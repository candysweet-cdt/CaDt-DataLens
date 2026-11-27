# 工作区无缝切换与无工作区 harness 方案

> **⚠ 本文已并入 `docs/finished-plans/agent-host-platform.md`（2026-11-25 整合）**，本文件保留作历史记录，
> 不再维护。整合版把本文与「Agent 宿主平台化」评估合并为统一的分期规划（S0–S7），并保留本文的全部
> 决策、证据与评审处置。新增内容请写整合版。
>
> 状态：**已取代并归档（2026-11-27）**。本文主体已并入 `agent-host-platform.md` 线 A（S0–S3）并落地，作为历史方案归档。归档核验发现两处方案项未随整合版落地：① 根变更写历史 `<workspace-context-change>` / `pendingRootChange`（§3.3.1、决议 #6）；② 回合根冻结（P2a 升级 A，整回合不再现取根）。其余能力由 `switchRootLight` + `applyViewRoot` 等价承接。
> 本文＝只读评估结论 + 实施方案。
> **v6（对齐参考实现，模型级修正）**：只读调研了 opencode / pi / ZCode / codex / cline / deepseek-harness 六个
> 开源 harness，**它们无一采用「窗口绑定工作区」，全部是「会话自带 cwd/roots，窗口只是视图」**。据此做四处修正：
> ① **窗口不持有根**，`scopeRootOf(session)` 成为唯一根来源，窗口根降级为投影缓存（§2 / §4.1）；
> ② **撤销窗口级写权占位**（推翻 v3 决议）——六家无一先例，改由「会话租约 + 路径级写边界 + 越界升权审批」
> 覆盖，同时解掉「同仓库不能双窗口」的限制（§3.1 / §4.6）；
> ③ **换根写进对话历史** `<workspace-context-change>`（opencode / deepseek 做法，§3.3.1）；
> ④ **未绑定会话改用 backing workspace**（ZCode / cline 做法，可读写的会话沙盒，§4.4）。
> 分期相应重排：P1 去掉 Go 新增绑定（2 → 1 人日），P3 2.5 人日；最小切片 ≈3 人日。
>
> **v5（性能预算）**：新增 §4.7——切根成本三档盘点（轻 / 中 / 重）+ 三条硬设计：**轻量换根 `switchRootLight`**、
> **重活按工作区去重**（open 钩子 / 首次 git / 首次指纹各只跑一次）、**换手序列化**；
> P3 相应扩为 3 人日，§7 新增性能验收第 13 条（v6 撤销写权占位后回落为 2.5 人日）。
>
> **v4（标签页注入复议）**：`<workspace_context>` 的处理从「按会话根过滤」改为「按归属**分层渲染**」——
> 活动文件始终注入、本会话根全列相对路径、其它工作区折叠成**不给可解析路径**的摘要、虚拟标签页不过滤；
> 数据源 `getWorkspaceContext()` 保持返回窗口全量事实（`pickOpenFileMatch` 依赖它）。理由见 §4.3。
>
> **v3（拍板后定稿）**：四项待拍板项全部按推荐值确认——① 放宽为「写者唯一 + 多读者」；
> ② 回合处理走「P1 用禁止换手兜底 → P2a 升级为冻结回合根」两段式；③ 旧标签保留并标记「工作区外」；
> ④ harness 新建会话默认引导选工作区，`noWorkspace` 保留为显式入口。决议表见 §6。
>
> **v2（评审后修订）**：两名只读子代理分别做「事实核对」与「遗漏审查」，主要改动——修正行号基准与 3 处引错、
> 新增 §1.5「作用域根的其它消费者」、新增 §3.1 的原子换手（TOCTOU）、**推翻「P1 可独立上线」的分期结论**
> （换手必须与「工具根改会话」同批）、对齐仓库内正在进行的 `noWorkspace` 会话实现。评审发现与处置见 §9。
>
> 两条需求：
> ① **窗口内无缝切换工作区**——同一个窗口可以从仓库 A 换到仓库 B，不必另开窗口。
> ② **无具体工作区（harness 形态）**——窗口不绑定任何工作区，只做 AI 运行容器；AI 面板在
> 单窗口内直接切换不同工作区的会话，起轮时按**该会话自己的工作区**注入上下文与解析工具路径。
>
> **前置评估**：`docs/reports/workspace-isolation-audit.md`（隔离四层模型、12 条不变量、工具路径解析链路、
> 写效应覆盖面）。核心判断——`workspaceFolder` 同时承担「编辑根 / 作用域根 / 窗口身份」三种身份，
> 本次改造的本质是把三者拆开。

## 0. 行号基准

- 核对基准 commit：`966cbf1`（HEAD）。`frontend/src/main.js` 在此版已比本文初稿引用的时点（`488671a^`）
  多 5 行，本文行号**已按当前树修正**；后续若 main.js 再变，请按函数名检索而非依赖行号。
- 仓库工作区当前有未提交改动（`ai-panel.js`、`ai-system-context.js`、`ai-session-scope.js`、
  `ai-session-store.js`、`ai-session-fork.js`、`ai-sidechat.js`、`style.css`、`package.json` 等），
  其中包含**正在落地的「无工作区会话」特性**（`isNoWorkspaceSession`、`ai-no-workspace-session.test.mjs`）。
  本文只读引用这些改动，未修改它们；实施前需先确认该特性已合入，§4.4 的方案已据此调整。

## 1. 现状：工作区是窗口级状态，会话已有工作区归属

### 1.1 窗口侧（一目录一窗口 / 单打开者）

| 事实 | 位置 |
|---|---|
| 原地切换工作区的函数**已存在**（改 `workspaceFolder` + 资源管理器 / 监听 / Git / 便签 / AI 列表全套刷新） | `frontend/src/main.js:3467` |
| 但 UI 入口走 `openFolderSmart`：本窗口已有工作区就**另开窗口** | `frontend/src/main.js:3509` |
| 「一个工作区一个打开者」是显式不变量，共三重守卫：建窗时 `FindByWorkspace` 命中即前置（`window_factory.go:358`）、恢复时 `IsWorkspaceOpen`（`session-restore.js:252`）、CLI 与会话复用同源。**本方案把它收窄为「写者唯一」（§3.1）** | `app_window.go:45`、`window_factory.go:358` |
| 每个工作区的标签 / 分屏快照**已存在**（`cadt.workspace-sessions.v1`，写入时按工作区前缀过滤文件） | `frontend/src/shell/session-restore.js:15,44` |
| 窗口工作区向 Go 侧登记（路由 / 复用匹配的唯一数据源） | `window_host.go:104`（`WindowRegister`）、`:118`（`WindowReuseForSession`） |
| 文件监听每窗口只有一个根，跟随资源管理器根 | `frontend/src/main.js:3652`、`internal/watch/watch.go:75` |
| 无工作区启动时会**自动采纳上次工作区**（`cadt.session.v1` 快照里带 workspace） | `frontend/src/bridge/bridge-ui.js:286`、`session-restore.js:249` |

### 1.2 会话侧（已有归属，无需新建模型）

