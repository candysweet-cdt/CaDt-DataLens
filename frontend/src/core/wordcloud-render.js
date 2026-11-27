// wordcloud-render.js：```wordcloud 词云 → 静态 SVG（方案阶段 6）。
// 首选 echarts-wordcloud（16 KiB）SSR——它的排布是 setTimeout 异步过程，必须轮询到产物含
// <text> 再取值（同步取只会得到空场景）；超时或环境缺 canvas 时退 d3-cloud（34 KiB）只算
// 布局、应用自拼 SVG，最后还有不依赖 canvas 的纯函数螺旋布局兜底。
// 三条路都不产生可执行代码、不放宽边界。

import {resolveThemeColors} from './visual-spec.js';
import {createLruCache} from './render-cache.js';

export const WORDCLOUD_LIMITS = {maxWords: 120, minFont: 11, maxFont: 34};

const cache = createLruCache(30);

// validateWordCloudSpec 校验 ```wordcloud 的 JSON（纯函数，供测试）。
// words 非空 ≤120；text 非空字符串；value 缺省 1、负值按 1 处理。
export function validateWordCloudSpec(text) {
    let spec;
    try {
        spec = JSON.parse(String(text || ''));
    } catch (e) {
        return {ok: false, error: 'wordcloud 不是合法 JSON：' + ((e && e.message) || e)};
    }
    if (!spec || typeof spec !== 'object' || !Array.isArray(spec.words) || !spec.words.length) {
        return {ok: false, error: 'words 必须是非空数组'};
    }
    if (spec.words.length > WORDCLOUD_LIMITS.maxWords) {
        return {ok: false, error: '词超过上限（' + WORDCLOUD_LIMITS.maxWords + '）'};
    }
    const words = [];
    for (const raw of spec.words) {
        if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string' || !raw.text.trim()) {
            return {ok: false, error: '每个词都要有非空字符串 text'};
        }
        let value = 1;
        if (raw.value != null && Number.isFinite(Number(raw.value))) {
            value = Math.max(1, Number(raw.value));
        }
        words.push({text: raw.text, value});
    }
    return {ok: true, words};
}

// paletteFor 按权重排名给色：权重高靠前（accent 优先），主题注入具体色值。
export function paletteFor(sortedWords, colors) {
    const palette = [colors.accent, colors.green, colors.warn, colors.red, colors.muted];
    return new Map(sortedWords.map((w, i) => [
        w.text,
        palette[Math.min(palette.length - 1, Math.floor((i / Math.max(1, sortedWords.length)) * palette.length))],
    ]));
}

// estimateTextWidth 粗估单行词宽（px，纯函数）：CJK / 全角按 1em，其余按 0.55em。
// 用于无 canvas 环境下的布局碰撞与 viewBox 边界——宁可略宽，也不要压字或被裁掉。
export function estimateTextWidth(text, size) {
    let em = 0;
    for (const ch of String(text == null ? '' : text)) {
        em += (ch.codePointAt(0) || 0) > 0x2e7f ? 1 : 0.55;
    }
    return Math.max(1, em) * Math.max(1, size);
}

