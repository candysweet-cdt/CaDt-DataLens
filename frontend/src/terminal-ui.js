// terminal-ui.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// 内置终端
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {iconSvg} from './icons.js';
import {createRunController, splitRunArgs} from './run.js';

export function createTerminalUI(deps) {

const terminalUI = {open: false, sessions: new Map(), order: [], activeId: null};
const TERM_SHELL_LABELS = {pwsh: 'PowerShell 7', powershell: 'Windows PowerShell', cmd: 'Command Prompt', gitbash: 'Git Bash'};
const cmdOutHandlers = new Map();
const cmdExitHandlers = new Map();
let cmdSeq = 0;
// AI 面板初始化必须在 terminalUI 等模块级声明之后：面板若按上次状态自动打开，
// open() → onLayout 会同步引用这些声明，放在前面会触发 TDZ 中断整个模块求值。
deps.initAIPanel();
let mockBgSeq = 0; // mock 后台作业编号
let mockSchedSeq = 0; // mock 定时任务编号



// gitRelParentDir 返回 path 相对仓库根的父目录（JetBrains 式灰字，Windows 反斜杠显示）。
function gitRelParentDir(path) {
    const root = (deps.gitStateCache.dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const p = String(path || '').replace(/\\/g, '/');
    if (!root || !p.toLowerCase().startsWith(root.toLowerCase() + '/')) return '';
    const rel = p.slice(root.length + 1);
    const idx = rel.lastIndexOf('/');
    if (idx <= 0) return '';
    return rel.slice(0, idx).replace(/\//g, '\\');
}

function renderGitPanel() {
    if (!deps.els.gitChanges) return;
    const available = deps.gitStateCache.available && deps.gitStateCache.dir;
    deps.els.gitBranch.textContent = deps.gitStateCache.branch ? '分支：' + deps.gitStateCache.branch : '';
    if (!available) {
        deps.els.gitHint.textContent = deps.gitStateCache.reason || '当前目录不在 git 仓库内';
        deps.els.gitChanges.innerHTML = '';
        deps.els.gitCommitBtn.disabled = true;
        deps.els.gitCommitPushBtn.disabled = true;
        return;
    }
    deps.els.gitHint.textContent = '';
    deps.els.gitCommitBtn.disabled = false;
    deps.els.gitCommitPushBtn.disabled = false;
    const changes = [];
    const untracked = [];
    for (const [path, state] of deps.gitStateCache.map) {
        if (state === 'untracked') untracked.push(path);
        else changes.push({path, state});
    }
    deps.els.gitChanges.textContent = '';
    if (!changes.length && !untracked.length) {
        const empty = document.createElement('div');
        empty.className = 'git-empty';
        empty.textContent = '（工作区干净，没有变更）';
        deps.els.gitChanges.appendChild(empty);
        return;
    }
    const makeRow = (path, checked, state) => {
        const row = document.createElement('label');
        row.className = 'git-file-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = checked;
        cb.dataset.path = path;
        const name = document.createElement('span');
        name.className = 'git-fname git-st-' + (state || 'modified');
        name.textContent = path.replace(/^.*[\\/]/, '');
        row.append(cb, name);
        // JetBrains 式：文件名后跟一行淡灰小字 = 相对仓库根的父目录
        const relParent = gitRelParentDir(path);
        if (relParent) {
            const dirSpan = document.createElement('span');
            dirSpan.className = 'git-fpath';
            dirSpan.textContent = relParent;
            row.append(dirSpan);
        }
        row.title = path;
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!deps.ctxMenu) return;
            const isUntracked = deps.gitStateCache.untrackedSet.has(path);
            deps.ctxMenu.open([
                {label: '查看差异', icon: 'E8D3', action: () => deps.showGitDiff(path)},
                {label: '文件历史', icon: 'E81C', action: () => deps.showGitFileHistory(path)},
                {sep: true},
                {label: '回滚更改', icon: 'E7A7', danger: true, action: () => {
                    const what = isUntracked ? '该文件未被版本管理，回滚将删除文件：' : '将丢弃该文件的全部未提交修改：';
                    deps.openCloseConfirm(what + '\n' + path, () => deps.gitRollbackPaths([path], isUntracked ? [path] : []), '回滚');
                }},
            ], e.clientX, e.clientY);
        });
        return row;
    };
    // 分组块：组头勾选框 = 全选/全不选该组文件（JetBrains 式，支持半选态）；组头箭头 = 展开/收起（跨轮询重渲染保留）
    const makeGroupBlock = (title, rows, key) => {
        const block = document.createElement('div');
        block.className = 'git-group-block';
        const head = document.createElement('div');
        head.className = 'git-group';
        const chev = document.createElement('button');
        chev.type = 'button';
        chev.className = 'git-chev';
        chev.title = '展开/收起';
        chev.innerHTML = iconSvg(deps.gitGroupCollapsed[key] ? 'chevron-right' : 'chevron-down', 10);
        const gcb = document.createElement('input');
        gcb.type = 'checkbox';
        gcb.className = 'git-group-cb';
        const label = document.createElement('span');
        label.textContent = title;
        head.append(chev, gcb, label);
        const rowsWrap = document.createElement('div');
        rowsWrap.className = 'git-group-rows' + (deps.gitGroupCollapsed[key] ? ' collapsed' : '');
        const rowCbs = () => [...rowsWrap.querySelectorAll('.git-file-row input[type="checkbox"]')];
        const updateGroupState = () => {
            const cbs = rowCbs();
            const checkedCount = cbs.filter((c) => c.checked).length;
            gcb.checked = cbs.length > 0 && checkedCount === cbs.length;
            gcb.indeterminate = checkedCount > 0 && checkedCount < cbs.length;
        };
        gcb.addEventListener('change', () => {
            for (const c of rowCbs()) c.checked = gcb.checked;
            updateGroupState();
        });
        chev.addEventListener('click', () => {
            deps.gitGroupCollapsed[key] = !deps.gitGroupCollapsed[key];
            rowsWrap.classList.toggle('collapsed', deps.gitGroupCollapsed[key]);
            chev.innerHTML = iconSvg(deps.gitGroupCollapsed[key] ? 'chevron-right' : 'chevron-down', 10);
        });
        block.append(head, rowsWrap);
        for (const row of rows) {
            rowsWrap.append(row);
            row.querySelector('input[type="checkbox"]').addEventListener('change', updateGroupState);
        }
        updateGroupState();
        return block;
    };
    if (changes.length) {
        const rows = changes.map((item) => {
            const row = makeRow(item.path, true, item.state);
            row.querySelector('input').dataset.path = item.path;
            row.addEventListener('dblclick', () => deps.showGitDiff(item.path));
            return row;
        });
        deps.els.gitChanges.appendChild(makeGroupBlock('更改（' + changes.length + ' 个文件）', rows, 'changes'));
    }
    if (untracked.length) {
        const rows = untracked.map((path) => {
            const row = makeRow(path, true, 'untracked');
            row.addEventListener('dblclick', () => deps.showGitDiff(path));
            return row;
        });
        deps.els.gitChanges.appendChild(makeGroupBlock('未进行版本管理的文件（' + untracked.length + ' 个文件）', rows, 'untracked'));
    }
}