| 事实 | 位置 |
|---|---|
| 会话 meta 的 `workspace` 是归属真源，磁盘按工作区短哈希分桶 | `internal/sessionstore/sessionstore.go:272` |
| 未绑定工作区的会话已有桶 | `internal/sessionstore/sessionstore.go:49`（`_unbound`） |
| 会话列表**已按工作区分组**、当前组置顶、组头带「新建会话 / 工作区操作」 | `frontend/src/ai/session/ai-session-list.js:643` |
| 「当前会话按工作区记录」已落地（多窗口不再互相驱动） | `frontend/src/ai/session/ai-session-scope.js:51` |
| 点别的会话今天是：探测存活窗口 → 投递复用；未命中 → **软切换另开窗口** | `frontend/src/ai/ai-panel.js:6917` → `ai-session-scope.js:135` → `main.js:4267` |
| 本窗口无工作区时点会话，**已经在原地采纳**该工作区 | `frontend/src/main.js:4291` |
| 子会话已继承父会话 workspace；子代理沙箱根**已与窗口根解耦**（worktree 路径 > 会话 workspace > 调用方兜底） | `frontend/src/ai/agent/ai-subagents.js:868,250` |

> 也就是说：**「按工作区切会话」这条路 80% 已铺好，缺的是「窗口愿意换手」与「根按会话算」。**

### 1.3 AI 作用域的 7 条来源（全部默认取窗口）

| 用途 | 今日取根位置 |
|---|---|
| 范围根 / 路径解析 / 命令 cwd | `frontend/src/main.js:4263`（`getScopeRoot`）→ `ai-panel.js:6959`（`aiResolveScopePath`） |
| 系统提示词「范围根」行 | `frontend/src/ai/core/ai-system-context.js:24` |
| `AGENTS.md` | `ai-panel.js:6800`（`aiProjectRoot`）→ `ai-system-context.js:413` |
| 记忆目录 `.cadt/memory` | `ai-panel.js:7142`（`resolveMemoryDir`） |
| 项目权限规则 `.cadt/permissions.json` | `frontend/src/ai/security/ai-permission-settings.js:686,711` |
| 认知索引 | `ai-panel.js:10167`（`cognitionWorkspace`） |
| 子代理沙箱 / wipe-guard 指纹 | `ai-panel.js:11903,11927` |

引用量：`getScopeRoot` **71 处 / 10 个模块**（`ai-panel.js` 30）；其中直接调用 `getScopeRoot()` 的约 57 处，
其余是 opts 注入、getter 与透传，所以「71 处都是待改调用点」略微高估。
`getWorkspaceContext` 15 处、`aiProjectRoot` 17 处、`ensureProjectRules` 18 处。

### 1.4 无工作区的现状

- **临时会话**：不绑工作区、不注入 AGENTS.md / 记忆 / 认知索引、只读、不跨启动
  （`ai-session-scope.js:88`、`ai-system-context.js:363`）——harness 的现成模板，但它是「一次性」的。
- **无工作区会话**（仓库工作区正在落地，未提交）：持久、不绑工作区、不注入工作区知识、不显示「临时」徽标
  （`ai-session-scope.js:92-98` 的 `isNoWorkspaceSession`，配 `ai-no-workspace-session.test.mjs`）。
  这是需求②「未绑定会话」的**已有实现基础**，§4.4 据此调整。
- **浮窗**（`--ai-float`）今天就是「无工作区窗口」，于是 `getScopeRoot()` 为空/仅活动文件目录，
  相对路径工具直接报「当前没有工作区范围」（`ai-panel.js:6966`）——只有完全权限档用绝对路径可用。

### 1.5 作用域根的其它消费者（初稿漏了，评审补出）

「范围根」不是一个纯函数能换掉的取值，它是**几十处调用时现取**的活状态。除 §1.3 的 7 条，还有：

| 消费者 | 今日取根 | 换手后的错位 |
|---|---|---|
| 隔离 worktree 全生命周期（建/统计/丢弃/写闸） | `frontend/src/ai/tools/ai-worktree.js` 15 处 `getScopeRoot()`（`:505,506,535,825,867` 等） | 换手后建/删/统计落到新仓库；`GitWorktreeRemove` 可能删同名隔离区，真隔离区未导出改动没存档 |
| 技能来源与缓存 | `ai-panel.js` 的 `resolveSkillDirs`（`project = aiProjectRoot()`）+ `skillsCache` 单槽 | A 仓库的 `.cadt/skills` / `.agents/skills` 喂给 B 仓库的会话 |
| 认知 overview 预取缓存 | `frontend/src/ai/settings/ai-cognition.js:192`（`let cache = {ws:'', snapshot:null}` 单槽） | 两个工作区会话交替起轮时索引块静默消失 |
| 计划模式批准的「命令放行规则」cwd | `frontend/src/ai/tools/ai-tool-cards.js:1856`（`cwd = getScopeRoot()`，为空则整段跳过） | harness 下规则落不下，执行 cwd 却用会话根 → 同一批命令重复弹审批 |
| 生成产物 / 语音产物 / 补丁落盘 | `ai-panel.js:9832`（`generate_image`）、TTS、`propose_patch` | 空根直接报「无法保存生成产物」；异步完成时记录的路径可能指向换手后的仓库 |
| Git 面板与「变更卡撤销」 | `bridge-git.js` 的 `gitRootDir()`、`gitRollbackPaths`（**不接根**）、`git-graph.js` | 撤销打到错的仓库 |
| 群聊（多智能体）的 workspace | `frontend/src/main.js:4402`（`getWorkspace: () => workspaceFolder || ''`）→ 写进群 meta，成员工具边界据此钳 | harness 下群 workspace 为空，成员工具被钳到空根 |
| 崩溃自愈的工作区段 | `window_host.go:110`（每次 `WindowRegister` 调 `runCrashWorkspaceRecovery`） | 仅崩溃后首轮、按根去重，与今天打开工作区同语义（不是换手新增风险，但要在方案里写明） |

## 2. 目标形态

> **v6 模型修正（2026-11-25，参考 opencode / pi / ZCode / codex / cline / deepseek-harness）**：
> 六个参考实现**没有一个**采用「窗口绑定工作区」，全部是「**会话自带 cwd / roots，窗口只是视图**」
> （opencode `Session.location`、pi `SessionHeader.cwd`、ZCode `workingDirectory`、codex `environments[]`、
> cline `SessionWorkspaceConfig.cwd`、deepseek `header.cwd` + `workingDirectory` 投影）。
> 因此本方案不再在「窗口持有根」上打补丁，改为：**窗口不持有根，只投影当前会话的根**；
> 原「窗口级写权占位」一并撤销（六家无一先例，并发安全改由「会话租约 + 路径级策略」承担）。

```
① 普通模式：窗口根 = 当前会话根的投影（两者恰好相等，保持今天一目录一窗口的体验）

   窗口（无独立根状态）
     └─ 会话 · ws1 ──▶ 作用域 ws1 ──▶ 树 / 监听 / Git / 上下文 / 工具 / 规则 / 记忆 / 认知
   换手 = 让窗口投影另一个会话的根 + 恢复该工作区的标签快照

② harness 模式：同一套模型，只是不强求「窗口根唯一」

   窗口（永远不持有根）
     ├─ 会话 A · ws1 ──▶ 作用域 ws1
     ├─ 会话 B · ws2 ──▶ 作用域 ws2
     └─ 未绑定会话   ──▶ backing workspace（应用数据目录下的会话沙盒根，见 §4.4）

   写边界：写根 = 会话根 + 显式附加可写根；越界走升权审批（§4.6），不做窗口级占位
```

**推论**：`scopeRootOf(session)` 是唯一的根来源；`windowWorkspace()` 降级为「当前会话根缓存」，
仅供少数非 AI 的窗口级 UI（标题徽标、窗口切换器）显示用。

## 3. 需求 A：窗口内无缝切换工作区

### 3.1 语义定义（v6：窗口不持有根，无写权占位）

- **根归属**：根属于会话（`session.workspace`，已是磁盘真源，`internal/sessionstore/sessionstore.go:272`）；
  窗口只缓存「当前投影的根」，不再拥有独立语义。
