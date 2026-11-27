// ai-message-queue 纯模型测试：单队列 + delivery 车道（queue / steer）的增删改与快照。
// 方案见 docs/finished-plans/ai-turn-steering.md §6.1。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createQueueModel, createAIMessageQueue, formatSteerMessage, queuedAttachmentsPayload, persistSafeItem, restorableQueueItems} from '../../../src/ai/chat/ai-message-queue.js';

const item = (over = {}) => ({sessionId: 's1', text: 'hi', attachments: [], ...over});

test('enqueue：默认 queue 车道，显式 steer 生效，id 是唯一字符串', () => {
    const model = createQueueModel();
    const a = model.enqueue(item());
    const b = model.enqueue(item({delivery: 'steer'}));
    assert.equal(a.delivery, 'queue');
    assert.equal(b.delivery, 'steer');
    assert.equal(typeof a.id, 'string');
    assert.notEqual(a.id, b.id);
    assert.equal(a.ts > 0, true);
    assert.equal(a.roundId, '');

    const ids = new Set();
    const many = createQueueModel();
    for (let i = 0; i < 200; i++) ids.add(many.enqueue(item()).id);
    assert.equal(ids.size, 200);
});

test('enqueue：attachments 原样保存，text 归一为字符串', () => {
    const model = createQueueModel();
    const attachments = [{kind: 'image', data: 'x'}];
    const queued = model.enqueue({sessionId: 's1', text: null, attachments});
    assert.equal(queued.text, '');
    assert.deepEqual(queued.attachments, attachments);
});

test('enqueue：同毫秒入队按单调 seq 定序，persistSafeItem 保留 seq', () => {
    const originalNow = Date.now;
    Date.now = () => 1700000000000;
    try {
        const model = createQueueModel();
        const a = model.enqueue(item({text: 'a'}));
        const b = model.enqueue(item({text: 'b'}));
        assert.equal(a.ts, b.ts, '构造同毫秒场景');
        assert.ok(b.seq > a.seq, 'seq 必须单调递增，不能依赖 Date.now');
        assert.equal(persistSafeItem(a).seq, a.seq, '快照保留 seq');
    } finally {
        Date.now = originalNow;
    }
});

test('drainSteer：只取该会话的 steer、按 FIFO、取后移除；queue 条目不受影响', () => {
    const model = createQueueModel();
    const q1 = model.enqueue(item({text: 'q1'}));
    const s1 = model.enqueue(item({text: 's1', delivery: 'steer'}));
    const other = model.enqueue(item({sessionId: 's2', text: 'other', delivery: 'steer'}));
    const s2 = model.enqueue(item({text: 's2', delivery: 'steer'}));
    const q2 = model.enqueue(item({text: 'q2'}));

    const taken = model.drainSteer('s1');
    assert.deepEqual(taken.map((it) => it.text), ['s1', 's2']);
    assert.deepEqual(model.forSession('s1').map((it) => it.text), ['q1', 'q2']);
    assert.deepEqual(model.forSession('s2').map((it) => it.id), [other.id]);
    assert.equal(model.hasSteer('s1'), false);
    assert.equal(model.hasSteer('s2'), true);
    // 取走的对象身份不变（回滚 / 改投按 id 定位仍成立）
    assert.equal(taken[0], s1);
    assert.equal(taken[1], s2);
    assert.equal(q1.delivery, 'queue');
    assert.equal(q2.delivery, 'queue');
});

test('drainSteer：空队列 / 无 steer 会话返回空数组', () => {
    const model = createQueueModel();
    assert.deepEqual(model.drainSteer('nope'), []);
    model.enqueue(item());
    assert.deepEqual(model.drainSteer('s1'), []);
});

test('hasSteer / setDelivery：跨会话隔离、重复改投返回 false', () => {
    const model = createQueueModel();
    const a = model.enqueue(item());
    assert.equal(model.hasSteer('s1'), false);
    assert.equal(model.setDelivery(a, 'steer'), true);
    assert.equal(model.hasSteer('s1'), true);
    assert.equal(model.hasSteer('s2'), false);
    assert.equal(model.setDelivery(a, 'steer'), false);
    assert.equal(model.setDelivery({id: 'missing'}, 'steer'), false);
    assert.equal(model.setDelivery(a, 'queue'), true);
    assert.equal(model.hasSteer('s1'), false);
});

test('fallbackSteerToQueue：只降级目标会话的 steer，返回是否有改动', () => {
    const model = createQueueModel();
    model.enqueue(item({text: 's1', delivery: 'steer'}));
    const other = model.enqueue(item({sessionId: 's2', text: 's2', delivery: 'steer'}));
    assert.equal(model.fallbackSteerToQueue('s1'), true);
    assert.equal(model.forSession('s1')[0].delivery, 'queue');
    assert.equal(other.delivery, 'steer');
    assert.equal(model.fallbackSteerToQueue('s1'), false);
});

