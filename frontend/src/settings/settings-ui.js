// settings-ui.js：设置页核心（theme/字体/缩进/只读锁/applySettings/设置搜索/集成状态/字数统计）。
// 操作留痕（docs/unfinished-plans/operation-audit-log.md）——只记状态改变类摘要，正文/剪贴板/密钥永不落盘。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构。
// 对话框族、行式下拉、设置搜索已拆到同目录兄弟模块，经 Object.create 委托同一 deps。
import {createActivityLog} from '../core/activity-log.js';
import {iconSvg} from '../core/icons.js';
import {kvGetJson} from '../core/kv-store.js';
import {isDocReadOnly} from '../core/readonly.js';
import {CODE_SHOT_RADII, CODE_SHOT_SCALES} from '../core/code-shot.js';
import {refreshFileIconElements, setFileIconTheme} from '../core/fileicons.js';
import {themeRegistry} from '../core/theme-registry.js';
import {CODE_STYLE_AUTO, currentCodeStyleName, isValidCodeStyleId} from './code-styles.js';
import {createSettingsDialogs} from './settings-dialogs.js';
import {createSettingsSearch} from './settings-search.js';
import {createSettingsSelect} from './settings-select.js';
import {renderShortcutsTable, KEY_STYLES, DEFAULT_KEY_STYLE, isValidKeyStyleId, keyStyleName} from '../core/keybindings.js';
import {renderEditorShortcutsTable} from '../core/editor-keybindings.js';
import {SCROLL_STYLES} from '../editor/editor-smooth-scroll.js';
import {keymap} from '../core/keymap.js';
import {mergeSettingsInto, stripPerWindowLayout} from './settings-sync.js';

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

// 跨窗口设置同步（2026-11-22）：本窗口 applySettings 写完 localStorage 后广播 settings-changed；
// 收到别的窗口的广播时置 applyingRemote=true，原地合并内存 + 重绘，但不再广播（防环）。
// 布局键（PER_WINDOW_LAYOUT_KEYS）每窗口独立：广播仍带全量快照，但接收方合并前剥掉——
// 点侧边栏图标只属于当前窗口，不该镜像到别的窗口。
// 用 payload 携带完整快照而非只靠 localStorage——WebView2 多窗口是否共享 localStorage 未强依赖，
// 双保险：payload 到达后也顺手写回本窗口 localStorage，供方案 C（打开设置重读）兜底。
let applyingRemoteSettings = false;

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
    editorLineHeight: document.getElementById('opt-editor-line-height'),
    editorLineHeightVal: document.getElementById('opt-editor-line-height-val'),
    sidebarFont: document.getElementById('opt-sidebar-font'),
    sidebarFontVal: document.getElementById('opt-sidebar-font-val'),
    treeGuides: document.getElementById('opt-tree-guides'),
    treeCounts: document.getElementById('opt-tree-counts'),
    treeRefresh: document.getElementById('opt-tree-refresh'),
    showCadDir: document.getElementById('opt-show-cad-dir'),
    codeGuides: document.getElementById('opt-code-guides'),
    alwaysOnTop: document.getElementById('opt-always-on-top'),
    codeWrap: document.getElementById('opt-code-wrap'),
    completionFiles: document.getElementById('opt-completion-files'),
    completionSql: document.getElementById('opt-completion-sql'),
    completionLive: document.getElementById('opt-completion-live'),
    scrollStyle: document.getElementById('opt-scroll-style'),
    codeShotTitle: document.getElementById('opt-code-shot-title'),
    codeShotLineNumbers: document.getElementById('opt-code-shot-line-numbers'),
    codeShotRadius: document.getElementById('opt-code-shot-radius'),
    codeShotScale: document.getElementById('opt-code-shot-scale'),
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
    closeAction: document.getElementById('opt-close-action'),
    codeStyle: document.getElementById('opt-code-style'),
    iconTheme: document.getElementById('opt-icon-theme'),
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

// 快捷键表：由 core/keybindings.js 单一来源渲染，不再在 index.html 手抄一份。
// 表内容跟随当前快捷键风格（keymap.style），切换风格后立刻重绘。
const shortcutsTable = document.getElementById('shortcuts-table');
function renderShortcuts() {
    if (shortcutsTable) {
        shortcutsTable.innerHTML = renderShortcutsTable(keymap.style)
            + renderEditorShortcutsTable(keymap.style);
    }
}
renderShortcuts();
// 风格一变（设置页切换，或 main.js 启动时按存档切换）就重绘文案表。
keymap.subscribe(() => renderShortcuts());

