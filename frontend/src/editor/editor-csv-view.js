// editor-csv-view.js：从 editor-groups.js 拆出的域模块（factory + 显式依赖注入）。
// CSV/TSV 表格视图：表格渲染与虚拟滚动、列统计面板、冻结列宽、
// 单元格编辑与回写、缩放、撤销/重做（tableHistory）。
//
// deps 经 Object.create 委托继承 editor-groups 的 getter 集，
// 另接内部函数 markDocDirty / updateStatus 的转发箭头。
import {isDocReadOnly} from '../core/readonly.js';

export function createEditorCsvView(deps) {

function createCsvTableView(doc) {
    if (doc.tableEl || !doc.pane) return;
    const wrap = document.createElement('div');
    wrap.className = 'csv-table-view';
    const bar = document.createElement('div');
    bar.className = 'csv-table-bar';
    const meta = document.createElement('span');
    meta.className = 'csv-table-meta';
    const filterWrap = document.createElement('label');
    filterWrap.className = 'csv-table-filter';
    const filterInput = document.createElement('input');
    filterInput.type = 'search';
    filterInput.placeholder = '筛选所有列…';
    filterInput.spellcheck = false;
    const filterClear = document.createElement('button');
    filterClear.type = 'button';
    filterClear.className = 'csv-filter-clear';
    filterClear.textContent = '×';
    filterWrap.append(filterInput, filterClear);
    const hint = document.createElement('span');
    hint.className = 'csv-table-hint';
    hint.textContent = doc.large
        ? '文件超过 10 MB，表格只读'
        : '';
    const statsBtn = document.createElement('button');
    statsBtn.type = 'button';
    statsBtn.className = 'csv-stats-btn';
    statsBtn.textContent = '列统计';
    statsBtn.dataset.tip = '查看当前列统计（也可右键表头指定列）';
    bar.append(meta, filterWrap, statsBtn, hint);
    const scroll = document.createElement('div');
    scroll.className = 'csv-table-scroll';
    wrap.append(bar, scroll);
    doc.pane.appendChild(wrap);
    doc.tableEl = wrap;
    doc.tableMeta = meta;
    doc.tableScroll = scroll;
    doc.tableFilterInput = filterInput;
    doc.tableFilterClear = filterClear;
    if (!doc.tableZoom) doc.tableZoom = 1;
    let filterTimer = 0;
    filterInput.addEventListener('input', () => {
        clearTimeout(filterTimer);
        filterTimer = setTimeout(() => {
            filterTimer = 0;
            const view = ensureCsvView(doc);
            const next = filterInput.value;
            if (view.filter === next) return;
            view.filter = next;
            renderCsvTableView(doc, {resetScroll: true});
        }, 120);
    });
    filterClear.addEventListener('click', () => {
        filterInput.value = '';
        const view = ensureCsvView(doc);
        if (!view.filter) return;
        view.filter = '';
        renderCsvTableView(doc, {resetScroll: true});
    });
    statsBtn.addEventListener('pointerdown', () => {
        const active = document.activeElement;
        if (active && active.classList && active.classList.contains('csv-cell') && active.dataset.col != null) {
            doc.csvActiveCol = Number(active.dataset.col);
        }
    });
    statsBtn.addEventListener('click', () => {
        if (doc !== deps.file) return;
        const view = ensureCsvView(doc);
        let col = doc.csvActiveCol;
        if (!Number.isInteger(col)) col = view.sortCol >= 0 ? view.sortCol : 0;
        openCsvColumnStats(doc, col);
    });
    scroll.addEventListener('scroll', () => {
        if (doc.csvVirtual) scheduleCsvVirtualRender(doc);
    }, {passive: true});
    applyCsvTableZoom(doc);
}

function ensureCsvView(doc) {
    if (!doc.csvView) doc.csvView = {sortCol: -1, sortDir: 0, filter: ''};
    return doc.csvView;
}

const csvCollator = new Intl.Collator('zh-CN', {numeric: true, sensitivity: 'base'});

function csvSortKey(value) {
    const text = value == null ? '' : String(value);
    const trimmed = text.trim();
    if (!trimmed) return {empty: true, kind: 3, num: 0, str: ''};
    const num = Number(trimmed.replace(/,/g, ''));
    if (trimmed !== '' && Number.isFinite(num)) return {empty: false, kind: 0, num, str: trimmed};
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(trimmed)) {
        const time = Date.parse(trimmed);
        if (Number.isFinite(time)) return {empty: false, kind: 1, num: time, str: trimmed};
    }
    return {empty: false, kind: 2, num: 0, str: trimmed};
}

