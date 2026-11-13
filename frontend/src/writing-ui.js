// writing-ui.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// 写作模式
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {WRITING_FONTS, formatWritingText, genName, SCENE_SEPARATOR} from './writing.js';
import {RECIPES, SELF_TEST} from './run.js';
import {initPluginRuntime, loadPlugins} from './plugins.js';
import {iconSvg} from './icons.js';
import {aceModeFor, formats} from './formats.js';
import {createMarkdownRenderer} from './markdown.js';

export function createWritingUI(deps) {


let writingLastSig = '';
let writingPrevFamily = '';
let writingSwitchWasOn = !!deps.settings.writingMode; // 跟踪总开关本身；视图/文档临时切换不重置「本次」基线
let writingCaretRaf = 0;
let writingCaretTimer = 0;

// 生效条件：总开关开启 + 当前文档为 text/markdown + 处于源码/分屏视图（不满足时样式行为自动退避）
function writingActive() {
    return !!deps.settings.writingMode && !!deps.file && !deps.file.binary && !deps.file.large
        && !!deps.file.format && (deps.file.format.id === 'text' || deps.file.format.id === 'markdown')
        && (deps.currentMode === 'code' || deps.currentMode === 'text' || deps.currentMode === 'split');
}

function editorFontFamilyVar() {
    const editorFace = deps.editorFonts.find((f) => f.id === deps.settings.editorFontFamily) || deps.editorFonts[0];
    const editorCjk = deps.cjkFonts.find((f) => f.id === deps.settings.editorCjkFont) || deps.cjkFonts[0];
    return editorFace.family + ', ' + editorCjk.family + ', monospace';
}

// applyWritingMode：data-writing 属性 + 字体/字号 CSS 变量 + 逐 doc 的 Ace 字号/行号/边距
// 由 applySettings 尾部与 updateStatus（模式/文档切换）调用；签名未变时跳过
function applyWritingMode() {
    // 总开关切换才重置基线（本次/今日从开启时刻起算）；必须放在签名早返回之前，
    // 否则在非生效文档/视图上关→开时 sig 不变，重置被跳过，切回正文仍累计上一轮。
    if (!!deps.settings.writingMode !== writingSwitchWasOn) {
        writingSwitchWasOn = !!deps.settings.writingMode;
        for (const d of deps.docs) {
            delete d._writingBase;
            delete d._writingLast;
        }
    }
    const on = writingActive();
    const paper = on ? (deps.settings.writingPaper || 'off') : 'off';
    const face = on ? (WRITING_FONTS.find((f) => f.id === deps.settings.writingFont) || WRITING_FONTS[0]) : null;
    const size = on ? deps.settings.writingFontSize : deps.settings.editorFont;
    const showLines = on ? !!deps.settings.writingLineNumbers : true;
    const sig = [on ? '1' : '0', paper, face ? face.id : 'follow', size, showLines ? '1' : '0',
        deps.settings.writingFocus ? '1' : '0', deps.settings.writingTypewriter ? '1' : '0',
        deps.file ? (deps.file.path || deps.file.name) : '', deps.currentMode].join('|');
    if (sig === writingLastSig) return;
    writingLastSig = sig;

    const root = document.documentElement;
    if (on) {
        root.dataset.writing = 'on';
        if (paper !== 'off') root.dataset.writingPaper = paper;
        else delete root.dataset.writingPaper;
    } else {
        root.dataset.writing = 'off';
        delete root.dataset.writingPaper;
    }
    // 字体族：只替换 CJK 部分，拉丁保持编辑器主字体；follow = 不改族
    const family = on && face && face.family
        ? (deps.editorFonts.find((f) => f.id === deps.settings.editorFontFamily) || deps.editorFonts[0]).family + ', ' + face.family + ', monospace'
        : editorFontFamilyVar();
    document.documentElement.style.setProperty('--editor-font', size + 'px');
    document.documentElement.style.setProperty('--editor-font-family', family);
    if (!on || !deps.settings.writingFocus) {
        for (const d of deps.docs) clearWritingMarkers(d);
    }

    // 逐 doc 应用 Ace：字号、行号；族/字号变化后必须 resize 重排版，否则光标错位
    const familyChanged = family !== writingPrevFamily;
    writingPrevFamily = family;
    let sizeChanged = false;
    for (const d of deps.docs) {
        const ace = d.editor && d.editor.aceEditor;
        if (!ace) continue;
        try {
            if (ace.getFontSize() !== size) {
                ace.setFontSize(size);
                sizeChanged = true;
            }
            ace.setOption('showLineNumbers', showLines);
        } catch (e) {}
    }
    if (familyChanged || sizeChanged) {
        for (const d of deps.docs) {
            const ace = d.editor && d.editor.aceEditor;
            if (ace) {
                try {
                    ace.renderer.setPadding(on ? 40 : 0);
                    ace.resize();
                } catch (e) {}
            }
        }
    } else {
        for (const d of deps.docs) {
            const ace = d.editor && d.editor.aceEditor;
            if (ace) {
                try { ace.renderer.setPadding(on ? 40 : 0); } catch (e) {}
            }
        }
    }
    if (on) {
        // 开关/视图切换后立即建立统计基线并显示状态栏，不等第一次输入
        updateWritingStats();
        scheduleWritingCaret();
    } else if (deps.els.stWriting) deps.els.stWriting.style.display = 'none';
}

// ---- 专注模式：打字机滚动 + 段落聚焦 ----

// 仅 Ace（code/split 左栏）；text 视图为 textarea，v1 不做打字机/聚焦
function scheduleWritingCaret(aceArg) {
    const doc = deps.file;
    if (!doc || !doc.editor || !writingActive()) return;
    const ace = doc.editor.aceEditor;
    if (!ace) return;
    if (aceArg && aceArg !== ace) return; // 背景文档的事件不作用到当前编辑器
    if (deps.currentMode === 'text' && !doc.splitActive) return;
    if (deps.settings.writingTypewriter) {
        if (writingCaretRaf) cancelAnimationFrame(writingCaretRaf);
        writingCaretRaf = requestAnimationFrame(() => {
            writingCaretRaf = 0;
            writingTypewriterScroll(ace);
        });
    }
    clearTimeout(writingCaretTimer);
    writingCaretTimer = setTimeout(() => writingFocusParagraph(ace), 150);
}

function writingTypewriterScroll(ace) {
    if (!deps.settings.writingTypewriter || !writingActive()) return;
    try {
        const session = ace.session;
        const pos = ace.getCursorPosition();
        const screenRow = session.documentToScreenRow(pos.row, pos.column);
        const lineHeight = Number(ace.renderer.lineHeight) || (() => {
            const el = ace.container.querySelector('.ace_line');
            return el ? parseFloat(getComputedStyle(el).lineHeight) || 20 : 20;
        })();
        const pad = Number(ace.renderer.$padding) || 0;
        const scroller = ace.renderer.scroller;
        const target = pad + screenRow * lineHeight + lineHeight / 2 - (scroller ? scroller.clientHeight : 0) / 2;
        if (Math.abs(session.getScrollTop() - target) > 2) session.setScrollTop(Math.max(0, target));
    } catch (e) {}
}

function writingRangeClass(aceInstance) {
    // vendored Ace 暴露在 window.ace；编辑器实例本身没有 Range/require
    if (aceInstance.Range) return aceInstance.Range;
    const g = window.ace;
    if (g && g.require) {
        try { return g.require('ace/range').Range; } catch (e) {}
    }
    try { return aceInstance.require && aceInstance.require('ace/range').Range || null; } catch (e) { return null; }
}

function clearWritingMarkers(doc) {
    const marks = doc && doc._writingMarkers;
    if (!marks) return;
    doc._writingMarkers = null;
    const ace = doc.editor && doc.editor.aceEditor;
    if (!ace) return;
    try {
        if (marks.top) ace.session.removeMarker(marks.top);
        if (marks.bottom) ace.session.removeMarker(marks.bottom);
    } catch (e) {}
}

// 段落聚焦：当前段落外上下两个全行遮罩 marker（inFront，用主题底色半透明盖住实现淡出）
function writingFocusParagraph(ace) {
    const doc = deps.file;
    if (!doc || !doc.editor || doc.editor.aceEditor !== ace) return;
    if (!writingActive() || !deps.settings.writingFocus) {
        clearWritingMarkers(doc);
        return;
    }
    try {
        const session = ace.session;
        const total = session.getLength();
        const row = ace.getCursorPosition().row;
        const emptyLine = (r) => !String(session.getLine(r) || '').trim();
        let paraStart = row;
        while (paraStart > 0 && !emptyLine(paraStart - 1)) paraStart--;
        let paraEnd = row;
        while (paraEnd < total - 1 && !emptyLine(paraEnd + 1)) paraEnd++;
        const marks = doc._writingMarkers;
        if (marks && marks.session === session && marks.paraStart === paraStart && marks.paraEnd === paraEnd) return;
        clearWritingMarkers(doc);
        const Range = writingRangeClass(ace);
        if (!Range) return;
        const top = paraStart > 0
            ? session.addMarker(new Range(0, 0, paraStart - 1, 0), 'writing-dim', 'fullLine', true) : 0;
        const bottom = paraEnd < total - 1
            ? session.addMarker(new Range(paraEnd + 1, 0, total - 1, 0), 'writing-dim', 'fullLine', true) : 0;
        doc._writingMarkers = {top, bottom, paraStart, paraEnd, session};
    } catch (e) {}
}

// ---- 码字统计 ----

const WRITING_DAILY_KEY = 'datalens-writing-daily';
let writingSpeedSamples = []; // {t, chars} 正增量采样

function writingTodayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function loadWritingDaily() {
    let store = null;
    try {
        store = JSON.parse(localStorage.getItem(WRITING_DAILY_KEY) || 'null');
    } catch (e) {}
    const today = writingTodayStr();
    if (!store || store.date !== today || typeof store.count !== 'number') {
        store = {date: today, count: 0, goalHit: false};
    }
    return store;
}

function saveWritingDaily(store) {
    try {
        localStorage.setItem(WRITING_DAILY_KEY, JSON.stringify(store));
    } catch (e) {}
}

// 挂在字数防抖管线与 updateStatus 上；写作模式生效时累计今日/本次增量
function updateWritingStats() {
    const doc = deps.file;
    const active = writingActive();
    if (!doc || !doc.editor || doc.binary || doc.large) {
        updateWritingStatusBar(0, false);
        return;
    }
    // doc.text 由 markDocDirty 随每次编辑维护，避免再拉一次全文；缺失时兜底 getText
    const total = deps.countWords(doc.text != null ? doc.text : doc.editor.getText());
    if (!active) {
        // 仅清观察基线；_writingBase 保留，切回写作视图时「本次」继续累计
        if (doc._writingLast != null) delete doc._writingLast;
        updateWritingStatusBar(total, false);
        return;
    }
    // 首次观察：只记基线不计增量；其后 delta = 当前全文 − 上次观察
    if (typeof doc._writingLast !== 'number') {
        doc._writingLast = total;
        if (typeof doc._writingBase !== 'number') doc._writingBase = total;
    } else {
        const delta = total - doc._writingLast;
        doc._writingLast = total;
        if (delta !== 0) {
            const store = loadWritingDaily();
            store.count = Math.max(0, store.count + delta);
            const goal = Number(deps.settings.writingDailyGoal) || 0;
            if (goal > 0 && !store.goalHit && store.count >= goal) {
                store.goalHit = true;
                flash('今日目标达成 🎉');
            }
            saveWritingDaily(store);
            if (delta > 0) {
                writingSpeedSamples.push({t: Date.now(), chars: delta});
                if (writingSpeedSamples.length > 600) writingSpeedSamples.splice(0, writingSpeedSamples.length - 600);
            }
        }
    }
    updateWritingStatusBar(total, true);
}

function writingSpeedPerMin() {
    const now = Date.now();
    writingSpeedSamples = writingSpeedSamples.filter((s) => now - s.t <= 5 * 60 * 1000);
    let sum = 0;
    for (const s of writingSpeedSamples) sum += s.chars;
    return Math.round(sum / 5);
}

function writingSessionSum(total) {
    return deps.file && typeof deps.file._writingBase === 'number' ? Math.max(0, total - deps.file._writingBase) : 0;
}

function updateWritingStatusBar(total, active) {
    const el = deps.els.stWriting;
    if (!el) return;
    if (!active) {
        el.style.display = 'none';
        el.textContent = '';
        return;
    }
    const store = loadWritingDaily();
    const goal = Number(deps.settings.writingDailyGoal) || 0;
    const text = '今日 ' + Math.max(0, store.count) + (goal > 0 ? '/' + goal : '') + ' · 本次 +' + writingSessionSum(total);
    if (el.textContent !== text) el.textContent = text;
    el.style.display = '';
}

function openWritingStatsDialog() {
    if (!writingActive() || !deps.file || !deps.file.editor) return;
    const total = deps.countWords(deps.file.editor.getText());
    const store = loadWritingDaily();
    const goal = Number(deps.settings.writingDailyGoal) || 0;
    deps.elsDialogs.writingToday.textContent = String(Math.max(0, store.count));
    deps.elsDialogs.writingSession.textContent = '+' + writingSessionSum(total);
    deps.elsDialogs.writingSpeed.textContent = String(writingSpeedPerMin());
    deps.elsDialogs.writingTotal.textContent = String(total);
    deps.elsDialogs.writingGoalBar.style.display = goal > 0 ? '' : 'none';
    deps.elsDialogs.writingGoalFill.style.width = goal > 0 ? Math.min(100, Math.round(store.count / goal * 100)) + '%' : '0';
    deps.elsDialogs.writingGoalInput.value = goal > 0 ? String(goal) : '';
    deps.openDialogEl(deps.elsDialogs.writing);
}

function saveWritingGoal() {
    const goal = Math.max(0, Number(deps.elsDialogs.writingGoalInput.value) || 0);
    deps.settings.writingDailyGoal = goal;
    const store = loadWritingDaily();
    store.goalHit = goal > 0 && store.count >= goal;
    saveWritingDaily(store);
    deps.applySettings();
    updateWritingStats();
    flash(goal > 0 ? '每日目标已保存：' + goal + ' 字' : '每日目标已关闭');
    openWritingStatsDialog();
}

// ---- 动作：开关 / 一键排版 / 起名器 / 场景分隔符 ----

function toggleWritingMode() {
    deps.settings.writingMode = !deps.settings.writingMode;
    deps.applySettings();
    flash(deps.settings.writingMode ? '写作模式已开启' : '写作模式已关闭');
}

function writingFormatable() {
    return !!deps.file && !!deps.file.editor && !deps.file.binary && !deps.file.large
        && !!deps.file.format && (deps.file.format.id === 'text' || deps.file.format.id === 'markdown');
}

// 一键排版：writing.js 纯函数 transform → setText + markDocDirty
function applyWritingFormat(indent) {
    if (!writingFormatable()) return;
    if (indent && deps.file.format.id !== 'text') return;
    const doc = deps.file;
    const isMd = doc.format.id === 'markdown';
    const res = formatWritingText(doc.editor.getText(), {markdown: isMd, indent: !!indent});
    const parts = [];
    if (res.trailing) parts.push('去 ' + res.trailing + ' 处行尾空白');
    if (res.leading) parts.push('清 ' + res.leading + ' 处行首空白');
    if (res.collapsed) parts.push('收敛 ' + res.collapsed + ' 处空行');
    if (res.indented) parts.push('缩进 ' + res.indented + ' 段');
    if (!parts.length) {
        flash('未发现需要整理的内容');
        return;
    }
    const loading = doc.loading;
    doc.loading = true;
    try {
        doc.editor.setText(res.text);
        doc.text = res.text;
    } catch (e) {
        flash('排版失败：' + e.message, true);
        return;
    } finally {
        doc.loading = loading;
    }
    deps.markDocDirty(doc);
    // 整页预览模式下底层编辑器仍存活但预览不随 setText 自动刷新，手动重渲染
    if (deps.currentMode === 'preview' && doc.format && doc.format.preview) deps.renderMarkdownPreview(doc);
    // jsoneditor setText 会清空撤销历史（vendor 已确认 history.clear()）
    flash('已整理：' + parts.join('、') + '（撤销历史已重置，可从 Git 历史找回）');
}

function openWritingNameDialog() {
    rollWritingName();
    deps.openDialogEl(deps.elsDialogs.writingName);
}

function rollWritingName() {
    const gender = deps.elsDialogs.writingNameGender.value || 'random';
    deps.elsDialogs.writingNameText.textContent = genName(gender);
}

// code 视图走 ace.insert，text 视图走 textarea setRangeText（同 jumpToPosition 的双路处理）
function insertTextAtCursor(text) {
    if (!deps.file || deps.file.binary || deps.file.large) return false;
    if (deps.file.editor && deps.file.editor.aceEditor && (deps.currentMode === 'code' || (deps.file.splitActive && deps.currentMode === 'split'))) {
        deps.file.editor.aceEditor.insert(text);
        deps.file.editor.aceEditor.focus();
        return true;
    }
    if (deps.currentMode === 'text' && deps.file.pane) {
        const ta = deps.file.pane.querySelector('textarea.jsoneditor-text');
        if (ta) {
            const start = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
            const end = ta.selectionEnd != null ? ta.selectionEnd : start;
            ta.setRangeText(text, start, end, 'end');
            ta.focus();
            ta.dispatchEvent(new Event('input', {bubbles: true}));
            deps.markDocDirty(deps.file);
            return true;
        }
    }
    return false;
}

function insertWritingName() {
    const name = deps.elsDialogs.writingNameText.textContent || '';
    if (!insertTextAtCursor(name)) flash('当前视图不支持插入，请切换到源码或纯文本视图', true);
    else deps.closeTopDialog();
}

function insertSceneSeparator() {
    if (!insertTextAtCursor(SCENE_SEPARATOR)) flash('当前视图不支持插入，请切换到源码或纯文本视图', true);
}

function updateCursorPosition() {
    if (!deps.els.stPos) return;
    const pos = deps.cursorPositionForDoc();
    const text = pos ? pos.line + ':' + pos.column : '';
    if (deps.els.stPos.textContent !== text) deps.els.stPos.textContent = text;
    deps.els.stPos.title = text ? '当前光标位置（点击或 Ctrl+G 跳转）' : '';
}

function scheduleCursorPosition() {
    updateCursorPosition();
    setTimeout(updateCursorPosition, 0);
}

function openGotoDialog() {
    const pos = deps.cursorPositionForDoc() || {line: 1, column: 1};
    deps.elsDialogs.gotoInput.value = pos.line + ':' + pos.column;
    deps.elsDialogs.gotoError.textContent = '';
    deps.elsDialogs.gotoError.classList.add('hidden');
    deps.openDialogEl(deps.elsDialogs.goto);
    setTimeout(() => {
        deps.elsDialogs.gotoInput.focus();
        deps.elsDialogs.gotoInput.select();
    }, 0);
}

function gotoDialogError(message) {
    deps.elsDialogs.gotoError.textContent = String(message || '');
    deps.elsDialogs.gotoError.classList.remove('hidden');
}

function jumpToPosition(line, column) {
    if (deps.currentMode === 'code' && deps.file && deps.file.editor && deps.file.editor.aceEditor) {
        const ace = deps.file.editor.aceEditor;
        const total = ace.session.getLength();
        const targetLine = Math.min(Math.max(1, line), total);
        const lineText = ace.session.getLine(targetLine - 1) || '';
        const targetColumn = Math.min(Math.max(1, column), lineText.length + 1);
        ace.selection.moveTo(targetLine - 1, targetColumn - 1);
        ace.clearSelection();
        ace.scrollToLine(targetLine - 1, true, true);
        ace.focus();
        updateCursorPosition();
        if (deps.structurePanel) deps.structurePanel.setCursor(targetLine);
        return true;
    }
    if (deps.currentMode === 'text' && deps.file && deps.file.pane) {
        const textarea = deps.file.pane.querySelector('textarea.jsoneditor-text');
        if (!textarea) return false;
        const lines = textarea.value.split('\n');
        const targetLine = Math.min(Math.max(1, line), lines.length);
        const targetColumn = Math.min(Math.max(1, column), lines[targetLine - 1].length + 1);
        let index = 0;
        for (let i = 0; i < targetLine - 1; i++) index += lines[i].length + 1;
        index += targetColumn - 1;
        textarea.focus();
        textarea.setSelectionRange(index, index);
        const style = getComputedStyle(textarea);
        const lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 13) * 1.45;
        textarea.scrollTop = Math.max(0, (targetLine - 1) * lineHeight - textarea.clientHeight / 2 + lineHeight);
        updateCursorPosition();
        if (deps.structurePanel) deps.structurePanel.setCursor(targetLine);
        return true;
    }
    return false;
}

