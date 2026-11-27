// db-connections.js：MySQL 连接管理对话框——对齐 JetBrains「数据源和驱动程序」形态。
//
// 左列表（全部全局连接 + 工作区徽标，+ 新建 / − 删除）| 右表单（名称自动建议 user@host:port、
// 主机端口并排、URL 预览、允许编辑开关、加入当前工作区开关）| 底部 测试连接 / 取消 / 应用 / 确定。
// 「应用」= 保存草稿并刷新列表不关窗；「确定」= 应用 + 关窗；连接配置存全局
// （Go db-connections.json），工作区引用由 deps.syncWorkspaceRef 同步（db-ui.js 提供）。
// 密码 DPAPI 加密、不回显、不进配置 JSON；表单走 core/form-controls.js，弹层走 overlay-stack。
//
// JetBrains 对照：名称自动建议（@localhost / user@localhost）↔ nameTouched 前自动跟随主机端口；
// 「项目数据源」↔「加入当前工作区」开关；URL 自动生成 ↔ 只读预览（不支持 URL 驱动表单，够用）。

import {iconSvg} from '../core/icons.js';
import {createInput, createNumber, createSelect, createSwitch} from '../core/form-controls.js';
import {overlayStack} from '../core/overlay-stack.js';

// openMaskDialog：通用模态骨架——遮罩 + overlayStack 注册。
// 关键：overlay-stack 的 dispose() **不触发 onClose**（onClose 只在 Esc 路径走），所以 DOM
// 清理必须由骨架自己的 close()/onClose 两条路径收口，否则取消/遮罩点击会把 mask 留在 DOM
// （失去内联 z-index 后按绘制顺序盖住侧栏等非定位区）。
// onClosed 在所有关闭路径（Esc / 遮罩点击 / 按钮 close()）上恰好触发一次，调用方用它
// resolve 外层 Promise，否则 await 悬挂（闭包泄漏 + 刷新丢失）。
function openMaskDialog(id, panel, onClosed) {
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
        if (onClosed) onClosed();
    };
    handle = overlayStack.open({
        id,
        kind: 'dialog',
        el: panel,
        underEl: mask,
        onClose: () => {
            // Esc 路径：先出栈（dispose 不触发 onClose，无递归），再清 DOM + onClosed
            if (handle) handle.dispose();
            cleanup();
        },
    });
    document.body.appendChild(mask);
    const close = () => {
        if (cleaned) return;
        if (handle) handle.dispose();
        cleanup();
    };
    mask.addEventListener('click', (ev) => {
        if (ev.target === mask) close();
    });
    return {mask, panel, close};
}

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

function suggestedName(draft) {
    const host = draft.host || 'localhost';
    return (draft.user ? draft.user + '@' : '') + host + ':' + (draft.port || 3306);
}

function draftEquals(a, b) {
    const strip = (d) => JSON.stringify({
        name: d.name, host: d.host, port: d.port, database: d.database,
        user: d.user, allowEdit: d.allowEdit,
    });
    return strip(a) === strip(b);
}

/**
 * 连接管理对话框（JetBrains「数据源和驱动程序」对齐版）。
 * @param {object} deps {backend, flash, syncWorkspaceRef(id, inWorkspace, name), workspaceFolder()}
 * @param {object} [opts] {initialSelectId}: 打开时选中的连接（侧栏「编辑连接…」直达）
 * @returns {Promise<void>} 关闭即完成（工作区引用已在应用时同步）
 */
