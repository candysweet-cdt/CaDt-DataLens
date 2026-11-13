// editor-groups.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// 编辑器分栏（编辑器组 + 二叉分割树，VS Code 式）
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {iconSvg} from './icons.js';
import {createFileIcon, fileIconSpec} from './fileicons.js';
import {aceModeFor, formats, detectFormat, isKnownCodeFileName} from './formats.js';
import {showPatchView, disposePatchView} from './patch-view.js';
import {copyImageBlobToClipboard} from './image-clipboard.js';

export function createEditorGroups(deps) {

let editorGroups = [];
let splitRoot = null;
let focusedGroupId = null;
let groupSeq = 0;
let dragTabId = null;
let dragTabGroupId = null;
let dropZone = null;
const SPLIT_MAX_DEPTH = 3;
const SPLIT_MIN_W = 240;
const SPLIT_MIN_H = 180;

function nextGroupId() { return 'g' + (++groupSeq); }
function groupById(gid) { return editorGroups.find((g) => g.id === gid) || null; }
function groupOfDoc(docId) { return editorGroups.find((g) => g.docIds.includes(docId)) || null; }
function groupDocs(g) { return (g ? g.docIds.map((id) => deps.docs.find((d) => d.id === id)).filter(Boolean) : []); }
function focusedGroup() { return groupById(focusedGroupId) || editorGroups[0] || null; }
function createGroup(docIds) {
    const g = { id: nextGroupId(), docIds: docIds || [], activeId: (docIds && docIds.length ? docIds[0] : null) };
    editorGroups.push(g);
    if (!focusedGroupId) focusedGroupId = g.id;
    return g;
}
// 新开文件归入当前聚焦组（多开时只 activate 最后一个，其余仍需可见）
function addDocToFocusedGroup(doc) {
    if (!doc) return null;
    const g = focusedGroup() || createGroup();
    if (!g.docIds.includes(doc.id)) g.docIds.push(doc.id);
    return g;
}
function leafDepth(node, gid, d) {
    if (!node) return -1;
    if (typeof node === 'string') return node === gid ? d : -1;
    const a = leafDepth(node.a, gid, d + 1);
    if (a >= 0) return a;
    return leafDepth(node.b, gid, d + 1);
}
function groupDepth(gid) { return splitRoot ? leafDepth(splitRoot, gid, 0) : 0; }
function splitReplaceLeaf(node, gid, dir, side, newGid) {
    const mkSplit = (existing) => ({ dir, ratio: 0.5, a: side === 'before' ? newGid : existing, b: side === 'before' ? existing : newGid });
    if (!node) return mkSplit(gid);
    if (typeof node === 'string') return node === gid ? mkSplit(node) : node;
    if (node.a === gid) return { dir: node.dir, ratio: node.ratio, a: mkSplit(gid), b: node.b };
    if (node.b === gid) return { dir: node.dir, ratio: node.ratio, a: node.a, b: mkSplit(gid) };
    return { dir: node.dir, ratio: node.ratio, a: splitReplaceLeaf(node.a, gid, dir, side, newGid), b: splitReplaceLeaf(node.b, gid, dir, side, newGid) };
}
function collapseTree(node) {
    if (typeof node === 'string') return groupById(node) ? node : null;
    const a = collapseTree(node.a);
    const b = collapseTree(node.b);
    if (a === null) return b;
    if (b === null) return a;
    return { dir: node.dir, ratio: node.ratio, a, b };
}
function removeGroupIfEmpty(gid) {
    if (!gid) return;
    const idx = editorGroups.findIndex((g) => g.id === gid);
    if (idx < 0) return;
    if (editorGroups[idx].docIds.length) return;
    editorGroups.splice(idx, 1);
    if (splitRoot) splitRoot = collapseTree(splitRoot);
    if (focusedGroupId === gid || !groupById(focusedGroupId)) {
        const fg = focusedGroup();
        focusedGroupId = fg ? fg.id : null;
    }
}
function moveTabInGroup(gid, srcId, targetId, before) {
    const g = groupById(gid);
    if (!g) return;
    const si = g.docIds.indexOf(srcId);
    const ti = g.docIds.indexOf(targetId);
    if (si < 0 || ti < 0 || srcId === targetId) return;
    g.docIds.splice(si, 1);
    const idx = g.docIds.indexOf(targetId);
    g.docIds.splice(before ? idx : idx + 1, 0, srcId);
    renderTabs();
}

function renderTabs() { renderEditorLayout(); }

function renderEditorLayout() {
    deps.syncRunButtonState();
    // 提示条先移出布局区，避免被整体清空
    if (deps.els.banner && deps.els.banner.parentElement === deps.els.editor) deps.els.editorArea.appendChild(deps.els.banner);
    deps.els.editor.textContent = '';
    const root = splitRoot || (focusedGroupId || (editorGroups[0] && editorGroups[0].id));
    if (!root || !editorGroups.length) return;
    buildSplitNode(deps.els.editor, root);
    deps.scheduleSessionSave();
    for (const g of editorGroups) {
        const host = deps.els.editor.querySelector('.egroup[data-gid="' + g.id + '"] .ehost');
        if (!host) continue;
        const list = groupDocs(g);
        for (const d of list) {
            if (d.pane && d.pane.parentElement !== host) host.appendChild(d.pane);
        }
        const active = list.find((d) => d.id === g.activeId) || list[0];
        if (active) g.activeId = active.id;
        for (const d of list) {
            if (d.pane) d.pane.classList.toggle('active', d.id === g.activeId);
        }
    }
    // 提示条：放在聚焦分栏的标签条下方
    const fgWrap = deps.els.editor.querySelector('.egroup[data-gid="' + (focusedGroupId || (editorGroups[0] && editorGroups[0].id) || '') + '"]');
    if (fgWrap) {
        const fgHost = fgWrap.querySelector('.ehost');
        if (fgHost && deps.els.banner.parentElement !== fgWrap) fgWrap.insertBefore(deps.els.banner, fgHost);
    }
    // 全局 file 对齐聚焦组（直接更新 chrome，绝不递归回 renderTabs）
    if (!deps.file || !groupOfDoc(deps.file.id)) {
        const fg = focusedGroup();
        const fd = fg ? deps.docs.find((d) => d.id === fg.activeId) : null;
        if (fd) {
            deps.file = fd;
            deps.dirty = !!fd.dirty;
            // file 对齐到新活动 doc 时必须同步 currentMode，否则残留上一个 doc 的
            // 视图模式（browser doc 关闭后状态栏/工具条会卡在「网页视图」）
            deps.currentMode = deps.normalizeLegacySqlMode(fd);
        }
    }
    if (deps.file) {
        setFilename(deps.file.name, deps.file.path);
        renderBreadcrumb(deps.file.path);
        showBanner(deps.file, deps.file.parseError);
        deps.updateWindowTitle();
        updateStatus();
        deps.updateSearchState();
    }
}

function buildSplitNode(parent, node) {
    if (typeof node === 'string') { buildGroup(parent, node); return; }
    const wrap = document.createElement('div');
    wrap.className = 'esplit esplit-' + node.dir;
    const a = document.createElement('div');
    a.className = 'esplit-child';
    a.style.flexBasis = (node.ratio * 100) + '%';
    buildSplitNode(a, node.a);
    const b = document.createElement('div');
    b.className = 'esplit-child';
    buildSplitNode(b, node.b);
    wrap.append(a, makeSplitDivider(node), b);
    parent.appendChild(wrap);
}

function makeSplitDivider(node) {
    const d = document.createElement('div');
    d.className = 'esplit-divider';
    d.addEventListener('mousedown', (e) => {
        const childA = d.previousElementSibling;
        const childB = d.nextElementSibling;
        if (!childA || !childB) return;
        const horiz = node.dir === 'col';
        const start = horiz ? e.clientX : e.clientY;
        const rectA = childA.getBoundingClientRect();
        const total = horiz ? (rectA.width + childB.getBoundingClientRect().width) : (rectA.height + childB.getBoundingClientRect().height);
        const startRatio = node.ratio;
        deps.setDragCursor(horiz ? 'ew' : 'ns');
        document.body.style.userSelect = 'none';
        const move = (ev) => {
            const delta = (horiz ? ev.clientX : ev.clientY) - start;
            node.ratio = Math.min(0.8, Math.max(0.2, startRatio + delta / total));
            childA.style.flexBasis = (node.ratio * 100) + '%';
        };
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            deps.setDragCursor(null);
            document.body.style.userSelect = '';
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        e.preventDefault();
    });
    return d;
}

function buildGroup(parent, gid) {
    const g = groupById(gid);
    const wrap = document.createElement('div');
    wrap.className = 'egroup';
    wrap.dataset.gid = gid;
    const strip = document.createElement('div');
    strip.className = 'etabs';
    const single = editorGroups.length === 1 && !splitRoot;
    const hide = !g || !g.docIds.length || (deps.settings.openMode === 'window' && g.docIds.length === 1 && single);
    if (hide) strip.classList.add('hidden');
    const host = document.createElement('div');
    host.className = 'ehost';
    if (g) for (const d of groupDocs(g)) strip.appendChild(buildGroupTab(g, d, strip));
    wrap.append(strip, host);
    wireHostDnd(host, gid);
    host.addEventListener('mousedown', () => {
        if (focusedGroupId !== gid) focusGroupById(gid);
    });
    parent.appendChild(wrap);
    // 标签条右侧工具区（视图切换 + 标签页操作），每个分栏组独立一份
    if (!hide) {
        const tools = buildGroupTools(gid);
        if (tools) {
            wrap.appendChild(tools);
            const spacer = document.createElement('div');
            spacer.className = 'tb-spacer';
            spacer.style.width = tools.offsetWidth + 'px';
            strip.appendChild(spacer);
        }
    }
}

const VIEW_ICONS = {
    tree: '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M1.5 3.2h11M1.5 7h7.6M1.5 10.8h4.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/></svg>',
    table: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="2.2" width="11" height="9.6" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M1.5 5.6h11M5.3 2.2v9.6M9 2.2v9.6" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
    sql: '<svg viewBox="0 0 14 14" aria-hidden="true"><ellipse cx="7" cy="3.2" rx="4.7" ry="1.8" stroke="currentColor" stroke-width="1.1" fill="none"/><path d="M2.3 3.2v7.6c0 1 2.1 1.8 4.7 1.8s4.7-.8 4.7-1.8V3.2" stroke="currentColor" stroke-width="1.1" fill="none"/><path d="M2.3 7c0 1 2.1 1.8 4.7 1.8s4.7-.8 4.7-1.8" stroke="currentColor" stroke-width="1.1" fill="none"/></svg>',
    code: '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M4.4 3.6 1.7 7l2.7 3.4M9.6 3.6 12.3 7l-2.7 3.4M7.9 2.4 6.1 11.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
    text: '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.6h5.6L11.4 4v8.4H3z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/><path d="M5 7.2h4M5 9.6h4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
    preview: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="2.2" width="11" height="9.6" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><circle cx="4.8" cy="5.3" r="1.05" fill="currentColor"/><path d="M2.6 10.4 5.8 7.3l2.3 2.3L9.8 8l1.9 2.3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>',
    image: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="2.2" width="11" height="9.6" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><circle cx="4.8" cy="5.3" r="1.05" fill="currentColor"/><path d="M2.6 10.4 5.8 7.3l2.3 2.3L9.8 8l1.9 2.3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>',
    binary: '<svg viewBox="0 0 14 14" aria-hidden="true"><text x="2" y="10.6" font-size="9" font-family="JetBrains Mono, Consolas, monospace" font-weight="700" fill="currentColor">01</text></svg>',
    render: '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2 11c2.8 0 3.4-7 6.2-7 1.7 0 2 1.6 3.8 1.6" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/><circle cx="2" cy="11" r="1.1" fill="currentColor"/><circle cx="12" cy="5.6" r="1.1" fill="currentColor"/></svg>',
    patch: '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2 3.4h10M2 7h6.4M2 10.6h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/><path d="M9.6 8.2l2.4 2.4-2.4 2.4" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    split: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="2.2" width="11" height="9.6" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M7 2.6v9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
};
const MORE_ICON = '<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="2.9" r="1.25" fill="currentColor"/><circle cx="7" cy="7" r="1.25" fill="currentColor"/><circle cx="7" cy="11.1" r="1.25" fill="currentColor"/></svg>';

function viewDisabledFor(doc, mode) {
    if (!doc) return true;
    if (mode === 'image') return !doc.image;
    if (mode === 'binary') return !doc.binary;
    if (mode === 'tree') return !doc.treeAvailable;
    if (mode === 'preview') return !(doc.format && doc.format.preview) || !!doc.large;
    if (mode === 'table') return !(doc.format && doc.format.table);
    if (mode === 'render') return !deps.isSvgDoc(doc);
    if (mode === 'patch') return !(doc.format && doc.format.patch);
    return false;
}

function buildGroupTools(gid) {
    const g = groupById(gid);
    if (!g || !g.docIds.length) return null;
    const doc = deps.docs.find((d) => d.id === g.activeId) || groupDocs(g)[0];
    if (!doc) return null;
    const tools = document.createElement('div');
    tools.className = 'tb-tools';
    const activeMode = doc.splitActive ? 'split' : doc.mode;
    for (const [mode, label] of deps.viewOptionsFor(doc.format, doc)) {
        // 不可用的视图不显示（IDEA 只列可用视图），不摆灰态占位
        if (viewDisabledFor(doc, mode)) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        // SQL 是覆盖层：选中态独立于当前视图（开着才亮），底层视图按钮保持自己的选中态
        const on = mode === 'sql' ? !!doc.sqlActive : (activeMode === mode);
        btn.className = 'tb-view' + (on ? ' active' : '');
        btn.dataset.mode = mode;
        btn.title = label;
        btn.innerHTML = VIEW_ICONS[mode] || '';
        btn.addEventListener('click', async () => {
            if (deps.file !== doc) await activateDoc(doc);
            if (mode === 'sql') {
                deps.switchMode('sql');
            } else if (doc.splitActive || deps.currentMode !== mode) {
                deps.switchMode(mode);
            }
            renderTabs();
        });
        tools.appendChild(btn);
    }
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'tb-more';
    more.title = '标签页操作';
    more.innerHTML = MORE_ICON;
    more.addEventListener('click', () => {
        const r = more.getBoundingClientRect();
        showTabbarToolsMenu(r.left, r.bottom + 4);
    });
    tools.appendChild(more);
    return tools;
}

// 视图切换不一定重建标签条（底部状态栏、设置默认视图、快捷菜单等入口只调 switchMode），
// 这里按各分栏组当前文档同步视图按钮的选中态。
function syncTabViewTools() {
    for (const wrap of document.querySelectorAll('.egroup[data-gid]')) {
        const g = groupById(wrap.dataset.gid);
        const doc = g ? (deps.docs.find((d) => d.id === g.activeId) || groupDocs(g)[0]) : null;
        const activeMode = doc ? (doc.splitActive ? 'split' : doc.mode) : '';
        for (const btn of wrap.querySelectorAll('.tb-view[data-mode]')) {
            const isSql = btn.dataset.mode === 'sql';
            btn.classList.toggle('active', isSql ? !!(doc && doc.sqlActive) : btn.dataset.mode === activeMode);
        }
    }
}

function showTabbarToolsMenu(x, y) {
    if (!deps.ctxMenu) return;
    const clean = deps.docs.filter((d) => !d.dirty);
    deps.ctxMenu.open([
        {label: '新建浏览器标签页', icon: 'E721', action: () => deps.openBrowserTab('about:blank')},
        {label: '转到文件…', shortcut: 'Ctrl+Shift+N', icon: 'E721', action: () => {}},
        {sep: true},
        {label: '关闭所有标签页', action: () => closeDocsWithConfirm(deps.docs.slice(), '关闭所有标签页将丢弃未保存的修改。')},
        {label: '关闭未修改标签页', disabled: !clean.length, action: () => closeDocsWithConfirm(clean)},
        {sep: true},
        {label: '配置编辑器标签页…', icon: 'E713', action: () => deps.openSettings('editor-tabs')},
    ], x, y);
}

function focusGroupById(gid) {
    focusedGroupId = gid;
    const g = groupById(gid);
    const d = g ? deps.docs.find((x) => x.id === g.activeId) : null;
    if (d && deps.file !== d) activateDoc(d);
}

function bgTermTabIcon() {
    const span = document.createElement('span');
    span.className = 'tab-icon';
    span.innerHTML = iconSvg('terminal', 13);
    return span;
}

function buildGroupTab(g, doc, strip) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (doc.id === g.activeId ? ' active' : '') + (doc.dirty ? ' dirty' : '') + (doc.staleOnDisk ? ' stale' : '');
    tab.dataset.docId = String(doc.id);
    tab.title = (doc.path || doc.name) + (doc.staleOnDisk ? '\n（已在外部修改）' : '');
    // 后台终端标签页用 terminal 图标（非文件，没有扩展名图标）
    const icon = doc.bgTerm ? bgTermTabIcon() : createFileIcon(doc.name, 'tab-icon');
    const dot = document.createElement('span');
    dot.className = 'tab-dot';
    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = doc.name;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.title = '关闭';
    close.innerHTML = iconSvg('close', 12);
    close.addEventListener('click', (e) => {
        e.stopPropagation();
        requestCloseDoc(doc);
    });
    tab.append(icon, dot, name, close);
    tab.addEventListener('click', (e) => {
        if (e.shiftKey && deps.settings.shiftClickClose !== false) {
            e.preventDefault();
            requestCloseDoc(doc);
            return;
        }
        activateDoc(doc);
    });
    tab.addEventListener('dblclick', () => {
        if (deps.settings.dblClickClose) requestCloseDoc(doc);
    });
    tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        activateDoc(doc);
        showTabMenu(doc, e.clientX, e.clientY);
    });
    tab.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
            e.preventDefault();
            requestCloseDoc(doc);
        }
    });
    // 拖动：组内排序 + 跨区拖出分栏
    tab.draggable = true;
    const clearDropGaps = () => {
        strip.querySelectorAll('.tab.drop-gap-before, .tab.drop-gap-after').forEach((t) => {
            t.classList.remove('drop-gap-before', 'drop-gap-after');
        });
    };
    tab.addEventListener('dragstart', (e) => {
        dragTabId = doc.id;
        dragTabGroupId = g.id;
        tab.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(doc.id)); } catch (err) {}
    });
    tab.addEventListener('dragend', () => {
        dragTabId = null;
        dragTabGroupId = null;
        tab.classList.remove('dragging');
        clearDropGaps();
        hideSplitMask();
        dropZone = null;
    });
    tab.addEventListener('dragover', (e) => {
        if (dragTabId === null || dragTabGroupId !== g.id || dragTabId === doc.id) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        const r = tab.getBoundingClientRect();
        const before = e.clientX < r.x + r.width / 2;
        clearDropGaps();
        if (before) tab.classList.add('drop-gap-before');
        else {
            const next = tab.nextElementSibling;
            if (next && next.classList.contains('tab')) next.classList.add('drop-gap-before');
            else tab.classList.add('drop-gap-after');
        }
    });
    tab.addEventListener('drop', (e) => {
        if (dragTabId === null || dragTabGroupId !== g.id) return;
        e.preventDefault();
        e.stopPropagation();
        const r = tab.getBoundingClientRect();
        const before = e.clientX < r.x + r.width / 2;
        clearDropGaps();
        const srcId = dragTabId;
        dragTabId = null;
        dragTabGroupId = null;
        moveTabInGroup(g.id, srcId, doc.id, before);
    });
    if (doc.id === g.activeId) setTimeout(() => {
        try { tab.scrollIntoView({block: 'nearest', inline: 'nearest'}); } catch (err) {}
    }, 0);
    return tab;
}

