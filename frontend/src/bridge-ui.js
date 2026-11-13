// bridge-ui.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// 进程桥 / 虚拟文档
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {formats, pluginFormats, detectFormat} from './formats.js';
import {loadPlugins} from './plugins.js';

export function createBridgeUI(deps) {

function openVirtualDoc(name, content) {
    const doc = deps.createDoc({
        path: null,
        name,
        content,
        size: content.length,
        eol: 'lf',
        hasBom: false,
        large: false,
        enc: 'utf-8',
    });
    doc.untitled = true;
    deps.docs.push(doc);
    deps.activateDoc(doc);
    return doc;
}

// ===== 浏览器使用标签页 =====
let browserSeq = 0;

function openBrowserTab(url, profileKey) {
    browserSeq += 1;
    const target = (url || '').trim() || 'about:blank';
    const doc = {
        id: 'browser-' + Date.now().toString(36) + '-' + browserSeq,
        path: null,
        name: target !== 'about:blank' ? target : '新标签页',
        content: '',
        size: 0,
        eol: 'lf',
        hasBom: false,
        large: false,
        enc: 'utf-8',
        format: {id: 'browser', name: '网页', extensions: [], aceMode: 'text', rawOnly: true},
        browser: true,
        mode: 'browser',
        browserUrl: target,
        browserProfile: profileKey || '',
        treeAvailable: false,
        dirty: false,
        untitled: false,
        bases: {},
        savedText: '',
    };
    deps.docs.push(doc);
    deps.addDocToFocusedGroup(doc);
    deps.activateDoc(doc);
    if (deps.backend.BrowserOpen) {
        deps.backend.BrowserOpen(doc.id, target, doc.browserProfile || 'tab-' + doc.id).then((info) => {
            if (info && info.title) deps.updateBrowserTitle(doc, info.title);
            if (doc.browserEmpty) {
                doc.browserEmpty.remove();
                doc.browserEmpty = null;
            }
            deps.syncBrowserTab(doc);
        }).catch((e) => {
            const stack = String((e && e.stack) || '').split(String.fromCharCode(10)).slice(0, 4).join(' | ');
            deps.flash('浏览器标签页打开失败：' + ((e && e.message) || e) + ' @ ' + stack, true);
            deps.closeDocNow(doc, false);
        });
    } else {
        deps.flash('当前环境不支持内嵌浏览器', true);
    }
    return doc;
}

// ===== 后台终端标签页（AI background_command 作业在内容区的视图）=====
// 数据来自 aiPanel 桥接（bridgeBgJob / bridgeOnBgUpdate / bridgeStopBgJob）；
// 上栏命令信息、下栏实时输出，中间分割线可拖拽（比例存 localStorage）；关闭标签不影响作业。

const BGTERM_SPLIT_KEY = 'datalens-bgterm-split';

function bgTermSplitRatio() {
    const raw = Number(localStorage.getItem(BGTERM_SPLIT_KEY));
    if (!Number.isFinite(raw) || raw < 0.15 || raw > 0.85) return 0.34;
    return raw;
}

function bgTermTabName(command) {
    const line = String(command || '').split('\n', 1)[0].replace(/\s+/g, ' ').trim();
    if (!line) return '后台终端';
    return line.length > 28 ? line.slice(0, 28) + '…' : line;
}

function openBgTermTab(info) {
    const jobId = String((info && info.jobId) || '');
    if (!jobId) return null;
    const existing = deps.docs.find((d) => d.bgTerm === jobId);
    if (existing) {
        deps.activateDoc(existing);
        return existing;
    }
    const doc = {
        id: 'bgterm-' + jobId,
        path: null,
        name: bgTermTabName(info && info.command),
        content: '',
        size: 0,
        eol: 'lf',
        hasBom: false,
        large: false,
        enc: 'utf-8',
        format: {id: 'bgterm', name: '后台终端', extensions: [], aceMode: 'text', rawOnly: true},
        bgTerm: jobId,
        bgTermCommand: String((info && info.command) || ''),
        mode: 'bgterm',
        treeAvailable: false,
        dirty: false,
        untitled: false,
        bases: {},
        savedText: '',
    };
    deps.docs.push(doc);
    deps.addDocToFocusedGroup(doc);
    deps.activateDoc(doc);
    return doc;
}

function bgTermStateLabel(state, code) {
    if (state === 'running') return '运行中';
    if (state === 'exited') return '已退出（' + (code == null ? '?' : code) + '）';
    if (state === 'stopped') return '已停止';
    if (state === 'notfound') return '不存在';
    return state || '未知';
}

function createBgTermView(doc) {
    const pane = document.createElement('div');
    pane.className = 'jsoneditor-pane active bgterm-pane';
    deps.els.editor.appendChild(pane);

    // 上栏：命令 + 元信息 + 停止
    const info = document.createElement('div');
    info.className = 'bgterm-info';
    const cmdRow = document.createElement('div');
    cmdRow.className = 'bgterm-cmd-row';
    const cmdLabel = document.createElement('span');
    cmdLabel.className = 'bgterm-label';
    cmdLabel.textContent = '命令';
    const cmd = document.createElement('pre');
    cmd.className = 'bgterm-cmd';
    cmd.textContent = doc.bgTermCommand || '（读取中…）';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'dlg-btn bgterm-copy';
    copyBtn.textContent = '复制';
    copyBtn.addEventListener('click', () => deps.copyText(doc.bgTermCommand || '', '命令'));
    cmdRow.append(cmdLabel, cmd, copyBtn);

    const metaRow = document.createElement('div');
    metaRow.className = 'bgterm-meta-row';
    const stateBadge = document.createElement('span');
    stateBadge.className = 'bgterm-state';
    const metaText = document.createElement('span');
    metaText.className = 'bgterm-meta';
    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'dlg-btn bgterm-stop';
    stopBtn.textContent = '停止';
    metaRow.append(stateBadge, metaText, stopBtn);
    info.append(cmdRow, metaRow);

    // 中间分割线：拖拽调整上下比例
    const split = document.createElement('div');
    split.className = 'bgterm-split';
    split.title = '拖动调整上下高度';

    // 下栏：输出
    const out = document.createElement('pre');
    out.className = 'bgterm-out empty';
    out.textContent = '（暂无输出；作业产生输出后会实时显示在这里）';

    pane.append(info, split, out);
    doc.pane = pane;
    doc.bgTermEl = out;
    doc.bgTermStateEl = stateBadge;
    doc.bgTermMetaEl = metaText;

    doc.bgTermRatio = bgTermSplitRatio();
    info.style.flexBasis = (doc.bgTermRatio * 100) + '%';
    let dragging = false;
    const onMove = (e) => {
        if (!dragging || !pane.isConnected) return;
        const rect = pane.getBoundingClientRect();
        if (!rect.height) return;
        const ratio = Math.min(0.85, Math.max(0.15, (e.clientY - rect.top) / rect.height));
        doc.bgTermRatio = ratio;
        info.style.flexBasis = (ratio * 100) + '%';
    };
    const onUp = () => {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove('bgterm-dragging');
        try { localStorage.setItem(BGTERM_SPLIT_KEY, String(doc.bgTermRatio)); } catch (e) {}
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
    };
    split.addEventListener('mousedown', (e) => {
        e.preventDefault();
        dragging = true;
        document.body.classList.add('bgterm-dragging');
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    });

    stopBtn.addEventListener('click', async () => {
        if (!deps.aiPanel || !deps.aiPanel.bridgeStopBgJob) return deps.flash('当前版本不支持停止后台命令', true);
        stopBtn.disabled = true;
        try {
            await deps.aiPanel.bridgeStopBgJob(doc.bgTerm);
            deps.flash('已发送停止指令');
        } catch (e) {
            deps.flash('停止失败：' + ((e && e.message) || e), true);
        } finally {
            stopBtn.disabled = false;
        }
    });

    const render = () => {
        const snapshot = deps.aiPanel && deps.aiPanel.bridgeBgJob ? deps.aiPanel.bridgeBgJob(doc.bgTerm) : null;
        if (!snapshot) {
            stateBadge.textContent = '已丢失';
            stateBadge.className = 'bgterm-state st-lost';
            metaText.textContent = '作业句柄不在本运行期（应用重启后无法查看实时输出）';
            stopBtn.classList.add('hidden');
            return;
        }
        if (snapshot.command && !doc.bgTermCommand) {
            doc.bgTermCommand = snapshot.command;
            cmd.textContent = snapshot.command;
        }
        const state = snapshot.state || 'unknown';
        stateBadge.textContent = bgTermStateLabel(state, snapshot.code);
        stateBadge.className = 'bgterm-state st-' + state;
        const bits = [];
        if (snapshot.cwd) bits.push('目录 ' + snapshot.cwd);
        bits.push('jobId ' + doc.bgTerm);
        if (snapshot.startedAt) bits.push('启动 ' + new Date(snapshot.startedAt).toLocaleTimeString());
        metaText.textContent = bits.join(' · ');
        stopBtn.classList.toggle('hidden', state !== 'running');
        const text = String(snapshot.log || '');
        // 用户往上翻历史时不强制拉回底部
        const nearBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 60;
        if (text) {
            out.textContent = text;
            out.classList.remove('empty');
            if (nearBottom) out.scrollTop = out.scrollHeight;
        } else {
            out.textContent = '（暂无输出；作业产生输出后会实时显示在这里）';
            out.classList.add('empty');
        }
        renderBgTermTabTitle(doc, snapshot.command);
    };

    if (deps.aiPanel && deps.aiPanel.bridgeOnBgUpdate) {
        doc.bgTermUnsub = deps.aiPanel.bridgeOnBgUpdate((jobId) => {
            if (jobId !== doc.bgTerm || !doc.pane || !doc.pane.isConnected) return;
            render();
        });
    }
    render();
}

function renderBgTermTabTitle(doc, command) {
    const name = bgTermTabName(command || doc.bgTermCommand);
    if (name && name !== doc.name) {
        doc.name = name;
        deps.renderTabs();
    }
}

// ===== git 浅集成 =====
const gitStateCache = {dir: '', map: new Map(), branch: '', available: false, reason: '', untrackedSet: new Set(), ignoredSet: new Set()};
const gitGroupCollapsed = {changes: false, untracked: false};
let gitTimer = null;

function gitRootDir() {
    return deps.workspaceFolder || (deps.file && deps.file.path ? deps.file.path.replace(/[\\/][^\\/]*$/, '') : '') || '';
}

async function refreshGitStatus() {
    if (!deps.backend.GitStatusFor) return;
    const root = gitRootDir();
    if (!root) {
        gitStateCache.dir = '';
        gitStateCache.map.clear();
        gitStateCache.available = false;
        gitStateCache.branch = '';
        applyGitBadges();
        deps.renderWorkspaceCrumbs();
        notifyAIGitEntry();
        return;
    }
    if (root !== gitStateCache.dir) {
        gitStateCache.dir = root;
        gitStateCache.map.clear();
    }
    try {
        const status = await deps.backend.GitStatusFor(root);
        if (!status || !status.available) {
            gitStateCache.map.clear();
            gitStateCache.branch = '';
            gitStateCache.available = !!status.available;
            gitStateCache.reason = status.reason || '';
        } else {
            gitStateCache.available = true;
            gitStateCache.branch = status.branch || '';
            gitStateCache.map.clear();
            gitStateCache.untrackedSet.clear();
            gitStateCache.ignoredSet.clear();
            for (const entry of status.entries || []) {
                const p = entry.path.replace(/\\/g, '/').replace(/\/+$/, '');
                if (entry.state === 'ignored') {
                    gitStateCache.ignoredSet.add(p);
                    continue;
                }
                gitStateCache.map.set(p, entry.state);
                if (entry.state === 'untracked') gitStateCache.untrackedSet.add(p);
            }
        }
    } catch (e) {}
    applyGitBadges();
    applyGitDot();
    deps.renderWorkspaceCrumbs();
    // git 状态变化（提交/回滚/外部改动被定时器捕捉）后刷新已打开文件的行级标记
    for (const d of deps.docs) deps.scheduleGitGutter(d, 400);
    if (deps.currentSidebarView() === 'git' && deps.settings.showSidebar && deps.els.gitChanges) {
        deps.renderGitPanel();
    }
    notifyAIGitEntry();
}

// AI 面板头顶的 Git 图标是否出现，取决于当前工作区是不是 git 仓库。
function notifyAIGitEntry() {
    if (deps.aiPanel && typeof deps.aiPanel.refreshGitEntry === 'function') {
        try { deps.aiPanel.refreshGitEntry(); } catch (e) {}
    }
}

function applyGitBadges() {
    document.querySelectorAll('.sb-row[data-path]').forEach((row) => {
        for (const cls of Array.from(row.classList)) {
            if (cls.startsWith('git-')) row.classList.remove(cls);
        }
        const key = row.dataset.path.replace(/\\/g, '/').replace(/\/+$/, '');
        const st = gitStateCache.map.get(key);
        // 已删除文件磁盘上不存在、不会出现在文件树；灰色删除态只在 Git 提交面板显示
        if (st && st !== 'deleted') row.classList.add('git-' + st);
        else if (gitStateCache.ignoredSet.has(key)) row.classList.add('git-ignored');
    });
}

const gitBadgeObserver = new MutationObserver(() => applyGitBadges());

function restartGitTimer() {
    if (gitTimer) clearInterval(gitTimer);
    const sec = Math.max(1, deps.settings.treeRefreshInterval || 3);
    gitTimer = setInterval(refreshGitStatus, sec * 1000);
}

function applyGitDot() {
    if (deps.els.abGit) deps.els.abGit.classList.toggle('has-changes', gitStateCache.map.size > 0);
}

async function showGitRecentLog() {
    if (!deps.backend.GitRecentLogFor) {
        deps.flash('当前版本不支持查看提交历史', true);
        return;
    }
    const dir = gitStateCache.dir || gitRootDir();
    if (!dir) {
        deps.flash('请先打开一个文件或目录', true);
        return;
    }
    try {
        const log = await deps.backend.GitRecentLogFor(dir, 100);
        openVirtualDoc('Git 最近提交.gitlog', log || '（没有提交）');
    } catch (e) {
        deps.flash('读取提交历史失败：' + e, true);
    }
}

async function showGitFileHistory(path) {
    if (!deps.backend.GitFileHistoryFor) {
        deps.flash('当前版本不支持查看文件历史', true);
        return;
    }
    const dir = gitStateCache.dir || gitRootDir();
    if (!dir) return;
    try {
        const log = await deps.backend.GitFileHistoryFor(dir, path, 50);
        openVirtualDoc('Git 文件历史 — ' + path.replace(/^.*[\\/]/, '') + '.history', log || '（该文件没有提交历史）');
    } catch (e) {
        deps.flash('读取文件历史失败：' + e, true);
    }
}

async function gitRollbackPaths(paths, untracked) {
    if (!deps.backend.GitRollbackFor) {
        deps.flash('当前版本不支持回滚', true);
        return;
    }
    const root = gitStateCache.dir || gitRootDir();
    const tracked = paths.filter((p) => !untracked.includes(p));
    const realUntracked = untracked.filter((p) => untracked.includes(p));
    try {
        await deps.backend.GitRollbackFor(root, tracked, realUntracked);
        deps.flash('已回滚 ' + (tracked.length + realUntracked.length) + ' 个文件');
    } catch (e) {
        deps.flash('回滚失败：' + e, true);
    }
    await refreshGitStatus();
    deps.renderGitPanel();
}

async function showGitDiff(path) {
    if (!deps.backend.GitDiffFor) return;
    try {
        const res = await deps.backend.GitDiffFor(gitStateCache.dir || gitRootDir(), path);
        if (!res || !res.hasChanges) {
            deps.flash('该文件暂无差异');
            return;
        }
        openVirtualDoc('Git 差异 — ' + path.replace(/^.*[\\/]/, '') + '.diff', res.diff);
    } catch (e) {
        deps.flash('读取差异失败：' + e, true);
    }
}


try {
    if (deps.els.sbBody) gitBadgeObserver.observe(deps.els.sbBody, {childList: true, subtree: false});
    restartGitTimer();
    refreshGitStatus();
    if (deps.settings.sidebarView === 'git') deps.switchSidebarView('git');
} catch (e) {
    window.__gitInitErr = String((e && e.stack) || e);
}
deps.initCodeFoldHover();

// ---- CLI 转换模式：隐藏窗口加载前端格式层，转换完立即退出 ----
function convertTargetDriver(to) {
    const id = String(to || '').toLowerCase().replace(/^\./, '');
    const aliases = {yml: 'yaml', ndjson: 'jsonl'};
    const targetID = aliases[id] || id;
    const driver = formats[targetID] ||
        pluginFormats.find((f) => f.id === targetID) ||
        Object.values(formats).find((f) => f.extensions.includes(targetID));
    if (!driver || typeof driver.parse !== 'function' || typeof driver.stringify !== 'function') {
        throw new Error('不支持的目标格式：' + to);
    }
    return driver;
}

async function maybeRunConvertJob() {
    if (!deps.hasWails || !deps.backend.GetConvertRequest) return false;
    let raw = '';
    try {
        raw = await deps.backend.GetConvertRequest();
    } catch (e) {
        return false;
    }
    if (!raw) return false;
    let req;
    try {
        req = JSON.parse(raw);
    } catch (e) {
        return false;
    }
    let target = null;
    let targetError = '';
    try {
        target = convertTargetDriver(req.to);
    } catch (e) {
        targetError = String((e && e.message) || e);
    }
    const results = [];
    for (const job of req.jobs || []) {
        try {
            if (targetError) throw new Error(targetError);
            const data = await deps.backend.OpenFile(job.input, 'auto');
            if (!data || data.binary) throw new Error('二进制文件不支持转换');
            const content = String(data.content == null ? '' : data.content);
            const source = detectFormat(job.input, content);
            if (typeof source.parse !== 'function' || typeof source.stringify !== 'function') {
                throw new Error('不支持读取该格式：' + (source.name || ''));
            }
            const value = source.parse(content);
            const output = target.stringify(value);
            results.push({
                input: job.input,
                output: job.output || '',
                content: output == null ? '' : String(output),
            });
        } catch (e) {
            results.push({
                input: job.input,
                output: job.output || '',
                error: String((e && e.message) || e),
            });
        }
    }
    try {
        await deps.backend.FinishConvert(JSON.stringify({stdout: !!req.stdout, results}));
    } catch (e) {}
    return true;
}

(async () => {
    if (await maybeRunConvertJob()) return;
    // 独立调试控制台窗口：只渲染控制台面板，跳过正常的应用启动流程
    if (await deps.consoleWindowMode) {
        deps.startConsoleWindowMode();
        return;
    }
    let floatWindow = false;
    try {
        floatWindow = !!(deps.backend.IsAIFloatWindow && await deps.backend.IsAIFloatWindow());
    } catch (e) {
        floatWindow = false;
    }
    if (!floatWindow && !deps.hasWails && deps.mockScenario.has('aifloat')) floatWindow = true;
    if (floatWindow) {
        window.__aiFloatWindow = true;
        document.body.classList.add('ai-float-window');
        document.title = 'AI 助手 · CaDt-DataLens';
    }
    // 操作留痕：主窗口启动标记（悬浮窗/独立控制台/转换模式不记）。
    deps.activityLog.log('app.start', '', {mock: deps.hasWails ? undefined : true}, {actor: 'system', source: 'system'});
    deps.refreshDeveloperMode();
    deps.refreshLogPath();
    if (deps.backend.GetOpenMode) {
        try {
            const mode = await deps.backend.GetOpenMode();
            if (mode === 'tab' || mode === 'window') {
                deps.settings.openMode = mode;
                deps.syncedOpenMode = mode;
                deps.applySettings();
            }
        } catch (e) {}
    }
    if (deps.backend.GetPluginSources) {
        try {
            const errors = await loadPlugins(deps.backend);
            window.__pluginLoadErrors = errors;
            for (const err of errors) deps.flash(err, true);
        } catch (e) {
            window.__pluginLoadErrors = ['异常：' + (e && e.stack || e)];
            deps.flash('插件加载失败：' + e, true);
        }
    }
    deps.logFrontend('info', '前端启动完成：' + navigator.userAgent);
    let startupAISession = '';
    if (deps.backend.GetStartupAISession) {
        try {
            startupAISession = await deps.backend.GetStartupAISession() || '';
        } catch (e) {}
    }
    let targets = [];
    if (deps.backend.GetStartupTargets) {
        try {
            targets = await deps.backend.GetStartupTargets();
        } catch (e) {}
    }
    if (targets && targets.length) {
        // 先读取目标目录上次的工作区环境，再打开目标：打开目录会触发一次防抖保存，
        // 若先打开再读，空环境可能把旧环境覆盖掉。
        let workspaceSession = null;
        if (!floatWindow && deps.backend.GetPathInfo) {
            for (const target of targets) {
                if (!target || !target.path) continue;
                let info = null;
                try {
                    info = await deps.backend.GetPathInfo(target.path);
                } catch (e) {}
                if (info && info.isDir) {
                    workspaceSession = deps.readWorkspaceSession(info.path);
                    break;
                }
            }
        }
        await deps.openTargets(targets);
        if (workspaceSession) await deps.restoreSession(workspaceSession);
    } else {
        const files = await deps.backend.GetStartupFiles();
        if (files && files.length) await deps.openPaths(files);
        else {
            const sess = deps.readSession();
            if (sess) await deps.restoreSession(sess);
        }
    }
    if (floatWindow) {
        document.title = 'AI 助手 · CaDt-DataLens';
        if (!deps.aiPanel) deps.initAIPanel();
        if (deps.aiPanel) deps.aiPanel.open(true);
    } else {
        setTimeout(() => deps.autoCheckUpdateOnStart(), 2000);
        // 软切换新窗口：打开 AI 面板并选中目标会话（工作区已在上一步恢复）。
        if (startupAISession && deps.aiPanel && deps.aiPanel.bridgeListSessions) {
            try {
                if (deps.aiPanel.whenReady) await deps.aiPanel.whenReady();
            } catch (e) {}
            const session = deps.aiPanel.bridgeListSessions().find((item) => item.id === startupAISession);
            if (session && (!session.workspace || deps.sessionPathKey(session.workspace) === deps.sessionPathKey(deps.workspaceFolder))) {
                deps.aiPanel.open(true);
                try {
                    deps.aiPanel.bridgeSwitchSession(startupAISession);
                } catch (e) {}
            }
        }
    }
    try {
        if (deps.backend.ConsumeStartupSettings) {
            const pane = await deps.backend.ConsumeStartupSettings();
            if (pane) deps.openSettings(String(pane));
        }
    } catch (e) {}
})();


    return {createBgTermView, gitRootDir, gitStateCache, notifyAIGitEntry, openBgTermTab, openBrowserTab, openVirtualDoc, refreshGitStatus, showGitDiff};
}
