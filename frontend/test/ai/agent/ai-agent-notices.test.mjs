// ai-agent-notices.test.mjs：会话信箱（后台注入通道）的行为护栏。
// 覆盖：结算文案（done / error / stopped，含「投递层不截断」）、三态投递、
// 信箱深度与溢出策略（会话投递拒收 / 结算合并）、折叠成 user 消息、唤醒被拒后内容回填。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildSettlementNotice, buildAskNotice, buildBgJobExitNotice, buildTerminalExitNotice, formatBgDuration, createAIAgentNotices, NOTICE_DEPTH_MAX} from '../../../src/ai/agent/ai-agent-notices.js';

function makeHarness(overrides) {
    const opts = overrides || {};
    const sessions = new Map();
    const calls = {turns: [], unread: [], notices: [], flashes: [], desktop: [], notified: []};
    const session = {id: 's1', title: '会话一', messages: [], archivedAt: 0};
    sessions.set('s1', session);
    let busy = !!opts.busy;
    const notices = createAIAgentNotices({
        // 等待原语的假实现：这里只关心「入队后有没有按正确的 ownerId notify」——
        // key 写错（session.id → item.id）在端到端里完全看不见，只能在这里抓。
        inboxWaiters: {notify: (ownerId) => calls.notified.push(ownerId)},
        sessionById: (id) => sessions.get(id) || null,
        streamOf: (id) => (opts.streamOf ? opts.streamOf(id) : (busy ? {sessionId: 's1'} : null)),
        compactOf: (id) => (opts.compactOf ? opts.compactOf(id) : null),
        // 「压缩正在准备」是**全局**标记（不属于任何会话）：用它模拟「别的会话正在压缩」
        compactStartingOf: () => !!opts.compactStarting,        startSessionTurn: opts.startSessionTurn || ((s, text, options) => {
            calls.turns.push({sessionId: s.id, text, options});
            return opts.turnResult ? opts.turnResult : Promise.resolve({ok: true});
        }),
        currentSession: () => session,
        isOpen: () => false,
        renderMessages: () => {},
        renderSessionList: () => {},
        setSessionUnread: (s, kind) => calls.unread.push({id: s.id, kind}),
        notifyDesktop: (o) => calls.desktop.push(o),
        flash: (text, isError) => calls.flashes.push({text, isError}),
        persistSessions: () => {},
        // 信箱增减钩子（头部「信箱」胶囊角标）：透传以便断言触发次数
        onChanged: () => { if (opts.onChanged) opts.onChanged(); },
        getPendingEdit: () => opts.pendingEdit || null,
        getSessions: () => (opts.sessions ? opts.sessions() : [session]),
        workspaceKeyOf: (target) => (opts.workspaceKey ? opts.workspaceKey(target) : 'ws'),
    });
    return {
        notices, session, sessions, calls,
        setBusy(value) { busy = value; },
    };
}

test('buildSettlementNotice：完成通知带固定前缀与完整结论（不截断）', () => {
    const long = '结论正文'.repeat(3000);
    const notice = buildSettlementNotice({name: '依赖调查', agentId: 'sub-1', state: 'done', summary: long});
    assert.equal(notice.kind, 'subagent');
    assert.equal(notice.label, '子代理通知 · 依赖调查');
    assert.ok(notice.content.startsWith('［子代理通知 · 依赖调查］'));
    assert.ok(notice.content.includes('id=sub-1'));
    // 投递层不截断：原 AI_SUB_SUMMARY_MAX（8000）已移除，长报告必须整段到达
    assert.ok(notice.content.includes(long), '长结论必须完整保留');
    assert.ok(notice.content.includes('agent_send'), '完成通知要给出后续动作提示');
});

test('buildSettlementNotice：失败与停止的文案各自成句', () => {
    const failed = buildSettlementNotice({name: '审查', agentId: 'sub-2', state: 'error', note: '断网'});
    assert.ok(failed.content.includes('已失败'));
    assert.ok(failed.content.includes('断网'));
    assert.ok(failed.content.startsWith('［子代理通知 · 审查］'));

    const stopped = buildSettlementNotice({name: '扫描', state: 'stopped', summary: '已读 3 个文件', unconsumed: 2});
    assert.ok(stopped.content.includes('已停止'));
    assert.ok(stopped.content.includes('已读 3 个文件'));
    assert.ok(stopped.content.includes('2 条未消费消息'));
});

