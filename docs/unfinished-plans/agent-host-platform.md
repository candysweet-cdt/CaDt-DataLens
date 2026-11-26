# Agent 宿主平台与多工作区 Harness（整合方案）

> 状态：**线 A（S0–S3）已实施并合入**；**线 B（S4–S7）未开工，已完成代码级复核**（§2.6，2026-11-27）。
> 本文整合并取代两份前序文档：
> `docs/unfinished-plans/workspace-seamless-switch.md`（多工作区换手 + harness，v6）与
> `docs/unfinished-plans/agent-platform-for-writing-plugins.md`（Agent 宿主平台化评估）；
> 隔离现状的代码依据来自 `docs/reports/workspace-isolation-audit.md`。
>
> 结论先行：
> 1. **产品定位**：CaDt 是「多工作区 GUI harness + 可扩展宿主」。六个开源 harness
>    （opencode / pi / ZCode / codex / cline / deepseek-harness）**无一支持一个界面管多个仓库的会话**
>    （全部单 cwd / 单 environment），这是 CaDt 的差异化空间；DSH 则作为单工作台执行引擎，两者互补而非替代。
> 2. **两条线共享同一地基**：线 A（多工作区）要「根是会话属性」，线 B（平台化）要「事件溯源会话」——
>    改的是同一层（session 模型 + `ai-panel.js`），所以必须统一排期，不能并行抢同一批文件。
> 3. **最小可交付切片 ≈ 4 人日**（S0 + S1）——**已交付**：拿到的收益是「点会话不再满屏新窗口、
>    且不写错仓库」。剩余线 B（S4–S7）复核后合计 **9.5–12 人日**，不含 Go 侧 agent loop（S6′）。
> 4. **不追求**原样运行 DSH 插件 npm 包（等于移植整个 DSH）；平台化只做「契约思想对齐」。
>
> **本版关键修订（v7）**：新增 §4.9 并发专项——锁能力三件套、三个关键漏洞
> （`resourcelease` 的进程内 refcount 在多窗口下失效、`SaveFile` 是裸 `os.WriteFile`、
> 跨窗口 localStorage 无锁）、全量写点矩阵，以及 **§4.9.7 wipe-guard 专项**（六个失效模式：
> 换根清零导致漏报、监听根不跟会话、pre/post 跨仓库误报、长驻保护静默失效、冷却不分根、单根 watcher 失明）+
> **§6.1 端到端演练**（四个场景，必须真跑，单测不能替代）。
> S1 / S2 / S3 相应扩项，§6 新增并发与 wipe-guard 验收。
>
> **本版关键修订（v8，2026-11-27，线 B 复核）**：线 A 已合入后逐条核对线 B 的缺口断言，
> 结论见新增的 **§2.6**。三处原判断需要更正，它们直接改变工程量与落点：
> 1. **S5 不是从零**：会话日志已是 append-only JSONL（六种事件 + replay + 崩尾修复 + 分桶 + 锁 + fsync，
>    Go 侧 `vacuum` 带 parity 测试）。**不再新建 `internal/sessionlog/`**，改为扩事件词表 + 追加式闭合事件。
> 2. **S4 的落点不能叫 `plugin-services.js`**：该文件名已被「插件后台子进程服务」占用（`registerService` →
>    `internal/appservices`），DI 容器改用 `shell/plugin-container.js`；五模式总线走独立命名空间，
>    **不得登记进 `EVENT_SCOPES`**（那张表被 Go↔前端双向契约守卫约束）。
> 3. **S6 的「重启即丢」只说对一半**：子代理运行态在内存 Map，但 `raw.agent` 元数据随消息落盘、载入时
>    running→stopped；缺的是**可续跑**。同时 Go 侧 agent loop 单独立项，不并入 S6。
> 另：上下文去重（原 P1）基本已由 `assembleSystemContext` 的 stable / `turnBlock` 分区达成，只差 digest。
> S4/S5 人日下调，S6 拆分，S7 略降。
>
> 前序版本演进见 `docs/unfinished-plans/workspace-seamless-switch.md`（v2 评审 → v6 对齐六个开源 harness）。

---

## 0. 行号基准

- **v8 核对基准 commit：`1a59adf`**（线 A 合入后的 master）。线 A 之前的一版基准是 `e64884d`，
  本文线 A 章节（§2.1 / §2.2 / §3 / §4.1–§4.6）里的行号仍是那一版的，线 A 实施后已漂移——
  **按符号名检索优先于行号**。线 B 章节（§2.3 / §2.4 / §4.7 / §5）已按 `1a59adf` 重新核对。
- 实测规模（`1a59adf`）：`frontend/src/ai/ai-panel.js` **21045 行**（原记 20171，只增不减的既有超线文件）、
  `ai-subagents.js` **2364 行**（原记 2361）、`testdata/app_bindings_baseline.txt` **434 条**
  （原记 420，线 A 新增 14 条绑定）。
- 本仓库工作区在 2026-11-25 有一次 `git stash`（PR #4 合并），`stash@{0}` 仍保留；
  若发现文件异常先与相关会话确认，不要覆盖。
- **2026-11-27 复核时工作区非干净**：`main.js` 正在拆出 `shell/view-root.js` 与 `shell/wipeguard-roots.js`
  （超线治理第 1/2 批），另有 5 个测试文件随之改动。这批改动与线 B 不重叠，但会改变任何全量测试的基线——
  **线 B 开工前先确认这批改动的归属**（提交或明确保留），不要在脏树上叠加新失败。

---

## 1. 两条需求线

### 1.1 线 A：多工作区与 harness（用户当前诉求）

| 需求 | 含义 |
|---|---|
| **A1 窗口内无缝切换工作区** | 同一个窗口从仓库 A 换到仓库 B，不必另开窗口 |
| **A2 harness 形态** | 窗口不绑定工作区，只做 AI 运行容器；面板内直接切不同工作区的会话，起轮时按**该会话自己的工作区**注入上下文与解析工具路径 |

### 1.2 线 B：Agent 平台化（插件宿主）

目标：让 CaDt 成为「webnovel-writer v8 这类插件」的通用底座——插件声明依赖、挂事件钩子、注册工具、
带 preset 与配置 schema，而不是把某个插件内置成专用功能。

DSH 的宿主契约（Cordis 模型，源码级核实）：

- **插件 = 导出 `apply(ctx)` 的模块**，`ctx` 是访问框架能力的唯一入口。
- **服务容器**：能力挂稳定 key（`ctx.tools` / `ctx.llm` / `ctx.agents` / `ctx.sessions`），
  插件用 `inject` 声明依赖并等待就绪；服务可替换、可 group 隔离；注册经 `ctx.effect()` 可逆。
- **事件分发五模式**：`emit` / `waterfall`（环绕中间件，可短路接管）/ `parallel` / `serial` / `bail`。
- **事件溯源会话**：一切状态 append 进会话日志（深冻结），UI 回放 / 压缩 / 审计都从日志派生；
  崩溃尾部由 `interruptedTurnClosers` 合成闭合事件恢复。
- **Agent Preset**：一个目录（`agent.cordis.yml` + `preset.yml`）决定工具集 + persona + prompt sections + realm 隔离。
- **Agent Scope 隔离**：每个 live agent 有扁平注册层 `agent.ctx`，工具 / 提示 / 变量只对该 agent 可见。
- **上下文哲学**：durable 消息（AGENTS.md / skill catalog / persona / 权限）加载一次不重发；
  动态部分每 step 变化；`headerEquals` 去重保持前缀稳定；压缩阈值 0.8 且保 warm cache。
- **插桩点**：`agent/pre-step` / `agent/request` / `agent/request-error` 三个 waterfall 点。

### 1.3 交汇点：会话必须自带完整状态

| 议题 | 线 A 需要 | 线 B 需要 | 结论 |
|---|---|---|---|
| 会话状态 | 根是会话属性（`session.workspace`）+ 根变更可回放 | 事件溯源日志（一切 append、可 replay） | **同一件事的两半**：根要可回放，就得先进日志 |
| 多作用域共存 | 一窗口跑多个工作区会话 | Agent Scope 隔离（`agent.ctx`） | `scopeRootOf(session)` 就是 `agent.ctx` 的雏形 |
| 上下文注入 | 动态块不进系统提示词 | durable / 动态分区 + 去重 | 线 A 做到了「不进系统提示词」；分区（stable / `turnBlock`）在 `assembleSystemContext` 已成立，线 B 只补 digest 去重（v8 更正：比原判断轻） |
| 角色化 | 未涉及 | Agent Preset（决定根 + 工具集 + persona） | **preset 是两条线的共同落点** |
| 回合钩子 | 回合根冻结 | `agent/pre-step` waterfall | 根冻结应收口到 `onPreStep(session)`，将来零改动接入事件总线 |

**推论**：线 A 是线 B 的**地基与验证场**——先证明「会话级作用域」成立，再把作用域扩展成完整的 agent ctx。

---

## 2. 现状盘点

### 2.1 窗口与工作区（线 A 的现状）

| 事实 | 位置 |
|---|---|
| 原地切换工作区的函数已存在（改 `workspaceFolder` + 树/监听/Git/便签/AI 列表全套刷新） | `frontend/src/main.js:3467` |
| 但 UI 入口走 `openFolderSmart`：本窗口已有工作区就另开窗口 | `frontend/src/main.js:3509` |
| 「一个工作区一个打开者」三重守卫：建窗 `FindByWorkspace`、恢复 `IsWorkspaceOpen`、CLI 复用 | `window_factory.go:358`、`app_window.go:45`、`session-restore.js:252` |
| 每个工作区的标签 / 分屏快照已存在（`cadt.workspace-sessions.v1`，写入按工作区前缀过滤） | `frontend/src/shell/session-restore.js:15,44` |
| 窗口工作区向 Go 侧登记（路由 / 复用匹配唯一数据源） | `window_host.go:104`、`:118` |
| 文件监听每窗口只有一个根 | `frontend/src/main.js:3652`、`internal/watch/watch.go:75` |
| 无工作区启动会自动采纳上次工作区 | `frontend/src/bridge/bridge-ui.js:286`、`session-restore.js:249` |
| 会话 meta 的 `workspace` 是归属真源，磁盘按工作区短哈希分桶；未绑定会话有 `_unbound` 桶 | `internal/sessionstore/sessionstore.go:272`、`:49` |
| 会话列表已按工作区分组、当前组置顶、组头带「新建 / 工作区操作」 | `frontend/src/ai/session/ai-session-list.js:643` |
| 「当前会话按工作区记录」已落地 | `frontend/src/ai/session/ai-session-scope.js:51` |
| 点别的会话今天：探测存活窗口 → 投递复用；未命中 → 软切换另开窗口 | `ai-panel.js:6917` → `ai-session-scope.js:135` → `main.js:4267` |
| 本窗口无工作区时点会话，已在原地采纳该工作区 | `frontend/src/main.js:4291` |
| 子会话已继承父会话 workspace；子代理沙箱根已与窗口根解耦 | `frontend/src/ai/agent/ai-subagents.js:868`、`:250` |
| 已有 `noWorkspace` 会话（持久、不绑工作区、不注入工作区知识） | `ai-session-scope.js:92-98`、`ai-system-context.js:375-382` |

### 2.2 作用域的来源与其它消费者

**7 条来源（全部默认取窗口）**：

