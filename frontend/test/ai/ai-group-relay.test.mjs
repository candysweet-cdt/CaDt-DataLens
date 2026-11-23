// ai-group-relay.test.mjs：接力模式（G7）——链序调度、【交棒】模型声明交棒、无标记重唤
// 与系统代为推进、回问闭环（@ 前棒，答完回来续）与上限、pendingUser 注入、endRelay 中断、
// 链尾自动成果纪要、relaySnapshot 与状态文案。纯函数部分直接测 ai-group-model 导出。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAIGroupRuntime} from '../../src/ai/group/ai-group-runtime.js';
import {
    GROUP_MEMBER_MAX,
    RELAY_CAPS,
    hasHandoffMarker,
    normalizeGroupMode,
    normalizeRelay,
    parseMentions,
    relayAskTargets,
    relayStageFocus,
    relayWakes,
    stripHandoffMarker,
} from '../../src/ai/group/ai-group-model.js';
import {discussionActionLabel, groupStatusText} from '../../src/ai/group/ai-group-ui-model.js';

async function waitFor(fn, ms = 4000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        if (fn()) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
}

// 假后端：replyScript 按 agentId 出回复（循环取最后一条）；replyDelay 按成员延迟发射
//（测运行中插话 / endRelay 中断需要真实的异步窗口）。
function makeBackend() {
    const groups = new Map();
    const sent = [];
    const handlers = [];
    const resolved = new Set();
    const replyScript = new Map();
    const replyDelay = new Map();
    let handler = null;
    const backend = {
        groups,
        sent,
        handlers,
        replyScript,
        replyDelay,
        setHandler: (fn) => {
            handler = fn;
        },
        emit: (name, payload) => {
            if (name === 'ai-done') resolved.add(payload.id);
            for (const fn of handlers) fn(name, payload);
        },
        AIGroupList: async () => [],
        AIGroupRead: async (id) => (groups.get(id) ? groups.get(id).log : ''),
        AIGroupAppend: async (id, lines) => {
            const item = groups.get(id) || {meta: '{}', log: '', priv: {}};
            item.log += lines.endsWith('\n') ? lines : lines + '\n';
            groups.set(id, item);
        },
        AIGroupRewrite: async () => {},
        AIGroupWriteMeta: async (id, data) => {
            const item = groups.get(id) || {meta: '{}', log: '', priv: {}};
            item.meta = data;
            groups.set(id, item);
        },
        AIGroupDelete: async () => {},
        AIGroupDeleteAll: async () => {},
        AIGroupPrivateRead: async () => '',
        AIGroupPrivateAppend: async () => {},
        AIGroupPrivateRewrite: async () => {},
        AISendChat: async (roundId, cfg, messages) => {
            sent.push({roundId, messages});
            if (handler) await handler(roundId, messages, backend.emit);
            return null;
        },
        AIStop: (id) => {
            for (const item of sent) {
                if (!resolved.has(item.roundId) && (id === item.roundId || item.roundId.startsWith(id + '#'))) {
                    backend.emit('ai-done', {id: item.roundId, finishReason: 'stopped'});
                }
            }
        },
    };
    handler = async (roundId, messages, emit) => {
        const agentId = roundId.split('#')[1].split('-').slice(0, -1).join('-');
        const delay = replyDelay.get(agentId) || 0;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        const script = replyScript.get(agentId);
        const text = script && script.length ? (script.length > 1 ? script.shift() : script[0]) : '好的，收到。';
        emit('ai-chunk', {id: roundId, delta: text});
        emit('ai-done', {id: roundId, finishReason: 'stop', usage: {promptTokens: 10, completionTokens: 10, totalTokens: 20}});
    };
    return backend;
}

function makeRuntime(backend, agents) {
    return createAIGroupRuntime({
        backend,
        getAIConfig: () => ({
            agents,
            profiles: [
                {id: 'p1', name: '账号', provider: 'openai', models: [
                    {id: 'm1', model: 'big', contextWindow: 100000, outputWindow: 4096, reasoningEffort: '', thinking: false},
                ]},
            ],
            retryMax: 2,
            outputLanguage: 'zh',
        }),
        resolveModel: () => {
            const entry = {id: 'm1', model: 'big', contextWindow: 100000, outputWindow: 4096};
            return {account: {}, entry, profileCfg: {provider: 'openai', model: 'big', baseURL: '', apiKey: '', temperature: 0, maxTokens: 4096, proxy: '', extraHeaders: {}, thinking: false, thinkingBudget: 8000, reasoningEffort: '', rpmLimit: 0}, label: 'big'};
        },
        flash: () => {},
        getWorkspace: () => '',
    });
}

