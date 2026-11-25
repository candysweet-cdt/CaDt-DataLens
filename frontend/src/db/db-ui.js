// db-ui.js：侧栏「数据库」面板——添加入口（按钮/对话框/插件表单）+ 行菜单 + 启用门；
// 清单与会话树（连接 → 库 → 表/视图/服务器对象）的展示归 db-session-tree.js（方案 §11.8）。
//
// 工作区清单存 settings.dbWorkspaceDatabases（平铺数组，条目带 workspace 字段，
// 与 lifecycleHooks 的「本机设置、按工作区生效」同款模式；settings-changed 跨窗同步）：
//   {id, workspace, kind, name, path?|connectionId?|config?, allowEdit?, addedAt}
// kind 三族：sqlite（存路径 + 条目级 allowEdit）、mysql|mariadb（引用全局连接 id，
// 配置与凭据在 Go 侧，多工作区共享；mariadb 与 mysql 同引擎、只差分组标签）、
// `plugin:<插件id>:<驱动id>`（插件驱动，config 存声明字段、密文字段走 dpapi 凭据库）。
//
// 总开关 settings.dbToolsEnabled（默认关）：未启用时面板只显示启用门。

import {iconSvg} from '../core/icons.js';
import {createInput, createSwitch} from '../core/form-controls.js';
import {overlayStack} from '../core/overlay-stack.js';
import {getPluginDbDrivers} from '../shell/plugin-db-drivers.js';
import {openConnectionsManager, confirmDeleteConnection} from './db-connections.js';
import {createDbDropHandler} from './db-drop.js';
import {isPluginDbKind, openPluginSession, pluginDbDriverOf, savePluginSecrets} from './db-plugin.js';
import {createDbSessionTree} from './db-session-tree.js';
import {disconnectSession, getSessionState} from './db-sessions.js';

const REGISTRY_KEY = 'dbWorkspaceDatabases';

function formRow(form, label, control) {
    const row = document.createElement('label');
    row.className = 'db-conn-rowline';
    const text = document.createElement('span');
    text.className = 'db-conn-label';
    text.textContent = label;
    row.append(text, control);
    form.appendChild(row);
    return row;
}

function basenameOf(p) {
    return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
}