| 用途 | 今日取根 |
|---|---|
| 范围根 / 路径解析 / 命令 cwd | `main.js:4263`（`getScopeRoot`）→ `ai-panel.js:6959`（`aiResolveScopePath`） |
| 系统提示词「范围根」行 | `ai-system-context.js:24` |
| `AGENTS.md` | `ai-panel.js:6800`（`aiProjectRoot`）→ `ai-system-context.js:413` |
| 记忆目录 `.cadt/memory` | `ai-panel.js:7142`（`resolveMemoryDir`） |
| 项目权限规则 `.cadt/permissions.json` | `ai-permission-settings.js:686,711` |
| 认知索引 | `ai-panel.js:10167`（`cognitionWorkspace`） |
| 子代理沙箱 / wipe-guard 指纹 | `ai-panel.js:11903,11927` |

引用量：`getScopeRoot` **71 处 / 10 个模块**（`ai-panel.js` 30，其中约 57 处是直接调用，
其余为 opts 注入 / getter / 透传）；`getWorkspaceContext` 15；`aiProjectRoot` 17；`ensureProjectRules` 18。

**其它消费者（初稿漏过，评审补出）**：

| 消费者 | 今日取根 | 换手/harness 后的错位 |
|---|---|---|
| 隔离 worktree 全生命周期（建/统计/丢弃/写闸） | `ai-worktree.js` 15 处 `getScopeRoot()` | 建/删/统计落到新仓库；可能删同名隔离区且未导出改动没存档 |
| 技能来源与缓存 | `resolveSkillDirs`（`project = aiProjectRoot()`）+ `skillsCache` 单槽 | A 仓库的 `.cadt/skills` 喂给 B 仓库会话 |
| 认知 overview 预取缓存 | `ai-cognition.js:192`（`{ws, snapshot}` 单槽） | 交替起轮时索引块静默消失 |
| 计划模式批准的「命令放行规则」cwd | `ai-tool-cards.js:1856`（为空则整段跳过） | 规则落不下，执行 cwd 用会话根 → 重复弹审批 |
| 生成产物 / TTS / 补丁落盘 | `ai-panel.js:9832`、TTS、`propose_patch` | 空根直接报错；异步完成时路径可能指向换手后仓库 |
| Git 面板与「变更卡撤销」 | `bridge-git.js` 的 `gitRootDir()`、`gitRollbackPaths`（**不接根**） | 撤销打到错的仓库 |
| 群聊（多智能体）workspace | `main.js:4402`（写进群 meta，成员工具边界据此钳） | harness 下群 workspace 为空 |
| 崩溃自愈工作区段 | `window_host.go:110` → `runCrashWorkspaceRecovery` | 仅崩溃后首轮、按根去重（与今天打开工作区同语义） |

### 2.3 AI 核心（线 B 的现状）

> v8 复核（2026-11-27）：本节按 `1a59adf` 重写。原版把会话日志与作用域都算作「缺失」，
> 实测两者都已有可复用底座，缺口的实际形状不同——详见 §2.6。

**已有可复用底座**：

- **Agent 循环**（前端）：`ai-panel.js` 的 `startRound`（`:13423`）→ `handleToolRound`（`:13988`）→
  `executeTool`（`:10579`）→ 结果 push 进 `session.messages` → 续轮；无硬轮次上限。
- **子代理系统**：`ai-subagents.js` 的 `spawn_agent / wait_agent / agent_send / agent_stop /
  agent_compact / agent_tree` 齐全；嵌套、并发、任务树、收件箱、worktree 隔离、沙箱档、轮次预算都有。
- **工具链**：`ai-tool-defs.js` + `executeToolInner`；MCP / 插件工具前缀路由；结果超阈值落盘 `ai-artifacts/`。
  工具集**已按会话裁剪**：`toolsForScope(scope, planMode, session)`（`ai-tool-defs.js`）——preset 的天然接缝。
- **三协议 LLM + SSE**：`internal/aitransport/`（openai / anthropic / responses）。
- **文件监听 / 技能 / 配置 / 调度**：`internal/watch`、`internal/skills`、`internal/aiconfig`、`internal/aischedule`。
- **会话日志（v8 新增认定）**：已经是 append-only JSONL，六种事件 `header / msg / meta / archive /
  truncate / reset`（`ai/session/ai-session-store.js` 的 `encode*`），配 `replaySessionLog` 完整回放、
  `atomfile.RepairTornTail` 修尾、按工作区分桶、`internal/sessionlock` 互斥、O_APPEND + 每批 fsync，
  Go 侧 `internal/sessionstore`（含 `vacuum.go` 1017 行与 parity 测试）。**这就是事件溯源的地基。**
- **会话级作用域（v8 新增认定）**：`scopeRootOf(session)` 四步（`ai/session/ai-session-scope.js`）已是
  唯一的根解析入口，`<workspace_rules>` / `<workspace_context>` / 工具路径三处已同源——`agent.ctx` 的雏形。
- **上下文分区（v8 新增认定）**：`ai-system-context.js` 的 `assembleSystemContext` 已把「稳定块」与
  `turnBlock`（每轮动态块，随用户消息以 `<system-reminder>` 落盘）拆开，文件头注释明确
  「系统提示词保持每轮一致，前缀缓存可整段命中」。
- **角色定义（v8 新增认定）**：`session.agents`（`ai/agent/ai-agent-model.js` 的 `normalizeAgent`）已有
  `personaText / role / group / modelRef / temperature / replyStyle`，是 preset 的一半。

**关键缺口**（v8 按代码事实重写）：

- **子代理运行态不可续跑**：4 个内存 Map（`ai-subagents.js` 的 `subAgents` / `subAgentTranscripts` /
  `subAgentRecords` / `subCompacts`），终态记录 LRU 20。但**不是全丢**——`raw.agent` 小元数据随消息落盘，
  载入时 running 态收敛成 `stopped`（`ai-panel.js` 载入归一）。缺的是「跨进程续跑」，不是「保住记录」。
- **事件粒度只到消息**：工具调用 / 审批裁定 / 子代理生命周期都塞在 message payload 的字段里，
  不是一等事件——查询、审计、外部插件读状态都得先解消息结构。
- **日志写者在前端**：`ai-session-disk.js` 驱动 append，Go 只提供 append/rewrite 原语与 vacuum。
  平台化要求「状态由日志派生」，写者位置会成为约束。
- **崩溃闭合是改写而非追加**：载入时把 `running/pending` 消息改写为 `error + interrupted + _recovered`、
  `ask/envAsk` 收敛为 cancelled。语义等价于 DSH 的 `interruptedTurnClosers`，但**不是日志里的闭合事件**——
  回放视角看不到「这里曾经崩过」。
- 编排逻辑与 UI 渲染 / 会话持久化 / 审批链 / 沙箱 / worktree / 压缩深度耦合，无独立「编排引擎」抽象；
  `ai-panel.js` **21045 行**、`ai-subagents.js` **2364 行**，代码里有大量「实测缺陷」注释。
- Go 侧**无 agent loop**（`internal/aichat/chat.go` 的 `AISendChat` 单轮流式即返回），循环全在前端闭包。
- **确实没有**：DI 服务容器 / inject、五模式事件总线、配置 schema、`aiComplete` 桥。

### 2.4 插件与扩展能力（线 B 的现状）

- **已有注册面**：`frontend/src/shell/plugins.js` 的 `apiFor()` 单点定义 13 个 `cadt.*` 方法
  （`registerFormat / addCommand / registerViewer / registerTool / registerService / registerAIProvider /
  registerAIContext / registerImporter / registerDbDriver / registerDocConverter / registerSettingsPanel /
  registerCommandClassifier / registerIconTheme` 等），经 `new Function('cadt', code)(api)` 注入。
  各域注册表已拆成兄弟模块（`plugin-tools / plugin-viewers / plugin-context / plugin-importers /
  plugin-db-drivers / plugin-ai-providers / plugin-settings-panels / plugin-commands-model` …），
  **统一形状是「模块级 `Map` + `register*` + `clear*`」** —— 这正是 DI 容器要收编的那 10 个域。
- **命名冲突（v8 新增）**：`frontend/src/shell/plugin-services.js` **已存在且已占用**，但它是
  「插件后台子进程服务」注册表（`registerService` → `buildServiceSpecs` → Go `internal/appservices`），
  不是依赖注入容器。**S4 的容器必须另起名**，否则同一目录下两套「服务」无法区分。
- **缺口**：注册式但**无服务查找 / 替换 / inject 声明 / 就绪等待 / disposer**；注册不可逆
  （`clear*` 只能整轮重放时全量清空，插件无法只撤自己的注册）。
- **事件**：`app-events.js` 是**订阅桥**而非总线，只有五种过滤器
  （`onApp / onWindow / onWorkspace / onOwned / onResource`），没有 `emit / waterfall / parallel / serial / bail`，
  也没有任何 JS 侧发起能力。⚠️ 它同时被 `event-scope.js` 的 `EVENT_SCOPES` 与两个守卫测试约束
  （`event-bridge-guard`：`EventsOn` 只许出现在桥里；`event-contract-guard`：Go 发射名 ↔ 前端订阅名**双向差集**）。
- **分发与版本**：插件是「文件夹 + `plugin.json`」，清单 13 字段
  （`id / name / version / author / description / entry / extensions / homepage / repository / license /
  keywords / minAppVersion / icon`），**无 `dependencies` / `inject` / 配置 schema**；
  但**版本兼容层已有一半**——`minAppVersion` 校验 + `internal/vercmp` 可用。
- **编辑器内联 AI**：`registerViewer` 的 ctx 只有 `getSelection / requestSave`（`editor-plugin-view.js`），
  **无 `aiComplete` 桥、无 Ctrl+K 行内 widget**（全仓无该快捷键接线）。

### 2.5 缺口汇总

| # | 缺口 | 归属 | 严重度 | v8 复核（2026-11-27） |
|---|---|---|---|---|
| 1 | 根从窗口取（71 处）而非会话 | 线 A | 🔴 阻断 A2 | 已实施；本轮只做存在性核对（`scopeRootOf` 四步 + `core/root-scope.js` 唯一判定），未逐条回归 |
| 2 | `aiRelPath` 与 `aiResolveScopePath` 双基准 | 线 A | 🔴 会写错相对路径 | 同上（`aiResolveScopePath` 已按 `sessionScopeRoot`） |
| 3 | 单槽缓存 4 处（技能 / 认知 / 规则 / wipe-guard） | 线 A | 🟡 串味 | wipe-guard 已 Map 化（`shell/wipeguard-roots.js`），其余同上 |
| 4 | 一个窗口只监听一个根 | 线 A | 🟡 结构性 | 已实施（多根 watcher + 按根冷却） |
| 5 | `cadt.session.v1` 单槽 | 线 A | 🟡 harness 布局污染 | 已实施（独立槽 `cadt.session.harness.v1`） |
| 6 | 事件溯源会话缺失 | 线 B（P0） | 🔴 | **降级**：JSONL 日志底座已在（六事件 + replay + 崩尾修复 + 分桶 + 锁 + vacuum），缺的是**事件粒度**与**追加式闭合** |
| 7 | 编排状态不落盘 | 线 B（P0） | 🔴 | **降级**：`raw.agent` 元数据随消息落盘、载入 running→stopped；缺的是**跨进程续跑** |
| 8 | DI 服务容器缺失 | 线 B（P0） | 🔴 | 成立（10 个域注册表待收编；落点名见 §2.6 约束 1） |
| 9 | 五模式事件总线缺失 | 线 B（P0） | 🔴 | 成立（现有是订阅桥 + 五种过滤器，命名空间约束见 §2.6 约束 2） |
| 10 | agent scope / preset / schema / 上下文去重 | 线 B（P1） | 🟡 | **拆分**：scope 雏形已有（`scopeRootOf` + `toolsForScope`）；preset 半个（`session.agents`）；去重已基本达成（stable / `turnBlock` 分区，只差 digest）；**schema 确实缺** |
| 11 | 插件依赖声明 / 组合配置 / 版本兼容 | 线 B（P2） | 🟢 | **部分**：版本兼容半成（`minAppVersion` + `internal/vercmp`）；依赖声明与组合配置缺 |
| 12 | 编辑器内联 AI 闭环 | 线 B（P2） | 🟢 | 成立（ctx 无 `aiComplete`，全仓无 Ctrl+K） |

