// ai-context-dedup.js：系统提示词的稳定前缀去重与 warm cache（平台原语 S6，对齐 Cordis）。
//
// 背景：assembleSystemContext 已把「稳定块」与 turnBlock（每轮动态块）拆开，系统提示词
// 每轮逐字一致，前缀缓存可整段命中。这里补两件剩下小事：
//   1. headerEquals：判断两次组装的稳定前缀是否相等（按段落内容比，不受对象身份影响）；
//   2. warm cache：稳定区文本按会话缓存，digest 未变时直接复用上次结果，避免每轮重算
//      （durable 消息「加载一次不重发」的等价物）。
//
// 纯函数 + 小状态机，无 DOM / 无后端 / 无依赖，便于单测。

/**
 * 稳定字符串 digest（FNV-1a 32 位，输出 8 位十六进制）。
 * 只用于「内容是否变化」的判定，不用于安全场景——碰撞概率对提示词去重足够低。
 * @param {string} text
 */
export function contextDigest(text) {
    const s = typeof text === 'string' ? text : (text == null ? '' : String(text));
    let hash = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        hash ^= s.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return ('00000000' + hash.toString(16)).slice(-8);
}

/**
 * headerEquals：两段稳定前缀是否逐段相等。
 * 段落以空行（\n\n）分隔；忽略首尾空段与段内首尾空白，避免无关空行导致误判。
 * @param {string} a
 * @param {string} b
 */
export function headerEquals(a, b) {
    const parts = (v) => String(v == null ? '' : v)
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean);
    const left = parts(a);
    const right = parts(b);
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
        if (left[i] !== right[i]) return false;
    }
    return true;
}

/**
 * 创建稳定区 warm cache。
 * 每个会话槽保存 {digest, text, at}；digest 命中直接返回缓存文本，未命中则调用 build() 重算并回填。
 * 容量按 LRU 淘汰（默认 32 槽），避免 harness 多会话无界增长。
 * @param {{limit?: number, now?: () => number}} [options]
 */
export function createContextWarmCache(options = {}) {
    const limit = Math.max(1, Math.round(Number(options.limit) || 32));
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    /** @type {Map<string, {digest: string, text: string, at: number}>} */
    const slots = new Map();
    let hits = 0;
    let misses = 0;

    /**
     * 取稳定区文本：digest 命中复用，否则重算回填。
     * @param {string} key 会话 id（或能唯一标识一份稳定区的 key）
     * @param {string} digest 内容摘要（由调用方对「会影响稳定区的输入」算 contextDigest）
     * @param {() => string} build 未命中时的重算函数
     */
    function get(key, digest, build) {
        const k = String(key == null ? '' : key);
        const d = String(digest == null ? '' : digest);
        const cached = slots.get(k);
        if (cached && cached.digest === d && typeof cached.text === 'string') {
            hits += 1;
            // LRU：命中即移到末尾（最近使用）
            slots.delete(k);
            slots.set(k, cached);
            return cached.text;
        }
        misses += 1;
        const text = typeof build === 'function' ? String(build() || '') : '';
        slots.delete(k);
        slots.set(k, {digest: d, text, at: now()});
        while (slots.size > limit) {
            const oldest = slots.keys().next().value;
            if (oldest === undefined) break;
            slots.delete(oldest);
        }
        return text;
    }

    /** 主动失效某会话（工作区切换 / 设置变更时调用）。 */
    function invalidate(key) {
        return slots.delete(String(key == null ? '' : key));
    }

    function clear() {
        slots.clear();
    }

    return {
        get,
        invalidate,
        clear,
        has: (key) => slots.has(String(key == null ? '' : key)),
        get size() { return slots.size; },
        get stats() { return {hits, misses}; },
    };
}