function rectsOverlap(a, b) {
    return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

// packWordCloudLayout 不依赖 canvas 的兜底布局（纯函数，供测试）。
// 按传入顺序（权重降序）做阿基米德螺旋放置 + 矩形碰撞检测；螺旋内找不到位置的词
// 堆到已放置区域下方，保证每个词都出现。返回 [{text, size, x, y}]，
// 坐标以画布中心为原点（与 d3-cloud 的 place() 一致）。
export function packWordCloudLayout(words, size) {
    const width = (size && size[0]) || 640;
    const height = (size && size[1]) || 360;
    const pad = 3;
    const placed = [];
    let bottom = -Infinity;
    for (const w of words || []) {
        const boxW = estimateTextWidth(w.text, w.size) + pad * 2;
        const boxH = w.size * 1.15 + pad * 2;
        let hit = null;
        const maxR = Math.max(width, height);
        for (let step = 0; step < 4000; step++) {
            const t = step * 0.4;
            const r = 2.6 * t;
            if (r > maxR) break;
            // 词是横排的，横向拉宽以贴合 16:9 画布
            const x = Math.cos(t) * r * 1.6;
            const y = Math.sin(t) * r * 0.9;
            const rect = {x0: x - boxW / 2, y0: y - boxH / 2, x1: x + boxW / 2, y1: y + boxH / 2};
            if (!placed.some((p) => rectsOverlap(p.rect, rect))) {
                hit = {x, y, rect};
                break;
            }
        }
        if (!hit) {
            const y = bottom + boxH / 2 + pad;
            hit = {x: 0, y, rect: {x0: -boxW / 2, y0: y - boxH / 2, x1: boxW / 2, y1: y + boxH / 2}};
        }
        placed.push({
            text: w.text, size: w.size, x: Math.round(hit.x), y: Math.round(hit.y),
            rect: {
                x0: Math.round(hit.x) - boxW / 2, y0: Math.round(hit.y) - boxH / 2,
                x1: Math.round(hit.x) + boxW / 2, y1: Math.round(hit.y) + boxH / 2,
            },
        });
        bottom = Math.max(bottom, hit.rect.y1);
    }
    return placed.map((p) => ({text: p.text, size: p.size, x: p.x, y: p.y}));
}

// sizedWords 把 {text,value} 线性映射成字号 {text,size}（纯函数，供测试）。
export function sizedWords(sorted) {
    const max = sorted[0] ? sorted[0].value : 1;
    const min = sorted.length > 1 ? sorted[sorted.length - 1].value : max;
    const span = Math.max(1e-9, max - min);
    return sorted.map((w) => ({
        text: w.text,
        size: WORDCLOUD_LIMITS.minFont +
            Math.round(((w.value - min) / span) * (WORDCLOUD_LIMITS.maxFont - WORDCLOUD_LIMITS.minFont)),
    }));
}

// assembleWordCloudSvg 用给定坐标拼静态 SVG（纯函数，供测试）。
// layout: [{text, size, x, y}]（x/y 为词中心点，rotate 恒 0——横向可读性优先）。
// viewBox 按实际词边界 + 内边距计算，避免 d3-cloud 溢出 640×360 时被裁掉。
export function assembleWordCloudSvg(layout, colors) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const w of layout) {
        const halfW = Math.max(12, estimateTextWidth(w.text, w.size) / 2);
        minX = Math.min(minX, w.x - halfW); maxX = Math.max(maxX, w.x + halfW);
        minY = Math.min(minY, w.y - w.size); maxY = Math.max(maxY, w.y + w.size);
    }
    const pad = 12;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const sorted = layout.slice().sort((a, b) => b.size - a.size);
    const palette = paletteFor(sorted, colors);
    const parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + Math.round(minX) + ' ' + Math.round(minY) + ' ' +
        Math.round(maxX - minX) + ' ' + Math.round(maxY - minY) +
        '" role="img" aria-label="词云：' + layout.length + ' 个词">');
    parts.push('<title>词云</title>');
    for (const w of layout) {
        const fill = palette.get(w.text) || colors.text;
        parts.push('<text x="' + Math.round(w.x) + '" y="' + Math.round(w.y) +
            '" font-size="' + Math.round(w.size) + '" text-anchor="middle" dominant-baseline="central"' +
            ' fill="' + fill + '">' + escapeText(w.text) + '</text>');
    }
    parts.push('</svg>');
    return parts.join('');
}

function escapeText(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let echartsLoadPromise = null;
function ensureEcharts() {
    if (window.echarts) return Promise.resolve(window.echarts);
    if (echartsLoadPromise) return echartsLoadPromise;
    echartsLoadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/vendor/echarts/echarts.min.js';
        script.onload = () => {
            if (!window.echarts) { echartsLoadPromise = null; reject(new Error('echarts 库加载失败')); return; }
            resolve(window.echarts);
        };
        script.onerror = () => { echartsLoadPromise = null; reject(new Error('echarts 库加载失败')); };
        document.head.appendChild(script);
    });
    return echartsLoadPromise;
}

// 已成功加载过的脚本：插件类脚本没有可靠的全局标记（echarts-wordcloud 只是往
// echarts 注册 series 类型），只能靠这份集合去重。
const loadedScripts = new Set();

function loadScript(src, globalCheck) {
    if (loadedScripts.has(src)) return Promise.resolve();
    if (typeof globalCheck === 'function' && globalCheck()) {
        loadedScripts.add(src);
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => {
            // 有 globalCheck 就按它判定；没有（插件类）按「脚本执行完即成功」。
            if (typeof globalCheck === 'function' && !globalCheck()) {
                reject(new Error(src + ' 加载失败'));
                return;
            }
            loadedScripts.add(src);
            resolve();
        };
        script.onerror = () => reject(new Error(src + ' 加载失败'));
        document.head.appendChild(script);
    });
}