function submitGotoDialog() {
    const raw = deps.elsDialogs.gotoInput.value.trim();
    const match = /^(\d+)(?:\s*[:：]\s*(\d+))?$/.exec(raw);
    if (!match) {
        gotoDialogError('请输入「行:列」，例如 12:43');
        return;
    }
    const line = Number(match[1]);
    const column = match[2] ? Number(match[2]) : 1;
    if (!Number.isFinite(line) || !Number.isFinite(column) || line < 1 || column < 1) {
        gotoDialogError('行号和列号必须大于 0');
        return;
    }
    if (!jumpToPosition(line, column)) {
        gotoDialogError('当前视图不支持跳转');
        return;
    }
    deps.closeDialogs();
}

document.getElementById('btn-goto-ok').addEventListener('click', submitGotoDialog);
document.getElementById('btn-goto-cancel').addEventListener('click', deps.closeTopDialog);
deps.elsDialogs.gotoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        submitGotoDialog();
    } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        deps.closeTopDialog();
    }
});
if (deps.els.stPos) {
    deps.els.stPos.addEventListener('click', () => {
        if ((deps.currentMode === 'code' || deps.currentMode === 'text') && deps.file) openGotoDialog();
    });
}

// 写作模式：状态栏入口与对话框按钮
if (deps.els.stWriting) deps.els.stWriting.addEventListener('click', openWritingStatsDialog);
document.getElementById('btn-writing-goal-save').addEventListener('click', saveWritingGoal);
document.getElementById('btn-writing-close').addEventListener('click', deps.closeDialogs);
document.getElementById('btn-writing-name-roll').addEventListener('click', rollWritingName);
document.getElementById('btn-writing-name-copy').addEventListener('click', () => deps.copyText(deps.elsDialogs.writingNameText.textContent, '名字'));
document.getElementById('btn-writing-name-insert').addEventListener('click', insertWritingName);
document.getElementById('btn-writing-name-close').addEventListener('click', deps.closeDialogs);
deps.elsDialogs.writingNameGender.addEventListener('change', rollWritingName);
deps.elsDialogs.writingGoalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        saveWritingGoal();
    }
});

for (const type of ['keyup', 'click', 'input', 'focusin']) {
    deps.els.editor.addEventListener(type, (e) => {
        if (!e.target || !e.target.matches || !e.target.matches('textarea.jsoneditor-text')) return;
        updateCursorPosition();
        // 文本视图是 textarea：字数与码字统计要和 Ace 走同一条防抖管线，否则打字时数字冻结
        if (type === 'input') deps.scheduleWordCount();
    });
}
document.addEventListener('selectionchange', () => {
    if (deps.currentMode !== 'text') return;
    const textarea = deps.file && deps.file.pane && deps.file.pane.querySelector('textarea.jsoneditor-text');
    if (textarea && document.activeElement === textarea) updateCursorPosition();
});

function openCloseConfirm(message, action, okLabel, title) {
    deps.elsDialogs.confirmText.textContent = message || '有未保存的修改，关闭后将丢弃。';
    deps.elsDialogs.confirmOk.textContent = okLabel || '丢弃并关闭';
    const titleEl = deps.elsDialogs.confirm.querySelector('.dialog-title');
    if (titleEl) titleEl.textContent = title || '关闭';
    deps.setConfirmAction(action || (() => {
        if (deps.backend.ForceClose) deps.backend.ForceClose();
    }));
    deps.openDialogEl(deps.elsDialogs.confirm, {keepSettings: true});
}

document.getElementById('btn-discard').addEventListener('click', () => {
    const action = deps.getConfirmAction();
    deps.setConfirmAction(null);
    deps.closeTopDialog();
    if (action) action();
});
document.getElementById('btn-cancel-close').addEventListener('click', deps.closeTopDialog);
document.getElementById('btn-props-ok').addEventListener('click', deps.closeDialogs);

let dialogDrag = null;
function startDialogDrag(e) {
    if (e.target.closest('.dialog-close')) return;
    const dlg = e.currentTarget.parentElement;
    const r = dlg.getBoundingClientRect();
    dialogDrag = {el: dlg, dx: e.clientX - r.left, dy: e.clientY - r.top};
    dlg.style.left = r.left + 'px';
    dlg.style.top = r.top + 'px';
    dlg.style.transform = 'none';
    e.preventDefault();
}
window.addEventListener('mousemove', (e) => {
    if (!dialogDrag) return;
    dialogDrag.el.style.left = (e.clientX - dialogDrag.dx) + 'px';
    dialogDrag.el.style.top = (e.clientY - dialogDrag.dy) + 'px';
});
window.addEventListener('mouseup', () => {
    dialogDrag = null;
});
document.querySelectorAll('.dialog-head').forEach((head) => head.addEventListener('mousedown', startDialogDrag));
document.querySelectorAll('.dialog-close').forEach((btn) => btn.addEventListener('click', deps.closeTopDialog));
deps.elsDialogs.mask.addEventListener('click', (e) => {
    if (e.target !== deps.elsDialogs.mask) return;
    if (!deps.elsDialogs.confirm.classList.contains('hidden') || !deps.elsDialogs.conflict.classList.contains('hidden') ||
        !deps.elsDialogs.name.classList.contains('hidden') ||
        !deps.elsDialogs.props.classList.contains('hidden') || !deps.elsDialogs.update.classList.contains('hidden') ||
        !deps.elsDialogs.writing.classList.contains('hidden') ||
        !deps.elsDialogs.writingName.classList.contains('hidden')) deps.closeTopDialog();
});

document.querySelector('.settings-nav').addEventListener('click', (e) => {
    const parent = e.target.closest('.snav-parent');
    if (parent) {
        const group = parent.closest('.snav-group');
        const expanded = group.classList.toggle('expanded');
        parent.setAttribute('aria-expanded', String(expanded));
        return;
    }
    const item = e.target.closest('.snav-item[data-pane]');
    if (!item) return;
    deps.selectSettingsPane(item.dataset.pane);
    if (item.dataset.pane === 'integration') deps.syncIntegrationStatus();
});
// 常用编程语言：独立于数据格式，每个语言单独配置环境信息（为后续辅助运行代码预留）
const LANG_DEFS = [
    {id: 'python', name: 'Python', tools: [{id: 'python', name: '解释器'}, {id: 'pip', name: 'pip', optional: true}], pkgs: [{id: 'env', label: '当前环境'}]},
    {id: 'node', name: 'Node.js', tools: [{id: 'node', name: 'Node'}, {id: 'npm', name: 'npm'}, {id: 'pnpm', name: 'pnpm', optional: true}, {id: 'yarn', name: 'yarn', optional: true}], pkgs: [{id: 'global', label: '全局（npm -g）'}, {id: 'project', label: '项目（node_modules）'}]},
    {id: 'go', name: 'Go', tools: [{id: 'go', name: 'Go 工具链'}], pkgs: [{id: 'project', label: '项目依赖（go.mod）'}]},
    {id: 'java', name: 'Java', tools: [{id: 'java', name: 'JDK'}, {id: 'maven', name: 'Maven', optional: true}, {id: 'gradle', name: 'Gradle', optional: true}]},
    {id: 'c', name: 'C', tools: [{id: 'c', name: '编译器（gcc / clang）'}, {id: 'cmake', name: 'CMake', optional: true}]},
    {id: 'cpp', name: 'C++', tools: [{id: 'cpp', name: '编译器（g++）'}, {id: 'cmake', name: 'CMake', optional: true}]},
    {id: 'rust', name: 'Rust', tools: [{id: 'rust', name: 'rustc'}, {id: 'cargo', name: 'cargo'}]},
    {id: 'php', name: 'PHP', tools: [{id: 'php', name: 'PHP'}, {id: 'composer', name: 'Composer', optional: true}]},
    {id: 'ruby', name: 'Ruby', tools: [{id: 'ruby', name: 'Ruby'}, {id: 'gem', name: 'gem'}]},
    {id: 'lua', name: 'Lua', tools: [{id: 'lua', name: 'Lua'}]},
];

setupFormatSettings();
setupLanguageSettings();
// 命名运行配置：存的是「参数 + 命令模板 + 语言」预设，选中时载入到当前语言，
// 不是运行时的另一套分支——面板里看到的仍然是这次真正会用的值。
function renderRunProfiles() {
    const select = document.getElementById('run-profile-select');
    const list = document.getElementById('run-profile-list');
    const profiles = Array.isArray(deps.settings.runProfiles) ? deps.settings.runProfiles : [];
    if (select) {
        select.textContent = '';
        const def = document.createElement('option');
        def.value = '';
        def.textContent = '默认配置';
        select.appendChild(def);
        for (const p of profiles) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name;
            select.appendChild(opt);
        }
        const active = deps.settings.runActiveProfile || '';
        select.value = profiles.some((p) => p.id === active) ? active : '';
    }
    if (!list) return;
    list.textContent = '';
    if (!profiles.length) {
        const empty = document.createElement('div');
        empty.className = 'fmt-hint';
        empty.textContent = '还没有保存的配置。';
        list.appendChild(empty);
        return;
    }
    for (const p of profiles) {
        const row = document.createElement('div');
        row.className = 'run-profile-row';
        const name = document.createElement('span');
        name.className = 'run-profile-name';
        name.textContent = p.name;
        const detail = document.createElement('span');
        detail.className = 'run-profile-detail';
        detail.textContent = [p.lang ? '[' + p.lang + ']' : '', p.args || '', p.template || '']
            .filter(Boolean).join('  ');
        detail.title = detail.textContent;
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'run-profile-del';
        del.textContent = '删除';
        del.addEventListener('click', () => deleteRunProfile(p.id));
        row.append(name, detail, del);
        list.appendChild(row);
    }
}

