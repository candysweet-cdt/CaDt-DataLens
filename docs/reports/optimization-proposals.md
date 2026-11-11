# CaDt-DataLens 低体积优化与功能建议

> 分析日期：2026-01（基于当前工作区源码）
> 分析范围：`app.go`、`search.go`、`structure.js`、`formats.js`、`main.js`、`frontend/package.json`、`frontend/dist/`
> 原则：**优先“不增加安装体积、不增加第三方依赖”的改动**，符合本项目「单 exe、零依赖、系统提供引擎」的定位。

---

## 摘要

编号与正文小节编号一致；优先级单列。

| # | 项目 | 类型 | 新增体积 | 改动量 | 优先级 |
|---|---|---|---|---|---|
| 1 | CSV 表格虚拟滚动 | 优化 | 0 | ~120 行 | ⭐⭐⭐ |
| 2 | Markdown 一次性 sanitize | 优化 | 0 | ~30 行 | ⭐⭐⭐ |
| 3 | 工作区搜索多线程化 | 优化 | 0 | ~80 行 | ⭐⭐ |
| 4 | Markdown 分屏按块增量渲染 | 优化 | 0 | ~150 行 | ⭐⭐ |
| 5 | 文件树缓存治理 + 文件系统通知 | 优化 | 0 | ~25 行（快）/ ~150 行 Go（全） | ⭐⭐⭐ |
| 6 | 结构解析移入 Web Worker + 缓存 | 优化 | 0 | ~80 行 | ⭐⭐ |
| 7 | 优先调用 ripgrep（可选增强） | 优化 | 0（不打包） | ~100 行 Go | ⭐⭐ |
| 8 | JSONPath / JMESPath 查询栏 | 新功能 | 0 ~ 10 KB | 中 | ⭐⭐⭐ |
| 9 | CSV 列统计面板 | 新功能 | 0 | ~150 行 | ⭐⭐⭐ |
| 10 | 表格排序与筛选 | 新功能 | 0 | ~100 行 | ⭐ |
| 11 | 两个文件 Diff（数据感知） | 新功能 | 0 | ~200 行 | ⭐⭐ |
| 12 | CLI 批量格式转换 | 新功能 | 0 | ~400 行 | ⭐⭐ |
| 13 | 书签与视图状态持久化 | 新功能 | 0 | ~80 行 | ⭐ |
| 14 | JSON Schema 校验（可选） | 新功能 | ~30–40 KB | 中 | ⭐ |

> 体积数字中，`0` 表示不引入新依赖；括号内的 KB 为 npm 包 gzip 后的经验值，实际以打包结果为准。
> 性能倍数均为基于代码结构的**推断**，本文未做基准测试，落地时应实测验证。
> **第 5 项分两阶段**：阶段一（`DirEntry` 加 `mtime` + 三处小改）约 25 行，即可解决 90% 的无效重扫；阶段二（文件系统通知）才是 150 行 Go。详见该节。

---

## 一、现状基线

### 体积构成（实测）

| 文件 | 大小 | 说明 |
|---|---|---|
| `frontend/dist/assets/index-BAwWF6e5.js` | 1.34 MB | 打包后的全部应用 JS |
| `frontend/public/vendor/mermaid/mermaid.min.js` | 2.57 MB | 单个图表库 |
| `frontend/src/main.js`（源码） | 573 KB | 业务逻辑主文件 |
| `frontend/src/structure.js`（源码） | 71 KB | 17 种语言的结构解析 |
| `frontend/dist/assets/KaTeX_*` | 60 个文件 | woff2 / woff / ttf 三套格式 |
| `frontend/public/fonts/` | 5 个字体 | Inter ×2、JetBrains Mono ×2、Fira Code ×1 |

**结论**：20 MB 级的体积已经主要来自「借来的现成能力」（Ace / jsoneditor / xterm / mermaid / KaTeX / markdown-it / hljs）。因此后续优化应避免引入新的重量级依赖，把预算花在**填充真实功能缺口**上。

### 已知的硬限制（来自源码）

| 限制 | 位置 | 数值 |
|---|---|---|
| 打开文件上限 | `app.go` | 100 MB 拒绝 |
| 大文件只读 | `app.go` | 10 MB |
| 图片直接预览 | `app.go` | 32 MB |
| 二进制 hex 显示 | `app.go` `imageHexLimit` | 1 MB |
| CSV 表格渲染行数 | `main.js:3408` `CSV_TABLE_ROW_LIMIT` | 5000 |
| 结构视图文本上限 | `structure.js` `MAX_TEXT` | 4 MB |
| 结构视图节点上限 | `structure.js` `MAX_NODES` | 6000 |
| 工作区搜索文件上限 | `search.go` `searchMaxFileSize` | 4 MB |
| 工作区搜索耗时预算 | `search.go` `searchBudget` | 3.5 s |
| 工作区搜索结果数 | `search.go` `searchMaxResults` | 400 |
| 单文件搜索命中数 | `search.go` `searchMaxPerFile` | 30 |

