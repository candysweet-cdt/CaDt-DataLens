// session-mid-collision.test.mjs：重复 mid 不许再卡死落盘前缀（2026-11-28 事故护栏）。
// 事故链：两条消息共用一个 mid → mid 键指纹表里永远只剩后一条的指纹 → persist 的公共
// 前缀在第一条上永假 → 每次落盘都 truncate + 整段重追加，追加式日志无界膨胀（300 MB）。
// 四层防线各自有测试钉住：
//   1. dedupeMessageMids：载入自愈，重复 mid 改配新 mid，消息一条不丢；
//   2. hydrate 接线：载入路径真的跑了自愈并标记 _needsRewrite（物理收敛）；
//   3. persist 收敛：重复 mid 的会话第一次落盘截断重追加，第二次必须零事件（循环已死）；
//   4. 就地改写回归：位置键指纹仍能在消息被就地改写时截断重追加（原有语义不回退）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {createSessionDiskStore} from '../../../src/ai/session/ai-session-disk.js';
import {
    dedupeMessageMids,
    encodeMessageEvent,
    encodeSessionHeader,
    encodeSessionLines,
    messageFingerprint,
    replaySessionLog,
} from '../../../src/ai/session/ai-session-store.js';

function makeBackend(logText) {
    const calls = {append: [], rewrite: []};
    return {
        calls,
        AISessionList: async () => [],
        AISessionRead: async () => logText,
        AISessionWriteMeta: async () => {},
        AISessionAppend: async (id, lines) => { calls.append.push(lines); },
        AISessionRewrite: async (id, lines) => { calls.rewrite.push(lines); },
        AISessionDelete: async () => {},
        AISessionStat: async () => ({exists: true, mtimeMs: 1, size: 2}),
    };
}

// 模拟载入时的指纹基线（与 ai-session-disk.js resetFingerprints 同构，位置键）
function resetFps(session) {
    const fps = new Map();
    (session.messages || []).forEach((message, i) => fps.set(i, messageFingerprint(message)));
    session._fps = fps;
}

function logWithDuplicateMid() {
    const events = [encodeSessionHeader({id: 's1', title: 'T', workspace: 'D:/w', createdAt: 1000})];
    events.push(encodeMessageEvent({role: 'user', content: 'a', ts: 1}, 'm-dup', false));
    // 与事故同构：同一 mid 两条不同内容的记录先后落盘（就地改写重追加的物理形态）
    events.push(encodeMessageEvent({role: 'tool', content: '占位', ts: 2, status: 'error'}, 'm-dup', false));
    events.push(encodeMessageEvent({role: 'tool', content: '完成回报', ts: 2, status: 'done'}, 'm-dup', false));
    events.push(encodeMessageEvent({role: 'user', content: 'b', ts: 3}, 'm-ok', false));
    return encodeSessionLines(events);
}

test('dedupeMessageMids：重复 mid 改配新 mid，先到先得，消息一条不丢', () => {
    const messages = [
        {role: 'user', content: 'a', _mid: 'm-x'},
        {role: 'tool', content: '占位', _mid: 'm-x'},
        {role: 'tool', content: '回报', _mid: 'm-x'},
        {role: 'user', content: 'b', _mid: 'm-y'},
    ];
    let freshSeq = 0;
    const healed = dedupeMessageMids(messages, () => 'm-fresh' + (++freshSeq));
    assert.equal(healed, 2);
    assert.equal(messages[0]._mid, 'm-x', '首条持有者不动');
    assert.equal(messages[1]._mid, 'm-fresh1');
    assert.equal(messages[2]._mid, 'm-fresh2');
    assert.notEqual(messages[1]._mid, messages[2]._mid, '两条重复各自拿独立新 mid');
    assert.equal(messages[3]._mid, 'm-y', '未重复的不动');
    assert.equal(messages[1].content, '占位', '只动 _mid，不动内容');
});

test('dedupeMessageMids：无重复返回 0，mid 缺失视为待分配也计入', () => {
    assert.equal(dedupeMessageMids([{role: 'user', _mid: 'm-1'}, {role: 'user', _mid: 'm-2'}], () => 'm-n'), 0);
    const messages = [{role: 'user', _mid: 'm-1'}, {role: 'user'}];
    assert.equal(dedupeMessageMids(messages, () => 'm-n'), 1);
    assert.equal(messages[1]._mid, 'm-n');
    assert.equal(dedupeMessageMids(null, () => 'm-n'), 0);
});

test('hydrateSession 载入即自愈：重复 mid 被改配，并标记 _needsRewrite 物理收敛', async () => {
    const backend = makeBackend(logWithDuplicateMid());
    const store = createSessionDiskStore({backend});
    const session = {
        id: 's1', title: 'T', workspace: 'D:/w',
        messages: [], archived: [], _stub: true,
    };
    const ok = await store.hydrateSession(session);
    assert.equal(ok, true);
    const mids = session.messages.map((m) => m._mid);
    assert.equal(new Set(mids).size, mids.length, '载入后 mid 必须两两不同');
    assert.equal(session.messages.length, 4, '消息一条不丢');
    assert.equal(session._needsRewrite, true, '重复 mid 必须标记整份重写，物理清掉磁盘复印行');
    // 干净日志不标记重写（不误伤）
    const backend2 = makeBackend(encodeSessionLines([
        encodeSessionHeader({id: 's2', title: 'T', workspace: 'D:/w', createdAt: 1000}),
        encodeMessageEvent({role: 'user', content: 'a', ts: 1}, 'm-1', false),
        encodeMessageEvent({role: 'user', content: 'b', ts: 2}, 'm-2', false),
    ]));
    const store2 = createSessionDiskStore({backend: backend2});
    const session2 = {id: 's2', title: 'T', workspace: 'D:/w', messages: [], archived: [], _stub: true};
    assert.equal(await store2.hydrateSession(session2), true);
    assert.equal(session2._needsRewrite, false);
});

