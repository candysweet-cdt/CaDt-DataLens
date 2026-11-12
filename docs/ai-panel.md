# AI 助手面板 v1 方案（Agent 全套 · 计划，待批准后实施）

> 状态：**已实施（批次 1–6 完成）+ 2026-11-10 UI 改版（精简发送区 / 权限四档 / 独立悬浮窗 / 模型设置页 / 轮次计时与过程折叠 / 会话管理迁左侧边栏）+ 2026-11-10 Agent 能力补齐（会话归档 / 内置技能 / 通知 / AskQuestion / Plan 模式 / 消息排队与插话 / composer 接管 / 状态栏 AI 宽度）+ 2026-11-11 头部新建会话按钮与空会话新建去重 + 2026-11-11 AskQuestion 改版（跳过按钮 / 自己输入项默认开 / 多选勾选框）+ 2026-11-11 用户偏好（设置列表 + preference_* 工具 + 上下文注入）+ 2026-11-11 联网检索（web_search / web_fetch + web-research 技能）+ 2026-11-11 工作区上下文自动注入（打开文件 / 光标 / 选区）+ 2026-11-11 排队消息可编辑 + 2026-11-11 上下文注入细粒度开关与独立设置页** · 拟定日期：2026-11-10（v9 修订：斜杠命令与上下文管理——/context /compact /clear /model 等 + 上下文窗口配置）
> 定位：IDEA / Qoder 式**右侧 AI 助手面板**：多会话流式聊天 + **思考链流式显示**（R1 类 reasoning / Claude thinking）+ **Agent 能力**（范围模式 / 工具调用 / 写操作审批 / Todolist / 变更记录）+ **提示词系统**（预设模板 / 会话临时改 / 上下文与 AGENTS.md 自动注入）+ **记忆系统**（双模式持久记忆）+ **技能系统**（SKILL.md 双目录 + skill_use）+ **多配置 Profile** + **三种显示方式**（停靠 / 吸附 / 悬浮）+ **斜杠命令与上下文管理**（/compact 压缩、/context 统计）。
> API 由用户自配，协议：**OpenAI 兼容 + Anthropic 原生**。
> 安全原则：API Key 只存前端 localStorage、不落 Go 磁盘、不进日志；工作区文件写操作全部经用户审批。

---

## 0. 2026-11-10 UI 改版

- 显示方式：停靠 / 全屏（仅覆盖文件内容区）/ 悬浮（独立进程窗口，可移动到其他屏幕）。
- 发送区：`+` 菜单附加文件/技能/指令；权限胶囊（只读访问 / 每次询问 / 自动审批 / 完全权限，完全权限二次确认）；模型胶囊（切换配置与推理等级）；圆形发送/停止按钮。
- 权限：只读访问仅提供读取工具；每次询问对所有工作区写操作与命令逐次审批；自动审批自动应用工作区写操作（目标文件有未保存修改时仍询问），并自动执行白名单内的低风险命令，其余命令仍审批；完全权限对工作区内写操作与命令免审批，并允许工作区外绝对路径。
- 设置：新增「模型」页，承载 Profile / API / 模型 / 上下文窗口 / 思考等级 / 代理 / 自定义头 / 预设 / 导入导出；已配置模型以卡片列表展示，新建/编辑使用独立三级弹层（保存生效、取消回滚、支持复制/删除/设为当前）；「AI 助手」页保留记忆、提示词、审批与聊天行为；新增「用户偏好」页承载偏好的筛选与增删改查。「模型」「AI 助手」「用户偏好」在设置导航中归入可折叠的「AI」组（与「数据格式」同构）。
- 弹层：从设置内打开确认框/命名框时，设置弹层保持可见，关闭确认框后回到设置；终端标签页关闭图标按 SVG 子元素命中修复；独立调试控制台关闭走 `runtime.Quit`/`ForceClose`。
- 悬浮窗内的设置入口经单实例 IPC 转发到主窗口；主窗口未运行时启动主窗口并直接打开对应设置页。
- 头部：移除独立最大化按钮；重命名/删除/导出/提示词/记忆/技能收进「⋯」菜单；「新建会话」以图标按钮常驻头部（显示方式切换组左侧，2026-11-11 加回）。
- 会话管理：从面板头部移出，改为左侧活动栏「AI 会话」视图（`Alt+8`）；列表显示标题、消息数、最近活动时间，当前会话高亮；支持新建、切换、重命名、导出、删除（行内 ⋯ 或右键菜单）。面板头部只保留标题、新建会话、显示方式、变更、⋯、关闭；悬浮窗因没有左侧边栏，会话操作保留在 ⋯ 菜单。
- 轮次计时与过程折叠：每轮用户消息到最终回答之间的思考、工具调用和中间说明收进 `.ai-process` 折叠行（「已完成，用时 7 分 26 秒」）；流式中默认展开并每秒更新用时，完成后默认收起，点击展开；最终回答始终显示在折叠行之外；耗时随会话持久化（`turnStartedAt` / `turnMs` / `finishedAt`）。
- 流式状态条：看板娘 +「甜澄漫游中」+ 实时计时，始终位于消息区文档末尾（**非 sticky**，内容不足时 `margin-top:auto` 贴底）；工具卡片原位更新（如 diff 展开、结果回填）后，若处于跟随底部状态会自动滚到文档末尾，避免卡片变高把状态条顶出视口（手动上滚时不打扰）。
- 图片粘贴：composer 支持 Ctrl+V 粘贴剪贴板图片，自动压缩（≤1600px）、最多 6 张、缩略图/预览/移除；图片随 user 消息以多模态内容发送（OpenAI `image_url` / Anthropic base64 image）；图片-only 消息可直接发送。
- 对话日志：默认每轮自动保存 Markdown 到应用数据目录 `ai-logs/`，图片落到 `ai-logs/images/` 并在日志中引用；设置 AI 页可开关、查看路径、打开目录；侧栏会话菜单与面板 `⋯` 均可打开日志目录；日志不含 API Key。
- 内容宽度（停靠 / 全屏通用）：AI 面板打开时状态栏显示「AI 宽度」按钮，可选自动（默认）/ 跟随 / 720 / 860 / 920 / 1100 / 1300px，消息区、composer、统计行与 todos 按该宽度居中；设置存入 `datalens-settings.aiFullscreenWidth`，默认自动。

## 0.1 2026-11-10 Agent 能力补齐

