// ai-session-list.js：会话列表域（侧栏列表/工作区分组/未读标记 + 会话搜索 + 列表与会话右键菜单）。
// 从 ai-panel.js 拆出（docs/unfinished-plans/structure-cleanup.md 阶段 3），函数体逐字搬移；
// sessions 为重赋值 let 且模块内只读（经 getSessions()），stickBottom 经 setStickBottom 写。
// 列表分组状态与搜索状态为域私有，随域迁入本模块。
import {iconSvg} from '../../core/icons.js';
import {aiTextOf, aiFormatSessionTime, aiFormatBytes, AI_SESSION_READ_LIMIT} from '../core/ai-constants.js';
import {sessionActivityTs} from './ai-session-store.js';
import {planAwaitingUserReply} from '../core/ai-plan-file.js';
import {isTransientSession} from './ai-session-scope.js';
import {isMultiWorkspace} from '../../core/root-scope.js';

// 活动栏「AI 会话」图标状态点的聚合（纯函数，env 注入判定，便于单测）：
// 只统计当前工作区的非归档会话，按 error > pending > done 取最高优先级的一个；
// running / '' 不产生点。当前工作区键为空时一律不显示（未打开工作区）。
export function aggregateSessionBadge(sessions, env) {
    const list = Array.isArray(sessions) ? sessions : [];
    const statusOf = typeof env.sessionStatus === 'function' ? env.sessionStatus : () => '';
    const keyOf = typeof env.workspaceKeyOf === 'function' ? env.workspaceKeyOf : () => '';
    const currentKey = typeof env.currentWorkspaceKey === 'function' ? env.currentWorkspaceKey() : '';
    if (!currentKey) return '';
    let hasError = false;
    let hasPending = false;
    let hasDone = false;
    for (const session of list) {
        if (!session || session.archivedAt) continue;
        if (keyOf(session) !== currentKey) continue;
        const status = statusOf(session);
        if (status === 'error') hasError = true;
        else if (status === 'pending') hasPending = true;
        else if (status === 'done') hasDone = true;
    }
    if (hasError) return 'error';
    if (hasPending) return 'pending';
    if (hasDone) return 'done';
    return '';
}

// 计划待批准是否需要用户注意（会话列表 pending/info 角标的判定之一，纯函数便于单测）。
// AI 正在为这份计划工作时（用户点「继续规划」发来修订意见、新一轮在跑），流挂着就不算
// 「等用户动手」——列表应显示 running 而非 pending。与 planApprovalMessage 的 streamOf
// 前置判定同源：流在跑时审批卡也隐藏。用户已对计划发言（继续规划讨论中、审批卡已收起）
// 时同样不算——与「计划等待批准」横条的收起判定（planAwaitingUserReply）同源，不再反复
// 提示批准；计划重新提交（ts 更新）后角标自然回来。
export function planPendingNeedsAttention(session, hasStream) {
    return !!(session && session.planMode && session.activePlan &&
        session.activePlan.status === 'pending' && !hasStream &&
        planAwaitingUserReply(session));
}

// 支线紧跟母会话：按传入顺序（已按活跃度排序）铺平，再把每条支线插到它的母会话之后。
// 母会话已删除、或 sideOf 成环时按普通会话处理——渲染不能因为元数据坏了就少一条会话。
export function orderSessionsWithSides(list) {
    const source = Array.isArray(list) ? list : [];
    const byId = new Map(source.map((session) => [session.id, session]));
    const children = new Map();
    const roots = [];
    for (const session of source) {
        const parent = session && session.sideOf ? byId.get(session.sideOf) : null;
        if (parent && parent !== session) {
            if (!children.has(parent.id)) children.set(parent.id, []);
            children.get(parent.id).push(session);
        } else {
            roots.push(session);
        }
    }
    const out = [];
    const seen = new Set();
    const walk = (session) => {
        if (!session || seen.has(session.id)) return;
        seen.add(session.id);
        out.push(session);
        for (const child of children.get(session.id) || []) walk(child);
    };
    for (const session of roots) walk(session);
    for (const session of source) walk(session);
    return out;
}

// 编排批次会话紧跟发起会话（parentSessionId 永不变；仲裁者交接不影响这里）。
// 只按业务归属分组，不复用 sideOf——批次会话要独立打开，不是分叉快照。
export function orderSessionsWithOrchestration(list) {
    const source = Array.isArray(list) ? list : [];
    const byId = new Map(source.map((session) => [session.id, session]));
    const children = new Map();
    const roots = [];
    for (const session of source) {
        const orc = session && session.orchestration;
        const parentId = orc && orc.parentSessionId;
        const parent = parentId ? byId.get(parentId) : null;
        if (parent && parent !== session && (orc.role === 'work' || orc.role === 'review')) {
            if (!children.has(parent.id)) children.set(parent.id, []);
            children.get(parent.id).push(session);
        } else {
            roots.push(session);
        }
    }
    const out = [];
    const seen = new Set();
    const walk = (session) => {
        if (!session || seen.has(session.id)) return;
        seen.add(session.id);
        out.push(session);
        for (const child of children.get(session.id) || []) walk(child);
    };
    for (const session of roots) walk(session);
    for (const session of source) walk(session);
    return out;
}

// 会话过滤命中（纯函数，配 ai-session-list.test.mjs）：按标题或会话 ID 子串匹配，
// 大小写不敏感、去首尾空白；空串 = 不过滤（全命中）。标题取列表里实际显示的文案
//（无标题会话显示「新会话」，输入「新」也要能命中它们）。
export function sessionFilterHit(session, text) {
    const needle = String(text || '').trim().toLowerCase();
    if (!needle) return true;
    const title = String((session && session.title) || '新会话').toLowerCase();
    const id = String((session && session.id) || '').toLowerCase();
    return title.includes(needle) || id.includes(needle);
}

// 工作区分组默认展开判定（纯函数，配 ai-session-list.test.mjs）：
// - 用户手动切换过该分组（override 有布尔值）→ 尊重显式选择；
// - 否则默认只展开当前工作区，其余收起；
// - 未打开工作区（currentKey 为空）时展开第一个分组，避免所有会话都藏在收起的分组里。
// 分组默认是否展开。优先级：用户显式 override > 聚焦组 > 当前工作区组 > 第一组。
// 「聚焦组」与「当前工作区」是两件事，别合并（踩过坑）：
//   · 单工作区：聚焦组 == 当前工作区（group.current）
//   · 多工作区：窗口没有绑定工作区，但**当前会话**属于某个工作区——默认该展开它，
//     而不是按名字序展开第一组（那会让用户重启后看到"当前会话那组收着、别的组开着"）。
// override 恒优先：用户手动折叠/展开过的分组不被默认规则抢走。
export function workspaceGroupExpanded(key, group, env) {
    const override = env && env.override && typeof env.override.get === 'function'
        ? env.override.get(key) : undefined;
    if (typeof override === 'boolean') return override;
    const focusedKey = env && typeof env.focusedKey === 'function' ? env.focusedKey() : '';
    if (focusedKey) return key === focusedKey;
    const currentKey = typeof env.currentKey === 'function' ? env.currentKey() : (env && env.currentKey) || '';
    if (currentKey) return !!(group && group.current);
    return key === (env && env.firstKey);
}

// 工作区内的自定义分组桶（纯函数，配 ai-session-list.test.mjs）：
// 把某工作区的 sessions 按 session.group 切成子分组。空分组名归「未分组」并置底，
// 其余按组名排序（中文用 localeCompare 的 zh 排序），保证同一批会话的分组顺序稳定。
// 每个桶带 name（'' = 未分组）/ sessions / latest（桶内最近活动时间，供渲染排序用）。
export function buildWorkspaceSubgroups(sessions) {
    const list = Array.isArray(sessions) ? sessions : [];
    const byName = new Map();
    for (const session of list) {
        const name = String((session && session.group) || '').trim();
        let bucket = byName.get(name);
        if (!bucket) {
            bucket = {name, sessions: [], latest: 0};
            byName.set(name, bucket);
        }
        bucket.sessions.push(session);
        const ts = sessionActivityTs(session);
        if (ts > bucket.latest) bucket.latest = ts;
    }
    const buckets = [...byName.values()];
    buckets.sort((a, b) => {
        if (!!a.name !== !!b.name) return a.name ? -1 : 1; // 未分组置底
        if (!a.name) return 0;
        return a.name.localeCompare(b.name, 'zh');
    });
    return buckets;
}

