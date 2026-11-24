// visual-spec.js：AI 可视化规范的单一来源——主题 token、尺寸预算、提示词规范文本、路由决策表。
// 消费方：core/widget.js（SHADOW_STYLE 与限额）、ai/core/ai-constants.js（技能文本拼装）、图表引擎
// （resolveThemeColors 给 SSR 注入当前主题的具体色值——静态 SVG 里 CSS 变量不会被解析）。
// 阶段 1（docs/unfinished-plans/visualizer.md §4）：只搬运既有常量与文本，行为零变化。

// 尺寸与数量预算：widget.js 的限额常量与提示词里的数字都从这里取，改一处两处生效。
export const VISUAL_BUDGET = {
    svgViewBoxWidth: 680,
    svgMaxHeight: 520,
    minFontSize: 11,
    baseFontSize: 13,
    maxColumns: 2,
    maxPerMessageRecommended: 3,
    maxPerMessage: 8,
    maxWidgetChars: 200 * 1024,
    maxCssChars: 24 * 1024,
};

// 可视化围栏语言清单（单一来源）：widget.js 的卡片渲染与 AI 工具名的「围栏误用」识别共用。
// 这些是正文围栏的语言标记，不是可调用工具；模型偶尔会把它们误发成 function_call。
export const WIDGET_LANGS = new Set(['svg', 'html', 'htm', 'mermaid', 'echarts', 'chart', 'graph', 'wordcloud']);

// Shadow DOM 基础样式的别名表：[--color-* 别名, 应用变量, 兜底色]。
// 主题自定义属性会穿透 shadow 边界继承，映射一份通用命名让模型按惯例写的图也能拿到主题色。
const SHADOW_ALIAS = [
    ['--color-text-primary', '--text', '#1f2328'],
    ['--color-text-secondary', '--muted', '#6b7280'],
    ['--color-background-primary', '--panel2', '#fff'],
    ['--color-background-secondary', '--panel', '#f4f6f8'],
    ['--color-background-tertiary', '--bg', '#eef1f5'],
    ['--color-border-tertiary', '--border', 'rgba(0,0,0,.14)'],
    ['--color-border-secondary', '--border', 'rgba(0,0,0,.24)'],
    ['--color-accent', '--accent', '#4f8cff'],
];

export const SHADOW_STYLE = [
    ':host{display:block;background:var(--panel2,#fff);color:var(--text,#1f2328);',
    'font:13px/1.6 var(--ui-font,system-ui,"Segoe UI",sans-serif);',
    ...SHADOW_ALIAS.map(([alias, v, fb], i) =>
        alias + ':var(' + v + ',' + fb + ')' + (i === SHADOW_ALIAS.length - 1 ? ';}' : ';')),
    '*,*::before,*::after{box-sizing:border-box}',
    'img,svg,canvas{max-width:100%}',
    'svg{height:auto;max-height:' + VISUAL_BUDGET.svgMaxHeight + 'px}',
    'table{border-collapse:collapse}',
    'input[type=checkbox]{appearance:none;-webkit-appearance:none;position:relative;flex:none;width:14px;height:14px;margin:0 6px 0 0;vertical-align:-2px;border:1.5px solid var(--border);border-radius:4px;background:var(--bg);cursor:pointer;transition:background-color .15s ease,border-color .15s ease}',
    'input[type=checkbox]:checked{background:var(--color-accent);border-color:var(--color-accent);box-shadow:0 1px 3px color-mix(in srgb,var(--color-accent) 38%,transparent)}',
    'input[type=checkbox]::after{content:"";position:absolute;left:3px;top:1px;width:4px;height:7px;border:solid #fff;border-width:0 2px 2px 0;border-radius:1px;transform:rotate(45deg) scale(0);transition:transform .16s ease}',
    'input[type=checkbox]:checked::after{transform:rotate(45deg) scale(1)}',
    'a{color:var(--accent,#4f8cff)}',
].join('');

