const ICONS = {
    chevron: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    folder: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.7c0-.9.7-1.7 1.7-1.7h2.9l1.6 1.8h4.1c.9 0 1.7.7 1.7 1.7v4.8c0 .9-.7 1.7-1.7 1.7H3.7c-.9 0-1.7-.7-1.7-1.7z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    file: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.8h5.2L12 5.6v7.6H4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9.2 2.8v2.8H12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    list: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.2h10M3 8h10M3 11.8h10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    tree: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.2v9.6M3 6h4.2M3 11.8h4.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M7.2 4.6h5.2v2.8H7.2zM7.2 10.4h5.2v2.8H7.2z" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>',
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

function fileKind(name) {
    const base = String(name || '').toLowerCase();
    const dot = base.lastIndexOf('.');
    const ext = dot < 0 ? '' : base.slice(dot + 1);
    if (['json', 'jsonc', 'json5'].includes(ext)) return 'json';
    if (['yaml', 'yml'].includes(ext)) return 'yaml';
    if (['xml', 'svg'].includes(ext)) return 'xml';
    if (['csv', 'tsv'].includes(ext)) return 'csv';
    if (['png', 'jpg', 'jpeg', 'jfif', 'gif', 'bmp', 'webp', 'ico', 'tif', 'tiff',
        'avif', 'heic', 'heif', 'psd', 'raw', 'cr2', 'nef', 'arw', 'dng'].includes(ext)) return 'image';
    return 'text';
}

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
        body, titleEl, refreshBtn, listBtn, treeBtn,
        readDir, openPath, openFolder, openFileDialog, isSupported,
        onModeChange, onContextMenu, listLimit = 200, readLimit = 1000, listReadLimit = 5000,
    } = options;
    let mode = 'tree';
    let visible = false;
    let explicitRoot = null;
    let activePath = null;
    let tree = null;
    let treeSeq = 0;
    let revealSeq = 0;
    let listState = {root: null, entries: [], tooMany: false, error: '', loading: false, loaded: false, token: 0};

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
            titleEl.textContent = root ? (baseName(root) || root) : '资源';
            titleEl.title = root || '文件侧边栏';
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

    function treeRow(node) {
        const row = el('div', 'sb-row sb-tree-row' + (node.root ? ' sb-root' : '') +
            (node.isDir ? ' sb-dir' : '') + (samePath(node.path, activePath) ? ' current' : ''));
        row.dataset.path = node.path;
        row.dataset.dir = node.isDir ? '1' : '0';
        if (node.path) row.title = node.path;
        const chev = el('span', 'sb-chev' + (node.isDir && node.expanded ? ' open' : ''));
        if (node.isDir) chev.innerHTML = ICONS.chevron;
        const icon = el('span', 'sb-icon' + (node.isDir ? ' sb-dir-icon' : ' sb-ft-' + fileKind(node.name)));
        icon.innerHTML = node.isDir ? ICONS.folder : ICONS.file;
        const name = el('span', 'sb-name', node.name);
        row.append(chev, icon, name);
        row.addEventListener('click', () => {
            if (node.isDir) {
                node.expanded = !node.expanded;
                if (node.expanded && !node.loaded) loadNode(node, treeSeq);
                else renderTree();
            } else if (typeof openPath === 'function') {
                openPath(node.path);
            }
        });
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (typeof onContextMenu === 'function') {
                onContextMenu({kind: 'tree', name: node.name, path: node.path, isDir: node.isDir}, e.clientX, e.clientY, node);
            }
        });
        return row;
    }

    function appendTreeRows(node, parent) {
        parent.appendChild(treeRow(node));
        if (!node.isDir || !node.expanded) return;
        const box = el('div', 'sb-children');
        if (node.loading) {
            box.appendChild(statusRow('加载中…'));
        } else if (node.error) {
            box.appendChild(statusRow('无法读取：' + node.error, true));
        } else {
            for (const child of node.children) appendTreeRows(child, box);
            if (!node.children.length) box.appendChild(statusRow('空文件夹'));
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
                    children: [],
                    loadPromise: null,
                })).sort(compareEntries);
                node.truncated = !!(result && result.truncated);
                node.loaded = true;
                node.error = '';
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
            children: [],
            loadPromise: null,
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
            listState = {root: null, entries: [], tooMany: false, error: '', loading: false, loaded: true, token: listState.token};
            renderList();
            return;
        }
        if (!force && listState.root && samePath(listState.root, root) && listState.loaded) {
            renderList();
            return;
        }
        const token = ++listState.token;
        listState = {root, entries: [], tooMany: false, error: '', loading: true, loaded: false, token};
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
        const row = el('div', 'sb-row sb-list-row' + (samePath(entry.path, activePath) ? ' current' : ''));
        row.dataset.path = entry.path;
        if (entry.path) row.title = entry.path;
        const icon = el('span', 'sb-icon sb-ft-' + fileKind(entry.name));
        icon.innerHTML = ICONS.file;
        row.append(icon, el('span', 'sb-name', entry.name));
        row.addEventListener('click', () => {
            if (typeof openPath === 'function') openPath(entry.path);
        });
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
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
            for (const entry of listState.entries) frag.appendChild(listRow(entry));
            body.appendChild(frag);
            body.scrollTop = prevTop;
            scrollToActive();
        }
        updateTitle();
    }

    function setMode(next, notify = true) {
        if (next !== 'tree' && next !== 'list') return;
        const changed = mode !== next;
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
        if (!visible) return;
        if (mode === 'list') {
            loadList(false);
        } else {
            ensureTree();
            renderTree();
            revealActive();
        }
    }

    function setRoot(path) {
        explicitRoot = path || null;
        tree = null;
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
    }

    function toggleNode(node) {
        if (!node || !node.isDir) return;
        node.expanded = !node.expanded;
        if (node.expanded && !node.loaded) loadNode(node, treeSeq);
        else renderTree();
    }

    if (refreshBtn) {
        refreshBtn.innerHTML = ICONS.refresh;
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

    return {
        setVisible,
        setMode,
        getMode: () => mode,
        setRoot,
        getRoot: currentRoot,
        setActive,
        refresh,
        toggleNode,
    };
}