function wireHostDnd(host, gid) {
    host.addEventListener('dragover', (e) => {
        if (dragTabId === null) return;
        const srcG = groupById(dragTabGroupId);
        const selfSingle = srcG && srcG.id === gid && srcG.docIds.length <= 1;
        const tg = groupById(gid);
        const canSplit = !selfSingle && !!tg && tg.docIds.length > 0 && groupDepth(gid) < SPLIT_MAX_DEPTH;
        const cell = host.parentElement;
        if (!cell) return;
        const rect = cell.getBoundingClientRect();
        const relX = (e.clientX - rect.x) / rect.width;
        const relY = (e.clientY - rect.y) / rect.height;
        let zone = 'center';
        if (canSplit) {
            if (relX < 0.25) zone = 'left';
            else if (relX > 0.75) zone = 'right';
            else if (relY < 0.25) zone = 'top';
            else if (relY > 0.75) zone = 'bottom';
        }
        if (zone === 'left' || zone === 'right') {
            if (rect.width / 2 < SPLIT_MIN_W) zone = 'center';
        } else if (zone === 'top' || zone === 'bottom') {
            if (rect.height / 2 < SPLIT_MIN_H) zone = 'center';
        }
        dropZone = { gid, zone, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        showSplitMask();
    });
    host.addEventListener('dragleave', (e) => {
        if (!host.contains(e.relatedTarget)) { hideSplitMask(); dropZone = null; }
    });
    host.addEventListener('drop', (e) => {
        if (dragTabId === null) return;
        e.preventDefault();
        e.stopPropagation();
        const dz = dropZone;
        hideSplitMask();
        dropZone = null;
        const srcId = dragTabId;
        dragTabId = null;
        dragTabGroupId = null;
        if (!dz) { renderTabs(); return; }
        try {
            performDrop(dz, srcId);
        } catch (err) {
            deps.flash('分栏失败：' + (err && err.message || err), true);
            renderTabs();
        }
    });
}

function ensureSplitMask() {
    let m = document.getElementById('split-mask');
    if (!m) {
        m = document.createElement('div');
        m.id = 'split-mask';
        deps.els.editorArea.appendChild(m);
    }
    return m;
}

function showSplitMask() {
    syncAllBrowserTabs();
    if (!dropZone) return;
    const area = deps.els.editorArea.getBoundingClientRect();
    const r = dropZone.rect;
    let mx = r.x, my = r.y, mw = r.w, mh = r.h;
    if (dropZone.zone === 'left' || dropZone.zone === 'right') mw = r.w / 2;
    if (dropZone.zone === 'right') mx = r.x + r.w / 2;
    if (dropZone.zone === 'top' || dropZone.zone === 'bottom') mh = r.h / 2;
    if (dropZone.zone === 'bottom') my = r.y + r.h / 2;
    const m = ensureSplitMask();
    m.style.left = Math.round(mx - area.x) + 'px';
    m.style.top = Math.round(my - area.y) + 'px';
    m.style.width = Math.round(mw) + 'px';
    m.style.height = Math.round(mh) + 'px';
    m.style.display = 'block';
}

function hideSplitMask() {
    const m = document.getElementById('split-mask');
    if (m) m.style.display = 'none';
    syncAllBrowserTabs();
}

function performDrop(dz, srcId) {
    const doc = deps.docs.find((d) => d.id === srcId);
    if (!doc) { renderTabs(); return; }
    const srcG = groupOfDoc(doc.id);
    if (!srcG) { renderTabs(); return; }
    if (dz.zone === 'center' || (srcG.id === dz.gid && srcG.docIds.length <= 1)) {
        activateDoc(doc);
        renderTabs();
        return;
    }
    const dir = (dz.zone === 'left' || dz.zone === 'right') ? 'col' : 'row';
    const side = (dz.zone === 'left' || dz.zone === 'top') ? 'before' : 'after';
    // 从源组移除
    srcG.docIds = srcG.docIds.filter((id) => id !== doc.id);
    if (srcG.activeId === doc.id) srcG.activeId = srcG.docIds[0] || null;
    removeGroupIfEmpty(srcG.id);
    // 目标组保留剩余文档，新组获得被拖文档
    const tg = groupById(dz.gid);
    if (!tg) { activateDoc(doc); renderTabs(); return; }
    tg.docIds = tg.docIds.filter((id) => id !== doc.id);
    if (tg.activeId === doc.id) tg.activeId = tg.docIds[0] || null;
    const ng = createGroup([doc.id]);
    ng.activeId = doc.id;
    // 单组尚未成树时以该组为根直接生成两层；已有树则替换对应叶子
    const base = splitRoot || dz.gid;
    splitRoot = (typeof base === 'string')
        ? { dir, ratio: 0.5, a: side === 'before' ? ng.id : base, b: side === 'before' ? base : ng.id }
        : splitReplaceLeaf(base, dz.gid, dir, side, ng.id);
    focusedGroupId = ng.id;
    renderTabs();
    activateDoc(doc);
}

function renderBreadcrumb(path) {
    deps.els.breadcrumb.textContent = '';
    if (!path) return;
    const parts = String(path).split(/[\\/]+/).filter(Boolean);
    let display = parts;
    if (parts.length > 6) {
        display = [parts[0], '…', ...parts.slice(-4)];
    }
    display.forEach((seg, i) => {
        if (i > 0) {
            const sep = document.createElement('span');
            sep.className = 'crumb-sep';
            sep.innerHTML = iconSvg('chevron-right', 10);
            deps.els.breadcrumb.appendChild(sep);
        }
        const s = document.createElement('span');
        s.className = 'crumb' + (i === display.length - 1 ? ' crumb-last' : '');
        s.textContent = seg;
        s.title = seg;
        deps.els.breadcrumb.appendChild(s);
    });
}

function treeHistory(action) {
    if (!deps.editor || !deps.editor.dom) return;
    const active = document.activeElement;
    if (active && deps.els.editor.contains(active) && active.blur) active.blur();
    const btn = deps.editor.dom[action];
    if (btn && !btn.disabled) btn.click();
}

function textArea() {
    if (!deps.editor) return null;
    if (deps.editor.textarea) return deps.editor.textarea;
    const pane = deps.file && deps.file.pane ? deps.file.pane : deps.els.editor;
    return pane.querySelector('textarea.jsoneditor-text');
}

function doUndo() {
    if (!deps.editor || deps.settings.readOnlyMode) return;
    if (deps.currentMode === 'tree') {
        const btn = deps.editor.dom && deps.editor.dom.undo;
        if (btn && !btn.disabled) { treeHistory('undo'); return; }
    } else if (deps.currentMode === 'table') {
        if (deps.file && deps.file.tableUndo && deps.file.tableUndo.length) { tableHistory('undo'); return; }
    } else if (deps.currentMode === 'code' && deps.editor.aceEditor) {
        const um = deps.editor.aceEditor.session.getUndoManager();
        if (um && um.hasUndo()) { deps.editor.aceEditor.execCommand('undo'); return; }
    } else if (deps.currentMode === 'text') {
        const ta = textArea();
        if (ta) {
            ta.focus();
            if (document.execCommand('undo')) return;
        }
    }
    // 操作栈为空但文件仍处于修改状态：Ctrl+Z 直接退回未修改（已保存）状态
    if (deps.file && deps.file.dirty) revertDocToSaved(deps.file);
}

// revertDocToSaved：把文档内容回退到最后一次保存（或打开/新建）时的状态
function revertDocToSaved(doc) {
    if (!doc || !doc.editor) return;
    const target = doc.savedText != null ? doc.savedText : (doc.content != null ? doc.content : '');
    let value = null;
    if (deps.currentMode === 'tree') {
        try { value = doc.format.parse(target); } catch (e) { deps.flash('无法回退：已保存内容解析失败', true); return; }
    }
    doc.loading = true;
    try {
        if (deps.currentMode === 'tree') deps.editor.set(value);
        else deps.editor.setText(target);
        doc.text = target;
        doc.bases[doc.mode] = target;
        doc.dirty = false;
        if (deps.file === doc) {
            deps.setDirty(false);
            updateStatus();
            deps.updateWindowTitle();
        }
        deps.updateTabDirty(doc);
        deps.updateBackendDirty();
        if (deps.currentMode === 'table') renderCsvTableView(doc);
    } finally {
        doc.loading = false;
    }
}

function doRedo() {
    if (!deps.editor || deps.settings.readOnlyMode) return;
    if (deps.currentMode === 'tree') treeHistory('redo');
    else if (deps.currentMode === 'table') tableHistory('redo');
    else if (deps.currentMode === 'code' && deps.editor.aceEditor) deps.editor.aceEditor.execCommand('redo');
    else if (deps.currentMode === 'text') {
        const ta = textArea();
        if (ta) {
            ta.focus();
            document.execCommand('redo');
        }
    }
}

function toggleFocusedNode(action) {
    const active = document.activeElement;
    if (!active || !deps.els.editor.contains(active)) return;
    const tr = active.closest('tr');
    if (!tr) return;
    const btn = tr.querySelector('button.jsoneditor-collapsed, button.jsoneditor-expanded');
    if (!btn) return;
    const collapsed = btn.classList.contains('jsoneditor-collapsed');
    if (action === 'expand' && collapsed) btn.click();
    if (action === 'collapse' && !collapsed) btn.click();
}

// ---- 状态栏「AI 写入」徽标 ----
// 由 ai-panel 的写操作事件驱动：每次落盘推一次状态，不轮询磁盘，
// 因此外部编辑器 / git 造成的改动不会点亮它。
// 显隐沿用状态栏既有做法（切换 display），自动隐藏时长与 flash() 的 5s 对齐。
const AI_WRITE_LABELS = {pending: '待确认', running: '写入中', done: '已修改', failed: '写入失败', denied: '被规则阻止'};
const AI_WRITE_TRANSIENT = new Set(['done', 'failed', 'denied']);
const AI_WRITE_HIDE_MS = 5000;
let aiWriteHideTimer = 0;

function hideAiWriteBadge() {
    if (aiWriteHideTimer) { clearTimeout(aiWriteHideTimer); aiWriteHideTimer = 0; }
    if (!deps.els.stAiWrite) return;
    deps.els.stAiWrite.style.display = 'none';
    deps.els.stAiWrite.classList.remove('pending', 'running', 'done', 'failed', 'denied');
}

function updateAiWriteBadge(payload) {
    const el = deps.els.stAiWrite;
    if (!el) return;
    if (aiWriteHideTimer) { clearTimeout(aiWriteHideTimer); aiWriteHideTimer = 0; }
    const state = payload && AI_WRITE_LABELS[payload.state] ? payload.state : 'idle';
    if (state === 'idle') {
        // 本轮结束不立刻抹掉「已修改」提示，交给瞬时态的自动隐藏计时器
        if (AI_WRITE_TRANSIENT.has(currentAiWriteState())) return;
        hideAiWriteBadge();
        return;
    }
    const label = AI_WRITE_LABELS[state];
    el.classList.remove('pending', 'running', 'done', 'failed', 'denied');
    el.classList.add(state);
    el.style.display = '';
    if (deps.els.stAwState) deps.els.stAwState.textContent = label;
    if (deps.els.stAwPath) deps.els.stAwPath.textContent = deps.baseNameOf(payload.relPath || payload.path);
    if (deps.els.stAwAdd) deps.els.stAwAdd.textContent = payload.added > 0 ? '+' + payload.added : '';
    if (deps.els.stAwDel) deps.els.stAwDel.textContent = payload.removed > 0 ? '−' + payload.removed : '';
    const counts = (payload.added || payload.removed) ? '（+' + (payload.added || 0) + ' −' + (payload.removed || 0) + '）' : '';
    el.title = label + counts + '\n' + (payload.path || payload.relPath || '');
    if (AI_WRITE_TRANSIENT.has(state)) {
        aiWriteHideTimer = setTimeout(() => { aiWriteHideTimer = 0; hideAiWriteBadge(); }, AI_WRITE_HIDE_MS);
    }
}

function currentAiWriteState() {
    const el = deps.els.stAiWrite;
    if (!el || el.style.display === 'none') return '';
    for (const state of Object.keys(AI_WRITE_LABELS)) {
        if (el.classList.contains(state)) return state;
    }
    return '';
}

function updateStatus() {
    if (deps.aiPanel && deps.aiPanel.refreshContext) {
        try { deps.aiPanel.refreshContext(); } catch (e) {}
    }
    if (!deps.file) return;
    deps.scheduleSessionSave();
    syncTabViewTools();
    const fmt = deps.file.format;
    const view = deps.file.splitActive ? deps.viewLabel('split') : deps.viewLabel(deps.file.sqlActive ? 'sql' : deps.currentMode);
    deps.els.stMode.textContent = deps.formatDisplayName(deps.file) + ' · ' + view + (deps.file.large || deps.file.binary || deps.settings.readOnlyMode ? ' · 只读' : '');
    if (deps.file.browser) {
        const url = String(deps.file.browserUrl || '');
        deps.els.stMode.textContent = '网页 · ' + (url === 'about:blank' ? '空白页' : (url.length > 60 ? url.slice(0, 60) + '…' : url));
        deps.els.stSize.textContent = '';
        deps.els.stZoom.textContent = '';
        deps.els.stMdWidth.style.display = 'none';
        deps.els.stEol.textContent = '';
        deps.els.stEnc.textContent = '';
        const stCount = document.getElementById('st-count');
        if (stCount) stCount.textContent = '';
        if (deps.els.stWriting) deps.els.stWriting.style.display = 'none';
        deps.els.stPos.textContent = '';
        return;
    }
    deps.els.stSize.textContent = deps.fmtSize(deps.file.size);
    deps.els.stSize.title = deps.file.image && deps.file.imageWidth ? deps.file.imageWidth + ' × ' + deps.file.imageHeight : '';
    const tableZoom = deps.currentMode === 'table' && deps.file.format && deps.file.format.table;
    const svgScale = deps.file.svgRenderScale && (deps.currentMode === 'render' || (deps.file.splitActive && deps.file.splitKind === 'svg'));
    const renderZoom = svgScale ? Math.round(deps.file.svgRenderScale * 100) + '%' : '';
    const zoom = deps.file.image && deps.currentMode === 'image' && deps.file.imageScale
        ? Math.round(deps.file.imageScale * 100) + '%'
        : renderZoom || (tableZoom ? Math.round((deps.file.tableZoom || 1) * 100) + '%' : '');
    deps.els.stZoom.textContent = zoom;
    deps.els.stZoom.title = zoom
        ? (tableZoom ? '表格缩放比例（点击选择，Ctrl+滚轮调整）' : '图片缩放比例（点击选择，Ctrl+滚轮调整，双击图片恢复适配）')
        : '';
    const showMdWidth = !!(deps.file.format && deps.file.format.preview && deps.currentMode === 'preview' && !deps.file.large);
    deps.els.stMdWidth.style.display = showMdWidth ? '' : 'none';
    deps.els.stMdWidth.textContent = showMdWidth ? '宽度 · ' + deps.mdPreviewWidthLabel(deps.settings.mdPreviewWidth) : '';
    deps.updateWordCount();
    deps.updateWritingStats();
    deps.applyWritingMode();
    if (deps.file.binary) {
        deps.els.stEol.textContent = '';
        deps.els.stEnc.textContent = '';
        deps.els.stEol.style.display = 'none';
        deps.els.stEnc.style.display = 'none';
        deps.scheduleCursorPosition();
        return;
    }
    deps.els.stEol.style.display = '';
    deps.els.stEnc.style.display = '';
    const eolSetting = fmt ? deps.getFormatSettings(fmt.id).eol : 'follow';
    deps.els.stEol.textContent = (eolSetting === 'follow' ? deps.file.eol : eolSetting).toUpperCase();
    const enc = (deps.file.enc || 'utf-8').toUpperCase();
    deps.els.stEnc.textContent = enc + (deps.file.hasBom && enc === 'UTF-8' ? ' BOM' : '');
    deps.scheduleCursorPosition();
    if (typeof deps.scheduleStructureRefresh === 'function') deps.scheduleStructureRefresh(deps.file);
}

function hideBanner() {
    deps.els.banner.classList.add('hidden');
}

function dismissBanner() {
    if (deps.file) deps.file.bannerDismissed = true;
    hideBanner();
}

function showBanner(data, parseError) {
    if (!data || data.bannerDismissed || !deps.settings.showBanners) {
        hideBanner();
        return;
    }
    if (data.binary) {
        if (data.image && data.mode === 'image') {
            hideBanner();
            return;
        }
        const shown = data.hexShown || data.size;
        const truncated = shown < data.size;
        deps.els.bannerText.textContent = '二进制文件 · ' + data.name + '（' + deps.fmtSize(data.size) + '）：下方从第 0 字节开始，以十六进制字节数据只读展示' +
            (truncated ? '，仅显示前 ' + deps.fmtSize(shown) : '') + '。';
        deps.els.banner.classList.remove('hidden');
    } else if (data.large) {
        deps.els.bannerText.textContent = '大文件（' + deps.fmtSize(data.size) + '）：已切换为只读代码模式，不可编辑保存。';
        deps.els.banner.classList.remove('hidden');
    } else if (parseError) {
        deps.els.bannerText.textContent = data.format.name + ' 解析失败：' + parseError.message + '。已用代码模式打开，可手动修复后保存。';
        deps.els.banner.classList.remove('hidden');
    } else {
        hideBanner();
    }
}

function foldDomCount(el) {
    const raw = el.textContent.trim();
    const exact = raw.match(/^[[{]\s*(\d+)\s*[\]}]$/);
    if (exact) return Number(exact[1]);
    const loose = raw.match(/[[{]\s*(\d+)/);
    if (loose) return Number(loose[1]);
    if (el.dataset.count != null) return Number(el.dataset.count);
    return null;
}

function foldValueAtPath(root, path) {
    let value = root;
    for (const segment of path) {
        if (value == null) return undefined;
        if (Array.isArray(value)) value = value[Number(segment)];
        else if (typeof value === 'object') value = value[segment];
        else return undefined;
    }
    return value;
}

function foldRowPaths(tbody) {
    const paths = new Map();
    const stack = [];
    for (const tr of tbody.children) {
        if (!tr || tr.tagName !== 'TR') continue;
        const table = tr.querySelector('table.jsoneditor-values');
        const keyEl = table ? table.querySelector('.jsoneditor-field, .jsoneditor-readonly') : null;
        if (!keyEl) continue;
        const key = keyEl.textContent.trim();
        if (!key) continue;
        const margin = table ? parseInt(table.style.marginLeft || '0', 10) : 0;
        const depth = Math.max(0, Math.round(margin / 24));
        if (depth === 0) {
            stack.length = 0;
            stack[0] = null;
        } else {
            stack.length = depth;
            stack[depth] = key;
        }
        paths.set(tr, stack.slice(1, depth + 1));
    }
    return paths;
}

function foldPrimitive(value) {
    if (typeof value === 'string') return JSON.stringify(value);
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return '[...]';
    if (typeof value === 'object') return '{...}';
    return String(value);
}

function clipFoldText(text, max) {
    if (text.length <= max) return text;
    return text.slice(0, max) + (text.startsWith('"') ? '"' : '');
}

function foldObjectSpec(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    if (!keys.length) return {kind: 'empty'};
    const keyText = clipFoldText(JSON.stringify(keys[0]), 36);
    return {
        kind: 'object',
        keyText,
        valueText: clipFoldText(foldPrimitive(value[keys[0]]), 30),
    };
}

function foldSpan(parent, text, className) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    parent.appendChild(span);
}

function renderFoldPreview(el, sig, build) {
    if (el.dataset.foldSig === sig && el.querySelector('.jsoneditor-fold-preview')) return;
    el.textContent = '';
    const wrap = document.createElement('span');
    wrap.className = 'jsoneditor-fold-preview';
    build(wrap);
    el.appendChild(wrap);
    el.dataset.foldSig = sig;
}

function humanizeCounts() {
    if (!deps.editor || deps.currentMode !== 'tree') return;
    const root = deps.file && deps.file.pane ? deps.file.pane : deps.els.editor;
    const nodes = root.querySelectorAll('div.jsoneditor-value.jsoneditor-object, div.jsoneditor-value.jsoneditor-array');
    const pathMaps = new WeakMap();
    let rootValue;
    let rootLoaded = false;
    const rootData = () => {
        if (!rootLoaded) {
            try {
                rootValue = deps.editor.get();
            } catch (e) {
                rootValue = undefined;
            }
            rootLoaded = true;
        }
        return rootValue;
    };
    nodes.forEach((el) => {
        const isObject = el.classList.contains('jsoneditor-object');
        const collapsed = !!el.closest('tr.jsoneditor-collapsed');
        const row = el.closest('tr.jsoneditor-expandable');
        let path = null;
        if (row && row.parentElement) {
            if (!pathMaps.has(row.parentElement)) pathMaps.set(row.parentElement, foldRowPaths(row.parentElement));
            const map = pathMaps.get(row.parentElement);
            if (map.has(row)) path = map.get(row);
        }
        const value = path ? foldValueAtPath(rootData(), path) : undefined;
        let count = foldDomCount(el);
        if (isObject && value && typeof value === 'object' && !Array.isArray(value)) count = Object.keys(value).length;
        else if (!isObject && Array.isArray(value)) count = value.length;
        if (!Number.isFinite(count)) return;
        el.dataset.count = String(count);
        if (collapsed) {
            if (isObject) {
                const spec = foldObjectSpec(value);
                if (spec && spec.kind === 'empty') {
                    renderFoldPreview(el, 'o:empty', (wrap) => foldSpan(wrap, '{}', 'jsoneditor-fold-text'));
                } else if (spec) {
                    renderFoldPreview(el, 'o:' + JSON.stringify(spec), (wrap) => {
                        foldSpan(wrap, '{', 'jsoneditor-fold-text');
                        foldSpan(wrap, spec.keyText, 'jsoneditor-fold-text');
                        foldSpan(wrap, ': ', 'jsoneditor-fold-text');
                        foldSpan(wrap, spec.valueText, 'jsoneditor-fold-text');
                        foldSpan(wrap, '...', 'jsoneditor-fold-text');
                        foldSpan(wrap, '}', 'jsoneditor-fold-text');
                    });
                } else {
                    renderFoldPreview(el, 'of:' + count, (wrap) => {
                        foldSpan(wrap, '{' + count + ' 项}', 'jsoneditor-fold-text');
                    });
                }
            } else if (count === 0) {
                renderFoldPreview(el, 'a:0', (wrap) => foldSpan(wrap, '[]', 'jsoneditor-fold-text'));
            } else {
                renderFoldPreview(el, 'a:' + count, (wrap) => {
                    foldSpan(wrap, '[ ', 'jsoneditor-fold-text');
                    foldSpan(wrap, count + ' 个元素', 'jsoneditor-fold-text');
                    foldSpan(wrap, '... ]', 'jsoneditor-fold-text');
                });
            }
            el.removeAttribute('title');
        } else {
            const text = deps.settings.treeCounts ? count + ' 项' : '';
            if (el.textContent !== text || el.querySelector('.jsoneditor-fold-preview')) el.textContent = text;
            el.dataset.foldSig = 'e:' + count + ':' + (deps.settings.treeCounts ? '1' : '0');
            el.title = deps.settings.treeCounts ? (isObject ? '对象' : '数组') + '，共 ' + count + ' 项' : '';
        }
        el.classList.toggle('value-fold', collapsed);
        el.classList.toggle('value-count', !collapsed && !!deps.settings.treeCounts);
    });
}

let countQueued = false;
const countObserver = new MutationObserver(() => {
    if (countQueued) return;
    countQueued = true;
    queueMicrotask(() => {
        countQueued = false;
        humanizeCounts();
    });
});
countObserver.observe(deps.els.editor, {childList: true, subtree: true, characterData: true});

function applyAceMode(force) {
    if (!force && (deps.currentMode !== 'code' && deps.currentMode !== 'binary')) return;
    if (!deps.editor || !deps.editor.aceEditor) return;
    const want = aceModeFor(deps.file && deps.file.name, deps.file && deps.file.format);
    try {
        if (deps.editor.aceEditor.session.getMode().$id !== want) {
            deps.editor.aceEditor.session.setMode(want);
        }
        const container = deps.editor.aceEditor.container;
        for (const cls of Array.from(container.classList)) {
            if (cls.startsWith('ace-mode-')) container.classList.remove(cls);
        }
        container.classList.add('ace-mode-' + want.split('/').pop());
        const pureJson = !!(deps.file && deps.file.format && deps.file.format.id === 'json' && /\.json$/i.test(deps.file.name || ''));
        deps.editor.aceEditor.session.setUseWorker(pureJson);
        // 关闭 worker 后旧 JSON 校验注解不会自动消失（切到 Markdown 等模式仍留红叉）
        if (!pureJson) {
            try { deps.editor.aceEditor.session.clearAnnotations(); } catch (e) {}
        }
        deps.editor.aceEditor.setReadOnly(!!(deps.file && (deps.file.large || deps.file.binary)) || !!deps.settings.readOnlyMode);
        deps.editor.aceEditor.setFontSize(deps.settings.editorFont);
        deps.editor.aceEditor.session.setUseWrapMode(!!deps.settings.codeWrap);
        if (deps.file && deps.file.format) {
            const fs = deps.getFormatSettings(deps.file.format.id);
            const tab = fs.indent === 'tab';
            deps.editor.aceEditor.session.setUseSoftTabs(!tab);
            deps.editor.aceEditor.session.setTabSize(tab ? 4 : Number(fs.indent));
        }
        deps.editor.aceEditor.setDisplayIndentGuides(!!deps.settings.codeGuides);
        deps.editor.aceEditor.setHighlightIndentGuides(!!deps.settings.codeGuides);
        hookCodeFoldPreviews(deps.editor.aceEditor);
        hookMultiCursor(deps.editor.aceEditor);
        hookPythonTokenClasses(deps.editor.aceEditor);
        hookCursorTracking(deps.editor.aceEditor);
        updateCodeFoldPreviews(deps.editor.aceEditor);
    } catch (e) {
        console.warn('ace mode switch failed', e);
    }
}

const codeFoldLanguages = {
    json: 'json', json5: 'json', jsonl: 'json',
    yaml: 'yaml', xml: 'xml', html: 'xml', css: 'css',
    javascript: 'javascript', typescript: 'typescript',
    markdown: 'markdown', python: 'python', sh: 'bash', bash: 'bash',
    batchfile: 'dos', powershell: 'powershell', golang: 'go', go: 'go',
    java: 'java', kotlin: 'kotlin', lua: 'lua', sql: 'sql',
    toml: 'ini', ini: 'ini', properties: 'ini', text: 'plaintext',
};

let codeFoldHoverEl = null;
let codeFoldHoverGutter = null;
let codeFoldHoverCode = null;
let codeFoldHoverShowTimer = 0;
let codeFoldHoverHideTimer = 0;
let codeFoldHoverTarget = null;

function ensureCodeFoldHover() {
    if (codeFoldHoverEl) return codeFoldHoverEl;
    codeFoldHoverEl = document.createElement('div');
    codeFoldHoverEl.id = 'code-fold-hover';
    codeFoldHoverEl.className = 'hidden';
    codeFoldHoverGutter = document.createElement('pre');
    codeFoldHoverGutter.className = 'code-fold-gutter';
    codeFoldHoverCode = document.createElement('pre');
    codeFoldHoverCode.className = 'code-fold-code';
    codeFoldHoverEl.append(codeFoldHoverGutter, codeFoldHoverCode);
    codeFoldHoverEl.addEventListener('mouseenter', () => {
        clearTimeout(codeFoldHoverHideTimer);
    });
    codeFoldHoverEl.addEventListener('mouseleave', () => {
        codeFoldHoverHideTimer = setTimeout(hideCodeFoldHover, 120);
    });
    document.body.appendChild(codeFoldHoverEl);
    return codeFoldHoverEl;
}

function hideCodeFoldHover() {
    clearTimeout(codeFoldHoverShowTimer);
    clearTimeout(codeFoldHoverHideTimer);
    codeFoldHoverTarget = null;
    if (codeFoldHoverEl) codeFoldHoverEl.classList.add('hidden');
}

function codeFoldLineFromEvent(e) {
    const target = e.target;
    if (!target || !target.closest) return null;
    const line = target.closest('.ace_line');
    if (!line || !line.querySelector('.ace_fold')) return null;
    const ace = deps.editor && deps.editor.aceEditor;
    if (!ace || !ace.container.contains(line)) return null;
    return line;
}

function codeFoldForLine(lineEl) {
    const ace = deps.editor && deps.editor.aceEditor;
    if (!ace || !lineEl || !ace.container.contains(lineEl)) return null;
    let row = null;
    try {
        const rect = lineEl.getBoundingClientRect();
        const position = ace.renderer.screenToTextCoordinates(rect.left + 1, rect.top + rect.height / 2);
        row = position.row;
    } catch (e) {
        return null;
    }
    const folds = ace.session.getAllFolds();
    const starts = folds.filter((fold) => fold.range && fold.range.start && fold.range.start.row === row);
    if (starts.length) {
        starts.sort((left, right) => right.range.end.row - left.range.end.row);
        return {ace, fold: starts[0]};
    }
    const containing = folds.find((fold) => fold.range && row >= fold.range.start.row && row <= fold.range.end.row);
    return containing ? {ace, fold: containing} : null;
}

function codeFoldLanguage(session) {
    const id = session && session.getMode ? String(session.getMode().$id || '').split('/').pop() : '';
    return codeFoldLanguages[id] || 'plaintext';
}

function clipCodeFoldPreview(text, max) {
    const compact = String(text || '').replace(/\s+/g, ' ').trim();
    return compact.length > max ? compact.slice(0, max) : compact;
}

function codeFoldDisplayWidth(text) {
    let width = 0;
    for (const ch of String(text)) {
        width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
    }
    return width;
}

function clipCodeFoldText(text, maxWidth) {
    const raw = String(text == null ? '' : text);
    if (codeFoldDisplayWidth(raw) <= maxWidth) return raw;
    let out = '';
    let width = 0;
    for (const ch of raw) {
        const chWidth = codeFoldDisplayWidth(ch);
        if (width + chWidth > maxWidth) break;
        out += ch;
        width += chWidth;
    }
    return out + (raw.startsWith('"') ? '"' : '');
}

function codeFoldPreviewFor(ace, fold) {
    // JetBrains 风格：折叠后把块内容压成一行内联显示，括号保留在外面
    const inner = (ace.session.getTextRange(fold.range) || '').trim();
    if (!inner) return '';
    const flat = inner.replace(/\s+/g, ' ');
    const clipped = clipCodeFoldText(flat, 120);
    return clipped === flat ? flat : clipped + ' …';
}

function updateCodeFoldPreviews(ace) {
    if (!ace || !ace.session || !ace.session.getAllFolds) return;
    const folds = ace.session.getAllFolds();
    if (!folds.length) return;
    let changed = false;
    for (const fold of folds) {
        let preview = '';
        try {
            preview = codeFoldPreviewFor(ace, fold);
        } catch (e) {
            continue;
        }
        if (fold.placeholder !== preview) {
            fold.placeholder = preview;
            changed = true;
        }
    }
    if (changed) {
        try {
            ace.renderer.updateFull(true);
        } catch (e) {
            ace.renderer.updateFull();
        }
    }
}

function hookCodeFoldPreviews(ace) {
    if (!ace || ace._foldPreviewHooked) return;
    ace._foldPreviewHooked = true;
    const schedule = () => {
        clearTimeout(ace._foldPreviewTimer);
        ace._foldPreviewTimer = setTimeout(() => {
            ace._foldPreviewTimer = 0;
            updateCodeFoldPreviews(ace);
        }, 40);
    };
    ace.session.on('changeFold', () => updateCodeFoldPreviews(ace));
    ace.session.on('change', schedule);
}

// ---- 行书签：F11 切换光标行书签，F2/Shift+F2 循环跳转，gutter 紫色标记 ----

function bookmarkRowsForDoc(doc) {
    if (!doc || !doc.editor || !doc.editor.aceEditor) return [];
    try {
        return [...(doc.bookmarks || [])].sort((a, b) => a - b);
    } catch (e) {
        return [];
    }
}

function renderBookmarks(doc) {
    const ace = doc && doc.editor && doc.editor.aceEditor;
    if (!ace) return;
    if (doc.bmApplied) {
        for (const [row, cls] of doc.bmApplied) {
            try { ace.session.removeGutterDecoration(row, cls); } catch (e) {}
        }
    }
    const list = [];
    const rows = bookmarkRowsForDoc(doc);
    let lineCount = 0;
    try { lineCount = ace.session.getLength(); } catch (e) { lineCount = 0; }
    for (const row of rows) {
        if (!(row >= 0) || row >= lineCount) continue;
        try {
            ace.session.addGutterDecoration(row, 'bm-gutter');
            list.push([row, 'bm-gutter']);
        } catch (e) {}
    }
    doc.bmApplied = list;
}

function toggleBookmark() {
    const ace = deps.file && deps.file.editor && deps.file.editor.aceEditor;
    if (!ace) {
        deps.flash('书签仅在代码/文本视图可用', true);
        return;
    }
    if (!deps.file.bookmarks) deps.file.bookmarks = new Set();
    const row = ace.getCursorPosition().row;
    if (deps.file.bookmarks.has(row)) {
        deps.file.bookmarks.delete(row);
        deps.flash('已移除书签：' + (row + 1) + ' 行');
    } else {
        deps.file.bookmarks.add(row);
        deps.flash('已添加书签：' + (row + 1) + ' 行');
    }
    renderBookmarks(deps.file);
}

function jumpBookmark(delta) {
    const ace = deps.file && deps.file.editor && deps.file.editor.aceEditor;
    if (!ace) {
        deps.flash('书签仅在代码/文本视图可用', true);
        return;
    }
    const rows = bookmarkRowsForDoc(deps.file);
    if (!rows.length) {
        deps.flash('当前文件还没有书签（F11 在光标行添加）', true);
        return;
    }
    const cur = ace.getCursorPosition().row;
    let target = null;
    if (delta > 0) target = rows.find((r) => r > cur);
    else {
        for (let i = rows.length - 1; i >= 0; i--) {
            if (rows[i] < cur) { target = rows[i]; break; }
        }
        if (target == null) target = rows[rows.length - 1];
    }
    if (target == null) target = rows[0];
    deps.jumpToPosition(target + 1, 1);
}

// ---- 视图状态：光标/滚动/折叠/书签随会话保存 ----

function captureDocView(doc) {
    const ace = doc && doc.editor && doc.editor.aceEditor;
    if (!ace) return null;
    const view = {};
    try {
        const pos = ace.getCursorPosition();
        view.cursor = [pos.row, pos.column];
    } catch (e) {}
    try { view.scrollTop = Math.max(0, Math.round(ace.session.getScrollTop() || 0)); } catch (e) {}
    try {
        const folds = typeof ace.session.getAllFolds === 'function' ? ace.session.getAllFolds() : [];
        const ranges = [];
        for (const fold of folds || []) {
            const start = fold && fold.start ? fold.start.row : -1;
            const end = fold && fold.end ? fold.end.row : -1;
            if (start >= 0 && end > start) ranges.push([start, end]);
            if (ranges.length >= 500) break;
        }
        if (ranges.length) view.folds = ranges;
    } catch (e) {}
    const marks = bookmarkRowsForDoc(doc);
    if (marks.length) view.bookmarks = marks.slice(0, 500);
    if (!view.cursor && !view.scrollTop && !view.folds && !view.bookmarks) return null;
    return view;
}

function applyDocView(doc, view) {
    if (!doc || !view) return false;
    if (Array.isArray(view.bookmarks)) {
        doc.bookmarks = new Set(view.bookmarks.filter((n) => Number.isInteger(n) && n >= 0));
    }
    const ace = doc.editor && doc.editor.aceEditor;
    if (!ace) return false;
    renderBookmarks(doc);
    try {
        const Range = ace.Range || (ace.require && ace.require('ace/range').Range) ||
            (window.ace && window.ace.require ? window.ace.require('ace/range').Range : null);
        if (Range && Array.isArray(view.folds)) {
            const lineCount = ace.session.getLength();
            for (const pair of view.folds) {
                const start = Number(pair && pair[0]);
                const end = Number(pair && pair[1]);
                if (!(start >= 0) || !(end > start) || start >= lineCount) continue;
                try { ace.session.addFold('', new Range(start, 0, Math.min(end, lineCount - 1), Infinity)); } catch (e) {}
            }
        }
    } catch (e) {}
    try {
        if (Array.isArray(view.cursor)) {
            const lineCount = Math.max(1, ace.session.getLength());
            const row = Math.max(0, Math.min(lineCount - 1, Number(view.cursor[0]) || 0));
            const col = Math.max(0, Number(view.cursor[1]) || 0);
            ace.clearSelection();
            ace.moveCursorTo(row, col);
        }
    } catch (e) {}
    try {
        if (Number.isFinite(view.scrollTop)) ace.session.setScrollTop(view.scrollTop);
    } catch (e) {}
    return true;
}

function applyPendingDocView(doc) {
    if (!doc || !doc.path) return;
    const key = deps.sessionPathKey(doc.path);
    const view = deps.pendingDocViews.get(key);
    if (!view) return;
    deps.pendingDocViews.delete(key);
    applyDocView(doc, view);
}

function rememberDocView(doc) {
    if (!doc || !doc.path) return;
    const key = deps.sessionPathKey(doc.path);
    const view = captureDocView(doc) || deps.knownDocViews.get(key);
    if (view) deps.knownDocViews.set(key, view);
}

// ---- Git 行级标记：代码视图行号左侧色条（JetBrains 风格） ----
// 绿=新增、蓝=修改、灰点=此处上方有删除的行。数据来自 git diff HEAD（未保存内容不参与）。

const GIT_GUTTER_ADD = 'git-gutter-add';
const GIT_GUTTER_MOD = 'git-gutter-mod';
const GIT_GUTTER_DEL = 'git-gutter-del';

function renderGitGutter(doc) {
    const ace = doc && doc.editor && doc.editor.aceEditor;
    if (!ace) return;
    if (doc.gitGutterApplied) {
        for (const [row, cls] of doc.gitGutterApplied) {
            try { ace.session.removeGutterDecoration(row, cls); } catch (e) {}
        }
    }
    const list = [];
    const marks = doc.gitGutterData;
    if (marks) {
        let lineCount = 0;
        try { lineCount = ace.session.getLength(); } catch (e) { lineCount = 0; }
        const put = (row, cls) => {
            if (!(row >= 0) || row >= lineCount) return;
            try {
                ace.session.addGutterDecoration(row, cls);
                list.push([row, cls]);
            } catch (e) {}
        };
        for (const row of marks.added) put(row, GIT_GUTTER_ADD);
        for (const row of marks.modified) put(row, GIT_GUTTER_MOD);
        for (const row of marks.delBefore) put(row, GIT_GUTTER_DEL);
    }
    doc.gitGutterApplied = list;
}

function clearGitGutterData(doc) {
    doc.gitGutterData = null;
    renderGitGutter(doc);
}

// scheduleGitGutter 按需取 git diff 并刷新标记；900ms 防抖，状态机见 refreshGitStatus。
function scheduleGitGutter(doc, delay) {
    if (!doc || !doc.path || doc.large || !deps.gitStateCache.available || !deps.gitStateCache.dir) return;
    const key = doc.path.replace(/\\/g, '/');
    const st = deps.gitStateCache.map.get(key);
    if (!st || st === 'untracked') {
        // 无变更或未跟踪：清掉旧标记即可，不用对比
        if (doc.gitGutterData) clearGitGutterData(doc);
        return;
    }
    clearTimeout(doc.gitGutterTimer);
    doc.gitGutterTimer = setTimeout(async () => {
        doc.gitGutterTimer = 0;
        if (!deps.docs.includes(doc) || !doc.path || doc.large || !doc.editor) return;
        if (!deps.gitStateCache.available || !deps.gitStateCache.dir) return;
        if (!deps.backend.GitLineMarksFor) return;
        let text = '';
        try { text = doc.editor.getText(); } catch (e) { return; }
        try {
            // 直接对比 HEAD 与编辑器当前内容：未保存的输入也实时参与
            doc.gitGutterData = await deps.backend.GitLineMarksFor(deps.gitStateCache.dir, doc.path, text);
        } catch (e) {
            doc.gitGutterData = null;
        }
        renderGitGutter(doc);
    }, delay || 900);
}

// 多光标：Alt+单击添加光标；中键拖动建立列光标/矩形选区；普通单击回到单光标
function hookMultiCursor(ace) {
    if (!ace || ace._multiCursorHooked || !ace.container) return;
    ace._multiCursorHooked = true;
    try { ace.setOption('enableMultiselect', true); } catch (e) {}

    const pointAt = (e) => {
        try { return ace.renderer.screenToTextCoordinates(e.clientX, e.clientY); } catch (err) { return null; }
    };
    const rangeFor = (start, end) => {
        const range = ace.selection.getRange().clone();
        range.start = {row: start.row, column: start.column};
        range.end = {row: end.row, column: end.column};
        range.cursor = range.end;
        return range;
    };
    const refresh = () => {
        ace.renderer.updateCursor();
        ace.renderer.updateBackMarkers();
    };
    const applyRanges = (ranges) => {
        if (!ranges || !ranges.length) return;
        ace.selection.toSingleRange(ranges[0]);
        for (let i = 1; i < ranges.length; i++) ace.selection.addRange(ranges[i], true);
        refresh();
    };

    let drag = null;
    const onDragMove = (e) => {
        if (!drag) return;
        e.preventDefault();
        const end = pointAt(e);
        if (!end) return;
        const from = ace.session.documentToScreenPosition(drag.start);
        const to = ace.session.documentToScreenPosition(end);
        let ranges = [];
        try { ranges = ace.selection.rectangularRangeBlock(from, to) || []; } catch (err) {}
        applyRanges(ranges);
        ace.renderer.scrollCursorIntoView(end, 0.15);
    };
    const onDragEnd = (e) => {
        if (!drag) return;
        drag = null;
        e.preventDefault();
        e.stopPropagation();
        window.removeEventListener('mousemove', onDragMove, true);
        window.removeEventListener('mouseup', onDragEnd, true);
    };

    ace.container.addEventListener('mousedown', (e) => {
        if (e.target.closest && e.target.closest('.ace_gutter')) return;
        const altAdd = e.button === 0 && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey;
        const middle = e.button === 1;
        if (!altAdd && !middle) return;
        const pos = pointAt(e);
        if (!pos) return;
        e.preventDefault();
        e.stopPropagation();
        ace.focus();
        if (altAdd) {
            ace.selection.addRange(rangeFor(pos, pos));
            refresh();
            return;
        }
        ace.selection.toSingleRange(rangeFor(pos, pos));
        drag = {start: pos};
        refresh();
        window.addEventListener('mousemove', onDragMove, true);
        window.addEventListener('mouseup', onDragEnd, true);
    }, true);
    ace.container.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);
}

function hookCursorTracking(ace) {
    if (!ace || ace._cursorTracked) return;
    ace._cursorTracked = true;
    const update = () => {
        if (deps.file && deps.currentMode === 'code' && deps.file.editor && deps.file.editor.aceEditor === ace) {
            deps.updateCursorPosition();
            if (deps.structurePanel) deps.structurePanel.setCursor(ace.getCursorPosition().row + 1);
        }
    };
    try {
        ace.selection.on('changeCursor', update);
        ace.on('focus', update);
    } catch (e) {}
}

function applyPythonTokenClasses(ace) {
    if (!ace || !ace.container || !ace.container.classList.contains('ace-mode-python')) return;
    const layer = ace.container.querySelector('.ace_text-layer');
    if (!layer) return;
    for (const el of layer.querySelectorAll('.py-kwarg, .py-builtin, .py-doc')) el.classList.remove('py-kwarg', 'py-builtin', 'py-doc');
    for (const line of layer.querySelectorAll('.ace_line')) {
        const spans = [...line.children];
        let depth = 0;
        let isDefinition = false;
        for (const span of spans) {
            if (span.classList.contains('ace_keyword') && /^(def|class)$/.test(span.textContent || '')) isDefinition = true;
        }
        if (isDefinition) continue;
        // 双下划线预定义名（__name__/__file__…）→ 内置名紫色（PyCharm PY.BUILTIN_NAME）
        for (const span of spans) {
            if (span.classList.contains('ace_identifier') && /^__\w+__$/.test((span.textContent || '').trim())) {
                span.classList.add('py-builtin');
            }
        }
        // 整行都是字符串 → 三引号 docstring（PyCharm 文档字符串：弱绿斜体）
        const nonEmpty = spans.filter((sp) => (sp.textContent || '').trim());
        if (nonEmpty.length && nonEmpty.every((sp) => sp.classList.contains('ace_string'))) {
            for (const sp of nonEmpty) sp.classList.add('py-doc');
        }
        for (let i = 0; i < spans.length; i++) {
            const span = spans[i];
            const text = span.textContent || '';
            for (const ch of text) {
                if (ch === '(') depth++;
                else if (ch === ')') depth = Math.max(0, depth - 1);
            }
            if (depth <= 0 || !span.classList.contains('ace_identifier')) continue;
            const next = spans[i + 1];
            if (next && next.classList.contains('ace_keyword') && next.classList.contains('ace_operator') && next.textContent === '=') {
                span.classList.add('py-kwarg');
            }
        }
    }
}

function hookPythonTokenClasses(ace) {
    if (!ace || ace._pythonTokenHooked) return;
    const layer = ace.container && ace.container.querySelector('.ace_text-layer');
    if (!layer) return;
    ace._pythonTokenHooked = true;
    let timer = 0;
    const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            timer = 0;
            applyPythonTokenClasses(ace);
        }, 30);
    };
    new MutationObserver(schedule).observe(layer, {childList: true, subtree: true});
    try {
        ace.renderer.on('afterRender', schedule);
    } catch (e) {}
    schedule();
}

