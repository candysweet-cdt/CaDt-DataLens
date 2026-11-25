// db-drop.js：外部文件拖进侧栏「数据库」面板的分派（DOM 无关，node 可直测）。
//
// 两类文件、两条完全不同的路：
//   - SQLite 库文件（.db/.db3/.sqlite/.sqlite3）→ 以只读加进工作区清单（settings.dbWorkspaceDatabases）
//     并展开连接（看得到库/表树，不自动打开表标签页）。连接失败说明不是有效库 → 回滚刚建的条目，
//     别让「拖错的文件」在清单里留一堆连不上的脏行。
//   - 连接配置文件（.json，{connections:[...]}）→ 交 Go 侧 DBImportConnections 导入 MySQL/MariaDB/Redis
//     连接，再把这些连接加进当前工作区清单并展开。密码不随配置导入（dpapi 绑定本机），连不上属预期，
//     提示里必须说清。
// 其余类型一律不接（提示一次），不在数据库面板里做「猜格式」。
//
// 依赖全部注入：清单读写与 id 生成留在 db-ui.js（工作区条目的唯一所有者），这里只管顺序与提示。

const SQLITE_EXTS = ['.db', '.db3', '.sqlite', '.sqlite3'];

/**
 * classifyDbDropPath 按扩展名给拖入文件分类。
 * @param {string} path
 * @returns {'sqlite'|'connection-config'|'unsupported'}
 */
export function classifyDbDropPath(path) {
    const lower = String(path == null ? '' : path).trim().toLowerCase();
    if (!lower) return 'unsupported';
    for (const ext of SQLITE_EXTS) {
        if (lower.endsWith(ext)) return 'sqlite';
    }
    if (lower.endsWith('.json')) return 'connection-config';
    return 'unsupported';
}

// uniquePaths 批内去重（大小写不敏感、保留顺序）——拖 5 个文件进来不该开 5 次连接。
function uniquePaths(paths) {
    const seen = new Set();
    const out = [];
    for (const raw of paths || []) {
        const path = String(raw == null ? '' : raw).trim();
        if (!path) continue;
        const key = path.replace(/\\/g, '/').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(path);
    }
    return out;
}

/**
 * createDbDropHandler 组装数据库面板的拖放处理器。
 * @param {object} deps
 *   isEnabled()                        settings.dbToolsEnabled
 *   baseNameOf(path)
 *   findSqliteEntry(path)              工作区清单里同路径的 sqlite 条目（没有返回 null）
 *   addSqliteEntry(path)               建只读 sqlite 条目并返回它
 *   removeEntry(id)                    回滚刚建的条目
 *   ensureConnectionEntry(cfg)         按配置建/取工作区连接条目，返回条目
 *   expandEntry(entry)                 展开并连接（失败 reject）
 *   importConnections(path)            backend.DBImportConnections → {imported, updated, skipped}
 *   flash(msg, isError)
 */
export function createDbDropHandler(deps) {
    const d = deps || {};

    function flash(message, isError) {
        if (typeof d.flash === 'function') d.flash(String(message == null ? '' : message), !!isError);
    }

    function nameOf(path) {
        return typeof d.baseNameOf === 'function' ? d.baseNameOf(path) : String(path || '');
    }

    async function openSqlite(path) {
        const existing = typeof d.findSqliteEntry === 'function' ? d.findSqliteEntry(path) : null;
        if (existing) {
            // 已在清单里：只展开（连着就不用重连——ensureSession 幂等），不重复建条目
            await Promise.resolve(d.expandEntry(existing)).catch(() => {});
            flash('已在工作区清单：' + (existing.name || nameOf(path)));
            return {created: false, entry: existing};
        }
        const entry = d.addSqliteEntry(path);
        try {
            await d.expandEntry(entry);
            flash('已加入数据库：' + (entry.name || nameOf(path)) + '（只读；需要写入时在条目菜单开启「允许编辑」）');
            return {created: true, entry};
        } catch (e) {
            d.removeEntry(entry.id);
            flash('不是可用的 SQLite 数据库：' + nameOf(path) + '（' + ((e && e.message) || e) + '）', true);
            return {created: false, entry: null};
        }
    }

    async function importConfig(path) {
        const result = await d.importConnections(path) || {};
        const configs = [].concat(result.imported || [], result.updated || []);
        const added = result.imported ? result.imported.length : 0;
        const updated = result.updated ? result.updated.length : 0;
        const skipped = result.skipped || [];
        if (!configs.length) {
            const reasons = skipped.map((item) => (item.name || '') + '（' + (item.reason || '') + '）').join('、');
            flash('连接配置里没有可导入的连接' + (reasons ? '：' + reasons : ''), true);
            return {added: 0, updated: 0, entries: []};
        }
        const entries = [];
        for (const cfg of configs) {
            const entry = d.ensureConnectionEntry(cfg);
            if (entry) entries.push(entry);
        }
        // 逐个展开：导入的连接通常还没存密码，连接失败属预期（树行会显示「连接失败」），
        // 这里吞掉错误、由下面的汇总统一解释，不刷 N 条同样的红字。
        for (const entry of entries) {
            await Promise.resolve(d.expandEntry(entry)).catch(() => {});
        }
        let note = '已导入 ' + added + ' 个连接';
        if (updated) note += '、更新 ' + updated + ' 个';
        if (skipped.length) {
            note += '；跳过 ' + skipped.length + ' 个（' +
                skipped.map((item) => (item.name || '未命名') + '：' + (item.reason || '')).join('；') + '）';
        }
        note += '。密码不随配置文件导入，连不上时在条目菜单「编辑连接」重填密码';
        flash(note, !added && !updated);
        return {added, updated, entries};
    }

    async function handle(paths) {
        if (typeof d.isEnabled === 'function' && !d.isEnabled()) {
            flash('数据库工具未启用：在侧栏「数据库」面板里打开「启用数据库工具」开关后再拖入', true);
            return {added: 0, opened: 0, skipped: (paths || []).length};
        }
        const list = uniquePaths(paths);
        let added = 0;
        let updated = 0;
        let skipped = 0;
        for (const path of list) {
            const kind = classifyDbDropPath(path);
            try {
                if (kind === 'sqlite') {
                    const out = await openSqlite(path);
                    if (out && out.created) added++;
                    if (!out || !out.entry) skipped++;
                    continue;
                }
                if (kind === 'connection-config') {
                    const out = await importConfig(path);
                    added += out.added;
                    updated += out.updated;
                    if (!out.added && !out.updated) skipped++;
                    continue;
                }
            } catch (e) {
                skipped++;
                flash('数据库文件处理失败：' + nameOf(path) + '（' + ((e && e.message) || e) + '）', true);
                continue;
            }
            skipped++;
            flash('数据库面板只接受 SQLite 库文件（.db / .db3 / .sqlite / .sqlite3）或连接配置文件（.json）：' + nameOf(path), true);
        }
        return {added, updated, opened: added, skipped};
    }

    return {handle, openSqlite, importConfig};
}
