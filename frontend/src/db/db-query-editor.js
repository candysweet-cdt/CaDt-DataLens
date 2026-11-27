// db-query-editor.js：SQL 控制台——输入 + 执行/取消 + 确认横幅 + 结果表。
// 会话绑定由 db-page.js 切换（查询随连接会话走，不另开标签页，方案 §5.1 决策 2）。
// 危险/缺 WHERE 语句走两阶段确认：Status=confirm 时出横幅，确认后带 confirmed=true 重发。

import {iconSvg} from '../core/icons.js';
import {createTextarea, createSelect} from '../core/form-controls.js';
import {createDbGrid} from './db-grid-core.js';
import {formatElapsed, confirmReasonLabel, DB_ROW_DEFAULT, DB_ROW_MAX} from './db-model.js';
import {isSessionMissing} from './db-sessions.js';
import {normalizeCompletionSettings, isAceCompletionCapable, enableAceCompletion} from '../core/completion.js';
import {createSqlCompletion} from './db-completion.js';

export function createDbQueryEditor(deps) {

const el = document.createElement('div');
el.className = 'db-query';

let session = null;
let runningQueryID = 0; // 自增查询号：取消与两阶段确认都对准这一次
let lastSQL = '';   // 被确认横幅锁定的语句：确认执行只跑这条（编辑输入框即失效）

// placeholderText 按会话方言切换提示（Redis：每行一条命令）
function placeholderText(kind) {
    return kind === 'redis'
        ? 'GET key …（Ctrl+Enter 执行；每行一条命令，写命令需开启「允许编辑」）'
        : 'SELECT … （Ctrl+Enter 执行；多条语句逐条分类，任一条非只读即整批拒）';
}

// 工具行：执行 / 取消 / 行数上限
const toolbar = document.createElement('div');
toolbar.className = 'db-query-toolbar';
const runBtn = document.createElement('button');
runBtn.type = 'button';
runBtn.className = 'db-btn primary';
runBtn.innerHTML = iconSvg('play', 12) + '<span>执行</span>';
runBtn.dataset.tip = '执行（Ctrl+Enter）';
const cancelBtn = document.createElement('button');
cancelBtn.type = 'button';
cancelBtn.className = 'db-btn';
cancelBtn.textContent = '取消';
cancelBtn.hidden = true;
const limitSel = createSelect({
    options: [
        {value: '100', label: '100 行'},
        {value: String(DB_ROW_DEFAULT), label: DB_ROW_DEFAULT + ' 行', selected: true},
        {value: '2000', label: '2000 行'},
        {value: String(DB_ROW_MAX), label: DB_ROW_MAX + ' 行'},
    ],
    title: '结果行数上限',
});
// 走设置页同款浮层增强（原生 select 仍是值真源）；db-limit-select 只管宽度
if (typeof deps.enhanceSelect === 'function') deps.enhanceSelect(limitSel.element);
limitSel.element.classList.add('db-limit-select');
toolbar.append(runBtn, cancelBtn, limitSel.element);

// 确认横幅（两阶段确认）
const confirmBar = document.createElement('div');
confirmBar.className = 'db-query-confirm hidden';
const confirmMsg = document.createElement('span');
confirmMsg.className = 'db-query-confirm-msg';
const confirmOk = document.createElement('button');
confirmOk.type = 'button';
confirmOk.className = 'db-btn danger';
confirmOk.textContent = '确认执行';
const confirmNo = document.createElement('button');
confirmNo.type = 'button';
confirmNo.className = 'db-btn';
confirmNo.textContent = '放弃';
confirmBar.append(confirmMsg, confirmOk, confirmNo);

// SQL 输入：Ace（mode-sql 语法高亮 + 补全，方案 §5 路线 A）。window.ace 由 jsoneditor.min.js
// 挂全局，探针确认带 .edit 与 ext/language_tools；能力探测失败静默退回裸 textarea（功能等价，
// 仅无高亮补全——方案 §5.1 的既定降级）。编辑器内部浮层不进 overlay-stack（弹层规范豁免）。
const sqlAceWrap = document.createElement('div');
sqlAceWrap.className = 'db-sql-ace-wrap';
const sqlAceEl = document.createElement('div');
sqlAceEl.className = 'db-sql-ace';
sqlAceWrap.appendChild(sqlAceEl);
let sqlEditor = null; // Ace 实例（可用时）
let sqlResizeObserver = null; // 容器尺寸观察器：dispose 时必须 disconnect
let sqlInput = null;  // textarea 兜底（Ace 不可用时）
let sqlCompletion = null;

function getSqlText() {
    if (sqlEditor) return sqlEditor.getValue();
    if (sqlInput) return sqlInput.control.value;
    return '';
}

try {
    const ace = window.ace;
    if (ace && typeof ace.edit === 'function') {
        sqlEditor = ace.edit(sqlAceEl);
        sqlEditor.setOptions({showPrintMargin: false, useSoftTabs: true, tabSize: 2});
        try { sqlEditor.setFontSize((deps.settings && deps.settings.editorFont) || 15); } catch (e) {}
        sqlEditor.session.setMode('ace/mode/sql');
        try { sqlEditor.setOption('placeholder', placeholderText(null)); } catch (e) {}
        // 容器脱离/进入 DOM、三栏尺寸变化都要 resize（Ace 只监听 window resize 不够）。
        // 实例必须存下来：不 disconnect 的话浏览器会一直持有 wrap → 闭包 → 编辑器，
        // 断线重连重建时旧实例全部滞留。
        try {
            if (typeof ResizeObserver === 'function') {
                sqlResizeObserver = new ResizeObserver(() => { try { sqlEditor.resize(); } catch (e) {} });
                sqlResizeObserver.observe(sqlAceWrap);
            }
        } catch (e) {}
        // 执行键位：Ctrl/Cmd+Enter（原 textarea keydown 的等价物）
        sqlEditor.commands.addCommand({
            name: 'cadtSqlRun',
            bindKey: 'Ctrl-Enter|Command-Enter',
            exec: () => run(false),
        });
        // 横幅弹出后改动输入框 = 被锁定的语句作废，横幅收起（原 textarea input 事件的等价物）
        sqlEditor.session.on('change', () => {
            if (!confirmBar.classList.contains('hidden')) hideConfirm();
        });
        // 补全：方言关键词 + 库/表/视图 + 列（点号/别名上下文）；Alt-/ 备用触发键
        // （Ctrl+Space 被 Windows 中文输入法占成中英切换）
        const comp = normalizeCompletionSettings(deps.settings);
        if (comp.sql && isAceCompletionCapable(ace)) {
            sqlCompletion = createSqlCompletion({backend: deps.backend, getSession: () => session});
            enableAceCompletion(sqlEditor, [sqlCompletion.completer], comp.live);
            try {
                sqlEditor.commands.addCommand({
                    name: 'cadtSqlAltSlash',
                    bindKey: 'Alt-/',
                    exec: () => sqlEditor.execCommand('startAutocomplete'),
                });
            } catch (e) {}
        }
    }
} catch (e) {
    // 尽力而为：Ace 起不来就退回 textarea，不打断控制台可用性
    sqlEditor = null;
}
if (!sqlEditor) {
    sqlInput = createTextarea({
        rows: 5,
        placeholder: placeholderText(null),
        spellcheck: false,
    });
    sqlInput.control.addEventListener('keydown', (ev) => {
        if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
            ev.preventDefault();
            run(false);
        }
    });
    sqlInput.control.addEventListener('input', () => {
        if (!confirmBar.classList.contains('hidden')) hideConfirm();
    });
}