test('clearSteer：丢弃目标会话的 steer，保留 queue 与其他会话', () => {
    const model = createQueueModel();
    model.enqueue(item({text: 'q'}));
    model.enqueue(item({text: 's', delivery: 'steer'}));
    model.enqueue(item({sessionId: 's2', text: 'other', delivery: 'steer'}));
    const dropped = model.clearSteer('s1');
    assert.deepEqual(dropped.map((it) => it.text), ['s']);
    assert.deepEqual(model.forSession('s1').map((it) => it.text), ['q']);
    assert.equal(model.forSession('s2').length, 1);
    assert.deepEqual(model.clearSteer('s1'), []);
});

test('restoreItems：按时间顺序放回同会话队列项之间并改投 queue（drain 后预算回滚）', () => {
    const model = createQueueModel();
    const existing = model.enqueue(item({text: 'existing'}));
    const a = model.enqueue(item({text: 'a', delivery: 'steer'}));
    const b = model.enqueue(item({text: 'b', delivery: 'steer'}));
    const drained = model.drainSteer('s1');
    model.restoreItems(drained, 'queue');
    // FIFO：先排队的 existing 仍在 a/b 之前（回滚不能插队）
    assert.deepEqual(model.forSession('s1').map((it) => it.text), ['existing', 'a', 'b']);
    assert.equal(model.hasSteer('s1'), false);
    assert.equal(model.forSession('s1')[0], existing);
});

test('restoreItems：同会话没有更晚项时落到队尾，跨会话不影响本会话顺序', () => {
    const model = createQueueModel();
    const a = model.enqueue(item({text: 'a', delivery: 'steer'}));
    model.enqueue(item({sessionId: 's2', text: 'other'}));
    model.restoreItems(model.drainSteer('s1'), 'queue');
    assert.deepEqual(model.forSession('s1').map((it) => it.text), ['a']);
    assert.equal(model.forSession('s2').length, 1);
    assert.equal(a.delivery, 'queue');
});

test('restoreItems：同毫秒按 seq 顺序回插，ts 不参与新条目排序', () => {
    const model = createQueueModel();
    const a = model.enqueue(item({text: 'a', delivery: 'steer'}));
    const b = model.enqueue(item({text: 'b', delivery: 'steer'}));
    const drained = model.drainSteer('s1');
    const later = model.enqueue(item({text: 'later'}));
    a.ts = b.ts = later.ts = 1700000000000;
    // 故意打回 drain 顺序：恢复必须按 seq 还原，而不是按 ts 或传入顺序。
    model.restoreItems(drained.slice().reverse(), 'queue');
    assert.deepEqual(model.forSession('s1').map((it) => it.text), ['a', 'b', 'later']);
});

test('restoreItems：交错队列逐条归位，旧插话不能越过较新的排队消息', () => {
    const model = createQueueModel();
    const q1 = model.enqueue({sessionId: 's1', text: 'q1', delivery: 'queue'});
    const a = model.enqueue({sessionId: 's1', text: 'steer-a', delivery: 'steer'});
    const q2 = model.enqueue({sessionId: 's1', text: 'q2', delivery: 'queue'});
    const b = model.enqueue({sessionId: 's1', text: 'steer-b', delivery: 'steer'});
    model.drainSteer('s1');
    model.restoreItems([a, b]);
    assert.deepEqual(model.forSession('s1').map((item) => item.id), [q1.id, a.id, q2.id, b.id]);
});

test('restoreItems：旧快照没有 seq 时回落 ts，保持旧数据可恢复', () => {
    const model = createQueueModel();
    const existing = {id: 'old-existing', sessionId: 's1', text: 'existing', ts: 20};
    model.restore([existing]);
    const old = {id: 'old-item', sessionId: 's1', text: 'old', ts: 10};
    model.restoreItems([old], 'queue');
    assert.deepEqual(model.forSession('s1').map((it) => it.text), ['old', 'existing']);
    assert.equal(old.delivery, 'queue');
});

test('reorderSession：只重排目标会话的槽位，其它会话位置不动', () => {
    const model = createQueueModel();
    const a = model.enqueue(item({text: 'a'}));
    const other = model.enqueue(item({sessionId: 's2', text: 'other'}));
    const b = model.enqueue(item({text: 'b'}));
    const c = model.enqueue(item({text: 'c'}));
    assert.equal(model.reorderSession('s1', [c.id, a.id, b.id]), true);
    assert.deepEqual(model.forSession('s1').map((it) => it.text), ['c', 'a', 'b']);
    // 跨会话槽位保持不动（flush 按会话取队首，跨会话相对位置不影响消费）
    assert.deepEqual(model.all().map((it) => it.text), ['c', 'other', 'a', 'b']);
});

