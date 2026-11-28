// plugin-context-provider.js：按轮惰性求值的插件上下文提供者（cadt.registerContextProvider）。
//
// 与 registerAIContext 的区别：后者是「稳定知识」（进系统提示词稳定区，单条 4 KiB / 合计 12 KiB）；
// ContextProvider 是「随会话/轮变化的大块上下文」（如本章任务书、当前草稿摘要），按轮求值、
// 单独限长（默认 8 KiB）、带来源标记，走同一条 <plugin_context> 渲染链但不占稳定区配额。
// 内容按数据处理（不是系统指令），见 plugin-context.js 的转义口径。
import {PLUGIN_CTX_ORIGINS, pluginCtxBase, withCtx} from './plugin-ctx.js';

export const MAX_PROVIDERS_PER_PLUGIN = 16;
export const MAX_PROVIDERS_TOTAL = 64;
export const MAX_PROVIDER_CHARS = 8 * 1024;
const ID_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** @type {Map<string, any>} `${pluginId}:${id}` → record */
const providers = new Map();

/** @param {string} message */
function bad(message) {
    throw new Error('[registerContextProvider] ' + message);
}

/** @param {any} value */
function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/** @param {string} pluginId @param {string} pluginName @param {any} spec */
export function normalizeContextProvider(pluginId, pluginName, spec) {
    const owner = String(pluginId || '').trim();
    if (!owner) bad('缺少插件 id');
    if (!isPlainObject(spec)) bad('需要一个上下文提供者对象');
    const id = String(spec.id || '').trim();
    if (!ID_RULE.test(id)) bad(`id 无效：${JSON.stringify(spec.id)}`);
    if (typeof spec.text !== 'function') bad(`提供者 ${id} 缺少 text 函数`);
    return {
        key: owner + ':' + id,
        pluginId: owner,
        pluginName: String(pluginName || owner),
        id,
        label: String(spec.label == null ? id : spec.label).trim().slice(0, 40) || id,
        text: spec.text,
    };
}

/** @returns {() => void} */
export function registerContextProvider(pluginId, pluginName, spec) {
    const record = normalizeContextProvider(pluginId, pluginName, spec);
    if (providers.has(record.key)) bad(`提供者 ${record.id} 已注册`);
    let owned = 0;
    for (const item of providers.values()) if (item.pluginId === record.pluginId) owned += 1;
    if (owned >= MAX_PROVIDERS_PER_PLUGIN) bad(`单插件提供者数超过上限 ${MAX_PROVIDERS_PER_PLUGIN}`);
    if (providers.size >= MAX_PROVIDERS_TOTAL) bad(`提供者总数超过上限 ${MAX_PROVIDERS_TOTAL}`);
    providers.set(record.key, record);
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        if (providers.get(record.key) === record) providers.delete(record.key);
    };
}

/** 半插件失败时按 owner 撤销该插件的全部注册。 */
export function removeContextProvidersByOwner(pluginId) {
    for (const [key, rec] of providers) if (rec.pluginId === pluginId) providers.delete(key);
}

export function clearContextProviders() {
    providers.clear();
}

export function getContextProviders() {
    return [...providers.values()];
}

/**
 * 按轮求值所有提供者，产出可并入系统提示词的块文本（带来源标记）。
 * 单条失败只跳过；合计上限 MAX_PROVIDER_CHARS * 2（与稳定区分开）。
 * @param {any} runtimeCtx 基座 ctx（含 plugin/workspace/sessionId/origin）
 */
export function renderContextProviders(runtimeCtx) {
    const src = runtimeCtx && typeof runtimeCtx === 'object' ? runtimeCtx : {};
    const out = [];
    let total = 0;
    let truncated = false;
    for (const record of providers.values()) {
        // 按记录重建基座：插件在 text(ctx) 里读 ctx.plugin 应拿到自己的身份，不是宿主空壳
        const callCtx = withCtx(pluginCtxBase({
            pluginId: record.pluginId,
            pluginName: record.pluginName,
            workspace: src.workspace,
            sessionId: src.sessionId,
            origin: PLUGIN_CTX_ORIGINS.prompt,
        }), src);
        let text = '';
        try {
            text = String(record.text(callCtx) || '').trim();
        } catch (e) {
            continue;
        }
        if (!text) continue;
        // 先全局转义属性与正文，闭合标签的 < 已被转成 &lt;，跳不出数据区。
        const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
        const safe = esc(text);
        // 按**转义后**长度计数/截断：原文里的 & < > " 会被放大（最长 6 倍），
        // 按原文计数会让实际注入的提示词突破 16 KiB 预算。
        let rendered = safe;
        if (rendered.length > MAX_PROVIDER_CHARS) {
            rendered = rendered.slice(0, MAX_PROVIDER_CHARS);
            truncated = true;
        }
        if (total + rendered.length > MAX_PROVIDER_CHARS * 2) {
            truncated = true;
            break;
        }
        total += rendered.length;
        out.push('<plugin_context plugin="' + esc(record.pluginName) + '" id="' + esc(record.id) + '">\n'
            + rendered + '\n</plugin_context>');
    }
    return {
        text: out.length ? out.join('\n') : '',
        count: out.length,
        truncated,
    };
}
