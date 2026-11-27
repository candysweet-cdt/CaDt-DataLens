// ai-session-scope.js：会话归属哪个工作区的判定（纯函数，无副作用）。
// 另含作用域根 scopeRootOf——AI 工具「以哪个目录为根」的唯一来源（四步取值，顺序不可变）。
//
// 背景：ai-config.json 里的 activeSessionId 是全局的（多窗口共享同一份配置），AI 面板启动
// 只校验「这个会话还在」，不校验它属于哪个工作区——新窗口打开另一个工作区时会沿用上一个
// 工作区那个会话，面板直接恢复成别人的对话（再经 syncWorkspaceToSession 把工作区切回去）。
// 判定放这里便于单测；绑定 / 切换 / 建空会话这些副作用留在 ai-panel。

import {aiTextOf} from '../core/ai-constants.js';

// 与 Go 侧 normalizeWorkspacePath（internal/sessionstore/sessionstore.go）语义一致：
// 反斜杠归一为正斜杠、叠斜杠与 . / .. 段清理、协议或盘符前缀保留。
// 从 ai-panel.js 移出：ai-panel 35 处引用经 import 别名沿用原名，会话工作区归一
// 的哈希向量测试两端各锁一遍（frontend/test/ai/ai-session-scope.test.mjs ↔
// internal/sessionstore/sessionstore_test.go 的 TestWorkspaceBucketKeyVectors）。
export function normalizePath(value) {
    const raw = aiTextOf(value).replace(/\\/g, '/');
    if (!raw) return '';
    const scheme = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i);
    let prefix = '';
    let rest = raw;
    if (scheme) {
        prefix = scheme[1] + '://';
        rest = raw.slice(scheme[0].length);
    } else {
        const drive = raw.match(/^[A-Za-z]:/);
        if (drive) {
            prefix = drive[0];
            rest = raw.slice(2);
        }
    }
    const absolute = rest.startsWith('/');
    const parts = [];
    for (const segment of rest.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            if (parts.length) parts.pop();
            continue;
        }
        parts.push(segment);
    }
    return prefix + (absolute ? '/' : '') + parts.join('/');
}

// 会话工作区归一 key：去首尾空白 → 归一路径 → 去尾斜杠 → 小写（Windows 盘符大小写
// 不敏感）。Go 侧分桶哈希 WorkspaceBucketKey 以同一语义的 key 为输入（trim 在 key 这层，
// 不进 normalizePath——路径工具保持原语义）。
export function workspaceKey(value) {
    return normalizePath(aiTextOf(value).trim()).replace(/\/+$/, '').toLowerCase();
}

// ---- 作用域根（AI 工具「以哪个目录为根」的唯一来源）----
// 改造前 ai-panel 的 getScopeRoot() = 工作区文件夹 || 活动文件父目录，与「会话」无关：
// 用户在 A 仓库开会话、切标签到 B 仓库，工具就跟着按 B 解析路径（harness 多窗口下更糟）。
// 下面三个纯函数把「取根」抽出来，env 由调用方显式传入，纯函数里不取任何全局。

// 第 4 步兜底的第一来源：窗口工作区。只认显式工作区，不含活动文件目录。
export function windowWorkspace(folder) {
    return normalizePath(aiTextOf(folder).trim()).replace(/\/+$/, '');
}

// 活动文件父目录（旧 getScopeRoot 的兜底来源）。参数语义是「文件路径」，不是目录。
export function activeFileDir(filePath) {
    const full = normalizePath(aiTextOf(filePath).trim());
    if (!full) return '';
    const idx = full.lastIndexOf('/');
    return idx > 0 ? full.slice(0, idx) : '';
}

// 唯一根来源，四步顺序不可变（见 docs/finished-plans/agent-host-platform.md 核心设计 §1）：
//   1. session.workspace 非空      → 会话真源
//   2. session.noWorkspace === true → 会话沙盒（backing workspace），取不到就是无根
//   3. harness 窗口且会话未绑定     → ''（无根：工具只读 + 绝对路径）
//   4. 否则                         → 窗口工作区 || 活动文件父目录（兼容旧行为）
// 第 4 步的兜底绝不能提前：harness 下未绑定会话若拿到「用户当前点开的标签父目录」当根，
// AGENTS.md / 记忆 / 项目规则会读错仓库。env 显式传：
// {windowWorkspace, activeFilePath, activeFileDir, isHarness, backingWorkspaceOf}。
// activeFilePath（文件路径）与 activeFileDir（旧名）两种写法都按「文件路径」处理，内部折算目录。
export function scopeRootOf(session, env) {
    const e = env || {};
    const ws = normalizePath(aiTextOf(session && session.workspace).trim()).replace(/\/+$/, '');
    if (ws) return ws;
    if (session && session.noWorkspace === true) {
        const backing = typeof e.backingWorkspaceOf === 'function' ? e.backingWorkspaceOf(session) : '';
        return normalizePath(aiTextOf(backing).trim()).replace(/\/+$/, '');
    }
    if (e.isHarness) return '';
    const filePath = aiTextOf(e.activeFilePath) || aiTextOf(e.activeFileDir);
    return windowWorkspace(e.windowWorkspace) || activeFileDir(filePath);
}

