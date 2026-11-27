// @ts-check
// tab-kinds.js：内容区虚拟标签页类型的单一来源。
//
// 「一切皆标签页」的落地约定：内容区里任何值得人看或操作的东西都是一个 doc、
// 占一个标签页。doc 分两类——
//   1. 文件标签页：path ≠ null（磁盘文件 / 未保存新文档）
//   2. 虚拟标签页：path === null，又分两族
//      · 视图型（本表登记的 7 类）：doc 上有标记位，createDocEditor 建自定义面板，
//        没有 doc.editor；本模块只回答「这是哪一类」，视图实现仍在各域（避免反向依赖）
//      · 文本型：openVirtualDoc 产出（untitled + viewKind），复用通用编辑器
//
// 放在 core/ 而不是 editor/：editor/ 与 bridge/ 是同级的两个域、互相不 import
// （见 AGENTS.md 依赖单向），而两边都要认这几类标签页——core/ 是它们共同的纯函数层。
//
// 新增一类虚拟标签页 = 本表加一项 + 各域写一个视图工厂 + （按需）补 bridge 创建点，
// 不再需要同步 createDocEditor / viewOptionsFor / buildGroupTab 图标链 / appTabViewOf
// 四个地方各自的 if 链（漏一处不会报错，只会静默降级）。
//
// 本模块是纯数据 + 纯函数：不下 DOM、不 import 任何域模块
// （唯一例外是 core/app-pages.js——它同样是纯数据表，同层不构成反向依赖）。

import {appPageOf} from './app-pages.js';

/**
 * @typedef {object} TabKind
 * @property {string} marker doc 上的标记位名（`doc.browser` / `doc.bgTerm` …）
 * @property {string} kind 类型名（AI workspace_context 的 kind、视图工厂分派键）
 * @property {string} icon core/icons.js 里注册的图标名
 * @property {string} label 人读标签（AI 的 openViews 描述用）
 * @property {(doc: Record<string, any>|null) => {icon?: string, label?: string}|null} [resolve]
 *   同一类型下要按 doc 细分图标 / 标签时提供（只有 appPage 用到：一个类型装 N 个功能页）
 */

/** @type {readonly TabKind[]} */
export const TAB_KINDS = [
    {marker: 'browser', kind: 'browser', icon: 'browser', label: '浏览器'},
    {marker: 'memo', kind: 'memo', icon: 'memo', label: '快捷便签'},
    {marker: 'bgTerm', kind: 'terminal', icon: 'terminal', label: '后台终端'},
    // 子代理详情与智能体团队共用「协作图」图标，两者是同一族视图
    {marker: 'agentView', kind: 'agent', icon: 'agents', label: '子代理详情'},
    {marker: 'agentTeam', kind: 'team', icon: 'agents', label: '智能体团队'},
    {marker: 'sideChat', kind: 'sidechat', icon: 'sidechat', label: '支线对话'},
    {marker: 'groupMember', kind: 'groupmember', icon: 'group', label: '群聊成员'},
    // 编排看板的独立标签页（也作为应用页面入口存在）：doc.orchestrationSpec 指定聚焦的编排。
    {marker: 'orchestration', kind: 'orchestration', icon: 'branch', label: '编排',
        resolve: (doc) => ({icon: 'branch', label: (doc && doc.orchestrationSpec && doc.orchestrationSpec.title) || '编排'})},
    // 应用页面（使用统计 / 外部工具 / 定时任务 / 操作记录 / 补丁库…）：一个类型按 doc.appPage 细分，
    // 图标与标签从 core/app-pages.js 的注册表取。视图工厂在 bridge 域。
    {marker: 'appPage', kind: 'apppage', icon: 'doc', label: '应用页面',
        resolve: (doc) => {
            const page = appPageOf(doc && doc.appPage);
            return page ? {icon: page.icon, label: page.label} : null;
        }},
    // 数据库（侧栏会话树打开，方案 §11.8）：数据表网格每表一个标签（表名做标签，
    // 图标按表/视图细分）；查询控制台每会话一个。视图工厂在 db 域。
    // marker 字段保持去重 key 字符串，域数据在 dbTableSpec / dbConsoleSpec（bridge 创建点）。
    {marker: 'dbTable', kind: 'dbTable', icon: 'view-table', label: '数据表',
        resolve: (doc) => {
            const t = doc && doc.dbTableSpec;
            if (!t) return null;
            return {icon: t.kind === 'view' ? 'eye' : 'view-table', label: t.table || doc.name};
        }},
    {marker: 'dbConsole', kind: 'dbConsole', icon: 'terminal', label: '查询控制台',
        resolve: (doc) => ({icon: 'terminal', label: (doc && doc.dbConsoleSpec && doc.dbConsoleSpec.title) || '查询控制台'})},
    // Redis 键查看器（方案 §11.13）：每个键一个标签；图标按值类型细分
    {marker: 'dbRedisKey', kind: 'dbRedisKey', icon: 'key', label: '键查看器',
        resolve: (doc) => {
            const t = doc && doc.dbRedisKeySpec;
            if (!t) return null;
            return {icon: 'key', label: t.key || doc.name};
        }},
];

/**
 * doc → 类型项；不是视图型虚拟标签页时返回 null。
 * @param {Record<string, any>|null} doc
 * @returns {TabKind|null}
 */
export function tabKindOf(doc) {
    if (!doc) return null;
    for (const spec of TAB_KINDS) {
        if (doc[spec.marker]) return spec;
    }
    return null;
}

/**
 * 是否屏蔽文件视图下拉（浏览器 / 终端 / 便签这类没有「文本 / 树 / 预览」可言）。
 * 文本型虚拟标签页（计划文档 / 差异）**不**屏蔽——.md 计划文档该有预览选项。
 * @param {Record<string, any>|null} doc
 */
export function suppressesViewOptions(doc) {
    return !!tabKindOf(doc);
}

/**
 * doc → 类型元信息（kind / icon / label），已应用 resolve 细分。
 * 不是视图型虚拟标签页时返回 null。
 * @param {Record<string, any>|null} doc
 * @returns {{kind: string, icon: string, label: string}|null}
 */
export function tabMetaOf(doc) {
    const spec = tabKindOf(doc);
    if (!spec) return null;
    const override = typeof spec.resolve === 'function' ? spec.resolve(doc) : null;
    return {
        kind: spec.kind,
        icon: (override && override.icon) || spec.icon,
        label: (override && override.label) || spec.label,
    };
}

/**
 * 标签图标名；不是视图型虚拟标签页时返回空串（调用方回落 createFileIcon）。
 * @param {Record<string, any>|null} doc
 */
export function tabIconName(doc) {
    const meta = tabMetaOf(doc);
    return meta ? meta.icon : '';
}

/**
 * 类型名 → 类型项；未知类型返回 null。
 * @param {string} kind
 * @returns {TabKind|null}
 */
export function tabKindByName(kind) {
    return TAB_KINDS.find((spec) => spec.kind === kind) || null;
}