function applyRunProfile(id) {
    deps.settings.runActiveProfile = id || '';
    const profile = (deps.settings.runProfiles || []).find((p) => p.id === id);
    if (profile) {
        const lang = deps.runController.currentLang() || '';
        if (lang) {
            if (typeof profile.args === 'string') deps.settings.runArgs[lang] = profile.args;
            if (profile.template) deps.settings.runConfigs[lang] = profile.template;
            const tplLang = document.getElementById('run-template-lang');
            if (tplLang && [...tplLang.options].some((o) => o.value === lang)) tplLang.value = lang;
            const input = document.getElementById('run-args-input');
            if (input && typeof profile.args === 'string') input.value = profile.args;
        }
    }
    deps.applySettings();
    renderRunProfiles();
    renderRunPane();
    if (profile) flash('已载入运行配置：' + profile.name);
}

function saveRunProfile() {
    const nameEl = document.getElementById('run-profile-name');
    const name = nameEl ? nameEl.value.trim() : '';
    if (!name) {
        flash('请填配置名称', true);
        return;
    }
    const lang = deps.runController.currentLang() || '';
    if (!lang) {
        flash('先打开一个可运行的文件，再保存配置', true);
        return;
    }
    const argsEl = document.getElementById('run-args-input');
    const args = argsEl ? argsEl.value : deps.runArgsText(lang);
    const template = (deps.settings.runConfigs && deps.settings.runConfigs[lang]) || '';
    if (!Array.isArray(deps.settings.runProfiles)) deps.settings.runProfiles = [];
    const profile = {
        id: 'rp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        name, lang, args, template,
    };
    deps.settings.runProfiles.push(profile);
    deps.settings.runActiveProfile = profile.id;
    if (nameEl) nameEl.value = '';
    deps.applySettings();
    renderRunProfiles();
    flash('已保存运行配置：' + name);
}

function deleteRunProfile(id) {
    deps.settings.runProfiles = (deps.settings.runProfiles || []).filter((p) => p.id !== id);
    if (deps.settings.runActiveProfile === id) deps.settings.runActiveProfile = '';
    deps.applySettings();
    renderRunProfiles();
}

let runTemplateSaveTimer = 0;
setupRunSettings();

// 设置 → 运行：工作目录、未保存修改策略、首次确认与临时目录
function setupRunSettings() {
    const cwd = document.getElementById('run-cwd');
    const dirtyMode = document.getElementById('run-dirty-mode');
    const reset = document.getElementById('run-confirm-reset');
    const openTemp = document.getElementById('run-open-temp');
    const templateLang = document.getElementById('run-template-lang');
    const templateInput = document.getElementById('run-template-input');
    const selfTestLang = document.getElementById('run-selftest-lang');
    const selfTestBtn = document.getElementById('run-selftest');
    if (cwd) {
        cwd.addEventListener('change', () => {
            deps.settings.runCwd = cwd.value === 'workspace' ? 'workspace' : 'file';
            deps.applySettings();
        });
    }
    if (dirtyMode) {
        dirtyMode.addEventListener('change', () => {
            deps.settings.runDirtyMode = ['ask', 'save', 'temp'].includes(dirtyMode.value) ? dirtyMode.value : 'ask';
            deps.applySettings();
        });
    }
    if (reset) {
        reset.addEventListener('click', () => {
            deps.settings.runConfirmSeen = [];
            deps.applySettings();
            renderRunPane();
            flash('已重置，每种语言下次运行会再提示一次');
        });
    }
    if (openTemp) {
        openTemp.addEventListener('click', async () => {
            try {
                const dir = await deps.backend.GetRunTempDir();
                await deps.backend.ShowInFolder(dir);
            } catch (e) {
                flash('打开临时目录失败：' + e, true);
            }
        });
    }

    // 命令模板按语言覆盖（同一语言的多个扩展名共用一份）
    if (templateLang) {
        const seen = new Map();
        for (const recipe of Object.values(RECIPES)) {
            if (!seen.has(recipe.lang)) seen.set(recipe.lang, recipe.label);
        }
        for (const [id, label] of seen) {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = label;
            templateLang.appendChild(opt);
        }
        templateLang.addEventListener('change', renderRunPane);
    }
    if (templateInput) {
        templateInput.addEventListener('input', () => {
            const lang = templateLang ? templateLang.value : '';
            if (!lang) return;
            if (!deps.settings.runConfigs || typeof deps.settings.runConfigs !== 'object') deps.settings.runConfigs = {};
            deps.settings.runConfigs[lang] = templateInput.value;
            clearTimeout(runTemplateSaveTimer);
            runTemplateSaveTimer = setTimeout(deps.applySettings, 400);
        });
    }
    if (selfTestLang) {
        for (const ext of Object.keys(SELF_TEST)) {
            const recipe = RECIPES[ext];
            if (!recipe) continue;
            const opt = document.createElement('option');
            opt.value = ext;
            opt.textContent = recipe.label + ' (.' + ext + ')';
            selfTestLang.appendChild(opt);
        }
    }
    if (selfTestBtn) {
        selfTestBtn.addEventListener('click', () => {
            if (selfTestLang && selfTestLang.value) deps.runController.selfTest(selfTestLang.value);
        });
    }
    const profileSelect = document.getElementById('run-profile-select');
    const profileSave = document.getElementById('run-profile-save');
    const profileName = document.getElementById('run-profile-name');
    if (profileSelect) profileSelect.addEventListener('change', () => applyRunProfile(profileSelect.value));
    if (profileSave) profileSave.addEventListener('click', saveRunProfile);
    if (profileName) {
        profileName.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            e.stopPropagation();
            saveRunProfile();
        });
    }
    renderRunProfiles();
}

function renderRunPane() {
    const cwd = document.getElementById('run-cwd');
    const dirtyMode = document.getElementById('run-dirty-mode');
    const hint = document.getElementById('run-confirm-hint');
    const tempHint = document.getElementById('run-temp-hint');
    const templateLang = document.getElementById('run-template-lang');
    const templateInput = document.getElementById('run-template-input');
    if (cwd) cwd.value = deps.settings.runCwd;
    if (dirtyMode) dirtyMode.value = deps.settings.runDirtyMode;
    if (templateLang && templateInput) {
        templateInput.value = (deps.settings.runConfigs && deps.settings.runConfigs[templateLang.value]) || '';
    }
    if (hint) {
        const seen = deps.settings.runConfirmSeen || [];
        hint.textContent = seen.length
            ? ('已确认 ' + seen.length + ' 种语言：' + seen.join('、'))
            : '尚未确认任何语言，首次运行会出现提示。';
    }
    if (tempHint && deps.backend.GetRunTempDir) {
        deps.backend.GetRunTempDir().then((dir) => {
            tempHint.textContent = dir;
        }).catch((e) => {
            tempHint.textContent = '读取失败：' + ((e && e.message) || e);
        });
    }
    renderRunProfiles();
}

function refreshPluginUI() {
    // 清掉已失效的插件格式导航与面板（插件被禁用/删除后）
    const children = document.querySelector('#snav-formats .snav-children');
    const content = document.querySelector('.settings-content');
    if (children && content) {
        const valid = new Set(deps.allFormatDefs().map((f) => 'fmt-' + f.id));
        for (const nav of [...children.querySelectorAll('.snav-fmt')]) {
            if (!valid.has(nav.dataset.pane)) {
                const pane = content.querySelector(`.settings-pane[data-pane="${nav.dataset.pane}"]`);
                if (pane) pane.remove();
                nav.remove();
            }
        }
    }
    setupFormatSettings();
    setupLanguageSettings();
    if (deps.elsDialogs.settings && !deps.elsDialogs.settings.classList.contains('hidden')) {
        const active = document.querySelector('.snav-item.active');
        if (active && active.dataset.pane === 'plugins') renderPluginsPane();
    }
}

initPluginRuntime({
    flash,
    getActiveFile: () => deps.file ? {path: deps.file.path || '', name: deps.file.name || '', size: deps.file.size || 0, formatId: deps.file.format ? deps.file.format.id : null} : null,
    getActiveText: () => {
        if (!deps.file) return null;
        if (deps.currentMode === 'code' && deps.editor && deps.editor.aceEditor) return deps.editor.aceEditor.getValue();
        if (deps.currentMode === 'tree' && deps.editor && deps.file.format && typeof deps.file.format.stringify === 'function') {
            try {
                return deps.file.format.stringify(deps.editor.get());
            } catch (e) {
                return null;
            }
        }
        const ta = deps.textArea();
        if (ta) return ta.value;
        return deps.file.binary ? null : deps.file.content;
    },
    openPath: (p) => {
        if (p) deps.openPaths([p]);
    },
    runCommandSync: (opts) => deps.backend.RunCommandSync(opts.exe, opts.args, opts.cwd || '', opts.timeoutMs || 20000),
    runCommand: (opts) => {
        const id = 'cmd-' + deps.nextCmdSeq();
        deps.cmdOutHandlers.set(id, (stream, data) => {
            if (stream === 'out' && opts.onOut) opts.onOut(data);
            if (stream === 'err' && opts.onErr) opts.onErr(data);
        });
        deps.cmdExitHandlers.set(id, (code) => {
            deps.cmdOutHandlers.delete(id);
            if (opts.onExit) opts.onExit(code);
        });
        Promise.resolve(deps.backend.StartCommand(id, opts.exe, opts.args, opts.cwd || '')).catch((e) => {
            flash('启动命令失败：' + e, true);
            deps.cmdExitHandlers.delete(id);
            if (opts.onExit) opts.onExit(-1);
        });
        return {stop: () => deps.backend.StopCommand(id).catch(() => {})};
    },
    openVirtualDoc: (name, content) => deps.openVirtualDoc(name, content),
    readPluginAsset: (pluginId, relPath) => deps.backend.ReadPluginAsset(pluginId, relPath),
    addPluginTheme: (theme) => {
        if (deps.themes.some((t) => t.id === theme.id)) {
            throw new Error(`主题 ${theme.id} 与内置主题冲突`);
        }
        deps.themes.push({...theme, group: 'plugin'});
    },
    onPluginsChanged: () => refreshPluginUI(),
});

async function reloadPluginErrors(prefix) {
    const errors = await loadPlugins(deps.backend);
    for (const err of errors) flash(prefix + err, true);
}

if (deps.elsSettings.fileAssoc) {
    deps.elsSettings.fileAssoc.addEventListener('change', () => deps.applyIntegration('SetFileAssociation', deps.elsSettings.fileAssoc, '文件关联'));
    deps.elsSettings.contextMenu.addEventListener('change', () => deps.applyIntegration('SetContextMenu', deps.elsSettings.contextMenu, '右键菜单'));
    deps.elsSettings.agentSkill.addEventListener('change', () => deps.applyIntegration('SetAgentSkill', deps.elsSettings.agentSkill, 'Agent Skill '));
    deps.elsSettings.refreshIntegration.addEventListener('click', deps.syncIntegrationStatus);
}

function setupPluginsSettings() {
    const addBtn = document.getElementById('plugin-add');
    const importBtn = document.getElementById('plugin-import');
    const cloneBtn = document.getElementById('plugin-clone');
    const openDirBtn = document.getElementById('plugin-open-dir');
    const modeSel = document.getElementById('plugin-path-mode');
    if (!addBtn) return;
    addBtn.addEventListener('click', async () => {
        if (!deps.backend.AddPluginFromFolder) return flash('当前版本不支持插件', true);
        try {
            const installed = await deps.backend.AddPluginFromFolder();
            if (installed) {
                await reloadPluginErrors('');
                flash('已添加插件：' + installed.name);
                deps.activityLog.log('plugin.change', installed.id || installed.name, {op: 'install-folder'});
            }
        } catch (e) {
            flash('添加插件失败：' + e, true);
        }
        renderPluginsPane();
    });
    importBtn.addEventListener('click', async () => {
        if (!deps.backend.ImportPluginFromZip) return flash('当前版本不支持插件', true);
        try {
            const installed = await deps.backend.ImportPluginFromZip();
            if (installed) {
                await reloadPluginErrors('');
                flash('已导入插件：' + installed.name);
                deps.activityLog.log('plugin.change', installed.id || installed.name, {op: 'install-zip'});
            }
        } catch (e) {
            flash('导入插件失败：' + e, true);
        }
        renderPluginsPane();
    });
    cloneBtn.addEventListener('click', () => {
        if (!deps.backend.InstallPluginFromUrl) {
            flash('当前版本不支持从仓库地址安装', true);
            return;
        }
        deps.openNameDialog({
            title: '从仓库地址安装插件',
            label: '仓库地址',
            placeholder: 'https://gitee.com/cadt-datalens-plugins/git-flow',
            okLabel: '安装',
            onSubmit: async (url) => {
                if (!url || !url.trim()) throw new Error('仓库地址为空');
                // 安装插件 = 执行第三方代码：先明示权限范围，确认后再装
                openCloseConfirm('插件代码以与应用相同的权限运行，可读写本机文件、执行命令。仅安装你信任的来源：' + url, () => {
                    (async () => {
                        try {
                            const installed = await deps.backend.InstallPluginFromUrl(url);
                            await reloadPluginErrors('');
                            renderPluginsPane();
                            flash('已安装插件：' + installed.name);
                            deps.activityLog.log('plugin.change', (installed && (installed.id || installed.name)) || url, {op: 'install-url'});
                        } catch (e) {
                            flash('安装失败：' + e, true);
                        }
                    })();
                }, '继续安装', '安装第三方插件');
            },
        });
    });
    openDirBtn.addEventListener('click', async () => {
        try {
            await deps.backend.OpenPluginsDir();
        } catch (e) {
            flash('打开插件目录失败：' + e, true);
        }
    });
    const trustIcon = document.querySelector('.plugin-trust-icon');
    if (trustIcon) trustIcon.innerHTML = iconSvg('warn', 12);
    modeSel.addEventListener('change', async () => {
        try {
            await deps.backend.SetPluginsPathMode(modeSel.value);
            await reloadPluginErrors('');
            flash('插件目录已切换，重新打开文件生效');
        } catch (e) {
            flash('切换插件目录失败：' + e, true);
        }
        renderPluginsPane();
    });
    const marketRefresh = document.getElementById('plugin-market-refresh');
    if (marketRefresh) {
        marketRefresh.addEventListener('click', () => renderPluginMarket(true));
    }
    const marketSource = document.getElementById('plugin-market-source');
    if (marketSource) {
        marketSource.addEventListener('click', (e) => {
            e.preventDefault();
            const url = marketSource.dataset.url;
            if (deps.rt && deps.rt.BrowserOpenURL) deps.rt.BrowserOpenURL(url);
            else window.open(url, '_blank', 'noopener');
        });
    }
}

