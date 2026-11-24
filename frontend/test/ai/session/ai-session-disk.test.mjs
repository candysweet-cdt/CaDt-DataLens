// ai-session-disk.test.mjs：懒加载会话的不变量。
// 这一层的错误是「不可逆」的（用空正文重写 3MB 历史），所以护栏必须有测试盯着：
//   1. 占位会话（只有 meta）写盘只能写 meta，绝不触发日志 append / rewrite；
//   2. 占位的 messageCount / turnTs 必须沿用 meta 缓存值，否则会把 0 写回 meta.json；
//   3. 归档 / 清空 / 整份重写三个入口拒绝占位；
//   4. hydrateSession 就地补正文，引用不变、占位标记清干净、条数回到现算。
import test from 'node:test';
import assert from 'node:assert/strict';

import {createSessionDiskStore, createAIConversationLog} from '../../../src/ai/session/ai-session-disk.js';
import {
    buildSessionMeta,
    encodeMessageEvent,
    encodeSessionHeader,
    encodeSessionLines,
    metaSignature,
} from '../../../src/ai/session/ai-session-store.js';

// 正文与 meta 必须同源：logOf 写的消息形状，meta 的 messageCount / turnTs 就得算出同一个值，
// 否则「补水后签名不该误判成 meta 变了」这条不变量会被假数据自己打破。
function msgsOf(count) {
    return new Array(count).fill(0).map((unused, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: 'msg' + i,
        ts: 2000 + i,
    }));
}

function logOf(id, count) {
    const events = [encodeSessionHeader({id, title: 'T-' + id, workspace: 'D:/w', createdAt: 1000})];
    msgsOf(count).forEach((message, i) => {
        events.push(encodeMessageEvent(message, 'm-' + id + '-' + i, false));
    });
    return encodeSessionLines(events);
}

function makeStore(counts) {
    const metas = Object.entries(counts).map(([id, count]) => buildSessionMeta({
        id,
        title: 'T-' + id,
        workspace: 'D:/w',
        createdAt: 1000,
        updatedAt: 3000,
        messages: msgsOf(count),
    }));
    const calls = {meta: [], append: 0, rewrite: 0, read: 0};
    const backend = {
        AISessionList: async () => metas.map((meta) => JSON.stringify(meta)),
        AISessionRead: async (id) => {
            calls.read++;
            return logOf(id, counts[id]);
        },
        AISessionWriteMeta: async (id, text) => { calls.meta.push({id, meta: JSON.parse(text)}); },
        AISessionAppend: async () => { calls.append++; },
        AISessionRewrite: async () => { calls.rewrite++; },
        AISessionDelete: async () => {},
    };
    const normalizeMessage = (raw) => (raw && raw.role
        ? {role: raw.role, content: String(raw.content || ''), ts: Number(raw.ts) || 0, _mid: raw._mid}
        : null);
    const store = createSessionDiskStore({backend, normalizeMessage});
    const normalizeSession = (raw) => ({...raw, messages: [], archived: []});
    return {store, calls, normalizeSession};
}

test('toStubs 只产占位、不读正文，条数来自 meta', async () => {
    const {store, calls, normalizeSession} = makeStore({a: 3, b: 5});
    const stubs = store.toStubs(await store.loadMetas(), normalizeSession);
    assert.equal(stubs.length, 2);
    assert.ok(stubs.every((session) => session._stub === true));
    assert.deepEqual(stubs.map((session) => session._msgCount), [3, 5]);
    // 排序键缓存：占位没有正文，列表的时间与顺序只能靠 meta 里的轮次起点
    assert.deepEqual(stubs.map((session) => session._turnTs), [2002, 2004]);
    assert.equal(calls.read, 0, '列表阶段不应该读任何正文');
});

test('占位写盘只写 meta：未改不写，改 unread 只写一次且条数不能变 0', async () => {
    const {store, calls, normalizeSession} = makeStore({a: 3});
    const stubs = store.toStubs(await store.loadMetas(), normalizeSession);

    await store.persistSession(stubs[0]);
    assert.equal(calls.meta.length, 0, '没改过的占位不该写 meta');

    stubs[0].unread = 'done';
    await store.persistSession(stubs[0]);
    assert.equal(calls.meta.length, 1);
    assert.equal(calls.meta[0].meta.unread, 'done');
    assert.equal(calls.meta[0].meta.messageCount, 3, '条数必须沿用占位缓存，不能写成 0');
    assert.equal(calls.meta[0].meta.turnTs, 2002, '轮次起点同理，不能写成 0');
    assert.equal(calls.append, 0, '占位绝不能追加日志');
    assert.equal(calls.rewrite, 0, '占位绝不能整份重写日志');
});

