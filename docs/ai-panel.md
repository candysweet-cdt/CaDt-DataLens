# AI 助手面板 v1 方案（Agent 全套 · 计划，待批准后实施）

> 状态：**已实施（批次 1–6 完成）+ 2026-11-10 UI 改版（精简发送区 / 权限三档 / 独立悬浮窗 / 模型设置页 / 轮次计时与过程折叠 / 会话管理迁左侧边栏）+ 2026-11-10 Agent 能力补齐（会话归档 / 内置技能 / 通知 / AskQuestion / Plan 模式 / 消息排队与插话 / composer 接管 / 状态栏 AI 宽度）** · 拟定日期：2026-11-10（v9 修订：斜杠命令与上下文管理——/context /compact /clear /model 等 + 上下文窗口配置）
> 定位：IDEA / Qoder 式**右侧 AI 助手面板**：多会话流式聊天 + **思考链流式显示**（R1 类 reasoning / Claude thinking）+ **Agent 能力**（范围模式 / 工具调用 / 写操作审批 / Todolist / 变更记录）+ **提示词系统**（预设模板 / 会话临时改 / 上下文与 AGENTS.md 自动注入）+ **记忆系统**（双模式持久记忆）+ **技能系统**（SKILL.md 双目录 + skill_use）+ **多配置 Profile** + **三种显示方式**（停靠 / 吸附 / 悬浮）+ **斜杠命令与上下文管理**（/compact 压缩、/context 统计）。
> API 由用户自配，协议：**OpenAI 兼容 + Anthropic 原生**。
> 安全原则：API Key 只存前端 localStorage、不落 Go 磁盘、不进日志；工作区文件写操作全部经用户审批。

---

## 0. 2026-11-10 UI 改版

- 显示方式：停靠 / 全屏（仅覆盖文件内容区）/ 悬浮（独立进程窗口，可移动到其他屏幕）。
- 发送区：`+` 菜单附加文件/技能/指令；权限胶囊（仅可查看 / 工作区内修改 / 完全权限，完全权限二次确认）；模型胶囊（切换配置与推理等级）；圆形发送/停止按钮。
- 权限：完全权限对工作区内写操作自动应用，并允许工作区外绝对路径；工作区内修改仍需逐次审批。
- 设置：新增「模型」页，承载 Profile / API / 模型 / 上下文窗口 / 思考等级 / 代理 / 自定义头 / 预设 / 导入导出；已配置模型以卡片列表展示，新建/编辑使用独立三级弹层（保存生效、取消回滚、支持复制/删除/设为当前）；「AI 助手」页保留记忆、提示词、审批与聊天行为。「模型」与「AI 助手」在设置导航中归入可折叠的「AI」组（与「数据格式」同构）。
- 弹层：从设置内打开确认框/命名框时，设置弹层保持可见，关闭确认框后回到设置；终端标签页关闭图标按 SVG 子元素命中修复；独立调试控制台关闭走 `runtime.Quit`/`ForceClose`。
- 悬浮窗内的设置入口经单实例 IPC 转发到主窗口；主窗口未运行时启动主窗口并直接打开对应设置页。
- 头部：移除独立最大化按钮；新建/重命名/删除/导出/提示词/记忆/技能收进「⋯」菜单。
- 会话管理：从面板头部移出，改为左侧活动栏「AI 会话」视图（`Alt+8`）；列表显示标题、消息数、最近活动时间，当前会话高亮；支持新建、切换、重命名、导出、删除（行内 ⋯ 或右键菜单）。面板头部只保留标题、显示方式、变更、⋯、关闭；悬浮窗因没有左侧边栏，会话操作保留在 ⋯ 菜单。
- 轮次计时与过程折叠：每轮用户消息到最终回答之间的思考、工具调用和中间说明收进 `.ai-process` 折叠行（「已完成，用时 7 分 26 秒」）；流式中默认展开并每秒更新用时，完成后默认收起，点击展开；最终回答始终显示在折叠行之外；耗时随会话持久化（`turnStartedAt` / `turnMs` / `finishedAt`）。
- 图片粘贴：composer 支持 Ctrl+V 粘贴剪贴板图片，自动压缩（≤1600px）、最多 6 张、缩略图/预览/移除；图片随 user 消息以多模态内容发送（OpenAI `image_url` / Anthropic base64 image）；图片-only 消息可直接发送。
- 对话日志：默认每轮自动保存 Markdown 到应用数据目录 `ai-logs/`，图片落到 `ai-logs/images/` 并在日志中引用；设置 AI 页可开关、查看路径、打开目录；侧栏会话菜单与面板 `⋯` 均可打开日志目录；日志不含 API Key。
- 内容宽度（停靠 / 全屏通用）：AI 面板打开时状态栏显示「AI 宽度」按钮，可选自动（默认）/ 跟随 / 720 / 860 / 920 / 1100 / 1300px，消息区、composer、统计行与 todos 按该宽度居中；设置存入 `datalens-settings.aiFullscreenWidth`，默认自动。

## 0.1 2026-11-10 Agent 能力补齐

- 会话归档：会话菜单新增「归档会话 / 取消归档」；归档会话从活动列表移入可折叠「已归档」区，保留查看、重命名、导出与取消归档；归档会话禁止继续发送/压缩，且不会被会话数量上限优先淘汰。持久化字段 `archivedAt`。
- 内置技能：随包内置 `code-review`（只读代码审查）、`json-toolkit`（JSON/JSONL/YAML/TOML/CSV 校验与修改）、`release-notes`（更新日志/发布说明）三个技能；技能列表、`/skill`、`skill_use` 与技能管理统一可见，支持启用/禁用；同名用户技能优先覆盖内置。
- 通知：任务完成、任务失败、AI 提问时显示应用内 toast（可点击跳到对应会话）；窗口失焦时应用内通道还会让任务栏闪烁并可播放提示音；系统级 Windows Toast 独立开关。设置 → AI 助手 → 通知可分别开关应用内通知、系统通知、完成/失败/提问事件与失焦提醒。
- AskQuestion：新增 `ask_user` 工具，一次最多 5 个问题；每题可单选或多选，可标记推荐项，可允许自定义回答；提问和计划批准会接管底部 composer（不再插入消息流），回答后恢复输入框并在转录中保留只读问答记录。设置项：超时时长（不超时/30 秒/1 分钟/5 分钟/10 分钟/30 分钟）与超时处理（按 AI 推荐项继续 / 继续阻塞等待 / 直接停止本轮 / 交给 AI 决定）。超时停止会结束本轮；超时继续会把结果作为工具结果交回模型。
- Plan 模式：composer 新增「计划」胶囊，`/plan` 进入、`/plan off` 退出，`/plan <指令>` 进入并直接开始规划；计划模式下不提供 `write_file` / `edit_file`，提示词要求只读探索并输出 Markdown 计划。计划完成后在底部 composer 接管处显示计划预览与「继续规划 / 执行计划」；执行时自动退出计划模式并发送批准指令；仅可查看权限下会提示先切换编辑权限。计划模式状态随会话持久化。
- 底部 composer：改为带圆角/阴影的浮动面板；队列、附件和输入框都在面板内。提问/计划批准会临时替换面板内容，回答或决定后恢复。
- 消息排队与插话：生成中 Enter 把消息加入排队（面板内可见、可移除/插话），本轮结束后自动发送；Ctrl+Enter 立即插话（停止当前回复并把该消息排到队首）；普通停止不自动清空队列。
- AI 内容宽度：状态栏「AI 宽度」按钮（和 Markdown 预览宽度一样使用状态栏弹出菜单）；停靠与全屏模式均显示，选项自动（默认，< 920px 跟随、≥ 920px 最大 920px）/ 720 / 860 / 920 / 1100 / 1300 / 跟随。
- 思考链：支持 Markdown 渲染；思考时长按每轮助手消息统计（含工具调用轮，<1 秒显示「<1 秒」）；展开/收起状态在重渲染后保留；去掉了思考卡片的左边框。
- AI 代码块右上角提供「复制」按钮，复制整块代码（含流式输出中的代码块）。
- AI 消息右键菜单：可复制所选文本、复制代码块、复制整条回复/消息/工具输出、全选对话；不再弹出主编辑区空白菜单。
- AI 字号与字体：聊天字号范围 10–32，滑动条与数字输入联动，AI 面板内 Ctrl+滚轮可直接调整并持久化；设置 → AI 助手 → 聊天行为新增英文字体、中文字体、代码字体三个选择，可分别跟随界面/编辑器或指定字体，分别作用于 AI 对话与代码块。
- 推理强度：模型芯片显示「模型 · 推理强度」；OpenAI 兼容配置新增 `reasoning_effort` 设置（自动/低/中/高，自动不发送该字段），Anthropic 继续使用扩展思考预算。
- Composer 统计行：输入框下方显示「轮 / 步 · tok/s · 总 tokens · 缓存命中」与上下文百分比环；两组统计可点开弹层：会话统计（模型用时 / 工具调用用时 / 首 token 平均 TTFT / 输出速度 TPS）与 Token 用量（缓存命中 / 未缓存输入 / 缓存读取 / 输出）；点环弹出上下文构成（系统提示词 / 工具定义 / 对话消息）与「压缩上下文」按钮；上下文占比估算现包含工具定义。
- AI 回复默认无卡片边框（只有用户消息保留气泡）；设置 → AI 助手 → 聊天行为可开启「AI 回复显示卡片边框」恢复边框与底板。
- 兼容 dsh 约定：参考 `deepseek-harness` 的 user-questions / plan-mode 设计，超时把结果放行给模型而不是伪造用户回答；计划模式采用「先评审、后执行」；归档会话不能继续执行模型步骤。

