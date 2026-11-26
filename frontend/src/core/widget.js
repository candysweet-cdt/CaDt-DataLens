// AI 回答里的可视化卡片（svg / html / mermaid / echarts / graph / wordcloud 围栏代码块）。
// mermaid / echarts 走异步引擎：动态 import 渲染模块、vendor 按需加载，产物仍是静态 SVG，
// 之后与 svg 卡片走同一条 sanitize → Shadow DOM 管线；主题切换（data-theme）触发重渲染。
//
// 安全边界（不可放松）：
// - 只有 AI 消息显式标注 svg / html 的围栏才会变成卡片；普通 Markdown 内嵌 HTML 仍由
//   markdown.js 的 html:false 规则转义，原始 HTML 不执行这条硬要求不变。
// - 代码块内容先经 DOMPurify 清洗（去掉 script / 事件属性 / javascript: 协议），
//   再放进 Shadow DOM：样式不外泄、主界面不受影响，脚本也不会执行。
// - 卡片内的链接由外层拦截后交给系统浏览器，其它导航一律阻止。
import DOMPurify from 'dompurify';
import {SHADOW_STYLE, VISUAL_BUDGET, WIDGET_LANGS, svgSanitizeConfig} from './visual-spec.js';
import {escapeHtml} from './escape.js';
// 限额与 Shadow 基础样式来自 core/visual-spec.js（规范单一来源，代码与提示词共用一份预算）。
const MAX_WIDGET_CHARS = VISUAL_BUDGET.maxWidgetChars;
const MAX_WIDGETS_PER_MESSAGE = VISUAL_BUDGET.maxPerMessage;
const MAX_WIDGET_CSS_CHARS = VISUAL_BUDGET.maxCssChars;

// kind 分类（方案 §3.1）：只影响卡片标签、规范段落与无障碍描述，不是新引擎。
// chart 是 echarts 的兼容别名；显式 kind= 修饰优先于按语言推导的默认形态。
export const WIDGET_KINDS = new Set(['diagram', 'chart', 'mockup', 'card']);
const KIND_LABELS = {diagram: '图示', chart: '图表', mockup: '示意', card: '卡片'};
const LANG_LABELS = {svg: 'SVG', html: 'HTML', mermaid: 'Mermaid', echarts: 'ECharts', graph: 'Graph', wordcloud: 'WordCloud'};
const LANG_DEFAULT_KIND = {svg: 'diagram', mermaid: 'diagram', echarts: 'chart', graph: 'diagram', wordcloud: 'chart', html: 'card'};

// 语言归一化：chart 是 echarts 的兼容别名；不在集合里返回空串。
function normalizeWidgetLang(lang) {
    const l = String(lang || '').toLowerCase();
    if (!WIDGET_LANGS.has(l)) return '';
    return l === 'chart' ? 'echarts' : l;
}

export function widgetLangOf(info) {
    return normalizeWidgetLang(String(info || '').trim().split(/\s+/)[0]);
}

// widgetKindOf 解析围栏信息里的语言与 kind 修饰，返回 {lang, kind}；不是可视化围栏返回 null。
// 围栏信息示例：`svg`、`html kind=mockup`、`mermaid`、`echarts`、`chart`（= echarts）。
export function widgetKindOf(info) {
    const text = String(info || '').trim();
    if (!text) return null;
    const lang = widgetLangOf(text);
    if (!lang) return null;
    const m = text.match(/\bkind=([A-Za-z-]+)/i);
    const kind = m && WIDGET_KINDS.has(m[1].toLowerCase()) ? m[1].toLowerCase() : LANG_DEFAULT_KIND[lang];
    return {lang, kind};
}

// 保留旧名做兼容，实现统一到 core/escape.js（同一份 5 实体转义）。
export function escapeWidgetText(text) {
    return escapeHtml(text);
}

// 轻量滚动 hash：用于标记同一段代码，重渲染时可据此判断要不要重建卡片。
export function widgetCacheKey(lang, code) {
    const text = String(code || '');
    let hash = 5381;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    return String(lang) + ':' + text.length + ':' + (hash >>> 0).toString(36);
}

