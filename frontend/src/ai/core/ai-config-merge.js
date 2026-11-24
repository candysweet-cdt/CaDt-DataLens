// ai-config-merge.js：ai-config.json 的三方合并（base / mine / theirs），纯函数。
//
// 背景：主窗 / 浮窗 / 多个工作区窗口共享同一份 ai-config.json，而 saveAIConfig 是整份
// 覆盖。写盘侧现在有「比较-交换」（后端 AIConfigWriteIfUnchanged：磁盘内容仍等于我方
// 基线才写），冲突时把磁盘最新明文回传给前端——由这里把「本窗口改过的键」与「另一窗口
// 改过的键」各自保留，而不是整份相互覆盖。
//
// 三条规则：
//   1. 标量 / 整体小对象：本窗口改过（mine ≠ base）就用 mine，否则用 theirs；
//      两边都改过 → 用 mine（本窗口是正在操作的一方，不能丢用户刚做的动作）并记一条冲突。
//   2. activeSessionByWorkspace：本窗口的工作区键永远用 mine（这是本窗口唯一有权写的
//      条目，含「清空该键」）；其余键按规则 1。
//   3. 带 id 的数组（profiles / prompts / genModels / agents）：逐元素按 id 走规则 1，
//      支持增 / 改 / 删（本窗口删掉的元素不会被磁盘版本复活）。
//
// 合并结果由调用方再走一次 normalizeAIConfig（归一化是唯一真源，这里不重复字段校验）。

// 元素带稳定 id、可逐项三方合并的数组键。
const ID_ARRAY_KEYS = new Set(['profiles', 'prompts', 'genModels', 'agents']);

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

// 稳定序列化（键排序）：配置对象是纯 JSON，两侧键序可能不同，直接 JSON.stringify
// 会把「同一份内容」误判成「改过」。只用于等值比较，不用于落盘。
function stableKey(value) {
    if (Array.isArray(value)) return '[' + value.map(stableKey).join(',') + ']';
    if (isPlainObject(value)) {
        return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stableKey(value[k])).join(',') + '}';
    }
    return value === undefined ? 'undefined' : JSON.stringify(value);
}

function same(a, b) {
    return stableKey(a) === stableKey(b);
}

function mergeSessionMap(base, mine, theirs, ownWorkspaceKey) {
    const baseMap = isPlainObject(base) ? base : {};
    const mineMap = isPlainObject(mine) ? mine : {};
    const theirsMap = isPlainObject(theirs) ? theirs : {};
    const out = {};
    const keys = new Set([...Object.keys(baseMap), ...Object.keys(theirsMap), ...Object.keys(mineMap)]);
    for (const key of keys) {
        // 本窗口的工作区条目只有本窗口有权写：mine 里没有就是「本窗口清空了它」。
        if (ownWorkspaceKey && key === ownWorkspaceKey) {
            const value = mineMap[key];
            if (value) out[key] = value;
            continue;
        }
        const mineChanged = (mineMap[key] || '') !== (baseMap[key] || '');
        const theirsChanged = (theirsMap[key] || '') !== (baseMap[key] || '');
        const value = mineChanged ? mineMap[key] : theirsMap[key];
        if (value) out[key] = value;
    }
    return out;
}

function mergeByIdArray(base, mine, theirs) {
    const indexOf = (list) => {
        const map = new Map();
        list.forEach((item, i) => {
            if (!isPlainObject(item)) return;
            const id = String(item.id == null ? '' : item.id) || ('#' + i);
            map.set(id, item);
        });
        return map;
    };
    const baseMap = indexOf(base);
    const mineMap = indexOf(mine);
    const theirsMap = indexOf(theirs);
    const ids = new Set([...baseMap.keys(), ...theirsMap.keys(), ...mineMap.keys()]);
    const out = [];
    const conflicts = [];
    for (const id of ids) {
        const inBase = baseMap.has(id);
        const inMine = mineMap.has(id);
        const inTheirs = theirsMap.has(id);
        // 增 / 删也算「改过」：否则本窗口删掉的条目会被磁盘版本复活。
        const mineChanged = inMine !== inBase || (inMine && !same(mineMap.get(id), baseMap.get(id)));
        const theirsChanged = inTheirs !== inBase || (inTheirs && !same(theirsMap.get(id), baseMap.get(id)));
        let pick;
        if (mineChanged && theirsChanged) {
            pick = mineMap.get(id);
            conflicts.push(id);
        } else if (mineChanged) {
            pick = mineMap.get(id);
        } else {
            pick = theirsMap.get(id);
        }
        if (pick) out.push(pick);
    }
    return {value: out, conflicts};
}

/**
 * 三方合并 AI 配置。
 * @param {object} base 上一次成功读/写后的配置（本窗口的合并基线）
 * @param {object} mine 本窗口当前内存里的配置
 * @param {object} theirs 磁盘上的最新配置（由后端 WriteIfUnchanged 回传）
 * @param {{ownWorkspaceKey?: string}} [opts] 本窗口的工作区 key（activeSessionByWorkspace 专用）
 * @returns {{config: object, conflicts: string[]}} conflicts 只用于给用户一条提示，不阻断合并
 */
export function mergeAIConfig(base, mine, theirs, opts = {}) {
    const baseObj = isPlainObject(base) ? base : {};
    const mineObj = isPlainObject(mine) ? mine : {};
    const theirsObj = isPlainObject(theirs) ? theirs : {};
    const conflicts = [];
    const out = {};
    const keys = new Set([...Object.keys(baseObj), ...Object.keys(theirsObj), ...Object.keys(mineObj)]);
    for (const key of keys) {
        const b = baseObj[key];
        const m = mineObj[key];
        const t = theirsObj[key];
        if (key === 'activeSessionByWorkspace') {
            out[key] = mergeSessionMap(b, m, t, opts.ownWorkspaceKey);
            continue;
        }
        if (ID_ARRAY_KEYS.has(key)) {
            const merged = mergeByIdArray(Array.isArray(b) ? b : [], Array.isArray(m) ? m : [], Array.isArray(t) ? t : []);
            out[key] = merged.value;
            for (const id of merged.conflicts) conflicts.push(key + ':' + id);
            continue;
        }
        const mineChanged = !same(m, b);
        const theirsChanged = !same(t, b);
        if (!mineChanged) {
            if (t !== undefined) out[key] = t;
            continue;
        }
        if (!theirsChanged) {
            if (m !== undefined) out[key] = m;
            continue;
        }
        // 两边都改过：本窗口优先（用户正在操作的是这个窗口），并如实报告一次冲突。
        if (m !== undefined) out[key] = m;
        conflicts.push(key);
    }
    return {config: out, conflicts};
}