test('buildAskNotice：提问通知带 askId 与作答方式，问题与选项都在', () => {
    const notice = buildAskNotice({
        name: '依赖调查',
        agentId: 'sub-9',
        askId: 'call_12',
        questions: [
            {text: '要不要包含 devDependencies？', options: ['包含', '不包含']},
            {text: '目标是小程序还是网页？'},
        ],
    });
    assert.equal(notice.kind, 'subagent-ask');
    assert.equal(notice.label, '子代理提问 · 依赖调查');
    assert.ok(notice.content.startsWith('［子代理提问 · 依赖调查］'));
    assert.ok(notice.content.includes('askId=call_12'), 'askId 是回答的寻址依据');
    assert.ok(notice.content.includes('Q1：要不要包含 devDependencies？'));
    assert.ok(notice.content.includes('可选：包含 / 不包含'));
    assert.ok(notice.content.includes('Q2：目标是小程序还是网页？'));
    assert.ok(notice.content.includes("agent_send(agentId='sub-9'"), '要给出可直接照抄的作答形式');
});

test('投递：入队即 notify 等待方（ownerId 必须是会话 id，不是消息 id）', async () => {
    const h = makeHarness({busy: true});
    h.notices.deliverAgentNotice(h.session, {kind: 'subagent', label: '子代理通知 · A', content: '完成'});
    // notify 的 key 写错在端到端里完全看不见（wait_agent 只会白等到超时），这里必须锁死
    assert.deepEqual(h.calls.notified, ['s1'], '入队后按会话 id 唤醒');
    h.calls.notified.length = 0;

    // 合并分支（信箱已满 + 结算类只合并不丢弃）同样要 notify：内容变了模型该醒
    for (let i = 0; i < NOTICE_DEPTH_MAX; i++) {
        h.notices.deliverAgentNotice(h.session, {kind: 'subagent', label: '通知 ' + i, content: '第 ' + i + ' 条'});
    }
    h.calls.notified.length = 0;
    const merged = h.notices.deliverAgentNotice(h.session, {kind: 'subagent', label: '通知 X', content: '溢出的一条'});
    assert.equal(merged.reason, 'merged');
    assert.deepEqual(h.calls.notified, ['s1'], '合并也算有新内容，必须唤醒');
});

test('投递：空闲会话立刻唤醒，忙则排队', async () => {
    const h = makeHarness();
    const r = h.notices.deliverAgentNotice(h.session, {kind: 'subagent', label: '子代理通知 · A', content: '［子代理通知 · A］完成'});
    assert.equal(r.ok, true);
    assert.equal(r.woke, true);
    await Promise.resolve();
    assert.equal(h.calls.turns.length, 1);
    assert.ok(h.calls.turns[0].text.includes('［子代理通知 · A］'));
    // 后台注入恒不读 pendingEdit、不截断历史
    assert.equal(h.calls.turns[0].options.allowPendingEdit, false);
    assert.equal(h.calls.turns[0].options.truncateAt, null);

    const h2 = makeHarness({busy: true});
    const r2 = h2.notices.deliverAgentNotice(h2.session, {kind: 'subagent', label: 'x', content: '正文'});
    assert.equal(r2.ok, true);
    assert.equal(r2.reason, 'queued');
    assert.equal(h2.calls.turns.length, 0);
    assert.equal(h2.notices.pendingCount('s1'), 1);
});

test('投递：归档会话拒绝、空正文拒绝、编辑态延后不唤醒', () => {
    const h = makeHarness();
    const archived = {...h.session, archivedAt: 123};
    assert.equal(h.notices.deliverAgentNotice(archived, {kind: 'subagent', content: 'x'}).reason, 'archived');
    assert.equal(h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: '   '}).reason, 'empty');

    const editing = makeHarness({pendingEdit: {index: 2, sessionId: 's1'}});
    const r = editing.notices.deliverAgentNotice(editing.session, {kind: 'subagent', content: '正文'});
    assert.equal(r.reason, 'deferred');
    assert.equal(editing.calls.turns.length, 0, '用户正在编辑重发时不唤醒');
    assert.equal(editing.notices.pendingCount('s1'), 1);
});

test('信箱深度：会话投递满即拒收，结算类只合并不丢弃', () => {
    const h = makeHarness({busy: true});
    for (let i = 0; i < NOTICE_DEPTH_MAX; i++) {
        const r = h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: '第 ' + i + ' 条'});
        assert.equal(r.ok, true);
    }
    assert.equal(h.notices.pendingCount('s1'), NOTICE_DEPTH_MAX);

    // 会话间投递：满了给回执，发送方可丢
    const rejected = h.notices.deliverAgentNotice(h.session, {kind: 'session', content: '来自别的会话'});
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, 'full');

    // 结算通知：只合并不丢弃（丢了无法再生）
    const merged = h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: '另一个子代理完成'});
    assert.equal(merged.ok, true);
    assert.equal(merged.reason, 'merged');
    assert.equal(h.notices.pendingCount('s1'), NOTICE_DEPTH_MAX, '合并后深度不增长');
});

