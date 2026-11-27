// 结构面板「代码大纲」增强护栏：源码语言在细粒度解析树之上追加一份代码大纲分组
// （与 AI 工具 code_outline / .map.md 共用 core/code-outline.js 解析真源），数据语言原样返回。
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseStructureWithOutline} from '../../src/editor/structure.js';

function findGroup(root, label) {
    return (root.children || []).find((n) => n.label === label);
}

test('Go 源码：追加「代码大纲」分组，含函数/类型节点与行号', () => {
    const src = [
        'package main',
        '',
        '// ===== 核心函数 =====',
        'func Alpha() {}',
        '',
        'type Config struct {}',
        'func Beta(x int) {}',
    ].join('\n');
    const result = parseStructureWithOutline('main.go', src);
    assert.equal(result.supported, true);
    const group = findGroup(result.root, '代码大纲');
    assert.ok(group, '源码语言应有「代码大纲」分组');
    assert.equal(group.kind, 'section');
    const labels = group.children.map((n) => n.label);
    assert.ok(labels.includes('Alpha'), '应含函数 Alpha');
    assert.ok(labels.includes('Config'), '应含类型 Config');
    assert.ok(labels.includes('Beta'), '应含函数 Beta');
    assert.ok(labels.includes('核心函数'), '应含分节标题');
    const alpha = group.children.find((n) => n.label === 'Alpha');
    assert.equal(alpha.line, 4, '行号应与源码一致');
    // 按行号排序
    const lines = group.children.map((n) => n.line);
    assert.deepEqual(lines, [...lines].sort((a, b) => a - b), '子节点应按行号升序');
});

test('JavaScript 源码：追加代码大纲（走 file-outline 真源）', () => {
    const src = 'function alpha() {}\nconst beta = () => {};\n';
    const result = parseStructureWithOutline('app.js', src);
    const group = findGroup(result.root, '代码大纲');
    assert.ok(group, 'JS 应有代码大纲分组');
    const labels = group.children.map((n) => n.label);
    assert.ok(labels.includes('alpha') && labels.includes('beta'), '应含函数与箭头函数');
});

test('数据语言：JSON / YAML / Markdown 不追加代码大纲', () => {
    const cases = [
        ['data.json', '{"a": 1, "b": {"c": 2}}'],
        ['data.yaml', 'a: 1\nb:\n  c: 2\n'],
        ['doc.md', '# 标题\n\n正文\n'],
        ['page.html', '<div><span>x</span></div>'],
    ];
    for (const [name, src] of cases) {
        const result = parseStructureWithOutline(name, src);
        assert.equal(findGroup(result.root, '代码大纲'), undefined, name + ' 不应追加代码大纲');
    }
});

test('不支持的文件 / 空文件：原样返回，不抛错', () => {
    assert.equal(parseStructureWithOutline('x.unknown', 'anything').supported, false);
    const empty = parseStructureWithOutline('main.go', '');
    assert.equal(empty.supported, true);
    assert.equal(findGroup(empty.root, '代码大纲'), undefined);
});