这些数字说明一件事：**当前的性能瓶颈是有意用限制绕开的**，而不是被解决了。下面第 1、2、4、6 项就是把这些限制放宽；第 5 项则是消除无效的重复 I/O。

---

## 二、第一档：纯优化（不增加任何依赖）

### 1. CSV 表格虚拟滚动 —— 去掉 5000 行硬限制

**现状**

`main.js:3408`：

```js
const CSV_TABLE_ROW_LIMIT = 5000;
```

`main.js:6235` `renderCsvTableView()`：

```js
const shown = Math.min(rows.length, CSV_TABLE_ROW_LIMIT);
...
for (let i = 0; i < shown; i++) {
    const tr = document.createElement('tr');
    // 每行每个单元格都 createElement + 绑定 3 个事件监听
    fragment.appendChild(tr);
}
tbody.appendChild(fragment);
```

**问题**：一次性创建全部 `<tr>/<td>`。5 万行 × 10 列 ≈ 50 万 DOM 节点，因此只能砍到 5000 行，并在表头提示「仅显示前 5000 行」。

对一个自称「数据查看器」的工具来说，**看不了大表格是最直接的功能缺口**。

**改法**

1. 表体改为固定高度的虚拟滚动容器；
2. 只渲染 `[scrollTop / rowHeight, 视口行数 + overscan]` 区间内的行；
3. 上下各放一个撑高的占位元素维持滚动条长度；
4. 行 DOM 复用（行池），滚动时只更新 `textContent`。

由于 `td` 已经是 `contentEditable`，需要注意：**复用行池时必须在滚动前 `blur()` 正在编辑的单元格**（现有 `flushCsvCellEditor()` 已具备该能力，可直接复用）。

**收益**

| 维度 | 收益 |
|---|---|
| 功能 | 10 万行 CSV 可流畅浏览，移除「仅显示前 5000 行」 |
| 体积 | 0 |
| 风险 | 中等：需处理编辑态、列宽、`Ctrl+滚轮` 缩放（`applyCsvTableZoom`）与虚拟滚动的坐标换算 |

**工作量估算**：约 120 行 JS，集中在 `renderCsvTableView` / `applyCsvColumnLayout`。

---

### 2. Markdown 一次性 sanitize

**现状**

`main.js:7678` `renderMarkdownBlocksHtml()`：

```js
while (i < tokens.length) {
    ...
    const seg = DOMPurify.sanitize(
        markdownRenderer.renderer.render(group, markdownRenderer.options, env),
        {
            USE_PROFILES: {html: true, mathMl: true, svg: true},
            ADD_ATTR: ['target', 'rel'],
        }
    );   // ← 每个顶层块调用一次
    html += '<div class="md-block" style="display:contents" data-md-start="' + map[0] + '" data-md-end="' + map[1] + '">' + seg + '</div>';
}
```

**问题**：`DOMPurify.sanitize` 每次调用都会创建一个独立 document 并完整遍历一遍。一个 100 KB 的 Markdown 文档通常有一两百个顶层块，于是产生**一两百次独立 sanitize**，而不是一次。

这是为了实现「预览选区反查 Markdown 源码行」（`.md-block[data-md-start]` + `copySelectedMarkdown`）而付出的代价。

**改法**

先拼接完整 HTML（保留 `data-md-start/end` 包装），再**只调用一次** `sanitize`：

```js
html += '<div class="md-block" data-md-start="..." data-md-end="...">' + seg + '</div>';
// 循环结束后：
return DOMPurify.sanitize(html, {USE_PROFILES: {...}, ADD_ATTR: ['target', 'rel', 'data-md-start', 'data-md-end']});
```

注意点：
- `data-*` 属性默认会被 DOMPurify 保留，但为稳妥仍应显式加入 `ADD_ATTR`（或确认 `ALLOW_DATA_ATTR` 未关闭）；
- 现有 fallback 分支 `return renderMarkdownHtml(text)` 需保持一致行为。

**收益**：渲染耗时**预期可降一个数量级**（纯推断，未实测）；`copySelectedMarkdown` 的块级精度逻辑完全不变。

