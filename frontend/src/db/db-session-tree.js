// db-session-tree.js：侧栏「数据库」面板的会话树（JetBrains 对齐，方案 §11.8 入口重构 v2）。
//
// 层级全部懒加载：连接条目（展开 = 建立会话）→ 库 → 分组「表 N」「视图 N」（N=0 隐藏）
// + MySQL 专属「服务器对象」→ 排序规则 / 用户 / 虚拟视图（DBListServerObjects，失败组隐藏）。
// 表/视图节点双击 → 以独立虚拟标签页打开数据网格；节点行尾 muted 显示表注释。
// 会话状态（连接中/失败/断开）由 db-sessions.js 管理并广播，本模块只管展示与展开缓存。
// 清单分组（按 kind）沿用 db-ui 原语义：内置类型固定序在前，插件按显示名排。

import {iconSvg} from '../core/icons.js';
import {createInput} from '../core/form-controls.js';
import {
    kindLabel, rowEstimateLabel, buildDDL,
    redisPrefixTree, redisGroupPrefix, redisKeyDisplayName, redisTTLLabel, REDIS_KEY_SEP,
} from './db-model.js';
import {pluginDbLabel} from './db-plugin.js';
import {ensureSession, getSessionState, disconnectSession, subscribeSession} from './db-sessions.js';
import {openCreateTableForm} from './db-create-table.js';

const SERVER_OBJ_ID = 'server-objects';