test('reorderSession：未知 id 忽略、漏掉的条目按原顺序补在末尾', () => {
    const model = createQueueModel();
    const a = model.enqueue(item({text: 'a'}));
    const b = model.enqueue(item({text: 'b'}));
    assert.equal(model.reorderSession('s1', ['missing', b.id]), true);
    assert.deepEqual(model.forSession('s1').map((it) => it.text), ['b', 'a']);
    assert.equal(model.reorderSession('s1', []), true);
    assert.deepEqual(model.forSession('s1').map((it) => it.text), ['b', 'a']);
    assert.equal(a.text, 'a');
});

test('snapshot：只含目标会话、完整深拷贝（嵌套附件对象也不共享）', () => {
    const model = createQueueModel();
    model.enqueue(item({
        text: 'mine',
        attachments: [{kind: 'image', data: 'x'}, {kind: 'selection', start: {line: 1, column: 2}}],
    }));
    model.enqueue(item({sessionId: 's2', text: 'theirs'}));
    const snap = model.snapshot('s1');
    assert.equal(snap.sessionId, 's1');
    assert.deepEqual(snap.items.map((it) => it.text), ['mine']);
    snap.items[0].text = 'changed';
    snap.items[0].attachments[0].data = 'changed';
    snap.items[0].attachments[1].start.line = 99;
    const live = model.forSession('s1')[0];
    assert.equal(live.text, 'mine');
    assert.equal(live.attachments[0].data, 'x');
    assert.equal(live.attachments[1].start.line, 1);
});

test('clearForSession / clearAll：连同 steer 一起清掉', () => {
    const model = createQueueModel();
    model.enqueue(item({delivery: 'steer'}));
    model.enqueue(item({text: 'q'}));
    model.enqueue(item({sessionId: 's2', delivery: 'steer'}));
    model.clearForSession('s1');
    assert.equal(model.forSession('s1').length, 0);
    assert.equal(model.forSession('s2').length, 1);
    model.clearAll();
    assert.equal(model.hasItems(), false);
});

test('indexOf / remove / insert：所有权 API 行为不变', () => {
    const model = createQueueModel();
    const a = model.enqueue(item({text: 'a'}));
    const b = model.enqueue(item({text: 'b'}));
    assert.equal(model.indexOf(a), 0);
    assert.equal(model.remove(a), true);
    assert.equal(model.remove(a), false);
    model.insert(0, a);
    assert.deepEqual(model.all().map((it) => it.text), ['a', 'b']);
    assert.equal(model.indexOf(b), 1);
});

test('DOM 壳：clearQueueForSession 同时清 steer 与抢占待发标记', () => {
    // el.queue 为空时 renderMessageQueue 直接 return，不需要真 DOM
    const shell = createAIMessageQueue({el: {}});
    shell.enqueueItem({sessionId: 's1', text: 'steer', delivery: 'steer'});
    shell.enqueueItem({sessionId: 's1', text: 'queued'});
    shell.enqueueItem({sessionId: 's2', text: 'other', delivery: 'steer'});
    shell.addInterject('s1');
    assert.equal(shell.itemsForSession('s1').length, 2);
    assert.equal(shell.hasSteer('s1'), true);
    assert.equal(shell.hasInterject('s1'), true);
    shell.clearQueueForSession('s1');
    assert.equal(shell.itemsForSession('s1').length, 0);
    assert.equal(shell.hasSteer('s1'), false);
    assert.equal(shell.hasInterject('s1'), false);
    assert.equal(shell.itemsForSession('s2').length, 1);
});

test('入队唤醒 wait_agent：只有 steer 车道 notify 且带来源，排队不打扰等待', () => {
    // 方案 docs/finished-plans/ai-wait-input-gestures.md：排队按语义本轮结束后送达，
    // 唤醒只会让等待白醒一轮；插话才唤醒（wait 返回后紧接的轮边界就会 drain）。
    const calls = [];
    const shell = createAIMessageQueue({
        el: {},
        inboxWaiters: {notify: (sessionId, source) => calls.push([sessionId, source])},
    });
    shell.enqueueItem({sessionId: 's1', text: '排队'});
    shell.enqueueItem({sessionId: 's1', text: '插话', delivery: 'steer'});
    assert.deepEqual(calls, [['s1', 'steer']], '排队不 notify；steer notify 带来源');
});