// 状态条 + 结果（JetBrains 对齐：多语句 = 「输出」摘要 + 每条 SELECT 一个结果 tab，grid 共享切换重放）
const status = document.createElement('div');
status.className = 'db-query-status';
const rtabs = document.createElement('div');
rtabs.className = 'db-query-rtabs hidden';
const outputView = document.createElement('div');
outputView.className = 'db-query-output hidden';
const resultGrid = createDbGrid({rowNumberLabel: true});
const empty = document.createElement('div');
empty.className = 'db-query-empty';
empty.textContent = '连接会话的查询结果在这里显示；选中对象树里的表也可直接浏览数据。';

let curResults = []; // 本次的逐条结果（{sql, result, wrote}；mock 无 results 时兜底单条）
let curTab = 'output'; // 当前结果 tab（'output' 或 'r<idx>'）

el.append(toolbar, confirmBar, sqlEditor ? sqlAceWrap : sqlInput.element, status, rtabs, outputView, resultGrid.el, empty);

function renderTabs() {
    rtabs.textContent = '';
    if (!curResults.length) {
        rtabs.classList.add('hidden');
        outputView.classList.add('hidden');
        return;
    }
    rtabs.classList.remove('hidden');
    const mk = (id, label, count) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'db-query-rtab' + (curTab === id ? ' active' : '');
        b.textContent = label + (count ? '（' + count + '）' : '');
        b.addEventListener('click', () => showTab(id));
        return b;
    };
    rtabs.appendChild(mk('output', '输出'));
    let n = 0;
    curResults.forEach((r, i) => {
        if (!(r.result.columns || []).length) return;
        n++;
        rtabs.appendChild(mk('r' + i, '#' + (i + 1) + ' ' + short(i, r.sql), r.result.rows ? r.result.rows.length : 0));
    });
    function short(idx, s) {
        const t = String(s || '').replace(/\s+/g, ' ').trim();
        return t.length > 18 ? t.slice(0, 18) + '…' : t || ('语句 ' + (idx + 1));
    }
}

