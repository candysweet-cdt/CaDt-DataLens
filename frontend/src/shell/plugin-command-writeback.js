// plugin-command-writeback.js：插件命令 run(env) 返回值的写回意图解析（纯逻辑，无 DOM，可单测）。
//
// addCommand 的 run 现在可以返回 {replaceSelection, insertText, openVirtualDoc} 表达写回意图；
// 本模块只做「把返回值归一化成可信的写回意图」，真正的文本替换 / 脏标记由宿主（main.js +
// editor 既有通道）执行——插件永远碰不到 doc 内容与脏标记本身。
// 不返回写回意图（字符串 / undefined / 其它对象）一律当「命令已自行处理」，宿主不干预。

/**
 * @typedef {object} WritebackIntent
 * @property {'replaceSelection'|'insertText'|'openVirtualDoc'|'none'} kind
 * @property {string} [text]
 * @property {string} [name]
 */

/**
 * 解析命令返回值。只认明确的写回意图字段，避免把普通返回值误当写回。
 * @param {any} result run(env) 的返回值（允许 Promise，由调用方 await 后传入）
 * @returns {WritebackIntent}
 */
export function parseCommandWriteback(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return {kind: 'none'};
    if (typeof result.replaceSelection === 'string') {
        return {kind: 'replaceSelection', text: result.replaceSelection};
    }
    if (typeof result.insertText === 'string') {
        return {kind: 'insertText', text: result.insertText};
    }
    if (result.openVirtualDoc && typeof result.openVirtualDoc === 'object') {
        const name = String(result.openVirtualDoc.name == null ? '' : result.openVirtualDoc.name).trim();
        const text = String(result.openVirtualDoc.content == null ? '' : result.openVirtualDoc.content);
        if (name && text) return {kind: 'openVirtualDoc', name, text};
    }
    return {kind: 'none'};
}

/** 写回意图是否需要当前有编辑器/选区（宿主据此决定要不要拦截）。 */
export function writebackNeedsEditor(intent) {
    return intent.kind === 'replaceSelection' || intent.kind === 'insertText';
}
