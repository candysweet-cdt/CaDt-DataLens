// ai-session-list：会话右键菜单组装（buildSessionMenuItems）纯函数测试。
// 规则：不适用的项直接不出现——支线才有「提升为独立会话」、信箱有积压才有「清空信箱」、
// 磁盘存储才有「复制会话路径」；普通对话不再出现一排灰掉的无关项。
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSessionMenuItems, buildWorkspaceMenuItems, buildSubgroupMenuItems, subgroupFolded, aggregateSessionBadge, planPendingNeedsAttention, workspaceGroupExpanded, sessionOverLimitOf, sessionOverLimitTip, sessionFilterHit, buildWorkspaceSubgroups, subgroupPageKey, orderSessionsWithOrchestration} from '../../../src/ai/session/ai-session-list.js';
import {ICONS} from '../../../src/core/icons.js';

const baseEnv = {pendingNoticeCount: () => 0, diskStorage: true};
const labelsOf = (items) => items.filter((item) => item.label).map((item) => item.label);

test('普通会话：不出现「提升为独立会话」「清空信箱」，出现两个复制项', () => {
    const session = {id: 's1', pinned: false};
    const items = buildSessionMenuItems(session, baseEnv);
    const labels = labelsOf(items);
    assert.ok(!labels.includes('提升为独立会话'), '非支线不应有提升项');
    assert.ok(!labels.some((l) => l.startsWith('清空信箱')), '无积压不应有清空信箱');
    assert.ok(labels.includes('复制会话ID'));
    assert.ok(labels.includes('复制会话路径'));
    // act 键齐全：每个非 sep 项都能映射到真实动作
    for (const item of items) {
        if (!item.sep) assert.ok(item.act, '菜单项缺少 act 键: ' + JSON.stringify(item));
    }
});

test('支线会话：出现「提升为独立会话」', () => {
    const items = buildSessionMenuItems({id: 's2', sideOf: 's1'}, baseEnv);
    const item = items.find((it) => it.act === 'promote');
    assert.ok(item, '支线应有提升项');
    assert.equal(item.label, '提升为独立会话');
});

test('会话菜单不再有「在新窗口打开」：强制新开出口已移除，复用是唯一行为', () => {
    // 2026-11-20 移除该出口（作者裁定）：有工作区归属 / 兜底当前工作区都不再出现；
    // 工作区分组头菜单的「在新窗口打开此工作区」不受影响（buildWorkspaceMenuItems 单独测）
    const withWs = buildSessionMenuItems({id: 's7', workspace: 'D:/repos/foo'}, baseEnv);
    assert.ok(!withWs.some((it) => it.act === 'openNewWindow'), '有工作区也不应出现「在新窗口打开」');
    const fallback = buildSessionMenuItems(
        {id: 's7'},
        {pendingNoticeCount: () => 0, diskStorage: true, currentWorkspace: 'D:/repos/cur'},
    );
    assert.ok(!fallback.some((it) => it.act === 'openNewWindow'), '兜底当前工作区也不应出现「在新窗口打开」');
});

test('信箱积压：N 条才出现「清空信箱（N 条）」，0 条不出现', () => {
    const withPending = buildSessionMenuItems(
        {id: 's3'},
        {pendingNoticeCount: () => 2, diskStorage: false},
    );
    const item = withPending.find((it) => it.act === 'clearMailbox');
    assert.ok(item, '有积压应有清空信箱');
    assert.equal(item.label, '清空信箱（2 条）');
    const empty = buildSessionMenuItems({id: 's3'}, baseEnv);
    assert.ok(!empty.some((it) => it.act === 'clearMailbox'), '无积压不应有清空信箱');
});

test('内存/legacy 模式：不出现「复制会话路径」，保留「复制会话ID」', () => {
    const items = buildSessionMenuItems({id: 's4'}, {pendingNoticeCount: () => 0, diskStorage: false});
    const labels = labelsOf(items);
    assert.ok(!labels.includes('复制会话路径'));
    assert.ok(labels.includes('复制会话ID'));
});

