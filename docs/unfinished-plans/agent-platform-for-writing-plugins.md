# Agent 宿主平台化：让 CaDt 成为 webnovel-writer v8 类插件的通用底座（评估方案）

> **⚠ 本文已并入 `docs/finished-plans/agent-host-platform.md`（2026-11-25 整合）**，本文件保留作历史记录，
> 不再维护。整合版保留本文的 DSH 契约分析、P0/P1/P2 分层与务实路线（sidecar），并把「平台化」与
> 「多工作区 harness」合并为统一分期（S0–S7），解决两者都改 `ai-panel.js` 的排期冲突。
>
> 状态：**评估完成，未实施**（2026-11-25 完成差距分析与分层设计；P0 四项为硬门槛，其中事件溯源会话与编排持久化是最大工程量，等于重构 AI 核心。本文是未完成方案，供后续决策与排期，不代表已排入开发）
> 缘起：用户提出「不是把 v8 内置进 CaDt，也不是做专用插件，而是让软件给插件提供通用平台，就像 v8 依赖 DSH 的那些」。本文据此做 DSH 宿主契约与 CaDt 平台能力的逐层差距分析。
> 结论先行：**完全兼容 DSH（原样跑 npm 包）不可行且不划算；平台能力对齐（同一套契约思想、插件稍加适配）可行，但 P0 四项是重构级投入**。最务实路线是把 DSH 作为受管 sidecar 托管，CaDt 做书仓查看/状态面板，两边共享书仓目录。

## 1. 背景与代码事实（2026-11-25 核实）

### 1.1 v8 的真实形态与宿主依赖

webnovel-writer v8（DSH Scriptor 8.4.2）不是普通插件，而是**运行在 DeepSeek Harness（DSH）上的写作工作台**：

- 安装标识 `@linfengqaqtat/dsh-scriptor@8.4.2`，配套 DSH `0.2.2-rc.5`，兼容范围 `>=0.2.2-rc.1 <0.3.0-0`，Node ≥ 24.9（来源：v8 安装文档 https://lingfengqaq.github.io/webnovel-writer/docs/install.html ）
- `packages/core/package.json` 的依赖（GitHub API base64 解码核实）：
  - peer `@deepseek-ai/cordis ^4.1.0`（DI / 插件容器）
  - peer `@deepseek-ai/dsh-user-questions >=0.2.2-rc.1 <0.3.0-0`（交互提问）
  - dev `@deepseek-ai/dsh-user-questions 0.2.2-rc.5`
  - workspace 内部包：`@webnovel/drafting` / `polish` / `review`
- 主包含 **12 个写作与维护技能 + 8 个脚本入口**；检索增强、鲸鱼娘是可选独立包。
- `packages/bundle/cordis.patch.yml` 内容：`- insert: - id: webnovel  name: '@linfengqaqtat/dsh-scriptor'` —— 即通过 Cordis 覆盖层把插件挂进 profile。

### 1.2 DSH 宿主契约（Cordis 模型，源码级）

来源：DSH 官方 Cordis 入门（https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer.md ）、服务与依赖（https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/service.md ）、架构深读 Discussion #1103（https://github.com/deepseek-ai/deepseek-harness/discussions/1103 ）。

- **插件 = 导出 `apply(ctx)` 的模块**；`ctx` 是访问框架能力的唯一入口，不 import 框架内部对象。
- **服务容器**：能力挂在稳定 key（`ctx.tools` / `ctx.llm` / `ctx.agents` / `ctx.sessions`）；插件用 `inject` 声明依赖，等待就绪后才启动；服务可被替换、可被 group 隔离；注册通过 `ctx.effect()` / `ctx.on()` 可逆，卸载时按 disposer 清理。
- **事件分发五模式**：`emit`（观察）/ `waterfall`（环绕中间件，可短路接管）/ `parallel`（并行）/ `serial`（有序）/ `bail`（首个返回值终止）。waterfall 是「一切皆插件」在决策层的核心。
- **事件溯源会话**：一切状态 append 进会话日志（深冻结），UI 回放/压缩/审计都从日志派生；崩溃尾部由 `interruptedTurnClosers` 合成闭合事件恢复；replay 是一等公民。
- **Agent Preset**：一个 preset = 目录（`agent.cordis.yml` + `preset.yml`），决定工具集 + persona + prompt sections + realm 隔离；建多个 preset 目录即多 Agent；会话创建时选 preset 并持久化到 session header。
- **Agent Scope 隔离**：每个 live agent 有扁平注册层 `agent.ctx`，工具/prompt/变量只对该 agent 可见；「一进程跑多个异构 agent」。
- **上下文哲学**：durable 消息（AGENTS.md / skill catalog / persona / 权限）加载一次不重发；动态部分每 step 变化；`headerEquals` 去重保持前缀稳定、复用 KV cache；压缩阈值 0.8 且发 `x-deepseek-harness-compact: 1` 头保 warm cache。
- **插桩点**：`agent/pre-step` / `agent/request` / `agent/request-error` 三个 waterfall 点让插件接管决策。
- **子代理**：6 种 transport + 可续跑的后台子代理。

