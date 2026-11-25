// drop-mime.js：应用内文件拖拽（文件树 → 编辑区 / AI 面板 / 数据库面板）的自定义 MIME 与路径编解码。
//
// 为什么不用现成的 text/plain：普通文本拖拽（从编辑器选中文字拖出来）也是 text/plain，
// 落点无法区分「文件树拖出的本地文件」和「一段恰好长得像路径的文本」。自定义 MIME 是精确标记，
// 只对带它的拖拽显示落点遮罩、走文件路由；text/plain 仍保留给文件树内部移动与编辑器文本拖拽。
//
// 依赖方向：explorer/ 与 shell/ 都 import 这个 core 叶子模块，互不反向依赖。

export const INTERNAL_PATHS_MIME = 'application/x-cadt-paths';

/** encodeDropPaths 把路径数组编进 dataTransfer（拖起时调用）。 */
export function encodeDropPaths(paths) {
    try {
        return JSON.stringify(Array.isArray(paths) ? paths : []);
    } catch (e) {
        return '[]';
    }
}

/** decodeDropPaths 从 dataTransfer 读回路径（drop 时调用；dragover 阶段 getData 通常为空）。 */
export function decodeDropPaths(raw) {
    try {
        const arr = JSON.parse(String(raw || ''));
        return Array.isArray(arr) ? arr.filter((p) => typeof p === 'string' && p.trim()) : [];
    } catch (e) {
        return [];
    }
}
