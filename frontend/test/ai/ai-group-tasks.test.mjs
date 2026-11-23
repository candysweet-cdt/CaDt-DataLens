// ai-group-tasks.test.mjs：G4 护栏——角色预设（§1.4）、任务模式主持人指令、任务板增改
// （§1.2）、纪要润色/导出/带回（§3.8）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAIGroupRuntime} from '../../src/ai/group/ai-group-runtime.js';
import {buildChairMessages, buildMemberMessages, normalizeGroupMeta} from '../../src/ai/group/ai-group-model.js';

async function settle(ms = 40) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

function makeBackend() {
    const groups = new Map();
    const sent = [];
    const handlers = [];
    const saveDialogs = [];
    const savedFiles = [];
    const handlers2 = [];
    let handler = null;
    const backend = {
        groups,
        sent,
        handlers,
        setHandler: (fn) => {
            handler = fn;
        },
        emit: (name, payload) => {
            for (const fn of handlers2) fn(name, payload);
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
            sent.push({roundId, cfg, messages});
            if (handler) await handler(roundId, messages, backend.emit);
            return null;
        },
        AIStop: () => {},
        SaveFileDialog: async (name) => {
            saveDialogs.push(name);
            return saveDialogs.length === 2 ? '' : 'D:/mock/' + name + '.md';
        },
        SaveFile: async (path, content) => {
            savedFiles.push({path, content});
        },
    };
    backend.handlers2 = handlers2;
    backend.savedFiles = savedFiles;
    backend.saveDialogs = saveDialogs;
    return backend;
}

const AGENTS = [
    {id: 'a1', name: '架构师', color: 'blue', role: '设计', modelRef: 'p1|m1', personaText: '', chair: false, enabled: true},
    {id: 'a2', name: '审查员', color: 'red', role: '审查', modelRef: 'p1|m2', personaText: '', chair: false, enabled: true},
    {id: 'a3', name: '主持人', color: 'violet', role: '主持', modelRef: 'p1|m1', personaText: '', chair: true, enabled: true},
];

function makeRuntime(backend, extra = {}) {
    const runtime = createAIGroupRuntime({
        backend,
        getAIConfig: () => ({
            agents: AGENTS,
            profiles: [{id: 'p1', models: [
                {id: 'm1', model: 'big', contextWindow: 100000, outputWindow: 4096, reasoningEffort: '', thinking: false},
                {id: 'm2', model: 'big2', contextWindow: 100000, outputWindow: 4096, reasoningEffort: '', thinking: false},
            ]}],
            retryMax: 2,
            outputLanguage: 'zh',
        }),
        resolveModel: (ref) => {
            const entry = {id: ref.slice(-2), model: 'x', contextWindow: 100000, outputWindow: 4096};
            return {account: {}, entry, profileCfg: {provider: 'openai', model: 'x'}, label: 'x'};
        },
        flash: () => {},
        getWorkspace: () => '',
        deliverToSessions: extra.deliverToSessions || null,
        getCurrentSessionId: extra.getCurrentSessionId || (() => ''),
    });
    backend.handlers2.push((name, payload) => runtime.handleEvent(name, payload));
    return runtime;
}

async function makeGroup(runtime, overrides = {}) {
    const result = await runtime.createGroup({
        title: '协作',
        topic: '把功能拆成任务',
        goal: 'plan',
        memberIds: ['a1', 'a2'],
        maxRounds: 2,
        timeoutPreset: 'standard',
        ...overrides,
    });
    assert.equal(result.ok, true, '群创建失败：' + (result.error || ''));
    return result.id;
}

test('model：roles 归一化（非法丢弃、长度钳制）与角色段注入', () => {
    const meta = normalizeGroupMeta({roles: {a1: '正方', a2: ['', '  '], a3: 'x'.repeat(100)}});
    assert.deepEqual(meta.roles, {a1: '正方', a3: 'x'.repeat(80)});
    const member = {id: 'a1', name: '架构师', role: '设计'};
    const built = buildMemberMessages({
        member,
        group: meta,
        sharedMessages: [],
        ownSteps: [],
        participantsText: '',
        boardText: '',
        focus: '',
        outputLanguage: 'zh',
        memberWindow: 100000,
    });
    assert.match(built.messages[0].content, /<agent_role>\n你在这场讨论中的角色：正方/);
    const noRole = normalizeGroupMeta({});
    const built2 = buildMemberMessages({
        member, group: noRole, sharedMessages: [], ownSteps: [], participantsText: '', boardText: '', focus: '', outputLanguage: 'zh', memberWindow: 100000,
    });
    assert.ok(!built2.messages[0].content.includes('<agent_role>'));
});

