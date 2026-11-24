// db-tab-views.js：数据库的独立虚拟标签页——数据表网格（每表一个）与 SQL 控制台（每会话一个）。
// 由原 db-tab.js 三栏布局演进（方案 §11.8）：侧栏会话树承接对象浏览后，双击表直接全宽开标签页。
// 会话经 db-sessions.js 共享：关标签页只关视图不断会话；会话失效/断开时面板给出重连入口。

import {iconSvg} from '../core/icons.js';
import {createTextarea} from '../core/form-controls.js';
import {createDbQueryEditor} from './db-query-editor.js';
import {createDbTablePane} from './db-table-grid.js';
import {createDbRedisKeyPane} from './db-redis-view.js';
import {kindLabel} from './db-model.js';
import {isPluginDbKind, pluginDbDriverOf} from './db-plugin.js';
import {ensureSession, getSessionState, disconnectSession, reconnectSession, subscribeSession} from './db-sessions.js';

// 会话门面通道在 build 回调内按 getSessionState 动态解析（api || deps.backend）

// 会话挂载通用壳：连接中/失败/断开三态覆盖层 + 就绪后 build(ready)
// 返回 {el, dispose}；dispose 撤订阅并拒绝后续回调（关标签页时的竞态防线）
function mountWithSession(deps, doc, build) {
    const el = document.createElement('div');
    el.className = 'db-tab-session';
    const spec = doc.dbTableSpec || doc.dbConsoleSpec || doc.dbRedisKeySpec;
    const entry = spec.entry;
    const entryId = spec.entryId;
    let disposed = false;
    let ready = false; // build 完成为 true：会话恢复（connected）时据此决定是否重建内容
    let unsub = subscribeSession(entryId, () => {
        const st = getSessionState(entryId);
        if (st && st.status === 'connected') {
            // 在别处重连成功（侧栏树/另一个标签页）：本页还停在覆盖层就跟着重建
            if (!disposed && !ready) start();
            return;
        }
        showGate(st);
    });
    let paneEl = null;

    // 会话被 Go 侧空闲回收是服务端静默行为（前端 status 仍是 connected），只有调用失败才知道。
    // 捕获方调 sessionLost()：自动重连并返回是否成功；5s 节流防「重连又失败」死循环。
    let lastLost = 0;
    function sessionLost() {
        const now = Date.now();
        if (now - lastLost < 5000) return Promise.resolve(false);
        lastLost = now;
        return reconnectSession(entry).then(() => true).catch(() => false);
    }

    // 自动重连成功后重建面板内容（build 里 init 会自动重新加载当前页）
    function sessionRecovered() {
        ready = false;
        start();
    }

    function clearGate() {
        if (paneEl) {
            paneEl.remove();
            paneEl = null;
        }
        el.textContent = '';
    }

    function showGate(st) {
        if (disposed) return;
        ready = false;
        clearGate();
        const gate = document.createElement('div');
        gate.className = 'db-tab-gate';
        const ic = document.createElement('div');
        ic.className = 'db-gate-icon';
        ic.innerHTML = iconSvg('database', 22);
        const msg = document.createElement('div');
        msg.className = 'db-gate-title';
        gate.append(ic, msg);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'db-btn primary';
        if (!st || st.status === 'closed') {
            msg.textContent = '会话未连接';
            btn.textContent = '连接';
            btn.addEventListener('click', () => start());
        } else if (st.status === 'connecting') {
            msg.textContent = '连接中…';
            btn.remove();
        } else if (st.status === 'error') {
            msg.textContent = '连接失败：' + st.error;
            btn.textContent = '重试连接';
            btn.addEventListener('click', () => start());
        } else {
            msg.textContent = '会话已断开';
            btn.textContent = '重新连接';
            btn.addEventListener('click', () => start());
        }
        if (btn.parentNode) gate.appendChild(btn);
        el.appendChild(gate);
        paneEl = gate;
    }

    async function start() {
        if (disposed) return;
        clearGate();
        const gate = document.createElement('div');
        gate.className = 'db-tab-gate';
        gate.innerHTML = '<div class="db-gate-title">连接中…</div>';
        el.appendChild(gate);
        paneEl = gate;
        try {
            const readyResult = await ensureSession(entry);
            if (disposed) return;
            clearGate();
            ready = true;
            paneEl = build(readyResult, {sessionLost, sessionRecovered}); // 就绪内容
            el.appendChild(paneEl);
        } catch (e) {
            if (disposed) return;
            showGate(getSessionState(entryId));
        }
    }

    start();

    return {
        el,
        dispose() {
            disposed = true;
            unsub();
        },
    };
}

