// ai-paste 纯函数护栏：三档模式、阈值、标记扫描、镜像 HTML（XSS 转义）、展开、光标命中、行数、
// 摘要单行化（换行问题）、时间格式。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LARGE_PASTE_CHAR_THRESHOLD, AI_PASTE_MODES, DEFAULT_AI_PASTE_MODE,
    normalizePasteMode, shouldFoldPaste, makePasteMarker, pasteMarkerRe, pasteMarkerOneRe,
    scanPasteMarkers, markerAtCursor, buildPasteMirrorHtml, expandPasteMarkers,
    countPasteLines, makePasteEntry, pasteFullDocName, pasteTooltip,
    pasteSummary, formatPasteTime, PASTE_MARKER_ICON, friendlyPasteLabel,
    PASTE_INLINE_MAX_CHARS, PASTE_ATTACH_MAX_CHARS, decidePasteAction,
    pasteFileAttachmentText, pasteOverflowPlaceholder,
} from '../../../src/ai/chat/ai-paste.js';

// 便捷构造器：固定摘要与时间，便于断言标记格式。
const mark = (id, summary = '摘要', time = '12:34') => makePasteMarker(id, summary, time);

test('三档模式白名单与归一化', () => {
    assert.deepEqual(AI_PASTE_MODES, ['off', 'attachment', 'collapse']);
    assert.equal(DEFAULT_AI_PASTE_MODE, 'collapse');
    assert.equal(normalizePasteMode('off'), 'off');
    assert.equal(normalizePasteMode('attachment'), 'attachment');
    assert.equal(normalizePasteMode('collapse'), 'collapse');
    assert.equal(normalizePasteMode('bogus'), 'collapse');
    assert.equal(normalizePasteMode(undefined), 'collapse');
});

test('阈值：严格大于 1000 才折叠', () => {
    assert.equal(LARGE_PASTE_CHAR_THRESHOLD, 1000);
    assert.equal(shouldFoldPaste('x'.repeat(999)), false);
    assert.equal(shouldFoldPaste('x'.repeat(1000)), false);
    assert.equal(shouldFoldPaste('x'.repeat(1001)), true);
    assert.equal(shouldFoldPaste(''), false);
    assert.equal(shouldFoldPaste(null), false);
});

