// 阅读模式控制器（docs/finished-plans/reading-mode.md）：
// 打开/关闭、扫描→模型→章流、渲染管线、导航、进度记忆、书签、统计、
// 章内/全书查找、朗读、专注模式、快捷键。只读：不调用任何写接口。

import {
    buildBookModel, flattenChapters, locateUnit, computeProgress,
    normalizeBookKey, flattenTreePreorder,
} from './reading-model.js';
import {createContextMenu} from '../contextmenu.js';
import {createReadingState} from './reading-state.js';
import {createReadingRender} from './reading-render.js';
import {createReadingSearch} from './reading-search.js';
import {createReadingTts} from './reading-tts.js';
import {
    buildSkeleton, renderBookshelf, renderDetail, renderToc, scrollTocToActive,
    renderBookmarks, renderSearchResults, renderSettingsPopover, renderStats,
    fontFamilyFor,
} from './reading-view.js';

const READING_SETTINGS_DEFAULTS = {
    readingFont: 'songti',
    readingFontSize: 19,
    readingLineHeight: 1.9,
    readingPageWidth: 42,
    readingParagraphGap: 0.6,
    readingIndent: false,
    readingTheme: 'auto',
    readingJoinSoftLines: true,
    readingContinuous: false,
    readingPaged: false,
    readingTocDepth: 2,
    readingTtsRate: 1,
    readingTtsAutoNext: true,
};

function app() {
    return (typeof window !== 'undefined' && window.go && window.go.main && window.go.main.App) || null;
}

