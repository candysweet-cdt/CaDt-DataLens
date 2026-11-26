// bridge-ui.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// 进程桥 / 虚拟文档 / 浏览器标签；后台终端视图、git 浅集成、CLI 转换已拆到同目录兄弟模块。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {loadPlugins} from '../shell/plugins.js';
import {createVirtualTabDoc} from '../core/virtual-tab-doc.js';
import {createBridgeCliConvert} from './bridge-cli-convert.js';
import {createBridgeGit} from './bridge-git.js';
import {createBridgeTerminalView} from './bridge-terminal-view.js';
import {createBridgeAgentView} from './bridge-agent-view.js';
import {createBridgeTeamView} from './bridge-team-view.js';
import {createBridgeSideChat} from './bridge-sidechat-view.js';
import {createBridgeGroupMemberView} from './bridge-group-member-view.js';
import {createBridgeMemoView} from './bridge-memo-view.js';
import {createBridgeAppPageView} from './bridge-app-page-view.js';
import {createBridgeDatabaseView} from './bridge-database-view.js';

export function createBridgeUI(deps) {

const termMod = createBridgeTerminalView(deps);
const agentMod = createBridgeAgentView(deps);
// 智能体团队详情标签页：doc.agentTeam = 会话 id（正文渲染在面板 ai-team-view.js）
const teamMod = createBridgeTeamView(deps);
const sideChatMod = createBridgeSideChat(deps);
// 群聊成员详情标签页：doc.groupMember = groupId:agentId；正文渲染在 ai/group/ai-group-member-view.js
const groupMemberMod = createBridgeGroupMemberView(deps);
// 快捷便签面板：虚拟标签页 + 数据 store（AI 经 app_control memo 动作走同一套变更通路）
const memoMod = createBridgeMemoView(deps);
// 应用页面标签页：使用统计 / 定时任务 / 操作记录 / 补丁库（清单在 core/app-pages.js）
const appPageMod = createBridgeAppPageView(deps);
// 数据库连接标签页：侧栏「数据库」面板双击工作区条目打开（一个标签 = 一个库会话，视图在 db 域）
const databaseMod = createBridgeDatabaseView(deps);
// git 域要开虚拟文档标签：经 Object.create 委托原 deps（保持 getter 惰性），只补一个宿主函数
const gitDeps = Object.create(deps);
gitDeps.openVirtualDoc = openVirtualDoc;
const gitMod = createBridgeGit(gitDeps);
const cliMod = createBridgeCliConvert(deps);

// opts：readOnly（标签页只读锁）、readOnlyFixed（固定只读、不可解锁）、
// patchReview（只读审阅快照）、reviewNotes（无差异文件说明）、
// onChange（可选：文档内容变更时把最新文本推回宿主，见 editor-groups.js 的 markDocDirty）
function openVirtualDoc(name, content, opts) {
    const options = opts || {};
    const fixed = !!options.readOnlyFixed;
    const doc = deps.createDoc({
        path: null,
        name,
        content,
        size: content.length,
        eol: 'lf',
        hasBom: false,
        large: false,
        enc: 'utf-8',
        readOnly: !!(options.readOnly || fixed),
        readOnlyFixed: fixed,
        patchReview: !!options.patchReview,
        reviewNotes: options.reviewNotes || [],
    });
    doc.untitled = true;
    // 视图类型（plan / diff / document）：只供 AI 的 workspace_context 区分「应用内视图」
    // 与「工作区文件」——虚拟文档没有路径，混进已打开文件会被显示成「（范围外）xxx」
    doc.viewKind = options.viewKind || 'document';
    // 可选的内容变更回调：编辑虚拟文档时把最新文本推回宿主（如粘贴胶囊编辑回写）。
    // 触发点在 editor-groups.js 的 markDocDirty（紧挨 pluginViewNotify）。
    if (typeof options.onChange === 'function') doc.virtualDocOnChange = options.onChange;
    deps.docs.push(doc);
    deps.activateDoc(doc);
    return doc;
}

// ===== 浏览器使用标签页 =====
let browserSeq = 0;

// 个人浏览器：固定实例 id ⇒ Go 侧 user data 目录固定（BrowserSessions/browser-user_user），
// cookie / 登录态随磁盘保留（关标签再开、重启应用都还在）。
// 任何时刻只允许一个实例：WebView2 规定同一个 user data folder 不能被两个 environment
// 同时使用，而每个实例各自建一个 environment——多开必然第二个初始化失败。
const PERSONAL_BROWSER_ID = 'browser-user';

function openBrowserTab(url, profileKey, opts) {
    const target = (url || '').trim() || 'about:blank';
    const personal = !!(opts && opts.personal);
    if (personal) {
        // 已开着就切过去（带地址时顺带导航），不重复建实例
        const opened = deps.docs.find((d) => d.browser && d.id === PERSONAL_BROWSER_ID);
        if (opened) {
            deps.activateDoc(opened);
            if (target !== 'about:blank' && deps.backend.BrowserNavigate) {
                opened.browserUrl = target;
                if (opened.browserAddr) opened.browserAddr.value = target;
                deps.backend.BrowserNavigate(opened.id, target).catch(() => {});
                // 已开着再导航 = 地址变了，同步进恢复列表
                if (deps.browserTabRestore) deps.browserTabRestore.notePersonalOpened(target);
            }
            return opened;
        }
    }
    browserSeq += 1;
    const doc = createVirtualTabDoc({
        id: personal ? PERSONAL_BROWSER_ID : 'browser-' + Date.now().toString(36) + '-' + browserSeq,
        name: personal ? '我的浏览器' : (target !== 'about:blank' ? target : '新标签页'),
        format: {id: 'browser', name: '网页', extensions: [], aceMode: 'text', rawOnly: true},
        mode: 'browser',
        marker: 'browser',
        key: true,
        extra: {
            // 个人浏览器（持久 profile）标记：新建标签页永远是隔离会话，两者语义不同
            browserPersist: personal,
            browserUrl: target,
            browserProfile: personal ? 'user' : (profileKey || ''),
        },
    });
    deps.docs.push(doc);
    deps.addDocToFocusedGroup(doc);
    deps.activateDoc(doc);
    // 注意：建标签这里不通知恢复模块——写权要等实例确认打开成功（onOpened）再置位，
    // 打开失败回滚（closeDocNow）才不会把（可能是别的窗口写下的）存档抹掉。
    if (!deps.backend.BrowserOpen) {
        deps.flash('当前环境不支持内嵌浏览器', true);
        return doc;
    }
    const profileForOpen = doc.browserProfile || 'tab-' + doc.id;
    const onOpened = (info) => {
        // 流事件归属：browser-nav/title/error 定向投本窗口（打开完成前的竞态事件走广播兜底）
        if (deps.backend.RegisterEventOwner) {
            Promise.resolve(deps.backend.RegisterEventOwner('browser', doc.id)).catch(() => {});
        }
        if (info && info.title) deps.updateBrowserTitle(doc, info.title);
        if (doc.browserEmpty) {
            doc.browserEmpty.remove();
            doc.browserEmpty = null;
        }
        deps.syncBrowserTab(doc);
        // 实例确认打开成功：个人浏览器标签落恢复列表（普通临时标签不参与恢复，
        // 见 shell/browser-tab-restore.js 的写权不变量）
        if (doc.browserPersist && deps.browserTabRestore) {
            deps.browserTabRestore.notePersonalOpened(target);
        }
    };
    // 个人浏览器关掉后立刻重开：上一个 WebView2 浏览器进程可能还没退干净、同一 user data
    // 目录短暂被占，补一次重试（约 0.8s），别让「记住登录」的入口动辄弹打开失败。
    // browserOpenPromise：把创建完成暴露给等待方（AI 的 open_browser_tab 宿主动作）。
    // 之前完全 fire-and-forget，AI 拿到 id 立刻 BrowserNavigate——两个绑定调用在 Go 侧
    // 并发排队，导航任务先到就命中「不存在或未就绪」守卫，模型只能重试一次白烧 token
    // （2026-11-16）。约定：promise resolve ⇒ Go 侧 BrowserOpen 已返回、webview 已就绪。
    const runOpen = (retryLeft) => deps.backend.BrowserOpen(doc.id, target, profileForOpen).then(onOpened).catch((e) => {
        if (doc.browserPersist && retryLeft > 0 && deps.docs.includes(doc)) {
            return new Promise((resolve) => setTimeout(resolve, 800)).then(() => runOpen(retryLeft - 1));
        }
        const stack = String((e && e.stack) || '').split(String.fromCharCode(10)).slice(0, 4).join(' | ');
        deps.flash('浏览器标签页打开失败：' + ((e && e.message) || e) + ' @ ' + stack, true);
        deps.closeDocNow(doc, false);
        throw e; // 等待方要拿到确定失败；fire-and-forget 侧另行兜底吞掉 rejection
    });
    doc.browserOpenPromise = runOpen(doc.browserPersist ? 1 : 0);
    doc.browserOpenPromise.catch(() => {});
    return doc;
}


(async () => {
    if (await cliMod.maybeRunConvertJob()) return;
    // 独立调试控制台窗口：只渲染控制台面板，跳过正常的应用启动流程
    if (await deps.consoleWindowMode) {
        deps.startConsoleWindowMode();
        return;
    }
    // 终端独立窗口：全屏渲染一个已存在的终端会话，同样跳过正常启动流程
    if (await deps.terminalWindowMode) {
        Promise.resolve(deps.startTerminalWindowMode())
            .catch((e) => {
                try { deps.logFrontend('error', '终端窗口启动失败：' + ((e && (e.stack || e.message)) || e)); } catch (_) {}
            });
        return;
    }
    // 辅助独立窗（便签 / 会话监控 / 文件对比 / 轻量查看 / 实时预览）：同构终端窗，各渲染自己的单一视图
    const auxKind = await deps.auxWindowKind;
    if (auxKind === 'memo' || auxKind === 'monitor' || auxKind === 'diff' || auxKind === 'light' || auxKind === 'preview') {
        const starter = auxKind === 'memo' ? deps.startMemoWindowMode
            : auxKind === 'monitor' ? deps.startMonitorWindowMode
            : auxKind === 'diff' ? deps.startDiffWindowMode
            : auxKind === 'light' ? deps.startLightWindowMode : deps.startPreviewWindowMode;
        const label = {memo: '便签', monitor: '会话监控', diff: '文件对比', light: '轻量查看', preview: '实时预览'}[auxKind];
        Promise.resolve(starter())
            .catch((e) => {
                try { deps.logFrontend('error', label + '窗口启动失败：' + ((e && (e.stack || e.message)) || e)); } catch (_) {}
            });
        return;
    }
    // 浮窗探测已在 main.js 顶层与其他窗口类型探测并行发出，这里直接取结果，
    // 不再串行 await 一次 IPC（缩短 app-booting 摘除前的等待）。
    let floatWindow = false;
    try {
        floatWindow = !!(await deps.aiFloatWindowMode);
    } catch (e) {
        floatWindow = false;
    }
    if (!floatWindow && !deps.hasWails && deps.mockScenario.has('aifloat')) floatWindow = true;
    // harness 窗口（--harness）：不恢复上次工作区，AI 面板就是它的主界面。
    // 探测失败一律按普通窗口处理（老宿主没有这条绑定）。
    let harnessWindow = false;
    if (!floatWindow) {
        try {
            harnessWindow = deps.backend.GetWindowHarness ? !!(await deps.backend.GetWindowHarness()) : false;
        } catch (e) {
            harnessWindow = false;
        }
        // 命令行没给 --harness 时，恢复上次关闭时的窗口模式（关闭时是多工作区 → 这次还是）。
        // 显式 --harness 优先：用户明确指定的形态不该被上次的记忆覆盖。
        if (!harnessWindow && typeof deps.restoreWindowMode === 'function') {
            try {
                harnessWindow = !!deps.restoreWindowMode();
            } catch (e) {
                harnessWindow = false;
            }
        }
    }
    if (harnessWindow) {
        // 供 ai-session-scope.js 的 scopeRootOf 第 3 步判断（harness 下未绑定会话 = 无根），
        // 也供 session-restore.js 选独立快照槽。
        window.__harnessWindow = true;
        // 标题栏的模式 chip 要跟着变：main.js 顶层的初始渲染早于这里（那时标记还没置位），
        // 所以置位后必须再刷一次，否则多工作区窗口会显示成「单工作区」。
        try {
            if (typeof deps.renderWindowMode === 'function') deps.renderWindowMode();
        } catch (e) { /* 渲染失败不影响启动 */ }
    }
    if (floatWindow) {
        window.__aiFloatWindow = true;
        document.documentElement.classList.remove('app-booting');
        document.body.classList.add('ai-float-window');
        document.title = 'AI 助手 · CaDt-DataLens';
    } else {
        // 普通窗口：模式已定，解除首帧隐藏
        document.documentElement.classList.remove('app-booting');
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
                deps.setSyncedOpenMode(mode);
                deps.applySettings();
            }
        } catch (e) {}
    }
    // 关闭行为（点 X 直接退出 / 最小化到托盘）：真相在 config.json，回读一次覆盖本机
    // localStorage，免得换了窗口或清了缓存后设置页显示与后端实际行为不一致。
    if (deps.backend.GetCloseAction) {
        try {
            const action = await deps.backend.GetCloseAction();
            if (action === 'tray' || action === 'exit') {
                deps.settings.closeAction = action;
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
    let startupMemoLocator = '';
    if (deps.backend.GetStartupMemoLocator) {
        try {
            startupMemoLocator = await deps.backend.GetStartupMemoLocator() || '';
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
        // harness 窗口不读这份环境（目标目录照常打开，但不去拉该目录上次的标签/布局）。
        let workspaceSession = null;
        if (!floatWindow && !harnessWindow && deps.backend.GetPathInfo) {
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
            // harness 窗口恢复**自己的**快照槽（cadt.session.harness.v1，session-restore 的
            // sessionKeyOf 按 __harnessWindow 选槽）。跳过的是「窗口工作区 / 目标目录」的
            // 环境（上面那一段），不是「任何标签」——否则每次开 harness 都是空窗。
            const sess = deps.readSession();
            if (sess) await deps.restoreSession(sess);
        }
    }
    // 个人浏览器标签恢复（P0，docs/finished-plans/browser-tab-restore.md）：文件标签先
    // 恢复，再恢复网页；仅主窗口（悬浮窗 / 独立窗在上面已分流）。BrowserOpen 本就是
    // 异步的，实例目录被占时靠 openBrowserTab 内置的重试兜底。
    if (!floatWindow && deps.browserTabRestore) {
        try {
            await deps.browserTabRestore.restoreOnStartup();
        } catch (e) {
            deps.logFrontend('warn', '个人浏览器恢复失败：' + ((e && (e.stack || e.message)) || e));
        }
    }
    if (floatWindow) {
        document.title = 'AI 助手 · CaDt-DataLens';
        if (!deps.aiPanel) deps.initAIPanel();
        if (deps.aiPanel) deps.aiPanel.open(true);
    } else {
        setTimeout(() => deps.autoCheckUpdateOnStart(), 2000);
        // harness 窗口没有工作区、标签页是空的：AI 面板就是它的主界面，直接打开
        //（与浮窗同款 initAIPanel + open(true)，但保留主窗口的其余行为）。
        if (harnessWindow) {
            if (!deps.aiPanel) deps.initAIPanel();
            if (deps.aiPanel) deps.aiPanel.open(true);
        }
        // 软切换新窗口：打开 AI 面板并选中目标会话（工作区已在上一步恢复）。
        if (startupAISession && deps.aiPanel && deps.aiPanel.bridgeListSessions) {
            try {
                if (deps.aiPanel.whenReady) await deps.aiPanel.whenReady();
            } catch (e) {}
            const session = deps.aiPanel.bridgeListSessions().find((item) => item.id === startupAISession);
            // 判据是「会话归属本窗口」＝**窗口绑定**的工作区语义，必须用真值
            // （deps.workspaceFolder 已注入为 currentRoot()，多工作区下是聚焦会话的仓库，
            // 用它会让 --ai-session 在多工作区窗口里永远匹配不上）。多工作区窗口没有绑定，
            // 只要能找到该会话就直接切过去——视图跟随会由 followSessionWorkspace 处理。
            const bound = typeof deps.boundWorkspaceFolder === 'function'
                ? deps.boundWorkspaceFolder()
                : deps.workspaceFolder;
            const owned = !bound || !session || !session.workspace ||
                deps.sessionPathKey(session.workspace) === deps.sessionPathKey(bound);
            if (session && owned) {
                deps.aiPanel.open(true);
                try {
                    await deps.aiPanel.bridgeSwitchSession(startupAISession);
                } catch (e) {}
            }
        }
        // 多工作区窗口：把视图跟到**恢复出来的当前会话**。
        // 缺这一步的后果（实测）：重启后模式是多工作区、会话也恢复了，但文件树是空的、
        // 面包屑「未打开文件」——因为 followSessionWorkspace 只挂在会话切换回调上，
        // 而启动恢复是直接设 current、不经过切换通知。
        if (harnessWindow && typeof deps.followActiveSession === 'function') {
            try {
                if (deps.aiPanel && deps.aiPanel.whenReady) await deps.aiPanel.whenReady();
                deps.followActiveSession();
            } catch (e) { /* 跟随失败不影响启动 */ }
        }
        // 快捷便签定位点：CLI --memo 启动直达（工作区已恢复，memoApi 自己处理作用域切换）
        if (startupMemoLocator && memoMod.memoApi && memoMod.memoApi.jumpToLocator) {
            try {
                await memoMod.memoApi.jumpToLocator(startupMemoLocator);
            } catch (e) {
                // 用户显式传了 --memo，失败必须留痕（静默失败会让人以为参数没生效）
                console.warn('[startup] --memo 定位失败', e);
            }
        }
    }
    try {
        if (deps.backend.ConsumeStartupSettings) {
            const pane = await deps.backend.ConsumeStartupSettings();
            if (pane) deps.openSettings(String(pane));
        }
    } catch (e) {
        // 同上：--open-settings=<pane> 是用户显式指定的启动参数
        console.warn('[startup] --open-settings 处理失败', e);
    }
})();


    return {
        ...termMod, ...agentMod, ...teamMod, ...sideChatMod, ...groupMemberMod, ...memoMod, ...appPageMod, ...databaseMod, ...gitMod, ...cliMod,
        openBrowserTab, openVirtualDoc,
    };
}
