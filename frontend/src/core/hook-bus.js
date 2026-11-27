// hook-bus.js：进程内钩子总线（插件平台原语 S4）。
//
// 与 core/app-events.js 的分工——**两条总线，两层语义，不要混用**：
//   · app-events.js 管「Go → 前端」的跨窗口事件，事件名必须登记进 event-scope.js 的
//     EVENT_SCOPES，并由 event-bridge-guard / event-contract-guard 双向守卫
//     （后者要求「Go 有发射点 ↔ 前端有订阅」）。它只订阅，不发起。
//   · 本模块管「进程内 JS 钩子」：插件与核心在同一窗口里互相插桩，不经 Wails、不跨窗口、
//     不需要 Go 侧对应发射点。**因此本模块的事件名一律不进 EVENT_SCOPES**——混进去会让
//     event-contract-guard 要求 Go 侧也发射同名事件，产生永远修不掉的红灯。
//
// 五种分发模式（对齐 Cordis，语义按本仓库口径固定下来）：
//   emit      观察：同步串行调用全部监听器，忽略返回值；单个监听器抛错只记日志、不影响其他
//   waterfall 环绕中间件：值依次穿过监听器（fn(value, payload)），返回 undefined 表示不接管；
//             返回任何非 undefined 即为新值；任何一步返回 __STOP 语义由调用方自行表达（本项目
//             用「返回非 undefined 即视为已被处理」的宽松口径，不做额外哨兵）
//   parallel  并行：全部监听器并发执行，等 allSettled，返回各自返回值数组（失败项为 undefined）
//   serial    有序：顺序 await，任一抛错即中断并向上抛（调用方决定降级）
//   bail      首个返回值：顺序调用，第一个返回非 undefined 的监听器终止整条链并返回该值
//
// 监听器注册是**可逆**的：on() 返回解绑函数，绑定时可带 owner（插件 id），
// 卸载插件时用 offOwner(owner) 一次性撤干净——这是「注册不可逆」缺口的修法。

/** 监听器优先级：数值大者先执行；同优先级按注册顺序。 */
export const HOOK_PRIORITY_DEFAULT = 0;

/**
 * @typedef {(value: any, payload: any) => any} HookFn
 * @typedef {{id: number, fn: HookFn, priority: number, once: boolean, owner: string}} HookEntry
 */

/**
 * 创建钩子总线。
 * @param {{logf?: (message: string) => void}} [options]
 */
