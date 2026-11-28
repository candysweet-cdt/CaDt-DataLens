# CaDt 子代理能力与权限体系重设计（对齐 DSH，取代局部补丁方案）

> 状态：**已实施（2026-11-28，阶段零至六一批落地）**。实施落点：`frontend/src/ai/agent/agent-capabilities.js`（快照合成）+ `ai-agent-preset-registry.js`（注册表与 §10.4 宿主内置 preset）+ `ai-subagents.js`（派单 / 投影 / guard / 阶段零）+ `ai-panel.js`（写判定与 Go 权威判定接线）+ `internal/fsops/writeboundary.go`（§5.5 防线）+ `ai-agent-resume.js`（v2 快照）。文档正文与实现如有出入，以代码为准。（2026-11-28 基于本地 DSH 0.2.2-rc.5 源码与 CaDt 当前实现逐项核对；同日两轮修订：一轮评审结论并入 §0，二轮按「不做任何向前兼容、彻底重构」定案删除兼容层，见 §10）
> 目标：建立通用的子代理能力委派模型，使写作、审读、改稿、翻译、数据分析等插件可以安全地按角色使用工具，而不是给每个业务场景打补丁。
> 结论先行：**推翻「子代理默认只读，只有 worktree 才能写」以及「用 scope 同时代表权限、审批、沙箱、工具面」的设计**——两者均指**子代理侧**；主代理的 scope 审批链保留不动（§0.3）。对齐 DSH 后，子代理在启动时获得一份**固定、可收窄、可审计、可恢复**的能力授权；不能审批不等于不能写。
>
> **重构定案（2026-11-28，作者拍板）：不做任何向前兼容，彻底重构。** 旧参数（`spawn_agent.sandbox`）、旧映射（scope→沙箱/工具面）、旧快照（v1）一律删除，不做兼容映射与降级恢复——见 §10.1 抛弃清单与 §10.2 迁移约束。
>
> **关系定位**：本文取代 `plugin-host-extension-p0.md` §3.3 原来的「设计约束清单」（该节现已只留一个指针指向本文，避免两处真源），不是对 p0 的整体否定——p0 其余部分（技能注册 / 文本资产）照旧独立实施。p0 §3.3 原记的四条前置条件，本文逐条回应：① 真实需求 = 写作插件的 drafting / polish 角色（§4.3）；② 先修编排 fail-open → **阶段零硬前置**（§10.5）；③ 走 preset 接线而非 `capabilities:['write']` 硬开关 → 本文整体方案；④ preset 只管工具可见性、档位与 owns 仍是独立授权层 → §0.3 第 1 条与 §5.2。

## 0. 评审结论摘要（2026-11-28，已并入正文）

### 0.1 三个阻塞项（已修入正文）

1. **编排 owns 冲突**（→ §10.5 阶段零）：仲裁者持有 `spawn_agent`，新模型下若它派 drafting 子代理，该子代理有写工具但无 `session.orchestration` 标记，`authorizeWrite`（`orchestration-ui.js:760-762`）对无标记会话 fail-open 放行 → **绕过 owns 写任意工作区路径**。编排会话派生的一切子代理必须强制只读 preset（本文取此方案），「写闸认子代理 + fail-closed」记为独立后续项。
2. **兼容层映射矛盾**（→ §10.4）：初稿「旧无参数派单映射为默认只读 preset」会把现状 `min(auto, 父档)` 的 workspace-write 命令沙箱（`ai-subagents.js:231,260-265`）降成 read-only，`go test` / `npm test` / `git status`（写 `.git/index.lock`）全挂，与「现有行为不变」的回归承诺直接矛盾。**默认 preset 必须等价现状**。
3. **`interaction.askUser` 混淆两个概念**（→ §3.1）：现状 `ask_user` 本来就是向父代理提问（`ai-subagents.js:662-664`，系统提示词明说「由主代理决定答案，或转询用户」），「子代理直接弹卡给用户」这条路现状就不存在。初稿 `askUser:false` 若导致不挂 `ask_user`，会弄断 background 子代理的提问链（2026-11-17 嵌套提问修复依赖它）。已拆为 `askParent`（保留现状）与「触发用户审批」（恒否，由 `approval:'never'` 表达，不单列字段）。

### 0.2 设计空洞（已补进对应章节）