// XML 良构化：把 HTML 序列化产物修成 XML 能解析的 SVG。
// mermaid 的 htmlLabels 把节点文字放进 foreignObject 里的 HTML，序列化时 HTML 序列化器把空元素
// 写成 `<br>`（不补斜杠），文本里的 U+00A0 写成 `&nbsp;`。这份字符串在卡片里由 HTML 解析器读
// （容错），但一旦交给 `<img src="data:image/svg+xml,…">` 或存成 .svg 文件，浏览器按 XML 解析
// 整份文档——一个未闭合的 `<br>` 就让整张图解析失败（实测：灯箱显示「无法显示」、文件里只画出
// 第一个错误之前的半张图，报 "Opening and ending tag mismatch: br line 1 and p"）。
// 只补 XML 不认的空元素与 XML 未定义的命名实体，不动其它字节：SVG 命名空间里没有同名空元素
// （图是 <image> 不是 <img>，<a> 需要成对闭合且不在表内），所以全局替换是安全的。
const XML_VOID_TAGS = 'area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr';
const XML_VOID_RE = new RegExp('<(?!\\/)(?:' + XML_VOID_TAGS + ')(?:\\s[^<>]*?)?\\s*\\/?>', 'gi');
export function svgXmlSafe(svg) {
    return String(svg == null ? '' : svg)
        .replace(XML_VOID_RE, (tag) => tag.replace(/\s*\/?>\s*$/, '/>'))
        // 只换 HTML 序列化一定会产出的那一个（U+00A0 → &nbsp;）；&amp; / &lt; / &gt; / &quot;
        // 在 XML 里本就合法，其余命名实体只可能来自模型直接写进标签，属另一类问题。
        .replace(/&nbsp;/gi, '&#160;');
}

// 可视化卡片「全屏」：把渲染后的静态 SVG 编成可独立加载的 data URL。
// 抽成纯函数给 node 测试覆盖；先良构化（见 svgXmlSafe），裸片段补 xmlns，
// 否则 <img> 里的 SVG 无法独立解析。
export function svgToDataUrl(svg) {
    const text = svgXmlSafe(svg);
    const doc = /<svg[\s>]/i.test(text) && /xmlns=/i.test(text)
        ? text
        : text.replace(/<svg(\s|>)/i, '<svg xmlns="http://www.w3.org/2000/svg"$1');
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(doc);
}

// 占位 HTML：由 markdown.js 的 fence 规则插入，增强阶段再从 .ai-widget-src 读回源码。
// 源码放在 pre/code 里（已转义），即使增强失败也能看到原始内容。
export function buildWidgetPlaceholder(code, lang, kind) {
    const text = String(code || '');
    const safeLang = normalizeWidgetLang(lang) || 'html';
    const safeKind = WIDGET_KINDS.has(kind) ? kind : (LANG_DEFAULT_KIND[safeLang] || 'card');
    return '<div class="ai-widget" data-widget-lang="' + safeLang + '" data-widget-kind="' + safeKind +
        '" data-widget-key="' + widgetCacheKey(safeLang, text) + '">' +
        '<div class="ai-widget-src" hidden><pre><code class="language-' + safeLang + '">' +
        escapeWidgetText(text) + '</code></pre></div></div>\n';
}