- 会话归档：会话菜单新增「归档会话 / 取消归档」；归档会话从活动列表移入可折叠「已归档」区，保留查看、重命名、导出与取消归档；归档会话禁止继续发送/压缩，且不会被会话数量上限优先淘汰。持久化字段 `archivedAt`。
- 内置技能：随包内置 `code-review`（只读代码审查）、`json-toolkit`（JSON/JSONL/YAML/TOML/CSV 校验与修改）、`release-notes`（更新日志/发布说明）、`cadt-datalens`（命令行打开文件/跳转行:列）、`cadt-ui`（app_control 动作表）、`web-research`（联网检索）、`docx` / `pdf`（文档处理）、`skill-creator`（技能创作）、`plugin-creator`（插件开发）十个技能；技能列表、`/skill`、`skill_use` 与技能管理统一可见，支持启用/禁用；同名用户技能优先覆盖内置。
- 通知：任务完成、任务失败、AI 提问时显示应用内 toast（可点击跳到对应会话）；窗口失焦时应用内通道还会让任务栏闪烁并可播放提示音；系统级 Windows Toast 独立开关。设置 → AI 助手 → 通知可分别开关应用内通知、系统通知、完成/失败/提问事件与失焦提醒。
- AskQuestion：新增 `ask_user` 工具，一次最多 5 个问题；每题可单选或多选（多选题选项前带勾选框图标），可标记推荐项；面板默认在选项后追加一个「自己输入」项（`allow_custom=false` 时才关闭，默认开）。接管卡底部为「跳过」+「提交/继续」（原「停止本轮」已移除）：点「跳过」不回答问题但不中断本轮，以 `skipped` 状态把「用户选择不回答」作为工具结果交回模型，卡片显示「已跳过」。提问和计划批准会接管底部 composer（不再插入消息流），回答后恢复输入框并在转录中保留只读问答记录。设置项：超时时长（不超时/30 秒/1 分钟/5 分钟/10 分钟/30 分钟）与超时处理（按 AI 推荐项继续 / 继续阻塞等待 / 直接停止本轮 / 交给 AI 决定）。超时停止会结束本轮；超时继续会把结果作为工具结果交回模型。`ask_user` 另支持逐次覆盖超时：可选参数 `timeoutSec`（秒，`0` = 本次不限时，范围 0–3600）与 `timeoutAction`（`recommended` / `wait` / `abort` / `ai_decide`），只影响本次提问，不写回设置；两者省略时沿用设置。实现见 `resolveAskTimeout`（ai-panel.js），实际生效值记录在 `ask.timeoutSec` / `ask.timeoutAction`；本次为定制时 `ask.timeoutCustom` 为 true，composer 倒计时会附加「（本次自定义 N 秒）」。
- Plan 模式：composer 新增「计划」胶囊，`/plan` 进入、`/plan off` 退出，`/plan <指令>` 进入并直接开始规划；计划模式下不提供 `write_file` / `edit_file`，提示词要求只读探索并输出 Markdown 计划。计划完成后在底部 composer 接管处显示计划预览与「继续规划 / 执行计划」；执行时自动退出计划模式并发送批准指令；只读访问权限下会提示先切换到「每次询问」或更高权限。计划模式状态随会话持久化。
- 用户偏好：设置 → AI →「用户偏好」独立页（可筛选搜索），可手动添加、编辑、删除（每条 ≤500 字，上限 100 条，重复文本拦截）；每条带来源标记（你 / AI）与条数统计。偏好存在 `datalens-ai.preferences[]`，每轮对话注入 `<user_preferences>` 块（在任务目标与安全规则下优先遵循）。新增 `preference_list` / `preference_write` / `preference_remove` 工具：只读访问即可用、免审批、计划模式不可用；改/删按 id（`preference_write` 带 id 即修改），写入即时刷新设置列表；随 AI 配置导出 / 导入。
- 底部 composer：改为带圆角/阴影的浮动面板；队列、附件和输入框都在面板内。提问/计划批准会临时替换面板内容，回答或决定后恢复。
- 消息排队与插话：生成中 Enter 把消息加入排队（面板内可见、可编辑/移除/插话），本轮结束后自动发送；Ctrl+Enter 立即插话（停止当前回复并把该消息排到队首）；普通停止不自动清空队列。队列「编辑」会把该条及其附件取回输入区；若输入区已有草稿，草稿自动放回队尾。
- AI 内容宽度：状态栏「AI 宽度」按钮（和 Markdown 预览宽度一样使用状态栏弹出菜单）；停靠与全屏模式均显示，选项自动（默认，< 920px 跟随、≥ 920px 最大 920px）/ 720 / 860 / 920 / 1100 / 1300 / 跟随。
- 思考链：支持 Markdown 渲染；思考时长按每轮助手消息统计（含工具调用轮，<1 秒显示「<1 秒」）；展开/收起状态在重渲染后保留；去掉了思考卡片的左边框。
- AI 代码块右上角提供「复制」按钮，复制整块代码（含流式输出中的代码块）。
- AI 消息右键菜单：可复制所选文本、复制代码块、复制整条回复/消息/工具输出、全选对话；不再弹出主编辑区空白菜单。
- AI 字号与字体：聊天字号范围 10–32，滑动条与数字输入联动，AI 面板内 Ctrl+滚轮可直接调整并持久化；设置 → AI 助手 → 聊天行为新增英文字体、中文字体、代码字体三个选择，可分别跟随界面/编辑器或指定字体，分别作用于 AI 对话与代码块。
- 推理强度：模型芯片显示「模型 · 推理强度」；OpenAI 兼容配置新增 `reasoning_effort` 设置（自动/低/中/高，自动不发送该字段），Anthropic 继续使用扩展思考预算。
- Composer 统计行：输入框下方显示「轮 / 步 · tok/s · 总 tokens · 缓存命中」与上下文百分比环；两组统计可点开弹层：会话统计（模型用时 / 工具调用用时 / 首 token 平均 TTFT / 输出速度 TPS）与 Token 用量（缓存命中 / 未缓存输入 / 缓存读取 / 输出）。
  - TPS 口径：`输出 tokens ÷（模型往返耗时 − 首 token 延迟）`，即真实解码速度，不含排队、预填充与首 token 等待；只在「本轮有 usage 且有模型耗时」的轮次上加权，不回退到含工具调用时间的整轮耗时。
  - 非流式返回（拿不到首 token 时间戳）时退化为端到端吞吐「输出 tokens ÷ 模型往返耗时」，鼠标悬停 tok/s 可看到当前用的是哪种口径。
  - 上下文占用估算口径：`content + 思考链 + 工具调用参数 + 图片`，与真实请求一致；百分比环、上下文弹层、发送前预警与自动压缩共用同一函数。此前只算 `content`，实测低估约 36%。
  - 消息流顶部有常驻「上下文已压缩」摘要卡：显示归档 / 保留条数，点开可读摘要全文与归档原文（只读，不参与请求）。
  - 点环弹出上下文构成（系统提示词 / 工具定义 / 对话消息）与「压缩上下文」按钮；上下文占比估算现包含工具定义。
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
| 设置 pane + 搜索 | snav-item 模式；`buildSettingsSearchIndex` `main.js:1747` 自动扫描 `.popover-row` | 新 pane「AI 助手」/「上下文注入」 |
| 文件树右键 | explorer.js 右键菜单（已有 属性/复制/删除 等项） | 加「在 AI 中询问此文件」 |
| 日志 | `logFrontend` `main.js:977` → logging.go | AI 错误记录，**不落 key** |

