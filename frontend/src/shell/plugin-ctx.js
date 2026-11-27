// @ts-check
// plugin-ctx.js：插件回调上下文（ctx）的单一基座（纯函数，无 DOM，可单测）。
//
// 背景：插件有 8 个入口会回调插件代码（命令 / 视图 / 导入器 / 导出转换器 / AI 工具 /
// AI 上下文 / 设置面板 / 命令分类器），历史上各构造点各造一套 ctx，于是出现三个问题：
//   · 一半入口的 ctx 拿不到「我是谁」（pluginId / pluginName）；
//   · `source` 一名三义（导入器的 'open'、导出转换器的 'memo'、视图的 {path,name,size} 对象）；
//   · AI 上下文的 ctx 漏传 workspace（plugin-context.js 注释写着三件，实际只传了两件）。
//
// 本模块只做一件事：把「身份 + 位置」这几个每个入口都该有的键拼一次，各入口再用
// withCtx() 追加自己的域方法（requestSave / readTextFile / chooseSavePath / signal…）。
//
// **纪律：只加键，不改键。** 插件是市场分发的第三方代码，改名 / 换类型都是破坏性变更，
// 必须升大版本；要消歧就新增语义明确的键（如 origin / doc），旧键原样留着——插件读旧键
// 照常工作，新插件读新键不用猜。约定全文见 docs/plugins/README.md「插件回调上下文（ctx）」。
//
// 不归一化的边界（刻意）：registerFormat 的 parse / stringify 是纯函数（结构面板、表格、
// worker 都会调，可能不在主线程），不能挂宿主能力；registerDbDriver 的 connect(config)
// 是数据源配置；registerAIProvider 的 prepare(ctx) 是请求补丁上下文。三者语义都不属于
// 「插件在界面里干活」，硬塞基座只会多出永远为空的身份字段。

/** 入口来源：写进 ctx.origin，供插件区分「同一段代码被谁调用」。 */
export const PLUGIN_CTX_ORIGINS = Object.freeze({
    command: 'command',   // 命令（工具菜单 / 命令面板 / 编辑器右键 / 快捷键）
    editor: 'editor',     // 自定义视图（编辑器内渲染）
    open: 'open',         // 导入器（打开文件链）
    export: 'export',     // 文档导出转换器
    tool: 'tool',         // AI 工具（execute）
    prompt: 'prompt',     // AI 上下文（进系统提示词）
    settings: 'settings', // 插件专属设置面板
    classifier: 'classifier', // 命令风险分类器（classify）
});

/**
 * @typedef {object} PluginCtxBaseSpec
 * @property {string} [pluginId] 插件 id（缺省空串）
 * @property {string} [pluginName] 插件显示名（缺省回落 id）
 * @property {string} [workspace] 当前工作区根（绝对路径；没有工作区时为空串）
 * @property {string} [sessionId] 所属 AI 会话（非 AI 入口为空串）
 * @property {string} [origin] PLUGIN_CTX_ORIGINS 之一
 * @property {(message: any, isError?: any) => void} [flash] 提示能力；给了才注入
 */

/**
 * 拼 ctx 基座。`plugin` / `workspace` / `sessionId` / `origin` 四个键**恒存在**；
 * `flash` 只在调用方给到时注入——不给就是没有，逼各入口自己决定「这里该不该有提示能力」，
 * 而不是留一个静默空实现让插件误以为能用。
 * @param {PluginCtxBaseSpec} [spec]
 * @returns {Record<string, any>}
 */
export function pluginCtxBase(spec) {
    const src = spec && typeof spec === 'object' ? spec : {};
    const id = String(src.pluginId == null ? '' : src.pluginId).trim();
    const name = String(src.pluginName == null ? '' : src.pluginName).trim() || id;
    /** @type {Record<string, any>} */
    const ctx = {
        // 身份集中在这里：插件写跨入口共享的工具函数时直接读 ctx.plugin，不必各入口传一遍。
        // 只放 id / name 两个**各处都能拿到**的字段；安装目录仍走 cadt.getPluginDir()
        // ——那个 API 一直存在，把 dir 也塞进基座就得让 7 个注册表各自保存目录，
        // 而各入口拿到的记录里只有 id/name，不值这个钱。
        plugin: {
            id,
            name,
        },
        // 路径一律原样透传（不 trim、不规范化）：要与磁盘上的真实目录逐字一致。
        workspace: String(src.workspace == null ? '' : src.workspace),
        sessionId: String(src.sessionId == null ? '' : src.sessionId),
        origin: String(src.origin == null ? '' : src.origin),
    };
    if (typeof src.flash === 'function') {
        const flash = src.flash;
        /** @type {(message: any, isError?: any) => void} */
        const bound = (message, isError) => flash(message == null ? '' : String(message), !!isError);
        ctx.flash = bound;
    }
    return ctx;
}

/**
 * 在基座上追加域字段。extra 可以覆盖 workspace / sessionId / origin（域内更精确时以域为准），
 * 但 **plugin 恒取基座的**——身份不能被某个入口的域字段抹掉（否则 ctx.plugin.id 会随入口变空）。
 * @param {Record<string, any>} base pluginCtxBase 的返回值
 * @param {Record<string, any>} [extra] 该入口的域字段
 * @returns {Record<string, any>}
 */
export function withCtx(base, extra) {
    const merged = Object.assign({}, base && typeof base === 'object' ? base : {},
        extra && typeof extra === 'object' ? extra : {});
    if (base && base.plugin) merged.plugin = base.plugin;
    return merged;
}
