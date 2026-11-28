// plugin-workspace-events.js：把宿主工作区事件转发进插件钩子总线（onWorkspaceEvent 的宿主侧）。
// 纯逻辑，无 DOM，可单测。main.js 在两个 workspace 事件点各调一次 emitWorkspaceEvent。
import {PLUGIN_CTX_ORIGINS, pluginCtxBase} from './plugin-ctx.js';

/**
 * @param {any} bus 插件钩子总线（有 emit 方法）
 * @param {'changed'|'opened'} kind 事件类型
 * @param {string} root 当前工作区根
 * @param {any} [payload] 原始事件负载
 */
export function emitWorkspaceEvent(bus, kind, root, payload) {
    if (!bus || typeof bus.emit !== 'function') return;
    const event = kind === 'opened' ? 'workspace/opened' : 'workspace/changed';
    const ctx = pluginCtxBase({workspace: root, origin: PLUGIN_CTX_ORIGINS.settings});
    bus.emit(event, {
        ...ctx,
        root: String(root || ''),
        paths: (payload && Array.isArray(payload.paths)) ? payload.paths : [],
        payload: payload || null,
    });
}
