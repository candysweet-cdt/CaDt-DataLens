// ai-session-scope.test.mjs：AI 面板「当前会话属于哪个工作区」的判定。
// 回归场景：多窗口共享 ai-config.json 的 activeSessionId，新窗口打开另一个工作区时
// 面板会直接恢复成上一个工作区的对话（见 ai-session-scope.js 头注释）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {decideSessionForWorkspace, activeSessionIdFor, rememberActiveSession, isTransientSession, normalizePath, pickWorkspaceSession, workspaceKey, decideSessionOpen} from '../../../src/ai/session/ai-session-scope.js';
import {createSessionBusyProbe, canStartTurn, canSendMessage, isUnboundSession} from '../../../src/ai/session/ai-session-scope.js';

const MINE = 'd:/work/other'; // 本窗口打开的工作区
const OTHER = 'd:/code/cadt-datalens'; // 上一个窗口（当前会话属于这里）
const OWN_KEY = MINE;

function keyOf(session) {
    return String((session && session.workspace) || '')
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase();
}

function sess(id, workspace, extra = {}) {
    return {id, workspace, updatedAt: 1, ...extra};
}

test('当前会话属于别的工作区：切到本工作区最近的会话', () => {
    const current = sess('s-other', 'D:\\code\\CaDt-DataLens');
    const list = [
        current,
        sess('s-mine-old', MINE, {updatedAt: 10}),
        sess('s-mine-new', 'D:\\Work\\Other', {updatedAt: 50}),
    ];
    const d = decideSessionForWorkspace(current, OWN_KEY, list, keyOf);
    assert.equal(d.action, 'switch');
    assert.equal(d.session.id, 's-mine-new');
});

test('本工作区还没有会话：新建空会话，不沿用别人的对话', () => {
    const current = sess('s-other', OTHER);
    const d = decideSessionForWorkspace(current, OWN_KEY, [current], keyOf);
    assert.equal(d.action, 'create');
    assert.equal(d.session, undefined);
});

test('当前会话已属本工作区：不动（大小写/斜杠归一后一致）', () => {
    const current = sess('s-mine', 'D:\\Work\\Other\\');
    const d = decideSessionForWorkspace(current, OWN_KEY, [current], keyOf);
    assert.equal(d.action, 'keep');
});

test('老会话没有工作区归属：绑定到当前工作区，不换会话', () => {
    const current = sess('s-legacy', '');
    const d = decideSessionForWorkspace(current, OWN_KEY, [current], keyOf);
    assert.equal(d.action, 'bind');
});

// 临时会话（isTransientSession）：只认严格的 temp === true——老会话没有这个字段就是普通会话。
// 这条判定同时是「不绑工作区」与「读盘列表滤掉」两处的单一来源，门一旦放宽就会把
// 普通会话误判成一次性会话（关掉应用就再也看不到）。
test('isTransientSession 只认严格 true', () => {
    assert.equal(isTransientSession({id: 's', temp: true}), true);
    assert.equal(isTransientSession({id: 's'}), false);
    assert.equal(isTransientSession({id: 's', temp: 'true'}), false);
    assert.equal(isTransientSession({id: 's', temp: 1}), false);
    assert.equal(isTransientSession(null), false);
});

test('当前窗口没有工作区（欢迎页）：不做任何切换', () => {
    const current = sess('s-other', OTHER);
    const d = decideSessionForWorkspace(current, '', [current], keyOf);
    assert.equal(d.action, 'keep');
});

test('有回合在跑（busy）：不改看别的会话', () => {
    const current = sess('s-other', OTHER);
    const list = [current, sess('s-mine', MINE, {updatedAt: 10})];
    const d = decideSessionForWorkspace(current, OWN_KEY, list, keyOf, {busy: true});
    assert.equal(d.action, 'keep');
});

test('候选排除归档会话、支线会话与当前会话自身', () => {
    const list = [
        sess('archived', MINE, {updatedAt: 90, archivedAt: 1}),
        sess('side', MINE, {updatedAt: 80, sideOf: 's-parent'}),
        sess('ok', MINE, {updatedAt: 5}),
    ];
    assert.equal(pickWorkspaceSession(list, OWN_KEY, keyOf), list[2]);
    assert.equal(pickWorkspaceSession(list, OWN_KEY, keyOf, 'ok'), null);
    assert.equal(pickWorkspaceSession(list, '', keyOf), null);
});