test('置顶与归档：标签切换、归档会话的置顶项禁用', () => {
    const pinned = buildSessionMenuItems({id: 's5', pinned: true}, baseEnv);
    assert.ok(labelsOf(pinned).includes('取消置顶'));
    const archived = buildSessionMenuItems({id: 's5', archivedAt: 123}, baseEnv);
    const labels = labelsOf(archived);
    assert.ok(labels.includes('取消归档'));
    assert.ok(labels.includes('归档会话') === false);
    assert.equal(archived.find((it) => it.act === 'togglePin').disabled, true);
    const normal = buildSessionMenuItems({id: 's5'}, baseEnv);
    assert.ok(labelsOf(normal).includes('置顶会话'));
    assert.ok(labelsOf(normal).includes('归档会话'));
});

test('结构不变量：删除会话恒在末尾且 danger；归档紧挨它上面；分隔线不夹空段', () => {
    const items = buildSessionMenuItems({id: 's6'}, baseEnv);
    const last = items[items.length - 1];
    assert.equal(last.label, '删除会话');
    assert.equal(last.danger, true);
    // 归档紧挨删除上方（图 2 的底部布局：归档 → 永久删除）
    assert.equal(items[items.length - 2].label, '归档会话');
    for (let i = 1; i < items.length; i++) {
        assert.ok(!(items[i].sep && items[i - 1].sep), '连续两条分隔线');
    }
    assert.equal(items[0].label, '新建会话');
});

test('归档/取消归档：已归档会话倒数第二项切成「取消归档」且用 unarchive 图标', () => {
    const items = buildSessionMenuItems({id: 's9', archivedAt: 123}, baseEnv);
    const archive = items[items.length - 2];
    assert.equal(archive.label, '取消归档');
    assert.equal(archive.icon, 'unarchive');
    const normal = buildSessionMenuItems({id: 's9'}, baseEnv);
    assert.equal(normal[normal.length - 2].icon, 'archive');
});

test('每个菜单项都有已注册的图标（菜单图标不缺、不拼错）', () => {
    for (const session of [{id: 'a'}, {id: 'b', sideOf: 'a'}, {id: 'c', archivedAt: 1}]) {
        const env = {pendingNoticeCount: () => 3, diskStorage: true};
        for (const item of buildSessionMenuItems(session, env)) {
            if (item.sep) continue;
            assert.ok(item.icon, '菜单项缺 icon: ' + item.label);
            assert.ok(ICONS[item.icon], '图标未注册: ' + item.icon + '（' + item.label + '）');
        }
    }
});

// 工作区分组头「⋯」菜单：有路径给完整工作区操作、无路径只给打开类、关闭仅当前工作区出现。
const wsEnv = (recent = []) => ({recent, baseName: (p) => String(p || '').split('/').pop()});

test('工作区菜单（有路径，非当前）：资源管理器/复制路径/新窗口/新建会话，无关闭', () => {
    const items = buildWorkspaceMenuItems({path: 'D:/repos/foo', current: false}, wsEnv());
    const labels = labelsOf(items);
    assert.ok(labels.includes('在文件资源管理器中显示'));
    assert.ok(labels.includes('复制工作区路径'));
    assert.ok(labels.includes('在新窗口打开此工作区'));
    assert.ok(labels.includes('在此工作区新建会话'));
    assert.ok(labels.includes('打开文件夹…'));
    assert.ok(!labels.includes('关闭当前工作区'));
    // 每个非分隔、非子菜单项都要有 act
    for (const item of items) {
        if (!item.sep && !item.submenu) assert.ok(item.act, '缺少 act: ' + JSON.stringify(item));
    }
});

test('工作区菜单（当前工作区）：新窗口项禁用，出现关闭当前工作区', () => {
    const items = buildWorkspaceMenuItems({path: 'D:/repos/foo', current: true}, wsEnv());
    const labels = labelsOf(items);
    assert.ok(labels.includes('关闭当前工作区'));
    assert.equal(items.find((it) => it.act === 'openNewWindow').disabled, true);
});

