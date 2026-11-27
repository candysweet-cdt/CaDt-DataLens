// @ts-check
// event-scope.js：多窗口事件范围表（唯一分类来源）。
// 与 docs/finished-plans/wails-v3-event-filtering.md §3 对齐；新增订阅必须先登记这里。
//
// scope:
//   app       全局状态，所有窗口都应处理（消费者自行去重）
//   window    控制命令，只给目标窗口（sender === 本窗口名）
//   workspace 按 payload.root 匹配本窗口工作区
//   resource  按 kind/key 匹配本窗口注册的资源监听
//   owned     ID 归属，按本窗口注册表判定
//   session   会话级，由 AI 面板按 sessionId 判定

export const EVENT_SCOPES = Object.freeze({
    // AI 流式（面板按 sessionId 自行判定；P2 可收紧为 session 谓词）
    'ai-chunk': 'session',
    'ai-think': 'session',
    'ai-toolcall': 'session',
    'ai-done': 'session',
    'ai-error': 'session',
    'ai-retry': 'session',
    'ai-param-adjust': 'session',
    'ai-queue': 'session',

    // 全局状态
    'sched-fire': 'app',
    'schedules-changed': 'app',
    'mcp-tools-changed': 'app',
    'mcp-status-changed': 'app',
    // 桌面控制安装进度（Go 侧 mcp_desktop_app.go 的 desktopInstallEvent）：
    // 全局事件——所有窗口都该看到「正在安装」的真实进度，避免多窗口各说一套
    'mcp-desktop-install': 'app',
    // 设置变更广播（多窗口）：任一窗口改设置后发全量快照，其他窗口原地合并内存副本并重绘。
    // app 级不按 sender 过滤——发出的窗口自己也收，接收方按值比较，无变化即跳过（幂等）。
    'settings-changed': 'app',
    // 桌面控制状态广播：payload {sessionId, enabled}——别的窗口改了同一会话的启用状态时，
    // 收到的一方刷新胶囊 / 权限面板显示（会话级授权，不再有单飞抢占语义）
    'desktop-grant-changed': 'app',
    'ai-timer-fired': 'app',
    'ai-timer-stopped': 'app',
    // 终端独立窗口关闭：payload.target 指定由哪个主窗口把会话接回去
    'term-popout-closed': 'app',
    // --quit 优雅退出（外部重建脚本）：每个窗口结算自己的 AI 回合后 ack
    'app-graceful-quit': 'app',

    // 工作区 / 资源
    'workspace-changed': 'workspace',
    // 编排：派发 / 状态变化 / 统一停止 / 仲裁事件 / 交接 / 审计，全部按 payload.root
    // 路由到归属工作区窗口（同工作区多窗口靠 ClaimBatch 互斥，只会有一个起轮）。
    'orchestration-dispatch': 'workspace',
    'orchestration-changed': 'workspace',
    'orchestration-stop': 'workspace',
    'orchestration-arbiter-event': 'workspace',
    'orchestration-arbiter-handoff': 'workspace',
    'orchestration-audit': 'workspace',
    // 注意：resource-changed 目前实际以 onApp 全窗广播消费（watch.Emit 未带 sender，
    // onResource 的 owns 谓词通道已建未接）——消费端有 kind/租约幂等兜底。改接线前
    // 先给 Go 侧 watch 事件带上归属，不要只动这张表（2026-11-21 审查 P2-4）。
    'resource-changed': 'resource',

    // 窗口控制命令
    'confirm-close': 'window',
    'close-choice': 'window',
    'app-quit-request': 'window',
    'app-open-terminal': 'window',
    // 文件拖放：Go 侧收下 v3 drop 后转成窗口事件（window_factory.go），按窗口消费
    'app-file-drop': 'window',
    'open-targets': 'window',
    'app-open-settings': 'window',
    'app-open-memo': 'window',
    'app-open-ai-session': 'window',
    'ai-notify-activate': 'window',

    // ID 归属（流式；P1 注册为 onApp，消费者已按 id 过滤；P2 收紧为 onOwned）
    'term-out': 'owned',
    'term-exit': 'owned',
    'cmd-out': 'owned',
    'cmd-exit': 'owned',
    'run-out': 'owned',
    'run-exit': 'owned',
    'browser-nav': 'owned',
    'browser-title': 'owned',
    'browser-error': 'owned',
    'reading-search-progress': 'owned',
});

// scopeOf 返回事件分类，未登记的事件按 app 处理（桥会记一条调试日志提醒登记）。
/**
 * @param {string} name
 * @returns {string}
 */
export function scopeOf(name) {
    return /** @type {Record<string, string>} */ (EVENT_SCOPES)[name] || 'app';
}

// pathKey 把路径归一成可比较的小写 key（分隔符统一、去尾斜杠）。
/** @param {string|null|undefined} p */
export function pathKey(p) {
    return String(p == null ? '' : p)
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase();
}

// acceptWorkspace 判断事件载荷是否属于本窗口工作区。
/**
 * @param {{root?: string}|null|undefined} payload
 * @param {string|null|undefined} workspace
 */
export function acceptWorkspace(payload, workspace) {
    const root = payload && payload.root;
    if (!root || !workspace) return false;
    return pathKey(root) === pathKey(workspace);
}