function showCodeFoldHover(lineEl) {
    const found = codeFoldForLine(lineEl);
    if (!found) return;
    const {ace, fold} = found;
    const start = fold.range.start.row;
    const end = fold.range.end.row;
    let lines = ace.session.getLines(start, end);
    const truncated = lines.length > 200;
    if (truncated) lines = lines.slice(0, 200);
    let text = lines.join('\n');
    if (truncated) text += '\n…';
    const gutterText = Array.from({length: lines.length}, (_, index) => String(start + 1 + index)).join('\n');
    ensureCodeFoldHover();
    codeFoldHoverGutter.textContent = gutterText;
    const language = codeFoldLanguage(ace.session);
    let highlighted = '';
    try {
        if (hljs.getLanguage(language)) highlighted = hljs.highlight(text, {language}).value;
    } catch (e) {}
    if (highlighted) codeFoldHoverCode.innerHTML = highlighted;
    else codeFoldHoverCode.textContent = text;
    codeFoldHoverEl.scrollTop = 0;
    codeFoldHoverEl.scrollLeft = 0;
    codeFoldHoverEl.style.visibility = 'hidden';
    codeFoldHoverEl.style.left = '0px';
    codeFoldHoverEl.style.top = '0px';
    codeFoldHoverEl.classList.remove('hidden');
    const width = codeFoldHoverEl.offsetWidth;
    const height = codeFoldHoverEl.offsetHeight;
    const rect = lineEl.getBoundingClientRect();
    const margin = 8;
    let left = Math.min(rect.left, window.innerWidth - width - margin);
    left = Math.max(margin, left);
    let top = rect.bottom + 4;
    if (top + height > window.innerHeight - margin) top = rect.top - height - 4;
    top = Math.max(margin, top);
    codeFoldHoverEl.style.left = left + 'px';
    codeFoldHoverEl.style.top = top + 'px';
    codeFoldHoverEl.style.visibility = '';
    codeFoldHoverTarget = lineEl;
}

function initCodeFoldHover() {
    if (!deps.els.editor) return;
    ensureCodeFoldHover();
    deps.els.editor.addEventListener('mouseover', (e) => {
        const line = codeFoldLineFromEvent(e);
        if (!line || line === codeFoldHoverTarget) return;
        if (!codeFoldForLine(line)) return;
        codeFoldHoverTarget = line;
        clearTimeout(codeFoldHoverShowTimer);
        clearTimeout(codeFoldHoverHideTimer);
        if (codeFoldHoverEl) codeFoldHoverEl.classList.add('hidden');
        codeFoldHoverShowTimer = setTimeout(() => showCodeFoldHover(line), 280);
    });
    deps.els.editor.addEventListener('mouseout', (e) => {
        const line = codeFoldLineFromEvent(e);
        const related = e.relatedTarget;
        if (related && ((line && line.contains(related)) || (codeFoldHoverEl && codeFoldHoverEl.contains(related)))) return;
        if (!codeFoldHoverTarget) return;
        if (line && line !== codeFoldHoverTarget) return;
        clearTimeout(codeFoldHoverShowTimer);
        codeFoldHoverHideTimer = setTimeout(hideCodeFoldHover, 140);
    });
    document.addEventListener('pointerdown', (e) => {
        if (codeFoldHoverEl && e.target && codeFoldHoverEl.contains(e.target)) return;
        hideCodeFoldHover();
    }, true);
    window.addEventListener('scroll', (e) => {
        if (codeFoldHoverEl && e.target && codeFoldHoverEl.contains(e.target)) return;
        hideCodeFoldHover();
    }, true);
    window.addEventListener('resize', hideCodeFoldHover);
    window.addEventListener('blur', hideCodeFoldHover);
}

function snapshotActiveDoc() {
    if (!deps.file || !deps.editor) return;
    deps.file.text = deps.editor.getText();
    deps.file.mode = deps.currentMode;
    deps.file.dirty = deps.dirty;
    if (deps.file.splitActive && deps.file.htmlFrame) deps.file.htmlFrame.srcdoc = '';
}

function markDocDirty(doc) {
    if (!doc || !doc.editor) return;
    const text = doc.editor.getText();
    doc.text = text;
    const base = doc.bases[doc.mode];
    const next = doc.untitled ? true : (base == null ? true : text !== base);
    if (deps.file === doc) {
        deps.setDirty(next);
    } else {
        doc.dirty = next;
        deps.updateTabDirty(doc);
        deps.updateBackendDirty();
    }
    if (typeof deps.scheduleStructureRefresh === 'function') {
        doc.structureRev = (doc.structureRev || 0) + 1;
        deps.scheduleStructureRefresh(doc);
    }
    if (doc.splitActive) scheduleSplitPreview(doc);
    scheduleGitGutter(doc);
}

// ---- 浏览器使用标签页：内容区内嵌 WebView2（browser-use） ----

// 地址栏目标解析：协议原样；Windows 绝对/UNC 路径转 file://；其余补 https://
function browserTargetUrl(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    if (/^[a-zA-Z]:[\\/]/.test(raw)) return encodeURI('file:///' + raw.replace(/\\/g, '/'));
    if (raw.startsWith('\\\\')) return encodeURI('file:' + raw.replace(/\\/g, '/'));
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
    return 'https://' + raw;
}

// 地址栏里优先用户正在输入的内容，否则用当前页面地址
function browserAddressOf(doc) {
    const typed = doc.browserAddr ? String(doc.browserAddr.value || '').trim() : '';
    if (typed) return typed;
    const current = String(doc.browserUrl || '').trim();
    return current && current !== 'about:blank' ? current : '';
}

function openBrowserExternally(doc) {
    const target = browserAddressOf(doc);
    if (!target) {
        deps.flash('地址栏为空，先输入网址或文件路径', true);
        return;
    }
    const url = browserTargetUrl(target);
    if (!url) return;
    if (deps.rt && deps.rt.BrowserOpenURL) deps.rt.BrowserOpenURL(url);
    else window.open(url, '_blank', 'noopener');
}

function showBrowserMoreMenu(doc, anchor) {
    if (!deps.ctxMenu) return;
    const target = browserAddressOf(doc);
    const url = target ? browserTargetUrl(target) : '';
    const rect = anchor.getBoundingClientRect();
    deps.ctxMenu.open([
        {label: '用默认浏览器打开', icon: 'browser', disabled: !url, action: () => openBrowserExternally(doc)},
        {label: '复制网页地址', icon: 'copy', disabled: !target, action: () => deps.copyText(target, '网页地址')},
        {label: '在新标签页中打开', icon: 'new-window', disabled: !url, action: () => deps.openBrowserTab(url, doc.browserProfile)},
        {sep: true},
        {label: '刷新页面', icon: 'refresh', action: () => deps.backend.BrowserReload(doc.id).catch(() => {})},
        {label: '停止加载', icon: 'close', disabled: !doc.loading, action: () => deps.backend.BrowserStop(doc.id).catch(() => {})},
    ], rect.left, rect.bottom + 4, {onClose: () => syncBrowserTab(doc)});
    // 菜单已进 DOM：作废显隐缓存，让同步逻辑把原生控件先藏起来（否则菜单会被它盖住）
    doc.browserApplied = null;
    syncBrowserTab(doc);
}

// ---------- 浏览器视口尺寸（用户菜单或 AI browser_resize 工具控制） ----------
// fit = 随标签页撑满（默认）；fixed = 固定宽高居中显示。.browser-surface 是唯一
// 真源：ResizeObserver 会把新尺寸同步到原生 WebView2（syncBrowserTab）。

const BROWSER_VIEWPORT_PRESETS = [
    {label: '1280 × 720（桌面）', width: 1280, height: 720},
    {label: '1440 × 900（桌面）', width: 1440, height: 900},
    {label: '375 × 812（iPhone）', width: 375, height: 812},
    {label: '768 × 1024（iPad）', width: 768, height: 1024},
];

// 解析「宽×高」文本（支持 × x * 与逗号分隔），非法返回 null
function parseBrowserViewportText(text) {
    const match = String(text || '').trim().match(/^(\d{1,5})\s*[×xX*,:，]\s*(\d{1,5})$/);
    if (!match) return null;
    const width = Math.round(Number(match[1]));
    const height = Math.round(Number(match[2]));
    if (width < 200 || width > 8000 || height < 200 || height > 8000) return null;
    return {mode: 'fixed', width, height};
}

function applyBrowserViewport(doc) {
    if (!doc || !doc.browserEl) return;
    const surface = doc.browserEl;
    const vp = doc.browserViewport;
    if (!vp || vp.mode !== 'fixed' || !(vp.width > 0) || !(vp.height > 0)) {
        surface.classList.remove('browser-surface-fixed');
        surface.style.width = '';
        surface.style.height = '';
        surface.style.flex = '';
        surface.style.margin = '';
    } else {
        surface.classList.add('browser-surface-fixed');
        surface.style.width = Math.round(vp.width) + 'px';
        surface.style.height = Math.round(vp.height) + 'px';
        surface.style.flex = 'none';
        surface.style.margin = 'auto';
    }
    updateBrowserViewportBtn(doc);
    syncBrowserTab(doc);
}

function setBrowserViewport(doc, viewport) {
    if (!doc || !doc.browserEl) return false;
    doc.browserViewport = viewport && viewport.mode === 'fixed' && viewport.width > 0 && viewport.height > 0
        ? {mode: 'fixed', width: Math.round(viewport.width), height: Math.round(viewport.height)}
        : {mode: 'fit'};
    applyBrowserViewport(doc);
    return true;
}

function browserViewportLabel(doc) {
    const vp = doc.browserViewport;
    if (!vp || vp.mode !== 'fixed' || !(vp.width > 0)) return '自适应';
    return Math.round(vp.width) + '×' + Math.round(vp.height);
}

function updateBrowserViewportBtn(doc) {
    if (!doc || !doc.browserViewportBtn) return;
    doc.browserViewportBtn.textContent = browserViewportLabel(doc);
    doc.browserViewportBtn.title = '视口尺寸：' + browserViewportLabel(doc) + '（点击切换预设或自定义）';
}

function showBrowserViewportMenu(doc, anchor) {
    if (!deps.ctxMenu) return;
    const rect = anchor.getBoundingClientRect();
    const vp = doc.browserViewport;
    const isFit = !vp || vp.mode !== 'fixed';
    const items = [{label: '自适应容器', checked: isFit, action: () => setBrowserViewport(doc, {mode: 'fit'})}, {sep: true}];
    for (const preset of BROWSER_VIEWPORT_PRESETS) {
        const active = !isFit && Math.round(vp.width) === preset.width && Math.round(vp.height) === preset.height;
        items.push({
            label: preset.label,
            checked: active,
            action: () => setBrowserViewport(doc, {mode: 'fixed', width: preset.width, height: preset.height}),
        });
    }
    items.push({sep: true});
    items.push({label: '自定义尺寸…', action: () => showBrowserViewportDialog(doc)});
    deps.ctxMenu.open(items, rect.left, rect.bottom + 4, {onClose: () => syncBrowserTab(doc)});
    doc.browserApplied = null;
    syncBrowserTab(doc);
}

function showBrowserViewportDialog(doc) {
    const vp = doc.browserViewport && doc.browserViewport.mode === 'fixed' ? doc.browserViewport : {width: 1280, height: 800};
    deps.openNameDialog({
        title: '自定义视口尺寸',
        label: '宽 × 高（像素，如 1280×800）',
        value: Math.round(vp.width) + '×' + Math.round(vp.height),
        placeholder: '1280×800',
        okLabel: '应用',
        onSubmit: async (value) => {
            const parsed = parseBrowserViewportText(value);
            if (!parsed) {
                throw new Error('格式应为「宽×高」，宽高各 200–8000 像素');
            }
            setBrowserViewport(doc, parsed);
            deps.flash('浏览器视口已设为 ' + parsed.width + '×' + parsed.height);
        },
    });
}