test('工作区菜单（未关联工作区）：只给打开类，无路径相关项与关闭', () => {
    const items = buildWorkspaceMenuItems({path: '', current: false}, wsEnv());
    const labels = labelsOf(items);
    assert.ok(labels.includes('打开文件夹…'));
    assert.ok(!labels.includes('复制工作区路径'));
    assert.ok(!labels.includes('关闭当前工作区'));
});

test('工作区菜单：最近打开以子菜单给出，act=openRecent 带路径', () => {
    const items = buildWorkspaceMenuItems(
        {path: 'D:/repos/foo', current: true},
        wsEnv([{path: 'D:/repos/bar', name: 'bar'}, {path: 'D:/repos/baz'}]),
    );
    const recentItem = items.find((it) => it.submenu);
    assert.ok(recentItem, '应有最近打开子菜单');
    assert.equal(recentItem.submenu.length, 2);
    assert.equal(recentItem.submenu[0].label, 'bar');
    assert.equal(recentItem.submenu[0].act, 'openRecent');
    assert.equal(recentItem.submenu[0].arg, 'D:/repos/bar');
    assert.equal(recentItem.submenu[1].label, 'baz', '无 name 时回退 baseName');
});

// 活动栏会话图标状态点：按 error > pending > done 取最高，仅当前工作区，running 忽略。
const badgeEnv = (statusMap, {currentKey = 'ws-a', keyOf = () => 'ws-a'} = {}) => ({
    sessionStatus: (s) => statusMap[s.id] || '',
    workspaceKeyOf: keyOf,
    currentWorkspaceKey: () => currentKey,
});

test('状态点优先级：error > pending > done，全无则空', () => {
    const sessions = [{id: 'e'}, {id: 'p'}, {id: 'd'}];
    assert.equal(aggregateSessionBadge(sessions, badgeEnv({e: 'error', p: 'pending', d: 'done'})), 'error');
    assert.equal(aggregateSessionBadge(sessions, badgeEnv({p: 'pending', d: 'done'})), 'pending');
    assert.equal(aggregateSessionBadge(sessions, badgeEnv({d: 'done'})), 'done');
    assert.equal(aggregateSessionBadge(sessions, badgeEnv({})), '');
});

test('状态点忽略 running 与空状态', () => {
    const sessions = [{id: 'r'}, {id: 'n'}];
    assert.equal(aggregateSessionBadge(sessions, badgeEnv({r: 'running', n: ''})), '');
    // running 不该压过 done
    assert.equal(aggregateSessionBadge(sessions, badgeEnv({r: 'running', n: 'done'})), 'done');
});

test('状态点仅统计当前工作区；当前键为空一律不显示', () => {
    const sessions = [{id: 'e'}, {id: 'p'}];
    const keyOf = (s) => (s.id === 'e' ? 'ws-b' : 'ws-a');
    assert.equal(aggregateSessionBadge(sessions, badgeEnv({e: 'error', p: 'done'}, {keyOf})), 'done',
        'error 属于别的工作区，不该计入');
    assert.equal(aggregateSessionBadge(sessions, badgeEnv({e: 'error'}, {currentKey: ''})), '',
        '未打开工作区不显示');
});

test('状态点跳过归档会话', () => {
    const sessions = [{id: 'e', archivedAt: 123}, {id: 'p'}];
    assert.equal(aggregateSessionBadge(sessions, badgeEnv({e: 'error', p: 'pending'})), 'pending',
        '归档的 error 不该计入');
});

test('状态点透传被抑制的状态（正在查看的会话返回空，不产生点）', () => {
    const sessions = [{id: 'viewed'}];
    assert.equal(aggregateSessionBadge(sessions, badgeEnv({viewed: ''})), '');
});

