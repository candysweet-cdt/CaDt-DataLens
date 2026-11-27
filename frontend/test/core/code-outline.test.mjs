// test/core/code-outline.test.mjs：跨语言大纲解析器与分节注释编辑计划的契约测试。
// 解析口径与 file-outline.test.mjs 对齐（JS 委托同一真源），新增语言规则必须在此登记。
import test from 'node:test';
import assert from 'node:assert/strict';

import {detectLanguage, outlineForLanguage, planSectionComments, applySectionEdits} from '../../src/core/code-outline.js';

test('detectLanguage：按扩展名识别，未知回退 plaintext', () => {
    assert.equal(detectLanguage('a.go').id, 'go');
    assert.equal(detectLanguage('D:\\ws\\sub\\app.py').id, 'python');
    assert.equal(detectLanguage('Main.java').id, 'java');
    assert.equal(detectLanguage('x.tsx').id, 'typescript');
    assert.equal(detectLanguage('x.unknownext').id, 'plaintext');
    assert.equal(detectLanguage('noext').id, 'plaintext');
    assert.equal(detectLanguage('a.go').label, 'Go');
});

test('outlineForLanguage：Go 函数与类型', () => {
    const text = [
        'package main',
        '',
        'type Server struct {}',
        'func main() {}',
        'func (s *Server) Start(x int) {}',
    ].join('\n');
    const out = outlineForLanguage(text, 'go');
    assert.equal(out.language, 'go');
    assert.deepEqual(out.symbols.map((s) => [s.n, s.type, s.name]), [
        [3, 'class', 'Server'],
        [4, 'function', 'main'],
        [5, 'function', 'Start'],
    ]);
});

test('outlineForLanguage：Python 函数/类与 # 分节', () => {
    const text = [
        '# ===== 核心 =====',
        'def hello():',
        '    pass',
        'class World:',
        '    pass',
    ].join('\n');
    const out = outlineForLanguage(text, 'python');
    assert.deepEqual(out.sections.map((s) => [s.n, s.title]), [[1, '核心']]);
    assert.deepEqual(out.symbols.map((s) => [s.n, s.type, s.name]), [
        [2, 'function', 'hello'],
        [4, 'class', 'World'],
    ]);
});

test('outlineForLanguage：Java / C / Rust 函数与类', () => {
    const java = outlineForLanguage('public class Foo {\n  public void run() {\n  }\n}\n', 'java');
    assert.deepEqual(java.symbols.map((s) => [s.type, s.name]), [['class', 'Foo'], ['function', 'run']]);
    const c = outlineForLanguage('struct Node {};\nint add(int a, int b) {\n}\n', 'c');
    assert.deepEqual(c.symbols.map((s) => [s.type, s.name]), [['class', 'Node'], ['function', 'add']]);
    const rust = outlineForLanguage('pub struct Foo {}\npub fn run() {}\nfn helper() {}\n', 'rust');
    assert.deepEqual(rust.symbols.map((s) => [s.type, s.name]), [
        ['class', 'Foo'], ['function', 'run'], ['function', 'helper'],
    ]);
});

test('outlineForLanguage：JS 委托 parseOutline，分节/箭头/case 口径不变', () => {
    const text = [
        '// ===== 工具 =====',
        'export function foo() {}',
        'const bar = (x) => x;',
        "case 'read_file': {",
    ].join('\n');
    const out = outlineForLanguage(text, 'javascript');
    assert.equal(out.language, 'javascript');
    assert.deepEqual(out.sections.map((s) => s.title), ['工具']);
    assert.deepEqual(out.symbols.map((s) => s.type), ['function', 'arrow', 'case']);
});

test('outlineForLanguage：多语言分节注释符（// # ; -- <!-- -->）', () => {
    assert.deepEqual(outlineForLanguage('; ===== 配置 =====\nx', 'plaintext').sections.map((s) => s.title), ['配置']);
    assert.deepEqual(outlineForLanguage('-- ===== 查询 =====\nSELECT 1;', 'sql').sections.map((s) => s.title), ['查询']);
    assert.deepEqual(outlineForLanguage('<!-- ===== 头部 ===== -->\n<div></div>', 'html').sections.map((s) => s.title), ['头部']);
});

test('outlineForLanguage：无分节注释时只出函数，sections 为空', () => {
    const out = outlineForLanguage('func a() {}\nfunc b() {}\n', 'go');
    assert.equal(out.sections.length, 0);
    assert.equal(out.symbols.length, 2);
});

