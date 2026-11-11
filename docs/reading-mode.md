# 阅读模式 v1 方案（全量 17 项，计划，未实施）

> 状态：**方案定稿，待实施** · 日期：2026-11-11
> 命名：本方案 = **阅读模式**；原「小说模式」已更名为 **写作模式**（`docs/writing-mode.md`）。
> 范围：功能清单 1–12（v1）+ 13–17（后续，全部纳入本方案），共 17 项。
> 版本号：`1.0.0`（未变更）。
> 本轮只出文档，不改代码。

---

## 0. 一句话目标

把「一个目录下的 md / txt / docx / epub」变成一本可连续阅读的书：自动识别目录结构，给出卷-章-节目录，提供中文排版、进度记忆、书签、搜索、朗读和连续/分页阅读；**全程只读，不碰源文件**。

阅读模式**不是**把整个工作区递归拼成一本书。工作区是书架，书是用户选定的目录。这样 `正文` 与 `分卷` 不会互相污染，也不会把 `backup`、`node_modules`、`时空纪元\时空纪元`（一个含 3410 个 md 的备份仓）读进来。

### 功能索引

| 编号 | 功能 | 章节 |
|---|---|---|
| 1 | 入口与书架 | §3 |
| 2 | 扫描与结构识别 | §4 |
| 3 | 目录树 | §5 |
| 4 | 阅读视图与中文排版 | §6 |
| 5 | 导航 | §7 |
| 6 | 进度记忆 | §8.1–8.3 |
| 7 | 只读与回跳 | §9 |
| 8 | 分单元渲染与缓存 | §10.1 |
| 9 | md/txt 渲染 | §10.2–10.3 |
| 10 | 章内查找 | §11.1 |
| 11 | docx 读取 | §10.4 |
| 12 | 文档树模式 | §5.2、§7.2 |
| 13 | 全书搜索 | §11.2 |
| 14 | 书签与阅读统计 | §8.4–8.5 |
| 15 | 连续滚动与分页 | §12 |
| 16 | 朗读 | §13 |
| 17 | EPUB | §10.5 |

### 默认拍板项（可改）

| 决策 | 默认 | 理由 |
|---|---|---|
| 书根 | 用户选定的目录；工作区只做书架；不递归拼全书 | 备份仓/工程目录会污染；`正文`/`分卷` 是同一本书的两种排版 |
| 正文/分卷 | 两个独立阅读源，进度各自记 | 章节不是 1:1，自动合并需要额外映射 |
| 分卷切章 | 按 `## 第N章` 切；`第0卷` 作详情页 | 38 章的卷文件不整卷滚动；进度/字数按章 |
| 默认翻页 | 单章一屏；连续滚动/分页可开 | 大文件内存和进度简单；阅读习惯可调 |
| 资料类 | 文档树默认 | 时间线/百年史标题密度高，切章会碎 |
| Word | 仅 `.docx` 文本/标题/表格文本，图片占位 | 老 `.doc` 解析成本高；库里只有 3 个 docx |
| 状态 | `datalens-reading-state` localStorage | 零后端改动；不写源文件 |
| 字体 | 系统字体，不打包 | 中文字体几 MB 起，违背体积约束 |
| 不做 | 批注/云同步/PDF/全文索引 | v1 聚焦阅读闭环 |

---

## 1. 实测依据（来自当前真实目录）

| 目录 | 实测 | 说明 |
|---|---|---|
| `Novel\日记星辰\正文` | 93 个 md（目录内共 114 个文件） | 一个文件一章；含 `番外0001…`、`扩展章/沈世安列传/` 子目录、`assets/` 图片 |
| `Novel\日记星辰\分卷` | 6 个 md | `第1卷` 289 KB / 8022 行 / 38 章；`第2卷` 24 章；`扩展卷` 13 章；`第0卷 基本信息`；`第3卷` 仅 73 字节 |
| `Novel\时空纪元\世界观设定\时间线` | 14 个 md | 单文件最多 145 个标题（h1–h4）；`1. 基石时代.md` 234 KB |
| `Novel\时空纪元\世界观设定\时空纪元百年史` | 3 个 md | 人物卷 155 标题 / 230 KB；记录卷 220 标题 / **1.88 MB**；设定卷 **1002 标题** / 1.39 MB |
| `Novel\时空纪元\世界观设定` | 62 个 md + 图片/docx | 混合资料库，有嵌套目录 |
| `Novel\时空纪元\时空纪元` | 3410 个 md | 工程/备份仓，禁止全工作区递归扫描 |
| 全 `Novel` 树 | 3 个 `.docx` | 均位于资料/参考目录 |

这些数字直接决定了几条硬约束：目录默认折叠、按单元渲染、超大文件分块、全书搜索有预算、书架只认显式目录。

---

## 2. 术语与统一模型

### 2.1 层级

| 层级 | 含义 |
|---|---|
| **书（book）** | 用户选定的阅读根目录，或单个 `.epub` 文件 |
| **卷（volume）** | 子目录，或文件内 `第一卷 / 第1卷` 级标题 |
| **章（chapter）** | 文件，或文件内 `第N章 / 第N回 / 第N节` 级标题 |
| **节（section）** | 更低级标题（`##`/`###`/`####`） |
| **阅读单元（unit）** | 目录树中任意一个可渲染节点；对应「文件 + 起止行 / 起止块」或「EPUB spine + 标题区间」 |

核心抽象：**每个目录节点 = 一个可渲染区间**。章流模式把章节点当翻页单位；文档树模式按任意节点浏览。三类目录共用同一套扫描、目录、渲染、进度代码。

### 2.2 三种结构 profile

| profile | 判定 | 适用 |
|---|---|---|
| `file` 文件即章 | 多文件，每文件 0–1 个章标题且标题数少 | `正文` |
| `split` 文件内切章 | 至少一个文件含 ≥2 个章标题 | `分卷` |
| `tree` 多级文档 | 标题层级 ≥3，标题密度高，章关键词少 | `时间线`、`百年史`、`世界观设定` |

profile 是「默认展示形态」，不是硬限制：`tree` 也能切章流，`split` 也能展开成一棵树。识别置信度低或用户不满意时，在「结构设置」里手动切换并记住。

### 2.3 三类目录的落法