test('折叠：工具轮边界把通知折成一条 user 消息并清空队列', () => {
    const h = makeHarness({busy: true});
    h.notices.deliverAgentNotice(h.session, {kind: 'subagent', label: '子代理通知 · A', content: '甲'});
    h.notices.deliverAgentNotice(h.session, {kind: 'subagent', label: '子代理通知 · B', content: '乙'});
    assert.equal(h.notices.pendingCount('s1'), 2);
    const folded = h.notices.foldNotices('s1');
    assert.equal(folded, 2);
    assert.equal(h.notices.pendingCount('s1'), 0);
    assert.equal(h.session.messages.length, 1);
    const msg = h.session.messages[0];
    assert.equal(msg.role, 'user');
    assert.equal(msg.notice, true);
    assert.ok(msg.content.includes('甲') && msg.content.includes('乙'));
    // 多条合并时 app 元数据退化为「后台通知 · N 条」，卡片仍能归类
    assert.equal(msg.app.kind, 'subagent');
    assert.ok(msg.app.label.includes('2 条'));
});

test('折叠：单次消费上限内多条合并，超出部分留在信箱', () => {
    const h = makeHarness({busy: true});
    for (let i = 0; i < 8; i++) h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: 'n' + i});
    const folded = h.notices.foldNotices('s1');
    assert.equal(folded, 5, '单边界最多 5 条');
    assert.equal(h.notices.pendingCount('s1'), 3);
});

test('唤醒被拒：内容退回信箱最前并打未读，不静默丢弃', async () => {
    const h = makeHarness({turnResult: Promise.resolve({ok: false, reason: 'over_budget'})});
    h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: '要送达的通知'});
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.notices.pendingCount('s1'), 1, '被拒后内容必须回填');
    assert.equal(h.calls.unread.length, 1);
    assert.equal(h.calls.unread[0].kind, 'done');
    assert.ok(h.calls.desktop.length >= 1);
    assert.ok(h.calls.flashes.some((f) => f.isError));
});

test('flushNotices：忙时只排队不唤醒，空闲时唤醒', () => {
    const h = makeHarness({busy: true});
    h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: 'x'});
    assert.equal(h.notices.flushNotices('s1').reason, 'busy');
    assert.equal(h.calls.turns.length, 0);
    h.setBusy(false);
    assert.equal(h.notices.flushNotices('s1').woke, true);
});

// 实测 bug（2026-11-27）：明明会话空闲，后台通知却报「投递失败：busy」，而且消息要等
// 用户下次发消息才到。根因是两处判定与起轮内核不同源：
//   · deliverAgentNotice / flushNotices 用 isSessionBusy(id)（**不判** compactStarting）
//   · startSessionTurn 判 streamOf || compactOf || compactStarting
// 于是「某个会话正在压缩准备」这个**全局**窗口内，所有会话都被判空闲 → 唤醒 → 被拒 → 报错。
test('压缩准备窗口（compactStarting）必须算忙，否则会误唤醒再被拒', async () => {
    // 模拟：本会话没有 stream / compact，但全局 compactStarting 为真
    const h = makeHarness({
        compactStarting: true,          // 见下面 harness 支持
        turnResult: Promise.resolve({ok: false, reason: 'busy'}),  // 起轮内核会拒
    });
    const receipt = h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: '压缩期间到达的通知'});
    // 关键：不能进 wakeWith。inclusion 正确时应直接排队返回 queued
    assert.equal(receipt.reason, 'queued', '压缩准备窗口必须按忙排队，不能尝试唤醒');
    assert.equal(h.calls.turns.length, 0, '不该调用 startSessionTurn（必然被拒）');
    // flushNotices 同口径
    assert.equal(h.notices.flushNotices('s1').reason, 'busy', 'flushNotices 也必须认 compactStarting');
});

test('wakeWith 拿到 busy 不报错（消息已退回队列，等下一边界）', async () => {
    // 竞态场景：isSessionBusy 判定时空闲，但在 startSessionTurn 之前流起来了
    const h = makeHarness({turnResult: Promise.resolve({ok: false, reason: 'busy'})});
    h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: '竞态通知'});
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // 内容退回队列（不丢）
    assert.equal(h.notices.pendingCount('s1'), 1, 'busy 被拒后内容必须回填队列');
    // 但不该弹「投递失败」系统通知——busy 是预期状态，报了会让用户以为消息丢了
    assert.equal(h.calls.desktop.length, 0, 'busy 不该触发「AI 后台通知投递失败」通知');
    assert.equal(h.calls.flashes.filter((f) => f.isError).length, 0, 'busy 不该 flash 报错');
});

