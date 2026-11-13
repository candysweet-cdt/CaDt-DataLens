// AI 回答里的 SVG / HTML 可视化卡片（语言标记为 svg / html 的围栏代码块）。
//
// 安全边界（不可放松）：
// - 只有 AI 消息显式标注 svg / html 的围栏才会变成卡片；普通 Markdown 内嵌 HTML 仍由
//   markdown.js 的 html:false 规则转义，原始 HTML 不执行这条硬要求不变。
// - 代码块内容先经 DOMPurify 清洗（去掉 script / 事件属性 / javascript: 协议），
//   再放进 Shadow DOM：样式不外泄、主界面不受影响，脚本也不会执行。
// - 卡片内的链接由外层拦截后交给系统浏览器，其它导航一律阻止。
import DOMPurify from 'dompurify';

const WIDGET_LANGS = new Set(['svg', 'html', 'htm']);
// 单块源码上限：超出只保留源码，避免一段超大 HTML 卡住渲染进程。
const MAX_WIDGET_CHARS = 200 * 1024;
// 单条消息上限：防止模型一次输出几十张图把长会话拖慢。
const MAX_WIDGETS_PER_MESSAGE = 8;
// 单块 CSS 上限：样式是附带的，正常卡片远小于这个量级。
const MAX_WIDGET_CSS_CHARS = 24 * 1024;

// Shadow DOM 内的基础排版。主题自定义属性（--bg / --panel / --text …）会穿透 shadow 边界继承，
// 这里再把常见的 --color-* 命名映射过去，让模型按通用命名写的图也能拿到当前主题色。
const SHADOW_STYLE = [
    ':host{display:block;color:var(--text,#1f2328);',
    'font:13px/1.6 var(--ui-font,system-ui,"Segoe UI",sans-serif);',
    '--color-text-primary:var(--text,#1f2328);',
    '--color-text-secondary:var(--muted,#6b7280);',
    '--color-background-primary:var(--panel2,#fff);',
    '--color-background-secondary:var(--panel,#f4f6f8);',
    '--color-background-tertiary:var(--bg,#eef1f5);',
    '--color-border-tertiary:var(--border,rgba(0,0,0,.14));',
    '--color-border-secondary:var(--border,rgba(0,0,0,.24));',
    '--color-accent:var(--accent,#4f8cff);}',
    '*,*::before,*::after{box-sizing:border-box}',
    'img,svg,canvas{max-width:100%}',
    'svg{height:auto;max-height:520px}',
    'table{border-collapse:collapse}',
    'a{color:var(--accent,#4f8cff)}',
].join('');

export function widgetLangOf(info) {
    const lang = String(info || '').trim().split(/\s+/)[0].toLowerCase();
    return WIDGET_LANGS.has(lang) ? lang : '';
}

export function escapeWidgetText(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// 轻量滚动 hash：用于标记同一段代码，重渲染时可据此判断要不要重建卡片。
export function widgetCacheKey(lang, code) {
    const text = String(code || '');
    let hash = 5381;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    return String(lang) + ':' + text.length + ':' + (hash >>> 0).toString(36);
}

// 占位 HTML：由 markdown.js 的 fence 规则插入，增强阶段再从 .ai-widget-src 读回源码。
// 源码放在 pre/code 里（已转义），即使增强失败也能看到原始内容。
export function buildWidgetPlaceholder(code, lang) {
    const text = String(code || '');
    const safeLang = WIDGET_LANGS.has(lang) ? lang : 'html';
    const label = safeLang === 'svg' ? 'svg' : 'html';
    return '<div class="ai-widget" data-widget-lang="' + safeLang + '" data-widget-key="' +
        widgetCacheKey(safeLang, text) + '">' +
        '<div class="ai-widget-src" hidden><pre><code class="language-' + label + '">' +
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

export function sanitizeWidgetHtml(code, lang) {
    let source = String(code || '');
    // 裸 SVG 片段补命名空间与默认视口，否则部分渲染路径会得到 0 尺寸。
    if (lang === 'svg' && !/^\s*<svg[\s>]/i.test(source)) {
        source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 400">' + source + '</svg>';
    }
    return DOMPurify.sanitize(source, {
        USE_PROFILES: {html: true, svg: true, svgFilters: true, mathMl: true},
        // form 禁掉：无脚本的表单只会把卡片导航走；checkbox / details 等仍保留，纯 CSS 交互照常可用。
        FORBID_TAGS: [
            'script', 'iframe', 'frame', 'frameset', 'object', 'embed',
            'link', 'meta', 'base', 'form', 'audio', 'video', 'source', 'track',
        ],
        FORBID_ATTR: ['srcdoc'],
    });
}

function widgetButton(label, title, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ai-widget-btn';
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick(button);
    });
    return button;
}

function mountShadow(host, code, lang, opts) {
    let shadow = host.shadowRoot;
    if (!shadow) shadow = host.attachShadow({mode: 'open'});
    // svg 内的 <style> 同样抽出来统一清洗，避免两套路径行为不一致。
    const extracted = extractWidgetCss(code);
    shadow.innerHTML = '<style>' + SHADOW_STYLE + extracted.css + '</style>' +
        sanitizeWidgetHtml(extracted.code, lang);
    // 链接交给系统浏览器；其余导航（相对路径、javascript:、表单）一律拦下。
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

function mountCard(node, lang, code, opts) {
    node.dataset.widgetReady = '1';
    const srcPanel = node.querySelector('.ai-widget-src');

    const bar = document.createElement('div');
    bar.className = 'ai-widget-bar';
    const tag = document.createElement('span');
    tag.className = 'ai-widget-tag';
    tag.textContent = lang === 'svg' ? 'SVG' : 'HTML';
    const label = document.createElement('span');
    label.className = 'ai-widget-label';
    label.textContent = '可视化';
    const actions = document.createElement('div');
    actions.className = 'ai-widget-actions';

    const srcButton = widgetButton('源码', '查看 / 收起源码', () => {
        const show = !!srcPanel && srcPanel.hidden;
        if (srcPanel) srcPanel.hidden = !show;
        srcButton.textContent = show ? '收起' : '源码';
        node.classList.toggle('show-src', show);
    });
    const copyButton = widgetButton('复制', '复制源码', () => {
        if (typeof opts.copyText === 'function') opts.copyText(code, lang === 'svg' ? 'SVG' : 'HTML');
    });
    actions.append(srcButton, copyButton);
    bar.append(tag, label, actions);

    const body = document.createElement('div');
    body.className = 'ai-widget-body';
    node.insertBefore(bar, node.firstChild);
    node.insertBefore(body, srcPanel || null);
    mountShadow(body, code, lang, opts);
}

// 把 markdown 渲染出的 .ai-widget 占位升级成卡片。
// streaming 为真时只标记「生成中」，等整轮结束再挂载——流式期间每次增量都会整段重渲染，
// 此时建卡片会被反复销毁重建（闪烁且浪费）。返回实际挂载的数量。
export function enhanceWidgets(root, opts = {}) {
    if (!root || typeof root.querySelectorAll !== 'function') return 0;
    const nodes = root.querySelectorAll('.ai-widget[data-widget-lang]');
    let mounted = 0;
    nodes.forEach((node, index) => {
        if (node.dataset.widgetReady === '1') return;
        const lang = node.getAttribute('data-widget-lang') || 'html';
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
        mountCard(node, lang, code, opts);
        mounted++;
    });
    return mounted;
}
