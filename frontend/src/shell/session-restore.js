// session-restore.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {defaultMediaMode} from '../core/formats.js';
import {kvGetJson, kvRemove, kvSetJson} from '../core/kv-store.js';
import {isMultiWorkspace} from '../core/root-scope.js';
import {WORKSPACE_SESSIONS_KEY, windowSessionKeyOf} from '../core/storage-keys.js';


export function createSessionRestore(deps) {


// ---- 会话恢复：标签页/分组/分屏布局持久化，重启后还原 ----
// 快照槽的选择规则在 core/storage-keys.js 的 windowSessionKeyOf：普通窗口用共享单槽，
// harness 窗口用自己的槽（空工作区的布局写进共享槽会污染普通窗口的下次启动——读取侧
// 对空 workspace 不做归属校验）。
// 按工作区保存环境：软切换（新窗口打开另一工作区）时恢复该工作区上次的标签/布局。
const workspaceSessionsKey = WORKSPACE_SESSIONS_KEY;
const WORKSPACE_SESSION_LIMIT = 30;
let sessionTimer = 0;
// allowEmpty 是「本次保存由用户主动关标签触发」的粘滞标志：一旦置上就保持到真正
// 写入那一刻，不能被随后 renderEditorLayout 的无参 scheduleSessionSave 覆盖掉。
// 否则关到空标签时空快照保护会误判为「过程性保存」而跳过，旧标签在 workspace
// 快照里残留，下次从该目录启动又被 openPathsHere 恢复出来。
let allowEmptyPending = false;
// 每个文件的光标/滚动/折叠/书签：随会话保存，未激活的文档沿用上次读到的视图
let knownDocViews = new Map();
let pendingDocViews = new Map();

function sessionPathKey(path) {
    return String(path || '').replace(/\\/g, '/').replace(/[\\/]+$/, '').toLowerCase();
}

function readWorkspaceSessions() {
    const data = kvGetJson(workspaceSessionsKey, {});
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
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
    // 写不进（配额满 / 存储不可用）要留痕：否则「重启后布局没恢复」查不到任何线索
    if (!kvSetJson(workspaceSessionsKey, map)) {
        deps.logFrontend('warn', '工作区会话索引写入失败：localStorage 不可用或配额已满');
    }
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
        if (!d.path || !d.mode) continue;
        // 媒体文档只记它自己的媒体视图：binary / text 是手动备份（也可能是播放失败自动
        // 回退留下的），跨启动不能变成「默认视图」。
        modes[d.path] = defaultMediaMode(d) || (d.mode === 'sql' ? (d.sqlPrevMode || 'text') : d.mode);
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
    // 悬浮窗 / 调试控制台与主窗口共享同一 localStorage，读会串台、写会覆盖，整块关掉。
    // harness 窗口**不在这里**：它改用自己的独立槽位（见 sessionKeyOf），写入必须保留——
    // 那是它下次启动还能恢复自己标签的唯一来源。
    return !!(window.__aiFloatWindow || window.__consoleWindowMode);
}

// 本窗口的会话快照槽（harness 窗口用独立槽，其它窗口仍是共享单槽）。
function sessionKeyOf() {
    return windowSessionKeyOf(isMultiWorkspace());
}

function scheduleSessionSave(options) {
    if (auxWindowNoSession()) return;
    // 粘滞：本次调度链里只要有一次显式 allowEmpty（用户关标签），后续无参调度不清除。
    if (options && options.allowEmpty) allowEmptyPending = true;
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => saveSessionNow(), 500);
}

