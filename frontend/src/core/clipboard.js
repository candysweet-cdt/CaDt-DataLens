// @ts-check
// core/clipboard.js：文本剪贴板统一入口（图片走 core/image-clipboard.js）。
// 原先三处各写一套：main.js 只走 Go 绑定（backend.CopyText），外部工具页与 app-pages/ui-kit
// 只走 Web API（navigator.clipboard），失败文案也各不相同。
//
// 统一口径：**先试 Go 绑定，再退 Web API**。WebView2 里 Web API 在窗口失焦 / 权限受限时会失败，
// Go 侧（Win32 剪贴板）更可靠；反过来 Go 绑定缺失（老版本 exe、dev/mock 环境）时用 Web API 兜底。
// 两者都失败返回 false，由调用方决定提示（本模块不弹任何 UI）。

/**
 * copyTextToClipboard 把文本写入系统剪贴板。
 * @param {string} text 要复制的文本；空串直接返回 false（清空用户剪贴板没有意义）
 * @param {{goCopy?:(text:string)=>Promise<void>|void}} [options] goCopy = Go 侧复制绑定（可选）
 * @returns {Promise<boolean>} true = 已写入
 */
export async function copyTextToClipboard(text, options = {}) {
    const value = text == null ? '' : String(text);
    if (!value) return false;
    const goCopy = typeof options.goCopy === 'function' ? options.goCopy : null;
    if (goCopy) {
        try {
            await goCopy(value);
            return true;
        } catch (e) {
            // Go 侧不可用（绑定缺失 / IPC 失败）：静默退 Web API，失败原因由最终结果表达
        }
    }
    return writeWithWebApi(value);
}

// writeWithWebApi 走浏览器异步剪贴板；不可用 / 被拒（未聚焦、无权限）返回 false。
/**
 * @param {string} value 要写入的文本（调用方已确保非空）
 * @returns {Promise<boolean>}
 */
async function writeWithWebApi(value) {
    try {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return false;
        await navigator.clipboard.writeText(value);
        return true;
    } catch (e) {
        return false;
    }
}
