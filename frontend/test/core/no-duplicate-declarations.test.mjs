// 同作用域同名 function 声明守卫。
//
// 背景（2026-11-26 实测事故）：给 explorer.js 的树加「展开态快照」时新写了
// `function collectExpanded()`（无参，返回 Set），而同一个 `createExplorer` 作用域里
// 早已有 `function collectExpanded(node, out)`（按节点收集到数组，refreshTreeSilently 用）。
// JS 里**后一个声明覆盖前一个**，于是 saveRootSnapshot 调到的是两参版本：
// 传 undefined → 返回 undefined → `expanded.size` 抛
//   TypeError: Cannot read properties of undefined (reading 'size')
// 表现是「切换到此工作区」点了没反应、几秒后调试台报未捕获异常。
//
// `node --check` 与 `tsc` 都发现不了（同名 function 声明是合法 JS），所以需要这条守卫。
//
// 判定口径：按**花括号作用域路径**判断，不是按缩进——
//   · 同一作用域链内同名 → 后者覆盖前者，红
//   · 不同函数内同名（各自局部 helper）→ 合法，不报
// 缩进不可靠：`ai-session-send.js` 里两个 `submit` 都是 8 空格缩进，但分属投递框与
// 通知框两个不同闭包，是合法写法（早期用缩进判定的版本在这里误报过）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join, relative} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '../../src');

function walkJs(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walkJs(p, out);
        else if (name.endsWith('.js')) out.push(p);
    }
    return out;
}

// 扫描 `function name(` 声明，返回 {name, line, scope}。
// scope 是花括号作用域 id 路径——同一路径 = 同一作用域（会被后者覆盖）。
// 字符串 / 行注释 / 块注释 / 模板字面量整段跳过，避免误数里面的花括号。
export function scanFunctionDeclarations(text) {
    const scopeStack = [0];
    let nextScopeId = 1;
    const decls = [];
    let line = 1;
    let i = 0;
    let mode = ''; // '' | 'line' | 'block' | 'sq' | 'dq'
    const src = String(text || '');
    while (i < src.length) {
        const c = src[i];
        const n = src[i + 1];
        if (c === '\n') line++;
        if (mode === 'line') { if (c === '\n') mode = ''; i++; continue; }
        if (mode === 'block') {
            if (c === '*' && n === '/') { mode = ''; i += 2; continue; }
            i++; continue;
        }
        if (mode === 'sq' || mode === 'dq') {
            if (c === '\\') { i += 2; continue; }
            if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"')) mode = '';
            i++; continue;
        }
        if (c === '/' && n === '/') { mode = 'line'; i += 2; continue; }
        if (c === '/' && n === '*') { mode = 'block'; i += 2; continue; }
        if (c === "'") { mode = 'sq'; i++; continue; }
        if (c === '"') { mode = 'dq'; i++; continue; }
        if (c === '`') {
            // 模板字面量整段跳过（含 ${} 里的花括号，宁可不数也不失衡）
            i++;
            while (i < src.length) {
                const ch = src[i];
                if (ch === '\\') { i += 2; continue; }
                if (ch === '\n') line++;
                if (ch === '`') { i++; break; }
                i++;
            }
            continue;
        }
        if (c === '{') { scopeStack.push(nextScopeId++); i++; continue; }
        if (c === '}') { if (scopeStack.length > 1) scopeStack.pop(); i++; continue; }
        if (c === 'f' && src.startsWith('function', i)) {
            const m = /^function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(src.slice(i));
            if (m) decls.push({name: m[1], line, scope: scopeStack.join('.')});
            i += 'function'.length;
            continue;
        }
        i++;
    }
    return decls;
}

function duplicateDeclarations(text) {
    const seen = new Map(); // `${scope}|${name}` -> [lineNo]
    for (const d of scanFunctionDeclarations(text)) {
        const key = d.scope + '|' + d.name;
        if (!seen.has(key)) seen.set(key, []);
        seen.get(key).push(d.line);
    }
    const dups = [];
    for (const [key, lines] of seen) {
        if (lines.length > 1) dups.push(key.split('|')[1] + ' @ 行 ' + lines.join(', '));
    }
    return dups;
}

test('同作用域内不得出现同名 function 声明（后者会覆盖前者）', () => {
    const offenders = [];
    for (const file of walkJs(srcRoot)) {
        const dups = duplicateDeclarations(readFileSync(file, 'utf8'));
        if (dups.length) {
            offenders.push(relative(srcRoot, file).replace(/\\/g, '/') + ' :: ' + dups.join(' | '));
        }
    }
    assert.deepEqual(offenders, [],
        '这些文件里有同作用域同名 function 声明，后者会静默覆盖前者（实测会导致'
        + '「Cannot read properties of undefined (reading \'size\')」这类难查的运行时错误）：\n'
        + offenders.join('\n'));
});

test('守卫自身有效：同作用域同名能识别', () => {
    const sample = [
        'export function createX() {',
        '    function helper() { return 1; }',
        '    function other() { return 2; }',
        '    function helper() { return 3; }',
        '}',
    ].join('\n');
    const dups = duplicateDeclarations(sample);
    assert.equal(dups.length, 1, '应识别出一组重名');
    assert.match(dups[0], /^helper @ 行 2, 4$/);
});

test('守卫不误报：不同函数内的同名局部 helper 合法', () => {
    const sample = [
        'export function createA() {',
        '    function open() {',
        '        function submit() { return 1; }',
        '        return submit;',
        '    }',
        '    return open;',
        '}',
        'export function createB() {',
        '    function open() {',
        '        function submit() { return 2; }',
        '        return submit;',
        '    }',
        '    return open;',
        '}',
    ].join('\n');
    assert.deepEqual(duplicateDeclarations(sample), [],
        '两个不同闭包里的 submit 不构成覆盖');
});

test('守卫不误报：字符串与注释里的 function 字样不算声明', () => {
    const sample = [
        'export function createX() {',
        '    const a = "function helper() {}";',
        '    // function helper() {}',
        '    /* function helper() {} */',
        '    function helper() { return 1; }',
        '    return helper;',
        '}',
    ].join('\n');
    assert.deepEqual(duplicateDeclarations(sample), [], '字面量与注释里的不算声明');
});
