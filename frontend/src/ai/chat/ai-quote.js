// ai-quote.js：对话引用（把 AI 回复 / 用户消息引用到输入框）的标记与展示纯函数单一来源。
// 标记拼在 user content 前缀，不进 <attachments>：语义上是「用户在指这段」而不是系统规则，
// 且随消息落 JSONL，历史可复查、压缩不丢。气泡渲染时由 ai-panel.js 拆出引用块单独展示。
import {aiTextOf} from '../core/ai-constants.js';

export const AI_QUOTE_KIND = 'message_quote';
export const AI_QUOTE_EXCERPT_LIMIT = 160;

// 只认 buildQuoteMarkup 生成的严格形状，避免把用户正文里手写的 <quote> 误判成引用块。
const QUOTE_PREFIX_RE = /^<quote source="([^"]*)" index="(-?\d+)" scope="(message|selection)">\n([\s\S]*?)\n<\/quote>\s*/;

function escAttr(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescAttr(value) {
    return String(value == null ? '' : value)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

// 引用正文里的 </quote> 会提前闭合标记；换成全角斜杠，内容基本原样保留。
export function neutralizeQuoteText(text) {
    return aiTextOf(text).replace(/<\/quote\s*>/gi, '<／quote>');
}

export function buildQuoteMarkup(quotes) {
    const list = (quotes || []).filter((item) => item && aiTextOf(item.text).trim());
    if (!list.length) return '';
    return list.map((item) => {
        const source = aiTextOf(item.source) || 'assistant';
        const index = Number.isInteger(Number(item.index)) ? Number(item.index) : -1;
        const scope = item.scope === 'selection' ? 'selection' : 'message';
        return '<quote source="' + escAttr(source) + '" index="' + index + '" scope="' + scope + '">\n' +
            neutralizeQuoteText(item.text) + '\n</quote>';
    }).join('\n\n');
}

export function quoteMarkupFromAttachments(attachments) {
    const list = (attachments || []).filter((item) => item && item.kind === AI_QUOTE_KIND);
    return buildQuoteMarkup(list.map((item) => ({
        source: item.source,
        index: item.index,
        scope: item.scope,
        text: item.content,
    })));
}

export function splitQuotePrefix(content) {
    const text = aiTextOf(content);
    const quotes = [];
    let rest = text;
    let match = QUOTE_PREFIX_RE.exec(rest);
    while (match) {
        quotes.push({
            source: unescAttr(match[1]) || 'assistant',
            index: Number(match[2]),
            scope: match[3],
            text: match[4],
        });
        rest = rest.slice(match[0].length);
        match = QUOTE_PREFIX_RE.exec(rest);
    }
    return {quotes, body: rest};
}

// 气泡里截断成单行摘要；完整原文交给 title/tooltip，不改动持久化内容。
export function quoteExcerpt(text, limit = AI_QUOTE_EXCERPT_LIMIT) {
    const full = aiTextOf(text);
    const flat = full.replace(/\s+/g, ' ').trim();
    const cap = Math.max(20, Number(limit) || AI_QUOTE_EXCERPT_LIMIT);
    if (flat.length <= cap) return flat;
    return flat.slice(0, cap) + '…（共 ' + full.length + ' 字符，悬浮查看全部）';
}

export function quoteChipLabel(quote) {
    const role = quote && quote.source === 'user' ? '用户消息' : '助手回复';
    const index = (quote && Number(quote.index)) || 0;
    return role + ' #' + index + (quote && quote.scope === 'selection' ? '（选区）' : '（整条）');
}

export function quoteLabel(quote) {
    return '引用 · ' + quoteChipLabel(quote);
}

// 卡片摘要：压平空白后按 limit 截断，只补一个省略号。与 quoteExcerpt 不同，
// 卡片已有 tooltip 与「点击看全文」，不再追加「（共 N 字符，悬浮查看全部）」的啰嗦尾巴。
export function quoteCardExcerpt(text, limit = 120) {
    const flat = aiTextOf(text).replace(/\s+/g, ' ').trim();
    const cap = Math.max(20, Number(limit) || 120);
    if (flat.length <= cap) return flat;
    return flat.slice(0, cap) + '…';
}

// 点击引用开全文时用的虚拟只读文档：标题含角色/索引/scope，content 兼容
// composer 附件（item.content）与气泡引用（quote.text）两种字段名。
export function quoteFullDoc(quote) {
    const name = '引用全文 — ' + quoteChipLabel(quote) + '.txt';
    const content = aiTextOf((quote && (quote.content || quote.text)) || '');
    return {name, content};
}
