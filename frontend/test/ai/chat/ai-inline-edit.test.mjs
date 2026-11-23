// ai-inline-edit 纯数据层：用户消息附件快照归一 + 保存载荷组装。
// 方案见 docs/finished-plans/inline-message-edit.md。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
    normalizeMessageAttachments,
    inlineEditPayload,
    snapshotFromAttachments,
    INLINE_EDIT_MAX_ITEMS,
    INLINE_EDIT_LABEL_MAX,
} from '../../../src/ai/chat/ai-inline-edit.js';
import {AI_QUOTE_KIND} from '../../../src/ai/chat/ai-quote.js';

test('normalizeMessageAttachments：非数组 / null / 脏项安全', () => {
    assert.deepEqual(normalizeMessageAttachments(null), []);
    assert.deepEqual(normalizeMessageAttachments(undefined), []);
    assert.deepEqual(normalizeMessageAttachments('x'), []);
    assert.deepEqual(normalizeMessageAttachments({kind: 'file'}), []);
    assert.deepEqual(normalizeMessageAttachments([null, 0, 'a', {}]), []);
});

test('normalizeMessageAttachments：只收文本类附件（媒体与引用走既有字段）', () => {
    const kept = normalizeMessageAttachments([
        {kind: 'file', label: 'a.js', path: '/w/a.js', content: 'x'},
        {kind: 'skill', label: 'code-review', content: 'y'},
        {kind: 'selection', label: '选区', path: '/w/b.js', content: 'z'},
        {kind: 'reference', label: '引用', path: '/w/c.js'},
        // 下面三项不进快照：图片走 images、视频走 videos、引用走 content 前缀
        {kind: 'image', label: '图', data: 'AAA'},
        {kind: 'video', label: '视频', data: 'BBB'},
        {kind: AI_QUOTE_KIND, label: '引用', content: 'q'},
    ]);
    assert.deepEqual(kept.map((item) => item.kind), ['file', 'skill', 'selection', 'reference']);
    assert.equal(kept[0].path, '/w/a.js');
    assert.equal(kept[1].content, 'y');
});

test('normalizeMessageAttachments：label / content 截断，数量封顶', () => {
    const long = normalizeMessageAttachments([
        {kind: 'file', label: 'x'.repeat(1000), content: 'y'.repeat(200000)},
    ]);
    assert.equal(long[0].label.length, INLINE_EDIT_LABEL_MAX);
    assert.ok(long[0].content.length <= 64 * 1024);

    const many = normalizeMessageAttachments(
        Array.from({length: INLINE_EDIT_MAX_ITEMS + 20}, (_, i) => ({kind: 'file', label: 'f' + i})),
    );
    assert.equal(many.length, INLINE_EDIT_MAX_ITEMS);
});

test('normalizeMessageAttachments：选区行列范围随消息保留', () => {
    const [item] = normalizeMessageAttachments([{
        kind: 'selection',
        label: '选中',
        content: 'x',
        range: {start: {line: 10, column: 2}, end: {line: 20, column: 5}},
    }]);
    assert.deepEqual(item.range, {start: {line: 10, column: 2}, end: {line: 20, column: 5}});
    // 脏 range 归一为 0，不抛错
    const [dirty] = normalizeMessageAttachments([{kind: 'selection', content: 'x', range: {start: 'no'}}]);
    assert.deepEqual(dirty.range.start, {line: 0, column: 0});
});

test('inlineEditPayload：引用 chip 拼回正文前缀（不进文本附件）', () => {
    const payload = inlineEditPayload([
        {kind: AI_QUOTE_KIND, source: 'assistant', index: 3, scope: 'message', content: '被引用的原话'},
        {kind: 'file', label: 'a.js', content: 'code'},
        {kind: 'image', data: 'AAA'},
        {kind: 'video', mime: 'video/mp4', data: 'BBB'},
    ], '补充说明');
    assert.match(payload.value, /<quote/);
    assert.match(payload.value, /被引用的原话/);
    assert.match(payload.value, /补充说明$/);
    assert.deepEqual(payload.images.map((item) => item.kind), ['image']);
    assert.deepEqual(payload.videos.map((item) => item.kind), ['video']);
    assert.deepEqual(payload.texts.map((item) => item.kind), ['file'], '引用与媒体都不进文本附件');
});

test('inlineEditPayload：只有引用没有正文时 value 仍可用；全空时为空', () => {
    const quoteOnly = inlineEditPayload([
        {kind: AI_QUOTE_KIND, source: 'user', index: 1, scope: 'message', content: '原话'},
    ], '');
    assert.match(quoteOnly.value, /<quote/);
    assert.equal(quoteOnly.texts.length, 0);

    const empty = inlineEditPayload([], '   ');
    assert.equal(empty.value, '');
    assert.equal(empty.images.length + empty.videos.length + empty.texts.length, 0);
    assert.deepEqual(inlineEditPayload(null, null).value, '');
});