function showTab(id) {
    curTab = id;
    renderTabs();
    const isOut = id === 'output';
    outputView.classList.toggle('hidden', !isOut);
    resultGrid.el.classList.toggle('hidden', isOut);
    if (!isOut) {
        const r = curResults[Number(id.slice(1))];
        if (r) {
            resultGrid.setColumns(r.result.columns || []);
            resultGrid.setRows(r.result.rows || [], r.result.nulls || [], 0);
        }
    }
}

function renderOutput() {
    outputView.textContent = '';
    for (let i = 0; i < curResults.length; i++) {
        const r = curResults[i];
        const line = document.createElement('div');
        line.className = 'db-query-output-line';
        const tag = document.createElement('span');
        tag.className = 'db-query-output-idx';
        tag.textContent = '#' + (i + 1);
        const sql = document.createElement('code');
        sql.className = 'db-query-output-sql';
        sql.textContent = r.sql || '';
        const meta = document.createElement('span');
        meta.className = 'db-query-output-meta';
        const cols = (r.result.columns || []).length;
        meta.textContent = r.wrote ? (r.result.message || '已执行') : cols ? ((r.result.rows || []).length + ' 行') : (r.result.message || '已执行');
        line.append(tag, sql, meta);
        outputView.appendChild(line);
    }
    const total = document.createElement('div');
    total.className = 'db-query-output-total';
    total.textContent = '共 ' + curResults.length + ' 条语句 · ' + formatElapsed((curResults[curResults.length - 1] || {}).result ? curResults[curResults.length - 1].result.elapsedMs : 0);
    outputView.appendChild(total);
}

function setSession(s) {
    session = s;
    lastSQL = '';
    if (sqlCompletion) sqlCompletion.reset(); // 换会话 = 补全元数据缓存整体作废
    const ph = placeholderText(s && s.kind);
    if (sqlEditor) {
        try { sqlEditor.setOption('placeholder', ph); } catch (e) {}
    }
    if (sqlInput) {
        sqlInput.control.placeholder = ph;
    }
    confirmBar.classList.add('hidden');
    curResults = [];
    renderTabs();
    status.textContent = s ? '' : '没有活动连接';
}

function setRunning(running) {
    runBtn.disabled = running;
    cancelBtn.hidden = !running;
}

function showConfirm(reason, message) {
    confirmMsg.textContent = '【' + confirmReasonLabel(reason) + '】' + (message || '');
    confirmBar.classList.remove('hidden');
}

function hideConfirm() {
    lastSQL = ''; // 横幅失效 = 锁定的语句作废（用户改了输入框或主动放弃）
    confirmBar.classList.add('hidden');
}

