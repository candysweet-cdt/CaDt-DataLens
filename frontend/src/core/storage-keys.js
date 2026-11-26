// @ts-check
// core/storage-keys.js：持久化键名的唯一登记处（localStorage 键 + 动态键构造器）。
//
// 为什么集中：改造前同一件事有四种命名风格并存——`datalens-xxx`、`cadt.xxx.v1`、
// `cadt-xxx`，还有一批无前缀的 camelCase。散落的真实代价不是「不好看」，而是
// 「按名单枚举键」的地方永远对不全：设置页清缓存、仓库外数据清理、导出、重置、
// 多窗口间的认领标记，各写各的字面量，加一个键就要在 N 个地方补一次。
//
// 边界（别在这里扩张）：
//   - 这里只登记**键名字面量**与**键名构造器**。读取/写入的容错（隐私模式抛错、配额满）
//     仍归 core/kv-store.js——那层刻意不认识任何业务键，也不做清理/过期策略。
//   - camelCase 的**设置字段**（如 dbWorkspaceDatabases / runActiveProfile）不是 localStorage
//     键，它们住在 SETTINGS_KEY 那一份快照里，不登记在这。
//   - 只有名字长得像键的东西更不登记：技能名（cadt-ui / cadt-gen-models）、CSS 类
//     （cadt-cmpl-icon）、对话框默认文件名（cadt-ai-config.json）、窗口事件名
//     （cadt-plugins-loaded）、插件组织名（cadt-datalens-plugins）、id 前缀（newId('datalens-')）。
//     守卫 test/core/storage-key-guard.test.mjs 逐条列了这些同前缀但不同语义的字面量。
//
// 命名约定：新键写成 `cadt.<域>.<名称>.v<版本>`。**存量键不改名**——改名等于清空用户本地
// 数据，要动必须配迁移（参考 ai-session-store 的 migrated-at / migrated-ids 那对键）。
// 版本号进键名（而非键内数据）的前提是「读到旧版本就当没有」，不能做增量升级。

// ---------------- 应用设置快照 ----------------
// 设置项总快照：设置页 / 菜单 / 跨窗口同步都只写这一个键（applySettings / persistSettingsLight /
// applyRemoteSettings 三条通道，见 AGENTS.md 的设置同步硬规范）。
export const SETTINGS_KEY = 'datalens-settings';

// ---------------- AI 助手 ----------------
// 会话真源在磁盘（ai-sessions 目录），下面几个键是「指向 / 迁移状态 / 模式开关」这类索引信息。
export const AI_CONFIG_KEY = 'datalens-ai';
export const AI_SESSIONS_KEY = 'datalens-ai-sessions';
export const AI_STORAGE_MODE_KEY = 'datalens-ai-storage';
export const AI_CONFIG_MODE_KEY = 'datalens-ai-config';
export const AI_SESSION_MIGRATED_AT_KEY = 'datalens-ai-sessions-migrated-at';
export const AI_SESSION_MIGRATED_IDS_KEY = 'datalens-ai-sessions-migrated-ids';
// 输入区草稿：按会话存（键名带会话 id）。附件可能含大体积 dataURL，只走内存不落盘。
export const AI_DRAFT_KEY_PREFIX = 'datalens-ai-draft:';
// 工作区级草稿槽：空会话「没发就切走」会被删掉，草稿按归一化工作区路径暂存，下次在该
// 工作区新建会话时回填。不与上一行的会话草稿槽混用：一是「哪个会话」，一是「哪个工作区」。
export const AI_WS_DRAFT_KEY_PREFIX = 'datalens-ai-draft-ws:';
// 排队消息的重启恢复快照（队列本体是内存，重启即丢）。
export const AI_MSG_QUEUE_KEY = 'datalens-ai-msg-queue';
// 任务清单一轮的「当前条」徽标状态。
export const AI_TODOS_BADGE_KEY = 'datalens-ai-todos-current-badge';
// 定额查询结果的短缓存（额度查询有网络开销与频率限制）。
export const AI_USAGE_CACHE_KEY = 'cadt.ai-usage-cache.v2';