// 排序/筛选只产生视图索引，绝不改动 doc.tableRows 的原始顺序
function csvViewIndices(doc) {
    const view = ensureCsvView(doc);
    const rows = doc.tableRows || [];
    const headers = doc.tableHeaders || [];
    const filter = String(view.filter || '').trim().toLowerCase();
    const sortable = view.sortDir !== 0 && view.sortCol >= 0 && view.sortCol < headers.length;
    if (!filter && !sortable) return null;
    const indices = [];
    for (let i = 0; i < rows.length; i++) {
        if (filter) {
            const row = rows[i] || [];
            let hit = false;
            for (let c = 0; c < row.length; c++) {
                const cell = row[c] == null ? '' : String(row[c]);
                if (cell.toLowerCase().includes(filter)) {
                    hit = true;
                    break;
                }
            }
            if (!hit) continue;
        }
        indices.push(i);
    }
    if (sortable) {
        const col = view.sortCol;
        const dir = view.sortDir;
        indices.sort((a, b) => {
            const ka = csvSortKey((rows[a] || [])[col]);
            const kb = csvSortKey((rows[b] || [])[col]);
            if (ka.empty || kb.empty) {
                if (ka.empty === kb.empty) return a - b;
                return ka.empty ? 1 : -1;
            }
            let cmp;
            if (ka.kind === kb.kind && ka.kind !== 2) cmp = ka.num - kb.num;
            else cmp = csvCollator.compare(ka.str, kb.str);
            if (cmp === 0) cmp = a - b;
            return cmp * dir;
        });
    }
    return indices;
}

function computeCsvColumnStats(doc, col) {
    const rows = doc.tableRows || [];
    const values = [];
    let empty = 0;
    for (const row of rows) {
        const raw = (row || [])[col];
        const text = raw == null ? '' : String(raw);
        if (!text.trim()) empty++;
        else values.push(text);
    }
    const counts = new Map();
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    let numericCount = 0;
    let dateCount = 0;
    let emailCount = 0;
    let urlCount = 0;
    let boolCount = 0;
    let maxLen = 0;
    const numbers = [];
    for (const text of values) {
        const trimmed = text.trim();
        maxLen = Math.max(maxLen, text.length);
        const num = Number(trimmed.replace(/,/g, ''));
        if (trimmed && Number.isFinite(num)) {
            numericCount++;
            numbers.push(num);
        }
        if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(trimmed) && Number.isFinite(Date.parse(trimmed))) dateCount++;
        if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) emailCount++;
        if (/^https?:\/\//i.test(trimmed)) urlCount++;
        if (/^(true|false|yes|no|是|否)$/i.test(trimmed)) boolCount++;
    }
    let type = '文本';
    if (values.length && numericCount === values.length) type = '数字';
    else if (values.length && dateCount === values.length) type = '日期';
    else if (values.length && emailCount === values.length) type = '邮箱';
    else if (values.length && urlCount === values.length) type = 'URL';
    else if (values.length && boolCount === values.length) type = '布尔';
    else if (counts.size && counts.size <= Math.min(20, Math.max(2, Math.round(values.length * 0.2)))) type = '枚举';
    const stats = {
        total: rows.length,
        nonEmpty: values.length,
        empty,
        unique: counts.size,
        maxLen,
        type,
        top,
        numeric: null,
    };
    if (values.length && numericCount === values.length) {
        let min = numbers[0];
        let max = numbers[0];
        let sum = 0;
        for (const n of numbers) {
            if (n < min) min = n;
            if (n > max) max = n;
            sum += n;
        }
        stats.numeric = {min, max, avg: sum / numbers.length};
    }
    return stats;
}

function closeCsvColumnStats(doc) {
    if (!doc) return;
    if (doc.csvStatsPanel) doc.csvStatsPanel.classList.add('hidden');
    doc.csvStatsOpen = false;
    if (doc.csvStatsEscHandler) {
        document.removeEventListener('keydown', doc.csvStatsEscHandler, true);
        doc.csvStatsEscHandler = null;
    }
}

function ensureCsvStatsPanel(doc) {
    if (doc.csvStatsPanel) return doc.csvStatsPanel;
    const panel = document.createElement('div');
    panel.className = 'csv-stats-panel hidden';
    panel.setAttribute('role', 'dialog');
    doc.tableEl.appendChild(panel);
    doc.csvStatsPanel = panel;
    return panel;
}