function currentSidebarView() {
    if (deps.settings.sidebarView === 'git' || deps.settings.sidebarView === 'structure' || deps.settings.sidebarView === 'chats') return deps.settings.sidebarView;
    return 'files';
}

function switchSidebarView(view) {
    if (!['files', 'git', 'structure', 'chats'].includes(view)) view = 'files';
    deps.settings.sidebarView = view;
    if (deps.structurePanel && view === 'structure') deps.structurePanel.setDoc(deps.file);
    deps.applySettings();
    if (view === 'git') {
        deps.refreshGitStatus().then(() => renderGitPanel()).catch(() => renderGitPanel());
    }
}

function toggleSidebarView(view) {
    if (deps.settings.showSidebar && currentSidebarView() === view) {
        deps.settings.showSidebar = false;
    } else {
        deps.settings.showSidebar = true;
        switchSidebarView(view);
    }
    deps.applySettings();
}

function termCwd() {
    return deps.workspaceFolder || (deps.file && deps.file.path ? deps.file.path.replace(/[\\/][^\\/]*$/, '') : '') || '';
}

function termTheme() {
    const cs = getComputedStyle(document.documentElement);
    return {
        background: cs.getPropertyValue('--bg').trim() || '#1e1f24',
        foreground: cs.getPropertyValue('--text').trim() || '#e0e0e0',
        cursor: cs.getPropertyValue('--accent').trim() || '#4f8cff',
        cursorAccent: cs.getPropertyValue('--bg').trim() || '#1e1f24',
        selectionBackground: '#88888855',
    };
}