### 2.6 线 B 复核明细（2026-11-27，代码级）

> 基准 `1a59adf`，逐条读源码核对 §2.3 / §2.4 的断言。下表左列是 **v7 原文的判断**，
> 右列是本轮实测。凡标「不成立 / 降级」的，§4.7 与 §5 已同步改过，不要按旧结论排期。

| 断言（v7） | 实测（`1a59adf`） | 判定 |
|---|---|---|
| 服务容器缺失，落点新建 `plugin-services.js` | 文件名已被「后台子进程服务」占用；DI 容器确实缺失，现状是 10 个域各自的 `Map + register/clear`，无查找 / 替换 / inject / 就绪 / disposer | 缺口成立，**落点改名** |
| 事件只有 `appEvents.on` | `app-events.js` 是订阅桥：`onApp / onWindow / onWorkspace / onOwned / onResource`，纯过滤器，无发起能力 | 成立 |
| 事件溯源缺失，新建 `internal/sessionlog/` | 已有 append-only JSONL：`header / msg / meta / archive / truncate / reset` + `replaySessionLog` + `RepairTornTail` + 分桶 + `sessionlock` + O_APPEND/fsync + Go `vacuum`（1017 行，带 parity） | **不成立** |
| 编排状态 4 个 Map，重启即丢 | 4 个 Map 在；但 `raw.agent` 小元数据随消息落盘，载入时 running→stopped | 半成立：缺的是续跑 |
| agent scope 缺失 | `scopeRootOf(session)` 已是会话级根；`toolsForScope(scope, planMode, session)` 已按会话出工具集 | 雏形比原文强 |
| preset 缺失 | `session.agents` 已有 persona / role / group / model / temperature / replyStyle | 半成立（缺「决定工具集 + 根」） |
| 上下文每轮全量重发 | `assembleSystemContext` 已拆 stable + `turnBlock`，动态块随用户消息落 `<system-reminder>` | **基本不成立**，只差 digest |
| manifest 无依赖声明 | 13 字段确无 `dependencies / inject / config`，但 `minAppVersion` + `internal/vercmp` 已在 | 半成立 |
| 无 `aiComplete` | `editor-plugin-view.js` 的 ctx 只有 `getSelection / requestSave`，全仓无 Ctrl+K | 成立 |
| Go 侧无 agent loop | `AISendChat` 单轮流式即返回 | 成立（但这是独立工程，见 §5 的 S6 拆分） |

**四条动手前的硬约束**（不处理必踩）：

1. **命名**：DI 容器用 `frontend/src/shell/plugin-container.js`，不复用 `plugin-services.js`。
2. **事件命名空间**：插件进程内事件走独立总线（`cadt.on / cadt.emit`），**不得登记进 `EVENT_SCOPES`**——
   那张表被 `event-contract-guard.test.mjs` 做 Go↔前端双向差集，放进去会要求 Go 侧有对应发射点。
   两条总线各管一层：`EVENT_SCOPES` 管「Go → 前端跨窗口」，新总线管「进程内 JS 钩子」。
3. **改事件格式必须同批改 Go**：`ai-session-store.js` 的事件词表一变，`internal/sessionstore`
   （含 `vacuum.go`）与 `frontend/test/ai/ai-session-vacuum-parity.test.mjs` 必须在同一批改完，
   否则存量会话整理会静默丢事件。
4. **脏树**：见 §0 最后一条，开工前先定 `view-root.js` / `wipeguard-roots.js` 那批改动的归属。

---

## 3. 隔离模型与不变量

### 3.1 核心判断：一个变量三种身份

`workspaceFolder` 同时承担：

| 身份 | 管什么 | 代表消费者 |
|---|---|---|
| **E 编辑根** | 人看/搜/改什么 | 资源管理器、全局搜索、文件监听、Git、终端 cwd、Maven/DB |
| **S 作用域根** | AI 能碰什么、注入什么、往哪写状态 | 71 处 `getScopeRoot()`、`aiProjectRoot`、记忆/规则/认知/技能、沙箱、wipe-guard、worktree |
| **W 窗口身份** | 别的窗口/进程怎么找到我 | `WindowRegister`、`FindByWorkspace`、`WindowList`、CLI 转发 |

**改造的实质是把三者拆开**：线 A 的换手 = 三者一起换；harness = 只有 S 跟会话走。

### 3.2 四层隔离模型

```
┌ 第 4 层 跨窗口协调 ── windowreg（路由 / 复用）、CLI 转发
├ 第 3 层 共享事实   ── ai-config.json（三方合并）、settings、workspace-sessions
├ 第 2 层 内存状态   ── 每窗口 workspaceFolder 及 30+ 派生；每会话 session.workspace；单槽缓存
└ 第 1 层 磁盘与内核 ── .cadt/*（工作区级）、ai-sessions 分桶、租约/锁、watcher owner、wipe-guard
```

**强度分布不均**：第 1 层已足够强（分桶 / 租约 / .cadt 十项 / 认知 CAS），第 2 层的**单槽缓存**是风险集中区，
第 3 层是刻意共享。所以改动重心在「调用点归类」与「缓存 Map 化」，不在路径机制本身。

### 3.3 不变量清单

| # | 不变量 | 强度 | 依据 | 线 A 后 |
|---|---|---|---|---|
| I1 | 同一会话同时只有一个回合 | **硬**（安全） | 租约 `lease_service.go:60-120` | 保持 |
| I2 | 应用数据目录不可被 AI 读/扫 | **硬**（安全） | `ai-read-roots.js:102-129` | 保持 |
| I3 | 写工具越界即拒（无审批兜底） | **硬**（安全） | `aiResolveScopePath` 不捕获 | 保持（根换会话） |
| I4 | `.cadt/cognition` 不可直写 | **硬** | `assertNotCognitionPath` | 依赖「双基准同批改」 |
| I5 | ~~同一工作区只有一个写者~~ | **v6 撤销** | `IsWorkspaceOpen` 退回纯体验守卫 | 改路径级写边界 |
| I6 | 一个窗口只监听一个根 | 软（结构） | `WatchWorkspaceFor(owner, root)` | 换手即换根；harness 树跟会话 |
| I7 | 项目状态跟随工作区 | 软 | `.cadt/*` 物理布局 | 跟会话根 |
| I8 | 跨窗口配置一致 | 软 | `ai-config.json` 三方合并 | 保持 |
| I9 | 窗口布局不互相污染 | 软 | `PER_WINDOW_LAYOUT_KEYS` + 快照归属校验 | harness 需独立快照槽 |
| I10 | 缓存按工作区分区 | 软（易漏） | 各域自管 | 需改 Map |
| I11 | 崩溃自愈不误删他人在用的临时文件 | 软 | 按根去重 + 仅崩溃后首轮 | 保持 |
| I12 | CLI / 文件投递按工作区路由到正确窗口 | 软 | `window_route.go` 最深命中 | harness 需补会话→工作区弱映射 |
| I13 | 切根开销只随「进入新工作区」增长 | 软（体验） | §4.6 | 需轻量换根 + 重活去重 |

### 3.4 工具路径解析链路（最关键的一处）

```
模型给相对路径
   └─▶ aiResolveScopePath(value, session)        ← 唯一收口，但内部取窗口根
        ├─ 读类越界 → resolveReadPathWithApproval
        │     ① 应用数据目录硬拒  ② 点名/已批准读根  ③ auto 档直读  ④ read/edit 弹卡
        ├─ 扫描类 → resolveScanRoot（起点粒度审批）
        ├─ 写类越界 → 直接 throw（fail-closed，full 档除外）
        └─ 命令 cwd → commandCwdOf（持有隔离区时默认落隔离区）
   └─▶ aiRelPath(getScopeRoot(), path)            ← 第二个基准（write_file / edit_file）
        ├─ assertNotCognitionPath(relPath)       ← 安全闸
        ├─ wipeguard.backupWrite({ws, relPath})  ← 备份归属
        └─ mainRootWriteVerdict(relPath)         ← worktree 写闸
```

**③ 是 auto 档的关键**：越界路径直接放行。所以「把别的工作区的可解析路径注入上下文」在 auto 档
等于**静默跨仓库读**——这是 §4.3 采用「无路径摘要」的根本原因。

**两个基准必须同批改**：只改 `aiResolveScopePath` 不改 `aiRelPath`，会出现「绝对路径在会话根、
相对路径按窗口根算」的窗口期，连带变更卡、备份归属（`backup.go:85-124` 的 `WS` 字段）、
worktree 写闸全错。已核实**不存在路径穿越写**（blob 走内容哈希 CAS，`Rel` 仅元数据）。

---

## 4. 目标架构

### 4.1 根归属：窗口不持有根（v6 模型修正）

六个参考实现**无一采用「窗口绑定工作区」**，全部是「会话自带 cwd/roots，窗口只是视图」：
opencode `Session.location = {directory, workspaceID}`、pi `SessionHeader.cwd`、
ZCode `workingDirectory`、codex `environments[] {cwd, workspace_roots}`、
cline `SessionWorkspaceConfig.cwd`、deepseek `header.cwd` + `workingDirectory` 投影。

```
普通模式：窗口根 = 当前会话根的投影（两者恰好相等，保持今天一目录一窗口的体验）
harness ：同一套模型，只是不强求窗口根唯一
```

**推论**：`scopeRootOf(session)` 是唯一根来源；`windowWorkspace()` 降级为「当前会话根缓存」，
仅供标题徽标 / 窗口切换器显示。

### 4.2 作用域解析（四步）

```
scopeRootOf(session):
  1. session.workspace 非空      → 用它（会话真源，磁盘已按它分桶）
  2. 会话标记 noWorkspace        → backingWorkspace(session)（§4.8，应用数据下的会话沙盒）
  3. harness 窗口且会话未绑定    → ''（无根；工具只读 + 绝对路径）
  4. 否则                        → windowWorkspace() || activeFileDir()   ← 兼容旧行为
```

**必须拆两层**：今日 `getScopeRoot()` = `workspaceFolder || 活动文件父目录`。若直接复用这条兜底，
harness 下未绑定会话会把「用户当前点开的标签父目录」当作用域根，AGENTS.md / 记忆 / 规则跟着读错仓库。

### 4.3 上下文注入：按归属分层渲染（不是过滤）

| 内容 | 处置 | 理由 |
|---|---|---|
| **活动文件** | **始终注入**（路径/光标/选区/视口），跨根时加「属于其它工作区，读取需授权」 | 它是用户注意力的锚点；靠 `aiDisplayPath` 自动脱敏成「（范围外）名」 |
| **本会话根已打开文件** | 全列（≤20），相对路径 | 与今天单仓库行为逐字一致 |
| **其它工作区已打开文件** | **折叠为摘要**：工作区数 + 文件数 + 最多 3–4 个文件名，**不给可解析路径** | 保留「还有别的东西开着」，同时不扩大 auto 档的静默跨仓读 |
| **虚拟标签页** | **不按工作区过滤**，全列（≤12） | `appTabViewOf` 只返回 `{label,name,desc}`，浏览器/便签/页面/数据库表都无 workspace 归属 |
| **跨根活动文件读取** | 视为**用户点名**（`userNamedPath` 同语义），不弹审批 | 用户正看着它，问「这个文件」必须能读 |
| `redactToolText` | 脱敏基准换成会话根 | 否则会话根 ≠ 窗口根时脱错 |
| AGENTS.md / `<memory>` / 认知守则 | 随会话根 | — |

