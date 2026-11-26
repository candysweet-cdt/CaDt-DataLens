// wipeguard-roots.js：工作区破坏防护的「多根监听」域——从 main.js 拆出（超线治理第 2 批）。
//
// ── 为什么主信号必须跟会话 ────────────────────────────────────────────────
// 一个窗口只开一路 WatchWorkspace（当前根），但多工作区下「切走」不等于「不看」：
// 用户切到 B 会话时，A 仓库里可能还有后台命令 / 子代理在跑，那里正好会发生最该报的删除。
// 所以切走时旧根**不立刻退订**，交给多根 watcher 继续盯，退订只发生在 LRU 淘汰或窗口关闭。
//
// ── 六个失效模式里有三个在这域（方案 §4.9.7 F2/F5/F6）──────────────────
//   F2 监听根不跟会话 → 主信号瞎，收不到当前会话根的删除
//   F5 告警冷却不分根 → A 根刚报过警，2 分钟内 B 根的真破坏被一起抑制
//   F6 单根 watcher    → 切走后旧根完全失明
// 这三条的共同点是「坏了不报错、只是该报警时没报警」，也是最难靠人眼发现的一类。
//
// ── 硬纪律 ────────────────────────────────────────────────────────────────
// · 监听根的来源**必须**是 currentWatchRoot()（会话根 > 树根 > 当前根），三处同源。
//   用裸窗口绑定根会让多工作区下退化成「无根」，监听静默失效。
// · 退订只走 release/unwatch 两个出口，不要在别处 delete 登记表——否则后端 watcher 会
//   继续盯着但前端不再认它，条目被下一次事件建回来，LRU 淘汰永远压不下去。

/**
 * @param {object} deps
 * @param {() => any} deps.backend Wails 后端（可能尚未就绪）
 * @param {() => any} deps.wipeguardCtrl 破坏防护控制器（在 main.js 4k 行处构造，故用 getter）
 * @param {() => string} deps.currentSessionScopeRoot 当前会话的作用域根（可能为空）
 * @param {() => any} deps.explorer 文件树
 * @param {() => string} deps.currentRoot 当前根（视图根）
 * @param {(ws: string) => string} deps.normalizeWsKey 工作区归一 key
 */
