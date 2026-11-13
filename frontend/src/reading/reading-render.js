// 阅读渲染层（docs/finished-plans/reading-mode.md §10）：
// md 复用共享 markdown.js 与同一套 DOMPurify 规则；txt 转义直渲；
// docx 块 → HTML；epub 经 DOMParser 清洗后套用阅读排版。LRU 缓存。

import DOMPurify from 'dompurify';
import {createMarkdownRenderer} from '../markdown.js';
import {joinSoftLines, stripFrontMatter, unitIdOf} from './reading-model.js';

const CACHE_MAX_BYTES = 8 << 20;
const CACHE_MAX_UNITS = 12;

export function createReadingRender(deps) {
    // deps: {
    //   getSetting(key),                // 阅读设置
    //   resolveImage(rel, src): string, // 相对图片 → /__local/<token>/...；书根外返回 ''
    // }
    const getSetting = (k, dflt) => (deps && deps.getSetting ? deps.getSetting(k, dflt) : dflt);
    const resolveImage = (rel, src) => (deps && deps.resolveImage ? deps.resolveImage(rel, src) : '');

    const shared = createMarkdownRenderer({mdLineNumbers: () => false, mermaidPlaceholder: null});
    const {renderMarkdownHtml} = shared;

    // ---- LRU 缓存 ----
    const cache = new Map(); // unitId -> {html, headings, bytes, mtime}
    let cacheBytes = 0;

    function cacheGet(id, mtime) {
        const hit = cache.get(id);
        if (!hit) return null;
        if (mtime && hit.mtime && hit.mtime !== mtime) {
            cache.delete(id);
            cacheBytes -= hit.bytes;
            return null;
        }
        // 触碰移到尾部（最新）
        cache.delete(id);
        cache.set(id, hit);
        return hit;
    }

    function cachePut(id, value) {
        if (cache.has(id)) {
            const old = cache.get(id);
            cacheBytes -= old.bytes;
            cache.delete(id);
        }
        cache.set(id, value);
        cacheBytes += value.bytes;
        while ((cacheBytes > CACHE_MAX_BYTES || cache.size > CACHE_MAX_UNITS) && cache.size > 1) {
            const firstKey = cache.keys().next().value;
            const first = cache.get(firstKey);
            cacheBytes -= first.bytes;
            cache.delete(firstKey);
        }
    }

    function cacheInvalidateRel(rel) {
        for (const [id, v] of cache) {
            if (id.startsWith(rel + '#')) {
                cacheBytes -= v.bytes;
                cache.delete(id);
            }
        }
    }

    // ---- HTML 后处理：锚点 + 图片 ----

    function postProcess(container, rel) {
        let idx = 0;
        for (const h of container.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
            if (!h.textContent.trim()) continue;
            h.id = 'rh-' + idx;
            h.dataset.rh = String(idx);
            idx++;
        }
        for (const img of container.querySelectorAll('img')) {
            const raw = img.getAttribute('data-ai-src') || img.getAttribute('src') || '';
            const resolved = raw ? resolveImage(rel, raw) : '';
            if (resolved) {
                img.src = resolved;
                img.loading = 'lazy';
            } else if (raw && !/^(https?:|data:|blob:|\/__local\/)/i.test(raw)) {
                // 书根外图片：alt 占位
                const ph = document.createElement('span');
                ph.className = 'rd-img-placeholder';
                ph.textContent = '〔图片：' + (img.getAttribute('alt') || '不可解析') + '〕';
                img.replaceWith(ph);
            }
        }
        for (const table of container.querySelectorAll('table')) {
            if (table.parentElement && table.parentElement.classList.contains('rd-table-wrap')) continue;
            const wrap = document.createElement('div');
            wrap.className = 'rd-table-wrap';
            table.replaceWith(wrap);
            wrap.appendChild(table);
        }
        for (const a of container.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href') || '';
            if (/^https?:/i.test(href)) {
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.classList.add('rd-ext-link');
            }
        }
    }

    // ---- Markdown ----

    function renderMarkdownUnit(text, rel) {
        let html = renderMarkdownHtml(text);
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        postProcess(tpl.content, rel);
        return tpl.innerHTML;
    }

    function prepareMarkdownText(content, unit, opts) {
        let text = content;
        if (unit.offset <= 1 && !Number.isFinite(unit.endOffset)) {
            const stripped = stripFrontMatter(content);
            text = stripped.text;
        } else {
            const lines = String(content).replace(/\r\n/g, '\n').split('\n');
            const start = Math.max(0, unit.offset - 1);
            const end = Number.isFinite(unit.endOffset) ? unit.endOffset - 1 : lines.length;
            text = lines.slice(start, end).join('\n');
        }
        if (opts.joinSoftLines) text = joinSoftLines(text);
        return text;
    }

    // ---- TXT ----

    function escapeHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function renderTxtUnit(content, unit, headings) {
        const lines = String(content).replace(/\r\n/g, '\n').split('\n');
        const start = Math.max(0, unit.offset - 1);
        const end = Number.isFinite(unit.endOffset) ? unit.endOffset - 1 : lines.length;
        const seg = lines.slice(start, end);
        const headingOffsets = new Map((headings || []).map((h) => [h.offset, h]));
        const keepBreaks = getSetting('readingKeepTxtBreaks', false);
        if (getSetting('readingJoinSoftLines', true)) {
            // 标题行保持独立后再合并正文
            const merged = [];
            let buf = [];
            for (let i = 0; i < seg.length; i++) {
                const lineNo = start + i + 1;
                const h = headingOffsets.get(lineNo);
                if (h) {
                    if (buf.length) merged.push(joinSoftLines(buf.join('\n')));
                    buf = [];
                    merged.push({heading: h});
                } else {
                    buf.push(seg[i]);
                }
            }
            if (buf.length) merged.push(joinSoftLines(buf.join('\n')));
            const parts = [];
            for (const m of merged) {
                if (m && m.heading) {
                    parts.push('<h2 class="rd-txt-title">' + escapeHtml(m.heading.title) + '</h2>');
                } else {
                    parts.push(txtParagraphs(typeof m === 'string' ? m : '', keepBreaks));
                }
            }
            return parts.join('\n');
        }
        // 标题行独立成 h2，其余按空行分段
        const parts = [];
        let para = [];
        const flushPara = () => {
            if (para.length) {
                parts.push(txtParagraphs(para.join(keepBreaks ? '\n' : ''), keepBreaks));
                para = [];
            }
        };
        for (let i = 0; i < seg.length; i++) {
            const h = headingOffsets.get(start + i + 1);
            if (h) {
                flushPara();
                parts.push('<h2 class="rd-txt-title">' + escapeHtml(h.title) + '</h2>');
                continue;
            }
            if (seg[i].trim() === '') {
                flushPara();
            } else {
                para.push(seg[i]);
            }
        }
        flushPara();
        return parts.join('\n');
    }

    function txtParagraphs(text, keepBreaks) {
        const blocks = String(text).split(/\n{2,}/);
        return blocks.map((b) => {
            if (!b.trim()) return '';
            const body = escapeHtml(b).replace(/\n/g, keepBreaks ? '<br>' : ' ');
            return '<p>' + body + '</p>';
        }).join('\n');
    }

    // ---- DOCX ----

    function renderDocxBlocks(blocks, unit) {
        const start = Math.max(0, unit.offset - 1);
        const end = Number.isFinite(unit.endOffset) ? unit.endOffset - 1 : blocks.length;
        const seg = blocks.slice(start, end);
        const out = [];
        for (const b of seg) {
            if (b.kind === 'table') {
                const rows = (b.rows || []).map((row) => '<tr>' +
                    (row.cells || []).map((c) => '<td>' + escapeHtml(c).replace(/\n/g, '<br>') + '</td>').join('') +
                    '</tr>').join('');
                out.push('<div class="rd-table-wrap"><table>' + rows + '</table></div>');
            } else if (b.kind === 'image') {
                out.push('<p class="rd-img-placeholder">' + escapeHtml(b.text || '〔图片〕') + '</p>');
            } else if (/^h[1-6]$/.test(b.kind)) {
                out.push('<' + b.kind + '>' + escapeHtml(b.text || '') + '</' + b.kind + '>');
            } else {
                out.push('<p>' + escapeHtml(b.text || '').replace(/\n/g, '<br>') + '</p>');
            }
        }
        const html = out.join('\n');
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        postProcess(tpl.content, unit.rel);
        return tpl.innerHTML;
    }

    // ---- EPUB ----

    const EPUB_DROP = 'script,style,iframe,object,embed,link,meta';
    const EPUB_EVENT_ATTR = /^on/i;

    function renderEpubHtml(rawHtml, unit) {
        let doc;
        try {
            doc = new DOMParser().parseFromString(String(rawHtml || ''), 'text/html');
        } catch (e) {
            return '<p class="rd-img-placeholder">章节解析失败</p>';
        }
        for (const el of doc.querySelectorAll(EPUB_DROP)) el.remove();
        for (const el of Array.from(doc.querySelectorAll('*'))) {
            for (const attr of Array.from(el.attributes)) {
                if (EPUB_EVENT_ATTR.test(attr.name)) el.removeAttribute(attr.name);
                else if ((attr.name === 'href' || attr.name === 'src') && /^\s*javascript:/i.test(attr.value)) {
                    el.removeAttribute(attr.name);
                }
            }
        }
        const inner = doc.body ? doc.body.innerHTML : String(rawHtml || '');
        const html = DOMPurify.sanitize(inner, {
            USE_PROFILES: {html: true, svg: true},
            FORBID_TAGS: ['style', 'script'],
            ADD_ATTR: ['data-epub-href'],
        });
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        postProcess(tpl.content, unit.rel);
        // EPUB 内部锚链接标记（控制器处理跳转）
        for (const a of tpl.content.querySelectorAll('a[href^="#"]')) {
            a.dataset.epubAnchor = (a.getAttribute('href') || '').slice(1);
        }
        return tpl.innerHTML;
    }

    // ---- 统一入口 ----

    // renderUnit(unit, payload) → {html}
    // payload: {kind: 'md'|'txt'|'docx'|'epub', content, headings, blocks, mtime}
    async function renderUnit(unit, payload) {
        const id = unit.id || unitIdOf(unit.rel, unit.offset, payload.kind === 'docx' || payload.kind === 'epub');
        const cached = cacheGet(id, payload.mtime);
        if (cached) return {html: cached.html, headings: cached.headings, cached: true};
        let html = '';
        const kind = payload.kind;
        if (kind === 'md') {
            let text;
            if (payload.rawSlice) {
                // 大章分块：内容已切好，不再按单元区间二次切片
                text = getSetting('readingJoinSoftLines', true) ? joinSoftLines(payload.content) : payload.content;
            } else {
                text = prepareMarkdownText(payload.content, unit, {
                    joinSoftLines: getSetting('readingJoinSoftLines', true),
                });
            }
            html = renderMarkdownUnit(text, unit.rel);
        } else if (kind === 'txt') {
            html = renderTxtUnit(payload.content, unit, payload.headings);
        } else if (kind === 'docx') {
            html = renderDocxBlocks(payload.blocks, unit);
        } else if (kind === 'epub') {
            html = renderEpubHtml(payload.content, unit);
        } else {
            html = '<p>' + escapeHtml(String(payload.content || '')) + '</p>';
        }
        const entry = {html, headings: payload.headings || [], bytes: html.length * 2, mtime: payload.mtime || 0};
        cachePut(id, entry);
        return {html, headings: entry.headings, cached: false};
    }

    return {
        renderUnit,
        cacheInvalidateRel,
        cacheClear() {
            cache.clear();
            cacheBytes = 0;
        },
    };
}