**为什么不是过滤**（v4 复议结论）：
1. `getWorkspaceContext().openFiles` 有第二个消费者——`ai-panel.js:5202` 的 `pickOpenFileMatch`
   用它把回复里的裸文件名解析成可点击芯片；数据源过滤会让跨工作区引用退化成普通文本。
   （`ai-composer.js:645` 的 `attachCurrentFile` 也读同一字段。）
2. 虚拟标签页没有 workspace 归属，过滤只会漏。
3. 活动文件被过滤，模型就不知道用户在看什么——这正是 `<workspace_context>` 的立身之本。

**因此：数据源 `getWorkspaceContext()` 保持返回窗口全量事实，只在渲染层分层。**

**前缀缓存**：系统提示词里的根行随会话变——每个会话本来各有提示词，切换不击穿缓存；
但同一会话内换工作区会击穿一次（v6 用 §4.5 的根变更注入缓解）。

### 4.4 写边界：路径级策略（v6 撤销窗口级占位）

| 实现 | 机制 | 借鉴度 |
|---|---|---|
| codex | `entries[{path, access: Read\|Write\|Deny}]` + `writable_roots`；`deny > write > read`；越界升权审批 | ✅ 主参考 |
| deepseek | 三档 `read-only / workspace-write / danger-full-access`；拒绝返回 `FS_SANDBOX_DENIED` + 一次升权重试 | ✅ 主参考 |
| opencode | 内部免审 → `external_directory` 审 → read/edit 审 | ✅ 分层思路 |
| ZCode | 不硬阻断 workspaceRoot 外路径（等权限适配器） | ❌ 反面 |
| pi | 越界静默允许 | ❌ 反面 |

**定稿**：
- **不做窗口级写权占位**：不新增 `ClaimWorkspace` / `ReadWorkspaces` / 接管语义，不改 `windowreg` 的权限含义。
- 并发安全三层：① 同一会话回合租约（已有）；② 路径级写边界（写根 = 会话根 + 显式附加可写根，
  对齐 codex `--add-dir`）；③ 越界升权审批（走已有的写审批链，不新造机制）。
- **同仓库两窗口并发写**从「被禁止」变成「允许、冲突交给 git」。真正的数据丢失风险是「同会话双开」，
  已由租约挡住（I1）。
- **写效应清单必须全覆盖**：不只是文件与命令——`memory_write`（**无锁整份覆盖 `MEMORY.md`，是唯一会丢用户数据的写点**）、
  `write_worklog`（有跨进程锁，安全）、`cognition_edit`（resourcelease + CAS，安全）、`propose_patch` / 补丁应用、
  `worktree_manage`、计划落盘、便签（有锁）、`generate_image/video` 产物、`text_to_speech`。
  否则会出现「`write_file` 受边界约束、`memory_write` 不受」的不一致。

### 4.4.1 `.cadt` 既有功能的影响面（核实结论）

| 功能 | harness 下 | 依据 |
|---|---|---|
| worktree 孤儿清理 | ✅ 安全 | 按会话 meta 的 `worktree.path` 判定 + fail-safe（`storage_app.go:56`、`storage.go:156`） |
| worklog `.cadt/logs` | ✅ 安全 | `sessionlock` + 进程内 mutex，根 INDEX 读改写也在锁内（`aiworklog.go:104-148`） |
| 认知索引 | ✅ 安全 | resourcelease + CAS |
| 补丁库 | ✅ 安全 | 记录自带 root |
| 便签 | ✅ 安全 | 按 scope 分区 + resourcelease |
| plan 落盘 | 🟡 半对 | 已优先 `session.workspace`（`ai-panel.js:6812`）；但审批规则 cwd 取窗口根（`ai-tool-cards.js:1856`）→ S1 |
| memory 目录 | 🔴 需修 | `resolveMemoryDir()` 无参 + 静默回落应用数据目录 → S2 禁回落 |
| `MEMORY.md` 写入 | 🔴 需修 | 无锁整份覆盖 → S2 加 `sessionlock` |
| `permissions.json` | 🟡 需修 | 仅窗口内串行 → S2 提升为文件锁 |
| `.cadt/tmp` / `.cadt/logs` 崩溃自愈 | 🟡 已知 | 按工作区清；harness 不登记不触发，但别的窗口登记同根时会清（仅崩溃后首轮） |
| worktree 建/删/统计 | 🟡 需修 | 15 处取窗口根 → S1 改用 `wt.path` |
| gen / answers / scratch | 🟡 需修 | 取窗口根，harness 下为空会报错 → S1/S2 |

### 4.5 换手与根变更

```
switchWorkspaceInPlace(dir, sessionId):
  1. 同一根 → return
  2. 目标已开在别的窗口？是 → WindowFocusByName + 投递会话，return 'reused'（体验选择，非权限门槛）
  3. targetSnapshot = readWorkspaceSession(dir)     // 必须在切换前读，避免防抖保存覆盖
  4. 当前会话有进行中回合 → §4.5.1 守卫
  5. openFolderWorkspace(dir)                       // 前端状态落地（树/监听/Git/便签/面包屑）
  6. applyWorkspaceSnapshot(targetSnapshot)
  7. 切到 sessionId → syncActiveSessionUI
  8. 注入根变更记录 → 下次起轮落盘
  9. wipe-guard 基线按新根重设
```

**根变更必须写进对话历史**（opencode 注入 `The working directory has been changed to X.`；
deepseek 做可校验可回放的 `workingDirectory` 投影）。不写的后果：换手后模型按旧根推理，
表现为「无故怀疑文件被删」。

做法：换根后在会话上挂 `pendingRootChange = {from, to, at}`，随下一次起轮的 `<system-reminder>`
注入 `<workspace-context-change from to>`，说明「旧路径仍可用，相对路径从现在起按新根解析」；
连续换根只留最后一条；切回原根时清除。该块属动态块，不进系统提示词。

**时序坑一**：`openFolderWorkspace` 末尾调 `aiPanel.refreshSessionList()` → `adoptWorkspaceSession()`，
会把面板自动切到新工作区「最近更新的会话」，甚至新建空会话。第 7 步必须显式 `setActiveSessionId(目标)`，
并清理 adopt 产生的空会话（复用 `isVirginSession` / `discardVirginOnLeave`）。

**时序坑二**：`aiResolveScopePath` 每次工具调用现取窗口根。A 仓库会话跑长回合期间换手到 B，
后续写文件 / 命令 cwd / worktree 全落到 B。**所以换手不得与「工具根改会话」拆开上线**（见 §5）。

#### 4.5.1 进行中回合：两段式

| 阶段 | 做法 |
|---|---|
| S1（兜底） | 目标/当前会话有 `stream` / 压缩 / 活跃子代理时**拒绝换手**并提示（复用 `busy` 语义） |
| S2（升级） | 起轮时把根冻结进工具上下文（`ctx.scopeRoot = scopeRootOf(session)`），整回合不再现取；`busy` 收窄为「禁止同会话并发」 |

**架构要求**：根冻结收口到 `onPreStep(session) → {scopeRoot}` 单一函数，**不要写死在 `executeTool` 里**——
将来接事件总线时它天然是 `agent/pre-step` waterfall 的钩子，零改动。

### 4.6 性能：轻量换根

**结论**：harness 下切会话**会卡**，但卡点不是「换工作区」本身，而是「把切会话等同于重开工作区」导致重活重复。

| 档 | 项 | 依据 / 上限 |
|---|---|---|
| 轻（毫秒级） | 树换根 | `explorer.js:891` 只 `tree=null` + `ensureTree()` 读一层 |
| 轻 | 认知卷 / 技能目录 / AGENTS.md / 记忆 / 规则 | 几个 `readdir` / `readFile` |
| 中（数十 ms ~ 数秒） | `git status` | **无内建上限**，视仓库规模，主要波动源 |
| 中 | wipe-guard 指纹 | 硬预算 200ms 墙钟 + 5 万条目（`fingerprint.go:31-37`），超限降级 `Sampled` |
| 中 | 监听注册 | `ReadDirectoryChangesW` 一次调用（`watch.go:75`）；大仓库事件洪峰会持续推事件 |
| 中 | 会话正文懒加载 | `_stub` 保证切回已加载的不重读；大会话首读可达秒级（上限 256MB） |
| 重（无上限） | 工作区 open 钩子 | `main.js:3504` → `runForWorkspace` 真跑用户命令 |
| 重 | Maven 扫描 + 全量 `applySettings` 重绘 | 随每次换根触发 |

**三条硬设计**：
1. **`switchRootLight(dir)`**：会话切换引起的根变更只做「切根 + 轻刷」（树、面包屑、标题、监听换根、
   当前会话上下文），不重跑钩子、不强制刷 git / 指纹；中档项改「标脏 + 空闲刷新」。
   `openFolderWorkspace` 保留为「真正打开工作区」的完整路径。
2. **重活按工作区去重**：进程级 `openedWorkspaces`；同一工作区在一次运行内，open 钩子 / 首次 git /
   首次指纹各只执行一次。`lifecycle-hooks.js` 的 `runningByWs` 只防并发、不防先后重复，需加幂等层。
3. **换手序列化**：快速连点只处理最后一次，复用 `ai-panel.js` 的 `switchSeq` 序号作废机制。

**不做**：不给 git / 指纹加后台轮询（把抖动换成持续 CPU）；只用「标脏 + 用户看到时刷」。

### 4.7 插件平台原语（线 B）

> v8 复核后按实测重写「现状」与「落点」两列。三处落点变更：容器改名、总线与日志表分开、
> **不再新建 `internal/sessionlog/`**（会与 `internal/sessionstore` 双写并击穿 vacuum parity）。

| 原语 | 现状（v8 实测） | 目标 | 落点 |
|---|---|---|---|
| 服务容器 | 10 个域各自的 `Map + register/clear`，无查找 / 替换 / inject / 就绪 / disposer | 服务注册表 + `inject` 声明 + 就绪等待 + 可替换 / 隔离 + disposer | **新建 `frontend/src/shell/plugin-container.js`**（不叫 `plugin-services`，该名已被子进程服务占用）+ 改 `plugins.js` 的 `apiFor` |
| 事件五模式 | 订阅桥：`onApp / onWindow / onWorkspace / onOwned / onResource`，无发起能力 | `emit / waterfall / parallel / serial / bail` | **新建独立模块**（如 `core/hook-bus.js`），命名空间 `cadt.on / cadt.emit`；**不进 `EVENT_SCOPES`** |
| 事件溯源会话 | append-only JSONL 六事件 + replay + 崩尾修复 + 分桶 + 锁 + fsync；Go 侧 vacuum | 事件粒度下探到工具 / 审批 / 子代理 / 回合；崩溃尾部**追加**闭合事件；可 replay 派生 UI | 扩 `ai/session/ai-session-store.js` 事件词表 + `ai-session-disk.js` 写点 + `internal/sessionstore`（vacuum 同批改）；**不新建 `internal/sessionlog/`** |
| 编排持久化 | 4 个前端 Map；元数据随消息落盘、载入 running→stopped | 流水线状态可续跑（跨进程恢复子代理） | `ai-subagents.js` + 复用上面的事件通道；**Go 侧 agent loop 单独立项** |
| Agent Scope | `scopeRootOf(session)` 已是唯一根；`toolsForScope(scope, planMode, session)` 已按会话 | `agent.ctx` 扁平注册层，每 agent 独立工具 / 提示 / 变量 | 在 `scopeRootOf` 之上演进，不另起根解析 |
| Agent Preset | `session.agents` 已有 persona / role / group / model / temperature | 声明式 preset（persona + 工具集 + 提示片段 + 根），随会话持久化 | 扩 `ai/agent/ai-agent-model.js` + 会话 meta；工具集经 `toolsForScope` 注入 |
| 配置 Schema | 缺失 | 校验 + 默认值 + UI，按 scope 隔离 | 新模块（纯函数 + 测试） |
| 上下文去重 | 已分 stable / `turnBlock` 两区，前缀稳定；无 digest | durable 消息 + digest 去重 | `ai-system-context.js` 补 digest（增量小改，不再是分区改造） |
| 编辑器内联 AI | 无 `aiComplete` 桥、无 Ctrl+K | `registerViewer` ctx 加 `aiComplete()`；Ace 行内 widget | `editor-plugin-view.js` + `editor-groups.js` |
| 回合钩子（v8 补记） | 无 `onPreStep`；根冻结靠「根即会话属性」天然成立 | `agent/pre-step` 统一钩子点 | `ai-panel.js` 的 `startRound` 入口补钩子，接入上面的事件总线 |