// ---------------- 窗口与会话（shell） ----------------
// 标签页 / 分组 / 分屏布局快照。两个槽：普通窗口一个、harness 窗口一个——单槽时 harness 的
// 空工作区布局会污染普通窗口的下次启动（读取侧对空 workspace 不做归属校验）。
export const WINDOW_SESSION_KEY = 'cadt.session.v1';
export const WINDOW_SESSION_HARNESS_KEY = 'cadt.session.harness.v1';
// 按工作区保存的环境（软切换 / 新窗口打开另一工作区时恢复该工作区上次的布局）。
export const WORKSPACE_SESSIONS_KEY = 'cadt.workspace-sessions.v1';
// 浏览器标签页的恢复快照 + 「哪个窗口持有」标记（多窗口下同一批标签页只恢复一次）。
export const BROWSER_TABS_KEY = 'cadt.browser-tabs.v1';
export const BROWSER_TABS_OWNER_KEY = 'cadt.browser-tabs.owner';
// 状态栏消息中心的历史列表。
export const MESSAGE_CENTER_KEY = 'datalens-message-center';
// 最近打开的文件（欢迎页 / 菜单入口）。
export const RECENT_FILES_KEY = 'datalens-recent';

// ---------------- 各视图的局部状态 ----------------
// 便签面板的 scope 选择（工作区 / 全局）。
export const MEMO_SCOPE_KEY = 'cadt-memo-scope';
// 底部后台终端的分割比例。
export const BGTERM_SPLIT_KEY = 'datalens-bgterm-split';
// Git 图谱面板的分栏宽度与信息面板高度。
export const GITGRAPH_PANE_WIDTHS_KEY = 'cadt.gitgraph.paneWidths';
export const GITGRAPH_INFO_HEIGHT_KEY = 'cadt.gitgraph.infoH';
// 阅读模式的阅读进度。
export const READING_STATE_KEY = 'datalens-reading-state';
// 写作模式的「今日已写」计数。
export const WRITING_DAILY_KEY = 'datalens-writing-daily';
// 上一次「一键清缓存」的时间（存储页据此显示下次可清理时间）。
export const AUTO_CLEAN_LAST_KEY = 'datalens-storage-autoclean-last';

// ---------------- dev 模式（mock 后端的本地存根） ----------------
// 只在 `npm run dev` 的 mock 后端里用，不进真实构建路径。
export const MOCK_DB_CONNECTIONS_KEY = 'datalens-mock-db-connections';
export const MOCK_SAVE_KEY = 'datalens-mock-save';

// ---------------- 动态键构造器 ----------------
// 定时任务某次触发的认领标记键（多窗口去重：广播各窗口都收到，只有一个能写成功）。
export const SCHED_FIRE_KEY_PREFIX = 'datalens-sched-fire-';

// 守卫 test/core/storage-key-guard.test.mjs 用这张表判断「拼接出来的键是从哪个前缀来的」，
// 新增构造器时一并登记，否则守卫认不出它的前缀。
/** @type {readonly string[]} */
export const DYNAMIC_KEY_PREFIXES = Object.freeze([
    AI_DRAFT_KEY_PREFIX,
    AI_WS_DRAFT_KEY_PREFIX,
    SCHED_FIRE_KEY_PREFIX,
]);

// @ts-check 下 builder 的入参一律先归一成字符串：调用方传 null / undefined / 数字都能拼出稳定的键
// （历史上出现过 undefined 拼进键名，读回来的键与写的不一致 → 状态看起来「没保存」）。
/** @param {unknown} value */
function keyPart(value) {
    return value == null ? '' : String(value);
}

// 某个会话的输入草稿键。
/** @param {string} sessionId */
export function draftLSKey(sessionId) {
    return AI_DRAFT_KEY_PREFIX + keyPart(sessionId);
}

// 某个工作区（已归一化的 workspaceKey）的草稿槽键。
/** @param {string} workspaceKey */
export function wsDraftLSKey(workspaceKey) {
    return AI_WS_DRAFT_KEY_PREFIX + keyPart(workspaceKey);
}

// 窗口布局快照槽：多工作区（harness）窗口与普通窗口分开存。
/** @param {boolean} isMultiWorkspace */
export function windowSessionKeyOf(isMultiWorkspace) {
    return isMultiWorkspace ? WINDOW_SESSION_HARNESS_KEY : WINDOW_SESSION_KEY;
}

// 定时任务某次触发的认领标记键（多窗口去重：广播各窗口都收到，只有一个能写成功）。
/** @param {string} scheduleId @param {number} [runNo] */
export function schedFireKey(scheduleId, runNo) {
    return SCHED_FIRE_KEY_PREFIX + keyPart(scheduleId) + '-' + keyPart(runNo || 0);
}
