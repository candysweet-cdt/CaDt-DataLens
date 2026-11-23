// ai-image-policy.js：AI 图片三层限制的前端消费端——投影拉取 + 两层准入纯函数。
//
// 数值的单一真源在 Go 的 internal/aiimagepolicy（经 Wails 绑定 AIImageLimits 投影过来），
// 这里只做两件事：启动时把投影拉下来缓存，以及提供「源准入 / 请求预算」两层校验的纯函数。
// 内置 DEFAULT_IMAGE_LIMITS 是投影不可用（dev mock / 绑定未就绪）时的兜底快照，
// **数值必须与 internal/aiimagepolicy/policy.go 逐项一致**（改一处就要同步另一处）。
//
// 与 dsh 的对应关系：
//   - 源准入 ≡ dsh 的 maxImageBytes / maxMessageImageBytes（入口收大图，不在这里压）
//   - 归一化 ≡ 前端 canvas（ai-image-encode.js 的 fitImageSize / encodeCanvasPayload）
//   - 请求预算 ≡ dsh 的 maxMessageImageBytes 在请求层的形态（真正进模型的总量）
// 所有校验只返回结果、不 flash，提示文案与展示交给调用方（与 Go 侧 ValidateBatch 同序）。

// 与 Go internal/aiimagepolicy 镜像的默认值（Wails 绑定未就绪时的兜底）。
export const DEFAULT_IMAGE_LIMITS = Object.freeze({
    maxImagesPerMessage: 10,
    maxSourceImageBytes: 50 * 1024 * 1024,
    maxMessageSourceBytes: 200 * 1024 * 1024,
    maxImagePixels: 64000000,
    maxImageDimension: 65535,
    maxNormalizedDimension: 2048,
    maxNormalizedBase64: 4 * 1024 * 1024,
    maxRequestImageBytes: 32 * 1024 * 1024,
    mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
});

// 校验结果码：与 Go 侧 aiimagepolicy.ErrorCode 同名，便于前后端日志对齐排查。
export const IMAGE_POLICY_CODE = Object.freeze({
    TOO_MANY_IMAGES: 'TOO_MANY_IMAGES',
    SOURCES_TOO_LARGE: 'SOURCES_TOO_LARGE',
    REQUEST_IMAGES_TOO_LARGE: 'REQUEST_IMAGES_TOO_LARGE',
    // 源文件格式不在可解码范围（与体积问题分开，排障时能一眼区分）
    UNSUPPORTED_SOURCE_TYPE: 'UNSUPPORTED_SOURCE_TYPE',
});

// 源准入可接受的 MIME：比归一化白名单宽——bmp / svg 不在 AI_IMAGE_MIMES 里，
// 但画布能把它们统一转成 png / jpeg（见 ai-image-encode.js 的注释），
// 所以源层必须放行，否则「转码后可用」的图会在入口就被拒。
// image/jpg 是非标准写法（下游 aiNormalizeImage 会映射成 image/jpeg），一并放行。
const SOURCE_EXTRA_MEDIA_TYPES = ['image/bmp', 'image/svg+xml', 'image/jpg', 'image/x-ms-bmp'];

// 把后端投影归一化成前端可用的形状：缺字段回落到默认值，mediaTypes 保证是数组。
// 远端/绑定返回 null 或字段残缺都不能让前端拿到 undefined 阈值（会导致比较恒 false）。
export function normalizeImageLimits(raw) {
    const base = DEFAULT_IMAGE_LIMITS;
    if (!raw || typeof raw !== 'object') return base;
    const pick = (key) => {
        const value = Number(raw[key]);
        return Number.isFinite(value) && value > 0 ? value : base[key];
    };
    const mediaTypes = Array.isArray(raw.mediaTypes) && raw.mediaTypes.length
        ? raw.mediaTypes.filter((mime) => typeof mime === 'string' && mime)
        : Array.from(base.mediaTypes);
    return {
        maxImagesPerMessage: pick('maxImagesPerMessage'),
        maxSourceImageBytes: pick('maxSourceImageBytes'),
        maxMessageSourceBytes: pick('maxMessageSourceBytes'),
        maxImagePixels: pick('maxImagePixels'),
        maxImageDimension: pick('maxImageDimension'),
        maxNormalizedDimension: pick('maxNormalizedDimension'),
        maxNormalizedBase64: pick('maxNormalizedBase64'),
        maxRequestImageBytes: pick('maxRequestImageBytes'),
        mediaTypes,
    };
}

