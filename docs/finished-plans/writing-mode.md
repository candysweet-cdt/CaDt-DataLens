# 写作模式 v1 方案（已实施）

> 状态：**已实施（v1 全量 6 批）** · 拟定日期：2026-11-10 · 更名日期：2026-11-11 · 实施日期：2026-11-12
> 更名说明：原「小说模式」更名为「写作模式」，与新增的「阅读模式」（`docs/finished-plans/reading-mode.md`）区分。
> 范围：用户已确认 **全套 v1**（模式开关+中文排版、专注模式、码字统计、章节大纲、一键排版、起名器）。
> 适用文档类型：`text`（txt）与 `markdown`（md）。
> 版本号：`1.0.0`（未变更）。

---

## 1. 背景与目标

CaDt-DataLens 目前已有的写作红利：Markdown 分屏（源码+实时预览）、状态栏字数、F11 书签 + F2/Shift+F2 跳转、Git 行级改稿痕迹 + 历史版本、命令面板（Ctrl+Shift+P）、会话恢复。

「写作模式」要在这之上加一层**沉浸写作体验**：更舒服的中文排版、专注当前段落、码字激励（今日/本次/速度/目标）、txt 章节导航、中文排版整理、起名器。

设计原则：

- **总开关 + 子开关**：一个总开关控制模式外观，专注/统计行为各有子开关，默认值即"开箱即用的写作体验"。
- **零冲突**：不新增全局快捷键（F11/F2 已被书签占用，Ctrl+Shift+P 是面板）；所有入口走 菜单/设置/命令面板/右键。
- **复用现有管线**：设置五点接线、countWords、Ace marker/setScrollTop、结构面板解析器注册表、openDialogEl 对话框模式，全部沿用已验证的模式。

---

## 2. 现有基础设施盘点（已核实，实施时直接复用）

| 设施 | 位置 | 说明 |
|---|---|---|
| 设置五点接线 | `main.js` defaultSettings(~1215) → 归一化(~1266) → `elsSettings`(~1318) → 回填 → change 监听；`applySettings()`(1589) 持久化 | settingsKey=`datalens-settings`，新设置项照抄此模式 |
| `countWords` | `main.js:1984` | CJK 字符逐个计 + 拉丁词计 1；章节字数、码字统计同口径 |
| 状态栏 | `index.html:756` `st-count`；另有 `st-pos`/`st-md-width`/`st-update` | 新增 `st-writing` 相邻放置 |
| 字数管线 | `updateWordCount`(1994) / `scheduleWordCount`(2011)，Ace `changeSelection`+`input` 已挂（createDocEditor 5476-5477） | 码字统计挂同一防抖管线 |
| vendored Ace | `frontend/public/vendor/jsoneditor.min.js` | 已确认 `addMarker`×6、`fullLine`×4 存在；`session.setScrollTop` 为**像素**制、`documentToScreenRow` 可用（md 分屏滚动同步已验证） |
| 中文字体 | `cjkFonts` `main.js:1173` | 已含 楷体/宋体/仿宋/等线，写作字体选项直接引用 |
| 主题机制 | `applyTheme`(1418) → `documentElement.dataset.theme` | 写作模式用 `data-writing` 平行属性，不侵入主题 |
| 结构面板 | `structure.js`：`EXTENSIONS`(56)、`PARSERS`(1374)、节点 `{kind,label,detail,line,column,endLine,children}` | **txt 目前不支持结构视图**（EXTENSIONS 无 txt）→ 章节解析器是新增 |
| 菜单挂点 | 视图 `menuItems('view')`(11064)、格式 (11053)、工具 (11107，当前仅插件命令)、`paletteActions`(10965) | 开关/排版/起名器入口 |
| 对话框模式 | `openDialogEl`(1674)（settings/confirm/name/goto/props/update） | 新对话框需在 `openDialogEl`/`closeDialogs` 的隐藏列表注册 |
| 视图模式 | `switchMode`(9142)：tree/code/text/preview/render/table/image/binary/split | txt 默认 `code` 视图（formatSettings.text.view），Ace 覆盖主场景 |
| md 分屏滚动同步 | `hookSplitScrollSync` 等（~5074，已上线） | 打字机滚动只挂**光标事件**，同步只挂 **scroll 事件**，天然无冲突 |