---

## 1. 背景与目标

用户在查看 JSON/日志/CSV/Markdown 时需要：① 解释/总结/翻译当前内容（聊天）；② 让 AI 在工作区里查文件、改文件（Agent）；③ 全程可控——工具卡片/审批/变更记录/范围模式；④ 项目约定自动生效（AGENTS.md）；⑤ AI 跨会话记住重要事实与偏好（记忆系统，双模式存储）；⑥ 多个 API 配置一键切换；⑦ 领域能力扩展（技能系统，SKILL.md 按需加载）。v1 一次到位做全。

**总体架构决策**（已按代码核实）：

- **Agent 编排放前端**，工具执行直接复用既有 Go 绑定（`OpenFile` / `ReadDir` / `SearchWorkspace` / `SaveFile`）；**Go 仅新增 2 个小方法** `AIAppDir`（应用数据根）与 `AIEnsureDir`（建目录），供记忆/技能目录解析。
- **Go 只做两件事**：双协议 HTTP + SSE 流式转发（归一化事件）；记忆/技能目录解析。
- 审批、diff、范围检查、todolist、变更记录、记忆读写编排全在前端，Git 历史作工作区改动回退兜底。

---

## 2. 现有基础设施盘点（已核实）

| 设施 | 位置 | 用途 |
|---|---|---|
| 右停靠布局 | `index.html:648` `#top-row`（`#sidebar` + `#main-pane`） | 新 `#ai-panel`；宽度拖拽走统一 resize 规则（`pushRule` `main.js:11736`） |
| 活动栏 | `index.html:614-645`；`aria-pressed` 模式 `main.js:11960` | 新 `ab-ai`（顶组 `ab-git` 后）；**Alt+9 空闲** |
| Go→JS 事件 | `term-out` 先例（`main.js:940` EventsOn 包装；`app.go:87` EventsEmit） | AI 事件：`ai-chunk` / `ai-toolcall` / `ai-done` / `ai-error` |
| Go HTTP | `update.go:19` / `market.go:24` client 先例 | ai.go 无整体超时 client + 空闲 watchdog |
| 绑定 | `main.go:63` 单 App 结构体 | 新方法自动暴露 |
| **工具绑定** | `OpenFile(path,enc)` `app.go:254`；`ReadDir(path,limit)` `app.go:619`；`SearchWorkspace(root,query,cs,max)` `search.go:102`；`SaveFile(path,content,eol,hasBom,enc)` `app.go:475` | **Agent 工具复用**；SaveFile 是否自动建目录在批 3 实测（AIMemoryDir 内 MkdirAll 兜底） |
| Markdown 渲染 | `renderMarkdownHtml` `main.js:2976`（hljs/mermaid/DOMPurify） | 回复渲染；经 options 回调注入 ai-panel.js |
| 插入双路 | `jumpToPosition` `main.js:2046` | 代码块插入/替换选区 |
| mockBackend / mockRt | `main.js:931` / `936`（EventsOn 可回放） | 浏览器开发全流程可测 |
| 设置 pane + 搜索 | snav-item 模式；`buildSettingsSearchIndex` `main.js:1747` 自动扫描 `.popover-row` | 新 pane「AI 助手」 |
| 文件树右键 | explorer.js 右键菜单（已有 属性/复制/删除 等项） | 加「在 AI 中询问此文件」 |
| 日志 | `logFrontend` `main.js:977` → logging.go | AI 错误记录，**不落 key** |

---

## 3. UI 设计

`index.html` 新增**单一** `<aside id="ai-panel" class="hidden">`（默认停靠形态挂在 `#top-row` 内 `#main-pane` 之后；吸附/悬浮形态是**同一个 DOM** 改为 overlay 定位，见 §3.2）：

```
#ai-panel
├─ #ai-resize                        ← 左缘宽度拖拽（pushRule 'ew'）
├─ .ai-head
│   └─ 标题 + 显示方式切换（停靠/全屏/悬浮）+ 「变更(N)」 + 「⋯」 + 关闭
├─ #ai-todos                        ← Todolist 区（todos 非空时显示）
│   └─ 每项：○ 待办 / ▶ 进行中(高亮) / ✓ 完成(划线) + 进度 N/M；全部完成折叠成单行
├─ #ai-messages                     ← 消息流（唯一滚动容器）
│   ├─ .ai-msg.user / .ai-msg.assistant
│   ├─ .ai-process                  ← 轮次过程折叠：思考/工具/中间说明；显示「已完成，用时 X」+ 展开/收起
│   │   ├─ .ai-msg.assistant        ← 本轮中间说明
│   │   ├─ .ai-msg.tool             ← 工具调用卡片
│   │   └─ .ai-think                ← 最终回答的思考过程（完成后移入折叠）
│   ├─ .ai-msg.assistant            ← 最终回答（始终在折叠之外）
│   └─ .ai-empty                    ← 未配置 API 空态（「去设置」→ openSettings('models')）
├─ .ai-scroll-btn                   ← 离底 >200px 显示「回到底部」
└─ .ai-composer
    ├─ .ai-attach                   ← 附加 chips：当前文件 / 选中内容 / 附加文件… / 技能…
    ├─ textarea#ai-input            ← Enter 发送 / Shift+Enter 换行 / 生成中禁用
    └─ .ai-composer-bottom          ← + / 权限胶囊 / 上下文提示 / 模型胶囊 / 发送/停止
```

- 会话管理不在面板头部：左侧活动栏「AI 会话」视图（`Alt+8`）独立承载（见 §4）。
- 宽度 `settings.aiPanelWidth` 默认 380（280–640）；窄窗（<900px）打开时自动收文件侧栏。
- 入口：活动栏 `ab-ai`、**Alt+9**、视图菜单「AI 助手面板」（checked）、命令面板。
- 生成中指示：assistant 气泡尾三点动画；工具轮间隔显示「正在调用 xxx…」。

