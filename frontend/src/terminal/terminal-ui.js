// terminal-ui.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// 内置终端 / 侧栏与底部面板 / git 面板；运行接线与会话管理已拆到同目录兄弟模块。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {iconSvg} from '../core/icons.js';
import {createFileIcon} from '../core/fileicons.js';
import {createRunUI} from './run-ui.js';
import {createTerminalSessions} from './terminal-sessions.js';
import {createGitGraph} from '../git-graph/git-graph.js';

export function createTerminalUI(deps) {

const terminalUI = {open: false, sessions: new Map(), order: [], activeId: null};
const TERM_SHELL_LABELS = {pwsh: 'PowerShell 7', powershell: 'Windows PowerShell', cmd: 'Command Prompt', gitbash: 'Git Bash'};
const cmdOutHandlers = new Map();
const cmdExitHandlers = new Map();
let cmdSeq = 0;
// Git 提交面板当前选中的行（JetBrains 式：单击选中、双击开 diff、右键菜单）；
// 轮询重渲染后据此恢复选中态。
let gitSelectedPath = '';

// 运行接线与会话管理经 Object.create 委托原 deps（getter 仍惰性），只补它们需要的宿主能力
const runDeps = Object.create(deps);
runDeps.toggleTerminalPanel = toggleTerminalPanel;
runDeps.toggleDockView = toggleDockView;
const runMod = createRunUI(runDeps);

const sessDeps = Object.create(deps);
sessDeps.terminalUI = terminalUI;
sessDeps.TERM_SHELL_LABELS = TERM_SHELL_LABELS;
sessDeps.termCwd = termCwd;
sessDeps.termTheme = termTheme;
sessDeps.toggleTerminalPanel = toggleTerminalPanel;
sessDeps.runGitCommit = runGitCommit;
const sessMod = createTerminalSessions(sessDeps);

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

// 选中提交面板的某一行（勾选框独立，点它不会选中整行）。
function selectGitRow(path) {
    gitSelectedPath = path || '';
    applyGitSelection();
}

// 把选中态同步到当前 DOM（轮询重渲染后调用以恢复高亮）。
function applyGitSelection() {
    if (!deps.els || !deps.els.gitChanges) return;
    for (const row of deps.els.gitChanges.querySelectorAll('.git-file-row')) {
        row.classList.toggle('selected', row.dataset.path === gitSelectedPath);
    }
}

// 「作为补丁复制到剪贴板」：读该文件 diff 原文进剪贴板。
async function copyGitPatch(path) {
    if (!deps.backend.GitDiffFor) {
        deps.flash('当前版本不支持读取差异', true);
        return;
    }
    try {
        const res = await deps.backend.GitDiffFor(deps.gitStateCache.dir, path);
        if (!res || !res.diff) {
            deps.flash('该文件暂无差异');
            return;
        }
        await deps.copyText(res.diff, '补丁');
    } catch (e) {
        deps.flash('复制补丁失败：' + e, true);
    }
}

// 提交面板文件行的右键菜单（对齐 JetBrains 常用项，按项目已有能力裁剪）。
function openGitFileMenu(path, state, x, y) {
    if (!deps.ctxMenu) return;
    const isUntracked = state === 'untracked' ||
        (deps.gitStateCache.untrackedSet && deps.gitStateCache.untrackedSet.has(path));
    deps.ctxMenu.open([
        {label: '显示差异', icon: 'diff', action: () => deps.showGitDiff(path)},
        {label: '跳转到源', icon: 'file', action: () => deps.openPathsHere([path])},
        {label: '文件历史', icon: 'history', action: () => deps.showGitFileHistory(path)},
        {sep: true},
        {label: '作为补丁复制到剪贴板', icon: 'copy', action: () => copyGitPatch(path)},
        {sep: true},
        {label: '回滚更改', icon: 'undo', danger: true, action: () => {
            const what = isUntracked ? '该文件未被版本管理，回滚将删除文件：' : '将丢弃该文件的全部未提交修改：';
            deps.openConfirmDialog(what + '\n' + path, () => deps.gitRollbackPaths([path], isUntracked ? [path] : []), '回滚', '回滚更改', 'danger');
        }},
        {sep: true},
        {label: '刷新', icon: 'refresh', action: () => deps.refreshGitStatus()},
    ], x, y);
}

// 回滚全部未提交更改：tracked 丢弃修改，untracked 删除文件。危险二次确认走统一弹窗。
function rollbackAllChanges() {
    const all = [];
    const untracked = [];
    for (const [path, state] of deps.gitStateCache.map) {
        all.push(path);
        if (state === 'untracked') untracked.push(path);
    }
    if (!all.length) {
        deps.flash('没有可回滚的更改');
        return;
    }
    deps.openConfirmDialog(
        '将丢弃全部 ' + all.length + ' 个文件的未提交修改（未跟踪文件将被删除）。',
        () => deps.gitRollbackPaths(all, untracked),
        '回滚', '回滚全部更改', 'danger');
}

// 标题栏「...」菜单：把危险的「回滚全部更改」收进来，避免和刷新并排时误触。
// 菜单走全局 ctxMenu 实例，定位在按钮下方（与 db-ui 的锚点菜单同款）。
function openGitMoreMenu(anchor) {
    if (!deps.ctxMenu) return;
    const rect = anchor.getBoundingClientRect();
    deps.ctxMenu.open([
        {label: '回滚全部更改', icon: 'undo', danger: true, action: rollbackAllChanges},
    ], rect.left, rect.bottom + 2);
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
        const row = document.createElement('div');
        row.className = 'git-file-row';
        row.dataset.path = path;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = checked;
        cb.dataset.path = path;
        // 勾选状态写入共享集合，跨轮询重渲染保留
        cb.addEventListener('change', () => {
            if (cb.checked) deps.gitUncheckedFiles.delete(path);
            else deps.gitUncheckedFiles.add(path);
        });
        // 勾选框独立命中区：点它只切勾选，不冒泡到整行的选中 / 双击开 diff
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('dblclick', (e) => e.stopPropagation());
        const fileName = path.replace(/^.*[\\/]/, '');
        const icon = createFileIcon(fileName, 'git-ficon');
        const name = document.createElement('span');
        name.className = 'git-fname git-st-' + (state || 'modified');
        name.textContent = fileName;
        row.append(cb, icon, name);
        // JetBrains 式：文件名后跟一行淡灰小字 = 相对仓库根的父目录
        const relParent = gitRelParentDir(path);
        if (relParent) {
            const dirSpan = document.createElement('span');
            dirSpan.className = 'git-fpath';
            dirSpan.textContent = relParent;
            row.append(dirSpan);
        }
        row.dataset.tip = path;
        // 单击：只选中行（不勾选、不开 diff）
        row.addEventListener('click', (e) => {
            if (e.target === cb) return;
            selectGitRow(path);
        });
        // 双击：打开只读 diff（选中已在单击时完成）
        row.addEventListener('dblclick', (e) => {
            if (e.target === cb) return;
            deps.showGitDiff(path);
        });
        // 右键：先选中，再开菜单
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            selectGitRow(path);
            openGitFileMenu(path, state, e.clientX, e.clientY);
        });
        return row;
    };
    // 分组块：组头勾选框 = 全选/全不选该组文件（JetBrains 式，支持半选态）；组头箭头与文件勾选态均跨轮询重渲染保留
    const makeGroupBlock = (title, rows, key) => {
        const block = document.createElement('div');
        block.className = 'git-group-block';
        const head = document.createElement('div');
        head.className = 'git-group';
        const chev = document.createElement('button');
        chev.type = 'button';
        chev.className = 'git-chev';
        // 箭头方向自明，不再挂 data-tip；展开态与可访问名走原生属性
        chev.setAttribute('aria-label', title + '（展开或收起）');
        chev.setAttribute('aria-expanded', String(!deps.gitGroupCollapsed[key]));
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
            for (const c of rowCbs()) {
                c.checked = gcb.checked;
                // 组头全选/全不选是程序赋值，不触发行 change 事件，这里手动同步集合
                if (gcb.checked) deps.gitUncheckedFiles.delete(c.dataset.path);
                else deps.gitUncheckedFiles.add(c.dataset.path);
            }
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
        const rows = changes.map((item) => makeRow(item.path, !deps.gitUncheckedFiles.has(item.path), item.state));
        deps.els.gitChanges.appendChild(makeGroupBlock('更改（' + changes.length + ' 个文件）', rows, 'changes'));
    }
    if (untracked.length) {
        const rows = untracked.map((path) => makeRow(path, !deps.gitUncheckedFiles.has(path), 'untracked'));
        deps.els.gitChanges.appendChild(makeGroupBlock('未进行版本管理的文件（' + untracked.length + ' 个文件）', rows, 'untracked'));
    }
    // 轮询重渲染后恢复选中态（DOM 已重建，选中记忆在 gitSelectedPath）
    applyGitSelection();
}

