// settings-ui.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// 操作留痕（docs/unfinished-plans/operation-audit-log.md）
// 只记状态改变类操作摘要；文件正文/剪贴板/密钥永不落盘，开关在设置 → 操作记录。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {createActivityLog} from './activity-log.js';
import {iconSvg} from './icons.js';

export function createSettingsUI(deps) {

const activityLog = createActivityLog({
    backend: deps.backend,
    settings: () => deps.settings,
    relativize: (p) => actRel(p),
});

// actRel 工作区内转相对路径（正斜杠）；工作区外保留用户主动打开的绝对路径。
function actRel(path) {
    const raw = String(path || '');
    if (!raw) return '';
    try {
        const root = deps.workspaceFolder || (deps.explorer && deps.explorer.getRoot ? deps.explorer.getRoot() : '');
        if (root) {
            const rel = deps.relativePathFrom(raw, root);
            if (rel) return rel;
        }
    } catch (e) {}
    return raw;
}

// 设置变更留痕：与上次 applySettings 的快照对比；逐键记 ≤8 条，超出合并为一条汇总。
let lastSettingsSnapshot = null;

function diffSettingsForLog(prev, next) {
    const keys = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})]);
    const changed = [];
    for (const key of keys) {
        const before = prev ? prev[key] : undefined;
        if (Object.is(before, next[key]) && typeof before === typeof next[key]) continue;
        if (JSON.stringify(before) === JSON.stringify(next[key])) continue;
        changed.push({key, from: before, to: next[key]});
    }
    return changed;
}

function logSettingsChange(snapshot) {
    if (lastSettingsSnapshot === null) return;
    const changed = diffSettingsForLog(lastSettingsSnapshot, snapshot);
    if (changed.length === 1) {
        activityLog.log('settings.change', changed[0].key, {from: changed[0].from, to: changed[0].to});
    } else if (changed.length > 1 && changed.length <= 8) {
        for (const item of changed) {
            activityLog.log('settings.change', item.key, {from: item.from, to: item.to});
        }
    } else if (changed.length > 8) {
        activityLog.log('settings.change', '', {count: changed.length, keys: changed.map((c) => c.key).join(',')});
    }
}

function getFormatSettings(id) {
    return deps.settings.formatSettings[id] || deps.defaultFormatSettings()[id] || {encoding: 'auto', indent: '2', eol: 'follow', view: 'tree'};
}

const elsSettings = {
    fixed: document.getElementById('opt-fixed-keys'),
    width: document.getElementById('opt-key-width'),
    widthVal: document.getElementById('opt-key-width-val'),
    font: document.getElementById('opt-font-size'),
    fontVal: document.getElementById('opt-font-size-val'),
    sidebarFont: document.getElementById('opt-sidebar-font'),
    sidebarFontVal: document.getElementById('opt-sidebar-font-val'),
    treeGuides: document.getElementById('opt-tree-guides'),
    treeCounts: document.getElementById('opt-tree-counts'),
    treeRefresh: document.getElementById('opt-tree-refresh'),
    codeGuides: document.getElementById('opt-code-guides'),
    alwaysOnTop: document.getElementById('opt-always-on-top'),
    codeWrap: document.getElementById('opt-code-wrap'),
    mdLineNumbers: document.getElementById('opt-md-line-numbers'),
    mdScrollSync: document.getElementById('opt-md-scroll-sync'),
    settingsSearch: document.getElementById('settings-search'),
    settingsSearchResults: document.getElementById('settings-search-results'),
    mdPreviewWidth: document.getElementById('opt-md-preview-width'),
    autoCheckUpdate: document.getElementById('opt-auto-update'),
    treeExpand: document.getElementById('opt-tree-expand'),
    showBanners: document.getElementById('opt-show-banners'),
    autoSave: document.getElementById('opt-auto-save'),
    openMode: document.getElementById('opt-open-mode'),
    tabClose: document.getElementById('opt-tab-close'),
    dblClickClose: document.getElementById('opt-dblclick-close'),
    shiftClickClose: document.getElementById('opt-shiftclick-close'),
    uiFont: document.getElementById('opt-ui-font'),
    uiCjkFont: document.getElementById('opt-ui-cjk-font'),
    editorFontFamily: document.getElementById('opt-editor-font'),
    editorCjkFont: document.getElementById('opt-editor-cjk-font'),
    writingMode: document.getElementById('opt-writing-mode'),
    writingFont: document.getElementById('opt-writing-font'),
    writingFontSize: document.getElementById('opt-writing-size'),
    writingFontSizeVal: document.getElementById('opt-writing-size-val'),
    writingPaper: document.getElementById('opt-writing-paper'),
    writingLineNumbers: document.getElementById('opt-writing-line-numbers'),
    writingTypewriter: document.getElementById('opt-writing-typewriter'),
    writingFocus: document.getElementById('opt-writing-focus'),
    writingDailyGoal: document.getElementById('opt-writing-goal'),
    aiChatFontEn: document.getElementById('ai-opt-chatfont-en'),
    aiChatFontCjk: document.getElementById('ai-opt-chatfont-cjk'),
    aiChatCodeFont: document.getElementById('ai-opt-chatfont-code'),
    fileAssoc: document.getElementById('opt-file-assoc'),
    contextMenu: document.getElementById('opt-context-menu'),
    agentSkill: document.getElementById('opt-agent-skill'),
    skillDirs: document.getElementById('opt-skill-dirs'),
    exePath: document.getElementById('opt-exe-path'),
    refreshIntegration: document.getElementById('opt-refresh-integration'),
    developerMode: document.getElementById('opt-developer-mode'),
    openLogs: document.getElementById('opt-open-logs'),
    logPath: document.getElementById('opt-log-path'),
    activityLog: document.getElementById('opt-activity-log'),
    activityRetention: document.getElementById('opt-activity-retention'),
    openActivity: document.getElementById('opt-open-activity'),
    exportActivityJson: document.getElementById('opt-export-activity-json'),
    exportActivityCsv: document.getElementById('opt-export-activity-csv'),
    clearActivity: document.getElementById('opt-clear-activity'),
};