- **换手（handoff）**：让窗口投影目标会话的根 —— 保存当前工作区快照 → 打开新工作区（前端状态落地）
  → 恢复目标工作区快照 → 切到目标会话。**不再有「抢占写权」这一步**。
- **不做窗口级写权占位（推翻 v3 决议）**：六个参考实现里都没有这种东西；
  codex 用 `entries[{path, access: Read|Write|Deny}]` + `writable_roots`，deepseek 用
  `read-only / workspace-write / danger-full-access` 三档，opencode 用「内部免审 → external 审 → read/edit 审」。
  并发安全由两件事覆盖：**同一会话的回合租约**（已有，`lease_service.go:60-120`）+ **路径级写边界**（§4.6）。
  **副产品**：今天「同一仓库不能被两个窗口打开」的硬限制（`IsWorkspaceOpen`）随之解除，
  同仓库两窗口写冲突交给 git——这与六家的取舍一致。
- **仍然原子的部分**：`WindowRegister` 的登记写入要保证「最后一次生效」，
  避免快速换手时旧值覆盖新值（前端用序号作废，见 §4.7 第 3 条）。
- **窗口身份**：`Spec.Workspace` 保留，语义变为「当前投影的根（只读用途：路由 / 复用匹配 / 标题）」，
  不承载权限语义；无需新增 `ReadWorkspaces` / `ClaimWorkspace` / `WindowTryClaimWorkspace`。

### 3.2 入口

| 入口 | 行为 |
|---|---|
| 会话列表点其他工作区分组的会话 | 按设置项：`new-window`（默认，现行为）/ `in-place`（原地换手并切到该会话） |
| 工作区分组头「⋯」菜单 | 新增「在当前窗口打开此工作区」 |
| 菜单「文件 → 最近打开」 | 每项加二级「在当前窗口打开」 |
| 命令面板 | 新命令 `workspace.switchInPlace`（进菜单即自动可搜，参照 `paletteActions`） |

设置项 `workspaceOpenMode`（`new-window` 默认 / `in-place`）：**行为偏好**，跨窗口同步，
不进 `PER_WINDOW_LAYOUT_KEYS`（`frontend/src/settings/settings-sync.js:61`）。

### 3.3 切换编排（顺序即正确性）

```
switchWorkspaceInPlace(dir, sessionId):
  1. 同一根 → 直接 return（openFolderSmart 的等价判定，main.js:3513）
  2. 目标已开在别的窗口？
     ├─ 是 → WindowFocusByName + 投递会话，return 'reused'（保持今天的复用语义，不做抢占）
     └─ 否 → 继续
  3. targetSnapshot = readWorkspaceSession(dir)  // 必须在切换前读，避免防抖保存覆盖
  4. 若当前会话有进行中的回合 → 见 §3.4 的根冻结/禁止换手守卫
  5. openFolderWorkspace(dir)                    // 前端状态落地（树/监听/Git/便签/面包屑）
  6. applyWorkspaceSnapshot(targetSnapshot)      // 新函数，见 §3.5
  7. 切到 sessionId（若有）→ syncActiveSessionUI
  8. 注入根变更记录（§3.3.1）→ 下次起轮落盘
  9. wipe-guard 基线按新根重设（见 §3.5）
```

注意第 2 步只是**体验选择**（避免同一仓库开两个窗口），不是权限门槛；用户坚持要开第二个窗口时允许，
写冲突由 git 与路径级审批兜底。

#### 3.3.1 根变更必须写进对话历史（v6 新增）

`opencode` 在目录变更时注入一条 user 消息 `The working directory has been changed to X.`
（`packages/core/src/session/runner/to-llm-message.ts:252-259`）；deepseek 把有效工作目录做成
可校验、可回放的 `workingDirectory` 投影（`packages/session/working-directory/src/index.ts:113-127`）。
**不写进历史的后果**：换手后模型仍按旧根推理（“我刚读的文件在哪”“为什么这里没有这个文件”），
表现为无故怀疑文件被删。

做法：
- 换根成功后在会话上挂 `pendingRootChange = {from, to, at}`，随下一次起轮的 `<system-reminder>` 注入
  `<workspace-context-change from="…" to="…">`，并说明「已打开文件的旧路径仍可用，但相对路径从现在起按新根解析」。
- 同一会话连续换根只保留最后一条（避免刷屏）；切回原根时清除。
- 该块与 §4.3 的 `<workspace_context>` 同属动态块，不进系统提示词（不击穿前缀缓存）。

**时序坑一（必须写测试）**：`openFolderWorkspace` 末尾调 `aiPanel.refreshSessionList()`（`main.js:3498`），
它内部是 `adoptWorkspaceSession()`（`ai-panel.js:19766`）——会把面板自动切到新工作区「最近更新的会话」，
甚至在目标工作区没有会话时**新建一个空会话**。所以第 7 步必须在第 5 步之后显式 `setActiveSessionId(目标会话)`，
并清理 adopt 可能产生的空会话（复用 `isVirginSession` / `discardVirginOnLeave` 的既有语义）。

**时序坑二（评审发现，最严重）**：`aiResolveScopePath` 每次工具调用**现取窗口根**
（`ai-panel.js:6959`，命令 cwd 走 `commandCwdOf`）。若用户在 A 仓库会话跑长回合期间换手到 B，
后续 `write_file` / `edit_file` 的相对路径、`run_command` 的 cwd、`isAutoWriteRisky` 的相对判定、
worktree 的建/删/统计**全部落到 B 仓库**。因此：**换手不得与「工具根改会话」拆开上线**（见 §5）。

### 3.4 进行中回合的处理（拍板：两段式 B → A）

**定稿**：P1 先用 B 兜底，P2a 落地「回合根冻结」后自动升级为 A。两段都是定案，不是二选一。

| 阶段 | 做法 | 依据 |
|---|---|---|
| P1（B） | 目标/当前会话有 `stream` / 压缩 / 活跃子代理时**拒绝换手**，提示「当前会话正在运行，结束后再切换」 | 复用现有 `busy` 语义（`ai-session-scope.js:126`），一行判定，零新概念 |
| P2a（A） | 起轮时把根冻结进工具上下文（`ctx.scopeRoot = scopeRootOf(session)`），整回合不再现取；`busy` 判定从「换手」收窄为「禁止同会话并发」 | §4.2 本来就要把取根点改成会话根，冻结是顺带的 |

**A 的验收**：会话 A（ws1）跑长回合期间换手到 ws2，A 继续在 ws1 完成（写文件、`run_command` 的 cwd、
worktree 建删都在 ws1）；切回 A 能看到完整进展。
**观感要求**：A 在后台跑时，会话列表行显示 running，切换后不得出现「AI 好像停了」的错觉（复用现有 running 角标）。

### 3.5 标签与快照策略

- 现状 `restoreSession` 两个限制要改：跨工作区快照直接拒绝（`session-restore.js:243`）、
  只有「本窗口没有工作区」时才切根（`:249`）。新增 `applyWorkspaceSnapshot(dir, snapshot)`：
  - 目标工作区有快照 → 复用**当前分组**打开其中的文件（`openPathsHere` 只往 focused group 加，
    不新建分组，避免每切一次多一个分屏）；
  - 无快照 → 不动标签，仅在面包屑与树上体现新工作区。
- **旧工作区的标签：保留（拍板定稿）**，但必须同时做两件事，缺一不可：
  1. 标签加「工作区外」标记——监听根已换，这些文件不再接收外部变更事件；
  2. `<workspace_context>` 按归属**分层渲染**（§4.3）：活动文件始终注入、本根全列、其它根折叠成无路径摘要、
     虚拟标签不过滤。**这是保留策略的前置条件**——不做的话跨仓库标签会污染上下文，做了则保留无副作用。