function currentSidebarView() {
    const view = deps.settings.sidebarView;
    if (view === 'git' || view === 'structure' || view === 'chats' || view === 'app-pages' || view === 'database' || view === 'maven') return view;
    return 'files';
}

function switchSidebarView(view) {
    if (!['files', 'git', 'structure', 'chats', 'app-pages', 'database', 'maven'].includes(view)) view = 'files';
    deps.settings.sidebarView = view;
    if (deps.structurePanel && view === 'structure') deps.structurePanel.setDoc(deps.file);
    deps.applySettings();
    if (view === 'git') {
        deps.refreshGitStatus().then(() => renderGitPanel()).catch(() => renderGitPanel());
    }
    // 应用页面面板：每次切进来重绘一次（列表是本地注册表，成本可忽略）
    if (view === 'app-pages' && typeof deps.renderAppPagesNav === 'function') {
        try { deps.renderAppPagesNav(); } catch (e) {}
    }
    // 数据库面板：每次切进来重绘（工作区注册表可能被别的窗口改过）
    if (view === 'database' && typeof deps.renderDatabaseNav === 'function') {
        try { deps.renderDatabaseNav(); } catch (e) {}
    }
    // Maven 面板：每次切进来重绘（触发判定 / 项目结构可能变过）
    if (view === 'maven' && typeof deps.renderMavenTree === 'function') {
        try { deps.renderMavenTree(); } catch (e) {}
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
        if (dockView === 'terminal' && !terminalUI.sessions.size) sessMod.createTermSession();
        applyDockView();
    } else {
        panel.classList.add('hidden');
        terminalUI.open = false;
        applyDockView();
    }
}

