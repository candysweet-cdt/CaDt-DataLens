// ai-agent-model.js：智能体（群聊成员）数据层——归一化、名字校验/去重、modelRef 解析
// 与能力快照。纯函数无 DOM，可单测；方案见 docs/finished-plans/ai-group-chat.md §6.1。
// 智能体存 ai-config.json 的 agents[]；删除不级联（群内显示「已删除成员」）。
// modelRef = '账号id|模型id'（复用 ai-config-model 的 resolveModelRef）；失效显示
// 「模型不可用」，不静默回退。

import {PERSONA_TEXT_MAX, REPLY_STYLES} from '../core/ai-persona.js';
import {findModelEntry, modelRefLabel, resolveModelRef} from '../core/ai-config-model.js';
import {normalizeAgentPreset} from './ai-agent-preset.js';

export const AGENT_MAX_COUNT = 32;
export const AGENT_NAME_MAX = 32;
export const AGENT_ROLE_MAX = 120;
export const AGENT_MODELREF_MAX = 200;
// 分组：agents[].group 的必有值字段（不选归「默认」），组列表 = 字段去重集合；
// 无独立存储实体，空组随最后一个成员离开而消失（feature-evaluations 2026-11-18 §3）。
export const AGENT_GROUP_MAX = 12;
export const AGENT_GROUP_NAME_MAX = 16;
export const AGENT_DEFAULT_GROUP = '默认';
// 点名保留词：@all 语义冲突，这些名字不能用于智能体（§6.1）
export const AGENT_RESERVED_NAMES = ['all', 'everyone', '全体成员', '所有人'];
// 头像圆点调色板：颜色名对应 style.css 的 .gc-dot-<name>；HEX 表供无 CSS 处（设置行内圆点）取色
export const AGENT_COLORS = ['blue', 'violet', 'green', 'amber', 'red', 'cyan', 'pink', 'lime'];
export const AGENT_COLOR_HEX = {
    blue: '#4d8bf5', violet: '#8b5cf6', green: '#34a853', amber: '#f59e0b',
    red: '#ef4444', cyan: '#06b6d4', pink: '#ec4899', lime: '#84cc16',
};

function clampText(value, max) {
    return String(value == null ? '' : value).slice(0, max);
}

export function normalizeAgentName(raw) {
    return String(raw == null ? '' : raw).normalize('NFC').trim();
}

// 名字合法性：'' = 合法，否则返回错误文案。唯一性按 NFC + 小写比较（§6.1）。
export function agentNameError(name, agents, excludeId) {
    const trimmed = normalizeAgentName(name);
    if (!trimmed) return '名字不能为空';
    if (trimmed.length > AGENT_NAME_MAX) return '名字不能超过 ' + AGENT_NAME_MAX + ' 字符';
    if (/[\s@]/.test(trimmed)) return '名字不能包含空白或 @';
    const lower = trimmed.toLowerCase();
    if (AGENT_RESERVED_NAMES.some((word) => word === trimmed || word.toLowerCase() === lower)) {
        return '「' + trimmed + '」是保留名（@全体成员语义冲突），请换一个';
    }
    const list = Array.isArray(agents) ? agents : [];
    const dup = list.some((agent) => agent && agent.id !== excludeId &&
        normalizeAgentName(agent.name).toLowerCase() === lower);
    if (dup) return '名字与现有智能体重名';
    return '';
}

function validReplyStyle(id) {
    return REPLY_STYLES.some((style) => style && style.id === id);
}

// 组名归一化：NFC + 去两端空白 + 限长；空 = 未选 → 调用方落「默认」。
export function normalizeGroupName(raw) {
    return String(raw == null ? '' : raw).normalize('NFC').trim().slice(0, AGENT_GROUP_NAME_MAX).trim();
}

// 新组名校验（设置页「新建分组」/ AI 代建）：'' = 合法，否则错误文案。
// 组名与成员名是两个命名空间：保留词 / @ 规则不适用；只禁空白两端与超长（去重另查）。
export function groupNameError(name, agents, excludeId) {
    const trimmed = String(name == null ? '' : name).normalize('NFC').trim();
    if (!trimmed) return '分组名不能为空';
    if (trimmed.length > AGENT_GROUP_NAME_MAX) return '分组名不能超过 ' + AGENT_GROUP_NAME_MAX + ' 字符';
    const final = trimmed.slice(0, AGENT_GROUP_NAME_MAX);
    const list = Array.isArray(agents) ? agents : [];
    const dup = list.some((agent) => agent && agent.id !== excludeId &&
        normalizeGroupName(agent.group).toLowerCase() === final.toLowerCase());
    if (dup) return '分组「' + final + '」已存在';
    return '';
}

