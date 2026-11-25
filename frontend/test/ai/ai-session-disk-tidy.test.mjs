// ai-session-disk-tidy.test.mjs：会话数据整形的前端护栏（docs/unfinished-plans/
// session-compaction-disk-growth.md S1/S2/S3）。
//   1. S2 上限语义反转：读正文撞 session-too-large: → 自动 vacuum（force=false）→ 重读，
//      onTidy 回调带回统计；整理失败给 tidyFailed，live 主导给 liveDominant；
//   2. S3 归档出栈 + 内存对账：vacuum 搬走「磁盘归档态」，内存只清 _archivedMids 登记过的
//      前缀——未登记的尾部（刚切进归档、还没落盘为归档态的消息）必须留在内存并随重写
//      以 a:1 落盘（P0 回归：曾在此处把刚压缩的消息三处同时弄丢）；
//   3. 手动「瘦身归档」：vacuumSessionArchive 走 force + 重读对账；
//   4. 混合态探测：vacuum 过又压缩过的会话，内存归档非空也要探测侧车总数；
//   5. 对话日志 / 导出注释：buildConversationLogMarkdown 接收 sidecar 合并结果。
// mock vacuum 用真实重放语义（从日志推导搬移），不再用罐头结果——罐头曾把 P0 行为钉成预期。
import test from 'node:test';
import assert from 'node:assert/strict';

import {createSessionDiskStore, createAIConversationLog} from '../../src/ai/session/ai-session-disk.js';
import {
    buildSessionMeta,
    encodeMessageEvent,
    encodeSessionHeader,
    encodeSessionLines,
    encodeArchiveEvent,
    encodeMetaEvent,
} from '../../src/ai/session/ai-session-store.js';
import {persistBudgetText, SLIM_PERSIST_HARD_LIMIT} from '../../src/ai/chat/ai-context-slim.js';

const TOO_LARGE = 'session-too-large: 会话正文 300 MB，超过 256 MB 上限（打开时将自动整理归档）';

function logOf(id, count, opts) {
    const options = opts || {};
    const events = [encodeSessionHeader({id, title: 'T-' + id, workspace: 'D:/w', createdAt: 1000})];
    const midArchive = options.archiveMid || 0;
    for (let i = 0; i < count; i++) {
        if (midArchive && i === midArchive) {
            events.push(encodeArchiveEvent(midArchive, {text: options.summary || ('S-' + id)}));
        }
        events.push(encodeMessageEvent({role: 'user', content: 'c' + i, ts: 2000 + i}, 'm-' + id + '-' + i, false));
    }
    if (options.summary && !midArchive) events.push(encodeArchiveEvent(count, {text: options.summary}));
    return encodeSessionLines(events);
}

// 真实语义的极简重放（与 dev mock 的 __mockVacuumPlan 同形）：推导 vacuum 的搬移结果。
function planOf(log) {
    const live = [];
    const archived = [];
    let summary = null;
    let header = '';
    let issues = 0;
    for (const raw of log.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        let event = null;
        try { event = JSON.parse(line); } catch (e) { issues++; continue; }
        if (!event || typeof event !== 'object' || (Number(event.v) || 0) > 1) { issues++; continue; }
        if (event.t === 'header') header = line;
        else if (event.t === 'msg' && event.m && typeof event.m === 'object') {
            const message = Object.assign({}, event.m, {_mid: String(event.mid == null ? '' : event.mid)});
            (event.a ? archived : live).push(message);
        } else if (event.t === 'truncate') {
            live.length = Math.max(0, Math.min(live.length, Number(event.keep) || 0));
        } else if (event.t === 'archive') {
            const keep = Math.max(0, Math.min(live.length, Number(event.keep) || 0));
            archived.push(...live.slice(0, keep));
            // 语义对齐 replaySessionLog：移走 [0,keep)，保留尾部 slice(keep)——
            // 曾写成 live.length = keep（留头），部分归档时双计（调试发现）。
            live.splice(0, keep);
            if (event.summary && typeof event.summary === 'object') summary = event.summary;
        } else if (event.t === 'reset') {
            live.length = 0;
            archived.length = 0;
            summary = null;
        } else if (event.t === 'meta' && event.patch && typeof event.patch === 'object' &&
            Object.prototype.hasOwnProperty.call(event.patch, 'summary')) {
            summary = (event.patch.summary && typeof event.patch.summary === 'object') ? event.patch.summary : null;
        }
    }
    return {header, live, archived, summary, issues};
}

