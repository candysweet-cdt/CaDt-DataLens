# 统一可视化能力（Visualizer）实施计划

> 状态：**方案已定，待实施**（本轮只出方案，不改代码）
> 范围：AI 回答内的可视化（对话内卡片 + 落盘页面），不含主界面 Markdown 预览与阅读模式
> 首轮交付：阶段 1–5 全部，含卡片「另存为」与图表引擎
> 已定决策：围栏驱动 / 不做 `visualize` 工具 / 另存为纳入首轮 / **≤5 MB 依赖可接受，能力优先**（见 §7）
> 版本预算：**+1.07 MiB**（ECharts 全量，照 mermaid 放 `public/vendor/` 懒加载），远低于 5 MB
> 版本号：不变更（内部能力整合，无新增设置项）
> 提出日期：2026-11-13

## 1. 背景

参考 WorkBuddy 内置 Visualizer 后重新审视本应用，结论是：**渲染内核已经有了，缺的是把它升格为「一套能力」的规范层与路由层，以及让模型能声明式出图的引擎。**

WorkBuddy 的 Visualizer 由三层构成，与具体渲染技术无关：

1. **规范层** `widget_guidelines(modules)`：按需加载 `diagram` / `chart` / `mockup` / `interactive` / `art` 五套规范，含 design tokens、色板、排版、复杂度预算、无障碍、图表规则。
2. **路由层**：何时画、画哪种形态、要不要写成文件。
3. **渲染层** `show_widget`：把 SVG / HTML 片段内联渲染，容器负责主题、CSP、无障碍。

本应用已具备 1 的内容（写在提示词里）、2 的雏形（散在 3 处）、3 的实现（`widget.js`，安全性更严）。差距在于这三层各自为政，且**模型出图只能手写 SVG 坐标**。

### 1.1 现状五条管线（已核对源码）

| # | 管线 | 锚点 | 说明 |
|---|---|---|---|
| 1 | `svg` / `html` 卡片 | `frontend/src/widget.js`、`markdown.js:47`、`ai/ai-panel.js:5830` | `WIDGET_LANGS = {svg, html, htm}`；Shadow DOM + DOMPurify + CSS 清洗；`MAX_WIDGETS_PER_MESSAGE=8`、`MAX_WIDGET_CHARS=200KB`；流式期间只标 pending，整轮结束才挂载；卡片带「源码 / 复制」 |
| 2 | mermaid 11 | `main.js:6353–6413` | `ensureMermaidScript()` 懒加载 `/vendor/mermaid/mermaid.min.js`（2.57 MB），`securityLevel:'strict'` + DOMPurify 二次清洗 |
| 3 | 图片 | `markdown.js:35`（`data-ai-src`）、`main.js:6418`（`resolveMarkdownImages`）、`image-lightbox.js` | Windows 盘符路径经 `ADD_URI_PROTOCOL:['c']` 放行，后端 `ReadImageAsDataURL` 转 data URL |
| 4 | HTML 回答页 | 内置技能 `answer-me-with-html`（`ai/ai-panel.js:524`） | `write_file` → `.cadt/answers/<slug>.html` → `app_control` 内嵌浏览器打开 |
| 5 | 纯 CSS 柱图 | `reading/reading-view.js:520` | 阅读模式最近 7 天统计，独立实现 |

规范文本分散在三处：`inline-visual`（`ai-panel.js:395`）、`answer-me-with-html`（`ai-panel.js:524`）、`docs/skills/cadt-file-layout/SKILL.md:27`。且 `widget.js:21` 的 `SHADOW_STYLE` 又手写了一份 `--color-*` 别名映射，与 `inline-visual` 第 5 节的变量清单是两份事实。

### 1.2 前提变更（2026-11-13 作者确认）

作者明确：**5 MB 以内的依赖都可接受，更重要的是给模型扩展可视化能力。**

- 这解除了 `AGENTS.md`「体积第一约束」在本功能上的限制，属于作者批准的**本次例外**（记法参照已有的 SQLite 派生索引例外），不外推到全项目。
- 于是体积不再是选型依据，**硬约束只剩一条**：`AGENTS.md` 的「原始 HTML 不执行」——卡片内容在 Shadow DOM 里，`<script>` 被 DOMPurify 清除。
- 目标重述：让模型用**声明式语法 / 结构化 option** 出图，而不是手写 `<rect x=… width=…>`。数值、刻度、比例交给渲染引擎，模型只负责选图型和给数据。