- `execution.network` 无强制机制（OS 沙箱不隔离网络，deny 只能靠提示词，违反原则 4）→ **删除该维度**（§3.1）；
- preset 可声明 `fs.mode:'danger-full-access'` 的提权漏洞 → **禁止**，full 只能经用户显式派单参数触发（§4.2）；
- 与现有 `ai-agent-preset.js` 的关系 → **扩展而非另立**，不出现第二套 preset 注册表（§4.4）；
- 符号链接逃逸 / TOCTOU 无实现落点 → Go 侧新防线（§5.5）；
- `writableRoots` 相对路径解析基准未定义 → 派单时相对会话工作区解析为绝对路径、快照内只存绝对路径（§3）；
- `spawn_agent` 工具面变更的接线清单（AGENTS.md「AI 工具增删改」硬规范）→ §12.1；
- 存量测试与成文不变量的同步 → §10.5 各阶段。

### 0.3 与现状 / 相邻系统的边界（评审补）

1. **编排 owns 是独立授权层**：能力快照决定「子代理能做什么」，编排批次 owns 决定「哪些路径属于哪个批次」，两层都过才放行——preset 不能绕过 owns（§5.2 guard 链 + §10.5 阶段零）。
2. **主代理不变**：主会话的 scope 审批链（`decidePermission`，`ai-permissions.js:238-282`）原样保留；`applyWorkspaceWrite` 的主会话分支零改动，只在子代理分支读能力快照。
3. **子代理 `session.scope` 字段保留**：它仍被 `ai-read-roots.js` 的读边界判定（工作区外读根授权）使用。能力快照的 `fs` **不接管读边界**——读授权需要随父会话审批动态变化（现状 `ai-subagents.js:929-930`：判定时实时回查父会话，不快照复制），而能力快照的要义是不可变。两套读边界并存是**有意**的：快照只管写与工具，读沿用现有链。

## 1. 为什么必须重设计，而不是继续打补丁

### 1.1 现状的五重耦合

CaDt 当前用一个 `scope ∈ {read, edit, auto, full}` 同时表达：

1. 能读哪些路径；
2. 能写哪些路径；
3. 是否需要人工审批；
4. 命令沙箱模式；
5. 子代理是否挂载写工具。

证据：

- `frontend/src/ai/agent/ai-subagents.js:209-236`：`subScopeDowngrade` 只做权限档严格度比较；
- `:257-280`：`scope → sandboxMode` 固定映射；
- `:643-682`：工具白名单只由 `hasWorktree` 决定；
- `frontend/src/ai/ai-panel.js:9880-9937`：文件写入又按 `scope` 与 worktree 分叉；
- `frontend/src/ai/security/ai-permissions.js:238-282`：审批决策也按 `scope` 分叉。

这导致三个结构性问题：

- **写权限被审批权绑架**：子代理不能弹审批，于是普通子代理干脆不挂写工具；需要写的角色只能借 worktree 绕路。
- **工具面无法表达角色**：review 要只读，drafting 要写，polish 要写，revision 要只读返回整稿；当前只有「worktree 有写 / 非 worktree 只读」二值。
- **策略无法独立演进**：想让 review 访问某个外部知识库、让 drafting 只能写草稿目录、让某类命令允许但文件写禁止，都无法表达。

### 1.2 DSH 的正确拆分

本地源码 `OpenSource/deepseek-harness/packages/subagent/subagent/src/child-agent.ts` 明确把委派边界拆成：

- **权限 preset**：`permission/preset`，子代理继承父级 `auto` / `danger-full-access` 身份；
- **沙箱模式**：`sandbox/mode`，`read-only` / `workspace-write` / `danger-full-access`；
- **审批策略**：`approval/policy`，子代理固定为 `never`；
- **工具组合**：由 preset / `tools.restrict` 决定；
- **执行守卫**：`tools.guard` 在调用前再次拒绝越权；
- **会话元数据**：preset、parentSession、delegationDepth、cwd 等写入子会话日志，冷恢复可重放。

关键原文（`child-agent.ts:171-177`）：

> permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically.

也就是说：**范围固定 + 越权拒绝 + 不能升权**，不是「子代理一律只读」。

### 1.3 与 DSH 的有意差异：默认只读是本地化决策

DSH 子代理默认**继承父工具集（含写工具）**（`.agents/notes/archived/bug-fix/2026-08-10-child-agents-join-their-parent-preset.md`：「A child's capabilities are exactly its parent's, minus whatever its own `toolFilter` removes」）。本文的「默认只读」是**有意收严**，不是 DSH 语义：CaDt 主代理没有 preset 可继承，且默认封顶 auto（2026-11-27 作者决策）下「继承父工具集」等于给所有子代理开 workspace-write，写效应面不可控。本文对齐的是**拆分方式**（维度正交 + 启动时固定 + 越权拒绝 + 不能升权），不是默认值。