let cachedAppVersion = '';
function appVersionValue() {
    return cachedAppVersion;
}

function versionAtLeast(current, required) {
    const parse = (v) => String(v || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    const [c1 = 0, c2 = 0, c3 = 0] = parse(current);
    const [r1 = 0, r2 = 0, r3 = 0] = parse(required);
    if (c1 !== r1) return c1 > r1;
    if (c2 !== r2) return c2 > r2;
    return c3 >= r3;
}

function compareVersion(a, b) {
    const parse = (v) => String(v || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    const ap = parse(a);
    const bp = parse(b);
    for (let i = 0; i < 3; i += 1) {
        const av = ap[i] || 0;
        const bv = bp[i] || 0;
        if (av !== bv) return av > bv ? 1 : -1;
    }
    return 0;
}

async function renderPluginsPane() {
    const listEl = document.getElementById('plugin-list');
    if (!listEl) return;
    const modeSel = document.getElementById('plugin-path-mode');
    try {
        if (deps.backend.GetAppVersion) cachedAppVersion = await deps.backend.GetAppVersion();
        const plugins = deps.backend.GetPlugins ? await deps.backend.GetPlugins() : [];
        const dir = deps.backend.GetPluginsDir ? await deps.backend.GetPluginsDir() : '—';
        if (modeSel && deps.backend.GetPluginsPathMode) {
            modeSel.value = await deps.backend.GetPluginsPathMode();
        }
        if (document.getElementById('plugin-dir-line')) {
            document.getElementById('plugin-dir-line').textContent = '插件目录：' + dir;
        }
        renderPluginMarket(false);
        listEl.textContent = '';
        if (!plugins || !plugins.length) {
            const empty = document.createElement('div');
            empty.className = 'plugin-empty';
            empty.textContent = '暂无插件。点「添加插件」选择包含 plugin.json 的文件夹，或导入 .zip 插件包；插件可注册新的文件格式、工具菜单命令和主题。';
            listEl.appendChild(empty);
            fitPluginListBox(listEl);
            return;
        }
        for (const p of plugins) {
            const item = document.createElement('div');
            item.className = 'plugin-item';
            const head = document.createElement('div');
            head.className = 'plugin-head';
            if (p.iconData) {
                const icon = document.createElement('img');
                icon.className = 'plugin-icon';
                icon.src = p.iconData;
                icon.alt = '';
                icon.draggable = false;
                head.appendChild(icon);
            }
            const name = document.createElement('span');
            name.className = 'plugin-name';
            name.textContent = p.name;
            const ver = document.createElement('span');
            ver.className = 'plugin-version';
            ver.textContent = p.version ? 'v' + p.version : '';
            const author = document.createElement('span');
            author.className = 'plugin-author';
            author.textContent = p.author ? '作者：' + p.author : '';
            const license = document.createElement('span');
            license.className = 'plugin-license';
            license.textContent = p.license || '';
            license.title = '许可证';
            const enabledLabel = document.createElement('label');
            enabledLabel.className = 'popover-label plugin-enabled';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!p.enabled;
            cb.addEventListener('change', async () => {
                try {
                    await deps.backend.SetPluginEnabled(p.id, cb.checked);
                    await reloadPluginErrors('');
                    deps.activityLog.log('plugin.change', p.id, {op: cb.checked ? 'enable' : 'disable'});
                } catch (e) {
                    flash('切换失败：' + e, true);
                }
                renderPluginsPane();
            });
            enabledLabel.append(cb, document.createTextNode('启用'));
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'dlg-btn plugin-del';
            del.textContent = '删除';
            del.addEventListener('click', async () => {
                if (!del.dataset.armed) {
                    del.dataset.armed = '1';
                    del.textContent = '确认删除？';
                    del.classList.add('danger');
                    setTimeout(() => {
                        if (del.isConnected) {
                            del.dataset.armed = '';
                            del.textContent = '删除';
                            del.classList.remove('danger');
                        }
                    }, 3000);
                    return;
                }
                try {
                    await deps.backend.DeletePlugin(p.id);
                    await reloadPluginErrors('');
                    flash('插件已删除：' + p.name);
                    deps.activityLog.log('plugin.change', p.id, {op: 'uninstall'});
                } catch (e) {
                    flash('删除失败：' + e, true);
                }
                renderPluginsPane();
            });
            head.append(name, ver, author, license, enabledLabel, del);
            const desc = document.createElement('div');
            desc.className = 'plugin-desc';
            desc.textContent = p.description || '无描述';
            const meta = document.createElement('div');
            meta.className = 'plugin-meta';
            if (p.extensions && p.extensions.length) {
                const exts = document.createElement('span');
                exts.textContent = '扩展名：' + p.extensions.join('、');
                meta.appendChild(exts);
            }
            for (const kw of (p.keywords || []).slice(0, 6)) {
                const chip = document.createElement('span');
                chip.className = 'plugin-tag';
                chip.textContent = kw;
                meta.appendChild(chip);
            }
            if (p.minAppVersion && !versionAtLeast(appVersionValue(), p.minAppVersion)) {
                const warn = document.createElement('span');
                warn.className = 'plugin-warn';
                warn.textContent = '需要应用 ≥ ' + p.minAppVersion;
                meta.appendChild(warn);
            }
            for (const [label, url] of [['主页', p.homepage], ['源码', p.repository]]) {
                if (!url) continue;
                const link = document.createElement('a');
                link.className = 'plugin-link';
                link.textContent = label;
                link.href = url;
                link.dataset.url = url;
                link.title = url;
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    if (deps.rt && deps.rt.BrowserOpenURL) deps.rt.BrowserOpenURL(url);
                    else window.open(url, '_blank', 'noopener');
                });
                meta.appendChild(link);
            }
            if (!p.entryOk) {
                const warn = document.createElement('span');
                warn.className = 'plugin-warn';
                warn.textContent = '入口文件缺失或过大';
                meta.appendChild(warn);
            }
            item.append(head, desc, meta);
            listEl.appendChild(item);
        }
        fitPluginListBox(listEl);
    } catch (e) {
        flash('读取插件失败：' + e, true);
    }
}

let pluginMarketCache = null;
const PLUGIN_MARKET_TTL = 5 * 60 * 1000;

async function renderPluginMarket(force) {
    const listEl = document.getElementById('plugin-market-list');
    if (!listEl) return;
    if (!deps.backend.GetPluginMarket) {
        listEl.textContent = '';
        const unsupported = document.createElement('div');
        unsupported.className = 'plugin-empty';
        unsupported.textContent = '当前版本不支持插件市场。';
        listEl.appendChild(unsupported);
        fitPluginListBox(listEl);
        return;
    }
    if (!force && pluginMarketCache && Date.now() - pluginMarketCache.at < PLUGIN_MARKET_TTL) {
        renderPluginMarketList(listEl, pluginMarketCache.items);
        return;
    }
    listEl.textContent = '';
    const loading = document.createElement('div');
    loading.className = 'plugin-empty';
    loading.textContent = force ? '正在刷新插件市场…' : '正在读取插件市场…';
    listEl.appendChild(loading);
    fitPluginListBox(listEl);
    try {
        const items = (await deps.backend.GetPluginMarket()) || [];
        pluginMarketCache = {at: Date.now(), items};
        renderPluginMarketList(listEl, items);
    } catch (e) {
        listEl.textContent = '';
        const err = document.createElement('div');
        err.className = 'plugin-empty plugin-market-error';
        err.textContent = '插件市场加载失败：' + e + '（点「刷新」重试）';
        listEl.appendChild(err);
        fitPluginListBox(listEl);
        deps.logFrontend('error', '插件市场加载失败：' + e);
    }
}

function renderPluginMarketList(listEl, items) {
    listEl.textContent = '';
    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'plugin-empty';
        empty.textContent = '插件市场暂无公开插件。';
        listEl.appendChild(empty);
        fitPluginListBox(listEl);
        return;
    }
    for (const m of items) {
        const item = document.createElement('div');
        item.className = 'plugin-item';
        const head = document.createElement('div');
        head.className = 'plugin-head';
        const name = document.createElement('span');
        name.className = 'plugin-name';
        name.textContent = m.name || m.repo;
        const ver = document.createElement('span');
        ver.className = 'plugin-version';
        ver.textContent = m.version ? 'v' + m.version : '';
        const author = document.createElement('span');
        author.className = 'plugin-author';
        author.textContent = m.author ? '作者：' + m.author : '';
        head.append(name, ver, author);
        const installedVersion = m.installedVersion || '';
        const updateAvailable = m.installed && installedVersion && m.version && compareVersion(m.version, installedVersion) > 0;
        if (updateAvailable) {
            const update = document.createElement('button');
            update.type = 'button';
            update.className = 'dlg-btn primary plugin-market-action';
            update.textContent = '更新';
            update.title = '当前 v' + installedVersion + ' → v' + m.version;
            update.addEventListener('click', async () => {
                update.disabled = true;
                update.textContent = '更新中…';
                try {
                    const pluginId = m.id || (m.repo || '').split('/').pop();
                    const updated = await deps.backend.UpdatePluginFromUrl(pluginId, m.url);
                    if (!updated) throw new Error('更新失败');
                    m.installed = true;
                    m.installedVersion = m.version;
                    await reloadPluginErrors('');
                    renderPluginsPane();
                    flash('已更新插件：' + (updated.name || m.name) + (m.version ? ' v' + m.version : ''));
                } catch (e) {
                    update.disabled = false;
                    update.textContent = '更新';
                    flash('更新失败：' + e, true);
                }
            });
            head.appendChild(update);
        } else if (m.installed) {
            const tag = document.createElement('span');
            tag.className = 'plugin-market-installed';
            tag.textContent = '已安装' + (installedVersion ? ' v' + installedVersion : '');
            head.appendChild(tag);
        } else if (m.minAppVersion && !versionAtLeast(appVersionValue(), m.minAppVersion)) {
            const warn = document.createElement('span');
            warn.className = 'plugin-warn plugin-market-action';
            warn.textContent = '需要应用 ≥ ' + m.minAppVersion;
            head.appendChild(warn);
        } else {
            const install = document.createElement('button');
            install.type = 'button';
            install.className = 'dlg-btn plugin-market-action';
            install.textContent = '安装';
            install.addEventListener('click', () => {
                openCloseConfirm('插件代码以与应用相同的权限运行，可读写本机文件、执行命令。仅安装你信任的来源：' + (m.name || m.url), async () => {
                    install.disabled = true;
                    install.textContent = '安装中…';
                    try {
                        const installed = await deps.backend.InstallPluginFromUrl(m.url);
                        if (!installed) throw new Error('仓库地址为空');
                        m.installed = true;
                        await reloadPluginErrors('');
                        renderPluginsPane();
                        flash('已安装插件：' + (installed.name || m.name));
                        deps.activityLog.log('plugin.change', (installed.id || installed.name || m.url), {op: 'install-url'});
                    } catch (e) {
                        install.disabled = false;
                        install.textContent = '安装';
                        flash('安装失败：' + e, true);
                    }
                }, '继续安装', '安装第三方插件');
            });
            head.appendChild(install);
        }
        const desc = document.createElement('div');
        desc.className = 'plugin-desc';
        desc.textContent = m.description || '无描述';
        const meta = document.createElement('div');
        meta.className = 'plugin-meta';
        const repo = document.createElement('span');
        repo.textContent = m.repo;
        meta.appendChild(repo);
        const date = marketDate(m.updatedAt);
        if (date) {
            const updated = document.createElement('span');
            updated.textContent = '更新于 ' + date;
            meta.appendChild(updated);
        }
        if (m.stars > 0) {
            const stars = document.createElement('span');
            stars.className = 'market-stars';
            stars.innerHTML = iconSvg('star', 11) + '<span>' + m.stars + '</span>';
            meta.appendChild(stars);
        }
        if (!m.manifestOk) {
            const warn = document.createElement('span');
            warn.className = 'plugin-warn';
            warn.textContent = '未读取到插件清单';
            meta.appendChild(warn);
        }
        const link = document.createElement('a');
        link.className = 'plugin-link';
        link.textContent = '主页';
        link.href = m.url;
        link.dataset.url = m.url;
        link.title = m.url;
        link.addEventListener('click', (e) => {
            e.preventDefault();
            if (deps.rt && deps.rt.BrowserOpenURL) deps.rt.BrowserOpenURL(m.url);
            else window.open(m.url, '_blank', 'noopener');
        });
        meta.appendChild(link);
        item.append(head, desc, meta);
        listEl.appendChild(item);
    }
    fitPluginListBox(listEl);
}

// 列表外层框最多显示三格，超出的内容在框内滚动。
function fitPluginListBox(listEl, maxItems = 3) {
    const box = listEl && listEl.parentElement;
    if (!box || !box.classList.contains('plugin-list-box')) return;
    const items = Array.from(listEl.children);
    if (!items.length || !items[0].offsetHeight) {
        box.style.maxHeight = '';
        return;
    }
    const listStyle = getComputedStyle(listEl);
    const gap = parseFloat(listStyle.rowGap || listStyle.gap) || 0;
    let height = 0;
    const visible = Math.min(items.length, maxItems);
    for (let i = 0; i < visible; i += 1) {
        height += items[i].offsetHeight;
        if (i > 0) height += gap;
    }
    const boxStyle = getComputedStyle(box);
    height += (parseFloat(boxStyle.paddingTop) || 0) + (parseFloat(boxStyle.paddingBottom) || 0);
    height += (parseFloat(boxStyle.borderTopWidth) || 0) + (parseFloat(boxStyle.borderBottomWidth) || 0);
    box.style.maxHeight = Math.ceil(height) + 'px';
}

function marketDate(iso) {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso || ''));
    return match ? match[1] : '';
}

setupPluginsSettings();

// ---- 设置：环境变量（私密值注入终端/命令桥；AI 只见名称与描述） ----

const ENVVAR_NAME_RULE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const envVarState = {vars: [], encrypted: false, supported: false};
let envEditorEditing = '';

