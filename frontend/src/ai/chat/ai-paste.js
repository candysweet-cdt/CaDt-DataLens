// ai-paste.js：AI 输入框长文本粘贴的纯函数单一来源（零 I/O、便于单测）。
// 三档模式（off / attachment / collapse）与折叠胶囊的标记、扫描、镜像 HTML、展开。
// 胶囊机制沿用群聊 @ 提及的「文本是唯一真源、镜像层画胶囊」方案（ai-group-ui-model.js）：
// 正文里胶囊 = 一段标记文本 ⟦贴N⟧，镜像层按 range 渲染成彩色 span，占据字符与原文严格等宽。
// 配套测试：test/ai/ai-paste.test.mjs。

// 超过该字符数才折叠（严格大于）。与调研 codex 口径一致。
export const LARGE_PASTE_CHAR_THRESHOLD = 1000;

// 三档设置值（settings.aiLongPaste）。默认 collapse。
export const AI_PASTE_MODES = ['off', 'attachment', 'collapse'];
export const DEFAULT_AI_PASTE_MODE = 'collapse';

// 归一化设置值：非法值回落默认。
export function normalizePasteMode(value) {
    return AI_PASTE_MODES.includes(value) ? value : DEFAULT_AI_PASTE_MODE;
}

// 胶囊标记：⟦贴N⟧。全角方括号避免与正文常见方括号冲突；短小以减少排版影响。
const MARKER_RE_SOURCE = '⟦贴(\\d+)⟧';
// 每次返回新正则，避免 lastIndex 状态污染。
export function pasteMarkerRe() {
    return new RegExp(MARKER_RE_SOURCE, 'g');
}
// 严格单个标记（用于校验，非全局）。
export function pasteMarkerOneRe() {
    return new RegExp('^' + MARKER_RE_SOURCE + '$');
}

export function makePasteMarker(id) {
    return '⟦贴' + (Number(id) || 0) + '⟧';
}

// 是否达到折叠阈值。
export function shouldFoldPaste(text) {
    return String(text == null ? '' : text).length > LARGE_PASTE_CHAR_THRESHOLD;
}

// 扫描正文里的所有胶囊标记（按出现顺序，不重叠）。文本是唯一真源。
export function scanPasteMarkers(text) {
    const value = String(text == null ? '' : text);
    const re = pasteMarkerRe();
    const out = [];
    let m;
    while ((m = re.exec(value)) !== null) {
        out.push({id: Number(m[1]), start: m.index, end: m.index + m[0].length, marker: m[0]});
    }
    return out;
}

// 光标位置是否落在某个标记内（含边界：start <= pos <= end）。返回命中项或 null。
export function markerAtCursor(text, pos) {
    const p = Math.max(0, Math.round(Number(pos) || 0));
    return scanPasteMarkers(text).find((r) => r.start <= p && p <= r.end) || null;
}

function escHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// 镜像层 HTML：与 textarea 同字体同度量，胶囊 span 占据的字符与标记文本严格一致（不改排版）。
// store: Map<id, {text, charCount, lineCount}>；只有 store 里存在的 id 才渲染成胶囊，
// 手打的同形文本保持纯文本，避免误伤。
export function buildPasteMirrorHtml(text, store) {
    const value = String(text == null ? '' : text).replace(/\r\n/g, '\n');
    const ranges = scanPasteMarkers(value).filter((r) => !!(store && store.has(r.id)));
    const parts = [];
    let cursor = 0;
    for (const r of ranges) {
        if (r.start < cursor || r.start >= value.length) continue;
        if (r.start > cursor) parts.push(escHtml(value.slice(cursor, r.start)));
        const entry = store.get(r.id);
        const tip = pasteTooltip(r.id, entry);
        parts.push('<span class="ai-paste-pill" data-paste-id="' + r.id + '" data-tip="' + escHtml(tip) + '">' +
            escHtml(value.slice(r.start, r.end)) + '</span>');
        cursor = r.end;
    }
    parts.push(escHtml(value.slice(cursor)));
    let html = parts.join('');
    if (html.endsWith('\n')) html += '\u200b';
    return html;
}

// 展开：把正文里的胶囊标记原位替换成 store 里的全文（可能是用户在虚拟标签页里编辑过的）。
// 只展开 store 里存在的 id；手打同形文本不动。返回 {text, usedIds}。
export function expandPasteMarkers(text, store) {
    const value = String(text == null ? '' : text);
    const usedIds = [];
    const out = value.replace(pasteMarkerRe(), (full, idStr) => {
        const id = Number(idStr);
        if (!store || !store.has(id)) return full;
        const entry = store.get(id);
        usedIds.push(id);
        return String(entry && entry.text != null ? entry.text : '');
    });
    return {text: out, usedIds};
}

// 兼容 \r\n / \r / \n 的行数统计；末尾换行不额外计一行；空串算 1 行。
export function countPasteLines(text) {
    const value = String(text == null ? '' : text);
    if (!value) return 1;
    const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const endsWithNewline = normalized.endsWith('\n');
    const lines = endsWithNewline ? normalized.slice(0, -1) : normalized;
    return lines.split('\n').length;
}

// 构造存入 store 的条目。
export function makePasteEntry(text) {
    const full = String(text == null ? '' : text);
    return {
        text: full,
        charCount: full.length,
        lineCount: countPasteLines(full),
    };
}

// 虚拟标签页标题。
export function pasteFullDocName(id) {
    return '粘贴文本 #' + (Number(id) || 0) + '.txt';
}

// 胶囊 tooltip / 提示文案。
export function pasteTooltip(id, entry) {
    const chars = entry && Number.isFinite(entry.charCount) ? entry.charCount : 0;
    const lines = entry && Number.isFinite(entry.lineCount) ? entry.lineCount : 0;
    return '粘贴 #' + (Number(id) || 0) + ' · ' + chars + ' 字符 / ' + lines + ' 行 · 点击查看并编辑全文';
}