### 3.1 思考链折叠区（.ai-think）

- 助手回复若带思考链（reasoning/thinking），正文上方显示「思考过程」折叠区：次要色、小字号。
- **流式进行中默认展开**实时滚动；完成后自动收起为单行「已深度思考 · 用时 Xs · N 字」，点击可展开全文。
- 开关 `opt-ai-show-thinking`（设置 AI pane，默认开；关闭则完全隐藏思考区，仅保留收起态标题）。

### 3.2 三种显示方式（`settings.aiFloatMode`：`dock` / `fullscreen` / `float`，默认 `dock`）

| 方式 | 形态 | 几何 | 持久化 |
|---|---|---|---|
| **停靠 dock**（自适应分屏） | `#top-row` 内 flex 子项；内容区**没有打开文件时自动占满内容区**（隐藏 `#main-pane`），打开文件后自动回到右侧分屏 | 分屏宽度 280–640；占满时隐藏拖宽手柄；内容宽度按「AI 宽度」居中 | `aiPanelWidth` + `aiFullscreenWidth` |
| **全屏 fullscreen** | absolute 铺满 `#main-pane`，只替换/隐藏文件内容区，不改变侧边栏、活动栏、终端 | 一键还原；内容宽度按「AI 宽度」居中 | `aiFullscreenWidth`（默认自动） |
| **悬浮 float** | **独立进程窗口**（`--new-window --ai-float`），可移动到其他屏幕 | 独立窗口尺寸 | 启动时创建窗口尺寸 |
| 切换入口 | 面板 head 三态按钮（停靠 / 全屏 / 悬浮）+ 视图菜单 | — | 停靠/全屏记 `aiFloatMode` |
| 悬浮 | 主面板关闭，独立窗口打开；窗口内设置入口经 IPC 回主窗口；关闭按钮退出该进程 | — | — |
| dock/fullscreen 切换 | head 双击空白区切换 | — | — |

### 3.3 轮次计时与过程折叠（`.ai-process`）

- 每轮（user 消息 → 最终 assistant 回答）的思考、工具卡片、中间 assistant 说明收进 `.ai-process`。
- 流式中默认展开，标题「处理中，用时 X」，每秒刷新；完成后默认收起，标题「已完成，用时 X」（停止→「已停止」，错误→「已失败」）。
- 最终 assistant 正文始终在折叠之外；完成后其思考过程移入折叠内（设置关闭思考显示时不渲染）。
- 无过程且无思考的简单回答仍显示耗时行（不可展开）；旧会话没有耗时数据时只显示「已完成」。
- 折叠展开状态仅内存保存，切换会话/重启后回到默认收起。

---

## 4. 会话管理

- 入口：左侧活动栏「AI 会话」视图（`Alt+8` / 视图菜单 / 命令面板 `AI 会话`）。侧边栏列表显示标题、消息数、最近活动时间，当前会话高亮；按最近活动倒序。
- 操作：头部 `+` 新建；行内 `⋯` 或右键重命名 / 导出 / 删除；头部 `⋯` 对当前会话执行同名操作。点击会话条目切换并在面板关闭时自动打开 AI 面板。
- **长会话懒加载**：打开/切换会话时只渲染最近一段消息，初始窗口至少约 1M tokens（取 `1M` 与当前 Profile `contextWindow` 的较大值，按估算 tokens 从末尾回溯并按轮次对齐）；列表顶部显示「↑ 上方还有 N 条更早消息」，上滑触顶或点击后按约 250k tokens 分块补载，并补偿滚动位置保持视口不跳。消息变少（`/compact`、编辑重发、清空）时窗口自动重置；窗口状态仅内存保存，重启后重新从最近一段开始。
- localStorage `datalens-ai-sessions`：`[{id, title, createdAt, scope, systemPrompt?, promptTemplateId?, profileId?, todos[], changes[], messages:[{role, content, images?:[{id,mime,data,width,height,name,logFile?}], toolCalls?, ts, model, reasoning?, turnStartedAt?, turnMs?, finishedAt?}], summary?:{text, upTo, createdAt}, archived?:[], logFile?, logSavedAt?}]`；当前会话 id 存 `datalens-ai`。
- 图片受 localStorage 预算保护：全局图片数据超过约 3.2MB 时，旧图片会只保留 `logFile` 引用并从消息中移除 base64；对话日志仍保留完整图片文件。
- 标题自动取首条用户消息前 20 字；新建/切换/重命名/删除；消息上限 200 条。
- 持久化时机：每轮（含工具轮）结束后写入；流式中不写盘。轮次耗时存于最终 assistant 的 `turnMs`，用户消息带 `turnStartedAt`。
- **导出会话为 Markdown**：侧边栏行内 `⋯` 或面板 `⋯`（悬浮窗）→ `SaveFileDialog` → 用户/助手段落 + 工具调用摘要 + 变更记录附录。

---

## 5. 常用消息功能与斜杠命令（v1 全套）

