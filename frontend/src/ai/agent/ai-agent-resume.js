// ai-agent-resume.js：子代理运行态快照与跨进程续跑（纯函数，S6）。
//
// 要解决的问题：子代理的四个运行态容器（subAgents / transcripts / records / compacts）全在内存，
// 进程退出即失。原来的兜底是「载入时把 running 收敛成 stopped」——记录还在，但**续不上**：
// 冷唤醒（reviveSubAgent）依赖 record.session / profile / entry 三个活引用，重启后全没了。
//
// 本模块负责「把这三样变成可落盘的东西」：快照里存 session 的可序列化外壳（含转录、范围档、
// worktree）、profileId / modelId，以及续跑所需的轮次与预算。真正的重建在 ai-subagents 里做
// （它才知道怎么按 id 找回 profile/entry、怎么造 flow）。
//
// 三条纪律：
//   · **只存必要**：转录保留最近 N 条（首条 task 必留），否则一次长调研就能把 meta.json 撑爆。
//   · **宁缺勿脏**：字段逐个校验，坏数据整条丢弃（快照是缓存，丢了最多续不上，不能污染会话）。
//   · **不自动续跑**：载入只把状态标成 interrupted 并标记可续。自动起轮会在用户不知情时
//     消耗 token，且可能重复执行上次未完成的写操作——续跑必须由用户/主代理显式触发。

import {serializeCapabilities, parseCapabilities} from './agent-capabilities.js';

/** 每个会话最多保留多少条运行态快照（与终态记录 LRU 同量级）。 */
export const AI_AGENT_RUN_MAX = 12;
/** 单条快照最多保留多少条转录消息（首条 task 另算）。 */
export const AI_AGENT_RUN_MSG_MAX = 60;
/** 快照版本：v2 起携带能力快照（DelegatedCapabilities，方案 §8.1）；v1 无能力字段不可续跑（§8.2）。 */
export const AI_AGENT_RUN_VERSION = 2;

const STATE_OK = new Set(['running', 'interrupted', 'done', 'error', 'stopped']);

function textOf(value) {
    return typeof value === 'string' ? value : (value == null ? '' : String(value));
}

function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

// 转录裁剪：首条（派单 task）必留，其余从尾部取，保证「任务是什么」永远可读。
function trimMessages(messages) {
    const list = Array.isArray(messages) ? messages.filter((m) => m && typeof m === 'object') : [];
    if (list.length <= AI_AGENT_RUN_MSG_MAX) return list;
    const head = list.slice(0, 1);
    const tail = list.slice(list.length - (AI_AGENT_RUN_MSG_MAX - 1));
    return head.concat(tail);
}

/**
 * 把运行中的子代理编成可落盘快照。
 * @param {any} sub 运行态（subAgents 里的对象）
 * @param {string} [state] 覆盖状态（终态时为 done/error/stopped）
 */
export function encodeAgentRun(sub, state) {
    if (!sub || !sub.id) return null;
    const session = sub.session || {};
    const flow = sub.flow || {};
    const profileId = textOf(session.profileId) || textOf(sub.profile && sub.profile.id);
    const modelId = textOf(session.modelId) || textOf(sub.entry && sub.entry.id);
    // 能力快照（§8.1）：全绝对路径，恢复时不需重新解析；granted 记授权来源（插件 + 父会话）。
    const capabilities = serializeCapabilities(sub.capabilities);
    return {
        v: AI_AGENT_RUN_VERSION,
        id: textOf(sub.id),
        key: textOf(sub.key),
        toolCallId: textOf(sub.toolCallId),
        name: textOf(sub.name) || '子代理',
        task: textOf(sub.task),
        depth: clampInt(sub.depth, 1, 8, 1),
        mode: textOf(sub.mode) || 'blocking',
        state: STATE_OK.has(state) ? state : (STATE_OK.has(sub.state) ? sub.state : 'running'),
        sandboxMode: textOf(sub.sandboxMode),
        presetId: capabilities ? capabilities.preset : '',
        capabilities,
        grantedBy: capabilities
            ? {pluginId: capabilities.granted.pluginId, parentSessionId: capabilities.granted.parentSessionId}
            : null,
        grantedAt: capabilities ? capabilities.granted.at : 0,
        parentSessionId: textOf(sub.parentSessionId),
        rootSessionId: textOf(sub.rootSessionId) || textOf(sub.parentSessionId),
        maxRounds: clampInt(sub.maxRounds, 1, 200, 40),
        baseRound: clampInt(flow.baseRound, 1, 10000, 1),
        rounds: clampInt(flow.roundNo, 0, 10000, 0),
        startedAt: clampInt(sub.startedAt, 0, Number.MAX_SAFE_INTEGER, 0),
        updatedAt: Date.now(),
        // 续跑所需的会话外壳（不存 flow：flow 里有 Map / DOM 定时器，重建更可靠）
        run: {
            workspace: textOf(session.workspace),
            originSessionId: textOf(session.originSessionId),
            scope: textOf(session.scope) || 'read',
            ctxLimit: clampInt(session.ctxLimit, 0, 100000000, 0),
            systemPrompt: textOf(session.systemPrompt),
            promptTemplateId: textOf(session.promptTemplateId),
            profileId,
            modelId,
            worktree: session.worktree && typeof session.worktree === 'object'
                ? {
                    name: textOf(session.worktree.name),
                    branch: textOf(session.worktree.branch),
                    path: textOf(session.worktree.path),
                    baseSha: textOf(session.worktree.baseSha),
                    createdAt: clampInt(session.worktree.createdAt, 0, Number.MAX_SAFE_INTEGER, 0),
                }
                : null,
            messages: trimMessages(session.messages),
        },
    };
}

