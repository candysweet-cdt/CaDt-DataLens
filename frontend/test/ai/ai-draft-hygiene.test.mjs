// ai-draft-hygiene：输入草稿与排队 / 冲刷的卫生守卫（2026-11-22 排队消息回流输入框实测）。
// 根因：输入内容被「排队 / 发送」消费后，会话草稿（内存 Map + localStorage）不作废，
// 而冲刷代发会把消息瞬态回填进输入区——期间切走会话会把回填文本沉淀成草稿，切回时
// 复活出已发出的文本。代发路径已于 2026-11-27 删除（方案 B，冲刷统一走内核起轮），
// 那条回填-沉淀链随之消失；这里只剩三个作废接线点，行为级断言在
// ai-message-queue.test.mjs（冲刷不读写输入区两例）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const composer = read('../../src/ai/chat/ai-composer.js');
const panel = read('../../src/ai/ai-panel.js');

function sliceFunction(source, marker) {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, '找不到函数：' + marker);
    const end = source.indexOf('\n    function ', start + marker.length);
    return source.slice(start, end < 0 ? undefined : end);
}

test('captureComposerMessage：输入被排队/插话/抢占消费后立即作废会话草稿', () => {
    const body = sliceFunction(composer, 'function captureComposerMessage() {');
    const clearAt = body.indexOf("el.input.value = '';");
    assert.notEqual(clearAt, -1, '排队路径必须清输入区');
    const dropAt = body.indexOf('dropComposerDraft(session.id)');
    assert.notEqual(dropAt, -1, '缺少草稿作废调用');
    assert.ok(dropAt > clearAt, '草稿作废要在清空输入区之后（同一次消费内完成）');
    // 未注入依赖时安全跳过（测试桩 / 旧装配）
    assert.match(composer, /const dropComposerDraft = typeof ctx\.dropComposerDraft === 'function' \? ctx\.dropComposerDraft : null;/);
});

test('editQueuedMessage：输入区原有内容挪进队列时同步作废草稿', () => {
    const body = sliceFunction(composer, 'function editQueuedMessage(item) {');
    const enqueueAt = body.indexOf('queue.enqueue({');
    assert.notEqual(enqueueAt, -1);
    const dropAt = body.indexOf('dropComposerDraft(session.id)');
    assert.notEqual(dropAt, -1, '取回编辑把原输入挪进队列，草稿必须同步作废');
    assert.ok(dropAt > enqueueAt);
});

test('submitText onStarted：起轮成功清输入区时同步作废会话草稿', () => {
    const start = panel.indexOf('onStarted: () => {');
    assert.notEqual(start, -1, '找不到 onStarted');
    const end = panel.indexOf('\n            },', start);
    const body = panel.slice(start, end);
    assert.match(body, /el\.input\.value = '';/);
    // 参数名可能是 session.id / 提交时捕获的 sessionId（异步起轮期间防误清）
    assert.match(body, /dropComposerDraft\((?:session\.id|sessionId)\);/, '发送消费输入后草稿必须作废');
});

test('switchSession：同 id 重复切换保持输入区现场（不保存也不用草稿覆盖）', () => {
    const body = sliceFunction(panel, 'async function switchSession(id) {');
    assert.match(body, /const sameSession = !!\(previous && previous\.id === id\);/);
    assert.match(body, /if \(previous && !sameSession\) \{\s*saveComposerDraft\(previous\.id\);/);
    // loadComposerDraft 必须在 sameSession 守卫下：同 id 切换不复活旧草稿、不打断正在敲的内容
    assert.match(body, /if \(!sameSession\) loadComposerDraft\(id, target\);/);
});

test('面板接线：dropComposerDraft 注入 composer 消费方', () => {
    const composerCtx = sliceFunction(panel, 'let composerMod = createAIComposer({');
    assert.match(composerCtx, /dropComposerDraft: \(sessionId\) => dropComposerDraft\(sessionId\)/);
    // 队列冲刷自 2026-11-27（方案 B）不再经过输入区，队列模块也就不再需要草稿作废依赖：
    // 少一个消费方是有意的，不是漏注入
    const queueCtxStart = panel.indexOf('const queueMod = createAIMessageQueue({');
    assert.notEqual(queueCtxStart, -1);
    const queueCtx = panel.slice(queueCtxStart, panel.indexOf('});', queueCtxStart));
    assert.equal(queueCtx.includes('dropComposerDraft'), false, '冲刷不碰输入区，无需草稿补偿');
});

test('长文本胶囊全文随草稿持久化，重启后不再退化成裸标记', () => {
    assert.match(composer, /exportPasteEntries:\s*\(\)\s*=>/);
    assert.match(composer, /importPasteEntries:\s*\(entries\)\s*=>/);
    assert.match(panel, /const paste = typeof composerMod !== 'undefined'[\s\S]{0,160}composerMod\.exportPasteEntries\(\)/);
    assert.match(panel, /kvSetJson\(draftLSKey\(sessionId\), \{text, paste\}\)/);
    assert.match(panel, /composerMod\.importPasteEntries\(draft \? draft\.paste : \[\]\)/);
});