async function renderEnvVarsPane() {
    const listEl = document.getElementById('envvar-list');
    if (!listEl) return;
    const sel = document.getElementById('envvar-encrypted');
    const hint = document.getElementById('envvar-storage-hint');
    let snap = {encrypted: false, supported: false, vars: []};
    try {
        snap = (await deps.backend.GetEnvVars()) || snap;
    } catch (e) {
        if (hint) hint.textContent = '读取环境变量失败：' + e;
    }
    envVarState.vars = Array.isArray(snap.vars) ? snap.vars : [];
    envVarState.encrypted = !!snap.encrypted;
    envVarState.supported = !!snap.supported;
    if (sel) {
        const encOpt = sel.querySelector('option[value="encrypted"]');
        if (encOpt) {
            encOpt.disabled = !envVarState.supported;
            encOpt.textContent = envVarState.supported ? 'DPAPI 加密（仅本机可解）' : 'DPAPI 加密（当前平台不支持）';
        }
        sel.value = envVarState.encrypted && envVarState.supported ? 'encrypted' : 'plain';
    }
    if (hint) {
        hint.textContent = envVarState.supported
            ? (envVarState.encrypted
                ? '当前：DPAPI 加密，绑定本机与当前用户，配置文件拷到别的机器也解不开。'
                : '当前：明文 JSON，可手动备份编辑；文件位于应用数据目录 env-vars.json。')
            : '当前：明文 JSON（本平台不支持 DPAPI 加密）。';
    }
    listEl.textContent = '';
    if (!envVarState.vars.length) {
        const empty = document.createElement('div');
        empty.className = 'envvar-empty';
        empty.textContent = '还没有环境变量。点「新增变量」添加 API key 等私密值；之后新开的终端会话与命令桥命令都会注入它们。';
        listEl.appendChild(empty);
        return;
    }
    for (const v of envVarState.vars) {
        listEl.appendChild(buildEnvVarRow(v));
    }
}

function buildEnvVarRow(v) {
    const row = document.createElement('div');
    row.className = 'envvar-row';
    const nameEl = document.createElement('span');
    nameEl.className = 'envvar-name';
    nameEl.textContent = v.name;
    const descEl = document.createElement('span');
    descEl.className = 'envvar-desc';
    descEl.textContent = v.description || '（无描述）';
    descEl.title = v.description || '';
    const enabledLabel = document.createElement('label');
    enabledLabel.className = 'popover-label envvar-enabled';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!v.enabled;
    cb.addEventListener('change', async () => {
        try {
            await saveEnvVarsAll(envVarState.vars.map((item) => (
                item.name === v.name ? {...item, enabled: cb.checked} : item
            )));
        } catch (e) {
            flash('切换失败：' + e, true);
            renderEnvVarsPane();
        }
    });
    enabledLabel.append(cb, document.createTextNode('注入'));
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'dlg-btn';
    editBtn.textContent = '编辑';
    editBtn.addEventListener('click', () => openEnvVarEditor(v.name));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'dlg-btn envvar-del';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
        if (!del.dataset.armed) {
            del.dataset.armed = '1';
            del.textContent = '确认删除？';
            del.classList.add('danger');
            setTimeout(() => {
                if (del.isConnected) {
                    del.dataset.armed = '';
                    del.textContent = '删除';
                    del.classList.remove('danger');
                }
            }, 3000);
            return;
        }
        try {
            await saveEnvVarsAll(envVarState.vars.filter((item) => item.name !== v.name));
            flash('已删除环境变量：' + v.name);
        } catch (e) {
            flash('删除失败：' + e, true);
        }
    });
    row.append(nameEl, descEl, enabledLabel, editBtn, del);
    return row;
}

async function saveEnvVarsAll(vars) {
    await deps.backend.SetEnvVars((vars || []).map((v) => ({
        name: v.name,
        value: v.value,
        description: v.description || '',
        enabled: !!v.enabled,
    })));
    await renderEnvVarsPane();
}

function showEnvEditorError(message) {
    const errorEl = document.getElementById('env-opt-error');
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.classList.toggle('hidden', !message);
}

function closeEnvVarEditor() {
    const dlg = document.getElementById('dlg-env-editor');
    const mask = document.getElementById('dlg-env-editor-mask');
    if (dlg) dlg.classList.add('hidden');
    if (mask) mask.classList.add('hidden');
    envEditorEditing = '';
    showEnvEditorError('');
    const input = document.getElementById('env-opt-value');
    const toggle = document.getElementById('env-opt-value-toggle');
    if (input) input.type = 'password';
    if (toggle) toggle.textContent = '显示';
}

function openEnvVarEditor(name) {
    const dlg = document.getElementById('dlg-env-editor');
    if (!dlg) return;
    const mask = document.getElementById('dlg-env-editor-mask');
    envEditorEditing = envVarState.vars.some((v) => v.name === name) ? name : '';
    const existing = envEditorEditing
        ? envVarState.vars.find((v) => v.name === envEditorEditing)
        : null;
    const title = document.getElementById('dlg-env-title');
    const nameInput = document.getElementById('env-opt-name');
    const descInput = document.getElementById('env-opt-desc');
    const valueInput = document.getElementById('env-opt-value');
    const enabledInput = document.getElementById('env-opt-enabled');
    const warn = document.getElementById('env-opt-name-warn');
    if (title) title.textContent = existing ? '编辑变量：' + existing.name : '新增变量';
    if (nameInput) nameInput.value = existing ? existing.name : '';
    if (descInput) descInput.value = existing ? (existing.description || '') : '';
    if (valueInput) valueInput.value = existing ? (existing.value || '') : '';
    if (enabledInput) enabledInput.checked = existing ? !!existing.enabled : true;
    if (warn) warn.classList.toggle('hidden', !existing || existing.name.toUpperCase() !== 'PATH');
    showEnvEditorError('');
    if (valueInput) valueInput.type = 'password';
    const toggle = document.getElementById('env-opt-value-toggle');
    if (toggle) toggle.textContent = '显示';
    if (mask) mask.classList.remove('hidden');
    dlg.classList.remove('hidden');
    setTimeout(() => {
        if (nameInput) {
            nameInput.focus();
            nameInput.select();
        }
    }, 50);
}

async function saveEnvVarEditor() {
    const nameInput = document.getElementById('env-opt-name');
    const descInput = document.getElementById('env-opt-desc');
    const valueInput = document.getElementById('env-opt-value');
    const enabledInput = document.getElementById('env-opt-enabled');
    if (!nameInput || !valueInput) return;
    const name = String(nameInput.value || '').trim();
    if (!ENVVAR_NAME_RULE.test(name)) {
        showEnvEditorError('名称无效：字母/数字/下划线，字母或下划线开头，最长 128 字符');
        nameInput.focus();
        return;
    }
    const dup = envVarState.vars.some((v) => v.name === name && v.name !== envEditorEditing);
    if (dup) {
        showEnvEditorError('已存在同名变量：' + name);
        nameInput.focus();
        return;
    }
    const entry = {
        name,
        value: String(valueInput.value || ''),
        description: String((descInput && descInput.value) || '').trim(),
        enabled: !!(enabledInput && enabledInput.checked),
    };
    const list = envEditorEditing
        ? envVarState.vars.map((v) => (v.name === envEditorEditing ? entry : v))
        : envVarState.vars.concat([entry]);
    const wasEditing = envEditorEditing;
    try {
        await deps.backend.SetEnvVars(list);
        closeEnvVarEditor();
        flash((wasEditing ? '已保存环境变量：' : '已新增环境变量：') + name);
        await renderEnvVarsPane();
    } catch (e) {
        showEnvEditorError(String(e));
    }
}

function setupEnvVarsSettings() {
    const addBtn = document.getElementById('envvar-add');
    if (!addBtn) return;
    addBtn.addEventListener('click', () => openEnvVarEditor(''));
    const saveBtn = document.getElementById('dlg-env-save');
    if (saveBtn) saveBtn.addEventListener('click', saveEnvVarEditor);
    const cancelBtn = document.getElementById('dlg-env-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', closeEnvVarEditor);
    const closeBtn = document.getElementById('dlg-env-editor-close');
    if (closeBtn) closeBtn.addEventListener('click', closeEnvVarEditor);
    const mask = document.getElementById('dlg-env-editor-mask');
    if (mask) mask.addEventListener('click', closeEnvVarEditor);
    // 捕获阶段拦截 Esc：编辑器开着时只关编辑器，不动背后的设置窗口
    // （main.js 的全局 Esc 走 window capture，这里必须同样挂 window capture 且先注册才能拦住）
    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const dlg = document.getElementById('dlg-env-editor');
        if (!dlg || dlg.classList.contains('hidden')) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        closeEnvVarEditor();
    }, true);
    const valueToggle = document.getElementById('env-opt-value-toggle');
    if (valueToggle) {
        valueToggle.addEventListener('click', () => {
            const input = document.getElementById('env-opt-value');
            if (!input) return;
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            valueToggle.textContent = show ? '隐藏' : '显示';
        });
    }
    const nameInput = document.getElementById('env-opt-name');
    if (nameInput) {
        nameInput.addEventListener('input', () => {
            const warn = document.getElementById('env-opt-name-warn');
            if (warn) warn.classList.toggle('hidden', nameInput.value.trim().toUpperCase() !== 'PATH');
        });
    }
    const sel = document.getElementById('envvar-encrypted');
    if (sel) {
        sel.addEventListener('change', async () => {
            try {
                await deps.backend.SetEnvVarEncrypted(sel.value === 'encrypted');
                flash(sel.value === 'encrypted' ? '已切换为 DPAPI 加密存储' : '已切换为明文存储');
            } catch (e) {
                flash('切换存储方式失败：' + e, true);
            }
            renderEnvVarsPane();
        });
    }
}

setupEnvVarsSettings();

const ENCODINGS = [['auto', '自动'], ['utf-8', 'UTF-8'], ['gbk', 'GBK'], ['gb18030', 'GB18030'], ['iso-8859-1', 'ISO-8859-1'], ['us-ascii', 'US-ASCII']];
const CONVERT_ENCODINGS = [['utf-8', 'UTF-8'], ['gbk', 'GBK'], ['gb18030', 'GB18030'], ['iso-8859-1', 'ISO-8859-1'], ['us-ascii', 'US-ASCII']];
const INDENTS = [['2', '2 空格'], ['4', '4 空格'], ['tab', 'Tab']];
const EOLS = [['follow', '跟随原文件'], ['lf', 'LF'], ['crlf', 'CRLF']];
const VIEWS = [['tree', '树视图'], ['code', '代码视图'], ['text', '文本视图']];
const PATCH_VIEWS = [['patch', '补丁视图'], ['code', '代码视图'], ['text', '文本视图']];
const CSV_VIEWS = [['table', '表格视图'], ['sql', 'SQL 查询'], ['tree', '树视图'], ['text', '文本视图']];
const JSONL_VIEWS = [['tree', '树视图'], ['code', '代码视图'], ['text', '文本视图'], ['sql', 'SQL 查询']];
const MARKDOWN_VIEWS = [['split', '分屏'], ['preview', '预览'], ['code', '代码视图'], ['text', '文本视图']];
const HTML_VIEWS = [['split', '分屏'], ['code', '代码视图'], ['text', '文本视图']];
const IMAGE_VIEWS = [['image', '图片视图'], ['binary', '二进制视图'], ['text', '文本视图']];
const BINARY_VIEWS = [['binary', '二进制视图'], ['text', '文本视图']];
const SVG_VIEWS = [['split', '分屏'], ['render', '渲染视图'], ['tree', '树视图'], ['code', '代码视图'], ['text', '文本视图']];

function isSvgDoc(doc) {
    return !!(doc && /\.svg$/i.test(doc.name || ''));
}

function isHtmlDoc(doc) {
    return !!(doc && /\.(html?|xhtml)$/i.test(doc.name || ''));
}

// 分屏种类：markdown / svg / html；其他格式暂不支持
function splitKindFor(doc) {
    if (!doc || !doc.format) return '';
    if (doc.format.preview) return 'markdown';
    if (isSvgDoc(doc)) return 'svg';
    if (isHtmlDoc(doc)) return 'html';
    return '';
}

function canSplitDoc(doc) {
    return !!doc && !doc.binary && !doc.large && !!splitKindFor(doc);
}
const CSV_ROW_NUM_WIDTH = 44;
const CSV_COL_MIN_WIDTH = 56;

function viewOptionsFor(fmt, doc) {
    if (doc && (doc.browser || doc.bgTerm)) return [];
    if (fmt && fmt.image) return IMAGE_VIEWS;
    if (fmt && fmt.id === 'bytes') return BINARY_VIEWS;
    if (isHtmlDoc(doc)) return HTML_VIEWS;
    if (fmt && fmt.id === 'markdown') return MARKDOWN_VIEWS;
    if (isSvgDoc(doc)) return SVG_VIEWS;
    if (fmt && fmt.id === 'jsonl') return JSONL_VIEWS;
    if (fmt && fmt.patch) return PATCH_VIEWS;
    return fmt && (fmt.table || fmt.id === 'csv') ? CSV_VIEWS : VIEWS;
}

function isSqlSupportedDoc(doc) {
    const id = doc && doc.format && doc.format.id;
    return id === 'csv' || id === 'jsonl';
}

// 旧版本把 sql 当视图模式持久化过；SQL 现在是覆盖层，恢复时归一为底层视图
function normalizeLegacySqlMode(doc) {
    if (doc && doc.mode === 'sql') {
        doc.mode = doc.sqlPrevMode || 'text';
        doc.sqlActive = false;
        if (doc.pane) doc.pane.classList.remove('sql-active');
    }
    return (doc && doc.mode) || 'tree';
}

function viewDisabled(mode) {
    if (!deps.file) return true;
    if (mode === 'image') return !deps.file.image;
    if (mode === 'binary') return !deps.file.binary;
    if (mode === 'tree') return !deps.file.treeAvailable;
    if (mode === 'text') return false;
    if (mode === 'preview') return !(deps.file.format && deps.file.format.preview) || !!deps.file.large;
    if (mode === 'render') return !isSvgDoc(deps.file);
    if (mode === 'split') return !canSplitDoc(deps.file);
    if (mode === 'sql') return !isSqlSupportedDoc(deps.file);
    return false;
}

function viewDisabledTitle(mode) {
    if (mode === 'preview' && deps.file && deps.file.large) return '大文件不支持预览';
    if (mode === 'sql') return 'SQL 查询仅支持 CSV / TSV / JSONL';
    return '当前文件只支持代码视图';
}

// text 组是兜底组（纯文本 + CMake/Make/Dockerfile/Git 规则等特殊文件名），
// 状态栏按 ace 语法模式细化显示，不再一律叫「纯文本」
const TEXT_MODE_NAMES = {
    cmake: 'CMake', dockerfile: 'Dockerfile', makefile: 'Makefile',
    diff: 'Diff', protobuf: 'Protobuf', graphqlschema: 'GraphQL', gitignore: 'Git 规则',
};

function formatDisplayName(doc) {
    if (doc && doc.format && doc.format.id === 'text' && doc.name) {
        try {
            const mode = aceModeFor(doc.name, doc.format).split('/').pop();
            if (TEXT_MODE_NAMES[mode]) return TEXT_MODE_NAMES[mode];
        } catch (e) {}
    }
    return (doc && doc.format && doc.format.name) || '';
}

