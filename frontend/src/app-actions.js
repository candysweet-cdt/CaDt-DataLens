// app-actions.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {fileIconSpec} from './fileicons.js';

export function createAppActions(deps) {

function exitApp() {
    if (deps.rt && deps.rt.Quit) deps.rt.Quit();
    else if (deps.rt && deps.rt.WindowClose) deps.rt.WindowClose();
    else window.close();
}

function parentDirOf(path) {
    const s = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const i = s.lastIndexOf('/');
    return i > 0 ? s.slice(0, i) : '';
}

const recentOpenKey = 'datalens-recent';
const recentOpenLimit = 12;

function readRecentOpen() {
    try {
        const raw = JSON.parse(localStorage.getItem(recentOpenKey) || '[]');
        return Array.isArray(raw) ? raw.filter((it) => it && it.path) : [];
    } catch (e) {
        return [];
    }
}

function rememberRecentOpen(path, name, isDir) {
    if (!path) return;
    const key = String(path).replace(/\\/g, '/').toLowerCase();
    const list = readRecentOpen().filter((it) => String(it.path || '').replace(/\\/g, '/').toLowerCase() !== key);
    list.unshift({path, name: name || deps.baseNameOf(path), isDir: !!isDir});
    try {
        localStorage.setItem(recentOpenKey, JSON.stringify(list.slice(0, recentOpenLimit)));
    } catch (e) {}
}

function clearRecentOpen() {
    try {
        localStorage.removeItem(recentOpenKey);
    } catch (e) {}
    deps.flash('已清除最近打开记录');
}

function recentOpenMenuItems() {
    const list = readRecentOpen();
    if (!list.length) return [{label: '（无最近记录）', disabled: true}];
    const items = list.map((entry) => {
        const spec = entry.isDir ? null : fileIconSpec(entry.name || entry.path);
        return {
            label: entry.name || deps.baseNameOf(entry.path),
            icon: entry.isDir ? 'E8B7' : undefined,
            iconHtml: spec ? spec.svg : undefined,
            iconClass: spec ? spec.className : undefined,
            action: () => (entry.isDir ? deps.openFolderSmart(entry.path) : deps.openPath(entry.path)),
        };
    });
    items.push({sep: true}, {label: '清除最近记录', action: clearRecentOpen});
    return items;
}

// ---- 外部文件拖到文件树目录行：复制进该目录 ----
// Wails 的 file-drop 事件比 drop 事件晚（要等 Go 原生解析路径），用 pending 标记衔接。
let pendingExternalDrop = null;

function setPendingExternalDrop(destDir) {
    pendingExternalDrop = {destDir, at: Date.now()};
}

async function copyExternalIntoDir(paths, destDir) {
    if (!deps.backend.CopyEntry) {
        deps.flash('当前版本不支持复制到目录', true);
        return;
    }
    let ok = 0;
    let failed = 0;
    for (const p of paths || []) {
        const name = deps.baseNameOf(p);
        if (!name) { failed++; continue; }
        let newName = name;
        try {
            newName = (await deps.backend.SuggestCopyName(destDir, name, false)) || name;
        } catch (e) {}
        try {
            await deps.backend.CopyEntry(p, destDir, newName);
            ok++;
        } catch (e) {
            failed++;
        }
    }
    if (deps.explorer && deps.explorer.refresh) deps.explorer.refresh();
    if (ok) deps.flash('已复制 ' + ok + ' 项到 ' + (deps.baseNameOf(destDir) || destDir));
    if (failed) deps.flash(failed + ' 项复制失败', true);
}


    return {copyExternalIntoDir, exitApp, parentDirOf, readRecentOpen, recentOpenMenuItems, rememberRecentOpen, setPendingExternalDrop};
}