export function openConnectionsManager(deps, opts = {}) {
    return new Promise((resolve) => {
        let connections = [];
        let selectedId = opts.initialSelectId || '';
        let draft = null;        // 当前选中连接的可编辑副本（含 id；新建草稿 id 为 ''）
        let nameTouched = true;  // 选中已有连接时保持已存名称；新建草稿为 false 让名称自动跟随

        const panel = document.createElement('div');
        panel.className = 'db-preview db-ds-dialog';

        const head = document.createElement('div');
        head.className = 'db-preview-head';
        head.textContent = '数据库连接管理';

        const body = document.createElement('div');
        body.className = 'db-ds-body';

        // ---- 左列：工具栏 + 连接清单 ----
        const left = document.createElement('div');
        left.className = 'db-ds-left';
        const toolbar = document.createElement('div');
        toolbar.className = 'db-ds-toolbar';
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'db-btn';
        addBtn.innerHTML = iconSvg('plus', 12);
        addBtn.title = '新建连接';
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'db-btn';
        delBtn.innerHTML = iconSvg('trash', 12);
        delBtn.title = '删除选中连接（全局，含凭据）';
        toolbar.append(addBtn, delBtn);
        const listEl = document.createElement('div');
        listEl.className = 'db-ds-list';
        left.append(toolbar, listEl);

        // ---- 右列：表单（空清单时显示引导态，不给对话框塌高） ----
        const right = document.createElement('div');
        right.className = 'db-ds-right';
        const rightEmpty = document.createElement('div');
        rightEmpty.className = 'db-ds-right-empty';
        rightEmpty.textContent = '还没有连接。点左上角 + 新建一个，或选中左侧连接进行编辑。';
        const form = document.createElement('div');
        form.className = 'db-conn-form db-ds-form';
        const nameInput = createInput({value: '', placeholder: suggestedName({host: 'localhost', port: 3306})});
        // 驱动：MySQL 与 MariaDB 协议兼容（同一引擎，kind 恒 mysql）；Redis 是独立 kind
        const protocolSelect = createSelect({
            options: [
                {value: 'mysql', label: 'MySQL', selected: true},
                {value: 'mariadb', label: 'MariaDB'},
                {value: 'redis', label: 'Redis'},
            ],
        });
        const hostInput = createInput({value: '', placeholder: '主机（IP 或域名）'});
        const portInput = createNumber({value: 3306, min: 1, max: 65535});
        const userInput = createInput({value: '', placeholder: '用户名'});
        const passInput = createInput({type: 'password', value: '', placeholder: '密码'});
        passInput.control.autocomplete = 'new-password';
        const dbInput = createInput({value: '', placeholder: '默认库（可留空，连接后也可在对象树切换）'});
        if (typeof deps.enhanceSelect === 'function') deps.enhanceSelect(protocolSelect.element);
        const editSwitch = createSwitch({checked: false});
        const wsSwitch = createSwitch({checked: false});
        const urlLine = document.createElement('div');
        urlLine.className = 'db-ds-url';
        formRow(form, '名称', nameInput.element);
        const driverRow = formRow(form, '驱动（同一引擎，分组标签不同）', protocolSelect.element);
        const hostPortRow = document.createElement('div');
        hostPortRow.className = 'db-conn-rowline';
        const hostLabel = document.createElement('span');
        hostLabel.className = 'db-conn-label';
        hostLabel.textContent = '主机';
        const hostWrap = document.createElement('span');
        hostWrap.className = 'db-ds-hostport';
        const portLabel = document.createElement('span');
        portLabel.className = 'db-conn-label db-ds-port-label';
        portLabel.textContent = '端口';
        hostWrap.append(hostInput.element, portLabel, portInput.element);
        hostPortRow.append(hostLabel, hostWrap);
        form.appendChild(hostPortRow);
        const userRow = formRow(form, '用户', userInput.element);
        formRow(form, '密码', passInput.element);
        const dbRow = formRow(form, '数据库', dbInput.element);
        formRow(form, '允许编辑（写操作仍需提交预览确认）', editSwitch.element);
        formRow(form, '加入当前工作区（侧栏双击打开）', wsSwitch.element);
        form.appendChild(urlLine);
        right.appendChild(form);
        right.append(rightEmpty, form);
        body.append(left, right);

        // ---- 底部：测试 / 取消 / 应用 / 确定 ----
        const foot = document.createElement('div');
        foot.className = 'db-preview-foot db-ds-foot';
        const testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'db-btn';
        testBtn.textContent = '测试连接';
        const driverLabel = document.createElement('span');
        driverLabel.className = 'db-ds-driver';
        driverLabel.textContent = 'MySQL';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'db-btn';
        cancelBtn.textContent = '取消';
        const applyBtn = document.createElement('button');
        applyBtn.type = 'button';
        applyBtn.className = 'db-btn';
        applyBtn.textContent = '应用';
        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'db-btn primary';
        okBtn.textContent = '确定';
        foot.append(testBtn, driverLabel, cancelBtn, applyBtn, okBtn);
        const msgEl = document.createElement('div');
        msgEl.className = 'db-ds-msg';
        function setMsg(text, kind) {
            msgEl.textContent = String(text || '');
            msgEl.className = 'db-ds-msg' + (kind ? ' ' + kind : '');
        }
        panel.append(head, body, msgEl, foot);

        // settled：所有关闭路径（Esc/遮罩/取消/确定）都要 resolve，否则 await 悬挂
        let settled = false;
        const settle = () => {
            if (!settled) {
                settled = true;
                resolve();
            }
        };
        const {close} = openMaskDialog('db-connections-manager', panel, settle);

        // ---------- 数据与渲染 ----------

        async function reload(selected) {
            connections = await deps.backend.DBListConnections() || [];
            if (selected !== undefined) selectedId = selected;
            if (!selectedId) selectedId = opts.initialSelectId && connections.some((c) => c.id === opts.initialSelectId)
                ? opts.initialSelectId
                : (connections[0] ? connections[0].id : '');
            const refs = deps.listWorkspaceRefs();
            renderList(refs);
            select(selectedId, refs);
        }

        function renderList(refs) {
            const wsSet = new Set(refs.map((r) => r.connectionId));
            listEl.textContent = '';
            if (!connections.length) {
                const hint = document.createElement('div');
                hint.className = 'db-tree-hint';
                hint.textContent = '还没有连接。点上方 + 新建。';
                listEl.appendChild(hint);
                return;
            }
            for (const cfg of connections) {
                const row = document.createElement('div');
                row.className = 'db-ds-row' + (cfg.id === selectedId ? ' active' : '');
                const main = document.createElement('div');
                main.className = 'db-ds-row-main';
                const name = document.createElement('div');
                name.className = 'db-conn-name';
                name.textContent = cfg.name;
                const sub = document.createElement('div');
                sub.className = 'db-conn-sub';
                sub.textContent = cfg.host + ':' + cfg.port + (cfg.database ? '/' + cfg.database : '');
                main.append(name, sub);
                row.appendChild(main);
                if (wsSet.has(cfg.id)) {
                    const badge = document.createElement('span');
                    badge.className = 'db-tree-badge';
                    badge.textContent = '工作区';
                    row.appendChild(badge);
                }
                row.addEventListener('click', () => select(cfg.id));
                listEl.appendChild(row);
            }
        }

        function select(id, refsArg) {
            const refs = refsArg || deps.listWorkspaceRefs();
            const wsSet = new Set(refs.map((r) => r.connectionId));
            if (draft && !draft.id && !draftEquals(draft, blankDraft())) {
                deps.flash('未保存的新建草稿已丢弃');
            }
            selectedId = id;
            const cfg = connections.find((c) => c.id === id);
            if (!cfg) {
                draft = null;
                renderList(refs);
                renderForm();
                return;
            }
            draft = Object.assign({}, cfg);
            nameTouched = true;
            wsSwitch.control.checked = wsSet.has(id);
            // 驱动标签跟随连接 kind 与工作区引用条目（mysql | mariadb | redis）
            const ref = refs.find((r) => r.connectionId === id);
            protocolSelect.control.value = draft.kind === 'redis' || (ref && ref.kind === 'redis')
                ? 'redis'
                : (ref && ref.kind === 'mariadb' ? 'mariadb' : 'mysql');
            renderList(refs);
            renderForm();
        }

        function blankDraft() {
            return {id: '', kind: 'mysql', name: '', host: '', port: 3306, database: '', user: '', allowEdit: false};
        }

        function newDraft() {
            selectedId = '';
            draft = blankDraft();
            nameTouched = false; // 名称自动跟随 user@host:port（JetBrains 的 @localhost 习惯）
            protocolSelect.control.value = 'mysql';
            renderList(deps.listWorkspaceRefs());
            renderForm();
            nameInput.control.focus();
        }

        // ---------- 驱动分支（MySQL/MariaDB 同引擎；Redis 独立 kind） ----------

        const rowLabel = (row) => row.firstChild; // formRow 的标签 span
        const defaultPort = (p) => (p === 'redis' ? 6379 : 3306);

        // applyProtocolUI 按当前驱动切换标签/占位文案与端口默认值（3306 ↔ 6379 跟随）
        function applyProtocolUI(p) {
            const isRedis = p === 'redis';
            rowLabel(userRow).textContent = isRedis ? '用户名（可选，Redis 6+ ACL）' : '用户';
            rowLabel(dbRow).textContent = isRedis ? '数据库编号' : '数据库';
            dbInput.control.placeholder = isRedis ? '0–15（留空 = db0）' : '默认库（可留空，连接后也可在对象树切换）';
            rowLabel(driverRow).textContent = isRedis ? '驱动（Redis 独立会话）' : '驱动（同一引擎，分组标签不同）';
            driverLabel.textContent = isRedis ? 'Redis' : 'MySQL';
            const cur = Number(portInput.control.value) || 0;
            if (cur === 0 || cur === 3306 || cur === 6379) {
                portInput.control.value = defaultPort(p);
            }
            updateUrl();
        }
        protocolSelect.control.addEventListener('change', () => applyProtocolUI(protocolSelect.control.value));

        function renderForm() {
            const empty = !draft;
            form.classList.toggle('hidden', empty);
            rightEmpty.hidden = !empty;
            driverLabel.hidden = empty;
            testBtn.disabled = empty;
            applyBtn.disabled = empty;
            okBtn.disabled = empty;
            delBtn.disabled = !selectedId;
            if (empty) {
                urlLine.textContent = '';
                return;
            }
            nameInput.control.value = draft.name;
            hostInput.control.value = draft.host;
            portInput.control.value = draft.port || defaultPort(protocolSelect.control.value);
            userInput.control.value = draft.user || '';
            dbInput.control.value = draft.database || '';
            passInput.control.value = '';
            passInput.control.placeholder = draft.id ? '已保存（留空保持不变）' : '密码';
            editSwitch.control.checked = !!draft.allowEdit;
            applyProtocolUI(protocolSelect.control.value);
        }

        function collectDraft() {
            const p = protocolSelect.control.value;
            return {
                id: draft.id || '',
                name: nameInput.control.value.trim(),
                kind: p === 'redis' ? 'redis' : 'mysql',
                host: hostInput.control.value.trim(),
                port: Number(portInput.control.value) || defaultPort(p),
                database: dbInput.control.value.trim(),
                user: userInput.control.value.trim(),
                allowEdit: editSwitch.control.checked,
                updatedAt: draft.updatedAt || 0,
            };
        }

        function updateUrl() {
            const d = collectDraft();
            const p = protocolSelect.control.value;
            urlLine.textContent = (p === 'redis' ? 'redis://' : 'mysql://')
                + (d.user ? d.user + '@' : '') + d.host + ':' + d.port
                + (d.database ? (p === 'redis' ? '/' : '/') + d.database : '');
        }

        // ---------- 动作 ----------

        async function applyDraft() {
            if (!draft) return false;
            const d = collectDraft();
            if (!d.name) d.name = suggestedName(d); // 名称留空时按建议值落盘
            try {
                const saved = await deps.backend.DBSaveConnection(d, passInput.control.value);
                let workspaceNote = '';
                try {
                    await deps.syncWorkspaceRef(saved.id, wsSwitch.control.checked, saved.name, protocolSelect.control.value);
                    workspaceNote = '（已' + (wsSwitch.control.checked ? '加入' : '移出') + '当前工作区）';
                } catch (syncErr) {
                    workspaceNote = '（加入工作区失败：' + (syncErr && syncErr.message || syncErr) + '——连接本身已保存）';
                }
                await reload(saved.id);
                setMsg('已保存：' + saved.name + workspaceNote, 'ok');
                return true;
            } catch (e) {
                setMsg('保存失败：' + (e && e.message || e), 'error');
                return false;
            }
        }

        nameInput.control.addEventListener('input', () => {
            nameTouched = true;
        });
        for (const input of [hostInput, portInput, userInput]) {
            input.control.addEventListener('input', () => {
                if (!nameTouched && draft) {
                    const d = collectDraft();
                    nameInput.control.value = suggestedName(d);
                }
                updateUrl();
            });
        }
        dbInput.control.addEventListener('input', updateUrl);

        addBtn.addEventListener('click', newDraft);
        delBtn.addEventListener('click', () => {
            const cfg = connections.find((c) => c.id === selectedId);
            if (!cfg) return;
            confirmDeleteConnection(deps, cfg, async () => {
                await deps.syncWorkspaceRef(cfg.id, false, cfg.name);
                await reload('');
            });
        });
        testBtn.addEventListener('click', async () => {
            testBtn.disabled = true;
            setMsg('测试中…', '');
            try {
                const version = await deps.backend.DBTestConnection(collectDraft(), passInput.control.value);
                setMsg('连接正常：' + version + (draft.id ? '' : '（测试通过 ≠ 已保存：点「应用」或「确定」后侧栏才能使用）'), 'ok');
            } catch (e) {
                setMsg('测试失败：' + (e && e.message || e), 'error');
            } finally {
                testBtn.disabled = false;
            }
        });
        applyBtn.addEventListener('click', () => applyDraft());
        okBtn.addEventListener('click', async () => {
            if (await applyDraft()) {
                close(); // onClose 会 settle
            }
        });
        cancelBtn.addEventListener('click', close);

        reload();
    });
}

/**
 * 删除连接确认（全局删除：配置 + 加密凭据一并清）。
 * @returns {Promise<boolean>} true = 用户确认删除且已删除
 */
export function confirmDeleteConnection(deps, cfg, onDone) {
    // 统一确认弹窗（writing-mode 的 openConfirmDialog）：与全应用的删除确认同一观感。
    // callback 式——取消即什么都不发生（不再自建 Promise，避免 Esc/取消路径悬挂）。
    deps.openConfirmDialog(
        '连接配置与保存的密码（加密凭据）一并删除；引用它的工作区清单条目同步移除；不影响数据库本身。',
        async () => {
            try {
                await deps.backend.DBDeleteConnection(cfg.id);
                deps.flash('连接已删除：' + cfg.name);
                if (onDone) onDone();
            } catch (e) {
                deps.flash('删除失败：' + (e && e.message || e), true);
            }
        },
        '删除',
        '删除连接「' + cfg.name + '」？',
        'danger',
    );
}
