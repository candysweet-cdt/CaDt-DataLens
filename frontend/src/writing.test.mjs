import test from 'node:test';
import assert from 'node:assert/strict';
import {formatWritingText, genName, WRITING_FONTS, WRITING_PAPERS, SCENE_SEPARATOR} from './writing.js';

test('排版：删行尾空白、统一换行', () => {
    const r = formatWritingText('第一行\u3000  \r\n第二行\t\r\n', {});
    assert.equal(r.text, '第一行\n第二行\n');
    assert.equal(r.trailing, 2);
});

test('排版：≥3 连续空行收敛为 1 个空行', () => {
    const r = formatWritingText('甲\n\n\n\n\n乙', {});
    assert.equal(r.text, '甲\n\n乙');
    assert.equal(r.collapsed, 1);
    const r2 = formatWritingText('甲\n\n乙', {});
    assert.equal(r2.collapsed, 0);
    assert.equal(r2.text, '甲\n\n乙');
});

test('排版：行首 ASCII 空白清除，全角缩进保留', () => {
    const r = formatWritingText('  缩进行\n\u3000\u3000全角缩进\n', {});
    assert.equal(r.text, '缩进行\n\u3000\u3000全角缩进\n');
    assert.equal(r.leading, 1);
});

test('排版：md 语法行行首不动，围栏代码块内容不动', () => {
    const src = [
        '# 标题',
        '  - 嵌套列表项',
        '    > 引用',
        '```python',
        '    indented_code()',
        '~~~',
        '正文',
        '',
    ].join('\n');
    const r = formatWritingText(src, {markdown: true});
    assert.equal(r.text, src);
    assert.equal(r.leading, 0);
    assert.equal(r.indented, 0);
});

test('排版：md 表格与有序列表行首保护', () => {
    const src = '正文\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n  3. 有序列表\n';
    const r = formatWritingText(src, {markdown: true});
    assert.equal(r.text, src);
});

test('排版：段首缩进两格（txt，跳过全角已缩进与文首标题外规则）', () => {
    const r = formatWritingText('第一段\n\n第二段\n\n\u3000\u3000已缩进段', {indent: true});
    assert.equal(r.text, '\u3000\u3000第一段\n\n\u3000\u3000第二段\n\n\u3000\u3000已缩进段');
    assert.equal(r.indented, 2);
});

test('排版：md 缩进不应用于语法行', () => {
    const r = formatWritingText('段落\n\n# 标题\n\n- 列表', {markdown: true, indent: true});
    assert.equal(r.text, '\u3000\u3000段落\n\n# 标题\n\n- 列表');
    assert.equal(r.indented, 1);
});

test('排版：围栏内不缩进', () => {
    const r = formatWritingText('前文\n\n```\ncode_line()\n```\n', {markdown: true, indent: true});
    assert.equal(r.text, '\u3000\u3000前文\n\n```\ncode_line()\n```\n');
});

test('排版：空文本与无改动', () => {
    const r = formatWritingText('', {});
    assert.equal(r.text, '');
    assert.equal(r.trailing + r.leading + r.collapsed + r.indented, 0);
});

test('排版：md 列表续段保留缩进，不被顶格拆出列表', () => {
    const src = '- item\n\n  续段段落\n\n- item2\n';
    const r = formatWritingText(src, {markdown: true});
    assert.equal(r.text, src);
    assert.equal(r.leading, 0);
    const nested = '- a\n  - b\n    - c\n';
    assert.equal(formatWritingText(nested, {markdown: true}).text, nested);
    // 列表结束后回到顶层段落
    assert.equal(formatWritingText('- a\n\n顶层\n', {markdown: true}).text, '- a\n\n顶层\n');
});

test('排版：md 硬换行（行尾两空格）与围栏内行尾空白保留', () => {
    const hard = 'one  \ntwo\n';
    const r = formatWritingText(hard, {markdown: true});
    assert.equal(r.text, hard);
    assert.equal(r.trailing, 0);
    const fenced = '```\ncode()   \n```\n';
    const r2 = formatWritingText(fenced, {markdown: true});
    assert.equal(r2.text, fenced);
    assert.equal(r2.trailing, 0);
    // 非 markdown 仍按原规则删行尾空白
    assert.equal(formatWritingText('one  \n', {}).text, 'one\n');
});

test('排版：≥3 连续空行在文首/文末与中间同口径收敛', () => {
    const head = formatWritingText('\n\n\n甲\n', {});
    assert.equal(head.text, '\n甲\n');
    assert.equal(head.collapsed, 1);
    const mid = formatWritingText('甲\n\n\n\n乙\n', {});
    assert.equal(mid.text, '甲\n\n乙\n');
    assert.equal(mid.collapsed, 1);
    // 2 个空行不收敛
    assert.equal(formatWritingText('甲\n\n\n乙\n', {}).text, '甲\n\n\n乙\n');
});

test('排版：txt 缩进不套用 md 语法豁免', () => {
    const r = formatWritingText('1. 第一段\n\n- 第二段\n', {indent: true});
    assert.equal(r.text, '\u3000\u30001. 第一段\n\n\u3000\u3000- 第二段\n');
    assert.equal(r.indented, 2);
});

test('起名器：姓与名非空，性别池区分', () => {
    assert.ok(WRITING_FONTS.some((f) => f.id === 'kaiti' && f.family));
    assert.ok(WRITING_PAPERS.some((p) => p.id === 'sepia'));
    assert.equal(SCENE_SEPARATOR, '\n\n* * *\n\n');
    for (let i = 0; i < 200; i++) {
        const name = genName('female');
        assert.match(name, /^[\u4e00-\u9fff]{2,4}$/);
    }
    for (let i = 0; i < 200; i++) {
        const name = genName('random');
        assert.match(name, /^[\u4e00-\u9fff]{2,4}$/);
    }
});