// SVG 产物的 DOMPurify 配置单一来源。三个消费方共用：core/widget.js 的 sanitizeWidgetHtml、
// core/mermaid-render.js、editor/markdown-mermaid.js——各写一份必然漂移（历史上就漂了）。
// 为什么必须这么配（实测：mermaid 图只剩框、没有文字）：
// - mermaid 的节点文字在 <foreignObject> 里的 div/span 中，不是 <text>；
// - foreignObject 不在任何 USE_PROFILES 白名单里，不显式 ADD_TAGS 就会被整体删除；
// - 只 ADD_TAGS 也不够：DOMPurify 仍按 SVG 上下文校验它的子元素，div/span 会被当非法 SVG 元素剥掉，
//   必须声明 HTML_INTEGRATION_POINTS 让子元素按 HTML 规则处理；
// - USE_PROFILES 要带 html，否则 div/span 根本不在标签白名单里。
// 放宽的只是「允许 foreignObject 内的 HTML 标签存在」：script / 事件属性 / javascript: / FORBID_TAGS
// 里的标签照旧被剥（前端有对应断言，见 core/visual-spec.test.mjs）。
export function svgSanitizeConfig(extra) {
    return Object.assign({
        USE_PROFILES: {html: true, svg: true, svgFilters: true, mathMl: true},
        ADD_TAGS: ['style', 'foreignObject'],
        HTML_INTEGRATION_POINTS: {foreignobject: true},
        // form 禁掉：无脚本的表单只会把卡片导航走；checkbox / details 等仍保留，纯 CSS 交互照常可用。
        FORBID_TAGS: [
            'script', 'iframe', 'frame', 'frameset', 'object', 'embed',
            'link', 'meta', 'base', 'form', 'audio', 'video', 'source', 'track',
        ],
        FORBID_ATTR: ['srcdoc'],
    }, extra || {});
}

// 主题语义变量表：[key, 应用变量, 兜底色]。resolveThemeColors 按此读取计算样式；
// 兜底值仅在变量缺失（异常主题 / 非 DOM 环境）时使用。
const THEME_COLOR_SLOTS = [
    ['text', '--text', '#1f2328'],
    ['muted', '--muted', '#6b7280'],
    ['panel', '--panel', '#f4f6f8'],
    ['panel2', '--panel2', '#fff'],
    ['bg', '--bg', '#eef1f5'],
    ['border', '--border', 'rgba(0,0,0,.24)'],
    ['accent', '--accent', '#4f8cff'],
    ['onAccent', '--on-accent', '#fff'],
    ['green', '--green', '#2da44e'],
    ['red', '--red', '#cf222e'],
    ['warn', '--warn', '#bf8700'],
];

export const VISUAL_TOKENS = {shadowAlias: SHADOW_ALIAS, colorSlots: THEME_COLOR_SLOTS};

// resolveThemeColors 读取当前主题的具体色值（getComputedStyle 解析 var() 后的结果）。
// ECharts / ELK / 词云的 SSR 输出是静态 SVG，CSS 变量在里面不生效，必须注入具体色值；
// 不维护第二份 JS 色板——单一来源仍是 CSS，这里只做运行时读取。
// 非 DOM 环境（node --test）直接返回兜底值，不抛错。
export function resolveThemeColors() {
    let styles = null;
    try {
        if (typeof document !== 'undefined' && document.documentElement) {
            styles = getComputedStyle(document.documentElement);
        }
    } catch (e) {
        styles = null;
    }
    const out = {};
    for (const [key, v, fb] of THEME_COLOR_SLOTS) {
        let value = '';
        if (styles) {
            try { value = (styles.getPropertyValue(v) || '').trim(); } catch (e) { value = ''; }
        }
        out[key] = value || fb;
    }
    return out;
}

// mermaid 主题映射与 editor/markdown-mermaid.js 的 mermaidThemeForCurrent 保持一致；
// night 背景是深色（#16181f），必须落到 dark，否则图表配色脱节。
export function mermaidThemeIdFor(themeId) {
    return /dark|darcula|night/.test(String(themeId || '')) ? 'dark' : 'neutral';
}