const AGENTS = [
    {id: 'a1', name: '架构师', color: 'blue', role: '设计', modelRef: 'p1|m1', personaText: '', chair: false, enabled: true},
    {id: 'a2', name: '审查员', color: 'red', role: '审查', modelRef: 'p1|m1', personaText: '', chair: false, enabled: true},
];

function agentOfRoundId(roundId) {
    // roundId = groupId#agentId-seq；测试 id 无 '-'，直接取中段去序号
    return roundId.split('#')[1].replace(/-\d+$/, '');
}

// 某成员某次请求的尾巴（最后一条 user 消息）——焦点文案都在这里
function tailOf(backend, agentId, nth = 0) {
    const calls = backend.sent.filter((item) => agentOfRoundId(item.roundId) === agentId);
    const call = calls[nth < 0 ? calls.length + nth : nth];
    if (!call) return '';
    const users = call.messages.filter((m) => m.role === 'user');
    return users.length ? String(users[users.length - 1].content || '') : '';
}

// ==================== 纯函数 ====================

test('relay 纯函数：模式放行、normalizeRelay 钳制、marker 识别与剥离', () => {
    assert.equal(normalizeGroupMode('relay'), 'relay');
    assert.equal(normalizeGroupMode('nope'), 'roundtable');
    const relay = normalizeRelay({stage: 99, done: true, passes: -3});
    assert.equal(relay.stage, GROUP_MEMBER_MAX);
    assert.equal(relay.done, true);
    assert.equal(relay.passes, 0);
    assert.equal(normalizeRelay({done: 1}).done, false); // done 只认严格 true
    assert.deepEqual(normalizeRelay(null), {stage: 0, done: false, passes: 0});
    // marker：正文末尾算数；代码围栏/行内代码里引用提示词不算
    assert.equal(hasHandoffMarker('产出\n\n【交棒】'), true);
    assert.equal(hasHandoffMarker('```js\n【交棒】\n```'), false);
    assert.equal(hasHandoffMarker('用 `【交棒】` 标记结尾'), false);
    // strip：独立标记行剥掉（首尾清理），行内混排保留
    assert.equal(stripHandoffMarker('产出A\n\n【交棒】\n'), '产出A');
    assert.equal(stripHandoffMarker('【交棒】\n产出A'), '产出A');
    assert.equal(stripHandoffMarker('我说了【交棒】这两个字'), '我说了【交棒】这两个字');
});

test('relay 纯函数：relayAskTargets 只认前棒（@all/@自己/@后棒忽略、去重、上限 2）', () => {
    const earlier = [{id: 'a1', name: '架构师'}, {id: 'a0', name: '前言者'}];
    assert.deepEqual(relayAskTargets('问 @架构师 和 @前言者', {speakerId: 'a2', earlierNames: earlier}), ['a1', 'a0']);
    // @all（成员不能广播）→ 忽略
    assert.deepEqual(relayAskTargets('@全体成员 谁来说下', {speakerId: 'a2', earlierNames: earlier}), []);
    // 自己 / 非前棒（后棒、不存在的名字）→ 忽略
    assert.deepEqual(relayAskTargets('@审查员 你看下', {speakerId: 'a2', earlierNames: earlier}), []);
    assert.deepEqual(relayAskTargets('@路人甲 在吗', {speakerId: 'a2', earlierNames: earlier}), []);
    // 单次最多 @2 人（answersPerAsk）
    assert.deepEqual(
        relayAskTargets('@架构师 @前言者 @审查员 都答下', {speakerId: 'a9', earlierNames: earlier}),
        ['a1', 'a0']);
    // 代码块里的 @ 不算（防引用示例误触发）
    assert.deepEqual(relayAskTargets('```\n@架构师\n```', {speakerId: 'a2', earlierNames: earlier}), []);
});

