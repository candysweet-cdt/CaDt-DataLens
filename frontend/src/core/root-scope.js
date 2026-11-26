// @ts-check
// root-scope.js：「当前根 / 窗口模式」的**唯一判定入口**。
//
// ── 为什么需要这个模块 ────────────────────────────────────────────────────
// 「多工作区模式」与「根」的判定原先散落在 6 个文件、42 处（`window.__harnessWindow`），
// 加上 ai-panel 里 25 处 `currentWorkspacePath()`。每个判断点都要自己考虑多工作区分支，
// 漏一处就是**长期静默失效**——不报错、不显眼，只是某个功能悄无声息地不工作。
//
// 实测踩到的一串（2026-11-26，全部同源）：
//   1. 窗口 workspaceFolder 被写脏 → 顶部徽标与文件树显示两个不同仓库
//   2. currentRoot 优先级错 → 脏值凌驾于视图根
//   3. isSessionLocal 在多工作区恒假 → 定时任务 / 计时器 / 生成任务全部送不达
//   4. scheduleListCache 不刷新 → 头部定时胶囊永久隐藏
//   5. viewRootOrphan 漏重置 → 标题栏长期挂着「当前会话没有工作区」
//   6. Git 快捷操作按钮永久隐藏（注入裸 currentWorkspacePath）
//   7. main.js 8 处注入裸 workspaceFolder → 认知索引页必然报错、群聊工具禁用等
//
// 结论：**判定必须唯一实现，读取必须收口**。本模块就是那个唯一实现。
//
// ── 设计约束 ──────────────────────────────────────────────────────────────
// core/ 不能持有应用状态（那是 main.js 的事），也不能 import 域模块。所以这里
// 只放「可注入的探针」：main.js 在启动时调 configureMultiProbe 注入真实判定，
// 其余模块一律经 isMultiWorkspace() 读取。
//
// 为什么不直接用 window.__harnessWindow：
//   · 它是全局可写字符串魔法值，谁都能改、谁都能读，没有任何约束；
//   · 42 处直接读意味着「模式怎么判」有 42 个副本在脑子里；
//   · 将来换成「多根窗口 / 部分工作区」等新形态时，要改 42 个地方。
//
// 守卫：test/core/root-scope-guard.test.mjs 禁止 core/ 之外直接读 __harnessWindow。

/**
 * 默认探针：直接读全局标记。
 * 这样即使宿主忘了注入（或某个模块被单独加载 / 测试直接 import），判定仍然正确——
 * 静默退化成「单工作区」是更糟的失败方式（功能会莫名其妙消失，还不报错）。
 * configureMultiProbe 的价值在于「可替换实现」（将来换多根窗口等形态时只改注入处）。
 * @type {() => boolean}
 */
let multiProbe = () => {
    if (typeof window === 'undefined') return false;
    // __harnessWindow 是运行时挂到 window 上的标记，不在 TS 的 Window 类型里
    return !!(/** @type {any} */ (window).__harnessWindow);
};

/**
 * 注入「当前是否多工作区窗口」的判定。**只应由 main.js 在启动时调用一次。**
 * 重复调用以最后一次为准（测试里会来回切）。
 * @param {() => boolean} probe
 */
export function configureMultiProbe(probe) {
    multiProbe = typeof probe === 'function' ? probe : () => false;
}

/**
 * 当前窗口是否多工作区模式（不绑定单个目录，AI 会话各自带 workspace）。
 *
 * 所有需要区分模式的代码只应调用本函数，不要读 `window.__harnessWindow`——
 * 那个全局变量的读写点应当是「设置它的人」与「注入 probe 的人」，各一处。
 * @returns {boolean}
 */
export function isMultiWorkspace() {
    try {
        return !!multiProbe();
    } catch (e) {
        // 探针抛错（宿主还没就绪）：按单工作区处理 = 旧行为，不会把功能关掉
        return false;
    }
}

/**
 * 会话是否有工作区归属。三态，**不要用真值判断代替**：
 *   true  → 会话绑定了一个真实仓库
 *   false → 会话沙盒 / 临时会话 / 未关联（合法状态，不是错误）
 *   null  → 问不到（宿主未就绪 / 参数缺失），调用方自行决定回落
 *
 * 为什么要三态：`!session.workspace` 把「确实没有」和「问不到」混成一件事，
 * 前者要隐藏/提示，后者应回落到别处，混用会做出错误决定（实测：标题栏提示长期挂错）。
 * @param {{workspace?: string}|null|undefined} session
 * @returns {boolean|null}
 */
export function sessionHasWorkspace(session) {
    if (!session || typeof session !== 'object') return null;
    return !!String(session.workspace || '').trim();
}