function fillFontSelect(select, list) {
    select.textContent = '';
    for (const face of list) {
        const opt = document.createElement('option');
        opt.value = face.id;
        opt.textContent = face.name;
        select.appendChild(opt);
    }
}
function fillThemeSelect(select, items, selected) {
    if (!select) return;
    select.textContent = '';
    for (const item of items) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.name;
        select.appendChild(option);
    }
    select.value = items.some((item) => item.id === selected) ? selected : (items[0]?.id || '');
}

function refreshThemeSelects() {
    fillThemeSelect(elsSettings.codeStyle, [
        {id: CODE_STYLE_AUTO, name: '跟随软件主题'},
        ...themeRegistry.listCodeThemes(),
    ], currentCodeStyle());
    fillThemeSelect(elsSettings.iconTheme, themeRegistry.listIconThemes(), deps.settings.iconTheme || 'opensource');
}

refreshThemeSelects();
if (elsSettings.codeStyle) elsSettings.codeStyle.addEventListener('change', () => setCodeStyle(elsSettings.codeStyle.value));
if (elsSettings.iconTheme) elsSettings.iconTheme.addEventListener('change', () => setIconTheme(elsSettings.iconTheme.value));
// 快捷键风格下拉：选项来自 core/keybindings.js 单一来源（同代码主题下拉），
// 必须早于 createSettingsSelect 的行式下拉增强（增强时会读取 options 生成自定义面板）。
const keyStyleSelect = document.getElementById('opt-key-style');
if (keyStyleSelect) {
    keyStyleSelect.textContent = '';
    for (const style of KEY_STYLES) {
        const opt = document.createElement('option');
        opt.value = style.id;
        opt.textContent = style.name;
        keyStyleSelect.appendChild(opt);
    }
    keyStyleSelect.addEventListener('change', () => setKeyStyle(keyStyleSelect.value));
}
// 滚动手感下拉：选项来自 editor-smooth-scroll.js 的 SCROLL_STYLES 单一来源（同代码主题下拉写法）。
if (elsSettings.scrollStyle) {
    elsSettings.scrollStyle.textContent = '';
    for (const style of SCROLL_STYLES) {
        const opt = document.createElement('option');
        opt.value = style.value;
        opt.textContent = style.label;
        elsSettings.scrollStyle.appendChild(opt);
    }
    elsSettings.scrollStyle.addEventListener('change', () => {
        deps.settings.scrollStyle = elsSettings.scrollStyle.value;
        applySettings();
    });
}
// 代码截图样式（渲染档位单一来源在 core/code-shot.js 的 CODE_SHOT_RADII / CODE_SHOT_SCALES）
elsSettings.codeShotTitle.addEventListener('change', () => {
    deps.settings.codeShotTitle = elsSettings.codeShotTitle.checked;
    applySettings();
});
elsSettings.codeShotLineNumbers.addEventListener('change', () => {
    deps.settings.codeShotLineNumbers = elsSettings.codeShotLineNumbers.checked;
    applySettings();
});
elsSettings.codeShotRadius.addEventListener('change', () => {
    const radius = Number(elsSettings.codeShotRadius.value);
    deps.settings.codeShotRadius = CODE_SHOT_RADII.includes(radius) ? radius : 10;
    applySettings();
});
elsSettings.codeShotScale.addEventListener('change', () => {
    const scale = Number(elsSettings.codeShotScale.value);
    deps.settings.codeShotScale = CODE_SHOT_SCALES.includes(scale) ? scale : 2;
    applySettings();
});
fillFontSelect(elsSettings.uiFont, deps.uiFonts);
fillFontSelect(elsSettings.uiCjkFont, deps.cjkFonts);
fillFontSelect(elsSettings.editorFontFamily, deps.editorFonts);
fillFontSelect(elsSettings.editorCjkFont, deps.cjkFonts);
fillFontSelect(elsSettings.aiChatFontEn, [
    {id: 'follow', name: '跟随界面英文字体'},
    ...deps.uiFonts.map((f) => ({id: 'ui:' + f.id, name: f.name})),
    ...deps.editorFonts.map((f) => ({id: 'mono:' + f.id, name: f.name + '（等宽）'})),
]);
fillFontSelect(elsSettings.aiChatFontCjk, [
    {id: 'follow', name: '跟随界面中文字体'},
    ...deps.cjkFonts.map((f) => ({id: 'cjk:' + f.id, name: f.name})),
]);
fillFontSelect(elsSettings.aiChatCodeFont, [
    {id: 'follow', name: '跟随编辑器字体'},
    ...deps.editorFonts.map((f) => ({id: 'mono:' + f.id, name: f.name})),
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
function setSyncedOpenMode(value) {
    syncedOpenMode = value;
}

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

// 关闭行为（exit / tray）：判定在后端 beforeClose，所以每次变化都要推过去落盘。
// 首次 applySettings 只记快照不推送——启动时后端已从 config.json 读到同一个值。
let syncedCloseAction = null;
function syncCloseAction() {
    const value = deps.settings.closeAction === 'tray' ? 'tray' : 'exit';
    if (syncedCloseAction === null) {
        syncedCloseAction = value;
        return;
    }
    if (syncedCloseAction === value) return;
    syncedCloseAction = value;
    if (deps.backend && deps.backend.SetCloseAction) {
        try {
            deps.backend.SetCloseAction(value);
        } catch (e) {}
    }
}

let appliedTheme = '';
function currentTheme() {
    return themeRegistry.getUiTheme(deps.settings.theme) || themeRegistry.listUiThemes()[0];
}

function applyTheme(force = false) {
    const theme = currentTheme();
    if (!force && appliedTheme === theme.id) return;
    document.documentElement.dataset.theme = theme.id;
    appliedTheme = theme.id;
    if (deps.backend && deps.backend.SetWindowBg) {
        const n = parseInt(theme.bg.slice(1), 16);
        try {
            deps.backend.SetWindowBg((n >> 16) & 255, (n >> 8) & 255, n & 255);
        } catch (e) {}
    }
}

// 代码主题独立于界面主题；auto 不写属性，让 token 自然回落到界面变量。
let appliedCodeStyle = null;
function currentCodeStyle() {
    return String(deps.settings.codeStyle || CODE_STYLE_AUTO);
}

function applyCodeStyle(force = false) {
    const requested = currentCodeStyle();
    const id = isValidCodeStyleId(requested, themeRegistry.listCodeThemes()) ? requested : CODE_STYLE_AUTO;
    if (!force && appliedCodeStyle === id) return;
    if (id === CODE_STYLE_AUTO) delete document.documentElement.dataset.codeStyle;
    else document.documentElement.dataset.codeStyle = id;
    appliedCodeStyle = id;
    if (elsSettings.codeStyle && [...elsSettings.codeStyle.options].some((option) => option.value === requested)) {
        elsSettings.codeStyle.value = requested;
    }
}

function setCodeStyle(id) {
    const value = String(id || CODE_STYLE_AUTO);
    if (!isValidCodeStyleId(value, themeRegistry.listCodeThemes())) return;
    deps.settings.codeStyle = value;
    applySettings();
    deps.flash('代码主题：' + currentCodeStyleName(deps.settings.theme, value, themeRegistry.listCodeThemes(), themeRegistry.listUiThemes()));
}

let appliedIconTheme = '';
function applyFileIconTheme(force = false) {
    const id = themeRegistry.hasIconTheme(deps.settings.iconTheme) ? deps.settings.iconTheme : 'opensource';
    if (!force && appliedIconTheme === id) return;
    setFileIconTheme(id, themeRegistry.iconThemeMap());
    refreshFileIconElements();
    appliedIconTheme = id;
    if (elsSettings.iconTheme && [...elsSettings.iconTheme.options].some((option) => option.value === id)) {
        elsSettings.iconTheme.value = id;
    }
}

function setIconTheme(id) {
    if (!themeRegistry.hasIconTheme(id)) return;
    deps.settings.iconTheme = id;
    applySettings();
    deps.flash('文件图标主题：' + (themeRegistry.getIconTheme(id)?.name || id));
}

function reconcileThemes() {
    return themeRegistry.reconcileSettings(deps.settings);
}

function refreshThemes() {
    refreshThemeSelects();
    applyTheme(true);
    applyCodeStyle(true);
    applyFileIconTheme(true);
    if (typeof selMod.enhanceSelect === 'function') {
        selMod.enhanceSelect(elsSettings.codeStyle);
        selMod.enhanceSelect(elsSettings.iconTheme);
    }
}

// 快捷键风格：切换整套键位方案（settings.keyStyle）。
// 运行时索引在 core/keymap.js（全局单例，main.js 的按键链查同一份），
// 这里切完立即生效；文案表同步重绘，两者同源（core/keybindings.js 一张表）。
function setKeyStyle(id) {
    const value = String(id || '');
    if (!isValidKeyStyleId(value)) return;
    deps.settings.keyStyle = value;
    keymap.setStyle(value);   // 运行时索引立即切换，行为随之生效；文案表由订阅回调重绘
    // 编辑器内键位（Ace CommandManager）不走全局 keymap，需单独重绑所有已开编辑器
    if (typeof deps.applyEditorKeybindingsToAll === 'function') deps.applyEditorKeybindingsToAll();
    if (keyStyleSelect) keyStyleSelect.value = value;
    applySettings();
    deps.flash('快捷键风格：' + keyStyleName(value));
}

function setTheme(id) {
    if (!themeRegistry.hasUiTheme(id)) return;
    deps.settings.theme = id;
    applySettings();
    // 主题切换后必须重绘预览：mermaid 出的 SVG 颜色是渲染时写死的，不重绘会把深色图表贴在浅色界面上。
    // （原先这里有一行 `&& doc && false` 的残留判断，preview 下会先抛 ReferenceError 把重绘掐掉。）
    // 分屏视图 currentMode 是 'code' 但右侧预览同样挂着 mermaid 图，一并重绘（报告 §1.3.2）。
    if (deps.file && (deps.currentMode === 'preview' || deps.file.splitActive)) deps.renderMarkdownPreview(deps.file);
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

// 置顶值未变就不调用运行时（2026-11-22）：applySettings 是高频出口（侧边栏切换、跨窗口
// settings-changed 同步与发送方回声都会触发），而 Wails 的 SetAlwaysOnTop 落到
// SetWindowPos(HWND_TOPMOST/NOTOPMOST, 无 SWP_NOACTIVATE/NOZORDER) 时会把窗口无条件提到
// 本档 Z 序最顶——值没变也一样（win32 实测，非 MSDN 文档语义）。不设防的话，任何窗口点
// 侧边栏图标都会让另一个窗口跳到前台、再被发送方回声顶回来，表现为两窗来回闪一下。
let lastAppliedAlwaysOnTop = null;

function applyAlwaysOnTop() {
    const next = !!deps.settings.alwaysOnTop;
    if (lastAppliedAlwaysOnTop === next) return;
    if (!deps.rt || !deps.rt.WindowSetAlwaysOnTop) return;
    try {
        deps.rt.WindowSetAlwaysOnTop(next);
        lastAppliedAlwaysOnTop = next;
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
        deps.els.lock.dataset.tip = locked ? '解除只读锁定' : '只读锁定';
        deps.els.lock.innerHTML = locked ? deps.LOCK_ICON : deps.UNLOCK_ICON;
    }
}

function installReadOnlyGuards(pane, doc) {
    if (!pane) return;
    // 每次事件都重新求值：标签页只读锁可以在不刷新编辑器的情况下切换。
    const locked = () => isDocReadOnly(doc, deps.settings);
    const inTreeField = (target) => target && target.closest && target.closest('.jsoneditor-field, .jsoneditor-value');
    pane.addEventListener('beforeinput', (e) => {
        if (!locked() || !inTreeField(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
    }, true);
    pane.addEventListener('keydown', (e) => {
        if (!locked() || !inTreeField(e.target)) return;
        const key = e.key;
        if ((e.ctrlKey || e.metaKey) && ['c', 'C', 'a', 'A'].includes(key)) return;
        if (['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(key)) return;
        e.preventDefault();
        e.stopPropagation();
    }, true);
    for (const type of ['paste', 'cut', 'drop']) {
        pane.addEventListener(type, (e) => {
            if (!locked() || !inTreeField(e.target)) return;
            e.preventDefault();
            e.stopPropagation();
        }, true);
    }
    pane.addEventListener('contextmenu', (e) => {
        if (!locked()) return;
        if (e.target.closest && e.target.closest('.jsoneditor-tree')) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);
}

function applyReadOnlyToDoc(doc) {
    if (!doc || !doc.editor) return;
    const locked = isDocReadOnly(doc, deps.settings);
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

// 关于页横幅随系统时间切换：白天（6–18 点）用 light 版配图，夜间（其余时段）用 dark 版。
// 只影响「关于」页顶部的横幅配图，不改变应用主题；打开设置 / 换肤 / 启动时刷新。
function syncAboutBannerByTime() {
    const hour = new Date().getHours();
    document.documentElement.classList.toggle('about-night', hour >= 18 || hour < 6);
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
    syncAboutBannerByTime();
    applyTheme();
    applyCodeStyle();
    applyFileIconTheme();
    if (keyStyleSelect) keyStyleSelect.value = String(deps.settings.keyStyle || DEFAULT_KEY_STYLE);
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
    if (elsSettings.editorLineHeight) elsSettings.editorLineHeight.value = String(deps.settings.editorLineHeight);
    if (elsSettings.editorLineHeightVal) elsSettings.editorLineHeightVal.textContent = String(deps.settings.editorLineHeight);
    elsSettings.sidebarFont.value = String(deps.settings.sidebarFont);
    elsSettings.sidebarFontVal.textContent = String(deps.settings.sidebarFont);
    elsSettings.treeGuides.checked = !!deps.settings.treeGuides;
    elsSettings.treeCounts.checked = !!deps.settings.treeCounts;
    elsSettings.treeRefresh.value = String(deps.settings.treeRefreshInterval);
    if (deps.explorer && deps.explorer.setAutoRefresh) deps.explorer.setAutoRefresh(deps.settings.treeRefreshInterval);
    if (elsSettings.showCadDir) elsSettings.showCadDir.checked = deps.settings.showCadDir !== false;
    if (deps.explorer && deps.explorer.setShowCadDir) deps.explorer.setShowCadDir(deps.settings.showCadDir !== false);
    elsSettings.autoSave.checked = !!deps.settings.autoSave;
    elsSettings.codeGuides.checked = !!deps.settings.codeGuides;
    elsSettings.alwaysOnTop.checked = !!deps.settings.alwaysOnTop;
    elsSettings.codeWrap.checked = !!deps.settings.codeWrap;
    // 补全三开关（settings.completion 归一化语义与 core/completion.js 一致：缺省=开/开/关）
    const comp = deps.settings.completion && typeof deps.settings.completion === 'object' ? deps.settings.completion : {};
    if (elsSettings.completionFiles) elsSettings.completionFiles.checked = comp.files !== false;
    if (elsSettings.completionSql) elsSettings.completionSql.checked = comp.sql !== false;
    if (elsSettings.completionLive) elsSettings.completionLive.checked = comp.live === true;
    if (elsSettings.scrollStyle) elsSettings.scrollStyle.value = SCROLL_STYLES.some((s) => s.value === deps.settings.scrollStyle) ? deps.settings.scrollStyle : 'standard';
    elsSettings.codeShotTitle.checked = !!deps.settings.codeShotTitle;
    elsSettings.codeShotLineNumbers.checked = deps.settings.codeShotLineNumbers !== false;
    elsSettings.codeShotRadius.value = String(CODE_SHOT_RADII.includes(Number(deps.settings.codeShotRadius)) ? Number(deps.settings.codeShotRadius) : 10);
    elsSettings.codeShotScale.value = String(CODE_SHOT_SCALES.includes(Number(deps.settings.codeShotScale)) ? Number(deps.settings.codeShotScale) : 2);
    elsSettings.mdLineNumbers.checked = !!deps.settings.mdLineNumbers;
    elsSettings.mdScrollSync.checked = deps.settings.mdScrollSync !== false;
    elsSettings.mdPreviewWidth.value = String(deps.settings.mdPreviewWidth);
    elsSettings.autoCheckUpdate.checked = deps.settings.autoCheckUpdate !== false;
    if (elsSettings.treeExpand) elsSettings.treeExpand.value = deps.settings.treeExpandDefault;
    elsSettings.showBanners.checked = !!deps.settings.showBanners;
    elsSettings.openMode.value = deps.settings.openMode;
    if (elsSettings.closeAction) elsSettings.closeAction.value = deps.settings.closeAction === 'tray' ? 'tray' : 'exit';
    if (elsSettings.activityLog) elsSettings.activityLog.checked = deps.settings.activityLog !== false;
    if (elsSettings.activityRetention) elsSettings.activityRetention.value = String(deps.settings.activityRetentionMonths || 12);
    document.documentElement.dataset.tabClose = deps.settings.tabCloseMode;
    if (elsSettings.tabClose) elsSettings.tabClose.value = deps.settings.tabCloseMode;
    if (elsSettings.dblClickClose) elsSettings.dblClickClose.checked = !!deps.settings.dblClickClose;
    if (elsSettings.shiftClickClose) elsSettings.shiftClickClose.checked = deps.settings.shiftClickClose !== false;
    syncOpenMode();
    syncCloseAction();
    document.documentElement.style.setProperty('--editor-font', deps.settings.editorFont + 'px');
    // 代码编辑器行高：Ace 从字体度量（measureNode.clientHeight）算行高，measureNode 用 font:inherit
    // 继承 .ace_editor 的 line-height；变量须在下方 setFontSize（触发度量重算）之前写入。
    document.documentElement.style.setProperty('--editor-line-height', String(deps.settings.editorLineHeight));
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
            const ace = deps.editor.aceEditor;
            ace.setFontSize(deps.settings.editorFont);
            // 行高由 --editor-line-height 驱动；setFontSize 在字号未变时会跳过度量重算，
            // 这里显式触发一次，让 Ace 重新测量 measureNode.clientHeight 并更新每行像素。
            if (ace.renderer && ace.renderer.$textLayer && typeof ace.renderer.$textLayer.checkForSizeChanges === 'function') {
                ace.renderer.$textLayer.checkForSizeChanges();
            }
        } catch (e) {}
    }
    applyCodeWrap();
    applyCodeGuides();
    applyAlwaysOnTop();
    applyReadOnlyMode();
    // 补全设置热生效：live/总开关变更即时应用到已开编辑器（依赖 main.js 注入的组合根回调）
    if (typeof deps.applyCompletionSettingsToAll === 'function') {
        try { deps.applyCompletionSettingsToAll(); } catch (e) {}
    }
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
    // 临时草稿（doc.draft）不依赖 autoSave 开关，设置变更后也要把它的防抖保存重新挂上
    if ((deps.settings.autoSave || (deps.file && deps.file.draft)) && deps.dirty &&
        !isDocReadOnly(deps.file, deps.settings)) deps.scheduleAutoSave();
    else deps.cancelAutoSave();
    broadcastSettings();
}

// broadcastSettings：settings-changed 的唯一广播点（applySettings / persistSettingsLight 共用）。
// 全量快照走 payload（localStorage 是否跨窗口共享不强依赖）；远端触发期间静默，防回声环。
function broadcastSettings() {
    if (applyingRemoteSettings || !deps.rt || typeof deps.rt.EventsEmit !== 'function') return;
    try {
        deps.rt.EventsEmit('settings-changed', {values: JSON.parse(JSON.stringify(deps.settings))});
    } catch (e) {}
}

// persistSettingsLight：轻量落盘出口——只写 localStorage + 广播，不做全量重绘。
// 供拖分割线、草稿扩展名记忆这类高频/局部小改动用：它们同样改了 settings 对象，
// 漏广播会让别的窗口内存副本停在旧值；走 applySettings 的全量重绘对它们又是浪费。
// 布局键进广播无害：接收方 applyRemoteSettings 会剥掉（PER_WINDOW_LAYOUT_KEYS）。
function persistSettingsLight() {
    try {
        localStorage.setItem(deps.settingsKey, JSON.stringify(deps.settings));
    } catch (e) {}
    broadcastSettings();
}

// applyRemoteSettings：收到别的窗口的 settings-changed 广播后，把快照原地合并进内存副本。
// 必须原地合并（Object.assign）而非替换对象——ai-panel / ai-cognition 等模块持有 settings
// 的值快照引用（ai-panel.js:327 `const settings = opts.settings`），换对象它们读不到新值。
// payload 是权威来源；顺手写回本窗口 localStorage，供 openSettings 的方案 C 兜底。
function applyRemoteSettings(values) {
    if (!values || typeof values !== 'object') return;
    applyingRemoteSettings = true;
    try {
        // 布局键（侧栏显隐/视图/宽度、AI 面板形态等）每窗口独立，跨窗合并前剥掉——
        // 这里是广播与方案 C 重读（reloadSettingsFromDisk）的共同必经点，别处不要再直并。
        const changed = mergeSettingsInto(deps.settings, stripPerWindowLayout(values));
        if (!changed.length) return; // 同源回声（发出的窗口自己也收）：值没变，不重绘
        try { localStorage.setItem(deps.settingsKey, JSON.stringify(deps.settings)); } catch (e) {}
        applySettings();
    } finally {
        applyingRemoteSettings = false;
    }
}

// reloadSettingsFromDisk：方案 C 兜底——打开设置页时从 localStorage 重读一次再渲染。
// 处理「广播事件在设置页未打开时到达、但 localStorage 是共享的」这类场景；若本地存储不共享，
// 读到的仍是旧值，此时纯靠事件广播（applyRemoteSettings）保证正确，本函数无副作用。
function reloadSettingsFromDisk() {
    // 只读一次本窗口 localStorage 快照；读不到 / 损坏时保持现状（正确性由事件广播兜底）
    const stored = kvGetJson(deps.settingsKey, null);
    if (!stored || typeof stored !== 'object') return;
    applyRemoteSettings(stored);
}


// 关于页版本号唯一来源是 Go 的 appVersion（GetAppVersion 绑定），index.html 只留占位符。
let aboutVersionText = '';
async function fillAboutVersion() {
    const el = document.getElementById('about-version');
    if (!el) return;
    if (aboutVersionText) {
        el.textContent = aboutVersionText;
        return;
    }
    try {
        if (deps.backend && deps.backend.GetAppVersion) {
            const version = await deps.backend.GetAppVersion();
            if (version) {
                aboutVersionText = version;
                el.textContent = version;
            }
        }
    } catch (e) {
        // 尽力而为：版本取不到就保留占位符，不打扰用户
    }
}

function selectSettingsPane(pane) {
    searchMod.resetSettingsSearch();
    // 菜单管理是动态行：进本页时重建一次，保证显隐/顺序/模板改动立刻可见
    if (pane === 'new-file-menu' && deps.newFileMenuPane && typeof deps.newFileMenuPane.renderNewFileMenuPane === 'function') {
        deps.newFileMenuPane.renderNewFileMenuPane();
    }
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
        // 外部工具、智能体已迁为应用页面标签页（core/app-pages.js），不再是设置子页
        const inAI = pane === 'models' || pane === 'gen-models' || pane === 'ai' || pane === 'persona' || pane === 'context' || pane === 'preferences';
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
    else if (String(pane).startsWith('plugin-') && deps.renderPluginSettingsPane) deps.renderPluginSettingsPane(pane);
    else if (pane === 'run') deps.renderRunPane();
    else if (pane === 'lifecycle' && typeof deps.renderLifecyclePane === 'function') deps.renderLifecyclePane();
    else if (pane === 'envvars') deps.renderEnvVarsPane();
    else if (pane === 'app-pages' && typeof deps.renderAppPagesPane === 'function') deps.renderAppPagesPane();
    else if (pane === 'storage') deps.renderStoragePane();
    else if (pane === 'developer') {
        // 开发者页只剩日志与调试控制台；补丁库已迁为内容区标签页（应用页面 → 补丁库）
        // 外部工具同理已迁（应用页面 → 外部工具），AI 子页不再有它
    }
    if (pane === 'ai' || pane === 'models' || pane === 'gen-models' || pane === 'persona' || pane === 'context' || pane === 'preferences') {
        if (!deps.aiPanel) deps.initAIPanel();
        if (deps.aiPanel && typeof deps.aiPanel.refreshSettings === 'function') {
            try { deps.aiPanel.refreshSettings(); } catch (e) {}
        }
    }
    // 定时任务已迁为内容区标签页（应用页面 → 定时任务），CRUD 后由页面自己刷新列表
    // 动态面板（格式总览 / 格式子页 / 运行 / AI 设置）每次重建都会生成新的 select，
    // 渲染完再增强一次，避免它们退回原生外观。
    selMod.enhanceSetSelects();
}

function openSettings(pane = 'general', preset) {
    // 方案 C：打开设置前先从 localStorage 重读一次，兜住事件广播错过的变更。
    reloadSettingsFromDisk();
    dlgMod.openDialogEl(elsDialogs.settings);
    searchMod.resetSettingsSearch();
    selectSettingsPane(pane);
    // 插件市场搜索预设（端侧分类器状态行的「下载语义模型」跳转带 onnx 关键词进来）
    if (pane === 'plugins' && preset) {
        const search = document.getElementById('plugin-market-search');
        if (search) {
            search.value = preset;
            search.dispatchEvent(new Event('input', {bubbles: true}));
        }
    }
    // 左栏逐项图标：按 data-icon 用 iconSvg 填充（唯一图标来源，只填一次）
    if (deps.iconSvg) {
        document.querySelectorAll('.snav-ic[data-icon]').forEach((el) => {
            if (!el.dataset.done) {
                el.innerHTML = deps.iconSvg(el.dataset.icon, 13);
                el.dataset.done = '1';
            }
        });
    }
    // 横幅配图按打开时刻刷新：设置页可能跨过白天/夜间边界一直开着
    syncAboutBannerByTime();
    deps.refreshDeveloperMode();
    deps.refreshLogPath();
    if (pane === 'about') {
        const status = document.getElementById('about-update-status');
        if (status) {
            status.textContent = '';
            status.className = 'about-update-status';
        }
        fillAboutVersion();
    }
    if (pane === 'integration') syncIntegrationStatus();
}

// 打开设置并定位到某行：pane 切过去后把目标行滚到视口中央并高亮闪烁
// （.settings-hit 模式与 settings-search 的命中高亮同款，1600ms 同步）。
// 传控件元素（如开关 input），向上找 .set-row；行不存在（pane 不对/已改名）静默跳过。
function openSettingsAtRow(pane, controlEl) {
    openSettings(pane);
    const row = controlEl && controlEl.closest ? controlEl.closest('.set-row') : null;
    if (!row) return;
    requestAnimationFrame(() => {
        if (!row.isConnected) return;
        row.scrollIntoView({block: 'center'});
        row.classList.add('settings-hit');
        setTimeout(() => row.classList.remove('settings-hit'), 1600);
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
        elsSettings.exePath.dataset.tip = status.executable || '';
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
    deps.els.stCount.dataset.tip = '字数统计（CJK 字符数 + 英文单词数）';
}

function scheduleWordCount() {
    clearTimeout(wordCountTimer);
    wordCountTimer = setTimeout(() => {
        updateWordCount();
        deps.updateWritingStats();
    }, 150);
}



// 三个兄弟模块：对话框族 / 行式下拉 / 设置搜索。经 Object.create 委托原 deps（getter 惰性），只补宿主能力
const dlgDeps = Object.create(deps);
dlgDeps.elsDialogs = elsDialogs;
dlgDeps.openSettings = openSettings;
const dlgMod = createSettingsDialogs(dlgDeps);

const selMod = createSettingsSelect(deps);

const searchDeps = Object.create(deps);
searchDeps.selectSettingsPane = selectSettingsPane;
searchDeps.elsSettings = elsSettings;
// 应用页面命中后收掉设置弹层，避免标签页被模态挡住（同 settings-pane-app-pages 的行为）
searchDeps.closeSettings = () => dlgMod.closeDialogs();
const searchMod = createSettingsSearch(searchDeps);
themeRegistry.subscribe(refreshThemes);

// 通用「跳到应用页面」按钮委托：某些设置项的前置配置在应用页面标签页（如默认桌面控制
// 要先在外部工具页安装），用 data-open-app-page="<pageId>" 给一条按钮通路，避免只靠
// desc 文字指路。委托到设置对话框根容器，动态渲染的按钮也生效。
// openAppPageTab 由组合根在后面定义（getter 延迟求值），typeof 判断必须放在回调里避开 TDZ。
if (elsDialogs.settings) {
    elsDialogs.settings.addEventListener('click', (e) => {
        const appBtn = e.target && e.target.closest ? e.target.closest('[data-open-app-page]') : null;
        if (appBtn) {
            const pageId = appBtn.getAttribute('data-open-app-page');
            if (!pageId || typeof deps.openAppPageTab !== 'function') return;
            deps.openAppPageTab(pageId);
            dlgMod.closeDialogs();
            return;
        }
        // 正交维度互跳（语言↔运行、插件↔权限）：只切 pane，不关设置弹层。
        const paneBtn = e.target && e.target.closest ? e.target.closest('[data-open-pane],[data-open-pane-from]') : null;
        if (paneBtn) {
            let pane = paneBtn.getAttribute('data-open-pane');
            const fromId = paneBtn.getAttribute('data-open-pane-from');
            if (fromId) {
                const src = document.getElementById(fromId);
                const prefix = paneBtn.getAttribute('data-open-pane-prefix') || '';
                if (src && src.value) pane = prefix + src.value;
            }
            if (!pane) return;
            selectSettingsPane(pane);
            const anchorId = paneBtn.getAttribute('data-open-anchor');
            if (anchorId) {
                requestAnimationFrame(() => {
                    const group = document.getElementById(anchorId);
                    if (!group || !group.isConnected) return;
                    group.scrollIntoView({block: 'center'});
                    group.classList.add('settings-hit');
                    setTimeout(() => group.classList.remove('settings-hit'), 1600);
                });
            }
        }
    });
}

    return {
        ...dlgMod, ...selMod, ...searchMod,
        actRel, activityLog, applyCodeStyle, applyIntegration, applyReadOnlyToDoc, applyRemoteSettings, applySettings, countWords, currentCodeStyle, currentTheme, cursorPositionForDoc, elsDialogs, elsSettings, getFormatSettings, installReadOnlyGuards, openSettings, openSettingsAtRow, persistSettingsLight, reconcileThemes, refreshThemes, rtFullscreen, scheduleWordCount, selectSettingsPane, setCodeStyle, setIconTheme, setSyncedOpenMode, setTheme, syncIntegrationStatus, syncedOpenMode, toggleAlwaysOnTop, toggleCodeWrap, toggleFullscreen, updateLockButton, updateWordCount,
    };
}