| 例子 | 识别 | 目录 | 默认形态 | 特例 |
|---|---|---|---|---|
| `正文` | `file` | 卷=子目录，章=93 个文件 | 章流 | `番外` 排正文后；`扩展章/` 作附录卷；`第0000章-引言` 作前言 |
| `分卷` | `split` | 卷=6 个文件，章=文件内 `##` 标题 | 章流 | `第0卷` 作书籍详情；`第3卷` 空卷显示标题+题记 |
| `时间线` | `tree` | 文件=篇，h1/h2/h3/h4=节点 | 文档树 | 单文件 81–145 个标题，默认只展开到第 2 层 |
| `世界观设定` | `tree`（混合） | 子目录=卷，文件=篇，标题=节 | 文档树（可切章流） | 同收 md/docx/epub；图片不单独进目录 |

---

## 3. 功能 1：入口与书架

### 3.1 入口

- 资源管理器：右键**目录** → 「作为书籍阅读」；右键 `.md/.txt/.docx/.epub` → 「阅读此文件」。
- 菜单：`视图 → 阅读模式`（有上次的书直接续读；没有则打开书架）。
- 欢迎页：新增「阅读书籍…」按钮。
- 命令面板：`阅读： 打开书籍…`、`阅读： 刷新目录`、`阅读： 全书搜索`、`阅读： 添加书签`、`阅读： 阅读统计`。
- 不新增全局快捷键；阅读态快捷键只在阅读视图获得焦点时生效。

### 3.2 书架

进入阅读模式且当前没有指定书时，显示书架：

```
阅读模式
┌ 最近阅读 ─────────────────────────────────────┐
│ [封面/首字] 日记星辰 · 正文   37% · 12 分钟前   │
│ [封面/首字] 时空纪元 · 时间线 12% · 昨天        │
└───────────────────────────────────────────────┘
┌ 当前工作区检测到 3 本书 ──────────────────────┐
│ 日记星辰  93 章 / 12.4 万字 / 未读             │
│ 时空纪元  62 篇 / 38.1 万字 / 12%              │
│ 黄粱一梦  …                                   │
└───────────────────────────────────────────────┘
[打开其他文件夹…]  [显示全部目录]
```

- 候选书根 = 工作区的一级子目录；若工作区本身就是章节目录，则工作区直接作为一本书。
- 评分：章文件名数量、章标题数量、是否含 `正文/分卷/设定/世界观` 子目录、支持格式文件数与总字数；`node_modules/.git/backup` 等降权。
- 默认只显示评分靠前的候选；「显示全部目录」展开完整列表；最近阅读永远显示。
- 书籍卡：书名（目录名或元数据）、作者（能解析时）、章数/篇数、总字数、进度、最近阅读时间。
- 书籍详情页：书名、作者、简介、总字数、预计阅读时长、进度、「继续阅读 / 从头开始」、结构设置、清空本书进度、在资源管理器中显示。

### 3.3 书籍元数据

按优先级解析：

1. `第0卷 基本信息.md` / `基本信息.md` / `简介.md` / `README.md` 里的 `**书名**：`、`**作者**：`、`**简介**：`。
2. Markdown YAML front matter 的 `title` / `author` / `description`。
3. `.docx` 的 `docProps/core.xml`（单个 docx 作为书时）。
4. `.epub` 的 OPF metadata。
5. 兜底：目录名。

`第0卷 基本信息` 默认作为**详情页**，不占正文进度；用户可在结构设置里把它改为普通一章。

---

## 4. 功能 2：扫描与结构识别

### 4.1 Go API

新增 `reading.go`（不引入新依赖）：

```go
type ReadingScanOptions struct {
    MaxDepth           int      `json:"maxDepth"`           // 默认 6
    MaxFiles           int      `json:"maxFiles"`           // 默认 2000
    MaxFileBytes       int64    `json:"maxFileBytes"`       // 默认 20 MB
    MaxHeadingsPerFile int      `json:"maxHeadingsPerFile"` // 默认 5000
    IgnoreDirs         []string `json:"ignoreDirs"`
}

type ReadingHeading struct {
    Offset int    `json:"offset"` // 文本：1-based 行号；docx/epub：块序号
    Level  int    `json:"level"`
    Title  string `json:"title"`
    Words  int    `json:"words"`  // 本标题到下一个同级/更高级标题之间的字数
}

type ReadingFile struct {
    Rel      string           `json:"rel"`      // 相对书根，统一 /
    Name     string           `json:"name"`
    Ext      string           `json:"ext"`
    Size     int64            `json:"size"`
    ModTime  int64            `json:"modTime"`
    Encoding string           `json:"encoding"`
    Words    int              `json:"words"`
    Headings []ReadingHeading `json:"headings"`
    Error    string           `json:"error,omitempty"`
}

type ReadingScan struct {
    Root       string        `json:"root"`
    Title      string        `json:"title"`
    Author     string        `json:"author"`
    Intro      string        `json:"intro"`
    Profile    string        `json:"profile"` // file | split | tree
    Confidence float64       `json:"confidence"`
    Files      []ReadingFile `json:"files"`
    Warnings   []string      `json:"warnings"`
    ScanMs     int64         `json:"scanMs"`
}

func (a *App) ScanReadingRoot(root string, opts ReadingScanOptions) (*ReadingScan, error)
```

- 支持的扩展名：`.md/.markdown/.mdx/.txt`（文本）、`.docx`、`.epub`。
- 不支持的 `.doc`：扫描时记录 warning「暂不支持 .doc，请另存为 .docx」。
- 文本编码复用现有解码（UTF-8 / GBK / GB18030）；UTF-16 仅在检测到 BOM 时用标准库解码，不做自动探测；读操作不改文件。
- 文件 > `MaxFileBytes`：跳过并列入 `Warnings`；单文件标题数 > `MaxHeadingsPerFile`：截断并 warning。
- 跳过隐藏目录/文件、符号链接；默认忽略 `.git/.svn/.hg/node_modules/dist/build/backup/备份/archive/__pycache__/.webnovel/.story-system/.claude/.zcode`。
- 扫描并发 4 个 worker，结果按相对路径稳定排序；每个文件错误只记录，不中断整本书。
- 扫描计时写入 `ScanMs`，开发模式打印到日志。

### 4.2 标题识别

**Markdown ATX**（跳过 fenced code 内的 `#`）：

```text
^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$
```

**卷/章关键词**（对 md 标题文本、txt 行、docx 段落文本都跑一遍；卷优先判定）：

```text
卷：^\s{0,8}(第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[卷部篇]
    |番外卷|扩展卷|设定卷|人物卷|记录卷)\s*[:：、.．\s]*(.*)$

章：^\s{0,8}(第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章回节话]
    |序章|楔子|引子|前言|引言|尾声|终章|后记|附录
    |番外(?:篇|中|之外)?(?:\s*[0-9零〇一二三四五六七八九十百千万两]+)?(?:\s|[-—·:：、.．]|$))(.*)$
```