// 分组建议过滤（编辑器弹窗的分组输入框）：包含匹配、大小写不敏感；空 query 给全量。
// 输入的名字不在列表里 = 新建分组（agentsUpsert 落组，groupNameError 管校验）。
export function filterGroupSuggestions(names, query) {
    const q = String(query == null ? '' : query).trim().toLowerCase();
    const list = Array.isArray(names) ? names : [];
    if (!q) return list.slice();
    return list.filter((name) => String(name || '').toLowerCase().includes(q));
}

// 单条归一化：name/id 全空的原始数据丢弃（返回 null），其余字段 clamp 到边界。
export function normalizeAgent(raw, index, idGen) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const name = normalizeAgentName(source.name);
    const id = String(source.id || '').trim();
    if (!name && !id) return null;
    let temperature = null;
    if (source.temperature != null && source.temperature !== '') {
        const t = Number(source.temperature);
        if (Number.isFinite(t)) temperature = Math.min(2, Math.max(-2, Math.round(t * 100) / 100));
    }
    const now = Date.now();
    return {
        id: id || (idGen ? idGen() : 'agent-' + now.toString(36)),
        name: name || ('智能体 ' + ((index || 0) + 1)),
        color: AGENT_COLORS.includes(source.color) ? source.color : AGENT_COLORS[(index || 0) % AGENT_COLORS.length],
        role: clampText(source.role, AGENT_ROLE_MAX),
        group: normalizeGroupName(source.group) || AGENT_DEFAULT_GROUP,
        modelRef: clampText(source.modelRef, AGENT_MODELREF_MAX),
        personaText: clampText(source.personaText, PERSONA_TEXT_MAX),
        replyStyle: validReplyStyle(source.replyStyle) ? source.replyStyle : 'default',
        // 声明式 preset（S6）：决定工具集 / 提示片段 / realm；无声明时为空壳，
        // 不覆盖上面的 personaText（后者是设置页可直接编辑的人设字段）。
        preset: source.preset ? normalizeAgentPreset(source.preset) : null,
        temperature,
        slowTier: source.slowTier === true,
        chair: source.chair === true,
        enabled: source.enabled !== false,
        createdAt: Number(source.createdAt) || now,
        updatedAt: Number(source.updatedAt) || Number(source.createdAt) || now,
    };
}

// 数组归一化：去重 id / 名字（冲突加后缀保留数据）、数量截到上限。
export function normalizeAgents(raw, idGen) {
    const list = [];
    if (!Array.isArray(raw)) return list;
    const usedIds = new Set();
    const usedNames = new Set();
    for (let index = 0; index < raw.length && list.length < AGENT_MAX_COUNT; index++) {
        const agent = normalizeAgent(raw[index], index, idGen);
        if (!agent) continue;
        let id = agent.id;
        let suffix = 2;
        while (usedIds.has(id)) id = agent.id + '-' + suffix++;
        agent.id = id;
        let name = agent.name;
        let n = 2;
        while (usedNames.has(name.toLowerCase())) name = agent.name + '-' + n++;
        agent.name = name;
        usedIds.add(id);
        usedNames.add(name.toLowerCase());
        list.push(agent);
    }
    return list;
}

