# AI 助手 v2 方案（子代理团队 · 后台终端 · 定时任务 · 计划，待批准后实施）

> 状态：**拟定（2026-11-11，基于已完成 v1 的只读调查）· 功能 A（后台终端）与功能 C（定时任务）已实施（2026-11-12）** · 前置：`docs/ai-panel.md`（v1 已全部实施，批次 1–6 + 应用操作桥 + Todolist 重构）
> 定位：三个 v2 方向——**子代理调用（智能体团队）**、**后台终端（AI 长驻/后台作业）**、**定时任务（schedule / 循环唤醒 / 单点唤醒）**。
> 本文所有行号以 2026-11-11 工作区快照为准（ai-panel.js 9109 行、ai.go 1446 行），实施时可能漂移，以符号名为准。

---

## 0. 背景与目标

v1 已交付：单流 Agent 循环（15 轮）、15 个工具、四档权限（只读访问 / 每次询问 / 自动审批 / 完全权限）、写审批、计划模式、上下文压缩、图片附件、记忆/技能、app_control 应用操作桥。

v2 补齐三类「harness 级」能力：

| 方向 | 用户价值 | 现状 |
|---|---|---|
| 子代理调用 | 并行探索/多视角审查/长任务隔离，主会话不被子任务中间过程污染 | 完全没有 |
| 后台终端 | AI 可启动长驻/耗时命令（构建、watch、服务器），稍后回来查输出、停止 | `run_command` 只能同步阻塞（≤120s），提示词明确禁长驻命令 |
| 定时任务 | 「每 N 分钟检查一次」「明早 9 点跑」「10 分钟后提醒我继续」 | 完全没有，Go 侧零 timer 基础设施 |

---

## 1. 现有基础设施盘点（已核实，2026-11-11 只读调查）

### 1.1 Go 流式内核（ai.go）——天然支持并发流

- `aiStreams` 是 `map[sessionId]*entry`（ai.go:141）；`AISendChat` 仅在**同 sessionId** 时互踢旧请求（ai.go:174–179）。多 sessionId 并发流后端无需改动。
- `AIStop(sessionId)` 按 `id == sessionId || HasPrefix(id, sessionId+"#")` 前缀取消（ai.go:215–231）——若子代理 sessionId 以主 sessionId 为前缀（如 `main#sub-1`），停止主会话会连带取消其子代理，该语义可显式利用。
- 事件归一化：`ai-chunk / ai-think / ai-toolcall / ai-done / ai-error`，payload 自带 `Id`（即前端传入的 sessionId，含 roundId）；空闲 120s watchdog（ai.go:30, ai.go:504）。
- 工具上限：`aiMaxToolDefs = 64`（单请求工具定义数）；消息校验支持 role=tool / toolCalls 回填（双协议都已实现）。

### 1.2 前端单流假设（ai-panel.js）——子代理的唯一大改造点

- `stream` 是模块级**单例**全局变量（ai-panel.js:4708 处创建），一次只有一个活跃流。
- `handleEvent` 硬过滤：`if (!stream || !payload || payload.id !== stream.roundId) return;`（ai-panel.js:5076）——非当前流事件直接丢弃。注意 `/compact` 的 oneShot 分支也走同一个 `handleEvent`（ai-panel.js:5061–5075），改造路由时必须保持其行为。
- roundId 格式：`session.id + '#' + baseRound + '-' + roundNo`（ai-panel.js:4777）；每会话 `session.round` 递增。
- Agent 循环：`submitText → startRound（ai-panel.js:4757）→ ai-done(finishReason=tool) → handleToolRound（ai-panel.js:4977）→ executeTool（switch，ai-panel.js:4084）→ 顺序执行 → startRound`，15 轮上限（ai-panel.js:5039）。
- 工具白名单在流启动时固化为 `s.tools`（ai-panel.js:4722），`handleToolRound` 里用 `Set` 校验（ai-panel.js:4996）。
- 事件注册：`initAIPanel()` 在 main.js:14048 启动时无条件调用；main.js:10742 处统一 `rt.EventsOn` 转发进 `aiPanel.handleEvent`——**面板关闭时事件监听依然活跃**，这是定时任务能在面板关闭时触发的前提。