// 子分组分页键（纯函数）：工作区分组内的每个子分组各自记可见条数，避免点 A 的「···」展开 B。
export function subgroupPageKey(archived, groupKey, subName) {
    return (archived ? 'archived:' : 'active:') + String(groupKey || '') + ':' + String(subName || '');
}

// 会话是否挂「超限」胶囊（纯函数，配 ai-session-list.test.mjs）：判定线 = 新版读取上限
// 256 MB（严格超限，与 session-too-large: 的产出口径一致）。
// 三类可判定来源：① hydrate/打开时自动整理失败（_tidyFailed）；② live 段自身超限
// （_liveDominant，真空角落）；③ 已载入会话的 stat 体积越过 256 MB 线（运行中长出来的）。
// 懒加载占位（_stub）没有 stat，无法判定——打开时才会暴露，届时再亮胶囊。
export function sessionOverLimitOf(session) {
    if (!session) return false;
    if (session._liveDominant || session._tidyFailed) return true;
    const stat = session._logStat;
    return !session._stub && !!stat && stat.exists === true &&
        Number(stat.size) > AI_SESSION_READ_LIMIT;
}

// 胶囊悬浮说明（按来源分级给动作指引）。
export function sessionOverLimitTip(session) {
    const stat = session && session._logStat;
    const size = stat && stat.exists ? Number(stat.size) : 0;
    if (session && session._liveDominant) {
        return '正文 ' + (size ? aiFormatBytes(size) : '超过') + ' 256 MB：当前消息（live 段）本身超限，打开将提供「临时加载」；载入后 /compact 回归常态';
    }
    if (session && session._tidyFailed) {
        return '正文 ' + (size ? aiFormatBytes(size) : '超过') + ' 256 MB：打开时自动整理失败，可重试或查看会话数据诊断';
    }
    return '正文 ' + aiFormatBytes(size) + '，超过 256 MB 读取上限：下次打开自动整理归档';
}

// 会话右键菜单项组装（纯函数，配 ai-session-list.test.mjs）：act 是符号动作键，
// showSessionMenu 负责映射成真实闭包。显隐规则——不适用的项直接不出现：
// 支线才有「提升为独立会话」、信箱有积压才有「清空信箱」、
// 磁盘存储才有「复制会话路径」（内存/legacy 模式没有磁盘路径可复制）、
// 磁盘存储 + 正文 ≥16 MB 才有「瘦身归档」（vacuum 提前回收空间，方案 §5.1 S1 触发方式 ②）。
export const AI_ARCHIVE_VACUUM_MIN_BYTES = 16 * 1024 * 1024;

export function buildSessionMenuItems(session, env) {
    const pending = Math.max(0, Number(env.pendingNoticeCount(session.id)) || 0);
    const archived = !!session.archivedAt;
    const items = [
        {label: '新建会话', icon: 'plus', act: 'new'},
        {label: '新建支线对话', icon: 'sidechat', act: 'newSide'},
        {sep: true},
        {label: session.pinned ? '取消置顶' : '置顶会话', icon: 'pin', disabled: archived, act: 'togglePin'},
        {label: '重命名会话…', icon: 'rename', act: 'rename'},
        {label: '设置分组…', icon: 'tag', act: 'setGroup'},
        {label: '导出会话…', icon: 'export', act: 'export'},
        {label: '会话数据诊断…', icon: 'chart', act: 'diagnostics'},
        // 监控窗（辅助窗第一批）：只读镜像，不改会话归属；绑定缺失（旧 mock）时灰置
        {label: '在独立窗口打开（监控）', icon: 'new-window', act: 'monitor', disabled: !env.canMonitor},
    ];
    if (env.canVacuumArchive &&
        Math.max(0, Number(typeof env.logSizeOf === 'function' ? env.logSizeOf(session) : 0) || 0) >= AI_ARCHIVE_VACUUM_MIN_BYTES) {
        items.push({label: '瘦身归档', icon: 'eraser', act: 'vacuumArchive'});
    }
    if (session.sideOf) items.push({label: '提升为独立会话', icon: 'new-window', act: 'promote'});
    if (pending > 0) items.push({label: '清空信箱（' + pending + ' 条）', icon: 'eraser', act: 'clearMailbox'});
    items.push({sep: true});
    items.push({label: '复制会话ID', icon: 'copy', act: 'copyId'});
    if (env.diskStorage) items.push({label: '复制会话路径', icon: 'folder', act: 'copyPath'});
    // 归档紧挨删除、放在它上面（对齐图 2 的底部布局：归档 → 永久删除）
    items.push({sep: true});
    items.push({label: archived ? '取消归档' : '归档会话', icon: archived ? 'unarchive' : 'archive', act: 'archive'});
    items.push({label: '删除会话', icon: 'trash', danger: true, act: 'remove'});
    return items;
}

// 工作区分组头「⋯」菜单组装（纯函数，配 ai-session-list.test.mjs）：act 是符号动作键，
// showWorkspaceMenu 负责映射成真实闭包。有 path 的分组给「资源管理器显示 / 复制路径 /
// 新窗口打开 / 在此新建会话」；未关联工作区的分组只给「打开文件夹 / 最近打开」。
// 关闭工作区只对当前工作区出现；最近打开以子菜单（act=openRecent + arg=path）给出。
export function buildWorkspaceMenuItems(group, env) {
    const path = group && group.path ? group.path : '';
    const isCurrent = !!(group && group.current && path);
    const recent = Array.isArray(env.recent) ? env.recent : [];
    const expanded = !!(env && env.expanded);
    const multiRoot = !!(env && env.multiRoot);
    const items = [];
    if (path) {
        items.push({label: '在文件资源管理器中显示', act: 'reveal'});
        items.push({label: '复制工作区路径', act: 'copyPath'});
        items.push({label: '在新窗口打开此工作区', act: 'openNewWindow', disabled: isCurrent});
        items.push({sep: true});
        items.push({label: '在此工作区新建会话', icon: 'plus', act: 'newSession'});
        // 「切换到此工作区」只对多工作区有意义：单工作区下换工作区＝开新窗口/换根，
        // 与「在新窗口打开」重复。多工作区下它把视图（树/面包屑/git）切到这个仓库。
        if (multiRoot) items.push({label: '切换到此工作区', icon: 'folder', act: 'switchHere'});
        items.push({sep: true});
    }
    // 展开 / 折叠：当前分组一个动作（按现状二选一），再加「全部」两个（分组多时省事）
    items.push(expanded
        ? {label: '折叠此分组', icon: 'chevron-up', act: 'collapseOne'}
        : {label: '展开此分组', icon: 'chevron-down', act: 'expandOne'});
    items.push({label: '展开所有分组', icon: 'chevron-down', act: 'expandAll'});
    items.push({label: '折叠所有分组', icon: 'chevron-up', act: 'collapseAll'});
    items.push({sep: true});
    items.push({label: '打开文件夹…', act: 'openFolder'});
    if (recent.length) {
        items.push({
            label: '最近打开的工作区',
            submenu: recent.map((entry) => ({
                label: entry.name || env.baseName(entry.path) || entry.path,
                act: 'openRecent',
                arg: entry.path,
            })),
        });
    }
    if (isCurrent) {
        items.push({sep: true});
        items.push({label: '关闭当前工作区', act: 'close'});
    }
    return items;
}