---

## 3. 设置项（8 项，全部走既有五点接线）

| key | 默认 | 说明 |
|---|---|---|
| `writingMode` | `false` | 总开关；仅对当前 doc 为 text/markdown 且处于 code/text/split 视图时生效（不满足时 CSS/行为自动退避，设置保留） |
| `writingFont` | `'kaiti'` | 写作字体：kaiti/simsun/fangsong/follow（follow=跟随现有编辑器字体设置） |
| `writingFontSize` | `16` | 写作字号 12–22（独立于全局 `editorFont`） |
| `writingPaper` | `'off'` | 纸色滤镜：off / sepia（暖黄护眼）/ dim（调暗） |
| `writingLineNumbers` | `false` | 写作模式下显示行号（默认隐藏，书签/git 标记仍在 gutter） |
| `writingTypewriter` | `true` | 打字机滚动（光标行垂直居中） |
| `writingFocus` | `true` | 段落聚焦（非当前段落淡出） |
| `writingDailyGoal` | `0` | 每日目标字数，0=关闭 |

设置 UI：通用设置页新增「写作模式」小节（总开关 checkbox + 字体 select + 字号 range + 纸色 select + 行号/打字机/聚焦 checkbox + 目标 number）。设置搜索（`settings-search`）自动覆盖。

---

## 4. 详细设计

### ① 总开关 + 中文排版外观

**核心函数** `applyWritingMode()`（main.js，由 `applySettings` 尾部 + `updateStatus`/`onModeChange` 调用）：

1. 判定生效条件：`settings.writingMode && file && (file.format.id==='text' || 'markdown') && currentMode ∈ {code, text, split}`。
2. 生效 → `document.documentElement.dataset.writing = 'on'`（含 `data-writing-paper`）；否则 `off`。CSS 按属性开关，不影响其他文档。
3. 字体/字号：直接改写 `--editor-font-family` / `--editor-font` 两个内联 CSS 变量（`applySettings` 现在就是在这两个变量上写字体，写作模式开启时改写为 writingFont/writingFontSize，关闭时还原为常规值），然后对所有打开的 Ace：`ace.setFontSize(...)` + `ace.resize()`（**必须 resize 重排版，否则光标错位**）。
4. 行号：逐 doc `ace.setOption('showLineNumbers', settings.writingLineNumbers)`；关闭模式时恢复 `true`。gutter 装饰（书签紫标/git 蓝绿标）不受影响。
5. 纸色滤镜（编辑器窗格，不碰 md 预览）。实现落在 Ace 容器与文本视图 textarea 上（不是 `.jsoneditor-pane`：整窗格 filter 会生成 containing block，把浮层/弹窗定位带偏）：
   ```css
   html[data-writing="on"][data-writing-paper="sepia"] .jsoneditor .ace_editor,
   html[data-writing="on"][data-writing-paper="sepia"] textarea.jsoneditor-text { filter: sepia(0.22) saturate(0.92); }
   html[data-writing="on"][data-writing-paper="dim"] .jsoneditor .ace_editor,
   html[data-writing="on"][data-writing-paper="dim"] textarea.jsoneditor-text { filter: brightness(0.88); }
   ```
   用 CSS filter 而非改底色：**主题无关**（深浅主题都成立），不与 Ace 语法配色冲突。

**排版 CSS**（`style.css`）：`html[data-writing="on"]` 下 `.ace_editor` 行高 1.9、编辑区左右 padding 加宽（40px+），营造"稿纸"感。（字距 0.02em 未实现：等宽字体下会破坏 Ace 光标列宽计算，暂不加。）

**入口**：视图菜单「写作模式」（checked 项，放在"自动换行"附近）+ 设置页 + 命令面板（`视图： 写作模式`）。开启/关闭 flash 提示。

### ② 专注模式

**打字机滚动**（`writingTypewriter`）：