---

## 3. UI 设计

`index.html` 新增**单一** `<aside id="ai-panel" class="hidden">`（默认停靠形态挂在 `#top-row` 内 `#main-pane` 之后；吸附/悬浮形态是**同一个 DOM** 改为 overlay 定位，见 §3.2）：

```
#ai-panel
├─ #ai-resize                        ← 左缘宽度拖拽（pushRule 'ew'）
├─ .ai-head
│   └─ 标题 + 新建会话 + 显示方式切换（停靠/全屏/悬浮）+ 「变更(N)」 + 「⋯」 + 关闭
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

- 入口：左侧活动栏「AI 会话」视图（`Alt+8` / 视图菜单 / 命令面板 `AI 会话`）。侧边栏列表显示标题、消息数、最近活动时间，当前会话高亮；按工作区分组，当前工作区组置顶（组头可折叠），其余组按最近活动倒序，未关联工作区的会话置底；组内仍按最近活动倒序。
- **按工作区归类与软切换**：会话记录 `workspace`（创建时取当前工作区，老会话首次发送/打开时补绑）。点击其他工作区的会话时：当前窗口尚未打开工作区 → 在本窗口打开该工作区并切换会话；当前窗口已有工作区 → **不硬切换**，`OpenWorkspaceForConversation` 另开窗口打开目标工作区（新窗口带 `--ai-session=<id>`），并按 `cadt.workspace-sessions.v1` 恢复该工作区上次的标签/分组/分屏/当前文件与视图，随后打开 AI 面板选中该会话。
- 操作：头部 `+` 新建；行内 `⋯` 或右键重命名 / 导出 / 删除；头部 `⋯` 对当前会话执行同名操作。点击会话条目切换并在面板关闭时自动打开 AI 面板。
- **会话搜索**：AI 会话侧栏顶部搜索框，优先走 Go 侧 SQLite FTS 索引（`ai-index.db`，可重建，JSONL 仍是真源；≥3 字符走 trigram，1–2 字符走 LIKE），索引不可用时退回内存扫描。结果按标题/消息/工具名展示，点击切到会话并滚动到命中消息，`Esc` 清空。
- **回退到此轮**：assistant 回复的操作栏提供「回退到此轮」，保留该轮、删除之后的消息；磁盘日志追加 `truncate` 事件，归档内容不受影响。
- **首轮自动标题**：首轮结束后用当前模型按第一条用户消息生成 6–16 字标题（`autoTitle`，默认开）；失败或用户改名时保留原标题，每个会话本进程只尝试一次。
- **会话数据诊断**：会话菜单打开诊断对话框，显示 JSONL 字节/行数、事件统计、重放条数、解析 issue、撕裂尾、live/archived 的 mid 对齐、加载错误与搜索索引状态，可复制或重建索引。
- **长会话懒加载**：打开/切换会话时只渲染最近一段消息，初始窗口至少约 1M tokens（取 `1M` 与当前 Profile `contextWindow` 的较大值，按估算 tokens 从末尾回溯并按轮次对齐）；列表顶部显示「↑ 上方还有 N 条更早消息」，上滑触顶或点击后按约 250k tokens 分块补载，并补偿滚动位置保持视口不跳。消息变少（`/compact`、编辑重发、清空）时窗口自动重置；窗口状态仅内存保存，重启后重新从最近一段开始。
- **磁盘存储（2026-11-11 起）**：每个会话一个目录 `%APPDATA%\CandySweet\CaDt-DataLens\ai-sessions\<id>\`——`meta.json` 存 `{id,title,createdAt,updatedAt,workspace,scope,systemPrompt?,promptTemplateId?,profileId?,todos[],changes[],summary?,logFile?,logSavedAt?,archivedAt,messageCount,archivedCount}`；`session.v1.jsonl` 为追加式事件日志（`header` / `msg` / `truncate` / `archive` / `meta` / `reset`），消息字段沿用 `{role, content, images?:[{id,mime,file,width,height,name,logFile?}], toolCalls?, ts, model, reasoning?, turnStartedAt?, turnMs?, finishedAt?}`。列表只读 `meta.json`，正文按需加载并重放。当前会话 id 与存储模式仍存 `datalens-ai` / `datalens-ai-storage`。编辑器环境按工作区另存 `cadt.workspace-sessions.v1`（键为规范化工作区路径，值同 `cadt.session.v1` 的 `{workspace,groups,current,split,modes}`）。
- **AI 配置落盘（2026-11-11 起）**：profiles / prompts / preferences / approvedPaths 存 `%APPDATA%\CandySweet\CaDt-DataLens\ai-config.json`（原子写、0600），localStorage `datalens-ai` 继续保留一份镜像用于旧版本回退与降级；`localStorage['datalens-ai-config']='legacy'` 可强制走旧路径。首次升级自动把 localStorage 配置写成文件。
- 图片外置到会话目录的 `images/`，事件里只留 `file` 引用（不再把 base64 写进会话数据）；加载时读回 base64，读不到显示「图片已归档」占位。对话日志 `ai-logs/` 照旧保留完整 Markdown 转录与图片副本。
- **无消息条数上限**：条数与 token 无关，硬裁剪会静默丢弃历史。上下文规模由 `contextWindow` 预算 + 自动压缩管理；单会话归档上限 `AI_ARCHIVE_LIMIT=5000`，超出提示导出 Markdown。磁盘无 5 MB 配额，**不再做 localStorage 写满降级/自动归档**；写入失败只提示，不改历史。每批追加后 fsync、失败回滚；每会话 `.session.lock` 做跨进程写串行；启动时把上次中断的 `running`/`streaming` 状态收尾为「已中断」并异步写回。
- 标题自动取首条用户消息前 20 字；新建/切换/重命名/删除。
- **新建去重**：当前会话未发过消息、未归档且属于当前工作区（或未绑定工作区，复用时补绑）时，再次触发新建复用该会话并提示「当前会话为空，已复用」；头部新建按钮、⋯ 菜单、命令面板、会话桥同一规则。已归档或属于其他工作区的空会话不复用。
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
| AI 面板打开时右键「引用该文件 / 引用选取」 | tab / 编辑器 / Markdown 预览 / SVG / 图片 / 文件树菜单：只加引用 chip（名称 + 绝对路径 + 起止行列），不读正文；编辑器有选区时该项为「引用选取」 |
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
| `/model` | 提示并聚焦 composer 右下角的模型胶囊（**不自动弹出下拉**） | 切换配置请点模型胶囊 |
| `/export` | 导出会话为 Markdown | 等效 head 按钮 |
| `/memory` | 打开记忆管理对话框 | 等效 head「记忆」 |
| `/skill <name>` | 手动调用技能（全文注入下一轮） | 等效「技能…」chip |
| `/init` | 生成 `AGENTS.md` 模板到工作区根（无则创建；已存在提示） | 写入走审批卡片；无工作区禁用 |
| `/help` | 命令列表 | — |

- 补全交互：输入 `/` 弹出内联列表（复用 palette 的模糊匹配打分），↑↓ 选择、Enter 执行、Tab 补全、Esc 关闭；未知命令提示「未知命令，输入 /help」。

### 5.2 上下文统计与压缩机制

- **Token 估算**（无 tokenizer 依赖）：`tokens ≈ ceil(ascii字符数/4 + CJK字符数×0.75)`，界面标注「估算」；有 API `usage` 返回值时展示实际值并标注。
- **压缩后请求构建**：`msgs = [{role:'system', content:'<会话摘要>…'}] + 最近 6 条原文`；摘要存 `session.summary {text, upTo, createdAt}`，`upTo` 之前的消息进 `archived[]`。
- **阈值提示 + 自动压缩**：估算占比 ≥ `autoCompactThreshold`（默认 80%）时，输入区上方显示 banner「上下文约 X%，建议 /compact」+ 一键按钮。设置项「自动压缩」开启（`autoCompact`，默认开启）时，在一轮回复正常结束后检查一次预算，超阈值则自动发起 `/compact`；同一会话连续自动压缩 2 次后不再自动触发，改为提示「建议开启新会话或减少附件」。自动压缩期间不打断生成，正在提问 / 计划待批准 / 队列有待发消息时不会触发。
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
- **AIHomeDir()**：返回当前用户主目录（用户级通用技能 `~/.agents/skills` 解析用；失败返回空串）。
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
| `web_search(query, maxResults?)` | 后端 `WebSearch`：Bing RSS 搜索，返回标题 / URL / 摘要 / 日期；默认 8 条、最多 10 条 | 读取+ / 计划模式 | 免 |
| `web_fetch(url, maxChars?)` | 后端 `WebFetch`：抓取公网 HTML / 文本 / JSON / XML → 标题 + 正文纯文本 + 页面链接；默认 12000 字、最多 60000；拒绝本机 / 内网 / 二进制 | 读取+ / 计划模式 | 免 |
| `memory_list()` | `AIEnsureDir` 后 `ReadDir(dir, 200)`：文件名+大小+修改时间 | 读取+ | 免 |
| `memory_read(name)` | 记忆目录 + `OpenFile`（≤64KB） | 读取+ | 免 |
| `memory_write(name, content)` | 记忆目录 + `SaveFile`（文件名白名单校验，见 §15） | 读取+ | 免（**显示写入卡片**） |
| `preference_list()` | 读取 AI 配置 `preferences[]`（id + 文本 + 来源） | 读取+ | 免 |
| `preference_write(text, id?)` | 新增；带 id 即修改该条（≤500 字符，上限 100 条，重复文本去重），即时刷新设置列表 | 读取+（计划模式不可用） | 免 |
| `preference_remove(id?, text?)` | 按 id 或内容精确匹配删除 | 读取+（计划模式不可用） | 免 |
| `skill_use(name)` | 在 rank 100–600 的扫描根中取胜出技能，读取 `<name>/SKILL.md` 或 `<name>.md`（≤64KB），结果 = 全文 + 「遵循该技能指令」 | **四档通用**（唯一例外，见 §16） | 免（显示加载卡片） |
| `write_file(path, content)` | `SaveFile(path, content, '', false, 'utf-8')`（新建文件） | 编辑 | **是** |
| `edit_file(path, oldString, newString)` | `OpenFile` → 唯一性校验（多处命中=错误回给模型）→ 替换 → `SaveFile` **保留原 eol/bom/enc** | 编辑 | **是** |
| `todo_write(todos[])` | 纯前端状态 → §11 | 编辑 | 免 |
| `run_command(command, cwd?, timeoutMs?)` | 后端 `AIRunShellCommand`：shell 优先级 **Git Bash → PowerShell 7 → Windows PowerShell → cmd**；默认 30s、上限 120s；stdout/stderr 各截断 16KB | 每次询问 / 自动审批 / 完全权限（计划模式不可用） | 每次询问**是**（逐条，命令 + cwd；可勾选本会话相同/同类命令放行）；自动审批仅风险命令**是**；完全权限免 |
| `background_command(command, cwd?)` | 后端 `AICommandStart`：后台启动长驻/耗时命令，立即返回 `jobId`（`bg-<序号>`）；输出按行缓冲（每作业 256 KB 环形，超限丢弃最早）并照常广播 `cmd-out` | 每次询问 / 自动审批 / 完全权限（计划模式不可用） | 每次询问**是**（与 run_command 同一审批卡，启动时审一次）；自动审批白名单命令免；完全权限免 |
| `check_command(jobId)` | 后端 `AICommandStatus`：返回 running / exited / notfound、退出码、时长与自上次查询的**增量输出**（单次 ≤64KB，结果截断 16KB） | 同上 | 免 |
| `stop_command(jobId)` | 后端 `AICommandStop`：终止作业（taskkill 杀整棵进程树），返回最终退出码与已捕获全部输出 | 同上 | 免 |
| `schedule_create(name?, kind, at?/delayMinutes?/intervalMinutes?/cron?, prompt, sessionId?, scope?, maxRuns?)` | 后端 `AIScheduleCreate`：创建定时任务（once / interval / cron，prompt ≤8KB；scope 仅对「每次新建会话」生效） | 读取+（计划模式不可用） | 免 |
| `schedule_list()` | 后端 `AIScheduleList`：全部任务（名称、id、类型、下次触发、启停、最近结果） | 读取+ | 免 |
| `schedule_delete(id)` / `schedule_toggle(id, enabled?)` | 后端 `AIScheduleDelete` / `AIScheduleToggle` | 读取+（计划模式不可用） | 免 |

> AI 改写不再按目标文件的 512KB 设硬限制：`edit_file` / `write_file` 可处理到应用读取上限（>10MB 视为大文件，仍不可读写）；超过 4000 行时 diff 自动降级为公共前缀 / 后缀 + 中间变更块，审批预览最多 40 行。单次写入内容仍上限 256KB，大文件用 `edit_file` 做局部替换。
>
> `web_search` / `web_fetch` 由 Go 后端 `webtools.go` 执行（跟随系统代理、25s 超时、响应上限 4MB）；只允许 http/https 公网地址（解析到回环 / 内网 / 链路本地 / 保留地址即拒绝），抓取内容按不可信外部数据处理、不执行页面脚本，也不需要额外 API Key。
>
> memory 工具在**只读访问即可用**（记忆是 AI 的工作笔记而非用户数据）；写入免审批但每次显示卡片，可追溯。`skill_use` 四档通用（只读知识加载零副作用），是只读档工具集的唯一例外。`preference_*` 操作设置页的「用户偏好」列表（存于 AI 配置），同样只读访问可用、免审批，删除即时生效。
>
> **后台终端**：`background_command` 启动的作业独立于对话轮生命周期（对话结束作业继续跑，应用退出全部终止）；查状态 / 停止免审批。工具卡片在 `cmd-out` 广播到达时实时追加输出行（面板关闭时只更新缓冲数据，切回可见即恢复），卡片头部显示作业状态（后台运行中 / 已结束 / 已停止 + 退出码）。Go 侧为 `commands.go` 的作业缓冲 + `ai_command_windows.go` 的 `AICommandStart`；同时共享进程桥 16 并发上限与 8 MB 捕获上限。Git Bash 的 `bin/bash.exe` 是 wrapper（真实 bash 是其子进程），因此取消一律走 `taskkill /F /T` 杀整棵进程树并配合 `WaitDelay=3s` 兜底——这也修复了 `run_command` 超时在 wrapper shell 下可能永不返回的隐患；被终止的作业退出码统一记 -1。
>
> **定时任务**：调度器在 Go 侧（`ai_schedule.go`，单 ticker 每秒扫描），任务定义与运行状态存派生 SQLite `ai-schedule.db`（modernc pure Go，可随时删除重建，JSON/SQLite 边界与 `ai-index.db` 同一策略）。触发发 `sched-fire` 事件 → 前端注入 `[定时任务 · 名称]` 指令走 `submitText`（复用审批/流式/通知管线），执行结果经 `AIScheduleSetResult` 回写任务卡片。多窗口（独立进程）各自扫描并广播，执行去重在前端：指定会话的任务由持有该会话的窗口执行、无人认领 700ms 后报告失败；新建会话类任务优先聚焦窗口（localStorage 标记先到先得）。任务仅在应用运行期间有效：once 错过标记「已错过」停用不补跑，interval 顺延到下一个整周期，cron 取下一个匹配时刻。设置 → AI 新增「定时任务」页（列表 + 新建/编辑对话框 + 启停/删除），`/schedule` 斜杠命令直达。cron 自写 5 字段解析（约 200 行，支持 `* , - /`，周日 0/7 双写），未引入 robfig/cron。edit 档任务触发时若无人在场处理写审批会一直挂起（守则与设置页均提示）。

**范围安全**（工作区工具执行前）：路径相对 scopeRoot 解析，归一后校验仍在 scopeRoot 内；越界直接返回工具结果「路径超出工作区范围」由模型自行调整。memory/skills 目录独立于范围检查（专用目录 + 文件名白名单兜底）。symlink 逃逸风险见 §21。

**工具 schema**：在 ai-panel.js 定义 JSON Schema（含 description 中文说明），按 scope 动态组装传给 AISendChat。

---

## 9. 审批流（工作区写操作）

0. AI 发起 `run_command` / `background_command`（每次询问 / 自动审批档）→ 插入命令审批卡片：显示完整命令与工作目录，按钮 **执行 / 放弃**；自动审批档白名单命令直接执行，完全权限档直接执行。后台命令启动时审批一次，之后查状态 / 停止不再审批。工具结果返回 shell 名称、退出码、stdout/stderr、耗时；超时标记「已终止」并保留已捕获输出。命令卡默认收起为一行「run_command + 命令 + 状态」，点击展开完整输出，输出区带独立背景色。
   - **本会话允许相同命令**：完整命令字符串 + cwd（规范化后）完全一致才自动执行。
   - **本会话允许同类命令**：仅对白名单开发命令显示，签名 = 可执行文件 + 子命令（如 `git status`、`go test`、`npm run build`）；要求同 cwd、单条简单命令（无管道、重定向、命令串联、`$()`/反引号），并排除危险参数（`-exec`、`--output`、`-o`、`--prefix`、`-C` 等）。
   - 授权只存内存 `Map<sessionId, rules>`，不写会话 JSONL/meta；重启应用、重新加载对话或清空会话即失效。解释器（`powershell`/`pwsh`/`cmd`/`bash`/`python`/`node` 等）与 `rm`/`cat` 等无同类放行，只能相同命令或逐条审批。
   - 同类白名单：`git`（status/diff/log/show/rev-parse/ls-files/blame/grep/shortlog/describe/whatchanged/merge-base/name-rev/for-each-ref）、`go`（test/build/vet/list/env/version/doc）、`npm`/`pnpm`（test/run &lt;script&gt;/ls/view/outdated）、`dotnet`（build/test/list）、`cargo`（check/build/test/clippy/metadata）。构建类命令可能产生构建产物。
1. AI 发起 `write_file`/`edit_file` → 该工具轮**挂起**，面板内插入审批卡片：
   - 头部：工具名 + 目标路径 + ±行数；`edit_file` 显示**未保存修改警告**（若文件在编辑器中且 dirty）
   - diff 视图：前端 ~40 行 LCS 行 diff（对齐 gitinfo `computeLineMarks` 思路），+绿 −红 上下文灰，新文件全绿
   - 按钮：**应用** / **放弃**，外加**审批记忆**（§17.1）：「本会话允许此文件」「总是允许此文件」——授权清单 `datalens-ai.approvedPaths[]`，设置 AI 页可查看并一键清除；默认每次询问
2. 应用 → 执行 → 成功后：文件已打开且未 dirty → 自动重载（`OpenFile` 重读 setText）；dirty → flash 提示手动重载。
3. 应用记录进会话 `changes[]`（§12）。
4. 审批等待无超时（用户决策）；「停止」按钮可中止等待。

> 自动审批档：工作区写操作跳过审批卡直接应用，工具卡显示「已按自动审批应用更改」，diff 仍可展开复查；目标文件在编辑器中存在未保存修改，或路径属于 `AGENTS.md` / `.cadt/` / `.agents/` / `.git/` 时自动退回逐次审批。终端命令只有白名单内的低风险命令自动执行，其余仍弹出命令审批卡。

---

## 10. 范围模式（session.scope，四档）

| 档位 | 工具 | 说明 |
|---|---|---|
| **只读访问**（默认） | list_dir / read_file / search_text / web_search / web_fetch / memory_* / preference_*（写删计划模式不可用）+ `skill_use` + `schedule_list`（schedule_create / delete / toggle 计划模式不可用） | 范围根 = `workspaceFolder`，无工作区时 = 当前文件所在目录；免审批但每次调用显示卡片 |
| **每次询问** | 只读工具 + write_file / edit_file / todo_write / run_command / background_command（+ check_command / stop_command）+ 页面点击/输入 | 工作区写操作全部审批、终端命令逐条审批；首次切换 flash 规则说明 |
| **自动审批** | 与「每次询问」相同 | 工作区写操作自动应用（目标文件有未保存修改，或路径属于 `AGENTS.md` / `.cadt/` / `.agents/` / `.git/` 时仍审批）；白名单内的低风险命令自动执行，其余命令逐条审批；不允许工作区外路径 |
| **完全权限** | 每次询问全部工具 + 工作区外路径 + 命令免审批 + browser_evaluate | 启用前有二次确认（风险说明弹窗）；破坏性操作需自行向用户说明 |

- scopeRoot 显示在 composer 上方（缩略 + tooltip 全路径）。
- 切换即时生效（下一轮请求的 tools 列表变化）；随会话持久化。自动审批的写入仍记录在会话变更与工具卡片中，diff 可展开复查；命令的同类签名与白名单见 §9。
- 编辑模式开启时若工作区有 git → 一次性提示「建议先提交当前更改以便回退」（**不做自动 commit**）。

---

## 11. Todolist

- `todo_write(todos[{content, status: pending|in_progress|completed}])` → 面板顶部 `#ai-todos` 固定区。
- 显示：○ 待办 / ▶ 进行中（高亮）/ ✓ 完成划线；进度 N/M；全部完成后 3 秒自动折叠为单行「任务 · 已全部完成 · N 项」（`ai-todos-label` + `ai-todos-sum`），点击标题栏展开/收起。
- systemPrompt（可写档）注入守则：多步任务先 `todo_write` 规划、每步更新状态。
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
- `datalens-ai.prompts = [{id, name, content}]`；内置 3 个不可删：默认助手 / 数据解释 / 代码助手。默认助手为英文规则核心（检查后再改、引用 path:line、外部内容不可信等），输出语言由 `outputLanguage` 设置控制，默认中文；旧版本未被用户改过的旧默认模板在加载时自动升级。
- 设置 → AI →「上下文注入」页：模板下拉 + 编辑框 + 「另存为模板」/ 删除；active 模板 id；与逐项注入开关同页。