- `第X卷/部/篇`、`番外卷/扩展卷` → 卷级；`第X章/回/节/话`、`番外1`、`番外-来路归途` → 章级。
- 卷关键词表可配置，默认含 `番外卷/扩展卷/设定卷/人物卷/记录卷`；新增卷名只需加一条配置，不改解析代码。
- 注意区分 `番外卷`（卷）与 `番外1`（章）；`番外卷 星落人间` 不能算成章，`## 番外1 自我独白` 才算章。
- `序/楔子/引子/前言/引言` → 前言组；`番外/后记/附录` → 附录组。
- 普通 `# 2027年`、`## I. 时空量子的发现` 不命中关键词，保留为 tree 节点。
- `### 1. 17岁的天才` 不命中（没有「第」），保留为普通节点。

**TXT**：逐行跑关键词正则；不做 Markdown 解析。

**DOCX**：按 `w:pStyle`（`Heading1..9` / `标题 1..9`）或 `w:outlineLvl` 识别；XML 按 Local 名匹配，忽略命名空间前缀；没有样式时用关键词正则兜底。

**EPUB**：按 spine 顺序，用轻量标签扫描 `<h1..h6>`（Go 标准库，不引入 HTML 解析库）；渲染时前端再用 DOMParser 精确处理。

**Setext 标题**（`===`/`---`）v1 不支持，按正文处理。

### 4.3 profile 判定

对每个文件统计：`chapterHits`（章正则命中数）、`headingCount`、`maxDepth`、`chapterNamed`（文件名匹配 `第N章/回/节/话` 或 `番外N`，不含普通 `N.` 前缀）。

```text
fileScore  = 0.5(文件数>=3 且 章标题中位数<=1 且 标题数中位数<=2)
           + 0.3(章文件名占比>=50%)
           + 0.2(没有多章文件)
splitScore = 0.6(存在多章文件 且 文件数<=20)
           + 0.2(多章文件占比>=50%)
           + 0.2(存在>=5 章的文件)
treeScore  = 0.4(最大标题深度>=3)
           + 0.3(平均每文件标题数>=8)
           + 0.2(章关键词密度<0.2)
           + 0.1(文件数<=20)
```

- 取最高分；分数 < 0.6 时弹「结构设置」让用户选，并显示每种 profile 的章节数预览。
- 同分或分差 <0.1 时优先 `tree`，其次 `split`，最后 `file`；`标题数中位数<=2` 用来防止「每文件很多标题的时间线」被误判成 `file`。
- **split 兜底**：某文件没有章关键词、但同一层有 ≥2 个标题时，把该层标题当章（例如 `番外卷` 用 `## 番外1` 作章）。
- 用户可覆盖：profile、章级（自动/h1/h2/h3）、忽略目录/文件、排序模式。覆盖存进阅读状态，下次直接使用。
- 重扫后若覆盖项失效（例如章级 h2 在新文件里不存在），回退自动判定并提示。

### 4.4 排序

排序键按优先级：

1. **分组**：详情页 `-1` → 前言 `0` → 正文 `1` → 番外 `2` → 扩展/附录/后记 `3`。
2. **数字**：`第X卷`、`第X章`、`X.`、`番外X`、文件名前导数字，统一解析（中文数字 `零〇一二三四五六七八九十百千万两` + 阿拉伯数字）。
3. **自然序**：数字段按数值、其余按本地化字符串；最后按相对路径。
4. **特例**：
   - `第0卷 基本信息` / `基本信息.md` → 详情页，不进正文流。
   - `第0000章-引言` → 前言组，排在 `第0001章` 前。
   - `番外0001`（没有 `第`/`N.` 前缀）→ 番外组，排在正文后。
   - `12. 番外-来路归途` 这种「数字前缀 + 番外」→ 按数字顺序走正文序列，不额外后置。
   - `扩展卷` / `番外卷` / `扩展章/` → 扩展/附录组。
   - `assets/` 等只有图片的目录 → 不生成卷，只给 md 图片当资源根。

排序实现为纯函数（Go 扫描侧排文件，前端 `reading-model.js` 排卷和标题），两边都有同一组测试样例。

### 4.5 刷新

- 进入书、切换书、点「刷新目录」时重扫。
- 窗口从隐藏变为可见且距上次扫描 > 60 秒时，后台重扫一次（不阻塞当前阅读）。
- 重扫时保留当前单元：按 `rel + 标题 + 序号` 重新定位；失败则按整体进度比例落到最近单元，并 flash「原位置已变化，已跳到最近章节」。
- 源文件内容变化（mtime 变）时，当前单元重新渲染；未变的单元走缓存。

---

## 5. 功能 3：目录树

### 5.1 数据结构

```js
{
  id: "rel#L123",          // 稳定 ID：文件 + 起始行/块
  kind: "volume" | "chapter" | "section" | "file",
  title: "第12章 初遇微光",
  rel: "第0012章-初遇微光.md",
  offset: 1,                // 起始行/块
  endOffset: 1,             // 结束（不含）
  level: 2,
  words: 3210,
  minutes: 8,
  children: [],
  renderable: true
}
```

- 卷节点可以同时可渲染（卷首语/卷简介）；`renderable=false` 的卷只作分组。
- **篇标题合并**：tree 模式的篇节点用文件名；若首个一级标题去掉编号/卷前缀后与文件名归一化相同（如 `1. 基石时代.md` 的 `# 第一卷 基石时代`、`扩展卷 星火长明.md` 的 `# 扩展卷 星火长明`），合并为篇标题，不在子节点里重复显示；`人物卷.md` 的 `# 一、主线人物` 不同，保留为子节点。
- `words` 由 Go 扫描给出；`minutes = ceil(words / 400)`。字数口径与现有 `countWords` 一致：CJK（中文/日文假名/韩文）逐字计 1，拉丁字母/数字串计 1 个词。
- `chapter` 节点的 `endOffset` = 下一个同级或更高级标题的起始；`section` 同理。

### 5.2 交互

- 左侧栏三个页签：**目录 / 书签 / 搜索**。
- 目录默认折叠到「卷 + 章」两层（`readingTocDepth=2`）；tree profile 默认「篇 + h1 + h2」。
- 当前节点高亮，自动滚动到可视区；父级自动展开。
- 目录顶部有过滤框：子串匹配，显示匹配节点及其祖先；最多 200 条，回车跳第一条。
- 单层超过 500 项时先渲染 300 项 + 「显示更多」，避免 1002 个标题一次性进 DOM。
- 节点右侧显示字数；hover 显示「约 N 分钟」。
- 点击节点：
  - 若节点在当前已渲染区间内 → 直接滚到锚点；
  - 否则重新渲染该节点区间并滚到顶部；
  - tree 模式下点击子节点会渲染更窄的区间，父节点目录保持展开。
