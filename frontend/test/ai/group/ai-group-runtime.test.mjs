// ai-group-runtime.test.mjs：发言路径端到端（假后端）——上下文组装、流事件认领、
// 落盘、超时跳过、上下文门禁、串行互斥、用户插话。
// 真 AI 传输（SSE / 看门狗 / 重试）不在单测面内，靠 G2/G3 手工验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAIGroupRuntime} from '../../../src/ai/group/ai-group-runtime.js';

function makeBackend() {
    const groups = new Map();
    const sent = [];
    const stops = [];
    return {
        groups,
        sent,
        stops,
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
        AISendChat: async (roundId, cfg, messages, tools, retryMax) => {
            sent.push({roundId, cfg, messages, tools, retryMax});
        },
        AIStop: (id) => stops.push(id),
    };
}

function makeRuntime(backend, overrides = {}) {
    const agents = overrides.agents || [
        {id: 'a1', name: '架构师', color: 'blue', role: '设计', modelRef: 'p1|m1', personaText: '', chair: false, enabled: true},
        {id: 'a2', name: '审查员', color: 'red', role: '审查', modelRef: 'p1|m2', personaText: '谨慎', chair: false, enabled: true, slowTier: true},
    ];
    const runtime = createAIGroupRuntime({
        backend,
        getAIConfig: () => ({
            agents,
            profiles: overrides.profiles || [
                {id: 'p1', name: '账号', provider: 'openai', models: [
                    {id: 'm1', model: 'big', contextWindow: overrides.window || 100000, outputWindow: 4096, reasoningEffort: '', thinking: false},
                    {id: 'm2', model: 'big2', contextWindow: overrides.window || 100000, outputWindow: 4096, reasoningEffort: '', thinking: false},
                ]},
            ],
            retryMax: 2,
            outputLanguage: 'zh',
        }),
        resolveModel: (ref) => {
            const entry = ref.endsWith('m1')
                ? {id: 'm1', model: 'big', contextWindow: overrides.window || 100000, outputWindow: 4096}
                : {id: 'm2', model: 'big2', contextWindow: overrides.window || 100000, outputWindow: 4096};
            return {account: {}, entry, profileCfg: {provider: 'openai', model: entry.model, baseURL: '', apiKey: '', temperature: 0, maxTokens: 4096, proxy: '', extraHeaders: {}, thinking: false, thinkingBudget: 8000, reasoningEffort: '', rpmLimit: 0}, label: entry.model};
        },
        flash: () => {},
        getWorkspace: () => '',
    });
    return {runtime, agents};
}

async function makeGroup(runtime, overrides = {}) {
    const result = await runtime.createGroup({
        title: '评审',
        topic: '存储方案',
        goal: 'decide',
        memberIds: ['a1', 'a2'],
        chair: {kind: 'user'},
        maxRounds: 2,
        timeoutPreset: 'standard',
        ...overrides,
    });
    assert.equal(result.ok, true, '群创建失败：' + (result.error || ''));
    return result.id;
}

// 落盘是异步链（persistSpeech → store.append → saveMeta）；断言前等微任务+定时器排空
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

