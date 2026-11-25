import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AI_SESSION_SCHEMA,
    encodeSessionHeader,
    encodeMessageEvent,
    encodeTruncateEvent,
    encodeArchiveEvent,
    encodeResetEvent,
    encodeMetaEvent,
    encodeSessionLines,
    replaySessionLog,
    serializeSessionMessage,
    isSilentInjection,
    isTurnBoundaryMessage,
    sessionTurnStartTs,
    sessionEndTs,
    sessionActivityTs,
    buildSessionMeta,
    metaSignature,
    messageFingerprint,
    normalizeSessionGroup,
    resolveSessionGroupName,
    AI_SESSION_GROUP_MAX,
} from '../../../src/ai/session/ai-session-store.js';
import {createSessionDiskStore} from '../../../src/ai/session/ai-session-disk.js';

function logOf(...events) {
    return encodeSessionLines(events);
}

test('header + messages replay', () => {
    const text = logOf(
        encodeSessionHeader({id: 's1', title: '标题', createdAt: 100, workspace: 'D:/w'}),
        encodeMessageEvent({role: 'user', content: '你好', ts: 1}, 'm-1', false),
        encodeMessageEvent({role: 'assistant', content: '在', ts: 2}, 'm-2', false),
    );
    const result = replaySessionLog(text);
    assert.equal(result.header.id, 's1');
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0]._mid, 'm-1');
    assert.equal(result.messages[1].content, '在');
    assert.equal(result.issues, 0);
    assert.equal(result.torn, false);
});

test('model-switch note keeps kind/systemNote/modelNote', () => {
    const note = {
        role: 'user',
        kind: 'model-switch',
        systemNote: true,
        content: '模型已从 A 更改为 B',
        modelNote: {from: 'A', to: 'B', account: '账号 1', effort: '高'},
        ts: 5,
        turnStartedAt: 0,
    };
    const result = replaySessionLog(logOf(
        encodeSessionHeader({id: 's1'}),
        encodeMessageEvent(note, 'm-1', false),
    ));
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].kind, 'model-switch');
    assert.equal(result.messages[0].systemNote, true);
    assert.deepEqual(result.messages[0].modelNote, note.modelNote);
});

test('isSilentInjection：按内容识别历史会话的机械提醒注入块', () => {
    // 修复前落盘的注入块没有 silent 字段，靠内容前缀回填
    assert.equal(isSilentInjection('<task_todos_check>任务清单尚未与实际进度对齐：1 项进行中、3 项待处理。</task_todos_check>'), true);
    assert.equal(isSilentInjection('  <task_todos_check>任务清单尚未与实际进度对齐：…</task_todos_check>  '), true);
    // 新形态：包成 <system-reminder> 宿主块（2026-11-17 起），同样要隐藏
    assert.equal(isSilentInjection('<system-reminder>\n<task_todos_check>任务清单现状：共 2 项……</task_todos_check>\n</system-reminder>'), true);
    // 普通用户消息 / 系统注记 / 其他标签不命中
    assert.equal(isSilentInjection('帮我看看这个文件'), false);
    assert.equal(isSilentInjection('（系统提示）工具调用轮次已达 10。'), false);
    assert.equal(isSilentInjection('<task_reminders>提醒内容</task_reminders>'), false);
    assert.equal(isSilentInjection('<system-reminder>\n<workspace_context>x</workspace_context>\n</system-reminder>\n\n正文'), false);
    assert.equal(isSilentInjection(''), false);
    assert.equal(isSilentInjection(null), false);
});

test('buildSessionMeta：activePlan 归一随 meta 持久化（计划唯一真源）', () => {
    // 计划状态在 session 层（activePlan），不再挂在消息上；meta 必须原样带出，
    // 重启后审批卡 / 落盘 / 回注才能恢复。
    const plan = {
        title: 'Git 图谱', markdown: '# Git 图谱\n\n## 目标', status: 'pending',
        ts: 123, fileRel: '.cadt/plan/plan-s1.md',
    };
    const meta = buildSessionMeta({id: 's1', planMode: true, activePlan: plan});
    assert.deepEqual(meta.activePlan, plan);
    // 空 / 脏数据归一成 null，不写空壳
    assert.equal(buildSessionMeta({id: 's1'}).activePlan, null);
    assert.equal(buildSessionMeta({id: 's1', activePlan: {markdown: '   '}}).activePlan, null);
    // status 只认 pending / approved
    const bad = buildSessionMeta({id: 's1', activePlan: {...plan, status: 'weird', extraField: 1}});
    assert.equal(bad.activePlan.status, 'pending');
    assert.equal('extraField' in bad.activePlan, false, '白名单外字段不得透传');
});

test('buildSessionMeta：turnInFlight 随 meta 持久化（进程强杀的中断留痕）', () => {
    // 起轮置位、finishStream 清除；只有「进程死了没走收尾」才残留 true——
    // 读盘侧据此挂「回合中断」横幅，与「用户自己停止」区分开。
    assert.equal(buildSessionMeta({id: 's1'}).turnInFlight, false);
    assert.equal(buildSessionMeta({id: 's1', turnInFlight: true}).turnInFlight, true);
    assert.equal(buildSessionMeta({id: 's1', turnInFlight: 'weird'}).turnInFlight, false);
    // 标记变化必须改变 meta 签名：否则 writeMetaIfChanged 会漏写置位/清除
    const sig = (m) => metaSignature(buildSessionMeta(m));
    assert.notEqual(sig({id: 's1'}), sig({id: 's1', turnInFlight: true}));
});

test('会话分组：normalizeSessionGroup trim/截断/脏值归一', () => {
    assert.equal(normalizeSessionGroup('  前端  '), '前端');
    assert.equal(normalizeSessionGroup(''), '');
    assert.equal(normalizeSessionGroup('   '), '');
    assert.equal(normalizeSessionGroup(null), '');
    assert.equal(normalizeSessionGroup(12345), '12345');
    assert.equal(normalizeSessionGroup('x'.repeat(AI_SESSION_GROUP_MAX + 10)).length, AI_SESSION_GROUP_MAX);
});

