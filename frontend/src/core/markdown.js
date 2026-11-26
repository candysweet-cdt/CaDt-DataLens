// 共享 Markdown 渲染层：从 main.js 抽出（docs/finished-plans/reading-mode.md §10.2）。
// 阅读模式与主界面 md 预览共用同一实例与 sanitize 规则，避免两套安全配置漂移。
// main.js 侧保留 mermaid 脚本加载（依赖视图状态），通过 deps 注入占位函数。

import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import markdownItKatex from '@vscode/markdown-it-katex';
import {buildWidgetPlaceholder, widgetKindOf} from './widget.js';

// ---- mermaid 占位源码编解码（UTF-8 安全 base64） ----
// DOMPurify 3.4.x 会整体丢弃属性值含换行的属性（mXSS 加固），而 mermaid 源码必含换行：
// 明文存 data-src 会被 sanitize 静默剥掉，占位永远空白且无报错。base64 值不含换行可存活，
// 渲染端（writing-ui.renderMermaidBlocks）解码后交给 mermaid.render。
/**
 * 把 mermaid 源码编码成 UTF-8 安全的 base64（DOMPurify 会丢弃属性值含换行的属性，
 * base64 值不含换行可存活；渲染端解码后交给 mermaid.render）。
 * @param {string} text mermaid 源码
 * @returns {string} base64 编码串
 */