// 插件驱动声明的自定义视图（graph / 画布 / 时间线…）：数据表标签页顶部多一排切换。
// 与 cadt.registerViewer 的差别在数据来源——这里给的是「库 + 表 + 只读查询出口」而不是文件文本：
//   ctx.query(cypher, limit) 走会话门面（插件会话 = 插件门面，内置会话 = 宿主绑定），
//   受连接只读与行数上限约束，写语句由驱动侧自行拦截。
// mount 返回 {resize?, setTheme?, destroy}；容器变化 / 主题切换由本宿主转达。
// consoleSpec（可选）在该栏之上再给一条自由查询输入框，两档视图共用。
function createDbTableViewsHost(deps, t, session, paneEl, views, consoleSpec) {
    const root = document.createElement('div');
    root.className = 'db-tab-views';
    const bar = document.createElement('div');
    bar.className = 'db-tab-views-bar';
    const body = document.createElement('div');
    body.className = 'db-tab-views-body';
    root.append(bar, body);

    const tablePane = document.createElement('div');
    tablePane.className = 'db-tab-view-pane';
    tablePane.appendChild(paneEl);
    body.appendChild(tablePane);

    const api = () => (getSessionState(t.entryId) ? (getSessionState(t.entryId).api || deps.backend) : deps.backend);
    const currentTheme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

    let active = 'table';
    let mounted = null; // {wrap, handle}
    const buttons = new Map();

    async function runQuery(sql, limit) {
        const text = String(sql == null ? '' : sql).trim();
        if (!text) throw new Error('查询语句为空');
        const queryId = 'view-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        const out = await api().DBQuery(session.id, queryId, text, false, Number(limit) || 500);
        if (!out || out.status !== 'ok') throw new Error((out && out.message) || '查询未执行');
        return out.result || {columns: [], rows: []};
    }

    // 查询框专用：把 confirm（写语句 / 缺 WHERE）当作一种结果返回，交给界面弹「确认执行」，
    // 而不是当错误抛掉——否则用户永远无法用输入框做写操作。
    async function execQuery(sql, limit, confirmed) {
        const text = String(sql == null ? '' : sql).trim();
        if (!text) throw new Error('查询语句为空');
        const queryId = 'qbar-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        const out = await api().DBQuery(session.id, queryId, text, !!confirmed, Number(limit) || 500);
        if (!out) throw new Error('查询未执行');
        if (out.status === 'ok') {
            return {kind: 'ok', result: out.result || {columns: [], rows: []}, writes: Number(out.writes) || 0};
        }
        if (out.status === 'confirm') {
            return {kind: 'confirm', message: out.message || '该语句需要确认后执行', confirm: out.confirm || 'danger'};
        }
        throw new Error(out.message || '查询未执行');
    }

    // 查询输入框：Enter / Ctrl+Enter 执行（Shift+Enter 换行），结果就地展开成表格。
    // 与图视图共用同一条 query 通道，插件不需要为它额外实现执行逻辑。
    function createQueryBar(spec) {
        const wrap = document.createElement('div');
        wrap.className = 'db-tab-query';
        const head = document.createElement('div');
        head.className = 'db-tab-query-head';
        const tag = document.createElement('span');
        tag.className = 'db-tab-query-tag';
        tag.textContent = spec.label;
        const inputWrap = createTextarea({
            rows: 1,
            placeholder: spec.placeholder || '',
            className: 'db-tab-query-input',
            spellcheck: false,
        });
        const input = inputWrap.control;
        const runBtn = document.createElement('button');
        runBtn.type = 'button';
        runBtn.className = 'db-btn db-tab-query-run';
        runBtn.textContent = '执行';
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'db-btn db-tab-query-clear hidden';
        clearBtn.textContent = '收起结果';
        head.append(tag, inputWrap.element, runBtn, clearBtn);
        wrap.appendChild(head);

        const out = document.createElement('div');
        out.className = 'db-tab-query-out';
        out.style.display = 'none';
        wrap.appendChild(out);

        let running = false;

        function setStatus(text, isError) {
            out.textContent = '';
            out.style.display = 'block';
            const line = document.createElement('div');
            line.className = 'db-tab-query-status' + (isError ? ' error' : '');
            line.textContent = text;
            out.appendChild(line);
            clearBtn.classList.remove('hidden');
        }

        function renderResult(result, elapsedHint) {
            const cols = result.columns || [];
            const rows = result.rows || [];
            out.textContent = '';
            out.style.display = 'block';
            clearBtn.classList.remove('hidden');
            const status = document.createElement('div');
            status.className = 'db-tab-query-status';
            const cn = cols.length ? ' · ' + cols.length + ' 列' : '';
            const el = result.elapsedMs != null ? ' · ' + result.elapsedMs + ' ms' : (elapsedHint || '');
            status.textContent = '返回 ' + rows.length + ' 行' + cn + el + (result.truncated ? '（已截断，可加 LIMIT 精确定位）' : '');
            out.appendChild(status);
            if (!cols.length) return;
            const scroll = document.createElement('div');
            scroll.className = 'db-tab-query-tablewrap';
            const table = document.createElement('table');
            table.className = 'db-tab-query-table';
            const thead = document.createElement('thead');
            const htr = document.createElement('tr');
            for (const c of cols) {
                const th = document.createElement('th');
                th.textContent = c;
                htr.appendChild(th);
            }
            thead.appendChild(htr);
            const tbody = document.createElement('tbody');
            for (const row of rows) {
                const tr = document.createElement('tr');
                for (let i = 0; i < cols.length; i++) {
                    const td = document.createElement('td');
                    const value = row ? row[i] : '';
                    td.textContent = value == null ? '' : String(value);
                    td.title = td.textContent;
                    tr.appendChild(td);
                }
                tbody.appendChild(tr);
            }
            table.append(thead, tbody);
            scroll.appendChild(table);
            out.appendChild(scroll);
        }

        async function run() {
            if (running) return;
            const sql = input.value.trim();
            if (!sql) {
                input.focus();
                return;
            }
            running = true;
            runBtn.disabled = true;
            setStatus('执行中…', false);
            try {
                const outcome = await execQuery(sql, spec.limit, false);
                if (outcome.kind === 'confirm') {
                    showConfirm(outcome, sql);
                    return;
                }
                renderResult(outcome.result);
                if (outcome.writes) {
                    const note = document.createElement('div');
                    note.className = 'db-tab-query-status';
                    note.textContent = '已执行 ' + outcome.writes + ' 条写语句';
                    out.insertBefore(note, out.firstChild);
                }
            } catch (e) {
                setStatus(String((e && e.message) || e), true);
            } finally {
                running = false;
                runBtn.disabled = false;
            }
        }

        // 写语句两阶段确认：这里显式再问一次，确认后带 confirmed 重发
        function showConfirm(outcome, sql) {
            out.textContent = '';
            out.style.display = 'block';
            clearBtn.classList.remove('hidden');
            const line = document.createElement('div');
            line.className = 'db-tab-query-status error';
            line.textContent = outcome.message;
            const actions = document.createElement('div');
            actions.className = 'db-tab-query-status';
            const okBtn = document.createElement('button');
            okBtn.type = 'button';
            okBtn.className = 'db-btn danger';
            okBtn.textContent = '确认执行';
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'db-btn';
            cancelBtn.textContent = '取消';
            cancelBtn.addEventListener('click', () => {
                out.style.display = 'none';
                out.textContent = '';
                clearBtn.classList.add('hidden');
            });
            okBtn.addEventListener('click', async () => {
                okBtn.disabled = true;
                setStatus('执行中…', false);
                try {
                    const res = await execQuery(sql, spec.limit, true);
                    if (res.kind === 'confirm') {
                        showConfirm(res, sql);
                        return;
                    }
                    renderResult(res.result);
                    if (deps.logActivity) {
                        deps.logActivity('db.query.write', t.table, {via: 'query-bar', writes: res.writes || 0});
                    }
                } catch (e) {
                    setStatus(String((e && e.message) || e), true);
                } finally {
                    okBtn.disabled = false;
                }
            });
            actions.append(okBtn, cancelBtn);
            out.append(line, actions);
        }

        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' && !ev.shiftKey) {
                ev.preventDefault();
                run();
            } else if (ev.key === 'Escape') {
                if (out.style.display !== 'none') {
                    out.style.display = 'none';
                    clearBtn.classList.add('hidden');
                } else {
                    input.blur();
                }
            }
        });
        // 单行自动长高，最多 5 行
        input.addEventListener('input', () => {
            input.style.height = 'auto';
            const lineHeight = 18;
            input.style.height = Math.min(5 * lineHeight, input.scrollHeight) + 'px';
        });
        runBtn.addEventListener('click', run);
        clearBtn.addEventListener('click', () => {
            out.style.display = 'none';
            out.textContent = '';
            clearBtn.classList.add('hidden');
        });

        return wrap;
    }

    function makeCtx() {
        return {
            database: t.db,
            table: t.table,
            kind: t.kind,
            getTheme: currentTheme,
            query: (sql, limit) => runQuery(sql, limit),
            flash: (msg, isError) => {
                if (deps.flash) deps.flash(String(msg == null ? '' : msg), !!isError);
            },
            logActivity: (action, target, meta) => {
                if (deps.logActivity) deps.logActivity(action, target, meta);
            },
        };
    }

    function syncButtons() {
        for (const [id, btn] of buttons) {
            btn.classList.toggle('active', id === active);
        }
    }

    function destroyMounted() {
        if (!mounted) return;
        const {wrap, handle} = mounted;
        mounted = null;
        try {
            if (handle && typeof handle.destroy === 'function') handle.destroy();
        } catch (_) {
            // 插件视图的清理异常不该拖垮标签页（泄漏由插件负责，已记文档）
        }
        wrap.remove();
    }

    function showTable() {
        if (active === 'table') return;
        destroyMounted();
        // 用内联 display 而不是 .hidden 类：本文件的 .db-tab-view-pane 也声明了 display:flex，
        // 同特异性且写在 .hidden 之后会把它覆盖掉，表格就藏不住了（曾经的真事故）
        tablePane.style.display = '';
        active = 'table';
        syncButtons();
    }

    function showView(view) {
        if (active === view.id) return;
        destroyMounted();
        tablePane.style.display = 'none';
        const wrap = document.createElement('div');
        wrap.className = 'db-plugin-view';
        body.appendChild(wrap);
        let handle = null;
        try {
            handle = view.mount(wrap, makeCtx());
        } catch (e) {
            wrap.remove();
            tablePane.style.display = '';
            active = 'table';
            syncButtons();
            if (deps.flash) deps.flash('「' + view.label + '」视图加载失败：' + (e && e.message || e), true);
            return;
        }
        mounted = {wrap, handle: handle || {}};
        active = view.id;
        syncButtons();
    }

    function addButton(id, label, onClick) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'db-btn db-tab-view-btn';
        btn.textContent = label;
        btn.dataset.view = id;
        btn.addEventListener('click', onClick);
        bar.appendChild(btn);
        buttons.set(id, btn);
        return btn;
    }

    bar.appendChild(Object.assign(document.createElement('span'), {
        className: 'db-tab-views-label',
        textContent: '视图',
    }));
    addButton('table', '表格', showTable);
    for (const view of views) {
        addButton(view.id, view.label, () => showView(view));
    }
    syncButtons();

    // 查询输入框放在视图栏之上：表格与图两档共用，随时能跑一条临时查询
    let queryBar = null;
    if (consoleSpec) {
        queryBar = createQueryBar(consoleSpec);
        root.insertBefore(queryBar, bar);
    }

    // 容器尺寸变化（分栏拖拽 / 窗口缩放）与主题切换：转达给已挂载的视图，不重挂
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => {
            if (mounted && mounted.handle && typeof mounted.handle.resize === 'function') {
                try {
                    mounted.handle.resize();
                } catch (_) {}
            }
        });
        ro.observe(body);
    }
    let themeObs = null;
    if (typeof MutationObserver !== 'undefined') {
        themeObs = new MutationObserver(() => {
            if (mounted && mounted.handle && typeof mounted.handle.setTheme === 'function') {
                try {
                    mounted.handle.setTheme(currentTheme());
                } catch (_) {}
            }
        });
        themeObs.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
    }

    return {
        el: root,
        destroy() {
            destroyMounted();
            if (ro) ro.disconnect();
            if (themeObs) themeObs.disconnect();
        },
    };
}

