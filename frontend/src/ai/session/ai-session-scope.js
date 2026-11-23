// ai-session-scope.js：会话归属哪个工作区的判定（纯函数，无副作用）。
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

// 能成为「面板当前会话」的候选：未归档、非支线（支线有独立标签页承载）。
function isCandidate(session) {
    if (!session || session.archivedAt) return false;
    if (String(session.sideOf || '').trim()) return false;
    return true;
}

// 临时会话：一次性会话（侧栏「新建会话」右侧「⋯」→ 新建临时会话）。
// 语义：默认只读、不绑定工作区、不注入 AGENTS.md / 记忆 / 认知索引等环境知识；
// 磁盘只作为留档（meta.temp 标记），启动加载时一律滤掉——对用户来说关掉应用就没了。
// 判定只认严格 true：读盘回来的老会话没有这个字段，缺省即普通会话。
export function isTransientSession(session) {
    return !!(session && session.temp === true);
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
//   window   软切换：另开窗口打开目标工作区
// 决策依据 state：{dir, isFloat, currentKey, targetKey, reuseHit, canSoftSwitch, canNewWindow}。
// reuseHit 由调用方先 await 后端 WindowReuseForSession 探测得到（本函数保持纯同步）。
export function decideSessionOpen(state) {
    if (!state || !state.dir || state.isFloat) return {action: 'invalid'};
    if (state.currentKey && state.currentKey === state.targetKey) return {action: 'same'};
    if (!state.currentKey) return {action: 'current'};
    if (state.reuseHit) return {action: 'reused'};
    if (state.canSoftSwitch || state.canNewWindow) return {action: 'window'};
    return {action: 'invalid'};
}
