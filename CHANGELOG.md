# 更新日志

CaDt-DataLens 的重要变更记录。版本号采用 `vMAJOR.MINOR.PATCH`，与 Gitee Release 的 tag 对应。

## 未发布

### 修复（内置 TTS 示例启动命令 + 桌面控制「尚未安装」误报）

> 来源：GitHub PR #1（作者 jasonsac-hzau，"fix(ai): 内置 TTS 示例改用系统 PowerShell 5.1；桌面控制申请按真因报错"）。两处缺陷的修复由该 PR 提供，本地合入时在其基础上补了审查修正（见下）。

- **`tts_sapi` 内置示例在干净系统上必挂**：示例启动命令写的是 `pwsh`（PowerShell 7，需另装），前置条件却写「Windows 自带 PowerShell（pwsh 7 或 5.1）」——Win10/11 自带的是 `powershell.exe`(5.1)，两者自相矛盾。实测干净机器上装完即 `state=failed`、`toolCount=0`，把 command 改成 `powershell` 后立刻 `connected`（同目录 `ocr_windows` 示例一直用 `powershell`）。修法：`internal/mcpsamples/samples.go` 里 `tts_sapi` 的 `Command` 改为 `powershell`、前置条件改为「Windows PowerShell 5.1（Win10/11 自带，无需另装 PowerShell 7）」，`docs/mcp-samples/README.md` / `tts-sapi.ps1` 的注释与 dev mock 预览文案同步。守卫：`internal/mcpsamples/mcp_samples_test.go` 新增 `TestBuiltinSampleCommandsResolveOnCleanSystem`（按注册表断言启动命令、预览前缀，并禁止前置条件再承诺 `pwsh`）。已安装老用户不改写 `mcp.json`：把该行命令手动改成 `powershell` 即可。
- **桌面控制申请把「已安装但启动失败」报成「尚未安装」**：`request_desktop_control` 原用「MCP 快照里 windows 工具数 > 0」当「装没装」判据，而 server 启动失败（uv 缺失 / 依赖没下完 / wheel 被清理）时工具数同样是 0——于是「已安装 + 开关已开 + 工具全勾」的机器收到「请点『安装』」，而卡片自 2026-11-22 起是「开关即安装」，界面上没有这个按钮。修法：`ai-desktop-control.js` 新增纯函数 `desktopAvailability()` 把「mcp.json 的 windows 行 + 快照 state/lastError + MCP 总开关」折算成五态（未安装 / 已装未启用 / 启动中 / 启动失败 / 可用）与 `desktopAvailabilityMessage()` / `desktopAvailabilitySummary()`；`ai-panel.js` 的 `request_desktop_control`、`windows_control_mode` 兜底、权限面板开关、菜单描述与「新会话默认桌面控制」置灰判定统一走它（启动失败时带 `state` 与失败原因）；`ai-mcp.js` 的 `getState()` 增加 `loaded`，区分「MCP 总开关关闭」与「还没拉过快照」。守卫：`ai-desktop-control.test.mjs` 新增五态用例。
- **本地审查修正（在 PR 基础上）**：① FAILED 文案原本让用户「点『更新配置』重装依赖」，但该按钮只在旧配置（`needsUpgrade`）时渲染，启动失败时配置本身通常是好的、按钮并不存在——改为指向始终存在的「启用桌面控制」开关（关掉再打开重试）；② 移除文案里让 AI「用 MCPDesktopDoctor 确认 uv」的指引——它是 Wails 绑定、不是 AI 可调用工具；③ 测试补断言，禁止 FAILED 文案再指向不存在的「更新配置 / MCPDesktopDoctor」入口；④ dev mock 补 `MCPGetConfig` / `MCPSnapshot`，避免 dev 模式可用性判定退化成「启动失败」。

### 优化（子代理详情标签页：工具输出可折叠 + 标题带状态 + 滚动跟随）

- **工具输出改可折叠工具卡**：详情正文的工具行原先是「裸工具名 + 一坨截断文本」（长输出硬铺开、无动词无图标），现复用主消息区同一份 `toolMeta` 动词+图标映射，头部显示「图标 + 动词 + 主参数 + 折叠箭头」，长输出（>400 字）与命令/搜索/列目录类工具默认收起、点击展开。折叠态存在块节点 class 上，跨 300ms 流式刷新自动保留。`toolMeta` 经 ctx 注入（不搬动定义，避免破坏 `ai-tool-wiring` 的源码切片守卫）。改动在 `ai-agent-view.js` / `ai-subagents.js` / `ai-tool-cards.js` / `ai-panel.js` / `style.css`。
- **标签页标题带运行状态**：运行中/完成/失败/停止分别加 `⟳ / ✓ / ✕ / ■` 前缀，tooltip 追加「轮次 · 耗时 · token · 状态」行。仿后台终端的「快照 + 订阅 + 卸载」范式：面板闭包内新增 `agentViewSnapshot` 与状态订阅，经 `bridgeAgentViewSnapshot` / `bridgeOnAgentViewUpdate` 桥方法送进 bridge 标签（bridge 域不 import ai 域，纯函数同样经桥方法注入）；300ms 节流 + 名称比对守卫避免每次状态事件重建标签栏，卸载时退订 + 清定时器 + 清 `doc.tabUnmount`。改动在 `ai-subagents.js` / `ai-panel.js` / `bridge-agent-view.js` / `editor-groups.js`。
- **正文排版微调**：内容区工具输出展开后限高 260→200px、块间距 10→12px、工具卡头部字号微调，避免长转录占满一屏（`style.css` 的 `.agentview-root` 覆盖区）。
- **滚动跟随接入通用模块**：详情正文的手写「距底<60」判定会被工具卡展开/内容重排骗成用户上翻；现改用 `ai-scroll-follow.js` 的 `createScrollGesture` + `nextStickState`，只有用户手势里的上滚才解除贴底，工具卡展开后贴底态自动补底。保留首帧吸附与后台标签（display:none）不写 scrollTop 两道守卫，多挂载点用 WeakMap 按工具行反查所属 view 防串扰。改动在 `ai-agent-view.js`。
- **验证**：`ai-subagents.test.mjs` 补 `agvToolDefaultCollapsed` / `agentViewTabName` / `agentViewRuntimeText` 表驱动用例；`npm test`、`npm run build` 全绿（构建仅余既有 chunk 体积警告）。

### 修复（内嵌浏览器：分辨率选择不缩放，页面纹丝不动）

- **现象**：工具条选「375 × 812（iPhone）」等预设后，页面照旧按标签页宽度布局——`innerWidth`、媒体查询都没变，分辨率选项实际上只改了可视框大小，等于没选。
- **根因（本机实测）**：旧实现靠 `ICoreWebView2Controller3::RasterizationScale` 承担缩放，而它**只影响栅格化密度、不参与布局**——960×540 可视框下把栅格比设成 1.25 / 3，页面 `innerWidth` 恒为 640（物理宽 ÷ 显示器 DPI 比例）、`devicePixelRatio` 恒为显示器比例，一次都不跟随。也试过 CDP `Emulation.setDeviceMetricsOverride`：布局能钉成 1280×720，但画面被可视框裁掉（右下角固定元素在截图里直接消失），且与页面缩放不叠加（metrics 宽再被 zoom 除一次），不能用作缩放。
- **修法（对齐 zcode 内置浏览器：分辨率与显示比例彻底分开）**：固定视口时前端把逻辑宽高一起下传，Go 侧按 `ZoomFactor = 物理宽 ÷(窗口 DPI 比例 × 视口宽)`（宽高各算一次取小，避免 1px 滚动条）设页面缩放——页面 CSS 视口恒等于用户设定的宽高，画面按「物理宽 ÷ 视口宽」等比缩进可视框；自适应（`0`）恢复缩放 1。页面导航会重置缩放，`NavigationCompleted` 后按记住的尺寸重放（`browser_windows.go`；`browser_other.go` 桩同步签名，`RasterizationScale` 相关字段与释放逻辑一并删除）。
- **前端新增预览缩放**：`doc.browserViewport`（分辨率）与 `doc.browserZoom`（适应窗口 / 50% / 75% / 100%）两个独立状态，改比例不动 CSS 视口；按钮显示 `1280×720 · 适应`，档位被「放得下」兜底时报**真实生效比例**（如 `· 70%`），不再出现「选了 100% 却看不出来」；从自适应进入固定视口默认「适应窗口」，换预设/换自定义尺寸不动用户已选比例（`editor-browser-tab.js`）。
- **验证**：新增 `internal/browser/browser_viewport_windows_test.go`（`-v` 显式运行，需本机 WebView2）：960×540 框里 1280×720 视口必须报 `innerWidth/innerHeight = 1280×720` 且 `dpr < 显示器比例`，可视框减半后视口不变、`dpr` 更小，换 375×812 预设视口跟随，回自适应等于「物理宽 ÷ dpr」；`editor-browser-tab.test.mjs` 补缩放档位与真实比例文案 3 例（20 例全绿）。

### 修复（AI 头部窄宽度：「变更 N」徽标折成两行 + MCP 安装后不自动刷新）

- **窄宽度徽标不再折行**：用户实测停靠面板中等宽度时头部「变更 17」被挤成「变 / 更 17」上下两行。根因是 `.ai-chip-btn` 没有 `white-space:nowrap`，而 `.ai-head-compact` 的收起阈值 420px 太晚——420–560px 区间徽标被压窄折行。修复：`style.css` 给 `.ai-chip-btn` 加 `white-space:nowrap` + `flex:none` 永不折行；`ai-head-hud.js` 的 ResizeObserver 增加 `ai-head-tight` 档（宽度 <560px 先收起「变更」徽标，改动汇总在消息流轮尾卡片仍可见），Git / 搜索留到 `ai-head-compact` 档再收。守卫补进 `ai-head-hud-icons.test.mjs`。
- **MCP 内置示例安装后立即刷新列表**：用户实测安装 `tts_sapi` 后服务器列表不出现，要退出重进才看到。两处根因：① Go 侧 `mcpsamples.MCPInstallSample` 绕过 `Client` 直接写 `mcp.json`，没应用到运行态管理器——新 server 不进 `m.servers`，`MCPSnapshot` 惰性启动看不到它、也不发 `mcp-tools-changed`；② 前端安装后调 `renderAll()` 读的是内存旧 config，新条目不会出现。修复：Go 侧新增 `mcp.ApplyConfigFromDisk`，根壳 `MCPInstallSample` 写盘后调它把新配置应用到运行态并推事件；前端 AI 工具安装与 `refreshMcpConfig`（外部工具页安装）都改走 `render()` 重读盘。守卫：`internal/mcp/client_test.go` 新用例（直接写盘后 `ApplyConfigFromDisk` 应挂进新 server 并发事件）、`mcp_samples_test.go` 接线守卫、`ai-mcp-config.test.mjs` 刷新口径断言。`go test ./internal/mcp ./internal/mcpsamples .`、`npm test`、`npm run build` 均通过。

### 修复（AI 面板：配置模型后「无模型」状态不自动刷新）

- 用户实测「AI 面板提示无模型，去设置里配好模型后，面板仍显示『尚未配置 AI / 未配置模型』，要关掉重开才消失」。根因：该空态在 `ai-panel.js` 的 `renderMessagesInner` 里按 `profileOf(session)` 画到 DOM 上，只有重绘主区才会更新；而新建/保存模型账号（`closeModelEditor`）、删除账号（`deleteModel`）保存后只调了 `updateComposerState()`（仅刷发送按钮/hint），没重绘主区——对比切换账号 `switchProfile`、导入配置 `importAIConfig` 都调了 `renderMessages(true)`。修复（`ai-model-settings.js`）：新增 `refreshMainView()` 钩子（面板打开且有当前会话时调 `renderMessages(true)`，并同步刷模型 chip），在账号保存、取消、删除三处收尾替换原来的 `updateComposerState()`。新增守卫测试 `ai-model-empty-refresh.test.mjs` 并登记进 `npm test`。

### 修复（AI 消息区：读历史时被新内容顶走滚动条）

- 用户实测「向上滚动正在静止看前面的消息时，下面新内容和卡片出来还是会影响滚动条」。根因是浏览器原生 scroll anchoring：在视口锚点上方插入 / 展开内容（工具卡、任务卡、新消息）时 Chromium 自动改 `scrollTop` 去锚定可见内容（实测插入 100px 卡片 scrollTop 被顶 +110px），绕过了应用已有的 `ai-scroll-follow` JS 判定——上翻态本应刻意不动 scrollTop。修复（`style.css`）：给两个消息滚动区 `.ai-messages` 与 `.gc-scroll`（群聊）加 `overflow-anchor: none`，把贴底跟随完全交给 JS（`scrollToBottom` / `shouldRefollowGrowth`，贴底态每帧主动补底，链路完整不受影响）。dev 里在真实 `.ai-messages` 验证：视口上方插入 130px 卡片 scrollTop 保持不动（delta=0）。`ai-scroll-follow.test.mjs` 补 CSS 守卫，全量测试与构建通过。

### 修复（标签拖动排序：让位动画把目标推开后 drop 落空）

- 用户实测「标签能拖、但松手换不了位置」。根因：拖动让位动画（`.tab.drop-gap { margin-left:88px }` + transition，`style.css`）在 `dragover` 时把目标标签从鼠标底下推开 88px，后续 `dragover`/`drop` 落在让位出来的 `.etabs` 空白区而非标签上；旧实现只在标签自身监听 `drop`，落点不是标签就无人 `preventDefault`，浏览器不触发 drop，排序提交（`moveTabInGroup`）根本没跑。因 130ms 动画时序而表现为时灵时不灵。修复（`editor-groups.js`）：`dragover` 把「插到哪个标签前/后」记入独立意图 `pendingTabDrop`，`drop` 统一经 `commitTabDrop` 消费；`.etabs` 标签条加 dragover/drop 兜底接住空白区落点（仅在本组标签拖动时生效，不干扰外部文件拖放）。新增守卫测试 `tab-drag-reorder.test.mjs` 并登记进 `npm test`；dev mock 里用合成 DragEvent 验证让位动画后落点变 `.etabs` 仍能正确换序（含 before/after 两向）。

### 修复（上下文弹层：会话运行中禁用「压缩上下文」按钮）

- 「上下文用量」弹层里的「压缩上下文」按钮原先在会话生成中仍可点——点了虽被 `startCompact` 的 `anyStreaming()` 拦下并提示，但按钮外观没变化，交互与反馈不一致。现新增 `syncCtxCompactButton()`，按 `anyStreaming() || oneShot`（与 `startCompact` 门禁同源）设置按钮 `disabled`，禁用时 `data-tip` 说明「请先停止当前生成，再压缩上下文」；流开始/结束（`setStreamingUI`）与弹层打开/重绘（`paintCtxPop`）两处同步，覆盖弹层开着时别的会话起轮的场景。禁用态在 `style.css` 压暗（原 `.dlg-btn:disabled` 只改 cursor，蓝描边按钮看着仍可点）。改动在 `ai-panel.js` / `style.css`；守卫测试补进 `ai-turn-steer-wiring.test.mjs`，该测试与 `npm run build` 均通过。

### 修复（浏览器标签：弹出菜单闪一帧 + 工具栏按钮 tooltip）

- 点开浏览器标签的「更多操作」与「自适应」视口菜单时，网页区域会闪一帧。根因是内嵌 WebView2 为独立 HWND、恒盖在主 WebView 之上，旧逻辑先显示菜单、再靠 `syncBrowserTab` 的 `setTimeout(0)` 异步隐藏控件，中间隔了一帧，菜单先被网页盖住再露出。改为菜单打开前先发 `BrowserSetVisible(false)` 并等待隐藏完成（150ms 超时兜底）再显示菜单；等待期间用 `browserMenuOpening` 标志堵住轮询的 `syncBrowserTab`，防止控件被重新 Show 出来。
- 工具栏「后退 / 前进 / 刷新 / 用默认浏览器打开 / 更多操作」按钮悬停无提示：`mkBtn` 收了 `title` 参数却没写到按钮上。改为写入 `dataset.tip`，走项目统一的全局 tooltip（非原生 `title`）；视口按钮原本已有提示，不受影响。
- 改动在 `editor-browser-tab.js`，`editor-browser-tab.test.mjs` 补预隐藏与 tooltip 守卫测试，相关 19 例、icon/utility 护栏与 `test:ui-core` 全绿。

### 修复（定时任务弹窗：三个下拉「框中框」）

- 「新建 / 编辑定时任务」弹窗里的「类型 / 权限档 / 目标会话」三个下拉出现双层边框（外层输入框框 + 内层自绘触发器框）。根因是这三个 `createSelect` 传了 `dlg-input ai-settings-input` 输入框外观类，而 `enhanceSelect` 增强时让外层 wrap 继承 select 的全部 class（`settings-select.js`），外观类跟着套到 wrap 上与内层 `.set-select-btn` 叠成两层。改为不传外观类、走工厂默认 `opt-select`（纯布局，边框由内层触发器提供；`.set-select` 的 `border:0/max-width:100%` 后定义会覆盖 `.opt-select` 的边框与 320px 上限，宽度仍与其他输入框对齐）。改动在 `ai-schedule.js`，CSS 与其它文件不动。守卫测试 `ai-schedule-page.test.mjs` 补「增强下拉不得带外观类」断言；该测试与 `npm run build` 均通过。

### 修复（数据表状态条：行高 / 每页行数下拉露出系统原生菜单）

- 数据表标签页状态条底部的「行高：常规」与「500 行」两个下拉是裸原生 `<select>`，展开露出系统白底菜单，与界面其余自绘控件两套外观（违反表单控件硬规范）。根因是这两个下拉创建后从未走 `deps.enhanceSelect` 增强——同域的查询编辑器行数上限下拉是增强过的（`db-query-editor.js`）。现改为首次挂载后调用 `enhanceSelect`（原生 select 仍是值真源、change 照常派发）；同时把 `renderStatus` 从 `statusBar.textContent=''` 整段重建改为只更新独立的状态文本 span——否则重建会把 `enhanceSelect` 用 `sel.after(wrap)` 插入的 `.set-select` 包装层一起清掉，下拉又变回裸原生。改动在 `db-table-grid.js`。
- **验证**：新增 `frontend/test/db/db-table-grid.test.mjs`（2 例，已登记 `npm test` 的 `test:ui-core`）钉住增强接线与「不清空 statusBar」；`npm test` 全量、`npm run build` 通过。

### 修复（应用页面：详情抽屉随列表滚走 + 认知索引列表分页）

- **详情抽屉不再随列表滚走**：应用页面标签（认知索引 / 补丁库等）的详情抽屉原挂在会滚动的 `.apppage-pane` 里，而抽屉是 `position:absolute; top/bottom:0`——absolute 的包含块就是滚动内容本身，滚到列表底部时抽屉顶部跟着跑出视口。改为滚动与定位分层：`.apppage-pane` 不再滚动（`overflow:hidden`）只当抽屉定位锚，新增内层 `.apppage-scroll` 承担滚动（`bridge-app-page-view.js` + `style.css`）；抽屉仍挂 pane，即固定在可视区。认知索引 / 补丁库两页的挂载点注释同步说明。
- **认知索引列表加前端分页**：原先 205 条路径一次性铺开、无分页；现对齐补丁库做前端分页（每页 30 条 + 「共 N 条 · 第 x/y 页」页脚与上一页/下一页），概览与搜索结果共用，切换搜索 / chips / 刷新时页码归 1。改动在 `ai-cognition-page.js`，页脚复用 `.ap-patch-foot` 视觉（新增 `.cog-page-foot` 间距）。
- **验证**：`ai-cognition-page.test.mjs` / `patch-store-page.test.mjs` 补分页与定位层守卫；两组 15 例全绿，`npm test` 全量、`npm run build` 通过。

### 修复（欢迎页状态栏：关掉标签后残留「全文 X 字 / 缩放」）

- 关掉最后一个标签回到欢迎页后，状态栏仍挂着上一个文件的「全文 4058 字」与缩放「1:1」。根因是 `showWelcome`（`editor-groups.js`）只清了 `stMode/stSize/stEol/stEnc`，漏了 `stCount`（字数）、`stZoom`（缩放）、`stPos`（光标位置）——这三项只在有文档时由 `updateStatus`/`updateWordCount` 更新，漏清就一直残留（网页标签分支已在 `updateStatus` 清过，只有欢迎页路径漏了）。现补齐清理，`stCount` 另显式 `display:none`（无 `:empty` 隐藏规则）。新增守卫测试 `welcome-status-clear.test.mjs` 并登记进 `npm test`。

### 改进（欢迎页：打开文件夹 / 打开文件并排按钮）

- 欢迎页底部原先只有一个「打开文件 (Ctrl+O)」按钮；现改为并排两个按钮——「打开文件夹」（次要样式，走 `openFolderDialog`）与「打开文件」（主样式，走 `openDialog`），文案去掉 Ctrl+O 快捷键提示。改动落在 `index.html`（`.welcome-actions` 容器 + 两个按钮）、`main.js`（新增 `btnWelcomeFolder` 引用与点击绑定）、`style.css`（`.welcome-actions` 横向 flex 布局）。

### 改进（AI 快捷操作菜单：分组与更多入口）

- **tooltip 改为「快捷操作」**：AI 面板头部 Git 按钮（`#ai-git`）的提示文案从「Git 操作」改为「快捷操作」，菜单不再只是 Git 专属。
- **菜单加「其他操作」分组**：新增 `OTHER_ACTIONS`（`ai-git.js`）——「维护认知索引」（仅 `aiCognition` 开关打开时显示）与「生成更新日志」，与原有 4 个 Git 动作之间用分隔线 + 不可点击的「其他操作」分组标题隔开；该分组仅在其下有可见项时才出现。新增的提示词走与 Git 动作相同的会话 / 权限 / 生成中门禁，但不打 Git 写命令豁免令牌。菜单组件（`contextmenu.js`）新增 `heading` 项类型承载分组标题。
- **验证**：`ai-git.test.mjs` 补动作表 / 图标注册 / 两个新提示词断言；`npm test` 与 `npm run build` 全通过。

### 改进（提交面板：图标显示与回滚入口收拢）

- **修好标题栏空白图标**：提交面板标题栏的「刷新」「最近提交」两个按钮原先在 HTML 里留空、无人注水，实际显示为空白（`index.html`）；现统一在 `terminal-ui.js` 用 `iconSvg()` 从注册表注入 `refresh` / `history` 图标。
- **回滚收进「...」菜单，去掉重复刷新**：原先分支名一行并排「回滚↶」和「刷新⟳」两个图标，回滚太显眼易误触、刷新又与标题栏重复。现标题栏刷新右侧新增「...」（`more` 图标），点开弹出菜单承载「回滚全部更改」——仍走统一的 `openConfirmDialog` danger 二次确认；分支行不再放这两个按钮。复用了现有 `ctxMenu` 实例与确认弹窗，未造新轮子。

### 改进（session_list 目录文案与过滤参数）

- **session_list 目录文案与过滤能力**：目录文案（`AI_TOOL_CATALOG`）原与 `session_send` 共用「会话间投递」，看不出它其实是只读的「列会话 / 取 id」入口；改为「列本窗口可投递的会话（id/标题/状态），给 session_send / session_read 拿 id；支持按状态/未读/标题过滤」。新增三个过滤参数 `state`（idle / streaming / compacting）、`unreadOnly`、`titleContains`（不区分大小写），过滤逻辑落在 `listSessionsForSend`（`sessionListText` 与投递选择器共用，UI 不传新参数故行为不变），多条件取交集、非法 `state` 当不过滤，空结果给明确提示。新增一条表驱动测试；相关 59 例全绿。

### 修复（AI 面板：diff 完整性 / 信箱范围 / 消息卡片切换）

- **diff 预览完整显示改动行**：`buildDiffPreview`（`ai-diff-view.js`）原按 ops 顺序累计到 40 行上限就 `break`，导致排在后面的 `+` 行被整段吞掉（+28 −37 的审批卡只见红色 − 行、看不到任何 + 行）。改为行数上限只裁未改动的上下文行，`+/-` 改动行一律保留、超限时跳过上下文继续往后走；`truncated` 语义不变。新增两条回归测试（末尾 + 行不被吞 / 超限时改动行仍全留），`ai-diff-view.test.mjs` 全绿。
- **信箱胶囊只显示当前会话**：角标计数与弹层列表原走 `listPending()` 枚举所有会话（含后台会话）的待注入通知，与用户预期不符。改为经 `pendingMailboxGroups()` 按当前会话 id 过滤，切会话时随 `syncActiveSessionUI` 重算；别的会话通知切到那个会话才看得到。信箱模块自身的全局枚举语义与测试未动。
- **未展开的消息卡片不显示「查看渲染/查看原文」**：结论型应用消息卡片的视图切换按钮原无条件渲染，但收起态正文 hidden、点了无反馈。改为按钮随卡片展开/收起同步显隐。
- **AI 头部胶囊稳定居中**：标题行原用 `justify-content: space-between`（`style.css`），中间的智能体团队 / 终端胶囊只在左右等宽时才居中，会话标题一长就明显偏左。改为会话标题与右侧操作组各占 `flex:1 1 0`，中间胶囊组相对面板稳定居中（长/短标题均验证）。
- **思考链不再显示「正在生成可视化…」**：`renderThinkBody` 原把思考内容交给通用 `renderMarkdown`，而后者带 `aiWidgets` 开关，思考里 AI 随手写的 ```svg / ```html 围栏被当成可视化卡片、挂上「正在生成可视化…」占位；但卡片 mount 只针对最终回答，思考里的占位永远挂不上，一直卡着。给注入的 `renderMarkdown` 加可选 `opts.widgets=false`（`main.js`），思考链调用时关闭 widget，围栏按普通高亮代码块显示；其它回答场景不受影响。

### 功能（Maven 工具窗口）

- **侧栏 Maven 面板**：打开 Maven 项目且本机扫到 Maven 时，左侧工具条自动出现 Maven 图标（触发判定 = 工作区 pom.xml 探测 + 工具链缓存惰性扫描，非 Maven 用户不显示，重算挂在工作区切换 / 手动刷新上）。面板树形展示配置文件（pom.xml / `~/.m2/settings.xml`，点击在编辑区打开）、项目与子模块（读 `<modules>`，限深 4 层递归，`${...}` 占位模块跳过）、每个项目的九个标准生命周期目标；子模块按 `-pl <模块路径>` 执行。点目标直接在「运行」面板起会话（新增 `runCommand` 入口，继承只读拒绝 / 并发上限 / 超时杀树，按 `maven` 首次确认；mvn 经 `cmd.exe /c` 包装，沿用 bat/cmd 配方同一约定）。
- **依赖 / 插件 / 仓库惰加载与执行开关**：「依赖项」「插件」「仓库」三组节点展开时起 `mvn dependency:tree` / `help:effective-pom` / `help:effective-settings`（Go 侧输出写临时文件绕开 `[INFO]` 噪声，前端 fast-xml-parser / 纯函数解析；4 MB 输出上限；失败提示可重试）；依赖 / 插件 / 仓库节点点击复制坐标或 URL。工具条「执行目标…」弹窗（overlay-stack 注册）跑任意 goal，词元按 argv 传递并拒绝 cmd 元字符；执行开关（离线 `-o` / 跳过测试 `-DskipTests` / 强制更新快照 `-U` / 精简进度 `-ntp`）存 `settings.mavenFlags` 偏好键，走 `persistSettingsLight` 通道。
- **后端**：`internal/runproject` 标记表加 `pom.xml`（pyproject 之后、Makefile 之前；`Detect` 兜底文案同步）——Maven 项目 F5 不给候选命令、改提示走 Maven 工具窗口；新增 `internal/mavenproject`（pom 结构纯文件读取 + 数据命令统一通道，`cmdwrap_windows/other` 平台成对）与根壳绑定 `MavenProjectInfo` / `MavenData`；`dev/mock-backend.js` 补同名 mock。
- **验证**：`internal/runproject`、`internal/mavenproject` 表驱动测试（含 fake mvn.cmd 打通「cmd 包装 + 临时文件 + 读回」链路）全绿；新增 `frontend/test/maven/maven-model.test.mjs`（15 例，登记 `npm test` 新分组 `test:maven`）覆盖开关 / 命令拼装 / 依赖树缩进解析 / effective-pom / effective-settings 解析；`npm test` 全量、`npm run build`、`go build ./...`、`go vet` 改动面、`tools/check-crossbuild.cmd`（linux/darwin 三目标）全通过。方案见 `docs/finished-plans/maven-tool-window.md`。

### 功能（应用页面：认知索引）

- **认知索引浏览页**：开启认知索引（设置 → AI → 上下文与记忆）后，「应用页面」出现「认知索引」标签页，浏览工作区 `.cadt/cognition/` 卷——路径地图（目录 / 文件 + 标签）、条目详情（职责 F / 强关联 R / 对外契约 A / 暗约束 S，抽屉展示 + 复制条目）、FRAS 关键词搜索（走后端 query 过滤，命中超预算时提示收窄）、治理状态条（scene、条目 / 字节与预算占比、drift 四态徽标、卷指纹复制）。页面只读，卷仍只能经 AI 的 `cognition_edit` 以 CAS 写。关闭开关后入口消失（已开标签仍可看），跨窗口开关同步即时生效。
- **APP_PAGES 第一个条件可见页**：`AppPage` 新增可选 `visibleWhen`（settings 布尔键），`appPageGroups(settings)` 作为四个入口（侧栏面板 / 两个菜单 / 设置目录）的统一过滤漏斗；`appPageOf` 不过滤（已开标签的图标 / 标题 resolve 依赖它）。开关翻转由 `settings-changed` 订阅驱动侧栏与已开标签的定向刷新。后续条件页照此办理。
- **后端**：`CognitionRead` 的 entries 模式新增 `hitCount` / `hitEntries` 结构化返回（与模型文本同一 rune 预算口径，模型看的 `Text` 不变），页面不再解析文本行格式；`dev/mock-backend.js` 的认知卷改为 3 条样例条目（dev 下页面有东西可看）。
- **验证**：新增 `frontend/test/ai/ai-cognition-page.test.mjs`（9 例，已登记 `npm test`）钉住注册表 / 过滤矩阵 / 挂载器 / 入口传参 / 翻转刷新 / 页面契约；`internal/cognition/service_test.go` 补结构化命中断言；`go test ./internal/cognition/`、`go build ./...`、`npm run test:ai` / `test:ui-shell` 全绿。方案见 `docs/finished-plans/cognition-app-page.md`。

### 功能（AI 群聊第四模式：接力流水线）

- **接力模式**：新建群聊可选「接力流水线」——成员按勾选顺序（行上 ▲▼ 可调序）组成链，发条需求即从第 1 棒开工；每棒完成产出后在回复末尾写「【交棒】」才交给下一棒（没写会被重唤续写，到顶系统代为推进），后面的成员对前面的产出有疑问时 @ 前棒回问（前棒只回答不交棒，答完回到提问者继续，每棒至多回问 2 次）。链完整跑完自动由链尾成员产出成果纪要卡片（可复制 / 导出 / 带回 AI 会话）；运行中可暂停 / 继续 / 结束并总结 / 从断点续跑 / 再跑一遍；运行中的插话会在下一棒生效。工具栏显示「接力中 · 第 k/M 棒 · 名字」，时间线按棒次分隔，气泡不显示交棒标记（只留给引擎判读）。AI 代建群（app_control create_group）同步支持 `mode: relay`（按 members 顺序成链）。方案见 `docs/finished-plans/ai-group-chat.md` §19。
- **验证**：新增 `frontend/test/ai/ai-group-relay.test.mjs`（12 例，已登记 `npm test`）覆盖链序调度、声明交棒、回问闭环与上限、插话注入、中断与断点续跑、自动纪要；群聊域测试 88 例全绿 + Vite 构建通过。

### 改进（防重复机制：通用能力清单 + 两道护栏）

- **通用能力清单**：新增 `docs/core-capabilities.md`——一张表列出 core 已有的通用能力（转义/格式化/图标/控件/弹层/定位/DOM/id/JSON/KV/剪贴板）、各自唯一来源、何时用、禁止的重复形态，并逐条说明「语义相近但不算重复」的例外（XML 转义、插件上下文、图表 SVG 等）。写新工具函数前先查此表。AGENTS.md 前端侧新增「通用工具函数硬规范」与弹层规范的外点关闭/定位口径。
- **两道护栏**（均登记 `npm test`，基线按文件只减不增、新文件出现即红）：
  - `test/core/utility-duplication-guard.test.mjs`：抓 `escapeHtml` / `formatBytes` 在业务模块里的完整重写（委托包装与第三方属性调用不误报；XML/插件/图表转义进豁免并写明原因）。
  - `test/core/outside-click-guard.test.mjs`：抓 document 级 `pointerdown`/`mousedown` 外点关闭监听，引导走 `overlayStack.open({closeOnOutsideClick, anchors})`（面板内自管等存量进白名单）。
- 目的：把「通用能力埋进业务模块 / 重复造轮子」从「靠人记得」变成「机制兜底」——延续项目已有的 icon-guard / overlay-esc-guard / form-controls-factory 护栏模式。
- **验证**：两道护栏自身 + 清单守卫 9 例全绿；全量 `npm test`（1474/637/485/17）与 `npm run build` 通过。

### 改进（代码收敛：通用小工具下沉 core + Go 原子写/文案统一）

- **DOM / ID / JSON / KV / 剪贴板五个 core 模块**：新增 `core/dom.js`（`el`/`btn`）、`core/id.js`（`newId`/`randomIdSuffix`）、`core/json-safe.js`（`parseJson`）、`core/kv-store.js`（`kvGet`/`kvSet`/`kvGetJson`/`kvSetJson`/`kvRemove`，只统一读写不抛、不认识业务 key）、`core/clipboard.js`（`copyTextToClipboard`，先 Go 绑定后 Web API 降级）。约 60 个文件里的局部实现替换为这五个模块；各模块配测试并登记 `npm test`。`settings` 三条同步通道未动（`settings-ui.js` 的 `localStorage.setItem(settingsKey…)` 仍是唯一出口）。
- **Go 原子写与文案统一**：`convert_cli.go`、`internal/aigen/aigen.go` 的用户可见产物写盘从 `os.WriteFile` 改为 `atomfile.WriteFileAtomic`（保留 0o644）；`internal/appdata` 新增导出 `ErrNoRoot`，12 个文件 20 处「无法定位应用数据目录」字面量改为引用它（可用 `errors.Is` 判定），新增 `internal/appdata/appdata_test.go`。
- **验证**：`npm test` 三段、`npm run build`、`go build ./...`、`go test ./... -timeout 300s`、`tools/check-crossbuild.ps1`（linux/darwin 三目标）全通过。

### 改进（代码收敛续：#3 文件管理器定位下沉 + #4 弹层外点关闭/锚点定位）

- **#3 文件管理器定位下沉**：`internal/shellexec` 新增 `RevealInFolder`（Windows 走 `explorer.exe` 并 `executil.HideCommandWindow`，非 Windows 桩报错）；`app_window.go` 的 `ShowInFolder` 只留校验后转发，删除裸写的 `exec.Command("explorer.exe", ...)` 与 `explorerArgs`。测试迁到 `internal/shellexec/shellexec_test.go`（`//go:build windows`）；`crossplatform_guard_test.go` 增加「`"explorer.exe"` 只许出现在 Windows 文件」规则，防止以后再在平台无关文件里手写。验证：`go build ./...`、`go test`、`tools/check-crossbuild.ps1`（linux/darwin 三目标）全通过。
- **#4 弹层基础设施**：新增 `core/popover-position.js` 的 `placePopover(el, anchor, {placement, align, gap, margin})`（视口钳制 + 自动翻上方）；`core/overlay-stack.js` 的 `open()` 新增 `closeOnOutsideClick` + `anchors`（共享 document `pointerdown` 捕获，只看栈顶活层，打开当帧跳过）。已迁移 `shell/message-center.js`（定位 + 外点关闭）、`shell/titlebar-popovers.js`（定位），以及 AI 的 `ai/ai-model-picker.js`、`ai/ai-agent-settings.js`（分组建议）、`ai/ai-usage-ui.js`（用量弹层）、`ai/ai-panel.js`（模型列表弹层）的外点关闭（删除各自自挂的 document 监听与 dismiss 句柄）。其余站点（AI 用量弹层、提醒、设置下拉、阅读、编辑器菜单等）按同一范式待迁移，清单见 `docs/unfinished-plans/code-consolidation-followups.md`。
- **验证**：新增 `test/core/popover-position.test.mjs`，`test/core/overlay-stack.test.mjs` 补外点关闭用例（均已登记 `npm test`）；`npm run build` 通过。

### 改进（代码收敛：HTML 转义与大小/时间格式化统一到 core）

- **HTML 转义**：新增 `core/escape.js` 的 `escapeHtml`（`& < > " '` 五实体全转）作唯一来源，替换 ai / settings / bridge / reading 六处同名实现。其中 `bridge/bridge-memo-view.js`、`reading/reading-render.js`、`reading/reading.js` 三处此前只转 `& < > "`、**漏转单引号**，拼进 `innerHTML` 属性上下文时可被逃逸——本次一并修掉。`core/widget.js` 的 `escapeWidgetText` 改为委托同一实现（保留旧名）。
- **字节与时间格式化**：新增零依赖 `core/humanize.js`（`formatBytes(n,{compact})` / `formatFullTime` / `relativeTime`）。合并存储页与工作区防护两份逐字符相同的 `formatBytes`、AI 域 `aiFormatBytes`、`ai-file-tools` 的 `humanSizeBytes`（紧凑口径）、`ai-external-tools` 的私有 `formatBytes`；相对时间合并 `app-pages/ui-kit.js`（改为 re-export）与 `ai-group-sidebar` / `ai-settings-dialog` 的局部实现。附带修正：群聊列表与 AI 设置里的长旧时间不再显示 `toLocaleDateString()` / 无上限「N 天前」，统一回退完整时间。`shell/message-center.js` 保留其面板专用的 `MM-DD HH:mm` 紧凑格式（有意差异）。
- **跟随项**：审查里需单独方案的两项已落到 `docs/unfinished-plans/code-consolidation-followups.md`（#3 `ShowInFolder` 手写 `explorer.exe` 下沉 `internal/shellexec`；#4 弹层外点关闭 / 锚点定位并入 `core/overlay-stack.js`），本轮未动其代码。
- **验证**：新增 `test/core/escape.test.mjs`、`test/core/humanize.test.mjs`（均已登记 `npm test`）；全量前端测试通过、`npm run build` 通过。

### 改进（「智能体」迁为应用页面标签页）

- **定位**：设置 → AI → 智能体 实为群聊成员的管理面板（实体 CRUD + 编辑器弹窗），在设置体系里本就语义错位——零可写设置行（唯一按钮行被判 `action` 不可写、动态列表不进树）、数据在 ai-config.json 不走设置三条同步通道、AI 对它走 `get_agents` / `create_agent` 专属动作而非 `set_setting_row`。与外部工具迁移同一论证：实体管理面板归应用页面，可写偏好行（子代理上限 / 注入开关 / 权限）归设置。第 6 个应用页面，归 AI 组（与外部工具同组）。
- **迁移形态（外部工具先例）**：`core/app-pages.js` 登记 `agents` 条目，侧栏面板 / 菜单 / 命令面板 / 设置目录页四个入口与 AI 上下文描述自动派生；pane DOM 常驻 `index.html` 尾部 `#agents-park` 停靠区（必须在 `#dlg-settings` 之外，防 buildSettingsTree 误索引），`ai-agent-settings.js` 的 `mountAgentsPane` 搬进 / 搬出标签页容器保持节点身份——本模块创建期按 id 捕获 `agents-list` / `ai-agent-create`，编辑器中间态与分组折叠记忆在模块闭包里，不能重建 DOM；pane 改用 `.agents-root` 节奏类（flex+gap 沿用设置 pane），不再带 `.settings-pane` 类（settings-tree / settings-search 不再扫到）。
- **三级桥（定时任务先例）**：`ai-settings-dialog` 转发 `mountAgentsPane` / `refreshAgentsPane` → `ai-panel` 暴露 `bridgeMountAgents` / `bridgeRefreshAgents` → `main.js` 的 `appPageMounters` 登记（`bridgeMountSchedules` 同款惰性桥）。
- **挂载器面板兜底（审查修正）**：AI 面板是惰性初始化的——用户没碰过 AI 面板就点开智能体 / 定时任务页时，挂载器先 `initAIPanel()` 幂等兜底再走桥；此前定时任务挂载器裸读 `aiPanel`，该场景得到空白标签页且再激活不自愈（存量问题，本次一并修），两个页面测试各加一枚兜底钉子。
- **反馈通道**：保存 / 删除提示从设置窗状态条换全局 flash——标签页场景设置窗多半没开，往里写状态等于写空气。
- **设置侧摘除**：设置导航删除「智能体」子页；settings-ui 的 AI 组展开与 refreshSettings 触发列表去掉 `agents`；`refreshSettingsPane` 里的列表渲染保留为幂等兜底（pane 在停靠区时不可见）。
- **群聊接线**：新建群聊弹窗左下角齿轮改 `openAppPageTab('agents')`——原语义本就「先弃草态、关弹窗、再跳」（离开建群流程去备成员），迁移完全等价且不引入新的状态丢失；空群提示 / 创建默认主持人反馈 / 齿轮 tip 统一「应用页面 → 智能体」。
- **AI 侧（只改文案）**：`open_settings` 的 pane 枚举去掉 `agents`（设置窗不再有它）并在指引句补「应用页面 → 智能体」；`create_agent` 描述里修改 / 删除归属与返回 note 换新口径；`create_agent` 落盘后标签开着即时重绘（`saveAIConfig` 不广播，判法同 `schedules-changed` 订阅先例）。动作名一个不变，`APP_ACTIONS` / `runAppAction` / `UNDOCUMENTED` 零改动。
- **不变**：agents[] 数据模型（ai-agent-model.js）、`aiGroupApi` 契约、AI 工具表零改动。
- **验证**：新增 `frontend/test/settings/agents-page.test.mjs` 守卫 10 例 + `ai-schedule-page.test.mjs` 补挂载器兜底钉子（均已登记 `npm test`）；子代理只读审查全项通过（唯一 P1 即上面的面板兜底，修复后复验）；全量前端测试通过；`npm run build` 通过；顺带清掉 README 里外部工具 / 使用统计两处上轮迁移的旧路径欠账。

### 修复（工作区搜索撞上二进制毒行导致整窗闪退）

- **现象**：打开软件后做一次工作区全局搜索（大小写不敏感），进程无任何报错直接退出（用户感知「闪退」）；事件查看器无记录——Go panic 直接 `exit(2)`，不经过 WER。panic 全文 `slice bounds out of range [:40] with length 37`，出现在 `internal/search` 扫描 worker。
- **根因**：`findMatches` 字面量大小写不敏感模式在 `strings.ToLower(line)` 的**降写副本**上找命中、却把字节区间套回**原行**切片；而 Go 的 `ToLower` 不保长——非法 UTF-8 字节逐个替换成 3 字节 U+FFFD（+2/个），`Ⱥ`(U+023A)/`Ⱦ`(U+023E) 小写 2→3 字节。触发文件是 `.cadt/tmp/webview-inspect` 下 WebView2 的「Subresource Filter」二进制规则文件：无扩展名绕过二进制扩展名表、前 8KB 无 NUL 绕过 NUL 预检，行内两个非法字节把 37 字节的行膨胀到 41 字节，行尾命中区间 [35,40) 切原行即越界。与 `code-bug-hunt-2026-11-18` 修过的 `sessionindex.makeSearchSnippet` 同款模式，当时漏了 search.go。
- **修复**：`findMatches` 检测降写后长度漂移（`len(haystack) != len(line)`），漂移时放弃降写快路径，改在原行上逐 rune 折叠匹配（新增 `foldFindFrom`/`foldMatchAt`，口径与「两侧各自 ToLower 再比对」一致，区间永远对原行有效，且修正了变短字符导致的错位高亮）；`scanSearchFile.appendHit` 对 start/end 按原行收口兜底——将来任何上游给出越界偏移只损一条预览，不再 panic 掉整个进程。
- **验证**：回归测试 4 组（闪退原行 / 多命中落位 / Ⱥ 变长 / KELVIN 变短）+ wholeWord 边界 + 大小写敏感不受影响 + 端到端 `SearchWorkspace` 扫毒行不 panic，全部落 `search_test.go`；旧实现下这些用例分别越界红 / 进程 panic 红。设计取舍：`.cadt` 不加进跳过名单——`SkipPath` 注释明确 `.cadt/tmp` 要对 glob/list_dir 保持可见（探针沙箱约定），根修后毒行本身无害。

### 改进（崩溃自愈：异常退出后下次启动自动清缓存 + 删工作区 tmp）

- **背景**：上面这条闪退的触发文件躺在工作区 `.cadt/tmp` 里——崩溃清不掉它，下次一搜再崩。新增兜底：检测到上次异常退出，本次启动自动执行一轮「清除缓存」，把脏状态在用户碰到之前收掉。事故与取证见 `docs/reports/incident-2026-11-23-search-panic-crash.md`。
- **崩溃检测**（`internal/crashrecovery`）：GUI 会话启动时在 `appdata/session-alive/` 写「活着」标记（按会话一文件：多实例 / 调试控制台各有各的文件，互不覆盖），优雅退出摘除；异常退出遗留，下次启动属主进程已不在 = 上次崩溃（Windows `OpenProcess` 探活，`_windows/_other` 成对）。
- **自愈清理**（根壳 `crashrecovery_app.go`）：复用 `storage` 条目表分两段——app 段（run-temp / session-index / ai-logs 等）在启动空档直清，webview-cache 转 pending 由 `ApplyPending` 本轮收口；工作区段（`ws-worklog` / `ws-tmp`）等 `WindowRegister` 登记根目录后清（`WorkspaceCacheIDs()` 从同一张表派生）。全程写运行日志，warn 级别的「检测到上次会话异常退出」是本次自愈的标志。
- **时序护栏**：检测与标记只发生在 `application.New` 之后——转发进程在 New 里就 os.Exit，不能抢走遗留标记去清理运行中主实例正占用的缓存（`applyPendingStorageCleanup` 因此一并挪到 New 之后，转发进程也不再抢跑 pending 清理）。
- **不碰的边界**：`ws-scratch`（用户亲手写的临时文件）、wipe-guard 备份、会话正文等数据段条目一律不进自愈范围（`storage_test.go` 负向断言照旧）；自愈是缓存级自愈，不是数据重置。
- **验证**：`crashrecovery` 包测试（属主死亡取走 / 存活保留 / 只摘自己 / 残缺标记新生保留老化清 / 空根 no-op）+ `storage` 的 `TestWorkspaceCacheIDs` 快照；`go build ./...` 与 `tools/check-crossbuild.cmd` 通过。

### 改进（CLI 启动参数收口：--help/--version、转发路径修正与按工作区路由）

- **顶层 `--help` / `--version`**：新增 `--help/-h` 打印全部启动参数（GUI 开关 + `--convert` / `--check-patch` 等 headless 子命令用法，`cliUsageText()` 三段拼接）；`--version/-v` 打印版本号。此前一半开关（`--open-settings` / `--ai-session` / `--quit` / `--ai-float` / `--debug-console` 等）是「读源码才知道」的隐藏知识。护栏 `cli_help_guard_test.go` 对源码开关字面量与 help 文本双向对账，以后加开关漏写 help 直接红；`convertcli` 原 `--help` 死分支删除（避免两份 help 漂移），patchcli 用法从文件头注释正式化为 `Usage` 常量。
- **不存在的路径不再静默丢弃**：`datalens.exe 打错的路径.json` 此前什么都不发生（欢迎页），现在照常进打开目标并提示「打开失败」——agent 调用打错路径拿得到失败信号；`路径:行` 拆分在目标不存在时仍保住行号语义（报错是干净文件名）。v2 时代遗留的 `PathArgs`/`FirstPathArg` 死代码一并清理。
- **`--ai-session` 转发修正**：单独传参会话 id 此前被丢弃、还把调用方 CWD 兜底成打开目标误投主窗口（可能误切运行中窗口的工作区）；现在解析会话归属工作区（`sessionstore.ResolveSessionWorkspace`，按 id 扫桶 + meta.workspace 真源，meta 缺失从正文 header 兜底）走「同工作区复用 + 前置 + 切会话」语义。`--ai-session` + 文件转发到已有窗口时会话不再静默丢失（归属工作区与接收窗口一致时补投，不一致记 warn）。
- **多窗口文件投递按工作区路由**：文件属于某个已开主窗口的工作区 → 标签页开在**那个窗口**（祖先链逐级向上与已登记工作区键精确匹配取最深命中，嵌套工作区内层窗口拿子目录文件）；无归属投主窗口——此前一律投最早的主窗口，跨工作区错位。目录目标不路由（维持原逻辑）。
- **`--open-settings` / `--memo` 与文件参数组合转发**：文件目标随定点事件一起投给主窗口，不再被定点分支吞掉（回退浮窗时仍不投文件）。
- **实现**：secondInstance 决策与执行分离——纯函数 `secondInstancePlan`（依赖注入，表驱动测试 `secondinstance_plan_test.go`）+ 窗口 API 执行层；移除 `OpenMode()=="window"` 死分支（2026-11-21 已把 window 归一回 tab）。README 命令行节、AGENTS.md 命令行能力节、帮助-教程（`docs/tutorial.md` 第 5 节）、agent 技能（SKILL.md + reference/cli.md）五处同步，并把本机已注册的全局 skill 副本（`~/.agents` / `~/.claude`）按注册逻辑刷新到新内容；方案与落地记录见 `docs/finished-plans/cli-startup-args-refresh.md`。

### 修复（斜杠补全的方向键选中不跟随滚动）

- **现象**：输入 `/` 打开补全列表后按 ↑/↓ 移动高亮，选中项一离开首屏就沉到可视区外（列表不再跟着滚），只能盲按。
- **根因**：方向键分支走的是 `updateSlash()` → `renderSlash()`，每次移动都 `innerHTML = ''` 重建整张列表，滚动容器的 `scrollTop` 随重建归零；高亮项按新 index 渲染在首屏之外。
- **修复**：`ai-slash.js` 新增 `moveSlashSelection(delta)` 与内部 `syncSelectedClass()` / `scrollSelectedIntoView()`——方向键只切 `.selected` 类、由 `.ai-slash` 容器自己按 `slashScrollDelta`（纯函数，口径同 `explorer.js` 的 nearest）滚够让选中行露出来，不再重建列表；`renderSlash()` 末尾也补一次跟随（过滤条件变化导致 index 被 clamp、或刚用滚轮停在半途时同样归位）。`ai-composer.js` 的方向键分支改走新出口，`ai-panel.js` 接线。
- **验证**：`ai-slash.test.mjs` 新增 `slashScrollDelta` 用例；dev 模式实测 35 项列表（可视 219px / 内容 900px）连按 ↓ 10 次 index 到 10 时 `scrollTop=58`、选中行落在可视区底部，连按 ↑ 回到 index 0 时滚回顶部；`npm run build` 通过。

### 修复（三路子代理审查后的整改：1 阻断 + 3 高 + 多处中低）

派 Go / 前端 / Python 三个只读子代理交叉审查本次改动，逐条整改并补回归：

- **阻断（Python B1）**：`Snapshot(window=…)` / `Find(window=…)` 在默认不传 `region` 时必抛 `TypeError: 'int' object is not callable` —— `target.bounding_box` 是 `BoundingBox`（`width/height` 是 int 字段），却被传给期望 `uia.Rect`（`width()/height()` 是方法）的 `_rect_to_bounding_box()`。改为显式 `uia.Rect(box.left, box.top, box.right, box.bottom)`，截图区域直接用 `BoundingBox`。**实测：修复前必崩，修复后 `Snapshot(window='CaDt')` 正常返回。**
- **高（Python H1）**：`Find` 的 `activate_element` 原来靠「窗口名 != 前台窗口名」决定点两次 —— 对 toggle 控件（复选框/开关）会翻两次，对任务栏图标等于启动后立刻最小化。改用上游已有的 `bring_window_to_top(handle)`（它处理了 AttachThreadInput / AllowSetForegroundWindow）先真正激活窗口，再**只点一次**；任务栏/桌面等 shell 窗口跳过激活。
- **高（Go H1）**：`EnsureServerWheel` 自愈补的是「当前版本路径」，而 spawn 执行的是 `cfg.Args` 里的路径 —— 版本升级后 mcp.json 仍指旧目录时，旧 wheel 被清理删掉依然起不来。改为按**配置里实际指向的路径**补文件（`ourWheelPath` 解析 `--from`），并加 `testRootOverride` 注入临时根的真实写盘用例；前端 `desktopConfigNeedsUpgrade(row, plan)` 增加版本比对，引导用户「更新配置」。
- **高（前端 H1/H2）**：① 安装进行中开关未禁用，用户可把开关关掉导致「已安装但禁用」且作业照跑 —— 改为安装期禁用；② `setDesktopEnabled` / `startDesktopInstall` / `setDesktopToolEnabled` 三处都是「内存快照整文件覆盖 mcp.json」，会冲掉本页停留期间从 MCP 列表增删的其它 server —— 新增 `freshConfig()` 写前重读 + `writeDesktopRow()` 只替换 windows 行。
- **中（Go M1/M2/M3）**：① `runStreaming` 的 `onLine` 在锁外被两条扫描 goroutine 并发调用，消费者的 `last`/`percent` 无锁 → 移进临界区（并用 atomic 断言回调不并发）；② 预热阶段节流写了 `&& percent < 95`，导致 95% 之后每行都 emit，与 `splitAnyLine` 把 `\r` 切成上千行叠加会打满 WebView2 IPC → 去掉该条件；③ `desktopmcp.Logf = mcp.Logf` 在 init 中取值过早（本文件字典序早于 `mcp_app.go`）会永久捕获 nil → 改为转发闭包。
- **中（前端 M1 / Python M2/M3 / 自查）**：`startDesktopInstall` 的双击守卫移到第一次 `await` 之前（`installStarting`）；`window` 与 `use_ui_tree=False` 同用改为报错而非静默忽略；打包脚本把 `.dist-info` 目录名一并改成 `windows_mcp-0.8.9+p3.dist-info`（PEP 427/376），并把 `Embedded` 未注入时的 `fs.ReadFile(nil,…)` panic 改成返回错误。
- **测试修正**：前端升级判定用例里「缺 `--no-control`」与「缺 `--from`」原本用了同一组 args（实际只测到后者），已拆分并补「`--from` 指向旧版本」用例。
- **验证**：Go 9 用例（含真实写盘自愈、并发回调不串行断言）、前端 **485 测试**、`go build`、三平台交叉编译全通过；端到端起真实 server 复核 —— 22 工具含 `Find`、`Snapshot(window=…)` 不崩、`use_ui_tree=False` 正确报错、`Find(window=…)` 返回真实元素。

### 改进（桌面控制补丁升到 `0.8.9+p3`：Type 免坐标 + 新增 Find 工具）

- **`Type` 可以不给坐标**：`loc` / `label` 都省略时直接往**当前焦点**输入（`desktop.type_focused`）。此前地址栏已 `Ctrl+L` 聚焦却必须先把文本写进剪贴板再 `Ctrl+V`——多两步往返，还污染用户剪贴板。实现上把 `type()` 拆成点击 + 共用的 `_type_into()`（caret 定位、清空、长短文本分流、回读逻辑不变）。
- **新增工具 `Find`**：按可见名称定位交互元素并直接操作——`query`（默认子串，可 `exact` / `regex`）+ `action=list|click|type` + `nth` + `window`（复用 +p1 的窗口过滤）+ `limit`。要点头部按钮 / 卡片 / 某一行，不必再先 `Snapshot` 拿编号再 `Click(label=N)`，也不必截图目测坐标。目标位于后台窗口时自动点两次（第一次点击只会激活窗口，Windows 不会把它交给控件）。
- **工具数 21 → 22**：`internal/desktopmcp.AllTools`、前端 `DESKTOP_ALL_TOOLS`、mock 的 `MCPDesktopPlan`、Go 与前端两边清单用例同步；设置页工具开关列表自动多出一行「Find · 按名字找元素并直接点击 / 输入」。
- **不做 CSS selector / CDP（明确取舍）**：Chrome 136 起禁止对默认 `user-data-dir` 开 `--remote-debugging-port`，走 CDP 必须换用户数据目录、丢掉全部登录态。改用「按可见名称匹配 UIA 交互元素」——零依赖、不重启浏览器，覆盖绝大多数点击需求。
- **端到端验证**：起 `+p3` wheel 的真实 MCP server，`tools/list` 返回 22 个工具且含 `Find`（参数 `query/action/text/nth/exact/regex/window/limit`）；`Find(query='CaDt', action='list')` 实际返回桌面元素 `'CaDt-DataLens - 1 个运行窗口' <按钮> at (1644,1404) in '任务栏'`。
- **打包脚本**：`tools/pack-desktop-wheel.py` 支持 overlay 里的**新增文件**（基线没有同名路径时按新增写入并打印），此前只允许覆盖既有路径。

### 改进（桌面控制可客制化：随 exe 分发的 wheel 打了本地补丁 `0.8.9+p1`）

- **能改脚本了**：windows-mcp 从「从 PyPI 现拉、改不了」变成「仓库里带 overlay 的本地补丁版本」。仓库只存**改动的 3 个文件**（`docs/mcp-desktop/overlay/windows_mcp/…`）与未改动的基线 wheel（`vendor/`），`tools/pack-desktop-wheel.py` 把 overlay 覆盖到基线、重算 RECORD、打出 `windows_mcp-0.8.9+p1-py3-none-any.whl`；exe 内嵌的是这个产物。上游升级时把 overlay 重放到新基线即可，diff 可审查；MIT 合规要求（版权/许可/标注已修改）写在 `docs/mcp-desktop/NOTICE.md`。
- **本次补的能力 —— `Snapshot(window=…)`**：按窗口标题正则（不区分大小写）挑出目标窗口，**只对它建树**、并把截图裁到该窗口矩形（显式 `region` 仍优先）。这是实机跑任务踩到的坑：同时开着十几个窗口时，无关窗口的元素会先把元素预算（默认 500 条）吃满，真正想看的窗口被截断，只能反复 `region` 盲猜坐标。改在 `desktop/service.py` 的 `get_state`（新增 `window_filter`）+ 工具层两处透传；不传 `window` 时行为与上游 0.8.9 完全一致。
- **护栏**：`internal/desktopmcp/desktopmcp_test.go` 的工具清单用例对账上游 21 个工具；打包产物 `--help` 与 `inspect.signature(Desktop.get_state)` 实测含 `window_filter`。

### 修复（操作记录：详情钮按条件渲染导致按钮不齐）

- **现象（用户反馈）**：操作记录列表里「详情」钮只有部分行有，复制钮于是在有/无详情钮的行之间左右跳动；把内容区拖窄后更糟——5 列最小宽度装不进容器，按钮被挤出可视区，hover 也看不见。
- **根因**：`activity-pane.js` 里详情钮是条件渲染（`if (detailText || target.length > 32)`），两行结构不同 → `.act-ops` 内部按钮起始位置不同；`.activity-list` 没有横向滚动，grid 的固定列宽（96+56+140+160+104 ≈ 604px）在窄容器里无处可去。
- **修复**：详情钮**每行都渲染**，内容不可截断的行加 `.is-empty` 用 `visibility: hidden` 占位（保留宽度、不参与交互）；`.act-ops` 改 `justify-content: flex-end`，两个按钮在每行都落在同一水平位置；`.activity-list` 改 `width: max-content; min-width: 100%` + `.activity-list-box` 加 `overflow-x: auto`，窄容器改为横向滚动而不是压列。实测四行按钮坐标完全一致（宽容器 1021/1067，窄容器 598/643，各自唯一）。
- **护栏**：`activity-pane.test.mjs` 改断言「每行都占位 + flex-end + visibility 占位」，并禁止回退到「无详情钮时只挂复制钮」的分支。


- **分发形态（2026-11-22 用户裁决）**：windows-mcp **不再由 uvx 从 PyPI 现拉**，改为把 0.8.9 的 wheel（306 KB）内嵌进 exe（`docs/mcp-desktop/windows_mcp-0.8.9-py3-none-any.whl` + `NOTICE.md` 记录 MIT 许可与 sha256）；Python 3.14 解释器与 21 个依赖（约 197 MB）**不内嵌**，首次安装仍由 uv 下载——体积红线不变。好处是代码版本可复现、离线可修、将来给上游打补丁（Snapshot 按窗口过滤等）时随 exe 一起走。
- **开关即安装 + 进度条**：卡片不再有「安装…」按钮。打开「启用桌面控制」若尚未安装，直接写入配置行并起异步安装作业；Go 侧新增 `MCPDesktopInstallStart`（立即返回）+ `MCPDesktopInstallStatus`（重建页面时接回进度），进度经 `mcp-desktop-install` 事件推送（release → uv → warm → done/error，百分比是阶段估算，下载拿不到字节进度），卡片下方画细进度条与上游日志尾行。
- **工具逐项开关（默认全选）**：安装后列出上游**全部 21 个工具**（`internal/desktopmcp.AllTools` 是权威清单），默认全勾，可逐项取消；高风险项（PowerShell / FileSystem / Registry / Process / App / Clipboard / MultiEdit / Notification）在名字旁标「可改系统」。勾选写回 mcp.json 的 `enabledTools`——它是**唯一**的工具可见性闸；`--tools` 参数彻底移除（此前白名单写死在 args 里，用户没法逐项调）。不允许清空：空数组语义是「一个都不给」，server 连进程都不起。
- **实现**：新增 `internal/desktopmcp`（内嵌 wheel 释放 / 配置行 / 安装流程 / 自愈，纯引擎，进度经回调注入）；根壳 `desktop_mcp.go` 做 `go:embed` 与 `mcp.PrepareServer` 的**组合注入**（内置示例脚本 + 内置 wheel 共用一个钩子，此前只能挂一个）；`mcp_desktop_app.go` 只留绑定；删掉旧的 `mcp_desktop_install_windows.go` / `_other.go`（逻辑下沉）。行切分 `splitAnyLine` 放平台无关的 `stream.go`——放 `_windows.go` 会让 linux/darwin 的 `go vet` 编不过（交叉守卫实测抓到）。
- **护栏**：`internal/desktopmcp/desktopmcp_test.go`（21 工具清单完整性 / 配置行 / 自愈识别 / `\r` 行切分 / plan 形状）；`ai-desktop-control.test.mjs` 重写为「结构性旧形态才判升级、用户取消勾选不判脏」+ 内置 wheel 口径；`external-tools-page.test.mjs` 改为断言开关即安装、事件订阅、工具开关接线；`event-scope` 登记 `mcp-desktop-install`。全量前端 470 测试、`go build ./...`、`go vet ./internal/desktopmcp`、`tools/check-crossbuild.ps1`（linux/darwin 三档）全通过。

### 改进（操作记录：展开区补对象全文，复制整条记录，复制钮 hover 显形）

- **行为**：原先「详情」展开区只有参数 JSON，对象列被省略号截断时只能 hover 看 tooltip。现在展开区分两段：`对象`（完整 target，界面字体、可折行）与 `详情`（参数 JSON，等宽、各自 220px 内滚动），中间虚线分隔；展开钮的判定条件是「有参数 或 对象长度 > 32」（超过这个长度基本必然被截断），极短对象行不挂展开钮。
- **复制按钮**：每行都有（2026-11-22 用户要求：无参数、对象又短的行也要能复制），复制**整条记录成一个 JSON**，字段与「导出 JSON」同源：`ts`（毫秒时间戳）+ `time`（可读时间）+ `actor`（user/ai/system）+ `action` + `target` + 有参数时的 `detail`；存储内部字段 `v` / `seq` 与判定来源 `source` 不输出。tip 为「复制整条记录（JSON）」。
- **复制钮 hover 才显形**（用户反馈「每行清一色一个复制图标看着花眼」）：`.activity-row .ap-copy-btn { opacity: 0 }`，`:hover` / `:focus-within`（键盘 Tab）/ `:has(.act-detail:not(.hidden))`（详情已展开）时显形；用 opacity 而不是 display/visibility——占位不变，列宽与对齐零跳动。`@media (hover: none)` 下常显，避免触屏看不见入口。
- **顺带修一个静默覆盖**：`.act-detail` 在 style.css 里有**两处定义**（新规则与旧规则按 `flex-basis:100%` 写的设置页内嵌形态各一处），旧的按源码顺序压掉新的，导致展开区退回 160px 高、文字垂直错位。删掉旧规则，并加护栏「`.act-detail` 只允许一处定义」。
- **列表横向溢出（本轮真正的病灶）**：`.activity-list` 的 `width: max-content` 让行宽等于最长对象内容的固有宽度——AI 工具参数动辄几百字符，于是整张表格比容器宽几百像素，**对象列与右侧「详情 / 复制」全被推出视野**（用户看到的「对象列是空的」其实是整列在视口外）。改为行宽跟容器（`.activity-list` 去掉 max-content）、对象列下限从 `minmax(160px, 2fr)` 改成 `minmax(0, 2fr)`、时间列从固定 96px 改成 `minmax(72px, max-content)`、表头单元格加 `white-space: nowrap`（窄宽时「对象」曾被拆成两行）。超长内容仍走省略号，全文看展开区。
- **dev 可复现**：`dev/mock-backend.js` 补齐 `ActivityRead` / `ActivityAppend` / `ActivityPath` / `ActivityClear` 四个 mock（此前缺失，dev 打开这页永远走「当前版本不支持操作记录」分支），合成 10 条覆盖「有参数 / 长对象 / 短对象」的记录，`?text` 场景下能直接在浏览器里看布局、点展开、点复制、翻页。
- **护栏**：`activity-pane.test.mjs` 新增 5 例（展开区必须有「对象」「详情」两段 + 长对象无参数也要挂钮；复制必须是整条记录 JSON 且含五个字段、不含内部字段；复制钮每行都建、只在末列容器里；hover 显形规则齐全且不得用 display:none；`.activity-list` 不得 max-content + 对象列下限必须 0 + 表头 nowrap；`.act-detail` 单一定义）。

### 修复（定时任务 / 记忆技能对话框的输入框丢失封装外观）

- **现象**：新建定时任务对话框的输入框、多行框看起来「不是封装好的控件」——4px 小圆角、12px 字号、聚焦只有一条 1px 蓝边、没有 hover 反馈，与其它对话框的现代表单不一致。
- **根因**：控件确实走的是 `createInput` / `createTextarea` / `createSelect`，但传的 `className: 'ai-settings-input'` 在 `applyCommon` 里是**整段覆盖**（`control.className = o.className`），默认封装类 `.dlg-input` 被顶掉了；`.ai-settings-input` 只自带 4px 圆角 / 12px 字号 / focus 边框色，缺 `.dlg-input` 的 7px 圆角、12.5px 字号、hover 边框与 3px 外发光。
- **修复**：`ai/ai-schedule.js`（7 处）与 `ai/ai-manage-dialogs.js`（3 处）的 `className` 改为并列 `'dlg-input ai-settings-input'`——`dlg-input` 提供封装外观（在 style.css 里定义更晚，同名属性胜出），`ai-settings-input` 继续提供域内布局（`flex: 0 1 320px`、`.ai-sched-field > .ai-settings-input { flex: 1 }`）；三处下拉增强后 wrap 继承这两个类，触发器外观仍由 `.set-select-btn` 决定。
- **护栏**：`ai-schedule-page.test.mjs` 新增 1 例（编辑器里每个 `className` 都必须包含 `dlg-input`）；`docs/frontend-form-controls.md` 第 4/5 节补「className 是覆盖不是追加」的口径。

### 改进（搜索忽略规则软化：默认规则可 `!` 覆盖 + `search_text` 临时放行参数）

- **行为**：`node_modules` / `.git` / `.venv` 等 14 个默认忽略目录从「硬编码」改为「默认软规则」——先注入默认规则、再叠加用户 `.cadt/config/search-ignore`，故用户写 `!node_modules` 即可永久放行（此前 `!` 只能取反用户自己的规则，动不了硬编码表）。四处检索/展示统一口径：`search_text`、`glob`、目录树 `list_dir`、目录结构导出（后者此前完全不读 search-ignore，现补上）。二进制扩展名、AI 隔离 worktree 仍硬忽略；wipeguard 结构指纹、cognition 索引继续走独立硬编码表（可搜索 ≠ 可索引，防用户配置把安全判定带偏）。新工作区开箱行为与改动前一致。
- **临时放行**：`search_text` 新增可选参数 `includeIgnored`（默认 false）——为 true 时本次搜索放行全部被忽略目录，仅内存生效、不写配置；与 `!` 的「持久化按目录放行」互补。工具描述同步告知 AI 这两个通道（永久改配置 / 本次放行）。
- **实现**：`internal/search/search.go` 新增 `defaultIgnoreNames` 有序表（硬编码 `searchSkipDirs` 由它派生，仅供安全用途），`LoadIgnoreRules` 注入默认规则后再拼用户规则（拼到新 slice、不污染 mtime 缓存实例）；`LoadIgnoreRulesAt` 保持纯解析供 cognition 的 `.cogignore` 复用。检索四处删掉直查硬编码表的分支，统一走 `IgnoreRules`；`SearchOptions` / `searchSpec` 加 `IncludeIgnored`，入口为 true 时 `spec.ignore` 留 nil（nil 的 `shouldSkip` / `globArgs` 安全放行）。前端 `ai-tool-defs.js` / `ai-search-advanced.js` / `ai-panel.js` / mock-backend 四处同步接线。
- **护栏**：`ignore_test.go` 补默认注入 / `!` 覆盖 / `LoadIgnoreRulesAt` 不注入 / IncludeIgnored 放行用例；`ai-search-advanced.test.mjs` 补归一化用例；`ai-tool-wiring.test.mjs` 接线守卫自动核对新参数（描述 ↔ properties ↔ 执行分支）。

### 改进（AI 回复的文件引用支持 `:起-止` 行区间，并修复裸文件名+行号被误判为 URL）

- **行为**：AI 回复里 `code.ai-tool-defs.js:65-84` 这类带行区间的引用此前永远渲染成普通代码（点击芯片只认 `:行[:列]`，区间后缀剥不掉导致扩展名检查失败）；现在 `:起-止` 同样升级成可点击芯片，点击跳到起始行，tooltip 显示「第 65–84 行」。顺带修一个存量缺陷：`model-catalog.js:42` 这类**裸文件名+行号**此前被 URL scheme 检查误杀（`model-catalog.js:` 形似 scheme），导致 `pickOpenFileMatch`（专门按已开标签页匹配裸 basename）对带行号的 basename 永远轮不到。
- **实现**：`ai-file-refs.js` 的 `parseFileRef` 加 `LINE_RANGE_RE = /:(\d{1,7})-(\d{1,7})$/`（与 `LINE_COL_RE` 互斥，`LINE_COL_RE` 先试），区间命中取起始行、`lineEnd` 仅在区间时出现（普通引用返回形状保持三键不变）；倒序区间（`:84-65`）视为笔误直接不命中、`:42-42` 归一成单行、区间后带列号（`:42-56:8`）与超 7 位数字不命中。scheme 检查从入口挪到**后缀剥离之后**：`mailto:` / `http:` 剥完仍带 scheme 照样拒，`D:` 盘符放行不变；`applyFileRefChip` 的 tooltip 支持区间写法（dataset 仍只带起始行，点击行为不变）。
- **文案**：`ai-system-context.js` 的文件引用守则补区间写法（「可加 :行号[:列号] 或 :起行-止行」），模型可自然表达跨行引用。
- **护栏**：`ai-file-refs.test.mjs` 新增 2 组用例（区间命中含截图回归 `ai-tool-defs.js:65-84`、退化/倒序/超纲/位数超限不命中、裸文件名+行号 scheme 误判回归、tooltip 区间显示）。

### 改进（操作记录：追加式「加载更早记录」改为分页条）

- **行为**：列表底部原先是「加载更早记录」——点一次把更早的记录**追加**到当前列表，越看越长、也没法往回翻。现在改为真分页：`每页条数`（100 / 200 / 500）+ `最新` / `上一页` / `第 N 页` / `下一页`；切页只显示当页并把滚动容器拉回顶部，第 1 页禁用「最新」「上一页」，当前页之后没有记录时禁用「下一页」。
- **实现**：后端 `Read` 只有 ts+seq 复合游标、没有 offset，所以第 N(>1) 页的游标取第 N-1 页末条（`beforeTs` + `beforeSeq`），只做顺序翻页、不做任意跳页。取过的页缓存在 `activityView.pages`（`Map<page, {entries, truncated}>`）里，来回翻不重复读文件；筛选变化 / 刷新 / 改每页条数清空缓存并回第 1 页，`最新` 清缓存重取（深翻后点它要看到新记录）。
- **同时移除**：零引用的字符串骨架 `activitySkeleton()`——设置页内嵌形态的遗留，里面还写着同一个「加载更早记录」按钮。
- **护栏**：`activity-pane.test.mjs` 的分页用例改写为「`fetchActivityPage(page)` / `beforeTs` + `beforeSeq` / 页缓存 / 4 个分页控件 id / `#activity-more` 必须不存在 / `.act-pager` 有 CSS」。

### 修复（应用页面页头在窄内容区被挤成一字一行）

- **复现与事实**：把内容区拖窄（约 300–420px）后，「操作记录」页的标题与说明被挤成竖排一字一行，右侧按钮横排溢出被裁；同用 `pageHeader` 的外部工具 / 定时任务 / 补丁库同样中招。
- **根因**：`.ap-head` 是 flex 但不可换行，`.ap-head-actions` 为 `flex: none` 按内容宽度硬占位（操作记录有 5 个 ≥84px 的按钮），`.ap-head-main` 又带 `min-width: 0`——余量不足时只有标题区被动收缩到几十像素，中文逐字断行。
- **修复**：`.ap-head` 加 `flex-wrap: wrap`；main 改 `flex: 1 1 240px`（保底 240px 争取空间，装不下时按钮组整体落到下一行）；actions 改 `flex: 0 1 auto` + 自身 `flex-wrap: wrap` + 右对齐（宽屏下 main 仍吃满余量、按钮仍靠右，视觉不变）。顺带修同类问题：命令栏里的 `.opt-select` 基础规则是 `flex: 1; min-width: 0`，窄宽时被压成只剩一个箭头，新增 `.ap-cmd-filters > .opt-select` 给 96px 底线、装不下交给父级换行。
- **验证**：300 / 420 / 620px 三档宽度截图核对（标题正常按行折、按钮逐行折、下拉不再被压扁）；`npm run build` 通过。

### 改进（AI 上下文：数据库标签页 desc 去冗余 + Redis 键补上下文）

- **行为**：`appTabViewOf` 的三处调整——① 查询控制台标签不再在 desc 里重复连接名（旧文案注入成「查询控制台「x」（连接「x」的 SQL 查询控制台）」，连接名出现两次），SQL 控制台只注入「查询控制台「连接名」」；Redis 控制台额外补「（Redis 命令控制台）」区分命令方言；② Redis 键查看器标签补上缺失的 desc（此前只有「键查看器「键名」」，AI 不知道连的是哪个连接哪个库），现在注入「键查看器「键名」（连接「x」库 N）」，键名不在 desc 重复；③ 数据表 desc 维持原样。护栏：`virtual-doc-wiring.test.mjs` 新增 1 例（Redis 键 desc 分支存在 + 控制台分支不出现「连接「」）。

### 改进（AI 上下文：虚拟标签页清单文案压缩）

- **行为**：workspace_context 里虚拟标签页清单的引导句从「其他已打开的标签页（应用内视图，不是文件、没有路径可读）：」压缩为「虚拟标签页（非文件，不可按路径读取）：」——防误读语义不变（告诉模型这些不是文件、别按路径读），每轮注入少约 10 字噪音。只改 `ai-system-context.js` 一处注入文案；openViews 组装、12 个截断与文件清单隔离逻辑均不动。

### 修复（AI 正文图片失效时用会话附图留档兜底显示）

- **复现与事实**：AI 会话（如桌面控制汇报）里正文 Markdown 引用的截图显示「图片无法加载（悬停查看原因）」，悬停报 `GetFileAttributesEx … The system cannot find the file specified`——但图片并没有丢：模型曾用 read_image 把它附到对话里，耐久副本就在会话目录 `ai-sessions/<哈希>/<会话>/images/` 下。
- **根因**：正文引用的只是「文件当时的位置」。两种典型失效：① 会话在旧工作区跑（如 `D:\Projects\CaDt-DataLens`），模型写的是工作区相对路径（`.cadt/tmp/family-tree-01.png`），换工作区后按当前根解析必然找不到；② 引用指向 `.cadt/tmp` / `mcp-images` 这类设计上可整目录回收的临时区，存储清理后路径失效。附图真源（会话 `images/` 目录，加载时 `hydrateImages` 水合成 data）一直都在，只是正文渲染没有兜底链。
- **修复**：`resolveAIImages` 的「读取失败」分支新增兜底——`aiFindAttachedImageByRef`（纯函数，`ai-constants.js`）从当前会话消息 + 归档里按文件名对齐附图记录，附图 content 里记录的来源路径与引用路径**尾段**对得上的候选优先（压过仅同名的，防同名不同图），同级取后出现的；命中即用耐久副本渲染，tip 注明「原文件已不在原位，显示的是会话附图留档」。只兜「读不到文件」：格式不支持 / 超 30MB（url 为空分支）与越界未授权路径维持原语义。
- **护栏**：`ai-constants.test.mjs` 新增 5 例（工作区移动尾段对齐 / 尾段优先于同名 / 同级取后者 / 未水合 data 不参与 / 找不到与非法入参返回 null）。

### 修复（编辑区收起态下打开文件：标签条横滚滚不到末尾）

- **复现与事实**：收起编辑区后在 AI 会话里点文件链接（或任何收起态下开标签页的操作），展开后标签条横滚条滚到头，末尾标签仍被右侧工具区（视图切换/更多按钮的绝对定位覆盖层）盖住一截；不收起直接打开则正常。
- **根因**：`.tb-tools` 是绝对定位覆盖层，滚动余量靠标签条末尾 `.tb-spacer` 预留，宽度在 buildGroup 构建现场量 `tools.offsetWidth`。收起态下 `#main-pane` 是 `display:none`，此刻量出来恒为 0——AI 面板点文件链接先在隐藏态重建标签条再展开，spacer 被记成 0px，展开后无人重新测量，滚到头末尾标签仍被工具区盖住。
- **修复**：spacer 测量收敛到 `syncTabSpacer`（宽度不变幂等返回）；新增 `refreshTabStripSpacers` 逐组重量，只有 spacer 确实被修正才补发激活标签定位（不拽用户手动滚出的位置）；`setEditorCollapsed` 只在「收起→展开」真实过渡时调用（收起方向 hidden 态量了也是 0，不动旧值）。
- **护栏**：`tabstrip-scroll.test.mjs` 新增 5 例（测量收敛不许内联 / syncTabSpacer 契约 / refresh 条件 reveal / 工厂导出 / setEditorCollapsed 过渡分支）。

### 改进（全局搜索支持文件名命中）

- **行为**：此前全局搜索只搜文件**内容**——`searchNameHit` 仅用于给内容命中排序提权，文件名匹配但内容零命中的文件完全不返回（搜 "icons.js" 找不到 `core/icons.js` 本身）。现在内容扫描完成后统一做一次**文件名兜底**：文件名含查询词（模糊模式按子序列）且没有内容命中的文件，追加一条 nameOnly 命中（行号槽显示「文件名」、预览即文件名高亮段），追加在内容命中之后（按路径排序、上限 50 条）——内容搜索的既有排序与档位不受扰动，且内容命中吃满 maxResults 时文件名命中仍可见。
- **口径**：与内容扫描同过滤（skip 目录 / AI worktree / 用户排除表 / filePattern / excludePattern），**不按二进制扩展名排除**——文件名命中不读内容，logo.png 这类二进制文件同样能按名找到。rg 与内置扫描两条路径统一收口（rg 不产出扫描文件清单，故在 `searchWorkspace` 汇总后一次只读目录遍历实现）；`outputMode=files/count`、AI `search_text` 同样生效，AI 工具描述已同步（按文件名找文件可以直接搜）。前端 nameOnly 行点击即打开文件（无行可跳）。
- **护栏**：`internal/search` 新增 3 例（nameOnly 基线 + 大小写 + 二进制按名命中 / 模糊子序列文件名命中 / rg 路径同生效）；前端 `global-search.test.mjs` 新增 nameOnly 渲染与「点击不进跳转」2 处断言（setup 注入 openPaths/findDocByPath 调用记录）。

### 新增（Redis 支持：键空间浏览 / 类型化键查看器 / 命令控制台，P3 一次落地）

- **连接**：连接管理对话框「驱动」下拉新增 Redis（host/port/密码 + ACL 用户名可选 + 数据库编号 0–15）；自写 RESP2 客户端（`internal/dbclient/redis.go`，0 新依赖，文件头注明后续可替换 go-redis/v9），AUTH/SELECT/PING 握手、单连接串行 + pipeline、二进制安全；不支持 Cluster/Sentinel/TLS（MOVED/ASK 错误给出明确指引）。会话生命周期（上限/空闲回收/取消）与 SQL 会话共用一条流程（`dbSession` 加 `redis` 字段，遵守 driver.go「独立子系统」声明，绕开 Driver 注册表）。
- **键空间树**（侧栏会话树 Redis 形态）：SCAN 分层懒加载（COUNT 250/批 + cursor 续扫，全程无 KEYS）；`:` 前缀虚拟分组（可切扁平列表）、组名与叶子名共存互不吞并；键节点带类型图标（string/hash/list/set/zset/stream）与 TTL 角标；根层模式过滤（SCAN MATCH）；「已匹配 N + 加载更多」诚实 UI（SCAN 无总数，不做假分页）。
- **键查看器标签页**（每键一个，marker `dbRedisKey`）：头部键名/类型/TTL/长度 + 刷新/改 TTL/删除；string 四档 formatter（Text/JSON pretty/HEX/Binary base64，二进制自动 HEX）；hash/list/set/zset 转统一行集网格（stream 只读），editable 会话双击行弹层编辑（HSET/LSET/SADD/ZADD 等价命令预览确认）；TTL 修改/PERSIST；单键 DEL 普通确认、**前缀批量删 Type-to-Confirm**（输入完整前缀才可确认，§5.4）。
- **查询控制台**：复用现有控制台标签页，Redis 词表 guard——读白名单精确枚举（`config` 只放行 get 两词）、写命令跟随「允许编辑」、FLUSHALL/CONFIG SET/SHUTDOWN/DEBUG 等两阶段确认、MULTI/EXEC 控制台拒（与 SQL BEGIN/COMMIT 同口径）、未知命令 fail-closed 拒；xread 不进读白名单（BLOCK 参数会阻塞）；每行一条命令，回复转行集（标量单行 / 数组 #+值）。
- **编辑提交**：走结构化 `DBRedisApply`（RESP 直发不经文本解析，多行/二进制安全）+ 命令预览弹层（§5.4「编辑生成命令预览」）；string 保存自动补偿 TTL（SET 清 TTL → 按原值 EXPIRE，兼容 Redis <6.0 不用 KEEPTTL）。
- **实现**：Go `redis.go`（协议+客户端）/`redis_session.go`（会话+scan/fetch/apply/删前缀）/`guard_redis.go`（词表）+ session/query/config 接线 + 4 个新绑定（`DBRedisScan/DBRedisFetchValue/DBRedisApply/DBRedisDeleteByPrefix`）；前端 `db-redis-view.js`（键查看器）、`db-session-tree.js` 键空间分支、`db-connections.js` 驱动参数化、`db-model.js` redisPrefixTree 纯函数；mock 全套（演示键五类型 + 中文前缀组，浏览器 mock 全流程可测）。测试：Go 假 server 全链路 8 例 + RESP/词表表驱动（不写 TestMain 规避子进程递归陷阱）、前端 `db-redis.test.mjs` 9 例，均登记 `npm test`。方案 §5.4、实施记录 §11.13。

### 改进（编辑器：Python 染色对齐 PyCharm）

- **对照实机 PyCharm（新版 Dark）截图逐 token 像素采样 + intellij-community 官方配色源（PythonDarcula/PythonDefault.xml、expUI_darkScheme.xml、Light.xml）核实，深浅两套全部对齐**：类内 dunder 方法名（`__init__`/`__str__`…）品红 `#B200B2`（PY.PREDEFINED_DEFINITION，深浅同值）；装饰器 `@staticmethod` @ 与名字整体橄榄黄（深 `#B3AE60` = DEFAULT_METADATA / 浅 `#9E880D`）；class 名回归普通文本色（此前误吃函数蓝）；`__name__` 等模块级 dunder 引用回归普通色（此前误上内置紫）；关键字参数新分色（深 `#AA4926` / 浅 `#660099`，调用处与 def 签名形参均染色，对齐 PY.KEYWORD_ARGUMENT）；浅色侧内置名（print/len…）修正为官方 `#000080`（原 `#871094`）、docstring 修正为 `#8C8C8C` 斜体（原沿用深色 `#5F826B`）。函数名/普通方法/静态方法维持函数声明蓝（深 `#56A8F5` / 浅 `#00627A`），self/cls、字符串、数字、注释、内置名（深色 `#8888C6`）、docstring（深色 `#5F826B`）此前已与官方一致，不动。
- Python 专项色全部收进 `--py-*` 变量（新增 `--py-dunder` / `--py-decorator` / `--py-kwarg`，在深浅两套软件主题块定义、代码主题块按明暗继承），六套浅色代码主题（jetbrains-light/github-light/shiki/newsprint/pixyll/whitey）的 Python 专项色归一到官方值。
- 实现：`editor-ace-hooks.applyPythonTokenClasses` 重写——def 名 span 回溯关键字区分 def/class（Ace 对两者都发 entity.name.function）；行首 `@` 判定装饰器（行中 `@` 矩阵乘不受影响）；摘除「双下划线 identifier→py-builtin」旧规则；def 签名不再整行跳过（形参 kwarg 照染）。测试改写 + 新增 8 例（装饰器/矩阵乘/dunder/class/签名 kwarg），`editor-ace-hooks.test.mjs` 26 例全绿。

### 修复（折叠图标收尾：原生 tooltip、胶囊居中与文字箭头）

- **编辑器折叠标记不再弹原生 tooltip（gutter + 行内胶囊）**：Ace 的无障碍补齐在渲染 gutter 单元格（`Gutter.$renderCell`）与行内折叠胶囊（`Text.$renderToken` 对 fold token）时都会无条件 `setAttribute("title", "Fold code"/"Unfold code")`（无开关项，翻译表置空无效——nls 查表用 `||` 回退，空串会被跳过）。`editor-ace-hooks.disableAceFoldWidgetTooltips` 分别包这两层，渲染完摘掉 title（空 title 不弹 tooltip）；一次性全局原型补丁，随 `createEditorAceHooks` 在模块求值时执行（早于任何编辑器创建），窗口内所有 Ace 编辑器一并生效。行内胶囊选 `$renderToken` 收口是实测结论：CDP 插桩发现 addFold 的局部渲染不经过 `$renderLine`（局部更新路径绕开），而 title 只在 `$renderToken` 诞生、span 又随行重建——在出生点拦截才能全覆盖。测试 4 例登记 `editor-ace-hooks.test.mjs`。
- **折叠胶囊 `...` 居中（用户报「点不在胶囊中间而是偏右」）**：根因是几何结构问题——Ace 把胶囊 span 宽度写死为 `占位符字符数 × characterWidth`（border-box），`.ace_fold` 的 `padding: 0 4px` 挤掉内容盒后内容盒比 `...` 文本还窄，Chrome 对溢出的 `text-align: center` 钳住左缘只向右溢出（CDP 实测 textRect 比 spanRect 偏右 4px，字宽度量偏差大的会话左空可达一字宽）。修复：`.ace_fold` 加 `display: inline-grid !important; place-content: center !important`，溢出双向对称——胶囊宽度精确（=3×字宽）与偏宽（度量偏差）两种场景都居中。CDP 端到端复验 leftGap=rightGap=0。
- **阅读模式目录折叠按钮换 SVG**：`reading-view.js` 目录分组折叠按钮从文字「▸/▾」改为 `iconSvg('chevron-right')` + CSS 旋转（图标硬规范，open 态用 class 判定替代 textContent 比对）。
- **便签块折叠按钮删文字兜底**：`bridge-memo-view.js` 的 `iconSvg(...) || '▸'` 兜底摘除——iconSvg 失败时宁可不画，不再退回文字字符。

### 修复（SQL 控制台配色与编辑区不一致）

- **事实**：控制台 Ace 是运行时 `ace.edit()` 创建，Ace 会动态往 head 注入默认主题 CSS（晚于构建期样式表）——SQL 关键字/字符串被主题硬色盖成默认蓝紫，与编辑区的代码风格变量（`--syn-keyword` 等，随 data-code-style 代码主题切换）不一致。
- **修复**：`.db-sql-ace` 的 token 规则（关键字/字符串/注释/数字/布尔/NULL/函数/标点/标识符 + 选区/gutter）全部改 `!important` 顶掉运行时注入的主题色——颜色永远走应用代码风格变量，与编辑区同源同切换。

### 改进（数据库：行高列宽 / DDL 导出 / 控制台多结果）

- **行高与列宽（图9）**：表头右缘拖拽手柄调列宽（双击手柄恢复自适应，列模板走 CSS 变量单一来源）；状态条加行高档位（紧凑 22 / 常规 26 / 宽松 32，`setRowHeight` 联动 canvas 与可视窗口，行内文字始终居中）。
- **导出/复制 DDL**：`buildDDL` 纯函数从表元数据生成建表语句（MySQL 反引号 / SQLite 双引号；单主键落列内、复合主键表级声明；DEFAULT 字面量按数字/NULL/字符串转义；SQLite autoindex 不还原）——树表节点右键「复制 DDL / 导出 DDL…」+ 表标签页工具栏「DDL」按钮；入口均为异步拉 DBDescribe。
- **控制台多结果（图2 JetBrains 对齐）**：Go `QueryOutcome.Results` 逐条语句留档（兼容字段 Result = 最后一条）；结果区 tab 化——「输出」摘要（每条语句 + 行数/消息 + 总耗时）+ 每条 SELECT 一个结果 tab（grid 共享切换重放，mock 同步拆语句）；Ace 多行编辑器已由编辑器补全方案落地（mode-sql 高亮 + 表/列补全 + Ctrl+Enter）。
- **护栏**：`buildDDL` 3 例（SQLite/MySQL 方言 + 复合主键 + 兜底）；eslint no-undef db 域归零。

### 改进（编辑器：格式解析失败不再拦截保存）

- **行为**：code/text 视图保存时不再因格式解析失败被拦截（此前 JSON/YAML/TOML 等敲坏后 Ctrl+S 直接弹错拒存）——**是否保存交给用户**：按原文落盘 + 非阻断提示「XX 无效，已按原文保存」（auto-save 静默放行；表格模式的序列化内容由应用生成、失败静默；tree 模式是真实数据路径，校验保留）。
- **实现**：`saveDoc` 原文路径摘除 `fmt.parse` 校验门（该路径 text 本就按原文写盘，parse 纯属拦截用）；配合解析错误托盘现代化（见下方实机反馈 ①），「报错可见、保存自决」。

### 改进（数据库：对齐 JetBrains 的八项打磨）

- **自动重连**：会话被空闲回收（Go 侧 15 分钟）是服务端静默行为，此前网格只会报「连接会话不存在」。现在浏览/刷新/执行失败识别到会话丢失即**自动重连并重建面板**重新加载当前页（5 秒节流防「重连又失败」死循环；控制台同样接入）。
- **树缩进层级修正**（用户报「层级画歪了」）：库行曾比条目行还浅（父子倒挂）、表节点与「表」分组行只差 4px——改为固定步进缩进（条目 20 → 库 36 → 分组 52 → 表节点 68px，服务器对象再深一档）。
- **折叠箭头换 SVG**：树展开箭头从文字「▸」改为 `iconSvg('chevron-right')`（图标硬规范），open 态 CSS 旋转。
- **树层级右键菜单补齐**：库行（刷新/新建表/控制台/断开）、表分组（刷新/新建表）、视图分组（刷新）、服务器对象分组（刷新）、表/视图节点（打开/复制表名/控制台）全部有右键；条目行右键 = `[...]` 同款。`[...]` 按钮去掉 tooltip；MySQL/MariaDB 菜单「编辑连接…」更名「属性…（连接管理）」对齐 JetBrains Properties。
- **AI 上下文丰富化**：数据表/查询控制台标签页在 AI 的打开视图清单里注入 desc（连接名、库、表/视图类型），不再只给表名（`appTabViewOf` + `ai-system-context` 拼接）。
- **筛选区重排 + 多列 ORDER BY**：筛选面板加 WHERE / ORDER BY 分区标签；条件行固定栅格（列 150px / 算子 110px / 值弹性，不换行不错位——修复增强 select 替换后的塌陷，触发器 wrap 继承列宽类）；ORDER BY 结构化多列（列下拉 + 升降，可多行），Go `BrowseRequest.OrderCols` 逐列过元数据白名单后拼 `ORDER BY`，不接受原始 SQL 片段。
- **分页档位 + 导出/导入 + 自动刷新**（图7/图8）：状态条加每页行数档位（10/100/250/500/1000/所有=5000 上限/自定义）；工具栏「导出」当前已加载结果为 CSV/JSONL（`formats.csv.stringifyTable`）；「导入」CSV/JSONL（UTF-8，20MB 上限，新绑定 `DBReadImportFile`）→ 列映射表单 → 生成待提交行**走受控写入链路**（预览确认后单事务提交）；「自动」刷新档位（禁用/5s/10s/30s/1m/5m，编辑中或有 dirty 时自动暂停，断开时静默停止）。
- **单元格垂直居中**：`.db-grid-cell` 补 `line-height:20px`（26px 行高减上下 padding），内容不再偏上。
- **护栏**：Go `guard_test` DDL 能力位语义 + `TestCreateSQLite` + `TestBrowseOrderCols`（多列下推/坏列拒绝）；前端 `db-create-table.test.mjs` 6 例；eslint `no-undef` db 域归零。

### 改进（编辑器：折叠箭头对齐 JetBrains）

- **行为**：展开态箭头（向下）默认不显示，**hover 行号区才出现**；折叠态箭头（向右）**任何情况常显**——与 JetBrains 编辑器一致。
- **实现**：纯 CSS 作用域调整（`.ace_gutter:hover … .ace_start:not(.ace_closed)`）——折叠行同时挂 `ace_start ace_closed` 两个类，`:not(.ace_closed)` 保证 hover 行号区时折叠行仍显示右箭头不被盖成向下；箭头造型/配色沿用既有 data-uri。

### 新增（编辑器代码补全：SQL 控制台 Ace 化 + 数据格式结构补全）

- **事实**：SQL 控制台是裸 textarea（无高亮无补全）；文件编辑器的 Ace 从未启用 language_tools——补全引擎（ext/language_tools + autocomplete）其实一直躺在 jsoneditor.min.js bundle 里随 `window.ace` 暴露，只是零接线。方案与调研见 `docs/finished-plans/editor-completion.md`（偏离记录 §15）。
- **SQL 控制台（P0）**：textarea → Ace（`ace/mode/sql` 语法高亮 + placeholder；Ctrl/Cmd+Enter、确认横幅失效、防重入等价迁移；`window.ace.edit` 探针通过，起不来时自动退回 textarea 兜底）。补全三层：方言关键词（sqlite/mysql 两套语法级手写表）→ 库/表/视图（`DBListObjects`）→ 列（`DBDescribe`，`表.` / `库.表.` 点号上下文 + FROM/JOIN 别名解析）；元数据懒聚合按会话缓存、并发单飞，DDL/写语句执行后失效并让下次描述带 noCache（与网格写后刷新同语义）；断连/失败静默降级纯关键词，不打断输入。列候选悬浮显示 类型 · 主键 · NOT NULL · 默认值。
- **文件编辑器（P1）**：非只读 doc 幂等挂载全局 completer（`editor-ace-hooks.applyAceMode` 接线，且在键位重绑之前——键位表里的补全条目要等命令挂上才能被接管），候选按 mode 分流：JSON/JSONL 键、YAML 键、XML 标签/属性、INI/TOML 段/键（`core/completion.js` 纯函数提取）+ 全文档词法兜底（≥3 字符词；>2MB 只扫光标附近窗口，脏标记 300ms 节流）；打分口径 前缀 > CamelHumps > 子串 > fuzzy。vendored mode 实测无 `$keywordList`（python/js/go 均 0 命中），探测代码保留——有就带上。
- **设置与键位**：`settings.completion = {files: true, sql: true, live: false}`，设置 → 编辑器与写作三行开关（文件补全 / SQL 补全 / 输入即弹，live 默认关，偏好键跨窗同步）；键位表登记「代码补全（候选弹层）」三风格 Ctrl+Space + Alt+/（Windows 中文输入法把 Ctrl+Space 占成中英切换，Alt+/ 备用），设置页「编辑器内键位」表自动带出该行。
- **工程（npm test 拆分）**：测试清单过 240 个文件后，单条 `node --test` 命令行超出 Windows cmd 8191 字符上限（「命令行太长」整批不跑）——`npm test` 拆为 `test:ai` / `test:ui-core` / `test:ui-shell` 三个子脚本串行（失败即停），`test-manifest` 守卫改为扫全部 npm script 字段的并集（双向核对 + 禁重复登记语义不变）。
- **护栏**：0 新依赖、0 vendor 新增文件、无 Go 改动（无新绑定 → 无 mock-backend 义务）；新增 `core/completion.js` / `editor/editor-completion.js` / `db/db-completion.js` 三模块。测试 `test/core/completion.test.mjs`（13 例）+ `test/editor/editor-completion.test.mjs`（8 例）+ `test/db/db-completion.test.mjs`（15 例，假 backend 覆盖单飞 / 缓存失效 / 失败降级 / 跨库 / quick doc）已登记清单；候选弹层样式走主题变量，编辑器内部浮层不进 overlay-stack（弹层规范豁免）。

- **实机反馈改进（2026-11-22）**：① JSON 解析错误托盘（编辑器底部，jsoneditor 原生 `.jsoneditor-text-errors`）现代化——杀掉原生黄顶线与酱色红底（真凶是 `tr.parse-error` 的 `rgba(238,46,46,.44)`，特异性 (0,3,1) 需单独覆盖 + !important），改为面板底色 + 主题分隔线 + 行 hover + 跳行 accent + 报错文本编辑器字体（红 X sprite 保留、「Ln N」列弱化）；② 补全弹层对齐 JetBrains 观感——行首类型图标（meta → `iconSvg`：关键词 `</>`、键 花括号、段 缩进行、标签/属性/表/视图/SQL 列分色，新登记注册图标 `braces`；装饰挂 MutationObserver——popup 晚于首回调创建需惰性重试，且 popup renderer 不发 afterRender，与 python 补色同款观察器机制）、行距/圆角/选中行底色/meta 弱化；弹层配色改跟**编辑器代码主题**走（底/字 `--editor-bg`/`--editor-text`、选中行 `--ace-selection`、meta `--ace-gutter`，fallback 界面主题变量——默认「跟随软件主题」档下无感，深色界面配浅色代码主题时弹层同步变浅，不再深弹层浮浅编辑器）；③ 「输入时自动弹出」**默认关**：live 路径在 vendored bundle 上实测不可靠（最小 completer + live 也复现渲染冻结、真实键入后 completer 未创建——非本项目代码问题，详见方案 §15.2），设置变更热生效到已开编辑器的接线保留（开关切换即时生效，生效后仍可尝试）；④ 编辑器折叠箭头对齐 JetBrains：展开态（向下）hover 行号区才显示、折叠态（向右）常显。
- **护栏补充**：测试 36 → 41 例（normalize 默认值、热生效、弹层行图标装饰各一）；`braces` 图标先进注册表再用（icon-guard 合规路径）；JSON 错误托盘覆盖仅加 `.jsoneditor .jsoneditor-text-errors` 作用域，结构与跳行交互不动；折叠箭头为纯 CSS 作用域调整。

### 改进（数据库：从零建库建表，仅 SQLite）

- **事实**：此前「新建连接 → SQLite」只能选已有库文件，且 guard 对 DDL 恒拒（连控制台 CREATE TABLE 都不收）——「从零建一个库」的链路不存在。
- **新建空库**：顶部菜单新增「新建 SQLite 数据库…」——保存对话框选路径，Go `CreateSQLite` 以 `O_CREATE|O_EXCL` 原子判定（已存在绝不覆盖），0 字节文件 + 「建 `_cadt_init` 表再删」的真实写事务落盘文件头（`PRAGMA journal_mode` 不产生写 I/O，会留半截 0 字节文件）；建好默认允许编辑加入工作区。绑定 `DBCreateSQLite`，mock 同步。
- **SQLite 开放建表**（作者拍板）：`sqliteDriver.Capabilities().DDL = true`，仅 editable 会话生效（只读会话被 editable 门挡住），MySQL 恒拒不变；DROP TABLE 等危险结构变更仍走两阶段确认。新增结构化「新建表」表单（`db-create-table.js`）——入口在树「表」分组行尾 + 按钮；表名/列名保守校验（字母数字下划线、不以数字开头）、类型白名单（INTEGER/TEXT/REAL/BLOB/NUMERIC）、单主键落列内（INTEGER 主键保留 rowid 别名）、复合主键表级声明；生成的 SQL 走控制台同一条 guard 通道，不做旁路，成功后树清单自动刷新。
- **护栏**：`guard_test` DDL 用例改能力位语义（未开放拒 / CREATE 直接放行 / DROP 确认链路）；`TestSQLiteEditableFlow` 改写为「确认后 DROP 真实执行」；新增 `TestCreateSQLite`；前端新增 `test/db/db-create-table.test.mjs`（6 例，已登记 `npm test`）。

### 改进（数据库浏览重构：侧栏会话面板化，JetBrains 对齐）

- **入口方向纠正**（作者以 JetBrains 截图为准）：侧栏「数据库」面板本身就是会话面板——连接条目展开即建立会话，树直接长在侧栏：连接 → 库 → 分组「表 N」「视图 N」+ MySQL 专属「服务器对象」（排序规则 / 用户 / 虚拟视图，懒加载、权限不足的组自动隐藏）；表/视图节点行尾显示表注释。**双击数据表直接以独立虚拟标签页打开全宽数据网格**（一个表一个标签），不再有「库标签页内嵌树+子标签」的三栏布局；查询控制台是每会话一个的独立标签页（行菜单「打开查询控制台」）。旧 `db-tab.js` / `db-object-tree.js` 删除，新增 `db-sessions.js`（会话管理器：幂等连接/断开重连/订阅通知，关标签页不断会话，断开与空闲回收后网格给重连入口）、`db-session-tree.js`、`db-tab-views.js`。
- **编辑链路对齐**（图4/图5）：单元格内联编辑框修复（占满单元格、无圆角缝隙、accent 描边——原对话框形态的输入框在 26px 行高里溢出被裁）；修改后的单元格显示**新值**并高亮，行号列同色高亮；提交改 icon 按钮——无修改灰、有修改亮，点击出预览弹层（两阶段确认保留），**Ctrl+Enter 直接提交**（跳过预览，作者拍板对齐 JetBrains 默认行为）。
- **Go 协议**：`DBObject.Comment` / `DBTableMeta.TableComment`、`DBListServerObjects` 绑定（排序规则/用户/系统虚拟视图，每组独立容错）；顺带修掉 `.db-btn[hidden]` 被 `display:inline-flex` 覆盖导致编辑簇在只读会话也显示、预览弹层取消后 mask 残留两个 bug。新增 `test/db/db-sessions.test.mjs`（8 例，已登记 `npm test`）。

### 改进（设置 → 编程语言首次打开自动全语言扫描）

- **行为**：编辑器与运行面板照旧不主动扫描；打开「设置 → 编程语言」任一语言页时，若还**没有任何语言的扫描结果**（全空，如首次使用 / 清过设置），自动后台顺序扫一遍**全部语言**并缓存（此前只扫当前打开的语言，其余要逐个点开才扫）。已有任何结果 / 在扫时维持原状：只补当前语言还没扫过的工具，缓存不重扫。
- **实现**：判定抽成纯函数 `firstFullScanRuns`（`settings-pane-lang.js`，只读读取不建空档）；全语言扫描与各 pane 补扫互斥（工厂级 `fullAutoScanning` 标记 + 循环内复查），`scanLanguageTool` 原有重入守卫兜底并发；旧结构（语言级缓存）经既有迁移语义保留，不会被重扫。
- **护栏**：新增 `frontend/test/settings/settings-pane-lang.test.mjs`（7 例，已登记 `npm test`）：全空清单顺序、任一结果 / 在扫即否决、缺档视为未扫、旧结构视为未扫、空表与缺 tools 键边界。

### 修复（Python 编辑时 `__name__` 等增强染色闪白）

- **事实（2026-11-22 用户实测）**：dark 模式下写 Python，往 `if __name__ == "__main__":` 的字符串里敲字，每敲一个字符 `__name__` 先变白再变紫，持续闪烁。
- **根因**：Ace 原生 python 分词器把 `__name__` 这类双下划线预定义名当普通 identifier（白），紫色的 `py-builtin`（以及 kwarg / docstring 增强）是渲染完后对 text layer **事后补染**的（`editor-ace-hooks.js`），补染经 `setTimeout(…, 30)` 去抖。击键让 Ace 整行重建 DOM（补的类随重建丢失→白），30ms 后去抖回调才补回紫色——去抖必然晚于本帧绘制，闪烁由此而来。
- **修复**：补色时机挪到**本帧绘制前**——去掉 30ms 去抖，`MutationObserver` 回调（微任务，Ace 渲染任务结束后、绘制前同步执行）、`afterRender` 钩子、挂载三处都直接同步跑 `applyPythonTokenClasses`；该 pass 只改 class、不监听 attributes，不会自触发观察回调。顺带修掉滚动新行延迟 30ms 才染色的问题。
- **护栏**：`editor-ace-hooks.test.mjs` 新增 11 例（已登记 `npm test`）：染色规则（`__name__`→py-builtin、括号内 kwarg、整行 docstring、def/class 跳过、括号外赋值不染、残留类先清、非 python 模式不动）+ 时机契约（挂载即同步染色、行 DOM 重建后观察回调同步补色、afterRender 直接补色）——旧去抖实现在「挂载即染色」断言下直接红。

### 修复（编辑消息重新发送后编辑框不退出）

- **事实（2026-11-22 用户实测）**：消息原地编辑后点「发送」（重新发送），消息发出去了、流式回复都开始了，编辑框还挂在回复上面不退。
- **根因**：`doSaveInlineEdit` 成功路径按**对象身份**清编辑态（`if (inlineEdit === state) inlineEdit = null`），注释假设「startSessionTurn 已重画消息区、编辑态随之消失」——那是快照恢复机制加入前的旧假设。现在 `renderMessages` 重绘前会把编辑态快照、重绘后在**新消息节点上原样恢复**（防异步重读丢内容的机制），`inlineEdit` 已换成恢复出的新对象，身份比对恒失配，编辑框就被复活在了流式回复上。
- **修复**：成功路径改按「会话 + 位置」匹配（截断重发后新消息恰好落回原 index），命中即走 `endInlineEdit` 统一收口（摘 `.editing` 类 + 整面重画还原正文——`.ai-edit` 不靠类显隐，只摘类不够）；起轮没触发重画（面板没在看这个会话）时维持按身份直接清。
- **护栏**：`ai-inline-edit-wiring.test.mjs` 新增「保存成功」用例，锁成功路径必须按会话+位置匹配并经 `endInlineEdit` 收口，禁止退回只按对象身份清。

### 改进（中断横幅「继续回合」按钮改 warn 淡底）

- **事实**（用户反馈：横幅右边的按钮很难看）：`.ai-interrupt-resume` 用 warn 实心块 `#fff` 白字，暗色主题下 warn 是浅金 `#d5b778`，白字压上去对比度极低、发灰糊成一团；也违背本套主题的 warn 用法——warn 系一律是「淡底 / 深橄榄底 + warn 字」（`--banner-*`、`.ai-truncated-box`、`.ai-retry-note` 都是），从未做过实心浅金 + 白字。
- **修复**：改 warn 淡实底（16%）+ warn 42% 描边 + warn 字，hover 加深到 26%，补 `:focus-visible` 描边；尺寸对齐兄弟按钮（`border-radius: 5px` 与 × 一致、`padding: 3px 10px`、`line-height: 1.5`），显式 `font-family: var(--ui-font)`（button 不继承字体，此前落回 WebView2 系统字体）。颜色全部走 `color-mix` + 变量，深浅主题各自成立。
- **验证**：`.cadt/tmp/` 下临时页引入真实 `style.css` 按暗/浅主题各渲染一遍核对；`npm run build` 通过。

### 修复（排队消息发出后文本复活回输入框）

- **事实（2026-11-22 用户实测）**：生成中排队一句话，轮末冲刷把它发出去了，文字却又出现在输入框里——看起来像「从队列取回了刚发出的消息」。
- **根因**：输入草稿槽（内存 Map + localStorage）与「排队 / 冲刷代发」互相不知情。①排队/插话/抢占把输入内容消费掉时不清草稿；②冲刷代发会把消息**瞬态回填**进输入区再起轮（大会话起轮的 whenIdle / 生命周期钩子窗口可达数秒），期间用户切走会话，`switchSession` 的「存上个会话草稿」就把这段瞬态文本沉淀成草稿；③之后切回本会话，`loadComposerDraft` 把草稿复活回输入框。同 id 重复切换（信箱行 / 桥跳转打在当前会话上）还会在**不保存**的情况下直接用旧草稿覆盖输入区，同样能把已发出 / 已排队的文本带回来。
- **修复**（四处，规则统一为「输入内容被消费或清空时，会话草稿同步作废；同 id 切换保持输入区现场」）：
  - `captureComposerMessage`（排队 / 插话 / 抢占共用出口）与 `editQueuedMessage`（取回编辑把原输入挪进队列）在清空输入区时调用新注入的 `dropComposerDraft` 作废草稿；
  - `submitText` 的 `onStarted`（直发 / 冲刷 / 斜杠发送共用的清输入点）同步作废草稿；
  - `flushThroughComposer` 入口与失败收尾各作废一次（失败回插队列时输入区也清空）；
  - `switchSession` 引入 `sameSession` 守卫：同 id 重复切换既不保存也不用草稿覆盖输入区（顺带修掉「同 id 切换会打断用户正在敲的内容」的隐性丢失）。
- **护栏**：新增 `frontend/test/ai/ai-draft-hygiene.test.mjs`（5 例源码守卫，已登记 `npm test`）；`ai-message-queue.test.mjs` 补冲刷草稿作废的行为用例 2 例（成功 / 失败路径，桩 `submitText`）；`ai-empty-session.test.mjs` 的 previous 块断言同步 `sameSession` 形态。全量 `npm test`（2372 过）与 `npm run build` 通过。

### 改进（原生右键菜单收编：输入面编辑菜单全局兜底 + 调试台选区菜单）

- **输入面编辑菜单兜底**（用户报告：两个过滤框右键弹的是 WebView2 原生菜单）：新建共享模块 `shell/edit-menu.js`——撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选的应用菜单，从 ai-composer 的 composer 专用版泛化（`openEditMenu` / `editableHasSelection` / `execEditable` / `pasteTextIntoEditable`，粘贴只回读系统剪贴板文本插入目标）。`bindEditableContextMenuFallback` 在 main.js 组合根注册**一次**：右键落在没人接管的输入框 / 文本域（文件树与 AI 会话的过滤框、设置页与弹窗里的输入面……）时给应用编辑菜单；**冒泡阶段监听 + `defaultPrevented` 守卫**——域处理器先跑，已开自定义菜单（preventDefault）或已 stopPropagation 的不再兜底，AI 面板 composer 的图片 / 折叠粘贴分支原样保留（经 `options.paste` 覆盖）。
- **调试控制台选区右键菜单**（用户报告：选区右键也是原生菜单）：`.dbg-body` 挂 contextmenu——复制（选区，无选中灰置）/ 全选 / 复制全部日志 / 清空；工具栏的「复制全部」「清空」抽成 `copyLogsToClipboard` / `clearAll` 与菜单共用。独立调试控制台窗口没有编辑器初始化（全局 `ctxMenu` 不会创建），`startConsoleWindowMode` 给调试台自建一个菜单实例。
- **护栏**：新增 `frontend/test/shell/edit-menu.test.mjs`（9 用例：菜单结构 / 选区灰置 / 粘贴覆盖与回退链 / 兜底的 defaultPrevented 与非输入面不出手，已登记 `npm test`）；`ai-undo-shortcut.test.mjs` 的菜单结构断言指向新单一来源并钉住 composer 委托。

### 改进（AI 会话列表过滤 + 头部投递图标收进按钮）

- **会话列表过滤**（对齐文件树的漏斗过滤）：AI 会话侧栏头部新增漏斗按钮（`#ai-session-filter-btn`），点开分段下方的过滤行，按**会话标题或会话 ID** 子串过滤（大小写不敏感、150ms 防抖、Esc 收起并清词）。过滤时命中分组一律展开渲染（对齐文件树「命中目录自动展开」）、分页失效、归档区随命中自动展开；命中集为空显示「没有匹配的会话」。判定单一来源是纯函数 `sessionFilterHit`（无标题会话按显示文案「新会话」命中）。
- **头部投递图标移除**（用户要求）：标题栏右侧的投递纸飞机图标（`#ai-session-tool-send`）删除——投递入口保留在下方动作区的「投递」按钮（`#ai-session-action-send`）。事件绑定与元素引用一并清理。
- **作用域**：过滤只作用于会话列表——切到「群聊」分段时漏斗按钮与过滤行一起隐藏（分段模式由 `ai-group-sidebar` 的 `applyListMode` 同步到面板根 `data-list-mode`，CSS 据此显隐）。
- **护栏**：`ai-session-list.test.mjs` 补 `sessionFilterHit` 用例（标题 / ID 命中、大小写、空词全过、「新会话」回退）；过滤输入是带封装 class 的静态控件，`form-controls-factory` 基线不变。全量 `npm test`（2356 过）与 `npm run build` 通过。

### 修复（桌面控制看不到画面：Screenshot 被排除 + 图像结果被丢弃）

- **事实**：上游 windows-mcp 0.8.9 有两个截图能力（读了本机 uv 缓存里的 `windows_mcp/tools/snapshot.py` 确认）：`Screenshot`（纯截图，`display` / `region` / `save_path`，`readOnlyHint=True`）与 `Snapshot(use_vision=True)`（连可交互元素一起给）。两个都能用 `save_path` 把 PNG 写到磁盘。
- **两处坑**：① `Screenshot` 被排除在 `DESKTOP_TOOLS_WHITELIST` 外（当初理由是「图像结果会被降级」）；② 那个理由是真的——`internal/mcp/mcp_client.go` 把 `image` content 压成 `[image: image/png，base64 N 字符]` 并把图片本身丢弃，模型调 Snapshot(use_vision=True) 也看不到画面。
- **修复**：
  - `DESKTOP_TOOLS_WHITELIST` 加回 `Screenshot`（观察类只读工具，无副作用）；服务器行 `notes` 写清怎么看画面（Screenshot / Snapshot(use_vision=True)，可用 display / region 收窄）。
  - `internal/mcp` 新增 `mcp_image.go`：MCP 工具返回的 image content 一律落地成文件（默认 `%TEMP%\CaDt-DataLens\mcp-images\`，按 mime 定扩展名、时间戳 + 随机串命名），结果文本改为「image 已保存：<绝对路径>（用 read_image 查看这张图）」——模型随即能用 `read_image` 真正看到画面；落地失败或内容为空时退回旧占位并注明「无法查看画面」，不假装成功。`ImageSaver` 保留为可选覆盖点（nil 时用 `DefaultImageSaver`），因此 main 无需注入。
  - 落点选临时目录而非应用数据目录 / 工作区：前者 AI 一律不可读，后者会污染仓库且 MCP 是应用级（多窗口工作区不同）。
- **护栏**：新增 `internal/mcp/mcp_image_test.go`（4 态 text 转换 + 默认 saver 真实写盘/空内容报错）；`ai-desktop-control.test.mjs` 白名单断言由「不得含 Screenshot」改为「必须含 Screenshot」。`go test ./internal/mcp ./internal/mcpsamples`、全量 `npm test`、`npm run build` 均通过。

### 修复（桌面控制：键盘被上游钩子吞掉、跑马灯背景）

- **键盘失效（严重，2026-11-22 用户实测）**：AI 接管后物理键盘直接失效，即使 AI 主动 `windows_control_mode(exit)` 也不恢复，必须关掉应用才恢复。根因是 `mcp.json` 里那条 `windows` 行是旧配置、**缺 `--no-control`**——上游 windows-mcp 0.8.x 默认 `--control`，用 `WH_KEYBOARD_LL` / `WH_MOUSE_LL` 低级钩子做「桌面所有权」，AI 操作期间吞掉全部物理键盘输入，且**只在 server 进程退出时释放**；我们的 exit 只清了前端状态，进程与钩子还在。修法两道：
  - **进入前闸**：`desktopInputGuard()` 读 `MCPGetConfig()` 校验 `args` 必须含 `--no-control`，缺失则拒绝进入控制模式并让用户先去外部工具页点「更新配置」（根治）；
  - **退出时兜底**：`releaseDesktopControl()` = 清控制模式状态 + `MCPRestartServer('windows')`——重启进程是让键盘立刻恢复的唯一手段，用户不必再关整个应用。会话删除路径同样释放。
- **跑马灯形态（用户两轮校正后定稿）**：**悬浮胶囊**——绝对定位挂在 `#ai-head` 下沿正中（`top:100%`，随标题栏高度自适应，不写死偏移），有底色 / 红色描边 / 圆角 999px / 双层实阴影，浮在消息区之上；`#ai-panel.desktop-active` 给消息区让出 30px 顶部空间，避免遮住第一条消息。**不要**那道红色扫光（`::after` + `ai-marquee-sweep` 已删），也**不要**流内一行（那样会变成横幅，2026-11-22 第二轮实测被用户否掉）。
- **护栏**：`external-tools-page.test.mjs` 新增一例——跑马灯必须 `background:none` 且无 `::after` / `ai-marquee-sweep`；`desktopInputGuard` / `releaseDesktopControl` / `MCPRestartServer` / `await desktopInputGuard()` 四处接线必须都在。14/14 通过，全量 `npm test` 与 `npm run build` 通过。
- **仍需用户操作**：`--no-control` 只能由用户点「更新配置」写入（带 env 的 MCP 服务器 AI 不可修改）；在写入之前，新加的闸会让 `windows_control_mode(enter)` 直接返回「请先更新配置」，不会再吞键盘。

### 修复（默认会话看不到桌面入口，模型改用 PowerShell SendKeys 绕过）

- **成因（2026-11-22 用户实测）**：`windows_control_mode` 的下发条件是「会话已启用桌面控制」。新会话默认 **关**（用户要求），于是工具表里一个桌面工具都没有——但模型仍能从 `<mcp_server_notes>` 知道这台机器装了 windows MCP，于是它判定「工具没挂上」并自行降级成 `run_command` + PowerShell `SendKeys` / user32 模拟键鼠。这是最坏组合：**既没走受控通道，也没有「AI 正在控制你的电脑」提示与授权卡**。
- **修复**：入口下发条件从「会话已启用」放宽为「桌面 server 已安装」（`desktopInstalledOn`，新钩子）——装了就给 `windows_control_mode`；白名单桌面工具（`mcp__windows__*`）仍只在「已启用 + 已进入控制模式」时注入。`enter` 在未启用时改为**明确指路**：调用 `app_control` 的 `request_desktop_control`（用户看到危险审批卡），并明说不要改用 PowerShell / Add-Type / SendKeys 绕过。
- **提示词同步**：`workspace_rules` 新增一条（写权限档非计划模式）——操作其他应用走桌面控制，未启用就申请，禁止用 `run_command` 跑 PowerShell / SendKeys / user32 模拟键鼠（属规避授权）；`tool_catalog` 的 desktop 组 note 与工具描述同步。
- **护栏**：`ai-tool-wiring` 新增一例四态守卫（未安装 = 无入口 / 已安装未启用 = 有入口无工具 / 已启用未进控制模式 = 同上 / 进入控制模式 = 全量下发；计划模式一律无）；`ai-system-context` / `ai-tool-defs` 全绿；全量 `npm test` 通过、`npm run build` 通过。

### 修复（桌面控制：审批通过仍报未启用、跑马灯位置、上游接管弹窗）

- **成因①（会话字段丢失）**：`desktopEnabled` 没进会话持久化的字段白名单——`ai-session-store.js` 的 `buildSessionMeta` 只挑登记过的字段，`ai-panel.js` 的会话归一（`raw → session`）同样没读它。结果：开关点亮、标题胶囊也亮，但落盘/重读后字段消失，`windows_control_mode` 判定「尚未启用」。修：两处各补一行（`desktopEnabled: raw.desktopEnabled === true` / `(session.desktopEnabled) === true`）；另把开启路径改为写「内存里的真身」（`sessionById(id)` 优先）——工具执行的 `ctx.session` 可能是本轮开始时的对象副本，直接改它不会让按 id 重查的判定看到。
- **成因②（跑马灯漂在消息区中间）**：`#ai-desktop-marquee` 原本绝对定位（`top:10px / left:50%`），一旦定位父级不是 `#ai-panel` 就会漂到面板中部并压住消息文字。修：改为**流内一行**（`flex:none; align-self:center; margin:6px auto 0`），插在标题栏之后、消息区之前——位置由布局保证，不再依赖定位上下文，也不会遮挡消息；胶囊外观（红边 / 脉冲点 / 高光扫过）保留。
- **成因③（仍弹上游接管确认窗）**：`mcp.json` 里 `windows` 行的 `args` 是旧版本写入的，缺 `--no-control`（上游 `--control` 会弹「AI is about to take control of this computer」并吞系统组合键）。修：新增 `desktopConfigNeedsUpgrade(row)` 纯函数（args 缺 `--no-control` / 勾选与白名单不一致 / notes 仍是旧流程文案 / command 被改），桌面卡片在命中时显示「更新配置」按钮；安装改为 **upsert**（`Object.assign({}, 旧行, 新预置)`，只覆盖我们管理的字段，保留用户其他自定义），不再「已存在就拒绝」。用户自写的 notes 不动（只认明确的旧关键词）。
- **验证**：`ai-desktop-control.test.mjs` 9/9（新增 `desktopConfigNeedsUpgrade` 6 组断言）、`ai-session-store.test.mjs`、`external-tools-page.test.mjs` 全通过；全量 `npm test` 退出码 0；`npm run build` 通过。
- **注意（升级路径）**：带 env 的 MCP 服务器 AI 不可修改（安全边界），所以已有 `windows` 行只能由用户在 应用页面 → 外部工具 → 桌面控制 点「更新配置」修复；`desktopEnabled` 是新增字段，修复前的老会话需要重新点亮一次开关（或新建会话）。

### 改进（超限会话在列表上可定位）

- 会话列表给**正文超过读取上限**的会话挂 warn 色「超限」胶囊（悬停说明原因；三类判定：打开时自动整理失败 / live 段自身超限 / 已载入会话的 stat 体积越上限；懒加载占位不判定，打开后即暴露）。同批启动失败的「部分会话读取失败」通知改为**点名会话**（最多列 3 个），与胶囊对号（纯函数 `sessionOverLimitOf` + `ai-session-list.test.mjs` 用例，已登记 `npm test`；上限常量 `AI_SESSION_READ_LIMIT` 与 Go `aiSessionReadLimit` 镜像）。

### 改进（会话数据诊断的字节数人可读）

- 「会话数据诊断」的「正文」与「搜索索引」体积在原数值后追加人可读标注：`9616029 字节（9.2 MB）` / `40056 KB（39.1 MB）`（新纯函数 `aiFormatBytes`，B/KB/MB/GB/TB、1024 进制、≥100 档取整；护栏：`ai-constants.test.mjs` 用例，已登记 `npm test`）。

### 新增（AI 临时会话：一次性对话，只读 / 不绑工作区 / 不注入工作区知识 / 关掉就没了）

- **入口**：AI 会话侧栏的「新建会话」改成**分体按钮**——主体仍是原来的新建会话（绑定当前工作区），右侧新增「⋯」按钮，点开是新建方式的菜单，目前提供**新建临时会话**（`#ai-session-action-new-more` → `showNewSessionMenu`，菜单走全局 `showContextMenu` / 弹层栈，Esc 归栈管）。
- **临时会话语义**（`createSessionData(title, {transient: true})`）：权限档固定**只读**、`workspace` 为空（不绑定任何工作区，磁盘落在 `ai-sessions/_unbound/` 桶）、桌面控制默认关、不复用空会话也不接管工作区草稿；会话上带 `temp === true` 标记（判定的单一来源是 `ai-session-scope.js` 的 `isTransientSession`，只认严格 `true`）。
- **不注入工作区知识**：`ai-system-context.js` 对临时会话跳过 AGENTS.md、`<memory>`（MEMORY.md）、认知索引守则与卷 / 维护提醒、`<workspace_context>`（活动文件 / 光标 / 已打开文件），改为注入一段 `<transient_session>` 定性块（说明「只读、无工作区归属、关掉就不再出现」）；身份 / 人设 / 偏好 / 技能 / 环境变量这些应用级能力照旧注入。认知索引预取也一并跳过。
- **关掉应用就没了**：`buildSessionMeta` 把 `temp` 写进 `meta.json`（留档）；`ai-session-disk` 的 `loadMetas` / `loadAll` 默认**滤掉** `temp` 会话（显式 `includeTemp` 才读回来，诊断用），所以重启后列表里不会出现它们，正文仍留在磁盘上作留档。运行期内仍在列表可见（带「临时」徽标，归「未关联工作区」分组）；`metasDiffer` 跳过临时会话、`applyLoadedSessions` 整份替换时把它们补回内存——打开面板触发的磁盘重读不会把正在用的临时会话弄丢。
- **不吸附到工作区**：`adoptWorkspaceSession` / `syncWorkspaceToSession` 对临时会话直接返回，`newSession` 的空会话复用也把它们排除——切过去 / 换工作区都不会把它变成工作区会话。
- 护栏：新增 `frontend/test/ai/ai-temp-session.test.mjs`（源码接线守卫：分体按钮结构 / 菜单入口 / 三处不吸附守卫 / 磁盘重读保留 / 徽标，已登记 `npm test`）；`ai-session-store.test.mjs` 加 `buildSessionMeta` 的 `temp` 用例（含 meta 签名必须变化）；`ai-session-disk.test.mjs` 加「临时会话不进食盘列表、被滤掉的不读正文」；`ai-session-scope.test.mjs` 加 `isTransientSession` 严格判定；`ai-system-context.test.mjs` 加「临时会话只留定性块、不注入 AGENTS.md / 记忆 / 认知索引 / 工作区状态」。
- **二次审查后补的四处漏洞**（子代理只读审查发现，均已修 + 补断言）：① legacy / 磁盘回退模式下临时会话会跨重启存活（`loadLegacySessions` 补 `isTransientSession` 过滤）；② **起轮路径 `startSessionTurn` 会把空 workspace 回填成当前工作区**——临时会话发第一条消息就被收养，现加 `!isTransientSession(session)` 守卫（这是最常走的一条路）；③ 空临时会话切走不删是死代码（`isVirginSession` 只认标题「新会话」，而临时会话标题固定为「临时会话」，现放行 `AI_TEMP_SESSION_TITLE`）；④ 从临时会话派生支线 / 分支会变成普通持久化会话（`forkSettings` 继承 `temp`，分支与支线各自清空兜底绑定的 workspace）。另按审查意见让 `newTempSession` 与 `newSession` 一致地清理离开的空会话。

### 新增（AI 会话「数据整形」：180 MB 死锁会话的根治——vacuum 归档出栈 + 256 MB 语义反转 + 落盘预算化）

- **背景**：两个历史会话正文涨到 180.71 / 162.59 MB，超过 `AISessionRead` 的 64 MB 上限被拒绝加载，压缩 / 导出 / 清空全被同一堵墙卡死（只删不救）。方案与两轮调研记录见 `docs/unfinished-plans/session-compaction-disk-growth.md`（§5 定稿，S1→S2→S3 全部实施）。
- **S1 vacuum 归档出栈**：新绑定 `AISessionVacuum(id, force)` 把重放后处于归档态的消息搬进 sidecar `archive.v1.jsonl`（append-only，`m` 用 `json.RawMessage` 保字节原文），主文件原子重写为 header + meta + summary + live——live 段被 auto-compact 的 token 阈值结构性约束，主文件从此回到「结构性小于任何上限」的形状。Go 状态机与前端 `replaySessionLog` 逐事件同构（含 v 缺失视为 0、JS 真值、keep clamp、dedupeKey 折叠三条特性级行为），10 条固定夹具双侧测试钉死（`vacuum_parity_test.go` ↔ `ai-session-vacuum-parity.test.mjs`）。两步写（sidecar 追加 → 主文件替换）由 `archive.v1.jsonl.state` 清单做崩溃恢复；进锁重 stat 保证双窗口竞态下第二方 no-op。配套 `AISessionReadArchive`（分页读回）、`AISessionReadForce`（真空角落临时加载）、`AISessionArchiveClear`（清空会话连带侧车）。
- **消费点接线（先于入口开放）**：归档卡 / 命令面板「查看已归档消息」/ 导出 Markdown / 对话日志自动落盘 / `session_history` 工具查询全部改为「内存归档 + 侧车按需分页」；sessionindex 索引扫描拼接 sidecar（归档在前、主文件在后），归档正文搜索可达。
- **S2 上限语义反转**：`aiSessionReadLimit` 64 → 256 MB，超限不再「拒绝服务」——错误改带稳定前缀 `session-too-large:`，前端加载路径捕获后自动触发 vacuum 并重读，toast 一次「已自动整理」，此后永久回归常态；**任何体积的会话都能打开并继续聊**。拒载卡片只留给两类真失败：整理执行失败（「重试整理」）与 live 段自身超限（「临时加载」，`AISessionReadForce` 整份读入，载入后 `/compact` 回归常态）。列表不挂任何体积 UI（作者裁定）。
- **S3 降速**：整份重写收窄——重写前归档先经 vacuum 出栈，内存只清「已落盘为归档态」的登记前缀（`_archivedMids`），刚切进归档、尚未落盘的尾部保留在内存并随重写以 a:1 落盘（任何情况下不把内存归档从载荷排除——vacuum 只搬磁盘归档态，排除未落盘部分 = 丢消息）；vacuum 失败自动回退旧路径全量编码保数据；工具结果落盘预算化——超阈值结果全文落 `ai-artifacts/` 后，历史（JSONL 与内存）只留头 4 K + 尾 1 K + 指针（`persistBudgetText`，>4 MB 只留指针），请求组装对已预算消息透传；「长文本调研」型会话的磁盘增速降一个数量级。
- 护栏：Go `vacuum_parity_test.go`（10 条夹具双侧一致性 + 崩溃恢复 + 分页 + 前缀契约 + liveDominant）、`sessionindex` 拼接测试；前端 `ai-session-disk-tidy.test.mjs`（自动整理三分流 / 收窄与回退 / 手动整理 / 日志合并 / 预算化）、`ai-session-vacuum-parity.test.mjs`，均登记 `npm test`。全量 `go test ./...`、`npm test`、`npm run build` 通过；`dev/mock-backend.js` 同步补齐 4 个新绑定。

### 新增（内置数据库连接与浏览工具：SQLite 本地库 / MySQL 连接 / 受控写入，P0–P2 一次落地）

- **入口（一切皆标签，作者纠正后返工）**：活动栏新增「数据库」图标 → 侧栏面板列出**本工作区添加的数据库**（`settings.dbWorkspaceDatabases`，条目带 workspace 字段按工作区生效；按 SQLite / MySQL / MariaDB / 插件驱动分组可折叠）。顶部单一「**新建连接**」按钮 + 弹出菜单选类型（SQLite 库文件 / MySQL·MariaDB 连接 / 插件驱动）；MySQL 打开**对齐 JetBrains「数据源和驱动程序」的统一管理对话框**：左列表 +/−、右表单名称自动建议 `user@host:port`、主机端口并排、URL 预览、「加入当前工作区」开关，底部 测试连接 / 应用 / 确定）；**双击在内容区开「数据库」标签页**（视图型虚拟标签 `dbView`，一个标签 = 一个库会话，关标签即断开）；右键或行尾 `[...]` 菜单：打开 / 允许编辑（SQLite）/ 测试 / 编辑（打开连接管理并定位该连接）/ 删除连接（全局）/ 从工作区移除。标签页内仍为「对象树 | 表网格（面板内子标签）| SQL 控制台」三栏。总开关 `settings.dbToolsEnabled` 默认关，启用门在面板内。方案与实施记录（含入口重构 §11.6）见 `docs/unfinished-plans/db-connection-tools.md`（§11）。
- **能力**：打开本地 SQLite 库文件（对象树两级按需加载）；MySQL 连接管理（新建/编辑/测试/删除、密码 DPAPI 加密单独落盘、复合凭据键）；表数据网格（虚拟滚动、列头排序、结构化筛选、分页 500 行/上限 5000，排序筛选分页全下推为参数化 SQL）；SQL 控制台（多语句逐条分类、Ctrl+Enter、执行中可取消 `DBCancel`）；受控写入（连接级「允许编辑」开关 + dirty model → 提交预览（内联展示值 SQL）→ 单事务提交 → 乐观并发冲突整体回滚 → noCache 刷新；无主键表/视图一律只读，主键列不可编辑）。
- **安全**（P0 即埋，非事后补）：默认只读双保险——SQLite `mode=ro`（WAL 无读权限自动 immutable 兜底并显式标记）、MySQL `SET SESSION TRANSACTION READ ONLY` + 池限 1；查询路径逐条分类，任一条非只读整批拒——**数据变更 CTE（`WITH x AS (DELETE … RETURNING …)`）逐体检查**、未知语句 fail-closed 按写拒、PRAGMA 赋值判写、MySQL `INTO OUTFILE/CALL/GRANT/LOAD` 归危险；危险语句与缺 WHERE（含 WHERE TRUE / 1）走两阶段确认（guard 返回 confirm、前端确认后重发）；DDL 未开放；连接目标拒绝链路本地地址（IMDS 169.254.169.254）；写留痕 `db.exec` / `db.apply` 不含参数值与密码。
- **实现**：Go 引擎 `internal/dbclient/`（driver/guard/sqlite/mysql/session/query/edit/config 九文件，纯引擎 + 根壳 `dbclient_app.go` 薄绑定）；前端新域 `frontend/src/db/`（factory+deps）；SQLite 复用已在库的 `modernc.org/sqlite`（增量 0），MySQL 用 `go-sql-driver/mysql`（纯 Go ~0.6 MB，作者已批准 2026-11-22，全功能最坏 +1.5 MB 预算内）。
- **MariaDB 支持**：与 MySQL 协议兼容、同一引擎——连接管理对话框加「驱动」选择（MySQL / MariaDB），侧栏按所选分组显示；零新依赖。
- **插件驱动扩展点（其他数据库交给插件）**：`cadt.registerDbDriver({id, label, fields, connect})`——侧栏 [+ 插件驱动] 按声明的 fields 动态出连接表单（`type:'password'` 字段经 DPAPI 加密走 `DBCredentialPut/Get` 凭据库，绝不进清单与跨窗同步），内容区「数据库」标签页复用对象树/网格/控制台（会话门面与内置绑定同形，`db-plugin.js`）；kind 串 `plugin:<插件id>:<驱动id>`，插件禁用后打开引用条目明确报错。会话契约、上限（单插件 5 / 全局 20）与限制（HTTP 型直连、sidecar 走 registerService、裸 TCP 需下沉核心）见 `docs/plugins/README.md`「注册数据库驱动」；完整示例 `plugins/db-clickhouse-http/`（真实 ClickHouse HTTP 接口，零依赖）。护栏：`test/shell/plugin-db-drivers.test.mjs` 登记 `npm test`。
- 护栏：`internal/dbclient` 表驱动测试（分类/拆分/批量口径 + 真实 SQLite 端到端：只读拦截含 CTE bypass、下推浏览、截断判定、冲突回滚、会话上限回收、取消）；`frontend/test/db/db-model.test.mjs` 登记 `npm test`；接线守卫 `virtual-doc-wiring.test.mjs` 的 tabUnmount owners 清单纳入 `bridge-database-view.js`。全量验证：`go test ./...` 62 包、`npm test` 2324 例、`npm run build`、`tools/check-crossbuild.cmd` 三平台，全部通过。
- **AI 代配（app_control）**：新增 `db_list_connections / db_save_connection / db_delete_connection / db_test_connection` 四动作——AI 可代用户新建、更新、删除数据库连接并测试连通性（保存/删除**必弹动作审批卡**；密码经 DPAPI 加密落盘、不进对话回显；工作区引用走与侧栏同一套清单语义，纯函数层 `db-registry.js` 共用）。技能表、APP_ACTIONS、runAppAction 三处对齐（守卫 `ai-app-actions.test.mjs`）。
- 已知边界：Redis 不在本期（P3 按方案单独立项）；SSH 隧道、ERD、跨库迁移不做（§9）；行定位只认主键（唯一索引不做）；DDL 恒拒；密码仅在打开连接对话框内输入、不回显不进日志。

### 修复（重启遗留的卡片，模型把「等待用户回答…」当成已有结果）

- **现象**：应用在等用户回答 / 审批 / 填变量时被关闭，重开后卡片显示为终态（「已过期」「已取消」），用户以为自己只是错过了；但模型那边收到的是一条**内容为「等待用户回答…」的已完成工具结果**，于是把「还在等」读成「已有答案 / 已批准」，按猜测继续跑。
- **成因**：卡片数据确实落盘了，重放也把状态收敛成终态；但正文只在**为空时**才替换，而这三类工具注册时都写了占位正文（`等待用户回答…` / `等待用户审批…` / `等待用户审批命令…` / `等待用户填写变量值…`），于是占位原样进了模型上下文。「正文为空」这个前提多数情况下根本不成立。
- **修复**：`ai-constants.js` 新增三条按语义拆开的文案——`ASK_LOST_TEXT`（答案未知，需要就用 `ask_user` 重问）、`APPROVAL_LOST_TEXT`（没收到决定，操作没执行）、`ENV_ASK_LOST_TEXT`（变量没创建）；重放分支改为**无条件**整句替换。顺带补上一个漏网变体：审批分支原先只认「等待用户审批…」，命令审批与 AI 分类器的另两种占位会原样漏出。卡片文案「页面已关闭，问题未回答」改为「应用重启，这个问题没收到回答」。
- 护栏：新增 `frontend/test/ai/ai-replay-recovery-guard.test.mjs`（源码断言：三类卡片必须走 `*_LOST_TEXT`、旧文案不得复现，已登记 `npm test`）；`ai-constants.test.mjs` 增一例（不得沿用注册占位、必须说清「没收到」、三条文案不得合并）。`npm test` 2294 通过、`npm run build` 通过。
- 说明：卡片上「让 AI 重新问一次」的按钮**评估后不做**——四家竞品都没有卡片复活，且它与「继续回合」是同一条通路，缺的只是「别让模型自欺」这一半，本次已修完；理由与实施手册在 `docs/finished-plans/interactive-card-restart-recovery.md`（§4.2 / §5.2-5.4）。

### 修复（操作留痕把自动放行记成「用户批准」）

- **现象**：设置 → 操作留痕里，规则放行、家族放行、git 快捷、端侧 / 云端分类器放行、完全权限直通的每一笔 `ai.approve` / `ai.deny`，actor 徽标都显示「用户」——审计上分不清是**人拍板的**还是**系统自动放行的**，而「谁批的」正是审批复盘与出事追责的第一问。
- **成因**：`logPermission` 落盘时把 actor 写死成 `'user'`，只用 `source` 字段区分来源；留痕页按 actor 打徽标并支持按 actor 筛选（`settings/activity-pane.js` 的 `ACTIVITY_ACTOR_LABEL = {user, ai, system}`），于是后端数据与前端语义各说各话。
- **修复**：`frontend/src/ai/ai-permissions.js` 新增纯函数 `permissionAuditActor(source)` 按判定来源归属 actor——`user` / `project` / `session`（用户在卡上拍板，或用户预写的规则与会话授权）归 `user`；`readonly` / `family` / `git-flow` / `classifier` / `local-classifier` / `full` / `auto` 归 `ai`；`worktree-isolation` / `agent-worktree` / web 内置 `default` 归 `system`；**未知来源归 `ai`**（宁可少记人的功劳，也不能把一次自动放行记成人工批准）。`logPermission` 改用该函数，`internal/activity` 的 actor 白名单本就含 `ai`，**无 Go 变更、无 schema 变更、存量记录不改写**。
- 护栏：`frontend/test/ai/ai-permissions.test.mjs` 新增两例（逐来源归属含空值 / 未知值回落；与 `decidePermission` 实际产出的自动来源对齐，断言自动判定一律不是 `user`）。全量 `npm test` 2289 通过、`npm run build` 通过。
- 背景：该缺陷是在评估「用户委托代理（让另一个模型代点审批）」时顺带发现的，那份方案本身已复评否决并归档到 `docs/reports/user-delegate-agent.md`。

### 改进（桌面控制按会话启用 + 控制模式声明，全面简化 windows-mcp 使用路径）

- **背景（2026-11-22 用户要求）**：旧形态门槛太多——要先去 MCP 列表勾工具、再在输入框点亮「桌面」pill（应用级单飞）、再让模型调 `windows_desktop` 揭示具体工具；用户侧表现为「设置里一堆按钮 + 输入框一个莫名其妙的『桌面 · 8』」，且一次只能一个会话持有。
- **新模型三层**：① 安装（应用级，外部工具页）：只有一个「启用桌面控制」开关 + 「安装…」按钮，未安装时开关禁用；安装一步到位写入 mcp.json（`enabled` + 白名单工具勾选）并跑官方 uv 安装脚本 + `uvx windows-mcp` 预热依赖（新增 Go 绑定 `MCPDesktopInstall`，windows/other 成对）。② 会话启用（`session.desktopEnabled`，与 planMode / worktree 同族）：入口收进 composer 的权限面板（新增「桌面控制」行，与计划模式 / 隔离工作区并列），用户手动开启弹二次确认（完全权限同款外观与通道），关闭不弹；AI 经新增的 app_control 动作 `request_desktop_control` 申请时**必弹危险审批卡（完全权限也不例外）**。取消应用级单飞：按会话独立，多会话可同时启用。③ 控制模式（新工具 `windows_control_mode`，进出都不审批）：进入后白名单桌面工具（快照 / 点击 / 输入 / 滚动 / 剪贴板）才全量注入工具表，面板顶部（标题栏下方居中）浮出跑马灯「AI 正在控制你的电脑」，标题胶囊区在「智能体团队」左侧点亮红色「桌面控制中」；退出或用户点胶囊立即收回。
- **移除**：composer 的「桌面 · N」pill、`windows_desktop` 揭示工具及其全部揭示/匹配逻辑（`matchDesktopDefs` / `formatRevealResult` / `revealedBySession`）、应用级单飞与 `desktop-grant-changed` 的抢占语义（事件保留，payload 改为 `{sessionId, enabled}` 供多窗口刷新）。取消揭示层的理由：控制模式本身就是显式闸，再叠一层两次往返的揭示只会多一个前置与「并行调用必被拒一次」的坑；成本只在地控制模式期间支付（7 份 schema），退出即移除。
- **设置项**：设置 → AI → 权限 → 新会话 下新增「默认桌面控制」（默认关；桌面未安装时禁用；开启时二次确认），只对新建会话生效——新会话创建时按它置 `desktopEnabled`，AI 仍需 `windows_control_mode` 才动手。
- **护栏**：重写 `frontend/test/ai/ai-desktop-control.test.mjs`（会话级启用 / 控制模式进出 / 会话说隔离 / 配置行一步到位）；`ai-tool-wiring` 的档位并集用例改注入 `desktopEnabledOn`；`external-tools-page` 守卫保持不变。全量 `npm test` 通过、`npm run build` 通过、`go build ./...` 通过。

### 修复（外部工具页的 MCP 总开关与服务器列表根本不渲染）

- **成因（2026-11-22 用户反馈）**：MCP 服务器组（总开关 + 服务器列表）从设置弹层迁到「应用页面 → 外部工具」后，按配置渲染它的 `mcpSettingsMod.render()` 只挂在 `ai-panel.refreshSettings()` 上，而后者只在设置弹层切到 AI 相关子页时触发——外部工具页 mount 时谁都没按 `mcp.json` 渲染一次。于是页面永远停在 `index.html` 的静态初值：开关显示为关、`#ai-opt-mcp-list` 空白（四个已连接的服务器与「工具」按钮全不见），点开关时闭包里 `config` 还是 `null`、`change` 处理器第一句 `if (!config) return` 直接返回（只改了 DOM 视觉），重开标签就弹回。
- **修复**：`settings-pane-external-tools.js` 的 `mount()` 在搬运 DOM 后调 `ai-panel` 新增的 `renderMcpSettings()`（内部走 `mcpSettingsMod.render()`——含 `loadConfig`，不是只重绘的 `renderAll`）；`main.js` 新增 `ensureAiPanel` 注入，AI 面板惰性初始化（用户没开过面板就点开该页）时先建面板再取，避免拿到 `null`。`ai-mcp-settings.js` 的开关 change 补兜底：`config` 缺失时先补读一次配置，仍失败则回弹勾选并提示「配置读取失败」，不再出现「看着打开了其实没写」的假象。
- 护栏：`frontend/test/settings/external-tools-page.test.mjs` 新增 1 例接线守卫（mount 必须调 `renderMcpSettings` / 面板经 `ensureAiPanel` 取 / ai-panel 的暴露面必须走含 loadConfig 的 `render` / main.js 必须注入 `ensureAiPanel`）；该测试 11/11、`ai/ai-mcp-settings.test.mjs` 8/8 通过，`npm run build` 通过。

### 改进（重启后恢复上次的个人浏览器标签）

- **行为**：「我的浏览器」（固定 profile 的个人浏览器）标签页现在参与关闭保存与启动恢复——开着网页直接关应用，重开后标签自动续上（登录态在 profile 磁盘里本就保留）；关掉个人浏览器标签 = 用户不想看它了，不再恢复（登录态仍在，重开不用重新登录）。普通临时浏览器标签与 AI 会话浏览器不恢复（两者 profile 目录随随机 tabId 走，恢复出来是未登录空白页，P1 另评估，方案 §2/§4）。
- **实现**：新增 `frontend/src/shell/browser-tab-restore.js`——快照存 localStorage `cadt.browser-tabs.v1`（全局单份，只存地址列表、过滤 about:blank、上限 20）；实例确认打开成功（onOpened）、已开着再导航、`browser-nav` 地址变化、`closeDocNow` 关标签四处通知保存；**只有实例确认打开成功的窗口才写 key**——打开失败回滚（实例被别的窗口占用）绝不覆盖存档，其他窗口与悬浮窗/控制台退出也绝不覆盖；启动编排 `restoreSession` 之后仅主窗口恢复，多窗口并发用轻量 owner 租约（15s TTL + 5s 心跳，释放仅当 owner 是自己）串行化，恢复前再以 Go 侧 `BrowserState` 做保险（实例已在别的窗口活着就跳过）。方案见 `docs/finished-plans/browser-tab-restore.md`。
- 护栏：新增 `frontend/test/shell/browser-tab-restore.test.mjs`（已登记 `npm test`）：归一化/序列化往返/坏数据容错、写权判据（回滚不清存档、未确认导航不落盘、未持有窗口退出不覆盖、悬浮窗不写）、开/导航/关生命周期、租约对账（无 owner 获取 / 未过期跳过 / 过期接管 / 释放后可接管 / 不偷别人租约）、BrowserState 跳过、openBrowserTab 缺失分支、接线护栏（main.js getter 注入 / browser-nav 通知 / bridge-ui 恢复调用点与 onOpened 通知点 / editor-groups 关闭通知点 / PERSONAL_BROWSER_ID 两处同值）。

### 修复（确认对话框长文件名撑出横滚条）

- **成因（2026-11-22 用户反馈）**：确认框正文 `#dlg-confirm-text` 是 `.dialog-body`（flex + `overflow:auto`）的直接子项，只有 `white-space: pre-line`；flex 子项默认 `min-width:auto`，超长无空格串（如反复拼接的 `ai_image_policy_app…` 文件名）的 min-content 宽度就是整串宽度，撑破 430px 容器出现横向滚动条。
- **修复**：`style.css` 给 `#dlg-confirm-text` 加 `overflow-wrap: anywhere; min-width: 0;`——允许任意字符断行并让 flex 子项正常收缩，长文件名完整换行显示、不再横滚；`pre-line` 保留（清除确认的多行分行不受影响）。纯 CSS 改动，`npm run build` 通过，浏览器最小复现验证修复前溢出、修复后不溢出。

### 改进（四个应用页面现代化重设计）

- **背景**：外部工具 / 定时任务 / 操作记录 / 补丁库搬进内容区标签页后，骨架仍是设置面板的 `.set-card` 纵向堆叠——信息密度低、没有详情、没有状态反馈。用户 2026-11-22 要求重设计，取舍：各页定制、只统一视觉 token；设置项留设置页 + 页内「去设置」跳转；前端 UI + 必要后端增强。
- **共用基础**：新增 `frontend/src/app-pages/ui-kit.js`（页头 / 状态徽标 / 命令栏防抖搜索 / 筛选 chips / 状态块 / 详情抽屉 / 相对时间 / 复制 / 图标按钮），全部走 `core/form-controls` + `core/icons` + `core/overlay-stack`，零新依赖；`style.css` 补 `.ap-*` token 类，颜色全走主题变量。
- **外部工具**：能力矩阵改响应式卡片网格 + 有效性徽标；保存加「保存中 / 已保存 / 失败」状态反馈（竞态序号只让最后一次更新）；修复 MCP 工具面板每次 `renderAll` 复用节点导致的监听器累积（改为每次重建 panel 节点）。
- **定时任务**：竖排 nowrap 改列对齐排程表（下次触发含相对时间 / 状态徽标 / 权限 / 操作）；筛选 chips + 搜索 + 空态 CTA；编辑器改用 `form-controls` 工厂（修复裸控件违规）；`schedules-changed` 订阅补刷新应用页标签（修复跨窗口陈旧）。
- **操作记录**：日志表格（日期分组 / 中文动作名 / 格式化 JSON 详情 / 复制 / 相对时间）；命令栏防抖搜索 + 清除筛选；Go 侧 `ActivityRead` 新增 `beforeSeq` 复合游标（ts+seq 消除同毫秒重复/漏，旧 `beforeTs` 单游标兼容）；页内「去设置」跳转保留 settings-tree 反射契约。
- **补丁库**：卡片列表 + 状态筛选 + 搜索 + 排序 + 前端分页（显示总数）；整行可点开详情抽屉（元信息 / 文件列表 / 打开补丁视图 / 撤销 / 删除）；去掉嵌套滚动；时间含相对时间。
- **护栏**：新增 4 个页面接线守卫测试（`ai-schedule-page` / `activity-pane` / `patch-store-page` + 扩 `external-tools-page`），均登记 `npm test`；Go 侧新增复合游标表驱动用例。全量前端 2264 例通过、Go 全量通过、`npm run build` 通过。
- **说明**：补丁库分页最终在前端做（`PatchList` 一次取 500 + 前端筛选/排序/分页），未改 Go 绑定签名——实测前端全量取数已足够，避免扩大后端改动面。

### 修复（一次 Enter 发出两条消息，第一条还标「已停止生成」）

- **成因（2026-11-22 用户反馈）**：提交链路没有防重入。一次轻按 Enter 可能派发两次 keydown（键盘重复 / 中文输入法确认候选词的双事件），而 `submitText` → `startSessionTurn` 从入口忙检查（`ai-panel.js:11934`）到 `attachStream` 注册流（`ai-panel.js:12123`）之间有一串 `await`（`whenIdle`、回合租约、上下文组装）；窗口内流还没注册、输入框也还没清空（清空在 `onStarted`，`ai-panel.js:12187`）。第二次读到同样的文本再起一轮，两个 `startSessionTurn` 抢注册流，落败方在 `ai-panel.js:12198` 的守卫处把占位 assistant 标成 `stopped`——用户看到的就是「两条同样的消息，前一条已停止生成」。
- **修复**：`ai-composer.js` 的 `submitFromComposer` 加 `submitInFlight` 防重入锁，持有到 `submitText` 的 Promise 落定（起轮并清空输入区）才释放，锁在 `finally` 里放，同步抛错也不会把输入区永久卡死；`sendComposerMessage` 的直发分支改为 `return submitText(text)`，把异步提交的 Promise 交回锁（不返回的话锁立刻释放，双发照样能发生）。`handleComposerKey` 的 Enter 分支补 `if (e.repeat) return;`，按住 Enter 的键盘重复事件不再算新的发送意图。排队 / 插话 / 抢占是同步完成的（当场清输入区），不受锁影响。
- 护栏：新增 `frontend/test/ai/ai-composer-submit-guard.test.mjs`（已登记 `npm test`）源码断言钉住五处接线——锁存在于取文本前、锁在 `finally` 释放、直发分支返回 Promise、Enter 挡 `repeat`、输入框 keydown 只绑定一处；dev 环境实测「连续两次 Enter」修复前出两条、修复后只出一条。

### 改进（计划批准卡支持临时收起 / 展开）

- **变更**：计划批准卡（composer 接管区）与 ask_user 提问卡、工具审批卡对齐——头部新增收起按钮，点击折成单行细条（plan 图标 + 「计划等待批准 · 计划标题」），点击细条恢复完整卡；「执行计划 / 继续规划」与收起状态互不影响。
- **实现**：`ai-takeover.js` 的 `createAITakeover` 闭包内维护 plan 折叠 key + 标志，换一条计划（key 变化）自动复位展开；收起细条复用现有 `.ai-takeover-bar` / `.ai-takeover-collapse` 样式，`style.css` 补一条 plan 头部收起按钮紧跟 mode 徽标的 margin 规则。纯前端改动，零 Go 变更。
- 护栏：`ai-takeover.test.mjs` / `ai-plan-file.test.mjs` 28 例通过、`node --check` 通过。

### 修复（frontend/nul 反复出现导致快照告警刷屏）

- **成因（2026-11-22 用户反馈，第二次出现）**：`> nul` 是 cmd 惯用法，但在 Git Bash 下重定向会落地成真文件；`npm test` 在 `frontend/` 下跑就生成 `frontend/nul`（Windows 保留设备名，187 KB npm test 日志）。`.gitignore` 原有的 `/nul` 只匹配仓库根，漏掉 `frontend/nul`——git 把它列为未跟踪文件，`git add -A` fatal，L3 定期快照每 10 分钟跳过一次并刷「快照跳过 1 个无法索引的文件」告警。
- **修复**：`.gitignore` 的 `/nul` 改为不带前导斜杠的 `nul` / `NUL`，覆盖任意层级（实测 `git check-ignore` 命中 `frontend/nul`、`git status` 不再显示、`git add -A` 干净退出）。文件本身需以 `\\?\` 前缀删除（Win32 常规 API 打不开保留设备名）。
- 说明：快照侧早已有单文件跳过重试兜底（`gitAddAllWith`），本修是消除根因——让 git 根本不碰这类误产物，告警不再产生。

### 杂项（AOCI 退役，内置认知索引成为单一事实源）

- **背景**：本仓自 2026-11-19 起由宿主侧 AOCI（FSL-1.1-MIT source-available）维护并行认知索引；2026-11-22 内置认知索引（`internal/cognition` + `cognition_read/edit/status`）实施完成并建成（177 条 / 39 KB，drift 四态全 0），两者功能重叠且 AOCI 与 Apache-2.0 定位有张力、55 MB 运行时产物入库。作者决定退役 AOCI、保留内置索引为单一事实源。
- **清理**：删除 `aoci.txt` / `aoci.meta.txt` / `aoci.code.txt` 与 `.aoci/` 整目录（drafts/baseline/fingerprints/ledger 等）；删 `AGENTS.md` 末尾 14 KB AOCI 接入契约块；`.gitattributes` 保留 LF 规则但改为通用说明、`.gitignore` 删 AOCI 忽略边界注释；卸载 aoci MCP server；清 README / tutorial 里的 AOCI 示例、两份 ignore 表的 AOCI 死规则。
- **文档**：方案 `docs/unfinished-plans/ai-cognition-index.md` 移入 `docs/finished-plans/`，状态行与 §7 P3 / §9 的双索引描述改为「已退役」；同步 AGENTS.md / CHANGELOG / `ai-cognition.js` / `ai-tool-defs.js` / `cognition.go` 的方案路径引用。

### 修复（使用统计图表宽度变化不重建）

- **成因（2026-11-22 用户反馈）**：趋势图 / 环形图是 ECharts 实例，只在 `window.resize` 时调 `.resize()`，但侧栏展开收起、编辑器分栏拖动、标签页宽度变化都不派发 `window.resize`——容器变窄了图表仍保持旧宽度，看起来像「不重建」（热力图是 CSS Grid 固定 53 列 + 横向滚动，不受影响）。
- **修复**：`settings-pane-usage-stats.js` 改用 `ResizeObserver` 直接观察 `#us-trend` / `#us-donut` 两个容器，覆盖所有「窗口没变但容器变窄」的宽度变化；`window.resize` 保留作宿主不派发 RO 回调时的兜底，两者共用同一 120ms debounce；卸载时对称 `disconnect()` + `removeEventListener()` 并重置 `resizeBound`，避免重挂重复绑定与实例泄漏。
- 护栏：`frontend/test/settings/usage-stats-pane.test.mjs` 补 2 例接线守卫（RO 观察两个容器 + 保留 window.resize 兜底 / 卸载对称解绑），已登记 `npm test`；该测试 6/6 通过、`npm run build` 通过。

### 修复（多窗口点侧边栏图标两窗来回闪一下）

- **成因（2026-11-22 用户反馈）**：两个成因叠加。① `applySettings` 是所有设置写入的高频统一出口（侧边栏四 icon 都经 `toggleSidebarView` 触发），其中 `applyAlwaysOnTop` 每次都无条件调 `WindowSetAlwaysOnTop`；Wails v3 的该实现落到 `SetWindowPos(HWND_TOPMOST/NOTOPMOST, SWP_NOMOVE|SWP_NOSIZE)` 时会**把窗口无条件提到本档 Z 序最顶——值没变也一样**（win32 实测，MSDN「NOTOPMOST 对已是非置顶窗口无效果」在 Win11 26300 不成立）。② 当日新加的跨窗口设置同步广播全量快照，而 `mergeSettingsInto` 按 `Object.is` 逐键比较——对象键（`runArgs`/`runConfigs`/`runProfiles`/`langEnv`/`formatSettings`）是 `JSON.parse` 新引用，永远「有变更」，于是接收窗全量重绘并触发 `applyAlwaysOnTop`（跳到前台），发送窗自己的回声同样误报变更再重绘一次（顶回前台）——任一窗口点侧边栏图标即两窗各跳一次，表现为「来回闪一下」。底部 dock 四 icon（终端/调试/运行/图谱）不走 `applySettings`，所以不闪。
- **修复**：① `applyAlwaysOnTop` 记住上次应用的置顶值，值未变不调用运行时（启动首应用与真实开关行为不变）；② `mergeSettingsInto` 对纯对象/数组键改为结构化深比较（键序无关、数组序敏感、非 plain 对象不假相等），内容没变不写入、引用原样保留——回声与同源广播幂等归零；③ 布局/模式/选择键改为**每窗口独立**：侧栏显隐/视图/模式/宽度、终端 dock 高度、git 提交区高度、AI 面板开合/宽度/停靠侧/形态、分栏比例、结构面板来源、窗口置顶、写作模式总开关、当前激活的运行配置（`PER_WINDOW_LAYOUT_KEYS`，判类规则见 settings-sync.js 注释：窗口自身形态 → 每窗独立，偏好与数据 → 全局同步）跨窗合并前剥掉（`applyRemoteSettings` 是广播与方案 C 重读的共同必经点）——点侧边栏图标、置顶窗口、进写作模式、选运行配置都不再镜像到别的窗口；localStorage 共享单槽语义不变，重启后取最后写入者的值（与引入同步之前一致）；④ 设置持久化收敛为三条通道并钉死——`applySettings`（全量重绘+落盘+广播）/ `persistSettingsLight`（新增，只落盘+广播，供拖分割线、`rememberScratchExt` 等高频小改动）/ `applyRemoteSettings`（唯一合并入口）；`editor-split-preview` 分栏拖动、`structure-panel` 两处、`rememberScratchExt` 四个历史直写 `localStorage` 的散点全部改走轻量出口（其中 `scratchExt` / `structureExportLineNums` 是偏好键，直写漏广播会让别的窗口内存副本停在旧值——正是同步要修的病）。
- 护栏：`test/settings/settings-sync.test.mjs` 补 7 例（深比较语义 4 例 + 布局键剥离 3 例：剥键不改入参、畸形输入、合并语义端到端）；新增 `test/settings/settings-windowops.test.mjs`（已登记 `npm test`）源码断言钉住「`applyAlwaysOnTop` 值未变不调用运行时」「`mergeSettingsInto` 不得用 `Object.is` 直比对象键」「合并入口必须过 `stripPerWindowLayout`」+ 统一入口扫描「`settings-changed` 广播全仓仅 settings-ui.js 一处」「`localStorage.setItem(settingsKey…)` 禁止出现在 settings-ui.js 之外」「`mergeSettingsInto` 调用全仓仅一处」「`PER_WINDOW_LAYOUT_KEYS` 每键真实存在（防拼写漂移）」；AGENTS.md 前端侧新增「设置同步硬规范」。

### 修复（多窗口设置不同步：窗口2开启认知索引，窗口1设置页仍显示关闭）

- **成因（2026-11-22 用户反馈）**：设置持久化在共享 `localStorage`（`datalens-settings`），但每个窗口只在启动时读一次到内存 `settings` 对象，之后不重读、也无跨窗口通知。窗口2经 AI 审批卡开启认知索引后写入 localStorage，窗口1的内存副本仍是启动时的 `false`——设置页复选框与 `aiCognition` 工具下发全按旧值走。影响**所有设置项**，认知索引只是最易触发的那个。
- **修复（B+C，覆盖全部设置项，纯前端零重建）**：① `settings-changed` 登记为 app 全局事件；`applySettings()`（所有设置写入的统一出口，含 `cognition_toggle` 审批卡与 AI 设置页手动开关）写完 localStorage 后经 `rt.EventsEmit` 广播全量快照；② 各窗口 `appEvents.onApp('settings-changed')` 收到后把快照**原地合并**进现有 settings 对象（`mergeSettingsInto`，保持 ai-panel 等持有者的引用有效）并重绘——发出的窗口自己也收，按值比较无变化即跳过，幂等防环；③ 方案 C 兜底：打开设置页前先从 localStorage 重读一次再渲染，覆盖广播错过 / localStorage 共享的场景。
- 护栏：`settings-sync.js` 纯函数 + `test/settings/settings-sync.test.mjs`（原地引用 / 同值幂等 / 畸形快照），`event-scope.test.mjs` 登记新事件；前端 2217 测试全绿、`npm run build` 通过。

### 改进（认知索引支持 .cadt/cognition/ignore.txt 作用域排除）

- **成因（2026-11-22 用户反馈）**：`cognition_status` 的 Missing 漂移按「工作区有文件而索引没条目」全量计数——但工作区不是所有文件都值得建条目，生成物 / 构建产物 / 数据文件报 Missing 纯噪音，没法像 `.gitignore` 一样收窄。
- **落点（作者裁定：写进卷目录而非工作区根）**：作用域排除文件 **`.cadt/cognition/ignore.txt`**（gitignore 简化语法：`#` 注释 / `!` 取反后匹配覆盖 / 不含 `/` 按路径段名匹配任意层级 / 含 `/` 按相对根路径 glob），从**清单层面**排除文件与目录（`ScanWorkspace` 剪枝 + 跳文件）：被排除文件不再报 Missing；已有条目指向被排除文件按 Orphan 收敛；文件在卷目录里 = 天然落 `.cadt` 整树排除之下，自身永不进清单（无自指）。解析与匹配复用 `internal/search` 的排除表机器（新抽象 `LoadIgnoreRulesAt(path)`，按「路径 + mtime」缓存、改动后下次扫描自动生效），与 `.cadt/config/search-ignore` **刻意解耦**——可搜索 ≠ 可索引。
- **AI 创建通道**：`.cadt/cognition` 整树是 write_file/edit_file 拒绝路径，模型不用也不会猜路径——`cognition_edit` 新增 **`ignore` 参数**（整卷替换、与 meta 同款 CAS 校验；预算 100 行 / 单行 200 rune 超限整体拒绝不动盘；不校验 glob 语法——本方言字面字符恒 QuoteMeta，「写错语法」最坏是排除不到、下轮可改；**进指纹三段** meta‖code‖ignore，排除表改变作用域其他窗口 base 失效逼重读；写管线排 meta 之后，半写态最坏是排除表丢失、无破坏性）。
- **现场提示（如何让 AI 知道能创建）**：`cognition_status` 响应在「Missing ≥ 20 且排除文件不存在」时自带 hint——模型正盯着 Missing 看的时刻给出口，指明 ignore 参数通道与语法要点；低于阈值不催、已有文件不重复提示。`cognition_status` 描述与 `<cognition_rules>` 守则同步指向该 hint。
- 护栏：`internal/cognition/drift_test.go` 补排除文件场景表（目录整树 / 按名通配 / 路径 glob / 取反重含 / 自身不进清单 / 无文件行为不变）+ `TestIgnoreListPrunesOrphansIgnoredEntries`（排除后条目收敛 Orphan）；`service_test.go` 补 `TestEditIgnoreParam`（ignore-only edit / 文件落卷目录 / CAS / 指纹前移与 status 读回一致 / 预算拒绝）与提示三态；`parse_test.go` 补 `TestParseIgnoreText`（规整 / 空文本 / 预算）；`internal/search/ignore_test.go` 补 `TestLoadIgnoreRulesAtArbitraryPath`。cognition / search 双包与全仓 `go test` 通过、前端全量 2224 例通过（工具接线守卫按 PROSE_TOKENS 登记「ignore 为 cognition_edit 的参数」）。

### 修复（应用页面标签页整体居中；使用统计整页贴边）

- **成因（2026-11-22 用户实测）**：① `.apppage-root` 只有 `max-width: 1100px` 没有 `margin: 0 auto`，窗口一宽所有应用页面左对齐贴着侧栏，非常难看；② 使用统计的 mount 把 `.us-root` class 加在宿主 `.apppage-root` 元素身上（同节点合并），`.us-root` 里设置页遗留的内边距 `padding: 4px 2px 20px` 同特异性、声明更晚，把宿主的 `padding: 14px 16px 22px` 压掉——整页左右上下全贴边；同文件的 `.apppage-root > .us-root` 重置规则写的是「子元素」形态，从来匹配不上。
- **修复**：`.apppage-root` 补 `margin: 0 auto` 整体居中；`.us-root` 去掉遗留 padding（留白统一由宿主给），删除从未命中的子元素重置规则；usage-stats 注释标注「us-root 不得自带 padding」防回归。外部工具 / 定时任务 / 操作记录 / 补丁库的宿主均无自带 padding 的 class，一并受益于居中。
- 护栏：`frontend/test/settings/usage-stats-pane.test.mjs` 补负向断言（`.us-root` 禁 padding）与宿主三属性断言（padding / max-width / margin auto），已登记 `npm test`。

### 改进（AI 输入框长文本粘贴：彩色胶囊 + 可编辑全文标签页 + 三档设置）

- **变更**：粘贴超过 1000 字符的纯文本时，默认在光标原位折叠成一个彩色胶囊（如「文本1：【胶囊】文本2」的前后文位置完整保留），附件区不携带任何内容；点击胶囊打开**可编辑**虚拟标签页查看/修改全文，编辑内容经 `openVirtualDoc` 的 `onChange` 回调实时写回，发送时胶囊原位展开成（可能已编辑的）全文。
- **三档设置**：设置 → AI → 聊天行为 →「长文本粘贴」：`collapse` 折叠胶囊（默认）/ `attachment` 整段转附件（正文不留位置，ZCode 款）/ `off` 原样全文键入（dsh 款）。每次粘贴即读设置，下次粘贴生效。
- **实现**：胶囊沿用群聊 @ 提及的「文本是唯一真源、镜像层画不透明底胶囊」方案（`ai-paste.js` 纯函数 + `ai-composer.js` 镜像层/原子删除/展开 + `style.css` 彩色胶囊），避开 IME 组合期整段隐形坑；展开覆盖直发/排队/插话/抢占四条发送路径；手打同形标记不误展开。
- **护栏**：`frontend/test/ai/ai-paste.test.mjs`（11 例纯函数：阈值边界、标记扫描、镜像 HTML 转义、展开、光标命中、行数），已登记 `npm test`；前端全量 2193 例与 `vite build` 通过。

### 改进（计划批准卡新增「在隔离区中执行」开关）

- **变更**：计划批准卡左下角原静态提示「批准后开始执行」换成开关「在隔离区中执行」（默认关）。勾选后点「执行计划」会先创建一个隔离 git worktree（`.cadt/worktree/<slug>/`），再让 AI 在隔离区里执行；不勾选行为完全不变。只读档禁用该开关并提示先切到「每次询问」及以上。
- **实现**：① 批准卡开关经 `createSwitch` 创建，勾选值随 `acceptPlan(session, grants, {inWorktree})` 透传；② 面板包装层在**计划落盘前**建隔离区（复用 `worktreeMod.createForSession`，传 `skipConfirm` 免二次弹窗、`allowRunning` 绕过刚停流的守卫），创建失败即返回、审批卡保留可重试——避免落盘后无法回滚；③ 批准指令按勾选差异化：勾选时明确告知隔离区路径、主根只读、改动只写隔离区、完成后经 `worktree_manage(action=export)` 回灌（两种文案共用「计划已批准，请立即按」前缀，历史会话识别不受影响）；④ `createForSession` 新增 `skipConfirm` / `allowRunning` 两个可选参数，既有调用点行为不变。纯前端改动，零 Go 变更。
- 护栏：`frontend/test/ai/ai-plan-worktree.test.mjs`（7 例：指令差异化纯函数 + 开关默认关 / 透传 / 建区早于落盘 / 两选项接线），已登记 `npm test`。前端全量测试与 `vite build` 通过。

### 修复（智能体团队标签页：支持折叠，层级超过 8 连线不再错乱）

- **成因（2026-11-22 用户实测）**：团队详情视图（`ai-team-view.js`）把 `flattenAgentTree` 的折叠回调写死为 `() => false`，从未接入折叠态，卡片无法收起；连线只按封顶后的 `--atl` 在固定列画一条竖线 + 横线，既不画祖先列的贯穿竖线、也不区分末子节点，层级超过 8 后深层连线全挤在同一位置、断裂重叠成一团。
- **修复**：① `flattenAgentTree` 行数据增加 `key / guides / isLast`（祖先列是否有后续兄弟、自身是否末子），纯函数可单测；② 团队视图每个实例维护折叠 `Set`，卡片前加折叠箭头（有子节点才有，叶子用等宽占位对齐），点击切换并重绘、保持焦点与滚动位置；③ 连线改为按 `guides` 逐列画贯穿竖线、末子竖线止于行中心，层级封顶时深层落在同一列形成阶梯而非重叠。
- 护栏：`frontend/test/ai/ai-agent-tree.test.mjs` 补 2 例（连线字段 / 折叠后代清理），已登记 `npm test`；全量测试与 `vite build` 通过。

### 改进（外部工具迁为应用页面标签页；应用页面目录行体验）

- **迁移**：设置 → AI → 外部工具 整体迁为「应用页面」内容区标签页（与使用统计 / 定时任务同族）。内容 DOM 常驻 index.html 尾部的 `#extcap-park` 停靠区，`settings-pane-external-tools.js` 的 mount/unmount 搬进 / 搬出标签页容器——保持节点身份，`ai-mcp-settings.js` 启动时按 id 捕获的引用与事件绑定跨开关标签页始终有效；容器加 `.extcap-root` 沿用设置 pane 的纵向节奏；MCP 世代事件只在标签开着时刷新（`refreshExternalToolsPaneIfVisible` 改判 `doc.appPage`）。
- **AI 文案同步**：技能表与工具描述里的指引路径统一改为「应用页面 → 外部工具」；`open_settings` 的 pane 清单对齐当前实际子页（外部工具 / 定时任务已不在设置弹窗，补 app-pages / envvars / storage / new-file-menu）。注意：MCP 与能力来源各行随页离开设置树，AI 对 MCP 服务器仍走 get/set/delete_mcp_server 专用动作。
- **图标对齐**：设置导航「应用页面」的清单图标（≡）换为与侧栏活动栏同款四方格——新登记 `core/icons.js` 的 `apps` 图标（20 网格按 0.8 缩到 16 网格）。
- **目录行**：设置 → 页面 → 应用页面 点行（或「打开」按钮）在内容区开标签页后顺带关闭设置弹层；目录行补页面图标；hover 从贴边直角大色块改为圆角内收（负 margin 换呼吸空间）并去掉行分隔线。
- 护栏：新增 `frontend/test/settings/external-tools-page.test.mjs`（APP_PAGES 注册 / 停靠区与导航断言 / mount 搬运契约 / 关弹层接线 / 下拉增强覆盖 / CSS 契约），已登记 `npm test`。前端全量 2191 例通过。

### 修复（plan 模式下抢占失效：消息停在排队框发不出去）

- **成因（2026-11-22 用户实测）**：抢占（Ctrl+Shift+Enter / 队列行 ⚡）的消息入队后靠轮收尾冲刷发出，但 `takeQueuedItem` 的守卫见「计划待批准」就静默放行失败——plan 模式下 `activePlan` 为 pending 时（审批卡接管输入区），冲刷被拦、待发标记已被 `finishStream` 消费，没有任何重试或提示，消息永远以「排队」状态留在队列框。
- **修复**：① 计划守卫改为「审批卡**正显示**才拦」——被「继续规划」收起后输入区已空闲、手动发送可行，队列冲刷同一口径放行（原先收起后照样拦，口径比手动发送更严）；② 抢占入口自动收起待批准的计划卡让路（只改显示、计划保持 pending，队列上方「计划等待批准 · 查看」可随时回到批准卡）；③ `finishStream` 收尾兜底：停止 / 抢占收尾且有消息待发时收起正显示的计划卡（覆盖抢占瞬间计划才提交、收尾时才 pending 的工具竞态；普通停止与自然结束不收卡）。
- 护栏：`frontend/test/ai/ai-message-queue.test.mjs` 补 3 例（卡正显示拦冲刷 / 收起后放行 / 抢占自动收起）、`frontend/test/ai/ai-turn-steer-wiring.test.mjs` 补 4 处源码断言，均已登记 `npm test`。前端全量 2182 例通过。

### 改进（通用确认框支持自定义触发键，重新发送框 Enter 即确认）

- **变更**：通用确认框 `openConfirmDialog` 新增可选第 6 参 `options.keys`（`KeyboardEvent.key` 字符串或数组），按下指定键即等同点确认按钮；输入法组词态与带修饰键的组合不触发，Esc 仍由弹层栈统一处理。
- **应用**：AI 消息原地编辑点「重新发送」弹出的二次确认框绑定 Enter——弹框时焦点仍在编辑区 textarea，监听挂在 window 捕获阶段确保可靠触发。
- 护栏：`frontend/test/settings/confirm-dialog-keys.test.mjs` 锁住参数解析、监听守卫与透传链，已登记 `npm test`。

### 修复（计划批准指令补「计划模式已自动退出」，防模型再调 plan_mode）

- **成因（2026-11-22 用户实测）**：点「执行计划」后应用代发的批准指令只说「开始执行」，没告诉模型计划模式已被应用自动退出——模型有时会纠结模式状态，主动调用注定空转的 `plan_mode(false)`（当前已不在计划模式，只会返回「当前不在计划模式」）。
- **修复**：批准指令追加一句「计划模式已随批准自动退出，不要再调用 plan_mode」；顺带把 `detectAppMessage` 的计划批准前缀放宽到两代文案共有的头「计划已批准，请立即按」——排队重发路径（`flushInBackground`）不透传 app 元数据，现行文案此前认不回来、会渲染成用户胶囊。
- 护栏：`frontend/test/ai/ai-app-message.test.mjs` 补现行文案识别用例，已登记 `npm test`。

### 修复（计划模式「继续规划」讨论轮：列表 info 角标不退、AI 幻觉审批卡还在）

- **成因（2026-11-22 用户实测）**：AI 提交计划后用户点「继续规划」发修订意见、AI 只用正文回应（未重新提交），此时审批卡已随「继续规划」收起，但 `activePlan.status` 仍是 `pending`——会话列表的 `planPendingNeedsAttention` 只看「pending 且无流」，于是讨论轮结束就挂出 info「待确认」角标，和横条（用户发言即收起）与审批卡（已收起）的状态不一致；同一状态下模型只看得到历史里「提交过计划」，不知道卡片此刻在不在，回出「点「执行计划」我就动手」这种幻觉（卡片并不存在）。
- **修复**：① 角标判定补上与横条同源的 `planAwaitingUserReply`——用户已对计划发言（继续规划讨论中）不再标待确认，计划重新提交（ts 更新）后角标自然回来；② 起轮动态块新增 `<plan_status>`（`turnContextBundle`，随用户消息注入、不进系统提示词稳定区）：每轮把审批卡真实状态告诉模型（卡在输入框上方等批准 / 卡已随「继续规划」收起、没有可点的「执行计划」按钮，修订收敛后重新 submit_plan），判定经 ctx 注入 `planApprovalCardVisible`（与接管区同源：`planApprovalMessage` + dismissed 比对）；③ 完成后的桌面通知「AI 计划待批准」同步加同一判定，讨论轮不再误弹。
- 护栏：`frontend/test/ai/ai-session-list.test.mjs` 补 2 例（讨论轮不挂角标 / 重新提交角标回来）、`frontend/test/ai/ai-system-context.test.mjs` 补 4 例（卡在 / 卡收起 / 非计划状态不注入 / 缺绑定跳过），均已登记 `npm test`。前端全量 `npm test` 与 `vite build` 通过。

### 改进（AI 对话引用卡片化，点击开全文）

- **变更**：输入框里的引用从单行 chip（只显示「回复引用 · 助手回复 #…」，看不到内容）改为引用卡片——来源标签弱化在上、正文摘要独立成 2 行；发送后用户气泡里的引用块也从「标签+摘要挤一行」改成上下分层 + 左侧竖线强调。
- **看全文**：引用卡片的摘要、气泡里的标签/摘要都可点击，在只读虚拟标签页打开引用全文（复用现有「只读文档」类型，固定只读不可解锁、可复制）；悬浮仍有 tooltip 快速预览。输入区与消息原地编辑区共用同一套卡片渲染。

### 修复（AI 打开网页后截图出现空标签页、截图为空白）

- **成因（2026-11-22 用户实测，复现率极高）**：AI 用 `app_control open_browser_tab` 打开网页会新建一个标签页，但这条路径不写会话的 `browserTabId`；紧接着 `browser_screenshot`（或 `browser_snapshot` / `browser_navigate`）走 `ensureBrowserTab` 时看不到 id，便**再新建一个 `about:blank`「新标签页」**——当前视图没切过去，截图工具却对着这张空白页截，于是标签栏莫名多出一个空标签、附加的图是白图。
- **修复**：`app_control` 的 `open_browser_tab` / `close_browser_tab` 成功后，把标签页 id 与会话的 `browserTabId` 对齐（纯函数 `resolveSessionBrowserTabId`，`ai-browser-tools.js`）——打开即登记、关闭当前标签才清空、变化时才落盘。此后所有 `browser_*` 工具复用同一标签页，不再重复新建。
- 护栏：`frontend/test/ai/ai-browser-tools.test.mjs` 补纯函数用例、`frontend/test/ai/ai-browser-tab-identity.test.mjs` 锁接线点，均已登记 `npm test`。

### 改进（文件树/列表可显示 .cadt 状态目录，默认显示）

- **变更**：此前 `.cadt`（AI 草稿 / 日志 / 补丁 / 记忆）在文件树与列表的工作区根层被硬编码隐藏（2026-11-21 `a72570a` 引入，无开关、与 Windows 隐藏属性无关），现改为默认显示，并在 设置 → 通用设置 →「文件树与代码视图」分组的「显示 .cadt 状态目录」开关提供控制；关掉时恢复原来的根层隐藏，不影响「临时草稿」固定节点与各设置页入口。
- **实现**：隐藏判定抽成纯函数 `isCadDirEntry` / `visibleTreeEntries`（`frontend/src/explorer/explorer.js`），树过滤与列表跳过表共用同一开关；`setShowCadDir` 同步列表忽略表（文件系统通知同读该表），`showCadDir` 设置项走完 HTML → 事件 → applySettings 全链路，AI `set_setting` 亦可直接改。
- 护栏：`frontend/test/explorer/explorer-cad-dir.test.mjs`（纯逻辑 + 全链路源码守卫），已登记 `npm test`。

### 修复（会话消息原地编辑：异步重绘不再打断编辑态）

- **成因（2026-11-22 用户实测）**：第一次编辑会话消息，几秒后莫名退出编辑态，第二次点编辑又不会。根因是 `renderMessages` 无条件 `inlineEdit = null`，而 `handleResourceChange` 的会话磁盘重读（租约忙时重试最多 ~6 秒）会在用户打字时触发重绘——首次编辑时之前某次写盘的重读还在重试队列里，几秒后落地打断编辑；之后没有新写盘事件，所以再编辑不受影响。
- **修复**：`renderMessages` 重绘前用 `snapshotInlineEdit` 保存编辑数据（会话/idx/文本/附件/光标位置，不含 DOM 引用），重绘后用 `restoreInlineEdit` 在新的 `.ai-msg[data-ai-idx]` 节点上原样恢复编辑态与光标位置，未保存内容不丢。校验会话仍是当前查看的、消息仍可编辑才恢复，否则静默放弃；只保护面板主视图（支线标签页编辑由自己管）。
- 护栏：`frontend/test/ai/ai-inline-edit.test.mjs` 补 3 例源码守卫（快照-恢复接线 / 快照字段 / 恢复校验与定位），已登记 `npm test` 清单。

### 改进（编辑器内快捷键随风格联动：默认对齐 JetBrains，VSCode 风格可选）

- **能力**：代码 / 文本视图里的编辑键（此前走 jsoneditor 内嵌 Ace 默认键位，不受快捷键风格控制）现在跟随 设置 → 快捷键风格（candysweet / jetbrains / vscode）联动，切换即时生效（已开标签一并重绑）。设置页快捷键表下方新增「编辑器内键位」分组，与全局表同源切换。
- **默认（CandySweet）与 JetBrains 对齐**：Ctrl+D = 复制行 / 选区、Ctrl+Y = 删除行、Ctrl+Shift+U = 切换大小写、Ctrl+Alt+↑/↓ = 向上/下复制行、Ctrl+/ · Ctrl+Shift+/ = 行/块注释。**注意**：默认 Ctrl+D 由原来的「删除行」改为「复制行」，删除行改用 Ctrl+Y——老用户需注意肌肉记忆变化。
- **VSCode 风格**：Ctrl+D = 多选下一个匹配（自实现：光标在词上首按选中该词，再按逐个加入后续匹配，文末回绕）、Ctrl+Shift+L = 选中所有匹配、Ctrl+Shift+K = 删除行、Ctrl+Shift+Alt+↓ = 复制行、Ctrl+Shift+A = 块注释。
- **冲突处理**：全局「重做」在默认/JetBrains 风格去掉 Ctrl+Y（仅留 Ctrl+Shift+Z），VSCode 风格保留 Ctrl+Y；Ctrl+W 仍是全局「关闭标签」，不占编辑器扩展选区（扩展选区沿用 Ace 原生 Ctrl+Alt+←/→）。只读文档下这些编辑键不生效。
- **实现**：键位单一来源 `core/editor-keybindings.js`（纯数据 + 纯函数）+ 运行时 `editor/editor-keybindings.js`（用 Ace `bindKey(key, null)` 精确解绑冲突键、专属命令名重绑、幂等；不改动 vendored 文件，可整体回滚）。组合根注入到 editor-groups（建编辑器时 applyTo）与 settings-ui（切风格时 applyToAll）。
- 护栏：新增 `frontend/test/core/editor-keybindings.test.mjs`（键位表冲突 / 语义 / 展示）与 `frontend/test/editor/editor-keybindings-wiring.test.mjs`（接线源码守卫），均登记 `npm test`；同步更新 keybindings / keymap 旧断言。前端全量 `npm test` 与 `vite build` 通过。

### 新功能（AI 工作区认知索引：FRAS 卷文件 + drift 治理，可选启用）

- **能力**：AI 维护的工作区语义层（`.cadt/cognition/` 卷文件，每文件一行 F 职责 / R 强关联 / A 对外契约 / S 暗约束）——R/S 是 grep 永远给不出的「改这里必须同时知道的事」；新会话首轮注入一份路径地图（≤1–2K token，三级降级封顶），细节按需 `cognition_read`。机制借鉴 AOCI、引擎全部自写（方案 `docs/finished-plans/ai-cognition-index.md`，2026-11-21 评审修订后实施）。
- **可选启用（默认关）**：开关在 设置 → AI → 上下文与记忆「认知索引」（`aiCognition`，设置树登记 protected）；内置助手可主动建议启用——app_control 新增 `cognition_toggle {enabled}`，**必弹动作审批卡（完全权限也不例外）**，用户拍板或手动在设置开/关；关闭态系统守则只留一句启用入口。
- **三件工具**（启用后下发）：`cognition_read`（路径地图 / 按前缀·标签·关键词取条目全文，响应 ≤7 000 字符——刻意压在 context-slim 落盘阈值之下，模型永远拿到正文而非指针）/ `cognition_edit`（按目录分批维护条目 + `meta` 整卷替换；写路径 base-CAS，写后 baseline 簿记闭环——改完文件再更新条目不再永报 Stale）/ `cognition_status`（drift 四态报告 + 预算余量 + needsReread；唯一副作用是 baseline 缺失时全量生成）。计划模式三件中 edit 不派；子代理只派只读两件；群聊不派。
- **治理**：`.cadt/cognition` 整树是 write_file/edit_file 拒绝路径（卷只能经 cognition_edit 改，用户手工编辑不受限）；meta 的 budget 行与 Go 常量比对（600 条 / 256 KB）；租约锁在卷目录外；`ws-cognition` 进存储清理勾选清单（刻意不进一键清缓存）并挂 BeforeClear 门闩。
- **注入落点**：`<cognition_index>` / `<cognition_nudge>` 走轮上下文（`turnContextBundle`），不进系统提示词稳定区——卷会被改写，进稳定区等于每次维护击穿前缀缓存；压缩裁掉历史块后重注是预期恢复行为。改动索引覆盖内文件却没维护时，下一轮一行提醒（方向「少提醒」）。
- 引擎 `internal/cognition`（parse / drift / service）+ 绑定壳 `cognition_app.go`；前端域 `ai-cognition.js`（指纹登记 / 预取 / 纯函数）+ 守卫测试。帮助 → 教程新增「认知索引」一节（开关与审批 / 三件工具 / 卷文件 / 治理机制 / 边界）。
- 护栏：`internal/cognition/*_test.go`（格式向量 / 路径归一 / 四态判定 / CAS 三态 / 簿记闭环 / 预算拒绝 / 租约与清理门闩 / `.cadt` 不进清单 / status 零写入）、`frontend/test/ai/ai-cognition.test.mjs`（已登记 `npm test`）、工具接线守卫与动作三方对账全绿；前端全量与 `go test ./...` 通过。P3 真实使用量化验收（探索轮数 / 错改率对比）待回填。

### 新功能（桌面控制 Computer Use：第三方窗口 GUI 自动化，desktop-mcp P1/P3/P4/P2 落地）

- **能力**：把外部 windows-mcp（CursorTouch，stdio MCP server）接进应用 MCP 客户端，让 AI 能看第三方原生窗口的无障碍树并做点击 / 输入 / 滚动 / 剪贴板操作。方案 `docs/finished-plans/desktop-mcp.md` §13.5（2026-11-21 三审排期）。
- **三道闸**（`ai/ai-desktop-control.js`）：① 只在写权限档（非计划模式）注入；② 会话授权单飞——输入框新增「桌面」pill（无注册工具时隐藏，数字=快照真实注册数），仅本会话生效、重启失效，应用级同时只允许一个会话持有（grant/revoke 经 `desktop-grant-changed` 全窗广播收敛，新 grant 挤掉旧持有者并向其会话投递通知，空闲会话静默收回不唤醒）；③ 懒加载揭示——模型默认只看到 `windows_desktop` 入口，调用它才把匹配的 `mcp__windows__*` 工具揭示进本会话工具表，未揭示的桌面工具派发层确定性拒绝。
- **审批语义**：授权生效的桌面工具免逐次审批（`sessionAllow`），项目规则 deny 优先不变；pill tooltip 明示 `run_command` 命令通道不受本开关约束（incident §5 已知盲区的如实承认）。
- **工具表**：MCP 通用注入分支排除 windows server 的工具（走桌面双闸）；`windows_desktop` 登记目录新组「桌面控制（第三方原生窗口）」与典型工具链。
- **设置 → AI → 外部工具 → 桌面控制卡片**（P2 降级形态）：不自动装依赖——复制 uv 安装命令 + 一键写入 mcp.json 服务器行（`uvx windows-mcp@0.8.9 serve --tools Snapshot,Click,Move,Scroll,Type,Shortcut,Clipboard`，白名单无 Screenshot（MCP 客户端暂不显示图像结果）/ Registry / Process / App / PowerShell / FileSystem，默认停用）+ `MCPDesktopDoctor` 只读诊断（uv 解析，PATH 与用户目录 `.local\bin`）。
- 护栏：`frontend/test/ai/ai-desktop-control.test.mjs`（8 例：server 判定 / 揭示匹配 / 单飞与广播副本收敛 / 配置行与白名单口径），已登记 `npm test`；工具接线守卫的授权 stub 同步；`mcp_desktop_app_test.go`（uv 候选表驱动 + doctor 冒烟）。前端全量 2139/2139、Go 定向、`vite build`、`check-crossbuild` 均通过；实施后经只读子代理审查（P0 零、P1 两处当日修复：**能力来源绑定 mcp__windows__\* 曾绕过派发闸**——闸下沉 `invokeMcpToolWithApproval` 单收口；**doctor 的 uv 候选缺 `.exe`** 恒落空——补 uv.exe + uv 双候选）。
- 已知边界与实机回归（2026-11-21）：**决策点通过**——纯无障碍树完成「任务栏图标清单」（46 s，13 图标带窗口状态）与「计算器 123+456= 关闭复核」（2 m 35 s），Screenshot 维持砍掉。**实测 P0（已处置）**：上游 `--control` 模式用 WH_KEYBOARD_LL/WH_MOUSE_LL 低级钩子做桌面所有权，AI 操作后 Alt+Tab / Win+Shift+S 等系统组合键被吞到 server 进程退出才恢复（重 UIA 快照 + GIL 争用加剧）——配置行默认改 **`--no-control`**（源码验证 disabled 完全不装钩子），授权语义由「桌面」pill 承担；想要上游 consent 弹框的可自行改回 `--control`（紧急接管和弦 Ctrl+Shift+Alt+Backspace）。已写入旧配置行的机器：删行重写或手动在 args 加 `"--no-control"`。其余：`toolsForScope` 的 session 参数本就存在（read_video 先例），P1 无签名改动；配置行带 `startupTimeoutMs: 600000`（uvx 首跑下载依赖，默认 30s 会超）；揭示口径「同批并行调用拒一次、下一条请求生效」已写进揭示文案；高 DPI / 非英文 Windows 属上游行为。

### 工程（禁止 `git checkout` / `git restore`：跨 harness 的命令守卫）

- **背景**：2026-11-21 一次 `git checkout -- frontend/src/explorer/explorer.js` 想撤掉「自己的」改动，把该文件上**多个并行会话叠加的未提交改动**一起回滚到 HEAD（wipe-guard 快照早于那次改动，恢复不回来）。单文件整文件回退在这类仓库里等价于批量销毁；`git restore` 是同一动作的新名字，一并禁掉——但只拦**会写工作区**的形态，`git restore --staged`（只撤暂存）放行，带了 `--worktree` / `-W` 就照拦。
- **守卫**：新增 `tools/hooks/git-guard.mjs`（Node 无依赖），同一脚本适配三种 harness 协议——Claude Code / CodeBuddy / WorkBuddy 的 `PreToolUse`（拦截 = 退出码 2 + stderr 回填给模型）、Cursor 的 `beforeShellExecution`（回 `{"permission":"deny"}`，配 `failClosed`）。`--check "<命令>"` 可手工验证判定。
- **配置三处入库**：`.workbuddy/settings.json`（另含 `permissions.deny` 的 `Bash(git checkout:*)` / `Bash(git restore)` 等硬规则；restore 只钉裸命令，`--staged` 交给钩子按形态放行）、`.claude/settings.json`、`.cursor/hooks.json`；`.gitignore` 改为 `.workbuddy/*` + `!.workbuddy/settings.json`，让规则对所有会话生效而记忆等本机状态仍不入库。
- **ZCode 覆盖（补充，2026-11-21）**：仓库根新增 `zcode.json`——`hooks.enabled:true` + PreToolUse `process` 型挂 node（免 shell 引号问题，Windows 可移植）。协议实测兼容：stdin 载荷 `{tool_name, tool_input:{command}}`，拦截=退出码 2+stderr（同 Claude Code），放行=0。**注意**：ZCode 项目钩子要在客户端**信任工作区**后才注册（未信任时日志报 `config_project_hooks_pending_trust` 且静默放行，本会话早于配置创建也读不到——新会话生效）。
- **判定口径**：只认**命令位置**的 `git`，认前缀缩写（`checko`/`rest`），并看穿 `bash -c` / `cmd /c` / `pwsh -Command` 包装；`grep "git checkout"`、`git log --grep=…`、提交信息里出现该词都不拦，`Write`/`Edit` 正文也不经过判定。拦截信息直接给替代做法（`git switch` / 按 hunk 反向改 / `git reset HEAD -- <路径>`（只撤销暂存）/ `git stash -u` / `git show HEAD:<路径>`）。
- **边界**：护栏不是沙箱（别名、改配置都能绕）。AGENTS.md 新增「禁止操作（硬规则）」一节，写清纪律、替代做法与新增 harness 的挂载方式；要再加同类命令（`reset --hard`、`clean -fd`…）在脚本的 `BLOCKED_SUBCOMMANDS` 表里加一条即可。
- 护栏：`frontend/test/tools/git-guard.test.mjs`（7 例：checkout / restore 两张判定表、切段切词、三种协议退出码与 JSON、非 shell 工具不误伤），已登记 `npm test` 清单；前端全量通过。

### 修复（工作区防护 L3 快照：单枚坏文件不再放走整张安全网）

- **成因（2026-11-21 实测）**：并行会话意外在工作区创建 `frontend\nul`（Windows 保留设备名，`> nul` 重定向在 Git Bash 下落地成真文件），`git add -A` fatal 令 L3 定期快照连败 13 轮（16:40→18:41），安全网断档约 2 小时——而失败只有 debug-console warn 一条 4KB 日志（全是 CRLF warning），没有任何用户可见表象。
- **单文件跳过重试**：`git add -A` 改走 `gitAddAllWith`——解析 git stderr 的 `error: open("…")` / `error: unable to index file '…'`（含 C 八进制引号还原为 UTF-8 路径），把无法索引的文件（保留设备名 / 无权限 / 被锁）以 `:(exclude)路径` pathspec 排除后重试（上限 8 轮，防悄悄缺一大片）；没有新 Culprit 的失败（锁冲突、仓库损坏）与超限仍按失败处理，不静默丢文件。跳过清单写日志并经 `SnapshotResult.Excluded` 上报；CAS 快照的不可读/超限文件同样计数上报（原先静默跳过）。
- **失败升级为用户可见告警**：前端快照 tick 把失败 / 跳过投进消息中心（点击直达 设置 → 存储与清理 → 工作区防护）——error 与 excluded 两条车道各自 30 分钟节流（`snapshotAlarmDecide` 纯函数），失败连击计数进文案（「已连续 N 次，每 10 分钟自动重试」）、首轮弹 toast；错误文案经 `compactSnapshotError` 只留 fatal/error 行。
- 护栏：`internal/wipeguard/snapshots_test.go` 新增 ParseUnindexable / CompactGitOutput / AddAllWith 表驱动（含「排除无效时不静默丢」「超上限按失败」两条负向断言）；新增 `frontend/test/ai/ai-wipeguard-snapshot-alarm.test.mjs`（节流决策 / 车道独立性 / 错误收敛，已登记 `npm test`）。取证细节见 `docs/finished-plans/icon-consolidation.md` 事故记录与 `docs/finished-plans/workspace-wipe-guard.md` §9。

### 重构（图标统一管理收编：icon-consolidation）

- **通用 UI 图标全部收敛到 `core/icons.js` 注册表**（源自用户反馈 AI 消息右键菜单 4 个图标全同 + 全仓盘点 76+ 处内联手写 SVG / 12+ 组重复语义）：拆除 AI 消息动作影子工厂（ai-panel 本地 `icon()` 10 图标）、监控窗 `iconSvgOf`、标题栏 `POP_ICONS` / 运行配置 `RUN_POP_ICONS`、explorer / structure 局部表、editor-groups 的 14 网格 `VIEW_ICONS`（按 16 网格重画为 `view-*` 键，binary 的 `<text>` 字形改为路径）、main.js 的 UNLOCK/LOCK 手写 SVG 与 AI 引用菜单的 20 网格星花（复用 `sparkles`）。
- **注册表补 27 键**：`chevron-left` / `question` / `circle-check` / `circle-x` / `database` / `structured-dir` / `unlock` / `rewind` / `bringback` / `deliver` / `tag` / `collapse-all` / `expand-all` / `locate` / `checklist` / `env` / `plan` / `more-vertical`（18）+ `view-*` 族（tree/table/binary/video/audio/render/patch/split/panel，9）+ `tree`（复审补登记）；sql/code/text/preview 等视图与 `database`/`code`/`doc`/`image` 同形复用不另立键。
- **全仓 162 处遗留 MDL2 码位菜单数据迁移为命名图标**（11 文件，映射同 `LEGACY_ICONS`）；`LEGACY_ICONS` 仅为外部插件兼容保留，本仓 src 已零码位。
- 行为不变（纯视觉重构）：菜单项/按钮的标签、快捷键、action 与无障碍语义未动；个别图标按注册表统一造型（AI 引用菜单星花、Git 推送按钮改上传托盘、消息中心成功/失败改圆圈徽标键、结构面板折叠键等），AI 消息右键菜单 4 个同形图标改为 `copy`/`quote`/`select-all` 分明语义（先行样例）。
- 护栏：新增 `frontend/test/core/icon-guard.test.mjs`（内联 `<svg>` 基线只减不增 / 遗留码位清零 / `iconHtml` 来源合规 / 注册表 `currentColor` 着色，`PRINT_ICON_BASELINE=1` 重印快照），已登记 `npm test`；收编后基线仅剩 git-graph 泳道画布 1 处（图表产物）。规范 `docs/icon-guidelines.md` 与 AGENTS.md 前端侧同步补「禁止影子注册表 / iconHtml 例外注释 / 护栏位置」。前端全量 `npm test`（2066 项）与 `vite build` 通过。方案与实施记录见 `docs/finished-plans/icon-consolidation.md`。

### 修复（标签栏横向滚动「滚不到末尾」：后台重绘不再抢滚动位置）

- **成因**：`renderEditorLayout` 每次整段重建标签条，横向滚动位置清零，随后 `revealActiveTabs` 无条件把激活标签滚回定位点。任何后台重绘（外部修改标记、AI 写用户打开着的文件、保存脏标、后台标签关闭）都会把手动滚到一半的标签条拽回激活标签的定位点——AI 正在改打开着的文档时标签条等于被钉死，表现为「怎么都滚不到末尾，末尾被工具区盖住」（2026-11-21 用户实测，前会话在 dev 里复现不出，因为 mock 场景没有后台写盘触发源）。
- **修复**：重建前按组记录各标签条 `scrollLeft`、重建后原样恢复（超上限自动收敛）；只有首次构建（此前不存在该组的标签条）才做激活标签定位；切换标签由 `activateDoc` 显式补发定位。`scheduleRevealActiveTabs` / `revealActiveTabs` 支持按组过滤，同帧调度合并时「无条件定位」吞掉组过滤，组过滤永远挤不掉显式定位。
- **附带改善**：关闭后台标签、拖动排序、AI 修改已打开文件等重绘不再把用户滚出的位置弹回；多分栏各组的滚动位置互不影响。
- 护栏：新增 `frontend/test/editor/tabstrip-scroll.test.mjs`（5 例源码守卫：收集先于清空、恢复/首次构建分流、过滤器合并语义、activateDoc 显式定位），已登记 `npm test` 清单。

### 修复（自动保存后编辑器失焦「突然打不了字」：后台重绘不再抢走焦点）

- **成因（2026-11-22 用户实测）**：自动保存成功路径 `saveDoc` 调用 `renderTabs()` → `renderEditorLayout()`，后者整段 `#editor.textContent = ''` 清空再 `appendChild` 把编辑器 pane 插回——DOM 节点被摘除再插回时浏览器会丢失子树内的焦点（Ace 的隐藏 textarea 失焦）。用户写着写着突然打不了字，必须重新用鼠标点一下。这是通用问题：任何触发 `renderEditorLayout` 的后台重绘（自动保存、外部修改标记、AI 写已打开文件、保存脏标）都会在用户打字时夺走焦点。
- **修复**：`renderEditorLayout` 重建前记录 `document.activeElement` 与其所属 `.jsoneditor-pane`（`prevActive` / `prevActivePane` / `hadFocusInEditor`），重建后若焦点所属 pane 仍是激活文档则恢复焦点——优先走 `aceEditor.focus()`（同步 Ace 内部焦点状态），否则回退 `prevActive.focus()`。按焦点 pane 反查文档（不依赖 `deps.file` 当前值，多分栏下焦点组可能不是 file 组）。
- **边界**：标签切换（`activateDoc` 移走旧 pane）不会命中——重建后激活 pane 与焦点 pane 不同，`activePane.contains(prevActivePane)` 为 false，不会抢新标签焦点；关闭标签时焦点 pane 已被移除，`prevActive.isConnected` 为 false，同样不执行。
- 护栏：`frontend/test/editor/tabstrip-scroll.test.mjs` 补 1 例源码守卫（焦点记录先于清空、重建后 `aceEditor.focus()` 恢复、恢复逻辑位于标签条定位之后），已登记 `npm test` 清单。

### 改进（运行面板：同一文件反复运行复用同一个标签，不再堆标签）

- **成因（2026-11-22 用户实测）**：底部「运行」面板每次按 F5 都 `createSession` 新建一个标签，同一文件反复运行会堆出一排同名标签（截图里 3 个 `草稿-…py`），用户要手动关掉旧的。
- **修复**：`run()` 创建会话前先按文件路径查找可复用会话（`findReusableRunSession` 纯函数）——同路径 = 同一文件，复用同一个标签；不同文件各自一个标签。复用时若旧任务还在跑，先 `RunStop` 停止并等它完全退出（会话级 `donePromise`，由 `finishSession` / `execSteps` finally resolve），再重置会话状态、清空旧输出、更新标签标题——避免新旧进程的 `run-exit` 事件串台。
- **边界**：自检（`selfTest`）与项目运行（无文件路径）不参与复用，各自独立标签；`MAX_SESSIONS` 上限照旧生效（复用不占新名额）。
- 护栏：`frontend/test/terminal/run.test.mjs` 补 3 例纯函数测试（同路径复用 / 不同路径各自新建 / 自检与无 path 不参与复用 / 空表与坏条目不抛错），已登记 `npm test` 清单。

### 修复（Markdown 预览滚动不持久 + 分屏不对齐：滚动位置存进 doc）

- **成因（2026-11-22 用户实测）**：切标签切回来，md 预览的浏览进度没了、跳回顶部；分屏视图还有滚动条 / 不对齐。根因是预览滚动只存在 DOM（`doc.previewScroll.scrollTop`），而切标签 / 自动保存触发的 `renderEditorLayout` 会把 pane 整段摘除插回（与失焦同一个机制），DOM scrollTop 归零。
- **修复**：预览滚动的持久真源改为 `doc.previewScrollTop`（存在 doc 上，不依赖 DOM）——`createMarkdownPreview` 挂 scroll 监听写入它；`renderMarkdownPreview` 用它恢复（不再读当前 DOM）；切走（`snapshotActiveDoc`）、`renderEditorLayout` 重建前 capture，切回（`activateDoc` 的 ace.resize 后 setTimeout）、重建后 restore。只对活动 doc capture/restore——隐藏 doc 的 DOM scrollTop 已归零，读了会覆盖持久值。
- **分屏**：以 Ace 滚动为真源对齐（`mdSyncScrollFromAce` 回写持久值），布局就绪后（resize 之后）恢复，避免 scrollHeight 未就绪时算出 0 导致停在顶部；预览滚动容器加 `scrollbar-gutter: stable`，防止横向滚动条出现时挤压内容高度引起跳动。
- 护栏：新增 `frontend/test/editor/md-preview-scroll.test.mjs`（8 例源码守卫：持久真源 / capture-restore 接线 / 分屏对齐 / 时序），已登记 `npm test` 清单。

### 修复（使用统计板块上下无间距：补上漏加的 .us-root class）

- **成因（2026-11-22 用户实测）**：使用统计作为「应用页面」标签页打开后，Token 活动 / 趋势 / 模型用量 / 请求日志各板块上下紧贴、没有间距。根因是板块间距靠 `.us-root` 的 flex `gap:14px`，但 `mountSkeleton` 只往 host 里塞 `.us-card`，从没给 host 加 `.us-root`——应用页面宿主是 `.apppage-root`（无此 class），CSS 里甚至已有 `.apppage-root > .us-root { padding:0 }` 的适配规则，却因 JS 没加 class 而形同虚设。
- **修复**：`mountSkeleton` 建骨架前给 host 加 `.us-root`（组件自带样式，不依赖宿主 class），卸载时移除——flex column + gap 生效，板块间距恢复。
- 护栏：新增 `frontend/test/settings/usage-stats-pane.test.mjs`（3 例源码守卫：加/移除 class 接线 + CSS gap 规则），已登记 `npm test` 清单。

### 修复（临时文件目录不存在时报错 + 新建后不显示：空目录当正常态 + 强制重读）

- **成因（2026-11-22 别的机器实测）**：新机器工作区还没有 `.cadt/scratch/`，展开「临时文件」节点时后端 `ReadDir` 的 `os.Stat` 报 `GetFileAttributesEx ... 系统找不到指定的文件`，节点显示「无法读取：GetFileAttributesEx...」；之后新建草稿虽然 `AIEnsureDir` 建了目录，节点仍不显示文件。根因：① `loadNode` 把「目录不存在」当普通读取错误存进 `node.error`；② 失败后 `node.loaded=true`，`refreshScratch` 走 `refreshNodeChildren` 时被残留的加载态 guard 挡住，没重读。
- **修复**：新增 `isMissingDirError` 纯函数识别跨平台「目录不存在」文案（英文 `cannot find the file` / 中文 `系统找不到指定的文件` / `no such file or directory`），`loadNode` 的 catch 对 scratch 节点 + 该错误当空目录处理（清 error、不显示报错）；`refreshScratch` 新建后强制重置 `loaded`/`error`/`loading`/`loadPromise`/`refreshing` 再走 `loadNode` 完整重读，保证新文件显示。
- 护栏：`frontend/test/explorer/explorer-diff.test.mjs` 补 3 例（错误文案判定 + loadNode scratch 特殊处理 + refreshScratch 强制重读），已登记 `npm test` 清单。

### 改进（临时文件对齐 JetBrains：节点叫「临时文件」，文件名用 scratch 不用中文）

- **成因（2026-11-22 用户反馈）**：文件树里的固定节点叫「临时草稿」，新建的文件名是 `草稿-YYYYMMDD-HHMMSS.<ext>`（带中文 + 时间戳），与 JetBrains 的 Scratches（`scratch.json` / `scratch_1.json`）风格不一致。
- **改名**：树节点、quick-switch 层、右键菜单项、编辑器右键「存为临时文件」、存储与清理条目标签、flash 与历史文案，全部从「临时草稿」改为「临时文件」（`explorer.js` / `explorer-ops.js` / `editor-menus.js` / `quick-switch.js` / `main.js` / `dev/mock-backend.js` / `internal/storage/specs.go`）。
- **命名**：`scratchDraftName` 从 `草稿-时间戳[-N].<ext>` 改为 `scratch[-N].<ext>`（对齐 JetBrains：`scratch.json`、`scratch_1.json`…）；`createScratchFile` 的撞名重试从「同秒 3 次」改为「递增 `_N` 直到成功（上限 100）」。`scratchStamp` 保留为通用时间戳工具（不再参与命名）。
- **兼容**：旧文件（`草稿-*.md`）仍落在 `.cadt/scratch/`，`isScratchPath` 只认目录不认前缀，照常识别与打开；只影响新建文件的命名。
- 护栏：`frontend/test/core/scratch.test.mjs` 更新命名断言（`scratch.md` / `scratch_1.md` / `scratch_2.md`），已登记 `npm test` 清单。

### 新增（临时文件：explorer「新建」里的免起名草稿）

- **填的是既有两种「新建」之间的空档**：文件 → 新建是**内存未命名文档**（无 path，重启即丢），explorer → 新建是**先起名再建**。临时文件 = 免起名 + 落盘有 path：随手开一份、一秒后自动保存、重启回来还是原文。空草稿建好直接落在可写的代码视图（`.md` / `.html` 的默认首屏是预览，只有草稿这一份切自己）。方案与实施记录见 `docs/finished-plans/scratch-file.md`。
- **落 `.cadt/scratch/`，不进 AI 免审写区**：原评估稿建议与 AI 产物同放 `.cadt/tmp`，但那目录对 AI 是免审写区（覆盖同名文件不需要确认）且被「一键清缓存」覆盖，用户草稿放进去会被静默覆盖/清掉。草稿改用 `<工作区>/.cadt/scratch/`，文件名 `草稿-YYYYMMDD-HHMMSS.<ext>`（同秒撞名加序号重试）。
- **选语言 = 选扩展名**：新建 → 临时文件的子菜单首行是「临时文件（.md）」一键建（扩展名记忆自上次使用，`settings.scratchExt`），其后是语言清单（复用内置文件类型表）+ 更多…。草稿必须带扩展名——高亮、可用视图、运行配方、图标全按扩展名分派，应用没有内容识别。
- **静默落盘**：新建的草稿带 `doc.draft`，自动保存的门从 `settings.autoSave` 放宽为 `autoSave || doc.draft`（含切标签前那次 flush、设置变更后的重挂）。普通文档行为不变；只读锁、大文件保护、脏标记语义一律不越过。
- **关闭空草稿自动删**：空白草稿关标签直接走回收站，不弹「未保存」确认、不进关闭标签栈；删除失败静默。只认 `doc.draft`，普通文件绝不自动删。
- **文件树里有专门的「临时草稿」节点**（对齐 JetBrains 的 Scratches and Consoles）：树根下固定一行，展开就是 `<ws>/.cadt/scratch` 的草稿，双击即开；新建后自动展开并选中新草稿，空白草稿被自动删掉后节点跟着刷新。为了让草稿不在树里出现两次，`.cadt` 本身从树里隐藏（只作用于工作区根这一层；此前 `LIST_SKIP_DIRS` 只被列表视图用，树其实一直把 `.cadt/.git/node_modules` 原样显示出来——方案里「树里看不见」的判断是错的）。该节点的右键只有新建 / 刷新 / 定位 / 存储与清理，不给重命名与删除。
- **另外三条找回路径**：建完 flash 一行文件名、quick-switch 新增「临时草稿」层（按 mtime 倒序，键盘可达，对齐 Show Scratch Files）、`Ctrl+Shift+T` 与文件 → 最近打开（草稿有意进最近列表）。
- **从选区建草稿**：编辑器右键「存为临时草稿」把选中文本作为初始内容（对齐 JetBrains `Alt+Enter`），扩展名沿用当前文档、不嗅探选区内容；全局只读锁下不出现。
- **存储条目 `ws-scratch` 刻意 `inCache: false`**：清缓存一键不许碰用户草稿，需要时在「数据」段按勾选单条清（`kind: KindData` → 走回收站，方案原文写的 `KindCache` 会被 `os.RemoveAll` 直删）。
- 护栏：`saveDoc` 在草稿保存遇到「路径不存在」时重建目录并静默重试一次（scratch 目录被清掉后已打开的草稿还能继续存）；新增 `frontend/test/core/scratch.test.mjs`（目录/命名/扩展名/判空/草稿架列表 6 例，已登记 `npm test` 清单）；`storage_test.go` 的「绝不能进一键清缓存」补一条负向断言。前端全量 `npm test`（2055 项）、`vite build`、`go build ./...`、`go test ./internal/storage/` 均通过。

### 修复（AI 对话「莫名停止」：外部杀进程的回合善后 + 优雅退出通道）

- **成因（2026-11-21 会话取证）**：用户报告「对话好几次莫名其妙停了」。取证发现停点全是**进程被外部强杀**——重建替换 exe / 外部结束进程时，窗口 JS 随进程即刻消失，在飞回合没有任何收尾路径：JSONL 停在「工具已执行完」，进程日志止于 `AI 请求：`（无「应用退出」行），界面无错误卡、会话数据诊断 issue 0（原子写入保证日志一致，只是到此为止）。两个不同工作区的会话同秒停止（07:32:22 / 07:32:26）与 exe 重建时间（07:32）吻合，坐实进程级死因；模型、审批链、传输层均无关。
- **中断回合留痕**：起轮时 meta.json 写 `turnInFlight` 标记（随首次消息落盘），`finishStream` 清除（done / error / 用户停止的 1.2s 兜底全部汇到这里）。只有「进程死了没走收尾」才残留——下次读盘在消息流末尾挂**中断横幅**（warn 色条 + 「继续回合」按钮），点继续按历史里的工具结果接着做，不再莫名。「用户自己停止」与「进程死亡」由标记精确区分。
- **优雅退出通道**：新增 `datalens.exe --quit`（经单实例转发给运行实例，冷启动无实例时直接退出不闪窗）：广播 `app-graceful-quit`，每个窗口结算自己的在飞回合（复用 `stopGeneration` 收口——工具卡标中断、终态落盘、释放回合租约），写队列排空后按窗口 ack（`AppGracefulQuitAck`）；Go 收齐全部窗口 ack（或 6 秒超时）才 `ForceQuitAll`。事件登记进 `event-scope.js`，mock 补同名方法。
- **重建脚本接入**：`tools/rebuild-exe.ps1` 的 `Stop-RunningInstances` 先发 `--quit`（等 10 秒优雅退出），没退的再走原有优雅关闭（6 秒）→ 强制结束。以后重建不再杀掉跑着的对话。
- 护栏：`ai-session-store.test.mjs` 补 `turnInFlight` 归一与 meta 签名断言；前端全量 `npm test`（2049 项）与 `go test ./...` 通过。

### 改进（应用页面：使用统计 / 定时任务 / 操作记录 / 补丁库搬出设置对话框）

- **背景**：这四个页面本质是「浏览与管理数据」的重面板——要长时间停留、要看大量内容、要能和别的标签页并列对照，被模态框困住只会「关掉就丢滚动位置与筛选状态」。现在各自是一个内容区标签页，属于「一切皆标签页」的第二族（第一族是子代理详情 / 支线对话 / 便签这类「一个业务对象」，这族是「一个功能页面」）。
- **清单单一来源**：新增 `frontend/src/core/app-pages.js`（`APP_PAGES`：id / label / icon / group / desc）。`core/tab-kinds.js` 的 `TAB_KINDS` 新增 `appPage` 一项，用 `resolve(doc)` 按 `doc.appPage` 细分图标与标签——一个类型装 N 个功能页。
- **内容渲染仍归原域**：四个 pane 各加 `mount(root)` 返回卸载函数（使用统计 / 补丁库 / 操作记录，以及 `ai-schedule.js` 的 `mountSchedules`），骨架由页面自己注入、元素在宿主内按 id 查询。视图工厂 `bridge/bridge-app-page-view.js` 只建标签页与调 mount；挂载器由 `main.js` 的 `appPageMounters` 注入（`bridge/` 不 import `settings/` 或 `ai/`）。
- **入口四层**：活动栏 `ab-app-pages` 打开侧栏「应用页面」面板（按分组列出页面，点行直接开标签页——最常用入口）、菜单「工具 → 应用页面」子菜单、活动栏 `ab-more` 弹层、命令面板 `Ctrl+Shift+P`（`paletteActions()` 递归展开菜单 submenu，**进菜单即自动可搜，零额外代码**）。设置页另有「页面 → 应用页面」目录 pane 作发现入口。
- **真·设置项不随页搬走**：`settings-tree` 靠扫设置页 DOM 反射成可写行，页面搬走后 AI 的 `set_setting_row` 就照不到。当前涉及「操作记录」的两个开关（`opt-activity-log` / `opt-activity-retention`）仍留在设置页，页内只放浏览与记录管理动作。
- **顺带修**：AI 的 `schedule_*` 工具在 CRUD 后调 `renderScheduleSettings()` 原本靠设置页容器刷新；迁出后改为优先刷新「当前已挂载的列表容器」（`mountedList`），否则标签页里会一直显示陈旧列表。
- **活动栏瘦身**：移除「内容搜索」与「新建浏览器标签页」两个一次性动作图标（活动栏只留面板开关）。搜索靠 `Ctrl+F` / `Ctrl+Shift+F` 与菜单「编辑 → 查找… / 全局搜索…」兜底；浏览器入口移到「应用页面」侧栏面板**顶部**动作行（菜单「文件 → 新建浏览器标签页 / 打开我的浏览器」与命令面板仍在）。浏览器不作为 `APP_PAGES` 注册项——它多开、带 URL 与 profile，语义上是"文件"而不是"单例功能页"。
- 守卫 `virtual-doc-wiring.test.mjs` 自动覆盖新类型（注册表 ↔ 分派表 ↔ 创建点 ↔ 图标注册 ↔ 统一卸载）。前端全量 `npm test` 与 `npm run build` 均通过。

### 改进（「一切皆标签页」：虚拟标签页接线收敛到注册表）

- **概念立起来**：内容区里不存在第二种呈现单位——文件、浏览器、后台终端、子代理详情、智能体团队、支线对话、群聊成员、便签、计划与差异文档，全部是一个 `doc`、占一个标签页，共用同一套生命周期（打开 / 激活 / 关闭 / 分栏 / 拖拽 / 跳转 / 描述给 AI）。常驻 UI（AI 面板、设置、阅读模式、底部 dock、调试台、浮层、辅助窗口）是明确豁免，理由写进 AGENTS.md。
- **类型单一来源**：新增 `frontend/src/core/tab-kinds.js`（`TAB_KINDS` 登记 7 类视图型虚拟标签页的 marker / kind / icon / label）。此前同一个集合被枚举 5 遍（`createDocEditor` 分支、`viewOptionsFor` 清单、`closeDocNow` 卸载、标签图标三元链、`appTabViewOf`），加一类要改 5 处且漏一处**不报错**、只静默降级。
- **doc 工厂去重**：新增 `frontend/src/core/virtual-tab-doc.js`，7 个 `openXxxTab` 里各自手写的约 14 字段公共块收敛成一次调用（净减约 80 行）；`marker` 与 `key` 成对校验，防止「只写标记位不给值」导致去重恒假、每次点开都新建标签。
- **卸载契约统一**：6 个域五花八门的卸载钩子（`bgTermUnsub` / `agentViewUnmount` / `agentTeamUnmount` / `sideChatUnmount` / `groupMemberUnmount` / `memoUnmount`）合并为 `doc.tabUnmount` 一条，`closeDocNow` 只调这一条（浏览器仍走 `BrowserClose` 释放 WebView2）。现在**新增一类虚拟标签页完全不需要改 `editor-groups.js`**。
- **顺带修 bug**：浏览器标签页一直没有专属图标——`buildGroupTab` 的图标链漏了 `doc.browser` 分支，落到按扩展名解析的文件图标（顶栏 `browser` 地球图标早已注册却无人调用），网页标签页长期显示成普通文本图标。
- **守卫升级**：`virtual-doc-wiring.test.mjs` 从「正则反推 `createDocEditor` 的 if 链」改为「以 `TAB_KINDS` 为准逐点对账」，并补三处此前测不到的盲区——图标名必须在 `core/icons.js` 注册（丢失只静默渲染空）、文本型虚拟文档（计划 / 差异）的 `viewKind` 必须在 `APP_TAB_KIND_LABELS` 有标签、`.md` 计划文档必须保留预览视图。
- 设计依据与实施记录见 `docs/finished-plans/tab-registry.md`；前端全量 `npm test`（2044 项）与 `npm run build`、`go build` 均通过。

### 改进（超窗压缩自救复评：分段压缩不实施 + 旧摘要截断修复）

- **分段压缩方案复评，决定不实施**：`docs/unfinished-plans/ai-segmented-compact.md` 的两个死因（压缩请求=全量发送发不出去、转录尾部截断导致摘要残缺）在 2026-11-19 的 `9147f8b` 已被「超窗兜底」绕过——`startCompact` 不再预拒，而是把转录按窗口比例截断（`transcriptCap = window × 0.4 × 3.2` 字符），保证摘要请求一定发得出去；原文全程归档不删，auto-compact 同样走兜底。会话死锁已解，完整分段压缩只剩「摘要覆盖率」优化点，性价比降为 nice-to-have。方案移入 `docs/reports/` 作决策记录。
- **修超窗压缩丢旧摘要**：`compactTranscriptOf` 原来把「此前摘要」拼进转录一起按尾部截断，而超窗兜底会压小预算——旧摘要排在最前，总是第一个被截掉，滚动累积链断裂，超窗压缩的摘要反而比正常压缩更差。现在旧摘要恒定保留在头部、只截消息中段，且旧摘要篇幅计入截断预算（消息转录保底 2000 字符），请求体积仍受 cap 约束。
- **清理过时文案**：≥100% 时提醒条按钮不再显示「分段压缩」占位与 aria-disabled 压暗、点击不再提示「尚未实装」，恢复「压缩上下文」可点；banner / 提示行 / 发送 flash 改为「可压缩（摘要略粗），或切换更大上下文的模型」；删掉 style.css 里对应的死样式。`aiCtxBannerState` 文案测试同步。
- 护栏：`ai-compact.test.mjs` 补「超窗截断仍保留头部旧摘要 + 总量受 cap 约束 + 超长旧摘要保底」，`ai-constants.test.mjs` 同步 banner 文案；前端全量 `npm test` 通过。

### 修复（可视化卡片「全屏」显示不出图、「另存为」的 SVG 打不开）

- **成因**：mermaid 用 `htmlLabels` 把节点文字放进 `foreignObject` 的 HTML 里，序列化时空元素被写成 `<br>`（HTML 不补斜杠）。这份字符串在卡片里由 HTML 解析器读（容错），但编成 `data:image/svg+xml,…` 交给 `<img>`、或存成 `.svg` 文件时，浏览器按 **XML** 整份解析——一个未闭合的 `<br>` 就让整张图加载失败：灯箱显示「无法显示」，文件只画出错误点之前的半张图（`Opening and ending tag mismatch: br line 1 and p`）。
- **修复**：`frontend/src/core/widget.js` 新增纯函数 `svgXmlSafe`（XML 空元素补自闭合 + `&nbsp;` → `&#160;`），`svgToDataUrl`（全屏灯箱）与卡片「另存为」的 SVG 出口都先过一遍；HTML 卡片导出不受影响。SVG 命名空间没有同名空元素（是 `<image>` 不是 `<img>`），全局替换不会误伤。
- **顺手补齐失败提示**：用户自己的 `.svg` 文件本身不良构时不自动洗白（那会让坏文件看着正常，发给别人/用浏览器打开还是坏的），但预览外置窗补上了 `<img>` 的 `onerror`（此前解码失败是一片空白），渲染视图与「导出为 PNG」的报错也点明「多半是标签未闭合或用了 `&nbsp;` 这类 HTML 实体」。
- 用例进 `frontend/test/core/widget.test.mjs`（空元素/实体/不误伤成对标签、data URL 里不再残留裸 `<br>`）。

### 修复（AI 回复「话说到一半」停住时看不出原因）

- **结束原因如实上报**：传输层归一结束原因时，`length`（输出预算打满 / 上下文超限）与 Anthropic 的 `max_tokens` 不再被折成 `stop`；只发 `[DONE]`、不给 `finish_reason` 的网关记为 `unknown`（`internal/aitransport/sse.go`）。此前两类都表现为「正常完成」，界面上与模型自己写完完全无法区分。
- **落盘留痕**：assistant 消息新增 `finishReason` / `truncated` 字段（并进消息指纹），重启重放后仍能判断某条回复当时是正常收尾还是被截断。
- **提示与出口**：被截断的回复在正文末尾出现警告色提示条 + 「继续」按钮，点一下从断点接着写、不重复已输出内容；`unknown` 只在正文悬空收尾（冒号 / 逗号 / 破折号等）时才提示，正常网关不打扰。
- 判定与文案抽成 `frontend/src/ai/ai-truncation.js`（纯函数，`test/ai/ai-truncation.test.mjs` 覆盖，已登记 `npm test`）；`internal/aitransport` 补两条用例（`[DONE]` 无原因 → `unknown`、`length` / `max_tokens` 原样保留）。
- 背景：免费通道（hy4-flash-free）在准备输出长 SVG 时多次停在一句话后面，客户端当时既无提示也无续写入口（会话 `session-mwpjsx19f56c0`）。

## v1.2.0 — 2026-11-20

### 重构（窗口架构迁移到 Wails v3：一进程多窗口）

- **一进程多窗口**：框架从 Wails v2 迁到 v3（`application.New` + `NewService` + 多 `WebviewWindow`），主窗口可多开、AI 浮窗与调试控制台不再是独立进程；第二实例、`--new-window`、窗口打开模式、打开目录/软切换、打开浮窗/调试台全部改为同进程窗口。窗口级状态（启动参数、脏标记、AI 运行状态、工作区）按窗口名归属，绑定方法经 v3 的 `application.WindowKey` 上下文拿到调用方窗口。
- **跨窗口会话复用**：原文件注册表 + 信箱协议（`internal/windowreg`）整体删除，改为进程内注册表；命中目标工作区时直接向该窗口投 `app-open-ai-session` 事件并前置，目标窗口回执 ok/mismatch（超时 2.5s），失败自动退化为开新窗口。
- **事件桥**：新增 `core/app-events.js` + `core/event-scope.js`，48 处订阅收口（`EventsOn` 只允许出现在桥与 mock），控制命令按 sender/工作区过滤；`term/cmd/run/browser/reading` 流事件在创建后登记 owner，输出只定向投归属窗口（创建竞态前的广播仍由 id 过滤兜底）。
- **前端绑定**：不再生成 `wailsjs/`；运行时动态加载 `/wails/runtime.js`，`backend` 用 `Call.ByName('main.App.<Method>')` Proxy，原有调用点零改动；`window.go` / `window.runtime` 兼容 shim 保留旧模块。
- **构建**：`tools/rebuild-exe.ps1` 与 `scripts/build-installer.ps1` 改为「npm run build → `wails3 generate syso` → `go build -tags production`」；补上 v3 的 `Taskfile.yml` + `build/config.yml`，`wails3 task windows:build` 与 `wails3 dev`（Vite 热更新 + 应用）可用；`build/windows/info.json` 改为 v3 schema，修复 v2 模板导致的 exe 版本资源为空；新增 `portablewindows_other.go` 等跨平台桩，`tools/check-crossbuild.ps1` 非 Windows vet 加 `-tags purego`。
- **清理**：删除 `internal/windowreg`、`internal/newwindow`、`frontend/wailsjs` 与信箱轮询兼容代码。
- 方案与实测记录见 `docs/finished-plans/wails-v3-migration.md`、`docs/finished-plans/wails-v3-event-filtering.md`、`docs/reports/wails-v3-p0-spike.md`。Go/前端全量测试、linux/darwin 交叉编译、`rebuild-exe.ps1` 测试门均通过；托盘/拖放/终端/DPI 等 GUI 场景留手工回归。

### 改进（浮窗行为工程化：窗口位置 / 尺寸记忆）

- **窗口几何记忆**：新增 `internal/windowgeom`（矩形收敛纯逻辑 + `window-state.json` 原子持久化）与根壳 `window_geometry.go`。主窗口、AI 浮窗、调试控制台分别记住位置与尺寸，下次启动原样恢复；最大化状态记住的是最大化前的还原矩形，不会把满屏尺寸当成普通尺寸。
- **多屏安全**：创建窗口时按当前 `Screen.PhysicalWorkArea` 收敛——显示器被拔掉或分辨率变化后，窗口自动回到主屏可见区；从 4K 屏回到小屏时尺寸收敛到当前工作区，标题栏不会被挤到屏幕外。
- **多主窗口级联**：额外主窗口（main-2/…）不单独持久化，从 main 的还原矩形按 28px 级联，避免每次启动都叠在同一位置。
- **落盘时机**：移动 / 缩放 500ms 防抖写入；关窗与进程退出同步 flush（拖拽刚结束就关窗也不会丢）。文件是 `<应用数据>/window-state.json`，损坏时静默回落空状态，不阻塞启动。
- 方案与后续路线见 `docs/finished-plans/window-geometry-memory.md`。

### 修复（浮窗 / 调试台的关闭语义）

- **独立调试台关闭不再退出整个应用**：v2 里一个窗口就是一个进程，`runtime.Quit` 只关自己；v3 一进程多窗口后它是应用级退出。独立控制台的关闭改为按调用方窗口 `ForceClose`（兜底 `WindowClose`）。
- **主窗口标题栏 X 改走窗口级关闭**：先 `WindowClose` 再兜底 `Quit`，重新经过 Go 的 `WindowClosing`（托盘隐藏 / 脏数据与 AI 回合确认 / 最后一个主窗口收口），不再绕过确认直接退出。
- **浮窗/调试台关闭不再误停后台服务**：`beforeCloseWindow` / `ForceClose` 的收口条件补上「关闭的必须是主窗口」，避免关浮窗时把 MCP、插件服务和工作区监听一起停掉。
- **收起态不写几何记忆**：浮窗「收起」（只留标题栏）期间新增 `SetWindowCollapsed` 标记，几何采集跳过，下次打开仍是收起前的展开尺寸。
- **独立调试台窗口可拖动**：无边框窗口的头部补拖动区（`body.console-only .dbg-head`），按钮保持可点；停靠模式不受影响。
- **显式退出恢复确认**：v3 的 `Application.Quit` 不经过 `WindowClosing`（v2 的 `runtime.Quit` 会先调 `OnBeforeClose`）。菜单/托盘的「退出」改为 `QuitApp` 汇总全部窗口与进程级任务：无风险直接关闭全部窗口；有风险发 `app-quit-request`，前端复用关窗确认框，确认后 `ForceQuitAll`。
- **最后一个主窗口关闭 = 退出程序**：带走浮窗/调试台（确认理由聚合附属窗口的 AI/未保存状态）；应用级服务收口抽成幂等的 `teardownAppServices`，只在应用退出时执行一次。
- 新增护栏 `frontend/test/core/window-close-semantics.test.mjs`，防止这些路径再退回 `runtime.Quit`。

### 改进（终端弹出窗口：浮窗行为工程化第二期）

- **终端会话可弹出为独立窗口**：终端页签右键「在独立窗口打开」→ 新建无边框终端窗口（terminal-only 形态：全屏渲染该会话，头部即拖动区，带「收回主窗口 / 关闭会话」）。ConPTY 会话与 64 KiB 环形缓冲全程不动，跨窗口只切换事件归属 + 环形缓冲快照回放（≤20k 字符，防回放与暂存双写），主窗口卸掉页签。
- **关窗自动收回**：弹出窗口关闭时 Go 广播 `term-popout-closed` 指定交还目标（来源窗口，不在了就当前主窗口），主窗口把页签接回来；「关闭会话」走 `TermClose`，Go 查不到会话则不投递，不会复活死页签。
- **几何**：终端窗口按 `"terminal"` 槽位级联记忆（额外窗口 28px 错位，最后一次移动生效）。
- **启动门控修正**：无主窗口的形态（`--ai-float` / `--debug-console` / 终端窗口作首窗）不再拉起 AI 定时任务、插件服务、MCP 客户端与使用统计（此前按 `ctx` 判定窗口形态在 ServiceStartup 里拿不到，实际一直按主窗口路径初始化）。
- 已知边界与机制见 `docs/finished-plans/terminal-popout.md`；接线护栏 `test/terminal/term-popout-wiring.test.mjs`。

### 改进（v3 独有能力一批：热键 / 窗口切换器 / 屏幕看护 / MCP 变体）

- **全局热键**（v2 没有全局热键 API，v3 `GlobalShortcutManager`）：`Ctrl+Alt+A` 呼出 AI 浮窗、`Ctrl+Alt+T` 主窗前置并打开终端面板、`Ctrl+Alt+D` 呼出调试控制台。固定键位，组合键被其他程序占用时只记日志；退出时随 v3 cleanup 注销。
- **窗口切换器**：quick-switch（`Ctrl+反引号`）新增「窗口」层，列出其他存活窗口（形态 · 工作区）并跳转——Go 侧进程内窗口注册表直接出清单，`WindowList` / `WindowFocusByName` 两个绑定。
- **显示器布局看护**：每 10s 轮询显示器布局（v3 在 WM_DISPLAYCHANGE 自动刷新 ScreenManager），变化后等 1.5s（让系统排完窗口）把可见窗口按新布局收敛一次——只平移不缩放（`windowgeom.ClampVisible`），悬跨双屏的窗口不会被裁。
- **调试控制台窗口不占任务栏**：`HiddenOnTaskbar`（Windows 嵌套选项），工具窗口的恢复走切换器「窗口」层与 F12；AI 浮窗/终端窗口保持任务栏。
- **MCP server 构建变体**：v3 内置 MCP server（`-tags mcp`，`app_info/windows_list/window_control/js_eval/dom_*/mouse_*/keyboard_*`，外部 agent 经 Streamable HTTP 驱动应用界面）。`js_eval` 可在页面里执行任意 JS，故做成**构建变体**——标准构建完全不含该端点；`tools/rebuild-exe.ps1 -IncludeMCP` 出变体包，令牌随机生成持久化到 `<应用数据>/mcp-server.json`（0600），端口占用自动后移。见 `docs/finished-plans/app-mcp-server.md`。

### 审查修复（2026-11-21 子代理全面审查）

- **坐标系统一（P1）**：v3 的窗口 Position/Size 是 DIP 逻辑坐标，几何记忆此前与 `PhysicalWorkArea`（物理像素）混算，非 100% 缩放/混合 DPI 下会把窗口夹到屏幕外或漏判离屏——工作区统一取 `Screen.WorkArea`（DIP）。
- **退出标记**：`stopTray` 不再清 `quitRequested`（ForceQuitAll 先置位再 teardown，中途被清会让退出流程里的窗口钩子守卫失效）；终端交还投递加 `teardownDone` 守卫，应用收尾期一律不投递。
- **MCP 变体**：`App.Run` 报错不再静默 exit 0（启动失败给退出码 1）；端口探测失败的兜底改 `WAILS_MCP_PORT=0`（系统分配）而非回落已占用端口；被占端口不再回写 `mcp-server.json`（第二实例会把第一实例的连接信息改写成死端口）；**令牌不再向子进程环境继承**——`envvars.SanitizeChildEnv` 剥离 `WAILS_MCP_*`/`CADT_*`，终端/命令桥/运行代码/沙箱/插件服务/MCP 子进程全覆盖，堵住「受控进程拿凭据反向驱动宿主」的通道。
- **文件拖放修复（P1）**：v3 的 drop 只回调 Go 侧监听（不发回 JS 事件），此前 `rt.OnFileDrop` 通道不存在、拖放打开文件静默失效——Go 收下后转 `app-file-drop` 窗口事件，前端经事件桥按窗口消费。
- **窗口生命周期**：`windowReady` 的 Show/Maximise 改一次性标记（托盘隐藏的窗口遇 reload 不再被弹回）；首次运行「未移动直接最大化」也记还原矩形；浮窗先启的进程开出首个主窗口时惰性补齐 AI 侧服务（定时任务/插件服务/MCP 客户端/使用统计）；通知点击激活在无主窗形态回退浮窗；`event_owner` 表满改 FIFO 淘汰（不再整表清空打回广播）。
- **前端**：`WindowGetSize` 适配 v3 双返回值打包成数组的变化（浮窗「收起前尺寸」恢复失效）；终端独立窗口里 Shift+Esc 改为关窗（收起会留一块空白无边框窗口）；调试台作唯一窗口时关窗确认框可见（console-only 放行 #dialog-mask）；终端暂存缓冲加条目上限与 TTL（多窗口广播兜底不再无界累积）；`attachResumedTermSession` 快照失败不再丢暂存；AI terminal 工具对已弹出终端的报错文案与描述补弹出语义。
- **最大化还原空白窗修复（用户实测复现）**：v3 的 `Maximise()` 是裸 `ShowWindow(SW_MAXIMIZE)`，绕过了 `Show()` 里「导航完成后置 WebView2 控制器可见」的联动——从隐藏窗口直接最大化会得到「窗口可见但 WebView 隐藏」的全屏空白（窗口树取证：Chrome_WidgetWin 三层子窗口 vis=False）。最大化后补一次 `Show()` 修复。
- **构建/文档**：Taskfile 的 NSIS 目录对齐 `installer/`（package 链路此前是死链）；安装包构建补 `wails3 generate webview2bootstrapper`（裸 Win10 自动装 WebView2，此前静默缺失）；build-installer 支持 `-IncludeMCP`；删除 launchargs 单实例 ID 死代码与 package.json.md5 残留；packaging.md / AGENTS / README 口径修正（切换器键位、wails_tools.nsh 手工维护、版本五处、wails3 dev 前置构建说明、AGENTS 补 event_owner/spike/src-core 新模块条目）。

### 审查修复（2026-11-21 等价性对照）

- **对话框取消不再报错**：v2 显式吞掉取消（空值+nil），v3 把 cfd 的「cancelled by user」透传成错误——打开/保存/文件夹/插件选择全部取消路径现在返回空值，前端不再弹红字。
- **浮窗单独运行的设置/memo 入口回退**：无主窗口时 `--open-settings` / `--memo` / 浮窗齿轮改为投递到浮窗自身（与 v2 的单实例转发等价，不再静默丢弃）。
- **托盘态清理**：第二实例带文件/设置/memo 目标把窗口拉出前台时，顺手复位退出标记并撤掉通知区图标（v2 每个分支都做，此前图标残留）。
- **`--new-window <dir> --ai-session=<id>` 组合**：会话 id 不再被丢弃，随窗口启动上下文带入软切换。
- **关窗确认口径**：关掉非最后一个主窗口时不再用「关闭将终止这些任务」弹危险确认（终端会话/后台命令在进程里活着，并不随该窗口死）。
- **8 秒兜底显示回归**：v2 的 `ensureWindowShown` 语义找回——导航 8s 未完成强制露出窗口，WebView2 卡死不再「进程活着但没窗口」。
- **标题栏 X / 终端收回绕过关窗确认（用户实测）**：v3 两条关窗路径发不同事件——JS `WindowClose()` 发 `Common.WindowClosing`、原生 WM_CLOSE 发 `Windows.WindowClosing`（经默认映射汇入 Common）；关窗钩子此前挂在 `Windows.*` 上，JS 关窗路径完全绕过 `beforeCloseWindow`（改文件点 X 直接退出、终端窗口收回不发交还事件）。钩子移到 `Common` 后两条路径统一：先于内部关闭监听执行，取消语义完整。
- **终端弹出窗口实测反馈一批**：terminal-only 漏藏 `#ai-panel`（`#body-col` 直接子级）根因是 style.css 修改后未重跑 `npm run build`，dist 停在旧版——**已重构建，后续前端改动一律先 npm run build**；启动防闪现（app-booting 首帧隐藏 + 模式确定后摘除 + 5s 兜底）；标题栏去四向箭头光标；头部加「工作区 / Shell」胶囊并同步 OS 窗口标题；收回链路双侧诊断日志；v3 内部关闭监听语义核verified（Common 先于内部关闭执行、取消生效）。
- **手工回归第二批（用户实测）修复与裁定**：
  - **同工作区禁止双开（用户裁定）**：`openMainWindow` 加工作区守卫（已开即前置+投递会话/目标），启动恢复路径加 `IsWorkspaceOpen` 检查——会话双开丢失（两窗口同会话各持内存态，后关覆盖先关）的根源被堵住；深层的会话写回合并调查随窗口归属批次跟进。
  - **「一个文件一个窗口」禁用（用户裁定，轻量查看窗待评估）**：openMode 只支持 tab（appconfig 读取回落、OpenInNewWindows 退化为标签页打开、设置/切换器/AI set_setting 文案同步）；打开文件默认归属其父目录工作区。
  - **托盘语义重定义（用户实测反馈）**：托盘模式下主窗口点 X 一律收进托盘（不再弹确认框）；多主窗共用单托盘图标，恢复时全部找回（`shouldHideOnClose` 去 otherWindows 条件）。
  - **切换器「窗口」层含当前窗口**（勾选标记 + 「（当前）」后缀，点击自身 no-op）。
  - **第二实例参数无条件剥 exe 自身路径**（跨副本混跑时 exe 被当文件塞进二进制查看器，用户实测复现）。
  - `WindowReuseForSession` 探测日志（跨窗跳转命中与否的定位证据）。
- **启动挂起/闪退排查记录（测试环境副作用，非产品 bug）**：测试期强杀实例留下的 msedgewebview2 僵尸子进程会锁住 WebView2 用户数据目录，新实例的环境创建会挂起/静默退出（日志只到启动参数行、Go 层无 panic——applog 已接管 crash output 可排除）。僵尸进程自然消亡或手动清理后恢复。遗留改进：WebView2 环境创建失败时给用户可见的错误提示（当前静默退出，见 internal/applog 注释里的同款历史问题）。
- **v2/v3 共存警告（操作层面）**：两者单实例锁 ID 相同但转发协议不同——**同时运行会双开或挂起**（03:51 与 03:53 的日志证实）。测试 v3 前必须完全退出 v2（含托盘），任务管理器确认无 datalens 进程。
- **窗口归属遗留立项**：工作区监听单槽顶掉（wipe-guard L2 失明）、memo 租约同进程双写、`findWailsWindow` 多窗口不确定、对话框无属主、资源监听替换式登记——五项同根（进程级单例 vs 多窗口），统一按「调用方窗口键控」重构，见 `docs/unfinished-plans/window-ownership-refactor.md`（未开工，已知偏差均已声明）。

### 修复（设置页「默认读写权限」选完全权限时补上确认框）

- **现象**：设置 → AI → 权限 →「新会话默认读写权限」下拉切到「完全权限」时直接生效、不弹确认框；而会话级切换权限有图1 那样的强确认。默认值影响之后所有新会话，影响面更大却无确认。
- **根因**：两条路径代码不同——会话切换走 `ai-panel.js` 的 `setScope` → `confirmFullPermission`，设置页下拉的 change 只写 `config.defaultScope` 并保存，从未接确认框。
- **改法**：把 `confirmFullPermission` 提取为可带 `title/intro/note/top` 选项的共用函数，经 ctx 注入设置页；下拉选 full 时先把值回退到原档位（程序化改 `select.value` 不触发 change，`enhanceSelect` 同步自绘触发器文本），再弹同款确认框（`top: true` 盖在设置窗上），确认后才落盘为 full。取消 / Esc / 点遮罩关闭都无需额外回调，显示天然保持旧值。
- 改动：`frontend/src/ai/ai-panel.js`、`frontend/src/ai/ai-settings-dialog.js`。`node --check` 语法通过。

### 文档（6 家 harness 终端唤醒机制调研：手动停止不唤醒是主流）

- 调研 cline / codex / opencode / pi / ZCode / dsh 六家在终端命令结束、手动停止时是否唤醒 AI 会话。结论：手动停止不唤醒是绝对主流（6 家全部如此），本应用 `code !== -1` 的排除口径与主流一致、不是 bug；"会唤醒"的印象来自"后台正常完成"或 ZCode 独有的"停止后台任务算终态"两类场景。
- 核查 `code === -1` 语义：它严格说是"非正常退出"标记（含两种罕见异常来源），但在"排除唤醒"方向上误判无害——主流排除的是整个"被中止"类别。若要对齐 ZCode 需显式标记而非复用 -1。
- 文档：`docs/reports/terminal-wakeup-survey-2026-11-21.md`。仅调研，未改代码。

### 改进（信箱弹层改为两行卡片，长通知不再竖排成窄条）

- **现象**：点头部「信箱」胶囊弹出的通知列表把会话名徽标和摘要并排塞在一行，徽标就占 140px，后台命令这类长摘要被挤成很窄的一列、竖着折成十几行，很难看。
- **改法**：信箱行改用专用两行布局——上行「会话名 + 类别徽标」（后台命令 / 待拍板 / 子代理…按 kind 上色，未知 kind 落「通知」不拼 class），下行摘要独占整个弹层宽度、最多两行、超出悬停看全文。专用 `.ai-mailbox-*` 样式与计时器 / 定时任务 / 智能体树共用的 `.ai-chips-row` 分开，互不影响。
- 改动：`frontend/src/ai/ai-panel.js`（`mailboxRow` / `MAILBOX_KIND_LABEL` / `renderMailboxPopInto`）、`frontend/src/style.css`（`.ai-mailbox-*`）。`npm run build` 通过、全量 `npm test` 1980 通过（串行两次）。

### 改进（斜杠选中技能即作为本轮请求发出，不再让「继续输入需求」）

- **现象**：输入 `/` 从补全列表选一个技能后，只提示「已加载技能（随下一轮发送），继续输入需求」，输入框被清空、什么都没发出去，看起来像「技能不能单独发、必须配文字等下一轮」。
- **对齐调研**：ZCode / dsh / opencode / cline / codex / pi 六家一致——选中 skill 即作为本轮请求发出，正文作为 user context 注入，**没有「挂起等下一轮」的状态机**。本应用底层其实也支持只发 skill（附件让发送按钮变亮、空文案由 `startSessionTurn` 补占位），纯粹是斜杠路径主动清空输入框 + 误导文案造成的错觉。
- **改法**：`ai-slash.js` 新增纯函数 `slashSkillInvocation`（无参 → 空文案只发 skill，带参 → 原文连附件一起发）；`invokeSkillItem` 附加附件后直接 `sendComposerMessage`，不再清空输入框干等；`/help` 与文件头注释同步；附件栏技能选择器与 `/skill 名字` 的文案改为「可直接点发送（只发 skill），或继续输入需求」。
- 测试：`ai-slash.test.mjs` 新增 `slashSkillInvocation` 用例；`npm run build` 通过、全量 `npm test` 1979 通过（串行）。

### 修复（会话数据诊断不再卡在「正在分析」，字体一并修正）

- **现象**：打开会话数据诊断后一直显示「正在分析会话数据…」，必须点「重建搜索索引」才出数据；诊断正文的中文字体发虚发窄，很难看。
- **根因**：`Stats()` 是诊断用的只读统计，却顺带调用 `syncSessionIndex` 重放全部脏会话——长会话要跑几秒，前端 `await backend.AISessionIndexStats()` 一直不返回，文本填不进去；点「重建索引」时 `ResetFiles()` 关掉了 `Stats()` 正在用的 DB，才让 await 抛 `sql: database is closed` 结束等待、文本终于显示（于是看起来像「点了重建才出来」）。
- **改法**：`internal/sessionindex/sessionindex.go` 的 `Stats()` 改为纯读取当前索引状态，不再同步脏会话，脏数照实上报（`dirty` 列）让诊断能看出待索引量；`frontend/src/style.css` 的 `.ai-diagnostic-pre` 字体从 `ui-monospace/SFMono-Regular`（Windows 上中文回退到宋体）改为项目统一的 `--editor-font-family`（JetBrains Mono + 微软雅黑）。
- 测试：`internal/sessionindex/sessionindex_test.go` 新增 `TestStatsDoesNotRebuildDirtySessions` 锁定「Stats 不重建脏会话」；Go 相关用例通过。

### 改进（归档会话改为明确的只读态，不再只靠右下角一行灰字）

- **现象**：查看归档会话时不能编辑消息、也不能发送，但界面上编辑按钮照常出现、输入框照常可填，直到点发送才被后端拒绝，右下角甩出一行英文 reason 码 `archived`，用户很难看懂。
- **改法（三层）**：① 视觉——composer 顶部常驻琥珀色横幅「归档会话 · 只读，不能发送消息」并就地给出「取消归档」按钮（直接调 `archiveSession(session, false)`），输入框设只读、模式 pill 置灰；② 入口——`canInlineEdit` 加归档判定，消息操作收起编辑 / 重试 / 重新生成 / 回退 / 分支等改写动作（只留复制、投递等只读动作），`saveInlineEdit` 开头再挡一道；③ 兜底——起轮与原地保存的 `archived` 失败原因统一成中文文案，不再露出裸 reason 码。
- 改动：`frontend/index.html`（横幅结构）、`frontend/src/ai/ai-panel.js`（`syncArchivedBanner` + 三处门禁 + 两处文案）、`frontend/src/style.css`（`.ai-archived-banner` / `.ai-composer.is-archived`），新增测试 `test/ai/ai-archived-readonly.test.mjs` 并登记 `npm test` 清单；同步更新 `ai-inline-edit-wiring.test.mjs` 的 `canInlineEdit` 签名断言。`npm test` 全量通过。

### 改进（会话右键菜单加图标，归档移到删除上方）

- 会话右键菜单按图 2 的布局调整：「归档会话 / 取消归档」从诊断区移到「删除会话」正上方，归档与删除紧邻成组；所有菜单项补上前缀图标（新建 / 支线 / 置顶 / 重命名 / 导出 / 诊断 / 提升 / 清空信箱 / 复制 ID / 复制路径 / 归档 / 删除），图标走菜单统一的 `item.icon` 通道。
- 图标表新增 `archive`（带盖归档盒）与 `unarchive`（归档盒 + 取出箭头）两枚，归档态自动切换；全部用内联 SVG、`currentColor` 着色，无新依赖。
- 改动：`frontend/src/core/icons.js`、`frontend/src/ai/ai-session-list.js`（`buildSessionMenuItems`）、`frontend/test/ai/ai-session-list.test.mjs`（新增归档位置 + 图标完整性用例）。`npm test` 全量通过。

### 改进（子代理通知等结论型应用消息支持 Markdown 渲染，可切回原文）

- **现象**：后台子代理结算 / 提问、支线结论以应用消息卡片注入，正文里的 `###` / `**` / 反引号代码围栏都按纯文本原样显示（`查看指令` 区用 `<pre>`），可读性差。
- **改法**：只对结论型 kind（`subagent` / `subagent-ask` / `sidechat`）渲染 Markdown；指令型（git / 定时 / 计划批准 / 会话投递 / 工作区防护等）保持原文——「查看指令」的用途是核对实际发给模型的字节，渲染会吃掉标记符号。卡片头新增「查看原文 / 查看渲染」切换，随时切回逐字原文；开头的宿主环境块（`<system-reminder>`）始终原文弱化显示，不参与渲染。
- **性能**：复用已注入面板的单例 `renderMarkdown`（无新依赖、零体积成本）；默认折叠时**不渲染**，只在展开且处于渲染视图时才跑，结果按消息 key 缓存，流式期间 `renderMessages` 全量重放直接取缓存、零成本；正文超 12000 字符退回原文。
- 改动：`frontend/src/ai/ai-app-message.js`（`appMessageMarkdownEligible` 纯函数）、`frontend/src/ai/ai-panel.js`（`renderAppMessage` 双视图 + 懒渲染 + 缓存）、`frontend/src/style.css`（`.ai-app-msg-md` + 末尾全局 `.hidden { display:none }` 兜底）、`frontend/test/ai/ai-app-message.test.mjs`（eligibility + 全局 hidden 规则守卫）。`npm test` 全量通过、`npm run build` 通过。
- 顺带在 `style.css` 末尾加全局 `.hidden { display: none }` 兜底：本项目历史上逐类配 `.xxx.hidden`（已有 30 条），新增组件常漏配导致隐藏失效（本次卡片切换就踩到一次）。全局规则不带 `!important`（不压过内联 `style.display` 与既有 `!important` 显示逻辑）、放文件末尾（同特异性后写赢），已有逐类规则特异性更高、行为不变。

### 改进（AI 会话列表改按「最近一轮结束时间」排序，刚结束的会话冒到顶）

- **现象**：刚结束的会话仍按发问时刻排在列表中间（如跑了很久的会话显示 17:30 的发问时间，结束时间却是更晚），用户期望它排到最前。
- **背景**：参考 opencode / ZCode / dsh 三家 harness 实测口径——dsh 按用户发问时间（结束不刷新，与旧行为一致），opencode 按 `time.updated`（运行中冻结、运行结束才刷新），ZCode 按 `lastActivityAt`（含 turn/工具活动，运行中整体置顶）。作者拍板采用 **opencode 模式**。
- **修法**：排序键与时间文案同源 `sessionActivityTs` 改为 `max(最近一轮结束时间 finishedAt, 最近发问时间 turnStartedAt)`：运行中（工具结果 / 流式回复）两个值都不推进，会话不会在列表里跳动（保住旧版「工具刷屏顶列表」的修复）；用户发新一轮按发问时刻前移，本轮结束按 `finishedAt` 再前移。新增 `sessionEndTs()`（只认已收尾 assistant 的 `finishedAt`，跳过 `status:'streaming'`）。会话 meta 加 `endTs` 缓存字段（仿 `turnTs`），占位会话从 meta 读回，重启后排序不跳位；老会话无 `finishedAt` 时 `endTs=0`，自然回落到发问时间。
- 改动：`frontend/src/ai/ai-session-store.js`（`sessionEndTs` + `sessionActivityTs` + meta `endTs`）、`frontend/src/ai/ai-session-disk.js`（`toStubs` 读回 `_endTs`）；测试 `test/ai/ai-session-store.test.mjs` 新增 5 例（运行中冻结 / 结束前移 / 发问前移 / 老会话回落 / meta 缓存），全量 `npm test` 通过。

### 修复（AI 消息队列抢占一条后，其它插话消息消失）

- **现象**：生成中输入两条插话消息后，点其中一条的「抢占」（⚡）发送，这条发出去了，另一条却凭空消失。
- **原因**：`preemptQueuedItem` / `preemptComposerMessage` 抢占时会调 `stopGeneration`，而 `stopGeneration` 与 1.2s 后的 `finishStream` 都会执行 `queueMod.clearSteer(sessionId)`——这是「放弃当前任务」语义，把本会话所有 pending steer 一起清掉。抢占的意图只是让这一条立即发出，其它消息本应保留，却被连带丢弃。
- **修法**：两条抢占路径在停轮**之前**先 `model.fallbackSteerToQueue(sessionId)`，把本会话其它 steer 降级为 `queue`（被抢占那条已改投 queue，不受影响）；`clearSteer` 清不到它们，它们会在被抢占那条发出后按 FIFO 依次冲刷。停止按钮的「放弃当前任务」语义不变。
- 改动：`frontend/src/ai/ai-message-queue.js`（两处抢占路径）、`docs/finished-plans/ai-turn-steering.md` §4.5；测试 `test/ai/ai-message-queue.test.mjs`（新增「其它 steer 降级保留」用例）、`test/ai/ai-turn-steer-wiring.test.mjs`（两条抢占路径接线断言），51 例全绿。

### 修复（AI 流式计时超过 1 小时只显示「X 分 Y 秒」，缺小时/天档位）

- **现象**：AI 处理中的计时条（`.ai-process-timer`）跑到 82 分钟时仍显示「82 分 56.3 秒」，分钟数一路涨下去，不换算成小时/天。
- **原因**：计时条文案走 `ai/ai-constants.js` 的 `aiFormatLiveDuration`，它只有「秒 / 分 秒」两档；同文件的 `aiFormatDuration` 虽有小时档但也没天档。
- **修法**：`aiFormatDuration` 抽出共用的 `aiDurationText`，统一为「天 / 小时 / 分 / 秒」四档整数秒（值为 0 的单位跳过）；`aiFormatLiveDuration` 补上小时/天档——不到 1 小时保留十分位小数（40.2 秒 / 3 分 40.2 秒），到小时/天档改整数秒。图片里的 82 分 56.3 秒现在显示「1 小时 22 分 56 秒」。顺带修掉 `NaN` 输入时返回「NaN 天」的边界 bug（`Number(ms) || 0` 兜底）。
- 测试：`test/ai/ai-constants.test.mjs` 新增 2 例覆盖四档与非法输入，11 例全绿；相邻 `ai-terminal-tools` / `ai-team-model` 24 例无回归。

### 修复（未配置生命周期钩子时，发首条消息仍闪「正在执行该会话的生命周期钩子」）

- **现象**：明明没有任何生命周期钩子（甚至总开关已关），空会话发第一条消息时状态栏仍提示「正在执行该会话的生命周期钩子，完成后再发送…」。
- **原因**：`ai-panel.js` 的 `startSessionTurn` 只判断「`lifecycleAIStart` 已注入（main.js 永远注入）+ 空会话首轮」就**无条件** flash；是否真有 `session-start` 条目要到控制器下游才知道（无条目时立即 `{ran:0}` 返回，提示却已经闪出去了）。
- **修法**：`shell/lifecycle-hooks.js` 的 `runEntries` 增加可选 `onWillRun(list)` 同步挂点——只在「确有启用的条目、且未被重入护栏跳过」时回调一次；`runForAISessionStart` 透传，ai-panel 把 flash 挪进该回调。无条目 / 总开关关闭 / 已跳过都不再提示，真有钩子时的阻塞等待反馈语义不变。
- 测试：`test/shell/lifecycle-hooks.test.mjs` 新增 2 例（只在确有可执行条目时回调、重入跳过不回调），25 例全绿；`npm run build` 通过。

### 新增（帮助 → 教程：内置文档讲解专门语法）

- 帮助菜单新增「教程」，以内置虚拟文档打开 `docs/tutorial.md`，与用户协议 / 隐私协议一致用固定只读展示（不可解锁、无保存入口）。
- 内容只收录有专门语法、光看界面不易弄明白的部分，按「解决什么—怎么写—边界」组织：搜索排除表 `search-ignore`（按名/按路径、`!` 取反与覆盖顺序、四处检索范围）、生命周期钩子（9 事件、阻塞与非阻塞、工具名匹配器、执行环境、AI 代配必审批、为何存 localStorage）、JSONPath 查询（路径/切片/联合/递归/过滤运算符）、便签定位点 `cadt-memo://`、命令行文件与行列定位。博客式叙述，分级清晰，不使用 emoji。
- 改动：`docs/tutorial.md`（新）、`frontend/src/shell/app-links.js`（import + `showTutorial` + 导出）、`frontend/src/main.js`（解构 + 帮助菜单项）、`frontend/test/shell/app-links-readonly.test.mjs`（教程纳入固定只读护栏）。

### 修复（AI 头部「定时」胶囊点了没反应，且在所有会话都显示）

- **现象**：头部「定时」胶囊显示某会话的任务数后，切到任何别的会话都一直挂着，点击也没有任何反应。
- **原因**：两处接线缺口——① `createAISchedule` 的 ctx 里注入了 `togglePop` 却从没绑到胶囊 DOM 上（弹层机制、`renderSchedulePop` 全就位，唯独差一行 `addEventListener`，计时胶囊有同款接线可对照）；② 胶囊口径早已改成「绑定当前会话的任务」，但 `syncActiveSessionUI` 只重刷计时/隔离芯片不重刷定时胶囊，切换会话后残留上一个会话的显隐与角标。
- **修法**：`ai-schedule.js` 工厂时给胶囊绑 click → `ctx.togglePop`（点击弹出「本会话的定时任务」弹层：行进编辑器、底部新建与全部管理入口），显隐刷新抽成缓存同步的 `updateChipFromCache` 并导出 `syncChip`；`syncActiveSessionUI` 在 `timerMod.render()` 旁补 `scheduleMod.syncChip()`（切会话按缓存重算，不拉后端）。
- 测试：新增 `test/ai/ai-schedule-chip-wiring.test.mjs`（钉死点击接线与会话口径），`ai-session-ui-sync.test.mjs` 的会话级 chrome 清单与 switchSession 负向清单补 `scheduleMod.syncChip`。

### 改进（Git 图谱对齐 JetBrains：本次变动顶层目录 / 文件 diff / 提交筛选 / 分割线 hover）

- **本次变动树加工作区顶层节点**：详情「本次变动」文件树最外层套一层工作区目录名（JetBrains 式），其下才是 docs/frontend 等；`fileTreeFromChanges(files, rootName)` 加可选根名参数，不传保持旧行为，顶层节点加粗+accent 图标。
- **点击文件看当次提交 diff**：本次变动树的文件行可点击，调新绑定 `GitGraphCommitFileDiff(dir, sha, path, maxLines)` 拉该文件在选中提交中的 unified patch，开只读虚拟 .diff 文档走 patch-view 只读快照渲染。Go 引擎复用 `GraphCommitFiles` 的端点语义（普通对父/根对空树/合并对第一父），sha 正则+rev-parse 校验、path 越界校验、`--no-ext-diff/--no-textconv` 防外部命令、maxLines 截断、只裁尾部一个换行保住空上下文行。Wails 绑定与 dev mock 同步。
- **提交搜索增强**：搜索框右侧加「正则（.*）/ 区分大小写」两个 SVG 开关，并新增「分支 / 用户 / 日期」三个下拉筛选（不做路径）。分支=切换查看该分支历史（复用 ref 机制），用户按 author/email 过滤，日期按 today/7d/30d/1y 过滤；过滤缓存键覆盖全部条件、非法正则不打断渲染、泳道/加载更多/预加载在筛选态收敛。新增 `buildCommitMatcher` 纯函数与 `regex`/`case-sensitive`/`filter`/`user`/`calendar` 五个 SVG 图标（无 emoji/文字图标）。
- **分割线 hover 一致性**：hover「提交列 | 详情」竖分割条时，头部那段静态竖线同步高亮（此前 body 变蓝、头部仍灰，视觉断成两截）；刷新/关闭按钮位置不变。
- 测试：`internal/gitinfo/graph_test.go` 新增 diff 集成+校验用例，`test/git-graph/git-graph-lane.test.mjs` 新增根名/匹配器用例；Go 全量测试、前端全量测试与 vite build 均通过。

### 改进（工作区搜索排除表 search-ignore + 配置文件归拢到 .cadt/config/）

- **全局搜索/目录树可自定义排除**：工作区放 `.cadt/config/search-ignore`（一行一条，`#` 注释、`!` 取反、不含 `/` 按路径每段名字匹配、含 `/` 按相对路径 glob），即可把 `.aoci` 这类认知资产/噪音目录从 UI 全局搜索、AI `search_text`、`glob`、目录树 `list_dir` 一并排除。解析层 `internal/search/ignore.go` 产出统一规则，rg `--glob` 尽力剪枝 + 命中二次过滤、内置 WalkDir 与 `FindFiles` 直接剪枝、`fsops.ReadDirTree` 同步遵守；按 mtime 缓存、根自身永不跳过。硬编码忽略表 `SkipDir`/`SkipPath` 保持独立，wipeguard 结构指纹等不接入用户配置。
- **配置文件归拢**：Git 提交风格配置从 `.cadt/git-commit-style.json` 迁到 `.cadt/config/git-commit-style.json`，`ai-git.js` 的 `GIT_COMMIT_STYLE_PATH` 与提示词同步（不做向前兼容，旧文件不再读取）。`cadt-file-layout` 技能的子目录表与路径速查表补 `config/` 说明。
- 测试：`internal/search/ignore_test.go`（解析/取反/按名/路径 glob/三路径）、`app_fs_test.go`（目录树遵守配置）新增，Go 全量测试通过。

### 改进（Git 提交面板对齐 JetBrains：分支行回滚/刷新 + 所有左侧面板收起按钮）

- **Git 提交面板分支名行**：在「分支：xxx」那一行最右侧加「回滚全部更改」与「刷新」两个内联 SVG 图标（沿用 `undo` / `refresh` 图形，禁止文字或 emoji 充当图标）。回滚会汇总当前全部未提交文件（tracked 丢弃修改、untracked 删除文件）并二次确认后走既有 `gitRollbackPaths`；刷新与标题栏刷新共用 `refreshGitStatus` 通路。
- **所有左侧面板收起按钮**：文件树 / 结构 / Git 变更列表 / AI 会话四个面板的标题栏最右各加一个 SVG「−」收起按钮（统一 `sb-collapse` class），点击收起侧边栏（`toggleSidebar(false)`），与标题栏左侧的活动栏图标形成对称。
- 改动文件：`frontend/index.html`（HTML 结构 + 内联 SVG）、`frontend/src/main.js`（新元素引用 + 收起按钮统一接线）、`frontend/src/terminal/terminal-ui.js`（git 回滚/刷新接线）、`frontend/src/style.css`（`.git-meta-tools` 靠右、`.git-hint` 伸缩）。`npm test` 与 `npm run build` 均通过。

### 重构（生命周期钩子的动作名与全仓命名统一为 lifecycle-hook）

- **动机**：`app_control` 的动作名长期是 `get_pre_commands` / `add_pre_command` / `update_pre_command` / `remove_pre_command`，而它挂的是 **9 个生命周期事件**（`workspace-open` / `workspace-close` / `session-start` / `user-prompt-submit` / `pre-tool-use` / `post-tool-use` / `post-tool-use-failure` / `permission-request` / `stop`）。pre-command 只表达「前置命令」，`post-tool-use` / `stop` 这类事后钩子被名字说反，模型也容易把它当成「打开前跑一次」。
- **动作名**：改为 `get_lifecycle_hooks` / `add_lifecycle_hook` / `update_lifecycle_hook` / `remove_lifecycle_hook`。技能动作表只下发新名；旧名在 `test/ai/ai-app-actions.test.mjs` 的 `UNDOCUMENTED` 登记原因，并保留为**静默别名**——历史会话与记忆里的旧调用仍命中同一分支，写动作审批语义不变，计划模式的 per-action 拦截也同时列旧名（别名不能成为绕行通道）。
- **存储与接线**：设置字段 `preCommands` → `lifecycleHooks`、`preCommandsEnabled` → `lifecycleHooksEnabled`（启动时从旧键迁移一次并删除旧键，已写新键的配置不被覆盖）；设置页 pane id `precmd` → `lifecycle`，DOM id 与 CSS 类 `precmd-*` → `lifecycle-*`，设置树行 id → `lifecycle-enabled`；留痕事件 `precmd.run` / `precmd.config` → `lifecycle.run` / `lifecycle.config`；模块 `core/precommands.js` / `shell/precommands.js` / `settings/settings-pane-precommands.js` → `core/lifecycle-hooks.js` / `shell/lifecycle-hooks.js` / `settings/settings-pane-lifecycle.js`；导出 `PRECMD_*` → `LIFECYCLE_HOOK_*`、`normalizePreCommand` / `buildPreCommandApprovalSpec` / `summarizePreCommandRuns` → `normalizeLifecycleHook` / `buildLifecycleHookApprovalSpec` / `summarizeLifecycleHookRuns`、`createPrecommands` → `createLifecycleHooks`、`createSettingsPanePrecommands` / `renderPreCommandsPane` → `createSettingsPaneLifecycle` / `renderLifecyclePane`；注入钩子 `precmdAIStart` / `precmdEvent` → `lifecycleAIStart` / `lifecycleEvent`；命令 runId 前缀 `precmd-` → `lifecycle-`；新条目 id 前缀 `lh-`（存量 `pc-` 原样保留，不重生成）。
- **刻意不改**：wipeguard 的 `preCommand` / `postCommand`（`run_command` 前后的结构指纹基线，与生命周期钩子无关）；存量条目 id 的 `pc-` 前缀（改名不换 id，AI 与会话手里的引用不失效）。
- 方案存档 `docs/finished-plans/workspace-lifecycle-hooks.md` 同步更名为 `workspace-lifecycle-hooks.md`（正文保留更名前的原始记录，顶部加改名对照）。
- 测试：`test/core/precommands.test.mjs` → `test/core/lifecycle-hooks.test.mjs`、`test/shell/precommands.test.mjs` → `test/shell/lifecycle-hooks.test.mjs`（各补 1 例：旧动作名别名走同一分支、旧 `pc-` id 不重生成），`test/ai/ai-app-actions.test.mjs` 补「技能表只发新名，旧名仅兼容」1 例；重命名后 49 例、加全量 `npm test` 与 `npm run build` 均通过。

### 修复（上下文压缩后，占用环停在压缩前的百分比不动）

- **现象**：auto-compact 触发并完成压缩（提示「已压缩上下文」）后，底部占用环与 /context 弹层仍显示压缩前的百分比（如 82%），看起来「压缩了个寂寞」，直到下一轮响应落地才突然回落。
- **原因**：占用估算 = 实测 usage 锚点 + 增量（`buildApiMessages` 取最后一条带 `usage` 的 assistant）。锚点的 `usage` 计量的是**当时那次请求**的输入——即压缩前整段上下文；压缩裁掉旧消息后，保留尾部里恰好就有这条带旧 `usage` 的 assistant，锚点仍选中它 → 估算停在压缩前。设计预期「压缩后百分比回落自然隐藏」（提醒条）被陈旧锚点打掉；超窗压缩时发送门禁与 auto-compact 计数也会被陈旧值误判。
- **修法**：共用内核 `applyCompactToSession`（主会话与子代理同走）给保留段消息的 `usage` 打 `preCompact` 标记——usage 本身保留（统计行总量 / tok/s / 缓存命中与「最近一次 API 实际用量」依赖它），锚点经 `isAnchorUsage` 跳过带标的：压缩后估算立刻退回纯字符口径（环随即回落到真实占用），下一轮响应带回新 usage 后自动恢复「实测 + 增量」。标记随消息落盘，重载后依旧成立。
- 测试：`test/ai/ai-compact.test.mjs` 补打标 / 锚点可信判定 / 幂等 3 例，15 例全绿。

### 改进（AI 会话右键菜单移除「在新窗口打开」）

- **背景**：跨工作区点会话复用已开窗口落地时，会话右键菜单保留了「在新窗口打开」作为绕过复用探测的强制新开出口（对齐 JetBrains 的 "Open in New Window"）。
- **改法**：作者裁定移除该出口——复用成为唯一行为（点跨工作区会话：目标工作区已开在别的存活窗口就投递复用，否则软切换新开）。菜单项、动作闭包与 `buildSessionMenuItems` 的 `env.currentWorkspace` 兜底参数一并清掉；工作区分组头「⋯」菜单的「在新窗口打开此工作区」不受影响。
- 测试：`test/ai/ai-session-list.test.mjs` 原「强制新开出口」用例改为移除护栏（有工作区 / 兜底当前工作区都不再出现该项），19 例全绿。

### 修复（设置页关掉确认框后，标题栏 / 工具栏被遮罩蒙住，按 Esc 才消失）

- **现象**：在 设置 → 生命周期 里点「删除」（或任何走 `confirmAction` 的删除 / 清空 / 还原）并在确认框点确定后，设置页看起来「被关掉了」，上下标题栏与工具栏变成一层灰色遮罩；按 Esc 才恢复。同样的症状在「生命周期条目新建 / 编辑弹窗保存后」也会出现。
- **原因**：设置对话框家族的共享遮罩 `#dialog-mask` 的 z-index 不是 CSS 写死的，而是由 `overlay-stack` 在 `open` 时写内联、`dispose` 时还原。打开确认框时 `openDialogEl` 调 `disposeFamilyHandlesExcept(dlg)` 把所有兄弟**无条件**出栈——包括仍然可见、本该留在底下的设置窗。设置窗出栈后内联 z-index 被撤掉，回落到 CSS 兜底值，而遮罩随后被确认框重新钉在 `dialog` 档地板上，于是遮罩盖住了标题栏与工具栏；设置窗自身也不再在栈里，Esc 只能走 `main.js` 的栈真空兜底 `closeDialogs`——这就是「按 Esc 就好了」的由来。
- **修法**（`frontend/src/settings/settings-dialogs.js`）：`disposeFamilyHandlesExcept` 改为**只出栈已隐藏的成员**，`keepSettings` 下继续显示的设置窗及其分配到的 z-index 留在栈里；确认框 `dispose` 时遮罩因还有其他条目引用而不会被撤销（`overlay-stack` 的 `underShared` 判定因此生效）。同时补两处：`openDialogEl` 入栈前先撤掉同一对话框的旧句柄（反复开设置不再叠层），`closeDialogs` 补 `runDirty` / `runConfirm` 的隐藏（与家族清单对齐，顺应「只出栈已隐藏」的新规则）。
- 验证：`node --test test/core/overlay-stack.test.mjs test/ai/ai-dialog-esc.test.mjs test/core/overlay-esc-guard.test.mjs` 24 例全绿；`test/settings` 9 个文件 73 例全绿；`npm run build` 通过。

### 新功能（AI 输入区双击 Esc 停止生成）

- **现象**：会话生成中想停止，只能伸手去点停止按钮（或 Ctrl+Shift+Enter 抢占重发）——手在键盘上打字时没有一个纯键盘的「停」手势。
- **改法**：AI 输入框聚焦时**双击 Esc** 即停当前会话，走停止按钮同一条路径（`stopGeneration(undefined, true)`）；会话闲时是安全 no-op，压缩中则取消一次性压缩。判定复用全局搜索「双击 Shift」的同一状态机（`core/shift-double-tap.js` 键位参数化 `key: 'Escape'`），四条防线照搬：完整轻按（keydown 登记、keyup 才结算）、400ms 短窗口、中间无其它键、输入法组字隔离——打中文时按 Esc 取消候选词不会误停。单次 Esc 行为不变：斜杠菜单 / 面板内小浮层 / 全局弹层栈照旧按层序退。
- 监听只挂输入框（`ai-composer.js` 经 ctx 注入停止能力），浮动窗 / 多面板实例各自独立判定；设置页快捷键表「AI 助手」组与 README 快捷键表新增「停止生成（输入区聚焦时）· 双击 Esc」。护栏：`test/core/shift-double-tap.test.mjs` 补 Escape 参数化 3 例 + 新接线护栏 `test/ai/ai-composer-esc.test.mjs`（已登记 npm test）。

### 改进（额度外显显示规范 v1：账号卡显示全部窗口用量，文案收紧）

- **先立规范再改码**：显示口径定稿进 `docs/finished-plans/ai-quota-display.md` §11，实现单一来源 `ai-usage-quota.js`（`usageCompactLine` / `formatUsageCompactText` / `usageTightSummary`），旧的 `usageHeadlineSummary` / `formatUsageHeadline` 删除。
- **账号卡（设置 → AI → 模型）**：从单值摘要改为全量紧凑行——已用型列出全部窗口的百分比 + ⏱重置倒计时（`已用：5h: 70% ⏱3h15m · 7d: 37% ⏱3d4h`）；SenseNova 这类积分/Token 额度换算成剩余百分比（`剩余：通用池5h: 98.2% ⏱3h17m`）；币种型只显示总额并去掉 CNY/USD 文案，直接 `¥48.47` / `$18.00`（赠送/充值留详情层）。百分比按剩余比例上色（≤0 红 / <20% 橙 / 其余绿），文案/图标灰；放不下省略号 + 悬浮看全文。
- **模型选择器分组头**：改为「最紧约束」单值——已用型取已用最高窗口（`5h 70%`）、剩余型取剩余最低段（`通用池5h 1.8%`）、币种型取总额；悬浮 tooltip 显示全量行。
- **基础记号**：窗口短名（5 小时→5h / 每周→7d / 每月→30d）、货币符号映射、百分比最多 1 位小数（0.00%→0%）；详情弹层与用量配置「测试」保持原样（原始单位全字段）。
- 测试：`ai-usage-quota.test.mjs` 重写展示断言——三形态、上色阈值、倒计时文本、分组头口径与记号函数，18 例全绿。

### 新功能（跨工作区点会话复用已开窗口：不再多开第三个窗口）

- **现象**：窗口 A（工作区 X）的 AI 会话列表里点工作区 Y 的会话时，应用总是再开一个新窗口；若工作区 Y 已开在另一个窗口里，就变成第三个窗口。
- **改法**：新增窗口注册表与跨窗口信箱（`internal/windowreg` + `window_app.go` 五绑定）——每个主窗口进程在 `<应用数据>/windows/` 注册（`resourcelease` 租约判活，进程崩溃内核自动放锁），点跨工作区会话时先探测目标工作区是否已开在别的存活窗口：有则经文件信箱投递（目标窗口 rename 原子接管、切会话、前置到前台），没有才走原有软切换新开窗口。
- **协议保证「最多一边开窗」**：投递超时后投递方尝试撤回请求，撤回与接管对同一接管标记做 O_EXCL 独占创建、内核保证恰一方得手（审查竞态用例实测 remove/rename 方案在 Win10+ POSIX 删除语义下会双双成功，故弃用）——未被接管则安全撤回换候选，已被接管则信任对方处理不再新开；目标窗口对超过 3s 的迟到请求回执 `expired` 丢弃，杜绝「新开窗口 + 复用窗口」双开同一会话。投递失败全链路退化为原有新开行为，不卡用户。
- **交互**：复用成功时源窗口状态栏提示「已在另一个窗口打开该会话」；会话右键菜单新增「在新窗口打开」（有工作区归属的会话可见）——想同工作区双开时从这里绕过复用（对齐 JetBrains 的 "Open in New Window"）。复用决策分支抽成纯函数 `decideSessionOpen`（`ai-session-scope.js`），`switchSession` 的工作区对齐点 async 化并加切换序号令牌防连点交错。
- 无新依赖、无体积影响；非 Windows 平台（watcher 不可用）自动降级为原行为。方案见 `docs/unfinished-plans/multi-window-session-reuse.md`。

### 修复（可视化围栏的 loading 被流式更新打断，永远停在前几帧）

- **现象**：AI 正在生成可视化（mermaid / echarts / svg / html / 关系图 / 词云）时，占位卡的「正在生成可视化…」呼吸 / 扫光动画会被思考链、工具卡等上方 DOM 的每帧更新打断——动画一直停在前几帧，看起来像卡死。
- **原因**：流式期间正文是整段重建（`md.innerHTML = renderMarkdown(content)`，签名判定 content 变了就全量重写），`.ai-widget` 占位节点随之整只销毁重建，CSS 动画时钟每次归零。
- **修法**：占位节点保活——重建前按 `data-widget-key`（占位自带 `widgetCacheKey`）把未挂载占位摘出文档（`parkPendingWidgets`），`innerHTML` 覆盖销毁不到它们，写完 FIFO 移植回同 key 的新槽位（`restoreParkedWidgets`），再统一增强（流式加 pending、轮结束 `mountCard` 挂卡都作用于同一节点，无跳变）；已挂载的卡（带事件与异步任务）不参与保活。同 key 多块按序复用，内容变了旧占位自然淘汰。
- 新导出 `parkPendingWidgets` / `restoreParkedWidgets`（`core/widget.js`），配 `widget.test.mjs` 最小 DOM stub 用例 4 组（摘出分组 / FIFO 移植 / 非法输入 / 接线顺序静态断言，19 例全过）。

### 新功能（终端链接右键菜单：复制链接 / 内置浏览器打开 / 默认程序打开）

- **现象**：终端里的 http/https 链接此前只有 hover 下划线 + Ctrl+单击用系统默认程序打开两种交互，想复制链接地址或用内置浏览器打开没有任何入口，只能手动选中 URL 文本再复制。
- **改法**：右键指针下的链接时，终端区域菜单前置三个链接动作——复制链接（写入剪贴板）、内置浏览器打开（`openBrowserTab` 新开浏览器标签页）、默认程序打开（与 Ctrl+单击同一条 `BrowserOpenURL` 通道）；下面照常保留复制选中 / 粘贴 / 清屏。指针定位（`termLinkAtPointer`）把鼠标位置按 `.xterm-screen` 实测 cell 尺寸换算成缓冲行列，再对该行重跑与 `provideLinks` 相同的链接检测——软换行拆开的长链接、右键在回滚历史里的链接同样命中。
- 命中判定抽成纯函数 `linkHitAt`（`term-links.js`：跨行链接中段整行算命中、首末行按端点收窄），`test/terminal/term-links.test.mjs` 补 4 组断言（13 例全过）。

### 新功能（全局弹层栈：Esc 一次只退一层，z-index 统一分档）

- **现象**：弹层（对话框/模态/菜单/灯箱/popover）没有栈管理——39 处 Esc 分支散布在约 41 个文件各自为政，跨层协调全靠特判硬编码：main.js 手写「查找条 → AI 弹窗让路 → 设置窗」优先级链、图片灯箱用 DOM 反查让过右键菜单、环境变量编辑器靠 `stopImmediatePropagation` 抢跑。一次 Esc 经常连带关掉多层（比如开着 AI 顶层弹窗按 Esc 曾把底下的设置窗一起关掉）。
- **改法**：新增 `core/overlay-stack.js` 全局弹层栈（模块级单例）。所有页面级浮层打开时注册（`open({id, kind, el, onClose})`）、关闭路径收口 `dispose()`；唯一的全局 Esc 监听装在 main.js 最顶（window 捕获，先于一切弹层工厂），从栈顶向下分发——一次 Esc 只退栈顶层，下层不动；栈空或让路（Shift+Esc 归 dock 关闭、焦点在 `data-esc-local` 标记的输入框内如设置搜索框「清词不关窗」）时事件照旧流向旧监听。死层（元素已断连/隐藏）分发时顺手剔除，泄漏自愈。
- **z-index 同步收口**：style.css 里 72 处手工 z-index 中栈管的 15 处全部删除，由栈按档位分配（bar 100 < lightbox 1100 < dialog 2100 < modal 3100 < popover 4100 < menu 5100，同档按栈序后开在上）；设置下拉（实证须压过对话框）归 popover 档、右键菜单归 menu 档；tooltip 9999 与 toast（200→6000）保持常驻顶层，不进栈。
- **接入范围**：设置对话框族（含共享遮罩）、AI 弹窗与模型/环境变量编辑器、右键菜单（子菜单在菜单基准上逐层 +1）、图片灯箱、命令面板、快速切换（子级先回主级再关）、消息中心、标题栏三弹层、状态栏浮层、查找条、全局搜索、JSONPath/对比/Schema 三遮罩、git-graph 模态、设置下拉、模型选择器与模型列表浮层、本轮用量浮层。面板/视图内部小浮层（AI 面板 ctx/changes/chips pop、群聊菜单、CSV 统计面板、阅读模式 Esc 链）不进栈、自管 Esc——栈消费时被抢占、栈空时照常工作。旧特判（isAIDialogOpen 让路查询、灯箱 DOM 反查、envvars 抢跑监听、标题栏逐个点名 Esc）全部退役。
- 纯逻辑测试 `test/core/overlay-stack.test.mjs`（16 例：栈序/幂等出栈/档位数学/各让路守卫/死层自愈），`test/ai/ai-dialog-esc.test.mjs` 重写钉住新契约（栈先分发、install 先于工厂、旧 hack 不复存在），另加护栏 `test/core/overlay-esc-guard.test.mjs` 扫描全局 Esc 监听——后续弹层自挂 window/document 级 Esc 直接测试红，强制接入栈或显式登记豁免，均登记 npm test 清单。方案见 `docs/finished-plans/overlay-stack.md`。

### 修复（文本视图滚动条光标不再显示 I 形）

- 文本视图用原生 `<textarea>`，自带 `cursor: text`，滚动条区域继承后悬停显示 I 形光标。给全局滚动条伪元素（`::-webkit-scrollbar` 与滑块 `::-webkit-scrollbar-thumb`）显式声明 `cursor: default`，滚动条上恢复箭头光标，不影响正文输入光标。

### 修复（Git 图谱：再次查看同一提交不再报未处理的 Promise 拒绝）

- **现象**：提交详情的文件变动走 LRU 缓存，第二次点击同一提交进缓存命中路径时，`loadCommitDetail` 在 `fillFiles` / `fillBody` 两个 const 声明之前就同步调用它们——TDZ 抛出「Cannot access 'fillFiles' before initialization」（2026-11-18 引入，`f066828`），async 函数直接返回被拒的 promise，调用点没接 catch，控制台报未处理的 Promise 拒绝且「本次变动」停在「加载中…」。缓存路径还误把详情容器 `filesWrap` 当文件数组传给了单参的 `fillFiles`。
- **改法**：两个填充函数声明提前到缓存检查之前，缓存命中调用改为 `fillFiles(cacheHit.files)`；`test/git-graph/git-graph-lane.test.mjs` 加源码序回归护栏（声明先于缓存命中调用、缓存路径单参）。

### 新功能（菜单子菜单的预测锥）

- **现象**：所有菜单的子菜单都没有斜向容差——鼠标斜向移向子菜单必然扫过兄弟行，兄弟行的 mouseenter 会立即收起子菜单，只能走「先垂直下移再水平过去」的直角路线。
- **改法**：引入 Amazon 式预测锥（hover-intent cone）。锥 = 「子菜单近边两端角 + 父项行对侧底角」的三角走廊 ∪ 父项行 ∪ 子菜单面板；指针在锥内触发收起时改为延迟 250ms（期间继续移动会不断顺延，到点复核指针已进子菜单或回到锚点行则放行），锥外（明确去点别的项）照旧立即收起。两处菜单面都接上：`shell/contextmenu.js` 的嵌套子菜单（全部右键菜单 / AI 面板 / 资源管理器 / 结构面板 / 终端 / 便签 / 快速切换等共用）与 `main.js` 菜单条下拉的独立子菜单实例（新建 / 最近打开 / 复制路径 / 导出 / 转换为… 等）；子菜单右开被视口翻转成左开时锥镜像成立。
- 纯函数 `pointInRect` / `inSubmenuCone` 与常量 `SUBMENU_CONE_CLOSE_DELAY_MS` 从 `contextmenu.js` 导出，配 `submenu-cone.test.mjs`（走廊 / 直奔兄弟项 / 左开镜像 / 退化矩形 6 组断言），登记进 npm test 清单。

### 新功能（AI 头部「信箱」胶囊：已排入信箱、等轮边界注入的回执一眼可见）

- **背景**：机制性回执挂在会话信箱里等轮边界注入，用户完全看不见——子代理完成 / 失败 / 提问、后台命令与终端退出、计时器**到点**后的唤醒通知（会话忙时投递即挂箱）。子代理 18 批并行时哪个会话挂着什么，只能靠猜。
- **胶囊**：AI 头部新增「信箱」胶囊（`#ai-chip-queue`，类计时器胶囊），显隐与角标 = 信箱挂起通知合计，无则隐藏。点击弹 chips-pop（kind=mailbox）：按会话分组的条目，通知显示 content 首行摘要（子代理**提问**用橙色徽标突出，需要拍板的最紧急）；行点击跳到对应会话。弹层开着时后台冲刷消费条目会原位刷新。**口径边界**：用户手动排队的消息不进这里（composer 队列条是它的地盘）；**没到点的运行中计时器也不进**——它还没产生消息，「计时」胶囊已有完整入口，到点产生的唤醒通知才排入信箱、自然出现在这里（2026-11-20 作者裁定：信箱只装「已排入」的）。
- **接线**：`ai-agent-notices.js` 新增 `listPending()` 全局枚举（按会话分组返回 kind / label / content）与 `onChanged` 钩子（入队 / 轮边界消费 / 清空各变更点回调）。
- **修复（2026-11-20 实测）**：首版胶囊永远不显示——`setChipCount` 只更新角标数字，胶囊自身的 `hidden` 类没人摘（index.html 初始 `class="ai-chip hidden"`）；`updateMailboxChip` 现按 count 摘/挂胶囊显隐，`ai-agent-notices.test.mjs` 加接线静态断言防回归。
- 测试：`ai-agent-notices.test.mjs` 补 `listPending` / `onChanged` 整链路覆盖（忙会话回执挂信箱可枚举、消费清零、闲会话不误报，30 例全过）。

### 修复（排队消息重启不再丢）

- **现象**：消息队列是纯内存（重启即丢全部排队条目），且队列条只渲染当前会话的条目——后台会话排了什么、塞下了几条，用户在面板上完全看不到。
- **持久化**：新增 localStorage 轻量快照（键 `datalens-ai-msg-queue`，预算 800 KB，超限整体放弃不撑爆配额）。每次队列渲染后全量覆盖（队列变更必然触发渲染），启动读盘完成后恢复一次（按 id 去重、剔除已删/归档会话的条目）。图片/视频附件的 base64 data 不进快照（动辄数百 KB，只保留文本类附件）——恢复后消息文本仍在，媒体需重贴。局限：多窗口双开时各自恢复同一批条目（队列本就 per-window 互不同步），只有窗口主动消费才会发送，风险面与恢复前一致。
- 纯函数 `persistSafeItem` / `restorableQueueItems` 与 `createQueueModel.restore` 配 `ai-message-queue.test.mjs` 新增 3 组断言（28 例全过）。

### 改进（应急收缩触发时留痕：占用「突然下降」不再无解释）

- **背景**：窗口占用 ≥90% 时组装请求会把最近 5 个工具结果之外的历史工具结果修剪/指针化（`ai-context-slim` 的应急收缩档），只改发出内容、磁盘历史原样——实测占用会在一轮之间掉一大截（如 85%→64%），面板上没有任何痕迹，用户无从知晓发生了什么。
- **改法**：发送前检测到本次组装触发应急收缩、且该会话 30 分钟内没记过留痕时，在本轮回复之前落一条会话注记（`kind=slim-note`，与模型切换留痕同款分隔行样式）：「上下文应急瘦身已介入……」，触发占用与机制说明收进 ⓘ tooltip；注记不进模型上下文（组装跳过）、随 JSONL 落盘重放还原。
- 判定抽纯函数 `shouldInsertShrinkNote`（冷却去重，防占用在线附近震荡反复刷屏），测试 `ai-context-slim.test.mjs` 新增 3 组断言。

### 修复（后台队列消息塞不下时自动腾地方，不再干等用户）

- **现象**：后台会话的排队消息被起轮内核的请求预检拦下（`over_budget`，占用将超窗口 90%）时，只退回队列 + 提示「切回压缩后再发送」，**不会触发压缩**——而手动发送被同一预检拦下时会兜底触发自动压缩（`autoCompactOnGateBlocked`），两条路径不对称。消息留在队列反复重试失败，直到用户亲自切回来处理。
- **修法**：`flushInBackground` 的 `over_budget` 分支新增兜底钩子 `onQueueOverBudget`（panel 注入 `maybeAutoCompact(session)`）：消息先退回队列，再触发一次自动压缩腾地方；压缩完成后既有的 `flushMessageQueue` 冲刷会自动重发队列，闭环不丢消息。

### 新功能（使用统计：请求日志）

- 设置 → AI → 使用统计底部新增**请求日志**：按时间倒序分页展示每次模型请求，列含时间、供应商（账号名）、模型、新增输入、输出、缓存命中、缓存写入、命中率、速度、首字、总耗时、状态码；每页 10 / 20 / 50 条可切换，底部显示总记录数与页码。
- 口径与提示：新增输入 = prompt − 缓存命中 − 缓存写入；命中率 = 缓存命中 ÷（新增输入 + 缓存写入 + 缓存命中）；速度 = 输出 token ÷（请求总耗时 − 首字延迟），只统计输出 ≥100 token 且生成窗口 ≥200ms 的请求；首字 = 请求发出到第一个 token。命中率 / 速度 / 首字表头带 ⓘ 说明，累计 Token 指标卡补「真实消耗」口径说明。
- 数据采集：`usage_events` 新增 `model_ms` / `ttft_ms` / `status_code`；传输层 `ai-done` 回传最终 HTTP 状态码；主会话、子代理、群聊三处上报补请求耗时、首字延迟与状态码；主会话/群聊 JSONL 扫描同步解析这些字段。群聊的「供应商」改用账号名，旧消息缺账号时回退成员名。
- 兼容：老库启动时自动补三列并清空一次扫描游标，下次打开面板按历史会话 JSONL 回填耗时/首字（状态码是本次新增字段，历史消息没有记录，显示「—」）。
- 新增绑定 `AIUsageStatsRequests(offset, limit)`；`dev/mock-backend.js` 提供 137 条确定性演示数据。
- 测试：Go 覆盖上报归一、主会话/群聊解析、请求日志分页与参数收敛；前端 `usage-stats-model` 新增新增输入/命中率/速度/首字/时间/状态码格式化用例。

### 修复（zcode2api 插件模型清单过时；附 Start Plan 反代不可用的定案）

- ZCode / Z.ai 现役 Start 免费额度是 `GLM-5.3-Flash`（官方 API code `glm-5.3-flash`，1M 上下文 / 128K 输出），插件却仍注册旧的 `GLM-5.2` / `GLM-5-Turbo`，导致模型选不对、请求失败。
- `plugins/zcode2api/main.js` 注册模型改为 `GLM-5.3-Flash` + `GLM-5.3`；`server/app/routes/gateway.py` 的 `AVAILABLE_MODELS` / `MODEL_NAME_MAP` 同步更新，旧名保留兼容历史配置；`server/app/agent.py` / `settings.py` 的请求头对齐官方 3.18.2（补 `X-Title`、`X-Release-Channel`、平台头等）；同步架构文档并把插件版本升到 1.2.0。
- **定案：Start Plan 免费额度无法通过反代/API 代理使用**。上游把 zcode-plan 端点的鉴权改为要求渲染进程**逐请求现签**的阿里云验证头（`X-Aliyun-Captcha-Verify-Param`），没有可抽取的 API Key：JWT 直连返回 `405 / 3012 This client is not supported`，官方 API 通道（`api.z.ai/api/anthropic`）只回 `1113 余额不足或无可用资源包`；project access token 换证链实测（zcode-plan 401、ultra-zai 429）同样不可用。GitHub `ZhaoAndy821/dsh-zcode-connector` 独立得出同一结论，其方案是用 CDP 驱动官方客户端而非抽凭证。因此换证链改动已回滚，仅保留模型名与请求头修正。详见 `.cadt/memory/zcode-start-plan-no-api.md`。

### 修复（存储自动清理：原生下拉 + 完成无主动通知）

- **现象**：设置 → 存储与清理 → 自动清理区的「时间间隔」「大小阈值」，展开后是白底黑字的系统原生下拉列表，与项目其它行式下拉外观不一致。
- **原因**：这两个 select 由 `paintAuto()` 在 async 的 `renderStoragePane()` 里动态创建，而 `selectSettingsPane()` 末尾的 `enhanceSetSelects()` 是同步调用——扫描时它们还没生成；存储面板 deps 里也没有注入增强器，无法自补。
- **修法**：给 `createSettingsPaneStorage` 注入 `enhanceSetSelects`（main.js 接线），在 `paintAuto()` 末尾补一次增强（幂等，并覆盖开关切换 / 设置更新导致的重建）。
- **补完成通知**：自动清理原本只 `messageCenter.add(...)` 不传 `opts.toast`，只进消息中心、状态栏角标 +1，后台清理用户不点开就完全不知道；与其它后台事件（工作区防护 / 更新检查）一致改传 `{toast: true}`，完成时弹右下角提示。

### 修复（使用统计 / 额度外显的代码审查问题）

- **扫描游标加「前 64 字节指纹」**：会话日志被 reset/整份重写后又增长到超过旧 offset 时，不再从新文件中间续读导致前段永久漏计；指纹不匹配一律从头重读。
- **使用统计移出一键清缓存**：子代理用量没有 JSONL 兜底、只存在 `ai-usage.db`，原先把库标成缓存会在例清时不可逆丢失；改为数据条目单独删除并更新文案。主会话/群聊仍可在下次打开面板时按游标回填。
- **上报时机补齐**：主会话每轮 `ai-done`（含工具轮）都实时上报，空回复自动重试替换消息前也先记下当轮消耗；群聊工具轮累计输入/输出/缓存字段、自动重试不再清零已产生用量、失败/停止路径保留累计值；子代理补 `turnMs`。
- **额度外显口径**：同一池的 5h/7d 重叠窗口按池取较大剩余再跨池求和（不重复放大同一份额度）；返赠余额只计一次；OpenRouter 优先「剩余」而不是「已购额度」；`%` 条目的 token 数不再拼成百分号；无缓存时恢复「待查询」。
- **使用统计面板**：环形图/趋势图 tooltip 对模型名与数值全量转义（模型名来自配置，默认 HTML formatter 是注入点）；热力图月份标签跳过后下一周补，不再整月丢失；每周/累计模式 tooltip 显示整列口径；图表实例复用前先 resize；同步失败在副标题提示。
- `999950+` 的 token 数进位为 `1M`（不再显示 1000K）；热力图窗口收紧为恰好 371 天；未来时间戳归到当前时刻，汇总与热力图口径一致。

### 改进（上下文提醒条的「压缩上下文」按钮不再发灰）

- 默认（琥珀 suggest）态的按钮原本是 `transparent` 背景 + `--muted` 文字 + 普通边框，在琥珀提醒条里几乎看不出是可点的；改为与 `is-over` 红态对称的琥珀强调——描边 / 淡底 / 文字统一用 `--warn`，hover 加深。红态与 ≥100% 的 `aria-disabled` 压暗样式优先级更高，不受影响。

### 变更（便签移除三态统计）

- 状态点换成自定义标签后，三态 status 已无任何 UI 入口，顶栏的「完成/总数 · 进行中 N」是永远不变的死数字。**彻底删除 status 字段**：条目数据不再存 status，导出不再有勾选框，顶栏统计与 AI 反馈里的完成/进行中计数一并移除。
- **AI 工具改用标签分类**：`get_memo` 的 `status` 过滤改为 `tag`（按自定义标签精确匹配），`add_memo` 新增可选 `tags` 参数（新条目直接挂标签），`update_memo` 去掉 `status` 参数（标签仍用 `tags` 整体替换）。技能表 / APP_ACTIONS / 执行分支三处对齐。

### 改进（额度外显只显示余额总额，明细点开看）

- 账号卡与模型选择器分组头不再平铺所有条目：官方引擎只显示「总额余额」（DeepSeek 的赠送/充值余额不再挤在同一行）；脚本模板把同单位 remaining 求和（SenseNova 的返赠余额一并计入、只加一次）。多套餐的已用百分比、重置时间与返赠文案改由点击账号卡弹出的详情层展示。
- 新增纯函数 `usageHeadlineSummary` 统一汇总口径；SenseNova extractor 增加 `grantBalance` 数值字段（`extra` 的「返赠 N」文案保留给详情层）。
- 测试：`ai-usage-quota.test.mjs` 覆盖官方总额优先、多套餐求和 + 返赠、百分比兜底、错误态。

### 改进（模型供应商图标补齐到 39 家）

- 新增 21 家品牌图标（取自 cc-switch MIT 仓库的 `src/icons/extracted/`）：OpenCode、豆包/火山方舟、腾讯混元、腾讯云、文心/百度、零一万物、美团 LongCat、小米 MiMo、NVIDIA、Cohere、Perplexity、HuggingFace、ModelScope、阿里百炼、AWS Bedrock、Azure OpenAI、Google Cloud、Meta/Llama、Gemma、Sub2API。
- host 匹配补 `opencode.ai` / `ark.cn-beijing.volces.com` / `qianfan.baidubce.com` / `bedrock-runtime.*.amazonaws.com` / `*.openai.azure.com` 等；名称关键词补中文名（豆包、混元、文心、百炼、魔搭等），账号起中文别名也能命中。
- OpenCode 用官方方块标记改 `currentColor`（原 SVG 是浅色底专用，深色主题下不可见）；其余保留品牌色。多图标内联时 `clipPath`/`mask` 的 id 按图标键加前缀，避免同文档撞车。
- 主包 +42 KB（gzip +17 KB）。

### 新功能（设置 → AI → 使用统计：用量先入库，打开面板不再扫会话）

- **数据来源**：新增派生库 `<应用数据>/ai-usage.db`（modernc SQLite，可随时删除重建）。事实有两条写入路径：① 每轮流结束时前端拿到 `usage` 静默上报——主会话、子代理（每轮 `ai-done`）、群聊（成员/主持人发言）三处入口，失败忽略；② 打开面板或点刷新时按「字节偏移 + 文件大小/mtime」游标增量扫描会话 JSONL（`ai-sessions` 与 `ai-groups`）——首次打开即历史回填，不启动后台回填、不做定时轮询。其余时间只做库内聚合，不遍历会话文件。子代理消息没有可扫描的 JSONL，依赖实时上报。
- **口径**：日界按本机时区；活跃日 = 当天 token > 0；当前连续天数从今天往前数（今天没有用量为 0），最长连续取最大连续段；「最长聊天时长」取消息 `turnMs`（老数据无此字段时回退会话首末跨度）；事实永久保留，删会话/截断历史不回收已计入的消耗。
- **面板**：5 张指标卡（累计 / 峰值 Token、最长聊天时长、当前 / 最长连续天数）、Token 活动热力图（53 周，每日 / 每周 / 累计三种模式）、每日 Token 趋势（多模型折线，近 7 日 / 近 30 日）、模型用量环形图 + 排行（前 5 + 其他）；刷新按钮触发一次增量回填。ECharts 仍懒加载。
- **清理**：设置 → 存储与清理新增「AI 使用统计」数据条目，删除前先释放库句柄；主会话/群聊事实在下次打开面板时按游标回填，子代理用量不可恢复（见下方修复条）。
- 方案见 `docs/finished-plans/usage-stats.md`。

### 改进（terminal read 支持按行取尾部：新增 tail 参数）

- **需求**：`terminal` 工具的 `read` 原来只能按字符数（`maxChars`）取输出尾部，想看「最后 N 行」得自己数字符或绕道 `app_control get_terminal`。
- **改法**：`read` 新增可选 `tail`（1–200 行），与 `maxChars` 二选一、`tail` 优先。传 `tail` 时前端把读取量拉到上限 20000 字符，拿到文本后按行切最后 N 行（纯前端，不改 Go 绑定 / wailsjs / exe）。工具描述、参数表、返回文案同步更新，配套 `ai-terminal-tools.test.mjs` 新增 2 条断言。

### 修复（斜杠补全认不出工作区技能：`.agents/skills` 里的技能被判「未知命令」）

- **现象**：工作区 `.agents/skills/xxx`（或 `.cadt/skills/xxx`）里的技能，输入 `/xxx` 时补全列表里没有、回车提示「未知命令：/xxx」；但同一技能模型用 `skill_use` 能正常加载，`/skill xxx` 和技能菜单里也都能看到。
- **原因**：斜杠补全在 `ai-slash.js` 里自持一份技能缓存，命中一次就**永不刷新**；而 `skill_use` / `/skill` / 技能菜单走的是 `listSkills(true)` 强扫。面板若在工作区打开之前预热（启动时 AI 面板本就是开着的）或技能是会话中途才放进目录的，补全侧就永久落后于强扫侧，形成「模型能加载、斜杠说不认识」的口径分裂。
- **修法**：斜杠缓存加 5s TTL（与面板 `listSkills` 同口径），过期后台刷新后重渲染（旧列表先顶上，不闪烁）；`/技能名` 回车时缓存未命中先强扫一次再判未知；面板 `invalidateSkillsCache()`（技能管理里新建 / 启停 / 隐藏、配置导入）经新钩子同步清空补全缓存。命中判定抽成纯函数 `findSkillBySlashToken`（补 10 条断言）。

### 改进（静默失败改走应用内 toast：不再只躺在状态栏）

- **现象**：大量失败 / 后台事件只写状态栏 `flash()`（5 秒自动清空），用户没盯着就完全看不见——会话保存失败、子代理失败、定时任务触发失败、便签多窗口冲突等尤其容易被漏掉。
- **改法**：新增统一失败通知出口 `shell/failure-notifier.js`（消息中心 + 右下角 toast + 按 key 节流，默认 30s），只给「需要用户回来处理」的 A/B 级清单用；「已复制 / 已保存 / 输入校验 / 当前版本不支持」这类现场即时反馈仍走 flash，不弹。AI 域的对话级通知（任务失败 / 提问 / 审批）仍走既有 `notifyDesktop()` 会话可见性策略，两套平行不重复。
- **覆盖**：会话保存失败 / 磁盘存储不可用 / 部分会话读取失败 / 归档溢出丢弃 / 对话日志落盘失败、子代理失败与结论投递失败、定时任务触发失败、计时器与生成任务的唤醒/注入失败及跨工作区提醒、排队消息未发送、群聊落盘/纪要/加载/调度失败（高频的只进消息中心不弹）、文件被 AI/补丁修改但未重载、便签多窗口冲突。
- **节流**：同 key 30s 内只弹一次；C 级高频（群聊加载/调度等）传 `toast:false` 只进列表。纯逻辑 `core/notify-throttle.js` + 单测 `notify-throttle.test.mjs` / `failure-notifier.test.mjs`（已登记 npm test）。

### 改进（过程折叠不再被已答提问卡切段）

- **现象**：一轮里答完一次 `ask_user` 后，过程折叠被劈成「body｜提问卡｜body」——展开时过程流被整卡打断，后续过程是无头续段；多张提问卡就是多段碎片。
- **修法**：已答（含超时/跳过/取消）提问卡不再切段，留在过程流里按时间序渲染，随过程一起开合、默认收起（点开「已完成」即可查看问答记录）。方案见 `docs/finished-plans/turn-fold-redesign.md` §9。
- 测试：`ai-turn-fold.test.mjs` 新增 R5（不许再出现 `segments.push({ask:`，默认展开判定不特判提问）。

### 新功能（用户消息原地编辑：正文与附件就地改，不再灌回输入框）

- **交互**：用户消息悬停操作栏的「编辑」由「仅最后一条」放开到**任意一条**；点开后气泡就地变成编辑区（正文 `textarea` 自动高度 + 附件 chips + 「＋ 添加」+「取消 / 发送」），不动底部输入框。`Esc` 取消、`Enter` 发送、`Shift+Enter` 换行（与输入框一致；输入法组词中的回车不算发送）。
- **附件可增删**：图片缩略图、视频 / 文件 / 技能 / 选区 / 引用 chip 都能就地删；「＋ 添加」复用输入区同一条附件链（图片降采样、视频校验、文本读取超限降级为路径引用）；编辑区里 `Ctrl+V` 直接粘贴图片 / 视频（纯文本粘贴走默认，不拦）。
- **保存语义**：截断这条及其之后并重新发送（与既有「编辑重发」一致）；非最后一条保存前二次确认「将丢弃后面 N 条对话」，取消则编辑态原样保留。失败（超阈 / 忙 / 图片超限 / 租约）编辑态与内容都不丢。
- **历史文件附件**：新增 `message.attachments` 快照（只存文本类附件：文件 / 技能 / 选区），从本次改动起的消息重开应用后仍能完整编辑；此前的老消息里这些附件已固化进 `<attachments>` 环境块，编辑区显示说明「无法单独编辑，可继续添加新附件」。图片 / 视频继续走 `message.images` / `videos`，引用继续从 `<quote>` 前缀解析，都不重复落盘。
- **实现**：纯数据层 `frontend/src/ai/ai-inline-edit.js`（快照归一 / 载荷组装）；chip 渲染抽成 `renderAttachmentChips`（输入区与编辑区共用，避免两套视觉漂移）；`ai-composer.js` 导出 `pickAttachmentFiles`；控制器与接线在 `ai-panel.js`；样式 `.ai-edit` 系列复用主题变量。方案见 `docs/finished-plans/inline-message-edit.md`。
- **测试**：`ai-inline-edit.test.mjs`（8 例：白名单 / 截断 / 封顶 / 往返）、`ai-inline-edit-wiring.test.mjs`（8 例：入口放开 / 保存传 `truncateAt` 且不碰输入区 / 二次确认 / 键位 / 退出 / 快照落盘）。

### 改进（自动审批档：`cd x && npm test` 不再反复弹审批卡）

- **现象**：auto 档下模型爱写 `cd frontend && npm test` 切目录，`commandTokens` 遇 `&&` 直接返回 null，家族白名单短路失效、命令落进分类器——语料把 test/build 类故意标成灰色（良性但必须 ask），端侧给 0.95 高分、远程 AI 复核也按「有副作用非只读」判 ask，于是每次都弹卡；单写 `npm test` + `cwd` 参数则命中家族白名单直接放行。
- **修法**：`commandFamilySignature` 容忍「恰好一段前置 `cd`/`chdir` + 一条白名单家族命令」——cd 只换执行目录，与调用方直接传 `cwd` 参数等价，后者本就自动放行，这里让 cd 写法获得同等待遇，不放宽任何「执行什么」的判定。多段串联、`||`、`;`、管道、重定向、命令替换、反引号、换行、未闭合引号、非白名单家族一律拒绝。计划预授权判定同步用同一签名口径，避免卡片写「不预授权」而执行时却没弹卡的错位。
- 工具描述同步补指引：`run_command` / `background_command` 与终端组注记写明「换目录直接传 cwd，命令里不必带 `cd <dir> &&` 前缀」。
- 测试：`test/ai/ai-command-rules.test.mjs` 新增 3 组用例（前置 cd 正向等价 / 安全边界 / family 授权匹配）；全量 `npm test` 1794 通过。

### 改进（会话数据诊断：长会话不再点了没反应）

- 诊断的数据读取 / 重放 / 逐行解析原先全在弹对话框之前跑完，长会话要等几秒，期间界面毫无变化，用户以为没点上。现改为先弹对话框显示「正在分析会话数据…」，算完再填内容；「复制诊断信息」按钮在分析完成前禁用（提前点会提示「还在生成中」），避免复制到空内容。

### 改进（隔离区 AI 出路收尾：discard 保底快照 / 自举提示 / 导出标记 / conflict_detail）

- **discard 保底快照**：丢弃隔离区前自动把未导出改动全量落盘 `.cadt/patches/worktree-snapshot-<name>-<时间戳>.patch` 并在回执/提示给出路径（可用 git apply 或 propose_patch 恢复）——AI discard 与用户手点丢弃两条路径都覆盖；快照**绕开 PatchSave**（它对「没有任何文件可应用」会删补丁文件，保底存档绝不能被删，新增 `WorktreeSnapshotPatch` 引擎）。快照失败不阻塞丢弃但明确提示「未导出改动已丢失」。丢弃确认卡文案同步改为存档语义。
- **create 自举提示**：create 回执与会话时间线都提示隔离区只有 git 跟踪内容——依赖目录与构建产物（node_modules / dist / wailsjs）不在其中，测试前先自举（npm install → vite build → wails generate module，顺序有依赖；缺 dist 时 generate 报 embed 错误是在提示先 vite build），并点破「测试假失败先怀疑缺生成物，不是代码错误」。
- **导出状态标记**：隔离区登记的 `lastExportReport` 展示在 stat 回执、chip 徽标（「隔离区 xxx · 已导出」）与信息卡——改动统计是全量语义（相对基准），已回灌部分看最近一次 export 预检报告，避免「全没回灌」误读。
- **conflict_detail 按需通道**：`worktree_manage(action=conflict_detail, file=…)` 查看主根某文件相对创建基准的 diff（新增 `GitWorktreeDiffSinceBase`，200 行封顶截断附 read_file 提示）——export 预检报冲突时据此在隔离区重做，冲突细节按需逐文件取，文件级清单仍在 export 回执里。
- 测试：`TestWorktreeSnapshotPatchAndDiffSince`（快照落盘/无改动语义/单文件 diff/截断/越界拒绝）；工具词表护栏同步（file 参数登记 PROSE_TOKENS）。

### 修复（后台会话的排队消息现在会自动发出，不再等你切回对话）

- **现象**：会话 A 正在后台生成，你在 A 里按 Enter 排了一条消息（或插话/抢占降级成排队），然后切到 B 继续干活——A 本轮结束后那条消息**不会发出**，直到你切回 A 才慢半拍补上，「本轮结束后自动发送」的承诺失效。
- **根因**：`flushMessageQueue` 开头是 `session.id !== sessionId → return`，把「队列只能由当前输入区代发」写成了唯一通路——`finishStream` / `finishCompact` 里明明调了它，在后台会话里是**死调用**（评估稿 `ai-queue-background-flush.md` 已定位，本次按方案 A 落地）。
- **修法**：冲刷拆成「取项」与「发送」两步——`takeQueuedItem` 只做守卫与摘除（忙 / 归档 / 待回答 / 计划待批准 / **当前会话**的输入区草稿）；当前会话仍走输入区可见地发，后台会话走 `startSessionTurn` 内核起轮（引用前缀与附件分组与手动发送同一口径），不碰输入区、不刷前台视图。
- **失败不丢**：回插该会话队首 + 状态栏人话（上下文超阈 / 已归档 / 另一窗口占用 / 其他）+ 会话未读标记，并做一次 2.5s 自愈重试（`fromRetry` 防无限打转）。
- 方案与实施记录见 `docs/finished-plans/ai-queue-background-flush.md`（原在 `unfinished-plans/`，当日评估当日落地）；测试：`ai-message-queue.test.mjs` 新增 5 例（后台走内核且不碰输入区 / 失败回插 / 忙时不取项 / 当前会话仍走输入区 / 附件分组），`ai-turn-steer-wiring.test.mjs` 同步接线断言。

### 修复（消息中心「AI 待审批」显示红叉图标）

- 审批 / 环境变量待填写是「等用户拍板」，不是错误，但 `markWaitingOnUser` 的通知被标成 `kind: 'error'`，消息中心据此画了叉号圆圈（与「AI 任务失败」同款），连着几条容易被误读成任务失败。现统一改为 `info`（ⓘ，与「AI 计划待批准」一致），含 60 秒催办那条。
- 历史消息一次性迁移：读取 localStorage 时把标题为「AI 待审批 / AI 待填写」（含「（仍在等待）」后缀）的 error 条目改成 info 并写回，真正的错误消息不动。迁移判定抽成纯函数 `migrateApprovalKind`，配 `test/shell/message-center.test.mjs`。

### 修复（轮次耗时被后台通知截短：会话末尾「00:17」这类用时对不上）

- **根因**：信箱注入（子代理结算 / 后台作业与终端退出 / 会话投递）会折叠成 `role=user` 且带 `turnStartedAt` 的消息（`frontend/src/ai/ai-agent-notices.js`），而回合起点判定 `turnStartAt` 只排除 `systemNote` / `steer`，没识别 `notice`——这一轮的耗时就从「通知到达那一刻」起算，末尾操作行的耗时缩成十几秒（实测 `00:17`，真实是几分钟）。
- **同源影响**：会话列表时间（`sessionTurnStartTs`）、回合分组折叠条的「用时」、编辑重发锚点、「N 轮」统计都抄了同一份 `role === 'user' && !systemNote && !steer` 判定，一并被通知污染。
- **修法**：`isTurnBoundaryMessage` 增加 `notice` 排除（与 `ai-context-slim.js` 的轮次切分口径一致）；`ai-panel.js` 的 `turnStartAt` / `lastUserIndex`、上下文统计、`ai-usage-ui.js` 的轮次计数全部改为复用这一判据，不再各处手抄。
- **历史轮次一起修**：耗时徽标与折叠条「用时」在有 `finishedAt` 时按当前口径现算，不再沿用旧口径落盘的 `turnMs`——已存档的会话也不用重写磁盘就能显示正确值。
- 测试：`ai-session-store.test.mjs`（notice 不作边界、起点不被通知推进）、`ai-usage-ui.test.mjs`（notice / steer 不计轮）、`ai-turn-steer-wiring.test.mjs`（接线断言改为单一判据）。

### 新功能（二进制文件也能进对话：路径引用降级）

- 以前在输入区附加 docx / xlsx / zip / pdf 这类文件只会弹「附加文件失败：二进制文件不可作为文本读取」，等于完全传不进去。现在改为**路径引用降级**（对齐 ZCode 的 `resolvedPathReferenceAttachment`）：不读正文（避免把二进制塞进上下文），而是把「文件未读入内容 + 完整路径 + 该怎么读」注入 `<attachments>` —— pdf 指向 `ocr`，docx/xlsx/pptx 指向 `ocr` 与 `docx` 技能，压缩包提示先解压到 `.cadt/tmp/`，图片指向 `read_image`，mp4 指向 `read_video`，其余回落 `read_file`。纯函数 `attachmentPathHint` 在 `frontend/src/ai/ai-file-tools.js`（配测试）。
- **顺带修掉文件对话框的图片通道缺口**：选 png/jpg 曾经也会被当文本读而失败，现在按类型分派——视频走视频通道、图片走图片通道（同一套源准入 + 降采样），其余才走文本/路径引用。
- 超过文本读取上限（>10 MB）的文件同样降级为路径引用，不再整条失败。

### 改进（AI 图片上限放宽到 10 张，按 dsh 架构重做两层限制）

- **张数 6 → 10，总预算 6 MiB → 32 MiB，单张编码 3 MiB → 4 MiB**；归一化长边 1600 → 2048px。大图现在先按「源准入」收下（单张 50 MiB / 单条消息 200 MiB），再经 canvas 等比缩放与降质压到 4 MiB 才进模型——与 deepseek-harness 的「宽松准入 + 归一化兜底 + 请求层硬预算」两层结构一致。
- **限制改为单一真源 + 投影**：新增 `internal/aiimagepolicy`（常量与校验的唯一定义）与 Wails 绑定 `AIImageLimits`，前端 `frontend/src/ai/ai-image-policy.js` 启动时拉一次，composer 与发送前预检读同一份数值；两侧测试都断言同一组阈值，前后端不会漂。限制不暴露设置页（与 codex / opencode / ZCode / dsh 一致）。
- **三层校验**：输入区先做源准入整批拒收（超限时点名上限，不再静默截断）；发送前 `startSessionTurn` 再算一次请求预算，超限直接提示、不发无效往返；Go 传输层用同一份真源强制校验张数、单张与单条消息合计，并核对 MIME 白名单与 base64 合法性。
- **不引入图像原生依赖**：npm 实测 sharp + libvips（win32-x64）约 40.6 MB，会让单 exe 体积翻倍。归一化继续用浏览器原生 canvas（已有链路，零体积），格式面仍是 png/jpeg/webp/gif，与 dsh 一致。方案见 `docs/finished-plans/ai-image-limits.md`。

### 新功能（内嵌浏览器补齐 4 个工具 + 2 处增强）

- 新增 `browser_wait`：等 `selector`（元素出现）/ `text`（可见文本）/ `url`（地址包含），条件之间是「与」；200ms 轮询到超时（默认 5s、上限 60s）。此前没有任何等待原语，导航后只能反复 `browser_snapshot` 猜时间或空等。
- 新增 `browser_scroll`：`selector` 滚到元素 / `byPx` 按像素 / `position=top|bottom` 滚到顶底，返回滚动位置与页面高度（触发懒加载、把下方内容滚进视野再截图）。
- 新增 `browser_hover`：派发 `mouseover`/`mouseenter`/`mousemove` 展开靠 JS 监听触发的悬停菜单。**描述里写明边界**：脚本派发事件不改变 CSS `:hover` 伪类，纯 CSS 悬停样式与只认真实指针的浮层不会出现。
- 新增 `browser_select`：在原生下拉框上按 `value` 或可见文本（`label`，先精确再包含）选中并派发 `input`/`change`；匹配失败时回执附带前 20 个可选值。自定义下拉组件仍走 `browser_click` 展开再点子项。
- `browser_click` 增 `text` 参数：按可见文本点「文本相等或包含目标的最小可见可点击元素」（选择器难写时更稳）；`selector` 与 `text` 二选一，都传或都不传直接报错。
- `browser_press_key` 增 `modifiers`：支持 `ctrl`/`shift`/`alt`/`meta`（含 `cmd`/`win` 等别名）组合快捷键。
- 权限档：`browser_wait` / `browser_scroll` 进只读档（只影响「看什么」，不改页面内容）；`browser_hover` / `browser_select` 与 click/type 同档（写权限档）。
- 实现：脚本构造与入参归一抽到纯函数 `frontend/src/ai/ai-browser-tools.js`（配 `test/ai/ai-browser-tools.test.mjs`），执行仍走既有 `BrowserEval`（WebView2 ExecuteScript），**无新增 Go 绑定**；`dev/mock-backend.js` 的 `BrowserEval` 对这类回执脚本返回成功，dev 模式可走通工具链。

### 改进（隔离区 export 应用换轨：merge-tree 写回主根）

- **实证否决 `git apply -3` 路线**：`--3way` 隐含 `--index`，要求「工作区文件与 index 一致」，主根有未暂存改动（隔离区回灌的常态场景）时整份补丁直接失败（`f.txt: does not match index`），连可干净应用的文件都不写——原方案的 apply -3 路线不可用。
- **应用改为 merge-tree 写回**（与预检共用 `runMergeCore`，同一引擎报告与应用永不分叉）：审批通过后重新跑一次三方合并（覆盖审阅间隔内主根再变的竞态），把合并 tree 里的文件内容经 `cat-file blob` 写回主根工作区——纯 plumbing，**不碰真 index / HEAD / 分支、无 unmerged stages 残留**；合并结果里不存在的文件（隔离区删除）同步删除主根文件；**真冲突文件不写**，原因进逐文件结果与预检报告，交 AI 在隔离区重做。新增 `GitWorktreeMergeApply` 绑定（`internal/gitinfo/worktree_preview.go` 的 `WorktreeMergeApply`），结果契约对齐 PatchApply（mode/applied/skipped/added/removed/files），结果卡零适配。
- 审批卡里 merge-tree 判「可合并」的文件按可应用呈现（双向引擎判冲突 ≠ 三方合不了，如行号漂移、远处改动），用户仍可自由勾选；全部判定为「已应用」或「只有真冲突」时不出审批卡（S1 行为不变）。实施发现：相邻行改动在 git 三方合并里判冲突（改动区域相接即冲突），属正确行为。
- 测试：`TestWorktreeMergeApply`（漂移合并写回两侧改动同时在场 / 冲突不写 / 已应用 skipped / 删除同步 / 越界路径拒绝 / index 与 HEAD 不动）。

### 改进（隔离区 export 零副作用三方合并预检）

- **export 先跑 merge-tree 预检再落盘**（方案 `docs/finished-plans/worktree-export-improvement.md` L1）：carry=true 的基准快照 commit 就是现成 merge-base，新增 `GitWorktreeMergePreview`（`internal/gitinfo/worktree_preview.go`）——主根与隔离区各做一次 `GIT_INDEX_FILE` 临时 index 工作区快照（不碰用户暂存区 / HEAD / 分支），`git merge-tree --write-tree --merge-base=<baseSha>` 三方合并后按改动文件分三栏：**真冲突**（附 merge-tree CONFLICT 原因）/ **本次可应用** / **已应用**（主根与隔离区内容一致，明确「无需重做」）。此前重复 export 会把已回灌 hunk 报成「没有任何文件可直接应用」的误导报错，现改为有信息量的三栏报告且不落盘补丁。
- **体量护栏**：工具回执只给索引——冲突 / 可应用清单各 20 行封顶、已应用 10 行，超出折叠计数；全量报告每次 export 独立落盘主根 `.cadt/export-reports/<name>-<时间戳>.md`（不覆盖，可跨次比对），AI 要细节按需 read_file，冲突文件内容永不进上下文。
- **新绑定**：`GitWorktreeMergePreview` / `GitPatchID`（diff 稳定指纹，`git patch-id --stable`）；git <2.38（无 merge-tree）或快照失败时静默降级走原 PatchSave 链路，行为不劣化。隔离区登记新增 `lastExportReport` / `lastExportPreviewAt`（导出状态标记）。
- 测试：`worktree_preview_test.go`（三栏分类 / 干净合入 / 快照保暂存区）；`ai-worktree.test.mjs` 增预检回执（体量护栏 / 全部已应用 / 折叠）。

### 改进（Git 提交面板对齐 IDEA：单击选中 / 双击只读差异 / 文件类型图标 / 富右键菜单）

- **单击文件名只选中行**：以前整行是 `<label>`，点文件名会顺带切换勾选框、双击还会同时触发勾选与开差异，两个事件打架。现在行改为普通容器、勾选框独立命中区：单击只选中（高亮 `--accent-weak`，轮询重渲染后保持选中），点勾选框只切勾选，双击才打开差异。
- **文件类型图标**：文件名前加与文件树同源的类型图标（`core/fileicons.js` 的 `createFileIcon`）。
- **双击看差异改为固定只读**：差异虚拟文档传 `readOnlyFixed: true`（`bridge-git.js` 的 `showGitDiff`），状态栏显示「只读快照」，`setDocReadOnly` 拒绝对它解锁——以前是可编辑的普通虚拟文档。
- **右键菜单对齐 JetBrains 常用项**（带图标）：显示差异 / 跳转到源 / 文件历史 / 作为补丁复制到剪贴板 / 回滚更改 / 刷新；右键会先选中该行再弹菜单。菜单实现 `openGitFileMenu`、选中态 `selectGitRow`/`applyGitSelection` 在 `terminal-ui.js`，并给 terminal-ui 注入 `openPathsHere` 依赖。

### 修复（便签标签菜单出现两个对勾）

- 标签管理菜单里已选中的标签显示两个对勾：预设项的 label 里拼了 `'✓ '` 前缀，同时 `checked: true` 又让行首渲染一个对勾图标（`renderMenuIcon` 的 checked 分支）——同一行两处勾。去掉 label 里的文字前缀，只靠 `checked` 画图标（`bridge-memo-view.js` 的 `openTagMenu`）。

### 改进（Git 快捷操作支持配置提交粒度）

- Git 快捷操作（提交代码 / 提交并推送）的提交风格配置新增 **`granularity` 字段**：`batch`（按功能/主题分批提交，一批一 commit，推荐，符合项目「一次提交一个主题」惯例）/ `single`（所有改动一次提交）。首次使用询问时多问一项「提交粒度」，此后按工作区 `.cadt/git-commit-style.json` 执行，不再重复询问。
- 提示词模板 `frontend/src/ai/ai-git.js` 的 `STYLE_RULES` 同步字段说明与 JSON 示例（`version` 升到 2），提交流程步骤按粒度给出「分组逐批 add+commit」或「全部一次提交」的执行指引。

### 改进（会话列表工作区分组头的「⋯」改为工作区管理菜单）

- AI 会话列表里工作区分组头（如 `CaDt-DataLens`）右侧的「⋯」以前弹出的是**会话管理菜单**（新建 / 置顶 / 重命名 / 删除当前会话…），与面板标题栏右侧的会话菜单重复。现在改为**工作区管理菜单**：在文件资源管理器中显示、复制工作区路径、在新窗口打开此工作区、在此工作区新建会话、打开文件夹…、最近打开的工作区（子菜单）、关闭当前工作区（仅当前分组显示）。面板标题栏右侧的「⋯」仍是会话列表整体菜单，保持不变。
- 菜单结构由纯函数 `buildWorkspaceMenuItems` 组装（`frontend/src/ai/ai-session-list.js`，配 `ai-session-list.test.mjs`）；动作经宿主 `workspaceMenu` 回调转发到 main.js 已有的工作区能力（`ShowInFolder` / `OpenDirInNewWindow` / `openFolderSmart` / `closeFolder` 等），无新增 Go 绑定。

### 改进（read_file 按行读取卡可展开，代码区与 diff 视觉统一）

- `read_file` 传 `startLine`/`endLine` 按行读取时，工具卡不再只是一行路径：卡头补「行 N–M」范围徽标，点击可展开正文，直接核对 AI 读了哪几行；字符模式（`offset`/`limit`）读取卡行为不变（仍不展开，文件名即超链接）。
- 展开的代码区与 `edit_file` 的 diff **视觉语义统一**：同款「背景框（边框 + 圆角 + `--bg` 底色）+ 独立行号列 + 代码列」结构，行号不再是内嵌在文本里的前缀，四位数行号不折行——「AI 读了哪几行」和「AI 改了哪几行」在对话里长得一样，都是明确的代码块。渲染 `renderReadLinesInto` 在 `ai-tool-cards.js`，配 `ai-tool-cards.test.mjs` 测试。

### 修复（git 面板「回滚」恒报路径越界；未跟踪文件会删错位置）

- 回滚的文件路径来自 `git status`（**相对仓库根**），后端 `gitPathInRoot` 却按 `filepath.Rel(绝对 dir, 相对 path)` 判定——Windows 上混合形态直接报错，于是任何文件回滚都返回「路径越界」，功能整体不可用（2026-11-19 由测试 `TestGitRollbackForReal` 暴露）。
- 后端：相对路径先按 dir 解析（`filepath.Join`）再判越界；未跟踪文件的删除同口径——原来直接用相对路径调 `os.Remove`，会按**应用进程 cwd** 找文件，删不到目标甚至删错同名文件。
- 前端：回滚的 dir 改用 `GitStatus` 返回的仓库根（新增 `gitStateCache.repoRoot`）——工作区是仓库子目录时，相对仓库根的 pathspec 只配仓库根才能解析正确；老后端无 root 字段时退回工作区目录。
- 测试：`TestGitRollbackForReal` 从「在真实工作区改示例文件再 checkout」改为临时仓库夹具。原写法两个测试实例并发会互踩（A 写入的 `// modified` 被 B 读成 orig），且 defer 的 `git checkout` 会丢弃用户对该文件的未提交修改。新夹具显式关 `core.autocrlf`（本机全局开启时 checkout 把 LF 转 CRLF，字节比较误报「未还原」）并按行尾归一比较。

### 新功能（隔离区操作必须说明原因）

- AI 主动**创建 / 丢弃**隔离工作区时**必须带 `reason`**（≤200 字，CJK 按字符计数）：原因显示在审批卡**第一行**，让用户先看清「为什么」再决定批不批，而不只是看到「要做什么」。缺失或超长直接拒绝并提示补参数，不弹卡；用户自己手点的隔离开关不受影响（那是用户发起的动作）。
- 实现：`worktreeReasonCheck` 纯函数在 `frontend/src/ai/ai-worktree.js`（trim / 空值 / 上限校验，配测试）；`worktree_manage` 工具新增 `reason` 参数并在 create/discard 的描述里写明必填与用途；`requestWorktreeApproval` 透传到 `frontend/src/ai/ai-takeover.js` 的隔离区审批卡（create / discard 两个分支都渲染）。

### 新功能（插件扩展点收尾：自定义视图 registerViewer + 导入器接进打开链）

- **`cadt.registerViewer`（自定义视图）**：插件可以给某个格式注册自己的渲染视图（地图 / 图表 / 3D / 播放器），出现在标签页视图按钮与底栏「视图」下拉里，按 `priority` 排序。视图是**覆盖层**：切走即调 `destroy()`、切回重新 `mount`；主题切换走 `setTheme()`，不重挂。写回一律经 `ctx.requestSave(text)` 上抛编辑器，脏标记 / 自动保存 / 只读锁 / 外部修改检测照旧生效；二进制档与 `>10 MB` 只读档不提供插件视图。视图模式串是 `plugin:<id>`，随会话持久化，插件被禁用 / 卸载后标签页自动回落默认视图。注册表 `frontend/src/shell/plugin-viewers.js`（单插件 ≤10、全局 ≤30，超限注册即报错），运行时 `frontend/src/editor/editor-plugin-view.js`，接线覆盖 `createDocEditor` / `closeDocNow` / `switchMode` / `viewOptionsFor` / `viewDisabled` 五处。
- **`cadt.registerImporter`（导入器）接进打开链**：打开内置解析不了的文件（二进制视图）且扩展名命中插件导入器时，先弹确认框问要不要用它转成文本；同意则以**只读虚拟文档**打开并 flash 插件名与导入器名。用户拒绝或转换失败一律退回原有二进制视图——导入失败不会让文件打不开。返回 `{text, name}` 可建议新文件名（`report.md` 才会走 Markdown 渲染）。读接口复用既有绑定，不新增 Go 绑定；`readBinaryFile` 上限 1 MB，更大的二进制请用插件自己的通道。
- 示例插件 `docs/plugins/examples/geojson-viewer/`：canvas 地图视图 + `.bin` 十六进制取样导入器，零第三方依赖。文档补 `docs/plugins/README.md` 两节（API 形状、ctx 成员表、边界与限制）。
- 测试：新增 `test/shell/plugin-viewers.test.mjs`（11 例）与 `test/shell/plugin-importers.test.mjs`（6 例），均登记进 `npm test`。

### 修复（额度外显显示问题一批）

- **DeepSeek 账户卡只显示「是」**：官方引擎条目里的「账户可用」是零信息量行，现在被过滤，优先显示总额余额等有金额的行（只剩它时才显示）。
- **SenseNova 显示「112911.76%」**：`unit='%'` 的条目此前把 remaining（原始 token 数）套上了 % 单位。现在百分比条目一律显示「已用 X%」，remaining 只作为「剩余 660K」出现在明细里。
- **「N 个套餐 · 第一名」改为完整列出**：账号卡、模型选择器分组头、明细弹层都直接列出每个套餐（如「5 小时 已用 12% · 每周 已用 32% · 每月 已用 16%」），不再聚合。
- **重置时间改为倒计时**：extractor 统一输出结构化 `resetAt`，显示层按 `d/h/m` 只取两个单位渲染（`27d2h` / `1h55m` / `55m`），对齐 cc-switch `countdownStr`；各预设（Kimi/智谱/MiniMax/ZenMux/OpenCode Go/Ollama/SenseNova）同步。
- **去掉协议字段**：用量明细弹层头部的 `/chat/completions` 标签、模型选择器账号分组头的协议标签一并移除（协议信息在账号卡 meta 行已有）。
- **用量明细弹层重排版**：每条额度改为独立行卡（档名 + 右对齐数值，第二行灰色小字写「重置 2h51m · 剩余 880K · 返赠 500」），条目间细分隔线，弹层加宽到 380px、数值等宽对齐；快照缓存键升 v2，旧格式缓存直接作废重查。

### 新增（通用 OAuth 额度模板：SenseNova Token Plan）

- 额度外显新增第七种预设模板「**OAuth**」（与官方/通用/NewAPI/Sub2API/Token Plan/自定义并列）：服务商额度接口用**控制台登录 token**（不是 API Key、会过期）的，走通用 OAuth 引擎。第一条配置是 **SenseNova Token Plan**：在 OAuth 模板下选 provider、填控制台账号密码登录（密码只用于本次登录、封成 JWE 后发出，不落盘），refresh token 存 DPAPI 加密文件并自动轮续；额度卡显示每个额度池的 5 小时 / 每周**已用百分比 + 剩余数值 + 重置时间 + 返赠余额**。
- 引擎通用化：`internal/oauthquota` 按 Provider 配置驱动（端点/PKCE/JWKS/IAM 登录全在配置表），新增 OAuth 服务商只需加一条 Go 配置 + 一条前端预设脚本，不改引擎与 UI；带 token 的请求限制在 provider 域名下，OAuth 入口不开放给 AI。
- 额度数值按 cc-switch 口径着色（对齐 `quotaRules.ts`）：颜色按**剩余**算——>20% 绿、≤20% 橙、≤0 红，只给数字上色、文案保持灰；余额（无总额）绿、用完红。深色用 green/orange/red-400 亮色、浅色用 600/500/500。
- 用量配置弹窗去掉「查看/收起预设脚本」的预览按钮与预览区（意义不大且折叠态不一体）；自定义脚本编辑器字体改用内置 JetBrains Mono（此前是系统 monospace）。
- 方案与实现记录见 `docs/finished-plans/oauth-quota-template.md`。

### 新增（AI 账号额度外显，cc-switch 式用量查询）

- 设置 → AI → 模型的账号卡新增**品牌图标**与**余额行**：开启用量查询的账号常显余额/套餐额度（如「余额 49.05 CNY」「5 小时 已用 34.50%」），点击重新查询并弹出明细；查询失败红字带原因可重试。**未开启的账号没有余额行、也没有查询按钮**——统一只有「用量配置」入口（替代原「查询用量」按钮）。
- 「配置用量查询」弹窗：预设模板 chips（官方 / 通用模板 / NewAPI / Sub2API / Token Plan / 自定义）+ API Key / 请求地址覆盖（留空用账号的）+ 超时与自动查询间隔（分钟，0=不自动）+ **测试脚本**按钮。「官方」模板走内置白名单引擎（DeepSeek / OpenRouter / SiliconFlow）；Token Plan 内置 7 家套餐预设（Kimi For Coding / 智谱 GLM / 智谱团队 / MiniMax / ZenMux / OpenCode Go / Ollama Cloud，端点移植自 cc-switch），自定义脚本支持 `{{baseUrl}}` / `{{apiKey}}` 与 extraFields 变量替换。
- 自定义脚本格式 `({ request: {...}, extractor: function (response) {...} })`：**extractor 在隔离 Worker 沙箱执行**——Worker 全局没有 `window.go` / DOM，prelude 从实例与原型链两层摘除 fetch / XHR / WebSocket / importScripts 等网络与派生原语（只遮 globalThis 会被原型链取回），5 秒硬中断、脚本 ≤64KB；HTTP 一律经 Go 哑通道（`AIUsageHTTPRequest`，转发 aigen 引擎）发出。配置随账号存 ai-config.json（0600），导入导出沿用 includeKeys 脱敏语义。
- 模型选择器（面板头部模型胶囊）的**账号分组头**同步显示品牌图标与余额主句（失败态红字）。
- 缓存：查询结果按账号缓存（内存 + localStorage 快照，只存展示数据不存密钥），进入模型页时按自动间隔节流补查；AI 不可达——没有给模型暴露任何读写该配置的工具或动作。
- 新模块：`ai/ai-usage-templates.js`（模板与套餐预设数据）、`ai/ai-usage-quota.js`（查询管线 + 沙箱 + 缓存）、`ai/ai-usage-config-dialog.js`（配置弹窗）、`ai/ai-provider-icons.js`（17 家供应商品牌 SVG，取自 cc-switch MIT 仓库）；测试 `test/ai/ai-usage-templates / ai-usage-quota / ai-provider-icons` 已登记 `npm test`。方案存档 `docs/finished-plans/ai-quota-display.md`。

### 新增（生命周期：9 事件自动执行命令，对齐 ZCode 钩子）

- 新功能「生命周期」：给每个工作区配置一组命令，按 **9 个事件**自动执行（对齐 ZCode 钩子模型，工作目录为该工作区根，继承「设置 → 环境变量」）：
  - 工作区级：`workspace-open` 打开工作区（打开 / 切回 / 启动恢复）、`workspace-close` 关闭工作区（显式关闭或切走旧目录；应用整体退出不触发）；
  - AI 会话级：`session-start` 会话开始（空会话首轮流起**前**阻塞，每会话一次）、`user-prompt-submit` 提交用户输入（每轮起轮前阻塞）、`stop` 停止生成时（fire-and-forget）；
  - AI 工具级（按**工具名匹配器** `matchTools` 过滤，空=全部、`mcp__*` 前缀通配）：`pre-tool-use` 工具前（阻塞）、`post-tool-use` 工具成功后、`post-tool-use-failure` 工具失败后、`permission-request` 权限请求时（审批卡出现前阻塞）。
  - 设置 → 生命周期页只列条目摘要；**新建/编辑命令走独立弹窗**（命令 / 时机 / 匹配工具 / 超时），不再在页内展开表单。
  - 阻塞型事件等命令跑完才继续；其余 fire-and-forget 不阻断宿主流程。配置入口在 设置 → 生命周期（导航「运行」旁）：总开关 + 条目列表（启用开关 / 时机 / 匹配工具 / 上移下移 / 编辑 / 删除 / 危险命令标记）+「本工作区预跑一次」。单条失败不阻断后续，结果汇总进状态栏消息中心（失败额外弹 toast），操作留痕记 `precmd.run` / `precmd.config`（只记摘要不记命令正文）。
- **AI 可代配，但每次写入都要审批**：`app_control` 新增 `get_pre_commands` / `add_pre_command {command,timeoutMs?,event?,matchTools?,enabled?}` / `update_pre_command` / `remove_pre_command`，三个写动作**无条件弹动作审批卡（完全权限档也不例外）**，审批卡列出命令全文、触发事件与匹配工具；批准后条目标「AI 配置」徽标、执行汇总注明来源；AI 只能操作本窗口当前工作区的条目；**刻意不提供「立即执行」动作**——要跑命令走 `run_command` 正常审批链，不给借道免审批的旁路；计划模式下拦截三个写动作。
- 存储刻意放本机设置（localStorage），不放应用数据或工作区 `.cadt/`：full 档的 AI 可直接写应用数据文件，放那里等于绕过审批拿持久化后门；放工作区则等于「打开陌生仓库自动执行命令」。设置里 AI 摸不到 localStorage，审批不可绕过。上限：全局 20 条 / 单工作区 10 条 / 单条命令 2000 字符 / 超时 1–600 秒（默认 30 秒）。旧事件名 `ai-session-start` 保留为别名兼容已存盘配置。方案见 `docs/finished-plans/workspace-lifecycle-hooks.md`。
- 配套测试 `test/core/precommands.test.mjs`（归一化 / 上限 / 审批规格 / 匹配器 / 汇总含 stderr 尾部）与 `test/shell/precommands.test.mjs`（9 事件执行 / 工具匹配 / 重入跳过 / 四动作审批语义 / 改绑与撞 id 防护），登记 `npm test`。

### 修复（自动压缩死锁：error 收尾的会话永久卡在发送门禁）

实测路径：47 轮的会话，最后几轮的大工具结果把估算堆过阈值，恰好那轮以 **error 收尾**（限流 / 超窗措辞没命中恢复分支）——自动压缩的轮末检查只在 `status === 'done'` 时跑，error 直接跳过；而估算 94% ≥ 90% 发送门禁把所有新轮拦住，**轮末检查从此永远不会再触发**，会话死锁在红条上。

- 轮末检查扩展到 error 收尾（`overflowRecovered` 的错误已走「强制压缩 + 重发」分支，跳过避免双重压缩；`autoCompactCount` / 溢出恢复计数仍只在 done 时重置，不放松防循环闸）。
- 发送门禁拦下时（快速门禁与 `over_budget` 权威预检两处）兜底触发一次 `maybeAutoCompact`：被拦的轮永远完不成，这就是最后能自救的时机。输入框文字不会被清（起轮成功才清），压缩完成后直接再点发送即可。
- `maybeAutoCompact` 内部本就有开关与阈值判断（估算没过线 = 空操作），兜底调用无条件发起是安全的。

### 修复（两个只读审查代理报出的缺陷）

两轮并行审查（Go 侧 / 前端侧）报出 1 个严重、8 个中等、十余个轻微问题，已全部处理或裁定。要点：

- **严重：sealed 场景下自动保存会覆写解不开的配置**。三处叠加修复——① bootstrap 的 sealed 分支补上与 `saveAIConfig` 同口径的基线（`lastConfigText`），配置没变时自动保存直接跳过；② 热重读失败的 `catch` 不再静默吞 `AI_CONFIG_SEALED`，会置标记；③ Go 侧 `WriteFile` 加防呆闸门：目标文件存在且是本环境解不开的密文时拒绝写入（不变量不再依赖前端内存状态）。旧后端缺 `AIConfigBackupSealed` 时宁可不写。
- **转录读回在默认路径上不可达**（三处叠加）：`toolMessage.agent` 落盘时没有 `id`、标签页 spec 漏复制 `parentSessionId`、读回成功后调了无参的 `scheduleAgentViewRender()` 等于不刷新。现在 `agent` 持久化 `id + artifactDir`、spec 补字段、读回后按 view 重渲染、读不到也收敛到兜底文案（不再永远挂「正在读取」）。落盘目录改用**根会话** id——嵌套代理原来落在父代理的会话目录里，删根会话清不掉。
- **应急收缩两处失效**：压力判定改用与提醒条同口径的 `aiEstimateTokens`（原 `chars/3.2` 对中文低估一倍以上，90% 阈值要 2.7 倍窗口才触发），并把系统提示词与 `toolCalls.arguments` 计入；压力档新增独立的 2 000 字符修剪门槛（原来低于落盘阈值的结果一条也压不动）。
- **配置镜像的凭据不止 apiKey**：`extraHeaders`（Authorization/x-api-key）、`usage.extraFields`（额度脚本 cookie）、`genModels[].headers`、代理地址里的 `user:pass@` 全部从 localStorage 镜像剥掉。
- **`<mcp_server_notes>` 注入面**：notes 是数据不是指令，尖括号转义（`</mcp_server_notes>` 闭合块、伪 `<system-reminder>` 都失效），换行压平补齐 `\r` 与 U+2028/2029；Go 侧快照按 rune 截断 1000 字（手改 `mcp.json` 塞长文本也进不来）。
- **并发批次单点异常静默停摆**：组内改 allSettled 语义（一个收尾抛错不再丢掉同批结果），`handleToolRound` 调用点补 `.catch`。
- **Go 小修**：`Encode("")` 不再产出 `enc:v1:` 空密文、`Decode` 对只剩前缀的截断文件返回 `ErrSealed`（损坏 ≠ 空配置）；`BackupSealed` 加 2 MB 上限、备份名精确到毫秒（同秒互覆）；`sanitize` 拦 Windows 保留设备名（CON/NUL/COM1…，Read 打开设备可能挂住 GUI）、Trim 移到截断之后（尾点剥离会让两个 id 落同一目录）；`cache_control` 降级不再消耗 429/5xx 的重试预算（`attempt--` 抵消）；`ai-artifacts` 清理文案明确「子代理转录删了不可恢复」。
- **补测试**：`internal/dpapi` 往返 + 坏 base64（这次重构最欠的回归面）；指针文案加死链出路（清缓存后模型不必白跑一轮）。
- 参数折叠的语义收紧：同一条 assistant 消息里的兄弟调用成功不再算「后续重试」（B 成功不代表 A 的参数被取代）。

### 新增（子代理转录重启后可读回）

- 子代理结算时落盘的转录（`ai-artifacts/<父会话>/sub-<agentId>.txt`）现在**能被读回来了**：重启后打开子代理详情，内存里没有转录时会异步补读磁盘并重渲染，原来那句「应用重启后子代理只保留状态与结论摘要」只在文件也不存在时出现，等待期间显示「正在读取磁盘转录…」。
- 新增绑定 `AIArtifactRead(sessionId, name)`（路径由 Go 侧拼，前端不碰应用数据目录）；`aiartifact.Read` 带 4 MB 上限、非法 id/名一律拒绝，缺文件返回空串而不是报错。
- 每个子代理只补读一次，失败不重试（避免打开详情就反复打盘）；读到后写进内存缓存，后续切标签页不再读盘。
- 测试：`aiartifact` 新增往返/缺文件/非法入参 1 例，`parseTranscriptLines` 1 例（坏行跳过、缺字段归一成空串——这是与写盘侧的格式契约）。

### 变更（同一轮工具调用支持并发）

- **一轮里相邻的只读调用并发执行**（`read_file` / `list_dir` / `search_text` / `glob`），单批上限 4 个；写文件、执行命令、派子代理、MCP 工具一律串行——它们带顺序语义或审批。此前是 `for + await` 全串行：模型一轮读 5 个文件就是 5 次串行往返。做法对齐 codex 的 `can_run_in_parallel`、deepseek-harness 的 `executionMode` 分类器（不明确可并行就串行）、ZCode 的 `concurrentSafe`。
- **并发资格还要求路径在工作区内**：工作区外的读会弹审批卡，两张卡同时弹会互相挡住，所以解析不出路径或解析越界的调用自动退回串行。
- 顺序与落盘不受影响：tool 消息的 push 发生在第一个 `await` 之前，`messages` 顺序仍等于模型的调用顺序；会话落盘本身按会话 id `enqueue` 串行化，并发调用只会合并、不会交错。
- 实现：新模块 `frontend/src/ai/ai-tool-schedule.js`（`PARALLEL_READ_TOOLS` / `isParallelToolCall` / `groupToolCalls`），`ai-panel.js` 的 `handleToolRound` 把单次调用抽成 `runToolCall(call)` 后按批次执行。
- 测试：`ai-tool-schedule.test.mjs` 5 例（只读白名单、批次切断、并发上限、eligible 谓词、边界输入），已登记 `npm test`。

### 变更（压缩：应急收缩 + 摘要保真 + 超窗兜底）

- **应急收缩（不调模型）**：窗口占用 ≥ 90% 时，把原本「倒数第 2 轮以前才修剪」的规则放宽成「除最近 5 个工具结果外全部换成指针/修剪」。位置对齐 ZCode 的 microcompact（它同样 0.9 触发、保留最近 5 个结果）：本地先降载，避免窗口快满时只剩「直接调模型做摘要」这一条贵路。**只改发出去的请求，会话历史原样不动**。最近 5 个结果不动的原因很实际——模型正在用的数据被清掉，它得重跑工具，那个往返比省下的 token 更贵。
- **摘要提示词按「保真优先」重写**：加了逐字保留清单（文件路径、函数/符号名、命令行、报错原文、URL、各类 ID 与标识符、关键数字与阈值）、五类必须写清的事项（目标与硬约束 / 决定与被否决方案 / 已完成事实与证据 / 未完成事项与下一步 / 工作流状态），以及「新历史优先于旧摘要」的冲突规则。参照 opencode 的 checkpoint 提示词。
- **超窗兜底**：原来「上下文已超过模型上限 → 请先切模型」这条死路取消。改为按窗口比例截断喂给摘要器的转录（窗口 40%，至少 8 K 字符），保证摘要请求本身一定发得出去；截断只影响摘要能看到多少，归档原文与保留下来的消息都不动。
- 未做：opencode 那种 `[0.85, 0.7, 0.5, 0.35]` 渐进收缩（作者裁定不做）。
- 测试：`ai-context-slim` 新增 2 例（压力阈值与窗口未知、最近 N 个工具结果索引），`ai-compact` 新增 1 例（转录预算与尾部保留、下限 2000）。

### 变更（Anthropic 提示词缓存断点）

- **Anthropic 系请求现在会打提示词缓存断点**：`system` 改为 block 数组并在末块加 `cache_control: {type:"ephemeral"}`，最后一个工具定义、最后一条消息的末尾 block 同样打点（共 3 个，上限 4）。此前只解析返回里的 `cached_tokens` 却从不发断点——OpenAI / DeepSeek 是自动缓存不受影响，**Anthropic 格式必须显式打点才缓存**，否则每轮全量计费。断点位置依赖「动态块已移出系统提示词」这个既有设计（稳定前缀才值得缓存）。
- thinking / redacted_thinking 块不接受 `cache_control`，遇到会往前落到 text 块。
- 兼容降级：个别 Anthropic 兼容网关不认该字段，400 且报文提到 `cache_control` 时自动去掉全部断点重发一次（与既有的 stream_options / 关思考参数降级同一套路）。
- 测试：新增 `anthropic_cache_test.go` 4 例（断点位置与总数、关闭后形状完全回退、跳过 thinking 块、400 判定），并同步更新 `TestAIStreamAnthropic` 对 `system` 形状的断言。

### 新增（MCP「使用约定」注入系统提示词）

- 设置 → MCP 的服务器编辑弹窗新增**「使用约定」**多行输入（≤1000 字），保存进 `mcp.json` 的 `notes`。用途是把某个 server 专属的用法约束写在配置里，而不是塞进 CaDt 的通用系统提示词——比如「提交前先校验字段长度」「一次最多提交 10 条」「按来源分批」。
- 有内容的 server 会拼成 `<mcp_server_notes>` 块，**接在工具目录之前**注入系统提示词（模型先看到用法约束，再看到工具定义）；一个都没写就整块不出现，不占上下文。多行会压成单行，避免用户文本里的换行破坏块结构。
- **纯展示数据**：`stripRuntimeFields` 把 `notes` 剥离，改备注不会触发「配置变了 → 关掉再重启 server」。快照里带上 `notes`，前端直接读，不额外发 RPC。
- 上限口径：前端 `MCP_NOTES_MAX_CHARS` 与 Go `mcpNotesMaxChars` 同为 1000（按字符计，CJK 一字算一个）；textarea 的 `maxlength` + 表单校验 + Go 写入期校验三层。
- 测试：Go 2 例（字符上限、`stripRuntimeFields` 忽略 notes），前端 3 例（块只列有内容的 server / 多行压平 / 快照透传与缺省归一）。

### 新增（过期工具参数折叠）

- **整批提交类 MCP 的失败批次参数不再反复重发**：`aoci_update_entry` 这类接口只要有一条不合规就 `applied=0` 整批退回（实测 16 次退回时 `finding` 只有 1–5 条，却连累 37–47 条全部重发）。那些失败批次的完整参数（JSON 阵列，单批 2 万字符上下）留在 assistant 消息里已无复用价值，现在在后续同名调用成功之后折叠成一句说明：「原参数 N 字符已省略，不要复用，以最近一次成功提交为准」。
- **实测收益**（session-mwmpfg5fihesi）：31 次调用里 17 个失败批次可折叠，参数合计 378 810 字符，净省 **≈ 375 K 字符 ≈ 117 K token**，占该会话 982 K 上下文的 12%。
- 判定只依赖两个可观测事实、不解析业务 schema：① 结果带「整批未接收」回执标记（`repair_required` / `stopped`，JSON 两种空格写法都认，标记表在 `ai-context-slim.js` 的 `SLIM_ROLLBACK_MARKERS`，接新接口加一行）；② 同一工具其后调用成功过。**尚未成功重试的批次不折叠**——那种情况下旧参数仍是下一轮重发的底稿。
- 组装视角生效（会话 JSONL 与 UI 里的调用参数照旧完整），与工具结果瘦身同层、同开关（`settings.aiContextSlim`），省量记账新增「过期工具参数」一栏。

### 新增（大工具结果落盘 + 上下文瘦身覆盖 MCP）

- **超过阈值（内置 8 192 字符 / MCP 50 000 字符）的工具结果落盘，上下文里换「预览 + 路径」指针**：写到 `<应用数据>/ai-artifacts/<会话 id>/<toolCallId>.txt`，请求里发「头 4 096 字符 + 原文长度 + 绝对路径 + 读法提示 + 尾 1 024/2 048 字符」。原文仍在会话 JSONL 里（只瘦请求、不瘦历史），指针随消息落盘，重放后照样有效。写盘失败或超过 4 MB 退回原来的「修剪中段 + 提示重跑」。MCP 与其他第三方工具（`mcp__` / `plugin__` 前缀）的阈值单独放宽到 50 K（对齐 ZCode `mcp/index.ts` 的 `maxModelBytes: 50 000`）：8–50 K 的查询结果往往是模型接下来要直接引用的数据，落盘再读回要多花一轮工具调用。
- **判定从白名单翻成黑名单**：旧实现只认 `read_file / web_fetch / run_command / background_command / search_text` 五个内置工具，**MCP 工具全被漏掉**——实测一个会话里 `mcp__aoci__aoci_update_entry` 的 553 K 回显、`aoci_maintain` 414 K 原样进了上下文（占该轮上下文一半以上）。现在除「自带行窗口」的 `read_file` 与「操作回执、不可重得」的写/改/补丁/派单/待办/提问外，一律按体量判定，MCP 与内置同权。
- **读策略同比收窄**：应用数据目录的硬拒保留，唯一例外是 `ai-artifacts/` 子树（与 Go 侧 `internal/aiartifact.DirName` 同源）；读该子树不走工作区授权链，不弹审批——否则「读回自己落盘的全文」会被审批卡打断。密钥（`ai-config.json`）、会话正文（`ai-sessions/`）及其它应用数据仍在拒绝范围。
- **生命周期**：删会话清 `ai-artifacts/<会话 id>/`，删全部会话清整根；存储清理新增 `ai-artifacts` 条目（`KindCache`，进一键清缓存，删了不丢正式内容，只是指针失效需重新调工具）。
- **子代理转录落盘**：子代理结算时把内存转录写成 `ai-artifacts/<父会话>/sub-<agentId>.txt`（JSONL，一行一条角色/工具名/文本），补上「`agent_stop` 收集过程记录在进程退出后即丢」的缺口。纯留档，失败不影响结算。
- 实现：新增 `internal/aiartifact`（路径清洗、4 MB 上限、按会话分桶、越界双保险）与 `ai_artifact_app.go`（`AIArtifactWrite` / `AIArtifactClear` / `AIArtifactClearAll`）；前端判定在 `ai-context-slim.js`（`SLIM_SKIP_TOOLS` / `spillWanted` / `spillPointerText` / `slimToolResult`），接线在 `ai-panel.js` 的工具回包与 `buildApiMessages` 两处，读放行在 `ai-read-roots.js`（`ARTIFACT_DIR_NAME` / `isArtifactPath`）。
- 测试：`internal/aiartifact` 4 例（落盘与清理、路径穿越拒绝、超限、空目录）、`internal/storage` 的清缓存范围快照同步登记 `ai-artifacts`；前端新增/改写 `ai-context-slim` 5 例（MCP 纳入、跳过表、指针文案、命令尾部预算、有路径/无路径分流）与 `ai-read-roots` 1 例（产物子树可读、兄弟前缀与会话目录仍拒）。

### 变更（AI 配置整份加密落盘）

- **`ai-config.json` 在 Windows 上整份 DPAPI 加密**（文件前缀 `enc:v1:`）：密文绑定当前 Windows 用户与本机，模型即使能读到文件，拿到的也只是密文——与 ZCode 的 `~/.zcode/v2/credentials.json` 同一种做法。读写对前端完全透明（`ReadFile` 解出明文、`WriteFile` 加密后落盘），旧的明文配置照常能读，**下次保存自动升级**成密文，不需要用户做任何动作。
- **解不开时不静默覆盖**：换机器 / 换 Windows 用户 / 文件损坏时 `ReadFile` 返回带 `AI_CONFIG_SEALED` 标记的错误；前端据此进入「留档待办」状态，第一次保存前先调新增绑定 `AIConfigBackupSealed` 把原文件改名成 `ai-config.json.sealed-<时间>.bak`，再写新配置。绝不出现「解不开就用空配置盖掉」。
- **localStorage 镜像不再存密钥**：`profiles[].apiKey` / `profiles[].usage.apiKey` / `genModels[].apiKey` 写镜像前置空。镜像仍是旧版本回退与 WebView2 重置的兜底，但回退路径缺密钥需要重填——这是「密钥不落明文」的必然代价。
- 实现：新增 `internal/dpapi`（Windows CryptProtectData / 非 Windows 恒不支持），`internal/envvars` 与 `internal/aiconfig` 共用这一份 syscall 实现，不再各写一套；`internal/aiconfig` 增加 `Decode` / `Encode` / `BackupSealed`，`Store` 增加 `AIConfigBackupSealed` 绑定。前端改动在 `ai-panel.js` 的 `saveAIConfig` / `bootstrapAIConfig` / `reloadAIConfigFromDisk` 三处。
- 测试：`internal/aiconfig` 新增 4 例（落盘无明文 API Key、旧明文升级、伪造密文报 `ErrSealed` 且不改原文件、留档只对密文生效），`internal/envvars` 原用例保持通过。
- 升级注意：加密后的文件只有同一 Windows 用户 + 同一台机器能解。换机迁移请走「设置 → 导入导出」（勾选包含密钥）导出明文 JSON；**降级到旧版本会读不懂该文件**，旧版本会回退到 localStorage 镜像（此时已无密钥）。

### 变更（子代理层级上限默认 3 层 = 2 层子代理）

- **层级上限默认值从「不设限（0）」改为 3 层**：主代理第 1 层、它派出的子代理第 2 层、子代理再派出的孙代理第 3 层，孙代理不能再派。也就是**允许 2 层子代理嵌套**。0 仍是合法值（不设限），只影响**缺字段**的新配置与重置后的配置，已存 0 的老配置保持原样不被动升级。
- 为什么是 3 而不是 2：这个字段数的是「含主代理的整棵树的层数」，且 0 被占用为「不设限」，所以层数永远比子代理嵌套层数大 1。设置页说明与 tooltip 同步写清这层换算（1 = 只有主代理；2 = 主代理 + 1 层子代理；3 = 主代理 + 2 层子代理）。
- 改动点：`ai-panel.js` 的 config 默认、`ai-settings-dialog.js` 的钳制回落、`ai-subagents.js` 的 `subAgentMaxDepth()` 兜底三处同步改为 3；设置页输入框初始值与说明文案一并更新。

### 修复（轮末清单提醒节流失效：相同文案每批工具重插一条）

- **`<task_todos_check>` 轮末提醒的「相同文案不重复催」闸门完全失效**：注入前取上一条提醒的比较文本时用了 `splitTurnReminderPrefix(content).body`——那是包装块**之后的用户正文**，纯注入消息里恒为空串，与待比较的裸 `<task_todos_check>` 块永不相等，`shouldSendTodosCheck` 的第一道闸门形同虚设。后果是清单没动也每批工具结束重插一条：单会话落盘 339 条、最长连续 69 条（2026-11-19 session-mwm2sdc1n4cs5 实测），模型每轮被迫在思考链里复述「没有已完成未标记的项 / 不需要 todo_write」。修复：新增纯函数 `todosCheckTextFromMessage`（`frontend/src/ai/ai-todos.js`，宿主块包装与裸块两种落盘形态都认，统一还原成裸块再比较），`ai-panel.js` 注入点改用它；发送侧 dedupeKey 只保留最新一条的机制不受影响。
- 配套测试 `test/ai/ai-todos.test.mjs`：还原函数的两种形态 / 提取不到返回空串 / 回归断言「相同清单连续两轮只催一次、清单真变了才催」。
- **老会话的重复注入随读盘自动清理**：`replaySessionLog` 重放完成后把同类 `dedupeKey` 机械注入折叠成只留最新一条（口径与发送侧 buildApiMessages 一致），丢弃数经 `droppedTransient` 交给三条加载路径（启动读盘 / 懒加载补水 / 多窗口重载）置 `_needsRewrite`——该会话被再次持久化时整份重写 JSONL，磁盘冗余一并清掉；未打开的会话磁盘不动（无害冗余）。`session_read` / 会话历史查询等读盘方同步少掉这批噪音。配套 `test/ai/ai-session-store.test.mjs`：纯重放折叠（同 key 只留最新 / 无 key 不误伤 / 不同 key 各自折叠 / archived 不动）+ 落盘→读盘折叠→整份重写→日志干净的全链路用例。

### 修复（插件后台服务起不来 + 插件「安装依赖」报错）

- **插件声明的后台服务一律启动失败**：`internal/appservices` 用 `exec.Command` 创建进程后又经 `procctl.ApplyCancel` 写入 `cmd.Cancel`，而 `os/exec` 只接受「由 `CommandContext` 创建」的命令带 Cancel——`cmd.Start()` 直接返回 `exec: command with a non-nil Cancel was not created with CommandContext`（zcode2api 反代的「启动服务失败」即此）。改为 `exec.CommandContext`，取消照旧杀整棵进程树。旧单测把进程原语整体 mock 掉，漏掉了这个只在真起进程时暴露的回归；新增 `internal/appservices/process_test.go`（测试二进制自当子进程）把这条错误钉住。
- **服务工作目录不存在时给出可读原因**：cwd 缺失过去只在 Windows 层冒一句 `The directory name is invalid`，看不出缺的是哪个目录。现在起进程前先校验（不存在 / 不是目录分别报错并附完整路径），插件面板直接显示「工作目录不可用：<路径>」。
- **`cadt.runCommandSync` 返回的是 Promise**（命令在 Go 侧异步执行），文档却写成同步返回 `{code,stdout,stderr}`：插件照抄后拿到 Promise、读输出得到 `undefined`（面板显示「依赖安装失败：无返回」），失败还会散落一条未处理的 Promise 拒绝。`docs/plugins/README.md` 与插件技能说明改为「必须 await」。
- **zcode2api 插件 v1.1.1**：「安装依赖」改为 await + 失败给可读原因（源码目录缺失 / 找不到 Python / 命令输出尾部），一次点击依次装 pip 依赖与 `captcha_node` 的 npm 依赖（后者只服务 JWT 账号，装不上不阻断）；服务未注册时状态行不再显示「查询失败」。

### 修复（便签终端条目运行按钮报错 row is not defined）

- 点终端条目的运行按钮直接抛 `ReferenceError: row is not defined`：审查修复「未提交草稿跑旧命令」时在 `buildRunButton` 的点击处理里引用了 `row`，但该变量在 `buildItem` 作用域——按钮处理内改用 `btn.closest('.memo-item')` 定位行。顺带把运行出发点显性化：运行按钮悬停提示标注「运行于工作区根目录 / 应用进程目录」（命令的 cwd 即工作区根，全局作用域未开工作区时继承应用进程目录）。

### 变更（移除便签 Word(.doc) 导出）

- 导出菜单去掉「Word（.doc，图片存旁侧）」——HTML 兼容形态导入 Word 的兼容提示与排版退化始终不如原生 .docx，保留「Word（.docx 原生，图片内嵌）」与 Markdown / HTML 导出；插件转换器扩展点（`cadt.registerDocConverter`）不受影响。

### 修复（编辑器组接线崩溃：应用启动即抛 ReferenceError）

- 180febc 引入的导出对账漏项：`editor-groups.js` 的导出对象里写了简写属性 `hideHtmlPreview`，但模块内从未定义这个名字（相邻的 `showHtmlPreview` / `hideAudioView` / `hideSvgRender` 等都有包装函数，唯独它漏了）。JS 引擎求值对象字面量时查找裸标识符落空 → `createEditorGroups()` 启动接线即抛 `ReferenceError: hideHtmlPreview is not defined`，main.js 初始化中断，应用窗口起不来（调试台报错 `index-3GRSWvaq.js`）。
- 修复：补上与 show/enter/leave/release 同模式的包装函数 `const hideHtmlPreview = (...a) => splitPreview.hideHtmlPreview(...a)`。
- 为什么构建期不报错：压缩器无法改名对象简写里引用的裸标识符，产物里保留 `hideHtmlPreview,` 原样——构建通过、运行必炸。这类「导出对象简写属性」的错只能靠运行暴露，验收时务必实启一次。

### 修复（工具卡底部「已应用更改」被压成半行）

- 已应用的写文件 / 编辑卡里，正文是 `max-height: min(65vh,460px)` 的纵向 flex：diff 占剩余空间、底部的命令块与结果输出是 `flex: 0 1 auto`（**可缩**）。diff 一长，这两个低优先级项就被一路压到 **3px**——表现成卡片底部「已应用更改（自动放行：完全权限）」下面那行只剩一条边。现在给两者加 `min-height: 1.7em` 保底一行，压不动了；让位由 diff 自己承担（同时它内部照旧滚动）。
- 复现方式写进护栏：`ai-tool-cards.test.mjs` 新增一条 CSS 断言，要求 `.ai-tool-approval-body .ai-command-line` 与 `.ai-tool-approval-body .ai-approval-output` 都必须有 `min-height`，防止以后又有人把「可缩」当无害。

### 修复（后台终端弹层：已停止画成了「暂停」）

- 头部「后台终端」弹层里，已停止的作业画的是 `||` 暂停图标——读起来像「暂停、还能继续」，而后台作业停下就结束了。现在改用实心方块 `stop`（与输入区停止按钮同字形）；「查不到该作业」（应用重启后快照丢失）也不再借用终态图标，换成中性 ⓘ。
- 顺带修同一处语义：图标原来不看退出码，**非 0 退出也画绿勾**，把失败命令说成成功。现在 0 → 绿勾、非 0 → 红叉（新增 `.ai-status-failed` 用 `--red`）。
- 配 `test/ai/ai-head-hud-icons.test.mjs`（4 例源码护栏：stop 字形、退出码分支、notfound 用 info、失败色类）并登记进 `npm test`。

### 修复（wait_agent 等待期间用户发消息的手势语义）

- **排队（Enter）不再打断等待**：以前排队一条消息会把挂着的 wait_agent 立刻唤醒（工具卡秒关、等待白醒一轮还读不到内容），消息又要等整轮结束才发出。现在排队入队即止、不算「待消费输入」，等待完全不被打扰；超时检查点文案会提示「输入框有排队消息，工作告一段落可结束本轮去接收」，本轮自然结束后消息照旧作为正式用户消息送达。想立即让等待中的代理读到，用插话。
- **插话（Ctrl+Enter）唤醒并按轮边界立即注入**：唤醒文案按来源区分——插话明确「下一条请求的轮边界就会注入，继续工作即可读到，无需结束本轮」（旧文案一律说「直接结束本轮」）；代理通知 / 子代理回报给通用通知文案。
- **抢占（Ctrl+Shift+Enter）如实结算等待**：wait 卡中断文案特判为「等待被停止：用户中断了本轮」（原来混在通用「用户已停止生成」里，模型下回合读不懂自己为什么停在等待上）。
- **排队消息发送失败自动重试一次**（2.5s，瞬态的租约/写盘时序失败自愈，持续失败不无限打转）；停止收尾窗口（1.2s）内排队的消息现在也会随收尾冲刷发出（原来要等下次切换会话）。
- 实现：等待原语 `notify` 带唤醒来源（`ai-inbox-wait.js`）；队列 `onChange` 只有 steer 车道唤醒且带来源（`ai-message-queue.js`）；`wait_agent` 待消费输入改按车道判定 `queueLanesOf`（`ai-panel.js` 接线 + `ai-subagents.js` 消费），唤醒 / 超时文案抽成导出纯函数 `waitWakeText` / `waitTimeoutText`；工具描述同步新语义。方案存档 `docs/finished-plans/ai-wait-input-gestures.md`。

### 优化（可视化卡片的生成中占位不再是裸文字）

- 流式期间可视化围栏只有一行 `::before` 纯文字「正在生成可视化…」，跟正文没区别、也看不出「在干活」。现在改成与卡片同宽的加载态：左侧 accent 转环（沿用会话状态点 / 重试徽标那枚 `ai-todo-spin` 规格）+ 呼吸文案 + 卡片底部一条由左向右掠过的柔和高光；异步引擎出图期间的「正在渲染可视化…」（mermaid / echarts / graph / wordcloud）也补上同一枚转环，两个阶段动效语言一致。
- 只作用于「还没挂卡片」的占位（`mountCard` 第一行就设 `data-widget-ready`，已挂载卡片不受影响）；超限终态「内容过大或数量过多，已保留源码」保持虚线朴素提示、不加动势；`prefers-reduced-motion` 下动画全部关闭。

### 新功能（便签终端条目）

- 便签新增**终端条目**：条目正文是命令，行首出现运行按钮，点击以默认 shell（pwsh → Windows PowerShell 兜底，与内置终端默认一致）执行，输出实时渲染在条目下方（等宽深底输出块，stderr 红色、500 行尾部保留、ANSI 与进度条重绘清洗）。**不支持挂起任务**：120s 硬超时自动杀进程树（防 npm run dev 这类常驻），运行中可随时点停止按钮手动停止；状态行显示 运行中/退出码/耗时。块尾快捷新建【终端】按钮由占位转可用，条目右键菜单「转为…」支持文本/Markdown/终端三向转换 +「清除运行输出」。
- 实现：执行复用 F5 的 RunExec 通道（流式 run-out/run-exit、GBK 解码、超时杀树、RunStop），Go 侧零改动；输出为会话内存态不写 memo.json（重渲染不丢、关面板即清）。运行时在 `bridge/memo-term.js`（纯函数 + 编排，运行 id `memo-<itemId>` 与 F5 互不干扰）；AI 经 update_memo 可建/改终端条目（kind=term）但不可运行。配 `test/bridge/memo-term.test.mjs`（12 例）+ memo-model kind=term 断言，登记进 `npm test`。

### 修复（便签滚动位置：点击状态icon等重渲染后滚动条偏移）

- **点击条目左侧标签芯片（及一切触发重渲染的操作）后滚动位置上跳约 43px**：`render()` 重建面板时滚动位置恢复发生在 footer（新建块/跳转栏）入树之前——footer 缺席的那一瞬间 `.memo-body` 被 flex 撑高一个 footer 的高度（实测 clientHeight 336→379），最大滚动量随之变小，接近底部的滚动位置被浏览器钳到偏小的 max（滚动探针实测 208→165.33），footer 补上后 body 缩回但 scrollTop 不会自己涨回来，视口就永久偏移了。修复：footer 构建挪到滚动恢复之前，恢复时 clientHeight 与重渲染前一致（浏览器复测：滚到底 208 → 点标签增删 → 仍 208；中段 100 → 100）。

### 修复（便签贴图放大：右键没有菜单、有时点了没反应）

- **放大后右键没有「复制图片 / 另存为…」**：图片查看层为了不让原生菜单干扰查看操作会吞掉 `contextmenu`，需要宿主传 `onContextMenu` 才有菜单——AI 面板传了，便签侧创建查看层时没传，于是右键被吃掉、菜单和原生菜单都没有。现在灯箱右键弹出与条目贴图同一套菜单；默认文件名取贴图文件名，拿不到时按 data URL 的 mime 给扩展名（贴图管线会把大图转 jpeg，写死 `.png` 会让另存出来的扩展名与字节不符）。
- **「放大不了也没报错」原来有三条静默路径，现在都能放大或至少给提示**：
  1. 点内联图时只认 `img/` 前缀的引用，`./img/…`、反斜杠路径这类引用会被当成「点了文字」直接进编辑态，一点反应都没有 → 引用先归一（去 `./`、反斜杠转正斜杠）；归一后仍不是贴图引用时退回用图片自身的 `src` 打开查看层，彻底拿不到来源才 flash 提示。
  2. 图片解码失败时（坏 data URL、超限图）灯箱停在黑屏：既没放大也没提示，而且 **WebView2 对这类图不派发 `error` 事件**（实测只把 `complete` 置 true、`naturalWidth` 留 0）→ 改走 `img.decode()` 的 reject 兜底，右上角明确显示「无法显示」。
  3. 同一张图反复打开会继承上一张图残留的内联宽高 → 每次打开先清尺寸，适应区域的计算不被旧尺寸带偏。
- 实现：`shell/image-lightbox.js`（`contextmenu` 回调在宿主没给 image 对象时退回当前 `<img>`——否则回调拿到 null、菜单照样弹不出来；load / error / `decode()` 三路 settle 且只成功结算一次，迟到事件不会把用户已放大的比例重置；清残留尺寸）、`bridge/bridge-memo-view.js`（`onContextMenu` 接线、`imageMenuItems` 抽成贴图与灯箱共用、`normalizeMemoRel` / `imageExtFromSrc` 导出供单测）。配 `test/bridge/memo-image.test.mjs`（7 例）并登记进 `npm test`。

### 新功能（AI 会话图标状态点）

- 活动栏「AI 会话」图标现在带状态点，与 Git 图标的点同一视觉语言：按 **失败红点 > 审批类橙点 > 完成绿点** 的优先级取最高显示一个，颜色复用会话列表逐条状态点的 `--red` / `--orange` / `--green`。审批类涵盖等审批 / 等回答 / 等环境确认 / 计划待批准；运行中（转圈）不产生点，避免后台会话多时一直亮。
- 只统计**当前工作区**的非归档会话（与会话列表默认工作区口径一致）；未打开工作区不显示。完成绿点沿用现有「未查看」语义——只有真正切到那条会话才消，仅打开会话侧栏不消。
- 实现：`ai/ai-session-list.js` 新增纯函数 `aggregateSessionBadge`（env 注入判定，便于单测），`refreshBadge` 复用逐条 `sessionEntryStatus` 并随每次列表刷新推送，宿主 `main.js` 把 kind 映射成 `#ab-chats` 的颜色 class；工作区切换 / 面板初始化各补一次重算。配 `ai-session-list.test.mjs` 优先级 / 工作区过滤 / 归档 / 抑制 / running 忽略用例，全量前端测试通过。

### 修复（编辑区收起时打开便签无反应）

- AI 让位（或手动）收起编辑区后，若快捷便签标签页**本就是当前标签页**，再点活动栏便签按钮 / Ctrl+Alt+T / AI 的 `open_memo_panel` 都没有反应：`activateDoc` 对「doc === 当前 doc」早退、不走 `updateDocChrome`，宿主的 `onDocVisible`（`revealEditorForContent`）收不到通知，收起态解不开。现在早退分支同样通知宿主——「再看一次这份内容」的意图仍然解开收起（沿用既有判定：仅停靠分屏 + `editorExpandOnNewTab` 开；全屏/悬浮不动）。同一分支还覆盖「点已激活的标签页」等其他重激活入口。接线护栏补进 `ai-auto-collapse.test.mjs`。

### 新功能（计划批准卡支持 AI 申报命令清单）

- AI 提交计划（`submit_plan`）时可带 **`commands` 参数**主动申报执行期预计要运行的命令（如 `go test` / `npm test`，各带一句话用途）；计划批准卡合并列出**申报命令**（权威清单）与计划正文扫描出的命令（兜底），默认全选、可取消勾选，点「执行计划」后按勾选落本会话预授权——白名单开发命令仍按同类放行，白名单外的单条简单命令（含 `node scripts/x.mjs` 这类解释器跑脚本）退到**全文精确匹配**，旧会话无申报数据时退回纯正文扫描行为。
- 申报命令先经**静态预判**：危险命令（`rm -rf`、`find -delete`、解释器内联代码等）在批准卡上**红标展示但不预授权**——执行时仍逐次单次确认（「危险命令永不落会话规则」不变式不动）；管道 / 重定向 / 命令串联的复合命令灰显说明、同样不预授权。预判结果随 `submit_plan` 工具结果回传给 AI，可下轮修正申报；**完全权限档免审批，AI 不申报**（描述与计划模式守则双重约束），该档下申报直接丢弃。
- 实现：`ai/ai-command-rules.js` 新增纯函数 `normalizePlanDeclaredCommands` / `mergePlanGrantItems`；`session.activePlan.declaredCommands` 随会话持久化（`normalizeActivePlan` 白名单归一防脏）；批准卡 chip 三态渲染（可勾选 / 灰显 / 红标）在 `ai-takeover.js`，落规则复用 `acceptPlan` → `addCommandApprovalRule` 的 exact/family 双模式。配 ai-command-rules / ai-plan-file 测试扩展。

### 修复（AI 工具卡 diff 视图：四位以上行号被从数字中间截断）

- 编辑 main.js 这类 3000+ 行的文件时，审批/已应用卡的 diff 视图行号列显示成 `309`+`1` 两行——行号列固定 22px 只装得下 3 位数，`.ai-tool-body` 继承下来的 `overflow-wrap: anywhere` 允许词内断行，四位数行号（如 3091）就被从中间折成两行。现在行号列宽随整份 diff 的最大行号位数伸缩（新增纯函数 `diffNoDigits`，渲染端设 `--ai-diff-no-w` 变量，CSS 以 `max(22px, var(--ai-diff-no-w))` 消费），并加 `white-space: nowrap` 兜底——行号永不折行；少于 3 位的 diff 维持原 22px 基线宽不缩列。配 `ai-diff-view.test.mjs` 用例（4/5 位数撑开、删行看旧行号加行看新行号取最大、旧会话无行号字段退回行数）。

### 优化（工具卡：没有正文的卡不再摆折叠箭头）

- 「等待新输入 `{"timeoutSec":300}`」这类卡在执行中只有一个「执行中…」占位，却仍带折叠箭头——展开也只有那一行字，纯噪音。现在 `renderToolMessage` 的通用分支会判定**正文是否只有状态占位**：是则不建 `ai-tool-body`、不渲染箭头、点卡头也不做折叠 toggle（与读取卡 / 内置技能卡同一口径）。等它真出内容（如 `wait_agent` 等到结算）下一次渲染会自动带上正文与箭头。
- 顺带修卡头摘要：`wait_agent`、`agent_send/stop/compact`、`notify_send`、`session_*`、`start_timer/stop_timer`、`reminder_*`、`env_*` 此前落 `toolPrimary` 的 default，把参数 JSON 原样摆到卡头；现在各给一句人话（如「等待新输入 · 最多 5 分钟」）。MCP 第三方工具仍是参数摘要（来源不明，无法逐一映射）。
- 护栏：`ai-tool-cards.test.mjs` 新增两条源码断言（`statusOnlyBody` 必须同时收口 body / chev / 卡头点击，且 `wait_agent` 等工具有自己的 primary 分支）。

### 优化（文件树其余整树重建入口收口）

- 排查了除「刷新按钮」外所有会把整棵树丢掉重建的地方，把其中三处改成**保留展开态**：
  - **外部文件拖入复制完成**（`shell/app-actions.js`）之前调 `explorer.refresh()` 整树重建，改为只重读目标目录（`refreshDir`）并把该目录标脏（新增 `explorer.notifyDirChange`，列表模式靠它静默重扫）。
  - **`app_control reveal_in_explorer`**（AI 让文件树定位某路径）之前先 `explorer.refresh()` 再展开，会把用户已展开的目录全折叠；现在 `revealPath` 自己建树并对沿途逐层**强制重读**（新建的文件/目录也能找到），其它展开态与滚动位置不动。
  - **文件监听溢出**（`flushExternalChanges` 的 overflow 分支，git checkout / 大批量外部变更触发）之前直接 `tree=null` 重建，现在走 `rebuildTreeKeepingExpansion()`：先记录已展开目录集合，重建后逐层展开回去。
- 仍然保留整树重建的只有两处有意的：刷新按钮 / 右键「刷新」/ `app_control refresh_explorer`（用户显式要求重读），以及切换 / 关闭工作区（树根变了）。列表模式的重命名走 `invalidateList`（列表无展开态，重扫后恢复滚动位置）。
- 护栏：`explorer-reveal.test.mjs` 新增三条断言（复制收尾不得 `refresh()`、`reveal_in_explorer` 不得先 `refresh()`、溢出分支不得直接 `tree = null`）。

### 新功能（HTML 纯预览视图）

- HTML 文件现在和 Markdown 一样有**纯预览视图**（视图菜单 / 标签条视图按钮里的「预览」）：在内容区用 iframe 渲染真实页面，`<base>` 指向文件所在目录，同目录的相对样式、脚本、图片都能生效；sandbox 隔离与分屏预览同一套（`allow-scripts allow-forms allow-modals allow-popups`）。默认仍是代码视图，切换过来即可看效果，切回代码继续改。
- 复用既有分屏预览的渲染管线（`createHtmlPreviewView` / `renderHtmlPreview`），新增 `enterHtmlPreview` / `leaveHtmlPreview` / `showHtmlPreview` / `releaseHtmlPreview`；`preview` 模式名对 Markdown / HTML 按文档类型分派（`mode-switch.js`），关闭标签页时释放 iframe（`srcdoc` 清空 + 节点移除）。样式补 `.html-preview-active` 全屏覆盖规则。

### 修复（文件树删除后整树重建：闪烁 + 展开目录被折叠）

- 删除文件 / 目录后不再调用 `explorer.refresh()`。那是「点击刷新按钮」的全量重建（`tree=null` → 逐级重新加载），会把刚展开的目录全部折叠、滚动位置归零，视觉上就是文件树闪一下又缩回去。现在仅由 `removePath` 就地摘除该行，再把所在目录经 `notifyFileChange` 标脏走既有的 120ms 防抖差量刷新（列表模式靠它静默重扫）；展开态与滚动位置都保留。
- 护栏：`test/explorer/explorer-reveal.test.mjs` 断言 `performDelete` 里不得出现 `explorer.refresh()`、必须走 `notifyFileChange`。

### 优化（切换标签页不再抢文件树：对齐 JetBrains）

- 切换标签页只更新文件树的**当前行高亮**，不再展开目录、不再滚动定位——切标签时侧栏保持原样（`activateDoc` 调 `syncExplorerActive({reveal:false})`，`explorer.setActive(path, {reveal})` 按需选择）。显示侧栏、切换树/列表、切工作区仍会把当前文件摆到眼前。
- 新增侧栏标题栏**「定位当前文件」按钮**（靶心图标，`explorer.revealActiveFile()`）：随时主动把当前文件展开并滚进视野，替代原来「切标签就自动跳」的隐式行为。

### 新功能（AI 过程区「始终折叠」模式）

- 新增 **「过程区始终折叠」** 开关（默认关）：开启后思考链、工具卡与中间回复从流式开始就默认收起，只显示最终结果；想看过程点折叠头展开即可。关闭时行为与现状完全一致。设置 → AI 助手 → 界面，或面板头部「…」→ 显示方式里切换，两处双向同步。
- pending 审批 / AI 提问 / 计划批准（接管区）、已答提问卡、最终回答与改动汇总卡**不受折叠影响**，照常可见。手动展开过的轮次在轮次结束后回到默认收起。
- 实现：默认值判定收敛为纯函数 `ai/ai-always-collapse.js`（含 R1 护栏——始终折叠 + 流式仍预建折叠体 body，中途点开看到实时内容而非空白），配 `ai-always-collapse.test.mjs`（判定表 + 四处接线护栏）；设置项 `aiAlwaysCollapse` 走 localStorage。全量前端测试 + Vite 构建通过。

### 修复（上下文爆窗不再硬失败：条数上限改体积兜底 + 实测 usage 锚点 + 溢出自动压缩重试）

- **根因**：`aitransport.ValidateMessages` 有一条 `len(messages) > 1000` 的**条数硬上限**，而前端只有 token 门禁。长任务（几百个工具轮）里旧工具结果被 prune、过期注记被剔除，token 几乎不涨而条数照涨——某个会话在 1255 条时撞线，本地校验直接拒收整轮请求（校验在 goroutine 之前返回，日志里一条都不留），此后每次发送都是 1001 条、永久失败，只能手动 `/compact`。
- **解除条数上限**（与 opencode / pi / ZCode / cline / codex / deepseek-harness 一致：六者都不设 messages 条数上限，也都不设工具定义数量上限）：改为 `aiMaxRequestBytes = 128 MiB` 的**体积兜底**（正文 + 思考 + 工具参数 + 附件 base64），只拦不可能被任何服务商接受的请求；工具数量上限 128 一并移除，只保留「单条消息工具调用数 ≤ 128」的畸形历史防护。
- **压缩触发改用实测 usage 锚点**：`buildApiMessages` 产出 `{index, usage}` 侧信道，上下文占用 = 最近一条已发送 assistant 的真实 `usage` + 其后的增量估算（六份参照实现同口径）；`/context` 显示「实测锚点 A + 增量 B」。纯字符估算在工具 schema / 思考链 / CJK 场景系统性偏低，会出现「估算没到阈值、实际早已超窗」。
- **压缩保留按 token 预算**（与 deepseek-harness 的 `retainRatio` 对齐）：`(窗口 − 输出预留) × 16%` 取代原来的「保留最近 6 条」，切点仍回退到 user 轮边界；主会话与子代理共用同一内核（`compactRetainBudget` / `computeCompactCutoffByBudget`）。
- **新增上下文溢出恢复**：provider 报超窗时（`aiIsContextOverflowError`，措辞清单取自六份参照实现），先正常收尾本轮、等回合租约释放后强制压缩（`startCompact({force:true})`，跳过「估算 ≥ 窗口就不许压缩」的自锁），压缩完成自动重发本轮（不新增用户消息）；60s 内最多恢复 2 次，连续溢出改为提示切换更大窗口的模型。
- 验证：Go `aitransport` 单测（1500 条短消息不再被拒 / 超体积被拒 / 300 个工具不再被拒）、前端全量 **1547 项**测试、Vite 构建通过。

### 优化（会话右键菜单按上下文显隐 + 复制会话ID/路径）

- 会话右键菜单不再一排灰项凑数：**不适用的项直接不出现**——只有支线对话才显示「提升为独立会话」，信箱有积压才显示「清空信箱（N 条）」，内存/legacy 存储模式下不显示「复制会话路径」。菜单结构抽成纯函数 `buildSessionMenuItems`（`ai-session-list.js`），配 6 项测试。
- 新增**「复制会话ID」**与**「复制会话路径」**：路径由新绑定 `AISessionPath` 在 Go 侧只读解析（桶名是工作区短哈希，前端不复刻分桶规则），返回正文 `session.v1.jsonl` 的绝对路径；尚未落盘的会话提示「会话尚未落盘」而不是原始错误。

### 新功能（插件 AI 工具注册）

- 插件现在可以**给 AI 加工具**：`cadt.registerTool({name, description, parameters, readOnly?, timeoutMs?, execute})`。注册只是登记能力，**默认关闭**——须在 设置 → AI → 权限 → 插件工具 三层授权（全局总闸 / 插件级 / 工具级）后才下发给模型。声明 `readOnly` 的工具可额外勾「只读档可用」（默认关），让纯查询类工具在只读权限档也能用；声明只是候选资格，放行必须由用户确认。
- 执行走与 MCP 工具**完全相同**的审批链（同一 `decidePermission` 判定、同一张审批卡、按权限档与项目规则决定放行或转人工），计划模式一律拒绝，子代理默认看不到。工具对外名为 `plugin__<插件id>__<工具名>`，工具卡显示「插件 · 短名」，`<tool_catalog>` 按来源插件分组。
- **明示的限制**：审批只约束「AI 调用插件工具」，约束不了插件代码自己干活——插件与主界面同权限运行，加载即有执行命令与读写文件的能力。插件工具授权的作用是收窄 AI 的能力面，不是给插件加沙箱。安全模型与全部取舍见 `docs/finished-plans/plugin-tool-security.md`。
- 实现：纯逻辑在 `frontend/src/shell/plugin-tools.js`（命名解析 / 归一化与上限 / 三层授权与 readOnly 放行判定，配 9 项测试）；`plugins.js` 增 `registerTool` 并在重载时清空；`ai-tool-defs.js` 增 `pluginToolDefs` / `pluginToolCatalog` 两个注入口；`ai-panel.js` 增 `plugin__` 路由与 `executePluginTool`（授权复查 + 审批 + 超时）；`ai-permission-settings.js` 增三层授权渲染；`index.html` 增插件工具授权卡片；`ai-tool-cards.js` 增卡头兜底。验证：全量前端测试 + Vite 构建通过。

### 文档（用户协议与隐私协议重写至 v1.1.0 口径）

- `docs/legal/privacy.md` 与 `docs/legal/terms.md` 自 v1.0.0 的「纯本地查看器」表述更新为当前能力口径，最后更新 2026-11-19、适用版本 v1.1.0。隐私协议保留「软件自身不收集、不上传文件与使用数据、无埋点与崩溃上报」的核心原则，新增：**AI 对话会把文件内容 / 命令输出 / 工作区路径随请求发给你配置的模型服务商**（第 2.2 款逐项列出发送内容）、外部工具与生图视频的服务商去向、MCP、余额查询、端侧分类器离线、服务商密钥默认明文保存（建议改用 DPAPI 加密的环境变量）、本地数据全清单（含 `ai-config.json` / `ai-sessions/` / `ai-groups/` / 派生索引 / `activity/` / `wipe-guard/` 完整文件副本 / 浏览器 Cookie / 4xx 请求体转储）与**工作区 `.cadt/` 下会随仓库一并提交的数据**、12 行联网功能对照表。用户协议新增第 3 章（AI 与第三方服务：内容外发、生成内容不构成建议、费用与可用性）、第 4 章（AI 执行文件与命令的风险：已有多层保护、**脚本内部操作不受规则层约束**这一已知局限、wipe-guard 恢复受备份策略限制、不作安全保证）、第 5 章（插件与 MCP）、第 6 章（内置终端 / 运行代码 / 内嵌浏览器）。两份协议互相引用，端内仍经「帮助」菜单以**固定只读虚拟文档**展示（`app-links.js` 的 `openBundledDoc` 新增 `readOnlyFixed` 参数，用户协议 / 隐私协议传 true；不可解锁、右键不出现解锁入口、状态栏标「只读快照」，与审阅快照同一机制；更新日志仍可编辑）。

### 修复（插件设置导航：补折叠箭头与拼图图标）

- 设置侧栏动态插入的「插件设置」分组父项此前缺 `snav-chev` 折叠箭头，且引用的 `puzzle` 图标未在图标注册表登记（渲染为空白），整行只剩孤零零文字、夹在「插件」高亮行下很突兀。现于 `icons.js` 登记拼图图标（16 网格描边、主体 + 朝上/朝右凸头），动态父项与静态分组（AI 助手/格式/语言）同构：折叠箭头 + 图标 + 文字；图标改为创建时经 `iconSvg` 直接内联填充——原 `data-icon` 注水只在设置弹窗打开时跑一次，动态节点晚于注水会永远空白。「没有任何插件注册设置面板时整组不显示」的行为此前已存在（`setupPluginSettingsNav` 空表即移除），未改动。

### 新功能（插件命令入口矩阵）

- `cadt.addCommand` 新增 6 个可选字段（全部向后兼容）：`icon` / `description` / `category` / `contexts` / `when` / `shortcut`。插件命令不再只出现在「工具」菜单——可进编辑器右键菜单（`contexts: ['editorContext']`）、按分组进命令面板、按条件变灰（`when`）、绑定快捷键（内置键位优先、对话框与输入框内不触发）。`run(env)` / `when(env)` 收到只读上下文快照（`hasFile` / `formatId` / `hasSelection` / `readonly` / `workspace` / `editorFocused`）。
- 实现：纯逻辑在 `frontend/src/shell/plugin-commands-model.js`（声明归一化 / 入口归属 / when 安全求值 / 快捷键命中，配 10 项测试）；`plugins.js` 的 `addCommand` 改走归一化；`main.js` 接线工具菜单筛选、命令面板按分类分组、全局快捷键分发；`editor-menus.js` 只展开宿主注入的菜单项，保持 editor 域不依赖插件域。验证：全量前端 **1494 项**测试通过、Vite 构建通过。

### 新功能（内置终端：链接识别与打开）

- 终端里的 http/https 链接（如 dev server 输出的 `http://localhost:5173/`）**hover 显示下划线 + 手型光标**，**Ctrl/Cmd+单击用系统默认程序打开**；普通点击不动作，不干扰选区。零新依赖：用 xterm 的 `registerLinkProvider` 自写检测（`src/terminal/term-links.js` 纯函数 + 配测试）——支持被软换行拆开的长链接跨行拼接、尾巴标点/未配对括号修剪、**宽字符（中文）按 cell 列换算**（字符串偏移 ≠ cell 列，逐 cell 建映射）；应用经 OSC 8 转义序列发的真链接（`linkHandler`）也统一走 Ctrl+单击语义，替代内置的 confirm 弹窗。

### 新功能（模型账号手动排序）

- 设置 → AI → 模型 账号卡片支持**拖拽排序**（手柄 + JetBrains 式让位插槽）与**上移 / 下移按钮**兜底；顺序写入配置持久化，重启后保持，输入框账号下拉同步。
- 实现：`ai/ai-model-settings.js` 新增 `moveProfile` + `setupCardDrag`；`style.css` 补手柄 / 让位插槽样式。零新增字段、零 Go 改动。

### 新功能（子代理标签页显示父代理信息）

- 子代理详情标签页的 tooltip 与详情视图头部现在显示**父级面包屑**（嵌套时显示父代理名，顶层时显示所属会话标题）与**嵌套层级徽标**（第 N 层）。
- 标签栏里嵌套子代理（depth>1）名字前加 `↳` 层级记号，与顶层派单一眼区分。
- 实现：`ai/ai-agent-view.js` 新增 `agentParentInfo` 纯函数，`openAgentView` 算好 `parentLabel`/`depth`/`task` 传入 spec；`bridge/bridge-agent-view.js` 透传三个字段；`editor/editor-groups.js` `tabTooltip` 对 `doc.agentView` 多行显示父级与任务摘要，`buildGroupTab` 加嵌套记号；`style.css` 补面包屑 / 层级徽标 / 标签嵌套记号样式。

### 修复（新建会话无法落盘：session-gone 死循环）

- **新建会话保存失败**（「上一次会话保存失败，暂不能开始新回合：session-gone」）：ed23473 给 append 加 allowCreate 透传时写成了 `!session._logCreated`——而同一次 persist 里 header unshift 已先把它置 true，新会话的**首次落盘**也被当成「已有会话的扇出写」（allowCreate=false），目录缺失 → session-gone → 状态回滚 → 每轮重试同样失败。修复：改用进门时的快照 `state.logCreated` 判定（新会话首落盘=true 允许建目录；已有会话追加=false 不许复活目录，保留 ed23473 的防复活语义）。新增回归测试钉住两态。该 bug 与会话分桶迁移无关（平铺布局下同样会炸），由同日 00:10 的提交引入。
### 修复（AI 限流提示人话化 + 等待期不再谎报「正在思考」）

- **限流重试提示友好化**：状态条重试提示由「HTTP 429 · 17576.5 秒后重试 1/8」改为「服务商限流 · 约 4.9 小时后重试 1/8」——Go 侧的原始 reason（HTTP 429 / 网络错误）进 UI 前经 `friendlyRetryReason` 翻译（`ai/ai-terminal-tools.js` 新增纯函数），等待时长走 `formatWaitDuration` 秒档取整（「42 秒」而非「42.0 秒」，倒计时不再每 100ms 重写小数秒文案）；群聊成员气泡的重试状态同样翻译。
- **等待期占位不再误导**：思考卡占位条件改为「有思考内容，或正文尚未开始」——429 重试 / 本地限流排队期间（可能长达数小时）显示「等待模型响应…」而不是「正在思考…」；不思考的模型正文一开始流式就撤掉占位卡，与轮结束时的移除口径一致（`ai-tool-cards.js` `updateAssistantElement` + `aiThinkLabel`）。

### 修复（内置终端：渲染错位与选区复制）

- **渲染错位/重绘残留修复（根因：PTY 尺寸从未同步）**：此前 ConPTY 永远停在创建时的 80×24——前端只 fit xterm 自己的行列，Go 侧 `TermResize` 从未被调用，shell 按 80 列输出/重绘、xterm 按面板实际宽度渲染。现在 xterm 每次适配面板后自动把行列同步给 PTY（防抖 120ms，覆盖面板拖高 / 窗口缩放 / dock 视图切换），提示符错位、重绘残留、全屏程序（TUI/进度条）显示混乱随之修复。
- **首屏输出不再丢失（创建期竞态）**：Go 在 `TermCreate` 返回前后就开始推 `term-out` 事件，前端注册会话前先到的事件原先被静默丢弃——banner/首提示符残缺，转义序列被拦腰截断会一直乱下去。现在未注册会话的输出先暂存（单会话上限 256 KB），挂上 UI 后按序回放。
- **跨块中文字符不再变乱码**：Go 侧按 4 KiB 分块读 ConPTY 输出，跨块截断的多字节字符此前被逐块 `ToValidUTF8` 替换成 U+FFFD；现在块尾不完整序列攒住与下一块拼回再解码（`utf8IncompleteTail` 纯函数 + 表驱动测试）。
- **终端复制/粘贴**：选中内容后 `Ctrl+C` 即复制（无选中照常发 `\x03` 中断前台程序，Windows Terminal 语义；`Ctrl+Shift+C` 同复制），`Ctrl+Shift+V` 粘贴；终端区域右键菜单新增复制 / 粘贴 / 清屏，不再弹 WebView2 默认菜单。按键分流抽成纯函数 `src/terminal/term-keys.js`（`termKeyAction`，配测试）。
- 顺带修掉**终端页签**右键菜单一打开就抛 ReferenceError（引用了未定义的 `terminalUI`），页签的 新建 / 重命名 / 清屏 / 关闭 菜单恢复可用。

### 修复（工作区防护：只计真删除 + 止血按工作区收窄 + 告警文案不再引用内部文档）

- **治本口径：删除计数只认「消失」类事件**。Go 侧 `internal/watch` 解析 `ReadDirectoryChangesW` 的 action（`watchEvent.Removed` = FILE_ACTION_REMOVED / RENAMED_OLD_NAME），`workspace-changed` 事件新增 `removed` 数组；前端 wipe-guard 只消费 `removed`。此前把 added/modified 也计成删除，补丁应用 / worktree 大改动回灌（六七十个文件）会二次误报——现在合法写入零计数，真删除照旧秒级命中。
- **止血与熔断按工作区收窄**（原为「停全窗口所有会话」，误报时把别的后台会话一起陪葬）：critical 只停挂在被告警工作区上的生成与子代理（`wipeguardStopForWorkspace` / `wipeguardIsAIActive(root)`，workspace 为空的会话保守一并停）；熔断 `isWriteBlocked(root)` 按工作区匹配，只拦被告警工作区的 write_file / edit_file，下一回合解除。
- **告警文案去除内部文档路径**：用户弹窗原文案引用了 `docs/reports/...` 开发者文档——改为指向应用内出口（设置 → 存储与清理 → 工作区防护）。开发者文档路径只属于方案文档与日志。
- **告警通知可点击直达**：critical 通知带 actionId（复用消息中心 `runAction` 分发，同更新对话框机制），点击后打开 设置 → 存储与清理 并滚动到「工作区防护」区块、短暂高亮定位。
### 修复（工作区防护：补丁应用被误判为大范围删除）

- **根因与修复**：补丁应用（7 文件回灌主根）把 AI 面板连弹三条「疑似大范围文件消失（41/55/55 个文件被删除）」——全是误报。两个叠加缺陷：① 原子写与补丁写入的**临时文件**（`*.tmp.<pid>.<hash>` / `.cadt-patch-*.tmp` / `*.lock`）在 temp→rename 半程的「消失」被 watcher 当成删除计数，一次 7 文件补丁能堆 40+ 条直接爆 40 阈值——按 basename 形态排除出删除窗口；② ReadDirectoryChangesW 对一次 rename 推多条 action，同一路径重复计 4-5 次——窗口内同路径去重，量级回到真实值（41 条 → ~10 个文件）。
- 实现与用例都在纯函数层（`ai-wipeguard.js` 的 `wipeGuardSkipPath` / `registerDeleteEvents`，+2 用例）；构建产物目录的两级排除（vite/wails 清 dist 是合法 churn）此前已修，本次不重叠。丢弃隔离树（`.cadt/worktree` 前缀）本就被 Go watcher 过滤，与本误报无关。
### 修订（工作区防护：砍掉诱饵文件，工作区保持零足迹）

- **canary 诱饵整个砍掉**（作者裁定：工作区文件洁癖，应用不得在工作区自建任何文件）。诱饵落地首日还暴露了自身缺陷：幂等检查用「随机 token 文名 + Stat」，token 每次重生成 → 文件名每次不同 → 检查永远 miss，每调用一次就在每个布点新增一个诱饵（本仓库一天积到 297 个）；布点含 `build/` 等构建目录，被构建链清理就弹「疑似大范围文件消失」。防护灵敏度不受损：对 2026-11-18 事故形态（`find . -delete`），watcher 数量阈值（40/10s）秒级命中，关键标记（`.git`/`go.mod`/`package.json`）消失与顶层清空由结构指纹兜底——canary 的边际价值≈0。实现与设置开关一并移除（`canary*.go` / `WipeGuardEnsureCanaries` 绑定 / 前端 canary 通道 / 「诱饵文件」开关行），已撒出的诱饵文件可随时手动删除（应用不再重建）。
- **watcher 删除计数排除构建产物目录**（保留的独立修复）：`dist`/`build`/`out`/`target` 等（含二级路径如 `frontend/dist`）不计入 40 阈值窗口——vite/wails 清产物一轮就有几十个删除事件，属合法 churn。

### 新功能（工作区破坏防护：写前快照 + watcher 检测）

- **AI 造成的工作区破坏从此有「事前副本 + 秒级发现 + 手动恢复」三道兜底**（源自 2026-11-18 整仓被清空事故）：`write_file` / `edit_file` / 补丁应用在落盘前把原文件存进应用数据目录的内容寻址备份库（重复内容去重、恢复前 sha256 复核）；工作区 watcher 实时检测大范围删除（10 秒内 ≥40 条删除即告警），AI 活跃时自动停止生成并熔断本轮后续写命令（下一回合自动解除；空闲时段只提醒不误停）；有 git 的工作区每 10 分钟出一份自足归档快照（还原不需要 `.git` 存在），无 git 的小工作区走增量去重快照。
- 检测两信号：watcher 滚动删除计数（内核级、子进程可见——这是主信号；`git gc` / `node_modules` / 构建产物目录等合法 churn 已排除）+ 结构指纹（命令前后与每 10 分钟校准，判定阈值单一来源在 Go）。工作区零足迹：不在用户项目里创建任何文件。备份根默认 `<应用数据>/wipe-guard` 并套 deny-delete ACL（子进程 `rm -rf` 备份目录直接失败）；可自定义到其他盘（校验拒绝指进工作区内部）。
- 恢复出口：设置 → 存储与清理 → 「工作区防护」区——开关组（全部默认开）+ 按文件分组的备份时间线（一键还原，危险确认）+ 快照清单 + 风险明示（无 git 大项目固定提示「批量删除无法自动恢复」）。备份清理条目**刻意不进「一键清缓存」**（例行清缓存不能拆保险）。
- 实现：`internal/wipeguard` 新包（fingerprint / backup / snapshots / ACL 平台对），`wipeguard_app.go` 挂 12 个 `WipeGuard*` 绑定；补丁写入点经 `patch.OnWriteBackup` 包级钩子顺手持久化；前端 `ai/ai-wipeguard.js` 检测控制器 + `settings/settings-pane-wipeguard.js` 恢复出口；`ai-panel.js` 写路径接线（备份 + 熔断 + 命令前后指纹保底）。工作区短哈希与 AI 会话分桶同一约定（测试向量两端共享）。验证：Go 单测（含 icacls ACL 集成、git 快照端到端、1000 行并发追加）+ 前端 25 项新用例，全量通过。方案与业界对照见 `docs/finished-plans/workspace-wipe-guard.md`。

### 新功能（AI 会话按工作区分桶存储）

- AI 会话磁盘存储从 `<应用数据>/ai-sessions/` 全平铺改为**按工作区分桶**：`ai-sessions/<工作区短哈希>/session-<id>/`，桶名 = 归一化工作区路径（反斜杠归一、去尾斜杠、小写）的 sha256 前 8 hex（与 workspace-wipe-guard 方案的 `ws` 字段同一约定），无工作区的会话落 `_unbound` 桶，桶内 `ws.json` 记录工作区原路径（资源管理器里可读）。存量会话由作者手动迁移（`tools/migrate-session-buckets` 一次性工具，应用关闭后执行），程序不做启动迁移、不向前兼容旧布局。
- 实现：`internal/sessionstore` 新增 `NewBucketed`（opt-in，`aigroups` 复用同一引擎仍按 groupId 平铺）与 `WorkspaceBucketKey`；目录解析按 id 扫桶（现存目录永远赢，workspace 不参与），新会话从首行 header 解析归属落桶，附件落盘（`AISessionSaveImage/SaveVideo` 新增 workspace 参数——新会话带附件时图片先于正文 header 落盘，归属只能由调用方传入）收敛到同一目录；非创建路径对缺失会话照旧报 `session-gone`。侧边栏分组 / 串台护栏 / 派生索引 / 存储清理全部走 meta.workspace，零改动。
- 哈希向量两端各锁一遍（`sessionstore_test.go` ↔ `ai-session-scope.test.mjs`）：`aiNormalizePath`/`aiWorkspaceKey` 从 ai-panel 移出到 `ai-session-scope.js`（ai-panel 经 import 别名沿用原名）。

### 修复（AI 实时瘦身 · 轮次口径与修剪加固）

- **注入类消息不再挤占上下文保留窗口**：实时瘦身此前把「所有非 systemNote/steer 的 user 消息」都算一轮——信箱折叠通知（子代理结算 / 计时器到点 / 终端退出 / 会话投递）、后台唤醒轮、工具中途自动附加的图片/视频（read_image / 截图 / generate_image review）都会被误计为新轮，把「保留最近 2 轮原文」的窗口往前挤、裁掉连续任务里仍在用的上下文。现口径收紧为「只有用户亲手键入的消息才算一轮」（systemNote / steer / notice / app 四类注入一律不计），长自主过程整段保留；`notice` 标记补进 JSONL 重放归一（此前重启后丢失，靠 app 标记兜底）。
- **大工具结果修剪加固**：run_command / background_command 的尾部保留预算 1024 → 2048 字符（失败统计不一定压在最尾，结尾可能是长堆栈）；修剪标记明确「不要凭记忆引用被修剪的中段内容，如需完整内容请重新调用该工具获取」。
- 实现：判定抽成纯函数模块 `frontend/src/ai/ai-context-slim.js`（isRealUserTurn / recentTurnStart / pruneToolResult），`buildApiMessages` 改用；新增 `ai-context-slim.test.mjs` 12 条用例锁住轮次口径与修剪预算。瘦身仍只裁组装视角，会话历史原样保留。
- **上下文浮层「实时瘦身已省」分类自解释**：记账按类拆分（旧轮思考 / 重复注入 / 过期注记 / 工具结果中段），明细显示在该行的 ⓘ tooltip 第一行（如「本次剔除：旧轮思考 26K · 工具结果中段 84.5K」）——「省了多少」不再是一个看不出构成的笼统数字，构成按需展开、不占版面。
- **上下文浮层与状态栏角标口径对齐**：角标 / auto-compact 此前已切到「provider 实测用量锚点 + 增量估算」，浮层头部仍是纯字符估算，CJK 重的会话会出现「浮层 30%、角标 39%」两张皮。现在浮层头部总量与百分比与角标同源，系统提示词/工具定义/对话消息三段图例按估算占比等比缩放到锚点总量（分段之和 = 头部总量）。

### 新功能（插件能力：后台服务托管 + 专属设置页）

- 插件系统新增三项能力：`cadt.registerService()` 声明后台服务（软件统一负责开机自启、健康检查、退出时杀整棵进程树、日志环形缓冲）、`cadt.registerSettingsPanel()` 注册插件专属设置页（设置 → 插件设置 下独立导航项）、`cadt.getPluginDir()` 返回插件安装目录。服务声明只在内存里，插件禁用/卸载后自动停止并移除，不写配置文件。
- 实现：Go 侧新增 `internal/appservices` 引擎（复用 `procctl` 进程树取消 + `executil` 防黑窗），`appservices_app.go` 提供 6 个 Wails 绑定，退出清理接 `app_window.go` 的 `beforeClose` / `ForceClose`；前端新增 `plugin-services.js` / `plugin-settings-panels.js`，`loadPlugins` 在插件重放后统一 `AppServiceSync`，设置页动态建面板导航（仿格式子页范式）。
- 随仓库分发的 `plugins/zcode2api/` 升级到 v1.1.0：把 zcode2api 反代作为后台服务交给软件托管（自动拉起 + `/v1/models` 探活），带专属设置页查看状态/日志/启停/装依赖，反代源码放进插件的 `server/` 子目录即可。验证：Go 单测 + 前端新增 2 个测试（全量 1438 项）+ Vite 构建通过。方案见 `docs/finished-plans/plugin-background-services.md`。

### 群聊（G6 面板化重构）

- **群聊接管 AI 面板，不再开内容区标签页**：左侧「会话 | 群聊」列表点开即右侧聊天窗；点会话自动回会话视图，讨论在后台继续。面板头显示群名与轮次；更多菜单新增「群聊」子菜单（切群 / 新建群聊）。`doc.groupChat` 虚拟标签页退役。
- **QQ/微信群式聊天窗重做**：成员左气泡（彩色首字头像 / 主持人描边 / 连续消息合并 / hover 复制与 @TA）、用户右气泡、日期与轮次分隔、系统灰条、失败/超时小状态行（修掉整条失败消息变红字的类名冲突）；贴底跟随复用 `ai-scroll-follow`（用户上翻不抢滚动，「回到底部 · N」未读按钮）；输入区 Enter 发送 / Shift+Enter 换行 / 自动增高 / `@` 成员补全（紧跟文字也触发，↑↓/Enter/Tab/Esc 键盘操作）；流式打字气泡固定队尾；讨论控制收敛为「开始讨论/暂停/继续」主按钮 + ⋯ 菜单（结束并总结 / 压缩 / 润色 / 导出纪要 / 群设置），看板改为右侧覆盖层（修掉「N 次发言」计数冻结的早退 bug）。
- **轮次预算放宽（回应「说几句话就没了」）**：`maxRounds` 从 1–3 扩到 0–20（0 = 不限轮次、手动结束），默认 5；发言上限不再固定 12，按「成员数 × 轮数」自动推导（12–200，群设置可改）；整场上限 15/30 分钟 → 60/120 分钟；看板「请求发言」补归一化持久化（重开不丢）；侧栏最近消息预览随消息落盘写入 meta。
- **成员详情标签页（像子代理）**：`doc.groupMember = groupId:agentId`（独立上限 8 个）——实时流 / 上下文占用 / **私有过程（仅你可见，按发言对齐折叠）** / 发言记录（轮次 / 立场 / 首字耗时 / token），动作：请发言（可带焦点）/ 静音 / 停止 / 打开群聊；点群聊消息头像或名字即开。
- **@ 成员胶囊（QQ 式）**：弹层选中后输入框里 @名字 变成胶囊——文本仍是纯文本（复制 / 粘贴 / 选区不受影响），Backspace/Delete 命中整颗删且可撤销（execCommand 参与原生撤销栈），改坏名字自动溶解；手打 @合法成员名 也会自动成胶囊。实现为真实 textarea + 同度量镜像层（守住表单控件硬规范），纯函数 `scanMentions` / `buildRichHtml` / `expandDeletionRange` 配测试。
- 新模块 `ai-group-ui-model.js`（视图纯函数 + 测试）/ `ai-group-member-view.js` / `bridge-group-member-view.js`；删除 `bridge-group-view.js`。前端 1427 项测试与 Vite 构建通过。


### 修复（端侧分类器 · 语料与金丝雀按线上口径重建）

- **训练改为按段打标签**（`scripts/train-local-classifier.mjs` + `scripts/classifier-corpus.mjs`）：线上是「切段 → 逐段打分 → 取 max」，训练此前是整条命令一个特征向量。后果不只是「前缀稀释危险信号」，更糟的是**反向污染**——合成样本整条标 y=1 时，前缀里的 `grep -rn error` 之类安全 n-gram 被一起推向危险侧（实测重训后 `grep -rn error logs` 涨到 **0.722**、直接误拦）。现在每个样本展开成段、按段给标签（前缀 y=0 / 危险段 y=1），训练与推进口径一致。
- **语料补「形态」**：危险类此前**零**良性前缀（safe 侧 cd 16% / `| tee` 12.8% / `FOO=` 9.8%），模型能学到的唯一规律就是「带前缀 = 安全」——这才是 `git log …\r…\rformat C:` 曾压到 0.0165 的根因。现补：前缀链 20%（覆盖 `&&` / `;` / CR / LS / NEL）、长洪泛 4%（200/800/1900 字符）、中文良性/破坏成对模板（宾语刻意错开）、裸命令密度 10%、侦察族（`reg query HKLM\SAM` / `vssadmin list` / `git config --global`）、ACL 授权族、环境变量写入族、`docker prune`、`npm run <script>`。样本量 400/400/130 → 1200/1200/400，每族从 7 条提到 12+ 条才稳得住边界。
- **验收口径改为线上口径**：`evaluate()` 从整条打分改 `lcScoreCommand`（分段取 max）。此前公布的「安全放行率 0.94」是整条口径，线上真实值 0.892——差约 6 个百分点。
- **金丝雀分三层**（`CANARIES` / `ADVERSARIAL_CANARIES` / `REGRESSION_CANARIES`）：`plain` 是记忆层（34 条里 10 条与训练语料逐字重复，只能防权重跑飞）；`adversarial` 考泛化（CR/NEL/LS/PS 链、48 段链、侦察/持久化、中文）；`regression` 钉住本轮修掉的每条绕过。三层都硬性阻断权重产出，前端 `ai-local-classifier.test.mjs` 读同一份清单守门。
- **结果**（出厂 `factory-2026-11-18-1`）：安全标准档放行 0.892 → **0.99**（严格 0.87 → 0.94）；标准档误放 0；硬危险宽松档误放 0；对抗层金丝雀全过。`reg query HKLM\SAM` 0.0328 → **0.9342**，`vssadmin list shadows` 0.0361 → **0.9825**，`git config --global include.path` 0.1246 → **0.9950**，中文 `删除所有文件并且清空磁盘` 0.0893 → **0.7581**，良性 `ls -la` 0.041 → **0.0006**。
- 插件侧：`verify.mjs` 金丝雀改走分段口径并与主仓库共用清单；`train-head.mjs` 改按段训练（含嵌入缓存）。语义头重训**未达门槛**（标准档误放 3 / 硬危险 6 / 安全放行 87.7%），脚本拒绝产出、`head.json` 保持 `head-2026-11-14-1`；因此插件闸门分硬性（plain 全层 + dangerous 层）与 `watch`（safe/gray，如实打印不阻断）两档，待语义头换更强多语嵌入后收紧。

### 新功能（生图与视频 · 配置导入导出）

- 设置 → AI → 生图与视频模型 新增「导入 / 导出配置」：导出只含生成条目（`genModels[]`），不夹带模型账号、偏好、提示词等其它 AI 配置；默认不含 API Key，勾选「含密钥导出」才写明文（文件请妥善保管）。导入接受本面板导出的 JSON 或裸 `genModels` 数组，默认按 id 合并（同 id 覆盖、文件里空密钥不冲掉本地密钥、其余条目保留），勾选「替换全部」则整体替换（有二次确认，不可撤销）。条目统一走 `normalizeGenModels` 校验归一，坏 JSON / 缺数组 / 无有效条目给出明确报错。
- 实现：纯函数在 `frontend/src/ai/ai-gen-model.js`（`buildGenConfigExport` / `parseGenConfigImport` / `mergeGenConfigImport`），UI 接线在 `ai-gen-settings.js`，按钮与开关在 `index.html`（开关用标准 `.set-switch` 结构，符合表单控件规范）。验证：`ai-gen-model.test.mjs` 新增 3 条用例，表单控件基线与测试清单守卫通过，Vite 构建通过。

### 新功能（Shift+Esc 关闭底部面板）

- 底部面板（终端 / 调试控制台 / 运行 / Git 图谱共用容器）打开时按 **Shift+Esc** 即收起整个面板，对齐 JetBrains「关闭工具窗口」语义；面板未打开或对话框打开时不拦截该键。三套快捷键风格（CandySweet / IDEA / VS Code）统一绑此键——调研确认 VS Code 默认把 Shift+Esc 用于「面板最大化」（`workbench.action.toggleMaximizedPanel`），本应用无该动作，故不冲突（VS Code 关闭面板是 Ctrl+J）。
- 实现：快捷键注册表 `frontend/src/core/keybindings.js` 新增 `view.closeDockPanel`，全局按键链 `frontend/src/main.js` 查表分发并调用 `toggleTerminalPanel(false)`；设置页快捷键表自动出现该条。护栏 `core/keybindings.test.mjs` 钉住三套风格键位与真实分发。

### 修复（端侧命令分类器 · 红队验收落地）

- **换行族分隔符统一**（`frontend/src/ai/ai-local-classifier.js` 的 `lcSegment`、`frontend/src/ai/ai-command-rules.js` 的 `splitCommandSegments`）：切段正则补单独 `\r`、NEL(U+0085)、LS(U+2028)、PS(U+2029)，且**在原始文本上切**（先 NFKC 会把它们折成空格，反而丢失分隔）。危险门此前遇 `\r`/`\n` 直接返回 null、退化成只有 4 条原文兜底——等于**任何多行命令都跳过整套段级检测**：`git log …\rgit diff --stat\rformat C: /y` 实测线性 0.0165（三档全放行）+ 危险门 PASS；修复后危险门命中 `disk-destructive`、线性 0.9853、真实 ONNX 模型 0.9989，全部转人工。
- **分段失败兜底补全**（`ai-command-rules.js`）：原文兜底此前只有 rm / git 四条，现补 `format` / `shutdown` / `Remove-Item -Recurse` / `del /f /s` / `rmdir /s` / `dd of=/dev/` / `bcdedit` / `diskpart clean` / 分开写的 `rm -r -f`，并让分段失败时也跑完整 `RAW_DANGER_RULES`。修掉「`echo hi > /dev/null && format C: /y` 危险门全空、只剩模型兜」。
- **插件畸形 score 不再当 0 分**：`classifyOne` 改严格 `typeof result.score === 'number' && Number.isFinite(...)`——`Number(null|''|[]|false)` 都是 0，旧校验会把坏插件静默降级成线性单票（不熔断、不计失败、不告警）。
- **学习护栏改查脱敏前原文**：脱敏正则 `[^\s"']+` 会把紧跟秘密字面量的结构 token 一起打码（`echo password | sh` → `echo password *** sh`），管道落地壳消失导致 `LC_LEARN_DENY_PIPE_SH` 失明；脱敏从此只用于落盘，判定一律看原文。
- **ONNX 插件 48 段静默丢弃**（`cadt-plugin-command-classifier-onnx`）：去掉 `si < 48` 硬上限，改为段数 >512 直接 fail-closed（`truncated` → 转人工）；分隔符与线性对齐（换行族 + `(?<![>&])&`）。同时构建脚本模板改 `String.raw`、加产物 `new Function` 语法自检——HEAD 提交的 `dist/worker.js` 曾因 `\n` 被解释成真实换行而**语法错误**，语义模型整体不运行。
- 验证：`ai-local-classifier.test.mjs` / `ai-command-rules.test.mjs` 新增换行族切段、危险门兜底与只读口径回归（全量 1406 条，仅 1 条与本次无关的 memo 用例失败）；真实 22 MB 模型复核：48 段良性 + `rm -rf /` 从 0.000 变 1.0000，600 段走 fail-closed，良性 `ls -la` 仍 0.0000。

### 修复（AI 请求排队提示 · 区分本地限流与服务商配额冻结）

- **`ai-queue` 事件新增 `kind` 字段**（`rpm` / `frozen`，`internal/aitransport/ratelimit.go`）：此前两种性质完全不同的等待共用一句「RPM 限流」文案——本地滑动窗口满最多等 60 秒；服务端 429 的 `Retry-After` 回灌出的冻结期可能长达数小时（实测一次 35,517.8 秒 ≈ 9.9 小时）。后者被显示成「RPM 限流」会让人误以为是请求太密而去删请求，实际只能等配额恢复。
- 前端文案分开：本地排队 →「排队中 · 约 42.0 秒」；429 冻结 →「服务商配额已用尽 · 约 9.9 小时后恢复」。等待时长改用新纯函数 `formatWaitDuration`（秒 / 分钟 / 小时三档），不再把 35517.8 秒直接摆给用户；群聊运行时同步区分（「排队等待限流…」/「服务商配额已用尽，等待恢复…」）。
- 排队原因会变（冻结到期后仍可能卡在 RPM 窗口），`kind` 变化时重发事件，提示不会一直停在「配额用尽」。
- 验证：`ratelimit_test.go` 新增 `TestFreezeReasonIsFrozen` 与 rpm 原因断言；`ai-terminal-tools.test.mjs` 覆盖 `formatWaitDuration` 三档与非法输入。

### 新功能（AI 命令 · 可选 shell / 脚本审批三层）

- **`run_command` / `background_command` 新增 `shell` 参数**（`gitbash` / `pwsh` / `powershell` / `cmd`）：缺省行为不变（Git Bash → PowerShell 7 → Windows PowerShell → cmd）；显式指定后命令直接交给该 shell，不再经 bash——修掉「在默认 Git Bash 档里写 `powershell -Command "…"` 时，双引号内的 `$变量` / `$_` 被 bash 先展开、PowerShell 收到残缺脚本」的老问题。本机没装指定 shell 时直接报错、不静默回退（静默回退正是「以为在 bash 其实不是」的来源）；子代理的沙箱档请求 Git Bash 也明确报错（Cygwin 在受限令牌下起不来）。Go 侧 `aiShellInvocation` 与四个绑定加尾参，命令卡片与审批卡如实显示 shell 名。
- **脚本档审批三层**：① 新增 PowerShell 破坏特征表（`ai-command-rules.js` 的 `psScriptDanger`）**全文**扫描——删除 / 移动 / 改名、写文件与重定向、`iex` / 调用操作符 `&` / 点源、服务·计划任务·注册表·账户·ACL、磁盘、反射（`[IO.*]`、`[System.*]`、`Add-Type`）、关机、日志清理，含 `ri` / `gci` / `sc` / `-OutFile` 等别名与简写，命中即单次确认；② 端侧分类器对脚本**只拦不放**（判「安全」也不放行，且不把它的结论注入 AI 提示词）；③ AI 分类器 `allow` 才自动执行，未开启则转人工。默认档（不传 `shell`）行为零变化，只读判定 / 会话授权 / 命令族 / Git 快捷豁免在脚本档一律不作数（否则等于用新参数开降级审批的后门）。
- 同步：工具描述（`run_command` / `background_command`）、系统提示词守则（改用 `shell="pwsh"` 而不是拼 `powershell -Command`，环境变量说明补 PowerShell 的 `$env:名称`）、README 对应小节。护栏：`ai-command-rules.test.mjs` 钉住 24 条破坏样本与只读样本的误报基线，Go 侧 `TestAIRunShellCommandExplicitShellKeepsDollar` 覆盖多行 + 双引号 + `$变量` 原样送达。

### 新功能（多实例同步 · 资源写权租约）

- **新包 `internal/resourcelease`**：跨进程写权租约——per-key refcount（同进程面板 + AI 工具 + 后台任务不会自锁）、共享/独占模式、`owner` 提示文件、`Probe`、`AcquireNoShare`（删除/清理用，本进程有任何 ref 也拒绝）。底层复用 `internal/sessionlock`，并补了 `TryLockFile` / `TryLockFileShared` / `ErrLocked`；锁文件放在被保护目录**之外**，目录被删除/移动/回收不会出现“新目录新锁文件”的双写者。
- **快捷便签改为单写者**：打开面板即取写权，第二个窗口只读并在顶部显示“另一窗口正在编辑（PID）”；关闭编辑窗口的面板后，另一窗口在 focus/watch 时自动接管并重读。全局便签新增目录 watch；`memo.Save` / `SaveImage` 在 Go 侧也做同一把锁兜底，AI 的 `add_memo` / `update_memo` / `remove_memo` 在面板未持锁时用短租约、拿不到就报忙。mtime CAS 保留为外部手改/异常路径的兜底；`SaveResult.Busy` 与 `Conflict` 分开，busy 不再删缓存丢本窗口内容。
- **AI 会话改为回合锁**：同一会话同时只允许一个回合（根门闩共享 + 会话独占）；打开/阅读不受限，第二个窗口发送会明确提示“另一窗口运行中”。新回合拿锁后按日志 `{mtime,size}` 做交接检查，另一个窗口写过就**先整份重读再改内存**，避免 retry/edit 的 truncate 截掉对方消息；终态写盘（`whenIdle`）完成后才释放，失败则保持锁并提示。
- **写路径兜底与清理保护**：`sessionstore` 的 append/rewrite/meta/图片/视频写路径统一取“根共享 + 会话独占”短租约；`persistSessions` 的扇出写遇到别的窗口正在跑的会话会跳过而不是覆盖。`AISessionDelete` / `AISessionDeleteAll` / 存储清理 `ai-sessions` / `memo` / `ws-memo` 都先取对应门闩，busy 时拒绝清理；存储清理通过注入钩子接入，不改 `internal/storage` 的条目表。
- **刷新**：新增 `resource-changed` 事件与 `internal/watch.ResourceWatcher`；全局便签 watch、当前 AI 会话目录 watch（流式消息不落盘，租约空闲后重读），watch 到的会话变更同时异步给派生搜索索引标脏。
- **行为变化**：多窗口下不再允许两个窗口同时写同一份便签；同一会话不再允许两个窗口同时跑回合。单窗口行为不变。实现与边界见 `docs/unfinished-plans/multi-instance-sync.md`。
- **验证**：Go 全量测试、前端 1397 项测试、Vite 构建、linux/darwin 交叉编译全部通过；新增 resourcelease / sessionstore / memo / storage 的租约与门闩测试。

### 修复（子代理 · 孤儿结论投递 / 预算继承 / 默认轮次）

- **孤儿接管**：父代理走到终态（done / error / stopped）仍不级联停下级（done 的下级结论可能还有价值，agent_stop 才显式级联），但终态时会把仍在运行的直属下级**改挂到最近的运行中祖先**（祖父，收件箱投递可达）；没有运行中祖先就改挂根会话（信箱投递可达），孙代理随直属下级自然保持成树。接管时 flash 一条提示（「N 个运行中的下级改由『X』接管」）。此前 bug-hunt 实测：层3 子代理轮次耗尽自动 done 后，它派出的三个层4 后台子代理结算时 `deliverToParent` 两头落空（父不在运行表、子代理会话不进 sessions 表），四条「结论未能投递」flash、结论就地蒸发。`deliverToParent` 另加兜底：父 id 不在 sessions 表且未被接管时，按终态记录回落 `rootSessionId` 投根会话信箱。结算/提问通知的 tool 卡片刷新加归属校验（孤儿改挂后 `indexOf` 落空会退化成整屏重渲染）。护栏 `ai-subagent-sandbox.test.mjs` P14。
- **嵌套预算继承**：子代理再派单（spawn_agent）未点名 `maxRounds` 时，继承派出方子代理自己的轮次上限，而不是每层都落回设置默认——多层审计 / 调研里中间层预算先耗尽自动收尾是上面孤儿事故的直接诱因（主代理派层2给了 80、层2 派层3没传落到 50）。显式点名永远优先；主代理派单不继承（走设置默认）；继承值仍过 `resolveSubAgentRounds` 统一钳制。`spawn_agent` 工具描述同步说明。护栏 P15。
- **子代理默认轮次 50 → 200**：`AI_SUB_ROUNDS_DEFAULT`、设置归一化 / 设置弹窗钳制 fallback、设置页输入框初值与 info-tip 同步（范围仍 3–200）。注意：设置里已保存过显式值的用户不受默认值影响，需在 设置 → AI 助手 → 子代理 里自行调整。

### 改进（AI 搜索 · search_text 支持单文件起点）

- **`search_text` 的 `path` 现在也可直接传单个文件**：此前只收目录（传文件报「path 必须是目录」）。现在传文件时会走 Go 新增的 `fileOnly` 选项：以该文件为扫描根，**只扫这一个文件、不遍历兄弟目录**；rg 与纯 Go 两条扫描路径都适配（点名文件不参与产物分档，即使在 dist/build 下也当源码扫），读授权粒度与 `read_file` 一致（工作区外同一套审批）。返回头写明「只搜索文件：…（路径相对其所在目录）」。旧后端 / 不支持 `fileOnly` 的构建会自动退回「父目录 + 文件名 pattern + 结果收敛」，目录 + `filePattern` 用法不变。纯函数 `filterSearchResultToFile` 在 `ai-search-advanced.js`（测试 `ai-search-advanced.test.mjs`），Go 测试 `TestSearchFileOnly` 覆盖 rg / builtin 两条路径；工具描述同步；dev mock 支持 `fileOnly`，`?aisearchfile` 场景覆盖端到端链路。


### 新功能（app_control 扩展 · 动作审批面板 / 插件矩阵 / 设置树 / 编辑器分栏）

- **通用动作审批面板**：高危 app_control 动作走独立的 composer 接管卡（`approval.kind='action'`，`ai/ai-action-approval-card.js`）——卡面写清动作、目标、**原值 → 新值**、**发起会话（标题 + id）**、来源与**危险度**（低/中/高徽标；高风险有红警条；未知来源插件单独红字警告），按钮「拒绝 / 批准并执行」；**一次性授权，不写任何长期放行规则**；后台会话沿用通知 + 未读 + 60 秒再提醒；批准与拒绝都写操作留痕（`ai.approve` / `ai.deny`，kind=action，附 action / old / new / risk / sessionId）。公共 API `requestActionApproval` 在 `ai-panel.js`，规格归一与插件来源判定在 `ai/ai-app-approval.js`（测试 `ai-app-approval.test.mjs`）。
- **插件安装 / 卸载权限矩阵**：`install_plugin {name|url}` / `uninstall_plugin {id}`——官方市场 = Gitee / GitHub 的 `cadt-datalens-plugins` 组织（两个镜像都算）；**full 直通、auto 官方直通（非官方弹审批 + 未知来源红警）、edit 一律审批、read 拒绝**；`DeletePlugin` 是 `os.RemoveAll` 永久删除，**卸载除 full 外恒审批**。安装 / 卸载后刷新插件运行时并写 `plugin.change` 留痕。
- **设置树与按行写入**：`get_settings_tree`（不带 pane 给页清单；带 pane 给分组与行：唯一 id / 标题 / 类型 / 当前值 / 危险度 / 是否可写）；`open_settings {pane,row}` 打开设置并滚动高亮指定行；`set_setting_row {id,value}` 设原生控件值并派发 change（复用设置页校验 / 持久化 / 刷新通路），**中/高风险先过动作审批**；**布局形态（AI 面板显示方式）永久不可由 AI 写**。行 id 归一与危险分级在新模块 `settings/settings-tree.js`（测试 `settings-tree.test.mjs`）：高 = 安全姿态与第三方代码（权限默认档、分类器、子代理层级/并发、MCP、插件路径、系统集成、开发者模式），中 = 资源保留与执行行为（上下文/超时、清理保留、运行目录、留痕保留），低 = 观感项直接生效。
- **编辑器完整分组操作**：`split_open {paths}`（两文件并排）、`split_editor`、`move_tab_to_group`、`focus_editor_group`、`merge_editor_groups`；`get_state` 增加 `editorGroups` 快照（索引 / id / 聚焦 / 标签）。
- **其余新动作**：`set_dock_view {view}`（terminal / debug / run / graph）、`get_storage`（存储占用只读报告）、`get_groups {id?}` / `send_group_message {id|title,text}`（群列表与纪要、以用户身份发言；计划模式拦截）、`reveal_in_explorer {path?}`（文件树展开并选中）。
- **验证**：`ai-app-actions` 三方对账自动覆盖新动作；新增 `ai-app-approval.test.mjs` / `settings-tree.test.mjs`；dev mock 新增 `?aiapproval` 场景（真实面板审批卡 → 批准 / 拒绝链路）；全量前端测试与构建通过，dev 冒烟覆盖设置树、危险设置审批、插件矩阵、编辑器分栏、文件树定位、群聊与存储。

### 新功能（AI 按键模拟 · press_key 支持组合键）

- **`app_control` 的 `press_key` 支持组合键**：此前只派发单键（`Enter` / `Esc` / `F3` / 单字符）。现在 `Ctrl+Shift+P` / `Alt+7` / ``Ctrl+` `` / `Shift+F4` / `Ctrl+Alt+L` 这类组合串会解析成修饰键 + 主键，并按真实顺序派发——修饰键 keydown → 主键 keydown/keyup → 修饰键逆序 keyup；修饰键认 Ctrl / Alt / Shift / Meta（也认 Control / Option / Win / Cmd），主键支持字母、数字、F1–F24、Enter / Escape / Tab / Space / 方向键与常用符号，无法识别的组合串会明确报错并说明写法。解析纯函数 `comboSpecFromText` 放在 `core/keymap.js`（与 `comboFromEvent` 同一套语汇；应用快捷键按 `e.code` 匹配，字母/数字/符号自动补物理键位），`keymap.test.mjs` 用「应用全部快捷键组合」做解析→归一化往返守卫。
- 顺带修正：VS Code 风格的格式化快捷键写作 `Shift+Alt+F`，与应用自己的归一化顺序（Ctrl→Alt→Shift→Meta）不一致、实际永远命中不了；现统一为 `Alt+Shift+F`（设置页快捷键表同步）。

### 新功能（AI 界面点击 · app_control click）

- **app_control 新增 `click`**（**仅完全权限档**，计划模式拒绝）：给 AI 补上鼠标单击能力——坐标 `{x,y}` 用 `elementFromPoint` 命中目标，按真实顺序派发 pointerover/enter → pointermove → pointerdown → mousedown（补焦点）→ pointerup → mouseup → click，**不移动系统鼠标**；也可传 `selector` 直接点元素（位置更准）。坐标口径是 **CSS 像素**：截图是物理像素需 ÷ `devicePixelRatio`，`get_state` 与 `click` 返回都带 `viewport {width,height,dpr}`；返回命中元素的 tag/id/class/文本，点偏了让模型自行校准。合成事件 `isTrusted=false`、不带用户激活，依赖真实点击校验的行为可能无响应；只支持单击——拖拽 / 滚轮 / 长按 / 悬停与内嵌浏览器页面内部操作（`browser_click` 系列）不在范围。cadt-ui 动作表、`APP_ACTIONS`、执行分发与工具描述同步，`ai-app-actions` 三方对账守卫自动覆盖。

### 新功能（AI 代建群聊 · app_control create_group）

- **app_control 新增 `create_group`**：AI 可按用户要求直接建群并打开标签页（与侧栏「新建群聊」同一条落盘路径）——`members` 2–8 位智能体（写 id 或名字，重名给候选）、`title` / `topic` / `mode`（roundtable / task / free）/ `goal` / `chair`（缺省用第一个主持人标记智能体，可写名字换人、`{kind:"member"}` 成员兼任或 `{kind:"user"}` 用户主持）/ `policy` / `rounds` / `timeout`。没有主持人标记的智能体时明确报错并提示先 `create_agent {chair:true}` 或改成员兼任，不静默换模型；free 模式缺省不需要主持人。**创建后不会自动开始讨论**（开始会真实调用成员模型），由用户点「开始讨论」或发消息触发。参数整理与校验抽成 `ai-group-model.js` 的纯函数 `buildGroupDraft`（成员定位 `resolveAgentByKeyword`），测试见 `ai-group-model.test.mjs` / `ai-agent-model.test.mjs`；cadt-ui 动作表、`APP_ACTIONS`、执行分发与工具描述同步，`ai-app-actions` 三方对账守卫自动覆盖。

### 调整（欢迎页 · 空态改两块布局）

- **快捷键清单收进「快捷键」块**：原 8 行竖排清单改为块内两列网格，键名右对齐，块高度减半。
- **新增「常用入口」块**：AI 面板、便签、浏览器、终端、Git 图谱、阅读模式、全局搜索、设置八个图标按钮（图标与活动栏同源），点击走与活动栏 / 菜单相同的底层入口（`aiPanel.open` / `memoApi.open` / `openBrowserTab` / `toggleDockView` / `readingMode.openBookshelf` / `openGlobalSearch` / `openSettings`）；「将文件拖放到此处以打开」与「打开文件」按钮移出块外不变。
- **顺手修复**：`dev/mock-backend.js` 一处字符串笔误（`'\'` 未闭合转义）导致 dev 浏览器调试模式整个 mock 模块加载失败、vite 报语法错误遮罩，已改为 `'\\'`（git 图谱 `\` 字形）。

### 修复（多窗口 · 会话没按工作区隔离）

- **新窗口打开另一个工作区时，AI 面板会恢复成上一个工作区的对话**：根因是「当前会话」`activeSessionId` 存在全局 `ai-config.json`（多窗口共享同一份），面板启动只校验「这个会话还在」，不校验它属于哪个工作区；沿用之后还会经 `syncWorkspaceToSession` 把工作区切回去。现在会话读完盘 / 面板 init / 工作区变化（打开或关闭文件夹）三处都做归属校验（判定抽成纯函数 `ai/ai-session-scope.js`）：本工作区有会话就改看最近的那条，没有就新建空会话；没有工作区归属的老会话按既有语义只绑定当前工作区、不换会话；本窗口没有工作区（欢迎页）或该会话正在生成 / 压缩时一律不动。
- **编辑区会话恢复补同源防线**：`cadt.session.v1` 存在多窗口共享的 localStorage 里，是「最后保存的那个窗口」的环境；`restoreSession` 现在拒绝工作区不匹配的快照（`warn` 日志注明双方路径），不再把别的工作区的标签恢复进来、也不再把本窗口工作区换掉。
- 护栏：新增 `test/ai/ai-session-scope.test.mjs`（切会话 / 建空会话 / 绑定 / busy 不动 / 归档与支线不参与）与 `test/shell/session-restore.test.mjs` 新增两例（跨工作区快照拒绝 + 同工作区路径写法不同照常恢复）。

### 修复（全局 tooltip · 动态内容把它掐灭）

- **AI 对话里动态块一出现 tooltip 就消失/不出现**：根因在全局 tooltip 运行时 `core/tooltip.js`，两处机制叠加——①「任意滚动立即隐藏」不区分是谁在滚：AI 面板流式输出每帧贴底（`scheduleStreamRender` → `scrollToBottom`）、思考体跟流、新工具卡挂载都会产生**程序性滚动事件**，把正看着的气泡立即隐藏、还顺手清掉没到点的待显示定时器；②回答/思考体每 80ms `innerHTML` 重建，指针下的 `[data-tip]` 元素（文件引用、图片、复制钮）被整只换掉，每次替换 mouseover 重来把 1 秒停留窗口无限重置——永远弹不出来，弹出来也被下一次替换的 mouseout 隐藏。
- **滚动隐藏分两类**：用户手势（滚轮/触摸拖动/翻页键）后的滚动照旧立即隐藏（气泡不跟手滚动，不开热窗口）；程序滚动不掐 tooltip——指针还压在锚点上就跟随锚点重摆、锚点已被重渲染换掉就原地换到指针下的新锚点、锚点被挪出指针下才隐藏且进热窗口（是内容动了，不是用户在干别的事）。处置判定抽成纯函数 `resolveScrollAction`，护栏进 `test/core/tooltip.test.mjs`（用户手势 > 气泡在屏 > 锚点连通/指针压锚的优先级矩阵）。
- **流式重渲染换锚不重置停留窗口**：待显示期间同文案的新元素替换旧锚点（旧元素已离文档）时接续原来的定时器继续等，不把 1 秒重置回去；定时器到点时按指针当前位置（`elementFromPoint`）再验证一次——锚点被换掉就弹指针下的新锚点，指针已离开才撤。另兜底部分 DOM 变更不派发边界事件的静默换锚（pointermove 时对离文档锚点重新对位），`showFor` 对已离文档的锚点不再弹（旧版会按全 0 矩形把气泡飞到左上角）。
- 行为不变的部分：用户滚动/点击/Esc/窗口失焦立即隐藏、停留 1s 才出、热窗口 150ms、sticky 与动作链接均照旧；修的是「内容在动、人没动」的场景，AI 面板/浮窗/支线对话/群聊等所有用 tooltip 的地方一并受益。

### 修复（AI 面板 · 输入区盖住标题栏/标签栏）

- **底部面板拉高后 AI 输入区「浮」到标题栏上方**：贴底堆叠区（上下文警告条 / 任务清单 / 输入区 / 统计行）旧上限是 `82vh`（按视口封顶）——底部面板放开到很高后顶条被压矮，堆叠区仍按内容向上生长，直接冲出 AI 面板顶边；`#ai-panel`（z-index 20）比标题栏高，表现为输入框 / 任务卡盖住标签栏甚至标题栏。现在堆叠区封顶到「头部工具行以下」（`max-height: calc(100% - var(--ai-head-h))`，头部实测高度由 ai-panel 布局同步写入），警告条 / 任务清单可收缩让位、输入区保底 96px——极矮面板下任务卡在头部下沿被优雅裁剪，composer 与头部互不遮挡；`#ai-panel` 加 `overflow: hidden` 面板级兜底（不再外溢盖 chrome）。浏览器实测：面板压到 ~170px 时头部完整可见。
- **统计气泡不受裁剪影响**：会话 / token / 上下文三个统计气泡（`.ai-ctx-pop`）是堆叠区子元素、向上弹出，裁剪放在面板级而非堆叠级（堆叠级会把它们裁没）；AI 面板拖宽手柄从负偏移（探出面板 3px）收回面板内，6px 命中区不变小。
- **底部面板高度上限微调**：`85vh` 收紧为 `min(85vh, 100vh − 240px)`（CSS 与拖动钳制同步）——铺得仍然很高，但保证顶条至少 ~200px，AI 贴底堆叠区在顶条被压到极限时也有立足之地。

### 调整（文件树右键菜单）

- **去掉撤销 / 重做 / 展开·收起目录**：右键菜单只留操作类条目；文件树聚焦时的 `Ctrl+Z` / `Ctrl+Y` 仍走文件树自己的撤销历史（删除可从回收站还原），快捷键路径不变。
- **新建子菜单重排**：一级为「文件… / 临时文件（占位禁用，待实现）/ 目录…」+ 常用类型（Markdown、文本、Python、JavaScript、JSON、Go、Java、CSV、C++、Vue），其余类型（TypeScript / HTML / CSS / SQL / Shell / PowerShell / 批处理 / Kotlin / Lua / YAML / XML / TOML / JSONL / INI / Properties）收进「更多」二级菜单。
- **新建菜单图标与文件树同源**：`fileIconSpec` 的 svg 改走与 `createFileIcon` 相同的主题解析链——右键菜单 / 标题栏运行配置徽标 / 全局搜索 / 最近打开此前显示的是 mono 文字徽章，与文件树的 vscode-icons 彩色图标不一致；补充 `.vue` 扩展名（官方 logo + mono 兜底）。新增护栏 `test/core/fileicons.test.mjs` 并登记 `npm test`。

### 新功能（Git 图谱 · 对齐 IDEA 日志体验）

- **泳道引擎重写为 `git log --graph` 字形流（对齐业界标准做法）**：此前自研「最小空闲泳道 + 父方向判定」算法，连续多轮修补仍有断线/悬空/交叉（graph.c 的列塌缩与逐行移位语义无法靠猜复原）。调研 git graph.c / Gitea / GitHub / DoltHub(pvigier) 后改为业界同款做法——**布局交给 git 自己**：`--graph` 输出每行字形矩阵（`* | / \ _`），Go 侧按 Gitea gitgraph parser（MIT，已注明出处）移植的字形解析器按连通性给每条 flow 分配色号；渲染采用 **Gitea svgcontainer.tmpl 同款逐字形直译**——每个字形一段确定几何（竖线在格右界、斜线跨 2 格、横线贴底边跨 2 格），相邻字形天然首尾相接，`| |_|_|/`、`|/| | |` 这类复合字形全覆盖，前端零布局逻辑（此前一版「压缩成 flow 折线」的方案覆盖不了复合字形，已废弃）。同一条分支线一个 flow 色号贯穿（IDEA/GitHub 惯例），色板 12 色循环；提交行与其后的关系行（过渡字形）压成一个视觉行；排序用 `--topo-order`（分支尖紧跟其 merge 连续展示，泳道立即释放、列数少且干净——与 IDEA/JGit 一致；`--date-order` 会按日期交错出复合辫子、泳道暴涨）；斜线字形画成竖直方向的 S 形贝塞尔（控制点取 DoltHub commit-graph 插值公式），弯道只占端部、中段保持竖直。ref 点击过滤改回修订语义（旧版 `-- ref` 被当成路径过滤）；提交正文改为详情面板按需拉取（新绑定 `GitGraphCommitBody`，多行正文会让 --graph 多出关系行、破坏一行一提交的映射）。
- **图谱面板三处交互补齐**：详情「消息/作者区」与「本次变动」之间可拖动分配高度（比例持久化）；拖动底部面板高度 / 窗口缩放后提交列表自动重渲（此前要手动滚动一下才重建）；三栏与详情内拖动条全部接入系统自定义光标主题。
- **提交行右键菜单**（JetBrains 式）：右键先把该行置为选中态再弹菜单——复制修订号 / 新建分支… / 签出修订 / Cherry-Pick / 将当前分支重置到此处…。
- **三个操作对话框**（`git-graph-dialogs.js`，自持遮罩不进全局对话框栈）：新建分支（分支名 + 签出分支勾选，对应新绑定 `GitGraphCreateBranch`）；分支重置（软/混合/硬三选一 + 说明，替换原详情面板三个散按钮）；签出冲突（列出会被覆盖的文件，强制签出 / 智能签出（stash→checkout→stash pop，恢复冲突改动保留在 stash）/ 不签出；`GitOperationResult` 新增 `conflictFiles` 解析）。
- **双搜索框**（IDEA 式）：左栏「过滤分支…」实时过滤 ref 树（空组隐藏、过滤时强制展开），中栏「搜索提交（文本或哈希）…」；顶部工具条取消，刷新/关闭并入提交列头。
- **提交详情 IDEA 化**：完整正文（主题加粗 + 正文多行）→ 作者行（头像色块 + sha + 作者 <邮箱>，日期）→ ref 徽章（HEAD 金 / 本地分支绿 / 远程蓝 / 标签橙）→「在 N 个分支中: …」→ 操作按钮 → **本次变动文件树**（新绑定 `GitGraphCommitFiles`：合并提交相对第一个父比对、根提交相对空树，目录树可折叠、状态用 git 树同款 FILESTATUS 色彩标在文件名上（绿=新增 蓝=修改/重命名 灰=删除，悬停看状态与重命名前后路径）、文件/目录图标与文件树同一套主题解析链，LRU 100 缓存）。
- **交互修正**：底部面板高度上限从 480px 放开到窗口 85%（拖动钳制与 CSS 同步）；面板高度设置键范围 120–480 → 120–2000；三栏拖动条光标接入系统自定义光标主题（此前是原生 col-resize）；去掉「回到当前分支」图标。
- 测试：Go `graph_test.go` 补泳道边方向 / LaneSeg / NUL 记录解析 / diff-tree -z / 冲突文件解析用例；前端 `git-graph-lane.test.mjs` 重写为按 Go 原语渲染的护栏并新增 `parseCommitRefs` / `fileTreeFromChanges` 用例。

### 调整（活动栏 · 顶部组顺序）

- 调整为：**文件树 → Git（提交）→ 结构 → 其余**（搜索 / 浏览器 / 便签 / AI 助手 / AI 会话 / 更多），对齐 IDEA 资源管理器 / 提交 / 结构的排布习惯。纯 DOM 顺序调整，按钮 id、快捷键与行为不变。

### 新功能（标题栏运行配置 · 对齐 JetBrains 运行区）

- **标题栏右侧运行区重构为 JetBrains 式 widget**：`[配置名/文件名 + 展开箭头] + 运行 ▶`——无激活配置时显示当前文件名（带文件图标），激活配置时显示配置名（彩色字母徽标）；▶ 可用性与 tooltip 跟随激活配置的目标文件（配置绑定的文件不依赖当前标签）。AI 图标保持在最小化按钮左侧，编辑区收起条位置不变。
- **运行配置升级为可绑定目标文件**（JetBrains 式 configuration）：设置 → 运行 →「运行配置」卡片改造为配置管理（列表 + 「新建配置…」行内编辑器：名称 / 目标文件（可浏览选择）/ 运行参数 / 命令模板），语言由目标文件扩展名自动推导。旧版不带目标文件的预设保留兼容，行为不变（作用于当前文件、经语言桶生效）。
- **标题栏下拉面板**（`#run-config-pop`，与项目 / Git 分支弹层同壳互斥）：最近的配置（按 lastUsedAt 降序，运行一次即置顶）/ 所有配置 N（可折叠）/ 当前文件（切回「运行当前文件」模式）/ 编辑配置…（跳设置 → 运行）；点配置项即激活并同步 widget。
- **运行链支持配置目标文件**：激活绑定配置时 ▶ / F5 直接运行绑定的那个文件——目标是当前活动文档走原内存流（含脏文件三选一），否则从磁盘读取（`OpenFile`，二进制 / 超大拒绝；该文件在其它标签有未保存修改时提示「运行的是磁盘内容」）；参数与命令模板直接取自配置本身，不读写语言桶，不影响面板参数输入框。
- 运行面板顶部下拉的「默认配置」更名「当前文件」，与标题栏口径一致；运行配置纯函数（`activeRunConfig` / `resolveRunTarget` / `recentConfigs` 等）集中在 `terminal/run.js`（`run.test.mjs` 补护栏），widget 与弹层在 `shell/titlebar-run-config.js`（`runConfigMenuModel` 配 `titlebar-run-config.test.mjs`，已登记 `npm test`）。

### 调整（活动栏 · 四枚图标对齐 IDEA 新 UI 造型）

- **终端**：加圆角外框，框内 `>_`（箭头 45° 臂、下划线右下角），对齐 IDEA Terminal 图标。
- **结构**：竖干 + 两枚圆角矩形节点（短横梗连接），对齐 IDEA Structure 图标；旧版四条右对齐阶梯线更像「文本对齐」。
- **Git（变更列表）**：横线贯穿居中圆环（提交节点造型），对齐 JetBrains 新 UI Git 图标；旧版三节点曲线更接近「提交图谱」，与旁边 Git 图谱按钮语义撞车。
- **设置**：滑杆组换齿轮（齿轮几何取自 `core/icons.js` 的 16 网格 gear ×1.25 放大到 20 网格），对齐 IDEA 设置齿轮；旧版滑杆与「环境变量」等配置语义混淆。
- 仅改 `index.html` 内联 SVG 路径（20 网格、stroke 1.3 与活动栏一致），颜色与背景样式不动（沿用 `.ab-btn` 通用悬停/激活态）。

### 新功能（后台任务感知 · 关窗确认覆盖终端与后台命令 + 作业结束自动唤醒）

- **关窗二次确认扩展到终端与后台命令**：此前 `beforeClose` 只看「未保存修改 + AI 回合进行中」，用户自己开的终端、AI `terminal open` 创建的终端、`background_command` 的长驻作业（npm run dev 等）都会随窗口关闭被静默终止。现在 Go 侧 `beforeClose` 直接查询两个注册表的真实状态——`internal/terminal` 的 `RunningSessionCount()`（**shell 里有活命令进程才算**：Toolhelp32 枚举 shell 的后代进程，空闲提示符 / 跑完回到提示符的终端不计数不拦截，快照失败按有活动处理宁多拦不误杀；ConPTY 的 pseudo console 由系统管理不挂进程树，枚举看到的就是真实命令）与 `internal/cmdbridge` 的 `RunningAIJobCount()`（未退出的后台作业；插件 / git 走的 StartCommand 不注册、不在计数内）——四个来源（dirty / aiRunning / terms / bgJobs）一并下发 `confirm-close`，前端确认框文案按来源分组列出数量（终端项「N 个终端正在执行任务」），按钮「终止并关闭」。多窗口是多进程，注册表各归各窗口，互不影响。
- **后台命令作业结束自动唤醒会话**：`background_command` 的作业此前只能靠模型自觉轮询 `check_command`（cmd-exit 事件只更新卡片状态，不进 AI 通路）。现在真实退出事件在卡片状态翻转时经会话信箱投递「［后台命令 · jobId］已结束（退出码 N，已运行时长）」——发起者是运行中的子代理则进其收件箱（下一轮边界消费），否则投根会话信箱（忙排队、闲唤醒，与子代理结算同一套三态投递）；被停止（退出码 -1）与 `check_command` 轮询 / 弹层对账触发的状态同步不投递（模型已主动查询就不再打扰）。文案构造器 `buildBgJobExitNotice` / `formatBgDuration` 为纯函数（`ai-agent-notices.js`），前缀与 `detectAppMessage` 归类同源约定，旧会话重放可正确归类。
- **AI 创建的终端 shell 退出自动唤醒**：`terminal open` 现在记录发起会话 id（终端会话对象 `aiSessionId` 标记；用户自己开的终端没有该标记，退出不打扰）。Go 侧 `term-exit` 广播由 main.js 转发，AI 来源的终端整个 shell 退出时经信箱唤醒发起会话——ConPTY 是持久 shell，里面的程序退出不触发通知（模型用 `terminal read` 看输出即可），shell 整个没了多半是异常终止才投「［后台终端 · termId］」通知。`notifyAITerminalExit` 挂在面板公开 API 上（非新 Go 绑定，wailsjs 与 mock-backend 零改动）。
- **工具描述同步**：`background_command`（作业结束会收到后台通知，无需轮询等待）、`check_command`（正常结束会收到通知）、`terminal`（程序退出无通知要用 read 看；shell 会话本身退出才有通知）。
- 护栏：`ai-agent-notices.test.mjs` 补两个通知构造器与时长格式化（退出码未知兜底 / 命令截断 / 后续动作提示）；`ai-app-message.test.mjs` 补新前缀归类与图标；Go `commands_test.go` 补 `TestRunningAIJobCount`（差值断言，注册表全局共享不吃绝对值）；跨平台护栏 `check-crossbuild.cmd` 三平台通过（`terminal_other.go` 桩新增）。

### 新功能（AI 上下文门禁 · 超上限禁止发送 + 提醒条重绘）

- **上下文达到窗口 90% 禁止发送**：发送按钮禁用、提示行说明原因、回车 / 点击发送直接给明确提示；此前起轮预检（超 90% 拒发）只在点击后才 flash，用户无预知。判定口径收敛为单一常量 `AI_CTX_SEND_BLOCK_RATIO`（ai-constants.js），起轮预检、门禁、提醒条三处同源。
- **上下文提醒条重绘**：一行裸灰字改为警告胶囊——警告图标 + 一行文案 +「压缩上下文」按钮 + ×，边距与输入框卡片对齐；达到压缩阈值为琥珀「建议压缩」态，达到发送门槛转红色门禁态（数字千分位）。× 关闭只收提醒、发送门禁不变（再涨 5% 重新提醒的规则照旧）。
- **≥100%（压缩也不可行）分层出口**：压缩请求 = 摘要提示 + 整段会话一起发给模型，估算 ≥100% 时同样必被拒收——`/compact` 与 auto-compact 在 `startCompact` 提前拒绝并给出指引（不再等 API 报错，也不触发转录尾部截断导致的「摘要静默缺斤短两」）；提醒条按钮换成「分段压缩」占位（aria-disabled 压暗 + tooltip + 点击提示出路；用 `aria-disabled` 而非 `disabled` 是为了让 hover/tooltip 仍可派发）；发送提示行与 flash 按档区分文案。
- 方案文档：`docs/unfinished-plans/ai-segmented-compact.md`（分段压缩自救——归档最老一批消息再摘要的分段压缩）。注：该方案后于 2026-11-22 复评决定不实施并移入 `docs/reports/`，详见「未发布」段落。
- 文案与状态收敛为纯函数 `aiCtxBannerState`（ai-constants.js），护栏补进 `ai-constants.test.mjs`（三档文案 / 门禁边界 / 千分位 / windowSize 兜底）。

### 新功能（tooltip · 可悬停交互气泡与动作链接）

- **交互扩展（默认关，逐锚点 opt-in）**：`core/tooltip.js` 新增两属性——`data-tip-sticky` 让指针可以从锚点移进气泡里读长说明，「锚点 + 气泡」合为一个悬停区域，移出才隐藏（滚动 / Esc / 失焦照旧隐藏）；`data-tip-actions='[{"label":"去关闭","action":"ai:context-slim"}]'` 在气泡尾部渲染动作链接，点击经 `setTooltipActionHandler` 注册的回调分发（main.js 接线），分发后隐藏且不开热窗口。挂了 actions 自动启用 sticky（链接要悬停才点得中）。链接只用 `createElement` + `textContent` 渲染，不走 innerHTML（原始 HTML 不执行是硬要求，测试静态卡）。交互气泡才收指针事件（`.app-tip-interactive` 且显示态），默认隐形气泡不挡 UI。
- **首个落地场景**：AI 面板上下文弹层「实时瘦身已省」ⓘ 说明尾部加**「去关闭」**——点击打开 设置 → AI 助手 并定位到「上下文实时瘦身」开关（`openSettingsAtRow`：复用 `openSettings('ai')` 与 settings-search 的 `.settings-hit` 滚动高亮模式）。
- 护栏：`test/core/tooltip.test.mjs` 扩充 `parseTipActions` 坏数据丢弃 / 条目校验 / 3 条与 24 字上限 / innerHTML 静态禁令（已登记 npm test）。

### 修复（文件树 · 打开文件不再挪动横向滚动条）

- **对齐 IDEA 的 reveal 行为**：树/列表视图此前用 `scrollIntoView({block:'nearest'})` 把当前文件滚进视野，但 `inline` 默认 `'nearest'`，打开文件时会连横向一起滚动，横向滚动条位置随打开的文件乱跳。现在改为纯垂直 reveal——`verticalScrollFor` 只算垂直目标（上方贴顶 / 下方贴底 / 可见不动），`revealRowVertically` 只写 `scrollTop`、不碰 `scrollLeft`，横向滚动条完全交给用户控制。`scrollToActive` / `selectPath` / `selectPaths` 三处统一走它。护栏：`test/explorer/explorer-reveal.test.mjs`（垂直滚动边界 + 接线扫描，已登记 npm test）。

### 新功能（AI 命令卡 · 执行耗时徽标）

- **run_command 工具卡头部显示命令耗时**：命令结束后在右侧状态字左边显示徽标（`1.25 s` / `12.3 s` / `2 m 05 s`，口径与 F5 运行计时一致），数据取 Go 回传的 `durationMs` 暂存在消息上，随会话 JSONL 落盘、重启重放后仍在；中断 / 失败的命令不显示。模型可见文本里的「用时 X ms」保持精确毫秒不变。格式化纯函数 `formatCommandDuration` 落在 `ai-terminal-tools.js`，护栏补进 `ai-terminal-tools.test.mjs`。

### 新功能（跨文件行书签 · 总览弹层 + app_control 开放给 AI）

- **书签总览**：`Shift+F11` / 视图菜单 / 编辑器右键「书签 → 书签总览…」/ 命令面板打开，复用快速切换器的弹层——按文件分组列出全部书签（行号 + 行内容片段），↑↓ 选中、Enter 跨文件跳转、**Delete 删除选中项**；编辑器右键菜单补「书签」子菜单（切换当前行书签 / 书签总览 / 清除本文档书签），命令面板补「清除当前文档书签」。
- **app_control 新增五个书签动作**：`list_bookmarks`（按文件分组 + 行内容片段）/ `add_bookmark`（未打开文件自动打开并切到代码视图）/ `remove_bookmark`（未命中该行时回报现有书签行）/ `clear_bookmarks` / `goto_bookmark`（跨文件打开并跳行；与 `goto_line` 的分工写进工具描述）。计划模式下三个写动作 per-action 拦截，list / goto 不受限。技能动作表、APP_ACTIONS、分发、工具描述四处同步，`ai-app-actions` 三方对账守卫自动覆盖。
- 聚合口径 = 打开中的标签页（书签随会话快照只持久化打开中的文档）。护栏：新增 `test/editor/bookmark-list.test.mjs`（聚合 / 行预览 / AI 文本格式 + 接线护栏，已登记 npm test）。

### 新功能（存储与清理 · 定期 / 按大小自动清理缓存）

- **设置 → 存储与清理 新增「自动清理」**：开关 + 时间间隔（每天 / 3 天 / 每周 / 每月 / 仅按大小）+ 大小阈值（100 MB ~ 2 GB / 仅按时间），任一条件满足即清。检查时机为启动后 2 分钟与运行中每 6 小时；执行复用既有 `StorageScan` / `StorageClear` 绑定，Go 侧零改动；范围 = 「清除缓存」条目表去掉**浏览器实例数据**（含网页登录态，自动清等于不定时把用户登出网站）——data/danger 条目永不进入，安全性由显式 id 列表保证、不依赖后端兜底。
- 清理完成经**消息中心**提示（触发原因 + 释放量 + 排下次启动的项），操作留痕记 `storage.auto_clean`（系统来源，设置页筛选新增「存储」域）；上次清理时间显示在设置页、跨窗口共享。WebView2 缓存仍走 pending 标记、下次启动前执行；多窗口并发有互斥锁兜底，最坏重复清一次（幂等）。
- 护栏：`test/settings/settings-pane-storage.test.mjs` 新增 `shouldAutoClean` 判定表（时间 / 大小 / 双关 / 从未清理过 / 非法值）与 `autoCleanScope` 范围防线（只含缓存条目、排除登录态与空条目）。

### 调整（Git 图谱 · 首次加载骨架屏与三栏宽度可拖动）

- **首次加载骨架屏**：切到「Git 图谱」视图拉后端数据期间，三栏区域先显示 shimmer 骨架占位（ref 树 / 提交列表 / 详情的结构与真实布局对齐），数据返回（或失败）后移除，不再「先空白一片再突然蹦出」。骨架 HTML 由纯函数 `buildSkeletonHtml` 生成，宽度随拖动后的栏宽同步；`prefers-reduced-motion` 下关掉扫光动画。手动刷新 / 写操作后重载沿用旧数据，不闪骨架。
- **三栏分割线可拖动**：ref 树 | 提交列表 | 详情之间加两条 `col-resize` 拖动条（pointer 事件 + setPointerCapture，拖出条外也持续跟踪），两侧栏宽存 localStorage（`cadt.gitgraph.paneWidths`），下次打开保留。宽度经 `clampPaneWidth` 收敛到下限与「窗口宽 − 另两栏 − 中间最小宽」之间，窄窗口下中间提交列表不会被挤没；骨架屏三栏宽度同步 CSS 变量。护栏：`test/git-graph/git-graph-lane.test.mjs` 新增骨架结构与 `clampPaneWidth` 边界用例。

### 修复（AI 会话结构 · 宿主环境块不再污染定位条）

- **预览先拆 `<system-reminder>` 环境块再取正文**（`frontend/src/ai/session-outline.js`）：环境块随用户消息一起落盘，定位条此前直接拿 `content` 做预览，开着文件的那几轮整行显示成 `<system-reminder> <workspace_context>…`，用户自己的话被挤出可见范围。现在与气泡渲染同一口径走 `splitTurnReminderPrefix`。
- **纯注入消息不占行**：只有环境块、没有正文也没有图片/视频的消息没有可定位内容，不再计入轮号；带媒体的仍按数量兜底（补齐视频，此前会被标成「图片」）。历史会话的静默注入（`silent`，含旧 `task_todos_check` 回填）与 systemNote / app / 模型切换留痕一样跳过。
- 护栏：`test/ai/session-outline.test.mjs` 新增拆块预览、纯注入跳过、媒体兜底三组用例。

### 新功能（AI 子代理 · 默认轮次预算可配置）

- **设置 → AI 助手 → 子代理新增「默认轮次」**：默认 50，范围 3–200。子代理的轮次预算此前是硬编码常量 `AI_SUB_ROUNDS_DEFAULT`，想改只能改代码；现在可在设置里调，`spawn_agent` 未指定 `maxRounds` 时用它。一轮 = 一次模型请求（一轮里可并行多个工具调用）。
- **配置值与单次点名走同一个纯函数**（`resolveSubAgentRounds`，`frontend/src/ai/ai-subagents.js`）：两者都缺省才用内置 50；`null` / `''` 一律回落而不是被 `aiClampInt` 算成 0 再钳到下限 3（与 `resolveWaitTimeoutSec` 同一个坑，这次一开始就避开）。
- **工具描述跟着变**：`buildSpawnAgentDef` 现在总是新建 def 并把 `maxRounds` 描述里的「默认 50」替换成当前设置值——否则模型会按写死的旧默认规划预算。没有自选模型候选时也不会再早退返回常量对象（否则该项永远显示 50）。
- 导入导出同步该字段（`ai-settings-io.js`）；旧配置缺字段零迁移（回落 50）。冷唤醒仍沿用记录里原来那个 `maxRounds`，不受后续改设置影响。
- 护栏：`test/ai/ai-subagents.test.mjs`（`resolveSubAgentRounds` 的缺省 / 越界 / 字符串 / 非法值）、`test/ai/ai-tool-defs.test.mjs`（描述随设置变、不污染 `AI_TOOL_DEFS` 常量、无候选时不出现 `model` 参数、def 仍是纯载荷）。

### 新功能（AI 隔离区 · 参照 ZCode managed-worktree 补齐）

- **隔离会话的补丁卡全档必弹**：`patchAllowApply` 新增 `worktreeActive` 维度——隔离区开启期间 `propose_patch` 无论档位都弹审批卡（`apply=false` 仍可只产出文件）。理由：主根只读闸下补丁回灌是唯一能写主根的通道，与 `worktree_manage(export)` 的回灌卡同一条人工审阅红线；工具描述与 cadt-ui 技能档位表同步。
- **`.worktreeinclude` 被忽略文件拷贝**（对齐 ZCode §3.4）：创建隔离区时若仓库根有 `.worktreeinclude`（gitignore 语法），把「被 git 忽略 **且** 匹配清单」的文件（`.env` 这类 dotfiles——junction 只能共享目录、覆盖不了它们）从主根拷进隔离区：只拷普通文件、不覆盖已存在、junction 父目录下跳过（已共享）、并发 8；结果带 `includeCopied` / `includeErrors`，不致命。新增 `TestWorktreeIncludeCopy`。
- **`carry=true` 带入主根未提交改动**（对齐 ZCode fork 的 binary patch 做法）：`worktree_manage(create, carry=true)` / 面板直连创建可选——暂存补丁（`--index` 保留暂存划分）→ 未暂存补丁 → 未跟踪文件拷贝 → **打一个机器快照 commit 并把 baseSha 推进到它**，export 的 diff 语义保持「只含 AI 的草稿改动」；带入失败整个创建失败并回滚（carry-failed）。创建审批卡会写明「将带入主根未提交改动」。新增 `TestWorktreeCarryChanges`。
- **丢弃前查终端占用**（对齐 ZCode §3.11）：`TermList` 里初始 cwd 落在隔离区内且还活着的终端（底部终端与 AI 终端统一查）会阻止丢弃——AI 路径报 `WORKTREE_TERMINAL`，用户路径 flash 提示「请先关闭」；已退出的终端不算占用。
- **git 环境隔离**：`gitRun` 逐项剔除 `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` / `GIT_OBJECT_DIRECTORY` / `GIT_ALTERNATE_OBJECT_DIRECTORIES` / `GIT_COMMON_DIR` / `GIT_NAMESPACE` / `GIT_CEILING_DIRECTORIES`（用户从带这些变量的终端拉起应用时，它们会让 `cmd.Dir` 失效、git 跑到别的仓库）。新增 `TestGitRunEnvIsolation`。
- **隔离区生命周期写进会话历史**：用户手点的创建/丢弃合成一条 `worktree_manage` 工具卡消息对（同 `/init` 的做法）——重启后对话里能看到隔离区何时建、何时丢（对齐 ZCode 的「已创建 worktree」timeline part）；AI 路径本来就有工具卡，不受影响。
- **创建/丢弃审批卡改结构化观感**：纯文字墙改为键值明细行（位置 / 分支 / 用途 / 带入 / 改动，路径用等宽字体）+ 强调色提示条（创建卡 info 蓝、丢弃卡 danger 红「删除不可恢复」），与补丁审批卡的清单观感对齐。胶囊信息卡与 pill 丢弃确认弹窗同步改结构化弹窗体（同一套明细行 + 提示条，`confirmDialog` 支持传 DOM 节点）；补丁审批卡的「应用模式」从裸 select 改为两段式切换钮（`patch-mode-group`，允许部分成功 / 整体成功，aria-pressed），补丁视图里的下拉维持 `createSelect` 不变。
- **部分应用补丁的结果补 `unselected=` 计数**：partial 模式 / 用户取消勾选冲突文件时，未勾选的文件不在 `PatchApply` 结果里，`skipped=0` 看起来像"没跳过任何东西"——现在 `patchResultText` 收 `okTotal`（预检可应用数），把差额写进 `unselected=N` 并加一行「未勾选：N 个文件不在本次应用中，文件保持原样」；隔离区回灌路径还注明「仍留在隔离区」。`propose_patch` 与 `worktree_manage(export)` 两条路径都生效。
- **补丁审批卡文件清单限高框内滚动**：多文件（worktree 回灌常十几二十个）此前把整卡撑到 58vh 上限、应用模式与操作条被推到很远的底部——现在 `.ai-patch-filelist` 自身限高 `min(40vh, 380px)` 框内滚动，「应用模式」行与「放弃 / 应用」始终可见。
- **创建卡显示真实 slug、统计改紧凑汇总**：① slug 由前端按 Go 同一套派生规则（`predictWorktreeSlug`：用途名清洗截 32 + 会话 id 尾 8 位）预测出实际路径显示在卡上（同名冲突顺延 -2/-3 时以工具结果为准），不再写 `<slug>` 占位；② 丢弃卡/信息卡/列表的改动统计从 `git diff --stat` 逐文件表格改为 **`+45 −39 · 3 文件`** 紧凑汇总（`worktreeStatTotals` 纯函数解析 summary 尾行），删除卡不再有无上限的 pre 块；③ 顺带修一个真 bug：`WorktreeStat` 此前没做 `add -N`，AI 新建的未跟踪文件不进统计（丢弃卡会显示 +0）——现在与 `WorktreeDiff` 共用同一个 intent-to-add 前置步骤。护栏：`worktreeStatTotals` 5 例（多文件 / 单文件纯删 / 空文本 / 无 summary 行）+ slug 预测 6 例（CJK / 截断 / 尾号）。


### 新功能（AI 斜杠补全 · 指令在前技能在后，/技能名 带参直调）

- **`/` 补全面板分区显示技能**：固定指令保持在前列出，后接「技能」分区标题与技能条目（`/技能名` + 来源标签 · 描述，如 `/app-error-log  用户·通用 · 查询生产库错误记录`）。技能列表经 `listSkills`（5s 缓存）异步预热，已禁用技能不显示；键盘 ↑↓/Tab/点击与固定指令同一条交互。
- **`/技能名 参数` 直接调用**：非固定指令的斜杠输入先按技能名匹配（大小写不敏感）——带参数时附加技能全文并**立即发送**原文（如 `/app-error-log 123`，生成中自动排队，消息保留 `/技能名 参数` 原文便于模型对应技能描述里的触发约定）；无参数时只附加技能并提示继续输入需求（与 `/skill <名字>` 手感一致）。未知命令的提示同步改为指向 `/` 补全与 `/help`。
- 实现：`ai-slash.js` 分区渲染 + `invokeSkillItem`（纯函数 `filterSlashCommands` / `filterSlashSkills` / `extractSlashArgs` 导出供测试）；`ai-composer.js` 新 `sendComposerMessage` 直发/排队统一出口；`ai-message-queue.js` 排队三函数加 `plain` 旁路（跳过「/ 开头转斜杠命令」检查，否则技能带参排队会转回 `handleSlashText` 死循环）；`/help` 文案补技能调用说明。护栏：`test/ai/ai-slash.test.mjs`（已登记 npm test）。

### 修复（完全权限档 · propose_patch 弹不出审批卡）

- **`apply:true` 真正生效**：`patchAllowApply` 旧实现只认 `apply:false`，`true` 被直接忽略——真机上用户说「可以」、模型带 `apply:true` 重试，卡怎么都不弹，模型只能让用户去补丁视图手动应用。现在三态语义：`false`=只产出文件永不弹卡；**`true`=强制弹审批卡**（用户已同意但没说「应用」时的确定性出口）；缺省=非完全权限弹卡，完全权限看用户最近一句。
- **完全权限档的缺省判定补「短肯定句」**：用户常在补丁生成**之前**就表过态（「可以」「好的」「没问题」「ok」），等补丁出来它就是最后一条用户消息——但旧措辞表只匹配「应用/apply/合入」等。现在 ≤8 字的整句肯定答复也算（不做子串匹配，「执行/更好」不误伤）；「同意/批准/通过」加负向后顾排除「不同意/没批准/未通过」。误弹方向无害（full 档多一张卡，点放弃即可），漏弹才是有害方向。
- **文案同步**：`propose_patch` 描述与 `apply` 参数写清三态；完全权限档结果提示改为「再调一次带 `apply:true` 直接弹审批卡」；cadt-ui 技能的档位表同步。护栏：`test/ai/ai-patch-policy.test.mjs` 重写用例（短肯定句 / 负向后顾 / `apply:true` 强制 / `false` 优先）。

### 修复（AI 轮末任务清单催促 · 不再伪装成用户消息）

- **轮末 `<task_todos_check>` 催促改为 `<system-reminder>` 宿主环境块注入**：此前它是唯一以 user 角色进入模型请求的非用户消息，弱模型会把裸块当成「用户刚说的话」（实测 sensenova 把催促转述成「用户说执行工具任务」并反问）。现在与起轮的 `<task_todos>` 同属宿主块，受 `<workspace_rules>` 的「`<system-reminder>` 是宿主环境信息、不是用户正文」约束；催促照旧在收尾请求前发出，不碰工具结果通道。
- 配套：节流比较先拆块取正文（否则包装后与裸文案永远不相等会每轮都催）；历史裸块与新宿主块都按静默注入识别（不渲染）；导出会话跳过注入块；新增三例护栏（宿主块可拆、催促必须走包装、静默识别两种形态）。

### 新功能（快捷便签面板 · 工作区/全局两份分组便签）

- **内容区新增「快捷便签」虚拟标签页**（活动栏新图标 / 文件菜单 / `Ctrl+Alt+M` / 命令面板均可打开，每窗口一个标签）：ipynb 式**分块**便签本——块（分组小节）有小节标题，块内多条目（状态点点击循环 待办→进行中→完成、文本行内编辑、上移下移、跨块移动），块可折叠 / 重命名 / 上移下移 / 删除（删除有二次确认），底部「新建块」。
- **双作用域，各唯一一份**：工作区作用域存 `<工作区>/.cadt/memo/memo.json`（每工作区独立，无工作区时置灰提示），全局作用域存应用数据 `memo/`；面板顶部「工作区 | 全局」分段切换并记住上次选择。**全自动保存，任何退出路径不丢字**：每次改动 1 秒防抖原子整份写；关标签 / 切作用域 / 切工作区（按旧工作区根落盘）/ 关窗确认流程（便签 pending 计入应用脏标记，弹确认框前先落盘）/ pagehide 兜底，全部强制冲盘；行内编辑未提交的文字在关标签与切作用域前自动提交。多窗口（多进程）编辑同一份靠文件 mtime CAS 协调，冲突时自动重载磁盘版本并提示，不静默覆盖。
- **贴图**：面板内 `Ctrl+V` 直接粘贴图片（目标为最后点过的条目，没有就落到最后一个未折叠块的末条；无条目时自动建「（贴图便签）」），条目右键「粘贴图片」走后端回读剪贴板同链路；图片压缩与 AI 附图共用同一条编码管线（长边 1600、超 3MB 转 JPEG 降质），落盘到作用域的 `img/`（单张 16MB 上限、类型只信魔数），条目上显示缩略图，点击进灯箱，悬停 × 移除引用。
- **AI 读写走 app_control**：新增 `get_memo / add_memo / update_memo / remove_memo / open_memo_panel` 五个动作（与界面同一套变更通路——AI 改完立即防抖保存并刷新打开中的面板）；读不受计划模式限制，三个写动作在计划模式下被 per-action 拦截。便签内容不自动注入对话上下文，AI 按需 `get_memo`；与 todo_write（会话内执行进度）是两个本子，描述与调度原则双向写明分工。
- **交互与编辑打磨**：便签正文改多行 textarea（Enter 换行、Ctrl+Enter 提交、失焦保存、自动撑高），标题编辑仍单行；块/条目右键菜单对齐编辑器视觉（图标码表同源），正文编辑中右键放行原生剪贴板菜单；面板按钮 mousedown 响应（防 blur 重渲染死区）；顶栏右侧常驻快捷行【文本 | Markdown | 新分组】（PyCharm ipynb 式）：新条目智能落点——编辑某条目时插到它后面，否则加到最后一个块末尾；Markdown 条目失焦即渲染、点击回源码；文本条目里的贴图占位符渲染成内联图；缩略图放大并支持右键【复制 / 另存为】。
- **贴图删除即回收**：移除贴图引用（× 按钮 / 删条目 / 删块 / 正文删占位符 / AI remove_memo）后，保存成功时把不再被引用的图文件送回收站（引用差集判定，CAS 冲突重载保住的图绝不误删）；失败静默由存储清理兜底。
- **导出**：顶栏「导出」→ 当前作用域便签导出 **Markdown**（任务清单勾选框 + md 条目原样 + 贴图复制到旁侧 img/）、**HTML**（单文件、图片内嵌 data URL，可直接分发）**Word（.doc）**（Word 兼容 HTML + 旁侧贴图，零依赖内置）或 **Word（.docx 原生）**（OOXML 直排 + store-mode ZIP 内置生成器，图片按 PNG 实际尺寸等比内嵌、无兼容模式提示；生成器 `bridge/memo-docx.js`，产物经 Python zipfile/XML 解析器独立交叉验证）。
- **AI 读取支持过滤**：`get_memo` 新增可选参数 `block_id`（只看某分组）/ `status`（pending / in_progress / completed）/ `q`（文本包含，不区分大小写）——便签多时模型优先过滤读取，返回首行仍汇报全局面板计数并注明过滤条件与命中数（不丢全局视野）；无命中明确提示总数不变。
- **定位点（AI / CLI 直达）**：块与条目右键菜单新增「复制定位点」（`cadt-memo://<作用域>/<block|item>/<id>`）——粘贴给 AI 助手，模型按 get_memo 清单按 id 立刻定位（格式已写入技能表）；也可用 CLI `CaDt-DataLens.exe --memo "<定位点>"` 直接打开面板跳转到该位置（冷启动与运行中转发均支持，折叠块自动展开并高亮定位）。
- **快捷跳转**：底部「新建块」右侧新增「跳转」按钮——按文档顺序平铺分组与条目（长清单菜单内滚动），点击直达：折叠块自动展开、滚动居中并闪烁高亮定位。
- **导出扩展点（通用能力，市场插件）**：新增 `cadt.registerDocConverter({id, label, extensions, convert(ctx)})`——通用的「文档格式转换器」扩展点：消费场景（快捷便签面板先行，AI 回答另存 / 阅读导出等后续接入）把内容组装成统一 ctx（HTML 相对引用 + 图片字节就绪 + 保存对话框与文本/二进制落盘原语）交给插件；**一个转换器插件安装后所有接入场景自动获得该格式**。.docx 生成器最初以插件形态发布后收编内置（仅 15KB，不值得独立分发）；扩展点保留给 PDF 等更重格式的市场插件，开发文档见 `docs/plugins/README.md`「注册文档格式转换器」。
- 存储：工作区 `.cadt/memo` 与应用数据 `memo/` 已登记进「设置 → 存储与清理」（清除数据按勾选处理、送回收站）。

### 修复（AI 隔离区 · 新会话残留隔离芯片）

- **从隔离区会话点「新建对话」不再残留「隔离 · 开」**：隔离状态是会话级的（`session.worktree`，一会话一个），新会话本就不带登记，但 `newSession` 的全新创建分支不走 `switchSession`，头部胶囊与输入区开关停留在上一个隔离会话的显示，要切到别的会话才被修正。隔离边界本身（写闸 / 注入块）一直是按会话取值的，此问题只在显示层。
- **会话级 chrome 统一刷新收口**：新增 `syncActiveSessionUI(keepScroll)`（`frontend/src/ai/ai-panel.js`）——消息区、输入区、发送/停止按钮、提醒徽标、计时胶囊、隔离芯片、系统提示词估算八项「跟着当前会话走」的显示状态收成单一入口；`switchSession`（原手写清单）、`newSession`、`deleteSession` 兜底空白会话、跨窗口重载兜底（`applyLoadedSessions`）、启动加载（`refreshSessionUI`）与 `init` 全部改走它——跨窗口重载 / 启动兜底路径此前连计时胶囊、提醒徽标也不刷（相邻缺口一并收口）。
- 护栏：新增 `test/ai/ai-session-ui-sync.test.mjs`（已登记 npm test）——统一入口必须含全部八项刷新、六条路径必须调用、`switchSession` 不许再手写芯片清单；以后加会话级芯片漏了统一入口会直接红。

### 调整（AI 计划审批卡 · 预览渲染 Markdown）

- **计划等待批准的预览从原始文本改为渲染 Markdown**：标题 / 加粗 / 列表 / 代码块正常显示，与 AI 回复走同一条共享渲染链（markdown-it → DOMPurify → hljs），原始 HTML 不执行；预览区沿用 `.ai-md` 排版。
- **截断改为结构感知**（`planPreviewSlice` 纯函数，`frontend/src/ai/ai-plan-file.js`）：只在行边界、围栏代码块外切——围栏要么整体保留要么整体丢弃（围栏内形如 ```` ```js ```` 的行不算闭合），不再出现切半行或悬空围栏；截断补省略行，「查看完整计划」入口不变。

### 新功能（AI 助手 · 提问卡可折叠收起）

- **AI 提问卡支持临时折叠**：头部新增收起按钮，整卡折成单行细条（标题 + 当前问题文本），方便先看上方消息；细条上保留超时倒计时（到点仍按设置结算），不显示「跳过 / 提交回答」按钮，点击细条恢复完整卡。已选选项与题目进度在收起期间保留。
- **倒计时文案去掉「（本次自定义 N 秒）」**：超时动作说明保持「超时后按 AI 推荐项继续 · 剩余 4:24」这样的原样，不再因本次超时秒数由 AI 定制而附加括号说明。

### 修复（AI 子代理 · 层级编号与并发上限文案）

- **层号统一为「含主代理」口径**：主代理第 1 层，它直接派出的子代理第 2 层，依此类推。此前各处直接印内部 `depth`（主代理=0），`agent_tree` 的「第 2 层」实际是二级子代理，比人的层号小 1；一级子代理还完全不显示层号。层号文案收成单一来源 `agentLevelText()`（`frontend/src/ai/ai-team-model.js`），团队详情卡、HUD 胶囊、工具卡、`agent_tree` 文本、`spawn_agent` 回执与停止摘要六处统一走它。
- **设置项「递归层级」改为「层级上限」并同口径**：说明写清「含主代理，1 = 只允许主代理」；判定按层号换算，实际允许的层数与文案一致（此前设为 N 时实际能多派一层）。旧配置数值无需迁移，默认 0 = 不设限不变。
- **并发上限的文案改正**：错误信息与设置标题从「子代理总数上限」改为「子代理并发上限」。`activeSubCount` 只数运行中的子代理，不累计历史——5 层满员树（2/4/8/16 共 30 个子代理）连续跑通即证明它不是累计上限；超限发生在同时运行数达 20 时，等一个结束重试即可。
- 护栏：`test/ai/ai-team-model.test.mjs` 新增 `agentLevelText` 用例，层号断言改为含主代理口径。

### 重构（AI 子代理 · `wait_agent` 语义对齐 dsh：改为等自己的收件箱）

- **语义变更**：`wait_agent` 不再「等某个子代理出终态并直接返回它的结论」，改为等**调用方自己下一步的新输入**——子代理完成通知 / 其他代理的消息 / 用户插话；返回 `{timedOut}`，内容在下一轮开头注入上下文。参数只剩 `timeoutSec`（0–600，默认 60），`agentId` 已移除；被不想等的代理唤醒时可继续 `wait_agent` 等目标。
- **为什么改**：旧实现必须靠守卫逐个补三类坑——子代理把自己算进「可等候选」导致自等满超时（2026-11-17 五层嵌套实测两支各踩一次，单轮 253 秒以上，还丢了一个结论）、跨支定向等被拒、终态记录被 LRU 回收后结论取不到。等自己的收件箱从定义上没有这些：入队即唤醒、谁完成谁入队、结论不会丢。参照 `deepseek-harness` 的 `packages/subagent/tool-subagent-control/src/wait-agent.ts`。
- **新增等待原语** `frontend/src/ai/ai-inbox-wait.js`：`wait / notify / cancel`，事件驱动；落地即有输入时立即返回、不发定时器；250ms 心跳只用于检查「调用方已被停止」（用户停止 / agent_stop 立刻返回，不空等满超时）；竞态按「先注册再查」闭合。
- **三处入队即唤醒**：会话信箱（`deliverAgentNotice`）、子代理收件箱（`queueSubAgentMessage` / `steerSubAgent`）、用户插话与排队消息（`createQueueModel` 新增可选 `onChange` 钩子）。notify 只表示「有新东西排队」，注入仍在轮边界——把 notify 当立即注入会破坏轮次模型。
- **顺带修掉一个真缺陷（嵌套回报全丢）**：结算与提问通知此前用 `sessionById(parentSessionId)` 取父会话，而子代理会话不进 `sessions` 表，该调用对嵌套代理恒为 `null`，第 2 层起的回报**静默丢失**（就是「层5-A2a 结论没回到层4-A2」的机制）。新增 `deliverToParent()`：父是运行中的子代理就投它的收件箱（来源前缀新增「下级代理回报」），否则走会话信箱。
- **收尾轮守卫**：子代理收尾轮不消费收件箱（`runSubRound` 的 `!s.wrapUp` 守卫），此时 `wait_agent` 立即返回并提示「预算已尽，别再等，直接给结论」，不再空等满超时。
- **审查后补的四处（同批，均有护栏）**：
  - **`timeoutSec` 传 `null` / `""` 不再变成「不限时」**。`aiClampInt` 用 `Math.round(Number(x))`，`null`/`''`/`false` 都变成 0 且都是 finite（不走 fallback），而 0 曾表示「不限时」——没有 deadline，一次失败收尾就能让工具调用**永久悬挂**（250ms 定时器还一直跑）。现在抽成 `resolveWaitTimeoutSec()`：缺省 60、最小 5，「不限时」取消。
  - **同一轮内重复 `wait_agent` 不再自旋**。注入只在轮边界发生，计数本轮不会变，所以第二次调用会立刻又返回「有新输入」，主代理又没有逐轮硬上限——可以烧到用户手动停。现按 `stream` 记「本轮已报告过」的 pending 数（对齐 dsh 的 seen 集合），第二次起直接回「已报告过，直接结束本轮」。
  - **`hasQueuedInput` 接线修正**：它曾被写进子代理模块 ctx、却从**工具 ctx**（只有 `session/toolMessage/stream`）读取，恒为 `undefined`，等于把「队列里已有用户消息」这条判定关掉——注释宣称修好的场景其实没修。
  - **停止即放行**：`stopGeneration` / `stopSubAgent` 现在直接 `inboxWaiters.cancel()`，不再依赖 250ms 心跳；`isStopped` additionally 认 `stream.finished`（`finishStream` 只置 finished 不置 stopped，漏了会白等满超时）。`cancel` / `clear` 因此不再是死代码。
- **投递失败不再静默**：`deliverToParent` 返回 false（父会话已结束 / 已归档）时 flash 提示「结论未能投递」。
- 删除随旧语义一起作废的 `agentCanBeWaitedBy` / `agentUnderSessionBy`（定向等待的祖先判定）与 `subSettledText` / `subRunningSnapshot`。
- 护栏：新增 `test/ai/ai-inbox-wait.test.mjs`（落地即有输入 / notify 唤醒 / 超时 / 被停止 / 注册前入队不丢 / owner 隔离 / cancel 与 clear 清干净）；`ai-subagents.test.mjs` 新增 `resolveWaitTimeoutSec`（null/空串/false/0 的钳制）与 `pendingInboxCount`（ask 不算可注入输入）；`ai-agent-notices.test.mjs` 新增「入队即 notify 且 ownerId 是会话 id」（key 写错在端到端里看不见）；`ai-subagent-sandbox.test.mjs` 新增 P10（嵌套投递归 `deliverToParent`）、P11（来源前缀三方可辨），P7 改写为「等自己的收件箱、不许轮询、收尾轮守卫、不许从工具 ctx 读队列判定、两处停止都要 cancel」；`ai-turn-steer-wiring.test.mjs` 的 `createQueueModel` 签名断言同步。
- **嵌套提问现在真的有人能答了**：`agent_send` 从「只有主代理有」扩到「能派单的层都有」（与 `spawn_agent` / `wait_agent` 同批）。此前 `buildAskNotice` 教父代理用 `agent_send(askId=…)` 作答，但嵌套时父是子代理、手里没有这个工具，提问只能等 120s 超时按 `ai_decide` 放行。方向限死为**只能发给自己派出的下级**（回答提问 / 补线索 / 冷唤醒），不能给祖先或兄弟喊话——守卫生成 `agentDescendsFrom()`（从上级起追，天然排除自身，不复刻当年 `agentUnderSessionBy` 的自等坑）；向上汇报仍走最终结论。
- **收件箱来源前缀改为三方且不再说「主代理」**：`［用户插话］` / `［上级代理消息］` / `［下级代理回报］`。嵌套时父是子代理，第 3 层看到「主代理消息」会认错来源；详情视图输入行同步为「用户 / 上级 / 下级」。
- **收尾轮现在真的不带工具**：此前注释写「收尾轮不带工具（模型只能输出文本）」，但每次请求照旧下发完整工具表，模型在收尾轮仍能调 `read_file` / `spawn_agent`，调 `ask_user` 还会空等父代理 120s。现在 `wrapUp` 时工具表传 `[]`（Go 侧三套 body 都是 `if len(tools) > 0` 才写该字段，空数组等价于无工具，不会让服务商报错）；万一模型仍幻觉出工具调用，`runSubToolRound` 一律拒绝并**立即收尾**——否则「拒绝 → 再请求」在收尾轮没有轮次上限兜底。
- **未做（记在方案文档 §5）**：终态记录 LRU 20 与并发上限仍按全窗口计。

### 新功能（AI 子代理 · 团队树工具与级联停止）

- **新增只读工具 `agent_tree`**：返回调用者所在的智能体团队树——主代理看到整棵任务树，子代理只看到自己这一支；每行带各层级代理 id、名称、层级、状态、沙箱档、轮次与任务摘要，并标注「你」是哪一行。嵌套代理的 id 因此能回到主代理手上，可据此 `agent_send` / `agent_stop` / `agent_compact` 指定目标。
- **`agent_stop` 支持级联与全停**：带 `agentId` 时连同它的全部下级（子代理 / 孙代理 / 更深层级）递归停止；省略 `agentId` 时停掉本会话任务树里所有仍在运行的代理（含嵌套层级），结束语列出每个被停代理。此前主代理只拿得到直接下级的 id，孙代理停不了。
- **用户手动停止同样递归**：详情视图的停止按钮会连同该代理派出的下级一起停；主会话停止原本就按根会话全量停。代理自身正常收尾 / 循环守卫自动停止仍是单点停止，不级联。
- 护栏：`test/ai/ai-team-model.test.mjs`（团队树文本 / 自身标注 / 子代理视角裁剪）、`test/ai/ai-subagents.test.mjs`（`subTreeIdsOf` 多级 / 成环 / 脏数据）；工具接线由 `ai-tool-wiring.test.mjs` 全量对账。

### 新功能（AI 响应空闲超时可配置）

- **设置 → AI 助手 → 超时与重试新增「响应空闲超时」**：默认 120 秒，可选 30 秒 / 1 / 2 / 5 / 10 / 30 / 60 分钟。此前 120 秒是硬编码常量，慢模型或长思考一旦连续 120 秒无输出就被误杀；现在可调大，最长 60 分钟。语义仍是「连续无数据才中断，收到数据重新计时」，工具执行 / 等待提问期间照常喂看门狗不会误杀。
- 超时随请求下发（`aitransport.Config.IdleTimeoutSec`），主对话、子代理、群聊全路径覆盖；Go 侧二次钳制到 [30, 3600] 秒，导入导出同步该字段，旧配置缺字段零迁移。超时错误文案改为带实际秒数（如「AI 响应超时（300 秒无数据）」）。

### 调整（AI 计划模式 · 判定收敛为两条门槛）

- **不再按「新增功能 / 跨多文件」触发计划模式**：进入计划模式只保留两种情况——用户明确要求先规划（「先规划 / 给方案 / 别动手」），或动工前必须由用户拍板方案（多种架构路线取舍、接口 / 数据格式 / 交互形态有实质分歧、需求歧义大到不探索无法圈定范围）。新增功能、改动跨多个文件、加设置项一律直接动手；拿不准时也直接动手（用户可随时叫停），模型不再为「要不要进计划模式」反复权衡。
- 系统提示词守则（`ai-system-context.js`）、`plan_mode` 工具描述与工具目录文案三处同步，口径一致。

### 新功能（AI 子代理 · 可选专用模型）

- **设置 → AI 助手 → 子代理新增「子代理模型」**：默认「跟随当前模型」，也可指定任一已配置的模型条目。搜索、审查这类「读得多、结论短」的子代理因此可以用便宜快模型跑，不必和主对话抢同一个贵模型。
- **引用格式与分类器模型同款**（`账号id|模型id`）：解析抽成 `resolveModelRefTarget`（`frontend/src/ai/ai-config-model.js`），所选配置被删除 / 导入半程时自动回退为跟随，不会留下悬空 id。
- **模型在派单那一刻定死**：`spawn_agent` 时写进子代理会话的 `profileId` / `modelId`，因此上下文窗口基数（决定 auto-compact 阈值）、`read_video` 视频能力与真正发出的请求同源——只在请求侧换模型会让窗口基数停在旧值。冷唤醒沿用原记录里的账号 / 条目，中途改设置不会给已派出的子代理换模型。
- **逐次点名（白名单）**：同一张卡片里可再勾 1–3 个候选模型，勾了之后主代理能在 `spawn_agent` 里用 `model` 参数给单个子代理点模型（探索用便宜快的、审查用强的）。只接受候选里的值——模型名、`模型名 · 账号名` 标签、`账号id|模型id` 三种写法都认，同名模型造成的歧义与候选外取值一律**报错并附合法清单**，绝不静默回落成别的模型。三个候选全空 = 关闭，此时 `spawn_agent` 的 def 里连 `model` 参数都不出现（不占 token）。
- **三级优先**：本次点名的 > 设置里的默认子代理模型 > 跟随派出它的会话。孙代理看到的候选清单与主代理同一份（`buildSpawnAgentDef` 动态生成 def，不改模块级常量）。
- 导入导出同步两个字段（自选候选在导出方缺失时保留本地设置）；护栏 `test/ai/ai-config-model.test.mjs` 覆盖引用解析、候选清单去重与失效剔除、三种写法的匹配与歧义处理。

### 修复（子代理 · 嵌套时 background 派单收不回结论）

- **子代理与孙代理现在也有 `wait_agent`**：此前它只在主代理工具表里，子代理用 `mode='background'` 派单后唯一回收路径是结算通知（把结论投回子代理会话再唤醒），实测并不可靠——嵌套测试里一条支线的第 5 层汇报直接丢了。现在「能派单的层」同时挂 `spawn_agent` + `wait_agent`（`ai-subagents.js` 的 `subToolsForScope`）。
- 子代理系统提示补一条纪律：报「授权写根 … Access is denied」是宿主机目录权限问题，改用只读工具并在结论里注明未用命令验证。

### 修复（子代理沙箱 · workspace-write 授权失败只报裸的 Access is denied）

- **失败原因翻成可操作说明**：写根授权失败时新增「目录所有者 ↔ 当前账户」比对（`sandbox_windows.go` 的 `diagnoseGrantFailure`），三种结果分别给出——同一账户仍被拒（查安全软件 / 只读属性 / ACL 保护）、读不到所有者（通用提示）、**目录属于另一个账户**（写 ACL 需要它的「更改权限」WRITE_DAC，附 `icacls "<目录>" /grant "*<当前账户SID>:(OI)(CI)WD"` 补救命令）。
- 触发条件实测：工作区目录由本地 `admin` 账户创建、应用以 Microsoft 账户运行，继承来的 `Modify` 不含 WRITE_DAC，于是每次 `auto` 档子代理执行命令都报「沙箱不可用，命令未执行」。这类目录改不动 ACL 是环境事实，代码只能把原因与补救说清（fail-closed 语义不变，不降级裸跑）。

### 新功能（智能体团队 · 嵌套树折叠视图）

- **「智能体团队」弹层改成树形**：主代理直接派出的子代理、子代理再派出的孙代理按父子缩进 + 竖向细线展示，父行带展开/收起箭头（默认全展开），嵌套关系一眼可见；不再靠副标题里的「第 2 层」辨认。收起父行时副标题显示「N 个下级」，叶子行仍可直接点开详情标签页。列表里没有嵌套（全是第 1 层子代理）时不预留箭头列，保持原来的紧凑排版。
- 父子关系按 `parentSessionId` ↔ 子代理会话 id 还原（运行态 / 终态记录 / 注册表三个来源都带）；父代理已不在列表时回落为顶层并保留层号，脏数据成环不会挂死渲染。纯函数在 `frontend/src/ai/ai-agent-tree.js`，护栏 `test/ai/ai-agent-tree.test.mjs`。
- **深层缩进封顶**：缩进最多到第 4 层（80px，弹层仅 320px 宽），第 5 层起不再右推、改由副标题「第 N 层」标明真实深度，名称列始终留有可读宽度；行内 overflow 兜底，深层长内容不会把弹层撑出横向滚动条。
- **弹层开着时实时刷新**：子代理派出 / 状态变化 / 收尾时直接重绘弹层内容（120ms 节流合并连续事件），不用关掉重开；重建时保留折叠状态、滚动位置与键盘焦点（焦点恢复用 `preventScroll`，不会把列表拽回去）。
- 计时器 / 定时任务共用的 chips 行基础样式未改动，树形样式只作用于智能体团队。
- **「查看详情」→ 团队拓扑标签页**：弹层标题右侧新增入口（悬浮窗没有内容区，不显示），在内容区标签页画**主代理 + 全部子代理**的纵向卡片图：主代理卡带生成状态 / 模型 / 权限档，子代理卡带状态、沙箱档、轮次 / 用时 / token、任务与结论摘要，层级用缩进 + 连接线表达（缩进封顶 8 层，更深靠「第 N 层」补足）；点子代理卡片打开它原有的实时详情标签页。标签页按会话打开、同一会话复用；切走会话后仍显示原会话的团队；状态变化实时重绘并保持滚动位置。纯模型在 `frontend/src/ai/ai-team-model.js`（护栏 `test/ai/ai-team-model.test.mjs`），视图在 `ai-team-view.js`，标签页桥 `bridge/bridge-team-view.js`。

### 新功能（AI 插话 · 真 steer：不打断当前轮，在下一个工具边界注入）

- **生成中三手势**：Enter 排队（现状）、**Ctrl+Enter 插话（steer，不打断）**、**Ctrl+Shift+Enter 抢占（preempt，原「插话」语义：停掉当前轮再发）**；Shift+Enter / Alt+Enter 仍是换行。Ctrl+点击发送 = 插话，Ctrl+Shift+点击 = 抢占。空闲时完全遵循「发送快捷键」设置，不引入抢占。
- **插话不再作废已完成的工作**：steer 条目以 `delivery: 'steer'` 留在消息队列，在**当前轮下一次 model request 边界**（`startRound` 的第 2 次及以后请求）注入——工具批次全部执行完、新的 assistant 占位就位后才落进 `session.messages`，不跳过任何正在执行的工具。请求里包 `user_steer` 模板（「The user sent a new message while you were working…」），**落盘与会话气泡仍是用户原文**（带 `steer: true` 标记，重放 / 导出 / 搜索不受影响）。
- **纯文本回复收尾也续轮**：模型给出 no-tool final response 但队列里还有 pending steer 时不结束本轮——新建 assistant 占位后再发一次请求（不复用已完成的 assistant），插话不会被静默吞掉。
- **窗口竞态静默降级**：轮已结束时插话条目自动改回排队；用户停止 / 抢占则丢弃 pending steer（放弃当前任务），排队消息照旧保留。**停止后的 1.2s 收尾窗口**（流还登记着但已 `stopped`）按轮已结束处理——降级为排队并登记待冲刷，不会入队后又被收尾清掉。压缩中、带文件 / 技能 / 选区附件、以及视频输入不被当前协议支持时，一律降级为排队并提示（避免轮中重组 `<attachments>` 环境块或留下每轮都被拒收的视频消息）。
- **预算保护**：drain 后若请求预计超过上下文窗口 90%，本批插话回滚为排队并提示，不强塞超限请求、也不中断本轮。
- **轮次口径与重放一致**：`steer: true` 随 JSONL 落盘并在重启 / 懒加载后保留（`normalizeMessage` 不丢字段），历史插话仍包 `user_steer` 模板；`lastUserIndex`（重新生成 / 编辑重发）、回合分组、上下文轮数、用量统计的轮数都跳过 steer，插话不会被当成用户发起的新回合。**但插话必须可见**：回合折叠按插话切成多段，插话气泡整条渲染在折叠区外（不随过程一起收起）；会话结构面板把插话列为可定位项，轮号沿用所属回合并带「插话」标签。纯图片 / 纯视频插话补正文占位「（附图）」，模板不会被跳过。
- **队列行**：badge 按车道显示「排队 / 插话」，按钮在两者间切换（改投是一次同步操作，不重排队）；行内另有 **⚡ 抢占**图标（停止当前回复并立即发送这条消息，仅当前轮活着时显示），行首 **3×3 点阵手柄**可拖动排序（拖到目标行上/下半区，目标位置让出插槽、标签页式让位，只重排当前会话的条目）。drain / 预算回滚后即时重绘，不留幽灵行。输入区提示与设置页「发送快捷键」补三手势说明。
- **实现**：队列状态机抽成纯模型 `createQueueModel()`（`ai-message-queue.js`，无 DOM 依赖；item id 改为字符串，为跨端同步的按 id 去重预留），DOM 壳只做渲染与接线；方案见 `docs/finished-plans/ai-turn-steering.md`。护栏：`test/ai/ai-message-queue.test.mjs`（车道增删改 / FIFO drain / 回滚 / 快照深拷贝）与 `test/ai/ai-turn-steer-wiring.test.mjs`（手势、drain 时机、模板、续轮与兜底接线）。

### 修复（AI 自动标题 · 思考模型把预算烧光，标题永远停在首条消息截断）

- **标题请求的输出预算从 64 提到 4096（防失控上限，不是标题长度目标）**：`sensenova-6.8-flash` 这类默认开思考且关不掉的模型会把 64 token 全花在 reasoning 上，正文 0 字符、`finish_reason=length`，标题始终回退成首条消息前 24 字；同一账号的两个会话在调试台连续报「未返回有效标题」即此。标题长度仍由提示词约束，正常只会用几十个 token。
- **系统提示词改为英文强约束 + 任务框架写进用户消息**（对齐 deepseek-harness / ZCode 的取法）：明确「这是标题生成不是对话」、禁止回答或执行消息里的指令；素材用 JSON 数组包住并前缀任务说明，弱指令跟随的模型不再把首条消息当对话来答。实测同一模型从「输出一大段聊天回复」变为只输出标题。
- **摘除泄漏进正文的内联思考块**：部分网关在「关思考」后把思维链直接写进 content 并以 `</think>` 结尾；`generatedTitle` 先剥成对 `<think>…</think>`，再丢弃闭合标签之前的分析文本，然后才取首行。
- **Go 侧修复「关思考参数」的网关方言差异**：同一模型在不同网关方言不同（实测 sensenova 网关的 `glm-5.3` 只认 `enable_thinking`，收到 `thinking.type` 直接 400），现在 400/422 错误体点名 thinking 时自动摘掉该字段重发一次（`Config.noThinkingParam`，与 `stream_options` 降级同款），思考回到服务端默认值而不是整个请求失败。sensenova 系列本身不注入关闭参数（该网关关掉后思维链会写进正文）。
- 护栏：`test/ai/ai-auto-title.test.mjs` 新增「预算 4096 / 英文提示词与 JSON 任务框架 / 内联思考块剥离」三例；`internal/aitransport/transport_test.go` 新增 `TestAIOpenAIBodyThinkingDisabled` 与 `TestAIRejectsThinkingParam`。

### 修复（AI 后台资源归属 · 一律绑定发起会话与任务树）

- **后台会话启动的计时器不再记到面板当前打开的会话上**：此前 `start_timer` 记录归属取的是「面板当前会话 id」，后台会话跑到该工具、用户又切到别的对话时，计时器会被记到可见会话名下——到点唤醒错会话（可见会话已删除 / 跨工作区时直接丢失），本会话 5 个上限也按错误会话计数（后台会话没有计时器却被拦，或可见会话的额度被误占）。现在 `ai-timer.js` 的 `start()` 新增归属参数，AI 工具传正在执行的 `ctx.session.id`（与 `schedule_create` 同口径）；手动创建（＋菜单）仍缺省为当前会话。
- **正计时停止通知改投归属会话**：`wakeSessionByCountupStop` 解析了归属会话却仍走 `sendAppMessage`（内部按面板当前会话起轮）——后台会话的正计时被停止 / 到点自动停止时，通知会落到用户正看着的另一个对话里（对方正忙时则直接丢失）。改走会话信箱 `deliverAgentNotice(归属会话, …)`：忙则排队、闲则静默起一轮，与计时器到点 / 定时任务同一通道。
- **`stop_timer` 只能停本会话树启动的计时器**：省略 id 时此前按整个窗口「唯一运行中」找目标、显式 id 也不校验归属——别的会话可掐掉用户的计时器，还会把它应得的正计时停止通知一起抑制。现在与 `timer_list` 同一可见口径（自身 / 父 / 根 / 最初发起会话），越界明确拒绝；工具描述同步。
- **后台命令与生成任务按任务树查询**：`check_command` 补上与 `stop_command` 相同的归属校验（作业编号 `bg-<序号>` 可猜，输出可能含敏感信息）；`check_gen` 只允许启动会话查询自己的任务。
- **子代理操作按根会话校验**：`agent_send` / `agent_stop` / `agent_compact` 与 `wait_agent` 统一走新纯函数 `subTreeOwned`（根会话 id 相等才放行），别的会话的 agentId 不能投递 / 停止 / 压缩。
- 护栏：`test/ai/ai-timer.test.mjs` 新增「显式归属优先 / 缺省回落当前会话 / 上限按归属会话计数」三例；`test/ai/ai-subagents.test.mjs` 新增 `subTreeOwned` 判定用例。

### 新功能（全局搜索 · fzf 式子序列模糊匹配）

- **全局搜索新增「模糊」勾选（默认关闭）**：范围行里勾上后，查询词按字符顺序出现即可命中（`gsrch` 能搜到 `globalSearch`），适合记不全拼写时找内容。只作用于「工作区文件」，未勾该分类时禁用。
- **先精确后模糊**：同一行先找字面命中（与普通模式完全一致，多命中照旧全部列出）；整行没有字面命中才做子序列匹配，每行至多一条，匹配窗口取「首尾收紧」的最小范围并整体高亮、点击仍精确选区跳转；窗口首尾相隔超过 200 字符视为无意义命中直接丢弃（防长行噪音与预览撑爆）。
- **结果分档排序**：文件名子序列命中 → 字面（连续）命中 → 子序列（离散）命中 → 路径/行号；源码档/产物档的预算分档不变（产物仍垫底、只补空位）。子序列匹配没有 rg 对应能力，模糊模式固定走内置 Go 扫描——共用同一个 3.5 秒预算与 400 条上限，超出仍标「已截断」，大工作区会比对字面搜索慢。
- 实现：`internal/search/fuzzy.go`（正向贪婪 + 反向收紧的最小窗口匹配）与 `SearchWorkspaceFuzzy` 绑定；前端 `explorer/global-search.js` 勾选接线；`core/form-controls.js` 补紧凑行内复选框工厂 `createCheckbox`，该范围行三个勾选一并迁入工厂（裸控件基线 2→0）。护栏：`internal/search/fuzzy_test.go`（窗口收紧 / 大小写 / 中文 / 窗口上限 / 字面优先 / 文件名档位）、`test/explorer/global-search.test.mjs`（勾模糊走模糊接口、取消工作区文件时禁用）、`test/core/form-controls-factory.test.mjs`。

### 修复（权限胶囊 · 菜单贴合展开、去掉多余 tooltip）

- **权限档菜单与「+」附件菜单改为按实测高度贴合触发器向上展开**：此前分别用写死的 `rect.top - 280` / `rect.top - 240` 估算菜单高度，实际菜单高度随内容与缩放变化（权限菜单差出约 80px 空档，附件菜单则可能反过来盖住输入区）。现在共享右键菜单支持 `anchorAbove`——渲染完按实测高度把菜单底边贴到触发器顶边（6px 间隙），视口夹取逻辑不变；定位数学收敛为纯函数 `computeMenuPosition`。
- **「只读访问 / 自动审批 / …」胶囊不再挂 tooltip**：档位说明由菜单本身承担，悬浮气泡只会挡住输入区；`aria-label` 随当前档位同步更新。
- **权限胶囊补上下拉箭头**：它是选择器（点开菜单），不是「计划」那样的点亮式开关——文字后现在固定带 12px 下箭头，与模型 chip 的展开箭头同款。
- 护栏：`test/shell/menu-position.test.mjs`（上翻贴合 / 上方放不下夹取 / 常规 x,y 与越界夹取）。

### 新功能（Git 图谱 · 底部面板新视图）

- **底部面板新增「Git 图谱」视图**（参考 JetBrains Git Log 面板）：左下活动栏新增 `#ab-git-graph` 按钮，点击在底部面板（与终端 / 调试控制台 / 运行面板共用容器）切换到图谱。三栏布局——左栏 ref 树（HEAD / 本地分支 / 远程分支 / 标签 / Worktree，点分支即过滤）、中栏带泳道拓扑的提交列表、右栏提交详情。
- **泳道拓扑在 Go 侧计算**：`internal/gitinfo/graph.go` 的 `assignLanes` 用「最小空闲泳道」算法算好每行提交的 `lane` 与 `throughLanes`（穿线），前端只负责渲染 SVG（竖线 / 分支拐点弧线 / 圆点，按 lane index 循环取主题色板）。已验证直线 / 分叉后合并 / 两条独立分支并行 / 八叉合并（octopus）等拓扑。
- **分页懒加载，默认 500 条/页**：`GitGraphCommits(dir, ref, limit, skip)` 多取一条判断 `hasMore`，滚动到底自动续拉；首次切到该视图才拉数据。提交列表虚拟滚动只渲染可见区。跨页泳道连续性一期不保证（每页独立起 lane，页边界可能有断线）。
- **完整操作集（签出 / 重置 / cherry-pick）**：详情面板提供签出（detached HEAD 会提示）、cherry-pick、重置 soft / mixed / hard（hard 明确警示丢工作区改动）。均为**用户主动 UI 操作**，走只读锁 + 确认弹窗，成功后刷新图谱与 git 状态；不进 AI 的 auto 审批链（`GIT_FLOW_SAFE_SUBCOMMANDS` 是 AI 经 run_command 执行时的令牌，与此无关）。
- **过滤**：顶栏输入框按 subject / sha / author 过滤提交（过滤时泳道列隐藏，因过滤会打乱 lane 连续性）。
- Go 引擎与测试：`internal/gitinfo/graph.go` + `graph_test.go`（泳道算法表驱动、porcelain 解析、写操作参数校验、集成用例）；绑定 `gitinfo_app.go` 五转发；前端域模块 `git-graph/git-graph.js`（factory + deps 注入）+ `test/git-graph/git-graph-lane.test.mjs`（泳道 SVG 几何）；mock-backend 五 mock；`wailsjs` 绑定。

### 修复（AI 编辑卡 diff 行号 · 对齐原文件）

- **编辑 / 写入工具卡的 diff 预览显示真实文件行号**：预览只保留改动行前后各 2 行上下文、中间用「…」跳过，渲染端却从 1 连数——文件中间或末尾的改动会被标成第 1、2 行（如 `mock-backend.js` 尾部的改动显示为 1–23）。现在 `buildDiffPreview` 按完整 diff 连好 `oldLine` / `newLine` 随行下发，裁剪与省略号不再重置行号；旧会话没有这两个字段时退回原连数逻辑。`normalizeApproval` 重载会话时保留该字段。
- 护栏：`test/ai/ai-diff-view.test.mjs` 新增「行号按完整 diff 计数，裁剪与省略号不重置」用例。

### AI 面板（查看指令：环境块弱化）

- **应用消息的「查看指令」里，宿主环境块（`<system-reminder>`：任务清单 / workspace_context / 提醒 / 附件）改为弱化显示**：此前展开「查看指令」时，投递唤醒等应用消息的环境块与正文同样式混排，一展开先是一大段注入文本、看不清真正的指令正文。现在环境块单独渲染为灰色小字分区（左侧细边框、更暗背景、最大高度 160px 内滚动），正文保持原样式——**内容一字不删**（「查看指令」的用途就是核对实际发给模型的内容，环境块正是要核对的对象）。判定复用 `splitTurnReminderPrefix`（仅严格形状拆出），非严格形状原样全量显示。实现：`ai-panel.js`（应用消息卡渲染）、`style.css`（`.ai-app-msg-env`）。

### AI 面板（流式工具卡 · 零字节不再显示「接收中 0 B」）

- **参数还没到时不报 0 B，改报「等待参数…」**：工具调用头（name）通常远早于参数字节到达，而部分模型端点会把整段工具参数憋完再回放（实测 `token.sensenova.cn` 的 `sensenova-6.8-flash`：参数静默 8–15 秒后 3.7 KB 在 244 ms 内刷完，同账号 `deepseek-flash` 与 DeepSeek 官方则持续增量）——这段时间原先恒定显示「接收中 0 B」，看着像计数器坏了 / 卡死。现在零字节显示「等待参数…」，收到首块后照旧报体积（`+N −M` 的 ± 同样是参数到达后才可算，节奏由端点决定）。实现：`ai-tool-cards.js` 新增 `liveToolStateText()`（`liveToolParts` 补 `chars` 原始长度，不用格式化后的 `size` 反推），占位行建行与原地更新两处共用；护栏 `test/ai/ai-tool-cards.test.mjs` 新增 1 例。

### 修复（模型账号编辑器 · 下拉不再露出系统原生菜单）

- **「接口协议 / 代理 / 推理强度」改用统一的浮层下拉**：这三个 select 是 `index.html` 里的静态原生控件，只有 `.mcfg-select` 外观类、从未走设置页的 `enhanceSelect` 增强（扫描器只覆盖 `.settings-pane select`），展开时露出 WebView2 的系统菜单，和弹窗里的自绘控件像两套。现在打开编辑器时增强成与设置页同款触发器（宽高、圆角、底色对齐 `.mcfg-input`），并给三个控件补了 `aria-label`。
- **重复增强改为同步触发器文本**：程序化改 `select.value` 不派发 change，此前触发器标签会停在旧值。`enhanceSelect` 对已增强的 select 再调一次时改为刷新标签（仍幂等、不重复包装），面板刷新后可补一次调用。

### 修复（会话快照不落盘 · 关掉的标签重启又回来）

- **关掉标签后重启，标签不再复活**：`createEditorGroups` 的导出对象在 98365fb 的前端拆分中丢了 `editorGroups` getter，`main.js` 注入给 `session-restore` 的是 `undefined`；`serializeSession` 遍历它时抛 `TypeError`，被 `saveSessionNow` 的空 catch 静默吞掉——此后**每次会话保存都失败**，localStorage 里永远是拆分前的旧快照（含已关闭的 wav / mp4 标签），重启就从旧快照恢复。
- **保存失败不再静默、调试台可见**：`saveSessionNow` 的异常分支改为记一条 `会话保存失败：…`（带 stack）warn；同时 `logFrontend` 从「只写应用日志文件」改为**双写应用日志 + 调试台**——此前模块里直接 `logFrontend('warn'/'error')` 的失败（插件市场、更新检查、会话恢复…）在调试台里完全是黑箱。`console.*` 补丁与全局错误钩子带 `fromConsole` 标记，不会重复入面板。
- 护栏：`test/shell/session-restore.test.mjs` 新增「editorGroups 必须是活引用导出」接线断言、「保存失败写 warn 并返回 false」与「logFrontend 双写调试台」三例；测试 harness 同步改为 getter 注入，与 main.js 一致。

### 修复（媒体文件默认视图 · 重开不再落到二进制）

- **图片 / 视频 / 音频文件重开时固定回到自己的视图**：启动恢复会按上次会话的 `modes` 逐文件复原视图，而媒体文件上次可能是二进制（旧版本还没有该媒体视图，或播放失败自动回退留下的），于是每次重开都「默认」进十六进制。现在媒体文档的首屏视图收敛到 `core/formats.js` 的 `defaultMediaMode`（单一来源）：`createDoc` 初始 mode、会话保存、启动恢复三处都走它，旧的持久化 `binary` / `text` 不再盖掉媒体视图。手动切到二进制 / 文本视图仍可用，但不会跨启动变成默认。
- 护栏：`test/core/formats.test.mjs`（defaultMediaMode 优先级）、`test/editor/audio-view-wiring.test.mjs`（恢复 / 保存两侧接线）、`test/editor/video-view-wiring.test.mjs`。

### 修复（会话投递入口口径 · 侧栏 / ＋菜单不挂会话身份）

- **侧栏「投递」与 composer「+」菜单改为用户全局入口**：不再把面板当前会话当发起方——列表里当前会话照常可选（此前被当前会话与发起方两道过滤连挡，想投给它时永远找不到），卡片标注「用户消息 · 来自用户」，不再写「会话 X「标题」」。
- **消息操作条 / 支线标签页仍按会话发起**：只排除真正的发起方；从支线标签页转发消息时，面板当前会话不再被误当成发起方而漏掉。
- 护栏：`test/ai/ai-agent-notices.test.mjs` 新增 excludeSessionId 口径与全局投递（不判 self、卡片「来自用户」）两例。

### AI 子代理（命令沙箱 · Windows 受限令牌 + ACL）

- **子代理能执行命令了，写入由 Windows 系统层圈死**：此前子代理只有读工具，跑测试 / 看 `git log` / 验证构建只能由主会话串行做。现在子代理可用 `run_command`（前台）与 `background_command` / `check_command` / `stop_command`（后台），执行时子进程跑在受限令牌（`WRITE_RESTRICTED` + Low 完整性）里：**写效应只允许落在本次任务的工作区根**（有隔离 worktree 时就是那个草稿目录）**与一次性的私有临时目录**内，其余写入由系统拒绝；读、网络不受这层限制（`enforcement` 如实标 `partial`）。
- **档位与父会话一致**：只读访问 / 每次询问 → `read-only`（一个写根都不给，含私有 temp）；自动审批 → `workspace-write`；完全权限 → 不圈定。**子代理永不弹审批卡**（后台子代理没有「人」可问，与 dsh 的 approval pin never 同语义），但项目里写死的 **deny 规则照旧生效**（只取 deny，不问、不跑分类器）。
- **沙箱里没有 bash**：实测 Git Bash（Cygwin）在受限令牌下无法启动——它要在 `\BaseNamedObjects` 建目录对象、按用户 SID 建共享内存，而 restricting 列表里没有用户 SID。所以沙箱档的 shell 固定为 PowerShell（回退 `cmd`），卡片与工具结果如实显示实际 shell（`PowerShell 7` / `Windows PowerShell` / `Command Prompt`）与 `沙箱：workspace-write（partial）· 写根：…`；子代理系统提示也提前声明「用 PowerShell 语法，不要用 ls / grep / sed」。
- **不可用就不跑（fail-closed）**：受限令牌、ACL 或 Job 建不起来时直接报「沙箱不可用，命令未执行」，绝不降级裸跑。后台作业退出后自动撤销临时目录授权并删除目录。
- **操作记录可查**：`ai.tool` 新增两种 status —— `sandbox-denied`（命令失败且 stderr 命中「拒绝访问 / Access is denied / Permission denied」等特征，识别 UTF-8 与 GBK 两种输出）与 `sandbox-unavailable`（沙箱建不起来）；成功执行记 `done` 并附 `sandbox` 档位。**后台作业同样能分类**：作业退出时按缓冲里的 stderr 行判定，结论走 `AICommandJobStatus.sandboxDenied`，`check_command` 轮询到就把这次调用记成 `sandbox-denied` 并在结果里说明。子代理的工具执行此前**只在「超出只读范围被拒」时留痕**，现在每次执行都记（子代理命令无人可问，留痕是唯一审计面）。
- **看得见、也掐得断**：团队弹层里每个子代理的副标题在原来「沙箱 …」文字的位置显示一枚描边档位胶囊 `只读 / 可写 / 完全`（读派出时定死的档位，未知值原样回显；只读中性、可写强调色、完全橙色警示）；`stop_command` 增加归属校验——只能停**本任务树**起的后台作业，子代理不能顺手掐掉别的会话的作业（越界确定性拒绝）。
- **授权残留可自己清**：`workspace-write` 会给工作区目录留下能力 SID 的授权 ACE、Everyone 的「禁止删除子项」deny 与 Low 完整性标签，跨会话复用、不随退出撤销（撤销会让下次重新传播整棵树）。这些痕迹 **`icacls` 撤不掉**（能力 SID 是派生的 `S-1-4-x-y`，解析失败报 1332），现在可在 设置 → 权限 →「子代理命令沙箱」检查并清除；清除只删完全匹配本应用的条目，用户自己的权限原样保留。
- 已知代价（如实说明）：工作区树被打上 **Low 完整性标签**后，其它以 Low IL 运行的进程也能写它；首次授权是 eager 全树传播（大目录几十秒）；FAT / exFAT 卷不能作为写根；硬链接别名可绕过能力 SID。
- 护栏：Go `internal/sandbox` 13 例（令牌 / 授权 / 幂等 / Job / 扫描撤销）+ `internal/cmdbridge` 10 例（前台与后台沙箱执行、写根外拒绝、拒绝分类、后台拒绝标记）；前端 `test/ai/ai-subagent-sandbox.test.mjs` 11 例（档位映射、写根来源、工具挂载、执行分支、留痕、残留文案、HUD 与归属校验）。

### AI 工具（read_file 路径纠错）

- **读不到文件时直接告诉模型同名文件在哪**：`read_file` 失败且错误确属「不存在」（Windows / Go 的 not-found 文案，目录 / 过大 / 二进制不误判）时，按 basename 在范围根扫一遍并返回「同名文件在以下位置（可直接用它们重试 read_file）」，一轮改对路径；没有同名则引导用 glob 找相近文件名。此前只回 Go 的原始英文报错，模型（把 test/ 镜像位猜成 src/ 是最高频姿势）得再花一轮 glob 才能找回。纯逻辑收在 `ai/ai-path-hints.js`（deps 注入 IO），护栏 `test/ai/ai-path-hints.test.mjs` 6 例。

### 修复（AI 流式中断可读化 · 自动重试）

- **网关掐断 SSE 时自动重试，不再只显示 `unexpected EOF`**：长生成（如一次「整体替换大数组」的 `edit_file`）被网关/代理中途断开时，Go 只返回 `io.ErrUnexpectedEOF`（chunked 流缺终止块）。现在传输层把它标成 `ErrStreamTruncated`、`ai-error` 载荷带 `retryable`，文案翻成「AI 流式响应被服务端提前断开（unexpected EOF）：通常是网关或代理在长生成中超时、掐断了连接……大段改动建议拆成多次小改动」；解析失败、业务错误体等原有文案不变，断开前已收到的增量照常保留。
- **主面板自动重试断流轮次**：收到可重试的断流错误时，把本轮半截正文 / 思考 / 工具参数整轮作废，换一条空 assistant 就地重发（与「空回复自动重试」同一条路，不新增用户消息），状态条提示「流式连接被中断，正在自动重试（n/2）…」；预算取设置里的重试次数、上限 2 次，`retryMax=0` 视为关闭。群聊 / 子代理本轮未接入自动重试，仍按原样显示错误卡。
- 护栏：Go `TestAIStreamUnexpectedEOF`（文案 + `ErrStreamTruncated` 哨兵 + 断开前增量不丢）、`TestAISendChatMarksTruncatedStreamRetryable`（`ai-error.retryable` 接线）；前端 `ai/ai-stream-retry.js` 纯函数 + `test/ai/ai-stream-retry.test.mjs`。

### 修复（内嵌浏览器闪退兜底 · 崩溃报告落日志）

- **WebView2 完成回调的 use-after-free**：`ExecuteScript` / `CapturePreview` 超时返回后，原生侧晚到的完成回调仍会写 handler（快照轮询用的正是 300ms 短超时，页面忙时极易踩中）；此前 handler 超时后即失去引用，被 GC 回收后回调写进已释放内存，进程可能在随后任意时刻被堆校验/野指针直接终止——无日志、无 WER（2026-11-17 打开网页闪退的排查轨迹）。现在 handler 在「创建 → 回调到达」期间登记在存活表里，回调后释放；重复派发只留第一份结果且不阻塞原生线程（`browser_com_windows.go`，护栏 `browser_com_windows_test.go` 三例）。
- **WebView2 回调里的 panic 不再击穿整个进程**：go-webview2 本地补丁补齐——`EnvironmentCompleted` / `CreateCoreWebView2ControllerCompleted` / `MessageReceived` / `NavigationCompleted` / `ProcessFailed` / `PermissionRequested` / `WebResourceRequested` / `AcceleratorKeyPressed` / `ContainsFullScreenElementChanged` 各回调统一加 recover，出事只走 `errorCallback` 隔离实例并记日志；顺带修掉两处上游会静默杀进程的洞：controller 创建失败后继续解引用 nil（`CreateCoreWebView2ControllerCompleted`，改为直接放弃初始化），`WebResourceRequested` 取请求失败走 `log.Fatal`（改为只报告）。主 WebView2（Wails 运行时）也套上了同一层兜底。
- **崩溃报告写进当次运行日志**：`applog.Start` 打开日志后调用 `debug.SetCrashOutput`（并 `SetTraceback("all")`）——未恢复的 panic / 致命错误此前只写 stderr，GUI 进程没有控制台，症状就是「进程瞬间消失、日志空白」；现在死因与全 goroutine 栈直接落在 `logs/<时间>.txt`。
- **浏览器生命周期留痕**：实例创建（含 profile 名）/ 导航目标 / 关闭各记一条 INFO；页面加载失败记 WARN 并带 `WebErrorStatus` 与 URL，下次闪退能直接看出死在哪一步。

### 修复（内置 MCP 示例脚本自动补回 · 日志噪音收敛）

- **已注册的内置 MCP 示例服务器不再永久失效**：设置 → 存储与清理把 `builtin-mcp-samples/` 当缓存删掉后，`mcp.json` 里的绝对路径还在，`ocr_windows` / `tts_sapi` 每次启动都初始化失败、重连十次后放弃，并把 PowerShell 的启动横幅当成「MCP stdout 丢弃非 JSON 行」刷满日志；此时「重新安装示例」又被「已存在同名服务器」拦住，用户没有出路。现在 spawn 前自愈：`mcp.PrepareServer`（根壳注入 `mcpsamples.EnsureServerScript`）在每次连接 / 测试连接 / 面板列工具前，按配置里的**原路径**补回内嵌脚本（版本升级换了释放目录也一并覆盖），只认 `<应用数据>/builtin-mcp-samples/` 下我们自己释放的那份，用户自备的同名脚本一律不碰。`MCPInstallSample` 遇到同名条目但脚本缺失时改为只补脚本、不动用户改过的授权与环境变量，并返回 `repaired`。护栏：`internal/mcpsamples` 三例（补回内容 / 不碰外部副本 / 修复不改配置）+ 根壳接线守卫。
- **日志不再被 MCP 启动横幅刷屏**：`rpcConn.serve` 对连续非 JSON 行改为「首行带预览 + 结尾一行汇总行数」，一段十几行的 shell 启动横幅现在只留两条记录（此前逐行 WARN，一次起不来的 server 能刷出上百行把真实失败原因挤掉）；判定协议错乱时直接由错误文本带行数，不再重复记一条。护栏：`TestRPCConnGarbageLoggedOncePerRun`。

### AI 面板（支线对话标签页补全 · 视图层抽取）

- **支线对话标签页能力补齐**：标签页消息动作此前只放行审批类，现在复制 / 分支 / 重试 / 回到某轮 / 新建支线 / 带回主对话 / 投递全部可用；「编辑重发」把原文回填到标签页输入框（原消息的图片 / 视频随发送自动带上，截断在发送时进行，与面板 pendingEdit 同语义）。「带回主对话」现在附带支线的改动文件清单（同路径聚合 +/−，超过 12 个折叠计数），母会话能直接看到支线改了哪些文件。
- **标签页的增量更新与统计**：宿主登记表（viewHosts 真表）落地——工具卡挂载 / 原位刷新 / ask 倒计时现在直接写进支线标签页容器（此前只能靠 400ms 全量轮询兜底），回退 / 清空 / 压缩收尾等会话数据改动会主动通知标签页重绘。标签页底部新增与面板同口径的统计行（轮/步、tok/s、累计、缓存命中、上下文占用），输入框支持 slash 子集（/compact、/clear、/context、/help），压缩期间也走轮询推进。
- **视图层抽取（纯重构，行为不变）**：用量弹层与统计逻辑收进 `ai/ai-usage-ui.js`（`sessionUsageTotals` / 格式化三件套成为唯一来源，附 6 例单测）；行级 diff 核（LCS / ± 统计 / 预览裁剪）收进 `ai/ai-diff-view.js`（附 7 例单测）；双层级模型选择器收进 `ai/ai-model-picker.js`；输入框右键编辑菜单收进 `ai/ai-composer.js`；对话日志落盘机（Markdown 构建 / 图片归档 / 防抖排队）收进 `ai/ai-session-disk.js`；AI 对话框基建四件收进 `ai/ai-manage-dialogs.js`；会话结构定位条控制器收进 `ai/session-outline.js`。`npm test` 965/965、`vite build` 通过。

### AI 面板（上下文注入布局：动态块随用户消息落盘）

- **每轮环境块移出系统提示词，改随起轮的用户消息以 `<system-reminder>` 前缀落盘**：`<workspace_context>`（活动文件 / 光标 / 选区 / 可见范围 / 已打开文件）、`<task_todos>`、`<task_reminders>`、`<attachments>` 四块此前拼在系统提示词尾部、每轮都变——服务商的前缀缓存按字节前缀匹配，系统提示词在最前面，尾部一变，**后面整段历史每轮全价重算**（长会话白白多付一个数量级的输入）。现在 `turnContextBundle`（`ai-system-context.js`，同步实现）在起轮时冻结一份块，拼进用户消息 content 后随 JSONL 落盘；系统提示词只剩稳定段（基座 / 人设 / AGENTS.md / 记忆 / 偏好 / 技能 / 环境变量 / 工具目录 / 守则 / 输出语言），每轮完全一致、历史追加式增长，缓存可整段命中。注入开关（范围根 / 活动文件 / 光标 / 可见范围 / 打开文件等）语义不变，只是块的位置变了；旧注释里「稳定 → 动态排序」的妥协随之删除。
- **新增纯函数模块 `ai-turn-reminder.js`**（与 `ai-quote.js` 同架构）：`wrapTurnReminder` 包装（内容里的 `</system-reminder>` 中和为全角斜杠防提前闭合；无任何子块时返回空串，不生成空包装）、`splitTurnReminderPrefix` 只认严格形状（开头紧跟四个已知子块标签之一，用户手写的同名标签不误判）。所有展示/派生路径统一经它剥块：气泡渲染、编辑重发（`editLast` / 支线编辑）、导出 Markdown、会话日志、`session_search` 片段、`session_read` 摘要、复制消息、右键「引用整条消息」、自动标题取名——这些地方此前会把环境块当正文带进输入框 / 剪贴板 / 导出文档 / 标题请求。护栏：`test/ai/ai-turn-reminder.test.mjs`（5 例，含中和与严格形状），`ai-system-context.test.mjs` 断言改为「系统提示词不含动态块、turnBlock 含」，`ai-quote.test.mjs` 接线护栏同步为「先剥环境块再拆引用」。
- **附带行为变化**：① 文本附件（文件 / 引用 / 技能正文）现在随消息进历史，后续轮次模型仍能看到（此前只在该轮系统提示词里，下一轮即消失）；② 打字态的上下文估算不再包含当轮的块（块尚不存在），发送预检与落盘后估算口径不变；③ 跨会话搜索索引（Go 侧 SQLite）仍索引块文本，片段展示已在前端剥离，索引层剥离留作后续。

### AI 群聊（多智能体圆桌）

- **智能体（设置 → AI → 智能体）**：群聊成员数据层——每个智能体绑定「账号id|模型id」，配职责 / 人设正文 / 回复风格 / 温度 / 颜色，名字全局唯一（无空白与 `@`、`all / everyone / 全体成员` 等保留词拦截），`slowTier` 开关给不暴露 reasoning 能力的兼容端点手动按思考档计时（预检徽标同步）；删除不级联，群内显示「已删除成员」。存 `ai-config.json` 的 `agents[]`，上限 32 个；「可作为主持人」标记的成员在群创建时可被选为主持人（无主持人智能体时提供「一键创建默认主持人」）。
- **群聊（AI 侧栏「会话 | 群聊」→ 新建群聊）**：多智能体圆桌——用户提议题，主持人（AI 独立 / 成员兼任 / 我来主持，轮计划或逐句调度）安排多个不同模型的智能体按轮多轮讨论，成员必须回应彼此并输出结构化立场块（同意 / 反对 / 补充 / 存疑 + 要点 / 担忧 / 疑问），轮末复盘更新讨论看板并判定收敛，产出结构化纪要（看板模板 0 次调用或主持人润色），可复制 / 导出 Markdown / 带回当前 AI 会话。创建时逐成员红黄绿兼容性预检（上下文 / 思考档）与预计调用量；串行轮保证互相回应；超时跳过不报错（首次 45s / 思考 90s，总 180s / 240s，整场 15min，宽松预设可选）；**共享群聊对话永不自动压缩**——某成员窗口装不下即停止参与（不阻塞其他成员），手动「压缩群聊数据」生成摘要 + 截止点且最近 1 轮全文保留、原始日志不删；私有过程（思考链）按成员独立日志、仅本人与用户可见。用户可随时插话、`@点名`（强制进下一次调度）、`@全体成员`、暂停 / 继续 / 结束并总结；讨论看板抽屉实时展示议程 / 立场 / 共识 / 分歧 / 未决 / 行动项（任务模式可增改状态）；辩论 / 评审预设给成员分配正方 / 反方 / 评审角色。群聊打开为内容区标签页（最多 3 个，关闭不停止讨论）。存储在独立 `ai-groups` 根（复用会话存储引擎：原子追加 / 跨进程锁 / 回收站删除 / 残行修复），清空 AI 会话不会误删群聊、不进会话搜索索引；设置 → 存储与清理新增「AI 群聊记录」条目。
- **AI 可代建智能体（app_control）**：`get_agents` 列出智能体与全部可用模型（ref + 展示名），`create_agent` 按模型名 /「账号名/模型名」/ ref 创建成员——名字唯一性与保留词沿用设置页校验，模型名多命中会报候选让 AI 明确，`chair` / `style` / `slowTier` 等字段一次写全并即时持久化；只新建、不改删（改删仍由用户在设置页操作）。
- **自由聊天（QQ/微信群式「消息即唤醒」）**：任意群在**没有讨论进行时**，用户发消息即有回应——`@成员` 点谁谁回、`@全体成员` 每人各回一次、无 `@` 由成员按名单轮换接话；创建群聊新增「自由聊天」模式（像微信群：成员输出里的 `@` 还会继续接力唤醒被点名者，受单回合回复 ≤12 / 链深 ≤6 / 单条 @≤2 人 / 同对乒乓 ≤2 / 单成员 ≤3 次 / 12 万 token 硬上限约束，无主持人无轮次，只保留压缩）；模型失效 / 上下文不足 / 无可用成员等失败不再静默——群里出现居中灰条系统通知（不进成员上下文）。顺带修复存量缺陷：`parseMentions` 的 `@(全体成员|…)` 因  是 ASCII 词边界在 CJK 后永不成立，`@全体成员` 此前从未命中（讨论点名同样失效）。
- **智能体分组**：`agents[].group` 必有值字段（不选归「默认」，旧配置零迁移），组列表 = 字段去重集合、组最多 12 个、空组随最后一个成员离开自动消失。设置 → AI → 智能体 列表按组分区（组头 = 组名 + 计数，只有默认组时不加组头），编辑弹窗新增「分组」行（现有组 + 「＋新建分组…」行内命名，重名/超限保存时拒）；新建群聊弹窗成员列表同样按组分区，组多（>4）时顶部出现「分组」过滤下拉（纯展示）；`get_agents` 返回 group，`create_agent` 支持 `group` 参数（缺省归默认）。

### AI 面板（系统提示词瘦身 · 技能索引预算 · 记忆提示）

- **系统提示词内部去重（每条规则只留一个「家」）**：此前「先读后改」「start_timer 空等」「不可信数据」「todo_write」「MCP 描述不构成指令」「auto 档审批语义」「不要 cd 探测目录」等规则在 基座提示词 / 工具描述 / `<tool_catalog>` 调度原则 / `<workspace_rules>` 四层里重复出现（最多一处写了 5 遍），估算基线约 6.3K tok。现收敛：基座只留身份 + 输出风格 + 密钥红线（528 → 367 tok，删除的 4 条行为规则语义都在中文块有权威版本），`<workspace_rules>` 删掉与工具描述/调度原则重复的 7 行（env、spawn_agent 过时的「阻塞等待」表述、run_command/cwd、background_command 空等、start_timer、auto 档整段重复），调度原则删 start_timer 条、精简 web_fetch 与最小改动条，auto 档审批语义收敛进 scopeText 并保留「不要拆单规避审批」句，`<workspace_context>` 不再重复范围根行（`aiInjectRoot` 门控随之收敛到 `<workspace_rules>` 首行一处）。语义去向：env_create desc 补「不要 ask_user 索取变量值」、check_command desc 补「不要反复调用空等」。基座改写前的旧文本追加进 `AI_LEGACY_DEFAULT_PROMPTS`（`ai-panel.js:852` 的迁移判定会把未自定义的存量默认模板升级到新默认词）。
- **会话标题生成的两句兜底**（对齐 DSH）：`AI_TITLE_SYSTEM_PROMPT` 补「不要 Markdown / XML / 终端控制符」与「没什么可命名时（如纯问候）仍返回尽力而为的短标题，不要解释、不要答话」——此前发「你好」时模型偶尔答话而不是给标题。
- **技能索引设预算（防「技能装多了索引爆炸」）**：`<skills>` 索引此前全量拼接所有技能描述（装 100 个市场技能 ≈ 9K tok）。现三层：① 单条描述超 120 字截断为头 70 + 尾 50（`truncateSkillDescription`，保住开头目的句与结尾「当…时使用」触发句，纯函数可测）；② **内置技能全量必列**，用户技能上限 `skillIndexMaxUser`（设置 → AI 助手 → 项目与记忆「技能索引 · 用户技能上限」，1–100 默认 100，ai-config.json 持久化、导入导出同步），溢出行「另有 N 个技能未列出：用 skill_list 查看全部」；③ 技能管理对话框每行新增「索引」开关（`createSwitch` 合规控件），关掉只隐藏索引行——仍可输入框附加与 `skill_use` 加载（`config.hiddenSkills`，与 `disabledSkills` 同按名小写匹配）。
- **新增 `skill_list` 工具**（只读，所有档位与计划模式可用）：列出全部技能的名称 + 一句话描述（按来源分组，已禁用 / 不在索引的标注），索引截断时模型用它发现长尾；描述写明「不要用它加载技能——加载用 skill_use」。接线全套（def + 目录 + toolsForScope + executeTool + 工具卡「技能目录」book 图标），目录一致性 / 档位并集 / 执行分支 / 工具卡 / 参数提及守卫自动覆盖。
- **空记忆不再「整块消失」**：MEMORY.md 读不到或为空时注入占位引导块（记忆区路径 + 「值得跨会话保留的事实用 memory_write 落盘并同步更新 MEMORY.md 索引」），`meta.memory.placeholder` 标记；估算面板「系统注入」行占位态显示「空索引占位」且不再与「记忆未注入」错误并存；`<workspace_rules>` 补一条 memory_* 使用守则（写入时机 + 先 memory_list），与 preference_* 同级。顺带修正 `memory_write` 参数描述 256KB → 60KB（与实现截断一致）。护栏：`ai-system-context.test.mjs` 新增 8 例（截断 / 预算 / 溢出行 / hidden / 占位块 / 范围根去重 / auto 收敛 / 守则行增删）。

### AI 面板（会话重命名动作）

- **app_control 新增 `ai_rename_session {title,id?}`**：AI 可直接重命名 AI 会话——此前只有用户手动入口（右键列表项 / 标题栏菜单），AI 想改个不准确的默认标题只能删会话重建（丢上下文）。**`id` 可省略，缺省改调用者自己所在的会话**——`runAppAction` 第 4 参注入调用者会话 id（`executeTool` 的 `ctx.session`），桥接按「显式 id > 调用者自己 > 面板当前查看的会话（兜底）」解析目标，后台会话改自己标题不会误改前台会话；改其他会话时从 `get_ai` 的会话信息或跨会话搜索结果获取。`get_ai` 同步修正：返回 `callerSessionId` / `viewingSessionId` / `callerIsBackground`，`session` 块标注为「面板当前查看的会话」（不一定是调用者自己的），后台调用时模型据 `callerIsBackground` 辨识、要改自己标题用 `callerSessionId`；`get_state` 的会话列表同步返回 `caller` 标记（`active` 只是面板当前查看的会话）。`title` 非空、超 60 字符截断；懒加载 stub 会话先补正文再改名（改名后的 md 日志写盘不能把未载入的历史当空内容写出，与 `bridgeSwitchSession` / `exportSession` 护栏一致），改名即持久化并写盘、重启保留。实现落点：`ai-panel.js`（`bridgeRenameSession` 桥接 + `bridgeGetState` 的调用者语义）、`main.js`（`APP_ACTIONS` 登记 + `runHostAppAction` case + `runAppAction` 第 4 参）、`ai-constants.js`（cadt-ui 技能动作表 + `get_ai` 文案）。护栏：`ai-app-actions.test.mjs` 三方对账（技能表 ↔ APP_ACTIONS ↔ 分发，自动覆盖新动作）。方案存档 `docs/finished-plans/ai-rename-session.md`。

### AI 面板（显示方式只归用户 · 新标签页展开编辑区）

- **显示方式不再被自动或静默改动**：`settings.aiFloatMode` 是全局持久设置，只有用户能从面板 [...] 菜单 / 设置页 / 视图菜单改。删掉两条越权路径：① 面板标题栏的**双击切全屏**手势（原来直接 `applyMode(..., true)` 落盘——双击会话标题想选中文字、或随手双击头部留白，都会把「全屏」写进设置，下次打开就是全屏）；② 子代理详情 / 支线对话打开内容区标签页时的 `setMode('dock')`（程序替用户改布局，用户切回全屏又会被下一次开标签页打回停靠）。配套：`aiPanelSide` 从 `APP_SETTING_RULES` 摘除（`aiFloatMode` 本就不在），AI 的 `set_setting` 再也写不到面板形态，技能说明写明「显示方式与停靠侧永远不可写」。护栏 `frontend/test/ai/ai-panel-mode-lock.test.mjs`。
- **新增设置项「打开新标签页时展开编辑区」（默认开）**：停靠分屏下编辑区被收起时（手动点收起条或 AI 让位），任何新标签页打开都会自动展开——文件、浏览器、子代理详情、支线对话、后台终端一律经 `activateDoc → updateDocChrome → revealEditorForContent` 收敛到这一条判定；全屏 / 悬浮形态不展开（内容区本来就看不见）。判定是纯函数 `shouldExpandEditorOnTab`（`ai-auto-collapse.js`，`enabled` 缺省即开、`mode` 必须是 dock），设置页入口在 设置 → AI 助手 → 界面，`ai-opt-expand-editor-on-tab`。护栏：`ai-auto-collapse.test.mjs`（判定表 4 例 + 判定接线 + 设置四处齐全）、`ai-panel-mode-lock.test.mjs`（形态切换只剩菜单一条路 / 标签页出口不按形态改行为）。

### 编辑器（视频视图）

- **mp4 / webm / mov / m4v / mkv 不再当「二进制文件」看十六进制，标签页直接出播放器**：AI 生视频产物（`.cadt/gen/video/`）、录屏、下载的片段此前打开都是 hex dump，想看得先用系统播放器；现在这类文档多一档「视频视图」（`<video controls preload="metadata">`，打开不自动播放），视图下拉里可在视频 / 二进制 / 文本之间切。播放源**不读 base64**，复用阅读模式与 HTML 预览那条预览资源通道 `/__local/<token>/…`：按工作区（或文件所在目录）注册目录 token，Go 侧 `http.ServeFile` 天然处理 Range 与 HEAD，拖进度条不重读整片。Go 侧只加分类（`internal/fileio` 的 `videoExtensions` + `isVideoFile`：扩展名、ISO BMFF 的 ftyp 品牌、EBML 头三路判定；`FileData.Video`），`Image` 与 `Video` 互斥且**扩展名明确是容器时优先视频**（`isImageFile` 会把 `hevc` 品牌位的 mp4 当 HEIF 静态图）。解码交给 WebView2：H.264/AAC、VP9、AV1 能播；HEVC/H.265 依赖系统「HEVC 视频扩展」，**解不了时按 `MediaError` 码给原因并自动退回二进制视图**，不静默黑屏。生命周期：切标签 / 切视图先 `pause()`（保留播放位置），关标签与「重新加载」调 `releaseVideo` 断源再摘节点，否则隐藏面板里音频还在响。实现落点：`internal/fileio`、`core/formats.js`（`video` 驱动 + `videoExtensions`）、`core/fileicons.js`（`video` 图标 + mp4/m4v/webm/mov/mkv/avi/flv/wmv/mpg/mpeg/m2ts/3gp/ogv 扩展名映射，`.ts` 仍归 TypeScript）、`writing/writing-ui.js`（`VIDEO_VIEWS` / `viewLabel` / `viewDisabled`）、`editor/editor-groups.js`（`createDoc` / `createDocEditor` / 视图图标 / 切标签暂停 / 关标签释放）、`editor/editor-split-preview.js`（`createVideoView` / `videoSrcFor` / `loadVideoPreview` / `enterVideoView` / `releaseVideo`）、`shell/mode-switch.js`、`editor/editor-doc-extras.js`（不弹「二进制文件」横幅）、`editor/editor-menus.js`（不接管右键）、`style.css`（`.video-*` 覆盖层与 `.fi-video` 图标配色）。护栏：`video-view-wiring.test.mjs`（9 例接线 + 样式 + 图标映射）、`TestOpenFileVideoClassification`（真 mp4 / webm / HEVC 品牌位 / HEIC / PNG 分类）、`TestPreviewAssetRangeRequest`（206 + Content-Range + HEAD）。已知边界：单文件仍受 100 MB 打开上限；Wails 在 Windows 上把响应体整体缓冲后交给 WebView2，几十 MB 可用、上百 MB 会明显占内存。

### 文件树与标签页（用默认应用打开）

- **右键标签页或文件树里的文件 / 目录，多了「用默认应用打开」**：此前只能「在文件管理器中显示」再双击。新 Go 绑定 `App.OpenWithDefaultApp` 走 `internal/shellexec`（`shell32!ShellExecuteW` 的 `open` 谓词，不经过命令行，空格与中文路径安全，也不闪黑窗），调用前先 `os.Stat` 校验，空路径 / 不存在 / 无关联程序都返回可读文案；目录等价于在资源管理器里打开。前端单一入口 `editor-groups.js` 的 `openWithDefaultApp(path)`（缺绑定时提示「当前版本不支持」），标签页菜单里无路径的虚拟标签自动置灰。
- **修复文件树右键目录整张菜单打不开**：`explorer-ops.js` 的 `newFileMenuItems` 裸写了 `newFileTypeMenuItems(...)`，而该函数定义在 `main.js`——右键任何目录直接 `ReferenceError`（自菜单拆分起即坏）。现改为 `deps.newFileTypeMenuItems` 并在 `createExplorerOps` 的 deps 补 getter。护栏：`default-app-menu.test.mjs`（3 例）、`TestOpenWithDefaultAppRejectsBadPaths`。

### AI 面板（本地模型的用量统计）

- **修复本地模型（llama.cpp / LM Studio / vLLM 这类 OpenAI 兼容服务）的「输出速度」与「缓存命中」永远是「—」**：流式请求体此前从不带 `stream_options.include_usage`——开放推理服务默认不往流里放 usage（OpenAI 官方也要求显式索取），于是 `ai-done` 里没有 usage，`promptTokens / completionTokens / cachedTokens` 全 0，会话统计弹层的「输出速度」、Token 用量弹层的「缓存命中」只能显示「—」，输入框下方那一排「N tok · N tok/s · 缓存命中 x%」整块不出现；同样的请求打 DeepSeek / DashScope 这类「不管有没有该开关都在末块回 usage」的网关就又统计正常，所以问题只在本地模型上暴露。现在 OpenAI 兼容请求统一带 `stream_options: {include_usage: true}`，并补两条兜底：① 网关 400/422 且错误文案点名 `stream_options` / `include_usage` 时，摘掉该字段重发一次（个别老 shim 把未知字段当参数错误，不能让对话直接失败，也不能循环重发）；② 只在 `timings` 里给数字（`cache_n` / `prompt_n` / `predicted_n`，llama-server 系自报计时）、完全不回 usage 的老版本，用 timings 反推 prompt / cached / completion（`aiMergeTimings`，已有值不覆盖）。护栏：`TestAIStreamOpenAIRequestsStreamUsage` / `TestAIStreamOpenAIUsageFromTimings` / `TestAIStreamDropsStreamOptionsWhenRejected` / `TestAIStreamNoDropForUnrelated400`（`internal/aitransport`）。

### AI 面板（回复操作按钮颗粒度）

- **「回复操作按钮」新增三档颗粒度设置**（设置 → AI 助手，行式下拉）：每条 assistant 消息尾部都挂着悬停操作行（复制 / 回退到此轮 / 分支 / 支线对话 / 投递 + 用量、耗时，`opacity:0` 悬停才显示）——轮次中间步骤（如发起工具调用的那条）也带，用户反馈在思考块下方很显眼。三档口径：**都完整出现**（默认，行为不变）｜**最后一条完整，中间只留复制 / 回退**（回合收尾类按钮——分支 / 支线 / 投递 / 用量 / 耗时——只属于最后一条，中间步骤出错时的「重试」也一并收敛）｜**只在最后一条显示，中间不出现**（中间步骤整行不渲染）。用户消息的复制 / 编辑重发不受该设置影响。判定抽成纯函数 `aiMsgActionsStepMode(mode, isLast)`（`ai-constants.js`，'full' | 'basic' | 'none'，非法档位回落 full，配 `ai-constants.test.mjs` 用例）；`appendActions` 的 'none' 早退放在操作行元素创建之前（不创建再移除），切档立即 `renderMessages` 生效。实现落点：`main.js`（`aiMsgActions` 默认值与归一化）、`index.html`（设置行，静态 `opt-select` 合规写法）、`ai-panel.js`（el 注册 + appendActions 分支）、`ai-settings-dialog.js`（绑定 + 切档重渲染）。

### AI 面板（上下文提醒条）

- **「上下文约 X%，建议压缩」横幅改细字一行，并可以关闭**：原样式是带主题色底、上边框的整条横幅 + 大按钮，占一整行还压着输入区。现在收成一行细字提示（muted 色、小字号、无底色无边框，超长省略号截断），右侧是小型「压缩上下文」描边按钮和「×」关闭钮（悬停有 tooltip 说明）。关闭语义：**会话内记下关闭时的百分比，上下文再涨 5% 才重新提醒**（WeakMap 挂会话对象，切会话互不影响、会话删除即回收；压缩后百分比回落到阈值以下自然隐藏，与关闭态互不干扰）。判定抽成纯函数 `aiCtxBannerShow`（`ai-constants.js`，配 `ai-constants.test.mjs` 6 例：踩线提醒 / 关闭后静默档 / 取整边界 87.4↔87.5 / 回落隐藏 / 非法输入兜底）。

### AI 多模态（视频输入）

- **模型设置的「视频」输入能力勾选真正生效**：此前勾选只记录能力位（UI 挂「待支持」占位），没有发送通道。现在勾了「视频」的模型条目可以随对话发送视频——**粘贴视频文件**（资源管理器复制 mp4 后在输入框粘贴）或「附加文件…」选 `.mp4`（走新 Go 绑定 `ReadVideoAsDataURL`：扩展名 + ftyp 魔数双校验、16 MB 上限），视频原样 base64 不降质不截帧（浏览器解不了任意容器，抽帧另议），作为 `message.videos` 落会话、落 `ai-sessions/<id>/videos/`（新绑定 `AISessionSaveVideo` / `AISessionReadVideo`，与图片同构的丢 base64 留 file 引用机制；存储清理按 ai-sessions/ 整树统计自动覆盖）。请求体按 Qwen-VL 系（DashScope / vLLM）OpenAI 兼容约定发 `video_url` 内容段；**只走 OpenAI 兼容协议**——Anthropic 与 Responses 协议没有视频内容段，前端发送时拦下并提示、Go 传输层对这两套协议遇 videos 双保险报错。**「视频」默认不勾选**（与「音频」一致，默认只勾文本 + 图像——大多数模型不支持视频输入，不该默认打开）：要用视频的模型条目在设置里手动勾上「视频」；经「获取列表」批量添加时，配置表标注 `video:true` 的已知模型（qwen3.8 系 / Gemini 等）会自动勾上。配套上下文预算：单条消息 1 个视频、每个按 4000 token 估算参与上下文预检。新增 **`read_video` 工具**（只读档，计划模式与子代理同 read_image 口径）：读本地 mp4 把视频画面附加到对话（≤16 MB、不支持公网 URL），执行时按当前条目 `modalities.video` 拦截（与 `read_image` 的执行时门禁同构，工具描述写明），路径授权链、批次边界 flush（`queueSessionImage` 通用队列直挂 videos 消息）、会话落盘全复用；工具卡动词「看视频」+ play 图标，应用消息 kind `read-video`。实现落点：`internal/aitransport`（`Message.Videos` + 校验 + 三套协议构造器）、`internal/fileio`（`ReadVideoAsDataURL`）、`internal/sessionstore`（videos 落盘/回读 + 文件名校验白名单收 .mp4）、`ai-constants.js`（`AI_VIDEO_*` 常量、`aiNormalizeVideo` / `aiVideoFromSrc` / `bufferToBase64` / `isReadableVideoPath`）、`ai-config-model.js`（默认 modalities）、`ai-composer.js`（粘贴/对话框分流与门禁）、`ai-panel.js`（发送组装 / 协议拦截 / 气泡回显 / 编辑重发 / read_video 分支）、`ai-tool-defs.js`（def + 目录 + 决策表）、`ai-tool-cards.js`、`ai-subagents.js`、`ai-session-store.js` / `ai-session-disk.js`（videos 持久化）、`ai-system-context.js`（活动文件是 mp4 时提示用 read_video）、`ai-manage-dialogs.js`（token 估算）、`ai-app-message.js`、`style.css`、`dev/mock-backend.js`。护栏：`ai-video.test.mjs`（10 例纯函数）、`ai-tool-defs.test.mjs`（read_video 下发与描述契约）、Go 侧 `TestAIOpenAIUserVideos` / `TestAIAnthropicVideosRejected` / `TestAIResponsesVideosRejected` / `TestAIMessageVideoValidation` / `TestReadVideoAsDataURL` / `TestServiceVideoRoundTrip`。限制：只支持 mp4 容器，webm/mov 后续按服务商支持放宽；音频勾选仍为「待支持」。

### AI 终端工具（terminal）

- **修复 AI 终端工具从未可用（一直报「当前版本不支持终端操作」）**：`main.js` 给 ai-panel 注入的 `terminalHost` getter 调的是 `terminalUI.terminalHostApi`——但 `terminalHostApi` 挂在 terminalMod 模块返回面（terminal-sessions.js 定义、经 `...sessMod` 转发），`terminalUI` 只是 dock 状态对象 `{open, sessions, order, activeId}`，上面没有这个方法；getter 恒返 null，terminal 工具的 list/open/send/read 全部在第一道闸就报「当前版本不支持终端操作（请重新构建或更新应用）」——文案误导，与构建版本无关。自 b59df28（11-15）随工具诞生即坏，从未工作过。现在从 terminalMod 解构 `terminalHostApi` 并在 getter 直接调用；工具的审批链（open/send 走 approveCommandForRun）与纯函数（ai-terminal-tools.js）不受影响。
- terminal / background_command 描述互补分工句，收窄长驻服务的选型模糊区：**不需要交互、只等 AI 自己轮询结果的长驻服务优先 background_command**（输出走缓冲更省），terminal 用在想让用户看到现场、需要持续输入（REPL / ssh）或随时接手的场合。

### 后台终端（AI 后台命令实时输出）

- **修复实时输出从未送达（「后台终端」标签页永远「暂无输出」）**：`cmdbridge` 广播 `cmd-out` 的载荷 map 字面量把键写成了裸标识符（`map[string]string{id: id, stream: stream, data: …}`）——Go 的 map 复合字面量键是表达式，裸写 `id:`/`stream:`/`data:` 取的是同名**变量**，实际发出的是 `{"bg-1":"bg-1","out":"out","<输出文本>":"<输出文本>"}`，载荷里没有 `id` 字段；前端 `EventsOn('cmd-out')` 按 `payload.id` 查分发表永远落空，每行输出被静默丢弃。于是后台终端标签页与 AI 面板工具卡的实时输出自进程桥诞生（c598f42，11-08）起**从未工作过**（全历史 14 个含 `bgLog` 的会话无一非空，实证），作业输出只能靠 `check_command` 游标查询、状态靠 `cmd-exit`（键带引号，一直正常）推进；dev/mock 模式下 mock 后端发的是正确形状，浏览器调试看不出问题。现在键加引号修正载荷（插件命令的实时输出同样受益），`AICommandStatus` 游标查询不受影响。护栏 `TestAICommandStartEmitsEventPayload`：钩住 `cmdbridge.Emit` 断言每条 `cmd-out` 带正确 `id/stream/data`（对修复前代码实测红：`{"CADT_BG_EVT_7701":"CADT_BG_EVT_7701","bg-1":"bg-1","out":"out"}`）。

### 通知（消息中心口径）

- **例行「任务完成」不再写进状态栏【消息】中心**：此前每轮结束都记一条（标题固定「AI 任务完成」+ 会话标题 + 首段摘要截断），连续跑几轮就把消息列表刷成十几行同样的流水账，真正需要处理的消息（失败 / 提问 / 审批）反而被埋掉。现在完成通知只保留两个出口——**软件在后台时弹 Windows 系统卡片**（可点击跳回会话，受「任务完成时通知」开关管）与任务栏闪烁；「这一轮跑完了、用户还没看」这件事由会话列表的**「已完成未查看」角标**表达（`finishStream` 里本来就在打）。失败 / 提问 / 审批 / 计划待批准 / `notify_send` / 版本更新照旧进消息中心。实现落点：`ai-notify-policy.js` 的策略对象新增 `centerRecord`（完成档为 false），`ai-panel.js` 的 `notifyDesktop` 三条出口都按它决定是否 `addMessage`（含「两个弹层开关全关」的早退出口——那里也要记，否则后台审批会一点痕迹不留）；`notify_send` 工具描述与设置页「应用内通知 / 任务完成时通知」文案同步改口径；**旧流水一并清掉**——消息中心读取 localStorage 时剔除旧的「AI 任务完成」条目（只认 `success` + 标题完全相同，`notify_send` 的自定义标题消息不受影响），不用手动点「清空全部」。护栏 `frontend/test/ai/ai-notify-policy.test.mjs` 新增 4 例（完成不进消息中心 / 其余事件一律进 / notifyDesktop 每条出口都看 `centerRecord` / 旧条目清理与通知标题保持一致）。

### AI 面板（工具卡与图片预览）

- **生成图片 / 生成视频卡的完整提示词可以在展开正文里看了**：卡头主参数仍只放 60 字摘要（一行放不下长提示词，截断号后全是省略），展开卡片后正文顶部新增完整提示词块——超过 120 字符或含换行时折叠并给「展开提示词 / 收起提示词」按钮，交互与命令卡的「展开命令」一致（同一套 `ai-cmd-line` 折叠样式）。提示词块排在进度行之前（输入在上、状态在下）。
- 图片预览弹窗去掉「全屏查看」按钮：点图片本身即可全屏（既有行为），按钮冗余；「复制 / 关闭」与右键菜单（复制图片 / 另存为）不变。
- 修复**「在新对话中分支」以未捕获异常收尾**：收尾提示引用了不存在的 `branchMessages`（会话对象实际叫 `branch`、消息在 `branch.messages`），分支本体（建会话、持久化、切换）在抛错前已完成，功能看似能用但每次都往调试控制台丢一条 `ReferenceError`、完成提示也不弹。改为读 `branch.messages.length`。

### AI 隔离工作区（git worktree）

- **修复确认弹层「动作执行了但窗口不消失」（2026-11-17 真机）**：`ai-worktree.js` 的 `confirmDialog` 按钮回调只 resolve 不 `closeDialog()`，且 `settled` 守卫会吞掉后续点击——表现为点「创建」后 slug 已建好但弹层不动、点「取消」也没反应、丢弃同理。现在 `done()` 先关窗再落定（仓库惯例，与 ai-reminders / ai-schedule 一致），创建 / 丢弃 / 信息卡共用同一修复。
- **头部「隔离区」胶囊：补图标 + 点击改为信息卡**：compact 档（标题行 <420px）会隐藏 chip 文字，而 worktree chip 从未注入图标，只剩空白圆——现在注入 folder 图标并设置 tooltip。点击胶囊不再是直接进入丢弃确认，改为**信息卡**：显示路径、分支、改动统计与回灌指引，底部两个显式按钮【关闭】【丢弃隔离区】；权限弹窗里「隔离工作区」行在已开启时同样进入信息卡（点一下不会退出），未开启时创建。
- **修复「已开完全权限仍弹命令审批卡」的档位竞态**：分类器判定最长等 12s，期间把档位切到完全权限后，迟到的 ask 会照弹。现在 `requestCommandApproval` 在弹卡前按当前档位重判（`scopeUpgradedToFull` 纯函数）：full 下除**项目 ask 规则**（有意压过 full）外一律自动放行并留痕「审批等待期间已提升到完全权限」；项目 ask 仍按原样弹卡。命令通道的四个询问点补了 `source` 供区分。
- **补丁审批卡头部统计贴右**：`+26 −25 3 文件` 此前停在卡片中间而不是收起图标左边——`.ai-takeover-stat` 与 `.ai-takeover-collapse` 都带 `margin-left: auto`，Flex 把剩余空间在两个 auto 边距间平分了。现在补丁卡内收起按钮改为 `margin-left: 0`（auto 只由统计块持有），统计块紧贴右侧、收起图标紧随其后；单文件审批等其他接管卡布局不变（`style.css`）。
- **隔离区临时文件与输出重定向指引**：worktree 检出里没有主根 `.cadt/`，AI 之前会猜 `../.cadt/tmp` 并在 worktree 内部自建目录、再用 `> log` + `sed` 读日志——重定向使命令变成无法静态分析的复合命令，auto 档只能转人工（分类器 ask / 超时），这不是权限 bug。现在 `<worktree>` 块写明：工具路径一律相对范围根（主根）、隔离区没有主根 `.cadt`、临时产物用 `write_file` 写主根 `.cadt/tmp/`（auto 档免审）、不要用 `../` 猜路径；`run_command` 描述补充「输出已捕获，不要用重定向写日志再读，长日志用 background_command + check_command」。
- **输入区窄宽度两级降级（对齐 ZCode 权限弹窗）**：此前面板拖窄时底栏放不下，发送/停止会被挤出可视区、pill 全变省略号。现在：① 内容宽 ≤400px 时**模型 chip 收成单图标**（名字/推理等级/上下文上限/箭头隐藏，模型名与等级进入 tooltip / aria-label）；② ≤330px 时**「计划」「隔离」两个 pill 收起，入口移进权限模式弹窗**的「会话模式」两行——计划模式 / 隔离工作区（带勾选、描述、任何宽度都保留在菜单里，宽档 pill 与菜单并存），计划已开用权限胶囊上的强调色圆点提示以免状态丢失；③ 发送/停止始终固定可见。两级之间都不出省略号。实现：`style.css` 容器查询段（`.ai-composer` 已是 `container-type: inline-size`）、`ai-panel.js` 的 `showPermissionMenu` / `updateScopeUI` / `renderModelChip`、`ai-worktree.js` 的 `toggleForSession`（pill 开关与运行中守卫）；权限菜单行：未开启=创建、已开启=信息卡。
- **输入区常驻「隔离」开关（对齐 ZCode 的 worktree 勾选）**：AI 输入框底部工具栏新增 `隔离` pill（与「计划」同排、同 `.active` 样式）——勾上即创建隔离区（确认卡按权限档出、完全权限免），取消即弹确认丢弃（含改动统计）；轮次运行中禁用切换（写效应正在产生），只读档点击提示先切权限档；会话切换/启动自动同步状态。worktree 从此是用户显式控制的会话开关，不再只靠 `/worktree` 或模型自觉；AI 侧仍可经 `worktree_manage` 建议创建。
- **修复「用户说了基于 worktree，AI 仍在主根开发」**（2026-11-17 实测）：此前守则里没有把用户的 worktree 表态绑定到工具调用——模型把「基于 worktree」理解成「参考 worktree 方案文档」，且计划模式下 `worktree_manage` 按设计不可见、更不会创建。现在：① `<workspace_rules>` 写档守则要求「用户以『基于 worktree / 用隔离区 / 在 worktree 里开发』措辞要求时，实施第一步先 `worktree_manage(action=create)`，并声明这不是读方案文档；只是讨论方案文档时不要创建」；② 计划模式守则与 `<plan_mode>` 块要求「计划 steps 第一项写创建隔离区，批准后才执行」；③ 工具 create 描述同步；④ `/worktree` 从「填提示词」改为**面板直连创建**（`createForSession`：确认卡按档位出后立即 `GitWorktreeAdd`、登记会话、出胶囊），不依赖模型回合的确定性入口。提示词是行为依据不是硬约束——要 100% 确定就勾「隔离」或先 `/worktree` 再让 AI 干活。
- **二期：依赖共享 / 子代理并行 / 改动统计 / 孤儿回收**。① **依赖目录 junction**：创建隔离区时自动把主根的 `node_modules` / `.venv` / `venv`（白名单，只共享通常 gitignore 的目录；git 跟踪的 vendor 不碰）以目录联接（junction）接进 worktree（原生 FSCTL 创建，免管理员权限、不经 cmd.exe），创建结果告知 AI 已共享哪些——隔离区里 `npm test` / `pip` 可直接跑（写入的就是主根依赖目录，双向共享）；删除侧递归摘掉全部 reparse 点再交 git，**删除 worktree 绝不伤主根依赖**（测试断言）。实施实测：Go 1.27 Windows 下 `os.Lstat` 对 junction 不报 symlink/dir 位（`WalkDir`/`ReadDir` 把它当非目录条目、不下钻——遍历天然安全），reparse 点判定按 reparse tag 精确识别（MOUNT_POINT / SYMLINK）。② **子代理并行隔离区（`spawn_agent` 新增 `isolation: 'worktree'`）**：给子代理建独立隔离 git worktree（创建失败让派单直接报错，不静默降级成写主根），挂 `write_file` / `edit_file`，写效应圈定在它自己的 `.cadt/worktree/<slug>/` 前缀内（`agentWorktreeWriteVerdict` 纯函数闸：前缀内确定性放行自动应用——隔离区即审批边界，子代理永不弹卡；前缀外确定性拒绝）；命令通道由同期落地的 OS 沙箱承载（写效应圈在 cwd / 隔离 worktree 内）；主代理用 `worktree_manage` 的 `export` / `stat` / `discard`（新增可选 `name`，只认本会话自己的或本会话派生子代理的隔离区，归属外拒绝）审阅回灌或丢弃。③ **改动统计（对比 lite）**：Go 新绑定 `GitWorktreeStat`（baseSha 有效对比创建基准，否则对比该 worktree 自己的 HEAD）；`worktree_manage` 新增 `stat` 动作、`list` 给每个隔离区附一行未提交改动统计、头部胶囊弹层显示统计。④ **孤儿隔离区回收**：设置 → 存储与清理 新条目「AI 隔离 worktree（孤儿）」（危险类，走回收站）——只清「没有任何会话登记」的孤儿检出副本，活跃会话登记的隔离区不在范围（宿主从会话 meta 收登记路径注入，钩子未注入时一律不清，fail-safe）；git 管理记录由启动 prune 收敛，分支残留写进条目说明。

- **修复「补丁回灌失败时 AI 直接改主根」（2026-11-17 真机）**：`worktree export` 的补丁预检有冲突时，模型会自作主张「直接对主根做同样的替换」——真机上在完全权限档 `edit_file` 改了主根 `frontend/src/style.css`（+23 −18），绕过回灌审批卡。现在主会话在隔离期间**主根只读**：`applyWorkspaceWrite` 用纯函数 `mainRootWriteVerdict` 判定，只允许写自己的 `.cadt/worktree/<slug>/` 前缀与 `.cadt/tmp/` 临时产物，其余主根路径确定性拒绝（**全档生效，含完全权限**；`/init` 是应用代发的用户动作，豁免），拒绝文案指引「改隔离区路径、冲突在隔离区修正后重新 export」。同时 `run_command` / `background_command` 未显式传 `cwd` 时**默认在隔离区里执行**（`commandCwdOf`），要看主根需显式 `cwd='.'`；`<worktree>` 块补「主根只读 + 导出冲突处理」指引。护栏：`test/ai/ai-worktree.test.mjs` 新增 `mainRootWriteVerdict` 用例（隔离前缀 / `.cadt/tmp` / 主根文件 / 近似前缀 / 范围外绝对路径 / 无登记）与提示词块断言。
- **AI 主动进入 / 退出隔离区改为输入区审批卡（2026-11-17 真机）**：此前 `worktree_manage(create/discard)` 走居中二次确认弹窗（且 full 档创建直接免确认）。现在 AI 发起的 create / discard 一律弹**接管 composer 的审批卡**（新增 `approval.kind = 'worktree'`，与写/命令审批共用 `pendingApprovals` 通道）：创建卡说明位置/分支/用途与「拒绝后只能主根常规流程」，丢弃卡附改动统计与「未导出改动会丢失」，底部【取消/保留】【创建隔离区/丢弃隔离区】，支持临时收起；**全档必弹（含完全权限）**——会话级状态变更不随逐写档位静默执行。用户自己点的「隔离」开关与胶囊信息卡仍走居中确认弹窗（那是用户发起、不是 AI 请求）。审批记录按 `worktree` 来源落痕。实现：`ai-takeover.js` 的 `renderWorktreeTakeover`、`ai-panel.js` 的 `requestWorktreeApproval` / `decideApproval` 分支、`ai-worktree.js` 的 `manageCreate` / `manageDiscard`；工具描述同步「会弹审批卡」。
- **修复「丢弃隔离区后主根 frontend/node_modules 被清空」（2026-11-17 真机）**：AI 在隔离区里手动 `mklink /J frontend/node_modules <主根>/frontend/node_modules` 借依赖（根层没有可自动共享的 node_modules，旧提示词仍说「依赖已共享」误导了它）；`WorktreeRemove` 之前只摘 worktree **根一层**白名单里的 junction，扫不到嵌套链接，随后 `git worktree remove --force` 在 Windows 上**跟进 junction** 递归删除目标内容——主根 `frontend/node_modules` 被直接删空（用户 `npm install` 后才恢复）。现在删除前 `unlinkReparsePoints` 递归遍历 worktree（`WalkDir` 对 junction 不下钻），摘掉**所有** reparse point（junction / 符号链接，只删链接、绝不动目标）再交 git；`<worktree>` 块与工具描述改为「只共享主根**顶层** node_modules/.venv/venv，子目录依赖不会共享——缺依赖在隔离区里装，绝不要手动 mklink 借主根」。护栏：`internal/gitinfo/worktree_test.go` 新增 `TestWorktreeRemoveNestedJunction`（嵌套 junction 删除后主根依赖内容完好）；已用临时仓库复现「git 跟进 junction 删空目标」，确认根因。
- **复查加固（2026-11-17，子代理三轮只读复审）**：① **主根只读闸补根相对/UNC 绕过**：`aiNormalizePath` 会把 `\\server\share` 与 `\\?\D:\...` 折成单斜杠（`/server/share`、`/?/D:/...`），旧闸把 `/` 开头当「范围外绝对路径」放行——Win32 会解析到当前盘根，工作区在该盘时即可命中主根。现在隔离期间单斜杠/反斜杠开头一律拒绝，临时产物统一引导到 `.cadt/tmp/`；测试改按生产形状（归一后的单斜杠）断言。② **审批后失败/停止不再假成功**：create/discard/export 在审批通过后遇到 `GitWorktreeAdd/Remove/PatchApply` 报错或用户停止时，把 `approval.state` 落成 `failed/cancelled` 并写 `error`，工具卡与状态文字不再显示「已创建/已丢弃」；补丁卡异常不再永久停在「正在应用补丁…」。③ **停止竞态防幽灵卡**：`requestWorktreeApproval` 与 `requestPatchApproval` 在注册前检查 `toolHalted`，避免「已死轮次」的 pending 卡永久挂起并顶掉下一轮审批。④ **入口护栏补齐**：`createForSession`（/worktree、权限菜单）与胶囊信息卡的丢弃都补运行中守卫；同会话 create 加互斥标记并在审批返回后复查 `session.worktree`，防止审批等待期间从另一入口建出第二个隔离区（后者覆盖登记、前者成孤儿）；非当前会话完成创建/丢弃只清/刷新自己的胶囊，不再把别会话的隔离状态画到当前会话。⑤ **Go 删除加固**：worktree 根本身是链接时 fail-closed 拒绝删除（git 会跟进删空目标）；`isReparsePoint` 改按 reparse tag 精确判定（只认 junction/symlink，不误伤云占位符/去重/ProjFS）；不再跳过嵌套 `.git`；`createJunction` 改用 `FSCTL_SET_REPARSE_POINT` 原生创建（不再经 cmd.exe，杜绝路径元字符注入/假成功）；`git add -N` 对 junction 路径加 exclude pathspec（防止未 gitignore 的依赖目标被打进导出补丁）；重复 discard 幂等并清分支、目录已被手动删除时也按成功收尾；创建后取 HEAD 失败会回滚目录与分支。新增 Go 用例：重复 discard、根链接拒绝、junction 元字符路径、导出排除 junction 目标；前端新增 create/discard 审批闸用例。⑥ **文案/文档对齐**：`run_command` / `background_command` 描述补充「隔离会话默认 cwd 落隔离区」；审批记录补 `worktree` 类型与 `worktree-isolation` / `agent-worktree` / `confirm` 来源标签；CHANGELOG/README/方案 §6.4 审批矩阵与 §8/§9 同步。
- **新增 AI 的隔离 git worktree（一期）**：AI 的有风险批量改动、大规模重构、试错可以在独立 worktree 里做——改动落在 `<主根>/.cadt/worktree/<slug>/`（新分支 `cadt/wt/<slug>`，slug 由用途名 + 会话 id 在 Go 侧派生），主根全程零改动；完成后导出补丁交用户在审批卡逐文件审阅后回灌主根，**回灌审批卡全档必弹（含完全权限档）**——人工审阅闸门是本功能的红线，不做任何自动 merge。会话独占（一会话一个 worktree，fork / 支线 / 会话投递不继承）；丢弃时 `worktree remove --force` + 删隔离分支。入口：AI 工具 `worktree_manage` 与输入框 `/worktree` 斜杠命令；会话持有活跃隔离区时头部出「隔离区」胶囊、系统提示词每轮注入 `<worktree>` 块。权限面全部走既有机制：auto 档对 `.cadt/worktree/` 精确前缀豁免逐写审批（脏文件仍确认、write-guard 与项目规则照常、`.cadt/permissions.json` 等仍 risky），edit 档照常逐写显示 diff；**git 快捷操作令牌豁免在 worktree cwd 下失效**（防令牌被拿去静默提交草稿分支）；项目规则对 `.cadt/worktree` 加 deny 即整域硬禁。五处护栏配套：文件监听跳过 worktree 子树（防事件洪峰冲 overflow）、检索两路径跳过（内置 WalkDir 加 `search.SkipPath`；rg 路径 glob 尽力剪枝 + `skipRgHit` 命中二次过滤保底——Windows 上路径型 glob 实测不可靠）、AI list_dir 与目录结构树导出整棵跳过（从隔离区自身发起的遍历/导出不受影响）。已知限制：重复 export 是全量语义（已回灌的 hunk 预检如实报「不可应用」），文案引导 export 后 discard 收尾；二进制改动不可回灌（预检如实报「不可应用」）。实现落点：`internal/gitinfo/worktree.go`（新，配 `worktree_test.go`：slug 派生 / 生命周期 / 隔离性 / diff 含未跟踪与删除 / patch 引擎可解析 / 冲突后缀 / junction 共享与删除安全 / prune）、`gitinfo_app.go` 转发、`internal/search`（`SkipPath` + rg 兜底）、`internal/watch`、`internal/fsops`、`internal/structuredir`、`internal/storage`（孤儿条目 + 会话登记钩子）、`ai-worktree.js`（新，配 `ai-worktree.test.mjs`）、`ai-tool-defs.js` / `ai-command-rules.js` / `ai-session-store.js` / `ai-system-context.js` / `ai-slash.js` / `ai-constants.js` / `ai-subagents.js`（隔离子代理） / `ai-panel.js` / `mock-backend.js`。方案见 `docs/finished-plans/git-worktree.md`。

### AI 对话（轮次过程折叠）

- 修复**同一轮被提问卡切成多条「已完成 · 用时 X」**：过程内容会按「已回答的提问卡」分段以守住时间序，但此前是每段各自一条 `.ai-process` 折叠条——同一轮里「已完成，用时 13 分 9 秒」会重复出现三次、看起来像跑了三轮。提问卡是折叠区外的整卡（问答凭据不能收起），它只该把过程 body 隔开，不该切出第二个开关。现在折叠状态的 key 只到轮（去掉 `:s<segIndex>`），折叠头只出在第一个可渲染段上，其余段是无头的 body 容器、与首段共享同一个开合状态：收起时只剩一条「已完成」+ 提问卡 + 最终回答，展开时仍按时间序铺开。提问卡保持整卡常显，不参与折叠。护栏 `frontend/test/ai/ai-turn-fold.test.mjs`（4 例：key 不带段号 / 头只出一次 / 点头同步全轮 / 续段收起不占位）。

### 通知点击跳转（系统通知 + 应用内 toast）

- **Windows 系统通知可以点了**：此前通知卡片只带标题与正文，没有激活接线——toast XML 的 `launch` 为空、注册表 AUMID 下没有 `CustomActivator`（COM 激活器）、进程内也没注册激活回调，Windows 不知道点了通知该叫醒谁，点击只等于关闭卡片。现在发通知时带上业务参数（`ai-session=<id>`），启动时经 go-toast 的 `SetAppData` 登记 COM 激活器（`CustomActivator` + `LocalServer32`）并注册激活回调：应用在后台时点击通知 → Windows 把激活投递回本进程（push 时已注册类工厂）→ Go 侧把窗口拉回前台（`WindowShow`，不还原最大化）并发 `ai-notify-activate` 事件 → 前端按参数跳到对应会话（待审批 / 待填写的接管卡就在那个会话的输入区）。应用完全没在跑时点旧卡片仍会正常启动应用（冷启动拿不到会话参数，旧卡片本就多半过期）。设置 → AI 助手 → 通知的「测试」按钮发同样可点的通知。实现落点：`internal/notify`（`registerToastActivation` / `NotifySystemToast` 新增 payload 参数）、`app_core.go`（`onToastActivation` 钩子）、`ai-notify-policy.js`（`buildNotifyActivationPayload` / `parseNotifyActivationPayload` 纯函数，配测试）、`ai-panel.js`（通知带参数）、`main.js`（`ai-notify-activate` 事件接线）。
- 修复 **应用内 toast / 消息中心点击「没反应」**：`main.js` 的 `focusSession` 调 `aiPanel.switchSession(...)`，但 AI 面板对外 API 没有导出 `switchSession`（前端拆分时丢失），调用抛 TypeError 被 try/catch 吞掉——面板开了、会话却永远切不过去。现在面板 return 补导出 `switchSession`，消息点击与通知点击共用同一条 `focusAISession` 收口。
- 修复 **设置页「应用内通知」开关不生效**：`notifyInApp` 被硬编码为 `false`（原意是「应用内完成 toast 默认关」），设置里的开关存了值也不读，成了死开关。现在如实读取存值（默认仍关）；「任务完成不弹应用内 toast」的语义由投放策略的 completion 档继续兜住，不受开关影响。

### Go 引擎布局重构收口（2026-11-17 审查修正）

B6–F 系列引擎下沉（`docs/finished-plans/go-layout.md`）经逐提交审查后修正四处，均为未发布构建内的问题修复与语义登记：

- **SVG 恢复按文本/XML 打开**：下沉期把 `.svg` 误加进 fileio 的图片扩展名共享表，`OpenFile` 把 SVG 判成图片二进制，代码编辑器与分屏渲染打不开（与 README「XML/SVG 树/代码/文本视图」承诺相悖）。现在共享表不再收 `.svg`，读图链路（Markdown 相对路径图片 / AI 附件）按扩展名单独放行、MIME 照旧 `image/svg+xml`。
- **AI 对话事件出口补注入**：`aichat.Emit` 此前在 startup 漏接线，AI 流式事件（chunk/think/toolcall/done/error）会静默丢失。已补注入并加事件送达回归测试（`internal/aichat`）。仅影响本未发布窗口内的开发构建。
- **取消表语义统一（有意变更，接受登记）**：运行通道与命令桥共用一张进程取消表后，重复 id / 超上限的错误文案统一为「任务 id %q 已在运行」「同时运行的任务超过上限 16」（原为「命令 id…」「运行 id…」）；**同步命令（AI run_command / 插件同步）一并纳入 16 上限**——原实现不查上限，可在流式任务占满后继续叠加。前端不对文案做匹配。
- **绑定面清理**：`EnsureDir`（插件）与 `Start`（AI 定时任务）曾因写成嵌入服务的导出方法被提升为 Wails 绑定（前端从未调用）；现改回包级函数，绑定面与重构前一致。

### AI 面板布局（编辑区自动收起）

- **AI 工作时自动收起编辑区**（设置 → AI 助手 →「AI 工作时收起编辑区」，默认**关**）：回合开始时把内容区位置让给对话、回合结束自动还原，等价于已有的手动「收起编辑区」但由运行态驱动。默认关是因为它会改变布局，须用户主动开启。收起状态拆成**两个原因位**（`manual` 用户点收起条 / `auto` AI 让位）——AI 跑完只还原自己收起的，绝不把用户刻意收起的编辑区顶开；反之用户手动展开后本次让位过程内不再自动收（粘性位，回合开始与切会话清零，不是固定锁）。**收起态不是固定锁**：任何内容出现在内容区都会立即展开——用户点开文件、AI 打开文件、浏览器标签页、子代理标签页、补丁/差分预览，全部经 `activateDoc → updateDocChrome` 一处收敛（`deps.onDocVisible`）。这条不只是体验：一旦有 activeFile，`refreshDockFill` 就会摘掉 `ai-dock-fill`（面板不再占满），此时若编辑区还收着就是「面板不满 + 内容不可见」的空白布局，所以展开必须排在 `refreshDockFill` 之后。只在 `dock` 停靠分屏生效：`fullscreen` 已覆盖内容区（再收起会留白）、`float` 是独立窗口（与本窗口布局无关）；有未保存修改时也不收（收起会把脏标记藏起来）。运行态此前没有事件（只有 800ms 轮询给后端做关窗确认），本次在 `attachStream` / `detachStream` 挂宿主回调 `onTurnStateChange(running, sessionId, isCurrent)`，按会话整轮触发所以不会随流式每帧闪。判定收敛为纯函数 `decideAutoCollapse`（`ai-auto-collapse.js`，配 `ai-auto-collapse.test.mjs` 12 例，含「手动收起不许被顶开」「脏文档不收」等语义断言与四处接线护栏）。

### AI 请求限流（RPM，防 429）

- **模型条目新增「频率上限」（次 / 分钟，留空 = 不限）**：此前 Go 侧完全没有速率控制，只有「收到 429 之后」的退避重试；而并发面实际很大——主会话 × 会话数 + 最多 20 个子代理 + 1 个自动审批分类器，全部落在同一个 `baseURL+model` 上，正是撞 429 的根源。现在超出阈值（`Config.RPMLimit`）的请求在客户端排队而不是直接发出，从「事后补救」前移到「事前预防」。两层：RPM 滑动窗口（60s，按 `baseURL|model` 计数，BaseURL 尾斜杠/大小写归一）+ **429 冻结回灌**（收到 429 时把 `Retry-After` / 指数退避算出的等待时间灌回该 key 的冻结窗口，冻结期内同 key 的其他请求一起排队，避免「一个请求在退避、另外二十个还在往前撞」；5xx 不是配额问题，不冻结）。排队中持续喂 120s 看门狗、可被 ctx 取消（用户点停止不会在队列里继续等），并每轮发 `ai-queue` 事件——不提示的话排队期间前端是纯空转，比 429 更像卡死（状态条复用重试提示的位置，用强调色而非警告色）。与重试**叠加不替换**：限流器覆盖不了网关配额抖动、网络错误与 5xx。实现落点：`internal/aitransport/ratelimit.go`（新，配 `ratelimit_test.go` 9 例）、`types.go`（`Config.RPMLimit` / `EventQueue` / `QueuePayload`）、`http.go`（`client.Do` 前取名额 + 429 分支冻结）、`ai-config-model.js`（条目 `rpm` 归一与 `rpmLimit` 透传，配 `ai-rate-limit.test.mjs`）、`ai-settings-dialog.js` / `index.html` / `ai-panel.js`（编辑器字段与排队提示）。**TPM 暂未做**：需要「预估值 + 实际 usage 回填」两段链路，估偏会误伤正常请求，留待二期。

### AI 工具（read_image 直读网图）

- **`read_image` 可以直接看公网图片了（URL 走同一个 `path` 入参）**：此前 `read_image` 只收本地路径，模型拿到一张图片链接（例如 `https://picsum.photos/640/360`）只能去试 `web_fetch`，而 `web_fetch` 按契约只读文本、会以「该地址返回 image/jpeg」失败——模型于是只能回一句「URL 有效但看不了」。现在 `path` 传 `http(s)://` 直链即按图片抓取：工具描述与 `web_fetch` 的报错文案都改成明确指向 `read_image`。**没有塞进 `web_fetch`**：`web_fetch` 的契约是「返回可截断的文本 + 标题 + 链接」，图片是「附加到对话、占 800–1600 token、不可分页」，混在一起会让模型拿 `maxChars` 去截 JPEG；这也是当初 `read_image` 与 `read_file` 分家的同一条理由。图片注入链完全复用（`queueSessionImage` → 批次边界 flush → 会话 `images/` 落盘），服务商适配与上下文估算不改。安全面：抓取复用 `Fetch` 的 `webValidateURL`（仅公网 http/https、逐跳校验重定向、25s 超时），体积单独一档 16 MB（网页那 4 MB 是按文本估的，常见照片会被误判成截断），**只信魔数不信 `Content-Type`**（站点谎报 `image/jpeg` 塞 HTML 会明确报错）；SVG 按开头标记识别、AVIF 按 `ftyp` 品牌识别。联网开关与项目域名规则经新抽出的 `gateWebTarget` 与 `web_fetch` 同源（`deny` 直接拒、`ask` 弹同一张审批卡、子代理照旧不弹卡）；审批对象带 `web` 标记，卡片按「访问网址」渲染（「本会话允许该网址」）、审计 kind 记 `web` 而非 `command`（判定收口到 `isWebApproval`，本地读图审批仍是 `read`）。工具卡对网图显示「域名 + 路径」且不挂本地文件链接。实现落点：`internal/webtools`（`FetchImage` + `webImageMime` / `webLooksLikeSVG` / `webHasAVIFBrand`，测试覆盖 12 例嗅探表与可选联网用例）、`webtools_app.go`（`WebFetchImage` 绑定）、`ai-panel.js`（`gateWebTarget` 抽取 + `read_image` 分支）、`ai-permissions.js`（`isWebApproval`，配 `ai-permissions.test.mjs` 用例）、`ai-takeover.js`（审批卡网络语义文案）、`ai-tool-defs.js`（描述与工具链文案）、`ai-constants.js`（web-research 技能提示词）、`ai-subagents.js`（子代理只读范围）、`ai-tool-cards.js`、`dev/mock-backend.js`。方案补记见 `docs/finished-plans/read-image.md`。

### AI 工具（list_dir 递归树 + 读审批卡修复）

- **list_dir 支持递归树状输出（新 `depth` 参数）**：此前模型摸多层目录结构只能逐层 list_dir（实测一轮串行 10+ 次调用）。现在 depth 缺省仍是单层（行为与输出不变）；depth 传 2–8 走 Go 新绑定 `ReadDirTree`，一次返回 `├──/└──` 树状文本——目录带 `/` 后缀、文件带人类可读大小，跳过 `.git` / `node_modules` 等目录（与 search_text 同一张跳过表），目录符号链接不跟（防环），全树 400 项预算、超限截断并在对应目录标「还有条目未列出」。递归授权粒度记**目录本身**（`scanRoot` 语义，整个子树都在授权范围内，与 search_text / glob 的起点一致）；读审批弹窗动词按工具名显示「想列目录」，不再误作「想搜索」。实现落点：`app_fs.go`（ReadDirTree / walkDirTree，测试 `app_fs_test.go`）、`ai-file-tools.js`（`renderDirTreeText` 纯函数）、`ai-panel.js`（list_dir 分支 + 审批动词）、`ai-tool-defs.js`（depth 参数、工具描述与目录文案）、`dev/mock-backend.js`（dev 模式同名 mock）。
- 修复 **读类审批卡（list_dir / read_file / 搜索起点授权）展开出现「+undefined −undefined」**：审批正文的 ±diff 统计此前无条件渲染，而读类审批没有 added / removed 字段；现在与工具卡头部同一门卫（有数字才渲染），并把读类审批收尾文案从「已应用更改（…）」改为「已授权读取（…）/ 已拒绝，未读取」，与授权裁定侧的「用户已授权，正在读取…」措辞对齐。护栏见 `ai-tool-cards.test.mjs`。
- **Git 快捷操作在 auto 档的一次性窄豁免**：点 AI 面板头部 Git 快捷操作（提交并推送 / 提交代码 / 推送代码 / 拉取代码）后，auto 档下常规 git 写命令（`add` / `commit` / `push` / `pull` / `merge` / `fetch` / `stash`）不再逐条弹审批卡——此前一次「提交并推送」会弹 3~5 张卡（add、commit、push、可能 pull/merge 各一张），与 auto 档「非风险自主执行」契约不符。实现为**一次性 Git 流程令牌**：点快捷操作时给当前会话打一个令牌（工作区根 + 15 分钟 TTL），`approveCommandForRun` 在危险检测与项目规则**之后**检查令牌 + 命令静态安全 → 放行（来源 `git-flow`）。护栏保留：`push --force/--delete/--mirror/--force-with-lease`、`push +ref`/`push :ref`（强制推送与删除远端分支）、`reset --hard`、`clean -f`、`checkout --`、`restore`、`stash drop/clear`、`branch -D`、`--receive-pack`/`--upload-pack`/`--exec`（指定远端执行程序，等同任意程序执行）走单次确认；`commit --amend`、`commit -a`、`commit -n/--no-verify`、`add -A`/`add .`/`add ..`、`pull --rebase`、`merge --abort`、`stash save/push -u` 不享受豁免、按原审批链处理（这批不在危险清单里，分类器开启时仍可能被判安全，属既有判定行为）；项目 `Bash(...):deny/ask` 规则仍优先；非 git 命令不受影响；只对 `run_command` / `background_command`（terminal 显式排除）、发起动作的会话、auto 档生效（edit 档仍逐条询问）；`git -C`/`-C/path`/`--git-dir` 等全局旗标与 cwd 越界直接不放行。纯函数 `gitFlowSafeCommand` 在 `ai-command-rules.js`（配 `ai-command-rules.test.mjs`），决策链入参 `gitFlowSafe` 在 `ai-permissions.js`（配 `ai-permissions.test.mjs`）。方案见 `docs/finished-plans/git-flow-auto-exemption.md`。

### AI 生图（参考图编辑 / 图生图）

- **`generate_image` 支持参考图（新 `reference` 参数）**：此前只会发纯 prompt，主流生图服务商（SenseNova `/v1/images/edits`、豆包、通义万相等）的「参考图 + 编辑指令」图生图接口完全用不上。现在 `reference` 收至多 5 张（工作区相对路径 / 已授权的工作区外绝对路径 / http(s) 图片地址，单张 ≤4MB）：本地图走 `read_file` 同一条读权限链（read/edit 档弹读卡、auto/full 直读、应用数据目录硬拒），读成 Data URL 交给服务商；远程 URL 原样透传由服务商拉取。传了参考图即改走条目的**编辑端点**，不传则行为与旧版逐字一致（回归零差异）。
- **条目新增 `editPath` / `editImageWrap`**：`editPath` 是同步型 JSON-body 编辑端点（留空 = 该条目不支持参考图）；`editImageWrap` 是参考图数组元素的包装字段名（缺省 `image_url`，留空 = 裸字符串数组）。请求体模板新增占位符 `{{images}}`——渲染成 JSON 数组字面量，模板里同样不手写引号：`{"model":{{model}},"images":{{images}},"prompt":{{prompt}}}`。设置 → AI → 生图与视频 的编辑器补了两个字段，条目列表的摘要行会标出「图生图 <端点>」。
- **明确边界（不静默降级）**：缺 `editPath`、模板里没有 `{{images}}`、异步型条目（已知编辑端点均为同步型）、`data:` / `file:` 这类绕过文件授权的输入，都直接报错而不是把参考图悄悄丢掉；单张超 4MB 提示压缩而不自动改图（不擅自动构图与画质）。**multipart/form-data 的编辑端点（OpenAI 官方 `/v1/images/edits`）不支持**——请求体模板体系发不了 multipart，只接 JSON body 的接口，技能文档里写明兼容性。
- **审批与留痕**：生成审批卡的命令行内联「（参考图 N 张：<逐个路径/URL>）」，用户批准那一刻就能看见哪几张图会被外传；工具卡新增参考图行（本地图按路径现读小缩略图、可点开，远程 URL 只显示地址不代拉取）；操作留痕只记张数（`refCount`），会话 JSONL 只存路径/URL 摘要，Data URL 本体只进请求体——不落日志、不进模型上下文。实现落点：`ai-gen-model.js`（`classifyGenRef` / `renderGenImages` / `dataURLBytes` / `genRequestPath` 与 `{{images}}` 渲染，测试 `ai-gen-model.test.mjs` 8 例）、`ai-panel.js`（`resolveGenReferences` + 编辑端点校验）、`ai-gen-jobs.js`（端点选择）、`ai-tool-defs.js` / `ai-tool-cards.js` / `style.css`、`ai-gen-settings.js`、内置技能 `cadt-gen-models` 与 `get_gen_models` 视图。
- 修复 **`generate_image` 大图回传的误导文案**：`review: true` 时若产物 base64 超过 3MB 上限（`AI_IMAGE_MAX_BASE64`，防大图耗尽对话上下文），此前统一报「生成图片数据无法解析」，听起来像产物坏了——实际是**有意跳过回传**，产物已正常落盘。现在先判大小：超限返回「生成图较大（约 X MB），已跳过图片回传；产物已正常保存，可用 read_image 查看」，只有真正数据异常（mime 非法 / 无数据）才保留「无法解析」。落点：`ai-panel.js` 的 `genReviewImages`（`dataURLBytes` 先判大小再走 `aiNormalizeImage`）。
- **支持 `multipart/form-data` 的编辑端点（Qwen-Image / OpenAI 官方 `/v1/images/edits`）**：此前参考图编辑只支持 JSON body 的 edits 接口（SenseNova 等），而 Qwen-Image-2.1、OpenAI 官方的 `/v1/images/edits` 收的是 FormData——图片是独立的文件字段（同名重复 = 多参考图），JSON 传不进去，调用只能得到 `422 {"loc":["body","prompt"]}`。现在条目新增 **`editFormat`** 配置（`json` 缺省 / `multipart`）：multipart 下 `bodyTemplate` 只提供其余文本字段（不要求 `{{images}}`），参考图按 `editImageWrap` 命名的文件字段重复提交（缺省 `image`，与 OpenAI 一致），请求体由前端拼成完整 multipart 字节流、base64 后交 Go 解码发送（JSON 字符串传不了二进制）。multipart 只接受本地图片（URL 参考图明确报错，需换本地文件或 JSON 型端点）。实现落点：`internal/aigen/aigen.go`（`HTTPSpec.BodyBase64` + 解码，配 `aigen_test.go` 二进制回环用例）、`ai-gen-model.js`（`buildGenMultipart` 纯函数：模板→文本字段、Data URL→文件段、边界拼接与 base64，配 `ai-gen-model.test.mjs` 3 例）、`ai-gen-jobs.js`（`runSync` 按 `editFormat` 分流并覆盖 Content-Type）、`ai-panel.js`（multipart 免 `{{images}}` 校验 + `get_gen_models` 视图带 `editFormat`）、`ai-gen-settings.js`（「编辑端点格式」下拉）、`ai-constants.js`（cadt-gen-models 技能说明）。
- **异步条目新增「探针端点」`probePath`（解决产物在独立端点、轮询响应里没有下载地址的服务端）**：本项目异步链路只从**轮询响应 JSON** 里按 `resultPath` 取产物（b64 或 http(s) URL），而有的服务端跑完只在响应里给一个本机文件路径（`url` 为空），成片实际放在独立端点（形如 `/v1/videos/{id}/content`）——于是出现「任务已完成却取不到产物」。现在条目可配 `probePath`（支持 `{{jobId}}`）：轮询时额外探一次，**2xx 即视为完成**，产物直接用该 URL 下载。同时给 `SaveProducts` 补请求头透传（`SaveSpec.Headers`，禁头再挡一次）——产物端点通常需要 `Authorization`，此前只有 User-Agent、必然 401。探针失败不改变任务状态（继续原节奏轮询），避免瞬时网络问题被当成任务失败；它与服务端正常回填的 `status` 互补（状态写回可能存在滞后）。实现落点：`internal/aigen/aigen.go`（`SaveSpec.Headers` + `aiGenDownloadURL` 带头下载，配 `aigen_test.go` 鉴权下载/禁头拦截用例）、`ai-gen-model.js`（`probePath` 归一）、`ai-gen-jobs.js`（`probeProducts` + 轮询兜底 + `saveProducts` 传头）、`ai-gen-settings.js`（「探针端点（可选）」字段）、`ai-gen-model.test.mjs`（归一化用例）。

### AI 内嵌浏览器

- **AI 可打开本地文件（`file://`）**：此前 `browser_navigate` 只放行 http/https/about/data，模型查看本地产物（HTML 回答页、构建产物、vendor 页面）只能另起静态服务器。现在 `browser_navigate` 与 `app_control` 的 `open_browser_tab` 都支持本地文件，并走与 `read_file` **同一条读权限链**：工作区内直接打开；工作区外按「用户点名 / 已批准读根 / 自动·完全权限 → 直开，只读·每次询问 → 弹读取审批卡」处理；应用数据目录（密钥与会话数据）任何档位拒绝。`file://` 地址先解码再归一（`%2e%2e`、`%2f` 拼出的越界按真实路径判定，盘符/UNC 分享根是地板），`open_browser_tab` 不再成为绕过审批的旁路；用户手动在地址栏打开不受影响。纯函数 `normalizeFileUrlTarget` 在 `ai-file-tools.js`，测试见 `ai-file-tools.test.mjs`。

### 外部 AI 工具（搜索 / 抓取 / OCR / 语音）与设置归位

- **设置 → AI 新增「外部工具」页**：MCP 服务器组从「AI 助手」页迁入（配置与绑定代码未变），与新增的能力来源矩阵、服务提供商配置合并为同一页。AI 子页顺序变为 模型 / 生图与视频 / 外部工具 / AI 助手 / 权限 / 个性化 / 上下文注入 / 用户偏好 / 定时任务。
- **五种能力各选来源**：搜索、抓取 = 内置（默认）/ 服务提供商 / 本地 MCP / 关闭；OCR、语音合成、语音识别 = 服务提供商 / 本地 MCP / 关闭（默认）。来源关闭时工具不注册；provider 未启用或缺 Key、MCP 绑定失效时按关闭处理（设置页给出提示）。搜索/抓取的非内置来源失败**自动回退内置并注明**；OCR/语音不回退，明确报错。选择本地 MCP 时沿用 MCP 既有边界：仅写权限档、非计划模式、按绑定工具名走写工具审批。
- **服务提供商 = DeepSeek 工具 API**（`/v1/tools/*`）：新增搜索、抓取、OCR、TTS、ASR 适配；搜索映射到现有结果结构（`engine=deepseek`），抓取返回 Markdown；OCR 按页返回并在 4 万字符预算处标注省略页；TTS 音频流边读边写临时文件、原子改名到 `.cadt/gen/tts/tts-YYYYMMDD-HHmmss-*.wav`；ASR 接受 WAV / Ogg Opus。配置存 `<应用数据>/external-tools.json`（0600），API Key 不回传前端、日志脱敏，留空保存 = 保持原值，清除走独立按钮。
- **新增 AI 工具**：`ocr(path, purpose?)`、`text_to_speech(text, voice?)`、`transcribe_audio(path)`，工具目录新增「语音与识别（外部服务）」组。provider 来源下 OCR/ASR 全权限档可用（OCR 读文件、ASR 上传音频，审批沿用域名规则并可显示预估费用），TTS 写权限档（产物写工作区）；MCP 来源按上条边界。ASR 非直传格式走 WebView2 WebAudio 转 16 kHz 单声道 + 纯 JS WAV 编码（零新依赖，20 MB / 15 分钟上限，wma / ape 明确拒绝）；TTS 工具卡可直接打开产物。
- **本地来源示例**：`docs/mcp-samples/` 提供 `tts-sapi.ps1`（Windows SAPI）、`ocr-windows.ps1`（Windows.Media.Ocr，需 Windows PowerShell 5.1）、`asr-whisper.py` / `asr-whisper.md`（whisper.cpp 接入脚本）；三份脚本随后改为随 exe 内嵌的内置示例（见下条），模型与本地引擎仍由用户自备。
- 实现落点：引擎在 `internal/webtools`（配置、DeepSeek 适配、音频读取），根目录 `webtools_config.go` / `webtools_app.go` 只做绑定；前端 `ai/ai-external-tools.js`（来源判定与结果格式化）、`ai/ai-audio-transcode.js`（转码）、`settings/settings-pane-external-tools.js`（设置页）；新增测试覆盖配置归一化、来源可用性、WAV 编码与 httptest 假服务。
- 修复 **MCP 服务器「工具」勾选面板跑到整页最底部**：面板此前 append 到列表容器的父级末尾，MCP 组迁进外部工具页后落到了「内置示例」下面。现在与状态灯诊断行同一规则，插在所属服务器行之后展开（左侧缩进对齐服务器名）；列表重绘（启停、状态事件）后自动挂回，服务器被删/改名时面板一并收起。

### MCP 服务器（AI 代配）

- 新增 **AI 可代配 MCP 服务器**（`app_control` 新动作 `get_mcp_servers` / `set_mcp_server` / `delete_mcp_server` + 内置技能 `cadt-mcp-config`）：用户说「帮我接 XX MCP server」，AI 按官方文档代填 command / args / cwd / 超时 / 启停，部分更新语义（未传字段沿用原值）；保存后刷新设置页并提醒用户去「工具」面板勾选授权。
- **安全边界（比生图条目更严）**：env 值不可读写——AI 只能用 `envKeys` 登记变量名（值留空由用户填）；`enabledTools`（工具授权）永远由用户勾选，AI 不能设置；新增/修改/删除每次都会弹「本机命令执行」确认，即使用户选了自动审批也不会静默执行；已配置环境变量的服务器 AI 不可修改/删除。只读视图不下发 args 原文与环境变量值，只给命令、参数个数、env 键名、已授权工具与运行状态。
- 实现落点：纯逻辑 `frontend/src/ai/ai-mcp-config.js`（视图脱敏 / 合并 / 删除保护，测试 `ai-mcp-config.test.mjs`），审批与接线在 `ai-panel.js` 的 `app_control` 分支；`AI_TOOL_DEFS`、`APP_ACTIONS`、`cadt-ui` 技能与新增 `cadt-mcp-config` 技能同步登记。
- 新增 **内置 MCP 示例**（设置 → AI → 外部工具 → MCP 服务器 → 内置示例）：TTS（Windows SAPI）、OCR（Windows.Media.Ocr）、ASR（whisper.cpp）三份脚本随 exe 内嵌，安装时释放到应用数据目录 `builtin-mcp-samples/<版本>/` 并合并进 `mcp.json`（只启用该示例自己的工具，不覆盖同名服务器）；**只内置脚本，不内置 Python / whisper 模型 / OCR 引擎**，exe 只增加约 20 KB。释放副本登记进设置 → 存储与清理，可随时删除重装。
- AI 新增 `list_mcp_samples` / `install_mcp_sample` 两个 app_control 动作与内置技能 `cadt-mcp-samples`：用户缺本地 TTS / OCR / ASR 时，AI 先列示例、说明前置条件，用户同意后安装（每次弹本机命令确认）；安装后提醒去「能力来源」绑定并填 ASR 的 `WHISPER_CLI` / `WHISPER_MODEL`。ASR 示例的 `asr-whisper.py` 从文档中抽出为独立可运行文件。

### 思考循环守卫

- **检测模型陷入重复思考**：流式思考在尾部行窗口上同时看「最高同文重复次数」与「不同行占比」，达到提示阈值时思考卡头标为「重复思考」；同一句重复 15 次时在输入区弹出**带 30 秒倒计时的确认卡**（停止本轮 / 继续观察），无回答自动停止，继续后 2 分钟内仍重复也会自动停止。子代理命中时直接自动停止并在记录摘要里注明，不抢主面板输入区。只认完全相同的整行，正常清单 / 代码引用与历史会话全量回放均未误报；判定本身是纯函数（`ai-loop-guard.js`），确认卡由通用系统接管状态机（`ai-system-takeover.js`）驱动，后续其他「应用发起、模型不可见」的确认可复用。

### 存储与清理（设置 → 诊断 → 存储与清理）

- **新增「存储与清理」页**：把本应用自己产生的缓存与数据登记成一张条目表，逐条显示占用与后果，提供**一键清除缓存**与**按勾选清除数据**。顶部三格占用（应用数据目录 / 当前工作区 `.cadt` / 系统临时目录里我们写的那部分）+ 一条「可释放缓存 / 用户数据 / 其他」占比条；格子数字包含没登记进条目表的「其他」，所以等于目录真实占用，不会出现「条目加起来比目录小」。统计有 30 万条目硬预算，超了标注「约」，不会把设置页拖死。
- **清除口径**：缓存（运行临时副本、内嵌浏览器实例数据、界面浏览器缓存、会话搜索索引、运行日志、调试控制台日志、AI 对话导出、模型配置表缓存、内置技能释放副本、系统临时文件、工作区 AI 工作日志）**直接删除**，立刻还回磁盘；用户数据（生图产物、AI 回答页、工作区/应用级记忆、计划正文、补丁库、AI 会话记录、定时任务、操作记录、分类器个性化、全部配置）**送进回收站**，误删可取回。标了「不可恢复」的条目在确认框里逐个点名，未打开工作区时工作区条目整行置灰。
- **实测最大的一项**：内嵌浏览器每个标签一份独立 WebView2 配置，关掉标签后不会回收——本机实测 `BrowserSessions\` 累积 44 份、1.1 GB。清除时正在使用的实例自动跳过并在行上标注「N 项使用中」。
- **WebView2 相关两项排到下次启动前执行**：界面浏览器缓存（约 150 MB 的 `Code Cache` 等）与界面状态在运行中被浏览器进程锁住，点了只写 `<应用数据>\.pending-clean` 标记，程序下次启动、WebView2 还没创建时执行；没清干净（例如另一个窗口还占着）就保留标记，不会把用户点过的清除请求吞掉。缓存只删浏览器自己会长回来、不需要联网重下的目录，`Local Storage`（界面设置）与登录态不受影响。
- **实现落点**：引擎在 `internal/storage`（条目表、体积统计、清除与待清理标记），仓库根只留壳 `storage_app.go` 注入位置与回收站动作——这是 `docs/unfinished-plans/go-layout.md` 抽包方案落地的第一个 internal 包。位置一律向宿主索取，引擎不自己拼目录名，避免「写入端改了目录、清理端还在原地删」。前端 `settings/settings-pane-storage.js` 只渲染这张表并传 id，删除路径不接受调用方拼接。

### 内置终端（稳定性修复）

- 修复 **终端会话退出时把进程句柄二次回收，导致应用无规律闪退**：退出监听原先是 `cmd.Wait()` 收掉进程之后，再调 `cmd.Process.Wait()` 取退出码。`go-pty` 的 `Wait` 内部已经做过 `Process.Wait()`，第二次调用等于对同一个进程句柄重复 `CloseHandle`——句柄号被别处复用之后，踩空的是整个进程。现场表现为「跑过终端会话的进程里，稍后用句柄的东西随机崩」：`go test ./...` 会崩掉测试二进制（`0xc0000374`），而崩溃点落在毫无关系的目录监视用例 `TestWatchDirectoryReceivesCreate` 上；去掉终端用例、或单独跑监视用例都不复现。现在退出码一律从 `cmd.ProcessState` 读。
- 修复 **同一会话的 ConPTY 句柄被释放两次**：`ClosePseudoConsole` 不幂等，但「进程退出」（`finish`）与「用户关闭 / 应用退出」（`closeAll`）两条路径各自都会 `p.Close()` 一次。现在两条路径共用一次性的 `releasePty()`。
- 修复 **已退出的会话仍被 `Kill()`**：`TermClose` 与应用退出时的 `closeAll` 都会先 `terminate()`，而进程早已被回收——同样是往可能已被复用的句柄号上打枪。现在会话标记为已退出就跳过 Kill。生产路径上这是常态：AI 的 `terminal` 工具读完输出就关会话，用户关终端标签也一样。
- 新增两条回归用例：`TestTermReleasePtyOnlyOnce`（用计数替身把「Close 只能一次」钉成静态断言）、`TestTermExitCodeAfterRealProcessExit`（真起 `cmd` 会话跑 `exit 7`，走完整退出链路后再 terminate/closeAll）。全量 `go test ./...` 连跑三次全绿（修复前必崩）。

### AI 助手

- 修复 **full 档与工作区内路径绕过应用数据目录硬拒**：`resolveReadPathWithApproval` 在 `aiResolveScopePath` 成功（full 档 / 工作区内）时提前返回，`sensitiveReadDenyReason` 与扫描类的 `scanRootDenyReason` 从未执行——full 档下 AI 能把 `ai-config.json`、会话数据扫进转录。现在两道硬拒在作用域解析之后、在范围内提前放行之前执行（任何档位与工作区内路径同样生效），默认扫描根（工作区）也做「包含应用数据目录」检查。`run_command` 读敏感路径仍是已知边界，不在本次范围内。
- **`search_text` / `glob` 支持自定义起点目录（含工作区外）**：`search_text` 新增 `path` 参数（默认仍是当前范围根）；两者传工作区外绝对路径时走与 `read_file` 相同的授权链——用户点名或已批准读根直接搜，read/edit 档弹审批卡（记住的粒度是目录本身），auto/full 档直接搜，子代理报回主代理。起点**包含**应用数据目录时拒绝（避免把 `ai-config.json` 扫进结果），传文件路径直接报错并提示用 `read_file`。此前外盘搜索只能借 `run_command` 绕。
- **会话列表不再在轮中间跳动**：条目的排序与右侧时间以前取「最后一条消息的时间」，于是同一轮里的工具结果、审批改写、截图自动附加、轮次提醒都会把会话（尤其是后台跑着的那些）不断顶到列表最前、时间一路往前推。现在统一按**轮次起点**——最后一条「用户发起的回合」的消息时间（用户消息、定时任务/会话投递/计时器到点等注入的轮首消息都算，轮中间的过程消息不算），一条会话只在有人对它说话时上跳一次；运行中 / 待确认 / 已完成未查看仍由条目右侧的状态图标实时表达。占位会话（正文未加载）改用 meta 里新增的 `turnTs` 缓存同一个键，补水前后不会跳位；老会话首次活动后自动补齐。
- 新增 **`session_search` / `session_read` 两个跨会话检索工具**：AI 可以按关键词搜「哪个会话说过这件事」（复用全局搜索的 AI 会话通道，只搜未归档会话、带 3 秒 / 100 条硬预算），再用 `session_read` 读该会话的消息摘要（默认最近 20 条；给了关键词则返回命中消息及前后各一条；单次输出 ≤ 8000 字符）。跨工作区的会话会明确标注来源，提示引用前先核对。此前 `session_history` 只能查当前会话。
- 新增 **`glob` 工具**：按 `*.go`、`src/**/*.ts` 这类通配列工作区文件（只回相对路径与大小，不读内容），补上「已知文件名找路径」的缺口——此前只有 `list_dir`（单层目录）与 `search_text`（按内容找）。同时把 `search_text` 的 `filePattern` 从「前端先取 1000 条再过滤」**下推到搜索层**（rg 走 `--glob`，内置扫描在遍历时过滤），无关文件的命中不再挤占结果窗口。两者共用同一套通配语义（`*` / `**` / `?`，且 `**/` 可匹配零个目录段），Go 与前端各有一份表驱动用例互相卡住。
- 新增 **`terminal` 工具**：AI 可在应用内置终端（ConPTY 持久会话）里 `open` / `send` / `read` / `signal` / `close`，适合 dev server、交互式 CLI 这类需要持续输入的长驻程序。AI 自建的终端与用户点「新建终端」出来的完全一样（同一个页签、同一份输出流，并自动打开底部面板）；`read` 读的是 Go 侧 64 KiB 滚动缓冲——面板收起时也能拿到输出，进程退出后缓冲保留到关闭为止；写操作走与 `run_command` 同一条命令审批链（`deny` 规则同样生效），`signal` 发 Ctrl+C。停止生成不会杀掉终端里的程序，需要中止请显式 `signal`。
- **工作日志的月份索引回归「一句话」**：`.cadt/logs/{YYYY}/{MM}/INDEX.md` 此前每条把标题 + 最多 500 字摘要拼成一行，索引退化成正文复制（一个月 37 条就有 22 KB）。现在每行只放「日期 + 短标题 + 指向当日正文的链接」，摘要只留在正文里；`write_worklog` 的工具描述同步收口——标题写成 ≤40 字的一句话（索引里只有它），细节/验证/待办进 summary，写超长时索引侧再收紧到 48 字并在断句点截断。
- 修复 **判定 / 系统提示胶囊掉到看板娘条下面**：`showNote` 无条件把 `.ai-note` append 到消息区末尾，而流式状态条（看板娘条）固定钉在最底——「AI 分类器判定中」「端侧未放行…AI 复核放行」这类提示全排到了看板娘下面。现在与工具卡同一规则：状态条在场上时插到它之前，提示始终留在消息流里、看板娘条保持置底。

### 数据源（Gitee / GitHub）

- **设置 → 插件 → 插件市场新增「数据源」选择**（默认 Gitee，可选 GitHub）：GitHub 侧 `cadt-datalens-plugins` 与 `cadt-datalens-data` 两个组织是 Gitee 的同名镜像，内容一致。
- 切换数据源后，插件市场列表、仓库主页与「从仓库地址安装」示例地址改走 GitHub 组织；AI 模型配置表的默认同步地址同步切换（自定义配置表地址仍优先）。更新检查仍固定读 Gitee Release，不受此设置影响。
- 插件市场遇匿名接口限流（HTTP 403/429）时自动换另一侧镜像重试一次（数据源设置仍是首选，回退只影响本次抓取）；两侧都失败时错误提示改为可操作文案：稍后重试或切换数据源。

### 设置页（分组与顺序重排）

- **AI 子页按「接入 → 行为 → 边界 → 内容 → 自动化」重排**：模型 / 生图与视频 / AI 助手 / **权限** / 个性化 / 上下文注入 / 用户偏好 / 定时任务（权限从末尾提到 AI 助手之后）。左栏 AI 子页图标随之各不相同（用户偏好原与个性化共用 ★，新增注册表图标 `list`）。
- **权限内容归一**：原散在「AI 助手」页的「新会话默认读写权限」「写操作审批」「AI 工具权限」三组并入「权限」页，顺序为 模式与判定顺序 → 新会话 → 项目规则 → 写操作审批 → AI 工具权限 → 会话与审批记录 → 端侧分类器；「AI 助手」页只剩 界面 → 上下文与记忆 → 聊天行为 → 对话日志 → 子代理 → MCP 服务器 → 通知 → AskQuestion 与重试 → 配置迁移。
- **通用设置拆成「常规 / 外观」**，并把**固定键列**移到「编辑器与写作 → 文件树与代码视图」，与「键列宽度」并排（此前同一件事的两项分居两页）。
- **「编辑器与写作」重排**：标签页 → 字体 → 文件树与代码视图 → **Markdown 预览** → **写作模式** → 代码截图（原 11 行的「Markdown 与写作模式」拆成两组，低频的代码截图挪到末尾）。
- **「上下文注入」**：系统提示词 → 工作区上下文 → 项目与记忆 → 个性化 → 环境变量；**「运行」**：运行 → 运行配置（预设）→ 命令模板（覆盖）；**功能区**左栏：快捷键 → 运行 → 插件 → 系统集成 → 环境变量。
- 设置项本身、开关与存储均未改动，只调整位置；设置搜索与各项提示里的「设置 → …」路径同步更新。

### 补丁（.patch / .diff）

- **补丁库不再越用越脏**：内容完全相同的补丁再次提交时复用已有的那份（不再每次重试都落一个新 `.patch`）；空补丁（`+0/−0` 且没有新增文件）与预检阶段就失败的补丁不再落盘留档。
- **补丁能删了**：设置 → 开发者新增「补丁库」列表，删除时把 `.patch`、应用备份、manifest 与元数据一并送进回收站，并从索引里摘掉该补丁的全部历史行（此前 `PatchDelete` 只删备份和 manifest，界面也没有入口，删完仍会留在列表里变成幽灵记录）；已应用的补丁删除前二次确认「无法再撤销」。
- **应用中断的补丁会自愈**：上次应用中途被打断、只留下 `applying` 而没有终态的补丁，打开补丁库时自动收敛为「应用中断」，不再永远显示「应用中」。

### 主题体系（重构）

- **软件主题精简为深色 / 浅色两套**：深色抛弃旧配色、以 IDEA Dark 为基底重制（界面整体换到 IDEA 新 UI 观感），浅色同步以 IDEA Light 为基底重制。原 Darcula / IDEA Dark / IDEA Light / Github / Newsprint / Night / Pixyll / Whitey / Harness 九套界面主题**降级为「代码主题」**，并入主题菜单的「代码主题」子菜单（原「代码风格」，显示名对齐老主题：IDEA Dark / Darcula / Tokyo Night / IDEA Light / GitHub Light / Shiki（DeepSeek）/ Newsprint 暖纸 / Pixyll / Whitey）。
- **代码主题升级为完整「编辑器配色方案」**：除语法 token 外，还接管编辑器底色、正文色、行号槽、选区、当前行与缩进线（新增 `--editor-bg` / `--editor-text`，`--ace-*` 随代码主题走）——深色界面配浅色代码主题时编辑器区完整变浅，对齐 IDEA 的「UI 主题与编辑器配色方案分离」；代码截图底色/正文同步跟随编辑器配色。Pixyll / Whitey 原本缺的 token 由各自取值色与中性色合成补齐。
- **旧主题自动迁移**：老配置里存着九套降级主题 id 时，启动自动换到深色/浅色 UI 主题 + 对应代码主题（如 darcula → 深色 + Darcula、github → 浅色 + GitHub Light）；显式选过代码风格的用户只迁界面不动代码选择；插件注册主题不受影响。harness 的界面专属细节（近黑主按钮、白输入框等）随降级移除，其编辑器观感由 Shiki（DeepSeek）代码主题保留。
- **快速切换面板同步**：Ctrl+` →「主题」子列表在深色 / 浅色之下补入代码主题一组（「跟随软件主题」+ 9 套，与主菜单同一清单单一来源 code-styles.js），勾选态与键盘数字 / 方向键行为不变。

### 内嵌浏览器

- **修复切换视口尺寸预设导致整个软件闪退**：内嵌 WebView2 的桥接消息回调里，页面 `postMessage` 非字符串（或被注入的 `window.external.invoke` 通道触达）会走库的错误回调；该回调原先以 panic/`os.Exit` 收场，而它跑在 COM 原生派发帧上——panic 穿不过去，进程直接没了（表现为点一下预设窗口就消失，无任何报错）。现在 go-webview2 本地补丁把错误回调改为「只通知、不退出」，宿主侧把出错实例**隔离**（记一条带栈的运行日志、通知前端提示「标签页需要重新打开」、该标签页后续调用返回明确错误），单个页面出问题不再带走应用；隔离中的标签页仍可正常关闭并同名重开（回归测试 `TestBrowserObjectMessageQuarantine` 覆盖）。
- **固定视口改为区域内等比缩放**：选「1280×720 / 375×812」等预设后，网页不再按设定尺寸把控件铺到标签页外、盖住工具栏与其他面板——逻辑视口保持设定宽高，画面用 WebView2 栅格缩放（`RasterizationScale`）等比缩进可用区域并居中（DevTools 响应式模式的做法）；自定义尺寸与 AI `browser_resize` 同享此行为。自适应模式也显式下发设备缩放比，切换系统分辨率/缩放后页面比例不再错位。`BrowserSetBounds` 增加栅格比例参数（第六参），前端同步矩形缓存纳入该值。

### 窗口与集成

- 修复 **给子代理投递的指令要晚一轮才生效（冷唤醒时表现为复述上一轮结论）**：三处续轮路径——冷唤醒 `reviveSubAgent`、工具轮 `runSubToolRound` 末尾、插队打断的 `steerKick` 分支——原先都是先 push 一个空的 assistant 续写目标，再由 `runSubRound` 开头把投递消息消费成 user 消息，会话因此变成「…assistant(新建), user(投递)」。而 `runSubRound` 用 `buildApiMessages(sub.session, indexOf(assistant))` 组装请求，只取 assistant **之前**的消息，那条投递被整体排除在请求之外：冷唤醒时模型看到的历史仍以第一轮对话结尾，于是照着旧上下文又答一遍（实测：落账记录的 `rounds/ms/tokens` 是本轮的，正文却是上一轮的）；运行中投递与插队则表现为指令晚一轮生效（实测：投递停止指令后仍按原任务多跑一轮）。现在三处一律改为先消费投递、再 push assistant，`indexOf` 命中末条，投递必然进入请求；收尾轮（wrapUp）保持不消费的原有口径。三条路径均已实测（工具轮排队投递、urgent 插队、冷唤醒），组装请求时 assistant 之后的消息数恒为 0。
- 修复 **`wait_agent` 把冷唤醒前的旧结论当成本轮结果返回**：唤醒后立刻 `wait_agent` 时 live 可能已消失、记录还是唤醒前那份，旧逻辑无条件返回「（该子代理此前已结束，无需等待）」+ 旧结论，主代理会误以为新任务已完成。现在冷唤醒给旧记录打 `revivedAt`，`wait_agent` 用新增的纯函数 `isStaleRecord` 判断记录是否诞生于唤醒之前——陈旧则等新一轮落账（超时与用户停止各给专门文案），不再返回旧结果；表驱动测试覆盖陈旧 / 已落账 / 同一毫秒 / 缺字段 / 脏字符串五种组合。
- 新增 **回复正文里的文件引用芯片**：AI 回复里反引号包裹的工作区文件路径渲染成可点击芯片（文件图标 + 悬浮显示完整路径与行号），点击在编辑器打开，带 `:行号[:列号]` 后缀（如 `src/main.js:42`）时同步跳行定位。裸文件名（不含目录）自动按已打开的标签页匹配；只有 `GetPathInfo` 校验真实存在的文件才升级成芯片，其余保持普通代码样式——零误伤。识别规则是纯函数（`ai-file-refs.js`，配表驱动测试），存在性校验结果按绝对路径缓存（流式期间每帧重渲染不重复 stat）；`<workspace_rules>` 同步加守则，要求模型引用文件时用反引号包相对路径。
- 修复 **极快连发两条消息后，第一条的回复占位永远停在「…」**：起轮前的上下文预检是异步点，两次极快发送可能都通过忙检查（双方都还没注册流），各自起轮后后者顶掉前者的流注册，落败方的 assistant 占位没人收尾——界面上一条回复永远转流式点点，第二条正常完成。现在真正落消息前再查一次忙把窗口关死（队列冲刷对 busy 自动重新入队不丢消息），并在「轮被顶替/已停止」守卫处加兜底：占位 assistant 若仍停在流式态一律收尾为「已停止」，不再出现永不消失的「…」。
- 改进 **AI 面板头部移除「停靠 / 全屏 / 悬浮」三连图标**：显示方式默认全局停靠分屏，调整入口收进面板 **[…] 菜单 →「显示方式」二级菜单**（停靠分屏 / 全屏 / 在独立悬浮窗打开，当前档位打勾；原先只在头部宽度不足时才出现，现在常驻）与 **设置 → AI 助手 → 界面 → 显示方式** 下拉（选「独立悬浮窗」即打开独立窗口）；主菜单「视图 → AI 面板显示方式」不变。头部宽度不足时「换到另一侧」按钮仍收进[…]菜单补回。
- 修复 **全局搜索面板的「AI 会话」范围下拉弹出浏览器原生样式**：三连 Shift / AI 头部搜索打开的面板里，简要 / 详细模式下拉只换了触发器外观，点开仍是 WebView2 原生弹层。现在接入设置页同款行式下拉增强（`settings-select.js` 新增单选入口 `enhanceSelect`，经 main.js deps 注入），弹出改为统一 Portal 浮层（按视口定位 / 主题化 / 键盘与外点关闭行为一致）；触发器保持原紧凑行外观，原生 select 仍是值真源。
- 修复 **AI 输入框的背景遮挡与圆角打架**：底部堆叠区的同色铺底此前从输入框顶边整块直角铺起，消息卡滚入时被一条与输入框圆角相切的直角横线拦腰截断，方角压着圆角很违和。现在铺底拆两层：新增**圆角兜底扩层**（`.ai-bottom-stack::after`，输入框盒外扩 6px 的同心圆角——左留 6px 同色凹槽，右贴滚动条槽边界，消息卡右缘本就距输入框 11px，圆角夹角里不会露出卡片），全宽铺底（`::before`）顶边下移到「肩线」（圆角 + 6px）；消息卡滚入时遮挡沿输入框圆角轮廓收口，不再出现相切直角线。输入框圆角收敛为单一来源 `--ai-composer-radius`（harness 主题覆写 16px），扩层与肩线经 `calc` 联动，改圆角只动一处。
- 修复 **Git 面板取消勾选的文件几秒后被重新勾上**：侧栏 Git 视图按 `treeRefreshInterval` 轮询刷新，重渲染时文件勾选框硬编码为全选——勾选状态只在当前 DOM 里活 3 秒，没法「取消勾选一部分文件再提交」。现在勾选状态与组折叠记忆一样跨轮询保留（未勾选集合随文件从变更列表消失——提交/回滚/外部还原——与工作区切换自动清理），组头全选/全不选同步写回集合。
- 修复 **增量挂卡后看板娘条被顶上去一格**：工具循环增量挂卡直接 append 到消息区末尾——新工具卡排到了「钉在消息区最底」的流式状态条（看板娘条）后面。现在挂卡时若状态条在场上则插到它之前，置底关系恢复；全量重建路径本来就在最后 append，不受影响。
- 改进 **任务清单轮末同步提醒（`<task_todos_check>`）**：系统提示里的 `<task_todos>` 是轮开始快照，长工具链中模型对被动提醒依从性低（干完活不标 completed、总结都说完了清单还挂着）。现在每批工具循环结束、收尾请求发出前，若清单还有未完成项且本轮跑过工具，注入一条 systemNote 硬提醒（「已完成的步骤请立即 todo_write 标 completed，不要在总结里口头说完成而清单没有更新」）——离行动点最近的催促，随收尾请求进入模型上下文。本轮没跑工具、清单全完成时不催。
- 新增 **/compact 带压缩焦点指令**（Codex 风格）：`/compact 保住补丁库方案` —— 指令（≤500 字）追加进压缩请求，摘要器按指令决定取舍；指令记入压缩触发快照（事后可查「凭什么压的、按什么压的」）。自动压缩路径无指令不受影响。
- 改进 **AI 分类器复核注入用户设置的严格度**：云端大模型复核的输入此前只有端侧 score/阈值，不知道用户设的严格度——「严格」档下用户希望复核也更谨慎，模型却按默认保守度判。现在 `userPayload` 带上 `strictness`（loose/standard/strict，与端侧阈值同源），提示词说明三档语义（strict 时几乎只有纯只读、幂等命令才 allow）。
- 修复 **AI 面板拖宽被硬顶 640px**：大屏分屏用 AI 面板拖不到半屏宽。上限改为视口 60%（至少 640 保底），拖拽、持久化、设置表单、dock 恢复四处统一；此前漏改的 `#ai-panel.ai-dock { max-width: 640px }` CSS 兜底一并移除——它把拖拽/设置写进内联 width 的值在渲染层压回 640，JS 四处统一后仍表现为「拖不动」，现宽度上限唯一来源是 JS clamp。
- 修复 **删除当前会话后跳到列表里最旧的会话**：删除后的 fallback 取的是 `sessions[0]`（数组头 = 最旧的对话），看起来像「跳到了最后一个对话」。现在删除当前会话时**新建一个空白会话**并跳过去；删除其他会话时当前选中不变。
- 修复 **`<task_todos_check>` 提醒块渲染到了消息流里**：它是给模型的机械注入块，不是给人看的——消息新增 `silent` 标记（保留 DOM 与索引，`buildApiMessages` / 会话定位照常使用），渲染时整条 `display:none` 隐藏；历史会话里的旧提醒块按内容前缀识别回填 `silent`（修复前落盘的数据没有该字段，仅靠字段判断盖不住旧会话）。
- 改进 **瞬态注入块发请求时只保留最新一条**：轮末提醒这类带 `dedupeKey` 的注入块，若模型一直没同步清单会在历史里累积——旧条目每次请求都重发，浪费上下文还用过期状态误导模型。`buildApiMessages` 组装时对同类 `dedupeKey` 只保留最新一条，历史条目剔除（会话里照常保留可查）。长任务 10 批工具原来会发 10 条相同提醒，现在只发 1 条。
- 新增 **组装请求时的实时瘦身（会话历史原样保留，只瘦发给模型的部分）**：① **历史 reasoning 剔除**——思考只服务于当轮行动，只保留最近 2 轮的 `thinking`，更早轮次的每轮数千 token 思考不再重发（Claude 系官方也推荐清理旧思考块，当轮工具循环内的完整保留不受影响）；② **过时的大工具结果修剪**——2 轮之前的 `read_file` / `web_fetch` / 命令 / 搜索输出超过 8192 字符时保留**头 4096 + 尾 1024**、中间打「已修剪」标记（参数对齐 dsh tool-result-pruner 默认值：头部是结构信息、尾部常是结论）；③ **轮次提醒注记不再重发**（「工具调用轮次已达 N」只在产生时随下一请求有效）。长会话的大头原来是旧思考与旧文件内容，长任务中段可省 30–60% 上下文。新增设置项 **「上下文实时瘦身」**（设置 → AI → 对话，默认开，关掉即恢复全量发送）；瞬态注入块去重不受该开关影响（同内容多份是纯冗余，与上下文清理是两回事）。
- 改进 **上下文统计浮层加「实时瘦身已省」行**：瘦身机制此前对用户不可见——现在浮层在系统提示词 / 工具定义 / 对话消息之外，单独展示本次组装剔除的估算 token（旧思考 + 过时大结果 + 过期注入），绿色弱化行、悬浮说明统计口径。没做缓存命中率（依赖各网关 usage 接口不一）与 MCP/技能分项（本仓无此概念），不为对齐而对齐。
- 改进 **上下文统计浮层加「实时瘦身已省」行**：瘦身机制此前对用户不可见——现在浮层在系统提示词 / 工具定义 / 对话消息之外，单独展示本次组装剔除的估算 token（旧思考 + 过时大结果 + 过期注入），绿色弱化行、悬浮说明统计口径。没做缓存命中率（依赖各网关 usage 接口不一）与 MCP/技能分项（本仓无此概念），不为对齐而对齐。
- 修复 **最大化状态下首次打开浏览器标签黑屏几秒**：WebView2 控件创建（`Embed`）到前端首次 `SetBounds` 之间，控件以库默认矩形裸露——页面其实已在加载（状态栏有 URL）但内容区全黑，等布局事件才恢复。现在**创建即隐藏**，前端第一次 `BrowserSetBounds` 自带 Show（w/h>0 → Resize+Show），控件直接以正确矩形出现；黑屏窗口变成标签页背景色的一瞬。
- 修复 **一弹出菜单/浮层，内嵌浏览器里的网页就整块消失**：旧逻辑只要 DOM 里「存在」`.ctx-menu` / `.dialog` 等浮层就隐藏整个 WebView2 原生控件（原生 HWND 盖在主 WebView 之上，不藏就压住浮层），于是右侧 AI 面板的「+」菜单这种**完全没压到网页区域**的浮层也会把整页变成标签页底色。现在按浮层矩形与网页区域**实际相交**才隐藏（补全全屏遮罩、标题栏弹层、消息中心、设置下拉等选择器，未列入表的浮层由命中测试抽检兜底，右下角 toast 不算）；相交时把最近一帧网页截图铺在网页区域上做成「定格」——浮层可见、页面内容也不消失，关闭后立刻恢复实时渲染。定格帧走新增的 `BrowserSnapshot`（只在控件可见时单次短超时抓帧、隐藏态不 Show，不会在浮层上闪一下），正常浏览时约 2s 轻量刷新一张。
  - **层级显隐全量排查补漏**（逐一对账 style.css 全部 z-index ≥30 的浮层）：补入 5 个漏网 fixed 浮层——`.ai-model-picker` / `.ai-model-list-pop`（z260）、`.ai-turn-usage` / `.enc-popover`（z90）、`.ai-dialog.ai-dialog-top`（z300，从设置窗开记忆/技能管理时全屏盖 body）；其中 `.ai-model-picker` 关闭态是 inline `visibility:hidden` 留在 DOM、矩形非零，`browserRectOf` 现在会滤掉 visibility:hidden（否则它开过一次网页就永远被误判遮挡）；菜单条下拉面板 `.dropdown` 是 absolute 往下展开、父级 `.menu` 的矩形盖不住它，改为单独按面板矩形判定。`#jp/diff/js-mask` 与 `#gs-mask` 共享 `.gs-mask` 类天然覆盖；`split-mask` 用 `style.display` 切换已有专门判定。
- 修复 **编辑器里弹出原生白色迷你菜单**：WebView2/Edge 内核对可编辑区域自带的「文本选中迷你菜单」（`Select All / Paste / Find …` 白色横条，选中/点击文本时触发）——浏览器 UI 层的东西，不受应用主题控制、也绕过 JS 的 contextmenu 接管。现在通过 `go-webview2` 的 `AdditionalBrowserArguments` COM/环境双通道注入 `--disable-features=msWebOOUI,msPdfOOUI,…`，全应用所有 WebView2（含内嵌浏览器标签）一并生效。
  - **依赖补丁**：此前用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量的做法**无效**——go-webview2 会在 `init()` 与每次创建环境时把它置空。为此在仓库内放了一份上游 v1.0.22 并加 `replace`，只新增 `webviewloader/app_browser_args.go` + 三处调用点开出注入点（约 2.2 MB 源码，不进 exe / dist）；**升级 go-webview2 时必须重新套用该补丁**。feature 名改用微软 WebView2Feedback#2140 给出的官方 workaround，同时保留旧名以兼容不同 Edge 版本。
- 改进 **新建倒计时 / 正计时 / 任务提醒从面板小浮层改为居中弹窗**（复用 AI 对话框遮罩，Enter 提交 / Esc 关闭一致）：倒计时时长不再手输数字——改为**常用档位直选**（5/10/15/20/30/45 分钟、1 小时）或**自定义到点时刻**（选 HH:MM，已过时刻自动按明天同一时刻算，Go 侧仍按 duration 计时，窗口最小化不漂移）；启动成功提示带上具体到点时刻。输入控件迁移到 form-controls 工厂（表单控件硬规范），AI 面板宽窄形态与浮窗下布局不再受浮层锚点计算影响。
- 改进 **正计时有了完整感知闭环**：此前正计时被停止时只静默清掉胶囊，谁停的、计了多久 AI 全程不知道（「测耗时」用法等于半残）。现在用户手动停止正计时 → 以系统消息把「目的 + 已计时长」投递给启动它的会话并唤醒（与倒计时到点同一投递通道；归属会话已归档自动恢复，会话正忙时静默等待不再打断）；AI 自己用 `stop_timer` 停的轮次时长随工具结果返回、抑制重复投递；弹层 / 详情手动停止的 flash 反馈也带上时长。工具描述同步说明两种感知路径。
- 新增 **计时器时刻标记**：计时器详情里可对运行中的正/倒计时一键打标（可选备注，如「开始报错」），标记攒在 Go 注册表、不打断 AI；停止或到点时以完整时间线（`T+05:12 开始报错；T+20:30 恢复`）随系统消息 / `stop_timer` 工具结果一次性投递——「测耗时」升级成「测过程」，时间线上发生了什么 AI 全知道。单计时器上限 20 条、单条备注 ≤200 字。
- 新增 **正计时到点自动停止**：创建正计时时可选「到点自动停止」时刻（留空 = 一直计到手动停止），Go 侧到点自动收尾并投递通知（带自动停止标记区分文案）——忘停的正计时不再无限挂着。`start_timer` 工具的 `seconds` 对 countup 也有了语义（>0 = 自动停止延迟）。
- 修复 **标题栏运行按钮点一下就出现「选中」底色**：`applyDockView` 误把「底部运行面板是否打开」这个面板状态同步到标题栏 ▶ 上（`active` + `aria-pressed`）——它是纯动作按钮（点击即运行当前文件），不是面板开关，运行面板开着时按钮就一直亮着、再点也不会取消。现在摘掉该同步与对应 CSS，动作按钮不再有选中态；活动栏终端/调试两个真开关的 active 不受影响。
- 修复 **右键/菜单条菜单里一批「运行」相关条目没有图标**：菜单数据里写的 Segoe MDL2 码位（`E768` 运行 / `E71A` 停止 / `E7B3` 运行面板与运行项目 / `E716` 起名器 / `E9D2` 列统计）不在 `LEGACY_ICONS` 迁移映射表里，`resolveIconName` 解析为空、图标槽留白。补齐映射（依次落到 play / close / terminal / sparkles，与运行面板停止按钮的 X 视觉一致），并按 `icon-guidelines` 统一描边规范登记新命名图标 `chart`（列统计用）。
- 改进 **AI 头部宽度不足时 Git / 变更 / 会话搜索一并收起**：紧凑档（`.ai-head-compact`）此前只收 chips 文案与换侧按钮，标题行右侧仍挤着 Git 按钮、「变更 N」胶囊与搜索按钮。现在三个随紧凑档一起隐藏——Git 快捷操作是头部按钮的唯一入口，在「更多」菜单里补回（仅 Git 可用时，浮窗最小宽 360 也会触发同档）；变更看消息流轮尾汇总卡（带审阅按钮），会话搜索按提示走全局搜索切换范围。
- 改进 **AI 输入框「+」菜单补齐图标**：「更多」菜单每条都有图标而「+」菜单全裸——条目数据漏写 `icon` 字段（渲染器的图标槽是常驻的，不填就空着）。按语义补齐（当前文件 doc / 选中内容 select-all / 附加文件 file / 技能 sparkles / 计时器 clock / 任务提醒 bell / 投递到会话 forward / 新建支线对话 bookmark（与「更多」菜单同键）/ 指令 terminal），子菜单沿用全仓约定不带图标。

### 编辑器

- 改进 **全局搜索结果「源码优先、产物靠后」，档内文件名命中优先**：此前所有命中按完整路径字符串升序（`frontend/dist/assets/…` 会排在 `frontend/src/…` 之前），且构建产物命中先吃满 400 条上限时会把源码命中直接挤掉。现在 `dist` / `build` / `out` / `target` / `bin` / `obj` / `vendor` / `coverage` / `bower_components` / `.next` 等目录段与 `*.min.js` / `*.min.css` / `*.map` 归为**产物档**，只降权不排除——工作区本身可能就是一份构建站，产物仍搜得到，只是垫底；分两阶段扫描（rg 两趟 / 内置扫描两组队列）共享同一个 3.5s 截止时间：源码档先占预算，没占满 400 条才补产物档，产物永远不会挤掉源码；两档内部再按「文件名命中 > 仅内容命中 → 路径 → 行 → 列」排序。AI 的 `search_text` 同走这条路径，跟着受益，且源码档吃满窗口、产物档未检索时会多返回一行「源码命中已占满窗口，产物档未检索」。路径分类每个文件只算一次（O(路径长度)），排序只作用于 ≤400 条命中；rg 侧命中截断后立即结束进程，不再等管道写满拖到截止时间。
- 新增 **代码截图**：代码/分屏视图右键 →「代码截图」，可复制为图片或导出 PNG。当前展示效果画成 PNG（Canvas 2D，零新增依赖；token 颜色用探针 DOM 读当前主题 + 代码风格的真实取色，所见即所得；不走窗口截图 API，Ace 虚拟滚动视口外的内容也能截全）。有选区取涉及的全部整行，无选区取全文，单次上限 600 行。成品图**只有代码卡片本身**——没有外圈页面背景，圆角外四角透明；标题（文件名 · 行号范围）**默认不画**，子菜单勾选「带标题」即加。样式扩展在 设置 → 通用设置 → 代码截图：带标题 / 显示行号 / 圆角（直角·小·中·大）/ 输出倍率（1×·2×·3×），档位单一来源 `code-shot.js` 的 `shotStyleOptions`。
- 修复 **代码折叠把整块内容压成一行内联显示**（Go 的 `import ( )` 块折叠后渲染成 `import ("strings" "testing" "time")`，`if` 块折叠后行尾挂着一截 `t.Fatalf(...)`）。根因是占位符改写把折叠块内容压平塞进占位符（≤120 显示列 + ` …`）。现在占位符回归 Ace 默认的 `...`：花括号块折叠后行尾渲染成 `{...}`（`{` 留在行尾、`}` 紧随占位符，与 VS Code 一致）；`import ( )` 块包装 `session.addFold` 把圆括号本体折进折叠范围，显示成 `import ...`（纯函数 `adjustCodeFoldRange` 可单测）。块内容预览改由折叠行悬停面板承担（带原始行号与语法高亮，行为不变）；会话恢复时还原的折叠占位符从空串改为 `...`，不再「看不出哪里折了」。`hookCodeFoldPreviews` / `updateCodeFoldPreviews` 更名为 `hookCodeFoldRanges`（占位符改写机制整体移除）。

- 收敛 **AI 引用菜单：同一个文件只保留一个入口**：标签页 / 资源管理器右键里「引用该文件」与「在 AI 中询问此文件」此前并排出现、图标相同，行为却不同（前者只挂路径让模型自读，后者当场读 ≤64 KiB 全文进附件），几乎没法从菜单看出来。现在统一为单个「引用该文件」：AI 面板没开就自动打开，只挂 `<file_reference>` 路径引用并聚焦输入框（不读内容，大文件 / 二进制也能引用，读多少由模型决定）；编辑器内容右键的「引用选取 / 引用该文件」同样改为面板未开时自动打开。顺带修复资源管理器文件右键菜单 `explorer-ops.js` 里 `aiReferenceFileMenuItems` 的裸引用（ReferenceError，树中右键文件菜单此前打不开）。

- 改进 **AI 基础文件工具的能力与效率**（声明表同步更新，参数更省猜测）：
  - `read_file`：新增 `limit`（单次最多返回的字符数，与现有 `offset` 组成完整字符分页）与 `startLine`/`endLine`（1-based 含头含尾按行读取，输出带行号前缀方便模型精确引用——行号仅供参考，`edit_file` 的 oldString 不要带）；行号模式截断时提示「继续读请 startLine=N」，字符模式截断提示续读 offset，不再盲翻页。两组参数互斥，混用直接报错。切片与行号窗口逻辑抽到新纯函数模块 `ai/ai-file-tools.js`（`ai-file-tools.test.mjs` 11 项单测，已登记 `npm test`）。
  - `edit_file`：新增 `replaceAll`——多处命中默认仍报错并提示命中数，传 `replaceAll=true` 全量替换（返回「已替换 N 处」）；CRLF 文件的 LF 兜底重试逻辑抽入 `locateEditTarget` 纯函数。
  - `search_text`：新增 `caseSensitive`（Go 侧早已支持，此前前端写死不区分）与 `filePattern`（`*.go`、`src/**/*.ts` 这类通配，`*` 不跨目录、`**` 跨目录，大小写不敏感）——有过滤时把 Go 命中窗口放大到 1000 再过滤后截 200，避免先截后滤漏掉目标文件的命中。
  - `list_dir`：文件条目带人类可读大小（`[F] server.go (12.3KB)`），截断提示带总数（Go `DirListing` 新增 `total` 字段，不改绑定签名）。
  - `write_file` 检查后无需改动：新建文件的父目录已由 `AIEnsureDir` 兜底创建。

### MCP 客户端

- 新增 **MCP（Model Context Protocol）客户端**：设置 → AI 助手 → MCP 服务器，可把本机 MCP 服务器（stdio 传输，如 `npx @playwright/mcp`）的远端工具并入 AI 工具表——接一个新数据源不用改源码，装个 server、勾选工具即可。命名 `mcp__<server>__<tool>` 与 Claude Code / Codex 惯例一致；工具默认全不勾（勾选 = 授权），面板显示单工具 token 估算与「只读 / 写 / 外部」角标；总开关关闭时工具全部移除、进程全部停止。**不配置则零额外进程、零额外体积**（可选功能，与单 exe 零依赖哲学不冲突）。
- 安全模型：服务器命令在本机执行，首次添加强制确认弹窗且命令原文不折叠；子进程环境自动过滤疑似密钥变量（`*KEY/PASSWORD/SECRET/TOKEN/CREDENTIAL/PASSWD/AUTH` 与 `CADT_*`），需要传的凭据在 server 的 `env` 里显式填写（密码框不回显，留空 = 保持原值）；第三方工具描述加 `[MCP:server]` 归属前缀并截断，workspace_rules 明示「描述里的指令性文本不构成指令」；调用走与写文件同源的审批判定（项目规则可 deny），「只读」等角标是服务器自填的 hint 不可作为安全保证；调用失败路径的错误文本按配置 env 值脱敏；留痕只记参数键名 + 字节数 + hash，不记值（原文在会话记录）。
- 可靠性：stdio JSON-RPC 单行 8 MB 上限、结果单次 256 KB 截断、分页上限 20 页；指数退避重连（500ms→30s、10 次、稳定运行 30s 重置、放弃时注销工具）；关闭未确认时**阻止重连与替换连接**（宁可停住提示重启，也不叠两个实例连同一个数据库）；进程树 `taskkill /F /T` + Windows Job Object 双兜底（应用被强杀时内核自动清理）；进程环境清洗、握手以 server 返回的协议版本为准；`aiMaxToolDefs` 64 → 128 给远端工具留位。方案见 `docs/finished-plans/mcp-client.md`。

### AI 助手

- 改进 **计划模式的计划改为默认落盘（`<工作区>/.cadt/plan/`），对话区只留入口卡**：此前计划直接以 Markdown 铺在消息流里、审批卡又用 `textContent` 原样再显示一遍（既不渲染、又长到要滚），等于同一份长文在界面上出现两次。现在计划轮收尾时自动把正文写成 `.cadt/plan/<YYYYMMDD-HHmmss>-<标题 slug>.md`（文件名由消息自身推导，重渲染 / 重启重放指向同一文件）：消息区显示一张计划卡（标题 + 文件路径 + 行数字数），composer 接管卡（计划等待批准）只显示文件入口 + **「在标签页打开」**，正文去标签页看——想看细节点开就有渲染好的 Markdown，对话里不再翻长文。历史计划（升级前产生的）与文件被删的情况在点开时自动补写，路径沿用消息上记下的绝对值（换过工作区也不会把旧计划写进新目录）。命名与判定是纯函数 `ai/ai-plan-file.js`（`ai-plan-file.test.mjs` 7 项单测，已登记 `npm test`）；计划正文仍随会话保存并照常发给模型，只是不再重复渲染。**批准后那条「计划已批准，请立即…执行」不再显示成用户胶囊**——它是应用代按「执行计划」发出的指令，改走「应用消息」卡片（`app.kind = 'plan'`，图标 compass，页脚写明「由应用自动注入 · 计划已批准」，指令原文仍可在「查看指令」里核对）；升级前的历史会话按同一文案前缀 `detectAppMessage` 认回来。
- 修复 **切走再切回对话后，回复里的文件引用退化成不可点的普通代码**：同一条回复里的 `frontend/src/core/wordcloud-render.js:215`，第一次进对话是带点状下线的可点链接，切到别的会话再切回来就变回一块灰底 code span。根因是渲染时序与 stat 缓存的组合——整屏重放时 `renderMessage` 先建**游离的 wrap**、渲染完才 append，而 `GetPathInfo` 的存在性结果按绝对路径缓存在 `aiRefStatCache`：第一次进对话缓存未命中、走异步 stat，回调执行时节点早已挂上，链接正常；切走再切回命中缓存走**同步**升级，此刻节点还没 append，`markFileRefChip` 的 `if (!code.isConnected) return` 直接放弃，并且 `aiRefState` 停在 `pending` 让该节点永不再试——一屏引用就此全部变成普通代码（同一现象也解释了生图产物路径点不动）。现在把「上 chip」抽成 `ai-file-refs.applyFileRefChip`，**刻意不检查 isConnected**（游离节点挂上后 class 自然生效，节点被整块重建丢弃也无害），并补两条回归测试钉住「未挂载也升级 / tooltip 带行列」。
- 新增 **AI 能直读图片（`read_image`）**：此前模型看不了本机图片——`read_file` 对图片直接报「二进制文件不可作为文本读取」，想看图只能 `app_control screenshot` 截应用窗口或 `browser_screenshot` 截图绕一圈，截到的还是渲染后的界面而不是原图。现在所有权限档（含计划模式）都下发 `read_image`：读 png / jpg / webp / gif / bmp / svg 并把画面挂成一条独立消息，模型直接看到画面（子代理同享）。路径授权与 `read_file` 同源——工作区外点名直读、auto/full 直读、read/edit 弹同一张审批卡、应用数据目录硬拒、子代理不弹卡只报回；长边 >1600 或 base64 >3MB 自动等比降采样（PNG 压不下转 JPEG 逐级降质），压不下去明确报错而不是静默丢图；模型条目明确关了「图像输入」时直接给文案，不产生半条图片消息。图片编码抽成 `frontend/src/ai/ai-image-encode.js`，与输入框粘贴附图共用同一份实现（阈值与降质策略逐字保留，两处不会再走偏）。系统提示词在「当前活动文件」是图片时追加一句「要看画面用 read_image」，免得模型继续打截窗口的主意。顺带修掉一个真实隐患：`read_image` 与 `generate_image review` 的图片消息原先在工具执行中直接 push，一轮里并发多个工具时会插在 `assistant(tool_calls)` 与工具结果之间（OpenAI 以「must be followed by tool messages」拒收整轮请求），现在统一排到工具批次结束再落盘（`pendingToolImages` + `flushToolImages`，主循环与子代理循环同一口径）。方案与手工回归清单见 `docs/finished-plans/read-image.md`，单测 `ai-image-encode.test.mjs`。
- 修复 **刚打开软件时 AI 面板先跳到「第 1 个对话」、几秒后才刷成上次看的会话**，同时把会话加载改成 dsh 那套「列表只读 meta、正文按需读」：面板初始化时磁盘会话还没读完，`sessions` 只是占位（老的 localStorage 快照，或一个全新的空会话），`init()` 却按它渲染了一屏并据此决定「当前会话」——真正的上次会话要等读盘结束才出现，于是先闪一屏错的再跳走。现在分三层：① **列表**只读 `meta.json`（一次 IPC 拿全部标题/时间/条数/未读/置顶/待办/摘要），会话对象以**占位态 `_stub`** 入列（`sessionStore.toStubs`）；② **正文**只补「当前会话 + 最近 12 条」（`hydrateStartupSessions`，6 路并发），其余**等用户点开 / 发消息 / 桥切会话时**才走 `ensureSessionLoaded` 读整份 JSONL 重放（`sessionStore.hydrateSession`，就地填充，引用不变）；③ 读盘未完成的那一瞬只画加载态，并且不替用户重写 `activeSessionId`。占位态的三条护栏是这次的核心：`sessionMessageCount()` 是条数的唯一取值（占位读 meta 缓存的 `_msgCount`），**否则会把 0 条写进 meta.json、下次启动整个列表全变「0 条消息」**；占位写盘**只允许写 meta**（`persistSession` 分支，标题/未读/置顶/待办照常保存），`archiveSession` / `resetSession` / `rewriteSession` 三个「整份重写日志」入口直接拒绝占位（`requireBody`，等价 dsh「根本没有 save 整个会话的 API」）；`isVirginSession` 不把占位当「没动过的空会话」，免得被启动去重剔掉或当可复用空会话。顺带：打开面板时的全量重读改成**先读 meta 对账**（`metasDiffer`，比对标题/更新时间/条数/未读/置顶/归档/增删），没变化就一次正文都不读——否则「懒加载」在每次打开面板时又被 `loadAll()` 抵消；导出 Markdown / 会话诊断 / `/clear` / 分支跳转都对未载入会话做了前置处理；子代理详情头部的状态兜底原先会扫**全部**会话的正文找 `spawn_agent` 记录，现在优先扫「打开详情时所在的会话」、跳过占位会话，只有在所属会话仍是占位时补它**一个**（`view.sessionId` 随详情 spec / 标签页 `agentViewSpec` 一起带下去）。本机 45 个会话、最大 3MB 一份：启动空白期从约 2~3 秒降到「一次 meta IPC + 12 份正文」。
- 改进 **AI 回复里的图片不再按面板宽铺满**：正文 Markdown 图片原先只有 `max-width: 100%`、没有高度上限，一张 16:9 生图在宽面板里能撑到吃掉整屏（浏览器截图卡反倒一直限在 240px）。现在限高 480px，**点击图片进全屏查看层**（原图 + 滚轮缩放 / 拖动平移 / 双击原始大小），本地图片在查看层里右键仍可复制 / 另存为，默认文件名取原图名；子代理详情标签页里的图片走同一套查看层（铺满所在标签页，不遮挡窗口其他区域）。查看层按宿主容器复用实例（`WeakMap`，避免 window 级 Esc/resize 监听重复挂载），data URL 反解成图片对象是纯函数 `aiImageFromSrc`（配 `ai-constants.test.mjs`）。
- 修复 **新会话的模型总被切回列表第一个**：新会话此前只继承「窗口默认」（`config.active*`），而那只是最后一次**显式切换**的结果——切到一个 pin 着别的模型的旧会话、或点开设置页里另一个账号的模型编辑器（`openModelEditor` 会顺手把窗口默认改成被编辑的账号），窗口默认就与实际在用的模型脱节，新建会话于是退回第一个账号的第一个模型（实测：正在用 SenseNova 的 flash-lite，点新建拿到的是 Deepseek 的首条目，并被 pin 死在该会话上）。现在新会话继承**当前会话实际生效的账号 + 条目**（`inheritModelRef`，问不到才回落窗口默认），切换会话时把窗口默认同步成该会话的模型（`syncActiveFromSession`；插件虚拟账号只在内存，不写进窗口默认，免留悬空 id），复用空会话也按当前模型重新 pin；接线护栏在 `ai-config-model.test.mjs`。
- 改进 **内置技能的卡片不再展示全文**：`skill_use` 加载内置技能（cadt-ui / cadt-gen-models 等）的卡片此前可展开出整篇技能文档——那是给模型的指令，对用户是纯噪音且把消息流顶得老长。现在内置技能卡只保留卡片头（名称 + 完成状态），无展开箭头、无正文，悬浮提示「内容已注入模型上下文」；工作区 / 用户技能不受影响，照常可展开阅读。识别按结果首行的来源标注（「（内置）」，单一来源 `skillSourceLabel`），历史会话里的旧卡片同样生效。
- 新增 **AI 可代配生成条目（app_control 新动作 get_gen_models / set_gen_model / delete_gen_model + 内置技能 cadt-gen-models）**：用户说「帮我接 XX 生图服务」，AI 按服务商文档代填生图/视频条目的全部配置（baseURL / 端点 / 请求体模板 / 产物提取路径 / 默认参数，部分更新语义——改一处不必重发全量），**唯独 API Key 不可写**：新建留空、更新保留已填的（`mergeGenModelEntry` 纯函数保证，AI 塞密钥会被丢弃）、已填密钥的条目不可由 AI 删除；保存后状态栏 flash 提醒并在回复里引导用户去 设置 → AI → 生图与视频 → 编辑 填 Key、逐字核对 baseURL。新技能含条目字段表、OpenAI 兼容模板示例、占位符 JSON 字面量约定与红线（不编造域名、n=1 接口硬编码）。配置写入走 saveAIConfig 并同步刷新设置页列表，列表/返回值一律不含密钥。
- 修复 **流式生成时轻微上翻被拽回底部（滚动条突然置底）**：贴底跟随用「距底 ≤80px」判定——用户只往上翻一点（想重读刚出的回复开头）时贴底状态不解除，而思考流 / 工具卡在下方增长**不产生 scroll 事件**（scrollTop 没变），下一个 80ms 渲染帧就被 `scrollToBottom` 整个拽回底部；上翻越少、后续内容越长，跳得越狠。现在**任何向上滚动一律解除贴底**（向下滚回底部才恢复跟随）。同批把两处「无条件拉底」改为不抢滚动位置：排队消息在轮末冲刷发送、后台通知唤醒新轮（子代理汇报 / 信箱投递 / 定时任务 / 计时器）——用户贴底时照常跟随，上翻阅读时保持原位，靠「回到底部」按钮提示新内容。
- 改进 **AI 回答里的代码块改为「卡头式」**：此前只有一块灰底 `pre` + 右上角浮着的「复制」文字钮，围栏语言完全丢掉、按钮还压在代码上。现在与可视化卡片同构——顶部信息条左边写围栏语言（无围栏回退「文本」，带复制钮的 `data-tip` 气泡），右边是图标复制按钮（复制成功短暂换成勾号），下方代码区白底、自己横向滚动，长行不再撑破消息宽度；开「Markdown 行号」时行号槽与代码仍是两列（边框与底色交给卡片，禁选行号不变）。编辑器里的 Markdown 预览不受影响。
- 修复 **子代理详情里「每来一条消息视图就跳回顶部」**：正文此前有两条互不相通的块模型——运行态用会话消息（`m<i>`），收尾瞬间改成「最终结论 + 过程转录」（`t<i>`）。子代理被 `agent_send` / 用户插话唤醒是它最常见的交互形态，一次收尾 + 一次唤醒就整段换模型：节点全删重建、图表卡片销毁、滚动位置被浏览器钳到新上限（内容一屏放得下时直接钳成 0），看起来就是滚动条自己往顶部跑。现在只要会话还在内存（含可冷唤醒的 done），运行态与终态一律沿用同一套消息块，摘要在不是最后一条正文时补一张「最终结论」卡；只有上下文已回收 / 应用重启后才退回「摘要 + 转录」。顺带把滚动位置当状态维护：渲染前记下位置，跟随底部时吸附到底、上翻读时原样还原（内容缩水被钳也能补回）；详情页第一次落地一律跟到最新一条，不再因为「长派单提示词一屏放不下 + scrollTop 还是 0」被误判成用户在上翻而永久卡在顶部；后台标签页（布局盒为 0）不再写 scrollTop，切回来不会在顶部；输入行改为先于正文同步挂载，首帧吸附按扣掉输入行的高度算，落到底不再差 36~40px。
- 改进 **模型选择弹层现代化 + 思考等级按模型行内配置**：模型列表每行显示该模型自己的思考等级徽标（分色：自动/关=灰、低=蓝、中=黄、高=紫红，取 `--ai-lv-*` 主题变量），点徽标在行下展开档位条（自动/低/中/高，Anthropic 为关/低/中/高）直接改**该模型**——弹层不关闭，可连续为多个模型分别配置（此前底部按钮组只对当前选中模型生效，且点其它模型行会直接切换并关闭弹层）；底部全局「推理等级」行随之移除（入口即每行徽标）。弹层视觉同步翻新：大圆角 + 双层阴影 + 淡入动效、搜索框带放大镜图标、选中行淡底色 + SVG 对勾、上下文上限行改连体分段控件。等级推导收拢为 `ai-config-model.js` 的 `reasoningLevelInfo` 纯函数（档位表 / 中文标签 / 徽标分色单一来源，配表驱动测试）。
- 修复 **设置页里打开的嵌套弹窗层级与宽度**：「新建/编辑生成条目」「新建/编辑定时任务」从设置窗打开时用的是普通 AI 弹层（z40），整层被设置窗压在下面露出半截——现在与记忆/技能管理一致走 `ai-dialog-top`（z300 全屏置顶）。生成条目编辑器内容密集（URL/模板/轮询等十余行），弹窗新增 `options.wide` 加宽到 800px（默认仍 560px）。

- 改进 **任务清单默认收起，只占一行进度摘要**：AI 面板顶部的任务清单此前只要有任务就整块展开，长清单把对话挤下去。现在默认收起——标题行 + 「N 已完成 · N 进行中 · N 待处理」摘要（收起态仍用小字显示当前进行中的任务，右侧眼睛按钮可关），点标题行展开；想恢复常驻展开可在 **设置 → AI 助手 → 对话 →「任务清单默认展开」** 打开，切换后已打开会话的收起态立即跟随。全部完成 3 秒自动收起的行为不变；手动展开的会话在后续 `todo_write` 更新进度时不会被强行折回。

- 改进 **429 限流的重试策略，分钟窗配额不再轻易撞墙**：此前退避 1s→2s→4s…封顶 30s、按用户设置的次数用完即失败——「tpm exhausted」这类分钟窗配额重置需要时间，30 秒预算常在耗尽的窗口里连环撞壁。现在 429 专用退避曲线 2s→4s→8s→16s→32s→60s 封顶，并在用户设置的次数之外加 3 次限流额外预算（默认 5 次 → 实际 8 次，总恢复窗口约 4 分钟；`retryMax=0` 显式关闭时不强加）；`Retry-After` 新增 HTTP-date 解析且原样尊重服务器（不再被 30s 钳制）；重试长等待期间每 30s 喂一次看门狗，超过空闲超时的长等待不再被误判为无响应。5xx / 网络错误的曲线与次数不变。

- 改进 **全仓 tooltip 从原生 title 换成主题化气泡**（新增 `core/tooltip.js` 全局运行时）：`data-tip` 属性驱动、单例气泡委托监听——鼠标悬停 250ms 显示、键盘聚焦立即显示，滚动 / 点击 / Esc 隐藏，位置下方优先、越界翻转到上方并做视口钳制，`\n` 按 pre-line 换行；文本经 `textContent` 写入不执行 HTML，显示时挂 `aria-describedby`、纯图标元素以气泡文本兜底 `aria-label`。设置页 `.info-tip` ⓘ 说明圆点同步并入同一运行时——自带的 `::after` 气泡与点击委托删除，长说明获得视口翻转（靠底的 ⓘ 不再溢出屏幕），触屏上点击 ⓘ 切换气泡。全仓约 240 处 `.title =` 赋值与 137 处 `title="` 模板属性（含 index.html）机械替换为 `data-tip`，保留例外：`document.title`（窗口标题）、`session.title` 等数据对象、`<iframe>` 的 title（无障碍名）、设置页 `.info-tip`（自带气泡不重复）。`write_file` 等表单控件的 `title` 选项经 `form-controls.js` 统一转为 data-tip。

- 改进 **AI 回复里的文件引用从胶囊改为内联链接**：`path:行` 引用此前渲染成蓝底描边带图标的胶囊，改动清单这类一屏几十个路径的消息满屏色块。现在无底色无图标——路径文字用主题色加点状下线，hover 才出现淡底与实线下线；点击跳行、悬浮显示绝对路径与行列的能力不变。

- 新增 **生图与视频生成（generate_image / generate_video / check_gen 工具 + 独立设置页）**：设置 → AI → 「生图与视频」可配置任意生图/视频服务商条目——**通用输入输出模板**吸收各家接口差异（请求体模板用 `{{prompt}} / {{model}} / {{size}} / {{n}} / {{apiKey}}` 占位符，一律渲染为 JSON 字面量、prompt 内容无法破坏 JSON；响应提取路径 `data[*].b64_json` 手写点路径、不引 JSONPath 库），内置 OpenAI 兼容 b64/URL 两式与自定义预设；支持同步型（单次 POST 等结果）与异步型（提交→轮询→取产物，DashScope 类任务型接口与视频服务共用同一引擎），本地服务（ComfyUI 等）可直填 `http://127.0.0.1:*`。AI 侧三个新工具走**写工具档审批**（read/edit 弹卡展示条目与参数、auto/full 直发，项目规则 `Write(generate_image)` 可覆写）；产物落盘工作区 `.cadt/gen/{image|video}/` 按月归档（`outputPath` 可指定工作区内目录，越界拒绝），生成卡内嵌缩略图、点击在标签页打开，异步任务完成/失败经信箱唤醒会话、卡上可停止；`review: true` 可把首张图回传给多模态聊天模型（browser_screenshot 同款注入链）。密钥与账号同源信任（仅存本机 ai-config.json、仅进请求头、不落日志）；响应体 64MB / 单图 25MB / 视频 220MB 上限；配置随导入导出（密钥同一脱敏开关）。未配置条目时工具不下发，零额外进程与体积。方案见 `docs/finished-plans/ai-gen-models.md`。
- 改进 **生图与视频条目分成两组、可调优先级**：条目列表此前按配置顺序混排，看不出 AI 到底会挑哪一条。现在按类型分成「生图 / 视频」两组（各带条数与「组内顺序即优先级」的说明），每条挂 `#n` 优先级徽标（缺省那条高亮为 `#1 缺省`），卡上新增上移 / 下移按钮调整组内顺序——`generate_image` / `generate_video` 未指定 `model` 时按组内顺序取第一个启用的条目，顺序即口径；复制条目改为插在原件之后（副本优先级顺位下一位）。上移 / 下移只在同类型的槽位间交换（`moveGenModelWithinKind` 纯函数 + 测试），不会打乱另一组的顺序。
- 改进 **生图条目编辑器排版**：自定义请求头、请求体模板两处多行输入原先挤在标题右侧的 210px 定宽列里，逐行内容基本读不出来——现在独占一整行（沿用设置页「标题一行 + 控件整行」的 `.set-row-top` 结构），说明文字里的换行也按行显示；弹窗里的三个下拉（类型 / 代理 / 产物形态）接入设置页同款行式下拉增强，不再弹出 WebView2 原生样式。
- 新增 **本次会话上下文上限（模型选择器档位）**：模型胶囊下拉在「推理等级」下新增「上下文上限」行，按档位（256K / 512K / 1M，只列**小于模型窗口**的档；模型窗口不大于最小档时整行不显示）把当前会话的有效窗口压到模型上限以下，默认不设限。生效窗口是占用口径的唯一基数——用量环与百分比、auto-compact 触发、发送前超限预检、`/context` 报告随之全部收窄（压缩阈值不变，基数变小即更早触发）；调低上限时若占用已过阈值立即尝试压缩，不必等下一轮。上限只写当前会话（模型条目配置不动），随会话持久化（重启恢复仍在），fork 会话与派生子代理继承；模型胶囊挂档位徽标（如 `256K`），上下文浮层在分母被收窄时标注「会话上限」。
- 改进 **子代理详情改为在内容区标签页打开**：点开头部「智能体团队」里的一行，此前是绝对定位覆盖整个 AI 面板（连输入框一起盖住，想边看子代理边给主代理发消息就得先返回）。现在对齐后台终端标签页的做法，在内容区以标签页打开（标签图标同「智能体团队」，标题取子代理名，同一子代理重复点开复用同一个标签，最多留 8 个）；关标签只是卸载视图，子代理照常跑，悬浮窗里仍是原来的面板内覆盖层（那里没有内容区）。
- 修复 **子代理详情里 Markdown 只渲染到一半**：正文走了 Markdown，但缺了主消息区的增强链——```mermaid / echarts / svg / html``` 围栏只显示一块源码占位、代码块没有复制钮、本地图片不解析。现在与主消息区共用同一条链（`enhanceAnswerBody`：代码块复制钮 → 本地图片 → 可视化卡片），流式期间卡片先占位、块落定后挂载。工具行也补了主参数（`read_file · src/main.js`），不再只有工具名 + 输出。
- 修复 **子代理详情每 300ms 整段重建**：运行中的视图每次刷新都清空重排正文，长转录会闪、滚动位置被拉回底部，可视化卡片建了又毁。现在按「块 + 内容签名」增量渲染：只重写内容变化的块，块 key 稳定（消息下标 / 转录下标），顺序不变时零 DOM 搬动。
- 新增 **AI 空态看板娘**：新对话空态文字放大居中（标题 15px / 正文 13px），甜澄（默认「中秋」装，512px WebP 仅 20KB，内置于 `brand/mascot-empty.webp`）站在标题上方。点击换装并入样例插件 **「甜澄的漫游时光」v1.3.0**（`plugins/scene-carousel`，18 款服装与表情，欢迎页轮播之外新增 `images/mascot/` 图源）：点击形象循环切换、记住选中款，空态重建由 MutationObserver 重新装饰，停用 / 禁用插件自动恢复内置形象。
- 修复 **轮尾「已编辑 N 个文件」的【审阅】打不开**：审阅虚拟文档把每份 Git 差异整串 `trim()` 后再拼接——hunk 恰好以**空上下文行**（git 输出里是单个空格的行，markdown 等文档极常见）结尾时，这一行连同换行被整行吃掉，hunk 实际行数便与 `@@` 头对不上，`PatchParseText` 直接报「无法解析该差异（PATCH_PARSE: 头部声明 -141,7 +141,7，实际数出 -6 +6）」——刚改完的文件反而审不了。现在 `normalizeGitDiffBlock` 只裁首尾换行、空上下文行原样保留（解析端对传输吃尾空格的空行本就有兜底，整行丢失才无解，所以修在生成端）；抽成纯函数配 4 项单测。
- 修复 **AI 面板拖宽失效**：拖边缘手柄拉不动宽度——「拖宽上限改视口 60%」那次改写 `moveResize` 时误删了 `const delta = e.clientX - drag.startX`，每次 pointermove 抛 `ReferenceError`、宽度永不更新。补回一行。
- 修复 **会话面板「自动化」弹层打不开**：点击报 `dialogButton is not defined`——定时任务域从 ai-panel 拆出时，弹层的按钮工厂漏了从 ctx 解包，点击即抛未捕获异常、弹层永远出不来。补一行解包。
- 改进 **子代理权限边界的声明与拒绝语义**（对齐 dsh 的「策略钉死派生边界」）：子代理系统提示新增声明——工具范围派出时已固定、无法从会话内放宽；范围外工具从「工具执行失败：子代理不允许工具：xxx」改为**独立的确定性拒绝分支**（仿参数非法分支），模型侧文案明确「不要重试、在最终结论中说明限制、由主代理处理」，拒绝首次落操作留痕（`ai.tool`，status: denied，不含工具输入）。
- 改进 **默认提示词的涉密值引导**：工具守则新增一条——涉密值（API key、令牌、密码等）优先建议用户经 `env_create` 登记为环境变量（值只经 0600 配置落盘，不进对话、不进模型上下文），不引导用户把这类值发进对话或写进文件；措辞是「优先建议」而非禁止，`.env` 等确需明文的场景照旧。
- 新增 **工作区外读取：点名直读 + 按档审批 + 目录记忆**：`read_file` / `list_dir` 不再把工作区根当死墙——用户在对话里**明确给过路径**的（逐字出现在真用户消息里；应用消息卡片、子代理收件箱注入与模型派单 task 都不算点名，注入伪造不了用户消息）直接读，不再为已表达的意图弹审批卡。没点名的越界读取按权限档分流：**auto / full 直接读**（auto 契约即非风险自主执行，且命令通道本就绕行，闸 read_file 只会逼模型走更绕的路），**read / edit 弹审批卡**（显示完整真实路径，批准时可选记住目录：本会话 / 总是 / 本项目——批准过父目录后同目录免询问；子代理**永不弹卡**，接管卡按当前会话匹配、子会话上永远不可达，改为报错指引它经 `agent_send` 报回主代理发起授权，父会话已批准的读根实时回查继承）。**应用数据目录（含 `ai-config.json` 密钥与会话数据）任何档位、点名也不放行**——密钥一旦被读就随会话 JSONL 落盘，与操作记录不存密钥同一哲学。项目规则新增 `Read(D:/xxx/**)` 目录树授权（设置 → AI → 权限规则可编辑）；授权判定抽成纯函数 `ai-read-roots.js`（点名提取复用 `ai-scope-redact.js` 的路径 token 语义）。`aiResolveScopePath` 的越界错误带结构化标记供读工具捕获，写工具（write_file / edit_file）越界行为与文案不变；AI 消息里的本地图片对已批准读根放行展示。
- 安全：**非完全权限档不再把真实绝对路径回给模型**：工具报错此前原样透传后端文案（`GetFileAttributesEx D:/…/x.md: The system cannot find the path specified.`），只读档下盘符、用户名与整段目录结构都跟着进了模型上下文（`read_file` / `list_dir` 回显绝对路径参数时同理）。新增 `ai-scope-redact.js`：非完全权限档把工作区根收敛成 `<工作区>` 记号、残余的盘符绝对路径只留文件名（`（范围外）x.md`），套在工具错误文案与 `read_file` / `list_dir` 的路径回显上；完全权限档（full）不设边界、原样返回。边界口径与 `aiResolveScopePath` 一致；读到的文件正文与命令输出不做改写（那是用户要看的内容）。
- 修复 **别的会话在跑时定时任务唤醒失败**：调查结论不是并发冲突，而是注入入口**绑死了「当前会话」**——定时任务必须 `open(true)` 强开面板、`switchSession` 切走用户正在看的会话，才能把指令投进去；而 `switchSession` 里调 `timerMod.render()`，`ai-timer.js` 当时代码只导出了 `renderPop`，于是整轮注入被 `oo.render is not a function` 打断（日志里 5 次 cron 全部失败）。现在定时任务与计时器**改走会话信箱**（`startSessionTurn` 内核 + notices 的三态投递）：不切视图、不强开面板、不再 30 秒忙等——目标空闲就静默起一轮并打未读标记，忙则排到它下一轮边界（本轮结束后消费）。跨工作区目标仍保持失败分支（系统上下文按本窗口工作区解析，不为静默化顺手改权限语义），归档目标仍「自动取消归档再唤醒」（用户自己设的定时器，与「外部投递拒收归档会话」是两套语义，判据写在同一处）。
- 新增 **后台轮次的可见与可干预**：静默的另一半是「用户仍看得见」。① **审批可见**——接管卡只渲染「当前查看会话」的审批，而写操作/命令审批**没有超时**，后台轮次一旦要写文件就会挂在一个用户看不见的输入区里永不结束（本轮最可能的悬挂源）。现在后台触发审批时打未读 + 桌面通知（消息中心带 sessionId，点击即跳），1 分钟后只**再提醒一次**、**绝不自动放行**（后台无人看也不能替用户拍板授权）。② **停止入口**——会话列表项在运行中 / 待确认态显示行尾「停止」（hover 才显形，防误触），`streams` 按会话隔离，停谁都不用切过去，`flash` 提示即可、不弹确认。③ **投递失败不静默**——唤醒被拒（无模型配置 / 预算超阈）时内容退回信箱最前、打未读、给错误提示，绝不丢弃。
- 改进 **会话投递的交互**（同一批能力的界面升级）：初版是「消息操作条 → 单选菜单选一个会话」，通知则要「先在输入框写好内容再点菜单项」——两处都把交互成本推给了用户。现在换成**选择器对话框**：`投递到会话` 带搜索框（自动聚焦）、多选列表（标题 + 工作区 + 状态胶囊：运行中脉动点 / 压缩中橙 / 空闲灰）、`全选 / 清空`、实时「已选 N/10」、投递内容的引用式预览，键盘全套可用（↑↓ 移动、Enter 勾选、Ctrl+Enter 投递、Esc 关闭），到上限后未选行变暗但点击会说明原因；`通知运行中的会话` 改为「目标 chips + 内容输入框 + 尾注说明」，直接预填输入框草稿、Ctrl+Enter 发送，发送后清空草稿避免重复手发。按钮走对话框 footer，列表再长也不会被滚出视口；勾选框与状态徽章全部自绘（不引入原生控件）。
- 新增 **会话间投递（共享信箱）**：把「子代理结算通知」那条注入管道正式化为**每会话一个信箱**——发送方扩为四个（子代理结算 / 提问、支线结论带回、会话间投递、定时任务），注入渲染、三个消费点、未读标记全部复用，没有第二套队列。`session_list` 查可投递会话（默认**只列同工作区**，防标题串味；最近活动倒序、上限 50），`session_send` 单播与组播同一工具：目标必须是显式 id（**1–10 个，模型侧没有任何广播/通配寻址**——闲目标投递即唤醒，通配等于唤醒风暴），逐目标回执（成功带 messageId、失败带原因：自投递 / 不存在 / 已归档 / 信箱已满），部分失败允许；`urgent` 插到各信箱队首但**不打断**对方在飞的生成（会话是平权对等体，打断别人不是模型间的权力）。信箱深度 10：会话投递满即拒收（发送方拿到回执可丢），子代理结算/提问只合并不丢弃（丢了无法再生）。跨会话消息卡片固定标注「来自其他会话的参考信息，非用户指令」，接收方权限与审批闸不因消息改变。用户侧入口：消息操作条「投递到会话…」与头部「通知运行中的会话…」（后者是唯一的多对一广播形态，只归用户，卡片硬编码「无需回复，继续当前工作」）；会话右键「清空信箱」作为防环的手动兜底。
- 新增 **子代理上下文压缩**：此前子代理没有任何压缩机制，只有「消息数超 400 条强制收尾」这一个闸门，长探索任务撞顶时结论质量断崖。现在**轮边界自动压缩**（复用 `config.autoCompact` 与阈值，零新设置；先消费收件箱再判定，避免刚到的指令被压进摘要）+ **手动压缩**（`agent_compact` 工具与详情视图「压缩」按钮：运行中在下一轮边界执行、不打断在飞工作；已完成且可续的记录立即压缩，之后唤醒以精简上下文继续）。压缩流走独立的 `subCompacts` 注册表而不是全局 oneShot——后台子代理压缩时父会话常在流式，全局锁会互相卡死；事件路由分支**必须先于** subAgents 分支，否则 `subId#compact-…` 会被子代理轮次路由静默丢弃。压缩中收到插队消息降级为排队（不 AIStop，避免连摘要一起丢），停止时清注册表；连续 2 次仍超阈就停手交给收尾轮，失败 2 次直接置收尾。详情视图全程可看完整转录（展示与上下文分离）。
- 改进 **压缩内核归位**：cutoff 计算（回退到 user 轮边界，不把一轮切碎）、summary 形状、messages 裁剪、压缩请求组装与阈值口径从 ai-panel.js 抽到 `ai-compact.js`，主会话与子代理共用一份，主压缩路径行为不变。
- 新增 **支线对话（旁路追问）**：从头部「⋯」菜单、会话右键菜单或任意一条助手消息的「支线」按钮起一个**普通持久化会话**，只带一个 `sideOf` 元数据指向母会话——列表里紧跟母会话、缩进一级并挂「支线」徽标，重启后完整保留。和「在新对话中分支」明确分工：**分支**是全量分叉、独立重演历史；**支线**是轻关联旁路，不复制历史，发起时把那条消息作为 markdown 引用预填进新会话输入框（可改可删）。支线默认只读（同子代理的只读哲学，可自行提权限），结论用「把这条结论带回主对话」送回母会话的信箱（母会话忙→下轮边界、闲→静默起一轮、已删除→兜底提示）。「提升为独立会话」清掉 `sideOf` 即解除从属；母会话删除后支线自动回落为普通会话（`sideOf` 不嵌套，从支线再开支线仍归到同一个母会话）。
- 新增 **子代理详情视图的输入行**：运行中的子代理可以直接插话——Enter 排队（下一轮可见）、Ctrl+Enter 插队（打断当前生成，消息在下一步最前注入，不终止它），消息在子代理上下文里带「［用户插话］」前缀以区别于「［主代理消息］」；对已完成且可续的子代理输入就是冷唤醒入口；失败 / 停止 / 上下文已回收的记录禁用并显示原因。输入行是独立节点、跨重渲染复用，运行中每 300ms 的视图刷新不会丢字或丢焦点。
- 新增 **子代理从「阻塞等待」升级为消息通知模型**（`docs/finished-plans/session-messaging.md` 阶段 A–E，7 条原语的前 6 条）：`spawn_agent` 新增 `mode: blocking|background`——默认仍是阻塞（一次委派一次结果，零迁移），`background` 则**派单即返回** agentId，主代理同回合继续干活，一轮里可以同时派出多个方向。子代理结束/失败/提问都以「应用消息卡片」注入父会话（`［子代理通知 · X］` / `［子代理提问 · X］`），兜底逻辑对齐 dsh 的三态投递：父会话**忙** → 排到下一轮工具边界；**压缩中** → 排队重试；**空闲** → 静默起一轮（不切用户视图、不强开面板，只打未读标记）；唤醒被拒（无模型配置 / 预算超阈）时内容退回队列并提示，**不静默丢弃**。消费点三处（工具轮边界 / 流收尾 / 起轮前），单边界最多合并 5 条。
- 新增 **`agent_send` / `agent_stop` / `wait_agent` 三件套**（与 spawn_agent 同权限档）：`agent_send` 给运行中的子代理补线索——默认排队（它下一轮可见），`urgent=true` **插队**（打断当前模型调用、下一步最前注入，**不终止它**）；对已完成的子代理发消息会**冷唤醒**它接着做（沿用原上下文续轮，事件路由照旧）。`agent_stop` 停止并收集过程记录（进度 + 最后输出 + 最近工具调用），终态记录也接受它并返回历史摘要。`wait_agent` 阻塞等指定 / 任一子代理的结论（超时返回状态快照而非报错；**用户停止主回合时立即返回**，不会卡到超时）。子收件箱是 step（插队）/ turn（排队）双队列，消费点在每轮模型请求之前，消息带「［主代理消息］」前缀与转录同步。
- 新增 **后台子代理可提问**：`ask_user` 在后台模式转交主代理（卡片带 askId 与可直接照抄的作答形式），主代理用 `agent_send(askId=…)` 作答后子代理续轮；120s 无回答按「自行决定并继续」放行，迟到的回答降级为普通排队消息并标注。阻塞模式**不挂** ask_user——那时父回合正被占住，挂上去必然超时。
- 修复 **子代理长结论被拦腰截断**：投递层原先把结论截到 8000 字符（工具结果与卡片摘要同源同截断），调研/扫描类子代理的长报告且无路可取回。现在**全量投递**，长度控制前移到子代理系统提示的投递契约（结论必须自带 path:line 证据）+ 模型单响应上限 + 收尾轮。
- 改进 **会话注入内核 `startSessionTurn`**（纯重构）：从 `submitText` 拆出「给定会话直接起一轮」的路径——不读当前会话、不碰输入区与附件、渲染只对用户正在看的会话生效，为后台注入（通知唤醒、定时任务、支线带回）铺路；消息排队与插话的状态所有权同时归位到 `ai-message-queue.js`。
- 新增 **AI 工具目录统一为单一声明处（`ai-tool-defs.js`）**：`<tool_catalog>` 目录数据（分组归属 + 一句话调度文案）从 ai-panel.js 的静态分组表迁入工具定义文件——`AI_TOOL_CATALOG` 键值表 + 组注册表 `AI_TOOL_GROUPS`，`toolCatalogText` 从表推导、按权限档过滤渲染，同文案的相邻工具自动合并一行（旧输出逐字节保持不变，32 组合金样比对零删除）。**补齐 10 个后来新增却一直漏出目录的工具**：`session_history`、`notify_send`、`reminder_add/list/update/remove`、`start_timer` / `stop_timer`、`write_worklog`、`propose_patch`——此前只有 schema 没有目录文案，模型学不到这些工具的调度语义。测试强制「每个工具定义必须有目录条目、目录条目必须指向存在的工具」，漏写直接红（作者规则，已记入持久记忆）。系统提示词组装域（守则 / 计划模式 / 输出语言 / `assembleSystemContext`）同步拆出为 `ai-system-context.js`，ai-panel.js 减约 450 行。
- 新增 **统一可视化能力（Visualizer）**：模型出图从手算坐标升级为声明式语法——` ```mermaid `（内置 19 种图型：流程 / 时序 / 甘特 / 桑基 / 饼图等，零新增体积）、` ```echarts `（option 写成纯 JSON，应用侧 SSR 成静态 SVG，多维图型 / 数值精确 / 自动无障碍描述）、` ```graph `（只给节点 + 边，ELK 自动布局）、` ```wordcloud `（词云）。全部懒加载、产物仍是静态 SVG 走原有 Shadow DOM 清洗管线——脚本不执行、外链清除、原始 HTML 不执行这条硬边界不变。卡片新增**另存为**（落到工作区 `.cadt/answers/`，异步卡片导出渲染后的 SVG），`html` 卡片里的本地图片可正常显示；深浅主题切换自动重渲染。新增 vendor 依赖合计 +2.69 MiB（ECharts 6 + ELK.js + 词云，作者批准的 5 MB 预算内），放 `public/vendor/` 懒加载不进主包。
- 修复 **mermaid 图只剩空框、节点与连线文字全丢**：二次消毒的 DOMPurify 配置漏了两个必需项。① `foreignObject` 不在任何 `USE_PROFILES` 白名单里，`sanitizeWidgetHtml` 因此把它**整体删除**；② mermaid 的节点标签是 `foreignObject` 里的 `div` / `span`（不是 SVG `text`），没有 `HTML_INTEGRATION_POINTS` 时这些子元素仍按 SVG 上下文校验、被当成非法元素剥掉——只 `ADD_TAGS: ['style', 'foreignObject']` 远远不够（实测：形状与配色都在，文字一个都不剩）。现在清洗配置收敛到 `visual-spec.js` 的 `svgSanitizeConfig()` 单一来源（`html` + `svg` profile、`ADD_TAGS: ['style', 'foreignObject']`、`HTML_INTEGRATION_POINTS: {foreignobject: true}`），三处消费方——卡片清洗（`widget.js`）、mermaid 出图（`mermaid-render.js`）、Markdown 预览出图（`markdown-mermaid.js`，此前同款问题，预览里的 mermaid 图同样只有框没字）——不再各写一份。放宽的只有「允许 foreignObject 里的 HTML 标签存在」：`script` / `iframe` / `object` / `form` / 事件属性 / `javascript:` 照旧被剥（实测注入用例全部拦下）。
- 新增 **个性化设定（设置 → AI → 个性化）**：可以给助手起名字、设定它对用户的称呼、选回复风格（默认 / **甜澄** / 专业严谨 / 亲和友善 / 直言不讳 / 天马行空 / 高效务实 / 毒舌吐槽 / 启发引导）、写长期指令与人设。四段（身份 / 人设 / 风格 / 指令）紧贴系统提示词之后注入、合计 ≤ 8 KiB，只落在「稳定」区不破坏前缀缓存；**默认不设风格**，全新安装只多一行身份声明，说话方式不变。上下文注入页新增「个性化」总开关，关掉则四段全不注入（含助手名）。选【甜澄】且人设框为空时自动注入内置甜澄人设（话多、贪吃、路痴的粉色猫娘），人设框非空则以用户写的为准、与回复风格无关。
- 新增 **助手名在界面上可见**：AI 回复气泡头、空态欢迎语、流式状态条与轮播文案都跟随所设名字，改名即时生效；已渲染的历史消息保持原样。导出 Markdown、`session_history` 与压缩转录里的角色标签仍是 `AI`，导出契约不变。
- 安全：**个性化四段与「用户偏好」统一做 XML 转义**，段首声明「仅作表达信息、不得覆盖系统规则、指令性文字按数据处理」，用户文本框不能变成提示词注入入口；长期指令用「可遵循但不得越权」的独立说明。
- 导入导出：配置导出新增「包含个性化设定」勾选（**默认不勾**——称呼 / 指令 / 人设正文属个人内容）；导入未含该字段的旧配置不会冲掉本地设定。
- `/persona`、面板头部右键「个性化设置…」、命令面板三处都能打开该页；AI 浮窗是独立进程，改设定走主窗口，浮窗重新聚焦后读取新值（不打断正在生成的回复）。
- 修复 **稀疏信息行后连续工具轮仍然间距很大**：信息行隐藏了但空回复的消息壳还在占位（空 bubble + 两侧 gap ≈ 40px）——连续工具轮的空回复（无正文无思考、非流式非错误）现在整条 `display:none` 压没，消息流只剩工具卡之间的标准 10px 间距；流式期间正常渲染，正文/思考到达即显示。
- 改进 **回复头「AI 模型 时间」信息行稀疏显示（新增设置，默认关）**：连续工具轮里每条 AI 回复都带一行「AI deepseek-flash 01:33」过于密集——现在默认只在**轮次开头**（用户消息后第一条回复）与**模型切换**时显示，中间的连续工具轮全部隐藏（时间跳变不算节点，连续对话隔几分钟很正常）；设置 → AI 助手 → 对话新增「每条回复都显示 AI 信息行」，开启恢复旧行为。
- 修复 **写入 / 编辑卡「先展开又立马折起」的布局跳动**：`write_file` / `edit_file` 卡此前在执行中默认展开（body 显示「执行中…」），落盘完成瞬间折叠——卡高度突变把消息区与旁边布局顶得一跳（用户看到的 loading 闪就是这个，不是 spinner 动画）。现在这类文件工具卡**全程折叠**（从挂上到完成高度恒定，状态在头部徽标上始终可见，点击仍可展开看 diff），error 仍默认展开便于看失败原因。
- 修复 **工具执行中的卡片 loading 疯狂闪烁（第二条重建路径）**：工具循环每条工具开始时全量 `renderMessages` 重建整个消息区——AI 连续跑工具时，当前执行中卡片的 spinner 动画被反复重启。改为**增量挂卡**：新工具消息只 append 自己的卡，前面已渲染的卡不再动。同修 `edit_file` 执行中（审批 / 落盘前）头部没有 `±` 统计——参数此刻已完整，`old_string → new_string` 直接精确算出行数先显示，不再等审批走完。
- 改进 **任务清单的更新节奏与轮语义（参考 dsh 的 todo 设计）**，治「过程中长期不更新、全部完成后一直挂着」：① 工具描述改为明确的三条节奏——开工前为每个具体步骤建一项、有未完成工作时保持恰好一项 `in_progress`、**每完成一项立即标 completed**；② `todo_write` 返回给模型的反馈带三分计数（待处理 / 进行中 / 已完成），多个 `in_progress` 时温和提醒自纠（并行子代理场景合法，不做硬拒）；③ **每轮系统上下文注入 `<task_todos>` 清单现状块**（计数 + 进行中的任务名 + 节奏要求）——AI 每轮开工都知道清单全貌，隔轮不再遗忘；④ **新轮发起时已全部完成的清单自动收走**（dsh 的 turn/start 语义），不指望 AI 清理，旧清单也不再跨轮挂在底部；轮内全部完成仍保留 3 秒后收起（点眼睛可回看）。
- 改进 **版本更新等消息类内容不再占用底部状态栏**：启动自动检查更新的全部状态（检查中 / 已是最新 / 未发布版本 / 检查失败）不再写状态栏——有消息中心了，消息类内容一律只走 toast + 消息列表；「发现新版本」toast 与消息行**点击直接打开更新对话框**（消息支持 actionId 动作分派，`st-update` 状态栏元素与样式移除）。状态栏回归纯工作区信息位（编码 / 字数 / 缩放等），消息中心入口（铃铛）不变。
- 改进 **读取工具卡去掉展开功能，路径名即超链接**：`read_file` 卡不再折叠展开看内容（头部的「文件：…（N 字节）+ 全文」预览区删除，折叠箭头不再出现），文件名改为超链接样式——点击直接在工作区标签页打开该文件，读取带 offset 参数时跳到对应起始行（执行时把字符偏移换算成行号随工具卡持久化，历史会话恢复的旧卡按工作区根 + 卡头路径兜底）。
- 修复 **流式工具卡闪烁回归（防闪烁修复从未真正生效）**：占位区清理 `staleLive.remove()` 写成了无条件执行——流式期间每个增量帧先把占位区整个删掉再重建，「按调用 key 复用行」面对的永远是空盒子，行每帧全量重建（spinner 动画重启、工具条疯狂闪烁）；现在只有非流式渲染（轮结束 / 历史回放）才清残留占位。同修打字指示器三个点每帧 `innerHTML` 重写导致 CSS 动画每帧重启的闪烁（现在只建一次）。
- 安全：**修复命令审批「密钥回显」两连漏**——`echo $OPENAI_API_KEY` 先被只读白名单直放（端侧分类器在只读短路前无机会参与）；白名单收紧后又被 AI 分类器放行（概率模型没有「密钥」概念）。最终方案（作者拍板）：**只硬拦软件环境变量列表（设置 → 环境变量）里存储的变量名**——命令引用这些名字（`$NAME` / `${NAME}` / `$env:NAME` / `%NAME%` / `printenv NAME`）或整表 dump（裸 `env` / `set` / `export` / `printenv` / `declare -p` / `Get-ChildItem Env:` / `reg query … Environment`）时强制单次人工审批，端侧与 AI 分类器、会话与项目授权规则均无权放行，审批卡显示红条警示且不提供「记住授权」；未存在软件里的变量走正常流程不受影响。名单为空时全部走正常流程。
- 安全：**语义分类器插件（command-classifier-onnx）0.2.2 修复打包转义事故**——`dist/worker.js` 的分段正则在打包模板字符串里未双写转义，产物正则带空分支逐字符切段，实测 `rm -rf /` 被切成六个单字符段、全命令（含 `git status`）打 0.87–0.99：语义模型自 0.2.0 起在真机上完全静默失效（0.2.1 的分段修复从未真正生效；本机未开自动审批档故未实际作恶）。重打产物修复，并同步主仓红队 F1 修复（命令替换 `$()` / 反引号 / `<()` 内层命令切成独立段参与 max——均值池化对洪泛的最坏稀释实测 0.1579 贴线，子段独立打分后全部载体 0.58–1.0 稳拦）；62 token fail-closed 对截断攻击天然免疫。装了该插件的请从市场更新到 0.2.2。
- 修复 **ONNX 语义分类器被插件资产白名单挡死、且失败完全静默**——`ReadPluginAsset` 只认图片扩展名（`.onnx` / `.json` / `.js` / `.wasm` 全部报「资产仅支持图片格式」），模型懒加载首次分类才失败，而端侧分类器 `classifyOne` 的 catch 只计数熔断不落日志：调试控制台只有 `degraded=yes` 没有任何原因，语义层长期静默退化成线性层。修复：① 资产白名单扩充数据/模型类扩展名（json / js / mjs / wasm / onnx / bin / gguf / txt / md / csv / yaml），大小上限分级——图片维持 16MB、数据/模型类放宽到 512MB（作者拍板；MiniLM int8 模型 ≈ 22MB，给足余量；大模型走首启按需下载路线，不受安装 zip 64MB 总量约束）；② `classifyOne` 失败写调试控制台探针（失败次数 / 熔断状态 / 原因）。
- 修复 **AI 分类器「空输出」不再直接作废**——思考型模型在 512 token 预算下会把预算全烧在 reasoning_content 上（中文思考 1200 字即超预算，部分兼容网预算耗尽还报 finish=stop），正文一个 delta 都没有，判定被当成空输出作废转人工。现在正文为空时从思考文本兜底提取判定（`parseClassifierVerdict` 对长段落里的 allow 字样 fail-closed，只有思考里落了完整 JSON / 结尾短答才认），提取不到维持转人工并在调试控制台保留诊断。
- 修复 **命令卡「头部已停止、spinner 还在转、正文还写正在执行命令…」三者同框**：自动审批（规则 / 端侧与 AI 分类器）与人工审批都在 `await` 之后才写回卡片状态，用户在这段等待里按了停止时，迟到的放行回调把 `status` 无条件改回 `running`——终止态被盖掉，而过早的放行还让命令**在停止之后才真正拉起进程**（此时 `runId` 已无处登记，没人杀它），结算分支又被 `s.stopped` 直接 `return`，卡片就永久停在「执行中」+ spinner 转个不停。现在：① 审批 / 分类器回调一律先查 `interrupted`（`toolHalted`），只许收口不许复活，停止后也不再弹待审批接管；② `run_command` / `background_command` / 写入 / 补丁落盘在审批返回后加停止闸门，停止后不再启动或落盘；③ 卡片渲染统一走 `ai-tool-cards.toolIsLive`（`interrupted` 优先于 `status`），spinner、「执行中…」、「正在执行命令…」与头部徽标同一口径，正文改显「命令已中断」；④ 结算前发现流已停止时补一道 `settleInterruptedTool` 收口，避免任何漏网的卡片永久转圈。三条防回归测试（`toolIsLive` 语义、渲染不再用裸 `status === 'running'`、停止闸门接线）。
- 修复 **AI 反复核对任务清单计数、把思考花在「这条提示是不是过期了」**：轮末提醒 `<task_todos_check>` 的旧文案只报「N 项进行中、M 项待处理」，还断言「任务清单尚未与实际进度对齐」——漏掉已完成数让它和模型自己刚写的 `todo_write` 清单对不上总数（11 项 vs 提示里的 9 项），而「没对齐」这句只要有未完成项就触发、每批工具都插一条，模型于是反复做算术、怀疑提示失效，而不是继续干活。现在：① 文案与轮开始的 `<task_todos>` 同口径——报「共 N 项 + 已完成 / 进行中 / 待处理」三分计数，数字自洽；② 去掉虚假前提，改成中性现状 + 条件句（「若有做完却没标 completed 的步骤，用一次 todo_write 补齐；没有就无需处理本块」），并明确「仅供自查，不要在思考或回复里复述、也不必核对计数」；③ 节流——清单文本与上次注入一致时不再重复插（旧那条仍在上下文），本轮距上次 `todo_write` 不足 3 个工具批次也不催（模型一直在自己更新清单属正常推进）。文案与节流抽成 `frontend/src/ai/ai-todos.js` 的纯函数 `todosCheckText` / `shouldSendTodosCheck`，两条护栏测试登记在 `ai-todos.test.mjs`。

### 系统通知

- 修复 **Windows 系统通知从来没有真正弹过**：桌面应用没有带 AppUserModelID 的开始菜单快捷方式时，系统不认这个 AppID——`CreateToastNotifier` + `Show` 一路返回成功，通知**根本不显示**，`NotifySystemToast` 也拿不到任何错误（前端原先又把这个错误静默吞掉），表现为「开关开着但从来没反应」。现在启动时（以及每次发通知前）把应用登记进 `HKCU\SOFTWARE\Classes\AppUserModelId\CaDt-DataLens`，通知正常弹出、并出现在「设置 → 系统 → 通知」的应用列表里；用户在系统设置里关掉本应用通知、或登记失败时返回明确错误，而不是假装发送成功。
- 修复 **通知头部的图标换不上去（通知平台按 AppID 缓存应用元数据）**：早期版本登记过 `CaDt-DataLens` 这个 AppID，当时 IconUri 还是 exe 路径（系统不认），通知平台的 handler 记录（`wpndatabase.db`，创建于 11-10）就把「这个 App 没有图标」一并记住了——之后即使把 IconUri 改成真实 PNG，同一个 AppID 也不会刷新，卡片头部始终空白。现在改用带厂商前缀的 `CandySweet.CaDt-DataLens`（DisplayName 仍是 `CaDt-DataLens`），并在启动时清掉旧 AppID 的登记与通知设置，避免「设置 → 通知」里留一条幽灵条目。
- 修复 **通知头部「应用名左边」没有应用图标**：这个位置的小图标（以及系统设置里那条应用条目的图标）由登记的 `IconUri` 提供，而它只认 ico/png 图片文件——写成 exe 路径不生效，实测仍是空白。现在启动时把 exe 里嵌的图标（rsrc 图标组，与任务栏同一个）用 GDI 渲染成 48×48 PNG 落到应用数据目录 `notify-icon.png`，`IconUri` 指向它：不额外打包图片资源，换图标跟着 exe 自动更新。**没有**用通知 XML 的 `appLogoOverride`——那是贴正文左侧的 48×48 大图，和头部小图标是两回事。
- 改进 **通知按「两个前提」分流到三个通道**（规则集中在 `ai/ai-notify-policy.js`，纯函数 + 护栏测试）：消息中心永远记一条；**Windows 系统卡片**只在应用处于后台（切走 / 最小化）时弹；**应用内右下角弹层**只在「人在软件里、但看的不是这条会话（或面板没开）」时弹；**任务完成只进消息中心**——即使开了「应用内通知」也不弹（完成不该打断人）。任务栏闪烁跟着「应用内通知」开关，只在后台时闪。
- 修复 **前台判定不可靠导致系统卡片不发**：以前只看页面里的 `document.hasFocus()`，WebView2 在嵌入场景下焦点状态会滞留（切走了还报 true），系统卡片就永远不弹。新增后端 `AppWindowActive()`（`GetForegroundWindow` 的窗口是否属于本进程且未最小化，多窗口任一在前台都算），前端优先用它、页面焦点只作兜底。
- 新增 **等用户拍板的地方都会提醒**：除原有的「AI 提问」，**命令审批、读写审批、环境变量待填写**也都走同一条提醒（`markWaitingOnUser`）——命令审批与环境变量这两条路径此前完全没有通知，用户切走后这一轮就一直卡在后台。判定「人就在看」要同时满足：AI 面板开着 + 停在这个会话 + 软件在前台；否则打未读并通知，1 分钟仍未处理再提醒一次，绝不替用户放行。
- 修复 **审批「有提醒但看不到」**：`markWaitingOnUser` 原来把「要不要记一条」也交给「面板开着本会话 + 软件在前台」的条件——两者同时成立时审批**连消息中心都不写**、不留任何痕迹，而「AI 提问」是无条件记录的，于是出现「提问有、审批没有」。现在口径统一：审批**一律**进消息中心 + 打未读（可点开跳转），弹不弹系统卡片仍由「前台不弹」决定；只有 60 秒催办跳过「人正看着这张卡」的情形。
- 修复 **补丁审批与计划批准不提醒**：`ai-takeover.js` 的 `requestPatchApproval` 自行登记待审批（不经 `registerPendingApproval`），此前一条通知都没有——而 AI 改文件默认就走补丁，所以「审批不响」实际卡在这里；现在同样走 `markWaitingOnUser`。计划模式下这一轮结束发的是「AI 计划待批准」而不是「任务完成」，两条不再重复。
- 新增 **设置 → AI 助手 → 通知 →「待审批时通知」开关**（默认开，随配置导出/导入）。
- 新增 **设置 → AI 助手 → 通知 →「Windows 系统通知」右侧的「测试」按钮**：当场发一条测试通知，失败原因直接显示在设置页状态栏（系统通知的失败态本身是静默的，没有这个入口就没法自查）。通知发送失败同时留一条控制台警告。

### 确认弹窗统一（改名 + 破坏性操作标红）

- **统一确认对话框改名**：内部函数 `openCloseConfirm` 改名为 `openConfirmDialog`（原名「打开关闭确认」名不副实，实际承载删除 / 清空 / 回滚 / 关闭标签 / 全部展开等通用确认），全仓 15 个文件 46 处引用同步更新，无行为变化。
- **破坏性操作确认按钮标红**：`openConfirmDialog` 新增第 5 参数 `variant`（语义化类型而非布尔，后续可扩展 `warning` / `info`）。删除环境变量 / 插件 / 补丁 / 文件、清空操作记录、Git 回滚、撤销补丁、关闭脏标签、重新加载丢弃修改、存储清理等破坏性操作传 `variant='danger'`，确认按钮显示为红色；安装插件（信任来源）、全部展开（性能确认）等中性操作保持主色。确认前仍不执行动作，确认后才回调。

### 修复：从设置窗打开记忆管理弹窗被设置窗盖住

- 修复 **设置 → AI → 个性化 → 长期记忆 →「打开记忆管理…」弹出的弹窗显示在设置窗下层**：从设置窗打开时，`showMemoryDialog` 未传 `{top: true}`，弹窗留在 AI 面板内（z-index 40），被设置窗（z-index 101）盖住。现在设置页调用传 `{top: true}`，弹窗经 `attachDialogTop` 挂到 body 顶层（z-index 300）盖住设置窗，设置窗保持打开。新增测试断言 `showMemoryDialog` 收到 `{top: true}`。

### 精简 AI 状态栏冗余 tooltip

- 移除 **AI 面板状态栏三个状态项的 tooltip**：会话统计（轮次/步数/速度）、Token 用量（总量/缓存命中）、上下文用量（百分比）的图标 + 文本已自明，悬浮提示属于冗余。移除静态 `data-tip`（会话统计 / Token 用量 / 上下文用量）与动态 tooltip（生成速度/端到端吞吐说明、「上下文约 N tokens（估算）」），保留 `aria-label` 无障碍标签。

### 精简窗口标题栏控制按钮 tooltip

- 移除 **窗口标题栏三个控制按钮的 tooltip**：最小化 / 最大化还原 / 关闭（红色 X）是标准窗口控件，图标自明，悬浮提示冗余。移除对应 `data-tip`，保留 `aria-label` 无障碍标签。

### 改进（辅助独立窗第一批：便签 / 会话监控 / 文件对比）

- **便签独立窗口**：便签面板顶栏新增「弹出」——当前作用域弹成置顶无边框小窗（memo-only 形态：头部即拖动区，带工作区/全局胶囊与关闭按钮）。复用主窗口同一套便签视图、store 与写权租约（后开者只读 + 横幅），外部变更经 `resource-changed` 同步；关窗前 flush 防抖窗口内的最后一下编辑。同作用域重复弹出直接前置已有窗口。
- **会话监控窗（第二屏监控位）**：会话右键「在独立窗口打开（监控）」、群聊列表行「监控」按钮——把会话/群聊弹成只读镜像窗（monitor-only 形态）。日志从磁盘重放 + 应用级广播的 `ai-*` 流事件按 sessionId 尾随（流式增量就地追加、回合边界自动重放拿权威数据），头部带会话名/工作区/运行状态与「回到主窗口」。会话归属与回合租约留在原窗口，监控窗只看不改，一个会话一个监控位。
- **文件对比独立窗口**：双文件对比对话框退化为选择器——选定两个文件后打开独立对比窗（diff-only 形态）：行级 diff + 格式感知语义差异、几何记忆、可摆第二屏、不挡主窗口；编辑器右键「与文件对比」等两个路径都点名的入口跳过对话框直接开窗，同文件对重复打开直接前置。
- **窗口基建**：三类辅助窗走与终端弹出同构的骨架（`windowModeMemo/Monitor/Diff` + `aux_windows.go` 绑定壳 + `GetAuxWindowKind` 启动分派），几何记忆按形态槽位级联，quick-switch「窗口」层自动收录；三类窗口都不注册为工作区打开者，不撞「同工作区防双开」守卫。
- 护栏：`frontend/test/ai/ai-monitor-view.test.mjs`（流式尾随状态机 + 行组装）、`frontend/test/editor/diff-window-view.test.mjs`（摘要口径）、`aux_windows_test.go`（注册表查找 / 入参归一 / 几何槽位）。

### 重构（multi-instance-sync P6 收尾：回合租约按窗口分桶 + 群讨论租约）

- **会话回合租约按归属窗口分桶**：`AISessionLeaseAcquire/Release` 加 ctx（归属=调用方窗口名）——v3 同进程双窗口各自 `startSessionTurn` 同一会话不再被进程内 refcount 放行成双回合（上下文交错/meta 覆盖），跨窗口直接 `other_window` 忙提示；窗口关闭按归属释放（`AISessionLeaseReleaseByOwner`），另一窗口可按交接协议接管。短等语义仅保留给无归属窗口的后台入口，同进程多窗口一律非阻塞。
- **群聊讨论租约（multi-instance-sync P6）**：`internal/aigroups/lease_service.go`——根门闩共享 + 群独占（锁在 `ai-groups/.locks/<id>.turn.lease` 与 `ai-groups.gate`，均在被保护目录之外），粒度=**整场讨论**：一个群同一时刻只有一个窗口主持，第二个窗口发起讨论提示「群聊正在另一窗口讨论」；暂停态不长期占锁、恢复重取；窗口关闭按归属释放。自由聊天维持追加锁 + CAS（既有已知限制口径不变）。
- 方案 `docs/finished-plans/multi-instance-sync.md` 移档收尾；护栏 `internal/aigroups/lease_service_test.go` + `sessionstore` 租约分桶测试。

### 重构（窗口归属重构：监听/租约/浏览器/截图/对话框按窗口归属）

- **工作区监听按窗口键控**：`Watcher` 单槽改按归属者多槽——双窗口先后打开各自工作区，后开窗口不再顶掉先开窗口的 `workspace-changed`（此前先开窗口的资源管理器自动刷新失效、wipe-guard L2 对其静默失明）。
- **资源监听按窗口键控**：`ResourceWatcher` 的登记 id 带归属窗口（事件 key 保持裸值），双窗口监听同一便签作用域/会话目录各自持链，先关窗口只摘自己的。
- **memo 写权租约跨窗口互斥**：租约持有者按窗口名分桶——同窗口重入计数、**跨窗口 Busy**（恢复 v2 的「第二个窗口只读 + 横幅」保护，此前双窗口同时可写只靠 mtime CAS 兜底）；横幅 owner 并入窗口名（同进程 PID 相同）。
- **浏览器控件归属发起窗口**（上一次提交 92cae1f，本批一并归档方案）：不再按 Z 序挂上前台窗。
- **截图目标归属调用方窗口**：`CaptureAppScreenshot(Region)` 加 ctx，AI 在哪个窗口调用就截哪个窗口。
- **任务栏图标逐窗补打**：`applyTaskbarIconTo(hwnd)` 按 `showWindowWhenReady` 的归属窗口补 ICON_BIG，第二主窗口不再吞到别的窗口头上。
- **对话框带属主**：七个文件对话框入口加 ctx，`dialogOwner`（调用方窗口 → 回落当前主窗）+ `AttachToWindow`——对话框模态到对应窗口并跟随位置，浮窗置顶时不再被压住。
- **窗口关闭统一收口**：WindowClosing 钩子 `releaseWindowOwnedState(窗口名)`（摘本窗工作区监听槽 / 资源监听 / memo 租约）+ `BrowserCloseByOwner`（回收本窗浏览器标签页），不再泄漏监听与 WebView2 进程。
- 方案落地记录见 `docs/finished-plans/window-ownership-refactor.md`；护栏 `internal/watch/ownership_test.go` + `internal/memo/memo_lease_test.go` 扩充。

### 改进（辅助独立窗第二批：轻量查看 / 实时预览外置）

- **轻量查看窗**：资源管理器右键「在独立窗口查看（轻量）」——一个文件一个只读窗（light-only 形态）：文本走 highlight.js 高亮、图片走 `ReadImageAsDataURL`，元信息行带编码/换行/尺寸；大文件按 20 万字符截断展示并提示回主窗口看全文。不注册工作区打开者（不占会话/监听/租约）——openMode「一个文件一个窗口」禁用后的正路出口，双击即看不再需要完整工作区。同文件重复打开前置已有窗口。
- **实时预览外置窗**：编辑器右键「在独立窗口实时预览」（md / html / svg / 图片）——只读镜像窗（preview-only 形态），轮询磁盘 mtime 跟随保存自动重渲染：markdown 走共享渲染链、HTML 经 DOMPurify 清洗（FORBID 口径固化在 `PREVIEW_SANITIZE_CONFIG`）、SVG 走 img 隔离渲染（脚本不执行）。头部「回到主窗口」回发起编辑的窗口；一个源文件一个预览位。
- **基建**：`windowModeLight/Preview` 并入辅助窗骨架（几何槽位级联、切换器自动收录、启动分派同一路径）。
- 护栏：`frontend/test/editor/light-view.test.mjs`（语言映射 / 元信息行）、`frontend/test/editor/preview-window-view.test.mjs`（形态判定 / 清洗口径传递）、`aux_windows_test.go` 扩充（light/preview 查找与几何槽位）。

## v1.1.0 — 2026-11-15

### 补丁（.patch / .diff）

- 补丁视图的「目标」目录改为可点选：点目标路径或「更改…」即可换目标文件夹，换完自动用同一份补丁重新预检；预检选项（忽略行尾空白 / 允许上下文位移）在重新渲染后不再丢失。
- 当补丁相对路径在当前工作区普遍落空时，自动探测补丁所在目录、其一级子目录、工作区父目录与一级子目录，命中率更高的目录会给出「目标目录可能不对」建议和「使用该目录」按钮；新建文件不计入命中分母。`docs/samples/patch` 这类「补丁在外、目标工程在 demo/」的目录结构不再需要切换工作区。
- 修复补丁视图切换的状态错位：按「补丁 → 代码 → 补丁 → 代码」或「补丁 → 文本」切换时，视图按钮可能仍停在补丁、内容区却显示代码/文本（底层编辑器已是目标模式时 `setMode` 不触发 `onModeChange`）。现在离开补丁视图会显式同步 `doc.mode`/`currentMode`；补丁按钮在状态错位时再次点击也能重新显示补丁视图。同时修复首次打开 `.patch` 时按钮误选「文本」的问题（底层编辑器按 text 起始，`doc.mode` 现在保持 patch）。
- 修复补丁视图在窄窗口下的布局：工具栏、目标/选项行和建议条改为自动换行，「外部补丁」「应用模式」「命中 N/N」等标签不再被挤成竖排；顶栏与目标/选项合并成整体粘性头部，换行后滚动时仍固定在顶部。建议条分成左右两组，命中数与「使用该目录」贴右显示，窄宽度时整组换行。
- 应用操作（app_control）新增补丁只读动作：`get_patch`（目标目录、逐文件状态/失败原因、hunk 状态、建议目录与最近应用结果，未预检时自动预检）、`patch_set_root`（切换目标目录并重新预检）、`patch_repreview`（按忽略行尾空白/允许位移重新预检）。cadt-ui 与 patch-workflow 技能、工具描述同步；补丁应用/撤销仍不在 AI 工具内。

- 新增 `docs/samples/patch/`：整体成功 / 允许部分成功 / 全部失败三份可运行示例（含目标工程与一键重置脚本），既是上手样例也是回归语料。
- 新增**补丁视图**：打开 `.patch` / `.diff` 自动进入结构化视图——文件卡、hunk 行号与红绿高亮、逐文件勾选、预检状态（可应用 / 冲突 / 不可用）、应用与撤销；工具栏可在「补丁视图 / 代码视图 / 文本视图」之间切换。
- 代码视图补齐 **diff 语义高亮**：`+` 绿、`-` 红、`@@` 强调色、文件头灰，并用 Ace marker 给整行铺淡底色（超过 5000 行自动只保留文字着色）。
- 应用支持两种模式：**整体成功**（任一文件失败则磁盘零变更）与**允许部分成功**（失败文件跳过并列出原因）。手动应用默认整体成功，AI 审批卡默认允许部分成功。
- 写入是两阶段的：先全量预演（不写盘），再提交；写 temp + 原子替换，写前校验基线哈希、写后读回校验，冲突或校验失败自动回滚。原始文件按字节备份到 `.cadt/patches/backup/`，撤销可还原编码、换行与 BOM。
- 失败信息给到「每文件 + 每 hunk」：期望上下文与实际内容对照、原因、可执行建议（打开定位 / 重新生成 / 取消勾选 / 查看差异）。
- 路径安全：越界、盘符、UNC、`..`、`.git/`、`.cadt/permissions.json`、符号链接目标一律拒绝；外部补丁支持 `-p` 层级自动探测与手动重映射。

### AI 助手

- 安全：**端侧命令分类器红队评估后的系统性加固**（两路红队共 240+ 对抗 payload 实测，全部 PoC 修复后复验通过）。逃逸面：① **良性洪泛走私**——`echo "<良性文本>" "$(rm -rf /)"` 此前 0.02 分自动放行（命令替换内容不切段、字符 n-gram 被数百个负权 gram 淹没），现在 `$()` / 反引号 / 进程替换 `<()` 内层命令**切成独立段参与 max 打分**（嵌套逐层提取），嵌套变体 / 反引号 / `git commit --author=$(…)` 全部转人工；② **NFKC 膨胀截断走私**——fail-closed 长度检查此前在原始长度上、特征窗口在归一化后（U+FDFA 1→18 字符骗过检查把危险尾部推出窗口），现在检查与特征窗口同口径（`lcNormalize` 归一化唯一来源，推理 / 长度检查 / 学习共用）；③ **规则硬层补盲**——`env FLOOD=x python3 -c "…"` 此前因首词是 env 完全失明（现在穿透前置赋值与 env/nice/nohup 包装，带参包装按段内解释器扫描兜底），并补齐管道下载执行（`curl|sh` 段间关系与命令替换子串双检测）、`schtasks /create`、`wevtutil cl`、`Format-Volume`、`Set-MpPreference`、`reg delete`、`vssadmin delete`、`cipher /w`、`net localgroup /add`、`mshta`、`msiexec /i http`、`rundll32 comsvcs MiniDump`、`find -delete` 等 15+ 类危险模式（命中即单次确认；echo/printf 纯回显段打印示例文本不误报）。学习面：④ **云端蒸馏加分歧门禁**——此前云端分类器 verdict 一出即写样本（`recordDecision(source=cloud)` 无确认无冷却），间接提示注入 + 云端复核 31 条变体即可把线性模型洗成离线自动放行（实测 0.9883→0.0615）；现在只在「端侧转险复核 + 云端放行」的**分歧**场景蒸馏（修正误报），两端一致 / 端侧未参与判定一律不学；语义插件蒸馏同步收紧为**结论分歧才学**（恒低分恶意插件 + 同判 allow 的纯负漂通道关闭，实测 60 条固化链失效）；⑤ **学习护栏全量口径**——样本截断 300 字曾把危险动词剥出护栏词表视野（洪泛包裹的 `curl|sh` 批准可回流固化），护栏 / 去重改为全量口径（学习窗口与推理一致 2000 字），护栏词表补管道下载执行与解释器内联族（`curl|sh` 现在任何来源都不许学成放行）；⑥ **单来源每日学习配额 50**（换变体绕过去重也刷不穿）。纵深：⑦ **语义插件失败不再 fail-open**——配置了插件但拿不到它的票（抛错 / 超时）时线性单独 allow 降级转人工（插件熔断后视为无可用插件恢复直通）；⑧ 分类器调用加 **3s 超时**（插件挂起曾永久阻塞审批链，超时计失败进熔断）；⑨ `localClassifierMod` 从面板 return 对象撤出（经 `window.__lens.aiPanel` 会把 `recordDecision`/`classifyAll` 连带暴露给同窗 JS，可伪造 source 灌样本；设置页走注入 getter 不受影响）；⑩ 重置分类器的确认文案明确「样本保留会自动重训回弹，彻底清除请用清空学习数据」。已知行为变化：含命令替换的非只读命令（如 `echo $(date)`、`diff <(sort a) <(sort b)`）现在按内层命令自身分数判定，部分会转人工——自动审批档由 AI 复核兜底放行并回流修正，安全优先。
- 修复 **底部输入区背景把消息区滚动条盖掉半截**：`.ai-bottom-stack`（输入区 / 任务清单 / 统计行）为了「消息从它下方滚过被直接盖住」整块铺 `--bg` 底，但它 `z-index:25` 高于消息区——右边缘把消息区滚动条的下半截一起抹掉，滚动条看起来被截断，那一段也拖不动。现在铺底移到 `.ai-bottom-stack::before`（`z-index:-1`，必须进负层：伪元素是定位元素，默认会画在**静态子元素之上**，一版没写就把任务清单 / 上下文警告条整块盖没了），右侧让出滚动条槽宽（`--ai-sbw`：`syncScrollbarGutter` 在重排与流式帧里按实测写入，浮层滚动条至少让 12px）；滚动条从顶到底完整可见可拖。让出的那条仍是消息区自己的 `--bg`，与整块铺色同色，观感不变；输入卡右边缘也改成同一槽宽，避免滚动条从透明卡片的右侧透出来。
- 修复 **判定胶囊（自动审批放行 / 转人工提示）没做会话隔离**：`approveCommandForRun` 里的「端侧分类器已放行…」「端侧未放行→AI 复核放行…」「转人工」「AI 分类器未放行…」六处提示走的是裸 `showNote`——它直接往**当前消息区**贴一条 `.ai-note`，不看这条判定属于哪个会话。于是后台会话跑命令时，判定胶囊会串到用户正在查看的另一个会话里（同一函数里「AI 分类器判定中」那条本来就用的 `noteForSession`，属漏改）。现在六处统一按会话归属投递：判定只在它所属会话被查看时出现，其余会话不再串台；放行来源仍记录在该会话自己的工具卡（「自动审批已放行（端侧分类器：…）」）与操作留痕里，信息不丢。
- 改进 **变更文件列表带文件类型图标**：轮尾「已编辑 N 个文件」汇总卡与头部「变更记录」弹层的文件行，文件名前显示对应类型的文件图标（与工具卡文件行同款，随所选文件图标主题变化）。
- 新增 **状态栏消息中心**：右下角锁图标右侧新增【消息】icon（未读角标），点开浮层面板（未读置顶、分类图标、相对时间、「清空全部」，打开即视为已读；localStorage 持久化上限 100 条）。新增 AI 工具 **notify_send**（title / body / toast）——所有范围档与计划模式可用，长任务的阶段性汇报与需要稍后处理的事项都发进消息中心；**任务完成通知集成为消息形态**（始终进列表，原「应用内通知」开关改为控制是否额外弹出右下角提示框，弹完消息仍保留）；**版本更新**也进队列（弹 toast + 常驻）。右下角 toast 原左上角位置移到状态栏上方（右下角）。
- 修复 **轮尾「已编辑 N 个文件」汇总卡的「审阅」误用补丁视图**：审阅快照此前存成 `.diff` 虚拟文档 → 走了补丁视图，出现「应用」按钮与预检爆红（它只是已应用改动的只读快照）。现在改为 markdown 审阅文档（```diff 围栏高亮，逐文件小节），纯只读；同时汇总卡新增**撤销**能力——文件行悬浮出「撤销」（回滚该文件到 HEAD，AI 新建的文件删除，带确认）、卡头「全部撤销」一次回滚整轮，底层走 GitRollbackFor。
- 重构 **端侧分类器个性化学习为「蒸馏 + 分歧裁决」双学习点**（用户设计修正，取代「审批卡裁定直接回流」）：此前用户在审批卡上的允许 / 拒绝直接回流端侧模型——但审批是一次性授权语境，「这次确实要写」的批准学进去会变成以后每次都放行。现在只有两类学习点：① **蒸馏**——端侧只学大模型的判定（云端 AI 分类器结论、语义插件结论，线性向语义看齐，样本标 source=cloud / plugin）；② **分歧裁决**——仅当线性 / 语义 / 云端 AI 的放行结论**不一致**时（不一致的是模型之间），用户的允许 / 拒绝作为裁决信号回流（source=user）。结论一致时用户操作一律不学习；破坏性命令的批准护栏与单命令去重、族迁移、bias 限幅全部保留。
- 新增 **端侧命令分类器**（默认启用）：自动审批档下规则、只读与命令族都没接住的命令，先经内置线性分类器**离线**判定（毫秒级、不联网）——危险概率低于严格度阈值（宽松 0.30 / 标准 0.15 / 严格 0.07）直接放行（来源标「端侧分类器」），达到阈值转人工——若同时开启了远程「AI 分类器」，会把端侧结果（来源 / score / 阈值）注入提示词交大模型二次复核，复核放行即直接执行。模型为字符 n-gram + 结构特征的 int8 量化线性回归（出厂权重 11.8 KB 懒加载，训练管线 `scripts/train-local-classifier.mjs` 入库可复现，硬指标：三档误放率 0、安全命令标准档放行率 ≥ 0.85）。支持**个性化学习**（默认关）：只从端侧审批卡上用户的显式批准 / 拒绝回流样本（秘密打码后存应用数据 `local-classifier/`，环形上限 500），SGD + L2 锚定出厂权重防漂移，可随时重置 / 清空 / 导出；插件也可经 `cadt.registerCommandClassifier` 注册语义级分类器（示例见 `docs/plugins/examples/command-classifier-onnx/`，多分类器保守合并取最高分、连续失败自动熔断）。设置 → AI 助手 → 权限 → 高级配置可关闭 / 调严格度 / 用测试命令即时看 score（不产生审批记录）。
- 改进 **全局搜索分类拆分 + AI 会话搜索入口上移**：三连 Shift 全局搜索的分类拆成独立勾选项——**工作区文件**（默认勾选）与 **AI 会话**（默认不勾，简要 / 详细两档保留），可只搜其中一类（两类都不勾给出明确提示）；AI 会话侧栏顶部的搜索框删除（其面板内搜索逻辑与样式一并移除），搜索入口并入 **AI 面板头部放大镜**（会话标题右侧、【···】左侧）——点击打开全局搜索并**只勾选「AI 会话」分类**直接搜。
- 改进 **定时任务胶囊改为当前会话口径（与计时胶囊一致）**：头部「定时」胶囊只显示 / 统计**绑定当前会话**的启用任务，点开弹层也只列本会话的任务（其他会话与未绑定任务在「自动化」对话框与设置页可见）；胶囊刷新统一走 refreshSchedulesUI——创建 / 编辑 / 启停 / 删除 / 触发执行 / 「自动化」对话框打开全部路径都会同步胶囊显隐与角标（修：任务已存在但胶囊不出现——此前自动化对话框的刷新不更新胶囊）。
- 修复 **gitStateCache 求值早期 TDZ 打断面板初始化**：gitStateCache 在 main.js 模块底部才从 bridgeUI 解构绑定，而面板可能在求值早期自动打开（mock 场景）/ 键盘事件先行到达——全局键处理器与工作区面包屑读它会 ReferenceError，中断 initAIPanel（AI 面板挂载失败）。解构上移至 bridgeUI 创建之后，全局键处理器与面包屑的早期访问按 getGitRepo 先例 try/catch 兜底（按无仓库处理）。
- 改进 **自动化改为设置面板同款模态对话框**：会话侧栏「自动化」按钮改开 `自动化 · 定时任务` 模态（与任务编辑器同一对话框外壳）——任务**按对话分组**（本工作区会话 + 「每次新建会话」，跨工作区/失效会话任务折叠成提示行），每行带**启停 / 编辑 / 删除**全套操作（删除带确认），变化后对话框原位重建；底部「新建任务…」「全部管理（设置）…」「关闭」。
- 修复 **流式占位工具卡疯狂闪烁**：每个流帧（约 80ms）整行 remove + 重建——spinner 动画重启、文件图标 SVG 重建、hover 丢失；改为按调用 key 复用行、原位更新文本（文件名 / 目录 / ±统计 / 接收中体积），仅结构形态变化（path 刚收到 / ±统计刚可算）才重建那一行。
- 修复 **判定 / 系统提示胶囊劫持滚动位置**：showNote 此前无条件滚到底部——上滚阅读历史时一出现「端侧未放行…AI 复核放行」这类判定提示就被强行拉到底；现在仅当原本贴底附近才跟随滚动，已上滚时保持原位。
- 改进 **自动化弹层会话隔离**：任务一览只展示**本工作区**会话绑定的任务与「每次新建会话」任务，组间按会话最近活动排序；绑定到其他工作区或已失效会话的任务折叠成一行提示（设置页全部管理里仍可见），不再混入当前对话的分组。
- 改进 **AI 会话侧栏顶部操作区**：搜索栏下方新增两个整行按钮——**新建会话**与**自动化**；标题栏的【+】随之删除。**自动化**点击弹出任务一览弹层：全部定时任务**按对话分组**（绑定会话的归「会话「标题」」，未绑定的归「每次新建会话」），行显示启用 / 停用徽标与计划描述、点击进编辑器，右上「新建任务…」与空态居中「创建定时任务…」直达创建；打开即拉最新列表，点外部 / Esc / 再点按钮收起。
- 改进 **定时任务头部胶囊与弹层**：与计时器胶囊同机制——应用内存在启用的定时任务时头部亮出「定时」胶囊（数量角标 + 悬浮列出任务名），点击弹出任务列表（启用 / 停用徽标 + 计划描述），行点击直接进编辑器，底部「新建任务…」与「全部管理（设置）…」；无启用任务时隐藏。胶囊随任务增删改、触发执行（once 任务触发后停用）与设置页操作自动刷新，弹层打开即拉最新列表。
- 改进 **计时器按会话隔离（显示与上限）**：头部计时胶囊 / 弹层列表 / 数量角标只显示**当前会话**的计时器（其他会话的照常在跑并到点唤醒自己，只是不在这边显示，切会话即切换视图）；上限改为**会话内同时运行 5 个**（AI 的 start_timer 与手动创建同一条校验）+ **应用内总上限 30 个**（Go 侧把关）——运行中计数，done（到点 / 停止）的计时器已从注册表移除、天然不计入；归属不明（跨窗同步来的）计时器保持可见可停，避免另一窗口关闭后失联。
- 改进 **端侧分类器设置排版重构为「模型位」**：原「启用端侧分类器」总开关拆成两个可独立关闭的模型位——**线性模型**（内置 n-gram 模型 / 关闭，默认内置）与**语义模型**（全部已装（默认）/ 任一已安装的分类器插件 / 关闭，多分类器仍保守合并取最高分）；标题行带**「刷新」**按钮重新扫描插件与注册状态（装完插件不用重启）；两个都关即整体停用；旧配置里关过总开关的自动迁移为「线性模型关闭」。学习状态行同步按当前语义模型选择过滤显示（关闭 / 指定模型未找到都有明确文案）。加载链路加诊断输出：loadPlugins 完成后向调试控制台写 `[plugins]` 源清单 / 分类器注册数 / 错误（排查「分类器未注册」不再盲猜）。三层自愈消灭「装了插件还要手动刷新」：loadPlugins 每次完成广播 `cadt-plugins-loaded`（端侧模型位与状态行原位回填）；打开设置时若注册表空且无加载错误自动补一次重扫（每会话一次防循环）。
- 修复 **AI 分类器复核频繁「输出无法解析」、复核环节形同虚设**：原实现只在输出里抓第一个 `{…}` 片段再 `JSON.parse`，模型带解释、套代码块、把结论写进推理或正文为空时必然失败，然后 fail-closed 转人工——实测一轮里复核几乎全程解析失败。现在改为括号配对扫描取全部顶层对象、从后往前逐个试解析、短答复允许纯文本 allow/ask 兜底（长段落里的 allow 字样不算），失败时把模型实际输出的片段写进判定理由便于排障；提示词同时要求「第一个字符必须是 `{`、不输出解释与代码块」。解析器独立成 `src/ai/ai-classifier-verdict.js` 并配表驱动测试。
- 改进 **审批卡分类器判定区**：取代「端侧分类器转人工：端侧 端侧分类器 score=1.00 ≥ 阈值 0.15（线性模型判定）…」的三连「端侧」拼接文案——端侧判定渲染为**「端侧·线性 / 端侧·语义」标签 + 风险条**（红色填充 = 分数、蓝色刻度 = 阈值位置，超出多少一眼可见）+ 着色分数（≥0.7 红 / 其余黄）+「→ 转人工」；AI 复核理由独占一行（「AI 复核」空心标签），不再与分数信息挤成一句。结构化字段（引擎 / 分数 / 阈值 / 复核理由）随审批对象持久化，旧会话恢复的审批卡回退原拼接文案。
- 改进 **流式工具卡与真实工具卡统一**：参数还在增量接收时的占位行从「写入 xx · 参数接收中 2.7 KB」虚线小行升级为与编辑卡同款的工具调用卡片行（旋转加载图标 + 动词 + 文件类型徽标 + 文件名 / 目录，图标与已应用卡同用图标库 save / rename），`write_file` 实时显示与磁盘旧内容、`edit_file` 实时显示与已接收完整的 old_string 比对的 `+N −M` 行数随流刷新（基线每条调用异步取一次、内容增量 <256B 复用上次结果防大文件频繁跑 diff，换轮自动清缓存），行尾标「接收中 x KB」。
- 改进 **生成中的发送按钮**：AI 运行中若输入区已有内容（文字 / 图片），右下角保持「发送」图标——点击排队发送、**Ctrl+点击 插话**（停止当前回复并立即发送该条，与 Ctrl+Enter 同路）；输入区清空才切回「停止」。提示文案同步标注两种点击行为。
- 改进 **AI 面板底部区域视觉**：任务清单 / 输入区 / 统计行所在的底部堆叠区整块铺与面板同色的底——消息滚动经过时被干净盖住（dsh 式无边界遮挡，不加分割线），不再透过半透明输入区与统计行空隙隐约显示；输入框去掉半透明底 / 阴影 / 毛玻璃只留描边、任务清单保留卡片形态（边框 / 底 / 圆角），同铺在一条不悬浮的底栏上。
- 改进 **端侧分类器个性化学习按命令族迁移**：此前一次批准只压低「这一条命令」的分数，换个参数就回到原点（实测同一语义 `git push --dry-run origin master` 同文本 0.98→0.67，但换成 `gitee master` 变体仍是 0.99）。现在族归一命中时对命令族特征额外重放 3 次——实测同族变体 0.985→0.858（只学原文为 0.945），异族命令几乎不动；族归一仅对 git / npm / pnpm / go / cargo / dotnet / gh / docker 等白名单命令生效，危险动词、破坏性开关、解释器、复合语法与重定向一律不做，避免「批准一次 rm 变体」把整个 rm 族压成安全。
- 安全：**解释器内联代码现在走危险规则做单次确认**——`node -e` / `python -c` / `bash -c` / `powershell -Command` / `deno eval` / `php -r` 等。这类命令把代码当参数传入，绕过了 argv 级的只读与危险分析（`bash -c "rm -rf /"` 在分段里看不到 `rm`），而端侧线性模型对它们给分极低（实测 `node -e` 在 0.03–0.06，低于 0.15 阈值直接放行）。现在一律单次确认、不经分类器、不长期放行；`cmd /c` 刻意不列入（工具链常用来包一层单命令，误伤大于收益），`node script.js` / `bash -x build.sh` / `php -S …` 等「解释器 + 脚本文件」形态不受影响。
- 新增 **公开语料 eval 工具**（`scripts/eval-public-corpus.mjs`，只评不训）：用 SEA 真实用户命令、Cowrie 蜜罐攻击者输入、malbash 恶意脚本三类公开语料对照评估端侧分类器——蜜罐真实攻击流量中位 score 1.0、破坏性子集三档 100% 拦截；eval 反哺两处语料修正（`2>/dev/null` 惯用法扰动、安全/中性/受害者文件词表分离）并把金丝雀清单固化进训练门槛。
- 新增插件市场首个**语义分类器插件**（[command-classifier-onnx](https://gitee.com/cadt-datalens-plugins/command-classifier-onnx)）：MiniLM int8 ONNX（22MB，仓库直带）+ 逻辑回归头，`registerCommandClassifier` 注册进自动审批链与内置线性分类器保守合并取最高分；推理在 blob Worker 内 onnxruntime-web 离线执行（实测 47–92ms/条），加载失败自动回退词表打分。
- 修复端侧分类器状态行**误报「语义模型未安装」**：插件已安装但入口 JS 加载失败（如语法错误）时，注册表为空、状态行分不清两种情况——现在 plugins.js 记录最近一次加载错误，状态行如实显示「插件加载失败：<原因>」（原因里的具体语法错误来自该插件 v0.2.0 的真实事故：await 写进了非 async 的 Promise executor）。
- 新增 **计时工具**（`start_timer` / `stop_timer`）：AI 可启动倒计时 / 正计时（最多同时 5 个、单个上限 24 小时）。倒计时在 Go 后端计时（窗口最小化不漂移），到点自动以系统消息注入启动它的会话并唤醒新一轮——适合「等待构建/安装/下载」这类不知道多久的事，AI 不再用 sleep 命令或反复轮询空等。计时器不跨应用重启，更长的等待请用定时任务（schedule_create）。
- 计时器 UI 改为 **单胶囊 + 弹层**：头部只挂一枚「计时」胶囊（数量角标 + 最快到点倒计时走秒），无计时器时不显示；点击弹出全部计时器列表，行点击进入**详情**（目的 / 模式 / 实时读数 / 起止时刻 / id + 停止按钮），行尾【x】直接停止——不再一排平铺胶囊、一点就停。消息框「+」→ 计时器可手动创建倒计时 / 正计时（与 AI 工具同一条 Go 侧链路）。
- 修复 **倒计时到点唤不醒 AI 且完全静默**：`wakeSessionByTimer` 引用了不存在的 `getSessions` 标识符（域模块拆出时漏注入），异常又被空 catch 吞掉——到点后胶囊消失但什么也不发生；现改用面板自身会话列表并让唤醒失败可见（flash 提示）。
- `start_timer` 返回值补上 **计时器 id**：多计时器并存时 AI 可以按 id 精确 `stop_timer`（此前返回只有文案，「有多个计时器请指定 id」实际无处可取）。
- 工具调用改为 **流式亮卡**：模型还在增量输出参数时就先渲染一张「接收中」占位卡（写文件显示目标路径与已接收体积，随流更新）——写大文件时对话不再像卡住、完成后突然蹦出一张 ±xxx 的写卡；整轮结束后由真实工具卡接替。
- 任务提醒 **上限口径统一**：5 条上限只数未完成条目（标记 done 即释放名额），徽标 / 弹层计数 / 报错文案三处口径一致，报错建议的「标 done 后再添加」路径真实可用；已完成条目保留作历史（只留最近 5 条），不挤占名额。铃铛入口同样按需显示——**无未完成条目时隐藏**，创建走消息框「+」→ 任务提醒（与 AI 的 reminder_add 同一条写入路径）。
- AI 回答里的 **```mermaid 围栏现在会渲染成图**（此前占位无人渲染，图在对话里直接消失）；预览 / 分屏下切换主题时图表同步换配色；`night` 主题的图表落到深色配色。
- 新增 **任务提醒**（`reminder_add` / `list` / `update` / `remove`）：每个会话可维护提醒清单「标题 + 简述」，防止上下文过长遗漏事情；每轮对话开始以 `<task_reminders>` 注入给模型；面板标题栏新增铃铛弹层，用户可手动增删/完成。
- 新增 **会话历史查询工具**（`session_history`）：上下文压缩后早期消息不再可见，AI 可按关键词 / 序号分页查回磁盘上的原始会话消息（含已压缩归档的内容），带条数与输出体积硬预算。
- 设置 → AI 助手新增 **「新会话默认读写权限」**（只读访问 / 每次询问 / 自动审批 / 完全权限）：仅对新建会话生效，历史会话保持各自档位，默认值维持「每次询问」。
- 新增 **工作日志**（可选，默认开启）：AI 完成任务/修复问题/做出关键决定后，通过 `write_worklog` 工具向工作区 `.cadt/logs/` 追加一条工作日志——三层结构（根 `INDEX.md` 每月一行 → `{YYYY}/{MM}/INDEX.md` 每条一行 → 当日文件正文），只记标题 + 一句话摘要，不存正文与敏感信息；日志文件仅可经该工具追加，自动审批档下直接放行。
- 全局搜索支持 **未归档 AI 会话**：勾选「搜索 AI 会话」才参与检索，分「详细（全部消息全文）/ 简要（用户消息 + 每轮最后一条 assistant 消息）」两档；带结果条数、扫描字节与墙钟硬预算，结果可跳转进会话并定位到消息。
- 修复 **「打开对话日志目录」误开文档文件夹**：explorer.exe 把正斜杠路径的段当命令行开关解析，失败时静默回退到「文档」；现在统一归一成 Windows 原生分隔符再传入。
- 修复 **会话回合折叠条错标「未完成」**：回合中途注入的用户消息（如截图自动附加）被当成新回合边界，把一个回合切成多组、以工具结尾的中间组被误标「未完成」；现在中途注入并入当前回合。
- 修复 **悬浮窗关不掉留空壳**：浮窗关闭走的 `Quit` 会被 `OnBeforeClose` 拦截（有未保存修改或 AI 进行中时），而收起态又把确认框藏了；现在浮窗自行判定——空闲直接退出，有进行中回合先弹面板内确认。
- 删除状态栏 **「已修改 <文件>」**徽标（写入结果在工具卡与变更记录里已有呈现）。
- 会话消息区 **滚动条贴满全高**（原来上下 padding 让轨道露出空隙）；消息区进一步改为 **占满面板可视高度**——上下文警告条 / 任务清单 / 输入区 / 统计行整体浮于消息区底部（原先是纵向占位把滚动条截断在输入区上沿），消息内容按堆叠区实际高度预留 padding（打字增行、清单显隐实时跟随），滚动条轨道从头部下方一直贴到面板底边；**超长用户消息默认折叠**（超过 12 行 / 800 字符，可展开全文复制）；任务列表收起时在展开图标左侧小字显示当前进行中任务（可选，默认开）；**「甜澄漫游中...」文案随工作状态与时间轮换**；切换会话保存各自输入框草稿、切回恢复（顺带修了草稿恢复必抛 TypeError 的隐藏 bug）；修复 **重复的「新会话」空会话**（主窗口与悬浮窗各自创建占位，现在复用/去重）。

- **子代理轮次预算用尽改为强制收尾一轮**：撞轮次/消息上限不再直接返回「按当前探索结果收尾」占位符（探索成果全部丢弃），而是带「立即输出最终结论」指令、不带工具重入一轮，主代理拿到真正的结论；收尾请求自身失败时回退为探索记录摘录，任何情况下不让子代理空手而归。预算按重型只读探索/规划的真实体量放宽：轮次钳制 3–15 → **3–200**（默认 15 → 50）、消息上限 60 → **400**（主对话无逐轮硬上限、靠 auto-compact，子代理硬上限此前过紧）；工具描述去掉「轻量调查建议 5」引导（主代理会照抄小值导致预算过紧）。
- 修复**子代理多轮必 400**：deepseek 思考模型的网关逐条校验 `reasoning_content`（工具轮与「assistant 末条续写」形态下缺失即 400，空串也必须带字段），此前按「非空才回传」处理，模型某轮没输出思考就直接 400；同时子代理回合结束没把 `tool_calls` 写回消息，下一轮请求会把 tool 结果整条丢出历史、并落进触发校验的形态。现在 Go 侧按模型名门控无条件回传字段（空串也带），子代理与主代理一样写回 `tool_calls`；非 2xx 时把完整请求体转储到应用数据 `logs/ai-last-4xx-request-*.json`、错误信息带网关原文，载荷校验类问题可直接用真实载荷定位。
- 新增 **write_file 陈旧缓冲防护**（并发会话覆盖丢码防线）：AI 会话用 `write_file` 整体覆盖已存在的文件前，会校验本会话是否读过该文件、以及读取后磁盘是否又被修改（会话级读取指纹 + Go `SaveFileChecked` 落盘校验双保险）——本会话没读过的文件、或读取后已被其他会话 / 外部程序改动的文件会被拒绝写入并提示先 `read_file` 重读（局部修改建议改用 `edit_file`），不再静默覆盖他人改动。新建文件与内部流（记忆写入等）不受影响。

- 修复**右键菜单「粘贴」贴不进图片**：菜单点击不会产生 `paste` 事件，原来只回读剪贴板文本，剪贴板里是截图时点「粘贴」毫无反应（`Ctrl+V` 正常）。现在剪贴板里没有文本时会请后端回读系统剪贴板位图（优先注册格式 `PNG`，回退 `CF_DIB`，纯 Win32 + 标准库解码，不引入依赖），再走与 `Ctrl+V` 相同的压缩 / 数量与体积上限 / 落盘管线。
- 修复**工具执行成功、重启后却显示「应用在这个工具执行期间关闭或重启」**：会话日志是追加式的，工具消息先以 `running` 落盘，执行完成后只就地改内存状态；追加式日志按 `_mid` 比对公共前缀，认为「没变化」，磁盘上永远停在 `running`，重启重放时被当成未收到结果收尾（截图、写文件其实早已完成）。现在给每条已落盘消息记一份轻量指纹（状态、审批对象、提问、子代理、后台作业、内容长度等），持久化时指纹不符就从该消息处截断重写，工具结果、审批裁定等就地改写都能落盘。
- 修复**正看着的会话条目挂绿点**：面板开着且就是当前会话时，上一轮结束（或磁盘重读把别处写入的未读标记带回来）会在条目上留一个「已完成未查看」绿点，接着发消息也不消失，非得重新点一次该会话。现在查看中的会话不显示未读标记，发消息 / 开始新一轮 / 磁盘重读都会把未读压掉，运行中的转圈图标不会再被绿点顶掉。

- 新增内置技能 **`cadt-file-layout`**（文件目录规范）：统一约束 AI 产物的落盘位置——用户要的正式文件按项目既有结构放，AI 自己产生的中间产物收进工作区 `.cadt/`（`memory/` 记忆、`skills/` 技能、`answers/` HTML 回答页、`patches/` 补丁），应用数据目录与 `.git/` 等列为只读禁区；另含脚本规范（一次性脚本优先不落盘、用完即删，编码与依赖约定，不得用脚本绕过审批）、命名约定、可删除 / 可重建清单与权限降级规则。随 exe 分发到所有工作区，技能管理里显示为「内置」（rank 600，可被工作区同名技能覆盖）。

- 修复**切换会话后输入框状态串会话**：某个会话在生成时切到另一个空闲会话，输入框仍显示「停止」按钮、回车也只会进排队（这是把「正在生成」当成全局单例的结果）。现在每条流按会话独立登记（`streams`），composer 的「发送 / 停止」、占位文案、排队与插话、消息列表的「生成中」标记、编辑重发 / 重新生成等操作全部只看**当前查看会话自己的流**；后台会话继续生成、结束时报未读，互不打断。同一次停止只取消本会话的待审批 / 待回答，不再连坐其他会话。

- 修复**后台终端标签页出现两个输出框**：`.bgterm-pane` 直接写了 `display:flex`，与 `.jsoneditor-pane { display:none }` 同权重又定义在后，把「非激活标签页隐藏」这条规则顶掉了——只要开过两个后台作业标签，另一个不可见的面板其实一直铺在原位（它按 34% 的上下比例排版，输出框比当前标签更长），看起来就像多出一个输出框。现在布局改为挂在 `.jsoneditor-pane.active.bgterm-pane` 上：只有激活的标签用 flex 上下分栏，其余标签照旧隐藏。同时后台终端 / 内置浏览器的视图改为按 `doc.pane` 判断是否已建过（它们没有 `doc.editor`），反复点击同一作业的「在标签页打开」不再重复建面板。

- 修复**AI 面板输出时把内容区 / 标签页的右键菜单关掉**：右键菜单原本「任何滚动都关闭」，用来防止菜单和锚点脱节，但文档级捕获监听连 AI 面板流式输出的自动滚动（`scrollTop = scrollHeight`）也算进去了，于是模型一边吐字、菜单一边消失。现在打开菜单时记住锚点（`pointerdown` / `contextmenu` 的目标，也支持显式 `anchor`），只有滚动的是**锚点所在的那个滚动容器**（或整页滚动）才关闭；AI 面板、侧边栏、另一个编辑器分组的滚动不再影响它。菜单自己在面板内打开的 `ignoreScrollWithin` 语义保持不变。

- 每轮回答的操作行补齐三项收尾信息：**在新对话中分支**（把当前轮及之前的历史复制成一条新会话再切过去，原会话不动）、**本轮用量**（`用量 2.5M tok` 徽标，点开是浮层明细：提供方 / 模型、缓存命中率、未缓存输入、缓存读取、缓存写入、输出）、**本轮耗时**（`00:34`）。用量数据沿用每轮 `usage`，新增 Anthropic 的 `cache_creation_input_tokens` → `cacheWriteTokens` 字段，「缓存写入」不再恒为 0；原来回答下方那行「tokens：输入…输出…合计…」并入徽标，设置 → AI 助手 →「显示 Token 用量」现在默认开启（曾经手动关掉的保持关闭）。

- 补齐**补丁审批卡**的样式与详情入口：多文件列表改为带边框的清单（路径用等宽字体、`+N` 绿 / `−N` 红、新建 / 删除标签、可应用 / 冲突徽标、失败原因缩进到对应行下方），头部补上文件数统计与临时收起按钮，底部「查看详情」直接在新标签页打开该 `.patch` 的补丁视图（逐文件状态、逐行 diff、应用后可撤销）；已裁决的工具卡也保留「在补丁视图中查看 / 撤销」入口。

- **结构面板支持「会话结构」**：面板不再只认文件——内容区只有文件时显示文件结构；只有 AI 助手时（全屏，或停靠且没打开文件、AI 占满内容区）自动显示当前会话结构，即按轮列出的用户消息定位条（轮次序号 + 单行预览 + 时间，点一下跳到那条消息并闪一下，滚动时高亮当前所处的一轮）；两者同时存在时默认文件结构，面板标题旁的图标可在文件结构 / 会话结构之间切换，选择记进设置。会话结构下自动隐藏复制导出与全部折叠，标题变为「会话结构」，刷新按钮重新向面板取一次快照。

- 修复**多会话并发生成时的其他串台**（按会话隔离审计，与上一条同源）：① 后台会话的**上下文压缩**不再把当前会话的输入框变成「停止 / 压缩中」，也不会拦截当前会话发送；压缩完成/失败提示只在被压缩的会话里出现（后台完成改用桌面通知）；② **系统提示词缓存与占用估算改为按会话**，A 的工作区/附件上下文不再拿去估 B 的 token（原先「估算任务在飞」时切会话会直接复用 A 的结果）；③ **输入框文字与附件按会话保存草稿**——在 A 粘的图片、写了一半的话切到 B 不会再带过去，也不会被排队消息覆盖；④ **插话标记**按会话记，A 的「插话」不会让 B 收尾时误冲刷队列；⑤ **自动标题**在同一时间只跑一个的前提下排队补做，两个会话同时收尾都能拿到标题；⑥ 后台会话的分类器 / 工具轮次提示、文件改动汇总卡的折叠状态、编辑重发索引全部绑定到会话，不再串台。

- **模型选择改为会话级**（对齐 dsh 的 `model/selection` 投影语义）：每个会话记住自己的账号 + 模型条目（`session.profileId` / `session.modelId`，随会话 meta 落盘），切会话时模型胶囊、上下文占用、自动压缩阈值都按该会话的模型算；没选过的会话沿用窗口默认（`config.active*`），手动切换同时更新「本会话」与「新会话的默认」。发送时把当时用的模型固定到该会话，子代理继承发起它的会话的模型，自动标题 / 上下文压缩 / 自动审批分类器（未指定专用模型时）也跟着各自会话走。

- **头部两个入口与写入徽标改为按会话**（对齐 dsh 的 jobs / agent-team 面板「本会话」语义）：智能体团队与后台终端只列当前会话的子代理与后台命令，角标数字同样只算本会话；子代理里派出的任务归到根会话名下；切会话时弹层自动收起。会话列表的「运行中」标记额外覆盖「本轮已结束但后台命令还在跑」的会话。状态栏写入徽标（待确认 / 写入中 / 已修改 +N −M）只显示当前查看会话的写入，后台会话的写入不再闪到正在看的对话上，切回该会话时按 5 秒时效回放它自己的状态。

- **自动审批分类器改为串行队列**：同一时间只跑一个分类请求（避免并发打爆接口 / 触发限流），后来的请求按先来后到排队，不再直接返回「分类器正忙」把决定甩回人工；同一条命令（cwd + 命令）的重复请求合并为一次模型调用，结果缓存 10 分钟；用户点「停止」会撤销该会话排队中与在飞的分类请求（不写缓存），命令直接转人工确认。

- 修复**后台终端作业卡片状态不更新**：作业结束后工具卡仍显示「后台运行中…」，即使 `check_command` / `stop_command` 已经返回退出码。根因是收尾逻辑 `bgLiveFinish` 只查实时输出缓存 `bgJobLive`，而该缓存仅在收到首行输出时创建——完全没有输出的作业（如 `sleep 2; exit 0`）从启动到结束都没有条目，收尾被直接跳过；现改为退回启动时就已登记的 `bgJobIndex` 取消息对象，并把退出码统一换算成数字后再判定「已停止 / 已结束」。「后台终端」入口弹层打开时还会向后端对账一次运行中作业的真实状态（不推进 `check_command` 的增量游标），错过的结束事件与被重启清理的作业都会收敛为结束状态，不再永久转圈；头部「终端」chip 角标同步收敛。

- 应用操作（app_control）的 `screenshot` 新增 `area` 参数：`full`（默认整窗）/ `editor`（编辑区）/ `sidebar`（侧边栏）/ `ai`（AI 面板）/ `terminal`（终端）/ `patch`（当前补丁视图）/ `statusbar`（状态栏）。区域截图按 DOM 位置换算成物理像素后由后端裁剪，高分屏与窗口缩放自动适配；板块未打开或不可见时给出明确提示。cadt-ui 动作表与工具描述同步。
- 底部状态栏新增 **AI 写入徽标**：AI 写文件（含补丁应用）时依次显示「待确认 → 写入中 → 已修改」，并带文件名与本轮累计 `+N −M`，写完 5 秒自动隐藏；补丁为多文件动作，按计划/实际应用量合计显示；被项目权限规则拦下、或写盘失败时单独标出。只在写操作发生的那一刻刷新，不轮询磁盘，因此外部编辑器或 Git 的改动不会点亮它。
- 悬浮 AI 窗口的「收起」改为收成标题栏高度（隐藏面板内容，再点展开恢复原尺寸），不再最小化到任务栏；「全屏」继续切换当前独立窗口全屏。
- 修复 AI 面板「换到左侧」后排到文件树侧边栏左边的问题：文件树始终固定在最左，面板停靠在侧边栏与内容区之间。
- 修复每轮「已编辑 N 个文件」汇总卡的两个问题：卡片原本 `margin-left:auto` 靠右收缩（与回答正文不在同一列），现在铺满消息宽度、左对齐；卡片也不再被套两层 `.ai-msg`，当轮与重放后的位置完全一致。
- 修复汇总卡「重新打开对话就没了」：本轮改动的切分从「比较时间戳」改为「轮开始时的记录快照」（时钟回拨、审批耗时长都不会再漏掉整轮），渲染处也不再要求卡片必须是组内最后一项；打开面板触发的磁盘重读，当前会话在内存里比磁盘更全时保留内存版本并补写磁盘，不再被旧内容覆盖。

- 新增工具 **`propose_patch`**：把改动写成标准 unified diff 落盘并弹出补丁审批卡，点「应用」才写文件；「完全权限」档下不会主动出补丁（除非用户明确要求）。
- 新增内置技能 **`patch-workflow`**：何时用补丁 / 何时直写、diff 写法与自检清单、失败后的最小修复与重试纪律。
- 补丁失败以 `【patch:error】` 工具结果回给模型（附期望/实际/建议），不中断对话；同一补丁连续失败 3 次自动熔断转人工。应用完成回 `【patch:result】`，模型据此汇报「已应用 N 个 / 跳过 M 个」。
- 新增 `/patch`（把改动做成补丁）与 `/diff`（只看差异不写文件）两个斜杠命令。

### 命令行

- 新增 `--check-patch`（只检查，不写）、`--apply-patch`（加 `--yes` 才写入，可配 `--partial`、`--only`、`--dir`）、`--revert-patch`；支持 `--json` 输出，退出码 0/1/2/3/4/5 区分成功、有文件未应用、参数错误、内部错误、缺少 `--yes`、回滚失败。补丁命令行不启动窗口、不依赖 AI。

### 文件面板

- 文件列表（扁平视图）改为 **递归扫描子目录**：打开了工作区就扫工作区下所有文件（含嵌套），只开单个文件时扫其所在目录及子文件夹——目录数 / 深度 / 条目数硬上限防大仓库拖垮界面，超出在列表尾部给截断提示（可用上方过滤缩小范围），替代旧版「超 200 个文件只能切文件树」。
- 修复文件列表 **无限刷新、滚动条被重置、视图闪烁**：文件事件改为差量刷新（内容没变不重渲染、静默刷新保持滚动位置），`.git` / `node_modules` 等黑名单目录的写入事件不再触发整表刷新。
- **LICENSE / NOTICE / COPYING** 等仓库元信息约定名文件可直接从文件树打开并获专用「§」图标、按代码视图呈现；`.npmrc` / `.gitconfig` 用 ini 高亮、`.npmignore` 用 gitignore 高亮。

### 编辑器与窗口

- 新增 **「我的浏览器」持久会话**（文件菜单 / 命令面板）：内置浏览器此前每个标签页一个独立 user data 目录（隔离其实来自**实例 id**——`BrowserSessions/<id>_<profileKey>`），新开即空白、cookie 与登录态都不保留。现在多一个固定实例 id 的 `browser-user` 标签，目录固定为 `BrowserSessions/browser-user_user`，关掉标签再开、重启应用后登录态都还在；同一时刻只允许一个实例（WebView2 规定同一个 user data folder 不能被两个 environment 共用，而本实现每个实例各自建一个 environment），已开着就直接切过去、带地址时顺带导航。新建标签页 / 活动栏图标 / `Ctrl+Alt+B` 仍是隔离会话，语义不变；个人浏览器关掉后立刻重开补一次 0.8s 重试（上一个浏览器进程可能还没退干净）。**未做**：隔离标签的 profile 目录不回收（会越攒越多，可加启动期清理）、多标签共享同一 profile 需要把宿主改成「每 profile 一个 environment + 多 controller」。
- 新增 **手动新建浏览器标签页**：此前只有「标签页右键 / AI 工具」能开出来，用户没有直接入口。现在三个入口共用同一条链路（`openBrowserTab('about:blank')`）——左侧活动栏新增地球图标（在搜索图标下方，点一次开一个标签页）、快捷键 **Ctrl+Alt+B**、文件菜单「新建浏览器标签页」（命令面板由菜单项自动派生，因此也一并收录）；设置 → 快捷键的「文件」组补上该键位。无内嵌浏览器支持的环境（纯浏览器调试）会照旧提示「当前环境不支持内嵌浏览器」。

- 修复 **内置浏览器内容区黑屏、点一下才出来（z 序自愈其实没生效）**：250ms 兜底的 `BrowserEnsureZ` 用 `GetWindow(GW_HWNDNEXT)` 找「上方兄弟」，但这个方向是往 **z 序下方** 走——控件被主 WebView 压到最底时第一跳就返回 0，被当成「已在最顶」直接 return，自愈一次都没提过顶（改用 `GW_HWNDPREV`，新增回归测试 `TestBrowserEnsureZRaisesCoveredControl`，把方向改回 NEXT 会立刻失败）。顺带修 **同步失败不可重试**：前端把 `browserApplied` 记在调用**之前**，`BrowserSetBounds` / `BrowserSetVisible` 一旦失败（宿主忙、看门狗超时）状态却已记为「已应用」，此后每轮轮询都走「状态没变」分支，原生控件再也不显示——只有点一下触发新矩形才恢复；现在失败会撤回该状态，下一轮轮询自动重试。

- 新增 **编辑区收起**：标题栏「运行」与 AI 入口之间的收起按钮（或视图菜单「收起编辑区」）可把编辑区位置整个让给 AI 助手——标签页保留不关闭，收起态按钮高亮、AI 面板关闭后编辑区自动还原。
- 修复 **任务清单收起态样式**：无进行中任务（或小字开关关闭）时图标不再挤在文字后面——统计与图标始终两端对齐，进行中任务小字贴右侧图标、过长按比例截断；修复分屏视图下切换主题不重绘预览（含 mermaid 图表配色）。
- 「关于」页顶部横幅配图改为 **随系统时间切换**：白天（6–18 点）用 light 版、夜间用 dark 版，不再跟随应用主题（打开设置 / 换肤 / 启动时刷新）。
- 修复 **Mermaid 图表渲染空白（无任何报错）**：DOMPurify 3.4.x 会整体丢弃属性值含换行的属性（mXSS 加固），mermaid 源码必含换行，占位符的 `data-src` 每次都被静默剥掉、渲染永远轮空；现在图表源码以 base64 存进占位、渲染时解码，中文标签图表实测通过。
- 修复 **AI 审阅 / Git 差异虚拟文档打不开结构化补丁视图**（「PATCH_BACKEND: 缺少补丁文件路径」）：这类 `.diff` 文档 path 为空、内容即补丁文本，此前被硬路由到按文件路径预览；现在补丁后端新增文本预览通道（不落盘、不写索引，重预检走计划内缓存原文），多段拼接 diff 之间夹的标题/说明行也能正确解析。
- 新增 **标题栏运行按钮**：从侧边活动栏移入标题栏，与「编辑区收起」「AI 助手」依次排列（运行在最左），禁用态与提示随文件切换实时同步；代码视图的编辑区右键菜单新增「运行」。
- **会话进行中关闭窗口出现二次确认**（「中断并关闭」）；关闭确认事件改为携带原因（未保存修改 / AI 进行中），提示文案按原因组合。
- 活动条 Git 图标与 AI 图标之间加了一条短分隔线。

### 外观

- **Harness 主题按 deepseek-harness 源码重做**：旧实现只借了 dsh 的「白底 + 灰侧栏」轮廓，强调色是自己调的紫蓝 `#4d6bfe`，语法高亮又是从 Github 主题抄来的红色关键字，混在一起偏紫、和 dsh 对不上。现在 token 全部照 `packages/client/ui-theme/src/styles/design-platform.css` 的 static 调色板与 alias 语义层映射：内容白 `#ffffff`、侧栏 `neutral-bluish-50`、次级面 `neutral-bluish-60`、分隔线 `rgba(0,0,0,.1)`、正文 `#0f1115`、次要文字 `#81858c`、强调用 deepseek 蓝 `#4176e6`、悬停/选中用 `rgba(38,49,72,.06/.1)`、状态色取 `state-*` 与 `file-diff-*`；代码高亮改用同目录 `shiki.css` 的 token 表（关键字 `#d6336c`、字符串 `#2f9e44`、注释 `#868e96`、函数 `#6741d9`…）。同时按 dsh 的组件观感补了三处细节：主按钮（发送、对话框主操作）改成 `brand-primary` 近黑、用户气泡改成扁平 `deepseek-50 #edf3fe` 无边框胶囊、输入框纯白 + `lg` 圆角——之前整屏发紫正是气泡和按钮都在吃 `accent`。

### 界面

- **设置页全面改为行式布局**：左侧导航 + 右侧「分组卡片」重构全部 19 个设置页——每项设置为「标题 + 一句话说明 + 右侧控件」的行，开关统一为现代 switch 形态（逻辑不变），长提示收敛进 ⓘ 说明气泡（悬浮 / 键盘聚焦 / 点击展开），不再有大段说明文字铺在页面上；设置搜索同步覆盖新行结构与气泡内容。

- 修复 Ace 编辑器在启动、打开/切换文件时刷出大量 i18n 警告（`text-input.aria-label`、`gutter.code-folding.*` 等）：只读提示的 `setMessages` 现在会合并 Ace 默认英文消息表，不再整表替换导致其余键逐个回退。
- 文件树与标签页为 `.patch` / `.diff` 文件新增专用图标（加/减改动行），不再回退成通用文本图标。
- 新增 `.php` / `.rs` / `.cpp` / `.cs` / `Dockerfile` / `Makefile` / `CMakeLists.txt` 等类型的文件图标（vscode-icons / material-icon-theme，MIT）。
- 修复文件图标串色：内联 SVG 的渐变 id 在多个图标间重名，`url(#a)` 会命中先渲染图标的渐变（例如 Python 图标被前面 `.ps1` 图标的蓝色渐变染成纯蓝）；现在每个图标实例使用独立 id。

### 运行代码

- 新增 **运行代码**：`F5` 把当前文件交给本机已检测到的解释器 / 编译器执行，输出显示在底部「运行」面板，带退出码与耗时。
- 支持 Python、Node.js、TypeScript（Node 22.6+ 原生类型剥离）、Go、Java（JDK 11+ 单文件源码启动）、PHP、Ruby、Lua、Shell / Batch / PowerShell；C / C++ / Rust 先编译到临时目录再运行，编译失败停在编译输出，不进入运行。
- 运行环境复用「设置 → 编程语言」里扫描并选中的解释器 / 编译器，无需二次配置；从未扫描过时按需扫一次。
- 工作目录默认取**文件所在目录**（脚本可直接读旁边的数据文件），可在 设置 → 运行 改为工作区根。
- 有未保存修改时弹窗选择「保存并运行 / 临时副本运行 / 取消」，可勾选记住选择；临时副本不修改磁盘文件，但同目录依赖（import / require / 相对路径）不可用。
- 运行面板顶部可填**运行参数**（空格分隔、支持引号与转义，回车直接运行）；按语言记住并在切换运行标签时回显，参数只传给程序、不进入编译命令。脚本类（Shell / Batch / PowerShell）同样接收参数。
- 输出面板：`stderr` 单独标色、ANSI 基础色跟随主题、编译器报错与 Python traceback 里的 `路径:行:列` 可点击直接跳到源码位置；单次输出上限 8 MB，超过后插入截断提示。
- 中文 Windows 下 gcc / pip 的 GBK 输出自动转码，不再出现乱码。
- `Shift+F5` 停止（`taskkill /F /T` 连整棵进程树一起终止），`Alt+F11` 打开运行面板；最多 3 个任务并存，面板按标签切换，关标签即清理临时目录。
- 首次运行某种语言时提示「以用户的权限在本机执行代码」，确认后不再重复；只读模式下不执行。活动栏 ▶ 与工具菜单会随当前文件类型 / 只读状态同步灰显。
- 临时目录放在 `%APPDATA%\CandySweet\CaDt-DataLens\run\`，超过 7 天的自动清理；设置 → 运行 里可直接打开。
- 每次运行记入操作留痕（文件名、语言、退出码、耗时，不记输出正文）。

### 运行代码 · V2 / V3

- **标准输入**：运行中的任务在面板出现 stdin 输入条，可逐行发送、点 `EOF` 关闭输入端让按行读到结尾的程序正常退出；后端用带缓冲队列写管道，程序不读 stdin 也不会阻塞界面或拖住 `cmd.Wait()`。
- **命令模板覆盖**：设置 → 运行 可按语言写完整命令行，支持 `$TOOL` / `$FILE` / `$DIR` / `$BASE` / `$STEM` / `$EXT` / `$OUT` / `$ARGS`；先拆 argv 再逐项替换，路径含空格不会被切开，全程不经 shell。编译型的编译步骤仍用默认配方。
- **验证运行环境**：设置 → 运行 可挑一种语言跑最小自检脚本（只打印一行固定标记，落在临时目录、不改用户文件、忽略用户模板），结果直接给「自检通过 / 未通过」结论。
- **命名运行配置**：把当前参数、语言与命令模板存成多套预设，设置页可增删，运行面板顶部下拉一键载入。
- **发给 AI 分析**：输出面板新增按钮，把尾部 200 行（上限 12000 字符）连同文件名 / 语言 / 退出码填进 AI 输入框，**不自动发送**、不触发模型调用。
- **项目感知运行（`Ctrl+F5`）**：从当前文件 / 工作区向上最多 8 层探测 `package.json` / `go.mod` / `Cargo.toml` / `pyproject.toml` / `Makefile`，遇到 `.git` 或用户主目录停止（避免误命中主目录里的 `package.json`）；候选命令（`npm start` / `npm run dev` / `go run .` / `cargo run` / `python main.py` / `make`）在面板里列出，**每次都要点「执行」确认**，以项目根为工作目录，不安装依赖也不改项目文件。
- 新增 `docs/samples/run-code/`：14 种语言的 hello 脚本、cwd / 参数 / stdin / traceback / 编译报错跳转 / GBK / ANSI / 8 MB 截断 / 停止等场景用例，以及 node / go / rust / python / make 五个可探测的小项目；目录内 `README.md` 逐项对应 §11 的 20 条验收清单。

### 修复

- 修复多窗口同时写操作记录 / AI 会话时偶发「操作记录正被其他窗口写入：Access is denied」：Windows 侧文件锁只对 `LockFileEx` 做了等待重试，抢建锁文件阶段的 `CreateFile` 一旦撞上瞬时竞态（`ERROR_ACCESS_DENIED` / `ERROR_SHARING_VIOLATION`）就直接报错。现在两步都在同一条重试链里等到超时，并补了并发加锁的回归测试（同一时刻只有一个持有者）。

### 内部结构（docs/finished-plans/structure-cleanup.md 实施记录）

- **main.js 单体拆分**：21,188 行 → 7,447 行（-65%），组合根（标签页核心、命令面板、菜单注册表、初始化接线）保留在 `main.js`，其余按域拆成独立模块——`cursor-themes`（系统光标）、`terminal-ui`（内置终端与底部面板）、`bridge-ui`（进程桥/虚拟文档/浏览器标签/git 面板）、`settings-ui`（设置/主题/对话框/字数统计/留痕接线）、`writing-ui`（写作模式 + 格式渲染 + 语言定义）、`editor-groups`（编辑器组/分栏/标签/各预览视图，5,125 行）、`titlebar-popovers`（项目选择 + Git 分支弹层）、`menu-bar`（IDEA 式菜单条）、`mode-switch`（模式切换外壳）、`activity-pane`（设置页操作记录）、`properties-ui`（属性对话框）、`session-restore`（会话持久化）、`app-actions`（退出/最近打开/拖放复制）、`app-links`（外链/内置文档）、`update-check`（更新检查）、`format-convert`（格式互转）、`find-bar`（查找替换）、`global-search`（工作区搜索）、`json-query`（JSONPath）、`diff-dialog`（双文件对比）、`schema-panel`（Schema 校验）、`quick-switch`（快速切换器）。拆分采用「factory + 显式依赖注入」：依赖一律经 `deps` 延迟求值（调用方传 getter），不依赖声明顺序、不拍 let 快照；函数体原样搬移。每批拆分后 `npm test`（161 项）与 `npm run build` 验证通过。
- **AI 面板常量外移**：`ai-panel.js` 闭包前的 832 行常量与纯辅助函数（存储键、容量上限、时间/字数/图片估算等）拆到 `src/ai/ai-constants.js`；`createAIPanel` 闭包骨架保持原样。
- **ai-panel.js 按域拆分**：18,023 行 → 11,040 行（-39%），闭包内按域抽成 17 个兄弟模块（统一模式：`createAI<域>(ctx)` 工厂 + ctx 注入，重赋值状态经 getter/setter 访问器，互引经惰性转发箭头解环；函数体逐字搬移）——`ai-tool-defs`（工具定义表）、`ai-session-list`（侧栏列表/分组/搜索）、`ai-composer`（输入区与附件）、`ai-tool-cards`（工具卡/审批卡渲染）、`ai-takeover`（输入区接管卡）、`ai-todos`、`ai-changes-ui`（变更记录）、`ai-schedule`（定时任务）、`ai-git-ui`（Git 快捷操作）、`ai-slash`（斜杠命令）、`ai-message-queue`（消息排队/插话）、`ai-manage-dialogs`（提示词/记忆/技能对话框）、`ai-settings-dialog`（设置页）、`ai-subagents`（子代理运行时 + HUD）。留守核心：`executeTool`、回合流程、会话持久化、消息渲染、三形态、init。每批独立提交，配三类静态扫描（ctx 键一致性 / return 键 / 裸引用与反向悬空）+ `npm test`（170 项）+ 构建验证；扫描共捕获 15 处「构建不报、运行才炸」的真实缺陷，另修复 `sessionHasLiveBgJob` 重复定义。
- **仓库卫生**：`.gitignore` 补齐 `*.exe~` 与 `/nul` 规则，清掉根目录残留的 27 MB 旧 exe 映像。
- **ai-* 归目录**：8 个 `ai-*` 前端模块与测试迁入 `src/ai/`（沿用 `reading/` 先例）；顺带把此前从未被执行的 `ai-permissions.test.mjs` 纳入测试脚本（150 → 161 项）。
- **前端拆分第二阶段（editor-groups + main.js 残余）**：`editor-groups.js` 5,130 → 1,520 行（-70%），按域抽成 7 个兄弟模块（`editor-ace-hooks` Ace 钩子、`editor-csv-view` CSV 表格、`editor-split-preview` 分屏与预览视图族、`editor-sql-view` SQL 查询、`editor-browser-tab` 浏览器标签、`editor-doc-extras` 徽标/书签/gutter/树菜单、`editor-export-menus` Markdown 块渲染与导出菜单；deps 经 `Object.create` 委托共用 editor-groups 的 getter 集）；`main.js` 7,473 → 约 4,380 行，拆出 `dev/mock-backend.js`（mock 后端改为 `!hasWails` 时**动态 import**——此前 mock 被静态打进生产包，现在主包零 mock、独立 65KB 懒加载 chunk）、`explorer-ops.js`（资源管理器域操作）、`editor-menus.js`（编辑器右键菜单）、`structure-panel.js`（结构面板控制器，与 structure.js 的面板 UI 工厂分层）。从 main.js 拆出的模块经 tokenizer 级重写器把裸标识符改写为 deps.X（跳过字符串/模板/注释/正则/属性/键位，对象简写位展开），抽取脚本自带模块自洽性扫描；过程共捕获并修复 4 类「构建不报、运行才炸」缺陷（动态尾发现误吞相邻域 82+33 行、对象简写位非法语法、for-of 迭代值漏改、import 绑定依赖缺失）。每批独立提交 + npm test（170 项）+ vite/wails build + 定向冒烟（mock 场景经内置浏览器实测）。

## v1.0.0 — 2026-11-09

首个正式版本。

### 文件与格式

- 支持 JSON / JSONC / JSON5、JSONL / NDJSON、YAML / YML、XML / SVG、CSV / TSV、TOML、INI / Properties、Markdown、图片与二进制文件。
- JSONL 按行解析为数组显示，编辑后仍按“一行一个 JSON 值”保存。
- 图片直接预览（上限 32 MB），二进制文件以十六进制只读展示；超大文件自动切换只读模式。
- UTF-8 / GBK / GB18030 / ISO-8859-1 / US-ASCII 编码自动识别，保留原文件换行符与 BOM。

### 视图与编辑

- 树视图、代码视图、文本视图、Markdown 预览、CSV 表格、图片视图与二进制视图。
- CSV / TSV / JSONL 新增 **SQL 查询视图**：把当前文件导入临时 SQLite（不修改原文件），在 `t` 表上执行 SQL 过滤/排序/聚合；CSV/TSV 自动推断列类型与分隔符，JSONL 展平顶层字段并保留嵌套 JSON；结果最多显示 100–5000 行，可重新导入；临时库在关闭标签页时删除，启动时清理 7 天前的遗留文件。
- 结构视图：Markdown 标题、HTML/XML 标签树、常用语言的类/方法/函数、数据文件的键层级，点击即可跳到源码行。
- 代码视图支持语法高亮、括号匹配、代码折叠预览、自动换行与缩进参考线。
- 内容区查找栏：`Ctrl+F` 打开 IDEA 风格浮动查找，支持区分大小写、全字匹配、正则表达式、结果计数，以及 `↑`/`↓`、`Enter`/`Shift+Enter` 上下跳转；代码视图高亮全部匹配。
- 快速切换面板：Ctrl + 反引号打开，按数字或点击快速切换主题、视图模式、编辑器字体、字号、缩进、布局与打开方式。
- 文件侧边栏新增 `Ctrl+B` 收起 / 展开（与 VS Code / IDEA 一致），原 `Alt+1` 仍可用；标题栏工具提示、菜单、欢迎页与快捷键说明同步显示新键位。
- CSV 表格支持单元格编辑、列宽调整、缩放与撤销/重做。
- CSV 大表改为虚拟滚动，去掉 5000 行预览上限；点击表头排序、顶部输入框筛选（只改视图，不改原文件）；右键表头打开列统计（行数/空值/唯一值/数值 min-max-avg/最长值/疑似类型）。
- 新增 JSONPath 查询栏（`Ctrl+Shift+J`）：支持 `$ . [] * ..`、切片、过滤与逻辑运算，JSON 结果可跳回源码行，YAML/TOML/INI 复用解析结果。
- 新增两个文件比较：Myers 行级 diff + JSON/YAML/TOML/INI 语义级差异；入口在「工具」菜单与命令面板，文件树选中两个文件也可右键比较。
- 新增 JSON Schema 校验（零依赖）：覆盖 type/required/properties/items/enum/数值与长度约束/组合关键字/本地 `$ref`，错误列表可按 JSON 路径跳转。
- 行书签（`F11` 切换、`F2`/`Shift+F2` 跳转）以及每个文件的光标、滚动、折叠状态随会话持久化。
- 结构解析移入 Web Worker 并按文本修订缓存，切换标签或编辑时不再阻塞 UI；结构文本上限提高到 8 MB。
- Markdown 整页渲染改为一次 sanitize，分屏预览按块增量更新 DOM，大文档输入更顺畅。
- 新增写作模式（`视图 → 写作模式`，仅纯文本与 Markdown 源码视图生效）：楷体/宋体/仿宋中文排版与独立字号、纸色滤镜（暖黄/调暗）、打字机滚动、段落聚焦、状态栏码字统计（今日/本次/速度/每日目标，达标提示，详情对话框）。
- 新增「格式 → 小说排版」一键整理：去行尾空白、行首清理、≥3 连续空行收敛；Markdown 语法行、围栏代码块、列表续段缩进与硬换行（行尾双空格）保护；纯文本可加段首全角缩进两格（注意：整理会重置撤销历史，可从 Git 历史找回）。
- 新增「工具 → 起名器…」（男/女/随机名池，可插入光标处）与「插入： 场景分隔符」；纯文本结构视图支持章节大纲（`第X章/回/节/卷/部/篇/话`、序章/楔子/番外等，卷→章层级，附每章字数）。
- 新增**阅读模式**（`视图 → 阅读模式`、资源管理器目录右键「作为书籍阅读」、文件右键「阅读此文件」、欢迎页「阅读书籍…」）：把一个目录下的 md/txt/docx/epub 变成可连续阅读的书——自动识别卷-章-节结构（文件即章 / 文件内切章 / 多级文档树三种 profile，可手动覆盖）、中文排版（宋体/楷体/雅黑/等线、字号/行高/页宽/段距/缩进、纸白/护眼/纯白/夜间主题）、进度记忆（字数加权、四级失效恢复）、书签（`Ctrl+D`）、章内查找与全书搜索、阅读统计（时长/连续天数/近 7 天柱状图）、文档树模式、大章自动分块、目录字数与预计时长。全程只读：不写源文件、不进会话文件列表、不建全文索引；Markdown 渲染与主界面共用同一套 sanitize 规则（新抽出 `frontend/src/markdown.js`）。
- 撤销/重做、格式化、自动保存、只读锁定；多标签分组与分栏、多窗口打开模式。
- 关闭有未保存修改的标签或窗口时确认；可重新打开刚刚关闭的标签页。

### 文件管理

- 文件侧边栏：列表 / 文件树、懒加载目录、多选、重命名、复制 / 剪切 / 粘贴、删除到回收站、自动刷新。
- 文件树自动刷新前先比对目录 mtime，未变化直接跳过；窗口聚焦时改用 `ReadDirectoryChangesW` 文件系统通知按变化目录局部刷新，缓冲区溢出自动退化为全量刷新，监听不可用时保留轮询兜底。
- 文件夹工作区与结构化目录复制 / 导出。
- 新建文件菜单重排：`文件…` / `目录…` 置顶，常用数据格式（JSON / TXT / Markdown / YAML / XML / CSV / TOML / JSONL / INI / Properties）直接列出，代码类文件（JavaScript / TypeScript / HTML / CSS / Python / Shell / PowerShell / 批处理 / SQL / Go / Java / Kotlin / Lua）收进底部「更多」二级菜单；文件树右键与菜单栏「文件 → 新建」保持一致。
- 文件菜单：新建、最近打开、保存 / 全部保存、重新加载 / 全部重新加载、文件属性、复制路径、导出、标签批量关闭等。
- 拖放文件到窗口即可打开；支持命令行打开并跳转到指定行:列。
- 新增命令行批量格式转换：`--convert <输入...> --to <格式> [--out <文件|目录>] [--stdout] [--force]`，复用前端格式层，支持 JSON/JSONL/YAML/XML/CSV/TOML/INI；通配符展开、批量输出目录、拒绝覆盖已有文件、退出码区分参数错误与转换失败。
- 工作区搜索优先调用用户已安装的 ripgrep（不打包、不可用时自动退回内置扫描），内置扫描改为 worker pool 并行处理，并消除逐行 ToLower 与整行转 rune 的分配热点。

### 个性化

- 10 套配色主题；界面、编辑器、中文字体、字号与文件树字号可分别设置。
- 文件图标主题：开源图标集、文字缩写、无特殊图标。
- 窗口置顶、终端面板、状态栏信息与快捷操作。

### 安全与隐私

- 新增**操作记录**（`设置 → 操作记录`）：把打开 / 保存 / 另存为 / 新建 / 删除 / 重命名 / 移动 / 格式化、设置变更（旧值→新值）、关闭脏标签、标签 / 工作区 / 视图切换、插件启停、AI 审批判定（含自动放行来源）与工具执行摘要等「状态改变类操作」落成可查询的结构化本地日志——应用数据目录 `activity/*.jsonl`，按月分文件、单文件 5 MB 自动滚动分段、保留 1–60 个月可调（默认 12）。只记操作摘要，**永不记录文件正文、剪贴板与 API Key / Token**（秘密字段一律写 `***`，超长文本与深层对象降维）；设置页可按动作大类 / 来源 / 关键字筛选、导出 JSON / CSV、打开记录目录、一键清空（保留一条「已清空」标记）或整体关闭；AI 可经 `app_control get_activity`（只读）查询最近记录，方便「我刚才改了什么」回忆与排障。多窗口写入用文件锁串行，写失败只进运行日志，绝不阻塞用户操作。

### 扩展与系统集成

- 插件系统：注册文件格式、工具菜单命令、主题与图标主题；支持文件夹、`.zip` 和仓库地址安装。
- 插件市场：扫描 Gitee 组织公开仓库，显示版本、检测更新并一键升级。
- 插件权限提示：插件与应用同权限运行（可读写文件、执行命令），设置页插件小节常驻提示；从仓库地址或插件市场安装前弹确认框，避免一键装下来源不明的代码。
- 系统集成：文件关联、资源管理器右键菜单、全局 Agent Skill、`datalens` 命令行。
- 开发者模式：错误 / 警告写入本地运行日志，可额外记录调试信息。
- 应用数据统一存放于 `%APPDATA%\CandySweet\CaDt-DataLens`。

### 帮助与关于

- 帮助菜单支持检查更新、更新日志、问题反馈、用户协议与隐私协议。
- 关于页显示版本信息，并提供检查更新入口。

### AI 助手

- 审批体系升级（对齐 Qoder / ZCode 等 harness 的权限模型）：新增统一权限决策链（项目 deny → 危险命令单次确认 → 项目 ask → 会话/项目 allow → 模式默认），命令、工作区写入与 `web_fetch` 都走同一入口。自动审批档新增**只读命令静态分析**（argv 级识别 ls/cat/grep/rg/find/git status 等约 60 条只读命令与 Git 只读子命令，`sort -o` / `find -exec` / 重定向 / 命令替换等一律回退审批，复合命令逐段判定）；新增**危险命令清单**（rm -rf、git reset --hard / clean -f / push --force、checkout/restore 丢弃工作区、shutdown 等），非完全权限档只确认一次且不提供长期放行；新增项目级权限规则文件 `.cadt/permissions.json`（`Bash(...)` / `Write(...)` / `Web(...)` 行语法，deny → ask → allow，随工作区共享），审批卡支持「本项目允许同类命令 / 此文件」；设置 → AI 新增「权限」页（规则编辑、本会话授权、最近审批记录、**自动审批分类器**开关，默认关闭，失败/超时回退人工审批）；权限页支持**规则表格**（按 deny → ask → allow 分组直接增删，文本编辑保留为高级模式）、**审批记录一键成规则**（+allow / +ask / +deny）、**会话授权单条删除与「存入项目」**，规则文件读-改-写串行执行避免并发覆盖；分类器触发时工具卡显示「等待 AI 分类器判定…」，消息流推送系统提示（判定中 / 放行原因 / 转人工），审批记录标注 `classifier` 来源；**审批留痕**：命令 / 写入完成后卡片标注「自动放行：只读命令 / 命令族 / AI 分类器 / 本会话授权 / 项目规则 / 完全权限」或「用户已批准」，来源随会话持久化，权限页「最近审批」同时记录用户的批准 / 拒绝（来源「用户批准」）；计划批准卡片可从计划正文提取同类命令并预授权。只读命令与已知命令族直接执行后，`cd` / `pwd` / `ls` 等探测类命令不再触发审批。- 「自动审批」档补放行基础导航命令：`pwd` / `cd` / `chdir` / `echo` 这类不读文件、无副作用的单条命令不再逐条审批（含管道、重定向、命令串联的仍转审批）；「每次询问」档也可勾选「本会话允许同类命令（cd）」。`ls` / `dir` / `cat` 等目录与文件内容读取命令仍只能按相同命令放行。同时 `run_command` / `background_command` 的工具描述与系统提示词明确「每条命令在独立进程中以 cwd 参数为工作目录执行、cd 不会保留」，避免模型用 `cd` / `pwd` / `echo %CD%` 探测目录白白触发审批。- 内置技能新增 **answer-me-with-html**（把复杂回答做成一张网页）：遇到结构 / 流程 / 对比 / 排查 / 方案类问题，AI 会生成一页自包含 HTML（离线、无脚本、适配深浅色），写入工作区 `.cadt/answers/`，并用应用内嵌浏览器打开；同时给出 2–4 行结论与页面路径。内置版不依赖 Node 或外置 CLI，规则参考 MIT 许可的同名社区技能并做了应用适配。
- 内置技能新增两个**随应用分发的完整技能**（`go:embed` 进 exe，首次列出技能时释放到应用数据 `builtin-skills/`，版本更新后自动刷新）：**reverse-engineer-anything**（REA 逆向分析，同步上游 SKILL v62，含 8 份 references）与 **chinese-formal-document-format**（中文正式文档 DOCX 排版，上游 v1.3.0，含 Python 脚本、模板与参考资料）；技能管理显示为「内置」（rank 600），可被工作区 / 应用级 / 用户级同名技能覆盖；`skill_use` 现在会附带技能目录，模型可据此读取 references / scripts；两者均为 MIT 许可，许可证随技能目录存放，来源见 `docs/skills/README.md`。
- 自动审批分类器扩展：设置 → AI → 权限的分类器开关下新增默认折叠的「高级配置」面板，可为分类器指定**专用请求模型**——从模型配置列表下拉选择（使用该配置完整的 provider / 地址 / 密钥 / 代理），默认「跟随当前模型」，所选配置被删除后自动回退为跟随当前模型；选择随 AI 配置导入 / 导出。分类器开启时，权限档菜单的「自动审批」旁显示 **AI 胶囊标识**（sparkles 图标），提示该档位会额外请求模型判定。
- 修复审批留痕未随会话持久化：会话 JSONL 是追加式日志，工具消息首次落盘（常发生在审批判定等待期间，如分类器最长 12 秒请求）后再就地写入的审批对象不会被覆盖，导致会话重载后分类器放行来源（`autoRule:"classifier"`）、用户批准 / 拒绝结果丢失，手工批准永远残留「pending」状态。现在审批对象变更时把该消息从已持久化前缀中摘出，下次持久化以 truncate + 重追加覆盖为当前状态；自动放行（只读 / 命令族 / 分类器）、用户裁定、写入授权、取消与失败路径统一生效。
- 修复定时任务触发后新会话为空白：任务到点后确实发出了 AI 请求，但触发流程里的 `open()` 会异步重读磁盘会话，重读结果若在消息入队之后返回，会整体替换 `sessions` 数组，流对象指向被丢弃的会话（后续 `ai-chunk/ai-done` 全部落空，只留下一个空会话文件）。现在生成中（`stream`/`oneShot`）一律不应用磁盘重读结果；同时 `submitText` 在消息入队后立即落盘用户消息与占位回复，即使事件丢失/崩溃也不会只剩空壳。
- 定时任务操作反馈：AI 通过 `schedule_create` / `schedule_toggle` / `schedule_delete` 操作任务后会立即提示（创建含任务名与下次触发时间），并刷新设置里的定时任务列表；设置列表的启停/编辑/删除按钮改用内联 SVG 图标。
- 修复重新进入时上下文占用估算偏差：面板重开、切换会话、应用重启后，占用值此前沿用默认或旧的系统提示词（AGENTS.md / 记忆 / 技能索引 / 工作区上下文 / 注入开关等未即时计入），配置异步加载完成后也不会重算；现在上述时机都会异步重建真实系统提示词再刷新占用值，环形百分比、接近上限提示条与上下文弹层保持一致；发送带附件的一轮结束后也会按下一轮（附件已清空）重新估算。
- 修复上下文弹层与状态栏角标占用不一致（如弹层 5%、角标 9%）：统一估算口径时弹层漏改，仍只按消息正文累加，漏掉思考链与工具调用参数（重工具会话约 1/3 体积）。现在弹层逐条走与角标 / auto-compact 相同的 `estimateMessageTokens`（content + 思考链 + 工具参数 + 图片），分段条与总额同步；状态栏「6.2M tok」为历史累计流量（134 步 × 每步重发全量上下文），与「当前占用百分比」本就是两个口径。
- 修复工具轮消息顺序错乱：一轮内出现多次「思考/正文 + 调工具」时，最后一条 assistant 被当成「最终回答」抽到组尾，正文因此显示在它触发的工具卡片之后（如「先重新备份最新状态：」跑到终端卡片下面）。现在只要本组以 tool 消息结尾（工具执行中 / 等待审批 / 等待回答 / 异常中断），全部消息按时间序留在过程时间线里，不再提前抽最终回答。
- 思考链自动跟随最新内容：思考面板超过最大高度（260px）出现内滚动条后，流式思考期间滚动条**默认贴底**，新冒出来的一行始终在视野里，不用手动往下翻；手动上滑即暂停跟随（保留用户看的位置），滑回底部或流式中重新展开时恢复跟随，思考结束后保持原有阅读位置。
- 修复工具执行期间思考链面板消失：模型思考完直接调工具（该轮无正文）时，最终消息因无可展示内容被跳过，思考链也随之隐藏；现在工具执行/审批等待期间思考链挂在过程折叠体里保持可见（折叠区默认展开），工具结束后的展示与收起行为不变。
- 修复工具调用参数非法导致整轮对话被拒：模型偶发在工具参数末尾多写括号或截断时，非法 JSON 会被原样存进会话历史，之后每轮请求都被 `AISendChat` 整轮校验拒收（报「第 N 条消息第 M 个工具调用参数不是合法 JSON」）。现在工具轮结束时与请求构建时都会规范化参数（合法直接用、`jsonrepair` 修复常见损伤、括号平衡扫描取第一个完整对象）；**彻底无法修复的调用不再执行，而是把「参数不是合法 JSON，请重新调用」作为工具错误结果回给模型，对话继续**，由 AI 自行重试。Go 侧也不再因此整轮拒收（兜底按 `{}` 发送并记警告日志），历史坏会话无需清空即可继续；恢复旧会话时同样修复。
- 应用注入消息（Git 快捷操作、定时任务）改为全宽**应用消息卡片**：带图标、「应用消息」标签与来源标题（如「Git 快捷操作 · 提交并推送」「定时任务 · 名称」），不再是用户胶囊；指令全文默认收起，点「查看指令」展开。旧会话按固定前缀自动识别并同样按卡片展示。该机制已抽成通用能力（`ai-app-message.js` + `aiPanel.sendAppMessage({kind, label, icon?, content})`），后续功能直接复用，不必重复实现消息结构与样式。
- AI 回答支持**内联可视化卡片**：语言标记为 `svg` / `html` 的围栏代码块直接渲染成可交互卡片（顶部标注 SVG / HTML，可切换源码、复制、点链接走系统浏览器），用来画架构图、流程图、对比表或纯 CSS 小示意，不必再生成网页另开标签。内容经 DOMPurify 清洗后放进 **Shadow DOM**：脚本不执行、`on*` 事件属性与 `javascript:` 链接被移除、样式不外泄，主题变量（`--bg` / `--panel` / `--text` 及 `--color-*` 别名）自动继承明暗主题。流式输出期间只显示「正在生成可视化…」，整轮结束再挂载卡片，避免每次增量重建；围栏 info 写 `no-widget` 可对单块强制显示源码，单块超过 200 KB 或单条超过 8 张时保留源码。默认开启，可在 AI 面板设置「渲染回答中的 SVG / HTML 图」关闭（关闭后按普通代码块显示）。普通 Markdown 内嵌 HTML 仍按原规则转义，**原始 HTML 不执行**不变。HTML 卡片支持 `<style>` 块：DOMPurify 会连内容一起剥掉 `<style>`（SVG 内的反而保留），因此改为先把 CSS 文本抽出单独清洗、再与卡片基础样式一起注入 shadow（作用域仍只有卡片内部）；清洗去掉 `@import` 与远程 `url()`（保留 `url(#id)` 与 `data:`），`position:fixed` 降级为 `absolute`（shadow 内仍相对视口，会盖住整个应用），`expression()` / `behavior` / `-moz-binding` / `javascript:` 直接剔除。
- 内置技能拆成**两级可视化**，避免只靠提示词一句话叮嘱：新增 **inline-visual**（对话内卡片路线）——写明何时该画、何时不该画、`svg` / `html` 围栏写法、卡片没有 `body` / 没有 JS 的硬性边界、必须用主题变量（并明确禁用 `prefers-color-scheme`，因为应用主题是用户手选）、尺寸与排版上限，并附流程图与对比卡两套可直接照抄的模板和常见错误清单；**answer-me-with-html**（页面路线）同步收窄为「≥4 个面板 / 需留存分享 / 一屏放不下」时才用，开头增加「先选形态」判断，两个技能互为升级路径而不是互相抢活。系统提示词只保留一句用法指引并指向这两个技能，细则由技能承载。
- AI 面板头部新增 Git 快捷操作（工作区是 Git 仓库时显示，位于「新建会话」右侧、显示方式切换组左侧）：**提交并推送 / 提交代码 / 推送代码 / 拉取代码**四项把预设指令注入当前会话，由 AI 通过终端与写文件工具执行，权限档与审批沿用现有通道。提交信息风格首次使用时由 AI 询问（Conventional Commits（推荐）/ 简洁中文 / Gitmoji / 自定义、语言、是否追加 Co-authored-by；超时自动采用推荐项），此后按工作区 `.cadt/git-commit-style.json` 执行；推送被远端新提交拒绝时自动 `pull --no-rebase` 合并后重推（不询问），只有产生冲突才询问处理偏好；拉取同样优先自动合并、冲突先询问，并保护本地未提交改动。`write_file` 新建文件时自动创建缺失的父目录。
- 子代理（智能体团队）：新增 `spawn_agent` 工具——派出只读子代理独立完成子任务（并行探索 / 多视角审查 / 长任务隔离），阻塞等待其完成后把最终结论摘要（≤8KB）作为工具结果回填主会话；每次询问 / 自动审批 / 完全权限与计划模式可用（子代理只读探索正是计划模式的刚需）。子代理工具集为只读子集（列目录 / 读文件 / 搜索 / 联网 / 记忆读取 / 技能 / 环境变量列表，且层级允许时可用 `spawn_agent` 递归派下一层只读子代理），不能写文件、执行命令或与用户交互；轮次上限默认 15（可传 3–15），消息上限 60。子代理总数默认上限 20，统计所有层级正在运行的子代理（含递归派出的，不含主代理）：主代理达到上限时等待空位，子代理再派会被拒绝；递归层级默认不设限。两者均可在 `设置 → AI 助手 → 子代理` 调整（总数 1–20，层级 0 = 不设限或 1–20 层）。主会话消息流中以子代理卡片呈现（任务 + 运行状态 + 实时转录 + 最终摘要与轮次/用时/tokens）；主会话停止连带停止全部子代理。子对话不随会话持久化（转录存内存，重启后卡片保留元数据与摘要并显示「子对话已归档」，运行中的子代理恢复时收敛为已停止）。事件按子会话 id 前缀路由到独立流对象，主 stream 单例与 /compact oneShot 分支零改动。
- 定时任务：AI 可在指定时间自动触发对话——`schedule_create`（once / interval / cron，once 支持绝对时间或 delayMinutes）、`schedule_list`、`schedule_delete`、`schedule_toggle` 四个工具（读取档可用、免审批，计划模式不可用）；触发时向目标会话注入 `[定时任务 · 名称]` 指令并走完整审批/流式管线，完成/失败复用现有通知。调度器在 Go 侧（不受后台页面 timer 节流影响），任务存派生 SQLite `ai-schedule.db`（可随时删除重建）；任务仅在应用运行期间有效，重启后重算触发时间、错过的不补跑。多窗口广播去重：指定会话的任务由持有该会话的窗口执行，新建会话类任务优先聚焦窗口。设置 → AI 新增「定时任务」页（增删改查 + 启停），`/schedule` 直达；cron 为自写 5 字段解析（分 时 日 月 周，支持 * , - /）。
- 修复 AI 面板一个潜伏的启动中断：面板按上次状态在启动时自动打开时，布局回调会引用尚未初始化的终端声明（TDZ），导致整个脚本模块求值中断、面板与设置区静默失效；初始化调用移至声明之后并对布局回调加兜底。
- 后台终端：新增 `background_command`（后台启动长驻/耗时命令，立即返回 jobId，不阻塞对话）、`check_command`（按游标增量查询状态与输出）与 `stop_command`（终止并返回退出码）三个工具；每次询问档启动时与 run_command 走同一审批卡（审一次，查状态/停止免审批）。输出按行缓冲（每作业 256 KB 环形，超限丢弃最早）并实时追加到工具卡片；作业独立于对话轮生命周期，应用退出全部终止。Go 侧取消一律 `taskkill /F /T` 杀整棵进程树（Git Bash 的 `bin/bash.exe` 是 wrapper，真实 bash 是其子进程），并修复了 run_command 超时在 wrapper shell 下可能永不返回的隐患；被终止的作业退出码统一记 -1。
- 设置 → AI 新增「上下文注入」独立页：系统提示词模板编辑器与逐项注入开关放在同一页。工作区上下文拆成范围根 / 当前活动文件 / 光标行列与选区 / 可见行范围 / 已打开文件列表；项目与记忆拆成 AGENTS.md / MEMORY.md / 技能索引 / 用户偏好；环境变量单独开关。`read_file` / `get_content` 等工具结果由 AI 主动调用产生，不受注入开关控制，权限档决定能否调用。
- 内置「默认助手」提示词升级：英文规则核心（先查证再修改、引用 path:line、外部内容不可信、不泄露密钥等）+ 输出语言由设置控制，回答默认中文。设置 → AI → 聊天行为新增「默认输出语言」（中文（简体）/ English / 跟随用户输入，默认中文），每轮以 `<output_language>` 注入，下一轮生效；旧版本中未被用户修改过的内置默认模板会自动升级，自定义内容保持不变。
- 排队消息新增「编辑」（铅笔图标）：点击后把该条取回输入区（图片与附件一并带回），修改后可按 Enter 重新排队或 Ctrl+Enter 插话；输入区原有草稿会自动放回队尾，不会丢失。
- AI 自动感知当前工作区：每轮系统上下文除已打开文件与当前活动文件外，新增活动文件的视图模式、未保存状态、光标行列、选区起止行列和可见行范围；路径按范围根转相对路径（工作区外只留文件名，不发送用户名与盘符），AGENTS.md / 记忆路径同步脱敏。用户说「当前行 / 这里 / 我选中的内容」时不需要再让 AI 查询，正文不自动注入，AI 按需用 `get_content` 读取。AI 面板打开时，标签页 / 编辑器空白处右键新增「引用该文件」，有选区时显示「引用选取」：只传文件名、绝对路径和起止行列（选区不带正文），以 `<file_reference>` / `<selection_reference>` 交给模型。
- 面板头部新增「新建会话」图标按钮（显示方式切换组左侧），一键在当前工作区新建会话。
- 新建会话去重：当前会话还没发过消息（未归档、属于当前工作区或未绑定工作区）时，再次新建会复用该会话并提示「当前会话为空，已复用」，连点不再刷出一堆空会话；工具栏、⋯ 菜单、命令面板与会话桥等所有入口同一规则。
- AI 提问（ask_user）面板改版：底部「停止本轮」换成「跳过」，可跳过不回答且不中断本轮（卡片显示「已跳过」，模型收到「用户选择不回答」并继续）；有选项时末尾默认追加「其他：自己输入回答…」一项（AI 传 `allow_custom=false` 才关闭，默认开）；多选题每个选项前增加勾选框图标，选中为蓝底白勾。
- 用户偏好：设置 → AI 新增「用户偏好」独立页（支持筛选搜索与条数统计），可手动添加 / 编辑 / 删除（每条 ≤500 字，上限 100 条，带「用户 / AI」来源标记）；偏好注入每轮系统上下文并被优先遵循。新增 `preference_list` / `preference_write` / `preference_remove` 工具，AI 可读取、新增、修改（带 id）与删除偏好，写入即时刷新设置列表；偏好随 AI 配置导出 / 导入。
- 联网检索：新增 `web_search`（Bing 搜索，返回标题 / URL / 摘要 / 日期）与 `web_fetch`（抓取公开网页并转纯文本，附标题、HTTP 状态和页面链接）；读取档与计划模式可用、免审批、不需要额外 API Key。只允许 http/https 公网地址（拒绝本机 / 内网 / 保留地址），自动识别 UTF-8 / GBK / GB18030，限制响应大小与正文长度；网页内容按外部不可信资料处理，不执行页面脚本。配套新增 `web-research` 内置技能（先搜索、再抓取、附 URL 引用）。
- 技能扫描改为 dsh 式 rank 优先级：工作区 `.cadt/skills`（100）> 工作区 `.agents/skills`（200）> 应用 `%APPDATA%\CandySweet\CaDt-DataLens\ai-skills`（400）> 用户 `~/.agents/skills`（500）> 内置（600）。rank 越小越优先，同名技能只保留优先级最高的一份；同一根内按条目名排序、先到先得。新增扫描 `C:\Users\<用户名>\.agents\skills`，技能管理与技能索引会显示「工作区·通用」「用户·通用」来源。
- 权限粒度从三档改为四档：**只读访问 / 每次询问 / 自动审批 / 完全权限**。自动审批会直接应用工作区写操作（目标文件在编辑器中有未保存修改，或路径属于 AGENTS.md / .cadt / .agents / .git 时仍询问），并自动执行白名单内的低风险命令，其余命令仍逐条审批；完全权限保留二次确认，弹窗改为风险说明版（文件与文件夹 / 终端命令 / 互联网与已连接应用三项说明 + 取消/红色确认按钮）。
- 终端命令审批新增会话级放行：可勾选「本会话允许相同命令」（完整命令 + cwd 一致）或「本会话允许同类命令」（`git status` / `go test` / `npm run build` 等白名单签名，要求同 cwd 且不含管道、重定向、命令串联或 `$()`）；同类白名单覆盖 git / go / npm / pnpm / dotnet / cargo 的低风险子命令。授权只存内存，重启应用、重新加载对话或清空会话即失效；`powershell` / `cmd` / `bash` / `python` / `node` 等解释器只支持相同命令，不支持同类放行。
- 应用操作（app_control）补齐读取能力：新增 `get_settings`（全部设置值，可按 keys 过滤）、`get_editor`（编码/换行/行数/字符数/光标行列/选区预览）、`get_content`（编辑器内存实时文本，含未保存修改）、`get_git`（仓库/分支/变更列表）、`get_ai`（权限档/计划模式/模型/会话/偏好统计）、`get_explorer`（根目录/选中项）、`get_plugins`、`get_terminal`（终端会话与缓冲区末尾输出）；cadt-ui 内置技能动作表同步。
- AI 会话侧栏新增**搜索**：优先走 Go 侧可重建的 SQLite FTS 索引（`ai-index.db`；≥3 字符 trigram 子串匹配，1–2 字符 LIKE），索引不可用时自动回退内存扫描；点击结果切到会话并滚动到命中消息，`Esc` 清空。
- AI 配置（profiles / prompts / preferences / 审批白名单）从 localStorage 迁到 `ai-config.json`（原子写、0600）；localStorage 保留镜像用于旧版本回退，`localStorage['datalens-ai-config']='legacy'` 可强制旧路径，首次升级自动迁移。
- 新增 pure-Go SQLite 依赖 `modernc.org/sqlite`（**只用于可重建的会话搜索索引**，JSONL 仍是唯一真源）：实测整包 exe +3.9 MB，安装包约 +1.8 MB；删除 `ai-index.db` 后首次搜索自动重建。
- AI 回复操作新增**回退到此轮**：保留该条回复及之前的消息，删除之后的所有轮次（需确认；磁盘日志追加 `truncate` 事件，已归档内容不受影响）。
- 新增**首轮自动生成会话标题**（设置 → AI → 聊天行为，默认开）：首轮结束后用当前模型按第一条用户消息生成 6–16 字标题；失败或用户已重命名时保留原标题。
- 会话菜单新增**会话数据诊断**：查看 JSONL 字节数/行数、事件类型统计、重放条数、解析 issue、撕裂尾、内存与磁盘的 mid 对齐情况与加载错误，可一键复制。
- AI 会话改为**磁盘存储**：`%APPDATA%\CandySweet\CaDt-DataLens\ai-sessions\<会话id>\`，每个会话一个追加式 `session.v1.jsonl` + `meta.json`，图片外置到 `images/`。不再受 WebView2 localStorage 约 5 MB 配额限制，也不会再因配额告急而静默归档消息或裁掉图片。
  - 列表只读 `meta.json`，正文按需加载；写入只追加新消息，进程被杀最多丢最后半条（读取时忽略残行）。
  - 每批追加后 `fsync`；写入/同步失败会截回追加前长度并回滚内存记账，下次持久化自动重试这批消息。
  - 每个会话目录带 `.session.lock`（Windows `LockFileEx`、其余平台 `flock`）：两个窗口同时写同一会话不会撕裂或交错，写者最多等 5 秒。
  - 启动时收尾上次中断的状态：`running` 工具显示「执行被中断，结果未知」、`streaming` 回复显示已停止、挂起的审批/提问/变量创建取消；收尾结果会异步写回磁盘。
  - 支持标题变更、压缩归档、编辑重发、重新生成、清空等历史改写操作，重放结果与界面一致。
  - 旧的本地缓存会话在首次启动时自动迁移到磁盘，原数据保留 30 天；排查时可执行 `localStorage.setItem('datalens-ai-storage','legacy')` 临时回退。
  - 会话不再自动删除；设置中的「会话保留上限」已移除，手动删除会话会移入回收站。
  - 定时任务调度器尚未实现；任务定义与运行历史的 SQLite 存储方向已记入 `docs/ai-panel-v2.md`，等调度器落地再做。

- AI 工具调度整理：系统提示词新增 `<tool_catalog>`，把全部 40 个工具按「探索与读取 / 文件写入 / 终端与进程 / 联网资料 / 内嵌浏览器 / 应用界面 / 记忆偏好与技能 / 环境变量 / 任务协作与自动化」分类，逐项写清用途与适用场景；附调度原则（先查后答、并行读串行写、专用工具优先、失败先修正参数）与「典型任务 → 工具链」，并按当前权限档与计划模式只列出实际可用的工具。
- 应用操作（app_control）新增 `screenshot` 动作：截取当前应用主窗口（含内嵌浏览器与 AI 面板）并以「应用截图」应用消息卡附加到对话，AI 可直接核对主题、布局与面板位置；窗口最小化时提示先恢复。Go 侧用 `PrintWindow(PW_RENDERFULLCONTENT)` 抓 WebView2 合成层，失败退回窗口 DC；超过图片上限自动按 0.7 逐级缩小。
- 图片预览新增**面板内全屏查看**：预览对话框新增「全屏查看」按钮，也可直接点击预览图进入。查看层只铺满 AI 面板（全屏模式下即文件内容区），不遮挡窗口其他区域；滚轮缩放、拖动平移、双击在「适应区域 / 原始大小」间切换，右键图片仍可复制 / 另存为，`Esc`、点击空白或右上角按钮关闭。查看层抽成通用组件 `frontend/src/image-lightbox.js`（`createImageLightbox(host)`），其他面板可直接复用。
- 修复图片全屏查看放大后**左侧内容看不到**：居中容器此前固定为可视区宽度，放大后的图片超宽部分向左溢出，而滚动区只能从 0 向右滚，左侧（含左上角）永远拖不到；现在容器随图片一起撑开，放大后可从左边缘拖到右边缘，缩小回适应区域时仍然居中。
- 应用操作（app_control）新增 **get_activity** 动作（只读，所有权限档可用）：按 `limit / sinceTs / beforeTs / actions / actor / keyword` 查询操作记录的逐行文本摘要（actor/source 动作 对象 详情），`actions` 支持按大类前缀筛选（如 `file` 命中全部 `file.*`）；用户问「我刚才改了什么」或排查问题时先查记录再回答，cadt-ui 技能动作表与工具描述同步更新。
- AI 面板头部会话化 + 后台任务入口：头部标题改为显示**当前会话标题**（首轮即时标题与模型总结标题自动跟随，改名即刷新；宽度受限溢出省略），标题右侧常驻**「智能体团队」「终端」两个入口 chip**（宽度不够时自动只显示图标；有任务运行时显示数量角标并带转动指示）。**智能体团队**弹层列出子代理（运行中 / 已完成 / 失败 / 已停止，标注所属会话），点击在面板内打开**子代理详情视图**——左上角返回按钮回到主代理；运行中实时跟随（任务 / 正文 / 工具调用），结束后显示最终结论与过程转录（重启后仅保留会话内摘要）。**终端**弹层列出 AI 启动的后台命令作业（状态图标 + 指令单行），点击在**内容区以标签页打开**：上栏命令与元信息（可复制命令、一键停止）、下栏实时输出，中间分割线可拖拽调整上下比例（记忆上次位置）；关闭标签不影响作业继续运行。
- 定时任务改为**默认唤醒会话**而不是每次开新对话：`schedule_create` 省略目标会话时自动绑定当前会话（到点把该对话唤醒并继续），只有显式 `newSession=true` 才每次新建；设置 → AI → 定时任务的「新建/编辑任务」对话框新增「目标会话」下拉（唤醒会话 / 每次新建会话，最近 30 个会话可选），任务列表与 `schedule_list` 显示绑定会话的标题；触发时若绑定会话已被归档会自动取消归档再唤醒；目标会话属于其他工作区时明确报错（此前会静默注入到错误会话）。
- **模型账号升级为「一个 API Key 配多个模型」**：设置 → 模型 的配置项改为「模型账号」（连接信息：提供商 / Base URL / API Key / 代理 / 温度），账号下可挂多个**模型条目**，每条目独立配置模型 ID、上下文窗口、输出窗口、推理强度 / 扩展思考与**输入能力勾选框（文本 / 图像 / 视频 / 音频，默认勾选文本+图像；视频/音频暂不支持发送仅作标记）**；「获取列表」拉取 `/models` 后弹多选层勾选批量添加；旧单模型配置自动迁移为首条目（旧字段保留镜像，旧版本回滚可用）。模型胶囊单行显示模型名与推理等级（图标 + 名称 + 等级 + 一个展开箭头，不显示文字标签），点击弹出**搜索 + 按账号分组**的模型选择器（键盘导航、底部推理等级选项行）；切换模型/账号写入 `activeModelId` 并按账号记忆上次选择；当前模型未勾选图像时图片附加与发送自动禁用；分类器专用模型引用升级为「账号|模型」并兼容旧格式。窗口字段支持 **K / M 单位**（输入 `256K` / `1M` / `131K`，回显自动格式化），上下文窗口上限放宽到 8M、输出窗口 2M。
- **对话中切换模型留痕**：切换只在下一条消息发出时生效——当前这一轮（含剩余工具轮）继续用旧模型；发送下一条消息时，会话里会在该条消息之前插入一条居中的分隔记录「模型已从 A 更改为 B」（悬停信息图标可看账号、推理等级与时间），记录随会话 JSONL 持久化、重放后仍在，且不进入发给模型的上下文；每条 AI 回复头部的模型标签始终按实际使用的模型标注。连续多次切换合并为「起点 → 最终选择」，切回原模型则不留记录。
- **上下文注入改为缓存友好顺序**：系统提示词按「稳定 → 动态」排列——基础提示词、AGENTS.md、记忆、用户偏好、技能索引、环境变量、工具目录、工作区规则、输出语言在前；每轮都会变化的工作区状态（活动文件 / 光标 / 选区 / 可见范围 / 打开文件）与附件放到最后。注入内容与开关不变，但公共前缀更长，服务商的自动前缀缓存（DeepSeek / OpenAI）能命中更多 token，同一轮内多次工具调用也能复用整段系统提示词。
- **用量查询（cc-switch 式）**：设置 → 模型 账号卡片新增「查询用量」按钮，按账号 baseURL 匹配内置端点（DeepSeek `/user/balance`、OpenRouter credits、SiliconFlow user/info，支持代理与自定义请求头）查询余额 / 用量，弹层展示明细；未收录的服务商明确提示暂不支持。Go 侧新增 `AIUsageQuery`（15 秒超时、响应限 64KB，Key 只进本次请求头）。
- 每轮结束后在对话流末尾显示**「已编辑 N 个文件」汇总卡**（Qoder 风格）：聚合本轮所有写文件工具的改动（按文件合并 +新增 −删除 行数），默认列 3 个文件、超出折叠为「再显示 N 个文件」；点击文件行直接打开，**「审阅」按钮逐文件取 Git 差异拼成一份虚拟 diff 文档打开**（无 Git 差异时回退为直接打开文件）。汇总卡随会话 JSONL 持久化，重放后照常显示，不进入发给模型的上下文。
- 审批接管卡支持**临时收起**：卡片头部新增收起按钮，收起后折叠为单行细条（「更改待审批 · 路径 +N −N」）保持可见性，点击细条恢复完整卡；换一条审批或做出决定后自动复位，收起不影响审批本身。
- AI 面板停靠分屏支持**左右互换**：面板头部显示方式切换组旁新增「换侧」按钮，也可由 AI 经 `set_setting aiPanelSide left/right` 切换；面板在左侧时边框、拖拽手柄方向与拖拽语义同步翻转（向右拖变宽），设置持久化。
- **内置浏览器视口尺寸**：工具条新增视口按钮（当前尺寸 / 自适应），预设 1280×720 / 1440×900 / 375×812（iPhone）/ 768×1024（iPad）与自定义「宽×高」（200–8000）；固定视口居中显示、四周留白，`.browser-surface` 为唯一真源自动同步到原生 WebView2。AI 新增 **`browser_resize(width,height)` 工具**（每次询问及以上权限）与用户入口共用同一实现，用于测响应式布局。
- **会话置顶**：会话列表新增「置顶会话」——右键会话条目（或 ⋯ 菜单 / 会话列表更多菜单）置顶 / 取消置顶；置顶会话固定显示在列表最上方的「置顶」分区（不受工作区分组与时间排序影响），标题行带图钉标记；置顶状态随会话 meta 持久化，重启后保留；已归档会话不可置顶（先取消归档）。
- **AI 面板头部紧凑布局**：头部宽度不足时（标题行 < 420px，与智能体团队 / 终端 chips 只显示图标同一阈值），「显示方式」的停靠 / 全屏 / 悬浮三个按钮与「换到另一侧」一起收进右侧「⋯」菜单，菜单里用对钩标出当前显示方式；新建会话、智能体团队 / 终端、更多与关闭按钮保留，宽度恢复后自动还原。同一菜单补齐命名图标（提示词 / 记忆 / 技能 / 诊断 / 日志目录 / 模型设置、显示方式与换侧），当前显示方式以对钩替代图标。
- **会话列表按工作区分页**：每个工作区分组默认只显示最近 10 条会话，超出时底部出现「···」，每点一次再多加载 10 条（进行中 / 已归档分组各自记忆，搜索结果不受限制；当前会话即使排在页外也保持可见）。分组标题右侧不再显示会话数量，改为鼠标悬浮时出现的「新建会话」与「会话操作」两个图标（与面板头部同名按钮行为一致）；分组头支持键盘 Enter / 空格折叠展开。
- **会话状态指示**：会话条目右侧在鼠标未悬浮时显示状态图标——转圈表示会话运行中，橙色 info 表示待确认（命令 / 写入审批、AI 提问、变量填写、计划待批准），绿点表示会话已在后台结束但还没查看，红点表示结束时报错；看过该会话（切到它或重新打开面板）后自动消失，状态随会话 meta 持久化。悬浮到条目上时图标换成原来的「⋯」会话操作入口。
- 技能管理对话框按来源**分组显示**：「用户 / 自定义技能」（工作区 / 应用数据 / 用户目录，逐条带来源徽标）在上，「内置技能」（随应用分发，版本更新自动刷新）在下，各组带标题与数量、点组名可折叠（内置组默认收起，折叠状态在本次运行内保留）；列表改为固定高度的内部滚动区，组头滚动时吸顶；启用勾选、打开 / 目录、新建技能等操作不变。

### 修复

- 修复模型选择器的「推理等级」在**自动**（默认档）时不显示选中高亮：内部把默认值存成空字符串，与选项值 `auto` 不匹配，现归一化后「自动 / 低 / 中 / 高」始终高亮当前档位。
- **外部修改不再被静默回滚**：打开文件时记录磁盘 mtime，文件被其他程序修改后——未编辑的标签自动重新加载（后台标签切换时重载，标签显示强调色圆点，标题注明「已在外部修改」）；已编辑的标签保留自己的缓冲区不自动覆盖，保存时弹出冲突对话框（**重新加载（放弃我的修改）/ 仍然覆盖 / 取消**）；自动保存遇到冲突会跳过并提示。写盘由 Go 侧 `SaveFileChecked` 在写入前校验 mtime，另存为 / 新建不校验。
- 修复设置 → AI 助手里点「记忆管理…」「技能管理…」会把设置窗关掉：现在对话框临时浮到窗口顶层、设置窗保持打开，关闭对话框后自动回到 AI 面板原位（模式切换等内部重开也保持顶层）。
- 悬浮 AI 窗口头部新增**全屏 / 收起**两个图标：全屏切换当前独立窗口全屏；收起最小化到任务栏（点任务栏图标恢复）。
- 修复独立窗口打不开：`parseConvertArgs` 把 `--new-window` / `--ai-float` / `--debug-console` 等 GUI 启动参数当成转换模式的未知参数直接退出（子进程报「未知参数：--new-window」，退出码 2），导致 AI 悬浮窗打开后主面板消失、调试控制台「独立窗口」无反应；现在只有带 `--convert` 时才把未知参数视为错误。
- 修复标签激活末尾常量重复赋值抛 `TypeError: Assignment to constant variable`（`lastTabSwitchLog` 声明为 `const` 后又被赋值），导致打开文件 / 虚拟文档（查看差异、文件历史等）时出现未处理的 Promise 拒绝。
- Git 面板未跟踪文件右键「查看差异」按「全部新增」生成补丁并打开（此前只提示「该文件暂无差异」，看起来像没反应）。
- 移除空内容欢迎页的「阅读书籍…」按钮（阅读模式仍可从 `视图 → 阅读模式` 与文件 / 目录右键进入）。
- 修正 CSV / JSONL 工具栏 **SQL 查询图标缺失**：视图图标表里没有 `sql` 键，按钮渲染成一块空白占位。现已补上数据库图标。
- **SQL 查询改为可开关的覆盖层**（对齐搜索栏的交互）：此前它是与表格 / 树 / 文本互斥的「视图模式」，点开会顶替视图选中态、切走还要重新解析。现在点一下在当前视图上方打开（SQL 按钮进入选中态，底层视图按钮保持自己的选中态，状态栏显示「SQL 查询」），再点一下关闭并原样恢复底层视图（不重新解析）；切换其他视图 / 分屏时自动收起。导入临时副本的来源仍为打开覆盖层时的当前视图。修复范围覆盖标签页工具条、底部「视图」菜单、快速切换面板、「查看」菜单与状态栏的选中态同步。
- 修正二进制 / 文本等只读视图的 **「Editing is disabled」提示**：① 文案是英文——jsoneditor 的语言包不进 Ace 的 nls 表，现启动时直接 `ace.config.setMessages` 注册「只读模式下无法编辑」，全部 Ace 实例生效；② 提示框继承 jsoneditor 容器的 `min-height: 150px`（hoverTooltip 会把编辑器主题类同步到 tooltip 元素上），变成一大块空框，现已归零为贴合内容的小框；③ 英文兜底观察器此前匹配不到（消息是 tooltip 容器的子节点插入），已改为向上找容器，作为语言包未生效时的兜底。
- **树视图新增右键菜单**：展开该节点 / 折叠该节点（按右键位置所在节点，叶子或已是目标状态时禁用）、全部展开、全部收起、复制树（当前树文本进剪贴板）。
- **树视图「全部展开」大文件防护**：jsoneditor 无虚拟滚动，「全部展开」会一次性渲染整棵树——约 3 万节点的文件（如 `docs/samples/json/long-blueprint.json`）要卡几秒，展开后浏览 / 编辑也长期卡顿。现在全部展开前先快速估算节点数（毫秒级），超过 12000 时弹出确认对话框说明后果并提示可右键「展开该节点」逐层展开；菜单、快捷键 `Ctrl+Shift+=` 与树视图右键菜单三个入口统一生效，小文件仍然直通。
- **代码文件状态栏不再显示「纯文本」**：此前所有代码文件都归入「纯文本」兜底格式，状态栏 / 操作记录一律显示「纯文本」。现把代码语言拆分为独立格式分组——Python、Go、Web 前端、C/C++、Java/Kotlin/C#、Shell/Batch、Ruby/PHP/Lua 等、SQL——状态栏按组显示正确名称；CMakeLists.txt / Makefile / Dockerfile / `.gitignore` 等仍留在「纯文本」组，状态栏按语法模式细化为 CMake / Dockerfile / Git 规则等。
- **Python 缩进改为默认 4 空格**（此前随「纯文本」组默认 2 空格，不符合语法）：每个代码语言分组有独立的编码 / 缩进 / 换行 / 默认视图设置——Python 4 空格、Go 用 Tab（gofmt 惯例）、Web 前端 2 空格、C/C++ 与 Java/Kotlin/C# 与 Shell 与 SQL 4 空格，均可在设置 → 数据格式 → 对应分组调整。
- **CMakeLists.txt 打开即代码视图并语法高亮**：此前扩展名命中 `.txt` 被当成纯文本打开（无高亮）。现对 CMakeLists.txt / Makefile / `.gitignore` / `.env` 等已知代码 / 配置文件名豁免纯文本视图，按代码视图打开。
- **窗口最大化时两侧不再出现调整宽度光标**：Wails 运行时的边缘 resize 检测不判断最大化状态，无边框窗口最大化后鼠标靠近左右（上下）边缘仍会亮起 `e-resize` / `w-resize` 光标。现在最大化时关闭该检测（还原、Win+方向键贴靠后自动恢复），最大化下边缘不再误报可调整。
- 修复系统重启后标签页偶发不恢复：会话存在与 AI 悬浮窗/调试控制台共享的 localStorage 里，辅助窗口启动时会把工作区当启动目标打开并写下一份空会话（`groups: []`），覆盖主窗口上次保存的标签页；恢复/工作区预热过程中的空快照也可能造成同样覆盖。现在辅助窗口不再读写编辑器会话，同工作区的空快照也不会覆盖已有标签页（只有主动关掉最后一个标签或关闭文件夹才写空）；运行日志会记录“会话恢复：保存 N 个标签页，实际打开 M 个文件”。
- 区分「工具执行失败」和「执行被中断」：应用关闭/重启时仍在运行的工具此前一律标成红色「失败」并只给一句结果未知提示，看着像工具返回了错误却没有详情。现在这类消息单独标为橙色「中断」，文案说明「应用在工具执行期间关闭或重启、未收到结果」，并随消息持久化（旧会话按旧提示前缀自动识别）；工具自身返回的失败仍显示具体错误（如 `工具执行失败：导航失败：…`）。
- 修正大文件代码视图行号错位：git 标记/书签所在的行号格被样式改成了 `position: relative`，而 Ace 的行号格本身是 `absolute` + 内联 `top` 定位，导致这些格子同时参与文档流并再叠加一次 `top`，连续被标记的行每行多走一个行高，行号越往下越往前漂（正文不受影响）。现已移除该定位覆盖，行号格恢复 `absolute`，git/书签左侧色条与行号重新对齐。
- 修正内嵌浏览器整页空白、只停在「网页区域加载中…」：① 宿主线程复用时若已被系统通知的 `RoInitialize(MTA)` 残留占用，`CoInitializeEx(STA)` 返回 `RPC_E_CHANGED_MODE` 导致宿主创建失败、所有浏览器任务干等 60 秒看门狗超时——现在先清掉线程上残留的 MTA 再重试 STA，初始化失败也会立即报错而不卡住；② WebView2 控件创建后 z 序落在主 WebView 之下（页面其实已加载，只是被盖住）——现在每次显示/调整尺寸都把它提到最上层，且在菜单、命令面板、AI 面板全屏、对话框打开时自动隐藏；③ 地址栏左侧新增浏览器图标（用系统默认浏览器打开当前网址/文件），右侧新增「更多」（复制网页地址、在新标签页打开、刷新、停止加载），地址栏同时支持直接粘贴 Windows 本地路径并自动转成 `file://`。
- 浏览器截图（`browser_screenshot`）自动附加的图片改为「应用消息」卡片呈现（标题 + 缩略图 + 点击看大图），不再渲染成用户胶囊；旧会话里的同款消息按前缀识别后也走新样式。图片预览对话框新增「复制」按钮（写入系统剪贴板），右键图片可复制图片或另存为本地文件。
- 修正阅读模式打不开的问题：顶栏标题函数缺失导致书架/详情/章节渲染抛错；EPUB 读的是 Go 结构体的 PascalCase 字段（实际下发 `json` 小写键），EPUB 章节为空；朗读入口调用了作用域外的 `stop`；从书架进入后「阅读此文件」误进详情页；书架「N 个文件」显示 undefined。
- 修正写作模式在纯文本「文本视图」下码字统计不刷新（统计只挂了 Ace，textarea 输入没接防抖管线）；总开关关→开时「本次」基线不重置；关闭段落聚焦后遮罩残留；码字统计/起名器对话框点遮罩不关闭。
- 阅读模式 DOCX 增加解压上限（单条 50 MB / 整包 200 MB），防压缩炸弹；EPUB 章节高亮的 CSS Highlight 能力增加完整特性检测。
- SQL 视图拒绝 `ATTACH` / `DETACH` / `VACUUM`：此前可通过 `ATTACH DATABASE '路径'` + 建表把数据写到任意文件；临时副本上的 INSERT/UPDATE/DELETE 仍然可用。
- 插件目录模式下拉框回显已保存值（补 `GetPluginsPathMode` 后端接口，原先永远显示「程序目录」）。
- Mermaid 渲染出的 SVG 增加 DOMPurify 二次消毒（保留 style/foreignObject 以维持图表样式）。
- 内置字体改为 woff2、KaTeX 只打包 woff2 字形：安装包体积减少约 1.3 MB。
- AI 面板内的权限 / 模型 / 更多等弹出菜单不再被流式输出打断：消息区自动滚动或工具卡片插入时，来自 AI 面板的菜单会忽略面板内部滚动，保持打开，直到点击外部或按 Esc。
- 取消 AI 改写目标文件的 512KB 硬限制：`edit_file` / `write_file` 现在可以修改 `ai-panel.js` 这类大文件；大文件 diff 超过 4000 行时自动降级为公共前后缀 + 中间变更块，审批预览最多 40 行，避免整文件 diff 卡顿。有效上限回到应用自身的读取限制（>10MB 的文件仍不可读写）；单次写入内容仍保持 256KB 上限。
- 修正统计行的 **tok/s 计算**：原先分母用 `模型往返耗时`（含首 token 延迟），且在本轮缺少模型耗时时回退到**整轮耗时**（从用户发消息算起，含全部工具调用与之前所有步骤），导致多步任务的速度被严重低估。
  - 现在分母改为 `模型往返耗时 − 首 token 延迟`，即真实解码速度。
  - 只统计「有 usage 且有模型耗时」的轮次，不再回退整轮耗时。
  - 非流式返回无法测出生成窗口时，退化为端到端吞吐，鼠标悬停 tok/s 可看当前口径。
  - 以「TTFT 2s + 生成 1.5s + 输出 120 tok」的典型抽样为例，旧的显示值比真实解码速度低约 40%，叠加一次整轮耗时回退后低约 70%。
- 修正 **上下文占用估算**：原先只累加消息的 `content`，漏掉思考链（`reasoning`）与工具调用参数（`toolCalls[].arguments`），而这两项真实参与请求。
  - 实测某长会话：真实 `usage` 输入 87,044 tokens，旧算法只估出 55,899（**低 36%**）；补上思考链后为 81,824（偏差 −6%）。该会话思考链共 102,782 字符，占内容总量的 35%。
  - 后果一：composer 的上下文百分比环系统性偏低，看着还有余量，实际已接近上限。
  - 后果二：自动压缩同样按低估值判断，触发时真实占用早已超过窗口。
  - 现在百分比环、上下文弹层、发送前 90% 预警、自动压缩**共用同一个估算函数**，口径一致。
- 修正 **已压缩会话在界面上「凭空消失」**：压缩会把几十上百条消息挪进 `session.archived`，而消息流只渲染 `session.messages`，归档内容此前只在「查看已归档消息」弹窗里可见。
  - 消息流顶部新增常驻摘要卡：「上下文已压缩 · 归档 N 条 · 保留 M 条」，点击可展开摘要全文与归档原文（只读、内部滚动、不参与请求）。
  - 归档消息不显示复制 / 编辑重发 / 重新生成按钮，避免操作打到当前消息的错误索引上。
- 已归档消息超过上限（5000 条）时不再静默丢弃，改为提示先导出 Markdown 留存。
- 压缩摘要卡补充**触发快照**：显示自动/手动、压缩时的窗口大小、估算占用与阈值、模型名、压缩时间。「凭什么压缩」事后可自证。
- 会话数量不再自动清理：改存磁盘后没有容量压力，删除交给用户手动操作（进回收站）。
- AI 助手的文件写入 / 编辑 / 终端命令审批改为**接管输入区**：待审批时 composer 位置直接展开审批卡片，消息流里只留一条「等待审批…」占位。
  - diff（或命令内容）吃满可用高度并在内部滚动，「放弃 / 应用（执行）」固定停在底部操作条，长 diff 不再把按钮推到视野外。
  - 「本会话允许此文件 / 总是允许此文件」随按钮一起固定在底部。
  - 移除待审批卡片左侧的 2px 强调色边框，等待态改由卡片状态文字表达。
- AI 面板：内联 diff / 工具卡片展开时会把消息区底部的「甜澄漫游中」流式状态条顶出视口；现在卡片原位更新后（处于跟随底部状态）自动滚到文档末尾，状态条保持贴在输入区上方（仍为文档流内，非 sticky；手动上滚查看历史时不打扰）。
- 修正 **SVG 渲染视图切到分屏后右侧预览空白**：从树视图点「渲染」时，编辑器内容会被 jsoneditor 序列化成 JSON（渲染视图本身正常），此时再点「分屏」会把这段 JSON 塞进 `data:image/svg+xml`，`<img>` 解码失败、右侧只剩一片空白。现在进入渲染视图时立即把 SVG 源文本写回编辑器，分屏与渲染统一从 `_svgSrcText`（渲染视图下的真源）取文本；取到的内容不含 `<svg>` 根元素时不再渲染。
- SVG 渲染失败不再静默留白：`<img>` 补上 `onerror`，解码失败或源码不是 SVG 时隐藏图片，并在预览区中央显示原因。