test('resolveSessionGroupName：自由填 + 大小写/空白近似归一到既有分组', () => {
    const existing = ['前端', 'AI 研究', 'Review'];
    // 精确命中：原样复用
    assert.equal(resolveSessionGroupName('前端', existing), '前端');
    // 前后空白：先 trim 再命中
    assert.equal(resolveSessionGroupName('  前端  ', existing), '前端');
    // 大小写近似：复用既有原样名字（Review 保持首字母大写）
    assert.equal(resolveSessionGroupName('review', existing), 'Review');
    assert.equal(resolveSessionGroupName('REVIEW', existing), 'Review');
    // 中间空白差异：去所有空白后命中（"AI研究" → "AI 研究"）
    assert.equal(resolveSessionGroupName('AI研究', existing), 'AI 研究');
    assert.equal(resolveSessionGroupName('a i 研 究', existing), 'AI 研究');
    // 全新分组：走归一值（trim + 24 字上限）
    assert.equal(resolveSessionGroupName('新分组', existing), '新分组');
    assert.equal(resolveSessionGroupName('  ' + 'x'.repeat(30) + '  ', existing).length, AI_SESSION_GROUP_MAX);
    // 空值 / 纯空白：移出分组
    assert.equal(resolveSessionGroupName('', existing), '');
    assert.equal(resolveSessionGroupName('   ', existing), '');
    assert.equal(resolveSessionGroupName(null, existing), '');
    // 无既有分组时退化为纯归一
    assert.equal(resolveSessionGroupName('  前端  ', []), '前端');
    assert.equal(resolveSessionGroupName('前端', null), '前端');
    // 多个近似命中时取第一个既有项（顺序即优先级）
    assert.equal(resolveSessionGroupName('review', ['review-one', 'Review', 'REVIEW']), 'Review');
});

test('buildSessionMeta：group 随 meta 持久化，且变化改变签名', () => {
    assert.equal(buildSessionMeta({id: 's1'}).group, '');
    assert.equal(buildSessionMeta({id: 's1', group: '前端'}).group, '前端');
    assert.equal(buildSessionMeta({id: 's1', group: '  后端  '}).group, '后端', '写盘前也走归一');
    const sig = (m) => metaSignature(buildSessionMeta(m));
    assert.notEqual(sig({id: 's1'}), sig({id: 's1', group: '前端'}), '改分组必须触发 meta 重写');
    assert.notEqual(sig({id: 's1', group: '前端'}), sig({id: 's1', group: '后端'}));
});

test('messageFingerprint：思考循环守卫状态变化要能触发重写', () => {
    const message = {role: 'assistant', status: 'stopped', content: '', guard: {state: 'pending'}};
    const before = messageFingerprint(message);
    // pending → stopped 发生在同一条流里：不重写的话磁盘上会一直停在「待确认」。
    message.guard = {state: 'stopped', action: 'stop', source: 'timeout'};
    const after = messageFingerprint(message);
    assert.notEqual(before, after);
    assert.equal(messageFingerprint({...message, guard: {...message.guard}}), after);
});

test('truncate keeps prefix', () => {
    const text = logOf(
        encodeSessionHeader({id: 's1'}),
        encodeMessageEvent({role: 'user', content: 'a', ts: 1}, 'm-1', false),
        encodeMessageEvent({role: 'assistant', content: 'b', ts: 2}, 'm-2', false),
        encodeMessageEvent({role: 'user', content: 'c', ts: 3}, 'm-3', false),
        encodeTruncateEvent(2),
        encodeMessageEvent({role: 'user', content: 'd', ts: 4}, 'm-4', false),
    );
    const result = replaySessionLog(text);
    assert.deepEqual(result.messages.map((m) => m.content), ['a', 'b', 'd']);
});

test('replay folds old same-dedupeKey injections, keeps only the newest', () => {
    // 节流失效期（2026-11-19 修复前）落盘了大量重复的 <task_todos_check>：读盘统一折叠，
    // 只留最新一条（口径与 buildApiMessages 发送侧一致），droppedTransient 供加载方置重写。
    const injection = (text) => ({
        role: 'user', content: '<system-reminder>\n<task_todos_check>' + text + '</task_todos_check>\n</system-reminder>',
        systemNote: true, silent: true, dedupeKey: 'task_todos_check', ts: 0,
    });
    const text = logOf(
        encodeSessionHeader({id: 's1'}),
        encodeMessageEvent({role: 'user', content: 'a', ts: 1}, 'm-1', false),
        encodeMessageEvent(injection('共 9 项，6 项已完成'), 'm-2', false),
        encodeMessageEvent({role: 'assistant', content: 'b', ts: 2}, 'm-3', false),
        encodeMessageEvent(injection('共 9 项，6 项已完成'), 'm-4', false),
        encodeMessageEvent(injection('共 9 项，7 项已完成'), 'm-5', false),
    );
    const result = replaySessionLog(text);
    assert.deepEqual(result.messages.map((m) => m._mid), ['m-1', 'm-3', 'm-5'], '同 key 只留最后一条');
    assert.equal(result.droppedTransient, 2);
    // 无 dedupeKey 的消息（包括同样内容但没 key 的）不受影响
    const plain = replaySessionLog(logOf(
        encodeSessionHeader({id: 's1'}),
        encodeMessageEvent({role: 'user', content: '正文', ts: 1}, 'm-1', false),
        encodeMessageEvent({role: 'user', content: '<task_todos_check>手写的同名标签不算注入</task_todos_check>', ts: 2}, 'm-2', false),
    ));
    assert.equal(plain.messages.length, 2);
    assert.equal(plain.droppedTransient, 0);
    // 不同 key 各自折叠、互不误伤；archived 里的旧注入不动
    const mixed = logOf(
        encodeSessionHeader({id: 's1'}),
        encodeMessageEvent({role: 'user', dedupeKey: 'k1', content: 'k1-旧', ts: 1}, 'm-1', true),
        encodeMessageEvent({role: 'user', dedupeKey: 'k2', content: 'k2-旧', ts: 2}, 'm-2', false),
        encodeMessageEvent({role: 'user', dedupeKey: 'k2', content: 'k2-新', ts: 3}, 'm-3', false),
    );
    const mixedResult = replaySessionLog(mixed);
    assert.deepEqual(mixedResult.archived.map((m) => m.content), ['k1-旧']);
    assert.deepEqual(mixedResult.messages.map((m) => m.content), ['k2-新']);
    assert.equal(mixedResult.droppedTransient, 1);
});

