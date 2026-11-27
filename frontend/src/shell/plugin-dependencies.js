// plugin-dependencies.js：插件依赖排序（纯函数，S7）。
//
// 为什么需要：插件 A 提供 `plugin.a.llm`，插件 B `inject(['plugin.a.llm'])`。若 B 先执行，
// inject 只能等到超时——症状是「B 的某些功能偶发不工作」，而且不报错（超时被 catch 掉）。
// 排序把「偶发」变「确定」。
//
// 三条判定：
//   · 缺依赖（未安装 / 被禁用）：跳过该插件并记错误，其余照常加载（一个坏插件不该带垮全部）。
//   · 依赖被跳过：下游一并跳过（依赖链断了不能半启动）。
//   · 循环依赖：环上所有插件跳过，记一条错误说明环的成员。
//   · 稳定性：无依赖关系的插件之间维持原顺序，避免「只是排个序」把加载日志搅乱。

/**
 * 按 dependencies 排序。
 * @param {Array<{id: string, name?: string, dependencies?: string[]}>} sources
 * @param {string[]} [errors] 追加错误信息（调用方持有的数组，就地 push）
 * @returns {Array<{id: string, name?: string, dependencies?: string[]}>}
 */
export function orderByDependencies(sources, errors) {
    const push = (message) => {
        if (Array.isArray(errors)) errors.push(message);
    };
    const list = Array.isArray(sources) ? sources.filter((s) => s && s.id) : [];
    /** @type {Map<string, any>} */
    const byId = new Map();
    for (const source of list) {
        const id = String(source.id);
        if (byId.has(id)) {
            push(`${source.name || id}：插件 id 重复，已跳过重复项`);
            continue;
        }
        byId.set(id, source);
    }
    /** @type {Map<string, string[]>} */
    const depsOf = new Map();
    for (const [id, source] of byId) {
        const raw = source.dependencies;
        depsOf.set(id, Array.isArray(raw) ? raw.map((d) => String(d)).filter(Boolean) : []);
    }

    const usable = new Set();
    for (const [id, deps] of depsOf) {
        const missing = deps.filter((dep) => !byId.has(dep));
        if (missing.length) {
            push(`${(byId.get(id) || {}).name || id}：缺少依赖插件 ${missing.join('、')}（未安装或未启用），已跳过`);
            continue;
        }
        usable.add(id);
    }
    let shrunk = true;
    while (shrunk) {
        shrunk = false;
        for (const id of [...usable]) {
            const deps = depsOf.get(id) || [];
            if (deps.some((dep) => !usable.has(dep))) {
                usable.delete(id);
                push(`${(byId.get(id) || {}).name || id}：依赖的插件未能加载，已跳过`);
                shrunk = true;
            }
        }
    }

    const order = [...byId.keys()].filter((id) => usable.has(id));
    const indexOf = new Map(order.map((id, index) => [id, index]));
    const indegree = new Map(order.map((id) => [id, 0]));
    /** @type {Map<string, string[]>} */
    const dependents = new Map();
    for (const id of order) {
        for (const dep of depsOf.get(id) || []) {
            if (!usable.has(dep)) continue;
            indegree.set(id, (indegree.get(id) || 0) + 1);
            const kids = dependents.get(dep) || [];
            kids.push(id);
            dependents.set(dep, kids);
        }
    }
    const ready = order.filter((id) => (indegree.get(id) || 0) === 0);
    const placed = new Set();
    const out = [];
    while (ready.length) {
        // 按原始下标取最小者：只靠 FIFO 会让「刚就绪」的节点排到队尾，
        // 于是 [a, b(dep a), c] 会排成 [a, c, b]，与「无依赖关系的插件保持原顺序」不符。
        ready.sort((x, y) => (indexOf.get(x) || 0) - (indexOf.get(y) || 0));
        const id = ready.shift();
        placed.add(id);
        out.push(byId.get(id));
        for (const kid of dependents.get(id) || []) {
            const next = (indegree.get(kid) || 0) - 1;
            indegree.set(kid, next);
            if (next === 0) ready.push(kid);
        }
    }
    const stuck = order.filter((id) => !placed.has(id));
    if (stuck.length) {
        const stuckSet = new Set(stuck);
        // 区分「真的在环上」与「只是环的下游」：报错混在一起会让人去查错插件的依赖。
        const inCycle = new Set();
        for (const id of stuck) {
            const stack = (depsOf.get(id) || []).filter((dep) => stuckSet.has(dep));
            const seen = new Set();
            let hit = false;
            while (stack.length) {
                const next = stack.pop();
                if (next === id) { hit = true; break; }
                if (seen.has(next)) continue;
                seen.add(next);
                for (const dep of depsOf.get(next) || []) {
                    if (stuckSet.has(dep)) stack.push(dep);
                }
            }
            if (hit) inCycle.add(id);
        }
        const nameOf = (id) => (byId.get(id) || {}).name || id;
        if (inCycle.size) {
            push(`循环依赖：${[...inCycle].map(nameOf).join('、')}，已跳过`);
        }
        const downstream = stuck.filter((id) => !inCycle.has(id));
        if (downstream.length) {
            push(`依赖的插件存在循环依赖、无法启动：${downstream.map(nameOf).join('、')}，已跳过`);
        }
    }
    return out;
}