// 计划待批准的 pending/info 角标：AI 正在为该计划工作时（流挂着）不该报「待用户动手」。
const planSession = (over = {}) => ({
    id: 's1', planMode: true, activePlan: {status: 'pending', markdown: '# 计划'}, messages: [], ...over,
});

test('planPendingNeedsAttention：待批准且无流 → 需要用户注意', () => {
    assert.equal(planPendingNeedsAttention(planSession(), false), true);
});

test('planPendingNeedsAttention：AI 正在为该计划工作（有流）→ 不需要注意', () => {
    assert.equal(planPendingNeedsAttention(planSession(), true), false,
        '继续规划后新一轮在跑，列表应显示 running 而非 pending(info)');
});

test('planPendingNeedsAttention：非 pending / 非计划模式 / 无计划 → 不需要注意', () => {
    assert.equal(planPendingNeedsAttention(planSession({activePlan: {status: 'approved'}}), false), false);
    assert.equal(planPendingNeedsAttention(planSession({planMode: false}), false), false);
    assert.equal(planPendingNeedsAttention(planSession({activePlan: null}), false), false);
    assert.equal(planPendingNeedsAttention(null, false), false);
});

test('planPendingNeedsAttention：用户已对计划发言（继续规划讨论中）→ 不需要注意', () => {
    // 计划提交（ts=0）后用户发过修订意见：审批卡已收起、横条已收起，角标不该再挂「待批准」
    assert.equal(planPendingNeedsAttention(planSession({
        activePlan: {status: 'pending', markdown: '# 计划', ts: 0},
        messages: [{role: 'user', ts: 5}],
    }), false), false, '继续规划讨论轮结束后，info 角标不应出现');
});

test('planPendingNeedsAttention：计划重新提交（ts 晚于用户最后发言）→ 角标回来', () => {
    // 修订轮 AI 重新 submit_plan：新计划 awaiting 决策，角标应重新出现
    assert.equal(planPendingNeedsAttention(planSession({
        activePlan: {status: 'pending', markdown: '# 计划 v2', ts: 10},
        messages: [{role: 'user', ts: 5}],
    }), false), true);
});

// 工作区分组默认展开：只展开当前工作区，其余收起；用户显式切换过则尊重其选择。
const groupEnv = (currentKey, override = new Map(), firstKey = '') => ({override, currentKey: () => currentKey, firstKey});

test('分组默认展开：当前工作区展开，其余收起', () => {
    const env = groupEnv('ws-a', new Map(), 'ws-a');
    assert.equal(workspaceGroupExpanded('ws-a', {current: true}, env), true, '当前工作区默认展开');
    assert.equal(workspaceGroupExpanded('ws-b', {current: false}, env), false, '其他工作区默认收起');
    assert.equal(workspaceGroupExpanded('', {current: false}, env), false, '未关联分组默认收起');
});

test('分组默认展开：未打开工作区时展开第一个分组', () => {
    const env = groupEnv('', new Map(), 'ws-b');
    assert.equal(workspaceGroupExpanded('ws-b', {current: false}, env), true, '第一个分组展开');
    assert.equal(workspaceGroupExpanded('ws-c', {current: false}, env), false, '其余仍收起');
});

// 多工作区（窗口没绑定工作区）默认展开的是**聚焦会话所在的组**，不是按名字序的第一组。
// 踩过的坑：把「不置顶排序」和「展开哪一组」当成同一个开关，结果重启后当前会话那组收着、
// 不相干的组开着。
test('分组默认展开：多工作区跟聚焦会话所在组，而不是第一个组', () => {
    const env = {
        override: new Map(),
        currentKey: () => '',            // 多工作区：窗口没有绑定工作区
        focusedKey: () => 'ws-modedev',  // 但聚焦会话属于 ws-modedev
        firstKey: 'ws-aaa',              // 名字序第一组是别人
    };
    assert.equal(workspaceGroupExpanded('ws-modedev', {current: false}, env), true,
        '聚焦会话所在的组必须展开');
    assert.equal(workspaceGroupExpanded('ws-aaa', {current: false}, env), false,
        '名字序第一组不该因为排序而展开');
    // 用户显式折叠过就听用户的
    const env2 = {...env, override: new Map([['ws-modedev', false]])};
    assert.equal(workspaceGroupExpanded('ws-modedev', {current: false}, env2), false,
        'override 优先于聚焦组');
});