test('归档 / 清空 / 整份重写拒绝占位会话', async () => {
    const {store, normalizeSession} = makeStore({a: 3});
    const stubs = store.toStubs(await store.loadMetas(), normalizeSession);
    for (const call of [
        () => store.archiveSession(stubs[0], 1, null),
        () => store.resetSession(stubs[0]),
        () => store.rewriteSession(stubs[0]),
    ]) {
        assert.throws(call, /尚未加载/);
    }
});

test('hydrateSession 就地补正文：引用不变、标记清干净、条数回到现算', async () => {
    const {store, calls, normalizeSession} = makeStore({a: 3});
    const stubs = store.toStubs(await store.loadMetas(), normalizeSession);
    const stub = stubs[0];
    const ok = await store.hydrateSession(stub);
    assert.equal(ok, true);
    assert.equal(calls.read, 1);
    assert.equal(stub._stub, undefined, '补完不能还留着占位标记');
    assert.equal(stub.messages.length, 3);
    assert.equal(buildSessionMeta(stub).messageCount, 3);
    // 补完的指纹签名要按真实正文重算，否则下一次 persist 会误判「meta 变了」再写一遍
    assert.equal(stub._metaSig, metaSignature(buildSessionMeta(stub)));
    // 占位已清除 → 再 hydrate 是 no-op
    assert.equal(await store.hydrateSession(stub), true);
    assert.equal(calls.read, 1);
});

test('并发补水去重：同一会话同时 hydrate 只读一次正文', async () => {
    const {store, calls, normalizeSession} = makeStore({a: 3});
    const stubs = store.toStubs(await store.loadMetas(), normalizeSession);
    const stub = stubs[0];
    // 启动批量补水（hydrateSessions）与「渲染到占位就补水」的按需补水面是两条独立入口，
    // 会同时盯上同一个会话：两份整份 JSONL 重放对大文件是成倍 IO，后完成的那份还会
    // 覆盖先完成的写入基线（_logStat）。
    const [first, second] = await Promise.all([
        store.hydrateSession(stub),
        store.hydrateSession(stub),
    ]);
    assert.equal(first, true);
    assert.equal(second, true);
    assert.equal(calls.read, 1, '同一会话并发补水只能读一次正文');
    assert.equal(stub.messages.length, 3);
});

test('hydrateSession 与 reloadSession 互斥：同一会话不会并行整份重放', async () => {
    const {store, calls, normalizeSession} = makeStore({a: 3});
    const stubs = store.toStubs(await store.loadMetas(), normalizeSession);
    const stub = stubs[0];
    // 按需补水（ensureSessionLoaded）与另一窗口写入触发的整份重读（handleResourceChange）
    // 是两条独立入口：并行读同一会话会成倍 IO，后完成的还会用旧快照覆盖新内容与基线。
    const [hydrated, reloaded] = await Promise.all([
        store.hydrateSession(stub),
        store.reloadSession(stub),
    ]);
    assert.equal(hydrated, true);
    assert.equal(reloaded, true);
    assert.equal(calls.read, 2, '两次整份重放是串行执行，不会并行');
    assert.equal(stub.messages.length, 3);
});

test('requireBody 同时拒绝正文读取失败的会话（不能拿残缺内容覆盖真源）', async () => {
    const {store} = makeStore({a: 3});
    const broken = {id: 'a', title: 'a', messages: [], archived: [], _loadError: 'session-too-large: …'};
    assert.throws(() => store.resetSession(broken), /读取失败/);
    assert.throws(() => store.rewriteSession(broken), /读取失败/);
    assert.throws(() => store.archiveSession(broken, 0, null), /读取失败/);
});

test('对话日志：占位 / 正文读取失败的会话不写 md（SaveFile 整份覆盖会抹掉历史）', async () => {
    const saved = [];
    const log = createAIConversationLog({
        backend: {
            SaveFile: async (path, text) => { saved.push({path, text}); },
            SaveDataURL: async () => {},
            AIEnsureDir: async () => {},
        },
        getConfig: () => ({logEnabled: true, profiles: []}),
        ensureLogDir: async () => 'D:/logs',
        persistSessions: () => {},
        flash: () => {},
        notifyFailure: () => {},
        askStateLabel: () => '',
        askResultText: () => '',
        joinPath: (a, b) => a + '/' + b,
    });
    const stub = {id: 's1', title: 't', messages: [], archived: [], _stub: true};
    await log.saveConversationLog(stub);
    assert.equal(saved.length, 0, '占位会话不能覆盖 md 日志');
    const broken = {id: 's2', title: 't', messages: [], archived: [], _loadError: '超限'};
    await log.saveConversationLog(broken);
    assert.equal(saved.length, 0, '正文读取失败的会话不能覆盖 md 日志');
    const healthy = {id: 's3', title: 't', messages: [{role: 'user', content: 'hi', ts: 1}], archived: []};
    await log.saveConversationLog(healthy);
    assert.equal(saved.length, 1, '正常会话照常落 md');
});