function sidecarLinesOf(state) {
    return (state.sidecar || '').split('\n').filter((line) => line.trim()).length;
}

function makeBackend(state) {
    const calls = {vacuum: [], rewrite: [], readArchive: []};
    const backend = {
        AISessionList: async () => [JSON.stringify(state.meta)],
        AISessionRead: async (id) => {
            if (state.tooLarge) throw new Error(TOO_LARGE);
            return state.logs[id] || '';
        },
        AISessionReadForce: async (id) => state.logs[id] || '',
        AISessionVacuum: async (id, force) => {
            calls.vacuum.push({id, force});
            if (state.vacuumError) throw new Error(state.vacuumError);
            if (state.vacuumResult) return state.vacuumResult;
            const log = state.logs[id] || '';
            const before = log.length;
            const plan = planOf(log);
            if (!plan.archived.length) {
                return {
                    skipped: true, changed: false, movedArchived: 0, liveKept: plan.live.length,
                    droppedTransient: 0, issues: plan.issues, torn: false,
                    beforeBytes: before, afterBytes: before,
                    sidecarLines: sidecarLinesOf(state), sidecarAppendedLines: 0,
                    liveDominant: before > 256 * 1024 * 1024,
                };
            }
            state.tooLarge = false;
            const out = [plan.header];
            if (plan.summary) out.push(JSON.stringify(encodeMetaEvent({summary: plan.summary})));
            for (const message of plan.live) {
                out.push(JSON.stringify(encodeMessageEvent(message, message._mid, false)));
            }
            state.logs[id] = out.filter(Boolean).join('\n') + '\n';
            const sidecarEvents = plan.archived.map((message) => JSON.stringify(encodeMessageEvent(message, message._mid, true)));
            state.sidecar = (state.sidecar || '') + sidecarEvents.join('\n') + '\n';
            return {
                skipped: false, changed: true, movedArchived: plan.archived.length,
                liveKept: plan.live.length, droppedTransient: 0, issues: plan.issues, torn: false,
                beforeBytes: before, afterBytes: state.logs[id].length,
                sidecarLines: sidecarLinesOf(state), sidecarAppendedLines: plan.archived.length,
                liveDominant: false,
            };
        },
        AISessionReadArchive: async (id, offset, limit) => {
            calls.readArchive.push({id, offset, limit});
            const lines = (state.sidecar || '').split('\n').filter((line) => line.trim());
            const start = Math.max(0, offset || 0);
            return {total: lines.length, offset: start, events: lines.slice(start, start + Math.max(0, limit || 0))};
        },
        AISessionWriteMeta: async () => {},
        AISessionAppend: async () => {},
        AISessionRewrite: async (id, content) => { calls.rewrite.push({id, content}); },
        AISessionStat: async (id) => {
            // statSeq：按调用次序返回不同 stat（模拟 vacuum 前大 / 后小）。队空回落到默认值。
            const seq = Array.isArray(state.statSeq) ? state.statSeq : null;
            const picked = seq && seq.length ? seq.shift() : null;
            return {
                exists: true, mtimeMs: picked && picked.mtimeMs ? picked.mtimeMs : 1,
                size: picked && typeof picked.size === 'number' ? picked.size : 2048,
                archiveExists: !!state.sidecar, archiveSize: (state.sidecar || '').length,
            };
        },
        AISessionDelete: async () => {},
        AISessionArchiveClear: async () => {},
    };
    return {backend, calls};
}

function normalizeSession(raw) {
    return Object.assign({}, raw, {messages: raw.messages || [], archived: raw.archived || []});
}