// 新建 / 编辑：就地写入传入数组（配置里的 agents[] 即真源），返回 {ok, agent, error}。
export function agentsUpsert(agents, raw, idGen) {
    const list = Array.isArray(agents) ? agents : [];
    const source = raw && typeof raw === 'object' ? raw : {};
    const draft = normalizeAgent(source, list.length, idGen);
    if (!draft) return {ok: false, error: '智能体数据无效'};
    const editingId = String(source.id || '').trim();
    // 组数上限：本次写入会引入「新组名」且总数超限时拒绝（空组随成员离开自动消失）
    const existingGroups = agentGroups(list);
    if (!existingGroups.includes(draft.group) && existingGroups.length >= AGENT_GROUP_MAX) {
        return {ok: false, error: '分组最多 ' + AGENT_GROUP_MAX + ' 个'};
    }
    if (editingId) {
        const existing = list.find((agent) => agent && agent.id === editingId);
        if (!existing) return {ok: false, error: '智能体不存在或已被删除'};
        const nameError = agentNameError(draft.name, list, editingId);
        if (nameError) return {ok: false, error: nameError};
        Object.assign(existing, draft, {
            id: existing.id,
            createdAt: existing.createdAt,
            updatedAt: Date.now(),
        });
        return {ok: true, agent: existing};
    }
    if (list.length >= AGENT_MAX_COUNT) return {ok: false, error: '智能体最多 ' + AGENT_MAX_COUNT + ' 个'};
    const nameError = agentNameError(draft.name, list, '');
    if (nameError) return {ok: false, error: nameError};
    list.push(draft);
    return {ok: true, agent: draft};
}

export function agentsRemove(agents, id) {
    const list = Array.isArray(agents) ? agents : [];
    const index = list.findIndex((agent) => agent && agent.id === id);
    if (index < 0) return null;
    return list.splice(index, 1)[0];
}

export function agentById(agents, id) {
    const key = String(id || '');
    return (Array.isArray(agents) ? agents : []).find((agent) => agent && agent.id === key) || null;
}

// 组名清单：「默认」恒在且居首，其余按首次出现保序去重。
export function agentGroups(agents) {
    const list = Array.isArray(agents) ? agents : [];
    const out = [];
    for (const agent of list) {
        const group = normalizeGroupName(agent && agent.group) || AGENT_DEFAULT_GROUP;
        if (group !== AGENT_DEFAULT_GROUP && !out.includes(group)) out.push(group);
    }
    return [AGENT_DEFAULT_GROUP, ...out];
}

// 按组分区聚合（默认组居首；只返回有成员的组），供设置页列表与新建群聊成员区共用。
export function agentsByGroup(agents) {
    const list = Array.isArray(agents) ? agents : [];
    const out = [];
    for (const group of agentGroups(list)) {
        const bucket = list.filter((agent) =>
            (normalizeGroupName(agent && agent.group) || AGENT_DEFAULT_GROUP) === group);
        if (bucket.length) out.push({group, agents: bucket});
    }
    return out;
}

// 解析 modelRef：失效（账号/模型被删）返回 null，调用方显示「模型不可用」。
export function resolveAgentModel(agent, profiles) {
    const ref = resolveModelRef(agent && agent.modelRef, profiles);
    if (!ref) return null;
    const sep = ref.indexOf('|');
    const account = (Array.isArray(profiles) ? profiles : []).find((p) => p && p.id === ref.slice(0, sep));
    const entry = findModelEntry(account, ref.slice(sep + 1));
    return account && entry ? {account, entry, ref} : null;
}

// 超时档：模型本身会思考（Anthropic thinking / 兼容端点 reasoningEffort）或智能体手动
// 标注 slowTier（§16.12）→ 'thinking'（更长等待窗）；否则 'standard'。
export function agentThinkingTier(agent, profiles) {
    const resolved = resolveAgentModel(agent, profiles);
    if (!resolved) return agent && agent.slowTier ? 'thinking' : 'standard';
    const entry = resolved.entry;
    const thinking = entry.thinking === true || (entry.reasoningEffort || '') !== '';
    return (thinking || !!(agent && agent.slowTier)) ? 'thinking' : 'standard';
}

// 能力快照（群创建预检 / 成员徽标用；不落盘，随模型配置推导，§3.10）。
export function agentCapability(agent, profiles) {
    const resolved = resolveAgentModel(agent, profiles);
    if (!resolved) {
        return {
            available: false,
            contextWindow: 0,
            outputWindow: 0,
            thinking: false,
            slowTier: !!(agent && agent.slowTier),
            tier: agent && agent.slowTier ? 'thinking' : 'standard',
            label: '模型不可用',
        };
    }
    const entry = resolved.entry;
    return {
        available: true,
        contextWindow: entry.contextWindow || 0,
        outputWindow: entry.outputWindow || 0,
        thinking: entry.thinking === true || (entry.reasoningEffort || '') !== '',
        slowTier: !!(agent && agent.slowTier),
        tier: agentThinkingTier(agent, profiles),
        label: modelRefLabel(resolved.account, resolved.entry) || (entry.model || '模型'),
    };
}