function createBrowserView(doc) {
    const pane = document.createElement('div');
    pane.className = 'jsoneditor-pane active browser-pane';
    deps.els.editor.appendChild(pane);
    const view = document.createElement('div');
    view.className = 'browser-view';
    const toolbar = document.createElement('div');
    toolbar.className = 'browser-toolbar';
    const mkBtn = (icon, title, action) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'browser-btn';
        b.title = title;
        b.innerHTML = iconSvg(icon, 14);
        b.addEventListener('click', action);
        return b;
    };
    const backBtn = mkBtn('back', '后退', () => deps.backend.BrowserGoBack(doc.id).catch(() => {}));
    const fwdBtn = mkBtn('forward', '前进', () => deps.backend.BrowserGoForward(doc.id).catch(() => {}));
    const reloadBtn = mkBtn('refresh', '刷新', () => deps.backend.BrowserReload(doc.id).catch(() => {}));
    // 左侧浏览器图标：交给系统默认浏览器打开当前地址/文件；右侧「更多」：复制地址、新标签页、刷新等
    const externalBtn = mkBtn('browser', '用默认浏览器打开', () => openBrowserExternally(doc));
    const moreBtn = mkBtn('more', '更多操作', () => showBrowserMoreMenu(doc, moreBtn));
    const addr = document.createElement('input');
    addr.className = 'browser-addr';
    addr.type = 'text';
    addr.spellcheck = false;
    addr.placeholder = '输入网址或文件路径后回车（默认 https://）';
    addr.value = doc.browserUrl && doc.browserUrl !== 'about:blank' ? doc.browserUrl : '';
    addr.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const target = addr.value.trim();
        if (!target) return;
        const url = browserTargetUrl(target);
        if (!url) return;
        doc.browserUrl = url;
        deps.backend.BrowserNavigate(doc.id, url).catch((err) => deps.flash('导航失败：' + err, true));
    });
    // 视口尺寸按钮：预设（桌面/手机/平板）+ 自定义宽高；AI browser_resize 走同一入口
    const viewportBtn = document.createElement('button');
    viewportBtn.type = 'button';
    viewportBtn.className = 'browser-btn browser-viewport-btn';
    viewportBtn.addEventListener('click', () => showBrowserViewportMenu(doc, viewportBtn));
    toolbar.append(backBtn, fwdBtn, reloadBtn, externalBtn, addr, viewportBtn, moreBtn);
    const surface = document.createElement('div');
    surface.className = 'browser-surface';
    const empty = document.createElement('div');
    empty.className = 'browser-empty';
    empty.textContent = '网页区域加载中…';
    surface.appendChild(empty);
    view.append(toolbar, surface);
    pane.appendChild(view);
    doc.pane = pane;
    doc.browserEl = surface;
    doc.browserEmpty = empty;
    doc.browserAddr = addr;
    doc.browserBackBtn = backBtn;
    doc.browserFwdBtn = fwdBtn;
    doc.browserViewportBtn = viewportBtn;
    if (!doc.browserViewport) doc.browserViewport = {mode: 'fit'};
    updateBrowserViewportBtn(doc);
    if (typeof ResizeObserver === 'function') {
        doc.browserRO = new ResizeObserver(() => syncBrowserTab(doc));
        doc.browserRO.observe(surface);
        doc.browserRO.observe(pane);
    }
    syncBrowserTab(doc);
}

function browserSurfaceRect(doc) {
    if (!doc.browserEl || !doc.browserEl.isConnected) return null;
    const rect = doc.browserEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const dpr = window.devicePixelRatio || 1;
    return {
        x: Math.round(rect.left * dpr),
        y: Math.round(rect.top * dpr),
        w: Math.round(rect.width * dpr),
        h: Math.round(rect.height * dpr),
    };
}

// WebView2 是原生窗口，永远盖在主 WebView 之上：对话框/菜单/面板等浮层打开时必须隐藏它
const BROWSER_POPUP_SELECTORS = [
    '.dialog:not(.hidden)',
    '.ai-model-editor-mask:not(.hidden)',
    '.ctx-menu:not(.hidden)',
    '#menubar .menu.open',
    '#palette-mask:not(.hidden)',
    '#ai-panel.ai-fullscreen:not(.hidden)',
];

function browserVisibleFor(doc) {
    if (doc !== deps.file) return false;
    for (const sel of BROWSER_POPUP_SELECTORS) {
        if (document.querySelector(sel)) return false;
    }
    const mask = document.getElementById('split-mask');
    if (mask && mask.style.display === 'block') return false;
    return true;
}

let browserSyncPending = false;
function syncBrowserTab(doc) {
    if (!doc.browser || browserSyncPending || !deps.backend.BrowserSetBounds) return;
    browserSyncPending = true;
    // setTimeout 而非 rAF：后台标签页 rAF 冻结会让 bounds/可见性同步永久卡住
    setTimeout(() => {
        browserSyncPending = false;
        if (!deps.docs.includes(doc) || !doc.browserEl) return;
        const rect = browserSurfaceRect(doc);
        const visible = !!rect && browserVisibleFor(doc);
        const last = doc.browserApplied;
        // 轮询同步会反复进来：状态没变就别再跨进程调后端
        if (!visible) {
            if (last && !last.visible) return;
            doc.browserApplied = {visible: false};
            deps.backend.BrowserSetVisible(doc.id, false).catch(() => {});
            return;
        }
        if (last && last.visible && last.x === rect.x && last.y === rect.y && last.w === rect.w && last.h === rect.h) return;
        doc.browserApplied = {visible: true, x: rect.x, y: rect.y, w: rect.w, h: rect.h};
        deps.backend.BrowserSetBounds(doc.id, rect.x, rect.y, rect.w, rect.h).catch(() => {});
    }, 0);
}

function syncAllBrowserTabs() {
    for (const d of deps.docs) {
        if (d.browser) syncBrowserTab(d);
    }
}

function updateBrowserTitle(doc, title) {
    if (!title || title === 'about:blank') return;
    if (doc.name !== title) {
        doc.name = title;
        renderTabs();
    }
    if (doc === deps.file) {
        setFilename(doc.name, '');
        deps.updateWindowTitle();
    }
}

// 补丁视图的宿主上下文：把主界面的能力（打开文件、重载、提示）注入进去，
// 补丁视图本身不直接依赖 main.js 的全局状态。
let patchViewHostCtx = null;

function patchRootPath() {
    if (deps.explorer && typeof deps.explorer.getRoot === 'function') return deps.explorer.getRoot() || '';
    return deps.workspaceFolder || '';
}

function patchAbsPath(rel) {
    const root = patchRootPath().replace(/[\\/]+$/, '');
    if (!root || !rel) return rel || '';
    return root + '/' + String(rel).replace(/\\/g, '/');
}

async function reloadAfterPatch(files) {
    if (deps.explorer && deps.explorer.refresh) deps.explorer.refresh();
    for (const rel of files || []) {
        const doc = deps.findDocByPath(patchAbsPath(rel));
        if (!doc) continue;
        if (doc.dirty) {
            deps.flash(doc.name + ' 已被补丁修改，但编辑器里有未保存内容，未自动重载', true);
            continue;
        }
        if (doc === deps.file) {
            patchViewHostCtx.suppressNotify = true;
            try { await deps.reloadActive({quiet: true}); } catch (e) {}
            patchViewHostCtx.suppressNotify = false;
        } else {
            doc.staleOnDisk = true;
        }
    }
}

function patchViewContext() {
    if (patchViewHostCtx) return patchViewHostCtx;
    patchViewHostCtx = {
        backend: deps.backend,
        suppressNotify: false,
        getRoot: patchRootPath,
        chooseFolder: (dir) => deps.backend.OpenFolderDialog(dir || ''),
        openPath: (rel) => {
            const abs = patchAbsPath(rel);
            if (abs) deps.openPath(abs);
        },
        notifyChanged: (files) => { reloadAfterPatch(files); },
        flash: (msg, isErr) => deps.flash(msg, isErr),
    };
    return patchViewHostCtx;
}

// 补丁在代码视图里除 token 着色外，给整行铺淡底色（Ace marker，fullLine）。
// 超过 5000 行只保留 token 着色，避免 marker 过多拖慢滚动。
function refreshPatchMarkers(doc) {
    const ace = doc && doc.editor && doc.editor.aceEditor;
    if (!ace || !doc.format || !doc.format.patch) return;
    const session = ace.session;
    if (!session) return;
    for (const id of (doc._patchMarkers || [])) {
        try { session.removeMarker(id); } catch (e) {}
    }
    doc._patchMarkers = [];
    const total = session.getLength();
    if (total > 5000) return;
    const aceLib = window.ace;
    if (!aceLib || typeof aceLib.require !== 'function') return;
    let Range = null;
    try { Range = aceLib.require('ace/range').Range; } catch (e) { return; }
    if (!Range) return;
    for (let row = 0; row < total; row += 1) {
        const text = session.getLine(row) || '';
        if (text.startsWith('+++') || text.startsWith('---')) continue;
        let cls = '';
        if (text.startsWith('+')) cls = 'dl-diff-add-line';
        else if (text.startsWith('-')) cls = 'dl-diff-del-line';
        if (!cls) continue;
        try {
            doc._patchMarkers.push(session.addMarker(new Range(row, 0, row, 1), cls, 'fullLine'));
        } catch (e) {
            break;
        }
    }
}


function createDocEditor(doc) {
    if (doc.editor) return;
    // 浏览器 / 后台终端视图没有 doc.editor，用 doc.pane 判断是否已建过；
    // 否则每次激活都会再建一套面板，旧面板就留在编辑器里叠着。
    if (doc.browser) {
        if (doc.pane) return;
        createBrowserView(doc);
        return;
    }
    if (doc.bgTerm) {
        if (doc.pane) return;
        deps.createBgTermView(doc);
        return;
    }
    const fmt = doc.format;
    const fs = deps.getFormatSettings(fmt.id);
    const showJsonErrors = fmt.id === 'json' && /\.json$/i.test(doc.name || '');
    const patchRequested = !!fmt.patch && (doc.mode === 'patch' || !doc.mode);
    const tableRequested = !!fmt.table && doc.mode === 'table';
    const previewRequested = !!fmt.preview && doc.mode === 'preview';
    const splitRequested = doc.mode === 'split' && !!deps.splitKindFor(doc);
    const imageRequested = !!fmt.image && doc.mode === 'image';
    const binaryMode = !!fmt.image || fmt.id === 'bytes';
    let startMode = doc.mode === 'text' ? 'text' : (!doc.treeAvailable ? 'code' : (doc.mode === 'code' ? 'code' : 'tree'));
    if (tableRequested || patchRequested) startMode = 'text';
    if (previewRequested || splitRequested) startMode = 'code';
    let initialText = null;
    let initialValue = null;
    if (startMode === 'code' || startMode === 'text') {
        initialText = doc.content || '';
    } else {
        try {
            initialValue = fmt.parse(doc.content || '');
        } catch (e) {
            startMode = 'code';
            initialText = doc.content || '';
            doc.treeAvailable = false;
            doc.parseError = e;
        }
    }
    const pane = document.createElement('div');
    pane.className = 'jsoneditor-pane active';
    deps.els.editor.appendChild(pane);
    deps.installReadOnlyGuards(pane);
    pane.addEventListener('click', (e) => {
        const target = e.target;
        if (!target || !target.closest) return;
        const fold = target.closest('.jsoneditor-value.value-fold');
        if (fold) {
            const row = fold.closest('tr.jsoneditor-expandable');
            const button = row ? row.querySelector('button.jsoneditor-collapsed') : null;
            if (button) {
                e.preventDefault();
                e.stopPropagation();
                button.click();
                queueMicrotask(humanizeCounts);
                return;
            }
        }
        if (target.closest('button.jsoneditor-collapsed, button.jsoneditor-expanded')) {
            queueMicrotask(humanizeCounts);
        }
    }, true);
    doc.loading = true;
    const ed = new JSONEditor(pane, {
        mode: startMode,
        modes: fmt.table ? ['tree', 'text'] : (doc.treeAvailable ? ['tree', 'code', 'text'] : ['code', 'text']),
        mainMenuBar: true,
        navigationBar: !fmt.rawOnly,
        statusBar: false,
        showErrorTable: showJsonErrors,
        maxVisibleChilds: deps.TREE_MAX_CHILDREN,
        language: 'zh-CN',
        languages: deps.editorLocale,
        indentation: fs.indent === 'tab' ? '\t' : Number(fs.indent),
        onChange() {
            if (doc.loading) return;
            markDocDirty(doc);
        },
        onModeChange(mode) {
            if (!doc.editor) return;
            if (doc.splitActive && mode !== 'code') exitSplitView(doc);
            doc.mode = mode;
            if (deps.file === doc) {
                deps.currentMode = mode;
                applyAceMode();
                updateStatus();
                deps.updateSearchState();
            }
            setTimeout(() => {
                if (!doc.editor || doc.mode !== mode) return;
                doc.text = doc.editor.getText();
                if (!doc.dirty) doc.bases[mode] = doc.text;
                deps.applyReadOnlyToDoc(doc);
                scheduleGitGutter(doc, 300);
            }, 0);
        },
        onError(err) {
            if (deps.file === doc) deps.flash(err.message, true);
        },
    });
    doc.editor = ed;
    doc.pane = pane;
    if (ed.aceEditor) {
        hookCodeFoldPreviews(ed.aceEditor);
        hookMultiCursor(ed.aceEditor);
        ed.aceEditor.on('changeSelection', deps.scheduleWordCount);
        ed.aceEditor.on('input', deps.scheduleWordCount);
        // 写作模式：光标变化驱动打字机滚动与段落聚焦（内部自判生效条件）
        ed.aceEditor.on('changeSelection', () => deps.scheduleWritingCaret(ed.aceEditor));
        ed.aceEditor.on('input', () => deps.scheduleWritingCaret(ed.aceEditor));
    }
    if (deps.settings.treeExpandDefault === 'collapse' && startMode === 'tree' && doc.treeAvailable && !doc.large) {
        setTimeout(() => {
            try { if (doc.editor) doc.editor.collapseAll(); } catch (e) {}
        }, 50);
    }
    if (startMode === 'code' || startMode === 'text') {
        ed.setText(initialText != null ? initialText : '');
    } else {
        ed.set(initialValue);
    }
    if ((doc.large || doc.binary || deps.settings.readOnlyMode) && ed.aceEditor) {
        ed.aceEditor.setReadOnly(true);
    }
    if (ed.aceEditor) {
        try {
            ed.aceEditor.session.setUseWrapMode(!!deps.settings.codeWrap);
            ed.aceEditor.setDisplayIndentGuides(!!deps.settings.codeGuides);
            ed.aceEditor.setHighlightIndentGuides(!!deps.settings.codeGuides);
        } catch (e) {}
    }
    setupTreeContextMenu(doc);
    doc.mode = splitRequested ? 'split' : previewRequested ? 'preview' : tableRequested ? 'table' : imageRequested ? 'image' : binaryMode ? 'binary' : startMode;
    // 补丁视图是覆盖层：底层编辑器仍按 text 起始，但 doc.mode 必须记成 patch，
    // 否则首次打开时状态栏显示补丁、视图按钮却选中文本。
    if (patchRequested) doc.mode = 'patch';
    doc.text = ed.getText();
    // 打开/恢复/重载属于程序化全文替换：清掉码字观察基线，下一次观察以当前内容重新起算
    delete doc._writingLast;
    delete doc._writingBase;
    if (fmt.table) createCsvTableView(doc);
    if (fmt.preview) createMarkdownPreview(doc);
    if (fmt.image) createImageView(doc);
    if (patchRequested) showPatchView(doc, patchViewContext());
    if (tableRequested) showCsvTableView(doc);
    if (previewRequested) showMarkdownPreview(doc);
    if (imageRequested) showImageView(doc);
    if (!doc.dirty) doc.bases[doc.mode] = doc.text;
    deps.applyReadOnlyToDoc(doc);
    doc.content = null;
    doc.loading = false;
    if (fmt.patch) refreshPatchMarkers(doc);
    scheduleGitGutter(doc, 200);
}

function createCsvTableView(doc) {
    if (doc.tableEl || !doc.pane) return;
    const wrap = document.createElement('div');
    wrap.className = 'csv-table-view';
    const bar = document.createElement('div');
    bar.className = 'csv-table-bar';
    const meta = document.createElement('span');
    meta.className = 'csv-table-meta';
    const filterWrap = document.createElement('label');
    filterWrap.className = 'csv-table-filter';
    const filterInput = document.createElement('input');
    filterInput.type = 'search';
    filterInput.placeholder = '筛选所有列…';
    filterInput.title = '对所有列做子串筛选；只影响表格显示，不改文件内容';
    filterInput.spellcheck = false;
    const filterClear = document.createElement('button');
    filterClear.type = 'button';
    filterClear.className = 'csv-filter-clear';
    filterClear.textContent = '×';
    filterClear.title = '清除筛选';
    filterWrap.append(filterInput, filterClear);
    const hint = document.createElement('span');
    hint.className = 'csv-table-hint';
    hint.textContent = doc.large
        ? '文件超过 10 MB，表格只读'
        : '';
    const statsBtn = document.createElement('button');
    statsBtn.type = 'button';
    statsBtn.className = 'csv-stats-btn';
    statsBtn.textContent = '列统计';
    statsBtn.title = '查看当前列统计（也可右键表头指定列）';
    bar.append(meta, filterWrap, statsBtn, hint);
    const scroll = document.createElement('div');
    scroll.className = 'csv-table-scroll';
    wrap.append(bar, scroll);
    doc.pane.appendChild(wrap);
    doc.tableEl = wrap;
    doc.tableMeta = meta;
    doc.tableScroll = scroll;
    doc.tableFilterInput = filterInput;
    doc.tableFilterClear = filterClear;
    if (!doc.tableZoom) doc.tableZoom = 1;
    let filterTimer = 0;
    filterInput.addEventListener('input', () => {
        clearTimeout(filterTimer);
        filterTimer = setTimeout(() => {
            filterTimer = 0;
            const view = ensureCsvView(doc);
            const next = filterInput.value;
            if (view.filter === next) return;
            view.filter = next;
            renderCsvTableView(doc, {resetScroll: true});
        }, 120);
    });
    filterClear.addEventListener('click', () => {
        filterInput.value = '';
        const view = ensureCsvView(doc);
        if (!view.filter) return;
        view.filter = '';
        renderCsvTableView(doc, {resetScroll: true});
    });
    statsBtn.addEventListener('pointerdown', () => {
        const active = document.activeElement;
        if (active && active.classList && active.classList.contains('csv-cell') && active.dataset.col != null) {
            doc.csvActiveCol = Number(active.dataset.col);
        }
    });
    statsBtn.addEventListener('click', () => {
        if (doc !== deps.file) return;
        const view = ensureCsvView(doc);
        let col = doc.csvActiveCol;
        if (!Number.isInteger(col)) col = view.sortCol >= 0 ? view.sortCol : 0;
        openCsvColumnStats(doc, col);
    });
    scroll.addEventListener('scroll', () => {
        if (doc.csvVirtual) scheduleCsvVirtualRender(doc);
    }, {passive: true});
    applyCsvTableZoom(doc);
}

function ensureCsvView(doc) {
    if (!doc.csvView) doc.csvView = {sortCol: -1, sortDir: 0, filter: ''};
    return doc.csvView;
}

const csvCollator = new Intl.Collator('zh-CN', {numeric: true, sensitivity: 'base'});

function csvSortKey(value) {
    const text = value == null ? '' : String(value);
    const trimmed = text.trim();
    if (!trimmed) return {empty: true, kind: 3, num: 0, str: ''};
    const num = Number(trimmed.replace(/,/g, ''));
    if (trimmed !== '' && Number.isFinite(num)) return {empty: false, kind: 0, num, str: trimmed};
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(trimmed)) {
        const time = Date.parse(trimmed);
        if (Number.isFinite(time)) return {empty: false, kind: 1, num: time, str: trimmed};
    }
    return {empty: false, kind: 2, num: 0, str: trimmed};
}

// 排序/筛选只产生视图索引，绝不改动 doc.tableRows 的原始顺序
function csvViewIndices(doc) {
    const view = ensureCsvView(doc);
    const rows = doc.tableRows || [];
    const headers = doc.tableHeaders || [];
    const filter = String(view.filter || '').trim().toLowerCase();
    const sortable = view.sortDir !== 0 && view.sortCol >= 0 && view.sortCol < headers.length;
    if (!filter && !sortable) return null;
    const indices = [];
    for (let i = 0; i < rows.length; i++) {
        if (filter) {
            const row = rows[i] || [];
            let hit = false;
            for (let c = 0; c < row.length; c++) {
                const cell = row[c] == null ? '' : String(row[c]);
                if (cell.toLowerCase().includes(filter)) {
                    hit = true;
                    break;
                }
            }
            if (!hit) continue;
        }
        indices.push(i);
    }
    if (sortable) {
        const col = view.sortCol;
        const dir = view.sortDir;
        indices.sort((a, b) => {
            const ka = csvSortKey((rows[a] || [])[col]);
            const kb = csvSortKey((rows[b] || [])[col]);
            if (ka.empty || kb.empty) {
                if (ka.empty === kb.empty) return a - b;
                return ka.empty ? 1 : -1;
            }
            let cmp;
            if (ka.kind === kb.kind && ka.kind !== 2) cmp = ka.num - kb.num;
            else cmp = csvCollator.compare(ka.str, kb.str);
            if (cmp === 0) cmp = a - b;
            return cmp * dir;
        });
    }
    return indices;
}

function computeCsvColumnStats(doc, col) {
    const rows = doc.tableRows || [];
    const values = [];
    let empty = 0;
    for (const row of rows) {
        const raw = (row || [])[col];
        const text = raw == null ? '' : String(raw);
        if (!text.trim()) empty++;
        else values.push(text);
    }
    const counts = new Map();
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    let numericCount = 0;
    let dateCount = 0;
    let emailCount = 0;
    let urlCount = 0;
    let boolCount = 0;
    let maxLen = 0;
    const numbers = [];
    for (const text of values) {
        const trimmed = text.trim();
        maxLen = Math.max(maxLen, text.length);
        const num = Number(trimmed.replace(/,/g, ''));
        if (trimmed && Number.isFinite(num)) {
            numericCount++;
            numbers.push(num);
        }
        if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(trimmed) && Number.isFinite(Date.parse(trimmed))) dateCount++;
        if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) emailCount++;
        if (/^https?:\/\//i.test(trimmed)) urlCount++;
        if (/^(true|false|yes|no|是|否)$/i.test(trimmed)) boolCount++;
    }
    let type = '文本';
    if (values.length && numericCount === values.length) type = '数字';
    else if (values.length && dateCount === values.length) type = '日期';
    else if (values.length && emailCount === values.length) type = '邮箱';
    else if (values.length && urlCount === values.length) type = 'URL';
    else if (values.length && boolCount === values.length) type = '布尔';
    else if (counts.size && counts.size <= Math.min(20, Math.max(2, Math.round(values.length * 0.2)))) type = '枚举';
    const stats = {
        total: rows.length,
        nonEmpty: values.length,
        empty,
        unique: counts.size,
        maxLen,
        type,
        top,
        numeric: null,
    };
    if (values.length && numericCount === values.length) {
        let min = numbers[0];
        let max = numbers[0];
        let sum = 0;
        for (const n of numbers) {
            if (n < min) min = n;
            if (n > max) max = n;
            sum += n;
        }
        stats.numeric = {min, max, avg: sum / numbers.length};
    }
    return stats;
}

function closeCsvColumnStats(doc) {
    if (!doc) return;
    if (doc.csvStatsPanel) doc.csvStatsPanel.classList.add('hidden');
    doc.csvStatsOpen = false;
    if (doc.csvStatsEscHandler) {
        document.removeEventListener('keydown', doc.csvStatsEscHandler, true);
        doc.csvStatsEscHandler = null;
    }
}

function ensureCsvStatsPanel(doc) {
    if (doc.csvStatsPanel) return doc.csvStatsPanel;
    const panel = document.createElement('div');
    panel.className = 'csv-stats-panel hidden';
    panel.setAttribute('role', 'dialog');
    doc.tableEl.appendChild(panel);
    doc.csvStatsPanel = panel;
    return panel;
}

function openCsvColumnStats(doc, col) {
    const headers = doc.tableHeaders || [];
    if (!headers.length) return;
    const index = Math.max(0, Math.min(headers.length - 1, Number(col) || 0));
    doc.csvActiveCol = index;
    const panel = ensureCsvStatsPanel(doc);
    panel.textContent = '';
    const head = document.createElement('div');
    head.className = 'csv-stats-head';
    const title = document.createElement('span');
    title.className = 'csv-stats-title';
    title.textContent = '列统计 · ' + (headers[index] || '(空列名)');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'csv-stats-close';
    close.textContent = '×';
    close.title = '关闭（Esc）';
    close.addEventListener('click', () => closeCsvColumnStats(doc));
    head.append(title, close);
    panel.appendChild(head);
    const sub = document.createElement('div');
    sub.className = 'csv-stats-sub';
    sub.textContent = '第 ' + (index + 1) + ' 列';
    panel.appendChild(sub);
    const stats = computeCsvColumnStats(doc, index);
    const addRow = (label, value) => {
        const row = document.createElement('div');
        row.className = 'csv-stats-row';
        const key = document.createElement('span');
        key.className = 'csv-stats-label';
        key.textContent = label;
        const val = document.createElement('span');
        val.className = 'csv-stats-value';
        val.textContent = value;
        row.append(key, val);
        panel.appendChild(row);
    };
    addRow('行数', String(stats.total));
    addRow('非空 / 空', stats.nonEmpty + ' / ' + stats.empty);
    addRow('唯一值', String(stats.unique));
    if (stats.numeric) {
        const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))));
        addRow('最小 / 最大', fmt(stats.numeric.min) + ' / ' + fmt(stats.numeric.max));
        addRow('平均值', fmt(stats.numeric.avg));
    }
    addRow('最长值', stats.maxLen + ' 字符');
    addRow('疑似类型', stats.type);
    if (stats.top.length) {
        addRow('出现最多', stats.top.map(([value, count]) => value + '（' + count + '）').join('、'));
    }
    panel.classList.remove('hidden');
    doc.csvStatsOpen = true;
    if (!doc.csvStatsEscHandler) {
        doc.csvStatsEscHandler = (e) => {
            if (e.key !== 'Escape' || !doc.csvStatsOpen) return;
            e.preventDefault();
            e.stopPropagation();
            closeCsvColumnStats(doc);
        };
        document.addEventListener('keydown', doc.csvStatsEscHandler, true);
    }
}

