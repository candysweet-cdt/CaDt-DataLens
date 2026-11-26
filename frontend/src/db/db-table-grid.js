// db-table-grid.js：表数据网格面板——排序/筛选/分页下推 + 受控编辑。
//
// 编辑链路（方案 §5.3）：dirty model（客户端暂存，不发 SQL）→ 预览（内联展示值 SQL，只读弹层）
// → 用户确认 → 单事务提交（Go 侧乐观并发 + 整体回滚）→ 刷新（noCache 元数据）→ 留痕。
// 行定位只认主键；无主键/视图/只读会话/全局只读锁一律不可编辑，工具栏给出原因。
// 主键列本身不可编辑（改主键 = 改行身份，不支持）。

import {iconSvg} from '../core/icons.js';
import {createInput, createSelect} from '../core/form-controls.js';
import {overlayStack} from '../core/overlay-stack.js';
import {formats} from '../core/formats.js';
import {createDbGrid} from './db-grid-core.js';
import {isSessionMissing} from './db-sessions.js';
import {
    rowKeyOf, rowKeysMap, FILTER_OPS, filterOpNeedsValue,
    rowEstimateLabel, dirtySummary, tableEditable, formatElapsed, buildDDL,
    DB_ROW_DEFAULT, DB_ROW_MAX,
} from './db-model.js';

const PAGE_SIZES = [10, 100, 250, DB_ROW_DEFAULT, 1000, DB_ROW_MAX]; // 档位；末档 = 服务端 rowMax 上限（「所有」）
const DEFAULT_PAGE_SIZE = DB_ROW_DEFAULT;
let browseRequestSeq = 0; // 模块级请求号：同一会话的多个表标签页也不得撞取消句柄