test('archive moves prefix and sets summary', () => {
    const text = logOf(
        encodeSessionHeader({id: 's1'}),
        encodeMessageEvent({role: 'user', content: 'a', ts: 1}, 'm-1', false),
        encodeMessageEvent({role: 'assistant', content: 'b', ts: 2}, 'm-2', false),
        encodeMessageEvent({role: 'user', content: 'c', ts: 3}, 'm-3', false),
        encodeArchiveEvent(2, {text: '摘要', upTo: 2}),
    );
    const result = replaySessionLog(text);
    assert.deepEqual(result.archived.map((m) => m.content), ['a', 'b']);
    assert.deepEqual(result.messages.map((m) => m.content), ['c']);
    assert.equal(result.summary.text, '摘要');
});

test('reset clears live and archived', () => {
    const text = logOf(
        encodeSessionHeader({id: 's1'}),
        encodeMessageEvent({role: 'user', content: 'a', ts: 1}, 'm-1', true),
        encodeArchiveEvent(0, {text: '摘要'}),
        encodeResetEvent(),
    );
    const result = replaySessionLog(text);
    assert.equal(result.messages.length, 0);
    assert.equal(result.archived.length, 0);
    assert.equal(result.summary, null);
});

test('torn tail is ignored', () => {
    const complete = logOf(
        encodeSessionHeader({id: 's1'}),
        encodeMessageEvent({role: 'user', content: 'a', ts: 1}, 'm-1', false),
    );
    const result = replaySessionLog(complete + '{"v":1,"t":"msg","mid":"m-2"');
    assert.equal(result.messages.length, 1);
    assert.equal(result.torn, true);
});

test('malformed lines are skipped and counted', () => {
    const text = logOf(encodeSessionHeader({id: 's1'})) + 'not json\n' + encodeSessionLines([
        encodeMessageEvent({role: 'user', content: 'a', ts: 1}, 'm-1', false),
    ]);
    const result = replaySessionLog(text);
    assert.equal(result.issues, 1);
    assert.equal(result.messages.length, 1);
});

test('serialize strips inline image data when file exists', () => {
    const message = {
        role: 'user',
        content: '',
        ts: 1,
        _mid: 'm-1',
        images: [{id: 'img-1', mime: 'image/png', data: 'AAAA', file: 'images/img-1.png'}],
    };
    const out = serializeSessionMessage(message);
    assert.equal(out._mid, undefined);
    assert.equal(out.images[0].data, undefined);
    assert.equal(out.images[0].file, 'images/img-1.png');
});

test('serialize keeps inline data when file missing', () => {
    const out = serializeSessionMessage({
        role: 'user',
        content: '',
        ts: 1,
        images: [{id: 'img-1', mime: 'image/png', data: 'AAAA'}],
    });
    assert.equal(out.images[0].data, 'AAAA');
});

test('meta patch applies', () => {
    const text = logOf(
        encodeSessionHeader({id: 's1'}),
        encodeMetaEvent({title: '新标题', summary: {text: '摘要'}}),
    );
    const result = replaySessionLog(text);
    assert.equal(result.meta.title, '新标题');
    assert.equal(result.summary.text, '摘要');
});

test('buildSessionMeta counts messages and archived', () => {
    const meta = buildSessionMeta({
        id: 's1',
        title: 't',
        createdAt: 1,
        updatedAt: 2,
        messages: [{role: 'user'}, {role: 'assistant'}],
        archived: [{role: 'user'}],
        summary: {text: 's'},
    });
    assert.equal(meta.v, AI_SESSION_SCHEMA);
    assert.equal(meta.messageCount, 2);
    assert.equal(meta.archivedCount, 1);
    assert.equal(meta.summary.text, 's');
    assert.equal(meta.pinned, false, '未置顶会话 meta.pinned = false');
    assert.equal(buildSessionMeta({id: 's2', pinned: true}).pinned, true, '置顶标记写入 meta');
});

function fakeBackend() {
    const logs = new Map();
    const metas = new Map();
    const images = new Map();
    return {
        _logs: logs,
        _metas: metas,
        _images: images,
        async AISessionList() {
            return Array.from(metas.values());
        },
        async AISessionRead(id) {
            return logs.get(id) || '';
        },
        async AISessionAppend(id, lines) {
            logs.set(id, (logs.get(id) || '') + lines);
        },
        async AISessionRewrite(id, content) {
            logs.set(id, content);
        },
        async AISessionWriteMeta(id, data) {
            metas.set(id, data);
        },
        async AISessionDelete(id) {
            logs.delete(id);
            metas.delete(id);
        },
        async AISessionDeleteAll() {
            logs.clear();
            metas.clear();
        },
        async AIEnsureDir() {},
        async SaveDataURL(path, dataURL) {
            images.set(path, dataURL);
        },
        async ReadImageAsDataURL(path) {
            return images.get(path) || '';
        },
        async AISessionSaveImage(id, name, dataURL) {
            images.set(id + '/' + name, dataURL);
            return 'images/' + name;
        },
        async AISessionReadImage(id, name) {
            return images.get(id + '/' + name) || '';
        },
    };
}

function newSession(extra) {
    return Object.assign({
        id: 's1',
        title: '测试',
        createdAt: 1,
        updatedAt: 1,
        workspace: 'D:/w',
        messages: [],
        archived: [],
        summary: null,
    }, extra);
}

test('disk store: persist, reload, truncate', async () => {
    const backend = fakeBackend();
    const store = createSessionDiskStore({backend});
    const session = newSession({messages: [{role: 'user', content: 'a', ts: 1}]});
    await store.persistSession(session);
    await store.flush();
    let loaded = await store.loadAll(null);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].messages.length, 1);
    assert.ok(backend._logs.get('s1').startsWith('{"v":1,"t":"header"'), '正文首行必须是 header');

    session.messages.push({role: 'assistant', content: 'b', ts: 2, status: 'done'});
    await store.persistSession(session);
    await store.flush();
    loaded = await store.loadAll(null);
    assert.deepEqual(loaded[0].messages.map((m) => m.content), ['a', 'b']);

    session.messages = session.messages.slice(0, 1);
    await store.persistSession(session);
    await store.flush();
    loaded = await store.loadAll(null);
    assert.deepEqual(loaded[0].messages.map((m) => m.content), ['a']);
});