test('分组默认展开：focusedKey 缺失时回落到旧规则（不破坏单工作区与老调用）', () => {
    const env = groupEnv('ws-a', new Map(), 'ws-a');
    assert.equal(workspaceGroupExpanded('ws-a', {current: true}, env), true, '仍按当前工作区展开');
    const env2 = groupEnv('', new Map(), 'ws-b');
    assert.equal(workspaceGroupExpanded('ws-b', {current: false}, env2), true, '仍展开第一个');
});

test('分组默认展开：显式切换覆盖默认（记住用户选择）', () => {
    const override = new Map([['ws-b', true], ['ws-a', false]]);
    const env = groupEnv('ws-a', override, 'ws-a');
    assert.equal(workspaceGroupExpanded('ws-b', {current: false}, env), true, '手动展开的非当前分组保持展开');
    assert.equal(workspaceGroupExpanded('ws-a', {current: true}, env), false, '手动收起的当前分组保持收起');
});

test('sessionOverLimitOf：判定线=读取上限 256 MB（严格超限）；live 主导/整理失败直接亮；占位不判定', () => {
    const READ = 256 * 1024 * 1024;
    assert.equal(sessionOverLimitOf(null), false);
    assert.equal(sessionOverLimitOf({id: 'a'}), false, '正常会话不亮');
    assert.equal(sessionOverLimitOf({id: 'b', _stub: true, _logStat: {exists: true, size: READ * 2}}), false, '占位没有 stat 不判定');
    assert.equal(sessionOverLimitOf({id: 'c', _liveDominant: true}), true, 'live 主导');
    assert.equal(sessionOverLimitOf({id: 'd', _tidyFailed: true}), true, '自动整理失败');
    assert.equal(sessionOverLimitOf({id: 'e', _logStat: {exists: true, size: READ + 1}}), true, '越过 256 MB 线');
    assert.equal(sessionOverLimitOf({id: 'f', _logStat: {exists: true, size: READ}}), false, '恰好等于上限不亮');
    assert.equal(sessionOverLimitOf({id: 'e64', _logStat: {exists: true, size: 221.5 * 1048576}}), false, '221 MB 能正常打开，不亮');
    assert.equal(sessionOverLimitOf({id: 'g', _logStat: {exists: false, size: READ * 9}}), false, '正文不存在不亮');
    assert.equal(sessionOverLimitOf({id: 'h', _stub: true, _liveDominant: true}), true, '失败标记优先于占位');
});

test('sessionOverLimitTip：按来源分级给动作指引', () => {
    assert.ok(sessionOverLimitTip({_liveDominant: true, _logStat: {exists: true, size: 270 * 1048576}}).includes('临时加载'), 'live 主导给临时加载指引');
    assert.ok(sessionOverLimitTip({_tidyFailed: true, _logStat: {exists: true, size: 300 * 1048576}}).includes('重试'), '整理失败给重试指引');
    assert.ok(sessionOverLimitTip({_logStat: {exists: true, size: 300 * 1048576}}).includes('自动整理'), 'stat 超限给自动整理说明');
    assert.ok(sessionOverLimitTip({_logStat: {exists: true, size: 300 * 1048576}}).includes('300 MB'), '带人可读体积');
});