async function run(forceConfirm) {
    if (!session) {
        deps.flash('没有活动连接', true);
        return;
    }
    if (runBtn.disabled) return; // Ctrl+Enter 不受 disabled 按钮保护，这里显式防重入
    // 两阶段确认锁语句：确认横幅弹出后用户改了输入框，确认执行的必须是**被拦截的那条**，
    // 不能让新语句带着 confirmed=true 直通后端
    const sql = (forceConfirm && lastSQL) ? lastSQL : getSqlText().trim();
    if (!sql) return;
    hideConfirm();
    lastSQL = sql;
    const queryID = 'q' + (++runningQueryID);
    const myRun = runningQueryID;
    setRunning(true);
    status.textContent = '执行中…';
    try {
        const outcome = await deps.backend.DBQuery(session.id, queryID, sql, !!forceConfirm, Number(limitSel.control.value) || 500);
        if (myRun !== runningQueryID) return; // 已有更新的执行出发：旧结果整体丢弃
        if (outcome && outcome.status === 'confirm') {
            showConfirm(outcome.confirm, outcome.message);
            status.textContent = '已拦截，等待确认';
            return;
        }
        const r = (outcome && outcome.result) || {};
        // 逐条结果（Go Results；mock/旧后端无 results 时兜底单条），「输出」+ 各 SELECT 结果 tab
        curResults = (outcome && outcome.results && outcome.results.length)
            ? outcome.results
            : [{sql: sql.length > 80 ? sql.slice(0, 80) + '…' : sql, result: r, wrote: !!(outcome && outcome.writes)}];
        curTab = 'output';
        renderOutput();
        showTab('output');
        empty.hidden = curResults.some((x) => (x.result.columns || []).length > 0) || !!(r.message);
        const parts = [];
        if (outcome && outcome.statements) parts.push(outcome.statements + ' 条语句');
        if (r.rows && r.rows.length) parts.push(r.rows.length + ' 行' + (r.truncated ? '（截断）' : ''));
        if (r.message) parts.push(r.message);
        parts.push(formatElapsed(r.elapsedMs));
        // partial：批量里前面的语句已生效、后面的失败。结果照常展示，
        // 但状态行必须点明「部分执行」，否则用户会以为整批都成功了。
        if (outcome && outcome.status === 'partial') {
            status.textContent = '部分执行 · ' + (outcome.message || '有语句失败');
        } else {
            status.textContent = parts.join(' · ');
        }
        // 写语句留痕：连接/库/类型摘要，不含参数值（方案 §5.3）
        if (outcome && outcome.writes > 0 && deps.logActivity) {
            deps.logActivity('db.exec', sessionLabel(session), {kind: session.kind, writes: outcome.writes, statements: outcome.statements});
        }
        // 补全缓存失效：写语句 / DDL 后让对象与列清单下次重拉（DDL 让下次 DBDescribe 带 noCache）
        if (sqlCompletion) sqlCompletion.noteQueryOutcome(outcome, sql);
    } catch (e) {
        if (myRun !== runningQueryID) return;
        // 会话被空闲回收：自动重连，成功后重建控制台（session 换新，用户重跑即可）
        if (isSessionMissing(e) && typeof deps.sessionLost === 'function') {
            const ok = await deps.sessionLost();
            if (ok) {
                if (typeof deps.sessionRecovered === 'function') deps.sessionRecovered();
                return;
            }
        }
        status.textContent = '';
        resultGrid.setColumns([]);
        resultGrid.setRows([], [], 0);
        curResults = [];
        renderTabs();
        outputView.classList.add('hidden');
        resultGrid.el.classList.remove('hidden');
        empty.hidden = false;
        empty.textContent = String(e && e.message || e);
        deps.flash('SQL 执行失败：' + (e && e.message || e), true);
    } finally {
        if (myRun === runningQueryID) setRunning(false);
    }
}

function sessionLabel(s) {
    return s ? (s.kind + ':' + s.name + (s.server ? '@' + s.server : '')) : '';
}

runBtn.addEventListener('click', () => run(false));
cancelBtn.addEventListener('click', () => {
    if (!session) return;
    deps.backend.DBCancel(session.id, 'q' + runningQueryID).catch(() => {});
});
confirmOk.addEventListener('click', () => run(true));
confirmNo.addEventListener('click', hideConfirm);

// dispose 解绑编辑器侧资源（ResizeObserver / Ace 实例）。
// 卸载链 db-tab-views 会在 tabUnmount 时调用。
function dispose() {
    if (sqlResizeObserver) {
        try { sqlResizeObserver.disconnect(); } catch (e) {}
        sqlResizeObserver = null;
    }
    if (sqlEditor) {
        try { sqlEditor.destroy(); } catch (e) {}
        sqlEditor = null;
    }
}

return {el, setSession, refresh: () => resultGrid.refresh(), dispose};
}
