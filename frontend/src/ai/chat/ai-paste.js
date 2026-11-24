// ai-paste.js：AI 输入框长文本粘贴的纯函数单一来源（零 I/O、便于单测）。
// 三档模式（off / attachment / collapse）与折叠胶囊的标记、扫描、镜像 HTML、展开。
// 胶囊机制沿用群聊 @ 提及的「文本是唯一真源、镜像层画胶囊」方案（ai-group-ui-model.js）：
// 正文里胶囊 = 一段占位文本【📎 摘要 · 时间 #N】，镜像层按 range 渲染成彩色 span，占据字符与原文严格等宽。
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

// 胶囊图标：Unicode 几何符号 ▣（U+25A3，文本呈现、非 emoji）。
// 用文本符号而非 SVG/emoji：textarea 与镜像层逐字符等宽覆盖，SVG 图标不占文本宽度会错位，
// emoji 则可能触发字体回退导致两边宽度不一致。几何符号在同一字体里宽度稳定。
export const PASTE_MARKER_ICON = '▣';

// 胶囊标记：【▣ 摘要 · HH:mm #N】。占位文本本身就是「文本摘要 + 时间」——
// 镜像层 span 逐字符显示它，与 textarea 里的占位严格等宽（群聊 @ 胶囊同款：文本是唯一真源）。
// 摘要在生成时去掉所有换行符并截断，故占位永远是单行，不会破坏 textarea 行数。
// 结尾 #N 是序号（区分多个胶囊、回查 store），正则靠它 + 时间锚定，摘要里已剔除冲突字符。
const MARKER_RE_SOURCE = '【' + PASTE_MARKER_ICON + ' ([^】]*?) · (\\d{1,2}:\\d{2}) #(\\d+)】';
// 每次返回新正则，避免 lastIndex 状态污染。
export function pasteMarkerRe() {
    return new RegExp(MARKER_RE_SOURCE, 'g');
}
// 严格单个标记（用于校验，非全局）。
export function pasteMarkerOneRe() {
    return new RegExp('^' + MARKER_RE_SOURCE + '$');
}

// 粘贴时刻的时间戳（HH:mm）。传入 Date 便于单测，缺省取当前时刻。
export function formatPasteTime(date) {
    const d = date instanceof Date ? date : new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// 摘要默认最大字符数（纯文本胶囊保持紧凑，不撑宽输入框）。
export const PASTE_SUMMARY_MAX_LEN = 12;

// 摘要：取首个非空行，去掉所有换行/制表符与会冲突的标记字符，截断到 maxLen 字符。
// 关键：结果恒为单行——换行符一旦进入占位文本就会改变 textarea 行数、令镜像层错位。
export function pasteSummary(text, maxLen) {
    const full = String(text == null ? '' : text);
    const firstLine = full.split(/\r\n|\r|\n/).map((s) => s.trim()).find(Boolean) || '';
    const cleaned = firstLine.replace(/[【】·#\t]/g, ' ').replace(/\s+/g, ' ').trim();
    const len = Math.max(4, Math.min(40, Number(maxLen) || PASTE_SUMMARY_MAX_LEN));
    const clipped = cleaned.length > len ? cleaned.slice(0, len) + '…' : cleaned;
    return clipped || '长文本';
}

export function makePasteMarker(id, summary, time) {
    return '【' + PASTE_MARKER_ICON + ' ' + pasteSummary(summary) + ' · ' + (time || '00:00') + ' #' + (Number(id) || 0) + '】';
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
        // 捕获组：1=摘要 2=时间 3=序号。
        out.push({id: Number(m[3]), start: m.index, end: m.index + m[0].length, marker: m[0]});
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
    const out = value.replace(pasteMarkerRe(), (full, summary, time, idStr) => {
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