| 功能 | 行为 |
|---|---|
| 重新生成 | 最后一条 assistant 回复 hover「重新生成」→ 截断该条 → 以相同上下文重跑（可换 Profile/模型后重试） |
| 编辑并重发 | 最后一条 user 消息 hover「编辑重发」→ 内容回填输入框 → 确认后截断其后所有消息重发 |
| 复制消息 | hover「复制」→ 原始 markdown 进剪贴板（`copyText`）；用户消息的时间与操作默认隐藏，hover 消息胶囊时显示在气泡下方 |
| 思考链展开 | 过程折叠展开时，中间轮次与最终回答的思考链均展开；折叠收起后全部隐藏 |
| 导出会话 md | 见 §4 |
| 附加文件… | composer chips「附加文件…」→ `OpenFilesDialog` 选择（可多选，≤64KB/个） |
| 粘贴图片 | 输入框 Ctrl+V 直接粘贴剪贴板图片：自动压缩到 ≤1600px、最多 6 张、单张 base64 ≤3MB、单条消息 ≤6MB；composer 显示缩略图，可点开预览/移除；发送时作为 user 消息的 `images[]`，OpenAI 走 `image_url`、Anthropic 走 base64 `image` block；图片-only 消息可直接发送。 |
| 对话日志 | 每轮自动把当前会话写成 Markdown 到 `%APPDATA%\CandySweet\CaDt-DataLens\ai-logs\`，图片存到 `ai-logs/images/` 并在日志中引用；设置 AI 页可开关/打开目录；日志不含 API Key。 |
| 文件树/标签右键「在 AI 中询问此文件」 | explorer / tab 右键菜单加项：打开面板 + 附加该文件 + 输入框聚焦 |
| 回到底部 | 离底 >200px 显示悬浮按钮 |
| 上下文用量 | 发送行「本次约 N 字符」实时更新（附加/注入变化即变） |
| 错误重试 | 出错的 assistant 气泡带「重试」按钮（重跑该轮） |
| 停止生成 | 停止按钮（含审批等待中止） |

**不做**（v1 明确排除）：消息引用回复、拖拽文件到面板附加（与全窗口 OnFileDrop 打开文件语义冲突，后续用拖放目标区分再做）。

### 5.1 斜杠命令（composer 输入 `/` 触发内联补全）

| 命令 | 作用 | 备注 |
|---|---|---|
| `/context` | **上下文统计**：会话消息数/字符数/**估算 tokens** 与 `contextWindow` 占比；系统注入（提示词+AGENTS.md+记忆+技能索引+workspace_context）估算；待发送附加内容；最近一次 API `usage` 实际值（若有）；超阈值给出「建议 /compact」 | 纯前端计算，不发请求 |
| `/compact` | **压缩上下文**：用当前 Profile 对会话做摘要（幕后一次性请求，不计入对话流），历史替换为「摘要 + 保留最近 6 条」；**压缩前原文存入会话 `archived[]`**（可查看不发送） | 进行中显示进度、可取消 |
| `/clear` | 清空当前会话消息（会话保留） | 需确认 |
| `/model` | 打开 Profile 切换下拉 | 等效 composer 下拉 |
| `/export` | 导出会话为 Markdown | 等效 head 按钮 |
| `/memory` | 打开记忆管理对话框 | 等效 head「记忆」 |
| `/skill <name>` | 手动调用技能（全文注入下一轮） | 等效「技能…」chip |
| `/init` | 生成 `AGENTS.md` 模板到工作区根（无则创建；已存在提示） | 写入走审批卡片；无工作区禁用 |
| `/help` | 命令列表 | — |

- 补全交互：输入 `/` 弹出内联列表（复用 palette 的模糊匹配打分），↑↓ 选择、Enter 执行、Tab 补全、Esc 关闭；未知命令提示「未知命令，输入 /help」。

### 5.2 上下文统计与压缩机制

- **Token 估算**（无 tokenizer 依赖）：`tokens ≈ ceil(ascii字符数/4 + CJK字符数×0.75)`，界面标注「估算」；有 API `usage` 返回值时展示实际值并标注。
- **压缩后请求构建**：`msgs = [{role:'system', content:'<会话摘要>…'}] + 最近 6 条原文`；摘要存 `session.summary {text, upTo, createdAt}`，`upTo` 之前的消息进 `archived[]`。
- **阈值提示（不静默压缩）**：估算占比 ≥ `autoCompactThreshold`（默认 80%）时，输入区上方显示 banner「上下文约 X%，建议 /compact」+ 一键按钮；**默认不自动压缩**（摘要会丢信息，交用户决策）。
- **输入硬限**：单轮请求总估算 tokens > `contextWindow` 时阻止发送并提示（先 /compact 或减附加）；阈值预留 10% 余量（估算误差）。

---

## 6. Go 侧（新文件 `ai.go`，流式转发 + 目录解析）

```go
type AIConfig struct { Provider, BaseURL, APIKey, Model string; Temperature float64; MaxTokens int }
type AIMessage struct { Role string `json:"role"`; Content string `json:"content"`; Images []AIImagePart `json:"images,omitempty"` }
type AIImagePart struct { Mime, Data string } // Data 为 base64（不含 data: 前缀）；只允许 user 消息
type AIToolDef struct { Name, Description string; Parameters json.RawMessage }        // 前端构造，Go 透传
```

**AISendChat(sessionId, cfg, messages, tools)**：goroutine 流式 → 归一化事件：

| 事件 | 载荷 | 说明 |
|---|---|---|
| `ai-chunk` | `{id, delta}` | 文本增量 |
| `ai-think` | `{id, delta}` | **思考链增量**（reasoning/thinking 归一通道） |
| `ai-toolcall` | `{id, index, callId, name, argsDelta}` | 工具调用增量（首包带 callId/name，后续仅 argsDelta；前端按 index 累积） |
| `ai-done` | `{id, finishReason, thinkingSignature?, usage?}` | `'stop'` 或 `'tool'`（Anthropic `tool_use` 归一）；thinkingSignature 供 Anthropic 多轮回传；usage = 响应携带的 token 用量（prompt/completion，可选） |
| `ai-error` | `{id, message}` | 含 HTTP 非 2xx body 截断 500 字 |

- **OpenAI 兼容**：`POST {base}/chat/completions`，`tools:[{type:'function',function:{name,description,parameters}}]`，流式累积 `delta.tool_calls[]`（按 index），`finish_reason='tool_calls'`。**思考链**：`delta.reasoning_content`（DeepSeek-R1/Qwen/GLM-Z 系）或 `delta.reasoning`（OpenRouter 归一）→ `ai-think`；此类模型历史消息**不回传** reasoning。**图片**：user content 使用数组 `[{type:'text'},{type:'image_url',image_url:{url:'data:<mime>;base64,...'}}]`。
- **Anthropic 原生**：`POST {base}/v1/messages`，`x-api-key` + `anthropic-version: 2023-06-01`，system 单列，`tools:[{name,description,input_schema}]`；**事件块解析**（`event:`+`data:` 成对）：`content_block_start(tool_use)` → `input_json_delta` 累积 → `message_stop(stop_reason='tool_use')`。**思考链**：`content_block_start(type:'thinking')` → `thinking_delta` → `ai-think`；`signature_delta` 累积进 `ai-done.thinkingSignature`（多轮工具调用回传必需）；请求体在 profile 开启时带 `thinking:{type:'enabled', budget_tokens}`。**图片**：user content blocks `{type:'image',source:{type:'base64',media_type,data}}`。
- sessionId 规则：前端每轮传 `session.id + '#' + round`，事件按前缀归属。
- 超时：Dialer 10s，无整体读超时，**空闲 chunk watchdog 120s**。
- **代理与自定义头**（per profile）：cfg.`proxy`（`'direct'` / `'system'` / 自定义 URL）→ 每请求独立 `http.Transport` 的 Proxy；cfg.`extraHeaders`（k=v，≤8 条）随请求附加。日志不含头内容与代理凭据。
- `AIStop(sessionId)`（context cancel，前缀匹配）、`AITestConnection(cfg)`、`AIListModels(cfg)`（仅 OpenAI 兼容 GET /models）。
- **AIAppDir()**：返回应用数据根 `%APPDATA%\CandySweet\CaDt-DataLens`（记忆 app 模式 = 其下 `ai-memory\`，技能 app 级 = 其下 `ai-skills\`，对话日志 = 其下 `ai-logs\`，子目录由前端拼接）。
- **AIEnsureDir(path)**：`MkdirAll` 任意目录（记忆/技能目录首次写入前调用）；workspace 侧目录 = `<workspaceRoot>\.cadt\{memory,skills}\`（前端拼接）。全 v1 仅这两个新增 Go 方法。
- 日志只记主机/model/状态码/耗时，**不记录 apiKey 与请求体**。
- mockBackend：`AISendChat` 用 mockRt 回放预置流（含一次工具调用序列），Go 方法全配 mock。

---

## 7. Agent 循环（前端 `ai-panel.js`）

```
runTurn(session, userMsg):
  for round = 0..15（上限防死循环）:
    累积流 = await streamRequest(msgs, toolsFor(session.scope), sid = session.id+'#'+round)
    渲染文本/工具调用卡片
    if finishReason === 'stop': break
    for each toolCall:
      result = await execTool(toolCall)     // 工作区写工具 → 审批卡片 await 用户；停止可中止
      msgs.push(toolResultMsg(result))      // 失败/拒绝也回传给模型
  超过 15 轮 → assistant 提示终止
