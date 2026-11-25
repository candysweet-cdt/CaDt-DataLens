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

        // 竞态防线：每次执行自增 token，响应回来时 token 不匹配就丢弃（与 db-query-editor.js
        // 的 myRun !== runningQueryID 同一思路）。直发与「确认执行」两条路径共用同一个 token。
        let querySeq = 0;
        let destroyed = false;
        // 待确认的写语句：输入内容一变就作废，避免「横幅显示旧语句、用户改完点确认跑的是旧的」
        let pending = null;

        function hideOut() {
            out.style.display = 'none';
            out.textContent = '';
            clearBtn.classList.add('hidden');
        }

        function setStatus(text, isError) {
            out.textContent = '';
            out.style.display = 'block';
            const line = document.createElement('div');
            line.className = 'db-tab-query-status' + (isError ? ' error' : '');
            line.textContent = text;
            out.appendChild(line);
            clearBtn.classList.remove('hidden');
        }

        // elapsedMs 是内置后端的字段，插件驱动不保证返回——本地计时兜底
        function elapsedOf(result, started) {
            if (result && result.elapsedMs != null) return result.elapsedMs;
            return Math.max(0, Date.now() - started);
        }

        function renderResult(result, started) {
            const cols = result.columns || [];
            const rows = result.rows || [];
            out.textContent = '';
            out.style.display = 'block';
            clearBtn.classList.remove('hidden');
            const status = document.createElement('div');
            status.className = 'db-tab-query-status';
            const cn = cols.length ? ' · ' + cols.length + ' 列' : '';
            status.textContent = '返回 ' + rows.length + ' 行' + cn + ' · ' + elapsedOf(result, started) + ' ms'
                + (result.truncated ? '（已截断，可加 LIMIT 精确定位）' : '');
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

        // 写操作的两条路径（直发 / 确认）共用同一收尾：都插 note、都记 db.exec
        // （既有约定是 db.exec，见 db-query-editor.js 与 db-create-table.js）
        function renderWithWrites(outcome, started) {
            renderResult(outcome.result, started);
            const writes = Number(outcome.writes) || 0;
            if (!writes) return;
            const note = document.createElement('div');
            note.className = 'db-tab-query-status';
            note.textContent = '已执行 ' + writes + ' 条写语句';
            out.insertBefore(note, out.firstChild);
            if (deps.logActivity) deps.logActivity('db.exec', t.table, {via: 'query-bar', writes});
        }

        function confirmLabel(outcome) {
            return outcome.confirm === 'missingWhere' ? '缺少 WHERE 条件' : '含写操作';
        }

        // 写语句两阶段确认：这里显式再问一次，确认后带 confirmed 重发
        function showConfirm(outcome, sql, my) {
            pending = {sql, my};
            out.textContent = '';
            out.style.display = 'block';
            clearBtn.classList.remove('hidden');
            const line = document.createElement('div');
            line.className = 'db-tab-query-status error';
            line.textContent = '【' + confirmLabel(outcome) + '】' + outcome.message;
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
            const close = () => {
                pending = null;
                hideOut();
            };
            cancelBtn.addEventListener('click', close);
            okBtn.addEventListener('click', () => {
                if (!pending || pending.sql !== sql) return; // 已被输入变化作废
                pending = null;
                execute(sql, true);
            });
            actions.append(okBtn, cancelBtn);
            out.append(line, actions);
        }

        async function execute(sql, confirmed) {
            const my = ++querySeq;
            runBtn.disabled = true;
            setStatus('执行中…', false);
            const started = Date.now();
            try {
                const outcome = await execQuery(sql, spec.limit, confirmed);
                if (destroyed || my !== querySeq) return; // 过期响应：丢弃，不覆盖新结果
                if (outcome.kind === 'confirm') {
                    showConfirm(outcome, sql, my);
                    return;
                }
                renderWithWrites(outcome, started);
            } catch (e) {
                if (destroyed || my !== querySeq) return;
                setStatus(String((e && e.message) || e), true);
            } finally {
                if (!destroyed && my === querySeq) runBtn.disabled = false;
            }
        }

        function run() {
            const sql = input.value.trim();
            if (!sql) {
                input.focus();
                return;
            }
            execute(sql, false);
        }

        input.addEventListener('keydown', (ev) => {
            // 输入法组字中的 Enter 是「确认候选词」，不是执行——项目既定规范
            // （ai-composer.js / ai-panel.js 同样先做这个早退）
            if (ev.isComposing || ev.keyCode === 229) return;
            if (ev.key === 'Enter' && !ev.shiftKey) {
                ev.preventDefault();
                run();
            } else if (ev.key === 'Escape') {
                if (pending) {
                    pending = null;
                    hideOut();
                } else if (out.style.display !== 'none') {
                    hideOut();
                } else {
                    input.blur();
                }
            }
        });
        // 单行自动长高（最多 5 行）；输入内容变化即作废待确认的语句
        input.addEventListener('input', () => {
            input.style.height = 'auto';
            const lineHeight = 18;
            input.style.height = Math.min(5 * lineHeight, input.scrollHeight) + 'px';
            if (pending) {
                pending = null;
                setStatus('语句已修改，上一次的写操作确认已作废，请重新执行', false);
            }
        });
        runBtn.addEventListener('click', run);
        clearBtn.addEventListener('click', hideOut);

        // 宿主切视图 / 关标签时调用：置位后迟到的响应一律丢弃，不再写已脱离 DOM 的容器
        wrap.__destroy = () => {
            destroyed = true;
            pending = null;
            querySeq++;
        };
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
            // 查询框：置位后在途响应一律丢弃，不再写已脱离 DOM 的容器
            if (queryBar && typeof queryBar.__destroy === 'function') {
                try {
                    queryBar.__destroy();
                } catch (_) {}
            }
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