**工作量估算**：约 30 行，改动极小，**最容易先做的性能优化**。

---

### 3. 工作区搜索多线程化与热点消除

**现状**

`search.go` `SearchWorkspace()` 是单线程 `filepath.WalkDir` + 逐文件 `bufio.Scanner`：

```go
walkErr := filepath.WalkDir(root, func(path string, d os.DirEntry, walkErr error) error {
    ...
    scanner := bufio.NewScanner(f)
    for scanner.Scan() {
        line := scanner.Text()
        haystack := line
        if !caseSensitive {
            haystack = strings.ToLower(line)   // ← 每行一次完整字符串分配
        }
        ...
    }
})
```

**三个具体热点**

| 位置 | 问题 | 改法 |
|---|---|---|
| `buildSearchPreview` | 每次命中都 `[]rune(line)` 把整行转 rune；1000 字符长日志行有 10 个命中就是 10 次全行转换 | 只在 `[from, to]` 窗口附近切片，或直接用字节偏移 + `utf16Len` 增量计算 |
| `strings.ToLower(line)` | 每行分配一个新字符串（行长 × 文件数 × 行数） | 用 `bytes.Index` + 自写 ASCII 不敏感比较；或对纯 ASCII 行跳过 ToLower |
| `result.Files%200 == 0` 才检查超时 | 超时粒度粗（200 个文件一次）；且**完全没有并发** | 改为 worker pool（`runtime.NumCPU()`），每文件检查超时 |

**收益**：多核机器上预期 **3–6 倍**吞吐提升（推断）；配合第 7 项可再上一个台阶。**零新增依赖**。

**工作量估算**：约 80 行 Go，主要集中在 `SearchWorkspace` 重构。

---

### 4. Markdown 分屏按块增量渲染

**现状**

`main.js:6523` `renderMarkdownPreview()`：

```js
doc.previewBody.innerHTML = renderMarkdownBlocksHtml(doc.editor.getText());  // 整段替换
```

配合 `scheduleSplitPreview()`：

```js
doc.splitTimer = setTimeout(() => {
    renderSplitPreview(doc);
}, doc.splitKind === 'html' ? 350 : 160);
```

**问题**：分屏模式下，只要停止输入 160 ms，就会把**整个文件**重新解析 → 净化 → 重建全部 DOM。在 100 KB 的 Markdown 里写东西，会明显感到卡顿。完整预览模式是只读的，所以没有这个问题。

**改法**

由于 `renderMarkdownBlocksHtml` 已经为每个块标注了 `data-md-start` / `data-md-end`（源码行区间 0 基，含头不含尾），可以直接做**按块 diff**：

1. 解析新文本得到 `[{start, end, html}, ...]`；
2. 与旧块的 `start/end` 序列比对；
3. 仅替换行区间发生变化的块（外层 `.md-block` 的 `innerHTML` 局部更新）；
4. 插入/删除块时，按位置 `insertBefore` / `remove`。

**收益**：在文档尾部追加内容时，只需重建最后 1–2 个块，而不是全文。**大 Markdown 分屏编辑的卡顿可基本消除**。

**工作量估算**：约 150 行 JS。需要注意锚点链接（`gfm` heading id）和 `mdSyncScrollFromAce` 的位置换算不受影响。

---

### 5. 文件树缓存治理 + 文件系统通知

> 这一项经源码验证后改写：**缓存已经存在，问题不在“没缓存”，而在缓存被反复主动作废**。
> 因此拆成「低成本阶段一」和「完整阶段二」，阶段一的性价比远高于直接上文件系统通知。

#### 现状：三级机制

`frontend/src/explorer.js` 的文件树不是「每次展开都扫描磁盘」，而是分三层：

**① 惰性加载**（设计如此）

`resetTree()` 只创建根节点，`loaded: false`，子目录一律等展开时才读：

```js
tree = { name, path, isDir: true, root: true, expanded: true,
         loaded: false, children: [], loadPromise: null, ... };
loadNode(tree, treeSeq);   // 只加载根
```

**② 内存缓存**（`node.children` + `node.loaded`）

`loadNode()` 开头有缓存守卫，加载完成后结果写回节点：

```js
async function loadNode(node, seq) {
    if (!node || !node.isDir || node.loaded) return true;   // ← 已加载：直接返回
    if (node.loadPromise) return node.loadPromise;          // ← 并发去重
    ...
    node.children = entries.map(...).sort(compareEntries);
    node.loaded = true;
}
```