function viewLabel(mode) {
    if (mode === 'browser') return '网页视图';
    if (mode === 'split') return '分屏';
    if (mode === 'image') return '图片视图';
    if (mode === 'binary') return '二进制视图';
    if (mode === 'preview') return '预览';
    if (mode === 'render') return '渲染视图';
    if (mode === 'table') return '表格视图';
    if (mode === 'patch') return '补丁视图';
    if (mode === 'sql') return 'SQL 查询';
    if (mode === 'text') return '文本视图';
    if (mode === 'code') return '代码视图';
    return '树视图';
}

const TREE_MAX_CHILDREN = 10000;
const editorLocale = {
    'zh-CN': {
        showMoreStatus: '已显示 ${visibleChilds} / ${totalChilds} 项',
        showMore: '显示更多',
        showAll: '显示全部',
        'editor.tooltip.disable-editing': '只读模式下无法编辑',
    },
};

// 兜底：Ace 只读提示的内核文案是英文，观察器改写成中文（若语言包已生效则不会命中）。
// 注意：hoverTooltip 会把消息 <div> 作为子节点插入，addedNode 通常是内层 div 而不是
// .ace_tooltip 容器本身，所以这里要向上找容器。
const readonlyTipObserver = new MutationObserver((muts) => {
    for (const m of muts) {
        for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            const tip = node.classList.contains('ace_tooltip')
                ? node
                : (node.parentElement ? node.parentElement.closest('.ace_tooltip') : null);
            if (tip && tip.textContent === 'Editing is disabled') {
                tip.textContent = '只读模式下无法编辑';
            }
        }
    }
});
readonlyTipObserver.observe(document.body, {childList: true, subtree: true});

// 治本：把只读提示的中文文案直接注册进 Ace 的 nls。
// setMessages 是整表替换（不是合并）：必须带上默认英文表，否则其余键会逐个告警并回退。
// jsoneditor 的语言包不进 Ace nls，二进制 / 文本等只读编辑器此前一直是英文；
// 这里注册后所有 Ace 实例生效，观察器仅作兜底。
try {
    if (window.ace && ace.config && typeof ace.config.setMessages === 'function') {
        let base = null;
        try {
            const mod = ace.require('ace/lib/default_english_messages');
            base = mod && mod.defaultEnglishMessages;
        } catch (e) {}
        if (base && typeof base === 'object') {
            ace.config.setMessages(Object.assign({}, base, {'editor.tooltip.disable-editing': '只读模式下无法编辑'}));
        }
    }
} catch (e) {}

// 共享 Markdown 渲染层（frontend/src/markdown.js）：主界面与阅读模式共用，
// sanitize 规则单一来源（docs/finished-plans/reading-mode.md §10.2）。mermaid 脚本加载仍在 main.js。
let markdownRenderer;
const sharedMarkdown = createMarkdownRenderer({
    mdLineNumbers: () => deps.settings.mdLineNumbers,
    mermaidPlaceholder: (text) => renderMermaidPlaceholder(text),
});
markdownRenderer = sharedMarkdown.markdownRenderer;
const renderMarkdownHtml = sharedMarkdown.renderMarkdownHtml;

// renderMermaidPlaceholder mermaid 图表占位：渲染后异步替换为 SVG
function renderMermaidPlaceholder(text) {
    return '<div class="md-mermaid" data-src="' + markdownRenderer.utils.escapeHtml(text) + '"></div>';
}

let mermaidScriptLoading = false;

function ensureMermaidScript() {
    if (window.mermaid || mermaidScriptLoading) return;
    mermaidScriptLoading = true;
    const script = document.createElement('script');
    script.src = '/vendor/mermaid/mermaid.min.js';
    script.onload = () => {
        mermaidScriptLoading = false;
        try {
            window.mermaid.initialize({startOnLoad: false, securityLevel: 'strict'});
        } catch (e) {}
        if (deps.file && deps.currentMode === 'preview') deps.renderMarkdownPreview(deps.file);
    };
    script.onerror = () => {
        mermaidScriptLoading = false;
        for (const el of document.querySelectorAll('.md-mermaid')) {
            el.textContent = 'mermaid 库加载失败';
        }
    };
    document.head.appendChild(script);
}

function mermaidThemeForCurrent() {
    const id = deps.currentTheme().id;
    return /dark|darcula/.test(id) ? 'dark' : 'neutral';
}

async function renderMermaidBlocks(root) {
    const blocks = (root || document).querySelectorAll('.md-mermaid:not([data-rendered])');
    if (!blocks.length) return;
    if (!window.mermaid) {
        ensureMermaidScript();
        if (!window.mermaid) return;
    }
    try {
        window.mermaid.initialize({startOnLoad: false, securityLevel: 'strict', theme: mermaidThemeForCurrent()});
    } catch (e) {}
    for (const block of blocks) {
        const msrc = block.dataset.src || '';
        if (!msrc.trim()) continue;
        block.dataset.rendered = '1';
        try {
            const {svg} = await window.mermaid.render('mmd-' + Math.random().toString(36).slice(2), msrc);
            // mermaid strict 已自净化，这里再过一遍 DOMPurify（SVG 档）兜底；
            // style/foreignObject 是 mermaid 自带样式与 HTML 标签所需，保留但内容仍被消毒。
            block.innerHTML = DOMPurify.sanitize(svg, {
                USE_PROFILES: {svg: true, svgFilters: true},
                ADD_TAGS: ['style', 'foreignObject'],
            });
        } catch (e) {
            block.classList.add('md-mermaid-error');
            block.textContent = 'mermaid 图表渲染失败：' + (e && e.message || e);
        }
    }
}

// renderMarkdownCodeBlock / fence / link_open 规则已随渲染器抽到 markdown.js。

// resolveMarkdownImages 把 Markdown 预览里相对路径/本地绝对路径的图片换成后端读取的 data URL。
function resolveMarkdownImages(doc) {
    if (!doc || !doc.previewBody) return;
    const BS = String.fromCharCode(92); // 反斜杠（避免注入层转义问题）
    const raw0 = doc.path || '';
    const cut = Math.max(raw0.lastIndexOf('/'), raw0.lastIndexOf(BS));
    const base = cut >= 0 ? raw0.slice(0, cut) : '';
    for (const img of doc.previewBody.querySelectorAll('img')) {
        const raw = img.getAttribute('data-ai-src') || img.getAttribute('src') || '';
        if (!raw || /^(https?:|data:|blob:)/i.test(raw)) continue;
        let p = raw;
        if (/^file:/i.test(p)) p = p.slice(7);
        p = p.replace(/^\/+/, '');
        try { p = decodeURIComponent(p); } catch (e) {}
        p = p.split('/').join(BS);
        let abs;
        if (/^[A-Za-z]:/.test(p)) abs = p;
        else if (base) abs = base + BS + p;
        else continue;
        const parts = [];
        for (const seg of abs.split(BS)) {
            if (seg === '.' || seg === '') continue;
            if (seg === '..') { parts.pop(); continue; }
            parts.push(seg);
        }
        abs = parts.join(BS);
        if (!deps.backend.ReadImageAsDataURL) continue;
        deps.backend.ReadImageAsDataURL(abs).then((url) => { if (url) img.src = url; }).catch(() => {});
    }
}

// renderMarkdownHtml 已抽到 markdown.js（共享 sanitize 配置）。

function makeSelect(options, value, onChange) {
    const sel = document.createElement('select');
    for (const [v, label] of options) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = label;
        if (v === value) opt.selected = true;
        sel.appendChild(opt);
    }
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
}

const footPopover = document.getElementById('enc-popover');
const FOOT_WIDGETS = {encoding: deps.els.stEnc, view: deps.els.stMode, eol: deps.els.stEol, zoom: deps.els.stZoom, mdWidth: deps.els.stMdWidth, aiWidth: deps.els.stAiWidth};
let footPopoverKind = null;
// 编码/换行/缩进弹出面板的行图标用 icons.js 渲染（不再使用 MDL2 字符）
function closeFootPopover() {
    footPopover.classList.add('hidden');
    Object.values(FOOT_WIDGETS).forEach((el) => el && el.classList.remove('active'));
    footPopoverKind = null;
}

function popTitle(text) {
    const t = document.createElement('div');
    t.className = 'enc-title';
    t.textContent = text;
    return t;
}

function popSep() {
    const s = document.createElement('div');
    s.className = 'enc-sep';
    return s;
}

function popFoot(prefix, value) {
    const foot = document.createElement('div');
    foot.className = 'enc-foot';
    foot.textContent = prefix + ': ';
    const b = document.createElement('b');
    b.textContent = value;
    foot.appendChild(b);
    return foot;
}

function popItem(label, opts = {}) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'enc-item' + (opts.current ? ' current' : '');
    const ic = document.createElement('span');
    ic.className = 'enc-ic' + (opts.current ? ' cur' : (opts.iconClass ? ' ' + opts.iconClass : ''));
    if (opts.current) ic.innerHTML = iconSvg('check', 12);
    const text = document.createElement('span');
    text.textContent = label;
    row.append(ic, text);
    if (opts.disabled) {
        row.disabled = true;
        row.style.opacity = '0.4';
        row.title = opts.disabledTitle || '';
    } else if (opts.onClick) {
        row.addEventListener('click', opts.onClick);
    }
    return row;
}

function toggleBom() {
    if (!deps.file) return;
    deps.file.hasBom = !deps.file.hasBom;
    setDirty(true);
    deps.updateStatus();
    if (footPopoverKind === 'encoding') {
        footPopover.textContent = '';
        renderEncodingMenu();
    }
}

function convertEncoding(enc) {
    if (!deps.file) return;
    if ((deps.file.enc || 'utf-8') === enc) {
        closeFootPopover();
        return;
    }
    deps.file.enc = enc;
    if (enc !== 'utf-8') deps.file.hasBom = false;
    setDirty(true);
    deps.updateStatus();
    flash('编码已转换为 ' + enc.toUpperCase());
    closeFootPopover();
}

async function renderEncodingMenu() {
    const current = deps.file.enc || 'utf-8';
    footPopover.appendChild(popTitle('文件编码'));
    footPopover.appendChild(popItem(
        current === 'utf-8' ? (deps.file.hasBom ? '移除 BOM' : '添加 BOM') : '添加 BOM（仅 UTF-8）',
        {disabled: current !== 'utf-8', disabledTitle: '仅 UTF-8 支持 BOM', onClick: toggleBom}
    ));
    footPopover.appendChild(popSep());
    const rows = [];
    for (const [enc, label] of CONVERT_ENCODINGS) {
        const row = popItem(label, {current: enc === current, onClick: () => convertEncoding(enc)});
        footPopover.appendChild(row);
        if (enc !== current) rows.push({enc, ic: row.querySelector('.enc-ic')});
    }
    footPopover.appendChild(popFoot('文件编码', current.toUpperCase() + (deps.file.hasBom && current === 'utf-8' ? ' BOM' : '')));
    for (const {enc, ic} of rows) {
        try {
            const ok = await deps.backend.CheckEncoding(deps.file.content || '', enc);
            ic.innerHTML = iconSvg(ok ? 'check' : 'warn', 12);
            ic.className = 'enc-ic ' + (ok ? 'ok' : 'warn');
            ic.title = ok ? '可无损表示当前内容' : '包含无法表示的字符，转换后可能丢失';
        } catch (e) {}
    }
}

function renderViewMenu() {
    footPopover.appendChild(popTitle('视图'));
    const splitActive = !!(deps.file && deps.file.splitActive);
    for (const [mode, label] of viewOptionsFor(deps.file && deps.file.format, deps.file)) {
        const disabled = viewDisabled(mode);
        footPopover.appendChild(popItem(label, {
            current: mode === 'split' ? splitActive
                : (mode === 'sql' ? !!(deps.file && deps.file.sqlActive) : (!splitActive && deps.currentMode === mode)),
            disabled,
            disabledTitle: viewDisabledTitle(mode),
            onClick: () => { deps.switchMode(mode); closeFootPopover(); },
        }));
    }
    footPopover.appendChild(popFoot('当前', splitActive ? viewLabel('split') : viewLabel(deps.currentMode)));
}

function renderImageZoomMenu() {
    if (!deps.file || !deps.file.image) return;
    const doc = deps.file;
    footPopover.appendChild(popTitle('图片缩放'));
    footPopover.appendChild(popItem('自动（适配显示区）', {
        current: doc.imageZoom == null,
        onClick: () => {
            doc.imageZoom = null;
            deps.applyImageZoom(doc);
            closeFootPopover();
        },
    }));
    footPopover.appendChild(popSep());
    for (const percent of [25, 50, 75, 100, 150, 200, 400, 800]) {
        footPopover.appendChild(popItem(percent + '%', {
            current: doc.imageZoom != null && Math.round(doc.imageZoom * 100) === percent,
            onClick: () => {
                doc.imageZoom = percent / 100;
                deps.applyImageZoom(doc);
                closeFootPopover();
            },
        }));
    }
    const current = doc.imageScale ? Math.round(doc.imageScale * 100) + '%' : '—';
    footPopover.appendChild(popFoot('当前', current));
}

function renderTableZoomMenu() {
    if (!deps.file || !deps.file.format || !deps.file.format.table) return;
    const doc = deps.file;
    footPopover.appendChild(popTitle('表格缩放'));
    for (const percent of [25, 50, 75, 100, 150, 200, 400, 800]) {
        footPopover.appendChild(popItem(percent + '%', {
            current: Math.round((doc.tableZoom || 1) * 100) === percent,
            onClick: () => {
                doc.tableZoom = percent / 100;
                deps.applyCsvTableZoom(doc);
                deps.updateStatus();
                closeFootPopover();
            },
        }));
    }
    footPopover.appendChild(popFoot('当前', Math.round((doc.tableZoom || 1) * 100) + '%'));
}

function mdPreviewWidthLabel(value) {
    return String(value) === '0' ? '自适应' : value + 'px';
}

function aiFullscreenWidthLabel(value) {
    const current = String(value || 'auto');
    if (current === 'auto') return '自动';
    return current === '0' ? '跟随' : current + 'px';
}

function updateAiWidthWidget() {
    if (!deps.els.stAiWidth) return;
    const show = !!deps.settings.aiPanelOpen;
    deps.els.stAiWidth.style.display = show ? '' : 'none';
    if (!show) {
        deps.els.stAiWidth.textContent = '';
        return;
    }
    const value = String(deps.settings.aiFullscreenWidth || 'auto');
    deps.els.stAiWidth.textContent = 'AI 宽度 · ' + aiFullscreenWidthLabel(value);
    deps.els.stAiWidth.title = value === 'auto'
        ? 'AI 内容宽度（停靠 / 全屏通用）：自动（< 920px 跟随，≥ 920px 最大 920px）'
        : 'AI 内容宽度（停靠 / 全屏通用）：' + (value === '0' ? '跟随' : value + 'px');
}