// ---- 工作区归一 key 与分桶哈希向量（与 Go 侧 sessionstore_test.go 的
// TestWorkspaceBucketKeyVectors 互为镜像，改任一侧必须同步另一侧）----
// 磁盘分桶由 Go 侧 WorkspaceBucketKey 计算（sha256(key) 前 8 hex），前端只把 key
// 用于 UI 分组对账；这里用 node:crypto 复算同一哈希，锁死两端归一语义不漂移。
function bucketKeyOf(workspace) {
    const key = workspaceKey(workspace);
    return key ? createHash('sha256').update(key).digest('hex').slice(0, 8) : '_unbound';
}

test('workspaceKey 归一：反斜杠/尾斜杠/大小写/叠斜杠/点段/协议前缀', () => {
    assert.equal(workspaceKey('D:\\OraSkyC\\Project\\CandySweet\\CaDt-DataLens'), 'd:/oraskyc/project/candysweet/cadt-datalens');
    assert.equal(workspaceKey('D:/OraSkyC/Project/CandySweet/CaDt-DataLens'), 'd:/oraskyc/project/candysweet/cadt-datalens');
    assert.equal(workspaceKey('D:/Foo/Bar/'), 'd:/foo/bar');
    assert.equal(workspaceKey('d:\\Foo\\BAR'), 'd:/foo/bar');
    assert.equal(workspaceKey('D:/mixed//slashes/'), 'd:/mixed/slashes');
    assert.equal(workspaceKey('a/./b/../c'), 'a/c');
    assert.equal(workspaceKey('file://D:/x/y'), 'file://d:/x/y');
    assert.equal(workspaceKey(''), '');
    assert.equal(workspaceKey('   '), '');
    assert.equal(workspaceKey('/'), '');
    assert.equal(normalizePath('a/../../b'), 'b'); // 顶层 .. 无处弹出时被丢弃
});

test('分桶哈希向量与 Go 侧 WorkspaceBucketKey 一致', () => {
    assert.equal(bucketKeyOf('D:\\OraSkyC\\Project\\CandySweet\\CaDt-DataLens'), '35dc7bd8');
    assert.equal(bucketKeyOf('D:/OraSkyC/Project/CandySweet/CaDt-DataLens'), '35dc7bd8');
    assert.equal(bucketKeyOf('D:/Foo/Bar/'), '335d5c8a');
    assert.equal(bucketKeyOf('d:\\Foo\\BAR'), '335d5c8a');
    assert.equal(bucketKeyOf('D:/mixed//slashes/'), '02f5a654');
    assert.equal(bucketKeyOf('a/./b/../c'), '24586ae9');
    assert.equal(bucketKeyOf('file://D:/x/y'), 'd3934be2');
    assert.equal(bucketKeyOf(''), '_unbound');
    assert.equal(bucketKeyOf('   '), '_unbound');
    assert.equal(bucketKeyOf('/'), '_unbound');
});

// ===== 按工作区记录当前会话 =====
// 单值 activeSessionId 多窗口共享，各窗口会互相改写导致面板来回跳（2026-11-19 报告）。
// activeSessionByWorkspace 让每个工作区各记一条，窗口之间不再互相驱动。

test('各工作区各记各的：写一个不影响另一个', () => {
    const config = {activeSessionId: '', activeSessionByWorkspace: {}};
    rememberActiveSession(config, 'd:/a', 's-a');
    rememberActiveSession(config, 'd:/b', 's-b');
    assert.equal(activeSessionIdFor(config, 'd:/a'), 's-a');
    assert.equal(activeSessionIdFor(config, 'd:/b'), 's-b');
    rememberActiveSession(config, 'd:/a', 's-a2');
    assert.equal(activeSessionIdFor(config, 'd:/a'), 's-a2');
    assert.equal(activeSessionIdFor(config, 'd:/b'), 's-b', '另一工作区不该被改写');
});

test('没有本工作区条目时回退全局 activeSessionId（老配置兼容）', () => {
    const config = {activeSessionId: 's-legacy', activeSessionByWorkspace: {}};
    assert.equal(activeSessionIdFor(config, 'd:/a'), 's-legacy');
});