所以收起再展开一个**已加载**的目录，走的是纯渲染路径：

```js
function toggleNode(node) {
    if (!node.expanded) { renderTree(); return; }          // 收起：零 I/O
    if (!node.loaded) { loadNode(node, treeSeq); return; } // 首次：扫描
    renderTree();                                          // 已缓存：只渲染
    if (autoRefreshSeconds > 0) { refreshNodeChildren(node).then(...); }  // ← 却又扫一次
}
```

**③ 自动刷新**（缓存失效的主因）

默认 `settings.treeRefreshInterval = 3`（秒），`applySettings()` 里接上：

```js
if (explorer && explorer.setAutoRefresh) explorer.setAutoRefresh(settings.treeRefreshInterval);
```

定时器会把**所有已展开目录**逐个重读，而且**串行 `await`**：

```js
function collectExpanded(node, out) {
    if (node.expanded && node.loaded) out.push(node);      // 包括滚出视口的分支
    for (const child of node.children || []) collectExpanded(child, out);
}

async function refreshTreeSilently() {
    const targets = [];
    collectExpanded(tree, targets);                        // N 个已展开目录 = N 个 target
    for (const node of targets) {
        if (await refreshNodeChildren(node)) changed = true;   // 每个都完整 readDir
    }
    if (changed && visible && mode === 'tree') renderTree();
}
```

`refreshNodeChildren` 内部就是完整重读：

```js
const result = await readDir(path, readLimit);   // readLimit = 1000
return mergeChildren(node, (result && result.entries) || [], ...);
```

`mergeChildren()` 做了「按路径复用旧节点对象 + 未变化返回 false」的 diff，因此**避免了无谓的 DOM 重渲染**——但 **I/O 成本照付**。

**结论**：N 个展开的目录 = 每 3 秒 N 次 Wails IPC 往返 + N 次 `os.ReadDir`。打开 10 个目录，相当于每秒 3 次以上的目录读取。这才是「感觉一直在扫」的真实来源。

#### 缓存失效点清单

| 时机 | 位置 | 是否重扫 | 性质 |
|---|---|---|---|
| 首次展开某目录 | `toggleNode` → `loadNode` | ✅ | 惰性加载，合理 |
| **再次展开已缓存目录** | `toggleNode` 末尾 `refreshNodeChildren` | ⚠️ **会** | 与定时器重复，可删 |
| **自动刷新定时器** | `runAutoRefresh` → `refreshTreeSilently` | ✅ **所有已展开目录** | 无法判断“有无变化”，只能全读 |
| 点刷新按钮 | `refresh()` → `tree = null` | ✅ 整棵树丢弃重建 | 用户主动，合理 |
| 换根目录 | `setRoot` → `tree = null` | ✅ | 合理 |
| 新建/粘贴/删除/重命名 | `refreshDir()` | ✅ 仅目标目录 | 合理 |

#### 根因：`DirEntry` 不带 `mtime`，无法做廉价变更判断

`app.go:652` 返回的目录项只有三个字段：

```go
type DirEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
}
```

`os.ReadDir` 拿到的 `DirEntry.Info()` 本可提供 `ModTime()` 与 `Size()`，但**被丢掉了**。于是前端只能靠「完整重读 + 内容 diff」判断变化，做不到 VS Code 那种「先比时间戳，没变就跳过」。

**这是第 5 项里最值得先修的一个点。**

---

#### 阶段一（推荐先做）：四处小改，约 25 行

**A. `DirEntry` 增加 `mtime`/`size`**（Go 侧 ~10 行）

```go
type DirEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
	Mtime int64  `json:"mtime,omitempty"`   // Unix 毫秒
	Size  int64  `json:"size,omitempty"`
}
```

在 `ReadDir` 里用 `entry.Info()` 填充（注意 `Info()` 每项都可能触发一次 `stat`，目录项多时建议只对文件填 `Size`，或直接接受这点成本 —— 单次 `stat` 远廉价于整目录重读）。

**B. 前端先比目录 mtime，未变则跳过**（~15 行）

```js
async function refreshNodeChildren(node) {
    if (!node || !node.isDir || node.loading || node.refreshing) return false;
    const result = await readDir(node.path, 1);   // 只取头部，用于比对 mtime
    if (result && result.dirMtime === node.dirMtime) return false;   // 未变，直接返回
    ...
}
```

> 更简洁的做法：不额外请求，直接让 `readDir` 返回 `dirMtime`，在拿到完整结果后**下一次**刷新前比对——即「上次记录的 mtime 未变就跳过本次请求」。两种都可，后者少一次 IPC。

