// widget.js 的纯逻辑测试：识别围栏语言、转义源码、生成占位结构。
// sanitizeWidgetHtml / enhanceWidgets 依赖真实 DOM（DOMPurify 与 Shadow DOM），
// 由浏览器冒烟覆盖，不在 node --test 里跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
    buildWidgetPlaceholder,
    escapeWidgetText,
    extractWidgetCss,
    parkPendingWidgets,
    preserveLocalImageSrc,
    restoreParkedWidgets,
    sanitizeWidgetCss,
    svgToDataUrl,
    svgXmlSafe,
    tallSvgNeedsUncap,
    tinySvgSize,
    widgetCacheKey,
    widgetKindOf,
    widgetLangOf,
} from '../../src/core/widget.js';

test('widgetLangOf 只认 svg / html / htm / mermaid / echarts（chart 是 echarts 别名）', () => {
    assert.equal(widgetLangOf('svg'), 'svg');
    assert.equal(widgetLangOf('HTML'), 'html');
    assert.equal(widgetLangOf('htm'), 'htm');
    assert.equal(widgetLangOf('html title="demo"'), 'html');
    assert.equal(widgetLangOf('  mermaid '), 'mermaid');
    assert.equal(widgetLangOf('echarts'), 'echarts');
    assert.equal(widgetLangOf('chart'), 'echarts');
    assert.equal(widgetLangOf('Chart kind=chart'), 'echarts');
    assert.equal(widgetLangOf('graph'), 'graph');
    assert.equal(widgetLangOf('wordcloud'), 'wordcloud');
    assert.equal(widgetLangOf('javascript'), '');
    assert.equal(widgetLangOf(''), '');
    assert.equal(widgetLangOf(null), '');
});