function toggleTerminalPanel(force) {
    const panel = document.getElementById('terminal-panel');
    if (!panel) return;
    const show = force === undefined ? !terminalUI.open : force;
    if (show) {
        panel.classList.remove('hidden');
        terminalUI.open = true;
        if (dockView === 'terminal' && !terminalUI.sessions.size) createTermSession();
        applyDockView();
    } else {
        panel.classList.add('hidden');
        terminalUI.open = false;
        applyDockView();
    }
}

let dockView = 'terminal'; // 底部面板当前内容：'terminal' | 'debug'

// 应用底部面板视图：终端、调试控制台与运行面板共用同一个容器
function applyDockView() {
    const panel = document.getElementById('terminal-panel');
    if (!panel) return;
    const termOpen = terminalUI.open && dockView === 'terminal';
    const debugOpen = terminalUI.open && dockView === 'debug';
    const runOpen = terminalUI.open && dockView === 'run';
    const head = panel.querySelector('.term-head');
    if (head) head.classList.toggle('hidden', terminalUI.open && dockView !== 'terminal');
    const termBody = document.getElementById('term-body');
    if (termBody) termBody.classList.toggle('hidden', terminalUI.open && dockView !== 'terminal');
    const debugView = document.getElementById('debug-view');
    if (debugView) debugView.classList.toggle('hidden', !debugOpen);
    const runView = document.getElementById('run-view');
    if (runView) runView.classList.toggle('hidden', !runOpen);
    if (deps.els.abTerminal) {
        deps.els.abTerminal.classList.toggle('active', termOpen);
        deps.els.abTerminal.setAttribute('aria-pressed', String(termOpen));
    }
    if (deps.els.abDebug) {
        deps.els.abDebug.classList.toggle('active', debugOpen);
        deps.els.abDebug.setAttribute('aria-pressed', String(debugOpen));
    }
    if (deps.els.abRun) {
        deps.els.abRun.classList.toggle('active', runOpen);
        deps.els.abRun.setAttribute('aria-pressed', String(runOpen));
    }
    if (termOpen) fitActiveTerm();
}

// 左下活动栏 / 菜单 / F12 的统一入口：同一视图再点一次收起，不同视图则切换
function toggleDockView(view) {
    const target = view === 'debug' ? 'debug' : (view === 'run' ? 'run' : 'terminal');
    const panel = document.getElementById('terminal-panel');
    if (!panel) return;
    if (!terminalUI.open) {
        dockView = target;
        toggleTerminalPanel(true);
        return;
    }
    if (dockView !== target) {
        dockView = target;
        if (target === 'terminal' && !terminalUI.sessions.size) createTermSession();
        applyDockView();
        return;
    }
    if (target === 'run') {
        // 运行面板再次点击不收起：它承载的是运行结果，收起会让人以为结果丢了
        applyDockView();
        return;
    }
    toggleTerminalPanel(false);
}

// ---- 运行代码（F5）----
// 语言配方与输出渲染在 src/run.js；这里只提供「编辑器 / 设置 / 对话框」这些宿主能力。

let runDirtyResolve = null;
let runConfirmResolve = null;

// 当前文档的文本（与插件 runtime 的 getActiveText 同源，按视图取正确的那份）
function activeDocText() {
    if (!deps.file) return '';
    if (deps.currentMode === 'code' && deps.editor && deps.editor.aceEditor) return deps.editor.aceEditor.getValue();
    if (deps.currentMode === 'tree' && deps.editor && deps.file.format && typeof deps.file.format.stringify === 'function') {
        try {
            return deps.file.format.stringify(deps.editor.get());
        } catch (e) {
            return '';
        }
    }
    const ta = deps.textArea();
    if (ta) return ta.value;
    return deps.file.binary ? '' : (deps.file.content || '');
}