// 当前会话的「按工作区」归属：config.activeSessionByWorkspace[workspaceKey] = sessionId。
// 多窗口共享同一份 ai-config.json，单值 activeSessionId 会被各窗口互相改写——A 窗口写盘、
// B 窗口读到后按自己的工作区改回再写盘，面板就在两个会话之间来回跳（2026-11-19 报告）。
// 每个工作区各记一条：切工作区时自然读到该工作区上次的会话，窗口之间不再互相驱动。
// 老配置只有 activeSessionId：没有本工作区条目时回退到它（保持既有恢复语义）。
export function activeSessionIdFor(config, ownKey) {
    const map = (config && config.activeSessionByWorkspace) || {};
    const keyed = ownKey && typeof map === 'object' ? aiTextOf(map[ownKey]) : '';
    if (keyed) return keyed;
    return aiTextOf(config && config.activeSessionId);
}

// 记住某个工作区当前打开的会话（id 为空 = 清除该工作区条目）。
// activeSessionId 同步写成同一个值，只作为欢迎页 / 老配置的兼容回退。
export function rememberActiveSession(config, ownKey, id) {
    if (!config || typeof config !== 'object') return;
    const next = aiTextOf(id);
    config.activeSessionId = next;
    if (!ownKey) return;
    if (!config.activeSessionByWorkspace || typeof config.activeSessionByWorkspace !== 'object') {
        config.activeSessionByWorkspace = {};
    }
    if (next) config.activeSessionByWorkspace[ownKey] = next;
    else delete config.activeSessionByWorkspace[ownKey];
}

// ── 会话状态判定：统一构件 ────────────────────────────────────────────────
// 同一族判定原先各处手写，写法不齐（archived 有裸真值/布尔化/数值比较三种，sideOf
// 有 trim/无 trim/裸真值四种）。脏值 `sideOf: ' '` 会让不同分支得出相反结论。
// 这里只给**单一维度**的构件；组合判定由调用方组装——强行合并成一个"万能谓词"
// 会让语义变模糊（哪些场景该排 stub、哪些不该，本来就不同）。

// 已归档。归一化后 `archivedAt` 是 0 或数字，真值判断即可；
// 需要比较「归档时间戳值」的场合（磁盘对账）请自己比数字，不要用本函数。
export function isArchived(session) {
    return !!(session && session.archivedAt);
}

// 支线对话：由 sideOf 指向母会话。支线有独立标签页承载，不该当「面板当前会话」，
// 也不该进跨工作区的候选池。**必须 trim**：历史上存在手写侧只判裸真值，
// `' '` 这种脏值会被当成支线（菜单里冒出「提升为独立会话」）。
export function isSideChat(session) {
    return !!(session && String(session.sideOf || '').trim());
}

// 不绑定工作区的会话：临时会话 + 会话沙盒。两者都不注入工作区知识，也都不属于
// 任何工作区（workspace 恒空）。原先 8+ 处逐字重复 `isTransient || isNoWorkspace`。
export function isUnboundSession(session) {
    return isTransientSession(session) || isNoWorkspaceSession(session);
}

// 能成为「面板当前会话」的候选：未归档、非支线（支线有独立标签页承载）。
// 注意**不排** stub / loadError：占位会话仍要在列表里显示（点开时补水），
// 排掉会让列表在懒加载阶段空一片。
function isCandidate(session) {
    if (!session) return false;
    return !isArchived(session) && !isSideChat(session);
}

// 能进「按工作区挑当前会话」候选池的会话：满足 isCandidate 且确实绑定了工作区。
// 与 isCandidate 的区别就是那一句 isUnboundSession——临时会话 / 会话沙盒的 workspace
// 恒空，本可按 key 过滤掉，但显式排除更稳（将来若它们带上 workspace 也不会误入）。
export function isWorkspaceEligibleSession(session) {
    return isCandidate(session) && !isUnboundSession(session);
}