// renderWordCloudToSvg：校验 → SSR 出图（检查含 <text>）→ 失败退 d3-cloud 布局自拼。
export async function renderWordCloudToSvg(code, themeId) {
    const {ok, words, error} = validateWordCloudSpec(code);
    if (!ok) throw new Error(error);
    const cacheKey = (themeId || '') + ':' + code;
    const hit = cache.get(cacheKey);
    if (hit !== undefined) return hit;
    const colors = resolveThemeColors();
    const sorted = words.slice().sort((a, b) => b.value - a.value);
    const palette = paletteFor(sorted, colors);
    try {
        const echarts = await ensureEcharts();
        // echarts-wordcloud 注册 series 类型，没有独立全局可查：以前这里传
        // () => !!window.echarts，而 ensureEcharts 刚让它为真 → globalCheck 恒真，
        // 脚本永不注入，setOption 必抛错后落到 d3-cloud 兜底（插件成了死代码）。
        // 传 undefined 表示「按脚本自身的加载成功判定」，再用 loadedScripts 去重。
        await loadScript('/vendor/wordcloud/echarts-wordcloud.min.js');
        // 词多的时候放大画布，避免 echarts 放不下而静默丢词（卡片会按宽度自适应缩放）
        const canvasW = sorted.length > 40 ? 960 : 640;
        const canvasH = sorted.length > 40 ? 540 : 360;
        const chart = echarts.init(null, null, {renderer: 'svg', ssr: true, width: canvasW, height: canvasH});
        let svg;
        try {
            chart.setOption({
                silent: true,
                animation: false,
                series: [{
                    type: 'wordCloud',
                    shape: 'circle',
                    width: '100%',
                    height: '100%',
                    sizeRange: [WORDCLOUD_LIMITS.minFont, WORDCLOUD_LIMITS.maxFont],
                    rotationRange: [0, 0],
                    gridSize: 4,
                    layoutAnimation: false,
                    textStyle: {fontFamily: 'inherit'},
                    data: sorted.map((w) => ({
                        name: w.text,
                        value: w.value,
                        // SSR 产物是静态色值，拿不到 CSS 变量：这里显式注入主题色
                        textStyle: {color: palette.get(w.text)},
                    })),
                }],
            });
            svg = chart.renderToSVGString();
            // echarts-wordcloud 的逐词排布是 setTimeout 驱动的异步过程（库里 rAF 出现 0 次、
            // setTimeout 3 次），renderToSVGString 是同步快照——setOption 后立刻取图只会
            // 拿到空场景（实测 233 B、无 <text>）。轮询到产物真画出词再返回，超时退回兜底布局。
            const deadline = Date.now() + 1500;
            while (!/<text[\s>]/i.test(svg) && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 60));
                svg = chart.renderToSVGString();
            }
        } finally {
            chart.dispose();
        }
        // SSR 兼容性检查：产物必须真画出词（含 <text>），否则退 d3-cloud 自拼
        if (!/<text[\s>]/i.test(svg)) throw new Error('SSR 产物不含文本');
        if (/<script/i.test(svg)) throw new Error('SSR 产物包含脚本，已拒绝');
        cache.set(cacheKey, svg);
        return svg;
    } catch (e) {
        // 尽力而为路径：SSR 出图失败/超时（或在缺少 canvas 的环境）才走这里，
        // d3-cloud 只算布局、应用自拼 SVG
        console.debug('[wordcloud] echarts SSR 不可用，改用布局兜底：', (e && e.message) || e);
    }
    const layout = await layoutWithD3Cloud(sorted);
    const svg = assembleWordCloudSvg(layout, colors);
    cache.set(cacheKey, svg);
    return svg;
}

// layoutWithD3Cloud 用 d3-cloud 算 {text, size, x, y} 布局；库不可用或放不全时退纯函数兜底。
// 注意：public/vendor/wordcloud/d3-cloud.js 是新版 CloudLayout（命令式 API：
// canvas/size/random/getSprite/place），没有 v1 的 words()/fontSize()/on('end')/start()；
// 按 v1 调用会直接抛 TypeError。
async function layoutWithD3Cloud(sorted) {
    const words = sizedWords(sorted);
    let CloudLayout = null;
    try {
        // @vite-ignore + 运行时拼接：d3-cloud 是 public/ 下的 ES module（不进 Vite 依赖图），
        // 字面量 import 会被 Rollup 当构建期依赖解析而构建失败。
        const url = '/vendor/wordcloud/' + 'd3-cloud.js';
        const mod = await import(/* @vite-ignore */ url);
        CloudLayout = mod.CloudLayout || mod.default || null;
    } catch (e) {
        CloudLayout = null; // 尽力而为：库加载失败就走纯函数兜底
    }
    if (CloudLayout) {
        try {
            // 固定随机序列：同输入得到同布局，卡片缓存与视觉都稳定
            let seed = 20241113;
            const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
            const layout = new CloudLayout().size([640, 360]).random(random);
            const placed = [];
            for (const w of words) {
                const sprite = layout.getSprite(w.text, {size: w.size, padding: 3, rotate: 0});
                const hit = sprite ? layout.place(sprite) : null;
                if (!hit) break;
                // place() 坐标以画布中心为原点，平移到 640×360 画布内
                placed.push({text: w.text, size: w.size, x: Math.round(320 + hit.x), y: Math.round(180 + hit.y)});
            }
            if (placed.length === words.length) return placed;
        } catch (e) {
            // canvas 取不到 2d context 等环境限制：走纯函数兜底
        }
    }
    return packWordCloudLayout(words);
}