function finishRunDirty(choice) {
    const resolve = runDirtyResolve;
    runDirtyResolve = null;
    const remember = !!(deps.elsDialogs.runDirtyRemember && deps.elsDialogs.runDirtyRemember.checked);
    if (remember && (choice === 'save' || choice === 'temp')) {
        deps.settings.runDirtyMode = choice;
        deps.applySettings();
    }
    if (deps.elsDialogs.runDirtyRemember) deps.elsDialogs.runDirtyRemember.checked = false;
    deps.closeTopDialog();
    if (resolve) resolve(choice);
}

function finishRunConfirm(ok) {
    const resolve = runConfirmResolve;
    runConfirmResolve = null;
    deps.closeTopDialog();
    if (resolve) resolve(!!ok);
}

// 未保存修改的处理：设置里固定的模式直接返回，否则弹三选一
function askRunDirty(info) {
    return new Promise((resolve) => {
        if (deps.settings.runDirtyMode === 'temp') {
            resolve('temp');
            return;
        }
        if (deps.settings.runDirtyMode === 'save') {
            resolve(info.canSave ? 'save' : 'temp');
            return;
        }
        deps.elsDialogs.runDirtyText.textContent = info.canSave
            ? ('「' + (info.name || '当前文件') + '」有未保存的修改，运行前怎么处理？')
            : ('「' + (info.name || '当前文件') + '」还没有保存到磁盘，只能用临时副本运行。');
        deps.elsDialogs.runDirtySave.disabled = !info.canSave;
        runDirtyResolve = resolve;
        deps.openDialogEl(deps.elsDialogs.runDirty, {keepSettings: true});
    });
}

// 首次运行某种语言：明示风险，确认后记住
function confirmRunOnce(label) {
    return new Promise((resolve) => {
        deps.elsDialogs.runConfirmText.textContent =
            '将以你的 Windows 账户权限在本机执行 ' + label + ' 代码。只运行你自己写的或可信的文件。';
        runConfirmResolve = resolve;
        deps.openDialogEl(deps.elsDialogs.runConfirm, {keepSettings: true});
    });
}

if (deps.elsDialogs.runDirtySave) {
    deps.elsDialogs.runDirtySave.addEventListener('click', () => finishRunDirty('save'));
    deps.elsDialogs.runDirtyTemp.addEventListener('click', () => finishRunDirty('temp'));
    deps.elsDialogs.runDirtyCancel.addEventListener('click', () => finishRunDirty('cancel'));
    const closeBtn = deps.elsDialogs.runDirty.querySelector('.dialog-close');
    if (closeBtn) closeBtn.addEventListener('click', () => finishRunDirty('cancel'));
}
if (deps.elsDialogs.runConfirmOk) {
    deps.elsDialogs.runConfirmOk.addEventListener('click', () => finishRunConfirm(true));
    deps.elsDialogs.runConfirmCancel.addEventListener('click', () => finishRunConfirm(false));
    const closeBtn = deps.elsDialogs.runConfirm.querySelector('.dialog-close');
    if (closeBtn) closeBtn.addEventListener('click', () => finishRunConfirm(false));
}

// 工具链：优先用设置里缓存的扫描结果，没扫过就现场扫一次
async function ensureToolchainForRun(langId, toolId) {
    let eff = deps.effectiveToolEnv(langId, toolId);
    if (eff && eff.ok && eff.path) return eff;
    const env = deps.toolEnvFor(langId, toolId);
    if (!env.scannedAt) {
        try {
            const res = deps.backend.DetectToolchain ? await deps.backend.DetectToolchain(toolId, env.pathOverride || '') : null;
            const list = res && Array.isArray(res.envs) ? res.envs : [];
            env.envs = list;
            env.scannedAt = Date.now();
            env.error = list.length ? '' : ((res && res.error) || '未找到可用环境');
            deps.applySettings();
        } catch (e) {
            env.error = (e && e.message) || String(e);
        }
        eff = deps.effectiveToolEnv(langId, toolId);
    }
    return eff && eff.ok && eff.path ? eff : null;
}

// 从运行输出里点位置引用 → 打开（或切到）对应文件的对应行列
async function openDocAtLocation(path, line, column) {
    if (!path) return;
    let doc = deps.findDocByPath(path);
    if (!doc) {
        await deps.openPathsHere([path]);
        doc = deps.findDocByPath(path);
    }
    if (!doc) {
        deps.flash('打不开：' + path, true);
        return;
    }
    await deps.selectLineInDoc(doc, line, column);
}