test('队列行抢占：改投 queue、移到队首、停轮并登记待冲刷', () => {
    let stopped = 0;
    const live = {sessionId: 's1', stopped: false, finished: false, roundId: 'r'};
    const shell = createAIMessageQueue({
        el: {},
        streams: new Map([['s1', live]]),
        compactOf: () => false,
        getStream: () => live,
        flash: () => {},
        stopGeneration: () => { stopped += 1; },
    });
    const a = shell.enqueueItem({sessionId: 's1', text: 'steer', delivery: 'steer'});
    shell.enqueueItem({sessionId: 's1', text: 'queued'});
    shell.preemptQueuedItem(a);
    assert.equal(a.delivery, 'queue');
    assert.equal(shell.itemsForSession('s1')[0], a);
    assert.equal(shell.hasInterject('s1'), true);
    assert.equal(stopped, 1);
});

test('队列行抢占：其它 steer 降级保留，不被 clearSteer 连带丢弃', () => {
    // 2026-11-22 实测 bug：队列里两条插话，抢占其中一条后另一条消失。
    // 根因是 stopGeneration / finishStream 的 clearSteer 清掉本会话所有 steer。
    let stopped = 0;
    const live = {sessionId: 's1', stopped: false, finished: false, roundId: 'r'};
    const shell = createAIMessageQueue({
        el: {},
        streams: new Map([['s1', live]]),
        compactOf: () => false,
        getStream: () => live,
        flash: () => {},
        stopGeneration: () => { stopped += 1; },
    });
    const a = shell.enqueueItem({sessionId: 's1', text: 'A', delivery: 'steer'});
    const b = shell.enqueueItem({sessionId: 's1', text: 'B', delivery: 'steer'});
    const other = shell.enqueueItem({sessionId: 's2', text: 'other', delivery: 'steer'});
    shell.preemptQueuedItem(a);

    // A 被抢占：改投 queue + 移到队首
    assert.equal(a.delivery, 'queue');
    assert.equal(shell.itemsForSession('s1')[0], a);
    assert.equal(stopped, 1);
    // B 必须还在，且已降级为 queue（clearSteer 清不到它）
    assert.equal(b.delivery, 'queue');
    assert.deepEqual(shell.itemsForSession('s1').map((it) => it.text), ['A', 'B']);
    // 其它会话的 steer 不受抢占影响
    assert.equal(other.delivery, 'steer');
    assert.equal(shell.hasSteer('s1'), false);
    assert.equal(shell.hasSteer('s2'), true);
});

test('队列行抢占：停止收尾窗口不再重复停轮，等收尾冲刷', () => {
    let stopped = 0;
    const live = {sessionId: 's1', stopped: true, finished: false, roundId: 'r'};
    const shell = createAIMessageQueue({
        el: {},
        streams: new Map([['s1', live]]),
        compactOf: () => false,
        getStream: () => live,
        flash: () => {},
        stopGeneration: () => { stopped += 1; },
    });
    const a = shell.enqueueItem({sessionId: 's1', text: 'steer', delivery: 'steer'});
    shell.preemptQueuedItem(a);
    assert.equal(a.delivery, 'queue');
    assert.equal(shell.hasInterject('s1'), true);
    assert.equal(stopped, 0);
});

test('DOM 壳：steer 车道与手势 API 全部导出为函数', () => {
    const shell = createAIMessageQueue({el: {}});
    for (const api of ['preemptComposerMessage', 'preemptQueuedItem', 'interjectComposerMessage', 'enqueueComposerMessage',
        'hasSteer', 'drainSteer', 'restoreItems', 'setDelivery', 'reorderSession', 'fallbackSteerToQueue', 'clearSteer', 'snapshot']) {
        assert.equal(typeof shell[api], 'function', '缺少导出：' + api);
    }
});

test('formatSteerMessage：ZCode 文案合同（改文案要同步接线护栏）', () => {
    const text = formatSteerMessage('补充一句');
    assert.match(text, /while you were working/);
    assert.match(text, /mid-turn/);
    assert.match(text, /补充一句/);
    assert.equal(formatSteerMessage(null).includes('null'), false);
});

// ---------- 排队冲刷：所有会话同一条路径（docs/finished-plans/ai-queue-background-flush.md
// 方案 A 2026-11-19 → 方案 B 2026-11-27 统一） ----------