export function createHookBus(options = {}) {
    const logf = typeof options.logf === 'function' ? options.logf : () => {};
    /** @type {Map<string, HookEntry[]>} */
    const handlers = new Map();
    let seq = 0;
    let disposed = false;

    function assertName(name) {
        const value = String(name == null ? '' : name).trim();
        if (!value) throw new Error('[hook-bus] 事件名不能为空');
        if (!/^[a-z0-9][a-z0-9._:/-]*$/i.test(value)) {
            throw new Error('[hook-bus] 事件名只允许字母数字与 . _ : / -：' + value);
        }
        return value;
    }

    /** 取该事件的监听器快照，按优先级降序、同优先级按注册序。 */
    function listOf(name) {
        const list = handlers.get(name);
        if (!list || !list.length) return [];
        return list.slice().sort((a, b) => (b.priority - a.priority) || (a.id - b.id));
    }

    function detach(name, entry) {
        const list = handlers.get(name);
        if (!list) return;
        const index = list.indexOf(entry);
        if (index >= 0) list.splice(index, 1);
        if (!list.length) handlers.delete(name);
    }

    /**
     * 注册监听器。
     * @param {string} name
     * @param {HookFn} fn
     * @param {{priority?: number, once?: boolean, owner?: string}} [opts]
     * @returns {() => void} 解绑函数（幂等）
     */
    function on(name, fn, opts = {}) {
        const key = assertName(name);
        if (typeof fn !== 'function') throw new Error('[hook-bus] 监听器必须是函数：' + key);
        if (disposed) throw new Error('[hook-bus] 总线已释放');
        /** @type {HookEntry} */
        const entry = {
            id: ++seq,
            fn,
            priority: Number.isFinite(opts.priority) ? Number(opts.priority) : HOOK_PRIORITY_DEFAULT,
            once: opts.once === true,
            owner: String(opts.owner || ''),
        };
        let list = handlers.get(key);
        if (!list) handlers.set(key, (list = []));
        list.push(entry);
        return () => detach(key, entry);
    }

    /** 撤销某个 owner（插件）注册的全部监听器，返回撤销条数。 */
    function offOwner(owner) {
        const who = String(owner || '');
        if (!who) return 0;
        let removed = 0;
        for (const key of [...handlers.keys()]) {
            const list = handlers.get(key) || [];
            for (const entry of list.slice()) {
                if (entry.owner !== who) continue;
                detach(key, entry);
                removed += 1;
            }
        }
        return removed;
    }

    function isThenable(value) {
        return !!value && typeof value.then === 'function';
    }

    /** 同步模式下误用 async 监听器：记一条诊断并吞掉拒绝，避免 unhandledRejection。 */
    function swallowAsync(name, value) {
        logf('[hook-bus] 同步模式不支持 async 监听器（' + name + '），其返回值被忽略；需要异步请用 serial / parallel');
        if (typeof value.catch === 'function') {
            value.catch((e) => logf('[hook-bus] async 监听器拒绝被忽略 ' + name + '：' + ((e && e.message) || e)));
        }
    }

    /**
     * 观察模式：同步串行，忽略返回值，单点失败不影响其他监听器。
     * @returns {number} 实际被调用的监听器数
     */
    function emit(name, payload) {
        const key = assertName(name);
        const list = listOf(key);
        let called = 0;
        for (const entry of list) {
            if (entry.once) detach(key, entry);
            called += 1;
            try {
                const ret = entry.fn(undefined, payload);
                // async 监听器的拒绝不会进 catch：显式挂一个 catch，否则是 unhandledRejection。
                if (isThenable(ret)) swallowAsync(key, ret);
            } catch (e) {
                logf('[hook-bus] emit 监听器抛错 ' + key + '：' + ((e && e.message) || e));
            }
        }
        return called;
    }

    /**
     * 环绕中间件：值依次穿过监听器，返回 undefined 表示不接管。
     * @returns {any} 处理后的值
     */
    function waterfall(name, value, payload) {
        const key = assertName(name);
        let current = value;
        for (const entry of listOf(key)) {
            if (entry.once) detach(key, entry);
            try {
                const next = entry.fn(current, payload);
                if (isThenable(next)) {
                    // 不能把 Promise 当成新值传下去：后续监听器会拿到 Promise 参与运算。
                    swallowAsync(key, next);
                    continue;
                }
                if (next !== undefined) current = next;
            } catch (e) {
                logf('[hook-bus] waterfall 监听器抛错 ' + key + '：' + ((e && e.message) || e));
            }
        }
        return current;
    }

    /**
     * 并行：全部监听器并发，等 allSettled；失败项记为 undefined。
     * @returns {Promise<any[]>}
     */
    async function parallel(name, payload) {
        const key = assertName(name);
        const list = listOf(key);
        if (!list.length) return [];
        const results = await Promise.allSettled(list.map((entry) => {
            if (entry.once) detach(key, entry);
            try {
                return Promise.resolve(entry.fn(undefined, payload));
            } catch (e) {
                return Promise.reject(e);
            }
        }));
        return results.map((item, index) => {
            if (item.status === 'fulfilled') return item.value;
            logf('[hook-bus] parallel 监听器失败 ' + key + '#' + index + '：' + ((item.reason && item.reason.message) || item.reason));
            return undefined;
        });
    }

    /**
     * 有序：顺序 await，任一抛错即中断并向上抛。
     * @returns {Promise<any[]>}
     */
    async function serial(name, payload) {
        const key = assertName(name);
        const out = [];
        for (const entry of listOf(key)) {
            if (entry.once) detach(key, entry);
            out.push(await entry.fn(undefined, payload));
        }
        return out;
    }

    /**
     * 首个返回值：顺序调用，第一个返回非 undefined 的监听器终止整条链。
     * @returns {any} 命中值，未命中为 undefined
     */
    function bail(name, payload) {
        const key = assertName(name);
        for (const entry of listOf(key)) {
            if (entry.once) detach(key, entry);
            try {
                const value = entry.fn(undefined, payload);
                if (isThenable(value)) {
                    // async 监听器的「返回值」是 Promise，直接当命中会把整条链误截断。
                    swallowAsync(key, value);
                    continue;
                }
                if (value !== undefined) return value;
            } catch (e) {
                logf('[hook-bus] bail 监听器抛错 ' + key + '：' + ((e && e.message) || e));
            }
        }
        return undefined;
    }

    function listenerCount(name) {
        const list = handlers.get(String(name || ''));
        return list ? list.length : 0;
    }

    function eventNames() {
        return [...handlers.keys()];
    }

    function dispose() {
        disposed = true;
        handlers.clear();
    }

    return {
        on, offOwner, emit, waterfall, parallel, serial, bail,
        listenerCount, eventNames, dispose,
        get disposed() { return disposed; },
    };
}