// CSS 清洗：卡片本身在 shadow 里、脚本已被禁，这里只处理能越过边界的几类写法。
// - 外链资源（@import / url(http…)）会发网络请求，去掉；文档内引用 url(#id) 与 data: 保留。
// - position:fixed 在 shadow 内仍相对视口，会盖住整个应用，降级为 absolute。
// - expression()/behavior/-moz-binding 是历史执行入口，直接删。
export function sanitizeWidgetCss(css) {
    let text = String(css || '');
    if (!text.trim()) return '';
    if (text.length > MAX_WIDGET_CSS_CHARS) text = text.slice(0, MAX_WIDGET_CSS_CHARS);
    return text
        .replace(/<\/?style\b[^>]*>/gi, '')
        .replace(/@import[^;\n]*;?/gi, '')
        .replace(/expression\s*\(/gi, '(')
        .replace(/javascript\s*:/gi, '')
        // [^;\n] 而不是 [^;]：后者会跨行吞掉下一条规则，把无关样式整段删掉。
        .replace(/-moz-binding\s*:[^;\n]*;?/gi, '')
        .replace(/behavior\s*:[^;\n]*;?/gi, '')
        .replace(/position\s*:\s*fixed/gi, 'position:absolute')
        // 用回调判断而不是负向断言：`(['"]?)` 这类可选引号会发生回溯，导致 data: 被误杀。
        .replace(/url\s*\(\s*(['"]?)([\s\S]*?)\1\s*\)/gi, (match, quote, target) => {
            const value = String(target || '').trim();
            return /^(#|data:)/i.test(value) ? match : 'none';
        });
}

// 从围栏源码里抽出 <style> 块。
// 必要性：DOMPurify 会把 HTML 里的 <style> 连同内容一起剥掉（svg 内的反而保留），
// 若只在 sanitize 之后拼装，HTML 卡片会丢掉全部样式。这里先取出 CSS 文本单独清洗，
// 再和卡片基础样式一起塞进 shadow 的 <style>，作用域仍然只有卡片内部。
export function extractWidgetCss(code) {
    const styles = [];
    const body = String(code || '').replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (match, css) => {
        styles.push(css);
        return '';
    });
    return {code: body, css: sanitizeWidgetCss(styles.join('\n'))};
}

// html 卡片的本地图片：DOMPurify 的 URI 白名单会剥掉盘符 src（原始 HTML 不执行是硬要求），
// 清洗前把本地 src 抄一份到 data-ai-src（data-* 属性默认放行且不做 URI 校验），挂载后由外层
// resolveImages 经后端 ReadImageAsDataURL 换成 data URL。只加属性不重排 DOM，正则足够且无脚本面。
export function preserveLocalImageSrc(code) {
    let text = String(code || '');
    if (!/<img\b[\s>]/i.test(text)) return text;
    return text.replace(/(<img\b[^>]*?\bsrc\s*=\s*)("[^"]*"|'[^']*')/gi, (match, head, attr) => {
        const src = attr.slice(1, -1);
        if (/^(https?:|data:|blob:)/i.test(src)) return match;
        return head + attr + ' data-ai-src="' + escapeWidgetText(src) + '"';
    });
}

export function sanitizeWidgetHtml(code, lang) {
    let source = String(code || '');
    // 裸 SVG 片段补命名空间与默认视口，否则部分渲染路径会得到 0 尺寸。
    if (lang === 'svg' && !/^\s*<svg[\s>]/i.test(source)) {
        source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 400">' + source + '</svg>';
    }
    return DOMPurify.sanitize(source, svgSanitizeConfig());
}

function widgetButton(label, title, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ai-widget-btn';
    button.textContent = label;
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick(button);
    });
    return button;
}

function ensureShadow(host) {
    return host.shadowRoot || host.attachShadow({mode: 'open'});
}

// ---- 小 viewBox 图标兜底 ----
// 规范基准是 680 宽的 viewBox，卡片按容器宽度缩放。模型偶尔给 15×15 这类图标级
// viewBox，缩放策略会把它撑满卡片：灰底一大片、图标却只有一个点。宽高都很小时
// 改为按内容尺寸显示（保持比例，最长边至少 24px），正常尺寸的图完全不碰。
const TINY_VIEWBOX_MAX = 64;
const TINY_ICON_MIN_PX = 24;

// 只有「没写」「auto」「100%」算未指定；50% 等具体值是作者的明确意图，尊重。
function hasDeclaredSize(value) {
    const text = String(value == null ? '' : value).trim().toLowerCase();
    return !!text && text !== 'auto' && text !== '100%';
}

// 纯函数：返回需要内联的尺寸，不需要兜底时返回 null。抽出来给 node 测试覆盖
// （DOM 桩只测接线，尺寸算法本身不依赖浏览器）。
export function tinySvgSize(viewBox, width, height) {
    if (hasDeclaredSize(width) || hasDeclaredSize(height)) return null;
    const parts = String(viewBox || '').trim().split(/[\s,]+/);
    if (parts.length !== 4) return null;
    const nums = parts.map(Number);
    if (nums.some((n) => !Number.isFinite(n))) return null;
    const vw = nums[2];
    const vh = nums[3];
    if (!(vw > 0 && vh > 0) || vw > TINY_VIEWBOX_MAX || vh > TINY_VIEWBOX_MAX) return null;
    const scale = Math.max(1, TINY_ICON_MIN_PX / Math.max(vw, vh));
    return {
        width: Math.round(vw * scale * 100) / 100,
        height: Math.round(vh * scale * 100) / 100,
    };
}