test('relay 纯函数：relayStageFocus 四类焦点文案', () => {
    const start = relayStageFocus({kind: 'start', index: 0, count: 3, nextName: '审查员'});
    assert.ok(start.includes('接力第 1/3 棒'), start);
    assert.ok(start.includes('审查员'));
    assert.ok(start.includes(RELAY_CAPS.marker));
    assert.ok(start.includes('@ 前面棒次成员的名字提问'));
    const tailStart = relayStageFocus({kind: 'start', index: 2, count: 3, nextName: ''});
    assert.ok(tailStart.includes('最后一棒'), tailStart);
    assert.ok(!tailStart.includes('@ 前面棒次成员的名字提问')); // 尾棒无回问条款
    const answer = relayStageFocus({kind: 'answer', askerName: '审查员'});
    assert.ok(answer.includes('审查员') && answer.includes('不要写' + RELAY_CAPS.marker), answer);
    const resume = relayStageFocus({kind: 'resume', index: 1, count: 3});
    assert.ok(resume.includes('继续完成'), resume);
    const reawake = relayStageFocus({kind: 'reawake'});
    assert.ok(reawake.includes('还没有写' + RELAY_CAPS.marker), reawake);
});

test('relay 状态文案与主按钮：四态', () => {
    const meta = (over) => ({mode: 'relay', relay: {stage: 0, done: false, passes: 0}, ...over});
    const run = (over) => ({running: false, paused: false, stage: 1, stageCount: 3, stageName: '审查员', speeches: 5, done: false, ...over});
    assert.equal(groupStatusText(meta(), run({running: true})), '接力中 · 第 1/3 棒（审查员） · 5 次发言');
    assert.equal(groupStatusText(meta(), run({paused: true})), '已暂停 · 停在第 1/3 棒，点「继续」接着跑');
    assert.equal(groupStatusText(meta({relay: {stage: 3, done: true, passes: 2}}), run({stage: 3})),
        '接力已完成（3 棒 · 第 2 遍）· 发新需求或点「开始接力」再跑一遍');
    assert.ok(groupStatusText(meta({relay: {stage: 1, done: false, passes: 1}}), run({stage: 2})).includes('中断'));
    assert.equal(groupStatusText(meta(), null), '接力待开工 · 发条需求或点「开始接力」，成员按链序交棒');
    assert.equal(discussionActionLabel(meta(), run({running: true})), '暂停');
    assert.equal(discussionActionLabel(meta(), run({paused: true})), '继续');
    assert.equal(discussionActionLabel(meta({relay: {stage: 1, done: false, passes: 1}}), run({stage: 2})), '继续接力');
    assert.equal(discussionActionLabel(meta(), null), '开始接力');
});

// ==================== 端到端（假后端） ====================

async function makeRelayGroup(runtime) {
    const created = await runtime.createGroup({title: '接力群', memberIds: ['a1', 'a2'], mode: 'relay'});
    assert.equal(created.ok, true);
    return created;
}

test('接力链序调度：第 1 棒带【交棒】自动进第 2 棒，链尾自动出成果纪要', async () => {
    const backend = makeBackend();
    const runtime = makeRuntime(backend, AGENTS);
    backend.handlers.push((name, payload) => runtime.handleEvent(name, payload));
    backend.replyScript.set('a1', ['产出A：先定接口。\n\n【交棒】']);
    backend.replyScript.set('a2', ['产出B：审查通过。\n\n【交棒】', '## 成果纪要\n\n- 最终成果：B 汇总']);
    const created = await makeRelayGroup(runtime);
    const sentResult = await runtime.sendUserMessage(created.id, '做一个缓存模块');
    assert.equal(sentResult.ok, true);
    assert.equal(await waitFor(() => runtime.groupById(created.id).meta.relay.done), true);
    // 链序：a1 → a2 → a2（链尾总结）
    assert.deepEqual(backend.sent.map((item) => agentOfRoundId(item.roundId)), ['a1', 'a2', 'a2']);
    // 焦点：第 1 棒开工契约 / 第 2 棒（尾棒）整合条款
    assert.ok(tailOf(backend, 'a1', 0).includes('接力第 1/2 棒'), tailOf(backend, 'a1', 0));
    assert.ok(tailOf(backend, 'a2', 0).includes('第 2/2 棒'));
    assert.ok(tailOf(backend, 'a2', 0).includes('最后一棒'));
    // 成果纪要：来源 relay、署名链尾成员
    const g = runtime.groupById(created.id);
    assert.equal(g.meta.minutes && g.meta.minutes.source, 'relay');
    const minutesMsg = g.messages.find((m) => m.kind === 'minutes');
    assert.ok(minutesMsg, '纪要卡片已落盘');
    assert.equal(minutesMsg.agentName, '审查员');
    // 完成灰条
    assert.ok(g.events.some((evt) => evt.type === 'relay' && String(evt.text || '').includes('接力完成')));
    // 快照
    const snap = runtime.relaySnapshot(created.id);
    assert.equal(snap.stageCount, 2);
    assert.equal(snap.stage, 2);
    assert.equal(snap.running, false);
    assert.equal(snap.done, true);
});