function fillFontSelect(select, list) {
    select.textContent = '';
    for (const face of list) {
        const opt = document.createElement('option');
        opt.value = face.id;
        opt.textContent = face.name;
        select.appendChild(opt);
    }
}
fillFontSelect(elsSettings.uiFont, deps.uiFonts);
fillFontSelect(elsSettings.uiCjkFont, deps.cjkFonts);
fillFontSelect(elsSettings.editorFontFamily, deps.editorFonts);
fillFontSelect(elsSettings.editorCjkFont, deps.cjkFonts);
fillFontSelect(elsSettings.aiChatFontEn, [
    {id: 'follow', name: '跟随界面英文字体'},
    ...uiFonts.map((f) => ({id: 'ui:' + f.id, name: f.name})),
    ...editorFonts.map((f) => ({id: 'mono:' + f.id, name: f.name + '（等宽）'})),
]);
fillFontSelect(elsSettings.aiChatFontCjk, [
    {id: 'follow', name: '跟随界面中文字体'},
    ...cjkFonts.map((f) => ({id: 'cjk:' + f.id, name: f.name})),
]);
fillFontSelect(elsSettings.aiChatCodeFont, [
    {id: 'follow', name: '跟随编辑器字体'},
    ...editorFonts.map((f) => ({id: 'mono:' + f.id, name: f.name})),
]);

const elsDialogs = {
    mask: document.getElementById('dialog-mask'),
    settings: document.getElementById('dlg-settings'),
    confirm: document.getElementById('dlg-confirm'),
    confirmText: document.getElementById('dlg-confirm-text'),
    confirmOk: document.getElementById('btn-discard'),
    conflict: document.getElementById('dlg-save-conflict'),
    runDirty: document.getElementById('dlg-run-dirty'),
    runDirtyText: document.getElementById('dlg-run-dirty-text'),
    runDirtySave: document.getElementById('btn-run-dirty-save'),
    runDirtyTemp: document.getElementById('btn-run-dirty-temp'),
    runDirtyCancel: document.getElementById('btn-run-dirty-cancel'),
    runDirtyRemember: document.getElementById('run-dirty-remember'),
    runConfirm: document.getElementById('dlg-run-confirm'),
    runConfirmText: document.getElementById('dlg-run-confirm-text'),
    runConfirmOk: document.getElementById('btn-run-confirm-ok'),
    runConfirmCancel: document.getElementById('btn-run-confirm-cancel'),
    conflictText: document.getElementById('dlg-save-conflict-text'),
    conflictReload: document.getElementById('btn-conflict-reload'),
    conflictOverwrite: document.getElementById('btn-conflict-overwrite'),
    conflictCancel: document.getElementById('btn-conflict-cancel'),
    name: document.getElementById('dlg-name'),
    nameTitle: document.getElementById('dlg-name-title'),
    nameLabel: document.getElementById('dlg-name-label'),
    nameInput: document.getElementById('dlg-name-input'),
    nameError: document.getElementById('dlg-name-error'),
    nameOk: document.getElementById('btn-name-ok'),
    goto: document.getElementById('dlg-goto'),
    gotoInput: document.getElementById('dlg-goto-input'),
    gotoError: document.getElementById('dlg-goto-error'),
    props: document.getElementById('dlg-props'),
    propsGrid: document.getElementById('dlg-props-grid'),
    update: document.getElementById('dlg-update'),
    updateStatus: document.getElementById('dlg-update-status'),
    updateNotes: document.getElementById('dlg-update-notes'),
    updateDownload: document.getElementById('btn-update-download'),
    updatePage: document.getElementById('btn-update-page'),
    writing: document.getElementById('dlg-writing'),
    writingToday: document.getElementById('dlg-writing-today'),
    writingSession: document.getElementById('dlg-writing-session'),
    writingSpeed: document.getElementById('dlg-writing-speed'),
    writingTotal: document.getElementById('dlg-writing-total'),
    writingGoalBar: document.getElementById('dlg-writing-goalbar'),
    writingGoalFill: document.getElementById('dlg-writing-goalfill'),
    writingGoalInput: document.getElementById('dlg-writing-goal-input'),
    writingName: document.getElementById('dlg-writing-name'),
    writingNameText: document.getElementById('dlg-writing-name-text'),
    writingNameGender: document.getElementById('opt-writing-name-gender'),
};

let syncedOpenMode = null;
function syncOpenMode() {
    if (syncedOpenMode === null) {
        syncedOpenMode = deps.settings.openMode;
        return;
    }
    if (syncedOpenMode === deps.settings.openMode) return;
    syncedOpenMode = deps.settings.openMode;
    if (deps.backend && deps.backend.SetOpenMode) {
        try {
            deps.backend.SetOpenMode(deps.settings.openMode);
        } catch (e) {}
    }
}

