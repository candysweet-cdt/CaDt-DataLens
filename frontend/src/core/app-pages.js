// @ts-check
// app-pages.js：应用页面注册表——「可以开成内容区标签页的功能页」的单一来源。
//
// 「一切皆标签页」的第二族：第一族是「一个具体业务对象」（一个子代理、一条会话、一个便签面板），
// 这一族是「一个功能页面」（使用统计、定时任务…）。它们原本嵌在设置对话框里，但本质是
// 浏览 / 管理数据的重面板——要长时间停留、要看大量内容、要能和别的标签页并列对照，
// 被模态框困住只会「关掉就丢状态」。
//
// 本表只回答「有哪些页、叫什么、什么图标、怎么分组」；**内容渲染仍归原域**
// （settings/settings-pane-usage-stats.js 等），避免 core/ → 域 的反向依赖。
// 视图工厂在 bridge/bridge-app-page-view.js，按 id 分派到各域的 mount。
//
// 新增一个应用页面 = 本表加一项 + 该域提供 mount(root) 入口 + 视图工厂登记一行。

/**
 * @typedef {object} AppPage
 * @property {string} id 稳定标识（也是 doc.appPage 的取值）
 * @property {string} label 人读名（标签页标题、菜单项、AI 上下文）
 * @property {string} icon core/icons.js 注册的图标名
 * @property {string} group 菜单里的分组（同组连排，组间加分隔线）
 * @property {string} desc 一句话说明（设置页目录行、菜单提示）
 * @property {string} [visibleWhen] 可选：关联的 settings 布尔键名。给出时仅当
 *   settings[key] === true 才进各入口（appPageGroups 的统一漏斗，调用方须传 settings）；
 *   appPageOf 不过滤——已开的标签页在开关关掉后仍要能 resolve 图标与标题。
 * @property {boolean} [perWorkspace] 可选：数据属于**单个工作区**（如 .cadt/cognition、
 *   .cadt/patches）。给出时标签页按工作区去重——同一页可以同时开多个，各绑一个仓库，
 *   标签名带上仓库名。不给出 = 全局数据页，全应用只有一个实例。
 */

/** @type {readonly AppPage[]} */
// group 名刻意不与设置侧栏 section（界面与编辑 / 安全与权限 / 集成与自动化 / 维护与诊断）撞名：
// 同一词在两处指代不同集合会让用户困惑。这里按「页面对象」命名，侧栏按「作用域」命名。
export const APP_PAGES = [
    {id: 'usage-stats', label: '使用统计', icon: 'chart', group: '统计', desc: 'Token 用量、热力图、模型分布与请求日志'},
    // 编排：跨会话按依赖图执行的生产线（不是群聊讨论、也不是子代理临时工）。
    // 看板是长时间停留、要并列对照的重面板，因此是一个应用页面 + 独立虚拟标签族。
    {id: 'orchestration', label: '编排', icon: 'branch', group: 'AI 工具', perWorkspace: true, desc: '按工作区的批次依赖、文件所有权、验收/终审与仲裁生产线'},
    {id: 'external-tools', label: '外部工具', icon: 'globe', group: 'AI 工具', desc: 'AI 联网能力来源矩阵、服务提供商、MCP 服务器与桌面控制'},
    {id: 'agents', label: '智能体', icon: 'agents', group: 'AI 工具', desc: '群聊（圆桌讨论）成员管理：模型绑定、人设与职责'},
    // 认知索引 / 补丁库的数据物理上就在各个工作区里（.cadt/cognition、.cadt/patches），
    // 所以按工作区开多份才有意义——用户能并排看两个仓库的索引，而不是来回切换再点刷新。
    {id: 'cognition', label: '认知索引', icon: 'tree', group: 'AI 工具', visibleWhen: 'aiCognition', perWorkspace: true, desc: '浏览工作区认知索引：路径地图、条目 FRAS 详情与治理状态'},
    {id: 'schedules', label: '定时任务', icon: 'clock', group: '定时', desc: '按时间自动触发会话，可查看下次运行与最近结果'},
    {id: 'activity', label: '操作记录', icon: 'history', group: '记录', desc: '按月的操作留痕，可按来源与关键词筛选、导出'},
    {id: 'patches', label: '补丁库', icon: 'git', group: '补丁', perWorkspace: true, desc: '.cadt/patches 的补丁列表、审阅与删除'},
];

/**
 * 按 id 取页面元数据；未知 id 返回 null。
 * @param {string} id
 * @returns {AppPage|null}
 */
export function appPageOf(id) {
    const key = String(id || '');
    return APP_PAGES.find((page) => page.id === key) || null;
}

/**
 * 计算应用页面标签页的标题。
 *
 * 全局页恒为页面名；perWorkspace 页在多工作区下带仓库名——同一个「认知索引」可能开着两三份，
 * 标题不带仓库名就分不清哪个是哪个。单工作区不加后缀（只有一个仓库，加了是噪音）。
 * @param {AppPage|null} page
 * @param {string} workspaceRoot 该标签绑定的工作区
 * @param {boolean} multi 当前是否多工作区窗口
 * @returns {string}
 */
export function appPageTabTitle(page, workspaceRoot, multi) {
    const label = page ? page.label : '';
    if (!page || !page.perWorkspace || !multi) return label;
    const base = String(workspaceRoot || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop();
    return base ? label + ' · ' + base : label;
}

/**
 * 按注册表顺序分组（菜单 / 设置页目录共用同一份分组结果）。
 * @param {Record<string, any>} [settings] 当前设置对象（活引用即可，调用时现取值）；
 *   传了才对带 visibleWhen 的页面做条件过滤，不传时条件页一律隐藏。
 * @returns {{group: string, pages: AppPage[]}[]}
 */
export function appPageGroups(settings) {
    const out = [];
    for (const page of APP_PAGES) {
        if (page.visibleWhen && !(settings && settings[page.visibleWhen] === true)) continue;
        const last = out[out.length - 1];
        if (last && last.group === page.group) last.pages.push(page);
        else out.push({group: page.group, pages: [page]});
    }
    return out;
}
