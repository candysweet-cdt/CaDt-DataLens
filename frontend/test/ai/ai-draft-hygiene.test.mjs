// ai-draft-hygiene：输入草稿与排队 / 冲刷的卫生守卫（2026-11-22 排队消息回流输入框实测）。
// 根因：输入内容被「排队 / 发送」消费后，会话草稿（内存 Map + localStorage）不作废，
// 而冲刷代发会把消息瞬态回填进输入区——期间切走会话会把回填文本沉淀成草稿，切回时
// 复活出已发出的文本。本文件锁住四个作废 / 保持现场的接线点；行为级断言在
// ai-message-queue.test.mjs（flushThroughComposer 两例）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const composer = read('../../src/ai/chat/ai-composer.js');
const panel = read('../../src/ai/ai-panel.js');
const queue = read('../../src/ai/chat/ai-message-queue.js');

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
    assert.match(body, /dropComposerDraft\(session\.id\);/, '发送消费输入后草稿必须作废（直发 / 排队冲刷同口径）');
});

test('switchSession：同 id 重复切换保持输入区现场（不保存也不用草稿覆盖）', () => {
    const body = sliceFunction(panel, 'async function switchSession(id) {');
    assert.match(body, /const sameSession = !!\(previous && previous\.id === id\);/);
    assert.match(body, /if \(previous && !sameSession\) \{\s*saveComposerDraft\(previous\.id\);/);
    // loadComposerDraft 必须在 sameSession 守卫下：同 id 切换不复活旧草稿、不打断正在敲的内容
    assert.match(body, /if \(!sameSession\) loadComposerDraft\(id, target\);/);
});

test('面板接线：dropComposerDraft 注入 composer 与队列两个消费方', () => {
    const composerCtx = sliceFunction(panel, 'const composerMod = createAIComposer({');
    assert.match(composerCtx, /dropComposerDraft: \(sessionId\) => dropComposerDraft\(sessionId\)/);
    const queueCtxStart = panel.indexOf('const queueMod = createAIMessageQueue({');
    assert.notEqual(queueCtxStart, -1);
    const queueCtx = panel.slice(queueCtxStart, panel.indexOf('});', queueCtxStart));
    assert.match(queueCtx, /dropComposerDraft: \(sessionId\) => dropComposerDraft\(sessionId\)/);
    // 队列模块按可选依赖读取（测试桩 / 旧装配不注入时跳过）
    assert.match(queue, /const dropComposerDraft = typeof ctx\.dropComposerDraft === 'function' \? ctx\.dropComposerDraft : null;/);
});