### 14.2 会话内临时改
- head「提示词」按钮 → 小对话框：textarea（预填当前生效值）+ 模板下拉「套用」→ 保存仅写 `session.systemPrompt`。
- 优先级：**会话级 > 会话所选模板 > 全局 active 模板**。
- 对话框内显示注入状态行：AGENTS.md ✓（N KB）/ 记忆 ✓（模式 + N KB）/ 上下文 ✓（M 个打开文件）。

### 14.3 上下文自动注入（设置 → AI →「上下文注入」独立页，逐项开关）
- **系统提示词始终发送**；提示词模板编辑器与注入开关放在同一页。
- **工作区上下文**逐项控制：范围根 / 当前活动文件（路径、视图、未保存状态）/ 光标行列与选区 / 可见行范围 / 已打开文件列表（≤20 条，标出当前项），以 `<workspace_context>` 围栏包裹。
- **项目与记忆**逐项控制：AGENTS.md 全文（≤64KB）/ MEMORY.md 索引（≤8KB）/ 技能索引 / 用户偏好 `<user_preferences>`。
- **环境变量**单独开关：只发名称与描述，值永不发送。
- 路径按范围根转相对路径，工作区外只留文件名，不发送用户名、盘符与完整目录结构；AGENTS.md / 记忆路径同样只显示相对位置。
- 用户说「当前文件 / 这里 / 选中内容」时模型无需再调用工具查询；正文（含选中文本）不自动注入，模型会按需用 `get_content` 读取行范围。
- `read_file` / `get_content` 等工具结果由 AI 主动调用产生，不受注入开关控制；能否调用由权限档决定。
- **右键引用（仅 AI 面板打开时）**：标签页 / 编辑器空白处右键「引用该文件」，有选区时改为「引用选取」；只把文件名、绝对路径、起止行列放进附件（`<file_reference>` / `<selection_reference>`），不读正文，避免污染上下文。
- **面板内弹出菜单**：权限 / 模型 / 更多等菜单使用全局 `ctxMenu` 打开时传 `ignoreScrollWithin: '#ai-panel'`，流式输出自动滚动或工具卡片插入不会关闭菜单；点击外部、Esc 或滚动面板外区域才关闭。
- **读取及以上档额外注入「工作区规范」**：范围根、免审批/需审批规则、工具守则（先 list/read 确认再改、edit_file 的 oldString 必须逐字唯一复制、不越界、改动前说明意图）。
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
6. 「工作区规范」（读取及以上档）
7. `<output_language>` 默认输出语言（中文（简体）/ English / 跟随用户输入）

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

