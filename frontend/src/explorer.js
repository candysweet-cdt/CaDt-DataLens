const ICONS = {
    chevron: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    folder: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.7c0-.9.7-1.7 1.7-1.7h2.9l1.6 1.8h4.1c.9 0 1.7.7 1.7 1.7v4.8c0 .9-.7 1.7-1.7 1.7H3.7c-.9 0-1.7-.7-1.7-1.7z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    file: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.8h5.2L12 5.6v7.6H4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9.2 2.8v2.8H12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    list: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.2h10M3 8h10M3 11.8h10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    tree: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.2v9.6M3 6h4.2M3 11.8h4.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M7.2 4.6h5.2v2.8H7.2zM7.2 10.4h5.2v2.8H7.2z" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>',
    filter: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.2h11L9.6 8.4v4.2l-3.2 1.6V8.4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    refresh: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.8 8a4.8 4.8 0 1 1-1.4-3.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M12.8 2.6v3.2H9.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
function normalizePath(path) {
    return String(path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function samePath(a, b) {
    return !!a && !!b && normalizePath(a) === normalizePath(b);
}

function isWithin(root, target) {
    const r = normalizePath(root);
    const t = normalizePath(target);
    if (!r || !t) return false;
    return t === r || t.startsWith(r + '/');
}

function parentPath(path) {
    let s = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const i = s.lastIndexOf('/');
    if (i < 0) return s;
    let dir = s.slice(0, i);
    if (/^[a-z]:$/i.test(dir)) dir += '/';
    return dir || '/';
}

function baseName(path) {
    const s = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
}

import {createFileIcon} from './fileicons.js';

function compareEntries(a, b) {
    if (!!a.isDir !== !!b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN', {numeric: true, sensitivity: 'base'});
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

export function createExplorer(options) {
    const {
        body, titleEl, refreshBtn, listBtn, treeBtn, filterBtn, onToggleFilter,
        readDir, dirMtime, openPath, openFolder, openFileDialog, isSupported,
        onModeChange, onContextMenu, onMove, onExternalDrop, canDrag,
        listLimit = 200, readLimit = 1000, listReadLimit = 5000,
    } = options;
    let mode = 'tree';
    let visible = false;
    let explicitRoot = null;
    let activePath = null;
    let selection = [];
    let anchorPath = null;
    let cutPaths = [];
    let focused = false;
    let tree = null;
    let treeSeq = 0;
    let revealSeq = 0;
    let listState = {root: null, entries: [], tooMany: false, error: '', loading: false, loaded: false, token: 0, dirMtime: 0};
    let autoRefreshSeconds = -1;
    let autoRefreshTimer = 0;
    let autoRefreshBusy = false;
    let externalTimer = 0;
    let externalOverflow = false;
    const externalDirs = new Set();
    let dragState = null;

    const canList = (name) => (typeof isSupported === 'function' ? isSupported(name) : true);

    function treeRootPath() {
        if (explicitRoot) return explicitRoot;
        if (!activePath) return null;
        if (tree && isWithin(tree.path, activePath)) return tree.path;
        return parentPath(activePath);
    }

    function listRootPath() {
        return activePath ? parentPath(activePath) : null;
    }

    function currentRoot() {
        return mode === 'list' ? listRootPath() : treeRootPath();
    }

    function updateTitle() {
        const root = currentRoot();
        if (titleEl) {
            titleEl.textContent = root ? '项目' : '资源';
        }
        if (refreshBtn) refreshBtn.disabled = !root;
    }

    function updateModeButtons() {
        if (listBtn) {
            listBtn.classList.toggle('active', mode === 'list');
            listBtn.setAttribute('aria-pressed', String(mode === 'list'));
        }
        if (treeBtn) {
            treeBtn.classList.toggle('active', mode === 'tree');
            treeBtn.setAttribute('aria-pressed', String(mode === 'tree'));
        }
    }

    function emptyState(text, buttonText, action) {
        const wrap = el('div', 'sb-empty');
        wrap.appendChild(el('div', null, text));
        if (buttonText && action) {
            const btn = el('button', 'sb-empty-btn', buttonText);
            btn.type = 'button';
            btn.addEventListener('click', action);
            wrap.appendChild(btn);
        }
        return wrap;
    }

    function statusRow(text, isError) {
        const row = el('div', 'sb-row sb-tree-row sb-status' + (isError ? ' error' : ''));
        row.appendChild(el('span', 'sb-chev'));
        row.appendChild(el('span', 'sb-icon'));
        row.appendChild(el('span', 'sb-name', text));
        return row;
    }

    function clearDropHighlight() {
        for (const row of body.querySelectorAll('.sb-row.drop-target')) row.classList.remove('drop-target');
    }

    function clearDragState() {
        clearDropHighlight();
        for (const row of body.querySelectorAll('.sb-row.dragging')) row.classList.remove('dragging');
        dragState = null;
    }

    function dropAllowed(node) {
        if (!dragState || !dragState.items.length || !node || !node.isDir) return false;
        const dest = node.path;
        const items = dragState.items;
        if (items.some((item) => samePath(item.path, dest))) return false;
        if (items.some((item) => item.isDir && isWithin(item.path, dest))) return false;
        // 全部都已经在该目录里，没必要高亮
        if (items.every((item) => samePath(parentPath(item.path), dest))) return false;
        return true;
    }

    // ---- 文件名即时过滤：只过滤已加载节点，命中目录自动按展开渲染 ----
    let filterText = '';

    function treeFilterHit(node) {
        if (!filterText) return true;
        const name = String(node.name || '').toLowerCase();
        if (name.includes(filterText)) return true;
        if (node.isDir && Array.isArray(node.children)) {
            return node.children.some((child) => treeFilterHit(child));
        }
        return false;
    }

    function setFilter(text) {
        const next = String(text || '').trim().toLowerCase();
        if (next === filterText) return;
        filterText = next;
        if (mode === 'tree') renderTree();
        else renderList();
    }

    function isEmptyDirNode(node) {
        return !!(node && node.isDir && node.loaded && !node.loading && !node.error &&
            !node.truncated && Array.isArray(node.children) && node.children.length === 0);
    }

    function treeRow(node) {
        const row = el('div', 'sb-row sb-tree-row' + (node.root ? ' sb-root' : '') +
            (node.isDir ? ' sb-dir' : '') + (samePath(node.path, activePath) ? ' current' : '') +
            (selectionHas(node.path) ? ' selected' : '') +
            (samePath(node.path, anchorPath) ? ' anchor' : '') +
            (cutPaths.some((path) => samePath(node.path, path)) ? ' cut' : ''));
        row.dataset.path = node.path;
        row.dataset.dir = node.isDir ? '1' : '0';
        row.tabIndex = -1;
        const emptyDir = isEmptyDirNode(node);
        const chev = emptyDir
            ? el('span', 'sb-chev-spacer')
            : el('span', 'sb-chev' + (node.isDir && node.expanded ? ' open' : ''));
        if (node.isDir && !emptyDir) {
            chev.innerHTML = ICONS.chevron;
            chev.title = node.expanded ? '收起目录' : '展开目录';
        }
        let icon;
        if (node.isDir) {
            icon = el('span', 'sb-icon sb-dir-icon');
            icon.innerHTML = ICONS.folder;
        } else {
            icon = createFileIcon(node.name, 'sb-icon');
        }
        const name = el('span', 'sb-name', node.name);
        row.append(chev, icon, name);
        row.addEventListener('click', (e) => {
            row.focus({preventScroll: true});
            const onChevron = node.isDir && e.target && e.target.closest ? e.target.closest('.sb-chev') : null;
            if (onChevron) {
                if (e.detail > 1) return;
                if (!selectionHas(node.path)) selectOnly(node);
                toggleNode(node);
                return;
            }
            if (e.shiftKey) {
                selectRangeTo(node, e.ctrlKey || e.metaKey);
                return;
            }
            if (e.ctrlKey || e.metaKey) toggleSelection(node);
            else selectOnly(node);
        });
        row.addEventListener('dblclick', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.target && e.target.closest && e.target.closest('.sb-chev')) return;
            if (e.ctrlKey || e.metaKey || e.shiftKey) return;
            if (node.isDir) toggleNode(node);
            else if (typeof openPath === 'function') openPath(node.path);
        });
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            selectForContext(node);
            if (typeof onContextMenu === 'function') {
                onContextMenu({kind: 'tree', name: node.name, path: node.path, isDir: node.isDir, isRoot: !!node.root}, e.clientX, e.clientY, node);
            }
        });
        row.draggable = !node.root;
        row.addEventListener('dragstart', (e) => {
            if (node.root || (typeof canDrag === 'function' && !canDrag())) {
                e.preventDefault();
                return;
            }
            if (!selectionHas(node.path)) selectOnly(node);
            const items = selection.filter((item) => item && item.path).map((item) => ({...item}));
            if (!items.length) {
                e.preventDefault();
                return;
            }
            dragState = {items};
            row.classList.add('dragging');
            try {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', items.map((item) => item.path).join('\n'));
            } catch (err) {}
        });
        row.addEventListener('dragend', clearDragState);
        row.addEventListener('dragover', (e) => {
            // 外部文件拖入：目录行（含根行）接受复制，文件行不拦截（交给全局打开）
            const isFileDrag = !!(e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files'));
            if (isFileDrag) {
                if (node.isDir) {
                    e.preventDefault();
                    try { e.dataTransfer.dropEffect = 'copy'; } catch (err) {}
                    clearDropHighlight();
                    row.classList.add('drop-target');
                }
                return;
            }
            if (!dropAllowed(node)) return;
            e.preventDefault();
            e.stopPropagation();
            try { e.dataTransfer.dropEffect = 'move'; } catch (err) {}
            clearDropHighlight();
            row.classList.add('drop-target');
        });
        row.addEventListener('dragleave', (e) => {
            if (!row.contains(e.relatedTarget)) row.classList.remove('drop-target');
        });
        row.addEventListener('drop', (e) => {
            const isFileDrag = !!(e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files'));
            if (isFileDrag) {
                if (!node.isDir) return;
                // 浏览器 File 对象拿不到完整路径：不做 stopPropagation，
                // 放行 Wails 的原生解析链路，路径在 file-drop 事件里带回
                e.preventDefault();
                if (typeof onExternalDrop === 'function') onExternalDrop(node.path);
                clearDropHighlight();
                return;
            }
            if (!dropAllowed(node)) return;
            e.preventDefault();
            e.stopPropagation();
            const items = dragState.items.map((item) => ({...item}));
            const destDir = node.path;
            clearDragState();
            if (typeof onMove === 'function') onMove(items, destDir);
        });
        return row;
    }

    function appendTreeRows(node, parent) {
        parent.appendChild(treeRow(node));
        if (!node.isDir || isEmptyDirNode(node)) return;
        // 过滤时：命中后代的目录按展开渲染（不改节点自身的折叠状态）
        const expandForFilter = !!filterText && (node.children || []).some((child) => treeFilterHit(child));
        if (!node.expanded && !expandForFilter) return;
        const box = el('div', 'sb-children');
        if (node.loading) {
            box.appendChild(statusRow('加载中…'));
        } else if (node.error) {
            box.appendChild(statusRow('无法读取：' + node.error, true));
        } else {
            const children = filterText
                ? (node.children || []).filter((child) => treeFilterHit(child))
                : (node.children || []);
            for (const child of children) appendTreeRows(child, box);
            if (!children.length && filterText) box.appendChild(statusRow('无匹配文件'));
            if (node.truncated) box.appendChild(statusRow('仅显示前 ' + readLimit + ' 项'));
        }
        parent.appendChild(box);
    }

    function scrollToActive() {
        requestAnimationFrame(() => {
            const row = body.querySelector('.sb-row.current');
            if (row) row.scrollIntoView({block: 'nearest'});
        });
    }

    function renderTree(scroll) {
        if (!visible || mode !== 'tree') return;
        const prevTop = body.scrollTop;
        body.textContent = '';
        if (!tree) {
            body.appendChild(emptyState('打开文件或文件夹后在此浏览', '打开文件夹…', () => {
                if (typeof openFolder === 'function') openFolder();
            }));
            updateTitle();
            return;
        }
        const frag = document.createDocumentFragment();
        appendTreeRows(tree, frag);
        body.appendChild(frag);
        body.scrollTop = prevTop;
        updateTitle();
        updateSelectionBoundaries();
        if (focused) {
            const row = body.querySelector('.sb-row.anchor') || body.querySelector('.sb-row.selected');
            if (row) row.focus({preventScroll: true});
        }
        if (scroll) scrollToActive();
    }

    async function loadNode(node, seq) {
        if (!node || !node.isDir || node.loaded) return true;
        if (node.loadPromise) return node.loadPromise;
        node.loading = true;
        if (mode === 'tree') renderTree();
        node.loadPromise = (async () => {
            try {
                if (typeof readDir !== 'function') throw new Error('后端不支持目录读取');
                const result = await readDir(node.path, readLimit);
                if (seq != null && seq !== treeSeq) return false;
                const entries = (result && result.entries) || [];
                node.children = entries.map((entry) => ({
                    name: entry.name,
                    path: entry.path,
                    isDir: !!entry.isDir,
                    root: false,
                    expanded: false,
                    loaded: !entry.isDir,
                    loading: false,
                    error: '',
                    truncated: false,
                    mtime: entry.mtime || 0,
                    size: entry.size || 0,
                    children: [],
                    loadPromise: null,
                    refreshing: false,
                })).sort(compareEntries);
                node.truncated = !!(result && result.truncated);
                node.dirMtime = (result && result.mtime) || 0;
                node.loaded = true;
                node.error = '';
                if (!node.children.length) node.expanded = false;
            } catch (e) {
                node.error = String((e && e.message) || e);
                node.loaded = true;
            } finally {
                node.loading = false;
                node.loadPromise = null;
                if (seq == null || seq === treeSeq) renderTree();
            }
            return true;
        })();
        return node.loadPromise;
    }

    function resetTree() {
        treeSeq++;
        revealSeq++;
        const root = treeRootPath();
        if (selection.length) {
            selection = selection.filter((item) => !!root && isWithin(root, item.path));
            if (!selection.some((item) => samePath(item.path, anchorPath))) {
                anchorPath = selection.length ? selection[selection.length - 1].path : null;
            }
        }
        if (!root) {
            tree = null;
            return;
        }
        tree = {
            name: baseName(root) || root,
            path: root,
            isDir: true,
            root: true,
            expanded: true,
            loaded: false,
            loading: false,
            error: '',
            truncated: false,
            dirMtime: 0,
            children: [],
            loadPromise: null,
            refreshing: false,
        };
        loadNode(tree, treeSeq);
    }

    function ensureTree() {
        const root = treeRootPath();
        if (!root) {
            if (tree) {
                tree = null;
                treeSeq++;
                revealSeq++;
            }
            return;
        }
        if (!tree || !samePath(tree.path, root)) resetTree();
    }

    function updateActiveHighlight() {
        for (const row of body.querySelectorAll('.sb-row[data-path]')) {
            row.classList.toggle('current', samePath(row.dataset.path, activePath));
        }
    }

    function normalizeSelectionItem(item) {
        if (!item || !item.path) return null;
        return {path: item.path, name: item.name || baseName(item.path), isDir: !!item.isDir};
    }

    function selectionHas(path) {
        return selection.some((item) => samePath(item.path, path));
    }

    function setSelection(items, anchor) {
        const next = [];
        for (const item of items || []) {
            const entry = normalizeSelectionItem(item);
            if (!entry || next.some((existing) => samePath(existing.path, entry.path))) continue;
            next.push(entry);
        }
        selection = next;
        const anchorHit = anchor && next.some((item) => samePath(item.path, anchor));
        anchorPath = anchorHit ? anchor : (next.length ? next[next.length - 1].path : null);
        updateSelectionHighlight();
    }

    function selectOnly(node) {
        focused = true;
        if (!node || !node.path) {
            setSelection([], null);
            return;
        }
        setSelection([node], node.path);
    }

    function toggleSelection(node) {
        focused = true;
        if (!node || !node.path) return;
        const index = selection.findIndex((item) => samePath(item.path, node.path));
        if (index >= 0) {
            selection.splice(index, 1);
            anchorPath = selection.length ? selection[selection.length - 1].path : null;
        } else {
            selection.push(normalizeSelectionItem(node));
            anchorPath = node.path;
        }
        updateSelectionHighlight();
    }

    function selectForContext(node) {
        focused = true;
        if (!node || !node.path) return;
        if (!selectionHas(node.path)) {
            setSelection([node], node.path);
            return;
        }
        anchorPath = node.path;
        updateSelectionHighlight();
    }

    function selectRangeTo(node, additive) {
        focused = true;
        if (!node || !node.path) return;
        const rows = [...body.querySelectorAll('.sb-row[data-path]')];
        const targetIndex = rows.findIndex((row) => samePath(row.dataset.path, node.path));
        const anchorIndex = anchorPath ? rows.findIndex((row) => samePath(row.dataset.path, anchorPath)) : -1;
        if (targetIndex < 0 || anchorIndex < 0) {
            selectOnly(node);
            return;
        }
        const start = Math.min(anchorIndex, targetIndex);
        const end = Math.max(anchorIndex, targetIndex);
        const range = rows.slice(start, end + 1).map((row) => ({
            path: row.dataset.path,
            name: row.querySelector('.sb-name') ? row.querySelector('.sb-name').textContent : baseName(row.dataset.path),
            isDir: row.dataset.dir === '1',
        }));
        setSelection(additive ? [...selection, ...range] : range, anchorPath);
    }

    function updateSelectionBoundaries() {
        const rows = [...body.querySelectorAll('.sb-row')];
        for (const row of rows) row.classList.remove('sel-first', 'sel-last');
        let index = 0;
        while (index < rows.length) {
            if (!rows[index].classList.contains('selected')) {
                index++;
                continue;
            }
            const start = index;
            while (index + 1 < rows.length && rows[index + 1].classList.contains('selected')) index++;
            rows[start].classList.add('sel-first');
            rows[index].classList.add('sel-last');
            index++;
        }
    }

    function updateSelectionHighlight() {
        for (const row of body.querySelectorAll('.sb-row[data-path]')) {
            row.classList.toggle('selected', selectionHas(row.dataset.path));
            row.classList.toggle('anchor', samePath(row.dataset.path, anchorPath));
        }
        updateSelectionBoundaries();
    }

    function updateCutHighlight() {
        for (const row of body.querySelectorAll('.sb-row[data-path]')) {
            row.classList.toggle('cut', cutPaths.some((path) => samePath(row.dataset.path, path)));
        }
    }

    function setCutPaths(paths) {
        cutPaths = (paths || []).filter(Boolean);
        updateCutHighlight();
    }

    function setCutPath(path) {
        setCutPaths(path ? [path] : []);
    }

    function selectPath(path, isDir) {
        if (!path) {
            setSelection([], null);
            return;
        }
        setSelection([{path, name: baseName(path), isDir: !!isDir}], path);
        const row = body.querySelector('.sb-row.selected');
        if (row) row.scrollIntoView({block: 'nearest'});
    }

    function selectPaths(items) {
        setSelection(items, items && items.length ? items[items.length - 1].path : null);
        const row = body.querySelector('.sb-row.anchor') || body.querySelector('.sb-row.selected');
        if (row) row.scrollIntoView({block: 'nearest'});
    }

    async function revealActive() {
        if (!tree || !activePath || !isWithin(tree.path, activePath)) return;
        const seq = ++revealSeq;
        let node = tree;
        node.expanded = true;
        while (node && node.isDir) {
            await loadNode(node, treeSeq);
            if (seq !== revealSeq) return;
            if (samePath(node.path, parentPath(activePath))) break;
            const next = node.children.find((child) => child.isDir && isWithin(child.path, activePath));
            if (!next) break;
            next.expanded = true;
            node = next;
        }
        if (seq !== revealSeq) return;
        renderTree(true);
    }

    async function loadList(force) {
        const root = listRootPath();
        if (!root) {
            listState = {root: null, entries: [], tooMany: false, error: '', loading: false, loaded: true, token: listState.token, dirMtime: 0};
            renderList();
            return;
        }
        if (!force && listState.root && samePath(listState.root, root) && listState.loaded) {
            renderList();
            return;
        }
        const token = ++listState.token;
        listState = {root, entries: [], tooMany: false, error: '', loading: true, loaded: false, token, dirMtime: 0};
        renderList();
        try {
            if (typeof readDir !== 'function') throw new Error('后端不支持目录读取');
            const result = await readDir(root, listReadLimit);
            if (token !== listState.token) return;
            const files = ((result && result.entries) || [])
                .filter((entry) => !entry.isDir && canList(entry.name))
                .sort(compareEntries);
            listState.entries = files;
            listState.tooMany = !!(result && result.truncated) || files.length > listLimit;
            listState.dirMtime = (result && result.mtime) || 0;
            listState.error = '';
        } catch (e) {
            if (token !== listState.token) return;
            listState.error = String((e && e.message) || e);
        } finally {
            if (token === listState.token) {
                listState.loading = false;
                listState.loaded = true;
                renderList();
            }
        }
    }

    function listRow(entry) {
        const row = el('div', 'sb-row sb-list-row' + (samePath(entry.path, activePath) ? ' current' : '') +
            (selectionHas(entry.path) ? ' selected' : '') +
            (samePath(entry.path, anchorPath) ? ' anchor' : '') +
            (cutPaths.some((path) => samePath(entry.path, path)) ? ' cut' : ''));
        row.dataset.path = entry.path;
        row.tabIndex = -1;
        row.append(createFileIcon(entry.name, 'sb-icon'), el('span', 'sb-name', entry.name));
        row.addEventListener('click', (e) => {
            row.focus({preventScroll: true});
            const node = {path: entry.path, name: entry.name, isDir: false};
            if (e.shiftKey) {
                selectRangeTo(node, e.ctrlKey || e.metaKey);
                return;
            }
            if (e.ctrlKey || e.metaKey) toggleSelection(node);
            else selectOnly(node);
        });
        row.addEventListener('dblclick', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.ctrlKey || e.metaKey || e.shiftKey) return;
            if (typeof openPath === 'function') openPath(entry.path);
        });
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            selectForContext({path: entry.path, name: entry.name, isDir: false});
            if (typeof onContextMenu === 'function') {
                onContextMenu({kind: 'list', name: entry.name, path: entry.path, isDir: false}, e.clientX, e.clientY, null);
            }
        });
        return row;
    }

    function renderList() {
        if (!visible || mode !== 'list') return;
        const prevTop = body.scrollTop;
        body.textContent = '';
        if (!listState.root) {
            body.appendChild(emptyState('打开文件后显示所在目录', '打开文件…', () => {
                if (typeof openFileDialog === 'function') openFileDialog();
            }));
        } else if (listState.loading) {
            body.appendChild(emptyState('正在读取目录…'));
        } else if (listState.error) {
            body.appendChild(emptyState('无法读取目录：' + listState.error));
        } else if (listState.tooMany) {
            body.appendChild(emptyState('文件数量过多，请使用文件树视图', '切换到文件树', () => setMode('tree')));
        } else if (!listState.entries.length) {
            body.appendChild(emptyState('此目录没有可用的数据文件'));
        } else {
            const frag = document.createDocumentFragment();
            const entries = filterText
                ? listState.entries.filter((entry) => String(entry.name || '').toLowerCase().includes(filterText))
                : listState.entries;
            for (const entry of entries) frag.appendChild(listRow(entry));
            if (!entries.length) body.appendChild(emptyState('没有匹配的文件'));
            body.appendChild(frag);
            body.scrollTop = prevTop;
            updateSelectionBoundaries();
            if (focused) {
                const row = body.querySelector('.sb-row.anchor') || body.querySelector('.sb-row.selected');
                if (row) row.focus({preventScroll: true});
            }
            scrollToActive();
        }
        updateTitle();
    }

    function setMode(next, notify = true) {
        if (next !== 'tree' && next !== 'list') return;
        const changed = mode !== next;
        if (changed) {
            selection = [];
            anchorPath = null;
        }
        mode = next;
        updateModeButtons();
        if (changed && notify && typeof onModeChange === 'function') onModeChange(mode);
        if (!visible) return;
        if (mode === 'list') {
            loadList(false);
        } else {
            ensureTree();
            renderTree();
            revealActive();
        }
    }

    function setVisible(next) {
        const want = !!next;
        if (visible === want) return;
        visible = want;
        if (!visible) {
            focused = false;
            clearTimeout(autoRefreshTimer);
            autoRefreshTimer = 0;
            return;
        }
        if (mode === 'list') {
            loadList(false);
        } else {
            ensureTree();
            renderTree();
            revealActive();
        }
        scheduleAutoRefresh(0);
    }

    function setRoot(path) {
        explicitRoot = path || null;
        tree = null;
        selection = [];
        anchorPath = null;
        filterText = '';
        treeSeq++;
        revealSeq++;
        if (visible && mode === 'tree') {
            ensureTree();
            renderTree();
            revealActive();
        } else {
            updateTitle();
        }
    }

    function setActive(path) {
        activePath = path || null;
        if (!visible) return;
        if (mode === 'list') {
            const root = listRootPath();
            if (selection.length) {
                selection = selection.filter((item) => root && samePath(parentPath(item.path), root));
                if (!selection.some((item) => samePath(item.path, anchorPath))) {
                    anchorPath = selection.length ? selection[selection.length - 1].path : null;
                }
            }
            loadList(false);
        } else {
            const prevRoot = tree ? tree.path : null;
            ensureTree();
            if (!tree) {
                renderTree();
            } else if (!prevRoot || !samePath(prevRoot, tree.path)) {
                renderTree();
                revealActive();
            } else {
                updateActiveHighlight();
                revealActive();
            }
            updateTitle();
        }
    }

    function refresh() {
        if (!visible) return;
        if (mode === 'list') {
            loadList(true);
        } else {
            tree = null;
            treeSeq++;
            revealSeq++;
            ensureTree();
            renderTree();
            revealActive();
        }
        scheduleAutoRefresh();
    }

    function isNodeAttached(node) {
        if (!tree || !node) return false;
        if (samePath(tree.path, node.path)) return tree === node;
        return findLoadedNode(tree, node.path) === node;
    }

    function collectExpanded(node, out) {
        if (!node || !node.isDir) return;
        if (node.expanded && node.loaded) out.push(node);
        for (const child of node.children || []) collectExpanded(child, out);
    }

    function mergeChildren(node, entries, truncated, dirMtimeValue) {
        const previous = new Map((node.children || []).map((child) => [normalizePath(child.path), child]));
        let changed = false;
        const next = entries.map((entry) => {
            const key = normalizePath(entry.path);
            let child = previous.get(key);
            if (child) {
                previous.delete(key);
                if (child.name !== entry.name) {
                    child.name = entry.name;
                    changed = true;
                }
                child.mtime = entry.mtime || 0;
                child.size = entry.size || 0;
                if (!!child.isDir !== !!entry.isDir) {
                    child.isDir = !!entry.isDir;
                    child.expanded = false;
                    child.children = [];
                    child.loaded = !child.isDir;
                    child.loading = false;
                    child.error = '';
                    child.truncated = false;
                    child.loadPromise = null;
                    child.refreshing = false;
                    child.dirMtime = 0;
                    changed = true;
                }
                return child;
            }
            changed = true;
            return {
                name: entry.name,
                path: entry.path,
                isDir: !!entry.isDir,
                root: false,
                expanded: false,
                loaded: !entry.isDir,
                loading: false,
                error: '',
                truncated: false,
                mtime: entry.mtime || 0,
                size: entry.size || 0,
                dirMtime: 0,
                children: [],
                loadPromise: null,
                refreshing: false,
            };
        });
        next.sort(compareEntries);
        if (!changed) {
            if (next.length !== node.children.length) changed = true;
            else if (next.some((child, index) => child !== node.children[index])) changed = true;
        }
        if (node.truncated !== !!truncated) changed = true;
        if (node.error) changed = true;
        node.children = next;
        node.truncated = !!truncated;
        node.dirMtime = dirMtimeValue || 0;
        node.loaded = true;
        node.error = '';
        if (!next.length && node.expanded) {
            node.expanded = false;
            changed = true;
        }
        return changed;
    }

    async function refreshNodeChildren(node, force) {
        if (!node || !node.isDir || node.loading || node.loadPromise || node.refreshing) return false;
        node.refreshing = true;
        const path = node.path;
        try {
            if (typeof readDir !== 'function') return false;
            if (!force && node.dirMtime && typeof dirMtime === 'function') {
                try {
                    const current = await dirMtime(path);
                    if (current && Number(current) === node.dirMtime) return false;
                } catch (e) {}
                if (!isNodeAttached(node) || node.loading || node.loadPromise || !samePath(node.path, path)) return false;
            }
            const result = await readDir(path, readLimit);
            if (!isNodeAttached(node) || node.loading || node.loadPromise || !samePath(node.path, path)) return false;
            return mergeChildren(node, (result && result.entries) || [], !!(result && result.truncated), result && result.mtime);
        } catch (e) {
            if (!isNodeAttached(node) || (node.children && node.children.length && !node.root)) return false;
            const message = String((e && e.message) || e);
            if (node.error !== message) {
                node.error = message;
                return true;
            }
            return false;
        } finally {
            node.refreshing = false;
        }
    }

    async function refreshTreeSilently() {
        if (!tree) return;
        const targets = [];
        collectExpanded(tree, targets);
        const visiblePaths = new Set();
        for (const row of body.querySelectorAll('.sb-row[data-path][data-dir="1"]')) {
            visiblePaths.add(normalizePath(row.dataset.path));
        }
        let changed = false;
        for (const node of targets) {
            if (!isNodeAttached(node) || !node.expanded) continue;
            // 视野外的展开目录无需每轮校验：用户的注意力与可见性一致，IDE 通行做法
            if (visiblePaths.size && !visiblePaths.has(normalizePath(node.path))) continue;
            if (await refreshNodeChildren(node)) changed = true;
        }
        if (changed && visible && mode === 'tree') renderTree();
    }

    async function refreshListSilently() {
        if (!visible || mode !== 'list' || listState.loading) return;
        const root = listRootPath();
        if (!root) return;
        if (listState.dirMtime && typeof dirMtime === 'function') {
            try {
                const current = await dirMtime(root);
                if (current && Number(current) === listState.dirMtime) return;
            } catch (e) {}
            if (mode !== 'list' || !samePath(root, listRootPath()) || listState.loading) return;
        }
        const token = listState.token;
        let result;
        try {
            result = await readDir(root, listReadLimit);
        } catch (e) {
            if (token !== listState.token || mode !== 'list' || !samePath(root, listRootPath()) || listState.loading) return;
            const message = String((e && e.message) || e);
            if (listState.error !== message) {
                listState.error = message;
                listState.loaded = true;
                if (visible) renderList();
            }
            return;
        }
        if (token !== listState.token || mode !== 'list' || !samePath(root, listRootPath()) || listState.loading) return;
        const files = ((result && result.entries) || [])
            .filter((entry) => !entry.isDir && canList(entry.name))
            .sort(compareEntries);
        const tooMany = !!(result && result.truncated) || files.length > listLimit;
        const previous = listState.entries;
        let changed = !!listState.error || tooMany !== listState.tooMany ||
            files.length !== previous.length ||
            files.some((entry, index) => entry.path !== previous[index].path);
        listState.root = root;
        listState.entries = files;
        listState.tooMany = tooMany;
        listState.dirMtime = (result && result.mtime) || 0;
        listState.error = '';
        listState.loaded = true;
        if (changed) {
            if (!tooMany && selection.length) {
                selection = selection.filter((item) => files.some((entry) => samePath(entry.path, item.path)));
                if (!selection.some((item) => samePath(item.path, anchorPath))) {
                    anchorPath = selection.length ? selection[selection.length - 1].path : null;
                }
            }
            if (visible) renderList();
        }
    }

    function scheduleAutoRefresh(delay) {
        clearTimeout(autoRefreshTimer);
        autoRefreshTimer = 0;
        if (!(autoRefreshSeconds > 0) || !visible) return;
        const wait = typeof delay === 'number' ? delay : autoRefreshSeconds * 1000;
        autoRefreshTimer = setTimeout(runAutoRefresh, Math.max(0, wait));
    }

    // ---- 文件系统通知：按变化目录局部刷新，溢出时全量重建 ----
    function scheduleExternalRefresh() {
        if (externalTimer) return;
        externalTimer = setTimeout(flushExternalChanges, 120);
    }

    async function flushExternalChanges() {
        externalTimer = 0;
        if (!tree) {
            const hasChanges = externalDirs.size || externalOverflow;
            externalDirs.clear();
            externalOverflow = false;
            if (hasChanges && mode === 'list' && visible && listState.root) await loadList(true);
            return;
        }
        if (externalOverflow) {
            externalOverflow = false;
            externalDirs.clear();
            tree = null;
            treeSeq++;
            revealSeq++;
            if (visible && mode === 'tree') {
                ensureTree();
                renderTree();
            }
            return;
        }
        const nodes = [];
        for (const dir of externalDirs) {
            const node = findLoadedNode(tree, dir);
            if (node && node.isDir) nodes.push(node);
        }
        const listRoot = mode === 'list' ? listRootPath() : null;
        const listHit = !!listRoot && [...externalDirs].some((dir) => isWithin(dir, listRoot) || isWithin(listRoot, dir));
        externalDirs.clear();
        let changed = false;
        await Promise.all(nodes.map(async (node) => {
            if (!isNodeAttached(node)) return;
            if (node.expanded || node.root) {
                if (await refreshNodeChildren(node, true)) changed = true;
            } else {
                // 收起状态下不读盘，等下次展开时重新加载
                node.loaded = false;
                node.children = [];
                node.dirMtime = 0;
            }
        }));
        if (listHit && visible && mode === 'list') {
            await loadList(true);
        }
        if (changed && visible && mode === 'tree') renderTree();
    }

    function handleExternalChanges(payload) {
        if (!payload) return;
        const current = tree ? tree.path : listRootPath();
        if (!current) return;
        const root = String(payload.root || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        const currentRoot = String(current).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        if (!root) return;
        if (currentRoot !== root && !currentRoot.startsWith(root + '/')) return;
        if (payload.overflow) {
            externalOverflow = true;
            scheduleExternalRefresh();
            return;
        }
        const base = String(payload.root || '').replace(/\\/g, '/').replace(/\/+$/, '');
        for (const rel of payload.paths || []) {
            const full = base + '/' + String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
            externalDirs.add(parentPath(full));
        }
        if (externalDirs.size) scheduleExternalRefresh();
    }

    async function runAutoRefresh() {
        autoRefreshTimer = 0;
        if (!(autoRefreshSeconds > 0) || !visible) return;
        if (autoRefreshBusy || document.hidden || !document.hasFocus()) {
            scheduleAutoRefresh();
            return;
        }
        if (document.querySelector('.ctx-menu:not(.hidden)')) {
            scheduleAutoRefresh();
            return;
        }
        autoRefreshBusy = true;
        try {
            if (mode === 'list') await refreshListSilently();
            else await refreshTreeSilently();
        } catch (e) {
        } finally {
            autoRefreshBusy = false;
            scheduleAutoRefresh();
        }
    }

    function setAutoRefresh(seconds) {
        const next = Number(seconds);
        const value = Number.isFinite(next) ? Math.max(0, next) : 0;
        if (value === autoRefreshSeconds) return;
        autoRefreshSeconds = value;
        if (value > 0) {
            scheduleAutoRefresh(0);
        } else {
            clearTimeout(autoRefreshTimer);
            autoRefreshTimer = 0;
        }
    }

    function toggleNode(node) {
        if (!node || !node.isDir || isEmptyDirNode(node)) return;
        node.expanded = !node.expanded;
        if (!node.expanded) {
            renderTree();
            return;
        }
        if (!node.loaded) {
            loadNode(node, treeSeq);
            return;
        }
        // 已缓存目录展开只做渲染；新鲜度交给 mtime 比对/文件通知，避免与定时器重复扫描
        renderTree();
    }

    function findLoadedNode(node, path) {
        if (!node) return null;
        if (samePath(node.path, path)) return node;
        if (!node.isDir || !node.children) return null;
        for (const child of node.children) {
            const found = findLoadedNode(child, path);
            if (found) return found;
        }
        return null;
    }

    function remapPath(path, oldPath, newPath) {
        if (!path) return path;
        const target = String(path).replace(/\\/g, '/');
        const oldNorm = String(oldPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
        if (!oldNorm) return path;
        const lowerTarget = target.toLowerCase();
        const lowerOld = oldNorm.toLowerCase();
        if (lowerTarget === lowerOld) return newPath;
        if (!lowerTarget.startsWith(lowerOld + '/')) return path;
        const rest = target.slice(oldNorm.length);
        return String(newPath).replace(/\\/g, '/').replace(/\/+$/, '') + rest;
    }

    function rewriteSubtree(node, oldPath, newPath) {
        if (!node) return;
        if (isWithin(oldPath, node.path)) {
            node.path = remapPath(node.path, oldPath, newPath);
            node.name = baseName(node.path);
        }
        for (const child of node.children || []) {
            rewriteSubtree(child, oldPath, newPath);
        }
    }

    async function refreshDir(path) {
        if (!visible || mode !== 'tree' || !tree) return false;
        const node = findLoadedNode(tree, path);
        if (!node || !node.isDir) return false;
        node.expanded = true;
        node.loaded = false;
        await loadNode(node, treeSeq);
        return true;
    }

    function detachNode(parent, path) {
        if (!parent || !parent.children) return false;
        const index = parent.children.findIndex((child) => samePath(child.path, path));
        if (index >= 0) {
            parent.children.splice(index, 1);
            return true;
        }
        for (const child of parent.children) {
            if (detachNode(child, path)) return true;
        }
        return false;
    }

    function dropPathFromSelection(path) {
        if (!path) return;
        selection = selection.filter((item) => !isWithin(path, item.path));
        if (!selection.some((item) => samePath(item.path, anchorPath))) {
            anchorPath = selection.length ? selection[selection.length - 1].path : null;
        }
        cutPaths = cutPaths.filter((cut) => !isWithin(path, cut));
    }

    function removePath(path) {
        if (!path) return false;
        dropPathFromSelection(path);
        if (!tree) return false;
        if (samePath(tree.path, path)) {
            tree = null;
            treeSeq++;
            revealSeq++;
            if (visible) renderTree();
            return true;
        }
        const removed = detachNode(tree, path);
        if (removed && visible) renderTree();
        return removed;
    }

    function pathRenamed(oldPath, newPath) {
        if (!oldPath || !newPath) return;
        for (const item of selection) {
            item.path = remapPath(item.path, oldPath, newPath);
            item.name = baseName(item.path);
        }
        if (anchorPath) anchorPath = remapPath(anchorPath, oldPath, newPath);
        cutPaths = cutPaths.map((path) => remapPath(path, oldPath, newPath));
        if (mode === 'list') {
            listState.loaded = false;
            if (visible) loadList(true);
            return;
        }
        if (!tree) return;
        rewriteSubtree(tree, oldPath, newPath);
        if (activePath) activePath = remapPath(activePath, oldPath, newPath);
        if (explicitRoot) explicitRoot = remapPath(explicitRoot, oldPath, newPath);
        if (visible) {
            renderTree();
            updateTitle();
        }
    }

    if (refreshBtn) {
        refreshBtn.innerHTML = ICONS.refresh;
        if (filterBtn) {
            filterBtn.innerHTML = ICONS.filter;
            filterBtn.addEventListener('click', () => {
                if (typeof onToggleFilter === 'function') onToggleFilter();
            });
        }
        refreshBtn.addEventListener('click', refresh);
    }
    if (listBtn) {
        listBtn.innerHTML = ICONS.list;
        listBtn.addEventListener('click', () => setMode('list'));
    }
    if (treeBtn) {
        treeBtn.innerHTML = ICONS.tree;
        treeBtn.addEventListener('click', () => setMode('tree'));
    }
    updateModeButtons();

    document.addEventListener('pointerdown', (e) => {
        focused = !!(e.target && body.contains(e.target));
    }, true);
    document.addEventListener('focusin', (e) => {
        focused = !!(e.target && body.contains(e.target));
    }, true);
    window.addEventListener('focus', () => {
        if (autoRefreshSeconds > 0) scheduleAutoRefresh(0);
    });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && autoRefreshSeconds > 0) scheduleAutoRefresh(0);
    });

    return {
        setVisible,
        setMode,
        getMode: () => mode,
        setFilter,
        setRoot,
        getRoot: currentRoot,
        setActive,
        refresh,
        toggleNode,
        refreshDir,
        pathRenamed,
        handleExternalChanges,
        removePath,
        getSelection: () => selection.map((item) => ({...item})),
        getAnchor: () => {
            const item = selection.find((entry) => samePath(entry.path, anchorPath));
            return item ? {...item} : (selection.length ? {...selection[selection.length - 1]} : null);
        },
        selectPath,
        selectPaths,
        hasFocus: () => focused,
        setCutPaths,
        setCutPath,
        setAutoRefresh,
    };
}