- 挂 Ace `changeSelection`（与 wordCount 同一挂点，`createDocEditor` 与既有的 hook 处并列），内部 `requestAnimationFrame` 延迟一帧（沿用分屏同步修延迟时的经验：事件先于渲染管线）。
- 计算：`screenRow = session.documentToScreenRow(cursorRow, 0)`；目标 `scrollTop = screenRow × lineHeight + lineHeight/2 − scroller.clientHeight/2`，与 `session.getScrollTop()`（像素）差值 >2px 才写 `session.setScrollTop`。
- `lineHeight` 取 `renderer.lineHeight`，取不到时回退 `getComputedStyle(.ace_line)` 实测。
- 不与 md 分屏滚动同步冲突：同步挂在 scroll 事件上，打字机只对光标变化响应；滚轮滚动不改光标，不会被拉回。
- 备注：Ctrl+G/jumpToPosition 这类程序化跳转（`scrollToLine`）后会再居中一次，体验可接受。

**段落聚焦**（`writingFocus`）：

- 光标变化（防抖 150ms）→ 计算当前段落范围：从光标行向上/向下扩展到最近的空行为止（`paraStart..paraEnd`）。
- 用**两个全行遮罩 marker**（`session.addMarker(range, 'writing-dim', 'fullLine', true)`，inFront=true）盖住段落以上（0..paraStart−1）和以下（paraEnd+1..末尾）区域；旧 marker 先 `removeMarker`。
- CSS：`.writing-dim { background: color-mix(in srgb, var(--bg) 72%, transparent); }`——用主题底色做半透明遮罩实现"文字淡出"，任何主题下都成立（WebView2 为现代 Chromium，支持 color-mix）。
- 存 `doc._writingMarkers`，模式关闭/文档切换时清理。

### ③ 码字统计

**状态栏 `st-writing`**（st-count 旁，仅 writingMode 生效时显示）：

- 格式：`今日 1234/2000 · 本次 +89`（无目标时省略 `/2000`；速度在对话框里看）。
- 更新：搭 `scheduleWordCount` 防抖管线（输入/选区变化已挂）。

**计数规则**：

- **今日**：localStorage `datalens-writing-daily` = `{date: 'YYYY-MM-DD', count, goalHit}`。每个 doc 维护 `doc._writingLast`（首次观察时记录当前全文 countWords），Ace input 防抖后 `delta = 当前 total − doc._writingLast`，`today.count += delta`（正负都累计=净增删，显示时 clamp ≥0），跨天自动重置。
- **本次**：writingMode 开启时（及开启状态下新开 doc）记录 `doc._writingBase`；本次 = Σ(当前 − base) 的净和，clamp ≥0。
- **速度**：正 delta 事件记 `{t, chars}` 数组；速度 = 最近 5 分钟净字数 ÷ 5。仅在对话框显示。
- **达标**：today.count 首次 ≥ writingDailyGoal → `flash('今日目标达成 🎉')`（goalHit 标记防重复）。

**统计对话框 `dlg-writing`**（复用 `openDialogEl` 模式，需在 `openDialogEl`/`closeDialogs` 隐藏列表注册）：

- 内容：今日新增（大字）/ 目标进度、本次新增、码字速度、全文；目标输入框 + 保存（写 `writingDailyGoal`）。
- 入口：点击 `st-writing`。

### ④ 章节大纲（structure.js）

**txt 目前不支持结构视图**（`EXTENSIONS` 无 txt 条目），新增解析器：

- `EXTENSIONS.txt = ['novel', '纯文本']`，`PARSERS.novel = parseNovelChapters`。
  > 注：`novel` 是章节解析器 ID，不是模式名；若阅读模式要复用，可改名为 `chapters` 并保持解析规则不变。
- 章节正则（行首，缩进 ≤8 空格容错）：
  ```
  ^\s{0,8}(第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章回节卷部篇话]|序章|楔子|引子|尾声|终章|番外[篇中之外]?|后记)\s*[:：、.．\s]*(.*)$
  ```
