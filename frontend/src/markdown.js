// 共享 Markdown 渲染层：从 main.js 抽出（docs/reading-mode.md §10.2）。
// 阅读模式与主界面 md 预览共用同一实例与 sanitize 规则，避免两套安全配置漂移。
// main.js 侧保留 mermaid 脚本加载（依赖视图状态），通过 deps 注入占位函数。

import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import markdownItKatex from '@vscode/markdown-it-katex';

// createMarkdownRenderer 创建渲染器。
// deps.mdLineNumbers(): boolean —— 代码块是否带行号（实时读取设置）
// deps.mermaidPlaceholder(text): string —— mermaid 围栏占位 HTML（mermaid 归 main.js 管）
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
    markdownRenderer.use(markdownItKatex, {throwOnError: false, errorColor: '#f75464'});
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

    function renderMarkdownCodeBlock(text, info) {
        const code = String(text || '').replace(/\n$/, '');
        if (String(info || '').trim().toLowerCase() === 'mermaid' && mermaidPlaceholder) {
            return mermaidPlaceholder(code);
        }
        const language = String(info || '').trim().split(/\s+/)[0];
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

    markdownRenderer.renderer.rules.fence = (tokens, idx) => renderMarkdownCodeBlock(tokens[idx].content, tokens[idx].info);
    markdownRenderer.renderer.rules.code_block = (tokens, idx) => renderMarkdownCodeBlock(tokens[idx].content, '');
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

    function renderMarkdownHtml(text) {
        const html = markdownRenderer.render(text || '');
        return DOMPurify.sanitize(html, {
            USE_PROFILES: {html: true, mathMl: true, svg: true},
            ADD_ATTR: ['target', 'rel'],
            // 放行 Windows 盘符路径（C:/...）供本地图片解析；javascript:/data: 等危险协议仍被默认白名单拦截
            ADD_URI_PROTOCOL: ['c'],
        });
    }

    return {markdownRenderer, renderMarkdownHtml, renderMarkdownCodeBlock};
}
