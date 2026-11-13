// global-search.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {fileIconSpec} from './fileicons.js';

export function createGlobalSearch(deps) {

const globalSearch = {
    open: false,
    seq: 0,
    timer: 0,
    hits: [],
    index: -1,
    root: '',
    previousFocus: null,
};

function globalSearchRoot() {
    if (deps.workspaceFolder) return deps.workspaceFolder;
    if (deps.file && deps.file.path) {
        const s = String(deps.file.path).replace(/\\/g, '/');
        const i = s.lastIndexOf('/');
        if (i > 0) return s.slice(0, i);
    }
    return '';
}

function openGlobalSearch() {
    if (globalSearch.open) {
        deps.els.gsInput.focus();
        deps.els.gsInput.select();
        return;
    }
    const root = globalSearchRoot();
    if (!root) {
        deps.flash('请先打开文件夹或文件');
        return;
    }
    globalSearch.open = true;
    globalSearch.root = root;
    globalSearch.previousFocus = document.activeElement;
    globalSearch.hits = [];
    globalSearch.index = -1;
    deps.els.gsRoot.textContent = root;
    deps.els.gsInput.value = '';
    deps.els.gsCount.textContent = '';
    showGlobalSearchEmpty('输入内容，在打开的工作区中搜索文本');
    deps.els.gsMask.classList.remove('hidden');
    deps.els.gsInput.focus();
}

function closeGlobalSearch() {
    if (!globalSearch.open) return;
    globalSearch.open = false;
    clearTimeout(globalSearch.timer);
    globalSearch.seq++;
    deps.els.gsMask.classList.add('hidden');
    const prev = globalSearch.previousFocus;
    globalSearch.previousFocus = null;
    if (prev && prev.isConnected && typeof prev.focus === 'function') {
        try { prev.focus(); } catch (e) {}
    } else {
        deps.focusFindEditor();
    }
}

function showGlobalSearchEmpty(text) {
    deps.els.gsList.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'gs-empty';
    empty.textContent = text;
    deps.els.gsList.appendChild(empty);
}

function scheduleGlobalSearch() {
    clearTimeout(globalSearch.timer);
    globalSearch.timer = setTimeout(runGlobalSearch, 180);
}

async function runGlobalSearch() {
    if (!globalSearch.open) return;
    const query = deps.els.gsInput.value;
    const seq = ++globalSearch.seq;
    globalSearch.hits = [];
    globalSearch.index = -1;
    if (!query.trim()) {
        deps.els.gsCount.textContent = '';
        showGlobalSearchEmpty('输入内容，在打开的工作区中搜索文本');
        return;
    }
    deps.els.gsCount.textContent = '搜索中…';
    try {
        const res = await deps.backend.SearchWorkspace(globalSearch.root, query, false, 400);
        if (!globalSearch.open || seq !== globalSearch.seq) return;
        renderGlobalSearchResults(res || {hits: []});
    } catch (e) {
        if (seq !== globalSearch.seq) return;
        deps.els.gsCount.textContent = '搜索失败';
        showGlobalSearchEmpty('搜索失败：' + e);
    }
}

function globalSearchRow(hit, index) {
    const row = document.createElement('div');
    row.className = 'gs-row';
    row.dataset.i = String(index);
    row.setAttribute('role', 'option');
    const icon = document.createElement('span');
    icon.className = 'gs-file-icon';
    try {
        const spec = fileIconSpec(hit.name);
        icon.innerHTML = spec.svg;
        icon.classList.add(spec.className);
    } catch (e) {}
    const main = document.createElement('div');
    main.className = 'gs-main';
    const line1 = document.createElement('div');
    line1.className = 'gs-line1';
    const name = document.createElement('span');
    name.className = 'gs-name';
    name.textContent = hit.name || '';
    const dir = document.createElement('span');
    dir.className = 'gs-dir';
    dir.textContent = hit.dir || '';
    line1.append(name, dir);
    const line2 = document.createElement('div');
    line2.className = 'gs-line2';
    const ln = document.createElement('span');
    ln.className = 'gs-ln';
    ln.textContent = String(hit.line || '');
    const preview = document.createElement('span');
    preview.className = 'gs-preview';
    const text = String(hit.preview == null ? '' : hit.preview);
    const start = Math.max(0, Math.min(Number(hit.matchStart) || 0, text.length));
    const end = Math.max(start, Math.min(Number(hit.matchEnd) || 0, text.length));
    if (start > 0) preview.appendChild(document.createTextNode(text.slice(0, start)));
    if (end > start) {
        const mark = document.createElement('mark');
        mark.textContent = text.slice(start, end);
        preview.appendChild(mark);
    }
    if (end < text.length) preview.appendChild(document.createTextNode(text.slice(end)));
    line2.append(ln, preview);
    main.append(line1, line2);
    row.append(icon, main);
    row.addEventListener('click', () => {
        globalSearch.index = index;
        updateGlobalSearchSelection();
        openGlobalSearchHit(hit);
    });
    return row;
}

function renderGlobalSearchResults(res) {
    const hits = Array.isArray(res.hits) ? res.hits : [];
    globalSearch.hits = hits;
    globalSearch.index = hits.length ? 0 : -1;
    deps.els.gsList.textContent = '';
    if (!hits.length) {
        deps.els.gsCount.textContent = '0 个结果';
        showGlobalSearchEmpty('未找到匹配内容');
        return;
    }
    const fragment = document.createDocumentFragment();
    hits.forEach((hit, i) => fragment.appendChild(globalSearchRow(hit, i)));
    deps.els.gsList.appendChild(fragment);
    deps.els.gsCount.textContent = hits.length + ' 个结果' + (res.truncated ? '（仅显示前 ' + hits.length + ' 个）' : '');
    updateGlobalSearchSelection();
}

function updateGlobalSearchSelection() {
    const rows = deps.els.gsList.querySelectorAll('.gs-row');
    for (let i = 0; i < rows.length; i++) {
        const selected = i === globalSearch.index;
        rows[i].classList.toggle('selected', selected);
        rows[i].setAttribute('aria-selected', selected ? 'true' : 'false');
        if (selected) rows[i].scrollIntoView({block: 'nearest'});
    }
}

function moveGlobalSearchSelection(delta) {
    const total = globalSearch.hits.length;
    if (!total) return;
    globalSearch.index = ((globalSearch.index + delta) % total + total) % total;
    updateGlobalSearchSelection();
}

async function selectMatchInDoc(doc, line, column = 1, length = 1) {
    if (!doc || doc.binary || !doc.editor) return;
    if (doc !== deps.file) await deps.activateDoc(doc);
    const mode = doc.format && doc.format.table ? 'text' : 'code';
    if (deps.currentMode !== mode) deps.switchMode(mode);
    if (mode === 'code') {
        const ready = await deps.waitUntil(() => doc.editor && doc.editor.aceEditor);
        if (!ready) return;
        const ace = doc.editor.aceEditor;
        const lineNo = Math.max(1, Math.min(Number(line) || 1, ace.session.getLength()));
        const col = Math.max(0, (Number(column) || 1) - 1);
        const len = Math.max(1, Number(length) || 1);
        ace.gotoLine(lineNo, col, false);
        ace.selection.setSelectionRange({
            start: {row: lineNo - 1, column: col},
            end: {row: lineNo - 1, column: col + len},
        }, false);
        ace.scrollToLine(lineNo, true, true, () => {});
        ace.focus();
        return;
    }
    const ready = await deps.waitUntil(() => doc.pane && doc.pane.querySelector('textarea.jsoneditor-text'));
    if (!ready) return;
    const textarea = doc.pane.querySelector('textarea.jsoneditor-text');
    const lines = textarea.value.split('\n');
    const index = Math.max(0, Math.min((Number(line) || 1) - 1, lines.length - 1));
    let start = 0;
    for (let i = 0; i < index; i++) start += lines[i].length + 1;
    const lineStart = start;
    start += Math.max(0, (Number(column) || 1) - 1);
    const end = Math.min(start + Math.max(1, Number(length) || 1), lineStart + lines[index].length);
    textarea.focus();
    textarea.setSelectionRange(start, Math.max(start, end));
    const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 18;
    textarea.scrollTop = Math.max(0, index * lineHeight - textarea.clientHeight / 2);
}

async function openGlobalSearchHit(hit) {
    if (!hit || !hit.path) return;
    closeGlobalSearch();
    try {
        await deps.openPaths([hit.path]);
        const doc = deps.findDocByPath(hit.path);
        if (doc) await selectMatchInDoc(doc, hit.line, hit.column, hit.length);
    } catch (e) {
        deps.flash('打开失败：' + e, true);
    }
}

function handleGlobalSearchKey(e) {
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeGlobalSearch();
        return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        moveGlobalSearchSelection(e.key === 'ArrowDown' ? 1 : -1);
        return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        if (globalSearch.hits.length) openGlobalSearchHit(globalSearch.hits[globalSearch.index]);
    }
}

function bindGlobalSearch() {
    deps.els.gsInput.addEventListener('input', scheduleGlobalSearch);
    deps.els.gsInput.addEventListener('keydown', handleGlobalSearchKey);
    deps.els.gsMask.addEventListener('mousedown', (e) => {
        if (e.target === deps.els.gsMask) closeGlobalSearch();
    });
}
bindGlobalSearch();


    return {isGlobalSearchOpen: () => globalSearch.open, openGlobalSearch};
}