// 运行参数：按语言记住输入框原文（回显用），执行时才拆成 argv。
// 输入过程中只改内存并防抖落盘，避免每个字符都重同步整份设置。
function runArgsText(langId) {
    const value = deps.settings.runArgs && deps.settings.runArgs[langId];
    if (Array.isArray(value)) return value.join(' '); // 兼容早期按数组存的写法
    return typeof value === 'string' ? value : '';
}
let runArgsSaveTimer = 0;
function setRunArgs(langId, text) {
    if (!deps.settings.runArgs || typeof deps.settings.runArgs !== 'object') deps.settings.runArgs = {};
    if (runArgsText(langId) === text) return;
    deps.settings.runArgs[langId] = text;
    clearTimeout(runArgsSaveTimer);
    runArgsSaveTimer = setTimeout(deps.applySettings, 400);
}

const runController = createRunController({
    backend: deps.backend,
    onEvent: (name, cb) => {
        if (deps.rt && deps.rt.EventsOn) deps.rt.EventsOn(name, cb);
    },
    getActiveDoc: () => (deps.file ? {
        path: deps.file.path || '',
        name: deps.file.name || '',
        dirty: !!deps.file.dirty,
        binary: !!deps.file.binary,
        large: !!deps.file.large,
        formatId: deps.file.format ? deps.file.format.id : '',
    } : null),
    getDocText: () => activeDocText(),
    saveDoc: () => deps.saveDoc(deps.file, {silent: true}),
    isReadOnly: () => !!deps.settings.readOnlyMode,
    flash: deps.flash,
    askDirtyChoice: (info) => askRunDirty(info),
    hasConfirmed: (lang) => (deps.settings.runConfirmSeen || []).includes(lang),
    confirmRun: async (label, lang) => {
        const ok = await confirmRunOnce(label);
        if (ok && !deps.settings.runConfirmSeen.includes(lang)) {
            deps.settings.runConfirmSeen.push(lang);
            deps.applySettings();
        }
        return ok;
    },
    openLocation: (path, line, column) => openDocAtLocation(path, line, column),
    ensureToolchain: (langId, toolId) => ensureToolchainForRun(langId, toolId),
    copyText: (text, label) => deps.copyText(text, label),
    logActivity: (name, meta) => deps.activityLog.log('code.run', name, meta),
    askAI: (text) => deps.openAIPanelWithDraft(text),
    argsFor: (langId) => splitRunArgs(runArgsText(langId)),
    argsText: (langId) => runArgsText(langId),
    setArgs: (langId, text) => setRunArgs(langId, text),
    templateFor: (langId) => {
        const value = deps.settings.runConfigs && deps.settings.runConfigs[langId];
        return typeof value === 'string' ? value.trim() : '';
    },
    resolveWorkDir: (fallback) => (deps.settings.runCwd === 'workspace' && deps.workspaceFolder ? deps.workspaceFolder : fallback),
    showRunPanel: () => toggleDockView('run'),
    hidePanel: () => toggleTerminalPanel(false),
});

// Ctrl+F5：探测当前文件 / 工作区所属项目，把候选命令列在面板里由用户确认后执行
async function startRunProject() {
    const path = (deps.file && deps.file.path) || deps.workspaceFolder || '';
    if (!path) {
        deps.flash('先打开一个文件或工作区', true);
        return;
    }
    let info;
    try {
        info = await deps.backend.DetectRunProject(path);
    } catch (e) {
        deps.flash('项目探测失败：' + ((e && e.message) || e), true);
        return;
    }
    if (!info || !info.commands || !info.commands.length) {
        deps.flash((info && info.note) || '没有可运行的项目命令', true);
        return;
    }
    runController.showProjectChoice(info);
}

// 首次确认按语言 id 记录（run.js 里传 label + lang）
runController.mount();