function openCsvColumnStats(doc, col) {
    const headers = doc.tableHeaders || [];
    if (!headers.length) return;
    const index = Math.max(0, Math.min(headers.length - 1, Number(col) || 0));
    doc.csvActiveCol = index;
    const panel = ensureCsvStatsPanel(doc);
    panel.textContent = '';
    const head = document.createElement('div');
    head.className = 'csv-stats-head';
    const title = document.createElement('span');
    title.className = 'csv-stats-title';
    title.textContent = '列统计 · ' + (headers[index] || '(空列名)');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'csv-stats-close';
    close.textContent = '×';
    close.addEventListener('click', () => closeCsvColumnStats(doc));
    head.append(title, close);
    panel.appendChild(head);
    const sub = document.createElement('div');
    sub.className = 'csv-stats-sub';
    sub.textContent = '第 ' + (index + 1) + ' 列';
    panel.appendChild(sub);
    const stats = computeCsvColumnStats(doc, index);
    const addRow = (label, value) => {
        const row = document.createElement('div');
        row.className = 'csv-stats-row';
        const key = document.createElement('span');
        key.className = 'csv-stats-label';
        key.textContent = label;
        const val = document.createElement('span');
        val.className = 'csv-stats-value';
        val.textContent = value;
        row.append(key, val);
        panel.appendChild(row);
    };
    addRow('行数', String(stats.total));
    addRow('非空 / 空', stats.nonEmpty + ' / ' + stats.empty);
    addRow('唯一值', String(stats.unique));
    if (stats.numeric) {
        const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))));
        addRow('最小 / 最大', fmt(stats.numeric.min) + ' / ' + fmt(stats.numeric.max));
        addRow('平均值', fmt(stats.numeric.avg));
    }
    addRow('最长值', stats.maxLen + ' 字符');
    addRow('疑似类型', stats.type);
    if (stats.top.length) {
        addRow('出现最多', stats.top.map(([value, count]) => value + '（' + count + '）').join('、'));
    }
    panel.classList.remove('hidden');
    doc.csvStatsOpen = true;
    // 统计面板挂在 doc.tableEl 内（编辑器层叠上下文），不进全局弹层栈：
    // Esc 由这里的 per-doc 监听自管（栈空时才到达，页面级弹层开着时栈先退）。
    if (!doc.csvStatsEscHandler) {
        doc.csvStatsEscHandler = (e) => {
            if (e.key !== 'Escape' || !doc.csvStatsOpen) return;
            e.preventDefault();
            e.stopPropagation();
            closeCsvColumnStats(doc);
        };
        document.addEventListener('keydown', doc.csvStatsEscHandler, true);
    }
}

function applyCsvTableZoom(doc) {
    if (!doc || !doc.tableEl) return;
    doc.tableEl.style.setProperty('--csv-zoom', String(doc.tableZoom || 1));
    if (doc.csvVirtual) {
        doc.csvRowScreenH = (doc.csvRowLayoutH || CSV_DEFAULT_ROW_LAYOUT_H) * (doc.tableZoom || 1);
        doc.csvVisibleStart = -1;
        doc.csvVisibleEnd = -1;
        scheduleCsvVirtualRender(doc);
    }
}

function zoomCsvTable(doc, deltaY) {
    if (!doc || !doc.tableEl || !deltaY) return;
    const dir = deltaY < 0 ? 1 : -1;
    const current = doc.tableZoom || 1;
    const next = Math.min(8, Math.max(0.25, Math.round((current + dir * 0.1) * 10) / 10));
    if (next === current) return;
    const scroll = doc.tableScroll;
    const oldRowH = doc.csvRowScreenH || (doc.csvRowLayoutH || CSV_DEFAULT_ROW_LAYOUT_H) * current;
    const topRow = oldRowH > 0 ? scroll.scrollTop / oldRowH : 0;
    doc.tableZoom = next;
    applyCsvTableZoom(doc);
    if (doc.csvVirtual && scroll) {
        scroll.scrollTop = Math.max(0, topRow * (doc.csvRowLayoutH || CSV_DEFAULT_ROW_LAYOUT_H) * next);
        doc.csvVisibleStart = -1;
        doc.csvVisibleEnd = -1;
        renderCsvVirtualRows(doc, true);
    }
    deps.updateStatus();
}

const CSV_VIRTUAL_THRESHOLD = 300;
const CSV_VIRTUAL_OVERSCAN = 10;
const CSV_DEFAULT_ROW_LAYOUT_H = 24;

function estimateCsvColumnWidths(doc) {
    const headers = doc.tableHeaders || [];
    const rows = doc.tableRows || [];
    const widths = headers.map((header) => Math.max(deps.CSV_COL_MIN_WIDTH, Math.min(420, 24 + String(header || '').length * 8)));
    const sample = Math.min(rows.length, 300);
    for (let i = 0; i < sample; i++) {
        const row = rows[i] || [];
        for (let c = 0; c < headers.length; c++) {
            const len = row[c] == null ? 0 : String(row[c]).length;
            const width = Math.min(420, 24 + Math.min(len, 48) * 8);
            if (width > widths[c]) widths[c] = width;
        }
    }
    return widths;
}

function createCsvVirtualRow(doc, editable, headerCount) {
    const tr = document.createElement('tr');
    tr.className = 'csv-row';
    const num = document.createElement('td');
    num.className = 'csv-rownum';
    tr.appendChild(num);
    const cells = [];
    for (let col = 0; col < headerCount; col++) {
        const td = document.createElement('td');
        td.className = 'csv-cell';
        if (editable) {
            td.contentEditable = 'plaintext-only';
            td.spellcheck = false;
            td.dataset.col = String(col);
            td.addEventListener('focus', () => { doc.csvActiveCol = col; });
            td.addEventListener('keydown', (e) => onCsvCellKeyDown(doc, e));
            td.addEventListener('input', () => markCsvCellTyping(doc));
            td.addEventListener('blur', () => commitCsvCell(doc, td));
        }
        tr.appendChild(td);
        cells.push(td);
    }
    return {tr, num, cells};
}