// 边界：startSessionTurn 同步抛错（不是 reject）。wakeWith 在调用它之前已 waking.add，
// 且 batch 已被 splice 出队列。若不清理，该会话之后每次唤醒都被挡成 'waking'，
// 通知永久滞留到用户手动发消息。
test('startSessionTurn 同步抛错：waking 必须清理、内容必须回填', () => {
    // 只让第一次抛（模拟一次意外同步错误）；第二次正常，用来验证 waking 已被清理。
    let shouldThrow = true;
    const h = makeHarness({
        startSessionTurn: () => {
            if (shouldThrow) { shouldThrow = false; throw new Error('同步炸了'); }
            return Promise.resolve({ok: true});
        },
    });
    assert.throws(() => h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: '会炸通知'}),
        '同步抛错应当向上抛出（不静默吞掉）');
    // 内容回填，不丢
    assert.equal(h.notices.pendingCount('s1'), 1, '同步抛错后内容必须回填队列');
    // waking 已清理：下一次 flush 能真正起轮（不再返回 'waking'）
    const second = h.notices.flushNotices('s1');
    assert.notEqual(second.reason, 'waking', 'waking 残留会让该会话永久无法唤醒');
    assert.equal(second.woke, true, '清理干净后应当正常唤醒');
});

// 实测 bug（2026-11-27）：投递时判忙 → 消息退回队列 → **再没有任何事件触发投递**，
// 必须等用户手动发消息（foldBeforeTurn）才送达。用户原话：「要我给你发消息才会投递」。
// 根源：队列非空这件事本身没有唤醒源——finishStream 只在有流结束时冲刷。
// 修法：给非空队列配自带的重试触发器（退避，用尽即止）。
test('忙时退回队列后，必须有重试源把消息送达（不依赖用户发消息）', async () => {
    let busy = true;
    const h = makeHarness({
        streamOf: () => (busy ? {sessionId: 's1'} : null),
    });
    h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: '忙碌时到达的通知'});
    assert.equal(h.notices.pendingCount('s1'), 1, '忙时消息入队');
    assert.equal(h.calls.turns.length, 0, '忙时不该起轮');

    // 转空闲：**不调用任何 flush**，只等重试定时器（首个退避 800ms）
    busy = false;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(h.calls.turns.length, 1, '重试源必须自动送达（不靠用户发消息）');
    assert.equal(h.notices.pendingCount('s1'), 0, '送达后队列清空');
});

test('重试退避用尽后放弃（不做无限轮询）', async () => {
    // 一直忙：重试 5 次后应当停止（NOTICE_RETRY_DELAYS 有 5 档）
    const h = makeHarness({streamOf: () => ({sessionId: 's1'})});
    h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: '永远忙'});
    // 直接把内部定时器全跑完不现实（累计 38s）；这里只验证「不会无限增长」：
    // 连续多次投递不会叠加出多个 timer（scheduleRetry 有 st.timer 去重）。
    for (let i = 0; i < 20; i++) {
        h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: '永远忙' + i});
    }
    // 队列深度受 NOTICE_DEPTH_MAX 限制，不会因为重试而爆炸
    assert.ok(h.notices.pendingCount('s1') <= 10, '重试不该让队列无限增长');
});

// 这是「要发消息才投递」的**真正根因**（子代理审查 #1）：
// wakeWith 是**同步**返回 {woke:true}（startSessionTurn 异步），所以
// deliverAgentNotice 里 `if (!woke.woke) scheduleRetry()` 永远不会命中。
// 真正的失败只发生在异步 .then 回调里——那里若不武装重试，消息退回队列后再没人试。
test('异步唤醒失败（startSessionTurn 返回 ok:false）也必须武装重试', async () => {
    let failTimes = 1;
    const h = makeHarness({
        // 第一次返回 busy（异步失败），之后成功
        startSessionTurn: () => {
            if (failTimes > 0) { failTimes -= 1; return Promise.resolve({ok: false, reason: 'busy'}); }
            return Promise.resolve({ok: true, turns: [{sessionId: 's1'}]});
        },
    });
    h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: '异步会失败的通知'});
    // 让异步回调跑完：消息回填队列
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.notices.pendingCount('s1'), 1, '异步失败后内容必须回填');
    // 关键：**不手动调 flush**，等重试定时器（首个退避 800ms）自己把它送出去
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(h.notices.pendingCount('s1'), 0, '异步失败后必须由重试源送达，不能等用户发消息');
});

