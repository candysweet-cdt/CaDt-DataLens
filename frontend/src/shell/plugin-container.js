// plugin-container.js：插件依赖注入容器（平台原语 S4）。
//
// ⚠️ 与 shell/plugin-services.js **不是一回事，不要合并**：
//   · plugin-services.js 管「插件声明的后台子进程」（exe + healthURL + 启停 + 日志，
//     Go 侧 internal/appservices 托管）。名字里的 service 是「进程服务」。
//   · 本模块管「能力对象挂在稳定 key 上、谁提供谁使用、可替换、可等待就绪、可整体撤销」。
//     名字里的 service 是「依赖注入里的服务」。
//   两者都在 shell/ 下，靠文件头这段区分；新增代码请按「要不要起进程」判断，不要按文件名猜。
//
// 为什么需要它：现状是 10 个域各自一套 `Map + register/clear`（格式、工具、视图、导入器、
// 数据库驱动、AI provider、设置面板、命令、文档转换器、子进程服务）。插件只能「加」不能
// 「查」也不能「换」：想知道宿主有没有 llm、能不能替换默认实现、依赖的服务什么时候就绪，
// 一律没有答案。容器补的就是这三件事——**稳定 key 的查找 / 替换 / 就绪等待**，
// 外加「按 owner 一次性撤销」把注册变成可逆操作。
//
// 边界：容器只存**引用**，不负责创建、不负责生命周期之外的清理（disposer 由提供方给）。
//
// group 隔离（对齐 Cordis realm）：provide 可带 `group`，同名服务在不同 group 各存一份；
// 查找时先认同组、再回落全局（group='' 的 core 服务对所有 group 可见）。默认 group=''，
// 因此老插件（不带 group）的行为逐字不变。

/**
 * 服务 key 规则：点分命名空间 + 插件 id 段。与钩子事件名同口径。
 */
const NAME_RULE = /^[a-z0-9][a-z0-9._:/-]*$/i;

/** 默认就绪等待上限（毫秒）。插件加载期多为同步，5s 足够；超时按「服务未提供」报错。 */
export const CONTAINER_READY_TIMEOUT_MS = 5000;

/**
 * @typedef {{name: string, value: any, owner: string, group: string, providedAt: number, dispose?: () => void}} ServiceRecord
 */

/** 复合 slot key：group 与 name 用 NUL 分隔（name 规则不允许 NUL，无歧义）。 */
function slotKey(name, group) {
    return String(group || '') + '\u0000' + name;
}

/**
 * 创建容器。
 * @param {{logf?: (message: string) => void, timeoutMs?: number}} [options]
 */