export function createDbSessionTree(deps) {
    const el = document.createElement('div');
    el.className = 'db-session-list';

    // 展开箭头走 icons.js 注册表（图标规范：不手写文字符号），open 态由 CSS 旋转 90°
    function arrowGlyph() {
        return iconSvg('chevron-right', 10);
    }

    // entryId → 展开与清单缓存；会话重连/断开时整条清空（db/servoer 清单随会话失效）
    const cache = new Map();
    // entryId → 取消订阅函数（render 重建 DOM 前先撤旧监听，防泄漏叠加）
    const subs = new Map();
    // entryId → 连接条目最新快照（openTable 回调要用，不能闭包旧对象）
    const entries = new Map();
    // entryId → 条目行 DOM（行菜单的 [...] 锚点复用）
    const rowEls = new Map();
    // 类型分组的折叠态（内存即可：重启回默认全展开）
    const collapsed = new Set();

    // sessionApi 会话通道解析：插件驱动会话在门面（snap.api）里，内置 kind 走宿主绑定。
    // 树的会话级调用必须经过这里——插件会话 id 是 'p:<entryId>'，只存在于前端；把这种 id
    // 直接发给 deps.backend 时 Go 侧 sessions 里没有它，会回 ErrSessionNotFound
    // （「连接会话不存在，可能已断开或空闲超时，请重新连接」，dbclient.go）。
    function sessionApi(entry) {
        const snap = getSessionState(entry.id);
        return (snap && snap.api) || deps.backend;
    }

    function treeState(id) {
        if (!cache.has(id)) {
            cache.set(id, {
                expanded: false,
                dbs: null,
                dbsLoading: false,
                dbsError: '',
                expandedDb: new Set(),
                objects: new Map(),   // db → {loading, list, error}
                groupOpen: new Set(), // db + '|tables' / db + '|views'
                server: null,         // {loading, groups, error}
                serverOpen: false,
                serverGroupOpen: new Set(),
                redis: null,          // Redis 键空间状态（redisStateOf 惰性建）
            });
        }
        return cache.get(id);
    }

    function resetTree(id) {
        cache.delete(id);
    }

    // ---------- 加载 ----------

    async function loadDatabases(entry, info) {
        const st = treeState(entry.id);
        st.dbsLoading = true;
        st.dbsError = '';
        render();
        try {
            st.dbs = await sessionApi(entry).DBListDatabases(info.id) || [];
            // 单库（SQLite 恒 main）直接展开到分组层
            if (st.dbs.length === 1) st.expandedDb.add(st.dbs[0]);
        } catch (e) {
            st.dbsError = String(e && e.message || e);
        } finally {
            st.dbsLoading = false;
        }
        render();
    }

    async function loadObjects(entry, info, db, force) {
        const st = treeState(entry.id);
        const cur = st.objects.get(db);
        if (cur && !force) return cur;
        st.objects.set(db, {loading: true, list: cur && cur.list || null, error: ''});
        render();
        try {
            const list = await sessionApi(entry).DBListObjects(info.id, db) || [];
            st.objects.set(db, {loading: false, list, error: ''});
        } catch (e) {
            st.objects.set(db, {loading: false, list: null, error: String(e && e.message || e)});
        }
        render();
        return st.objects.get(db);
    }

    // 服务器对象是 MySQL 专属（调用点均有 isMySQL 门禁），插件驱动会话没有这个方法，
    // 故这里固定走宿主绑定，不参与 sessionApi 分派。
    async function loadServerObjects(entry, info) {
        const st = treeState(entry.id);
        if (st.server) return;
        st.server = {loading: true, groups: null, error: ''};
        render();
        try {
            const res = await deps.backend.DBListServerObjects(info.id);
            st.server = {loading: false, groups: res && res.groups || [], error: ''};
        } catch (e) {
            st.server = {loading: false, groups: null, error: String(e && e.message || e)};
        }
        render();
    }

    // ---------- Redis 键空间（方案 §5.4）：SCAN 分层聚合 + 诚实计数 ----------

    const REDIS_SCAN_BATCH = 250;

    // redisStateOf 会话级键空间状态（搜索模式 / 扁平开关 / 展开组 / 各前缀层扫描缓存）
    function redisStateOf(st) {
        if (!st.redis) {
            st.redis = {pattern: '', flat: false, openGroups: new Set(), nodes: new Map()};
        }
        return st.redis;
    }

    // redisCacheKey 某前缀层的缓存键（与 db 一起隔离）
    const redisCacheKey = (db, prefix) => db + '\x00' + prefix;

    function redisNodeOf(entry, db, prefix, create) {
        const rs = redisStateOf(treeState(entry.id));
        const key = redisCacheKey(db, prefix);
        if (!rs.nodes.has(key) && create) {
            rs.nodes.set(key, {prefix, keys: [], cursor: 0, started: false, loading: false, error: ''});
        }
        return rs.nodes.get(key);
    }

    // loadRedisNode SCAN 一批（MATCH 组前缀* 或全局搜索模式；COUNT 250；cursor 续扫）。
    // SCAN 无法给全库总数——诚实 UI 显示「已匹配 N」+ 游标未尽时的「加载更多」。
    async function loadRedisNode(entry, info, db, prefix, append) {
        const rs = redisStateOf(treeState(entry.id));
        const node = redisNodeOf(entry, db, prefix, true);
        if (node.loading) return;
        if (!append) {
            node.keys = [];
            node.cursor = 0;
        }
        node.started = true;
        node.loading = true;
        node.error = '';
        render();
        try {
            const match = prefix ? prefix + '*' : (rs.pattern || '');
            const res = await deps.backend.DBRedisScan(info.id, db, match, node.cursor, REDIS_SCAN_BATCH, '');
            node.keys = node.keys.concat(res && res.keys || []);
            node.cursor = (res && res.cursor) || 0;
        } catch (e) {
            node.error = String(e && e.message || e);
        } finally {
            node.loading = false;
        }
        render();
    }

    function isRedis(snap) {
        return !!(snap && snap.info && snap.info.kind === 'redis');
    }

    // redisTypeIcon 键类型 → 注册表图标（string/hash/list/set/zset/stream 语义对位）
    function redisTypeIcon(type) {
        switch (type) {
            case 'string': return 'file';
            case 'hash': return 'braces';
            case 'list': return 'list';
            case 'set': return 'tag';
            case 'zset': return 'chart';
            case 'stream': return 'history';
            default: return 'key';
        }
    }

    // renderRedisKeySpace db 展开区的 Redis 形态：搜索/形态切换行 + 根层节点
    function renderRedisKeySpace(entry, snap, db) {
        const rs = redisStateOf(treeState(entry.id));
        const wrap = document.createElement('div');
        wrap.className = 'db-tree-sub';
        const searchRow = document.createElement('div');
        searchRow.className = 'db-redis-search';
        const searchInput = createInput({value: rs.pattern, placeholder: '模式过滤（SCAN MATCH，如 user:*）'});
        searchInput.control.className = 'dlg-input db-redis-pattern';
        // input 只存值不重画（保焦点）；Enter 才触发重扫
        searchInput.control.addEventListener('input', () => {
            rs.pattern = searchInput.control.value.trim();
        });
        searchInput.control.addEventListener('keydown', (ev) => {
            if (ev.key !== 'Enter') return;
            ev.preventDefault();
            rs.nodes.clear();
            rs.openGroups.clear();
            loadRedisNode(entry, snap.info, db, '', false);
        });
        const flatBtn = document.createElement('button');
        flatBtn.type = 'button';
        flatBtn.className = 'db-btn db-redis-flat';
        flatBtn.dataset.tip = rs.flat ? '切换为前缀分组' : '切换为扁平列表';
        flatBtn.innerHTML = iconSvg(rs.flat ? 'tree' : 'list', 12);
        flatBtn.addEventListener('click', () => {
            rs.flat = !rs.flat;
            render();
        });
        searchRow.append(searchInput.element, flatBtn);
        wrap.appendChild(searchRow);
        wrap.appendChild(renderRedisNode(entry, snap, db, ''));
        return wrap;
    }

    // renderRedisNode 一层前缀的展开内容：聚合出子组 + 叶子键 + 加载更多/匹配计数
    function renderRedisNode(entry, snap, db, prefix) {
        const rs = redisStateOf(treeState(entry.id));
        const node = redisNodeOf(entry, db, prefix, true);
        if (!node.started && !node.loading) loadRedisNode(entry, snap.info, db, prefix, false);
        const wrap = document.createElement('div');
        wrap.className = 'db-redis-node';
        if (node.error) hintText(wrap, node.error, 'error');
        const flat = rs.flat;
        const byName = new Map(node.keys.map((k) => [k.name, k]));
        if (flat) {
            for (const k of node.keys) wrap.appendChild(renderRedisKeyRow(entry, snap, db, k));
        } else {
            const agg = redisPrefixTree(node.keys.map((k) => k.name), prefix);
            for (const g of agg.groups) wrap.appendChild(renderRedisGroupRow(entry, snap, db, prefix, g));
            for (const name of agg.leaves) wrap.appendChild(renderRedisKeyRow(entry, snap, db, byName.get(name)));
        }
        if (node.loading && !node.keys.length) hintText(wrap, '扫描中…');
        if (!node.loading && node.cursor !== 0) {
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'db-btn db-redis-more';
            more.textContent = '加载更多（已匹配 ' + node.keys.length + '）';
            more.addEventListener('click', () => loadRedisNode(entry, snap.info, db, prefix, true));
            wrap.appendChild(more);
        } else if (!node.loading && node.started && node.keys.length) {
            hintText(wrap, '已匹配 ' + node.keys.length + ' 个键');
        }
        if (!node.loading && node.started && !node.keys.length && !node.error) {
            hintText(wrap, rs.pattern ? '（无匹配键）' : '（空库）');
        }
        return wrap;
    }

    // renderRedisGroupRow 前缀组节点：展开懒加载子层；右键 刷新 / 删除此前缀（editable）
    function renderRedisGroupRow(entry, snap, db, parentPrefix, group) {
        const rs = redisStateOf(treeState(entry.id));
        const fullPrefix = redisGroupPrefix(parentPrefix, group);
        const open = rs.openGroups.has(fullPrefix);
        const node = redisNodeOf(entry, db, fullPrefix, true);
        const wrap = document.createElement('div');
        wrap.className = 'db-tree-sub';
        const row = rowBase('db-tree-group-row db-tree-leaf-group', 'open-folder');
        row.prepend(arrow(open));
        const name = document.createElement('span');
        name.className = 'db-tree-name';
        name.textContent = parentPrefix === '' ? group + REDIS_KEY_SEP : group;
        name.dataset.tip = fullPrefix + '*';
        row.appendChild(name);
        const agg = redisPrefixTree(node.keys.map((k) => k.name), fullPrefix);
        row.appendChild(countBadge(agg.groups.length + agg.leaves.length));
        row.addEventListener('click', () => {
            if (open) {
                rs.openGroups.delete(fullPrefix);
            } else {
                rs.openGroups.add(fullPrefix);
                if (!node.started) loadRedisNode(entry, snap.info, db, fullPrefix, false);
            }
            render();
        });
        row.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            const items = [
                {label: '刷新', icon: 'refresh', action: () => {
                    rs.nodes.delete(redisCacheKey(db, fullPrefix));
                    render();
                }},
            ];
            if (snap.info.editable && deps.deleteByPrefixConfirm) {
                items.push({sep: true});
                items.push({label: '删除此前缀下所有键…', icon: 'trash', action: () => deps.deleteByPrefixConfirm(entry, db, fullPrefix)});
            }
            openTreeMenu(items, ev.clientX, ev.clientY);
        });
        wrap.appendChild(row);
        if (open) wrap.appendChild(renderRedisNode(entry, snap, db, fullPrefix));
        return wrap;
    }

    // renderRedisKeyRow 键叶子：类型图标 + 行尾 TTL 角标；双击开键查看器；右键 查看/复制/删除
    function renderRedisKeyRow(entry, snap, db, k) {
        if (!k) return document.createElement('div');
        const row = rowBase('db-tree-obj db-tree-plain', redisTypeIcon(k.type),
            k.type + (k.length ? ' · ' + k.length : '') + (k.ttl > 0 ? ' · TTL ' + k.ttl + 's' : ''));
        const name = document.createElement('span');
        name.className = 'db-tree-name';
        name.textContent = redisKeyDisplayName(k.name);
        row.appendChild(name);
        const ttl = redisTTLLabel(k.ttl);
        if (ttl) {
            const b = document.createElement('span');
            b.className = 'db-tree-count';
            b.textContent = ttl;
            b.dataset.tip = k.ttl === -1 ? '永不过期' : 'TTL ' + k.ttl + 's';
            row.appendChild(b);
        }
        const openKey = () => deps.openRedisKey && deps.openRedisKey(entry, db, k.name);
        row.addEventListener('dblclick', openKey);
        row.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            const items = [
                {label: '查看值', icon: 'eye', action: openKey},
                {label: '复制键名', icon: 'copy', action: () => {
                    if (deps.copyText) deps.copyText(k.name);
                    else if (deps.flash) deps.flash(k.name);
                }},
            ];
            if (snap.info.editable && deps.deleteKeyConfirm) {
                items.push({sep: true});
                items.push({label: '删除键…', icon: 'trash', action: () => deps.deleteKeyConfirm(entry, db, k.name)});
            }
            if (deps.openConsole) {
                items.push({sep: true});
                items.push({label: '打开查询控制台', icon: 'terminal', action: () => deps.openConsole(entry)});
            }
            openTreeMenu(items, ev.clientX, ev.clientY);
        });
        return row;
    }

    // ---------- 行构造 ----------

    function rowBase(cls, icon, tip) {
        const row = document.createElement('div');
        row.className = 'db-tree-row ' + cls;
        if (tip) row.dataset.tip = tip;
        if (icon) {
            const ic = document.createElement('span');
            ic.className = 'db-tree-ic';
            ic.innerHTML = iconSvg(icon, 13);
            row.appendChild(ic);
        }
        return row;
    }

    function arrow(open) {
        const a = document.createElement('span');
        a.className = 'db-tree-arrow' + (open ? ' open' : '');
        a.innerHTML = arrowGlyph();
        return a;
    }

    function countBadge(n) {
        const b = document.createElement('span');
        b.className = 'db-tree-count';
        b.textContent = String(n);
        return b;
    }

    function hintText(parent, text, cls) {
        const hint = document.createElement('div');
        hint.className = 'db-tree-hint' + (cls ? ' ' + cls : '');
        hint.textContent = text;
        parent.appendChild(hint);
    }

    // 树内右键菜单（层级各自的动作集合；条目行的右键直接复用 db-ui 的 rowMenu）
    function openTreeMenu(items, x, y) {
        if (deps.ctxMenu) deps.ctxMenu.open(items, x, y);
    }

    function menuForDbRow(entry, snap, db) {
        const items = [
            {label: '刷新清单', icon: 'refresh', action: () => {
                const st = treeState(entry.id);
                st.objects.delete(db);
                st.server = null;
                loadObjects(entry, snap.info, db, true);
                if (st.serverOpen && isMySQL(snap)) loadServerObjects(entry, snap.info);
            }},
        ];
        if (snap.info.kind === 'sqlite' && snap.info.editable) {
            items.push({label: '新建表…', icon: 'plus', action: () => openCreateTableDialog(entry, snap, db)});
        }
        items.push({sep: true});
        items.push({label: '打开查询控制台', icon: 'terminal', action: () => deps.openConsole && deps.openConsole(entry)});
        items.push({label: '断开连接', icon: 'close', action: () => {
            resetTree(entry.id);
            disconnectSession(entry.id);
        }});
        return items;
    }

    function menuForTableGroup(entry, snap, db) {
        const items = [{label: '刷新清单', icon: 'refresh', action: () => {
            const st = treeState(entry.id);
            st.objects.delete(db);
            loadObjects(entry, snap.info, db, true);
        }}];
        if (snap.info.kind === 'sqlite' && snap.info.editable) {
            items.push({label: '新建表…', icon: 'plus', action: () => openCreateTableDialog(entry, snap, db)});
        }
        return items;
    }

    function openCreateTableDialog(entry, snap, db) {
        const st2 = getSessionState(entry.id);
        openCreateTableForm({
            backend: (st2 && st2.api) || deps.backend,
            info: snap.info,
            logActivity: deps.logActivity,
            onCreated: () => {
                const st = treeState(entry.id);
                st.objects.delete(db);
                render();
            },
        });
    }

    // 连接条目行：箭头 + 图标 + 名称 + 徽标（可编辑/只读快照/连接中/失败）+ [...] 菜单
    function renderEntryRow(entry, groupEl) {
        const st = treeState(entry.id);
        const snap = getSessionState(entry.id);
        const row = rowBase('db-side-row db-tree-session', entryIcon(entry), entryTip(entry));
        row.prepend(arrow(st.expanded));
        const name = document.createElement('span');
        name.className = 'db-tree-name';
        name.textContent = entry.name || '数据库';
        row.appendChild(name);
        if (snap && snap.status === 'connecting') {
            const b = document.createElement('span');
            b.className = 'db-tree-badge muted';
            b.textContent = '连接中…';
            row.appendChild(b);
        } else if (snap && snap.status === 'error') {
            const b = document.createElement('span');
            b.className = 'db-tree-badge warn';
            b.title = snap.error;
            b.textContent = '连接失败';
            row.appendChild(b);
        } else if (snap && snap.info) {
            if (snap.info.immutable) {
                const b = document.createElement('span');
                b.className = 'db-tree-badge warn';
                b.dataset.tip = '以 immutable 模式打开：数据可能不反映其他进程的写入';
                b.textContent = '只读快照';
                row.appendChild(b);
            }
            const b = document.createElement('span');
            b.className = 'db-tree-badge' + (snap.info.editable ? '' : ' muted');
            b.textContent = snap.info.editable ? '可编辑' : '只读';
            row.appendChild(b);
        }
        const menuBtn = document.createElement('button');
        menuBtn.type = 'button';
        menuBtn.className = 'db-tree-act';
        menuBtn.title = '操作';
        menuBtn.innerHTML = iconSvg('more', 12);
        menuBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const rect = menuBtn.getBoundingClientRect();
            deps.onEntryMenu(entry, rect, rowEls.get(entry.id));
        });
        row.appendChild(menuBtn);

        const toggle = async () => {
            st.expanded = !st.expanded;
            if (st.expanded) {
                await ensureSession(entry).catch(() => {}); // 失败已入状态（树行显示），这里吞掉避免未处理拒绝
            }
            render();
        };
        row.addEventListener('click', toggle);
        row.addEventListener('dblclick', toggle);
        // 右键 = [...] 同款菜单（层级补齐，JetBrains 对齐）
        row.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            if (deps.onEntryMenu) deps.onEntryMenu(entry, {left: ev.clientX, bottom: ev.clientY}, row);
        });
        groupEl.appendChild(row);
        return row;
    }

    // 连接条目的展开区：连接中 / 失败（重试）/ 库清单
    function renderEntryChildren(entry, groupEl) {
        const st = treeState(entry.id);
        const snap = getSessionState(entry.id);
        const area = document.createElement('div');
        area.className = 'db-session-tree';
        groupEl.appendChild(area);
        if (!st.expanded) return;
        if (!snap || snap.status === 'closed') {
            hintText(area, '未连接（点击连接）');
            return;
        }
        if (snap.status === 'connecting') {
            hintText(area, '连接中…');
            return;
        }
        if (snap.status === 'error') {
            hintText(area, '连接失败：' + snap.error, 'error');
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'db-btn';
            retry.textContent = '重试连接';
            retry.addEventListener('click', () => {
                resetTree(entry.id);
                ensureSession(entry).catch(() => {});
            });
            area.appendChild(retry);
            return;
        }
        // 已连接：库清单（懒加载）
        if (!st.dbs && !st.dbsLoading && !st.dbsError) loadDatabases(entry, snap.info);
        if (st.dbsLoading && !st.dbs) {
            hintText(area, '加载中…');
            return;
        }
        if (st.dbsError) {
            hintText(area, st.dbsError, 'error');
            return;
        }
        for (const db of st.dbs || []) {
            area.appendChild(renderDbRow(entry, snap, db));
            if (st.expandedDb.has(db)) area.appendChild(renderDbChildren(entry, snap, db));
        }
    }

    function renderDbRow(entry, snap, db) {
        const st = treeState(entry.id);
        const row = rowBase('db-tree-db', 'open-folder');
        row.prepend(arrow(st.expandedDb.has(db)));
        const name = document.createElement('span');
        name.className = 'db-tree-name';
        name.textContent = db;
        row.appendChild(name);
        const refresh = document.createElement('button');
        refresh.type = 'button';
        refresh.className = 'db-tree-act';
        refresh.dataset.tip = '刷新清单';
        refresh.innerHTML = iconSvg('refresh', 12);
        refresh.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            if (isRedis(snap)) {
                // Redis：清键空间扫描缓存重扫
                const rs = redisStateOf(st);
                for (const key of [...rs.nodes.keys()]) {
                    if (key.startsWith(db + '\x00')) rs.nodes.delete(key);
                }
                rs.openGroups.clear();
                render();
                return;
            }
            st.objects.delete(db);
            st.server = null;
            await loadObjects(entry, snap.info, db, true);
            if (st.serverOpen && isMySQL(snap)) await loadServerObjects(entry, snap.info);
        });
        row.appendChild(refresh);
        row.addEventListener('click', () => {
            if (st.expandedDb.has(db)) {
                st.expandedDb.delete(db);
            } else {
                st.expandedDb.add(db);
                if (!isRedis(snap)) loadObjects(entry, snap.info, db, false);
            }
            render();
        });
        row.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            openTreeMenu(menuForDbRow(entry, snap, db), ev.clientX, ev.clientY);
        });
        return row;
    }

    // 库的展开区：Redis 走键空间；SQL 方言走表分组 / 视图分组 / 服务器对象分组
    function renderDbChildren(entry, snap, db) {
        const st = treeState(entry.id);
        const wrap = document.createElement('div');
        wrap.className = 'db-tree-sub';
        if (isRedis(snap)) {
            wrap.appendChild(renderRedisKeySpace(entry, snap, db));
            return wrap;
        }
        const objs = st.objects.get(db);
        if (!objs) {
            loadObjects(entry, snap.info, db, false);
            hintText(wrap, '加载中…');
            return wrap;
        }
        if (objs.loading && !objs.list) {
            hintText(wrap, '加载中…');
            return wrap;
        }
        if (objs.error) {
            hintText(wrap, objs.error, 'error');
            return wrap;
        }
        const list = objs.list || [];
        const tables = list.filter((o) => o.kind === 'table');
        const views = list.filter((o) => o.kind === 'view');
        // 「表」分组带结构化建表入口（方案 §11.9）：仅 SQLite editable 会话显示（DDL 能力位在 Go 侧把关）
        const canCreateTable = snap.info.kind === 'sqlite' && snap.info.editable;
        if (tables.length) wrap.appendChild(renderGroupRow(entry, snap, db, 'tables', '表', 'view-table', tables.length,
            () => tables.map((o) => renderObjectRow(entry, db, o)),
            canCreateTable ? {
                title: '新建表',
                onClick: () => openCreateTableDialog(entry, snap, db),
            } : null,
            canCreateTable ? menuForTableGroup(entry, snap, db) : [{label: '刷新清单', icon: 'refresh', action: () => {
                const st = treeState(entry.id);
                st.objects.delete(db);
                loadObjects(entry, snap.info, db, true);
            }}]));
        if (views.length) wrap.appendChild(renderGroupRow(entry, snap, db, 'views', '视图', 'eye', views.length,
            () => views.map((o) => renderObjectRow(entry, db, o))));
        if (isMySQL(snap)) wrap.appendChild(renderServerGroupRow(entry, snap));
        if (!tables.length && !views.length && !isMySQL(snap)) hintText(wrap, '（无表）');
        return wrap;
    }

    // 「表 56」分组行：展开渲染子清单（由调用方给 renderItems）；actionBtn = 行尾动作（如新建表）、menuFn = 右键菜单
    function renderGroupRow(entry, snap, db, key, label, icon, count, renderItems, actionBtn, menuFn) {
        const st = treeState(entry.id);
        const openKey = db + '|' + key;
        const row = rowBase('db-tree-group-row', icon);
        row.prepend(arrow(st.groupOpen.has(openKey)));
        const name = document.createElement('span');
        name.className = 'db-tree-name';
        name.textContent = label;
        row.appendChild(name);
        row.appendChild(countBadge(count));
        if (actionBtn) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'db-tree-act';
            btn.title = actionBtn.title;
            btn.innerHTML = iconSvg('plus', 12);
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                actionBtn.onClick();
            });
            row.appendChild(btn);
        }
        row.addEventListener('click', () => {
            if (st.groupOpen.has(openKey)) st.groupOpen.delete(openKey);
            else st.groupOpen.add(openKey);
            render();
        });
        if (menuFn) {
            row.addEventListener('contextmenu', (ev) => {
                ev.preventDefault();
                openTreeMenu(menuFn, ev.clientX, ev.clientY);
            });
        }
        const wrap = document.createElement('div');
        wrap.className = 'db-tree-sub';
        wrap.appendChild(row);
        if (st.groupOpen.has(openKey)) {
            for (const child of renderItems()) wrap.appendChild(child);
        }
        return wrap;
    }

    // 表/视图节点：名称 + 行尾注释（图1）；双击开数据网格标签页；右键 打开/复制表名/控制台
    function renderObjectRow(entry, db, obj) {
        const row = rowBase('db-tree-obj', obj.kind === 'view' ? 'eye' : 'view-table',
            (obj.kind === 'view' ? '视图' : '表') + (rowEstimateLabel(obj.rowEstimate) ? ' · ' + rowEstimateLabel(obj.rowEstimate) : ''));
        const name = document.createElement('span');
        name.className = 'db-tree-name';
        name.textContent = obj.name;
        row.appendChild(name);
        if (obj.comment) {
            const cm = document.createElement('span');
            cm.className = 'db-tree-comment';
            cm.textContent = obj.comment;
            cm.title = obj.comment;
            row.appendChild(cm);
        }
        row.addEventListener('dblclick', () => deps.openTable(entry, db, obj));
        row.addEventListener('contextmenu', async (ev) => {
            ev.preventDefault();
            const items = [
                {label: '打开', icon: obj.kind === 'view' ? 'eye' : 'view-table', action: () => deps.openTable(entry, db, obj)},
                {label: '复制表名', icon: 'copy', action: () => {
                    const full = (db && db !== 'main' ? db + '.' : '') + obj.name;
                    if (deps.copyText) deps.copyText(full);
                    else if (deps.flash) deps.flash(full);
                }},
            ];
            if (obj.kind !== 'view') {
                items.push({label: '复制 DDL', icon: 'copy', action: async () => {
                    const sql = await fetchDDL(entry, db, obj.name);
                    if (sql) {
                        if (deps.copyText) deps.copyText(sql);
                        else deps.flash(sql.slice(0, 60) + '…');
                    }
                }});
                items.push({label: '导出 DDL…', icon: 'download', action: async () => {
                    const sql = await fetchDDL(entry, db, obj.name);
                    if (!sql) return;
                    let path = '';
                    try {
                        path = await deps.backend.ShowSaveFileDialog('导出 DDL', obj.name + '.sql');
                    } catch (e) {
                        return; // 取消保存对话框（尽力而为路径）
                    }
                    if (!path) return;
                    try {
                        await deps.backend.SaveFile(path, sql + '\n', 'lf', false, 'utf-8');
                        if (deps.flash) deps.flash('DDL 已导出：' + path);
                    } catch (e) {
                        if (deps.flash) deps.flash('导出失败：' + (e && e.message || e), true);
                    }
                }});
            }
            if (deps.openConsole) {
                items.push({sep: true});
                items.push({label: '打开查询控制台', icon: 'terminal', action: () => deps.openConsole(entry)});
            }
            openTreeMenu(items, ev.clientX, ev.clientY);
        });
        return row;
    }

    // fetchDDL 拉元数据并生成建表语句（buildDDL 纯函数在 db-model；失败走 flash 并返回空）
    async function fetchDDL(entry, db, table) {
        const snap = getSessionState(entry.id);
        if (!snap || !snap.info) return '';
        try {
            const meta = await sessionApi(entry).DBDescribe(snap.info.id, db, table, false);
            return buildDDL(snap.info.kind, meta);
        } catch (e) {
            if (deps.flash) deps.flash('读取表结构失败：' + (e && e.message || e), true);
            return '';
        }
    }

    // 「服务器对象」分组行（仅 MySQL）：展开时拉 DBListServerObjects，失败子组隐藏
    function renderServerGroupRow(entry, snap) {
        const st = treeState(entry.id);
        const wrap = document.createElement('div');
        wrap.className = 'db-tree-sub';
        const row = rowBase('db-tree-group-row', 'globe');
        row.prepend(arrow(st.serverOpen));
        const name = document.createElement('span');
        name.className = 'db-tree-name';
        name.textContent = '服务器对象';
        row.appendChild(name);
        row.addEventListener('click', () => {
            st.serverOpen = !st.serverOpen;
            if (st.serverOpen && !st.server) loadServerObjects(entry, snap.info);
            render();
        });
        row.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            openTreeMenu([{label: '刷新服务器对象', icon: 'refresh', action: () => {
                st.server = null;
                loadServerObjects(entry, snap.info);
            }}], ev.clientX, ev.clientY);
        });
        wrap.appendChild(row);
        if (!st.serverOpen) return wrap;
        if (!st.server) {
            loadServerObjects(entry, snap.info);
            hintText(wrap, '加载中…');
            return wrap;
        }
        if (st.server.loading) {
            hintText(wrap, '加载中…');
            return wrap;
        }
        if (st.server.error) {
            hintText(wrap, st.server.error, 'error');
            return wrap;
        }
        const visible = (st.server.groups || []).filter((g) => !g.error);
        for (const g of visible) wrap.appendChild(renderServerItemGroup(entry, g));
        if (!visible.length) hintText(wrap, '（无可访问的服务器对象）');
        return wrap;
    }

    // 排序规则/用户/虚拟视图子分组行：计数 + 展开列清单（清单已在内存，纯展开）
    function renderServerItemGroup(entry, g) {
        const st = treeState(entry.id);
        const openKey = SERVER_OBJ_ID + '|' + g.id;
        const wrap = document.createElement('div');
        wrap.className = 'db-tree-sub';
        const row = rowBase('db-tree-group-row db-tree-leaf-group', null);
        row.prepend(arrow(st.serverGroupOpen.has(openKey)));
        const name = document.createElement('span');
        name.className = 'db-tree-name';
        name.textContent = g.label;
        row.appendChild(name);
        row.appendChild(countBadge((g.items || []).length));
        row.addEventListener('click', () => {
            if (st.serverGroupOpen.has(openKey)) st.serverGroupOpen.delete(openKey);
            else st.serverGroupOpen.add(openKey);
            render();
        });
        wrap.appendChild(row);
        if (st.serverGroupOpen.has(openKey)) {
            for (const item of g.items || []) {
                const itemRow = rowBase('db-tree-obj db-tree-plain', null, item);
                const span = document.createElement('span');
                span.className = 'db-tree-name';
                span.textContent = item;
                itemRow.appendChild(span);
                wrap.appendChild(itemRow);
            }
        }
        return wrap;
    }

    // ---------- 渲染 ----------

    function entryIcon(entry) {
        if (entry.kind === 'sqlite') return 'database';
        if (entry.kind === 'mysql' || entry.kind === 'mariadb') return 'globe';
        if (entry.kind === 'redis') return 'key';
        return 'puzzle';
    }

    function entryTip(entry) {
        if (entry.kind === 'sqlite') return 'SQLite 库文件';
        if (entry.kind === 'mysql' || entry.kind === 'mariadb') return 'MySQL / MariaDB 连接';
        if (entry.kind === 'redis') return 'Redis 连接（键空间）';
        return '插件驱动数据源';
    }

    function isMySQL(snap) {
        return !!(snap && snap.info && snap.info.kind === 'mysql');
    }

    function labelForKind(kind) {
        return kind.startsWith('plugin:') ? pluginDbLabel(kind) : kindLabel(kind);
    }

    // 类型分组头（沿用 db-ui 原语义：内置类型固定序在前，插件按显示名排）
    function groupHeader(kind, rows) {
        const head = document.createElement('div');
        head.className = 'db-side-group-head';
        const isCollapsed = collapsed.has(kind);
        const ar = document.createElement('span');
        ar.className = 'db-tree-arrow' + (isCollapsed ? '' : ' open');
        ar.innerHTML = arrowGlyph();
        const label = document.createElement('span');
        label.className = 'db-side-group-label';
        label.textContent = labelForKind(kind) + '（' + rows.length + '）';
        head.append(ar, label);
        head.addEventListener('click', () => {
            if (collapsed.has(kind)) collapsed.delete(kind);
            else collapsed.add(kind);
            render();
        });
        return head;
    }

    function render() {
        // 订阅对齐：新条目挂监听，消失的条目撤监听并清缓存
        const list = deps.getEntries();
        const seen = new Set();
        for (const entry of list) {
            seen.add(entry.id);
            entries.set(entry.id, entry);
            if (!subs.has(entry.id)) {
                subs.set(entry.id, subscribeSession(entry.id, () => render()));
            }
        }
        for (const id of [...subs.keys()]) {
            if (!seen.has(id)) {
                subs.get(id)();
                subs.delete(id);
                cache.delete(id);
                entries.delete(id);
                rowEls.delete(id);
            }
        }
        el.textContent = '';
        if (!list.length) {
            hintText(el, '本工作区还没有添加数据库。用上方按钮添加 SQLite 库文件、MySQL/MariaDB 连接或插件驱动，展开条目即可浏览。');
            return;
        }
        const kinds = [];
        for (const e of list) {
            if (!kinds.includes(e.kind)) kinds.push(e.kind);
        }
        const builtinOrder = {sqlite: 0, mysql: 1, mariadb: 2, redis: 3};
        kinds.sort((a, b) => {
            const oa = builtinOrder[a] != null ? builtinOrder[a] : 99;
            const ob = builtinOrder[b] != null ? builtinOrder[b] : 99;
            if (oa !== ob) return oa - ob;
            return labelForKind(a) < labelForKind(b) ? -1 : 1;
        });
        for (const kind of kinds) {
            const rows = list.filter((e) => e.kind === kind);
            if (!rows.length) continue;
            el.appendChild(groupHeader(kind, rows));
            if (collapsed.has(kind)) continue;
            for (const entry of rows) {
                const group = document.createElement('div');
                group.className = 'db-session-item';
                const entryRow = renderEntryRow(entry, group);
                rowEls.set(entry.id, entryRow);
                renderEntryChildren(entry, group);
                el.appendChild(group);
            }
        }
    }

    return {
        el,
        render,
        /** 会话断开/重连后清展开缓存（清单随旧会话失效）。 */
        resetEntry(id) {
            resetTree(id);
            render();
        },
        /**
         * expandEntry 展开某条目并建立会话（外部拖放「加入清单并打开」用）。
         * 与行点击 toggle 同一条路径：失败已由会话状态机记账（树行显示「连接失败」），
         * 这里把错误继续抛给调用方，让域处理器能回滚刚建的清单条目。
         */
        expandEntry(entry) {
            if (!entry || !entry.id) return Promise.reject(new Error('数据库条目无效'));
            const st = treeState(entry.id);
            st.expanded = true;
            render();
            return ensureSession(entry);
        },
        /** 断开连接（行菜单用）。 */
        disconnect(id) {
            resetTree(id);
            return disconnectSession(id);
        },
    };
}