### 15.3 记忆工具（只读访问起可用，见 §8）

- `memory_list()` / `memory_read(name)` / `memory_write(name, content)`。
- **写入免审批**（记忆是 AI 的工作笔记，低风险），但每次显示工具卡片（文件名 + 字符数），可追溯；MEMORY.md 与主题文件一致由守则约束。
- 删除不做工具（AI 可用 write 清空内容）；物理删除交给用户在「记忆」对话框手动操作。

### 15.4 注入与守则

- 每轮注入 `MEMORY.md`（存在时，≤8KB 截断）到 `<memory>` 段（顺序见 §14.5）；主题文件由 AI 按索引用 `memory_read` 按需拉取。
- 只读访问起守则注入：「你有持久记忆（列出工具）；用户偏好、项目重要事实、跨会话结论应写入记忆；写入后同步更新 MEMORY.md 索引；记忆与 AGENTS.md 分工——AGENTS.md 是用户手写约定（只读），记忆是你自己积累的笔记（可写）」。
- 首次使用（目录空）：守则提示 AI 可在合适时机建立 MEMORY.md。

### 15.5 用户手动管理（head「记忆」按钮 → 对话框）

- 当前模式 + 生效路径（只读显示）+ 模式切换入口（跳设置）。
- 记忆文件列表（名称/大小/修改时间）：**打开**（应用内编辑器打开 md）/ **删除**（确认）/ 新建空文件。
- `datalens-ai` 存 `memoryMode`；文件本体永远在磁盘（不进 localStorage），会话/机器间天然持久。