## 2. 设计原则

1. **能力正交**：工具面、路径范围、沙箱、审批、模型、上下文、隔离方式分别声明，不再塞进一个 scope。
2. **启动时固定**：子代理创建时捕获一份不可变授权快照；运行中不能升权，续跑不能扩大。
3. **最小权限**：默认工具面只读（不挂写工具），命令沙箱按现状映射（§10.4）；写能力必须由角色/preset 显式声明，且路径范围默认收敛到工作区或指定子目录。
4. **双层防线**：模型可见工具白名单 + 执行前 guard；不能只靠提示词。
5. **确定性拒绝**：子代理不能审批；越权操作直接拒绝并说明原因，不弹卡、不悬挂。
6. **可审计、可恢复**：授权快照写入会话事件/快照，UI 可查，重启后按原授权恢复。
7. **角色是组合，不是硬编码**：宿主提供通用角色/preset 机制，写作插件自行声明 drafting/review 等角色，核心不内置业务角色。

## 3. 新模型：能力快照（DelegatedCapabilities）

每次 `spawn_agent` 生成一份快照。**快照内只存绝对路径**——相对声明在派单时相对会话工作区解析，解析后定死：

```js
{
  preset: 'webnovel.drafting',       // 可选：角色/preset id
  tools: {
    allow: ['read_file', 'search_text', 'write_file', 'edit_file'],
    deny: []
  },
  fs: {
    mode: 'workspace-write',          // read-only | workspace-write | danger-full-access
    workspaceRoot: 'D:/book',         // 绝对路径；派单时解析定死
    writableRoots: ['D:/book/草稿区'], // 绝对路径；相对声明（如 '草稿区'）派单时相对 workspaceRoot 解析
    readRoots: null                   // null = 读边界沿用现有 scope 授权链，快照不接管（§0.3 第 3 条）
  },
  execution: {
    approval: 'never',                // 子代理固定 never
    command: 'sandboxed'              // sandboxed | denied
  },
  delegation: {
    canSpawn: false,
    maxDepth: 1                       // 与全局设置 subAgentMaxDepth() 取 min，快照只收窄不放宽
  },
  interaction: {
    askParent: true                   // 挂 ask_user（向父代理提问，现状语义）；阻塞模式仍不挂
  }
}
```

### 3.1 维度说明

| 维度 | 回答的问题 | 默认 |
| --- | --- | --- |
| `tools` | 模型能看到/调用哪些工具 | 现状只读白名单（默认 preset，§10.4） |
| `fs` | 能写哪些路径（读边界沿用 scope 链，§0.3） | 按现状沙箱映射推导（§10.4） |
| `execution` | 能否执行命令；审批恒 never | 命令沙箱化；审批 never |
| `delegation` | 能否再派子代理 | 与全局设置取 min |
| `interaction` | 能否向父代理提问 | background 开 / blocking 关（现状） |
| `preset` | 用哪套 persona/提示/工具组合 | 继承父级或指定角色 |

**网络不设独立维度**：OS 沙箱（ACL + 完整性标签）不隔离网络，`network:'deny'` 只能靠提示词，违反原则 4「不能只靠提示词」；网络工具（`web_search` / `web_fetch` / `read_image` 的 URL 直读）的可见性由 `tools.allow` 控制，域名级审批沿用主链。将来 OS 级网络隔离落地后再加该维度。

## 4. 角色/preset 机制

### 4.1 宿主提供通用 API，不内置写作角色

```js
cadt.registerAgentPreset({
  id: 'webnovel.drafting',           // 点分命名空间，规则同 ai-agent-preset.js 的 realm
  name: '正文起草',
  tools: ['read_file', 'search_text', 'write_file', 'edit_file'],
  fs: {mode: 'workspace-write', writableRoots: ['草稿区']},  // 相对路径，派单时相对会话工作区解析
  promptSections: [{id: 'role', text: '……'}],
  variables: {role: 'drafting'},
  delegation: {canSpawn: false},
});
```

宿主负责归一化、校验、按 owner 撤销；插件负责声明业务角色。

### 4.2 角色解析顺序与非法定义

解析顺序：

1. `spawn_agent.preset` 显式指定；
2. 未指定则继承父代理 preset；
3. 父代理也没有 preset 时，使用宿主默认 preset（**等价现状**，见 §10.4，不是只读）；
4. 单次 `spawn_agent` 只能**收窄** preset，不能通过 `tools/fs` 字段升权。