test('disk store: streaming messages are not persisted until final', async () => {
    const backend = fakeBackend();
    const store = createSessionDiskStore({backend});
    const session = newSession({messages: [{role: 'user', content: 'q', ts: 1}]});
    await store.persistSession(session);
    session.messages.push({role: 'assistant', content: '部分', ts: 2, status: 'streaming'});
    await store.persistSession(session);
    await store.flush();
    let loaded = await store.loadAll(null);
    assert.equal(loaded[0].messages.length, 1);
    session.messages[1].status = 'done';
    await store.persistSession(session);
    await store.flush();
    loaded = await store.loadAll(null);
    assert.equal(loaded[0].messages.length, 2);
});

test('disk store: archive moves messages and keeps summary', async () => {
    const backend = fakeBackend();
    const store = createSessionDiskStore({backend});
    const session = newSession({messages: [
        {role: 'user', content: 'a', ts: 1},
        {role: 'assistant', content: 'b', ts: 2, status: 'done'},
        {role: 'user', content: 'c', ts: 3},
    ]});
    await store.persistSession(session);
    const summary = {text: '摘要', upTo: 2};
    const moved = session.messages.slice(0, 2);
    await store.archiveSession(session, 2, summary);
    session.messages = session.messages.slice(2);
    session.archived = session.archived.concat(moved);
    session.summary = summary;
    await store.persistSession(session);
    await store.flush();
    assert.ok(backend._logs.get('s1').includes('"t":"archive"'), '归档应追加 archive 事件而不是整份重写');
    // 归档后继续追加，前缀差分不能把剩余消息截掉
    session.messages.push({role: 'assistant', content: 'd', ts: 4, status: 'done'});
    await store.persistSession(session);
    await store.flush();
    const loaded = await store.loadAll(null);
    assert.deepEqual(loaded[0].messages.map((m) => m.content), ['c', 'd']);
    assert.deepEqual(loaded[0].archived.map((m) => m.content), ['a', 'b']);
    assert.equal(loaded[0].summary.text, '摘要');
});

test('disk store: images externalized and rehydrated', async () => {
    const backend = fakeBackend();
    const store = createSessionDiskStore({backend});
    const session = newSession({messages: [{
        role: 'user',
        content: '',
        ts: 1,
        images: [{id: 'img-1', mime: 'image/png', data: 'QUJD', name: '图'}],
    }]});
    await store.persistSession(session);
    await store.flush();
    const log = backend._logs.get('s1');
    assert.ok(!log.includes('QUJD'), '日志里不应内嵌 base64');
    assert.ok(log.includes('images/img-1.png'), '日志应保存图片引用');
    const loaded = await store.loadAll(null);
    assert.equal(loaded[0].messages[0].images[0].data, 'QUJD');
});

test('disk store: reset removes history', async () => {
    const backend = fakeBackend();
    const store = createSessionDiskStore({backend});
    const session = newSession({messages: [{role: 'user', content: 'a', ts: 1}]});
    await store.persistSession(session);
    await store.resetSession(session);
    session.messages = [];
    await store.flush();
    const loaded = await store.loadAll(null);
    assert.equal(loaded[0].messages.length, 0);
    assert.ok(backend._logs.get('s1').startsWith('{"v":1,"t":"header"'));
    assert.ok(!backend._logs.get('s1').includes('"a"'));
});

test('disk store: normalized-out messages trigger a rewrite before appending', async () => {
    const backend = fakeBackend();
    const store = createSessionDiskStore({backend});
    const session = newSession({messages: [
        {role: 'assistant', content: '', status: 'done', ts: 1},
        {role: 'user', content: 'a', ts: 2},
    ]});
    await store.persistSession(session);
    await store.flush();
    const normalize = (raw) => Object.assign({}, raw, {
        messages: (raw.messages || []).filter((m) => !(m.role === 'assistant' && !m.content && m.status === 'done')),
    });
    const loaded = await store.loadAll(normalize);
    assert.equal(loaded[0].messages.length, 1);
    loaded[0].messages.push({role: 'user', content: 'b', ts: 3});
    await store.persistSession(loaded[0]);
    await store.flush();
    const again = await store.loadAll(normalize);
    assert.deepEqual(again[0].messages.map((m) => m.content), ['a', 'b']);
    assert.ok(!backend._logs.get('s1').includes('"content":""'), '被归一化丢掉的消息应从日志里清掉');
});

test('disk store: folded duplicate injections trigger a rewrite that cleans the log', async () => {
    // 2026-11-19 session-mwm2sdc1n4cs5 实测：节流失效让同一句 <task_todos_check> 落盘
    // 339 条。读盘折叠只清理内存，磁盘冗余要靠 droppedTransient → _needsRewrite 的
    // 整份重写才能清掉（该老会话被打开并再次持久化时生效）。
    const backend = fakeBackend();
    const store = createSessionDiskStore({backend});
    const injection = (text) => ({
        role: 'user', content: '<system-reminder>\n<task_todos_check>' + text + '</task_todos_check>\n</system-reminder>',
        systemNote: true, silent: true, dedupeKey: 'task_todos_check', ts: 0,
    });
    const session = newSession({messages: [
        {role: 'user', content: 'a', ts: 1},
        injection('共 9 项，6 项已完成'),
        injection('共 9 项，6 项已完成'),
        injection('共 9 项，7 项已完成'),
        {role: 'assistant', content: 'b', status: 'done', ts: 2},
    ]});
    await store.persistSession(session);
    await store.flush();
    assert.equal((backend._logs.get('s1').match(/task_todos_check/g) || []).length >= 3, true, '三条注入都已落盘');

    const loaded = await store.loadAll(null);
    assert.equal(loaded[0].messages.length, 3, '读盘折叠成 a + 最新一条注入 + b');
    assert.ok(loaded[0].messages[1].content.includes('共 9 项，7 项已完成'), '只保留最新一条注入');
    assert.equal(loaded[0]._needsRewrite, true, '折叠过注入必须标记整份重写');

    // 下一次持久化触发整份重写，磁盘冗余清掉
    await store.persistSession(loaded[0]);
    await store.flush();
    const log = backend._logs.get('s1');
    // 每条注入在日志里出现 3 次（开/闭标签 + dedupeKey 字段），按 key 字段计数
    assert.equal((log.match(/"dedupeKey":"task_todos_check"/g) || []).length, 1, '重写后磁盘只保留最新一条注入');
    assert.equal(loaded[0]._needsRewrite, false, '重写后标志清除，不反复整份重写');
    const again = await store.loadAll(null);
    assert.equal(again[0].messages.length, 3);
    assert.ok(again[0].messages[1].content.includes('共 9 项，7 项已完成'));
    assert.equal(again[0]._needsRewrite, false, '日志干净后加载不再触发重写');
});

