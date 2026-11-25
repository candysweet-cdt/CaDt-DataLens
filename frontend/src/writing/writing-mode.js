// 写作模式：生效判定、编辑器 chrome（typewriter/焦点段落/范围类）、字数统计与目标、
// 中文排版整理、起名器、场景分隔符、光标位置与 goto 对话框、关闭确认对话框。
// 从 writing-ui.js 拆出；四个模块级 let（基线/光标 rAF）随本域迁入，deps.flash 由宿主注入。
import {WRITING_FONTS, formatWritingText, genName, SCENE_SEPARATOR} from '../core/writing.js';
import {kvGetJson, kvSetJson} from '../core/kv-store.js';

export function createWritingMode(deps) {

let writingLastSig = '';
let writingPrevFamily = '';
let writingSwitchWasOn = !!deps.settings.writingMode; // 跟踪总开关本身；视图/文档临时切换不重置「本次」基线
let writingCaretRaf = 0;
let writingCaretTimer = 0;
// 通用确认框当前绑定的触发键（openConfirmDialog 的 options.keys）；框关闭后由可见性判定兜底失效
let confirmKeys = [];

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
    let store = kvGetJson(WRITING_DAILY_KEY, null);
    const today = writingTodayStr();
    if (!store || store.date !== today || typeof store.count !== 'number') {
        store = {date: today, count: 0, goalHit: false};
    }
    return store;
}

function saveWritingDaily(store) {
    kvSetJson(WRITING_DAILY_KEY, store); // 尽力而为：配额满只影响下次冷启动的计数
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
                deps.flash('今日目标达成 🎉');
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
    deps.flash(goal > 0 ? '每日目标已保存：' + goal + ' 字' : '每日目标已关闭');
    openWritingStatsDialog();
}

// ---- 动作：开关 / 一键排版 / 起名器 / 场景分隔符 ----

function toggleWritingMode() {
    deps.settings.writingMode = !deps.settings.writingMode;
    deps.applySettings();
    deps.flash(deps.settings.writingMode ? '写作模式已开启' : '写作模式已关闭');
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
        deps.flash('未发现需要整理的内容');
        return;
    }
    const loading = doc.loading;
    doc.loading = true;
    try {
        doc.editor.setText(res.text);
        doc.text = res.text;
    } catch (e) {
        deps.flash('排版失败：' + e.message, true);
        return;
    } finally {
        doc.loading = loading;
    }
    deps.markDocDirty(doc);
    // 整页预览模式下底层编辑器仍存活但预览不随 setText 自动刷新，手动重渲染
    if (deps.currentMode === 'preview' && doc.format && doc.format.preview) deps.renderMarkdownPreview(doc);
    // jsoneditor setText 会清空撤销历史（vendor 已确认 history.clear()）
    deps.flash('已整理：' + parts.join('、') + '（撤销历史已重置，可从 Git 历史找回）');
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
    if (!insertTextAtCursor(name)) deps.flash('当前视图不支持插入，请切换到源码或纯文本视图', true);
    else deps.closeTopDialog();
}

function insertSceneSeparator() {
    if (!insertTextAtCursor(SCENE_SEPARATOR)) deps.flash('当前视图不支持插入，请切换到源码或纯文本视图', true);
}