### 4.8 未绑定会话：backing workspace

| 实现 | 做法 |
|---|---|
| ZCode | backing workspace `<data>/.zcode/workspace/default`，`purpose="conversation"`；**仍给真实 cwd** |
| cline | 共享 chat workspace `~/.cline/data/workspaces/chat` + 礼仪 `AGENTS.md` |
| deepseek | `header.cwd` 可空但不能入组，运行时用 `defaultCwd` 兜底 |
| opencode / pi / codex | **不支持**（强制 project / 强制 cwd） |

**定稿**：`noWorkspace` 从「只读 + 绝对路径」改为 **backing workspace**——
根 = `<应用数据>/ai-workspaces/<sessionId>/`（或按需共享 `chat` 单目录）；
该目录可读可写，工具相对路径语义正常；天然隔离（无 AGENTS.md / .cadt / git，所以「不注入工作区知识」自动成立）；
落一个礼仪 `AGENTS.md`（同 cline：这是会话沙盒、不要长期存放项目文件、需写真实仓库请先绑定工作区）；
UI 显示「会话沙盒」胶囊 + 「绑定到工作区」一键动作。

新建会话仍**弹三选一选择器**（最近工作区 / 打开文件夹 / 会话沙盒），不静默。

---

### 4.9 并发模型与写点矩阵（v7 新增）

> 这一节是把「并发处理」系统化：先给锁能力，再给写点矩阵，最后给本次改动引入的新并发面。
> **核心结论：本仓库的并发保护不是靠统一机制，而是靠「每个写点自己选通道」——
> 于是存在一条机械可审计的分界线：走专用 Go 服务的有保护，走通用 `SaveFile` 的是裸写。**

### 4.9.1 现有锁能力（三件套）

| 机制 | 粒度 | 跨进程 | 进程内重入 | 防丢更新 | 用途 |
|---|---|---|---|---|---|
| `sessionlock` | 文件 | ✅ LockFileEx / flock | ❌ 无 refcount | ✅ | worklog、wipeguard 索引、会话写 |
| `resourcelease` | 文件 | ✅（底层 sessionlock） | ✅ refcount + `AcquireShared` / `AcquireNoShare` / `AcquireWait` | ✅ | 认知、便签、会话租约、根门闩 |
| `atomfile` | 文件 | — | — | ❌ **只防半截** | meta.json、会话正文 rewrite、owner 文件 |

**`atomfile` 不能替代锁**：它只保证「目标要么是旧内容、要么是完整新内容」，两个并发写谁最后 rename 谁赢。
任何「读-改-写」只用 atomfile 仍会丢更新。

**进程内还有两层**：包级 mutex（`sessionstore.appendMu`、`aiworklog.worklogMu`）、
前端序号（`ai-panel.js` 的 `switchSeq`）。两者都不跨窗口。

### 4.9.2 关键漏洞 A：`resourcelease` 的 refcount 在多窗口下失效

`resourcelease.Acquire` 的设计是「同进程重入不自锁」：

```go
case st.exclusive > 0:
    st.exclusive++          // ← 直接成功，不查是谁
    return &Lease{...}, nil
```

`st` 是**进程级**全局状态，不区分窗口。v2 时代「一窗口 = 一进程」没问题；
**v3 一进程多窗口之后，同一进程的两个窗口获取同一把独占锁会互相放行**（refcount +1）。

已经按窗口名分桶修补的两处：

| 模块 | 位置 | 做法 |
|---|---|---|
| 会话回合租约 | `lease_service.go:92-102` | `sessionLeases[id].holders[ownerKey]`，同窗口重入 / 跨窗口 Busy |
| 快捷便签 | `memo/memo.go:161-173` | `memoLeases[path].holders[ownerKey]`，同款 |

**未修补**：`cognition.Service.acquireLease`（`cognition/service.go:366-368`）直接 `resourcelease.Acquire`，
没有窗口分桶。→ harness 下**同一工作区的两个会话可同时写认知卷**（不同工作区锁路径不同，不冲突）。
CAS 能挡住「基于旧基线的写」，但挡不住「两边都拿到锁后各自读最新基线再写」的竞争。
**修法：照抄 sessionLeases 的 holders 分桶，约 30 行。**

### 4.9.3 关键漏洞 B：`SaveFile` 是裸 `os.WriteFile`

```go
// internal/fileio/fileio.go:365-374
func (f *Files) SaveFile(path, content, eol string, hasBom bool, enc string) error {
    raw, err := chardec.BuildSaveBytes(content, eol, hasBom, enc)
    if err != nil { return err }
    return os.WriteFile(path, raw, 0644)   // ← 无锁、非原子
}
```

**这是本次审计最重要的一条**：它提供了一个机械判据——搜 `backend.SaveFile(` 就是全部无保护写点。
AI 相关调用点 24 处，其中会撞的：

| 写点 | 路径 | 并发后果 |
|---|---|---|
| `memory_write` | `.cadt/memory/MEMORY.md` | 🔴 **整份覆盖丢更新**（两会话并发写，后者抹掉前者） |
| 项目权限规则 | `.cadt/permissions.json` | 🟡 跨窗口读改写丢更新（窗口内已串行） |
| 计划落盘 | `.cadt/plan/plan-<sessionId>.md` | 🟢 按会话 id 命名，天然隔离；但**非原子**，写一半崩会留半截 |
| 记忆管理对话框 | `.cadt/memory/*` | 🟡 同 MEMORY.md |
| 群纪要 / 会话导出 / DB 导出 | 用户指定路径 | 🟢 用户主动、冲突概率低；仍非原子 |
| 粘贴图片临时文件 | `.cadt/tmp/` | 🟢 文件名唯一；非原子但内容小 |

**两级修法**：
1. **`SaveFile` 内部改走 `atomfile.WriteFileAtomicMode`**（保留 eol/BOM/enc 语义）——一处改动，
   所有写点都消除「半截文件」。代价是多一次 fsync，用户手写保存场景无感。
2. **真正需要互斥的少数文件**（`MEMORY.md`、`permissions.json`）改为**专用后端通道**：
   走 `resourcelease` + `atomfile`，前端不再直调 `SaveFile`。

> **实施结果（v8 复核，2026-11-27）**：第 1 条**没有按原样落地**。线 A 实际做的是**新增**
> `internal/fileio` 的 `SaveFileAtomic`（同目录临时文件 + fsync + Replace），**只给应用内务文件
> （`.cadt/**`）用**；`SaveFile` 一个字节未改，用户文档保存仍是原来的非原子写
> （见 `docs/reports/agent-host-platform-implementation.md` C 批与 `fileio_test.go:219` 的注释）。
> 后果：**「搜 `backend.SaveFile(` = 全部无保护写点」这个判据仍然有效**，24 处里只有改成
> `SaveFileAtomic` 的那部分消除了半截文件风险。第 2 条（`MEMORY.md` / `permissions.json` 专用通道）
> 随 S2 落地，结论不受影响。若将来要把用户文档保存也原子化，需要单独立项
> （`SaveFile` 的调用点包含编辑器直存，fsync 时机与撤销栈的交互要一起验）。

### 4.9.4 关键漏洞 C：跨窗口共享的 localStorage 无锁

Wails 多窗口共享同一 WebView2 user data 目录 → **localStorage 是共享的，且没有锁**。

| 键 | 冲突后果 | 现状缓解 | 本次处置 |
|---|---|---|---|
| `cadt.session.v1` | 最后写者赢（harness 布局污染普通窗口） | `restoreSession` 有归属校验，但空 workspace 不校验（`session-restore.js:243`） | **harness 用独立 key**（S3） |
| settings | 互相覆盖 | `settings-changed` 广播 + `applyRemoteSettings` 合并 + `PER_WINDOW_LAYOUT_KEYS` 剥离 | 保持（三通道已定） |
| `cadt.workspace-sessions.v1` | 按工作区 key 的 Map，同键并发写会丢一个工作区的布局 | 30 条上限 + 覆盖写 | 接受（布局可重建） |
| `ai-config.json` 镜像 | 覆盖明文镜像 | 磁盘侧有 CAS + 三方合并（`mergeAIConfig`） | 保持 |

**结论**：localStorage 层不做加锁（改造成本高、收益低），靠「单槽 → 按 key 分区」与「合并入口收口」缓解。

### 4.9.5 写点矩阵（全量）

| 写点 | 通道 | 跨进程互斥 | 原子 | 失效模式 | 处置 |
|---|---|---|---|---|---|
| 会话正文 append | `sessionstore.AppendWithCreate`（`appendMu` + `withSessionLock`） | ✅ | ✅ O_APPEND | 拒绝（busy） | 保持 |
| 会话 meta / rewrite | `atomfile.WriteFileAtomic` + `withSessionLock` | ✅ | ✅ | 拒绝 | 保持 |
| 会话回合 | `sessionLeases`（resourcelease + **窗口分桶**） | ✅ | — | 拒绝（session-busy） | 保持 |
| 认知卷 | `resourcelease`（**无窗口分桶**） | ✅ | ✅ | 同进程双窗口可并发写 | **S2 补分桶** |
| 便签 | `memoLeases`（+ 窗口分桶） | ✅ | ✅ | 拒绝 | 保持 |
| worklog | `sessionlock` + `worklogMu` | ✅ | ✅ 追加 | 拒绝/等待 | 保持 |
| wipe-guard 索引 | `sessionlock` + 10 次重试 + O_APPEND 兜底 | ✅ | ⚠️ 最坏丢一行 | 丢一行 | 保持（已声明） |
| 补丁库 | 记录自带 root + atomfile | ✅ | ✅ | — | 保持 |
| **`MEMORY.md`** | ~~`SaveFile` 裸写~~ → 专用锁通道 | ✅ | ✅ | ~~丢更新 + 半截~~ | **已落地（S2，E 批）** |
| **`permissions.json`** | ~~`SaveFile` 裸写~~ → 专用锁通道 | ✅ | ✅ | ~~丢更新 + 半截~~ | **已落地（S2，E 批）** |
| 计划落盘 | `SaveFile` 裸写 | ❌ | ❌ | 半截（按会话隔离不丢更新） | **S1 `SaveFile` 原子化** |
| 群纪要 / 导出 / 粘贴 | `SaveFile` 裸写 | ❌ | ❌ | 半截 | S1 `SaveFile` 原子化 |
| 设置（localStorage） | `kvSet` | ❌ | — | 覆盖 | 保持（合并入口） |
| 窗口布局快照 | `kvSet`（`cadt.session.v1`） | ❌ | — | 覆盖 | **S3 独立 key** |
| 窗口登记 | `WindowRegister`（内存注册表） | — | — | 短暂旧值 | **S3 加序号** |