- 目录宽度固定 280 px，可折叠（`[` 或按钮）；不做拖拽改宽 v1（避免与资源管理器宽度状态打架）。

### 5.3 1002 个标题的性能策略

- 树数据一次建好（纯 JS，1002 个节点 < 10 ms）。
- 只渲染展开分支；默认深度 2，`设定卷` 首屏通常 < 100 行。
- 过滤时只渲染匹配路径，最多 200 条。
- 不用 `innerHTML` 整段重建；用 DocumentFragment + 行节点复用。
- 当前节点用 `scrollIntoView({block:'nearest'})`，不用平滑滚动，避免长目录抖动。

---

## 6. 功能 4：阅读视图与中文排版

### 6.1 布局

阅读视图放在 `#editor-wrap` 内，作为 `#editor-area` 的同级；进入时隐藏编辑器/欢迎页，退出恢复。资源管理器默认收起（记住进入前状态），AI 面板保留（专注模式再隐藏）。阅读模式**不新增标签页**，不进入会话的打开文件列表；退出后原标签页原样恢复。

```text
┌─────────────────────────────────────────────────────────────┐
│ ← 书名 / 当前章      [目录][书签][搜索][Aa][专注][…]      │
├──────────────┬──────────────────────────────────────────────┤
│ 目录/书签/搜索│  正文（最大 42em，居中）                     │
│ 卷           │  …                                           │
│  章          │  [本章完 · 下一章]                            │
│   节         │                                              │
├──────────────┴──────────────────────────────────────────────┤
│ 进度条  ████████░░░░  12/93 · 37%                           │
└─────────────────────────────────────────────────────────────┘
```

- 顶栏在滚动时保持 sticky；专注模式隐藏顶栏/侧栏/底栏，鼠标移到顶部 24 px 时临时显示。
- 底栏进度条可点击打开目录；右侧显示「第 x / y 章 · 百分比」。
- 本章末尾有「本章完 · 下一章」；文档树模式显示「本节完 · 下一节」。
- 大屏正文最大宽度 42em；窄窗口自动收窄；左右留白不小于 24 px。

### 6.2 排版设置

| 项 | 默认 | 范围/选项 |
|---|---|---|
| 字体 | 宋体 | 宋体 / 楷体 / 微软雅黑 / 等线 / 跟随系统 |
| 字号 | 19 px | 16–28 |
| 行高 | 1.9 | 1.6–2.2 |
| 页宽 | 42em | 32–56 |
| 段落间距 | 0.6em | 0–1.2 |
| 段首缩进 | 关 | 开：正文段落 `text-indent: 2em` |
| 对齐 | 两端对齐 | `text-align: justify`，中文用 `text-justify: inter-ideograph` |
| 字距 | 0.02em | 固定 |

- 字体只用系统字体，不打包：`SimSun`、`KaiTi`、`Microsoft YaHei`、`DengXian`，每项带 `Noto Serif CJK SC` / `Songti SC` 等回退。
- 标题、图片、表格、引用、代码块、分隔线、脚注各有一套阅读样式；图片最大宽度 100%，点击用现有图片查看器打开。
- 表格外层加横向滚动容器，正文不产生横向滚动条。
- 正文 `::selection` 用主题色；阅读区允许选中复制。

### 6.3 主题

- `paper` 纸白：`#faf7ef / #2b2a27`
- `sepia` 护眼：`#f3ead6 / #5a4632`
- `light` 纯白：`#ffffff / #1f2328`
- `dark` 夜间：`#1e1f22 / #c9cdd4`
- `auto` 跟随应用主题（默认）。

主题只作用于 `#reading-view` 的 CSS 变量，不修改全局主题、不影响编辑器/预览。

### 6.4 专注/全屏

- 专注：隐藏资源管理器、AI 面板、阅读顶栏/侧栏/底栏，正文居中；`Esc` 先退出专注。
- 全屏：阅读视图本身已占满内容区，v1 不调用系统全屏 API；需要更大空间用专注模式。
- 进入/退出时保存并恢复资源管理器与 AI 面板的开关状态。

### 6.5 设置接线

阅读外观设置并入现有 `datalens-settings`，沿用五点接线（默认值 → 归一化 → `elsSettings` 回填 → change 监听 → `applySettings` 持久化）。阅读进度/书签/统计单独存 `datalens-reading-state`，不混进设置。

---

## 7. 功能 5：导航

### 7.1 章流模式

- 上一章 / 下一章按目录顺序；卷边界插入卷分隔（卷名 + 题记）。
- 章末「下一章」按钮；最后章显示「全书完」。
- 切换章节后滚到顶部（同一会话内回访保留该章滚动位置）。
- 进度条显示全书百分比；点击打开目录。

### 7.2 文档树模式

- 点击任意节点渲染该节点区间；区间包含其子标题。
- 「上一节 / 下一节」按目录先序（父 → 子 → 下一个兄弟）。
- 滚动时用 IntersectionObserver 高亮当前标题；目录同步滚动到当前节点。
- 若目标节点已在当前渲染区间内，只滚动不重渲染。
- 从章流切到文档树时，当前章作为树中第一个匹配节点。

### 7.3 快捷键（仅阅读视图聚焦时）

| 键 | 行为 |
|---|---|
| `Esc` | 关查找 → 退出专注 → 退出阅读 |
| `←` / `→` | 上一章/下一章；分页模式下上一页/下一页 |
| `PageUp` / `PageDown` | 滚动一屏 / 翻页 |
| `Space` / `Shift+Space` | 下/上一屏 |
| `Home` / `End` | 本章开头/结尾 |
| `Ctrl+F` | 章内查找 |
| `Ctrl+D` | 添加书签 |
| `Ctrl+Shift+F` | 全书搜索 |
| `[` / `]` | 收起/展开目录（非输入态） |

不新增全局快捷键；`F11` 仍归编辑器书签，阅读模式不占用。

**与现有全局快捷键的冲突**：`Ctrl+F` 已被 `main.js` 的全局 keydown 处理（约 `main.js:15117`）占用。阅读视图必须在 capture 阶段拦截 `Ctrl+F` 并 `stopPropagation`，或在全局 handler 首行判断 `readingActive` 后转发给阅读查找。`Ctrl+D`、`Ctrl+Shift+F` 当前未绑定。阅读视图只拦截上表按键，`Ctrl+O/Ctrl+W/Ctrl+N/Ctrl+,` 等应用级快捷键继续生效；`Esc` 若遇对话框打开，先交给对话框。