### 1.3 CaDt 现状（已有底座，代码事实）

CaDt 是 Go(Wails v3) + Vue/JS 前端，源码在 `D:\OraSkyC\Project\CandySweet\CaDt-DataLens`。通过两路只读调查核实：

**已有、可复用的底座：**

- **Agent 循环**（前端）：`frontend/src/ai/ai-panel.js:13011` `startRound` → `:13560` `handleToolRound` → `:10240` `executeTool` → 工具结果 push 进 `session.messages` → 续轮；无硬轮次上限。
- **子代理系统**（前端）：`frontend/src/ai/agent/ai-subagents.js`：`spawn_agent / wait_agent / agent_send / agent_stop / agent_compact / agent_tree` 齐全；嵌套 `:439`、并发 `:437`、任务树、收件箱、worktree 隔离、沙箱档、轮次预算强制收尾都有。
- **工具链**：`frontend/src/ai/tools/ai-tool-defs.js`（125KB）+ `ai-panel.js:10256` `executeToolInner`；MCP / 插件工具前缀路由（`mcp__` / `plugin__`）；结果超阈值落盘 `ai-artifacts/`。
- **三协议 LLM + SSE**：`internal/aitransport/`（openai / anthropic / responses），`sse.go` 解析，`types.go:54` 事件常量，30ms 微批合并。
- **插件 API**：`frontend/src/shell/plugins.js:82` `apiFor()` 单点定义 `registerFormat / addCommand / registerViewer / registerTool / registerService / registerAIProvider / registerAIContext / registerImporter / registerDbDriver / registerDocConverter / registerSettingsPanel / registerCommandClassifier`；由 `new Function('cadt', code)(api)` 注入（`plugins.js:318`）。
- **文件监听**：`internal/watch/` + `frontend/src/main.js:6901` `onWorkspace('workspace-changed')`；AI 写文件后 `notifyFileChanged`（`ai-panel.js:9226`）。
- **技能**：`internal/skills/skills.go`（物化 + agent 技能注册）；`cadt.registerAIContext` 已接进 `ai-system-context.js` 的 `assembleSystemContext`。
- **配置**：`internal/aiconfig/`（DPAPI 加密）、`frontend/src/ai/core/ai-config-model.js` / `model-catalog.js`。
- **调度**：`internal/aischedule/`（cron / interval / once，唤醒会话或新建会话）。

**关键缺口（代码事实）：**

- 子代理状态全在前端内存 Map（`ai-subagents.js:459-466`），**重启即丢**；终态记录仅 LRU 20。
- 编排逻辑与 UI 渲染、会话持久化、审批链、沙箱、worktree、压缩深度耦合，无独立「编排引擎」抽象；`ai-panel.js` 20171 行、`ai-subagents.js` 2361 行，代码里大量「实测缺陷」注释。
- Go 侧**无 agent loop**（`internal/aichat/chat.go:69` 单轮流式即返回），所有循环在前端闭包。
- 无事件溯源日志、无服务容器 / inject、无五模式事件总线、无 agent scope / preset、无配置 schema、无上下文去重。
- 编辑器是 vendored Ace（`doc.editor.aceEditor` / `window.ace`）；`registerViewer` 的 ctx 已含 `getSelection / setSelection / requestSave`（`frontend/src/editor/editor-plugin-view.js:139`），但**无 `aiComplete` 桥、无 Ctrl+K 行内润色 widget**。
- 插件分发是「文件夹 + plugin.json」，无依赖声明 / 组合配置 / 版本兼容层。