// 统一决策表（方案 §3.3）：何时画、画哪种形态、要不要落盘。
// ai-constants 的 answer-me-with-html 形态判断与 docs/skills 的决策树都以这张表为事实来源。
export const VISUAL_ROUTING = [
    ['一句话能答完 / ≤6 行数据 / 用户要纯文本', '不画，Markdown 表格或正文'],
    ['关系 / 流程 / 层级 / 时序', '```mermaid 声明式图，或 ```svg 手绘卡片'],
    ['柱 / 线 / 饼 / 桑基 / 象限等常规图表', '```mermaid（xychart-beta / pie / sankey-beta），大数据量或复杂坐标系用 ```echarts'],
    ['多维 / 大数据量 / 需精确数值与无障碍描述', '```echarts（option JSON，应用侧 SSR 出静态 SVG）'],
    ['界面 / 布局示意 / 要点对比', '```html 卡片'],
    ['节点 + 边的关系图（不想手排坐标）', '```graph（应用侧 ELK 自动布局）'],
    ['词频 / 关键词权重', '```wordcloud'],
    ['≥4 面板、需留存 / 分享 / 打印', 'answer-me-with-html → .cadt/answers/<slug>.html'],
    ['判断不清时', '先给卡片，用户说「还不够 / 想留一份」再升级成页面'],
];