export function createReadingMode(deps) {
    // deps: {
    //   container: HTMLElement,
    //   getSetting(key, dflt), setSetting(key, value),
    //   getWorkspace(): string,
    //   isDarkTheme(): boolean,
    //   isDialogOpen(): boolean,
    //   openInEditor(path, line): void,
    //   showFlash(msg): void,
    //   chooseDirectory(): Promise<string>,   // 「打开其他文件夹」
    //   showInFolder(path): Promise,
    // }
    const container = deps.container;
    // main.js 注入的 backend（真实 Wails 绑定或浏览器 mock 都走同一个入口）
    const app = () => {
        if (typeof deps.getBackend === 'function') return deps.getBackend();
        return (typeof window !== 'undefined' && window.go && window.go.main && window.go.main.App) || null;
    };
    const els = buildSkeleton(container);
    // 顶栏标题：书名 + 当前章（书架/详情页用页面名）
    function setTitles(bookName, unitName) {
        els.bookTitle.textContent = bookName || '';
        els.unitTitle.textContent = unitName || '';
    }
    const stateStore = createReadingState(typeof localStorage !== 'undefined' ? localStorage : undefined);
    const render = createReadingRender({
        getSetting: (k, d) => deps.getSetting(k, d),
        resolveImage: (rel, src) => resolveReadingImage(rel, src),
    });
    const search = createReadingSearch({
        getReader: () => els.reader,
        searchBook: (requestID, root, q, opts) => app().SearchReadingBook(requestID, root, q, opts),
        cancelSearch: (requestID) => app().CancelReadingSearch(requestID),
    });
    const tts = createReadingTts({
        getReader: () => els.reader,
        getRate: () => Number(deps.getSetting('readingTtsRate', 1)) || 1,
        getPitch: () => 1,
        getVolume: () => 1,
        autoNext: () => deps.getSetting('readingTtsAutoNext', true),
        onFinishUnit: async () => {
            if (book && currentIndex < book.chapters.length - 1) {
                await renderChapter(currentIndex + 1, {});
                tts.speakUnit();
            }
        },
        onStateChange: (playing) => {
            els.btnTts.textContent = playing ? '停止' : '朗读';
        },
    });

    let active = false;
    let book = null;          // {key, root, scan, model, chapters, isEpub, epubBook, token}
    let currentIndex = 0;
    let currentRatio = 0;
    let currentUnit = null;
    let sidebarTab = 'toc';
    let focusMode = false;
    let treeMode = false;
    let fileCache = new Map(); // rel → {kind, content, blocks, headings, mtime, text}
    let savedBeforeRestore = null;
    let statsAccum = 0;
    let lastInteraction = Date.now();
    let detailVisible = false;
    let searchBusy = false;
    let popover = null;
    let tocCap = 300;
    let streamState = null;   // 连续滚动状态（§12.1）
    let pageState = null;     // 分页状态（§12.2）
    let lastScanAt = 0;
    let rescanBusy = false;
    let pendingAnchor = '';   // EPUB 跨章锚点待跳转
    const rdCtx = createContextMenu();
    const isStream = () => !!deps.getSetting('readingContinuous', false) &&
        !deps.getSetting('readingPaged', false) && !treeMode;
    const isPaged = () => !!deps.getSetting('readingPaged', false) && !treeMode;

    // ---- 图片 token ----
    let imageToken = '';
    async function ensureImageToken(root) {
        if (!app()) return;
        try {
            imageToken = await app().RegisterPreviewRoot(root) || '';
        } catch (e) {
            imageToken = '';
        }
    }
    function resolveReadingImage(rel, src) {
        if (!imageToken || !src) return '';
        if (/^(https?:|data:|blob:)/i.test(src)) return '';
        // 相对路径按当前文件目录解析到书根内
        let p = src.replace(/\\/g, '/').split('?')[0].split('#')[0];
        if (/^[A-Za-z]:/.test(p) || p.startsWith('/')) {
            // 绝对路径：仅当位于书根内时可用（后端校验）
            const rootSlash = book && book.root ? String(book.root).replace(/\\/g, '/') : '';
            if (rootSlash && p.toLowerCase().startsWith(rootSlash.toLowerCase())) {
                p = p.slice(rootSlash.length);
            } else {
                return '';
            }
        }
        const baseParts = rel.split('/').slice(0, -1);
        const parts = [];
        for (const seg of (p.startsWith('./') ? p.slice(2) : p).split('/')) {
            if (seg === '' || seg === '.') continue;
            if (seg === '..') {
                baseParts.pop();
                continue;
            }
            parts.push(seg);
        }
        const full = baseParts.concat(parts).map((s) => encodeURIComponent(s)).join('/');
        return '/__local/' + imageToken + '/' + full;
    }

    // ---- 激活/退出 ----

    function isActive() {
        return active;
    }

    async function show() {
        if (active) return;
        active = true;
        container.classList.remove('hidden');
        deps.onActiveChanged && deps.onActiveChanged(true);
        window.addEventListener('keydown', onCaptureKey, true);
        document.addEventListener('visibilitychange', onVisibility);
        startStatsTimer();
        const last = stateStore.recent()[0];
        if (last && deps.getSetting('readingRestoreSession', true)) {
            const rec = stateStore.getBook(last);
            if (rec && rec.root) {
                try {
                    await openBook(rec.root, {skipRecent: true});
                    return;
                } catch (e) { /* 上次的书不见了 → 书架 */ }
            }
        }
        showBookshelf();
    }

    function close() {
        if (!active) return;
        stopTts();
        saveProgress(true);
        stateStore.flush();
        active = false;
        container.classList.add('hidden');
        deps.onActiveChanged && deps.onActiveChanged(false);
        window.removeEventListener('keydown', onCaptureKey, true);
        document.removeEventListener('visibilitychange', onVisibility);
        clearInterval(statsTimer);
        statsTimer = 0;
        search.clear();
    }

    // ---- 书架/详情 ----

    async function showBookshelf() {
        detailVisible = true;
        currentUnit = null;
        book = null;
        setTitles('阅读模式', '书架');
        els.reader.textContent = '';
        els.reader.className = 'rd-reader rd-shelf-host';
        let suggestions = [];
        try {
            suggestions = await app().SuggestReadingBooks(deps.getWorkspace(), 12) || [];
        } catch (e) { /* 后端不可用时显示空书架 */ }
        const recent = stateStore.recent().map((key) => stateStore.getBook(key)).filter(Boolean).map((b) => ({
            key: normalizeBookKey(b.root),
            root: b.root,
            title: b.title,
            progress: b.progress,
            updatedAt: b.updatedAt,
        }));
        renderBookshelf(els.reader, {
            recent,
            suggestions,
            onOpen: (entry) => openBook(entry.root || entry.key),
            onBrowse: async () => {
                const dir = await deps.chooseDirectory();
                if (dir) openBook(dir);
            },
        });
        els.bottombar.style.display = 'none';
    }

    function showDetailPage() {
        detailVisible = true;
        const m = book.model;
        const saved = stateStore.getBook(book.key);
        setTitles(book.model.title, '书籍详情');
        els.reader.textContent = '';
        els.reader.className = 'rd-reader rd-shelf-host';
        renderDetail(els.reader, {
            title: m.title,
            author: m.author,
            intro: m.intro,
            totalWords: m.totalWords,
            chapterCount: m.chapters.length,
            progress: saved ? saved.progress : 0,
            chapterLevel: saved && saved.chapterLevel,
            treeMode: treeMode,
            ignoreDirs: (saved && saved.ignoreDirs) || [],
            onContinue: () => continueReading(saved),
            onRestart: () => {
                stateStore.updateBook(book.key, {progress: 0, lastUnitId: '', lastRel: '', lastUnitTitle: ''});
                continueReading(null);
            },
            onShowInFolder: () => deps.showInFolder(book.root),
            onChapterLevel: (lv) => {
                stateStore.updateBook(book.key, {chapterLevel: lv});
                rebuildModel(lv);
            },
            onTreeMode: (on) => {
                treeMode = on;
                stateStore.updateBook(book.key, {treeMode: on});
            },
            onIgnoreDirs: async (list) => {
                const keepId = currentUnit ? currentUnit.id : (saved ? saved.lastUnitId : '');
                stateStore.updateBook(book.key, {ignoreDirs: list});
                await openBook(book.root, {skipRecent: true});
                const idx = book.chapters.findIndex((c) => c.id === keepId);
                deps.showFlash(list.length ? '已按忽略目录重扫：' + list.join('、') : '已清除忽略目录并重扫');
                if (idx >= 0) {
                    currentIndex = idx;
                    currentUnit = book.chapters[idx];
                }
            },
            onClearProgress: () => {
                stateStore.forgetBook(book.key);
                stateStore.touchRecent(book.key);
                deps.showFlash('已清空本书进度');
                showDetailPage();
            },
        });
        els.bottombar.style.display = 'none';
    }

    function rebuildModel(chapterLevel) {
        const saved = stateStore.getBook(book.key) || {};
        book.model = buildBookModel(book.scan, {chapterLevel: chapterLevel !== undefined ? chapterLevel : saved.chapterLevel});
        book.chapters = flattenChapters(book.model);
        book.treeNodes = flattenTreePreorder(book.model.top);
        showDetailPage();
    }

    async function continueReading(saved) {
        detailVisible = false;
        els.bottombar.style.display = '';
        els.reader.className = 'rd-reader';
        const located = locateUnit(book.chapters, saved, book.model);
        if (saved && saved.treeMode) treeMode = true;
        if (saved && saved.matchedHint) { /* reserved */ }
        if (saved && located.matched !== 'id' && located.matched !== 'first' && deps.showFlash) {
            deps.showFlash('原位置已变化，已跳到最近章节');
        }
        await renderChapter(located.index, {ratio: saved ? saved.scrollRatio : 0});
    }

    // ---- 打开书 ----

    async function openBook(root, opts) {
        opts = opts || {};
        const backend = app();
        if (!backend) return;
        let scan;
        const isEpubFile = /\.epub$/i.test(String(root).trim());
        if (isEpubFile) {
            const epubBook = await backend.PrepareReadingEpub(root);
            // Go 结构体经 Wails 走 encoding/json，字段是 json tag 的小写名
            scan = {
                root: epubBook.path,
                title: epubBook.title,
                author: epubBook.author,
                profile: 'file',
                confidence: 1,
                warnings: [],
                files: [{
                    rel: root.replace(/\\/g, '/').split('/').pop(),
                    name: String(root).split('\\').pop().split('/').pop(),
                    ext: '.epub',
                    words: (epubBook.chapters || []).reduce((s, c) => s + (c.words || 0), 0),
                    headings: (epubBook.chapters || []).map((c) => ({offset: c.index + 1, level: 1, title: c.title, words: c.words || 0})),
                }],
            };
            book = {key: normalizeBookKey(epubBook.path), root: epubBook.path, scan, isEpub: true, epubBook};
        } else {
            const savedOpts = stateStore.getBook(normalizeBookKey(root)) || {};
            scan = await backend.ScanReadingRoot(root, {IgnoreDirs: savedOpts.ignoreDirs || []});
            book = {key: normalizeBookKey(scan.root), root: scan.root, scan, isEpub: false};
        }
        lastScanAt = Date.now();
        const saved = stateStore.getBook(book.key) || {};
        book.model = buildBookModel(scan, {chapterLevel: saved.chapterLevel});
        book.chapters = flattenChapters(book.model);
        book.treeNodes = flattenTreePreorder(book.model.top);
        treeMode = !!saved.treeMode;
        fileCache = new Map();
        render.cacheClear();
        if (!opts.skipRecent) {
            stateStore.updateBook(book.key, {
                root: book.root,
                title: book.model.title,
                profile: book.model.profile,
                chapterLevel: saved.chapterLevel === undefined ? null : saved.chapterLevel,
            });
            stateStore.touchRecent(book.key);
            stateStore.startSession(book.key);
        }
        await ensureImageToken(book.root);
        setTitles(book.model.title, '');
        els.bookTitle.textContent = book.model.title;
        if (detailVisible || !opts.directRead) {
            showDetailPage();
        }
    }

    // 阅读此文件（资源管理器右键单文件入口）
    async function openSingleFile(path) {
        // 必须先清详情态：从书架过来时 detailVisible 仍是 true，openBook 会误走详情页
        detailVisible = false;
        await openBook(path, {directRead: true});
        els.bottombar.style.display = '';
        els.reader.className = 'rd-reader';
        await renderChapter(0, {});
    }

    // ---- 渲染管线 ----

    function extOf(rel) {
        const m = /\.([a-z0-9]+)$/i.exec(rel || '');
        return m ? m[1].toLowerCase() : '';
    }

    async function ensureFile(rel) {
        const hit = fileCache.get(rel);
        if (hit) return hit;
        const backend = app();
        const ext = extOf(rel);
        let entry;
        if (book.isEpub) {
            entry = {kind: 'epub', rel};
        } else if (ext === 'docx') {
            const doc = await backend.ParseReadingDocx(book.root + '/' + rel);
            entry = {kind: 'docx', rel, blocks: doc.blocks, mtime: 0};
        } else if (ext === 'epub') {
            // 目录内的 epub：按需准备
            const epubBook = await backend.PrepareReadingEpub(book.root + '/' + rel);
            entry = {kind: 'epub-inner', rel, epubBook};
        } else {
            const fd = await backend.OpenFile(book.root + '/' + rel, '');
            entry = {
                kind: ext === 'txt' ? 'txt' : 'md',
                rel,
                content: fd.content,
                headings: scanHeadingsOf(rel),
                mtime: fd.size || 0,
            };
        }
        fileCache.set(rel, entry);
        while (fileCache.size > 3) {
            const firstKey = fileCache.keys().next().value;
            fileCache.delete(firstKey);
        }
        return entry;
    }

    function scanHeadingsOf(rel) {
        const f = (book.scan.files || []).find((x) => x.rel === rel);
        return f ? f.headings || [] : [];
    }

    async function ensureUnitPayload(unit) {
        const entry = await ensureFile(unit.rel);
        if (entry.kind === 'epub' && book.isEpub) {
            const ch = await app().ReadReadingEpubChapter(book.epubBook.id, unit.offset - 1);
            return {kind: 'epub', content: ch.html, headings: [], mtime: 0};
        }
        if (entry.kind === 'epub-inner') {
            const ch = await app().ReadReadingEpubChapter(entry.epubBook.id, unit.offset - 1);
            return {kind: 'epub', content: ch.html, headings: [], mtime: 0};
        }
        if (entry.kind === 'docx') {
            return {kind: 'docx', blocks: entry.blocks, mtime: entry.mtime};
        }
        return {kind: entry.kind, content: entry.content, headings: entry.headings, mtime: entry.mtime};
    }

    function unitEndFor(unit, entry) {
        // Infinity 结尾按下一同级标题收口
        if (Number.isFinite(unit.endOffset)) return unit.endOffset;
        if (entry.kind === 'md' || entry.kind === 'txt') {
            const hs = entry.headings || [];
            for (const h of hs) {
                if (h.offset > unit.offset && h.level <= (unit.level || 1)) return h.offset;
            }
            return Infinity;
        }
        if (entry.kind === 'docx') {
            const hs = (book.scan.files || []).find((x) => x.rel === unit.rel);
            if (hs) {
                for (const h of hs.headings || []) {
                    if (h.offset > unit.offset && h.level <= (unit.level || 1)) return h.offset;
                }
            }
        }
        return Infinity;
    }

    // 大单元分块（§10.1）：> 200KB 文本按段落边界切块
    function chunkText(text) {
        const LIMIT = 200 * 1024;
        if (text.length <= LIMIT) return [text];
        const chunks = [];
        let rest = text;
        while (rest.length > LIMIT) {
            let cut = rest.lastIndexOf('\n', LIMIT);
            if (cut < LIMIT * 0.5) cut = LIMIT;
            chunks.push(rest.slice(0, cut));
            rest = rest.slice(cut);
        }
        if (rest.trim()) chunks.push(rest);
        return chunks;
    }

    let chunkIndex = 0;
    let chunkTotal = 1;
    let pendingChunks = null;

    function volumeHeaderFor(index) {
        // 卷边界插入卷分隔（§7.1）：与上一章不同卷时显示卷名
        const chapter = book.chapters[index];
        const prev = index > 0 ? book.chapters[index - 1] : null;
        if (!chapter.volumeTitle) return '';
        if (prev && prev.volumeTitle === chapter.volumeTitle) return '';
        return '<div class="rd-volume-header">' + escapeHtmlText(chapter.volumeTitle) + '</div>';
    }

    function chapterEndFor(index) {
        if (index >= book.chapters.length - 1) {
            return '<div class="rd-chapter-end"><span>全书完 · 共 ' + book.chapters.length + ' 章</span></div>';
        }
        return '<div class="rd-chapter-end"><span>本章完</span>' +
            '<button type="button" class="tb-btn rd-next-chapter">下一章 →</button></div>';
    }

    function bindChapterEnd(index) {
        const btnNext = els.reader.querySelector('.rd-next-chapter');
        if (btnNext) btnNext.addEventListener('click', () => navigate(1));
    }

    function escapeHtmlText(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    async function renderChapter(index, opts) {
        opts = opts || {};
        if (!book || index < 0 || index >= book.chapters.length) return;
        if (isStream()) return renderStreamFrom(index, opts);
        saveProgress(true);
        currentIndex = index;
        const chapter = book.chapters[index];
        currentUnit = chapter;
        const payload = await ensureUnitPayload(chapter);
        let unit = Object.assign({}, chapter);
        if (payload.kind === 'md' || payload.kind === 'txt') {
            const entry = await ensureFile(unit.rel);
            unit.endOffset = unitEndFor(unit, entry);
            let text = payload.content;
            if (Number.isFinite(unit.endOffset)) {
                const lines = String(payload.content).replace(/\r\n/g, '\n').split('\n');
                text = lines.slice(unit.offset - 1, unit.endOffset - 1).join('\n');
            }
            const chunks = chunkText(text);
            chunkIndex = 0;
            chunkTotal = chunks.length;
            pendingChunks = chunks;
            payload.content = chunks[0];
        } else if (payload.kind === 'docx') {
            unit.endOffset = unitEndFor(unit, payload);
        }
        const rendered = await render.renderUnit(unit, payload);
        let html = volumeHeaderFor(index) + rendered.html + chapterEndFor(index);
        if (isPaged()) {
            els.reader.innerHTML = '<div class="rd-paged-viewport"><div class="rd-paged-inner">' + html + '</div></div>';
            repaginate(0);
        } else {
            els.reader.innerHTML = html;
            els.reader.scrollTop = 0;
        }
        currentRatio = 0;
        chunkIndex = 1;
        appendChunkButton();
        bindChapterEnd(index);
        // EPUB 跨章锚点落地
        if (pendingAnchor) {
            requestAnimationFrame(() => handleEpubAnchor(pendingAnchor));
        }
        // 恢复滚动比例
        if (opts.ratio > 0 && !isPaged()) {
            requestAnimationFrame(() => {
                const max = els.reader.scrollHeight - els.reader.clientHeight;
                els.reader.scrollTop = Math.max(0, max * opts.ratio);
            });
        }
        updateUnitUI(chapter);
        prefetchNext(index + 1);
    }

    // ---- 连续滚动（§12.1）----

    async function renderStreamFrom(index, opts) {
        opts = opts || {};
        saveProgress(true);
        streamState = {next: index, count: 0, bytes: 0, busy: false, firstIndex: index};
        currentIndex = index;
        currentUnit = book.chapters[index];
        els.reader.innerHTML = '';
        await appendStreamChapter();
        currentRatio = 0;
        if (opts.ratio > 0) {
            requestAnimationFrame(() => {
                const max = els.reader.scrollHeight - els.reader.clientHeight;
                els.reader.scrollTop = Math.max(0, max * opts.ratio);
                updateStreamCurrent();
            });
        }
        prefetchNext(streamState.next);
    }

    async function appendStreamChapter() {
        const st = streamState;
        if (!st || st.busy || !book) return;
        if (st.next >= book.chapters.length) return;
        const capUnits = 30;
        const capBytes = 8 << 20;
        if (st.count >= capUnits || st.bytes > capBytes) {
            showStreamMoreButton();
            return;
        }
        st.busy = true;
        try {
            const idx = st.next;
            const chapter = book.chapters[idx];
            const payload = await ensureUnitPayload(chapter);
            const unit = Object.assign({}, chapter);
            if (payload.kind === 'md' || payload.kind === 'txt') {
                const entry = await ensureFile(unit.rel);
                unit.endOffset = unitEndFor(unit, entry);
                let text = payload.content;
                if (Number.isFinite(unit.endOffset)) {
                    const lines = String(payload.content).replace(/\r\n/g, '\n').split('\n');
                    text = lines.slice(unit.offset - 1, unit.endOffset - 1).join('\n');
                }
                payload.content = chunkText(text).join('\n');
            } else if (payload.kind === 'docx') {
                unit.endOffset = unitEndFor(unit, payload);
            }
            const rendered = await render.renderUnit(unit, payload);
            const section = document.createElement('section');
            section.dataset.unitId = chapter.id;
            section.innerHTML = volumeHeaderFor(idx) + rendered.html;
            els.reader.appendChild(section);
            st.bytes += rendered.html.length * 2;
            st.count++;
            st.next = idx + 1;
            if (idx === st.firstIndex) {
                els.reader.scrollTop = 0;
                updateUnitUI(chapter);
            }
        } catch (e) { /* 单章失败不中断流 */ }
        st.busy = false;
    }

    function showStreamMoreButton() {
        if (els.reader.querySelector('.rd-stream-more')) return;
        const more = document.createElement('button');
        more.className = 'rd-stream-more tb-btn';
        more.type = 'button';
        more.textContent = '加载更多（已连续加载 ' + streamState.count + ' 章）';
        more.addEventListener('click', async () => {
            more.remove();
            const st = streamState;
            if (st) {
                st.count = 0;
                st.bytes = 0;
            }
            await appendStreamChapter();
        });
        els.reader.appendChild(more);
    }

    function updateStreamCurrent() {
        const st = streamState;
        if (!st || detailVisible) return;
        const sections = els.reader.querySelectorAll('section[data-unit-id]');
        if (!sections.length) return;
        const line = els.reader.scrollTop + Math.min(120, els.reader.clientHeight * 0.25);
        let currentSection = sections[0];
        for (const sec of sections) {
            if (sec.offsetTop <= line) currentSection = sec;
            else break;
        }
        const id = currentSection.dataset.unitId;
        if (currentUnit && currentUnit.id === id) return;
        const idx = book.chapters.findIndex((c) => c.id === id);
        if (idx < 0) return;
        currentIndex = idx;
        currentUnit = book.chapters[idx];
        const secMax = Math.max(1, currentSection.offsetHeight);
        currentRatio = Math.max(0, Math.min(1,
            (els.reader.scrollTop - currentSection.offsetTop) / secMax));
        updateUnitUI(currentUnit);
    }

    // ---- 分页（§12.2 CSS 多栏原型）----

    function repaginate(keepPage) {
        const inner = els.reader.querySelector('.rd-paged-inner');
        if (!inner) return;
        inner.style.transform = '';
        const step = els.reader.clientWidth + 64;
        const pages = Math.max(1, Math.ceil(inner.scrollWidth / step));
        const page = Math.min(keepPage, pages - 1);
        pageState = {page, pages};
        applyPage();
        const chapter = book.chapters[currentIndex];
        els.progressText.textContent = (currentIndex + 1) + ' / ' + book.chapters.length +
            ' · 第 ' + (page + 1) + '/' + pages + ' 页';
        if (chapter) {
            currentRatio = pages > 1 ? page / pages : 0;
        }
    }

    function applyPage() {
        const inner = els.reader.querySelector('.rd-paged-inner');
        if (!inner || !pageState) return;
        const step = els.reader.clientWidth + 64;
        inner.style.transform = 'translateX(-' + pageState.page * step + 'px)';
    }

    function pageNext() {
        if (!pageState) return;
        if (pageState.page + 1 < pageState.pages) {
            pageState.page++;
            applyPage();
            repaginate(pageState.page);
        } else {
            navigate(1);
        }
    }

    function pagePrev() {
        if (!pageState) return;
        if (pageState.page > 0) {
            pageState.page--;
            repaginate(pageState.page);
        } else if (currentIndex > 0) {
            navigate(-1).then(() => {
                requestAnimationFrame(() => repaginate(pageState ? pageState.pages - 1 : 0));
            });
        }
    }

    function appendChunkButton() {
        if (chunkTotal <= 1) return;
        const more = document.createElement('button');
        more.className = 'rd-chunk-more tb-btn';
        more.type = 'button';
        more.textContent = '本章较长，已分块（' + chunkIndex + '/' + chunkTotal + '）· 继续阅读';
        more.addEventListener('click', () => {
            if (chunkIndex >= chunkTotal) return;
            more.remove();
            const unit = Object.assign({}, currentUnit);
            const isTxt = pendingKind() === 'txt';
            const rendered = render.renderUnit(unit, {
                kind: pendingKind(),
                content: pendingChunks[chunkIndex],
                headings: [],
                rawSlice: !isTxt,
            });
            chunkIndex++;
            rendered.then((r) => {
                els.reader.insertAdjacentHTML('beforeend', r.html);
                appendChunkButton();
            });
        });
        els.reader.appendChild(more);
    }

    function pendingKind() {
        const ch = book.chapters[currentIndex];
        return extOf(ch.rel) === 'txt' ? 'txt' : 'md';
    }

    function updateUnitUI(chapter) {
        els.unitTitle.textContent = chapter.title;
        els.progressText.textContent = (currentIndex + 1) + ' / ' + book.chapters.length +
            ' · ' + Math.round(currentRatio * 100) + '%';
        const p = computeProgress(book.chapters, book.model.totalWords, currentIndex, currentRatio);
        els.progressFill.style.width = Math.round(p * 100) + '%';
        stateStore.setProgress(book.key, {
            lastUnitId: chapter.id,
            lastUnitTitle: chapter.title,
            lastUnitOrdinal: chapter.offset,
            lastRel: chapter.rel,
            scrollRatio: currentRatio,
            progress: p,
        });
        renderTocPane();
    }

    function prefetchNext(index) {
        if (index >= book.chapters.length) return;
        const next = book.chapters[index];
        setTimeout(async () => {
            try {
                await ensureFile(next.rel); // 预热文件内容
            } catch (e) { /* 预取失败忽略 */ }
        }, 400);
    }

    function onReaderScroll() {
        if (!book || detailVisible) return;
        if (isPaged()) return; // 分页模式无滚动
        const el = els.reader;
        if (isStream() && streamState) {
            // 底部 sentinel 追加下一章（§12.1：进入视口 800px）
            if (el.scrollHeight - (el.scrollTop + el.clientHeight) < 800) {
                appendStreamChapter();
            }
            updateStreamCurrent();
            // 章内比例随滚动保存（§12.1：进度 = 当前章 + 章内比例）
            if (currentUnit) {
                const sec = els.reader.querySelector('section[data-unit-id="' + (window.CSS && CSS.escape ? CSS.escape(currentUnit.id) : currentUnit.id) + '"]');
                if (sec) {
                    const secMax = Math.max(1, sec.offsetHeight);
                    currentRatio = Math.max(0, Math.min(1, (el.scrollTop - sec.offsetTop) / secMax));
                    scheduleProgressSave();
                }
            }
            return;
        }
        const max = Math.max(1, el.scrollHeight - el.clientHeight);
        currentRatio = Math.max(0, Math.min(1, el.scrollTop / max));
        const p = computeProgress(book.chapters, book.model.totalWords, currentIndex, currentRatio);
        els.progressFill.style.width = Math.round(p * 100) + '%';
        els.progressText.textContent = (currentIndex + 1) + ' / ' + book.chapters.length +
            ' · ' + Math.round(currentRatio * 100) + '%';
        scheduleProgressSave();
    }

    let progressSaveTimer = 0;
    function scheduleProgressSave() {
        clearTimeout(progressSaveTimer);
        progressSaveTimer = setTimeout(() => saveProgress(false), 500);
    }
    function saveProgress(immediate) {
        if (!book || detailVisible || !currentUnit) return;
        const p = computeProgress(book.chapters, book.model.totalWords, currentIndex, currentRatio);
        stateStore.setProgress(book.key, {
            lastUnitId: currentUnit.id,
            lastUnitTitle: currentUnit.title,
            lastUnitOrdinal: currentUnit.offset,
            lastRel: currentUnit.rel,
            scrollRatio: currentRatio,
            progress: p,
        });
        if (immediate) stateStore.flush();
    }

    // ---- 导航 ----

    async function navigate(delta) {
        if (!book) return;
        if (treeMode) return treeNavigate(delta);
        const target = currentIndex + delta;
        if (target < 0) {
            deps.showFlash('已经是第一章');
            return;
        }
        if (target >= book.chapters.length) {
            deps.showFlash('全书完 · 共 ' + book.chapters.length + ' 章');
            return;
        }
        await renderChapter(target, {});
    }

    // 文档树模式：上一节/下一节按先序（父 → 子 → 下一兄弟，§7.2）
    async function treeNavigate(delta) {
        const nodes = book.treeNodes || [];
        if (!nodes.length) return;
        const at = nodes.findIndex((n) => currentUnit && n.id === currentUnit.id);
        const target = (at < 0 ? 0 : at + delta);
        if (target < 0 || target >= nodes.length) {
            deps.showFlash(delta > 0 ? '已是最后一节' : '已是第一节');
            return;
        }
        await renderRangeNode(nodes[target]);
    }

    // TOC 跳转：章节点走章流；树模式渲染节点区间
    async function jumpTo(node) {
        if (!node) return;
        if (node.kind === 'volume') {
            if (!node.renderable) {
                // 找到卷内第一章
                const first = firstChapterOf(node);
                if (first) return jumpTo(first);
                return;
            }
            // 卷首语：树模式直接渲染卷区间
            if (treeMode) return renderRangeNode(node);
            const first = firstChapterOf(node);
            if (first) return jumpTo(first);
            return;
        }
        if (treeMode) {
            return renderRangeNode(node);
        }
        const idx = book.chapters.findIndex((c) => c.id === node.id);
        if (idx >= 0) {
            await renderChapter(idx, {});
        } else {
            deps.showFlash('该节点不在章流中，可切换文档树模式查看');
        }
    }

    function firstChapterOf(node) {
        if (node.kind === 'chapter') return node;
        for (const c of node.children || []) {
            const found = firstChapterOf(c);
            if (found) return found;
        }
        return null;
    }

    // 树模式：渲染任意节点区间（含子标题）
    async function renderRangeNode(node) {
        detailVisible = false;
        els.bottombar.style.display = '';
        els.reader.className = 'rd-reader';
        const payload = await ensureUnitPayload({rel: node.rel, offset: node.offset});
        const unit = Object.assign({}, node);
        unit.endOffset = unitEndFor(unit, payload.kind === 'docx' ? payload : await ensureFile(node.rel));
        const rendered = await render.renderUnit(unit, payload);
        els.reader.innerHTML = rendered.html;
        els.reader.scrollTop = 0;
        currentUnit = node;
        currentRatio = 0;
        chunkTotal = 1;
        updateUnitUI(node);
    }

    // ---- 侧栏 ----

    function switchTab(tab) {
        sidebarTab = tab;
        els.tabToc.classList.toggle('active', tab === 'toc');
        els.tabBm.classList.toggle('active', tab === 'bm');
        els.tabSearch.classList.toggle('active', tab === 'search');
        els.tocPane.classList.toggle('hidden', tab !== 'toc');
        els.bmPane.classList.toggle('hidden', tab !== 'bm');
        els.searchPane.classList.toggle('hidden', tab !== 'search');
        els.tocFilter.classList.toggle('hidden', tab !== 'toc');
        if (tab === 'toc') renderTocPane();
        if (tab === 'bm') renderBmPane();
        els.sidebar.classList.remove('hidden');
    }

    function renderTocPane() {
        if (!book) return;
        const depth = Number(deps.getSetting('readingTocDepth', 2)) || 2;
        renderToc(els.tocPane, {
            nodes: book.model.top,
            activeId: currentUnit ? currentUnit.id : '',
            depth: depth,
            filter: els.tocFilter.value.trim(),
            cap: tocCap,
            onShowMore: () => {
                tocCap += 300;
                renderTocPane();
            },
            onJump: (node) => jumpTo(node),
        });
        if (!els.sidebar.classList.contains('hidden')) {
            scrollTocToActive(els.tocPane);
        }
    }

    function renderBmPane() {
        if (!book) return;
        const saved = stateStore.getBook(book.key);
        renderBookmarks(els.bmPane, {
            bookmarks: saved ? saved.bookmarks : [],
            onGo: async (bm) => {
                const parsed = bm.unitId || '';
                const idx = book.chapters.findIndex((c) => c.id === parsed);
                if (idx >= 0) {
                    await renderChapter(idx, {ratio: bm.ratio});
                }
            },
            onDelete: (bm) => {
                stateStore.removeBookmark(book.key, bm.id);
                renderBmPane();
            },
        });
    }

    // ---- 全书搜索（§11.2：进度 x/y + 可取消） ----

    let activeSearchRequestID = '';

    async function runBookSearch(query) {
        if (!book || searchBusy) return;
        searchBusy = true;
        const backend = app();
        const requestID = 'rd-search-' + Date.now();
        activeSearchRequestID = requestID;
        const unbindProgress = bindSearchProgress(requestID);
        renderSearchResults(els.searchResults, {
            status: '搜索中…', query, cancellable: true,
            onCancel: () => backend && backend.CancelReadingSearch(requestID),
        });
        try {
            const result = await backend.SearchReadingBook(requestID, book.root, query, {});
            if (activeSearchRequestID === requestID) {
                renderSearchResults(els.searchResults, {result, query, onGo: onSearchGo});
            }
        } catch (e) {
            renderSearchResults(els.searchResults, {status: '搜索失败：' + (e.message || e), query});
        }
        if (unbindProgress) unbindProgress();
        activeSearchRequestID = '';
        searchBusy = false;
    }

    // 订阅后端 reading-search-progress 事件，把「已扫描 x/y」写进状态行
    function bindSearchProgress(requestID) {
        const rt = typeof window !== 'undefined' ? window.runtime : null;
        if (!rt || typeof rt.EventsOn !== 'function') return null;
        const handler = (data) => {
            if (!data || data.requestID !== requestID) return;
            const row = els.searchResults.querySelector('.rd-search-status');
            if (row) row.textContent = '已扫描 ' + data.scanned + ' / ' + data.total + ' …';
        };
        rt.EventsOn('reading-search-progress', handler);
        return () => {
            if (typeof rt.EventsOff === 'function') rt.EventsOff('reading-search-progress');
        };
    }

    async function onSearchGo(rel, unitOffset, hit, hitIndexInGroup) {
        const idx = book.chapters.findIndex((c) => c.rel === rel && c.offset === unitOffset);
        if (idx < 0) {
            deps.showFlash('定位失败：单元不存在');
            return;
        }
        await renderChapter(idx, {});
        if (hit && hit.match) {
            setTimeout(() => {
                search.find(hit.match);
            }, 80);
        }
    }

    // ---- 章内查找条 ----

    function openFindBar() {
        els.findbar.classList.remove('hidden');
        els.findInput.focus();
        els.findInput.select();
    }

    function closeFindBar() {
        els.findbar.classList.add('hidden');
        search.clear();
    }

    function runFind() {
        const q = els.findInput.value;
        const n = search.find(q);
        els.findCount.textContent = n ? (search.index + 1) + '/' + n : (q ? '0/0' : '');
    }

    // ---- 书签 ----

    function addBookmark() {
        if (!book || detailVisible) return;
        const chapter = book.chapters[currentIndex];
        // 最近可见段落前 30 字摘录
        let excerpt = chapter.title;
        const scrollTop = els.reader.scrollTop;
        for (const p of els.reader.querySelectorAll('p, h1, h2, h3, h4, h5, h6')) {
            if (p.offsetTop >= scrollTop) {
                excerpt = (p.textContent || '').trim().slice(0, 30);
                break;
            }
        }
        const res = stateStore.addBookmark(book.key, {
            unitId: chapter.id,
            rel: chapter.rel,
            title: chapter.title,
            ratio: currentRatio,
            excerpt,
        });
        deps.showFlash(res.ok ? '已添加书签' : '该位置已存在书签');
        if (sidebarTab === 'bm') renderBmPane();
    }

    // ---- 专注模式 ----

    function toggleFocus() {
        focusMode = !focusMode;
        container.classList.toggle('rd-focus', focusMode);
        els.focusHint.classList.toggle('hidden', !focusMode);
        els.btnFocus.textContent = focusMode ? '退出专注' : '专注';
    }

    // ---- 设置应用 ----

    function applyReadingSettings() {
        const get = (k, d) => deps.getSetting(k, d);
        const font = fontFamilyFor(get('readingFont', 'songti'));
        const style = container.style;
        style.setProperty('--rd-font', font);
        style.setProperty('--rd-font-size', (Number(get('readingFontSize', 19)) || 19) + 'px');
        style.setProperty('--rd-line-height', String(Number(get('readingLineHeight', 1.9)) || 1.9));
        style.setProperty('--rd-page-width', (Number(get('readingPageWidth', 42)) || 42) + 'em');
        style.setProperty('--rd-para-gap', (Number(get('readingParagraphGap', 0.6)) || 0.6) + 'em');
        container.classList.toggle('rd-indent', !!get('readingIndent', false));
        const theme = get('readingTheme', 'auto');
        const resolved = theme === 'auto' ? (deps.isDarkTheme() ? 'dark' : 'light') : theme;
        container.dataset.rdTheme = resolved;
        container.classList.toggle('rd-paged', !!get('readingPaged', false));
    }

    function openSettingsPopover() {
        if (popover) {
            closeSettingsPopover();
            return;
        }
        popover = document.createElement('div');
        popover.className = 'rd-popover';
        const settings = {};
        for (const key of Object.keys(READING_SETTINGS_DEFAULTS)) {
            settings[key] = deps.getSetting(key, READING_SETTINGS_DEFAULTS[key]);
        }
        renderSettingsPopover(popover, {
            settings,
            onChange: (key, value) => {
                let v = value;
                if (typeof READING_SETTINGS_DEFAULTS[key] === 'number') v = Number(value);
                if (typeof READING_SETTINGS_DEFAULTS[key] === 'boolean') v = value === true || value === 'true';
                deps.setSetting(key, v);
                applyReadingSettings();
                if (key === 'readingTocDepth') renderTocPane();
                if (key === 'readingContinuous' || key === 'readingPaged') {
                    deps.showFlash(key === 'readingContinuous' ? '连续滚动将在下一章生效' : '分页模式已切换');
                }
            },
        });
        els.topbar.appendChild(popover);
        setTimeout(() => {
            document.addEventListener('pointerdown', onPopoverOutside);
        }, 0);
    }

    function onPopoverOutside(e) {
        if (popover && !popover.contains(e.target) && e.target !== els.btnAa) {
            closeSettingsPopover();
        }
    }

    function closeSettingsPopover() {
        if (popover) {
            popover.remove();
            popover = null;
            document.removeEventListener('pointerdown', onPopoverOutside);
        }
    }

    function openStatsDialog() {
        if (!book) return;
        const stats = stateStore.stats(book.key) || {totalSec: 0, daily: {}, streak: 0, sessions: 0};
        const today = new Date();
        const key = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
        const dlg = document.createElement('div');
        dlg.className = 'rd-popover rd-stats-pop';
        renderStats(dlg, {
            totalSec: stats.totalSec,
            todaySec: (stats.daily || {})[key] || 0,
            streak: stats.streak,
            sessions: stats.sessions,
            daily: stats.daily,
        });
        els.topbar.appendChild(dlg);
        const close = (e) => {
            if (!dlg.contains(e.target)) {
                dlg.remove();
                document.removeEventListener('pointerdown', close);
            }
        };
        setTimeout(() => document.addEventListener('pointerdown', close), 0);
    }

    // ---- 统计计时（§8.5） ----

    let statsTimer = 0;
    function startStatsTimer() {
        clearInterval(statsTimer);
        statsTimer = setInterval(() => {
            if (!active || !book || detailVisible) return;
            if (document.hidden) return;
            if (Date.now() - lastInteraction > 60000) return; // 空闲 60s 暂停
            statsAccum += 15;
            if (statsAccum >= 30) {
                stateStore.recordReading(book.key, statsAccum);
                statsAccum = 0;
            }
        }, 15000);
    }

    function onVisibility() {
        if (document.hidden) {
            saveProgress(true);
            if (tts.playing) tts.pause();
        } else if (book && Date.now() - lastScanAt > 60000) {
            backgroundRescan();
        }
    }

    // 后台重扫（§4.5）：不阻塞当前阅读；重扫后按当前单元重新定位
    async function backgroundRescan() {
        if (rescanBusy || !book || book.isEpub) return;
        rescanBusy = true;
        try {
            const saved = stateStore.getBook(book.key) || {};
            const scan = await app().ScanReadingRoot(book.root, {IgnoreDirs: saved.ignoreDirs || []});
            lastScanAt = Date.now();
            const model = buildBookModel(scan, {chapterLevel: saved.chapterLevel});
            const chapters = flattenChapters(model);
            const sameUnit = currentUnit && chapters.some((c) => c.id === currentUnit.id);
            book.scan = scan;
            book.model = model;
            book.chapters = chapters;
            book.treeNodes = flattenTreePreorder(model.top);
            fileCache = new Map();
            render.cacheClear();
            if (!sameUnit && currentUnit) {
                const located = locateUnit(chapters, {
                    lastUnitId: currentUnit.id,
                    lastRel: currentUnit.rel,
                    lastUnitTitle: currentUnit.title,
                    lastUnitOrdinal: currentUnit.offset,
                }, model);
                if (chapters[located.index] && chapters[located.index].id !== currentUnit.id) {
                    deps.showFlash('原位置已变化，已跳到最近章节');
                    currentIndex = located.index;
                }
            }
            renderTocPane();
        } catch (e) { /* 重扫失败静默 */ }
        rescanBusy = false;
    }

    function stopTts() {
        tts.stop();
        els.btnTts.textContent = '朗读';
    }

    // EPUB 锚链接：本章内滚动；跨章时定位到含该 id 的章（§10.5）
    async function handleEpubAnchor(id) {
        if (!id) return;
        const esc = (window.CSS && CSS.escape) ? CSS.escape(id) : id.replace(/"/g, '\\"');
        const local = els.reader.querySelector('[id="' + esc + '"]');
        if (local) {
            local.scrollIntoView({block: 'start'});
            return;
        }
        // 跨 spine：线性查找（磁盘读取有缓存目录，命中即停）
        const backend = app();
        if (!backend || !book) return;
        for (let i = 0; i < book.chapters.length; i++) {
            if (i === currentIndex) continue;
            try {
                const ch = await ensureUnitPayload(book.chapters[i]);
                const re = new RegExp('id\\s*=\\s*["\']' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']');
                if (ch.content && re.test(ch.content)) {
                    pendingAnchor = id;
                    await renderChapter(i, {});
                    pendingAnchor = '';
                    return;
                }
            } catch (e) { /* 继续找 */ }
        }
        deps.showFlash('未找到锚点：' + id);
    }

    function openLightbox(src, alt) {
        const box = document.createElement('div');
        box.className = 'rd-lightbox';
        const img = document.createElement('img');
        img.src = src;
        img.alt = alt || '';
        box.appendChild(img);
        box.addEventListener('click', () => box.remove());
        container.appendChild(box);
    }

    // ---- 快捷键（§7.3） ----

    function onCaptureKey(e) {
        if (!active) return;
        if (deps.isDialogOpen()) return; // 对话框优先
        const key = e.key;
        if (key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (!els.findbar.classList.contains('hidden')) {
                closeFindBar();
            } else if (focusMode) {
                toggleFocus();
            } else if (popover) {
                closeSettingsPopover();
            } else {
                close();
            }
            return;
        }
        const inInput = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
        if (inInput) {
            if (e.target === els.findInput) {
                if (key === 'Enter') {
                    e.preventDefault();
                    if (e.shiftKey) search.prev();
                    else search.next();
                    els.findCount.textContent = search.count ? (search.index + 1) + '/' + search.count : '0/0';
                }
            }
            return;
        }
        if (e.ctrlKey && !e.shiftKey && key.toLowerCase() === 'f') {
            e.preventDefault();
            e.stopPropagation();
            openFindBar();
            return;
        }
        if (e.ctrlKey && e.shiftKey && key.toLowerCase() === 'f') {
            e.preventDefault();
            e.stopPropagation();
            switchTab('search');
            const input = els.searchPane.querySelector('input');
            if (input) input.focus();
            return;
        }
        if (e.ctrlKey && !e.shiftKey && key.toLowerCase() === 'd') {
            e.preventDefault();
            e.stopPropagation();
            addBookmark();
            return;
        }
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        switch (key) {
            case 'ArrowLeft':
                e.preventDefault();
                if (isPaged()) pagePrev();
                else navigate(-1);
                break;
            case 'ArrowRight':
                e.preventDefault();
                if (isPaged()) pageNext();
                else navigate(1);
                break;
            case 'PageUp':
                e.preventDefault();
                if (isPaged()) pagePrev();
                else els.reader.scrollBy({top: -els.reader.clientHeight * 0.9});
                break;
            case ' ':
                e.preventDefault();
                if (isPaged()) {
                    if (e.shiftKey) pagePrev();
                    else pageNext();
                } else if (e.shiftKey) {
                    els.reader.scrollBy({top: -els.reader.clientHeight * 0.9});
                } else {
                    els.reader.scrollBy({top: els.reader.clientHeight * 0.9});
                }
                break;
            case 'PageDown':
                e.preventDefault();
                if (isPaged()) pageNext();
                else els.reader.scrollBy({top: els.reader.clientHeight * 0.9});
                break;
            case 'Home':
                e.preventDefault();
                els.reader.scrollTop = 0;
                break;
            case 'End':
                e.preventDefault();
                els.reader.scrollTop = els.reader.scrollHeight;
                break;
            case '[':
                els.sidebar.classList.add('hidden');
                break;
            case ']':
                els.sidebar.classList.remove('hidden');
                break;
            default:
                break;
        }
    }

    // ---- 事件接线 ----

    els.back.addEventListener('click', () => {
        if (!els.findbar.classList.contains('hidden')) closeFindBar();
        else if (focusMode) toggleFocus();
        else close();
    });
    els.btnToc.addEventListener('click', () => {
        if (sidebarTab === 'toc' && !els.sidebar.classList.contains('hidden')) {
            els.sidebar.classList.add('hidden');
        } else {
            switchTab('toc');
        }
    });
    els.btnBm.addEventListener('click', () => switchTab('bm'));
    els.btnSearch.addEventListener('click', () => switchTab('search'));
    els.btnAa.addEventListener('click', openSettingsPopover);
    els.btnFocus.addEventListener('click', toggleFocus);
    els.btnTts.addEventListener('click', async () => {
        if (tts.playing) {
            stopTts();
            return;
        }
        const ok = await tts.probe();
        if (!ok) {
            deps.showFlash('未检测到中文语音，请在 Windows 设置安装中文语音包');
            return;
        }
        tts.speakUnit();
    });
    els.tabToc.addEventListener('click', () => switchTab('toc'));
    els.tabBm.addEventListener('click', () => switchTab('bm'));
    els.tabSearch.addEventListener('click', () => switchTab('search'));
    els.tocFilter.addEventListener('input', () => renderTocPane());
    els.tocFilter.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const first = els.tocPane.querySelector('.rd-toc-title');
            if (first) first.click();
        }
    });
    els.findClose.addEventListener('click', closeFindBar);
    els.findInput.addEventListener('input', runFind);
    els.findPrev.addEventListener('click', () => search.prev());
    els.findNext.addEventListener('click', () => search.next());
    els.progressTrack.addEventListener('click', () => switchTab('toc'));
    // 交互时间与滚动进度（一次性注册）
    ['scroll', 'pointerdown', 'keydown'].forEach((ev) => {
        container.addEventListener(ev, () => {
            lastInteraction = Date.now();
        }, {passive: true});
    });
    els.reader.addEventListener('scroll', onReaderScroll, {passive: true});
    // 专注模式：鼠标移到顶部 24px 临时显示顶栏（§6.1）
    container.addEventListener('mousemove', (e) => {
        if (!focusMode) return;
        container.classList.toggle('rd-focus-reveal', e.clientY <= 24);
    });
    // 阅读区点击委托：图片灯箱 + EPUB 锚链接（§6.2/§10.5）
    els.reader.addEventListener('click', (e) => {
        const anchor = e.target.closest('a[data-epub-anchor]');
        if (anchor) {
            e.preventDefault();
            handleEpubAnchor(anchor.dataset.epubAnchor || '');
            return;
        }
        const img = e.target.closest('img');
        if (img && img.src && img.src.startsWith('/__local/')) {
            openLightbox(img.src, img.alt);
        }
    });
    // 阅读区右键菜单（§9）：复制 / 全选 / 添加书签 / 在编辑器中打开
    els.reader.addEventListener('contextmenu', (e) => {
        if (!book || detailVisible) return;
        e.preventDefault();
        const chapter = book.chapters[currentIndex];
        const editable = chapter && /\.(md|markdown|mdx|txt)$/i.test(chapter.rel || '');
        const sel = String(window.getSelection ? window.getSelection().toString() : '');
        rdCtx.open([
            {label: '复制', disabled: !sel, action: () => app().CopyText(sel).catch(() => {})},
            {label: '全选', action: () => {
                const r = document.createRange();
                r.selectNodeContents(els.reader);
                const s = window.getSelection();
                s.removeAllRanges();
                s.addRange(r);
            }},
            {sep: true},
            {label: '添加书签', shortcut: 'Ctrl+D', action: addBookmark},
            {label: '在编辑器中打开', disabled: !editable, action: () => {
                deps.openInEditor(els.reader && currentUnit ? currentUnit.rel : '', currentUnit ? currentUnit.offset : 0);
            }},
        ], e.clientX, e.clientY);
    });

    // 全书搜索面板：输入框 + 结果容器（结果渲染不清掉输入框）
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = '全书搜索…（Enter）';
    searchInput.className = 'rd-search-input';
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && searchInput.value.trim()) {
            runBookSearch(searchInput.value.trim());
        }
    });
    els.searchResults = document.createElement('div');
    els.searchResults.className = 'rd-search-results';
    els.searchPane.append(searchInput, els.searchResults);

    applyReadingSettings();

    return {
        open: show,
        close,
        openBook: (root) => {
            if (!active) show().then(() => openBook(root));
            else openBook(root);
        },
        openSingleFile: (path) => {
            if (!active) show().then(() => openSingleFile(path));
            else openSingleFile(path);
        },
        openBookshelf: () => {
            if (!active) show();
            else showBookshelf();
        },
        toggle: () => {
            if (active) close();
            else show();
        },
        isActive,
        applyReadingSettings,
        onKeydown: onCaptureKey,
        addBookmark,
        toggleFocus,
        openStatsDialog,
        runBookSearch: (q) => {
            switchTab('search');
            searchInput.value = q;
            return runBookSearch(q);
        },
    };
}
