// ai-paste.js：AI 输入框长文本粘贴的纯函数单一来源（零 I/O、便于单测）。
// 三档模式（off / attachment / collapse）与折叠胶囊的标记、扫描、镜像 HTML、展开。
// 胶囊机制沿用群聊 @ 提及的「文本是唯一真源、镜像层画胶囊」方案（ai-group-ui-model.js）：
// 正文里胶囊 = 一段占位文本【📎 摘要 · 时间 #N】，镜像层按 range 渲染成彩色 span，占据字符与原文严格等宽。
// 另有粘贴分派（decidePasteAction）：粘贴文本超过单条消息上限时无论哪一档都转附件——
// 折叠只改输入区显示，发送时按原文展开，超过 10 万字符必被内核以 too_long 拒发。
// 配套测试：test/ai/chat/ai-paste.test.mjs。

import {AI_CHAT_INPUT_LIMIT} from '../core/ai-constants.js';

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

// 结构化内容的友好标签：粘贴 SVG / HTML / JSON 时首行常是 <svg t="…"> 之类的标记，
// 直接截断当摘要会显示一堆尖括号（用户 2026-11-27 反馈胶囊里出现「<svg t="1795…」很难看）。
// 命中这些前缀就用短标签代替，既不撑宽胶囊也不暴露原始标记。
export function friendlyPasteLabel(firstLine) {
    const s = String(firstLine == null ? '' : firstLine).trim();
    // SVG 可能在首行带 XML 声明，先判 SVG 内容再判 XML（否则 <?xml 抢先命中）。
    if (/^<svg[\s>]/i.test(s) || /^<\?xml[^>]*\?>\s*<svg[\s>]/i.test(s)) return 'SVG 图片';
    if (/^<\?xml/i.test(s)) return 'XML 文档';
    if (/^<!doctype\s+html/i.test(s) || /^<html[\s>]/i.test(s)) return 'HTML 页面';
    if (/^<[a-z][a-z0-9-]*[\s/>]/i.test(s)) return 'HTML 内容';
    // JSON 分支要闭合校验：以 { 或 [ 开头且以 } 或 ] 收尾，避免把 Markdown 链接 [标题](url)、
    // 任务列表 [x] ... 误标成 JSON（审查 m2）。
    if (/^[{[]/.test(s) && /[}\]]\s*$/.test(s)) return 'JSON 数据';
    return '';
}

// 摘要：取首个非空行，去掉所有换行/制表符与会冲突的标记字符，截断到 maxLen 字符。
// 关键：结果恒为单行——换行符一旦进入占位文本就会改变 textarea 行数、令镜像层错位。
// 结构化内容（SVG/HTML/JSON）优先用友好标签，避免原始标记挤进胶囊（见 friendlyPasteLabel）。
export function pasteSummary(text, maxLen) {
    const full = String(text == null ? '' : text);
    const firstLine = full.split(/\r\n|\r|\n/).map((s) => s.trim()).find(Boolean) || '';
    const label = friendlyPasteLabel(firstLine);
    if (label) return label;
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

// 单条消息正文上限：超过它 startSessionTurn 会以 too_long 直接拒发（AI_CHAT_INPUT_LIMIT 同值）。
export const PASTE_INLINE_MAX_CHARS = AI_CHAT_INPUT_LIMIT;

// 文本附件单件上限（与 ai-composer 的 addAttachment 同一口径：超出会被截断丢内容）。
// 粘贴文本超过它就改为落盘 + 路径引用，让模型用 read_file 自己读，不静默截断。
export const PASTE_ATTACH_MAX_CHARS = 64 << 10;

// 粘贴分派（纯函数）：'inline' 原样插入 / 'marker' 折叠胶囊 / 'attach' 文本附件 / 'file' 落盘附件。
// 关键规则：粘贴文本一旦超过正文上限，折叠也没用（发送时按原文展开，必被 too_long 拒），
// 所以不管用户设了哪一档都转附件——这正是「粘贴过大导致消息发不出去」的根因。
export function decidePasteAction(text, opts) {
    const value = String(text == null ? '' : text);
    if (!shouldFoldPaste(value)) return 'inline';
    const mode = normalizePasteMode(opts && opts.mode);
    const inlineMax = Number(opts && opts.inlineMax) > 0 ? Number(opts.inlineMax) : PASTE_INLINE_MAX_CHARS;
    const attachMax = Number(opts && opts.attachMax) > 0 ? Number(opts.attachMax) : PASTE_ATTACH_MAX_CHARS;
    if (value.length > inlineMax) return 'file';
    if (mode === 'off') return 'inline';
    if (mode === 'attachment') return value.length > attachMax ? 'file' : 'attach';
    return 'marker';
}

// 落盘附件的说明文本（附件 content 只放这一段，正文在文件里，模型按提示 read_file 读）。
export function pasteFileAttachmentText(path, chars, lines) {
    return '（粘贴的文本已存盘，未直接注入正文：' + (Number(chars) || 0) + ' 字符 / ' + (Number(lines) || 0) + ' 行。\n' +
        '路径：' + String(path || '') + '\n' +
        '处理建议：用 read_file 读取该文件，内容很大时分段读（startLine/endLine）。）';
}

// 发送兜底时的正文占位：正文整段转附件后，留在输入区/消息里的那一句。
export function pasteOverflowPlaceholder(chars) {
    return '（正文 ' + (Number(chars) || 0) + ' 字符超过单条消息上限，已整段转为附件发送）';
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
        // 右侧 × 快捷删除：绝对定位的小按钮，不占文本宽度（否则镜像与 textarea 错位、原生字透出来）。
        parts.push('<span class="ai-paste-pill" data-paste-id="' + r.id + '" data-tip="' + escHtml(tip) + '">' +
            escHtml(value.slice(r.start, r.end)) +
            '<span class="ai-paste-pill-close" data-paste-close="' + r.id + '" aria-hidden="true">×</span></span>');
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