**C. 删掉 `toggleNode` 末尾的重复刷新**

定时器已经在兜底，展开时的 `refreshNodeChildren` 属于重复劳动。删掉后，展开已缓存目录变成**纯渲染**，真正用上缓存。

**D. 自动刷新只覆盖可见区域**

```js
const visiblePaths = new Set(
    [...body.querySelectorAll('.sb-row[data-path]')].map((r) => normalizePath(r.dataset.path))
);
const targets = allExpanded.filter((n) => visiblePaths.has(normalizePath(n.path)));
```

这是 IDE 的通行做法——**用户看不见的目录没必要每 3 秒校验一次**。

阶段一完成后，稳态下每次自动刷新的成本从「N 次目录重读」降到「0～(可见目录数) 次极轻比对」。

---

#### 阶段二（完整方案）：文件系统通知

在 Go 侧调用 `ReadDirectoryChangesW` 递归监听工作区根，变化时通过 `runtime.EventsEmit` 把**变化路径**推给前端，前端只刷新受影响目录。

`golang.org/x/sys` **已在 `go.mod`**（`v0.48.0`），无需新增依赖：

```go
// 示意
import "golang.org/x/sys/windows"
// windows.ReadDirectoryChangesW
//   + FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME | FILE_NOTIFY_CHANGE_LAST_WRITE
```

按现有平台分文件约定，新建成对文件：

- `watch_windows.go` —— 真实实现
- `watch_other.go` —— 空实现（`return errors.New("unsupported")`）

**收益**

| 维度 | 阶段一 | 阶段二 |
|---|---|---|
| 响应性 | 仍为「最多 3 秒」 | **即时** |
| 无效 I/O | 消除绝大多数（稳态趋近 0） | 完全消除 |
| CPU / 磁盘唤醒 | 大幅降低 | 最低 |
| 代码量 | ~25 行 | ~150 行 Go |
| 风险 | 低 | 中（见下） |

**兼容策略**：保留轮询作为降级路径——`settings.treeRefreshInterval` 已有 0/1/2/3/5/10 档开关，`0` 即关闭。建议实现为「通知可用时把轮询退化为长周期兜底（如 30 s）」。

> **风险提示**：`ReadDirectoryChangesW` 的语义细节必须处理——通知会合并、缓冲区可能溢出（`ERROR_NOTIFY_ENUM_DIR`），溢出时应退化为一次全量刷新；递归监听大目录时需注意句柄与线程模型；监听器需随 `setRoot` 切换而重建。

#### 验证方法

改动前后用同一工作区（建议 `node_modules` 或 `frontend/dist` 这类多目录场景）测量：

1. 展开 10 个目录，静置 60 秒；
2. 用 Process Monitor 统计 `ReadDirectoryChangesW` / 目录读取次数；
3. 对比阶段一/阶段二前后的调用次数与主线程占用。

**预期**：阶段一即可把稳态目录读取次数降到接近 0（仅在 mtime 变化时发生）。这是**推断**，需实测确认——尤其是 `DirEntry.Info()` 在小目录下的成本，可能抵消部分收益。

---

### 6. 结构解析移入 Web Worker + 结果缓存

**现状**

`structure.js` 的 `parseStructure()` 在**主线程**同步执行，且设有两道自我限制：

```js
const MAX_TEXT = 4 * 1024 * 1024;
const MAX_NODES = 6000;
```

`main.js` 侧用 500 ms 防抖触发：

```js
structureRefreshTimer = setTimeout(() => {
    structurePanel.refresh();
}, 500);
```

**问题**：4 MB 文件的正则全表扫描会阻塞 UI，造成输入卡顿；每次切换标签都要重新解析同一文件。

**改法**

1. **移入 Web Worker**：`structure.js` 是纯函数 + 零 DOM 依赖（`parseStructure` 及其下游 `parseMarkdown` / `parseGo` / `parseBrace` 等都不碰 `document`），只有 `createStructurePanel` 部分涉及 DOM —— 因此可把解析器单独抽成 `structure-parser.js`，Worker 与主线程共用同一份代码。
2. **加缓存**：按 `(filePath, mtime 或 textLength + 轻量 hash)` 缓存结果，切换标签时直接命中。

**收益**：解析期间 UI 完全不卡；重复切换零成本。可以顺势提高 `MAX_TEXT`（如 8 MB）。

**工作量估算**：约 80 行（拆文件 + Worker 消息协议 + 缓存表）。

---