export function createDbTablePane(deps, session, db, table) {

const el = document.createElement('div');
el.className = 'db-table-pane';

let meta = null;
let columns = [];
let serverRows = [];
let serverNulls = [];
let pageOffset = 0;
let hasMore = false;
let loading = false;
let error = '';
let sortCol = '';
let sortDesc = false;
let filters = [];
let orderCols = []; // 多列排序 [{column, desc}]（结构化：列名过元数据白名单，Go 侧拼 ORDER BY）
let editMode = false;
let loaded = false;
let loadSeq = 0; // 请求序号：慢通道（插件驱动走 HTTP）下旧响应不得覆盖新状态
let activeBrowseID = ''; // 当前在飞的浏览查询；新请求/会话失效时由 DBCancel 收口
let pageSize = DEFAULT_PAGE_SIZE; // 分页档位（图7：10/100/250/500/1000/所有）
let autoRefreshMs = 0; // 自动刷新档位（0 = 禁用；编辑中或有 dirty 时自动暂停）
let autoTimer = null;

// dirty model：updates key → {keys, cells: Map(col → {old, new})}；deletes key 集合；inserts 数组
const updates = new Map();
// 删除标记：key → 标记时捕获的主键快照（rowKeysMap）——跨页后 keyIndex 不再含旧页行，
// 提交时直接用快照定位，避免翻页把已标删的行静默丢掉
const deletes = new Map();
let inserts = [];
let keyIndex = new Map(); // 行键 → serverRows 下标

const globalReadonly = () => !!(deps.settings && deps.settings.readOnlyMode);
const isEditable = () => tableEditable(meta, session.editable, globalReadonly());
const editableReason = () => {
    if (!meta) return '';
    if (meta.kind === 'view') return '视图不可编辑';
    if (!session.editable) return '连接为只读（打开连接时未开启「允许编辑」）';
    if (!(meta.pk || []).length) return '无主键表一律只读';
    if (globalReadonly()) return '编辑器全局只读锁已开启';
    return '';
};

// ---------- DOM 骨架 ----------

const toolbar = document.createElement('div');
toolbar.className = 'db-table-toolbar';
const titleWrap = document.createElement('div');
titleWrap.className = 'db-table-title';
const titleIcon = document.createElement('span');
titleIcon.className = 'db-table-ic';
titleIcon.innerHTML = iconSvg('view-table', 13);
const titleName = document.createElement('span');
titleName.className = 'db-table-name';
titleName.textContent = (db && db !== 'main' ? db + '.' : '') + table;
const titleEst = document.createElement('span');
titleEst.className = 'db-table-est';
titleWrap.append(titleIcon, titleName, titleEst);

const actions = document.createElement('div');
actions.className = 'db-table-actions';
const refreshBtn = mkBtn('refresh', '刷新');
const filterBtn = mkBtn('filter', '筛选');
const pagePrev = mkBtn('chevron-left', '上一页');
const pageNext = mkBtn('chevron-right', '下一页');
const rangeLabel = document.createElement('span');
rangeLabel.className = 'db-table-range';
// 自动刷新（图8）：icon + 档位菜单（禁用/5s/10s/30s/1m/5m），走 deps.ctxMenu 弹出
const autoBtn = mkBtn('clock', '自动');
const editBtn = mkBtn('unlock', '编辑');
const addRowBtn = mkBtn('plus', '插入行');
const dropBtn = mkBtn('undo', '放弃');
// 提交 icon（图5 语义）：无修改灰、有修改亮；点击 = 预览弹层，Ctrl+Enter = 直接提交
const submitBtn = document.createElement('button');
submitBtn.type = 'button';
submitBtn.className = 'db-btn';
submitBtn.innerHTML = iconSvg('check', 13);
submitBtn.dataset.tip = '提交（点击出预览 · Ctrl+Enter 直接提交）';
const pendingLabel = document.createElement('span');
pendingLabel.className = 'db-table-pending';
// 导入/导出（图7）：导出当前结果为 CSV/JSONL；导入 CSV/JSONL 走受控写入链路
const exportBtn = mkBtn('download', '导出');
const importBtn = mkBtn('upload', '导入');
// DDL：从元数据生成建表语句（复制 / 导出 .sql）
const ddlBtn = mkBtn('code', 'DDL');
// 编辑簇只在可编辑时由 rebuildToolbar 显隐；工具栏必须把标题与操作区真正挂进来
actions.append(refreshBtn, filterBtn, autoBtn, pagePrev, rangeLabel, pageNext,
    exportBtn, importBtn, ddlBtn, editBtn, addRowBtn, dropBtn, submitBtn, pendingLabel);
toolbar.append(titleWrap, actions);
el.append(toolbar);

// 筛选区（结构化 WHERE 条件行 + 多列 ORDER BY，全部下推为参数化 SQL）
const filterArea = document.createElement('div');
filterArea.className = 'db-table-filters hidden';
const whereLabel = document.createElement('div');
whereLabel.className = 'db-filter-label';
whereLabel.textContent = 'WHERE';
const filterList = document.createElement('div');
filterList.className = 'db-table-filter-list';
const addFilterBtn = document.createElement('button');
addFilterBtn.type = 'button';
addFilterBtn.className = 'db-btn';
addFilterBtn.innerHTML = iconSvg('plus', 11) + '<span>加条件</span>';
const orderLabel = document.createElement('div');
orderLabel.className = 'db-filter-label hidden'; // 无排序列时隐藏（加行时移除）
orderLabel.textContent = 'ORDER BY';
const orderList = document.createElement('div');
orderList.className = 'db-table-filter-list';
const addOrderBtn = document.createElement('button');
addOrderBtn.type = 'button';
addOrderBtn.className = 'db-btn';
addOrderBtn.innerHTML = iconSvg('plus', 11) + '<span>加排序列</span>';
filterArea.append(whereLabel, filterList, addFilterBtn, orderLabel, orderList, addOrderBtn);

// 网格 + 状态条
const grid = createDbGrid({
    onHeaderClick(col) {
        if (sortCol === col && !sortDesc) { sortDesc = true; }
        else if (sortCol === col) { sortCol = ''; sortDesc = false; }
        else { sortCol = col; sortDesc = false; }
        pageOffset = 0;
        loadPage();
    },
    onCellActivate(rowIdx, colIdx, cellEl) { startCellEdit(rowIdx, colIdx, cellEl); },
    onRowNumberClick(rowIdx) { toggleRowDelete(rowIdx); },
    rowClass(i) {
        if (i >= serverRows.length) return 'db-row-inserted';
        const key = rowKeyOf(meta, serverRows[i], columns);
        if (deletes.has(key)) return 'db-row-deleted';
        return updates.has(key) ? 'db-row-dirty' : ''; // 修改行：行号同色高亮（图5）
    },
    cellClass(i, c) {
        const col = columns[c];
        if (i >= serverRows.length) {
            const ins = inserts[i - serverRows.length];
            return ins && ins.edited.has(col) ? 'db-cell-dirty' : '';
        }
        const key = rowKeyOf(meta, serverRows[i], columns);
        const u = updates.get(key);
        return u && u.cells.has(col) ? 'db-cell-dirty' : '';
    },
});
const statusBar = document.createElement('div');
statusBar.className = 'db-table-status';
const statusText = document.createElement('span'); // 状态文本（与档位下拉分开，避免重建清掉增强包装层）
const gridHost = document.createElement('div');
gridHost.className = 'db-table-grid-host';
gridHost.appendChild(grid.el);
el.append(filterArea, gridHost, statusBar);

function mkBtn(icon, label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'db-btn';
    b.innerHTML = iconSvg(icon, 12) + '<span>' + label + '</span>';
    return b;
}

// ---------- 数据加载 ----------

async function loadMeta(noCache) {
    meta = await deps.backend.DBDescribe(session.id, db, table, !!noCache);
    titleEst.textContent = rowEstimateLabel(meta.rowEstimate);
    rebuildToolbar();
}

function rebuildKeyIndex() {
    keyIndex = new Map();
    serverRows.forEach((row, i) => keyIndex.set(rowKeyOf(meta, row, columns), i));
}

function cancelActiveBrowse() {
    const queryID = activeBrowseID;
    activeBrowseID = '';
    if (!queryID || typeof deps.backend.DBCancel !== 'function') return;
    Promise.resolve(deps.backend.DBCancel(session.id, queryID)).catch(() => {
        // 尽力而为：请求可能已自然结束，或会话已被回收；旧响应仍由 loadSeq 丢弃
    });
}

async function loadPage() {
    cancelActiveBrowse();
    const seq = ++loadSeq;
    const queryID = 'browse' + (++browseRequestSeq);
    activeBrowseID = queryID;
    loading = true;
    error = '';
    renderStatus();
    try {
        const res = await deps.backend.DBBrowse(session.id, {
            database: db,
            table,
            queryId: queryID,
            sortColumn: sortCol,
            sortDesc,
            filters,
            orderCols, // 多列 ORDER BY（结构化；Go 侧过元数据白名单拼接）
            offset: pageOffset,
            limit: pageSize,
        });
        if (seq !== loadSeq) return; // 已有更新的请求出发：旧响应整体丢弃
        columns = res.columns || [];
        serverRows = res.rows || [];
        serverNulls = res.nulls || [];
        hasMore = !!res.truncated;
        rebuildKeyIndex();
    } catch (e) {
        if (seq !== loadSeq) return;
        if (await recoverSession(e)) return; // 会话被空闲回收：自动重连后重建面板重新加载
        error = String(e && e.message || e);
        deps.flash('表数据加载失败：' + error, true);
    } finally {
        if (seq === loadSeq) {
            if (activeBrowseID === queryID) activeBrowseID = '';
            loading = false;
            loaded = true;
            applyToGrid();
            renderStatus();
        }
    }
}

// 会话丢失（空闲回收/手动断开后继续调用）时的懒自动重连：成功即重建面板自动重载，返回 true
async function recoverSession(e) {
    if (!isSessionMissing(e) || typeof deps.sessionLost !== 'function') return false;
    const ok = await deps.sessionLost();
    if (ok && typeof deps.sessionRecovered === 'function') {
        deps.sessionRecovered();
        return true;
    }
    return false;
}

// keepScroll：单元格编辑/删除标记等本地状态变化走 true（长页里不弹回顶部）；
// 换页/换表/换排序是新数据，走默认 false（滚回顶部）
function applyToGrid(keepScroll) {
    // 已修改单元格显示新值（JetBrains 语义：脏单元格展示待提交内容，高亮标记）
    const displayRows = serverRows.map((r) => {
        const key = rowKeyOf(meta, r, columns);
        const u = updates.get(key);
        if (!u || !u.cells || !u.cells.size) return r;
        const row = r.slice();
        for (const [col, c] of u.cells) {
            const ci = columns.indexOf(col);
            if (ci >= 0) row[ci] = c.new == null ? '' : c.new;
        }
        return row;
    }).concat(inserts.map((ins) => columns.map((c) => (ins.values[c] == null ? '' : ins.values[c]))));
    const displayNulls = serverNulls.concat(inserts.map(() => columns.map(() => false)));
    grid.setColumns(columns);
    grid.setSort(sortCol, sortDesc);
    grid.setRows(displayRows, displayNulls, pageOffset, !!keepScroll);
}

function renderStatus() {
    const parts = [];
    if (loading) parts.push('加载中…');
    if (error) parts.push('错误：' + error);
    if (!loading && loaded && !error) {
        if (!serverRows.length && !inserts.length) parts.push('无数据');
        else parts.push('第 ' + (pageOffset + 1) + '–' + (pageOffset + serverRows.length) + ' 行' + (hasMore ? '（还有更多）' : ''));
    }
    const hint = editableReason();
    if (hint) parts.push(hint);
    // 只更新文本 span，不清空整个 statusBar——两个档位下拉经 enhanceSelect 增强后，
    // 包装层（.set-select）是 select 的兄弟节点，textContent='' 会把它一起清掉。
    statusText.textContent = parts.join(' · ');
    if (!statusBar.firstChild) {
        statusBar.append(statusText, rowHeightSel.element, pageSizeSel.element);
        // 入 DOM 后增强（enhanceSelect 的 sel.after(wrap) 要求 select 已在 DOM 里）；
        // 幂等，重复挂载只会同步触发器文本。原生 select 仍是值真源，change 照常派发。
        if (typeof deps.enhanceSelect === 'function') {
            deps.enhanceSelect(rowHeightSel.control);
            deps.enhanceSelect(pageSizeSel.control);
        }
    }
}

// 行高档位（图9：紧凑/常规/宽松）——网格 setRowHeight 联动 canvas 与可视窗口
const ROW_HEIGHT_STEPS = [
    {value: '22', label: '紧凑', h: 22},
    {value: '26', label: '常规', h: 26},
    {value: '32', label: '宽松', h: 32},
];
const rowHeightSel = createSelect({
    options: ROW_HEIGHT_STEPS.map((s) => ({value: s.value, label: '行高：' + s.label, selected: s.h === 26})),
    title: '行高',
});
rowHeightSel.element.classList.add('db-limit-select');
rowHeightSel.control.addEventListener('change', () => {
    const step = ROW_HEIGHT_STEPS.find((s) => s.value === rowHeightSel.control.value);
    if (step) grid.setRowHeight(step.h);
});

// 分页档位（图7）：10/100/250/500/1000/所有（末档 = 服务端上限）/自定义
const pageSizeSel = createSelect({
    options: [
        {value: '10', label: '10 行'},
        {value: '100', label: '100 行'},
        {value: '250', label: '250 行'},
        {value: String(DB_ROW_DEFAULT), label: DB_ROW_DEFAULT + ' 行', selected: true},
        {value: '1000', label: '1000 行'},
        {value: String(DB_ROW_MAX), label: '所有（' + DB_ROW_MAX + ' 上限）'},
        {value: 'custom', label: '自定义…'},
    ],
    title: '每页行数',
});
pageSizeSel.element.addEventListener('change', () => {
    let v = pageSizeSel.control.value;
    if (v === 'custom') {
        const input = window.prompt('每页行数（10–' + DB_ROW_MAX + '）：', String(pageSize));
        if (!input) { pageSizeSel.control.value = String(pageSize); return; }
        v = String(Number(input) || 0);
        if (Number(v) < 10 || Number(v) > DB_ROW_MAX) {
            deps.flash('行数需在 10–' + DB_ROW_MAX + ' 之间', true);
            pageSizeSel.control.value = String(pageSize);
            return;
        }
        // 自定义值回填进列表首位显示
        if (!pageSizeSel.__customOpt) {
            pageSizeSel.__customOpt = new Option(v + ' 行', v);
            pageSizeSel.control.add(pageSizeSel.__customOpt, 0);
        }
        pageSizeSel.__customOpt.textContent = v + ' 行';
        pageSizeSel.__customOpt.value = v;
        pageSizeSel.control.value = v;
    }
    pageSize = Number(v) || DEFAULT_PAGE_SIZE;
    pageOffset = 0;
    loadPage();
});

function rebuildToolbar() {
    // 编辑簇只在「可编辑」时出现；不可编辑时状态条给出原因
    editBtn.hidden = !isEditable();
    editBtn.classList.toggle('primary', editMode);
    editBtn.innerHTML = iconSvg(editMode ? 'lock' : 'unlock', 12) + '<span>' + (editMode ? '退出编辑' : '编辑') + '</span>';
    addRowBtn.hidden = !editMode;
    dropBtn.hidden = !editMode;
    submitBtn.hidden = !editMode;
    importBtn.hidden = !isEditable(); // 导入走受控写入，只读会话不显示
    ddlBtn.hidden = !meta || meta.kind === 'view'; // DDL 只对表生成（视图无列元数据）
    // 提交 icon：无修改灰（disabled）、有修改亮（primary）
    const summary = dirtySummary({updates, deletes, inserts});
    submitBtn.disabled = !summary;
    submitBtn.classList.toggle('primary', !!summary);
    pendingLabel.hidden = !editMode;
    pendingLabel.textContent = summary ? ('待提交：' + summary) : '';
    pagePrev.disabled = pageOffset <= 0;
    pageNext.disabled = !hasMore;
    titleEst.textContent = rowEstimateLabel(meta && meta.rowEstimate);
}

// ---------- 交互 ----------

refreshBtn.addEventListener('click', async () => {
    try {
        await loadMeta(true);
        await loadPage();
    } catch (e) {
        if (await recoverSession(e)) return; // 空闲回收：自动重连后重建面板
        deps.flash('刷新失败：' + (e && e.message || e), true);
    }
});
filterBtn.addEventListener('click', () => {
    filterArea.classList.toggle('hidden');
    if (!filterArea.classList.contains('hidden') && !filters.length) addFilterRow();
});

// ---------- 多列 ORDER BY（结构化：列下拉 + 方向，Go 侧过白名单拼接） ----------

addOrderBtn.addEventListener('click', () => addOrderRow());

function addOrderRow(initial) {
    const cond = initial || {column: (columns || [])[0] || '', desc: false};
    orderCols.push(cond);
    const row = document.createElement('div');
    row.className = 'db-filter-cond';
    const colSel = createSelect({options: columns.map((c) => ({value: c, label: c, selected: c === cond.column}))});
    const dirSel = createSelect({options: [
        {value: 'asc', label: '升序', selected: !cond.desc},
        {value: 'desc', label: '降序', selected: !!cond.desc},
    ]});
    colSel.element.classList.add('db-filter-col');
    dirSel.element.classList.add('db-filter-op');
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'db-btn';
    rm.innerHTML = iconSvg('close', 11);
    colSel.control.addEventListener('change', () => { cond.column = colSel.control.value; loadPage(); });
    dirSel.control.addEventListener('change', () => { cond.desc = dirSel.control.value === 'desc'; loadPage(); });
    rm.addEventListener('click', () => {
        const at = orderCols.indexOf(cond);
        if (at >= 0) orderCols.splice(at, 1);
        row.remove();
        if (!orderCols.length) orderLabel.classList.add('hidden');
        loadPage();
    });
    // 先入行再增强（同 addFilterRow：sel.after(wrap) 要求 select 已在 DOM）
    row.append(colSel.element, dirSel.element, rm);
    orderList.appendChild(row);
    orderLabel.classList.remove('hidden');
    if (typeof deps.enhanceSelect === 'function') {
        deps.enhanceSelect(colSel.element);
        deps.enhanceSelect(dirSel.element);
    }
}

// ---------- 自动刷新（图8：档位菜单；编辑中/有 dirty 时自动暂停） ----------

const AUTO_REFRESH_STEPS = [
    {label: '已禁用', ms: 0},
    {label: '5 秒', ms: 5000},
    {label: '10 秒', ms: 10000},
    {label: '30 秒', ms: 30000},
    {label: '1 分钟', ms: 60000},
    {label: '5 分钟', ms: 300000},
];

autoBtn.addEventListener('click', (ev) => {
    if (!deps.ctxMenu) {
        deps.flash('当前环境不支持菜单（mock 场景）', true);
        return;
    }
    const rect = autoBtn.getBoundingClientRect();
    deps.ctxMenu.open(AUTO_REFRESH_STEPS.map((s) => ({
        label: s.label + (s.ms === autoRefreshMs ? ' ✓' : ''),
        icon: s.ms === autoRefreshMs ? 'check' : 'clock',
        action: () => setAutoRefresh(s.ms),
    })), rect.left, rect.bottom + 2);
});

function setAutoRefresh(ms, silent) {
    autoRefreshMs = ms;
    if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
    }
    if (ms > 0) {
        autoTimer = setInterval(() => {
            // 编辑中或有待提交修改时不刷新（避免覆盖用户的 dirty 状态）
            if (editMode || dirtySummary({updates, deletes, inserts})) return;
            loadPage();
        }, ms);
    }
    autoBtn.classList.toggle('active', ms > 0);
    autoBtn.innerHTML = iconSvg('clock', 12) + '<span>' + (ms > 0 ? '自动 ' + (AUTO_REFRESH_STEPS.find((s) => s.ms === ms) || {}).label.replace(' ', '') : '自动') + '</span>';
    if (!silent) deps.flash(ms > 0 ? '自动刷新已开启' : '自动刷新已关闭');
}

