// ai-session-tools.js：AI 跨会话检索工具（session_search / session_read）的纯函数——
// 搜索结果分组渲染与会话 JSONL 摘要。工具执行在 ai-panel.js，这里只做无副作用整形，
// 配套测试见 ai-session-tools.test.mjs。
import {replaySessionLog, textOf} from './ai-session-store.js';
import {splitTurnReminderPrefix} from '../chat/ai-turn-reminder.js';

// 单次 session_read 的输出预算：总字符上限与单条消息截断长度（跨会话上下文，宁可少给不要灌满）
export const AI_SESSION_DIGEST_MAX_CHARS = 8000;
export const AI_SESSION_MESSAGE_MAX_CHARS = 800;

function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function oneLine(text, max) {
    const value = textOf(text).replace(/\s+/g, ' ').trim();
    return value.length > max ? value.slice(0, max) + '…' : value;
}

function roleLabel(role) {
    switch (textOf(role)) {
        case 'user': return '用户';
        case 'assistant': return '助手';
        case 'tool': return '工具';
        case 'system': return '系统';
        default: return textOf(role) || '?';
    }
}

// 本地时间「YYYY-MM-DD HH:mm」；顺手作为模型判断会话新旧的可读依据（不参与逻辑）
function formatTs(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n);
    const pad = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 消息正文提取：content 可能是字符串，也可能是分段数组（部分供应商的格式）
export function messageTextOf(message) {
    const content = message && message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (typeof part === 'string') return part;
            if (part && typeof part === 'object') return textOf(part.text);
            return '';
        }).join('');
    }
    return textOf(content);
}

// session_search 结果：按会话分组列出命中片段（跨会话检索的语义就是「先看哪个会话说过」）
export function formatSessionSearchResult(query, result) {
    const q = textOf(query).trim();
    const hits = Array.isArray(result && result.hits) ? result.hits : [];
    const brief = !!(result && result.brief);
    const truncated = !!(result && result.truncated);
    const lines = ['会话检索：' + q + '（' + (brief ? '简要：用户消息 + 每轮最后一条助手回复' : '全文') + '）'];
    if (!hits.length) {
        lines.push('没有找到匹配的会话内容。换个关键词再试，或让用户自己用全局搜索的「AI 会话」分类查看。');
        return lines.join('\n');
    }
    const groups = new Map();
    for (const hit of hits) {
        if (!hit || typeof hit !== 'object') continue;
        const id = textOf(hit.sessionId);
        if (!id) continue;
        if (!groups.has(id)) {
            groups.set(id, {
                id, title: textOf(hit.title) || '(无标题)',
                group: textOf(hit.group).trim(), ts: Number(hit.ts) || 0, items: [],
            });
        }
        const group = groups.get(id);
        group.items.push(hit);
        if (!group.ts && Number(hit.ts)) group.ts = Number(hit.ts);
    }
    let index = 0;
    for (const group of groups.values()) {
        const when = formatTs(group.ts);
        lines.push('');
        lines.push('● ' + group.title + (when ? '（' + when + '）' : '') + ' · id: ' + group.id
            + (group.group ? ' · 分组：' + group.group : ''));
        for (const hit of group.items) {
            index++;
            // 用户消息片段去掉开头的 <system-reminder> 环境块（宿主注入的每轮状态，不是用户说的内容）
            const snippet = splitTurnReminderPrefix(hit.snippet).body;
            lines.push('  ' + index + '. [' + roleLabel(hit.role) + '] ' + (oneLine(snippet, 200) || '(无片段)'));
        }
    }
    lines.push('');
    lines.push('要看上下文：session_read(id, query?) —— 默认读最近 20 条，给了 query 就定位关键词附近的消息。' +
        '这些片段来自其他会话（可能是别的工作区），引用前先核对与当前任务的关系。');
    if (truncated) lines.push('（结果已截断：命中过多，缩小关键词范围更有效）');
    return lines.join('\n');
}

// session_read：把会话 JSONL 原文摘要成「头部信息 + 若干条消息」。
// options.query 给了就按关键词定位（返回命中消息及其前后各一条），否则取最近 limit 条。
export function sessionLogDigest(raw, options = {}) {
    const limit = clampInt(options.limit, 1, 50, 20);
    const query = textOf(options.query).trim();
    const currentWorkspace = textOf(options.workspace).trim();
    const replayed = replaySessionLog(raw);
    const header = replayed.header && typeof replayed.header === 'object' ? replayed.header : {};
    const messages = Array.isArray(replayed.messages) ? replayed.messages : [];
    const title = textOf(header.title) || textOf(options.title) || '(无标题)';
    const workspace = textOf(header.workspace);
    const head = ['会话：' + title + ' · id: ' + (textOf(header.id) || textOf(options.id) || '?')];
    const metaParts = [];
    const group = textOf(options.group).trim();
    if (group) metaParts.push('分组：' + group);
    if (workspace) metaParts.push('工作区：' + workspace);
    const created = formatTs(header.createdAt);
    if (created) metaParts.push('创建于 ' + created);
    metaParts.push('消息 ' + messages.length + ' 条' + (replayed.archived.length ? '（另有归档 ' + replayed.archived.length + ' 条）' : ''));
    head.push(metaParts.join(' · '));
    if (workspace && currentWorkspace && workspace !== currentWorkspace) {
        head.push('注意：这是别的工作区的会话，内容未必适用于当前工作区。');
    }
    if (replayed.torn) head.push('（日志尾部未提交，最后一条可能不完整）');
    if (!messages.length) {
        head.push('（这个会话没有可读的消息）');
        return head.join('\n');
    }

    const picked = [];
    if (query) {
        const needle = query.toLowerCase();
        const hitIndexes = [];
        messages.forEach((message, index) => {
            if (messageTextOf(message).toLowerCase().includes(needle)) hitIndexes.push(index);
        });
        if (!hitIndexes.length) {
            head.push('没有在该会话里找到关键词：' + query + '（可省略 query 直接读最近 ' + limit + ' 条）');
            return head.join('\n');
        }
        const seen = new Set();
        for (const center of hitIndexes.slice(0, limit)) {
            for (let i = center - 1; i <= center + 1; i++) {
                if (i < 0 || i >= messages.length || seen.has(i)) continue;
                seen.add(i);
                picked.push({index: i, message: messages[i]});
                if (picked.length >= limit) break;
            }
            if (picked.length >= limit) break;
        }
        picked.sort((a, b) => a.index - b.index);
    } else {
        const start = Math.max(0, messages.length - limit);
        for (let i = start; i < messages.length; i++) picked.push({index: i, message: messages[i]});
    }

    const lines = head;
    let used = lines.join('\n').length;
    let clipped = false;
    for (const item of picked) {
        const when = formatTs(item.message && item.message.ts);
        // 用户消息正文去掉开头的 <system-reminder> 环境块（宿主注入的每轮状态，不是用户说的内容）
        const body = oneLine(splitTurnReminderPrefix(messageTextOf(item.message)).body, AI_SESSION_MESSAGE_MAX_CHARS);
        const line = '[#' + (item.index + 1) + ' ' + roleLabel(item.message && item.message.role) + (when ? ' ' + when : '') + '] ' + (body || '(空)');
        if (used + line.length > AI_SESSION_DIGEST_MAX_CHARS) {
            clipped = true;
            break;
        }
        lines.push(line);
        used += line.length + 1;
    }
    if (clipped) lines.push('…（已按输出预算截断，缩小 query 或用更小的 limit 继续读）');
    return lines.join('\n');
}