---

## 8. 功能 6 / 14：进度、书签与统计

### 8.1 存储

`localStorage` key：`datalens-reading-state`，版本化：

```json
{
  "version": 1,
  "books": {
    "d:/oraskyc/novel/日记星辰/正文": {
      "root": "D:\\OraSkyC\\Novel\\日记星辰\\正文",
      "title": "日记星辰 · 正文",
      "profile": "file",
      "chapterLevel": null,
      "lastUnitId": "第0012章-初遇微光.md#L1",
      "lastUnitTitle": "第12章 初遇微光",
      "lastUnitOrdinal": 12,
      "lastRel": "第0012章-初遇微光.md",
      "scrollRatio": 0.42,
      "progress": 0.37,
      "updatedAt": 1760000000000,
      "bookmarks": [],
      "stats": {
        "totalSec": 1234,
        "sessions": 5,
        "daily": {"2026-11-11": 600},
        "streak": 3,
        "lastReadDate": "2026-11-11"
      }
    }
  },
  "recent": ["d:/oraskyc/novel/日记星辰/正文"]
}
```

- key 归一化：小写盘符、`/` 分隔、去尾部 `/`；显示用原始路径。
- `daily` 保留最近 365 天，超过裁剪。
- 书签项：`{id, unitId, rel, title, ratio, excerpt, createdAt}`，`unitId` 与上文单元 ID 同规则。
- 写入防抖 500 ms；退出阅读、窗口隐藏、切换书时强制落盘。
- 书籍根路径变化（移动目录）时，最近列表按书名+作者提示重新定位，不自动猜路径。

### 8.2 单元 ID 与失效恢复

- 主 ID：`rel#L<offset>`（文本行）或 `rel#B<offset>`（docx/epub 块）。
- 同时存 `title` 和 `ordinal`。恢复顺序：
  1. ID 精确命中；
  2. 同 `rel` + 同标题 + 最近序号；
  3. 全书同标题 + 最近序号；
  4. 按 `progress` 比例落到最近单元；
  5. 第一章。
- 源文件大改后允许落点不完美，flash 说明，不阻塞阅读。

### 8.3 进度算法

- 全书进度按**字数加权**，不按章数：`已读单元字数之和 + 当前单元字数 × 单元内比例` ÷ `全书字数`。
- 单元内比例：章流/单页 = `scrollTop / max(1, scrollHeight - clientHeight)`；分页 = 当前页/总页数；连续 = 当前章 + 章内比例。
- 文档树的进度单元取「篇/一级标题」层，避免父节点和子节点重复计字数。
- 书籍卡进度、底栏百分比、状态栏（如显示）用同一算法。

### 8.4 书签

- 添加：当前单元 + `scrollRatio` + 最近可见段落前 30 字作为摘录。
- 列表：按位置排序（可切按时间）；显示标题、摘录、时间；点击跳转；可删除。
- 书签只存位置和摘录，不改源文件；v1 不做划线/批注。
- `Ctrl+D` 添加；顶栏按钮同效；重复位置（同单元且比例差 < 0.02）提示「已存在书签」。

### 8.5 阅读统计

- 计时：阅读视图可见 + 窗口可见 + 最近 60 秒内有滚动/点击/按键；空闲 60 秒暂停，交互恢复。
- 每本书累计 `totalSec`、`sessions`、`daily`；跨天按本地日期切分。
- 连续天数：今天有阅读且昨天也有 → `streak+1`；中断 → 1。
- 统计弹窗：总时长、今日、连续天数、已读书籍数（进度 ≥99%）、最近 7 天柱状图（纯 CSS）。
- 多窗口同时读同一本会重复计时，v1 接受；不为此加锁。

---

## 9. 功能 7：只读与回跳

- 阅读模块只调用读接口：`ScanReadingRoot`、`OpenFile`（读）、`ParseReadingDocx`、`PrepareReadingEpub`、`ReadReadingEpubChapter`、`SearchReadingBook`、`RegisterPreviewRoot`。
- **禁止**调用 `SaveFile`、`WriteFile`、`Delete`、`Rename`、`MarkDirty`；不打开编辑器标签，不进入会话文件列表。
- 静态断言：`frontend/src/reading/*.js` 中不得出现写接口名；Go 侧 `reading_*.go` 除 EPUB 缓存目录外不得出现 `os.WriteFile/os.Remove/os.Rename`。EPUB 缓存写入单独放行并限定在 `appdata/reading-cache/`。
- 「在编辑器中打开」：退出阅读 → 现有 `openPath(file)` → 跳到当前行（md/txt）；docx/epub 禁用该按钮并提示。
- 阅读区右键：复制、全选、在编辑器中打开（可编辑格式）、添加书签。
- 验收时对比源文件 mtime 与 `git status`，阅读前后必须不变。

---

## 10. 功能 8 / 9 / 11 / 17：渲染管线

### 10.1 单元切分与缓存

- md/txt：按行区间切片；切片包含单元标题行，包含其子标题，止于下一个同级/更高级标题。
- docx：按块区间切片；规则同上。
- epub：spine 项为一章；子标题在渲染后的 DOM 内定位。
- 单元 > 200 KB 时：优先按下一级标题拆成多个子单元；没有子标题则按段落每 ~1500 行分块，并提示「本章较长，已分块」。
- 单元 HTML 缓存：`Map<unitId, {html, headings, bytes}>`，LRU 8 MB 或 12 个单元；文件文本缓存 20 MB（最多 3 个文件）。
- 预取：当前单元渲染完成后，空闲时预取下一章 HTML（不插入 DOM）。
- 源文件 mtime 变化时清掉该文件相关缓存。

### 10.2 Markdown

- 把 `main.js` 里的 markdown 渲染配置抽到 `frontend/src/markdown.js`：`markdownRenderer`、`renderMarkdownHtml`、代码块渲染、图片/链接规则、DOMPurify 配置。`main.js` 改为引用，行为不变；这是纯搬移，需回归 md 预览/分屏/AI 面板/更新日志。
- 阅读模式复用同一实例与 sanitize 规则，避免两套安全配置漂移。
- 标题锚点：渲染后遍历 `h1–h6`，按顺序写 `id="rh-<index>"` 和 `data-rh="<index>"`；index 对应该单元内标题序号。TOC 点击按 `data-rh` 定位。
- 图片：渲染后遍历 `img`，把相对路径按「当前文件目录」解析到书根内，重写为 `/__local/<token>/<rel>`；书根外图片显示 alt 占位。token 由 `RegisterPreviewRoot(bookRoot)` 获取，一本书一个。
- 外链沿用现有规则外部打开；危险协议仍由 DOMPurify 拦截。
- 软换行：新增纯函数 `joinSoftLines(md)`（可关闭）。规则：
  - 跳过 fenced code、缩进代码、表格行、HTML 块、标题、列表/引用起始行；
  - 普通段落内相邻两行合并；
  - 若前一行末字符与后一行首字符都是 CJK/全角标点 → 直接拼接，否则补一个空格；
  - 行尾两个空格或反斜杠视为硬换行，不合并。
  - 目的：适配「一句一行 + 空行分段」的中文稿，避免渲染后句中冒出空格；保留单换行可作为设置项。