### 4.9.6 本次改动引入的新并发面

| 新面 | 为什么会发生 | 对策 |
|---|---|---|
| **换手期间登记空档** | `WindowRegister` 是 fire-and-forget，换手瞬间路由可能按旧值匹配 | 前端序号作废 + `WindowRegister(seq)` 只认最新（S3） |
| **harness 两会话同工作区写** | 撤销写权占位后同仓库可多会话共存 | `MEMORY.md` / `permissions.json` 走锁（S2）；其余按 §4.4 边界审批 |
| **重活去重表本身要并发安全** | `openedWorkspaces` 若放前端 Map，两窗口各算各的，钩子仍会跑两次 | **放 Go 侧**（进程级 map + resourcelease 或 mutex），不放前端（S3） |
| **轻量换根与完整打开竞态** | 用户在换手途中又点了「打开文件夹」 | 同一把根门闩（`resourcelease`）串行化，后到者放弃 |
| **缓存 Map 化的读写竞争** | 4 个单槽缓存改 Map 后，键写入仍可能被并发覆盖 | Map 只做「键存在性」判断，写入用 `set(key, v)` 覆盖（同 key 最后写赢可接受，因为内容等价） |

### 4.9.7 专项：wipe-guard（破坏防护）—— 最不能失效的一处

wipe-guard 的失效模式与其它功能不同：**它坏了不会丢数据，而是「该报警时不报警」**——直接让
2026-11-18 那次工作区被清空的事故失去唯一防线。所以它需要单独审视，不能混在「缓存串味」里一带而过。

**现状：单实例单根状态机**（`ai-wipeguard.js:276-284`）

```js
let watchWindow = null;       // 单一滚动窗口（10s / 40 条净消失阈值）
let wsKey = '';               // 单一根 key
let lastFingerprint = null;   // 单一基线
let fingerprintTimer = null;  // 单一周期校准（10 分钟）
let settleTimer = null;       // 单一确认延迟（1.2s）
let lastAlarmAt = 0;          // 全局告警冷却（2 分钟，不分根）
```

**六个具体失效模式**：

| # | 失效 | 触发条件 | 后果 | 严重度 |
|---|---|---|---|---|
| F1 | **换根清零基线 → 阈值攒不够** | `handleWorkspaceEvent` 里 `key !== wsKey` 就重置 `watchWindow` + `lastFingerprint`（`:401-407`）。harness 下 A→B→A 频繁切换 | 真破坏发生在「切走期间」，窗口被清空 → **漏报** | 🔴 |
| F2 | **监听根不跟会话 → 主信号瞎** | `syncWorkspaceWatcher` 用 `explorer.getRoot() \|\| workspaceFolder`（`main.js:3652`） | harness 下若树根没跟着会话，A 级删除事件根本收不到 | 🔴 |
| F3 | **pre/post 跨仓库比较 → 误报** | `preCommand(A)` 返回 A 指纹、`postCommand(B, before)` 拿 B 的 after 跟 A 的 before 比 | `RootEntries 98 → 3` → **critical 误报「整仓被清空」**，消耗用户信任 | 🔴 |
| F4 | **长驻保护静默失效** | `snapshotTick`（`:451`）与 `startCalibrationLoop`（`:365`）取 `getWsRoot()`，harness 下为空直接 return | 10 分钟快照与周期校准都没跑，且**无任何日志** | 🟡 |
| F5 | **告警冷却不分根** | `lastAlarmAt` 全局 | A 刚报过警，2 分钟内 B 的真破坏被抑制 | 🟡 |
| F6 | **watcher 单根 → 非当前根失明** | `WatchWorkspaceFor(owner, root)` 一窗口一根（`watch.go:75`） | A 会话跑长任务删文件、用户切到 B → A 完全无信号 | 🟡 |

**F3 特别值得注意**：`preCommand(root)` / `postCommand(root, before)` 的签名**已经带 root**，
看起来"早就支持多根了"，但调用点传的是 `getScopeRoot()`（现取窗口根）。
这是典型的「接口看似支持、调用点没跟上」——只改 S1 的 `aiResolveScopePath` 不会自动修好它。

**修法**：

1. **pre/post 同根（S1）**：`preCommand` 返回 `{root, fp}`，`postCommand` 用同一个 root，
   不再各自现取。同一改动给告警日志带上 root（便于事后定位是哪个仓库）。
2. **watcher 跟随会话根（S1）**：`syncWorkspaceWatcher` 的根改为 `scopeRootOf(当前会话)`，
   与 `windowreg` 是否登记无关（防护不能因为「不占有」而关掉）。
3. **per-root 状态表（S3）**：
   ```js
   const perRoot = new Map(); // wsKey -> {watchWindow, lastFingerprint, lastFingerprintAt,
                              //            settleTimer, lastAlarmAt, lastSeenAt}
   ```
   —— 换根不再清零，只初始化新根；按 `lastSeenAt` 做 LRU（只保留最近 N 个活跃根，
   建议 N=8，配合 `isAIActive(root)` 只留「有会话在跑」的根）。
4. **多根 watcher（S3）**：`internal/watch` 的 `ResourceWatcher.Watch(owner, kind, key, dir)`
   天然支持多 key（`resource.go:53`）——`kind="wipeguard"`、`key=wsKey`、`owner=窗口名`
   即可为多个活跃根各开一路监听；窗口关闭/根失活时 `Unwatch`。代价是 watcher 数量 = 活跃根数
   （通常 1–3，可接受）。
5. **冷却按根（S3）**：`lastAlarmAt` 移进 per-root 条目。
6. **快照按根轮转（S3）**：`snapshotTick` 只对「当前根」做（一个窗口一份），
   避免磁盘增长 × 根数；`snapshotAlarmState` 也按根记录。

**验证要点**：
- 单测：`perRoot` 状态机（换根不清零、LRU 淘汰、冷却独立）；
  `preCommand`/`postCommand` 同根（跨根时应当**拒绝比较**而不是报警）。
- 手工：A 会话让 AI 删 50 个文件的同时切到 B 会话 → 应当仍触发 critical 并投递给 A；
  A/B 交替切换 5 轮后，A 的基线不清零（日志可验证）。
- 回归：`test/ai/ai-wipeguard.test.mjs` 现有纯函数用例（`registerDeleteEvents` /
  `wipeGuardSkipPath` / `shouldAlarmFromWatch`）不受影响。

---

### 4.9.8 不做与接受

- **不做 localStorage 加锁**：收益低（布局/设置可重建），改造成本高（需要跨窗口协调通道）。
- **不做全量文件锁**：`SaveFile` 原子化就够防半截；只有会丢用户内容的少数文件才加互斥。
- **接受**：wipe-guard 索引最坏丢一行、导出/粘贴的非原子、设置类最后写赢。
- **不改**：租约的「拒绝」语义（busy 是设计意图，只补文案不改行为）。
- **不做** wipe-guard 的「停会话 / 熔断命令」：2026-11-19 作者裁定 critical 只提醒不打断，
  本次不改该语义（harness 下更不该打断——用户可能正在另一个仓库干活）。

---

## 5. 统一阶段规划（避免抢同一批文件）

> 关键约束：线 B 要改 `ai-panel.js`（**21045 行**）与 `ai-subagents.js`（**2364 行**）。
> **线 A（S0–S3）已合入**，下表把 S0–S3 折叠成交付摘要（逐项明细见 git 历史与 v7 版本）；
> 线 B 从 S4 起，编号沿用 S4–S7，括号里是复核后的建议批次名（B1–B4）。线 B 的编排重构（S6）仍必须最后。
>
> v8 复核后的人日：**S4 2→1.5–2**（落点改名，工程量不变）、**S5 3–4→2.5–3**（复用已有日志底座）、
> **S6 5–8→3–4 + 单列 Go loop**（拆出「可续跑」与「引擎下沉」两件事）、**S7 3–5→2–3**
> （版本兼容半成）。合计从 **13–21** 降至 **9.5–12** 人日（不含 Go loop 立项）。

| 阶段 | 内容 | 涉及文件 | 人日 | 风险 |
|---|---|---|---|---|
| **S0** | ✅ 已实施。纯函数 + 测试：`windowWorkspace` / `activeFileDir` / `scopeRootOf`（四步）、`decideSessionOpen` 的 `switchInPlace` 分支、`workspaceOpenMode` 归一 | 新增 `ai-session-scope.js` 函数 + 测试 | 0.5 | 无 |
| **S1** | ✅ 已实施。换手骨架 + 工具根改会话 + **`SaveFileAtomic`（仅 `.cadt/**`；`SaveFile` 未改，见 §4.9.3 实施结果）** + wipe-guard 同根修复（详见原表，此处不再展开） | `main.js`、`ai-panel.js`（路径段）、`ai-worktree.js`、`bridge-git.js`、`session-restore.js`、`internal/fileio/fileio.go`、`ai-wipeguard.js` | 3.5 | 中高 |
| **S2** | ✅ 已实施。上下文与状态改会话根 + 并发加固（AGENTS.md / 记忆 / 项目规则 / 技能 / 认知 / 群聊 / 分层渲染 / 缓存 Map 化 / cognition 分桶） | `ai-system-context.js`、`ai-permission-settings.js`、`ai-cognition.js`、`ai-panel.js`、`internal/cognition/service.go` | 3.5–4.5 | 中 |
| **S3** | ✅ 已实施。harness 窗口 + 跨窗口协调与防护加固（`--harness` / 独立快照槽 / backing workspace / 三选一选择器 / CLI 投递 / 重活去重放 Go / per-root wipe-guard） | `bridge-ui.js`、`session-restore.js`、`main.js`、`app_window.go`、`window_host.go`、`internal/windowreg`、`internal/watch/resource.go`、`ai-wipeguard.js` | 4 | 中高 |
| **S4**（B1） | 平台原语一（低风险，纯新增）：DI 服务容器 + 五模式事件总线 + 收编 10 个域注册表的登记口 + 单测。**容器落点 `shell/plugin-container.js`；总线独立命名空间，不进 `EVENT_SCOPES`** | 新增 `shell/plugin-container.js`、`core/hook-bus.js`，改 `plugins.js` 的 `apiFor` | 1.5–2 | 低 |
| **S5**（B2） | 平台原语二：事件粒度下探（`tool` / `approval` / `agent` / `turn` 四类事件）+ 崩溃尾部改成**追加** `turn/close`（保留现有载入改写兜底）+ **同批改 Go `sessionstore`/`vacuum` + parity 测试**。先「只写不读」 | 扩 `ai/session/ai-session-store.js`、`ai-session-disk.js`；`internal/sessionstore/*`；`ai-session-vacuum-parity.test.mjs` | 2.5–3 | 中高 |
| **S6**（B3a） | 平台原语三：编排持久化——子代理运行态落盘、跨进程可续跑；随后 P1 的 preset / 配置 schema / digest 去重 | `ai-subagents.js`、`ai/agent/ai-agent-model.js`、`ai-system-context.js`、新持久化层 | 3–4 | 高 |
| **S6′** | **单独立项**：Go 侧 agent loop（把前端闭包循环下沉）。与 S6 无强耦合，不要并成一批 | `internal/aichat`、新编排引擎包 | 待评估 | 极高 |
| **S7**（B4） | 平台配套：插件依赖声明 / 组合配置（复用 `vercmp`）；编辑器内联 AI（`aiComplete` + Ace widget） | `plugins.js`、`internal/plugins/plugins.go`、`editor-plugin-view.js`、`editor-groups.js` | 2–3 | 中 |

