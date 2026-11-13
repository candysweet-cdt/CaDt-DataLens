// widget.js 的纯逻辑测试：识别围栏语言、转义源码、生成占位结构。
// sanitizeWidgetHtml / enhanceWidgets 依赖真实 DOM（DOMPurify 与 Shadow DOM），
// 由浏览器冒烟覆盖，不在 node --test 里跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildWidgetPlaceholder,
    escapeWidgetText,
    extractWidgetCss,
    sanitizeWidgetCss,
    widgetCacheKey,
    widgetLangOf,
} from './widget.js';

test('widgetLangOf 只认 svg / html / htm', () => {
    assert.equal(widgetLangOf('svg'), 'svg');
    assert.equal(widgetLangOf('HTML'), 'html');
    assert.equal(widgetLangOf('htm'), 'htm');
    assert.equal(widgetLangOf('html title="demo"'), 'html');
    assert.equal(widgetLangOf('  mermaid '), '');
    assert.equal(widgetLangOf('javascript'), '');
    assert.equal(widgetLangOf(''), '');
    assert.equal(widgetLangOf(null), '');
});

test('escapeWidgetText 转义完整实体集', () => {
    assert.equal(
        escapeWidgetText('<svg onload="x">&\'</svg>'),
        '&lt;svg onload=&quot;x&quot;&gt;&amp;&#39;&lt;/svg&gt;',
    );
    assert.equal(escapeWidgetText(null), '');
});

test('widgetCacheKey 区分语言与内容', () => {
    assert.equal(widgetCacheKey('svg', '<svg/>'), widgetCacheKey('svg', '<svg/>'));
    assert.notEqual(widgetCacheKey('svg', '<svg/>'), widgetCacheKey('html', '<svg/>'));
    assert.notEqual(widgetCacheKey('svg', '<svg/>'), widgetCacheKey('svg', '<svg />'));
});

test('buildWidgetPlaceholder 保留语言标记并只输出转义后的源码', () => {
    const html = buildWidgetPlaceholder('<script>alert(1)</script>', 'html');
    assert.match(html, /class="ai-widget"/);
    assert.match(html, /data-widget-lang="html"/);
    assert.match(html, /<pre><code class="language-html">/);
    assert.ok(!html.includes('<script>'), '源码必须以实体形式出现，不能是活标签');
    assert.ok(html.includes('&lt;script&gt;'));
    assert.match(html, /ai-widget-src" hidden/);
});

test('buildWidgetPlaceholder 未知语言回退为 html', () => {
    const html = buildWidgetPlaceholder('<b>x</b>', 'py');
    assert.match(html, /data-widget-lang="html"/);
    assert.match(html, /language-html/);
});

test('extractWidgetCss 抽出 style 并从正文移除', () => {
    const out = extractWidgetCss('<style>.a{fill:var(--text)}</style><div class="a">hi</div>');
    assert.equal(out.code.trim(), '<div class="a">hi</div>');
    assert.equal(out.css.trim(), '.a{fill:var(--text)}');
});

test('extractWidgetCss 合并多个 style 块且允许无样式', () => {
    const out = extractWidgetCss('<style>.a{color:red}</style><p>x</p><style>.b{color:blue}</style>');
    assert.equal(out.code.trim(), '<p>x</p>');
    assert.match(out.css, /\.a\{color:red\}/);
    assert.match(out.css, /\.b\{color:blue\}/);
    assert.deepEqual(extractWidgetCss('<div>x</div>'), {code: '<div>x</div>', css: ''});
});

test('sanitizeWidgetCss 阻断外链资源与执行型写法', () => {
    const css = sanitizeWidgetCss([
        '@import url("https://evil/x.css");',
        '.a{background:url(https://evil/p.png)}',
        '.b{background:url(#grad)}',
        '.c{background:url("data:image/svg+xml;base64,AA")}',
        '.d{width:expression(alert(1))}',
        '.e{behavior:url(x.htc)}',
        '.f{color:javascript:alert(1)}',
        '.g{position:fixed;top:0}',
    ].join('\n'));
    assert.ok(!css.includes('@import'));
    assert.ok(!css.includes('evil'));
    assert.match(css, /url\(#grad\)/);
    assert.match(css, /data:image\/svg\+xml/);
    assert.ok(!/expression\s*\(/i.test(css));
    assert.ok(!css.includes('behavior'));
    assert.ok(!/javascript\s*:/i.test(css));
    assert.match(css, /position:absolute/);
});

test('sanitizeWidgetCss 拦掉试图闭合 style 标签的内容', () => {
    const css = sanitizeWidgetCss('.a{color:red}</style><div>injected</div>');
    assert.ok(!css.includes('</style>'));
});