// 提示词规范文本（单一来源）：ai-constants 的技能 content 从这里拼装。
// inline-visual 正文自 ai-constants.js 原文逐句搬运（阶段 1 纯重构，字节级一致由测试保证）；
// 阶段 3 在此追加 mermaid 图型速查与 echarts 模板。
const INLINE_VISUAL_BASE = [
    '# 内联可视化（inline-visual）',
    '',
    '能画就别只写。回答里用 ```svg 或 ```html 围栏，应用会把代码块渲染成卡片；用户看到的是图，不是代码。',
    '',
    '## 1. 什么时候画',
    '',
    '满足任一条件就画：',
    '- ≥3 个节点 / 模块，且读者需要看清它们的关系。',
    '- 流程、调用链、状态机、时序、数据流向（尤其带分支或多个角色）。',
    '- 多维对比、取舍、能做 / 不能做清单。',
    '- 层级、目录结构、时间演进、版本变化。',
    '- 用户说「画个图 / 没看懂 / 讲讲原理 / 看下结构 / 对比一下 / 出个示意」。',
    '',
    '不画：一句话能答完、纯代码、≤6 行的简单数据（Markdown 表格更清楚）、用户明确要纯文本。',
    '',
    '## 2. 先选形态',
    '',
    '- 一张图 / 一块对比，对话里看完就算 → 本技能的 ```svg 或 ```html 卡片。',
    '- ≥4 个面板、需要留存 / 分享 / 打印、或内容一屏放不下 → skill_use 加载 answer-me-with-html，写成一页 HTML。',
    '- 判断不清时先给卡片；用户说「还不够 / 想留一份」再升级成页面。',
    '',
    '## 3. 围栏怎么写',
    '',
    '- 语言标记只认 svg / html（htm 也行）/ mermaid / echarts；写成其它语言就是普通代码块。',
    '- 一个围栏 = 一张卡片；一条回答最多 3 张，只留最关键的（单条上限 8 张，单块上限 200 KB）。',
    '- 卡片在整轮回答结束后挂载，流式期间显示「正在生成可视化」；不要为此把一张图拆成多段输出。',
    '- 想让它保持代码形态：围栏信息里加 no-widget，如 ```html no-widget。',
    '',
    '## 4. 硬性边界（写之前先记住）',
    '',
    '- 没有 JavaScript：<script>、onclick 等事件属性、javascript: 会被清洗，写了等于没写。交互只能靠纯 CSS（:hover、<details>、checkbox 技巧）。',
    '- 没有 <body> / <html>：body{}、html{} 选择器不生效，容器用 :host，其余用 class。也不要依赖 <header>/<footer> 的浏览器默认样式。',
    '- 不引外链：CDN、远程字体、远程图片、@import、url(http…) 都会被去掉；图标用内联 SVG path 或字符。',
    '- 不要 position:fixed（会被降级为 absolute），不要动画、自动播放、表单、弹窗。',
    '- 样式写在 <style> 里（会注入到卡片的 shadow 内，只作用于卡片），或直接写 style 属性。',
    '- 链接只有 http(s):// 与 mailto: 会交给系统浏览器，其它跳转被拦掉。',
    '- 颜色零硬编码：不写 #fff、#fafafa、#333、rgb(255,255,255)、white 这类具体色值，全部用主题变量或 color-mix 生成。暗色主题下一条白底卡片会整块刺眼；模板兜底值（var(--x,#fff) 里逗号后的那个）只在变量缺失的异常环境出现，不许拿它当正常配色。',
    '',
    '## 5. 颜色必须跟主题走',
    '',
    '卡片活在应用主题里，写死颜色会在另一种主题下刺眼。优先用应用变量：',
    '',
    '- 文字 --text、次要文字 --muted、卡片底色 --panel2、次级底色 --panel、页面底 --bg、边框 --border、强调 --accent、强调上的字 --on-accent。',
    '- 也支持通用别名：--color-text-primary、--color-text-secondary、--color-background-primary/secondary/tertiary、--color-border-secondary/tertiary、--color-accent。',
    '- 每个变量都带兜底：fill="var(--text,#1f2328)"。',
    '- 不要用 prefers-color-scheme：应用主题由用户手选，不跟系统走，媒体查询会判断错。',
    '- 语义色可用 var(--green) / var(--red) / var(--warn)；需要浅色块时用 color-mix(in srgb, var(--accent) 14%, transparent)。',
    '- 自检：交稿前扫一遍自己写的颜色——凡是不在 var() 兜底位置上的 hex、rgb、white、black 都换成变量。大面积白底 / 浅灰底是暗色主题下最常见的翻车点，模拟「应用 UI」的卡片（标题条、按钮、标签）同样只用变量画，不要凭记忆复刻浅色界面。',
    '',
    '## 6. 尺寸与排版',
    '',
    '- svg 必须有 viewBox（如 0 0 680 360），不要写死 width/height；卡片会按容器宽度缩放，最大高度 520px。',
    '- 卡片宽度大约等于面板宽度（常见 380–600px）：最多两列，栅格用 repeat(auto-fit,minmax(220px,1fr))。',
    '- 字号 13–14px，注释 ≥11px；一个节点最多两行字，标签 ≤10 个字。',
    '- 宁可字少、箭头清楚；解释性文字放到卡片外面的正文里。',
    '- 纵向超过 600 的图拆成两张卡片。',
    '',
    '## 7. 模板',
    '',
    '### A. SVG 流程 / 架构图',
    '',
    '```svg',
    '<svg viewBox="0 0 680 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="请求处理流程">',
    '  <style>',
    '    .b{fill:var(--panel2,#f2f4f7);stroke:var(--border,#d8dde4);stroke-width:1.2}',
    '    .t{fill:var(--text,#1f2328);font-size:13px;text-anchor:middle}',
    '    .s{fill:var(--muted,#6b7280);font-size:11px;text-anchor:middle}',
    '    .l{stroke:var(--muted,#9aa4b2);stroke-width:1.4;fill:none}',
    '  </style>',
    '  <defs>',
    '    <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">',
    '      <path d="M0 0 10 5 0 10z" fill="var(--muted,#9aa4b2)"/>',
    '    </marker>',
    '  </defs>',
    '  <rect class="b" x="16" y="84" width="150" height="54" rx="10"/>',
    '  <text class="t" x="91" y="108">用户操作</text>',
    '  <text class="s" x="91" y="126">点击 / 快捷键</text>',
    '  <path class="l" d="M166 111 H246" marker-end="url(#ar)"/>',
    '  <rect class="b" x="246" y="84" width="150" height="54" rx="10"/>',
    '  <text class="t" x="321" y="108">主进程校验</text>',
    '  <text class="s" x="321" y="126">权限 / 路径</text>',
    '  <path class="l" d="M396 111 H476" marker-end="url(#ar)"/>',
    '  <rect class="b" x="476" y="84" width="188" height="54" rx="10"/>',
    '  <text class="t" x="570" y="108">前端渲染</text>',
    '  <text class="s" x="570" y="126">卡片 / 表格</text>',
    '</svg>',
    '```',
    '',
    '要点：节点等宽等高、间距 80；箭头统一走 marker；标签两行（名词 + 一句说明）。',
    '',
    '### B. HTML 对比 / 要点卡',
    '',
    '```html',
    '<style>',
    '  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}',
    '  .card{border:1px solid var(--border);border-radius:10px;padding:10px 12px;background:var(--panel2)}',
    '  .k{color:var(--muted);font-size:12px;margin-bottom:4px}',
    '  .v{font-size:13px}',
    '  .tag{display:inline-block;padding:0 6px;border-radius:5px;font-size:11px;background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent)}',
    '</style>',
    '<div class="grid">',
    '  <div class="card"><div class="k">读取路径</div><div class="v">一次读全量，前端分片渲染</div></div>',
    '  <div class="card"><div class="k">写入路径</div><div class="v">先校验 mtime，再落盘 <span class="tag">有冲突检测</span></div></div>',
    '</div>',
    '```',
    '',
    '### C. 时序 / 状态机',
    '',
    '沿用 A 的骨架：横向排时间点，纵向排参与者；跨泳道只画关键几条连线，其余用编号在正文说明。',
    '',
    '## 8. 内容规则',
    '',
    '- 先一句话结论，再给卡片；卡片后不要用文字重复图里已有的内容。',
    '- 节点里放「名词 + 动作」，细节写正文。',
    '- 不编造数据；示意数据要标「示意」。',
    '- 图里引用代码位置时写 path:line。',
    '',
    '## 9. 常见错误',
    '',
    '- 用 <script> 做交互 → 卡片里没有 JS，改成静态展示。',
    '- 写 body{background:#fff} → 无效，深色主题下还会白白一片；改用 :host 或变量。',
    '- SVG 硬编码 width="1200" → 撑爆卡片；用 viewBox。',
    '- 把整段解释塞进节点 → 拆成「图 + 正文」。',
    '- 一条回答贴五张卡片 → 只保留最关键的一张。',
    '- 写死浅色配色（白底卡、浅灰分隔、深色文字）→ 暗色主题下整卡刺眼；对照模板 A/B：底色 var(--panel2)、文字 var(--text)、描边 var(--border)，灰色阶用 color-mix(in srgb, var(--text) N%, transparent) 生成，两种主题都成立。',
    ].join('\n');