export function createDbUi(deps) {

// 折叠状态（内存即可：重启回默认全展开）
function getSettings() {
    return deps.settings || {};
}

function currentWorkspace() {
    // deps.workspaceFolder 是字符串（main.js 的 getter 每次返回当前值），不是函数
    return deps.workspaceFolder || '';
}

function listAll() {
    const v = getSettings()[REGISTRY_KEY];
    return Array.isArray(v) ? v : [];
}

function listForWorkspace() {
    const ws = currentWorkspace();
    return listAll().filter((e) => e.workspace === ws);
}

function persist() {
    deps.persistSettingsLight();
}

function addEntry(entry) {
    const all = listAll();
    all.push(entry);
    getSettings()[REGISTRY_KEY] = all;
    persist();
}

function removeEntry(id) {
    getSettings()[REGISTRY_KEY] = listAll().filter((e) => e.id !== id);
    persist();
}

function updateEntry(id, patch) {
    getSettings()[REGISTRY_KEY] = listAll().map((e) => (e.id === id ? Object.assign({}, e, patch) : e));
    persist();
}

async function globalConnections() {
    try {
        return await deps.backend.DBListConnections() || [];
    } catch (e) {
        return [];
    }
}

// ---------- 添加入口 ----------

// samePathKey 路径比较键：Windows 下大小写不敏感、反斜杠归一。
function samePathKey(path) {
    return String(path || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// findSqliteEntry 当前工作区清单里指向同一库文件的 sqlite 条目（拖放去重用）。
function findSqliteEntry(path) {
    const key = samePathKey(path);
    if (!key) return null;
    return listForWorkspace().find((e) => e.kind === 'sqlite' && e.path && samePathKey(e.path) === key) || null;
}

// addSqliteEntry sqlite 条目的唯一建法（对话框 / 拖放共用）：默认只读，写权限由行菜单显式开启。
function addSqliteEntry(path, opts) {
    const target = String(path || '').trim();
    if (!target) return null;
    const entry = {
        id: newEntryId(),
        workspace: currentWorkspace(),
        kind: 'sqlite',
        path: target,
        name: basenameOf(target),
        allowEdit: !!(opts && opts.allowEdit === true),
        addedAt: Date.now(),
    };
    addEntry(entry);
    renderSidebar();
    return entry;
}

// ensureConnectionEntry 把一条全局连接挂进当前工作区清单（已有则直接返回），供导入后「并打开」用。
function ensureConnectionEntry(cfg) {
    if (!cfg || !cfg.id) return null;
    const existing = listForWorkspace().find((e) => (e.kind === 'mysql' || e.kind === 'mariadb' || e.kind === 'redis')
        && e.connectionId === cfg.id);
    if (existing) return existing;
    const entry = {
        id: newEntryId(),
        workspace: currentWorkspace(),
        kind: cfg.kind === 'redis' ? 'redis' : 'mysql',
        connectionId: cfg.id,
        name: cfg.name || '',
        addedAt: Date.now(),
    };
    addEntry(entry);
    return entry;
}

async function addSqlite() {
    const pick = await deps.backend.ShowOpenFileDialog('选择 SQLite 数据库',
        'SQLite 数据库 (*.db;*.sqlite;*.sqlite3)|*.db;*.sqlite;*.sqlite3|所有文件 (*.*)|*.*');
    const path = String(pick || '');
    if (!path) return;
    const dup = findSqliteEntry(path);
    if (dup) {
        deps.flash('已在工作区清单里：' + dup.name);
        return;
    }
    const entry = addSqliteEntry(path, {allowEdit: false});
    if (entry) deps.flash('已添加数据库：' + entry.name);
}

// 新建空库文件（方案 §11.9）：保存对话框选路径 → Go 建库（存在即报错，绝不覆盖）
// → 默认允许编辑加入工作区（建库就是为了写，行菜单可改）。
async function addSqliteNew() {
    const pick = await deps.backend.ShowSaveFileDialog('新建 SQLite 数据库', '新数据库.db');
    const path = String(pick || '');
    if (!path) return;
    try {
        await deps.backend.DBCreateSQLite(path);
    } catch (e) {
        deps.flash(e && e.message || String(e), true);
        return;
    }
    addEntry({
        id: newEntryId(),
        workspace: currentWorkspace(),
        kind: 'sqlite',
        path,
        name: basenameOf(path),
        allowEdit: true,
        addedAt: Date.now(),
    });
    deps.flash('已创建数据库：' + basenameOf(path) + '（展开后用「表」旁的 + 新建表）');
    renderSidebar();
}

// MySQL/MariaDB 添加/管理：统一对话框（JetBrains「数据源和驱动程序」形态）。
// syncWorkspaceRef / listWorkspaceRefs 把全局连接与工作区清单的双向关系收在注册表这一层
// （引用条目完整返回，管理对话框据此回显驱动标签 mysql|mariadb）。
function dsDeps() {
    return {
        get backend() { return deps.backend; },
        get flash() { return deps.flash; },
        get openConfirmDialog() { return deps.openConfirmDialog; },
        get enhanceSelect() { return deps.enhanceSelect; },
        listWorkspaceRefs: () => listForWorkspace()
            .filter((e) => e.kind === 'mysql' || e.kind === 'mariadb')
            .map((e) => ({connectionId: e.connectionId, kind: e.kind})),
        syncWorkspaceRef: (connectionId, inWorkspace, name, protocol) => {
            const kind = protocol === 'redis' ? 'redis' : (protocol === 'mariadb' ? 'mariadb' : 'mysql');
            const kept = listAll().filter((e) => !((e.kind === 'mysql' || e.kind === 'mariadb' || e.kind === 'redis') && e.connectionId === connectionId && e.workspace === currentWorkspace()));
            if (inWorkspace) {
                kept.push({
                    id: 'wsdb-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
                    workspace: currentWorkspace(),
                    kind,
                    connectionId,
                    name: name || '',
                    addedAt: Date.now(),
                });
            }
            getSettings()[REGISTRY_KEY] = kept;
            persist();
        },
    };
}

async function addMysql() {
    await openConnectionsManager(dsDeps());
    renderSidebar();
}

// addRedis 与 MySQL 共用连接管理对话框（驱动下拉里选 Redis；kind 由对话框落盘）
async function addRedis() {
    await addMysql();
}

// ---------- Redis 危险操作确认（方案 §5.4：批量删 Type-to-Confirm） ----------

// redisDeleteKeyConfirm 单键删除：普通确认（键名在弹层里可见，破坏面只有一键）
function redisDeleteKeyConfirm(deps, entry, db, key) {
    deps.openConfirmDialog(
        '键「' + key + '」将被 DEL 删除，此操作不可撤销。',
        async () => {
            try {
                const snap = getSessionState(entry.id);
                if (!snap || !snap.info) throw new Error('会话已断开');
                await deps.backend.DBRedisApply(snap.info.id, [{kind: 'delKey', key}]);
                deps.flash('已删除键：' + key);
                tree.resetEntry(entry.id);
                renderSidebar();
            } catch (e) {
                deps.flash('删除失败：' + (e && e.message || e), true);
            }
        },
        '删除',
        '删除 Redis 键？',
        'danger',
    );
}

// redisDeleteByPrefixConfirm 前缀批量删除：Type-to-Confirm（输入完整前缀才可确认，§5.4）
function redisDeleteByPrefixConfirm(deps, entry, db, prefix) {
    const panel = document.createElement('div');
    panel.className = 'db-preview db-redis-confirm';
    const head = document.createElement('div');
    head.className = 'db-preview-head';
    head.textContent = '批量删除键（Type-to-Confirm）';
    const body = document.createElement('div');
    body.className = 'db-preview-body db-redis-confirm-body';
    const msg = document.createElement('p');
    msg.textContent = '将扫描并删除前缀「' + prefix + '*」下的全部键（SCAN + UNLINK），不可撤销。输入 ' + prefix + ' 以确认：';
    const wordInput = createInput({value: '', placeholder: '输入 ' + prefix + ' 确认'});
    const foot = document.createElement('div');
    foot.className = 'db-preview-foot';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'db-btn';
    cancelBtn.textContent = '取消';
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'db-btn danger';
    delBtn.textContent = '删除';
    delBtn.disabled = true;
    foot.append(cancelBtn, delBtn);
    panel.append(head, body, foot);
    body.append(msg, wordInput.element);
    const syncBtn = () => {
        delBtn.disabled = wordInput.control.value !== prefix;
    };
    wordInput.control.addEventListener('input', syncBtn);
    wordInput.control.focus();

    const mask = document.createElement('div');
    mask.className = 'db-preview-mask';
    mask.appendChild(panel);
    let handle = null;
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        mask.remove();
        panel.remove();
    };
    const close = () => {
        if (cleaned) return;
        if (handle) handle.dispose();
        cleanup();
    };
    handle = overlayStack.open({
        id: 'db-redis-delete-prefix',
        kind: 'dialog',
        el: panel,
        underEl: mask,
        onClose: () => {
            if (handle) handle.dispose();
            cleanup();
        },
    });
    document.body.appendChild(mask);
    mask.addEventListener('click', (ev) => {
        if (ev.target === mask) close();
    });
    cancelBtn.addEventListener('click', close);
    delBtn.addEventListener('click', async () => {
        if (delBtn.disabled) return;
        close();
        try {
            const snap = getSessionState(entry.id);
            if (!snap || !snap.info) throw new Error('会话已断开');
            const out = await deps.backend.DBRedisDeleteByPrefix(snap.info.id, db, prefix);
            deps.flash('已删除前缀 ' + prefix + '* 下 ' + (out && out.deleted || 0) + ' 个键');
            if (deps.logActivity) deps.logActivity('db.redis.deletePrefix', entry.name, {kind: 'redis', prefix, deleted: out && out.deleted || 0});
            tree.resetEntry(entry.id);
            renderSidebar();
        } catch (e) {
            deps.flash('批量删除失败：' + (e && e.message || e), true);
        }
    });
}

// ---------- 插件驱动（cadt.registerDbDriver）添加 / 编辑 ----------

function newEntryId() {
    return 'wsdb-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
}

// 插件驱动的动态连接表单：字段由驱动声明（fields），密文字段存 dpapi 凭据库。
// existing = 编辑已有条目；返回 Promise<void>（保存成功后自刷新）。
function openPluginEntryDialog(driver, existing) {
    return new Promise((resolve) => {
        const values = Object.assign({}, (existing && existing.config) || {});
        const panel = document.createElement('div');
        panel.className = 'db-preview db-conn-dialog db-plugin-entry';
        const head = document.createElement('div');
        head.className = 'db-preview-head';
        head.textContent = (existing ? '编辑连接' : '新建连接') + ' · ' + driver.label;
        // 来源单独一行小字：标题行保持短，插件身份仍然可见
        const sub = document.createElement('div');
        sub.className = 'db-conn-sub';
        sub.textContent = '插件驱动 · ' + driver.pluginName;
        head.appendChild(sub);
        const form = document.createElement('div');
        form.className = 'db-conn-form';
        const nameInput = createInput({
            value: existing ? existing.name : driver.label,
            placeholder: driver.label,
        });
        formRow(form, '名称', nameInput.element);
        const inputs = {};
        for (const field of driver.fields) {
            const isSecret = field.secret && existing; // 编辑时密文留空 = 保持不变
            const input = createInput({
                type: field.type === 'number' ? 'number' : field.type === 'password' ? 'password' : 'text',
                value: field.type === 'password' ? '' : String(values[field.key] != null ? values[field.key] : field.default || ''),
                placeholder: isSecret ? '已保存（留空保持不变）' : (field.default ? String(field.default) : ''),
            });
            if (field.type === 'password') input.control.autocomplete = 'new-password';
            inputs[field.key] = input;
            formRow(form, field.label + (field.secret ? '（加密存储）' : '') + (field.required ? ' *' : ''), input.element);
            // 字段级说明（驱动用 hint 声明）：解释语义，避免「库名填什么」这类猜测
            if (field.hint) {
                const hint = document.createElement('div');
                hint.className = 'db-conn-hint';
                hint.textContent = field.hint;
                form.appendChild(hint);
            }
        }
        const foot = document.createElement('div');
        foot.className = 'db-preview-foot';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'db-btn';
        cancelBtn.textContent = '取消';
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'db-btn primary';
        saveBtn.textContent = '保存';
        foot.append(cancelBtn, saveBtn);
        const msgEl = document.createElement('div');
        msgEl.className = 'db-ds-msg';
        const setMsg = (text, kind) => {
            msgEl.textContent = String(text || '');
            msgEl.className = 'db-ds-msg' + (kind ? ' ' + kind : '');
        };
        panel.append(head, form, msgEl, foot);

        // 遮罩弹层（overlayStack 注册）。close() 必须自己做 DOM 清理——dispose() 不触发
        // onClose，只 dispose 会把 mask 留在 DOM（与 db-connections.js 同款修复）
        const mask = document.createElement('div');
        mask.className = 'db-preview-mask';
        mask.appendChild(panel);
        let handle = null;
        let settled = false;
        const settle = () => {
            if (!settled) {
                settled = true;
                resolve();
            }
        };
        let cleaned = false;
        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            mask.remove();
            panel.remove();
            settle();
        };
        const close = () => {
            if (cleaned) return;
            if (handle) handle.dispose();
            cleanup();
        };
        handle = overlayStack.open({
            id: 'db-plugin-entry',
            kind: 'dialog',
            el: panel,
            underEl: mask,
            onClose: () => {
                // Esc 路径：先出栈再清 DOM（dispose 不触发 onClose，无递归）
                if (handle) handle.dispose();
                cleanup();
            },
        });
        document.body.appendChild(mask);
        // 刻意不绑「点遮罩关闭」：连接表单是长表单（地址/账号/口令/库名），误触遮罩会丢已填内容。
        // 关闭只走「取消」与 Esc（Esc 由 overlayStack 统一分发到 onClose）。
        cancelBtn.addEventListener('click', () => {
            settle();
            close();
        });
        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled = true;
            // required 校验跳过密文字段：编辑时留空 = 保持不变（与占位文案一致）
            const missing = driver.fields.find((f) => f.required && !f.secret && !String(inputs[f.key].control.value).trim());
            if (missing) {
                saveBtn.disabled = false;
                setMsg('必填项不能为空：' + missing.label, 'error');
                return;
            }
            const badNum = driver.fields.find((f) => f.type === 'number'
                && String(inputs[f.key].control.value).trim() !== ''
                && Number.isNaN(Number(inputs[f.key].control.value)));
            if (badNum) {
                saveBtn.disabled = false;
                setMsg('数字字段格式不对：' + badNum.label, 'error');
                return;
            }
            const config = {};
            for (const field of driver.fields) {
                if (field.secret) continue; // 密文走凭据库，不进清单
                const v = inputs[field.key].control.value;
                config[field.key] = field.type === 'number' ? (Number(v) || 0) : v;
            }
            const entryId = existing ? existing.id : newEntryId();
            try {
                const secretValues = {};
                for (const field of driver.fields) {
                    if (field.secret) secretValues[field.key] = inputs[field.key].control.value;
                }
                await savePluginSecrets(deps.backend, entryId, driver, secretValues);
            } catch (e) {
                saveBtn.disabled = false;
                setMsg('密文保存失败：' + (e && e.message || e), 'error');
                return;
            }
            const name = nameInput.control.value.trim() || driver.label;
            if (existing) {
                updateEntry(entryId, {name, config});
            } else {
                addEntry({
                    id: entryId,
                    workspace: currentWorkspace(),
                    kind: driver.kind,
                    name,
                    config,
                    addedAt: Date.now(),
                });
            }
            close(); // cleanup 会 settle
            renderSidebar();
        });
        nameInput.control.focus();
    });
}