// 应用在已清洗的 shadow DOM 上：只写数值型尺寸，不引入任何 url / 表达式。
// inline style 里已写尺寸的同样视为作者自管，直接跳过。
function fitTinySvg(shadow) {
    const svg = shadow && shadow.querySelector ? shadow.querySelector('svg') : null;
    if (!svg) return;
    const inline = svg.style;
    if (inline && (hasDeclaredSize(inline.width) || hasDeclaredSize(inline.height))) return;
    const size = tinySvgSize(
        svg.getAttribute('viewBox'),
        svg.getAttribute('width'),
        svg.getAttribute('height'),
    );
    if (!size) return;
    svg.style.setProperty('width', size.width + 'px', 'important');
    svg.style.setProperty('height', size.height + 'px', 'important');
    svg.style.setProperty('display', 'block', 'important');
    svg.style.setProperty('margin', '12px auto', 'important');
}

// ---- 竖向长图兜底 ----
// SHADOW_STYLE 的 svg{max-height:520px} 对横向图无害（按宽度缩放后本就矮），
// 但 mermaid TD 这类竖向长图会被压成 520px 窄条、节点文字缩到看不清。
// 高/宽超过阈值时取消 max-height，让图按宽度完整铺开，由 .ai-widget-body 的
// overflow:auto 承载滚动。横向图与正常比例的图完全不碰。
const TALL_SVG_RATIO = 1.2;

// 纯函数：viewBox 高/宽是否超过阈值。抽出来给 node 测试覆盖。
export function tallSvgNeedsUncap(viewBox) {
    const parts = String(viewBox || '').trim().split(/[\s,]+/);
    if (parts.length !== 4) return false;
    const nums = parts.map(Number);
    if (nums.some((n) => !Number.isFinite(n))) return false;
    const vw = nums[2];
    const vh = nums[3];
    if (!(vw > 0 && vh > 0)) return false;
    return vh / vw > TALL_SVG_RATIO;
}

// 应用在已清洗的 shadow DOM 上：只覆盖 max-height，不引入任何 url / 表达式。
// 作者显式写了高度/max-height 的视为自管，直接跳过。
function fitTallSvg(shadow) {
    const svg = shadow && shadow.querySelector ? shadow.querySelector('svg') : null;
    if (!svg) return;
    const inline = svg.style;
    if (inline && (hasDeclaredSize(inline.height) || hasDeclaredSize(inline.maxHeight))) return;
    if (!tallSvgNeedsUncap(svg.getAttribute('viewBox'))) return;
    svg.style.setProperty('max-height', 'none', 'important');
    svg.style.setProperty('height', 'auto', 'important');
}

// fillShadow 只负责填充内容；主题重渲染（异步卡片）会重复调用，不改监听器。
function fillShadow(host, code, lang) {
    const shadow = ensureShadow(host);
    // html 卡片先抄本地图片 src 到 data-ai-src（见 preserveLocalImageSrc 注释）；
    // svg / 引擎产物不处理（SSR 输出不含外链 img）。
    const extracted = extractWidgetCss(lang === 'html' ? preserveLocalImageSrc(code) : code);
    shadow.innerHTML = '<style>' + SHADOW_STYLE + extracted.css + '</style>' +
        sanitizeWidgetHtml(extracted.code, lang);
    // 异步引擎产物也走这条（lang 传 'svg'），但它们的 viewBox 是 680 宽，小图标兜底不会命中。
    if (lang === 'svg') {
        fitTinySvg(shadow);
        fitTallSvg(shadow);
    }
}

function mountShadow(host, code, lang, opts) {
    const shadow = ensureShadow(host);
    // 链接交给系统浏览器；其余导航（相对路径、javascript:、表单）一律拦下。
    // 主题重渲染会重复进入，守卫只绑一次。
    if (!host.dataset.shadowGuards) {
        host.dataset.shadowGuards = '1';
        shadow.addEventListener('click', (event) => {
            const link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
            if (!link) return;
            event.preventDefault();
            const href = String(link.getAttribute('href') || '').trim();
            if (/^(https?:\/\/|mailto:)/i.test(href) && typeof opts.openExternal === 'function') {
                opts.openExternal(href);
            }
        }, true);
        shadow.addEventListener('submit', (event) => event.preventDefault(), true);
    }
    fillShadow(host, code, lang);
}

