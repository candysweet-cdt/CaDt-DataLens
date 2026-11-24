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
 */

/** @type {readonly AppPage[]} */
export const APP_PAGES = [
    {id: 'usage-stats', label: '使用统计', icon: 'chart', group: '数据', desc: 'Token 用量、热力图、模型分布与请求日志'},
    {id: 'external-tools', label: '外部工具', icon: 'globe', group: 'AI', desc: 'AI 联网能力来源矩阵、服务提供商、MCP 服务器与桌面控制'},
    {id: 'agents', label: '智能体', icon: 'agents', group: 'AI', desc: '群聊（圆桌讨论）成员管理：模型绑定、人设与职责'},
    {id: 'cognition', label: '认知索引', icon: 'tree', group: 'AI', visibleWhen: 'aiCognition', desc: '浏览工作区认知索引：路径地图、条目 FRAS 详情与治理状态'},
    {id: 'schedules', label: '定时任务', icon: 'clock', group: '自动化', desc: '按时间自动触发会话，可查看下次运行与最近结果'},
    {id: 'activity', label: '操作记录', icon: 'history', group: '诊断', desc: '按月的操作留痕，可按来源与关键词筛选、导出'},
    {id: 'patches', label: '补丁库', icon: 'git', group: '开发', desc: '.cadt/patches 的补丁列表、审阅与删除'},
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