test('创建 → 用户插话（自动唤醒轮换接话人）→ 流式 → 落盘 → 点名发言带焦点', async () => {
    const backend = makeBackend();
    const {runtime} = makeRuntime(backend);
    const groupId = await makeGroup(runtime);

    const userResult = await runtime.sendUserMessage(groupId, '讨论一下拆库的利弊');
    assert.equal(userResult.ok, true);
    let g = runtime.groupById(groupId);
    assert.equal(g.messages.length, 1);
    assert.equal(g.messages[0].role, 'user');

    // 消息即唤醒：无 @ → 轮换接话人（第一条落到 a1）自动发言；请求形状：system 在首、user 尾巴收尾
    assert.equal(await waitFor(() => backend.sent.length >= 1), true, '插话应自动唤醒接话人');
    const req = backend.sent[0];
    assert.ok(req.roundId.startsWith(groupId + '#a1'));
    assert.equal(req.messages[0].role, 'system');
    assert.match(req.messages[0].content, /<participants>/);
    assert.equal(req.messages[req.messages.length - 1].role, 'user');
    assert.match(req.messages[req.messages.length - 1].content, /轮到你（架构师）发言/);
    assert.equal(req.tools.length, 0);
    assert.equal(req.retryMax, 2);
    // 用户消息以 [用户] 前缀进对话
    const userTurn = req.messages.find((m) => m.role === 'user' && m.content.includes('拆库的利弊'));
    assert.ok(userTurn);
    assert.match(userTurn.content, /^\[用户\]/);

    // 流事件：chunk → done（落盘）
    const autoRoundId = req.roundId;
    runtime.handleEvent('ai-chunk', {id: autoRoundId, delta: '我'});
    runtime.handleEvent('ai-chunk', {id: autoRoundId, delta: '同意拆库'});
    runtime.handleEvent('ai-think', {id: autoRoundId, delta: '思考'});
    runtime.handleEvent('ai-done', {id: autoRoundId, finishReason: 'stop', usage: {promptTokens: 100, completionTokens: 10, totalTokens: 110}});
    await settle();

    g = runtime.groupById(groupId);
    assert.equal(g.messages.length, 2);
    const msg = g.messages[1];
    assert.equal(msg.role, 'assistant');
    assert.equal(msg.agentName, '架构师');
    assert.equal(msg.content, '我同意拆库');
    assert.equal(msg.status, 'done');
    assert.equal(msg.hasPrivate, true);
    assert.ok(msg.timing.ttftMs >= 0);
    assert.equal(msg.usage.totalTokens, 110);
    // 私有日志落了 thinking
    const priv = await runtime.store.privateRead(groupId, 'a1');
    assert.match(priv, /"kind":"thinking"/);
    // 流结束
    assert.equal(runtime.activeStreamOf(groupId), null);

    // 指定成员发言（请发言路径）：<chair_focus> 焦点段进系统提示
    const speak = await runtime.speak(groupId, 'a2', {focus: '回应拆库成本'});
    assert.equal(speak.ok, true, speak.error);
    const req2 = backend.sent[1];
    assert.match(req2.messages[0].content, /<chair_focus>/);
    assert.match(req2.messages[0].content, /回应拆库成本/);
    runtime.handleEvent('ai-done', {id: speak.roundId, finishReason: 'stop'});
    await settle();
});