// 临时会话：一次性会话（侧栏「新建会话」右侧「⋯」→ 新建临时会话）。
// 语义：默认只读、不绑定工作区、不注入 AGENTS.md / 记忆 / 认知索引等环境知识；
// 磁盘只作为留档（meta.temp 标记），启动加载时一律滤掉——对用户来说关掉应用就没了。
// 判定只认严格 true：读盘回来的老会话没有这个字段，缺省即普通会话。
export function isTransientSession(session) {
    return !!(session && session.temp === true);
}

// 会话沙盒（侧栏「新建会话」右侧「⋯」→ 新建会话沙盒）：持久会话，但不绑定工作区——
// 它的根是应用数据下的沙盒目录（Go 侧 AIBackingWorkspace，见 scopeRootOf 第 2 步）；
// 不注入 AGENTS.md / 记忆 / 认知索引等工作区知识。与临时会话的区别：标题正常生成、
// 不显示「临时」徽标、重启后仍留在会话列表里（磁盘不按它过滤）。判定只认严格 true。
// 独立的 noWorkspace 标记而非复用 temp——temp 与「读盘过滤后消失」强绑定，语义不同。
export function isNoWorkspaceSession(session) {
    return !!(session && session.noWorkspace === true);
}

// 本工作区里最近更新的会话；没有返回 null。keyOf 把会话映射成归一化工作区 key。
export function pickWorkspaceSession(list, ownKey, keyOf, excludeId) {
    if (!ownKey) return null;
    let best = null;
    let bestAt = -1;
    for (const session of Array.isArray(list) ? list : []) {
        if (!isCandidate(session)) continue;
        if (excludeId && session.id === excludeId) continue;
        if (keyOf(session) !== ownKey) continue;
        const at = Number(session.updatedAt) || 0;
        if (at > bestAt) {
            best = session;
            bestAt = at;
        }
    }
    return best;
}

// 当前会话与本窗口工作区的关系 → 该做什么：
//   keep   不动（没有工作区 / 已属本工作区 / 有回合在跑）
//   bind   会话没有工作区归属（老会话）：按既有语义绑到当前工作区，不换会话
//   switch 改看本工作区最近的会话
//   create 本工作区还没有会话：新建空会话
export function decideSessionForWorkspace(current, ownKey, list, keyOf, opts = {}) {
    if (!ownKey || !current) return {action: 'keep'};
    // 正在生成 / 压缩的会话不能换走：回合还在跑，换了就看不见它了
    if (opts.busy) return {action: 'keep'};
    const currentKey = keyOf(current) || '';
    if (currentKey === ownKey) return {action: 'keep'};
    if (!currentKey) return {action: 'bind'};
    const next = pickWorkspaceSession(list, ownKey, keyOf, current.id);
    return next ? {action: 'switch', session: next} : {action: 'create'};
}

// 「点别的 AI 会话 → 怎么开」的分支决策（openWorkspaceFolder 的单一来源，纯函数）。
// 返回 action 语义与 main.js 的 openWorkspaceFolder 返回值一一对应：
//   invalid  参数不满足（无 dir / 浮窗 / 后端无新窗口能力），等价于 false
//   same     本窗口已是该工作区
//   current  本窗口没有工作区：就在本窗口打开
//   reused   目标工作区已开在别的存活窗口，已向其信箱投递（本窗口不动）
//   switchInPlace 原地换手：不新开窗口，本窗口直接切到目标工作区的会话（harness 用）
//   window   软切换：另开窗口打开目标工作区
// 决策依据 state：{dir, isFloat, currentKey, targetKey, reuseHit, canSoftSwitch, canNewWindow,
// openMode}。openMode 缺省 'new-window'（既有行为），'in-place' 才走原地换手。
// reuseHit 由调用方先 await 后端 WindowReuseForSession 探测得到（本函数保持纯同步）。
export function decideSessionOpen(state) {
    if (!state || !state.dir || state.isFloat) return {action: 'invalid'};
    if (state.currentKey && state.currentKey === state.targetKey) return {action: 'same'};
    if (!state.currentKey) return {action: 'current'};
    if (state.reuseHit) return {action: 'reused'};
    if (state.openMode === 'in-place') return {action: 'switchInPlace'};
    if (state.canSoftSwitch || state.canNewWindow) return {action: 'window'};
    return {action: 'invalid'};
}

