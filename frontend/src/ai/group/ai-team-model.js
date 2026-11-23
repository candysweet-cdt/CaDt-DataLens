// ai-team-model.js：智能体团队详情页的纯数据模型（主代理根 + 子树、统计、卡片副行文案）。
// 树的父子归属与排序复用 ai-agent-tree.js；这里只做「主代理置顶」与展示文案。
import {buildAgentTree} from '../agent/ai-agent-tree.js';
import {sandboxModeLabel} from '../security/ai-sandbox-grant.js';

export const TEAM_MAIN_KEY = '__main__';

// 主代理的合成根条目：subId 用会话 id，一级子代理的 parentSessionId 正好指向它。
export function makeMainAgentNode(info) {
    const main = info || {};
    return {
        key: TEAM_MAIN_KEY,
        toolCallId: TEAM_MAIN_KEY,
        subId: String(main.sessionId || ''),
        parentSessionId: '',
        name: String(main.title || '').trim() || '主代理',
        task: '',
        depth: 0,
        state: main.state || 'idle',
        startedAt: 0,
        main: true,
    };
}

// 返回根节点数组；主代理节点永远排第一（不受「运行中优先、新派在前」影响）。
export function buildTeamTree(mainAgent, agents) {
    const list = Array.isArray(agents) ? agents.filter(Boolean) : [];
    const main = mainAgent && mainAgent.key ? mainAgent : makeMainAgentNode({});
    const roots = buildAgentTree([main, ...list]);
    const idx = roots.findIndex((node) => node.agent === main);
    if (idx > 0) {
        const [mainNode] = roots.splice(idx, 1);
        roots.unshift(mainNode);
    }
    return roots;
}

// 层号文案的单一来源：内部 depth 以主代理为 0，而人读的层号以主代理为第 1 层
// （直接派出的子代理 = 第 2 层）。所有界面与工具文案都必须走这里，不要直接用 depth。
export function agentLevelText(depth) {
    return '第 ' + ((Number(depth) || 0) + 1) + ' 层';
}

export function teamAgentStats(agents) {
    const stats = {total: 0, running: 0, done: 0, error: 0, stopped: 0};
    for (const agent of Array.isArray(agents) ? agents : []) {
        if (!agent) continue;
        stats.total++;
        if (Object.prototype.hasOwnProperty.call(stats, agent.state) && agent.state !== 'total') stats[agent.state]++;
    }
    return stats;
}

export function formatDuration(ms) {
    const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
    if (total < 60) return Math.round(total) + 's';
    const minutes = Math.floor(total / 60);
    const seconds = Math.round(total % 60);
    if (minutes < 60) return seconds ? minutes + '分' + seconds + '秒' : minutes + '分钟';
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? hours + '小时' + rest + '分' : hours + '小时';
}

export function formatTokens(n) {
    const total = Math.max(0, Math.round(Number(n) || 0));
    if (!total) return '';
    if (total < 1000) return total + ' tokens';
    if (total < 1000000) return (total / 1000).toFixed(1).replace(/\.0$/, '') + 'K tokens';
    return (total / 1000000).toFixed(1).replace(/\.0$/, '') + 'M tokens';
}

// 详情卡片的副行文案：层级 / 沙箱档 / 模式 / 轮次 / 用时 / token / 待处理消息。
export function agentNodeMeta(agent) {
    const a = agent || {};
    const bits = [];
    if (Number(a.depth) >= 1) bits.push(agentLevelText(a.depth));
    if (a.sandboxMode) bits.push('沙箱 ' + sandboxModeLabel(a.sandboxMode));
    if (a.mode === 'background') bits.push('后台');
    if (Number(a.rounds) > 0) bits.push(a.rounds + ' 轮');
    if (Number(a.ms) > 0) bits.push(formatDuration(a.ms));
    const tokens = formatTokens(a.tokens);
    if (tokens) bits.push(tokens);
    if (a.compacting) bits.push('压缩中');
    if (Number(a.inboxCount) > 0) bits.push('待处理 ' + a.inboxCount);
    return bits;
}

export function taskSnippet(task, max) {
    const limit = Math.max(8, Number(max) || 120);
    const line = String(task || '').replace(/\s+/g, ' ').trim();
    return line.length > limit ? line.slice(0, limit) + '…' : line;
}

// ---- agent_tree 工具的文本输出：供模型看清团队结构、拿各层级 id 与自己的身份 ----
const TREE_STATE_LABEL = {running: '运行中', done: '已完成', error: '失败', stopped: '已停止'};

function subtreeAgents(node) {
    const out = [node.agent];
    for (const child of node.children) out.push(...subtreeAgents(child));
    return out;
}

function agentTreeLine(agent, viewerId) {
    const bits = ['[' + (TREE_STATE_LABEL[agent.state] || agent.state || '已完成') + '] '
        + (agent.name || '子代理')];
    if (agent.subId) bits.push('id=' + agent.subId);
    if (Number(agent.depth) >= 1) bits.push(agentLevelText(agent.depth));
    if (agent.sandboxMode) bits.push('沙箱 ' + sandboxModeLabel(agent.sandboxMode));
    if (agent.mode === 'background') bits.push('后台');
    if (Number(agent.rounds) > 0) bits.push(agent.rounds + ' 轮');
    const task = taskSnippet(agent.task, 40);
    if (task) bits.push(task);
    if (viewerId && String(agent.subId || '') === viewerId) bits.push('（你）');
    return bits.join(' · ');
}

// viewer: {isMain, id, name?, title?, depth?}；agents: listAgentsForHud 的条目。
// 主代理看整棵树；子代理只看自己这一支，并在自己那行标「（你）」。
export function agentTreeText(viewer, agents) {
    const list = (Array.isArray(agents) ? agents : []).filter(Boolean);
    const isMain = !viewer || !!viewer.isMain;
    const viewerId = String((viewer && viewer.id) || '');
    const roots = buildAgentTree(list);
    let selfNode = null;
    const find = (nodes) => {
        for (const node of nodes) {
            if (viewerId && String(node.agent.subId || '') === viewerId) {
                selfNode = node;
                return true;
            }
            if (find(node.children)) return true;
        }
        return false;
    };
    if (!isMain) find(roots);
    const scoped = !isMain && selfNode ? [selfNode] : roots;
    const scopedAgents = !isMain && selfNode
        ? subtreeAgents(selfNode)
        : list;
    const stats = teamAgentStats(scopedAgents);

    const lines = [];
    if (isMain) {
        lines.push('你是：主代理（根节点）');
        lines.push('团队：运行中 ' + stats.running + ' · 共 ' + stats.total);
        lines.push('- [主代理] ' + ((viewer && viewer.title) || '当前会话') + '（根）');
    } else {
        const name = (viewer && viewer.name) || (selfNode && selfNode.agent.name) || '子代理';
        lines.push('你是：「' + name + '」' + (viewerId ? ' id=' + viewerId : '') +
            (viewer && Number(viewer.depth) >= 1 ? '（' + agentLevelText(viewer.depth) + '）' : ''));
        lines.push('本支：运行中 ' + stats.running + ' · 共 ' + stats.total);
        if (!selfNode) lines.push('（团队记录里暂时查不到你自己，下面是能看到的团队树）');
    }
    const walk = (nodes, level) => {
        for (const node of nodes) {
            lines.push('  '.repeat(level) + '- ' + agentTreeLine(node.agent, viewerId));
            walk(node.children, level + 1);
        }
    };
    walk(scoped, isMain ? 1 : 0);
    if (!list.length) lines.push(isMain ? '（还没有派出子代理）' : '（你还没有派出子代理）');
    return lines.join('\n');
}