function scheduleCsvVirtualRender(doc) {
    if (!doc || !doc.csvVirtual || doc.csvRenderScheduled) return;
    doc.csvRenderScheduled = true;
    requestAnimationFrame(() => {
        doc.csvRenderScheduled = false;
        renderCsvVirtualRows(doc);
    });
}

// 只更新视口附近的真实行，滚动时复用同一批 tr/td
function renderCsvVirtualRows(doc, force) {
    if (!doc || !doc.csvVirtual || !doc.csvTBody || !doc.csvTopSpacer || !doc.csvBottomSpacer) return;
    const scroll = doc.tableScroll;
    const tbody = doc.csvTBody;
    const total = doc.csvViewTotal || 0;
    const zoom = doc.tableZoom || 1;
    if (!doc.csvRowLayoutH) doc.csvRowLayoutH = CSV_DEFAULT_ROW_LAYOUT_H;
    let rowH = doc.csvRowScreenH || doc.csvRowLayoutH * zoom;
    if (!rowH || rowH < 6) rowH = CSV_DEFAULT_ROW_LAYOUT_H * zoom;
    const viewH = scroll.clientHeight || 480;
    const maxTop = Math.max(0, total * rowH - viewH);
    if (scroll.scrollTop > maxTop) scroll.scrollTop = maxTop;
    let start = Math.floor(scroll.scrollTop / rowH) - CSV_VIRTUAL_OVERSCAN;
    if (start < 0) start = 0;
    let count = Math.ceil(viewH / rowH) + CSV_VIRTUAL_OVERSCAN * 2;
    let end = Math.min(total, start + count);
    if (start >= total && total > 0) {
        start = Math.max(0, total - count);
        end = total;
    }
    if (!force && start === doc.csvVisibleStart && end === doc.csvVisibleEnd &&
        doc.csvPool && doc.csvPool.length && doc.csvPool[0].cells.length === doc.tableHeaders.length) {
        return;
    }
    if (start !== doc.csvVisibleStart || end !== doc.csvVisibleEnd) {
        const active = document.activeElement;
        if (active && active.classList && active.classList.contains('csv-cell') && tbody.contains(active)) {
            active.blur();
        }
    }
    doc.csvVisibleStart = start;
    doc.csvVisibleEnd = end;
    const layoutH = doc.csvRowLayoutH;
    doc.csvTopSpacer.firstChild.style.height = Math.max(0, start * layoutH) + 'px';
    doc.csvBottomSpacer.firstChild.style.height = Math.max(0, (total - end) * layoutH) + 'px';
    const needed = Math.max(0, end - start);
    const headers = doc.tableHeaders || [];
    const rows = doc.tableRows || [];
    const indices = doc.csvViewIndices;
    const editable = !isDocReadOnly(doc, deps.settings);
    if (!doc.csvPool || (doc.csvPool.length && doc.csvPool[0].cells.length !== headers.length)) {
        for (const row of doc.csvPool || []) row.tr.remove();
        doc.csvPool = [];
    }
    while (doc.csvPool.length < needed) {
        const row = createCsvVirtualRow(doc, editable, headers.length);
        tbody.insertBefore(row.tr, doc.csvBottomSpacer);
        doc.csvPool.push(row);
    }
    for (let i = 0; i < doc.csvPool.length; i++) {
        const slot = doc.csvPool[i];
        if (i >= needed) {
            slot.tr.hidden = true;
            continue;
        }
        slot.tr.hidden = false;
        const viewPos = start + i;
        const rowIndex = indices ? indices[viewPos] : viewPos;
        const row = rows[rowIndex] || [];
        slot.num.textContent = String(rowIndex + 1);
        for (let col = 0; col < headers.length; col++) {
            const td = slot.cells[col];
            const display = row[col] == null ? '' : String(row[col]);
            if (td.textContent !== display) td.textContent = display;
            td.dataset.tip = display;
            td.dataset.row = String(rowIndex);
            td.dataset.vpos = String(viewPos);
        }
    }
    const first = doc.csvPool.find((slot) => !slot.tr.hidden);
    if (first) {
        const measured = first.tr.getBoundingClientRect().height;
        if (measured > 4 && Math.abs(measured - (doc.csvRowScreenH || 0)) > 0.6) {
            doc.csvRowScreenH = measured;
            doc.csvRowLayoutH = measured / zoom;
            doc.csvTopSpacer.firstChild.style.height = Math.max(0, start * doc.csvRowLayoutH) + 'px';
            doc.csvBottomSpacer.firstChild.style.height = Math.max(0, (total - end) * doc.csvRowLayoutH) + 'px';
        }
    }
}