```

- 事件分发：`rt.EventsOn` 注册一次，按 sessionId 前缀路由；后台会话静默累积。
- 流式渲染 80ms 节流 + 智能滚底（离底 >80px 暂停跟随）。
- 停止：`AIStop` + 放弃当前轮 + 审批等待中的工具结果记「用户中止」。
- 每轮请求的 cfg 取**当前 active Profile**（§13）；会话 `profileId` 记录最后使用的配置（仅展示用，不锁定）。
- **思考链回传规则**：message 存 `reasoning`（全文）+ `thinkingSignature`；**Anthropic** 工具轮间回传 `[{type:'thinking', thinking, signature}]`（置于 assistant content 前，签名校验必需）；**OpenAI 兼容类不回传** reasoning（DeepSeek-R1 等明确禁止）。
- **/compact 请求**：独立一次性调用（复用 AISendChat 事件流收集结果，不占 Agent 轮次、不写对话消息流）；摘要生成后按 §5.2 重建请求上下文。

---

## 8. 工具桥（v1 十一个工具）

| 工具 | 执行（前端包装） | 档位 | 审批 |
|---|---|---|---|
| `list_dir(path)` | `ReadDir(path, 200)` | 读取+ | 免 |
| `read_file(path, offset?)` | `OpenFile(path,'auto')` → Content 切片，**单次 ≤64KB**，二进制/超 10MB 拒绝 | 读取+ | 免 |
| `search_text(query)` | `SearchWorkspace(scopeRoot, query, false, 200)` | 读取+ | 免 |
| `memory_list()` | `AIEnsureDir` 后 `ReadDir(dir, 200)`：文件名+大小+修改时间 | 读取+ | 免 |
| `memory_read(name)` | 记忆目录 + `OpenFile`（≤64KB） | 读取+ | 免 |
| `memory_write(name, content)` | 记忆目录 + `SaveFile`（文件名白名单校验，见 §15） | 读取+ | 免（**显示写入卡片**） |
| `skill_use(name)` | 技能目录读取 `<name>/SKILL.md` 或 `<name>.md`（≤64KB），结果 = 全文 + 「遵循该技能指令」 | **三档通用**（唯一例外，见 §16） | 免（显示加载卡片） |
| `write_file(path, content)` | `SaveFile(path, content, '', false, 'utf-8')`（新建文件） | 编辑 | **是** |
| `edit_file(path, oldString, newString)` | `OpenFile` → 唯一性校验（多处命中=错误回给模型）→ 替换 → `SaveFile` **保留原 eol/bom/enc** | 编辑 | **是** |
| `todo_write(todos[])` | 纯前端状态 → §11 | 编辑 | 免 |
| `run_command(command, cwd?, timeoutMs?)` | 后端 `AIRunShellCommand`：shell 优先级 **Git Bash → PowerShell 7 → Windows PowerShell → cmd**；默认 30s、上限 120s；stdout/stderr 各截断 16KB | 编辑 / 完全权限（计划模式不可用） | 编辑档**是**（逐条，命令 + cwd）；完全权限免 |

> memory 工具在**读取档即可用**（记忆是 AI 的工作笔记而非用户数据）；写入免审批但每次显示卡片，可追溯。`skill_use` 三档通用（只读知识加载零副作用），是「对话档无工具」原则的唯一例外。

**范围安全**（工作区工具执行前）：路径相对 scopeRoot 解析，归一后校验仍在 scopeRoot 内；越界直接返回工具结果「路径超出工作区范围」由模型自行调整。memory/skills 目录独立于范围检查（专用目录 + 文件名白名单兜底）。symlink 逃逸风险见 §21。

**工具 schema**：在 ai-panel.js 定义 JSON Schema（含 description 中文说明），按 scope 动态组装传给 AISendChat。

---

## 9. 审批流（工作区写操作）

0. AI 发起 `run_command`（仅编辑档）→ 插入命令审批卡片：显示完整命令与工作目录，按钮 **执行 / 放弃**；完全权限档直接执行。工具结果返回 shell 名称、退出码、stdout/stderr、耗时；超时标记「已终止」并保留已捕获输出。命令卡默认收起为一行「run_command + 命令 + 状态」，点击展开完整输出，输出区带独立背景色。
1. AI 发起 `write_file`/`edit_file` → 该工具轮**挂起**，面板内插入审批卡片：
   - 头部：工具名 + 目标路径 + ±行数；`edit_file` 显示**未保存修改警告**（若文件在编辑器中且 dirty）
   - diff 视图：前端 ~40 行 LCS 行 diff（对齐 gitinfo `computeLineMarks` 思路），+绿 −红 上下文灰，新文件全绿
   - 按钮：**应用** / **放弃**，外加**审批记忆**（§17.1）：「本会话允许此文件」「总是允许此文件」——授权清单 `datalens-ai.approvedPaths[]`，设置 AI 页可查看并一键清除；默认每次询问
2. 应用 → 执行 → 成功后：文件已打开且未 dirty → 自动重载（`OpenFile` 重读 setText）；dirty → flash 提示手动重载。
3. 应用记录进会话 `changes[]`（§12）。
4. 审批等待无超时（用户决策）；「停止」按钮可中止等待。

---

## 10. 范围模式（session.scope，三档）

| 档位 | 工具 | 说明 |
|---|---|---|
| **对话**（默认） | 无（唯一例外：`skill_use`，见 §16） | 纯聊天 + 手动附加 |
| **读取** | list_dir / read_file / search_text / memory_* | 范围根 = `workspaceFolder`，无工作区时 = 当前文件所在目录；免审批但每次调用显示卡片 |
| **编辑** | 读取档 + write_file / edit_file / todo_write / run_command | 工作区写操作全部审批、终端命令逐条审批；首次切换 flash 规则说明 |
| **完全权限** | 编辑档全部工具 + 工作区外路径 + 命令免审批 | 启用前有二次确认；破坏性操作需自行向用户说明 |

- scopeRoot 显示在 composer 上方（缩略 + tooltip 全路径）。
- 切换即时生效（下一轮请求的 tools 列表变化）；随会话持久化。
- 编辑模式开启时若工作区有 git → 一次性提示「建议先提交当前更改以便回退」（**不做自动 commit**）。

---

## 11. Todolist

- `todo_write(todos[{content, status: pending|in_progress|completed}])` → 面板顶部 `#ai-todos` 固定区。
- 显示：○ 待办 / ▶ 进行中（高亮）/ ✓ 完成划线；进度 N/M；全部完成 3 秒后折叠单行「✓ 任务完成（N 项）」，点击展开。
- systemPrompt（读取/编辑档）注入守则：多步任务先 `todo_write` 规划、每步更新状态。
- 随会话持久化、随会话切换恢复。

---

## 12. 变更记录

- 会话 head「变更(N)」按钮 → popover 列表 `[{path, +lines, −lines, time}]`。
- 点击行 → `openPath` 打开对应文件。
- 仅记录**工作区文件**的已应用改动；memory 写入不算变更（有独立卡片可追溯）。
- 回退靠 git（本应用已有完整 git 集成）；列表仅作审计视图。

---

## 13. 多配置 Profile（v1）