// 数据表标签页：一个表 = 一个标签页（全宽网格）；插件驱动声明了自定义视图时多一排切换
export function createDbTableTabView(deps, doc) {
    const t = doc.dbTableSpec; // {entryId, entry, db, table, kind}
    let host = null;
    const view = mountWithSession(deps, doc, (ready, hooks) => {
        // 会话恢复会重新 build：先拆掉上一轮的视图宿主（观察器要断干净）
        if (host) {
            try {
                host.destroy();
            } catch (_) {}
            host = null;
        }
        const session = ready.info;
        const pane = createDbTablePane(
            {
                get backend() { return getSessionState(t.entryId) ? (getSessionState(t.entryId).api || deps.backend) : deps.backend; },
                flash: deps.flash,
                settings: deps.settings,
                logActivity: deps.logActivity,
                get enhanceSelect() { return deps.enhanceSelect; },
                get ctxMenu() { return deps.ctxMenu; },
                get copyText() { return deps.copyText; },
                get sessionLost() { return hooks.sessionLost; },
                get sessionRecovered() { return hooks.sessionRecovered; },
            },
            session, t.db, t.table);
        const driver = isPluginDbKind(t.entry.kind) ? pluginDbDriverOf(t.entry.kind) : null;
        const views = driver && Array.isArray(driver.views) ? driver.views : [];
        const consoleSpec = driver && driver.console ? driver.console : null;
        // 没有自定义视图也没有查询框：保持原来的纯网格标签页，不多包一层 DOM
        if (!views.length && !consoleSpec) return pane.el;
        host = createDbTableViewsHost(deps, t, session, pane.el, views, consoleSpec);
        return host.el;
    });
    // 统一卸载契约：bridge 的 doc.tabUnmount 会调 doc.dbTabUnmount（dispose 撤会话订阅）
    doc.dbTabUnmount = () => {
        if (host) {
            try {
                host.destroy();
            } catch (_) {}
            host = null;
        }
        view.dispose();
    };
    return view.el;
}