// 会话过滤（侧栏漏斗）：sessionFilterHit 纯函数——标题 / 会话 ID 子串、大小写不敏感。
test('sessionFilterHit：按标题或会话 ID 子串命中，大小写不敏感', () => {
    const session = {id: 'sess-AbC-123', title: '重构 explorer 域'};
    assert.equal(sessionFilterHit(session, 'explorer'), true, '标题命中');
    assert.equal(sessionFilterHit(session, 'EXPLORER'), true, '标题大小写不敏感');
    assert.equal(sessionFilterHit(session, 'abc-123'), true, 'ID 命中（大小写不敏感）');
    assert.equal(sessionFilterHit(session, '不存在'), false, '都不含则不命中');
    assert.equal(sessionFilterHit({id: 's1'}, ''), true, '空词 = 不过滤，全命中');
    assert.equal(sessionFilterHit({id: 's1'}, '   '), true, '纯空白 = 不过滤，全命中');
});

test('sessionFilterHit：无标题会话按显示文案「新会话」命中', () => {
    // 列表里无标题会话显示「新会话」——过滤词跟着看到的文字走，输入「新」能命中
    assert.equal(sessionFilterHit({id: 's1', title: ''}, '新会话'), true);
    assert.equal(sessionFilterHit({id: 's1'}, '新'), true);
    assert.equal(sessionFilterHit(null, ''), true, '空词时缺会话对象也放行');
    assert.equal(sessionFilterHit(null, 'x'), false, '有词时缺会话对象不命中');
});

test('会话菜单有「设置分组…」项（tag 图标已注册）', () => {
    const item = buildSessionMenuItems({id: 's1'}, baseEnv).find((it) => it.act === 'setGroup');
    assert.ok(item, '应有设置分组项');
    assert.equal(item.label, '设置分组…');
    assert.ok(ICONS[item.icon], '设置分组图标应已注册');
});

test('buildWorkspaceSubgroups：按 group 切桶，未分组置底', () => {
    const list = [
        {id: 'a', group: '前端'},
        {id: 'b', group: ''},
        {id: 'c', group: '后端'},
        {id: 'd', group: '前端'},
        {id: 'e', group: '   '}, // 纯空白归未分组
    ];
    const subs = buildWorkspaceSubgroups(list);
    assert.deepEqual(subs.map((s) => s.name).slice().sort(), ['', '前端', '后端'], '三个桶齐全');
    assert.equal(subs[subs.length - 1].name, '', '未分组恒置底');
    const bucket = (name) => subs.find((s) => s.name === name);
    assert.deepEqual(bucket('前端').sessions.map((s) => s.id), ['a', 'd'], '同组会话归一起');
    assert.deepEqual(bucket('').sessions.map((s) => s.id), ['b', 'e'], '空与纯空白都归未分组');
    assert.equal(subs.reduce((n, s) => n + s.sessions.length, 0), 5, '不丢会话');
});

test('buildWorkspaceSubgroups：无分组时只有一个未分组桶（渲染层据此不加子头）', () => {
    const subs = buildWorkspaceSubgroups([{id: 'a'}, {id: 'b'}]);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].name, '');
    assert.equal(subs[0].sessions.length, 2);
    assert.deepEqual(buildWorkspaceSubgroups(null), [], '空输入不报错');
});

test('subgroupPageKey：归档标志 + 工作区 + 子分组名三段唯一', () => {
    assert.equal(subgroupPageKey(false, 'ws1', '前端'), 'active:ws1:前端');
    assert.equal(subgroupPageKey(true, 'ws1', '前端'), 'archived:ws1:前端');
    assert.notEqual(subgroupPageKey(false, 'ws1', '前端'), subgroupPageKey(false, 'ws1', '后端'), '不同子分组分页互不影响');
    assert.equal(subgroupPageKey(false, 'ws1', ''), 'active:ws1:', '未分组桶也有独立键');
});

// 自定义子分组头「⋯」菜单：命名分组给重命名/新建/解散，未分组只给新建，归档区不给新建。
// groupKey 为空（未关联工作区）的桶没有工作区归属，新建会错绑当前工作区，故也不给新建。
test('子分组菜单（命名分组，进行中）：重命名 / 在此新建 / 解散，解散带条数', () => {
    const sub = {name: '前端', sessions: [{id: 'a'}, {id: 'b'}, {id: 'c'}]};
    const items = buildSubgroupMenuItems(sub, {archived: false, groupKey: 'ws1'});
    const labels = labelsOf(items);
    assert.ok(labels.includes('重命名分组…'));
    assert.ok(labels.includes('在此分组新建会话'));
    assert.ok(labels.some((l) => l.includes('解散分组') && l.includes('3 条')), '解散项带组内条数');
    for (const item of items) {
        if (!item.sep) assert.ok(item.act, '缺少 act: ' + JSON.stringify(item));
    }
});