test('欢迎页（没有工作区）只写全局，不清掉各工作区记录', () => {
    const config = {activeSessionId: '', activeSessionByWorkspace: {'d:/a': 's-a'}};
    rememberActiveSession(config, '', 's-x');
    assert.equal(config.activeSessionId, 's-x');
    assert.equal(activeSessionIdFor(config, 'd:/a'), 's-a');
    assert.equal(activeSessionIdFor(config, ''), 's-x');
});

test('id 为空时删掉该工作区记录（并同步清空全局回退值）', () => {
    const config = {activeSessionId: 's-a', activeSessionByWorkspace: {'d:/a': 's-a'}};
    rememberActiveSession(config, 'd:/a', '');
    assert.equal(activeSessionIdFor(config, 'd:/a'), '');
    assert.equal(config.activeSessionId, '');
});

// decideSessionOpen：openWorkspaceFolder 的分支决策单一来源（返回值与 main.js 的
// 四种返回值一一对应）。覆盖 multi-window-session-reuse.md §2 的目标行为。
test('decideSessionOpen：无 dir / 浮窗 → invalid（等价 false）', () => {
    assert.equal(decideSessionOpen({dir: '', currentKey: '', targetKey: 'd:/a'}).action, 'invalid');
    assert.equal(decideSessionOpen({dir: 'D:/a', isFloat: true, currentKey: 'd:/b', targetKey: 'd:/a'}).action, 'invalid');
});

test('decideSessionOpen：本窗口已是该工作区 → same；无工作区 → current', () => {
    assert.equal(decideSessionOpen({dir: 'D:/a', currentKey: 'd:/a', targetKey: 'd:/a'}).action, 'same');
    assert.equal(decideSessionOpen({dir: 'D:/a', currentKey: '', targetKey: 'd:/a'}).action, 'current');
});

test('decideSessionOpen：复用命中 → reused（优先于软切换，本窗口不动）', () => {
    const state = {dir: 'D:/a', currentKey: 'd:/b', targetKey: 'd:/a', reuseHit: true, canSoftSwitch: true};
    assert.equal(decideSessionOpen(state).action, 'reused');
});

test('decideSessionOpen：无复用 → window（软切换），仅当后端有新窗口能力', () => {
    assert.equal(decideSessionOpen({dir: 'D:/a', currentKey: 'd:/b', targetKey: 'd:/a', canSoftSwitch: true}).action, 'window');
    assert.equal(decideSessionOpen({dir: 'D:/a', currentKey: 'd:/b', targetKey: 'd:/a', canNewWindow: true}).action, 'window');
    assert.equal(decideSessionOpen({dir: 'D:/a', currentKey: 'd:/b', targetKey: 'd:/a'}).action, 'invalid',
        '两个后端都没有时不假报 window');
});

// ===== 会话忙判定与「能不能起一轮」的统一构件 =====
// 改造前 20+ 处手写 `streamOf(id) || compactOf(id)`，「能不能发」这门禁则有四套各缺一截的
// 版本（UI 按钮不判忙、起轮内核完整、原地编辑保存漏 _loadError、队列冲刷漏 _loadError）。
// 这组用例锁住构件的语义：哪些维度归它判、哪些**刻意不判**。

test('isSessionBusy：流 / 压缩 / streams.has 任一命中即忙', () => {
    const streams = new Map([['s-stream', {sessionId: 's-stream'}]]);
    const isBusy = createSessionBusyProbe({
        streams,
        compactOf: (id) => (id === 's-compact' ? {sessionId: 's-compact'} : null),
    });
    assert.equal(isBusy('s-stream'), true, '注册表里有流就算忙');
    assert.equal(isBusy('s-compact'), true, '正在压缩也算忙');
    assert.equal(isBusy('s-idle'), false);
    // 空 id 不该命中任何键（历史上 streamOf('') 曾被当成「当前会话」）
    assert.equal(isBusy(''), false);
    assert.equal(isBusy(null), false);
    assert.equal(isBusy(undefined), false);
});

test('isSessionBusy：只给 streamOf 时同样生效；什么依赖都没给时恒 false（测试桩）', () => {
    const withStreamOf = createSessionBusyProbe({streamOf: (id) => (id === 's1' ? {sessionId: 's1'} : null)});
    assert.equal(withStreamOf('s1'), true);
    assert.equal(withStreamOf('s2'), false);
    assert.equal(createSessionBusyProbe(null)('s1'), false, '缺省依赖时不能抛错');
});