// 可被群设为主持人的智能体（标记 chair 且启用；§3.1）
export function chairAgents(agents) {
    return (Array.isArray(agents) ? agents : []).filter((agent) => agent && agent.chair && agent.enabled);
}

// ==================== AI 代建智能体（app_control get_agents / create_agent） ====================

// 可用模型清单（ref = '账号id|模型id'）：get_agents 下发给模型选型，create_agent 解析后写回。
export function listModelOptions(profiles) {
    const out = [];
    for (const profile of Array.isArray(profiles) ? profiles : []) {
        if (!profile || typeof profile !== 'object') continue;
        for (const entry of Array.isArray(profile.models) ? profile.models : []) {
            if (!entry || !entry.id) continue;
            out.push({
                ref: String(profile.id || '') + '|' + entry.id,
                label: modelRefLabel(profile, entry) || entry.model || entry.id,
                model: String(entry.model || ''),
                account: String(profile.name || profile.id || ''),
            });
        }
    }
    return out;
}

// 按 id / 名字解析智能体（app_control create_group 的成员与主持人定位）：
// 精确 id → 名字精确（NFC 小写）→ 唯一子串。多命中返回候选让调用方报错，绝不静默取第一个。
export function resolveAgentByKeyword(agents, keyword) {
    const raw = String(keyword == null ? '' : keyword).trim();
    const options = (Array.isArray(agents) ? agents : []).filter((agent) => agent && typeof agent === 'object');
    if (!raw) return {ok: false, reason: 'empty', candidates: []};
    const byId = options.find((agent) => agent.id === raw);
    if (byId) return {ok: true, agent: byId};
    const lower = normalizeAgentName(raw).toLowerCase();
    const exact = options.filter((agent) => normalizeAgentName(agent.name).toLowerCase() === lower);
    if (exact.length === 1) return {ok: true, agent: exact[0]};
    if (exact.length > 1) return {ok: false, reason: 'ambiguous', candidates: exact};
    const contains = options.filter((agent) => normalizeAgentName(agent.name).toLowerCase().includes(lower));
    if (contains.length === 1) return {ok: true, agent: contains[0]};
    if (contains.length > 1) return {ok: false, reason: 'ambiguous', candidates: contains};
    return {ok: false, reason: 'not_found', candidates: []};
}

// 按关键词解析唯一模型，优先级：精确 ref → 「账号名/模型名」（/ ／ : ：皆可）→
// 模型名/展示名精确 → 唯一子串。多命中/未命中一律返回候选让调用方报错，绝不静默取第一个。
export function resolveModelByKeyword(profiles, keyword) {
    const raw = String(keyword == null ? '' : keyword).trim();
    const options = listModelOptions(profiles);
    if (!raw) return {ok: false, reason: 'empty', candidates: []};
    const byRef = options.find((option) => option.ref === raw);
    if (byRef) return {ok: true, option: byRef};
    const lower = raw.toLowerCase();
    const sep = /^(.+?)[/／:：](.+)$/.exec(raw);
    if (sep) {
        const account = sep[1].trim().toLowerCase();
        const model = sep[2].trim().toLowerCase();
        const hits = options.filter((option) => option.account.toLowerCase() === account && option.model.toLowerCase() === model);
        if (hits.length === 1) return {ok: true, option: hits[0]};
        if (hits.length > 1) return {ok: false, reason: 'ambiguous', candidates: hits};
    }
    const exact = options.filter((option) => option.model.toLowerCase() === lower || option.label.toLowerCase() === lower);
    if (exact.length === 1) return {ok: true, option: exact[0]};
    if (exact.length > 1) return {ok: false, reason: 'ambiguous', candidates: exact};
    const contains = options.filter((option) => option.model.toLowerCase().includes(lower));
    if (contains.length === 1) return {ok: true, option: contains[0]};
    if (contains.length > 1) return {ok: false, reason: 'ambiguous', candidates: contains};
    return {ok: false, reason: 'not_found', candidates: []};
}
