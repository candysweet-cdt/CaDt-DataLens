// plugin-context-merge.js：把「稳定插件上下文」与「按轮求值的 provider」合并成一块系统提示词文本。
// 从 ai-panel.js 拆出（组合根只减不增）；纯逻辑，无 DOM，可单测。
import {PLUGIN_CTX_ORIGINS, pluginCtxBase, withCtx} from '../shell/plugin-ctx.js';

/**
 * @param {any} stableMod shell/plugin-context.js（renderPluginContextBlocks）
 * @param {any} providerMod shell/plugin-context-provider.js（renderContextProviders）
 * @param {any} runtimeCtx {scope, sessionId, workspace}
 * @returns {{text: string, count: number, truncated: boolean}}
 */
export function mergePluginContextText(stableMod, providerMod, runtimeCtx) {
    const ctx = withCtx(pluginCtxBase({
        workspace: runtimeCtx && runtimeCtx.workspace,
        sessionId: runtimeCtx && runtimeCtx.sessionId,
        origin: PLUGIN_CTX_ORIGINS.prompt,
    }), runtimeCtx);
    const stable = stableMod && typeof stableMod.renderPluginContextBlocks === 'function'
        ? stableMod.renderPluginContextBlocks(ctx)
        : {text: '', count: 0, truncated: false};
    let providerText = '';
    let providerCount = 0;
    let providerTruncated = false;
    if (providerMod && typeof providerMod.renderContextProviders === 'function') {
        try {
            const p = providerMod.renderContextProviders(ctx) || {};
            providerText = String(p.text || '').trim();
            providerCount = Number(p.count) || 0;
            providerTruncated = !!p.truncated;
        } catch (e) {}
    }
    return {
        text: [stable.text, providerText].filter(Boolean).join('\n'),
        count: (Number(stable.count) || 0) + (providerText ? providerCount : 0),
        truncated: !!stable.truncated || providerTruncated,
    };
}