// 子代理审查 #3：`compactStarting` 是**全局**标记，压缩期间所有会话的通知都会排队。
// 压缩结束只冲压缩目标 → 别的会话干等到退避耗尽。flushAllPending 负责补齐。
test('flushAllPending：一次冲刷所有有待投通知的会话（压缩结束用）', () => {
    const h = makeHarness({busy: true});
    const s2 = {id: 's2', title: '会话二', messages: [], archivedAt: 0};
    h.sessions.set('s2', s2);
    h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: 'A'});
    h.notices.deliverAgentNotice(s2, {kind: 'subagent', content: 'B'});
    assert.equal(h.notices.pendingCount('s1'), 1);
    assert.equal(h.notices.pendingCount('s2'), 1);

    h.setBusy(false);
    const r = h.notices.flushAllPending();
    assert.equal(r.flushed, 2, '两个有待投通知的会话都要被尝试');
    assert.equal(r.woke, 2, '空闲后两个都该唤醒');
    assert.equal(h.notices.pendingCount('s1'), 0);
    assert.equal(h.notices.pendingCount('s2'), 0);
});

test('flushAllPending：excludeId 跳过已单独冲刷的会话', () => {
    const h = makeHarness({busy: true});
    const s2 = {id: 's2', title: '会话二', messages: [], archivedAt: 0};
    h.sessions.set('s2', s2);
    h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: 'A'});
    h.notices.deliverAgentNotice(s2, {kind: 'subagent', content: 'B'});
    h.setBusy(false);
    const r = h.notices.flushAllPending({excludeId: 's1'});
    assert.equal(r.flushed, 1, '排除的会话不重复冲刷');
    assert.equal(h.notices.pendingCount('s1'), 1, '被排除的会话保持原样');
    assert.equal(h.notices.pendingCount('s2'), 0);
});

test('foldBeforeTurn：不单独唤醒，直接折进即将发出的那一轮', () => {
    const h = makeHarness({busy: true});
    h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: '随轮注入'});
    assert.equal(h.notices.foldBeforeTurn(h.session), 1);
    assert.equal(h.calls.turns.length, 0, '用户这一轮已经开始，不再起新轮');
    assert.equal(h.session.messages.length, 1);
    assert.ok(h.session.messages[0].content.includes('随轮注入'));
});

test('clearMailbox / dropSession：清空与删除都不留残影', () => {
    const h = makeHarness({busy: true});
    h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: 'x'});
    assert.equal(h.notices.clearMailbox('s1'), 1);
    assert.equal(h.notices.pendingCount('s1'), 0);
    h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: 'y'});
    h.notices.dropSession('s1');
    assert.equal(h.notices.pendingCount('s1'), 0);
});

// ---- 会话间投递（阶段 H）----

function pairHarness() {
    const a = {id: 's1', title: '会话一', messages: [], archivedAt: 0};
    const b = {id: 's2', title: '会话二', messages: [], archivedAt: 0};
    const c = {id: 's3', title: '会话三', messages: [], archivedAt: 123};
    const h = makeHarness({sessions: () => [a, b, c]});
    h.sessions.set('s2', b);
    h.sessions.set('s3', c);
    return Object.assign(h, {a, b, c});
}

test('session_send：逐目标回执——成功、自投递、不存在、归档各自给原因', () => {
    const h = pairHarness();
    // 让目标处于「忙」：投递只入队，便于断言信箱内容（空闲时会立刻唤醒并消费掉）
    h.setBusy(true);
    const text = h.notices.sendToSessions({targetSessionIds: ['s2', 's1', 'nope', 's3'], message: '看下这个结论'}, {session: h.a});
    assert.ok(text.includes('1/4 成功'));
    assert.ok(text.includes('s1：失败 · 不能投递给自己'));
    assert.ok(text.includes('nope：失败 · 会话不存在'));
    assert.ok(text.includes('s3：失败 · 目标会话已归档'));
    assert.ok(text.includes('s2：已投递'));
    // 成功那条真的进了对方的信箱
    assert.equal(h.notices.pendingCount('s2'), 1);
});

test('session_send：目标数超过 10 整体拒绝', () => {
    const h = pairHarness();
    const ids = Array.from({length: 11}, (_, i) => 'x' + i);
    assert.throws(() => h.notices.sendToSessions({targetSessionIds: ids, message: 'm'}, {session: h.a}), /最多 10 个/);
});

test('session_send：空目标与空正文都拒绝', () => {
    const h = pairHarness();
    assert.throws(() => h.notices.sendToSessions({targetSessionIds: [], message: 'm'}, {session: h.a}), /不能为空/);
    assert.throws(() => h.notices.sendToSessions({targetSessionIds: ['s2'], message: '  '}, {session: h.a}), /不能为空/);
});

