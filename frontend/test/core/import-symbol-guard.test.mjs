// import-symbol-guard.test.mjs —— 跨模块「裸用未导入导出」静态扫描（守卫）。
//
// 背景：2026-11-24 运行期报 `ReferenceError: formatUsageAge is not defined`——
// ai-panel.js 的用量弹层裸用了 ai/usage/ai-usage-quota.js 的导出，却漏在 import 列表里。
// import/link/vite 构建全都通过（ESM 里未声明的标识符不是语法错误），只有真正打开弹层才炸。
// module-scope.test.mjs 只覆盖「宿主 → 登记在 HOSTS 里的兄弟模块」这一对手工维护的配对，
// 看不见 ai-panel 这种没有登记的大型宿主，也看不见别名导入（`x as y`）。
//
// 规则：文件里裸用的标识符若等于「它 import 的某个模块的导出名」，而本文件的本地名集合
// （import 进来的名字含别名后的名字 / 顶层定义 / 顶层解构）里没有它 → 漏导入。
// 已知的非引用形态会被放行：对象字面量键（`name:`）、getter / 方法简写键（`get name() {}`）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

// 确属误报时的豁免出口（只许按行写清原因；当前为空）
const EXEMPT = new Set([]);

function listJs(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) listJs(abs, out);
        else if (name.endsWith('.js')) out.push(abs);
    }
    return out;
}

// 去掉注释与字符串字面量：注释里提到符号名、字符串里写着符号名都不算引用
function code(text) {
    return text
        // 工作副本是 CRLF（core.autocrlf=true）：先归一到 LF，否则逐行 // 剥离整条失效
        .replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/(^|[^:\\])\/\/.*$/, '$1'))
        .join('\n')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

const exportCache = new Map();

function exportsOf(file) {
    if (exportCache.has(file)) return exportCache.get(file);
    let raw = '';
    try {
        raw = readFileSync(file, 'utf8');
    } catch {
        exportCache.set(file, new Set()); // 读不到（不该发生）：按无导出处理，不阻断
        return exportCache.get(file);
    }
    const src = code(raw);
    const out = new Set();
    for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
    for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
    exportCache.set(file, out);
    return out;
}

function scanFile(file) {
    const raw = readFileSync(file, 'utf8');
    const mods = new Set();
    const localNames = new Set();
    for (const m of raw.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
        for (const part of m[1].split(',')) {
            const [orig, alias] = part.trim().split(/\s+as\s+/);
            if (!orig) continue;
            localNames.add((alias || orig).trim()); // 别名导入：本地名是别名
        }
        mods.add(resolve(dirname(file), m[2]));
    }
    for (const m of raw.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s*'([^']+)'/g)) {
        localNames.add(m[1]);
        mods.add(resolve(dirname(file), m[2]));
    }
    if (!mods.size) return [];

    const body = code(raw)
        // import 语句本身：`x as y` 里的原名与 `{a, b}` 里的名字都不是使用
        .replace(/import\b[^;]*?from\s*''\s*;?/g, '')
        .replace(/import\s+''\s*;?/g, '')
        // export { a as b } 是再导出，别名同样不是使用
        .replace(/export\s*\{[^}]*\}\s*;?/g, '');

    for (const m of body.matchAll(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) localNames.add(m[1]);
    for (const m of body.matchAll(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) localNames.add(m[1]);
    for (const m of body.matchAll(/^\s*(?:const|let|var)\s*\{([^}]*)\}\s*=/gm)) {
        for (const id of m[1].match(/[A-Za-z_$][\w$]*/g) || []) localNames.add(id);
    }

    const problems = [];
    const rel = file.replace(/\\/g, '/').split('/frontend/src/')[1];
    for (const mod of mods) {
        for (const name of exportsOf(mod)) {
            if (localNames.has(name)) continue;
            const re = new RegExp('(?<![\\w$.\\\\])' + name + '\\b', 'g');
            for (const hit of body.matchAll(re)) {
                const after = body.slice(hit.index + name.length).trimStart();
                if (after.startsWith(':')) continue; // 对象字面量键
                if (/^\([^()]*\)\s*\{/.test(after)) continue; // getter / 方法简写键
                const lineNo = body.slice(0, hit.index).split('\n').length;
                if (EXEMPT.has(`${rel}:${name}`)) continue;
                problems.push(`${rel}:${lineNo} 裸用 ${name}（该名来自某个已 import 模块的导出，但没进本文件的 import 列表）`);
                break;
            }
        }
    }
    return problems;
}

test('源码里不得裸用「已 import 模块的导出名」却漏 import（别名/未导入都算）', () => {
    const problems = [];
    for (const file of listJs(SRC)) problems.push(...scanFile(file));
    assert.deepEqual(problems, [], '跨模块符号未导入（运行到该分支才炸，构建与单测都看不见）：\n' + problems.join('\n'));
});