test('S2 撞上限自动整理：vacuum(force=false) → 重读 → onTidy 带回统计', async () => {
    // 日志含 2 条磁盘归档 + 3 条 live：vacuum 应搬走 2 条，重读后 live 正常、内存归档清空。
    const state = {
        meta: buildSessionMeta({id: 'sx', title: 'T', workspace: 'D:/w', createdAt: 1000, updatedAt: 3000}),
        tooLarge: true,
        logs: {sx: logOf('sx', 5, {archiveMid: 2, summary: 'S-x'})},
    };
    const {backend, calls} = makeBackend(state);
    let tidySeen = null;
    const store = createSessionDiskStore({backend, onTidy: (id, result) => { tidySeen = {id, result}; }});
    const session = normalizeSession(Object.assign({_stub: true}, state.meta));
    const ok = await store.hydrateSession(session);
    assert.ok(ok, '自动整理后应载入成功');
    assert.equal(calls.vacuum.length, 1);
    assert.equal(calls.vacuum[0].force, false, '自动整理必须是 force=false');
    assert.ok(!session._loadError, '载入成功后无加载错误');
    assert.equal(session._archiveSidecarTotal, 2, '侧车归档总数来自 vacuum 统计');
    assert.ok(tidySeen, 'onTidy 回调应触发');
    assert.equal(tidySeen.result.movedArchived, 2);
    assert.equal(session.messages.length, 3);
    assert.equal(session.archived.length, 0, '重读的新主文件归档为空');
});

test('S2 整理后基线不退回：vacuum 改小文件不是并发写，_logStat 保留整理后的小值', async () => {
    // 回归：statBefore（整理前 300MB）≠ refreshStat（整理后小文件）曾被误判成「别的窗口写过」，
    // 基线退回大值 → 超限胶囊不消失 + 交接协议反复 reload + 内存旧历史整份写回磁盘。
    const BIG = 300 * 1024 * 1024;
    const SMALL = 2048;
    const state = {
        meta: buildSessionMeta({id: 'st', title: 'T', workspace: 'D:/w', createdAt: 1000, updatedAt: 3000}),
        tooLarge: true,
        logs: {st: logOf('st', 5, {archiveMid: 2, summary: 'S-t'})},
        // hydrateStubSession 读前 statOf → 大；refreshStat → 小。
        statSeq: [{size: BIG, mtimeMs: 1}, {size: SMALL, mtimeMs: 2}],
    };
    const {backend} = makeBackend(state);
    const store = createSessionDiskStore({backend});
    const session = normalizeSession(Object.assign({_stub: true}, state.meta));
    const ok = await store.hydrateSession(session);
    assert.ok(ok, '自动整理后应载入成功');
    assert.equal(session._logStat.size, SMALL, '基线必须是整理后的小 stat，不能退回整理前大值');
    assert.ok(!session._liveDominant && !session._tidyFailed, '整理成功不应带失败标记');
});

test('S2 reload 后基线不退回：vacuum 场景与 hydrate 同口径', async () => {
    const BIG = 300 * 1024 * 1024;
    const SMALL = 2048;
    const state = {
        meta: buildSessionMeta({id: 'sr', title: 'T', workspace: 'D:/w', createdAt: 1000, updatedAt: 3000}),
        tooLarge: true,
        logs: {sr: logOf('sr', 5, {archiveMid: 2, summary: 'S-r'})},
        statSeq: [{size: BIG, mtimeMs: 1}, {size: SMALL, mtimeMs: 2}],
    };
    const {backend} = makeBackend(state);
    const store = createSessionDiskStore({backend});
    const session = normalizeSession(Object.assign({}, state.meta, {_logCreated: true}));
    const ok = await store.reloadSession(session);
    assert.ok(ok, 'reload 触发自动整理后应成功');
    assert.equal(session._logStat.size, SMALL, 'reload 场景基线同样不能被退回');
});