// 自定义子分组头「⋯」菜单组装（纯函数，配 ai-session-list.test.mjs）：act 是符号动作键，
// showSubgroupMenu 负责映射成真实闭包。命名分组才有「重命名 / 解散」；未分组只有新建；
// 归档区的桶不给「在此分组新建会话」（归档会话不该被新建出来）。解散把组内会话移入未分组。
// env.groupKey 为空（未关联工作区）时不给新建——那条桶没有工作区归属，新建会错绑当前工作区。
export function buildSubgroupMenuItems(sub, env) {
    const name = sub && sub.name ? String(sub.name) : '';
    const count = sub && Array.isArray(sub.sessions) ? sub.sessions.length : 0;
    const archived = !!(env && env.archived);
    const groupKey = env && env.groupKey ? String(env.groupKey) : '';
    const items = [];
    if (name) items.push({label: '重命名分组…', icon: 'rename', act: 'rename'});
    if (!archived && groupKey) items.push({label: '在此分组新建会话', icon: 'plus', act: 'newSession'});
    if (name) {
        if (items.length) items.push({sep: true});
        items.push({label: '解散分组（' + count + ' 条移入未分组）', icon: 'eraser', act: 'dissolve'});
    }
    return items;
}

// 子分组折叠判定（纯函数，配 ai-session-list.test.mjs）：默认展开；只有用户显式折叠过
//（folded.has(key)）才收起。过滤时渲染层强制展开，不经过这里。
export function subgroupFolded(key, env) {
    return !!(env && env.folded && typeof env.folded.has === 'function' && env.folded.has(key));
}