async function createTermSession(shell = '') {
    if (!deps.backend.TermCreate) {
        deps.flash('当前版本不支持内置终端', true);
        return;
    }
    const body = document.getElementById('term-body');
    const host = document.createElement('div');
    host.className = 'term-session';
    body.appendChild(host);
    let created;
    try {
        created = await deps.backend.TermCreate(termDefaultCols(), termDefaultRows(), shell, termCwd());
    } catch (e) {
        deps.flash('创建终端失败：' + e, true);
        host.remove();
        return;
    }
    const id = created.id;
    const usedShell = created.shell || shell || 'powershell';
    const term = new window.Terminal({
        fontFamily: '"JetBrains Mono", Consolas, monospace',
        fontSize: 12,
        scrollback: 2000,
        cursorBlink: true,
        theme: termTheme(),
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
        fit.fit();
    } catch (e) {}
    term.onData((data) => {
        deps.backend.TermWrite(id, data).catch(() => {});
    });
    // 页签命名仿 JetBrains：默认 shell 叫「本地」，重复时加 (2)/(3)；显式选择的 shell 用名字
    const baseName = shell ? (TERM_SHELL_LABELS[usedShell] || usedShell) : '本地';
    let dup = 0;
    for (const s of terminalUI.sessions.values()) {
        if (s.baseName === baseName) dup++;
    }
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'term-tab';
    const label = document.createElement('span');
    label.className = 'term-tab-label';
    label.textContent = dup ? baseName + ' (' + (dup + 1) + ')' : baseName;
    label.title = TERM_SHELL_LABELS[usedShell] || usedShell;
    const tabClose = document.createElement('span');
    tabClose.className = 'term-tab-close';
    tabClose.innerHTML = iconSvg('close', 11);
    tabClose.title = '关闭终端';
    tab.append(label, tabClose);
    tab.addEventListener('click', (e) => {
        const closeHit = e.target.closest('.term-tab-close');
        if (closeHit) {
            e.preventDefault();
            e.stopPropagation();
            closeTermSession(id);
            return;
        }
        if (e.shiftKey) {
            e.preventDefault();
            closeTermSession(id);
            return;
        }
        activateTermSession(id);
    });
    tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        activateTermSession(id);
        showTermTabMenu(id, e.clientX, e.clientY);
    });
    document.getElementById('term-tabs').appendChild(tab);
    terminalUI.sessions.set(id, {id, term, fit, host, tab, shell: usedShell, baseName,
        defaultLabel: label.textContent, defaultTitle: label.title, customName: ''});
    terminalUI.order.push(id);
    activateTermSession(id);
    setTimeout(() => {
        try {
            fit.fit();
            term.focus();
        } catch (e) {}
    }, 80);
}

function termDefaultCols() {
    return 80;
}

function termDefaultRows() {
    return 24;
}

function activateTermSession(id) {
    terminalUI.activeId = id;
    for (const [sid, s] of terminalUI.sessions) {
        s.host.classList.toggle('hidden', sid !== id);
        s.tab.classList.toggle('active', sid === id);
    }
    const s = terminalUI.sessions.get(id);
    if (s) {
        try {
            s.fit.fit();
            s.term.focus();
        } catch (e) {}
    }
}

function fitActiveTerm() {
    const s = terminalUI.sessions.get(terminalUI.activeId);
    if (s) {
        try {
            s.fit.fit();
        } catch (e) {}
    }
}

async function closeTermSession(id) {
    try {
        await deps.backend.TermClose(id);
    } catch (e) {}
    removeTermSession(id);
    if (!terminalUI.sessions.size) toggleTerminalPanel(false);
    else activateTermSession(terminalUI.order[terminalUI.order.length - 1]);
}

function removeTermSession(id) {
    const s = terminalUI.sessions.get(id);
    if (s) {
        try {
            s.term.dispose();
        } catch (e) {}
        s.tab.remove();
        s.host.remove();
    }
    terminalUI.sessions.delete(id);
    terminalUI.order = terminalUI.order.filter((x) => x !== id);
}

function syncTerminalTheme() {
    for (const s of terminalUI.sessions.values()) {
        try {
            s.term.options.theme = termTheme();
        } catch (e) {}
    }
}

window.addEventListener('resize', () => {
    if (terminalUI.open) fitActiveTerm();
});

deps.els.gitRefresh.addEventListener('click', () => deps.refreshGitStatus());

