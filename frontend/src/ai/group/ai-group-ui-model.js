// ai-group-ui-model.js：群聊视图的纯函数层（G6 面板化重写）。
// 时间线合并（消息 + 关键系统事件）、日期/轮次分隔、连续消息合并、@ 补全解析、
// 头像与状态文案、预览截断。无 DOM、无副作用，可单测。
import {AGENT_COLOR_HEX} from '../agent/ai-agent-model.js';
import {GROUP_LAST_PREVIEW_MAX} from './ai-group-model.js';

// 连续消息合并窗口：同一作者 5 分钟内的发言收成一块（QQ/微信群式）
export const MERGE_WINDOW_MS = 5 * 60 * 1000;

// 进入时间线的系统事件白名单：runtime 落盘的 meta 事件里这些带人类可读 text；
// 其余（内部统计类）不进聊天流，避免刷屏。
const EVENT_TYPES = new Set(['mention', 'compress', 'budget', 'task-update', 'speech-timeout', 'context-overflow', 'relay']);

export function eventLineText(evt) {
    if (!evt || !EVENT_TYPES.has(evt.type)) return '';
    return String(evt.text || '').trim();
}

export function memberColorHex(color) {
    return AGENT_COLOR_HEX[color] || '#989898';
}

// 头像首字：取第一个字素（中文/emoji 都取一个显示单元）
export function memberInitial(name) {
    const chars = Array.from(String(name || '').trim());
    return chars.length ? chars[0] : '?';
}

