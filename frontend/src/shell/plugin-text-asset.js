// @ts-check
// plugin-text-asset.js：插件文本资产读取的解码层（纯函数，无 DOM，可单测）。
//
// Go 侧 ReadPluginAsset 返回 data URL（图片 + 数据文件共用一条通道，白名单见
// internal/plugins/plugins.go 的 pluginAssetMimeTypes / pluginDataAssetMimeTypes）。
// 插件要读随包的 SKILL.md / 脚本文本时，本模块负责「剥 data URL → base64 解码 →
// UTF-8 校验 → 大小闸」，让 cadt.readTextAsset 直接返回 string。
//
// 两个坑（写之前先想清楚，别踩）：
//   1. atob() 返回的是 Latin-1 字符串，直接当文本用会让中文全变乱码——必须转回
//      Uint8Array 再交给 TextDecoder('utf-8')。core/markdown.js 的 decodeMermaidSource
//      也是这个模式，但那个不校验 UTF-8、也没有大小闸，语义不同，故不复用。
//   2. TextDecoder 默认会把非法 UTF-8 静默替换成 U+FFFD；这里用 {fatal: true}
//      让非文本资产（被误当文本读的图片 / 二进制）明确报错，而不是给一串乱码。

/** 文本资产上限：1 MiB（脚本 / 技能足够，超过明确报错）。 */
export const MAX_TEXT_ASSET_BYTES = 1024 * 1024;

/**
 * 拆 data URL：只接受 `data:<mime>;base64,<payload>`（Go 侧固定这个形状）。
 * @param {string} dataUrl
 * @returns {{mime: string, base64: string}}
 */
export function decodeDataUrl(dataUrl) {
    const text = String(dataUrl == null ? '' : dataUrl);
    if (!text.startsWith('data:')) throw new Error('资产不是 data URL');
    const comma = text.indexOf(',');
    if (comma < 0) throw new Error('data URL 格式无效（缺少逗号）');
    const meta = text.slice(5, comma); // 去掉 'data:'
    if (!/;base64$/i.test(meta)) throw new Error('资产不是 base64 编码（拒绝非文本通道）');
    const mime = meta.slice(0, -';base64'.length).trim();
    const payload = text.slice(comma + 1);
    // 注意：空文件的 base64 载荷就是空串（Go 侧 EncodeToString([]byte("")) == ""），必须接受。
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) throw new Error('资产 base64 载荷无效');
    return {mime, base64: payload};
}

/**
 * data URL → UTF-8 文本。
 * @param {string} dataUrl ReadPluginAsset 的返回值
 * @param {number} [maxBytes] 大小上限，缺省 MAX_TEXT_ASSET_BYTES
 * @returns {string}
 */
export function dataUrlToText(dataUrl, maxBytes) {
    const {base64} = decodeDataUrl(dataUrl);
    let bin;
    try {
        bin = atob(base64);
    } catch (e) {
        throw new Error('资产 base64 解码失败：' + String((e && e && (/** @type {any} */ (e)).message) || e));
    }
    const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
        ? Math.floor(Number(maxBytes)) : MAX_TEXT_ASSET_BYTES;
    if (bin.length > limit) {
        throw new Error('文本资产过大（' + bin.length + ' 字节，上限 ' + limit + '）');
    }
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    try {
        // fatal:true —— 非 UTF-8 资产（图片 / 二进制被误读）明确报错
        return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    } catch (e) {
        throw new Error('文本资产不是合法 UTF-8（可能误读了二进制资产）');
    }
}