test('S2 对照：无 vacuum 时读前读后 stat 不一致仍退回（多窗口并发保护未被破坏）', async () => {
    const BEFORE = 2048;
    const AFTER = 4096;
    const state = {
        meta: buildSessionMeta({id: 'sc', title: 'T', workspace: 'D:/w', createdAt: 1000, updatedAt: 3000}),
        tooLarge: false, // 不触发 vacuum
        logs: {sc: logOf('sc', 3)},
        statSeq: [{size: BEFORE, mtimeMs: 1}, {size: AFTER, mtimeMs: 2}],
    };
    const {backend} = makeBackend(state);
    const store = createSessionDiskStore({backend});
    const session = normalizeSession(Object.assign({_stub: true}, state.meta));
    await store.hydrateSession(session);
    assert.equal(session._logStat.size, BEFORE, '无 vacuum 时 stat 变化仍应退回读前基线（并发写保护）');
});

test('S2 自动整理执行失败：_tidyFailed 交给拒载卡片（重试整理）', async () => {
    const state = {
        meta: buildSessionMeta({id: 'sy', title: 'T', workspace: 'D:/w', createdAt: 1000, updatedAt: 3000}),
        tooLarge: true,
        vacuumError: 'session-busy: 会话正在另一窗口运行',
        logs: {sy: ''},
    };
    const {backend} = makeBackend(state);
    const store = createSessionDiskStore({backend});
    const session = normalizeSession(Object.assign({_stub: true}, state.meta));
    const ok = await store.hydrateSession(session);
    assert.ok(!ok, '整理失败 = 拒载');
    assert.ok(session._loadError.startsWith('自动整理失败：'), '错误文案可读：' + session._loadError);
    assert.equal(session._tidyFailed, true);
});

test('S2 live 主导（真空角落）：不再自动重试，_liveDominant 交给卡片（临时加载）', async () => {
    const state = {
        meta: buildSessionMeta({id: 'sz', title: 'T', workspace: 'D:/w', createdAt: 1000, updatedAt: 3000}),
        tooLarge: true,
        vacuumResult: {
            skipped: true, changed: false, movedArchived: 0, liveKept: 0, droppedTransient: 0,
            issues: 0, torn: false, beforeBytes: 300 * 1024 * 1024, afterBytes: 300 * 1024 * 1024,
            sidecarLines: 0, sidecarAppendedLines: 0, liveDominant: true,
        },
        logs: {sz: ''},
    };
    const {backend, calls} = makeBackend(state);
    const store = createSessionDiskStore({backend});
    const session = normalizeSession(Object.assign({_stub: true}, state.meta));
    const ok = await store.hydrateSession(session);
    assert.ok(!ok, 'live 主导 = 拒载');
    assert.equal(calls.vacuum.length, 1, '只 vacuum 一次');
    assert.equal(session._liveDominant, true);
    assert.equal(session._tidyFailed, false, '不是整理失败');
});

test('S3 归档出栈 + 内存对账：已登记前缀清空入侧车，未登记尾部留在内存并随重写落盘（P0 回归）', async () => {
    // 磁盘日志：m0/m1 已是归档态（archive 标记），m2..m4 live。
    const state = {
        meta: buildSessionMeta({id: 'sn', title: 'T', workspace: 'D:/w', createdAt: 1000, updatedAt: 3000}),
        tooLarge: false,
        logs: {sn: logOf('sn', 5, {archiveMid: 2, summary: 'S-n'})},
    };
    const {backend, calls} = makeBackend(state);
    const store = createSessionDiskStore({backend});
    const session = normalizeSession(Object.assign({_stub: true}, state.meta));
    await store.hydrateSession(session);
    assert.deepEqual(session.archived.map((m) => m._mid), ['m-sn-0', 'm-sn-1'], '载入后内存归档=磁盘归档');
    assert.deepEqual(session._archivedMids, ['m-sn-0', 'm-sn-1']);
    // 模拟压缩进行中：pushArchivedMessages 追加了一条「尚未落盘为归档态」的尾部。
    const pending = {role: 'user', content: '刚压缩的尾部', ts: 9000, _mid: 'pending-1'};
    session.archived.push(pending);
    session._needsRewrite = true;
    await store.persistSession(session);
    await store.flush();

    assert.equal(calls.vacuum.length, 1);
    assert.equal(calls.vacuum[0].force, true, '重写前出栈必须是 force=true');
    assert.equal(calls.rewrite.length, 1);
    // P0 断言：尾部必须随载荷以 a:1 落盘——曾在此处被排除 → 三处同时消失。
    assert.ok(calls.rewrite[0].content.includes('"a":1'), '尾部归档必须随载荷落盘');
    assert.ok(calls.rewrite[0].content.includes('pending-1'), '尾部归档内容必须在载荷里');
    // 已登记前缀：清出内存（内容在侧车），未登记尾部：保留在内存。
    assert.deepEqual(session.archived.map((m) => m._mid), ['pending-1'], '只清登记过的前缀');
    assert.equal(session._archiveSidecarTotal, 2, '侧车计数来自 vacuum 统计');
    // 前缀进了 sidecar。
    assert.ok((state.sidecar || '').includes('m-sn-0'), '已登记前缀应入侧车');
    // 收敛：重写后 archived 与 _archivedMids 重新对齐，不再触发第二次重写。
    await store.persistSession(session);
    await store.flush();
    assert.equal(calls.rewrite.length, 1, '不应重复重写');
});