function mountCard(node, lang, kind, code, opts) {
    node.dataset.widgetReady = '1';
    const srcPanel = node.querySelector('.ai-widget-src');

    const bar = document.createElement('div');
    bar.className = 'ai-widget-bar';
    const tag = document.createElement('span');
    tag.className = 'ai-widget-tag';
    tag.textContent = LANG_LABELS[lang] || String(lang).toUpperCase();
    const label = document.createElement('span');
    label.className = 'ai-widget-label';
    label.textContent = KIND_LABELS[kind] || '可视化';
    const actions = document.createElement('div');
    actions.className = 'ai-widget-actions';

    const srcButton = widgetButton('源码', '查看 / 收起源码', () => {
        const show = !!srcPanel && srcPanel.hidden;
        if (srcPanel) srcPanel.hidden = !show;
        srcButton.textContent = show ? '收起' : '源码';
        node.classList.toggle('show-src', show);
    });
    const copyButton = widgetButton('复制', '复制源码', () => {
        if (typeof opts.copyText === 'function') opts.copyText(code, LANG_LABELS[lang] || String(lang).toUpperCase());
    });
    actions.append(srcButton, copyButton);
    // 全屏：复用图片灯箱看大图（滚轮缩放 / 拖拽平移）。只有 SVG 类卡片能进——
    // 异步引擎产物（mermaid / echarts / graph / wordcloud）取渲染后的静态 SVG，svg 卡取源码；
    // html 卡不是一张图，不显示这个按钮。
    const isSvgLike = !!ASYNC_RENDERERS[lang] || lang === 'svg';
    if (isSvgLike && typeof opts.openFullscreen === 'function') {
        const fullButton = widgetButton('全屏', '在灯箱中放大查看', () => {
            const svg = ASYNC_RENDERERS[lang] ? (asyncSvg.get(node) || '') : code;
            if (!svg) {
                if (typeof opts.fullscreenPending === 'function') opts.fullscreenPending();
                return;
            }
            opts.openFullscreen(svg, (LANG_LABELS[lang] || 'SVG') + ' · ' + (KIND_LABELS[kind] || '图示'));
        });
        actions.append(fullButton);
    }
    // 另存为：异步卡片导出渲染后的 SVG（源码只是文本 / JSON，离线打不开），svg / html 卡导源码。
    // 导出 SVG 时先良构化：文件按 image/svg+xml 由 XML 解析器读，foreignObject 里未闭合的 <br>
    // 会让浏览器只画出第一个错误之前的半张图（见 svgXmlSafe）。
    if (typeof opts.saveAs === 'function') {
        const saveButton = widgetButton('另存为', '保存到工作区 .cadt/answers/', () => {
            const isAsync = !!ASYNC_RENDERERS[lang];
            const ext = (isAsync || lang === 'svg') ? 'svg' : 'html';
            const raw = isAsync ? (asyncSvg.get(node) || code) : code;
            const content = ext === 'svg' ? svgXmlSafe(raw) : raw;
            Promise.resolve(opts.saveAs({lang, kind, ext, content})).catch((e) => {
                // 尽力而为：实现侧已 flash 提示，这里兜住避免 unhandled rejection
            });
        });
        actions.append(saveButton);
    }
    bar.append(tag, label, actions);

    const body = document.createElement('div');
    body.className = 'ai-widget-body';
    node.insertBefore(bar, node.firstChild);
    node.insertBefore(body, srcPanel || null);
    if (ASYNC_RENDERERS[lang]) {
        mountAsyncCard(node, body, lang, code, opts);
        return;
    }
    mountShadow(body, code, lang, opts);
    // html 卡片里抄到 data-ai-src 的本地图片：由外层实现（复用 AI 消息的图片解析）换成 data URL。
    if (typeof opts.resolveImages === 'function' && body.shadowRoot) opts.resolveImages(body.shadowRoot);
}