### 1.3 工具与权限（ai-panel.js:3285 AI_TOOL_DEFS / 3480 toolsForScope）

- 现有 32 工具：list_dir、read_file、search_text、web_search、web_fetch、memory_list、memory_read、memory_write、preference_list、preference_write、preference_remove、skill_use、plan_mode、ask_user、app_control、env_list、env_create、todo_write、write_file、edit_file、run_command，另有 browser_* 11 个（navigate / back / forward / reload / snapshot / screenshot / click / type / press_key / evaluate / close）。
- 四档：只读访问 / 每次询问 / 自动审批 / 完全权限；planMode 收走 memory_write、preference_write、preference_remove、write_file、edit_file、run_command。
- `run_command`（ai-panel.js:4889，schema 3692）：edit 档逐条审批（requestCommandApproval）、full 档免审批；后端 `AIRunShellCommand`（ai_command_windows.go:51）→ `RunCommandSync`（commands.go:74）同步执行，shell 优先级 Git Bash → pwsh → Windows PowerShell → cmd，超时不算错误（TimedOut=true + 已捕获输出）。**输出经两层上限**：后端 `commandOutputCap` 8 MB（commands.go:27，超限写入 `…输出超过 8 MB 上限，已截断…`），前端 `clip` 再把 stdout/stderr 各截到 **16000 字符**（附 `…（输出已截断）`）——模型实际最多看到约 32 KB 文本。

### 1.4 进程桥与终端（commands.go / terminal_windows.go）

- `RunCommandSync`（commands.go:74）：同步、超时上限 120s（前端 `aiClampInt(input.timeoutMs, 1000, 120000, 30000)`）、输出上限 8MB（`commandOutputCap`，commands.go:27）。注意 8MB 是后端捕获上限，模型看到的是前端 `clip` 后的 16000 字符/流。
- `StartCommand/StopCommand`（commands.go:126/233）：**流式后台命令**——按行发 `cmd-out {id, stream, data}` / `cmd-exit {id, code}` 事件，并发上限 16（commandMaxRunning）、单行 64KB、总输出 8MB 截断；id 由调用方生成。**输出发出后无人持久化**（ring buffer 缺失）。
- pty 终端：go-pty v0.2.3 ConPTY，会话上限 8（terminal_windows.go:22），`TermCreate/TermWrite/TermResize/TermClose`，`term-out/term-exit` 事件只推 UI 面板，AI 拿不到。
- `cmd-out/cmd-exit` 前端订阅已存在（main.js:13990）——供进程桥/插件使用。

### 1.5 会话持久化与多窗口