function updateCursorPosition() {
    if (!deps.els.stPos) return;
    const pos = deps.cursorPositionForDoc();
    const text = pos ? pos.line + ':' + pos.column : '';
    if (deps.els.stPos.textContent !== text) deps.els.stPos.textContent = text;
    deps.els.stPos.dataset.tip = text ? '当前光标位置（点击或 Ctrl+G 跳转）' : '';
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

function openConfirmDialog(message, action, okLabel, title, variant, options) {
    deps.elsDialogs.confirmText.textContent = message || '有未保存的修改，关闭后将丢弃。';
    deps.elsDialogs.confirmOk.textContent = okLabel || '丢弃并关闭';
    // variant：'danger' = 破坏性操作（删除/清空/回滚等），确认按钮标红；默认普通确认。
    // 语义化类型而非布尔，后续可扩展 'warning' / 'info' 等。
    const isDanger = variant === 'danger';
    deps.elsDialogs.confirmOk.classList.toggle('danger', isDanger);
    deps.elsDialogs.confirmOk.classList.toggle('primary', !isDanger);
    const titleEl = deps.elsDialogs.confirm.querySelector('.dialog-title');
    if (titleEl) titleEl.textContent = title || '关闭';
    deps.setConfirmAction(action || (() => {
        if (deps.backend.ForceClose) deps.backend.ForceClose();
    }));
    // 可选 options.keys：本次确认的触发键（KeyboardEvent.key，字符串或数组），
    // 按下任一即等同点确认按钮。退出键归弹层栈管，不在此列。框关闭后随可见性失效。
    const rawKeys = options && options.keys;
    confirmKeys = rawKeys ? (Array.isArray(rawKeys) ? rawKeys.slice() : [rawKeys]) : [];
    deps.openDialogEl(deps.elsDialogs.confirm, {keepSettings: true});
}

function submitConfirm() {
    const action = deps.getConfirmAction();
    deps.setConfirmAction(null);
    confirmKeys = [];
    deps.closeTopDialog();
    if (action) action();
}

document.getElementById('btn-discard').addEventListener('click', submitConfirm);

// 确认框触发键：window 捕获阶段——弹框时焦点可能仍落在触发它的输入框（如消息编辑区），
// 那里自己的 keydown 会 stopPropagation，冒泡监听收不到。只在框可见、按下本次绑定键且
// 无修饰键时消费；输入法组词态放行，避免抢走候选词确认。Esc 归弹层栈，不在此列。
window.addEventListener('keydown', (e) => {
    if (!confirmKeys.length || e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    if (deps.elsDialogs.confirm.classList.contains('hidden')) return;
    if (!confirmKeys.includes(e.key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    submitConfirm();
}, {capture: true});
document.getElementById('btn-cancel-close').addEventListener('click', deps.closeTopDialog);
document.getElementById('btn-props-ok').addEventListener('click', deps.closeDialogs);

// 对话框头部拖动已抽到 core/dialog-drag.js，在 main.js 统一安装（事件委托，动态弹窗也生效）。
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
    const pane = item.dataset.pane;
    deps.selectSettingsPane(pane);
    if (pane === 'integration') deps.syncIntegrationStatus();
    // 锚点入口：同一个 pane 内的不同分组各给一个侧栏入口（写作模式 / 代码截图 / 子代理 / 端侧分类器）。
    // selectSettingsPane 按 dataset.pane 高亮会让同 pane 的多个按钮一起亮，这里纠正为只亮被点的那个；
    // 再把目标分组滚到视口中央短暂高亮。不改 pane id，AI 工具的 open_settings pane 清单因此保持有效。
    const anchor = item.dataset.anchor;
    if (anchor) {
        document.querySelectorAll('.snav-item').forEach((b) => b.classList.toggle('active', b === item));
        requestAnimationFrame(() => {
            const group = document.getElementById(anchor);
            if (!group || !group.isConnected) return;
            group.scrollIntoView({block: 'center'});
            group.classList.add('settings-hit');
            setTimeout(() => group.classList.remove('settings-hit'), 1600);
        });
    }
});
// 常用编程语言：独立于数据格式，每个语言单独配置环境信息（为后续辅助运行代码预留）

return {applyWritingFormat, applyWritingMode, insertSceneSeparator, jumpToPosition, openConfirmDialog,
        openGotoDialog, openWritingNameDialog, scheduleCursorPosition, scheduleWritingCaret, toggleWritingMode,
        updateCursorPosition, updateWritingStats, writingFormatable};
}
