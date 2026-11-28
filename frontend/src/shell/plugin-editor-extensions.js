// plugin-editor-extensions.js：编辑器装饰与行内建议提供者注册表。纯逻辑，无 DOM，可单测。
// 装饰：插件声明 marker 范围与样式，宿主复用 Ace marker 生命周期；
// 行内建议：插件提供异步建议，宿主管理 widget 幽灵文本，采纳/拒绝由宿主统一。

export const MAX_DECORATIONS_TOTAL = 40;
export const MAX_SUGGEST_TOTAL = 16;
const ID_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const decorations = new Map();
const suggestProviders = new Map();

/** @param {string} message */
function bad(message) { throw new Error('[plugin-editor-ext] ' + message); }
/** @param {any} v */
function obj(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const p = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null;
}

/** @param {string} pluginId @param {string} pluginName @param {any} spec */
export function registerEditorDecoration(pluginId, pluginName, spec) {
    const owner = String(pluginId || '').trim();
    if (!owner || !obj(spec)) bad('缺少插件 id 或声明对象');
    const id = String(spec.id || '').trim();
    if (!ID_RULE.test(id)) bad(`装饰 id 无效：${JSON.stringify(spec.id)}`);
    if (typeof spec.provide !== 'function') bad(`装饰 ${id} 缺少 provide 函数`);
    const key = owner + ':' + id;
    if (decorations.has(key)) bad(`装饰 ${id} 已注册`);
    if (decorations.size >= MAX_DECORATIONS_TOTAL) bad(`装饰总数超过上限 ${MAX_DECORATIONS_TOTAL}`);
    const rec = {
        key, pluginId: owner, pluginName: String(pluginName || owner), id,
        formats: Array.isArray(spec.formats) ? spec.formats.map(String) : [],
        provide: spec.provide,
    };
    decorations.set(key, rec);
    let disposed = false;
    return () => { if (!disposed) { disposed = true; if (decorations.get(key) === rec) decorations.delete(key); } };
}

/** @param {string} pluginId @param {string} pluginName @param {any} spec */
export function registerInlineSuggestProvider(pluginId, pluginName, spec) {
    const owner = String(pluginId || '').trim();
    if (!owner || !obj(spec)) bad('缺少插件 id 或声明对象');
    const id = String(spec.id || '').trim();
    if (!ID_RULE.test(id)) bad(`建议提供者 id 无效：${JSON.stringify(spec.id)}`);
    if (typeof spec.suggest !== 'function') bad(`建议提供者 ${id} 缺少 suggest 函数`);
    const key = owner + ':' + id;
    if (suggestProviders.has(key)) bad(`建议提供者 ${id} 已注册`);
    if (suggestProviders.size >= MAX_SUGGEST_TOTAL) bad(`建议提供者总数超过上限 ${MAX_SUGGEST_TOTAL}`);
    const rec = {
        key, pluginId: owner, pluginName: String(pluginName || owner), id,
        formats: Array.isArray(spec.formats) ? spec.formats.map(String) : [],
        debounceMs: Number.isFinite(Number(spec.debounceMs)) ? Math.max(0, Number(spec.debounceMs)) : 250,
        suggest: spec.suggest,
    };
    suggestProviders.set(key, rec);
    let disposed = false;
    return () => { if (!disposed) { disposed = true; if (suggestProviders.get(key) === rec) suggestProviders.delete(key); } };
}

export function clearEditorDecorations() { decorations.clear(); }
export function clearInlineSuggestProviders() { suggestProviders.clear(); }
export function removeEditorExtensionsByOwner(pluginId) {
    for (const [key, rec] of decorations) if (rec.pluginId === pluginId) decorations.delete(key);
    for (const [key, rec] of suggestProviders) if (rec.pluginId === pluginId) suggestProviders.delete(key);
}
export function getEditorDecorations() { return [...decorations.values()]; }
export function getInlineSuggestProviders() { return [...suggestProviders.values()]; }

/** 某格式命中的装饰（provide 求值，抛错跳过）。 */
export function decorationsForFormat(formatId, doc, ctx) {
    const out = [];
    for (const d of decorations.values()) {
        if (d.formats.length && !d.formats.includes(String(formatId || ''))) continue;
        try {
            const r = d.provide({formatId: String(formatId || ''), path: String((doc && doc.path) || ''), ...(ctx || {})});
            if (Array.isArray(r)) out.push({pluginId: d.pluginId, markers: r.filter((m) => m && typeof m === 'object')});
        } catch (e) {}
    }
    return out;
}

/** 某格式命中的行内建议提供者。 */
export function suggestProvidersForFormat(formatId) {
    return [...suggestProviders.values()].filter((p) => !p.formats.length || p.formats.includes(String(formatId || '')));
}