// 新建连接入口：单个按钮 + 弹出菜单选类型（窄宽度不撑横滚条）。
// 插件驱动：单个直接列一项，多个收进子菜单；菜单最底部另给「插件市场」直达入口
// （没有驱动时就是安装途径，已有驱动时是「找更多驱动」）。
function openCreateMenu(anchorRect) {
    const items = [
        {label: '新建 SQLite 数据库…', icon: 'plus', action: () => addSqliteNew()},
        {label: 'SQLite 库文件…', icon: 'file', action: () => addSqlite()},
        {label: 'MySQL / MariaDB 连接…', icon: 'globe', action: () => addMysql()},
        {label: 'Redis 连接…', icon: 'database', action: () => addRedis()},
    ];
    const drivers = getPluginDbDrivers();
    if (drivers.length === 1) {
        items.push({
            label: '插件驱动：' + drivers[0].label,
            icon: 'puzzle',
            action: () => openPluginEntryDialog(drivers[0], null).then(() => renderSidebar()),
        });
    } else if (drivers.length > 1) {
        items.push({
            label: '插件驱动',
            icon: 'puzzle',
            submenu: drivers.map((d) => ({
                label: d.label,
                icon: 'puzzle',
                action: () => openPluginEntryDialog(d, null).then(() => renderSidebar()),
            })),
        });
    }
    // 直达设置 → 插件 → 插件市场，并预填 dataset 关键词（数据库驱动都在这个关键词下）。
    // openSettings 的第二参数是插件市场搜索预设，见 settings-ui.js 的 openSettings。
    items.push({sep: true});
    items.push({
        label: '插件市场：数据库驱动…',
        icon: 'download',
        action: () => deps.openSettings('plugins', 'dataset'),
    });
    deps.ctxMenu.open(items, anchorRect.left, anchorRect.bottom + 2);
}

