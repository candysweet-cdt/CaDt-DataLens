// test/core/file-outline.test.mjs：core/file-outline.js 纯解析器的契约测试。
// 这个解析器同时供静态地图脚本与 AI 工具 get_file_outline 用，行号/分节口径必须钉住。
import test from 'node:test';
import assert from 'node:assert/strict';

import {parseOutline, formatOutlineText} from '../../src/core/file-outline.js';

test('parseOutline：分节注释识别 = 与 - 两种分隔，标题去掉尾部装饰', () => {
    const text = [
        'const a = 1;',
        '    // ===== 启动期：后端桥 =====',
        '    function foo() {}',
        '    // ---------- 会话持久化 ----------',
        '    async function bar() {}',
        '    // -- 普通注释不算分节（不足 3 个） --',
    ].join('\n');
    const {sections} = parseOutline(text);
    assert.deepEqual(sections.map((s) => [s.n, s.title]), [
        [2, '启动期：后端桥'],
        [4, '会话持久化'],
    ]);
});

test('parseOutline：只收浅层函数声明，闭包内深层缩进函数不进索引', () => {
    const text = [
        'function top() {',
        '        function nested() {}',
        '            function deep() {}',
        '}',
        'export async function exported() {}',
    ].join('\n');
    const fns = parseOutline(text).symbols.filter((s) => s.type === 'function');
    assert.deepEqual(fns.map((s) => [s.n, s.name]), [
        [1, 'top'],
        [5, 'exported'],
    ]);
});

test('parseOutline：箭头函数识别，非函数初始化（|| 表达式）不算', () => {
    const text = [
        'const click = (e) => e.preventDefault();',
        'const detail = (err && err.message) || String(err);',
        'let deep = (a) => {',
        '    return a;',
        '};',
    ].join('\n');
    const arrows = parseOutline(text).symbols.filter((s) => s.type === 'arrow');
    assert.deepEqual(arrows.map((s) => [s.n, s.name]), [
        [1, 'click'],
        [3, 'deep'],
    ]);
});

test('parseOutline：跨行参数含对象默认值的箭头仍识别（isArrowInit 不被 { 提前打断）', () => {
    const text = [
        'const withDefault = (a = {x: 1},',
        '                     b = 2) => a.x + b;',
        'const plain = (err && err.message) || String(err);',
    ].join('\n');
    const arrows = parseOutline(text).symbols.filter((s) => s.type === 'arrow');
    assert.deepEqual(arrows.map((s) => [s.n, s.name]), [
        [1, 'withDefault'],
    ]);
});

test('parseOutline：任意缩进的 case 字面量都收，数字 case 不收', () => {
    const text = [
        'switch (name) {',
        "            case 'list_dir': {",
        '            }',
        "        case 'read_file': {",
        '            }',
        '        case 42:',
        '}',
    ].join('\n');
    const cases = parseOutline(text).symbols.filter((s) => s.type === 'case');
    assert.deepEqual(cases.map((s) => [s.n, s.name]), [
        [2, 'list_dir'],
        [4, 'read_file'],
    ]);
});

test('parseOutline：返回总行数（按换行切分，与 read_file 行号同口径）', () => {
    assert.equal(parseOutline('a\nb\nc').lines, 3);
    assert.equal(parseOutline('a\nb\nc\n').lines, 4);
});

test('parseOutline：大文本（数万行）无隐藏上限，首尾符号行号正确', () => {
    // get_file_outline 放开 10MB 闸的前提：解析层对大文件没有行数/长度截断。
    const lines = ['// ===== 第一段 =====', 'function first() {}'];
    for (let i = 0; i < 50000; i++) lines.push('const v' + i + ' = ' + i + ';');
    lines.push('// ===== 末段 =====', 'function last() {}');
    const outline = parseOutline(lines.join('\n'));
    assert.equal(outline.lines, 50004);
    assert.deepEqual(outline.sections.map((s) => [s.n, s.title]), [
        [1, '第一段'],
        [50003, '末段'],
    ]);
    const fns = outline.symbols.filter((s) => s.type === 'function');
    assert.deepEqual(fns.map((s) => [s.n, s.name]), [[2, 'first'], [50004, 'last']]);
});