### 1.3 关键判断

- **不再写一个渲染器。** `widget.js` 的 Shadow DOM + DOMPurify + 禁 `<script>` 边界比 WorkBuddy 更严，保留并升格。
- **安全边界与"引库"不冲突，前提是库在应用侧跑、产出静态 SVG。** 见 §3.5 的 SSR 方案。
- **复用已内置的 mermaid。** 实测 `frontend/public/vendor/mermaid/mermaid.min.js` 含 `xychart-beta`（2）、`pie`（271）、`sankey-beta`（2）、`block-beta`（2）、`packet-beta`（3）、`quadrantChart`（26）、`gitGraph`（17）。零新增字节即可给模型一整套声明式图语法。
- **不动 `main.js`（除 §4 阶段 3 的一处可选抽取）。** 作者有在途改动，实施前重跑 `git status` 核对。

## 2. 目标与非目标

### 目标

- **能力优先**：模型用 ` ```mermaid ` / ` ```echarts ` 声明式语法出图，覆盖柱/线/饼/桑基/象限/树图/热力等；不再手算 SVG 坐标。
- 规范单一来源：design tokens / 尺寸 / 复杂度预算 / 无障碍写成一份 JS 数据，代码与提示词共用。
- 统一路由：把三处「何时画 / 哪种形态 / 是否落盘」收敛成一张决策表。
- 统一外壳：所有 AI 可视化共用一张卡片（标签、源码、复制、限额、流式策略、链接拦截）；`kind` 元数据区分形态。
- 打通卡片 → 落盘：卡片「另存为」写 `.cadt/answers/`，使对话内卡片与 HTML 回答页不再是两条割裂管线。

### 非目标（明确不做）

- 不做 `visualize` 工具（模型调工具传 widget_code）：需新增消息类型、工具注册、JSONL 重放语义，与 `skill_use` 重复，见 §9。
- **不引 Chart.js**：205 KiB 虽最小，但输出 Canvas，需在卡片外持有活的 `Chart` 实例并管理 resize / 主题 / 销毁生命周期，对 Shadow DOM 卡片最不友好，能力也弱于 ECharts。
- 不改 `html:false`、不放宽 DOMPurify 白名单、不允许 `<script>` / 外链资源 / `position:fixed`；**模型输出的 option 永远是数据，不是可执行代码**。
- 不合并图片灯箱、阅读模式、jsoneditor / CSV 表格视图。
- 不新增设置项与用户可见开关（沿用现有 `settings.aiInlineWidgets`）。
- 不改 `frontend/dist/` 与 `frontend/wailsjs/`（构建产物）。

## 3. 设计

### 3.1 kind 分类（元数据，不是新引擎）

围栏信息里带 `kind=xxx`，或直接用语言别名。`kind` 只影响卡片标签、提示词规范段落、无障碍 `aria-label`、以及「另存为」的扩展名。

| kind | 承载 | 典型场景 | 围栏 |
|---|---|---|---|
| `diagram` | SVG | 流程 / 架构 / 时序 / 层级 | ` ```svg `（默认）或 ` ```mermaid ` |
| `chart` | mermaid 语法 / ECharts option JSON | 柱 / 线 / 饼 / 桑基 / 象限 / 热力 | ` ```mermaid `、` ```echarts ` |
| `mockup` | HTML+CSS | 界面 / 表单 / 布局示意 | ` ```html kind=mockup ` |
| `card` | HTML+CSS | 要点卡 / 对比表 / 清单 | ` ```html `（默认） |

不设 `interactive`（禁 `<script>` 下只有 `:hover` / `<details>` 纯 CSS 交互）、不设 `art`。

兼容性：`widgetLangOf` 现有行为不变，新增别名与 `kind=` 修饰都是增量；未识别围栏仍是普通代码块；`no-widget` 语义不变。

### 3.2 规范单一来源

新增 `frontend/src/ai/visual-spec.js`，导出 `VISUAL_TOKENS`（主题变量 + `--color-*` 别名 + 兜底色）、`VISUAL_BUDGET`（viewBox 680 / 高 520px / 字号 ≥11px / 最多两列 / 单条 ≤3 张 / 单块 200 KB / 单条上限 8 张 / CSS 24 KB）、`VISUAL_RULES`（按 kind 分组的规范文本）、`VISUAL_ROUTING`（§3.3 决策表文本）。