test('摘要：取首个非空行、去掉所有换行符（恒单行）、剔除冲突字符、截断', () => {
    assert.equal(pasteSummary('第一行内容\n第二行内容'), '第一行内容');
    assert.equal(pasteSummary('   \n第二行才是正文\r\n第三行'), '第二行才是正文');
    assert.equal(pasteSummary('a\tb\r\nc'), 'a b');
    // 冲突字符（【】·#）被剔除，避免破坏标记正则锚点。
    assert.ok(!/[【】·#\r\n]/.test(pasteSummary('含【括号】·与#井号\n换行')));
    const long = pasteSummary('x'.repeat(100), 10);
    assert.equal(long.length, 11); // 截断到 10 + 省略号
    assert.ok(long.endsWith('…'));
    assert.equal(pasteSummary(''), '长文本');
    // 默认 12 字。
    assert.equal(pasteSummary('x'.repeat(100)).length, 13); // 12 + 省略号
});

test('friendlyPasteLabel：结构化内容给友好标签，不把原始标记塞进胶囊', () => {
    assert.equal(friendlyPasteLabel('<svg t="1795234567890" class="icon" viewBox="0 0 1024 1024">'), 'SVG 图片');
    assert.equal(friendlyPasteLabel('<?xml version="1.0" encoding="UTF-8"?>'), 'XML 文档');
    assert.equal(friendlyPasteLabel('<!DOCTYPE html><html><body>x</body></html>'), 'HTML 页面');
    assert.equal(friendlyPasteLabel('<div class="a">hello</div>'), 'HTML 内容');
    assert.equal(friendlyPasteLabel('{"name":"test","value":1}'), 'JSON 数据');
    assert.equal(friendlyPasteLabel('[1,2,3]'), 'JSON 数据');
    // SVG 首行带 XML 声明时优先识别为 SVG（审查 m2）
    assert.equal(friendlyPasteLabel('<?xml version="1.0"?><svg viewBox="0 0 24 24">'), 'SVG 图片');
    // Markdown 链接 / 任务列表不误判为 JSON
    assert.equal(friendlyPasteLabel('[标题](https://example.com)'), '');
    assert.equal(friendlyPasteLabel('[x] 待办事项'), '');
    assert.equal(friendlyPasteLabel('普通文本第一行'), '');
    // 摘要本身也走友好标签
    assert.equal(pasteSummary('<svg t="1795" viewBox="0 0 1024 1024">…长内容'), 'SVG 图片');
});

test('时间格式：HH:mm 补零', () => {
    assert.equal(formatPasteTime(new Date(2026, 0, 1, 9, 5)), '09:05');
    assert.equal(formatPasteTime(new Date(2026, 0, 1, 15, 42)), '15:42');
});

test('标记格式与正则工厂（不共享 lastIndex）', () => {
    const m = mark(3, '摘要', '12:34');
    assert.equal(PASTE_MARKER_ICON, '▣');
    assert.equal(m, '【▣ 摘要 · 12:34 #3】');
    assert.ok(pasteMarkerOneRe().test(m));
    assert.equal(pasteMarkerOneRe().test('x' + m), false);
    const a = pasteMarkerRe();
    const b = pasteMarkerRe();
    a.exec(m); // 推进 a 的 lastIndex
    assert.equal(a.lastIndex > 0, true);
    assert.equal(b.lastIndex, 0); // b 不受影响
});

test('标记恒单行：摘要含换行也不破坏占位（换行已被 pasteSummary 剔除）', () => {
    const m = makePasteMarker(1, '第一行\n第二行', '12:34');
    assert.equal(/[\r\n]/.test(m), false, '占位文本绝不能含换行');
});

test('scanPasteMarkers：按出现顺序、位置正确、不重叠', () => {
    const m1 = mark(1, '甲摘要', '12:34');
    const m2 = mark(22, '乙摘要', '09:01');
    const text = '前' + m1 + '中' + m2 + '后';
    const marks = scanPasteMarkers(text);
    assert.equal(marks.length, 2);
    assert.equal(marks[0].id, 1);
    assert.equal(marks[0].marker, m1);
    assert.equal(text.slice(marks[0].start, marks[0].end), m1);
    assert.equal(marks[1].id, 22);
    assert.equal(text.slice(marks[1].start, marks[1].end), m2);
});

test('markerAtCursor：命中标记范围（含边界），范围外返回 null', () => {
    const m = mark(7);
    const text = 'AB' + m + 'CD';
    const s = text.indexOf(m);
    const e = s + m.length;
    assert.equal(markerAtCursor(text, s)?.id, 7);
    assert.equal(markerAtCursor(text, s + 2)?.id, 7);
    assert.equal(markerAtCursor(text, e)?.id, 7); // 右边界含
    assert.equal(markerAtCursor(text, s - 1), null);
    assert.equal(markerAtCursor(text, e + 1), null);
});

test('buildPasteMirrorHtml：只渲染 store 里存在的 id，手打同形文本保持纯文本', () => {
    const store = new Map([[1, makePasteEntry('hello')]]);
    const m1 = mark(1);
    const m99 = mark(99);
    const html = buildPasteMirrorHtml('前' + m1 + '中' + m99 + '后', store);
    assert.equal((html.match(/class="ai-paste-pill"/g) || []).length, 1, '只有 id=1 渲染成胶囊');
    assert.match(html, /data-paste-id="1"/);
    assert.match(html, /class="ai-paste-pill-close" data-paste-close="1"/, '胶囊带 × 快捷删除按钮');
    assert.ok(html.includes(m99), '手打的标记保持纯文本');
    assert.ok(!html.includes('data-paste-id="99"'));
    assert.ok(!html.includes('data-paste-close="99"'), '手打标记没有删除按钮');
});

test('buildPasteMirrorHtml：普通文本 HTML 转义，不执行脚本', () => {
    const store = new Map([[1, makePasteEntry('x')]]);
    const html = buildPasteMirrorHtml('<script>alert(1)</script>' + mark(1), store);
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.match(html, /data-paste-id="1"/);
});

test('expandPasteMarkers：多标记原位展开、手打不误伤、返回 usedIds', () => {
    const store = new Map([
        [1, makePasteEntry('AAA')],
        [2, makePasteEntry('BBB')],
    ]);
    const {text, usedIds} = expandPasteMarkers(
        '甲' + mark(1) + '乙' + mark(99) + '丙' + mark(2) + '丁', store);
    assert.equal(text, '甲AAA乙' + mark(99) + '丙BBB丁');
    assert.deepEqual(usedIds.sort(), [1, 2]);
});

test('expandPasteMarkers：展开的是 store 里的最新文本（编辑后版本）', () => {
    const store = new Map([[1, {text: '编辑后的内容', charCount: 6, lineCount: 1}]]);
    const {text} = expandPasteMarkers('看这里' + mark(1) + '结束', store);
    assert.equal(text, '看这里编辑后的内容结束');
});

test('countPasteLines：兼容 CRLF/CR/LF、末尾换行不多算、空串算 1 行', () => {
    assert.equal(countPasteLines(''), 1);
    assert.equal(countPasteLines('a'), 1);
    assert.equal(countPasteLines('a\nb'), 2);
    assert.equal(countPasteLines('a\r\nb\rc\nd'), 4);
    assert.equal(countPasteLines('a\nb\n'), 2, '末尾换行不多算一行');
});

test('makePasteEntry / pasteFullDocName / pasteTooltip', () => {
    const entry = makePasteEntry('a\nb\nc');
    assert.equal(entry.text, 'a\nb\nc');
    assert.equal(entry.charCount, 5);
    assert.equal(entry.lineCount, 3);
    assert.equal(pasteFullDocName(4), '粘贴文本 #4.txt');
    const tip = pasteTooltip(4, entry);
    assert.match(tip, /粘贴 #4/);
    assert.match(tip, /5 字符 \/ 3 行/);
    assert.match(tip, /点击查看并编辑全文/);
});

test('粘贴分派阈值：正文上限与附件单件上限同源', () => {
    assert.equal(PASTE_INLINE_MAX_CHARS, 100000, '单条消息正文上限');
    assert.equal(PASTE_ATTACH_MAX_CHARS, 65536, '文本附件单件上限（64KB）');
});

test('decidePasteAction：短文本原样、三档各自的折叠/附件行为', () => {
    const short = 'x'.repeat(1000);
    assert.equal(decidePasteAction(short, {mode: 'collapse'}), 'inline');
    assert.equal(decidePasteAction('', {mode: 'collapse'}), 'inline');
    assert.equal(decidePasteAction(null, {mode: 'collapse'}), 'inline');
    const mid = 'x'.repeat(2000);
    assert.equal(decidePasteAction(mid, {mode: 'collapse'}), 'marker');
    assert.equal(decidePasteAction(mid, {mode: 'attachment'}), 'attach');
    assert.equal(decidePasteAction(mid, {mode: 'off'}), 'inline');
    // 非法档位回落默认（collapse）
    assert.equal(decidePasteAction(mid, {mode: 'bogus'}), 'marker');
});

test('decidePasteAction：超过正文上限一律 file（off 档也不例外）', () => {
    const overflow = 'x'.repeat(PASTE_INLINE_MAX_CHARS + 1);
    for (const mode of AI_PASTE_MODES) {
        assert.equal(decidePasteAction(overflow, {mode}), 'file', mode + ' 超上限必须走落盘附件');
    }
    // 恰好等于上限仍可内联折叠（能发出去）
    assert.equal(decidePasteAction('x'.repeat(PASTE_INLINE_MAX_CHARS), {mode: 'collapse'}), 'marker');
});

test('decidePasteAction：attachment 档超过附件单件上限改走 file，不静默截断', () => {
    assert.equal(decidePasteAction('x'.repeat(PASTE_ATTACH_MAX_CHARS), {mode: 'attachment'}), 'attach');
    assert.equal(decidePasteAction('x'.repeat(PASTE_ATTACH_MAX_CHARS + 1), {mode: 'attachment'}), 'file');
});

test('decidePasteAction：阈值可注入（便于单测与将来调参）', () => {
    // 折叠阈值固定 1000，故用 3000 字符样本；inlineMax / attachMax 可注入。
    assert.equal(decidePasteAction('x'.repeat(3000), {mode: 'attachment', inlineMax: 3000, attachMax: 2500}), 'file');
    assert.equal(decidePasteAction('x'.repeat(2000), {mode: 'attachment', inlineMax: 3000, attachMax: 2500}), 'attach');
    // 非法阈值回落默认值
    assert.equal(decidePasteAction('x'.repeat(2000), {mode: 'attachment', inlineMax: 0, attachMax: -1}), 'attach');
});

test('落盘附件说明与超长占位：都写明字符数与路径', () => {
    const hint = pasteFileAttachmentText('D:/w/.cadt/tmp/paste/paste-1.txt', 120000, 3200);
    assert.match(hint, /120000 字符 \/ 3200 行/);
    assert.match(hint, /D:\/w\/\.cadt\/tmp\/paste\/paste-1\.txt/);
    assert.match(hint, /read_file/);
    const placeholder = pasteOverflowPlaceholder(120000);
    assert.match(placeholder, /120000/);
    assert.match(placeholder, /附件/);
});