export function createWipeguardRoots(deps) {
    // 窗口自己的 WatchWorkspace 当前盯着的根（与下面多根表分开：同一棵树不开两路监听，
    // 否则每个文件事件都来两遍）。
    let watchedWorkspaceRoot = '';
    // 本窗口正在防扩的根（多根 watcher）：wsKey -> root。切走后旧根留在这里继续盯。
    const roots = new Map();
    // 告警投递冷却表：wsKey -> 上次投递时间。
    // 按根计而不是全局（方案 §4.9.7 F5）：A 根报过警不该让 B 根的真破坏静默 2 分钟。
    // 它原先只增不减（根被 LRU 淘汰后键仍留着），随历史工作区单调增长，所以在
    // release 时一并回收。
    const notifyAt = new Map();

    // 本窗口「当前根」：会话根优先（harness / 会话换手后），否则树根，否则视图根。
    // 兜底用 currentRoot() 而不是裸窗口绑定根——多工作区下后者恒空，会让前两级没命中时
    // （例如面板未初始化）退化成「无根」，监听静默失效。
    function currentWatchRoot() {
        const explorer = deps.explorer();
        return deps.currentSessionScopeRoot()
            || (explorer && explorer.getRoot ? explorer.getRoot() : '')
            || deps.currentRoot();
    }

    function watchWipeguardRoot(root) {
        const key = deps.normalizeWsKey(root);
        if (!key || roots.has(key)) return;
        roots.set(key, root);
        const ctrl = deps.wipeguardCtrl();
        if (ctrl) ctrl.trackRoot(root); // 条目 = 防护范围（LRU 与事件分流的依据）
        const backend = deps.backend();
        if (!backend) return;
        try {
            // 兼容：后端多根绑定由并发改造提供（WatchWipeguardRoot）；未就绪时退回既有的
            // WatchWorkspaceFor（同一内核 watcher，owner 独立，事件同样是 workspace-changed
            // 且带 removed / present 分组——破坏判定依赖这两个分组，不能换成只有 paths 的通道）。
            if (typeof backend.WatchWipeguardRoot === 'function') {
                Promise.resolve(backend.WatchWipeguardRoot(root)).catch(() => {});
            } else if (typeof backend.WatchWorkspaceFor === 'function') {
                Promise.resolve(backend.WatchWorkspaceFor('wipeguard|' + key, root)).catch(() => {});
            }
        } catch (e) {
            console.warn('[wipeguard] 多根监听注册失败（该根切走后将失去删除事件）', e);
        }
    }

    // 摘登记表 + 后端退订，**不回调控制器**（控制器淘汰条目时也走这里）。
    function releaseWipeguardWatch(root) {
        const key = deps.normalizeWsKey(root);
        if (!key || !roots.has(key)) return;
        roots.delete(key);
        // 投递冷却表同源清理：与监听槽一起回收，否则键随历史工作区单调增长。
        try { notifyAt.delete(key); } catch (e) { /* 尽力而为 */ }
        const backend = deps.backend();
        if (!backend) return;
        try {
            if (typeof backend.UnwatchWipeguardRoot === 'function') {
                Promise.resolve(backend.UnwatchWipeguardRoot(root)).catch(() => {});
            } else if (typeof backend.UnwatchWorkspaceFor === 'function') {
                Promise.resolve(backend.UnwatchWorkspaceFor('wipeguard|' + key)).catch(() => {});
            }
        } catch (e) {
            console.warn('[wipeguard] 多根监听退订失败（残留到窗口关闭）', e);
        }
    }

    // 显式退订：控制器条目一起摘（摘条目会回调 onRootEvicted → releaseWipeguardWatch）。
    function unwatchWipeguardRoot(root) {
        const ctrl = deps.wipeguardCtrl();
        if (ctrl && typeof ctrl.untrackRoot === 'function') ctrl.untrackRoot(root);
        else releaseWipeguardWatch(root);
    }

    // 文件监听跟随当前根；失败时静默降级到轮询。
    // 根优先取会话根（方案 §4.9.7 F2）：防护不能因为「这个窗口没登记工作区」就关掉。
    function syncWorkspaceWatcher() {
        const backend = deps.backend();
        if (!backend) return;
        const root = currentWatchRoot();
        const prev = watchedWorkspaceRoot;
        if (root !== prev) {
            watchedWorkspaceRoot = root;
            try {
                if (root && typeof backend.WatchWorkspace === 'function') backend.WatchWorkspace(root).catch(() => {});
                else if (!root && typeof backend.UnwatchWorkspace === 'function') backend.UnwatchWorkspace().catch(() => {});
            } catch (e) { /* 监听失败降级到轮询 */ }
            // 旧根**不立刻退订**：切走期间那里可能还在跑命令（长任务 / 后台子代理），
            // 失明就正好丢掉最该报的事件。交给多根 watcher 继续盯。
            if (prev) watchWipeguardRoot(prev);
        }
        // 当前根交给窗口自己的 WatchWorkspace（同一棵树不开第二路监听），但仍要登记进控制器：
        // 有条目才不会被 LRU 淘汰，事件分流也认它。
        if (root) {
            const ctrl = deps.wipeguardCtrl();
            if (ctrl) ctrl.trackRoot(root);
            releaseWipeguardWatch(root);
        }
    }

    // 告警投递冷却（按根）。**注意有副作用**：不在冷却期内时会顺手把 now 记进去，
    // 所以它不是一个纯查询——同一个 key 连续调两次，第二次必然返回 true。
    // 命名用 tryMark 而不是 isCoolingDown，就是要让调用方看出它「消耗」了一次额度。
    // 返回 true = 在冷却期内（调用方应当直接 return，不要投递）。
    function tryMarkNotify(key, now, cooldownMs) {
        if (now - (notifyAt.get(key) || 0) < cooldownMs) return true;
        notifyAt.set(key, now);
        return false;
    }

    // 窗口关闭：本窗口挂的多根监听一并退订。后端按窗口名收口只摘窗口自己的槽位，
    // wipeguard 用的是独立 owner 名（wipeguard|key），需要前端显式收。
    function installPagehideCleanup() {
        window.addEventListener('pagehide', () => {
            for (const root of Array.from(roots.values())) releaseWipeguardWatch(root);
        }, {once: true});
    }

    return {
        syncWorkspaceWatcher,
        currentWatchRoot,
        watchWipeguardRoot,
        releaseWipeguardWatch,
        unwatchWipeguardRoot,
        tryMarkNotify,
        installPagehideCleanup,
        // 只读快照：诊断 / 测试用（不要拿它去改表，改动一律走上面的函数）
        get watchedRoot() { return watchedWorkspaceRoot; },
        get watchedRoots() { return Array.from(roots.values()); },
        hasRoot(keyOrRoot) { return roots.has(deps.normalizeWsKey(keyOrRoot)); },
    };
}