test('子分组菜单（未分组，有工作区）：只给在此新建，无重命名/解散', () => {
    const items = buildSubgroupMenuItems({name: '', sessions: [{id: 'a'}]}, {archived: false, groupKey: 'ws1'});
    const labels = labelsOf(items);
    assert.deepEqual(labels, ['在此分组新建会话']);
});

test('子分组菜单（未关联工作区）：不给新建，只有命名分组的重命名/解散', () => {
    const ungrouped = buildSubgroupMenuItems({name: '', sessions: [{id: 'a'}]}, {archived: false, groupKey: ''});
    assert.deepEqual(labelsOf(ungrouped), [], '未关联工作区的未分组桶没有任何操作');
    const named = buildSubgroupMenuItems({name: '前端', sessions: [{id: 'a'}]}, {archived: false, groupKey: ''});
    assert.ok(!labelsOf(named).includes('在此分组新建会话'), '未关联工作区不该新建（会错绑当前工作区）');
    assert.ok(labelsOf(named).includes('重命名分组…'));
});

test('子分组菜单（归档区）：命名分组也不给新建，仍可重命名/解散', () => {
    const items = buildSubgroupMenuItems({name: '前端', sessions: [{id: 'a'}]}, {archived: true, groupKey: 'ws1'});
    const labels = labelsOf(items);
    assert.ok(!labels.includes('在此分组新建会话'), '归档区不该新建会话');
    assert.ok(labels.includes('重命名分组…'));
    assert.ok(labels.some((l) => l.includes('解散分组')));
});

test('子分组菜单：每个非分隔项图标已注册', () => {
    for (const sub of [{name: '前端', sessions: [{}, {}]}, {name: '', sessions: [{}]}]) {
        for (const item of buildSubgroupMenuItems(sub, {archived: false, groupKey: 'ws1'})) {
            if (item.sep) continue;
            assert.ok(item.icon, '菜单项缺 icon: ' + item.label);
            assert.ok(ICONS[item.icon], '图标未注册: ' + item.icon + '（' + item.label + '）');
        }
    }
});

test('subgroupFolded：默认展开，仅显式折叠过才收起', () => {
    const folded = new Set(['active:ws1:前端']);
    assert.equal(subgroupFolded('active:ws1:前端', {folded}), true, '显式折叠的桶收起');
    assert.equal(subgroupFolded('active:ws1:后端', {folded}), false, '没折叠过的默认展开');
    assert.equal(subgroupFolded('x', {}), false, '无 folded 集合不报错，默认展开');
});


test('编排批次会话紧跟发起会话，parentSessionId 优先于活跃度排序', () => {
    const list = [
        {id: 'other', title: '别的'},
        {id: 'child-2', title: 'B2', orchestration: {role: 'work', parentSessionId: 'parent', batchId: 'B2'}},
        {id: 'parent', title: '发起'},
        {id: 'child-1', title: 'B1', orchestration: {role: 'work', parentSessionId: 'parent', batchId: 'B1'}},
    ];
    const ids = orderSessionsWithOrchestration(list).map((s) => s.id);
    assert.deepEqual(ids, ['other', 'parent', 'child-2', 'child-1']);

    // 父会话已删除 / parentSessionId 悬空：批次回落普通会话，渲染不能少一条
    const orphan = [{id: 'child', orchestration: {role: 'work', parentSessionId: 'gone'}}];
    assert.deepEqual(orderSessionsWithOrchestration(orphan).map((s) => s.id), ['child']);
});