function renderCsvTableView(doc, opts = {}) {
    if (!doc || !doc.tableEl || !doc.editor) return;
    const scroll = doc.tableScroll;
    const keepTop = opts.resetScroll ? 0 : scroll.scrollTop;
    const keepLeft = scroll.scrollLeft;
    scroll.textContent = '';
    const text = doc.editor.getText();
    doc.tableTrailingNewline = /\n$/.test(text);
    let parsed;
    try {
        parsed = doc.format.parseTable ? doc.format.parseTable(text) : {headers: [], rows: []};
    } catch (e) {
        doc.tableMeta.textContent = 'CSV 解析失败';
        const error = document.createElement('div');
        error.className = 'csv-table-empty error';
        error.textContent = e.message;
        scroll.appendChild(error);
        return;
    }
    const headers = parsed.headers || [];
    const rows = parsed.rows || [];
    doc.tableHeaders = headers;
    doc.tableRows = rows;
    const view = ensureCsvView(doc);
    if (view.sortCol >= headers.length) {
        view.sortCol = -1;
        view.sortDir = 0;
    }
    if (doc.tableFilterInput && doc.tableFilterInput.value !== (view.filter || '')) {
        doc.tableFilterInput.value = view.filter || '';
    }
    const viewIndices = csvViewIndices(doc);
    const shown = viewIndices ? viewIndices.length : rows.length;
    doc.csvViewIndices = viewIndices;
    doc.csvViewTotal = shown;
    const virtual = shown > CSV_VIRTUAL_THRESHOLD;
    doc.csvVirtual = virtual;
    doc.csvVisibleStart = -1;
    doc.csvVisibleEnd = -1;
    doc.csvRenderScheduled = false;
    doc.csvPool = [];
    if (!Array.isArray(doc.tableColWidths) || doc.tableColWidths.length !== headers.length) {
        doc.tableColWidths = null;
    }
    if (virtual && !doc.tableColWidths) {
        doc.tableColWidths = estimateCsvColumnWidths(doc);
    }
    if (!doc.tableUndo) doc.tableUndo = [];
    if (!doc.tableRedo) doc.tableRedo = [];
    const filtered = !!String(view.filter || '').trim();
    doc.tableMeta.textContent = rows.length + ' 行 × ' + headers.length + ' 列' +
        (filtered ? ' · 匹配 ' + shown + ' 行' : '');
    if (!headers.length) {
        const empty = document.createElement('div');
        empty.className = 'csv-table-empty';
        empty.textContent = filtered ? '没有匹配的行' : '没有可显示的表格内容';
        scroll.appendChild(empty);
        return;
    }
    const table = document.createElement('table');
    table.className = 'csv-table';
    if (Array.isArray(doc.tableColWidths) && doc.tableColWidths.length === headers.length) {
        table.classList.add('fixed-layout');
        table.appendChild(buildCsvColgroup(doc.tableColWidths));
        table.style.width = (deps.CSV_ROW_NUM_WIDTH + doc.tableColWidths.reduce((sum, w) => sum + w, 0)) + 'px';
    }
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const corner = document.createElement('th');
    corner.className = 'csv-rownum';
    corner.textContent = '#';
    headRow.appendChild(corner);
    for (let col = 0; col < headers.length; col++) {
        const header = headers[col];
        const th = document.createElement('th');
        th.className = 'csv-col-head';
        th.dataset.tip = header + (doc.large ? '' : '（点击排序）');
        if (view.sortCol === col && view.sortDir !== 0) {
            th.dataset.sort = view.sortDir > 0 ? 'asc' : 'desc';
        }
        const label = document.createElement('span');
        label.className = 'csv-head-text';
        label.textContent = header === '' ? '(空列名)' : header;
        const handle = document.createElement('span');
        handle.className = 'csv-col-resize';
        handle.dataset.col = String(col);
        handle.addEventListener('pointerdown', (e) => startCsvColumnResize(doc, col, e));
        handle.addEventListener('click', (e) => e.stopPropagation());
        th.addEventListener('click', (e) => {
            if (e.target && e.target.closest && e.target.closest('.csv-col-resize')) return;
            if (doc !== deps.file) return;
            doc.csvActiveCol = col;
            const csvView = ensureCsvView(doc);
            if (csvView.sortCol === col) {
                csvView.sortDir = csvView.sortDir === 1 ? -1 : (csvView.sortDir === -1 ? 0 : 1);
                if (csvView.sortDir === 0) csvView.sortCol = -1;
            } else {
                csvView.sortCol = col;
                csvView.sortDir = 1;
            }
            renderCsvTableView(doc, {resetScroll: true});
        });
        th.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            doc.csvActiveCol = col;
            if (!deps.ctxMenu) return;
            const csvView = ensureCsvView(doc);
            deps.ctxMenu.open([
                {
                    label: '升序排序',
                    icon: 'chevron-down',
                    action: () => {
                        csvView.sortCol = col;
                        csvView.sortDir = 1;
                        renderCsvTableView(doc, {resetScroll: true});
                    },
                },
                {
                    label: '降序排序',
                    icon: 'chevron-up',
                    action: () => {
                        csvView.sortCol = col;
                        csvView.sortDir = -1;
                        renderCsvTableView(doc, {resetScroll: true});
                    },
                },
                {
                    label: '清除排序',
                    disabled: csvView.sortDir === 0,
                    action: () => {
                        csvView.sortCol = -1;
                        csvView.sortDir = 0;
                        renderCsvTableView(doc, {resetScroll: true});
                    },
                },
                {sep: true},
                {label: '列统计…', icon: 'chart', action: () => openCsvColumnStats(doc, col)},
            ], e.clientX, e.clientY);
        });
        th.append(label, handle);
        headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    if (virtual) {
        const topSpacer = document.createElement('tr');
        topSpacer.className = 'csv-spacer';
        topSpacer.appendChild(document.createElement('td'));
        const bottomSpacer = document.createElement('tr');
        bottomSpacer.className = 'csv-spacer';
        bottomSpacer.appendChild(document.createElement('td'));
        const colspanCell = (row) => {
            const cell = row.firstChild;
            cell.colSpan = headers.length + 1;
            cell.style.padding = '0';
            cell.style.border = '0';
            return cell;
        };
        colspanCell(topSpacer);
        colspanCell(bottomSpacer);
        tbody.append(topSpacer, bottomSpacer);
        doc.csvTBody = tbody;
        doc.csvTopSpacer = topSpacer;
        doc.csvBottomSpacer = bottomSpacer;
    } else {
        doc.csvTBody = tbody;
        doc.csvTopSpacer = null;
        doc.csvBottomSpacer = null;
    }
    const fragment = document.createDocumentFragment();
    const editable = !isDocReadOnly(doc, deps.settings);
    if (!virtual) {
        for (let viewRow = 0; viewRow < shown; viewRow++) {
            const rowIndex = viewIndices ? viewIndices[viewRow] : viewRow;
            const row = rows[rowIndex] || [];
            const tr = document.createElement('tr');
            const num = document.createElement('td');
            num.className = 'csv-rownum';
            num.textContent = String(rowIndex + 1);
            tr.appendChild(num);
            for (let col = 0; col < headers.length; col++) {
                const td = document.createElement('td');
                td.className = 'csv-cell';
                const value = row[col];
                const display = value == null ? '' : String(value);
                td.textContent = display;
                td.dataset.tip = display;
                if (editable) {
                    td.contentEditable = 'plaintext-only';
                    td.spellcheck = false;
                    td.dataset.row = String(rowIndex);
                    td.dataset.col = String(col);
                    td.dataset.vpos = String(viewRow);
                    td.addEventListener('focus', () => { doc.csvActiveCol = col; });
                    td.addEventListener('keydown', (e) => onCsvCellKeyDown(doc, e));
                    td.addEventListener('input', () => markCsvCellTyping(doc));
                    td.addEventListener('blur', () => commitCsvCell(doc, td));
                }
                tr.appendChild(td);
            }
            fragment.appendChild(tr);
        }
    }
    tbody.appendChild(fragment);
    table.appendChild(tbody);
    scroll.appendChild(table);
    scroll.scrollTop = keepTop;
    scroll.scrollLeft = keepLeft;
    if (virtual) {
        renderCsvVirtualRows(doc, true);
        if (scroll.scrollTop !== keepTop) {
            scroll.scrollTop = keepTop;
            renderCsvVirtualRows(doc, true);
        }
    }
}