export function encodeMermaidSource(text) {
    const bytes = new TextEncoder().encode(String(text || ''));
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

/**
 * 解码 encodeMermaidSource 编码的 mermaid 源码。
 * @param {string} encoded base64 编码串
 * @returns {string} 原始 mermaid 源码
 */
export function decodeMermaidSource(encoded) {
    const bin = atob(String(encoded || ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

// GitHub 风格标题锚点 slug：小写化 → 去标点（保留字母/数字/空白/连字符/下划线）→ 空白转连字符。
// 内置文档（docs/tutorial.md）目录里的 [x](#1-搜索排除表-search-ignore) 依赖这套规则，
// markdown-it 默认不给标题生成 id，锚点找不到目标 = 点击没反应。
/**
 * 生成标题锚点 slug（GitHub 风格）。
 * @param {string} text 标题纯文本
 * @returns {string} slug（可含中文）
 */
export function slugifyHeading(text) {
    return String(text || '')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s\-_]/gu, '')
        .replace(/\s+/g, '-')
        .replace(/^-+|-+$/g, '');
}

// 从 heading_open 的 inline 兄弟节点取标题纯文本（忽略 **、` 等 markdown 标记）。
function headingTextOf(tokens, idx) {
    const inline = tokens[idx + 1];
    if (!inline || inline.type !== 'inline') return '';
    if (Array.isArray(inline.children)) {
        return inline.children
            .filter((t) => t.type === 'text' || t.type === 'code_inline')
            .map((t) => t.content)
            .join('');
    }
    return inline.content || '';
}

/**
 * 创建共享 Markdown 渲染器（阅读模式与主界面 md 预览共用同一实例与 sanitize 规则）。
 * @param {object} [deps] 依赖注入
 * @param {Function} [deps.mdLineNumbers] 返回 boolean，代码块是否带行号（实时读取设置）
 * @param {Function} [deps.mermaidPlaceholder] (code: string) => string，mermaid 围栏占位 HTML（mermaid 归 main.js 管）
 * @returns {{markdownRenderer: MarkdownIt, renderMarkdownHtml: Function, renderMarkdownCodeBlock: Function}}
 *   markdownRenderer 为配置好的 markdown-it 实例；renderMarkdownHtml(text, env) 返回 sanitize 后的 HTML；
 *   renderMarkdownCodeBlock(text, info, env) 渲染单个代码块
 */
export function createMarkdownRenderer(deps) {
    const getLineNumbers = deps && typeof deps.mdLineNumbers === 'function'
        ? deps.mdLineNumbers
        : () => false;
    const mermaidPlaceholder = deps && typeof deps.mermaidPlaceholder === 'function'
        ? deps.mermaidPlaceholder
        : null;

    const markdownRenderer = new MarkdownIt({
        html: false,
        linkify: true,
        breaks: false,
    });
    // KaTeX 的 strict 默认 'warn'：数学模式里出现非 ASCII 字符（中文）时**逐字符**打一条
    // console warning。中文 markdown 里 `$` 往往根本不是公式（价格、"$HOME"、两处无关的 $
    // 被规则配成一对），于是控制台被刷屏、真警告被淹没（实测一次渲染几十行）。
    // 只对 unicodeTextInMathMode 降级为 ignore，其余（真正的公式语法错误）仍保留 warn。
    markdownRenderer.use(markdownItKatex, {
        throwOnError: false,
        errorColor: '#f75464',
        strict: (errorCode) => (errorCode === 'unicodeTextInMathMode' ? 'ignore' : 'warn'),
    });
    // validateLink 默认把 C:/ 开头的本地图片/链接路径当未知协议丢掉 src；
    // 放行后危险协议（javascript:/vbscript:/data:）仍由 DOMPurify 的 URI 白名单兜底过滤。
    // 注意必须走 md.set() 写进 options——直接给实例赋 validateLink 属性不生效。
    markdownRenderer.set({validateLink: function () { return true; }});
    // 本地路径的图片 src 可能被 DOMPurify 的 URI 白名单拦掉（如 C:/ 盘符路径），
    // 渲染时同步写一份到 data-ai-src（data-* 属性默认放行且不做 URI 校验），
    // AI 面板/MD 预览的图片解析器优先读它恢复本地图片。
    const defaultImageRule = markdownRenderer.renderer.rules.image;
    markdownRenderer.renderer.rules.image = function (tokens, idx, options, env, self) {
        const token = tokens[idx];
        const src = token.attrGet('src') || '';
        if (src && !/^(https?:|data:|blob:)/i.test(src)) token.attrSet('data-ai-src', src);
        return defaultImageRule
            ? defaultImageRule(tokens, idx, options, env, self)
            : self.renderToken(tokens, idx, options);
    };

    // env.aiWidgets 由 AI 面板注入：只有它被显式打开时，svg / html / mermaid / echarts 围栏才渲染成可视化卡片。
    // 主界面 Markdown 预览与阅读模式不传该开关，行为保持不变；info 里写 no-widget 可强制保留源码。
    /**
     * 渲染单个代码块：可视化围栏 → 卡片占位，mermaid → 占位函数，其余走 hljs + 可选行号栏。
     * @param {string} text 代码正文（去掉尾换行）
     * @param {string} info 围栏信息串（语言与 no-widget 等标记）
     * @param {object} [env] 渲染环境；env.aiWidgets 为真时才启用可视化卡片
     * @returns {string} HTML 片段
     */
    function renderMarkdownCodeBlock(text, info, env) {
        const code = String(text || '').replace(/\n$/, '');
        const infoText = String(info || '').trim();
        const widgetInfo = env && env.aiWidgets ? widgetKindOf(infoText) : null;
        if (widgetInfo && !/\bno-widget\b/i.test(infoText)) {
            return buildWidgetPlaceholder(code, widgetInfo.lang, widgetInfo.kind);
        }
        if (infoText.toLowerCase() === 'mermaid' && mermaidPlaceholder) {
            return mermaidPlaceholder(code);
        }
        const language = infoText.split(/\s+/)[0];
        let highlighted = '';
        if (language && hljs.getLanguage(language)) {
            try {
                highlighted = hljs.highlight(code, {language, ignoreIllegals: true}).value;
            } catch (e) {}
        }
        if (!highlighted) highlighted = markdownRenderer.utils.escapeHtml(code);
        const langClass = language ? ' language-' + language.replace(/[^A-Za-z0-9_+.-]/g, '') : '';
        if (!getLineNumbers()) {
            return '<pre><code class="hljs' + langClass + '">' + highlighted + '</code></pre>\n';
        }
        const lineCount = Math.max(1, code.split('\n').length);
        const numbers = Array.from({length: lineCount}, (_, i) => String(i + 1)).join('\n');
        return '<div class="md-code-frame">' +
            '<pre class="md-code-gutter" aria-hidden="true">' + numbers + '</pre>' +
            '<pre class="md-code-pre"><code class="hljs' + langClass + '">' + highlighted + '</code></pre>' +
            '</div>\n';
    }

    markdownRenderer.renderer.rules.fence = (tokens, idx, options, env) =>
        renderMarkdownCodeBlock(tokens[idx].content, tokens[idx].info, env);
    markdownRenderer.renderer.rules.code_block = (tokens, idx, options, env) =>
        renderMarkdownCodeBlock(tokens[idx].content, '', env);
    // 标题生成 GitHub 风格 id，供文内 [x](#slug) 目录锚点跳转（内置教程.md 就靠它）。
    // 用 Map 去重，重复标题追加 -1/-2，避免 id 冲突。
    markdownRenderer.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
        const slug = slugifyHeading(headingTextOf(tokens, idx));
        if (slug) {
            const seen = (env && env.headingSlugs) || (env && (env.headingSlugs = new Map()));
            const n = seen.get(slug) || 0;
            seen.set(slug, n + 1);
            tokens[idx].attrSet('id', n ? slug + '-' + n : slug);
        }
        return self.renderToken(tokens, idx, options);
    };
    const defaultLinkOpen = markdownRenderer.renderer.rules.link_open ||
        ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
    markdownRenderer.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        const token = tokens[idx];
        const href = token.attrGet('href') || '';
        if (href && !href.startsWith('#')) {
            token.attrSet('target', '_blank');
            token.attrSet('rel', 'noopener noreferrer');
        }
        return defaultLinkOpen(tokens, idx, options, env, self);
    };

    function renderMarkdownHtml(text, env) {
        const html = markdownRenderer.render(text || '', env || {});
        return DOMPurify.sanitize(html, {
            USE_PROFILES: {html: true, mathMl: true, svg: true},
            ADD_ATTR: ['target', 'rel', 'id'],
            // 放行 Windows 盘符路径（C:/...）供本地图片解析；javascript:/data: 等危险协议仍被默认白名单拦截
            ADD_URI_PROTOCOL: ['c'],
        });
    }

    return {markdownRenderer, renderMarkdownHtml, renderMarkdownCodeBlock};
}