// 投影仓库：load() 拉一次，get() 供各处读取。绑定缺失不是错误——静默用默认值。
// 与 dsh「投影键缺席 = 不预检」的差别：这里改用内置快照兜底，因为 CaDt 的阈值恒有值。
export function createImagePolicyStore(deps) {
    const backend = deps && deps.backend ? deps.backend : {};
    let limits = DEFAULT_IMAGE_LIMITS;
    let loaded = false;
    let pending = null;

    async function load() {
        const call = backend.AIImageLimits;
        if (typeof call !== 'function') return limits;
        // 并发调用合并成一次（面板 init 与设置页可能同时触发）
        if (pending) return pending;
        pending = Promise.resolve()
            .then(() => call())
            .then((raw) => {
                limits = normalizeImageLimits(raw);
                loaded = true;
                return limits;
            })
            .catch(() => limits)
            .finally(() => { pending = null; });
        return pending;
    }

    return {
        load,
        get: () => limits,
        isLoaded: () => loaded,
        // 测试与边界演练用：直接替换当前限制
        set: (next) => { limits = normalizeImageLimits(next); },
    };
}

function bytesOf(saved) {
    const data = saved && saved.data;
    return typeof data === 'string' ? data.length : 0;
}

// 源准入层校验：入口（粘贴 / 拖拽 / 文件对话框）在解码前调用。
// existing 为当前已附加的图片（已归一化的载荷，用它取源字节不现实——这里只数张数），
// incoming 为待加入的原始文件（{size, type}），按文件名/大小/类型判断。
// 返回 {ok:true} 或 {ok:false, code, reason}。
export function checkSourceBatch(limits, existingImages, incoming) {
    const list = limits || DEFAULT_IMAGE_LIMITS;
    const current = Array.isArray(existingImages) ? existingImages.length : 0;
    const files = Array.isArray(incoming) ? incoming : [];
    if (!files.length) return {ok: true};
    if (current + files.length > list.maxImagesPerMessage) {
        return {
            ok: false,
            code: IMAGE_POLICY_CODE.TOO_MANY_IMAGES,
            reason: '每条消息最多附加 ' + list.maxImagesPerMessage + ' 张图片',
        };
    }
    const mediaTypes = list.mediaTypes || [];
    // 源层白名单 = 归一化白名单 + 画布能转码的格式（bmp/svg/jpg 别名）。
    const sourceTypes = mediaTypes.length ? mediaTypes.concat(SOURCE_EXTRA_MEDIA_TYPES) : [];
    let total = 0;
    for (const file of files) {
        const size = Number(file && file.size) || 0;
        if (size > list.maxSourceImageBytes) {
            return {
                ok: false,
                code: IMAGE_POLICY_CODE.SOURCES_TOO_LARGE,
                reason: '单张图片源文件超过 ' + Math.round(list.maxSourceImageBytes / (1024 * 1024)) + ' MB 上限',
            };
        }
        const type = String((file && (file.type || file.mime)) || '').toLowerCase();
        // 类型已知时才按白名单拦；未知（浏览器没给 type）交给后端魔数判定，不在这里误杀。
        if (type && sourceTypes.length && !sourceTypes.includes(type)) {
            return {
                ok: false,
                code: IMAGE_POLICY_CODE.UNSUPPORTED_SOURCE_TYPE,
                reason: '不支持的图片格式：' + type,
            };
        }
        total += size;
    }
    if (total > list.maxMessageSourceBytes) {
        return {
            ok: false,
            code: IMAGE_POLICY_CODE.SOURCES_TOO_LARGE,
            reason: '图片源文件合计超过 ' + Math.round(list.maxMessageSourceBytes / (1024 * 1024)) + ' MB 上限',
        };
    }
    return {ok: true};
}

// 请求预算层校验：图片已归一化成 {mime, data(base64), bytes...}，在组装请求前调用。
// 单张超归一化上限、合计超请求预算是两条独立红线（与 Go ValidateBatch 同序）。
export function checkRequestBudget(limits, images) {
    const list = limits || DEFAULT_IMAGE_LIMITS;
    const items = Array.isArray(images) ? images : [];
    if (!items.length) return {ok: true};
    let total = 0;
    for (let i = 0; i < items.length; i += 1) {
        const size = bytesOf(items[i]);
        if (size > list.maxNormalizedBase64) {
            return {
                ok: false,
                code: IMAGE_POLICY_CODE.REQUEST_IMAGES_TOO_LARGE,
                reason: '第 ' + (i + 1) + ' 张图片编码后超过 ' +
                    Math.round(list.maxNormalizedBase64 / (1024 * 1024)) + ' MB 上限',
            };
        }
        total += size;
    }
    if (total > list.maxRequestImageBytes) {
        return {
            ok: false,
            code: IMAGE_POLICY_CODE.REQUEST_IMAGES_TOO_LARGE,
            reason: '图片编码后合计超过 ' + Math.round(list.maxRequestImageBytes / (1024 * 1024)) +
                ' MB 上限，请减少图片或先发送当前消息',
        };
    }
    return {ok: true};
}