function buildCsvColgroup(widths) {
    const group = document.createElement('colgroup');
    group.className = 'csv-colgroup';
    const rowCol = document.createElement('col');
    rowCol.style.width = deps.CSV_ROW_NUM_WIDTH + 'px';
    group.appendChild(rowCol);
    for (const width of widths) {
        const col = document.createElement('col');
        col.style.width = width + 'px';
        group.appendChild(col);
    }
    return group;
}

function applyCsvColumnLayout(doc) {
    if (!doc || doc !== deps.file || !doc.tableScroll || !doc.tableColWidths) return;
    const table = doc.tableScroll.querySelector('table.csv-table');
    if (!table) return;
    const headers = doc.tableHeaders || [];
    if (doc.tableColWidths.length !== headers.length) return;
    table.classList.add('fixed-layout');
    let group = table.querySelector('colgroup.csv-colgroup');
    if (!group || group.children.length !== doc.tableColWidths.length + 1) {
        if (group) group.remove();
        group = buildCsvColgroup(doc.tableColWidths);
        table.insertBefore(group, table.firstChild);
    } else {
        for (let i = 0; i < doc.tableColWidths.length; i++) {
            group.children[i + 1].style.width = doc.tableColWidths[i] + 'px';
        }
    }
    table.style.width = (deps.CSV_ROW_NUM_WIDTH + doc.tableColWidths.reduce((sum, w) => sum + w, 0)) + 'px';
}

function freezeCsvColumnWidths(doc) {
    if (!doc || doc !== deps.file || !doc.tableScroll) return;
    const headers = doc.tableHeaders || [];
    if (!headers.length) return;
    if (Array.isArray(doc.tableColWidths) && doc.tableColWidths.length === headers.length) return;
    const ths = Array.from(doc.tableScroll.querySelectorAll('thead th.csv-col-head'));
    if (ths.length !== headers.length) return;
    const zoom = doc.tableZoom || 1;
    doc.tableColWidths = ths.map((th) => Math.max(deps.CSV_COL_MIN_WIDTH, Math.round(th.getBoundingClientRect().width / zoom)));
    applyCsvColumnLayout(doc);
}

