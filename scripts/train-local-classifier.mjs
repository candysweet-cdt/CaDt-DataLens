// scripts/train-local-classifier.mjs：纯 Node SGD 训练端侧线性分类器 → int8 量化出厂权重。
// 产出 frontend/src/ai/security/local-classifier-weights.mjs（生成产物，勿手改）；
// 特征算法 import 自 frontend/src/ai/security/ai-local-classifier.js——训练与推理同一套实现，永不漂移。
//
// 硬指标（不达标退出码 1，拒绝产出）：int8 量化后的验证集上——
//   1) 硬危险类在宽松档（T=0.30）误放数 = 0（rm -rf 类在任何严格度都不允许自动放行）；
//   2) 全部转人工类（含灰色）在标准档（T=0.15）误放数 = 0（fail-closed：宁可误拦不可误放）；
//   3) 安全类在标准档放行率 ≥ 0.85（避免过度打扰）。
//
// 运行：node scripts/train-local-classifier.mjs [--version factory-2026-11-14-1]
import {generateCorpus, mulberry32, CANARIES, ADVERSARIAL_CANARIES, REGRESSION_CANARIES} from './classifier-corpus.mjs';
import {LC_FEATURES, lcExtractDims, lcScore, lcSegment, lcScoreCommand, lcDequantize} from '../frontend/src/ai/security/ai-local-classifier.js';
import {LOCAL_CLASSIFIER_THRESHOLDS} from '../frontend/src/ai/security/ai-permissions.js';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const TRAIN_SEED = 20261114;   // 训练语料种子
const VAL_SEED = 8675309;      // 验证语料种子（不同随机源 = 未见变体）
// 400/400/130 时每条模板只剩 7 条样本，稀有族（侦察 / ACL / 中文 / prune）贴着决策边界抖，
// 每加一批语料就有另一族掉下去（实测连续 4 轮「按下葫芦浮起瓢」）。提到 700/700/240 后
// 每族约 12 条，权重才有足够更新次数站稳。训练仍是秒级。
const COUNTS = {safe: 1200, dangerous: 1200, gray: 400};
const EPOCHS = 60;
const LR0 = 0.1;
const DECAY = 0.9;
const L2 = 1e-4;               // 出厂训练的正则拉向 0（个性化阶段才锚定出厂）

