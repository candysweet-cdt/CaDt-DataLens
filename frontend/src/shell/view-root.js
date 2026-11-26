// view-root.js：「当前根 / 视图跟随」域——从 main.js 拆出（2026-11-27 重构，main.js 超线治理）。
//
// ── 这域在讲什么 ──────────────────────────────────────────────────────────
// 应用里存在**两个不同的根**，混淆它们是这一轮多工作区改造中最高频的 bug 来源：
//
//   · 「窗口绑定的工作区」（主模块里的 workspaceFolder）
//       单工作区的真源。多工作区窗口**必须恒为空**——它是 activeSessionByWorkspace 的 key、
//       会话快照槽、scopeRootOf 兜底的判据，写进去会连环出错。
//   · 「当前在哪个目录」（本模块的 currentRoot()）
//       树 / 搜索 / git / 便签 / 终端 / Maven / 面包屑 / 标题栏… 只想知道这个。
//
// 单工作区下两者恰好相等；多工作区下前者为空、后者是**聚焦会话的工作区**（lastFocusedRoot）。
//
// ── 硬纪律 ────────────────────────────────────────────────────────────────
// 1. `applyViewRoot` 是多工作区下「根变了」的**唯一写入点**，且**绝不写 workspaceFolder**。
// 2. 任何「需要我在哪」的新代码调 `currentRoot()`，不要自己写 `workspaceFolder || (harness ? …)`。
// 3. 这条路径只做**轻活**（树换根、面包屑、标题、监听、git、便签、Maven 触发判定）。
//    重活（lifecycle 钩子、全量 applySettings、指纹扫描）归 openFolderWorkspace / switchRootLight
//    并按工作区去重——切会话不该触发它们。
//
// ── 为什么要有孤儿标记（viewRootOrphan）──────────────────────────────────
// 无根会话（沙盒 / 临时）切过来时树**保持不动**（清空更糟，用户会觉得「什么都没了」），
// 但名字照旧显示会让人以为会话绑在那个仓库上，所以要标一句「这是借来的根」。
//
// 状态位本身是易漏维护的东西（实测：同根短路分支忘了重置，标题栏长期挂错提示），
// 所以消费方（面包屑）改成「优先按面板当前会话现算，状态位只作面板未就绪时的兜底」。

import {isMultiWorkspace} from '../core/root-scope.js';

/**
 * @param {object} deps
 * @param {() => string|null} deps.windowWorkspace 窗口绑定的工作区（单工作区真源；多工作区恒空）
 * @param {() => any} deps.explorer 文件树（可能尚未创建）
 * @param {() => any} deps.aiPanel AI 面板（可能尚未创建）
 * @param {() => any} deps.mavenUi Maven 面板（可能尚未创建）
 * @param {() => void} deps.syncWorkspaceWatcher 跟随根换监听
 * @param {() => void} deps.renderWorkspaceCrumbs 重绘面包屑
 * @param {() => void} deps.updateWindowTitle 更新标题
 * @param {() => any} deps.refreshGitStatus 刷 git 状态（可能尚未接线）
 * @param {() => any} deps.memoWorkspaceChanged 便签作用域变更
 * @param {(level: string, msg: string) => void} deps.logFrontend 前端日志
 * @param {(path: any) => string} deps.sessionPathKey 路径比较键
 */
