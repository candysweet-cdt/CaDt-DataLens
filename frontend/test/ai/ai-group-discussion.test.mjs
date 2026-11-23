// ai-group-discussion.test.mjs：G3 讨论循环端到端（脚本化假模型）——开场/复盘契约、
// 立场卡合并、轮次推进与纪要、用户点名、用户主持的暂停/继续/结束、手动压缩 cutoff。
// 真实 SSE 生命周期不在此面内（G2/G3 手工验收）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAIGroupRuntime} from '../../src/ai/group/ai-group-runtime.js';

async function settle(ms = 40) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, ms = 3000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        if (fn()) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
}

function makeBackend() {
    const groups = new Map();
    const sent = [];
    const stops = [];
    const handlers = [];
    const resolved = new Set();
    const backend = {
        groups,
        sent,
        stops,
        handlers,
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
        AIGroupPrivateRead: async (id, agent) => {
            const item = groups.get(id);
            return item && item.priv[agent] ? item.priv[agent] : '';
        },
        AIGroupPrivateAppend: async (id, agent, lines) => {
            const item = groups.get(id) || {meta: '{}', log: '', priv: {}};
            item.priv[agent] = (item.priv[agent] || '') + lines;
            groups.set(id, item);
        },
        AIGroupPrivateRewrite: async () => {},
        AISendChat: async (roundId, cfg, messages) => {
            sent.push({roundId, cfg, messages});
            if (handler) await handler(roundId, messages, backend.emit);
            return null;
        },
        AIStop: (id) => {
            stops.push(id);
            // 模拟 Go 侧取消语义：群前缀取消 → 未完成请求补发 ai-done stopped
            for (const item of sent) {
                if (!resolved.has(item.roundId) && (id === item.roundId || item.roundId.startsWith(id + '#'))) {
                    backend.emit('ai-done', {id: item.roundId, finishReason: 'stopped'});
                }
            }
        },
    };
    let handler = null;
    return backend;
}

const AGENTS_WITH_CHAIR = [
    {id: 'a1', name: '架构师', color: 'blue', role: '设计', modelRef: 'p1|m1', personaText: '', chair: false, enabled: true},
    {id: 'a2', name: '审查员', color: 'red', role: '审查', modelRef: 'p1|m2', personaText: '', chair: false, enabled: true},
    {id: 'a3', name: '主持人', color: 'violet', role: '主持', modelRef: 'p1|m1', personaText: '', chair: true, enabled: true},
];

function chairJSON(value) {
    return '```group\n' + JSON.stringify(value) + '\n```';
}

function makeRuntime(backend, agents) {
    return createAIGroupRuntime({
        backend,
        getAIConfig: () => ({
            agents,
            profiles: [
                {id: 'p1', name: '账号', provider: 'openai', models: [
                    {id: 'm1', model: 'big', contextWindow: 100000, outputWindow: 4096, reasoningEffort: '', thinking: false},
                    {id: 'm2', model: 'big2', contextWindow: 100000, outputWindow: 4096, reasoningEffort: '', thinking: false},
                ]},
            ],
            retryMax: 2,
            outputLanguage: 'zh',
        }),
        resolveModel: (ref) => {
            const entry = ref.endsWith('m1')
                ? {id: 'm1', model: 'big', contextWindow: 100000, outputWindow: 4096}
                : {id: 'm2', model: 'big2', contextWindow: 100000, outputWindow: 4096};
            return {account: {}, entry, profileCfg: {provider: 'openai', model: entry.model, baseURL: '', apiKey: '', temperature: 0, maxTokens: 4096, proxy: '', extraHeaders: {}, thinking: false, thinkingBudget: 8000, reasoningEffort: '', rpmLimit: 0}, label: entry.model};
        },
        flash: () => {},
        getWorkspace: () => '',
    });
}

async function makeGroup(runtime, overrides = {}) {
    const result = await runtime.createGroup({
        title: '评审',
        topic: '存储方案',
        goal: 'decide',
        memberIds: ['a1', 'a2'],
        maxRounds: 2,
        timeoutPreset: 'standard',
        ...overrides,
    });
    assert.equal(result.ok, true, '群创建失败：' + (result.error || ''));
    return result.id;
}