function applyCsvTableZoom(doc) {
    if (!doc || !doc.tableEl) return;
    doc.tableEl.style.setProperty('--csv-zoom', String(doc.tableZoom || 1));
    if (doc.csvVirtual) {
        doc.csvRowScreenH = (doc.csvRowLayoutH || CSV_DEFAULT_ROW_LAYOUT_H) * (doc.tableZoom || 1);
        doc.csvVisibleStart = -1;
        doc.csvVisibleEnd = -1;
        scheduleCsvVirtualRender(doc);
    }
}

function zoomCsvTable(doc, deltaY) {
    if (!doc || !doc.tableEl || !deltaY) return;
    const dir = deltaY < 0 ? 1 : -1;
    const current = doc.tableZoom || 1;
    const next = Math.min(8, Math.max(0.25, Math.round((current + dir * 0.1) * 10) / 10));
    if (next === current) return;
    const scroll = doc.tableScroll;
    const oldRowH = doc.csvRowScreenH || (doc.csvRowLayoutH || CSV_DEFAULT_ROW_LAYOUT_H) * current;
    const topRow = oldRowH > 0 ? scroll.scrollTop / oldRowH : 0;
    doc.tableZoom = next;
    applyCsvTableZoom(doc);
    if (doc.csvVirtual && scroll) {
        scroll.scrollTop = Math.max(0, topRow * (doc.csvRowLayoutH || CSV_DEFAULT_ROW_LAYOUT_H) * next);
        doc.csvVisibleStart = -1;
        doc.csvVisibleEnd = -1;
        renderCsvVirtualRows(doc, true);
    }
    updateStatus();
}

const CSV_VIRTUAL_THRESHOLD = 300;
const CSV_VIRTUAL_OVERSCAN = 10;
const CSV_DEFAULT_ROW_LAYOUT_H = 24;

function estimateCsvColumnWidths(doc) {
    const headers = doc.tableHeaders || [];
    const rows = doc.tableRows || [];
    const widths = headers.map((header) => Math.max(deps.CSV_COL_MIN_WIDTH, Math.min(420, 24 + String(header || '').length * 8)));
    const sample = Math.min(rows.length, 300);
    for (let i = 0; i < sample; i++) {
        const row = rows[i] || [];
        for (let c = 0; c < headers.length; c++) {
            const len = row[c] == null ? 0 : String(row[c]).length;
            const width = Math.min(420, 24 + Math.min(len, 48) * 8);
            if (width > widths[c]) widths[c] = width;
        }
    }
    return widths;
}

function createCsvVirtualRow(doc, editable, headerCount) {
    const tr = document.createElement('tr');
    tr.className = 'csv-row';
    const num = document.createElement('td');
    num.className = 'csv-rownum';
    tr.appendChild(num);
    const cells = [];
    for (let col = 0; col < headerCount; col++) {
        const td = document.createElement('td');
        td.className = 'csv-cell';
        if (editable) {
            td.contentEditable = 'plaintext-only';
            td.spellcheck = false;
            td.dataset.col = String(col);
            td.addEventListener('focus', () => { doc.csvActiveCol = col; });
            td.addEventListener('keydown', (e) => onCsvCellKeyDown(doc, e));
            td.addEventListener('input', () => markCsvCellTyping(doc));
            td.addEventListener('blur', () => commitCsvCell(doc, td));
        }
        tr.appendChild(td);
        cells.push(td);
    }
    return {tr, num, cells};
}

function scheduleCsvVirtualRender(doc) {
    if (!doc || !doc.csvVirtual || doc.csvRenderScheduled) return;
    doc.csvRenderScheduled = true;
    requestAnimationFrame(() => {
        doc.csvRenderScheduled = false;
        renderCsvVirtualRows(doc);
    });
}

// 只更新视口附近的真实行，滚动时复用同一批 tr/td
function renderCsvVirtualRows(doc, force) {
    if (!doc || !doc.csvVirtual || !doc.csvTBody || !doc.csvTopSpacer || !doc.csvBottomSpacer) return;
    const scroll = doc.tableScroll;
    const tbody = doc.csvTBody;
    const total = doc.csvViewTotal || 0;
    const zoom = doc.tableZoom || 1;
    if (!doc.csvRowLayoutH) doc.csvRowLayoutH = CSV_DEFAULT_ROW_LAYOUT_H;
    let rowH = doc.csvRowScreenH || doc.csvRowLayoutH * zoom;
    if (!rowH || rowH < 6) rowH = CSV_DEFAULT_ROW_LAYOUT_H * zoom;
    const viewH = scroll.clientHeight || 480;
    const maxTop = Math.max(0, total * rowH - viewH);
    if (scroll.scrollTop > maxTop) scroll.scrollTop = maxTop;
    let start = Math.floor(scroll.scrollTop / rowH) - CSV_VIRTUAL_OVERSCAN;
    if (start < 0) start = 0;
    let count = Math.ceil(viewH / rowH) + CSV_VIRTUAL_OVERSCAN * 2;
    let end = Math.min(total, start + count);
    if (start >= total && total > 0) {
        start = Math.max(0, total - count);
        end = total;
    }
    if (!force && start === doc.csvVisibleStart && end === doc.csvVisibleEnd &&
        doc.csvPool && doc.csvPool.length && doc.csvPool[0].cells.length === doc.tableHeaders.length) {
        return;
    }
    if (start !== doc.csvVisibleStart || end !== doc.csvVisibleEnd) {
        const active = document.activeElement;
        if (active && active.classList && active.classList.contains('csv-cell') && tbody.contains(active)) {
            active.blur();
        }
    }
    doc.csvVisibleStart = start;
    doc.csvVisibleEnd = end;
    const layoutH = doc.csvRowLayoutH;
    doc.csvTopSpacer.firstChild.style.height = Math.max(0, start * layoutH) + 'px';
    doc.csvBottomSpacer.firstChild.style.height = Math.max(0, (total - end) * layoutH) + 'px';
    const needed = Math.max(0, end - start);
    const headers = doc.tableHeaders || [];
    const rows = doc.tableRows || [];
    const indices = doc.csvViewIndices;
    const editable = !doc.large && !doc.binary && !deps.settings.readOnlyMode;
    if (!doc.csvPool || (doc.csvPool.length && doc.csvPool[0].cells.length !== headers.length)) {
        for (const row of doc.csvPool || []) row.tr.remove();
        doc.csvPool = [];
    }
    while (doc.csvPool.length < needed) {
        const row = createCsvVirtualRow(doc, editable, headers.length);
        tbody.insertBefore(row.tr, doc.csvBottomSpacer);
        doc.csvPool.push(row);
    }
    for (let i = 0; i < doc.csvPool.length; i++) {
        const slot = doc.csvPool[i];
        if (i >= needed) {
            slot.tr.hidden = true;
            continue;
        }
        slot.tr.hidden = false;
        const viewPos = start + i;
        const rowIndex = indices ? indices[viewPos] : viewPos;
        const row = rows[rowIndex] || [];
        slot.num.textContent = String(rowIndex + 1);
        for (let col = 0; col < headers.length; col++) {
            const td = slot.cells[col];
            const display = row[col] == null ? '' : String(row[col]);
            if (td.textContent !== display) td.textContent = display;
            td.title = display;
            td.dataset.row = String(rowIndex);
            td.dataset.vpos = String(viewPos);
        }
    }
    const first = doc.csvPool.find((slot) => !slot.tr.hidden);
    if (first) {
        const measured = first.tr.getBoundingClientRect().height;
        if (measured > 4 && Math.abs(measured - (doc.csvRowScreenH || 0)) > 0.6) {
            doc.csvRowScreenH = measured;
            doc.csvRowLayoutH = measured / zoom;
            doc.csvTopSpacer.firstChild.style.height = Math.max(0, start * doc.csvRowLayoutH) + 'px';
            doc.csvBottomSpacer.firstChild.style.height = Math.max(0, (total - end) * doc.csvRowLayoutH) + 'px';
        }
    }
}

function renderCsvTableView(doc, opts = {}) {
    if (!doc || !doc.tableEl || !doc.editor) return;
    const scroll = doc.tableScroll;
    const keepTop = opts.resetScroll ? 0 : scroll.scrollTop;
    const keepLeft = scroll.scrollLeft;
    scroll.textContent = '';
    const text = doc.editor.getText();
    doc.tableTrailingNewline = /\n$/.test(text);
    let parsed;
    try {
        parsed = doc.format.parseTable ? doc.format.parseTable(text) : {headers: [], rows: []};
    } catch (e) {
        doc.tableMeta.textContent = 'CSV 解析失败';
        const error = document.createElement('div');
        error.className = 'csv-table-empty error';
        error.textContent = e.message;
        scroll.appendChild(error);
        return;
    }
    const headers = parsed.headers || [];
    const rows = parsed.rows || [];
    doc.tableHeaders = headers;
    doc.tableRows = rows;
    const view = ensureCsvView(doc);
    if (view.sortCol >= headers.length) {
        view.sortCol = -1;
        view.sortDir = 0;
    }
    if (doc.tableFilterInput && doc.tableFilterInput.value !== (view.filter || '')) {
        doc.tableFilterInput.value = view.filter || '';
    }
    const viewIndices = csvViewIndices(doc);
    const shown = viewIndices ? viewIndices.length : rows.length;
    doc.csvViewIndices = viewIndices;
    doc.csvViewTotal = shown;
    const virtual = shown > CSV_VIRTUAL_THRESHOLD;
    doc.csvVirtual = virtual;
    doc.csvVisibleStart = -1;
    doc.csvVisibleEnd = -1;
    doc.csvRenderScheduled = false;
    doc.csvPool = [];
    if (!Array.isArray(doc.tableColWidths) || doc.tableColWidths.length !== headers.length) {
        doc.tableColWidths = null;
    }
    if (virtual && !doc.tableColWidths) {
        doc.tableColWidths = estimateCsvColumnWidths(doc);
    }
    if (!doc.tableUndo) doc.tableUndo = [];
    if (!doc.tableRedo) doc.tableRedo = [];
    const filtered = !!String(view.filter || '').trim();
    doc.tableMeta.textContent = rows.length + ' 行 × ' + headers.length + ' 列' +
        (filtered ? ' · 匹配 ' + shown + ' 行' : '');
    if (!headers.length) {
        const empty = document.createElement('div');
        empty.className = 'csv-table-empty';
        empty.textContent = filtered ? '没有匹配的行' : '没有可显示的表格内容';
        scroll.appendChild(empty);
        return;
    }
    const table = document.createElement('table');
    table.className = 'csv-table';
    if (Array.isArray(doc.tableColWidths) && doc.tableColWidths.length === headers.length) {
        table.classList.add('fixed-layout');
        table.appendChild(buildCsvColgroup(doc.tableColWidths));
        table.style.width = (deps.CSV_ROW_NUM_WIDTH + doc.tableColWidths.reduce((sum, w) => sum + w, 0)) + 'px';
    }
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const corner = document.createElement('th');
    corner.className = 'csv-rownum';
    corner.textContent = '#';
    headRow.appendChild(corner);
    for (let col = 0; col < headers.length; col++) {
        const header = headers[col];
        const th = document.createElement('th');
        th.className = 'csv-col-head';
        th.title = header + (doc.large ? '' : '（点击排序）');
        if (view.sortCol === col && view.sortDir !== 0) {
            th.dataset.sort = view.sortDir > 0 ? 'asc' : 'desc';
        }
        const label = document.createElement('span');
        label.className = 'csv-head-text';
        label.textContent = header === '' ? '(空列名)' : header;
        const handle = document.createElement('span');
        handle.className = 'csv-col-resize';
        handle.title = '拖动调整列宽';
        handle.dataset.col = String(col);
        handle.addEventListener('pointerdown', (e) => startCsvColumnResize(doc, col, e));
        handle.addEventListener('click', (e) => e.stopPropagation());
        th.addEventListener('click', (e) => {
            if (e.target && e.target.closest && e.target.closest('.csv-col-resize')) return;
            if (doc !== deps.file) return;
            doc.csvActiveCol = col;
            const csvView = ensureCsvView(doc);
            if (csvView.sortCol === col) {
                csvView.sortDir = csvView.sortDir === 1 ? -1 : (csvView.sortDir === -1 ? 0 : 1);
                if (csvView.sortDir === 0) csvView.sortCol = -1;
            } else {
                csvView.sortCol = col;
                csvView.sortDir = 1;
            }
            renderCsvTableView(doc, {resetScroll: true});
        });
        th.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            doc.csvActiveCol = col;
            if (!deps.ctxMenu) return;
            const csvView = ensureCsvView(doc);
            deps.ctxMenu.open([
                {
                    label: '升序排序',
                    icon: 'E70D',
                    action: () => {
                        csvView.sortCol = col;
                        csvView.sortDir = 1;
                        renderCsvTableView(doc, {resetScroll: true});
                    },
                },
                {
                    label: '降序排序',
                    icon: 'E70E',
                    action: () => {
                        csvView.sortCol = col;
                        csvView.sortDir = -1;
                        renderCsvTableView(doc, {resetScroll: true});
                    },
                },
                {
                    label: '清除排序',
                    disabled: csvView.sortDir === 0,
                    action: () => {
                        csvView.sortCol = -1;
                        csvView.sortDir = 0;
                        renderCsvTableView(doc, {resetScroll: true});
                    },
                },
                {sep: true},
                {label: '列统计…', icon: 'E9D2', action: () => openCsvColumnStats(doc, col)},
            ], e.clientX, e.clientY);
        });
        th.append(label, handle);
        headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    if (virtual) {
        const topSpacer = document.createElement('tr');
        topSpacer.className = 'csv-spacer';
        topSpacer.appendChild(document.createElement('td'));
        const bottomSpacer = document.createElement('tr');
        bottomSpacer.className = 'csv-spacer';
        bottomSpacer.appendChild(document.createElement('td'));
        const colspanCell = (row) => {
            const cell = row.firstChild;
            cell.colSpan = headers.length + 1;
            cell.style.padding = '0';
            cell.style.border = '0';
            return cell;
        };
        colspanCell(topSpacer);
        colspanCell(bottomSpacer);
        tbody.append(topSpacer, bottomSpacer);
        doc.csvTBody = tbody;
        doc.csvTopSpacer = topSpacer;
        doc.csvBottomSpacer = bottomSpacer;
    } else {
        doc.csvTBody = tbody;
        doc.csvTopSpacer = null;
        doc.csvBottomSpacer = null;
    }
    const fragment = document.createDocumentFragment();
    const editable = !doc.large && !doc.binary && !deps.settings.readOnlyMode;
    if (!virtual) {
        for (let viewRow = 0; viewRow < shown; viewRow++) {
            const rowIndex = viewIndices ? viewIndices[viewRow] : viewRow;
            const row = rows[rowIndex] || [];
            const tr = document.createElement('tr');
            const num = document.createElement('td');
            num.className = 'csv-rownum';
            num.textContent = String(rowIndex + 1);
            tr.appendChild(num);
            for (let col = 0; col < headers.length; col++) {
                const td = document.createElement('td');
                td.className = 'csv-cell';
                const value = row[col];
                const display = value == null ? '' : String(value);
                td.textContent = display;
                td.title = display;
                if (editable) {
                    td.contentEditable = 'plaintext-only';
                    td.spellcheck = false;
                    td.dataset.row = String(rowIndex);
                    td.dataset.col = String(col);
                    td.dataset.vpos = String(viewRow);
                    td.addEventListener('focus', () => { doc.csvActiveCol = col; });
                    td.addEventListener('keydown', (e) => onCsvCellKeyDown(doc, e));
                    td.addEventListener('input', () => markCsvCellTyping(doc));
                    td.addEventListener('blur', () => commitCsvCell(doc, td));
                }
                tr.appendChild(td);
            }
            fragment.appendChild(tr);
        }
    }
    tbody.appendChild(fragment);
    table.appendChild(tbody);
    scroll.appendChild(table);
    scroll.scrollTop = keepTop;
    scroll.scrollLeft = keepLeft;
    if (virtual) {
        renderCsvVirtualRows(doc, true);
        if (scroll.scrollTop !== keepTop) {
            scroll.scrollTop = keepTop;
            renderCsvVirtualRows(doc, true);
        }
    }
}

function buildCsvColgroup(widths) {
    const group = document.createElement('colgroup');
    group.className = 'csv-colgroup';
    const rowCol = document.createElement('col');
    rowCol.style.width = deps.CSV_ROW_NUM_WIDTH + 'px';
    group.appendChild(rowCol);
    for (const width of widths) {
        const col = document.createElement('col');
        col.style.width = width + 'px';
        group.appendChild(col);
    }
    return group;
}

function applyCsvColumnLayout(doc) {
    if (!doc || doc !== deps.file || !doc.tableScroll || !doc.tableColWidths) return;
    const table = doc.tableScroll.querySelector('table.csv-table');
    if (!table) return;
    const headers = doc.tableHeaders || [];
    if (doc.tableColWidths.length !== headers.length) return;
    table.classList.add('fixed-layout');
    let group = table.querySelector('colgroup.csv-colgroup');
    if (!group || group.children.length !== doc.tableColWidths.length + 1) {
        if (group) group.remove();
        group = buildCsvColgroup(doc.tableColWidths);
        table.insertBefore(group, table.firstChild);
    } else {
        for (let i = 0; i < doc.tableColWidths.length; i++) {
            group.children[i + 1].style.width = doc.tableColWidths[i] + 'px';
        }
    }
    table.style.width = (deps.CSV_ROW_NUM_WIDTH + doc.tableColWidths.reduce((sum, w) => sum + w, 0)) + 'px';
}

function freezeCsvColumnWidths(doc) {
    if (!doc || doc !== deps.file || !doc.tableScroll) return;
    const headers = doc.tableHeaders || [];
    if (!headers.length) return;
    if (Array.isArray(doc.tableColWidths) && doc.tableColWidths.length === headers.length) return;
    const ths = Array.from(doc.tableScroll.querySelectorAll('thead th.csv-col-head'));
    if (ths.length !== headers.length) return;
    const zoom = doc.tableZoom || 1;
    doc.tableColWidths = ths.map((th) => Math.max(deps.CSV_COL_MIN_WIDTH, Math.round(th.getBoundingClientRect().width / zoom)));
    applyCsvColumnLayout(doc);
}

function startCsvColumnResize(doc, colIndex, e) {
    if (!doc || doc !== deps.file || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    freezeCsvColumnWidths(doc);
    if (!doc.tableColWidths || !doc.tableColWidths[colIndex]) return;
    try {
        e.currentTarget.setPointerCapture(e.pointerId);
    } catch (err) {}
    const startX = e.clientX;
    const startWidth = doc.tableColWidths[colIndex];
    const zoom = doc.tableZoom || 1;
    const onMove = (ev) => {
        const next = Math.max(deps.CSV_COL_MIN_WIDTH, Math.round(startWidth + (ev.clientX - startX) / zoom));
        if (next === doc.tableColWidths[colIndex]) return;
        doc.tableColWidths[colIndex] = next;
        applyCsvColumnLayout(doc);
    };
    const cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', cleanup);
        window.removeEventListener('pointercancel', cleanup);
        window.removeEventListener('blur', cleanup);
        document.body.classList.remove('csv-col-resizing');
    };
    document.body.classList.add('csv-col-resizing');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
    window.addEventListener('blur', cleanup);
}

function onCsvCellKeyDown(doc, e) {
    const td = e.currentTarget;
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        const row = doc.tableRows && doc.tableRows[Number(td.dataset.row)];
        const value = row && row[Number(td.dataset.col)] != null ? String(row[Number(td.dataset.col)]) : '';
        td.textContent = value;
        td.blur();
        return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        commitCsvCell(doc, td);
        focusAdjacentCsvCell(doc, td, (doc.tableHeaders || []).length || 1);
        return;
    }
    if (e.key === 'Tab') {
        e.preventDefault();
        commitCsvCell(doc, td);
        focusAdjacentCsvCell(doc, td, e.shiftKey ? -1 : 1);
    }
}

function focusAdjacentCsvCell(doc, td, offset) {
    if (!doc.tableScroll) return;
    if (doc.csvVirtual && td.dataset.vpos != null) {
        const targetPos = Number(td.dataset.vpos) + offset;
        const total = doc.csvViewTotal || 0;
        if (!(targetPos >= 0) || targetPos >= total) {
            td.blur();
            return;
        }
        const selector = 'td.csv-cell[data-vpos="' + targetPos + '"]';
        let target = doc.tableScroll.querySelector(selector);
        if (!target) {
            const rowH = doc.csvRowScreenH || (doc.csvRowLayoutH || CSV_DEFAULT_ROW_LAYOUT_H) * (doc.tableZoom || 1);
            doc.tableScroll.scrollTop = Math.max(0, targetPos * rowH - doc.tableScroll.clientHeight / 2);
            renderCsvVirtualRows(doc, true);
            target = doc.tableScroll.querySelector(selector);
        }
        if (!target) {
            td.blur();
            return;
        }
        target.focus();
        target.scrollIntoView({block: 'nearest', inline: 'nearest'});
        return;
    }
    const cells = doc.tableScroll.querySelectorAll('td.csv-cell');
    const index = Array.prototype.indexOf.call(cells, td);
    if (index < 0) return;
    const target = cells[index + offset];
    if (!target) {
        td.blur();
        return;
    }
    target.focus();
    target.scrollIntoView({block: 'nearest', inline: 'nearest'});
}

function csvCellText(td) {
    return String(td.innerText || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
}

function markCsvCellTyping(doc) {
    if (!doc || doc.dirty) return;
    if (deps.file === doc) {
        deps.setDirty(true, {noAutoSave: true});
    } else {
        doc.dirty = true;
        deps.updateTabDirty(doc);
        deps.updateBackendDirty();
    }
}

function flushCsvCellEditor() {
    if (deps.currentMode !== 'table') return;
    const active = document.activeElement;
    if (active && active.classList && active.classList.contains('csv-cell')) active.blur();
}

function serializeCsvTable(doc) {
    const text = doc.format.stringifyTable(doc.tableHeaders, doc.tableRows);
    return doc.tableTrailingNewline ? text + '\n' : text;
}

function applyCsvTableText(doc, text) {
    if (!doc || !doc.editor || doc.editor.getText() === text) return;
    const loading = doc.loading;
    doc.loading = true;
    try {
        doc.editor.setText(text);
        doc.text = text;
    } finally {
        doc.loading = loading;
    }
    markDocDirty(doc);
}

function commitCsvCell(doc, td) {
    if (!doc || doc !== deps.file || doc.large || deps.settings.readOnlyMode || !doc.tableRows || !doc.tableHeaders || !td) return;
    const rowIndex = Number(td.dataset.row);
    const colIndex = Number(td.dataset.col);
    const row = doc.tableRows[rowIndex];
    if (!row) return;
    const value = csvCellText(td);
    const before = row[colIndex] == null ? '' : String(row[colIndex]);
    td.textContent = value;
    td.title = value;
    if (value === before) {
        markDocDirty(doc);
        return;
    }
    row[colIndex] = value;
    applyCsvTableText(doc, serializeCsvTable(doc));
    doc.tableUndo.push({row: rowIndex, col: colIndex, before, after: value});
    if (doc.tableUndo.length > 100) doc.tableUndo.shift();
    doc.tableRedo.length = 0;
}

function tableHistory(action) {
    if (deps.currentMode !== 'table' || !deps.file || !deps.file.tableRows) return;
    const doc = deps.file;
    const active = document.activeElement;
    if (active && active.classList && active.classList.contains('csv-cell')) active.blur();
    if (!doc.tableUndo || !doc.tableRedo) return;
    const from = action === 'undo' ? doc.tableUndo : doc.tableRedo;
    const to = action === 'undo' ? doc.tableRedo : doc.tableUndo;
    if (!from.length) return;
    const op = from.pop();
    if (op.full) {
        applyCsvTableText(doc, action === 'undo' ? op.before : op.after);
        to.push(op);
        renderCsvTableView(doc);
        return;
    }
    const row = doc.tableRows[op.row];
    if (!row) {
        from.push(op);
        return;
    }
    row[op.col] = action === 'undo' ? op.before : op.after;
    to.push(op);
    applyCsvTableText(doc, serializeCsvTable(doc));
    renderCsvTableView(doc);
}

function createMarkdownPreview(doc) {
    if (doc.previewEl || !doc.pane) return;
    const wrap = document.createElement('div');
    wrap.className = 'md-preview-view';
    const scroll = document.createElement('div');
    scroll.className = 'md-preview-scroll';
    const body = document.createElement('div');
    body.className = 'md-preview';
    scroll.appendChild(body);
    wrap.appendChild(scroll);
    doc.pane.appendChild(wrap);
    doc.previewEl = wrap;
    doc.previewScroll = scroll;
    doc.previewBody = body;
    wrap.addEventListener('click', (e) => {
        const a = e.target.closest('a');
        if (!a) return;
        const href = a.getAttribute('href') || '';
        if (!href || href.startsWith('#')) return;
        e.preventDefault();
        if (!/^(https?:|mailto:)/i.test(href)) return;
        if (deps.rt && deps.rt.BrowserOpenURL) deps.rt.BrowserOpenURL(href);
        else window.open(href, '_blank', 'noopener');
    });
}

function renderMarkdownPreview(doc, opts = {}) {
    if (!doc || !doc.editor || !doc.previewBody) return;
    const scrollTop = doc.previewScroll ? doc.previewScroll.scrollTop : 0;
    try {
        const patched = !!(opts.incremental && patchMarkdownPreview(doc));
        if (!patched) doc.previewBody.innerHTML = renderMarkdownBlocksHtml(doc.editor.getText());
        deps.resolveMarkdownImages(doc);
    } catch (e) {
        doc.previewBody.textContent = 'Markdown 渲染失败：' + e.message;
    }
    if (doc.previewScroll) doc.previewScroll.scrollTop = scrollTop;
    mdSyncScrollFromAce(doc);
    deps.renderMermaidBlocks(doc.previewBody);
}

function showMarkdownPreview(doc) {
    if (!doc || !doc.format.preview) return;
    createMarkdownPreview(doc);
    if (doc.pane) doc.pane.classList.add('preview-active');
    renderMarkdownPreview(doc);
}

function hideMarkdownPreview(doc) {
    if (!doc || !doc.pane) return;
    doc.pane.classList.remove('preview-active');
    if (doc === deps.file && doc.editor && doc.editor.aceEditor) {
        try {
            doc.editor.aceEditor.resize();
        } catch (e) {}
    }
}

function enterMarkdownPreview(doc) {
    if (!doc || !doc.format.preview || !doc.editor) return;
    if (doc.large) {
        deps.flash('大文件不支持 Markdown 预览', true);
        return;
    }
    const text = doc.editor.getText();
    doc.loading = true;
    try {
        doc.editor.setMode('code');
        doc.editor.setText(text);
        doc.text = text;
        if (!doc.dirty && doc.bases.preview == null) doc.bases.preview = text;
        doc.mode = 'preview';
        deps.currentMode = 'preview';
        showMarkdownPreview(doc);
        updateStatus();
        deps.updateSearchState();
    } catch (e) {
        deps.flash('切换预览失败：' + e.message, true);
    } finally {
        doc.loading = false;
    }
}

function leaveMarkdownPreview(doc, mode) {
    if (!doc || !doc.editor) return;
    hideMarkdownPreview(doc);
    doc.mode = mode;
    deps.currentMode = mode;
    const loading = doc.loading;
    doc.loading = true;
    try {
        doc.editor.setMode(mode);
    } catch (e) {
        deps.flash('切换视图失败：' + e.message, true);
    } finally {
        doc.loading = loading;
    }
    // 预览底层编辑器本来就是 code 模式，setMode('code') 不会触发 onModeChange，
    // 必须显式应用 Markdown 等语法模式（否则残留 jsoneditor 默认 JSON 模式）
    if (doc === deps.file && mode === 'code') applyAceMode(true);
    updateStatus();
    deps.updateSearchState();
}

// ---- 单标签页分屏：左源码 / 右预览 ----

function splitRatioFor(doc) {
    const r = Number(doc && doc.splitRatio != null ? doc.splitRatio : deps.settings.splitRatio);
    return Number.isFinite(r) ? Math.min(0.85, Math.max(0.15, r)) : 0.5;
}

function ensureSplitDivider(doc) {
    if (doc.splitDivider || !doc.pane) return;
    const bar = document.createElement('div');
    bar.className = 'vp-split-divider';
    bar.title = '拖动调整左右宽度';
    doc.pane.appendChild(bar);
    bar.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || !doc.pane) return;
        const rect = doc.pane.getBoundingClientRect();
        if (rect.width < 40) return;
        const startX = e.clientX;
        const startRatio = splitRatioFor(doc);
        deps.setDragCursor('ew');
        document.body.style.userSelect = 'none';
        const move = (ev) => {
            const ratio = Math.min(0.85, Math.max(0.15, startRatio + (ev.clientX - startX) / rect.width));
            doc.splitRatio = ratio;
            doc.pane.style.setProperty('--split-ratio', String(ratio));
            if (!doc._splitResizePending) {
                doc._splitResizePending = true;
                requestAnimationFrame(() => {
                    doc._splitResizePending = false;
                    if (doc.editor && doc.editor.aceEditor) {
                        try { doc.editor.aceEditor.resize(); } catch (err) {}
                    }
                });
            }
        };
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            deps.setDragCursor(null);
            document.body.style.userSelect = '';
            deps.settings.splitRatio = doc.splitRatio;
            try { localStorage.setItem(deps.settingsKey, JSON.stringify(deps.settings)); } catch (err) {}
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        e.preventDefault();
    });
    doc.splitDivider = bar;
}

