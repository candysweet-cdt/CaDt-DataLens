// find-bar.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。


export function createFindBar(deps) {

const findState = {
    open: false,
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    ranges: [],
    index: -1,
    target: null,
    markerIds: [],
    aceSession: null,
    aceChangeHandler: null,
    host: null,
    textLayer: null,
    textInner: null,
    textMarkerEls: [],
    textScrollTarget: null,
    textScrollHandler: null,
    textResizeObserver: null,
    timer: 0,
};
const findMarkerLimit = 2000;

function findTarget() {
    if (!deps.file || !deps.file.editor) return null;
    if (deps.file.sqlActive) return null; // SQL 覆盖层打开时不可用编辑器查找
    if (deps.currentMode === 'code') {
        const ace = deps.file.editor.aceEditor;
        return ace ? {type: 'ace', ace} : null;
    }
    if (deps.currentMode === 'text') {
        const textarea = deps.file.pane && deps.file.pane.querySelector('textarea.jsoneditor-text');
        return textarea ? {type: 'text', textarea} : null;
    }
    return null;
}

function ensureFindBarHost() {
    const group = deps.file ? deps.groupOfDoc(deps.file.id) : null;
    const host = group ? deps.els.editor.querySelector('.egroup[data-gid="' + group.id + '"] .ehost') : null;
    const target = host || deps.els.editor;
    if (!target) return;
    const hostChanged = findState.host !== target;
    if (findState.host && findState.host !== target) findState.host.classList.remove('find-open');
    target.classList.add('find-open');
    findState.host = target;
    if (deps.els.findBar.parentElement !== target) target.appendChild(deps.els.findBar);
    if (hostChanged) resizeFindEditor();
}

function resizeFindEditor() {
    requestAnimationFrame(() => {
        if (!deps.file || !deps.file.editor) return;
        try {
            if (deps.file.editor.resize) deps.file.editor.resize();
            if (deps.file.editor.aceEditor) deps.file.editor.aceEditor.resize();
        } catch (e) {}
    });
}

function clearFindMarkers() {
    const target = findState.target;
    if (target && target.type === 'ace') {
        const session = target.ace.session;
        for (const id of findState.markerIds) {
            try { session.removeMarker(id); } catch (e) {}
        }
    }
    findState.markerIds = [];
}

function detachFindAceChange() {
    if (findState.aceSession && findState.aceChangeHandler) {
        try { findState.aceSession.off('change', findState.aceChangeHandler); } catch (e) {}
    }
    findState.aceSession = null;
    findState.aceChangeHandler = null;
}

function clearTextFindLayer() {
    if (findState.textScrollTarget && findState.textScrollHandler) {
        findState.textScrollTarget.removeEventListener('scroll', findState.textScrollHandler);
    }
    if (findState.textResizeObserver) {
        findState.textResizeObserver.disconnect();
        findState.textResizeObserver = null;
    }
    findState.textScrollTarget = null;
    findState.textScrollHandler = null;
    if (findState.textLayer) {
        findState.textLayer.remove();
        findState.textLayer = null;
    }
    findState.textInner = null;
    findState.textMarkerEls = [];
}

function syncFindTextLayerScroll() {
    const textarea = findState.textScrollTarget;
    if (!findState.textInner || !textarea) return;
    findState.textInner.style.transform = 'translate(' + (-textarea.scrollLeft) + 'px,' + (-textarea.scrollTop) + 'px)';
}

function positionFindTextLayer() {
    const layer = findState.textLayer;
    const textarea = findState.textScrollTarget;
    const host = findState.host;
    if (!layer || !textarea || !host) return;
    const hostRect = host.getBoundingClientRect();
    const rect = textarea.getBoundingClientRect();
    layer.style.left = (rect.left - hostRect.left) + 'px';
    layer.style.top = (rect.top - hostRect.top) + 'px';
    layer.style.width = textarea.clientWidth + 'px';
    layer.style.height = textarea.clientHeight + 'px';
    if (findState.textInner) findState.textInner.style.width = textarea.clientWidth + 'px';
}

function buildTextFindLayer(target) {
    clearTextFindLayer();
    const textarea = target.textarea;
    const host = findState.host;
    const ranges = findState.ranges;
    if (!textarea || !host || !ranges.length || textarea.value.length > 1500000) return;
    const layer = document.createElement('div');
    layer.className = 'find-text-layer';
    layer.setAttribute('aria-hidden', 'true');
    const inner = document.createElement('div');
    inner.className = 'find-text-layer-inner';
    const style = getComputedStyle(textarea);
    const copied = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing',
        'wordSpacing', 'textAlign', 'textIndent', 'textTransform', 'whiteSpace', 'wordBreak',
        'overflowWrap', 'tabSize', 'direction'];
    for (const prop of copied) inner.style[prop] = style[prop];
    inner.style.padding = style.padding;
    inner.style.minHeight = textarea.clientHeight + 'px';
    const text = textarea.value;
    const fragment = document.createDocumentFragment();
    const marks = [];
    let pos = 0;
    const limit = Math.min(ranges.length, findMarkerLimit);
    for (let i = 0; i < limit; i++) {
        const range = ranges[i];
        if (range.start < pos) continue;
        fragment.appendChild(document.createTextNode(text.slice(pos, range.start)));
        const mark = document.createElement('mark');
        mark.textContent = text.slice(range.start, range.end);
        if (i === findState.index) mark.classList.add('current');
        fragment.appendChild(mark);
        marks.push(mark);
        pos = range.end;
    }
    fragment.appendChild(document.createTextNode(text.slice(pos)));
    inner.appendChild(fragment);
    layer.appendChild(inner);
    host.appendChild(layer);
    findState.textLayer = layer;
    findState.textInner = inner;
    findState.textMarkerEls = marks;
    findState.textScrollTarget = textarea;
    findState.textScrollHandler = () => syncFindTextLayerScroll();
    textarea.addEventListener('scroll', findState.textScrollHandler, {passive: true});
    if (window.ResizeObserver) {
        findState.textResizeObserver = new ResizeObserver(() => positionFindTextLayer());
        findState.textResizeObserver.observe(textarea);
    }
    positionFindTextLayer();
    syncFindTextLayerScroll();
}