### 7. 优先调用 ripgrep（可选增强）

**改法**

```go
if rgPath, err := exec.LookPath("rg"); err == nil {
    // 走 rg --json 子进程
} else {
    // 退回现有 SearchWorkspace 实现
}
```

这是 VS Code 的策略：**不打包 ripgrep，用户装了就用，没装就降级。**

**收益**

| 维度 | 收益 |
|---|---|
| 性能 | 大仓库搜索快 10 倍以上 |
| 额外能力 | 免费获得 `.gitignore` 尊重、并发 IO、内存映射 |
| 体积 | **0**（不打包 rg） |

**工作量估算**：约 100 行 Go（JSON 流式解析 + 路径/行号映射）。

---

## 三、第二档：小体积高价值新功能

### 8. JSONPath / JMESPath 查询栏 ⭐ 最高性价比

**现状**

- `formats.js` 只有 `parse` / `stringify`，**没有任何查询能力**；
- 用户要在一个 20 MB 的 JSON 里找某个字段，只能靠树视图逐层点开，或 Ctrl+F 全文搜（但搜到的是文本位置，不是结构化结果）。

**这是当前最大的功能空白。**

**改法**

在内容区加一个查询输入框：

```
$.items[?(@.price > 100)].name
$.users[*].email
$..errorCode
```

结果以「结果列表 + 可跳转行号」或「过滤后的树」两种方式呈现。

| 实现方案 | 体积 | 能力 |
|---|---|---|
| **手写简易 JSONPath** | **0 字节** | 支持 `$ . [] * ..` + 简单过滤，约 200 行，覆盖 ~90% 日常场景 |
| 引入 `jmespath` | ~10 KB gzip | 语法规范，有完整文档与更严谨的语义 |

**收益**：对「数据查看器」而言，**这个功能比任何性能优化都更有价值**。同类工具（jq、JSON Hero、Insomnia、Bruno）都靠查询能力留住用户。

**工作量估算**：200 行（手写方案），建议同时支持 YAML / TOML / INI（复用 `formats.parse` 得到对象后统一查询）。

---

### 9. CSV 列统计面板

**改法**

选中某列 → 侧栏（或底部面板）显示：

| 指标 | 示例 |
|---|---|
| 行数 / 非空 / 空值 | 50,000 / 49,832 / 168 |
| 唯一值数 | 1,204 |
| min / max / avg（数值列） | 0 / 98500 / 4213.7 |
| 最长值长度 | 148 |
| 疑似类型 | 数字 / 日期 / 邮箱 / URL / 枚举 |

相当于 pandas `describe()` 的轻量版。**这对「看数据」的价值极高**，而代码是纯 JS 数值遍历。

**工作量估算**：约 150 行，**0 依赖**。

---

### 10. 表格排序与筛选

**现状**：`renderCsvTableView` 已有结构化的 `doc.tableHeaders` / `doc.tableRows`，`doc.tableUndo` / `doc.tableRedo` 也已存在。

**改法**

- 点击表头排序（数字/字符串/日期自适应）；
- 顶部输入框做子串筛选。

**关键设计点**：排序与筛选应当**只改视图顺序，不改 `editor.getText()`**。

理由：`commitCsvCell()` 通过 `serializeCsvTable(doc)` 把 `doc.tableRows` 序列化回编辑器文本。若排序直接改动 `doc.tableRows` 顺序，会把文件内容一起重排 —— 用户按一下排序键，文件就被改动了，这几乎一定是非预期行为。

正确做法：引入 `doc.tableViewRows`（视图索引数组），渲染时按它取行，编辑时通过索引映射回原始行。

**工作量估算**：约 100 行。

---

### 11. 两个文件 Diff（数据感知）

**现状**：已有 Git diff（`gitinfo.go` / `showGitDiff`），但**无法比较两个任意文件**。

**改法**

- 入口：任意两个标签页 → 「比较…」；或文件树多选两项 → 右键「比较」。
- 文本层：Myers/LCS 行 diff，复用 Ace 的语法高亮与滚动（`diff` 模式 Ace 已内置）。
- **数据层（本项目的差异化优势）**：对 JSON/YAML/TOML 先 `JSON.parse`（或 `formats.parse`）再规范化，输出**语义级差异**：

```
a.b.c: 1 → 2            （值变化）
a.b.d                    （新增）
a.e                      （删除）
items[3].name: "x"→"y"  （数组元素变化）
```

而不是几百行无意义的文本行变化。两份配置文件对比是这个应用的高频场景。