test('persist 收敛：重复 mid 会话第一次落盘截断重追加，第二次零事件（循环已死）', async () => {
    // 事故形态直接复现：内存里两条消息共用 mid，账本 _mids 也各留同 mid（载入后的状态）
    const session = {
        id: 's1', title: 'T', workspace: 'D:/w',
        messages: [
            {role: 'user', content: 'a', ts: 1, _mid: 'm-dup'},
            {role: 'tool', content: '占位', ts: 2, _mid: 'm-dup'},
            {role: 'tool', content: '回报', ts: 2, _mid: 'm-dup'},
            {role: 'user', content: 'b', ts: 3, _mid: 'm-ok'},
        ],
        archived: [],
        _mids: ['m-dup', 'm-dup', 'm-dup', 'm-ok'],
        _archivedMids: [],
        _fps: new Map(),
        _logCreated: true,
        _logMeta: {title: 'T', workspace: 'D:/w'},
    };
    const backend = makeBackend('');
    const store = createSessionDiskStore({backend});
    await store.persistSession(session);
    assert.ok(backend.calls.append.length >= 1, '第一次落盘必须有事件');
    const firstEvents = backend.calls.append.join('\n');
    assert.match(firstEvents, /"t":"truncate"/, '第一次必须截断重追加（旧账本状态与新指纹不一致）');
    // Fix D：追加段的占用检查把重复 mid 改配成新 mid
    const replayed = replaySessionLog(firstEvents);
    const liveMids = replayed.messages.map((m) => m._mid);
    assert.equal(new Set(liveMids).size, liveMids.length, '重追加后 mid 必须唯一');
    // Fix B：位置键指纹让前缀真正通过——第二次落盘必须零事件，不再无限 truncate
    await store.persistSession(session);
    const secondLen = backend.calls.append.slice(1).join('\n');
    assert.doesNotMatch(secondLen, /"t":"truncate"/, '第二次落盘不许再截断（事故死循环回归线）');
    assert.equal(secondLen.trim(), '', '第二次落盘应无任何追加事件');
});

test('persist 回归：就地改写的消息仍会在它的位置截断重追加（位置键不丢原语义）', async () => {
    const session = {
        id: 's1', title: 'T', workspace: 'D:/w',
        messages: [
            {role: 'user', content: 'a', ts: 1, _mid: 'm-1'},
            {role: 'tool', content: '', ts: 2, _mid: 'm-2', status: 'running'},
            {role: 'user', content: 'b', ts: 3, _mid: 'm-3'},
        ],
        archived: [],
        _mids: ['m-1', 'm-2', 'm-3'],
        _archivedMids: [],
        _fps: new Map(),
        _logCreated: true,
        _logMeta: {title: 'T', workspace: 'D:/w'},
    };
    const backend = makeBackend('');
    const store = createSessionDiskStore({backend});
    // 建立指纹基线：第一次落盘无事件（与账本一致）
    resetFps(session);
    await store.persistSession(session);
    assert.equal(backend.calls.append.join('\n').trim(), '', '基线一致时首落盘零事件');
    // 就地改写 running → done：下一次落盘必须只在 index 1 截断
    session.messages[1].status = 'done';
    session.messages[1].content = '完成';
    await store.persistSession(session);
    const events = backend.calls.append.join('\n');
    assert.match(events, /"t":"truncate","keep":1/, '必须在被改写的消息处截断');
    // 增量批次单独重放：truncate(1) 作用在空数组上被钳到 0，得到的是本次重追加的 2 条
    const replayed = replaySessionLog(events);
    assert.equal(replayed.messages.length, 2);
    assert.equal(replayed.messages[0].content, '完成');
    // 收敛：再落一次零事件
    await store.persistSession(session);
    assert.equal(backend.calls.append.slice(1).join('\n').trim(), '');
});

test('persist：syncMids 整份重写路径同样做 mid 占用检查', async () => {
    const session = {
        id: 's1', title: 'T', workspace: 'D:/w',
        messages: [
            {role: 'user', content: 'a', ts: 1, _mid: 'm-x'},
            {role: 'tool', content: '占位', ts: 2, _mid: 'm-x'},
        ],
        archived: [],
        _mids: [],
        _archivedMids: [],
        _fps: new Map(),
        _logCreated: true,
        _logMeta: {title: 'T', workspace: 'D:/w'},
        _needsRewrite: true,
    };
    const backend = makeBackend('');
    const store = createSessionDiskStore({backend});
    await store.persistSession(session);
    assert.ok(backend.calls.rewrite.length >= 1, '_needsRewrite 必须走整份重写');
    const replayed = replaySessionLog(backend.calls.rewrite.join('\n'));
    const mids = replayed.messages.map((m) => m._mid);
    assert.equal(new Set(mids).size, mids.length, '重写后 mid 必须唯一');
    assert.equal(replayed.messages.length, 2, '消息一条不丢');
});

test('位置键指纹与 messageFingerprint 口径一致：同一条消息基线前后指纹不变', () => {
    const message = {role: 'tool', content: 'x', ts: 1, status: 'done', _mid: 'm-1'};
    assert.equal(messageFingerprint(message), messageFingerprint({...message}));
    const mutated = {...message, status: 'error'};
    assert.notEqual(messageFingerprint(message), messageFingerprint(mutated));
});