function renderAiWidthMenu() {
    footPopover.appendChild(popTitle('AI 内容宽度（停靠 / 全屏）'));
    const options = [['auto', '自动（默认）'], ['720', '720px'], ['860', '860px'], ['920', '920px'], ['1100', '1100px'], ['1300', '1300px'], ['0', '跟随']];
    for (const [value, label] of options) {
        footPopover.appendChild(popItem(label, {
            current: String(deps.settings.aiFullscreenWidth) === value,
            onClick: () => {
                deps.settings.aiFullscreenWidth = value;
                deps.applySettings();
                closeFootPopover();
            },
        }));
    }
    footPopover.appendChild(popSep());
    footPopover.appendChild(popFoot('当前', aiFullscreenWidthLabel(deps.settings.aiFullscreenWidth)));
    footPopover.appendChild(popFoot('自动规则', '<920px 跟随 / ≥920px 最大 920px'));
}

function renderMdWidthMenu() {
    footPopover.appendChild(popTitle('Markdown 预览宽度'));
    const options = [['720', '720px'], ['860', '860px'], ['920', '920px'], ['1100', '1100px'], ['1300', '1300px'], ['0', '跟随窗口宽度']];
    for (const [value, label] of options) {
        footPopover.appendChild(popItem(label, {
            current: String(deps.settings.mdPreviewWidth) === value,
            onClick: () => {
                deps.settings.mdPreviewWidth = value;
                deps.applySettings();
                deps.updateStatus();
                closeFootPopover();
            },
        }));
    }
    footPopover.appendChild(popSep());
    footPopover.appendChild(popItem('更多设置…', {
        onClick: () => {
            closeFootPopover();
            deps.openSettings('general');
        },
    }));
    footPopover.appendChild(popFoot('当前', mdPreviewWidthLabel(deps.settings.mdPreviewWidth)));
}

function chooseEol(value) {
    if (!deps.file) return;
    const fs = deps.getFormatSettings(deps.file.format.id);
    if (fs.eol === value) {
        closeFootPopover();
        return;
    }
    const before = fs.eol === 'follow' ? deps.file.eol : fs.eol;
    fs.eol = value;
    deps.applySettings();
    const after = value === 'follow' ? deps.file.eol : value;
    if (after !== before) setDirty(true);
    deps.updateStatus();
    flash('保存换行: ' + (value === 'follow' ? '跟随原文件' : value.toUpperCase()));
    closeFootPopover();
}

function renderEolMenu() {
    const fs = deps.getFormatSettings(deps.file.format.id);
    const eff = fs.eol === 'follow' ? deps.file.eol : fs.eol;
    footPopover.appendChild(popTitle('换行符'));
    for (const [value, label] of EOLS) {
        footPopover.appendChild(popItem(label, {
            current: fs.eol === value,
            onClick: () => chooseEol(value),
        }));
    }
    footPopover.appendChild(popFoot('当前', eff.toUpperCase()));
}

function openFootPopover(kind) {
    if (!deps.file && kind !== 'aiWidth') return;
    const anchor = FOOT_WIDGETS[kind];
    if (!anchor) return;
    footPopover.textContent = '';
    footPopover.classList.remove('hidden');
    if (kind === 'encoding') renderEncodingMenu();
    else if (kind === 'view') renderViewMenu();
    else if (kind === 'zoom') {
        if (deps.currentMode === 'table' && deps.file.format && deps.file.format.table) renderTableZoomMenu();
        else renderImageZoomMenu();
    }
    else if (kind === 'mdWidth') renderMdWidthMenu();
    else if (kind === 'aiWidth') renderAiWidthMenu();
    else renderEolMenu();
    const r = anchor.getBoundingClientRect();
    const pr = footPopover.getBoundingClientRect();
    // 向上弹出，空间不足时限制高度内部滚动，避免被窗口顶部截断
    const available = r.top - 14;
    if (pr.height > available && available > 120) {
        footPopover.style.maxHeight = available + 'px';
        footPopover.style.overflowY = 'auto';
        const pr2 = footPopover.getBoundingClientRect();
        footPopover.style.left = Math.max(8, Math.round(r.right - pr2.width)) + 'px';
        footPopover.style.top = Math.round(r.top - pr2.height - 6) + 'px';
    } else {
        footPopover.style.maxHeight = '';
        footPopover.style.overflowY = '';
        footPopover.style.left = Math.max(8, Math.round(r.right - pr.width)) + 'px';
        footPopover.style.top = Math.round(r.top - pr.height - 6) + 'px';
    }
    Object.values(FOOT_WIDGETS).forEach((el) => el && el.classList.remove('active'));
    anchor.classList.add('active');
    footPopoverKind = kind;
}

function toggleFootPopover(kind) {
    if (footPopoverKind === kind && !footPopover.classList.contains('hidden')) closeFootPopover();
    else openFootPopover(kind);
}

Object.entries(FOOT_WIDGETS).forEach(([kind, el]) => {
    if (!el) return;
    el.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFootPopover(kind);
    });
});
footPopover.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.closest && (t.closest('#enc-popover') || t.closest('#statusbar'))) return;
    closeFootPopover();
}, true);
window.addEventListener('blur', () => closeFootPopover());

function setupFormatSettings() {
    const children = document.querySelector('#snav-formats .snav-children');
    const content = document.querySelector('.settings-content');
    if (!children || !content) return;
    for (const f of deps.allFormatDefs()) {
        if (children.querySelector(`[data-pane="fmt-${f.id}"]`)) continue;
        const nav = document.createElement('button');
        nav.type = 'button';
        nav.className = 'snav-item snav-child snav-fmt';
        nav.dataset.pane = 'fmt-' + f.id;
        nav.textContent = f.name;
        children.appendChild(nav);
        if (!content.querySelector(`.settings-pane[data-pane="fmt-${f.id}"]`)) {
            const pane = document.createElement('div');
            pane.className = 'settings-pane hidden';
            pane.dataset.pane = 'fmt-' + f.id;
            content.appendChild(pane);
        }
    }
}

function setupLanguageSettings() {
    const children = document.getElementById('snav-lang-children');
    const content = document.querySelector('.settings-content');
    if (!children || !content) return;
    for (const lang of LANG_DEFS) {
        if (children.querySelector(`[data-pane="lang-${lang.id}"]`)) continue;
        const nav = document.createElement('button');
        nav.type = 'button';
        nav.className = 'snav-item snav-child snav-lang';
        nav.dataset.pane = 'lang-' + lang.id;
        nav.textContent = lang.name;
        children.appendChild(nav);
        if (!content.querySelector(`.settings-pane[data-pane="lang-${lang.id}"]`)) {
            const pane = document.createElement('div');
            pane.className = 'settings-pane hidden';
            pane.dataset.pane = 'lang-' + lang.id;
            content.appendChild(pane);
        }
    }
}

// 每个语言的环境状态按工具拆分存放在 settings.langEnv[id].tools[toolId]
function langEnvFor(id) {
    if (!deps.settings.langEnv || typeof deps.settings.langEnv !== 'object') deps.settings.langEnv = {};
    const entry = deps.settings.langEnv[id];
    if (!entry || typeof entry !== 'object') {
        deps.settings.langEnv[id] = {tools: {}};
    } else if (Array.isArray(entry.envs) && !entry.tools) {
        // 旧结构迁移：语言级缓存挪到该语言的主工具下
        const lang = LANG_DEFS.find((l) => l.id === id);
        const primary = lang && lang.tools && lang.tools[0] ? lang.tools[0].id : id;
        const migrated = {
            envs: entry.envs,
            selectedPath: entry.selectedPath || '',
            pathOverride: entry.pathOverride || '',
            scannedAt: entry.scannedAt || 0,
        };
        deps.settings.langEnv[id] = {tools: {}};
        deps.settings.langEnv[id].tools[primary] = migrated;
    }
    if (!deps.settings.langEnv[id].tools || typeof deps.settings.langEnv[id].tools !== 'object') deps.settings.langEnv[id].tools = {};
    return deps.settings.langEnv[id];
}

function toolEnvFor(id, toolId) {
    const e = langEnvFor(id);
    if (!e.tools[toolId] || typeof e.tools[toolId] !== 'object') e.tools[toolId] = {};
    return e.tools[toolId];
}

// effectiveToolEnv 当前生效的环境：手动指定 > 手动选择 > 默认第一个
function effectiveToolEnv(id, toolId) {
    const env = toolEnvFor(id, toolId);
    const list = Array.isArray(env.envs) ? env.envs : [];
    if (env.pathOverride) {
        const hit = list.find((x) => x.path && String(x.path).toLowerCase() === env.pathOverride.toLowerCase());
        if (hit) return hit;
        return {ok: false, path: env.pathOverride, error: env.error || '指定的路径不可用'};
    }
    const hit = env.selectedPath ? list.find((x) => x.path && String(x.path).toLowerCase() === env.selectedPath.toLowerCase()) : null;
    return hit || list[0] || {ok: false, error: env.error || '未找到可用环境'};
}

function renderLangPane(id) {
    const lang = LANG_DEFS.find((l) => l.id === id);
    const pane = document.querySelector(`.settings-pane[data-pane="lang-${id}"]`);
    if (!lang || !pane) return;
    pane.textContent = '';
    const title = document.createElement('div');
    title.className = 'fmt-pane-title';
    title.textContent = lang.name;
    const sub = document.createElement('div');
    sub.className = 'fmt-pane-sub';
    sub.textContent = '环境信息（解释器 / 编译器与配套工具链的路径和版本），缓存到本地；按 F5 运行当前文件时用的就是这里选中的环境';
    pane.append(title, sub);

    for (const tool of lang.tools) {
        const env = toolEnvFor(id, tool.id);
        const list = Array.isArray(env.envs) ? env.envs : [];
        const eff = effectiveToolEnv(id, tool.id);

        const sec = document.createElement('div');
        sec.className = 'env-tool';

        const head = document.createElement('div');
        head.className = 'env-tool-head';
        const dot = document.createElement('span');
        dot.className = 'env-dot' + (env.scanning ? ' busy' : (env.scannedAt ? (eff && eff.ok ? ' ok' : (tool.optional ? '' : ' fail')) : ''));
        const headText = document.createElement('span');
        headText.textContent = tool.name + (tool.optional ? '（可选）' : '');
        head.append(dot, headText);
        sec.appendChild(head);

        // 多环境选择框：扫描出多个时默认选第一个，可手动切换
        if (list.length) {
            const sel = document.createElement('select');
            sel.className = 'env-select';
            for (const e of list) {
                const opt = document.createElement('option');
                opt.value = e.path || '';
                opt.textContent = (e.version ? e.version + ' ｜ ' : '') + (e.path || '');
                sel.appendChild(opt);
            }
            if (eff && eff.path && list.some((e) => e.path === eff.path)) sel.value = eff.path;
            if (env.pathOverride) {
                sel.disabled = true;
                sel.title = '手动指定路径时忽略此选择';
            }
            sel.addEventListener('change', () => {
                env.selectedPath = sel.value;
                deps.applySettings();
                if (id === 'python') resetLangPkgs(id);
                renderLangPane(id);
            });
            sec.appendChild(sel);
        }

        const body = document.createElement('div');
        body.className = 'env-status';
        if (env.scanning) {
            const line = document.createElement('div');
            line.className = 'env-meta';
            line.textContent = '正在扫描…';
            body.appendChild(line);
        } else if (!env.scannedAt) {
            const line = document.createElement('div');
            line.className = 'env-meta';
            line.textContent = '未检测';
            body.appendChild(line);
        } else if (eff && eff.ok) {
            const vRow = document.createElement('div');
            vRow.className = 'env-status-row';
            const vk = document.createElement('span');
            vk.className = 'env-status-key';
            vk.textContent = '版本';
            const vv = document.createElement('span');
            vv.className = 'env-status-val';
            vv.textContent = eff.version || '';
            vRow.append(vk, vv);
            body.appendChild(vRow);
            const pRow = document.createElement('div');
            pRow.className = 'env-status-row';
            const pk = document.createElement('span');
            pk.className = 'env-status-key';
            pk.textContent = '路径';
            const pv = document.createElement('span');
            pv.className = 'env-status-val mono';
            pv.textContent = eff.path || '';
            pv.title = eff.path || '';
            pRow.append(pk, pv);
            body.appendChild(pRow);
        } else {
            const line = document.createElement('div');
            line.className = 'env-error';
            line.textContent = (eff && eff.error) || env.error || '未找到可用环境';
            body.appendChild(line);
        }
        if (env.scannedAt && !env.scanning) {
            const meta = document.createElement('div');
            meta.className = 'env-meta';
            const source = env.pathOverride ? '手动指定' : (env.selectedPath ? '手动选择' : '默认');
            meta.textContent = '上次扫描 ' + deps.propsTimeText(env.scannedAt) + ' · ' + source;
            body.appendChild(meta);
        }
        sec.appendChild(body);

        // 手动指定：输入框 + 「…」按钮，可手输也可打开文件对话框选择
        const overrideRow = document.createElement('div');
        overrideRow.className = 'env-override-row';
        const overrideInput = document.createElement('input');
        overrideInput.type = 'text';
        overrideInput.className = 'env-override';
        overrideInput.placeholder = '手动指定可执行文件路径';
        overrideInput.value = env.pathOverride || '';
        overrideInput.addEventListener('change', () => {
            env.pathOverride = overrideInput.value.trim();
            deps.applySettings();
            if (id === 'python') resetLangPkgs(id);
            renderLangPane(id);
        });
        const browseBtn = document.createElement('button');
        browseBtn.type = 'button';
        browseBtn.className = 'env-browse';
        browseBtn.title = '浏览…';
        browseBtn.textContent = '…';
        browseBtn.disabled = !!env.scanning;
        browseBtn.addEventListener('click', async () => {
            if (!deps.backend.ShowOpenFileDialog) {
                flash('当前版本不支持选择文件', true);
                return;
            }
            try {
                const picked = await deps.backend.ShowOpenFileDialog('选择 ' + tool.name + ' 可执行文件', 'exe');
                if (!picked) return;
                overrideInput.value = picked;
                env.pathOverride = picked;
                deps.applySettings();
                if (tool.id === 'python') resetLangPkgs(id);
                await scanLanguageTool(id, tool.id);
            } catch (e) {
                flash('选择文件失败：' + ((e && e.message) || e), true);
            }
        });
        overrideRow.append(overrideInput, browseBtn);
        sec.appendChild(overrideRow);

        pane.appendChild(sec);
    }

    const anyScanning = lang.tools.some((t) => toolEnvFor(id, t.id).scanning);
    const btnRow = document.createElement('div');
    btnRow.className = 'popover-row';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tb-btn';
    const scanned = lang.tools.every((t) => toolEnvFor(id, t.id).scannedAt);
    btn.textContent = scanned ? '重新扫描' : '扫描环境';
    btn.disabled = anyScanning;
    btn.addEventListener('click', () => scanLanguageAll(id));
    btnRow.appendChild(btn);
    pane.appendChild(btnRow);

    const hint = document.createElement('div');
    hint.className = 'fmt-hint';
    hint.textContent = '首次打开会自动扫描一次并缓存；扫描出多个环境时默认选第一个，可用下拉切换，或在各工具的「手动指定」里填路径。';
    pane.appendChild(hint);

    // 已安装的包：python（pip 全局 / .venv）与 node（npm 全局 / 项目 node_modules）
    if (lang.pkgs && lang.pkgs.length) {
        const pkgSec = document.createElement('div');
        pkgSec.className = 'env-tool';
        const pkgHead = document.createElement('div');
        pkgHead.className = 'env-tool-head';
        pkgHead.textContent = '已安装的包';
        pkgSec.appendChild(pkgHead);
        for (const scope of lang.pkgs) {
            pkgSec.appendChild(renderPkgScope(id, scope));
        }
        pane.appendChild(pkgSec);
    }

    // 自动扫描：还没扫过的工具按顺序补一次（结果缓存，不重复扫）
    const pending = lang.tools.filter((t) => {
        const e = toolEnvFor(id, t.id);
        return !e.scanning && !e.scannedAt;
    });
    const container = langEnvFor(id);
    if (pending.length && !anyScanning && !container._autoScanning) {
        container._autoScanning = true;
        (async () => {
            try {
                for (const t of pending) {
                    await scanLanguageTool(id, t.id);
                }
            } finally {
                container._autoScanning = false;
            }
        })();
    }

    // 包列表：还没有缓存结果的作用域按顺序补一次
    if (lang.pkgs && lang.pkgs.length) {
        const pendingPkgs = lang.pkgs.filter((s) => {
            const st = pkgStateFor(id, s.id);
            return !st.scanning && !st.scannedAt;
        });
        if (pendingPkgs.length && !container._pkgAutoScanning) {
            container._pkgAutoScanning = true;
            (async () => {
                try {
                    for (const s of pendingPkgs) {
                        await scanLanguagePkgs(id, s.id);
                    }
                } finally {
                    container._pkgAutoScanning = false;
                }
            })();
        }
    }
}