// ---------- 行菜单 ----------

// 行菜单（JetBrains 对齐）：浏览入口已移到树节点（双击表开标签页），这里只留连接级操作。
function rowMenu(entry, anchorRect) {
    const snap = getSessionState(entry.id);
    const items = [];
    items.push({
        label: '打开查询控制台',
        icon: 'terminal',
        action: () => deps.openDbConsoleTab(entry),
    });
    if (snap && (snap.status === 'connected' || snap.status === 'connecting')) {
        items.push({
            label: '断开连接',
            icon: 'close',
            action: () => {
                tree.resetEntry(entry.id);
                disconnectSession(entry.id);
            },
        });
    }
    if (entry.kind === 'sqlite') {
        items.push({sep: true});
        items.push({
            label: entry.allowEdit ? '允许编辑 ✓（点击关闭）' : '允许编辑（点击开启，断开重连后生效）',
            icon: entry.allowEdit ? 'check' : 'unlock',
            action: () => {
                updateEntry(entry.id, {allowEdit: !entry.allowEdit});
                deps.flash(entry.allowEdit ? '已关闭允许编辑，断开重连后生效' : '已开启允许编辑，断开重连后生效');
                renderSidebar();
            },
        });
    }
    if (entry.kind === 'mysql' || entry.kind === 'mariadb' || entry.kind === 'redis') {
        items.push({sep: true});
        items.push({
            label: '测试连接',
            icon: 'zap',
            action: async () => {
                const cfg = (await globalConnections()).find((c) => c.id === entry.connectionId);
                if (!cfg) {
                    deps.flash('连接配置不存在（可能已被删除）', true);
                    return;
                }
                try {
                    const version = await deps.backend.DBTestConnection(cfg, '');
                    deps.flash('连接正常：' + version);
                } catch (e) {
                    deps.flash('测试失败：' + (e && e.message || e), true);
                }
            },
        });
        items.push({
            label: '属性…（连接管理）',
            icon: 'gear',
            action: async () => {
                await openConnectionsManager(dsDeps(), {initialSelectId: entry.connectionId});
                renderSidebar();
            },
        });
        items.push({
            label: '删除连接…（全局，含凭据）',
            icon: 'trash',
            action: () => {
                (async () => {
                    const cfg = (await globalConnections()).find((c) => c.id === entry.connectionId);
                    if (!cfg) return;
                    confirmDeleteConnection(deps, cfg, () => {
                        // 全局删除：所有引用它的条目一并移除，会话与树缓存一并清
                        disconnectSession(entry.id);
                        tree.resetEntry(entry.id);
                        getSettings()[REGISTRY_KEY] = listAll().filter((e) => e.connectionId !== cfg.id);
                        persist();
                        renderSidebar();
                    });
                })();
            },
        });
    }
    if (isPluginDbKind(entry.kind)) {
        items.push({sep: true});
        items.push({
            label: '测试连接（连接即测）',
            icon: 'zap',
            action: async () => {
                const driver = pluginDbDriverOf(entry.kind);
                if (!driver) {
                    deps.flash('驱动未注册（插件已禁用或卸载）', true);
                    return;
                }
                try {
                    const opened = await openPluginSession(deps.backend, entry, driver);
                    await opened.api.DBClose();
                    deps.flash('连接正常：' + driver.label);
                } catch (e) {
                    deps.flash('测试失败：' + (e && e.message || e), true);
                }
            },
        });
        items.push({
            label: '编辑连接…',
            icon: 'gear',
            action: async () => {
                const driver = pluginDbDriverOf(entry.kind);
                if (!driver) {
                    deps.flash('驱动未注册（插件已禁用或卸载）', true);
                    return;
                }
                await openPluginEntryDialog(driver, entry);
                renderSidebar();
            },
        });
    }
    items.push({sep: true});
    items.push({
        label: '从工作区移除',
        icon: 'close',
        action: () => {
            disconnectSession(entry.id);
            tree.resetEntry(entry.id);
            removeEntry(entry.id);
            deps.flash('已从工作区移除：' + entry.name + (entry.kind === 'mysql' ? '（连接配置保留，可重新添加）' : ''));
            renderSidebar();
        },
    });
    deps.ctxMenu.open(items, anchorRect.left, anchorRect.bottom + 2);
}