// ---- Markdown 分屏滚动同步：左源码滚动 → 右预览按比例跟随（单向，不回环） ----

function mdSyncScrollFromAce(doc) {
    if (!doc || !doc.splitActive || doc.splitKind !== 'markdown') return;
    if (deps.settings.mdScrollSync === false) return;
    const scroll = doc.previewScroll;
    const ace = doc.editor && doc.editor.aceEditor;
    if (!scroll || !ace) return;
    let ratio = 0;
    try {
        // 比例统一用屏幕坐标系（像素同源）：文档行经 documentToScreenRow 转换，
        // 否则开启自动换行时与反向（预览→源码按像素驱动）的坐标系不一致
        const firstDoc = ace.getFirstVisibleRow();
        const first = ace.session.documentToScreenRow(firstDoc, 0);
        const last = ace.session.documentToScreenRow(ace.getLastVisibleRow(), 0);
        const visRows = Math.max(1, last - first + 1);
        const denom = ace.session.getScreenLength() - visRows;
        ratio = denom > 0 ? Math.min(1, Math.max(0, first / denom)) : 0;
    } catch (e) {
        return;
    }
    const max = scroll.scrollHeight - scroll.clientHeight;
    if (max <= 0) return;
    doc._previewEcho = Math.round(ratio * max);
    scroll.scrollTop = doc._previewEcho;
}

// 反方向：预览滚动 → 源码跟随。该内核 session.setScrollTop 收像素
// （scrollToLine 内部就是 getPixelPosition(row).top 直接喂给 setScrollTop）。
function mdSyncScrollFromPreview(doc) {
    if (!doc || !doc.splitActive || doc.splitKind !== 'markdown') return;
    if (deps.settings.mdScrollSync === false) return;
    const scroll = doc.previewScroll;
    const ace = doc.editor && doc.editor.aceEditor;
    if (!scroll || !ace) return;
    const denom = scroll.scrollHeight - scroll.clientHeight;
    if (denom <= 0) return;
    const ratio = Math.min(1, Math.max(0, scroll.scrollTop / denom));
    try {
        const lineHeight = ace.renderer.lineHeight || 16;
        const scroller = ace.renderer.scroller || ace.container;
        const maxPx = Math.max(0, ace.session.getScreenLength() * lineHeight - scroller.clientHeight);
        if (maxPx <= 0) return;
        doc._aceEcho = Math.round(ratio * maxPx);
        ace.session.setScrollTop(doc._aceEcho);
    } catch (e) {}
}

// hookPreviewScrollSync 监听预览滚动做反向同步；自激事件（左源码写入引起）值与
// _previewEcho 相同，直接忽略，防止两侧互相追逐。
function hookPreviewScrollSync(doc) {
    const scroll = doc && doc.previewScroll;
    if (!scroll || doc._splitPreviewHooked === scroll) return;
    doc._splitPreviewHooked = scroll;
    const onScroll = () => {
        if (!doc.splitActive || doc.splitKind !== 'markdown') return;
        if (deps.settings.mdScrollSync === false) return;
        if (Math.round(scroll.scrollTop) === doc._previewEcho) return;
        mdSyncScrollFromPreview(doc);
    };
    scroll.addEventListener('scroll', onScroll);
    doc._splitPreviewDetach = () => {
        scroll.removeEventListener('scroll', onScroll);
        doc._splitPreviewHooked = null;
        doc._splitPreviewDetach = null;
    };
}

// hookSplitScrollSync 挂 Ace 滚动监听；setMode 可能更换 session，用 changeSession 重新挂。
// changeScrollTop 触发时渲染层还没更新到新位置，延一帧再读，否则比例会慢一拍。
function hookSplitScrollSync(doc) {
    const ace = doc && doc.editor && doc.editor.aceEditor;
    if (!ace || doc._splitSyncAce === ace) return;
    unhookSplitScrollSync(doc);
    // changeScrollTop 回调参数就是滚动值（像素）：预览反向驱动写入的值与 _aceEcho 相同，忽略
    const onScroll = (top) => {
        if (top != null && Math.round(top) === doc._aceEcho) return;
        if (doc._splitSyncRaf) cancelAnimationFrame(doc._splitSyncRaf);
        doc._splitSyncRaf = requestAnimationFrame(() => {
            doc._splitSyncRaf = 0;
            mdSyncScrollFromAce(doc);
        });
    };
    const attach = (sess) => {
        if (!sess || sess === doc._splitSyncSession) return;
        detachSession();
        doc._splitSyncSession = sess;
        sess.on('changeScrollTop', onScroll);
    };
    const detachSession = () => {
        if (doc._splitSyncSession) {
            try { doc._splitSyncSession.off('changeScrollTop', onScroll); } catch (e) {}
            doc._splitSyncSession = null;
        }
    };
    const onSession = (e) => attach(e && e.session ? e.session : ace.session);
    doc._splitSyncAce = ace;
    doc._splitSyncDetach = () => {
        detachSession();
        try { ace.off('changeSession', onSession); } catch (e) {}
    };
    attach(ace.session);
    ace.on('changeSession', onSession);
}

function unhookSplitScrollSync(doc) {
    if (doc && doc._splitSyncDetach) {
        try { doc._splitSyncDetach(); } catch (e) {}
    }
    if (doc) {
        if (doc._splitSyncRaf) {
            cancelAnimationFrame(doc._splitSyncRaf);
            doc._splitSyncRaf = 0;
        }
        doc._splitSyncAce = null;
        doc._splitSyncDetach = null;
        doc._splitSyncSession = null;
    }
}

function createHtmlPreviewView(doc) {
    if (doc.htmlPreviewEl || !doc.pane) return;
    const wrap = document.createElement('div');
    wrap.className = 'html-preview-view';
    const frame = document.createElement('iframe');
    frame.className = 'html-preview-frame';
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = doc.name || 'HTML 预览';
    wrap.appendChild(frame);
    doc.pane.appendChild(wrap);
    doc.htmlPreviewEl = wrap;
    doc.htmlFrame = frame;
}

function relativeDirUrl(root, filePath) {
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const r = norm(root);
    const d = norm(deps.parentFolderOf(filePath));
    if (!r || !d) return '';
    if (d.toLowerCase() === r.toLowerCase()) return '';
    if (!d.toLowerCase().startsWith(r.toLowerCase() + '/')) return '';
    return d.slice(r.length + 1).split('/').filter(Boolean).map(encodeURIComponent).join('/') + '/';
}

async function ensureHtmlPreviewRoot(doc) {
    if (doc.htmlPreviewRoot || !doc.path || !deps.backend.RegisterPreviewRoot) return;
    let root = '';
    if (deps.workspaceFolder && deps.pathWithinValue(deps.workspaceFolder, doc.path)) root = deps.workspaceFolder;
    else root = deps.parentFolderOf(doc.path);
    if (!root) return;
    try {
        const token = await deps.backend.RegisterPreviewRoot(root);
        if (token) doc.htmlPreviewRoot = {root, token};
    } catch (e) {}
}

function injectHtmlBase(text, baseTag) {
    const src = String(text || '');
    if (!baseTag) return src;
    const doctype = /^\s*<!doctype[^>]*>/i.exec(src);
    if (doctype) return src.slice(0, doctype[0].length) + baseTag + src.slice(doctype[0].length);
    return baseTag + src;
}

function renderHtmlPreview(doc) {
    if (!doc || !doc.htmlFrame || !doc.editor) return;
    const apply = () => {
        if (!doc.htmlFrame || !doc.editor) return;
        let base = '<base target="_blank">';
        if (doc.htmlPreviewRoot) {
            const sub = relativeDirUrl(doc.htmlPreviewRoot.root, doc.path);
            base = '<base href="/__local/' + doc.htmlPreviewRoot.token + '/' + sub + '" target="_blank">';
        }
        doc.htmlFrame.srcdoc = injectHtmlBase(doc.editor.getText(), base);
    };
    if (doc.htmlPreviewRoot || doc.htmlRootTried || !doc.path) {
        apply();
        return;
    }
    doc.htmlRootTried = true;
    ensureHtmlPreviewRoot(doc).then(apply).catch(() => apply());
}

// SVG 渲染用的源文本：渲染视图下 jsoneditor 可能已把树值序列化成 JSON 填进编辑器，
// 真源保存在 _svgSrcText；其余情况以编辑器文本为准，最后回退打开时的原文。
function svgSourceFor(doc) {
    if (!doc) return '';
    if (doc.mode === 'render' && doc._svgSrcText != null && doc._svgSrcText.trim()) return doc._svgSrcText;
    let text = '';
    try { text = doc.editor ? doc.editor.getText() : ''; } catch (e) { text = ''; }
    if (!text.trim() && doc._svgSrcText != null && doc._svgSrcText.trim()) text = doc._svgSrcText;
    if (!text.trim() && doc.rawText != null) text = doc.rawText;
    return text;
}

function looksLikeSvg(text) {
    return /<svg[\s>]/i.test(String(text || ''));
}

// 渲染失败时隐藏 <img> 并在画布中央显示原因，避免只剩一片空白（图片 onerror 原本没有处理）
function setSvgRenderError(doc, message) {
    if (!doc || !doc.svgRenderImg) return;
    const status = doc.svgRenderStatus;
    if (!message) {
        doc.svgRenderError = '';
        doc.svgRenderImg.style.display = '';
        if (status) {
            status.classList.add('hidden');
            status.textContent = '';
        }
        return;
    }
    doc.svgRenderError = message;
    doc.svgRenderImg.style.display = 'none';
    if (status) {
        status.textContent = message;
        status.classList.remove('hidden');
    }
}

function renderSplitSvg(doc) {
    if (!doc || !doc.svgRenderImg || !doc.editor) return;
    const text = svgSourceFor(doc);
    if (!text || !text.trim()) {
        setSvgRenderError(doc, '当前没有可渲染的 SVG 源码');
        return;
    }
    if (!looksLikeSvg(text)) {
        setSvgRenderError(doc, '当前源码不是 SVG（缺少 <svg> 根元素），已停止渲染');
        return;
    }
    setSvgRenderError(doc, '');
    doc.svgRenderImg.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
}

function renderSplitPreview(doc) {
    if (!doc || !doc.splitActive) return;
    if (doc.splitKind === 'markdown') renderMarkdownPreview(doc, {incremental: true});
    else if (doc.splitKind === 'svg') renderSplitSvg(doc);
    else if (doc.splitKind === 'html') renderHtmlPreview(doc);
}

function scheduleSplitPreview(doc) {
    if (!doc || !doc.splitActive) return;
    clearTimeout(doc.splitTimer);
    doc.splitTimer = setTimeout(() => {
        doc.splitTimer = 0;
        renderSplitPreview(doc);
    }, doc.splitKind === 'html' ? 350 : 160);
}

function enterSplitView(doc) {
    if (!doc || !doc.editor) return;
    const kind = deps.splitKindFor(doc);
    if (!kind) {
        deps.flash('当前文件不支持分屏预览', true);
        return;
    }
    if (doc.large || doc.binary) {
        deps.flash('大文件不支持分屏预览', true);
        return;
    }
    if (doc.splitActive) {
        if (doc.pane) doc.pane.style.setProperty('--split-ratio', String(splitRatioFor(doc)));
        renderSplitPreview(doc);
        if (kind === 'markdown') {
            hookSplitScrollSync(doc);
            hookPreviewScrollSync(doc);
            mdSyncScrollFromAce(doc);
        }
        setTimeout(() => {
            if (doc.editor && doc.editor.aceEditor) {
                try { doc.editor.aceEditor.resize(); } catch (e) {}
            }
        }, 0);
        return;
    }
    const loading = doc.loading;
    doc.loading = true;
    try {
        let src = null;
        if (kind === 'svg' && doc.mode === 'tree') {
            try { src = doc.format.stringify(doc.editor.get()); } catch (e) {}
        }
        // 从渲染视图切分屏时真源是 _svgSrcText：走到这里时编辑器文本可能已经被序列化成 JSON
        if (src == null) src = kind === 'svg' ? svgSourceFor(doc) : doc.editor.getText();
        doc.editor.setMode('code');
        if (kind === 'svg') doc.editor.setText(src);
        doc.text = doc.editor.getText();
        if (!doc.dirty) doc.bases.code = doc.text;
        doc.mode = 'code';
        deps.currentMode = 'code';
        if (doc.pane) {
            doc.pane.classList.remove('preview-active', 'svg-render-active');
            doc.pane.classList.add('split-active');
            doc.pane.classList.toggle('split-markdown', kind === 'markdown');
            doc.pane.classList.toggle('split-svg', kind === 'svg');
            doc.pane.classList.toggle('split-html', kind === 'html');
            doc.pane.style.setProperty('--split-ratio', String(splitRatioFor(doc)));
        }
        if (kind === 'markdown') createMarkdownPreview(doc);
        else if (kind === 'svg') createSvgRenderView(doc);
        else if (kind === 'html') createHtmlPreviewView(doc);
        ensureSplitDivider(doc);
        doc.splitKind = kind;
        doc.splitActive = true;
        renderSplitPreview(doc);
        if (kind === 'markdown') {
            hookSplitScrollSync(doc);
            hookPreviewScrollSync(doc);
        }
        applyAceMode(true);
        showBanner(doc, doc.parseError);
        updateStatus();
        deps.updateSearchState();
    } catch (e) {
        deps.flash('打开分屏失败：' + e.message, true);
    } finally {
        doc.loading = loading;
    }
    setTimeout(() => {
        if (doc.splitActive && doc.editor && doc.editor.aceEditor) {
            try { doc.editor.aceEditor.resize(); } catch (e) {}
        }
    }, 0);
}

function exitSplitView(doc) {
    if (!doc || !doc.splitActive) return;
    doc.splitActive = false;
    doc.splitKind = '';
    clearTimeout(doc.splitTimer);
    doc.splitTimer = 0;
    unhookSplitScrollSync(doc);
    if (doc._splitPreviewDetach) {
        try { doc._splitPreviewDetach(); } catch (e) {}
    }
    if (doc.htmlFrame) doc.htmlFrame.srcdoc = '';
    if (doc.splitDivider) {
        doc.splitDivider.remove();
        doc.splitDivider = null;
    }
    if (doc.pane) {
        doc.pane.classList.remove('split-active', 'split-markdown', 'split-svg', 'split-html');
        doc.pane.style.removeProperty('--split-ratio');
    }
    if (doc.editor && doc.editor.aceEditor) {
        try { doc.editor.aceEditor.resize(); } catch (e) {}
    }
    syncTabViewTools();
}

function createImageView(doc) {
    if (doc.imageEl || !doc.pane) return;
    const wrap = document.createElement('div');
    wrap.className = 'image-preview-view';
    const scroll = document.createElement('div');
    scroll.className = 'image-preview-scroll';
    const canvas = document.createElement('div');
    canvas.className = 'image-preview-canvas';
    const status = document.createElement('div');
    status.className = 'image-preview-status';
    status.textContent = '正在加载图片…';
    const img = document.createElement('img');
    img.className = 'image-preview-img';
    img.alt = doc.name;
    img.draggable = false;
    img.hidden = true;
    img.addEventListener('load', () => {
        doc.imageWidth = img.naturalWidth;
        doc.imageHeight = img.naturalHeight;
        doc.imageError = null;
        img.hidden = false;
        status.classList.add('hidden');
        applyImageZoom(doc);
        if (doc === deps.file) updateStatus();
    });
    img.addEventListener('error', () => {
        img.hidden = true;
        doc.imageError = '无法解码该图片';
        status.textContent = '无法预览此图片，可切换到二进制视图';
        status.classList.remove('hidden');
        if (doc === deps.file && deps.currentMode === 'image') {
            deps.flash('图片无法预览，已切换到二进制视图', true);
            deps.switchMode('binary');
        }
    });
    canvas.appendChild(img);
    scroll.append(canvas, status);
    wrap.appendChild(scroll);
    doc.pane.appendChild(wrap);
    doc.imageEl = wrap;
    doc.imageScroll = scroll;
    doc.imageCanvas = canvas;
    doc.imageNode = img;
    doc.imageStatus = status;

    scroll.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (scroll.scrollWidth <= scroll.clientWidth + 1 && scroll.scrollHeight <= scroll.clientHeight + 1) return;
        e.preventDefault();
        doc.imagePan = {id: e.pointerId, x: e.clientX, y: e.clientY, left: scroll.scrollLeft, top: scroll.scrollTop};
        scroll.classList.add('panning');
        try {
            scroll.setPointerCapture(e.pointerId);
        } catch (err) {}
    });
    scroll.addEventListener('pointermove', (e) => {
        const pan = doc.imagePan;
        if (!pan || e.pointerId !== pan.id) return;
        scroll.scrollLeft = pan.left - (e.clientX - pan.x);
        scroll.scrollTop = pan.top - (e.clientY - pan.y);
    });
    const endPan = (e) => {
        if (!doc.imagePan || (e && e.pointerId !== doc.imagePan.id)) return;
        doc.imagePan = null;
        scroll.classList.remove('panning');
    };
    scroll.addEventListener('pointerup', endPan);
    scroll.addEventListener('pointercancel', endPan);
    scroll.addEventListener('dblclick', () => {
        if (!doc.imageWidth) return;
        doc.imageZoom = null;
        applyImageZoom(doc);
    });
    if (typeof ResizeObserver === 'function') {
        doc.imageResizeObserver = new ResizeObserver(() => {
            if (doc === deps.file && deps.currentMode === 'image') applyImageZoom(doc);
        });
        doc.imageResizeObserver.observe(scroll);
    }
}

function applyImageZoom(doc) {
    if (!doc || !doc.imageNode || !doc.imageScroll || !doc.imageWidth || !doc.imageHeight) return;
    const scroll = doc.imageScroll;
    const width = scroll.clientWidth;
    const height = scroll.clientHeight;
    if (width < 20 || height < 20) return;
    const availableWidth = Math.max(1, width - 48);
    const availableHeight = Math.max(1, height - 48);
    const scale = doc.imageZoom == null
        ? Math.min(1, availableWidth / doc.imageWidth, availableHeight / doc.imageHeight)
        : doc.imageZoom;
    const previous = doc.imageScale || 0;
    const centerX = scroll.scrollLeft + width / 2;
    const centerY = scroll.scrollTop + height / 2;
    doc.imageScale = scale;
    doc.imageNode.style.width = Math.max(1, Math.round(doc.imageWidth * scale)) + 'px';
    doc.imageNode.style.height = Math.max(1, Math.round(doc.imageHeight * scale)) + 'px';
    if (previous > 0 && Math.abs(scale - previous) > 0.0001) {
        const ratio = scale / previous;
        requestAnimationFrame(() => {
            if (!doc.imageScroll) return;
            doc.imageScroll.scrollLeft = Math.max(0, centerX * ratio - width / 2);
            doc.imageScroll.scrollTop = Math.max(0, centerY * ratio - height / 2);
        });
    }
    requestAnimationFrame(() => {
        if (!doc.imageScroll) return;
        const canPan = doc.imageScroll.scrollWidth > doc.imageScroll.clientWidth + 1 ||
            doc.imageScroll.scrollHeight > doc.imageScroll.clientHeight + 1;
        doc.imageScroll.classList.toggle('can-pan', canPan);
    });
    if (doc === deps.file) updateStatus();
}

function zoomImageBy(doc, deltaY) {
    if (!doc || !doc.imageWidth || !deltaY) return;
    const base = doc.imageScale || 1;
    const factor = deltaY < 0 ? 1.1 : 1 / 1.1;
    doc.imageZoom = Math.min(8, Math.max(0.05, Math.round(base * factor * 1000) / 1000));
    applyImageZoom(doc);
}

function loadImagePreview(doc) {
    if (!doc || !doc.image) return;
    createImageView(doc);
    if (!doc.imageNode) return;
    if (doc.imageUrl) {
        doc.imageStatus.classList.add('hidden');
        if (doc.imageNode.getAttribute('src') !== doc.imageUrl) doc.imageNode.src = doc.imageUrl;
        applyImageZoom(doc);
        return;
    }
    if (doc.imageLoading) return;
    doc.imageLoading = true;
    doc.imageError = null;
    doc.imageStatus.textContent = '正在加载图片…';
    doc.imageStatus.classList.remove('hidden');
    doc.imageNode.hidden = true;
    const load = deps.backend.ReadImageDataURL
        ? deps.backend.ReadImageDataURL(doc.path)
        : Promise.reject(new Error('当前后端不支持图片预览'));
    Promise.resolve(load).then((url) => {
        doc.imageLoading = false;
        if (!url || !doc.imageNode) throw new Error('图片数据为空');
        doc.imageUrl = url;
        doc.imageNode.src = url;
    }).catch((err) => {
        doc.imageLoading = false;
        doc.imageError = (err && err.message) || String(err);
        if (!doc.imageStatus) return;
        doc.imageStatus.textContent = '无法预览此图片：' + doc.imageError;
        doc.imageStatus.classList.remove('hidden');
        if (doc === deps.file && deps.currentMode === 'image') {
            deps.flash('图片无法预览，已切换到二进制视图', true);
            deps.switchMode('binary');
        }
    });
}

function applySvgZoom(doc) {
    if (!doc || !doc.svgRenderImg || !doc.svgRenderScroll || !doc.svgRenderW || !doc.svgRenderH) return;
    const scroll = doc.svgRenderScroll;
    const width = scroll.clientWidth;
    const height = scroll.clientHeight;
    if (width < 20 || height < 20) return;
    const availableWidth = Math.max(1, width - 36);
    const availableHeight = Math.max(1, height - 36);
    const scale = doc.svgRenderZoom == null
        ? Math.min(1, availableWidth / doc.svgRenderW, availableHeight / doc.svgRenderH)
        : doc.svgRenderZoom;
    const previous = doc.svgRenderScale || 0;
    const centerX = scroll.scrollLeft + width / 2;
    const centerY = scroll.scrollTop + height / 2;
    doc.svgRenderScale = scale;
    doc.svgRenderImg.style.width = Math.max(1, Math.round(doc.svgRenderW * scale)) + 'px';
    doc.svgRenderImg.style.height = Math.max(1, Math.round(doc.svgRenderH * scale)) + 'px';
    if (previous > 0 && Math.abs(scale - previous) > 0.0001) {
        const ratio = scale / previous;
        requestAnimationFrame(() => {
            if (!doc.svgRenderScroll) return;
            scroll.scrollLeft = Math.max(0, centerX * ratio - width / 2);
            scroll.scrollTop = Math.max(0, centerY * ratio - height / 2);
        });
    }
    if (doc === deps.file) updateStatus();
}