派单时**直接失败**的非法情形（错误信息带合法候选清单，对齐模型档的抛错惯例）：

- preset 未注册 / 已卸载；
- `tools.allow` 含未知工具名（对齐 DSH `tools.restrict` 的 unknown-name 拒绝，`core/tools/src/index.ts:180-183`）；
- `writableRoots` 解析后逃出 `workspaceRoot`（`..` 穿越、绝对路径指向工作区外、符号链接）；
- **preset 声明 `fs.mode: 'danger-full-access'`**——full 只能由用户/主代理在 `spawn_agent` 显式传 `sandbox:'full'` 触发（现状逃生舱 + 非阻塞警告，`ai-subagents.js:961-964`），插件声明一律拒绝；
- preset 声明的工具集超出插件安装时用户确认过的能力面（§6.3）。

### 4.3 写作插件的角色映射（示例，不进核心）

| 角色 | 工具 | 文件策略 | 说明 |
| --- | --- | --- | --- |
| drafting | read/search/write/edit | workspace-write，限草稿区 | 可写草稿 |
| polish | read/search/write/edit | workspace-write，限草稿区 | 可写润色稿 |
| revision | read/search | read-only | 返回整稿，由主控落实 |
| review | read/search | read-only | 只读审读 |
| settle | read/search | read-only | 只读沉淀候选 |

这与 v8 `worker-policy.ts:7,64` 一致：drafting/polish 有 `write/edit`，其余角色只有 `read/glob/grep`。

### 4.4 与现有 `ai-agent-preset.js` 的关系：扩展，不另立

`normalizeAgentPreset` / `createAgentScope`（S6 平台原语，`ai-subagents.js:884` 已在用）保留为唯一 preset 归一化入口：

- `normalizeAgentPreset` 的输入形状**扩展** `fs / delegation` 字段（`tools / promptSections / variables / realm` 语义不变）；
- 阶段一新增的 `agent-capabilities.js` 只做快照的**合成、收窄、校验、序列化**（preset × 派单参数 × 父级约束 → `DelegatedCapabilities`），消费 `normalizeAgentPreset` 的输出，**不另立第二套 preset 注册表**——两套 preset 概念并存会重蹈 scope 五重耦合的覆辙；
- `createAgentScope` 继续做每 live agent 的工具/提示/变量注册层；能力快照是它的**输入**之一，不是替代。

## 5. 工具面与执行 guard

### 5.1 可见工具白名单

子代理创建时由 preset + 单次收窄生成 `allow/deny`：

- `allow` 优先；未列出的工具不进入模型 schema；
- `deny` 再叠加，用于禁掉某个看似只读但有副作用的工具；
- 默认 preset 的工具面 = 现状 `subToolsForScope` 白名单（§10.4）；
- 工具集合在**每个模型步骤前**重新解析，兼容插件动态注册；
- 已开始的调用继续执行，新步骤使用新集合。

### 5.2 执行前 guard

所有子代理工具调用统一经过：

```text
参数校验
  → 项目 deny 规则
  → 编排写闸（owns；阶段零后对编排会话派生的子代理 fail-closed，见 §10.5）
  → 能力快照 tools.allow/deny
  → 路径/沙箱边界
  → 执行
```

- guard 是**单调拒绝**：返回拒绝后，后续插件/监听器不能重新放行（对齐 DSH `checkGuards` 的 first-denial 语义，`core/tools/src/index.ts:385-402`）；
- 编排 owns 是独立授权层：编排会话派生的子代理即使 preset 允许写，仍须过 owns——阶段零同时把这类子代理的 preset 强制收窄为只读，双保险。

### 5.3 文件工具

- `read_file/search_text`：读边界沿用现有 scope 授权链（§0.3 第 3 条），快照不接管；
- `write_file/edit_file`：按 `fs.mode + writableRoots` 校验；
- 复用 `SaveFileChecked` 的 mtime 冲突检测；
- 子代理越权返回结构化错误，不进入 `requestApproval`；
- worktree 只是一种 `writableRoots` 特例，不再是"是否给写工具"的开关。

### 5.4 命令工具

- `execution.command='sandboxed'`：复用现有 `AIRunShellCommandConfined` / `AICommandStartConfined`；
- `execution.command='denied'`：不挂载命令工具；
- 沙箱模式来自能力快照，不再从 `scope` 反推；
- 项目 deny 规则始终生效；
- 子代理永不弹审批；
- 编排会话派生的子代理被阶段零强制只读，命令工具不挂。

### 5.5 符号链接与 TOCTOU：Go 侧防线（评审补）

