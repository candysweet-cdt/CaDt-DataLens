// ai-image-encode.js：图片载荷编码的单一来源——任意来源（File/Blob 或 data URL）→
// 「能进对话」的 {mime, data, width, height, bytes, name}。
// 输入框附加图片（ai-composer.prepareImageAttachment）与 read_image 工具共用同一条
// 降采样 / 压缩链：阈值与降质策略保持一份实现，两处行为不可能走偏。
// 纯函数（fitImageSize / encodeCanvasPayload / isReadableImagePath）与 DOM 相关的
// 解码（createImageBitmap / Image / canvas）分开，便于 ai-image-encode.test.mjs 用假画布测。
import {AI_IMAGE_MAX_BASE64, AI_IMAGE_MAX_DIM} from '../core/ai-constants.js';

// 后端 ReadImageAsDataURL 认的扩展名（internal/fileio/fileio.go 的 imageMimeByExtension）：png / jpg / jpeg / gif / webp / bmp / svg。
// 其中 bmp / svg 不在 AI_IMAGE_MIMES 里，交给画布统一转成 png / jpeg。
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

export function isReadableImagePath(path) {
    return IMAGE_EXT_RE.test(String(path || '').trim());
}

// 等比缩放：长边不超过 maxDim（永不放大）。宽高未知（svg 无固有尺寸时为 0）按上限兜底，
// 否则画布宽高会变 NaN 直接抛错。
export function fitImageSize(width, height, maxDim) {
    const limit = Math.max(1, Math.round(Number(maxDim) || AI_IMAGE_MAX_DIM));
    const w = Number(width) > 0 ? Number(width) : 0;
    const h = Number(height) > 0 ? Number(height) : 0;
    if (!w && !h) return {width: limit, height: limit, scale: 1};
    const longest = Math.max(w, h);
    const scale = longest > limit ? limit / longest : 1;
    return {
        width: Math.max(1, Math.round(w * scale)),
        height: Math.max(1, Math.round(h * scale)),
        scale,
    };
}

// 画布编码：先 PNG（保透明与无损），超预算再转 JPEG 逐级降质（0.86 起，最低 0.45）。
// 与改造前 ai-composer 的内联实现完全一致，不要把质量序列改成别的值——两处共用同一条链。
export function encodeCanvasPayload(canvas, maxBase64) {
    const budget = Number(maxBase64) || AI_IMAGE_MAX_BASE64;
    let mime = 'image/png';
    let dataUrl = canvas.toDataURL('image/png');
    if (dataUrl.length > budget) {
        mime = 'image/jpeg';
        let quality = 0.86;
        dataUrl = canvas.toDataURL(mime, quality);
        while (dataUrl.length > budget && quality > 0.45) {
            quality -= 0.1;
            dataUrl = canvas.toDataURL(mime, quality);
        }
    }
    if (dataUrl.length > budget) throw new Error('压缩后图片仍然过大');
    const comma = dataUrl.indexOf(',');
    if (comma < 0) throw new Error('图片编码失败');
    const base64 = dataUrl.slice(comma + 1);
    return {mime, data: base64, bytes: Math.round(base64.length * 3 / 4)};
}

// 画到画布并按预算编码。source 可为 ImageBitmap / HTMLImageElement；createCanvas 可注入
// （测试用），缺省 document.createElement('canvas')。
export function drawImagePayload(source, width, height, opts) {
    const options = opts || {};
    const createCanvas = options.createCanvas || ((w, h) => {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        return canvas;
    });
    const size = fitImageSize(width, height, options.maxDim);
    const canvas = createCanvas(size.width, size.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建图片画布');
    ctx.drawImage(source, 0, 0, size.width, size.height);
    const encoded = encodeCanvasPayload(canvas, options.maxBase64);
    return {
        mime: encoded.mime,
        data: encoded.data,
        bytes: encoded.bytes,
        width: size.width,
        height: size.height,
        name: String(options.name || ''),
    };
}

function isBlobLike(value) {
    return !!value && typeof value === 'object' && typeof value.arrayBuffer === 'function' &&
        typeof value.size === 'number' && typeof value.type === 'string';
}

function loadImageElement(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('无法读取图片'));
        img.src = src;
    });
}

// 解压炸弹防护：一张几十 KB 的 PNG 可以解出上亿像素，直接把 WebView2 渲染进程内存打爆。
// 解码拿到真实宽高后按投影阈值（maxImagePixels / maxImageDimension）拒收，
// 检查放在解码之后、画布绘制之前——解码本身不可避免，但不再往画布上画。
function assertDecodedSize(width, height, opts) {
    const options = opts || {};
    const maxPixels = Number(options.maxPixels) || 0;
    const maxDimension = Number(options.maxDimension) || 0;
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    if (maxDimension > 0 && (w > maxDimension || h > maxDimension)) {
        throw new Error('图片边长超过上限（' + maxDimension + 'px）');
    }
    if (maxPixels > 0 && w * h > maxPixels) {
        throw new Error('图片像素总数超过上限（' + maxPixels + '）');
    }
}

// 解码成可画到画布的东西。Blob 走 createImageBitmap（无则回退 Image + objectURL），
// data URL 走 Image（Chromium 能直接解 bmp / svg）。close 负责释放位图与 objectURL。
async function decodeSource(source, opts) {
    const options = opts || {};
    if (isBlobLike(source)) {
        const maxBytes = Number(options.maxInputBytes) || 0;
        if (maxBytes && source.size > maxBytes) {
            throw new Error('图片超过 ' + Math.round(maxBytes / (1024 * 1024)) + 'MB');
        }
        const createBitmap = globalThis.createImageBitmap;
        if (typeof createBitmap === 'function') {
            const bitmap = await createBitmap(source);
            assertDecodedSize(bitmap.width, bitmap.height, options);
            return {
                image: bitmap,
                width: bitmap.width,
                height: bitmap.height,
                close: () => { if (typeof bitmap.close === 'function') bitmap.close(); },
            };
        }
        const url = URL.createObjectURL(source);
        try {
            const img = await loadImageElement(url);
            assertDecodedSize(img.naturalWidth || img.width, img.naturalHeight || img.height, options);
            return {
                image: img,
                width: img.naturalWidth || img.width,
                height: img.naturalHeight || img.height,
                close: () => URL.revokeObjectURL(url),
            };
        } catch (e) {
            URL.revokeObjectURL(url);
            throw e;
        }
    }
    const dataUrl = String(source || '').trim();
    if (!/^data:[^,]+,/i.test(dataUrl)) throw new Error('不是有效的图片数据');
    const img = await loadImageElement(dataUrl);
    assertDecodedSize(img.naturalWidth || img.width, img.naturalHeight || img.height, options);
    return {
        image: img,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        close: () => {},
    };
}

// 主入口：File / Blob / data URL → 对话能吃的载荷。
// opts: {maxDim, maxBase64, maxInputBytes, name, createCanvas}
export async function prepareImagePayload(source, opts) {
    if (source == null) throw new Error('没有图片数据');
    const options = opts || {};
    const decoded = await decodeSource(source, options);
    try {
        return drawImagePayload(decoded.image, decoded.width, decoded.height, options);
    } finally {
        decoded.close();
    }
}