let dockView = 'terminal'; // 底部面板当前内容：'terminal' | 'debug' | 'run' | 'graph'

// Git 图谱域模块（懒初始化：首次切到该视图才建实例并拉数据）
let gitGraphMod = null;
function getGitGraph() {
    if (!gitGraphMod) {
        // 注入宿主能力（关闭面板），与 runDeps / sessDeps 同款
        const graphDeps = Object.create(deps);
        graphDeps.toggleTerminalPanel = toggleTerminalPanel;
        gitGraphMod = createGitGraph(graphDeps);
    }
    return gitGraphMod;
}

// 应用底部面板视图：终端、调试控制台、运行面板与 Git 图谱共用同一个容器
function applyDockView() {
    const panel = document.getElementById('terminal-panel');
    if (!panel) return;
    const termOpen = terminalUI.open && dockView === 'terminal';
    const debugOpen = terminalUI.open && dockView === 'debug';
    const runOpen = terminalUI.open && dockView === 'run';
    const graphOpen = terminalUI.open && dockView === 'graph';
    const head = panel.querySelector('.term-head');
    if (head) head.classList.toggle('hidden', terminalUI.open && dockView !== 'terminal');
    const termBody = document.getElementById('term-body');
    if (termBody) termBody.classList.toggle('hidden', terminalUI.open && dockView !== 'terminal');
    const debugView = document.getElementById('debug-view');
    if (debugView) debugView.classList.toggle('hidden', !debugOpen);
    const runView = document.getElementById('run-view');
    if (runView) runView.classList.toggle('hidden', !runOpen);
    const graphView = document.getElementById('git-graph-view');
    if (graphView) graphView.classList.toggle('hidden', !graphOpen);
    if (deps.els.abTerminal) {
        deps.els.abTerminal.classList.toggle('active', termOpen);
        deps.els.abTerminal.setAttribute('aria-pressed', String(termOpen));
    }
    if (deps.els.abDebug) {
        deps.els.abDebug.classList.toggle('active', debugOpen);
        deps.els.abDebug.setAttribute('aria-pressed', String(debugOpen));
    }
    if (deps.els.abGitGraph) {
        deps.els.abGitGraph.classList.toggle('active', graphOpen);
        deps.els.abGitGraph.setAttribute('aria-pressed', String(graphOpen));
    }
    // tb-run 是动作按钮（点击即运行），不随运行面板开关显示选中态
    if (termOpen) sessMod.fitActiveTerm();
    if (graphOpen) { try { getGitGraph().show(); } catch (e) { /* show 内部已兜错，防御性忽略 */ } }
}