test('disk store: tool message updated in place is re-written to disk', async () => {
    const backend = fakeBackend();
    const store = createSessionDiskStore({backend});
    const tool = {role: 'tool', name: 'screenshot', content: '', status: 'running', ts: 2};
    const session = newSession({messages: [{role: 'user', content: 'run', ts: 1}, tool]});
    await store.persistSession(session);
    await store.flush();
    assert.ok(backend._logs.get('s1').includes('"status":"running"'), '运行中的工具消息应已落盘');
    // 工具执行完成：消息对象被就地改写，不新增消息——重启重放不能还读到 running。
    tool.status = 'done';
    tool.content = '截图已保存';
    await store.persistSession(session);
    await store.flush();
    const loaded = await store.loadAll(null);
    assert.equal(loaded[0].messages.length, 2);
    assert.equal(loaded[0].messages[1].status, 'done');
    assert.equal(loaded[0].messages[1].content, '截图已保存');
    // 内容没再变时不应重复追加事件。
    const before = backend._logs.get('s1');
    await store.persistSession(loaded[0]);
    await store.flush();
    assert.equal(backend._logs.get('s1'), before, '无变化时不应重复写事件');
});

test('disk store: approval state updated in place is re-written to disk', async () => {
    const backend = fakeBackend();
    const store = createSessionDiskStore({backend});
    const tool = {
        role: 'tool',
        name: 'run_command',
        content: '等待审批…',
        status: 'pending',
        ts: 2,
        approval: {state: 'pending', command: 'npm test'},
    };
    const session = newSession({messages: [{role: 'user', content: 'test', ts: 1}, tool]});
    await store.persistSession(session);
    await store.flush();
    tool.approval.state = 'approved';
    tool.approval.source = 'user';
    tool.status = 'done';
    tool.content = '全部通过';
    await store.persistSession(session);
    await store.flush();
    const loaded = await store.loadAll(null);
    const replayed = loaded[0].messages[1];
    assert.equal(replayed.status, 'done');
    assert.equal(replayed.approval.state, 'approved');
    assert.equal(replayed.approval.source, 'user');
});

test('disk store: recovered transient messages are rewritten before appending', async () => {
    const backend = fakeBackend();
    const store = createSessionDiskStore({backend});
    const session = newSession({messages: [
        {role: 'user', content: 'run', ts: 1},
        {role: 'tool', name: 'read_file', content: '', status: 'running', ts: 2},
    ]});
    await store.persistSession(session);
    await store.flush();
    // 模拟 normalizeMessage 的恢复收尾：running → error
    const normalize = (raw) => {
        const messages = (raw.messages || []).map((m) => (
            m.status === 'running'
                ? Object.assign({}, m, {status: 'error', content: '执行被中断', _recovered: true})
                : m
        ));
        return Object.assign({}, raw, {messages, _recovered: messages.some((m) => m._recovered)});
    };
    const loaded = await store.loadAll(normalize);
    assert.equal(loaded[0].messages[1].status, 'error');
    loaded[0].messages.push({role: 'assistant', content: 'ok', status: 'done', ts: 3});
    await store.persistSession(loaded[0]);
    await store.flush();
    const log = backend._logs.get('s1');
    assert.ok(!log.includes('"status":"running"'), '恢复后不应再保留 running 状态');
    assert.ok(log.includes('"status":"error"'), '收尾状态应落盘');
});

test('disk store: failed append is retried on next persist', async () => {
    const backend = fakeBackend();
    const original = backend.AISessionAppend;
    let failOnce = true;
    backend.AISessionAppend = async (...args) => {
        if (failOnce) {
            failOnce = false;
            throw new Error('磁盘写入失败');
        }
        return original.apply(backend, args);
    };
    const errors = [];
    const store = createSessionDiskStore({backend, onError: (e) => errors.push(e)});
    const session = newSession({messages: [{role: 'user', content: 'a', ts: 1}]});
    await store.persistSession(session);
    await store.flush();
    assert.equal(errors.length, 1);
    assert.equal(backend._logs.get('s1') || '', '');
    await store.persistSession(session);
    await store.flush();
    const loaded = await store.loadAll(null);
    assert.deepEqual(loaded[0].messages.map((m) => m.content), ['a']);
});

test('disk store: invalidateMessage re-persists mutated approval (classifier source)', async () => {
    const backend = fakeBackend();
    const store = createSessionDiskStore({backend});
    const session = newSession({
        messages: [{role: 'user', content: '帮我看看', ts: 1, status: 'done'}],
    });
    await store.persistSession(session);
    await store.flush();

    // 工具消息先以「无 approval」的中间状态落盘（对应审批判定期间的排队写入）
    const toolMessage = {role: 'tool', name: 'run_command', content: '执行中…', status: 'running', ts: 2};
    session.messages.push(toolMessage);
    await store.persistSession(session);
    await store.flush();
    let loaded = await store.loadAll(null);
    assert.equal(loaded[0].messages[1].approval, undefined, '中间状态落盘时还没有 approval');

    // 分类器放行：补上 approval（autoRule=classifier）→ 必须标记重写，否则旧状态留在日志里
    toolMessage.approval = {state: 'approved', autoRule: 'classifier', actor: 'auto'};
    toolMessage.status = 'done';
    store.invalidateMessage(session, toolMessage);
    await store.persistSession(session);
    await store.flush();

    const log = backend._logs.get('s1');
    assert.ok(log.includes('"autoRule":"classifier"'), '分类器放行来源必须落盘');
    const result = replaySessionLog(log);
    assert.equal(result.messages.length, 2, 'truncate 重写后不应产生重复消息');
    assert.equal(result.messages[1].approval.autoRule, 'classifier');
    assert.equal(result.messages[1]._mid, toolMessage._mid, '重追加沿用同一消息 id');

    loaded = await store.loadAll(null);
    assert.equal(loaded[0].messages.length, 2);
    assert.equal(loaded[0].messages[1].approval.autoRule, 'classifier');
});