`widget.js` 的 `SHADOW_STYLE` 由 `VISUAL_TOKENS` 生成；`ai-panel.js` 的 `inline-visual` content 改为拼装 `VISUAL_RULES`。`answer-me-with-html` 与 `cadt-file-layout` 的形态判断改为引用同一张表。

**额外职责**：`VISUAL_TOKENS` 还要能导出「当前主题的具体色值」，供 ECharts SSR 注入 option（见 §3.5，静态 SVG 里 CSS 变量不生效）。

### 3.3 统一决策表

| 条件 | 出口 |
|---|---|
| 一句话能答完 / ≤6 行数据 / 用户要纯文本 | 不画，Markdown 表格或正文 |
| 关系 / 流程 / 层级 / 时序 | ` ```mermaid ` 声明式图，或 ` ```svg ` 手绘卡片 |
| 柱 / 线 / 饼 / 桑基 / 象限等常规图表 | ` ```mermaid `（`xychart-beta` / `pie` / `sankey-beta`） |
| 多维 / 大数据量 / 复杂坐标系 / 需精确数值与无障碍描述 | ` ```echarts `（option JSON → SSR SVG） |
| 界面 / 布局示意 / 要点对比 | ` ```html ` 卡片 |
| ≥4 面板、需留存 / 分享 / 打印 | `answer-me-with-html` → `.cadt/answers/<slug>.html` |
| 用户点卡片「另存为」 | 同一内容写 `.cadt/answers/<slug>.<ext>` |

「判断不清先给卡片，用户说不够再升级成页面」保持现有约定。

### 3.4 三层能力阶梯（能力优先后的选型）

| 层 | 方案 | 新增体积 | 模型要写什么 | 能力 |
|---|---|---|---|---|
| L0 | 纯 SVG 手绘（原方案） | 0 | `<svg>` 坐标全手算 | 最弱，比例/刻度靠模型估算，不可复核 |
| **L1** | **复用内置 mermaid 11** | **0** | `xychart-beta` / `pie` / `sankey-beta` 等声明式文本 | 柱/线/饼/桑基/象限/时序，零成本、现成懒加载与 strict 净化 |
| **L2** | **ECharts 6 SSR → SVG 字符串** | **+1.07 MiB** | ECharts `option` JSON | 20+ 图型、dataset transform、自动 aria-label / decal 无障碍、数值精确 |
| L3 | Chart.js（不采纳） | +205 KiB | chart config | Canvas，须管理活实例；能力弱于 L2 |

**首轮上 L1 + L2。** 合计 +1.07 MiB，占 5 MB 预算的 21%，exe 从 28.0 MB → 约 29.1 MB（+3.8%）。L1 当天可用、L2 是真正的能力扩展。

### 3.5 L2 实现要点：ECharts SSR → 静态 SVG（保留禁脚本边界）

官方 SSR API（5.3.0 起，6.x 沿用，零依赖字符串拼接、不需要 DOM）：

```javascript
const chart = echarts.init(null, null, {renderer: 'svg', ssr: true, width: 640, height: 360});
chart.setOption(option);
const svgStr = chart.renderToSVGString();
chart.dispose();
```

链路：` ```echarts ` 围栏只带 **JSON option** → `markdown.js` 生成占位 → 应用侧懒加载 `/vendor/echarts/echarts.min.js`（照 `ensureMermaidScript()` 的模式）→ `JSON.parse` + 白名单校验 → SSR 出 SVG 字符串 → `sanitizeWidgetHtml(svg, 'svg')` → 塞进现有 Shadow DOM 卡片。