- 存储：`datalens-ai.profiles = [{id, name, provider, baseURL, apiKey, model, temperature, maxTokens}]` + `activeProfileId`。
- **切换**：composer 顶部下拉（显示 `名称 · 模型`），切换即时生效（下一轮请求用新 cfg）；命令面板同步注册「AI： 切换到 xxx」。
- **管理**（设置 pane AI 页）：profile 列表选择 + 表单编辑（provider/baseURL/apiKey/model/temperature/maxTokens/**contextWindow 上下文窗口**（tokens，默认 128000，8K–1M，用于 /context 占比与超限拦截）/**代理**（直连/系统/自定义 URL）/**自定义请求头**（k=v 行，≤8 条））+ 新增 / 复制 / 删除 / 重命名；「测试连接」「获取模型列表」作用于当前编辑的 profile。
- **Anthropic 扩展思考**（仅 anthropic profile 显示）：开关（默认关）+ 思考预算 `budget_tokens` 输入（默认 8000，≥1024）；开启后请求带 `thinking:{type:'enabled', budget_tokens}`。OpenAI 兼容类 reasoning 模型无需配置（有 reasoning_content 就显示）。
- **预设快填**：DeepSeek / 通义千问 / 智谱 GLM / Kimi / OpenRouter / Ollama / Anthropic 官方——一键按预设创建 profile（填 baseURL 与默认 model，key 自填）。
- 至少一个 profile 才能对话；空态引导「新建配置」直达设置。
- 会话不锁定 profile：切换是全局 active，消息 meta 记录当轮实际 model 名。

---

## 14. 提示词系统

### 14.1 预设模板多套
- `datalens-ai.prompts = [{id, name, content}]`；内置 3 个不可删：默认助手 / 数据解释 / 代码助手。
- 设置 pane：模板下拉 + 编辑框 + 「另存为模板」/ 删除；active 模板 id。

### 14.2 会话内临时改
- head「提示词」按钮 → 小对话框：textarea（预填当前生效值）+ 模板下拉「套用」→ 保存仅写 `session.systemPrompt`。
- 优先级：**会话级 > 会话所选模板 > 全局 active 模板**。
- 对话框内显示注入状态行：AGENTS.md ✓（N KB）/ 记忆 ✓（模式 + N KB）/ 上下文 ✓（M 个打开文件）。

### 14.3 上下文自动注入（每轮动态拼接，开关 `opt-ai-inject-context` 默认开）
- **始终注入**：打开文件列表（≤20 条路径）+ 当前活动文件名 + scopeRoot，以 `<workspace_context>` 围栏包裹，与用户 systemPrompt 分段。
- **读取/编辑档额外注入「工作区规范」**：范围根、免审批/需审批规则、工具守则（先 list/read 确认再改、edit_file 的 oldString 必须逐字唯一复制、不越界、改动前说明意图）。
- composer 发送行显示「本次上下文约 N 字符」。

### 14.4 AGENTS.md 自动注入（开关 `opt-ai-inject-agents-md` 默认开）
- **来源**：scopeRoot 下的 `AGENTS.md`（工作区打开时 = 工作区根；未开工作区 = 当前文件所在目录）。仅认 `AGENTS.md`（`CLAUDE.md` 等兼容留后续）。
- **时机**：每轮请求前读取（`OpenFile`，≤64KB 截断并提示）；无该文件则跳过。文件小（通常几 KB）且每轮仅一次读取，无需缓存。
- AGENTS.md 与用户提示词冲突时：AGENTS.md 视为项目约定，排在用户提示词**之后**（用户指令优先）。

### 14.5 注入总顺序（system 拼接，自上而下）
1. 用户 systemPrompt（会话级 > 模板 > 全局）
2. `<agents_md>` AGENTS.md 原文（§14.4）
3. `<memory>` MEMORY.md 索引（§15.4）
4. `<skills>` 技能索引（§16.3）
5. `<workspace_context>` 上下文注入（§14.3）
6. 「工作区规范」（读取/编辑档）

---

## 15. 记忆系统（双模式）

### 15.1 存储模式（`datalens-ai.memoryMode`，默认 `'workspace'`）

| 模式 | 路径 | 特点 |
|---|---|---|
| **app**（常规 harness 式） | `%APPDATA%\CandySweet\CaDt-DataLens\ai-memory\` | 全局记忆，跨所有工作区共享；跟应用走，不污染项目 |
| **workspace**（独有） | `<工作区根>\.cadt\memory\` | 记忆跟项目走，可入 git 团队共享、可手改；换机器/克隆仓库记忆仍在 |

- **退回规则**：workspace 模式但当前无工作区（且无打开文件）→ 自动退回 app 模式并在面板 flash 提示一次。
- 设置页 AI pane：模式 select（跟随工作区 .cadt/memory / 应用数据目录）+ 当前生效路径只读显示；面板「记忆」对话框头部同样显示。
- 模式切换即时生效（下一轮读写走新目录；不做迁移合并）。

### 15.2 目录结构（两模式同构）

```
<记忆目录>/
├─ MEMORY.md          ← 索引/总览（AI 维护：记了什么、在哪篇）
└─ <主题>.md           ← 任意主题文件（如 user-preferences.md、project-facts.md）
```

- 单文件 ≤64KB（超出截断写入并标注）；文件名白名单：`[A-Za-z0-9_\-\u4e00-\u9fff]{1,64}\.md`（禁路径分隔符与 `..`）。

### 15.3 记忆工具（读取+编辑档可用，见 §8）

- `memory_list()` / `memory_read(name)` / `memory_write(name, content)`。
- **写入免审批**（记忆是 AI 的工作笔记，低风险），但每次显示工具卡片（文件名 + 字符数），可追溯；MEMORY.md 与主题文件一致由守则约束。
- 删除不做工具（AI 可用 write 清空内容）；物理删除交给用户在「记忆」对话框手动操作。

### 15.4 注入与守则

- 每轮注入 `MEMORY.md`（存在时，≤8KB 截断）到 `<memory>` 段（顺序见 §14.5）；主题文件由 AI 按索引用 `memory_read` 按需拉取。
- 读取/编辑档守则注入：「你有持久记忆（列出工具）；用户偏好、项目重要事实、跨会话结论应写入记忆；写入后同步更新 MEMORY.md 索引；记忆与 AGENTS.md 分工——AGENTS.md 是用户手写约定（只读），记忆是你自己积累的笔记（可写）」。
- 首次使用（目录空）：守则提示 AI 可在合适时机建立 MEMORY.md。

### 15.5 用户手动管理（head「记忆」按钮 → 对话框）

- 当前模式 + 生效路径（只读显示）+ 模式切换入口（跳设置）。
- 记忆文件列表（名称/大小/修改时间）：**打开**（应用内编辑器打开 md）/ **删除**（确认）/ 新建空文件。
- `datalens-ai` 存 `memoryMode`；文件本体永远在磁盘（不进 localStorage），会话/机器间天然持久。

---

## 16. 技能系统（SKILL.md）

### 16.1 双目录来源（与记忆同构）

| 级别 | 路径 | 特点 |
|---|---|---|
| app 级 | `%APPDATA%\CandySweet\CaDt-DataLens\ai-skills\` | 全局技能，跨工作区可用 |
| workspace 级 | `<工作区根>\.cadt\skills\` | 跟项目走、可入 git 团队共享 |

- 两处合并加载；**重名时 workspace 覆盖 app**（项目可定制全局技能的行为）。

### 16.2 格式（兼容主流 agent 约定）

```
ai-skills/
└─ json-repair/
   └─ SKILL.md   ← YAML frontmatter（name / description）+ 正文指令
```

- 也接受单文件 `<name>.md`（frontmatter 同构）轻量编写。
- frontmatter 缺省时：name 取目录/文件名，description 取正文首行（≤80 字）。
- 技能管理对话框「新建技能」写入模板骨架（name/description + 空指令段）。

### 16.3 注入与调用

- **索引注入**：每轮 system `<skills>` 段列出启用技能的 name + description（紧凑列表，总是注入——让模型知道有哪些能力可加载）。
- **skill_use(name) 工具**（§8）：工具结果返回 SKILL.md 全文 + 「遵循该技能指令」，模型据此调整行为；加载显示卡片可审查。
- **手动调用**：composer「技能…」chip → picker 列表 → 所选技能全文注入下一轮（等效手动 skill_use，对话档也能用）。

### 16.4 管理（head「技能」按钮 → 对话框；设置 pane AI 页同入口）

- 列表（名称 / 来源 app|workspace / 描述 / 启用开关）+ **在编辑器中打开** + **打开所在目录** + 新建（模板）。
- 禁用列表 `datalens-ai.disabledSkills[]` 持久化（per-skill）。
- workspace 技能提示「该目录可提交 git 与团队共享」。

### 16.5 分工（与 AGENTS.md / 记忆）

| 机制 | 谁写 | 加载方式 | 用途 |
|---|---|---|---|
| AGENTS.md | 用户手写 | 每轮全文注入 | 项目全局约定 |
| 记忆 | AI 积累 | MEMORY.md 索引 + 按需 read | 跨会话事实/偏好 |
| **技能** | 用户或团队分发 | **按需 skill_use 加载** | **领域操作指令包（复用）** |

---

## 17. 通用配置项（harness 对齐汇总）

### 17.1 新增项（v8 并入）

| 配置 | 存储 | 默认 | 说明 |
|---|---|---|---|
| 网络代理 | per profile `proxy` | `'system'` | 直连 / 跟随系统 / 自定义 `http(s)://` URL（Go Transport Proxy，自建网关/科学上网场景） |
| 自定义请求头 | per profile `extraHeaders` | 空 | k=v 行编辑 ≤8 条（网关租户头、鉴权变体）；内容不落日志 |
| 发送快捷键 | `aiSendKey` | `'enter'` | Enter 发送（Shift+Enter 换行）或 Ctrl+Enter 发送（Enter 换行）——IME 用户常选后者 |
| 聊天字号 | `aiChatFont` | `13` | 12–20，仅面板消息区 |
| 审批记忆策略 | `approvedPaths[]` | 每次询问 | 审批卡片可选「本会话允许此文件 / 总是允许此文件」；设置页可查看授权清单并一键清除 |
| 会话保留上限 | `aiMaxSessions` | `50` | 超出自动清理最旧会话（连其 todos/changes）；「清空全部会话」按钮 |
| Token 用量显示 | 开关 `aiShowUsage` | 开 | `ai-done.usage`（API 提供则显示）→ 消息 meta 标 tokens、会话累计；无 usage 的端点自动隐藏 |
| 配置导入/导出 | — | — | 导出 profiles/prompts/memoryMode/approvedProfiles 为 JSON（**默认不含 apiKey**，勾选才含）；导入按 id 合并 |
| 快捷键登记 | — | — | Alt+9 与发送键登记进设置-快捷键页 |
| 上下文窗口 | per profile `contextWindow` | `128000` | 8K–1M tokens；用于 /context 占比与发送前超限拦截（§5.2） |
| 压缩提示阈值 | `autoCompactThreshold` | `0.8` | 占比 ≥ 阈值显示「建议 /compact」banner（**不静默压缩**） |
| 自动对话日志 | `logEnabled` | `true` | 每轮结束写 Markdown 到应用数据 `ai-logs/`；图片写 `ai-logs/images/`；设置页可开关/打开目录 |

### 17.2 固定不配置（写明理由）

- 工具轮上限 **15**（防失控烧 token）
- 空闲 watchdog **120s**（流式挂死保护）
- 附加/读取单文件 **≤64KB**
- **流式恒开**：个别网关不支持 SSE 时错误直接可见，不做非流式回退

### 17.3 留给 v2 的常见项

上下文自动压缩/滑窗截断 · 失败自动重试（退避）· 费用估算（per-token 价格表）· 图片拖拽（非粘贴）· 多模态图片历史自动归档/压缩优化。

---

## 18. 文件改动面

| 文件 | 改动 |
|---|---|
| `ai.go`（新） | AIConfig/AIMessage/AIToolDef、AISendChat 双协议流式+工具调用事件归一化、AIStop/AITestConnection/AIListModels/**AIMemoryDir**、取消 map、watchdog |
| `frontend/src/ai-panel.js`（新） | createAIPanel：渲染/会话/流式/**Agent 循环**/工具桥（含 memory、skill_use）/**审批 diff**/范围模式/todo/变更/**Profile 切换**/提示词注入（含 AGENTS.md、MEMORY.md、技能索引）/**记忆对话框**/**技能管理对话框**/常用消息操作/导出 |
| `frontend/src/main.js` | ab-ai/Alt+9/视图菜单/palette 接线；els、mockBackend 全套 mock；resize pushRule；注入所需的打开文件列表读取 |
| `frontend/src/explorer.js` | 文件树/目录右键「在 AI 中询问此文件」 |
| `frontend/index.html` | `#ai-panel` 结构、ab-ai、snav-item + settings-pane「AI 助手」（Profile 管理 + 模板管理 + 记忆模式 + 技能入口） |
| `frontend/src/style.css` | 面板/消息/工具卡片/审批卡片/diff/todo/scope segmented/profile 下拉/记忆对话框等样式 |