### 3.6 切换遗漏点（`openFolderWorkspace` 目前不处理）

| 遗漏 | 后果 | 对策 |
|---|---|---|
| 目标工作区快照未恢复 | 换手后看不到该工作区上次的标签 | §3.5 新函数 |
| **进行中回合的根** | 写错仓库（§3.3 坑二） | §3.4 方案 A/B，且与 P2a 同批 |
| wipe-guard 是单根状态机 | 换根即清基线与 watcher 窗口；周期校准取 `getWsRoot()`，harness 下为空即长驻保护静默失效；`preCommand` 的根与 `postCommand` 的根可能分属两个仓库 | 控制器改按根的 Map；`preCommand` 返回值带上取指纹时的根，`postCommand` 复用它（`ai-wipeguard.js:341,361,370,397`） |
| 技能缓存 / 认知预取缓存单槽 | 交替会话时串根或索引块消失（§1.5） | 缓存改按 `workspaceKey` 的 Map |
| `.cadt` 生命周期钩子每次切换都跑 | 钩子可能跑 npm install 一类重活 | 换手路径跳过 workspace-close / workspace 事件，或加最小间隔节流 |
| 监听根切换 | 旧工作区标签收不到外部变更 | 接受（标签标「工作区外」）；或给活跃文档目录补 `ResourceWatcher` |
| 终端 / 运行配置 / Maven / DB / Git 面板 | 仍停在上一个工作区；Git 撤销可能打错仓库 | 统一提示「已切换工作区」；`gitRollbackPaths` 显式带根 |
| 崩溃自愈工作区段 | 崩溃后首轮进入某工作区会清它的 `.cadt/tmp` / `.cadt/logs` | 与今天打开工作区同语义（按根去重、仅崩溃后首轮）；**harness 不登记则不会触发**，但别的窗口登记同一根时会清掉 harness 正在用的 tmp —— 需在 §4.5 说明 |
| 旧工作区有未保存改动 | 换手不应丢改动 | `saveSessionNow` 只存布局；换手前若有 dirty 文档须提示 |

## 4. 需求 B：无工作区 harness

### 4.1 核心：唯一根来源

```
scopeRootOf(session):
  1. session.workspace 非空        → 用它（会话真源，磁盘已按它分桶）
  2. 会话标记 noWorkspace          → backingWorkspace(session)（§4.4，应用数据下的沙盒根）
  3. harness 窗口且会话未绑定      → ''（无根；工具只读 + 绝对路径，见 §4.4 兜底）
  4. 否则                          → windowWorkspace() || activeFileDir()   ← 兼容旧行为

windowWorkspace() = 当前会话根的投影缓存（不再是独立状态；仅供标题徽标 / 窗口切换器显示）
activeFileDir()   = 活动文件父目录（今日 getScopeRoot 的兜底，只在第 4 步生效）
```

**v6 关键改动**：第 1 步优先会话根，窗口根只是第 4 步的兜底。普通模式下两者恰好相等
（`syncWorkspaceToSession` / `bind` 保证），所以对现有会话零行为变化；harness 下第 1 步就命中，
窗口根完全不参与。

**必须拆两层**：今日 `getScopeRoot()` = `workspaceFolder || 活动文件父目录`（`main.js:4263`）。
若 `scopeRootOf` 直接复用这条兜底，harness 下「未绑定会话」会把用户当前点开的标签父目录当成作用域根——
AI 的作用域随标签漂移，AGENTS.md / 记忆 / 项目规则跟着读错仓库。

### 4.2 调用面改造

| 位置 | 现状 | 改法 |
|---|---|---|
| `aiResolveScopePath(value, session)` | 收 `session` 却用窗口根（`ai-panel.js:6959`） | `scopeRootOf(session)`——覆盖读写 / 扫描 / 命令 cwd 大半 |
| `resolveScanRoot` 默认根 | 窗口根 | 同上 |
| `aiProjectRoot()`（`:6800`） | 无参 | `aiProjectRoot(session)`；AGENTS.md / 记忆 / 项目规则 / worklog 四处改传会话 |
| `resolveMemoryDir()`（`:7142`） | 无参，**失败静默回落应用数据目录** | `resolveMemoryDir(session)`；harness 下**禁止回落**（回落＝两个仓库记忆混一份），对话框显示「跟随当前会话」 |
| `ensureProjectRules(force)`（`ai-permission-settings.js:711`） | 无参 | 读侧加 session；**写侧与设置面一起改**（`saveProjectRules` / `addProjectRule` / `projectRulesPath` / 权限页显示），否则 harness 下看不到、改不了、存不了规则 |
| `resolveSkillDirs` + `skillsCache` | `project = aiProjectRoot()`，缓存单槽 | 按会话根扫描；缓存按 `workspaceKey` 分桶 |
| 认知 `cognitionWorkspace()` / overview 缓存 | 窗口根 / 单槽（`ai-cognition.js:192`） | scope 自动跟随；缓存按 `workspaceKey` 的 Map |
| `subSandboxPolicy(ctx.session, getScopeRoot())`（`:11903`） | 混用 | `scopeRootOf(ctx.session)` |
| `wipeguard.preCommand(getScopeRoot())`（`:11927`，另有 `:12004` 的 post） | 窗口根 | 前后用同一个根（取指纹时冻结） |
| `ai-worktree.js`（15 处） | 窗口根 | 会话根 / `wt.path`；`removeWorktreeNow` 先断言「根与会话归属一致」，不一致拒绝 |
| 生成产物 / TTS / `propose_patch` / `recordChange` | 窗口根 | `scopeRootOf(ctx.session)`；`recordChange` 用 plan 里存的根 |
| `gitRollbackPaths` / `gitRootDir` / `git-graph` | 窗口根，撤销不接根 | 显式带根，取会话根 |
| 群聊 `getWorkspace`（`main.js:4402`） | 窗口根 | 群创建时选/沿用发起会话的工作区；或 harness 下禁用并说明 |
| 计划模式命令放行规则 cwd（`ai-tool-cards.js:1856`） | 窗口根，空则跳过 | 用会话根（与执行 cwd 同源），否则 harness 下批次豁免等于没有 |

**必须显式传 `ctx.session`，禁止取「当前显示的会话」**：后台会话（会话 A 在跑命令、用户已切到会话 B）
在 harness 下会立刻串根，审批卡 / 指纹快照 / cwd 全错位。

### 4.3 上下文注入改造

| 块 | 改法 |
|---|---|
| `<workspace_rules>` 范围根行（`ai-system-context.js:24`） | 用会话根；未绑定会话写「（本会话未绑定工作区）」 |
| `<workspace_context>` 的**活动文件** | **始终注入**（路径/光标/选区/视口），跨会话根时追加一行「属于其它工作区，读取需授权」；路径经 `aiDisplayPath(path, 会话根)` 自动脱敏成「（范围外）名」，不泄露盘符结构 |
| `<workspace_context>` 的**本会话根已打开文件** | 全列（≤20），相对路径——与今天单仓库行为逐字一致 |
| `<workspace_context>` 的**其它工作区已打开文件** | **折叠为一段摘要**：工作区数 + 文件数 + 最多 3–4 个文件名，**不给可解析路径**（`aiDisplayPath` 的「（范围外）名」形态天然如此）→ 保留「还有别的东西开着」的信息，同时不触发 auto 档静默跨仓读 |
| `<workspace_context>` 的**虚拟标签页** | **不按工作区过滤**，保持全列（上限 12）——`appTabViewOf` 只返回 `{label,name,desc}`，浏览器/便签/应用页面/数据库表都没有 workspace 归属，过滤只会漏 |
| 跨根活动文件的读取 | 视为**用户点名**（`userNamedPath` 同语义），不弹审批——用户正看着它，问「这个文件」必须能读；摘要里的文件不算点名，要读走审批 |
| `redactToolText`（`ai-panel.js:7744`） | 脱敏基准同样换成会话根，否则会话根 ≠ 窗口根时脱错 |
| `AGENTS.md`（`:413`）、`<memory>`（`:427`）、认知守则（`:549`） | 随会话根 |
| 临时会话块（`:363`）/ 无工作区会话块（`:375-382`） | 复用为「未绑定会话」块，措辞统一为「未绑定工作区」 |