let appliedTheme = '';
function currentTheme() {
    return deps.themes.find((t) => t.id === deps.settings.theme) || deps.themes[0];
}

function applyTheme() {
    if (appliedTheme === deps.settings.theme) return;
    const theme = currentTheme();
    document.documentElement.dataset.theme = theme.id;
    appliedTheme = theme.id;
    if (deps.backend && deps.backend.SetWindowBg) {
        const n = parseInt(theme.bg.slice(1), 16);
        try {
            deps.backend.SetWindowBg((n >> 16) & 255, (n >> 8) & 255, n & 255);
        } catch (e) {}
    }
}

function setTheme(id) {
    if (!deps.themes.some((t) => t.id === id)) return;
    deps.settings.theme = id;
    applySettings();
    if (deps.file && deps.currentMode === 'preview' && doc && false) {}
    if (deps.file && deps.currentMode === 'preview') deps.renderMarkdownPreview(deps.file);
    deps.flash('主题：' + currentTheme().name);
}

function applyCodeWrap() {
    for (const doc of deps.docs) {
        const ace = doc && doc.editor && doc.editor.aceEditor;
        if (!ace) continue;
        try {
            ace.getSession().setUseWrapMode(!!deps.settings.codeWrap);
        } catch (e) {}
    }
    if (deps.editor && deps.editor.aceEditor) {
        try {
            deps.editor.aceEditor.resize();
        } catch (e) {}
    }
}

function applyCodeGuides() {
    for (const doc of deps.docs) {
        const ace = doc && doc.editor && doc.editor.aceEditor;
        if (!ace) continue;
        try {
            ace.setDisplayIndentGuides(!!deps.settings.codeGuides);
            ace.setHighlightIndentGuides(!!deps.settings.codeGuides);
            ace.renderer.updateFull(true);
        } catch (e) {}
    }
}

function applyAlwaysOnTop() {
    if (!deps.rt || !deps.rt.WindowSetAlwaysOnTop) return;
    try {
        deps.rt.WindowSetAlwaysOnTop(!!deps.settings.alwaysOnTop);
    } catch (e) {}
}

let rtFullscreen = false;

async function syncFullscreenState() {
    if (!deps.rt || !deps.rt.WindowIsFullscreen) return;
    try {
        rtFullscreen = !!(await deps.rt.WindowIsFullscreen());
    } catch (e) {}
}

async function toggleFullscreen() {
    if (!deps.rt || !deps.rt.WindowFullscreen) return;
    await syncFullscreenState();
    try {
        if (rtFullscreen) {
            deps.rt.WindowUnfullscreen();
            rtFullscreen = false;
        } else {
            deps.rt.WindowFullscreen();
            rtFullscreen = true;
        }
        deps.flash('全屏：' + (rtFullscreen ? '开' : '关'));
    } catch (e) {
        deps.flash('全屏切换失败：' + e, true);
    }
}

function toggleAlwaysOnTop() {
    deps.settings.alwaysOnTop = !deps.settings.alwaysOnTop;
    applySettings();
    deps.flash('窗口置顶：' + (deps.settings.alwaysOnTop ? '开' : '关'));
}

function toggleCodeWrap() {
    deps.settings.codeWrap = !deps.settings.codeWrap;
    applySettings();
    deps.flash('代码视图自动换行：' + (deps.settings.codeWrap ? '开' : '关'));
}

let appliedReadOnly = null;

function updateLockButton() {
    const locked = !!deps.settings.readOnlyMode;
    if (deps.els.lock) {
        deps.els.lock.classList.toggle('locked', locked);
        deps.els.lock.setAttribute('aria-pressed', String(locked));
        deps.els.lock.title = locked ? '解除只读锁定' : '只读锁定';
        deps.els.lock.innerHTML = locked ? LOCK_ICON : deps.UNLOCK_ICON;
    }
}