**关键：卡片里从头到尾没有可执行代码。** 库在应用侧运行，产出的是静态 SVG，与 ` ```svg ` 卡片走完全相同的清洗与挂载管线。这正好绕开「库需要 JS、卡片禁 JS」的矛盾。

必须处理的细节：

- **option 安全校验**：只接受纯 JSON；禁 `formatter` / `label.formatter` 等可写函数字符串字段、禁 `rich` 里的 HTML；`animation: false`（避免 SSR 把 CSS 动画 `<style>` 嵌进 SVG）；`backgroundColor: 'transparent'`；禁外链图片与 `url(...)` 资源。校验不过就降级显示源码。
- **主题**：SSR 输出的是**具体色值**，静态 SVG 里 `var(--text)` 不会被解析。渲染时把 `VISUAL_TOKENS` 的当前主题色写进 `option.color` / `textStyle` / `axisLine` 等；**主题切换或卡片宽度变化需重新 SSR 一次**（`dispose` 旧实例）。这是与纯 SVG 卡片最大的行为差异，要写进测试。
- **尺寸**：SSR 必须显式给 width/height，按卡片宽度渲染（建议 640×360 或 640×400），输出 SVG 带 viewBox，由 CSS 缩放；不做容器自适应。
- **限制**：静态 SVG 无 tooltip / dataZoom 等交互；中文文本宽度在 SSR 里用简化测量，长标签可能略偏；1.07 MiB 首次加载有可感延迟，需懒加载 + 占位提示。
- **ECharts 6 破坏性变更**：v6 默认主题与布局计算有变化（`grid.containLabel` 弃用等），提示词模板要按 v6 写，升级需截图回归。

### 3.6 L1 实现要点：mermaid 复用

- 已内置 mermaid 11 与 `renderMermaidBlocks`（`main.js:6386`），`securityLevel:'strict'` + DOMPurify 兜底都有。
- 让 AI 卡片的 ` ```mermaid ` 也能渲染，最小改法是在 `widget.js` / 新增 `mermaid-render.js` 里**自己写一个 20 行懒加载器**（检查 `window.mermaid`，没有就插 `<script src="/vendor/mermaid/mermaid.min.js">`），完全不动 `main.js`；代价是加载逻辑有两份。
- 更干净的做法是抽 `frontend/src/mermaid-render.js` 供 `main.js` 与 AI 面板共用，但**需改 `main.js` 一处**，与作者在途改动冲突，标为阶段 3 的可选项，实施前确认。
- 提示词补一段 mermaid 图表语法速查（`xychart-beta` / `pie` / `sankey-beta`），优先于手写 SVG。

### 3.7 实测体积数据（2026-11-13）

从官方分发文件实测（`jsdelivr` 包元数据 + CDN `Content-Encoding: gzip` 响应头）。注意**进 exe 的是未压缩原始字节**——`frontend/dist` 经 `go:embed` 原样编入二进制：

| 产物 | 原始 | gzip | 加进 exe |
|---|---|---|---|
| 复用内置 mermaid（L1） | 0 | 0 | **0** |
| Chart.js 4.6.1 `chart.umd.js` | 205 KiB | 70 KiB | +205 KiB |
| ECharts 6.1.0 `echarts.simple.min.js` | 489 KiB | 166 KiB | +489 KiB |
| ECharts 6.1.0 `echarts.common.min.js` | 698 KiB | 235 KiB | +698 KiB |
| **ECharts 6.1.0 `echarts.min.js`（全量，选用）** | **1096 KiB** | **361 KiB** | **+1.07 MiB** |
| 对照：现有 `mermaid.min.js` | 2514 KiB | — | 已在包内 |

基线：`build/bin/CaDt-DataLens.exe` 28.0 MB、`frontend/dist` 9.3 MB、`dist/assets/index-*.js` 2.0 MiB。ECharts 全量约为 mermaid 的 44%，仍在 5 MB 预算内。若改用 npm 依赖 + Vite tree-shaking，ECharts core + 少量图型约 350–450 KiB 原始，但会进主包、失去懒加载，**不采用**。

## 4. 实施阶段（每阶段可独立提交 / 回滚）

### 阶段 1：规范抽离（纯重构，行为零变化）

1. 新增 `frontend/src/ai/visual-spec.js`，把 `widget.js:11–37` 常量与 `SHADOW_STYLE`、`inline-visual` 第 5/6 节的变量与数字搬进去，额外导出「当前主题具体色值」。
2. `widget.js` 改为 import `VISUAL_TOKENS` / `VISUAL_BUDGET` 生成 `SHADOW_STYLE` 与限额常量。
3. `ai-panel.js` 的 `inline-visual` content 改为拼装 `VISUAL_RULES`，文字与原版逐句对齐。
4. 新增 `visual-spec.test.mjs`；`frontend/package.json` test script 追加该文件（硬编码列表，不加就不会执行）。
5. 验证：`npm test` 全绿（含 `widget.test.mjs` 现有 7 例）→ `npm run build` → 冒烟出一张 `svg` 卡片，与改动前逐像素比对无差异。