test('disk store: manual approval pending state is overwritten by user decision', async () => {
    const backend = fakeBackend();
    const store = createSessionDiskStore({backend});
    const session = newSession({messages: []});
    const toolMessage = {
        role: 'tool', name: 'run_command', content: '等待用户审批命令…', status: 'pending', ts: 1,
        approval: {state: 'pending', kind: 'command'},
    };
    session.messages.push(toolMessage);
    await store.persistSession(session);
    await store.flush();
    let loaded = await store.loadAll(null);
    assert.equal(loaded[0].messages[0].approval.state, 'pending');

    // 用户批准并记住：pending 状态必须被截断重写，而不是永远留在 JSONL 里
    toolMessage.approval.state = 'approved';
    toolMessage.approval.actor = 'user';
    toolMessage.approval.autoRule = 'exact';
    toolMessage.status = 'done';
    toolMessage.content = '命令已执行';
    store.invalidateMessage(session, toolMessage);
    await store.persistSession(session);
    await store.flush();

    const log = backend._logs.get('s1');
    const result = replaySessionLog(log);
    assert.equal(result.messages.length, 1, '不应出现重复消息');
    assert.equal(result.messages[0].approval.state, 'approved');
    assert.equal(result.messages[0].approval.autoRule, 'exact');
    assert.ok(log.includes('"t":"truncate"'), '旧状态由 truncate 事件在重放时移除');
});

test('disk store: invalidateMessage is a no-op for messages never persisted', async () => {
    const backend = fakeBackend();
    const store = createSessionDiskStore({backend});
    const session = newSession({messages: [{role: 'user', content: 'a', ts: 1, status: 'done'}]});
    await store.persistSession(session);
    await store.flush();
    const fresh = {role: 'tool', name: 'run_command', content: 'x', status: 'done', ts: 2};
    session.messages.push(fresh);
    store.invalidateMessage(session, fresh); // 从未落盘：不应破坏 _mids
    session.messages.push({role: 'assistant', content: 'b', ts: 3, status: 'done'});
    await store.persistSession(session);
    await store.flush();
    const loaded = await store.loadAll(null);
    assert.deepEqual(loaded[0].messages.map((m) => m.content), ['a', 'x', 'b']);
});

test('disk store: full rewrite keeps messages whose mid entry was invalidated', async () => {
    const backend = fakeBackend();
    const store = createSessionDiskStore({backend});
    const session = newSession({
        messages: [
            {role: 'user', content: 'a', ts: 1, status: 'done'},
            {role: 'assistant', content: 'b', ts: 2, status: 'done'},
        ],
    });
    await store.persistSession(session);
    await store.flush();
    store.invalidateMessage(session, session.messages[1]); // mid 记账被清空
    session._needsRewrite = true; // 归一化等场景触发整份重写
    await store.persistSession(session);
    await store.flush();
    const loaded = await store.loadAll(null);
    assert.deepEqual(loaded[0].messages.map((m) => m.content), ['a', 'b'], '重写不能丢被失效的消息');
});

// ---------- 轮次起点：会话列表的排序键与时间文案 ----------

test('isTurnBoundaryMessage 只认用户发起的回合边界', () => {
    assert.equal(isTurnBoundaryMessage({role: 'user', content: '你好', ts: 1}), true);
    assert.equal(isTurnBoundaryMessage({role: 'assistant', content: '在', ts: 2}), false);
    assert.equal(isTurnBoundaryMessage({role: 'tool', content: '结果', ts: 3}), false);
    // 轮次提醒 / 待办检查 / 模型切换留痕：机器注入的 user 消息，不是新回合
    assert.equal(isTurnBoundaryMessage({role: 'user', content: '（系统提示）…', ts: 4, systemNote: true}), false);
    // 工具中途自动附加的截图：带 app 与图片但没有 turnStartedAt
    assert.equal(isTurnBoundaryMessage({role: 'user', ts: 5, app: {kind: 'app'}, images: [{mime: 'image/png'}]}), false);
    // 应用入口真正发起的回合带 turnStartedAt，仍然是边界
    assert.equal(isTurnBoundaryMessage({role: 'user', ts: 6, turnStartedAt: 6, app: {kind: 'app'}, images: [{mime: 'image/png'}]}), true);
    // 信箱 notice（子代理结算 / 后台作业退出 / 会话投递折叠的 user 消息）恒在轮中注入：
    // 它有 turnStartedAt（通知到达时刻），但绝不是回合起点——否则轮耗时从通知起算
    assert.equal(isTurnBoundaryMessage({role: 'user', ts: 7, turnStartedAt: 7, notice: true, app: {kind: 'subagent'}}), false);
    assert.equal(isTurnBoundaryMessage({role: 'user', ts: 8, turnStartedAt: 8, notice: true, app: {kind: 'browser'}, images: [{mime: 'image/png'}]}), false);
    assert.equal(isTurnBoundaryMessage(null), false);
    assert.equal(isTurnBoundaryMessage(undefined), false);
});

test('sessionTurnStartTs 停在最后一个回合起点，轮中间注入不让它前进', () => {
    const session = {messages: [
        {role: 'user', content: '第一轮', ts: 1000, turnStartedAt: 1000},
        {role: 'assistant', content: 'a', ts: 1100},
        {role: 'user', content: '第二轮', ts: 2000, turnStartedAt: 2000},
        {role: 'tool', content: '结果', ts: 2100},
        {role: 'user', ts: 2200, app: {kind: 'app'}, images: [{mime: 'image/png'}]},
        {role: 'user', content: '（系统提示）轮次已达 20', ts: 2300, systemNote: true},
        {role: 'assistant', content: 'b', ts: 2400},
    ]};
    assert.equal(sessionTurnStartTs(session), 2000, '截图附加与轮次提醒不能把起点推到 2200/2300');
});