function installReadOnlyGuards(pane) {
    if (!pane) return;
    const inTreeField = (target) => target && target.closest && target.closest('.jsoneditor-field, .jsoneditor-value');
    pane.addEventListener('beforeinput', (e) => {
        if (!deps.settings.readOnlyMode || !inTreeField(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
    }, true);
    pane.addEventListener('keydown', (e) => {
        if (!deps.settings.readOnlyMode || !inTreeField(e.target)) return;
        const key = e.key;
        if ((e.ctrlKey || e.metaKey) && ['c', 'C', 'a', 'A'].includes(key)) return;
        if (['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(key)) return;
        e.preventDefault();
        e.stopPropagation();
    }, true);
    for (const type of ['paste', 'cut', 'drop']) {
        pane.addEventListener(type, (e) => {
            if (!deps.settings.readOnlyMode || !inTreeField(e.target)) return;
            e.preventDefault();
            e.stopPropagation();
        }, true);
    }
    pane.addEventListener('contextmenu', (e) => {
        if (!deps.settings.readOnlyMode) return;
        if (e.target.closest && e.target.closest('.jsoneditor-tree')) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);
}

function applyReadOnlyToDoc(doc) {
    if (!doc || !doc.editor) return;
    const locked = !!deps.settings.readOnlyMode;
    if (doc.editor.aceEditor) {
        try {
            doc.editor.aceEditor.setReadOnly(!!(doc.large || doc.binary || locked));
        } catch (e) {}
    }
    if (doc.pane) {
        doc.pane.classList.toggle('app-readonly', locked);
        const textarea = doc.pane.querySelector('textarea.jsoneditor-text');
        if (textarea) textarea.readOnly = locked || !!doc.binary;
        doc.pane.querySelectorAll('.jsoneditor-tree input, .jsoneditor-tree select').forEach((control) => {
            control.disabled = locked;
        });
        if (doc.format && doc.format.table && doc.tableEl && doc.pane.classList.contains('table-active')) {
            deps.renderCsvTableView(doc);
        }
    }
}

function applyReadOnlyMode() {
    deps.syncRunButtonState();
    updateLockButton();
    const locked = !!deps.settings.readOnlyMode;
    if (appliedReadOnly === locked) return;
    appliedReadOnly = locked;
    document.documentElement.classList.toggle('app-locked', locked);
    for (const doc of deps.docs) applyReadOnlyToDoc(doc);
    if (deps.file) deps.updateStatus();
    if (locked) deps.cancelAutoSave();
    else if (deps.settings.autoSave && deps.dirty) deps.scheduleAutoSave();
}

function applySettings() {
    const mdWidth = String(deps.settings.mdPreviewWidth || '0');
    document.documentElement.style.setProperty('--md-preview-max', mdWidth === '0' ? 'none' : mdWidth + 'px');
    const aiWidth = String(deps.settings.aiFullscreenWidth || 'auto');
    document.documentElement.style.setProperty('--ai-fullscreen-width',
        aiWidth === 'auto' ? 'min(100%, 920px)' : (aiWidth === '0' ? '100%' : aiWidth + 'px'));
    deps.updateAiWidthWidget();
    document.documentElement.classList.toggle('keycol-natural', !deps.settings.fixedKeys);
    document.documentElement.classList.toggle('tree-guides', !!deps.settings.treeGuides);
    applyTheme();
    if (typeof deps.syncTerminalTheme === 'function') {
        try {
            deps.syncTerminalTheme();
        } catch (e) {}
    }
    if (deps.els.sidebar && deps.settings.sidebarWidth) {
        deps.els.sidebar.style.width = deps.settings.sidebarWidth + 'px';
    }
    // AI 面板停靠侧（dock 分屏与内容区互换；ai-panel.js 的 applyPanelSide 同步按钮态）
    const topRowEl = document.getElementById('top-row');
    if (topRowEl) topRowEl.classList.toggle('ai-left', deps.settings.aiPanelSide === 'left');
    if (deps.els.gitCommitArea) {
        if (deps.settings.gitCommitAreaHeight) {
            deps.els.gitCommitArea.style.height = deps.settings.gitCommitAreaHeight + 'px';
            deps.els.gitCommitArea.style.flex = 'none';
        } else {
            deps.els.gitCommitArea.style.height = '';
            deps.els.gitCommitArea.style.flex = '';
        }
    }
    if (typeof deps.applySidebarUI === 'function') {
        try {
            deps.applySidebarUI();
        } catch (e) {}
    }
    document.documentElement.style.setProperty('--key-col-w', deps.settings.keyWidth + 'px');
    elsSettings.fixed.checked = deps.settings.fixedKeys;
    elsSettings.width.value = String(deps.settings.keyWidth);
    elsSettings.width.disabled = !deps.settings.fixedKeys;
    elsSettings.widthVal.textContent = String(deps.settings.keyWidth);
    elsSettings.font.value = String(deps.settings.editorFont);
    elsSettings.fontVal.textContent = String(deps.settings.editorFont);
    elsSettings.sidebarFont.value = String(deps.settings.sidebarFont);
    elsSettings.sidebarFontVal.textContent = String(deps.settings.sidebarFont);
    elsSettings.treeGuides.checked = !!deps.settings.treeGuides;
    elsSettings.treeCounts.checked = !!deps.settings.treeCounts;
    elsSettings.treeRefresh.value = String(deps.settings.treeRefreshInterval);
    if (deps.explorer && deps.explorer.setAutoRefresh) deps.explorer.setAutoRefresh(deps.settings.treeRefreshInterval);
    elsSettings.autoSave.checked = !!deps.settings.autoSave;
    elsSettings.codeGuides.checked = !!deps.settings.codeGuides;
    elsSettings.alwaysOnTop.checked = !!deps.settings.alwaysOnTop;
    elsSettings.codeWrap.checked = !!deps.settings.codeWrap;
    elsSettings.mdLineNumbers.checked = !!deps.settings.mdLineNumbers;
    elsSettings.mdScrollSync.checked = deps.settings.mdScrollSync !== false;
    elsSettings.mdPreviewWidth.value = String(deps.settings.mdPreviewWidth);
    elsSettings.autoCheckUpdate.checked = deps.settings.autoCheckUpdate !== false;
    if (elsSettings.treeExpand) elsSettings.treeExpand.value = deps.settings.treeExpandDefault;
    elsSettings.showBanners.checked = !!deps.settings.showBanners;
    elsSettings.openMode.value = deps.settings.openMode;
    if (elsSettings.activityLog) elsSettings.activityLog.checked = deps.settings.activityLog !== false;
    if (elsSettings.activityRetention) elsSettings.activityRetention.value = String(deps.settings.activityRetentionMonths || 12);
    document.documentElement.dataset.tabClose = deps.settings.tabCloseMode;
    if (elsSettings.tabClose) elsSettings.tabClose.value = deps.settings.tabCloseMode;
    if (elsSettings.dblClickClose) elsSettings.dblClickClose.checked = !!deps.settings.dblClickClose;
    if (elsSettings.shiftClickClose) elsSettings.shiftClickClose.checked = deps.settings.shiftClickClose !== false;
    syncOpenMode();
    document.documentElement.style.setProperty('--editor-font', deps.settings.editorFont + 'px');
    document.documentElement.style.setProperty('--sidebar-font', deps.settings.sidebarFont + 'px');
    const uiFace = deps.uiFonts.find((f) => f.id === deps.settings.uiFont) || deps.uiFonts[0];
    const editorFace = deps.editorFonts.find((f) => f.id === deps.settings.editorFontFamily) || deps.editorFonts[0];
    const uiCjk = deps.cjkFonts.find((f) => f.id === deps.settings.uiCjkFont) || deps.cjkFonts[0];
    const editorCjk = deps.cjkFonts.find((f) => f.id === deps.settings.editorCjkFont) || deps.cjkFonts[0];
    document.documentElement.style.setProperty('--ui-font', uiFace.family + ', ' + uiCjk.family + ', sans-serif');
    document.documentElement.style.setProperty('--editor-font-family', editorFace.family + ', ' + editorCjk.family + ', monospace');
    if (deps.aiPanel && typeof deps.aiPanel.applySettings === 'function') {
        try { deps.aiPanel.applySettings(); } catch (e) {}
    }
    elsSettings.uiFont.value = uiFace.id;
    elsSettings.uiCjkFont.value = uiCjk.id;
    elsSettings.editorFontFamily.value = editorFace.id;
    elsSettings.editorCjkFont.value = editorCjk.id;
    elsSettings.writingMode.checked = !!deps.settings.writingMode;
    elsSettings.writingFont.value = deps.settings.writingFont;
    elsSettings.writingFontSize.value = String(deps.settings.writingFontSize);
    elsSettings.writingFontSizeVal.textContent = String(deps.settings.writingFontSize);
    elsSettings.writingPaper.value = deps.settings.writingPaper;
    elsSettings.writingLineNumbers.checked = !!deps.settings.writingLineNumbers;
    elsSettings.writingTypewriter.checked = deps.settings.writingTypewriter !== false;
    elsSettings.writingFocus.checked = deps.settings.writingFocus !== false;
    elsSettings.writingDailyGoal.value = String(deps.settings.writingDailyGoal || 0);
    if (deps.editor && deps.editor.aceEditor) {
        try {
            deps.editor.aceEditor.setFontSize(deps.settings.editorFont);
        } catch (e) {}
    }
    applyCodeWrap();
    applyCodeGuides();
    applyAlwaysOnTop();
    applyReadOnlyMode();
    deps.applyWritingMode();
    if (deps.aiPanel && deps.aiPanel.applySettings) {
        try { deps.aiPanel.applySettings(); } catch (e) {}
    }
    if (deps.readingMode) {
        try { deps.readingMode.applyReadingSettings(); } catch (e) {}
    }
    try {
        localStorage.setItem(deps.settingsKey, JSON.stringify(deps.settings));
    } catch (e) {}
    // 设置变更留痕：首次调用（启动恢复）只建快照，不记变更。
    try {
        logSettingsChange(JSON.parse(JSON.stringify(deps.settings)));
        lastSettingsSnapshot = JSON.parse(JSON.stringify(deps.settings));
    } catch (e) {}
    if (deps.settings.autoSave && deps.dirty && !deps.settings.readOnlyMode) deps.scheduleAutoSave();
    else deps.cancelAutoSave();
}

function openDialogEl(dlg, options) {
    const keepSettings = !!(options && options.keepSettings) &&
        dlg !== elsDialogs.settings &&
        !elsDialogs.settings.classList.contains('hidden');
    elsDialogs.mask.classList.remove('hidden');
    if (!keepSettings) elsDialogs.settings.classList.add('hidden');
    for (const other of [elsDialogs.confirm, elsDialogs.conflict, elsDialogs.runDirty, elsDialogs.runConfirm, elsDialogs.name, elsDialogs.goto, elsDialogs.props, elsDialogs.update, elsDialogs.writing, elsDialogs.writingName]) {
        if (other !== dlg) other.classList.add('hidden');
    }
    dlg.dataset.parentSettings = keepSettings ? '1' : '';
    dlg.style.left = '';
    dlg.style.top = '';
    dlg.style.transform = '';
    dlg.classList.remove('hidden');
    deps.syncAllBrowserTabs();
}

function closeTopDialog() {
    if (!elsDialogs.settings.classList.contains('hidden')) {
            for (const dlg of [elsDialogs.confirm, elsDialogs.conflict, elsDialogs.runDirty, elsDialogs.runConfirm, elsDialogs.name, elsDialogs.goto, elsDialogs.props, elsDialogs.update, elsDialogs.writing, elsDialogs.writingName]) {
            if (dlg.classList.contains('hidden') || dlg.dataset.parentSettings !== '1') continue;
            dlg.classList.add('hidden');
            if (dlg === elsDialogs.confirm) confirmAction = null;
            if (dlg === elsDialogs.conflict) finishSaveConflict('cancel');
            if (dlg === elsDialogs.name) {
                nameSubmit = null;
                nameBusy = false;
            }
            deps.syncAllBrowserTabs();
            return;
        }
    }
    closeDialogs();
}

function closeDialogs() {
    if (deps.aiPanel && typeof deps.aiPanel.closeModelEditor === 'function') {
        try { deps.aiPanel.closeModelEditor(false); } catch (e) {}
    }
    elsDialogs.mask.classList.add('hidden');
    elsDialogs.settings.classList.add('hidden');
    elsDialogs.confirm.classList.add('hidden');
    if (saveConflictResolve) finishSaveConflict('cancel');
    elsDialogs.conflict.classList.add('hidden');
    elsDialogs.name.classList.add('hidden');
    elsDialogs.goto.classList.add('hidden');
    elsDialogs.props.classList.add('hidden');
    elsDialogs.update.classList.add('hidden');
    elsDialogs.writing.classList.add('hidden');
    elsDialogs.writingName.classList.add('hidden');
    confirmAction = null;
    deps.syncAllBrowserTabs();
    nameSubmit = null;
    nameBusy = false;
}

function selectSettingsPane(pane) {
    resetSettingsSearch();
    document.querySelectorAll('.snav-item').forEach((b) => b.classList.toggle('active', b.dataset.pane === pane));
    document.querySelectorAll('.settings-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== pane));
    const group = document.getElementById('snav-formats');
    if (group) {
        const inFormats = pane === 'formats' || String(pane).startsWith('fmt-');
        if (inFormats && !group.classList.contains('expanded')) {
            group.classList.add('expanded');
            const parent = group.querySelector('.snav-parent');
            if (parent) parent.setAttribute('aria-expanded', 'true');
        }
    }
    const langGroup = document.getElementById('snav-langs');
    if (langGroup) {
        const inLangs = String(pane).startsWith('lang-');
        if (inLangs && !langGroup.classList.contains('expanded')) {
            langGroup.classList.add('expanded');
            const parent = langGroup.querySelector('.snav-parent');
            if (parent) parent.setAttribute('aria-expanded', 'true');
        }
    }
    const aiGroup = document.getElementById('snav-ai');
    if (aiGroup) {
        const inAI = pane === 'models' || pane === 'ai' || pane === 'context' || pane === 'preferences' || pane === 'schedules';
        if (inAI && !aiGroup.classList.contains('expanded')) {
            aiGroup.classList.add('expanded');
            const parent = aiGroup.querySelector('.snav-parent');
            if (parent) parent.setAttribute('aria-expanded', 'true');
        }
    }
    if (pane === 'formats') deps.renderFmtTable();
    else if (String(pane).startsWith('fmt-')) deps.renderFormatPane(pane.slice(4));
    else if (String(pane).startsWith('lang-')) deps.renderLangPane(pane.slice(5));
    else if (pane === 'plugins') deps.renderPluginsPane();
    else if (pane === 'run') deps.renderRunPane();
    else if (pane === 'envvars') deps.renderEnvVarsPane();
    else if (pane === 'activity') deps.renderActivityPane();
    if (pane === 'ai' || pane === 'models' || pane === 'context' || pane === 'preferences') {
        if (!deps.aiPanel) deps.initAIPanel();
        if (deps.aiPanel && typeof deps.aiPanel.refreshSettings === 'function') {
            try { deps.aiPanel.refreshSettings(); } catch (e) {}
        }
    }
    if (pane === 'schedules') {
        if (!deps.aiPanel) deps.initAIPanel();
        if (deps.aiPanel && typeof deps.aiPanel.refreshScheduleSettings === 'function') {
            try { deps.aiPanel.refreshScheduleSettings(); } catch (e) {}
        }
    }
}

function openSettings(pane = 'general') {
    openDialogEl(elsDialogs.settings);
    resetSettingsSearch();
    selectSettingsPane(pane);
    deps.refreshDeveloperMode();
    deps.refreshLogPath();
    if (pane === 'about') {
        const status = document.getElementById('about-update-status');
        if (status) {
            status.textContent = '';
            status.className = 'about-update-status';
        }
    }
    if (pane === 'integration') syncIntegrationStatus();
}

// ---- 设置搜索：左栏顶部搜索框，跨面板检索设置项并跳转 ----

function buildSettingsSearchIndex() {
    const entries = [];
    const navLabels = {};
    document.querySelectorAll('.snav-item[data-pane]').forEach((b) => {
        navLabels[b.dataset.pane] = (b.textContent || '').trim();
    });
    for (const paneEl of document.querySelectorAll('.settings-pane')) {
        const pane = paneEl.dataset.pane;
        // 动态面板（数据格式 / 编程语言子页）打开前没有内容，跳过，用下面的静态条目兜底
        if (paneEl.classList.contains('hidden') && (pane.startsWith('fmt-') || pane.startsWith('lang-'))) continue;
        for (const row of paneEl.querySelectorAll('.popover-row, .fmt-pane-title, .fmt-pane-sub, .settings-section-title')) {
            const text = (row.textContent || '').replace(/\s+/g, ' ').trim();
            if (text) entries.push({pane, text, el: row});
        }
    }
    for (const f of deps.allFormatDefs()) {
        entries.push({pane: 'fmt-' + f.id, text: f.name + '：编码 / 缩进 / 保存换行 / 默认视图', el: null});
    }
    for (const l of deps.LANG_DEFS) {
        entries.push({pane: 'lang-' + l.id, text: l.name + '：环境检测（路径 / 版本）', el: null});
        for (const t of l.tools || []) {
            entries.push({pane: 'lang-' + l.id, text: l.name + ' · ' + t.name, el: null});
        }
    }
    return {entries, navLabels};
}

function renderSettingsSearch(query) {
    const box = elsSettings.settingsSearchResults;
    if (!box) return;
    const q = String(query || '').trim().toLowerCase();
    if (!q) {
        box.classList.add('hidden');
        box.textContent = '';
        return;
    }
    const {entries, navLabels} = buildSettingsSearchIndex();
    const hits = [];
    for (const e of entries) {
        const hay = (navLabels[e.pane] || '') + ' ' + e.text;
        if (hay.toLowerCase().includes(q)) hits.push(e);
        if (hits.length >= 12) break;
    }
    box.textContent = '';
    if (!hits.length) {
        const empty = document.createElement('div');
        empty.className = 'settings-search-empty';
        empty.textContent = '没有匹配的设置';
        box.appendChild(empty);
    } else {
        for (const hit of hits) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'settings-search-item';
            const nav = document.createElement('span');
            nav.className = 'settings-search-nav';
            nav.textContent = navLabels[hit.pane] || hit.pane;
            const text = document.createElement('span');
            text.className = 'settings-search-text';
            text.textContent = hit.text.length > 64 ? hit.text.slice(0, 64) + '…' : hit.text;
            row.append(nav, text);
            row.addEventListener('click', () => {
                box.classList.add('hidden');
                selectSettingsPane(hit.pane);
                if (hit.el && hit.el.isConnected) {
                    hit.el.scrollIntoView({block: 'center'});
                    hit.el.classList.add('settings-hit');
                    setTimeout(() => hit.el.classList.remove('settings-hit'), 1600);
                }
            });
            box.appendChild(row);
        }
    }
    box.classList.remove('hidden');
}

function resetSettingsSearch() {
    if (elsSettings.settingsSearch) elsSettings.settingsSearch.value = '';
    if (elsSettings.settingsSearchResults) {
        elsSettings.settingsSearchResults.classList.add('hidden');
        elsSettings.settingsSearchResults.textContent = '';
    }
}

if (elsSettings.settingsSearch) {
    elsSettings.settingsSearch.addEventListener('input', () => renderSettingsSearch(elsSettings.settingsSearch.value));
    elsSettings.settingsSearch.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            e.preventDefault();
            resetSettingsSearch();
            elsSettings.settingsSearch.blur();
        } else if (e.key === 'Enter') {
            const first = elsSettings.settingsSearchResults.querySelector('.settings-search-item');
            if (first) first.click();
        }
    });
}


async function syncIntegrationStatus() {
    if (!elsSettings.fileAssoc) return;
    if (!deps.backend.GetIntegrationStatus) {
        elsSettings.exePath.textContent = '当前版本不支持系统集成';
        return;
    }
    try {
        const status = await deps.backend.GetIntegrationStatus();
        elsSettings.fileAssoc.checked = !!status.fileAssoc;
        elsSettings.contextMenu.checked = !!status.contextMenu;
        elsSettings.exePath.textContent = status.executable || '—';
        elsSettings.exePath.title = status.executable || '';
    } catch (e) {
        deps.flash('读取系统集成状态失败：' + e, true);
    }
    if (deps.backend.GetAgentSkillStatus && elsSettings.agentSkill) {
        try {
            const skill = await deps.backend.GetAgentSkillStatus();
            elsSettings.agentSkill.checked = skill.targets.some((t) => t.registered);
            if (elsSettings.skillDirs) {
                const home = skill.home || '';
                elsSettings.skillDirs.innerHTML = skill.targets.map((t) => {
                    const raw = home && t.dir.startsWith(home) ? '~' + t.dir.slice(home.length) : t.dir;
                    const dir = raw.replace(/\\/g, '/');
                    const mark = iconSvg(t.registered ? 'check' : 'circle', 11);
                    return '<span class="skill-dir-state">' + mark + dir + '</span>';
                }).join('');
            }
        } catch (e) {
            if (elsSettings.skillDirs) elsSettings.skillDirs.textContent = '读取技能状态失败';
        }
    }
}

async function applyIntegration(kind, checkbox, label) {
    const enabled = checkbox.checked;
    if (!deps.backend[kind]) {
        checkbox.checked = !enabled;
        deps.flash('当前版本不支持系统集成', true);
        return;
    }
    for (const el of [elsSettings.fileAssoc, elsSettings.contextMenu, elsSettings.agentSkill]) {
        if (el) el.disabled = true;
    }
    try {
        await deps.backend[kind](enabled);
        deps.flash(label + (enabled ? '已注册' : '已取消'));
    } catch (e) {
        deps.flash(label + (enabled ? '注册失败：' : '取消注册失败：') + e, true);
    } finally {
        for (const el of [elsSettings.fileAssoc, elsSettings.contextMenu, elsSettings.agentSkill]) {
            if (el) el.disabled = false;
        }
        await syncIntegrationStatus();
    }
}

function openAbout() {
    openSettings('about');
}

let confirmAction = null;
// 保存冲突对话框的 Promise resolver：关闭对话框（按钮 / Esc / 遮罩）一律按取消处理
let saveConflictResolve = null;

function finishSaveConflict(choice) {
    const resolve = saveConflictResolve;
    saveConflictResolve = null;
    elsDialogs.conflict.classList.add('hidden');
    if (!elsDialogs.mask.classList.contains('hidden')) closeTopDialog();
    if (resolve) resolve(choice);
}

function openSaveConflictDialog(doc, deleted) {
    return new Promise((resolve) => {
        saveConflictResolve = resolve;
        const name = (doc && (doc.name || doc.path)) || '文件';
        elsDialogs.conflictText.textContent = deleted
            ? '「' + name + '」已在磁盘上被删除或移动，但编辑器里还有未保存的修改。'
            : '「' + name + '」已被其他程序修改，但编辑器里还有未保存的修改。请选择如何处理：';
        elsDialogs.conflictReload.disabled = !!deleted;
        openDialogEl(elsDialogs.conflict);
    });
}

elsDialogs.conflictReload.addEventListener('click', () => finishSaveConflict('reload'));
elsDialogs.conflictOverwrite.addEventListener('click', () => finishSaveConflict('overwrite'));
elsDialogs.conflictCancel.addEventListener('click', () => finishSaveConflict('cancel'));
let nameSubmit = null;
let nameBusy = false;

function openNameDialog(options) {
    const opts = options || {};
    elsDialogs.nameTitle.textContent = opts.title || '名称';
    elsDialogs.nameLabel.textContent = opts.label || '名称';
    elsDialogs.nameInput.value = opts.value || '';
    elsDialogs.nameInput.placeholder = opts.placeholder || '';
    elsDialogs.nameError.textContent = '';
    elsDialogs.nameError.classList.add('hidden');
    elsDialogs.nameOk.textContent = opts.okLabel || '确定';
    nameSubmit = opts.onSubmit || null;
    nameBusy = false;
    openDialogEl(elsDialogs.name, {keepSettings: true});
    setTimeout(() => {
        const input = elsDialogs.nameInput;
        input.focus();
        const dot = input.value.lastIndexOf('.');
        if (opts.selectStem && dot > 0) input.setSelectionRange(0, dot);
        else input.select();
    }, 0);
}

function nameDialogError(message) {
    elsDialogs.nameError.textContent = String(message || '');
    elsDialogs.nameError.classList.remove('hidden');
}

async function submitNameDialog() {
    if (!nameSubmit || nameBusy) return;
    const value = elsDialogs.nameInput.value;
    nameBusy = true;
    elsDialogs.nameOk.disabled = true;
    elsDialogs.nameError.classList.add('hidden');
    try {
        await nameSubmit(value);
        nameBusy = false;
        elsDialogs.nameOk.disabled = false;
        closeTopDialog();
    } catch (e) {
        nameDialogError((e && e.message) || e);
        nameBusy = false;
        elsDialogs.nameOk.disabled = false;
    }
}

elsDialogs.nameOk.addEventListener('click', submitNameDialog);
document.getElementById('btn-name-cancel').addEventListener('click', closeTopDialog);
elsDialogs.nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        submitNameDialog();
    } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeTopDialog();
    }
});