function zoomSvgRenderBy(doc, deltaY) {
    if (!doc || !doc.svgRenderW || !deltaY) return;
    const base = doc.svgRenderScale || 1;
    const factor = deltaY < 0 ? 1.1 : 1 / 1.1;
    doc.svgRenderZoom = Math.min(8, Math.max(0.05, Math.round(base * factor * 1000) / 1000));
    applySvgZoom(doc);
}

function showSvgRender(doc) {
    createSvgRenderView(doc);
    if (doc.pane) doc.pane.classList.add('svg-render-active');
    if (!doc.svgRenderImg || !doc.editor) return;
    // 真源优先用进入渲染视图时保存的 _svgSrcText（树模式下 getText() 是 JSON 序列化）
    const svgText = svgSourceFor(doc);
    if (!svgText || !svgText.trim()) {
        setSvgRenderError(doc, '当前没有可渲染的 SVG 源码');
        return;
    }
    if (!looksLikeSvg(svgText)) {
        setSvgRenderError(doc, '当前内容不是 SVG（缺少 <svg> 根元素），已停止渲染');
        return;
    }
    setSvgRenderError(doc, '');
    doc.svgRenderImg.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
}

function hideSvgRender(doc) {
    if (!doc || !doc.pane) return;
    doc.pane.classList.remove('svg-render-active');
}

function enterSvgRender(doc) {
    if (!doc || !doc.editor) return;
    doc.loading = true;
    try {
        // 记录退出渲染视图时的 SVG 源文本：
        // 树模式下 getText() 是树值的 JSON 序列化，必须用 format.stringify 还原 XML 源
        let src = null;
        if (doc.mode === 'tree') {
            try { src = doc.format.stringify(doc.editor.get()); } catch (e) {}
        }
        if (!src || !src.trim()) src = doc.editor.getText();
        if (!src || !src.trim()) src = doc.rawText != null ? doc.rawText : (doc.content || '');
        doc._svgSrcText = src;
        doc.editor.setMode('code');
        // setMode('code') 会把树值序列化成 JSON 填进编辑器，必须立刻写回 SVG 源文本，
        // 否则随后切分屏/保存拿到的都是 JSON（渲染本身正常，分屏则整片空白）
        doc.editor.setText(src);
        doc.text = src;
        if (!doc.dirty) doc.bases.code = src;
        doc.mode = 'render';
        deps.currentMode = 'render';
        showSvgRender(doc);
        showBanner(doc, doc.parseError);
        updateStatus();
        deps.updateSearchState();
    } finally {
        doc.loading = false;
    }
}

function createSvgRenderView(doc) {
    if (doc.svgRenderEl || !doc.pane) return;
    const wrap = document.createElement('div');
    wrap.className = 'svg-render-view';
    const scroll = document.createElement('div');
    scroll.className = 'svg-render-scroll';
    const img = document.createElement('img');
    img.className = 'svg-render-img';
    img.alt = doc.name || 'SVG';
    img.onload = () => {
        doc.svgRenderW = img.naturalWidth || 240;
        doc.svgRenderH = img.naturalHeight || 120;
        setSvgRenderError(doc, '');
        applySvgZoom(doc);
    };
    img.onerror = () => setSvgRenderError(doc, 'SVG 渲染失败：浏览器无法解码该内容');
    const status = document.createElement('div');
    status.className = 'svg-render-status hidden';
    scroll.append(img, status);
    doc.svgRenderScroll = scroll;
    doc.svgRenderStatus = status;
    wrap.appendChild(scroll);
    doc.pane.appendChild(wrap);
    doc.svgRenderEl = wrap;
    doc.svgRenderImg = img;
}

function showImageView(doc) {
    if (!doc || !doc.image) return;
    createImageView(doc);
    if (doc.pane) doc.pane.classList.add('image-active');
    loadImagePreview(doc);
}

function hideImageView(doc) {
    if (!doc || !doc.pane) return;
    doc.pane.classList.remove('image-active');
}

function enterImageView(doc) {
    if (!doc || !doc.image || !doc.editor) return;
    doc.loading = true;
    try {
        doc.editor.setMode('code');
        doc.mode = 'image';
        deps.currentMode = 'image';
        showImageView(doc);
        showBanner(doc, doc.parseError);
        updateStatus();
        deps.updateSearchState();
    } finally {
        doc.loading = false;
    }
}

function enterBinaryView(doc) {
    if (!doc || !doc.binary || !doc.editor) return;
    hideImageView(doc);
    doc.mode = 'binary';
    deps.currentMode = 'binary';
    const loading = doc.loading;
    doc.loading = true;
    try {
        doc.editor.setMode('code');
    } catch (e) {
        deps.flash('切换二进制视图失败：' + e.message, true);
    } finally {
        doc.loading = loading;
    }
    if (doc.pane) doc.pane.classList.add('active');
    applyAceMode();
    showBanner(doc, doc.parseError);
    updateStatus();
    deps.updateSearchState();
    try {
        if (doc.editor.aceEditor) doc.editor.aceEditor.resize();
    } catch (e) {}
}

function enterTextView(doc) {
    if (!doc || !doc.editor) return;
    hideImageView(doc);
    const loading = doc.loading;
    doc.loading = true;
    try {
        doc.editor.setMode('text');
        doc.mode = 'text';
        deps.currentMode = 'text';
        if (doc.pane) doc.pane.classList.add('active');
        showBanner(doc, doc.parseError);
        updateStatus();
        deps.updateSearchState();
    } catch (e) {
        deps.flash('切换文本视图失败：' + e.message, true);
    } finally {
        doc.loading = loading;
    }
    deps.applyReadOnlyToDoc(doc);
}

function showCsvTableView(doc) {
    if (!doc || !doc.format.table) return;
    createCsvTableView(doc);
    if (doc.pane) doc.pane.classList.add('table-active');
    renderCsvTableView(doc);
}

function hideCsvTableView(doc) {
    if (!doc || !doc.pane) return;
    doc.pane.classList.remove('table-active');
    if (doc === deps.file && doc.editor && doc.editor.aceEditor) {
        try {
            doc.editor.aceEditor.resize();
        } catch (e) {}
    }
}

function enterCsvTable(doc) {
    if (!doc || !doc.format.table || !doc.editor) return;
    let text;
    try {
        text = deps.currentMode === 'tree' ? doc.format.stringify(doc.editor.get()) : doc.editor.getText();
    } catch (e) {
        deps.flash('无法生成 CSV 表格：' + e.message, true);
        return;
    }
    doc.loading = true;
    try {
        doc.editor.setMode('text');
        doc.editor.setText(text);
        doc.text = text;
        if (!doc.dirty && doc.bases.table == null) doc.bases.table = text;
        doc.mode = 'table';
        deps.currentMode = 'table';
        doc.tableUndo = [];
        doc.tableRedo = [];
        showCsvTableView(doc);
        updateStatus();
        deps.updateSearchState();
    } catch (e) {
        deps.flash('切换表格视图失败：' + e.message, true);
    } finally {
        doc.loading = false;
    }
}

function leaveCsvTable(doc, mode) {
    if (!doc || !doc.editor) return;
    if (mode === 'text') {
        hideCsvTableView(doc);
        doc.mode = 'text';
        deps.currentMode = 'text';
        try {
            doc.editor.setMode('text');
        } catch (e) {}
        updateStatus();
        deps.updateSearchState();
        return;
    }
    if (mode !== 'tree') return;
    const text = doc.editor.getText();
    let value;
    try {
        value = doc.format.parse(text);
    } catch (e) {
        deps.flash('CSV 解析失败：' + e.message, true);
        return;
    }
    doc.loading = true;
    try {
        doc.editor.setText(JSON.stringify(value, null, 2));
        doc.editor.setMode('tree');
        doc.editor.set(value);
        hideCsvTableView(doc);
        doc.mode = 'tree';
        deps.currentMode = 'tree';
        updateStatus();
        deps.updateSearchState();
    } catch (e) {
        deps.flash('切换树视图失败：' + e.message, true);
    } finally {
        doc.loading = false;
    }
}

// ---------- 大文件只读 SQL 查询视图 ----------

function sqlKindFor(doc) {
    if (!doc) return '';
    if (doc.format && doc.format.id === 'jsonl') return 'jsonl';
    const ext = String(doc.name || '').split('.').pop().toLowerCase();
    return ext === 'tsv' ? 'tsv' : 'csv';
}

function currentSqlSourceText(doc) {
    try {
        if (doc && doc.editor) {
            const sourceMode = doc.sqlSourceMode || doc.mode;
            if (sourceMode === 'tree' && doc.format && typeof doc.format.stringify === 'function') {
                return doc.format.stringify(doc.editor.get());
            }
            return doc.editor.getText();
        }
    } catch (e) {}
    return (doc && (doc.text || doc.savedText || doc.content)) || '';
}

function createSqlView(doc) {
    if (!doc || !doc.pane || doc.sqlEl) return;
    const wrap = document.createElement('div');
    wrap.className = 'sql-view';
    const bar = document.createElement('div');
    bar.className = 'sql-bar';
    const meta = document.createElement('span');
    meta.className = 'sql-meta';
    meta.textContent = '尚未导入';
    const hint = document.createElement('span');
    hint.className = 'sql-hint';
    hint.textContent = '查询临时副本，不会修改原文件';
    const limit = document.createElement('select');
    limit.className = 'sql-limit opt-select';
    for (const n of [100, 500, 1000, 5000]) {
        const option = document.createElement('option');
        option.value = String(n);
        option.textContent = '最多 ' + n + ' 行';
        limit.appendChild(option);
    }
    limit.value = '500';
    const reimport = document.createElement('button');
    reimport.type = 'button';
    reimport.className = 'sql-btn';
    reimport.textContent = '重新导入';
    bar.append(meta, hint, limit, reimport);
    const queryWrap = document.createElement('div');
    queryWrap.className = 'sql-query-wrap';
    const input = document.createElement('textarea');
    input.className = 'sql-query';
    input.spellcheck = false;
    input.placeholder = 'SELECT * FROM t LIMIT 100;';
    input.value = 'SELECT * FROM t LIMIT 100;';
    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'sql-btn primary';
    run.textContent = '运行 (Ctrl+Enter)';
    queryWrap.append(input, run);
    const status = document.createElement('div');
    status.className = 'sql-status';
    const result = document.createElement('div');
    result.className = 'sql-result-wrap';
    wrap.append(bar, queryWrap, status, result);
    doc.pane.appendChild(wrap);
    doc.sqlEl = {wrap, meta, input, run, status, result, limit, reimport};
    run.addEventListener('click', () => runSqlQuery(doc));
    reimport.addEventListener('click', () => importSqlDoc(doc, true));
    input.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            runSqlQuery(doc);
        }
    });
    limit.addEventListener('change', () => {
        if (doc.sqlInfo) runSqlQuery(doc);
    });
}

function sqlSetStatus(doc, text, isError) {
    if (!doc || !doc.sqlEl) return;
    doc.sqlEl.status.textContent = text || '';
    doc.sqlEl.status.classList.toggle('error', !!isError);
}

async function importSqlDoc(doc, force) {
    if (!doc || !doc.sqlEl || doc.sqlImporting) return;
    if (doc.sqlInfo && !force) return;
    if (!deps.backend.SQLImport) {
        sqlSetStatus(doc, '当前版本不支持 SQL 查询', true);
        return;
    }
    if (doc.sqlInfo) {
        try { await deps.backend.SQLClose(doc.sqlInfo.id); } catch (e) {}
        doc.sqlInfo = null;
    }
    doc.sqlImporting = true;
    sqlSetStatus(doc, '正在导入临时副本…', false);
    if (doc.sqlEl.run) doc.sqlEl.run.disabled = true;
    try {
        const kind = sqlKindFor(doc);
        const useText = !doc.path || !!doc.dirty;
        const text = useText ? currentSqlSourceText(doc) : '';
        const info = await deps.backend.SQLImport(doc.path || '', kind, doc.enc || 'utf-8', text, useText);
        doc.sqlInfo = info;
        doc.sqlEl.meta.textContent = info.rows + ' 行 × ' + (info.columns || []).length + ' 列 · 导入 ' +
            info.elapsedMs + ' ms' + (info.truncated ? ' · 已截断' : '');
        doc.sqlEl.input.value = doc.sqlQuery || 'SELECT * FROM t LIMIT 100;';
        doc.sqlQuery = doc.sqlEl.input.value;
        sqlSetStatus(doc, useText ? '已导入编辑器当前内容（含未保存修改）' : '已导入磁盘文件', false);
        await runSqlQuery(doc);
    } catch (e) {
        sqlSetStatus(doc, '导入失败：' + ((e && e.message) || e), true);
    } finally {
        doc.sqlImporting = false;
        if (doc.sqlEl && doc.sqlEl.run) doc.sqlEl.run.disabled = false;
    }
}

async function runSqlQuery(doc) {
    if (!doc || !doc.sqlEl || !doc.sqlInfo) return;
    if (!deps.backend.SQLQuery) {
        sqlSetStatus(doc, '当前版本不支持 SQL 查询', true);
        return;
    }
    const query = doc.sqlEl.input.value.trim();
    if (!query) {
        sqlSetStatus(doc, '请输入 SQL', true);
        return;
    }
    doc.sqlQuery = doc.sqlEl.input.value;
    const limit = Number(doc.sqlEl.limit.value) || 500;
    doc.sqlEl.run.disabled = true;
    sqlSetStatus(doc, '查询中…', false);
    try {
        const result = await deps.backend.SQLQuery(doc.sqlInfo.id, query, limit);
        renderSqlResult(doc, result);
    } catch (e) {
        doc.sqlEl.result.textContent = '';
        sqlSetStatus(doc, '查询失败：' + ((e && e.message) || e), true);
    } finally {
        doc.sqlEl.run.disabled = false;
    }
}