**线 A 交付物**（S0+S1 ≈ 4 人日）已拿到「点会话不再满屏新窗口、且不写错仓库」，
`SaveFile` 原子化与 wipe-guard 同根修复一并落地。**线 B 的起点因此是「干净的地基」**：
会话级作用域已成立——`agent.ctx` 可以直接长在 `scopeRootOf` 上，不必先改根解析。

**线 B 建议顺序**：S4 → S5 → S6 → S7。S4 与 S5 可小范围并行（S4 只碰 `shell/` 与 `plugins.js`，
S5 只碰 `ai/session/` 与 Go `sessionstore`，文件不重叠），但**两者的测试基线必须先合并干净**
（见 §0 的脏树）。S6 仍必须最后，S6′ 不进本项目排期。

```html
<style>
  .g{display:flex;flex-direction:column;gap:6px;font-size:11.5px}
  .r{display:grid;grid-template-columns:96px 1fr;gap:8px;align-items:center}
  .nm{color:var(--muted);font-size:11px}
  .track{position:relative;height:22px;background:color-mix(in srgb, var(--text) 6%, transparent);border-radius:5px}
  .bar{position:absolute;top:3px;height:16px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--on-accent);white-space:nowrap;overflow:hidden}
  .b{background:var(--green)}
  .c{background:var(--warn)}
  .d{background:var(--muted)}
</style>
<div class="g">
  <div class="r"><div class="nm">B1 · S4</div><div class="track"><div class="bar b" style="left:0;width:18%">容器 + 总线 · 1.5–2 人日</div></div></div>
  <div class="r"><div class="nm">B2 · S5</div><div class="track"><div class="bar c" style="left:18%;width:26%">事件粒度 + 闭合 · 2.5–3 人日</div></div></div>
  <div class="r"><div class="nm">B3 · S6</div><div class="track"><div class="bar d" style="left:44%;width:34%">可续跑 + preset · 3–4 人日</div></div></div>
  <div class="r"><div class="nm">B4 · S7</div><div class="track"><div class="bar d" style="left:78%;width:22%">配套 · 2–3 人日</div></div></div>
</div>
```

---

## 6. 验证

- **单测**：`frontend/test/ai/session/ai-session-scope.test.mjs`（`scopeRootOf` 四步 + 新分支）、
  `frontend/test/shell/session-restore.test.mjs`（`applyWorkspaceSnapshot`）、
  新增 `frontend/test/ai/session/scope-root.test.mjs`（会话根优先 / backing workspace / 两层兜底 /
  路径归一对齐 Go 向量）。**新测试文件必须登记进 `frontend/package.json` 的 `test:*` 清单**
  （漏登记＝从没跑过）。线 B 的 S4 另需 `test/shell/plugin-container.test.mjs`（查找 / 替换 / inject 就绪 /
  disposer）与 `test/core/hook-bus.test.mjs`（五模式语义：`waterfall` 短路、`bail` 首个返回值、
  `serial` 顺序），两个都要登记进 `package.json` 的 `test:*` 清单**并由 `test-manifest.test.mjs` 兜住**。
- **守卫**：S4 的新总线**不得**让 `event-bridge-guard` / `event-contract-guard` 变红——
  前者管 `EventsOn` 只出现在桥里，后者管 Go↔前端事件名双向成对。插件进程内事件不进 `EVENT_SCOPES`。
- **类型**：改动 `frontend/src/core/*` 与纯逻辑文件加 `// @ts-check`，`npm run typecheck` 零错。
- **绑定面**：线 A 之前定的是「v6 不新增 Go 绑定」。**v8 复核后**：S5 只扩事件词表、写点仍在前端，
  **不新增绑定**（原计划里 `internal/sessionlog` 的绑定随「不新建该包」一并取消）；S4 / S7 都在前端，同样不加。
  只有 S6′（Go 侧 agent loop）真正下沉时才需要。若届时新增，需
  `UPDATE_BINDINGS_BASELINE=1 go test -run TestAppBindingBaseline .` + 重生成
  `frontend/src/types/backend.d.ts` + `dev/mock-backend.js` 补 mock；基线当前 **434** 条，
  避开 `Start / Close / EnsureDir / ServiceStartup` 四个禁用名。
- **构建门**：`npm test`（含 typecheck 前置门）、`go build ./...`。
- **手工清单**：
  1. 会话列表点跨工作区会话 → 按设置项分别验证「新窗口」与「原地换手」；
  2. 目标工作区已开在别的窗口 → 前置并投递会话（不抢占）；
  3. 换手后：树 / Git / 监听 / 便签 / wipe-guard 基线是否都指向新根；
  4. **A 会话跑长回合（写文件 + run_command）期间换手到 B → 写仍落在 A**（S1 核心验收）；
  5. A 持有隔离 worktree 时换手 → 统计/丢弃不串根；
  6. harness 窗口：两个工作区会话各发一轮，检查范围根 / AGENTS.md / 记忆 / 项目规则（含设置页写入口）/
     技能来源是否各自正确；
  7. harness 标签布局不写进共享槽（关掉 harness 后普通窗口仍恢复自己的）；
  8. `.cadt` 钩子不重复执行；崩溃自愈首次进入新工作区的清理有日志；
  9. **回合保护**：S1 阶段有 stream 时点别的会话 → 拒绝并提示；S1 完成后（根冻结）应放行，
     且写文件 / cwd / worktree 全程留在原仓库；
  10. **分层渲染**：换手后旧标签带「工作区外」标记；`<workspace_context>` 里活动文件始终出现，
      本根列相对路径，其它工作区折叠为无路径摘要，虚拟标签不受影响，跨工作区裸文件名仍能解析成芯片；
  11. **新建会话**：harness 点新建 → 必弹三选一；选「会话沙盒」后 `meta` 正确、可读写、不污染仓库；
  12. **性能**：连续切 10 个不同工作区会话 —— `git status` 与 open 钩子各最多执行 1 次 / 工作区；
      快速连点 5 次只落地最后一次；切回已加载会话不重读正文；
  13. **并发加固（§4.9）**：
      - `SaveFile` 原子化后，写入中途被杀（模拟）不留半截文件；
      - `MEMORY.md` 两会话并发写 → 不丢条目（第二次写入等待或合并，不是覆盖）；
      - `permissions.json` 两窗口并发改 → 不丢规则；
      - `cognition` 同工作区两会话并发 edit → 后者收到 busy 或 CAS 拒绝，不是静默覆盖；
  14. **wipe-guard（§4.9.7，逐条对应六个失效模式）**：
      - F1：A/B 交替切换 5 轮后，A 的 `watchWindow` 与基线**不清零**；
      - F2：harness 下（树根与登记根脱钩）`workspace-changed` 仍能收到当前会话根的事件；
      - F3：换手期间 A 的 `preCommand` 与 `postCommand` 用同一根；跨根时**拒绝比较**而非报警；
      - F4：harness 下 `snapshotTick` / 周期校准**有实际执行**且日志写明覆盖根；
      - F5：A 根告警后 2 分钟内 B 根的真破坏仍能报警（冷却按根独立）；
      - F6：A 会话删 ≥40 个文件（10s 滚动窗口阈值）的同时切到 B → 仍触发 critical 并投递给 A；
  15. **平台原语（S4）**：最小双插件跑通「A 提供 service → B `inject` 后就绪并拿到同一实例 →
      B 的 `waterfall` 钩子接管并短路一次请求 → 禁用 B 后 disposer 撤干净、A 的服务不受影响」；
  16. **回归**：子代理 `spawn/wait/send`、群聊四种模式、审批链全绿。

### 6.1 wipe-guard 端到端演练（必须真跑，S1 与 S3 各一次）

单测覆盖不到这一层：它涉及内核 watcher 事件、多窗口时序与真实文件删除。**每一次动 wipe-guard 或
换根逻辑，都必须跑一遍这个演练**。

**演练工作区（关键约束）**：

