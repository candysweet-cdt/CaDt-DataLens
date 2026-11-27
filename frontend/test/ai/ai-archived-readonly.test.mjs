// ai-archived-readonly.test.mjs —— 归档会话只读态接线护栏。
// 归档会话不允许编辑消息、不允许发送消息：视觉（横幅 + 置灰）、入口（改写动作收起）、
// 兜底（失败文案不露裸 reason 码）三层都依赖真实 DOM / 后端，只能在源码层面锁住接线点。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const panel = read('../../src/ai/ai-panel.js');
const html = read('../../index.html');
const style = read('../../src/style.css');

function sliceFunction(source, marker) {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, '找不到函数：' + marker);
    const rest = source.slice(start + marker.length);
    const next = rest.search(/\n {4}(?:async )?function /);
    return next < 0 ? source.slice(start) : source.slice(start, start + marker.length + next);
}

test('视觉：composer 里有归档横幅与「取消归档」出口，非隐藏时可见', () => {
    assert.match(html, /id="ai-archived-banner" class="ai-archived-banner hidden"/);
    assert.match(html, /id="ai-unarchive-btn" class="ai-archived-banner-btn">取消归档</);
    assert.match(style, /\.ai-archived-banner\.hidden \{ display: none; \}/);
    assert.match(style, /\.ai-composer\.is-archived \.ai-input \{[^}]*cursor: not-allowed/);
    assert.match(style, /\.ai-composer\.is-archived \.ai-composer-bottom > \.ai-pill \{[^}]*pointer-events: none/);
});

test('视觉：横幅由 updateSendState 统一驱动，textarea 只读、按钮点击即取消归档', () => {
    const sync = sliceFunction(panel, 'function syncArchivedBanner(archived) {');
    assert.match(sync, /el\.archivedBanner\.classList\.toggle\('hidden', !on\)/);
    assert.match(sync, /el\.composer\.classList\.toggle\('is-archived', on\)/);
    assert.match(sync, /el\.input\.readOnly = on/);
    assert.match(panel, /if \(el\.unarchiveBtn\) el\.unarchiveBtn\.addEventListener\('click'/);
    assert.match(panel, /archiveSession\(session, false\)/);
});

test('入口：归档会话的编辑动作收起，改写动作（重试/重新生成/回退/分支）全部禁用', () => {
    const actions = sliceFunction(panel, 'function appendActions(wrap, message, index, session, target) {');
    assert.match(actions, /const archived = !!\((sessionNow && sessionNow\.archivedAt)\)|const archived = !!\((sessionNow && sessionNow\.archivedAt)\)/);
    assert.match(actions, /canInlineEdit\(message, sessionNow\)/);
    // 四条改写动作都带 !archived
    assert.match(actions, /!sessionBusy && !archived && \(isLast \|\| stepMode === 'full'\)\) add\('retry'/);
    assert.match(actions, /isLast && !sessionBusy && !archived\) \{\s*add\('regenerate'/);
    assert.match(actions, /!sessionBusy && !archived && !isSessionBusy\(sessionNow\.id\)/);
    assert.match(actions, /!sessionBusy && !archived\) add\('branch'/);
    // 只读动作保留：复制、投递
    assert.match(actions, /add\('copy', '复制'\)/);
    assert.match(actions, /add\('deliver', '投递到会话…'\)/);
});

test('入口：canInlineEdit 与保存路径都挡住归档会话', () => {
    const can = sliceFunction(panel, 'function canInlineEdit(message, session) {');
    assert.match(can, /if \(owner && owner\.archivedAt\) return false;/);
    const begin = sliceFunction(panel, 'function beginInlineEdit(wrap, session, index) {');
    // 进编辑态与保存都走与起轮内核同源的门禁（canStartTurn），归档只是其中一维
    assert.match(begin, /canStartTurn\(session, \{busy: isSessionBusy\(session\.id\)\}\)/);
    const save = sliceFunction(panel, 'function saveInlineEdit(skipConfirm) {');
    assert.match(save, /canStartTurn\(session, \{busy: isSessionBusy\(session\.id\)\}\)/);
    assert.match(save, /gate\.reason === 'archived'/);
});

test('兜底：archived 失败原因统一成中文文案，不露裸 reason 码', () => {
    // 文案单一来源：turnStartFailureText（手动发送 / 原地编辑 / 排队冲刷共用）；薄壳只写状态栏
    const text = sliceFunction(panel, 'function turnStartFailureText(result, opts) {');
    assert.match(text, /case 'archived':/);
    assert.match(text, /'该会话已归档，取消归档后再发送'/);
    assert.match(text, /'发送失败：' \+ \(result\.reason \|\| 'unknown'\)/,
        '通用兜底仍在，archived 已在前面 return，不会走到「发送失败：archived」');
    const flash = sliceFunction(panel, 'function flashTurnStartFailure(result, opts) {');
    assert.match(flash, /turnStartFailureText\(result, opts\)/);
    assert.match(flash, /flash\(text, true\)/);
    // 编辑保存（2026-11-27 收口）：不再自建 reason 表，整条失败链复用主表 + 编辑语境
    const save = sliceFunction(panel, 'async function doSaveInlineEdit(state, session, payload) {');
    assert.match(save, /flashTurnStartFailure\(result, \{context: 'inline-edit'\}\)/, '编辑保存必须复用统一文案');
    assert.doesNotMatch(save, /reason === 'archived'/, '编辑保存不再自建失败分支');
    // 编辑态专属文案只在主表里出现（busy / empty 两条），其余 reason 与手动发送同款
    assert.match(text, /case 'busy':\s*return editing \? '该会话刚开始新一轮，稍后再保存'/);
    assert.match(text, /case 'empty':\s*return editing \? '消息不能为空'/);
});