// 左下活动栏 / 菜单 / F12 的统一入口：同一视图再点一次收起，不同视图则切换
function toggleDockView(view) {
    const target = view === 'debug' ? 'debug' : (view === 'run' ? 'run' : (view === 'graph' ? 'graph' : 'terminal'));
    const panel = document.getElementById('terminal-panel');
    if (!panel) return;
    if (!terminalUI.open) {
        dockView = target;
        toggleTerminalPanel(true);
        return;
    }
    if (dockView !== target) {
        dockView = target;
        if (target === 'terminal' && !terminalUI.sessions.size) sessMod.createTermSession();
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


// 标题栏三个工具按钮的图标统一由注册表注入（HTML 里留空，避免内联 svg 散落）。
deps.els.gitRefresh.innerHTML = iconSvg('refresh');
deps.els.gitMore.innerHTML = iconSvg('more');
deps.els.gitRecentLog.innerHTML = iconSvg('history');

deps.els.gitRecentLog.addEventListener('click', () => deps.showGitRecentLog());
deps.els.gitMore.addEventListener('click', () => openGitMoreMenu(deps.els.gitMore));
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

if (deps.els.termNew) deps.els.termNew.addEventListener('click', () => sessMod.createTermSession());
if (deps.els.termShellMenu) deps.els.termShellMenu.addEventListener('click', () => sessMod.showTermShellMenu());



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
    // 高度上限放开到窗口 85%（IDEA 式可铺很高），但至少给顶条留 240px
    // （AI 面板贴底堆叠区需要立足之地）；极小窗口兜底 120px
    const maxPanelH = () => Math.max(120, Math.min(window.innerHeight * 0.85, window.innerHeight - 240));
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
        const h = Math.min(maxPanelH(), Math.max(120, termResizeStartH + (termResizeStartY - e.clientY)));
        deps.els.terminalPanel.style.height = h + 'px';
        sessMod.fitActiveTerm();
    });
    window.addEventListener('mouseup', () => {
        if (!termResizing) return;
        termResizing = false;
        deps.setDragCursor(null);
        sessMod.fitActiveTerm();
        deps.settings.terminalHeight = Math.min(maxPanelH(), Math.max(120, deps.els.terminalPanel.offsetHeight));
        deps.applySettings();
    });
}

    function getDockView() { return dockView; }
    function setDockView(v) { dockView = v; }
    function nextCmdSeq() { return ++cmdSeq; }
    function nextMockBgSeq() { return ++mockBgSeq; }
    function nextMockSchedSeq() { return ++mockSchedSeq; }

    return {
        ...runMod, ...sessMod,
        applyDockView, renderGitPanel, cmdExitHandlers, cmdOutHandlers, currentSidebarView,
        switchSidebarView, termCwd, terminalUI, toggleDockView, toggleSidebarView, toggleTerminalPanel,
        getDockView, setDockView, nextCmdSeq, nextMockBgSeq, nextMockSchedSeq,
    };
}