### 阶段 2：kind 路由与统一外壳

1. `widget.js` 新增 `widgetKindOf(info)` / `WIDGET_KINDS`；`widgetLangOf` 增加 `mermaid` / `echarts` / `chart` 别名（`chart` 作为 `echarts` 的兼容别名）。
2. `buildWidgetPlaceholder` 输出 `data-widget-kind`，标签按 kind 显示中文短标签。
3. `markdown.js` fence 分流改用 `widgetKindOf`，`no-widget` 语义不变。
4. 补 `widget.test.mjs` 表驱动用例（大小写、`kind=` 修饰、未知 kind 回退、`no-widget` 不误判、新别名占位结构）。
5. 验证：`npm test` → `npm run build` → 四种 kind 各一张，浅色 / 深色主题变量生效。

### 阶段 3：图表引擎（能力扩展主线）

1. **L1 mermaid 卡片**：新增 `frontend/src/ai/mermaid-render.js`（懒加载器 + `mermaid.render` + DOMPurify 兜底），接进 `enhanceWidgets` 的异步分支；`inline-visual` 补 mermaid 语法速查。默认不动 `main.js`（可选抽取见 §3.6）。
2. **L2 ECharts SSR**：把 `echarts.min.js`（1.07 MiB）放 `frontend/public/vendor/echarts/`；新增 `frontend/src/ai/chart-render.js`（懒加载、option 校验、主题色注入、SSR→SVG、`dispose`、主题/宽度变化重渲染）；产物走 `sanitizeWidgetHtml(svg,'svg')` 进现有卡片。
3. `inline-visual` 补 ` ```echarts ` 的 option 模板与硬边界（纯 JSON、无 formatter 函数、无外链、禁动画）。
4. 新增 `chart-render.test.mjs`：option 白名单拒绝用例、超限与非法 JSON 降级、主题色注入、`animation:false` 强制、SSR 产物不含 `<script>`。
5. 验证：`npm test` → `npm run build` → 冒烟 mermaid 柱图 / ECharts 饼图各一张；切换主题后重渲染；`wails build -devtools` 实测 exe 体积与首次加载延迟。

### 阶段 4：卡片出口统一（已确认纳入首轮）

1. 卡片新增「另存为」，复用 `write_file` 写 `.cadt/answers/<slug>.svg` / `.html`；不新增 Go 方法。
2. `answer-me-with-html` 的形态判断改为引用 `VISUAL_ROUTING`。
3. `docs/skills/cadt-file-layout/SKILL.md` 第 27 行决策树同步为「以 visual-spec.js 为准」。
4. 卡片内 `<img>` 接入 `data-ai-src` 解析（复用 `ReadImageAsDataURL`）。
5. 验证：另存为文件可离线打开、不含 `<script>`；只读档下按钮禁用且不报错。

### 阶段 5：文档同步

- `AGENTS.md`：补 `visual-spec.js` / `chart-render.js` / `mermaid-render.js` 与 `widget.js` 新职责；**记一条作者批准的体积例外**（本功能 ≤5 MB 可接受，参照 SQLite 派生索引例外的写法）；顺手修正已过时的路径（`ai-panel.js` 已在 `src/ai/`，`widget.test.mjs` 已存在）。
- `CHANGELOG.md` / `README.md`：阶段 3 起有用户可见变化，同步对应小节。
- 全部实施后把本文档移入 `docs/finished-plans/`。

## 5. 文件改动清单

| 文件 | 动作 | 阶段 |
|---|---|---|
| `frontend/src/ai/visual-spec.js` / `.test.mjs` | 新增（约 180 行 + 测试） | 1 |
| `frontend/src/ai/mermaid-render.js` | 新增（懒加载 + 渲染） | 3 |
| `frontend/src/ai/chart-render.js` / `.test.mjs` | 新增（option 校验 + SSR→SVG） | 3 |
| `frontend/public/vendor/echarts/echarts.min.js` | **新增 vendor 资源（1.07 MiB）** | 3 |
| `frontend/public/vendor/licenses/echarts.LICENSE` | 新增许可证文件 | 3 |
| `frontend/src/widget.js` / `.test.mjs` | 改：常量外移、kind 解析、异步渲染分支、标签、另存为 | 1–4 |
| `frontend/src/markdown.js` | 改：fence 分流接 `widgetKindOf` | 2 |
| `frontend/src/ai/ai-panel.js` | 改：技能内容拼装规范、补 mermaid / echarts 模板 | 1–4 |
| `frontend/package.json` | 改：test script 追加两个新测试 | 1、3 |
| `docs/skills/cadt-file-layout/SKILL.md` | 改：决策树引用单一来源 | 4 |
| `AGENTS.md` / `CHANGELOG.md` / `README.md` | 改：文档与体积例外 | 5 |
| `frontend/src/main.js` | **默认不改**；仅当采纳 §3.6 共用抽取时改一处，实施前须与作者确认 | 3（可选） |

## 6. 验证与体积

- `cd frontend && npm test` → `npm run build` → `wails build -devtools` 冒烟。
- 冒烟清单：四种 kind 各一张；mermaid 柱图 / ECharts 饼图；流式期间不闪烁；整轮结束后挂载；8 张 / 200 KB 超限降级为源码；`no-widget` 保持代码块；浅色 / 深色主题切换后 ECharts 重渲染且颜色正确；卡片内链接交系统浏览器；`<script>` / `onclick` / 外链 `url()` / `position:fixed` 仍被清洗；**ECharts option 里塞 `formatter` 函数字符串被拒并降级**；会话重放后卡片仍在。
- 体积：新增 vendor 1.07 MiB + 约 400 行 JS（含测试）；exe 28.0 MB → 约 29.1 MB（+3.8%），在作者批准的 5 MB 预算内。
- 性能：库懒加载、不进 Vite 主包；卡片挂载时机、限额、pending 策略不变；ECharts 实例用完即 `dispose`，不常驻；不新增全局监听。

## 7. 已定决策与剩余开放问题

### 7.1 已定（2026-11-13 作者确认）

| 议题 | 决定 | 理由 |
|---|---|---|
| 触发形态 | **围栏驱动**，不做 `visualize` 工具 | 卡片即文本，与会话 JSONL 真源天然兼容；不碰会话核心 |
| 本轮动作 | **只出方案，不改代码** | 先 review 设计 |
| 「另存为」 | **纳入首轮** | 对话内卡片与 `.cadt/answers/` 共用同一内核 |
| **依赖预算** | **≤5 MB 可接受，能力优先于体积** | 作者明确；解除体积约束，聚焦给模型扩展可视化能力 |
| **图表引擎** | **L1 复用 mermaid + L2 ECharts SSR→SVG；不引 Chart.js** | 见 §3.4；合计 +1.07 MiB，且静态 SVG 产出不破坏禁脚本边界 |

### 7.2 术语澄清

- **围栏驱动**：模型把图当作回复正文的一部分输出（```svg / ```mermaid / ```echarts），`markdown.js` fence 规则识别后生成占位，应用侧渲染并挂卡片。消息里就是一段 `content` 字符串。
- **工具驱动**：模型发起一次 `tool_calls`（仿 `AI_TOOL_DEFS.skill_use`），参数带 `kind` / `code`；工具返回后界面插入卡片。图不再是文本，需要 `ai-session-store.js` 存调用、结果与卡片位置，`ai-panel.js:6258` 的 `tool_calls` 一一配对约束也要扩展。WorkBuddy `show_widget` 属于此类。