test('完整讨论循环：开场 → 计划发言（立场卡合并）→ 复盘 → 第 2 轮 → 纪要', async () => {
    const backend = makeBackend();
    const runtime = makeRuntime(backend, AGENTS_WITH_CHAIR);
    const groupId = await makeGroup(runtime, {chair: {kind: 'ai', agentId: 'a3'}});
    backend.handlers.push((name, payload) => runtime.handleEvent(name, payload));
    backend.setHandler((roundId, messages, emit) => {
        if (roundId.includes('#chair-opening')) {
            emit('ai-chunk', {id: roundId, delta: chairJSON({
                chairMessage: '开场：先谈拆库再谈迁移',
                plan: [{speaker: '架构师', focus: '给出拆库方案', agendaItem: '拆库'},
                       {speaker: '审查员', focus: '审查迁移风险', agendaItem: '迁移'}],
                statePatch: {agreements: ['拆库方向可行']},
            })});
            emit('ai-done', {id: roundId, finishReason: 'stop'});
        } else if (roundId.includes('#chair-review')) {
            emit('ai-chunk', {id: roundId, delta: chairJSON({
                chairMessage: '本轮结束，分歧已回应',
                plan: [{speaker: '架构师', focus: '回应上轮分歧', agendaItem: '迁移'}],
                statePatch: {decisions: ['确定拆库']},
                roundComplete: true,
                done: false,
            })});
            emit('ai-done', {id: roundId, finishReason: 'stop'});
        } else {
            emit('ai-chunk', {id: roundId, delta: '我的观点。```group\n{"stance":"agree","keyPoints":["隔离更安全"],"questions":["回滚怎么办"]}\n```'});
            emit('ai-done', {id: roundId, finishReason: 'stop', usage: {totalTokens: 500}});
        }
    });

    const start = runtime.startDiscussion(groupId);
    assert.equal(start.ok, true, start.error);
    const ended = await waitFor(() => {
        const snap = runtime.discussionSnapshot(groupId);
        return snap && snap.phase === 'ended';
    });
    assert.ok(ended, '讨论未收敛：' + JSON.stringify(runtime.discussionSnapshot(groupId)));

    const g = runtime.groupById(groupId);
    const chairMsgs = g.messages.filter((m) => m.chair && m.kind !== 'minutes');
    assert.ok(chairMsgs.length >= 2, '主持人消息数：' + chairMsgs.length);
    assert.equal(chairMsgs[0].content, '开场：先谈拆库再谈迁移');
    assert.ok(!chairMsgs[0].content.includes('```'), 'JSON 原文不应进正文');
    const memberMsg = g.messages.find((m) => m.agentId === 'a1' && !m.chair);
    assert.equal(memberMsg.groupBlock.stance, 'agree');
    assert.ok(!memberMsg.content.includes('```'));
    assert.ok(memberMsg.content.includes('我的观点'));
    assert.ok(g.meta.discussion.agreements.includes('拆库方向可行'));
    assert.ok(g.meta.discussion.agenda.includes('拆库'));
    assert.ok(g.meta.discussion.decisions.includes('确定拆库'));
    assert.ok(g.meta.discussion.openQuestions.includes('回滚怎么办'));
    assert.equal(g.meta.discussion.round, 2);
    const minutesMsg = g.messages.find((m) => m.kind === 'minutes');
    assert.ok(minutesMsg, '纪要消息缺失');
    assert.ok(g.meta.minutes);
    assert.match(minutesMsg.content, /群聊纪要/);
    // 每轮每人最多一次：2 成员 × 2 轮 = 4 条成员发言
    const memberSpeeches = g.messages.filter((m) => !m.chair && m.role === 'assistant');
    assert.equal(memberSpeeches.length, 4);
});

test('用户点名：@审查员 进入下一次调度；同轮不重复发言', async () => {
    const backend = makeBackend();
    const runtime = makeRuntime(backend, AGENTS_WITH_CHAIR);
    const groupId = await makeGroup(runtime, {chair: {kind: 'ai', agentId: 'a3'}, maxRounds: 1});
    backend.handlers.push((name, payload) => runtime.handleEvent(name, payload));
    let speechCount = 0;
    backend.setHandler((roundId, messages, emit) => {
        if (roundId.includes('#chair-opening')) {
            emit('ai-chunk', {id: roundId, delta: chairJSON({
                chairMessage: '开场',
                plan: [{speaker: '架构师', focus: 'A 先说'}, {speaker: '审查员', focus: 'B 再说'}],
            })});
            emit('ai-done', {id: roundId, finishReason: 'stop'});
        } else if (roundId.includes('#chair-review')) {
            emit('ai-chunk', {id: roundId, delta: chairJSON({chairMessage: '小结', roundComplete: true, done: true})});
            emit('ai-done', {id: roundId, finishReason: 'stop'});
        } else {
            speechCount++;
            if (speechCount === 1) {
                runtime.sendUserMessage(groupId, '@审查员 请回应迁移成本').catch(() => {});
            }
            emit('ai-chunk', {id: roundId, delta: '观点 ' + speechCount});
            emit('ai-done', {id: roundId, finishReason: 'stop'});
        }
    });
    const start = runtime.startDiscussion(groupId);
    assert.equal(start.ok, true);
    const ended = await waitFor(() => {
        const snap = runtime.discussionSnapshot(groupId);
        return snap && snap.phase === 'ended';
    });
    assert.ok(ended, '讨论未结束');
    const g = runtime.groupById(groupId);
    assert.ok(g.events.some((e) => e.type === 'mention' && e.text.includes('@审查员')));
    const speeches = g.messages.filter((m) => !m.chair && m.role === 'assistant');
    assert.equal(speeches.length, 2, '每轮每人最多一次（被点名的成员不重复发言）');
});