export function createViewRoot(deps) {
    // 视图跟随根：聚焦会话的工作区。**不写 workspaceFolder**（见文件头）。
    let lastFocusedRoot = '';
    // 重入闸门：跟随过程中内部会触发会话切换回调，不挡住会无限递归。
    let followingSessionWorkspace = false;
    // 「借来的根」标记：见文件头「为什么要有孤儿标记」。
    let viewRootOrphan = false;
    // 会话切换订阅只装一次（用模块内标记而不是挂在 aiPanel 上：面板对象若被 freeze，
    // 往它身上写标记会静默失败）。
    let sessionFollowInstalled = false;

    // 当前根：全应用「我在哪个目录」的唯一来源。
    function currentRoot() {
        // 多工作区优先：窗口不绑定工作区，workspaceFolder 按约定恒为空。万一某条旧路径把它
        // 写脏了（例如 openFolderWorkspace 被误调），也不能让它凌驾于视图根之上——否则
        // 面包屑与文件树会取到两个不同目录（实测：顶部徽标和树各显示一个仓库）。
        if (isMultiWorkspace()) return lastFocusedRoot || '';
        const ws = deps.windowWorkspace();
        return ws ? String(ws) : '';
    }

    // 把「树 / 面包屑 / 标题 / 监听 / git / 便签 / Maven」切到 root，**不写窗口绑定根**。
    // 返回是否真的换了根（false = 同根短路 / 无根保持原样 / 重入被挡）。
    function applyViewRoot(root, opts) {
        const next = String(root || '');
        if (deps.sessionPathKey(next) === deps.sessionPathKey(lastFocusedRoot)) {
            // 同根短路：树不用换。但 orphan 必须按这次调用重置——从「无工作区会话」切回
            // **同根**的普通会话时，next 与 lastFocusedRoot 相同会在这里提前返回，orphan
            // 停在 true，标题栏就一直挂着「当前会话没有工作区」（实测：树 / git 都对，
            // 只有这个标记错）。
            if (next && viewRootOrphan) {
                viewRootOrphan = false;
                deps.renderWorkspaceCrumbs();
            }
            return false;
        }
        if (followingSessionWorkspace) return false;
        // 空根：**保持现在的树不动**（会话沙盒 / 临时会话 / 未关联工作区）。
        // 清空树会让用户点几个会话后觉得「什么都没了」（实测反馈）。树的用途是浏览文件，
        // 无根会话本来就没有对应目录；AI 的工具根不受影响（它按会话自身解析）。
        if (!next) {
            if (opts && opts.logEmpty) deps.logFrontend('info', '[视图跟随] 会话无工作区，保留当前视图');
            viewRootOrphan = !!lastFocusedRoot;
            deps.renderWorkspaceCrumbs();
            return false;
        }
        lastFocusedRoot = next;
        viewRootOrphan = false;
        followingSessionWorkspace = true;
        try {
            deps.logFrontend('info', '[视图跟随] 切到 ' + next);
            const explorer = deps.explorer();
            if (explorer) {
                explorer.setMode('tree', false);
                explorer.setRoot(next);
            }
            deps.syncWorkspaceWatcher();
            deps.renderWorkspaceCrumbs();
            deps.updateWindowTitle();
            // git 分支跟着换：gitRootDir 读 currentRoot()，这里主动刷一次，别等 3 秒轮询。
            // try 包一层：refreshGitStatus 由 bridgeUI 解构（文件靠后），极端早期调用会踩 TDZ。
            try {
                const refreshGitStatus = deps.refreshGitStatus();
                if (typeof refreshGitStatus === 'function') {
                    Promise.resolve(refreshGitStatus()).catch(() => {});
                }
            } catch (e) { /* 接线尚未完成：定时器会在下一轮补上 */ }
            // 快捷便签：作用域根跟着换，丢弃旧仓库的缓存并重载打开中的「工作区」页签。
            try {
                const memoWorkspaceChanged = deps.memoWorkspaceChanged();
                if (typeof memoWorkspaceChanged === 'function') memoWorkspaceChanged();
            } catch (e) { /* 接线尚未完成 */ }
            // Maven 触发判定 / 依赖树缓存都与具体项目绑定（maven-panel 的 key = 当前根）。
            // 单工作区的 switchRootLight / openFolderWorkspace 都调了 syncTrigger，这条视图
            // 跟随路径曾漏掉：切到另一个仓库后图标仍是上一个仓库的判定，点开还按旧 cache 命中。
            try {
                const mavenUi = deps.mavenUi();
                if (mavenUi) mavenUi.syncTrigger();
            } catch (e) { /* 接线尚未完成 */ }
            // 不调 refreshSessionBadge：它会重绘会话列表、可能再触发会话切换回调 → 递归。
        } finally {
            followingSessionWorkspace = false;
        }
        return true;
    }

    // 把视图跟到某个会话的工作区。与 switchRootLight 的区别：**不写窗口绑定根**——
    // 多工作区窗口的窗口级工作区必须恒为空。AI 的工具根另由 sessionScopeRoot(session) 决定。
    function followSessionWorkspace(id) {
        if (!isMultiWorkspace()) return;
        const aiPanel = deps.aiPanel();
        if (!aiPanel) return;
        if (followingSessionWorkspace) return;
        const sess = aiPanel.bridgeListSessions
            ? aiPanel.bridgeListSessions().find((s) => s.id === id)
            : null;
        const root = sess && sess.workspace ? String(sess.workspace) : '';
        applyViewRoot(root, {logEmpty: true});
    }

    // 把视图跟到**当前**会话。followSessionWorkspace 只挂在「会话切换」回调上，而启动恢复
    // 是直接设 current、不经过通知，所以必须有这个主动入口，否则多工作区窗口重启后树是空的。
    function followActiveSession() {
        if (!isMultiWorkspace()) return false;
        const aiPanel = deps.aiPanel();
        if (!aiPanel || typeof aiPanel.bridgeListSessions !== 'function') return false;
        try {
            const active = aiPanel.bridgeListSessions().find((s) => s.active);
            if (!active) return false;
            followSessionWorkspace(active.id);
            return !!lastFocusedRoot;
        } catch (e) {
            console.debug('[视图跟随] 读取当前会话失败：' + ((e && e.message) || e));
            return false;
        }
    }

    // 订阅面板的会话切换（只装一次）。
    function installSessionFollow() {
        if (sessionFollowInstalled) return true;
        const aiPanel = deps.aiPanel();
        if (!aiPanel || typeof aiPanel.bridgeOnSessionSwitch !== 'function') {
            deps.logFrontend('warn', '[视图跟随] 面板未就绪或缺少 bridgeOnSessionSwitch，会话跟随未安装');
            return false;
        }
        sessionFollowInstalled = true;
        aiPanel.bridgeOnSessionSwitch((id) => followSessionWorkspace(id));
        return true;
    }

    return {
        currentRoot,
        applyViewRoot,
        followSessionWorkspace,
        followActiveSession,
        installSessionFollow,
        // 外部读写点：模式切换（切回单工作区要复用 lastFocusedRoot）、设置注入（getViewRoot）、
        // 面包屑兜底（viewRootOrphan）。用访问器而不是把裸 let 暴露出去——
        // 赋值统一走 setter，多一处写入就少一次「忘了同步」。
        get lastFocusedRoot() { return lastFocusedRoot; },
        set lastFocusedRoot(value) { lastFocusedRoot = String(value || ''); },
        get viewRootOrphan() { return viewRootOrphan; },
        set viewRootOrphan(value) { viewRootOrphan = !!value; },
    };
}