两者**共用同一个 Shadow DOM 渲染内核**，区别只在「图怎么从模型进到界面」。

### 7.3 剩余开放问题

1. **mermaid 加载逻辑是否抽共用模块**：抽取更干净但要改 `main.js` 一处（与作者在途改动冲突）；不抽则在 AI 面板侧多一份 20 行加载器。默认选不抽。
2. **ECharts 是否走全量 vendor**：全量 1.07 MiB / 懒加载 / 零配置，选用；tree-shaken ESM 更小但进主包、失去懒加载，不采用。
3. **是否最终切到工具驱动**：见 §9，不构成当前阻塞。

## 8. 风险

- **提示词回归**：`inline-visual` 内容改为拼装后，模型可见文本语序变化可能影响出图质量。阶段 1 要求逐句对齐、diff 可审。
- **模型写错 option**：JSON 非法 / 用了函数式 `formatter` / 图型名拼错都可能导致空图。必须做白名单校验 + 失败降级为源码，并把 v6 常见字段写进模板。
- **SSR 静态 SVG 不支持 CSS 变量**：主题切换与宽度变化要重新 SSR，若漏掉会出现「换了深色主题图还是浅色」；列进冒烟必测。
- **首次加载延迟**：1.07 MiB 首次懒加载可感，需占位提示；ECharts 实例必须 `dispose`，否则多图会话内存累积。
- **ECharts 6 破坏性变更**：默认主题 / 布局计算与 v5 不同，升级需截图回归，提示词模板按 v6 写。
- **规范漂移**：`cadt-file-layout/SKILL.md` 是纯文本无法 import JS，只能文档注明单一来源，阶段 5 复核。
- **未提交改动（重点）**：方案阶段 1 / 3 需要改 `frontend/src/ai/ai-panel.js` 的技能内容，而 21:50 的 `git status` 显示该文件**已有作者在途改动**（另有未跟踪 `ai-constants.js`）。实施前必须重跑 `git status`、先读该文件的当前内容再定位，不得 `git checkout` / `reset`；若作者的改动正好也在技能定义区，先与作者确认合并方式，必要时把「技能文本拼装」延后到阶段 5。
- **AGENTS.md 已过时**：`src/ai-panel.js`、`src/ai-session-store.js` 等路径已随 `structure-cleanup.md` 阶段 1 移入 `src/ai/`，引用行号前先实测核对。