// ---------- 面板渲染 ----------

// 会话树：清单渲染（含类型分组折叠）、连接生命周期展示、双击表开标签页都归它
const tree = createDbSessionTree({
    get backend() { return deps.backend; },
    getEntries: () => listForWorkspace(),
    openTable: (entry, db, obj) => deps.openDbTableTab(entry, db, obj),
    openRedisKey: (entry, db, key) => deps.openDbRedisKeyTab(entry, db, key),
    onEntryMenu: (entry, rect) => rowMenu(entry, rect),
    get logActivity() { return deps.logActivity; },
    get ctxMenu() { return deps.ctxMenu; },
    openConsole: (entry) => deps.openDbConsoleTab(entry),
    get copyText() { return deps.copyText; },
    deleteKeyConfirm: (entry, db, key) => redisDeleteKeyConfirm(deps, entry, db, key),
    deleteByPrefixConfirm: (entry, db, prefix) => redisDeleteByPrefixConfirm(deps, entry, db, prefix),
});

// 外部拖放落点（shell/file-drop-router.js 分派进来）：SQLite 库文件 → 只读加入并展开；
// 连接配置文件 → Go 侧导入后挂进工作区并展开。清单读写与 id 生成留在本文件，db-drop 只管顺序与提示。
const dropHandler = createDbDropHandler({
    isEnabled: () => !!getSettings().dbToolsEnabled,
    baseNameOf: basenameOf,
    findSqliteEntry,
    addSqliteEntry: (path) => addSqliteEntry(path, {allowEdit: false}),
    removeEntry: (id) => {
        removeEntry(id);
        renderSidebar();
    },
    ensureConnectionEntry,
    expandEntry: (entry) => tree.expandEntry(entry),
    importConnections: (path) => deps.backend.DBImportConnections(path),
    flash: (message, isError) => deps.flash(message, isError),
});