function cursorPositionForDoc() {
    if (!deps.file) return null;
    if (deps.currentMode === 'code' && deps.file.editor && deps.file.editor.aceEditor) {
        const pos = deps.file.editor.aceEditor.getCursorPosition();
        return {line: pos.row + 1, column: pos.column + 1};
    }
    if (deps.currentMode === 'text' && deps.file.pane) {
        const textarea = deps.file.pane.querySelector('textarea.jsoneditor-text');
        if (textarea) {
            const lines = textarea.value.slice(0, textarea.selectionEnd).split('\n');
            return {line: lines.length, column: lines[lines.length - 1].length + 1};
        }
    }
    return null;
}

// countWords 字数统计：CJK 字符逐个计 + 拉丁单词计 1（IDEA 风格)
// 对最近一次输入做备忘：updateWordCount 与写作统计同 tick 各调一次，大文本免二次正则
let countWordsCacheText = null;
let countWordsCacheTotal = 0;
function countWords(text) {
    const s = String(text || '');
    if (!s) return 0;
    if (s === countWordsCacheText) return countWordsCacheTotal;
    const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    const latin = (s.match(/[A-Za-z0-9]+(?:[''-][A-Za-z0-9]+)*/g) || []).length;
    countWordsCacheText = s;
    countWordsCacheTotal = cjk + latin;
    return countWordsCacheTotal;
}

