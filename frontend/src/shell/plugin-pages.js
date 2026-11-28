// plugin-pages.js：插件注册的应用页面（cadt.registerPage）注册表——纯逻辑，无 DOM，可单测。
//
// 应用页面清单的单一来源仍是 core/app-pages.js 的 APP_PAGES（静态表）。插件页不直接改那张表
// （会打破 core 不 import 域的方向），而是存这里，由 main.js 在 core 提供的 resolver 里合并——
// appPageOf / appPageGroups 查静态表没命中时回落到本注册表。

export const MAX_PAGES_PER_PLUGIN = 8;
export const MAX_PAGES_TOTAL = 32;
const ID_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** @type {Map<string, any>} id → record（id 全局唯一，插件 id 做前缀避免撞内置页） */
const pages = new Map();

/** @param {string} message */
function bad(message) {
    throw new Error('[registerPage] ' + message);
}

/** @param {any} value */
function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/** @param {string} pluginId @param {string} pluginName @param {any} spec */
export function normalizePluginPage(pluginId, pluginName, spec) {
    const owner = String(pluginId || '').trim();
    if (!owner) bad('缺少插件 id');
    if (!isPlainObject(spec)) bad('需要一个页面对象');
    const id = String(spec.id || '').trim();
    if (!ID_RULE.test(id)) bad(`页面 id 无效：${JSON.stringify(spec.id)}`);
    const fullId = owner + '.' + id;
    if (typeof spec.mount !== 'function') bad(`页面 ${fullId} 缺少 mount 函数`);
    return {
        id: fullId,
        pluginId: owner,
        pluginName: String(pluginName || owner),
        label: String(spec.label == null ? id : spec.label).trim().slice(0, 40) || id,
        icon: String(spec.icon || 'doc').trim().slice(0, 40) || 'doc',
        group: String(spec.group || '插件').trim().slice(0, 40) || '插件',
        desc: String(spec.desc || '').trim().slice(0, 120),
        perWorkspace: spec.perWorkspace === true,
        mount: spec.mount,
    };
}

/** @returns {() => void} */
export function registerPluginPage(pluginId, pluginName, spec) {
    const record = normalizePluginPage(pluginId, pluginName, spec);
    if (pages.has(record.id)) bad(`页面 ${record.id} 已注册`);
    let owned = 0;
    for (const item of pages.values()) if (item.pluginId === record.pluginId) owned += 1;
    if (owned >= MAX_PAGES_PER_PLUGIN) bad(`单插件页面数超过上限 ${MAX_PAGES_PER_PLUGIN}`);
    if (pages.size >= MAX_PAGES_TOTAL) bad(`页面总数超过上限 ${MAX_PAGES_TOTAL}`);
    pages.set(record.id, record);
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        if (pages.get(record.id) === record) pages.delete(record.id);
    };
}

export function clearPluginPages() {
    pages.clear();
}

export function removePluginPagesByOwner(pluginId) {
    for (const [key, rec] of pages) if (rec.pluginId === pluginId) pages.delete(key);
}

/** 给 core/app-pages.js 接 resolver（core 不 import shell，由 main.js 调本函数完成接线）。 */
export function initPluginPages(setResolver) {
    if (typeof setResolver !== 'function') return;
    setResolver(
        (id) => getPluginPages().find((p) => p.id === id) || null,
        () => pluginPagesAsAppPages());
}

export function getPluginPages() {
    return [...pages.values()];
}

/** 供 core resolver 用：把插件页转成 AppPage 形状（不含 mount，mount 走 appPageMounters）。 */
export function pluginPagesAsAppPages() {
    return getPluginPages().map((p) => ({
        id: p.id, label: p.label, icon: p.icon, group: p.group, desc: p.desc,
        perWorkspace: p.perWorkspace, plugin: true,
    }));
}

/** 供 main.js 构造 appPageMounters：id → mount。 */
export function pluginPageMounters() {
    const out = {};
    for (const p of pages.values()) out[p.id] = p.mount;
    return out;
}