test('snapshotFromAttachments：只固化白名单种类，媒体与引用不重复落盘', () => {
    const snapshot = snapshotFromAttachments([
        {kind: 'file', label: 'a.js', path: '/w/a.js', content: 'code', id: 'att-1'},
        {kind: 'skill', label: 'code-review', content: 'skill'},
        {kind: 'image', data: 'AAA'},
        {kind: 'video', data: 'BBB'},
        {kind: AI_QUOTE_KIND, content: 'quote'},
        null,
    ]);
    assert.deepEqual(snapshot.map((item) => item.kind), ['file', 'skill']);
    // 输入区的临时 id 不落盘（快照只留重启后仍能还原的字段）
    assert.equal('id' in snapshot[0], false);
    assert.equal(snapshot[0].path, '/w/a.js');
});

test('snapshotFromAttachments 与 normalizeMessageAttachments 往返稳定', () => {
    const source = [
        {kind: 'file', label: 'a.js', path: '/w/a.js', content: 'code'},
        {kind: 'selection', label: '选中', path: '/w/b.js', content: 'sel', range: {start: {line: 1, column: 1}, end: {line: 2, column: 2}}},
    ];
    const once = normalizeMessageAttachments(snapshotFromAttachments(source));
    const twice = normalizeMessageAttachments(once);
    assert.deepEqual(twice, once);
});

// ---- 编辑态保护：异步重绘不能打断消息原地编辑 ----
// 2026-11-22 用户实测：第一次编辑几秒后莫名退出编辑态，第二次又不会。
// 根因是 renderMessages 无条件 inlineEdit=null，而 handleResourceChange 的会话重读
// （重试最多 ~6s）会在用户打字时触发重绘。修复：重绘前存编辑数据、重绘后恢复。

const panelSrc = readFileSync(new URL('../../../src/ai/ai-panel.js', import.meta.url), 'utf8');

function panelFn(signature) {
    const start = panelSrc.indexOf(signature);
    assert.ok(start >= 0, '找不到函数：' + signature);
    const rest = panelSrc.slice(start + signature.length);
    const next = /\n    function [A-Za-z_]/.exec(rest);
    return signature + (next ? rest.slice(0, next.index) : rest);
}

test('renderMessages：重绘前快照编辑态、重绘后恢复，而非直接丢弃', () => {
    const body = panelFn('function renderMessages(keepScroll)');
    assert.ok(body.includes('snapshotInlineEdit(inlineEdit)'),
        '重绘前必须快照编辑态');
    assert.ok(body.includes('restoreInlineEdit(editSnapshot)'),
        '重绘后必须恢复编辑态');
    // 快照必须早于清空（否则读到的是被丢掉的 DOM）
    const snapAt = body.indexOf('snapshotInlineEdit(inlineEdit)');
    const clearAt = body.indexOf('inlineEdit = null');
    assert.ok(snapAt >= 0 && clearAt >= 0 && snapAt < clearAt,
        '编辑态快照必须先于 inlineEdit 清空');
    // 恢复必须早于函数结束（在 renderMessagesInner 之后）
    const restoreAt = body.indexOf('restoreInlineEdit(editSnapshot)');
    const innerAt = body.indexOf('renderMessagesInner(keepScroll)');
    assert.ok(innerAt >= 0 && restoreAt > innerAt,
        '恢复必须在重绘（renderMessagesInner）之后');
    // 只保护面板主视图，支线标签页编辑由它自己管
    assert.ok(body.includes('!renderTarget'),
        '编辑态保护只针对面板主视图（!renderTarget）');
});

test('snapshotInlineEdit：保存文本/附件/光标，不含 DOM 引用', () => {
    const body = panelFn('function snapshotInlineEdit(state)');
    for (const field of ['sessionId', 'index', 'items', 'text', 'selStart', 'selEnd']) {
        assert.ok(body.includes(field), '快照必须包含 ' + field);
    }
    assert.ok(body.includes('selectionStart') && body.includes('selectionEnd'),
        '光标位置必须从 textarea 读取');
});

test('restoreInlineEdit：校验会话/消息仍有效后用 data-ai-idx 定位新节点', () => {
    const body = panelFn('function restoreInlineEdit(snap)');
    assert.ok(body.includes("currentSession()"), '必须校验会话仍是当前查看的');
    assert.ok(body.includes('canInlineEdit(message, session)'), '必须校验消息仍可编辑');
    assert.ok(body.includes('.ai-msg[data-ai-idx='), '必须按 data-ai-idx 定位新的消息节点');
    assert.ok(body.includes('renderInlineEditor(state)'), '必须在新的 wrap 上重建编辑区');
    assert.ok(body.includes('setSelectionRange'), '恢复后要把光标放回保存的位置');
});
