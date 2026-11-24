// @ts-check
// core/dom.js：最小 DOM 工厂。
// `el(tag, cls, text)` 原本在十几个模块里各写一遍、实现逐字一致
// （cls 为空串/falsy 时跳过、text 为 null 或 undefined 时不设置），这里只留一份。
// 只做「建元素 + 类名 + 文本」，不要再往里加属性/事件/结构糖——
// 需要更多时用 core/form-controls.js 或就地写清楚，避免变成一个谁都不敢改的全能工厂。

/**
 * el 创建一个元素。
 * @param {string} tag 标签名
 * @param {string} [cls] className；空串 / 未传时不设置
 * @param {string|number} [text] textContent；null / undefined 时不设置（≠空串：空串会设成空文本）
 * @returns {HTMLElement}
 */
export function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    // textContent 的 setter 只收 string；这里显式 String() 与原先「传 number 靠 setter 隐式转换」等价。
    if (text != null) node.textContent = String(text);
    return node;
}