**为什么不是「按工作区过滤」（v3 复议结论）**：
1. `getWorkspaceContext().openFiles` 有第二个消费者——`ai-panel.js:5202` 的 `pickOpenFileMatch`
   用它把回复里的裸文件名解析成可点击芯片；数据源若过滤，跨工作区引用会退化成普通文本。
   （`ai-composer.js:645` 的 `attachCurrentFile` 也读同一字段。）
2. 虚拟标签页没有 workspace 归属，过滤只会漏掉它们。
3. 活动文件被过滤时，模型就不知道用户在看什么——而这正是 `<workspace_context>` 的立身之本。
**因此：数据源 `getWorkspaceContext()` 保持返回窗口全量事实，只在渲染层（本节）按归属分层。**

前缀缓存：系统提示词里的根行随会话变——每个会话本来就有各自的提示词，切换不击穿缓存；
但**同一会话内换工作区**会击穿一次（只有 §3.4 方案 C 才会发生）。

### 4.4 未绑定会话语义（v6：backing workspace，不再「只读 + 绝对路径」）

参考实现的做法（六个里三个支持、三个不支持）：

| 实现 | 做法 | 证据 |
|---|---|---|
| ZCode | backing workspace `<data>/.zcode/workspace/default`，`workspacePurpose="conversation"`、`selectedProject=null`；**仍给真实 cwd**，隐藏 Git 分支选择器，删 tab 不删目录 | `docs/superpowers/specs/2026-07-10-non-project-conversation-workspace-design.md:5-13,97-113` |
| cline | 共享 chat workspace `~/.cline/data/workspaces/chat` + 礼仪 `AGENTS.md`（要求「chat first，不要在顶层散落文件」） | `sdk/packages/core/src/services/workspace/chat-workspace.ts:CHAT_WORKSPACE_RULES` |
| deepseek | `header.cwd` 可空，但这类会话不能入 workspace 组，运行时用 `defaultCwd` 兜底 | `packages/session/session-format/src/types.ts:20`；`packages/workspace/workspace/src/entity.ts:130-134` |
| opencode / pi / codex | **不支持**（强制 project / 强制 cwd） | `packages/core/src/location.ts:22-32`；`session-manager.ts:43-50`；`protocol/src/environment.rs:24-29` |

**定稿**：我们的 `noWorkspace` 从「只读 + 绝对路径」改为 **backing workspace**——

- 根 = `<应用数据>/ai-workspaces/<sessionId>/`（每个未绑定会话一个隔离目录，或按需共享 `chat` 单目录）；
- 该目录**可读可写**，工具的相对路径语义正常（不再需要绝对路径）；
- 天然隔离：里面没有 `AGENTS.md` / `.cadt` / git，所以「不注入工作区知识」自动成立，无需特殊分支；
- 落一个礼仪 `AGENTS.md`（同 cline）：说明这是会话沙盒、不要在此长期存放项目文件、需要写真实仓库时请先绑定工作区；
- UI：输入区显示「会话沙盒」胶囊（不再是「未绑定工作区」），提供「绑定到工作区」一键动作。

| 项 | 今日 | v6 定稿 |
|---|---|---|
| 标记与持久化 | `isNoWorkspaceSession` 已存在 | 确认已合入并进 `test:ai` 清单 |
| 上下文注入 | 已有「不注入工作区知识」块 | 保留该块但改措辞：根是会话沙盒，工具可用，不要当项目目录 |
| 工具 | 只读 + 绝对路径 | **读写皆可**，根 = backing workspace |
| **新建会话默认行为** | — | 仍**弹选择器（最近工作区 + 打开文件夹 + 会话沙盒）**，三选一，不静默 |
| 入口 | 「⋯ → 新建无工作区会话」 | 改名「新建会话沙盒」，保留为显式入口 |
| 点已有会话 | 会话自带 workspace | 不需要选择器，直接按其 workspace 起轮 |

### 4.5 窗口形态与启动

- 启动参数 `--harness`（与 `--new-window` 组合）：开主窗口但**不恢复工作区**。
- 必须同时跳过「自动采纳上次工作区」：`bridge-ui.js:286`（无 target 时的 `readSession()` 恢复）
  与 `session-restore.js:249`（快照 workspace → `openFolderWorkspace`）。
- **harness 不得写共享单槽 `cadt.session.v1`**（`session-restore.js:13`）：该槽是多窗口共享，
  空 `workspace` 的快照在读取侧**不做归属校验**（`:243` 只在 `sess.workspace` 非空时校验），
  会让 harness 的布局被普通窗口下次启动恢复、或反过来抹掉普通窗口的标签。
  做法：harness 用独立 key（或按会话 id 分槽），并把 harness 加进 `auxWindowNoSession()` 的豁免分支（`:152`）。
- `WindowRegister('')`：`FindByWorkspace` 对空 workspace 直接返回 nil（`internal/windowreg/windowreg.go:341`），
  「不占有」本身不需要 Go 改动。**但**所有「按工作区找窗口」的路径都看不见 harness，会绕开它再开一个窗口：
  `--ai-session` 的 `sessionOpen`（`app_core.go:317` → `openMainWindow`）、`WindowReuseForSession`、
  启动时的会话恢复（`bridge-ui.js:306` 要求 `session.workspace == deps.workspaceFolder`，harness 下恒假）。
  → 至少让 `sessionOpen` / 复用探测命中 harness 时**投递会话**而不是开窗；必要时在 `WindowList` 暴露会话工作区。
- 侧栏：文件树根跟随当前会话根（标题栏显示工作区徽标）；或切到「应用页面 / 会话」面板。
  **注意**：一批以 `workspaceFolder` 判可用性的入口不会自动跟着会话走——
  新建文件/文件夹（`shell/properties-ui.js`）、临时文件（`core/scratch.js:50`）、拖文件进树复制
  （`shell/file-drop-router.js`）。建议收口一个 `currentTreeRoot()` 供它们读，否则 harness 的文件区只是只读展示区。
- `WindowList` 只在 `workspace != ""` 时下发字段（`app_window.go:61`），harness 窗口在窗口切换器里没有仓库信息
  → 增加「无工作区（会话：ws2）」这类三态展示。
- 若刻意做成「窗口形态」持久化：该键属窗口自身形态，**必须登记 `PER_WINDOW_LAYOUT_KEYS`**
  （`settings-sync.js:61`），否则别的窗口会把 harness 态镜像过去。

### 4.6 并发与安全（v6：路径级策略，无窗口级占位）

参考实现的做法（六家一致：**没有窗口级写权占位**）：

