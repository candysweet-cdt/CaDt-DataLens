// @ts-check
// core/kv-store.js：localStorage 的薄封装——只统一「读写不抛 + 配额/隐私模式降级」这一层。
// 各域的 key 命名、版本化、数据结构与迁移策略仍归各自模块（这里不认识任何业务 key，
// 也不做清理/过期策略），所以它是「取用方便」而不是「存储层」。
//
// 为什么需要它：浏览器在隐私模式 / 存储被策略禁用时，连 `localStorage.getItem` 都可能抛；
// 配额满时 setItem 抛 QuotaExceededError。散落的 try/catch 各写各的兜底返回值，
// 这里统一成「读不到给 null/fallback，写不进给 false」，调用方只需判断结果。

import {parseJson} from './json-safe.js';

// store 取 localStorage；访问本身也可能抛（隐私模式 / 策略禁用）。
function store() {
    try {
        return globalThis.localStorage || null;
    } catch (e) {
        return null;
    }
}

/**
 * kvGet 读原始字符串。
 * @param {string} key
 * @returns {string|null} 值；不存在或存储不可用时为 null
 */
export function kvGet(key) {
    const s = store();
    if (!s) return null;
    try {
        return s.getItem(key);
    } catch (e) {
        return null;
    }
}

/**
 * kvSet 写原始字符串。配额满 / 隐私模式下降级为 false（调用方决定是否提示）。
 * @param {string} key
 * @param {string} value
 * @returns {boolean} true = 已落盘
 */
export function kvSet(key, value) {
    const s = store();
    if (!s) return false;
    try {
        s.setItem(key, String(value));
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * kvRemove 删键；存储不可用或键不存在都返回 false，不抛。
 * @param {string} key
 * @returns {boolean} true = 删除成功
 */
export function kvRemove(key) {
    const s = store();
    if (!s) return false;
    try {
        s.removeItem(key);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * kvGetJson 按 JSON 读；空值 / 损坏值给 fallback（语义同 core/json-safe.js 的 parseJson）。
 * @param {string} key
 * @param {*} [fallback]
 * @returns {*}
 */
export function kvGetJson(key, fallback = null) {
    return parseJson(kvGet(key), fallback);
}

/**
 * kvSetJson JSON 化后写入；序列化失败（循环引用等）与写入失败都返回 false。
 * @param {string} key
 * @param {*} value
 * @returns {boolean} true = 已落盘
 */
export function kvSetJson(key, value) {
    let text;
    try {
        text = JSON.stringify(value);
    } catch (e) {
        return false;
    }
    if (text == null) return false; // undefined / 函数类型没有 JSON 表示
    return kvSet(key, text);
}