- 会话自 2026-11-11 起存磁盘 `%APPDATA%\CandySweet\CaDt-DataLens\ai-sessions\<id>\`（追加式 `session.v1.jsonl` + `meta.json` + `images/`），Go 侧只提供读写接口不解析内容；**无单会话消息条数上限**、无会话数上限、无图片预算裁剪与配额降级。
- 多窗口模式（openMode=window）每个窗口是独立进程但共享同一 WebView2 用户目录与 `ai-sessions/`；并发写按每会话独立文件 + 追加式写入处理（先写先得，后加载按日志重放合并），详见 `docs/reports/session-storage-jsonl.md`。
- 会话搜索使用**可重建的 SQLite 派生索引** `ai-index.db`（modernc），JSONL 仍是唯一真源；AI 配置（profiles/prompts/preferences）存 `ai-config.json`，localStorage 保留镜像。
- Go 侧除 AI watchdog 外无任何 timer/Ticker/cron 基础设施。

---

## 2. 功能 A：后台终端（✅ 已实施，2026-11-12）

> 实施记录：按方案 A 落地——`commands.go` 增加作业缓冲（256 KB 环形 + 游标增量读取，单次 ≤64 KB）与 `AICommandStatus / AICommandStop` 绑定，`ai_command_windows.go` 增加 `AICommandStart`；前端三工具与审批策略与 run_command 完全共用（抽取 `approveCommandForRun`）。实施中发现的关键点（原方案未预见）：Git for Windows 的 `bin/bash.exe` 是 wrapper、真实 bash 是其子进程，仅 Kill wrapper 会让输出管道永不关闭——Go 侧取消统一改为 `taskkill /F /T` 杀整棵进程树 + `cmd.WaitDelay=3s` 兜底，顺带修复了既有 `RunCommandSync`（run_command）超时可能永不返回的隐患；被终止作业退出码统一记 -1，前端映射为「已停止」。已结束作业保留最近 32 个供查询。`cmd-out` 实时追加走 main.js 既有的 `cmdOutHandlers` 分发（`commandOutput` 选项注入 ai-panel），与插件 `runCommand` 同一机制。

### 2.1 方案 A（推荐）：后台命令作业 = StartCommand + 输出缓冲 + 状态查询

**Go 侧（扩展 commands.go，不新起炉灶）：**

- 输出 ring buffer：`StartCommand` 时为每个 id 建内存缓冲（建议 256KB，超限从头丢弃），`cmd-out` 写入缓冲的同时照常 emit；退出码/开始时间/结束时间一并记录。
- 新绑定（ai_command_windows.go 同族或 commands.go 直出）：
  - `AICommandStart(command, cwd string) → {jobId, shell}`：内部走 aiShellInvocation（复用现有 shell 优先级）+ StartCommand，jobId 由 Go 生成（`bg-<seq>`），**不闪窗口、审批语义由前端控制**；
  - `AICommandStatus(jobId, since int) → {state: running|exited|notfound, code, durationMs, output: 增量文本, truncated, cursor}`：按游标返回增量，空轮询返回 state 即可；
  - `AICommandStop(jobId)`：= StopCommand。
- 作业独立于 AI 会话生命周期：本轮对话结束作业继续跑；应用退出全部终止（现有进程行为）。

**新工具 3 个（edit/full 档，审批策略与 run_command 一致；启动时审批一次，查状态/停止不再审批）：**

- `background_command`：`{command, cwd?}` → 立即返回 jobId + shell。系统守则注入：「长驻/耗时命令用它；启动后用 check_command 轮询，不要同步 run_command 跑长任务」。
- `check_command`：`{jobId, since?}` → 状态 + 增量输出（16KB 截断同 run_command 的 clip）。
- `stop_command`：`{jobId}` → 终止并返回最终退出码。

**UI**：工具卡片在 `cmd-out` 广播到达时实时追加输出行（复用 main.js:13990 已有订阅转发进 ai-panel；面板关闭时只入缓冲，切回可见）；作业列表可不做独立 UI，卡片内联即可。

### 2.2 方案 B（暂缓）：pty 交互会话

AI 直接复用 ConPTY 会话可跑交互式程序，但需要 `TermSessionsList` / AI 侧增量读取绑定、与 UI 终端共享 8 会话配额、输出交织问题。v2 先不做，方案 A 覆盖 90% 场景（构建/测试/watch 用后台命令足够）。

---

## 3. 功能 C：定时任务（✅ 已实施，2026-11-12）

> 实施记录：按 3.1 架构落地——调度器在 Go（新 `ai_schedule.go` + `ai_schedule_test.go`，startup 启动单 ticker 每秒扫描；调试控制台窗口进程不启动），任务存派生 SQLite `ai-schedule.db`（modernc，busy_timeout + WAL，与 `ai-index.db` 同策略；AGENTS.md 的「唯一 SQLite 例外」据此扩为 ai-index.db 与 ai-schedule.db 两个派生索引，均 JSON/原文为真源、可删可重建）。cron 按建议自写 5 字段解析（`* , - /`，周日 0/7 双写；日与周都受限时按标准 cron 取或语义）。触发 `sched-fire` → 前端注入 `[定时任务 · 名称]` 指令走 submitText，结果经 `AIScheduleSetResult` 回写。多窗口去重按 3.4 实现（localStorage 标记 + 聚焦窗口优先 + 700ms 无人认领报告失败）。与方案的两处偏差：① 工具审批未做「创建确认卡片」，改为与 memory_write 同策略（免审批但卡片可见可追溯，守则要求创建前与用户确认）；② schedule_* 工具读取档即可用（原方案写「对话档」，四档化后对应只读访问），计划模式不可用。

### 3.1 架构决策（先定边界）

- **调度器放 Go 侧**：Chromium 对最小化/后台页面的 timer 节流不可控，Go ticker 不受影响；且面板关闭时前端逻辑仍活着（initAIPanel 启动即注册），Go 发事件即可驱动执行。
- **任务定义与运行历史存 SQLite**（`%APPDATA%\CandySweet\CaDt-DataLens\ai-schedule.db`，modernc pure Go）——**已定方向，但调度器本身尚未实现**；不再是 `ai-schedules.json`。
- **执行体在前端**：会话在磁盘 JSONL、AI 配置在 `ai-config.json`，Go 可读取；但触发仍沿用「Go 发 `sched-fire` 事件 → 前端向目标会话注入 user 消息走 `submitText`」，以复用审批/流式/通知管线。
- **v1 边界（明确写入 UI 文案）**：任务仅在**应用运行期间**有效；窗口关闭后任务挂起，重开后不补跑（启动时把 `nextRunAt` 重算，错过的只记日志）。若未来要「关闭也执行」，Go 侧只能做到 Windows Toast 提醒，无法替用户跑 AI 轮次。

### 3.2 数据模型

```
Schedule {
  id, name,
  kind: 'once' | 'interval' | 'cron',
  at: string          // once：绝对本地时间 ISO，或创建时 delayMinutes 换算
  intervalMinutes: n  // interval：循环间隔
  cron: '分 时 日 月 周' // cron：5 字段，支持 * 、列表、范围、*/步进
  prompt: string      // 触发时注入的指令（≤8KB）
  sessionId: string   // 目标会话；空 = 每次新建会话
  scope: 'chat'|'read'|'edit',  // 触发轮次的权限档（新建会话时用）
  enabled: bool,
  createdAt, lastRunAt, nextRunAt, runCount, maxRuns  // maxRuns 供 once=1 / 有限次
}
```

### 3.3 Go 侧（新文件 ai_schedule.go，风格对齐 appdata.go/skills.go）

- 绑定：`AIScheduleList / AIScheduleCreate / AIScheduleUpdate / AIScheduleDelete / AIScheduleToggle`（写 json 文件 + 内存表 + 单 ticker 每秒扫描 nextRunAt）。
- cron 解析：**建议自写 5 字段解析**（约 150–200 行，支持 `* , - /`），与项目「能不引依赖就不引」的风格一致（ConPTY 是自写失败后才用 go-pty 的先例）。备选 robfig/cron/v3（MIT、纯 Go、很小），由作者定夺。
- 触发：`runtime.EventsEmit(ctx, "sched-fire", {scheduleId, sessionId, name, prompt, runNo})`；once/达 maxRuns 触发后自动删除；`lastRunAt/nextRunAt/runCount` 回写文件。
- 启动时加载 + 重算 nextRunAt；错过（now > nextRunAt 且非 interval 周期对齐）→ interval 顺延到下一个整周期，once 直接标记 miss 记日志。
- 全部调度状态变更可发 `schedules-changed` 事件供前端刷新列表。

### 3.4 前端

**新工具（对话档即可用——不碰文件系统，但每次触发都消耗 token，创建时前端弹确认卡片）**：

- `schedule_create`：`{name, kind, at?|intervalMinutes?|cron?, prompt, sessionId?, scope?, maxRuns?}`；
- `schedule_list` / `schedule_delete` / `schedule_toggle`。

**管理 UI**：`/schedule` 斜杠命令 + 设置 → AI 助手新增「定时任务」区（列表：名称/类型/下一次触发/最近触发/启停/删除）；活动栏 AI 会话视图可加角标。

**触发流程**：收到 `sched-fire` → 校验本窗口是否存在目标 sessionId（**多窗口歧义消解**：广播会被所有窗口收到，仅持有该会话的窗口执行；新建会话类任务由「当前聚焦窗口」执行，其余忽略——若都无法判定，取先收到者，用 localStorage 标记去重）→ 面板静默 open → 会话注入 user 消息（正文前缀 `[定时任务 · name]`）→ 走 submitText → 完成/失败走**现有通知系统**（toast + 系统通知，v1 已有）→ 会话已删除/不存在则 toast 失败并把该次记入任务 lastResult。

**与计划模式的交互**：定时触发的轮次若会话处于 planMode，行为与手动发送一致（只读规划）；approval 类接管（ask_user/写审批）超时策略复用现有设置。

---

## 4. 功能 D：子代理调用（智能体团队，建议第三批，前端最大重构）

### 4.1 总原则

- **Go 不动**：aiStreams 已支持并发；请求发独立 sessionId 即获得独立流。
- **主流零回归**：现有 `stream` 单例语义保留为「主流」；新增子流注册表，事件路由改造必须同时保住 `/compact` oneShot 分支（ai-panel.js:5061）。

### 4.2 前端改造核心

- **流注册表**：`const streamRegistry = new Map()`；主 stream 对象与子流对象同构（sessionId/baseRound/roundNo/roundId/assistant/toolCalls/tools/…）。`startRound`/`handleToolRound`/`finishStream` 全部改为接收流对象参数，内部全局 `stream` 引用替换为 `s`（该函数族已经大多用 `s = stream` 局部变量，改动可控）。
- **事件路由**：`handleEvent` 改为从 payload.id 提取 sessionId（`id.split('#')[0]`）查注册表；查不到且不是 oneShot → 忽略（与现状一致）。
- **子会话**：轻量 session 对象，不进活动栏 sessions 主列表；主会话消息里只存子代理卡片元数据（name/task/status/summary/tokens/ms/rounds）。子代理消息上限独立（如 60 条）、轮次上限独立（默认 15，可由 spawn 参数调低）。
- **并行度**：同时运行子代理上限 4（超出排队）；总流数受 Go 无上限、浏览器内存约束即可。
- **停止语义**：用户停止主会话 → 前端逐个 `AIStop(subId)` + 子代理卡片标 stopped；子代理 id 取独立 uuid（**不要**以主 sessionId 为前缀），避免依赖 AIStop 的前缀巧合——是否利用 `main#sub-x` 前缀格式让后端一键连带取消，实施时定夺（前缀格式可省去前端逐个 stop，但会话 id 可读性差）。