// mermaid 图型速查（阶段 3）：零新增字节，把内置 19 种图型写进规范，
// 让模型优先用声明式语法而不是手算坐标（完整清单见方案 §10.1）。
const MERMAID_SHEET = [
    '## 10. mermaid 声明式图速查（```mermaid 围栏，优先于手写 SVG，坐标交给引擎）',
    '',
    '- 结构 / 关系：flowchart、classDiagram、erDiagram、architecture-beta、block-beta、C4Context、requirementDiagram',
    '- 时序 / 状态：sequenceDiagram、stateDiagram-v2、gantt、timeline、gitGraph、journey',
    '- 层级 / 发散：mindmap、quadrantChart、packet-beta、sankey-beta',
    '- 数据：xychart-beta（柱 / 线）、pie',
    '',
    '示例（柱状图）：',
    '```mermaid',
    'xychart-beta',
    '    title "各格式解析耗时（示意）"',
    '    x-axis [json, yaml, csv, toml]',
    '    y-axis "毫秒" 0 --> 120',
    '    bar [80, 35, 62, 21]',
    '```',
    '',
    '示例（流程图，箭头与分支交给语法而不是坐标）：',
    '```mermaid',
    'flowchart LR',
    '    A[读取文件] --> B{编码检测}',
    '    B -- GBK --> C[转码]',
    '    B -- UTF-8 --> D[直接解析]',
    '    C --> E[渲染]',
    '    D --> E',
    '```',
].join('\n');