- 目录用 `%TEMP%\cadt-wipeguard-drill\`（**不要放仓库内，更不要放 `.cadt/` 下**）。
  原因：`.cadt` 在 `WIPEGUARD_SKIP_ANY_DIRS` 里（`ai-wipeguard.js:48`），其下事件会被
  `wipeGuardSkipPath` 全部跳过，**演练会静默不触发**，看起来像「修好了」其实什么都没测。
- 该目录只作为「一个工作区」打开，不放进任何 git 仓库。
- 造数：`src/` 下 120 个 `.txt`，文件名不含 `dist/build/out/bin/coverage/node_modules/.git` 等
  skip 词（否则同样不计入）。删除要在一轮内完成（10s 滚动窗口）。
- 每次演练前后各跑一次 `git status --porcelain`（在真仓库里），**两次输出必须一致**。

**四个场景**：

| # | 对应 | 步骤 | 预期 |
|---|---|---|---|
| D1 | F1 基线不清零 | 在演练工作区删 20 个文件 → 切到另一工作区 → 切回 → 再删 60 个 | 两次合计应触发 critical；若基线被清零则第二次 60 个仍触发但日志显示窗口从空开始（对比日志时间戳判定） |
| D2 | F3 同根比较 | 让 AI 在演练工作区跑一个 >5s 的 `run_command`，期间换手到另一工作区 | 命令前后指纹**同一根**；**不得**出现「整仓顶层条目被清空」这类跨根误报 |
| D3 | F6 非当前根不失明 | 在 A 会话让 AI 删除 ≥40 个文件（10s 内），**立刻**切到 B 会话 | 状态栏红条 + 消息中心 + `WipeGuardAlarm` 日志命中；告警投递给 **A** 而非 B |
| D4 | F4 长驻保护在跑 | harness 窗口开着 12 分钟不动 | 校准日志有 ≥1 条（含覆盖根），快照有 ≥1 次；**不得**出现「根为空直接 return」 |

**判定口径**：

- 通过：D1 日志显示 A 的 `watchWindow.seq` 未归零；D2 无跨根误报；D3 告警落在 A；D4 有校准记录。
- 失败的最常见形态：D3 无任何告警（说明 watcher 没跟着会话根，或告警投递对象错），
  D2 出现 critical「整仓顶层条目被清空（N → 1）」（说明 pre/post 跨了根）。
- 演练产物（造数脚本、日志片段）放 `.cadt/tmp/wipeguard-drill-<日期>/`，不提交。

---

## 7. 决议记录

### 7.1 线 A 决议（2026-11-25）

| # | 议题 | 决议 |
|---|---|---|
| 1 | 单打开者不变量 | **撤销窗口级写权占位**（v6 推翻 v3）：六家无一先例；改「会话租约 + 路径级写边界 + 升权审批」；`IsWorkspaceOpen` 退回纯体验守卫 |
| 2 | 换手时进行中的回合 | **两段式**：S1 用 `busy` 拒绝兜底 → S1 内落地根冻结后升级为「回合在原点跑完」 |
| 3 | 换手时旧标签 | **保留** + 标「工作区外」 + `<workspace_context>` **分层渲染**（不是过滤） |
| 4 | harness 新建会话 | **三选一选择器**（最近工作区 / 打开文件夹 / 会话沙盒），不静默 |
| 5 | 根归属模型 | **窗口不持有根**，`scopeRootOf(session)` 唯一来源，窗口根降级为投影缓存 |
| 6 | 换根写历史 | 换手后下一次起轮注入 `<workspace-context-change from to>` |
| 7 | 未绑定会话形态 | 从「只读 + 绝对路径」改为 **backing workspace**（可读写、天然隔离） |
| 8 | 根冻结的架构位置 | 收口到 `onPreStep(session)`，将来零改动接入 `agent/pre-step` waterfall |

### 7.2 线 B 决议

> 1–4 为 v7 原决议；5–9 为 v8 复核（2026-11-27）新增，凡与旧决议冲突的以新决议为准。

| # | 议题 | 决议 |
|---|---|---|
| 1 | 是否原样运行 DSH 插件 npm 包 | **不追求**（等于移植整个 DSH，238 workspace 包）；只做契约思想对齐 |
| 2 | 务实路线 | 短期把 DSH 作为受管 sidecar（`registerService` + `internal/appservices`），CaDt 做书仓查看 / 状态面板 / 命令面板，两边共享书仓目录 |
| 3 | 平台原生化顺序 | **先地基后编排**：S4（DI + 事件总线）→ S5（事件溯源，先只写不读）→ S6（编排持久化）；S6 之前不动 `ai-subagents.js` |
| 4 | 两条线的关系 | 线 A 是线 B 的地基与验证场：先证明「会话级作用域」成立，再扩展成完整 `agent.ctx` |
| 5 | 事件溯源落点（v8） | **不新建 `internal/sessionlog/`**。复用 `internal/sessionstore` 的日志与 vacuum，只在 `ai-session-store.js` 扩事件词表 + 追加 `turn/close` 闭合事件；改格式必须同批改 vacuum 与 parity 测试 |
| 6 | DI 容器命名（v8） | 用 `shell/plugin-container.js`。`shell/plugin-services.js` 保留给「插件后台子进程服务」，**两者不合并**（一个是依赖注入，一个是进程托管） |
| 7 | 五模式总线命名空间（v8） | 独立进程内总线（`cadt.on / cadt.emit`），**不进 `EVENT_SCOPES`**；那张表继续只做 Go↔前端跨窗口契约，由 `event-contract-guard` 守 |
| 8 | 编排持久化与 Go loop（v8） | **拆开**：S6 只做「前端可续跑 + preset + schema」；Go 侧 agent loop 立为 S6′，单独评估、不进本次排期（原 5–8 人日里含它，是估算偏高的主因） |
| 9 | 上下文去重（v8） | 从 P1 降为小改：`assembleSystemContext` 已分 stable / `turnBlock`，只补 digest 与 `headerEquals` 等价物，不再做「分区改造」 |

### 7.3 评审与审计处置摘要

前序评审（事实核对 / 遗漏审查两名只读子代理）的 18 条发现 + 6 条事实修正已全部并入本文：
换手会让进行中回合根漂移（→ S1 必含根冻结）、worktree 生命周期挂窗口根（→ §2.2）、
harness 写共享单槽（→ S3）、TOCTOU 守卫（→ v6 撤销占位后消失）、技能/认知缓存单槽（→ S2）、
项目规则写侧无会话（→ S2）、Git 撤销不接根（→ S1）、生成产物取窗口根（→ S1）、
群聊 workspace（→ S2）、`scopeRootOf` 含活动文件兜底（→ §4.2 拆两层）、记忆静默回落（→ S2）、
`workspaceFolder` 判可用性的一批入口（→ S3）、`WindowList` 无仓库信息（→ S3）、
计划审批 cwd 键（→ S1）、崩溃自愈语义（→ 仅崩溃后首轮，保持）。

**v7 并发审计新增处置**：
`SaveFile` 裸写（→ S1 原子化）、`MEMORY.md` / `permissions.json` 丢更新（→ S2 锁通道）、
`resourcelease` 进程内 refcount 在多窗口下失效（`sessionLeases` / `memoLeases` 已修、
**cognition 未修** → S2）、跨窗口 localStorage 无锁（→ S3 独立快照槽；其余接受）、
重活去重表若放前端会重复执行（→ S3 放 Go 侧）、
**wipe-guard 六个失效模式**（F1 换根清零漏报 / F2 监听根不跟会话 / F3 pre-post 跨仓库误报
→ S1；F4 静默失效 / F5 冷却不分根 / F6 单根 watcher 失明 → S3）。

---

## 8. 风险与不做

### 8.1 风险

| 风险 | 应对 |
|---|---|
| `ai-panel.js` 2 万行、编排与 UI 深度耦合 | S1/S2 只改路径与上下文段，不碰编排；S6 前不动 `ai-subagents.js` |
| 同仓库两窗口并发写（v6 放开后） | 冲突交给 git；数据丢失风险由会话租约挡住（I1）；越界走升权审批 |
| 大仓库 `git status` 无上限 | 走「标脏 + 空闲刷新」，不做后台轮询；S3 验收要求 1 次/工作区 |
| **wipe-guard 漏报（§4.9.7 F1/F2）** | 这是最危险的失效——防护静默失灵等于 11-18 事故失去防线。S1 修同根与监听根，S3 补 per-root 状态表与多根 watcher；**验收按 §6.1 的四个场景真跑，单测不能替代** |
| **`SaveFile` 裸写被遗漏** | ~~S1 统一改 `atomfile`，一处改动覆盖 24 个调用点~~ **v8 更正**：线 A 只新增了 `SaveFileAtomic` 给 `.cadt/**`，`SaveFile` 本身未改（§4.9.3 实施结果）。`MEMORY.md` / `permissions.json` 已随 S2 走锁通道；其余用户可见写点仍非原子，属**已知未收口项**，不要再当成"已修" |
| `resourcelease` 进程内 refcount 漏洞 | 只有 `sessionLeases` / `memoLeases` 修过；S2 补 cognition 分桶，其余新增写通道一律照抄该模式 |
| 一个窗口只能监听一个根 | harness 的树跟随当前会话根（不做多根监听）；接受旧工作区标签失去变更事件 |
| `stash@{0}` 等外部工作区状态 | 动手前确认工作区干净；不覆盖他人未提交改动 |
| **S5 改事件格式击穿 vacuum（v8 新增）** | 会话日志是「前端写 + Go 整理」的双端共识。事件词表一变，`internal/sessionstore/vacuum.go` 与 `ai-session-vacuum-parity.test.mjs` 必须同批改，否则存量会话整理会**静默丢事件**（不报错，回放才发现缺） |
| **S4 两套「服务」混淆（v8 新增）** | 容器叫 `plugin-container`，`plugin-services` 保留给子进程托管；两者都在 `shell/` 下，靠文件名与文件头注释区分，不合并 |
| **插件事件污染跨窗契约（v8 新增）** | 新总线独立命名空间，不进 `EVENT_SCOPES`；`event-contract-guard` 只认后者，混用会让「Go 没有发射点」的假失败掩盖真问题 |

### 8.2 不做

- 不做「一个窗口同时持有多个工作区登记」——登记唯一仍是路由 / 复用 / CLI 投递的前提。
- 不把工作区概念从窗口彻底移除（普通主窗口仍一目录一窗口）。
- 不改审批与沙箱语义（harness ≠ 放宽权限）。
- 不为 harness 新造会话存储（复用 `session.workspace`、分桶与 `noWorkspace` 标记）。
- 不做多根 mention（`@frontend:path` 类）——单根会话更清晰，复杂度会扩散到搜索/提及/路径适配三处。
- 不原样运行 DSH npm 插件包。
- 不给 git / 指纹加后台轮询。
- （v8）**不新建 `internal/sessionlog/`**——与 `internal/sessionstore` 双写会击穿 vacuum parity；
  事件溯源在既有日志上做增量，不另起一套存储。
- （v8）**不把插件进程内事件登记进 `EVENT_SCOPES`**——那张表是 Go↔前端跨窗口契约，混用即失效。
- （v8）**不把 Go 侧 agent loop 并入 S6**——它是独立工程，混进来会让「编排持久化」永远交付不了。

---

## 9. 参考实现对照（六个开源 harness）

| 维度 | 六家做法 | 我们采纳 |
|---|---|---|
| 根归属 | 全部会话级：`Session.location`（opencode）/ `SessionHeader.cwd`（pi）/ `workingDirectory`（ZCode）/ `environments[]`（codex）/ `SessionWorkspaceConfig.cwd`（cline）/ `header.cwd`+投影（deepseek） | ✅ 窗口不持有根 |
| 切会话 | pi `switchSession` 按该会话 cwd 重建整套 cwd-bound services | ✅ 切会话即切作用域 |
| 根变更 | opencode 注入「working directory has been changed to X」；deepseek 可回放投影 | ✅ §4.5 |
| 无工作区 | ZCode backing workspace / cline 共享 chat 目录 + 礼仪 AGENTS.md / deepseek 可空 cwd（不入组）/ 另三家不支持 | ✅ §4.8 |
| 越界 | codex Read/Write/Deny + writable_roots + 升权审批；deepseek 三档沙盒；opencode 两级审批；ZCode 不硬阻断（反面）；pi 静默放行（反面） | ✅ §4.4 |
| 多根上下文 | codex 按 environment 标注 `for <id> with root <cwd>` | ✅ §4.3 分层 |
| 「用户在看什么文件」 | **六家都没有**（只靠显式 @mention） | 我们已有 `<workspace_context>`，比六家强，保留并分层 |
| 多根 mention | cline 有 `@name:path` | ❌ 不采纳 |
| 窗口级写权 | **六家都没有** | ❌ 已撤销（v6） |
| 事件溯源 / DI / 五模式事件 | DSH 有完整实现 | ✅ 线 B 目标 |

---

## 10. 参考来源与依据

- **代码依据**：`docs/reports/workspace-isolation-audit.md`（四层模型、13 条不变量、工具路径链路、写效应清单）。
- **六个开源 harness**（只读调研，行号相对各仓库根）：
  opencode `packages/schema/src/session.ts:28-48`、`packages/core/src/instructions/builtins.ts:33-42`、
  `packages/core/src/file-access.ts:114-130`；
  pi `packages/coding-agent/src/core/session-manager.ts:43-50`、
  `agent-session-runtime.ts:215-243`、`tools/path-utils.ts:38-43`；
  ZCode `apps/zcode-cli/packages/core/src/runtime/types.ts:263-283`、
  `tool/path-policy.ts:8-59`、`docs/superpowers/specs/2026-07-10-non-project-conversation-workspace-design.md`；
  codex `codex-rs/protocol/src/environment.rs:24-43`、`protocol/src/permissions.rs:131-146,1361-1400`、
  `core/src/agents_md.rs:444-453`；
  cline `sdk/packages/shared/src/session/runtime-config.ts:59-62`、
  `services/workspace/chat-workspace.ts`、`tools/executors/editor.ts:42-64`；
  deepseek-harness `packages/session/session-format/src/types.ts:16-26`、
  `session/working-directory/src/index.ts:113-127`、`fs/fs-sandbox/README.md:12,48`、
  `context/agent-instructions/README.md:130-188`。
- **DSH 宿主契约**：Cordis 入门 `https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer.md`、
  服务与依赖 `.../develop/framework/service.md`、架构深读 Discussion #1103。
- **v8 插件形态**：`https://github.com/lingfengQAQ/webnovel-writer/tree/v8`、
  `https://lingfengqaq.github.io/webnovel-writer/docs/install.html`。
- **CaDt 插件开发指南**：本地 `docs/plugins/README.md`。