Go 新增仅 `ai.go`（流式 + AIMemoryDir 一个小方法）；其余全复用。

---

## 19. 分批实施路线（每批构建部署 + 用户验证）

1. **Go 流式内核**：ai.go 双协议（文本+思考链+工具调用事件归一化）+ **代理/自定义头** + stop/test/models/**AIAppDir/AIEnsureDir** + mock → `go build` + `go test ./...`
2. **面板 UI + 会话 + OpenAI 兼容对话跑通**：面板结构/活动栏/Alt+9/视图菜单/空态 + **三种显示方式**（停靠含最大化/吸附/悬浮，几何持久化）+ 流式收发 + **思考链折叠区**（ai-think 流式展开/完成收起）+ **常用消息操作**（复制/重新生成/编辑重发/回到底部/导出 md/重试/停止）+ **基础斜杠命令**（/clear /context 估算 /help /model /export /memory /skill）+ **发送键/聊天字号/用量显示/会话保留上限**
3. **注入系统 + 工具桥（读取档 + memory + skills）**：workspace_context/AGENTS.md/MEMORY.md/**技能索引**注入与守则 + 三档切换 + 工具 schema + list/read/search/**memory 三件套**/**skill_use** 执行 + 工具卡片 + 附加（chips/文件树右键/**技能 chip**）
4. **编辑档**：审批 diff 卡片/edit_file/write_file/**审批记忆（本会话/总是允许+授权清单）**/变更记录/todo_write+显示
5. **Anthropic 原生**：事件块解析（文本+thinking+tool_use）/tool_result 回传/**thinking+signature 回传**/扩展思考开关+预算/设置切换
6. **Profile + 提示词模板 + 记忆/技能管理 + 设置 pane 完整**：Profile 管理/**contextWindow/代理与自定义头表单**/预设快填/模板管理/**记忆对话框（查看/删除/打开）**/**技能管理对话框（来源/禁用/新建/打开目录）**/注入开关/模型列表/测试连接/**配置导入导出**/快捷键登记/**/compact 摘要+归档+阈值 banner+/init**/超限拦截/palette 全注册/全量回归

部署循环：`node --check` → `wails build` → 停 datalens.exe → 拷贝启动 → 用户逐项验证。

---

## 20. 验证清单