function startCsvColumnResize(doc, colIndex, e) {
    if (!doc || doc !== deps.file || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    freezeCsvColumnWidths(doc);
    if (!doc.tableColWidths || !doc.tableColWidths[colIndex]) return;
    // e.currentTarget 在事件派发结束后会被置空，先存下来给 cleanup 释放捕获用
    const handle = e.currentTarget;
    const pointerId = e.pointerId;
    try { handle.setPointerCapture(pointerId); } catch (err) {}
    const startX = e.clientX;
    const startWidth = doc.tableColWidths[colIndex];
    const zoom = doc.tableZoom || 1;
    let done = false;
    const onMove = (ev) => {
        // 松手事件丢在窗口外 / 预览 iframe 时，无按键却还在拖拽 = 必然卡死，动一下即自愈
        if (!ev.buttons) { cleanup(); return; }
        const next = Math.max(deps.CSV_COL_MIN_WIDTH, Math.round(startWidth + (ev.clientX - startX) / zoom));
        if (next === doc.tableColWidths[colIndex]) return;
        doc.tableColWidths[colIndex] = next;
        applyCsvColumnLayout(doc);
    };
    const cleanup = () => {
        if (done) return;
        done = true;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', cleanup);
        window.removeEventListener('pointercancel', cleanup);
        window.removeEventListener('blur', cleanup);
        try {
            if (handle && handle.hasPointerCapture && handle.hasPointerCapture(pointerId)) {
                handle.releasePointerCapture(pointerId);
            }
        } catch (err) {}
        document.body.classList.remove('csv-col-resizing');
    };
    document.body.classList.add('csv-col-resizing');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
    window.addEventListener('blur', cleanup);
}

function onCsvCellKeyDown(doc, e) {
    const td = e.currentTarget;
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        const row = doc.tableRows && doc.tableRows[Number(td.dataset.row)];
        const value = row && row[Number(td.dataset.col)] != null ? String(row[Number(td.dataset.col)]) : '';
        td.textContent = value;
        td.blur();
        return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        commitCsvCell(doc, td);
        focusAdjacentCsvCell(doc, td, (doc.tableHeaders || []).length || 1);
        return;
    }
    if (e.key === 'Tab') {
        e.preventDefault();
        commitCsvCell(doc, td);
        focusAdjacentCsvCell(doc, td, e.shiftKey ? -1 : 1);
    }
}

function focusAdjacentCsvCell(doc, td, offset) {
    if (!doc.tableScroll) return;
    if (doc.csvVirtual && td.dataset.vpos != null) {
        const targetPos = Number(td.dataset.vpos) + offset;
        const total = doc.csvViewTotal || 0;
        if (!(targetPos >= 0) || targetPos >= total) {
            td.blur();
            return;
        }
        const selector = 'td.csv-cell[data-vpos="' + targetPos + '"]';
        let target = doc.tableScroll.querySelector(selector);
        if (!target) {
            const rowH = doc.csvRowScreenH || (doc.csvRowLayoutH || CSV_DEFAULT_ROW_LAYOUT_H) * (doc.tableZoom || 1);
            doc.tableScroll.scrollTop = Math.max(0, targetPos * rowH - doc.tableScroll.clientHeight / 2);
            renderCsvVirtualRows(doc, true);
            target = doc.tableScroll.querySelector(selector);
        }
        if (!target) {
            td.blur();
            return;
        }
        target.focus();
        target.scrollIntoView({block: 'nearest', inline: 'nearest'});
        return;
    }
    const cells = doc.tableScroll.querySelectorAll('td.csv-cell');
    const index = Array.prototype.indexOf.call(cells, td);
    if (index < 0) return;
    const target = cells[index + offset];
    if (!target) {
        td.blur();
        return;
    }
    target.focus();
    target.scrollIntoView({block: 'nearest', inline: 'nearest'});
}