// ── 会话「忙不忙」与「能不能给它起一轮」的唯一构件 ──────────────────────────
// 这两条判定原先在 20+ 处手写：`streamOf(id) || compactOf(id)` 逐字重复（有的写 streams.has），
// 「能不能发消息」这门禁则有四套各缺一截的版本——UI 发送按钮不判忙（刻意）、起轮内核完整、
// 原地编辑保存漏 _loadError、队列冲刷漏 _loadError。漏判的代价很具体：用户先被问「将丢弃
// 之后的 N 条对话」，点确定之后才被告知发不出去。
//
// 分两层落地：
//   ① createSessionBusyProbe(source) → isSessionBusy(id, opts)：**注入式**。streams / oneShot
//      都是面板闭包里的状态，纯函数取不到，所以由装配方（ai-panel / 各子模块）注入后取回。
//   ② canStartTurn / canSendMessage：**纯函数**，只吃会话对象 + 调用方算好的忙标记，四处共用。

// 忙探针。source 可给 streamOf（id → 流|null）/ streams（有 has() 的 Map/Set）/ compactOf
// （id → 压缩中的 oneShot|null），三者任给其一即可，全部缺省时恒 false（测试桩场景）。
// compactStartingOf(id)：返回该会话是否正在准备压缩。压缩准备按会话隔离——startCompact
// 在置位前已经知道目标会话，不能因为 A 工作区准备压缩而拦住 B 工作区的后台通知。
export function createSessionBusyProbe(source) {
    const src = source || {};
    const streamOf = typeof src.streamOf === 'function' ? src.streamOf : null;
    const streams = src.streams && typeof src.streams.has === 'function' ? src.streams : null;
    const compactOf = typeof src.compactOf === 'function' ? src.compactOf : null;
    const compactStartingOf = typeof src.compactStartingOf === 'function'
        ? src.compactStartingOf
        : () => false;
    // opts.includeCompactStarting：把「该会话正在准备压缩」也算忙。默认不判，保持 UI /
    // 普通发送门禁的既有口径；只有起轮内核与同源守卫显式传 true。
    return function isSessionBusy(sessionId, opts) {
        if (!sessionId) return false;
        if (streamOf && streamOf(sessionId)) return true;
        if (streams && streams.has(sessionId)) return true;
        if (compactOf && compactOf(sessionId)) return true;
        return !!(opts && opts.includeCompactStarting) && !!compactStartingOf(sessionId);
    };
}

// 会话维度「现在能不能给它起一轮」的判定内核。env：
//   sessionsPending  会话列表还在读盘（此时发消息会落到占位会话上，读盘一完成就被整份替换 → 丢消息）
//   busy             本会话有回合在跑 / 正在压缩（由 createSessionBusyProbe 算好传进来）
// 返回 {ok, reason}，reason ∈ '' / no_session / sessions_pending / load_failed / busy / archived。
// 顺序与起轮内核的历史顺序一致（sessionsPending → 正文读取失败 → 忙 → 归档）。
// 刻意**不判**的两项，别顺手加进来：
//   _stub（懒加载占位）只说明正文还没读上来，不等于不能发——起轮内核会先 ensureSessionLoaded
//     再继续；在这里拦会把「后台通知 / 队列投递到没点开过的会话」这条支持路径一起堵死。
//   模型 / 附件 / 上下文占比不是会话状态，属调用方（profileOf / ctxGate）。
function turnGate(session, env) {
    const e = env || {};
    if (!session || !session.id) return {ok: false, reason: 'no_session'};
    if (e.sessionsPending) return {ok: false, reason: 'sessions_pending'};
    // 正文读取失败（超限拒载 / IO 失败）的会话写盘被写保护：这一轮只存在于内存，重启即丢。
    if (session._loadError) return {ok: false, reason: 'load_failed'};
    if (e.busy) return {ok: false, reason: 'busy'};
    if (session.archivedAt) return {ok: false, reason: 'archived'};
    return {ok: true, reason: ''};
}

// 起轮内核 / 后台队列冲刷 / 原地编辑保存 / 重发共用：忙就拒（调用方回插队列或提示，消息不丢）。
export function canStartTurn(session, env) {
    return turnGate(session, env);
}

// UI 发送门禁：与 canStartTurn 同源，但忙**不禁用**——生成中点发送是「排队 / 插话 / 抢占」
// 三手势（ai-panel.js syncSendStopButtons 的注释），禁用了这三条路就没了。其余维度同源，
// 将来给 turnGate 加一维，发送按钮与起轮内核会一起生效。
export function canSendMessage(session, env) {
    const e = env || {};
    return turnGate(session, {sessionsPending: e.sessionsPending, busy: false});
}