function shellCtx(over) {
    const calls = {start: [], flash: [], unread: [], submit: []};
    const ctx = {
        // el.queue 为空时 renderMessageQueue 直接 return，不需要真 DOM
        el: {input: {value: '', trim() { return String(this.value || '').trim(); }}},
        streams: new Map(),
        compactOf: () => false,
        currentSession: () => null,
        sessionById: (id) => (id === 's1' ? {id: 's1', title: '后台会话', messages: []} : null),
        startSessionTurn: async (session, text, opts) => {
            calls.start.push({sessionId: session.id, text, opts});
            return {ok: true};
        },
        setSessionUnread: (session, kind) => calls.unread.push([session.id, kind]),
        flash: (text, isError) => calls.flash.push([text, isError]),
        getAttachments: () => [],
        // 失败文案的来源（真实现是 panel 的 turnStartFailureText，queued 语境）。
        // 这里模拟它的契约：over_budget 必须带「留在队列」，其余带 reason。
        describeTurnFailure: (result, session) => {
            if (!result || result.ok) return '';
            if (result.reason === 'over_budget') return '上下文已超阈：消息已留在队列';
            return '「' + (session && session.title) + '」的排队消息未能发出（' + result.reason + '），已留在队列';
        },
        // 代发路径已删：留着桩，用来断言它**不再**被调用
        submitText: async (text) => {
            calls.submit.push(text);
            return true;
        },
    };
    return {ctx: {...ctx, ...(over || {})}, calls};
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return {promise, resolve, reject};
}

test('queuedAttachmentsPayload：图片 / 视频分组，引用块不进文本附件', () => {
    const payload = queuedAttachmentsPayload([
        {kind: 'image', data: 'x'},
        {kind: 'video', data: 'y'},
        {kind: 'file', label: 'a.js', content: 'x'},
        {kind: 'message_quote', source: 'q', text: 'y'},
        null,
    ]);
    assert.deepEqual(payload.images.map((a) => a.kind), ['image']);
    assert.deepEqual(payload.videos.map((a) => a.kind), ['video']);
    assert.deepEqual(payload.texts.map((a) => a.kind), ['file']);
    assert.deepEqual(queuedAttachmentsPayload(null), {images: [], videos: [], texts: []});
});

test('轮末冲刷走内核起轮，不碰输入区', async () => {
    const {ctx, calls} = shellCtx();
    const shell = createAIMessageQueue(ctx);
    shell.enqueueItem({
        sessionId: 's1',
        text: '排队的 2',
        attachments: [{kind: 'image', data: 'x'}, {kind: 'file', label: 'a.js', content: 'x'}],
    });
    await shell.flushMessageQueue('s1');
    assert.equal(calls.submit.length, 0, '不该灌输入区再代发');
    assert.equal(calls.start.length, 1, '要走 startSessionTurn 内核');
    assert.equal(calls.start[0].text, '排队的 2');
    assert.deepEqual(calls.start[0].opts.attachments.images.map((a) => a.kind), ['image']);
    assert.deepEqual(calls.start[0].opts.attachments.texts.map((a) => a.kind), ['file']);
    assert.equal(calls.start[0].opts.preserveScroll, true);
    assert.equal(calls.start[0].opts.truncateAt, null);
    assert.equal(shell.itemsForSession('s1').length, 0, '发出后队列清空');
});

test('起轮失败回插队首、打未读并提示，不丢消息', async () => {
    const {ctx, calls} = shellCtx({
        startSessionTurn: async () => ({ok: false, reason: 'over_budget', tokens: 9, windowSize: 8}),
    });
    const shell = createAIMessageQueue(ctx);
    shell.enqueueItem({sessionId: 's1', text: '排队 3'});
    await shell.flushMessageQueue('s1', {fromRetry: true});
    assert.equal(shell.itemsForSession('s1').length, 1, '失败不丢：回到该会话队首');
    assert.equal(shell.itemsForSession('s1')[0].text, '排队 3');
    assert.deepEqual(calls.unread, [['s1', 'done']]);
    assert.equal(calls.flash.length, 1);
    assert.equal(calls.flash[0][1], true, '失败提示要标红');
    assert.match(calls.flash[0][0], /上下文/);
});

test('并发 flush：同会话只取一个，重入直接返回', async () => {
    const pending = deferred();
    const {ctx, calls} = shellCtx({
        startSessionTurn: (session, text, opts) => {
            calls.start.push({sessionId: session.id, text, opts});
            return pending.promise;
        },
    });
    const shell = createAIMessageQueue(ctx);
    shell.enqueueItem({sessionId: 's1', text: 'first'});
    shell.enqueueItem({sessionId: 's1', text: 'second'});

    const first = shell.flushMessageQueue('s1');
    const reentrant = shell.flushMessageQueue('s1');
    await reentrant;
    assert.equal(calls.start.length, 1, '重入 flush 不取第二条');
    assert.equal(calls.start[0].text, 'first');
    assert.deepEqual(shell.itemsForSession('s1').map((it) => it.text), ['second']);

    pending.resolve({ok: true});
    await first;
    assert.equal(calls.start.length, 1);
    assert.deepEqual(shell.itemsForSession('s1').map((it) => it.text), ['second']);

    await shell.flushMessageQueue('s1');
    assert.equal(calls.start.length, 2, '锁释放后下一条可继续冲刷');
    assert.equal(calls.start[1].text, 'second');
    assert.equal(shell.itemsForSession('s1').length, 0);
});

