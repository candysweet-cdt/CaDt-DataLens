// ai-inline-edit.js：用户消息原地编辑的纯数据层（快照归一 / 保存载荷组装）。
// DOM 与控制器在 ai-panel.js；这里不碰 DOM，便于单测（test/ai/ai-inline-edit.test.mjs）。
// 方案见 docs/finished-plans/inline-message-edit.md。
import {AI_QUOTE_KIND, quoteMarkupFromAttachments} from './ai-quote.js';

// 快照里允许的附件种类：只收「文本类」附件。图片 / 视频继续走 message.images / videos
// （落盘时已外置成文件引用），引用块继续从 content 前缀解析（旧消息也认），都不进快照。
export const INLINE_EDIT_SNAPSHOT_KINDS = ['file', 'skill', 'reference', 'selection', 'selection_reference'];
export const INLINE_EDIT_MAX_ITEMS = 40;
export const INLINE_EDIT_LABEL_MAX = 200;
export const INLINE_EDIT_CONTENT_MAX = 64 << 10;

function textOf(value) {
    return typeof value === 'string' ? value : (value == null ? '' : String(value));
}

// 一条快照项：kind 白名单 + 字段规范化；非法项返回 null（由调用方丢弃）。
function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const kind = INLINE_EDIT_SNAPSHOT_KINDS.includes(raw.kind) ? raw.kind : '';
    if (!kind) return null;
    const item = {
        kind,
        label: textOf(raw.label).slice(0, INLINE_EDIT_LABEL_MAX),
        path: textOf(raw.path),
        content: textOf(raw.content).slice(0, INLINE_EDIT_CONTENT_MAX),
    };
    // 选区引用的行列范围：随消息落盘，编辑后重发时原样带回
    const range = raw.range && typeof raw.range === 'object' ? raw.range : null;
    if (range) {
        item.range = {
            start: {line: Number(range.start && range.start.line) || 0, column: Number(range.start && range.start.column) || 0},
            end: {line: Number(range.end && range.end.line) || 0, column: Number(range.end && range.end.column) || 0},
        };
    }
    if (raw.start && raw.end) {
        item.start = raw.start;
        item.end = raw.end;
    }
    return item;
}

// 落盘快照的读取归一：非数组 / null 安全；逐项校验 kind、截断长度、封顶数量。
// 空数组返回 []（调用方据「有没有可编辑附件」决定是否显示附件条）。
export function normalizeMessageAttachments(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const entry of raw) {
        const item = normalizeItem(entry);
        if (!item) continue;
        out.push(item);
        if (out.length >= INLINE_EDIT_MAX_ITEMS) break;
    }
    return out;
}

// 保存载荷：与输入区 submitText 的口径逐条对齐——
// 引用 chip 拼回正文前缀（不进 <attachments>）、媒体单独分组、其余走文本附件。
export function inlineEditPayload(items, text) {
    const list = (Array.isArray(items) ? items : []).filter((item) => item && typeof item === 'object');
    const quoteMarkup = quoteMarkupFromAttachments(list);
    const body = textOf(text).trim();
    return {
        value: quoteMarkup ? (body ? quoteMarkup + '\n\n' + body : quoteMarkup) : body,
        images: list.filter((item) => item.kind === 'image'),
        videos: list.filter((item) => item.kind === 'video'),
        texts: list.filter((item) => item.kind !== 'image' && item.kind !== 'video' && item.kind !== AI_QUOTE_KIND),
    };
}

// 发消息时把输入区的文本类附件固化成快照（随用户消息落 JSONL）。
// 只收快照白名单里的种类；媒体 / 引用由既有字段与前缀承载，不重复存。
export function snapshotFromAttachments(attachments) {
    const list = Array.isArray(attachments) ? attachments : [];
    const out = [];
    for (const item of list) {
        const normalized = normalizeItem(item);
        if (!normalized) continue;
        out.push(normalized);
        if (out.length >= INLINE_EDIT_MAX_ITEMS) break;
    }
    return out;
}