export function createAISessionList(ctx) {
    const el = ctx.el;
    const sessionListEl = ctx.sessionListEl;
    // 会话过滤（侧栏头部漏斗按钮 + 分段下方的过滤行，同文件树的过滤交互）
    const sessionFilterBtn = ctx.sessionFilterBtn;
    const sessionFilterRow = ctx.sessionFilterRow;
    const sessionFilterInput = ctx.sessionFilterInput;
    const renderWindows = ctx.renderWindows;
    const streams = ctx.streams;
    const backend = ctx.backend;
    const aiWorkspaceKey = ctx.aiWorkspaceKey;
    const aiWorkspaceName = ctx.aiWorkspaceName;
    const sessionWorkspacePath = ctx.sessionWorkspacePath;
    const sessionUseDisk = ctx.sessionUseDisk;
    // 支线对话动作（阶段 F）：面板经惰性转发注入，缺省时菜单项空操作不报错
    const openSideChat = typeof ctx.openSideChat === 'function' ? ctx.openSideChat : () => {};
    const promoteSideChat = typeof ctx.promoteSideChat === 'function' ? ctx.promoteSideChat : () => {};
    // 会话信箱（阶段 H）：未消费条数与清空入口
    const clearMailbox = typeof ctx.clearMailbox === 'function' ? ctx.clearMailbox : () => 0;
    const pendingNoticeCount = typeof ctx.pendingNoticeCount === 'function' ? ctx.pendingNoticeCount : () => 0;
    const stopSessionTurn = typeof ctx.stopSessionTurn === 'function' ? ctx.stopSessionTurn : () => {};
    const listFlash = typeof ctx.flash === 'function' ? ctx.flash : () => {};
    const copyText = typeof ctx.copyText === 'function' ? ctx.copyText : async () => {};
    const currentSession = ctx.currentSession;
    // 首次读盘未完成（磁盘模式的启动瞬间）：sessions 还是占位，不能当真实列表画出来
    const sessionsPending = typeof ctx.sessionsPending === 'function' ? ctx.sessionsPending : () => false;
    // 条数单一来源：懒加载占位（_stub）读 meta 里缓存的条数，已载体的会话现算
    const messageCountOf = typeof ctx.messageCount === 'function'
        ? ctx.messageCount
        : ((session) => (session && session.messages ? session.messages.length : 0));
    const windowWorkspacePath = ctx.windowWorkspacePath;
    const isOpen = ctx.isOpen;
    const ensureOpen = ctx.ensureOpen;
    const persistSessions = ctx.persistSessions;
    const renderMessages = ctx.renderMessages;
    const renderModelChip = ctx.renderModelChip;
    const sessionById = ctx.sessionById;
    const sessionHasLiveBgJob = ctx.sessionHasLiveBgJob;
    const switchSession = ctx.switchSession;
    const updateHeadHud = ctx.updateHeadHud;
    const toggleSessionPin = ctx.toggleSessionPin;
    const renameSession = ctx.renameSession;
    // 会话自定义分组：缺省空操作，保证浮窗/测试不报错
    const setSessionGroup = typeof ctx.setSessionGroup === 'function' ? ctx.setSessionGroup : () => {};
    // 子分组头操作：重命名 / 解散 / 在此分组新建（宿主惰性注入，缺省空操作）
    const renameSessionGroup = typeof ctx.renameSessionGroup === 'function' ? ctx.renameSessionGroup : () => {};
    const dissolveSessionGroup = typeof ctx.dissolveSessionGroup === 'function' ? ctx.dissolveSessionGroup : () => {};
    const newSessionInGroup = typeof ctx.newSessionInGroup === 'function' ? ctx.newSessionInGroup : () => {};
    const exportSession = ctx.exportSession;
    const showSessionDiagnostics = ctx.showSessionDiagnostics;
    const archiveSession = ctx.archiveSession;
    const deleteSession = ctx.deleteSession;
    // 手动「瘦身归档」（vacuum）：面板侧处理忙碌守卫与结果提示；缺省时空操作
    const vacuumSessionArchive = typeof ctx.vacuumSessionArchive === 'function' ? ctx.vacuumSessionArchive : () => {};
    const newSession = ctx.newSession;
    const newSessionInWorkspace = ctx.newSessionInWorkspace;
    const showContextMenu = ctx.showContextMenu;
    // 工作区管理菜单的宿主能力（由 main.js 注入；缺省空操作，浮窗/测试不报错）
    const workspaceMenuHost = ctx.workspaceMenu || {};
    // 「聚焦会话所在工作区」的分组 key（决定默认展开哪个组）。宿主没注入时回落到
    // 「单工作区看窗口工作区 / 多工作区看聚焦会话」，都不行就返回空（展开第一组）。
    const focusedWorkspaceKeyOf = typeof ctx.focusedWorkspaceKey === 'function'
        ? ctx.focusedWorkspaceKey
        : () => '';
    function focusedWorkspaceKey() {
        try { return aiWorkspaceKey(focusedWorkspaceKeyOf()) || ''; } catch (e) { return ''; }
    }
    const getSessions = ctx.getSessions;
    const setStickBottom = ctx.setStickBottom;
    // 活动栏会话图标状态点：宿主注入的回调（缺省空操作），由本域统一计算并推送
    const onBadgeChange = typeof ctx.onBadgeChange === 'function' ? ctx.onBadgeChange : () => {};

    // —— 随域迁入的列表状态（原 ai-panel.js 闭包级）；会话搜索框已删（并入全局搜索的「AI 会话」分类）——
    let archivedExpanded = false;
    // 会话过滤词（漏斗开合 + 输入去空格转小写后的命中词）：只在会话分段生效，
    // 群聊分段由 CSS 隐藏按钮与输入行（过滤不作用于群聊列表）。
    let sessionFilterText = '';
    // 用户显式切换过的分组展开状态：key → boolean。无记录的分组走默认判定
    //（只展开当前工作区，其余收起，见 workspaceGroupExpanded），切换后记住选择。
    const workspaceGroupOverrides = new Map();
    // 编排批次子项的折叠态（orchestrationId → true=展开）。内存态、不持久化，与工作区分组同款；
    // 默认折叠，有 failed / blocked 批次时默认展开（用户显式操作后尊重用户）。
    const orchestrationExpanded = new Map();
    // 自定义子分组的折叠状态：分页键 → true 表示用户显式折叠。默认展开，见 subgroupFolded。
    const subgroupFoldedKeys = new Set();

    // 过滤行开合（对齐文件树 toggleSidebarFilter）：显示时聚焦并全选输入，收起时清词重画。
    function toggleSessionFilter(force) {
        if (!sessionFilterRow || !sessionFilterInput) return;
        const show = typeof force === 'boolean' ? force : sessionFilterRow.classList.contains('hidden');
        sessionFilterRow.classList.toggle('hidden', !show);
        if (sessionFilterBtn) {
            sessionFilterBtn.classList.toggle('active', show);
            sessionFilterBtn.setAttribute('aria-pressed', String(show));
        }
        if (show) {
            sessionFilterInput.focus();
            sessionFilterInput.select();
        } else {
            sessionFilterInput.value = '';
            setSessionFilter('');
        }
    }

    function setSessionFilter(text) {
        const next = String(text || '').trim().toLowerCase();
        if (next === sessionFilterText) return;
        sessionFilterText = next;
        renderSessionList();
    }

    // 过滤按钮 / 输入行的事件接线（图标走注册表，按钮留空由这里填充）。
    if (sessionFilterBtn) {
        sessionFilterBtn.innerHTML = iconSvg('filter', 14);
        sessionFilterBtn.addEventListener('click', () => toggleSessionFilter());
    }
    if (sessionFilterInput) {
        // 输入防抖 150ms（对齐文件树过滤输入）；Esc 收起过滤行（元素级监听，非全局 Esc）
        let filterDebounce = 0;
        sessionFilterInput.addEventListener('input', () => {
            clearTimeout(filterDebounce);
            filterDebounce = setTimeout(() => setSessionFilter(sessionFilterInput.value), 150);
        });
        sessionFilterInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            toggleSessionFilter(false);
        });
    }

    // 把某个工作区分组显式展开（新建临时会话时用：它归「未关联工作区」分组，
    // 那个分组默认收起——不展开的话用户点完「新建临时会话」在列表里看不到它）。
    function expandWorkspaceGroup(key) {
        workspaceGroupOverrides.set(String(key || ''), true);
    }

    // 最近一次渲染出现过的分组 key（渲染顺序）。右键菜单的「展开/折叠所有」按它遍历；
    // 空列表时先渲染一次再取，保证菜单作用于「用户眼前这些分组」。
    let lastGroupKeys = [];

    // 一次性展开 / 折叠所有分组。只写 override（用户显式意图），不清 override 表——
    // 清掉会让「没有 override 的分组」回落到默认展开规则，表现为部分分组行为突变。
    function setAllGroupsExpanded(expanded) {
        const keys = lastGroupKeys.length ? lastGroupKeys : [];
        for (const key of keys) workspaceGroupOverrides.set(key, !!expanded);
        renderSessionList();
    }

    // 让某条会话在列表里可见：展开它所在的工作区分组（用户折叠过也要展开），
    // 重绘后把条目滚进视野。多工作区下「新建会话」必须走这里——新会话归它自己的工作区
    // 分组，那个分组若收着/在滚动区外，用户建完根本看不到它建在哪。
    function revealSession(sessionId, session) {
        const id = String(sessionId || '');
        if (!id || !sessionListEl) return;
        const target = session || sessions.find((item) => item.id === id);
        if (!target) return;
        // 分组 key 与 buildWorkspaceGroups 同源：会话的 workspace（无 → '' = 未关联工作区）
        workspaceGroupOverrides.set(aiWorkspaceKey(sessionWorkspacePath(target)) || '', true);
        renderSessionList();
        // 渲染是同步的，但滚动要等 DOM 落地：条目多时列表会整段换掉。
        setTimeout(() => {
            if (!sessionListEl) return;
            const node = Array.from(sessionListEl.querySelectorAll('[data-ai-session-id]'))
                .find((item) => item.dataset.aiSessionId === id);
            if (!node) return;
            const box = sessionListEl.getBoundingClientRect();
            const rect = node.getBoundingClientRect();
            // 已经整条在可视区内：不动。新建会话往往就在眼前，这时再滚一下反而打断视线。
            if (rect.top >= box.top && rect.bottom <= box.bottom) return;
            // 不在视野内才滚，且**尽量靠上**（第一眼要看到它，而不是停在列表最下一行）。
            // 直接改 scrollTop 而不是 scrollIntoView：只动会话列表这一个容器，不波及其它滚动区；
            // 末尾几条没有余量时 scrollTop 会被浏览器 clamp，自然落在偏低处——正是想要的。
            const PAD = 6; // 与 .ai-session-item 的 scroll-margin-top 一致，避免贴着分组头
            sessionListEl.scrollTop += (rect.top - box.top) - PAD;
        }, 0);
    }
    // 每个工作区分组一次只渲染最近 AI_SESSION_GROUP_PAGE 条会话，点分组底部的「···」再追加一页。
    // key = 列表类型 + 工作区 key，进行中与已归档互不影响；只是渲染层的展开状态，不动会话数据。
    const AI_SESSION_GROUP_PAGE = 10;
    const workspaceGroupVisibleCounts = new Map();
    // 会话条目右侧状态图标的悬浮提示
    const SESSION_STATUS_TITLE = {
        running: '会话运行中',
        pending: '待确认：需要用户审批或回答',
        done: '会话已完成，尚未查看',
        error: '会话出错，尚未查看',
    };

    // 配置切换走「模型列表」卡片；旧的 <select id="ai-opt-profile"> 已从 HTML 移除
    function renderProfileSelect() {
        renderModelChip();
    }

    function sessionActivity(session) {
        // 轮次起点，不是最后一条消息：工具刷屏、审批改写、标题生成都不该让条目在列表里跳。
        return sessionActivityTs(session);
    }

    function jumpToMessage(session, index) {
        if (!session || index < 0 || index >= (session.messages || []).length) return;
        setStickBottom(false);
        renderWindows.set(session.id, {start: Math.max(0, index - 3), len: session.messages.length});
        if (currentSession() === session) renderMessages(true);
        setTimeout(() => {
            if (!el.messages) return;
            const node = el.messages.querySelector('.ai-msg[data-ai-idx="' + index + '"]');
            if (!node) return;
            node.scrollIntoView({block: 'center'});
            node.classList.add('ai-msg-jump');
            setTimeout(() => node.classList.remove('ai-msg-jump'), 1600);
        }, 80);
    }

    // ---------- 会话条目状态 ----------
    // 会话条目右侧：未悬浮时显示状态图标，悬浮时换成「⋯」会话操作。
    // pending（等审批 / 等回答 / 计划待批准）优先于 running，因为它是需要用户动手的那一个。
    function sessionNeedsAttention(session) {
        if (!session) return false;
        // 占位会话没有正文：这里返回 false 只是「看不了」，真正要判断得等正文补上来
        //（补水完成后 scheduleSessionListRefresh 会重画一次，徽标随之出现）
        if (session._stub) return false;
        for (const message of session.messages || []) {
            if (!message) continue;
            if (message.approval && message.approval.state === 'pending') return true;
            if (message.ask && message.ask.state === 'pending') return true;
            if (message.envAsk && message.envAsk.state === 'pending') return true;
        }
        // 计划模式：待批准且 AI 没在为该计划工作（见纯函数注释）
        if (planPendingNeedsAttention(session, streams.has(session.id))) return true;
        return false;
    }

    function sessionEntryStatus(session, archived) {
        if (!session || archived || session.archivedAt) return '';
        if (sessionNeedsAttention(session)) return 'pending';
        if (streams.has(session.id)) return 'running';
        // 后台命令可能比本轮活得更久：即使没有流，作业还在跑也要在列表上标出来
        if (sessionHasLiveBgJob(session.id)) return 'running';
        if (session.unread === 'done' || session.unread === 'error') {
            // 正在看这个会话（面板打开且就是当前会话）时没有「未查看」可言：磁盘重读、
            // 另一窗口写入都可能把未读标记带回来，显示出来就是用户盯着的条目上挂绿点，
            // 得再点一次才会消失。这里直接不显示。
            if (isOpen() && currentSession() === session) return '';
            return session.unread;
        }
        return '';
    }

    // 活动栏会话图标状态点：复用逐条状态判定（含「正在查看时抑制未读」的语义），
    // running 归一为空（活动栏不提示运行中），再交给纯函数按工作区与优先级聚合。
    function refreshBadge() {
        const kind = aggregateSessionBadge(getSessions(), {
            sessionStatus: (session) => {
                const status = sessionEntryStatus(session, false);
                return status === 'running' ? '' : status;
            },
            workspaceKeyOf: (session) => aiWorkspaceKey(sessionWorkspacePath(session)),
            currentWorkspaceKey: () => aiWorkspaceKey(windowWorkspacePath()),
        });
        onBadgeChange(kind);
    }

    // 后台结束的会话标一个「未查看」；落盘进 meta，重启后仍然保留。
    function setSessionUnread(session, kind) {
        if (!session || session.archivedAt) return;
        // 面板开着且正看着这个会话：用户当场就看到了结果，不该留未读标记。
        if (isOpen() && currentSession() === session) {
            if (session.unread) {
                session.unread = '';
                persistSessions();
            }
            return;
        }
        const next = kind === 'error' ? 'error' : 'done';
        if (session.unread === next) return;
        session.unread = next;
        persistSessions();
    }

    function clearSessionUnread(session) {
        if (!session || !session.unread) return;
        session.unread = '';
        persistSessions();
    }

    function renderSessionList() {
        // 头部身份（会话标题）与 chips 角标跟随会话列表刷新点（改名/切换/自动标题都会走到这里）
        // 读盘中不给——占位会话的「新会话」标题闪一下没有意义
        if (!sessionsPending()) updateHeadHud();
        // 活动栏状态点跟随每次列表刷新（读盘期间也重算一次，占位会话不产生点）
        refreshBadge();
        if (!sessionListEl) return;
        const scrollTop = sessionListEl.scrollTop;
        sessionListEl.innerHTML = '';
        const current = currentSession();
        if (sessionsPending()) {
            // 启动第一个几百毫秒：磁盘会话还在读，占位列表画出来只会闪一下再被替换
            const loading = document.createElement('div');
            loading.className = 'ai-session-empty';
            const text = document.createElement('div');
            text.textContent = '正在读取会话…';
            loading.appendChild(text);
            sessionListEl.appendChild(loading);
            return;
        }
        const ordered = orderSessionsWithOrchestration(orderSessionsWithSides(getSessions().slice().sort((a, b) => sessionActivity(b) - sessionActivity(a))));
        if (!ordered.length) {
            const empty = document.createElement('div');
            empty.className = 'ai-session-empty';
            const text = document.createElement('div');
            text.textContent = '还没有会话';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'dlg-btn';
            button.textContent = '新建会话';
            button.addEventListener('click', () => {
                ensureOpen();
                newSession();
            });
            empty.append(text, button);
            sessionListEl.appendChild(empty);
            return;
        }
        // 过滤（标题 / 会话 ID 子串）：命中集为空时给独立空态，不把「还没有会话」的
        // 新建按钮顶出来——会话明明在，只是不匹配。
        const orchChildren = new Map();
        const orchChildOf = new Map();
        for (const session of ordered) {
            const orc = session && session.orchestration;
            if (!orc || (orc.role !== 'work' && orc.role !== 'review')) continue;
            const parent = getSessions().find((s) => s.id === orc.parentSessionId);
            if (!parent) continue;
            orchChildOf.set(session.id, parent.id);
            if (!orchChildren.has(parent.id)) orchChildren.set(parent.id, []);
            orchChildren.get(parent.id).push(session);
        }
        const orchExpanded = (parent) => {
            const id = (parent.orchestration && parent.orchestration.id) || parent.id;
            const explicit = orchestrationExpanded.get(id);
            if (typeof explicit === 'boolean') return explicit;
            const summary = parent._orchestrationSummary;
            if (summary && Number(summary.failedWork || 0) > 0) return true;
            return (orchChildren.get(parent.id) || []).some((s) => {
                const st = s._orchestrationBatchStatus && s._orchestrationBatchStatus.status;
                return st === 'failed' || st === 'blocked' || st === 'awaiting_user';
            });
        };
        const filtered = ordered.filter((session) => {
            if (sessionFilterText && !sessionFilterHit(session, sessionFilterText)) return false;
            if (sessionFilterText) return true;
            const parentId = orchChildOf.get(session.id);
            if (!parentId) return true;
            // 当前正在看的批次会话不能被折叠藏掉（用户点折叠后仍在对话区）。
            if (current && current.id === session.id) return true;
            const parent = getSessions().find((s) => s.id === parentId);
            return !parent || orchExpanded(parent);
        });
        if (!filtered.length) {
            const empty = document.createElement('div');
            empty.className = 'ai-session-empty';
            empty.textContent = '没有匹配的会话';
            sessionListEl.appendChild(empty);
            return;
        }

        // 支线徽标只在母会话仍存在时显示：母会话删除后回落为普通会话（元数据不追着清，
        // 「带回主对话」会给出明确提示）
        const liveIds = new Set(getSessions().map((item) => item.id));
        const sideBadgeOn = (session) => {
            const sideOf = aiTextOf(session && session.sideOf).trim();
            return !!sideOf && liveIds.has(sideOf);
        };
        const renderItem = (session, archived) => {
            const item = document.createElement('div');
            item.className = 'ai-session-item' + (current && current.id === session.id ? ' active' : '') + (archived ? ' archived' : '');
            // 支线：缩进 + 「支线」徽标，视觉上从属母会话（排序已保证紧跟其后）
            if (sideBadgeOn(session)) item.classList.add('ai-session-branch');
            // 编排批次会话：缩进（同支线），保留独立点击与独立标签页行为。
            if (orchChildOf.has(session.id)) item.classList.add('ai-session-orch-batch');
            item.dataset.aiSessionId = session.id;
            item.tabIndex = 0;
            item.setAttribute('role', 'button');
            const main = document.createElement('div');
            main.className = 'ai-session-main';
            const titleRow = document.createElement('div');
            titleRow.className = 'ai-session-title-row';
            if (session.pinned && !archived) {
                const pin = document.createElement('span');
                pin.className = 'ai-session-pin';
                pin.innerHTML = iconSvg('pin', 11);
                titleRow.appendChild(pin);
            }
            const title = document.createElement('div');
            title.className = 'ai-session-title';
            title.textContent = session.title || '新会话';
            titleRow.appendChild(title);
            if (sideBadgeOn(session)) {
                const badge = document.createElement('span');
                badge.className = 'ai-session-badge';
                badge.textContent = '支线';
                titleRow.appendChild(badge);
            }
            // 编排：父会话显示进度汇总（同时是折叠开关）；批次子项显示自己的批次状态。
            const isOrchParent = orchChildren.has(session.id);
            if (isOrchParent) {
                const summary = session._orchestrationSummary || {};
                const failed = Number(summary.failedWork || 0);
                const badge = document.createElement('span');
                badge.className = 'ai-session-badge orch' + (failed || summary.hasAttention ? ' attention' : '');
                const done = Number(summary.doneWork || 0);
                const total = Number(summary.totalWork || (orchChildren.get(session.id) || []).length);
                badge.textContent = total ? `编排 ${done}/${total}` : '编排';
                badge.dataset.tip = '编排批次会话（点击右侧箭头展开/收起）';
                titleRow.appendChild(badge);
                const toggle = document.createElement('button');
                toggle.type = 'button';
                toggle.className = 'ai-session-orch-toggle';
                toggle.setAttribute('aria-label', orchExpanded(session) ? '收起编排批次' : '展开编排批次');
                toggle.dataset.tip = '展开/收起编排批次';
                toggle.innerHTML = iconSvg(orchExpanded(session) ? 'chevron-up' : 'chevron-down', 12);
                toggle.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const id = (session.orchestration && session.orchestration.id) || session.id;
                    orchestrationExpanded.set(id, !orchExpanded(session));
                    renderSessionList();
                });
                titleRow.appendChild(toggle);
            }
            if (session.orchestration && (session.orchestration.role === 'work' || session.orchestration.role === 'review')) {
                const orc = session.orchestration || {};
                const st = session._orchestrationBatchStatus || {};
                const badge = document.createElement('span');
                badge.className = 'ai-session-badge orch-batch' + (
                    st.status === 'failed' || st.status === 'blocked' || st.status === 'awaiting_user' ? ' attention' : '');
                const labels = {
                    pending: '待派发', dispatched: '已广播', running: '执行中', verifying: '验收中',
                    reviewing: '审查中', done: '完成', failed: '失败', blocked: '卡住',
                    awaiting_user: '等用户', cancelled: '取消', skipped: '跳过',
                };
                badge.textContent = (orc.batchId || '批次') + (st.status ? ' · ' + (labels[st.status] || st.status) : '');
                titleRow.appendChild(badge);
            }
            // 临时会话：一次性对话（默认只读 / 不绑工作区 / 不注入工作区与记忆）。
            // 磁盘只留档，重启后不再出现——徽标就是「这条不会留到下次」的唯一提示。
            if (isTransientSession(session)) {
                const badge = document.createElement('span');
                badge.className = 'ai-session-badge temp';
                badge.textContent = '临时';
                badge.dataset.tip = '临时会话：默认只读、不绑定工作区、不注入 AGENTS.md 与记忆；关闭应用后不再显示';
                badge.setAttribute('role', 'img');
                badge.setAttribute('aria-label', badge.dataset.tip);
                titleRow.appendChild(badge);
            }
            // 超限会话：正文越过旧版 64 MB 上限（判定线，事故会话的物种）。
            // 胶囊帮用户把消息中心里「共 N 个会话读取失败」和 200 MB 级大家伙对上号；
            // 悬浮说明按两道线（64 MB / 256 MB）分级给动作指引。
            if (sessionOverLimitOf(session)) {
                const badge = document.createElement('span');
                badge.className = 'ai-session-badge over-limit';
                badge.textContent = '超限';
                badge.dataset.tip = sessionOverLimitTip(session);
                badge.setAttribute('role', 'img');
                badge.setAttribute('aria-label', badge.dataset.tip);
                titleRow.appendChild(badge);
            }
            const meta = document.createElement('div');
            meta.className = 'ai-session-meta';
            meta.textContent = (archived ? '已归档 · ' : '') + messageCountOf(session) + ' 条消息 · ' + aiFormatSessionTime(sessionActivity(session));
            main.append(titleRow, meta);
            // 右侧：未悬浮显示状态（运行中 / 待确认 / 已完成未查看），悬浮换成「⋯」会话操作。
            const side = document.createElement('div');
            side.className = 'ai-session-side';
            const statusKind = sessionEntryStatus(session, archived);
            if (statusKind) {
                const badge = document.createElement('span');
                badge.className = 'ai-session-status ' + statusKind;
                if (statusKind === 'running') {
                    const spinner = document.createElement('span');
                    spinner.className = 'ai-session-status-spin';
                    badge.appendChild(spinner);
                } else if (statusKind === 'pending') {
                    badge.innerHTML = iconSvg('info', 13);
                } else {
                    const dot = document.createElement('span');
                    dot.className = 'ai-session-status-dot';
                    badge.appendChild(dot);
                }
                badge.dataset.tip = SESSION_STATUS_TITLE[statusKind] || '';
                badge.setAttribute('role', 'img');
                badge.setAttribute('aria-label', badge.dataset.tip || '');
                side.appendChild(badge);
            }
            // 后台轮次的停止（§4.14.2）：只在运行中 / 待确认态出现，hover 才显形（防误触）。
            // streams 按会话隔离，停别人不需要先切过去——「静默跑着的轮次」必须有出口。
            if (statusKind === 'running' || statusKind === 'pending') {
                const stopBtn = document.createElement('button');
                stopBtn.type = 'button';
                stopBtn.className = 'ai-session-stop';
                stopBtn.dataset.tip = '停止这个会话的运行';
                stopBtn.setAttribute('aria-label', '停止会话运行');
                stopBtn.innerHTML = iconSvg('stop', 12);
                stopBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    stopSessionTurn(session.id);
                    listFlash('已停止会话「' + (session.title || '新会话') + '」');
                });
                item.appendChild(stopBtn);
            }
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'ai-session-more';
            more.dataset.tip = '会话操作';
            more.innerHTML = iconSvg('more', 13);
            more.addEventListener('click', (e) => {
                e.stopPropagation();
                const rect = more.getBoundingClientRect();
                showSessionMenu(session, rect.left, rect.bottom + 4);
            });
            side.appendChild(more);
            item.append(main, side);
            item.addEventListener('click', () => {
                ensureOpen();
                clearSessionUnread(session);
                if (!current || current.id !== session.id) switchSession(session.id);
            });
            item.addEventListener('keydown', (e) => {
                if (e.target !== item) return;
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                ensureOpen();
                switchSession(session.id);
            });
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                showSessionMenu(session, e.clientX, e.clientY);
            });
            sessionListEl.appendChild(item);
        };

        const buildWorkspaceGroups = (list) => {
            const groups = [];
            const byKey = new Map();
            // 多工作区模式不置顶任何分组：窗口不属于某个工作区，「当前工作区」这个概念
            // 在这里没有意义。置顶会让用户一点会话就把某个仓库排到最前，和单工作区
            // 的语义混在一起。
            const currentKey = isMultiWorkspace() ? '' : aiWorkspaceKey(windowWorkspacePath());
            for (const session of list) {
                const path = sessionWorkspacePath(session);
                const key = aiWorkspaceKey(path) || '';
                let group = byKey.get(key);
                if (!group) {
                    group = {key, path, sessions: [], latest: 0, current: !!key && key === currentKey};
                    byKey.set(key, group);
                    groups.push(group);
                }
                group.sessions.push(session);
                group.latest = Math.max(group.latest, sessionActivity(session));
            }
            // 单工作区：当前工作区排最前，其余按最近活动时间倒序，未关联工作区的放最后。
            // 多工作区：**按路径名固定排序**，不随操作跳位。用「最近活动」排序的话，
            // 在某个分组头点「+」新建会话会立刻把它顶到第一位（新建会话的 updatedAt 最新），
            // 表现为「点一下 + 就置顶了」——位置记忆被反复打乱。名字序稳定、可预测。
            const multi = !!isMultiWorkspace();
            const pathOf = (g) => String(g.path || '');
            groups.sort((a, b) => {
                if (a.current !== b.current) return a.current ? -1 : 1;
                if (!!a.key !== !!b.key) return a.key ? -1 : 1;
                if (multi) return pathOf(a).localeCompare(pathOf(b), 'zh-Hans-CN');
                return b.latest - a.latest;
            });
            return groups;
        };

        const renderWorkspaceGroups = (list, archived, collapsible) => {
            const groups = buildWorkspaceGroups(list);
            const showHeaders = groups.length > 1 || !!(groups[0] && groups[0].path);
            const firstKey = groups.length ? groups[0].key : '';
            // 记下本次渲染的分组顺序：右键菜单的「展开/折叠所有」按它遍历
            if (!archived) lastGroupKeys = groups.map((g) => g.key);
            const groupEnv = {
                override: workspaceGroupOverrides,
                // 排序：多工作区不置顶任何分组（按名称固定序），这里传空是对的。
                currentKey: () => (isMultiWorkspace() ? '' : aiWorkspaceKey(windowWorkspacePath())),
                // 展开：跟**聚焦会话所在组**。多工作区下就是当前会话的工作区——不跟它的话，
                // 重启后会按名字序展开第一组，用户看到「当前会话那组收着、不相干的组开着」。
                focusedKey: () => focusedWorkspaceKey(),
                firstKey,
            };
            for (const group of groups) {
                if (showHeaders) {
                    // 过滤时命中分组一律展开渲染（对齐文件树「命中目录自动展开」），
                    // 否则收起的非当前工作区会吞掉匹配的会话。
                    const expanded = !!sessionFilterText || workspaceGroupExpanded(group.key, group, groupEnv);
                    const collapsed = collapsible && !expanded;
                    // 用 div 承载：头部内含两个真实 button，避免 button 嵌套 button 的非法结构。
                    const head = document.createElement('div');
                    head.className = 'ai-session-group-head' + (group.current ? ' current' : '') + (collapsed ? '' : ' expanded');
                    if (collapsible) {
                        head.tabIndex = 0;
                        head.setAttribute('role', 'button');
                        head.setAttribute('aria-expanded', String(!collapsed));
                    }
                    const chev = document.createElement('span');
                    chev.className = 'ai-session-group-chev';
                    chev.innerHTML = iconSvg('chevron-right', 12);
                    const icon = document.createElement('span');
                    icon.className = 'ai-session-group-icon';
                    icon.innerHTML = iconSvg(group.path ? 'folder' : 'circle', 12);
                    const name = document.createElement('span');
                    name.className = 'ai-session-group-name';
                    name.textContent = group.path ? aiWorkspaceName(group.path) : '未关联工作区';
                    // 分组头右侧不再显示会话数：悬浮时才出现「新建会话 / 会话操作」两个图标。
                    const actions = document.createElement('span');
                    actions.className = 'ai-session-group-actions';
                    const add = document.createElement('button');
                    add.type = 'button';
                    add.className = 'ai-session-group-action';
                    add.dataset.tip = '新建会话';
                    add.setAttribute('aria-label', '新建会话');
                    add.innerHTML = iconSvg('plus', 12);
                    add.addEventListener('click', (e) => {
                        e.stopPropagation();
                        workspaceGroupOverrides.set(group.key, true);
                        ensureOpen();
                        newSessionInWorkspace(group);
                        renderSessionList();
                    });
                    const menu = document.createElement('button');
                    menu.type = 'button';
                    menu.className = 'ai-session-group-action';
                    menu.dataset.tip = '工作区操作';
                    menu.setAttribute('aria-label', '工作区操作');
                    menu.innerHTML = iconSvg('more', 12);
                    menu.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const rect = menu.getBoundingClientRect();
                        showWorkspaceMenu(group, rect.left, rect.bottom + 4);
                    });
                    actions.append(add, menu);
                    head.append(chev, icon, name, actions);
                    // 右键分组头 = 同一个工作区菜单（以前只有悬浮的「⋯」能打开，
                    // 右键没反应，用户以为列表缺功能）。
                    head.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        showWorkspaceMenu(group, e.clientX, e.clientY);
                    });
                    if (collapsible) {
                        const toggle = () => {
                            workspaceGroupOverrides.set(group.key, !workspaceGroupExpanded(group.key, group, groupEnv));
                            renderSessionList();
                        };
                        head.addEventListener('click', toggle);
                        head.addEventListener('keydown', (e) => {
                            if (e.target !== head || (e.key !== 'Enter' && e.key !== ' ')) return;
                            e.preventDefault();
                            toggle();
                        });
                    } else {
                        chev.style.visibility = 'hidden';
                    }
                    sessionListEl.appendChild(head);
                    if (collapsed) continue;
                }
                // 工作区内按自定义分组二次归类。只有出现 ≥2 个桶（即用户真的分了组）才显示
                // 子分组头；否则维持原来的一层列表，不给所有会话凭空加一级。
                const subgroups = buildWorkspaceSubgroups(group.sessions);
                const showSubHeaders = subgroups.length > 1;
                const renderBucket = (sub, pageKey) => {
                    const bucketList = sub.sessions;
                    const total = bucketList.length;
                    // 过滤时分页失效：命中集本来就小，再藏一批反而像丢结果
                    let visible = sessionFilterText ? total : Math.min(workspaceGroupVisibleCounts.get(pageKey) || AI_SESSION_GROUP_PAGE, total);
                    // 当前会话即使排在分页之外也保持可见，避免切换后高亮条目凭空消失。
                    if (current) {
                        const activeIndex = bucketList.findIndex((session) => session.id === current.id);
                        if (activeIndex >= visible) visible = Math.min(total, activeIndex + 1);
                    }
                    for (const session of bucketList.slice(0, visible)) renderItem(session, archived);
                    if (visible < total) {
                        const remaining = total - visible;
                        const more = document.createElement('button');
                        more.type = 'button';
                        more.className = 'ai-session-group-more';
                        more.innerHTML = iconSvg('more', 14);
                        const moreTip = '还有 ' + remaining + ' 条会话，点击再显示 ' + Math.min(AI_SESSION_GROUP_PAGE, remaining) + ' 条';
                        more.setAttribute('aria-label', moreTip);
                        more.addEventListener('click', () => {
                            workspaceGroupVisibleCounts.set(pageKey, Math.min(total, visible + AI_SESSION_GROUP_PAGE));
                            renderSessionList();
                        });
                        sessionListEl.appendChild(more);
                    }
                };
                if (showSubHeaders) {
                    for (const sub of subgroups) {
                        const pageKey = subgroupPageKey(archived, group.key, sub.name);
                        // 过滤时命中分组一律展开（对齐工作区分组 / 文件树行为），否则收起的桶会吞掉匹配会话
                        const folded = !sessionFilterText && subgroupFolded(pageKey, {folded: subgroupFoldedKeys});
                        const subHead = document.createElement('div');
                        subHead.className = 'ai-session-subgroup-head' + (folded ? '' : ' expanded')
                            + (sub.name ? '' : ' ungrouped');
                        subHead.tabIndex = 0;
                        subHead.setAttribute('role', 'button');
                        subHead.setAttribute('aria-expanded', String(!folded));
                        const chev = document.createElement('span');
                        chev.className = 'ai-session-subgroup-chev';
                        chev.innerHTML = iconSvg('chevron-right', 11);
                        const subIcon = document.createElement('span');
                        subIcon.className = 'ai-session-subgroup-icon';
                        subIcon.innerHTML = iconSvg(sub.name ? 'tag' : 'circle', 11);
                        const subName = document.createElement('span');
                        subName.className = 'ai-session-subgroup-name';
                        subName.textContent = sub.name || '未分组';
                        const subCount = document.createElement('span');
                        subCount.className = 'ai-session-subgroup-count';
                        subCount.textContent = String(sub.sessions.length);
                        // 分组头「⋯」：重命名 / 新建 / 解散（悬浮才显形，对齐工作区分组头）
                        const more = document.createElement('button');
                        more.type = 'button';
                        more.className = 'ai-session-subgroup-action';
                        more.dataset.tip = '分组操作';
                        more.setAttribute('aria-label', '分组操作：' + (sub.name || '未分组'));
                        more.innerHTML = iconSvg('more', 12);
                        more.addEventListener('click', (e) => {
                            e.stopPropagation();
                            const rect = more.getBoundingClientRect();
                            showSubgroupMenu(group, sub, archived, rect.left, rect.bottom + 4);
                        });
                        const actions = document.createElement('span');
                        actions.className = 'ai-session-subgroup-actions';
                        actions.appendChild(more);
                        subHead.append(chev, subIcon, subName, subCount, actions);
                        const toggle = () => {
                            if (subgroupFolded(pageKey, {folded: subgroupFoldedKeys})) subgroupFoldedKeys.delete(pageKey);
                            else subgroupFoldedKeys.add(pageKey);
                            renderSessionList();
                        };
                        subHead.addEventListener('click', toggle);
                        subHead.addEventListener('keydown', (e) => {
                            if (e.target !== subHead || (e.key !== 'Enter' && e.key !== ' ')) return;
                            e.preventDefault();
                            toggle();
                        });
                        sessionListEl.appendChild(subHead);
                        if (!folded) renderBucket(sub, pageKey);
                    }
                } else {
                    renderBucket(subgroups[0] || {sessions: []}, subgroupPageKey(archived, group.key, ''));
                }
            }
        };

        const activeList = filtered.filter((session) => !session.archivedAt);
        const archivedList = filtered.filter((session) => session.archivedAt);
        // 置顶会话固定在列表最上方（不受工作区分组与时间排序影响）
        const pinnedList = activeList.filter((session) => session.pinned);
        if (pinnedList.length) {
            const pinHead = document.createElement('div');
            pinHead.className = 'ai-session-pin-head';
            const pinIcon = document.createElement('span');
            pinIcon.innerHTML = iconSvg('pin', 11);
            const pinLabel = document.createElement('span');
            pinLabel.textContent = '置顶 ' + pinnedList.length;
            pinHead.append(pinIcon, pinLabel);
            sessionListEl.appendChild(pinHead);
            for (const session of pinnedList) renderItem(session, false);
        }
        const restActive = activeList.filter((session) => !session.pinned);
        if (!restActive.length) {
            // 过滤时这个空态让位：命中只在置顶 / 归档区时它就是一句噪音
            if (!sessionFilterText && !pinnedList.length) {
                const empty = document.createElement('div');
                empty.className = 'ai-session-archive-empty';
                empty.textContent = '没有进行中的会话';
                sessionListEl.appendChild(empty);
            }
        } else {
            renderWorkspaceGroups(restActive, false, true);
        }
        if (archivedList.length) {
            // 过滤时归档区随命中展开（状态位不动，清词后回到用户的显式选择）
            const archivedOpen = archivedExpanded || !!sessionFilterText;
            const head = document.createElement('button');
            head.type = 'button';
            head.className = 'ai-session-arch-head' + (archivedOpen ? ' expanded' : '');
            head.setAttribute('aria-expanded', String(archivedOpen));
            const chev = document.createElement('span');
            chev.className = 'ai-session-arch-chev';
            chev.innerHTML = iconSvg('chevron-right', 12);
            const label = document.createElement('span');
            label.textContent = '已归档 ' + archivedList.length;
            head.append(chev, label);
            head.addEventListener('click', () => {
                archivedExpanded = !archivedExpanded;
                renderSessionList();
            });
            sessionListEl.appendChild(head);
            if (archivedOpen) {
                renderWorkspaceGroups(archivedList, true, false);
            }
        }
        sessionListEl.scrollTop = scrollTop;
    }

    function showSessionMenu(session, x, y) {
        if (!showContextMenu) return;
        const actions = {
            new: () => { ensureOpen(); newSession(); },
            newSide: () => { ensureOpen(); openSideChat({session}); },
            togglePin: () => toggleSessionPin(session),
            rename: () => renameSession(session),
            setGroup: () => setSessionGroup(session),
            export: () => exportSession(session),
            diagnostics: () => showSessionDiagnostics(session),
            promote: () => promoteSideChat(session),
            clearMailbox: () => { clearMailbox(session.id); },
            // 监控窗（辅助窗第一批）：只读镜像，不改会话归属
            monitor: () => {
                if (!backend.PopOutSession) return;
                backend.PopOutSession(session.id, 'session', sessionWorkspacePath(session) || '')
                    .catch((e) => listFlash('打开监控窗失败：' + ((e && e.message) || e), true));
            },
            archive: () => archiveSession(session, !session.archivedAt),
            vacuumArchive: () => vacuumSessionArchive(session),
            copyId: () => { copyText(session.id, '会话ID'); },
            // 磁盘路径找 Go 侧解析（桶名 = 工作区短哈希，前端不复刻规则）；
            // 尚未落盘的会话把 session-gone 转成人话，不弹原始错误
            copyPath: async () => {
                let path = '';
                try {
                    path = await backend.AISessionPath(session.id) || '';
                } catch (e) {
                    const msg = String((e && e.message) || e);
                    listFlash(msg.includes('session-gone') ? '会话尚未落盘' : '取会话路径失败：' + msg, true);
                    return;
                }
                if (path) await copyText(path, '会话路径');
            },
            remove: () => deleteSession(session),
        };
        // act 是符号动作键：菜单结构由纯函数组装（可单测），这里只映射成真实闭包
        const items = buildSessionMenuItems(session, {
            pendingNoticeCount,
            diskStorage: !!sessionUseDisk(),
            canMonitor: !!backend.PopOutSession,
            // 「瘦身归档」：整理绑定存在 + 该会话正文 ≥16 MB（stat 缓存在 _logStat；
            // 未载入的占位会话没有 stat，先载入再整理）
            canVacuumArchive: !!backend.AISessionVacuum && !!sessionUseDisk(),
            logSizeOf: (target) => Math.max(0, Number(target && target._logStat && target._logStat.size) || 0),
        }).map((item) => (item.act && actions[item.act]) ? {...item, action: actions[item.act]} : item);
        showContextMenu(items, x, y);
    }

    function showWorkspaceMenu(group, x, y) {
        if (!showContextMenu) return;
        const path = group && group.path ? group.path : '';
        const actions = {
            reveal: () => { if (path && workspaceMenuHost.reveal) workspaceMenuHost.reveal(path); },
            copyPath: async () => {
                if (path) await copyText(path, '工作区路径');
            },
            openNewWindow: () => { if (path && workspaceMenuHost.openNewWindow) workspaceMenuHost.openNewWindow(path); },
            newSession: () => {
                workspaceGroupOverrides.set(group.key, true);
                ensureOpen();
                newSessionInWorkspace(group);
                renderSessionList();
            },
            // 多工作区：把视图（树 / 面包屑 / git / 便签）切到这个仓库，不新建会话
            switchHere: () => {
                workspaceGroupOverrides.set(group.key, true);
                if (path && workspaceMenuHost.switchToWorkspace) workspaceMenuHost.switchToWorkspace(path);
                renderSessionList();
            },
            expandOne: () => { workspaceGroupOverrides.set(group.key, true); renderSessionList(); },
            collapseOne: () => { workspaceGroupOverrides.set(group.key, false); renderSessionList(); },
            expandAll: () => { setAllGroupsExpanded(true); },
            collapseAll: () => { setAllGroupsExpanded(false); },
            openFolder: () => { if (workspaceMenuHost.openFolder) workspaceMenuHost.openFolder(); },
            openRecent: (arg) => { if (arg && workspaceMenuHost.openFolderSmart) workspaceMenuHost.openFolderSmart(arg); },
            close: () => { if (workspaceMenuHost.closeFolder) workspaceMenuHost.closeFolder(); },
        };
        const baseName = typeof workspaceMenuHost.baseName === 'function'
            ? workspaceMenuHost.baseName
            : (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop();
        const recent = typeof workspaceMenuHost.recent === 'function' ? workspaceMenuHost.recent() : [];
        const expanded = workspaceGroupExpanded(group.key, group, {
            override: workspaceGroupOverrides,
            currentKey: () => (isMultiWorkspace() ? '' : aiWorkspaceKey(windowWorkspacePath())),
            focusedKey: () => focusedWorkspaceKey(),
            firstKey: lastGroupKeys.length ? lastGroupKeys[0] : '',
        });
        const items = buildWorkspaceMenuItems(group, {
            recent, baseName, expanded, multiRoot: !!isMultiWorkspace(),
        })
            .map((item) => {
                if (item.submenu) {
                    return {
                        ...item,
                        submenu: item.submenu.map((sub) => (actions[sub.act]
                            ? {...sub, action: () => actions[sub.act](sub.arg)}
                            : sub)),
                    };
                }
                return (item.act && actions[item.act]) ? {...item, action: actions[item.act]} : item;
            });
        showContextMenu(items, x, y);
    }

    function showSubgroupMenu(group, sub, archived, x, y) {
        if (!showContextMenu) return;
        const name = sub && sub.name ? String(sub.name) : '';
        // 重命名/解散必须带 archived 维度：同名分组可同时存在于归档区与进行中区，
        // 宿主侧据此只操作当前分区的会话，避免从归档桶误伤进行中的会话。
        const actions = {
            rename: () => renameSessionGroup(name, group, archived),
            newSession: () => newSessionInGroup(name, group),
            dissolve: () => dissolveSessionGroup(name, group, archived),
        };
        const items = buildSubgroupMenuItems(sub, {archived, groupKey: group && group.key})
            .map((item) => (item.act && actions[item.act]) ? {...item, action: actions[item.act]} : item);
        showContextMenu(items, x, y);
    }
    return {
        renderProfileSelect,
        sessionActivity,
        setSessionUnread,
        renderSessionList,
        showSessionMenu,
        showWorkspaceMenu,
        clearSessionUnread,
        refreshBadge,
        expandWorkspaceGroup,
        revealSession,
        toggleSessionFilter,
    };
}