// ---- 异步渲染引擎（mermaid / echarts / graph / wordcloud） ----
// 引擎模块动态 import：卡片首次挂载该类语言才加载，vendor 脚本随之按需注入，不进 Vite 主包。
const ASYNC_RENDERERS = {
    mermaid: () => import('./mermaid-render.js').then((m) => m.renderMermaidToSvg),
    echarts: () => import('./chart-render.js').then((m) => m.renderEchartsToSvg),
    graph: () => import('./layout-render.js').then((m) => m.renderGraphToSvg),
    wordcloud: () => import('./wordcloud-render.js').then((m) => m.renderWordCloudToSvg),
};
const asyncCards = new Set(); // 已挂载的异步卡片节点，主题切换时逐个重渲染
const asyncOpts = new Map();  // node → enhanceWidgets opts（重渲染时复用 openExternal 等）
const asyncSvg = new Map();   // node → 最近一次渲染的 SVG（另存为导出用）

// 消息整段重渲染会销毁旧节点：三张登记表以 node 为键，断连节点在下次 enhanceWidgets 清掉，
// 避免长会话里持有已销毁 DOM。
function sweepAsyncMaps() {
    for (const node of Array.from(asyncCards)) {
        if (!node.isConnected) {
            asyncCards.delete(node);
            asyncOpts.delete(node);
            asyncSvg.delete(node);
        }
    }
}

function currentThemeId() {
    return document.documentElement.dataset.theme || '';
}

let themeObserver = null;
// 主题切换走 documentElement 的 data-theme 属性（settings-ui 切主题的唯一出口），懒注册监听；
// 异步引擎产物是具体色值的静态 SVG，主题换了必须重新渲染（缓存按主题区分，旧主题条目自然淘汰）。
function ensureThemeObserver() {
    if (themeObserver || typeof MutationObserver === 'undefined') return;
    themeObserver = new MutationObserver(() => rerenderAsyncCards());
    themeObserver.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
}

async function renderAsyncCard(lang, code) {
    const render = await ASYNC_RENDERERS[lang]();
    return render(code, currentThemeId());
}

async function mountAsyncCard(node, body, lang, code, opts) {
    asyncCards.add(node);
    asyncOpts.set(node, opts);
    ensureThemeObserver();
    body.innerHTML = '<div class="ai-widget-loading">正在渲染可视化…</div>';
    try {
        const svg = await renderAsyncCard(lang, code);
        // 消息整段重渲染会销毁重建卡片节点：任务完成时节点已不在文档里就丢弃（不挂孤儿）。
        if (!node.isConnected) {
            asyncCards.delete(node);
            asyncOpts.delete(node);
            return;
        }
        body.innerHTML = '';
        mountShadow(body, svg, 'svg', asyncOpts.get(node) || opts);
        asyncSvg.set(node, svg);
        if (typeof asyncOpts.get(node)?.resolveImages === 'function' && body.shadowRoot) {
            asyncOpts.get(node).resolveImages(body.shadowRoot);
        }
    } catch (e) {
        if (!node.isConnected) {
            asyncCards.delete(node);
            asyncOpts.delete(node);
            return;
        }
        // 失败降级：放出源码，与超限卡片的处理一致。
        body.innerHTML = '';
        node.classList.add('ai-widget-error');
        const srcPanel = node.querySelector('.ai-widget-src');
        if (srcPanel) srcPanel.hidden = false;
        const msg = document.createElement('div');
        msg.className = 'ai-widget-error-text';
        msg.textContent = '渲染失败，已显示源码：' + ((e && e.message) || e);
        body.appendChild(msg);
    }
}

async function rerenderAsyncCards() {
    for (const node of Array.from(asyncCards)) {
        if (!node.isConnected) {
            asyncCards.delete(node);
            asyncOpts.delete(node);
            continue;
        }
        const lang = node.getAttribute('data-widget-lang');
        const body = node.querySelector('.ai-widget-body');
        if (!ASYNC_RENDERERS[lang] || !body) continue;
        const code = node.querySelector('.ai-widget-src code');
        try {
            const svg = await renderAsyncCard(lang, code ? (code.textContent || '') : '');
            if (!node.isConnected) {
                asyncCards.delete(node);
                asyncOpts.delete(node);
                continue;
            }
            fillShadow(body, svg, 'svg');
            asyncSvg.set(node, svg);
        } catch (e) {
            // 尽力而为路径：重渲染失败保留旧图（旧主题色好过空白），不打断用户。
        }
    }
}