function csvCellText(td) {
    return String(td.innerText || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
}

function markCsvCellTyping(doc) {
    if (!doc || doc.dirty) return;
    if (deps.file === doc) {
        deps.setDirty(true, {noAutoSave: true});
    } else {
        doc.dirty = true;
        deps.updateTabDirty(doc);
        deps.updateBackendDirty();
    }
}

function flushCsvCellEditor() {
    if (deps.currentMode !== 'table') return;
    const active = document.activeElement;
    if (active && active.classList && active.classList.contains('csv-cell')) active.blur();
}

function serializeCsvTable(doc) {
    const text = doc.format.stringifyTable(doc.tableHeaders, doc.tableRows);
    return doc.tableTrailingNewline ? text + '\n' : text;
}

function applyCsvTableText(doc, text) {
    if (!doc || !doc.editor || doc.editor.getText() === text) return;
    const loading = doc.loading;
    doc.loading = true;
    try {
        doc.editor.setText(text);
        doc.text = text;
    } finally {
        doc.loading = loading;
    }
    deps.markDocDirty(doc);
}

function commitCsvCell(doc, td) {
    if (!doc || doc !== deps.file || isDocReadOnly(doc, deps.settings) || !doc.tableRows || !doc.tableHeaders || !td) return;
    const rowIndex = Number(td.dataset.row);
    const colIndex = Number(td.dataset.col);
    const row = doc.tableRows[rowIndex];
    if (!row) return;
    const value = csvCellText(td);
    const before = row[colIndex] == null ? '' : String(row[colIndex]);
    td.textContent = value;
    td.dataset.tip = value;
    if (value === before) {
        deps.markDocDirty(doc);
        return;
    }
    row[colIndex] = value;
    applyCsvTableText(doc, serializeCsvTable(doc));
    doc.tableUndo.push({row: rowIndex, col: colIndex, before, after: value});
    if (doc.tableUndo.length > 100) doc.tableUndo.shift();
    doc.tableRedo.length = 0;
}

function tableHistory(action) {
    if (deps.currentMode !== 'table' || !deps.file || !deps.file.tableRows) return;
    const doc = deps.file;
    const active = document.activeElement;
    if (active && active.classList && active.classList.contains('csv-cell')) active.blur();
    if (!doc.tableUndo || !doc.tableRedo) return;
    const from = action === 'undo' ? doc.tableUndo : doc.tableRedo;
    const to = action === 'undo' ? doc.tableRedo : doc.tableUndo;
    if (!from.length) return;
    const op = from.pop();
    if (op.full) {
        applyCsvTableText(doc, action === 'undo' ? op.before : op.after);
        to.push(op);
        renderCsvTableView(doc);
        return;
    }
    const row = doc.tableRows[op.row];
    if (!row) {
        from.push(op);
        return;
    }
    row[op.col] = action === 'undo' ? op.before : op.after;
    to.push(op);
    applyCsvTableText(doc, serializeCsvTable(doc));
    renderCsvTableView(doc);
}


function showCsvTableView(doc) {
    if (!doc || !doc.format.table) return;
    createCsvTableView(doc);
    if (doc.pane) doc.pane.classList.add('table-active');
    renderCsvTableView(doc);
}

function hideCsvTableView(doc) {
    if (!doc || !doc.pane) return;
    doc.pane.classList.remove('table-active');
    if (doc === deps.file && doc.editor && doc.editor.aceEditor) {
        try {
            doc.editor.aceEditor.resize();
        } catch (e) {}
    }
}

function enterCsvTable(doc) {
    if (!doc || !doc.format.table || !doc.editor) return;
    let text;
    try {
        text = deps.currentMode === 'tree' ? doc.format.stringify(doc.editor.get()) : doc.editor.getText();
    } catch (e) {
        deps.flash('无法生成 CSV 表格：' + e.message, true);
        return;
    }
    doc.loading = true;
    try {
        doc.editor.setMode('text');
        doc.editor.setText(text);
        doc.text = text;
        if (!doc.dirty && doc.bases.table == null) doc.bases.table = text;
        doc.mode = 'table';
        deps.currentMode = 'table';
        doc.tableUndo = [];
        doc.tableRedo = [];
        showCsvTableView(doc);
        deps.updateStatus();
        deps.updateSearchState();
    } catch (e) {
        deps.flash('切换表格视图失败：' + e.message, true);
    } finally {
        doc.loading = false;
    }
}

function leaveCsvTable(doc, mode) {
    if (!doc || !doc.editor) return;
    if (mode === 'text') {
        hideCsvTableView(doc);
        doc.mode = 'text';
        deps.currentMode = 'text';
        try {
            doc.editor.setMode('text');
        } catch (e) {}
        deps.updateStatus();
        deps.updateSearchState();
        return;
    }
    if (mode !== 'tree') return;
    const text = doc.editor.getText();
    let value;
    try {
        value = doc.format.parse(text);
    } catch (e) {
        deps.flash('CSV 解析失败：' + e.message, true);
        return;
    }
    doc.loading = true;
    try {
        doc.editor.setText(JSON.stringify(value, null, 2));
        doc.editor.setMode('tree');
        doc.editor.set(value);
        hideCsvTableView(doc);
        doc.mode = 'tree';
        deps.currentMode = 'tree';
        deps.updateStatus();
        deps.updateSearchState();
    } catch (e) {
        deps.flash('切换树视图失败：' + e.message, true);
    } finally {
        doc.loading = false;
    }
}

    return {
        createCsvTableView,
        ensureCsvView,
        renderCsvTableView,
        showCsvTableView,
        hideCsvTableView,
        enterCsvTable,
        leaveCsvTable,
        applyCsvTableZoom,
        zoomCsvTable,
        flushCsvCellEditor,
        closeCsvColumnStats,
        tableHistory,
    };
}
