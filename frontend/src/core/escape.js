// @ts-check
// escape.js：HTML 文本转义唯一来源（5 实体全转，含单引号，属性上下文安全）。
// 替代此前散落在 ai/settings/bridge/reading 等域的 6 份拷贝——其中 3 份漏转单引号，
// 在拼 innerHTML 的属性上下文里可被逃逸。需要给模型看的 XML 转义语义不同，不要用这里。

/**
 * escapeHtml 转义 HTML 文本。
 * @param {unknown} text 任意值；null / undefined 按空串处理
 * @returns {string}
 */
export function escapeHtml(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