function normalizeKey(command) {
    return String(command || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function shuffle(list, seed) {
    const r = mulberry32(seed >>> 0);
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(r() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

// 训练：稀疏二值特征 + 单样本 SGD，L2 拉向 0。样本顺序按 epoch 种子洗牌，全程可复现。
function train(samples) {
    const dims = LC_FEATURES.dims;
    const weights = new Float32Array(dims);
    let bias = 0;
    let lr = LR0;
    for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
        for (const sample of shuffle(samples, TRAIN_SEED + epoch * 7919)) {
            const g = lcScore(sample.dims, weights, bias) - sample.y;
            for (const d of sample.dims) weights[d] -= lr * g;
            bias -= lr * g;
            // L2 正则（每个样本步只在其特征维度上生效，与特征稀疏性对齐）
            for (const d of sample.dims) {
                weights[d] -= lr * L2 * weights[d];
            }
        }
        lr *= DECAY;
    }
    return {weights, bias};
}

// int8 量化：scale = max|w|/127，密集 int8 → base64（8192 维 ≈ 11 KB，体积优于稀疏文本）。
function quantize(weights) {
    let maxAbs = 0;
    for (let i = 0; i < weights.length; i += 1) maxAbs = Math.max(maxAbs, Math.abs(weights[i]));
    const scale = maxAbs > 0 ? maxAbs / 127 : 1;
    const bytes = new Uint8Array(weights.length);
    for (let i = 0; i < weights.length; i += 1) {
        const v = Math.round(weights[i] / scale);
        bytes[i] = v < 0 ? v + 256 : v;
    }
    return {scale, bytes, b64: Buffer.from(bytes).toString('base64')};
}

function evaluate(dataset, weights, bias) {
    // 验收口径 = 线上口径：lcScoreCommand（切段取 max）。整条打分只留作对照列，
    // 此前只用整条打分，公布的放行率比线上高约 6 个百分点（审计 2026-11-18 C-3）。
    const rows = dataset.map((s) => ({
        command: s.command,
        y: s.y,
        cls: s.cls,
        score: lcScoreCommand(s.command, weights, bias, LC_FEATURES),
        whole: lcScore(s.dims, weights, bias),
    }));
    const summary = {};
    for (const cls of ['safe', 'dangerous', 'gray']) {
        const list = rows.filter((r) => r.cls === cls);
        if (!list.length) continue;
        const sorted = list.map((r) => r.score).sort((a, b) => a - b);
        summary[cls] = {
            n: list.length,
            mean: list.reduce((acc, r) => acc + r.score, 0) / list.length,
            median: sorted[Math.floor(sorted.length / 2)],
            allow: {
                loose: list.filter((r) => r.score < LOCAL_CLASSIFIER_THRESHOLDS.loose).length / list.length,
                standard: list.filter((r) => r.score < LOCAL_CLASSIFIER_THRESHOLDS.standard).length / list.length,
                strict: list.filter((r) => r.score < LOCAL_CLASSIFIER_THRESHOLDS.strict).length / list.length,
            },
            // 对照：整条打分口径（旧验收口径），用来盯「公布的数」与「线上的数」差多少
            allowWhole: {
                standard: list.filter((r) => r.whole < LOCAL_CLASSIFIER_THRESHOLDS.standard).length / list.length,
            },
        };
    }
    const label1 = rows.filter((r) => r.y === 1);
    const hard = rows.filter((r) => r.cls === 'dangerous');
    return {
        summary,
        rows,
        falseAllow: {
            looseHard: hard.filter((r) => r.score < LOCAL_CLASSIFIER_THRESHOLDS.loose).length,
            looseAll: label1.filter((r) => r.score < LOCAL_CLASSIFIER_THRESHOLDS.loose).length,
            standard: label1.filter((r) => r.score < LOCAL_CLASSIFIER_THRESHOLDS.standard).length,
            strict: label1.filter((r) => r.score < LOCAL_CLASSIFIER_THRESHOLDS.strict).length,
        },
    };
}

// 训练样本按「段」展开：推理逐段打分取 max，训练就必须逐段学。
// 整条训练有两个副作用：①「良性前缀 + 危险尾部」会把前缀里的安全 n-gram 一并推向危险侧
// （反向污染，长洪泛样本尤其严重）；②「危险词被长前缀稀释」会被学成规律（审计 C-1）。
// 合成样本自带按段标签；模板样本按类标签展开（curl|sh 两段都危险，cd x && ls 两段都安全）。
function expandSamples(corpus) {
    const out = [];
    for (const s of corpus.samples) {
        let parts;
        if (Array.isArray(s.segments) && s.segments.length) {
            // 洪泛合成可能有上百段填充：只抽样几段代表「良性上下文」，否则安全类被稀释
            parts = s.segments.length > 12
                ? s.segments.slice(0, 6).concat(s.segments.slice(-1))
                : s.segments;
        } else {
            parts = lcSegment(s.command).map((text) => ({text, y: s.label}));
        }
        for (const part of parts) {
            const text = String((part && part.text) || '').trim();
            if (!text) continue;
            out.push({command: text, dims: lcExtractDims(text, LC_FEATURES), y: part.y, cls: s.cls});
        }
    }
    return out;
}

function main() {
    const args = process.argv.slice(2);
    const versionIndex = args.indexOf('--version');
    const version = versionIndex >= 0 && args[versionIndex + 1] ? String(args[versionIndex + 1])
        : 'factory-' + new Date().toISOString().slice(0, 10);

    const trainCorpus = generateCorpus(TRAIN_SEED, COUNTS);
    const valCorpus = generateCorpus(VAL_SEED, COUNTS);
    // 跨集合去重：验证集剔除与训练集字符串相同的样本（不同种子本不应撞，防御性兜底）
    const trainKeys = new Set(trainCorpus.samples.map((s) => normalizeKey(s.command)));
    const dropped = [];
    const valRaw = valCorpus.samples.filter((s) => {
        if (trainKeys.has(normalizeKey(s.command))) {
            dropped.push(s.command);
            return false;
        }
        return true;
    });

    const trainSamples = expandSamples(trainCorpus);
    const valSamples = valRaw.map((s) => ({command: s.command, dims: lcExtractDims(s.command, LC_FEATURES), y: s.label, cls: s.cls}));

    const trained = train(trainSamples);
    const quantized = quantize(trained.weights);
    // 量化后重算指标：上线的是 int8 权重，验收以量化后为准
    const dequantized = lcDequantize(quantized.b64, quantized.scale, LC_FEATURES.dims);
    const valReport = evaluate(valSamples, dequantized, trained.bias);
    const trainReport = evaluate(trainSamples, dequantized, trained.bias);

    console.log('训练集 ' + trainSamples.length + ' 条 / 验证集 ' + valSamples.length + ' 条（跨集合重复剔除 ' + dropped.length + ' 条）');
    console.log('int8 scale=' + quantized.scale.toExponential(3) + ' · 非零维 ' +
        [...trained.weights].filter((w) => Math.abs(w) > 1e-9).length + ' / ' + LC_FEATURES.dims);
    for (const [name, report] of [['验证集', valReport], ['训练集', trainReport]]) {
        console.log('--- ' + name + ' ---');
        for (const [cls, s] of Object.entries(report.summary)) {
            console.log('  ' + cls.padEnd(9) +
                ' mean=' + s.mean.toFixed(3) + ' median=' + s.median.toFixed(3) +
                ' allow@宽松=' + s.allow.loose.toFixed(2) +
                ' @标准=' + s.allow.standard.toFixed(2) +
                ' @严格=' + s.allow.strict.toFixed(2));
        }
        console.log('  误放（label1 score<T）：宽松硬危险=' + report.falseAllow.looseHard +
            ' 宽松全体=' + report.falseAllow.looseAll +
            ' 标准=' + report.falseAllow.standard +
            ' 严格=' + report.falseAllow.strict);
    }

    // 硬指标门槛（量化后验证集）
    const fails = [];
    if (valReport.falseAllow.looseHard !== 0) fails.push('硬危险类在宽松档误放 ' + valReport.falseAllow.looseHard + ' 条（要求 0）');
    if (valReport.falseAllow.standard !== 0) fails.push('标准档误放 ' + valReport.falseAllow.standard + ' 条（要求 0）');
    if (valReport.summary.safe.allow.standard < 0.85) {
        fails.push('安全类标准档放行率 ' + valReport.summary.safe.allow.standard.toFixed(2) + '（要求 ≥ 0.85，过度打扰）');
    }
    if (fails.length) {
        // 诊断：列出漏放样本（label1 且 score 低于对应阈值），便于回填语料模板
        for (const row of valReport.rows) {
            if (row.y !== 1) continue;
            const looseMiss = row.cls === 'dangerous' && row.score < LOCAL_CLASSIFIER_THRESHOLDS.loose;
            const standardMiss = row.score < LOCAL_CLASSIFIER_THRESHOLDS.standard;
            if (looseMiss || standardMiss) {
                console.error('  漏放 [' + row.cls + '] ' + row.score.toFixed(3) + ' ' + JSON.stringify(row.command));
            }
        }
        console.error('未达硬指标，拒绝产出权重：\n  - ' + fails.join('\n  - '));
        process.exit(1);
    }

    // 金丝雀三层：plain（记忆层，防权重跑飞）/ adversarial（泛化闸门）/ regression（本轮修复不回退）
    const canaryFails = [];
    const CANARY_LAYERS = [
        ['plain', CANARIES],
        ['adversarial', ADVERSARIAL_CANARIES],
        ['regression', REGRESSION_CANARIES],
    ];
    for (const [layer, set] of CANARY_LAYERS) {
        for (const command of (set && set.dangerous) || []) {
            const score = lcScoreCommand(command, dequantized, trained.bias, LC_FEATURES);
            if (score < 0.5) canaryFails.push('[' + layer + '] 危险应高置信（≥0.5）：' + command + ' → ' + score.toFixed(3));
            else if (score < LOCAL_CLASSIFIER_THRESHOLDS.loose) canaryFails.push('[' + layer + '] 危险宽松档也必须拦：' + command + ' → ' + score.toFixed(3));
        }
        for (const command of (set && set.gray) || []) {
            const score = lcScoreCommand(command, dequantized, trained.bias, LC_FEATURES);
            if (score < LOCAL_CLASSIFIER_THRESHOLDS.standard) canaryFails.push('[' + layer + '] 灰色应标准档转人工：' + command + ' → ' + score.toFixed(3));
        }
        for (const command of (set && set.safe) || []) {
            const score = lcScoreCommand(command, dequantized, trained.bias, LC_FEATURES);
            if (score >= LOCAL_CLASSIFIER_THRESHOLDS.standard) canaryFails.push('[' + layer + '] 安全应标准档放行：' + command + ' → ' + score.toFixed(3));
        }
    }
    if (canaryFails.length) {
        console.error('金丝雀未过，拒绝产出权重：\n  - ' + canaryFails.join('\n  - '));
        process.exit(1);
    }

    const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'src', 'ai', 'security', 'local-classifier-weights.mjs');
    const content = [
        '// local-classifier-weights.mjs：内置端侧分类器出厂权重（生成产物，勿手改）。',
        '// 重训：node scripts/train-local-classifier.mjs（语料 scripts/classifier-corpus.mjs，种子 ' + TRAIN_SEED + '/' + VAL_SEED + '）。',
        '// 出厂指标（验证集 ' + valSamples.length + ' 条，int8 量化后）：硬危险误放 0 · 标准档误放 0 · 安全放行率 ' +
            valReport.summary.safe.allow.standard.toFixed(2) + ' / ' + valReport.summary.safe.allow.strict.toFixed(2) + '（标准/严格）。',
        '// 灰色类（install/push/kill 等改环境）中位 score ' + valReport.summary.gray.median.toFixed(2) +
            '，标准档转人工、宽松档部分放行是设计行为（方案 §5）。',
        'export const LOCAL_CLASSIFIER_FACTORY_VERSION = ' + JSON.stringify(version) + ';',
        'export const LOCAL_CLASSIFIER_FEATURES = ' + JSON.stringify(LC_FEATURES) + ';',
        'export const LOCAL_CLASSIFIER_QUANT = {scale: ' + quantized.scale.toPrecision(8) + '};',
        'export const LOCAL_CLASSIFIER_BIAS = ' + trained.bias.toPrecision(8) + ';',
        'export const LOCAL_CLASSIFIER_WEIGHTS = ' + JSON.stringify(quantized.b64) + ';',
        '',
    ].join('\n');
    writeFileSync(outPath, content);
    console.log('已写出 ' + outPath + '（' + Buffer.byteLength(content) + ' 字节，权重预算 200 KB）');
    console.log('出厂版本：' + version);
}

main();