### 4.3 新工具（edit/full 档 + 计划模式可用——子代理只读探索正是计划模式的刚需）

- `spawn_agent`：`{name, task, scope: 'chat'|'read'（v1 子代理不给 edit）, maxRounds?, skills?}` → 返回 agentId，立即挂起主循环等待（v1 用阻塞式：主会话 tool 卡片显示运行中，子代理完成后 tool_result 回填；并行 spawn 多个 = 先 spawn 全部再依次 await）。
- 子代理完成时 tool_result = 最终答复摘要（8KB 截断）+ 状态行（轮次/用时/token）。
- `agents_status`（可选）：列出本会话子代理运行状态。
- **交互工具在子代理中禁用**：ask_user、写审批（write/edit/run_command 本就不给）、env_create 不进子代理 toolsForScope；子代理需要用户拍板时立即结束并在结果中声明「需用户决策：…」。spawn 的系统提示 = 精简默认提示 + task 注入 + 「你是子代理，完成后输出最终结论」。

### 4.4 UI

- 主会话消息流中子代理以**卡片**呈现：名称 + 任务 + 状态（运行中 spinner / 完成 ✓ / 失败 / 停止）+ 轮次与用时；点击展开可查看子对话完整转录（只读，独立滚动容器，复用 .ai-process 折叠样式思路）。
- 完成/失败接入现有通知系统；活动栏 AI 会话列表对含运行中子代理的会话加角标。

