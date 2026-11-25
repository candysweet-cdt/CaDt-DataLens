// file-drop-router.js：外部文件拖放的落点路由（纯逻辑，无 DOM 依赖，node 可直测）。
//
// Wails v3 的 drop 事件经 Go 往返后带回落点属性（见仓库根 window_drop.go）：
//   {filenames:[...], x, y, target:'files'|'editor'|'db'|'ai', attrs:{'data-drop-dir':'...'}}
// 本模块只做两件事：把载荷归一成「去哪 + 哪些文件 + 目标目录」，再分派给注入的域处理器。
//
// 纪律：
//   - 只信事件载荷里的属性，不回头查 DOM——drop 事件跨了一次 Go 往返，DOM 可能已经变了；
//   - 未标注（或标注成未知值）的区域一律 'none'，不做事也不提示（光标在 Wails 侧已显示禁止，
//     再弹提示只会让「拖错地方」变成噪音）；
//   - 域处理器抛错在这里收口成一条 flash，不把未处理拒绝丢给 window。

// DROP_ROUTES 与 index.html 里的 data-file-drop-target 取值一一对应。
export const DROP_ROUTES = Object.freeze({
    EDITOR: 'editor',
    FILES: 'files',
    DB: 'db',
    AI: 'ai',
});

const ROUTE_VALUES = Object.freeze(Object.values(DROP_ROUTES));

// normalizePaths 去空白、去重、保序（多文件拖放按用户拖入顺序处理）。
export function normalizeDropPaths(input) {
    if (!Array.isArray(input)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of input) {
        const path = String(raw == null ? '' : raw).trim();
        if (!path) continue;
        const key = path.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(path);
    }
    return out;
}

/**
 * routeExternalDrop 把 Go 的 app-file-drop 载荷归一成路由结果。
 * @param {object} payload {filenames, x, y, target, attrs}
 * @returns {{target: string, paths: string[], dir: string, rawTarget: string}}
 */
export function routeExternalDrop(payload) {
    const data = (payload && typeof payload === 'object') ? payload : {};
    const rawTarget = typeof data.target === 'string' ? data.target.trim() : '';
    const attrs = (data.attrs && typeof data.attrs === 'object') ? data.attrs : {};
    const dir = typeof attrs['data-drop-dir'] === 'string' ? attrs['data-drop-dir'].trim() : '';
    return {
        target: ROUTE_VALUES.includes(rawTarget) ? rawTarget : 'none',
        paths: normalizeDropPaths(data.filenames),
        dir,
        rawTarget,
    };
}

/**
 * createFileDropRouter 组装分派器。
 * @param {object} deps
 *   flash(msg, isError)
 *   openPaths(paths)                       编辑区：正常打开
 *   copyIntoDir(paths, destDir)            文件树：复制进目录
 *   workspaceFolder() / workspaceFolder    当前工作区根（无工作区时返回空串）
 *   dbDrop(paths)                          数据库面板：sqlite / 连接配置
 *   aiAttach(paths)                        AI 面板：附加进 composer
 */
export function createFileDropRouter(deps) {
    const d = deps || {};

    function flash(message, isError) {
        if (typeof d.flash === 'function') d.flash(String(message == null ? '' : message), !!isError);
    }

    function workspaceRoot() {
        try {
            const value = typeof d.workspaceFolder === 'function' ? d.workspaceFolder() : d.workspaceFolder;
            return String(value == null ? '' : value).trim();
        } catch (e) {
            return '';
        }
    }

    async function handle(payload) {
        const route = routeExternalDrop(payload);
        if (!route.paths.length) return {target: route.target, handled: 0};
        if (route.target === 'none') return {target: 'none', handled: 0};
        try {
            if (route.target === DROP_ROUTES.EDITOR) {
                await d.openPaths(route.paths);
                return {target: route.target, handled: route.paths.length};
            }
            if (route.target === DROP_ROUTES.FILES) {
                const destDir = route.dir || workspaceRoot();
                if (!destDir) {
                    flash('先打开一个文件夹，再从外部把文件拖到文件树里复制', true);
                    return {target: route.target, destDir: '', handled: 0};
                }
                await d.copyIntoDir(route.paths, destDir);
                return {target: route.target, destDir, handled: route.paths.length};
            }
            if (route.target === DROP_ROUTES.DB) {
                await d.dbDrop(route.paths);
                return {target: route.target, handled: route.paths.length};
            }
            if (route.target === DROP_ROUTES.AI) {
                await d.aiAttach(route.paths);
                return {target: route.target, handled: route.paths.length};
            }
        } catch (e) {
            flash('拖放处理失败：' + ((e && e.message) || e), true);
            return {target: route.target, handled: 0, error: String((e && e.message) || e)};
        }
        return {target: route.target, handled: 0};
    }

    return {handle, route: routeExternalDrop};
}