// ---------- 导出（当前已加载结果 → CSV / JSONL；受 5000 行上限） ----------

exportBtn.addEventListener('click', (ev) => {
    const rect = exportBtn.getBoundingClientRect();
    if (deps.ctxMenu) {
        deps.ctxMenu.open([
            {label: '导出 CSV…', icon: 'download', action: () => exportData('csv')},
            {label: '导出 JSONL…', icon: 'download', action: () => exportData('jsonl')},
        ], rect.left, rect.bottom + 2);
    } else {
        exportData('csv');
    }
});

async function exportData(kind) {
    if (!columns.length || !(serverRows.length || inserts.length)) {
        deps.flash('没有可导出的数据', true);
        return;
    }
    const ext = kind === 'jsonl' ? 'jsonl' : 'csv';
    const target = (db && db !== 'main' ? db + '.' : '') + table;
    let path = '';
    try {
        path = await deps.backend.ShowSaveFileDialog('导出数据（当前已加载的 ' + serverRows.length + ' 行）', target + '.' + ext);
    } catch (e) {
        return; // 用户取消保存对话框（尽力而为路径）
    }
    if (!path) return;
    const nullsOf = (i) => serverNulls[i] || [];
    let content = '';
    if (kind === 'jsonl') {
        const lines = [];
        for (let i = 0; i < serverRows.length; i++) {
            const obj = {};
            columns.forEach((c, ci) => { obj[c] = nullsOf(i)[ci] ? null : serverRows[i][ci]; });
            lines.push(JSON.stringify(obj));
        }
        for (const ins of inserts) {
            const obj = {};
            columns.forEach((c) => { obj[c] = ins.values[c] == null ? null : String(ins.values[c]); });
            lines.push(JSON.stringify(obj));
        }
        content = lines.join('\n') + '\n';
    } else {
        const rows = serverRows.map((r, i) => r.map((v, ci) => (nullsOf(i)[ci] ? null : v)));
        for (const ins of inserts) {
            rows.push(columns.map((c) => (ins.values[c] == null ? null : String(ins.values[c]))));
        }
        content = formats.csv.stringifyTable(columns, rows) + '\n';
    }
    try {
        await deps.backend.SaveFile(path, content, 'lf', false, 'utf-8');
        deps.flash('已导出 ' + (serverRows.length + inserts.length) + ' 行：' + path);
    } catch (e) {
        deps.flash('导出失败：' + (e && e.message || e), true);
    }
}