test('hydrateSession 读失败：清占位 + 打 _loadError（等于禁止写盘）', async () => {
    const writes = {meta: 0, append: 0, rewrite: 0};
    const store = createSessionDiskStore({
        backend: {
            AISessionList: async () => [],
            AISessionRead: async () => { throw new Error('boom'); },
            AISessionWriteMeta: async () => { writes.meta++; },
            AISessionAppend: async () => { writes.append++; },
            AISessionRewrite: async () => { writes.rewrite++; },
            AISessionDelete: async () => {},
        },
    });
    const stub = {id: 'x', title: 'x', messages: [], archived: [], _stub: true, _msgCount: 4};
    const ok = await store.hydrateSession(stub);
    assert.equal(ok, false);
    assert.equal(stub._stub, undefined, '不能永远停在「正在载入」');
    assert.match(stub._loadError, /boom/);
    // 带 _loadError 的会话被 persistSession 直接跳过：读不出来就绝不写（避免覆盖磁盘历史）
    await store.persistSession(stub);
    assert.equal(writes.meta, 0);
    assert.equal(writes.append, 0);
    assert.equal(writes.rewrite, 0);
});

test('sameLogStat 比较 exists/mtime/size，纳秒优先', () => {
    const {store} = makeStore({a: 0});
    assert.equal(store.sameLogStat({exists: true, mtimeMs: 1, size: 2}, {exists: true, mtimeMs: 1, size: 2}), true);
    assert.equal(store.sameLogStat({exists: true, mtimeMs: 1, size: 2}, {exists: true, mtimeMs: 2, size: 2}), false);
    assert.equal(store.sameLogStat({exists: true, mtimeMs: 1, size: 2}, {exists: false, mtimeMs: 1, size: 2}), false);
    assert.equal(store.sameLogStat(null, {exists: false, mtimeMs: 0, size: 0}), false, '未知基线不能当成“相同”');
    // 同一毫秒、同尺寸、内容不同：只有纳秒能看出来（否则交接协议跳过重读，后续 truncate 裁掉对方新增）
    assert.equal(store.sameLogStat(
        {exists: true, mtimeMs: 100, mtimeNs: 100000000, size: 2},
        {exists: true, mtimeMs: 100, mtimeNs: 100500000, size: 2},
    ), false, '纳秒不同必须判成变了');
    assert.equal(store.sameLogStat(
        {exists: true, mtimeMs: 100, mtimeNs: 100000000, size: 2},
        {exists: true, mtimeMs: 100, mtimeNs: 100000000, size: 2},
    ), true);
    // 老后端只给毫秒：退回毫秒比较，不能因为缺 mtimeNs 就永远判「变了」
    assert.equal(store.sameLogStat(
        {exists: true, mtimeMs: 100, size: 2},
        {exists: true, mtimeMs: 100, size: 2},
    ), true);
});

