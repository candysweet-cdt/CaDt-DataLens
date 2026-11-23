// ai-group-chat.test.mjs：自由聊天路径端到端（脚本化假模型）——闲时消息即唤醒
//（@点名/@全体/无 @ 轮换接话）、自由模式成员接力与 §12 上限、模型失效的系统通知。
// 讨论进行中的点名走 forcedIds（ai-group-discussion.test.mjs 已覆盖），此处不重复。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAIGroupRuntime} from '../../src/ai/group/ai-group-runtime.js';

async function settle(ms = 40) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, ms = 4000) {
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
    const handlers = [];
    const resolved = new Set();
    const replyScript = new Map(); // agentId → [回复文案]（循环取最后一条）
    let handler = null;
    const backend = {
        groups,
        sent,
        handlers,
        replyScript,
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
    handler = (roundId, messages, emit) => {
        const agentId = roundId.split('#')[1].split('-').slice(0, -1).join('-');
        const script = replyScript.get(agentId);
        const text = script && script.length ? (script.length > 1 ? script.shift() : script[0]) : '好的，收到。';
        emit('ai-chunk', {id: roundId, delta: text});
        emit('ai-done', {id: roundId, finishReason: 'stop'});
    };
    return backend;
}

function makeRuntime(backend, agents, resolveModelOverride) {
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
        resolveModel: resolveModelOverride || ((ref) => {
            const entry = {id: 'm1', model: 'big', contextWindow: 100000, outputWindow: 4096};
            return {account: {}, entry, profileCfg: {provider: 'openai', model: 'big', baseURL: '', apiKey: '', temperature: 0, maxTokens: 4096, proxy: '', extraHeaders: {}, thinking: false, thinkingBudget: 8000, reasoningEffort: '', rpmLimit: 0}, label: 'big'};
        }),
        flash: () => {},
        getWorkspace: () => '',
    });
}

const AGENTS = [
    {id: 'a1', name: '架构师', color: 'blue', role: '设计', modelRef: 'p1|m1', personaText: '', chair: false, enabled: true},
    {id: 'a2', name: '审查员', color: 'red', role: '审查', modelRef: 'p1|m1', personaText: '', chair: false, enabled: true},
];

function agentOfRoundId(roundId) {
    // roundId = groupId#agentId-seq（agentId 本身无 - 序号后缀除外）；测试 id 无 '-'，直接取中段
    return roundId.split('#')[1].replace(/-\d+$/, '');
}

test('闲时 @全体成员：每位成员各回一次（串行）', async () => {
    const backend = makeBackend();
    const runtime = makeRuntime(backend, AGENTS);
    backend.handlers.push((name, payload) => runtime.handleEvent(name, payload));
    const created = await runtime.createGroup({title: '闲聊', memberIds: ['a1', 'a2'], mode: 'roundtable'});
    assert.equal(created.ok, true);
    const sentResult = await runtime.sendUserMessage(created.id, '@全体成员 大家好');
    assert.equal(sentResult.ok, true);
    assert.equal(await waitFor(() => backend.sent.length >= 2), true, '应唤醒两位成员');
    await settle();
    const speakers = backend.sent.map((item) => agentOfRoundId(item.roundId));
    assert.deepEqual(speakers.sort(), ['a1', 'a2']);
    const g = runtime.groupById(created.id);
    const replies = g.messages.filter((m) => m.role === 'assistant');
    assert.equal(replies.length, 2);
});

test('闲时无 @：轮换接话人（每条消息一位成员，按名单轮转）', async () => {
    const backend = makeBackend();
    const runtime = makeRuntime(backend, AGENTS);
    backend.handlers.push((name, payload) => runtime.handleEvent(name, payload));
    const created = await runtime.createGroup({title: '闲聊', memberIds: ['a1', 'a2']});
    assert.equal(created.ok, true);
    await runtime.sendUserMessage(created.id, '第一条');
    assert.equal(await waitFor(() => backend.sent.length >= 1), true);
    await settle();
    await runtime.sendUserMessage(created.id, '第二条');
    assert.equal(await waitFor(() => backend.sent.length >= 2), true);
    await settle();
    const speakers = backend.sent.map((item) => agentOfRoundId(item.roundId));
    assert.deepEqual(speakers, ['a1', 'a2']); // 轮换：第一条 a1，第二条 a2
});