// ---------- 导入（CSV / JSONL → 列映射 → 走受控写入的 inserts，预览确认后单事务提交） ----------

importBtn.addEventListener('click', () => openImportDialog());

// ---------- DDL（复制 / 导出建表语句，元数据朴素还原） ----------

ddlBtn.addEventListener('click', (ev) => {
    if (!meta) return;
    const sql = buildDDL(session.kind, meta);
    if (deps.ctxMenu) {
        const rect = ddlBtn.getBoundingClientRect();
        deps.ctxMenu.open([
            {label: '复制 DDL', icon: 'copy', action: () => {
                if (deps.copyText) deps.copyText(sql);
                else deps.flash('DDL 已生成（当前环境无剪贴板）');
            }},
            {label: '导出 DDL…', icon: 'download', action: async () => {
                let path = '';
                try {
                    path = await deps.backend.ShowSaveFileDialog('导出 DDL', table + '.sql');
                } catch (e) {
                    return; // 取消保存对话框（尽力而为路径）
                }
                if (!path) return;
                try {
                    await deps.backend.SaveFile(path, sql + '\n', 'lf', false, 'utf-8');
                    deps.flash('DDL 已导出：' + path);
                } catch (e) {
                    deps.flash('导出失败：' + (e && e.message || e), true);
                }
            }},
        ], rect.left, rect.bottom + 2);
    } else if (deps.copyText) {
        deps.copyText(sql);
    }
});

