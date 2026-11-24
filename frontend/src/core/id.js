// @ts-check
// core/id.js：短 id 统一生成（前缀 + 36 进制时间戳 + 可选分隔符 + 随机后缀）。
// 原先 ai / reading / settings / core 各写一遍 `Date.now().toString(36) + Math.random()...`，
// 后缀位数与分隔符各不相同；这里把「形状」收成两个参数，业务里不要再手拼。
// 注意：id 会落到 JSONL / localStorage / 设置里，形状只能等价搬运，不要顺手改位数。

const BASE36 = 36;
const DEFAULT_SUFFIX_LENGTH = 6;

/**
 * randomIdSuffix 生成 base36 随机后缀，最多 len 位。
 * 与原先 `Math.random().toString(36).slice(2, 2 + len)` 逐字等价（含「不足 len 位时更短」的边界）。
 * @param {number} [len] 后缀位数上限，默认 6
 * @returns {string}
 */
export function randomIdSuffix(len = DEFAULT_SUFFIX_LENGTH) {
    const n = Math.max(0, Math.round(Number(len) || 0));
    if (!n) return '';
    return Math.random().toString(BASE36).slice(2, 2 + n);
}

/**
 * newId 生成短 id：`prefix + 时间戳36 + sep + 随机后缀`。
 * @param {string} [prefix] 前缀；前缀自带分隔符（`'rp-'`）时 sep 传空
 * @param {{sep?: string, suffixLength?: number}} [options] sep 默认空串，后缀默认 6 位
 * @returns {string}
 */
export function newId(prefix = '', options = {}) {
    const sep = typeof options.sep === 'string' ? options.sep : '';
    const suffixLength = options.suffixLength == null ? DEFAULT_SUFFIX_LENGTH : options.suffixLength;
    return String(prefix) + Date.now().toString(BASE36) + sep + randomIdSuffix(suffixLength);
}