test('outlineForLanguage：Markdown 标题当分节', () => {
    const out = outlineForLanguage('# 标题一\n正文\n## 标题二\n正文', 'markdown');
    assert.deepEqual(out.sections.map((s) => [s.n, s.title]), [[1, '标题一'], [3, '标题二']]);
});

test('outlineForLanguage：大文件无隐藏上限', () => {
    const lines = ['package main'];
    for (let i = 0; i < 50000; i++) lines.push('func f' + i + '() {}');
    const out = outlineForLanguage(lines.join('\n'), 'go');
    assert.equal(out.lines, 50001);
    assert.equal(out.symbols.length, 50000);
    assert.equal(out.symbols[49999].name, 'f49999');
});

test('planSectionComments + applySectionEdits：按语义分区插入注释，注释符按语言选', () => {
    const text = 'func a() {}\nfunc b() {}\nfunc c() {}\n';
    const edits = planSectionComments(text, 'go', [
        {title: '入口', startName: 'a'},
        {title: '辅助函数', startName: 'c'},
    ]);
    assert.deepEqual(edits, [
        {line: 1, text: '// ===== 入口 ====='},
        {line: 3, text: '// ===== 辅助函数 ====='},
    ]);
    const applied = applySectionEdits(text, edits);
    assert.equal(applied, '// ===== 入口 =====\nfunc a() {}\nfunc b() {}\n// ===== 辅助函数 =====\nfunc c() {}\n');
});

test('planSectionComments：Python 用 # 注释符，找不到的符号跳过，同位置不重复', () => {
    const text = 'def a():\n    pass\ndef b():\n    pass\n';
    const edits = planSectionComments(text, 'python', [
        {title: '甲', symbolNames: ['a', 'b']},
        {title: '乙', symbolNames: ['a']},
        {title: '无', startName: 'missing'},
    ]);
    assert.deepEqual(edits, [{line: 1, text: '# ===== 甲 ====='}]);
});

test('planSectionComments：空标题与匹配不到的符号都跳过，不产生编辑', () => {
    const text = 'def a():\n    pass\n';
    const edits = planSectionComments(text, 'python', [{title: ''}, {title: '头部', startName: 'missing'}]);
    assert.equal(edits.length, 0);
});

test('planSectionComments：含换行的标题被单行化，防止注入源码', () => {
    const text = 'func a() {}\n';
    const edits = planSectionComments(text, 'go', [{title: '配置 =====\n恶意代码\n// x', startName: 'a'}]);
    assert.equal(edits.length, 1);
    assert.ok(!edits[0].text.includes('\n'), '插入的注释必须是单行');
    assert.match(edits[0].text, /配置.*恶意代码.*x/);
});

test('applySectionEdits：越界行号抛错，不静默吞掉', () => {
    assert.throws(() => applySectionEdits('a\nb\n', [{line: 99, text: '// x'}]), /越界/);
    assert.throws(() => applySectionEdits('a\nb\n', [{line: 0, text: '// x'}]), /越界/);
});

test('planSectionComments：分节注释插在 JSDoc 整块之前，不拆散文档与函数', () => {
    const text = [
        '/**',
        ' * 初始化配置',
        ' * @param {number} x',
        ' */',
        'function init(x) {}',
    ].join('\n');
    const edits = planSectionComments(text, 'javascript', [{title: '配置', startName: 'init'}]);
    assert.deepEqual(edits, [{line: 1, text: '// ===== 配置 ====='}]);
    const applied = applySectionEdits(text, edits);
    assert.ok(applied.startsWith('// ===== 配置 =====\n/**\n * 初始化配置'), '注释须在 JSDoc 之前');
    assert.ok(applied.indexOf(' */\nfunction init') > 0, 'JSDoc 结束符须紧贴函数');
});

test('planSectionComments：重复维护幂等，已有分节注释不再叠加', () => {
    const text = ['// Start 启动服务', 'func Start() {}', 'func helper() {}'].join('\n');
    const plans = [{title: '启动', startName: 'Start'}, {title: '辅助', startName: 'helper'}];
    const once = applySectionEdits(text, planSectionComments(text, 'go', plans));
    assert.equal(planSectionComments(once, 'go', plans).length, 0, '第二次不应产生任何编辑');
    assert.equal(applySectionEdits(once, planSectionComments(once, 'go', plans)), once);
});