### 1.4 本机实况（2026-11-25）

- 书仓 `D:\OraSkyC\Novel\日记星辰` 本身是 webnovel-writer 书仓：`.story-system/`（62 个 accepted commit，第 63 章合同已就绪）、`.webnovel/`（state.json / index.db / vectors.db / projection_log.jsonl）。
- 本机已装 webnovel-writer **v6.4.0** 插件（`.claude/settings.json` 启用，`~/.claude/plugins/installed_plugins.json` 记录），但 `claude` 命令不在 PATH。
- `project-status` 输出：`phase: chapter_contract_ready`，`target_chapter: 63`，`next_action: run /webnovel-write 63`；`write-gate --chapter 63 --stage prewrite` 校验通过。

## 2. 目标与非目标

### 目标

- 明确「CaDt 作为 Agent 宿主平台」相对 DSH 的能力差距，给出分层清单（P0/P1/P2）。
- 为每条差距标注 CaDt 现状、需补内容与大致落点，供后续排期。
- 给出一条投入产出比最优的务实路线。

### 非目标

- 不追求 CaDt 原样运行 `@linfengqaqtat/dsh-scriptor` npm 包（那等于把 DSH 整个搬进 CaDt）。
- 不在本文实现任何代码；本文是评估方案。
- 不把 v8 写作能力做成 CaDt 专用内置功能（那是另一条路线，见「备选路线」）。

## 3. 两条平台化路线

| 路线 | 含义 | 判断 |
| --- | --- | --- |
| 路线 1：完全兼容 DSH | CaDt 内嵌 Node + Cordis 运行时、TS 模块加载、Schemastery、typert RPC、React UI 宿主，让 v8 npm 包原样跑 | **不可行 / 不划算**：等于移植整个 DSH，238 workspace 包 |
| 路线 2：平台能力对齐 | CaDt 补齐 DSH 宿主原语，v8 类插件稍加适配即可跑（同一契约思想，非原样 npm 包） | **可行**：本文目标，P0 为重构级投入 |

## 4. 需要添加的能力清单（分层）

### 4.1 P0 · 硬门槛（不加就不成其为 Agent 平台）

| DSH 能力 | CaDt 现状 | 需要添加 | 大致落点 |
| --- | --- | --- | --- |
| 事件溯源会话日志 | 缺失：状态在前端 Map，重启即丢 | append-only 深冻结日志；UI/恢复/审计从日志 replay；崩溃尾部合成闭合事件 | 新建 `internal/sessionlog/`；`ai-panel.js` 改为写日志 |
| 可持久化 Agent 编排 | 缺失：编排在前端闭包，无断点 | 流水线状态落盘（对应 v8「断更数月回来一句继续」） | `ai-subagents.js` + 新持久化层 |
| DI 服务容器 | 部分：注册式 `cadt.*`，无服务查找/替换 | 服务注册表 + `inject` 声明依赖 + 等待就绪 + 替换/隔离 + disposer 清理 | 新建 `frontend/src/shell/plugin-services.js`；改 `plugins.js` |
| 事件分发五模式 | 部分：仅 `appEvents.on` 简单订阅 | `emit / waterfall / parallel / serial / bail`，尤其 waterfall 接管决策 | 新事件总线或扩展 `appEvents` |

### 4.2 P1 · 能力对齐（补上后大半 v8 特性能对上）

| DSH 能力 | CaDt 现状 | 需要添加 |
| --- | --- | --- |
| Agent Scope 隔离 | 缺失：工具/提示全会话共享 | `agent.ctx` 扁平注册层，每 agent 独立工具/提示/变量 |
| Agent Preset（写作模式） | 缺失：无 preset 概念 | 声明式人格目录（persona + 工具集 + 提示片段），随会话持久化 |
| 配置 Schema | 缺失：插件配置无校验 | Schemastery 式 schema：校验 + 默认值 + UI，按 scope 隔离 |
| 上下文去重 / KV-cache 友好 | 缺失：每轮全量重发 | durable 消息 + digest + `headerEquals` 去重；压缩保 warm cache |
| 技能自动发现 | 部分：有 `registerAIContext` | 生成 `<available_skills>` catalog 并按 preset 过滤注入 |
| 子代理多 transport | 部分：有子代理，单一前端闭包 | 多 transport + 可续跑后台子代理 |