test('model：任务模式主持人指令（拆任务板 / blocked 语义）', () => {
    const taskMeta = normalizeGroupMeta({mode: 'task', title: '协作'});
    const opening = buildChairMessages({
        chairAgent: AGENTS[2],
        meta: taskMeta,
        sharedMessages: [],
        chairSteps: [],
        kind: 'opening',
        outputLanguage: 'zh',
        memberWindow: 100000,
    });
    assert.match(opening.messages[0].content + opening.messages[opening.messages.length - 1].content, /任务板/);
    const review = buildChairMessages({
        chairAgent: AGENTS[2],
        meta: taskMeta,
        sharedMessages: [],
        chairSteps: [],
        kind: 'review',
        outputLanguage: 'zh',
        memberWindow: 100000,
    });
    assert.match(review.messages[review.messages.length - 1].content, /blocked/);
    // 圆桌模式不出现任务指令
    const plain = normalizeGroupMeta({title: '评审'});
    const openingPlain = buildChairMessages({
        chairAgent: AGENTS[2],
        meta: plain,
        sharedMessages: [],
        chairSteps: [],
        kind: 'opening',
        outputLanguage: 'zh',
        memberWindow: 100000,
    });
    assert.ok(!openingPlain.messages[openingPlain.messages.length - 1].content.includes('任务板'));
});

test('runtime：任务板增改（状态流转 + 系统事件）', async () => {
    const backend = makeBackend();
    const runtime = makeRuntime(backend);
    const groupId = await makeGroup(runtime, {mode: 'task'});
    const add = await runtime.addActionItem(groupId, '补存储清理条目', 'a2');
    assert.equal(add.ok, true);
    let g = runtime.groupById(groupId);
    assert.equal(g.meta.discussion.actionItems.length, 1);
    const item = g.meta.discussion.actionItems[0];
    assert.equal(item.status, 'todo');
    assert.ok(g.events.some((e) => e.type === 'task-update' && e.text.includes('新增任务')));
    const update = await runtime.updateActionItem(groupId, item.id, {status: 'doing'});
    assert.equal(update.ok, true);
    g = runtime.groupById(groupId);
    assert.equal(g.meta.discussion.actionItems[0].status, 'doing');
    assert.ok(g.events.some((e) => e.type === 'task-update' && e.text.includes('状态 → doing')));
    assert.match(await runtime.updateActionItem(groupId, 'ghost', {status: 'done'}).then((r) => r.error || ''), /任务不存在/);
});

test('runtime：纪要导出（SaveFileDialog + SaveFile）；用户取消不落盘', async () => {
    const backend = makeBackend();
    const runtime = makeRuntime(backend);
    const groupId = await makeGroup(runtime, {chair: {kind: 'ai', agentId: 'a3'}});
    const none = await runtime.exportMinutes(groupId);
    assert.equal(none.ok, false);
    assert.match(none.error, /还没有本场纪要/);
    // 手写一份纪要进 meta（绕过讨论循环）
    await runtime.saveMeta(groupId, (meta) => {
        meta.minutes = {text: '# 群聊纪要\n- 结论', createdAt: Date.now(), source: 'board'};
    });
    const ok = await runtime.exportMinutes(groupId);
    assert.equal(ok.ok, true);
    assert.equal(backend.savedFiles.length, 1);
    assert.match(backend.savedFiles[0].path, /协作\.md$/);
    assert.match(backend.savedFiles[0].content, /群聊纪要/);
    const canceled = await runtime.exportMinutes(groupId);
    assert.equal(canceled.ok, false);
    assert.equal(canceled.canceled, true);
});

test('runtime：纪要带回当前会话（走信箱；无会话时报错）', async () => {
    const backend = makeBackend();
    const delivered = [];
    let currentSession = 'sess-current';
    const runtime = makeRuntime(backend, {
        deliverToSessions: async (ids, text, opts) => {
            delivered.push({ids, text, opts});
            return {results: [{targetSessionId: ids[0], ok: true}], okCount: 1};
        },
        getCurrentSessionId: () => currentSession,
    });
    const groupId = await makeGroup(runtime, {chair: {kind: 'ai', agentId: 'a3'}});
    const missing = await runtime.bringMinutesBack(groupId);
    assert.equal(missing.ok, false);
    await runtime.saveMeta(groupId, (meta) => {
        meta.minutes = {text: '纪要正文', createdAt: Date.now(), source: 'board'};
    });
    const ok = await runtime.bringMinutesBack(groupId);
    assert.equal(ok.ok, true);
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0].ids, ['sess-current']);
    assert.match(delivered[0].text, /【群聊纪要/);
    // 无会话
    currentSession = '';
    const noSession = await runtime.bringMinutesBack(groupId);
    assert.equal(noSession.ok, false);
    assert.match(noSession.error, /没有打开的 AI 会话/);
});

test('runtime：任务模式创建落盘 mode/roles；圆桌群不受影响', async () => {
    const backend = makeBackend();
    const runtime = makeRuntime(backend);
    const taskGroup = await makeGroup(runtime, {mode: 'task', roles: {a1: '前端负责人'}});
    assert.equal(runtime.groupById(taskGroup).meta.mode, 'task');
    assert.equal(runtime.groupById(taskGroup).meta.roles.a1, '前端负责人');
    const plainGroup = await makeGroup(runtime);
    assert.equal(runtime.groupById(plainGroup).meta.mode, 'roundtable');
    assert.deepEqual(runtime.groupById(plainGroup).meta.roles, {});
});