function renderSqlResult(doc, result) {
    const box = doc.sqlEl.result;
    box.textContent = '';
    const columns = (result && result.columns) || [];
    const rows = (result && result.rows) || [];
    const nulls = (result && result.nulls) || [];
    const meta = rows.length + ' 行 × ' + columns.length + ' 列 · ' + (result.elapsedMs || 0) + ' ms' +
        (result.truncated ? ' · 已截断（可加 LIMIT 或调大上限）' : '') +
        (result.message ? ' · ' + result.message : '');
    sqlSetStatus(doc, meta, false);
    if (!columns.length) {
        const empty = document.createElement('div');
        empty.className = 'sql-empty';
        empty.textContent = result.message || '语句已执行（无结果集）';
        box.appendChild(empty);
        return;
    }
    const table = document.createElement('table');
    table.className = 'sql-result-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const column of columns) {
        const th = document.createElement('th');
        th.textContent = column;
        headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (let r = 0; r < rows.length; r++) {
        const tr = document.createElement('tr');
        for (let c = 0; c < columns.length; c++) {
            const td = document.createElement('td');
            const isNull = !!(nulls[r] && nulls[r][c]);
            if (isNull) {
                const span = document.createElement('span');
                span.className = 'sql-null';
                span.textContent = 'NULL';
                td.appendChild(span);
            } else {
                const value = rows[r][c] == null ? '' : String(rows[r][c]);
                td.textContent = value;
                if (value) td.title = value.length > 200 ? value.slice(0, 200) + '…' : value;
            }
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);
}

function disposeSqlDoc(doc) {
    if (!doc || !doc.sqlInfo) return;
    const id = doc.sqlInfo.id;
    doc.sqlInfo = null;
    try {
        if (deps.backend.SQLClose) Promise.resolve(deps.backend.SQLClose(id)).catch(() => {});
    } catch (e) {}
}

// SQL 查询是可开关的覆盖层（类似搜索栏）：打开时盖在当前视图上，视图选中态不变；
// 关闭时直接移除覆盖层，底层视图原样恢复，无需重新解析。
function enterSqlView(doc) {
    if (!doc || !deps.isSqlSupportedDoc(doc) || !doc.editor) return;
    if (doc.splitActive) exitSplitView(doc);
    doc.sqlSourceMode = deps.currentMode;
    doc.pane.classList.add('sql-active');
    doc.sqlActive = true;
    createSqlView(doc);
    updateStatus();
    deps.updateSearchState();
    if (!doc.sqlInfo) importSqlDoc(doc, false);
    else if (doc.dirty) sqlSetStatus(doc, '文件有未保存修改；点「重新导入」可生效', false);
    setTimeout(() => {
        if (doc.sqlEl && doc.sqlEl.input) doc.sqlEl.input.focus();
    }, 0);
}

function closeSqlView(doc) {
    if (!doc || !doc.sqlActive || !doc.pane) return;
    doc.pane.classList.remove('sql-active');
    doc.sqlActive = false;
    updateStatus();
    deps.updateSearchState();
}

// ---------- 树视图右键菜单：展开 / 折叠当前节点、全部展开 / 收起、复制树 ----------

// 全部展开会一次性渲染整棵树（jsoneditor 无虚拟滚动）：大文件几万节点时会卡几秒，
// 展开后界面也长时间卡顿。超过阈值先确认，并提示可右键逐层展开。
const TREE_EXPAND_WARN_NODES = 12000;

function estimateJsonNodes(value, budget) {
    let count = 0;
    const stack = [value];
    while (stack.length) {
        const cur = stack.pop();
        count++;
        if (count > budget) return count;
        if (cur && typeof cur === 'object') {
            if (Array.isArray(cur)) {
                for (const item of cur) stack.push(item);
            } else {
                for (const key in cur) {
                    if (Object.prototype.hasOwnProperty.call(cur, key)) stack.push(cur[key]);
                }
            }
        }
    }
    return count;
}

function expandAllWithGuard(doc) {
    const ed = doc && doc.editor;
    if (!ed) return;
    let nodes = 0;
    try { nodes = estimateJsonNodes(ed.get(), 200000); } catch (e) { nodes = 0; }
    const run = () => { try { ed.expandAll(); } catch (err) {} };
    if (!nodes || nodes <= TREE_EXPAND_WARN_NODES) {
        run();
        return;
    }
    deps.openCloseConfirm(
        '「' + (doc.name || '当前文件') + '」约含 ' + nodes.toLocaleString() + ' 个节点，全部展开需要一次性渲染整棵树，会卡顿数秒，展开后浏览 / 编辑也会明显变慢。可改用树视图右键「展开该节点」逐层展开。仍要全部展开吗？',
        run, '全部展开', '全部展开');
}

// jsoneditor 每个节点渲染成两层：外层「状态行」（直系 td 含 contextmenu 按钮，
// 子节点嵌在内嵌 values 表里）+ 内层「字段行」（直系第一个 td 就是本节点的
// 展开/收起按钮）。右键可能落在这两层任意元素上，这里统一解析出本节点按钮。

function jsonTreeNodeToggle(target) {
    const tr = target && target.closest ? target.closest('tr') : null;
    if (!tr || !tr.closest('.jsoneditor-tree')) return null;
    const fieldRow = tr.querySelector(':scope > td > table.jsoneditor-values > tbody > tr')
        || tr;
    const btn = fieldRow.querySelector(':scope > td > button.jsoneditor-expanded, :scope > td > button.jsoneditor-collapsed');
    return btn
        ? {btn, expanded: btn.classList.contains('jsoneditor-expanded')}
        : null;
}

function openTreeContextMenu(e, doc) {
    if (!deps.ctxMenu || !doc || !doc.editor) return;
    const node = jsonTreeNodeToggle(e.target);
    const ed = doc.editor;
    deps.ctxMenu.open([
        {label: '展开该节点', icon: 'chevron-down', disabled: !node || node.expanded, action: () => node.btn.click()},
        {label: '折叠该节点', icon: 'chevron-up', disabled: !node || !node.expanded, action: () => node.btn.click()},
        {sep: true},
        {label: '全部展开', shortcut: 'Ctrl+Shift+=', action: () => expandAllWithGuard(doc)},
        {label: '全部收起', shortcut: 'Ctrl+Shift+-', action: () => { try { ed.collapseAll(); } catch (err) {} }},
        {sep: true},
        {label: '复制树', action: () => { try { deps.copyText(ed.getText(), '树内容'); } catch (err) {} }},
    ], e.clientX, e.clientY);
}

function setupTreeContextMenu(doc) {
    if (!doc || !doc.editor || !doc.editor.container || doc.editor.container.dataset.treeCtxBound) return;
    const container = doc.editor.container;
    container.dataset.treeCtxBound = '1';
    container.addEventListener('contextmenu', (e) => {
        if (!e.target || !e.target.closest || !e.target.closest('.jsoneditor-tree')) return;
        e.preventDefault();
        e.stopPropagation();
        openTreeContextMenu(e, doc);
    });
}

function createDoc(data) {
    if (data.binary) {        return {
            id: ++deps.docSeq,
            path: data.path,
            name: data.name,
            size: data.size,
            hexShown: data.hexShown || data.size,
            eol: data.eol || 'lf',
            hasBom: false,
            large: false,
            enc: 'binary',
            content: data.content,
            format: data.image ? formats.image : formats.bytes,
            image: !!data.image,
            treeAvailable: false,
            parseError: null,
            mode: data.image ? 'image' : 'binary',
            text: null,
            rawText: null,
            dirty: false,
            untitled: false,
            binary: true,
            bases: {tree: null, code: null},
            savedText: data.content,
            diskMtime: data.mtime || '',
        };
    }
    const preview = detectFormat(data.name, '');
    const fsPreview = deps.getFormatSettings(preview.id);
    const format = detectFormat(data.name, data.content, {indent: fsPreview.indent});
    const fs = deps.getFormatSettings(format.id);
    let treeAvailable = !(data.large || format.rawOnly);
    let parseError = null;
    if (treeAvailable && !String(data.content || '').trim()) {
        treeAvailable = false;
    } else if (treeAvailable) {
        try {
            format.parse(data.content);
        } catch (e) {
            treeAvailable = false;
            parseError = e;
        }
    }
    const ext = String(data.name || '').split('.').pop().toLowerCase();
    // CMakeLists.txt / Makefile / .gitignore 等已知文件名按代码视图打开（带语法高亮），不算纯文本
    const plainTextView = format.id === 'text' && deps.plainTextExtensions.has(ext)
        && !isKnownCodeFileName(data.name) && !data.large;
    const preferredMode = plainTextView ? 'text' : format.preview
        ? (['split', 'preview', 'code', 'text'].includes(fs.view) ? fs.view : 'preview')
        : format.table
            ? (['table', 'tree', 'text'].includes(fs.view) ? fs.view : 'table')
            : (fs.view === 'code' || fs.view === 'text' ? fs.view : 'tree');
    return {
        id: ++deps.docSeq,
        path: data.path,
        name: data.name,
        size: data.size,
        eol: data.eol,
        hasBom: data.hasBom,
        large: data.large,
        enc: data.enc,
        content: data.content,
        format,
        treeAvailable,
        parseError,
        mode: format.patch ? 'patch' : (plainTextView ? 'text' : format.preview ? (data.large ? 'code' : preferredMode) : (treeAvailable ? preferredMode : 'code')),
        text: null,
        rawText: treeAvailable ? data.content : null,
        dirty: false,
        untitled: false,
        binary: false,
        bases: {tree: null, code: null, text: null, table: null, preview: null},
        savedText: data.content,
        bookmarks: new Set(),
        diskMtime: data.mtime || '',
    };
}

function setFilename(name, path) {
    deps.els.filenameText.textContent = name || '';
    deps.els.filename.title = path || name || '';
    const icon = deps.els.filenameIcon;
    icon.textContent = '';
    icon.className = 'title-icon';
    delete icon.dataset.fi;
    if (!name || name === '未打开文件') return;
    const spec = fileIconSpec(name);
    icon.innerHTML = spec.svg;
    icon.classList.add(spec.className);
    icon.dataset.fi = spec.id;
}

function updateDocChrome() {
    if (!deps.file) return;
    setFilename(deps.file.name, deps.file.path);
    renderBreadcrumb(deps.file.path);
    showBanner(deps.file, deps.file.parseError);
    deps.els.welcome.classList.add('hidden');
    deps.els.editor.classList.remove('hidden');
    deps.updateWindowTitle();
    updateStatus();
    deps.updateSearchState();
    renderTabs();
    if (deps.aiPanel) deps.aiPanel.refreshDockFill();
    syncAllBrowserTabs();
    deps.refreshStructureSources();
}

function showWelcome() {
    syncAllBrowserTabs();
    if (!deps.docs.length) {
        editorGroups = [];
        splitRoot = null;
        focusedGroupId = null;
    }
    deps.cancelAutoSave();
    if (deps.editor) {
        deps.editor.destroy();
        deps.editor = null;
    }
    deps.file = null;
    deps.dirty = false;
    deps.currentMode = 'tree';
    deps.els.editor.classList.add('hidden');
    deps.els.welcome.classList.remove('hidden');
    setFilename('未打开文件', '');
    deps.els.filename.classList.remove('dirty');
    deps.els.breadcrumb.textContent = '';
    deps.els.stDirty.textContent = '';
    deps.els.stMessage.textContent = '';
    deps.els.stMode.textContent = '';
    deps.els.stSize.textContent = '';
    deps.els.stEol.textContent = '';
    deps.els.stEnc.textContent = '';
    deps.els.stEol.style.display = '';
    deps.els.stEnc.style.display = '';
    deps.els.banner.classList.add('hidden');
    deps.closeFootPopover();
    deps.closeDialogs();
    if (deps.els.stWriting) deps.els.stWriting.style.display = 'none';
    deps.applyWritingMode();
    deps.updateSearchState();
    renderTabs();
    deps.updateBackendDirty();
    deps.updateWindowTitle();
    deps.syncExplorerActive();
    if (deps.structurePanel) deps.structurePanel.setDoc(null);
    if (deps.aiPanel) deps.aiPanel.refreshDockFill();
    deps.refreshStructureSources();
}

let activateToken = 0;
let lastTabSwitchLog = {id: null, at: 0};

async function activateDoc(doc) {
    if (!doc) return;
    if (doc === deps.file) {
        const g0 = groupOfDoc(doc.id);
        if (g0) { g0.activeId = doc.id; focusedGroupId = g0.id; }
        return;
    }
    let g = groupOfDoc(doc.id);
    if (!g) {
        g = focusedGroup() || createGroup();
        if (!g.docIds.includes(doc.id)) g.docIds.push(doc.id);
    }
    g.activeId = doc.id;
    focusedGroupId = g.id;
    const token = ++activateToken;
    deps.cancelAutoSave();
    if (deps.settings.autoSave && deps.file && deps.dirty && deps.file.path && !deps.file.large) {
        await deps.save({auto: true});
        if (token !== activateToken) return;
    }
    snapshotActiveDoc();
    deps.file = doc;
    deps.dirty = !!doc.dirty;
    deps.currentMode = deps.normalizeLegacySqlMode(doc);
    deps.els.welcome.classList.add('hidden');
    deps.els.editor.classList.remove('hidden');
    if (!deps.els.editor.querySelector('.egroup[data-gid="' + g.id + '"]')) renderEditorLayout();
    for (const d of groupDocs(g)) {
        if (d.pane) d.pane.classList.remove('active');
    }
    if (!doc.editor) createDocEditor(doc);
    renderBookmarks(doc);
    const host = deps.els.editor.querySelector('.egroup[data-gid="' + g.id + '"] .ehost');
    if (host && doc.pane && doc.pane.parentElement !== host) host.appendChild(doc.pane);
    doc.pane.classList.add('active');
    deps.editor = doc.editor;
    updateDocChrome();
    deps.setDirty(doc.dirty);
    applyAceMode();
    if (doc.splitActive || doc.mode === 'split') enterSplitView(doc);
    humanizeCounts();
    if (deps.editor && deps.editor.aceEditor) {
        setTimeout(() => {
            if (deps.editor === doc.editor && deps.editor && deps.editor.aceEditor) {
                deps.editor.aceEditor.resize();
                if (deps.file === doc) applyPendingDocView(doc);
            }
        }, 0);
    }
    deps.syncExplorerActive();
    if (deps.structurePanel) deps.structurePanel.setDoc(doc);
    // 操作留痕：标签切换，同一标签 2s 内去重（避免连点噪音）。
    const now = Date.now();
    if (lastTabSwitchLog.id !== doc.id || now - lastTabSwitchLog.at > 2000) {
        lastTabSwitchLog = {id: doc.id, at: now};
        deps.activityLog.log('tab.switch', doc.name, {});
    }
    if (doc.staleOnDisk && !doc.dirty) {
        doc.staleOnDisk = false;
        deps.reloadActive({quiet: true});
    }
}

// ---------- 外部修改检测（写盘前冲突 + 读盘自动刷新） ----------
const externalDocTimers = new Map();

function handleExternalDocChanges(payload) {
    if (!payload || !deps.backend.GetFileStat) return;
    const root = String(payload.root || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (!root) return;
    const changed = new Set();
    if (payload.overflow) {
        for (const doc of deps.docs) if (doc.path && !doc.browser) changed.add(doc);
    } else {
        for (const rel of payload.paths || []) {
            const full = root + '/' + String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
            for (const doc of deps.docs) {
                if (!doc.path || doc.browser) continue;
                if (doc.path.replace(/\\/g, '/').toLowerCase() === full) changed.add(doc);
            }
        }
    }
    for (const doc of changed) {
        const prev = externalDocTimers.get(doc.id);
        if (prev) clearTimeout(prev);
        externalDocTimers.set(doc.id, setTimeout(() => {
            externalDocTimers.delete(doc.id);
            checkDocExternalChange(doc).catch(() => {});
        }, 350));
    }
}

// 磁盘 mtime 与打开/上次保存时不同：干净文档自动重载，脏文档标记 staleOnDisk（保存时弹冲突）
async function checkDocExternalChange(doc) {
    if (!doc || !doc.path || doc.browser || !deps.backend.GetFileStat) return;
    if (!doc.diskMtime) return;
    let st = null;
    try {
        st = await deps.backend.GetFileStat(doc.path);
    } catch (e) {
        return;
    }
    if (!st || !st.exists || st.mtime === doc.diskMtime) return;
    if (doc.dirty) {
        doc.staleOnDisk = true;
        renderTabs();
        return;
    }
    if (doc === deps.file) {
        await deps.reloadActive({quiet: true});
        deps.flash('文件已在外部修改，已自动重新加载 ' + doc.name);
    } else {
        doc.staleOnDisk = true;
        renderTabs();
    }
}

async function handleAIWorkspaceFileChanged(path) {
    if (deps.explorer && deps.explorer.refresh) deps.explorer.refresh();
    const doc = deps.findDocByPath(path);
    if (!doc) return;
    if (doc.dirty) {
        deps.flash('AI 已修改 ' + doc.name + '，但编辑器中有未保存修改，未自动重载', true);
        return;
    }
    if (doc === deps.file) {
        const ok = await deps.reloadActive({quiet: true});
        if (ok) deps.flash('AI 已修改并重载 ' + doc.name);
    } else {
        doc.staleOnDisk = true;
        deps.flash('AI 已修改 ' + doc.name + '，切换到该标签时自动重载');
    }
}

function requestCloseDoc(doc) {
    if (!doc) return;
    if (doc === deps.file) flushCsvCellEditor();
    if (doc.dirty) {
        deps.openCloseConfirm('“' + doc.name + '”有未保存的修改，关闭标签后将丢弃。', () => closeDocNow(doc));
    } else {
        closeDocNow(doc);
    }
}

function closeDocNow(doc, remember = true) {
    const idx = deps.docs.indexOf(doc);
    if (idx < 0) return;
    // 操作留痕：脏标签关闭 = 放弃修改（保存后的关闭到这里 dirty 已清零）。
    if (doc.dirty) deps.activityLog.log('tab.closeDirty', doc.name, {discarded: true});
    else deps.activityLog.log('tab.close', doc.name, {});
    disposeSqlDoc(doc);
    disposePatchView(doc);
    const wasActive = doc === deps.file;
    if (doc.path && remember) {
        deps.closedTabs.push({path: doc.path, name: doc.name});
        if (deps.closedTabs.length > 12) deps.closedTabs.shift();
    }
    if (doc.browser && deps.backend.BrowserClose) {
        deps.backend.BrowserClose(doc.id).catch(() => {});
    }
    // 后台终端标签页：只断开输出订阅，作业继续在后台运行
    if (doc.bgTerm && doc.bgTermUnsub) {
        doc.bgTermUnsub();
        doc.bgTermUnsub = null;
    }
    deps.docs.splice(idx, 1);
    if (doc.editor) {
        doc.editor.destroy();
        doc.editor = null;
    }
    if (doc.pane) {
        doc.pane.remove();
        doc.pane = null;
    }
    const g = groupOfDoc(doc.id);
    if (g) {
        g.docIds = g.docIds.filter((id) => id !== doc.id);
        if (g.activeId === doc.id) g.activeId = g.docIds[0] || null;
        removeGroupIfEmpty(g.id);
    }
    if (deps.docs.length === 0) {
        editorGroups = [];
        splitRoot = null;
        focusedGroupId = null;
        deps.editor = null;
        showWelcome();
        // 用户主动关掉最后一个标签：允许写入空快照
        deps.saveSessionNow({allowEmpty: true});
        return;
    }
    deps.scheduleSessionSave({allowEmpty: true});
    if (wasActive) {
        deps.editor = null;
        deps.file = null;
        deps.dirty = false;
        let next = null;
        if (g && g.docIds.length) {
            const at = Math.min(idx, g.docIds.length - 1);
            next = deps.docs.find((d) => d.id === g.docIds[at]) || deps.docs.find((d) => d.id === g.docIds[0]);
        }
        if (!next) {
            const fg = focusedGroup();
            next = fg ? deps.docs.find((d) => d.id === fg.activeId) : null;
        }
        if (!next) next = deps.docs[Math.min(idx, deps.docs.length - 1)] || deps.docs[0];
        renderTabs();
        activateDoc(next);
    } else {
        renderTabs();
        deps.updateBackendDirty();
    }
}

function showPathInFolder(path) {
    if (!path) return;
    deps.backend.ShowInFolder(path).catch((e) => deps.flash('打开文件位置失败：' + e, true));
}

function closeDocsWithConfirm(list, message) {
    const targets = (list || []).filter((doc) => deps.docs.includes(doc));
    if (!targets.length) return;
    const run = () => {
        for (const doc of targets.slice()) closeDocNow(doc);
    };
    if (targets.some((doc) => doc.dirty)) {
        deps.openCloseConfirm(message || '有未保存的修改，关闭后将丢弃。', run);
    } else {
        run();
    }
}

function reopenClosedTab() {
    const entry = deps.closedTabs.pop();
    if (!entry) return;
    deps.activityLog.log('tab.reopen', entry.name, {});
    deps.openPath(entry.path);
}

// renderMarkdownBlocks 按顶层块渲染 Markdown，并用 data-md-start/end
// 标注每块对应的源码行区间（0 基，含头不含尾），供预览选区反向取 md 源码。
function renderMarkdownBlocks(text) {
    const env = {};
    const tokens = deps.markdownRenderer.parse(text || '', env);
    const blocks = [];
    let i = 0;
    while (i < tokens.length) {
        const start = i;
        let level = 0;
        do {
            const t = tokens[i];
            if (t.nesting === 1) level++;
            else if (t.nesting === -1) level--;
            i++;
        } while (i < tokens.length && level > 0);
        const group = tokens.slice(start, i);
        const html = deps.markdownRenderer.renderer.render(group, deps.markdownRenderer.options, env);
        const map = group[0] && group[0].map;
        blocks.push({
            start: map && map.length === 2 ? map[0] : null,
            end: map && map.length === 2 ? map[1] : null,
            html,
        });
    }
    return blocks;
}

function markdownBlockHash(html) {
    let hash = 2166136261 >>> 0;
    for (let i = 0; i < html.length; i++) {
        hash ^= html.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(36) + ':' + html.length.toString(36);
}

function sanitizeMarkdownSegment(html) {
    return DOMPurify.sanitize(html, {
        USE_PROFILES: {html: true, mathMl: true, svg: true},
        ADD_ATTR: ['target', 'rel'],
    });
}

function renderMarkdownBlocksHtml(text) {
    let blocks;
    try {
        blocks = renderMarkdownBlocks(text);
    } catch (e) {
        return deps.renderMarkdownHtml(text);
    }
    let html = '';
    for (const block of blocks) {
        if (block.start != null && block.end != null) {
            html += '<div class="md-block" style="display:contents" data-md-start="' + block.start +
                '" data-md-end="' + block.end + '" data-md-hash="' + markdownBlockHash(block.html) + '">' +
                block.html + '</div>';
        } else {
            html += block.html;
        }
    }
    // 整页只净化一次：逐块 sanitize 会为每个顶层块各建一个 document 并全量遍历
    return DOMPurify.sanitize(html, {
        USE_PROFILES: {html: true, mathMl: true, svg: true},
        ADD_ATTR: ['target', 'rel', 'data-md-start', 'data-md-end', 'data-md-hash'],
    });
}

// patchMarkdownPreview 复用未变化块的 DOM，只更新行区间或替换变化块；
// 任一块缺少源码行区间（无法安全对齐）时返回 false，调用方回退整页渲染。
function patchMarkdownPreview(doc) {
    const body = doc && doc.previewBody;
    if (!body) return false;
    let blocks;
    try {
        blocks = renderMarkdownBlocks(doc.editor.getText());
    } catch (e) {
        return false;
    }
    if (blocks.some((block) => block.start == null || block.end == null)) return false;
    const oldEls = Array.from(body.children);
    if (oldEls.some((el) => !el.classList || !el.classList.contains('md-block'))) return false;
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        let el = oldEls[i];
        if (!el) {
            el = document.createElement('div');
            el.className = 'md-block';
            el.style.display = 'contents';
            body.appendChild(el);
        }
        el.dataset.mdStart = String(block.start);
        el.dataset.mdEnd = String(block.end);
        const hash = markdownBlockHash(block.html);
        if (el.dataset.mdHash !== hash) {
            el.innerHTML = sanitizeMarkdownSegment(block.html);
            el.dataset.mdHash = hash;
        }
    }
    for (let i = blocks.length; i < oldEls.length; i++) oldEls[i].remove();
    return true;
}

// rangeIntersectsNode 判断选区 range 是否与节点内容相交。
function rangeIntersectsNode(range, node) {
    try {
        const nr = document.createRange();
        nr.selectNodeContents(node);
        return range.compareBoundaryPoints(Range.END_TO_START, nr) < 0 &&
            range.compareBoundaryPoints(Range.START_TO_END, nr) > 0;
    } catch (e) {
        return false;
    }
}

// copySelectedMarkdown 把预览选区还原成对应的 markdown 源码行并复制。
// 精度是块级：选中段落的任何部分都会取回该块（及跨到的最后一个块）的完整源码行。
function copySelectedMarkdown(doc) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    const blocks = doc.previewBody ? Array.from(doc.previewBody.querySelectorAll('.md-block[data-md-start]')) : [];
    const hit = blocks.filter((b) => rangeIntersectsNode(range, b));
    if (!hit.length) return false;
    const start = Number(hit[0].dataset.mdStart);
    const end = Number(hit[hit.length - 1].dataset.mdEnd);
    if (!(start >= 0) || !(end > start)) return false;
    const lines = doc.editor.getText().split('\n');
    const text = lines.slice(start, end).join('\n');
    return deps.copyText(text, 'markdown 源码');
}

// getSelectionHtml 取当前选区的 HTML 片段（支持多选区）。
function getSelectionHtml(sel) {
    if (!sel || !sel.rangeCount) return '';
    const container = document.createElement('div');
    for (let i = 0; i < sel.rangeCount; i++) {
        container.appendChild(sel.getRangeAt(i).cloneContents());
    }
    return container.innerHTML;
}

// copySelectionRich 富文本复制：同时写入 text/html 与 text/plain，
// 粘到 Word/微信等会保留渲染样式。Clipboard API 不可用时回退临时选区 + execCommand。
async function copySelectionRich() {
    const sel = window.getSelection();
    const plain = sel ? sel.toString() : '';
    if (!plain) return false;
    const html = getSelectionHtml(sel);
    try {
        if (navigator.clipboard && window.ClipboardItem) {
            await navigator.clipboard.write([new ClipboardItem({
                'text/html': new Blob([html], {type: 'text/html'}),
                'text/plain': new Blob([plain], {type: 'text/plain'}),
            })]);
            return true;
        }
    } catch (e) {}
    try {
        const holder = document.createElement('div');
        holder.contentEditable = 'true';
        holder.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
        holder.innerHTML = html || '';
        document.body.appendChild(holder);
        const range = document.createRange();
        range.selectNodeContents(holder);
        const tmpSel = window.getSelection();
        tmpSel.removeAllRanges();
        tmpSel.addRange(range);
        const ok = document.execCommand('copy');
        tmpSel.removeAllRanges();
        holder.remove();
        if (ok) return true;
    } catch (e) {}
    return await deps.copyText(plain, '所选文本');
}

// copyImageBlobToClipboard 把图片 Blob 写入剪贴板（image/png）。
// svgToPngBlob 把 SVG 文本转成 2x 尺寸的 PNG Blob。
function svgToPngBlob(svgText) {
    return new Promise((resolve, reject) => {
        const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
        const img = new Image();
        img.onload = () => {
            try {
                const scale = 2;
                const w = Math.max(1, img.naturalWidth || 800);
                const h = Math.max(1, img.naturalHeight || 600);
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(w * scale);
                canvas.height = Math.round(h * scale);
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                canvas.toBlob((blob) => {
                    if (blob) resolve(blob);
                    else reject(new Error('canvas 转换失败'));
                }, 'image/png');
            } catch (e) {
                reject(e);
            }
        };
        img.onerror = () => reject(new Error('SVG 加载失败'));
        img.src = url;
    });
}

function fileStem(name) {
    const base = deps.baseNameOf(name || '图表');
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(0, dot) : base;
}

// showSvgMenu SVG 渲染视图的右键菜单（完整渲染 + 分屏右栏）。
function showSvgMenu(doc, x, y) {
    if (!deps.ctxMenu || !doc) return;
    const items = [
        {label: '导出为 PNG…（2x）', icon: 'E74E', action: async () => {
            try {
                const svgText = doc.editor.getText();
                const blob = await svgToPngBlob(svgText);
                const dataUrl = await new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => resolve('');
                    reader.readAsDataURL(blob);
                });
                if (!dataUrl) throw new Error('PNG 数据生成失败');
                let dest = '';
                try {
                    dest = await deps.backend.SaveFileDialog(fileStem(doc.path || doc.name) + '.png');
                } catch (e) {
                    return;
                }
                if (!dest) return;
                await deps.backend.SaveDataURL(dest, dataUrl);
                deps.flash('已导出 PNG：' + deps.baseNameOf(dest));
            } catch (e) {
                deps.flash('导出失败：' + (e && e.message || e), true);
            }
        }},
        {label: '复制图片', icon: 'E8C8', action: async () => {
            try {
                const blob = await svgToPngBlob(doc.editor.getText());
                const ok = await copyImageBlobToClipboard(blob);
                deps.flash(ok ? '已复制图片' : '剪贴板不支持图片', !ok);
            } catch (e) {
                deps.flash('复制失败：' + (e && e.message || e), true);
            }
        }},
        {sep: true},
        ...deps.aiReferenceFileMenuItems(doc),
        {label: '复制文件路径', icon: 'E8C8', disabled: !doc.path, action: () => deps.copyText(doc.path, '路径')},
        {label: '打开文件位置', icon: 'E8B7', disabled: !doc.path, action: () => showPathInFolder(doc.path)},
    ];
    deps.ctxMenu.open(items, x, y);
}

// showImageMenu 图片视图的右键菜单。
function showImageMenu(doc, x, y) {
    if (!deps.ctxMenu || !doc) return;
    const items = [
        {label: '另存为…', icon: 'E74E', disabled: !doc.path, action: async () => {
            let dest = '';
            try {
                dest = await deps.backend.SaveFileDialog(deps.baseNameOf(doc.path));
            } catch (e) {
                return;
            }
            if (!dest) return;
            try {
                await deps.backend.CopyFileTo(doc.path, dest);
                deps.flash('已另存为：' + deps.baseNameOf(dest));
            } catch (e) {
                deps.flash('另存为失败：' + (e && e.message || e), true);
            }
        }},
        {label: '复制图片', icon: 'E8C8', action: async () => {
            try {
                const url = doc.imageUrl || await deps.backend.ReadImageAsDataURL(doc.path);
                const blob = await (await fetch(url)).blob();
                const ok = await copyImageBlobToClipboard(blob);
                deps.flash(ok ? '已复制图片' : '剪贴板不支持图片', !ok);
            } catch (e) {
                deps.flash('复制失败：' + (e && e.message || e), true);
            }
        }},
        {sep: true},
        ...deps.aiReferenceFileMenuItems(doc),
        {label: '复制文件路径', icon: 'E8C8', disabled: !doc.path, action: () => deps.copyText(doc.path, '路径')},
        {label: '打开文件位置', icon: 'E8B7', disabled: !doc.path, action: () => showPathInFolder(doc.path)},
    ];
    deps.ctxMenu.open(items, x, y);
}

// showMdPreviewMenu Markdown 预览区的右键菜单：常用操作 + 预览宽度调整。
function showMdPreviewMenu(doc, x, y) {
    if (!deps.ctxMenu || !doc) return;
    const selText = String(window.getSelection ? window.getSelection().toString() : '');
    const widthOptions = [['720', '720px'], ['860', '860px'], ['920', '920px'], ['1100', '1100px'], ['1300', '1300px'], ['0', '跟随窗口宽度']];
    const items = [
        {label: '复制', shortcut: 'Ctrl+C', icon: 'E8C8', disabled: !selText, submenu: [
            {label: '纯文本', action: () => deps.copyText(selText, '所选文本')},
            {label: '富文本', action: async () => {
                const ok = await copySelectionRich();
                if (!ok) deps.flash('复制失败', true);
            }},
            {label: 'markdown文本', action: async () => {
                const ok = await copySelectedMarkdown(doc);
                if (!ok) deps.flash('无法定位所选内容对应的源码', true);
            }},
        ]},
        {label: '全选', shortcut: 'Ctrl+A', action: () => {
            const sel = window.getSelection();
            if (sel && doc.previewBody) sel.selectAllChildren(doc.previewBody);
        }},
        {sep: true},
        {label: '切换到代码视图', action: () => deps.switchMode('code')},
        {label: '分屏预览（左源码右预览）', disabled: doc.splitActive || !deps.canSplitDoc(doc), action: () => deps.switchMode('split')},
    ];
    if (!doc.splitActive) {
        items.push({sep: true});
        items.push({
            label: '预览宽度',
            submenu: widthOptions.map(([value, label]) => ({
                label,
                checked: String(deps.settings.mdPreviewWidth) === value,
                action: () => {
                    deps.settings.mdPreviewWidth = value;
                    deps.applySettings();
                    updateStatus();
                },
            })),
        });
        items.push({label: '刷新预览', icon: 'E72C', action: () => renderMarkdownPreview(doc)});
    }
    items.push({sep: true});
    items.push(...deps.aiReferenceFileMenuItems(doc));
    items.push({label: '复制文件路径', icon: 'E8C8', disabled: !doc.path, action: () => deps.copyText(doc.path, '路径')});
    items.push({label: '打开文件位置', icon: 'E8B7', disabled: !doc.path, action: () => showPathInFolder(doc.path)});
    deps.ctxMenu.open(items, x, y);
}

function showTabMenu(doc, x, y) {
    if (!deps.ctxMenu || !doc) return;
    const g0 = groupOfDoc(doc.id);
    const gdocs = g0 ? groupDocs(g0) : deps.docs.slice();
    const idx = gdocs.indexOf(doc);
    const others = gdocs.filter((d) => d !== doc);
    const left = gdocs.slice(0, Math.max(0, idx));
    const clean = gdocs.filter((d) => !d.dirty);
    const hasPath = !!doc.path;
    deps.ctxMenu.open([
        {label: '关闭', shortcut: 'Ctrl+W / Shift+点击', icon: 'E8BB', action: () => requestCloseDoc(doc)},
        {label: '关闭其他标签页', disabled: !others.length, action: () => closeDocsWithConfirm(others)},
        {label: '关闭所有标签页', action: () => closeDocsWithConfirm(gdocs.slice(), '关闭所有标签页将丢弃未保存的修改。')},
        {label: '关闭左侧标签页', disabled: !left.length, action: () => closeDocsWithConfirm(left)},
        {label: '关闭未修改标签页', disabled: !clean.length, action: () => closeDocsWithConfirm(clean)},
        {sep: true},
        {label: '复制文件路径', icon: 'E8C8', disabled: !hasPath, action: () => deps.copyText(doc.path, '路径')},
        {label: '复制文件名', icon: 'E8C8', action: () => deps.copyText(doc.name, '文件名')},
        {label: '打开文件位置', icon: 'E8B7', disabled: !hasPath, action: () => showPathInFolder(doc.path)},
        {label: '与另一个标签页比较…', icon: 'E8A5', disabled: gdocs.filter((d) => d.path && !d.binary).length < 2, action: () => deps.openDiffDialog(doc.path)},
        ...deps.aiReferenceFileMenuItems(doc),
        {label: '在 AI 中询问此文件', iconHtml: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.2l1.1 3.1 3.1 1.1-3.1 1.1L10 11.6 8.9 8.5 5.8 7.4l3.1-1.1z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M15.2 12.3l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z" fill="currentColor"/></svg>', disabled: !hasPath, action: () => deps.askAIAboutPath(doc.path)},
        {sep: true},
        {label: '在新窗口中打开', shortcut: 'Shift+F4', icon: 'E8A7', disabled: !hasPath, action: () => deps.openInNewWindows([doc.path])},
        {label: '重新打开关闭的标签页', shortcut: 'Ctrl+Shift+T', icon: 'E7A7', disabled: !deps.closedTabs.length, action: reopenClosedTab},
    ], x, y);
}


    function setFocusedGroupId(v) { focusedGroupId = v; }
    function setSplitRoot(v) { splitRoot = v; }

    return {activateDoc, setFocusedGroupId, setSplitRoot, addDocToFocusedGroup, applyAceMode, applyCsvTableZoom, applyImageZoom, browserViewportLabel, closeDocNow, closeDocsWithConfirm, closeSqlView, createDoc, createDocEditor, createGroup, dismissBanner, doRedo, doUndo, editorGroups, enterBinaryView, enterCsvTable, enterImageView, enterMarkdownPreview, enterSplitView, enterSqlView, enterSvgRender, enterTextView, exitSplitView, expandAllWithGuard, flushCsvCellEditor, focusedGroupId, groupDocs, groupOfDoc, handleAIWorkspaceFileChanged, handleExternalDocChanges, hideBanner, hideSvgRender, hookCodeFoldPreviews, hookMultiCursor, humanizeCounts, initCodeFoldHover, jumpBookmark, leaveCsvTable, leaveMarkdownPreview, markDocDirty, mdSyncScrollFromAce, moveTabInGroup, patchViewContext, refreshPatchMarkers, rememberDocView, renderBookmarks, renderBreadcrumb, renderCsvTableView, renderEditorLayout, renderMarkdownPreview, renderTabs, reopenClosedTab, requestCloseDoc, revertDocToSaved, scheduleGitGutter, setBrowserViewport, setFilename, showBanner, showImageMenu, showMdPreviewMenu, showPathInFolder, showSvgMenu, splitRoot, syncAllBrowserTabs, syncBrowserTab, textArea, toggleBookmark, toggleFocusedNode, updateAiWriteBadge, updateBrowserTitle, updateCodeFoldPreviews, updateDocChrome, updateStatus, zoomCsvTable, zoomImageBy, zoomSvgRenderBy};
}