function aceFindRanges(ace) {
    const search = ace.$search;
    if (!search) return [];
    search.set({
        needle: deps.els.findInput.value,
        caseSensitive: findState.caseSensitive,
        wholeWord: findState.wholeWord,
        regExp: findState.regex,
        wrap: false,
        skipCurrent: false,
    });
    return search.findAll(ace.session) || [];
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textFindRanges(text) {
    const query = deps.els.findInput.value;
    if (!query) return [];
    let pattern;
    if (findState.regex) {
        pattern = findState.wholeWord ? '\\b(?:' + query + ')\\b' : query;
    } else {
        const escaped = escapeRegExp(query);
        pattern = findState.wholeWord ? '\\b' + escaped + '\\b' : escaped;
    }
    const re = new RegExp(pattern, findState.caseSensitive ? 'g' : 'gi');
    const ranges = [];
    let match;
    while ((match = re.exec(text)) !== null) {
        if (!match[0].length) {
            re.lastIndex += 1;
            continue;
        }
        ranges.push({start: match.index, end: match.index + match[0].length});
        if (ranges.length >= 20000) break;
    }
    return ranges;
}

function updateFindNav() {
    const has = findState.ranges.length > 0;
    deps.els.findPrev.disabled = !has;
    deps.els.findNext.disabled = !has;
}

function updateFindCount() {
    if (!deps.els.findCount.classList.contains('error')) {
        deps.els.findCount.textContent = findState.ranges.length + ' 个结果';
    }
    updateFindNav();
}

function selectFindMatch(index, opts = {}) {
    const target = findState.target;
    const total = findState.ranges.length;
    if (!target || !total) {
        updateFindCount();
        return;
    }
    findState.index = ((index % total) + total) % total;
    const range = findState.ranges[findState.index];
    if (target.type === 'ace') {
        target.ace.selection.setSelectionRange(range, false);
        if (opts.scroll !== false) target.ace.scrollToLine(range.start.row, true, true);
    } else {
        const textarea = target.textarea;
        textarea.setSelectionRange(range.start, range.end);
        if (opts.scroll !== false) {
            const before = textarea.value.slice(0, range.start);
            const line = before.split('\n').length;
            const style = getComputedStyle(textarea);
            const lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 13) * 1.5;
            const top = (line - 1) * lineHeight - textarea.clientHeight / 2 + lineHeight / 2;
            textarea.scrollTop = Math.max(0, Math.min(top, textarea.scrollHeight - textarea.clientHeight));
        }
        for (let i = 0; i < findState.textMarkerEls.length; i++) {
            findState.textMarkerEls[i].classList.toggle('current', i === findState.index);
        }
        syncFindTextLayerScroll();
    }
    updateFindCount();
}