| 实现 | 越界/写边界机制 | 证据 |
|---|---|---|
| codex | `entries[{path, access: Read\|Write\|Deny}]` + `writable_roots`；`deny > write > read`；越界升权审批 `Allow writing outside the workspace` | `codex-rs/protocol/src/permissions.rs:131-146`、`:109-113`、`:1361-1400`；`core/tests/suite/permissions_messages.rs:912` |
| deepseek | 三档 `read-only / workspace-write / danger-full-access`；`workspace-write` 允许 root + 显式附加可写根 + 平台临时目录；拒绝返回 `FS_SANDBOX_DENIED` + 一次升权重试提示 | `packages/fs/fs-sandbox/README.md:12,28,48,52` |
| opencode | 内部免审 → `external_directory` 审 → `read`/`edit` 审 | `packages/core/src/file-access.ts:114-130` |
| ZCode | 当前**不硬阻断** workspaceRoot 外路径（等权限适配器）—— 反面教材 | `apps/zcode-cli/packages/core/src/tool/path-policy.ts:36-39` |
| pi | 越界静默允许 —— 反面教材 | `packages/coding-agent/src/core/tools/path-utils.ts:38-43` |

**定稿**：

- **不做窗口级写权占位**（推翻 v3 决议）：不新增 `ClaimWorkspace` / `ReadWorkspaces` / 接管语义，
  不改 `windowreg` 的权限含义。并发安全由下面三层覆盖：
  1. **同一会话的回合租约**（已有，`lease_service.go:60-120`）—— 防 2026-11-21 的「同会话双开覆盖」；
  2. **路径级写边界**：写根 = 会话根 + 显式附加可写根（对齐 codex `--add-dir` / deepseek 附加可写根）；
  3. **越界升权审批**：越界写走已有的写审批链（`applyWorkspaceWrite` 的确认卡），不新造机制。
- **读边界不变**：`resolveReadPathWithApproval` 的四层判定原样保留（应用数据硬拒 → 点名/已批准根 →
  auto 直读 → read/edit 弹卡）。harness 只是把「根」从窗口换成会话。
- **同仓库两窗口并发写**：从「被禁止」变成「允许、冲突交给 git」。这与六家取舍一致；
  真正的数据丢失风险是「同会话双开」（租约已挡），不是「同目录双写」。
- **应用数据目录硬拒**、`.cadt/cognition` 直写拒绝等既有硬规则不受影响。
- **会话租约与写边界不互相替代**：租约管「同一会话」，路径策略管「同一目录」，两者都要。

### 4.7 性能预算与「轻量换根」（v5 新增）

**结论先行**：harness 下切会话**会卡**，但卡点不是「换工作区」本身，而是「把切会话等同于重开工作区」这个实现选择。
单次换根的重活全是 async、`explorer.setRoot` 只读一层、指纹有硬预算，所以不会卡死；问题是**重复**。

成本分档（代码依据，非实测）：

| 档 | 项 | 依据 / 成本上限 |
|---|---|---|
| 轻（毫秒级，每次可跑） | 目录树换根 | `explorer.js:891` `setRoot` 只 `tree=null` + `ensureTree()` 读一层 |
| 轻 | 认知卷 / 技能目录 / AGENTS.md / 记忆 / 项目规则 | 几个 `readdir` / `readFile` |
| 中（数十 ms ~ 数秒） | `git status` | **无内建上限**，取决于仓库规模，是主要波动源 |
| 中 | wipe-guard 结构指纹 | 有硬预算：`fingerprint.go:31-37` 200ms 墙钟 + 5 万条目，超限降级 `Sampled` |
| 中 | 文件监听注册 | `ReadDirectoryChangesW` 一次调用（`watch.go:75`），注册快；但大仓库事件洪峰会持续推 `workspace-changed` |
| 中 | 会话正文懒加载 | `_stub` 机制保证切回已加载的不重读；大会话首读可达秒级（上限 256MB） |
| 重（无上限） | 工作区生命周期钩子 | `main.js:3504` → `runForWorkspace` 真跑用户配的命令（如 npm install） |
| 重 | Maven 扫描 + 全量 `applySettings` 重绘 | 随每次换根触发 |

**必须先立的三条设计**：

1. **轻量换根 `switchRootLight(dir)`**：会话切换引起的根变更只做「切根 + 轻刷」（树、面包屑、标题、监听换根、
   当前会话上下文），**不重跑钩子、不强制刷 git / 指纹**；中档项改为「标脏 + 空闲刷新」。
   `openFolderWorkspace` 保留为「真正打开工作区」的完整路径（对话框 / 最近打开 / 启动恢复）。
2. **重活按工作区去重**：进程级 `openedWorkspaces` 集合；同一工作区在一次应用运行内，
   `runForWorkspace`（open 钩子）、首次 git status、首次指纹基线**各只执行一次**——
   **换手（P1）同样受这条约束**：切回之前开过的工作区不重跑钩子，只做「标脏 + 空闲刷新」。
   `lifecycle-hooks.js` 现有 `runningByWs` 只防并发（`runEntries` 内），不防先后重复，需在其上加一层幂等。
3. **换手序列化**：快速连点多个会话只处理最后一次——复用 `ai-panel.js` 的 `switchSeq` 模式
   （`switchSession` 已有 `mySeq !== switchSeq` 作废机制），换手入口同样要带序号，避免叠加刷新。

**不做的**：不给 git / 指纹加"后台轮询"，那会把抖动换成持续 CPU；只用「标脏 + 用户看到时刷」。

## 5. 分期实施（v6 重排）

> 两条硬约束：① P1 换手会让**进行中回合**的根漂移，必须与 P2a 同批；
> ② v6 撤销了窗口级写权占位，P1 因此不再需要 Go 侧新增绑定，工作量下调。

| 期 | 内容 | 验收 | 参考工作量 |
|---|---|---|---|
| P0 | 纯函数 + 测试：`windowWorkspace` / `activeFileDir` / `scopeRootOf`（四步解析）、`decideSessionOpen` 新分支 `switchInPlace`、`workspaceOpenMode` 归一 | 新测试进 `npm test` 清单 | 0.5 人日 |
| P1 | 换手骨架：`switchWorkspaceInPlace`（无 claim 步骤）+ 三处入口 + `applyWorkspaceSnapshot` + **`busy` 拒绝换手兜底** + **根变更注入（§3.3.1）** | 换手后落到目标会话；回合进行中被拒并提示；换手后下一次起轮带 `<workspace-context-change>` | 1 人日 |
| **P2a** | **工具侧根改会话**（必须随 P1 交付）：`aiResolveScopePath` / 两处 `aiRelPath` / `resolveScanRoot` / `commandCwdOf` / `isAutoWriteRisky` / `ai-worktree` / Git 撤销 / 生成产物落盘 / 计划审批规则 cwd；**回合根冻结**（B 升级为 A） | 换手期间进行中回合仍写原仓库；worktree 建删不串根 | 1.5 人日 |
| P2b | 上下文与状态改会话根：AGENTS.md / 记忆（禁回落）/ 项目规则读写两侧 / 技能 + 缓存 / 认知预取缓存 / wipe-guard 按根 / 群聊 / **§4.3 分层渲染** | 两个工作区会话交替起轮，上下文与缓存互不串味；其它工作区折叠为无路径摘要 | 2–3 人日 |
| P3 | harness 模式：`--harness` + 不恢复 + 独立快照槽 + 侧栏跟会话 + **backing workspace（§4.4）** + 新建会话三选一选择器 + CLI 投递兼容 + **轻量换根 `switchRootLight` + 重活按工作区去重 + 换手序列化（§4.7）** | 开 harness 窗口点两个工作区会话，工具根 / AGENTS / 记忆 / 规则各自正确；会话沙盒可读写且不污染仓库；连续切 10 个不同工作区会话，git status 与 open 钩子各最多执行 1 次 / 工作区 | 2.5 人日 |
| P4 | 回归：复用投递、`--ai-session`、CLI 路由、会话租约、wipe-guard、会话恢复、崩溃自愈、**同仓库双窗口写** | 见 §7 | 1–2 人日 |