- YAML front matter：开头 `---` 且含 `key:` 时解析并隐藏，不进正文。

### 10.3 TXT

- 按空行分段；默认同样走 `joinSoftLines`（可关）。
- 段落内单换行若用户选择「保留」，渲染为 `<br>`。
- 章节标题行渲染为 `<h2>`，并进入锚点表。
- 不做 Markdown 解释，直接转义。

### 10.4 DOCX（功能 11）

- `reading_docx.go`：`archive/zip` + `encoding/xml` 解 `word/document.xml`，零新依赖。
- 输出块：`p`、`h1–h6`、`table`、`image`（占位）。
- 识别：`w:pStyle` 的 `Heading1..9` / `标题 1..9` / `w:outlineLvl`；缺样式用章关键词正则兜底。
- 文本：`w:t`、`w:tab`、`w:br`；超链接文本保留；表格按行/单元格转文本矩阵。
- 图片：`w:drawing` → 占位「〔图片〕」；v1 不抽取 docx 图片。
- `.doc`：检测 OLE 头 `D0 CF 11 E0 A1 B1 1A E1`，返回明确错误「暂不支持 .doc，请另存为 .docx」。
- 元数据：可选读 `docProps/core.xml` 的 title/creator。
- 测试：测试里用 `zip.Writer` 现场生成最小 docx（标题/段落/表格/图片占位），不提交二进制夹具；另测坏 zip、缺 document.xml、旧 .doc。

### 10.5 EPUB（功能 17）

- `reading_epub.go`：读 `META-INF/container.xml` → OPF → metadata/manifest/spine；`toc.ncx`/`nav.xhtml` 有则用于嵌套目录，没有则用 spine + XHTML 标题。
- 解压到 `appdata/reading-cache/epub-<sha1(path+mtime)>/`：
  - 拒绝绝对路径、`..`、反斜杠逃逸；
  - 单文件 ≤50 MB，总解压 ≤200 MB，条目 ≤5000；
  - 只解压 manifest 内资源；不执行任何脚本；
  - 缓存 LRU 20 本 / 500 MB，启动时清理超限目录。
- 注册缓存目录为 preview root，返回 token；图片通过 `/__local/<token>/<相对路径>` 访问。
- 渲染：读取 spine XHTML → DOMParser 取 body → 移除 `script/style/iframe/object/embed/link`、事件属性、`javascript:` 链接 → DOMPurify sanitize → 套阅读排版。EPUB 自带 CSS/字体丢弃，保持阅读模式统一。
- 内部链接 `#id` 在本章滚动；跨 spine 链接跳到对应章；外部链接外部打开。
- DRM：存在 `META-INF/encryption.xml` 时提示「受 DRM 保护的 EPUB 不支持」。
- 阅读单元：spine 项 = 章；标题 = 节。单文件 `.epub` 也可直接作为一本书打开。
- 测试：现场生成最小 EPUB（2 章 + 1 图片）、zip-slip 恶意条目、DRM 标记、缺 OPF。

---

## 11. 功能 10 / 13：查找与搜索

### 11.1 章内查找

- `Ctrl+F` 打开阅读专用查找条，不调用编辑器查找。
- 用 CSS Custom Highlight API（`CSS.highlights` + `Range`），不改 DOM；WebView2 不支持时回退 `<mark>`。
- 当前命中用另一颜色；显示 `3/17`；`Enter`/`Shift+Enter` 下一个/上一个；`Esc` 关闭并清除高亮。
- 查找范围 = 当前渲染单元（含子标题），忽略代码块？v1 不忽略，全部文本可查。
- 中文直接匹配；英文大小写不敏感。

### 11.2 全书搜索

Go 新增：

```go
type ReadingSearchOptions struct {
    MaxFiles     int  `json:"maxFiles"`     // 默认 2000
    MaxFileBytes int64 `json:"maxFileBytes"` // 默认 20 MB
    MaxResults   int  `json:"maxResults"`   // 默认 200
    TimeoutMS    int  `json:"timeoutMs"`    // 默认 15000
    ContextRunes int  `json:"contextRunes"` // 默认 30
}

type ReadingSearchHit struct {
    Rel        string `json:"rel"`
    Offset     int    `json:"offset"`     // 行/块
    Before     string `json:"before"`
    Match      string `json:"match"`
    After      string `json:"after"`
    UnitOffset int    `json:"unitOffset"` // 最近的标题起始
}

type ReadingSearchResult struct {
    Hits         []ReadingSearchHit `json:"hits"`
    FilesScanned int                `json:"filesScanned"`
    FilesTotal   int                `json:"filesTotal"`
    Truncated    bool               `json:"truncated"`
    ElapsedMS    int64              `json:"elapsedMs"`
}

func (a *App) SearchReadingBook(requestID, root, query string, opts ReadingSearchOptions) (*ReadingSearchResult, error)
func (a *App) CancelReadingSearch(requestID string)
```

- 文本用编码检测后按 rune 搜索；docx/epub 搜抽取后的文本；跳过超大/不支持文件并计数。
- 结果按「文件/单元」分组，显示上下文与命中数；点击跳转到单元并用章内查找定位第 N 个命中。
- 搜索期间侧栏显示「已扫描 x/y」，可取消；超时/截断明确提示。
- 不建全文索引、不进 SQLite；每次按预算即时扫。

---

## 12. 功能 15：连续滚动与分页

### 12.1 连续滚动

- 设置项 `readingContinuous` 默认关。
- 开启后当前单元渲染完，底部 sentinel 进入视口 800 px 时追加下一章；每章一个 `<section data-unit-id>`。
- 上限：30 个单元或 8 MB HTML；达到上限停止追加，显示「加载更多」按钮（保留已加载 DOM，不回收，避免滚动跳动）。
- 章间插入分隔（卷名/章名）。
- 当前章由 IntersectionObserver + 滚动位置判定；进度 = 当前章前字数 + 章内比例。
- 保存进度 = 当前章 + 章内比例；恢复时从 `activeIndex-1` 开始加载并滚到目标。
- 文档树模式默认不启用连续；超大单元不启用。

