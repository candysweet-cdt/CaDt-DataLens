// 阅读查找与全书搜索（docs/reading-mode.md §11）：
// 章内查找优先 CSS Custom Highlight API（不改 DOM），WebView2 不支持时回退 <mark>。

export function createReadingSearch(deps) {
    // deps: {
    //   getReader(): Element,                  // 当前正文容器
    //   searchBook(query, opts): Promise<res>, // 后端 SearchReadingBook
    //   cancelSearch(requestID): Promise,
    //   onProgress(scanned, total): void,
    // }
    const supportsHighlight = typeof CSS !== 'undefined' && typeof CSS.highlights !== 'undefined' &&
        typeof Highlight !== 'undefined';

    let ranges = [];
    let current = -1;
    let marks = []; // <mark> 回退用
    let query = '';

    function clear() {
        ranges = [];
        current = -1;
        query = '';
        if (supportsHighlight) {
            CSS.highlights.delete('rd-find');
            CSS.highlights.delete('rd-find-cur');
        }
        for (const m of marks) {
            const parent = m.parentNode;
            if (parent) parent.replaceChild(document.createTextNode(m.textContent), m);
            parent && parent.normalize();
        }
        marks = [];
    }

    function foldNodeText(text) {
        return String(text).toLowerCase();
    }

    // collectRanges 在 reader 内构建命中 Range 列表（不改 DOM）。
    function collectRanges(root, q) {
        const found = [];
        const lq = q.toLowerCase();
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
                const p = node.parentElement;
                if (p && (p.closest('.rd-findbar') || p.tagName === 'SCRIPT' || p.tagName === 'STYLE')) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            },
        });
        const lowerCache = new Map();
        let node;
        while ((node = walker.nextNode())) {
            const text = node.nodeValue;
            const lower = lowerCache.size < 4096 ? foldNodeText(text) : text.toLowerCase();
            let idx = lower.indexOf(lq);
            while (idx >= 0) {
                const r = document.createRange();
                r.setStart(node, idx);
                r.setEnd(node, idx + q.length);
                found.push(r);
                idx = lower.indexOf(lq, idx + Math.max(1, q.length));
            }
        }
        return found;
    }

    // markFallback 用 <mark> 包裹命中（不支持 Highlight API 时）。
    function markFallback(root, q) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(q.toLowerCase())) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            },
        });
        const targets = [];
        let node;
        while ((node = walker.nextNode())) targets.push(node);
        const lq = q.toLowerCase();
        for (const textNode of targets) {
            const text = textNode.nodeValue;
            const lower = text.toLowerCase();
            const frag = document.createDocumentFragment();
            let pos = 0;
            let idx = lower.indexOf(lq);
            while (idx >= 0) {
                if (idx > pos) frag.appendChild(document.createTextNode(text.slice(pos, idx)));
                const mark = document.createElement('mark');
                mark.className = 'rd-mark';
                mark.textContent = text.slice(idx, idx + q.length);
                frag.appendChild(mark);
                marks.push(mark);
                pos = idx + q.length;
                idx = lower.indexOf(lq, pos);
            }
            if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
            textNode.parentNode.replaceChild(frag, textNode);
        }
        ranges = marks.map((m) => {
            const r = document.createRange();
            r.selectNodeContents(m);
            return r;
        });
    }

    // find(query) → 命中数
    function find(q) {
        clear();
        query = q;
        if (!q) return 0;
        const reader = deps.getReader();
        if (!reader) return 0;
        if (supportsHighlight) {
            ranges = collectRanges(reader, q);
            if (ranges.length) {
                CSS.highlights.set('rd-find', new Highlight(...ranges));
            }
        } else {
            markFallback(reader, q);
        }
        if (ranges.length) {
            current = 0;
            showCurrent();
        }
        return ranges.length;
    }

    function showCurrent() {
        if (current < 0 || current >= ranges.length) return;
        const r = ranges[current];
        if (supportsHighlight) {
            CSS.highlights.set('rd-find-cur', new Highlight(r));
        } else {
            marks.forEach((m, i) => m.classList.toggle('rd-mark-cur', i === current));
        }
        const el = r.startContainer.parentElement;
        if (el && el.scrollIntoView) {
            el.scrollIntoView({block: 'center'});
        }
    }

    function next() {
        if (!ranges.length) return 0;
        current = (current + 1) % ranges.length;
        showCurrent();
        return current;
    }

    function prev() {
        if (!ranges.length) return 0;
        current = (current - 1 + ranges.length) % ranges.length;
        showCurrent();
        return current;
    }

    // ---- 全书搜索 ----

    let searchSeq = 0;

    async function searchBook(root, q, opts) {
        const requestID = 'rd-search-' + Date.now() + '-' + (++searchSeq);
        const res = await deps.searchBook(requestID, root, q, opts || {});
        return res;
    }

    return {find, next, prev, clear, searchBook, get count() { return ranges.length; }, get index() { return current; }, get query() { return query; }, supportsHighlight};
}
