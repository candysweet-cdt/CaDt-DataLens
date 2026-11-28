// plugin-task-providers.js：任务 / 进度 / 后台作业 / 工作区初始化器注册表。纯逻辑，无 DOM，可单测。
// 这些接口共用「插件声明 + 宿主展示/调度」的模式：插件提供 start/status/cancel / progress /
// cron 作业 / 初始化动作，宿主负责 UI 与生命周期。

export const MAX_TOTAL = 40;
const ID_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const taskProviders = new Map();
const progressReporters = new Map();
const backgroundJobs = new Map();
const initializers = new Map();

/** @param {string} message */
function bad(message) { throw new Error('[plugin-tasks] ' + message); }
/** @param {any} v */
function obj(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const p = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null;
}

function add(store, label, pluginId, pluginName, spec, required) {
    const owner = String(pluginId || '').trim();
    if (!owner || !obj(spec)) bad(`缺少插件 id 或声明对象`);
    const id = String(spec.id || '').trim();
    if (!ID_RULE.test(id)) bad(`${label} id 无效：${JSON.stringify(spec.id)}`);
    for (const fn of required) {
        if (typeof spec[fn] !== 'function') bad(`${label} ${id} 缺少 ${fn} 函数`);
    }
    const key = owner + ':' + id;
    if (store.has(key)) bad(`${label} ${id} 已注册`);
    if (store.size >= MAX_TOTAL) bad(`${label} 总数超过上限 ${MAX_TOTAL}`);
    const rec = {
        key, pluginId: owner, pluginName: String(pluginName || owner), id,
        label: String(spec.label == null ? id : spec.label).trim().slice(0, 60) || id,
    };
    return {owner, spec, key, rec};
}

function finish(store, built, extra) {
    const rec = {...built.rec, ...(extra || {})};
    store.set(built.key, rec);
    let disposed = false;
    return () => { if (!disposed) { disposed = true; if (store.get(built.key) === rec) store.delete(built.key); } };
}

export function registerTaskProvider(pluginId, pluginName, spec) {
    const b = add(taskProviders, '任务提供者', pluginId, pluginName, spec, ['start']);
    return finish(taskProviders, b, {
        status: typeof spec.status === 'function' ? spec.status : null,
        cancel: typeof spec.cancel === 'function' ? spec.cancel : null,
    });
}

export function registerProgressReporter(pluginId, pluginName, spec) {
    const b = add(progressReporters, '进度报告器', pluginId, pluginName, spec, ['progress']);
    return finish(progressReporters, b, {});
}

export function registerBackgroundJob(pluginId, pluginName, spec) {
    const b = add(backgroundJobs, '后台作业', pluginId, pluginName, spec, ['run']);
    const cron = String(spec.cron || '').trim();
    const intervalMs = Number(spec.intervalMs);
    if (!cron && !(Number.isFinite(intervalMs) && intervalMs > 0)) {
        throw new Error('[plugin-tasks] 后台作业需声明 cron 或 intervalMs');
    }
    return finish(backgroundJobs, b, {
        cron,
        intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? Math.floor(intervalMs) : 0,
    });
}

export function registerWorkspaceInitializer(pluginId, pluginName, spec) {
    const b = add(initializers, '工作区初始化器', pluginId, pluginName, spec, ['initialize']);
    return finish(initializers, b, {
        when: typeof spec.when === 'function' ? spec.when : null,
    });
}

export function clearTaskProviders() { taskProviders.clear(); }
export function clearProgressReporters() { progressReporters.clear(); }
export function clearBackgroundJobs() { backgroundJobs.clear(); }
export function clearWorkspaceInitializers() { initializers.clear(); }
export function removeTaskExtensionsByOwner(pluginId) {
    for (const store of [taskProviders, progressReporters, backgroundJobs, initializers]) {
        for (const [key, rec] of store) if (rec.pluginId === pluginId) store.delete(key);
    }
}
export function getTaskProviders() { return [...taskProviders.values()]; }
export function getProgressReporters() { return [...progressReporters.values()]; }
export function getBackgroundJobs() { return [...backgroundJobs.values()]; }
export function getWorkspaceInitializers() { return [...initializers.values()]; }