async function openImportDialog() {
    if (!isEditable()) {
        deps.flash(editableReason() || '当前会话不可编辑', true);
        return;
    }
    let pick = '';
    try {
        pick = await deps.backend.ShowOpenFileDialog('导入数据（CSV / JSONL，首行为列名）',
            'CSV / JSONL (*.csv;*.jsonl)|*.csv;*.jsonl|所有文件 (*.*)|*.*');
    } catch (e) {
        return; // 用户取消文件选择（尽力而为路径）
    }
    if (!pick) return;
    let text = '';
    try {
        text = await deps.backend.DBReadImportFile(pick);
    } catch (e) {
        deps.flash('读取导入文件失败（需 UTF-8 编码）:' + (e && e.message || e), true);
        return;
    }
    let headers = [];
    let fileRows = [];
    if (/\.jsonl$/i.test(pick)) {
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            const obj = JSON.parse(line);
            for (const k of Object.keys(obj)) if (!headers.includes(k)) headers.push(k);
            fileRows.push(obj);
        }
    } else {
        const parsed = formats.csv.parseTable(text);
        headers = parsed.headers || [];
        fileRows = parsed.rows.map((r) => {
            const obj = {};
            headers.forEach((h, i) => { obj[h] = r[i]; });
            return obj;
        });
    }
    if (!headers.length || !fileRows.length) {
        deps.flash('导入文件没有数据行', true);
        return;
    }
    const insertable = columns.filter((c) => !(meta.pk || []).includes(c) || c === 'rowid');
    const targets = insertable.length ? insertable : columns;
    openImportMapping({headers, fileRows, targets});
}

