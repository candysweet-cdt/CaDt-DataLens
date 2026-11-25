// app-actions.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {fileIconSpec} from '../core/fileicons.js';
import {kvGetJson, kvRemove, kvSetJson} from '../core/kv-store.js';

/**
 * 应用级动作域：退出、最近打开记录、外部文件复制进目录。
 * 最近打开记在 localStorage（上限 12 条，按小写化路径去重，最近的在最前）。
 * @param {object} deps 依赖（rt / backend / explorer / flash / baseNameOf / openPath / openFolderSmart）
 * @returns {object} 动作面（copyExternalIntoDir / parentDirOf 等）
 */
export function createAppActions(deps) {

function exitApp() {
    // 「退出」是显式退出（菜单）：走 QuitApp 绕开「最小化到托盘」——只有点 X 才是隐藏。
    if (deps.backend && deps.backend.QuitApp) {
        try {
            deps.backend.QuitApp();
            return;
        } catch (e) {}
    }
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
    const raw = kvGetJson(recentOpenKey, []);
    return Array.isArray(raw) ? raw.filter((it) => it && it.path) : [];
}

function rememberRecentOpen(path, name, isDir) {
    if (!path) return;
    const key = String(path).replace(/\\/g, '/').toLowerCase();
    const list = readRecentOpen().filter((it) => String(it.path || '').replace(/\\/g, '/').toLowerCase() !== key);
    list.unshift({path, name: name || deps.baseNameOf(path), isDir: !!isDir});
    kvSetJson(recentOpenKey, list.slice(0, recentOpenLimit));
}

function clearRecentOpen() {
    kvRemove(recentOpenKey);
    deps.flash('已清除最近打开记录');
}

// recentOpenMenuItems 生成右键/菜单用的最近打开项；空列表时给一条禁用的占位，
// 末尾固定追加分隔线与「清除最近记录」。
function recentOpenMenuItems() {
    const list = readRecentOpen();
    if (!list.length) return [{label: '（无最近记录）', disabled: true}];
    const items = list.map((entry) => {
        const spec = entry.isDir ? null : fileIconSpec(entry.name || entry.path);
        return {
            label: entry.name || deps.baseNameOf(entry.path),
            icon: entry.isDir ? 'folder' : undefined,
            // iconHtml-exception: 文件类型图标走 fileIconSpec 域（core/fileicons*.js），非通用注册表语义
            iconHtml: spec ? spec.svg : undefined,
            iconClass: spec ? spec.className : undefined,
            action: () => (entry.isDir ? deps.openFolderSmart(entry.path) : deps.openPath(entry.path)),
        };
    });
    items.push({sep: true}, {label: '清除最近记录', action: clearRecentOpen});
    return items;
}

// ---- 外部文件拖到文件树：复制进目标目录 ----
// 落点（哪个目录）由 Wails 的 data-file-drop-target / data-drop-dir 经 app-file-drop 事件带回，
// 路由在 shell/file-drop-router.js；这里只负责「复制并刷新目标目录」这一件事。
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
    // 复制进来的文件属于「自己写盘」：只重读目标目录 + 把该目录标脏走差量刷新，
    // 不做整树重建（那会丢展开态、还会闪一下）。
    if (deps.explorer) {
        if (ok && typeof deps.explorer.refreshDir === 'function') await deps.explorer.refreshDir(destDir);
        if (typeof deps.explorer.notifyDirChange === 'function') deps.explorer.notifyDirChange(destDir);
    }
    if (ok) deps.flash('已复制 ' + ok + ' 项到 ' + (deps.baseNameOf(destDir) || destDir));
    if (failed) deps.flash(failed + ' 项复制失败', true);
}

    return {copyExternalIntoDir, exitApp, parentDirOf, readRecentOpen, recentOpenMenuItems, rememberRecentOpen};
}