async function scanLanguageTool(id, toolId) {
    const env = toolEnvFor(id, toolId);
    if (env.scanning) return;
    env.scanning = true;
    renderLangPane(id);
    let res = null;
    try {
        res = deps.backend.DetectToolchain ? await deps.backend.DetectToolchain(toolId, env.pathOverride || '') : null;
    } catch (e) {
        res = {envs: []};
    }
    env.scanning = false;
    env.scannedAt = Date.now();
    const list = res && Array.isArray(res.envs) ? res.envs : [];
    env.envs = list;
    const prev = env.selectedPath;
    env.selectedPath = prev && list.some((x) => x.path && String(x.path).toLowerCase() === prev.toLowerCase()) ? prev : '';
    env.error = list.length ? '' : ((res && res.error) || '未找到可用环境');
    deps.applySettings();
    renderLangPane(id);
}

async function scanLanguageAll(id) {
    const lang = LANG_DEFS.find((l) => l.id === id);
    if (!lang) return;
    for (const tool of lang.tools) {
        await scanLanguageTool(id, tool.id);
    }
}

// ---- 已安装的包列表：python（pip）与 node（npm）----

function pkgStateFor(id, scope) {
    const container = langEnvFor(id);
    if (!container.pkgs || typeof container.pkgs !== 'object') container.pkgs = {};
    if (!container.pkgs[scope] || typeof container.pkgs[scope] !== 'object') container.pkgs[scope] = {};
    return container.pkgs[scope];
}

function resetLangPkgs(id) {
    const container = langEnvFor(id);
    if (!container.pkgs || typeof container.pkgs !== 'object') return;
    for (const key of Object.keys(container.pkgs)) {
        container.pkgs[key].scannedAt = 0;
    }
}

function renderPkgScope(id, scope) {
    const lang = LANG_DEFS.find((l) => l.id === id);
    // scope 兼容传对象或 id 字符串
    const scopeDef = typeof scope === 'object'
        ? scope
        : ((lang.pkgs || []).find((s) => s.id === scope) || {id: scope, label: scope});
    const scopeId = scopeDef.id;
    const st = pkgStateFor(id, scopeId);
    const wrap = document.createElement('div');
    wrap.className = 'pkg-scope';

    const head = document.createElement('div');
    head.className = 'pkg-scope-head';
    const name = document.createElement('span');
    name.className = 'env-tool-head';
    name.style.marginBottom = '0';
    const dot = document.createElement('span');
    dot.className = 'env-dot' + (st.scanning ? ' busy' : (st.scannedAt ? (st.error ? ' fail' : ' ok') : ''));
    const nameText = document.createElement('span');
    nameText.textContent = scopeDef.label;
    name.append(dot, nameText);
    const count = document.createElement('span');
    count.className = 'pkg-count';
    count.textContent = st.scanning || st.error
        ? ''
        : (st.exists ? ((Array.isArray(st.list) ? st.list.length : 0) + ' 个包') : '未找到');
    name.appendChild(count);
    head.appendChild(name);

    const filter = document.createElement('input');
    filter.type = 'text';
    filter.className = 'pkg-filter';
    filter.placeholder = '过滤包名…';
    filter.value = st.filterText || '';
    filter.addEventListener('input', () => {
        st.filterText = filter.value;
        renderPkgRows();
    });

    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'tb-btn';
    refresh.textContent = '刷新';
    refresh.disabled = !!st.scanning;
    refresh.addEventListener('click', () => scanLanguagePkgs(id, scopeId));
    head.append(filter, refresh);
    wrap.appendChild(head);

    const listBox = document.createElement('div');
    listBox.className = 'pkg-list';
    const renderPkgRows = () => {
        listBox.textContent = '';
        if (st.scanning) {
            const line = document.createElement('div');
            line.className = 'pkg-empty';
            line.textContent = '正在扫描…';
            listBox.appendChild(line);
            return;
        }
        if (st.error) {
            const line = document.createElement('div');
            line.className = 'env-error';
            line.textContent = st.error;
            listBox.appendChild(line);
            return;
        }
        if (!st.exists) {
            const line = document.createElement('div');
            line.className = 'pkg-empty';
            line.textContent = scopeId === 'env'
                ? '未检测到可用的 Python 解释器'
                : (id === 'go' ? '当前工作区没有 go.mod' : '当前目录没有 package.json');
            listBox.appendChild(line);
            return;
        }
        const q = (st.filterText || '').trim().toLowerCase();
        const list = (Array.isArray(st.list) ? st.list : []).filter((p) => !q || String(p.name).toLowerCase().includes(q));
        if (!list.length) {
            const line = document.createElement('div');
            line.className = 'pkg-empty';
            line.textContent = q ? '没有匹配的包' : '没有已安装的包';
            listBox.appendChild(line);
            return;
        }
        for (const p of list) {
            const row = document.createElement('div');
            row.className = 'pkg-row';
            const n = document.createElement('span');
            n.className = 'pkg-name';
            n.textContent = p.name;
            const v = document.createElement('span');
            v.className = 'pkg-ver';
            v.textContent = p.version || '';
            row.append(n, v);
            listBox.appendChild(row);
        }
    };
    renderPkgRows();
    wrap.appendChild(listBox);
    return wrap;
}

async function scanLanguagePkgs(id, scope) {
    const scopeId = typeof scope === 'object' ? scope.id : scope;
    const st = pkgStateFor(id, scopeId);
    if (st.scanning) return;
    st.scanning = true;
    renderLangPane(id);
    const kind = id === 'python' ? 'pip' : (id === 'node' ? 'npm' : (id === 'go' ? 'go' : ''));
    // python：包列表跟随所选解释器；npm/project：用当前工作区目录
    let target = '';
    if (id === 'python') {
        const eff = effectiveToolEnv(id, 'python');
        target = (eff && eff.path) || '';
    } else if (scopeId === 'project') {
        target = deps.termCwd() || '';
    }
    let res = null;
    try {
        res = deps.backend.ListLangPackages ? await deps.backend.ListLangPackages(kind, scopeId, target) : null;
    } catch (e) {
        res = {packages: [], exists: true, error: String((e && e.message) || e)};
    }
    st.scanning = false;
    st.scannedAt = Date.now();
    st.list = res && Array.isArray(res.packages) ? res.packages : [];
    st.exists = !!(res && res.exists !== false);
    st.error = (res && res.error) || '';
    deps.applySettings();
    renderLangPane(id);
}

function renderFormatPane(id) {
    const f = deps.allFormatDefs().find((item) => item.id === id);
    const pane = document.querySelector(`.settings-pane[data-pane="fmt-${id}"]`);
    if (!f || !pane) return;
    const fs = deps.getFormatSettings(id);
    pane.textContent = '';
    const title = document.createElement('div');
    title.className = 'fmt-pane-title';
    title.textContent = f.name + ' 文件';
    // 扩展名列表太长很难看（纯文本有几十个），收进标题悬停提示
    const extensions = formats[id] && formats[id].extensions ? formats[id].extensions : [];
    if (extensions.length) title.title = '扩展名：' + extensions.join('、');
    pane.append(title);
    const update = (key) => (value) => {
        deps.settings.formatSettings[id][key] = value;
        deps.applySettings();
    };
    const addRow = (label, control) => {
        const row = document.createElement('div');
        row.className = 'popover-row';
        const text = document.createElement('span');
        text.className = 'popover-label';
        text.textContent = label;
        row.append(text, control);
        pane.appendChild(row);
    };
    addRow('编码', makeSelect(ENCODINGS, fs.encoding, update('encoding')));
    addRow('缩进', makeSelect(INDENTS, fs.indent, update('indent')));
    addRow('保存换行', makeSelect(EOLS, fs.eol, update('eol')));
    const viewSel = makeSelect(viewOptionsFor(f), fs.view, (value) => {
        deps.settings.formatSettings[id].view = value;
        deps.applySettings();
        if (deps.file && deps.file.format.id === id) deps.switchMode(value);
    });
    if (id === 'text') viewSel.disabled = true;
    addRow('默认视图', viewSel);
    const hint = document.createElement('div');
    hint.className = 'fmt-hint';
    hint.textContent = '编码 / 缩进 / 保存换行对之后打开或保存的文件生效；默认视图对当前同类文件立即生效。';
    if (id === 'text') hint.textContent += ' txt/log/conf 默认按所在扩展名打开；CMake / Dockerfile / Git 规则等特殊文件名按代码视图打开。';
    pane.appendChild(hint);
}

function renderFmtTable() {
    const table = document.getElementById('fmt-table');
    table.textContent = '';
    const head = document.createElement('div');
    head.className = 'fmt-row fmt-head';
    for (const label of ['格式', '编码', '缩进', '保存换行', '默认视图']) {
        const cell = document.createElement('span');
        cell.textContent = label;
        head.appendChild(cell);
    }
    table.appendChild(head);
    for (const f of deps.allFormatDefs()) {
        const fs = deps.getFormatSettings(f.id);
        const row = document.createElement('div');
        row.className = 'fmt-row';
        const name = document.createElement('span');
        name.textContent = f.name;
        row.appendChild(name);
        const update = (key) => (value) => {
            deps.settings.formatSettings[f.id][key] = value;
            deps.applySettings();
        };
        row.appendChild(makeSelect(ENCODINGS, fs.encoding, update('encoding')));
        row.appendChild(makeSelect(INDENTS, fs.indent, update('indent')));
        row.appendChild(makeSelect(EOLS, fs.eol, update('eol')));
        const viewSel = makeSelect(viewOptionsFor(f), fs.view, (value) => {
            deps.settings.formatSettings[f.id].view = value;
            deps.applySettings();
            if (deps.file && deps.file.format.id === f.id) deps.switchMode(value);
        });
        if (f.id === 'text') viewSel.disabled = true;
        row.appendChild(viewSel);
        table.appendChild(row);
    }
}

function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function flash(msg, isError) {
    deps.els.stMessage.textContent = msg;
    deps.els.stMessage.classList.toggle('error', !!isError);
    clearTimeout(deps.flashTimer);
    deps.flashTimer = setTimeout(() => { deps.els.stMessage.textContent = ''; }, 5000);
    deps.logFrontend(isError ? 'error' : 'info', msg);
}

function updateWindowTitle() {
    const title = window.__aiFloatWindow ? 'AI 助手 · CaDt-DataLens' : (deps.file ? deps.file.name + ' - CaDt-DataLens' : 'CaDt-DataLens');
    document.title = title;
    if (deps.rt && deps.rt.WindowSetTitle) {
        try {
            deps.rt.WindowSetTitle(title);
        } catch (e) {}
    }
}

function anyDirty() {
    return deps.docs.some((d) => d.dirty);
}

function updateBackendDirty() {
    deps.backend.SetDirty(anyDirty());
}

function setDirty(flag, opts = {}) {
    deps.dirty = flag;
    if (deps.file) deps.file.dirty = flag;
    updateBackendDirty();
    deps.els.stDirty.textContent = flag ? '未保存' : '';
    deps.els.filename.classList.toggle('dirty', flag);
    if (deps.file) updateTabDirty(deps.file);
    updateWindowTitle();
    if (flag && !opts.noAutoSave) scheduleAutoSave();
    else cancelAutoSave();
}

const autoSaveDelay = 1000;

function cancelAutoSave() {
    if (deps.autoSaveTimer) {
        clearTimeout(deps.autoSaveTimer);
        deps.autoSaveTimer = 0;
    }
}

function scheduleAutoSave() {
    cancelAutoSave();
    if (!deps.settings.autoSave || deps.settings.readOnlyMode || !deps.dirty || !deps.file || deps.file.large || deps.file.binary || !deps.file.path || !deps.editor) return;
    deps.autoSaveTimer = setTimeout(() => {
        deps.autoSaveTimer = 0;
        if (deps.dirty && deps.file && deps.settings.autoSave) deps.save({auto: true});
    }, autoSaveDelay);
}

function updateTabDirty(doc) {
    const el = document.querySelector('.etabs .tab[data-doc-id="' + doc.id + '"]');
    if (el) el.classList.toggle('dirty', !!doc.dirty);
}


    return {CSV_COL_MIN_WIDTH, CSV_ROW_NUM_WIDTH, INDENTS, LANG_DEFS, TREE_MAX_CHILDREN, applyWritingFormat, applyWritingMode, canSplitDoc, cancelAutoSave, closeFootPopover, editorLocale, effectiveToolEnv, flash, fmtSize, formatDisplayName, insertSceneSeparator, isSqlSupportedDoc, isSvgDoc, jumpToPosition, markdownRenderer, mdPreviewWidthLabel, normalizeLegacySqlMode, openCloseConfirm, openGotoDialog, openWritingNameDialog, renderEnvVarsPane, renderFmtTable, renderFormatPane, renderLangPane, renderMarkdownHtml, renderMermaidBlocks, renderPluginsPane, renderRunPane, resolveMarkdownImages, scheduleAutoSave, scheduleCursorPosition, scheduleWritingCaret, setDirty, splitKindFor, toggleWritingMode, toolEnvFor, updateAiWidthWidget, updateBackendDirty, updateCursorPosition, updateTabDirty, updateWindowTitle, updateWritingStats, viewDisabled, viewLabel, viewOptionsFor, writingFormatable};
}