**最小可交付切片 = P0 + P1 + P2a**（约 4 人日）：换手 + 工具根改会话 + 回合根冻结，
已能在不写错仓库的前提下拿到「点会话不再满屏新窗口」的收益。P2b 与 P3 分开评审。

## 6. 决议表（2026-11-25，v6 修订）

| # | 议题 | 决议 | 落地位置 |
|---|---|---|---|
| 1 | 单打开者不变量 | **撤销窗口级写权占位**（v6 推翻 v3）：六家参考实现无一先例；并发安全改由「会话租约 + 路径级写边界 + 越界升权审批」覆盖。`IsWorkspaceOpen` 退回为纯体验守卫（避免同仓库开两个窗口），不再是权限门槛 | §3.1、§4.6 |
| 2 | 换手时进行中的回合 | **两段式**：P1 用 B（`busy` 拒绝换手）兜底；P2a 落地回合根冻结后升级为 A（回合在原点继续跑完） | §3.4、P1 / P2a |
| 3 | 换手时旧标签 | **保留** + 标「工作区外」 + `<workspace_context>` **分层渲染**（v4 修正：不是过滤） | §3.5、§4.3、P2b |
| 4 | harness 新建会话 | **三选一选择器**（最近工作区 / 打开文件夹 / 会话沙盒），不静默；会话沙盒是 backing workspace，可读写 | §4.4、P3 |
| 5 | 根归属模型（v6 新增） | **窗口不持有根**，`scopeRootOf(session)` 是唯一来源；窗口根降级为投影缓存（仅供标题/切换器显示） | §2、§4.1 |
| 6 | 换根写历史（v6 新增） | 换手后下一次起轮注入 `<workspace-context-change from to>`，避免模型按旧根推理 | §3.3.1、P1 |
| 7 | 未绑定会话形态（v6 新增） | 从「只读 + 绝对路径」改为 **backing workspace**（应用数据下的会话沙盒，可读写、天然隔离） | §4.4、P3 |

**后续若出现新分歧**（实施中发现的语义冲突、性能上限、想要的交互不同），回到本文档追加决议并注明日期，
不要口头改方案。

## 7. 验证

- 单测：`frontend/test/ai/session/ai-session-scope.test.mjs`（`scopeRootOf` 四步解析 + 新分支）、
  `frontend/test/shell/session-restore.test.mjs`（`applyWorkspaceSnapshot`）、
  新增 `frontend/test/ai/session/scope-root.test.mjs`（会话根优先 / backing workspace / 两层兜底 / 路径归一对齐 Go 向量）。
  **新测试文件必须登记进 `frontend/package.json` 的对应 `test:*` 清单**（漏登记＝从没跑过）。
- 类型：改动 `frontend/src/core/*` 与纯逻辑文件加 `// @ts-check`，`npm run typecheck` 零错。
- 绑定面：v6 **不再新增 Go 绑定**（无 `WindowTryClaimWorkspace`）；若实施中新增了任何绑定，
  仍需 `go test -run TestAppBindingBaseline .` + `node scripts/gen-backend-types.mjs` + `dev/mock-backend.js` 补 mock。
- 构建门：`npm test`（含 typecheck 前置门）、`go build ./...`。
- 手工清单：
  1. 普通模式：会话列表点跨工作区会话 → 按设置项分别验证「新窗口」与「原地换手」；
  2. 目标工作区已开在别的窗口 → 前置并投递会话（不抢占）；
  3. 换手后：树 / Git / 监听 / 便签 / wipe-guard 基线是否都指向新根；
  4. **A 会话跑长回合（写文件 + run_command）期间换手到 B → 写仍落在 A**（P2a 的核心验收）；
  5. A 会话持有隔离 worktree 时换手 → 统计/丢弃不串根；
  6. harness 窗口：两个工作区会话各发一轮，检查系统提示词范围根、AGENTS.md 路径、记忆目录、
     `.cadt/permissions.json`（含设置页的写入口）、技能来源是否各自正确；
  7. harness 窗口的标签布局不写进共享槽（关掉 harness 后普通窗口启动仍恢复自己的）；
  8. `.cadt` 生命周期钩子在换手时不重复执行（或已节流）；崩溃自愈轮次首次进入新工作区的清理有日志。
- 决议对应的验收（缺一不可）：
  9. **回合保护**：P1 阶段会话有 stream 时点别的会话 → 拒绝换手并提示；P2a 之后同样操作应放行，
     且 A 的写文件 / `run_command` cwd / worktree 全程留在原仓库，切回 A 看到完整进展。
  10. **写者唯一**：harness 对一个已被别窗口持写权的仓库调 `write_file` → 拒绝并提示占用窗口名 +
     提供接管；接管后写入生效、原窗口转只读；只读浏览 / 搜索 / 贴补丁预览不受影响。
  11. **旧标签**：换手后旧标签带「工作区外」标记；`<workspace_context>` 里活动文件始终出现（跨根时带「属于其它工作区」
      标注），本根文件列相对路径，其它工作区**折叠为摘要且不给可解析路径**，虚拟标签页不受过滤影响；
      回复里提到的跨工作区裸文件名仍能解析成可点击芯片（`pickOpenFileMatch` 未受影响）。
  12. **新建会话**：harness 点新建 → 必弹选择器（最近工作区 + 打开文件夹），选完 `meta.workspace` 正确；
      显式「新建无工作区会话」→ 输入区显示「未绑定工作区」胶囊且工具只读。
  13. **性能（§4.7）**：harness 窗口连续切 10 个不同工作区的会话 —— `git status` 与 open 钩子
      **各最多执行 1 次 / 工作区**（应用运行内），其余为标脏 + 空闲刷新；快速连点 5 次只落地最后一次，
      树/面包屑/标题无中间态闪烁；切回已加载的会话不重读正文（`_stub` 命中）。

## 8. 明确不做

- 不做「一个窗口同时持有多个工作区登记」——登记唯一是路由 / 复用 / CLI 投递的共同前提。
- 不把工作区概念从窗口彻底移除（普通主窗口仍是一目录一窗口）。
- 不改审批与沙箱语义（harness ≠ 放宽权限）。
- 不为 harness 新造一套会话存储（复用 `session.workspace`、分桶与 `noWorkspace` 标记）。
- 不把「作用域根」做成「任意时刻现取的窗口值」——P2a 之后它必须是会话属性。

## 9. 评审发现与处置

两名只读子代理（事实核对 / 遗漏审查）的发现，逐条处置：

