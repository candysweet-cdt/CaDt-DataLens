// explorer-list.js：资源管理器扁平列表视图引擎（BFS 扫描 + 渲染 + 静默刷新）。
// 从 explorer.js 拆出（frontend-split-phase3 X1，同域兄弟模块）：树/列表共享的选择状态、
// 渲染辅助与 options 经 deps 注入，let 状态一律 getter/setter 活引用。函数体逐字搬移
// （仅跨模块状态读写改走 deps 访问器，禁止反向 import 宿主）。
import {createFileIcon} from '../core/fileicons.js';
import {INTERNAL_PATHS_MIME, encodeDropPaths} from '../core/drop-mime.js';

export function createExplorerList(deps) {
    // options 直通
    const body = deps.body;
    const readDir = deps.readDir;
    const dirMtime = deps.dirMtime;
    const openPath = deps.openPath;
    const openFileDialog = deps.openFileDialog;
    const onContextMenu = deps.onContextMenu;
    const readLimit = deps.readLimit;
    const listReadLimit = deps.listReadLimit;
    // 模块级工具与宿主辅助
    const samePath = deps.samePath;
    const compareEntries = deps.compareEntries;
    const el = deps.el;
    const canList = deps.canList;
    const skipDirs = deps.skipDirs; // LIST_SKIP_DIRS：宿主持有（与文件系统通知共用一份忽略表）
    const emptyState = deps.emptyState;
    const statusRow = deps.statusRow;
    const updateTitle = deps.updateTitle;
    const updateSelectionBoundaries = deps.updateSelectionBoundaries;
    const scrollToActive = deps.scrollToActive;
    const selectionHas = deps.selectionHas;
    const selectRangeTo = deps.selectRangeTo;
    const toggleSelection = deps.toggleSelection;
    const selectOnly = deps.selectOnly;
    const selectForContext = deps.selectForContext;
    const listRootPath = deps.listRootPath;
    const parentDirOf = deps.parentDirOf;
    const getSelectionPaths = deps.getSelectionPaths;
    const canDrag = deps.canDrag;
    // 共享 let 状态：getter/setter 活引用
    const getMode = deps.getMode;
    const getVisible = deps.getVisible;
    const getActivePath = deps.getActivePath;
    const getFocused = deps.getFocused;
    const getFilterText = deps.getFilterText;
    const getCutPaths = deps.getCutPaths;
    const getSelection = deps.getSelection;
    const setSelection = deps.setSelection;
    const getAnchorPath = deps.getAnchorPath;
    const setAnchorPath = deps.setAnchorPath;

    // 文件列表（扁平视图）扫描上限：递归扫描时防止大仓库拖垮界面
    const LIST_RENDER_CAP = 2000;   // DOM 最多渲染的行数，超出用过滤缩小范围
    const LIST_DIR_LIMIT = 400;     // 最多遍历的目录数
    const LIST_DEPTH_LIMIT = 12;    // 嵌套深度上限

    // 列表状态与「切换根/切换文件后滚到当前行」标记随域迁入
    let listState = {root: null, entries: [], tooMany: false, error: '', loading: false, loaded: false, token: 0, dirMtime: 0};
    let listRevealPending = false;

    // 递归扫描 root 下所有受支持文件（BFS，带目录数/深度/条目数硬上限）。
    // 根目录读取失败视为整体失败（抛出），子目录失败跳过（无权限等）。
    async function scanListEntries(root, token) {
        const files = [];
        let truncated = false;
        let visited = 0;
        let rootMtime = 0;
        const queue = [{path: root, depth: 0}];
        while (queue.length) {
            if (token !== listState.token) return null;
            if (visited >= LIST_DIR_LIMIT || files.length >= listReadLimit) {
                truncated = true;
                break;
            }
            const {path: dir, depth} = queue.shift();
            visited++;
            let result;
            try {
                result = await readDir(dir, readLimit);
            } catch (e) {
                if (samePath(dir, root)) throw e;
                continue;
            }
            if (token !== listState.token) return null;
            if (samePath(dir, root)) rootMtime = (result && result.mtime) || 0;
            if (result && result.truncated) truncated = true;
            for (const entry of (result && result.entries) || []) {
                if (entry.isDir) {
                    if (depth + 1 >= LIST_DEPTH_LIMIT) {
                        truncated = true;
                        continue;
                    }
                    if (skipDirs.has(String(entry.name || '').toLowerCase())) continue;
                    queue.push({path: entry.path, depth: depth + 1});
                } else if (canList(entry.name)) {
                    files.push(entry);
                    if (files.length >= listReadLimit) {
                        truncated = true;
                        break;
                    }
                }
            }
        }
        files.sort(compareEntries);
        return {files, truncated, mtime: rootMtime};
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
            const scan = await scanListEntries(root, token);
            if (!scan || token !== listState.token) return;
            listState.entries = scan.files;
            listState.tooMany = scan.truncated;
            listState.dirMtime = scan.mtime;
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
        const row = el('div', 'sb-row sb-list-row' + (samePath(entry.path, getActivePath()) ? ' current' : '') +
            (selectionHas(entry.path) ? ' selected' : '') +
            (samePath(entry.path, getAnchorPath()) ? ' anchor' : '') +
            (getCutPaths().some((path) => samePath(entry.path, path)) ? ' cut' : ''));
        row.dataset.path = entry.path;
        // 外部拖放：列表行恒为文件，落点目录取父目录（与文件树文件行同一条规则）
        row.dataset.fileDropTarget = 'files';
        row.dataset.dropDir = parentDirOf(entry.path);
        row.tabIndex = -1;
        // 应用内拖拽：列表行也可作为拖拽源（拖到编辑区/AI 面板），与树行同一条自定义 MIME 链路
        row.draggable = !!(typeof canDrag === 'function' ? canDrag() : true);
        row.addEventListener('dragstart', (e) => {
            if (row.draggable === false || (typeof canDrag === 'function' && !canDrag())) {
                e.preventDefault();
                return;
            }
            // 当前行没被选中时不拖走别处选中的项（与树视图 dragstart 的 selectOnly 语义一致）
            const selected = (typeof getSelectionPaths === 'function' ? getSelectionPaths() : []) || [];
            const list = selected.includes(entry.path) ? selected : [entry.path];
            try {
                e.dataTransfer.effectAllowed = 'copyMove';
                e.dataTransfer.setData('text/plain', list.join('\n'));
                e.dataTransfer.setData(INTERNAL_PATHS_MIME, encodeDropPaths(list));
            } catch (err) {}
        });
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
        if (!getVisible() || getMode() !== 'list') return;
        const prevTop = body.scrollTop;
        body.textContent = '';
        if (!listState.root) {
            body.appendChild(emptyState('未打开文件', '打开文件…', () => {
                if (typeof openFileDialog === 'function') openFileDialog();
            }));
        } else if (listState.loading) {
            body.appendChild(emptyState('正在读取目录…'));
        } else if (listState.error) {
            body.appendChild(emptyState('无法读取目录：' + listState.error));
        } else if (!listState.entries.length) {
            body.appendChild(emptyState('此目录没有可用的数据文件'));
        } else {
            const entries = getFilterText()
                ? listState.entries.filter((entry) => String(entry.name || '').toLowerCase().includes(getFilterText()))
                : listState.entries;
            const cap = Math.min(entries.length, LIST_RENDER_CAP);
            const frag = document.createDocumentFragment();
            for (let i = 0; i < cap; i++) frag.appendChild(listRow(entries[i]));
            if (!cap) body.appendChild(emptyState('没有匹配的文件'));
            body.appendChild(frag);
            // 截断提示放在尾部，不弹错误态：列表按扫描上限递归，超限靠过滤缩小范围
            if (cap < entries.length) {
                body.appendChild(statusRow('仅显示前 ' + cap + ' / ' + entries.length + ' 项，可用上方过滤缩小范围'));
            } else if (listState.tooMany) {
                body.appendChild(statusRow('已扫描 ' + entries.length + ' 个文件（超出扫描上限，结果可能不完整）'));
            }
            body.scrollTop = prevTop;
            updateSelectionBoundaries();
            if (getFocused()) {
                const row = body.querySelector('.sb-row.anchor') || body.querySelector('.sb-row.selected');
                if (row) row.focus({preventScroll: true});
            }
        }
        // 只有切换根/切换文件等主动动作才把当前文件滚进视野；静默刷新一律保持滚动位置
        if (listRevealPending) {
            listRevealPending = false;
            scrollToActive();
        }
        updateTitle();
    }

    async function refreshListSilently() {
        if (!getVisible() || getMode() !== 'list' || listState.loading) return;
        const root = listRootPath();
        if (!root) return;
        if (listState.dirMtime && typeof dirMtime === 'function') {
            try {
                const current = await dirMtime(root);
                if (current && Number(current) === listState.dirMtime) return;
            } catch (e) {}
            if (getMode() !== 'list' || !samePath(root, listRootPath()) || listState.loading) return;
        }
        const token = listState.token;
        let scan;
        try {
            scan = await scanListEntries(root, token);
        } catch (e) {
            if (token !== listState.token || getMode() !== 'list' || !samePath(root, listRootPath()) || listState.loading) return;
            const message = String((e && e.message) || e);
            if (listState.error !== message) {
                listState.error = message;
                listState.loaded = true;
                if (getVisible()) renderList();
            }
            return;
        }
        if (!scan || token !== listState.token || getMode() !== 'list' || !samePath(root, listRootPath()) || listState.loading) return;
        const files = scan.files;
        const tooMany = scan.truncated;
        const previous = listState.entries;
        let changed = !!listState.error || tooMany !== listState.tooMany ||
            files.length !== previous.length ||
            files.some((entry, index) => entry.path !== previous[index].path);
        listState.root = root;
        listState.entries = files;
        listState.tooMany = tooMany;
        listState.dirMtime = scan.mtime;
        listState.error = '';
        listState.loaded = true;
        if (changed) {
            if (!tooMany && getSelection().length) {
                const kept = getSelection().filter((item) => files.some((entry) => samePath(entry.path, item.path)));
                setSelection(kept);
                if (!kept.some((item) => samePath(item.path, getAnchorPath()))) {
                    setAnchorPath(kept.length ? kept[kept.length - 1].path : null);
                }
            }
            if (getVisible()) renderList();
        }
    }

    // 宿主入口：切换模式 / 可见性 / 激活文件后要求把当前文件滚进视野（原 listRevealPending 写位）
    function requestListReveal() {
        listRevealPending = true;
    }

    // 重命名后列表缓存整体失效并强制重扫（pathRenamed 的列表分支）
    function invalidateList() {
        listState.loaded = false;
        if (getVisible()) loadList(true);
    }

    return {
        loadList, renderList, refreshListSilently,
        requestListReveal, invalidateList,
        getListState: () => listState,
    };
}