test('并发 flush：首条失败回插仍按原顺序，且不会抢发第二条', async () => {
    const pending = deferred();
    const {ctx, calls} = shellCtx({
        startSessionTurn: (session, text, opts) => {
            calls.start.push({sessionId: session.id, text, opts});
            return pending.promise;
        },
    });
    const shell = createAIMessageQueue(ctx);
    shell.enqueueItem({sessionId: 's1', text: 'first'});
    shell.enqueueItem({sessionId: 's1', text: 'second'});

    const first = shell.flushMessageQueue('s1', {fromRetry: true});
    const reentrant = shell.flushMessageQueue('s1', {fromRetry: true});
    await reentrant;
    assert.deepEqual(calls.start.map((call) => call.text), ['first']);

    pending.resolve({ok: false, reason: 'lease_failed'});
    await first;
    assert.deepEqual(calls.start.map((call) => call.text), ['first'], '第二条不能在首条 in-flight 时发出');
    assert.deepEqual(shell.itemsForSession('s1').map((it) => it.text), ['first', 'second'],
        '失败项回到原队首先，后续项顺序不变');
});

test('忙（生成中）时不取项，消息留在队列', async () => {
    const live = {sessionId: 's1', stopped: false, finished: false, roundId: 'r'};
    const {ctx, calls} = shellCtx({streams: new Map([['s1', live]])});
    const shell = createAIMessageQueue(ctx);
    shell.enqueueItem({sessionId: 's1', text: '排队 4'});
    await shell.flushMessageQueue('s1');
    assert.equal(calls.start.length, 0);
    assert.equal(shell.itemsForSession('s1').length, 1);
});

test('当前会话：同样走内核起轮，不再经过输入区代发', async () => {
    // 方案 B：所有会话一条发送路径。代发（灌输入区 → submitText）已删，视图渲染由内核
    // 按 viewed 判定负责，队列侧不再写 UI。
    const current = {id: 's1', title: '当前会话', messages: []};
    const {ctx, calls} = shellCtx({currentSession: () => current, sessionById: () => current});
    const shell = createAIMessageQueue(ctx);
    shell.enqueueItem({sessionId: 's1', text: '排队 5'});
    await shell.flushMessageQueue('s1');
    assert.equal(calls.start.length, 1, '当前会话也要走内核');
    assert.equal(calls.start[0].text, '排队 5');
    assert.equal(calls.submit.length, 0, '不许再走输入区代发');
    assert.equal(shell.itemsForSession('s1').length, 0);
});

// ---------- plan 模式抢占（2026-11-22 实测：抢占消息停在排队框发不出去） ----------

const planSession = () => ({id: 's1', title: '计划会话', planMode: true, messages: [],
    activePlan: {status: 'pending', markdown: '# 计划', ts: 1}});
const planGuards = (dismissed) => ({
    planApprovalMessage: (s) => (s && s.activePlan && s.activePlan.status === 'pending' ? s.activePlan : null),
    planApprovalKey: (s, plan) => s.id + ':' + plan.ts,
    getDismissedPlanApproval: () => (typeof dismissed === 'function' ? dismissed() : dismissed),
    setDismissedPlanApproval: () => {},
    planAwaitingUserReply: () => true,
});

test('计划审批卡正显示时冲刷被拦：消息留队等计划处理', async () => {
    // 卡片占着输入区（与手动发送同一口径），静默拦下但不丢消息
    const current = planSession();
    const {ctx, calls} = shellCtx({currentSession: () => current, sessionById: () => current, ...planGuards('')});
    const shell = createAIMessageQueue(ctx);
    shell.enqueueItem({sessionId: 's1', text: '排队 6'});
    await shell.flushMessageQueue('s1');
    assert.equal(calls.start.length, 0, '审批卡正显示，不起轮');
    assert.equal(shell.itemsForSession('s1').length, 1);
});

test('计划卡收起（继续规划 / 抢占收起）后冲刷照常发送', async () => {
    // 收起后输入区已空闲、手动发送可行：队列冲刷同一口径放行（否则 pending 计划永远钉住队列）
    const current = planSession();
    const {ctx, calls} = shellCtx({currentSession: () => current, sessionById: () => current,
        ...planGuards('s1:1')});
    const shell = createAIMessageQueue(ctx);
    shell.enqueueItem({sessionId: 's1', text: '排队 7'});
    await shell.flushMessageQueue('s1');
    assert.equal(calls.start.length, 1);
    assert.equal(calls.start[0].text, '排队 7');
    assert.equal(shell.itemsForSession('s1').length, 0);
});