**工作量估算**：文本 diff 约 150 行 + 语义 diff 约 100 行。

---

### 12. CLI 批量格式转换 ⭐ 被低估的价值

**现状**

- `main.go` 已有 CLI 入口：`if runInstallerCommand(os.Args[1:]) { return }`
- `app.go` 已有完整的参数解析：`parseOpenTargets`、`--line`、`--column`、`--goto`
- `formats.js` 里 `parse` / `stringify` 是**完整双向转换器**：JSON ⇄ YAML ⇄ TOML ⇄ CSV ⇄ INI ⇄ JSONL

也就是说：**转换能力早就写好了，只是没有暴露成命令行。**

**改法**

```bat
CaDt-DataLens.exe --convert "a.json" --to yaml --out "a.yaml"
CaDt-DataLens.exe --convert "logs\*.jsonl" --to csv
CaDt-DataLens.exe --convert "config.yaml" --to json --stdout
```

**收益**

把这个工具从「手动打开 → 另存为」变成**可脚本化、可批处理、可进 CI** 的能力。对数据工作流的价值远超界面上任何单点优化。

**实现路径两种**

| 路径 | 代码量 | 说明 |
|---|---|---|
| Go 侧重写转换器 | ~400 行 | 需要重新实现 8 种格式解析（重复劳动） |
| **headless 模式复用前端** | ~150 行 | 启动隐藏窗口跑 `formats.parse/stringify`，通过 `runtime` 回传结果 |

推荐后者：**逻辑只有一份，格式扩展自动生效**（包括插件注册的自定义格式 `pluginFormats`）。

**工作估算**：~150–400 行，视路径而定。

---

### 13. 书签 + 视图状态持久化

**现状**

- 大文件里来回跳只能靠 `Ctrl+G` 手动记行号；
- 已有会话恢复机制（`saveSessionNow` / `scheduleSessionSave`），但恢复的粒度是「打开了哪些文件」。

**改法**

- **行书签**：`Ctrl+F11` 加/删书签，`F11` / `Shift+F11` 跳转（注意 `F11` 在写作模式下已被占用，需协调键位或在非写作模式下才生效）。
- **视图状态**：把每个文件的光标位置、滚动位置、Ace 折叠状态一并存入 session。

**工作量估算**：约 80 行。

---

### 14. JSON Schema 校验（需权衡）

**改法**

用 `ajv` 在 JSON 文件上做 Schema 校验，行内显示错误标记，配合已有的 `showJsonErrors`（`createDocEditor` 中的 `showErrorTable: showJsonErrors`）呈现错误表。

**体积**：`ajv` 约 30–40 KB gzip。**不算零成本**，因此不放在第一档。

**注意**：本项目已有「解析错误表」能力（`onError` + `flash`），Schema 校验相当于把「语法错误」升级为「结构契约错误」，与现有 UI 契合度很高。

---

## 四、不建议做的方向

| 想法 | 不建议的原因 |
|---|---|
| **换 Monaco 替代 Ace** | 体积 +5~10 MB；本项目没有 PSI / LSP，拿不到 Monaco 真正优势（语义补全、跨文件跳转），只换来「更好看的编辑体验」，性价比极低 |
| **内置 SQLite / 查询引擎** | 不用于主存储与配置；**例外（2026-11-11 作者批准）**：AI 会话搜索派生索引 + CSV/TSV/JSONL 的只读查询临时库（pure-Go modernc，实测整包 +3.9 MB），会话 JSONL 与原数据文件仍是真源 |
| **自建全项目索引（学 IDE）** | 索引缓存可涨到 GB 级，正是 JetBrains 类产品体积的主要来源。**本项目的核心竞争力恰恰是「无索引」** |
| **内置 LSP 客户端** | 需要 Node / 各语言 language server，违背「单 exe、零依赖」的核心设计 |
| **打包 ripgrep 二进制** | rg 单文件约 3–5 MB。改为「检测到就用」（第 7 项）即可，体积为 0 |

---

## 五、推荐执行顺序

若受限于精力，只做四项：

| 优先级 | 项目 | 理由 |
|---|---|---|
| **1** | **JSONPath 查询栏**（第 8 项） | 纯增量价值，填补最大功能空白，0 ~ 10 KB |
| **2** | **CSV 虚拟滚动 + 列统计**（第 1、9 项） | 让「数据查看器」名副其实，0 依赖 |
| **3** | **Markdown 一次性 sanitize + 搜索多线程**（第 2、3 项） | 纯性能优化，不加任何东西就变快 |
| **4** | **文件树缓存治理 · 阶段一**（第 5 项 A–D） | 约 25 行，消除稳态下绝大部分无效目录 I/O |

