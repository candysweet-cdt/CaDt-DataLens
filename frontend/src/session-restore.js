// session-restore.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。


export function createSessionRestore(deps) {


// ---- 会话恢复：标签页/分组/分屏布局持久化，重启后还原 ----
const sessionKey = 'cadt.session.v1';
// 按工作区保存环境：软切换（新窗口打开另一工作区）时恢复该工作区上次的标签/布局。
const workspaceSessionsKey = 'cadt.workspace-sessions.v1';
const WORKSPACE_SESSION_LIMIT = 30;
let sessionTimer = 0;
// 每个文件的光标/滚动/折叠/书签：随会话保存，未激活的文档沿用上次读到的视图
let knownDocViews = new Map();
let pendingDocViews = new Map();

function sessionPathKey(path) {
    return String(path || '').replace(/\\/g, '/').replace(/[\\/]+$/, '').toLowerCase();
}

function readWorkspaceSessions() {
    try {
        const data = JSON.parse(localStorage.getItem(workspaceSessionsKey) || '{}');
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (e) {
        return {};
    }
}

function readWorkspaceSession(dir) {
    const key = sessionPathKey(dir);
    if (!key) return null;
    const map = readWorkspaceSessions();
    const sess = map[key];
    return sess && typeof sess === 'object' ? sess : null;
}

function writeWorkspaceSession(sess) {
    const key = sessionPathKey(sess && sess.workspace);
    if (!key) return;
    // 只保存属于该工作区的文件环境，避免工作区切换后把另一工作区的标签带进本工作区。
    const inside = (path) => {
        const fileKey = sessionPathKey(path);
        return !!fileKey && (fileKey === key || fileKey.startsWith(key + '/'));
    };
    const groups = [];
    let filtered = false;
    for (const group of (sess.groups || [])) {
        const source = group && Array.isArray(group.paths) ? group.paths : [];
        const paths = source.filter(inside);
        if (!paths.length) {
            filtered = true;
            continue;
        }
        if (paths.length !== source.length) filtered = true;
        groups.push({
            paths,
            active: paths.includes(group.active) ? group.active : paths[0],
        });
    }
    const modes = {};
    for (const [path, mode] of Object.entries(sess.modes || {})) {
        if (inside(path)) modes[path] = mode;
    }
    const views = {};
    for (const [path, view] of Object.entries(sess.views || {})) {
        if (inside(path)) views[path] = view;
    }
    const map = readWorkspaceSessions();
    map[key] = {
        workspace: sess.workspace,
        groups,
        current: sess.current && inside(sess.current) ? sess.current : '',
        split: filtered ? null : (sess.split || null),
        modes,
        views,
        savedAt: Date.now(),
    };
    const keys = Object.keys(map);
    if (keys.length > WORKSPACE_SESSION_LIMIT) {
        keys.sort((a, b) => (Number(map[a] && map[a].savedAt) || 0) - (Number(map[b] && map[b].savedAt) || 0));
        for (const k of keys.slice(0, keys.length - WORKSPACE_SESSION_LIMIT)) delete map[k];
    }
    localStorage.setItem(workspaceSessionsKey, JSON.stringify(map));
}

function serializeSplitSession(node, gidToIdx) {
    if (typeof node === 'string') {
        return gidToIdx.has(node) ? gidToIdx.get(node) : null;
    }
    const a = serializeSplitSession(node.a, gidToIdx);
    const b = serializeSplitSession(node.b, gidToIdx);
    if (a == null) return b;
    if (b == null) return a;
    return {dir: node.dir, ratio: node.ratio, a, b};
}

function serializeSession() {
    // 工作区可以单独持久化：只打开文件夹、没有打开文件时也应在重启后恢复。
    if (!deps.docs.length && !deps.workspaceFolder) return null;
    const groups = [];
    const gidToIdx = new Map();
    for (const g of deps.editorGroups) {
        const entries = deps.groupDocs(g).filter((d) => d.path);
        if (!entries.length) continue;
        gidToIdx.set(g.id, groups.length);
        groups.push({
            paths: entries.map((d) => d.path),
            active: (deps.docs.find((d) => d.id === g.activeId && d.path) || entries[0]).path,
        });
    }
    if (!groups.length && !deps.workspaceFolder) return null;
    const modes = {};
    for (const d of deps.docs) {
        if (d.path && d.mode) modes[d.path] = d.mode === 'sql' ? (d.sqlPrevMode || 'text') : d.mode;
    }
    const views = {};
    const liveKeys = new Set();
    for (const d of deps.docs) {
        if (!d.path) continue;
        deps.rememberDocView(d);
        const key = sessionPathKey(d.path);
        liveKeys.add(key);
        const view = knownDocViews.get(key);
        if (view) views[key] = view;
    }
    for (const key of [...knownDocViews.keys()]) {
        if (!liveKeys.has(key)) knownDocViews.delete(key);
    }
    return {
        workspace: deps.workspaceFolder || '',
        groups,
        current: deps.file && deps.file.path ? deps.file.path : '',
        split: deps.splitRoot ? serializeSplitSession(deps.splitRoot, gidToIdx) : null,
        modes,
        views,
    };
}

function auxWindowNoSession() {
    return !!(window.__aiFloatWindow || window.__consoleWindowMode);
}

function scheduleSessionSave(options) {
    if (auxWindowNoSession()) return;
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => saveSessionNow(options), 500);
}

function saveSessionNow(options) {
    if (auxWindowNoSession()) return false;
    sessionTimer = 0;
    try {
        const sess = serializeSession();
        if (sess) {
            const tabs = countSessionTabs(sess);
            if (!tabs && !(options && options.allowEmpty)) {
                const prev = readSession();
                if (countSessionTabs(prev) > 0 &&
                    sessionPathKey(prev && prev.workspace) === sessionPathKey(sess.workspace)) {
                    // 启动恢复、工作区预热等过程性保存不能把上一次的标签页抹成空快照
                    deps.logFrontend('info', '会话保存跳过：空快照未覆盖 ' + countSessionTabs(prev) + ' 个标签页');
                    return false;
                }
            }
            localStorage.setItem(sessionKey, JSON.stringify(sess));
            writeWorkspaceSession(sess);
        } else {
            localStorage.removeItem(sessionKey);
        }
        return true;
    } catch (e) { return false; }
}

function countSessionTabs(sess) {
    let n = 0;
    for (const group of (sess && Array.isArray(sess.groups) ? sess.groups : [])) {
        n += group && Array.isArray(group.paths) ? group.paths.length : 0;
    }
    return n;
}

// 关闭窗口时兜底保存一次，避免刚打开文件夹就退出时丢失（防抖还没触发）。
// AI 悬浮窗与调试控制台共享同一 localStorage，不能让它们覆盖主窗口的会话。
window.addEventListener('pagehide', () => {
    if (auxWindowNoSession()) return;
    // 操作留痕：退出前记一条并冲刷攒批（尽力而为，异步写入不保证完成）。
    deps.activityLog.log('app.exit', '', {}, {actor: 'system', source: 'system'});
    deps.activityLog.flush();
    if (!deps.docs.length && !deps.workspaceFolder) return;
    saveSessionNow();
});

function readSession() {
    try {
        const sess = JSON.parse(localStorage.getItem(sessionKey) || 'null');
        if (sess && (sess.workspace || (Array.isArray(sess.groups) && sess.groups.length))) return sess;
    } catch (e) {}
    return null;
}

function deserializeSplitSession(node, idxToGid) {
    if (typeof node === 'number') {
        return idxToGid.has(node) ? idxToGid.get(node) : null;
    }
    if (!node || typeof node !== 'object') return null;
    const a = deserializeSplitSession(node.a, idxToGid);
    const b = deserializeSplitSession(node.b, idxToGid);
    if (a == null || b == null) return null;
    return {dir: node.dir === 'h' ? 'h' : 'v', ratio: Math.min(0.8, Math.max(0.2, Number(node.ratio) || 0.5)), a, b};
}

async function restoreSession(sess) {
    if (auxWindowNoSession()) return false;
    try {
        if (sess.workspace && !deps.workspaceFolder) deps.openFolderWorkspace(sess.workspace);
        knownDocViews = new Map();
        pendingDocViews = new Map();
        for (const [path, view] of Object.entries(sess.views || {})) {
            if (!path || !view || typeof view !== 'object') continue;
            const key = sessionPathKey(path);
            knownDocViews.set(key, view);
            pendingDocViews.set(key, view);
        }
        const idxToGid = new Map();
        for (const gspec of (sess.groups || [])) {
            const g = deps.createGroup();
            deps.focusedGroupId = g.id;
            idxToGid.set(idxToGid.size, g.id);
            await deps.openPathsHere(gspec.paths || []);
            const activeDoc = deps.findDocByPath(gspec.active);
            if (activeDoc && deps.groupOfDoc(activeDoc.id) === g && g.activeId !== activeDoc.id) {
                await deps.activateDoc(activeDoc);
            }
        }
        if (sess.split && typeof sess.split === 'object') {
            deps.splitRoot = deserializeSplitSession(sess.split, idxToGid);
        }
        const current = sess.current ? deps.findDocByPath(sess.current) : null;
        if (current) {
            await deps.activateDoc(current);
            const mode = sess.modes && sess.modes[current.path];
            if (mode && mode !== deps.currentMode) deps.switchMode(mode);
        } else if (deps.editorGroups.length) {
            const first = deps.groupDocs(deps.editorGroups[0])[0];
            if (first) await deps.activateDoc(first);
        }
        deps.renderEditorLayout();
        const want = countSessionTabs(sess);
        deps.logFrontend('info', '会话恢复：保存 ' + want + ' 个标签页，实际打开 ' + deps.docs.length + ' 个文件');
        deps.flash('已恢复上次会话');
    } catch (e) {
        deps.logFrontend('warn', '会话恢复失败：' + (e && e.message || e));
    }
}


    return {knownDocViews, pendingDocViews, readSession, readWorkspaceSession, restoreSession, saveSessionNow, scheduleSessionSave, sessionPathKey};
}
