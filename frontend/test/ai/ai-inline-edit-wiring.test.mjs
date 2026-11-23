// ai-inline-edit 接线护栏：原地编辑的入口 / 保存语义 / 键盘 / 退出 / 快照落盘。
// 这些行为依赖真实 DOM 与 Wails 后端，只能在源码层面锁住接线点（同 ai-tool-wiring 惯例）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const panel = read('../../src/ai/ai-panel.js');
const composer = read('../../src/ai/chat/ai-composer.js');
const store = read('../../src/ai/session/ai-session-store.js');

function sliceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.notEqual(start, -1, '找不到起点：' + startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(end, -1, '找不到终点：' + endMarker);
    return source.slice(start, end);
}

// 从函数签名切到下一个同级函数声明（面板里的函数都是 4 空格缩进）
function sliceFunction(source, marker) {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, '找不到函数：' + marker);
    const rest = source.slice(start + marker.length);
    const next = rest.search(/\n {4}(?:async )?function /);
    return next < 0 ? source.slice(start) : source.slice(start, start + marker.length + next);
}

test('入口：任意一条用户消息都能原地编辑（不再只认最后一条）', () => {
    const actions = sliceFunction(panel, 'function appendActions(wrap, message, index, session, target) {');
    assert.match(actions, /if \(!sessionBusy && canInlineEdit\(message, sessionNow\)\) add\('edit', '编辑'\);/);
    assert.doesNotMatch(actions, /index === lastUser && !sessionBusy\) add\('edit'/, '不允许退回「仅最后一条」');
    const can = sliceFunction(panel, 'function canInlineEdit(message, session) {');
    // 注入类消息不可编辑：截断重发会把它们的语义一起砍掉
    assert.match(can, /message\.systemNote \|\| message\.notice \|\| message\.steer \|\| message\.silent/);
    assert.match(can, /return !message\.app;/);
    // 归档会话只读：同样不可编辑（与 ai-archived-readonly.test.mjs 双保险）
    assert.match(can, /if \(owner && owner\.archivedAt\) return false;/);
});