## 9. 长线演进：工具驱动值不值得切

首轮选围栏驱动的依据是「改动面 + 会话层风险」。作者解除体积预算后，**§9.1 第 5 条的长线优点已可在围栏驱动下提前兑现**：` ```echarts ` 的 option JSON 本身就是结构化数据，应用侧精确绘图、数值来自模型给出的数据而非手算坐标，不需要切工具驱动、不需要付会话层的税。

### 9.1 工具驱动仍然独有的长线优点

1. **图能被会话子系统认识**：卡片是 Markdown 渲染的副产物，无身份；`session-outline.js`、`sessionindex*.go`、`activity.go` 只认识文本。带 `id` / `kind` / `title` 后才能进大纲、被检索、单独折叠 / 重绘 / 撤销。
2. **上下文成本可压掉**：一段 SVG / 一份 option JSON 常 2–5k token，每轮重发都带着；工具调用参数可在上下文组装时替换为一句占位（保留 `tool_call id` + 结果摘要）。`ai-session-store.js:103-117` 已有 `archive` / `truncate` / `summary` 机制。
3. **规范从软约束变硬约束**：工具 schema 可强制 `kind` 枚举、option 长度、必填字段，渲染前强校验。
4. **稳定挂载点带来真交互**：卡片禁 `<script>`，交互只能外层注入；工具驱动给每张卡片稳定 id，围栏驱动靠 DOM 顺序，重放后漂移。

### 9.2 不会消失的成本

- **会话层永久税**：`serializeSessionMessage` / `encodeMessageEvent` / 重放 / `archive` / `truncate` / `ai-index.db` 派生索引 / `ai-panel.js:6258` 的 `tool_calls` 一一配对，此后每次动会话都得带着它。
- **多模型适配**：`ai-config-model.js` 下各家工具调用稳定性不同，弱模型出图率会掉。
- **可移植性**：图不再是纯文本，导出会话给外部工具看只剩占位。
- **第二套定义**：与 `skill_use` 并存，多一套工具描述、权限档矩阵与开关。

### 9.3 判断

`visual-spec.js` 规范层、kind 分类、图表引擎、卡片外壳、安全边界**两种触发形态完全共用**。首轮围栏驱动不欠技术债；出现以下任一信号再切工具驱动，届时规范层与引擎原样复用：

1. 卡片需要点击交互 / 单独重绘 / 折叠 / 被引用；
2. 长会话里图与 option 的 token 成本成为实际抱怨；
3. 图需要进会话大纲 / 搜索 / 操作留痕；
4. 要把「选中 CSV / JSON 数据直接出图」做成应用内动作（而非模型给数据）。