test('S3 出栈失败回退旧路径：归档全量随主文件重写（数据不丢）', async () => {
    const state = {
        meta: buildSessionMeta({id: 'sf', title: 'T', workspace: 'D:/w', createdAt: 1000, updatedAt: 3000}),
        tooLarge: false,
        vacuumError: '磁盘错误',
        logs: {sf: logOf('sf', 2)},
    };
    const {backend, calls} = makeBackend(state);
    const store = createSessionDiskStore({backend});
    const session = normalizeSession(Object.assign({}, state.meta));
    await store.hydrateSession(session);
    session.archived = [{role: 'user', content: '旧1', ts: 1, _mid: 'old-1'}];
    session._archivedMids = ['old-1'];
    session._needsRewrite = true;
    await store.persistSession(session);
    await store.flush();
    assert.equal(calls.vacuum.length, 1);
    assert.equal(calls.rewrite.length, 1);
    assert.ok(calls.rewrite[0].content.includes('"a":1'), '回退路径必须保留归档编码');
    assert.ok(calls.rewrite[0].content.includes('old-1'), '回退路径必须保留归档内容');
    assert.equal(session.archived.length, 1, '回退路径不清内存归档');
});

test('手动瘦身归档：vacuumSessionArchive 走 force + 重读对账', async () => {
    const state = {
        meta: buildSessionMeta({id: 'sv', title: 'T', workspace: 'D:/w', createdAt: 1000, updatedAt: 3000}),
        tooLarge: false,
        logs: {sv: logOf('sv', 3, {summary: 'S-v'})},
    };
    const {backend, calls} = makeBackend(state);
    const store = createSessionDiskStore({backend});
    const session = normalizeSession(Object.assign({_stub: true}, state.meta));
    await store.hydrateSession(session);
    assert.equal(session.archived.length, 3, '载入后内存归档来自重放');
    const result = await store.vacuumSessionArchive(session);
    assert.equal(calls.vacuum.length, 1);
    assert.equal(calls.vacuum[0].force, true);
    assert.equal(result.changed, true);
    assert.equal(session._archiveSidecarTotal, 3);
    assert.equal(session.archived.length, 0, '重读后内存归档清空（都在侧车）');
    assert.equal(session.messages.length, 0, '全部消息都已归档的会话 live 为空');
});

test('S4 混合态探测：内存归档非空时也探测侧车总数', async () => {
    // 磁盘：2 条磁盘归档 + 2 条 live；侧车另有 3 条（此前 vacuum 搬的）。
    const state = {
        meta: buildSessionMeta({id: 'sm', title: 'T', workspace: 'D:/w', createdAt: 1000, updatedAt: 3000}),
        tooLarge: false,
        logs: {sm: logOf('sm', 4, {archiveMid: 2, summary: 'S-m'})},
        sidecar: [
            JSON.stringify(encodeMessageEvent({role: 'user', content: 'side-1', ts: 1}, 'side-1', true)),
            JSON.stringify(encodeMessageEvent({role: 'user', content: 'side-2', ts: 2}, 'side-2', true)),
            JSON.stringify(encodeMessageEvent({role: 'user', content: 'side-3', ts: 3}, 'side-3', true)),
        ].join('\n') + '\n',
    };
    const {backend, calls} = makeBackend(state);
    const store = createSessionDiskStore({backend});
    const session = normalizeSession(Object.assign({_stub: true}, state.meta));
    await store.hydrateSession(session);
    assert.equal(session.archived.length, 2, '内存归档来自主文件重放');
    assert.equal(session._archiveSidecarTotal, 3, '混合态下侧车总数也要探测到');
    assert.ok(calls.readArchive.some((call) => call.offset === 0 && call.limit === 0), '应发一次总数探测');
});