前端路径校验挡不住符号链接逃逸（JS 侧不解析 reparse point），`SaveFileChecked` 只做 mtime 竞态检查。需要 Go 侧两道新防线，实施时落成绑定方法并更新基线：

1. **写路径解析拒绝 reparse point**：`SaveFileChecked`（或其子代理专用变体）在落盘前对目标路径做 `os.Lstat` 链式检查，路径上任何一节是 symlink/junction 即拒绝（`internal/fsops` 已有类似遍历，实施前先查再复用）；
2. **writableRoots 边界判定在 Go 侧做**：`EvalSymlinks` 归一化后前缀比对，前端只传原始路径——「前端快筛 + Go 权威判定」两层中，Go 那遍才是权威（对齐 `ReadPluginAsset` 的越界判定先例，`internal/plugins/plugins.go:283-331`）。

## 6. 审批模型

### 6.1 子代理

- `approval='never'` 固定；
- 需要审批的操作 = 超出授权范围，直接拒绝；
- 拒绝信息必须包含「缺什么权限/路径」，让子代理交回父代理处理；
- 禁止通过 `ask_user` 向用户升权（`ask_user` 只是向父代理提问的通道，§0.1 第 3 条）。

### 6.2 主代理

- 主代理仍走现有审批链；
- 只有主代理能代表用户批准写入/命令；
- 子代理的授权由主代理在派单时给定，不能由子代理自建。

### 6.3 授权来源

- preset 声明的能力必须经过插件安装信任；
- 涉及工作区写入的角色，首次使用时可由宿主展示一次能力确认（不是每次操作弹卡）；
- **能力确认走主会话审批卡**（`requestApproval`），不走 `ask_user`——子代理没有审批通道，确认必须由主代理在场时完成；确认时机取「主代理首次派该 preset 的派单调用」；
- 确认记录按「插件 + preset + workspace」保存；
- 撤销后新派子代理恢复默认只读。

## 7. 隔离方式与路径范围

隔离不再是权限本身，而是 `writableRoots` 的提供方式：

| 隔离方式 | writableRoots | 适用场景 |
| --- | --- | --- |
| 无隔离 | workspace 或指定子目录 | 写作草稿区、普通受控写入 |
| worktree | `.cadt/worktree/<slug>` | 代码修改、并行试错 |
| 临时目录 | `.cadt/tmp/<agentId>` | 中间产物、可丢弃分析 |
| 只读 | 空 | review/revision/settle |

路径校验必须（前四条为前端快筛，Go 侧权威判定见 §5.5）：

- 规范化大小写/分隔符；
- 防 `..` 穿越；
- 防符号链接逃逸；
- 防工作区外绝对路径；
- 在真正落盘前再次校验（TOCTOU 兜底）。

## 8. 持久化与恢复

### 8.1 授权快照落盘

`encodeAgentRun`（`frontend/src/ai/agent/ai-agent-resume.js:48`）扩展保存，**版本号升 `v: 2`**（现为 `v:1`，`ai-agent-resume.js:55`）：

```js
{
  v: 2,
  presetId,
  capabilities: DelegatedCapabilities,   // 全绝对路径，恢复时不需重新解析
  grantedBy: {pluginId, parentSessionId},
  grantedAt
}
```

### 8.2 恢复规则

- v1 旧快照（无能力字段）：**拒绝续跑**（§10.1，无兼容层），报「快照版本过旧，请重新派单」；
- 冷恢复按快照重建工具面、路径范围、沙箱模式；
- 恢复时**不能扩大**原授权；
- 若 preset 已卸载/变更，按快照中的能力声明降级重建；缺关键字段则拒绝续跑；
- 续跑仍显式触发，不自动消耗 token；
- 授权撤销后，未完成子代理在下一轮边界停止或降级只读。

## 9. 对现有代码的推翻清单（均限子代理侧）

| 现有设计 | 处理 | 原因 |
| --- | --- | --- |
| 子代理侧 `scope` 同时决定沙箱/工具面/写分支 | **推翻** | 维度耦合，无法表达角色；主代理 scope 审批链与 `session.scope` 读边界字段保留（§0.3） |
| `subToolsForScope` 按 `hasWorktree` 给写工具 | **推翻** | worktree 是隔离方式，不是写权限来源 |
| `subSandboxModeOf(scope)` 固定映射 | **推翻** | 沙箱模式应来自能力快照 |
| 普通子代理永不挂写工具 | **推翻** | 与 DSH 不一致，写作角色无法落地 |
| 子代理写操作进入 `requestApproval` | **推翻** | 子代理不能审批，应确定性拒绝 |
| `spawn_agent.sandbox` 参数 | **删除** | 改为 preset + 能力快照（§10.1，无兼容映射） |
| 子代理运行态只存 scope/worktree | **扩展** | 必须存完整能力快照（v:2） |
| worktree 写前缀特判 | **保留但泛化** | 纳入统一 `writableRoots` 校验 |

