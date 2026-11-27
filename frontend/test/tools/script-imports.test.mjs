// script-imports.test.mjs：脚本可解析守卫。
//
// 背景（2026-11-27 审查 S9）：AI 源码按域拆到 ai/security、ai/core 之后，5 个脚本
// 仍从旧路径 import，全部 ERR_MODULE_NOT_FOUND。`npm test` 与构建都不跑这些脚本，
// CI 全绿也发现不了。这里做静态校验（不执行训练/评测）：
//   1) 脚本里的相对 import 必须指向真实存在的文件；
//   2) 已被迁移走的旧路径不许再出现在 import 里。
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');

const SCRIPTS = [
    'scripts/train-local-classifier.mjs',
    'scripts/eval-public-corpus.mjs',
    'scripts/export-model-catalog.mjs',
    'plugins/command-classifier-onnx/scripts/train-head.mjs',
    'plugins/command-classifier-onnx/scripts/verify.mjs',
];

// 迁移前的旧路径：再出现就是回归。
const STALE_PATHS = [
    'frontend/src/ai/ai-local-classifier.js',
    'frontend/src/ai/ai-permissions.js',
    'frontend/src/ai/local-classifier-weights.mjs',
    'frontend/src/ai/model-catalog.js',
];

test('脚本的相对 import 全部可解析', () => {
    for (const rel of SCRIPTS) {
        const file = join(ROOT, rel);
        assert.ok(existsSync(file), `脚本不存在：${rel}`);
        const src = readFileSync(file, 'utf8');
        for (const m of src.matchAll(/\bfrom\s+'(\.[^']+)'/g)) {
            const target = resolve(dirname(file), m[1]);
            assert.ok(existsSync(target), `${rel} 引用了不存在的模块：${m[1]}`);
        }
    }
});

test('脚本不再引用迁移前的旧路径', () => {
    for (const rel of SCRIPTS) {
        const src = readFileSync(join(ROOT, rel), 'utf8');
        for (const stale of STALE_PATHS) {
            assert.ok(
                !src.includes(`'${stale}'`) && !src.includes(`'../${stale}'`),
                `${rel} 仍引用旧路径 ${stale}（已迁到 ai/security 或 ai/core）`,
            );
        }
    }
});

test('ONNX 插件脚本能在仓库内定位主仓根', () => {
    // 插件随主仓分发时位于 <repo>/plugins/<plugin>，主仓根是上两级；
    // 脚本必须能在这层找到 scripts/classifier-corpus.mjs。
    assert.ok(
        existsSync(join(ROOT, 'scripts', 'classifier-corpus.mjs')),
        '主仓 scripts/classifier-corpus.mjs 缺失',
    );
    for (const rel of SCRIPTS.filter((p) => p.startsWith('plugins/'))) {
        const src = readFileSync(join(ROOT, rel), 'utf8');
        assert.ok(
            src.includes("join(REPO, '..', '..')"),
            `${rel} 未把「插件在主仓内」的布局算进 MAIN_REPO 候选`,
        );
    }
});