test('sessionTurnStartTs：轮中的信箱 notice 有 turnStartedAt 也不推进起点', () => {
    const session = {messages: [
        {role: 'user', content: '调研一下', ts: 1000, turnStartedAt: 1000},
        {role: 'tool', content: '结果', ts: 1100},
        {role: 'user', content: '［子代理通知］已失败', ts: 3000, turnStartedAt: 3000, notice: true, app: {kind: 'subagent'}},
        {role: 'assistant', content: '重新派单', ts: 3100},
    ]};
    assert.equal(sessionTurnStartTs(session), 1000, '通知到达时刻不能顶替用户发问时刻');
    // 会话列表时间同源：列表不该跳到通知时刻（无 finishedAt，回落发问时间）
    assert.equal(sessionActivityTs(session), 1000);
});

test('sessionTurnStartTs：老数据回落到用户消息 ts，没有用户消息给 0', () => {
    assert.equal(sessionTurnStartTs({messages: [
        {role: 'user', content: '旧数据', ts: 500},
        {role: 'assistant', content: 'x', ts: 600},
    ]}), 500);
    assert.equal(sessionTurnStartTs({messages: []}), 0);
    assert.equal(sessionTurnStartTs({messages: [{role: 'assistant', ts: 9}]}), 0);
    assert.equal(sessionTurnStartTs(undefined), 0);
});

test('sessionActivityTs 在占位与已载体两种形态下给出同一时间键', () => {
    const live = {
        createdAt: 100,
        updatedAt: 900,
        messages: [
            {role: 'user', content: 'q', ts: 700, turnStartedAt: 700},
            {role: 'assistant', content: 'a', ts: 800},
        ],
    };
    const meta = buildSessionMeta(live);
    assert.equal(meta.turnTs, 700, 'meta 要缓存轮次起点，占位阶段才有的可读');
    assert.equal(meta.endTs, 0, '没有 finishedAt 时结束时间为 0');
    const stub = {_stub: true, _turnTs: meta.turnTs, _endTs: meta.endTs, _msgCount: 2, createdAt: 100, updatedAt: 900, messages: []};
    assert.equal(sessionActivityTs(stub), 700);
    assert.equal(sessionActivityTs(live), 700, '补水后不能跳到最后一条消息的 800');
    assert.equal(sessionActivityTs(stub), sessionActivityTs(live), '补水前后不跳位');
});

test('sessionActivityTs：正文里没有用户回合时回落到写入时间', () => {
    assert.equal(sessionActivityTs({createdAt: 100, updatedAt: 900, messages: [{role: 'assistant', content: 'x', ts: 800}]}), 900);
    assert.equal(sessionActivityTs({createdAt: 100, updatedAt: 0, messages: []}), 100);
    assert.equal(sessionActivityTs({_stub: true, _turnTs: 0, createdAt: 100, updatedAt: 900, messages: []}), 900, '老 meta 没有 turnTs 时占位仍按 updatedAt');
    assert.equal(sessionActivityTs(null), 0);
});

// ---- 会话列表排序口径：opencode 模式（2026-11-22 定）----
// 取 max(最近一轮结束时间 finishedAt, 最近发问时间 turnStartedAt)：
// 运行中冻结（工具/流式不推进），一轮结束才前移，用户发新一轮按发问时刻前移。
test('sessionEndTs：只认已收尾 assistant 的 finishedAt，运行中流式回复不算', () => {
    const streaming = {messages: [
        {role: 'user', content: 'q', ts: 1000, turnStartedAt: 1000},
        {role: 'assistant', content: '正在写', ts: 1500, status: 'streaming'},
    ]};
    assert.equal(sessionEndTs(streaming), 0, '流式回复没有 finishedAt，不能当结束时间');

    const done = {messages: [
        {role: 'user', content: 'q', ts: 1000, turnStartedAt: 1000},
        {role: 'tool', content: '结果', ts: 1200},
        {role: 'assistant', content: '完成', ts: 1800, status: 'done', finishedAt: 1800},
    ]};
    assert.equal(sessionEndTs(done), 1800);
    // 取最后一条已收尾回复（多轮场景）
    const multi = {messages: [
        {role: 'user', content: 'q1', ts: 1000, turnStartedAt: 1000},
        {role: 'assistant', content: 'a1', status: 'done', finishedAt: 1500},
        {role: 'user', content: 'q2', ts: 2000, turnStartedAt: 2000},
        {role: 'assistant', content: 'a2', status: 'done', finishedAt: 2600},
    ]};
    assert.equal(sessionEndTs(multi), 2600);
    assert.equal(sessionEndTs({messages: []}), 0);
    assert.equal(sessionEndTs(undefined), 0);
});

test('sessionActivityTs：运行中冻结——工具与流式输出不推进时间', () => {
    const session = {messages: [
        {role: 'user', content: 'q', ts: 1000, turnStartedAt: 1000},
        {role: 'tool', content: '结果', ts: 1500},
        {role: 'tool', content: '又一个结果', ts: 2000},
        {role: 'assistant', content: '还在写', ts: 2500, status: 'streaming'},
    ]};
    assert.equal(sessionActivityTs(session), 1000, '没有 finishedAt 时停在发问时刻，工具刷屏不顶列表');
});

test('sessionActivityTs：一轮结束后按 finishedAt 前移，刚结束的会话排前面', () => {
    const session = {messages: [
        {role: 'user', content: 'q', ts: 1000, turnStartedAt: 1000},
        {role: 'tool', content: '结果', ts: 1500},
        {role: 'assistant', content: '完成', ts: 5000, status: 'done', finishedAt: 5000},
    ]};
    assert.equal(sessionActivityTs(session), 5000, '结束时间晚于发问时间，取结束时间');
    // 与另一个更晚发问但更早结束的会话比较：结束时间决定排序
    const other = {messages: [
        {role: 'user', content: 'q2', ts: 3000, turnStartedAt: 3000},
        {role: 'assistant', content: 'done', ts: 4000, status: 'done', finishedAt: 4000},
    ]};
    assert.ok(sessionActivityTs(session) > sessionActivityTs(other), '刚结束的长会话应排在前面');
});