/**
 * 归一化一个会话的运行态快照数组：逐条校验、按 id 去重（后者覆盖前者）、按 updatedAt 倒序截断。
 * @param {any} raw
 * @returns {any[]}
 */
export function normalizeAgentRuns(raw) {
    if (!Array.isArray(raw)) return [];
    /** @type {Map<string, any>} */
    const byId = new Map();
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const id = textOf(item.id).trim();
        const run = item.run && typeof item.run === 'object' ? item.run : null;
        const parentSessionId = textOf(item.parentSessionId).trim();
        // 没有 id / 父会话 / 转录的快照无法重建，直接丢——留着只会让「可续」变成假的。
        if (!id || !parentSessionId || !run) continue;
        const messages = Array.isArray(run.messages) ? run.messages : [];
        if (!messages.length) continue;
        // v2 起带能力快照；v1 旧快照保留展示（状态 / 任务可查）但 resumePlanOf 拒绝续跑（§8.2）。
        const version = Number(item.v) === AI_AGENT_RUN_VERSION ? AI_AGENT_RUN_VERSION : 1;
        const capabilities = version === AI_AGENT_RUN_VERSION ? parseCapabilities(item.capabilities) : null;
        const record = {
            v: version,
            id,
            key: textOf(item.key),
            toolCallId: textOf(item.toolCallId),
            name: textOf(item.name) || '子代理',
            task: textOf(item.task),
            depth: clampInt(item.depth, 1, 8, 1),
            mode: textOf(item.mode) || 'blocking',
            state: STATE_OK.has(item.state) ? item.state : 'interrupted',
            sandboxMode: textOf(item.sandboxMode),
            presetId: textOf(item.presetId) || (capabilities ? capabilities.preset : ''),
            capabilities,
            parentSessionId,
            rootSessionId: textOf(item.rootSessionId) || parentSessionId,
            maxRounds: clampInt(item.maxRounds, 1, 200, 40),
            baseRound: clampInt(item.baseRound, 1, 10000, 1),
            rounds: clampInt(item.rounds, 0, 10000, 0),
            startedAt: clampInt(item.startedAt, 0, Number.MAX_SAFE_INTEGER, 0),
            updatedAt: clampInt(item.updatedAt, 0, Number.MAX_SAFE_INTEGER, 0),
            run: {
                workspace: textOf(run.workspace),
                originSessionId: textOf(run.originSessionId),
                scope: textOf(run.scope) || 'read',
                ctxLimit: clampInt(run.ctxLimit, 0, 100000000, 0),
                systemPrompt: textOf(run.systemPrompt),
                promptTemplateId: textOf(run.promptTemplateId),
                profileId: textOf(run.profileId),
                modelId: textOf(run.modelId),
                worktree: run.worktree && typeof run.worktree === 'object' && textOf(run.worktree.path)
                    ? {
                        name: textOf(run.worktree.name),
                        branch: textOf(run.worktree.branch),
                        path: textOf(run.worktree.path),
                        baseSha: textOf(run.worktree.baseSha),
                        createdAt: clampInt(run.worktree.createdAt, 0, Number.MAX_SAFE_INTEGER, 0),
                    }
                    : null,
                messages: trimMessages(messages),
            },
        };
        byId.set(id, record);
    }
    const list = [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return list.slice(0, AI_AGENT_RUN_MAX);
}

/**
 * 把快照合并进会话现有数组（同一 id 覆盖），返回新数组（不改入参）。
 * @param {any} existing
 * @param {any} snapshot encodeAgentRun 的产物
 */
export function mergeAgentRun(existing, snapshot) {
    const list = normalizeAgentRuns(existing).filter((run) => run.id !== (snapshot && snapshot.id));
    if (snapshot) list.unshift(snapshot);
    return normalizeAgentRuns(list);
}

/**
 * 判断一条快照能否续跑，不能则给出人话原因（用于 UI 禁用态与诊断）。
 * @param {any} run
 * @returns {{ok: boolean, reason: string}}
 */
export function resumePlanOf(run) {
    if (!run || typeof run !== 'object') return {ok: false, reason: '快照缺失'};
    if (!textOf(run.id)) return {ok: false, reason: '缺少代理 id'};
    const detail = run.run && typeof run.run === 'object' ? run.run : null;
    if (!detail) return {ok: false, reason: '快照缺少运行态'};
    // v1 旧快照无能力字段：不做降级恢复（§10.1 无兼容层），一律拒绝续跑让用户重新派单。
    if (Number(run.v) !== AI_AGENT_RUN_VERSION) return {ok: false, reason: '快照版本过旧，请重新派单'};
    // v2 但能力快照缺失 / 结构坏：缺关键字段拒绝续跑（§8.2）。归一化阶段已把坏快照解析成
    // null，这里再校验一次形态（UI 会拿归一后的记录调它，防手造对象绕过）。
    if (!parseCapabilities(run.capabilities)) return {ok: false, reason: '快照缺少能力快照，请重新派单'};
    if (!Array.isArray(detail.messages) || !detail.messages.length) {
        return {ok: false, reason: '没有可续的转录'};
    }
    if (!textOf(detail.profileId)) return {ok: false, reason: '快照缺少模型账号'};
    if (run.state === 'done') return {ok: false, reason: '已完成，无需续跑'};
    const rounds = clampInt(run.rounds, 0, 10000, 0);
    const cap = clampInt(run.maxRounds, 1, 200, 40);
    if (rounds >= cap) return {ok: false, reason: '已用满轮次预算（' + rounds + '/' + cap + '）'};
    return {ok: true, reason: ''};
}

/**
 * 判断快照是否属于「进程退出时还在跑」——这类才需要标成 interrupted 让用户决定续不续。
 * @param {any} run
 */
export function wasInterrupted(run) {
    return !!run && run.state === 'running';
}