function openImportMapping({headers, fileRows, targets}) {
    const panel = document.createElement('div');
    panel.className = 'db-preview db-conn-dialog';
    const head = document.createElement('div');
    head.className = 'db-preview-head';
    head.textContent = '导入数据 · ' + fileRows.length + ' 行 → ' + table;
    const form = document.createElement('div');
    form.className = 'db-conn-form';
    const rowEls = [];
    for (const col of targets) {
        const row = document.createElement('label');
        row.className = 'db-conn-rowline';
        const label = document.createElement('span');
        label.className = 'db-conn-label';
        label.textContent = col;
        const sel = createSelect({options: [
            {value: '', label: '（不导入）'},
            ...headers.map((h) => ({value: h, label: h, selected: h === col})),
        ]});
        sel.element.dataset.col = col;
        row.append(label, sel.element);
        form.appendChild(row);
        rowEls.push({col, sel});
    }
    const foot = document.createElement('div');
    foot.className = 'db-preview-foot';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'db-btn';
    cancelBtn.textContent = '取消';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'db-btn primary';
    okBtn.textContent = '载入 ' + fileRows.length + ' 行';
    foot.append(cancelBtn, okBtn);
    const msgEl = document.createElement('div');
    msgEl.className = 'db-ds-msg';
    panel.append(head, form, msgEl, foot);

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
        id: 'db-import-mapping',
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
    okBtn.addEventListener('click', () => {
        const map = rowEls.filter((r) => r.sel.control.value).map((r) => ({col: r.col, src: r.sel.control.value}));
        if (!map.length) {
            msgEl.textContent = '至少为一列选择来源';
            msgEl.className = 'db-ds-msg error';
            return;
        }
        let loaded = 0;
        for (const fr of fileRows) {
            const values = {};
            const edited = new Set();
            for (const m of map) {
                const raw = fr[m.src];
                values[m.col] = raw == null || raw === '' ? null : String(raw);
                edited.add(m.col);
            }
            inserts.push({values, edited});
            loaded++;
        }
        cleanup();
        applyToGrid(true);
        rebuildToolbar();
        deps.flash('已载入 ' + loaded + ' 行待提交——用「预览并提交」或 Ctrl+Enter 写入（单事务可整体回滚）');
    });
}
pagePrev.addEventListener('click', () => {
    pageOffset = Math.max(0, pageOffset - pageSize);
    loadPage();
});
pageNext.addEventListener('click', () => {
    if (!hasMore) return;
    pageOffset += pageSize;
    loadPage();
});
editBtn.addEventListener('click', () => {
    editMode = !editMode;
    rebuildToolbar();
    renderStatus();
});
addRowBtn.addEventListener('click', () => {
    if (!isEditable()) return;
    inserts.push({values: {}, edited: new Set()});
    applyToGrid(true);
    rebuildToolbar();
});
dropBtn.addEventListener('click', () => {
    updates.clear();
    deletes.clear();
    inserts = [];
    applyToGrid(true);
    rebuildToolbar();
});
submitBtn.addEventListener('click', submitChanges);

// Ctrl+Enter 直接提交（编辑框内的 Enter 落盘先走自己的 handler，随后冒泡到这里）
el.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
        ev.preventDefault();
        submitDirect();
    }
});

addFilterBtn.addEventListener('click', () => addFilterRow());