## 10. 抛弃清单与迁移约束（彻底重构，无向前兼容）

### 10.1 抛弃清单

**整体删除（代码与概念都不留）：**

| 旧设计 | 处置 | 替代 |
| --- | --- | --- |
| `spawn_agent.sandbox` 参数 | 删除工具定义、`startSubAgent` 读取（`ai-subagents.js:921`）、`dev/mock-backend.js` 相关 mock、wiring 守卫断言 | `preset` 参数（§12.1） |
| `subScopeDowngrade` / `SUB_SCOPES` / `SCOPE_STRICTNESS` 降档机制（`ai-subagents.js:214-236`） | 删除；防提权改由「父档上限取交」合成规则承担（§10.3） | 快照合成规则 |
| `SUB_SANDBOX_MODE_BY_SCOPE` / `subSandboxModeOf` / `subSandboxPolicy` 的 scope→沙箱映射（`:260-281`） | 删除；沙箱模式只来自快照 `fs.mode` | 能力快照 |
| `subToolsForScope` 的 `hasWorktree` 写工具分支（`:671-673`） | 删除；写工具只由快照 `tools.allow` 决定 | 能力快照 |
| `applyWorkspaceWrite` 的子代理 worktree 特判（`ai-panel.js:9912-9927`） | 删除；并入统一 `writableRoots` 校验 | §5.3 |
| v1 快照（`ai-agent-resume.js:55` 的 `v:1`） | **不做降级恢复**：旧快照一律拒绝续跑，报「快照版本过旧，请重新派单」 | v:2 快照（§8.1） |
| `sandbox:'full'` 参数逃生舱（`:961-964` 的非阻塞警告） | 删除；preset 化为宿主内置 `host.full-write`（§10.4），警告机制保留并改挂在该 preset 上 | `host.full-write` preset |

**语义纯化（保留入口，换语义）：**

| 旧设计 | 处置 |
| --- | --- |
| `isolation:'worktree'` | 只表达隔离方式（隔离车道）：快照注入 `writableRoots` = worktree 前缀**并挂 `write_file` / `edit_file`**——这是现状隔离车道（改动经 `worktree_manage(export)` 人工审批回灌）的延续，不是「scope→写」旧机制的回归。实施语义（2026-11-28 定）：host.default（followParent）经由该车道在任意父档（含 read / 计划模式）获得前缀写（§11.3 现状等价）；**preset 自身声明的写边界（工作区目录）不因 worktree 豁免**——插件写 preset 从 read/edit 父档派单仍失败（§10.3 照常校验，前缀写 ≠ 工作区写） |
| 子代理 `session.scope` 字段 | 退化为**纯读边界**（`ai-read-roots.js` 消费），不再参与沙箱/工具面/写判定（§0.3 第 3 条） |

**不动（正交分工，不是兼容）：** 主代理审批链（`decidePermission`）、读边界授权链、worktree 导出/回灌审批、编排 Worker/审查者工具表硬裁剪（`ai-tool-defs.js:1586-1598`）。

### 10.2 迁移约束（无兼容层带来的纪律）

- **一次性切换**：阶段一至六在同一批落地，不保留「旧路径 + 新路径」双轨期——双轨期本身就是兼容层；
- **旧快照全部作废**：升级后未完成子代理不可续跑，UI 提示重新派单；这是有意行为，进 CHANGELOG；
- **`spawn_agent` 工具描述全量重写**（§12.1），`sandbox` 参数从 schema 消失——依赖旧参数的系统提示词、技能文档、测试断言同步清理；
- **测试基线同步**：`frontend/test/ai/ai-subagent-sandbox.test.mjs` 的 `sliceBetween` 断言按新语义重写；「子代理拿不到任何写工具」的成文不变量注释（`ai-subagents.js:211,658`、`ai-panel.js:20646`）改为「子代理的写工具由能力快照决定」；
- **CHANGELOG 写明破坏性变更**：旧派单参数与旧快照不兼容，升级指引「重新派单」。

### 10.3 防提权合成规则（替代 `subScopeDowngrade`）

删除降档参数后，必须由快照合成规则堵住「read 档主代理派子代理绕开自己的审批面」：