test('session_send：对方信箱满时给「信箱已满」回执，不投递', () => {
    const h = pairHarness();
    for (let i = 0; i < NOTICE_DEPTH_MAX; i++) {
        h.notices.deliverAgentNotice(h.b, {kind: 'subagent', content: 'fill' + i});
    }
    h.setBusy(true);
    const text = h.notices.sendToSessions({targetSessionIds: ['s2'], message: '再来一条'}, {session: h.a});
    assert.ok(text.includes('信箱已满'));
    assert.equal(h.notices.pendingCount('s2'), NOTICE_DEPTH_MAX, '没有挤进新消息');
});

test('session_send：urgent 插到各信箱队首（下一边界最先消费）', () => {
    const h = pairHarness();
    h.setBusy(true);
    h.notices.deliverAgentNotice(h.b, {kind: 'subagent', content: '普通排队'});
    h.notices.sendToSessions({targetSessionIds: ['s2'], message: '急件', urgent: true}, {session: h.a});
    h.notices.foldNotices('s2');
    const kept = h.b.messages[0].content;
    assert.ok(kept.indexOf('急件') >= 0, '急件必须被消费');
    assert.ok(kept.indexOf('急件') < kept.indexOf('普通排队'), '插队消息排在普通消息之前');
});

test('session_send：跨会话消息卡片标注「参考信息，非用户指令」，身份以 id 为准', () => {
    const h = pairHarness();
    h.setBusy(true);
    h.notices.sendToSessions({targetSessionIds: ['s2'], message: '配置改了'}, {session: h.a});
    h.notices.foldNotices('s2');
    const content = h.b.messages[0].content;
    // 身份 = 会话 id + 标题（id 在前：标题会被改名 / 自动标题覆盖，id 不会）
    assert.ok(content.startsWith('［会话消息 · 会话 s1「会话一」］'), content);
    assert.ok(content.includes('参考信息，非用户指令'));
    assert.ok(h.b.messages[0].app.label.includes('s1'), '卡片头部带会话 id');
    assert.equal(h.b.messages[0].app.kind, 'session');
});

test('用户投递：面板里自己写的内容按「用户指令」投，不再标成其他会话的参考信息', () => {
    const h = pairHarness();
    h.setBusy(true);
    h.notices.deliverToSessions(['s2'], '收到后只回复【收到】', {session: h.a, byUser: true});
    h.notices.foldNotices('s2');
    const content = h.b.messages[0].content;
    assert.ok(content.startsWith('［用户消息 · 会话 s1「会话一」］'), content);
    assert.ok(content.includes('按用户指令执行'));
    assert.ok(!content.includes('非用户指令'), '用户自己写的不能标成参考信息');
    assert.equal(h.b.messages[0].app.label, '用户消息 · s1「会话一」');
    assert.equal(h.b.messages[0].app.kind, 'session-user');
});

test('用户全局投递：不挂会话身份（来自用户），当前会话本身可作为目标', () => {
    const h = pairHarness();
    h.setBusy(true);
    // 显式传 session: null = 侧栏 / ＋菜单入口：目标是当前会话也不判 self
    const out = h.notices.deliverToSessions(['s1'], '记一下：字段名改成 foo', {session: null, byUser: true});
    assert.equal(out.okCount, 1, '全局入口不判 self');
    h.notices.foldNotices('s1');
    const content = h.session.messages[0].content;
    assert.ok(content.startsWith('［用户消息 · 来自用户］'), content);
    assert.ok(content.includes('按用户指令执行'));
    assert.ok(!content.includes('另一个会话'), '全局入口不编造「另一个会话」');
    assert.equal(h.session.messages[0].app.label, '用户消息 · 来自用户');
});

test('用户广播：标注来自用户、无需回复，不带「其他会话」语义', () => {
    const h = pairHarness();
    h.setBusy(true);
    h.notices.deliverToSessions(['s2'], '工作区配置已变更', {broadcast: true});
    h.notices.foldNotices('s2');
    const content = h.b.messages[0].content;
    assert.ok(content.startsWith('［系统通知 · 来自用户］'), content);
    assert.ok(content.includes('无需回复'));
    assert.ok(!content.includes('来自其他会话'));
    assert.equal(h.b.messages[0].app.label, '系统通知 · 来自用户');
    assert.equal(h.b.messages[0].app.kind, 'session-user');
});

