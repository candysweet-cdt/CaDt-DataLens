// ai-paste 纯函数护栏：三档模式、阈值、标记扫描、镜像 HTML（XSS 转义）、展开、光标命中、行数。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LARGE_PASTE_CHAR_THRESHOLD, AI_PASTE_MODES, DEFAULT_AI_PASTE_MODE,
    normalizePasteMode, shouldFoldPaste, makePasteMarker, pasteMarkerRe, pasteMarkerOneRe,
    scanPasteMarkers, markerAtCursor, buildPasteMirrorHtml, expandPasteMarkers,
    countPasteLines, makePasteEntry, pasteFullDocName, pasteTooltip,
} from '../../../src/ai/chat/ai-paste.js';

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

test('标记格式与正则工厂（不共享 lastIndex）', () => {
    assert.equal(makePasteMarker(3), '⟦贴3⟧');
    assert.equal(makePasteMarker(0), '⟦贴0⟧');
    assert.ok(pasteMarkerOneRe().test('⟦贴12⟧'));
    assert.equal(pasteMarkerOneRe().test('x⟦贴12⟧'), false);
    const a = pasteMarkerRe();
    const b = pasteMarkerRe();
    a.exec('⟦贴1⟧'); // 推进 a 的 lastIndex
    assert.equal(a.lastIndex > 0, true);
    assert.equal(b.lastIndex, 0); // b 不受影响
});

test('scanPasteMarkers：按出现顺序、位置正确、不重叠', () => {
    const text = '甲⟦贴1⟧乙⟦贴22⟧丙';
    const marks = scanPasteMarkers(text);
    assert.equal(marks.length, 2);
    assert.equal(marks[0].id, 1);
    assert.equal(marks[0].marker, '⟦贴1⟧');
    assert.equal(text.slice(marks[0].start, marks[0].end), '⟦贴1⟧');
    assert.equal(marks[1].id, 22);
    assert.equal(text.slice(marks[1].start, marks[1].end), '⟦贴22⟧');
});

test('markerAtCursor：命中标记范围（含边界），范围外返回 null', () => {
    const text = 'AB⟦贴7⟧CD';
    const s = text.indexOf('⟦贴7⟧');
    const e = s + '⟦贴7⟧'.length;
    assert.equal(markerAtCursor(text, s)?.id, 7);
    assert.equal(markerAtCursor(text, s + 2)?.id, 7);
    assert.equal(markerAtCursor(text, e)?.id, 7); // 右边界含
    assert.equal(markerAtCursor(text, s - 1), null);
    assert.equal(markerAtCursor(text, e + 1), null);
});

test('buildPasteMirrorHtml：只渲染 store 里存在的 id，手打同形文本保持纯文本', () => {
    const store = new Map([[1, makePasteEntry('hello')]]);
    const html = buildPasteMirrorHtml('前⟦贴1⟧中⟦贴99⟧后', store);
    assert.equal((html.match(/ai-paste-pill/g) || []).length, 1, '只有 id=1 渲染成胶囊');
    assert.match(html, /data-paste-id="1"/);
    assert.ok(html.includes('⟦贴99⟧'), '手打的 ⟦贴99⟧ 保持纯文本');
    assert.ok(!html.includes('data-paste-id="99"'));
});

test('buildPasteMirrorHtml：普通文本 HTML 转义，不执行脚本', () => {
    const store = new Map([[1, makePasteEntry('x')]]);
    const html = buildPasteMirrorHtml('<script>alert(1)</script>⟦贴1⟧', store);
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.match(html, /data-paste-id="1"/);
});

test('expandPasteMarkers：多标记原位展开、手打不误伤、返回 usedIds', () => {
    const store = new Map([
        [1, makePasteEntry('AAA')],
        [2, makePasteEntry('BBB')],
    ]);
    const {text, usedIds} = expandPasteMarkers('甲⟦贴1⟧乙⟦贴99⟧丙⟦贴2⟧丁', store);
    assert.equal(text, '甲AAA乙⟦贴99⟧丙BBB丁');
    assert.deepEqual(usedIds.sort(), [1, 2]);
});

test('expandPasteMarkers：展开的是 store 里的最新文本（编辑后版本）', () => {
    const store = new Map([[1, {text: '编辑后的内容', charCount: 6, lineCount: 1}]]);
    const {text} = expandPasteMarkers('看这里⟦贴1⟧结束', store);
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