// echarts 模板与硬边界（阶段 3）：option 是纯 JSON 数据，应用侧 SSR 出静态 SVG。
const ECHARTS_TEMPLATE = [
    '## 11. echarts 声明式图表（```echarts 围栏，option 写成纯 JSON，应用负责渲染与主题）',
    '',
    '多维数据 / 精确数值 / mermaid 覆盖不了的图型（桑基、热力、treemap、sunburst、雷达、箱线等）用它：',
    '',
    '```echarts',
    '{',
    '  "xAxis": {"type": "category", "data": ["JSON", "YAML", "CSV", "TOML"]},',
    '  "yAxis": {"type": "value"},',
    '  "series": [{"type": "bar", "data": [120, 90, 150, 60]}]',
    '}',
    '```',
    '',
    '```echarts',
    '{"series": [{"type": "pie", "data": [{"name": "A", "value": 10}, {"name": "B", "value": 7}]}]}',
    '```',
    '',
    '硬边界：',
    '- 只写纯 JSON：不要函数、不要注释、不要尾逗号；禁止 formatter / rich 字段（会被整体拒绝并降级显示源码）。',
    '- 不要写 animation 与配色：应用强制关闭动画并注入当前主题色；确需强调可写 var(--text) 这类应用变量，应用会替换成具体色值。',
    '- 坐标轴、轴标签、数值标签、图例、标题的颜色由应用按主题自动注入（深色主题下还会做可读性兜底）：不要写 #333 / #000 / #fff 这类浅底专用色。',
    '- 不要外链图片与 url() 资源；单块不超过 200 KB，超限降级为源码。',
    '- 静态 SVG 没有 tooltip / dataZoom 等交互，不要写交互配置。',
].join('\n');


// graph / wordcloud 提示词节（阶段 6）：模型只给数据，布局交给引擎，坐标不进上下文。
const GRAPH_TEMPLATE = [
    '## 12. 关系图自动布局（```graph 围栏，只给节点和边，坐标交给引擎）',
    '',
    '不想手排坐标的架构图 / 依赖图 / 调用图用它：',
    '',
    '```graph',
    '{',
    '  "nodes": [{"id": "ui", "label": "前端"}, {"id": "go", "label": "Go 后端"}, {"id": "db", "label": "SQLite"}],',
    '  "edges": [{"from": "ui", "to": "go"}, {"from": "go", "to": "db"}],',
    '  "algorithm": "layered"',
    '}',
    '```',
    '',
    '- algorithm 可选 layered（分层，默认）/ force（力导向）/ stress。',
    '- 节点 ≤150、边 ≤300；节点 id 唯一，edges 的 from / to 必须是已有 id（不存在的边会被丢弃）。',
    '- label 一行 ≤8 字为宜；不用写坐标，布局失败会自动退简单分层兜底。',
].join('\n');

const WORDCLOUD_TEMPLATE = [
    '## 13. 词云（```wordcloud 围栏，词频数据）',
    '',
    '```wordcloud',
    '{"words": [{"text": "解析", "value": 30}, {"text": "缓存", "value": 18}, {"text": "虚拟滚动", "value": 9}]}',
    '```',
    '',
    '- words ≤120；value 是权重（正数，缺省 1），权重决定字号与颜色深浅。',
    '- 适合主题词、日志关键词、tag 概览；停用词自己先过滤掉再给。',
].join('\n');

// 组装：inline-visual 一份文本承载全部图型规范（mermaid 速查 + echarts 模板 + graph + 词云）。
export const VISUAL_RULES = {
    inlineVisual: [INLINE_VISUAL_BASE, MERMAID_SHEET, ECHARTS_TEMPLATE, GRAPH_TEMPLATE, WORDCLOUD_TEMPLATE].join('\n\n'),
    mermaidSheet: MERMAID_SHEET,
    echartsTemplate: ECHARTS_TEMPLATE,
    graphTemplate: GRAPH_TEMPLATE,
    wordcloudTemplate: WORDCLOUD_TEMPLATE,
};