function addFilterRow(initial) {
    const cond = initial || {column: (columns || [])[0] || '', op: 'contains', value: ''};
    filters.push(cond);
    const row = document.createElement('div');
    row.className = 'db-filter-cond';
    const colSel = createSelect({options: columns.map((c) => ({value: c, label: c, selected: c === cond.column}))});
    const opSel = createSelect({options: FILTER_OPS.map((o) => ({value: o.value, label: o.label, selected: o.value === cond.op}))});
    // 增强触发器（set-select wrap）会继承原 select 的类，宽度按这两个类定（CSS 栅格）
    colSel.element.classList.add('db-filter-col');
    opSel.element.classList.add('db-filter-op');
    const valInput = createInput({value: cond.value, placeholder: '值'});
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'db-btn';
    rm.innerHTML = iconSvg('close', 11);
    const syncValue = () => {
        valInput.element.hidden = !filterOpNeedsValue(opSel.control.value);
    };
    colSel.control.addEventListener('change', () => { cond.column = colSel.control.value; applyFilters(); });
    opSel.control.addEventListener('change', () => { cond.op = opSel.control.value; syncValue(); applyFilters(); });
    valInput.control.addEventListener('input', () => { cond.value = valInput.control.value; applyFilters(); });
    rm.addEventListener('click', () => {
        const at = filters.indexOf(cond);
        if (at >= 0) filters.splice(at, 1);
        row.remove();
        if (!filters.length) filterArea.classList.add('hidden');
        applyFilters();
    });
    syncValue();
    // 先入行再增强：enhanceSelect 的 sel.after(wrap) 要求 select 已在 DOM 里
    row.append(colSel.element, opSel.element, valInput.element, rm);
    filterList.appendChild(row);
    if (typeof deps.enhanceSelect === 'function') {
        deps.enhanceSelect(colSel.element);
        deps.enhanceSelect(opSel.element);
    }
}

function applyFilters() {
    pageOffset = 0;
    loadPage();
}

// 行号点按 = 删除标记（编辑模式）
function toggleRowDelete(rowIdx) {
    if (!editMode || loading) return;
    if (rowIdx >= serverRows.length) {
        inserts.splice(rowIdx - serverRows.length, 1);
        applyToGrid(true);
        rebuildToolbar();
        return;
    }
    const key = rowKeyOf(meta, serverRows[rowIdx], columns);
    if (deletes.has(key)) {
        deletes.delete(key);
    } else {
        deletes.set(key, rowKeysMap(meta, serverRows[rowIdx], columns));
        updates.delete(key); // 整行都删了，单格修改一并丢弃
    }
    applyToGrid(true);
    rebuildToolbar();
}

// 双击单元格 → 行内输入框
function startCellEdit(rowIdx, colIdx, cellEl) {
    if (!editMode || loading) return;
    const col = columns[colIdx];
    if (col == null) return;
    const editingInsert = rowIdx >= serverRows.length;
    if (!editingInsert) {
        if ((meta.pk || []).includes(col)) return; // 主键列不可编辑（改主键 = 改行身份）
        const key = rowKeyOf(meta, serverRows[rowIdx], columns);
        if (deletes.has(key)) return; // 已标记删除的行不再改
    }
    const current = cellEl.textContent === 'NULL' ? '' : cellEl.textContent;
    cellEl.textContent = '';
    const input = createInput({value: current, spellcheck: false});
    input.control.style.width = '100%';
    cellEl.appendChild(input.element);
    cellEl.classList.add('db-cell-editing');
    input.control.focus();
    input.control.select();

    const commit = () => {
        const value = input.control.value;
        cellEl.classList.remove('db-cell-editing');
        if (editingInsert) {
            const ins = inserts[rowIdx - serverRows.length];
            if (value === '') ins.values[col] = null;
            else ins.values[col] = value;
            if (value !== '') ins.edited.add(col);
            else ins.edited.delete(col);
        } else {
            const key = rowKeyOf(meta, serverRows[rowIdx], columns);
            const idx = keyIndex.get(key);
            const wasNull = !!(serverNulls[idx] && serverNulls[idx][colIdx]);
            const old = wasNull ? null : serverRows[rowIdx][colIdx];
            const newValue = value;
            if ((old == null && newValue === '') || old === newValue) {
                const u = updates.get(key);
                if (u && u.cells) {
                    u.cells.delete(col);
                    if (!u.cells.size) updates.delete(key);
                }
            } else {
                let u = updates.get(key);
                if (!u) {
                    u = {keys: rowKeysMap(meta, serverRows[rowIdx], columns), cells: new Map()};
                    updates.set(key, u);
                }
                u.cells.set(col, {old, new: newValue});
            }
        }
        applyToGrid(true);
        rebuildToolbar();
    };
    const cancel = () => {
        cellEl.classList.remove('db-cell-editing');
        applyToGrid(true);
    };
    input.control.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            commit();
        } else if (ev.key === 'Escape') {
            ev.preventDefault();
            cancel();
        }
    });
    input.control.addEventListener('blur', commit);
}

// ---------- 预览与提交 ----------

function buildChanges() {
    const ch = {database: db, table, updates: [], deletes: [], inserts: []};
    for (const [key, u] of updates) {
        if (deletes.has(key)) continue;
        for (const [col, c] of u.cells) {
            ch.updates.push({keys: u.keys, column: col, oldValue: c.old, newValue: c.new});
        }
    }
    for (const keys of deletes.values()) {
        ch.deletes.push({keys});
    }
    for (const ins of inserts) {
        ch.inserts.push({values: Object.assign({}, ins.values)});
    }
    if (!ch.updates.length && !ch.deletes.length && !ch.inserts.length) return null;
    return ch;
}