test('无标记：重唤（reawake 焦点）到 stageSpeaksMax 后系统代为推进', async () => {
    const backend = makeBackend();
    const runtime = makeRuntime(backend, AGENTS);
    backend.handlers.push((name, payload) => runtime.handleEvent(name, payload));
    backend.replyScript.set('a1', ['我还没做完，继续补充一些细节。']); // 永远无标记
    backend.replyScript.set('a2', ['产出B。\n\n【交棒】', '## 成果纪要\n\n- 最终成果：B']);
    const created = await makeRelayGroup(runtime);
    await runtime.sendUserMessage(created.id, '任务');
    assert.equal(await waitFor(() => runtime.groupById(created.id).meta.relay.done), true);
    const a1Calls = backend.sent.filter((item) => agentOfRoundId(item.roundId) === 'a1');
    assert.equal(a1Calls.length, RELAY_CAPS.stageSpeaksMax); // 重唤到顶
    // 第二次起是续写焦点
    assert.ok(tailOf(backend, 'a1', -1).includes('还没有写【交棒】'));
    const g = runtime.groupById(created.id);
    assert.ok(g.events.some((evt) => evt.type === 'relay' && String(evt.text || '').includes('未声明交棒')));
    assert.ok(g.events.some((evt) => evt.type === 'relay' && String(evt.text || '').includes('代为推进')));
});

test('回问闭环：@ 前棒提问 → 前棒只回答 → 回到提问者继续；回答焦点带提问者名', async () => {
    const backend = makeBackend();
    const runtime = makeRuntime(backend, AGENTS);
    backend.handlers.push((name, payload) => runtime.handleEvent(name, payload));
    backend.replyScript.set('a1', ['产出A：接口已定。\n\n【交棒】', '（回答）接口走 A 方案，直接用即可。']);
    backend.replyScript.set('a2', ['先问一下 @架构师 接口怎么定？', '明白了，产出B：审查通过。\n\n【交棒】', '## 成果纪要\n\n- 最终成果：B']);
    const created = await makeRelayGroup(runtime);
    await runtime.sendUserMessage(created.id, '任务');
    assert.equal(await waitFor(() => runtime.groupById(created.id).meta.relay.done), true);
    assert.deepEqual(backend.sent.map((item) => agentOfRoundId(item.roundId)), ['a1', 'a2', 'a1', 'a2', 'a2']);
    // 回答焦点：指向提问者、只回答不交棒
    const answerTail = tailOf(backend, 'a1', 1);
    assert.ok(answerTail.includes('架构师') && answerTail.includes('不要写【交棒】'), answerTail);
    // 回到提问者的续写焦点
    assert.ok(tailOf(backend, 'a2', 1).includes('继续完成'), tailOf(backend, 'a2', 1));
    const g = runtime.groupById(created.id);
    assert.equal(g.meta.relay.done, true);
});

test('回问上限：askBacksMax 次后强制基于现有信息继续（不再唤醒前棒）', async () => {
    const backend = makeBackend();
    const runtime = makeRuntime(backend, AGENTS);
    backend.handlers.push((name, payload) => runtime.handleEvent(name, payload));
    backend.replyScript.set('a1', ['产出A。\n\n【交棒】', '（回答）1。', '（回答）2。']);
    backend.replyScript.set('a2', ['问 @架构师 细节？']); // 单条循环 → 每次发言都在问（无标记）
    const created = await makeRelayGroup(runtime);
    await runtime.sendUserMessage(created.id, '任务');
    assert.equal(await waitFor(() => runtime.groupById(created.id).meta.relay.done), true);
    const a1Calls = backend.sent.filter((item) => agentOfRoundId(item.roundId) === 'a1');
    const a2Calls = backend.sent.filter((item) => agentOfRoundId(item.roundId) === 'a2');
    assert.equal(a1Calls.length, 1 + RELAY_CAPS.askBacksMax);   // 本棒 1 次 + 回答 2 次
    assert.equal(a2Calls.length, RELAY_CAPS.stageSpeaksMax + 1); // 4 次重唤到顶 + 链尾总结
    const g = runtime.groupById(created.id);
    assert.ok(g.events.some((evt) => evt.type === 'relay' && String(evt.text || '').includes('回问次数已达上限')));
    assert.equal(g.meta.relay.done, true);
});

