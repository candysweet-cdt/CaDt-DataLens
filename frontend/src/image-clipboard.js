// 图片写入系统剪贴板：Chromium 的异步剪贴板只接受 image/png，
// 其他格式先转 PNG；能力缺失或用户未聚焦时返回 false，由调用方决定提示。

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = url;
    });
}

export async function blobToPngBlob(blob) {
    if (!blob) return null;
    if (blob.type === 'image/png') return blob;
    const url = URL.createObjectURL(blob);
    try {
        const img = await loadImage(url);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, img.naturalWidth || img.width || 1);
        canvas.height = Math.max(1, img.naturalHeight || img.height || 1);
        canvas.getContext('2d').drawImage(img, 0, 0);
        return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    } finally {
        URL.revokeObjectURL(url);
    }
}

export async function copyImageBlobToClipboard(blob) {
    if (!navigator.clipboard || !window.ClipboardItem) return false;
    try {
        const png = await blobToPngBlob(blob);
        if (!png) return false;
        await navigator.clipboard.write([new ClipboardItem({'image/png': png})]);
        return true;
    } catch (e) {
        return false;
    }
}

export async function copyImageUrlToClipboard(url) {
    if (!url) return false;
    try {
        const resp = await fetch(url);
        return await copyImageBlobToClipboard(await resp.blob());
    } catch (e) {
        return false;
    }
}