let submitting = false; // 提交防重入（Ctrl+Enter 连按 / 预览弹层与快捷键并发）

// 两条提交路径（预览确认 / Ctrl+Enter 直提）共用的落地：清 dirty → 留痕 → 刷新
async function applyResult(changes) {
    const result = await deps.backend.DBApplyChanges(session.id, changes);
    updates.clear();
    deletes.clear();
    inserts = [];
    deps.flash('已提交：' + result.updates + ' 处修改、' + result.deletes + ' 行删除、' + result.inserts + ' 行插入（' + formatElapsed(result.elapsedMs) + '）');
    if (deps.logActivity) {
        deps.logActivity('db.apply', session.kind + ':' + session.name + '/' + table, {
            kind: session.kind, table,
            updates: result.updates, deletes: result.deletes, inserts: result.inserts,
            elapsedMs: result.elapsedMs,
        });
    }
    await loadMeta(true);
    await loadPage();
}

// Ctrl+Enter：直接提交（跳过预览弹层，方案 §11.8 作者拍板对齐 JetBrains 默认行为）
async function submitDirect() {
    if (!isEditable() || submitting) return;
    const changes = buildChanges();
    if (!changes) {
        deps.flash('没有待提交的修改');
        return;
    }
    submitting = true;
    rebuildToolbar();
    try {
        await applyResult(changes);
    } catch (e) {
        deps.flash('提交失败（已整体回滚）：' + (e && e.message || e), true);
        // 冲突/失败后刷新当前页，让用户看到最新数据（刷新失败保留原错误提示即可）
        try {
            await loadMeta(true);
            await loadPage();
        } catch (_) { /* 刷新失败时状态条已由 loadPage 自行报错 */ }
    } finally {
        submitting = false;
        rebuildToolbar();
    }
}

// 提交按钮：预览弹层路径（列出将执行的 SQL，确认后写库）
async function submitChanges() {
    if (!isEditable() || submitting) return;
    const changes = buildChanges();
    if (!changes) {
        deps.flash('没有待提交的修改');
        return;
    }
    let stmts = [];
    try {
        stmts = await deps.backend.DBPreviewChanges(session.id, changes) || [];
    } catch (e) {
        deps.flash('生成预览失败：' + (e && e.message || e), true);
        return;
    }
    openPreviewOverlay(stmts, changes);
}

function openPreviewOverlay(stmts, changes) {
    const mask = document.createElement('div');
    mask.className = 'db-preview-mask';
    const panel = document.createElement('div');
    panel.className = 'db-preview';
    const head = document.createElement('div');
    head.className = 'db-preview-head';
    head.textContent = '提交预览 · ' + stmts.length + ' 条语句 · 单事务（任一失败整体回滚）';
    const body = document.createElement('div');
    body.className = 'db-preview-body';
    for (const st of stmts) {
        const item = document.createElement('div');
        item.className = 'db-preview-item';
        const tag = document.createElement('span');
        tag.className = 'db-preview-kind ' + st.kind;
        tag.textContent = st.kind;
        const code = document.createElement('pre');
        code.className = 'db-preview-sql';
        code.textContent = st.sql;
        item.append(tag, code);
        body.appendChild(item);
    }
    const foot = document.createElement('div');
    foot.className = 'db-preview-foot';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'db-btn';
    cancelBtn.textContent = '取消';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'db-btn danger';
    okBtn.textContent = '提交（不可自动回滚）';
    foot.append(cancelBtn, okBtn);
    panel.append(head, body, foot);
    // 遮罩弹层（overlayStack 注册）。close() 必须自己做 DOM 清理——dispose() 不触发
    // onClose，只 dispose 会把 mask 留在 DOM（与 db-connections.js 同款收口）
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
        id: 'db-apply-preview',
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
    cancelBtn.addEventListener('click', close);
    mask.addEventListener('click', (ev) => {
        if (ev.target === mask) close();
    });
    okBtn.addEventListener('click', async () => {
        okBtn.disabled = true;
        try {
            await applyResult(changes);
            close();
        } catch (e) {
            okBtn.disabled = false;
            deps.flash('提交失败（已整体回滚）：' + (e && e.message || e), true);
            // 冲突/失败后刷新当前页，让用户看到最新数据
            await loadMeta(true);
            await loadPage();
            close();
        }
    });
}

// ---------- 启动 ----------

async function init() {
    try {
        await loadMeta(false);
    } catch (e) {
        if (await recoverSession(e)) return; // 空闲回收：自动重连后重建面板
        error = String(e && e.message || e);
        renderStatus();
        return;
    }
    rebuildToolbar();
    await loadPage();
}

init();

return {
    el,
    /** 会话断开时由页面调用（隐藏编辑簇并停自动刷新）。 */
    invalidate() {
        cancelActiveBrowse();
        loadSeq++; // 在飞响应作废；重连后由宿主重建面板
        editMode = false;
        setAutoRefresh(0, true); // 静默停自动刷新（重连重建后默认关，用户可再开）
        rebuildToolbar();
        renderStatus();
    },
};
}
