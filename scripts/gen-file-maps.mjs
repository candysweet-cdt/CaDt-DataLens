#!/usr/bin/env node
// gen-file-maps.mjs：为两个超大前端文件生成「符号地图」导航 md，让模型不必盲读上万行。
//
// 为什么要生成而不是手写：
//   frontend/src/main.js（约 7.6k 行）与 frontend/src/ai/ai-panel.js（约 2 万行）是组合根与
//   AI 面板宿主，共享大量闭包状态、按 AGENTS.md 红线暂不拆文件。模型用 search_text 只能猜关键词，
//   用 read_file 又得整段试读。本脚本从源码抽「分节注释 / 顶层函数 / 工具 case 分支」，
//   生成带行号的紧凑索引，模型读一份小 md 就能定位到具体行段再精准 read_file。
//
// 解析逻辑在 frontend/src/core/file-outline.js（纯函数，与 AI 工具 get_file_outline 共用同一份口径）。
//
// 用法：
//   node scripts/gen-file-maps.mjs                 # 写两个 .map.md
//   node scripts/gen-file-maps.mjs --check         # 只比对，内容有差异则退出码 1（CI / 幂等校验）

import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseOutline} from '../frontend/src/core/file-outline.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

// 源文件 → 输出地图。相对仓库根。
const TARGETS = [
    {src: 'frontend/src/main.js', out: 'frontend/src/main.map.md'},
    {src: 'frontend/src/ai/ai-panel.js', out: 'frontend/src/ai/ai-panel.map.md'},
];

function scan(srcPath) {
    return parseOutline(readFileSync(resolve(ROOT, srcPath), 'utf8'));
}

function render(srcPath, data) {
    const {lines, sections, symbols} = data;
    const out = [];
    out.push(`# ${srcPath} · 符号地图`);
    out.push('');
    out.push('> 由 `node scripts/gen-file-maps.mjs` 自动生成，请勿手改；源文件变动后重跑脚本刷新行号。');
    out.push(`> 源文件共 ${lines} 行。定位顺序：先看「分节导航」找大区 → 再看「符号索引」找具体函数 → 最后 \`read_file\` 对应行段。`);
    out.push('> 分节的「至」是下一个分节起始行 - 1；符号只标起始行，读到下一个符号或函数体结束即可。');
    out.push('');
    out.push(`## 分节导航（${sections.length} 个）`);
    out.push('');
    out.push('| 起始行 | 至 | 分节标题 |');
    out.push('|---:|---:|---|');
    sections.forEach((s, i) => {
        const end = i + 1 < sections.length ? sections[i + 1].n - 1 : lines;
        out.push(`| ${s.n} | ${end} | ${s.title} |`);
    });
    out.push('');
    const fnCount = symbols.filter((s) => s.type !== 'case').length;
    const caseCount = symbols.filter((s) => s.type === 'case').length;
    out.push(`## 符号索引（${fnCount} 个函数/箭头${caseCount ? ` + ${caseCount} 个 case 分支` : ''}，按行号）`);
    if (caseCount) out.push('> case 分支：`ai-panel.js` 是 `executeToolInner` 的工具分发（case 名即工具名）；`main.js` 是 `menuItems` 的菜单分类。');
    out.push('');
    out.push('| 行号 | 类型 | 名称 |');
    out.push('|---:|---|---|');
    symbols.forEach((s) => out.push(`| ${s.n} | ${s.type} | \`${s.name}\` |`));
    out.push('');
    return out.join('\n');
}

let dirty = false;
for (const {src, out} of TARGETS) {
    const content = render(src, scan(src));
    const abs = resolve(ROOT, out);
    if (CHECK) {
        let old = '';
        try { old = readFileSync(abs, 'utf8'); } catch { /* 不存在视为差异 */ }
        if (old !== content) {
            console.error(`[gen-file-maps] 内容有差异：${out}（重跑 node scripts/gen-file-maps.mjs）`);
            dirty = true;
        }
    } else {
        writeFileSync(abs, content, 'utf8');
        console.log(`[gen-file-maps] 已写入 ${out}`);
    }
}
if (CHECK && dirty) process.exit(1);