- 层级：`第X卷/部/篇` 作父节点，`章/回/节/话` 挂其下；无卷则平铺。未命中任何章节 → children 为空，显示"未找到章节标题"。
- **章节字数**：节点 `detail = 'N 字'`——用节点 line..endLine（下一章行−1）的原文切片，本地实现与 `countWords` 同口径的计数（structure.js 不能反向 import main.js，复制同款正则的小函数）。解析上限沿用现有 4MB/MAX_NODES 保护。
- 新 kind `chapter`：`KIND_GLYPH['chapter']='章'`、`KIND_NAME['chapter']='章节'`，样式复用 heading 色系（`.st-kind-chapter`）。
- md 文件的标题大纲已有；**md 的章节字数 v1 不做**（避免污染普通 md 文档的大纲），记为后续。

### ⑤ 一键排版

**新文件 `frontend/src/writing.js`** 承载纯函数（可独立 node 测试）：

```js
formatWritingText(text, {markdown, indent}) → {text, trailing, collapsed, indented}
```

规则（按序）：

1. `\r\n` → `\n` 统一处理（保存走现有 EOL 策略，还原 CRLF）。
2. 删行尾空白。**例外**：markdown 围栏代码块内保留代码原样；markdown 行尾 2 个以上空格是硬换行（`<br>`），保留。
3. ≥3 连续空行收敛为 1 个空行。按「连续空行数」计数，文首/文末与段间同口径；文末多余空行去掉，只保留结尾换行本身。
4. 行首空白清除——**md 保护**：`#{1,6} `、`>`、`-`/`*`/`+ `、`N. `、`|`、``` ``` ``/`~~~`、4 空格缩进代码块行不动行首；**列表续段保护**：列表标记行之后、缩进大于该标记缩进的行（含跨空行的续段/子块）保留行首，避免被顶格拆出列表。
5. `indent=true`（仅 txt）：空行后的首个非空行首加两个全角空格「　　」；已有 ASCII 缩进的行与已全角缩进的行不处理。md 语法行豁免只在 markdown 模式下生效（txt 里的 `1. `/`- ` 开头正文照常缩进）。

返回 stats 用于 flash：`已整理：去 N 处行尾空白、收敛 M 处空行、缩进 K 段`。

**入口**：格式菜单「小说排版」子菜单（整理段落 / 段首缩进两格〔仅 txt〕），disabled 条件 = 非 text/markdown、binary/large；实现走 `editor.getText()` → transform → `setText()` + `doc.text` 同步 + markDocDirty。命令面板同步注册。

> ⚠️ 实施时验证 jsoneditor `setText` 是否清空 undo 历史；若清空，flash 中附提示（可用 git 历史兜底，本项目已有 git 集成）。

### ⑥ 起名器 + 快速插入

**数据与生成**（writing.js 内联，无外部资源）：常用姓氏池 ~120（含复姓），名字字池按 男/女/中性 三组；`genName(gender)` 随机 姓 + 1~2 字。

**对话框 `dlg-writing-name`**（复用 dlg 模式）：名字大字展示 + 性别 select（男/女/随机）+ 按钮：换一个 / 复制 / 插入到光标 / 关闭。插入到光标 = code 视图下 `ace.insert(name)`（text 视图用 textarea setSelectionRange 方案，同 `jumpToPosition` 的双路处理）。

**场景分隔符**：插入 `\n\n* * *\n\n`（code 视图 ace.insert）。

**入口**：工具菜单（在插件命令**之前**加「起名器…」「插入： 场景分隔符」）+ 命令面板（`工具： 起名器` / `插入： 场景分隔符`）。

### 新文件与改动面

| 文件 | 改动 |
|---|---|
| `frontend/src/writing.js`（新） | 字体/纸色元数据、formatWritingText、起名池+genName、分隔符常量 |
| `frontend/src/main.js` | 设置 8 项五点接线、`applyWritingMode`、专注模式（marker+typewriter）、st-writing 与统计、dlg-writing / dlg-writing-name、视图/格式/工具菜单项、paletteActions 注册 |
| `frontend/src/structure.js` | EXTENSIONS.txt、parseNovelChapters、chapter kind 与字数 detail |
| `frontend/index.html` | 通用设置「写作模式」小节、st-writing span、dlg-writing、dlg-writing-name |
| `frontend/src/style.css` | data-writing 排版/纸色/遮罩/状态栏/对话框样式 |

不改 Go 侧。不改全局快捷键。

---

## 5. 实施顺序（每批独立构建部署 + 用户验证）