---

## 16. 技能系统（SKILL.md）

### 16.1 多目录来源与 rank 优先级（对齐 dsh）

| Rank | 来源标签 | 路径 | 特点 |
|---|---|---|---|
| 100 | 工作区 | `<工作区根>\.cadt\skills\` | 跟项目走、可入 git 团队共享 |
| 200 | 工作区·通用 | `<工作区根>\.agents\skills\` | 项目内跨 agent 通用目录 |
| 400 | 应用 | `%APPDATA%\CandySweet\CaDt-DataLens\ai-skills\` | 本应用全局技能，跨工作区可用 |
| 500 | 用户·通用 | `%USERPROFILE%\.agents\skills\` | 用户级跨 agent 通用目录 |
| 600 | 内置 | 前端 `AI_BUILTIN_SKILLS` | 随应用分发 |

- **rank 越小越优先**；同名技能只保留低 rank 的一份。同 rank 内按根注册顺序、再按根内条目名排序，先到先得。
- 项目根 = 打开的工作区根；未打开工作区时退到当前文件所在目录 / 范围根（不像 dsh 一样上溯到 `.git`，因为本应用的“工作区”是用户显式选择的）。
- 内置 `cadt-ui` 在应用操作关闭时隐藏；其余内置技能始终参与兜底。

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

- 列表（名称 / 来源 工作区|工作区·通用|应用|用户·通用|内置 / 描述 / 启用开关）+ **在编辑器中打开** + **打开所在目录** + 新建（模板）。
- 禁用列表 `datalens-ai.disabledSkills[]` 持久化（per-skill）。
- workspace 技能提示「该目录可提交 git 与团队共享」。

### 16.5 分工（与 AGENTS.md / 记忆）

| 机制 | 谁写 | 加载方式 | 用途 |
|---|---|---|---|
| AGENTS.md | 用户手写 | 每轮全文注入 | 项目全局约定 |
| 记忆 | AI 积累 | MEMORY.md 索引 + 按需 read | 跨会话事实/偏好 |
| 用户偏好 | 用户或 AI（`preference_*`） | 每轮全文注入（`<user_preferences>`） | 长期回答/工作方式约定（短条目） |
| **技能** | 用户或团队分发 | **按需 skill_use 加载** | **领域操作指令包（复用）** |

---

## 17. 通用配置项（harness 对齐汇总）

### 17.1 新增项（v8 并入）

| 配置 | 存储 | 默认 | 说明 |
|---|---|---|---|
| 网络代理 | per profile `proxy` | `'system'` | 直连 / 跟随系统 / 自定义 `http(s)://` URL（Go Transport Proxy，自建网关/科学上网场景） |
| 自定义请求头 | per profile `extraHeaders` | 空 | k=v 行编辑 ≤8 条（网关租户头、鉴权变体）；内容不落日志 |
| 发送快捷键 | `aiSendKey` | `'enter'` | Enter 发送（Shift+Enter 换行）或 Ctrl+Enter 发送（Enter 换行）——IME 用户常选后者 |
| 默认输出语言 | `outputLanguage` | `'zh'` | `zh` / `en` / `auto`；每轮注入 `<output_language>`，不改变代码、命令与路径；下一轮生效 |
| 聊天字号 | `aiChatFont` | `13` | 12–20，仅面板消息区 |
| 审批记忆策略 | `approvedPaths[]` | 每次询问 | 审批卡片可选「本会话允许此文件 / 总是允许此文件」；设置页可查看授权清单并一键清除 |
| 终端命令本会话放行 | 内存 `Map<sessionId, rules>` | 无 | 审批卡片可选「本会话允许相同命令」（命令 + cwd）或「本会话允许同类命令」（白名单签名）；不落盘，重启/重新加载/清空会话失效 |
| 用户偏好 | `preferences[]` | 空 | 长期偏好的短条目（id/text/source，≤500 字、上限 100 条）；设置页可增删改，AI 用 `preference_*` 维护；每轮注入 `<user_preferences>` |
| 上下文注入开关 | `aiInjectRoot` / `aiInjectActiveFile` / `aiInjectCaret` / `aiInjectViewport` / `aiInjectOpenFiles` / `aiInjectAgentsMd` / `aiInjectMemory` / `aiInjectSkills` / `aiInjectPreferences` / `aiInjectEnvVars` | 全开 | 设置 → AI →「上下文注入」逐项控制；旧 `aiInjectContext=false` 首次升级时迁移为工作区子项全部关闭 |
| 会话存储 | 磁盘 `ai-sessions/` | — | 追加式 JSONL + 每会话 `meta.json`；不自动删除，手动删除进回收站；`datalens-ai-storage=legacy` 可临时回退旧 localStorage |
| 首轮自动标题 | `autoTitle` | 开 | 首轮结束后额外请求一次模型生成 6–16 字标题；失败保留首条消息前 24 字 |
| Token 用量显示 | 开关 `aiShowUsage` | 开 | `ai-done.usage`（API 提供则显示）→ 消息 meta 标 tokens、会话累计；无 usage 的端点自动隐藏 |
| 配置导入/导出 | — | — | 导出 profiles/prompts/preferences/memoryMode/approvedProfiles 为 JSON（**默认不含 apiKey**，勾选才含）；导入按 id 合并（偏好按文本去重） |
| 快捷键登记 | — | — | Alt+9 与发送键登记进设置-快捷键页 |
| 上下文窗口 | per profile `contextWindow` | `128000` | 8K–1M tokens；用于 /context 占比与发送前超限拦截（§5.2） |
| 压缩提示阈值 | `autoCompactThreshold` | `0.8` | 占比 ≥ 阈值显示「建议 /compact」banner，并作为自动压缩的触发点 |
| 自动压缩上下文 | `autoCompact` | `true` | 每轮结束后超阈值自动 `/compact`；同会话连续 2 次后停止自动触发 |
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
2. **面板 UI + 会话 + OpenAI 兼容对话跑通**：面板结构/活动栏/Alt+9/视图菜单/空态 + **三种显示方式**（停靠含最大化/吸附/悬浮，几何持久化）+ 流式收发 + **思考链折叠区**（ai-think 流式展开/完成收起）+ **常用消息操作**（复制/重新生成/编辑重发/回到底部/导出 md/重试/停止）+ **基础斜杠命令**（/clear /context 估算 /help /model /export /memory /skill）+ **发送键/聊天字号/用量显示/会话管理**
3. **注入系统 + 工具桥（读取档 + memory + skills）**：workspace_context/AGENTS.md/MEMORY.md/**技能索引**注入与守则 + 四档切换 + 工具 schema + list/read/search/**memory 三件套**/**skill_use** 执行 + 工具卡片 + 附加（chips/文件树右键/**技能 chip**）
4. **每次询问 / 自动审批档**：审批 diff 卡片/edit_file/write_file/**审批记忆（本会话/总是允许+授权清单）**/变更记录/todo_write+显示
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
- [ ] 四档切换：只读档不发写工具；每次询问/自动审批/完全权限首次切换有规则提示；完全权限二次确认弹窗内容与取消/确认按钮正确。
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
13. **思考链存储膨胀**：reasoning 全文随消息追加进磁盘 JSONL（单条 ≤32KB 截断标注）；重生成会替换旧 reasoning。OpenAI 官方 o 系列 reasoning summary 走 Responses API，v1 不支持（兼容端点无此字段，留后续）。
14. **Anthropic thinking 签名**：多轮工具调用必须原样回传 thinking block + signature，前端不可改写其内容；丢弃会导致 400。
15. **技能是提示注入面**：工作区 `.cadt/skills`、`.agents/skills` 与用户级 `~/.agents/skills` 都可能由外部/团队写入，与 AGENTS.md 同级信任；提供来源标示（工作区|工作区·通用|应用|用户·通用|内置）+ per-skill 禁用 + 加载卡片审查；SKILL.md ≤64KB 截断。
16. **技能格式宽容度**：frontmatter 缺省自动降级（name 取文件名/description 取首行），但畸形 YAML 需容错（解析失败按无 frontmatter 处理并提示）。
17. **代理与自定义头**：凭据/头内容不进日志（§6 已约束）；自定义头可覆盖安全头（仅允许白名单外的业务头，禁改 Host/Content-Length）。
18. **审批记忆的信任边界**：「总是允许」仅按**规范化绝对路径**匹配，目录移动/重命名后自然失效；授权清单可在设置随时清除。
19. **Token 为估算值**：不引入 tokenizer 依赖，按字符近似（标注「估算」）；展示 API usage 实际值时区分标注；超限拦截预留 10% 余量避免误杀。
20. **/compact 信息损失**：摘要不可逆（原文进 archived 仅查看不回灌）；压缩前二次确认，可取消；连续压缩会产生「摘要的摘要」，提示用户。
21. **/init 写盘**：与 AI 写文件同一审批通道（用户主动触发也走审批卡片），工作区外不可用。
22. **终端本会话放行边界**：只存内存、不落盘；相同命令要求命令 + cwd 完全一致；同类命令只认白名单签名、同 cwd、无管道/重定向/命令串联，解释器命令不支持同类放行；重启、重新加载或清空会话即失效。
17. **悬浮/吸附是应用内浮层**：非独立 OS 窗口（不能拖出应用外；Wails v2 多窗口受限），层级需与菜单/对话框/右键菜单协调（面板 z-index 低于模态对话框）；拖拽用 pointer events + setPointerCapture，避免与文本选区冲突。
18. **停靠↔吸附切换抖动**：同一 DOM 重定位时流式渲染不中断（事件按 id 路由与 DOM 无关，已天然解耦）。

