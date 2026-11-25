import 'katex/dist/katex.min.css';
import './style.css';
import './reading.css';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import {detectFormat, formats, isSupportedFile, pluginFormats} from './core/formats.js';
import {installTooltip, setTooltipActionHandler} from './core/tooltip.js';
import {createExplorer} from './explorer/explorer.js';
import {createStructurePanel, parseStructure} from './editor/structure.js';
import {createContextMenu, inSubmenuCone, pointInRect, SUBMENU_CONE_CLOSE_DELAY_MS} from './shell/contextmenu.js';
import {bindEditableContextMenuFallback} from './shell/edit-menu.js';
import {copyImageBlobToClipboard} from './core/image-clipboard.js';
import {copyTextToClipboard} from './core/clipboard.js';
import {kvGetJson} from './core/kv-store.js';
import {prepareImagePayload} from './ai/tools/ai-image-encode.js';
import {normalizeTermText} from './ai/tools/ai-terminal-tools.js';
import {createAICognitionPage} from './ai/settings/ai-cognition-page.js';
import {pickPreviewKind} from './editor/preview-window-view.js';
import {createAuxWindowModes} from './shell/aux-window-modes.js';
import {CODE_SHOT_RADII, CODE_SHOT_SCALES} from './core/code-shot.js';
import {createDebugConsole} from './terminal/debugconsole.js';
import {createActivityLog} from './core/activity-log.js';
import {createDbUi} from './db/db-ui.js';
import {createMavenPanel} from './maven/maven-panel.js';
import {createDbTableTabView, createDbConsoleTabView, createDbRedisKeyTabView} from './db/db-tab-views.js';
import {configureDbSessions} from './db/db-sessions.js';
import {createDbAppActions} from './db/db-app-actions.js';
import {iconSvg, renderMenuIcon} from './core/icons.js';
import {createPalette} from './shell/palette.js';
import {createAIPanel} from './ai/ai-panel.js';
import {createAIWipeguard, WIPEGUARD_NOTIFY_COOLDOWN_MS} from './ai/security/ai-wipeguard.js';
import {decideAutoCollapse, shouldExpandEditorOnTab} from './ai/chat/ai-auto-collapse.js';
import {createReadingMode} from './reading/reading.js';
import {repairJson} from './core/jsonrepair.js';
import {fileIconSpec} from './core/fileicons.js';
import {themeRegistry} from './core/theme-registry.js';
import {BUILTIN_FILE_TYPES, defaultNewFileMenu, fileTypeMenuItem, normalizeNewFileMenu} from './explorer/new-file-menu.js';
import {RECIPES, activeRunConfig, extOf, SELF_TEST} from './terminal/run.js';
import {queryJsonPath} from './core/jsonpath.js';
import {unifiedDiff} from './core/diff.js';
import {validateJsonSchema} from './core/jsonschema.js';
import {getPluginCommands, getPluginCommandClassifiers, getPluginLoadErrors, loadPlugins} from './shell/plugins.js';
import {commandAppliesTo, commandCategoryLabel, evalCommandWhen, matchCommandShortcut} from './shell/plugin-commands-model.js';
import * as pluginToolsMod from './shell/plugin-tools.js';
import * as pluginContextMod from './shell/plugin-context.js';
import {createPluginImporter} from './shell/plugin-importer.js';
import {createMarkdownRenderer} from './core/markdown.js';
import {
    showPatchView, hidePatchView, disposePatchView, refreshPatchView,
    patchViewSnapshot, setPatchTargetRoot, repreviewPatchView,
} from './editor/patch-view.js';
import {WRITING_FONTS, WRITING_PAPERS, SCENE_SEPARATOR} from './core/writing.js';
import termsText from '../../docs/legal/terms.md?raw';
import privacyText from '../../docs/legal/privacy.md?raw';
import {createBridgeUI} from './bridge/bridge-ui.js';
import {createAIGroupRuntime} from './ai/group/ai-group-runtime.js';
import {createAIGroupSidebar} from './ai/group/ai-group-sidebar.js';
import {createAIGroupView} from './ai/group/ai-group-view.js';
import {createAIGroupMemberView} from './ai/group/ai-group-member-view.js';
// app_control 代建智能体 / 群聊：数据层纯函数（模型清单/关键词解析/校验/群草稿）+ 唯一 id 生成
import {agentsUpsert, listModelOptions, resolveModelByKeyword} from './ai/agent/ai-agent-model.js';
import {buildGroupDraft} from './ai/group/ai-group-model.js';
import {isOfficialPluginSource, pluginInstallRoute, pluginUninstallRoute} from './ai/security/ai-app-approval.js';
import {
    applySettingsValue, buildSettingsTree, coerceSettingsValue,
    describeSettingsInput, describeSettingsValue, findSettingsRow, settingsRowSnapshot,
} from './settings/settings-tree.js';
import {aiNowId} from './ai/core/ai-constants.js';
import {createCursorThemes} from './shell/cursor-themes.js';
import {createTerminalUI} from './terminal/terminal-ui.js';
import {createFormatConvert} from './editor/format-convert.js';
import {createUpdateCheck} from './shell/update-check.js';
import {createAppLinks} from './shell/app-links.js';
import {createPropertiesUI} from './shell/properties-ui.js';
import {createSessionRestore} from './shell/session-restore.js';
import {createBrowserTabRestore} from './shell/browser-tab-restore.js';
import {decideSessionOpen} from './ai/session/ai-session-scope.js';
import {createAppActions} from './shell/app-actions.js';
import {createFileDropRouter} from './shell/file-drop-router.js';
import {installDropHighlightFallback} from './shell/file-drop-highlight.js';
import {installInternalDrop} from './shell/internal-drop.js';
import {createQuickSwitch} from './shell/quick-switch.js';
import {createSchemaPanel} from './editor/schema-panel.js';
import {createDiffDialog} from './editor/diff-dialog.js';
import {createJsonQuery} from './editor/json-query.js';
import {createGlobalSearch} from './explorer/global-search.js';
import {createShiftDoubleTap} from './core/shift-double-tap.js';
import {keymap, comboSpecFromText} from './core/keymap.js';
import {DOUBLE_SHIFT, DEFAULT_KEY_STYLE, isValidKeyStyleId, getShortcut} from './core/keybindings.js';
import {createEditorKeybindings} from './editor/editor-keybindings.js';
import {refreshCompletionSettings} from './editor/editor-completion.js';
import {createMessageCenter} from './shell/message-center.js';
import {createFailureNotifier} from './shell/failure-notifier.js';
import {createFindBar} from './editor/find-bar.js';
import {createActivityPane} from './settings/activity-pane.js';
import {createSettingsPanePatches} from './settings/settings-pane-patches.js';
import {createSettingsPaneStorage} from './settings/settings-pane-storage.js';
import {createSettingsPaneUsageStats} from './settings/settings-pane-usage-stats.js';
import {createSettingsPaneAppPages} from './settings/settings-pane-app-pages.js';
import {createSettingsPaneWipeguard} from './settings/settings-pane-wipeguard.js';
import {createSettingsPaneNewFileMenu} from './settings/settings-pane-new-file-menu.js';
import {createSettingsPaneLifecycle} from './settings/settings-pane-lifecycle.js';
import {createLifecycleHooks} from './shell/lifecycle-hooks.js';
import {analyzeDangerousCommand} from './ai/security/ai-command-rules.js';
import {createStorageAutoClean} from './settings/storage-autoclean.js';
import {createSettingsPaneExternalTools} from './settings/settings-pane-external-tools.js';
import {createMenuBar} from './shell/menu-bar.js';
import {createModeSwitch} from './shell/mode-switch.js';
import {createTitlebarPopovers} from './shell/titlebar-popovers.js';
import {createSettingsUI} from './settings/settings-ui.js';
import {CODE_STYLE_AUTO, migrateLegacyTheme} from './settings/code-styles.js';
import {createWritingUI} from './writing/writing-ui.js';
import {createStructurePanelController} from './editor/structure-panel.js';
import {createEditorMenus} from './editor/editor-menus.js';
import {createExplorerOps} from './explorer/explorer-ops.js';
import {createEditorGroups} from './editor/editor-groups.js';
import {bookmarkOverview, formatBookmarkListText} from './editor/bookmark-list.js';
import {createBookmarkActions} from './editor/bookmark-actions.js';
import {isDocReadOnly, isTabReadOnlyFixed, isTabReadOnlyLocked} from './core/readonly.js';
import {listScratchDrafts, isScratchPath, normalizeScratchExt, scratchDir} from './core/scratch.js';
import {tabKindOf} from './core/tab-kinds.js';
import {APP_PAGES, appPageGroups, appPageOf} from './core/app-pages.js';
import {overlayStack} from './core/overlay-stack.js';
import {createDialogDrag} from './core/dialog-drag.js';
import {loadWailsRuntime, createRuntimeAdapter, createBackendProxy} from './core/wails-runtime.js';
import {createAppEventBridge, setAppEventBridge} from './core/app-events.js';

// 全局弹层栈的 Esc 分发监听必须先于一切弹层工厂注册（window 捕获阶段按注册顺序执行，
// 只有装得最早才能用 stopImmediatePropagation 可靠抢占各域散落的旧 Esc 监听）。
overlayStack.install(window);

// 对话框头部拖动（从 writing-mode.js 抽出）：事件委托覆盖静态 .dialog 族与动态创建的 AI 弹窗。
// .dialog 靠 translate(-50%,-50%) 居中，按下时需清 transform；AI 弹窗卡片靠 flex 居中，无需清。
createDialogDrag([
    {handle: '.dialog-head', exclude: '.dialog-close', clearTransform: true},
    {handle: '.ai-dialog-head', exclude: 'button'},
]).install(window);

window.addEventListener('error', (e) => {
    window.__modErr = (e.message || '') + ' @ ' + (e.filename || '').split('/').pop() + ':' + e.lineno + ':' + e.colno;
});

// 只读锁（状态栏按钮）：解锁/锁定成对语义，走注册表（.status-lock svg 由 CSS 统一 14px）
const UNLOCK_ICON = iconSvg('unlock');
const LOCK_ICON = iconSvg('lock');
const plainTextExtensions = new Set(['txt', 'log', 'conf']);

// Wails v3：没有 window.go 全局，绑定改为 /wails/runtime.js 的 Call.ByName。
// 加载失败 = 浏览器直开（mock 调试），走下方 mock 分支。
const wailsRuntime = await loadWailsRuntime();
const hasWails = !!wailsRuntime;

const mockScenario = new URLSearchParams(location.search);

let backend;
let rt = null;
if (hasWails) {
    rt = createRuntimeAdapter(wailsRuntime);
    backend = createBackendProxy(wailsRuntime.Call);
} else if (import.meta.env.DEV) {
    // vite dev 浏览器调试：动态加载 mock 后端（生产构建里这个分支被静态求值为 false，
    // chunk 不会产出，也就不会被 go:embed 打进 exe——dist 曾是 66 KB 的 mock-backend-*.js）
    const mock = await import('./dev/mock-backend.js');
    backend = mock.mockBackend;
    if (mockScenario.has('winctl')) rt = mock.mockRt;
}
// 兼容仍直接读 window.runtime / window.go 的旧模块（ai-panel / reading / 插件）。
if (rt) window.runtime = rt;
if (backend && hasWails) window.go = {main: {App: backend}};
// 事件桥：所有 EventsOn 统一经这里，按 sender / 工作区 / ID 归属过滤
// （多窗口语义见 docs/finished-plans/wails-v3-event-filtering.md）。
let wailsWindowName = null;
if (hasWails && wailsRuntime) {
    try { wailsWindowName = await wailsRuntime.Window.Name(); } catch (e) {}
}
const appEvents = createAppEventBridge({
    rt,
    windowName: wailsWindowName,
    logf: (msg) => console.debug('[app-events]', msg),
});
window.__appEvents = appEvents;
// 回放早于桥创建就排队的域模块订阅（run-ui 等在模块顶层 mount）。
setAppEventBridge(appEvents);
// 暴露给插件作者与调试：生产环境插件同样可以直接访问 window.go
window.__backend = backend;

// ===== 快捷便签：启动期事件（focus / workspace-changed / pagehide / initAIPanel）
// 可能早于 bridgeUI 的解构（约 5100 行）执行，一律先经这些早期 let 间接层，
// 解构完成后再绑真钩子——直接引用解构出的 const 会 TDZ（2026-11-18 实测未捕获异常）。
let memoFocusHook = null;          // 窗口聚焦 → 全局便签静默对账
let memoWorkspaceEventHook = null; // workspace-changed → 工作区便签重读
let memoResourceEventHook = null;  // resource-changed → 全局便签目录监听重读
let memoFlushHook = null;          // 关窗 / 页面隐藏 → 冲掉防抖保存
let dbSidebarRenderHook = null;    // 侧栏切到「数据库」面板 → 重绘工作区清单（dbUi 建得晚，先挂 null）
let mavenUi = null;                // Maven 工具窗口（下方创建）；applySidebarUI / 工作区切换经这里间接调
let mavenSidebarRenderHook = null; // 侧栏切到「Maven」面板 → 重绘项目树（同款间接层）
let memoJumpHook = null;           // --memo CLI / app-open-memo 事件 → 定位跳转
let memoPendingFlag = false;       // 有未落盘修改（writing-ui 的 anyDirty 经 getter 读它）

let developerMode = false;

function formatLogArg(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || value.message || String(value);
    try {
        const text = JSON.stringify(value);
        return text === undefined ? String(value) : text;
    } catch (e) {
        return String(value);
    }
}

// 独立调试控制台窗口探测（异步尽早开始；普通窗口为 false）
const consoleWindowMode = (async () => {
    try {
        if (!(backend && backend.IsDebugConsoleWindow)) return false;
        return !!(await backend.IsDebugConsoleWindow());
    } catch (e) {
        return false;
    }
})();
let consoleWindowResolved = null; // true=独立窗口 false=普通窗口 null=未定

// 终端独立窗口探测（异步尽早开始；普通窗口为 false）
const terminalWindowMode = (async () => {
    try {
        if (!(backend && backend.IsTerminalWindow)) return false;
        return !!(await backend.IsTerminalWindow());
    } catch (e) {
        return false;
    }
})();

// 悬浮调试控制台（F12）：先于 console 捕获补丁创建，保证所有日志都能进面板
const debugConsole = createDebugConsole({
    // 停靠到底部面板容器（与终端共用），显示/隐藏由底部面板控制
    mount: document.getElementById('debug-view'),
    // 日志区右键菜单（复制 / 全选 / 复制全部 / 清空）：走全局菜单实例（惰性）
    showContextMenu: openCtxMenu,
    // 面板关闭按钮：收起底部面板
    onClose: () => {
        try { toggleTerminalPanel(false); } catch (e) {}
    },
    // 主窗口把日志批量转给独立窗口（共享中继文件）；独立窗口自身不转发
    relay: (entries) => {
        if (consoleWindowResolved !== false) return;
        try { backend.DebugConsoleAppend?.(entries)?.catch?.(() => {}); } catch (e) {}
    },
    onDetach: () => {
        try {
            if (!backend.OpenDebugConsoleWindow) {
                flash('当前版本不支持独立窗口', true);
                return;
            }
            Promise.resolve(backend.OpenDebugConsoleWindow())
                .catch((e) => flash('打开调试控制台窗口失败：' + e, true));
        } catch (e) {}
    },
    onExport: (name, text) => exportDebugConsoleLog(name, text),
});

// 导出调试控制台日志：弹出保存对话框并写文件；取消时静默
async function exportDebugConsoleLog(name, text) {
    try {
        if (!backend.ExportDebugConsoleLog) {
            flash('当前版本不支持导出日志', true);
            return;
        }
        const path = await backend.ExportDebugConsoleLog(name, text);
        if (!path) return;
        flash('日志已导出：' + path);
    } catch (e) {
        flash('导出日志失败：' + e, true);
    }
}

// 独立控制台窗口内的轻提示：状态栏被隐藏，借用窗口标题提示
function notifyConsoleWindow(message) {
    try {
        const base = '调试控制台 · CaDt-DataLens';
        document.title = message + ' · ' + base;
        setTimeout(() => { document.title = base; }, 2500);
    } catch (e) {}
}
consoleWindowMode.then((v) => { consoleWindowResolved = v; });
window.__debugConsole = debugConsole;

// 独立控制台窗口：隐藏主应用 UI，铺满渲染控制台并轮询中继日志
function startConsoleWindowMode() {
    window.__consoleWindowMode = true;
    document.documentElement.classList.remove('app-booting');
    document.body.classList.add('console-only');
    document.title = '调试控制台 · CaDt-DataLens';
    // 独立控制台窗口没有编辑器初始化，全局 ctxMenu 不会创建：给调试台自建一个菜单实例
    const consoleMenu = createContextMenu();
    const dc = createDebugConsole({
        detached: true,
        showContextMenu: (items, x, y) => consoleMenu.open(items, x, y),
        remote: (offset) => backend.DebugConsoleRead(offset),
        onExport: async (name, text) => {
            try {
                if (!backend.ExportDebugConsoleLog) return;
                const path = await backend.ExportDebugConsoleLog(name, text);
                if (path) notifyConsoleWindow('日志已导出');
            } catch (e) {
                notifyConsoleWindow('导出失败');
            }
        },
        onClose: () => {
            try {
                // v3 里 runtime.Quit 是应用级退出：独立控制台只能关自己。
                // ForceClose 按 ctx 归属关闭调用方窗口（调试台不参与关窗确认）。
                if (backend.ForceClose) {
                    backend.ForceClose();
                    return;
                }
                if (window.runtime && window.runtime.WindowClose) {
                    window.runtime.WindowClose();
                }
            } catch (e) {}
        },
    });
    window.__debugConsole = dc;
    dc.open();
}

// 终端独立窗口：全屏渲染一个已存在的终端会话（弹出/收回机制见 terminal-sessions.js）。
// 跳过正常启动流程；主题/字体经 applySettings 套用，会话经环形缓冲快照回放接进来。
async function startTerminalWindowMode() {
    window.__terminalWindowMode = true;
    document.documentElement.classList.remove('app-booting');
    document.body.classList.add('terminal-only');
    try { applySettings(); } catch (e) {}
    let termId = '';
    try {
        termId = String((backend.GetStartupTermID && await backend.GetStartupTermID()) || '');
    } catch (e) {}
    if (!termId) {
        try { if (window.runtime && window.runtime.WindowClose) window.runtime.WindowClose(); } catch (e) {}
        return;
    }
    let shell = '';
    let cwdBase = '';
    try {
        const infos = backend.TermList ? await backend.TermList() : [];
        const info = infos.find((x) => x && x.id === termId);
        if (info) {
            shell = info.shell || '';
            cwdBase = String(info.cwd || '');
            {
                const cutAt = Math.max(cwdBase.lastIndexOf('\\'), cwdBase.lastIndexOf('/'));
                cwdBase = cwdBase.slice(cutAt + 1);
            }
        }
    } catch (e) {}
    const s = await terminalMod.attachResumedTermSession(termId, shell);
    toggleTerminalPanel(true);

    // 窗口头：标题（终端 + 工作区 + Shell 胶囊）+ 收回主窗口（关窗交还会话）+
    // 关闭会话（TermClose 后关窗）。无边框窗口，头部即拖动区（body.terminal-only CSS）。
    const panel = document.getElementById('terminal-panel');
    const head = document.createElement('div');
    head.id = 'term-window-head';
    const title = document.createElement('span');
    title.className = 'term-window-title';
    title.textContent = '终端';
    const actions = document.createElement('div');
    actions.className = 'term-window-actions';
    const redock = document.createElement('button');
    redock.type = 'button';
    redock.className = 'term-btn';
    redock.dataset.tip = '收回主窗口';
    redock.setAttribute('aria-label', '收回主窗口');
    redock.innerHTML = iconSvg('new-window', 12);
    redock.addEventListener('click', () => {
        try { if (window.runtime && window.runtime.WindowClose) window.runtime.WindowClose(); } catch (e) {}
    });
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'term-btn';
    closeBtn.dataset.tip = '关闭会话';
    closeBtn.setAttribute('aria-label', '关闭会话');
    closeBtn.innerHTML = iconSvg('close', 12);
    closeBtn.addEventListener('click', async () => {
        try { if (backend.TermClose) await backend.TermClose(termId); } catch (e) {}
        try { if (window.runtime && window.runtime.WindowClose) window.runtime.WindowClose(); } catch (e) {}
    });
    const shellPill = document.createElement('span');
    shellPill.className = 'term-window-pill';
    shellPill.textContent = terminalMod.termShellLabel(shell);
    const cwdPill = document.createElement('span');
    cwdPill.className = 'term-window-pill';
    cwdPill.dataset.tip = '会话启动目录';
    cwdPill.textContent = cwdBase;
    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    actions.append(redock, closeBtn);
    head.append(title);
    if (cwdBase) head.append(cwdPill);
    head.append(shellPill, spacer, actions);
    if (panel) panel.insertBefore(head, panel.firstChild);
    // OS 窗口标题（任务栏/Alt+Tab 可见）：终端 · 工作区 · Shell
    try {
        if (window.runtime && window.runtime.WindowSetTitle) {
            window.runtime.WindowSetTitle('终端 · ' + (cwdBase || '无工作区') + ' · ' + terminalMod.termShellLabel(shell));
        }
    } catch (e) {}
    if (s) {
        try { s.term.focus(); } catch (e) {}
    }
}

// 诊断日志单一入口：应用日志文件 + 调试台。此前它只写文件，模块里直接调
// logFrontend('warn'/'error') 的失败（如「会话保存失败」）在调试台里是黑箱，
// 排障时什么都看不到。fromConsole 由 console 补丁传 true（原文已 push 过，防重复）。
function logFrontend(level, message, opts) {
    try {
        const text = String(message == null ? '' : message);
        if (!text) return;
        if (!(opts && opts.fromConsole)) debugConsole.push(level, [text]);
        if (!backend || !backend.LogFrontend) return;
        const capped = text.length > 16000 ? text.slice(0, 16000) + '…' : text;
        Promise.resolve(backend.LogFrontend(level, capped)).catch(() => {});
    } catch (e) {}
}

for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
        original(...args);
        // 调试控制台不按开发者模式过滤：打开面板即回放缓冲（含历史）
        debugConsole.push(level, args);
        if ((level === 'log' || level === 'info' || level === 'debug') && !developerMode) return;
        logFrontend(level, args.map(formatLogArg).join(' '), {fromConsole: true});
    };
}

window.addEventListener('error', (event) => {
    const err = event.error;
    const detail = (err && (err.stack || err.message)) || event.message || '未知错误';
    debugConsole.push('error', ['未捕获异常：' + detail]);
    logFrontend('error', '未捕获异常：' + detail, {fromConsole: true});
});
window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const detail = (reason && (reason.stack || reason.message)) || String(reason);
    debugConsole.push('error', ['未处理的 Promise 拒绝：' + detail]);
    logFrontend('error', '未处理的 Promise 拒绝：' + detail, {fromConsole: true});
});

async function refreshDeveloperMode() {
    if (!backend.GetDeveloperMode) return;
    try {
        developerMode = !!(await backend.GetDeveloperMode());
        if (elsSettings.developerMode) elsSettings.developerMode.checked = developerMode;
    } catch (e) {}
    syncDevConsoleVisibility();
}

// 调试控制台入口跟随开发者模式：关闭时隐藏活动栏图标 / 视图菜单 / F12 / 设置按钮
function syncDevConsoleVisibility() {
    if (els.abDebug) els.abDebug.classList.toggle('hidden', !developerMode);
    const btn = document.getElementById('opt-debug-console');
    if (btn) btn.disabled = !developerMode;
    // 关闭开发者模式时若正在看调试控制台，切回终端（没有终端会话则收起面板）
    if (!developerMode && terminalUI.open && getDockView() === 'debug') {
        if (terminalUI.sessions.size) {
            setDockView('terminal');
            applyDockView();
        } else {
            toggleTerminalPanel(false);
        }
    }
}

// ===== 标题栏 logo 加载竞态兜底 =====
// 多窗口/高负载下 /icon.png 偶发加载失败，<img> 失败不重试 → 图标就此永久缺失
// （任务栏图标走 exe 资源不受影响，2026-11-21 用户实测）。失败后重赋 src 重新
// 请求，最多 3 次 600ms 间隔；图片自然加载成功则一个字节都不多花。
(function patchAppLogoRetry() {
    const logo = document.getElementById('app-logo');
    if (!logo) return;
    let tries = 0;
    logo.addEventListener('error', () => {
        if (tries >= 3) return;
        tries++;
        setTimeout(() => {
            const src = logo.getAttribute('src') || '/icon.png';
            logo.removeAttribute('src');
            logo.setAttribute('src', src);
        }, 600);
    });
})();

// AI 浮窗探测（异步尽早开始，与 console/terminal/aux 三类窗口探测并行）：
// bridge-ui 摘除 app-booting 前必须知道本窗口是不是浮窗，原先在那里串行 await
// IsAIFloatWindow 多花一次 IPC 往返；提到顶层并行后四个窗口类型探测同时发出。
const aiFloatWindowMode = (async () => {
    try {
        if (!(backend && backend.IsAIFloatWindow)) return false;
        return !!(await backend.IsAIFloatWindow());
    } catch (e) {
        return false;
    }
})();

// ===== 辅助独立窗（便签 / 会话监控 / 文件对比）=====
// 与终端独立窗口同构（bridge-ui 启动编排按 auxWindowKind 分派到这里）：
// 跳过正常启动流程，全屏渲染单一视图。数据源磁盘/进程内共享——便签走租约
// （多窗口单写者）、监控窗只读镜像（会话归属与回合租约留在原窗口）、对比窗
// 读完即渲。三类窗口都不注册工作区打开者（Go findByWorkspace 只认主窗口）。
const auxWindowKind = (async () => {
    try {
        if (!(backend && backend.GetAuxWindowKind)) return '';
        return String(await backend.GetAuxWindowKind() || '');
    } catch (e) {
        return '';
    }
})();

// 辅助独立窗（便签/监控/对比/查看/预览）的启动编排搬进 shell/aux-window-modes.js（phase4 M1）。
// backend/rt/appEvents/applySettings/baseNameOf 经 getter 活引用注入，避免拍 let 快照。
const auxWindowModes = createAuxWindowModes({
    get backend() { return backend; },
    get rt() { return rt; },
    get appEvents() { return appEvents; },
    get applySettings() { return applySettings; },
    get baseNameOf() { return baseNameOf; },
});

async function refreshLogPath() {
    if (!backend.GetLogPath) return;
    try {
        const path = await backend.GetLogPath();
        if (elsSettings.logPath) {
            elsSettings.logPath.textContent = path ? '日志文件：' + path : '日志文件：—';
        }
    } catch (e) {}
}

const els = {
    filename: document.getElementById('filename'),
    filenameIcon: document.getElementById('filename-icon'),
    filenameText: document.getElementById('filename-text'),
    wsCrumbs: document.getElementById('ws-crumbs'),
    wsProject: document.getElementById('ws-project'),
    wsProjectBadge: document.getElementById('ws-project-badge'),
    wsProjectName: document.getElementById('ws-project-name'),
    wsBranch: document.getElementById('ws-branch'),
    wsBranchName: document.getElementById('ws-branch-name'),
    projectPop: document.getElementById('project-pop'),
    projectPopBody: document.getElementById('project-pop-body'),
    gitBranchPop: document.getElementById('git-branch-pop'),
    gbSearch: document.getElementById('gb-search'),
    gbBody: document.getElementById('gb-body'),
    gbFetch: document.getElementById('gb-fetch'),
    gbPin: document.getElementById('gb-pin'),
    banner: document.getElementById('banner'),
    bannerText: document.getElementById('banner-text'),
    bannerClose: document.getElementById('banner-close'),
    editor: document.getElementById('editor'),
    welcome: document.getElementById('welcome'),
    mainPane: document.getElementById('main-pane'),
    btnWelcomeOpen: document.getElementById('btn-welcome-open'),
    btnWelcomeFolder: document.getElementById('btn-welcome-folder'),
    stMode: document.getElementById('st-mode'),
    stSize: document.getElementById('st-size'),
    stZoom: document.getElementById('st-zoom'),
    stMdWidth: document.getElementById('st-md-width'),
    stAiWidth: document.getElementById('st-ai-width'),
    stCount: document.getElementById('st-count'),
    stWriting: document.getElementById('st-writing'),
    stPos: document.getElementById('st-pos'),
    stEol: document.getElementById('st-eol'),
    stEnc: document.getElementById('st-enc'),
    stMessage: document.getElementById('st-message'),
    stDirty: document.getElementById('st-dirty'),
    breadcrumb: document.getElementById('breadcrumb'),
    findBar: document.getElementById('find-bar'),
    findInput: document.getElementById('find-input'),
    findCase: document.getElementById('find-case'),
    findWord: document.getElementById('find-word'),
    findRegex: document.getElementById('find-regex'),
    findCount: document.getElementById('find-count'),
    findPrev: document.getElementById('find-prev'),
    findNext: document.getElementById('find-next'),
    findClose: document.getElementById('find-close'),
    quickSwitchMask: document.getElementById('quick-switch-mask'),
    quickSwitch: document.getElementById('quick-switch'),
    quickSwitchList: document.getElementById('quick-switch-list'),
    quickSwitchTitle: document.getElementById('quick-switch-title-text'),
    quickSwitchBack: document.getElementById('quick-switch-back'),
    gsMask: document.getElementById('gs-mask'),
    gsPanel: document.getElementById('gs-panel'),
    gsInput: document.getElementById('gs-input'),
    gsList: document.getElementById('gs-list'),
    gsCount: document.getElementById('gs-count'),
    gsRoot: document.getElementById('gs-root'),
    editorArea: document.getElementById('editor-area'),
    sidebar: document.getElementById('sidebar'),
    sbBody: document.getElementById('sb-body'),
    sbTitle: document.getElementById('sb-title'),
    sbRefresh: document.getElementById('sb-refresh'),
    sbReveal: document.getElementById('sb-reveal'),
    paletteMask: document.getElementById('palette-mask'),
    paletteInput: document.getElementById('palette-input'),
    paletteList: document.getElementById('palette-list'),
    sbFilterBtn: document.getElementById('sb-filter-btn'),
    sbFilterRow: document.getElementById('sb-filter-row'),
    sbFilter: document.getElementById('sb-filter'),
    sbModeList: document.getElementById('sb-mode-list'),
    sbModeTree: document.getElementById('sb-mode-tree'),
    structurePanel: document.getElementById('structure-panel'),
    structureBody: document.getElementById('structure-body'),
    structureTitle: document.querySelector('#structure-panel .sb-title'),
    structureSource: document.getElementById('structure-source'),
    structureRefresh: document.getElementById('structure-refresh'),
    structureCollapse: document.getElementById('structure-collapse'),
    structureExport: document.getElementById('structure-export'),
    btnSidebar: document.getElementById('btn-sidebar'),
    lock: document.getElementById('btn-lock'),
    activityBar: document.getElementById('activity-bar'),
    abFiles: document.getElementById('ab-files'),
    abStructure: document.getElementById('ab-structure'),
    abMemo: document.getElementById('ab-memo'),
    abMore: document.getElementById('ab-more'),
    abTerminal: document.getElementById('ab-terminal'),
    tbRun: document.getElementById('tb-run'),
    tbRunConfig: document.getElementById('tb-run-config'),
    tbRunBadge: document.getElementById('tb-run-badge'),
    tbRunName: document.getElementById('tb-run-name'),
    runConfigPop: document.getElementById('run-config-pop'),
    runConfigPopBody: document.getElementById('run-config-pop-body'),
    editorCollapseStrip: document.getElementById('editor-collapse-strip'),
    abDebug: document.getElementById('ab-debug'),
    abGitGraph: document.getElementById('ab-git-graph'),
    abGit: document.getElementById('ab-git'),
    abAi: document.getElementById('ab-ai'),
    abChats: document.getElementById('ab-chats'),
    abAppPages: document.getElementById('ab-app-pages'),
    abDatabase: document.getElementById('ab-database'),
    abMaven: document.getElementById('ab-maven'),
    mavenTree: document.getElementById('maven-tree'),
    mavenFlags: document.getElementById('maven-flags'),
    mavenRefresh: document.getElementById('maven-refresh'),
    mavenGoal: document.getElementById('maven-goal'),
    tbAi: document.getElementById('tb-ai'),
    aiPanel: document.getElementById('ai-panel'),
    termNew: document.getElementById('term-new'),
    termShellMenu: document.getElementById('term-shell-menu'),
    termPanelClose: document.getElementById('term-panel-close'),
    terminalResize: document.getElementById('terminal-resize'),
    sidebarResize: document.getElementById('sidebar-resize'),
    sidebar: document.getElementById('sidebar'),
    terminalPanel: document.getElementById('terminal-panel'),
    gitPanel: document.getElementById('git-panel'),
    gitBranch: document.getElementById('git-branch'),
    gitHint: document.getElementById('git-hint'),
    gitChanges: document.getElementById('git-changes'),
    gitRefresh: document.getElementById('git-refresh'),
    gitMore: document.getElementById('git-more'),
    gitRecentLog: document.getElementById('git-recent-log'),
    gitAmend: document.getElementById('git-amend'),
    gitMessage: document.getElementById('git-message'),
    gitCommitBtn: document.getElementById('git-commit-btn'),
    gitCommitPushBtn: document.getElementById('git-commit-push-btn'),
    gitSplitter: document.getElementById('git-splitter'),
    gitCommitArea: document.getElementById('git-commit-area'),
    abSettings: document.getElementById('ab-settings'),
    abAbout: document.getElementById('ab-about'),
};

let editor = null;
let file = null;
let docs = [];
let docSeq = 0;
let autoSaveTimer = 0;
let explorer = null;
let structurePanel = null;
let structureRefreshTimer = 0;
let structureWorker = null;
let structureWorkerSeq = 0;
let structureWorkerBroken = false;
const structureWorkerPending = new Map();
const structureCache = new Map();
const STRUCTURE_CACHE_LIMIT = 12;
let workspaceFolder = null;
let watchedWorkspaceRoot = '';
let fileClipboard = null;
let ctxMenu = null;
// 主窗口全局菜单的惰性入口：ctxMenu 由 editor-menus 稍后创建（set ctxMenu 回填），
// 创建前的调用方（调试台 / 输入菜单兜底）先注册、右键时才真正 open。
function openCtxMenu(items, x, y, options) {
    if (ctxMenu) ctxMenu.open(items, x, y, options);
}
// 输入面的右键编辑菜单兜底（shell/edit-menu.js，注册一次）：右键落在没人接管的
// 输入框 / 文本域（文件树与 AI 会话的过滤框、设置页与弹窗里的输入面……）时给
// 应用编辑菜单，不再露出 WebView2 原生菜单。
bindEditableContextMenuFallback(openCtxMenu, {get backend() { return backend; }});
let palette = null;
let aiPanel = null;
// AI 群聊域（ai-group-*）：运行时 + 侧栏 + 面板群聊视图 + 成员详情视图；在 initAIPanel 内创建
// （依赖面板薄 API）。openGroupMemberTabHook 在 bridge 工厂解构后回填（TDZ 规避，memo 钩子同款）。
let aiGroupRuntime = null;
let aiGroupSidebar = null;
let aiGroupView = null;
let aiGroupMemberView = null;
let openGroupMemberTabHook = null;
let closedTabs = [];

// 应用操作桥：AI 面板 app_control 工具的执行端（仅当前窗口，语义化动作，不模拟 DOM 事件）。
const APP_SETTING_RULES = {
    autoSave: {type: 'bool'},
    showSidebar: {type: 'bool'},
    alwaysOnTop: {type: 'bool'},
    codeWrap: {type: 'bool'},
    scrollStyle: {type: 'enum', values: ['standard', 'swift', 'brisk', 'off']},
    codeGuides: {type: 'bool'},
    treeGuides: {type: 'bool'},
    treeCounts: {type: 'bool'},
    mdLineNumbers: {type: 'bool'},
    mdScrollSync: {type: 'bool'},
    readOnlyMode: {type: 'bool'},
    fixedKeys: {type: 'bool'},
    treeRefreshInterval: {type: 'enum', values: [0, 1, 2, 3, 5, 10]},
    showCadDir: {type: 'bool'},
    sidebarFont: {type: 'number', min: 10, max: 20},
    editorFont: {type: 'number', min: 10, max: 24},
    editorLineHeight: {type: 'number', min: 1.2, max: 2},
    treeExpandDefault: {type: 'enum', values: ['expand', 'collapse']},
    openMode: {type: 'enum', values: ['tab', 'window']},
    theme: {type: 'theme'},
    codeStyle: {type: 'codeStyle'},
    iconTheme: {type: 'iconTheme'},
    sidebarWidth: {type: 'number', min: 160, max: 500},
    terminalHeight: {type: 'number', min: 120, max: 2000},
    aiPanelWidth: {type: 'number', min: 280, max: 2000},
    // 面板显示形态（aiFloatMode：停靠/全屏/悬浮）与停靠侧（aiPanelSide）**故意不在白名单**：
    // 布局形态只能由用户手动切（面板 [...] 菜单 / 设置页 / 视图菜单），AI 与任何自动化都不得改
    // （2026-11-17 用户硬规则；别为了「顺手」把 aiPanelSide 加回来）。
};

const APP_ACTIONS = [
    'get_state', 'screenshot', 'open_file', 'open_folder', 'activate_tab', 'close_tab', 'reopen_closed_tab', 'move_tab',
    'set_view', 'goto_line', 'list_bookmarks', 'add_bookmark', 'remove_bookmark', 'clear_bookmarks', 'goto_bookmark',
    'toggle_sidebar', 'set_sidebar_view', 'toggle_terminal', 'set_dock_view', 'toggle_ai_panel',
    'split_open', 'split_editor', 'move_tab_to_group', 'focus_editor_group', 'merge_editor_groups',
    'toggle_fullscreen', 'toggle_always_on_top', 'set_theme', 'open_settings', 'set_setting',
    'get_settings_tree', 'set_setting_row',
    'ai_new_session', 'ai_switch_session', 'ai_rename_session', 'flash', 'refresh_explorer', 'reveal_in_explorer',
    'type_text', 'press_key', 'click',
    'open_browser_tab', 'close_browser_tab', 'open_memo_panel', 'get_memo', 'add_memo', 'update_memo', 'remove_memo',
    'get_settings', 'get_editor', 'get_content', 'get_git', 'get_ai', 'get_explorer', 'get_plugins', 'get_terminal', 'get_storage',
    'get_activity', 'get_patch', 'patch_set_root', 'patch_repreview',
    'get_gen_models', 'set_gen_model', 'delete_gen_model',
    'get_lifecycle_hooks', 'add_lifecycle_hook', 'update_lifecycle_hook', 'remove_lifecycle_hook',
    'db_list_connections', 'db_save_connection', 'db_delete_connection', 'db_test_connection',
    // 旧名（pre-command 时代）：保留为静默别名——技能表不再下发，历史会话 / 记忆里的调用仍能命中
    'get_pre_commands', 'add_pre_command', 'update_pre_command', 'remove_pre_command',
    'get_agents', 'create_agent', 'create_group', 'get_groups', 'send_group_message',
    'install_plugin', 'uninstall_plugin',
    'get_mcp_servers', 'list_mcp_samples', 'install_mcp_sample', 'set_mcp_server', 'delete_mcp_server',
    'cognition_toggle',
    // 桌面控制授权：执行体在 AI 面板（需要会话上下文与审批卡通道），这里登记以保持动作对账
    'request_desktop_control',
];

const APP_SCREENSHOT_AREAS = {
    full: {selector: '', label: '整窗'},
    editor: {selector: '#main-pane', label: '编辑区'},
    sidebar: {selector: '#sidebar', label: '侧边栏'},
    ai: {selector: '#ai-panel', label: 'AI 面板'},
    terminal: {selector: '#terminal-panel', label: '终端'},
    patch: {selector: '.jsoneditor-pane.patch-active .patch-view', label: '补丁视图'},
    statusbar: {selector: '#statusbar', label: '状态栏'},
};

function appActionDocInfo(doc) {
    if (!doc) return null;
    return {name: doc.name, path: doc.path || '', mode: doc.mode || '', dirty: !!doc.dirty, format: (doc.format && doc.format.id) || ''};
}

// 标签页 → 应用内视图描述（AI 的 workspace_context 用）。没有 path 的标签页（内嵌浏览器 /
// 快捷便签 / 计划与差异等虚拟文档 / 子代理详情 / 后台终端）不是文件，混进「已打开文件」
// 会被 aiDisplayPath 在范围根之外判成「（范围外）xxx」——模型会以为工作区外还有同名文件
// 可读，用户看到的也是这句没头没尾的标注。返回 null 表示这是真文件（有 path）。
//
// 视图型虚拟标签页（浏览器 / 终端 / 子代理 …）的 kind 与 label 在 core/tab-kinds.js；
// 这里只留文本型虚拟标签页（靠 viewKind 区分）的标签。
const APP_TAB_KIND_LABELS = {
    plan: '计划文档',
    diff: '差异审阅',
    document: '只读文档',
    untitled: '未保存的新文档',
};

function appTabViewOf(doc) {
    if (!doc || doc.path) return null;
    const name = String(doc.name || doc.browserUrl || '').trim();
    // 视图型虚拟标签页：类型名与标签来自 core/tab-kinds.js（单一来源）
    const tabKind = tabKindOf(doc);
    if (tabKind) {
        const base = {kind: tabKind.kind, label: tabKind.label, name};
        // 数据库标签页给 AI 注入比标签标题更丰富的上下文（连接/库/表/类型）。
        // name 已是表名/连接名/键名，desc 不重复它——旧控制台文案会注入成
        // 查询控制台「x」（连接「x」…），同一信息出现两次
        if (doc.dbTableSpec) {
            const t = doc.dbTableSpec;
            return {...base, desc: (t.entry && t.entry.name ? '连接「' + t.entry.name + '」' : '') +
                (t.db && t.db !== 'main' ? '库 ' + t.db + ' 的' : '') +
                (t.kind === 'view' ? '视图 ' : '表 ') + t.table};
        }
        if (doc.dbConsoleSpec) {
            const c = doc.dbConsoleSpec;
            // SQL / Redis 控制台共用此标签：SQL 是默认语义不必注，Redis 的命令方言值得点名
            return c.entry && c.entry.kind === 'redis' ? {...base, desc: 'Redis 命令控制台'} : base;
        }
        if (doc.dbRedisKeySpec) {
            const r = doc.dbRedisKeySpec;
            // 键名不重复（name 已带）；库省略口径与表同：Redis db 0 在创建点已归一为 ''
            return {...base, desc: (r.entry && r.entry.name ? '连接「' + r.entry.name + '」' : '') +
                (r.db ? '库 ' + r.db : '')};
        }
        return base;
    }
    // 文本型虚拟标签页（计划 / 差异 / 只读文档 / 未保存新文档）：靠 viewKind 区分
    const kind = doc.viewKind ? String(doc.viewKind) : 'untitled';
    return {kind, label: APP_TAB_KIND_LABELS[kind] || '标签页', name};
}

function appActionDocCaret(doc) {
    const out = {cursor: null, selection: null};
    if (!doc || doc.binary) return out;
    const lineColAt = (text, offset) => {
        const before = String(text).slice(0, Math.max(0, Math.min(Number(offset) || 0, String(text).length)));
        const lines = before.split('\n');
        return {line: lines.length, column: lines[lines.length - 1].length + 1};
    };
    try {
        const mode = String(doc.mode || '');
        const ace = doc.editor && doc.editor.aceEditor;
        if ((!mode || mode === 'code' || mode === 'split') && ace && ace.getCursorPosition) {
            const pos = ace.getCursorPosition();
            out.cursor = {line: (Number(pos.row) || 0) + 1, column: (Number(pos.column) || 0) + 1};
            if (ace.getSelectionRange && ace.getSelectedText) {
                const sel = ace.getSelectionRange();
                const empty = sel.start.row === sel.end.row && sel.start.column === sel.end.column;
                if (!empty) {
                    const selected = ace.getSelectedText() || '';
                    out.selection = {
                        start: {line: sel.start.row + 1, column: sel.start.column + 1},
                        end: {line: sel.end.row + 1, column: sel.end.column + 1},
                        chars: selected.length,
                        preview: selected.slice(0, 300),
                    };
                }
            }
            if (ace.renderer && ace.renderer.getFirstVisibleRow && ace.session && ace.session.screenToDocumentRow) {
                try {
                    const first = ace.renderer.getFirstVisibleRow();
                    const last = ace.renderer.getLastVisibleRow ? ace.renderer.getLastVisibleRow() : first;
                    out.viewport = {
                        fromLine: (Number(ace.session.screenToDocumentRow(first, 0)) || 0) + 1,
                        toLine: (Number(ace.session.screenToDocumentRow(last, 0)) || 0) + 1,
                    };
                } catch (e) {}
            }
            return out;
        }
        const textarea = doc.pane && doc.pane.querySelector('textarea.jsoneditor-text');
        if ((!mode || mode === 'text') && textarea && typeof textarea.selectionStart === 'number') {
            out.cursor = lineColAt(textarea.value, textarea.selectionEnd);
            if (textarea.selectionEnd > textarea.selectionStart) {
                const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
                out.selection = {
                    start: lineColAt(textarea.value, textarea.selectionStart),
                    end: lineColAt(textarea.value, textarea.selectionEnd),
                    chars: selected.length,
                    preview: selected.slice(0, 300),
                };
            }
        }
    } catch (e) {}
    return out;
}

function appActionResolveDoc(ref) {
    if (ref == null || ref === '') return file;
    if (typeof ref === 'number' && Number.isFinite(ref)) {
        const idx = ref < 0 ? docs.length + ref : ref;
        return docs[idx] || null;
    }
    const text = String(ref).trim();
    if (!text || text.toLowerCase() === 'active') return file;
    if (/^\d+$/.test(text)) return docs[Number(text)] || null;
    return findDocByPath(text);
}

// click 动作的 DOM 合成：按真实顺序派发 pointer/mouse 事件（不移动系统鼠标）。
// 合成事件 isTrusted=false、不带用户激活——依赖真实点击校验的行为可能无响应（技能表已注明）。
function appActionDispatchClick(el, x, y) {
    const Pointer = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    const screenX = (Number(window.screenX) || 0) + x;
    const screenY = (Number(window.screenY) || 0) + y;
    const base = {bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX, screenY};
    const pointer = (type, extra) => new Pointer(type, {...base, button: 0, buttons: 0, detail: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...extra});
    const mouse = (type, extra) => new MouseEvent(type, {...base, button: 0, buttons: 0, detail: 0, ...extra});
    el.dispatchEvent(pointer('pointerover'));
    el.dispatchEvent(mouse('mouseover'));
    el.dispatchEvent(pointer('pointerenter', {bubbles: false}));
    el.dispatchEvent(mouse('mouseenter', {bubbles: false}));
    el.dispatchEvent(pointer('pointermove'));
    el.dispatchEvent(mouse('mousemove'));
    el.dispatchEvent(pointer('pointerdown', {buttons: 1, detail: 1}));
    el.dispatchEvent(mouse('mousedown', {buttons: 1, detail: 1}));
    // 真实点击在 mousedown 后聚焦可聚焦目标；合成事件不会自动聚焦，手动补上
    try {
        if (el instanceof HTMLElement && el.tabIndex >= 0) el.focus({preventScroll: true});
    } catch (e) {}
    el.dispatchEvent(pointer('pointerup', {buttons: 0, detail: 1}));
    el.dispatchEvent(mouse('mouseup', {buttons: 0, detail: 1}));
    el.dispatchEvent(mouse('click', {buttons: 0, detail: 1}));
}

// press_key 的按键合成：修饰键先按下（带自己与已按修饰键的 flag）→ 主键 down/up →
// 修饰键逆序抬起。应用全局快捷键按 e.code 匹配（comboFromEvent），故 code 必须是物理键位。
function appActionDispatchKey(target, spec) {
    const flags = {ctrlKey: false, altKey: false, shiftKey: false, metaKey: false};
    const pressed = [];
    const modifierKeys = [
        ['ctrl', 'Control', 'ControlLeft'],
        ['alt', 'Alt', 'AltLeft'],
        ['shift', 'Shift', 'ShiftLeft'],
        ['meta', 'Meta', 'MetaLeft'],
    ];
    for (const [flag, key, code] of modifierKeys) {
        if (!spec.modifiers[flag]) continue;
        flags[flag + 'Key'] = true;
        target.dispatchEvent(new KeyboardEvent('keydown', {key, code, bubbles: true, cancelable: true, ...flags}));
        pressed.push([flag, key, code]);
    }
    target.dispatchEvent(new KeyboardEvent('keydown', {key: spec.key, code: spec.code, bubbles: true, cancelable: true, ...flags}));
    target.dispatchEvent(new KeyboardEvent('keyup', {key: spec.key, code: spec.code, bubbles: true, cancelable: true, ...flags}));
    for (let i = pressed.length - 1; i >= 0; i--) {
        const [flag, key, code] = pressed[i];
        flags[flag + 'Key'] = false;
        target.dispatchEvent(new KeyboardEvent('keyup', {key, code, bubbles: true, cancelable: true, ...flags}));
    }
}

function appActionDescribeNode(el) {
    if (!el) return null;
    let cls = '';
    try {
        cls = typeof el.className === 'string' ? el.className : ((el.getAttribute && el.getAttribute('class')) || '');
    } catch (e) {}
    const text = String(el.innerText || el.value || (el.getAttribute && el.getAttribute('aria-label')) || '')
        .replace(/\s+/g, ' ').trim().slice(0, 80);
    return {tag: String(el.tagName || '').toLowerCase(), id: el.id || '', cls: cls.slice(0, 120), text};
}

function appActionEditableTarget(selector, allowNonEditable) {
    let el = null;
    if (selector) {
        try {
            el = document.querySelector(String(selector));
        } catch (e) {
            return null;
        }
    } else {
        el = document.activeElement;
    }
    if (!el || el === document.body) return allowNonEditable ? (el || document.body) : null;
    const editable = el.matches && (el.matches('input, textarea') || el.isContentEditable);
    if (!editable && !allowNonEditable) return null;
    return el;
}

// 文档当前文本（含未保存修改）：编辑器在树/代码模式下 getText 会按当前设置序列化
function appActionDocText(doc) {
    if (!doc || doc.binary) return '';
    try {
        if (doc.editor && typeof doc.editor.getText === 'function') return String(doc.editor.getText() || '');
    } catch (e) {}
    return String(doc.content || '');
}

function appActionTermTail(term, maxLines) {
    const buf = term && term.buffer && term.buffer.active;
    if (!buf) return '';
    const end = Number(buf.length) || 0;
    const start = Math.max(0, end - maxLines);
    const lines = [];
    for (let i = start; i < end; i++) {
        const line = buf.getLine(i);
        lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n');
}

// —— AI 智能体（app_control get_agents / create_agent）——
// 智能体配置的真源在 AI 面板（ai-config.json 的 agents[]，经 panel 的 aiGroupApi 读写）；
// 这里只做参数整理与快照整形，校验/去重/编号全走 ai-agent-model 的纯函数。
function appActionAIConfig() {
    if (!aiPanel || !aiPanel.aiGroupApi) throw new Error('AI 面板未初始化');
    return aiPanel.aiGroupApi.getConfig();
}

function appActionAgentSnapshot() {
    const config = appActionAIConfig();
    const options = listModelOptions(config.profiles);
    const labelByRef = new Map(options.map((option) => [option.ref, option.label]));
    const agents = (config.agents || []).map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        group: agent.group,
        modelRef: agent.modelRef,
        model: labelByRef.get(agent.modelRef) || '模型不可用',
        style: agent.replyStyle,
        chair: !!agent.chair,
        slowTier: !!agent.slowTier,
        enabled: agent.enabled !== false,
    }));
    return {agents, models: options.map((option) => ({ref: option.ref, label: option.label}))};
}

// 相对路径按工作区根解析（app_control 的文件/目录类动作共用）。
function appActionWorkspacePath(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return '';
    // 绝对路径：盘符 / UNC / POSIX 根 / 带 scheme 的地址（mock、file、http 等）
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text) || /^[a-zA-Z]:[\\/]/.test(text) ||
        text.startsWith('\\\\') || text.startsWith('/')) {
        return text;
    }
    if (!workspaceFolder) return text;
    return workspaceFolder.replace(/[\\/]+$/, '') + '\\' + text.replace(/^[\\/]+/, '');
}

// 群聊摘要（get_groups / send_group_message 共用）：成员名按当前智能体配置解析。
function appActionGroupBrief(meta) {
    const agents = (appActionAIConfig().agents || []);
    const members = (meta.memberIds || []).map((id) => {
        const agent = agents.find((item) => item && item.id === id);
        return agent ? agent.name : '已删除成员';
    });
    return {
        id: meta.id,
        title: meta.title || '未命名群聊',
        mode: meta.mode,
        goal: meta.goal,
        chair: meta.chair ? {kind: meta.chair.kind, agentId: meta.chair.agentId || ''} : null,
        members,
        messageCount: meta.messageCount || 0,
        updatedAt: meta.updatedAt || 0,
        minutes: meta.minutes && meta.minutes.text
            ? {createdAt: Number(meta.minutes.createdAt) || 0, chars: String(meta.minutes.text).length, source: meta.minutes.source || ''}
            : null,
    };
}

// 群聊定位：id 精确 → 标题精确（大小写不敏感）；多命中要求用 id。
function appActionResolveGroup(query) {
    if (!aiGroupRuntime) throw new Error('群聊运行时未初始化');
    const key = String(query == null ? '' : query).trim();
    if (!key) throw new Error('需要群聊 id 或标题');
    const groups = aiGroupRuntime.groupList() || [];
    const byId = groups.find((meta) => meta.id === key);
    if (byId) return byId;
    const exact = groups.filter((meta) => String(meta.title || '').toLowerCase() === key.toLowerCase());
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
        throw new Error('群聊标题有多个匹配：' + exact.map((meta) => meta.id).join(' / ') + '；请改用 id');
    }
    throw new Error('找不到群聊「' + key + '」；现有：' +
        (groups.map((meta) => (meta.title || '未命名') + '（' + meta.id + '）').join('、') || '（暂无群聊，先用 create_group 创建）'));
}

// 按名字在官方插件市场解析安装地址；多命中/未命中都报候选。
async function appActionInstallUrlFromName(name) {
    if (typeof backend.GetPluginMarket !== 'function') throw new Error('当前版本不支持插件市场');
    const list = (await backend.GetPluginMarket()) || [];
    const key = String(name || '').trim().toLowerCase();
    const nameOf = (item) => [item && item.name, item && item.id, item && (item.repo || '').split('/').pop()]
        .filter(Boolean).map((value) => String(value).toLowerCase());
    const hits = list.filter((item) => nameOf(item).includes(key));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
        throw new Error('插件名有多个匹配：' + hits.map((item) => item.name + '（' + item.url + '）').join('；') + '；请改用 url 明确');
    }
    throw new Error('官方市场里没有插件「' + name + '」；可用：' +
        (list.slice(0, 30).map((item) => item.name).join('、') || '（市场为空或拉取失败）'));
}

async function runAppAction(action, params, scope, callerSessionId, requestActionApproval) {
    const actionScope = scope || 'full';
    const p = params || {};
    switch (String(action || '').trim()) {
        case 'get_state': {
            const aiOpen = !!(aiPanel && aiPanel.isOpen && aiPanel.isOpen());
            return {
                workspace: workspaceFolder || null,
                activeFile: appActionDocInfo(file),
                tabs: docs.map((doc, index) => ({index, ...appActionDocInfo(doc), active: doc === file})),
                editorGroups: editorGroupsMod.groupSnapshot(),
                closedTabsCount: closedTabs.length,
                sidebar: {visible: !!settings.showSidebar, view: currentSidebarView()},
                terminal: {open: !!(terminalUI && terminalUI.open), view: getDockView()},
                aiPanel: {
                    open: aiOpen,
                    mode: aiPanel && aiPanel.getMode ? aiPanel.getMode() : '',
                    // 透传调用者会话 id：列表里 caller=true 的是调用者自己，active=true 只是面板当前查看的会话
                    sessions: aiPanel && aiPanel.bridgeListSessions ? aiPanel.bridgeListSessions(callerSessionId) : [],
                },
                theme: settings.theme,
                codeStyle: settings.codeStyle || CODE_STYLE_AUTO,
                iconTheme: settings.iconTheme || 'opensource',
                fullscreen: !!rtFullscreen,
                alwaysOnTop: !!settings.alwaysOnTop,
                readOnlyMode: !!settings.readOnlyMode,
                // click 坐标口径：可视区是 CSS 像素，截图是物理像素（÷ dpr）
                viewport: {width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1},
            };
        }
        case 'get_settings': {
            const all = JSON.parse(JSON.stringify(settings));
            const keys = Array.isArray(p.keys) ? p.keys.map((key) => String(key)) : null;
            if (!keys) return {values: all, writableKeys: Object.keys(APP_SETTING_RULES)};
            const values = {};
            const missing = [];
            for (const key of keys) {
                if (Object.prototype.hasOwnProperty.call(all, key)) values[key] = all[key];
                else missing.push(key);
            }
            return {values, missing, writableKeys: Object.keys(APP_SETTING_RULES)};
        }
        case 'get_editor': {
            const doc = appActionResolveDoc(p.target);
            if (!doc) throw new Error('找不到文档：' + (p.target == null ? 'active' : p.target));
            const text = appActionDocText(doc);
            const detail = {
                ...appActionDocInfo(doc),
                path: doc.path || '',
                active: doc === file,
                enc: doc.enc || '',
                eol: doc.eol || '',
                hasBom: !!doc.hasBom,
                size: Number(doc.size) || 0,
                large: !!doc.large,
                binary: !!doc.binary,
                image: !!doc.image,
                untitled: !!doc.untitled,
                treeAvailable: !!doc.treeAvailable,
                parseError: doc.parseError ? String((doc.parseError && doc.parseError.message) || doc.parseError) : '',
                readOnly: isDocReadOnly(doc, settings),
                tabReadOnly: isTabReadOnlyLocked(doc),
                tabReadOnlyFixed: isTabReadOnlyFixed(doc),
                lines: doc.binary ? 0 : (text ? text.split('\n').length : 0),
                chars: doc.binary ? 0 : text.length,
                cursor: null,
                selection: null,
            };
            const caret = appActionDocCaret(doc);
            detail.cursor = caret.cursor;
            detail.selection = caret.selection;
            detail.viewport = caret.viewport || null;
            return detail;
        }
        case 'get_content': {
            const doc = appActionResolveDoc(p.target);
            if (!doc) throw new Error('找不到文档：' + (p.target == null ? 'active' : p.target));
            if (doc.binary) throw new Error('二进制/图片文档没有文本内容；可改用 read_file 读取磁盘文件');
            const text = appActionDocText(doc);
            const allLines = text.split('\n');
            const startLine = Math.max(1, Math.round(Number(p.startLine) || 1));
            const endLine = p.endLine != null && p.endLine !== '' ? Math.max(startLine, Math.round(Number(p.endLine))) : 0;
            const maxChars = Math.max(1000, Math.min(60000, Math.round(Number(p.maxChars) || 20000)));
            let content = endLine ? allLines.slice(startLine - 1, endLine).join('\n') : text;
            let truncated = endLine ? endLine < allLines.length : text.length > maxChars;
            if (content.length > maxChars) {
                content = content.slice(0, maxChars);
                truncated = true;
            }
            return {
                name: doc.name,
                path: doc.path || '',
                dirty: !!doc.dirty,
                totalLines: allLines.length,
                totalChars: text.length,
                startLine,
                endLine: endLine || undefined,
                truncated,
                content,
            };
        }
        case 'get_git': {
            const changes = [];
            for (const [path, state] of gitStateCache.map) changes.push({path, state});
            changes.sort((a, b) => a.path.localeCompare(b.path));
            const counts = {};
            for (const change of changes) counts[change.state] = (counts[change.state] || 0) + 1;
            const activeKey = file && file.path ? String(file.path).replace(/\\/g, '/') : '';
            return {
                available: !!(gitStateCache.available && gitStateCache.dir),
                dir: gitStateCache.dir || '',
                branch: gitStateCache.branch || '',
                reason: gitStateCache.reason || '',
                counts,
                total: changes.length,
                changes: changes.slice(0, 300),
                truncated: changes.length > 300,
                activeFileState: activeKey ? (gitStateCache.map.get(activeKey) || '') : '',
            };
        }
        case 'get_ai': {
            if (!aiPanel) throw new Error('AI 面板未初始化');
            // 透传调用者会话 id：bridgeGetState 据此区分「调用者自己」与「面板查看的会话」。
            if (aiPanel.bridgeGetState) return aiPanel.bridgeGetState(callerSessionId);
            return {open: !!(aiPanel.isOpen && aiPanel.isOpen()), mode: aiPanel.getMode ? aiPanel.getMode() : ''};
        }
        case 'get_explorer': {
            const selection = explorer && explorer.getSelection ? explorer.getSelection() : [];
            return {
                visible: !!settings.showSidebar,
                view: currentSidebarView(),
                mode: explorer && explorer.getMode ? explorer.getMode() : '',
                root: (explorer && explorer.getRoot ? explorer.getRoot() : '') || '',
                selectionCount: selection.length,
                selection: selection.slice(0, 50).map((item) => ({path: item.path, name: item.name, isDir: !!item.isDir})),
            };
        }
        case 'get_plugins': {
            let list;
            try {
                list = await backend.GetPlugins();
            } catch (e) {
                throw new Error('读取插件失败：' + ((e && e.message) || e));
            }
            const plugins = (Array.isArray(list) ? list : []).map((plugin) => ({
                id: plugin.id,
                name: plugin.name,
                version: plugin.version || '',
                author: plugin.author || '',
                description: plugin.description || '',
                enabled: plugin.enabled !== false,
                extensions: Array.isArray(plugin.extensions) ? plugin.extensions : [],
            }));
            return {count: plugins.length, plugins};
        }
        case 'get_terminal': {
            const lines = Math.max(1, Math.min(200, Math.round(Number(p.lines) || 40)));
            const sessions = [];
            for (const session of terminalUI.sessions.values()) {
                sessions.push({
                    id: session.id,
                    label: session.customName || session.defaultLabel || session.baseName || '',
                    shell: session.shell || '',
                    active: session.id === terminalUI.activeId,
                });
            }
            const target = p.id ? terminalUI.sessions.get(String(p.id)) : (terminalUI.sessions.get(terminalUI.activeId) || null);
            return {
                open: !!(terminalUI && terminalUI.open),
                activeId: terminalUI.activeId || '',
                sessions,
                tailSessionId: target ? target.id : '',
                tail: target ? appActionTermTail(target.term, lines) : '',
            };
        }
        case 'get_storage': {
            // 只读占用统计（设置 → 存储与清理 同一份 StorageScan）；清理仍由用户操作
            if (typeof backend.StorageScan !== 'function') throw new Error('当前版本不支持存储扫描');
            const report = (await backend.StorageScan(workspaceFolder || '')) || {};
            const items = (report.items || [])
                .filter((item) => item && item.exists)
                .map((item) => ({
                    id: item.id,
                    label: item.label,
                    kind: item.kind,
                    scope: item.scope,
                    bytes: Number(item.bytes) || 0,
                    files: Number(item.files) || 0,
                    entries: Number(item.entries) || 0,
                    approx: !!item.approx,
                    note: item.note || '',
                }))
                .sort((a, b) => b.bytes - a.bytes);
            return {
                tiles: report.tiles || [],
                cacheBytes: Number(report.cacheBytes) || 0,
                dataBytes: Number(report.dataBytes) || 0,
                truncated: !!report.truncated,
                pending: report.pending || [],
                scannedAt: Number(report.scannedAt) || 0,
                items: items.slice(0, 120),
                note: '只读统计；清除缓存 / 送回收站 / 自动清理参数仍由用户在 设置 → 存储与清理 操作',
            };
        }
        case 'open_file': {
            const target = String(p.path || '').trim();
            if (!target) throw new Error('open_file 需要 path');
            await openPathsHere([target], {readOnly: !!p.readOnly});
            const doc = findDocByPath(target);
            if (!doc) throw new Error('打开失败或文件不存在：' + target);
            return {opened: appActionDocInfo(doc), tabs: docs.length};
        }
        case 'open_folder': {
            const dir = String(p.dir || '').trim();
            if (!dir) throw new Error('open_folder 需要 dir');
            openFolderWorkspace(dir);
            return {workspace: workspaceFolder || dir};
        }
        case 'activate_tab': {
            const doc = appActionResolveDoc(p.index != null ? p.index : p.path);
            if (!doc) throw new Error('找不到标签：' + (p.index != null ? p.index : p.path));
            await activateDoc(doc);
            return {active: appActionDocInfo(file)};
        }
        case 'close_tab': {
            const target = p.target == null ? 'active' : p.target;
            if (target === 'all') {
                closeDocsWithConfirm(docs.slice(), '关闭全部标签页？未保存的修改将丢弃。');
                return {closing: 'all', count: docs.length};
            }
            if (target === 'unmodified') {
                const list = docs.filter((doc) => !doc.dirty);
                closeDocsWithConfirm(list.slice(), '关闭全部未修改标签页？');
                return {closing: 'unmodified', count: list.length};
            }
            const doc = appActionResolveDoc(target);
            if (!doc) throw new Error('找不到标签：' + target);
            const info = appActionDocInfo(doc);
            requestCloseDoc(doc);
            return {closing: info, note: info.dirty ? '该标签有未保存修改，已弹出确认框等待用户选择' : '已关闭'};
        }
        case 'reopen_closed_tab': {
            reopenClosedTab();
            return {active: appActionDocInfo(file)};
        }
        case 'move_tab': {
            const src = appActionResolveDoc(p.source);
            const dst = appActionResolveDoc(p.target);
            if (!src || !dst) throw new Error('move_tab 需要 source 与 target（索引或路径）');
            if (src === dst) throw new Error('source 与 target 是同一标签');
            const group = groupOfDoc(src.id);
            if (!group || !group.docIds.includes(dst.id)) throw new Error('两个标签不在同一分栏，无法移动');
            moveTabInGroup(group.id, src.id, dst.id, p.before !== false);
            return {order: groupDocs(group).map((doc) => doc.name)};
        }
        // —— 编辑器分组（完整分组操作）：索引 0 起或分组 id（g12）都能定位 ——
        case 'split_open': {
            // 两个文件左右（或上下）并排：先都开在当前组，再把右侧标签拆到新组
            const rawPaths = Array.isArray(p.paths) ? p.paths : [p.left, p.right];
            const paths = rawPaths.map((item) => appActionWorkspacePath(item)).filter(Boolean);
            if (paths.length !== 2) throw new Error('split_open 需要 paths: [左文件, 右文件]（或 left / right）');
            if (paths[0].replace(/\\/g, '/').toLowerCase() === paths[1].replace(/\\/g, '/').toLowerCase()) {
                throw new Error('两个路径相同');
            }
            if (!workspaceFolder) throw new Error('没有打开工作区');
            await openPathsHere(paths, {});
            const leftDoc = findDocByPath(paths[0]);
            const rightDoc = findDocByPath(paths[1]);
            if (!leftDoc || !rightDoc) {
                throw new Error('文件未全部打开（检查路径是否存在）：' + paths.filter((path) => !findDocByPath(path)).join(' / '));
            }
            // 已经分属不同分组：无需再拆，直接报现状
            const leftGroup = editorGroupsMod.groupOfDoc(leftDoc.id);
            const rightGroup = editorGroupsMod.groupOfDoc(rightDoc.id);
            if (leftGroup && rightGroup && leftGroup.id !== rightGroup.id) {
                return {split: {ok: true, already: true}, groups: editorGroupsMod.groupSnapshot()};
            }
            const result = editorGroupsMod.splitDocToGroup(rightDoc.id, p.side || 'right');
            if (!result.ok) throw new Error(result.error || '拆分失败');
            return {split: result, groups: editorGroupsMod.groupSnapshot()};
        }
        case 'split_editor': {
            const doc = appActionResolveDoc(p.target);
            if (!doc) throw new Error('找不到要拆分的标签：' + (p.target == null ? 'active' : p.target));
            const result = editorGroupsMod.splitDocToGroup(doc.id, p.side || 'right');
            if (!result.ok) throw new Error(result.error || '拆分失败');
            return {split: result, groups: editorGroupsMod.groupSnapshot()};
        }
        case 'move_tab_to_group': {
            const doc = appActionResolveDoc(p.target);
            if (!doc) throw new Error('找不到标签：' + (p.target == null ? 'active' : p.target));
            if (p.group == null || p.group === '') throw new Error('move_tab_to_group 需要 group（索引或分组 id，见 get_state 的 editorGroups）');
            const result = editorGroupsMod.moveDocToGroup(doc.id, p.group);
            if (!result.ok) throw new Error(result.error || '移动失败');
            return {moved: result.group, groups: editorGroupsMod.groupSnapshot()};
        }
        case 'focus_editor_group': {
            if (p.group == null || p.group === '') throw new Error('focus_editor_group 需要 group（索引或分组 id）');
            const result = editorGroupsMod.focusEditorGroup(p.group);
            if (!result.ok) throw new Error(result.error || '切换失败');
            return {focused: {index: result.index, id: result.id}, groups: editorGroupsMod.groupSnapshot()};
        }
        case 'merge_editor_groups': {
            const result = editorGroupsMod.mergeEditorGroup(p.group, p.into);
            if (!result.ok) throw new Error(result.error || '合并失败');
            return {merged: result.group, groups: editorGroupsMod.groupSnapshot()};
        }
        case 'set_view': {
            const mode = String(p.mode || '').trim();
            if (!mode) throw new Error('set_view 需要 mode');
            if (!file || !editor) throw new Error('当前没有打开的文件');
            switchMode(mode);
            return {activeFile: appActionDocInfo(file), mode: file.mode || currentMode};
        }
        case 'goto_line': {
            const line = Math.round(Number(p.line));
            if (!line || line < 1) throw new Error('goto_line 需要正整数 line');
            if (!file) throw new Error('当前没有打开的文件');
            if (file.binary) throw new Error('当前文档是二进制或图片文件，没有行号可定位');
            const column = Math.max(0, Math.round(Number(p.column) || 0));
            const landed = await selectLineInDoc(file, line, column);
            if (!landed) throw new Error('当前文档不支持按行定位（该视图没有行号）');
            const result = {file: file.name, line: landed.line, column: landed.column};
            if (landed.clamped) {
                result.requestedLine = landed.requestedLine;
                if (landed.requestedColumn && landed.requestedColumn !== landed.column) {
                    result.requestedColumn = landed.requestedColumn;
                }
                result.note = '请求位置超出范围（共 ' + landed.lineCount + ' 行），已定位到第 ' + landed.line + ' 行';
            }
            return result;
        }
        // ===== 书签（跨文件行书签；执行体拆到 editor/bookmark-actions.js，phase4 M2）=====
        case 'list_bookmarks': {
            return bookmarkActions.listBookmarks();
        }
        case 'add_bookmark': {
            return bookmarkActions.addBookmark(p);
        }
        case 'remove_bookmark': {
            return bookmarkActions.removeBookmark(p);
        }
        case 'clear_bookmarks': {
            return bookmarkActions.clearBookmarks(p);
        }
        case 'goto_bookmark': {
            return bookmarkActions.gotoBookmark(p);
        }
        case 'toggle_sidebar': {
            toggleSidebarView(['files', 'git', 'structure', 'chats'].includes(p.view) ? p.view : settings.sidebarView || 'files');
            return {sidebar: {visible: !!settings.showSidebar, view: currentSidebarView()}};
        }
        case 'set_sidebar_view': {
            if (!['files', 'git', 'structure'].includes(p.view)) throw new Error('set_sidebar_view 需要 view = files / git / structure');
            switchSidebarView(p.view);
            if (!settings.showSidebar) {
                settings.showSidebar = true;
                applySettings();
            }
            return {sidebar: {visible: !!settings.showSidebar, view: currentSidebarView()}};
        }
        case 'toggle_terminal': {
            toggleDockView('terminal');
            return {terminal: {open: !!(terminalUI && terminalUI.open), view: getDockView()}};
        }
        case 'set_dock_view': {
            // 底部面板切换内容（terminal / debug / run / graph）；面板收起时一并打开
            const view = String(p.view || '').trim().toLowerCase();
            if (!['terminal', 'debug', 'run', 'graph'].includes(view)) {
                throw new Error('view 只能是 terminal / debug / run / graph');
            }
            setDockView(view);
            applyDockView();
            if (terminalUI && !terminalUI.open) toggleTerminalPanel(true);
            return {terminal: {open: !!(terminalUI && terminalUI.open), view: getDockView()}};
        }
        case 'open_browser_tab': {
            const doc = openBrowserTab(p.url || 'about:blank', p.profileKey || '');
            // 必须等 Go 侧 WebView2 创建完成再返回：否则 AI 拿到 id 立刻 BrowserNavigate，
            // 两个绑定调用在 Go 侧并发排队，导航先到就报「浏览器标签页不存在或未就绪」，
            // 模型只能重试一次，白烧一轮工具调用（2026-11-16）。失败会原样抛出。
            if (doc && doc.browserOpenPromise) await doc.browserOpenPromise;
            return {browserTab: {id: doc.id, name: doc.name, url: doc.browserUrl}};
        }
        case 'close_browser_tab': {
            const target = docs.find((d) => d.browser && (d.id === p.id || d.name === p.name || d.browserUrl === p.url));
            if (!target) throw new Error('未找到浏览器标签页');
            closeDocNow(target, false);
            return {closed: true};
        }
        // ===== 快捷便签（数据与变更通路在 bridge-memo-view 的 memoApi，AI 与界面同源）=====
        case 'open_memo_panel': {
            return {opened: true, message: memoApi.open(p.scope)};
        }
        case 'get_memo': {
            // 返回紧凑文本清单（含条目/块 id），模型后续 update/remove 直接引用；
            // 可选过滤：block_id（某分组）/ tag（某标签）/ q（文本包含）
            const filter = {};
            if (p.block_id != null) filter.blockId = String(p.block_id);
            if (p.tag != null && String(p.tag).trim() !== '') filter.tag = String(p.tag).trim();
            if (p.q != null && String(p.q).trim() !== '') filter.q = String(p.q);
            return {scope: p.scope === 'global' ? 'global' : 'workspace', text: await memoApi.list(p.scope, filter)};
        }
        case 'add_memo': {
            const tags = Array.isArray(p.tags) ? p.tags.map((t) => String(t)) : undefined;
            return {result: await memoApi.add(p.scope, p.kind, p.block_id, String(p.text == null ? '' : p.text), tags)};
        }
        case 'update_memo': {
            const patch = {};
            if (p.text != null) patch.text = String(p.text);
            if (p.kind != null) patch.kind = String(p.kind);
            if (Array.isArray(p.tags)) patch.tags = p.tags.map((t) => String(t));
            if (p.index != null) patch.index = Number(p.index);
            return {result: await memoApi.update(p.scope, String(p.id == null ? '' : p.id), patch)};
        }
        case 'remove_memo': {
            return {result: await memoApi.remove(p.scope, String(p.id == null ? '' : p.id))};
        }
        case 'toggle_ai_panel': {
            if (!aiPanel) throw new Error('AI 面板未初始化');
            if (p.open == null) aiPanel.toggle();
            else aiPanel.open(!!p.open);
            return {aiPanel: {open: !!(aiPanel.isOpen && aiPanel.isOpen())}};
        }
        case 'toggle_fullscreen': {
            await toggleFullscreen();
            return {fullscreen: !!rtFullscreen};
        }
        case 'toggle_always_on_top': {
            toggleAlwaysOnTop();
            return {alwaysOnTop: !!settings.alwaysOnTop};
        }
        case 'set_theme': {
            if (!p.theme) throw new Error('set_theme 需要 theme');
            setTheme(String(p.theme));
            return {theme: settings.theme};
        }
        case 'open_settings': {
            const pane = String(p.pane || 'general').trim() || 'general';
            const rowId = String(p.row || '').trim();
            if (rowId) {
                const row = findSettingsRow(rowId);
                if (!row) throw new Error('找不到设置行 id：' + rowId + '（先用 get_settings_tree 取 id）');
                openSettingsAtRow(row.pane, row.rowEl || row.control);
                return {opened: row.pane, row: row.id, title: row.title};
            }
            openSettings(pane);
            return {opened: true, pane};
        }
        case 'set_setting': {
            const key = String(p.key || '').trim();
            const rule = APP_SETTING_RULES[key];
            if (!rule) {
                throw new Error('不支持设置「' + key + '」。可写键：' + Object.keys(APP_SETTING_RULES).join(', '));
            }
            let value = p.value;
            if (rule.type === 'bool') {
                value = !!value;
            } else if (rule.type === 'number') {
                value = Math.round(Number(value));
                if (!Number.isFinite(value) || value < rule.min || value > rule.max) {
                    throw new Error(key + ' 需要数字 ' + rule.min + '–' + rule.max);
                }
            } else if (rule.type === 'enum') {
                const num = Number(value);
                const match = rule.values.some((v) => v === value) || (typeof value === 'string' && value !== '' && rule.values.includes(num));
                if (!match) throw new Error(key + ' 仅支持：' + rule.values.join(' / '));
                value = typeof rule.values[0] === 'number' ? num : value;
            } else if (rule.type === 'theme') {
                value = String(value || '').trim();
                if (!themeRegistry.hasUiTheme(value)) {
                    throw new Error('theme 仅支持：' + themeRegistry.listUiThemes().map((theme) => theme.id).join(' / '));
                }
            } else if (rule.type === 'codeStyle') {
                value = String(value || CODE_STYLE_AUTO);
                if (!themeRegistry.hasCodeTheme(value) && value !== CODE_STYLE_AUTO) {
                    throw new Error('codeStyle 仅支持：auto / ' + themeRegistry.listCodeThemes().map((style) => style.id).join(' / '));
                }
            } else if (rule.type === 'iconTheme') {
                value = String(value || '').trim();
                if (!themeRegistry.hasIconTheme(value)) {
                    throw new Error('iconTheme 仅支持：' + themeRegistry.listIconThemes().map((theme) => theme.id).join(' / '));
                }
            }
            if (key === 'theme') {
                setTheme(value);
                return {key, value: settings.theme};
            }
            if (key === 'iconTheme') {
                setIconTheme(value);
                return {key, value: settings.iconTheme};
            }
            settings[key] = value;
            applySettings();
            return {key, value: settings[key]};
        }
        // —— 设置树：只读清单 + 按行 id 写入（中/高风险走动作审批；布局形态永久不可写）——
        case 'get_settings_tree': {
            const paneId = String(p.pane || '').trim();
            const tree = buildSettingsTree();
            if (!paneId) {
                return {
                    panes: tree.panes.map((pane) => ({
                        id: pane.id, label: pane.label, group: pane.group, rowCount: pane.rows.length,
                    })),
                    note: '传 pane 查看该页的分组与行（id / 当前值 / 危险度 / 是否可写）',
                };
            }
            const pane = tree.panes.find((item) => item.id === paneId);
            if (!pane) throw new Error('未知设置页「' + paneId + '」；可用：' + tree.panes.map((item) => item.id).join(' / '));
            const groups = [];
            for (const row of pane.rows) {
                let group = groups[groups.length - 1];
                if (!group || group.name !== row.group) {
                    group = {name: row.group, rows: []};
                    groups.push(group);
                }
                group.rows.push(settingsRowSnapshot(row));
            }
            return {pane: {id: pane.id, label: pane.label, group: pane.group}, groups};
        }
        case 'set_setting_row': {
            const row = findSettingsRow(String(p.id || ''));
            if (!row) throw new Error('找不到设置行 id：' + p.id + '（先用 get_settings_tree 取 id）');
            if (row.protected) throw new Error('该设置行只能由用户手动修改：' + row.title);
            if (!row.settable) throw new Error('该设置行不可由 AI 写入：' + row.title + '（' + row.kind + '）');
            const coerced = coerceSettingsValue(row.kind, row.control, p.value);
            if (!coerced.ok) throw new Error(coerced.error);
            const oldValue = describeSettingsValue(row.kind, row.control);
            const newValue = describeSettingsInput(row.kind, row.control, coerced.value);
            if (row.risk !== 'low') {
                if (typeof requestActionApproval !== 'function') {
                    throw new Error('该设置属于中/高风险，需要用户在界面审批；当前调用没有审批通道，拒绝执行');
                }
                const answer = await requestActionApproval({
                    action: 'set_setting',
                    title: '修改设置：' + row.title,
                    target: (row.paneLabel || row.pane) + (row.group ? ' / ' + row.group : '') + ' / ' + row.title + '（' + row.id + '）',
                    oldValue,
                    newValue,
                    risk: row.risk,
                    warnings: [row.riskReason].filter(Boolean),
                    source: '设置 → ' + (row.paneLabel || row.pane),
                    locate: {pane: row.pane, row: row.id},
                });
                if (!answer || !answer.approved) return {applied: false, denied: true, note: '用户拒绝了本次设置修改'};
            }
            applySettingsValue(row.kind, row.control, coerced.value);
            return {applied: true, id: row.id, pane: row.pane, title: row.title, oldValue, newValue, risk: row.risk};
        }
        case 'cognition_toggle': {
            // 认知索引启停（可选启用功能，默认关）：**无条件动作审批卡**——对齐生命周期钩子
            // / worktree 的口径，不管什么权限档都弹，用户拍板后才写。设置树里该行登记为
            // protected（settings-tree.js）：AI 的唯一写路径就是这张审批卡；手动开关走设置页。
            const control = document.getElementById('ai-opt-cognition');
            if (!control) throw new Error('当前版本没有认知索引设置项');
            const enabled = p.enabled === undefined ? !control.checked : p.enabled === true;
            const oldValue = control.checked ? '开启' : '关闭';
            const newValue = enabled ? '开启' : '关闭';
            if (typeof requestActionApproval !== 'function') {
                throw new Error('cognition_toggle 需要用户在界面审批；当前调用没有审批通道，拒绝执行');
            }
            const answer = await requestActionApproval({
                action: 'cognition_toggle',
                title: (enabled ? '启用' : '关闭') + ' AI 认知索引',
                target: '设置 → AI → 上下文与记忆 / 认知索引（ai-opt-cognition）',
                oldValue,
                newValue,
                risk: 'medium',
                warnings: enabled
                    ? ['启用后 AI 会话每会话注入一份路径地图（≤1–2K token，只注一次），并在改动代码后被期待维护 .cadt/cognition/ 认知卷；可选启用功能，工作区本地纯文本，可随时关闭或删除']
                    : ['关闭后 AI 不再注入认知索引、不再维护认知卷；已写的 .cadt/cognition/ 保留在工作区（可在 设置 → 存储与清理 清除）'],
                source: 'app_control · cognition_toggle',
                locate: {pane: 'ai', row: 'ai-opt-cognition'},
            });
            if (!answer || !answer.approved) return {applied: false, denied: true, note: '用户拒绝了本次认知索引' + (enabled ? '启用' : '关闭')};
            applySettingsValue('switch', control, enabled);
            return {applied: true, enabled, oldValue, newValue};
        }
        case 'request_desktop_control': {
            // 会话级桌面控制授权：必须由 AI 面板在会话上下文里执行（要 session + 桌面控制状态 +
            // pendingApprovals 审批通道）。ai-panel 的 app_control 分支已在分发前拦截并处理，
            // 走到这里说明调用来自没有面板的宿主（悬浮窗 / 调试台），确定性拒绝。
            throw new Error('request_desktop_control 只能由 AI 面板在当前会话内发起');
        }
        case 'get_activity': {
            // 操作留痕只读查询：帮用户回忆「刚才做了什么」与排障。
            if (!backend.ActivityRead) throw new Error('当前版本不支持操作记录');
            const query = {
                limit: Math.min(500, Math.max(1, Math.round(Number(p.limit) || 50))),
                sinceTs: Number(p.sinceTs) || 0,
                beforeTs: Number(p.beforeTs) || 0,
                actions: Array.isArray(p.actions) ? p.actions.filter((a) => typeof a === 'string' && a) : [],
                actor: String(p.actor || ''),
                keyword: String(p.keyword || ''),
            };
            let parsed;
            try {
                parsed = JSON.parse(await backend.ActivityRead(JSON.stringify(query)));
            } catch (e) {
                throw new Error('操作记录读取失败：' + ((e && e.message) || e));
            }
            const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
            if (!entries.length) {
                return '最近没有匹配的操作记录（功能开关在 设置 → 操作记录；仅记录操作摘要，不记录内容）';
            }
            const lines = entries.map((entry) => {
                const time = new Date(entry.ts || 0).toLocaleTimeString();
                const target = entry.target ? ' → ' + entry.target : '';
                const detail = entry.detail && Object.keys(entry.detail).length ? ' ' + JSON.stringify(entry.detail) : '';
                return '[' + time + '] ' + (entry.actor || '?') + '/' + (entry.source || '?') + ' ' +
                    (entry.action || '?') + target + detail;
            });
            return lines.join('\n') + (parsed.truncated ? '\n（结果超出上限被截断；可用 limit / sinceTs / keyword 缩小范围）' : '');
        }
        case 'get_patch': {
            const doc = appActionResolveDoc(p.target);
            if (!doc) throw new Error('找不到文档：' + (p.target == null ? 'active' : p.target));
            if (!(doc.format && doc.format.patch)) throw new Error('目标标签不是 .patch / .diff：' + (doc.path || doc.name));
            if (!doc.patchState || !doc.patchState.plan) {
                await refreshPatchView(doc, patchViewContext());
            }
            const snap = patchViewSnapshot(doc);
            if (snap) return snap;
            const err = doc.patchState && doc.patchState.error;
            if (err) throw new Error(err);
            return {loaded: false, name: doc.name, path: doc.path || ''};
        }
        case 'patch_set_root': {
            const doc = appActionResolveDoc(p.target);
            if (!doc) throw new Error('找不到文档：' + (p.target == null ? 'active' : p.target));
            if (!(doc.format && doc.format.patch)) throw new Error('目标标签不是 .patch / .diff：' + (doc.path || doc.name));
            if (doc.patchReview) throw new Error('只读审阅文档不支持设置目标目录');
            return setPatchTargetRoot(doc, patchViewContext(), p.root);
        }
        case 'patch_repreview': {
            const doc = appActionResolveDoc(p.target);
            if (!doc) throw new Error('找不到文档：' + (p.target == null ? 'active' : p.target));
            if (!(doc.format && doc.format.patch)) throw new Error('目标标签不是 .patch / .diff：' + (doc.path || doc.name));
            if (doc.patchReview) throw new Error('只读审阅文档不做预检');
            return repreviewPatchView(doc, patchViewContext(), {ignoreWhitespace: p.ignoreWhitespace, allowOffset: p.allowOffset});
        }
        case 'ai_new_session': {
            if (!aiPanel || !aiPanel.bridgeNewSession) throw new Error('AI 面板未初始化');
            const focus = p.focus === true;
            const session = await aiPanel.bridgeNewSession({title: p.title, message: p.message, focus});
            const where = focus ? '并已切到该会话' : '（后台运行，面板当前会话未变）';
            let sendPart;
            if (!p.message) sendPart = '已创建空会话';
            else if (session && session.sent === false) sendPart = '会话已建但消息发送失败（见面板错误提示）';
            else sendPart = '已在新会话发送消息（真实触发一次模型调用）';
            return {created: session, note: sendPart + where};
        }
        case 'ai_switch_session': {
            if (!aiPanel || !aiPanel.bridgeSwitchSession) throw new Error('AI 面板未初始化');
            const session = await aiPanel.bridgeSwitchSession(p.id);
            if (!session) throw new Error('找不到会话：' + p.id);
            return {switched: session};
        }
        case 'ai_rename_session': {
            if (!aiPanel || !aiPanel.bridgeRenameSession) throw new Error('AI 面板未初始化');
            // 透传调用者会话 id：不传 id 时默认改「调用者自己」的会话，后台会话不会误改前台。
            return {renamed: await aiPanel.bridgeRenameSession(p.id, p.title, callerSessionId)};
        }
        case 'get_gen_models': {
            if (!aiPanel || !aiPanel.bridgeGenModelsList) throw new Error('AI 面板未初始化');
            return aiPanel.bridgeGenModelsList();
        }
        case 'set_gen_model': {
            if (!aiPanel || !aiPanel.bridgeGenModelUpsert) throw new Error('AI 面板未初始化');
            return aiPanel.bridgeGenModelUpsert(p.entry);
        }
        case 'delete_gen_model': {
            if (!aiPanel || !aiPanel.bridgeGenModelDelete) throw new Error('AI 面板未初始化');
            return aiPanel.bridgeGenModelDelete(p.ref);
        }
        // —— 工作区生命周期钩子（get 只读；三个写动作在 shell/lifecycle-hooks.js 无条件动作审批，
        //    完全权限也不例外；刻意没有 run 动作，AI 验证走 run_command 审批链）——
        case 'get_lifecycle_hooks':
        case 'add_lifecycle_hook':
        case 'update_lifecycle_hook':
        case 'remove_lifecycle_hook':
        // 旧名兼容：get_pre_commands / add_pre_command / update_pre_command / remove_pre_command
        // 走同一分支（技能表已不下发，仅历史会话与记忆里的调用会命中）
        case 'get_pre_commands':
        case 'add_pre_command':
        case 'update_pre_command':
        case 'remove_pre_command': {
            return await lifecycleHooksCtl.handleAppAction(action, p, requestActionApproval);
        }
        // —— 数据库连接（AI 代配：清单只读；保存/删除必弹审批卡；密码 DPAPI 落库后不回传）——
        case 'db_list_connections':
        case 'db_save_connection':
        case 'db_delete_connection':
        case 'db_test_connection': {
            return await dbAppActions(action, p, requestActionApproval);
        }
        // —— 插件安装 / 卸载（第三方代码，按权限档与来源走审批；卸载永久删除恒审批）——
        case 'install_plugin': {
            if (typeof backend.InstallPluginFromUrl !== 'function') throw new Error('当前版本不支持安装插件');
            let url = String(p.url || '').trim();
            let marketItem = null;
            if (!url) {
                const name = String(p.name || '').trim();
                if (!name) throw new Error('install_plugin 需要 name（官方市场插件名）或 url（仓库地址）');
                marketItem = await appActionInstallUrlFromName(name);
                url = String(marketItem.url || '').trim();
                if (!url) throw new Error('市场条目缺少仓库地址：' + name);
            }
            const official = isOfficialPluginSource(url);
            const route = pluginInstallRoute(actionScope, official);
            if (route === 'deny') throw new Error('只读权限档不能安装插件');
            if (route === 'approve') {
                if (typeof requestActionApproval !== 'function') {
                    throw new Error('安装该插件需要用户在界面审批；当前调用没有审批通道，拒绝执行');
                }
                const label = (marketItem && marketItem.name) || url;
                const answer = await requestActionApproval({
                    action: 'install_plugin',
                    title: '安装插件：' + label,
                    target: (marketItem && marketItem.name ? marketItem.name + ' · ' : '') + url,
                    oldValue: '未安装',
                    newValue: (marketItem && marketItem.name
                        ? marketItem.name + (marketItem.version ? ' v' + marketItem.version : '')
                        : '来自仓库地址'),
                    risk: official ? 'medium' : 'high',
                    warnings: [
                        '插件代码以与应用相同的权限运行，可读写本机文件、执行命令',
                        official
                            ? '来源：官方插件市场（cadt-datalens-plugins）'
                            : '未知来源：不是官方插件市场（cadt-datalens-plugins），请只在你信任时继续',
                    ],
                    source: url,
                });
                if (!answer || !answer.approved) return {installed: false, denied: true, note: '用户拒绝了本次插件安装'};
            }
            const installed = await backend.InstallPluginFromUrl(url);
            Promise.resolve().then(() => loadPlugins(backend)).catch(() => {});
            activityLog.log('plugin.change', (installed && (installed.id || installed.name)) || url, {op: 'install-url'});
            return {
                installed: {
                    id: (installed && installed.id) || '',
                    name: (installed && installed.name) || '',
                    version: (installed && installed.version) || '',
                },
                official,
                approval: route,
            };
        }
        case 'uninstall_plugin': {
            if (typeof backend.DeletePlugin !== 'function') throw new Error('当前版本不支持删除插件');
            const id = String(p.id || '').trim();
            if (!id) throw new Error('uninstall_plugin 需要 id（见 get_plugins）');
            const installed = (typeof backend.GetPlugins === 'function' ? (await backend.GetPlugins()) : []) || [];
            const hit = installed.find((plugin) => plugin && plugin.id === id);
            if (!hit) throw new Error('找不到已安装插件：' + id + '（用 get_plugins 查看）');
            const route = pluginUninstallRoute(actionScope);
            if (route === 'deny') throw new Error('只读权限档不能卸载插件');
            if (route === 'approve') {
                if (typeof requestActionApproval !== 'function') {
                    throw new Error('卸载插件需要用户在界面审批；当前调用没有审批通道，拒绝执行');
                }
                const answer = await requestActionApproval({
                    action: 'uninstall_plugin',
                    title: '卸载插件：' + (hit.name || id),
                    target: (hit.name || id) + '（' + id + '）',
                    oldValue: '已安装' + (hit.version ? ' v' + hit.version : ''),
                    newValue: '已卸载（永久删除）',
                    risk: 'high',
                    warnings: [
                        '插件代码会被永久删除，不进回收站',
                        '依赖该插件扩展的格式 / 命令 / 主题会立即失效',
                    ],
                    source: '已安装插件（本地）',
                });
                if (!answer || !answer.approved) return {uninstalled: false, denied: true, note: '用户拒绝了本次插件卸载'};
            }
            await backend.DeletePlugin(id);
            Promise.resolve().then(() => loadPlugins(backend)).catch(() => {});
            activityLog.log('plugin.change', id, {op: 'uninstall'});
            return {uninstalled: {id, name: hit.name || id}, approval: route};
        }
        // —— 智能体（群聊成员）：get_agents 只读快照 / create_agent 代建 ——
        // 智能体存 ai-config.json 的 agents[]（面板 aiGroupApi 持有配置与持久化）
        case 'get_agents': {
            return appActionAgentSnapshot();
        }
        case 'create_agent': {
            const config = appActionAIConfig();
            const name = String(p.name == null ? '' : p.name).trim();
            if (!name) throw new Error('create_agent 需要 name');
            const resolved = resolveModelByKeyword(config.profiles, p.model);
            if (!resolved.ok) {
                if (resolved.reason === 'ambiguous') {
                    throw new Error('模型名有多个匹配，请用「账号名/模型名」明确一个：' +
                        resolved.candidates.map((c) => c.label + '（' + c.account + '）').join('；'));
                }
                if (resolved.reason === 'empty') throw new Error('create_agent 需要 model（可用模型见 get_agents 的 models）');
                const options = listModelOptions(config.profiles);
                throw new Error('找不到模型：' + p.model + '；可用模型：' +
                    (options.map((o) => o.label).join('、') || '（暂无，先在 设置 → AI → 模型 添加账号与模型）'));
            }
            const result = agentsUpsert(config.agents || [], {
                name,
                modelRef: resolved.option.ref,
                role: p.role,
                group: p.group,
                personaText: p.persona,
                replyStyle: p.style,
                temperature: p.temperature,
                chair: p.chair === true,
                slowTier: p.slowTier === true,
                enabled: p.enabled !== false,
                color: p.color,
            }, () => aiNowId('agent-'));
            if (!result.ok) throw new Error(result.error);
            if (aiPanel && aiPanel.aiGroupApi) aiPanel.aiGroupApi.saveConfig();
            // 智能体应用页标签开着就即时重绘（saveAIConfig 不广播，判法同 schedules-changed 订阅先例）
            const agentsDoc = docs.find((d) => d && d.appPage === 'agents');
            if (agentsDoc && agentsDoc.appPageRoot && agentsDoc.appPageRoot.isConnected
                && aiPanel && typeof aiPanel.bridgeRefreshAgents === 'function') {
                aiPanel.bridgeRefreshAgents();
            }
            return {
                created: {
                    id: result.agent.id,
                    name: result.agent.name,
                    model: resolved.option.label,
                    role: result.agent.role,
                    group: result.agent.group,
                    chair: result.agent.chair,
                    enabled: result.agent.enabled,
                },
                note: '已创建智能体；人设/角色可在 应用页面 → 智能体 再编辑，或直接在「新建群聊」里选用它',
            };
        }
        // —— 群聊（AI 代建）：成员/主持人按 id 或名字定位（纯函数在 ai-group-model），
        // 校验与落盘复用群聊运行时 createGroup（与「新建群聊」弹窗同一条路径）——
        case 'create_group': {
            if (!aiGroupRuntime) throw new Error('群聊运行时未初始化');
            const config = appActionAIConfig();
            const draft = buildGroupDraft({agents: config.agents || [], params: p});
            if (!draft.ok) throw new Error(draft.error);
            const result = await aiGroupRuntime.createGroup(draft.spec);
            if (!result.ok) throw new Error(result.error || '群聊创建失败');
            const group = aiGroupRuntime.groupById(result.id);
            return {
                created: {
                    id: result.id,
                    title: (group && group.meta && group.meta.title) || draft.spec.title || '未命名群聊',
                    mode: draft.spec.mode,
                    goal: draft.spec.goal,
                    members: draft.members.map((member) => member.name),
                    chair: draft.chair,
                    rounds: draft.spec.maxRounds,
                },
                note: '群聊已创建并在内容区标签页打开；讨论不会自动开始——由用户点「开始讨论」或发第一条消息触发（会真实调用成员模型），不要声称讨论已开始',
            };
        }
        // —— 群聊只读列表 / 用户身份发言（发言会触发成员模型调用，计划模式在面板侧拦截）——
        case 'get_groups': {
            if (!aiGroupRuntime) throw new Error('群聊运行时未初始化');
            const query = String(p.id || p.title || '').trim();
            if (!query) return {groups: (aiGroupRuntime.groupList() || []).map(appActionGroupBrief)};
            const meta = appActionResolveGroup(query);
            const brief = appActionGroupBrief(meta);
            return {
                group: {
                    ...brief,
                    minutesText: meta.minutes && meta.minutes.text ? String(meta.minutes.text).slice(0, 4000) : '',
                },
            };
        }
        case 'send_group_message': {
            if (!aiGroupRuntime) throw new Error('群聊运行时未初始化');
            const meta = appActionResolveGroup(p.id || p.title);
            const text = String(p.text == null ? '' : p.text).trim();
            if (!text) throw new Error('send_group_message 需要 text');
            const result = await aiGroupRuntime.sendUserMessage(meta.id, text);
            if (!result.ok) throw new Error(result.error || '发送失败');
            return {
                sent: {group: meta.title || meta.id, groupId: meta.id, gid: result.gid},
                note: '已作为用户消息发出；自由聊天会唤醒成员（真实模型调用），讨论中会进入点名队列',
            };
        }
        case 'flash': {
            const message = String(p.message || '').trim();
            if (!message) throw new Error('flash 需要 message');
            flash(message, !!p.isError);
            return {shown: true};
        }
        case 'refresh_explorer': {
            if (explorer && explorer.refresh) explorer.refresh();
            return {refreshed: true};
        }
        case 'reveal_in_explorer': {
            // 在文件树里展开并选中指定路径（缺省当前活动文件）
            if (!explorer || typeof explorer.revealPath !== 'function') throw new Error('文件树未初始化');
            const raw = String(p.path || '').trim() || (file && file.path) || '';
            if (!raw) throw new Error('reveal_in_explorer 需要 path（当前没有活动文件）');
            if (!workspaceFolder) throw new Error('没有打开工作区');
            const target = appActionWorkspacePath(raw);
            if (!settings.showSidebar) toggleSidebar(true);
            switchSidebarView('files');
            if (typeof explorer.setMode === 'function') explorer.setMode('tree', false);
            // revealPath 自己会建树并对沿途逐层强制重读（新建的文件/目录也能找到），
            // 不再先全量 refresh —— 那会把用户已展开的目录全部折叠。
            const ok = await explorer.revealPath(target);
            if (!ok) throw new Error('文件树展开失败：路径不在当前工作区或列表未加载：' + target);
            return {revealed: target};
        }
        case 'type_text': {
            // 模拟键盘输入（仅完全权限档）：输入到焦点元素或 target 选择器匹配的输入框
            if (actionScope !== 'full') throw new Error('type_text 需要「完全权限」权限档');
            const text = String(p.text == null ? '' : p.text);
            if (!text) throw new Error('type_text 需要 text');
            const target = appActionEditableTarget(p.target);
            if (!target) throw new Error('找不到可输入目标：先聚焦输入框，或用 target 传选择器');
            target.focus();
            let ok = false;
            try {
                ok = document.execCommand('insertText', false, text);
            } catch (e) {}
            if (!ok) {
                if (typeof target.selectionStart === 'number') {
                    target.setRangeText(text, target.selectionStart, target.selectionEnd, 'end');
                } else {
                    target.value += text;
                }
                target.dispatchEvent(new Event('input', {bubbles: true}));
            }
            return {typed: text.length, target: target.id || target.name || 'activeElement'};
        }
        case 'press_key': {
            // 模拟按键 / 组合键（仅完全权限档）：派发 keydown/keyup 并冒泡，可触发全局快捷键、对话框确认、Esc 关闭等
            if (actionScope !== 'full') throw new Error('press_key 需要「完全权限」权限档');
            const rawKey = String(p.key || '').trim();
            if (!rawKey) throw new Error('press_key 需要 key（如 Enter / Escape / F3 / a / Ctrl+Shift+P）');
            const spec = comboSpecFromText(rawKey);
            if (!spec.ok) throw new Error(spec.error + '；收到的组合串：' + rawKey);
            const target = appActionEditableTarget(p.target, true) || document.activeElement || document.body;
            target.focus && target.focus();
            appActionDispatchKey(target, spec);
            return {
                dispatched: spec.combo,
                key: spec.key,
                code: spec.code,
                modifiers: spec.modifiers,
                target: target.id || target.name || target.tagName || 'body',
            };
        }
        case 'click': {
            // 合成一次界面单击（仅完全权限档）：DOM 事件不移动系统鼠标，不产生真实用户激活
            if (actionScope !== 'full') throw new Error('click 需要「完全权限」权限档');
            const viewport = {width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1};
            const selector = String(p.selector || '').trim();
            let el = null;
            let x = 0;
            let y = 0;
            if (selector) {
                try {
                    el = document.querySelector(selector);
                } catch (e) {
                    throw new Error('selector 无效：' + selector);
                }
                if (!el) throw new Error('找不到元素：' + selector);
                try {
                    el.scrollIntoView({block: 'center', inline: 'center'});
                } catch (e) {}
                const rect = el.getBoundingClientRect();
                if (!(rect.width > 0 && rect.height > 0)) throw new Error('元素当前不可见：' + selector);
                x = Math.round(Math.min(viewport.width - 1, Math.max(0, rect.left + rect.width / 2)));
                y = Math.round(Math.min(viewport.height - 1, Math.max(0, rect.top + rect.height / 2)));
            } else {
                x = Math.round(Number(p.x));
                y = Math.round(Number(p.y));
                if (!Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) {
                    throw new Error('click 需要数字坐标 x / y（CSS 像素，相对窗口可视区），或传 selector');
                }
                if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
                    throw new Error('坐标超出可视区：(' + x + ', ' + y + ')，当前可视区 ' +
                        viewport.width + '×' + viewport.height + ' CSS 像素（截图是物理像素，请除以 DPR=' + viewport.dpr + '）');
                }
                el = document.elementFromPoint(x, y);
                if (!el) throw new Error('该坐标没有可点击元素：(' + x + ', ' + y + ')');
            }
            appActionDispatchClick(el, x, y);
            const target = appActionDescribeNode(el);
            return {
                clicked: {x, y, target},
                viewport,
                note: '合成点击（isTrusted=false，不带用户激活）：依赖真实点击校验的行为可能无响应；结果用 screenshot 核对。' +
                    (target && target.tag === 'iframe' ? '目标是 iframe 容器，页面内部请用 browser_click 系列。' : ''),
            };
        }
        case 'screenshot': {
            // 截取应用主窗口或指定板块（含 WebView2 与内嵌浏览器）；由 ai-panel 转成图片消息附加给模型
            const area = String(p.area || 'full').trim().toLowerCase();
            const spec = APP_SCREENSHOT_AREAS[area];
            if (!spec) throw new Error('未知截图区域「' + area + '」；可用：' + Object.keys(APP_SCREENSHOT_AREAS).join(' / '));
            if (!spec.selector) {
                if (!backend.CaptureAppScreenshot) throw new Error('截图通道不可用（请重新构建或更新应用）');
                const image = await backend.CaptureAppScreenshot();
                if (!image || image.length < 50) throw new Error('截图数据为空');
                return {image, mime: 'image/png', name: '应用截图'};
            }
            const el = document.querySelector(spec.selector);
            if (!el) {
                let hint = '';
                if (area === 'ai') hint = '（AI 面板可能已弹出为独立窗口，先停靠回来）';
                if (area === 'patch') hint = '（先在顶部视图切换里进入补丁视图）';
                throw new Error('找不到板块：' + spec.label + hint);
            }
            const rect = el.getBoundingClientRect();
            if (!(rect.width > 0 && rect.height > 0)) throw new Error('板块当前不可见：' + spec.label);
            if (!backend.CaptureAppScreenshotRegion) throw new Error('区域截图通道不可用（请重新构建或更新应用）');
            const dpr = window.devicePixelRatio || 1;
            const image = await backend.CaptureAppScreenshotRegion(
                Math.round(rect.left * dpr),
                Math.round(rect.top * dpr),
                Math.max(1, Math.round(rect.width * dpr)),
                Math.max(1, Math.round(rect.height * dpr))
            );
            if (!image || image.length < 50) throw new Error('截图数据为空');
            return {image, mime: 'image/png', name: '应用截图 · ' + spec.label};
        }
        default:
            throw new Error('未知动作「' + action + '」');
    }
}

window.__lens = {
    get editor() { return editor; },
    get file() { return file; },
    get docs() { return docs; },
    get currentMode() { return currentMode; },
    get explorer() { return explorer; },
    get structurePanel() { return structurePanel; },
    get terminalUI() { return terminalUI; },
    get closedTabs() { return closedTabs; },
    // 这些函数拆分到域模块后经 const 解构引入（不再有函数声明提升），
    // 这里必须用 getter 延迟求值，否则顶层急切求值会 TDZ
    get openConfirmDialog() { return openConfirmDialog; },
    get openPaths() { return openPaths; },
    get openTargets() { return openTargets; },
    get openFolderWorkspace() { return openFolderWorkspace; },
    get reopenClosedTab() { return reopenClosedTab; },
    get setTheme() { return setTheme; },
    runAppAction,
};
let dirty = false;
let currentMode = 'tree';
let flashTimer = 0;
let readingMode = null;

const settingsKey = 'datalens-settings';
const uiFonts = [
    {id: 'inter', name: 'Inter', family: '"Inter"'},
    {id: 'system', name: 'Segoe UI', family: '"Segoe UI"'},
];
const editorFonts = [
    {id: 'jetbrains', name: 'JetBrains Mono', family: '"JetBrains Mono"'},
    {id: 'fira', name: 'Fira Code', family: '"Fira Code"'},
    {id: 'consolas', name: 'Consolas', family: 'Consolas'},
    {id: 'cascadia', name: 'Cascadia Code', family: '"Cascadia Code"'},
    {id: 'system', name: '系统等宽', family: 'Consolas, "Courier New"'},
];
const cjkFonts = [
    {id: 'auto', name: '跟随设置', family: '"Microsoft YaHei UI", "微软雅黑"'},
    {id: 'dengxian', name: '等线', family: '"DengXian", "等线"'},
    {id: 'simsun', name: '宋体', family: '"SimSun", "宋体"'},
    {id: 'simhei', name: '黑体', family: '"SimHei", "黑体"'},
    {id: 'kaiti', name: '楷体', family: '"KaiTi", "楷体"'},
    {id: 'fangsong', name: '仿宋', family: '"FangSong", "仿宋"'},
    {id: 'jhenghei', name: '微软正黑体', family: '"Microsoft JhengHei UI", "Microsoft JhengHei", "微软正黑体"'},
];
const treeFonts = [
    {id: 'follow', name: '跟随界面字体', family: null},
    ...uiFonts.map((f) => ({id: 'ui-' + f.id, name: f.name, family: f.family})),
    ...editorFonts.map((f) => ({id: 'editor-' + f.id, name: f.name + '（等宽）', family: f.family})),
];
const treeCjkFonts = [
    {id: 'follow', name: '跟随界面中文字体', family: null},
    ...cjkFonts.filter((f) => f.id !== 'auto'),
];
const formatDefs = [
    {id: 'json', name: 'JSON'},
    {id: 'jsonl', name: 'JSONL'},
    {id: 'yaml', name: 'YAML'},
    {id: 'xml', name: 'XML'},
    {id: 'csv', name: 'CSV'},
    {id: 'toml', name: 'TOML'},
    {id: 'ini', name: 'INI/Properties'},
    {id: 'markdown', name: 'Markdown'},
    // 代码语言组（formats.js 里与 text 拆开）：indent/view 为该组默认值
    {id: 'python', name: 'Python', indent: '4', view: 'code'},
    {id: 'golang', name: 'Go', indent: 'tab', view: 'code'},
    {id: 'web', name: 'Web 前端', indent: '2', view: 'code'},
    {id: 'clang', name: 'C/C++', indent: '4', view: 'code'},
    {id: 'jvm', name: 'Java/Kotlin/C#', indent: '4', view: 'code'},
    {id: 'shell', name: 'Shell/Batch', indent: '4', view: 'code'},
    {id: 'script', name: 'Ruby/PHP/Lua 等', indent: '4', view: 'code'},
    {id: 'sql', name: 'SQL', indent: '4', view: 'code'},
    {id: 'text', name: '纯文本', view: 'code'},
];

function allFormatDefs() {
    return formatDefs.concat(pluginFormats.map((f) => ({id: f.id, name: f.name})));
}

function defaultFormatSettings() {
    return Object.fromEntries(formatDefs.map((f) => [f.id, {
        encoding: 'auto',
        indent: f.indent || '2',
        eol: 'follow',
        view: f.id === 'csv' ? 'table' : f.id === 'markdown' ? 'preview' : f.view || 'tree',
    }]));
}
const defaultSettings = {
    fixedKeys: true,
    autoSave: false,
    openMode: 'tab',
    // 点窗口 X 的行为：exit 直接退出 / tray 最小化到托盘（后端 config.json 为真源）
    closeAction: 'exit',
    sidebarMode: 'tree',
    sidebarView: 'files',
    // 结构面板在「文件 + AI 助手」同时存在时的来源偏好（file / session）
    structureSource: 'file',
    showSidebar: false,
    csvTableMigrated: false,
    keyWidth: 160,
    sidebarFont: 12.5,
    treeGuides: false,
    treeCounts: false,
    treeRefreshInterval: 3,
    // 文件树/列表是否显示应用状态目录 .cadt（默认显示；关掉只在根层隐藏）
    showCadDir: true,
    terminalHeight: 240,
    sidebarWidth: 264,
    gitCommitAreaHeight: 0,
    codeGuides: false,
    alwaysOnTop: false,
    editorFont: 15,
    // 代码编辑器行高倍数（默认 1.5，对齐 JetBrains 观感；比 Ace 默认 1.3 松）
    editorLineHeight: 1.5,
    codeWrap: false,
    // 编辑器补全（docs/finished-plans/editor-completion.md §8/§15.2；偏好键，默认跨窗同步）。
    // live「输入时自动弹出」默认关：vendored bundle 的 live afterExec 路径实测不可靠
    // （最小 completer 也复现冻结 + 真实键入后 completer 未创建），待升级 vendored Ace 后再评估
    completion: {files: true, sql: true, live: false},
    scrollStyle: 'standard',
    // 代码截图样式（档位单一来源 core/code-shot.js）
    codeShotTitle: false,
    codeShotLineNumbers: true,
    codeShotRadius: 10,
    codeShotScale: 2,
    mdLineNumbers: false,
    mdScrollSync: true,
    mdPreviewWidth: '0',
    aiFullscreenWidth: 'auto',
    autoCheckUpdate: true,
    structureExportLineNums: false,
    langEnv: {},
    // 运行代码（docs/finished-plans/run-code.md）
    runCwd: 'file',
    runDirtyMode: 'ask',
    runArgs: {},
    runConfigs: {},
    runProfiles: [],
    runActiveProfile: '',
    runConfirmSeen: [],
    mavenFlags: {}, // Maven 工具窗口执行开关（离线 / 跳过测试 / 更新快照 / 精简进度）
    treeExpandDefault: 'expand',
    showBanners: true,
    readOnlyMode: false,
    theme: 'dark',
    codeStyle: CODE_STYLE_AUTO,
    iconTheme: 'opensource',
    // 快捷键风格（candysweet / jetbrains / vscode）：键位单一来源在 core/keybindings.js，
    // 运行时索引在 core/keymap.js；切换立即生效。
    keyStyle: DEFAULT_KEY_STYLE,
    uiFont: 'inter',
    uiCjkFont: 'auto',
    editorFontFamily: 'jetbrains',
    editorCjkFont: 'auto',
    splitRatio: 0.5,
    aiPanelOpen: false,
    aiPanelWidth: 380,
    aiFloatMode: 'dock',
    aiSendKey: 'enter',
    // 长文本粘贴模式：collapse 折叠为可点击胶囊（默认）/ attachment 转附件 / off 原样键入
    aiLongPaste: 'collapse',
    aiChatFont: 14,
    aiChatFontEn: 'follow',
    aiChatFontCjk: 'follow',
    aiChatCodeFont: 'follow',
    aiShowThinking: true,
    aiShowEveryTurnMeta: false,
    aiContextSlim: true,
    // 认知索引（可选启用，默认关）：显式播种让 get_settings 能看到键——技能表教模型
    // 用 get_settings 查当前状态，缺省不存在会被误读成「版本不支持」（2026-11-22 审查）
    aiCognition: false,
    aiShowUsage: true,
    // composer 状态栏额度胶囊（全局外显开关，默认关；需账号启用用量查询才有数据）
    aiShowQuotaPill: false,
    // 回复操作按钮颗粒度：full 全部完整出现（默认）/ mid-basic 中间步骤只留复制+回退 / last-only 只在最后一条显示
    aiMsgActions: 'full',
    aiAssistantCard: false,
    aiInlineWidgets: true,
    // 任务清单默认展开（默认收起：只占一行进度摘要，设置页可改）
    aiTodosDefaultExpanded: false,
    // AI 回合开始时自动收起编辑区，把内容区位置让给对话（默认关：会改变布局，须主动开启）
    aiAutoCollapseEditor: false,
    // AI 过程区（思考链 / 工具卡 / 中间回复）从流式开始就默认收起，只显示最终结果（默认关）
    aiAlwaysCollapse: false,
    // 编辑区被收起时，任何新标签页打开都自动展开（默认开；仅停靠分屏生效）
    editorExpandOnNewTab: true,
    aiMaxSessions: 50,
    aiInjectContext: true,
    aiInjectRoot: true,
    aiInjectActiveFile: true,
    aiInjectCaret: true,
    aiInjectViewport: true,
    aiInjectOpenFiles: true,
    aiInjectAgentsMd: true,
    aiInjectMemory: true,
    aiInjectSkills: true,
    aiInjectPreferences: true,
    aiInjectEnvVars: true,
    // 个性化（称呼 / 名字 / 风格 / 人设 / 长期指令）总开关；不进下方 fineInjectKeys 迁移列表
    aiInjectPersona: true,
    writingMode: false,
    writingFont: 'kaiti',
    writingFontSize: 16,
    writingPaper: 'off',
    writingLineNumbers: false,
    writingTypewriter: true,
    writingFocus: true,
    writingDailyGoal: 0,
    formatSettings: defaultFormatSettings(),
    // 阅读模式（docs/finished-plans/reading-mode.md §14.1）
    readingFont: 'songti',
    readingFontSize: 19,
    readingLineHeight: 1.9,
    readingPageWidth: 42,
    readingParagraphGap: 0.6,
    readingIndent: false,
    readingTheme: 'auto',
    readingJoinSoftLines: true,
    readingContinuous: false,
    readingPaged: false,
    readingTocDepth: 2,
    readingRestoreSession: true,
    readingTtsRate: 1,
    readingTtsAutoNext: true,
    // 操作留痕（docs/unfinished-plans/operation-audit-log.md）
    activityLog: true,
    activityRetentionMonths: 12,
    // 存储自动清理（docs/finished-plans/auto-cache-cleanup.md）：天数 0 = 仅按大小，MB 0 = 仅按时间
    storageAutoClean: false,
    storageAutoCleanDays: 7,
    storageAutoCleanMB: 500,
    // 右键「新建」菜单定制（docs/finished-plans/feature-evaluations-2026-11-18.md §1）
    newFileMenu: defaultNewFileMenu(),
    // 临时草稿上次用过的扩展名（docs/finished-plans/scratch-file.md §6）：一键建草稿的默认语言
    scratchExt: '.md',
};
let settings = JSON.parse(JSON.stringify(defaultSettings));
try {
    const stored = kvGetJson(settingsKey, {}) || {};
    settings = {...settings, ...stored};
    settings.formatSettings = {...defaultFormatSettings(), ...(stored.formatSettings || {})};
    for (const f of formatDefs) {
        settings.formatSettings[f.id] = {...defaultFormatSettings()[f.id], ...(settings.formatSettings[f.id] || {})};
    }
    const fineInjectKeys = ['aiInjectRoot', 'aiInjectActiveFile', 'aiInjectCaret', 'aiInjectViewport', 'aiInjectOpenFiles',
        'aiInjectMemory', 'aiInjectSkills', 'aiInjectPreferences'];
    if (stored.aiInjectContext === false && !fineInjectKeys.some((key) => Object.prototype.hasOwnProperty.call(stored, key))) {
        for (const key of fineInjectKeys) settings[key] = false;
    }
} catch (e) {}
// 2026-11-21 命名迁移：preCommands / preCommandsEnabled → lifecycleHooks / lifecycleHooksEnabled
// （旧名 pre-command 只表达「前置命令」，与 9 个生命周期事件不符）。只在旧键存在时搬一次，
// 已写新键的配置不被覆盖；旧键一律删除，避免两套字段长期并存。
if (Object.prototype.hasOwnProperty.call(settings, 'preCommands')) {
    if (!Array.isArray(settings.lifecycleHooks) && Array.isArray(settings.preCommands)) {
        settings.lifecycleHooks = settings.preCommands;
    }
    delete settings.preCommands;
}
if (Object.prototype.hasOwnProperty.call(settings, 'preCommandsEnabled')) {
    if (settings.lifecycleHooksEnabled === undefined) settings.lifecycleHooksEnabled = settings.preCommandsEnabled;
    delete settings.preCommandsEnabled;
}
// 新建菜单配置：损坏 / 旧版残留字段一律归一化，不让它把右键菜单搞成空白
settings.newFileMenu = normalizeNewFileMenu(settings.newFileMenu);
// 临时草稿的默认扩展名：非法的旧值（含手工改坏的 localStorage）回落到 .md
settings.scratchExt = normalizeScratchExt(settings.scratchExt);
// 2026-11-16 主题体系重构：旧版 9 套界面主题降级为代码主题 —— 迁移成 深色/浅色
// UI 主题 + 对应代码主题（映射单一来源 code-styles.js，index.html 启动脚本有同表副本）；
// 未知主题（可能是已卸载插件注册的）先保留，等插件加载后 CSS 生效
const legacyThemeMigration = migrateLegacyTheme(settings.theme, settings.codeStyle);
if (legacyThemeMigration) {
    settings.theme = legacyThemeMigration.theme;
    settings.codeStyle = legacyThemeMigration.codeStyle;
}
if (!uiFonts.some((f) => f.id === settings.uiFont)) settings.uiFont = 'inter';
// 快捷键风格：非法值回落默认，并把运行时索引切到生效风格（按键链查表用）。
if (!isValidKeyStyleId(settings.keyStyle)) settings.keyStyle = DEFAULT_KEY_STYLE;
keymap.setStyle(settings.keyStyle);
if (!editorFonts.some((f) => f.id === settings.editorFontFamily)) settings.editorFontFamily = 'jetbrains';
// 编辑器行高倍数：非法值回落 1.5，夹在 1.2–2（与设置滑块范围一致）
settings.editorLineHeight = Math.min(2, Math.max(1.2, Number(settings.editorLineHeight) || 1.5));
if (!cjkFonts.some((f) => f.id === settings.uiCjkFont)) settings.uiCjkFont = 'auto';
if (!cjkFonts.some((f) => f.id === settings.editorCjkFont)) settings.editorCjkFont = 'auto';
settings.autoSave = !!settings.autoSave;
// openMode 仅支持 tab：「一个文件一个窗口」在 v3 一进程多窗口下会造成同工作区
// 双开，轻量查看窗评估前禁用（2026-11-21 用户裁定）；旧配置里的 window 值回落。
settings.openMode = 'tab';
// 关闭行为（exit 直接退出 / tray 最小化到托盘）：非法值回落退出——藏窗口是不可见的坑，
// 宁可退出也不要让用户找不到程序。真相在后端 config.json（见 SetCloseAction）。
if (settings.closeAction !== 'tray') settings.closeAction = 'exit';
if (settings.sidebarMode !== 'list') settings.sidebarMode = 'tree';
// sidebarView 白名单放行 'maven'：触发判定是异步的，启动时还没算完——放行后由 Maven 面板
// 在识别失败时自动退回 files（localStorage 单槽跨窗残留的兜底见方案 §5.3）。
if (!['files', 'git', 'structure', 'chats', 'maven'].includes(settings.sidebarView)) settings.sidebarView = 'files';
if (settings.structureSource !== 'session') settings.structureSource = 'file';
settings.showSidebar = !!settings.showSidebar;
settings.treeGuides = !!settings.treeGuides;
settings.treeCounts = !!settings.treeCounts;
settings.showCadDir = settings.showCadDir !== false;
settings.codeGuides = !!settings.codeGuides;
settings.alwaysOnTop = !!settings.alwaysOnTop;
// 存储自动清理：取值白名单与设置页下拉一致，非法值回落默认
settings.storageAutoClean = settings.storageAutoClean === true;
if (![1, 3, 7, 30, 0].includes(Number(settings.storageAutoCleanDays))) settings.storageAutoCleanDays = 7;
if (![100, 200, 500, 1024, 2048, 0].includes(Number(settings.storageAutoCleanMB))) settings.storageAutoCleanMB = 500;
settings.storageAutoCleanDays = Number(settings.storageAutoCleanDays);
settings.storageAutoCleanMB = Number(settings.storageAutoCleanMB);
settings.treeRefreshInterval = Number(settings.treeRefreshInterval);
if (![0, 1, 2, 3, 5, 10].includes(settings.treeRefreshInterval)) settings.treeRefreshInterval = 3;
settings.terminalHeight = Math.min(2000, Math.max(120, Number(settings.terminalHeight) || 240));
settings.sidebarWidth = Math.min(500, Math.max(160, Number(settings.sidebarWidth) || 264));
settings.codeWrap = !!settings.codeWrap;
settings.codeShotTitle = !!settings.codeShotTitle;
settings.codeShotLineNumbers = settings.codeShotLineNumbers !== false;
if (!CODE_SHOT_RADII.includes(settings.codeShotRadius)) settings.codeShotRadius = 10;
if (!CODE_SHOT_SCALES.includes(settings.codeShotScale)) settings.codeShotScale = 2;
settings.mdLineNumbers = !!settings.mdLineNumbers;
settings.mdScrollSync = settings.mdScrollSync !== false;
settings.writingMode = !!settings.writingMode;
if (!WRITING_FONTS.some((f) => f.id === settings.writingFont)) settings.writingFont = 'kaiti';
settings.writingFontSize = Math.min(22, Math.max(12, Number(settings.writingFontSize) || 16));
if (!WRITING_PAPERS.some((p) => p.id === settings.writingPaper)) settings.writingPaper = 'off';
settings.writingLineNumbers = !!settings.writingLineNumbers;
settings.writingTypewriter = settings.writingTypewriter !== false;
settings.writingFocus = settings.writingFocus !== false;
settings.writingDailyGoal = Math.max(0, Number(settings.writingDailyGoal) || 0);
if (!['0', '720', '860', '920', '1100', '1300'].includes(String(settings.mdPreviewWidth))) settings.mdPreviewWidth = '0';
if (!['auto', '0', '720', '860', '920', '1100', '1300'].includes(String(settings.aiFullscreenWidth))) settings.aiFullscreenWidth = 'auto';
if (settings.aiWidthAutoDefaultMigrated !== true) {
    // 旧版默认是「跟随」；自动模式引入后，未显式选过固定宽度的用户迁到新默认
    if (String(settings.aiFullscreenWidth) === '0') settings.aiFullscreenWidth = 'auto';
    settings.aiWidthAutoDefaultMigrated = true;
}
settings.autoCheckUpdate = settings.autoCheckUpdate !== false;
// 一次性迁移：曾以 920px 作为出厂默认被写入本地存储，改为新的默认值“自适应”
if (settings.mdPreviewWidth === '920' && settings.mdWidthMigrated !== true) {
    settings.mdPreviewWidth = '0';
    settings.mdWidthMigrated = true;
}
settings.structureExportLineNums = !!settings.structureExportLineNums;
if (!settings.langEnv || typeof settings.langEnv !== 'object') settings.langEnv = {};
settings.runCwd = settings.runCwd === 'workspace' ? 'workspace' : 'file';
if (!['ask', 'save', 'temp'].includes(settings.runDirtyMode)) settings.runDirtyMode = 'ask';
if (!settings.runArgs || typeof settings.runArgs !== 'object') settings.runArgs = {};
if (!settings.runConfigs || typeof settings.runConfigs !== 'object') settings.runConfigs = {};
if (!Array.isArray(settings.runProfiles)) settings.runProfiles = [];
if (typeof settings.runActiveProfile !== 'string') settings.runActiveProfile = '';
if (!Array.isArray(settings.runConfirmSeen)) settings.runConfirmSeen = [];
if (!settings.mavenFlags || typeof settings.mavenFlags !== 'object' || Array.isArray(settings.mavenFlags)) settings.mavenFlags = {};
settings.splitRatio = Number(settings.splitRatio);
if (!Number.isFinite(settings.splitRatio)) settings.splitRatio = 0.5;
settings.splitRatio = Math.min(0.85, Math.max(0.15, settings.splitRatio));
settings.treeExpandDefault = settings.treeExpandDefault === 'collapse' ? 'collapse' : 'expand';
settings.showBanners = settings.showBanners !== false;
settings.readOnlyMode = !!settings.readOnlyMode;
if (!['always', 'hover', 'none'].includes(settings.tabCloseMode)) settings.tabCloseMode = 'always';
settings.dblClickClose = !!settings.dblClickClose;
settings.shiftClickClose = settings.shiftClickClose !== false;
settings.sidebarFont = Number(settings.sidebarFont);
if (!Number.isFinite(settings.sidebarFont)) settings.sidebarFont = 12.5;
settings.sidebarFont = Math.min(20, Math.max(10, settings.sidebarFont));
settings.aiPanelOpen = !!settings.aiPanelOpen;
// 上限不写死：大屏分屏用 AI 面板常要拖到半屏宽（视口 60%，至少 640）
  settings.aiPanelWidth = Math.min(Math.max(640, Math.round(window.innerWidth * 0.6)), Math.max(280, Number(settings.aiPanelWidth) || 380));
settings.aiFloatMode = ['dock', 'fullscreen'].includes(settings.aiFloatMode) ? settings.aiFloatMode : 'dock';
// AI 面板停靠侧（dock 分屏模式下与内容区互换左右）
settings.aiPanelSide = settings.aiPanelSide === 'left' ? 'left' : 'right';
settings.aiSendKey = settings.aiSendKey === 'ctrl-enter' ? 'ctrl-enter' : 'enter';
// 长文本粘贴模式（三档，非法值回落 collapse）
settings.aiLongPaste = ['off', 'attachment', 'collapse'].includes(settings.aiLongPaste) ? settings.aiLongPaste : 'collapse';
// 2026-11-25 出厂字号调整（编辑器 13 → 15、聊天 13 → 14）：存量配置里仍停在旧出厂值的各跟一次，
// 用户显式选过别的值不动；迁移只跑一次（flag 落进 localStorage，之后不再干预）。
if (settings.fontDefaults15Migrated !== true) {
    if (Number(settings.editorFont) === 13) settings.editorFont = 15;
    if (Number(settings.aiChatFont) === 13) settings.aiChatFont = 14;
    settings.fontDefaults15Migrated = true;
}
settings.aiChatFont = Math.min(32, Math.max(10, Number(settings.aiChatFont) || 14));
for (const key of ['aiChatFontEn', 'aiChatFontCjk', 'aiChatCodeFont']) {
    if (typeof settings[key] !== 'string' || !settings[key]) settings[key] = 'follow';
}
settings.aiShowThinking = settings.aiShowThinking !== false;
settings.aiShowUsage = settings.aiShowUsage !== false;
settings.aiShowQuotaPill = settings.aiShowQuotaPill === true;
// 回复操作按钮颗粒度（三档，非法值回落 full）
settings.aiMsgActions = ['full', 'mid-basic', 'last-only'].includes(settings.aiMsgActions) ? settings.aiMsgActions : 'full';
settings.aiAssistantCard = settings.aiAssistantCard === true;
// AI 回答里把 svg / html 围栏渲染成可视化卡片（默认开；关闭后按普通代码块显示）
settings.aiInlineWidgets = settings.aiInlineWidgets !== false;
// 任务清单默认展开（默认关 = 收起成一行进度摘要）
settings.aiTodosDefaultExpanded = settings.aiTodosDefaultExpanded === true;
// AI 工作时自动收起编辑区（默认关；存量配置缺该键即视为关，不会悄悄改布局）
settings.aiAutoCollapseEditor = settings.aiAutoCollapseEditor === true;
// AI 过程区始终折叠（默认关；存量配置缺该键即视为关，不改变既有展开习惯）
settings.aiAlwaysCollapse = settings.aiAlwaysCollapse === true;
// 新标签页打开时自动展开编辑区（默认开；存量配置缺该键即视为开）
settings.editorExpandOnNewTab = settings.editorExpandOnNewTab !== false;
settings.aiMaxSessions = Math.min(500, Math.max(2, Number(settings.aiMaxSessions) || 50));
settings.aiInjectContext = settings.aiInjectContext !== false;
for (const key of ['aiInjectRoot', 'aiInjectActiveFile', 'aiInjectCaret', 'aiInjectViewport', 'aiInjectOpenFiles',
    'aiInjectAgentsMd', 'aiInjectMemory', 'aiInjectSkills', 'aiInjectPreferences', 'aiInjectEnvVars',
    // 个性化总开关：名字是身份信息不是上下文注入，故意不进上面的 fineInjectKeys 迁移语义
    'aiInjectPersona']) {
    settings[key] = settings[key] !== false;
}
// 阅读模式设置归一化（§14.1）
if (!['songti', 'kaiti', 'yahei', 'dengxian', 'system'].includes(settings.readingFont)) settings.readingFont = 'songti';
settings.readingFontSize = Math.min(28, Math.max(16, Number(settings.readingFontSize) || 19));
settings.readingLineHeight = Math.min(2.2, Math.max(1.6, Number(settings.readingLineHeight) || 1.9));
settings.readingPageWidth = Math.min(56, Math.max(32, Number(settings.readingPageWidth) || 42));
settings.readingParagraphGap = Math.min(1.2, Math.max(0, Number(settings.readingParagraphGap) || 0.6));
settings.readingIndent = !!settings.readingIndent;
if (!['auto', 'paper', 'sepia', 'light', 'dark'].includes(settings.readingTheme)) settings.readingTheme = 'auto';
settings.readingJoinSoftLines = settings.readingJoinSoftLines !== false;
settings.readingContinuous = !!settings.readingContinuous;
settings.readingPaged = !!settings.readingPaged;
settings.readingTocDepth = Math.min(4, Math.max(1, Number(settings.readingTocDepth) || 2));
settings.readingRestoreSession = settings.readingRestoreSession !== false;
settings.readingTtsRate = Math.min(2, Math.max(0.5, Number(settings.readingTtsRate) || 1));
settings.readingTtsAutoNext = settings.readingTtsAutoNext !== false;
if (!settings.csvTableMigrated) {
    settings.formatSettings.csv.view = 'table';
    settings.csvTableMigrated = true;
}
if (!['table', 'tree', 'text'].includes(settings.formatSettings.csv.view)) {
    settings.formatSettings.csv.view = 'table';
}
if (!['split', 'preview', 'code', 'text'].includes(settings.formatSettings.markdown.view)) {
    settings.formatSettings.markdown.view = 'preview';
}

// 编辑器内键位（复制行 / 删除行 / 多选…）随快捷键风格联动：与全局 keymap 共用 settings.keyStyle。
// 纯运行时，deps 全 getter 延迟求值；创建后注入 settingsUI（切风格时 applyToAll）与 editorGroups（建编辑器时 applyTo）。
const editorKeybindings = createEditorKeybindings({
    get settings() { return settings; },
    get docs() { return docs; },
});

// 补全设置热生效：settings 变更（含跨窗广播）后对已开编辑器即时更新 live / 补挂
// （镜像 editorKeybindings.applyToAll 的接线方式；启动时 docs 为空，无副作用）
const applyCompletionSettingsToAllDocs = () => refreshCompletionSettings(
    (docs || []).map((d) => ({aceEditor: d && d.editor && d.editor.aceEditor, doc: d})),
    settings,
);

const settingsUI = createSettingsUI({
    get aiPanel() { return aiPanel; },
    get allFormatDefs() { return allFormatDefs; },
    // 设置搜索要能搜到应用页面（它们不在任何 .settings-pane 里）
    get APP_PAGES() { return APP_PAGES; },
    get applyEditorKeybindingsToAll() { return () => editorKeybindings.applyToAll(); },
    get applyCompletionSettingsToAll() { return () => applyCompletionSettingsToAllDocs(); },
    get applySidebarUI() { return applySidebarUI; },
    get applyWritingMode() { return applyWritingMode; },
    get backend() { return backend; },
    get cancelAutoSave() { return cancelAutoSave; },
    get cjkFonts() { return cjkFonts; },
    get currentMode() { return currentMode; },
    get defaultFormatSettings() { return defaultFormatSettings; },
    get developerMode() { return developerMode; },
    get dirty() { return dirty; },
    get docs() { return docs; },
    get editor() { return editor; },
    get editorFonts() { return editorFonts; },
    get els() { return els; },
    get explorer() { return explorer; },
    get file() { return file; },
    get flash() { return flash; },
    get iconSvg() { return iconSvg; },
    get initAIPanel() { return initAIPanel; },
    // 设置页里「需先到应用页面配置」的跳转按钮（data-open-app-page）用；
    // openAppPageTab 由 bridgeUI 在后面定义，getter 延迟求值避开 TDZ。
    get openAppPageTab() { return openAppPageTab; },
    get LANG_DEFS() { return LANG_DEFS; },
    get LOCK_ICON() { return LOCK_ICON; },
    get readingMode() { return readingMode; },
    get patchesPane() { return settingsPanePatches; },
    get newFileMenuPane() { return settingsPaneNewFileMenu; },
    get refreshDeveloperMode() { return refreshDeveloperMode; },
    get refreshLogPath() { return refreshLogPath; },
    get relativePathFrom() { return relativePathFrom; },
    get renderActivityPane() { return renderActivityPane; },
    get renderAppPagesPane() { return settingsPaneAppPages.renderAppPagesPane; },
    get renderCsvTableView() { return renderCsvTableView; },
    get renderEnvVarsPane() { return renderEnvVarsPane; },
    get renderFmtTable() { return renderFmtTable; },
    get renderFormatPane() { return renderFormatPane; },
    get renderLangPane() { return renderLangPane; },
    get renderMarkdownPreview() { return renderMarkdownPreview; },
    get renderPluginsPane() { return renderPluginsPane; },
    get renderPluginSettingsPane() { return writingUI && writingUI.renderPluginSettingsPane; },
    get renderRunPane() { return renderRunPane; },
    get renderLifecyclePane() { return () => settingsPaneLifecycle.renderLifecyclePane(); },
    get renderUsageStatsPane() { return settingsPaneUsageStats.renderUsageStatsPane; },
    get renderStoragePane() {
        // storage 条目渲染完追加「工作区防护」区（组合根接线，两 pane 不互相 import）
        return async () => {
            await settingsPaneStorage.renderStoragePane();
            if (settingsPaneWipeguard && typeof settingsPaneWipeguard.renderSection === 'function') {
                await settingsPaneWipeguard.renderSection();
            }
        };
    },
    // 外部工具已迁为应用页面标签页，settings-ui 不再渲染它（挂载器见 appPageMounters）
    get rt() { return rt; },
    get scheduleAutoSave() { return scheduleAutoSave; },
    get settings() { return settings; },
    get settingsKey() { return settingsKey; },
    get syncAllBrowserTabs() { return syncAllBrowserTabs; },
    get syncRunButtonState() { return syncRunButtonState; },
    get syncTerminalTheme() { return syncTerminalTheme; },
    get themes() { return themeRegistry.listUiThemes(); },
    get uiFonts() { return uiFonts; },
    get UNLOCK_ICON() { return UNLOCK_ICON; },
    get updateAiWidthWidget() { return updateAiWidthWidget; },
    get updateStatus() { return updateStatus; },
    get updateWritingStats() { return updateWritingStats; },
    get workspaceFolder() { return workspaceFolder; },
});
const {actRel, activityLog, applyIntegration, applyReadOnlyToDoc, applyRemoteSettings, applySettings, closeDialogs, closeTopDialog, getConfirmAction, setConfirmAction, countWords, currentTheme, cursorPositionForDoc, elsDialogs, elsSettings, getFormatSettings, installReadOnlyGuards, openDialogEl, openNameDialog, openSaveConflictDialog, openSettings, openSettingsAtRow, persistSettingsLight, reconcileThemes, refreshThemes, rtFullscreen, scheduleWordCount, selectSettingsPane, setCodeStyle, setIconTheme, setTheme, syncIntegrationStatus, setSyncedOpenMode, toggleAlwaysOnTop, toggleCodeWrap, toggleFullscreen, updateLockButton, updateWordCount} = settingsUI;
const writingUI = createWritingUI({
    set flashTimer(v) { flashTimer = v; },
    set dirty(v) { dirty = v; },
    set autoSaveTimer(v) { autoSaveTimer = v; },
    get nextCmdSeq() { return nextCmdSeq; },
    get activityLog() { return activityLog; },
    get syncRunConfigWidget() { return syncRunConfigWidget; },
    get addMessage() { return (...args) => messageCenter.add(...args); },
    get allFormatDefs() { return allFormatDefs; },
    get applyCsvTableZoom() { return applyCsvTableZoom; },
    get applyImageZoom() { return applyImageZoom; },
    get applyIntegration() { return applyIntegration; },
    get applySettings() { return applySettings; },
    get reconcileThemes() { return reconcileThemes; },
    get refreshThemes() { return refreshThemes; },
    get autoSaveTimer() { return autoSaveTimer; },
    get backend() { return backend; },
    get baseNameOf() { return baseNameOf; },
    get cjkFonts() { return cjkFonts; },
    get closeDialogs() { return closeDialogs; },
    get closeTopDialog() { return closeTopDialog; },
    get cmdExitHandlers() { return cmdExitHandlers; },
    get cmdOutHandlers() { return cmdOutHandlers; },
    get copyText() { return copyText; },
    get countWords() { return countWords; },
    get currentMode() { return currentMode; },
    get currentTheme() { return currentTheme; },
    get cursorPositionForDoc() { return cursorPositionForDoc; },
    get dirty() { return dirty; },
    get docs() { return docs; },
    get editor() { return editor; },
    get editorFonts() { return editorFonts; },
    get els() { return els; },
    get elsDialogs() { return elsDialogs; },
    get elsSettings() { return elsSettings; },
    get file() { return file; },
    get flashTimer() { return flashTimer; },
    get getConfirmAction() { return getConfirmAction; },
    get getFormatSettings() { return getFormatSettings; },
    get logFrontend() { return logFrontend; },
    get markDocDirty() { return markDocDirty; },
    get openDialogEl() { return openDialogEl; },
    get openNameDialog() { return openNameDialog; },
    get openPath() { return openPath; },
    get openPaths() { return openPaths; },
    get openSettings() { return openSettings; },
    get openVirtualDoc() { return openVirtualDoc; },
    get propsTimeText() { return propsTimeText; },
    get renderMarkdownPreview() { return renderMarkdownPreview; },
    get rt() { return rt; },
    get runArgsText() { return runArgsText; },
    get runController() { return runController; },
    get save() { return save; },
    get scheduleWordCount() { return scheduleWordCount; },
    get selectSettingsPane() { return selectSettingsPane; },
    get setConfirmAction() { return setConfirmAction; },
    get settings() { return settings; },
    get structurePanel() { return structurePanel; },
    get switchMode() { return switchMode; },
    get syncIntegrationStatus() { return syncIntegrationStatus; },
    get termCwd() { return termCwd; },
    get textArea() { return textArea; },
    get themes() { return themeRegistry.listUiThemes(); },
    get updateStatus() { return updateStatus; },
    get updateWindowTitle() { return updateWindowTitle; },
    get workspaceFolder() { return workspaceFolder; },
    // 关窗脏标记把便签的防抖窗口算进去（anyDirty 可能在 bridgeUI 解构前被调用，读早期 flag 防 TDZ）
    get memoHasPending() { return () => memoPendingFlag; },
});
const {CSV_COL_MIN_WIDTH, CSV_ROW_NUM_WIDTH, INDENTS, LANG_DEFS, TREE_MAX_CHILDREN, applyRunProfile, applyWritingFormat, applyWritingMode, canSplitDoc, cancelAutoSave, closeFootPopover, editorLocale, effectiveToolEnv, flash, fmtSize, formatDisplayName, insertSceneSeparator, isHtmlDoc, isSqlSupportedDoc, isSvgDoc, jumpToPosition, markdownRenderer, mdPreviewWidthLabel, normalizeLegacySqlMode, openConfirmDialog, openGotoDialog, openWritingNameDialog, renderEnvVarsPane, renderFmtTable, renderFormatPane, renderLangPane, renderMarkdownHtml, renderMermaidBlocks, renderPluginsPane, renderRunPane, resolveMarkdownImages, scheduleAutoSave, scheduleCursorPosition, scheduleWritingCaret, setDirty, splitKindFor, toggleWritingMode, toolEnvFor, updateAiWidthWidget, updateBackendDirty, updateCursorPosition, updateTabDirty, updateWindowTitle, updateWritingStats, viewDisabled, viewLabel, viewOptionsFor, writingFormatable} = writingUI;
const editorGroupsMod = createEditorGroups({
    set currentMode(v) { currentMode = v; },
    set dirty(v) { dirty = v; },
    set file(v) { file = v; },
    set editor(v) { editor = v; },
    set docSeq(v) { docSeq = v; },
    get activityLog() { return activityLog; },
    get aiPanel() { return aiPanel; },
    // 失败 / 后台事件通知（消息中心 + toast + 节流）：文件被外部改动未重载等
    get notifyFailure() { return (...args) => failureNotifier.notifyFailure(...args); },
    // 内容区有文档被打开/切到前台：解开编辑区收起态（见 revealEditorForContent）
    get onDocVisible() { return revealEditorForContent; },
    get aiReferenceFileMenuItems() { return aiReferenceFileMenuItems; },
    get applyReadOnlyToDoc() { return applyReadOnlyToDoc; },
    get applyEditorKeybindings() { return (aceEditor) => editorKeybindings.applyTo(aceEditor); },
    get applySettings() { return applySettings; },
    get applyWritingMode() { return applyWritingMode; },
    get backend() { return backend; },
    get baseNameOf() { return baseNameOf; },
    // 个人浏览器标签关闭时从恢复列表移除（shell/browser-tab-restore.js）
    get browserTabRestore() { return browserTabRestore; },
    get cancelAutoSave() { return cancelAutoSave; },
    get canSplitDoc() { return canSplitDoc; },
    get closeDialogs() { return closeDialogs; },
    get closedTabs() { return closedTabs; },
    get closeFootPopover() { return closeFootPopover; },
    // 原生 select 的浮层增强（设置页同款触发器 + Portal 浮层），补丁视图的「应用模式」用它去掉浏览器原生外观
    get enhanceSelect() { return settingsUI.enhanceSelect; },
    get copyText() { return copyText; },
    get createAgentView() { return createAgentView; },
    get createAgentTeamView() { return createAgentTeamView; },
    get createSideChatView() { return createSideChatView; },
    get createGroupMemberView() { return createGroupMemberView; },
    get createBgTermView() { return createBgTermView; },
    get createAppPageView() { return createAppPageView; },
    get createDbTabView() { return createDatabaseTabView; },
    get createMemoView() { return createMemoView; },
    get CSV_COL_MIN_WIDTH() { return CSV_COL_MIN_WIDTH; },
    get CSV_ROW_NUM_WIDTH() { return CSV_ROW_NUM_WIDTH; },
    get ctxMenu() { return ctxMenu; },
    get currentMode() { return currentMode; },
    get dirty() { return dirty; },
    get docs() { return docs; },
    get docSeq() { return docSeq; },
    get editor() { return editor; },
    get editorLocale() { return editorLocale; },
    get els() { return els; },
    get explorer() { return explorer; },
    get file() { return file; },
    get findDocByPath() { return findDocByPath; },
    get flash() { return flash; },
    get fmtSize() { return fmtSize; },
    get formatDisplayName() { return formatDisplayName; },
    get getFormatSettings() { return getFormatSettings; },
    get gitStateCache() { return gitStateCache; },
    get installReadOnlyGuards() { return installReadOnlyGuards; },
    get isHtmlDoc() { return isHtmlDoc; },
    get isSqlSupportedDoc() { return isSqlSupportedDoc; },
    get isSvgDoc() { return isSvgDoc; },
    get jumpToPosition() { return jumpToPosition; },
    get knownDocViews() { return knownDocViews; },
    get markdownRenderer() { return markdownRenderer; },
    get mdPreviewWidthLabel() { return mdPreviewWidthLabel; },
    get normalizeLegacySqlMode() { return normalizeLegacySqlMode; },
    get openBrowserTab() { return openBrowserTab; },
    get openConfirmDialog() { return openConfirmDialog; },
    get openDiffDialog() { return openDiffDialog; },
    get openInNewWindows() { return openInNewWindows; },
    get openNameDialog() { return openNameDialog; },
    get openPath() { return openPath; },
    get openSettings() { return openSettings; },
    get parentFolderOf() { return parentFolderOf; },
    get pathWithinValue() { return pathWithinValue; },
    get pendingDocViews() { return pendingDocViews; },
    get plainTextExtensions() { return plainTextExtensions; },
    get refreshStructureSources() { return refreshStructureSources; },
    get reloadActive() { return reloadActive; },
    get renderMarkdownHtml() { return renderMarkdownHtml; },
    get renderMermaidBlocks() { return renderMermaidBlocks; },
    get resolveMarkdownImages() { return resolveMarkdownImages; },
    get rt() { return rt; },
    get save() { return save; },
    get saveSessionNow() { return saveSessionNow; },
    get scheduleCursorPosition() { return scheduleCursorPosition; },
    get scheduleSessionSave() { return scheduleSessionSave; },
    get scheduleStructureRefresh() { return scheduleStructureRefresh; },
    get scheduleWordCount() { return scheduleWordCount; },
    get scheduleWritingCaret() { return scheduleWritingCaret; },
    get sessionPathKey() { return sessionPathKey; },
    get setDirty() { return setDirty; },
    get setDocReadOnly() { return setDocReadOnly; },
    get setDragCursor() { return setDragCursor; },
    get settings() { return settings; },
    get settingsKey() { return settingsKey; },
    get persistSettingsLight() { return persistSettingsLight; },
    get splitKindFor() { return splitKindFor; },
    get structurePanel() { return structurePanel; },
    get switchMode() { return switchMode; },
    get syncExplorerActive() { return syncExplorerActive; },
    get syncRunButtonState() { return syncRunButtonState; },
    get TREE_MAX_CHILDREN() { return TREE_MAX_CHILDREN; },
    get updateBackendDirty() { return updateBackendDirty; },
    get updateCursorPosition() { return updateCursorPosition; },
    get updateSearchState() { return updateSearchState; },
    get updateTabDirty() { return updateTabDirty; },
    get updateWindowTitle() { return updateWindowTitle; },
    get updateWordCount() { return updateWordCount; },
    get updateWritingStats() { return updateWritingStats; },
    get viewLabel() { return viewLabel; },
    get viewOptionsFor() { return viewOptionsFor; },
    get workspaceFolder() { return workspaceFolder; },
});
const {activateDoc, addDocToFocusedGroup, applyAceMode, applyCsvTableZoom, applyImageZoom, browserViewportLabel, closeDocNow, closeDocsWithConfirm, closeSqlView, createDoc, createDocEditor, createGroup, dismissBanner, doRedo, doUndo,  enterAudioView, enterBinaryView, enterCsvTable, enterHtmlPreview, enterImageView, enterMarkdownPreview, enterPluginView, enterSplitView, enterSqlView, enterSvgRender, enterTextView, enterVideoView, exitSplitView, expandAllWithGuard, flushCsvCellEditor,  groupDocs, setFocusedGroupId, setSplitRoot, groupOfDoc, handleAIWorkspaceFileChanged, handleExternalDocChanges, hideAudioView, hideBanner, hideHtmlPreview, hidePluginView, hideSvgRender, hideVideoView, hookCodeFoldRanges, hookMultiCursor, humanizeCounts, initCodeFoldHover, jumpBookmark, addBookmarkAt, removeBookmarkAt, clearDocBookmarks, leaveCsvTable, leaveHtmlPreview, leaveMarkdownPreview, markDocDirty, mdSyncScrollFromAce, moveTabInGroup, openWithDefaultApp, patchViewContext, refreshPatchMarkers, rememberDocView, renderBookmarks, renderBreadcrumb, renderCsvTableView, renderEditorLayout, renderMarkdownPreview, renderTabs, reopenClosedTab, releaseAudio, releaseVideo, requestCloseDoc, revertDocToSaved, scheduleGitGutter, setBrowserViewport, setFilename, showBanner, showHtmlPreview, showImageMenu, showMdPreviewMenu, showPathInFolder, showSvgMenu,  syncAllBrowserTabs, syncBrowserTab, syncTabReadOnly, textArea, toggleBookmark, toggleFocusedNode, updateBrowserTitle, updateDocChrome, updateStatus, zoomCsvTable, zoomImageBy, zoomSvgRenderBy} = editorGroupsMod;
// app_control 书签动作执行体（phase4 M2）：编辑器域函数经 getter 活引用注入。
const bookmarkActions = createBookmarkActions({
    getDocs: () => docs,
    getFile: () => file,
    findDocByPath,
    openPaths,
    selectLineInDoc,
    addBookmarkAt,
    removeBookmarkAt,
    clearDocBookmarks,
    rememberDocView,
});
// 内置类型表由 new-file-menu.js 单一来源派生；属性面板的「新建文档」菜单保持既有行为，
// 资源管理器右键的「新建」子菜单则按 settings.newFileMenu 合成（见 explorer-ops.js）。
const NEW_FILE_TYPES = BUILTIN_FILE_TYPES.filter((t) => t.group === 'top').map(({id, ...type}) => type);
const NEW_FILE_TYPES_MORE = BUILTIN_FILE_TYPES.filter((t) => t.group === 'more').map(({id, ...type}) => type);

function newFileTypeMenuItems(action) {
    return [
        ...NEW_FILE_TYPES.map((type) => fileTypeMenuItem(type, action)),
        {sep: true},
        {
            label: '更多',
            icon: 'more',
            submenu: NEW_FILE_TYPES_MORE.map((type) => fileTypeMenuItem(type, action)),
        },
    ];
}

// rememberScratchExt：临时草稿「上次用过的扩展名」（下一份草稿一键建的默认语言）。
// 只为一个字符串走整份 applySettings 会重刷主题/字体/写作模式，走 persistSettingsLight
// 轻量出口：同样落 localStorage + 广播（别窗内存副本不落旧值），但不做全量重绘。
function rememberScratchExt(ext) {
    const next = normalizeScratchExt(ext);
    if (settings.scratchExt === next) return next;
    settings.scratchExt = next;
    persistSettingsLight();
    return next;
}

// ---- 资源管理器域操作（explorer-ops.js） ----
// ---- 编辑器右键菜单域（editor-menus.js） ----
// ---- 结构面板域（structure-panel.js） ----
const structurePanelCtrl = createStructurePanelController({
    get STRUCTURE_CACHE_LIMIT() { return STRUCTURE_CACHE_LIMIT; },
    get aiPanel() { return aiPanel; },
    get applySidebarUI() { return applySidebarUI; },
    get copyStructureTree() { return copyStructureTree; },
    get createStructurePanel() { return createStructurePanel; },
    get ctxMenu() { return ctxMenu; },
    get currentMode() { return currentMode; },
    get currentSidebarView() { return currentSidebarView; },
    get els() { return els; },
    get exportStructureTree() { return exportStructureTree; },
    get file() { return file; },
    get iconSvg() { return iconSvg; },
    get parseStructure() { return parseStructure; },
    get selectLineInDoc() { return selectLineInDoc; },
    get settings() { return settings; },
    set settings(v) { settings = v; },
    get settingsKey() { return settingsKey; },
    get persistSettingsLight() { return persistSettingsLight; },
    get structureCache() { return structureCache; },
    get structurePanel() { return structurePanel; },
    set structurePanel(v) { structurePanel = v; },
    get structureRefreshTimer() { return structureRefreshTimer; },
    set structureRefreshTimer(v) { structureRefreshTimer = v; },
    get structureWorker() { return structureWorker; },
    set structureWorker(v) { structureWorker = v; },
    get structureWorkerBroken() { return structureWorkerBroken; },
    set structureWorkerBroken(v) { structureWorkerBroken = v; },
    get structureWorkerPending() { return structureWorkerPending; },
    get structureWorkerSeq() { return structureWorkerSeq; },
            set structureWorkerSeq(v) { structureWorkerSeq = v; },
});
const structureTextForDoc = (...a) => structurePanelCtrl.structureTextForDoc(...a);
const jumpToStructureNode = (...a) => structurePanelCtrl.jumpToStructureNode(...a);
const getStructureWorker = (...a) => structurePanelCtrl.getStructureWorker(...a);
const rememberStructureResult = (...a) => structurePanelCtrl.rememberStructureResult(...a);
const parseStructureCached = (...a) => structurePanelCtrl.parseStructureCached(...a);
const scheduleStructureRefresh = (...a) => structurePanelCtrl.scheduleStructureRefresh(...a);
const initStructurePanel = (...a) => structurePanelCtrl.initStructurePanel(...a);
const structureSources = (...a) => structurePanelCtrl.structureSources(...a);
const structureOutlineSnapshot = (...a) => structurePanelCtrl.structureOutlineSnapshot(...a);
const syncStructureChrome = (...a) => structurePanelCtrl.syncStructureChrome(...a);
const refreshStructureSources = (...a) => structurePanelCtrl.refreshStructureSources(...a);
const toggleStructureSource = (...a) => structurePanelCtrl.toggleStructureSource(...a);
const structureTreeText = (...a) => structurePanelCtrl.structureTreeText(...a);
const showStructureExportMenu = (...a) => structurePanelCtrl.showStructureExportMenu(...a);
const toggleStructureExportLineNums = (...a) => structurePanelCtrl.toggleStructureExportLineNums(...a);

const editorMenus = createEditorMenus({
    get aiEditorReferenceMenuItems() { return aiEditorReferenceMenuItems; },
    get applySettings() { return applySettings; },
    get backend() { return backend; },
    get closeFolder() { return closeFolder; },
    get closeReadingForEditor() { return closeReadingForEditor; },
    get copyText() { return copyText; },
    get createContextMenu() { return createContextMenu; },
    get createPalette() { return createPalette; },
    get createReadingMode() { return createReadingMode; },
    // 编辑器选区「存为临时草稿」：编排在 explorer-ops，这里只传选区文本与当前文档扩展名
    get createScratchFile() { return createScratchFile; },
    get ctxMenu() { return ctxMenu; },
    set ctxMenu(v) { ctxMenu = v; },
    get currentMode() { return currentMode; },
    get defaultFolderDir() { return defaultFolderDir; },
    get doRedo() { return doRedo; },
    get doUndo() { return doUndo; },
    get docs() { return docs; },
    get editor() { return editor; },
    get els() { return els; },
    get file() { return file; },
    get flash() { return flash; },
    get formatDocument() { return formatDocument; },
    get isDialogOpen() { return isDialogOpen; },
    get jumpToPosition() { return jumpToPosition; },
    get newDocument() { return newDocument; },
    get openDialog() { return openDialog; },
    get openFindBar() { return openFindBar; },
    get openFolderDialog() { return openFolderDialog; },
    get openPath() { return openPath; },
    get openSettings() { return openSettings; },
    get palette() { return palette; },
    set palette(v) { palette = v; },
    get paletteActions() { return paletteActions; },
    get pluginEditorMenuItems() { return pluginEditorMenuItems; },
    get readingMode() { return readingMode; },
    set readingMode(v) { readingMode = v; },
    get requestReload() { return requestReload; },
    get runController() { return runController; },
    get settings() { return settings; },
    get showImageMenu() { return showImageMenu; },
    get showInFolder() { return showInFolder; },
    get pickPreviewKind() { return pickPreviewKind; },
    get openLivePreview() {
        return () => {
            if (!file || !file.path) return;
            backend.OpenLivePreview(file.path).catch((e) => flash('打开实时预览窗失败：' + ((e && e.message) || e), true));
        };
    },
    get showMdPreviewMenu() { return showMdPreviewMenu; },
    get showSvgMenu() { return showSvgMenu; },
    get toggleBookmark() { return toggleBookmark; },
    get openBookmarkList() { return openBookmarkList; },
    get clearCurrentDocBookmarks() { return clearDocBookmarksCurrent; },
    get textArea() { return textArea; },
    get workspaceFolder() { return workspaceFolder; },
});
const selectedText = (...a) => editorMenus.selectedText(...a);
const ctxCopy = (...a) => editorMenus.ctxCopy(...a);
const ctxCut = (...a) => editorMenus.ctxCut(...a);
const ctxPaste = (...a) => editorMenus.ctxPaste(...a);
const ctxSelectAll = (...a) => editorMenus.ctxSelectAll(...a);
const ctxFind = (...a) => editorMenus.ctxFind(...a);
const ctxFold = (...a) => editorMenus.ctxFold(...a);
const showEditorMenu = (...a) => editorMenus.showEditorMenu(...a);
const showBlankMenu = (...a) => editorMenus.showBlankMenu(...a);
const initContextMenus = (...a) => editorMenus.initContextMenus(...a);

const explorerOps = createExplorerOps({
    get actRel() { return actRel; },
    get activityLog() { return activityLog; },
    get aiReferenceFileMenuItems() { return aiReferenceFileMenuItems; },
    get backend() { return backend; },
    get baseNameOf() { return baseNameOf; },
    get closeDocNow() { return closeDocNow; },
    get closedTabs() { return closedTabs; },
    set closedTabs(v) { closedTabs = v; },
    get copyStructuredDir() { return copyStructuredDir; },
    get copyText() { return copyText; },
    get ctxMenu() { return ctxMenu; },
    get docs() { return docs; },
    get explorer() { return explorer; },
    get exportStructuredDir() { return exportStructuredDir; },
    get file() { return file; },
    get fileClipboard() { return fileClipboard; },
    set fileClipboard(v) { fileClipboard = v; },
    get flash() { return flash; },
    get gitStateCache() { return gitStateCache; },
    get newFileTypeMenuItems() { return newFileTypeMenuItems; },
    get openSettings() { return openSettings; },
    get openConfirmDialog() { return openConfirmDialog; },
    get openDiffDialog() { return openDiffDialog; },
    get openFolderWorkspace() { return openFolderWorkspace; },
    get openInNewWindows() { return openInNewWindows; },
    get openNameDialog() { return openNameDialog; },
    get openPath() { return openPath; },
    get openWithDefaultApp() { return openWithDefaultApp; },
    get readingMode() { return readingMode; },
    get rememberScratchExt() { return rememberScratchExt; },
    get renderBreadcrumb() { return renderBreadcrumb; },
    get renderTabs() { return renderTabs; },
    get renderWorkspaceCrumbs() { return renderWorkspaceCrumbs; },
    get setFilename() { return setFilename; },
    get settings() { return settings; },
    get showFileProperties() { return showFileProperties; },
    get showGitDiff() { return showGitDiff; },
    get showPathInFolder() { return showPathInFolder; },
    // 空草稿建好后切到可写的视图（预览型格式首屏是预览，见 createScratchFile）
    get switchMode() { return switchMode; },
    get updateWindowTitle() { return updateWindowTitle; },
    get workspaceFolder() { return workspaceFolder; },
    set workspaceFolder(v) { workspaceFolder = v; },
});
const remapPathValue = (...a) => explorerOps.remapPathValue(...a);
const parentFolderOf = (...a) => explorerOps.parentFolderOf(...a);
const samePathValue = (...a) => explorerOps.samePathValue(...a);
const pathWithinValue = (...a) => explorerOps.pathWithinValue(...a);
const clipboardItems = (...a) => explorerOps.clipboardItems(...a);
const setFileClipboard = (...a) => explorerOps.setFileClipboard(...a);
const applyMovedPath = (...a) => explorerOps.applyMovedPath(...a);
const runPasteItems = (...a) => explorerOps.runPasteItems(...a);
const moveEntriesByDrag = (...a) => explorerOps.moveEntriesByDrag(...a);
const pasteFileClipboard = (...a) => explorerOps.pasteFileClipboard(...a);
const openCreateEntryDialog = (...a) => explorerOps.openCreateEntryDialog(...a);
const newFileMenuItems = (...a) => explorerOps.newFileMenuItems(...a);
// 临时草稿：编排在 explorer-ops（唯一实现），文件菜单 / 编辑器右键只经这两个别名复用
const createScratchFile = (...a) => explorerOps.createScratchFile(...a);
const scratchMenuItems = (...a) => explorerOps.scratchMenuItems(...a);
const applyRenamedPath = (...a) => explorerOps.applyRenamedPath(...a);
const deleteExplorerEntries = (...a) => explorerOps.deleteExplorerEntries(...a);
const openRenameEntryDialog = (...a) => explorerOps.openRenameEntryDialog(...a);
const relativePathFrom = (...a) => explorerOps.relativePathFrom(...a);
const copyPathMenuItems = (...a) => explorerOps.copyPathMenuItems(...a);
const showExplorerMenu = (...a) => explorerOps.showExplorerMenu(...a);


// closeReadingForEditor 退出阅读模式再打开编辑器（阅读模式不进标签页）
function closeReadingForEditor() {
    if (readingMode && readingMode.isActive()) readingMode.close();
}


function findDocByPath(path) {
    const key = String(path || '').replace(/\\/g, '/').toLowerCase();
    return docs.find((d) => String(d.path || '').replace(/\\/g, '/').toLowerCase() === key) || null;
}

// 运行配置的目标文件在某个标签里有未保存修改（磁盘目标运行前提示用）
function openDocDirtyByPath(path) {
    const doc = findDocByPath(path);
    return !!doc && !!doc.dirty;
}

// 配置编辑器选目标文件：只选路径不打开
async function pickRunFile() {
    try {
        return await backend.ShowOpenFileDialog('选择配置目标文件', '') || '';
    } catch (e) {
        flash('选择文件失败：' + e, true);
        return '';
    }
}

// 插件文档导入器编排拆到 shell/plugin-importer.js（phase4 M3）；UI/后端能力经 deps 注入。
const pluginImporter = createPluginImporter({
    elsDialogs,
    openConfirmDialog,
    flash: (...args) => flash(...args),
    get backend() { return backend; },
    openVirtualDoc: (...args) => openVirtualDoc(...args),
    activityLog,
});
const {openWithPluginImporter} = pluginImporter;

async function openPathsHere(paths, opts = {}) {
    const list = (paths || []).filter(Boolean);
    if (!list.length) return;
    // 打开文件时就带只读锁：只作用于新建/命中的这个标签，不影响全局锁与其它标签。
    const readOnly = !!(opts && opts.readOnly);
    let target = null;
    let lastNew = null;
    let lastError = null;
    for (const path of list) {
        const existing = findDocByPath(path);
        if (existing) {
            if (readOnly && !existing.readOnlyLocked) {
                setDocReadOnly(existing, true, {silent: true});
                if (existing.dirty) flash(existing.name + ' 有未保存修改，已设为只读；解锁后可保存');
            }
            target = existing;
            continue;
        }
        try {
            const base = String(path).split(/[\\/]/).pop();
            const preview = detectFormat(base, '');
            const enc = getFormatSettings(preview.id).encoding;
            const data = await backend.OpenFile(path, enc);
            if (data && data.isDir) {
                await openFolderSmart(data.path);
                continue;
            }
            // 内置解析不了（二进制视图）而插件声明能处理这个扩展名：问一句再用只读虚拟文档打开。
            // 拒绝 / 转换失败都返回 null，继续走下面的常规打开（不能因为导入失败就打不开文件）。
            const imported = await openWithPluginImporter(base, path, data);
            if (imported) {
                target = imported;
                lastNew = imported;
                continue;
            }
            const doc = createDoc(readOnly ? {...data, readOnly: true} : data);
            // 草稿目录里的文件天然是草稿：不管从「新建 → 临时文件」、草稿架还是最近打开进来，
            // 都拿到 doc.draft（静默落盘 / 关闭空草稿自动删只认这个标记）。
            if (isScratchPath(workspaceFolder, doc.path)) doc.draft = true;
            docs.push(doc);
            addDocToFocusedGroup(doc);
            rememberRecentOpen(doc.path, doc.name, false);
            activityLog.log('file.open', doc.path, {
                format: (doc.format && doc.format.id) || '',
                size: data.size || 0,
                batch: list.length > 1 ? list.length : undefined,
            });
            target = doc;
            lastNew = doc;
        } catch (e) {
            lastError = e;
        }
    }
    if (target) await activateDoc(lastNew || target);
    if (lastError) flash('打开失败：' + lastError, true);
}

async function openInNewWindows(paths) {
    try {
        await backend.OpenInNewWindows(paths);
        flash('已在新窗口打开 ' + paths.length + ' 个文件');
    } catch (e) {
        flash('打开新窗口失败：' + e, true);
    }
}

async function openPaths(paths, opts) {
    const list = (paths || []).filter(Boolean);
    if (!list.length) return;
    // 「以只读打开」是显式的标签级动作：即使设置了「新窗口打开」，也落在当前窗口，
    // 否则新窗口里的标签拿不到这把锁，功能就静默失效了。
    if (opts && opts.readOnly) {
        await openPathsHere(list, opts);
        return;
    }
    if (settings.openMode === 'window') {
        if (docs.length === 0) {
            await openPathsHere([list[0]], opts);
            if (list.length > 1) await openInNewWindows(list.slice(1));
        } else {
            await openInNewWindows(list);
        }
        return;
    }
    await openPathsHere(list, opts);
}

async function openPath(path, opts) {
    await openPaths([path], opts);
}

// 标签页只读锁：只改 doc 自己，不动全局 settings.readOnlyMode。
// 全局锁开着时解除标签锁仍然只读，提示里说清楚，免得用户以为坏了。
// 固定只读（审阅快照）不允许解锁：这是硬防线，菜单不给入口，这里再挡一次，
// 免得别的代码路径 / app_control 把 doc.readOnlyLocked 改掉后快照变成可编辑。
function setDocReadOnly(doc, locked, opts = {}) {
    if (!doc) return;
    if (doc.readOnlyFixed) {
        if (!locked) flash('只读快照不可解锁', true);
        return;
    }
    doc.readOnlyLocked = !!locked;
    applyReadOnlyToDoc(doc);
    syncTabReadOnly(doc);
    // 补丁视图对只读锁是呈现敏感的（可应用 ↔ 纯 diff 两种形态），锁一变必须重渲染：
    // 从锁→解锁要把应用入口带回来（需要重新预检），从解锁→锁要退化成纯 diff。
    if (doc.format && doc.format.patch && doc.patchState) {
        refreshPatchView(doc, patchViewContext()).catch(() => {});
    }
    if (doc === file) {
        updateStatus();
        syncRunButtonState();
    }
    if (!opts.silent) {
        flash(doc.readOnlyLocked
            ? (settings.readOnlyMode ? '本标签已只读锁定（全局只读锁也处于开启状态）' : '本标签已只读锁定，其它标签不受影响')
            : '已解除本标签只读锁定');
    }
}

function waitUntil(check, timeout = 1200) {
    return new Promise((resolve) => {
        const start = Date.now();
        const tick = () => {
            try {
                if (check()) return resolve(true);
            } catch (e) {}
            if (Date.now() - start >= timeout) return resolve(false);
            setTimeout(tick, 30);
        };
        tick();
    });
}

async function selectLineInDoc(doc, line, column = 0) {
    if (!doc || doc.binary || !doc.editor) return null;
    if (doc !== file) await activateDoc(doc);
    const mode = doc.format && doc.format.table ? 'text' : 'code';
    if (currentMode !== mode) switchMode(mode);
    if (mode === 'code') {
        const ready = await waitUntil(() => doc.editor && doc.editor.aceEditor);
        if (!ready) return null;
        const ace = doc.editor.aceEditor;
        const lineCount = ace.session.getLength();
        const requestedLine = Math.max(1, Math.round(Number(line) || 1));
        const lineNo = Math.min(requestedLine, lineCount);
        const lineText = ace.session.getLine(lineNo - 1) || '';
        const requestedColumn = Math.max(1, Math.round(Number(column) || 1));
        const columnNo = Math.min(requestedColumn, lineText.length + 1);
        ace.gotoLine(lineNo, columnNo - 1, false);
        // 只定位、不选中：跳过来就整行高亮，看起来像误触了选中（用户报的就是这个）。
        // 需要高亮区间时由调用方自己加 marker，不靠选区顶替。
        ace.clearSelection();
        ace.scrollToLine(lineNo, true, true, () => {});
        ace.focus();
        return {
            mode: 'code',
            line: lineNo,
            column: columnNo,
            lineCount,
            requestedLine,
            requestedColumn,
            clamped: lineNo !== requestedLine || columnNo !== requestedColumn,
        };
    }
    const ready = await waitUntil(() => doc.pane && doc.pane.querySelector('textarea.jsoneditor-text'));
    if (!ready) return null;
    const textarea = doc.pane.querySelector('textarea.jsoneditor-text');
    const lines = textarea.value.split('\n');
    const requestedLine = Math.max(1, Math.round(Number(line) || 1));
    const index = Math.min(requestedLine - 1, lines.length - 1);
    let start = 0;
    for (let i = 0; i < index; i++) start += lines[i].length + 1;
    textarea.focus();
    // 同上：光标落在行首即可，不把整行选成选区
    textarea.setSelectionRange(start, start);
    const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 18;
    textarea.scrollTop = Math.max(0, index * lineHeight - textarea.clientHeight / 2);
    return {
        mode: 'text',
        line: index + 1,
        column: 0,
        lineCount: lines.length,
        requestedLine,
        requestedColumn: 0,
        clamped: index + 1 !== requestedLine,
    };
}

// 结构视图读取的源文本：树视图用打开时的原文（行号与源文件一致），
// 代码/文本/预览用编辑器当前内容，SVG 渲染视图用进入渲染前保存的原文。

async function openTargets(targets) {
    const list = Array.isArray(targets) ? targets : [];
    for (const target of list) {
        if (!target || !target.path) continue;
        await openPaths([target.path]);
        if (!target.line) continue;
        const doc = findDocByPath(target.path);
        if (doc) await selectLineInDoc(doc, target.line, target.column);
    }
}

// —— 书签总览与 app_control 书签动作（数据纯函数在 editor/bookmark-list.js）——
// 口径：书签随会话快照只持久化打开中的标签页，聚合/增删只针对打开中的文档；
// 动作里 path 指到未打开文件时先打开（add/goto），未打开文件的删除直接报错。
function bookmarkOverviewForUI() {
    return bookmarkOverview(docs);
}

function openBookmarkList() {
    openQuickSwitchAt('bookmarks');
}

function clearDocBookmarksCurrent() {
    if (!file) {
        flash('当前没有打开的文件');
        return;
    }
    const count = clearDocBookmarks(file);
    if (!count) {
        flash('当前文件没有书签');
        return;
    }
    rememberDocView(file);
    flash('已清除 ' + count + ' 个书签');
}

function removeBookmarkEntry(entry) {
    const doc = findDocByPath(entry && entry.path);
    if (!doc) return false;
    const result = removeBookmarkAt(doc, Number(entry && entry.row) || 0);
    if (result.existed) rememberDocView(doc);
    return result.existed;
}

async function jumpBookmarkEntry(entry) {
    const path = entry && entry.path;
    if (!path) return;
    await openPaths([path]);
    const doc = findDocByPath(path);
    if (doc) await selectLineInDoc(doc, (Number(entry && entry.row) || 0) + 1);
}

async function openDialog() {
    try {
        const paths = await backend.OpenFilesDialog();
        const list = Array.isArray(paths) ? paths : (paths ? [paths] : []);
        if (list.length) await openPaths(list);
    } catch (e) {
        flash('打开失败：' + e, true);
    }
}

function baseNameOf(path) {
    const s = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
}

// 项目徽标：取目录名前两个词的首字母（CaDt-DataLens → CD）
function projectBadgeText(name) {
    const words = String(name || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9\u4e00-\u9fa5]+/)
        .filter(Boolean);
    if (!words.length) return '?';
    if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
}

// 标题栏：有工作区时显示「项目 + 当前分支」替代文件名；分支仅 git 仓库内显示
function renderWorkspaceCrumbs() {
    const hasWorkspace = !!workspaceFolder;
    if (els.filename) els.filename.classList.toggle('hidden', hasWorkspace);
    if (!els.wsCrumbs) return;
    els.wsCrumbs.classList.toggle('hidden', !hasWorkspace);
    if (!hasWorkspace) return;
    const name = baseNameOf(workspaceFolder) || workspaceFolder;
    els.wsProjectName.textContent = name;
    els.wsProjectBadge.textContent = projectBadgeText(name);
    let branch = '';
    try { branch = (gitStateCache.available && gitStateCache.branch) || ''; } catch (e) {}
    els.wsBranch.classList.toggle('hidden', !branch);
    els.wsBranchName.textContent = branch;
}

const titlebarPopovers = createTitlebarPopovers({
    get applyRunProfile() { return applyRunProfile; },
    get backend() { return backend; },
    get baseNameOf() { return baseNameOf; },
    get els() { return els; },
    get elsDialogs() { return elsDialogs; },
    get file() { return file; },
    get fileIconSpec() { return fileIconSpec; },
    get flash() { return flash; },
    get gitRootDir() { return gitRootDir; },
    get openFolderDialog() { return openFolderDialog; },
    get openFolderSmart() { return openFolderSmart; },
    get openNameDialog() { return openNameDialog; },
    get openSettings() { return openSettings; },
    get openVirtualDoc() { return openVirtualDoc; },
    get projectBadgeText() { return projectBadgeText; },
    get readRecentOpen() { return readRecentOpen; },
    get refreshGitStatus() { return refreshGitStatus; },
    get reloadAllFromDisk() { return reloadAllFromDisk; },
    get samePathValue() { return samePathValue; },
    get settings() { return settings; },
    get switchSidebarView() { return switchSidebarView; },
    get workspaceFolder() { return workspaceFolder; },
});
const {closeGitBranchPopover, closeRunConfigPopover, gitPopNewBranch, gitPopOpenCommit, gitPopPush, gitPopUpdateProject, showBranchMenu, showProjectMenu, showRunConfigMenu, syncRunConfigWidget, touchRunProfileRecency} = titlebarPopovers;


function defaultFolderDir() {
    if (workspaceFolder) return workspaceFolder;
    if (file && file.path) {
        const s = String(file.path).replace(/\\/g, '/');
        const i = s.lastIndexOf('/');
        if (i > 0) return s.slice(0, i);
    }
    return '';
}

async function openFolderDialog() {
    try {
        const dir = await backend.OpenFolderDialog(defaultFolderDir());
        if (dir) await openFolderSmart(dir);
    } catch (e) {
        flash('打开文件夹失败：' + e, true);
    }
}

// ===== 跨窗口会话复用（方案 docs/finished-plans/multi-window-session-reuse.md）=====

// 本窗口可匹配工作区登记（fire-and-forget；Go 侧浮窗/调试窗静默忽略，失败走日志）。
function syncWindowRegRegistration(dir) {
    if (!backend.WindowRegister) return;
    Promise.resolve(backend.WindowRegister(dir || ''))
        .catch((e) => console.error('window-register: 工作区登记失败', e));
}

// 单条「跨窗口复用会话」请求的处理（P2 由 app-open-ai-session 事件直达）：
// 本窗口工作区仍匹配 → 开面板 + 切到请求的会话并前置；否则只记日志（源窗口已按命中处理）。
async function handleReuseSessionRequest(req) {
    const wantKey = sessionPathKey(req && req.workspace);
    if (!req || !req.sessionId || !wantKey) return 'mismatch';
    if (wantKey !== sessionPathKey(workspaceFolder)) return 'mismatch';
    if (!aiPanel || typeof aiPanel.bridgeSwitchSession !== 'function') return 'mismatch';
    // 面板收着时先强制展开：只切会话不开面板的话，用户只看到窗口前置、画面无任何变化
    //（与 focusAISession 同做法；open(true) = 强制打开，无参 open() 是 toggle 语义会关面板）
    if (typeof aiPanel.open === 'function') {
        try { aiPanel.open(true); } catch (e) { /* 展开失败不阻断切换 */ }
    }
    try {
        const res = await aiPanel.bridgeSwitchSession(String(req.sessionId));
        // switchSession 对「会话已删 / 软切换短路 / 支线重定向到母会话」不报错——
        // 用返回值校验是否真的落到了请求的那个会话上，没落地按 mismatch 让投递方兜底
        if (!res || res.id !== String(req.sessionId)) return 'mismatch';
        try {
            if (backend.WindowActivate) await backend.WindowActivate();
        } catch (e) {
            // 置前失败不影响会话已打开
        }
        return 'ok';
    } catch (e) {
        return 'mismatch'; // 会话已删/懒加载失败：投递方兜底（新窗口按 --ai-session 自行处理）
    }
}

function openFolderWorkspace(dir) {
    if (!dir) return;
    if (workspaceFolder && sessionPathKey(dir) !== sessionPathKey(workspaceFolder)) {
        // 切换工作区前先落盘旧工作区环境（per-workspace 会话恢复需要）。
        saveSessionNow();
        // 预指令：切走 = 旧工作区的 workspace-close 事件（fire-and-forget，不阻塞切换）
        Promise.resolve(lifecycleHooksCtl.runForWorkspaceClose(workspaceFolder))
            .catch((e) => console.error('lifecycle: 关闭执行失败', e));
    }
    workspaceFolder = dir;
    // 窗口注册表：本窗口可匹配工作区更新（fire-and-forget；失败由日志吸收）
    syncWindowRegRegistration(dir);
    // Maven 图标显隐随工作区重算（pom 探测 + 工具链惰性扫描在面板内做，见 maven-panel.js）
    if (mavenUi) mavenUi.syncTrigger();
    // 快捷便签：工作区变了，丢弃旧工作区的缓存并刷新打开中的面板
    if (memoWorkspaceChanged) memoWorkspaceChanged();
    toggleSidebarFilter(false);
    scheduleSessionSave();
    rememberRecentOpen(dir, baseNameOf(dir) || dir, true);
    settings.sidebarMode = 'tree';
    settings.showSidebar = true;
    applySettings();
    if (explorer) {
        explorer.setMode('tree', false);
        explorer.setRoot(dir);
    }
    syncWorkspaceWatcher();
    applySidebarUI();
    renderWorkspaceCrumbs();
    updateWindowTitle();
    refreshGitStatus();
    if (aiPanel && aiPanel.refreshSessionList) aiPanel.refreshSessionList();
    if (aiPanel && aiPanel.refreshSessionBadge) aiPanel.refreshSessionBadge();
    activityLog.log('workspace.open', dir, {}, {noRel: true});
    flash('已打开文件夹：' + (baseNameOf(dir) || dir));
    // 预指令：打开（含启动恢复 / 切回）后自动执行该工作区的启用条目；单条失败在
    // runForWorkspace 内部消化，这里只兜底不让打开流程被预指令中断
    Promise.resolve(lifecycleHooksCtl.runForWorkspace(dir)).catch((e) => console.error('lifecycle: 执行失败', e));
}

// 一目录一窗口：本窗口已有工作区目录时，新目录另开窗口；
// 当前窗口没有目录时才在本窗口打开。
async function openFolderSmart(dir) {
    if (!dir) return;
    if (workspaceFolder) {
        const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        if (norm(dir) === norm(workspaceFolder)) {
            flash('该目录已在当前窗口打开');
            return;
        }
        try {
            if (backend.OpenDirInNewWindow) await backend.OpenDirInNewWindow(dir);
            else await backend.OpenInNewWindows([dir]);
            flash('已在新窗口打开：' + (baseNameOf(dir) || dir));
        } catch (e) {
            flash('打开新窗口失败：' + e, true);
        }
        return;
    }
    openFolderWorkspace(dir);
}

function closeFolder() {
    if (!workspaceFolder) return;
    const closedDir = workspaceFolder;
    saveSessionNow({allowEmpty: true});
    workspaceFolder = null;
    // 窗口注册表：清掉本窗口的可匹配工作区（空串 = 退出匹配集合）
    syncWindowRegRegistration('');
    // Maven 图标显隐随工作区重算（关工作区后图标应隐藏）
    if (mavenUi) mavenUi.syncTrigger();
    if (memoWorkspaceChanged) memoWorkspaceChanged();
    // 工作区破坏防护：无工作区时停掉周期校准（诱饵与备份随工作区走）
    if (wipeguardCtrl) wipeguardCtrl.stopCalibrationLoop();
    if (explorer) explorer.setRoot(null);
    syncWorkspaceWatcher();
    gitStateCache.available = false;
    gitStateCache.branch = '';
    renderWorkspaceCrumbs();
    updateWindowTitle();
    notifyAIGitEntry();
    scheduleSessionSave();
    if (aiPanel && aiPanel.refreshSessionList) aiPanel.refreshSessionList();
    if (aiPanel && aiPanel.refreshSessionBadge) aiPanel.refreshSessionBadge();
    flash('已关闭文件夹');
    // 预指令：显式关闭工作区触发 workspace-close 事件（fire-and-forget，不阻塞关闭流程；
    // 应用整体退出不走这里——退出路径没有可靠等待窗口，见方案 §6）
    Promise.resolve(lifecycleHooksCtl.runForWorkspaceClose(closedDir))
        .catch((e) => console.error('lifecycle: 关闭执行失败', e));
}

function applySidebarUI() {
    if (!els.sidebar) return;
    els.sidebar.classList.toggle('hidden', !settings.showSidebar);
    els.sidebar.dataset.sidebarView = currentSidebarView();
    if (els.btnSidebar) {
        els.btnSidebar.classList.toggle('active', !!settings.showSidebar);
        els.btnSidebar.setAttribute('aria-pressed', String(!!settings.showSidebar));
    }
    if (els.abFiles) {
        // 文件 icon 在文件侧边栏可见时保持选中，列表/树模式都算
        const filesActive = !!settings.showSidebar && settings.sidebarView === 'files';
        els.abFiles.classList.toggle('active', filesActive);
        els.abFiles.setAttribute('aria-pressed', String(filesActive));
    }
    if (els.abGit) {
        const gitActive = !!settings.showSidebar && settings.sidebarView === 'git';
        els.abGit.classList.toggle('active', gitActive);
        els.abGit.setAttribute('aria-pressed', String(gitActive));
    }
    if (els.abStructure) {
        const structureActive = !!settings.showSidebar && settings.sidebarView === 'structure';
        els.abStructure.classList.toggle('active', structureActive);
        els.abStructure.setAttribute('aria-pressed', String(structureActive));
    }
    if (els.abChats) {
        const chatsActive = !!settings.showSidebar && settings.sidebarView === 'chats';
        els.abChats.classList.toggle('active', chatsActive);
        els.abChats.setAttribute('aria-pressed', String(chatsActive));
    }
    if (els.abAppPages) {
        const appPagesActive = !!settings.showSidebar && settings.sidebarView === 'app-pages';
        els.abAppPages.classList.toggle('active', appPagesActive);
        els.abAppPages.setAttribute('aria-pressed', String(appPagesActive));
    }
    if (els.abDatabase) {
        const dbActive = !!settings.showSidebar && settings.sidebarView === 'database';
        els.abDatabase.classList.toggle('active', dbActive);
        els.abDatabase.setAttribute('aria-pressed', String(dbActive));
    }
    if (els.abMaven) {
        const mavenActive = !!settings.showSidebar && settings.sidebarView === 'maven';
        els.abMaven.classList.toggle('active', mavenActive);
        els.abMaven.setAttribute('aria-pressed', String(mavenActive));
    }
    // 切进应用页面面板时按需渲染（首次 / 注册表变动后）
    if (els.sidebar.dataset.sidebarView === 'app-pages' && !document.querySelector('#app-pages-nav .app-pages-nav-item')) {
        try { renderAppPagesNav(); } catch (e) {}
    }
    // 切进数据库面板时重绘（工作区清单可能被别的窗口改过）；dbUi 建得晚，经早期 hook 间接层
    if (els.sidebar.dataset.sidebarView === 'database' && dbSidebarRenderHook) {
        try { dbSidebarRenderHook(); } catch (e) {}
    }
    // 切进 Maven 面板时重绘（触发判定 / 项目结构可能变过）
    if (els.sidebar.dataset.sidebarView === 'maven' && mavenSidebarRenderHook) {
        try { mavenSidebarRenderHook(); } catch (e) {}
    }
    const filesVisible = !!settings.showSidebar && currentSidebarView() === 'files';
    if (explorer) explorer.setVisible(filesVisible);
    if (structurePanel) structurePanel.setVisible(!!settings.showSidebar && currentSidebarView() === 'structure');
    refreshStructureSources();
    requestAnimationFrame(() => {
        if (!editor) return;
        try {
            if (editor.resize) editor.resize();
            if (editor.aceEditor) editor.aceEditor.resize();
        } catch (e) {}
    });
}

function toggleSidebar(force) {
    settings.showSidebar = typeof force === 'boolean' ? force : !settings.showSidebar;
    applySettings();
    applySidebarUI();
}

function setSidebarMode(mode) {
    if (mode !== 'list' && mode !== 'tree') return;
    settings.sidebarMode = mode;
    settings.showSidebar = true;
    applySettings();
    if (explorer) explorer.setMode(mode, false);
    syncWorkspaceWatcher();
    applySidebarUI();
}

// 文件树跟随活动文件。opts.reveal=false（切换标签页走这条）：只更新高亮，
// 不展开目录、不滚动 —— 对齐 JetBrains，切标签不动文件树视图。
// 需要「把当前文件摆到眼前」时用侧栏的「定位当前文件」按钮（explorer.revealActiveFile）。
function syncExplorerActive(opts) {
    if (explorer) explorer.setActive(file && file.path ? file.path : null, opts);
    syncWorkspaceWatcher();
}

// 文件监听跟随当前树根/工作区；失败时静默降级到轮询
function syncWorkspaceWatcher() {
    if (!backend) return;
    const root = (explorer && explorer.getRoot ? explorer.getRoot() : workspaceFolder) || '';
    if (root === watchedWorkspaceRoot) return;
    watchedWorkspaceRoot = root;
    try {
        if (root && typeof backend.WatchWorkspace === 'function') backend.WatchWorkspace(root).catch(() => {});
        else if (!root && typeof backend.UnwatchWorkspace === 'function') backend.UnwatchWorkspace().catch(() => {});
    } catch (e) {}
}

// 标题栏 ▶ 与工具菜单保持一致的可用状态（菜单是在打开时算的，按钮要随文件切换实时同步）。
// 绑定文件的配置激活时，▶ 的可用性跟随配置目标文件而不是当前文档；widget 标签一并刷新。
function syncRunButtonState() {
    if (!els.tbRun) return;
    const cfg = activeRunConfig(settings);
    if (cfg && cfg.file) {
        const targetName = String(cfg.file).replace(/\\/g, '/').split('/').pop();
        const supported = !!RECIPES[extOf(targetName)];
        els.tbRun.disabled = !supported;
        els.tbRun.dataset.tip = supported ? '运行配置「' + cfg.name + '」 (F5)'
            : '配置目标文件不支持运行：' + (targetName || cfg.file);
    } else {
        const ro = isDocReadOnly(file, settings);
        const supported = !!file && !file.binary && !file.large &&
            !!RECIPES[extOf(file.name || file.path)] && !ro;
        els.tbRun.disabled = !supported;
        els.tbRun.dataset.tip = supported || !file ? '运行当前文件 (F5)'
            : ro ? (isTabReadOnlyLocked(file) ? '本标签已只读，不执行代码' : '只读模式下不执行代码')
                : '当前文件不支持运行';
    }
    if (syncRunConfigWidget) syncRunConfigWidget();
}

function initActivityBar() {
    syncRunButtonState();
    if (!els.activityBar) return;
    if (els.abFiles) els.abFiles.addEventListener('click', () => toggleSidebarView('files'));
    if (els.abStructure) els.abStructure.addEventListener('click', () => toggleSidebarView('structure'));
    // 搜索入口已从活动栏移除（Ctrl+F / Ctrl+Shift+F 与菜单「编辑」两项兜底）：
    // 活动栏只留面板开关。
    if (els.tbRun) els.tbRun.addEventListener('click', () => runController.run());
    if (els.tbRunConfig) els.tbRunConfig.addEventListener('click', () => showRunConfigMenu(els.tbRunConfig));
    // 浏览器入口已从活动栏移到「应用页面」侧栏面板与文件菜单：
    // 活动栏只留面板开关，一次性动作不该和开关抢位置。
    // 快捷便签面板：一次性打开成内容区标签页
    if (els.abMemo) els.abMemo.addEventListener('click', () => openMemoTab());
    if (els.editorCollapseStrip) els.editorCollapseStrip.addEventListener('click', () => toggleEditorCollapsed());
    if (els.abTerminal) els.abTerminal.addEventListener('click', () => toggleDockView('terminal'));
    if (els.abGitGraph) els.abGitGraph.addEventListener('click', () => toggleDockView('graph'));
    if (els.abDebug) els.abDebug.addEventListener('click', () => toggleDockView('debug'));
    if (els.abGit) els.abGit.addEventListener('click', () => toggleSidebarView('git'));
    if (els.abChats) els.abChats.addEventListener('click', () => toggleSidebarView('chats'));
    if (els.abAppPages) els.abAppPages.addEventListener('click', () => toggleAppPagesPanel());
    if (els.abDatabase) els.abDatabase.addEventListener('click', () => toggleSidebarView('database'));
    if (els.abMaven) els.abMaven.addEventListener('click', () => toggleSidebarView('maven'));
    if (els.abMore) els.abMore.addEventListener('click', () => {
        if (!ctxMenu) return;
        const rect = els.abMore.getBoundingClientRect();
        // 「视图与工具窗口」：视图菜单 + 应用页面（使用统计 / 外部工具 / 定时任务 / 操作记录 / 补丁库）。
        // 应用页面是内容区标签页，这里给鼠标党一个直达入口（菜单「工具」与命令面板另有入口）。
        ctxMenu.open([
            ...menuItems('view'),
            {sep: true},
            {
                label: '应用页面',
                icon: 'list',
                submenu: appPageGroups(settings).flatMap((group, index) => [
                    ...(index ? [{sep: true}] : []),
                    ...group.pages.map((page) => ({
                        label: page.label,
                        icon: page.icon,
                        action: () => openAppPageTab(page.id),
                    })),
                ]),
            },
        ], rect.right + 6, rect.top - 4);
    });
    if (els.abSettings) els.abSettings.addEventListener('click', () => openSettings('general'));
    if (els.abAbout) els.abAbout.addEventListener('click', () => openSettings('about'));
    applySidebarUI();
    updateLockButton();
}

function toggleAIPanel(force) {
    if (!aiPanel) initAIPanel();
    if (aiPanel) aiPanel.toggle(force);
}

// 编辑区收起：把内容区位置让给 AI 助手（标签页保留），收起条可随时恢复。
// 收起有**两个原因**（手动点收起条 / AI 工作时自动让位），必须分开记账——AI 回合结束时
// 只还原「自己收起的」，绝不把用户刻意收起的编辑区顶开（反之亦然）。
// 会话态不持久化——AI 面板是惰性初始化，重启后未打开则自然回到展开态。
let editorCollapseReason = ''; // '' 展开 | 'manual' 用户收起 | 'auto' AI 让位
// 自动让位的粘性位：用户手动展开过之后，**当前这次让位过程**内不再自动收起（不跟用户抢）。
// 回合开始与切会话都会清零——它不是固定锁，只保护「用户刚表达过要看的这一刻」。
// 「始终不要自动收起」是开关 settings.aiAutoCollapseEditor 的事。
let autoCollapseSuppressed = false;
let autoCollapseSessionId = '';

function isEditorCollapsed() { return !!editorCollapseReason; }

function setEditorCollapsed(next, reason) {
    const target = !!next;
    const was = !!editorCollapseReason;
    if (target) {
        if (!aiPanel) initAIPanel();
        if (!aiPanel) { flash('AI 面板不可用', true); return; }
        if (aiPanel.isOpen && !aiPanel.isOpen()) aiPanel.open(true);
        editorCollapseReason = reason === 'auto' ? 'auto' : 'manual';
    } else {
        editorCollapseReason = '';
    }
    const topRow = document.getElementById('top-row');
    if (topRow) topRow.classList.toggle('ai-editor-collapsed', target);
    // 展开瞬间（收起→展开的真实过渡）重量标签条 spacer 并按需补发激活标签定位：
    // 收起期间 #main-pane display:none，期间打开文件 / 重建标签条（AI 面板点文件链接）
    // 量不到右侧工具区宽度，spacer 被记成 0，展开后末尾标签被工具区盖住滚不出来。
    // 收起方向不用管——hidden 态里量了也是 0，保持展开前的旧值即可。
    if (!target && was) editorGroupsMod.refreshTabStripSpacers();
    if (els.editorCollapseStrip) {
        els.editorCollapseStrip.setAttribute('aria-pressed', String(target));
        els.editorCollapseStrip.classList.toggle('active', target);
        els.editorCollapseStrip.dataset.tip = target ? '展开编辑区' : '收起编辑区（标签页保留，位置让给 AI 助手）';
    }
    updateAiWidthWidget();
    if (editor && editor.resize) {
        try { editor.resize(); } catch (e) {}
    }
    try { if (terminalUI.open) fitActiveTerm(); } catch (e) {}
}

// 收起条 / 视图菜单共用的手动开合：手动展开一律记「别再自动收我」。
function toggleEditorCollapsed() {
    if (isEditorCollapsed()) {
        autoCollapseSuppressed = true;
        setEditorCollapsed(false, 'manual');
    } else {
        setEditorCollapsed(true, 'manual');
    }
}

// 内容区出现内容就解开收起态：文件、浏览器、子代理详情、后台终端……全部经
// activateDoc → updateDocChrome 收敛到这一条路。
// 只在「停靠分屏 + 开关打开」时展开（settings.editorExpandOnNewTab，默认开）：
// 全屏盖住内容区、悬浮是另一个窗口，展开都看不见，没必要动布局。
// 这里不置粘性位：下一个回合 AI 仍然可以再次让位。
function revealEditorForContent() {
    const expand = shouldExpandEditorOnTab({
        enabled: settings.editorExpandOnNewTab !== false,
        collapsed: !!editorCollapseReason,
        mode: (aiPanel && aiPanel.getMode) ? aiPanel.getMode() : 'dock',
    });
    if (expand) setEditorCollapsed(false);
}

// AI 回合驱动自动让位：回合开始收一次、结束还原一次。attachStream / detachStream 是
// 按会话整轮触发（含中间多步工具调用），所以不会随流式每帧闪。
// 判定本身在 ai-auto-collapse.js（纯函数、可测），这里只做 DOM 动作。
function applyAutoCollapse(running, sessionId, isCurrent) {
    // 会话归属变了 = 换了会话看：清粘性位（用户的展开意图只对本会话有效）
    if (sessionId && sessionId !== autoCollapseSessionId) {
        autoCollapseSessionId = sessionId;
        autoCollapseSuppressed = false;
    }
    // 新回合 = 重新给「自动让位」一次机会。粘性位只保护本次让位过程，
    // 不是永久锁——想长期不收请关掉 settings.aiAutoCollapseEditor。
    if (running) autoCollapseSuppressed = false;
    const action = decideAutoCollapse({
        enabled: settings.aiAutoCollapseEditor === true,
        isCurrent,
        running,
        collapseReason: editorCollapseReason,
        suppressed: autoCollapseSuppressed,
        mode: (aiPanel && aiPanel.getMode) ? aiPanel.getMode() : 'dock',
        panelOpen: !!(aiPanel && aiPanel.isOpen && aiPanel.isOpen()),
        hasDirtyDoc: docs.some((doc) => doc && doc.dirty),
    });
    if (action === 'collapse') setEditorCollapsed(true, 'auto');
    else if (action === 'expand') setEditorCollapsed(false);
}

// AI 面板关闭时自动还原编辑区，避免内容区只剩侧边栏
if (els.editorCollapseStrip) {
    const aiPanelEl = document.getElementById('ai-panel');
    if (aiPanelEl) {
        new MutationObserver(() => {
            if (editorCollapseReason && aiPanelEl.classList.contains('hidden')) setEditorCollapsed(false);
        }).observe(aiPanelEl, {attributes: true, attributeFilter: ['class']});
    }
}

// AI 引用统一入口：打开面板（若关着）→ 只挂路径引用（<file_reference>，内容由模型自己 read_file）
// → 聚焦输入框。资源管理器 / 标签页 / 编辑器右键的「引用该文件」都走这里；不读内容，大文件与二进制也能引用。
function aiReferencePath(path, name) {
    if (!path) return;
    if (!aiPanel) initAIPanel();
    if (!aiPanel || !aiPanel.referencePath) {
        flash('AI 面板不可用', true);
        return;
    }
    aiPanel.open(true);
    aiPanel.referencePath(path, name || '');
}

// 外部拖放（整块 AI 面板是落点，见 shell/file-drop-router.js）：把一批文件附加进输入区。
// 图片走降采样图片通道、视频走 base64 视频通道、其余按文本读（读不了正文自动降级为路径引用）。
// 群聊视图没有附件能力——明确说一句，而不是静默把附件塞进看不见的会话输入区。
function attachPathsToAI(paths) {
    const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
    if (!list.length) return Promise.resolve();
    if (!aiPanel) initAIPanel();
    if (!aiPanel || typeof aiPanel.attachPaths !== 'function') {
        flash('AI 面板不可用', true);
        return Promise.resolve();
    }
    const panelEl = document.getElementById('ai-panel');
    if (panelEl && panelEl.classList.contains('ai-group-mode')) {
        flash('群聊视图暂不支持附件：切回普通会话后再把文件拖进来', true);
        return Promise.resolve();
    }
    aiPanel.open(true);
    return Promise.resolve(aiPanel.attachPaths(list)).catch((e) => {
        flash('附加失败：' + ((e && e.message) || e), true);
    });
}

// 运行面板「发给 AI 分析」：只预填输入框，发送与否由用户决定（不自动触发模型调用）
function openAIPanelWithDraft(text) {
    if (!aiPanel) initAIPanel();
    if (!aiPanel || !aiPanel.bridgeSetDraft) {
        flash('AI 面板不可用', true);
        return;
    }
    aiPanel.bridgeSetDraft(text);
}

// 右键菜单的 AI 引用入口（引用该文件 / 引用选取）：不再要求面板已打开——
// 点击时自动开面板；同一文件（标签页 / 资源管理器 / 编辑器右键）只有一个入口，不再并排两个 AI 项。
// 图标统一走注册表的 sparkles（原 20 网格手写星花已删除）。
function aiReferenceFileMenuItems(doc) {
    if (!doc || !doc.path) return [];
    return [{
        label: '引用该文件',
        icon: 'sparkles',
        action: () => aiReferencePath(doc.path, doc.name || ''),
    }];
}

function aiEditorReferenceMenuItems() {
    if (!file || !file.path) return [];
    const selected = selectedText();
    if (selected && selected.trim()) {
        const caret = appActionDocCaret(file);
        if (caret.selection) {
            return [{
                label: '引用选取',
                icon: 'sparkles',
                action: () => {
                    if (!aiPanel) initAIPanel();
                    if (!aiPanel || !aiPanel.referenceSelection) {
                        flash('AI 面板不可用', true);
                        return;
                    }
                    aiPanel.open(true);
                    aiPanel.referenceSelection();
                },
            }];
        }
    }
    return [{
        label: '引用该文件',
        icon: 'sparkles',
        action: () => aiReferencePath(file.path, file.name || ''),
    }];
}

function setAIPanelMode(mode) {
    if (!aiPanel) initAIPanel();
    if (aiPanel) aiPanel.setMode(mode);
}

// 消息中心：状态栏【消息】入口 + 浮层面板 + 持久化队列（AI notify_send / 失败·提问·审批 / 版本更新进这里；
// 例行「任务完成」不进——会刷屏，见 ai/core/ai-notify-policy.js）。
// toast 点击与消息行点击：带 actionId 的分派动作（如打开更新对话框），否则跳转到对应 AI 会话。
// 跳转逻辑被 focusAISession 收口：系统通知点击（ai-notify-activate 事件）走同一条路。
function focusAISession(sessionId) {
    if (!sessionId) return;
    if (!aiPanel) initAIPanel();
    if (!aiPanel || !aiPanel.switchSession) return;
    aiPanel.open(true); // 强制打开：面板已开时无参 open() 是 toggle 关闭语义，会把面板关掉
    try { aiPanel.switchSession(sessionId); } catch (e) {}
}

// 系统通知点击（Go 侧 COM 激活回调 → WindowShow + ai-notify-activate 事件）：
// payload 形如 "ai-session=<id>"，解析出自带会话就跳；其余只享受「窗口已拉回前台」。
function handleNotifyActivation(payload) {
    const hit = /(?:^|&)ai-session=([^&]+)/.exec(String(payload || ''));
    if (!hit) return;
    try { focusAISession(decodeURIComponent(hit[1])); } catch (e) {}
}

const messageCenter = createMessageCenter({
    focusSession: focusAISession,
    runAction: (actionId) => {
        if (actionId === 'open-update-dialog') {
            // 重新检查并打开更新对话框（结果比消息里的快照新鲜）
            if (updateCheck) updateCheck.checkForUpdates();
        }
        if (actionId === 'open-wipeguard-settings') {
            // 直达 设置 → 存储与清理 → 工作区防护：openSettings 内部会 selectSettingsPane('storage')
            // 触发 renderStoragePane（含工作区防护区），渲染完滚到区块并短暂高亮
            openSettings('storage');
            setTimeout(() => {
                const host = document.getElementById('wipe-guard-section');
                if (!host) return;
                host.scrollIntoView({behavior: 'smooth', block: 'start'});
                host.classList.add('wg-flash');
                setTimeout(() => host.classList.remove('wg-flash'), 1600);
            }, 150);
        }
    },
});
window.__lens.messageCenter = messageCenter;

// 失败 / 后台事件统一通知出口：静默失败送消息中心 + 右下角 toast，按 key 节流防刷屏。
// 只给 A/B 级清单用（落盘失败、多实例冲突、定时任务、子代理等）；即时反馈仍走 flash。
// 创建晚于 editorGroups / explorerOps（它们在 2356 / 2589 行），故那些域经 getter 延迟取用。
const failureNotifier = createFailureNotifier({
    addMessage: (msg, opts) => messageCenter.add(msg, opts),
});
window.__lens.failureNotifier = failureNotifier;

// 存储自动清理驱动器（设置 → 存储与清理）：启动后 2 分钟 + 每 6 小时各检查一次，
// 开关关闭或浮窗/调试控制台窗口内不做任何事。判定与范围纯函数在 settings-pane-storage.js。
const storageAutoClean = createStorageAutoClean({
    get backend() { return backend; },
    get settings() { return settings; },
    get notify() { return (...args) => messageCenter.add(...args); },
    get activity() { return activityLog; },
    get logFrontend() { return logFrontend; },
});
storageAutoClean.start();

// 工作区破坏防护控制器（ai/security/ai-wipeguard.js，方案 docs/finished-plans/workspace-wipe-guard.md）：
// 两信号检测（watcher 滚动净消失计数为主 + 指纹兜底）→ critical 时**不停会话**，只出
// 状态栏红条并向活跃会话插队投递应用消息（2026-11-19 作者裁定）。写前备份与恢复出口
// 不在本处（ai-panel 写路径 + 设置页）。
let wipeguardNotifyAt = 0; // 上次向会话投递告警的时间（2 分钟冷却，见 onCritical）
const wipeguardCtrl = createAIWipeguard({
    getBackend: () => backend,
    getWsRoot: () => workspaceFolder || '',
    getSettings: () => settings,
    // L3 快照失败 / 跳过文件升级进消息中心（snapshotTick 内部 30 分钟节流，见 ai-wipeguard.js）
    notify: (msg, opts) => messageCenter.add(msg, opts),
    isAIActive: (root) => !!(aiPanel && typeof aiPanel.wipeguardIsAIActive === 'function' && aiPanel.wipeguardIsAIActive(root || workspaceFolder || '')),
    onCritical: (info) => {
        // 不停会话、不熔断写命令（2026-11-19 作者裁定）：合法批量删除（插件更新、切分支、
        // 装依赖）与真破坏在 watcher 眼里同形，误判一次就把正在干活的会话打断。改为把
        // 告警**插队投递**给挂在本工作区、正在运行的会话，由模型自己判断「跟我有没有关系」；
        // 用户侧只留状态栏红条 + 消息中心，中止与否由用户决定。
        // 投递与红条共用 2 分钟冷却：真事故里删除会持续十几秒、fireAlarm 每 3 秒就能报
        // 一次，不节流会把几十条告警堆进会话上下文、把消息中心刷满（每次告警的运行
        // 日志仍由 Go 侧 WipeGuardAlarm 逐条写，留痕不受影响）。
        const now = Date.now();
        if (now - wipeguardNotifyAt < WIPEGUARD_NOTIFY_COOLDOWN_MS) return;
        wipeguardNotifyAt = now;
        if (info.aiActive && aiPanel && typeof aiPanel.wipeguardNotifyForWorkspace === 'function') {
            try {
                const pending = aiPanel.wipeguardNotifyForWorkspace(info.root || workspaceFolder || '', info);
                if (pending && typeof pending.catch === 'function') pending.catch(() => {});
            } catch (e) { /* 投递尽力而为，不影响红条 */ }
        }
        messageCenter.add({
            kind: 'error',
            title: '工作区防护：疑似大范围文件消失',
            body: info.reason + (info.aiActive ? '。已通知相关会话核实；' : '。') +
                '点击本条直达 设置 → 存储与清理 → 工作区防护 查看与还原被改文件。',
            actionId: 'open-wipeguard-settings',
        }, {toast: true});
    },
    onWarn: (info) => {
        messageCenter.add({kind: 'info', title: '工作区防护提示', body: info.reason}, {toast: true});
    },
});
wipeguardCtrl.syncConfig();
// L3 定期状态快照：10 分钟一拍（开关关闭时 tick 内部直接返回）
const wipeguardSnapshotTimer = setInterval(() => wipeguardCtrl.snapshotTick(), 10 * 60 * 1000);
window.__lens.wipeguard = wipeguardCtrl;
void wipeguardSnapshotTimer;

// 活动栏「AI 会话」图标状态点：由会话列表域算好后推送（error>pending>done），
// 这里只负责把 kind 映射成按钮上的颜色 class，与 Git 图标的 .ab-dot 同一视觉语言。
function applySessionBadge(kind) {
    const btn = els.abChats;
    if (!btn) return;
    btn.classList.remove('dot-error', 'dot-pending', 'dot-done');
    if (kind === 'error' || kind === 'pending' || kind === 'done') btn.classList.add('dot-' + kind);
}

function initAIPanel() {
    if (aiPanel) return;
    const panelEl = els.aiPanel || document.getElementById('ai-panel');
    if (!panelEl) return;
    aiPanel = createAIPanel({
        // 插件 AI 工具注册表（shell/plugin-tools.js）：面板内部按三层授权过滤下发，
        // 宿主未注入时面板降级为「无插件工具」，不影响既有能力。
        pluginTools: pluginToolsMod,
        // 插件注入的 AI 上下文注册表（shell/plugin-context.js）
        pluginContext: pluginContextMod,
        // 桌面授权单飞广播出口（desktop-grant-changed）：面板 grant/revoke 时经这里全窗广播，
        // 各窗口副本收敛（订阅在下方 onApp 区）。浏览器 mock（rt 为空）时静默降级为单窗口语义。
        emitAppEvent: (name, payload) => {
            if (rt && typeof rt.EventsEmit === 'function') rt.EventsEmit(name, payload);
        },
        panel: panelEl,
        dockParent: document.getElementById('top-row'),
        overlayParent: document.getElementById('main-pane'),
        backend,
        settings,
        // 工作区破坏防护（ai-wipeguard.js）：写路径备份 / run_command 指纹保底 / 熔断判定
        wipeguard: wipeguardCtrl,
        // 消息中心投递回调：notify_send 工具与「需要用户处理」的通知都走这里（message-center.js）；
        // 是否真的写进列表由 ai-notify-policy 的 centerRecord 决定（任务完成不写）
        addMessage: (...args) => messageCenter.add(...args),
        // 失败 / 后台事件统一通知（消息中心 + toast + 节流）：A/B 级清单专用，
        // 与 notifyDesktop（AI 任务失败 / 提问 / 审批，带会话可见性策略）平行，互不重复。
        notifyFailure: (...args) => failureNotifier.notifyFailure(...args),
        // 头部放大镜：开全局搜索并只勾选「AI 会话」分类（会话搜索框已并入这里）
        onHeadSearch: () => openGlobalSearch({aiOnly: true}),
        // 汇总卡「撤销」：回滚本轮编辑的文件到 HEAD（Git checkout / 删除新建文件）
        rollbackGitPaths: (paths, untracked) => gitRollbackPaths(paths, untracked),
        // AI 工具卡超链接：打开文件并跳到指定行（read_file 卡用）
        openTargets,
        fonts: {latin: uiFonts, cjk: cjkFonts, mono: editorFonts},
        saveSettings: applySettings,
        activity: activityLog,
        // 插件注册的命令分类器（plugins.js 域状态，端侧分类器聚合时读取）
        getPluginCommandClassifiers,
        // 行式下拉增强器：设置页弹窗（生图条目编辑器）里的 select 也要同样的浮层
        enhanceSelect: (sel) => settingsUI.enhanceSelect(sel),
        getPluginLoadErrors,
        refreshPlugins: () => loadPlugins(backend),
        openTermTab: (...args) => openBgTermTab(...args),
        // AI 终端桥（terminal 工具）：延迟求值——terminal-ui 工厂在本模块后段创建，
        // 创建期直接引用会 TDZ；getter 在工具调用时才读。注意 terminalHostApi 挂在
        // terminalMod 模块返回面（sessMod 转发），不在 terminalUI（那只是 dock 状态对象）——
        // 以前调错对象导致 terminal 工具一直报「当前版本不支持」。
        get terminalHost() {
            if (typeof terminalHostApi !== 'function') return null;
            try {
                return terminalHostApi();
            } catch (e) {
                return null;
            }
        },
        // 「自动化」按钮 → 定时任务应用页面标签页（虚拟标签页改造后不再是设置模态框）
        openAppPageTab: (...args) => openAppPageTab(...args),
        // 子代理详情视图：在内容区标签页打开（不遮挡面板；悬浮窗由面板自己退回覆盖层）
        openAgentTab: (...args) => openAgentTab(...args),
        // 智能体团队详情：内容区标签页（主代理 + 子代理树）
        openAgentTeamTab: (...args) => openAgentTeamTab(...args),
        // 支线对话标签页：完整会话渲染在内容区，面板继续显示主对话
        openSideChatTab: (...args) => openSideChatTab(...args),
        // G6 面板化：群聊视图挂载与群切换枢纽。aiGroupView 在本函数后段才创建，
        // 用惰性闭包取最新值；groupHub 供面板更多菜单与群聊视图切换弹层共用。
        mountGroupChatView: (spec, host) => (aiGroupView ? aiGroupView.mountPanel(spec, host) : null),
        groupHub: {
            list: () => (aiGroupRuntime ? aiGroupRuntime.groupList() : []),
            open: (groupId, title) => {
                if (aiPanel && aiPanel.bridgeShowGroupView) aiPanel.bridgeShowGroupView({groupId, title});
            },
            create: () => {
                if (aiGroupSidebar && aiGroupSidebar.openCreateDialog) aiGroupSidebar.openCreateDialog();
            },
        },
        // 视图变化 → 侧栏高亮当前打开的群
        onViewChange: (view, groupId) => {
            if (aiGroupSidebar && aiGroupSidebar.setActiveGroup) aiGroupSidebar.setActiveGroup(view === 'group' ? groupId : '');
        },
        runAppAction,
        hostAppActions: () => APP_ACTIONS,
        // AI 会话开始预指令（shell/lifecycle-hooks.js）：空会话首轮流起轮前 await 执行
        // session-start 条目；失败不阻塞起轮（ai-panel 侧另有 try/catch 双保险）。
        // onWillRun 由控制器在确有条目要跑时回调，ai-panel 用它闪阻塞期提示
        lifecycleAIStart: (ws, onWillRun) => lifecycleHooksCtl.runForAISessionStart(ws, onWillRun),
        // 9 事件通用钩子（工具级按 matchTools 过滤、阻塞型 await）：workspace 由调用方
        // 传会话归属，缺省用当前窗口工作区；main.js 只透传，执行与审批全在控制器
        lifecycleEvent: (event, toolName, ws) => lifecycleHooksCtl.runForEvent(
            ws || workspaceFolder || '', event, toolName || ''),
        browserHost: {
            ensureTab: async (id, url, profileKey) => {
                const existed = docs.find((d) => d.id === id);
                if (existed && backend.BrowserState) {
                    try {
                        const st = await backend.BrowserState(id);
                        if (st) return {id, url: st.url, title: st.title};
                    } catch (e) {}
                }
                const doc = openBrowserTab(url || 'about:blank', profileKey || '');
                // 同 open_browser_tab 宿主动作：返回前等 webview 就绪，失败原样抛出
                if (doc && doc.browserOpenPromise) await doc.browserOpenPromise;
                return {id: doc.id, url: doc.browserUrl, title: doc.name};
            },
            closeTab: async (id) => {
                const doc = docs.find((d) => d.id === id);
                if (doc) closeDocNow(doc, false);
                return {closed: true};
            },
            applyViewport: (id, viewport) => {
                const doc = docs.find((d) => d.id === id && d.browser);
                if (!doc || !doc.browserEl) return {applied: false};
                const ok = setBrowserViewport(doc, viewport);
                return {applied: ok, viewport: browserViewportLabel(doc)};
            },
        },
        flash,
        copyText,
        // AI 消息里的 svg / html 围栏按设置渲染成内联可视化卡片；其它 Markdown 视图不传该开关。
        // opts.widgets=false 供思考链调用：思考里的围栏只是 AI 推理时写的代码示例，不是要渲染的图，
        // 且可视化卡片的 mount 只针对最终回答，思考里的占位永远不会挂载，会一直卡在「正在生成可视化…」。
        renderMarkdown: (text, opts) => renderMarkdownHtml(text, {
            aiWidgets: (opts && opts.widgets === false) ? false : settings.aiInlineWidgets !== false,
        }),
        // AI 回答里的 ```mermaid 围栏占位渲染（功能验证报告 §1.3.3：原来占位无人渲染，图直接消失）
        renderMermaidBlocks,
        openExternal: openExternalUrl,
        // AI 回答正文里的 http(s) 链接用内置浏览器标签页打开（而非 target=_blank 弹裸 WebView2 窗口）。
        // 箭头函数延迟求值：openBrowserTab 在 bridgeUI 解构（约 7342 行）后才可用，直接传会 TDZ。
        openBrowserTab: (url) => openBrowserTab(url, ''),
        confirm: openConfirmDialog,
        nameDialog: openNameDialog,
        openSettings: (pane, preset) => {
            if (window.__aiFloatWindow && backend.OpenSettingsInMainWindow) {
                Promise.resolve(backend.OpenSettingsInMainWindow(pane || 'models'))
                    .then(() => flash('已在主窗口打开设置'))
                    .catch((e) => flash('打开主窗口设置失败：' + ((e && e.message) || e), true));
                return;
            }
            openSettings(pane, preset);
        },
        setDragCursor,
        openVirtualDoc: (...args) => openVirtualDoc(...args),
        commandOutput: (id, handlers) => {
            const off = () => {
                cmdOutHandlers.delete(id);
                cmdExitHandlers.delete(id);
            };
            if (!id || !handlers) return {cancel: off};
            // 流事件归属：cmd-out/cmd-exit 只投本窗口（创建竞态前的广播仍由 id 过滤兜底）
            if (backend.RegisterEventOwner) Promise.resolve(backend.RegisterEventOwner('cmd', id)).catch(() => {});
            if (handlers.onOut || handlers.onErr) {
                cmdOutHandlers.set(id, (stream, data) => {
                    if (stream === 'err') {
                        if (handlers.onErr) handlers.onErr(data);
                    } else if (handlers.onOut) {
                        handlers.onOut(data);
                    }
                });
            }
            if (handlers.onExit) {
                cmdExitHandlers.set(id, (code) => {
                    off();
                    handlers.onExit(code);
                });
            }
            return {cancel: off};
        },
        activityButton: els.abAi,
        toolbarButton: els.tbAi,
        // 活动栏会话图标状态点：会话列表域算好后推这里，映射到 #ab-chats 的颜色 class
        onSessionBadgeChange: applySessionBadge,
        isMock: !hasWails,
        floatWindow: !!window.__aiFloatWindow || (!hasWails && mockScenario.has('aifloat')),
        mockEmpty: mockScenario.has('aiempty'),
        getWorkspaceContext: () => {
            const caret = file ? appActionDocCaret(file) : {cursor: null, selection: null};
            return {
                workspaceFolder: workspaceFolder || '',
                activeFile: file ? {
                    path: file.path || '',
                    name: file.name || '',
                    mode: file.mode || '',
                    dirty: !!file.dirty,
                    cursor: caret.cursor,
                    selection: caret.selection ? {
                        start: caret.selection.start,
                        end: caret.selection.end,
                        chars: caret.selection.chars,
                    } : null,
                    viewport: caret.viewport || null,
                } : null,
                // 只收真文件（有 path）：浏览器 / 便签 / 计划视图等虚拟标签页单独进 openViews，
                // 不再被当成「范围外的文件」
                openFiles: docs.filter((doc) => doc.path).map((doc) => doc.path),
                openViews: docs.map(appTabViewOf).filter(Boolean),
            };
        },
        getGitRepo: () => {
            // 面板可能在模块求值早期自动打开：gitStateCache 尚未完成初始化时按「无仓库」处理，
            // 随后的 refreshGitStatus 会再次通知刷新。
            try {
                return {
                    available: !!gitStateCache.available,
                    root: gitStateCache.dir,
                    branch: gitStateCache.branch,
                };
            } catch (e) {
                return null;
            }
        },
        getScopeRoot: () => workspaceFolder || (file && file.path ? parentDirOf(file.path) : ''),
        // 「点别的 AI 会话 → 怎么开」的接线（方案 docs/finished-plans/multi-window-session-reuse.md）：
        // 分支决策单一来源在 ai-session-scope.decideSessionOpen（纯函数，测试锁各分支），这里只做探测与执行。
        // 复用探测快路径无感：目标工作区无存活窗口时 WindowReuseForSession 立即返回空，不等待。
        openWorkspaceFolder: async (dir, sessionId) => {
            if (!dir || window.__aiFloatWindow) return false;
            const targetKey = sessionPathKey(dir);
            const currentKey = workspaceFolder ? sessionPathKey(workspaceFolder) : '';
            let reuseHit = false;
            if (currentKey && currentKey !== targetKey && backend.WindowReuseForSession) {
                try {
                    reuseHit = !!(await backend.WindowReuseForSession(dir, sessionId || ''));
                } catch (e) {
                    // 探测失败按「没有可用窗口」处理，退化走软切换
                }
            }
            const decision = decideSessionOpen({
                dir,
                isFloat: !!window.__aiFloatWindow,
                currentKey,
                targetKey,
                reuseHit,
                canSoftSwitch: typeof backend.OpenWorkspaceForConversation === 'function',
                canNewWindow: typeof backend.OpenDirInNewWindow === 'function',
            });
            switch (decision.action) {
                case 'same':
                    return 'same';
                case 'current':
                    openFolderWorkspace(dir);
                    return 'current';
                case 'reused':
                    logFrontend('info', '跨窗口会话复用：目标工作区已开在别的存活窗口，已投递');
                    return 'reused';
                case 'window':
                    logFrontend('info', '跨窗口会话：软切换另开窗口（复用探测' + (currentKey && backend.WindowReuseForSession ? '未命中' : '未执行') + '）：' + dir);
                    saveSessionNow();
                    if (backend.OpenWorkspaceForConversation) {
                        Promise.resolve(backend.OpenWorkspaceForConversation(dir, sessionId || ''))
                            .catch((e) => flash('打开新窗口失败：' + ((e && e.message) || e), true));
                    } else if (backend.OpenDirInNewWindow) {
                        Promise.resolve(backend.OpenDirInNewWindow(dir))
                            .catch((e) => flash('打开新窗口失败：' + ((e && e.message) || e), true));
                    }
                    return 'window';
                default:
                    return false;
            }
        },
        // 会话列表工作区分组头「⋯」的工作区管理菜单：复用宿主已有的工作区能力，
        // 面板只负责组装菜单与转发动作（见 ai-session-list.js 的 buildWorkspaceMenuItems）。
        workspaceMenu: {
            reveal: (path) => {
                Promise.resolve(backend.ShowInFolder(path))
                    .catch((e) => flash('打开文件夹位置失败：' + e, true));
            },
            openNewWindow: (path) => {
                Promise.resolve(backend.OpenDirInNewWindow
                    ? backend.OpenDirInNewWindow(path)
                    : backend.OpenInNewWindows([path]))
                    .then(() => flash('已在新窗口打开：' + (baseNameOf(path) || path)))
                    .catch((e) => flash('打开新窗口失败：' + e, true));
            },
            openFolder: () => openFolderDialog(),
            openFolderSmart: (path) => openFolderSmart(path),
            closeFolder: () => closeFolder(),
            baseName: (path) => baseNameOf(path),
            recent: () => readRecentOpen().filter((entry) => entry && entry.isDir && entry.path),
        },
        getSelection: () => {
            const text = selectedText();
            if (!file || !text) return null;
            const caret = appActionDocCaret(file);
            return {
                path: file.path || '',
                name: file.name || '选中内容',
                text,
                selection: caret.selection,
            };
        },
        pickFiles: () => backend.OpenFilesDialog(),
        showContextMenu: (items, x, y, options) => {
            if (ctxMenu) ctxMenu.open(items, x, y, Object.assign({ignoreScrollWithin: '#ai-panel'}, options));
        },
        openPath: (path) => {
            if (window.__aiFloatWindow && backend.OpenInNewWindows) {
                Promise.resolve(backend.OpenInNewWindows([path])).catch((e) => flash('打开失败：' + ((e && e.message) || e), true));
                return;
            }
            openPath(path);
        },
        isFileDirty: (path) => {
            const doc = findDocByPath(path);
            return !!(doc && doc.dirty);
        },
        onFileChanged: (path) => handleAIWorkspaceFileChanged(path),
        collapseSidebar: () => {
            if (!settings.showSidebar) return;
            settings.showSidebar = false;
            applySettings();
        },
        onLayout: () => {
            updateAiWidthWidget();
            if (editor && editor.resize) {
                try { editor.resize(); } catch (e) {}
            }
            // terminalUI 在模块尾部声明：面板按上次状态自动打开时本回调可能先于其初始化
            // 执行（TDZ），一并用 try/catch 兜底，避免中断整个模块求值。
            try {
                if (terminalUI.open) fitActiveTerm();
            } catch (e) {}
        },
        // 面板开合 / 显示方式 / 消息流变化：结构面板据此决定显示文件结构还是会话结构
        onPanelStateChange: () => refreshStructureSources(),
        // 会话回合开始 / 结束：驱动「AI 工作时自动收起编辑区」（默认关，见 settings.aiAutoCollapseEditor）
        onTurnStateChange: (running, sessionId, isCurrent) => applyAutoCollapse(running, sessionId, isCurrent),
    });
    // 播种一次：面板刚建好时会话可能已读完盘，别等下一次列表刷新才出点
    if (aiPanel && aiPanel.refreshSessionBadge) aiPanel.refreshSessionBadge();
    window.__lens.aiPanel = aiPanel;
    // AI 群聊域：运行时 + 侧栏（面板薄 API aiGroupApi 提供配置/渲染链/弹窗三件套；
    // ai-* 流事件经下方 EventsOn 循环同时转发给面板与本运行时）
    aiGroupRuntime = createAIGroupRuntime({
        backend,
        getAIConfig: () => (aiPanel && aiPanel.aiGroupApi ? aiPanel.aiGroupApi.getConfig() : null),
        // modelRef → 请求配置（漏传则每次发言都报「模型不可用」——群聊 G2 接线事故修复）
        resolveModel: (ref) => (aiPanel && aiPanel.aiGroupApi ? aiPanel.aiGroupApi.resolveModel(ref) : null),
        // G5 落地：群成员只读文件工具执行体（读取/搜索/格式化助手在面板闭包里，
        // 路径边界在面板侧钳到群工作区）。漏传则成员请求不下发工具，退回纯对话。
        execMemberTool: (name, argsJson, workspace) => (
            aiPanel && aiPanel.aiGroupApi ? aiPanel.aiGroupApi.execMemberTool(name, argsJson, workspace) : null
        ),
        flash: (...args) => flash(...args),
        // 落盘 / 调度等后台失败：走消息中心 + toast + 节流（状态栏 flash 5s 就清，看不见）
        notifyFailure: (...args) => failureNotifier.notifyFailure(...args),
        // G6 面板化：点群聊行 / 创建群聊 → AI 面板切到群聊视图（不再开内容区标签页）
        openGroupView: (spec) => {
            if (aiPanel && aiPanel.bridgeShowGroupView) aiPanel.bridgeShowGroupView(spec);
        },
        getWorkspace: () => (workspaceFolder || ''),
        // G4 纪要带回会话：走面板信箱（deliverToSessions）；会话 id 取面板当前会话
        deliverToSessions: aiPanel.aiGroupApi
            ? (...args) => aiPanel.aiGroupApi.deliverToSessions(...args)
            : null,
        getCurrentSessionId: () => {
            try {
                const state = aiPanel && aiPanel.bridgeGetState ? aiPanel.bridgeGetState() : null;
                return state && state.session ? state.session.id : '';
            } catch (e) {
                return '';
            }
        },
    });
    aiGroupRuntime.init();
    aiGroupSidebar = createAIGroupSidebar({
        runtime: aiGroupRuntime,
        get backend() { return backend; },
        getAIConfig: () => (aiPanel && aiPanel.aiGroupApi ? aiPanel.aiGroupApi.getConfig() : null),
        saveConfig: () => {
            if (aiPanel && aiPanel.aiGroupApi) aiPanel.aiGroupApi.saveConfig();
        },
        flash: (...args) => flash(...args),
        confirm: (message, action, okLabel, title, variant, options) => openConfirmDialog(message, action, okLabel, title, variant, options),
        // 新建群聊弹窗左下角的齿轮：直达 应用页面 → 智能体（成员管理）；箭头包一层防
        // 组合根声明顺序（openAppPageTab 在 bridgeUI 解构之后才有值），调用时才求值
        openAppPageTab: (...args) => openAppPageTab(...args),
        dialog: aiPanel.aiGroupApi
            ? {
                open: (...args) => aiPanel.aiGroupApi.openDialog(...args),
                close: () => aiPanel.aiGroupApi.closeDialog(),
                node: (...args) => aiPanel.aiGroupApi.node(...args),
                button: (...args) => aiPanel.aiGroupApi.button(...args),
                enhanceSelect: aiPanel.aiGroupApi.enhanceSelect,
            }
            : {},
    });
    aiGroupSidebar.bindSidebar();
    // 群聊视图（挂 AI 面板）+ 成员详情视图（内容区标签页）：消息 / 流式 / 输入区由视图模块负责
    aiGroupView = createAIGroupView({
        runtime: aiGroupRuntime,
        getAIConfig: () => (aiPanel && aiPanel.aiGroupApi ? aiPanel.aiGroupApi.getConfig() : null),
        renderMarkdown: aiPanel.aiGroupApi ? (text) => aiPanel.aiGroupApi.renderMarkdown(text) : null,
        enhanceAnswerBody: aiPanel.aiGroupApi && aiPanel.aiGroupApi.enhanceAnswerBody
            ? (root) => aiPanel.aiGroupApi.enhanceAnswerBody(root)
            : null,
        flash: (...args) => flash(...args),
        // 成员详情：头像 / 名字点击 → 内容区标签页（像子代理）；hook 在 bridge 工厂后回填
        openMemberTab: (spec) => {
            if (openGroupMemberTabHook) openGroupMemberTabHook(spec);
            else flash('成员详情视图不可用：界面尚未就绪');
        },
        // 顶部「返回会话」：AI 面板切回会话视图
        showSessions: () => {
            if (aiPanel && aiPanel.bridgeShowSessionView) aiPanel.bridgeShowSessionView();
        },
        groupHub: {
            list: () => aiGroupRuntime.groupList(),
            open: (groupId, title) => {
                if (aiPanel && aiPanel.bridgeShowGroupView) aiPanel.bridgeShowGroupView({groupId, title});
            },
            create: () => {
                if (aiGroupSidebar && aiGroupSidebar.openCreateDialog) aiGroupSidebar.openCreateDialog();
            },
        },
        // ⋯ 菜单里的「群设置…」：复用侧栏的面板对话框实现
        openGroupSettings: (groupId) => {
            if (aiGroupSidebar && aiGroupSidebar.openGroupSettingsDialog) aiGroupSidebar.openGroupSettingsDialog(groupId);
        },
    });
    aiGroupMemberView = createAIGroupMemberView({
        runtime: aiGroupRuntime,
        getAIConfig: () => (aiPanel && aiPanel.aiGroupApi ? aiPanel.aiGroupApi.getConfig() : null),
        renderMarkdown: aiPanel.aiGroupApi ? (text) => aiPanel.aiGroupApi.renderMarkdown(text) : null,
        enhanceAnswerBody: aiPanel.aiGroupApi && aiPanel.aiGroupApi.enhanceAnswerBody
            ? (root) => aiPanel.aiGroupApi.enhanceAnswerBody(root)
            : null,
        flash: (...args) => flash(...args),
        // 成员详情页「打开群聊」：面板切回该群视图
        openGroupView: (spec) => {
            if (aiPanel && aiPanel.bridgeShowGroupView) aiPanel.bridgeShowGroupView(spec);
        },
    });
    window.__lens.aiGroupRuntime = aiGroupRuntime;
    window.__mockAiEmit = (name, payload) => {
        // dev mock 的 ai-* 事件与真实 Wails EventsOn 同语义：面板与群聊运行时都要认领
        if (aiPanel) aiPanel.handleEvent(name, payload);
        if (aiGroupRuntime) aiGroupRuntime.handleEvent(name, payload);
    };
    if (rt) {
        // 新增 Go 侧 aiEvent* 常量时必须同步加进这里，否则事件发出后前端无人接收
        // （ai-retry 曾长期漏订阅，导致流式状态条的重试提示是死代码）。
        for (const eventName of ['ai-chunk', 'ai-think', 'ai-toolcall', 'ai-done', 'ai-error', 'ai-retry', 'ai-param-adjust', 'ai-queue']) {
            appEvents.onApp(eventName, (payload) => {
                if (aiPanel) aiPanel.handleEvent(eventName, payload);
                if (aiGroupRuntime) aiGroupRuntime.handleEvent(eventName, payload);
            });
        }
        // 定时任务：sched-fire 由 Go 调度器广播（多窗口都会收到，执行去重在面板内裁决）
        appEvents.onApp('sched-fire', (payload) => {
            if (aiPanel && typeof aiPanel.handleScheduleFire === 'function') {
                try { aiPanel.handleScheduleFire(payload); } catch (e) {}
            }
        });
        // AI 计时器：到点/停止事件（多窗口都会收到，胶囊只在启动窗口注册过）
        appEvents.onApp('ai-timer-fired', (info) => {
            if (aiPanel && typeof aiPanel.handleTimerEvent === 'function') {
                try { aiPanel.handleTimerEvent('ai-timer-fired', info); } catch (e) {}
            }
        });
        appEvents.onApp('ai-timer-stopped', (info) => {
            if (aiPanel && typeof aiPanel.handleTimerEvent === 'function') {
                try { aiPanel.handleTimerEvent('ai-timer-stopped', info); } catch (e) {}
            }
        });
        appEvents.onApp('schedules-changed', () => {
            // 设置面板可见时刷新（兼容旧路径）
            const activePane = document.querySelector('.settings-pane[data-pane="schedules"]:not(.hidden)');
            if (activePane && aiPanel && typeof aiPanel.refreshScheduleSettings === 'function') {
                try { aiPanel.refreshScheduleSettings(); } catch (e) {}
            }
            // 应用页面标签页开着时也要刷新（修复跨窗口/工具 CRUD 后标签页陈旧）
            const schedDoc = docs.find((d) => d.appPage === 'schedules');
            if (schedDoc && schedDoc.appPageRoot && schedDoc.appPageRoot.isConnected
                && aiPanel && typeof aiPanel.refreshScheduleSettings === 'function') {
                try { aiPanel.refreshScheduleSettings(); } catch (e) {}
            }
        });
        // 跨窗口设置同步：别的窗口改了设置（含 AI 的 cognition_toggle 审批卡）后广播全量快照，
        // 本窗口原地合并内存并重绘——否则窗口1的设置页/认知开关一直显示启动时的旧值。
        // 发出的窗口自己也收（v3 广播无定向），applyRemoteSettings 会写回同源值，幂等。
        appEvents.onApp('settings-changed', (payload) => {
            const values = payload && payload.values;
            if (!values) return;
            // 认知索引开关翻转：应用页面的入口可见性（visibleWhen=aiCognition）与已开的认知页
            // 要跟着变。基线必须用模块级 lastCog 而非 settings.aiCognition——本地开关是「先改 settings
            // 再广播」，广播到达时 settings 已是新值，拿它当 before 会让比较恒 false（翻转永不刷新）。
            // 权威值是 payload.values（广播快照），跨窗口/本窗口两条路径统一走这里。
            const nowCog = values.aiCognition === true;
            try { applyRemoteSettings(values); } catch (e) {}
            if (lastCog !== null && nowCog !== lastCog) {
                refreshAppPagesNavIfVisible();
                refreshCognitionPageIfVisible();
            }
            lastCog = nowCog;
        });
        // MCP 客户端：Go 侧世代/状态事件都推全量快照，面板整表替换（ai-mcp.js §5.4）
        appEvents.onApp('mcp-tools-changed', (snapshot) => {
            if (aiPanel && typeof aiPanel.handleMcpEvent === 'function') {
                try { aiPanel.handleMcpEvent(snapshot); } catch (e) {}
            }
            refreshExternalToolsPaneIfVisible();
        });
        appEvents.onApp('mcp-status-changed', (snapshot) => {
            if (aiPanel && typeof aiPanel.handleMcpEvent === 'function') {
                try { aiPanel.handleMcpEvent(snapshot); } catch (e) {}
            }
            refreshExternalToolsPaneIfVisible();
        });
        // 桌面控制状态广播（desktop-grant-changed）：别的窗口改了同一会话的启用状态时刷新本窗口 UI
        appEvents.onApp('desktop-grant-changed', (payload) => {
            if (aiPanel && typeof aiPanel.handleDesktopGrantEvent === 'function') {
                try { aiPanel.handleDesktopGrantEvent(payload); } catch (e) {}
            }
        });
    }
}

// toggleSidebarFilter 侧边栏文件名过滤框的开关与清理
function toggleSidebarFilter(force) {
    if (!els.sbFilterRow || !els.sbFilter) return;
    const show = typeof force === 'boolean' ? force : els.sbFilterRow.classList.contains('hidden');
    els.sbFilterRow.classList.toggle('hidden', !show);
    if (els.sbFilterBtn) els.sbFilterBtn.classList.toggle('active', show);
    if (els.sbFilterBtn) els.sbFilterBtn.setAttribute('aria-pressed', String(show));
    if (show) {
        els.sbFilter.focus();
        els.sbFilter.select();
    } else if (explorer && explorer.setFilter) {
        els.sbFilter.value = '';
        explorer.setFilter('');
    }
}

function initExplorer() {
    if (!els.sbBody) return;
    explorer = createExplorer({
        body: els.sbBody,
        titleEl: els.sbTitle,
        refreshBtn: els.sbRefresh,
        revealBtn: els.sbReveal,
        filterBtn: els.sbFilterBtn,
        listBtn: els.sbModeList,
        treeBtn: els.sbModeTree,
        readDir: (path, limit) => backend.ReadDir(path, limit),
        dirMtime: (path) => (typeof backend.DirMtime === 'function' ? backend.DirMtime(path) : Promise.resolve(0)),
        // 文件树的「临时草稿」固定节点（JetBrains Scratches 同款）：.cadt 从树里隐藏，
        // 草稿单独挂一个根级节点，路径就是 <ws>/.cadt/scratch
        scratchRoot: () => scratchDir(workspaceFolder),
        openPath: (path) => openPath(path),
        openFolder: () => openFolderDialog(),
        openFileDialog: () => openDialog(),
        isSupported: isSupportedFile,
        onContextMenu: (info, x, y) => showExplorerMenu(info, x, y),
        onMove: (items, destDir) => moveEntriesByDrag(items, destDir),
        onToggleFilter: toggleSidebarFilter,
        canDrag: () => !settings.readOnlyMode,
        onModeChange: (mode) => {
            settings.sidebarMode = mode;
            applySettings();
            // 列表/树根不同，文件监听根要跟着切（列表模式根=工作区或单文件目录）
            syncWorkspaceWatcher();
        },
    });
    explorer.setMode(settings.sidebarMode, false);
    explorer.setAutoRefresh(settings.treeRefreshInterval);
    if (els.sbFilter) {
        let filterDebounce = 0;
        els.sbFilter.addEventListener('input', () => {
            clearTimeout(filterDebounce);
            filterDebounce = setTimeout(() => {
                if (explorer && explorer.setFilter) explorer.setFilter(els.sbFilter.value);
            }, 150);
        });
        els.sbFilter.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                toggleSidebarFilter(false);
            }
        });
    }
    applySidebarUI();
    if (els.btnSidebar) els.btnSidebar.addEventListener('click', () => toggleSidebar());
    // 各左侧面板标题栏的「−」收起按钮：统一收起侧边栏（含文件树 / 结构 / git / AI 会话）
    document.querySelectorAll('.sb-collapse').forEach((btn) => {
        btn.addEventListener('click', () => toggleSidebar(false));
    });
    if (els.lock) els.lock.addEventListener('click', () => {
        settings.readOnlyMode = !settings.readOnlyMode;
        applySettings();
        if (settings.readOnlyMode) {
            const hasDirty = docs.some((doc) => doc.dirty);
            flash(hasDirty ? '已切换为只读；有未保存修改，解锁后可保存' : '已切换为只读');
        } else {
            flash('已解除只读锁定');
        }
    });
    if (els.bannerClose) els.bannerClose.addEventListener('click', (e) => {
        e.stopPropagation();
        dismissBanner();
    });
}


async function copyStructureTree(format) {
    const text = structureTreeText(format);
    if (!text) {
        flash('当前文件没有可复制的结构', true);
        return;
    }
    await copyText(text, '结构');
}

async function exportStructureTree(format) {
    if (!backend.ExportStructureText) {
        flash('当前版本不支持导出结构', true);
        return;
    }
    const text = structureTreeText(format);
    if (!text) {
        flash('当前文件没有可导出的结构', true);
        return;
    }
    try {
        const ext = format === 'mermaid' ? '.mmd' : '.txt';
        const defaultName = (file && file.name ? file.name : '结构') + '-结构' + ext;
        const path = await backend.ExportStructureText(defaultName, text);
        if (!path) {
            flash('已取消导出');
            return;
        }
        flash('已导出结构：' + (baseNameOf(path) || path));
    } catch (e) {
        flash('导出结构失败：' + e, true);
    }
}

let untitledSeq = 0;

function newDocumentWith(baseName, content) {
    untitledSeq += 1;
    const dot = baseName.lastIndexOf('.');
    const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
    const ext = dot > 0 ? baseName.slice(dot) : '';
    const name = untitledSeq === 1 ? stem + ext : stem + ' ' + untitledSeq + ext;
    const text = content != null ? content : '';
    const doc = createDoc({
        path: null,
        name,
        content: text,
        size: new TextEncoder().encode(text).length,
        eol: 'lf',
        hasBom: false,
        large: false,
        enc: 'utf-8',
    });
    doc.untitled = true;
    doc.dirty = true;
    docs.push(doc);
    activityLog.log('tab.open', name, {format: (doc.format && doc.format.id) || ''});
    activateDoc(doc);
}

function newDocument() {
    newDocumentWith('未命名.json', '{}');
}

async function openNewWindow() {
    try {
        await backend.OpenNewWindow();
    } catch (e) {
        flash('新建窗口失败：' + e, true);
    }
}

async function showInFolder() {
    if (!file || !file.path) return;
    try {
        await backend.ShowInFolder(file.path);
    } catch (e) {
        flash('打开文件位置失败：' + e, true);
    }
}

async function copyText(text, label) {
    if (!text) return false;
    // 先试 Go 绑定（WebView2 失焦时 Web API 会被拒），失败再退 Web API——见 core/clipboard.js
    const ok = await copyTextToClipboard(text, {goCopy: (value) => backend.CopyText(value)});
    if (ok) {
        flash('已复制' + label);
        return true;
    }
    flash('复制失败', true);
    return false;
}

async function copyStructuredDir(dir) {
    if (!backend.StructureDir) {
        flash('当前版本不支持结构化目录', true);
        return;
    }
    flash('正在生成结构化目录…');
    try {
        const text = await backend.StructureDir(dir);
        await copyText(text, '结构化目录');
    } catch (e) {
        flash('复制结构化目录失败：' + e, true);
    }
}

async function exportStructuredDir(dir) {
    if (!backend.ExportStructureDir) {
        flash('当前版本不支持导出结构化目录', true);
        return;
    }
    try {
        const path = await backend.ExportStructureDir(dir);
        if (!path) {
            flash('已取消导出');
            return;
        }
        flash('已导出结构化目录：' + (baseNameOf(path) || path));
    } catch (e) {
        flash('导出结构化目录失败：' + e, true);
    }
}

async function requestReload() {
    const doc = file;
    if (!doc || !doc.path) return;
    if (doc.dirty) {
        openConfirmDialog('重新加载将丢弃未保存的修改。', () => reloadActive(), '丢弃并重新加载', '重新加载', 'danger');
    } else {
        await reloadActive();
    }
}

async function reloadActive(opts = {}) {
    const doc = file;
    if (!doc || !doc.path) return false;
    try {
        const data = await backend.OpenFile(doc.path, getFormatSettings(doc.format.id).encoding);
        const fresh = createDoc(data);
        const keepMode = doc.mode;
        const wasSplit = !!doc.splitActive;
        clearTimeout(doc.splitTimer);
        doc.splitTimer = 0;
        doc.splitActive = false;
        doc.splitKind = '';
        doc.splitDivider = null;
        doc.htmlPreviewEl = null;
        doc.htmlFrame = null;
        doc.htmlPreviewRoot = null;
        doc.htmlRootTried = false;
        if (doc.editor) doc.editor.destroy();
        if (doc.pane) doc.pane.remove();
        doc.editor = null;
        doc.pane = null;
        doc.tableEl = null;
        doc.tableScroll = null;
        doc.tableMeta = null;
        doc.tableUndo = [];
        doc.tableRedo = [];
        doc.previewEl = null;
        doc.previewScroll = null;
        doc.previewBody = null;
        if (doc.imageResizeObserver) {
            doc.imageResizeObserver.disconnect();
            doc.imageResizeObserver = null;
        }
        doc.imageEl = null;
        doc.imageScroll = null;
        doc.imageCanvas = null;
        doc.imageNode = null;
        doc.imageStatus = null;
        doc.imageUrl = null;
        doc.imageLoading = false;
        doc.imageError = null;
        doc.imageWidth = 0;
        doc.imageHeight = 0;
        doc.imageScale = 0;
        doc.imageZoom = null;
        doc.imagePan = null;
        // 重新加载会重建 pane：先把视频/音频断源，否则旧解码器还在播
        releaseVideo(doc);
        doc.videoReleased = false;
        releaseAudio(doc);
        doc.audioReleased = false;
        doc.loading = false;
        doc.bannerDismissed = false;
        Object.assign(doc, fresh, {id: doc.id, dirty: false, untitled: false, text: null, content: data.content, bookmarks: doc.bookmarks || new Set()});
        let nextMode = keepMode;
        if (doc.binary) {
            nextMode = doc.video && keepMode === 'video' ? 'video'
                : doc.audio && keepMode === 'audio' ? 'audio'
                : doc.image && keepMode === 'image' ? 'image' : 'binary';
        } else if (doc.format.preview) {
            if (doc.large) nextMode = 'code';
            else if (!['preview', 'code', 'text'].includes(nextMode)) nextMode = 'preview';
        } else if (!doc.treeAvailable) {
            nextMode = 'code';
        } else if (!['code', 'text', 'table'].includes(nextMode)) {
            nextMode = 'tree';
        }
        if (nextMode === 'table' && !doc.format.table) nextMode = 'tree';
        doc.mode = nextMode;
        editor = null;
        createDocEditor(doc);
        renderBookmarks(doc);
        doc.pane.classList.add('active');
        editor = doc.editor;
        currentMode = doc.mode;
        updateDocChrome();
        setDirty(false);
        applyAceMode();
        if (wasSplit && canSplitDoc(doc)) enterSplitView(doc);
        humanizeCounts();
        if (!opts.quiet) flash('已重新加载 ' + doc.name);
        return true;
    } catch (e) {
        if (!opts.quiet) flash('重新加载失败：' + e, true);
        return false;
    }
}

async function saveDoc(doc, opts = {}) {
    if (!doc || doc.browser || doc.large || doc.binary || !doc.editor) return false;
    if (isDocReadOnly(doc, settings)) {
        if (!opts.auto && !opts.silent) {
            flash(isTabReadOnlyLocked(doc) ? '本标签已只读锁定，解除后才能保存' : '只读锁定中，解锁后才能保存', true);
        }
        return false;
    }
    if (doc === file) flushCsvCellEditor();
    const fmt = doc.format;
    const fs = getFormatSettings(fmt.id);
    const savedMode = doc.mode;
    const snapshot = doc.editor.getText();
    let text;
    if (!doc.dirty && doc.rawText != null) {
        text = doc.rawText;
    } else if (savedMode === 'table' || savedMode === 'code' || savedMode === 'text' || fmt.rawOnly) {
        // 原文路径：是否保存交给用户——解析失败不再拦截，按原文落盘（手动保存时给非阻断提示；
        // 表格模式的序列化内容由应用生成，失败静默）。tree 模式（下方分支）是真实数据路径，校验保留。
        text = snapshot;
        if (!fmt.rawOnly && savedMode !== 'table') {
            try {
                fmt.parse(text);
            } catch (e) {
                if (!opts.auto) flash(fmt.name + ' 无效，已按原文保存：' + e.message);
            }
        }
    } else {
        let value;
        try {
            value = JSON.parse(snapshot);
        } catch (e) {
            if (!opts.auto) flash('无法读取树内容：' + e.message, true);
            return false;
        }
        text = fmt.stringify(value);
    }
    let path = doc.path;
    const origPath = path || '';
    const hadPath = !!path;
    if (opts.saveAs || !path) {
        if (opts.auto) return false;
        path = await backend.SaveFileDialog(doc.name || '未命名.json');
        if (!path) return false;
    }
    try {
        const eol = fs.eol === 'follow' ? doc.eol : fs.eol;
        const enc = fs.encoding === 'auto' ? (doc.enc || 'utf-8') : fs.encoding;
        // 写前冲突检测：磁盘 mtime 与打开 / 上次保存时不一致时不静默覆盖外部修改
        const tracked = !opts.saveAs && hadPath && !doc.untitled && !!doc.diskMtime && !!backend.SaveFileChecked;
        let saveMtime = 0;
        if (tracked) {
            let result = await backend.SaveFileChecked(path, text, eol, doc.hasBom, enc, doc.diskMtime);
            if (result && result.conflict) {
                if (!doc.dirty) {
                    await discardDocAndReload(doc);
                    flash('文件已在外部修改，已重新加载 ' + doc.name);
                    return true;
                }
                if (opts.auto) {
                    doc.staleOnDisk = true;
                    renderTabs();
                    flash('文件已在外部修改，已跳过自动保存：' + doc.name, true);
                    return false;
                }
                const choice = await openSaveConflictDialog(doc, result.deleted);
                if (choice === 'cancel') return false;
                if (choice === 'reload') {
                    await discardDocAndReload(doc);
                    flash('已重新加载 ' + doc.name);
                    return false;
                }
                result = await backend.SaveFileChecked(path, text, eol, doc.hasBom, enc, '');
                if (!result || result.conflict) return false;
            }
            saveMtime = (result && result.mtime) || 0;
        } else {
            await backend.SaveFile(path, text, eol, doc.hasBom, enc);
        }
        if (!saveMtime && backend.GetFileStat) {
            try {
                const st = await backend.GetFileStat(path);
                if (st && st.exists) saveMtime = st.mtime || 0;
            } catch (e) {}
        }
        doc.diskMtime = saveMtime || '';
        doc.staleOnDisk = false;
        doc.enc = enc;
        doc.path = path;
        doc.name = path.split(/[\\/]/).pop();
        doc.untitled = false;
        // 落点决定草稿身份：另存为到草稿目录 → 变成草稿；存到别处 → 不再是草稿
        // （关标签时的「空草稿自动删」只认这个标记，普通文件绝不能被误删）
        doc.draft = isScratchPath(workspaceFolder, path);
        doc.mode = savedMode;
        // 操作留痕：另存为 / 首次落盘（新建）/ 普通保存三类；自动保存不记。
        if (opts.saveAs) {
            activityLog.log('file.saveAs', path, {from: actRel(origPath), bytes: text.length});
        } else if (!hadPath) {
            activityLog.log('file.create', path, {bytes: text.length});
        } else if (!opts.auto) {
            activityLog.log('file.save', path, {bytes: text.length, mode: 'save'});
        }
        doc.text = snapshot;
        doc.bases[savedMode] = snapshot;
        doc.savedText = snapshot;
        if (doc.treeAvailable) doc.rawText = text;
        if (doc.parseError) {
            doc.parseError = null;
            if (file === doc) els.banner.classList.add('hidden');
        }
        if (file === doc) {
            const now = doc.editor ? doc.editor.getText() : snapshot;
            if (now !== snapshot) {
                doc.text = now;
                doc.mode = currentMode;
            }
            updateStatus();
            setFilename(doc.name, doc.path);
            renderBreadcrumb(doc.path);
            renderTabs();
            setDirty(now !== snapshot);
            updateWindowTitle();
        } else {
            doc.dirty = false;
            updateTabDirty(doc);
            renderTabs();
            updateBackendDirty();
        }
        if (!opts.auto && !opts.silent) flash('已保存 ' + doc.name);
        return true;
    } catch (e) {
        // 草稿目录被清掉（存储清理 / 手动删除）后，已打开草稿的保存会 ENOENT：SaveFile 是裸
        // os.WriteFile，不建父目录。重建目录后静默重试一次（方案 §4 的护栏），普通文件不走这条。
        const msg = String((e && e.message) || e);
        if (doc.draft && !opts.reenoentRetry && backend.AIEnsureDir &&
            /no such file|not exist|系统找不到|不存在/i.test(msg)) {
            try {
                await backend.AIEnsureDir(parentFolderOf(doc.path));
                return await saveDoc(doc, {...opts, reenoentRetry: true});
            } catch (e2) {}
        }
        flash((opts.auto ? '自动保存失败：' : '保存失败：') + e, true);
        return false;
    }
}

async function save(opts = {}) {
    return saveDoc(file, opts);
}

// 放弃缓冲区修改并以磁盘版本为准：前台标签立即重载，后台标签切换时重载
async function discardDocAndReload(doc) {
    doc.dirty = false;
    if (doc === file) {
        await reloadActive({quiet: true});
        return;
    }
    doc.staleOnDisk = true;
    updateTabDirty(doc);
    renderTabs();
}

async function saveAs() {
    const ok = await saveDoc(file, {saveAs: true});
    if (ok) syncExplorerActive();
    return ok;
}

async function saveAll() {
    let saved = 0;
    let failed = false;
    for (const doc of docs.slice()) {
        if (!doc.dirty || !doc.path) continue;
        const ok = await saveDoc(doc, {silent: true});
        if (ok) saved++;
        else failed = true;
    }
    const skipped = docs.some((d) => d.dirty && !d.path);
    if (saved) {
        flash('已保存 ' + saved + ' 个文件' + (failed || skipped ? '，部分未保存' : ''), failed || skipped);
    } else if (failed || skipped) {
        flash(skipped ? '未命名文件请单独另存为' : '保存失败', true);
    }
}

els.btnWelcomeOpen.addEventListener('click', openDialog);
els.btnWelcomeFolder.addEventListener('click', openFolderDialog);

// 欢迎页「常用入口」：与活动栏 / 菜单共用同一批底层入口；闭包在点击时求值，
// aiPanel / readingMode / memoApi 等此刻必已初始化，未就绪的域静默跳过
const welcomeEntries = {
    ai: () => aiPanel && aiPanel.open(true),
    memo: () => memoApi.open(),
    browser: () => openBrowserTab('about:blank'),
    terminal: () => toggleDockView('terminal'),
    graph: () => toggleDockView('graph'),
    reading: () => readingMode && readingMode.openBookshelf(),
    search: () => openGlobalSearch(),
    settings: () => openSettings('general'),
};
els.welcome.querySelectorAll('.wb-item[data-wentry]').forEach((btn) => {
    btn.addEventListener('click', () => {
        const run = welcomeEntries[btn.dataset.wentry];
        if (run) run();
    });
});

elsSettings.fixed.addEventListener('change', () => {
    settings.fixedKeys = elsSettings.fixed.checked;
    applySettings();
});
elsSettings.autoSave.addEventListener('change', () => {
    settings.autoSave = elsSettings.autoSave.checked;
    applySettings();
});
elsSettings.codeGuides.addEventListener('change', () => {
    settings.codeGuides = elsSettings.codeGuides.checked;
    applySettings();
});
elsSettings.alwaysOnTop.addEventListener('change', () => {
    settings.alwaysOnTop = elsSettings.alwaysOnTop.checked;
    applySettings();
});
elsSettings.codeWrap.addEventListener('change', () => {
    settings.codeWrap = elsSettings.codeWrap.checked;
    applySettings();
});
elsSettings.completionFiles.addEventListener('change', () => {
    settings.completion = settings.completion || {};
    settings.completion.files = elsSettings.completionFiles.checked;
    applySettings();
});
elsSettings.completionSql.addEventListener('change', () => {
    settings.completion = settings.completion || {};
    settings.completion.sql = elsSettings.completionSql.checked;
    applySettings();
});
elsSettings.completionLive.addEventListener('change', () => {
    settings.completion = settings.completion || {};
    settings.completion.live = elsSettings.completionLive.checked;
    applySettings();
});
elsSettings.tabClose.addEventListener('change', () => {
    settings.tabCloseMode = elsSettings.tabClose.value;
    applySettings();
});
elsSettings.dblClickClose.addEventListener('change', () => {
    settings.dblClickClose = elsSettings.dblClickClose.checked;
    applySettings();
});
elsSettings.shiftClickClose.addEventListener('change', () => {
    settings.shiftClickClose = elsSettings.shiftClickClose.checked;
    applySettings();
});
elsSettings.treeExpand.addEventListener('change', () => {
    settings.treeExpandDefault = elsSettings.treeExpand.value;
    applySettings();
});
elsSettings.mdLineNumbers.addEventListener('change', () => {
    settings.mdLineNumbers = elsSettings.mdLineNumbers.checked;
    applySettings();
    if (currentMode === 'preview' && file) renderMarkdownPreview(file);
});
elsSettings.mdScrollSync.addEventListener('change', () => {
    settings.mdScrollSync = elsSettings.mdScrollSync.checked;
    applySettings();
    // 关闭后如果预览已经滚偏，立即按当前设置拉回/不再跟随
    if (settings.mdScrollSync && file) mdSyncScrollFromAce(file);
});
elsSettings.mdPreviewWidth.addEventListener('change', () => {
    settings.mdPreviewWidth = elsSettings.mdPreviewWidth.value;
    applySettings();
    updateStatus();
});
elsSettings.autoCheckUpdate.addEventListener('change', () => {
    settings.autoCheckUpdate = elsSettings.autoCheckUpdate.checked;
    applySettings();
});
elsSettings.showBanners.addEventListener('change', () => {
    settings.showBanners = elsSettings.showBanners.checked;
    applySettings();
    if (file) showBanner(file, file.parseError);
    else hideBanner();
});
if (elsSettings.developerMode) {
    elsSettings.developerMode.addEventListener('change', async () => {
        developerMode = elsSettings.developerMode.checked;
        syncDevConsoleVisibility();
        try {
            if (backend.SetDeveloperMode) await backend.SetDeveloperMode(developerMode);
            logFrontend('info', '开发者模式已' + (developerMode ? '开启' : '关闭'));
        } catch (e) {
            flash('保存开发者模式失败：' + e, true);
        }
    });
}
if (elsSettings.openLogs) {
    elsSettings.openLogs.addEventListener('click', async () => {
        if (!backend.OpenLogDir) return flash('当前版本不支持打开日志目录', true);
        try {
            await backend.OpenLogDir();
        } catch (e) {
            flash('打开日志目录失败：' + e, true);
        }
    });
}

const activityPane = createActivityPane({
    get activityLog() { return activityLog; },
    get applySettings() { return applySettings; },
    get backend() { return backend; },
    get elsSettings() { return elsSettings; },
    get flash() { return flash; },
    get openConfirmDialog() { return openConfirmDialog; },
    get settings() { return settings; },
    // 页内「去设置」：定位到仍留在设置页的启用开关（settings-tree 反射契约不破）
    get openActivitySettings() {
        return () => settingsUI.openSettingsAtRow('general', elsSettings.activityLog);
    },
});
const {renderActivityPane} = activityPane;
// 补丁库（设置 → 开发者）：最近补丁列表 + 删除（Go 侧 PatchDelete 负责回收文件与摘索引）
const settingsPanePatches = createSettingsPanePatches({
    get backend() { return backend; },
    get flash() { return flash; },
    get openConfirmDialog() { return openConfirmDialog; },
    get root() { return workspaceFolder || ''; },
    // 点补丁行「打开视图」：.patch 文件走 openPath 会由 patch-view 接管（含预检/应用/撤销）
    get openPatchFile() { return (path) => openPath(path); },
});
// 设置 → 存储与清理：条目与删除都在 Go 侧，这里给的是位置（工作区根）与确认/回执通道。
const settingsPaneStorage = createSettingsPaneStorage({
    get backend() { return backend; },
    get flash() { return flash; },
    get openConfirmDialog() { return openConfirmDialog; },
    get root() { return workspaceFolder || ''; },
    get settings() { return settings; },
    get applySettings() { return applySettings; },
    get enhanceSetSelects() { return settingsUI.enhanceSetSelects; },
});

// 设置 → AI → 使用统计：只查 Go 派生库；刷新按钮触发增量回填
const settingsPaneUsageStats = createSettingsPaneUsageStats({
    get backend() { return backend; },
    get flash() { return flash; },
    // 请求日志「每页条数」下拉走设置页同款浮层增强，去掉浏览器原生外观（应用页面不走 settings-ui 扫描）
    get enhanceSelect() { return settingsUI.enhanceSelect; },
});

// 应用页面「认知索引」：.cadt/cognition/ 卷的只读浏览（APP_PAGES 第一个条件可见页，
// visibleWhen=aiCognition）。数据按本窗口工作区现取；「去设置开启」定位到 AI 页的开关行。
const cognitionPage = createAICognitionPage({
    get settings() { return settings; },
    get backend() { return backend; },
    get flash() { return flash; },
    get getWorkspace() { return () => workspaceFolder || ''; },
    get openCognitionSettings() {
        return () => openSettingsAtRow('ai', document.getElementById('ai-opt-cognition'));
    },
});

// 应用页面标签页的挂载器（键 = core/app-pages.js 的 id，值 = mount(root) → 卸载函数）。
// 经 deps 注入 bridge 域：bridge/ 不 import settings/ 与 ai/（同级域互相不 import）。
// 定时任务 / 智能体在面板闭包里（CRUD 后要刷新头部胶囊 / 列表），经 aiPanel 的桥转发。
// AI 面板是惰性初始化的（initAIPanel 只在面板交互路径触发）：用户没开过面板就点开这两页
// 时必须先兜底建面板（initAIPanel 自带 if (aiPanel) return 幂等），否则挂载器返回 null、
// 标签页空白且再激活不自愈（doc.pane 守卫挡住重挂）——兜底与设置页 AI 子页、外部工具页同款。
const appPageMounters = {
    'usage-stats': (root) => settingsPaneUsageStats.mount(root),
    'patches': (root) => settingsPanePatches.mount(root),
    'activity': (root) => activityPane.mount(root),
    'schedules': (root) => {
        if (!aiPanel) initAIPanel();
        return aiPanel && aiPanel.bridgeMountSchedules ? aiPanel.bridgeMountSchedules(root) : null;
    },
    // 智能体的 DOM 停靠在 #agents-park，mount 搬进 / 卸载搬出（ai/agent/ai-agent-settings.js）
    'agents': (root) => {
        if (!aiPanel) initAIPanel();
        return aiPanel && aiPanel.bridgeMountAgents ? aiPanel.bridgeMountAgents(root) : null;
    },
    // 外部工具的 DOM 停靠在 #extcap-park，mount 搬进 / 卸载搬出（settings-pane-external-tools.js）
    'external-tools': (root) => settingsPaneExternalTools.mount(root),
    // 认知索引：纯组件重建型（不依赖 aiPanel 闭包，无需兜底初始化）；入口条件可见（visibleWhen=aiCognition）
    'cognition': (root) => cognitionPage.mount(root),
};

// 设置 → 页面 → 应用页面：目录页，一行一个页面，点开在内容区打开对应标签页（顺带关设置弹层）
const settingsPaneAppPages = createSettingsPaneAppPages({
    get openAppPageTab() { return openAppPageTab; },
    get closeSettings() { return closeDialogs; },
    get iconSvg() { return iconSvg; },
    // 条件可见页（visibleWhen）按当前设置过滤——设置目录是四个入口之一
    get settings() { return settings; },
});

// 侧栏「应用页面」面板：一列页面入口，点行直接在内容区打开标签页。
// 与设置页目录同源（core/app-pages.js），只是宿主不同——侧栏是常用入口，设置页是发现入口。
// 侧栏「应用页面」面板底部的一次性动作：不属 APP_PAGES（那是单例功能页，
// 有身份、会去重），但同属"开个东西看看"的意图，放一起比塞回活动栏更合适。
// 浏览器多开、带 URL 与 profile，语义上更接近"文件"而不是"功能页"，所以只作动作行。
const APP_PAGE_ACTIONS = [
    {id: 'browser', label: '新建浏览器标签页', icon: 'browser', hint: 'Ctrl+Alt+B', run: () => openBrowserTab('about:blank')},
];

function renderAppPagesNav() {
    const host = document.getElementById('app-pages-nav');
    if (!host) return;
    host.textContent = '';
    // 顶部动作区：浏览器 / 便签这类「一次性开一个」的入口（不属 APP_PAGES）
    for (const action of APP_PAGE_ACTIONS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'app-pages-nav-item';
        btn.dataset.pageId = action.id;
        btn.dataset.tip = action.hint ? action.hint : '';
        const ic = document.createElement('span');
        ic.className = 'ap-ic';
        ic.innerHTML = iconSvg(action.icon, 13);
        const label = document.createElement('span');
        label.className = 'ap-label';
        label.textContent = action.label;
        btn.append(ic, label);
        btn.addEventListener('click', action.run);
        host.appendChild(btn);
    }
    const sep = document.createElement('div');
    sep.className = 'app-pages-nav-sep';
    host.appendChild(sep);
    for (const group of appPageGroups(settings)) {
        const heading = document.createElement('div');
        heading.className = 'app-pages-nav-group';
        heading.textContent = group.group;
        host.appendChild(heading);
        for (const page of group.pages) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'app-pages-nav-item';
            btn.dataset.pageId = page.id;
            btn.dataset.tip = page.desc;
            const ic = document.createElement('span');
            ic.className = 'ap-ic';
            ic.innerHTML = iconSvg(page.icon, 13);
            const label = document.createElement('span');
            label.className = 'ap-label';
            label.textContent = page.label;
            btn.append(ic, label);
            btn.addEventListener('click', () => openAppPageTab(page.id));
            host.appendChild(btn);
        }
    }
}

function toggleAppPagesPanel() {
    toggleSidebarView('app-pages');
}
// 设置 → 存储与清理 → 「工作区防护」区：开关组 / 备份时间线 / 快照清单
//（ai-wipeguard.js 的恢复出口；storage pane 渲染完后由 renderStoragePane 包装追加渲染）
const settingsPaneWipeguard = createSettingsPaneWipeguard({
    get backend() { return backend; },
    get root() { return workspaceFolder || ''; },
    get settings() { return settings; },
    get applySettings() { return applySettings; },
    get flash() { return flash; },
    get syncConfig() { return () => wipeguardCtrl.syncConfig(); },
    get confirmAction() {
        return (message, action, okLabel, title, variant, options) => openConfirmDialog(message, action, okLabel, title, variant, options);
    },
});
// 工作区预指令：打开工作区自动执行（shell/lifecycle-hooks.js 控制器）；写动作无条件动作审批
const lifecycleHooksCtl = createLifecycleHooks({
    get settings() { return settings; },
    get applySettings() { return applySettings; },
    get backend() { return backend; },
    get sessionPathKey() { return sessionPathKey; },
    get getWorkspace() { return () => workspaceFolder || ''; },
    get addMessage() { return (...args) => messageCenter.add(...args); },
    get activityLog() { return activityLog; },
});
// 设置 → 生命周期：条目列表 + 编辑器（总开关行在 index.html 静态结构，id lifecycle-enabled）
const settingsPaneLifecycle = createSettingsPaneLifecycle({
    get settings() { return settings; },
    get applySettings() { return applySettings; },
    get flash() { return flash; },
    get confirmAction() {
        return (message, action, okLabel, title, variant, options) => openConfirmDialog(message, action, okLabel, title, variant, options);
    },
    get analyzeDangerousCommand() { return analyzeDangerousCommand; },
    get sessionPathKey() { return sessionPathKey; },
    get getWorkspace() { return () => workspaceFolder || ''; },
    get runOnce() { return () => lifecycleHooksCtl.runForWorkspace(workspaceFolder || ''); },
    get runOnceEntry() { return (entryId) => lifecycleHooksCtl.runOnceForEntry(entryId, workspaceFolder || ''); },
    // 弹窗挂在 body（不在 .settings-pane 里），enhanceSetSelects 扫不到——打开后手动增强
    get enhanceSelect() { return settingsUI.enhanceSelect; },
});
// 设置 → 菜单管理：显隐 / 排序 / 模板，配置只在 settings.newFileMenu 一份
const settingsPaneNewFileMenu = createSettingsPaneNewFileMenu({
    get settings() { return settings; },
    get applySettings() { return applySettings; },
    get flash() { return flash; },
});
// 先渲染一次，让设置搜索能索引到动态行（之后进「菜单管理」时由 selectSettingsPane 重建）
settingsPaneNewFileMenu.renderNewFileMenuPane();
// 外部工具应用页面：能力来源矩阵 + 服务提供商配置（DOM 停靠 index.html 的 #extcap-park，
// mount/unmount 搬进搬出标签页；MCP 组绑定仍归 ai-panel）
const settingsPaneExternalTools = createSettingsPaneExternalTools({
    get backend() { return backend; },
    get flash() { return flash; },
    get enhanceSetSelects() { return settingsUI.enhanceSetSelects; },
    get getMcpToolDefs() {
        return () => (aiPanel && typeof aiPanel.getMcpToolDefs === 'function' ? aiPanel.getMcpToolDefs() : []);
    },
    get getAiPanel() { return () => aiPanel; },
    // 外部工具页要按 mcp.json 渲染 MCP 服务器组：AI 面板是惰性初始化的，直接读 aiPanel
    // 可能拿到 null（用户没开过面板就点开该页）。与设置页 AI 子页一致地在此兜底初始化
    // （initAIPanel 自带 if (aiPanel) return 幂等，不会重复建面板）。
    get ensureAiPanel() {
        return () => {
            if (!aiPanel) initAIPanel();
            return aiPanel;
        };
    },
    get confirmAction() {
        return (message, action, okLabel, title, variant, options) => openConfirmDialog(message, action, okLabel, title, variant, options);
    },
    // 该工厂创建时会立即读取 deps.openExternalUrl；用包装函数把真正的 openExternalUrl 读取推迟到点击时
    get openExternalUrl() { return (url) => openExternalUrl(url); },
});
function refreshExternalToolsPaneIfVisible() {
    // 外部工具已是应用页面标签页：标签开着才刷新（关着时 DOM 在停靠区，不重绘）
    const doc = docs.find((d) => d.appPage === 'external-tools');
    if (doc && doc.appPageRoot && doc.appPageRoot.isConnected) {
        settingsPaneExternalTools.renderExternalToolsPane();
    }
}
// 认知索引开关翻转后的两个刷新点：侧栏「应用页面」面板按 aiCognition 重建入口；
// 已开的认知页标签重读卷（关着的标签页不刷新，下次挂载自然拿到新状态）
// lastCog：上次 settings-changed 处理时的权威开关值（null=尚未收到过事件）。本地开关先改 settings
// 再广播，处理器里 settings 已是新值，故必须以这个独立基线比对 payload.values。
let lastCog = null;
function refreshAppPagesNavIfVisible() {
    if (els.sidebar && els.sidebar.dataset.sidebarView === 'app-pages') renderAppPagesNav();
}
function refreshCognitionPageIfVisible() {
    const doc = docs.find((d) => d.appPage === 'cognition');
    if (doc && doc.appPageRoot && doc.appPageRoot.isConnected) cognitionPage.refresh();
}
const debugConsoleBtn = document.getElementById('opt-debug-console');
if (debugConsoleBtn) debugConsoleBtn.addEventListener('click', () => toggleDockView('debug'));
elsSettings.openMode.addEventListener('change', () => {
    settings.openMode = elsSettings.openMode.value;
    applySettings();
    renderTabs();
});
// 关闭窗口时：直接退出 / 最小化到托盘（applySettings 里的 syncCloseAction 推给后端落盘）
elsSettings.closeAction.addEventListener('change', () => {
    settings.closeAction = elsSettings.closeAction.value === 'tray' ? 'tray' : 'exit';
    applySettings();
    if (settings.closeAction === 'tray') flash('点 X 将最小化到托盘，右键托盘图标可退出');
});
elsSettings.width.addEventListener('input', () => {
    settings.keyWidth = Number(elsSettings.width.value);
    applySettings();
});
elsSettings.font.addEventListener('input', () => {
    settings.editorFont = Number(elsSettings.font.value);
    applySettings();
});
elsSettings.editorLineHeight.addEventListener('input', () => {
    settings.editorLineHeight = Number(elsSettings.editorLineHeight.value);
    applySettings();
});
elsSettings.sidebarFont.addEventListener('input', () => {
    settings.sidebarFont = Number(elsSettings.sidebarFont.value);
    applySettings();
});
elsSettings.treeGuides.addEventListener('change', () => {
    settings.treeGuides = elsSettings.treeGuides.checked;
    applySettings();
});
elsSettings.treeCounts.addEventListener('change', () => {
    settings.treeCounts = elsSettings.treeCounts.checked;
    applySettings();
    humanizeCounts();
});
elsSettings.treeRefresh.addEventListener('change', () => {
    settings.treeRefreshInterval = Number(elsSettings.treeRefresh.value) || 0;
    applySettings();
});
elsSettings.showCadDir.addEventListener('change', () => {
    settings.showCadDir = elsSettings.showCadDir.checked;
    applySettings();
    if (explorer) {
        explorer.setShowCadDir(settings.showCadDir);
        explorer.refresh();
    }
});
elsSettings.uiFont.addEventListener('change', () => {
    settings.uiFont = elsSettings.uiFont.value;
    applySettings();
});
elsSettings.uiCjkFont.addEventListener('change', () => {
    settings.uiCjkFont = elsSettings.uiCjkFont.value;
    applySettings();
});
elsSettings.editorFontFamily.addEventListener('change', () => {
    settings.editorFontFamily = elsSettings.editorFontFamily.value;
    applySettings();
});
elsSettings.editorCjkFont.addEventListener('change', () => {
    settings.editorCjkFont = elsSettings.editorCjkFont.value;
    applySettings();
});
elsSettings.writingMode.addEventListener('change', () => {
    settings.writingMode = elsSettings.writingMode.checked;
    applySettings();
    flash(settings.writingMode ? '写作模式已开启' : '写作模式已关闭');
});
elsSettings.writingFont.addEventListener('change', () => {
    settings.writingFont = elsSettings.writingFont.value;
    applySettings();
});
elsSettings.writingFontSize.addEventListener('input', () => {
    settings.writingFontSize = Number(elsSettings.writingFontSize.value);
    applySettings();
});
elsSettings.writingPaper.addEventListener('change', () => {
    settings.writingPaper = elsSettings.writingPaper.value;
    applySettings();
});
elsSettings.writingLineNumbers.addEventListener('change', () => {
    settings.writingLineNumbers = elsSettings.writingLineNumbers.checked;
    applySettings();
});
elsSettings.writingTypewriter.addEventListener('change', () => {
    settings.writingTypewriter = elsSettings.writingTypewriter.checked;
    applySettings();
});
elsSettings.writingFocus.addEventListener('change', () => {
    settings.writingFocus = elsSettings.writingFocus.checked;
    applySettings();
});
elsSettings.writingDailyGoal.addEventListener('change', () => {
    settings.writingDailyGoal = Math.max(0, Number(elsSettings.writingDailyGoal.value) || 0);
    applySettings();
});

window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (!els.editor.contains(e.target)) return;
    if (currentMode === 'table' && file && file.format.table) {
        zoomCsvTable(file, e.deltaY);
        return;
    }
    if (currentMode === 'image' && file && file.image) {
        zoomImageBy(file, e.deltaY);
        return;
    }
    if (currentMode === 'render' && file && isSvgDoc(file)) {
        zoomSvgRenderBy(file, e.deltaY);
        return;
    }
    const dir = e.deltaY < 0 ? 1 : -1;
    const next = Math.min(24, Math.max(9, settings.editorFont + dir));
    if (next === settings.editorFont) return;
    settings.editorFont = next;
    applySettings();
    flash('编辑器字号 ' + next);
}, {passive: false, capture: true});

const winControls = document.getElementById('win-controls');
if (rt) {
    const maxBtn = document.getElementById('wc-max');
    const syncMaxIcon = async () => {
        const maximised = await rt.WindowIsMaximised();
        maxBtn.innerHTML = iconSvg(maximised ? 'restore' : 'maximize', 12);
        maxBtn.dataset.tip = maximised ? '还原' : '最大化';
        // Wails 运行时的边缘 resize 检测不判断最大化状态：无边框窗口最大化后
        // 鼠标靠近左右两侧仍会亮起调整宽度光标。最大化时直接关掉检测，
        // 还原（含 Win+方向键贴靠，经 resize 事件回到这里）再恢复。
        try {
            if (window.wails && window.wails.flags) window.wails.flags.enableResize = !maximised;
        } catch (e) {}
    };
    document.getElementById('wc-min').addEventListener('click', () => rt.WindowMinimise());
    maxBtn.addEventListener('click', async () => {
        rt.WindowToggleMaximise();
        setTimeout(syncMaxIcon, 100);
    });
    // 标题栏 X 走窗口级关闭（触发 Go 的 WindowClosing：托盘隐藏/关窗确认/
    // 最后一个窗口收口）；runtime.Quit 是应用级退出，留给菜单里的「退出」。
    document.getElementById('wc-close').addEventListener('click', () => { if (rt.WindowClose) rt.WindowClose(); else if (rt.Quit) rt.Quit(); });
    document.getElementById('toolbar').addEventListener('dblclick', (e) => {
        if (e.target.closest('button, input, select, textarea')) return;
        rt.WindowToggleMaximise();
        setTimeout(syncMaxIcon, 120);
    });
    window.addEventListener('resize', syncMaxIcon);
    syncMaxIcon();
} else {
    winControls.style.display = 'none';
}

const menuBarMod = createMenuBar({
    get activityLog() { return activityLog; },
    get closeAllMenus() { return closeAllMenus; },
    get currentMode() { return currentMode; },
    get editor() { return editor; },
    get els() { return els; },
    get file() { return file; },
    get flash() { return flash; },
    get flushCsvCellEditor() { return flushCsvCellEditor; },
    get getFormatSettings() { return getFormatSettings; },
    get markDocDirty() { return markDocDirty; },
    get openMenu() { return openMenu; },
    get renderCsvTableView() { return renderCsvTableView; },
    get settings() { return settings; },
    get textArea() { return textArea; },
    get updateStatus() { return updateStatus; },
});
const {clickEditorButton, formatDocument, getOpenMenuEl, hideMenuBar, menuBar, menuKeyMap, openMenuByKind, setOpenMenuEl, showMenuBar} = menuBarMod;
// switchMode 外壳负责操作留痕（view.switch）；实际切换在 applySwitchMode。
const modeSwitch = createModeSwitch({
    set currentMode(v) { currentMode = v; },
    get activityLog() { return activityLog; },
    get applyAceMode() { return applyAceMode; },
    get applyReadOnlyToDoc() { return applyReadOnlyToDoc; },
    get closeSqlView() { return closeSqlView; },
    get currentMode() { return currentMode; },
    get dirty() { return dirty; },
    get editor() { return editor; },
    get enterAudioView() { return enterAudioView; },
    get enterBinaryView() { return enterBinaryView; },
    get enterCsvTable() { return enterCsvTable; },
    get enterHtmlPreview() { return enterHtmlPreview; },
    get enterImageView() { return enterImageView; },
    get enterMarkdownPreview() { return enterMarkdownPreview; },
    get enterPluginView() { return enterPluginView; },
    get enterSplitView() { return enterSplitView; },
    get enterSqlView() { return enterSqlView; },
    get enterSvgRender() { return enterSvgRender; },
    get enterTextView() { return enterTextView; },
    get enterVideoView() { return enterVideoView; },
    get exitSplitView() { return exitSplitView; },
    get file() { return file; },
    get flash() { return flash; },
    get hideAudioView() { return hideAudioView; },
    get hidePluginView() { return hidePluginView; },
    get hideSvgRender() { return hideSvgRender; },
    get hideVideoView() { return hideVideoView; },
    get hookCodeFoldRanges() { return hookCodeFoldRanges; },
    get hookMultiCursor() { return hookMultiCursor; },
    get isHtmlDoc() { return isHtmlDoc; },
    get isSvgDoc() { return isSvgDoc; },
    get leaveCsvTable() { return leaveCsvTable; },
    get leaveHtmlPreview() { return leaveHtmlPreview; },
    get leaveMarkdownPreview() { return leaveMarkdownPreview; },
    get patchViewContext() { return patchViewContext; },
    get refreshPatchMarkers() { return refreshPatchMarkers; },
    get scheduleGitGutter() { return scheduleGitGutter; },
    get updateSearchState() { return updateSearchState; },
    get updateStatus() { return updateStatus; },
});
const {switchMode} = modeSwitch;

const findBar = createFindBar({
    get currentMode() { return currentMode; },
    get editor() { return editor; },
    get els() { return els; },
    get file() { return file; },
    get flash() { return flash; },
    get groupOfDoc() { return groupOfDoc; },
});
const {closeFindBar, ensureFindBarHost, findState, findTarget, focusFindEditor, openFindBar, runFind} = findBar;
const globalSearch = createGlobalSearch({
    get activateDoc() { return activateDoc; },
    get backend() { return backend; },
    get currentMode() { return currentMode; },
    get editor() { return editor; },
    get els() { return els; },
    // 行式下拉的浮层增强器（settings-select）：AI 会话范围下拉弹出统一 Portal 浮层，不落原生样式
    get enhanceSelect() { return settingsUI.enhanceSelect; },
    get file() { return file; },
    get findDocByPath() { return findDocByPath; },
    get flash() { return flash; },
    get focusFindEditor() { return focusFindEditor; },
    get openPaths() { return openPaths; },
    get openAISessionHit() { return openAISessionHit; },
    get switchMode() { return switchMode; },
    get waitUntil() { return waitUntil; },
    get workspaceFolder() { return workspaceFolder; },
});
const {isGlobalSearchOpen, openGlobalSearch} = globalSearch;

// 全局搜索的「双击 Shift」触发判定（JetBrains 式）：两次干净轻按 + 中间无其它键 + 输入法隔离。
// 触发在 keyup 结算，见下方 keydown / keyup 两个捕获监听。
const shiftDoubleTap = createShiftDoubleTap();

// 全局搜索「搜索 AI 会话」命中跳转：打开 AI 面板 → 切到该会话 → 按 mid 定位消息并高亮。
// mid 在面板里找不到时（索引滞后）退回按 liveIndex 兜底，找不到就只切会话。
async function openAISessionHit(hit) {
    if (!aiPanel || !aiPanel.bridgeSwitchSession) throw new Error('AI 面板未初始化');
    aiPanel.open(true);
    await aiPanel.bridgeSwitchSession(hit.sessionId);
    if (hit.mid && typeof aiPanel.bridgeLocateMessage === 'function') {
        const located = aiPanel.bridgeLocateMessage(hit.mid, hit.liveIndex);
        if (!located) flash('已打开会话「' + (hit.title || '') + '」，未能定位到该消息（会话可能在此期间有变更）');
    }
}
const jsonQuery = createJsonQuery({
    get copyText() { return copyText; },
    get docs() { return docs; },
    get file() { return file; },
    get flash() { return flash; },
    get selectLineInDoc() { return selectLineInDoc; },
    get structureTextForDoc() { return structureTextForDoc; },
});
const {jsonQuerySupported, openJsonQuery} = jsonQuery;
const diffDialog = createDiffDialog({
    get backend() { return backend; },
    get baseNameOf() { return baseNameOf; },
    get copyText() { return copyText; },
    get docs() { return docs; },
    get editor() { return editor; },
    get findDocByPath() { return findDocByPath; },
    get flash() { return flash; },
    get samePathValue() { return samePathValue; },
});
const {openDiffDialog} = diffDialog;
const schemaPanel = createSchemaPanel({
    get backend() { return backend; },
    get baseNameOf() { return baseNameOf; },
    get copyText() { return copyText; },
    get docs() { return docs; },
    get file() { return file; },
    get flash() { return flash; },
    get selectLineInDoc() { return selectLineInDoc; },
    get structureTextForDoc() { return structureTextForDoc; },
});
const {openSchemaValidation} = schemaPanel;
// 窗口切换器缓存：quick-switch「窗口」层用（打开该层时刷新一轮）。
// 列表来自 Go 的窗口注册表（v3 一进程多窗口才有这张表）。
let windowSwitchRows = [];
const WINDOW_MODE_LABELS = {main: '主窗口', float: 'AI 浮窗', debug: '调试控制台', terminal: '终端', memo: '便签', monitor: '会话监控', diff: '文件对比', light: '轻量查看', preview: '实时预览'};
async function refreshWindowSwitchEntries() {
    if (!backend.WindowList) {
        windowSwitchRows = [];
        return;
    }
    try {
        const rows = await backend.WindowList();
        windowSwitchRows = (rows || []).filter((w) => w && w.name);
    } catch (e) {
        windowSwitchRows = []; // 尽力而为路径：失败沿用空列表
    }
}
function windowSwitchEntries() {
    if (!windowSwitchRows.length) return [{label: '（没有其他窗口）', disabled: true}];
    return windowSwitchRows.map((w) => ({
        label: (WINDOW_MODE_LABELS[w.mode] || '窗口') +
            (w.workspace ? ' · ' + baseNameOf(w.workspace) : '') +
            (w.self ? '（当前）' : ''),
        checked: !!w.self,
        action: () => {
            if (w.self) return;
            if (backend.WindowFocusByName) backend.WindowFocusByName(w.name);
        },
    }));
}

// 临时草稿架缓存：quick-switch「临时草稿」层用（打开该层时刷新一轮）。
// 文件树的「临时草稿」节点是主入口（JetBrains Scratches 同款），这一层是键盘可达的快速切换
// （对齐 JetBrains Show Scratch Files）：进层时重读一遍，按 mtime 倒序。
let scratchSwitchRows = [];
async function refreshScratchEntries() {
    scratchSwitchRows = await listScratchDrafts(
        {readDir: (path, limit) => backend.ReadDir(path, limit)}, workspaceFolder);
    return scratchSwitchRows;
}
function scratchMtimeText(ms) {
    const n = Number(ms) || 0;
    if (!n) return '';
    try {
        return new Date(n).toLocaleString('zh-CN', {
            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
        });
    } catch (e) {
        return '';
    }
}
function scratchSwitchEntries() {
    if (!workspaceFolder) return [{label: '（未打开工作区）', disabled: true}];
    // 缓存是上一次刷新时的列表：换过工作区后只认当前草稿目录里的条目
    const rows = scratchSwitchRows.filter((row) => isScratchPath(workspaceFolder, row.path));
    if (!rows.length) return [{label: '（还没有临时文件）', disabled: true}];
    return rows.map((row) => ({
        label: row.name,
        value: scratchMtimeText(row.mtime),
        action: () => openPath(row.path),
    }));
}

const quickSwitchMod = createQuickSwitch({
    get applyAceMode() { return applyAceMode; },
    get applySettings() { return applySettings; },
    get closeAllMenus() { return closeAllMenus; },
    get CODE_STYLES() { return themeRegistry.listCodeThemes(); },
    get CODE_STYLE_AUTO() { return CODE_STYLE_AUTO; },
    get setCodeStyle() { return setCodeStyle; },
    get currentMode() { return currentMode; },
    get currentSidebarView() { return currentSidebarView; },
    get currentTheme() { return currentTheme; },
    get editor() { return editor; },
    get editorFonts() { return editorFonts; },
    get els() { return els; },
    get file() { return file; },
    get focusFindEditor() { return focusFindEditor; },
    get getFormatSettings() { return getFormatSettings; },
    get INDENTS() { return INDENTS; },
    get isDialogOpen() { return isDialogOpen; },
    get setSidebarMode() { return setSidebarMode; },
    get setTheme() { return setTheme; },
    get settings() { return settings; },
    get switchMode() { return switchMode; },
    get terminalUI() { return terminalUI; },
    get themes() { return themeRegistry.listUiThemes(); },
    get toggleAlwaysOnTop() { return toggleAlwaysOnTop; },
    get toggleCodeWrap() { return toggleCodeWrap; },
    get windowSwitchEntries() { return windowSwitchEntries; },
    get refreshWindowSwitchEntries() { return refreshWindowSwitchEntries; },
    // 临时草稿架（quick-switch scratch 层级）：只读 <ws>/.cadt/scratch，选中即 openPath
    get scratchEntries() { return scratchSwitchEntries; },
    get refreshScratchEntries() { return refreshScratchEntries; },
    get toggleSidebar() { return toggleSidebar; },
    get toggleSidebarView() { return toggleSidebarView; },
    get toggleTerminalPanel() { return toggleTerminalPanel; },
    get viewDisabled() { return viewDisabled; },
    get viewLabel() { return viewLabel; },
    get viewOptionsFor() { return viewOptionsFor; },
    get workspaceFolder() { return workspaceFolder; },
    // 书签总览（quick-switch bookmarks 层级）：聚合打开中的文档，删除/跳转回调见上方书签桥
    get bookmarkOverview() { return bookmarkOverviewForUI; },
    get removeBookmarkEntry() { return removeBookmarkEntry; },
    get jumpBookmarkEntry() { return jumpBookmarkEntry; },
});
const {handleQuickSwitchKey, openQuickSwitch, openQuickSwitchAt, quickSwitch, toggleQuickSwitch} = quickSwitchMod;
const appActions = createAppActions({
    get backend() { return backend; },
    get baseNameOf() { return baseNameOf; },
    get explorer() { return explorer; },
    get flash() { return flash; },
    get openFolderSmart() { return openFolderSmart; },
    get openPath() { return openPath; },
    get rt() { return rt; },
});
const {copyExternalIntoDir, exitApp, parentDirOf, readRecentOpen, recentOpenMenuItems, rememberRecentOpen} = appActions;
const sessionRestore = createSessionRestore({
    get setFocusedGroupId() { return setFocusedGroupId; },
    get setSplitRoot() { return setSplitRoot; },
    get activateDoc() { return activateDoc; },
    get activityLog() { return activityLog; },
    get createGroup() { return createGroup; },
    get currentMode() { return currentMode; },
    get docs() { return docs; },
    get editorGroups() { return editorGroupsMod.editorGroups; },
    get file() { return file; },
    get findDocByPath() { return findDocByPath; },
    get flash() { return flash; },
    get focusedGroupId() { return editorGroupsMod.focusedGroupId; },
    get groupDocs() { return groupDocs; },
    get groupOfDoc() { return groupOfDoc; },
    get logFrontend() { return logFrontend; },
    get openFolderWorkspace() { return openFolderWorkspace; },
    get openPathsHere() { return openPathsHere; },
    get rememberDocView() { return rememberDocView; },
    get renderEditorLayout() { return renderEditorLayout; },
    get splitRoot() { return editorGroupsMod.splitRoot; },
    get switchMode() { return switchMode; },
    get workspaceFolder() { return workspaceFolder; },
});
const {knownDocViews, pendingDocViews, readSession, readWorkspaceSession, restoreSession, saveSessionNow, scheduleSessionSave, sessionPathKey} = sessionRestore;
// 个人浏览器标签的保存与启动恢复（shell/browser-tab-restore.js）：openBrowserTab getter
// 指向下方 bridgeUI 解构出的函数——getter 延迟求值，创建期尚处 TDZ 也没关系。
const browserTabRestore = createBrowserTabRestore({
    get backend() { return backend; },
    get logFrontend() { return logFrontend; },
    get openBrowserTab() { return openBrowserTab; },
});
const propertiesUI = createPropertiesUI({
    get activateDoc() { return activateDoc; },
    get backend() { return backend; },
    get baseNameOf() { return baseNameOf; },
    get dirty() { return dirty; },
    get docs() { return docs; },
    get elsDialogs() { return elsDialogs; },
    get file() { return file; },
    get flash() { return flash; },
    get fmtSize() { return fmtSize; },
    get newDocumentWith() { return newDocumentWith; },
    get newFileTypeMenuItems() { return newFileTypeMenuItems; },
    get openConfirmDialog() { return openConfirmDialog; },
    get openCreateEntryDialog() { return openCreateEntryDialog; },
    get openDialogEl() { return openDialogEl; },
    get reloadActive() { return reloadActive; },
    // 临时草稿子菜单与资源管理器「新建 → 临时文件」同一份（explorer-ops.scratchMenuItems）
    get scratchMenuItems() { return scratchMenuItems; },
    get settings() { return settings; },
    get structureTextForDoc() { return structureTextForDoc; },
    get workspaceFolder() { return workspaceFolder; },
});
const {newDocumentMenuItems, propsTimeText, reloadAllFromDisk, showFileProperties} = propertiesUI;
const appLinks = createAppLinks({
    get activateDoc() { return activateDoc; },
    get backend() { return backend; },
    get docs() { return docs; },
    get flash() { return flash; },
    get logFrontend() { return logFrontend; },
    get openBrowserTab() { return openBrowserTab; },
    get openVirtualDoc() { return openVirtualDoc; },
    get rt() { return rt; },
});
const {appFeedbackUrl, appReleasesUrl, openBundledDoc, openDevTools, openExternalUrl, showChangelog, showPrivacy, showTerms, showTutorial} = appLinks;
const updateCheck = createUpdateCheck({
    get appReleasesUrl() { return appReleasesUrl; },
    get backend() { return backend; },
    get closeDialogs() { return closeDialogs; },
    get elsDialogs() { return elsDialogs; },
    get flash() { return flash; },
    get logFrontend() { return logFrontend; },
    get openDialogEl() { return openDialogEl; },
    get openExternalUrl() { return openExternalUrl; },
    get renderMarkdownHtml() { return renderMarkdownHtml; },
    get settings() { return settings; },
    get updateStatus() { return updateStatus; },
    // 发现新版本进消息中心（message-center.js）
    get addMessage() { return (...args) => messageCenter.add(...args); },
});
const {autoCheckUpdateOnStart, checkForUpdates} = updateCheck;
const formatConvert = createFormatConvert({
    get backend() { return backend; },
    get baseNameOf() { return baseNameOf; },
    get editor() { return editor; },
    get file() { return file; },
    get flash() { return flash; },
    get openPath() { return openPath; },
});
const {convertMenuItems, repairJsonAction} = formatConvert;

// ---- 插件命令的上下文环境 ----
// 传给插件命令的 run(env) / when(env)：一次性只读快照，插件据此决定可用性与行为。
function pluginCommandEnv() {
    let hasSelection = false;
    try {
        if (currentMode === 'code' && editor && editor.aceEditor) {
            hasSelection = !!editor.aceEditor.getSelectedText();
        } else if (textArea) {
            hasSelection = textArea.selectionStart !== textArea.selectionEnd;
        }
    } catch (e) {
        hasSelection = false;
    }
    let editorFocused = false;
    try {
        editorFocused = !!(currentMode === 'code' && editor && editor.aceEditor && editor.aceEditor.isFocused());
    } catch (e) {
        editorFocused = false;
    }
    return {
        hasFile: !!file,
        formatId: file && file.format ? file.format.id : '',
        hasSelection,
        readonly: !!file && isDocReadOnly(file, settings),
        workspace: workspaceFolder || '',
        editorFocused,
    };
}

// 编辑器右键菜单里的插件命令：本函数组装好菜单项交给 editor-menus.js 展开，
// 保持 editor 域不依赖插件域。分隔线只在确有命令时插入。
function pluginEditorMenuItems() {
    const list = getPluginCommands().filter((cmd) => commandAppliesTo(cmd, 'editorContext'));
    if (!list.length) return [];
    const env = pluginCommandEnv();
    const items = [];
    for (const cmd of list) {
        if (!evalCommandWhen(cmd, env)) continue;
        items.push({
            label: cmd.label,
            description: cmd.description || undefined,
            icon: cmd.icon || undefined,
            action: () => cmd.run(env),
        });
    }
    return items.length ? [{sep: true}, ...items] : [];
}

// ---- 命令面板动作注册表 ----
function flattenPaletteItems(prefix, item, out) {
    if (!item || item.sep || item.disabled) return;
    // 插件命令由 paletteActions 按 category 单独分组，这里跳过避免与工具菜单重复
    if (item.pluginCommand) return;
    if (item.submenu && item.submenu.length) {
        for (const sub of item.submenu) flattenPaletteItems(prefix, sub, out);
        return;
    }
    if (typeof item.action !== 'function') return;
    out.push({label: prefix + '： ' + item.label, shortcut: item.shortcut || '', action: item.action});
}

function paletteActions() {
    const actions = [];
    const kinds = [['file', '文件'], ['edit', '编辑'], ['format', '格式'], ['view', '视图'], ['tools', '工具'], ['theme', '主题'], ['help', '帮助']];
    for (const [kind, prefix] of kinds) {
        let items = [];
        try { items = menuItems(kind) || []; } catch (e) { items = []; }
        for (const item of items) flattenPaletteItems(prefix, item, actions);
    }
    // 菜单外的高频动作
    actions.push({label: 'AI： 打开 / 关闭助手面板', shortcut: 'Alt+9', action: () => toggleAIPanel()});
    if (aiPanel && typeof aiPanel.paletteActions === 'function') {
        try {
            actions.push(...aiPanel.paletteActions());
        } catch (e) {}
    }
    actions.push({label: '书签： 切换当前行书签', shortcut: 'F11', action: toggleBookmark});
    if (readingMode) {
        actions.push(
            {label: '阅读： 打开书籍…', action: () => readingMode.openBookshelf()},
            {label: '阅读： 添加书签', shortcut: 'Ctrl+D', action: () => readingMode.addBookmark()},
            {label: '阅读： 阅读统计', action: () => readingMode.openStatsDialog()},
            {label: '阅读： 专注模式', action: () => readingMode.toggleFocus()},
        );
    }
    actions.push({label: '书签： 跳到下一个书签', shortcut: 'F2', action: () => jumpBookmark(1)});
    actions.push({label: '书签： 跳到上一个书签', shortcut: 'Shift+F2', action: () => jumpBookmark(-1)});
    actions.push({label: '书签： 清除当前文档书签', action: clearDocBookmarksCurrent});
    actions.push({label: '数据： JSONPath 查询…', shortcut: 'Ctrl+Shift+J', action: openJsonQuery});
    actions.push({label: '数据： 比较两个已打开的文件…', action: () => openDiffDialog()});
    actions.push({label: '数据： JSON Schema 校验…', action: openSchemaValidation});
    for (const [value, label] of [['720', '720px'], ['860', '860px'], ['920', '920px'], ['1100', '1100px'], ['1300', '1300px'], ['0', '自适应']]) {
        actions.push({label: '设置： Markdown 预览宽度 ' + label, action: () => {
            settings.mdPreviewWidth = value;
            applySettings();
            updateStatus();
        }});
    }
    // 插件命令：按 category 分组进面板（面板对全部插件命令开放，不看 contexts）。
    // when 不满足的直接不出现（与内置动作 disabled 即跳过同一口径）。
    const pluginCmds = getPluginCommands();
    if (pluginCmds.length) {
        const env = pluginCommandEnv();
        for (const cmd of pluginCmds) {
            if (!evalCommandWhen(cmd, env)) continue;
            actions.push({
                label: commandCategoryLabel(cmd) + '： ' + cmd.label,
                shortcut: cmd.shortcut ? cmd.shortcut.label : '',
                action: () => cmd.run(pluginCommandEnv()),
            });
        }
    }
    return actions;
}

function menuItems(kind) {
    const tree = currentMode === 'tree' && !!file && !(file.format && file.format.rawOnly);
    const canSave = !!file && !file.large && !file.binary;
    const hasPath = !!(file && file.path);
    const hasDirty = docs.some((d) => d.dirty);
    switch (kind) {
        case 'file': {
            const otherDocs = docs.filter((d) => d !== file);
            const reloadable = docs.some((d) => d.path);
            const exportDir = workspaceFolder || (hasPath ? parentDirOf(file.path) : '');
            return [
                {label: '新建', shortcut: 'Ctrl+N', icon: 'plus', submenu: newDocumentMenuItems()},
                {label: '新建窗口', shortcut: 'Ctrl+Shift+N', icon: 'new-window', action: openNewWindow},
                {label: '新建浏览器标签页', shortcut: 'Ctrl+Alt+B', icon: 'browser', action: () => openBrowserTab('about:blank')},
                {label: '打开我的浏览器（保留登录）', icon: 'browser', action: () => openBrowserTab('about:blank', '', {personal: true})},
                {label: '快捷便签面板', shortcut: 'Ctrl+Alt+T', icon: 'memo', action: () => openMemoTab()},
                {sep: true},
                {label: '打开…', shortcut: 'Ctrl+O', icon: 'open-folder', action: openDialog},
                {label: '打开文件夹…', icon: 'folder', action: openFolderDialog},
                {label: '打开书籍…', icon: 'doc', action: () => readingMode && readingMode.openBookshelf()},
                {label: '最近打开', icon: 'history', submenu: recentOpenMenuItems()},
                {label: '关闭文件夹', icon: 'close', disabled: !workspaceFolder, action: closeFolder},
                {sep: true},
                {label: '保存', shortcut: 'Ctrl+S', icon: 'save', disabled: !canSave, action: () => save()},
                {label: '另存为…', shortcut: 'Ctrl+Shift+S', icon: 'save', disabled: !canSave, action: saveAs},
                {label: '保存全部', disabled: !hasDirty, action: saveAll},
                {sep: true},
                {label: '重新加载', icon: 'refresh', disabled: !hasPath, action: requestReload},
                {label: '从磁盘全部重新加载', icon: 'download', disabled: !reloadable, action: reloadAllFromDisk},
                {sep: true},
                {label: '打开文件位置', icon: 'folder', disabled: !hasPath, action: showInFolder},
                {
                    label: '复制路径',
                    icon: 'copy',
                    disabled: !hasPath,
                    submenu: [
                        {label: '复制完整路径', icon: 'copy', action: () => copyText(file.path, '路径')},
                        {label: '复制所在目录', icon: 'copy', action: () => copyText(parentDirOf(file.path), '目录路径')},
                        {label: '复制文件名', icon: 'copy', action: () => copyText(file.name, '文件名')},
                    ],
                },
                {sep: true},
                {label: '文件属性…', icon: 'info', disabled: !hasPath, action: showFileProperties},
                {
                    label: '导出',
                    icon: 'export',
                    submenu: [
                        {label: '复制结构化目录', disabled: !exportDir, action: () => copyStructuredDir(exportDir)},
                        {label: '导出结构化目录…', disabled: !exportDir, action: () => exportStructuredDir(exportDir)},
                    ],
                },
                {sep: true},
                {label: '关闭标签', shortcut: 'Ctrl+W', icon: 'close', disabled: !file, action: () => requestCloseDoc(file)},
                {label: '关闭其他标签', disabled: !otherDocs.length, action: () => closeDocsWithConfirm(otherDocs)},
                {label: '关闭所有标签', disabled: !docs.length, action: () => closeDocsWithConfirm(docs.slice(), '关闭所有标签页将丢弃未保存的修改。')},
                {label: '重新打开关闭的标签页', shortcut: 'Ctrl+Shift+T', icon: 'undo', disabled: !closedTabs.length, action: reopenClosedTab},
                {sep: true},
                {label: '设置…', shortcut: 'Ctrl+,', icon: 'gear', action: () => openSettings('general')},
                {sep: true},
                {label: '退出', icon: 'close', action: exitApp},
            ];
        }
        case 'edit':
            return [
                {label: '撤销', shortcut: 'Ctrl+Z', icon: 'undo', action: doUndo},
                {label: '重做', shortcut: 'Ctrl+Y', icon: 'redo', action: doRedo},
                {sep: true},
                {label: '查找…', shortcut: 'Ctrl+F', icon: 'search', disabled: !findTarget(), action: openFindBar},
                {label: '全局搜索…', shortcut: getShortcut('edit.globalSearch', keymap.style), icon: 'search', action: openGlobalSearch},
            ];
        case 'format':
            return [
                {label: '格式化', shortcut: 'Ctrl+Alt+L', action: formatDocument},
                {label: '压缩', action: () => clickEditorButton('.jsoneditor-compact')},
                {sep: true},
                {label: '修复 JSON', disabled: !file || !file.format || file.format.id !== 'json' || !!file.binary, action: repairJsonAction},
                {label: '转换为…', disabled: !file || !file.format || !!file.binary || !!file.large, submenu: convertMenuItems()},
                {sep: true},
                {
                    label: '小说排版',
                    disabled: !writingFormatable(),
                    submenu: [
                        {label: '整理段落', action: () => applyWritingFormat(false)},
                        {label: '段首缩进两格', disabled: !file || !file.format || file.format.id !== 'text', action: () => applyWritingFormat(true)},
                    ],
                },
                {sep: true},
                {label: '排序', disabled: !tree, action: () => clickEditorButton('.jsoneditor-sort')},
                {label: '变换…', disabled: !tree, action: () => clickEditorButton('.jsoneditor-transform')},
            ];
        case 'view': {
            const structured = !!file && !!file.treeAvailable;
            const items = [
                {label: '快速切换…', shortcut: 'Ctrl+`', icon: 'select-all', action: openQuickSwitch},
                {label: '书签总览', shortcut: getShortcut('edit.bookmarkList', keymap.style), action: openBookmarkList},
                {sep: true},
            ];
            const splitActive = !!(file && file.splitActive);
            items.push(...viewOptionsFor(file && file.format, file).map(([mode, label]) => ({
                label,
                checked: mode === 'split' ? splitActive
                    : (mode === 'sql' ? !!(file && file.sqlActive) : (!splitActive && currentMode === mode)),
                disabled: viewDisabled(mode),
                action: () => switchMode(mode),
            })));
            items.push(
                {sep: true},
                {label: '终端面板', shortcut: 'Alt+F12', checked: terminalUI.open && getDockView() === 'terminal', action: () => toggleDockView('terminal')},
                ...(developerMode ? [{label: '调试控制台', shortcut: 'F12', checked: terminalUI.open && getDockView() === 'debug', action: () => toggleDockView('debug')}] : []),
                {label: '文件侧边栏', shortcut: 'Ctrl+B', checked: !!settings.showSidebar, action: () => toggleSidebar()},
                {label: '文件列表', checked: settings.sidebarMode === 'list', action: () => setSidebarMode('list')},
                {label: '文件树', checked: settings.sidebarMode === 'tree', action: () => setSidebarMode('tree')},
                {label: '结构视图', shortcut: 'Alt+7', checked: !!settings.showSidebar && currentSidebarView() === 'structure', action: () => toggleSidebarView('structure')},
                {label: 'AI 会话', shortcut: 'Alt+8', checked: !!settings.showSidebar && currentSidebarView() === 'chats', action: () => toggleSidebarView('chats')},
                {sep: true},
                {label: '自动换行', checked: !!settings.codeWrap, action: toggleCodeWrap},
                {label: '写作模式', checked: !!settings.writingMode, action: toggleWritingMode},
                {label: '阅读模式', checked: !!(readingMode && readingMode.isActive()), action: () => readingMode && readingMode.toggle()},
                {label: '展开全部', shortcut: 'Ctrl+Shift+=', disabled: !tree, action: () => file && expandAllWithGuard(file)},
                {label: '收起全部', shortcut: 'Ctrl+Shift+-', disabled: !tree, action: () => editor && editor.collapseAll()},
                {sep: true},
                {label: '全屏', checked: !!rtFullscreen, action: toggleFullscreen},
                {label: '窗口置顶', checked: !!settings.alwaysOnTop, action: toggleAlwaysOnTop},
                {sep: true},
                {
                    label: 'AI 助手面板',
                    shortcut: 'Alt+9',
                    checked: aiPanel ? aiPanel.isOpen() : !!settings.aiPanelOpen,
                    action: () => toggleAIPanel(),
                },
                {
                    label: 'AI 面板显示方式',
                    submenu: [
                        {label: '停靠（无文件时占满，打开后分屏）', checked: settings.aiFloatMode === 'dock', action: () => setAIPanelMode('dock')},
                        {label: '全屏（仅覆盖文件内容区）', checked: settings.aiFloatMode === 'fullscreen', action: () => setAIPanelMode('fullscreen')},
                        {label: '悬浮（独立窗口）', action: () => setAIPanelMode('float')},
                    ],
                },
                {label: '收起编辑区（标签页保留）', checked: isEditorCollapsed(), action: () => toggleEditorCollapsed()},
            );
            return items;
        }
        case 'theme': {
            const items = [];
            let prevGroup = '';
            themeRegistry.listUiThemes().forEach((theme) => {
                if (prevGroup && theme.group !== prevGroup) items.push({sep: true});
                items.push({
                    label: theme.name,
                    checked: settings.theme === theme.id,
                    swatch: theme.bg,
                    swatchAccent: theme.accent,
                    action: () => setTheme(theme.id),
                });
                prevGroup = theme.group;
            });
            // 代码风格是独立通道：与上面的软件主题自由组合，切换只改代码着色。
            items.push({sep: true});
            const codeItems = [{
                label: '跟随软件主题',
                checked: (settings.codeStyle || CODE_STYLE_AUTO) === CODE_STYLE_AUTO,
                action: () => setCodeStyle(CODE_STYLE_AUTO),
            }];
            let prevCodeGroup = '';
            themeRegistry.listCodeThemes().forEach((style) => {
                if (prevCodeGroup && style.group !== prevCodeGroup) codeItems.push({sep: true});
                codeItems.push({
                    label: style.name,
                    checked: settings.codeStyle === style.id,
                    action: () => setCodeStyle(style.id),
                });
                prevCodeGroup = style.group;
            });
            items.push({label: '代码主题', submenu: codeItems});
            return items;
        }
        case 'tools': {
            const items = [{
                label: '运行当前文件',
                shortcut: 'F5',
                icon: 'play',
                disabled: !file || !runController.isSupported({name: file.name, path: file.path}) || isDocReadOnly(file, settings),
                action: () => runController.run(),
            }, {
                label: '停止运行',
                shortcut: 'Shift+F5',
                icon: 'close',
                disabled: !runController.hasRunning(),
                action: () => runController.stop(),
            }, {
                label: '运行面板',
                shortcut: 'Alt+F11',
                icon: 'terminal',
                action: () => runController.togglePanel(),
            }, {
                label: '运行项目…',
                shortcut: 'Ctrl+F5',
                icon: 'terminal',
                disabled: !file && !workspaceFolder,
                action: () => startRunProject(),
            }, {sep: true}, {
                label: 'JSONPath 查询…',
                shortcut: 'Ctrl+Shift+J',
                icon: 'search',
                disabled: !jsonQuerySupported(file),
                action: openJsonQuery,
            }, {
                label: '比较两个文件…',
                icon: 'doc',
                disabled: docs.filter((d) => d.path && !d.binary).length < 2,
                action: () => openDiffDialog(),
            }, {
                label: 'JSON Schema 校验…',
                icon: 'check',
                disabled: !file || file.binary || !file.format || (file.format.id !== 'json' && file.format.id !== 'jsonl'),
                action: openSchemaValidation,
            }];
            items.push({sep: true},
                {label: '起名器…', icon: 'sparkles', action: openWritingNameDialog},
                {label: '插入： 场景分隔符', icon: 'plus', disabled: !file || !!file.binary || !!file.large, action: insertSceneSeparator});
            // 应用页面（使用统计 / 外部工具 / 定时任务 / 操作记录 / 补丁库）：从设置对话框搬出来的
            // 数据浏览面板，现在各自是一个内容区标签页。清单单一来源 core/app-pages.js；
            // 提示：paletteActions() 会递归展开 submenu，所以命令面板自动就能搜到这几项。
            items.push({sep: true}, {
                label: '应用页面',
                icon: 'list',
                submenu: appPageGroups(settings).flatMap((group, index) => [
                    ...(index ? [{sep: true}] : []),
                    ...group.pages.map((page) => ({
                        label: page.label,
                        icon: page.icon,
                        action: () => openAppPageTab(page.id),
                    })),
                ]),
            });
            const toolCmds = getPluginCommands().filter((cmd) => commandAppliesTo(cmd, 'tools'));
            if (!toolCmds.length) {
                items.push({sep: true}, {label: '（暂无插件命令）', disabled: true});
            } else {
                const env = pluginCommandEnv();
                items.push({sep: true}, ...toolCmds.map((cmd) => ({
                    label: cmd.label,
                    icon: cmd.icon || undefined,
                    shortcut: cmd.shortcut ? cmd.shortcut.label : '',
                    // 标记来源：命令面板遍历菜单时据此跳过，改用插件自己的分组前缀
                    pluginCommand: true,
                    disabled: !evalCommandWhen(cmd, env),
                    action: () => cmd.run(env),
                })));
            }
            return items;
        }
        case 'help': {
            const items = [
                {label: '检查更新…', icon: 'download', action: checkForUpdates},
                {label: '更新日志', icon: 'doc', action: showChangelog},
                {label: '教程', icon: 'doc', action: showTutorial},
                {label: '反馈', icon: 'feedback', action: () => openExternalUrl(appFeedbackUrl)},
                {sep: true},
                {label: '用户协议', icon: 'doc', action: showTerms},
                {label: '隐私协议', icon: 'shield', action: showPrivacy},
                {sep: true},
                {label: '命令面板', shortcut: 'Ctrl+Shift+P', icon: 'search', action: () => palette && palette.toggle()},
                {label: '快捷键', action: () => openSettings('shortcuts')},
            ];
            if (developerMode) items.push({label: '开发者工具', icon: 'terminal', action: openDevTools});
            items.push({label: '关于 CaDt-DataLens', action: () => openSettings('about')});
            return items;
        }
        default:
            return [];
    }
}

function renderDropdown(menuEl) {
    const dd = menuEl.querySelector('.dropdown');
    dd.textContent = '';
    for (const it of menuItems(menuEl.dataset.menu)) {
        if (it.sep) {
            const s = document.createElement('div');
            s.className = 'menu-sep';
            dd.appendChild(s);
            continue;
        }
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'menu-item' + (it.disabled ? ' disabled' : '');
        const icon = document.createElement('span');
        icon.className = 'mi-icon' + (it.iconClass ? ' ' + it.iconClass : '');
        renderMenuIcon(icon, it);
        const label = document.createElement('span');
        label.className = 'mi-label';
        label.textContent = it.label;
        const key = document.createElement('span');
        key.className = 'mi-key';
        key.textContent = it.shortcut || '';
        row.append(icon, label, key);
        if (it.submenu) {
            const arrow = document.createElement('span');
            arrow.className = 'ctx-arrow';
            arrow.innerHTML = iconSvg('chevron-right', 10);
            row.appendChild(arrow);
            row.addEventListener('mouseenter', () => {
                if (!it.disabled) openDropdownSubmenu(row, it.submenu);
            });
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!it.disabled) openDropdownSubmenu(row, it.submenu);
            });
        } else {
            row.addEventListener('mouseenter', (e) => {
                if (!ctxMenu || !ctxMenu.isOpen()) return;
                // 菜单条下拉的子菜单是独立 ctxMenu 实例：指针在下拉项的预测锥内
                // （斜向走向子菜单）时延迟收起，锥外立即收起。复用 lastMouseX/Y 到点复核。
                const px = typeof e.clientX === 'number' ? e.clientX : lastMouseX;
                const py = typeof e.clientY === 'number' ? e.clientY : lastMouseY;
                if (dropdownSubAnchor && px != null && inSubmenuCone(px, py,
                    dropdownSubAnchor.getBoundingClientRect(), ctxMenu.rootEl().getBoundingClientRect())) {
                    clearTimeout(dropdownSubCloseTimer);
                    dropdownSubCloseTimer = setTimeout(() => {
                        dropdownSubCloseTimer = 0;
                        if (!ctxMenu || !ctxMenu.isOpen()) return;
                        const r = ctxMenu.rootEl().getBoundingClientRect();
                        if (lastMouseX >= 0 && pointInRect(lastMouseX, lastMouseY, r)) return;
                        ctxMenu.close();
                    }, SUBMENU_CONE_CLOSE_DELAY_MS);
                    return;
                }
                clearTimeout(dropdownSubCloseTimer);
                ctxMenu.close();
            });
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                if (it.disabled) return;
                hideMenuBar();
                it.action();
            });
        }
        dd.appendChild(row);
    }
}

// 子菜单动作执行后也要把菜单条收回三横（IDEA 同款）
function wrapMenuActions(items) {
    return items.map((it) => {
        if (it.submenu) return {...it, submenu: wrapMenuActions(it.submenu)};
        if (it.action) return {...it, action: (...args) => { hideMenuBar(); it.action(...args); }};
        return it;
    });
}

// 菜单条下拉子菜单的预测锥状态：锚点行 + 挂起收起计时器（onClose 复位锚点）
let dropdownSubAnchor = null;
let dropdownSubCloseTimer = 0;
// 下拉的弹层栈条目：Esc 由栈按层序退（closeAllMenus 的每条路径都要出栈）
let menubarPopHandle = null;

function openDropdownSubmenu(anchor, items) {
    if (!ctxMenu || !items || !items.length) return;
    const rect = anchor.getBoundingClientRect();
    clearTimeout(dropdownSubCloseTimer);
    // open() 会先跑上一个菜单的 onClose（把 dropdownSubAnchor 清掉），锚点必须在 open 之后再记
    ctxMenu.open(wrapMenuActions(items), rect.right + 2, rect.top - 4, {
        onClose: () => { dropdownSubAnchor = null; },
    });
    dropdownSubAnchor = anchor;
}

function closeAllMenus() {
    document.querySelectorAll('#menubar .menu').forEach((m) => {
        m.classList.remove('open');
        m.querySelector('.dropdown').classList.add('hidden');
    });
    if (menubarPopHandle) {
        menubarPopHandle.dispose();
        menubarPopHandle = null;
    }
    if (ctxMenu) ctxMenu.close();
    setOpenMenuEl(null);
}

function openMenu(menuEl) {
    closeAllMenus();
    renderDropdown(menuEl);
    const dd = menuEl.querySelector('.dropdown');
    dd.classList.remove('hidden');
    dd.style.maxHeight = '';
    dd.style.overflowY = '';
    // 窗口高度不够时限制在视口内并内部滚动（IDEA 同款），不再被底边截断
    const rect = dd.getBoundingClientRect();
    const available = window.innerHeight - rect.top - 8;
    if (rect.height > available && available > 120) {
        dd.style.maxHeight = available + 'px';
        dd.style.overflowY = 'auto';
    }
    menuEl.classList.add('open');
    setOpenMenuEl(menuEl);
    // 下拉进全局弹层栈：Esc 由栈按层序退；z-index 也由栈分配（menu 档）
    menubarPopHandle = overlayStack.open({
        id: 'menubar-dropdown', kind: 'menu', el: dd,
        onClose: () => { closeAllMenus(); return true; },
    });
}

// 菜单条在静止鼠标下唤出时会补发 mouseenter，坐标与上次真实移动相同则不算悬停切换
let lastMouseX = -1, lastMouseY = -1;
document.addEventListener('mousemove', (e) => { lastMouseX = e.clientX; lastMouseY = e.clientY; }, true);
document.querySelectorAll('#menubar .menu').forEach((menuEl) => {
    menuEl.querySelector('.menu-label').addEventListener('click', (e) => {
        e.stopPropagation();
        if (getOpenMenuEl() === menuEl) {
            closeAllMenus();
            return;
        }
        openMenu(menuEl);
    });
    menuEl.querySelector('.menu-label').addEventListener('mouseenter', (e) => {
        if (e.clientX === lastMouseX && e.clientY === lastMouseY) return;
        if (getOpenMenuEl() && getOpenMenuEl() !== menuEl) openMenu(menuEl);
    });
});
window.addEventListener('blur', () => hideMenuBar());
document.addEventListener('click', (e) => {
    if (menuBar.classList.contains('hidden')) return;
    const t = e.target;
    if (t && t.closest && (t.closest('#menubar') || t.closest('.ctx-menu'))) return;
    hideMenuBar();
}, true);

function updateSearchState() {
    if (!findState.open) return;
    if (!findTarget()) {
        closeFindBar({keepFocus: true});
        return;
    }
    ensureFindBarHost();
    runFind({keepIndex: true});
}

function isDialogOpen() {
    return !elsDialogs.mask.classList.contains('hidden');
}

function isTypingTarget() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    return !!(el.closest && el.closest('.ace_editor'));
}

// Ctrl+Z / Ctrl+Y：普通文本输入控件（AI 输入框、设置项、查找框等）的撤销交给控件自己的撤销栈，
// 别被全局快捷键抢去做编辑器 undo/redo；Ace / jsoneditor 仍走 doUndo/doRedo（含空栈回退已保存态）。
function isPlainTextUndoTarget() {
    if (!isTypingTarget()) return false;
    const active = document.activeElement;
    if (!active) return false;
    if (active.closest && active.closest('.ace_editor')) return false;
    if (active.matches && active.matches('textarea.jsoneditor-text')) return false;
    return true;
}

// 文件树聚焦时 Ctrl+Z/Y 走 explorerOps 的操作历史（删除可从回收站还原），而不是编辑器撤销。
// 必须在捕获层拦截器和冒泡层全局快捷键之前判定。
function isExplorerUndoTarget() {
    return !!(explorer && explorer.hasFocus && explorer.hasFocus());
}

function handleExplorerUndoKey(e) {
    if (!isExplorerUndoTarget()) return false;
    const key = (e.key || '').toLowerCase();
    const redo = key === 'y' || (key === 'z' && e.shiftKey);
    if (!redo && key !== 'z') return false;
    e.preventDefault();
    e.stopPropagation();
    if (redo) explorerOps.redoExplorer();
    else explorerOps.undoExplorer();
    return true;
}

// 编辑器（Ace 隐藏输入框）不算纯文本输入，允许编辑器内使用 Git 快捷键
function isPlainTextEntryTarget() {
    const el = document.activeElement;
    if (!el) return false;
    if (el.closest && el.closest('.ace_editor')) return false;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || !!el.isContentEditable;
}

function treeShortcutSelection() {
    const selected = explorer && explorer.getSelection();
    if (!selected || !selected.length || !explorer.hasFocus() || isTypingTarget() || isDialogOpen()) return null;
    return selected;
}

document.addEventListener('copy', (e) => {
    const selected = treeShortcutSelection();
    if (!selected) return;
    e.preventDefault();
    e.stopPropagation();
    setFileClipboard(selected, false);
}, true);

document.addEventListener('cut', (e) => {
    const selected = treeShortcutSelection();
    if (!selected) return;
    e.preventDefault();
    e.stopPropagation();
    if (settings.readOnlyMode) flash('只读模式下不能剪切', true);
    else setFileClipboard(selected, true);
}, true);

window.addEventListener('keydown', (e) => {
    if (isGlobalSearchOpen()) return;
    // 双击 Shift 判定：每个 keydown 都喂给状态机（中间按任意键要能清零配对）。
    // 这里只更新状态，真正触发在 keyup 结算——保证是两次完整的「按下 + 抬起」。
    shiftDoubleTap.onKeyDown(e);
    if (e.key === 'Shift' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat) {
        return;
    }
    // 快捷键风格查表：事件归一化成 'Ctrl+Shift+P' 这样的组合串，再按当前风格命中动作。
    // 风格（settings.keyStyle）切换后索引重建，这里立即按新风格生效；
    // 键位单一来源在 core/keybindings.js，与设置页文案同源。
    const kb = keymap.combo(e);
    if (keymap.is(kb, 'view.quickSwitch')) {
        if (isDialogOpen()) return;
        e.preventDefault();
        e.stopPropagation();
        toggleQuickSwitch();
        return;
    }
    if (quickSwitch.open) {
        if (handleQuickSwitchKey(e)) e.preventDefault();
        e.stopPropagation();
        return;
    }
    if (palette && palette.isOpen()) {
        // 输入框内的键由 palette 自行处理，全局键屏蔽
        return;
    }
    if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && menuKeyMap[e.code]) {
        e.preventDefault();
        e.stopPropagation();
        showMenuBar();
        openMenuByKind(menuKeyMap[e.code]);
        return;
    }
    if (keymap.is(kb, 'view.palette')) {
        e.preventDefault();
        e.stopPropagation();
        palette.toggle();
        return;
    }
    // 全局搜索：VS Code 风格下是 Ctrl+P / Ctrl+Shift+F；
    // CandySweet / IDEA 风格走双击 Shift（在 keyup 里结算，见下方监听）。
    if (keymap.is(kb, 'edit.globalSearch')) {
        e.preventDefault();
        e.stopPropagation();
        openGlobalSearch();
        return;
    }
    if (keymap.is(kb, 'view.sidebar')) {
        e.preventDefault();
        e.stopPropagation();
        toggleSidebar();
        return;
    }
    const key = e.key.toLowerCase();
    // gitStateCache 在模块底部才从 bridgeUI 解构绑定；面板/求值早期到达的按键事件读它会 TDZ——按无仓库处理（同 getGitRepo 先例）
    let gitAvailableEarly = false;
    try { gitAvailableEarly = !!gitStateCache.available; } catch (e) {}
    if (!isDialogOpen() && gitAvailableEarly && !isPlainTextEntryTarget()) {
        if (e.ctrlKey && !e.altKey && !e.shiftKey && key === 'k') {
            e.preventDefault();
            e.stopPropagation();
            gitPopOpenCommit();
            return;
        }
        if (e.ctrlKey && !e.altKey && !e.shiftKey && key === 't') {
            e.preventDefault();
            e.stopPropagation();
            gitPopUpdateProject();
            return;
        }
        if (e.ctrlKey && e.shiftKey && !e.altKey && key === 'k') {
            e.preventDefault();
            e.stopPropagation();
            gitPopPush();
            return;
        }
        if (e.ctrlKey && e.altKey && !e.shiftKey && key === 'n') {
            e.preventDefault();
            e.stopPropagation();
            gitPopNewBranch();
            return;
        }
    }
    if (!isDialogOpen() && (keymap.is(kb, 'run.current') || keymap.is(kb, 'run.stop'))) {
        e.preventDefault();
        e.stopPropagation();
        if (keymap.is(kb, 'run.stop')) runController.stop();
        else runController.run();
        return;
    }
    if (!isDialogOpen() && keymap.is(kb, 'run.project')) {
        e.preventDefault();
        e.stopPropagation();
        startRunProject();
        return;
    }
    if (!isDialogOpen() && keymap.is(kb, 'run.panel')) {
        e.preventDefault();
        e.stopPropagation();
        toggleDockView('run');
        return;
    }
    if (keymap.is(kb, 'view.structure')) {
        e.preventDefault();
        e.stopPropagation();
        toggleSidebarView('structure');
    } else if (keymap.is(kb, 'view.chats')) {
        e.preventDefault();
        e.stopPropagation();
        toggleSidebarView('chats');
    } else if (keymap.is(kb, 'ai.togglePanel')) {
        e.preventDefault();
        e.stopPropagation();
        toggleAIPanel();
    } else if (keymap.is(kb, 'file.openInNewWindow')) {
        e.preventDefault();
        e.stopPropagation();
        if (file && file.path) openInNewWindows([file.path]);
    } else if (keymap.is(kb, 'edit.nextBookmark')) {
        e.preventDefault();
        e.stopPropagation();
        jumpBookmark(1);
    } else if (keymap.is(kb, 'edit.bookmarkList')) {
        e.preventDefault();
        e.stopPropagation();
        openBookmarkList();
    } else if (keymap.is(kb, 'edit.prevBookmark')) {
        e.preventDefault();
        e.stopPropagation();
        jumpBookmark(-1);
    } else if (keymap.is(kb, 'tree.delete')) {
        const selected = treeShortcutSelection();
        if (selected && selected.length) {
            e.preventDefault();
            e.stopPropagation();
            deleteExplorerEntries(selected);
        }
    } else if (keymap.is(kb, 'tree.copy') || keymap.is(kb, 'tree.cut') || keymap.is(kb, 'tree.paste')) {
        const selected = treeShortcutSelection();
        if (selected) {
            e.preventDefault();
            e.stopPropagation();
            if (keymap.is(kb, 'tree.copy')) setFileClipboard(selected, false);
            else if (keymap.is(kb, 'tree.cut')) {
                if (settings.readOnlyMode) flash('只读模式下不能剪切', true);
                else setFileClipboard(selected, true);
            } else {
                if (settings.readOnlyMode) flash('只读模式下不能粘贴', true);
                else pasteFileClipboard(explorer.getAnchor() || selected[selected.length - 1]);
            }
        }
    } else if (keymap.is(kb, 'edit.gotoLine')) {
        if ((currentMode === 'code' || currentMode === 'text') && file && !isDialogOpen()) {
            e.preventDefault();
            e.stopPropagation();
            openGotoDialog();
        }
    } else if (keymap.is(kb, 'edit.format')) {
        e.preventDefault();
        e.stopPropagation();
        formatDocument();
    } else if (keymap.is(kb, 'file.newBrowserTab')) {
        // 新建浏览器标签页（与活动栏图标、文件菜单同一入口）
        e.preventDefault();
        e.stopPropagation();
        openBrowserTab('about:blank');
    } else if (keymap.is(kb, 'file.newMemo')) {
        // 快捷便签面板（与活动栏图标、文件菜单同一入口）
        e.preventDefault();
        e.stopPropagation();
        openMemoTab();
    } else if (keymap.is(kb, 'file.saveAs')) {
        e.preventDefault();
        e.stopPropagation();
        saveAs();
    } else if (keymap.is(kb, 'file.save')) {
        e.preventDefault();
        e.stopPropagation();
        save();
    } else if (keymap.is(kb, 'file.newWindow')) {
        e.preventDefault();
        e.stopPropagation();
        openNewWindow();
    } else if (keymap.is(kb, 'file.reopenTab')) {
        e.preventDefault();
        e.stopPropagation();
        reopenClosedTab();
    } else if (keymap.is(kb, 'view.jsonQuery')) {
        e.preventDefault();
        e.stopPropagation();
        openJsonQuery();
    } else if (keymap.is(kb, 'file.new')) {
        e.preventDefault();
        e.stopPropagation();
        newDocument();
    } else if (keymap.is(kb, 'file.closeTab')) {
        e.preventDefault();
        e.stopPropagation();
        if (file) requestCloseDoc(file);
    } else if (keymap.is(kb, 'file.settings')) {
        e.preventDefault();
        e.stopPropagation();
        openSettings('general');
    } else if (keymap.is(kb, 'edit.toggleBookmark')) {
        // F11：切换行书签（全屏不再绑定快捷键）
        e.preventDefault();
        e.stopPropagation();
        toggleBookmark();
    } else if (keymap.is(kb, 'view.closeDockPanel')) {
        // Shift+Esc（JetBrains 语义）：底部面板打开时收起，不论当前是终端 / 调试 / 运行 / Git 图谱。
        // 面板未打开或对话框打开时不拦截，交还默认处理。
        if (isDialogOpen() || !terminalUI.open) return;
        e.preventDefault();
        e.stopPropagation();
        // 终端独立窗口只有一个面板：收起等于一块空白无边框窗口，改为关窗
        // （走 Go 的 term-popout-closed 把会话交还主窗口，审查 P2-3）。
        if (window.__terminalWindowMode) {
            try { if (window.runtime && window.runtime.WindowClose) window.runtime.WindowClose(); } catch (e2) {}
            return;
        }
        toggleTerminalPanel(false);
    } else if (keymap.is(kb, 'view.terminal')) {
        e.preventDefault();
        e.stopPropagation();
        toggleDockView('terminal');
    } else if (keymap.is(kb, 'view.debug')) {
        // F12：底部面板切换到调试控制台（仅开发者模式）
        if (!developerMode) return;
        e.preventDefault();
        e.stopPropagation();
        toggleDockView('debug');
    } else if (keymap.is(kb, 'file.open')) {
        e.preventDefault();
        e.stopPropagation();
        openDialog();
    } else if (keymap.is(kb, 'edit.undo')) {
        if (isPlainTextUndoTarget()) return;
        if (handleExplorerUndoKey(e)) return;
        e.preventDefault();
        e.stopPropagation();
        doUndo();
    } else if (keymap.is(kb, 'edit.redo')) {
        if (isPlainTextUndoTarget()) return;
        if (handleExplorerUndoKey(e)) return;
        e.preventDefault();
        e.stopPropagation();
        doRedo();
    } else if (keymap.is(kb, 'edit.find')) {
        if (isDialogOpen()) return;
        const active = document.activeElement;
        const inFind = active === els.findInput;
        const inEditor = !!active && ((active.closest && active.closest('.ace_editor')) ||
            (active.matches && active.matches('textarea.jsoneditor-text')));
        if (!inFind && !inEditor && isTypingTarget()) return;
        e.preventDefault();
        e.stopPropagation();
        if (inFind) {
            els.findInput.select();
            return;
        }
        openFindBar();
    } else if (e.ctrlKey && (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd' ||
        e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract')) {
        const vplus = e.key === '+' || e.key === '=' || e.code === 'NumpadAdd';
        if (currentMode === 'image' && file && file.image) {
            e.preventDefault();
            e.stopPropagation();
            zoomImageBy(file, vplus ? -1 : 1);
            return;
        }
        if (currentMode === 'table' && file && file.format && file.format.table) {
            e.preventDefault();
            e.stopPropagation();
            zoomCsvTable(file, vplus ? -1 : 1);
            return;
        }
        if (currentMode === 'render' && file && isSvgDoc(file)) {
            e.preventDefault();
            e.stopPropagation();
            zoomSvgRenderBy(file, vplus ? -1 : 1);
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (!editor || currentMode !== 'tree' || !file || file.format.rawOnly) return;
        const plus = e.key === '+' || e.key === '=' || e.code === 'NumpadAdd';
        if (e.shiftKey) {
            if (plus) expandAllWithGuard(file);
            else editor.collapseAll();
        } else {
            toggleFocusedNode(plus ? 'expand' : 'collapse');
        }
    } else if (e.key === 'Escape') {
        // 全局弹层栈接管 Esc：一次只退栈顶层（core/overlay-stack.js）。查找条、AI 顶层
        // 弹窗、菜单条、状态栏浮层都已进栈，不再需要这里的手写优先级链。栈让路
        // （Shift+Esc 归 dock 关闭、data-esc-local 归元素语义）时也不能兜底，否则
        // 「Esc 只清搜索词」会连带关掉整个设置窗——只在栈真空时兜一次设置对话框族。
        if (overlayStack.dispatchEscape(e)) return;
        if (overlayStack.size() === 0) closeTopDialog();
    }
    // 插件命令快捷键：内置键位优先——走到这里说明没命中任何内置动作。
    // 对话框打开或正在输入框里打字时不触发，避免抢走正常输入。
    if (!isDialogOpen() && !isTypingTarget()) {
        const pluginEnv = pluginCommandEnv();
        const pluginCmd = matchCommandShortcut(getPluginCommands(), kb, pluginEnv);
        if (pluginCmd) {
            e.preventDefault();
            e.stopPropagation();
            pluginCmd.run(pluginEnv);
            return;
        }
    }
}, {capture: true});

// 全局搜索：双击 Shift 的第二次「抬起」在此结算。keydown 只登记，keyup 才触发，
// 以保证两次都是完整轻按、且中间没有被别的按键打断（防线见 core/shift-double-tap.js）。
window.addEventListener('keyup', (e) => {
    if (isGlobalSearchOpen()) return;
    const tapped = shiftDoubleTap.onKeyUp(e);
    if (!tapped || quickSwitch.open) return;
    // 双击 Shift 只在「当前风格把它列为全局搜索触发方式」时才生效
    // （VS Code 风格改用 Ctrl+P / Ctrl+Shift+F 组合键）。
    if (!keymap.hasSpecial('edit.globalSearch', DOUBLE_SHIFT)) return;
    e.preventDefault();
    openGlobalSearch();
}, {capture: true});

for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    window.addEventListener(type, (e) => {
        // dragover 高频：indexOf 避免 Array.from 每次分配临时数组
        if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf('Files') >= 0) {
            e.preventDefault();
        }
    }, true);
}

if (rt) {
    appEvents.onWindow('app-open-settings', (pane) => {
        openSettings(String(pane || 'models'));
    });
    appEvents.onWindow('open-targets', (targets) => openTargets(targets));
    // 系统通知被点击：Go 侧已把窗口拉回前台，这里按激活参数跳到对应 AI 会话
    appEvents.onWindow('ai-notify-activate', (payload) => handleNotifyActivation(payload));
    appEvents.onWorkspace('workspace-changed', () => workspaceFolder, (payload) => {
        if (explorer && typeof explorer.handleExternalChanges === 'function') explorer.handleExternalChanges(payload);
        handleExternalDocChanges(payload);
        // 快捷便签：其他窗口/外部改了 .cadt/memo/memo.json 时重读（面板开着才生效）
        if (memoWorkspaceEventHook) memoWorkspaceEventHook(payload);
        // 工作区破坏防护（ai-wipeguard.js）：watcher 是检测主信号——内核级，AI 工具 /
        // run_command 子进程 / 工具返回后存活的进程 / 用户的删除全部可见
        if (wipeguardCtrl) wipeguardCtrl.handleWorkspaceEvent(payload);
    });
    // 多实例资源目录监听（全局便签 / 当前 AI 会话）：只做重读，不做合并。
    appEvents.onApp('resource-changed', (payload) => {
        if (memoResourceEventHook) memoResourceEventHook(payload);
        if (aiPanel && typeof aiPanel.handleResourceChange === 'function') aiPanel.handleResourceChange(payload);
    });
    // 快捷便签定位点跳转：CLI --memo（已在运行时 secondInstance 转发到这里）
    appEvents.onWindow('app-open-memo', (locator) => {
        if (memoJumpHook) memoJumpHook(locator);
    });
    // P2 进程内复用：别的窗口把「打开这个工作区的会话」直接投给本窗口；
    // 处理完必须回执 reqId，投递方才好区分「已切过去」与「会话已删 → 退化开新窗口」。
    appEvents.onWindow('app-open-ai-session', (req) => {
        Promise.resolve(handleReuseSessionRequest(req))
            .then((status) => {
                if (req && req.reqId && backend.WindowReuseResult) {
                    Promise.resolve(backend.WindowReuseResult(req.reqId, status)).catch(() => {});
                }
            })
            .catch((e) => {
                console.error('app-open-ai-session: 切换会话失败', e);
                if (req && req.reqId && backend.WindowReuseResult) {
                    Promise.resolve(backend.WindowReuseResult(req.reqId, 'mismatch')).catch(() => {});
                }
            });
    });
    // 外部文件拖放：Go 侧把落点信息（data-file-drop-target / data-drop-dir）随事件带回
    //（window_factory.go + window_drop.go），这里统一按落点分流——
    // 编辑区打开文件 / 文件树复制进目录 / 数据库面板导入 / AI 面板附加，未标注区域无效果。
    const dropRouter = createFileDropRouter({
        get flash() { return flash; },
        get openPaths() { return openPaths; },
        get copyIntoDir() { return copyExternalIntoDir; },
        get workspaceFolder() { return workspaceFolder; },
        get dbDrop() { return (dbPaths) => (dbUi && typeof dbUi.handleDropPaths === 'function' ? dbUi.handleDropPaths(dbPaths) : Promise.resolve()); },
        get aiAttach() { return attachPathsToAI; },
    });
    // 兜底清理高亮：Wails runtime 的 dragleave 在「离开窗口」时故意不处理、也没有 dragend，
    // 拖出窗口/取消时 file-drop-target-active 会永久残留（遮罩一直挂着）。心跳 + 边界事件补一刀。
    installDropHighlightFallback(window, document);
    // 应用内拖拽（文件树行 → 编辑区 / AI 面板 / 数据库面板）：走与 OS 外部拖放相同的落点遮罩与路由。
    // 落点 route 直接喂给 dropRouter（它按 editor/files/db/ai 分派），复用同一套处理器。
    installInternalDrop(window, document, {
        onDrop: (paths, route) => {
            if (!route) return;
            dropRouter.handle({filenames: paths, target: route});
        },
    });
    appEvents.onWindow('app-file-drop', (data) => {
        // 真正的 drop 已到，遮罩该立即消失（不等兜底心跳），与路由并行清一次。
        const routerResult = dropRouter.handle(data);
        try {
            document.querySelectorAll('.file-drop-target-active').forEach((el) => el.classList.remove('file-drop-target-active'));
        } catch (e) {}
        return routerResult;
    });
    // 关窗/退出确认文案（Go 侧 beforeClose 与显式退出共用同一份理由）。
    // 来源分组：AI 回合 / 后台命令作业 / 终端；terms 只数 shell 里有活命令进程的终端。
    function closeReasonsText(r, actionWord) {
        const bgJobs = Number(r.bgJobs) || 0;
        const terms = Number(r.terms) || 0;
        const active = [];
        if (r.aiRunning) active.push('AI 会话正在进行中');
        if (bgJobs > 0) active.push(bgJobs + ' 个 AI 后台命令仍在运行');
        if (terms > 0) active.push(terms + ' 个终端正在执行任务');
        if (!active.length) return '';
        return (r.dirty ? '有未保存的修改，且 ' : '') + active.join('，') +
            '；' + actionWord + '将终止这些任务' + (r.dirty ? '并丢弃未保存的修改' : '') + '。';
    }

    appEvents.onWindow('confirm-close', (reasons) => {
        flushCsvCellEditor();
        // 快捷便签：挂着的防抖保存在弹确认框前先落盘（自动保存语义，之后无论选哪个退出按钮都不丢）
        if (memoFlushHook) memoFlushHook();
        const message = closeReasonsText(reasons || {}, '关闭');
        if (message) {
            openConfirmDialog(
                message,
                () => { if (backend.ForceClose) backend.ForceClose(); },
                '终止并关闭', '关闭', 'danger');
            return;
        }
        openConfirmDialog(undefined, undefined, undefined, undefined, 'danger');
    });
    // 显式退出（菜单/托盘）：Go 汇总全部窗口的风险后发来；确认后一次关闭所有窗口。
    appEvents.onWindow('app-quit-request', (reasons) => {
        flushCsvCellEditor();
        if (memoFlushHook) memoFlushHook();
        const message = closeReasonsText(reasons || {}, '退出');
        openConfirmDialog(
            message || '确定退出应用？',
            () => { if (backend.ForceQuitAll) backend.ForceQuitAll(); },
            '退出', '退出应用', 'danger');
    });
    // 外部优雅退出（--quit 经单实例转发，重建脚本在替换 exe 前调用）：每个窗口结算
    // 自己的 AI 回合（标中断、落盘、释放租约）后 ack；Go 收齐全部窗口 ack（或 6s
    // 超时）才 ForceQuitAll。onApp 而非 onWindow：广播不带 sender。
    appEvents.onApp('app-graceful-quit', async () => {
        flushCsvCellEditor();
        if (memoFlushHook) memoFlushHook();
        try {
            if (aiPanel && aiPanel.settleForShutdown) await aiPanel.settleForShutdown();
        } catch (e) {}
        if (backend.AppGracefulQuitAck) {
            try { backend.AppGracefulQuitAck(); } catch (e) {}
        }
    });
    // 全局热键 Ctrl+Alt+T：主窗口前置 + 打开终端面板（Go 侧发来）
    appEvents.onWindow('app-open-terminal', () => {
        try { toggleDockView('terminal'); } catch (e) {}
    });
    // AI 回合状态同步给后端（Go 侧 beforeClose 据此决定是否弹关窗确认）
    let aiRunningLast = false;
    setInterval(() => {
        try {
            const running = !!(aiPanel && aiPanel.hasActiveTurn && aiPanel.hasActiveTurn());
            if (running === aiRunningLast) return;
            aiRunningLast = running;
            if (backend.SetAIRunning) backend.SetAIRunning(running);
        } catch (e) {}
    }, 800);
    appEvents.onWindowOrBroadcast('browser-nav', (data) => {
        const doc = docs.find((d) => d.id === (data && data.id));
        if (!doc) return;
        if (data.loading !== undefined) doc.loading = !!data.loading;
        if (doc.browserEmpty) {
            doc.browserEmpty.remove();
            doc.browserEmpty = null;
        }
        if (data.url) doc.browserUrl = data.url;
        // 个人浏览器地址变化：通知恢复模块防抖落盘（cadt.browser-tabs.v1）。事件先按
        // doc 归属过滤过（本窗口没有这个 doc 时上面已 return），不会收到别的窗口的导航。
        if (doc.browserPersist && browserTabRestore) browserTabRestore.notePersonalNav(data.url);
        if (doc.browserAddr && document.activeElement !== doc.browserAddr) {
            doc.browserAddr.value = data.url && data.url !== 'about:blank' ? data.url : '';
        }
        if (doc.browserBackBtn && data.canGoBack !== undefined) doc.browserBackBtn.disabled = !data.canGoBack;
        if (doc.browserFwdBtn && data.canGoForward !== undefined) doc.browserFwdBtn.disabled = !data.canGoForward;
        if (data.title) updateBrowserTitle(doc, data.title);
    });
    appEvents.onWindowOrBroadcast('browser-title', (data) => {
        const doc = docs.find((d) => d.id === (data && data.id));
        if (doc && data && data.title) updateBrowserTitle(doc, data.title);
    });
    appEvents.onWindowOrBroadcast('browser-error', (data) => {
        const doc = docs.find((d) => d.id === (data && data.id));
        if (doc) flash('浏览器进程异常，标签页可能需要重新打开', true);
    });
    window.addEventListener('resize', syncAllBrowserTabs);
    // 菜单/命令面板/AI 面板全屏等浮层没有统一的开关事件：定时兜底同步内嵌浏览器的显隐。
    // 必须同步「所有」浏览器标签而非仅当前 file：切走后非活动浏览器标签靠 browserVisibleFor
    // 的 doc !== deps.file 判定隐藏，若轮询只盯着 file，那次隐藏一旦被全局锁吞掉就再无重试
    // 路径，原生 WebView2 HWND 会永久盖在其他视图上（只有关标签才消失）。
    setInterval(() => {
        syncAllBrowserTabs();
    }, 250);
    appEvents.onWindowOrBroadcast('term-out', (data) => {
        // 走 terminal 域的统一入口：session 未注册时先缓冲（Go 在 TermCreate 返回前就开始推输出），
        // attachTermSession 注册后按序回放，首屏 banner 不再被丢
        terminalMod.writeTermOut(data);
    });
    appEvents.onWindowOrBroadcast('term-exit', (data) => {
        const s = terminalUI.sessions.get(data.id);
        if (s) s.term.write('\r\n\x1b[90m[进程已退出，代码 ' + data.code + ']\x1b[0m');
        // AI 创建的终端 shell 退出：经会话信箱唤醒发起会话（用户自己开的终端不投递）。
        // aiPanel 在此处闭包里尚未赋值也没关系——事件只会触发在应用起来之后。
        if (s && s.aiSessionId && aiPanel && typeof aiPanel.notifyAITerminalExit === 'function') {
            try { aiPanel.notifyAITerminalExit(s.aiSessionId, data.id, Number(data.code)); }
            catch (e) {} // 尽力而为路径：唤醒失败不影响终端 UI 的退出标记
        }
    });
    // 终端独立窗口关闭：Go 指定了交还目标窗口，只有目标窗口接（避免多个主窗口抢）。
    // 会话已退出/已关闭时 Go 不发这个事件。
    appEvents.onApp('term-popout-closed', async (data) => {
        const d = data || {};
        logFrontend('info', '[term-popout] 收到交还事件 id=' + (d.id || '') + ' target=' + (d.target || '') + ' self=' + wailsWindowName);
        if (!d.id || d.target !== wailsWindowName) return;
        if (terminalUI.sessions.has(d.id)) return;
        try {
            await terminalMod.attachResumedTermSession(d.id, d.shell || '');
            toggleTerminalPanel(true);
            logFrontend('info', '[term-popout] 会话已接回：' + d.id);
        } catch (e) {
            logFrontend('error', '[term-popout] 接回失败：' + ((e && (e.stack || e.message)) || e));
        }
    });
    appEvents.onWindowOrBroadcast('cmd-out', (payload) => {
        const h = cmdOutHandlers.get(payload.id);
        if (h) h(payload.stream, payload.data);
    });
    appEvents.onWindowOrBroadcast('cmd-exit', (payload) => {
        const h = cmdExitHandlers.get(payload.id);
        if (h) {
            cmdExitHandlers.delete(payload.id);
            h(Number(payload.code));
        }
    });
}

document.querySelectorAll('.about-link').forEach((a) => {
    a.addEventListener('click', (e) => {
        e.preventDefault();
        const url = a.dataset.url;
        if (!url) return;
        if (rt && rt.BrowserOpenURL) rt.BrowserOpenURL(url);
        else window.open(url, '_blank', 'noopener');
    });
});

els.editor.addEventListener('wheel', (e) => {
    const strip = e.target && e.target.closest ? e.target.closest('.etabs') : null;
    if (!strip || strip.scrollWidth <= strip.clientWidth) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!delta) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? strip.clientWidth : 1;
    e.preventDefault();
    strip.scrollLeft += delta * unit;
}, {passive: false});

// Ctrl+Z 捕获拦截：代码模式下 ace 聚焦时会吞掉 Ctrl+Z（空栈静默），这里在捕获阶段先判空栈+脏 → 直接回退已保存状态
window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.shiftKey || e.altKey) return;
    if ((e.key || '').toLowerCase() !== 'z') return;
    if (isPlainTextUndoTarget()) return;
    if (handleExplorerUndoKey(e)) return;
    if (currentMode !== 'code' || !editor || !editor.aceEditor || isDocReadOnly(file, settings)) return;
    let um = null;
    try { um = editor.aceEditor.session.getUndoManager(); } catch (err) { return; }
    if (um && um.hasUndo()) return;
    e.preventDefault();
    e.stopPropagation();
    if (file && file.dirty) revertDocToSaved(file);
}, true);

els.wsProject.addEventListener('click', (e) => {
    e.stopPropagation();
    showProjectMenu(els.wsProject);
});
els.wsBranch.addEventListener('click', (e) => {
    e.stopPropagation();
    showBranchMenu(els.wsBranch);
});

const cursorThemes = createCursorThemes({
    get backend() { return backend; },
});
const {setDragCursor} = cursorThemes;


const terminalMod = createTerminalUI({
    get renderAppPagesNav() { return renderAppPagesNav; },
    get renderDatabaseNav() { return dbUi.renderSidebar; },
    get renderMavenTree() { return mavenUi ? mavenUi.renderTree : null; },
    get showGitFileHistory() { return showGitFileHistory; },
    get touchRunProfileRecency() { return touchRunProfileRecency; },
    get openDocDirtyByPath() { return openDocDirtyByPath; },
    get samePathValue() { return samePathValue; },
    get gitRollbackPaths() { return gitRollbackPaths; },
    get gitGroupCollapsed() { return gitGroupCollapsed; },
    get gitUncheckedFiles() { return gitUncheckedFiles; },
    get showGitRecentLog() { return showGitRecentLog; },
    get nextCmdSeq() { return nextCmdSeq; },
    get activityLog() { return activityLog; },
    get applySettings() { return applySettings; },
    get backend() { return backend; },
    get closeTopDialog() { return closeTopDialog; },
    get copyText() { return copyText; },
    get ctxMenu() { return ctxMenu; },
    get currentMode() { return currentMode; },
    get dirty() { return dirty; },
    get editor() { return editor; },
    get effectiveToolEnv() { return effectiveToolEnv; },
    get els() { return els; },
    get elsDialogs() { return elsDialogs; },
    get file() { return file; },
    get findDocByPath() { return findDocByPath; },
    get flash() { return flash; },
    get gitStateCache() { return gitStateCache; },
    get initAIPanel() { return initAIPanel; },
    get openAIPanelWithDraft() { return openAIPanelWithDraft; },
    get openBrowserTab() { return openBrowserTab; },
    get openConfirmDialog() { return openConfirmDialog; },
    get openDialogEl() { return openDialogEl; },
    get openNameDialog() { return openNameDialog; },
    get openPathsHere() { return openPathsHere; },
    get openVirtualDoc() { return openVirtualDoc; },
    get refreshGitStatus() { return refreshGitStatus; },
    get rt() { return rt; },
    get saveDoc() { return saveDoc; },
    get selectLineInDoc() { return selectLineInDoc; },
    get setDragCursor() { return setDragCursor; },
    get settings() { return settings; },
    get showGitDiff() { return showGitDiff; },
    get structurePanel() { return structurePanel; },
    get textArea() { return textArea; },
    get toolEnvFor() { return toolEnvFor; },
    get workspaceFolder() { return workspaceFolder; },
});
const {applyDockView, renderGitPanel, cmdExitHandlers, cmdOutHandlers, currentSidebarView, fitActiveTerm, runArgsText, runController, switchSidebarView, syncTerminalTheme, termCwd, terminalHostApi, terminalUI, toggleDockView, toggleSidebarView, toggleTerminalPanel, getDockView, setDockView, nextCmdSeq, nextMockBgSeq, nextMockSchedSeq, startRunProject} = terminalMod;
// —— 启动初始化：必须在 terminalMod 解构之后（applySettings 经 deps 触达
//    terminal-ui 导出），也必须在 bridgeUI 工厂之前（保持原始执行顺序）——
applySettings();
installTooltip();
// 气泡动作链接分发（data-tip-actions，见 core/tooltip.js）：未知动作忽略。
// ai:context-slim → 设置 → AI 助手，定位「上下文实时瘦身」开关
setTooltipActionHandler((action) => {
    if (action === 'ai:context-slim') openSettingsAtRow('ai', document.getElementById('ai-opt-context-slim'));
});
initContextMenus();
initExplorer();
initStructurePanel();
initActivityBar();

const bridgeUI = createBridgeUI({
    // 应用页面标签页：pageId → mount(root)，各页内容渲染仍归原域
    get appPageMounters() { return appPageMounters; },
    // 数据库虚拟标签页（数据表 / 查询控制台 / Redis 键查看器）：doc → db 域视图根元素（bridge 挂载 pane 与卸载契约）
    get dbTabMounter() {
        return (doc) => {
            const depsObj = {
                get backend() { return backend; },
                get flash() { return flash; },
                get settings() { return settings; },
                get logActivity() { return activityLog.log; },
                get enhanceSelect() { return settingsUI.enhanceSelect; },
                get ctxMenu() { return ctxMenu; },
                get copyText() { return copyText; },
                get openConfirmDialog() { return openConfirmDialog; },
                get overlayStack() { return overlayStack; },
                get onRedisKeyDeleted() { return () => { if (dbSidebarRenderHook) dbSidebarRenderHook(); }; },
            };
            if (doc.dbRedisKeySpec) return createDbRedisKeyTabView(depsObj, doc);
            return doc.dbTableSpec ? createDbTableTabView(depsObj, doc) : createDbConsoleTabView(depsObj, doc);
        };
    },
    // 应用页面标签页里的原生 select 用设置页同款浮层增强，去掉浏览器原生外观
    get enhanceSetSelects() { return settingsUI.enhanceSetSelects; },
    // 便签终端条目：run 事件订阅（mock/winctl 场景也走这里）与输出清洗（ai 域纯函数经组合根注入）
    get rt() { return rt; },
    get normalizeTermText() { return normalizeTermText; },
    setSyncedOpenMode,
    get activateDoc() { return activateDoc; },
    get activityLog() { return activityLog; },
    get addDocToFocusedGroup() { return addDocToFocusedGroup; },
    get aiPanel() { return aiPanel; },
    // 群聊域惰性引用：运行时 / 面板群聊视图 / 成员详情视图（创建期 TDZ 规避）
    get aiGroupRuntime() { return () => aiGroupRuntime; },
    get aiGroupView() { return () => aiGroupView; },
    // 成员详情视图（bridge-group-member-view）：同款惰性 getter
    get aiGroupMemberView() { return () => aiGroupMemberView; },
    get getAIConfig() { return () => (aiPanel && aiPanel.aiGroupApi ? aiPanel.aiGroupApi.getConfig() : null); },
    get applySettings() { return applySettings; },
    get autoCheckUpdateOnStart() { return autoCheckUpdateOnStart; },
    // 个人浏览器标签保存与启动恢复（shell/browser-tab-restore.js）：openBrowserTab 建个人标签
    // 时通知、启动编排末尾调 restoreOnStartup
    get browserTabRestore() { return browserTabRestore; },
    get backend() { return backend; },
    get closeDocNow() { return closeDocNow; },
    // 快捷便签面板（bridge-memo-view）需要的跨界依赖：右键菜单、贴图压缩、md 渲染、pending 翻转刷关窗脏标记
    get ctxMenu() { return ctxMenu; },
    get prepareImagePayload() { return prepareImagePayload; },
    get renderMarkdownHtml() { return renderMarkdownHtml; },
    get openConfirmDialog() { return openConfirmDialog; },
    get onPendingChange() { return memoPendingChanged; },
    get consoleWindowMode() { return consoleWindowMode; },
    get terminalWindowMode() { return terminalWindowMode; },
    get aiFloatWindowMode() { return aiFloatWindowMode; },
    get auxWindowKind() { return auxWindowKind; },
    get startMemoWindowMode() { return auxWindowModes.startMemoWindowMode; },
    get startMonitorWindowMode() { return auxWindowModes.startMonitorWindowMode; },
    get startDiffWindowMode() { return auxWindowModes.startDiffWindowMode; },
    get startLightWindowMode() { return auxWindowModes.startLightWindowMode; },
    get startPreviewWindowMode() { return auxWindowModes.startPreviewWindowMode; },
    // 便签面板顶栏「弹出」：把当前作用域弹成置顶便签窗（便签窗自身不传这个键，不显示按钮）
    get popOutMemo() {
        return (scope, workspace) => {
            backend.PopOutMemo(scope, workspace).catch((e) => flash('弹出便签窗失败：' + ((e && e.message) || e), true));
        };
    },
    get notifyFailure() { return (...args) => failureNotifier.notifyFailure(...args); },
    get copyText() { return copyText; },
    get createDoc() { return createDoc; },
    get currentSidebarView() { return currentSidebarView; },
    get dirty() { return dirty; },
    get docs() { return docs; },
    get editor() { return editor; },
    get els() { return els; },
    get file() { return file; },
    get flash() { return flash; },
    get hasWails() { return hasWails; },
    get initAIPanel() { return initAIPanel; },
    get initCodeFoldHover() { return initCodeFoldHover; },
    get logFrontend() { return logFrontend; },
    get mockScenario() { return mockScenario; },
    get openPaths() { return openPaths; },
    get openSettings() { return openSettings; },
    get openTargets() { return openTargets; },
    get readSession() { return readSession; },
    get readWorkspaceSession() { return readWorkspaceSession; },
    get refreshDeveloperMode() { return refreshDeveloperMode; },
    get refreshLogPath() { return refreshLogPath; },
    get renderGitPanel() { return renderGitPanel; },
    get renderTabs() { return renderTabs; },
    get renderWorkspaceCrumbs() { return renderWorkspaceCrumbs; },
    get restoreSession() { return restoreSession; },
    get scheduleGitGutter() { return scheduleGitGutter; },
    get sessionPathKey() { return sessionPathKey; },
    get settings() { return settings; },
    get startConsoleWindowMode() { return startConsoleWindowMode; },
    get startTerminalWindowMode() { return startTerminalWindowMode; },
    get switchSidebarView() { return switchSidebarView; },
    get syncBrowserTab() { return syncBrowserTab; },
    get updateBrowserTitle() { return updateBrowserTitle; },
    get workspaceFolder() { return workspaceFolder; },
});
const {createAgentView, createAgentTeamView, createSideChatView, createGroupMemberView, openGroupMemberTab, createBgTermView, createAppPageView, openAppPageTab, gitGroupCollapsed, gitRootDir, gitStateCache, gitUncheckedFiles, notifyAIGitEntry, openAgentTab, openAgentTeamTab, openSideChatTab, openBgTermTab, openBrowserTab, openVirtualDoc, refreshGitStatus, showGitDiff, showGitFileHistory, showGitRecentLog, gitRollbackPaths,
    openMemoTab, createMemoView, memoApi, memoHasPending, memoOnWorkspaceEvent, memoOnWindowFocus, memoOnResourceEvent, memoWorkspaceChanged,
    createDatabaseTabView, openDbTableTab, openDbConsoleTab, openDbRedisKeyTab} = bridgeUI;
// 成员详情标签页出口回填（aiGroupView 的 openMemberTab 闭包在创建期引用本 hook，避免 TDZ）
openGroupMemberTabHook = openGroupMemberTab;

// 数据库虚拟标签页入口（editor-groups 的 deps getter 指到 bridge 的挂载函数；
// db 域工厂的分派在 bridgeUI 的 dbTabMounter 内）
configureDbSessions({
    get backend() { return backend; },
});

// 数据库（侧栏「数据库」面板 = 会话树 + 内容区表/控制台标签页）：internal/dbclient 引擎
// （SQLite / MySQL / 受控写入），方案 docs/unfinished-plans/db-connection-tools.md；
// 工作区清单存 settings.dbWorkspaceDatabases，总开关 settings.dbToolsEnabled 默认关。
const dbUi = createDbUi({
    get backend() { return backend; },
    get flash() { return flash; },
    get settings() { return settings; },
    get persistSettingsLight() { return persistSettingsLight; },
    get logActivity() { return activityLog.log; },
    get workspaceFolder() { return workspaceFolder; },
    get ctxMenu() { return ctxMenu; },
    get openConfirmDialog() { return openConfirmDialog; },
    get enhanceSelect() { return settingsUI.enhanceSelect; },
    get openDbTableTab() { return openDbTableTab; },
    get openDbConsoleTab() { return openDbConsoleTab; },
    get openDbRedisKeyTab() { return openDbRedisKeyTab; },
    get copyText() { return copyText; },
    get openSettings() { return openSettings; },
});
dbSidebarRenderHook = () => dbUi.renderSidebar();

// Maven 工具窗口（maven-panel.js）：触发判定（工作区 pom + 本机 mvn 惰性扫描）→ ab-maven 显隐；
// 树渲染 / goal 弹窗 / 执行开关都在面板内，执行走运行通道 runCommand（有完整门禁）。
mavenSidebarRenderHook = () => { if (mavenUi) mavenUi.renderTree(); };
mavenUi = createMavenPanel({
    get backend() { return backend; },
    get settings() { return settings; },
    get persistSettingsLight() { return persistSettingsLight; },
    get ensureToolchainForRun() { return terminalMod.ensureToolchainForRun; },
    get runCommand() { return terminalMod.runController.runCommand; },
    get flash() { return flash; },
    get workspaceFolder() { return workspaceFolder; },
    get currentSidebarView() { return terminalMod.currentSidebarView; },
    get exitMavenView() { return () => { if (terminalMod.currentSidebarView() === 'maven') terminalMod.switchSidebarView('files'); }; },
    get openPath() { return openPath; },
    get copyText() { return copyText; },
    get abButton() { return els.abMaven; },
    get treeEl() { return els.mavenTree; },
    get flagsEl() { return els.mavenFlags; },
    get refreshBtn() { return els.mavenRefresh; },
    get goalBtn() { return els.mavenGoal; },
});
mavenUi.mount();

// app_control 数据库动作（db_list/save/delete/test_connection）：AI 代配数据库连接，
// 审批卡与工作区清单语义见 db-app-actions.js（密码 DPAPI 落库后不回传对话）
const dbAppActions = createDbAppActions({
    get backend() { return backend; },
    get settings() { return settings; },
    get persistSettingsLight() { return persistSettingsLight; },
    get workspaceFolder() { return workspaceFolder; },
});

// 绑定便签真钩子（顶部早期 let 间接层的落点）：启动期事件先到也只摸到 null，不摸未初始化的 const
memoFocusHook = () => { if (memoOnWindowFocus) memoOnWindowFocus(); };
memoJumpHook = (locator) => { if (memoApi && memoApi.jumpToLocator) memoApi.jumpToLocator(locator); };
memoWorkspaceEventHook = (payload) => { if (memoOnWorkspaceEvent) memoOnWorkspaceEvent(payload); };
memoResourceEventHook = (payload) => { if (memoOnResourceEvent) memoOnResourceEvent(payload); };
memoResourceEventHook = (payload) => { if (memoOnResourceEvent) memoOnResourceEvent(payload); };
memoFlushHook = () => { if (memoApi && memoApi.flushAll) memoApi.flushAll().catch(() => {}); };

// 便签 pending 翻转回调（bridge-memo-view 经 deps 注入取用）：记下标志位并刷新应用关窗脏标记，
// 让 Go 侧 beforeClose 在防抖窗口内也走 confirm-close 流程而不是静默关窗。
function memoPendingChanged() {
    memoPendingFlag = !!memoApi.hasPending();
    updateBackendDirty();
}