test('formatOutlineText：分节带起止行，符号带行号，sectionsOnly 只出分节', () => {
    const text = [
        '// ===== 第一节 =====',
        'function a() {}',
        'function b() {}',
        '// ===== 第二节 =====',
        'function c() {}',
    ].join('\n');
    const outline = parseOutline(text);
    const full = formatOutlineText('x.js', outline);
    assert.match(full, /1-3  第一节/);
    assert.match(full, /4-5  第二节/);
    assert.match(full, /2  function  a/);
    assert.match(full, /5  function  c/);
    const only = formatOutlineText('x.js', outline, {sectionsOnly: true});
    assert.match(only, /第一节/);
    assert.ok(!only.includes('function  a'), 'sectionsOnly 不应列符号');
});

test('formatOutlineText：offset/limit 分页，回报本次/共/offset 并提示续取', () => {
    const lines = [];
    for (let i = 0; i < 20; i++) lines.push('function f' + i + '() {}');
    const outline = parseOutline(lines.join('\n'));
    const p1 = formatOutlineText('x.js', outline, {limit: 5});
    assert.match(p1, /本次返回 5 条 \/ 共 20 条 \/ offset=0 \/ limit=5/);
    assert.match(p1, /用 offset=5 续取/);
    assert.match(p1, /f0/);
    assert.ok(!p1.includes(' f5'), '第一页不应含 f5');
    const p2 = formatOutlineText('x.js', outline, {limit: 5, offset: 5});
    assert.match(p2, /本次返回 5 条 \/ 共 20 条 \/ offset=5 \/ limit=5/);
    assert.match(p2, /f5/);
    assert.ok(!p2.includes(' f0'), '第二页不应含 f0');
    const pLast = formatOutlineText('x.js', outline, {limit: 5, offset: 18});
    assert.match(pLast, /本次返回 2 条 \/ 共 20 条 \/ offset=18 \/ limit=5/);
    assert.ok(!pLast.includes('用 offset=20 续取'), '最后一页不应再给具体续取提示');
});

test('formatOutlineText：limit 被 clamp 到 1..500', () => {
    const lines = [];
    for (let i = 0; i < 600; i++) lines.push('function f' + i + '() {}');
    const outline = parseOutline(lines.join('\n'));
    const big = formatOutlineText('x.js', outline, {limit: 9999});
    assert.match(big, /limit=500/, '超限的 limit 应被夹到 500');
    assert.match(big, /本次返回 500 条 \/ 共 600 条/);
    const small = formatOutlineText('x.js', outline, {limit: 0});
    assert.match(small, /limit=1/, '0 应被夹到 1');
});

test('formatOutlineText：section 按分节标题子串过滤符号', () => {
    const text = [
        '// ===== 配置与会话 =====',
        'function loadConfig() {}',
        'function saveConfig() {}',
        '// ===== 工具桥 =====',
        'function runTool() {}',
    ].join('\n');
    const outline = parseOutline(text);
    const scoped = formatOutlineText('x.js', outline, {section: '配置'});
    assert.match(scoped, /已按分节「配置」过滤/);
    assert.match(scoped, /loadConfig/);
    assert.match(scoped, /saveConfig/);
    assert.ok(!scoped.includes('runTool'), '不属于该分节的符号不应出现');
    assert.match(scoped, /共 2 条/, '过滤后总数应为该分节内的符号数');
});

test('formatOutlineText：section 无匹配时给出可选分节提示', () => {
    const text = [
        '// ===== 配置 =====',
        'function a() {}',
    ].join('\n');
    const out = formatOutlineText('x.js', parseOutline(text), {section: '不存在的段'});
    assert.match(out, /没有标题包含「不存在的段」的分节/);
    assert.match(out, /可选分节见上方导航/);
    assert.ok(!out.includes('function a'), '无匹配时不应列符号');
});

test('formatOutlineText：sectionsOnly 与分页/section 共存时只出分节', () => {
    const text = ['// ===== 配置 =====', 'function a() {}'].join('\n');
    const out = formatOutlineText('x.js', parseOutline(text), {sectionsOnly: true, section: '配置', limit: 1});
    assert.match(out, /配置/);
    assert.ok(!out.includes('function  a'), 'sectionsOnly 不应列符号');
});