test('对话日志：内存归档 + 侧车尾部合并，超预算部分注明省略', async () => {
    const sidecarEvents = [];
    for (let i = 0; i < 201; i++) {
        sidecarEvents.push(JSON.stringify(encodeMessageEvent({role: 'user', content: 'side-' + i, ts: i}, 's-' + i, true)));
    }
    const state = {
        meta: buildSessionMeta({id: 'sl', title: 'T', workspace: 'D:/w', createdAt: 1000, updatedAt: 3000}),
        tooLarge: false,
        logs: {sl: logOf('sl', 1)},
        sidecar: sidecarEvents.join('\n') + '\n',
    };
    const {backend} = makeBackend(state);
    let saved = '';
    backend.SaveFile = async (path, content) => { saved = content; };
    backend.SaveDataURL = async () => '';
    backend.AIEnsureDir = async () => {};
    const ctx = {
        backend,
        getConfig: () => ({logEnabled: true, profiles: []}),
        ensureLogDir: async () => 'D:/logs',
        persistSessions: () => {},
        flash: () => {},
        notifyFailure: () => {},
        askStateLabel: () => '',
        askResultText: () => '',
        joinPath: (a, b) => a + '/' + b,
    };
    const log = createAIConversationLog(ctx);
    const session = normalizeSession(Object.assign({}, state.meta));
    // 模拟「内存归档 1 条 + 侧车 201 条」：hydrate 后手工补内存归档。
    const store = createSessionDiskStore({backend});
    await store.hydrateSession(session);
    session.archived = [{role: 'user', content: 'memory-archived', ts: 999, _mid: 'mem-1'}];
    session._archiveSidecarTotal = 201;
    session.messages = [{role: 'user', content: 'live-1', ts: 5000}];
    await log.saveConversationLog(session);
    assert.ok(saved, '日志应已写出');
    assert.ok(saved.includes('side-200'), '侧车尾部（最近）应包含');
    assert.ok(!saved.includes('side-0\n'), '侧车头部（最旧，超 cap）应省略');
    assert.ok(/另有 \d+ 条更早的归档/.test(saved), '超预算部分应注明');
    assert.ok(saved.includes('memory-archived'), '内存归档应包含');
    assert.ok(saved.includes('live-1'), '当前对话应包含');
});

test('S3 落盘预算化：persistBudgetText 有 artifact 时给头尾+指针，超 4MB 只留指针', () => {
    const big = 'x'.repeat(10000);
    const budgeted = persistBudgetText('run_command', big, 'D:/artifacts/a.txt');
    assert.ok(budgeted.includes('D:/artifacts/a.txt'), '指针带路径');
    assert.ok(budgeted.length < 7000, '预算后应远小于原文（头 4096 + 命令尾 2048 + 指针）：' + budgeted.length);
    assert.ok(budgeted.startsWith('x'), '头部保留');
    assert.ok(persistBudgetText('run_command', big, '').length === 10000, '无 artifact 保持全文（组装侧兜底）');
    const huge = 'y'.repeat(SLIM_PERSIST_HARD_LIMIT + 1);
    const pointerOnly = persistBudgetText('run_command', huge, 'D:/artifacts/b.txt');
    assert.ok(pointerOnly.length < 500, '超 4MB 只留指针：' + pointerOnly.length);
    assert.ok(pointerOnly.includes(String(huge.length)), '指针注明原文长度');
});