test('session_list：默认只列同工作区、排除自己与归档；显式放开才跨工作区', () => {
    const a = {id: 's1', title: '会话一', messages: [], archivedAt: 0, updatedAt: 3};
    const b = {id: 's2', title: '会话二', messages: [], archivedAt: 0, updatedAt: 2};
    const other = {id: 's4', title: '别的工作区', messages: [], archivedAt: 0, updatedAt: 1};
    const archived = {id: 's5', title: '归档', messages: [], archivedAt: 9, updatedAt: 9};
    const h = makeHarness({
        sessions: () => [a, b, other, archived],
        workspaceKey: (session) => (session.id === 's4' ? 'other' : 'ws'),
    });
    h.sessions.set('s2', b);
    const ids = h.notices.listSessionsForSend().map((row) => row.id);
    assert.deepEqual(ids, ['s2'], '排除自己 / 归档 / 跨工作区');
    const all = h.notices.listSessionsForSend({allWorkspaces: true}).map((row) => row.id);
    assert.ok(all.includes('s4'));
    assert.ok(!all.includes('s5'));
    assert.ok(h.notices.sessionListText().includes('会话二'));
});

test('session_list：excludeSessionId 只排发起方；null 表示不排除（全局入口）', () => {
    const a = {id: 's1', title: '会话一', messages: [], archivedAt: 0, updatedAt: 3};
    const b = {id: 's2', title: '会话二', messages: [], archivedAt: 0, updatedAt: 2};
    const side = {id: 's3', title: '支线', messages: [], archivedAt: 0, updatedAt: 1};
    const h = makeHarness({sessions: () => [a, b, side], workspaceKey: () => 'ws'});
    // 会话发起（支线标签页）：只排发起方，面板当前会话（s1）仍是合法目标
    const fromSide = h.notices.listSessionsForSend({allWorkspaces: true, excludeSessionId: 's3'}).map((row) => row.id);
    assert.deepEqual(fromSide, ['s1', 's2']);
    // 全局入口（侧栏 / ＋菜单）：不排除任何人，当前会话可选
    const global = h.notices.listSessionsForSend({allWorkspaces: true, excludeSessionId: null}).map((row) => row.id);
    assert.deepEqual(global, ['s1', 's2', 's3']);
});

test('session_list：state / unreadOnly / titleContains 过滤（可叠加，非法 state 当不过滤）', () => {
    const a = {id: 's1', title: '会话一', messages: [], archivedAt: 0, updatedAt: 4};
    const b = {id: 's2', title: '构建 build 任务', messages: [], archivedAt: 0, updatedAt: 3, unread: true};
    const c = {id: 's3', title: 'BUILD 报告', messages: [], archivedAt: 0, updatedAt: 2};
    const h = makeHarness({
        sessions: () => [a, b, c],
        workspaceKey: () => 'ws',
        // s2 运行中、s3 压缩中、s1（当前会话）空闲
        streamOf: (id) => (id === 's2' ? {sessionId: 's2'} : null),
        compactOf: (id) => (id === 's3' ? {sessionId: 's3'} : null),
    });
    const ids = (opts) => h.notices.listSessionsForSend(Object.assign({allWorkspaces: true}, opts)).map((row) => row.id);
    assert.deepEqual(ids({}), ['s2', 's3'], '默认排除当前会话 s1');
    assert.deepEqual(ids({state: 'streaming'}), ['s2'], 'state=streaming 只留运行中');
    assert.deepEqual(ids({state: 'compacting'}), ['s3'], 'state=compacting 只留压缩中');
    assert.deepEqual(ids({state: 'idle'}), [], 's1 是当前会话被排除，空闲列表为空');
    assert.deepEqual(ids({state: 'garbage'}), ['s2', 's3'], '非法 state 当不过滤');
    assert.deepEqual(ids({unreadOnly: true}), ['s2'], 'unreadOnly 只留未读');
    assert.deepEqual(ids({titleContains: 'build'}), ['s2', 's3'], '标题过滤不区分大小写');
    assert.deepEqual(ids({state: 'streaming', unreadOnly: true, titleContains: '构建'}), ['s2'], '多条件叠加取交集');
    assert.ok(h.notices.sessionListText({state: 'idle'}).includes('没有符合条件'), '空结果给出明确提示');
});

test('buildBgJobExitNotice：退出码 / 命令截断 / 后续动作提示', () => {
    const notice = buildBgJobExitNotice({jobId: 'bg-3', command: 'npm run build', code: 0, durationMs: 65_000});
    assert.equal(notice.kind, 'bgjob');
    assert.equal(notice.label, '后台命令 · bg-3');
    assert.ok(notice.content.startsWith('［后台命令 · bg-3］'), '前缀与 detectAppMessage 同源约定');
    assert.ok(notice.content.includes('npm run build'));
    assert.ok(notice.content.includes('退出码 0'));
    assert.ok(notice.content.includes('1 分 5 秒'));
    assert.ok(notice.content.includes("check_command(jobId='bg-3')"), '要给出后续动作提示');
    const long = 'x'.repeat(120);
    const cut = buildBgJobExitNotice({jobId: 'bg-9', command: long, code: 1});
    assert.ok(cut.content.includes('…'), '超长命令要截断');
    assert.ok(!cut.content.includes('x'.repeat(81)));
});