### 4.3 P2 · 工程配套

- **插件分发/组合**：从「文件夹 + plugin.json」升级为支持依赖声明 + 组合配置（cordis.yml patch 类）+ 版本兼容声明。
- **编辑器内联 AI 闭环**：给 `registerViewer` 的 ctx 加 `aiComplete()` 桥；在 `editor-groups.js` 的 `createDocEditor` 加 Ace 行内 widget（覆盖层视图成本低、行内 widget 成本中）。
- **工具授权 pre-execute 门**：把现有审批链开放为 waterfall 插桩点，供插件接管。
- **类型化 RPC**：现有 Wails bindings（`Call.ByName`）够用；跨进程 agent 需补一层。
- **现成可复用底座**：三协议 SSE、工具链、文件监听、技能、审批链——无需重造，仅接线。

## 5. 务实路线（推荐）

**不追求 CaDt 原生跑 v8，采用 sidecar 托管：**

1. 用现有 `registerService` / `internal/appservices` 把 **DSH 作为受管后台服务**托管（软件启动拉起、健康检查、退出清理整棵进程树）。
2. CaDt 侧做：书仓查看（已有只读插件 `cadt-plugin/`）、状态面板、写作任务书生成器、preflight / write-gate / doctor 命令面板。
3. DSH 侧跑 v8 写作工作台，两边**共享同一书仓目录**。
4. 契合 v8「进度完全从书仓文件与 Git 提交推导、不依赖会话上下文」的设计——CaDt 随时可读到最新状态。

**投入最小、能力最全**；避开 P0 重构级工程量。

## 6. 备选路线（若坚持平台原生化）

若决定做路线 2，建议按「先地基、后编排」推进，且**第一步不是动 `ai-panel.js`**：

1. **阶段一（低风险，纯前端）**：新增 DI 服务容器 `plugin-services.js` + 五模式事件总线（P0 后两项），配单测与 manifest 登记；不动现有 AI 核心。
2. **阶段二（中风险）**：事件溯源日志层（P0 第一项）——先做「只写不读」的 append-only 日志，UI 仍从旧路径渲染，验证稳定后再切 replay。
3. **阶段三（高风险，需专项排期）**：编排持久化 + 重构 `ai-subagents.js`（P0 第二项）——这是最大工程量，必须先解决状态落盘，再谈流水线。
4. **阶段四**：P1 的 scope / preset / 上下文去重，逐项接入。
5. **阶段五**：P2 工程配套与编辑器内联 AI。

> 风险提示：`ai-panel.js`（2 万行）与 `ai-subagents.js`（2361 行）高度耦合，编排与 UI/持久化/审批/沙箱纠缠，无清晰引擎抽象。阶段三之前任何改动都要保证不破坏现有 spawn/wait/send 语义。

## 7. 验证方式（若进入实施）

- 单测：新增服务容器 / 事件总线 / 日志层各自 `frontend/test/**` 单测，并登记进 `test/core/test-manifest.test.mjs`（双向核对，漏登记会红）。
- 绑定守卫：若新增 Go 方法，执行 `UPDATE_BINDINGS_BASELINE=1 go test -run TestAppBindingBaseline .` 更新 `testdata/app_bindings_baseline.txt`，并在 `frontend/src/dev/mock-backend.js` 补 mock、重生成 `frontend/src/types/backend.d.ts`；避开 `Start / Close / EnsureDir / ServiceStartup` 四个禁用名。
- 端到端：用一个最小「写作模式 preset」插件跑通：注册工具 → 声明 inject → 事件 waterfall 接管一次请求 → 会话重启后 replay 恢复。
- 回归：现有子代理 spawn/wait/send、群聊四种模式、审批链全绿。

## 8. 参考来源

- v8 README / 安装文档：https://github.com/lingfengQAQ/webnovel-writer/tree/v8 、https://lingfengqaq.github.io/webnovel-writer/docs/install.html
- DSH Cordis 入门：https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer.md
- DSH 服务与依赖：https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/service.md
- DSH 架构深读 #1103：https://github.com/deepseek-ai/deepseek-harness/discussions/1103
- DSH 官网：https://www.deepseek.com/harness/
- CaDt 插件开发指南：本地 `docs/plugins/README.md`
- CaDt 关键代码位置见本文 §1.3（均带 path:line）
