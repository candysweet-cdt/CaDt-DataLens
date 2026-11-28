// plugin-file-actions.js：文件树装饰与右键动作注册表（cadt.registerFileDecorator / registerFileAction）。
// 纯逻辑，无 DOM，可单测。装饰给文件树附加徽标/图标（不改文件本体）；动作按路径/扩展名出现在右键菜单。

export const MAX_DECORATORS_TOTAL = 40;
export const MAX_ACTIONS_TOTAL = 40;
const ID_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const decorators = new Map();
const actions = new Map();

/** @param {string} message */
function bad(message) { throw new Error('[plugin-file-ext] ' + message); }
/** @param {any} v */
function obj(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const p = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null;
}

/** @param {string} pluginId @param {string} pluginName @param {any} spec */
export function registerFileDecorator(pluginId, pluginName, spec) {
    const owner = String(pluginId || '').trim();
    if (!owner || !obj(spec)) bad('缺少插件 id 或声明对象');
    const id = String(spec.id || '').trim();
    if (!ID_RULE.test(id)) bad(`装饰器 id 无效：${JSON.stringify(spec.id)}`);
    if (typeof spec.decorate !== 'function') bad(`装饰器 ${id} 缺少 decorate 函数`);
    const key = owner + ':' + id;
    if (decorators.has(key)) bad(`装饰器 ${id} 已注册`);
    if (decorators.size >= MAX_DECORATORS_TOTAL) bad(`装饰器总数超过上限 ${MAX_DECORATORS_TOTAL}`);
    const rec = {
        key, pluginId: owner, pluginName: String(pluginName || owner), id,
        extensions: Array.isArray(spec.extensions) ? spec.extensions.map((e) => String(e).replace(/^\./, '').toLowerCase()).filter(Boolean) : [],
        decorate: spec.decorate,
    };
    decorators.set(key, rec);
    let disposed = false;
    return () => { if (!disposed) { disposed = true; if (decorators.get(key) === rec) decorators.delete(key); } };
}

/** @param {string} pluginId @param {string} pluginName @param {any} spec */
export function registerFileAction(pluginId, pluginName, spec) {
    const owner = String(pluginId || '').trim();
    if (!owner || !obj(spec)) bad('缺少插件 id 或声明对象');
    const id = String(spec.id || '').trim();
    if (!ID_RULE.test(id)) bad(`动作 id 无效：${JSON.stringify(spec.id)}`);
    if (typeof spec.run !== 'function') bad(`动作 ${id} 缺少 run 函数`);
    const key = owner + ':' + id;
    if (actions.has(key)) bad(`动作 ${id} 已注册`);
    if (actions.size >= MAX_ACTIONS_TOTAL) bad(`动作总数超过上限 ${MAX_ACTIONS_TOTAL}`);
    const rec = {
        key, pluginId: owner, pluginName: String(pluginName || owner), id,
        label: String(spec.label == null ? id : spec.label).trim().slice(0, 60) || id,
        extensions: Array.isArray(spec.extensions) ? spec.extensions.map((e) => String(e).replace(/^\./, '').toLowerCase()).filter(Boolean) : [],
        contexts: Array.isArray(spec.contexts) && spec.contexts.length ? spec.contexts.map(String) : ['file'],
        run: spec.run,
    };
    actions.set(key, rec);
    let disposed = false;
    return () => { if (!disposed) { disposed = true; if (actions.get(key) === rec) actions.delete(key); } };
}

export function clearFileDecorators() { decorators.clear(); }
export function clearFileActions() { actions.clear(); }
export function removeFileExtensionsByOwner(pluginId) {
    for (const [key, rec] of decorators) if (rec.pluginId === pluginId) decorators.delete(key);
    for (const [key, rec] of actions) if (rec.pluginId === pluginId) actions.delete(key);
}
export function getFileDecorators() { return [...decorators.values()]; }
export function getFileActions() { return [...actions.values()]; }

/** 某路径/扩展名命中的装饰器（逐个 decorate 求值，抛错的跳过）。 */
export function decoratorsFor(path, ctx) {
    const ext = String(path || '').split(/[\\/]/).pop().split('.').pop().toLowerCase();
    const out = [];
    for (const d of decorators.values()) {
        if (d.extensions.length && !d.extensions.includes(ext)) continue;
        try {
            const r = d.decorate({path: String(path || ''), ext, ...(ctx || {})});
            if (r && typeof r === 'object') out.push({pluginId: d.pluginId, ...r});
        } catch (e) {}
    }
    return out;
}

/** 某路径/扩展名命中的右键动作。 */
export function actionsFor(path) {
    const ext = String(path || '').split(/[\\/]/).pop().split('.').pop().toLowerCase();
    return actionsList().filter((a) => !a.extensions.length || a.extensions.includes(ext));
}

function actionsList() { return [...actions.values()]; }