test('自由模式接力：成员输出里的 @ 继续唤醒（单跳）', async () => {
    const backend = makeBackend();
    const runtime = makeRuntime(backend, AGENTS);
    backend.handlers.push((name, payload) => runtime.handleEvent(name, payload));
    backend.replyScript.set('a1', ['我先说。@审查员 请补充']);
    backend.replyScript.set('a2', ['补充完毕']);
    const created = await runtime.createGroup({title: '自由', memberIds: ['a1', 'a2'], mode: 'free'});
    assert.equal(created.ok, true);
    await runtime.sendUserMessage(created.id, '@架构师 开始');
    assert.equal(await waitFor(() => backend.sent.length >= 2), true, '接力应唤醒审查员');
    await settle();
    const speakers = backend.sent.map((item) => agentOfRoundId(item.roundId));
    assert.deepEqual(speakers, ['a1', 'a2']);
    assert.equal(await waitFor(() => backend.sent.length >= 3, 400), false, '链条应终止（a2 无 @）');
});

test('自由模式接力：同对成员乒乓 ≤2 次后链条终止', async () => {
    const backend = makeBackend();
    const runtime = makeRuntime(backend, AGENTS);
    backend.handlers.push((name, payload) => runtime.handleEvent(name, payload));
    backend.replyScript.set('a1', ['第1句 @审查员 看看', '第2句 @审查员 再看看']);
    backend.replyScript.set('a2', ['回复1 @架构师 你呢', '回复2 @架构师 你呢']);
    const created = await runtime.createGroup({title: '自由', memberIds: ['a1', 'a2'], mode: 'free'});
    assert.equal(created.ok, true);
    await runtime.sendUserMessage(created.id, '@架构师 开始');
    // 链条：a1 → a2 → a1（a2 的第 2 次 @ 被乒乓上限拦住）→ 共 3 次回复
    assert.equal(await waitFor(() => backend.sent.length >= 3), true);
    await settle(120);
    assert.equal(backend.sent.length, 3, '乒乓上限后不应再唤醒（实际 ' + backend.sent.length + '）');
    const speakers = backend.sent.map((item) => agentOfRoundId(item.roundId));
    assert.deepEqual(speakers, ['a1', 'a2', 'a1']);
});

test('成员模型失效：系统通知明示原因，其余成员继续', async () => {
    const agents = [
        AGENTS[0],
        {...AGENTS[1], modelRef: 'p1|dead'},
    ];
    const backend = makeBackend();
    const runtime = makeRuntime(backend, agents, (ref) => {
        if (String(ref).includes('dead')) return null;
        const entry = {id: 'm1', model: 'big', contextWindow: 100000, outputWindow: 4096};
        return {account: {}, entry, profileCfg: {provider: 'openai', model: 'big', baseURL: '', apiKey: '', temperature: 0, maxTokens: 4096, proxy: '', extraHeaders: {}, thinking: false, thinkingBudget: 8000, reasoningEffort: '', rpmLimit: 0}, label: 'big'};
    });
    backend.handlers.push((name, payload) => runtime.handleEvent(name, payload));
    const created = await runtime.createGroup({title: '失效', memberIds: ['a1', 'a2']});
    assert.equal(created.ok, true);
    await runtime.sendUserMessage(created.id, '@全体成员 开始');
    assert.equal(await waitFor(() => backend.sent.length >= 1), true);
    await settle(120);
    const g = runtime.groupById(created.id);
    const notices = g.messages.filter((m) => m.role === 'system');
    assert.ok(notices.some((m) => m.content.includes('审查员') && m.content.includes('模型不可用')), '应有模型不可用通知');
    assert.equal(await waitFor(() => backend.sent.length >= 2, 400), false, '失效成员不应被调用');
});