test('抢占：待批准的计划卡自动收起让路，空闲分支消息立即发出', () => {
    const current = planSession();
    const dismissed = [];
    const takeovers = [];
    const {ctx, calls} = shellCtx({
        currentSession: () => current,
        sessionById: () => current,
        ...planGuards(() => dismissed[dismissed.length - 1] || ''),
        setDismissedPlanApproval: (v) => dismissed.push(v),
        updateComposerTakeover: (force) => takeovers.push(force),
        captureComposerMessage: () => ({sessionId: 's1', text: '抢占', attachments: []}),
    });
    const shell = createAIMessageQueue(ctx);
    shell.preemptComposerMessage({});
    assert.deepEqual(dismissed, ['s1:1'], '抢占把待批准计划卡收起（只改显示，计划本体不动）');
    assert.deepEqual(takeovers, [true]);
    // streams 为空 → 空闲直冲刷分支：收起后守卫放行，takeQueuedItem 同步摘条
    assert.equal(shell.itemsForSession('s1').length, 0);
});

// ---------- 重启恢复（localStorage 轻量快照） ----------

test('persistSafeItem：剥离图片/视频附件（base64 不进存储），文本类保留，字段归一', () => {
    const safe = persistSafeItem({
        id: 'q_1', sessionId: 's1', text: 'hi',
        attachments: [
            {kind: 'image', data: 'AAAA', name: 'a.png'},
            {kind: 'video', data: 'BBBB', name: 'b.mp4'},
            {kind: 'text', name: 'note.md', content: '# hi'},
            null,
        ],
        delivery: 'steer', ts: 123, roundId: 'r9',
    });
    assert.deepEqual(safe.attachments, [{kind: 'text', name: 'note.md', content: '# hi'}]);
    assert.equal(safe.delivery, 'steer');
    assert.equal(safe.ts, 123);
    assert.equal(safe.roundId, 'r9');
    // 非法值归一：text 缺省空串、delivery 未知值回落 queue、ts 缺失归 0
    const blank = persistSafeItem({id: 'q_2', sessionId: 's1', text: null, delivery: 'x'});
    assert.equal(blank.text, '');
    assert.equal(blank.delivery, 'queue');
    assert.equal(blank.ts, 0);
    assert.deepEqual(blank.attachments, []);
});

test('restorableQueueItems：剔失效、按已有 id 去重、lookup 不过的不收', () => {
    const list = [
        {id: 'q_1', sessionId: 's1', text: 'a'},
        {id: 'q_2', sessionId: 'gone', text: 'b'},
        {id: 'q_3', sessionId: 's1', text: '   '},
        {id: 'q_4', sessionId: 's1', text: 'c'},
        null,
        {sessionId: 's1', text: '无 id'},
    ];
    const out = restorableQueueItems(list, new Set(['q_4']), (id) => (id === 's1' ? {id} : null));
    assert.deepEqual(out.map((it) => it.id), ['q_1'], 'q_2 会话失效 / q_3 空文本 / q_4 内存已有');
    // lookup 缺省（不传）时不做会话校验
    assert.deepEqual(restorableQueueItems([{id: 'q_9', sessionId: 'any', text: 'z'}], [], null).length, 1);
    // 非数组 / 空输入安全
    assert.deepEqual(restorableQueueItems(null, [], null), []);
});

test('restorableQueueItems：纯文本类附件可恢复，媒体附件仍按 persistSafeItem 规则剔除', () => {
    const attachmentOnly = {
        id: 'q_att', sessionId: 's1', text: '',
        attachments: [{kind: 'file', label: 'a.js', content: 'x'}],
    };
    const mediaOnly = {
        id: 'q_media', sessionId: 's1', text: '',
        attachments: [{kind: 'image', data: 'AAAA'}, {kind: 'video', data: 'BBBB'}],
    };
    const out = restorableQueueItems([attachmentOnly, mediaOnly], [], null);
    assert.deepEqual(out.map((it) => it.id), ['q_att'], '空正文 + 可恢复附件有效；纯媒体附件不可恢复');
    const safe = persistSafeItem(attachmentOnly);
    assert.deepEqual(safe.attachments, [{kind: 'file', label: 'a.js', content: 'x'}]);
    assert.deepEqual(persistSafeItem(mediaOnly).attachments, [], '媒体附件仍被剥离');
});

test('model.restore：原样收回快照条目（id 保留），坏条目过滤，不触发 onChange', () => {
    let fired = 0;
    const model = createQueueModel({onChange: () => { fired += 1; }});
    const ok = model.restore([
        {id: 'q_1', sessionId: 's1', text: 'a', delivery: 'queue', ts: 1, roundId: ''},
        {id: 'q_2', sessionId: 's1', text: 'b', ts: 2},
        {text: '无 id 不收'},
        null,
    ]);
    assert.equal(ok, true);
    assert.equal(fired, 0, '恢复的旧条目不该唤醒 wait_agent');
    assert.deepEqual(model.all().map((it) => it.id), ['q_1', 'q_2']);
    assert.equal(model.forSession('s1')[0].text, 'a');
    // 全是坏条目 / 非数组返回 false，队列不动
    assert.equal(model.restore([{text: 'x'}]), false);
    assert.equal(model.restore('bad'), false);
    assert.equal(model.all().length, 2);
});

