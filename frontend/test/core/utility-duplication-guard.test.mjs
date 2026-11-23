// 通用工具函数防重复护栏（2026-11-23 两会话代码收敛后定）。
// 背景：同一份 escapeHtml / formatBytes 曾在 6 个模块各写一遍，其中 3 份漏转单引号是真实 XSS 面。
// 本护栏把「通用函数只许在 core 定义」变成机制：业务模块里再写完整实现即红。
//
// 抓的是「函数定义」特征而非函数名：委托包装（export const humanBytes = formatBytes、
// function aiFormatBytes(){ return formatBytes(...) }）与第三方属性调用（markdownRenderer.utils.escapeHtml）
// 都不算重复，只有真正重写了转义/单位换算逻辑才命中。
// 仿 icon-guard 的基线模式：新文件出现命中直接失败；存量白名单写明原因，只许减不许增。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function walkJs(dir, out = []) {
    for (const name of readdirSync(dir, {recursive: true, encoding: 'utf8'})) {
        const norm = name.replace(/\\/g, '/');
        if (norm.endsWith('.js')) out.push(norm);
    }
    return out;
}

// 每条规则：name + 定义特征正则（跨行匹配函数体里的标志性字面量）+ 唯一合法定义处 + 存量豁免（含原因）
const RULES = [
    {
        name: 'HTML 转义函数',
        // 函数名恰好 escapeHtml（大小写不敏感），且函数体做 5 实体转义。
        // 用精确名而非 escape\w*：escapeXmlText / escapeAttr / escapeClosingTag 是给模型/图表/插件上下文的
        // 不同语义转义，不该算 HTML innerHTML 转义的重复（见下方豁免表，双保险）。
        re: /(?:function\s+escapeHtml\s*\(|escapeHtml\s*=\s*(?:\(|function))[\s\S]{0,400}?&amp;[\s\S]{0,200}?&lt;/i,
        owner: 'core/escape.js',
        // 语义不同的转义函数，写明原因；只许减不许增
        exempt: {
            'ai/core/ai-persona.js': 'escapeXmlText 是给模型看的 XML 转义（&<>，无引号），非 HTML innerHTML',
            'bridge/memo-docx.js': 'escapeXml 是 docx XML 转义（&<>），非 HTML',
            'shell/plugin-context.js': 'escapeAttr/escapeClosingTag 是插件上下文防注入转义，非 HTML',
            'core/layout-render.js': 'graph 关系图 SVG 文本转义，图表产物',
            'core/wordcloud-render.js': '词云 SVG 文本转义，图表产物',
        },
    },
    {
        name: '字节数人可读格式化',
        // 函数体内出现 KB/MB 单位表 + 1024 换算（真正的实现，不是委托）
        re: /(?:function\s+\w*(?:formatBytes|humanBytes|humanSizeBytes|aiFormatBytes)\w*\s*\(|\w*(?:formatBytes|humanBytes|humanSizeBytes|aiFormatBytes)\w*\s*=\s*\()[\s\S]{0,300}?['"]KB['"][\s\S]{0,100}?['"]MB['"]/,
        owner: 'core/humanize.js',
        exempt: {},
    },
];

// 合法定义处本身也要存在，防止 core 模块被误删后护栏空跑
test('core 唯一实现文件仍在', () => {
    for (const rule of RULES) {
        assert.ok(readFileSync(join(SRC, rule.owner), 'utf8').length > 0, `${rule.name} 的 core 实现 ${rule.owner} 缺失`);
    }
});

test('通用工具函数只在 core 定义，业务模块不得重写实现', () => {
    const files = walkJs(SRC);
    const offenders = [];
    for (const rel of files) {
        if (rel.endsWith('.test.js')) continue;
        const src = readFileSync(join(SRC, rel), 'utf8');
        for (const rule of RULES) {
            if (rel === rule.owner) continue;
            if (rule.exempt[rel]) continue;
            if (rule.re.test(src)) offenders.push(`${rel}：${rule.name}`);
        }
    }
    assert.deepEqual(offenders, [],
        '以下文件重写了 core 已有的通用工具函数（应改为 import core 模块，或把新用法登记进豁免并写明原因）：\n' +
        offenders.join('\n'));
});
