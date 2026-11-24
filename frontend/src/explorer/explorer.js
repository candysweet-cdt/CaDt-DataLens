import {el} from '../core/dom.js';
import {iconSvg} from '../core/icons.js';

// 局部键 → 注册表键（原散落 SVG 已收编 core/icons.js）；svg 尺寸由 .sb-chev/.sb-icon/.sb-tool 的 CSS 规则统一
const ICONS = {
    chevron: iconSvg('chevron-right'),
    folder: iconSvg('folder'),
    list: iconSvg('list'),
    tree: iconSvg('tree'),
    filter: iconSvg('filter'),
    refresh: iconSvg('refresh'),
    reveal: iconSvg('locate'),
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

// .cadt 显隐的纯逻辑（供测试与树/列表两视图共用）。
// 只在工作区根这一层判定：用户直接把某个目录设成根时，不误伤同名子目录。
export function isCadDirEntry(entry) {
    return !!(entry && entry.isDir && String(entry.name).toLowerCase() === '.cadt');
}

export function visibleTreeEntries(entries, root, showCadDir) {
    if (!root || showCadDir) return entries;
    return entries.filter((entry) => !isCadDirEntry(entry));
}

// isMissingDirError：后端 ReadDir 对「目录不存在」的错误文案（跨平台）。
// scratch 目录首次不存在是正常初始状态，不该当读取错误显示（GetFileAttributesEx 截图）。
export function isMissingDirError(message) {
    const s = String(message || '').toLowerCase();
    if (!s) return false;
    return s.includes('getfileattributesex') && /find the file|找不到|不存在|not find/.test(s)
        || s.includes('no such file or directory')
        || s.includes('系统找不到指定的文件')
        || /\bgetfileattributesex\b/.test(s) && /find/.test(s);
}

import {createFileIcon} from '../core/fileicons.js';
import {createExplorerList} from './explorer-list.js';

function compareEntries(a, b) {
    if (!!a.isDir !== !!b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN', {numeric: true, sensitivity: 'base'});
}

// 目录子项差量合并：复用已有节点对象，只有「结构」变化才返回 true。
// 纯内容修改（仅 mtime / size 变化）刻意不算变更 —— 文件树不需要为此重建 DOM，
// 否则 AI 连续编辑 / 文件监听事件会让整棵树不停闪烁。
export function mergeChildren(node, entries, truncated, dirMtimeValue) {
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

// verticalScrollFor 计算「把行滚进垂直视野」后的 scrollTop（对齐 IDEA：只垂直 reveal，横向滚动条不动）。
// 纯函数、可单测：rowTop/rowBottom 是行相对滚动容器内容区的偏移，viewTop/viewH 是当前可视区。
// 行完全可见返回当前 scrollTop；在上方则贴顶、在下方则贴底，与 scrollIntoView({block:'nearest'}) 等价。
export function verticalScrollFor(rowTop, rowBottom, viewTop, viewH) {
    if (viewH <= 0) return viewTop;
    if (rowTop < viewTop) return rowTop;
    if (rowBottom > viewTop + viewH) return rowBottom - viewH;
    return viewTop;
}

// revealRowVertically 只调整容器的垂直滚动，保留 scrollLeft（打开文件不该挪动横向滚动条）。
function revealRowVertically(container, row) {
    if (!container || !row) return;
    const rowTop = row.offsetTop;
    const rowBottom = rowTop + row.offsetHeight;
    const next = verticalScrollFor(rowTop, rowBottom, container.scrollTop, container.clientHeight);
    if (next !== container.scrollTop) container.scrollTop = next;
}

export function createExplorer(options) {
    const {
        body, titleEl, refreshBtn, revealBtn, listBtn, treeBtn, filterBtn, onToggleFilter,
        readDir, dirMtime, openPath, openFolder, openFileDialog, isSupported,
        onModeChange, onContextMenu, onMove, onExternalDrop, canDrag,
        scratchRoot,
        readLimit = 1000, listReadLimit = 5000,
    } = options;
    // 列表扫描上限三常量随列表引擎迁入 explorer-list.js；忽略表与文件系统通知共用，留宿主
    // .cadt 是否跳过由 showCadDir 开关决定（默认显示），不写死在这张表——见 syncCadDirSkip。
    const LIST_SKIP_DIRS = new Set(['.git', 'node_modules', '.svn', '.hg', '__pycache__', '.idea', '.vs']);
    let showCadDir = true;
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
    let autoRefreshSeconds = -1;
    let autoRefreshTimer = 0;
    let autoRefreshBusy = false;
    let externalTimer = 0;
    let externalOverflow = false;
    const externalDirs = new Set();
    let dragState = null;
    // 「临时草稿」固定节点（JetBrains 的 Scratches and Consoles 同款）：不在 tree.children 里，
    // 由 renderTree 单独追加在根节点之后；路径是真实的 <ws>/.cadt/scratch，loadNode 照常读盘。
    let scratchNode = null;

    const canList = (name) => (typeof isSupported === 'function' ? isSupported(name) : true);

    // 扁平列表视图引擎（phase3 X1 拆出的同域兄弟模块）：树/列表共享的选择状态、渲染辅助与
    // options 经 deps 注入，let 状态一律 getter/setter 活引用（禁止值快照）。
    const listMod = createExplorerList({
        readDir, dirMtime, openPath, openFileDialog, onContextMenu, readLimit, listReadLimit, body,
        samePath, compareEntries, el, canList, skipDirs: LIST_SKIP_DIRS, listRootPath,
        emptyState, statusRow, updateTitle, updateSelectionBoundaries, scrollToActive,
        selectionHas, selectRangeTo, toggleSelection, selectOnly, selectForContext,
        getMode: () => mode,
        getVisible: () => visible,
        getActivePath: () => activePath,
        getFocused: () => focused,
        getFilterText: () => filterText,
        getCutPaths: () => cutPaths,
        getSelection: () => selection,
        setSelection: (next) => { selection = next; },
        getAnchorPath: () => anchorPath,
        setAnchorPath: (next) => { anchorPath = next; },
    });
    const loadList = (...args) => listMod.loadList(...args);
    const renderList = (...args) => listMod.renderList(...args);
    const refreshListSilently = (...args) => listMod.refreshListSilently(...args);
    const requestListReveal = () => listMod.requestListReveal();
    const getListState = () => listMod.getListState();
    const invalidateList = () => listMod.invalidateList();

    function treeRootPath() {
        if (explicitRoot) return explicitRoot;
        if (!activePath) return null;
        if (tree && isWithin(tree.path, activePath)) return tree.path;
        return parentPath(activePath);
    }

    function listRootPath() {
        // 打开了工作区就扫工作区下所有文件（含嵌套）；只开了单个文件则扫其所在目录及子文件夹
        if (explicitRoot) return explicitRoot;
        return activePath ? parentPath(activePath) : null;
    }

    // 树里是否显示应用自己的状态目录 .cadt（AI 记忆 / 日志 / 补丁 / 草稿都在里面）。
    // 默认显示（showCadDir=true）；关掉时只在工作区根这一层隐藏，草稿仍由下面的
    // 「临时草稿」固定节点单独承载。纯过滤逻辑抽到 visibleTreeEntries，供测试覆盖。
    function filterTreeEntries(node, entries) {
        return visibleTreeEntries(entries, !!(node && node.root), showCadDir);
    }

    // 草稿固定节点的路径：没打开工作区 / 调用方没提供时返回空串（节点不出现）
    function scratchRootPath() {
        return typeof scratchRoot === 'function' ? String(scratchRoot() || '') : '';
    }

    // ensureScratchNode：路径变了就重建（切工作区），否则复用同一个对象保住展开态
    function ensureScratchNode() {
        const dir = scratchRootPath();
        if (!dir) {
            scratchNode = null;
            return null;
        }
        if (scratchNode && samePath(scratchNode.path, dir)) return scratchNode;
        scratchNode = {
            name: '临时文件',
            path: dir,
            isDir: true,
            // root 语义 = 固定节点：不可拖拽、名字加粗（与工作区根同款）
            root: true,
            scratch: true,
            expanded: false,
            loaded: false,
            loading: false,
            error: '',
            truncated: false,
            dirMtime: 0,
            children: [],
            loadPromise: null,
            refreshing: false,
        };
        return scratchNode;
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
            // 不给 tooltip：箭头方向已经把「展开 / 收起」说完了，鼠标在树里移动时冒泡只会烦人
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
                // 连点箭头每次都即时 toggle：不再用 e.detail>1 吞掉双击窗口内的点击
                // （浏览器双击间隔 ~500ms，会让快速连续展开/收起明显不跟手）。
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
                onContextMenu({kind: 'tree', name: node.name, path: node.path, isDir: node.isDir, isRoot: !!node.root, scratch: !!node.scratch}, e.clientX, e.clientY, node);
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
            if (row) revealRowVertically(body, row);
        });
    }

    function renderTree(scroll) {
        if (!visible || mode !== 'tree') return;
        const prevTop = body.scrollTop;
        body.textContent = '';
        if (!tree) {
            body.appendChild(emptyState('未打开工作区', '打开文件夹…', () => {
                if (typeof openFolder === 'function') openFolder();
            }));
            updateTitle();
            return;
        }
        const frag = document.createDocumentFragment();
        appendTreeRows(tree, frag);
        // 草稿固定节点跟在工作区根之后（JetBrains 把 Scratches 放在项目节点下方同一层）
        const sn = ensureScratchNode();
        if (sn) appendTreeRows(sn, frag);
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
                node.children = filterTreeEntries(node, entries).map((entry) => ({
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
                const message = String((e && e.message) || e);
                // scratch 目录首次不存在是正常初始状态：当作空目录，不显示 GetFileAttributesEx 错误。
                // 新建草稿后 refreshScratch 会重读出真实文件。
                if (node.scratch && isMissingDirError(message)) {
                    node.children = [];
                    node.error = '';
                    node.loaded = true;
                    node.expanded = false;
                } else {
                    node.error = message;
                    node.loaded = true;
                }
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
        if (row) revealRowVertically(body, row);
    }

    function selectPaths(items) {
        setSelection(items, items && items.length ? items[items.length - 1].path : null);
        const row = body.querySelector('.sb-row.anchor') || body.querySelector('.sb-row.selected');
        if (row) revealRowVertically(body, row);
    }

    async function revealActive() {
        if (!tree || !activePath) return;
        const seq = ++revealSeq;
        // 草稿落在 .cadt/scratch（树里已隐藏 .cadt）：展开固定节点即可，不必走子树逐层展开
        const sn = ensureScratchNode();
        if (sn && isWithin(sn.path, activePath)) {
            sn.expanded = true;
            await loadNode(sn, treeSeq);
            if (seq !== revealSeq) return;
            renderTree(true);
            return;
        }
        if (!isWithin(tree.path, activePath)) return;
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

    // 展开到指定路径并选中（app_control reveal_in_explorer）：与跟随活动文件同一条展开链，
    // 目标可以是文件或目录；不在根内返回 false（调用方给错误）。
    // 沿途逐层**强制重读**（而不是整树重建）：新建的文件/目录也要能被找到，
    // 同时其它已展开目录与滚动位置保持不变。
    async function revealPath(targetPath) {
        const target = String(targetPath || '');
        if (!target) return false;
        ensureTree();
        // 草稿路径：.cadt 已从树里隐藏，改由「临时草稿」固定节点承载
        const sn = ensureScratchNode();
        if (sn && isWithin(sn.path, target)) {
            const seq = ++revealSeq;
            sn.expanded = true;
            if (!sn.loaded) await loadNode(sn, treeSeq);
            else await refreshNodeChildren(sn, true);
            if (seq !== revealSeq) return false;
            renderTree(true);
            selectPath(target, false);
            return true;
        }
        if (!tree || !isWithin(tree.path, target)) return false;
        const seq = ++revealSeq;
        let node = tree;
        node.expanded = true;
        while (node && node.isDir) {
            if (!node.loaded) await loadNode(node, treeSeq);
            else if (node.loadPromise) await node.loadPromise;
            else await refreshNodeChildren(node, true);
            if (seq !== revealSeq) return false;
            if (samePath(node.path, target) || samePath(node.path, parentPath(target))) break;
            const next = node.children.find((child) => child.isDir && isWithin(child.path, target));
            if (!next) break;
            next.expanded = true;
            node = next;
        }
        if (seq !== revealSeq) return false;
        renderTree(true);
        selectPath(target, false);
        return true;
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
            requestListReveal();
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
            requestListReveal();
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

    function setActive(path, opts = {}) {
        activePath = path || null;
        if (!visible) return;
        // reveal 默认 true：显式要求「把当前文件摆到眼前」的调用（显示侧栏 / 切工作区）才滚动；
        // 切换标签页传 false —— 对齐 JetBrains，切标签不动文件树的展开态与滚动位置。
        const reveal = opts.reveal !== false;
        if (mode === 'list') {
            if (reveal) requestListReveal();
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
                if (reveal) revealActive();
            } else {
                updateActiveHighlight();
                if (reveal) revealActive();
            }
            updateTitle();
        }
    }

    // 宿主入口（侧栏「定位当前文件」按钮 / AI reveal_in_explorer）：展开到活动文件并滚进视野
    function revealActiveFile() {
        if (!activePath) return false;
        if (mode === 'list') {
            requestListReveal();
            loadList(false);
            return true;
        }
        ensureTree();
        if (!tree) return false;
        revealActive();
        return true;
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
            // 用户显式刷新：草稿固定节点也重读一遍（它不在 tree 子树里，不会随之重建）
            if (scratchNode) {
                if (scratchNode.expanded) refreshScratch({expand: true});
                else scratchNode.loaded = false;
            }
            revealActive();
        }
        scheduleAutoRefresh();
    }

    function isNodeAttached(node) {
        if (!tree || !node) return false;
        // 草稿固定节点不在 tree 子树里，但它自身就是当前挂载的那个对象
        if (scratchNode && node === scratchNode) return true;
        if (samePath(tree.path, node.path)) return tree === node;
        return findLoadedNode(tree, node.path) === node;
    }

    function collectExpanded(node, out) {
        if (!node || !node.isDir) return;
        if (node.expanded && node.loaded) out.push(node);
        for (const child of node.children || []) collectExpanded(child, out);
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
            return mergeChildren(node, filterTreeEntries(node, (result && result.entries) || []), !!(result && result.truncated), result && result.mtime);
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

    // 保留展开态的重建：只有外部大批量变更（文件监听溢出）才需要整树重读，
    // 但不能让用户刚展开的目录全部折叠——重建后按记录的路径逐层展开回去。
    // 注意：刷新按钮 / 切工作区仍走各自的路径（前者是用户显式要求重建，后者根变了）。
    async function rebuildTreeKeepingExpansion() {
        const expanded = new Set();
        if (tree) collectExpanded(tree, []).forEach((node) => expanded.add(normalizePath(node.path)));
        tree = null;
        treeSeq++;
        revealSeq++;
        ensureTree();
        if (!tree) return;
        const seq = treeSeq;
        const restore = async (node) => {
            if (!node || !node.isDir) return;
            if (node !== tree) node.expanded = expanded.has(normalizePath(node.path));
            if (!node.expanded) return;
            if (!node.loaded) await loadNode(node, seq);
            if (seq !== treeSeq) return;
            for (const child of node.children || []) await restore(child);
        };
        await restore(tree);
        if (visible && mode === 'tree') renderTree();
    }

    async function refreshTreeSilently() {
        if (!tree) return;
        const targets = [];
        collectExpanded(tree, targets);
        // 草稿固定节点不在 tree 子树里，展开时也要跟着定时刷新（草稿可能被 AI / 外部编辑器改）
        if (scratchNode && scratchNode.expanded) targets.push(scratchNode);
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
            // 差量刷新：内容没变就不重渲染，避免列表闪烁与滚动位置丢失
            if (hasChanges && mode === 'list' && visible && getListState().root) await refreshListSilently();
            return;
        }
        if (externalOverflow) {
            externalOverflow = false;
            externalDirs.clear();
            await rebuildTreeKeepingExpansion();
            return;
        }
        const nodes = [];
        for (const dir of externalDirs) {
            const node = findLoadedNode(tree, dir);
            if (node && node.isDir) nodes.push(node);
            else if (scratchNode && samePath(scratchNode.path, dir)) nodes.push(scratchNode);
        }
        const listRoot = mode === 'list' ? listRootPath() : null;
        // 只关心扫描范围内（含嵌套）的变化；父目录的事件不再触发整个列表重载
        const listHit = !!listRoot && [...externalDirs].some((dir) => isWithin(listRoot, dir));
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
            await refreshListSilently();
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
            // 跳过扫描黑名单目录（.git / node_modules 等）里的事件，避免无关写入引发整表刷新
            if (String(full).toLowerCase().split('/').some((seg) => LIST_SKIP_DIRS.has(seg))) continue;
            externalDirs.add(parentPath(full));
        }
        if (externalDirs.size) scheduleExternalRefresh();
    }

    // 应用自身写盘（AI write_file / edit_file、补丁应用）后的轻量通知。
    // 与后端文件监听共用 externalDirs 与 120ms 防抖：只把该文件所在目录标脏，
    // 由 flushExternalChanges 做局部差量刷新。纯内容修改经 mergeChildren 判定为
    // 「结构未变」→ 完全不 renderTree；新建/删除才重绘一次，且保留展开态与滚动位置。
    // 切记不要在这里调全量刷新：那是「点击刷新按钮」的重建（整树清空 → 加载中
    // → 逐级重载 → 抢滚动），连续编辑时看起来就是整棵文件树一直在闪。
    function notifyFileChange(path) {
        const full = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
        if (!full) return;
        externalDirs.add(parentPath(full));
        scheduleExternalRefresh();
    }

    // 同上，但直接标脏目录本身（复制 / 移动等「作用在某个目录里」的写盘操作用它，
    // 免得去构造一个假的子路径）
    function notifyDirChange(dir) {
        const full = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
        if (!full) return;
        externalDirs.add(full);
        scheduleExternalRefresh();
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

    // 切换 .cadt 显隐：列表跳过表同步（文件系统通知也读这张表）。
    // 重读由调用方（settings-ui）统一触发，这里只切状态，避免一次开关两次重绘。
    function setShowCadDir(next) {
        const value = next !== false;
        if (value === showCadDir) return;
        showCadDir = value;
        if (showCadDir) LIST_SKIP_DIRS.delete('.cadt');
        else LIST_SKIP_DIRS.add('.cadt');
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
            invalidateList();
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
    if (revealBtn) {
        revealBtn.innerHTML = ICONS.reveal;
        revealBtn.dataset.tip = '定位当前文件';
        revealBtn.setAttribute('aria-label', '定位当前文件');
        revealBtn.addEventListener('click', () => revealActiveFile());
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

    // 草稿文件树节点变更后调用（新建草稿 / 空白草稿被自动删掉）：展开时重读目录，收起时只重绘。
    // .cadt 不在文件系统通知范围内（忽略表里就有它），所以这条刷新由调用方显式触发。
    // opts.expand = 新建后展开该节点（否则新文件只在收起态里，用户看不到任何变化）。
    async function refreshScratch(opts = {}) {
        const sn = ensureScratchNode();
        if (!sn) {
            if (visible) renderTree();
            return false;
        }
        if (opts.expand) sn.expanded = true;
        // 新建草稿后必须重读：清掉可能残留的加载态 / 错误（目录此前不存在时 loadNode 失败留下的），
        // 否则 refreshNodeChildren 的 guard 会被 node.loading / node.loadPromise 挡住，新文件不显示。
        sn.loaded = false;
        sn.error = '';
        sn.loading = false;
        sn.loadPromise = null;
        sn.refreshing = false;
        if (sn.expanded) await loadNode(sn, treeSeq);
        else sn.loaded = false;
        if (visible && mode === 'tree') renderTree();
        return true;
    }

    return {
        setVisible,
        setMode,
        getMode: () => mode,
        setFilter,
        setRoot,
        getRoot: currentRoot,
        setActive,
        revealActiveFile,
        refresh,
        toggleNode,
        refreshDir,
        refreshScratch,
        pathRenamed,
        handleExternalChanges,
        notifyFileChange,
        notifyDirChange,
        removePath,
        getSelection: () => selection.map((item) => ({...item})),
        getAnchor: () => {
            const item = selection.find((entry) => samePath(entry.path, anchorPath));
            return item ? {...item} : (selection.length ? {...selection[selection.length - 1]} : null);
        },
        selectPath,
        selectPaths,
        revealPath,
        hasFocus: () => focused,
        setCutPaths,
        setCutPath,
        setAutoRefresh,
        setShowCadDir,
    };
}