test('保存：截断到被编辑那条并重新起轮，不读底部输入区', () => {
    const save = sliceFunction(panel, 'async function doSaveInlineEdit(state, session, payload) {');
    assert.match(save, /truncateAt: state\.index/);
    assert.match(save, /allowPendingEdit: false/);
    assert.match(save, /startSessionTurn\(session, payload\.value, \{/);
    assert.match(save, /preserveScroll: true/);
    assert.equal(save.includes('submitText'), false, '保存不得回调 submitText（会去读输入区）');
    assert.equal(save.includes('setAttachments'), false, '保存不得改动输入区附件');
});

test('非末条：先二次确认，取消时编辑态保留', () => {
    const save = sliceFunction(panel, 'function saveInlineEdit(skipConfirm) {');
    assert.match(save, /const tail = Math\.max\(0, session\.messages\.length - state\.index - 1\);/);
    assert.match(save, /askConfirm\('重新发送这条消息？将丢弃它之后的 ' \+ tail \+ ' 条对话。'/);
});

test('保存成功：编辑态作废不能只按对象身份清（重画快照恢复会换掉对象）', () => {
    // startSessionTurn 成功起轮会在当前会话重画消息区，renderMessages 的快照恢复
    // 机制把编辑态原样搬到新消息节点上（防异步重读丢内容），inlineEdit 已换成
    // 恢复出的新对象——只按身份清恒失配，编辑框就会挂在流式回复上不退
    // （2026-11-22 用户实测）。成功路径必须按会话+位置匹配并走 endInlineEdit
    // 统一收口（摘 .editing 类 + 整面重画还原正文）。
    const ok = sliceBetween(panel, 'if (result && result.ok) {', '// 失败：编辑态与内容原样保留');
    assert.match(ok, /inlineEdit\.sessionId === state\.sessionId && inlineEdit\.index === state\.index/);
    assert.match(ok, /endInlineEdit\(\)/);
    assert.doesNotMatch(ok, /if \(inlineEdit === state\) inlineEdit = null;/, '不允许退回只按对象身份清');
});

test('键盘：Esc 取消 / Enter 发送 / Shift+Enter 换行；均不冒泡', () => {
    const editor = sliceFunction(panel, 'function renderInlineEditor(state) {');
    assert.match(editor, /if \(e\.key === 'Escape'\)/);
    // Enter 直接发送；Shift / Alt + Enter 放行走默认换行
    assert.match(editor, /if \(e\.key !== 'Enter'\) return;/);
    assert.match(editor, /if \(e\.shiftKey \|\| e\.altKey\) return;/);
    assert.match(editor, /saveInlineEdit\(e\.ctrlKey \|\| e\.metaKey\);/);
    // 输入法组词中的回车不能当发送
    assert.match(editor, /if \(e\.isComposing \|\| e\.keyCode === 229\) return;/);
    assert.match(editor, /e\.stopPropagation\(\)/);
});

test('跳过确认：Ctrl/Cmd+Enter 与 Ctrl/Cmd+点击直接保存，普通发送仍弹确认', () => {
    const editor = sliceFunction(panel, 'function renderInlineEditor(state) {');
    // 键盘与点击两条入口都传 skipConfirm
    assert.match(editor, /saveInlineEdit\(e\.ctrlKey \|\| e\.metaKey\);/);
    assert.match(editor, /saveBtn\.addEventListener\('click', \(e\) => saveInlineEdit\(e\.ctrlKey \|\| e\.metaKey\)\);/);
    const save = sliceFunction(panel, 'function saveInlineEdit(skipConfirm) {');
    assert.match(save, /if \(tail > 0 && !skipConfirm\) \{/, 'Ctrl/Cmd 捷径跳过确认');
    assert.match(save, /askConfirm\('重新发送这条消息？将丢弃它之后的 ' \+ tail \+ ' 条对话。'/);
});

test('退出：整面重画与切会话都会释放编辑态', () => {
    const render = sliceFunction(panel, 'function renderMessages(keepScroll) {');
    assert.match(render, /if \(inlineEdit\) inlineEdit = null;/);
    const pick = sliceFunction(panel, 'function switchSession(id) {');
    assert.match(pick, /inlineEdit\.sessionId !== id/);
});

test('数据：发送时写快照、重放时回填、序列化自动透传', () => {
    const turn = sliceBetween(panel, 'const userMessage = {', 'foldNoticesBeforeTurn(session)');
    assert.match(turn, /snapshotFromAttachments\(textAttachments\)/);
    assert.match(turn, /if \(inlineAttachments\.length\) userMessage\.attachments = inlineAttachments;/);

    const normalize = sliceBetween(panel, 'function normalizeMessage(raw) {', "if (role === 'tool') {");
    assert.match(normalize, /normalizeMessageAttachments\(raw\.attachments\)/);

    // 落盘是通用白名单（`_` 前缀之外全透传），新字段不需要改序列化
    assert.match(store, /for \(const key of Object\.keys\(message\)\)/);
});

test('附件：chip 渲染单一来源，编辑区复用输入区的附件链', () => {
    assert.match(composer, /export function renderAttachmentChips\(container, items, handlers\)/);
    assert.match(composer, /const pickFiles = ctx\.pickFiles;/);
    assert.match(composer, /async function pickAttachmentFiles\(opts\)/);
    assert.match(composer, /pickAttachmentFiles,/);
    // 粘贴解析抽成单一来源：输入区 Ctrl+V 与编辑区 paste 走同一份（图片/视频/源准入）
    assert.match(composer, /async function attachmentsFromDataTransfer\(data, opts\)/);
    assert.match(composer, /attachmentsFromDataTransfer,/);
    const inputPaste = sliceFunction(composer, 'async function handleInputPaste(e) {');
    assert.match(inputPaste, /await attachmentsFromDataTransfer\(data\)/);

    const editor = sliceFunction(panel, 'function renderInlineEditor(state) {');
    assert.match(editor, /const attach = document\.createElement\('div'\);/);
    assert.match(editor, /ai-edit-attach ai-attach hidden/, '附件条复用输入区的 .ai-attach 布局');
    // 编辑区支持 Ctrl+V 贴图：纯文本粘贴放行走默认行为
    assert.match(editor, /addEventListener\('paste'/);
    assert.match(editor, /attachmentsFromDataTransfer\(data, \{currentImages\}\)/);
    const chips = sliceFunction(panel, 'function renderInlineAttachments(state) {');
    assert.match(chips, /renderAttachmentChips\(state\.attachEl/, 'chip 渲染走单一来源');
    const add = sliceFunction(panel, 'async function addInlineAttachments(state) {');
    assert.match(add, /pickAttachmentFiles\(\{currentImages\}\)/);
    assert.match(add, /if \(inlineEdit !== state\) return;/);
});

test('编辑区：占满整行并随内容自动增高', () => {
    const style = read('../../src/style.css');
    assert.match(style, /\.ai-msg\.user\.editing \{[^}]*max-width: none/, '编辑态要解除气泡的收缩宽度');
    assert.match(style, /\.ai-msg\.user\.editing \{[^}]*align-self: stretch/);
    assert.match(style, /\.ai-edit-input \{[^}]*min-height: 88px/);
    const grow = sliceFunction(panel, 'function autoGrowInline(input) {');
    assert.match(grow, /input\.style\.height = 'auto'/);
    assert.match(grow, /input\.scrollHeight/);
    assert.match(grow, /Math\.min\(520/, '上限与 CSS 的 max-height 同口径');
});

test('编辑区还原：媒体来自 images/videos、引用来自 content 前缀、文本类来自快照', () => {
    const load = sliceFunction(panel, 'function inlineAttachmentsOf(message) {');
    assert.match(load, /attachmentsFromImages\(message\.images\)\.concat\(attachmentsFromVideos\(message\.videos\)\)/);
    assert.match(load, /splitTurnReminderPrefix\(message\.content \|\| ''\)/);
    assert.match(load, /splitQuotePrefix\(parsedReminder\.body\)/);
    assert.match(load, /normalizeMessageAttachments\(message\.attachments\)/);
    // 旧消息的文本类附件已固化进环境块：识别出来并给说明
    assert.match(load, /legacyPacked/);
    const renderer = sliceFunction(panel, 'function renderInlineAttachments(state) {');
    assert.match(renderer, /这条消息的文件附件已固化进上下文/);
});