function saveSessionNow(options) {
    if (auxWindowNoSession()) return false;
    sessionTimer = 0;
    // 读后即清：粘滞标志只对这一轮实际写入生效。
    const allowEmpty = allowEmptyPending || !!(options && options.allowEmpty);
    allowEmptyPending = false;
    try {
        const sess = serializeSession();
        if (sess) {
            const tabs = countSessionTabs(sess);
            if (!tabs && !allowEmpty) {
                const prev = readSession();
                if (countSessionTabs(prev) > 0 &&
                    sessionPathKey(prev && prev.workspace) === sessionPathKey(sess.workspace)) {
                    // 启动恢复、工作区预热等过程性保存不能把上一次的标签页抹成空快照
                    deps.logFrontend('info', '会话保存跳过：空快照未覆盖 ' + countSessionTabs(prev) + ' 个标签页');
                    return false;
                }
            }
            // 写不进（序列化失败 / 配额满）不能静默：旧快照会原地残留成「关掉的标签又回来」
            if (!kvSetJson(sessionKeyOf(), sess)) {
                deps.logFrontend('warn', '会话保存失败：快照未能写入 localStorage（序列化失败或配额已满）');
            }
            writeWorkspaceSession(sess);
        } else {
            kvRemove(sessionKeyOf());
        }
        return true;
    } catch (e) {
        // 序列化依赖任何一项缺失（如 getter 未导出）都会走到这里；不能静默失败，
        // 否则旧快照原地残留，重启后「关掉的标签又回来」且没有任何线索。
        // 带上 stack（文件:行）——这类接线断裂靠 message 往往定位不到源头。
        deps.logFrontend('warn', '会话保存失败：' + ((e && (e.stack || e.message)) || e));
        return false;
    }
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
    const sess = kvGetJson(sessionKeyOf(), null);
    if (sess && (sess.workspace || (Array.isArray(sess.groups) && sess.groups.length))) return sess;
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
    // 快照必须属于本窗口的工作区：cadt.session.v1 是多窗口共享的 localStorage 里
    // 「最后保存的那个窗口」的环境，拿错快照就会把别的工作区的标签恢复进来，还会顺手把
    // 本窗口的工作区一起换掉（多窗口一目录一窗口下这是串台）。空 workspace 的快照
    // （欢迎页/无目录启动）不拦：它本来就要恢复出目录来。
    if (sess && sess.workspace && deps.workspaceFolder &&
        sessionPathKey(sess.workspace) !== sessionPathKey(deps.workspaceFolder)) {
        deps.logFrontend('warn', '会话恢复跳过：快照属于 ' + sess.workspace + '，本窗口工作区是 ' + deps.workspaceFolder);
        return false;
    }
    try {
        if (sess.workspace && !deps.workspaceFolder) {
            // 同一工作区禁止双开（v3 会话/监听/租约按单打开设计）：已被其他窗口
            // 打开的工作区不再恢复，等用户回到那个窗口（2026-11-21 用户裁定）。
            if (deps.backend && deps.backend.IsWorkspaceOpen) {
                Promise.resolve(deps.backend.IsWorkspaceOpen(sess.workspace)).then((open) => {
                    if (open) {
                        if (typeof deps.flash === 'function') {
                            deps.flash('工作区 ' + sess.workspace + ' 已在另一个窗口打开，本窗口未重复恢复');
                        }
                        return;
                    }
                    deps.openFolderWorkspace(sess.workspace);
                }).catch(() => deps.openFolderWorkspace(sess.workspace));
            } else {
                deps.openFolderWorkspace(sess.workspace);
            }
        }
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
            deps.setFocusedGroupId(g.id);
            idxToGid.set(idxToGid.size, g.id);
            await deps.openPathsHere(gspec.paths || []);
            const activeDoc = deps.findDocByPath(gspec.active);
            if (activeDoc && deps.groupOfDoc(activeDoc.id) === g && g.activeId !== activeDoc.id) {
                await deps.activateDoc(activeDoc);
            }
        }
        if (sess.split && typeof sess.split === 'object') {
            deps.setSplitRoot(deserializeSplitSession(sess.split, idxToGid));
        }
        const current = sess.current ? deps.findDocByPath(sess.current) : null;
        if (current) {
            await deps.activateDoc(current);
            // 媒体文档首屏固定用自己的视图（图片 / 视频 / 音频播放），忽略旧会话里
            // 持久化的 binary / text——那是备份视图或自动回退的结果，不是默认视图。
            const mode = defaultMediaMode(current) || (sess.modes && sess.modes[current.path]);
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
        deps.logFrontend('warn', '会话恢复失败：' + ((e && (e.stack || e.message)) || e));
    }
}


    return {knownDocViews, pendingDocViews, readSession, readWorkspaceSession, restoreSession, saveSessionNow, scheduleSessionSave, sessionPathKey};
}