test('运行中插话：进入 pendingUser，下一棒开跑前以焦点提醒（不触发额外调度）', async () => {
    const backend = makeBackend();
    const runtime = makeRuntime(backend, AGENTS);
    backend.handlers.push((name, payload) => runtime.handleEvent(name, payload));
    backend.replyScript.set('a1', ['产出A。\n\n【交棒】']);
    backend.replyScript.set('a2', ['产出B。\n\n【交棒】', '## 成果纪要\n\n- 最终成果：B']);
    backend.replyDelay.set('a1', 260); // 留出插话窗口
    const created = await makeRelayGroup(runtime);
    await runtime.sendUserMessage(created.id, '任务');
    await new Promise((resolve) => setTimeout(resolve, 80));
    const interject = await runtime.sendUserMessage(created.id, '补充：优先用方案 A');
    assert.equal(interject.ok, true);
    assert.equal(await waitFor(() => runtime.groupById(created.id).meta.relay.done), true);
    assert.deepEqual(backend.sent.map((item) => agentOfRoundId(item.roundId)), ['a1', 'a2', 'a2']); // 插话不触发额外棒
    assert.ok(tailOf(backend, 'a2', 0).includes('用户刚补充了 1 条消息'), tailOf(backend, 'a2', 0));
});

test('endRelay 中断：在飞请求按 stopped 归档，链停在当前棒，不产纪要', async () => {
    const backend = makeBackend();
    const runtime = makeRuntime(backend, AGENTS);
    backend.handlers.push((name, payload) => runtime.handleEvent(name, payload));
    backend.replyScript.set('a1', ['产出A。\n\n【交棒】']);
    backend.replyScript.set('a2', ['产出B。\n\n【交棒】', '## 成果纪要\n\n- 最终成果：B']);
    backend.replyDelay.set('a1', 600);
    const created = await makeRelayGroup(runtime);
    const started = runtime.startRelay(created.id);
    assert.equal(started.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const ended = runtime.endRelay(created.id);
    assert.equal(ended.ok, true);
    assert.equal(await waitFor(() => !runtime.relaySnapshot(created.id).running), true);
    const g = runtime.groupById(created.id);
    assert.equal(g.meta.relay.done, false);
    assert.equal(g.meta.minutes, null);
    assert.deepEqual(backend.sent.map((item) => agentOfRoundId(item.roundId)), ['a1']); // a2 未被调用
});

test('接力成员被静音后链不足：startRelay 拒绝并报可用成员不足', async () => {
    const backend = makeBackend();
    const runtime = makeRuntime(backend, AGENTS);
    backend.handlers.push((name, payload) => runtime.handleEvent(name, payload));
    const created = await makeRelayGroup(runtime);
    await runtime.saveMeta(created.id, (meta) => {
        meta.mutedAgentIds = ['a2'];
    });
    const started = runtime.startRelay(created.id);
    assert.equal(started.ok, false);
    assert.ok(String(started.error || '').includes('可用成员不足'), started.error);
});

test('断点续跑：中断后「开始接力」（不带 fresh）从已完成的棒继续，不重跑已完成棒', async () => {
    const backend = makeBackend();
    const runtime = makeRuntime(backend, AGENTS);
    backend.handlers.push((name, payload) => runtime.handleEvent(name, payload));
    backend.replyScript.set('a1', ['产出A。\n\n【交棒】']);
    backend.replyScript.set('a2', ['产出B。\n\n【交棒】']); // 循环取最后一条：中断消耗的脚本不影响续跑
    backend.replyDelay.set('a2', 600); // 第 2 棒卡住
    const created = await makeRelayGroup(runtime);
    await runtime.sendUserMessage(created.id, '任务'); // a1 完成后 a2 卡住
    await new Promise((resolve) => setTimeout(resolve, 200));
    runtime.endRelay(created.id);
    assert.equal(await waitFor(() => !runtime.relaySnapshot(created.id).running), true);
    const g = runtime.groupById(created.id);
    assert.equal(g.meta.relay.done, false);
    const a1Before = backend.sent.filter((item) => agentOfRoundId(item.roundId) === 'a1').length;
    // 断点续跑：a1 已完成，不应再被调用
    backend.replyDelay.set('a2', 0);
    const resumed = runtime.startRelay(created.id);
    assert.equal(resumed.ok, true);
    assert.equal(await waitFor(() => runtime.groupById(created.id).meta.relay.done), true);
    const a1After = backend.sent.filter((item) => agentOfRoundId(item.roundId) === 'a1').length;
    assert.equal(a1After, a1Before); // a1 没有重跑
    assert.ok(runtime.relaySnapshot(created.id).done);
});

// ==================== 评审修复回归 ====================

test('parseMentions：CJK 右边界（@全体成员好 不误判 @all、@架构师 不误命中「架构」）', () => {
    // @all 后紧跟汉字不算广播
    assert.deepEqual(parseMentions('@全体成员好', ['架构']), {all: false, names: []});
    assert.deepEqual(parseMentions('@所有人啊', ['架构']), {all: false, names: []});
    // 正常边界仍生效
    assert.deepEqual(parseMentions('@全体成员 集合', ['架构']), {all: true, names: []});
    // 成员名前缀：@架构师 不应命中名为「架构」的成员
    assert.deepEqual(parseMentions('@架构师 说', ['架构']), {all: false, names: []});
    assert.deepEqual(parseMentions('@架构 说', ['架构']), {all: false, names: ['架构']});
});

test('parseMentions/relayWakes：names 按文本出现序（单条最多 @2 人截先写的两位）', () => {
    assert.deepEqual(parseMentions('@审查员 先说，@架构师 后说', ['架构师', '审查员']).names, ['审查员', '架构师']);
    const ctx = {
        speakerId: 'a0',
        memberNames: [{id: 'a1', name: '架构师'}, {id: 'a2', name: '审查员'}, {id: 'a3', name: '评审'}],
        generation: 0, pairCounts: new Map(), perAgentCounts: new Map(),
    };
    assert.deepEqual(relayWakes('@审查员 @架构师 @评审 都说', ctx), ['a2', 'a1']); // 文本前两位
});

test('重启后状态文案：run=null 时按 meta.relay 回退，已完成/中断不再显示「待开工」', () => {
    const meta = (over) => ({mode: 'relay', memberIds: ['a1', 'a2', 'a3'], relay: {stage: 0, done: false, passes: 0}, ...over});
    assert.ok(groupStatusText(meta({relay: {stage: 3, done: true, passes: 2}}), null).includes('接力已完成（3 棒'));
    assert.ok(groupStatusText(meta({relay: {stage: 1, done: false, passes: 1}}), null).includes('接力中断于第 2 棒'));
    assert.ok(groupStatusText(meta(), null).includes('待开工'));
});

test('暂停态「结束并总结」：产纪要、落 done，随后「继续」被拒（不复活）', async () => {
    const backend = makeBackend();
    const runtime = makeRuntime(backend, AGENTS);
    backend.handlers.push((name, payload) => runtime.handleEvent(name, payload));
    backend.replyScript.set('a1', ['产出A。\n\n【交棒】']);
    backend.replyScript.set('a2', ['产出B。\n\n【交棒】', '## 成果纪要\n\n- 汇总']);
    backend.replyDelay.set('a2', 300); // 第一棒快速完成、第二棒卡住时暂停（保证 stage>=1 有产出可总结）
    const created = await makeRelayGroup(runtime);
    const started = runtime.startRelay(created.id);
    assert.equal(started.ok, true);
    // 等第一棒完成、第二棒进入在飞状态
    assert.equal(await waitFor(() => backend.sent.filter((i) => agentOfRoundId(i.roundId) === 'a2').length > 0), true);
    const paused = runtime.pauseRelay(created.id);
    assert.equal(paused.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 60)); // 等在飞第二棒说完、循环因 paused 退出
    assert.equal(runtime.relaySnapshot(created.id).paused, true);
    const ended = runtime.endRelay(created.id);
    assert.equal(ended.ok, true);
    // 收尾异步跑完：纪要落盘、paused 被清
    assert.equal(await waitFor(() => runtime.relaySnapshot(created.id).paused === false), true);
    assert.equal(await waitFor(() => !!runtime.groupById(created.id).meta.minutes), true);
    // 结束后「继续」必须被拒，不能复活
    const resumed = runtime.resumeRelay(created.id);
    assert.equal(resumed.ok, false);
});