// HH:MM（24 小时制，聊天时间戳）
export function timeLabel(ts) {
    const d = new Date(Number(ts) || 0);
    const pad = (n) => String(n).padStart(2, '0');
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 日期分隔：今天 / 昨天 / M月D日（跨年补年份）
export function dateLabel(ts, now) {
    const date = new Date(Number(ts) || 0);
    const ref = new Date(Number(now) || Date.now());
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diffDays = Math.round((startOfDay(ref) - startOfDay(date)) / 86400000);
    if (diffDays === 0) return '今天';
    if (diffDays === 1) return '昨天';
    const sameYear = date.getFullYear() === ref.getFullYear();
    const base = (date.getMonth() + 1) + '月' + date.getDate() + '日';
    return sameYear ? base : date.getFullYear() + '年' + base;
}

// 相邻两条消息的本地日期是否不同（决定是否插日期分隔）
export function needsDateBreak(prevTs, ts, now) {
    if (prevTs == null) return true;
    return dateLabel(prevTs, now) !== dateLabel(ts, now);
}

// 连续消息合并：同作者、同轮次、间隔 ≤5 分钟、双方都是普通对话（非系统/纪要/失败）
export function shouldMerge(prev, cur) {
    if (!prev || !cur) return false;
    if (prev.role === 'system' || cur.role === 'system') return false;
    if (prev.kind === 'minutes' || cur.kind === 'minutes') return false;
    const sameAuthor = prev.role === 'user'
        ? cur.role === 'user'
        : (cur.role === 'assistant' && prev.agentId === cur.agentId);
    if (!sameAuthor) return false;
    if ((Number(cur.round) || 0) !== (Number(prev.round) || 0)) return false;
    const failed = (m) => m.status && m.status !== 'done';
    if (failed(prev) || failed(cur)) return false;
    const gap = (Number(cur.ts) || 0) - (Number(prev.ts) || 0);
    return gap >= 0 && gap <= MERGE_WINDOW_MS;
}

// 轮次分隔：非自由模式、轮次号有效且与上一条不同
export function needsRoundBreak(prev, cur, meta) {
    if (!meta || meta.mode === 'free') return false;
    const round = Number(cur && cur.round) || 0;
    if (round <= 0) return false;
    if (!prev || prev.role === 'system' || prev.kind === 'minutes') return true;
    return (Number(prev.round) || 0) !== round;
}

// @ 补全：返回光标前最后一个可补全的 {@ 起点索引, 已输入的查询}；不在补全态返回 null。
// 规则：@ 与光标之间不能出现空白；@ 允许紧跟在文字后面（中文输入习惯「请@审查员」，
// 不强制空白前缀），代价是 'a@b' 这类文本也会触发——群聊输入框里可接受。
export function mentionQuery(text, caret) {
    const value = String(text || '');
    const at = Math.min(Math.max(0, Number(caret) || 0), value.length);
    let start = -1;
    for (let i = at - 1; i >= 0; i--) {
        const ch = value[i];
        if (ch === '@') {
            start = i;
            break;
        }
        if (/\s/.test(ch)) break;
    }
    if (start < 0) return null;
    return {start, query: value.slice(start + 1, at)};
}

// 应用补全：把 [start, caret) 区间替换为「@名字 」，返回新文本与新光标位置。
export function applyMention(text, caret, name) {
    const parsed = mentionQuery(text, caret);
    if (!parsed) return {text: String(text || ''), caret: Math.max(0, Number(caret) || 0)};
    const value = String(text || '');
    const insert = '@' + String(name || '') + ' ';
    const next = value.slice(0, parsed.start) + insert + value.slice(Math.max(0, Number(caret) || 0));
    return {text: next, caret: parsed.start + insert.length};
}

// 补全候选过滤：名字包含查询（不区分大小写）；空查询给全部
export function filterMentionCandidates(candidates, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return candidates.slice();
    return candidates.filter((name) => String(name || '').toLowerCase().includes(q));
}

// 讨论状态文案（工具栏一行）：自由 / 讨论 / 暂停 / 纪要 / 空；接力按 run（relaySnapshot）分支
export function groupStatusText(meta, run) {
    if (!meta) return '';
    if (meta.mode === 'free') return '自由聊天 · 发消息即回，@点名谁谁回，@全体成员人人回';
    if (meta.mode === 'relay') return relayStatusText(meta, run);
    const running = !!(run && run.running);
    const paused = !!(run && run.paused);
    if (running) return '讨论中 · ' + ((run.speeches || 0)) + ' 次发言';
    if (paused) return '已暂停 · ' + (run.error || '点「继续」接着讨论');
    if (meta.minutes) return '本场已产出纪要';
    return '';
}

// 接力状态文案（G7）：进行中 / 暂停 / 已完成 / 中断待续 / 待开工
function relayStatusText(meta, run) {
    const relayMeta = meta.relay || {};
    // 内存态 relays 重启后为空（run=null），但 meta.relay 是持久真源：据此回退棒数/断点，
    // 否则已完成的接力会显示成「待开工」、中断态丢失断点提示。
    const memberCount = Array.isArray(meta.memberIds) ? meta.memberIds.length : 0;
    const count = (run && run.stageCount) || memberCount;
    const stage = (run && run.stage) || 0;
    if (run && run.running) {
        const at = count ? `第 ${stage}/${count} 棒${run.stageName ? `（${run.stageName}）` : ''}` : '';
        return '接力中' + (at ? ` · ${at}` : '') + ` · ${(run.speeches || 0)} 次发言`;
    }
    if (run && run.paused) return `已暂停 · 停在第 ${stage}${count ? `/${count}` : ''} 棒，点「继续」接着跑`;
    if (relayMeta.done && count) return `接力已完成（${count} 棒${relayMeta.passes > 1 ? ` · 第 ${relayMeta.passes} 遍` : ''}）· 发新需求或点「开始接力」再跑一遍`;
    if (relayMeta.stage > 0 && count && !relayMeta.done) return `接力中断于第 ${Math.min(relayMeta.stage, count) + 1} 棒 · 点「继续接力」从断点接着跑`;
    return '接力待开工 · 发条需求或点「开始接力」，成员按链序交棒';
}

// 主按钮文案：开始讨论 / 暂停 / 继续（free 不显示）；接力为 开始接力 / 暂停 / 继续
export function discussionActionLabel(meta, run) {
    if (!meta || meta.mode === 'free') return '';
    const running = !!(run && run.running);
    const paused = !!(run && run.paused);
    if (running) return '暂停';
    if (paused) return '继续';
    if (meta.mode === 'relay') return (meta.relay && meta.relay.stage > 0 && !meta.relay.done) ? '继续接力' : '开始接力';
    if (meta.discussion && meta.discussion.round > 0 && !meta.minutes) return '继续讨论';
    return '开始讨论';
}

// 消息失败态的状态行文案（气泡下方小字）
export function statusLineOf(msg) {
    if (!msg) return '';
    if (msg.timeout) return '超时未发言，已跳过';
    if (msg.status === 'error') return '发言失败' + (msg.error ? '：' + msg.error : '');
    if (msg.status === 'stopped') return '已停止';
    if (msg.status === 'interrupted') return '已中断';
    return '';
}

// 侧栏预览截断：who：content（空白折叠，超长截断）
export function previewOfMessage(msg, max) {
    if (!msg) return '';
    const who = msg.kind === 'minutes'
        ? '纪要'
        : (msg.role === 'user' ? '你' : (msg.chair ? '主持人' : (msg.agentName || '成员')));
    const text = String(msg.content || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return (who + '：' + text).slice(0, Math.max(1, Number(max) || GROUP_LAST_PREVIEW_MAX));
}

// ---------- @ 胶囊（QQ 式）：文本域保持纯文本，镜像层按 range 画胶囊 ----------

// 扫描文本里的 @提及（与 parseMentions 同语义：@ 后跟合法成员名，长名优先、不重叠）。
// 返回 [{start, end, name}]（end 不含紧随的空格）；文本是唯一真源，胶囊只是渲染。
export function scanMentions(text, names) {
    const value = String(text || '');
    const sorted = [...new Set((names || []).map((n) => String(n || '').trim()).filter(Boolean))]
        .sort((a, b) => b.length - a.length);
    const out = [];
    let i = 0;
    while (i < value.length) {
        if (value[i] !== '@') { i += 1; continue; }
        let matched = null;
        for (const name of sorted) {
            if (value.startsWith(name, i + 1)) { matched = name; break; }
        }
        if (!matched) { i += 1; continue; }
        out.push({start: i, end: i + 1 + matched.length, name: matched});
        i += 1 + matched.length;
    }
    return out;
}

// 镜像层 HTML：与文本域同字体同度量，胶囊 span 占据的字符与原文完全一致（不改变排版）。
// 胶囊把紧随的空格一并盖住（右边距感），换行结尾补零宽字符保持行数一致。
export function buildRichHtml(text, ranges) {
    const value = String(text || '').replace(/\r\n/g, '\n');
    const esc = (s) => String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const parts = [];
    let cursor = 0;
    for (const r of ranges || []) {
        if (!r || r.start < cursor || r.start >= value.length) continue;
        if (r.start > cursor) parts.push(esc(value.slice(cursor, r.start)));
        const withSpace = value[r.end] === ' ' ? r.end + 1 : r.end;
        const label = value.slice(r.start, withSpace);
        parts.push(`<span class="gc-pill" data-name="${esc(r.name)}">${esc(label)}</span>`);
        cursor = withSpace;
    }
    parts.push(esc(value.slice(cursor)));
    let html = parts.join('');
    if (html.endsWith('\n')) html += '\u200b';
    return html;
}

// 原子删除范围：Backspace/Delete 命中胶囊时整段删（返回 null = 交给浏览器默认行为）。
// 折叠光标：Backspace 命中「胶囊内或紧贴胶囊尾」删整颗；Delete 对称（胶囊头或胶囊内）。
// 选区：扩到所有与之相交的胶囊的完整范围。
export function expandDeletionRange(ranges, start, end, direction) {
    const list = Array.isArray(ranges) ? ranges : [];
    const s = Math.max(0, Math.round(Number(start) || 0));
    const e = Math.max(0, Math.round(Number(end) || 0));
    if (s === e) {
        const pos = s;
        const hit = direction === 'delete'
            ? list.find((r) => r.start <= pos && pos < r.end)
            : list.find((r) => r.start < pos && pos <= r.end);
        if (!hit) return null;
        return {start: hit.start, end: hit.end};
    }
    let lo = Math.min(s, e);
    let hi = Math.max(s, e);
    let touched = false;
    for (const r of list) {
        if (r.start < hi && r.end > lo) {
            lo = Math.min(lo, r.start);
            hi = Math.max(hi, r.end);
            touched = true;
        }
    }
    return touched ? {start: lo, end: hi} : null;
}