function runFind(opts = {}) {
    if (!findState.open) return;
    const target = findTarget();
    if (!target) {
        closeFindBar({keepFocus: true});
        return;
    }
    ensureFindBarHost();
    clearFindMarkers();
    clearTextFindLayer();
    const previousIndex = findState.index;
    findState.target = target;
    if (target.type === 'ace') {
        const session = target.ace.session;
        if (findState.aceSession !== session) {
            detachFindAceChange();
            const handler = () => {
                if (findState.open && findState.target === target) scheduleFind();
            };
            session.on('change', handler);
            findState.aceSession = session;
            findState.aceChangeHandler = handler;
        }
    } else {
        detachFindAceChange();
    }
    findState.ranges = [];
    findState.index = -1;
    deps.els.findCount.classList.remove('error');
    if (!deps.els.findInput.value) {
        updateFindCount();
        return;
    }
    if (findState.regex) {
        try {
            new RegExp(deps.els.findInput.value);
        } catch (e) {
            deps.els.findCount.textContent = '正则表达式无效';
            deps.els.findCount.classList.add('error');
            updateFindNav();
            return;
        }
    }
    try {
        findState.ranges = target.type === 'ace' ? aceFindRanges(target.ace) : textFindRanges(target.textarea.value);
    } catch (e) {
        deps.els.findCount.textContent = '正则表达式无效';
        deps.els.findCount.classList.add('error');
        updateFindNav();
        return;
    }
    if (target.type === 'ace' && findState.ranges.length) {
        const session = target.ace.session;
        const limit = Math.min(findState.ranges.length, findMarkerLimit);
        for (let i = 0; i < limit; i++) {
            findState.markerIds.push(session.addMarker(findState.ranges[i], 'cadt-find-match', 'text', false));
        }
    }
    if (target.type === 'text' && findState.ranges.length) buildTextFindLayer(target);
    if (!findState.ranges.length) {
        updateFindCount();
        return;
    }
    const keep = opts.keepIndex && previousIndex >= 0 && previousIndex < findState.ranges.length ? previousIndex : 0;
    selectFindMatch(keep, {scroll: true});
}

function stepFind(delta) {
    if (!findState.open || !findState.ranges.length) return;
    selectFindMatch(findState.index + delta, {scroll: true});
}

function scheduleFind() {
    clearTimeout(findState.timer);
    findState.timer = setTimeout(() => {
        findState.timer = 0;
        runFind({keepIndex: false});
    }, 80);
}

function selectedFindText() {
    const target = findTarget();
    if (!target) return '';
    if (target.type === 'ace') return target.ace.getSelectedText() || '';
    const textarea = target.textarea;
    return textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
}

function focusFindEditor() {
    if (deps.currentMode === 'code' && deps.file && deps.file.editor && deps.file.editor.aceEditor) {
        deps.file.editor.aceEditor.focus();
    } else if (deps.currentMode === 'text' && deps.file && deps.file.pane) {
        const textarea = deps.file.pane.querySelector('textarea.jsoneditor-text');
        if (textarea) textarea.focus();
    }
}

function openFindBar() {
    if (!findTarget()) {
        deps.flash('内容搜索请在代码视图或文本视图中使用');
        return;
    }
    if (findState.open) {
        deps.els.findInput.focus();
        deps.els.findInput.select();
        return;
    }
    ensureFindBarHost();
    findState.open = true;
    deps.els.findBar.classList.remove('hidden');
    deps.els.abSearch.classList.add('active');
    const selected = selectedFindText();
    if (selected && selected.length <= 200 && !/[\r\n]/.test(selected)) {
        deps.els.findInput.value = selected;
    }
    deps.els.findInput.focus();
    deps.els.findInput.select();
    runFind({keepIndex: false});
}

function closeFindBar(opts = {}) {
    if (!findState.open) return;
    findState.open = false;
    clearFindMarkers();
    clearTextFindLayer();
    detachFindAceChange();
    findState.target = null;
    findState.ranges = [];
    findState.index = -1;
    if (findState.host) {
        findState.host.classList.remove('find-open');
        findState.host = null;
    }
    deps.els.findBar.classList.add('hidden');
    if (deps.els.abSearch) deps.els.abSearch.classList.remove('active');
    resizeFindEditor();
    if (!opts.keepFocus) focusFindEditor();
}

function bindFindBar() {
    deps.els.findBar.addEventListener('keydown', (e) => {
        if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey && !e.ctrlKey && !e.metaKey &&
            !e.shiftKey && findState.ranges.length) {
            e.preventDefault();
            e.stopPropagation();
            stepFind(e.key === 'ArrowUp' ? -1 : 1);
        }
    });
    deps.els.findInput.addEventListener('input', scheduleFind);
    deps.els.findInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            stepFind(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeFindBar();
        }
    });
    deps.els.findPrev.addEventListener('click', () => stepFind(-1));
    deps.els.findNext.addEventListener('click', () => stepFind(1));
    deps.els.findClose.addEventListener('click', () => closeFindBar());
    const options = [
        [deps.els.findCase, 'caseSensitive'],
        [deps.els.findWord, 'wholeWord'],
        [deps.els.findRegex, 'regex'],
    ];
    for (const [button, key] of options) {
        button.addEventListener('click', () => {
            findState[key] = !findState[key];
            button.classList.toggle('active', findState[key]);
            button.setAttribute('aria-pressed', String(findState[key]));
            deps.els.findInput.focus();
            runFind({keepIndex: true});
        });
    }
    deps.els.findPrev.disabled = true;
    deps.els.findNext.disabled = true;
}

bindFindBar();


    return {closeFindBar, ensureFindBarHost, findTarget, focusFindEditor, openFindBar, runFind};
}