// Redis 键查看器标签页（方案 §11.13）：每个键一个；内容由 db-redis-view.js 提供
export function createDbRedisKeyTabView(deps, doc) {
    const t = doc.dbRedisKeySpec; // {entryId, entry, db, key}
    const view = mountWithSession(deps, doc, (ready, hooks) => {
        const session = ready.info;
        const pane = createDbRedisKeyPane(
            {
                get backend() { return getSessionState(t.entryId) ? (getSessionState(t.entryId).api || deps.backend) : deps.backend; },
                flash: deps.flash,
                get logActivity() { return deps.logActivity; },
                get enhanceSelect() { return deps.enhanceSelect; },
                get ctxMenu() { return deps.ctxMenu; },
                get copyText() { return deps.copyText; },
                get openConfirmDialog() { return deps.openConfirmDialog; },
                get overlayStack() { return deps.overlayStack; },
                get sessionLost() { return hooks.sessionLost; },
                get sessionRecovered() { return hooks.sessionRecovered; },
                get onKeyDeleted() { return deps.onRedisKeyDeleted; },
            },
            session, t.db, t.key);
        return pane.el;
    });
    doc.dbTabUnmount = () => view.dispose();
    return view.el;
}

// 查询控制台标签页：每个会话一个（头部显示会话信息 + 断开按钮）
export function createDbConsoleTabView(deps, doc) {
    const c = doc.dbConsoleSpec; // {entryId, entry, title}
    const root = document.createElement('div');
    root.className = 'db-console-view';
    const head = document.createElement('div');
    head.className = 'db-console-head';
    const headIc = document.createElement('span');
    headIc.innerHTML = iconSvg('terminal', 13);
    const headName = document.createElement('span');
    headName.className = 'db-console-name';
    const headMeta = document.createElement('span');
    headMeta.className = 'db-console-meta';
    const disconnectBtn = document.createElement('button');
    disconnectBtn.type = 'button';
    disconnectBtn.className = 'db-btn';
    disconnectBtn.innerHTML = iconSvg('close', 11) + '<span>断开连接</span>';
    disconnectBtn.addEventListener('click', () => {
        disconnectSession(c.entryId);
    });
    head.append(headIc, headName, headMeta, disconnectBtn);
    root.appendChild(head);

    const body = document.createElement('div');
    body.className = 'db-console-body';
    root.appendChild(body);

    const view = mountWithSession(deps, doc, (ready, hooks) => {
        const session = ready.info;
        headName.textContent = session.name || '数据库';
        headMeta.textContent = kindLabel(session.kind) + (session.server ? ' · ' + session.server : '') +
            (session.editable ? ' · 可编辑' : ' · 只读');
        const query = createDbQueryEditor({
            get backend() { return getSessionState(c.entryId) ? (getSessionState(c.entryId).api || deps.backend) : deps.backend; },
            flash: deps.flash,
            logActivity: deps.logActivity,
            settings: deps.settings,
            get enhanceSelect() { return deps.enhanceSelect; },
            get sessionLost() { return hooks.sessionLost; },
            get sessionRecovered() { return hooks.sessionRecovered; },
        });
        query.setSession(session);
        return query.el;
    });

    body.appendChild(view.el);
    doc.dbTabUnmount = () => view.dispose();

    return root;
}