1. **骨架+外观**：writing.js 创建、8 项设置接线、applyWritingMode、CSS、视图菜单开关、st-writing 占位 → 验证：开关后字体/字号/行距/行号/纸色生效，关掉还原。
2. **专注模式**：打字机滚动 + 段落聚焦（含 md 分屏左栏）→ 验证：打字光标居中；非当前段淡出；滚轮/分屏同步不被打扰。
3. **码字统计**：今日/本次/目标/达标 flash + 统计对话框 → 验证：连续输入今日数增长；删字回退；跨天重置（改本地日期或手改 localStorage）。
4. **章节大纲**：structure.js txt 解析器 + 章节字数 → 验证：txt「第X章」出大纲树、点击跳行、detail 字数正确；无章节 txt 显示空态。
5. **一键排版**：writing.js transform + 格式菜单/面板 → 验证：md 列表/代码块不被破坏；txt 缩进两格；undo 行为按风险备注处理。
6. **起名器**：对话框 + 工具/面板入口 + 分隔符 → 收尾全量 `go test ./...`（Go 未动，应全绿）。

构建部署循环：`node --check` 改动的 js → `wails build` → 停 datalens.exe → 拷 `build/bin/CaDt-DataLens.exe datalens.exe` → 启动 → 用户逐项验证。

---

## 6. 验证清单（完整回归）

- [ ] 开关写作模式：楷体/字号 16/行距/行号隐藏/纸色滤镜生效；切到 JSON 文档自动退避（无样式残留）；关闭全部还原。
- [ ] 字体切换（宋体/仿宋/跟随）+ 字号拖动即时生效且光标不错位（resize 生效）。
- [ ] 打字机：连续输入光标行保持垂直居中；滚轮自由滚动不被拉回；md 分屏左右同步照常。
- [ ] 段落聚焦：空行分段正确；光标移动段落切换淡出区域跟随；大文件（≥1 万行）不卡顿。
- [ ] 状态栏：今日/本次实时增长；带目标显示 x/2000；达标 flash 一次；点击弹统计对话框；目标可改。
- [ ] 章节大纲：含「第一章 / 序章 / 番外」的 txt 出树 + 每章字数；卷→章层级；点击跳转；普通 txt 空态提示。
- [ ] 一键排版：行尾空白/多空行/缩进三规则；md 的列表、引用、代码块、表格不被破坏；flash 摘要数字正确。
- [ ] 起名器：换一个/复制/插入光标（code 与 text 视图两路）；性别池区分。
- [ ] 命令面板：写作模式/排版/起名器/分隔符均可搜到并执行。
- [ ] 回归：书签 F11/F2、git 行标、md 滚动同步、字数统计、会话恢复不受影响。

---

## 7. 风险与备注

1. **Ace 字体/行高变更必须 resize**：`--editor-font-family` 改变后调 `ace.resize()`（必要时 `renderer.updateFull()`），否则光标/选区错位。这是本方案最大的技术风险点，第 1 批优先验证。
2. **color-mix 兼容性**：依赖 WebView2（Chromium ≥111），Win10/11 自带版本均满足；若需兜底，可用 CSS 变量 + `rgba` 手动混色。
3. **filter 产生 containing block**：`.jsoneditor-pane` 上的 filter 会使内部 `position: fixed` 元素相对窗格定位——查找条（find bar）宿主在编辑区内部，属预期；实施时确认无弹层错位。
4. **打字机 vs 程序化跳转**：Ctrl+G/书签跳转后会被再次居中，属可接受行为；若体验差可加"跳转后 300ms 内不居中"抑制窗口。
5. **排版与 undo**：`setText` 可能重置撤销历史——实施第 5 批时实测，若丢失则在 flash 提示中说明（git 历史可兜底）。
6. **EOL**：排版按 `\n` 处理，保存沿用现有 eol 'follow' 策略还原 CRLF，不产生混合换行。
7. **状态栏空间**：st-writing 仅 writingMode 生效时显示，与其他元素（st-update/st-count）无常态争位。
8. **后续（v1 不做）**：md 章节字数、"的地得"/敏感词检查、打字音效、人物卡侧栏、锁机模式。