// compactStarting 是**全局**的「压缩正在准备」窗口（startCompact 拿租约 / 按 stat 重读期间），
// 不属于任何单个会话。默认不判：否则一个会话开始压缩会拦住所有会话的发送门禁。
// 起轮内核与它同源的守卫显式传 includeCompactStarting。
test('isSessionBusy：compactStarting 是全局标志，只有显式要求才算忙', () => {
    const isBusy = createSessionBusyProbe({compactStartingOf: () => true});
    assert.equal(isBusy('s-any'), false, '默认不把全局的压缩准备算到某个会话头上');
    assert.equal(isBusy('s-any', {includeCompactStarting: true}), true);
    assert.equal(createSessionBusyProbe({compactStartingOf: () => false})('s-any', {includeCompactStarting: true}), false);
    // 装配方没有 getter 时也支持直接给值
    assert.equal(createSessionBusyProbe({compactStarting: true})('s', {includeCompactStarting: true}), true);
});

test('canStartTurn：内核的五个维度齐全，_stub 刻意不算拦截理由', () => {
    const live = {id: 's1'};
    assert.deepEqual(canStartTurn(live, {}), {ok: true, reason: ''});
    assert.equal(canStartTurn(null).reason, 'no_session');
    assert.equal(canStartTurn({}).reason, 'no_session');
    assert.equal(canStartTurn(live, {sessionsPending: true}).reason, 'sessions_pending');
    // 正文读取失败的会话写盘被写保护：这一轮只留在内存、重启即丢 —— 必须拒
    assert.equal(canStartTurn({id: 's1', _loadError: 'session-too-large'}).reason, 'load_failed');
    assert.equal(canStartTurn(live, {busy: true}).reason, 'busy');
    assert.equal(canStartTurn({id: 's1', archivedAt: 1}).reason, 'archived');
    // 懒加载占位不是拒绝理由：正文没读上来不等于发不出去，起轮内核会先 ensureSessionLoaded。
    // 在这里拦会把「后台通知 / 队列投递到没点开过的会话」这条支持路径一起堵死。
    assert.deepEqual(canStartTurn({id: 's1', _stub: true}, {}), {ok: true, reason: ''});
});

test('canStartTurn 的 reason 优先级与起轮内核的历史顺序一致', () => {
    // 归档 + 忙：内核先判忙再判归档
    assert.equal(canStartTurn({id: 's1', archivedAt: 1}, {busy: true}).reason, 'busy');
    // 读取失败优先于忙：读取失败的会话连新一轮都不该起
    assert.equal(canStartTurn({id: 's1', _loadError: 'x'}, {busy: true}).reason, 'load_failed');
    // 会话列表还没读回来时任何会话都不能发（落到占位会话上会丢消息）
    assert.equal(canStartTurn({id: 's1', _loadError: 'x'}, {sessionsPending: true}).reason, 'sessions_pending');
});

test('canSendMessage：忙不禁用（生成中点击是排队 / 插话 / 抢占三手势）', () => {
    assert.deepEqual(canSendMessage({id: 's1'}, {busy: true}), {ok: true, reason: ''},
        '生成中发送按钮仍可用：点击走排队，禁用了三手势就没了');
    assert.equal(canSendMessage({id: 's1', archivedAt: 1}).reason, 'archived');
    assert.equal(canSendMessage({id: 's1', _loadError: 'x'}).reason, 'load_failed');
    assert.equal(canSendMessage(null).reason, 'no_session');
    assert.equal(canSendMessage({id: 's1'}, {sessionsPending: true}).reason, 'sessions_pending');
});

test('isUnboundSession：临时会话与会话沙盒都算「不绑定工作区」，脏值不算', () => {
    assert.equal(isUnboundSession({temp: true}), true);
    assert.equal(isUnboundSession({noWorkspace: true}), true);
    assert.equal(isUnboundSession({}), false);
    assert.equal(isUnboundSession(null), false);
    // 只认严格 true：老会话没有这些字段，缺省即普通会话
    assert.equal(isUnboundSession({temp: 'true'}), false);
    assert.equal(isUnboundSession({noWorkspace: 1}), false);
});