if (deps.els.gitSplitter) {
    let gitSplitting = false;
    let gitSplitStartY = 0;
    let gitSplitStartH = 0;
    deps.els.gitSplitter.addEventListener('mousedown', (e) => {
        if (!deps.els.gitCommitArea) return;
        gitSplitting = true;
        gitSplitStartY = e.clientY;
        gitSplitStartH = deps.els.gitCommitArea.offsetHeight;
        deps.setDragCursor('ns');
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!gitSplitting) return;
        const h = Math.min(300, Math.max(90, gitSplitStartH - (e.clientY - gitSplitStartY)));
        deps.els.gitCommitArea.style.height = h + 'px';
        deps.els.gitCommitArea.style.flex = 'none';
    });
    window.addEventListener('mouseup', () => {
        if (!gitSplitting) return;
        gitSplitting = false;
        deps.setDragCursor(null);
        document.body.style.userSelect = '';
        deps.settings.gitCommitAreaHeight = Math.min(300, Math.max(90, deps.els.gitCommitArea.offsetHeight));
        deps.applySettings();
    });
}
deps.els.gitRecentLog.addEventListener('click', () => deps.showGitRecentLog());
deps.els.gitCommitBtn.addEventListener('click', () => runGitCommit(false));
deps.els.gitCommitPushBtn.addEventListener('click', () => runGitCommit(true));

function collectCheckedPaths() {
    return [...deps.els.gitChanges.querySelectorAll('.git-file-row input[type="checkbox"]:checked')].map((cb) => cb.dataset.path);
}

async function runGitCommit(push) {
    if (!deps.backend.GitCommitChanges) {
        deps.flash('当前版本不支持 git 提交', true);
        return;
    }
    const paths = collectCheckedPaths();
    const message = deps.els.gitMessage.value.trim();
    const amend = deps.els.gitAmend.checked;
    if (!amend && !message) {
        deps.flash('请填写提交消息', true);
        deps.els.gitMessage.focus();
        return;
    }
    if (!paths.length && !amend) {
        deps.flash('请勾选要提交的文件', true);
        return;
    }
    deps.els.gitCommitBtn.disabled = true;
    deps.els.gitCommitPushBtn.disabled = true;
    try {
        const res = await deps.backend.GitCommitChanges(deps.gitStateCache.dir, message, paths, amend, push);
        const tail = (res.output || '').trim().split('\n').slice(-4).join('\n');
        if (res.success) {
            deps.flash((push ? '提交并推送完成' : '提交完成') + (tail ? '：' + tail : ''));
            deps.els.gitMessage.value = '';
        } else {
            deps.flash('git 提交失败：' + (tail || '无输出'), true);
        }
    } catch (e) {
        deps.flash('git 提交失败：' + e, true);
    } finally {
        deps.els.gitCommitBtn.disabled = false;
        deps.els.gitCommitPushBtn.disabled = false;
        await deps.refreshGitStatus();
        renderGitPanel();
    }
}

if (deps.els.termNew) deps.els.termNew.addEventListener('click', () => createTermSession());
if (deps.els.termShellMenu) deps.els.termShellMenu.addEventListener('click', () => showTermShellMenu());

// 新建终端的 shell 菜单（JetBrains 风格）：列出本机可用 shell，选中即新建页签
async function showTermShellMenu() {
    if (!deps.ctxMenu) return;
    let shells = [];
    try {
        shells = deps.backend.TermShells ? await deps.backend.TermShells() : [];
    } catch (e) {}
    if (!shells.length) {
        deps.flash('没有可用的 Shell', true);
        return;
    }
    const r = deps.els.termShellMenu.getBoundingClientRect();
    deps.ctxMenu.open(shells.map((s) => ({
        label: s.name,
        action: () => createTermSession(s.id),
    })), r.left, r.bottom + 4);
}
if (deps.els.termPanelClose) deps.els.termPanelClose.addEventListener('click', () => toggleTerminalPanel(false));

