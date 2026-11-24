// @ts-check
// core/json-safe.js：容错的 JSON 解析唯一入口。
// 原先几十处各写 `try { JSON.parse(x || '[]') } catch { … }`——空串靠 `|| 默认值` 兜、
// 坏数据靠 catch 兜，两套兜底交织。这里统一成「空输入 → fallback，解析失败 → fallback」。
// 只做「读数据」，不要拿它当深层拷贝（JSON 往返会丢函数/undefined/Date），也不要拿它做校验：
// 需要形状校验的调用方自己判（typeof / Array.isArray / 字段检查），别把校验塞进来。

/**
 * parseJson 安全解析 JSON 文本。
 * @param {string|null|undefined} text 待解析文本；null / undefined / 空串按「无内容」处理
 * @param {*} [fallback] 解析不出来时的返回值（默认 null）
 * @returns {*} 解析结果或 fallback
 */
export function parseJson(text, fallback = null) {
    if (text == null) return fallback;
    const raw = typeof text === 'string' ? text : String(text);
    if (!raw) return fallback;
    try {
        return JSON.parse(raw);
    } catch (e) {
        return fallback;
    }
}