test('超时：等待期内无输出 → AIStop → stopped 归一 timeout', async () => {
    const backend = makeBackend();
    // 极小超时便于单测触发真实计时器
    const {runtime} = makeRuntime(backend);
    const groupId = await makeGroup(runtime, {timeoutPreset: undefined});
    // 手写 meta 超时：绕过 preset（直接改 meta 落盘值）
    const g = runtime.groupById(groupId);
    g.meta.timeouts = {...g.meta.timeouts, memberFirstActivityMs: 30, memberTotalMs: 60, memberThinkingTotalMs: 60};
    const speak = await runtime.speak(groupId, 'a1', {});
    assert.equal(speak.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.ok(backend.stops.includes(speak.roundId), '超时未触发 AIStop');
    runtime.handleEvent('ai-done', {id: speak.roundId, finishReason: 'stopped'});
    await settle();
    const msg = runtime.groupById(groupId).messages.find((m) => m.role === 'assistant');
    assert.equal(msg.status, 'timeout');
    assert.equal(msg.timeout, true);
    assert.equal(runtime.activeStreamOf(groupId), null);
});

test('上下文门禁：共享对话装不下 → 不发请求 + 系统事件', async () => {
    const backend = makeBackend();
    const {runtime} = makeRuntime(backend, {window: 4096}); // 输出预留后预算极小
    const groupId = await makeGroup(runtime);
    for (let i = 0; i < 5; i++) {
        await runtime.sendUserMessage(groupId, '长'.repeat(2000));
    }
    const speak = await runtime.speak(groupId, 'a1', {});
    assert.equal(speak.ok, false);
    assert.match(speak.error, /上下文不足/);
    assert.equal(backend.sent.length, 0);
    const g = runtime.groupById(groupId);
    const overflowEvent = g.events.find((e) => e.type === 'context-overflow');
    assert.ok(overflowEvent);
});

test('串行互斥：发言中不能再次发言；停止走群级前缀', async () => {
    const backend = makeBackend();
    const {runtime} = makeRuntime(backend);
    const groupId = await makeGroup(runtime);
    const speak = await runtime.speak(groupId, 'a1', {});
    assert.equal(speak.ok, true);
    const second = await runtime.speak(groupId, 'a2', {});
    assert.equal(second.ok, false);
    assert.match(second.error, /正在发言/);
    runtime.stopAll(groupId);
    assert.ok(backend.stops.includes(groupId), '群级停止应使用裸 groupId（前缀匹配）');
    runtime.handleEvent('ai-error', {id: speak.roundId, message: '网络中断'});
    await settle();
    const msg = runtime.groupById(groupId).messages.find((m) => m.role === 'assistant');
    assert.equal(msg.status, 'error');
    assert.match(msg.error, /网络中断/);
});

test('未知 roundId 的事件被忽略（不污染面板路由）', () => {
    const backend = makeBackend();
    const {runtime} = makeRuntime(backend);
    runtime.handleEvent('ai-chunk', {id: 'session-other#round-1', delta: 'x'});
    assert.equal(backend.sent.length, 0);
});


test('成员工具轮（G5）：finishReason=tool → 执行只读工具 → 同 roundId 续发 → 最终发言落盘 + 私有工具步骤', async () => {
    const backend = makeBackend();
    const toolCalls = [];
    const runtime0 = makeRuntime(backend);
    // 先建群（要 workspace 非空才有工具）：makeRuntime 不注入 workspace，重创带 getWorkspace 的运行时
    const agents = runtime0.agents;
    const runtime = createAIGroupRuntime({
        backend,
        getAIConfig: () => ({
            agents,
            profiles: [{id: 'p1', name: '账号', provider: 'openai', models: [
                {id: 'm1', model: 'big', contextWindow: 100000, outputWindow: 4096, reasoningEffort: '', thinking: false},
            ]}],
            retryMax: 2,
            outputLanguage: 'zh',
        }),
        resolveModel: (ref) => {
            const entry = {id: 'm1', model: 'big', contextWindow: 100000, outputWindow: 4096};
            return {account: {}, entry, profileCfg: {provider: 'openai', model: 'big', baseURL: '', apiKey: '', temperature: 0, maxTokens: 4096, proxy: '', extraHeaders: {}, thinking: false, thinkingBudget: 8000, reasoningEffort: '', rpmLimit: 0}, label: 'big'};
        },
        flash: () => {},
        getWorkspace: () => 'D:/novel',
        execMemberTool: async (name, argsJson, workspace) => {
            toolCalls.push({name, argsJson, workspace});
            assert.equal(name, 'read_file');
            assert.equal(JSON.parse(argsJson).path, '第0001章-引言.md');
            assert.equal(workspace, 'D:/novel');
            return '文件：第0001章-引言.md（1200 字节）\n\n第一章正文…';
        },
    });
    await runtime.init();
    const gid = await makeGroup(runtime);
    const r = await runtime.speak(gid, 'a1', {});
    assert.equal(r.ok, true);
    // 第一轮请求：带 4 个只读工具 + member_tools 系统段
    assert.ok(backend.sent.length >= 1);
    const first = backend.sent[0];
    assert.deepEqual(first.tools.map((t) => t.name), ['read_file', 'list_dir', 'search_text', 'glob']);
    const firstSystem = first.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    assert.ok(firstSystem.includes('<member_tools>'), '系统段缺 member_tools 说明');
    // 模型返回 tool 调用：ai-toolcall 聚合 + ai-done finishReason=tool
    runtime.handleEvent('ai-toolcall', {id: first.roundId, index: 0, callId: 'call_1', name: 'read_file', argsDelta: '{"path": "第000'});
    runtime.handleEvent('ai-toolcall', {id: first.roundId, index: 0, argsDelta: '1章-引言.md"}'});
    runtime.handleEvent('ai-done', {id: first.roundId, finishReason: 'tool', usage: {totalTokens: 500}});
    // 续发请求：同 roundId，末尾是 assistant(toolCalls) + tool 结果
    assert.ok(await waitFor(() => backend.sent.length >= 2));
    const second = backend.sent[1];
    assert.equal(second.roundId, first.roundId);
    const lastTwo = second.messages.slice(-2);
    assert.equal(lastTwo[0].role, 'assistant');
    assert.equal(lastTwo[0].toolCalls[0].id, 'call_1');
    assert.equal(lastTwo[1].role, 'tool');
    assert.equal(lastTwo[1].toolCallId, 'call_1');
    assert.ok(lastTwo[1].content.includes('第一章正文'));
    // 最终发言
    runtime.handleEvent('ai-chunk', {id: first.roundId, delta: '读完了第一章，钩子很稳。'});
    runtime.handleEvent('ai-done', {id: first.roundId, finishReason: 'stop', usage: {totalTokens: 300}});
    const result = await r.done;
    assert.equal(result.status, 'done');
    assert.equal(result.content, '读完了第一章，钩子很稳。');
    // usage 累计（500 + 300）
    assert.equal(result.usage.totalTokens, 800);
    await settle(30);
    const g = runtime.groupById(gid);
    assert.equal(g.messages[g.messages.length - 1].content, '读完了第一章，钩子很稳。');
    assert.equal(g.messages[g.messages.length - 1].hasPrivate, true);
    const privText = backend.groups.get(gid).priv['a1'];
    assert.ok(privText.includes('"kind": "tool"') || privText.includes('"kind":"tool"'), '私有日志缺工具步骤');
    assert.ok(privText.includes('tools:'), '私有工具条目缺 tools: gid 前缀');
    // 后续轮水合：新发言的请求里出现工具备注
    const r2 = await runtime.speak(gid, 'a1', {});
    assert.equal(r2.ok, true);
    const third = backend.sent[backend.sent.length - 1];
    const noteMsg = third.messages.find((m) => m.role === 'user' && String(m.content).includes('你这条发言前调用了只读工具'));
    assert.ok(noteMsg, '后续轮缺工具备注水合');
    assert.ok(noteMsg.content.includes('read_file：第0001章-引言.md'));
    runtime.handleEvent('ai-chunk', {id: r2.roundId, delta: '补充。'});
    runtime.handleEvent('ai-done', {id: r2.roundId, finishReason: 'stop'});
    await r2.done;
});

test('成员工具轮上限：4 轮后不再下发工具并给收敛提示；工具结果照常配对', async () => {
    const backend = makeBackend();
    let execCount = 0;
    const agents = [
        {id: 'a1', name: '架构师', color: 'blue', role: '', modelRef: 'p1|m1', personaText: '', chair: false, enabled: true},
        {id: 'a2', name: '审查员', color: 'red', role: '', modelRef: 'p1|m1', personaText: '', chair: false, enabled: true},
    ];
    const runtime = createAIGroupRuntime({
        backend,
        getAIConfig: () => ({
            agents,
            profiles: [{id: 'p1', name: '账号', provider: 'openai', models: [
                {id: 'm1', model: 'big', contextWindow: 100000, outputWindow: 4096, reasoningEffort: '', thinking: false},
            ]}],
            retryMax: 2,
            outputLanguage: 'zh',
        }),
        resolveModel: () => ({account: {}, entry: {id: 'm1', model: 'big', contextWindow: 100000, outputWindow: 4096}, profileCfg: {provider: 'openai', model: 'big', baseURL: '', apiKey: '', temperature: 0, maxTokens: 4096, proxy: '', extraHeaders: {}, thinking: false, thinkingBudget: 8000, reasoningEffort: '', rpmLimit: 0}, label: 'big'}),
        flash: () => {},
        getWorkspace: () => 'D:/novel',
        execMemberTool: async () => {
            execCount++;
            return '文件内容…';
        },
    });
    await runtime.init();
    const gid = await makeGroup(runtime);
    const r = await runtime.speak(gid, 'a1', {});
    assert.equal(r.ok, true);
    // 连续 5 次「模型要工具」：第 5 轮起不下发工具，请求里带收敛提示
    for (let i = 0; i < 5; i++) {
        const sentCount = backend.sent.length;
        runtime.handleEvent('ai-toolcall', {id: r.roundId, index: 0, callId: 'call_' + i, name: 'read_file', argsDelta: '{"path": "a.md"}'});
        runtime.handleEvent('ai-done', {id: r.roundId, finishReason: 'tool'});
        await waitFor(() => backend.sent.length > sentCount);
    }
    const last = backend.sent[backend.sent.length - 1];
    assert.deepEqual(last.tools, []);
    const nudge = last.messages.find((m) => m.role === 'user' && String(m.content).includes('工具调用轮次已用尽'));
    assert.ok(nudge, '缺收敛提示');
    assert.ok(execCount >= 4, '前 4 轮应真实执行过工具：' + execCount);
    // 收尾
    runtime.handleEvent('ai-chunk', {id: r.roundId, delta: '结论。'});
    runtime.handleEvent('ai-done', {id: r.roundId, finishReason: 'stop'});
    const result = await r.done;
    assert.equal(result.status, 'done');
});

test('无执行体 / 主持人返回工具调用 → 按错误归档（防悬空）', async () => {
    const backend = makeBackend();
    const {runtime} = makeRuntime(backend); // 未注入 execMemberTool → 成员不下发工具
    await runtime.init();
    const gid = await makeGroup(runtime);
    const r = await runtime.speak(gid, 'a1', {});
    assert.equal(r.ok, true);
    assert.deepEqual(backend.sent[0].tools, [], '无执行体时不应下发工具');
    runtime.handleEvent('ai-toolcall', {id: r.roundId, index: 0, callId: 'c1', name: 'read_file', argsDelta: '{}'});
    runtime.handleEvent('ai-done', {id: r.roundId, finishReason: 'tool'});
    const result = await r.done;
    assert.equal(result.status, 'error');
    assert.ok(result.error.includes('不支持工具调用'));
    await settle(20);
});