### 4.5 持久化

- 子对话**不随 sessions 持久化**（重开应用后卡片保留元数据 + 最终摘要，展开显示「子对话已归档」）；避免会话存储被并行探索撑爆。

---

## 5. 分批实施路线（每批独立构建 + 验证 + exe 同步）

| 批次 | 内容 | 主要改动面 | 规模 |
|---|---|---|---|
| A | 后台终端 | commands.go（缓冲+状态）、ai_command_windows.go（AICommandStart/Status/Stop）、ai-panel.js（3 工具 + 卡片输出流）、ai-panel.md 同步 | 小 |
| B | 定时任务 | 新 ai_schedule.go + ai_schedule_test.go、ai-panel.js（4 工具 + /schedule + 触发流程 + 设置区）、index.html/style.css（设置区） | 中 |
| C | 子代理 | ai-panel.js（流注册表重构 + spawn_agent + 卡片 UI）、style.css（卡片） | 大 |

- 每批照例：`npm run build` → `go vet ./...` → `go test ./...` → `wails build` → **同步 datalens.exe 并比对 SHA256**（记忆条目：构建后必须覆盖根目录启动副本）→ 浏览器 mock 验证 → 提交推送 GitHub + Gitee。
- **提交协调**：当前工作区混有并行 envvars 会话半成品（commands.go / terminal_windows.go / index.html / style.css / ai-panel.js / main.js 均在其列）；批次 A 恰好也要动 commands.go——**等 envvars 落地一起提交，或作者裁定 selective staging**，动手前每轮先 `git diff` 确认边界。