- [ ] 面板开合三路一致（ab-ai/Alt+9/视图菜单）；窄窗自动收侧栏。
- [ ] **会话管理**：左侧「AI 会话」视图（Alt+8）列出会话（标题/消息数/最近时间）并高亮当前会话；新建、切换、重命名、导出、删除（行内 ⋯ / 右键）均生效；面板头部不再有会话下拉；悬浮窗 ⋯ 菜单保留会话操作。
- [ ] **轮次计时与过程折叠**：工具轮执行中过程折叠保持展开且工具卡实时更新；完成后默认收起为「已完成，用时 X」，点击展开显示思考/工具/中间说明；最终回答始终在折叠外；刷新后耗时保留、折叠恢复默认收起。
- [ ] **图片粘贴**：输入框 Ctrl+V 粘贴截图 → 缩略图 chip，可预览/移除；无文字也能发送；OpenAI/Anthropic 请求分别带 `image_url` / base64 image；刷新后历史仍显示图片；超过 6 张或压缩后过大有提示。
- [ ] **对话日志**：默认开启时每轮生成/更新 `ai-logs/<会话>-<id>.md`，图片落 `ai-logs/images/` 并被引用；设置页关闭后不再写；「打开目录」可打开日志根目录；日志不包含 API Key。
- [ ] **三种显示方式**：停靠挤占内容区/最大化铺满/还原；吸附浮于右缘不挤占内容、高度可调；悬浮可拖到任意位置+任意缩放（≥最小尺寸）、越界收回；三种几何分别记忆、切换互不干扰。
- [ ] OpenAI 兼容流式：DeepSeek/OpenRouter 逐字渲染、停止生效、错误 key 红字。
- [ ] 思考链：R1 类模型（reasoning_content）思考区流式展开、完成后收起为「已深度思考 · Xs · N 字」、点击展开全文、显示开关生效；无思考输出的模型不显示该区。
- [ ] 常用操作：重新生成替换旧回复、编辑重发截断后续、复制原文、导出 md 内容完整、回到底部按钮、错误重试。
- [ ] Profile：新建/复制/删除/切换；切换后下一轮用新模型（消息 meta 可见）；预设快填正确；测试连接/模型列表反馈清晰。
- [ ] **通用配置**：代理切换后请求走向正确（直连/系统/自定义）；自定义头生效；Ctrl+Enter 发送切换；字号即时生效；usage 显示与无 usage 端点隐藏；会话超限自动清理；导出默认无 key、勾选后含、导入合并。
- [ ] AGENTS.md：工作区根放一个 AGENTS.md → 提示词对话框显示已注入；其中约定（如「回答用列表」）生效；删掉文件自动不再注入；64KB 超长截断。
- [ ] **记忆**：读取模式下让 AI「记住我喜欢紧凑表格」→ `.cadt/memory/`（workspace 模式）出现主题文件且 MEMORY.md 更新；**新开会话** AI 能引用该偏好；切 app 模式 → 写进 `%APPDATA%\...\ai-memory\` 且换工作区仍在；无工作区时 workspace 模式退回 app 并提示；记忆对话框列出/打开/删除正常。
- [ ] 读取模式：「找到工作区里最大的 JSON 并总结」→ list_dir/read_file 卡片、结果正确；越界路径（`..\..`）被拒并回传模型。
- [ ] 技能：app 级与 workspace 级各建一个 → 索引注入可见；AI 调 skill_use 后按技能指令行动；重名时 workspace 覆盖 app；per-skill 禁用生效；「技能…」chip 手动注入；新建模板/编辑器打开/打开所在目录正常。
- [ ] 编辑模式：改一个小文件 → 审批卡片 diff 正确 → 应用 → 编辑器自动重载；放弃 → 模型收到拒绝继续对话；CRLF/BOM 保持。
- [ ] edit_file oldString 多处命中 → 错误回给模型重试；dirty 文件审批卡警告。
- [ ] **审批记忆**：本会话允许后同文件不再询问（重启失效）；总是允许后持久跳过；设置页授权清单可见、清除后恢复询问。
- [ ] **斜杠命令**：输入 / 弹出补全、↑↓/Tab/Enter/Esc 交互正确；/context 数字估算合理且标注估算；/compact 后历史变「摘要+最近 6 条」、继续对话上下文连贯、archived 可查看不发送、压缩可取消；/clear 需确认；/init 生成 AGENTS.md 走审批且已存在时提示；未知命令有提示。
- [ ] **上下文限制**：contextWindow 改小后 /context 占比变化；达阈值出现「建议 /compact」banner；超限阻止发送并提示；有 usage 的端点显示实际值。
- [ ] todo：多步任务清单实时更新、完成折叠；切换会话恢复。
- [ ] 变更记录：应用/放弃分类正确、点击打开文件；memory 写入不进变更列表；git 提示一次性出现。
- [ ] 三档切换：对话档不发 tools；编辑档首次切换有规则提示。
- [ ] 提示词：模板切换生效、会话临时改仅本会话、注入状态行三种来源显示准确。
- [ ] Anthropic：流式 + tool_use 全流程（官方 key 或兼容网关）；扩展思考开启后思考区显示、多轮工具调用 thinking+signature 回传不报签名错误；关闭时无 thinking 块。
- [ ] 回归：终端/侧栏/md 分屏同步/布局不受影响；浏览器 mock 全流程可走。

---

## 21. 风险与备注

1. **工具参数流式累积**：模型可能输出畸形 JSON → 解析失败作为错误工具结果回传，模型自行重试。
2. **edit_file 依赖 oldString 逐字精确**：多处命中/未命中都回错误让模型重读文件重试（Claude Code 同策略）。
3. **范围检查在前端**：防模型失误，不防恶意（本机单用户应用可接受）；symlink 越界不在 v1 防护内（备注）。
4. **上下文膨胀**：agent 多轮 + 附加 + AGENTS.md + MEMORY.md 全量发送，v1 不截断（AGENTS.md/附加 ≤64KB、MEMORY.md ≤8KB 截断标注），仅显示字符数提示；截断/摘要策略记 v2。
5. **超长回复降级**：>100KB 文本生成中显示纯文本尾段，完成后一次性渲染。
6. **key 明文 localStorage**：与 JetBrains 插件同级；多 Profile 同理；v2 可换 Go 侧 DPAPI（接口已隔离在 AIConfig）。
7. **memory 文件名白名单**：防路径逃逸与非法名；workspace 模式 `.cadt/` 是否入 git 由用户决定（面板不强制，可在记忆对话框提示「该目录可提交到 git 与团队共享」）。
8. **Ollama**：baseURL `http://localhost:11434/v1`，走 Go http 无 CORS。
9. **审批期间网络空闲**：watchdog 120s 只约束 HTTP 空闲，审批等待不受影响。
10. **Anthropic SSE 事件块**（`event:`+`data:` 成对）与 OpenAI 单行 `data:` 解析器分开实现、共用事件 emit。
11. **AGENTS.md / MEMORY.md 每轮读取**：IO 开销可忽略（几 KB）；若需要 v2 加 mtime 缓存。
12. **记忆模式切换不迁移**：两目录各自独立；如需合并 v2 提供「导入另一模式记忆」按钮。
13. **思考链存储膨胀**：reasoning 全文随消息存 localStorage（单条 ≤32KB 截断标注）；重生成会替换旧 reasoning。OpenAI 官方 o 系列 reasoning summary 走 Responses API，v1 不支持（兼容端点无此字段，留后续）。
14. **Anthropic thinking 签名**：多轮工具调用必须原样回传 thinking block + signature，前端不可改写其内容；丢弃会导致 400。
15. **技能是提示注入面**：workspace `.cadt/skills` 可随 git 到来，与 AGENTS.md 同级信任；提供来源标示（app|workspace）+ per-skill 禁用 + 加载卡片审查；SKILL.md ≤64KB 截断。
16. **技能格式宽容度**：frontmatter 缺省自动降级（name 取文件名/description 取首行），但畸形 YAML 需容错（解析失败按无 frontmatter 处理并提示）。
17. **代理与自定义头**：凭据/头内容不进日志（§6 已约束）；自定义头可覆盖安全头（仅允许白名单外的业务头，禁改 Host/Content-Length）。
18. **审批记忆的信任边界**：「总是允许」仅按**规范化绝对路径**匹配，目录移动/重命名后自然失效；授权清单可在设置随时清除。
19. **Token 为估算值**：不引入 tokenizer 依赖，按字符近似（标注「估算」）；展示 API usage 实际值时区分标注；超限拦截预留 10% 余量避免误杀。
20. **/compact 信息损失**：摘要不可逆（原文进 archived 仅查看不回灌）；压缩前二次确认，可取消；连续压缩会产生「摘要的摘要」，提示用户。
21. **/init 写盘**：与 AI 写文件同一审批通道（用户主动触发也走审批卡片），工作区外不可用。
17. **悬浮/吸附是应用内浮层**：非独立 OS 窗口（不能拖出应用外；Wails v2 多窗口受限），层级需与菜单/对话框/右键菜单协调（面板 z-index 低于模态对话框）；拖拽用 pointer events + setPointerCapture，避免与文本选区冲突。
18. **停靠↔吸附切换抖动**：同一 DOM 重定位时流式渲染不中断（事件按 id 路由与 DOM 无关，已天然解耦）。