test('用户主持：无主持人调用；暂停/继续/结束并总结（看板模板纪要）', async () => {
    const backend = makeBackend();
    const runtime = makeRuntime(backend, AGENTS_WITH_CHAIR);
    const groupId = await makeGroup(runtime, {chair: {kind: 'user'}});
    backend.handlers.push((name, payload) => runtime.handleEvent(name, payload));
    // 第一次发言门控：等测试暂停后再放行，避免讨论自动跑完
    let releaseFirst = null;
    const firstGate = new Promise((resolve) => {
        releaseFirst = resolve;
    });
    let speechIndex = 0;
    backend.setHandler(async (roundId, messages, emit) => {
        speechIndex++;
        if (speechIndex === 1) await firstGate;
        emit('ai-chunk', {id: roundId, delta: '手动调度下的发言 ' + speechIndex});
        emit('ai-done', {id: roundId, finishReason: 'stop'});
    });
    const start = runtime.startDiscussion(groupId);
    assert.equal(start.ok, true);
    // 第一次发言已发出（还在门内）→ 暂停 → 放行让它说完 → 应停在 paused
    await waitFor(() => backend.sent.length >= 1);
    runtime.pauseDiscussion(groupId);
    releaseFirst();
    const paused = await waitFor(() => {
        const snap = runtime.discussionSnapshot(groupId);
        return snap && snap.paused && !snap.running;
    });
    assert.ok(paused, '未进入暂停态');
    assert.equal(runtime.discussionSnapshot(groupId).phase, 'paused');
    // 继续后立即结束并总结（在飞请求被补发 stopped）
    runtime.resumeDiscussion(groupId);
    await waitFor(() => runtime.discussionSnapshot(groupId).running);
    runtime.endDiscussion(groupId);
    const ended = await waitFor(() => {
        const snap = runtime.discussionSnapshot(groupId);
        return snap && (snap.phase === 'ended' || (!snap.running && !snap.paused));
    });
    assert.ok(ended, '结束未完成');
    await settle();
    const g = runtime.groupById(groupId);
    assert.ok(g.meta.minutes, '看板模板纪要缺失');
    assert.equal(g.meta.minutes.source, 'board');
    const minutesMsg = g.messages.find((m) => m.kind === 'minutes');
    assert.ok(minutesMsg && minutesMsg.chair);
    assert.equal(backend.sent.filter((s) => s.roundId.includes('#chair-')).length, 0);
});

test('手动压缩：单轮无可压缩历史时拒绝；压缩成功后成员请求 = 摘要 + cutoff 后对话', async () => {
    const backend = makeBackend();
    const runtime = makeRuntime(backend, AGENTS_WITH_CHAIR);
    const groupId = await makeGroup(runtime, {chair: {kind: 'user'}, maxRounds: 2});
    backend.handlers.push((name, payload) => runtime.handleEvent(name, payload));
    backend.setHandler((roundId, messages, emit) => {
        if (roundId.includes('#compress')) {
            emit('ai-chunk', {id: roundId, delta: '旧轮次摘要'});
            emit('ai-done', {id: roundId, finishReason: 'stop'});
        } else {
            const n = backend.sent.filter((s) => !s.roundId.includes('#compress')).length;
            emit('ai-chunk', {id: roundId, delta: '第' + n + '轮发言'});
            emit('ai-done', {id: roundId, finishReason: 'stop'});
        }
    });
    // 单轮 → 拒绝（保留最近 1 轮后无可压缩历史）
    await runtime.speak(groupId, 'a1', {});
    await settle();
    const reject = await runtime.compressShared(groupId, {keepRounds: 1});
    assert.equal(reject.ok, false);
    assert.match(reject.error, /没有可压缩/);
    assert.equal(runtime.groupById(groupId).meta.sharedSummary, null);
    // 推进到第 2 轮再压
    await runtime.saveMeta(groupId, (meta) => {
        meta.discussion.round = 2;
    });
    await runtime.speak(groupId, 'a1', {});
    await settle();
    const compress = await runtime.compressShared(groupId, {keepRounds: 1});
    assert.equal(compress.ok, true, compress.error);
    const g = runtime.groupById(groupId);
    assert.equal(g.meta.sharedSummary.text, '旧轮次摘要');
    assert.equal(g.meta.sharedSummary.createdBy, 'user');
    assert.notEqual(g.meta.sharedSummary.cutoffGid, '');
    // 压缩后发言：请求里只有摘要 + 第 2 轮消息，第 1 轮不再逐条出现
    const speak = await runtime.speak(groupId, 'a2', {focus: '压缩后继续'});
    assert.equal(speak.ok, true);
    const req = backend.sent[backend.sent.length - 1];
    const userContent = req.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    assert.ok(userContent.includes('旧轮次摘要'), '摘要应进上下文');
    assert.ok(userContent.includes('第2轮发言'), 'cutoff 之后的对话全文保留');
    assert.ok(!userContent.includes('第1轮发言'), 'cutoff 之前的消息不再逐条出现');
});