- **父档上限取交**：快照的 `fs.mode` ≤ 父会话 scope 对应档位（full → `danger-full-access`；auto → `workspace-write`；read/edit → `read-only`）；preset 或派单参数请求更高 → **派单失败**，错误信息说明「父会话权限档不足以授予该能力」；
- **工具面同取交**：`tools.allow` ∩ 父会话工具面（父代理自己没有的工具不能给子代理）；
- **`host.full-write` 只在父档 full 时可派**（§10.4）；
- 编排会话派生的子代理强制只读（阶段零），不参与取交——直接收窄到只读 preset。

### 10.4 宿主内置 preset（取代旧参数语义）

| preset id | 等价旧语义 | 说明 |
| --- | --- | --- |
| `host.default` | 现状默认派单 | 工具面 = 现状只读白名单 + 命令四件套；`fs.mode` = 父档上限取交（§10.3） |
| `host.read-only` | 旧 `sandbox:'read'/'edit'` | 只读工具面，无命令工具 |
| `host.full-write` | 旧 `sandbox:'full'` | `danger-full-access`；仅父档 full 可派；派单时投非阻塞警告（沿用 `:961-964` 机制） |
| （插件 preset） | — | `webnovel.drafting` 等，§4 |

未传 `preset` 时用 `host.default`——**这不是兼容**：默认 preset 是新模型的第一等公民（DSH 同款：未选 preset 时用宿主组合），只是其能力面恰好等于现状默认派单。

### 10.5 分阶段实施（无兼容层，一批落地）

0. **阶段零（硬前置，不做完不开阶段三）**：编排会话（Worker / 审查者 / 仲裁者）派生的一切子代理，能力快照强制收窄为只读 preset（宿主侧注入，不信任派单参数）；同时把「`authorizeWrite` 认子代理会话 + fail-closed」记为独立后续项——修好前，强制收窄是唯一防线。验收：仲裁者尝试派写角色子代理 → 派单直接失败或被强制只读。
1. **阶段一：纯模型**：新增 `agent-capabilities.js`（快照合成/收窄/校验/序列化，含 §10.3 取交规则）+ `normalizeAgentPreset` 扩展 `fs/delegation` 字段；纯函数单测覆盖 §4.2 全部非法情形；测试登记进 `npm test` 清单。
2. **阶段二：preset 注册**：新增 `registerAgentPreset` 插件 API 与注册表；宿主内置 preset（§10.4）同批落地；能力确认卡（§6.3）。
3. **阶段三：工具面投影**：`subToolsForScope` 改为消费能力快照；执行前增加 guard；**同批删除** `spawn_agent.sandbox` 参数与 `subScopeDowngrade` / `SUB_SANDBOX_MODE_BY_SCOPE`（§10.1）；按 §12.1 全链路接线；`frontend/test/ai/ai-subagent-sandbox.test.mjs` 断言重写；成文不变量注释更新（§10.2）。
4. **阶段四：文件/命令执行**：`applyWorkspaceWrite` 子代理分支与命令通道读取能力快照，**删除 worktree 特判**（§10.1）；越权确定性拒绝；Go 侧 symlink / writableRoots 防线（§5.5，新绑定方法 + `UPDATE_BINDINGS_BASELINE=1 go test -run TestAppBindingBaseline .` + `dev/mock-backend.js` mock + `backend.d.ts` 重生成）。
5. **阶段五：持久化/恢复**：扩展 `ai-agent-resume.js`（v:2），冷恢复重建能力；**v1 快照拒绝续跑**（§8.2），拒绝路径单测。
6. **阶段六：清理**：删除全部旧分支与旧注释（§10.1 清单逐项核对）；回归 §11.3 全表；CHANGELOG 写明破坏性变更。

## 11. 验收标准

### 11.1 功能验收

- 默认子代理仍只读（无写工具）；
- **默认派单（无 preset、父档 auto）子代理仍可跑 `go test` / `npm test` 验证命令**（§10.4，防回归）；
- drafting preset 子代理可写草稿区，不能写定稿/设定/工作区外；
- review preset 子代理无写工具，幻觉调用写工具在执行前被拒；
- revision preset 子代理只读，返回整稿；
- 子代理不能通过 `ask_user`、命令、插件工具绕过能力快照；
- worktree 子代理仍只能写隔离前缀；
- **编排会话（含仲裁者）派生的子代理一律只读**（阶段零）；
- 续跑后能力不扩大，preset 卸载后安全降级。

### 11.2 安全验收