test('sessionActivityTs：用户发新一轮按发问时刻前移（max 口径）', () => {
    const session = {messages: [
        {role: 'user', content: 'q1', ts: 1000, turnStartedAt: 1000},
        {role: 'assistant', content: 'a1', status: 'done', finishedAt: 6000},
        {role: 'user', content: 'q2', ts: 9000, turnStartedAt: 9000},
        {role: 'assistant', content: '还在写', status: 'streaming'},
    ]};
    assert.equal(sessionActivityTs(session), 9000, '新一轮发问时刻晚于上轮结束，取发问时刻');
});

test('buildSessionMeta 的 endTs：占位沿用缓存，已载体现算，老数据回落 0', () => {
    const live = {messages: [
        {role: 'user', content: 'q', ts: 1000, turnStartedAt: 1000},
        {role: 'assistant', content: 'a', status: 'done', finishedAt: 1800},
    ]};
    assert.equal(buildSessionMeta(live).endTs, 1800);
    assert.equal(buildSessionMeta({_stub: true, _endTs: 777, messages: []}).endTs, 777);
    assert.equal(buildSessionMeta({_stub: true, messages: []}).endTs, 0);
    // 占位排序：endTs 优先于 turnTs
    const stub = {_stub: true, _turnTs: 1000, _endTs: 1800, createdAt: 100, updatedAt: 900};
    assert.equal(sessionActivityTs(stub), 1800);
});

test('buildSessionMeta 的 turnTs：占位沿用缓存，不把现算出来的 0 写回盘', () => {
    const stub = {_stub: true, _turnTs: 777, _msgCount: 3, id: 's1', createdAt: 100, updatedAt: 900, messages: []};
    assert.equal(buildSessionMeta(stub).turnTs, 777);
    assert.equal(buildSessionMeta({_stub: true, id: 's1', createdAt: 100, messages: []}).turnTs, 0);
});

test('buildSessionMeta：worktree 会话态随 meta 持久化（占位与非对象归一）', () => {
    const wt = {name: 'demo-ab12', branch: 'cadt/wt/demo-ab12', path: 'D:/repo/.cadt/worktree/demo-ab12', baseSha: 'abc', createdAt: 5};
    const meta = buildSessionMeta({id: 's1', worktree: wt});
    // 导出状态标记（lastExportReport / lastExportPreviewAt）缺失归一成空值，其余原样保留
    assert.deepEqual(meta.worktree, {...wt, lastExportReport: '', lastExportPreviewAt: 0});
    // 占位会话（_stub）也原样保留 worktree（孤儿判定要占位会话参与）
    const stubMeta = buildSessionMeta({id: 's2', _stub: true, _msgCount: 3, worktree: wt});
    assert.equal(stubMeta.worktree.name, 'demo-ab12');
    // 非法值归一成 null；JSON 往返不失真（含导出标记字段）
    assert.equal(buildSessionMeta({id: 's3'}).worktree, null);
    assert.equal(buildSessionMeta({id: 's4', worktree: 'x'}).worktree, null);
    const marked = {...wt, lastExportReport: 'D:/repo/.cadt/export-reports/r.md', lastExportPreviewAt: 99};
    const round = JSON.parse(JSON.stringify(buildSessionMeta({id: 's5', worktree: marked})));
    assert.equal(round.worktree.path, marked.path);
    assert.equal(round.worktree.lastExportReport, 'D:/repo/.cadt/export-reports/r.md');
    assert.equal(round.worktree.lastExportPreviewAt, 99);
});

test('buildSessionMeta：opencodeSessionId 随 meta 持久化，重启后沿用同一 ID', () => {
    const meta = buildSessionMeta({id: 's1', opencodeSessionId: 'datalens-abc'});
    assert.equal(meta.opencodeSessionId, 'datalens-abc');
    // 缺失归一成空串（读盘时由 normalizeSession 惰性补生成）
    assert.equal(buildSessionMeta({id: 's2'}).opencodeSessionId, '');
    // JSON 往返不失真
    const round = JSON.parse(JSON.stringify(buildSessionMeta({id: 's3', opencodeSessionId: 'datalens-xyz'})));
    assert.equal(round.opencodeSessionId, 'datalens-xyz');
});

test('buildSessionMeta：临时会话标记随 meta 落盘（启动加载据此滤掉）', () => {
    assert.equal(buildSessionMeta({id: 's1', temp: true}).temp, true);
    // 普通会话 / 脏值一律 false：读盘回来的老会话没有这个字段，缺省就是普通会话
    assert.equal(buildSessionMeta({id: 's2'}).temp, false);
    assert.equal(buildSessionMeta({id: 's3', temp: 'yes'}).temp, false);
    // 标记变化必须改变 meta 签名，否则 writeMetaIfChanged 不会补写这个字段
    const sig = (m) => metaSignature(buildSessionMeta(m));
    assert.notEqual(sig({id: 's4'}), sig({id: 's4', temp: true}));
});

test('buildSessionMeta：browserScriptAllow 随 meta 落盘（脚本审批「本会话允许」跨重启保留）', () => {
    const hashes = ['bs-deadbeef', 'bs-cafebabe'];
    const meta = buildSessionMeta({id: 's1', browserScriptAllow: hashes});
    assert.deepEqual(meta.browserScriptAllow, hashes);
    // 缺失归一成空数组；脏值（非字符串 / 空串）剔除
    assert.deepEqual(buildSessionMeta({id: 's2'}).browserScriptAllow, []);
    assert.deepEqual(buildSessionMeta({id: 's3', browserScriptAllow: ['bs-ok', 42, '', null]}).browserScriptAllow, ['bs-ok']);
    // JSON 往返不失真
    const round = JSON.parse(JSON.stringify(meta));
    assert.deepEqual(round.browserScriptAllow, hashes);
    // 集合变化必须改变 meta 签名，否则 writeMetaIfChanged 不会补写
    const sig = (m) => metaSignature(buildSessionMeta(m));
    assert.notEqual(sig({id: 's4'}), sig({id: 's4', browserScriptAllow: ['bs-12345678']}));
});