// 终端标签页右键菜单（JetBrains 风格）：新建/重命名/清屏/关闭
async function showTermTabMenu(id, x, y) {
    if (!deps.ctxMenu) return;
    const s = terminalUI.sessions.get(id);
    if (!s) return;
    const others = [...terminalUI.sessions.values()].filter((v) => v.id !== id);
    let shells = [];
    try {
        shells = deps.backend.TermShells ? await deps.backend.TermShells() : [];
    } catch (e) {}
    const items = [
        {label: '新建终端（默认 Shell）', icon: 'E710', action: () => createTermSession()},
    ];
    if (shells.length) {
        items.push({
            label: '用其他 Shell 新建终端',
            icon: 'E756',
            submenu: shells.map((sh) => ({label: sh.name, action: () => createTermSession(sh.id)})),
        });
    }
    items.push(
        {label: '重命名标签页', icon: 'E8AC', action: () => renameTermSession(s)},
        {label: '清屏', icon: 'eraser', action: () => { try { s.term.clear(); s.term.focus(); } catch (e) {} }},
        {sep: true},
        {label: '关闭', shortcut: 'Shift+点击', icon: 'E8BB', action: () => closeTermSession(id)},
        {label: '关闭其他标签页', disabled: !others.length, action: () => { for (const o of others) closeTermSession(o.id); }},
        {label: '关闭所有标签页', action: () => { for (const o of [...terminalUI.sessions.values()]) closeTermSession(o.id); }},
    );
    deps.ctxMenu.open(items, x, y);
}

// 重命名终端标签页：清空并确定则恢复默认名
function renameTermSession(s) {
    if (!s) return;
    deps.openNameDialog({
        title: '重命名终端标签页',
        label: '名称',
        value: s.customName || s.defaultLabel,
        okLabel: '确定',
        onSubmit: async (value) => {
            const name = String(value || '').trim();
            const label = s.tab.querySelector('.term-tab-label');
            if (!label) return;
            if (name) {
                s.customName = name;
                label.textContent = name;
                label.title = name;
            } else {
                s.customName = '';
                label.textContent = s.defaultLabel;
                label.title = s.defaultTitle;
            }
        },
    });
}

if (deps.els.terminalPanel && deps.settings.terminalHeight) {
    deps.els.terminalPanel.style.height = deps.settings.terminalHeight + 'px';
}
if (deps.els.sidebarResize) {
    let sidebarResizing = false;
    let sidebarStartX = 0;
    let sidebarStartW = 0;
    deps.els.sidebarResize.addEventListener('mousedown', (e) => {
        if (!deps.settings.showSidebar) return;
        sidebarResizing = true;
        sidebarStartX = e.clientX;
        sidebarStartW = deps.els.sidebar.offsetWidth;
        deps.setDragCursor('ew');
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!sidebarResizing) return;
        const w = Math.min(500, Math.max(160, sidebarStartW + (e.clientX - sidebarStartX)));
        deps.els.sidebar.style.width = w + 'px';
    });
    window.addEventListener('mouseup', () => {
        if (!sidebarResizing) return;
        sidebarResizing = false;
        deps.setDragCursor(null);
        document.body.style.userSelect = '';
        deps.settings.sidebarWidth = Math.min(500, Math.max(160, deps.els.sidebar.offsetWidth));
        deps.applySettings();
    });
}

if (deps.els.terminalResize) {
    let termResizing = false;
    let termResizeStartY = 0;
    let termResizeStartH = 0;
    deps.els.terminalResize.addEventListener('mousedown', (e) => {
        if (!terminalUI.open) return;
        termResizing = true;
        termResizeStartY = e.clientY;
        termResizeStartH = deps.els.terminalPanel.offsetHeight;
        deps.setDragCursor('ns');
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!termResizing) return;
        const h = Math.min(480, Math.max(120, termResizeStartH + (termResizeStartY - e.clientY)));
        deps.els.terminalPanel.style.height = h + 'px';
        fitActiveTerm();
    });
    window.addEventListener('mouseup', () => {
        if (!termResizing) return;
        termResizing = false;
        deps.setDragCursor(null);
        fitActiveTerm();
        deps.settings.terminalHeight = Math.min(480, Math.max(120, deps.els.terminalPanel.offsetHeight));
        deps.applySettings();
    });
}

    function getDockView() { return dockView; }
    function setDockView(v) { dockView = v; }
    function nextCmdSeq() { return ++cmdSeq; }
    function nextMockBgSeq() { return ++mockBgSeq; }
    function nextMockSchedSeq() { return ++mockSchedSeq; }

    return {applyDockView, renderGitPanel, startRunProject, renderGitPanel, cmdExitHandlers, cmdOutHandlers, currentSidebarView, fitActiveTerm, runArgsText, runController, switchSidebarView, syncTerminalTheme, termCwd, terminalUI, toggleDockView, toggleSidebarView, toggleTerminalPanel, getDockView, setDockView, nextCmdSeq, nextMockBgSeq, nextMockSchedSeq};
}
