// json-query.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// ---- JSONPath 查询栏 ----
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {buildJsonLineMap, queryJsonPath} from './jsonpath.js';

export function createJsonQuery(deps) {

const JSON_QUERY_FORMATS = new Set(['json', 'jsonl', 'yaml', 'toml', 'ini']);
const JSON_QUERY_LIMIT = 500;
const jsonQuery = {
    open: false,
    doc: null,
    rootValue: null,
    lineMap: new Map(),
    results: [],
    index: -1,
    seq: 0,
    timer: 0,
    previousFocus: null,
};

function jpEls() {
    return {
        mask: document.getElementById('jp-mask'),
        input: document.getElementById('jp-input'),
        list: document.getElementById('jp-list'),
        count: document.getElementById('jp-count'),
        root: document.getElementById('jp-root'),
    };
}

function jsonQuerySupported(doc) {
    return !!doc && !doc.binary && !doc.large && !!doc.format && JSON_QUERY_FORMATS.has(doc.format.id);
}

function jsonQueryValuePreview(value) {
    if (typeof value === 'string') {
        const quoted = JSON.stringify(value);
        return quoted.length > 220 ? quoted.slice(0, 220) + '…"' : quoted;
    }
    try {
        const text = JSON.stringify(value);
        return text.length > 220 ? text.slice(0, 220) + '…' : text;
    } catch (e) {
        return String(value);
    }
}

function showJsonQueryEmpty(text) {
    const {list} = jpEls();
    if (!list) return;
    list.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'gs-empty';
    empty.textContent = text;
    list.appendChild(empty);
}

function openJsonQuery() {
    const doc = deps.file;
    if (!jsonQuerySupported(doc)) {
        deps.flash('当前文件不支持 JSONPath 查询（JSON/JSONL/YAML/TOML/INI）', true);
        return;
    }
    const elsJp = jpEls();
    if (!elsJp.mask || !elsJp.input) return;
    const text = deps.structureTextForDoc(doc);
    let rootValue;
    try {
        rootValue = doc.format.parse(text);
    } catch (e) {
        deps.flash('解析失败：' + ((e && e.message) || e), true);
        return;
    }
    jsonQuery.open = true;
    jsonQuery.doc = doc;
    jsonQuery.rootValue = rootValue;
    jsonQuery.lineMap = doc.format.id === 'json' ? buildJsonLineMap(text) : new Map();
    jsonQuery.results = [];
    jsonQuery.index = -1;
    jsonQuery.seq++;
    jsonQuery.previousFocus = document.activeElement;
    elsJp.mask.classList.remove('hidden');
    elsJp.input.value = '';
    elsJp.count.textContent = '';
    const kind = Array.isArray(rootValue) ? '数组' : (rootValue && typeof rootValue === 'object' ? '对象' : typeof rootValue);
    elsJp.root.textContent = (doc.name || '') + ' · $ · ' + kind;
    showJsonQueryEmpty('输入 JSONPath 后按 Enter 查看结果');
    elsJp.input.focus();
}

function closeJsonQuery() {
    if (!jsonQuery.open) return;
    jsonQuery.open = false;
    clearTimeout(jsonQuery.timer);
    jsonQuery.seq++;
    const {mask} = jpEls();
    if (mask) mask.classList.add('hidden');
    const prev = jsonQuery.previousFocus;
    jsonQuery.previousFocus = null;
    if (prev && prev.isConnected && typeof prev.focus === 'function') {
        try { prev.focus(); } catch (e) {}
    }
}

function scheduleJsonQuery() {
    clearTimeout(jsonQuery.timer);
    jsonQuery.timer = setTimeout(runJsonQuery, 160);
}

function renderJsonQueryResults(matches, truncated) {
    const {list, count} = jpEls();
    if (!list) return;
    jsonQuery.results = matches;
    jsonQuery.index = matches.length ? 0 : -1;
    list.textContent = '';
    count.textContent = matches.length + ' 项' + (truncated ? '（仅显示前 ' + JSON_QUERY_LIMIT + '）' : '');
    if (!matches.length) {
        showJsonQueryEmpty('没有匹配结果');
        return;
    }
    matches.forEach((match, index) => {
        const row = document.createElement('div');
        row.className = 'gs-row jp-row' + (index === 0 ? ' selected' : '');
        row.dataset.i = String(index);
        row.setAttribute('role', 'option');
        const main = document.createElement('div');
        main.className = 'jp-main';
        const path = document.createElement('div');
        path.className = 'jp-path';
        path.textContent = match.path;
        const value = document.createElement('div');
        value.className = 'jp-value';
        value.textContent = jsonQueryValuePreview(match.value);
        main.append(path, value);
        const loc = jsonQuery.lineMap.get(match.path);
        const meta = document.createElement('span');
        meta.className = 'jp-meta';
        meta.textContent = loc ? '第 ' + loc.line + ' 行' : '';
        row.append(main, meta);
        row.addEventListener('click', () => openJsonQueryHit(index));
        row.addEventListener('mouseenter', () => setJsonQuerySelection(index));
        list.appendChild(row);
    });
}

function setJsonQuerySelection(index) {
    const {list} = jpEls();
    if (!list) return;
    const rows = list.querySelectorAll('.jp-row');
    jsonQuery.index = Math.max(0, Math.min(rows.length - 1, index));
    rows.forEach((row, i) => row.classList.toggle('selected', i === jsonQuery.index));
    const current = rows[jsonQuery.index];
    if (current && current.scrollIntoView) current.scrollIntoView({block: 'nearest'});
}

function runJsonQuery() {
    if (!jsonQuery.open) return;
    const {input, count} = jpEls();
    const expr = input ? input.value : '';
    const seq = ++jsonQuery.seq;
    if (!expr.trim()) {
        count.textContent = '';
        showJsonQueryEmpty('输入 JSONPath 后按 Enter 查看结果');
        return;
    }
    let matches;
    try {
        matches = queryJsonPath(jsonQuery.rootValue, expr);
    } catch (e) {
        count.textContent = '语法错误';
        showJsonQueryEmpty('JSONPath 无效：' + ((e && e.message) || e));
        return;
    }
    if (!jsonQuery.open || seq !== jsonQuery.seq) return;
    const truncated = matches.length > JSON_QUERY_LIMIT;
    renderJsonQueryResults(matches.slice(0, JSON_QUERY_LIMIT), truncated);
}

async function openJsonQueryHit(index) {
    const match = jsonQuery.results[index];
    if (!match) return;
    const doc = jsonQuery.doc;
    const loc = jsonQuery.lineMap.get(match.path);
    if (loc && doc && deps.docs.includes(doc)) {
        closeJsonQuery();
        await deps.selectLineInDoc(doc, loc.line, loc.column);
        return;
    }
    await deps.copyText(match.path, 'JSONPath 路径');
}

function handleJsonQueryKey(e) {
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeJsonQuery();
        return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setJsonQuerySelection(jsonQuery.index + (e.key === 'ArrowDown' ? 1 : -1));
        return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        openJsonQueryHit(jsonQuery.index);
    }
}

function bindJsonQuery() {
    const {input, mask} = jpEls();
    if (!input || !mask) return;
    input.addEventListener('input', scheduleJsonQuery);
    input.addEventListener('keydown', handleJsonQueryKey);
    mask.addEventListener('mousedown', (e) => {
        if (e.target === mask) closeJsonQuery();
    });
}
bindJsonQuery();


    return {jsonQuerySupported, openJsonQuery};
}