### 12.2 分页模式

- 设置项 `readingPaged` 默认关；只对章流单章生效，和连续滚动互斥。
- CSS 多栏：`column-width: <页宽>; column-gap: 64px; column-fill: auto; height: <视口高度>; overflow: hidden`；外层用 `translateX(-page * (width+gap))` 翻页。
- 页码 = `ceil(scrollWidth / (clientWidth + gap))`；窗口 resize 重新分页并按比例保留位置。
- `PageUp/PageDown`/`←`/`→` 翻页；左右 25% 点击区上一页/下一页；中间点击切换顶栏/底栏。
- 图片/表格加 `break-inside: avoid`；超长表格允许横向滚动。
- 限制：分页模式下禁用连续滚动、禁用跨章预取；查找命中跨页时先翻到对应页。
- 风险：CSS multicol 在 WebView2 的 `scrollWidth` 测量需实测；若不可靠，回退为「固定高度 + 按元素偏移二分计算页边界」的 JS 分页（实现量更大，批 5 先做 CSS 版原型）。

---

## 13. 功能 16：朗读

- 优先 Web Speech API（WebView2 `speechSynthesis`），零依赖、离线可用性取决于系统语音包。
- 进入阅读时探针：`getVoices()` 过滤 `zh`，等 `voiceschanged` 最多 1.5 秒；无中文语音则禁用朗读按钮，提示「请在 Windows 设置安装中文语音包」。
- 分段：按 `。！？!?…\n` 切句，单段 ≤180 字；队列播放，`onend` 下一段。
- 控制：播放/暂停/继续/停止；语速 0.5–2.0、音调、音量；持久化到设置。
- 高亮：用句子对应的 `Range` + CSS Highlight 标当前句；`onboundary` 可用时按字推进，不可用时整句高亮。
- 跟随：默认开启「朗读时滚动到当前句」，`scrollIntoView({block:'center', behavior:'smooth'})`，用户手动滚动后暂停跟随 3 秒。
- 自动续章：默认开；本章读完自动进入下一章并继续；最后一章停止并提示。
- 窗口隐藏时暂停；退出阅读/切换单元时停止。
- v1 不引入 PowerShell/SAPI 兜底；环境无语音包即明确提示，避免额外进程与延迟。

---

## 14. 设置项、菜单与入口

### 14.1 设置项（并入 `datalens-settings`，五点接线）

| key | 默认 | 说明 |
|---|---|---|
| `readingFont` | `songti` | songti/kaiti/yahei/dengxian/system |
| `readingFontSize` | `19` | 16–28 |
| `readingLineHeight` | `1.9` | 1.6–2.2 |
| `readingPageWidth` | `42` | 32–56 em |
| `readingParagraphGap` | `0.6` | 0–1.2 em |
| `readingIndent` | `false` | 段首缩进两格 |
| `readingTheme` | `auto` | auto/paper/sepia/light/dark |
| `readingJoinSoftLines` | `true` | 合并段内单换行（中文稿推荐） |
| `readingContinuous` | `false` | 连续滚动跨章 |
| `readingPaged` | `false` | 分页模式 |
| `readingTocDepth` | `2` | 目录默认展开层级 |
| `readingKeepExplorer` | `false` | 进入阅读时保留资源管理器 |
| `readingRestoreSession` | `true` | 下次启动恢复上次阅读位置 |
| `readingStats` | `true` | 阅读统计 |
| `readingTtsRate` | `1` | 朗读语速 |
| `readingTtsAutoNext` | `true` | 朗读自动续章 |

设置页新增「阅读模式」分区：外观、行为、统计/朗读三组；支持现有设置搜索。

### 14.2 菜单/面板

- `视图 → 阅读模式`（toggle；无书时打开书架）。
- `文件 → 打开书籍…`。
- 资源管理器右键：目录「作为书籍阅读」；文本文件「阅读此文件」。
- 欢迎页「阅读书籍…」按钮。
- 命令面板注册：打开书籍、刷新目录、全书搜索、添加书签、阅读统计、切换连续/分页。
- 写作模式与阅读模式各自独立的菜单文案/设置分区，不共用开关。

---

## 15. 前端与 Go 改动面

### 15.1 前端

| 文件 | 内容 |
|---|---|
| `frontend/src/reading/reading.js` | 入口/关闭、当前书、事件、与 main.js 的接口 |
| `frontend/src/reading/reading-model.js` | 纯函数：TOC 构建、排序、单元 ID、进度、`joinSoftLines`、profile 兜底 |
| `frontend/src/reading/reading-view.js` | 书架、详情页、阅读视图、目录/书签/搜索侧栏 |
| `frontend/src/reading/reading-render.js` | md/txt/docx/epub 渲染、锚点、图片重写、LRU 缓存 |
| `frontend/src/reading/reading-search.js` | 章内查找、全书搜索 UI |
| `frontend/src/reading/reading-tts.js` | 朗读队列/高亮 |
| `frontend/src/reading/reading-state.js` | localStorage 读写/迁移/书签/统计 |
| `frontend/src/reading.css` | 阅读视图、主题、排版、分页、目录样式 |
| `frontend/src/markdown.js` | 从 main.js 抽出的共享 markdown 渲染/sanitize |
| `frontend/src/main.js` | 菜单/面板/设置接线、打开阅读入口、资源管理器右键 |
| `frontend/index.html` | `#reading-view` 骨架、设置分区、欢迎页按钮 |
| `frontend/package.json` | 增加 `reading-model.test.mjs` / `reading-state.test.mjs` 到 test script |

阅读视图是 `#editor-wrap` 内的独立 section，不是标签页；不改 `wailsjs/`。

### 15.2 Go

| 文件 | 内容 |
|---|---|
| `reading.go` | 扫描、标题识别、profile、排序、字数、读书元数据 |
| `reading_docx.go` | docx 解析 |
| `reading_epub.go` | epub 解析/解压/缓存 |
| `reading_search.go` | 全书搜索、取消 |
| `reading_*_test.go` | 对应测试 |

不改现有 API；新增方法后由 `wails dev/build` 重新生成绑定。Go 侧只读源文件；EPUB 缓存写入限制在 `appdata/reading-cache/`。

---

## 16. 性能预算与硬上限