这四项合计：

- **新增依赖 ≤ 10 KB**
- **改动集中在 4 个文件**：`main.js`、`explorer.js`、`search.go`、`structure.js`（外加 `app.go` 的 10 行）
- 分别补上「**能不能用**」「**好不好用**」「**快不快**」「**白不白耗**」四个维度

### 建议的实施节奏

```
Step 1  Markdown 一次性 sanitize（第 2 项）    ← 30 行，最容易验证，先建立信心
Step 2  文件树缓存治理·阶段一（第 5 项）        ← 25 行，收益立刻可测（数目录读取次数）
Step 3  CSV 虚拟滚动（第 1 项）               ← 解决最硬的功能限制
Step 4  JSONPath 查询栏（第 8 项）            ← 主打新增能力
Step 5  搜索多线程 + CSV 列统计（第 3、9 项）  ← 收尾优化
Step 6  CLI 格式转换（第 12 项）              ← 独立分支，可并行
Step 7  文件树通知（第 5 项阶段二）            ← 视阶段一实测收益决定是否继续
```

---

## 附录：证据索引

| 结论 | 证据位置 |
|---|---|
| CSV 5000 行限制 | `main.js:3408` `CSV_TABLE_ROW_LIMIT = 5000`；`main.js:6235` `shown = Math.min(...)` |
| 逐块 DOMPurify | `main.js:7678` `renderMarkdownBlocksHtml()` 循环内 `DOMPurify.sanitize` |
| 预览整段重渲染 | `main.js:6523` `doc.previewBody.innerHTML = ...`；`scheduleSplitPreview` 160/350 ms |
| 搜索单线程 | `search.go` `SearchWorkspace()` 中 `filepath.WalkDir` + `bufio.Scanner` |
| 搜索热点 | `search.go` `buildSearchPreview()` 的 `[]rune(line)`；`strings.ToLower(line)`；`result.Files%200 == 0` |
| 结构解析主线程 + 上限 | `structure.js` `MAX_TEXT`、`MAX_NODES`、`parseStructure()`；`main.js` `scheduleStructureRefresh` 500 ms |
| 结构解析为纯正则 | `structure.js` `PROFILES`、`goFunc()`、`maskCLikeLines()` |
| 格式驱动双向转换 | `formats.js` 各 `parse` / `stringify` |
| 文件树有内存缓存（非每次扫描） | `explorer.js` `loadNode()` 的 `if (node.loaded) return true` / `node.loadPromise`；`toggleNode()` 的 `if (!node.loaded)` 分支 |
| 树缓存被自动刷新作废 | `explorer.js` `collectExpanded()` + `refreshTreeSilently()` 串行 `await refreshNodeChildren()` |
| 展开已缓存目录仍会重扫 | `explorer.js` `toggleNode()` 末尾 `if (autoRefreshSeconds > 0) refreshNodeChildren(node).then(...)` |
| 自动刷新只做 diff、不做跳过 | `explorer.js` `mergeChildren()` 按路径复用节点，但 `readDir` 已先行调用 |
| `DirEntry` 缺 mtime/size | `app.go:652` `ReadDir()` 返回 `DirEntry{Name, Path, IsDir}`，未填 `Info()` 的 `ModTime()` |
| `x/sys` 已存在 | `go.mod` `golang.org/x/sys v0.48.0` |
| CLI 通道已存在 | `main.go` `runInstallerCommand(os.Args[1:])`；`app.go` `parseOpenTargets()` |
| 文件读写无 VFS 层 | `app.go` `OpenFile()` 直接 `os.ReadFile` |
| 体积实测 | `frontend/dist/assets/index-BAwWF6e5.js` 1.34 MB；`frontend/public/vendor/mermaid/mermaid.min.js` 2.57 MB |

---

## 免责说明

1. **性能数字均为推断**。文中「一个数量级」「3–6 倍」等表述来自对代码结构的分析，**未做基准测试**。落地时应先用 DevTools Performance 面板 / Go benchmark 实测，确认收益后再决定是否继续。
2. **体积数字**：`0` 表示不引入新依赖（已核对 `package.json` / `go.mod`）；`~10 KB`、`~30–40 KB` 为 npm 包 gzip 后的经验值，实际以打包结果为准。
3. 涉及的第三方库能力描述（ripgrep、ajv、jmespath）基于其公开文档的一般性理解，集成前请复核当前版本 API。