test('widgetKindOf 解析语言与 kind 修饰（显式 kind 优先，未知 kind 回退默认）', () => {
    assert.deepEqual(widgetKindOf('svg'), {lang: 'svg', kind: 'diagram'});
    assert.deepEqual(widgetKindOf('mermaid'), {lang: 'mermaid', kind: 'diagram'});
    assert.deepEqual(widgetKindOf('echarts'), {lang: 'echarts', kind: 'chart'});
    assert.deepEqual(widgetKindOf('chart'), {lang: 'echarts', kind: 'chart'});
    assert.deepEqual(widgetKindOf('html'), {lang: 'html', kind: 'card'});
    assert.deepEqual(widgetKindOf('graph'), {lang: 'graph', kind: 'diagram'});
    assert.deepEqual(widgetKindOf('wordcloud'), {lang: 'wordcloud', kind: 'chart'});
    assert.deepEqual(widgetKindOf('html kind=mockup'), {lang: 'html', kind: 'mockup'});
    assert.deepEqual(widgetKindOf('html kind=diagram'), {lang: 'html', kind: 'diagram'});
    assert.deepEqual(widgetKindOf('svg kind=notakind'), {lang: 'svg', kind: 'diagram'});
    assert.deepEqual(widgetKindOf('HTML KIND=MOCKUP'), {lang: 'html', kind: 'mockup'});
    assert.deepEqual(widgetKindOf('html title="demo"'), {lang: 'html', kind: 'card'});
    assert.equal(widgetKindOf('python'), null);
    assert.equal(widgetKindOf(''), null);
    assert.equal(widgetKindOf(null), null);
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

test('buildWidgetPlaceholder 带 kind 标记，未传 kind 时按语言推导', () => {
    const chart = buildWidgetPlaceholder('{"series":[]}', 'echarts', 'chart');
    assert.match(chart, /data-widget-lang="echarts"/);
    assert.match(chart, /data-widget-kind="chart"/);
    assert.match(chart, /language-echarts/);
    const diagram = buildWidgetPlaceholder('flowchart TD', 'mermaid');
    assert.match(diagram, /data-widget-kind="diagram"/);
    const mockup = buildWidgetPlaceholder('<div/>', 'html', 'mockup');
    assert.match(mockup, /data-widget-kind="mockup"/);
    // 未知 kind 回退默认，不出现在属性里
    const bad = buildWidgetPlaceholder('<div/>', 'html', 'interactive');
    assert.match(bad, /data-widget-kind="card"/);
    assert.ok(!bad.includes('interactive'));
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

test('tinySvgSize 把图标级 viewBox 按内容尺寸显示（保比例，最长边至少 24px）', () => {
    assert.deepEqual(tinySvgSize('0 0 15 15'), {width: 24, height: 24});
    assert.deepEqual(tinySvgSize('0 0 16 16'), {width: 24, height: 24});
    assert.deepEqual(tinySvgSize('0 0 32 32'), {width: 32, height: 32});
    assert.deepEqual(tinySvgSize('0 0 64 64'), {width: 64, height: 64});
    assert.deepEqual(tinySvgSize('0 0 20 10'), {width: 24, height: 12}, '等比例放大，不拉伸');
    assert.deepEqual(tinySvgSize('0,0,15,15'), {width: 24, height: 24}, '逗号分隔也能解析');
    assert.deepEqual(tinySvgSize('1 2 16 16'), {width: 24, height: 24}, 'origin 不参与尺寸计算');
});

test('tinySvgSize 跳过正常 viewBox、显式尺寸与非法输入', () => {
    assert.equal(tinySvgSize('0 0 680 400'), null, '规范尺寸不兜底');
    assert.equal(tinySvgSize('0 0 65 65'), null, '略超阈值不兜底');
    assert.equal(tinySvgSize('0 0 100 40'), null, '单边超阈值不兜底');
    assert.equal(tinySvgSize('0 0 15 15', '48'), null, '作者写了 width 就不动');
    assert.equal(tinySvgSize('0 0 15 15', null, '48px'), null);
    assert.equal(tinySvgSize('0 0 15 15', '50%'), null, '具体百分比是明确意图，尊重');
    assert.deepEqual(tinySvgSize('0 0 15 15', '100%'), {width: 24, height: 24}, '100% 等于没写');
    assert.deepEqual(tinySvgSize('0 0 15 15', null, 'auto'), {width: 24, height: 24});
    assert.equal(tinySvgSize(''), null);
    assert.equal(tinySvgSize('none'), null);
    assert.equal(tinySvgSize('0 0 15'), null);
    assert.equal(tinySvgSize('0 0 abc 15'), null);
    assert.equal(tinySvgSize('0 0 -15 15'), null);
    assert.equal(tinySvgSize(null), null);
});

test('widget.js 在 fillShadow 里接上小 viewBox 兜底', () => {
    const src = readFileSync(new URL('../../src/core/widget.js', import.meta.url), 'utf8');
    assert.match(src, /function fillShadow[\s\S]*?fitTinySvg\(shadow\)/, 'fillShadow 必须调用兜底');
    assert.match(src, /function fitTinySvg[\s\S]*?tinySvgSize\(/, '兜底必须用纯函数算尺寸');
    assert.match(src, /fitTinySvg\(shadow\);\s*\n\s*fitTallSvg\(shadow\)/, 'svg 卡同时调用长图兜底');
});

test('tallSvgNeedsUncap 识别竖向长图（高/宽 > 1.2），横向与正常图不命中', () => {
    // mermaid TD 长流程：高远大于宽 → 需要取消 max-height
    assert.equal(tallSvgNeedsUncap('0 0 680 3000'), true);
    assert.equal(tallSvgNeedsUncap('0 0 200 1000'), true);
    assert.equal(tallSvgNeedsUncap('0,0,680,1200'), true, '逗号分隔也能解析');
    // 刚好超过阈值
    assert.equal(tallSvgNeedsUncap('0 0 100 121'), true);
    // 正常比例 / 横向图不碰
    assert.equal(tallSvgNeedsUncap('0 0 680 400'), false);
    assert.equal(tallSvgNeedsUncap('0 0 680 520'), false, '1.2 以内不命中');
    assert.equal(tallSvgNeedsUncap('0 0 1000 300'), false, '横向图不命中');
    assert.equal(tallSvgNeedsUncap('0 0 100 120'), false, '正好 1.2 不命中');
    // 非法输入安全返回 false
    assert.equal(tallSvgNeedsUncap(''), false);
    assert.equal(tallSvgNeedsUncap('none'), false);
    assert.equal(tallSvgNeedsUncap('0 0 15'), false);
    assert.equal(tallSvgNeedsUncap('0 0 abc 15'), false);
    assert.equal(tallSvgNeedsUncap('0 0 -15 15'), false);
    assert.equal(tallSvgNeedsUncap(null), false);
});

test('widget.js 长图兜底只覆盖 max-height，不碰作者显式高度', () => {
    const src = readFileSync(new URL('../../src/core/widget.js', import.meta.url), 'utf8');
    assert.match(src, /function fitTallSvg[\s\S]*?tallSvgNeedsUncap\(/, '兜底必须用纯函数判定');
    assert.match(src, /max-height', 'none'/, '取消 max-height 让图完整铺开');
    assert.match(src, /hasDeclaredSize\(inline\.height\) \|\| hasDeclaredSize\(inline\.maxHeight\)/,
        '作者显式高度/max-height 视为自管，跳过');
});

test('svgToDataUrl 生成可独立加载的 data URL，裸片段补 xmlns', () => {
    const full = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg>';
    const url = svgToDataUrl(full);
    assert.ok(url.startsWith('data:image/svg+xml;charset=utf-8,'), '前缀正确');
    assert.equal(decodeURIComponent(url.slice(url.indexOf(',') + 1)), full, '内容原样编码');

    const bare = '<svg viewBox="0 0 10 10"><rect/></svg>';
    const bareUrl = svgToDataUrl(bare);
    const decoded = decodeURIComponent(bareUrl.slice(bareUrl.indexOf(',') + 1));
    assert.match(decoded, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox=/, '补上 xmlns');
    assert.equal((decoded.match(/xmlns=/g) || []).length, 1, '只补一次，不重复');

    assert.equal(svgToDataUrl(null), 'data:image/svg+xml;charset=utf-8,');
});

test('全屏按钮只给 SVG 类卡片，且经 opts.openFullscreen 回调', () => {
    const src = readFileSync(new URL('../../src/core/widget.js', import.meta.url), 'utf8');
    assert.match(src, /const isSvgLike = !!ASYNC_RENDERERS\[lang\] \|\| lang === 'svg'/,
        '仅 SVG / 异步引擎卡显示全屏按钮');
    assert.match(src, /isSvgLike && typeof opts\.openFullscreen === 'function'/, '有回调才显示');
    assert.match(src, /opts\.openFullscreen\(svg,/, '点击走 openFullscreen 回调');
});

// 背景：mermaid 的 htmlLabels 把节点文字放进 foreignObject，序列化时 `<br/>` 变成 `<br>`
// （HTML 空元素不补斜杠）。卡片里由 HTML 解析器读没事，但 data URL / .svg 文件按 XML 解析，
// 一个未闭合的 `<br>` 就让整张图加载失败（灯箱「无法显示」、文件只画出半张）。
test('svgXmlSafe 把 HTML 序列化的空元素补成自闭合，XML 才解析得动', () => {
    assert.equal(svgXmlSafe('<div>a<br>b</div>'), '<div>a<br/>b</div>');
    assert.equal(svgXmlSafe('<img src="x.png" alt="a">'), '<img src="x.png" alt="a"/>');
    assert.equal(svgXmlSafe('<hr class="sep" />'), '<hr class="sep"/>', '已自闭合保持自闭合');
    assert.equal(svgXmlSafe('<BR>'), '<BR/>');
    // 不误伤：SVG 命名空间没有同名空元素，成对标签与 <image> / <a> 必须原样
    assert.equal(svgXmlSafe('<image href="a.png"/>'), '<image href="a.png"/>');
    assert.equal(svgXmlSafe('<a href="#x">链接</a>'), '<a href="#x">链接</a>');
    assert.equal(svgXmlSafe('</div><rect/>'), '</div><rect/>', '闭合标签不动');
    // U+00A0 是 HTML 序列化唯一会产出、XML 又不认的命名实体
    assert.equal(svgXmlSafe('<text>a&nbsp;b</text>'), '<text>a&#160;b</text>');
    assert.equal(svgXmlSafe('&amp; &lt; &gt; &quot;'), '&amp; &lt; &gt; &quot;', 'XML 合法实体不动');
    assert.equal(svgXmlSafe(null), '');
});

test('svgToDataUrl 先良构化再编码，foreignObject 里的 <br> 不再拖垮整张图', () => {
    const mermaid = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">a<br>b</div></foreignObject></svg>';
    const decoded = decodeURIComponent(svgToDataUrl(mermaid).split(',')[1]);
    assert.ok(!/(?:<br>)/.test(decoded), '不得残留未闭合的 <br>');
    assert.match(decoded, /a<br\/>b/, '补成自闭合');
    assert.ok(decoded.includes('<foreignObject>'), 'foreignObject 保留');
});

test('preserveLocalImageSrc 给本地图片补 data-ai-src，外链不动', () => {
    const html = preserveLocalImageSrc(
        '<img src="C:\\data\\a.png" alt="a"><img src="https://x/b.png"><img src="data:image/png;base64,AA"><img>',
    );
    assert.match(html, /data-ai-src="C:\\data\\a\.png"/, '本地路径要抄到 data-ai-src');
    assert.equal((html.match(/data-ai-src/g) || []).length, 1, '只补一个');
    assert.ok(html.includes('src="https://x/b.png"'), '外链原样保留');
    assert.ok(html.includes('src="data:image/png;base64,AA"'), 'data: 原样保留');
    assert.equal(preserveLocalImageSrc('<div>无图片</div>'), '<div>无图片</div>');
    // src 里的引号必须转义，不能截断属性
    const quoted = preserveLocalImageSrc("<img src=\"a'b.png\">");
    assert.match(quoted, /data-ai-src="a&#39;b\.png"/);
});

// ---------- 重渲染保活（park / restore：流式 loading 不卡帧） ----------
// 最小 DOM stub：选择器过滤在函数内以 dataset / getAttribute 判定，stub 容器直接返回预置节点。

function stubWidgetNode(lang, key, ready) {
    return {
        attrs: ready
            ? {'data-widget-lang': lang, 'data-widget-key': key, 'data-widget-ready': '1'}
            : {'data-widget-lang': lang, 'data-widget-key': key},
        dataset: ready ? {widgetReady: '1'} : {},
        removed: false,
        replacedWith: null,
        getAttribute(name) { return this.attrs[name] || null; },
        remove() { this.removed = true; },
        replaceWith(other) { this.replacedWith = other; },
    };
}

function stubRoot(nodes) {
    return {querySelectorAll: () => nodes};
}

test('parkPendingWidgets：未挂载占位按文档顺序摘出，已挂载的卡不动', () => {
    const a = stubWidgetNode('mermaid', 'k1', false);
    const b = stubWidgetNode('svg', 'k2', false);
    const c = stubWidgetNode('mermaid', 'k3', false);
    const ready = stubWidgetNode('html', 'k4', true);
    const parked = parkPendingWidgets(stubRoot([a, b, c, ready]));
    assert.deepEqual(parked, [a, b, c], '按文档顺序摘出（不再依赖内容 hash）');
    assert.equal(a.removed && b.removed && c.removed, true, '摘出文档（innerHTML 覆盖销毁不到）');
    assert.equal(ready.removed, false, '已挂载的卡带事件与异步任务，不摘');
});

test('restoreParkedWidgets：按序移植回新槽位，key 变了也能对上（流式内容每帧变）', () => {
    const old1 = stubWidgetNode('mermaid', 'k1', false);
    const old2 = stubWidgetNode('svg', 'k2', false);
    const parked = parkPendingWidgets(stubRoot([old1, old2]));
    // 新槽位 key 全不同——模拟流式期间源码增长导致 hash 变化；按序匹配不受影响
    const slotA = stubWidgetNode('mermaid', 'k-new1', false);
    const slotB = stubWidgetNode('svg', 'k-new2', false);
    const slotC = stubWidgetNode('html', 'k-new3', false);
    const ready = stubWidgetNode('html', 'kr', true);
    const moved = restoreParkedWidgets(parked, stubRoot([slotA, slotB, slotC, ready]));
    assert.equal(moved, 2);
    assert.equal(slotA.replacedWith, old1, '按序：第一块回第一槽');
    assert.equal(slotB.replacedWith, old2, '第二块回第二槽');
    assert.equal(slotC.replacedWith, null, '多出的新槽位不动（末帧带完整源码重渲染）');
    assert.equal(ready.replacedWith, null, '已挂载的槽不参与');
});

test('restoreParkedWidgets：多出的旧节点被丢弃，空 parked / 非法输入安全返回 0', () => {
    const old1 = stubWidgetNode('svg', 'k1', false);
    const old2 = stubWidgetNode('svg', 'k2', false);
    const parked = parkPendingWidgets(stubRoot([old1, old2]));
    const onlySlot = stubWidgetNode('svg', 'k-new', false);
    assert.equal(restoreParkedWidgets(parked, stubRoot([onlySlot])), 1, '只移植一个');
    assert.equal(onlySlot.replacedWith, old1);
    assert.equal(restoreParkedWidgets([], stubRoot([stubWidgetNode('svg', 'k', false)])), 0);
    assert.equal(restoreParkedWidgets(null, null), 0);
});

test('接线：流式重渲染按 park → innerHTML → restore → enhanceWidgets 保活，轮结束跳过 restore', () => {
    const src = readFileSync(new URL('../../src/ai/tools/ai-tool-cards.js', import.meta.url), 'utf8');
    const parkAt = src.indexOf('const parked = parkPendingWidgets(md);');
    assert.ok(parkAt > 0, '摘出在 innerHTML 覆盖之前');
    const writeAt = src.indexOf('md.innerHTML = renderMarkdown(content);', parkAt);
    assert.ok(writeAt > parkAt, 'innerHTML 覆盖在摘出之后');
    const restoreAt = src.indexOf('if (streaming) restoreParkedWidgets(parked, md);', writeAt);
    assert.ok(restoreAt > writeAt, '移植在覆盖之后，且只在流式期间（轮结束让新占位带完整源码留下）');
    const enhanceAt = src.indexOf('enhanceWidgets(md, {', restoreAt);
    assert.ok(enhanceAt > restoreAt, '统一增强在移植之后（mountCard 作用于占位）');
});