## 6. 验证清单

- **A**：mock 下 background_command 启动 sleep/长循环命令 → 立即返回 jobId；check_command 首轮 running + 增量、结束轮 exited + code；stop_command 中途终止返回已捕获输出；启动审批卡片出现且取消后无进程残留；8MB 超限截断；16 并发上限报错文案；面板关闭期间输出只入缓冲、切回可见。
- **B**：once（1 分钟后）到点触发注入消息并跑轮次；interval（每 2 分钟）连续两轮；cron（每分钟）正确；面板关闭时触发静默执行 + toast；目标会话删除后 toast 失败；maxRuns 用尽自动移除；应用重启后 nextRunAt 重算且不错误补跑；多窗口只执行一次；设置区增删改查 + 启停。
- **C**：spawn_agent 只读探索（list_dir/read_file 两轮）结果回填主会话 tool 卡片；并行 2 个子代理事件互不串流（子 A 的 chunk 不出现在子 B 卡片）；主会话停止连带子代理停止；子代理内调用 ask_user 被拒并在结果中声明；15 轮上限独立生效；主流普通对话/压缩/compact 回归通过；重开应用后卡片保留摘要。

## 7. 风险与备注

1. **事件路由改造是最大回归面**：handleEvent 同时服务主流、oneShot（/compact）与未来的子流——改造时三种路径都要有回归用例（验证清单 C 已含）。
2. **限额**：15 轮上限、contextWindow 预算 + 自动压缩、会话存储体积（v1 不持久化子对话）——子代理并行探索会放大 token/存储消耗；v1 用独立上限 + 不持久化子对话规避。
3. **多窗口广播**：sched-fire 会被所有窗口收到，去重逻辑必须做（3.4）；子代理无此问题（事件按 roundId 只被持有者消费）。
4. **Chromium 节流**：任何「前端 setTimeout 调度」的替代实现都不可靠，调度器必须在 Go（3.1）。
5. **cron 依赖决策**：自写 5 字段（无依赖、约 200 行）vs robfig/cron/v3（MIT）——建议自写，与项目风格一致；若作者想支持秒级/复杂语法再引库。
6. **审批超时**：定时任务触发时若用户不在电脑前，写审批会一直挂起——v1 定时任务 scope 默认 chat/read，edit 档任务触发时提示用户在场再跑。
7. **aiToolNameRule**（ai.go:53）：新工具名 `background_command / check_command / stop_command / schedule_create / schedule_list / schedule_delete / schedule_toggle / spawn_agent / agents_status` 全部符合 `[A-Za-z0-9_-]{1,64}`，无需动后端校验。