let wordCountTimer = 0;

function updateWordCount() {
    if (!deps.els.stCount) return;
    const show = !!(deps.file && deps.file.editor && !deps.file.binary && !deps.file.large);
    deps.els.stCount.style.display = show ? '' : 'none';
    if (!show) return;
    let sel = 0;
    const ace = deps.file.editor.aceEditor;
    if (ace && !ace.selection.isEmpty()) {
        sel = countWords(ace.getSelectedText());
    } else if (deps.currentMode === 'preview') {
        sel = countWords(String(window.getSelection ? window.getSelection().toString() : ''));
    }
    const total = countWords(deps.file.editor.getText());
    deps.els.stCount.textContent = sel > 0 ? ('选中 ' + sel + ' · 全文 ' + total + ' 字') : ('全文 ' + total + ' 字');
    deps.els.stCount.title = '字数统计（CJK 字符数 + 英文单词数）';
}

function scheduleWordCount() {
    clearTimeout(wordCountTimer);
    wordCountTimer = setTimeout(() => {
        updateWordCount();
        deps.updateWritingStats();
    }, 150);
}


    function getConfirmAction() { return confirmAction; }
    function setConfirmAction(v) { confirmAction = v; }

    return {actRel, activityLog, applyIntegration, applyReadOnlyToDoc, applySettings, closeDialogs, closeTopDialog, countWords, currentTheme, cursorPositionForDoc, elsDialogs, elsSettings, getFormatSettings, installReadOnlyGuards, openDialogEl, openNameDialog, openSaveConflictDialog, openSettings, rtFullscreen, scheduleWordCount, selectSettingsPane, setTheme, syncIntegrationStatus, syncedOpenMode, toggleAlwaysOnTop, toggleCodeWrap, toggleFullscreen, updateLockButton, updateWordCount};
}