export function createPluginContainer(options = {}) {
    const logf = typeof options.logf === 'function' ? options.logf : () => {};
    const defaultTimeout = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : CONTAINER_READY_TIMEOUT_MS;
    /** @type {Map<string, ServiceRecord>} */
    const services = new Map();
    /** @type {Map<string, Array<{resolve: (v:any)=>void, reject: (e:Error)=>void, timer: any}>>} */
    const waiters = new Map();
    /** @type {Map<string, ServiceRecord>} effect 记录（与 services 分开，避免污染服务清单） */
    const effects = new Map();
    let effectSeq = 0;
    let disposed = false;

    function assertName(name) {
        const value = String(name == null ? '' : name).trim();
        if (!value) throw new Error('[plugin-container] 服务名不能为空');
        if (!NAME_RULE.test(value)) {
            throw new Error('[plugin-container] 服务名只允许字母数字与 . _ : / -：' + value);
        }
        return value;
    }

    function settleWaiters(name, ok, value) {
        const list = waiters.get(name);
        if (!list || !list.length) return;
        waiters.delete(name);
        for (const item of list) {
            clearTimeout(item.timer);
            if (ok) item.resolve(value);
            else item.reject(value);
        }
    }

    /**
     * 提供服务。同名已存在且非 replace 时抛错——静默覆盖会让「谁覆盖了谁」无从追查。
     * group 不同的同名服务各存一份（realm 隔离），查找时先认同组再回落全局。
     * @param {string} name
     * @param {any} value
     * @param {{owner?: string, group?: string, replace?: boolean, dispose?: () => void}} [opts]
     * @returns {() => void} 撤销函数（只撤自己提供的那一份；已被替换时是空操作）
     */
    function provide(name, value, opts = {}) {
        if (disposed) throw new Error('[plugin-container] 容器已释放');
        const key = assertName(name);
        const owner = String(opts.owner || '');
        const group = String(opts.group || '');
        const slot = slotKey(key, group);
        const existing = services.get(slot);
        if (existing && opts.replace !== true) {
            throw new Error('[plugin-container] 服务已存在：' + key +
                (group ? '（group ' + group + '）' : '') +
                (existing.owner ? '（提供者 ' + existing.owner + '）' : ''));
        }
        if (existing && typeof existing.dispose === 'function' && existing.value !== value) {
            try { existing.dispose(); } catch (e) {
                logf('[plugin-container] 旧服务的 dispose 抛错 ' + key + '：' + ((e && e.message) || e));
            }
        }
        /** @type {ServiceRecord} */
        const record = {
            name: key,
            value,
            owner,
            group,
            providedAt: Date.now(),
            dispose: typeof opts.dispose === 'function' ? opts.dispose : undefined,
        };
        services.set(slot, record);
        settleWaiters(slot, true, value);
        return () => {
            const current = services.get(slot);
            if (!current || current.value !== value) return;
            services.delete(slot);
            // 与 replace / disposeOwner / dispose 三条路径保持一致：撤销自己的服务也要跑
            // 自己的 dispose，否则插件用 off() 主动撤服务时定时器 / 子资源会静默泄漏。
            if (typeof record.dispose === 'function') {
                try { record.dispose(); } catch (e) {
                    logf('[plugin-container] 撤销时 dispose 抛错 ' + key + '：' + ((e && e.message) || e));
                }
            }
        };
    }

    /** 查找记录：先认同组（slotKey(name, group)），再回落全局（group=''）。 */
    function recordOf(name, group) {
        const key = String(name || '');
        const g = String(group || '');
        if (g) {
            const own = services.get(slotKey(key, g));
            if (own) return own;
        }
        return services.get(slotKey(key, '')) || null;
    }

    function has(name, opts = {}) {
        return !!recordOf(name, opts.group);
    }

    /** 取服务，缺失返回 undefined（不抛）。给「有就用、没有就降级」的场景。 */
    function get(name, opts = {}) {
        const record = recordOf(name, opts.group);
        return record ? record.value : undefined;
    }

    /** 取服务，缺失抛错。给「必须有」的场景——错误信息带上已注册的 key，便于排查拼写。 */
    function requireService(name, opts = {}) {
        const key = String(name || '');
        const record = recordOf(key, opts.group);
        if (!record) {
            const known = [...services.values()]
                .filter((r) => !r.group || (opts && opts.group && r.group === String(opts.group)))
                .map((r) => r.name).sort().join('、') || '（空）';
            throw new Error('[plugin-container] 缺少服务：' + key + '；已提供：' + known);
        }
        return record.value;
    }

    /**
     * 等待服务就绪（已就绪立即 resolve）。
     * @param {string} name
     * @param {{timeoutMs?: number, group?: string}} [opts]
     * @returns {Promise<any>}
     */
    function whenReady(name, opts = {}) {
        const key = assertName(name);
        const group = String(opts.group || '');
        const slot = slotKey(key, group);
        const ready = recordOf(key, group);
        if (ready) return Promise.resolve(ready.value);
        if (disposed) return Promise.reject(new Error('[plugin-container] 容器已释放'));
        const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : defaultTimeout;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const list = (waiters.get(slot) || []).filter((item) => item.resolve !== resolve);
                if (list.length) waiters.set(slot, list); else waiters.delete(slot);
                reject(new Error('[plugin-container] 等待服务超时（' + timeoutMs + 'ms）：' + key));
            }, timeoutMs);
            // 不要对 timer 调 unref：浏览器里没有该方法，Node 测试里 unref 会让事件循环
            // 先于超时退出，等待中的 Promise 永远不结算（表现为用例被 cancel）。
            const list = waiters.get(slot) || [];
            list.push({resolve, reject, timer});
            waiters.set(slot, list);
        });
    }

    /**
     * 声明依赖并等待全部就绪（Cordis 的 inject 等价物）。
     * @param {string[]} names
     * @param {{timeoutMs?: number, group?: string}} [opts]
     * @returns {Promise<Record<string, any>>}
     */
    async function inject(names, opts = {}) {
        const wanted = Array.isArray(names) ? names.map((n) => assertName(n)) : [];
        const values = await Promise.all(wanted.map((name) => whenReady(name, opts)));
        /** @type {Record<string, any>} */
        const out = {};
        wanted.forEach((name, index) => { out[name] = values[index]; });
        return out;
    }

    /**
     * 声明一次性副作用并登记 disposer（Cordis 的 ctx.effect 等价物）。
     * effect 立即执行；它返回的清理函数（或显式传入的 disposer）在 off/disposeOwner/dispose
     * 时按 owner 一起撤销——把「注册」变成可逆操作。
     * @param {() => (void | (() => void))} fn
     * @param {{owner?: string, group?: string}} [opts]
     * @returns {() => void} 手动撤销函数（幂等）
     */
    function effect(fn, opts = {}) {
        if (disposed) throw new Error('[plugin-container] 容器已释放');
        if (typeof fn !== 'function') throw new Error('[plugin-container] effect 必须是函数');
        const owner = String(opts.owner || '');
        const group = String(opts.group || '');
        const id = 'effect:' + (++effectSeq);
        let cleanup = null;
        let undone = false;
        try {
            const ret = fn();
            if (typeof ret === 'function') cleanup = ret;
        } catch (e) {
            logf('[plugin-container] effect 抛错 ' + id + '：' + ((e && e.message) || e));
        }
        const record = {
            name: id,
            value: undefined,
            owner,
            group,
            providedAt: Date.now(),
            dispose: () => {
                if (undone) return;
                undone = true;
                if (typeof cleanup === 'function') {
                    try { cleanup(); } catch (e) {
                        logf('[plugin-container] effect 清理抛错 ' + id + '：' + ((e && e.message) || e));
                    }
                }
            },
        };
        const slot = slotKey(id, group);
        effects.set(slot, record);
        return () => {
            if (!effects.has(slot)) return;
            effects.delete(slot);
            record.dispose();
        };
    }

    /** 执行一条记录的 disposer（统一吞错，不打断其余撤销）。 */
    function runDispose(record, label) {
        if (typeof record.dispose === 'function') {
            try { record.dispose(); } catch (e) {
                logf('[plugin-container] dispose 抛错 ' + label + '：' + ((e && e.message) || e));
            }
        }
    }

    /** 撤销某个 owner 提供的全部服务与 effect，返回条数（服务 + effect 合计）。 */
    function disposeOwner(owner) {
        const who = String(owner || '');
        if (!who) return 0;
        let removed = 0;
        for (const [slot, record] of [...services.entries()]) {
            if (record.owner !== who) continue;
            services.delete(slot);
            removed += 1;
            runDispose(record, record.name);
        }
        for (const [slot, record] of [...effects.entries()]) {
            if (record.owner !== who) continue;
            effects.delete(slot);
            removed += 1;
            runDispose(record, record.name);
        }
        return removed;
    }

    /** 供诊断 / 设置页展示：当前注册的服务清单（不含具体值）。 */
    function list() {
        return [...services.values()].map((record) => ({
            name: record.name,
            owner: record.owner,
            group: record.group,
            providedAt: record.providedAt,
        }));
    }

    function dispose() {
        disposed = true;
        for (const slot of [...waiters.keys()]) {
            settleWaiters(slot, false, new Error('[plugin-container] 容器已释放，等待中的服务不会就绪：' + slot));
        }
        for (const record of services.values()) runDispose(record, record.name);
        for (const record of effects.values()) runDispose(record, record.name);
        services.clear();
        effects.clear();
    }

    return {
        provide, has, get, require: requireService,
        whenReady, inject, effect, disposeOwner, list, dispose,
        get disposed() { return disposed; },
        get size() { return services.size; },
    };
}