function renderGate(host) {
    const wrap = document.createElement('div');
    wrap.className = 'db-gate db-gate-side';
    const title = document.createElement('div');
    title.className = 'db-gate-title';
    title.textContent = '数据库工具未启用';
    const desc = document.createElement('div');
    desc.className = 'db-gate-desc';
    desc.textContent = '启用后可把 SQLite 库文件与 MySQL 连接添加进当前工作区，双击在标签页打开浏览。默认只读；写入需显式开启并逐次确认。';
    const row = document.createElement('label');
    row.className = 'db-gate-switch';
    const sw = createSwitch({checked: false});
    const swLabel = document.createElement('span');
    swLabel.textContent = '启用数据库工具';
    row.append(swLabel, sw.element);
    sw.control.addEventListener('change', () => {
        getSettings().dbToolsEnabled = sw.control.checked;
        persist();
        renderSidebar();
    });
    wrap.append(title, desc, row);
    host.appendChild(wrap);
}

function renderSidebar() {
    const host = document.getElementById('database-nav');
    if (!host) return;
    host.textContent = '';
    if (!getSettings().dbToolsEnabled) {
        renderGate(host);
        return;
    }
    const actions = document.createElement('div');
    actions.className = 'db-left-actions db-side-actions';
    // 单一入口 + 弹出菜单选类型：窄宽度下不撑横滚条（三个并列按钮会被裁掉）
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'db-btn primary';
    addBtn.innerHTML = iconSvg('plus', 11) + '<span>新建连接</span>';
    addBtn.addEventListener('click', () => {
        const rect = addBtn.getBoundingClientRect();
        openCreateMenu({left: rect.left, bottom: rect.bottom});
    });
    actions.append(addBtn);
    host.appendChild(actions);

    // 清单 + 会话树（分组折叠/连接状态/库/表/服务器对象）由树组件接管
    host.appendChild(tree.el);
    tree.render();
}

return {
    renderSidebar,
    /** 外部拖放处理器（main.js 经 shell/file-drop-router.js 调用：handle(paths)） */
    dropHandler,
    handleDropPaths: (paths) => dropHandler.handle(paths),
    /** 暴露给右键测试 / 后续入口复用 */
    openDbTableTab: (entry, db, obj) => deps.openDbTableTab(entry, db, obj),
};
}