| # | 发现 | 处置 |
|---|---|---|
| 🔴1 | 换手会让进行中回合的根漂移（cwd / 写闸 / worktree） | **已采纳**：推翻「先只批 P1」，新增 P2a 与 §3.4 |
| 🔴2 | worktree 全生命周期挂在窗口根 | 已并入 §1.5 / §4.2 |
| 🔴3 | harness 会写共享单槽 `cadt.session.v1` | 已并入 §4.5 |
| 🔴4 | 单打开者守卫是 TOCTOU（查与登记分开、fire-and-forget） | 已并入 §3.1（新增原子绑定） |
| 🟡5 | harness 不登记 → CLI / 复用绕开它再开窗 | 已并入 §4.5 |
| 🟡6 | 崩溃自愈在登记时清工作区段 | **部分采纳**：仅崩溃后首轮、按根去重，与今天打开工作区同语义；已在 §1.5 / §3.6 写明，不按「每次换手都清」处理 |
| 🟡7 | 技能来源与缓存单槽串根 | 已并入 §1.5 / §4.2 / §3.6 |
| 🟡8 | 认知 overview 缓存单槽 | 已核实（`ai-cognition.js:192`）并并入 |
| 🟡9 | 项目规则写侧 / 设置面没有会话 | 已并入 §4.2 |
| 🟡10 | Git 面板与变更卡撤销不接根 | 已核实方向并并入 §1.5 / §4.2 |
| 🟡11 | wipe-guard 单根状态机（含 pre/post 跨仓库比较） | 已并入 §3.6 / §4.2 |
| 🟡12 | 生成产物 / TTS / 补丁 / `recordChange` 取窗口根 | 已核实（`:9832`）并并入 §4.2 |
| 🟡13 | 群聊 workspace 取窗口根 | 已核实（`main.js:4402`）并并入 §1.5 / §4.2 |
| 🟡14 | `scopeRootOf` 的「窗口工作区」含活动文件兜底 | **已采纳**：§4.1 拆两层 |
| 🟡15 | 记忆目录无会话 + 静默回落 | 已并入 §4.2 |
| 🟢16 | 以 `workspaceFolder` 判可用性的一批入口 | 已并入 §4.5 |
| 🟢17 | `WindowList` 在 harness 下无仓库信息 | 已并入 §4.5 |
| 🟢18 | 计划审批命令规则的 cwd 键 | 已核实（`ai-tool-cards.js:1856`）并并入 |
| 事实1 | `isTransientSession` 实际在 `ai-session-scope.js:88`（初稿写 96） | 已改 |
| 事实2 | wipeguard 的 `startCalibrationLoop` 在 361、`stopCalibrationLoop` 在 370、基线函数 341 | 已改 §3.6 / §4.2 |
| 事实3 | 单打开者守卫在 `session-restore.js:252`（初稿写 242） | 已改 §1.1 |
| 事实4 | main.js 行号整体 -5（基准漂移） | 已按当前树 `966cbf1` 修正 |
| 事实5 | 71 处中约 57 处是直接调用，其余为注入/透传 | 已补口径 |
| 事实6 | 仓库内已有 `noWorkspace` 会话实现（未提交） | **已采纳**：§1.4 / §4.4 改为「沿用 + 补齐」 |
| **v4 复议** | `<workspace_context>` 按工作区过滤会坏 `pickOpenFileMatch`（引用芯片）、漏掉无归属的虚拟标签、丢掉活动文件这个注意力锚点 | **改为分层渲染**（§4.3）：活动文件始终注入、本根全列、其它根给无路径摘要、虚拟标签不过滤；数据源不动 |
| **全局评估** | 隔离四层模型与 12 条不变量盘点（`docs/reports/workspace-isolation-audit.md`） | 分期不变；新增两条硬约束：`aiResolveScopePath` 与两处 `aiRelPath` 必须同批（路径与相对路径同源）；写者唯一按「写效应清单」而非「路径类工具」实现（记忆/工作日志无锁覆盖） |
| **v5 性能** | 切根成本三档 + 「切会话 = 重开工作区」会重复跑重活 | 新增 §4.7：轻量换根 / 重活按工作区去重 / 换手序列化；P3 → 3 人日 |
| **v6 参考实现** | 六家 harness（opencode / pi / ZCode / codex / cline / deepseek-harness）全部「会话自带根、窗口只是视图」；**无一有窗口级写权占位**；无工作区会话普遍用 backing workspace；换根普遍写进对话历史 | **四处修正**：§2/§4.1 窗口不持有根；§3.1/§4.6 撤销写权占位改路径级策略；§3.3.1 新增根变更注入；§4.4 改 backing workspace。P1 2→1 人日、P3 3→2.5 人日 |
| **v6 副作用** | 撤销写权占位后「同仓库不能双窗口」的限制解除 | 同仓库双写冲突交给 git；数据丢失风险仍由会话租约（I1）挡住，§4.6 已写明 |

### 参考实现对照（v6 调研摘要）

| 维度 | 六家做法 | 我们采纳 |
|---|---|---|
| 根归属 | 全部会话级（`Session.location` / `SessionHeader.cwd` / `workingDirectory` / `environments[]` / `SessionWorkspaceConfig.cwd` / `header.cwd`+投影） | 采纳：窗口不持有根 |
| 切换会话 | pi `switchSession` 按该会话 cwd 重建整套 cwd-bound services | 采纳：切会话即切作用域 |
| 根变更 | opencode 注入 `The working directory has been changed to X.`；deepseek 可校验可回放的 workingDirectory 投影 | 采纳：§3.3.1 |
| 无工作区 | ZCode backing workspace / cline 共享 chat workspace + 礼仪 AGENTS.md / deepseek 可空 cwd（不入组）/ opencode·pi·codex 不支持 | 采纳 backing workspace |
| 越界 | codex Read/Write/Deny + writable_roots + 升权审批；deepseek 三档沙盒；opencode 两级审批；ZCode 不硬阻断（反面）；pi 静默放行（反面） | 采纳路径级 + 升权审批 |
| 多根上下文 | codex 按 environment 标注 `for <id> with root <cwd>` | 采纳到 §4.3 分层渲染 |
| 「用户正在看的文件」 | **六家都没有**（只靠显式 @mention / 附件） | 我们已有 `<workspace_context>`，比六家强，保留并按归属分层 |
| 多根 mention（`@frontend:path`） | cline 有 | **不采纳**：单根会话更清晰，复杂度会扩散到搜索/提及/路径适配三处 |

## 10. 评估依据

只读核对范围（行号基于 `966cbf1`）：`frontend/src/main.js`（3467–3556、3652–3661、4222–4319、
4402、6049–6062）、`frontend/src/ai/ai-panel.js`（2344–2374、2491–2555、6800–6949、6958–7133、
7142–7154、7194–7208、9832、10160–10177、10601、11481、11896–11935、16432–16528、16666–16684、19766）、
`frontend/src/ai/core/ai-system-context.js`（24、242、363–382、413、427、549）、
`frontend/src/ai/session/ai-session-scope.js`（51、88–98、135）、
`frontend/src/ai/session/ai-session-list.js`（1–35、643–761）、
`frontend/src/ai/settings/ai-cognition.js`（192、198–213）、
`frontend/src/ai/security/ai-permission-settings.js`（686–751）、
`frontend/src/ai/agent/ai-subagents.js`（235–252、868）、
`frontend/src/ai/tools/ai-worktree.js`（271、505–506、535、825、867）、
`frontend/src/ai/tools/ai-tool-cards.js`（1848–1868）、
`frontend/src/shell/session-restore.js`（13、44、152、184–189、243、249、252–261）、
`frontend/src/bridge/bridge-ui.js`（257–323）、`frontend/src/settings/settings-sync.js`（52–76）、
`frontend/src/terminal/terminal-ui.js:316-318`、
`window_factory.go:354–373`、`app_window.go:44–67`、`window_host.go:102–140`、
`internal/windowreg/windowreg.go:39–107`（`Spec` / `State` / `SetWorkspace`，写权读权字段的落点）、
`:257–357`（`Add` / `Get` / `List` / `FindByWorkspace`，`ClaimWorkspace` 的落点）、
`crashrecovery_app.go:101–113`、`internal/sessionstore/sessionstore.go:26–57,272`、
`internal/windowreg/windowreg.go:340–357`、`internal/watch/watch.go:72–162`。