- 模型看不到未授权工具；
- 即使模型伪造工具调用，guard 仍拒绝；
- 路径穿越、符号链接、大小写变体均被拦——**符号链接由 Go 侧拦**（§5.5），不只是前端；
- preset 声明 `fs.mode:'danger-full-access'` 或未知工具名 → 派单失败（§4.2）；
- 子代理越权不弹审批、不悬挂；
- 授权快照在 UI/日志可查；
- 撤销授权后新子代理不能继承旧写能力。

### 11.3 回归验收（口径修正）

- 现有 spawn/wait/send/stop/compact 的**语义**不变：默认派单（`host.default`）的工具面与命令沙箱等价现状（§10.4）；显式变化仅限——`sandbox` 参数消失（preset 取代）、编排子代理强制只读（阶段零）、旧快照拒绝续跑（§8.2）；
- 现有 worktree 导出/回灌审批不变；
- 主会话审批链不变（`decidePermission` / `applyWorkspaceWrite` 主会话分支零改动）；
- 群聊成员（非子代理路径）不受影响；编排 Worker/审查者工具表硬裁剪不变，仲裁者派子代理被阶段零收窄（有意变化，进 CHANGELOG）；
- **破坏性变更明示**：携带 `sandbox` 参数的旧派单调用、依赖 v1 快照的续跑，升级后直接报错并给出新用法指引（不是静默兼容）。

## 12. 与 v8 的对接方式

### 12.1 工具面变更接线（AGENTS.md「AI 工具增删改」硬规范）

`spawn_agent` 新增 `preset` 参数，**删除 `sandbox` 参数**（schema 中消失，不做兼容映射）：

- `ai-tool-defs.js`：`buildSpawnAgentDef` 的 `properties` 加 `preset`（description 写清「角色 preset id；不传用 `host.default`」）；`sandbox` 字段与其 description 整体删除；
- `AI_TOOL_CATALOG` 的 `spawn_agent` blurb 同步；
- 系统提示词守则（`ai-system-context.js`）与子代理系统提示（`subSystemPromptFor`）同步「preset 派单」指引，清理旧 `sandbox` 措辞；
- `dev/mock-backend.js`：本阶段无新绑定则不动；阶段四新增 Go 绑定时补同名 mock；
- `frontend/test/ai/ai-tool-wiring.test.mjs` 自动核对「描述里提到的参数名 ↔ properties ↔ 执行分支」，`preset` 的读取分支在 `startSubAgent`；
- 用户可见变更与破坏性说明进 `CHANGELOG.md`。

### 12.2 插件适配层

v8 插件不需要改写作技能的业务流程，只需把角色声明映射到 CaDt preset：

```js
// 插件适配层
cadt.registerAgentPreset({
  id: 'webnovel.drafting',
  tools: ['read_file', 'search_text', 'write_file', 'edit_file'],
  fs: {mode: 'workspace-write', writableRoots: ['草稿区']},
  // ……
});
```

主控 `/webnovel-write` 派子代理时指定 `preset: 'webnovel.drafting'`，宿主负责授权与 guard。这样 CaDt 核心保持通用，v8 业务规则留在插件。

## 13. 参考源码

- DSH 委派策略：`OpenSource/deepseek-harness/packages/subagent/subagent/src/child-agent.ts:135-285`
- DSH 子代理工具：`packages/subagent/tool-subagent/src/index.ts:218-336`
- DSH 工具限制：`packages/core/tools/src/index.ts:162-188,385-400`
- DSH 工具契约：`packages/core/tools/README.zh.md:86-92`
- DSH 沙箱策略：`packages/sandbox/sandbox-policy/src/index.ts:61-114`
- DSH 权限预设：`packages/interaction/permission-presets/src/index.ts:65-124`
- v8 角色策略：`OpenSource/webnovel-writer-v8/packages/bundle/src/worker-policy.ts:7,61-90`
- v8 角色委派：`packages/bundle/src/writing-delegation.ts`
- CaDt 现状：`frontend/src/ai/agent/ai-subagents.js:209-280,643-682,802-1003`
- CaDt 写审批：`frontend/src/ai/ai-panel.js:9880-10031`
- CaDt 续跑快照：`frontend/src/ai/agent/ai-agent-resume.js:48-93`
- CaDt 编排写闸（fail-open 缺陷）：`frontend/src/orchestration/orchestration-ui.js:760-767`（唯一调用点 `ai-panel.js:9990`）
- CaDt 编排工具硬裁剪：`frontend/src/ai/tools/ai-tool-defs.js:1586-1598`
- CaDt preset 基础设施：`frontend/src/ai/agent/ai-agent-preset.js`