test('model.restore：新快照按 seq 恢复，旧快照无 seq 保持原数组顺序', () => {
    const fresh = createQueueModel();
    fresh.restore([
        {id: 'q_2', sessionId: 's1', text: 'second', ts: 1, seq: 2},
        {id: 'q_1', sessionId: 's1', text: 'first', ts: 2, seq: 1},
    ]);
    assert.deepEqual(fresh.forSession('s1').map((it) => it.text), ['first', 'second']);

    const legacy = createQueueModel();
    legacy.restore([
        {id: 'old_2', sessionId: 's1', text: 'legacy-second', ts: 2},
        {id: 'old_1', sessionId: 's1', text: 'legacy-first', ts: 1},
    ]);
    assert.deepEqual(legacy.forSession('s1').map((it) => it.text), ['legacy-second', 'legacy-first'],
        '旧快照没有 seq 时沿用原数组顺序，不按 ts 重排');
});

test('model.restore：seq 基线续接，重启后新 steer 回滚不能插到旧消息之前', () => {
    const model = createQueueModel();
    model.restore([{id: 'old', sessionId: 's1', text: 'old', ts: 1, seq: 100, delivery: 'queue'}]);
    const steer = model.enqueue({sessionId: 's1', text: 'new-steer', delivery: 'steer'});
    model.drainSteer('s1');
    model.restoreItems([steer]);
    assert.deepEqual(model.forSession('s1').map((item) => item.id), ['old', steer.id]);
});


// ---- 方案 B：冲刷不再经过输入区（2026-11-27）----
// 代发路径会把消息瞬态回填进输入区、起轮成功后再清掉；`await` 窗口里用户切走会话，
// 那段文字就留在**别的会话**的输入框里——「冲刷入口 + 失败收尾都要 dropComposerDraft」
// 这套补偿正是为它存在。统一走内核后，队列侧对输入区**零读写**、草稿无需作废。
function makeDispatchShell({turnResult}) {
    const session = {id: 's1', title: 'A', messages: []};
    // value 写成 getter/setter 计数：旧代发路径会写一次「消息文本」，新路径一次都不该写
    let valueWrites = 0;
    const inputEl = {
        get value() { return ''; },
        set value(_v) { valueWrites += 1; },
    };
    const calls = {start: [], submit: [], drops: 0};
    const q = createAIMessageQueue({
        el: {input: inputEl, queue: null},
        streams: new Map(),
        compactOf: () => null,
        currentSession: () => session,
        syncStreamView: () => null,
        currentQueueItems: () => [],
        sessionById: (id) => (id === 's1' ? session : null),
        flash: () => {},
        describeTurnFailure: () => '起轮失败：消息已留在队列',
        startSessionTurn: async (s, text, opts) => {
            calls.start.push({text, opts});
            return turnResult;
        },
        submitText: async (text) => {
            calls.submit.push(text);
            return true;
        },
        getAttachments: () => [],
        dropComposerDraft: () => { calls.drops += 1; },
    });
    return {q, session, calls, valueWrites: () => valueWrites};
}

test('冲刷不读不写输入区：成功路径不调 submitText、不作废草稿', async () => {
    const {q, calls, valueWrites} = makeDispatchShell({turnResult: {ok: true}});
    q.enqueueItem({sessionId: 's1', text: '排队的话', attachments: []});
    await q.flushMessageQueue('s1');
    assert.equal(calls.start.length, 1, '走内核起轮');
    assert.equal(calls.submit.length, 0, '不再代发');
    assert.equal(valueWrites(), 0, '输入区零写入（旧代发会先把文本灌进去）');
    assert.equal(calls.drops, 0, '没有瞬态回填，就不需要作废草稿');
    assert.equal(q.itemsForSession('s1').length, 0, '消息已发出，队列清空');
});

test('冲刷失败：回插队列、提示一次，输入区仍零写入', async () => {
    const {q, calls, valueWrites} = makeDispatchShell({turnResult: {ok: false, reason: 'lease_failed'}});
    q.enqueueItem({sessionId: 's1', text: '排队的话', attachments: []});
    await q.flushMessageQueue('s1', {fromRetry: true});
    assert.equal(q.itemsForSession('s1').length, 1, '失败消息回到队列不丢');
    assert.equal(valueWrites(), 0, '失败也不许碰输入区');
    assert.equal(calls.drops, 0, '不需要草稿补偿');
});