| 操作 | 预算 |
|---|---|
| 扫描 100 个文件 | < 300 ms |
| 扫描 2000 个文件 | < 3 s |
| 打开一本书（扫描+首屏目录） | < 1 s（≤200 文件） |
| 目录首屏渲染（≤500 可见节点） | < 100 ms |
| 单元渲染 10 KB | < 30 ms |
| 单元渲染 200 KB | < 200 ms |
| 章内查找 | < 50 ms |
| 全书搜索 3 MB | < 1 s |
| 全书搜索 200 MB | < 15 s（硬超时） |
| 内存增量 | 常规 < 150 MB；HTML 缓存 8 MB；文本缓存 20 MB |
| 退出阅读 | < 100 ms |

硬上限：深度 6、文件 2000、单文件 20 MB、单文件标题 5000、单单元 200 KB（超出拆分）、连续加载 30 单元 / 8 MB HTML、搜索 200 条 / 15 s、EPUB 5000 条目 / 200 MB 解压、TTS 单段 180 字。

---

## 17. 测试与验收

### 17.1 Go 单元测试

- `reading_scan_test.go`：用 `t.TempDir()` 现场写三类目录夹具（文件即章 / 文件内切章 / 多级文档），断言 profile、章数、卷数、排序、字数、mtime 不变。
- `reading_sort_test.go`：中文数字（一/十/十一/二十一/一百零三/两/〇）、`番外`/`扩展`/`第0卷` 分组。
- `reading_docx_test.go`：现场构造 docx；标题样式、正则兜底、表格、图片占位、坏 zip、旧 `.doc`。
- `reading_epub_test.go`：现场构造 epub；spine 顺序、标题、图片、zip-slip、DRM。
- `reading_search_test.go`：命中、上下文、大小写、条数上限、超时/取消。
- `reading_words_test.go`：与 JS `countWords` 同口径的表驱动样例。
- 只读断言：扫描/读取前后文件 hash + mtime 不变；前端 `reading/*.js` 不出现写接口；Go 侧除 `reading_epub.go` 的 `reading-cache` 写入外不出现写接口。

### 17.2 前端 Node 测试

- `reading-model.test.mjs`：TOC 构建、排序、ID 生成/失效回退、进度、`joinSoftLines`（中文一句一行/英文折行/列表/代码块/表格/硬换行）、profile 兜底。
- `reading-state.test.mjs`：schema 迁移、书签去重、每日统计裁剪、路径归一化。
- `npm test` 显式加入这两个文件（沿用现有 `node --test`）。

### 17.3 真实验收

- `正文`：93 章；顺序为前言 → 正文 → 番外 → 扩展；目录/进度/下一章正确；`assets` 图片显示。
- `分卷`：6 卷；第 1 卷 38 章、第 2 卷 24 章、扩展卷 13 章正确切分；`第0卷` 进详情页；`第3卷` 空卷不报错。
- `时间线`：14 篇；单文件 145 标题；文档树滚动高亮；h4 可展开。
- `百年史`：设定卷 1002 标题；首屏不卡；目录过滤可用；1.88 MB 记录卷按节点渲染。
- `世界观设定`：md + docx 混合；docx 标题/表格可读；图片占位。
- EPUB：现场生成 3 章 EPUB，正文/图片/目录可读；DRM/恶意 zip 被拒。
- 朗读：有中文语音包时播放/暂停/高亮/续章；无语音包时按钮禁用并提示。
- 连续/分页：连续滚动 5 章不跳；分页翻页/窗口 resize 位置不丢。
- 只读：阅读前后 `git status` 与文件 mtime 不变。
- 回归：编辑器、Markdown 分屏、AI 面板、资源管理器、会话恢复、`F11` 书签不受影响；写作模式方案（未实施）不受影响。

---

## 18. 实施批次

| 批次 | 内容 | 覆盖功能 |
|---|---|---|
| 0（本轮） | 文档与重命名：`novel-mode.md` → `writing-mode.md`；新增本文件；更新 AGENTS 文档清单 | — |
| 1 | Go 扫描/排序/profile；书架/详情页；阅读状态；测试 | 1–2 |
| 2 | 阅读视图骨架、TOC、md/txt 渲染、排版/主题、导航、进度、只读、章内查找、缓存 | 3–10 |
| 3 | docx 解析、文档树模式、混合目录、1002 标题性能 | 11–12 |
| 4 | 全书搜索、书签、阅读统计 | 13–14 |
| 5 | 连续滚动、分页、朗读（含语音包探针） | 15–16 |
| 6 | EPUB 解析/缓存/渲染与安全测试 | 17 |

每批独立 `node --check` → `go test ./...` → `wails build` → 用户在真实目录验收；版本号保持 `1.0.0`，不擅自升版。

---

## 19. 风险与待验证点

1. **TTS 语音可用性**：WebView2 的 `speechSynthesis` 在部分 Windows 环境没有中文语音；批 5 先做探针，无语音即禁用并提示，不引入 PowerShell 兜底。
2. **CSS 分页可靠性**：`column-fill: auto` + `scrollWidth` 在 WebView2 的测量需实测；不可靠时回退 JS 二分分页（批 5 原型先验证）。
3. **EPUB 安全**：zip-slip、zip bomb、XHTML 脚本/外链；必须白名单 + DOMPurify + 体积上限，禁止 EPUB 自带 CSS/字体。
4. **1002 标题目录**：默认深度 2、懒渲染、过滤；单层 500 项分页显示。
5. **大文件渲染**：1.88 MB 记录卷按节点切；单节点 200 KB 上限；无标题大文件按段落分块。
6. **自动识别不准**：必须有结构设置覆盖 + 置信度提示；不猜测用户意图。
7. **进度失效**：源文件大改后 ID 偏移；按标题/序号/比例三级回退，并提示。
8. **多窗口统计重复计时**：v1 接受；不做跨窗口锁。
9. **字体差异**：不同 Windows 版本系统字体可用性不同；每项都有 serif/sans 回退。
10. **DOCX 限制**：只取文本/标题/表格文本，图片占位；`.doc` 不支持。
11. **连续模式内存**：30 单元/8 MB HTML 上限；超出显示「加载更多」，不回收已加载 DOM。
12. **会话恢复**：若上次退出在阅读模式，启动恢复阅读位置；可在设置关闭。

---

## 20. 明确不做

- 不改源文件、不做划线/批注/笔记导出（书签只存位置+摘录）。
- 不做网络书城、账号同步、云进度。
- 不支持 `.doc`、PDF、DOCX 图片抽取、EPUB DRM/自带 CSS/字体。
- 不打包中文字体（体积约束），只用系统字体。
- 不为阅读模式建 SQLite 全文索引；搜索即时扫描 + 硬预算。
- 不把整个工作区递归拼成一本书；书根必须显式选择/记住。
- 不新增全局快捷键；不改 `wailsjs/` 生成文件。