// 把 markdown 渲染出的 .ai-widget 占位升级成卡片。
// streaming 为真时只标记「生成中」，等整轮结束再挂载——流式期间每次增量都会整段重渲染，
// 此时建卡片会被反复销毁重建（闪烁且浪费）。返回实际挂载的数量。
export function enhanceWidgets(root, opts = {}) {
    if (!root || typeof root.querySelectorAll !== 'function') return 0;
    sweepAsyncMaps();
    const nodes = root.querySelectorAll('.ai-widget[data-widget-lang]');
    let mounted = 0;
    nodes.forEach((node, index) => {
        if (node.dataset.widgetReady === '1') return;
        const lang = node.getAttribute('data-widget-lang') || 'html';
        const kind = node.getAttribute('data-widget-kind') || LANG_DEFAULT_KIND[lang] || 'card';
        const src = node.querySelector('.ai-widget-src code');
        const code = src ? (src.textContent || '') : '';
        if (!code.trim()) return;
        if (index >= MAX_WIDGETS_PER_MESSAGE || code.length > MAX_WIDGET_CHARS) {
            node.classList.add('ai-widget-oversize');
            // 不渲染卡片，但必须把源码放出来，否则用户只看到一句提示
            const srcPanel = node.querySelector('.ai-widget-src');
            if (srcPanel) srcPanel.hidden = false;
            return;
        }
        node.classList.remove('ai-widget-oversize');
        if (opts.streaming) {
            node.classList.add('ai-widget-pending');
            return;
        }
        node.classList.remove('ai-widget-pending');
        mountCard(node, lang, kind, code, opts);
        mounted++;
    });
    return mounted;
}

// ---------- 重渲染保活（流式 loading 不卡帧） ----------
// 流式期间 markdown 整段重建（md.innerHTML 覆盖）会把 .ai-widget 占位节点整只销毁，
// ::before/::after 的 CSS loading 动画时钟随之归零——上方思考链 / 工具卡每帧更新时，
// loading 就永远停在前几帧，看着就是「正在生成可视化…」一直闪。
//
// 保活做法：重建前把未挂载占位按文档顺序摘出（innerHTML 覆盖销毁不到），重建后按同序
// 移植回新槽位——保住节点对象与源码，避免每帧全新 DOM。注意 remove + insert 仍会重置 CSS
// 动画对象（currentTime 归零，Chrome 实测），故 loading 相位由 ai-tool-cards.js 的
// syncWidgetLoadingPhase 用负 animation-delay 补回，转环 / 扫光才看着连续。
// 已挂载（data-widget-ready）的卡带事件与异步任务，不参与。
//
// 为什么按文档顺序、不按 data-widget-key（源码 hash）匹配：流式期间围栏内容每帧增长，
// hash 每帧都变，按 hash 匹配永远对不上——旧节点被丢弃、新节点每帧重建，等于没保活。
// 围栏的数量与先后顺序在流式期间是稳定的，按序匹配才靠得住。源码内容以轮结束那次
// 全新渲染为准（轮结束不 park/restore），所以复用旧节点上的旧源码不影响最终卡片。
//
// park：摘出所有未挂载占位，返回按文档顺序排列的数组。
export function parkPendingWidgets(root) {
    const parked = [];
    if (!root || typeof root.querySelectorAll !== 'function') return parked;
    for (const node of root.querySelectorAll('.ai-widget[data-widget-lang]')) {
        if (!node || node.dataset.widgetReady === '1') continue;
        parked.push(node);
        if (typeof node.remove === 'function') node.remove();
    }
    return parked;
}

// restore：把摘出的占位按同序移植回新槽位，返回移植数。多出来的新槽位（围栏数增加）与
// 多出来的旧节点（围栏数减少）自然淘汰——末帧会带完整源码重新渲染，不心疼这一帧。
export function restoreParkedWidgets(parked, newRoot) {
    if (!parked || !parked.length || !newRoot || typeof newRoot.querySelectorAll !== 'function') return 0;
    let moved = 0;
    let i = 0;
    for (const node of newRoot.querySelectorAll('.ai-widget[data-widget-lang]')) {
        if (!node || node.dataset.widgetReady === '1') continue;
        const kept = parked[i++];
        if (!kept) break;
        if (typeof node.replaceWith === 'function') {
            node.replaceWith(kept);
            moved += 1;
        }
    }
    return moved;
}