test('whenIdle 等写队列排空后再返回成功', async () => {
    let releaseAppend;
    const appendGate = new Promise((resolve) => { releaseAppend = resolve; });
    const backend = {
        AISessionList: async () => [],
        AISessionRead: async () => '',
        AISessionAppend: async () => { await appendGate; },
        AISessionRewrite: async () => {},
        AISessionWriteMeta: async () => {},
        AISessionDelete: async () => {},
        AISessionStat: async () => ({exists: true, mtimeMs: 1, size: 2}),
    };
    const store = createSessionDiskStore({backend});
    const session = {
        id: 's1', title: 'T', workspace: 'D:/w',
        messages: msgsOf(1), archived: [],
        _mids: [], _archivedMids: [], _fps: new Map(),
        _logCreated: true, _logMeta: {title: 'T', workspace: 'D:/w'},
    };
    const saved = store.persistSession(session);
    let settled = false;
    const idle = store.whenIdle('s1').then((res) => { settled = true; return res; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false, '写队列未排空时 whenIdle 不应提前返回');
    releaseAppend();
    await saved;
    const res = await idle;
    assert.equal(res.ok, true);
});

test('whenIdle 带回最后一次写盘错误（enqueue 会吞错）', async () => {
    const backend = {
        AISessionList: async () => [],
        AISessionRead: async () => '',
        AISessionAppend: async () => { throw new Error('disk full'); },
        AISessionRewrite: async () => {},
        AISessionWriteMeta: async () => {},
        AISessionDelete: async () => {},
        AISessionStat: async () => ({exists: true, mtimeMs: 1, size: 2}),
    };
    const store = createSessionDiskStore({backend, onError: () => {}});
    const session = {
        id: 's1', title: 'T', workspace: 'D:/w',
        messages: msgsOf(1), archived: [],
        _mids: [], _archivedMids: [], _fps: new Map(),
        _logCreated: true, _logMeta: {title: 'T', workspace: 'D:/w'},
    };
    const saved = store.persistSession(session);
    const res = await store.whenIdle('s1');
    await saved;
    assert.equal(res.ok, false);
    assert.match(res.error, /disk full/);
});

test('reloadSession 对已存在会话的空日志抛 session-gone（不复活）', async () => {
    const backend = {
        AISessionList: async () => [],
        AISessionRead: async () => '',
        AISessionAppend: async () => {},
        AISessionRewrite: async () => {},
        AISessionWriteMeta: async () => {},
        AISessionDelete: async () => {},
        AISessionStat: async () => ({exists: false, mtimeMs: 0, size: 0}),
    };
    const store = createSessionDiskStore({backend});
    const session = {id: 's1', title: 'T', workspace: 'D:/w', messages: [], archived: [], _logCreated: true};
    await assert.rejects(() => store.reloadSession(session), /session-gone/);
});

// 首落盘 allowCreate 语义（ed23473 回归护栏）：append 的第三参必须用进门时的
// _logCreated 快照判定——新会话首落盘时 _logCreated 已被 header unshift 置位，
// 拿它取反会把首落盘当成扇出写（allowCreate=false）→ session-gone 死循环。
test('新会话首落盘 allowCreate=true；已有会话追加 allowCreate=false', async () => {
    const calls = [];
    const store = createSessionDiskStore({
        get backend() {
            return {
                AISessionList: async () => [],
                AISessionRead: async () => '',
                AISessionWriteMeta: async () => {},
                AISessionRewrite: async () => {},
                AISessionDelete: async () => {},
                AISessionAppend: async (id, lines, allowCreate) => { calls.push(allowCreate); },
            };
        },
    });
    const session = {
        id: 's-new', title: 'T', workspace: 'D:/w', _unsaved: true,
        messages: [{role: 'user', content: '你好', ts: 1}],
        archived: [],
    };
    await store.persistSession(session);
    session.messages.push({role: 'assistant', content: '嗯', ts: 2});
    await store.persistSession(session);
    assert.deepEqual(calls, [true, false], '首落盘必须允许建目录，之后的追加必须是扇出写');
});

// 临时会话（meta.temp）：磁盘只作留档，读盘列表一律滤掉——「关闭应用就没了」靠的就是这一层。
// 会话本体活在内存里，所以过滤只发生在读盘侧，写盘侧照旧（留档）。
test('临时会话不进食盘列表：loadMetas / loadAll 默认滤掉，显式 includeTemp 才读回来', async () => {
    const metas = [
        buildSessionMeta({id: 'normal', title: 'T-normal', workspace: 'D:/w', createdAt: 1000, updatedAt: 2000, messages: msgsOf(2)}),
        buildSessionMeta({id: 'tmp', title: 'T-tmp', temp: true, createdAt: 1000, updatedAt: 2000, messages: msgsOf(1)}),
    ];
    const reads = [];
    const store = createSessionDiskStore({
        backend: {
            AISessionList: async () => metas.map((meta) => JSON.stringify(meta)),
            AISessionRead: async (id) => { reads.push(id); return logOf(id, 1); },
            AISessionWriteMeta: async () => {},
            AISessionAppend: async () => {},
            AISessionRewrite: async () => {},
            AISessionDelete: async () => {},
        },
        normalizeMessage: (raw) => (raw && raw.role ? {role: raw.role, content: String(raw.content || ''), ts: Number(raw.ts) || 0} : null),
    });

    const normalOnly = await store.loadMetas();
    assert.deepEqual(normalOnly.map((meta) => meta.id), ['normal'], '临时会话不能出现在会话列表');

    const withTemp = await store.loadMetas({includeTemp: true});
    assert.deepEqual(withTemp.map((meta) => meta.id), ['normal', 'tmp'], 'includeTemp 是诊断/测试用的显式出口');

    const loaded = await store.loadAll((raw) => ({...raw, messages: [], archived: []}));
    assert.deepEqual(loaded.map((session) => session.id), ['normal'], '整份重读同样不能把临时会话带回来');
    assert.equal(reads.includes('tmp'), false, '被滤掉的会话不读正文');
});