## 应用操作桥（app_control 工具 + cadt-ui 技能，2026-11-11）

AI 助手可通过 **app_control** 工具像真人一样操作当前应用窗口：标签页管理、视图/主题/设置切换、面板开关、AI 会话管理等。仅限当前窗口；不改工作区文件；**所有权限档可用**——UI 操作不落盘，危险路径（关闭脏标签）复用既有确认弹窗由真人批准。

- 执行端：main.js `runAppAction(action, params)`（挂在 `window.__lens.runAppAction` 可手动调试），动作映射到既有闭包函数（switchMode/activateDoc/requestCloseDoc/toggleDockView/openSettings…），宿主对象以 `runAppAction` + `hostAppActions`（动作名列表，用于报错提示）注入。
- 工具参数：`{action: string, params?: object}`；未知动作报错并附 `APP_ACTIONS` 全表。
- 只读查询动作（所有权限档可用）：`get_settings {keys?}`（当前全部设置值 + 可写键）、`get_editor {target?}`（视图/编码/换行/BOM/行数/字符数/光标/选区预览）、`get_content {target?, startLine?, endLine?, maxChars?}`（编辑器内存实时文本，含未保存修改，默认 20k 字符）、`get_git`（仓库/分支/变更计数与列表）、`get_ai`（面板开关/权限档/计划模式/模型/会话/偏好统计）、`get_explorer`（根目录与选中项）、`get_plugins`（插件列表）、`get_terminal {id?, lines?}`（终端会话与缓冲区末尾文本，默认 40 行）。
- `set_setting` 走 `APP_SETTING_RULES` 白名单（bool/number 范围/enum/theme），改后 `applySettings()` 即时生效并持久化；openMode 的后端同步走 applySettings 内既有 syncedOpenMode 逻辑。
- AI 会话桥：ai-panel 返回对象新增 `bridgeNewSession({title,message})`（open + newSession + submitText）、`bridgeSwitchSession(id)`、`bridgeListSessions()`；`ai_new_session` 带 message 会真实触发一次模型调用。当前会话还没发过消息时 newSession 复用该会话（只重命名，不重复创建空会话）。
- 配套内置技能 **cadt-ui**：动作全表 + 使用顺序（先 get_state）+ 边界（不保存/不删除/不跨窗口/无任意 DOM 模拟）。
- 刻意不提供：保存/另存为（写文件走 write_file/edit_file 审批）、删除/重命名（已有专用工具+回收站）、跨窗口操作、鼠标模拟；键盘模拟 type_text/press_key 仅完全权限档。