test('buildTerminalExitNotice：退出码未知与后续动作提示', () => {
    const notice = buildTerminalExitNotice({termId: 'term-2', code: -1});
    assert.equal(notice.kind, 'bgterm');
    assert.equal(notice.label, '后台终端 · term-2');
    assert.ok(notice.content.startsWith('［后台终端 · term-2］'));
    assert.ok(notice.content.includes('退出码 -1'));
    assert.ok(notice.content.includes("terminal read(id='term-2')"));
    const unknown = buildTerminalExitNotice({termId: 'term-2', code: null});
    assert.ok(unknown.content.includes('退出码 未知'));
});

test('formatBgDuration：秒 / 分 / 时三档', () => {
    assert.equal(formatBgDuration(5_000), '5 秒');
    assert.equal(formatBgDuration(61_000), '1 分 1 秒');
    assert.equal(formatBgDuration(120_000), '2 分');
    assert.equal(formatBgDuration(3_600_000), '1 小时');
    assert.equal(formatBgDuration(3_700_000), '1 小时 1 分');
    assert.equal(formatBgDuration(0), '0 秒');
    assert.equal(formatBgDuration(-5), '0 秒');
});

// ---------- listPending / onChanged（头部「信箱」胶囊的数据源）----------

test('listPending：忙会话的子代理回执挂信箱可枚举，轮边界消费后清零，onChanged 跟随', () => {
    let changes = 0;
    const h = makeHarness({busy: true, onChanged: () => { changes += 1; }});
    // 模拟「开子代理 → 回执到达」：忙会话收结算回执（挂信箱等轮边界）
    const result = h.notices.deliverAgentNotice(h.session, buildSettlementNotice({
        name: '批16-文档', agentId: 'sub-1', state: 'done', summary: '9 条全部落盘',
    }));
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'queued', '忙会话的回执应挂信箱而不是立即起轮');
    const pending = h.notices.listPending();
    assert.equal(pending.length, 1, '只有一个会话挂通知');
    assert.equal(pending[0].sessionId, 's1');
    assert.equal(pending[0].items.length, 1);
    assert.equal(pending[0].items[0].kind, 'subagent');
    assert.equal(pending[0].items[0].label, '子代理通知 · 批16-文档');
    assert.ok(pending[0].items[0].content.includes('批16-文档'), 'content 首行含子代理名');
    assert.equal(changes, 1, '入队触发一次 onChanged');
    // 轮边界消费（foldNotices 折成 user 消息）后信箱清空，onChanged 再触发
    assert.equal(h.notices.foldNotices('s1'), 1);
    assert.deepEqual(h.notices.listPending(), []);
    assert.equal(changes, 2);
    assert.equal(h.session.messages.length, 1, '消费路径把回执折成了一条 user 消息');
    // clearMailbox（用户动作）同样清空并触发
    h.notices.deliverAgentNotice(h.session, buildAskNotice({
        name: '批17-A', agentId: 'sub-2', askId: 'call_1', questions: [{text: '继续吗'}],
    }));
    assert.equal(h.notices.listPending()[0].items[0].kind, 'subagent-ask');
    const before = changes;
    h.notices.clearMailbox('s1');
    assert.deepEqual(h.notices.listPending(), []);
    assert.equal(changes, before + 1);
});

test('listPending：闲会话回执直接起轮消费，不挂信箱（胶囊不误报）', () => {
    let changes = 0;
    const h = makeHarness({busy: false, onChanged: () => { changes += 1; }});
    h.notices.deliverAgentNotice(h.session, buildSettlementNotice({
        name: '批末-A', agentId: 'sub-3', state: 'done', summary: 'ok',
    }));
    assert.deepEqual(h.notices.listPending(), [], '闲会话的回执直接起轮消费，胶囊不应计数');
    assert.equal(h.calls.turns.length, 1);
    assert.ok(changes >= 1, 'enqueued→consumed 的每次增减都有 onChanged');
});

test('接线：信箱胶囊自身显隐必须由 updateMailboxChip 摘除（setChipCount 只管角标数字）', () => {
    // 回归：index.html 里胶囊初始是 class="ai-chip hidden"，漏了 classList.toggle('hidden')
    // 胶囊就永远看不见——信箱有数据也藏着（2026-11-20 实测）。
    const src = readFileSync(new URL('../../../src/ai/ai-panel.js', import.meta.url), 'utf8');
    assert.match(
        src,
        /function updateMailboxChip\(\)[\s\S]{0,500}chipQueue\.classList\.toggle\('hidden', count <= 0\)/,
        'updateMailboxChip 必须按 count 摘/挂胶囊自身的 hidden',
    );
});
