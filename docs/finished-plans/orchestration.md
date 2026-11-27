# 编排（Orchestration）：把多会话长任务做成产品能力

> 状态：**已实施（2026-11-27）**。需求来自 2026-11-25 夜间的实测：
> 用「中央指挥 + 分批派独立会话 + 循环唤醒 + 独立审查」人工跑完 agent-host-platform 改造
> （A–F 六个批次、约 1900 行改动、40+ 文件）。本文把那次的成功要素与踩到的坑固化成内置功能。
>
> 结论先行：
> 1. **这不是"多开几个会话"**——现在的群聊是**讨论**、子代理是**临时工**（只读/隔离），
>    缺的是**按依赖图执行、带验收与返工的生产线**。三者定位必须区分开，否则会做成一堆重叠功能。
> 2. **P0 的重心是"让完成有结构化信号"**（`orchestration_report` + 依赖门控 + 看板）：
>    猜「会话是否干完」是整条链最脆弱的一环。P0 还包含心跳三层、冷启动恢复、列表归属、
>    工作区隔离与派单上游摘要——**这些不是优化，缺了就会出正确性问题**（详见 §8 的分期理由）。
>    **P0 只允许 dry-run / 只读设计批次；真实写入必须等 P1 的写闸、验收、预算与停止能力全部就绪后开放**，
>    不能先上线一个只靠 prompt 约束写文件的执行器。
> 3. **不引入新 SQLite**。编排状态是 JSON + 原子写（数量级个位到几十），守「体积第一约束」。
> 4. **复用而非重造**：会话创建 / 派发 / 审批卡样式 / 表单控件 / 快照通道 / 子代理树渲染都已有。
>    新增的是：一个 Go 引擎（含 supervisor + auditor）、**四个 AI 工具**（§5.0）、
>    一个虚拟标签页 + 一个应用页面入口、受控写路径的所有权闸，以及会话身份与派发握手所需的一组绑定。
>    **可编辑编排审批卡、批次级命令隔离和统一停止都不是现成能力**，不能把「复用样式」写成「小改动直接可用」。
> 5. **执行会话不归档、默认折叠**（2026-11-26 定）：折叠保留可达性、不撑开列表；
>    折叠态是内存态（同 `workspaceGroupOverrides`），有失败批次时自动展开并标红。
> 6. **编排的发起强制审批**（任何档位）、**审查门默认开**、**心跳在 Go 而非会话**、
>    **子会话失败三级分流**（2026-11-26 定）：四条都是"不能靠约定、必须有机制"的结论，
>    详见 §6.1 / §5.5 / §5.3.1 / §5.12。
> 7. **三级架构：母会话 → Router → Workers**（2026-11-26 定）：母会话是**绝对上游**（最强模型、
>    有判断力、负责仲裁），Router 是确定性代码（不用模型、靠测试保证），Workers 可指定便宜模型。
>    **职责分界线：确定性归 Router，判断性归母会话**（§5.13.1）——Router 代码里不许"猜"。
> 8. **Router 自身有四重防线**（§5.14）：自检 fail-closed / 硬性数值护栏（含单位时间派发上限，
>    防状态机 bug 导致的死循环）/ 带理由的决策日志 / 穷举测试 + dry-run 模式。
>    它是代码不是 AI，所以它的 bug 用测试覆盖，不靠"AI 审查 AI"。
> 9. **换模型必须由用户显式授权**（§5.15.1）：审批卡勾选「允许编排为批次指定模型」（默认不勾），
>    勾选后填白名单（输入或点选，上限 5 条，存模型 ref）。默认全部用审批时固定的 `arbiterModelRef`；
>    白名单外一律拒绝并附清单，不静默回落。
> 10. **两种执行模式由用户批准时决定**（§5.11.2）：审批卡「全程由 agent 自主执行」默认**不勾**——
>    不勾 = 关键处会停下问你（照 `ask_user` 超时语义，§5.11.1）；勾了 = `awaiting_user` 被禁止，
>    agent 必须自己决定或报 blocked。
> 11. **开始前快照可选、默认不勾**（§5.11.3）：大项目快照可能几百 MB / 几十秒；
>    勾了走既有 `WipeGuardSnapshot`，只作人工后路，**不做自动回滚**。
> 12. **报告必须做归属校验**（§5.1.0）：`orchestration_report` 的 `batchId` 不能伪造——
>    否则会话 A 能冒领 B 批次的完成，编排器会以为活儿干完了。校验链五步，全在 Go 侧。
> 13. **母会话不是"不死"，而是"可替换"**（§5.13.4）：`arbiter` 是一个带 generation 的可转移角色，
>    不是"发起编排的那个会话"。五层保障：上下文瘦身（仲裁请求只带目标+计划摘要+争议点，
>    任何新会话读一份 ≤2000 字的简报就能上岗）/ 预判式交接（使用率>70%；该使用率需新增按会话查询）/ 失效检测（连续 2 次无响应）/
>    交接（开新会话注入角色简报，generation++，标题标注"接替"）/ 兜底降级为用户仲裁。
>    **不做 self-compact 续命**——把可靠性寄托在实例还活着上，而实例死亡正是要防的。
> 14. **跨工作区本期不做，但数据结构已预留**（§12）：`workspaces[]` + `batch.workspace`，
>    校验层限长度 1；12.2 列出了落地时必须补的五件事。
> 15. **加第二层兜底（审计者）**（§5.3.7）：它不是"第二个调度器"，而是**独立视角的观察者**——
>    判据基于持久化文件与 mtime（不读 supervisor 的内存心跳），只报警，并在旧 supervisor **确认退出后**重启、
>    绝不推进业务状态。Go 无法强杀卡死的 goroutine；旧实例不退出时只能告警并要求重启进程，不能再起一个并发调度器。
>    它覆盖"进程活着但内部判定坏了"的一部分，**覆盖不了进程死掉**（那只能靠冷启动恢复）。
>    这正是为什么它不能复用 `aischedule`：语义不同（触发 AI vs 观察本地状态），且会污染用户的定时任务列表。

---

## 1. 需求来源：那一夜的真实问题

以下每条都是当晚实测，不是假想。**方案的每个机制都对应一条**。

### 1.1 调度层

| # | 问题 | 当晚表现 |
|---|---|---|
| D1 | **无法判断会话是"干完了"还是"被打断了"** | 会话是「收到消息跑一轮就 idle」，从外部看 idle 有三种含义：正常完成 / 上下文耗尽 / 被中断。我只能反复 `session_read` 猜，F-核心 第一轮只读了文件就停，我误以为是半成品 |
| D2 | **进度只能靠约定文件** | 全靠 `.cadt/tmp/.../STATUS.md` 这个文本约定；没有结构化信号，无法自动推进，也不能查询 |
| D3 | **推进靠 cron 猜** | 我给自己设「每 25 分钟唤醒」，与真实进度完全脱钩：会话 3 分钟干完了要多等 22 分钟；卡住时又要等一个周期才发现 |
| D4 | **重复 push 的开销** | 每个 idle 会话我都要发一条「继续」消息，每次都烧一轮上下文；C 会话被推到 543 条消息，接近耗尽 |
| D5 | **失败不可分类** | 网络超时（`wsarecv`）、上下文耗尽、主动停止，从外部看都是 idle，处理方式却完全不同 |

### 1.2 并发层

| # | 问题 | 当晚表现 |
|---|---|---|
| C1 | **文件所有权靠 prompt 约定，没有系统强制** | 我在任务书里写「本轮只许你改 ai-panel.js」，但这是**约定不是强制**。`edit_file` 是读-改-写整个文件，两个会话同时改就是后写者覆盖前者 |
| C2 | **并行必须手工排开** | 我靠人肉判断「A 和 B 文件不重叠才能并行」，判断错一次就是互相覆盖 |
| C3 | **测试假红/假绿与环境干扰** | B 正在写 `ai-panel.js` 时，C 的全量 `npm test` 会红，C 无法分辨「我的错」还是「别人在写」 |

### 1.3 质量层

| # | 问题 | 当晚表现 |
|---|---|---|
| Q1 | **"声称完成"不可信** | F-核心 明确说「🔴① 已在面板返回对象上」，实际没挂——我信了，写进汇报，直到 H1 复核才发现 |
| Q2 | **测试假绿比没测试更危险** | 它的接线测试断言的是 **ctx getter**，不是面板返回对象，所以测试绿了但功能没接。**假绿让人确信已修好** |
| Q3 | **审查靠独立 agent + 人工判断** | 预审 3 条 🔴 全靠子代理发现；没有结构化的「问题清单 → 返工批次」回路 |

### 1.4 可观测与资源

| # | 问题 | 当晚表现 |
|---|---|---|
| O1 | **没有全局看板** | 七个子代理 + 三个执行会话 + 两个大批次，进度只在我的上下文里；用户完全看不到 |
| O2 | **token 消耗不可见** | 反复 push、重复读任务书，烧了多少不知道 |
| O3 | **上下文耗尽无法续** | C 会话 543 条消息后只能收工；它的经验（`CanonicalKey` 等）随会话消亡 |

---

## 2. 目标与非目标

### 目标

1. 用户说「把 X 做完」→ AI 产出**批次计划**（依赖图 + 文件所有权）→ 用户批准 → 自动执行到完成。
2. 批次完成有**结构化信号**，不靠猜 idle。
3. 文件所有权在**所有受控写路径上强制**，不是 prompt 礼貌；不受控的写路径（Shell / 终端 / MCP）默认不交给 Worker。
4. 质量有**独立审查门**，不合格自动返工。
5. 全程**可视化**（看板），用户睡觉也能在醒来时看清发生了什么。
6. 长任务可**断点续跑**（换新会话继续，不依赖单会话上下文）。

### 非目标

- 不做通用工作流引擎（不引入 BPMN / DAG 编辑器 / 节点画布）。
- 不替代群聊（群聊是讨论，编制是执行）。
- 不替代 `spawn_agent`（子代理是主代理的临时工，编排是独立会话的产线）。
- 不做跨工作区编排（见 §11「明确不做」与 §12 预留接口）。
- 不引入新 SQLite / 新 npm 依赖。

---

## 3. 术语与定位

### 3.1 术语表（先定名，后面所有章节都按此用词）

文档里有几个容易混的概念必须分清，否则读者无法判断"某个动作是谁做的"。

#### 角色类（谁在做事）

| 术语 | 字段 | 含义 | 会变吗 |
|---|---|---|---|
| **发起会话** | `parentSessionId` | 产出计划、走审批、启动编排的那个会话 | **永不变**；只用作会话列表归属（§5.7） |
| **仲裁者**（arbiter） | `arbiter.sessionId` | 当前担任"判断性决策"角色的会话 | **可变**：上下文将满 / 失效时交接（§5.13.4） |
| **母会话** | — | **本文档里是"仲裁者"的口语简称**，不是"发起会话" | 跟随仲裁者 |
| **Worker** | `batch.sessionId` | 执行某个批次的会话（可便宜模型） | 每次重派换新会话 |

#### 组件类（谁在跑）

| 术语 | 载体 | 职责 | 关键约束 |
|---|---|---|---|
| **Router / supervisor** | Go goroutine | 推进调度：依赖判定、派发、超时判定、护栏 | **确定性代码，不用模型**；代码里不许"猜"（§5.13.1） |
| **auditor**（审计者） | Go goroutine（独立） | 观察"推进是否真的在推进" | **只报警与重启 supervisor，绝不推进业务**（§5.3.7） |
| **审查会话** | 独立会话（`batch.kind='review'`） | 审查某批的改动 | `owns` 恒空（只读），由 Go 侧写死（§5.5.2） |

**为什么必须区分发起会话与仲裁者**：交接后（§5.13.4），"发起编排的那个会话"和"现在做仲裁的会话"就是两个不同会话。
若混用会造成三个实际错误：
- 把 L2 事件投给已失效的发起会话（应该投给当前仲裁者）；
- 列表把批次挂到新仲裁者下（应该挂 `parentSessionId`，固定不变）；
- 交接时去改 `parentSessionId`（不该改，它是历史事实）。

**唯一例外**：§5.7 讲列表归属时必须说"发起会话"，那里不叫母会话。

---

### 3.2 三者定位（必须先在 UI 与文案上说清）

| | 群聊（已有） | 子代理 `spawn_agent`（已有） | **编排（本方案）** |
|---|---|---|---|
| 本质 | 多智能体**讨论** | 主代理派的**临时工** | **生产线**：按依赖图执行 |
| 谁发起 | 用户 | 主代理 | 用户批准 AI 产出的计划 |
| 生命周期 | 一次讨论 | 一次任务，结束即回收 | 多批次，跨会话，可续跑 |
| 产出 | 结论 / 纪要 | 一段最终结论 | 代码改动 + 验收记录 + 审查报告 |
| 隔离 | 无 | 只读 / worktree | 文件所有权 + 批次级工作区约束 |
| 失败处理 | 无 | 主代理重派 | 自动返工（有次数上限） |

**文案约束**：三者入口与图标必须可区分；编排页顶部一行说明它与群聊的区别（避免用户以为"又是个群聊"）。

### 3.3 编排内部是三级：母会话 → Router → Workers

```
母会话（绝对上游 · 最强模型 · 有上下文与判断力）
   │  发起计划 · 异常仲裁 · 收尾
   ▼
Router（Go supervisor · 确定性代码 · 不用模型）
   │  依赖推进 · attempts · 护栏 · 决策日志
   ▼
Workers（独立会话 · 模型可指定 · 干具体批次）
```

**为什么必须有"绝对上游"**：Router 只会算确定量（依赖满足没、attempts 用完没），
它不知道"这次改造本来想干什么"。遇到「verify 失败是代码错还是测试写错」这类问题，
必须有**一个知道目标、且有判断力的主体**来裁决——那就是母会话。

**为什么 Router 不用模型**：调度是确定性工作（可穷举测试、行为可复现），
用模型做调度既浪费钱又不可预测。它的正确性靠测试保证，不靠"AI 审查 AI"。

**为什么 Workers 可以是便宜模型**：具体批次的活（照着 spec 改几个文件、跑 verify）判断密度低，
用便宜模型够用；而母会话的计划与仲裁判断密度高，值最贵的模型。
这是三分级最直接的经济学收益。

---

## 4. 数据模型

### 4.1 存储：JSON + 原子写

```
<应用数据>/orchestrations/<id>.json        编排定义与运行状态（真源）
<应用数据>/orchestrations/<id>.log.jsonl   决策与审计流水（append-only，可单独清理；删除后不可重建）
```

**为什么不上 SQLite**：AGENTS.md 只批准了三个派生库（`ai-index` / `ai-schedule` / `ai-usage`），
且都"不存真源"。编排状态**就是真源**，不该进可随时删除的派生库；数量级（个位到几十条）也不需要索引。
用 `atomfile.WriteFileAtomic` 保证不半截，配合 `sessionlock` 做读-改-写互斥（与 `aiworklog` 同款）。

#### 4.1.1 按工作区隔离（与会话列表同口径）

编排属于某个工作区（`workspaces[0]`）。**列表与看板必须按当前窗口的工作区过滤**，
否则 A 仓的窗口会看到 B 仓的编排，用户会误以为自己发起的。

| 场景 | 行为 |
|---|---|
| 看板 / 编排列表 | 只列 `workspaces[0]` 与当前窗口工作区一致的（`aiWorkspaceKey` 归一后比对） |
| 另一个工作区的编排正在跑 | 本窗口**不显示进度、不接管执行**；dispatch 事件也按工作区过滤，只有归属工作区的窗口可认领 |
| 该工作区没有可用窗口 | 编排置 `paused_no_window`，冻结批次剩余时限；该工作区窗口重开或从托盘还原后恢复。其他工作区窗口存在不算执行能力 |
| 用户跨工作区想干预 | 先切到该工作区窗口——**本期不提供跨工作区 CLI 或控制面板** |

**为什么不做跨工作区面板**：那会让"谁在控制这个编排"变得模糊。这里的「一个控制域」指**一个归属工作区**，
不是永久绑定某个窗口名；同工作区多窗口仍靠派发租约互斥，窗口关闭后由同工作区的新窗口接管。

**实现落点**：`OrchestrationList()` / `OrchestrationGet()` 必须按**可信调用方上下文中的工作区**过滤或鉴权，
不能先返回全量再只靠前端隐藏。supervisor 巡检直接调用包内存储接口，不经过 Wails 绑定，也不需要伪造一个窗口身份。

### 4.2 结构

```js
Orchestration = {
  id, title, goal,                    // goal 是给人和 AI 看的一句话总目标
  workspaces: [''],                   // **多工作区预留接口**：当前只允许长度 1（§12.1）
  parentSessionId,                    // 发起编排的会话（仅列表归属用，§5.7）
  groupSnapshot,                      // 创建时复制发起会话 group；后续重派不随仲裁者或原会话分组变化
  arbiterModelRef,                    // 审批时固定的仲裁/默认 Worker 模型，交接不得暗中换档
  arbiter: {                          // 仲裁者角色（可交接，§5.13.4）——不是 parentSessionId！
    sessionId, generation, assignedAt,
    handoffs: [{from, to, at, reason}],
  },
  snapshot,                           // 开始前快照（可选，§5.11.3）：{at, mode, name, bytes} | null
  createdAt, updatedAt,
  status,                             // planning | running | paused | paused_no_window | stopped
                                      // | awaiting_user | awaiting_arbitration | blocked | done | failed | fault
                                      // 聚合口径见 §5.3；paused/stopped/等待态会冻结批次时限
  policy: {
    scope: 'edit',                    // 执行会话的权限档（只能继承或更严）
    maxParallel: 2,                    // 并发批次数（默认 2）：owns 有交集的批次永不同时跑
    maxAttemptsPerBatch: 2,            // 单批最多尝试次数（含首次）
    budgetTokens, maxTotalRounds, maxWallMs,
    batchTimeoutMs: 1200000,           // 单批超时（默认 20 分钟）：超时未回报判 stalled（§5.3.2）
    auditIdleMs: 7200000,              // 审计者判"完全没进展"的阈值（§5.3.7，默认 2 小时）
                                       // **约束：必须 ≥ 2 × 最长 batchTimeoutMs**
                                       // 否则长任务正常跑着（无 report 就无状态变化）会被误判
    arbiterTimeoutMs: 600000,          // 单次仲裁请求的等待上限（§5.13.4，默认 10 分钟）
    arbiterMissLimit: 2,               // 连续多少次无响应判仲裁者失效（§5.13.4）
    arbiterRotateAt: 0.7,              // 上下文使用率超过它主动交接（§5.13.4；取不到使用率则跳过）
    review: true,                     // 审查门默认开（§5.5）
    reviewModel: '',                  // 省略 = 用 arbiterModelRef（§5.15）
    escalateOnRetry: false,           // 重派升级模型：默认关，见 §5.15
    allowWorkerModels: false,          // 用户是否允许编排为批次指定模型（§5.15.1，默认不许）
    allowedWorkerModels: [''],         // 白名单（最多 5 条）；空 = 全部用 arbiterModelRef
    autoRun: false,                    // 全程自主执行（§5.11.2，默认不勾）
                                       // true 时禁止 awaiting_user
    snapshotBeforeStart: false,        // 开始前快照（§5.11.3，默认不勾）
  },
  batches: [Batch],
  stats: { dispatched, done, failed, rework, tokensUsed, wallMs, dispatchTimes: [] }, // 派发时间只留滚动窗口，不建无界 map
}

Batch = {
  id, title,
  kind,            // 'work' | 'review'（默认 work；审查批次 §5.5.2）
  reviewOf,        // 仅 kind='review'：被审查的 work 批次 id；**不用 dependsOn 表达这层关系**（§5.5.2）
  workspace,       // 所属工作区（当前恒等于 workspaces[0]；多工作区时按批分配）
  spec,            // 本批任务说明（**独立存盘**，派单时只注入这一段，不注入全局手册）
  owns: [glob],    // 本批可写的路径（others = 只读）；相对 batch.workspace
  dependsOn: [id], // 门控（只允许 work 批次）
  verify: [{file, args, cwd?, timeoutMs?}],  // 验收命令：exe + argv，不走 shell 字符串（§5.4）
  timeoutMs,       // 本批执行超时；省略 = policy.batchTimeoutMs。审批卡可按批改，审计阈值按各批实际值算
  model: {first, retry},  // 模型分配（§5.15）；省略 = 用审批时固定的 arbiterModelRef
  status,          // pending | dispatched | running | verifying | reviewing | done
                   // | failed | blocked | awaiting_user | cancelled | skipped
                   // awaiting_arbitration 只存在于编排级（§5.3），批次停在 blocked / failed
                   // **没有 rework / review_unavailable 状态**：返工是 pending + history，后者是 failureReason
  failureReason,   // 最近一次失败分类：no_report | stalled | session_gone | verify_failed | review_failed | review_unavailable | over_budget
  sessionId,       // 当前执行会话
  attempts,        // **已成功起轮的次数**：StartBatch 时 +1，失败时不再 +1；上限判定见 §5.3
  dispatchAt, claimedBy, claimedAt, dispatchedAt,  // 派发四时间戳（§5.3.3，缺一不可）
  deadline,        // running 时的超时点；暂停/等待时转存 remainingMs，恢复时重算
  remainingMs,
  writeLog: [{attempt, at, path}],  // 写闸实际放行的路径（§5.2），供审查与重派回顾，不采信自报
  report,          // 最近一次结构化回报（§5.1）
  history: [{attempt, sessionId, model, status, at, problems, reportId, autonomousChoice}],
}
```

**关键点**：`spec` 存在编排队列里，不依赖任何外部文件。派单时只把这一个 batch 的 spec 注入给执行会话——
这解决 **O3**（上下文耗尽）与 **D4**（每次重读全局手册）。

---

## 5. 关键机制（逐条对应痛点）

### 5.0 新增 AI 工具清单（必须先定全，否则实现时必漏）

编排对外只有**四个工具**，按仓库规范每个都要走全套接线
（`AI_TOOL_DEFS` + `AI_TOOL_CATALOG` + `AI_TOOL_GROUPS` + 执行分支 + 工具卡 `verb`/`icon` + mock + 档位清单）。
`ai-tool-wiring.test.mjs` 会逐项对账，漏一处直接红。

| 工具 | 谁能用 | 作用 | 是否强制审批 |
|---|---|---|---|
| `orchestration_plan` | 任意会话 | 提交批次计划，**弹审批卡**；批准后创建编排并启动 | **是（任何档位）**，§6.1 |
| `orchestration_report` | **仅**带编排执行票据的会话 | 回报完成/阻塞/需用户裁决，或提交审查结论 | 否（但归属校验严格，§5.1.0） |
| `orchestration_status` | 任意会话 | 只读查询：**当前工作区**的编排进度、批次状态、最近事件 | 否 |
| `orchestration_control` | 仲裁者 | 暂停 / 恢复 / 停止 / 跳过批次 / 重派 / 修改未派发批次 spec 或 owns | **是**（有副作用，且会停别人的会话） |

看板上的用户操作不走这个 AI 工具，走独立的用户控制绑定（§7）：用户已在确认卡上点过确认，
不需要再冒充「仲裁者会话」，也不能靠前端传一个 `role: 'user'` 来提权。

**为什么合并成 `control` 一个而不是 `stop`/`pause`/`resume` 三个**：
它们共享同一套前置校验（编排归属、状态是否允许该操作、影响面确认），拆开会让守卫测试
与档位清单膨胀三倍，收益为零。`action` 枚举 + 一个 `switch` 即可。

**不下发的情况**（与 `spawn_agent` 的档位清单同款维护）：
- 计划模式下：`orchestration_report` / `orchestration_control` 不下发（计划模式不执行）；`plan` / `status` 照发。
- 普通会话：`orchestration_report` 不下发（没有编排归属就用不上）。

**每个工具的描述必须写清「何时用 / 何时不用 / 与相邻工具的分工」**（AGENTS.md 硬规范），
尤其 `orchestration_plan` 要写明"这是要花很多钱的动作，会强制弹审批卡，不要重试绕过"。

---

### 5.1 `orchestration_report` 工具 —— 结构化完成信号（解 D1/D2）

**新增 AI 工具**，只在编排派发的会话里可用：

```
orchestration_report({
  batchId, reportId,              // reportId 由模型生成并在重试时复用（幂等键，§5.1.2）；attempt 不在参数里，
                                  // 由执行票据绑定（§5.1.0），模型改不了
  status: 'done' | 'blocked' | 'awaiting_user',
  changedFiles: [path],          // 自述改了什么（仅供审查参考；实际改动以 writeLog 为准）
  verifySelf: [{cmd, exitCode, summary}],  // 会话自己跑过哪些命令 + 结果（**仅供审查者参考**）
  notes,                          // 一句话说明
  blockingIssue,                 // status=blocked 时必填：卡在哪、需要谁做什么
  question: {text, options: [{label, recommended?}], timeoutSec?, timeoutAction?}, // awaiting_user 时必填
  autonomousChoice,              // 自主模式下做了有争议的选择时必填：选了什么 + 理由
  review: {blocking, shouldFix, suggestions},  // 仅审查批次可带（§5.5.3）
})
```

`needs_rework` 不再作为执行者的回报状态：执行者只需要说 `done` / `blocked` / `awaiting_user`；
「要不要返工」由验收与审查判定，不由执行者自评。

**`verifySelf` 的用途必须明确，否则它是冗余字段**：

| 它**是** | 它**不是** |
|---|---|
| 给**审查会话**看的「执行者自述跑了什么」（审查者据此判断"有没有漏跑关键测试"） | ❌ 不是验收依据——`batch.verify` 由编排器自己跑（§5.4） |
| `batch.verify` 为空时的**候选命令**（编排器可提示用户"这批没配 verify，执行者建议跑 X"） | ❌ 不参与 `done`/`failed` 判定 |
| 失败重派时的排查线索（"上一轮跑过这些，都绿了，但你说没完成"） | ❌ 不由模型自报决定成功 |

**一句话**：`verifySelf` 是**证据**，不是**判决**。

**为什么这是 P0 的核心**：没有它，编排器只能用「idle + 轮询 STATUS.md」猜。有了它，
会话**必须**显式声明结果，编排器读结构化字段推进。

#### 5.1.0 归属校验：`batchId` 不能被伪造（安全硬要求）

**问题**：`orchestration_report` 由执行会话调用，若不做归属校验，
会话 A 可以提交 `batchId=B2` 的报告，**冒领 B2 的完成状态**——编排器会以为 B2 干完了。
这属于「同一进程内任意会话都能伪造业务事实」，比工具越权更隐蔽（它不写文件，只改状态）。

**校验链（Go 侧，全部在状态锁内）**：

```
1. 解析执行票据：OrchestrationStartBatch 在起轮前签发一次性 executionToken，
   绑定 {sessionId, orchestrationId, batchId, attempt, role, windowName}
   —— 前端运行时在工具参数之外自动携带，不进 AI_TOOL_DEFS，模型既看不到也填不了
   —— **不能用 sessionstore.OwnerForCall**：它只返回绑定调用方窗口名，窗口可切会话、多会话可交错调用
2. 断言票据未过期/未吊销，且 orchestrationId 对应的编排仍在运行（stopped/fault 的票据一律吊销）
3. 找到票据绑定的批次：session.orchestration = {id, batchId, attempt, role}
   —— 会话上必须有编排归属，没有就拒绝（非编排会话不可调用）
4. 断言 batch.sessionId === 票据 sessionId 且 batch.attempts === 票据 attempt
   —— 不相等说明是重派前的旧会话，或伪造
5. 断言批次处于该 role 允许回报的状态（work: running；review: 被审查批次处于 reviewing）
   —— 已完成/已取消的批次拒收报告
6. 幂等判定：同一 attempt 内 reportId 相同且正文相同 → 返回上次结果；reportId 相同正文不同 → 拒绝
```

第 5 步**不校验 `arbiter.generation`**：那是仲裁者写入用的 fencing，Worker 的完成事实不应因为中途换了仲裁者而作废。
generation 只在 `orchestration_control` 与仲裁回复上校验（§5.13.4）。

**失败一律拒绝并写明原因**（照 `subAgentModelPick` 的风格：错就明确报错，不静默忽略）：

| 情形 | 错误文案 |
|---|---|
| 会话无编排归属 / 票据无效 | 「本会话不属于任何编排批次，`orchestration_report` 不可用」 |
| `batchId` 与票据不符 | 「批次 B2 的执行会话是 `<other>`，不是你；不要提交他人的报告」 |
| 批次已终态 | 「批次 B2 已是 done，报告被丢弃（是否重复调用？）」 |
| 旧会话（已被重派替换） | 「你已被取代（attempt 1 → 2），报告不再受理；如需继续请等新会话」 |
| 自主模式下提交 `awaiting_user` | 「本次编排为自主执行模式，不能请求用户输入；请自行决定并在 notes 说明理由，或报 blocked」 |

**最后一条尤其重要**：重派后旧会话可能还在跑并迟交报告。若不拦，旧结果会覆盖新尝试。

#### 5.1.2 报告的幂等与丢失

- 报告写入走 `atomfile`（状态整体原子替换）。幂等键是 **`attempt + reportId`**，不是「同一 attempt 只认第一次」：
  同一 attempt 内允许先 `blocked` 再被仲裁者改派后继续、最后 `done`，只认第一次会把合法流程堵死。
- IPC 失败 → 工具返回错误给模型，**模型带同一个 `reportId` 重试**：若 Go 其实已落盘只是回包丢了，
  幂等判定直接返回上次结果；这样「已提交但模型以为失败」不会被误判成 `no_report`。
- 重试仍失败 → 走 `no_report` 判失败尝试（宁可重派一次，不可假成功）。

**强制力从哪来**：派单 prompt 里写明「**本批必须以调用 `orchestration_report` 收尾，否则编排器视为未完成**」。

**`no_report` 的判定不能只看 idle**——D1 说的正是 idle 有三种含义，用 idle 判失败等于把同一个坑再挖一遍。
正确判据需要前端宿主上报**回合生命周期事实**（不是「还在跑吗」这种问询，supervisor 的时限判定仍只用自己的账本）：

| 前端上报 | supervisor 的处理 |
|---|---|
| `turn_started`（stream 已注册） | 记 `dispatchedAt`，启动 deadline |
| `turn_finished`（模型自然收尾，无挂起工具/审批/提问） | 有 report → 正常推进；无 report → 判 `no_report` |
| `turn_failed(reason)` | 有明确分类（上下文耗尽 / 网络 / 用户停止）就按分类处理；用户停止不重试 |
| `waiting_user` / `waiting_approval` | 转对应等待态并冻结 deadline，**不算 stalled** |
| 什么都没上报（前端崩溃、stream 假活） | 不猜，等 deadline 判 `stalled` |

这条规则要在工具描述与派单 prompt 两处都写。

**工具下发条件**（与 `spawn_agent` 的档位清单一同维护，`ai-tool-wiring.test.mjs` 会对账）：
- 只在会话带 `orchestration` 归属时进工具表（普通会话看不到它，避免误用）。
- 计划模式下不下发（计划模式不执行）。

#### 5.1.1 与 `session_send` 的分工（**不要混用**）

现有 `session_send` 的语义是「**消息投递**」：进对方信箱，卡片明确标注「参考信息，非用户指令」，
对方的权限 / 状态不受影响。它**不适合**承担编排的「任务派发 + 结果回收」：

| | `session_send` | 编排通道 |
|---|---|---|
| 语义 | 一句话参考信息 | 任务契约（spec + owns + verify） |
| 送达 | 信箱，等对方轮边界消费 | **首轮用户消息**（直接起轮） |
| 回收 | 对方**自愿**回投（当晚靠 prompt 约定） | `orchestration_report` **强制** |
| 缺回复 | 不知道，也没法判定 | `no_report` 判定为失败尝试 |
| 撤销 | 不能 | 批次可被停 / 重派 |

**结论**：
- **派单不走 `session_send`**，而是把 batch spec 作为**首轮用户消息**注入新建会话（`ai_new_session` 后起轮）。
  理由：首轮是「任务」，信箱是「通知」；混用会让执行会话分不清"这是活还是句闲话"。
- **回收只认 `orchestration_report`**，写在 Go 状态里；编排器**订阅状态变化**推进（同进程直接回调、跨窗口靠事件）。
- **`session_send` 仍可作旁路**：执行会话中途要问主编排"这算不算越界"，用 `session_send` 发问是合理的——
  但它不是完成信号，编排器不会因此推进。

**保证「分发后的会话能回复主会话」的三层**：

1. **结构层**：`orchestration_report` 是注册在案的 AI 工具，执行会话的工具表里**一定有它**（不需要"记得"去投递）；
   工具卡会显示「已回报」状态，人一眼可见。
2. **兜底层**：会话 idle 且无 report → `no_report`，编排器重派时把「上一轮没回报」写进新 prompt。
3. **人的兜底层**：看板上该批标红「未回报」，可一键重派 / 停止编排。**不提供「手工标记完成」**——
   那等于绕过 verify 与审查，正是 Q1 要防的事；确需放行只能走「跳过」并记入 history。

**跨窗口注意**：编排状态在 Go 侧，窗口关掉再开也能续；`orchestration_report` 由任意窗口的会话调用都会落到同一份状态。

### 5.2 文件所有权闸（解 C1/C2）

**先把承诺说准**：本期能做到的是「**所有受控写路径上的强制**」，不是操作系统级的沙箱。
子进程（Shell / 终端 / MCP）能写任意文件，光靠前置断言拦不住；所以本方案的做法是
**把不受控的写路径从 Worker 手里拿掉**，而不是假装能拦住它们。

| 写路径 | 处理 |
|---|---|
| `write_file` / `edit_file` | 落盘前调 Go `assertWritable(sessionId, absPath)`，越权直接拒绝 |
| 补丁应用 `PatchApply` | **不经过 `applyWorkspaceWrite`**，必须在 Go 侧按选中的每个目标路径单独校验 |
| `run_command` / `background_command` / 交互终端 | **Worker 默认不可用**（工具表不下发）。验收命令只由 Router 的 verify runner 执行（§5.4） |
| MCP 工具 | 写效应无法从 schema 判断，**Worker 默认不可用**；只读 MCP 需逐个登记后放行 |
| 其它 Go 直写绑定 | 逐个登记并加同一道闸；未登记的按不可用处理 |

- 越权时**直接拒绝**（fail-closed），文案要能自我纠正：
  「路径 X 不在本批 owns 内（本批仅可写 Y）；如确需修改请回报 `blocked` 说明」
- 每次放行追加到 `batch.writeLog`（§4.2）。这是「实际改了什么」的依据；`report.changedFiles` 只是自述。
- 将来若要开放 Worker 跑命令，必须先有按批次隔离的 OS 级写约束；**在那之前不得放开**。

#### 5.2.1 绝对路径与 glob 的比对口径（必须写死，否则闸形同虚设）

比对在 **Go 侧**做（符号链接求值需要 `filepath.EvalSymlinks`，JS 做不了；而且补丁路径本来就在 Go）。
`owns` 是相对 `batch.workspace` 的 glob：

```
1. absPath 归一（分隔符→正斜杠；Windows 下大小写不敏感；折叠 ..）
2. 求符号链接：对 absPath **最近存在的祖先**做 EvalSymlinks 再拼回剩余段
   （目标文件可能还不存在，直接对整条路径求值会失败）；workspace 根同样求值
3. absPath 不在求值后的 workspace 根内 → 直接拒（工作区外，连 owns 都不用比）
4. rel = 去掉根前缀；用 rel 匹配 owns：
   - 只支持 `*`（不跨目录分隔符）与 `**`（跨目录）；`?`、`[]`、`{}`、正则一律不支持 → 计划校验阶段就拒绝
   - 匹配库未知/写错时**拒绝**，绝不退化成「放行一切」
5. 空 owns = 全只读（审查批次与设计讨论批次的用法）
   owns 含 `**` = 该批可写整个工作区 → 审批卡上按高危配置单独标红提示
```

**三个必须堵的绕过手法**：

| 绕过 | 堵法 |
|---|---|
| `../other-repo/x` | 第 3 步就拒 |
| 大小写差异（Windows 不敏感） | 归一后比对（与 `aiPathInside` 同口径） |
| 符号链接 / junction 指向别处 | 第 2 步求值；根内指向根外的链接会被第 3 步拒掉 |

**审阅线索**：越权拒绝必须记一条 debug 日志（含 rel 与 owns），否则 AI 反复被拒时无从排查。

#### 5.2.2 并行与验收的静默屏障（解 C2 / C3）

- **owns 交集用保守判定**：`src/**` 与 `src/*.js` 这类是否相交不能靠字符串前缀猜；
  判定器对确定不相交才允许并行，**判不准一律当作相交、串行执行**。
- **verify 不在有人写的时候跑**。C3 的根因是「B 还在写，C 的全量测试读到了半成品」，
  owns 不重叠也挡不住——测试会读整个工作区。所以每个工作区有一道**静默屏障**：
  1. 某批 report=done、准备 verify 时，Router **停止派发新批次**；
  2. 等在跑的 Worker 走到 report（或超时判定），期间不派新的；
  3. 工作区内无写入者后，把已就绪的批次**串行** verify，然后进审查；
  4. 屏障解除后才恢复派发。审查期间同样不许写入者，否则审的是移动中的 diff。
- 这会牺牲一部分并行度，是**正确性优先于吞吐**的有意取舍；多工作区落地后不同工作区可各自有屏障（§12.2）。

### 5.3 依赖门控与自动推进（解 D3）

**批次状态机**（完整，与 §4.2 的 `Batch.status` 一一对应）：

```
pending ──依赖满足──▶ dispatched ──认领+起轮──▶ running
                                                      │
        ┌─────────────────────────────────────────────┤
        │                                             │
  report=blocked                                   report=done
        │                                             ▼
        ▼                                        verifying
     blocked ──▶ awaiting_arbitration（不自动重派：blocked 是判断性问题，§5.12）
        │                                    ┌────────┴────────┐
        │                                 verify 绿          verify 红
        │                                    │                 │
        │                                    ▼                 │
        │                                reviewing             │
        │                                    │                 │
        │                          ┌─────────┴────────┐        │
        │                    无阻断问题          有阻断/应修问题  │
        │                          │                │        │
        │                          ▼                ▼        │
        │                        done      attempts < max → pending（同一批次，带上一轮回顾）
        │                                          │
        │                                          └ attempts = max → failed → awaiting_arbitration
```

**attempts 的计数口径只有一条**：`StartBatch` 成功时 `attempts++`，失败时**不再加**。
`maxAttemptsPerBatch = 2` 的含义是「首发 1 次 + 重派 1 次」。原稿在 verify 红、stalled 等处各写一次 `attempts++`，
叠加首次派发后实际口径不一。

**`stalled` / `session_gone` / `no_report` 不是状态，是 `failureReason`**（§5.3.2）：
三者都结束当前尝试并回到 `pending`，若 `attempts` 已达上限则进 `failed`。
同理没有独立的 `rework` 状态——返工就是**同一个** work 批次带着问题清单回到 `pending`，不是新建批次
（新建批次会让依赖、attempts 上限、看板计数全部对不上）。

**`skipped` 与 `cancelled` 都不是失败**，区别在谁来做的：

| 状态 | 含义 | 恢复编排时 |
|---|---|---|
| `cancelled` | 用户停止时尚未开始的批次，或上游已不可能满足 | 重新置 `pending` |
| `skipped` | 用户/仲裁者**显式**决定不做这一批 | 保持 skipped，不自动恢复 |

**四个"等待类"状态不是卡住**（各有自己的超时/触发，期间 deadline 冻结为 `remainingMs`）：

| 状态 | 含义 | 谁来推它 |
|---|---|---|
| `awaiting_user` | 等用户回答（§5.11.1） | 用户回答 / `timeoutAction` 到期 |
| `awaiting_arbitration`（编排级） | 有批次报了 `blocked`、或 attempts 用尽，等仲裁者判断（§5.13.2）；批次自身停在 `blocked` / `failed` | 仲裁者回复 / 交接 / 降级为用户仲裁 |
| `reviewing` | 审查会话在跑（§5.5） | 审查报告到达 |
| `blocked`（编排级） | 没有可推进的批次，且还有未解决的非终态批次 | 用户 / 仲裁者 |

**编排级状态是批次状态的聚合，按优先级取第一个命中项**（原稿说「不做映射表」，结果是 `paused_no_window`
与 `stopped` 根本不在枚举里）：

1. `fault`：Router 自检失败
2. `stopped` / `paused` / `paused_no_window`：用户或环境显式暂停
3. `awaiting_user`：任一批在等用户
4. `awaiting_arbitration`：存在 `blocked` 批次，或 `failed` 批次的 L2 事件尚未被仲裁确认
5. `running`：存在 running / verifying / reviewing，或存在依赖已满足可派的 pending
6. `blocked`：没有可推进批次，且存在 failed / blocked / 上游被 skip 的 pending
7. `done`：全部 work 批次为 done 或 skipped（审查批次不计入分母）
8. `failed`：计划本身不可执行——正常流程不应走到

**推进触发器**：`orchestration_report` 到达时，Go 在同一把状态锁内直接推进（**不用 cron，也不需要前端再调 Advance**）。
supervisor 只做兜底巡检。这解决 D3：正常路径是事件驱动，巡检只是保险丝。

#### 5.3.0 派单时注入什么：上游产出必须传给下游（否则 B2 不知道 B1 做了什么）

这是原设计的重大遗漏。B2 依赖 B1，但 B2 的执行会话是**全新会话**——
它不知道 B1 改了哪些文件、为什么那么改。让它自己去读代码猜，既慢又易错。

**定稿：派单 prompt = 本批 spec + 上游摘要，上游摘要由 Router 从状态里拼，不靠 AI 回忆。**

```
【本批任务】
<batch.spec>

【上游已完成】（自动注入，只给直接依赖，不递归传全部历史）
- B1「抽出 scopeRootOf」done
  · 改了：frontend/src/ai/session/ai-session-scope.js、frontend/src/ai/ai-panel.js（路径段）
  · 关键结论：会话根优先于窗口根；第 4 步兜底不能提前
  · 遗留：aiRelPath 两处尚未同源，B2 需要一起改
- B2a「Go 侧绑定」done
  · 改了：internal/windowreg/windowreg.go
  · 关键结论：Spec 已能透传 Harness

【约束】
- 只能写：<owns>
- 收尾必须调用 orchestration_report（否则视为未完成）
```

**上游摘要的取数规则**（每条都有上限，防止 prompt 膨胀）：

| 字段 | 来源 | 上限 |
|---|---|---|
| 标题 + 状态 | `batch.title` / `batch.status` | — |
| 改了哪些文件 | `batch.writeLog`（写闸实际放行记录；**只给目录级摘要**，不给完整路径列表） | 每批 ≤ 200 字 |
| 关键结论 | `report.notes` | 每批 ≤ 300 字 |
| 遗留问题 | `report.notes` 里"遗留"段落或 `blockingIssue` | 每批 ≤ 200 字 |
| **总计** | 只注入**直接依赖**（`dependsOn` 里列的），不递归 | ≤ 1200 字 |

**为什么只给直接依赖**：递归传全部历史会让第 6 批的 prompt 里塞满前 5 批摘要，
既超预算又稀释重点。真要跨批信息，应该在计划阶段把关键结论**写进后批的 spec 里**
（那是仲裁者在规划时的职责）。

**这条规则的验收**：dry-run 打印每批的实际派单 prompt，断言总长度 ≤ `spec + 1200 + owns`。

#### 5.3.0.1 重派时注入什么：上一轮的失败与进度

重派用的 prompt = 本批 spec + 上游摘要 + **上一轮回顾**（attempts 在新会话 `StartBatch` 成功时才 +1）：

```
【上一轮回顾】（attempt 1 失败：verify_failed）
- 结束状态：verify 失败（`npm run -s test:ai` exit 1，12 个用例红）
- 你说要做的：<report.notes 摘录>
- 实际改了：<writeLog 目录级摘要>；越权被拒的尝试：<writeLog 里的 denial 条目>
- 本次要求：先处理上面失败的点，再继续；不要重复已成功的部分
```

**重派不回滚**：上一个会话的改动还留在工作区里，新会话是在**现状**上继续，不是从零重做——所以回顾里必须给 writeLog。
若要丢弃上一次改动，只能走 §5.11.3 的人工还原，Router 不自动回滚（§11）。

**同时重置 `deadline`**：新会话 `StartBatch` 时 `deadline = now + batch.timeoutMs`（默认取 `policy.batchTimeoutMs`），
否则新会话一起来就被判 stalled。**这条必须写进实现清单**，否则重派等于立刻再失败一次。

### 5.3.1 心跳：三层能力分离（解"母对话终止即任务停止"）

昨晚我用 `schedule_create` 给自己设 cron 唤醒，才保证任务不因"我这轮结束"而停。
**但那绑在会话上**——会话被删、上下文耗尽、或忘续设，整条线就断。

**核心洞察：把"心跳"拆成三种互相独立的能力，任一缺失都能被明确定义。**

| 能力 | 载体 | 活着条件 | 缺失时 |
|---|---|---|---|
| **状态真源** | Go `internal/orchestration/`（JSON + atomfile） | 应用进程在 | 应用退出，状态留磁盘，重启续 |
| **推进能力** | Go supervisor goroutine | 进程在（且 supervisor 未死） | 见 §5.3.4 自愈 |
| **执行能力** | **归属工作区**至少有一个可用主窗口（前端起轮） | 该工作区有窗口 | 暂停（`paused_no_window`），不烧钱 |

「可用窗口」按**归属工作区**算，不是「任意主窗口」：B 仓的窗口替 A 仓的编排起不了轮。
托盘隐藏不算关窗（窗口仍可执行）；只有该工作区最后一个窗口真正销毁才触发暂停。

**三种组合的语义**（这是设计的关键，不是含糊的"心跳"）：

| 状态 | 推进 | 执行 | 行为 |
|---|---|---|---|
| 正常 | ✅ | ✅ | 事件驱动 + 巡检，全速跑 |
| 只剩推进 | ✅ | ❌ | **暂停**：置 `paused_no_window`，不派发；在跑批次把 deadline 折算成 `remainingMs` 冻结，窗口回来后 `deadline = now + remainingMs` |
| 全没了 | ❌ | ❌ | 应用已退出：状态在磁盘，下次启动由恢复流程接手（§5.3.5） |

冻结/重算这一步不能省：否则暂停 30 分钟后恢复，在跑批次会立刻超时被判 stalled。

### 5.3.2 supervisor 的判定依据：**自己的账本，不问前端**

这是原设计最大的漏洞。如果 supervisor 每次都要问前端"这个会话还在跑吗"，那它又依赖 UI 了，
和"心跳绑在会话上"是同一类错误。

**正确做法：只用自己写下的时间戳判定。**

```
起轮成功时写入：  batch.dispatchedAt = now,  batch.deadline = now + batch.timeoutMs
巡检时判定：  now > batch.deadline 且 该批无新 report  →  stalled
```

- `batch.timeoutMs` 默认取 `policy.batchTimeoutMs`（默认 20 分钟），审批卡可按批覆盖。
- **不需要向前端询问「还在跑吗」**——时限判定完全自足。前端只**主动推送**回合生命周期事实
  （`turn_finished` / `turn_failed` / `waiting_*`，§5.1.2），用来区分「自然结束没回报」和「卡住」，不参与 deadline 计算。
- 会话"假装在跑"（streaming 但卡死）也兜得住：照样超时、照样判 stalled。

**第四个判定：会话消失了怎么办**（这条不靠时间，靠存在性检查）

```
巡检时：batch.sessionId 非空 且 该会话已不在会话表里  → session_gone
       → 与 stalled 同样处理（按 attempts 重派新会话）
```

会话被删、或用户手动清理了会话列表，都会命中这条。**不要等 deadline 到期**——
会话都不存在了，等下去毫无意义。

三条判定的优先级：`session_gone` > `stalled`（deadline 超时）> 无动作。

### 5.3.3 派发的两阶段握手（防多窗口重复派发）

`orchestration-dispatch` 会到达归属工作区的多个窗口。若两个窗口都起轮，就双开了。
**原稿只有一个 `ClaimBatch` + `CLAIM_TTL`，有两个漏洞**：① 没有任何绑定负责写 `dispatchedAt`（「前端起轮后再写」是空话）；
② 认领 90 秒后 TTL 过期，而 `ClaimBatch` 只看 TTL——**已经起轮的批次会被第二个窗口再次认领**，正好造成它要防的双开。

**派发 = 认领 + 起轮确认，两步各有绑定**：

```
1. 窗口收到 dispatch 事件（按工作区过滤）→ 调 OrchestrationClaimBatch(id, batchId, expectedAttempt)
   Go 在状态锁内：batch.status 必须仍是 dispatched、expectedAttempt 匹配、无未过期 claim
                → 写 claimedBy / claimedAt，签发 claimToken；否则返回 false
2. 认领成功 → 前端建会话（group 取 groupSnapshot、scope 收紧、model 已校验）→ 调
   OrchestrationStartBatch(id, batchId, claimToken, sessionId)
   Go 在状态锁内：再次核对 claimToken → attempts++、写 sessionId / dispatchedAt / deadline、status=running、
                签发 executionToken（§5.1.0）、**作废 claimToken**
3. 前端拿到 executionToken 后才发首轮消息；起轮立即失败 → 调 OrchestrationAbortStart(id, batchId, executionToken)
   Go 吊销 executionToken、清 claim、回到 pending，并 **attempts--**
   （AbortStart 只允许在「尚未发出任何模型请求」的基础设施失败时调用；一旦发过请求就必须走 failureReason，不许回滚计数）
```

- **`CLAIM_TTL`（90 秒）只约束「认领后多久必须完成 StartBatch」**，与首轮响应、`batchTimeoutMs` 无关。
  一旦 `dispatchedAt` 写入，`ClaimBatch` 因 `status !== dispatched` 永远返回 false——不存在「TTL 过了再认领一次」。
- StartBatch 之前窗口崩了 → claim 过期，supervisor 清 `claimedBy` 重发广播（唯一允许的重发条件）。
  StartBatch 之后窗口崩了 → 走 §5.3.2 的 `session_gone` / `stalled`，不走重发。

**实施前提已核实（纠正一处误判）**：`startSessionTurn` 末尾是
`startRound(run); return {ok: true, run}`——**它不等整轮结束**，起轮准备完成即返回
（会 await `whenIdle` / 租约 / `assembleSystemContext` / 生命周期钩子，几秒量级）。
所以**不需要新起轮入口**，但必须**分两步调**，不能直接用 `bridgeNewSession({message})` 一步到底：

```
1. bridgeNewSession({ title, scope, model, group })   // 不带 message：只建会话，不起轮
   → 返回 sessionId
2. OrchestrationStartBatch(id, batchId, claimToken, sessionId)
   → Go 写 dispatchedAt / deadline / status=running，签发 executionToken 并挂到该会话上
3. 前端用 sessionId 起轮：startSessionTurn(session, spec)
   → 此时 executionToken 已在 session 上，模型调 orchestration_report 时由前端自动附加
     （模型既看不到 token，也伪造不了——传参里没有它）
```

**为什么不把 token 塞进首轮消息**：那要求模型"记得带上"，而它不该知道这个字段存在。
token 挂在**会话**上、由前端在工具调用时注入，才是"模型改不了"的正确形态（同 §5.1.0）。

**必须配套的防护**：supervisor 巡检不得每轮重发广播。emit 前检查 `dispatchAt`，已发且 claim 未过期就跳过。

**状态字段**：

```js
batch.dispatchAt    // 发出广播的时刻（防重复广播）
batch.claimedBy     // 认领成功的窗口名
batch.claimedAt     // 认领时刻（CLAIM_TTL 计时起点）
batch.dispatchedAt  // StartBatch 成功的时刻（§5.3.2 超时判定起点）
```

### 5.3.4 supervisor 自身自愈（它也是代码，也会卡）

goroutine 可能**不死也不工作**（mutex 死锁、channel 阻塞），这是最阴的失效——进程还在，
看起来都正常，实际什么都没推进。

**先说清 Go 的限制**：goroutine 不能被强杀。「重启 supervisor」只有在旧实例**自己退出**之后才安全；
否则就是两个调度器并存，比卡死更糟。所以设计重点前移到「让它卡不住」，重启只是兜底。

| 防护 | 做法 |
|---|---|
| panic | 每轮巡检放进独立函数并 `defer recover()`，捕获后置该编排 `fault` + 上报，**不让 panic 打穿进程**，循环本身继续 |
| 结构上防卡死 | 状态锁内**只做内存读写**，不发事件、不调前端、不跑命令、不写日志文件；这些一律在锁外做。外部调用都带 `context` 超时 |
| 静默卡死 | 巡检每轮更新**内存中的** `lastTickAt`（原子变量）；看门狗每 30s 检查 `now - lastTickAt > 3×巡检间隔` |
| 看门狗触发 | 先 cancel 旧 supervisor 的 context 并等它退出；**确认退出后**才起新实例并记 warn。宽限期（默认 30s）内不退出 → 不再起新的，置 `fault` + `notify_send`，提示用户重启应用 |
| 看门狗也死 | 接受；用户在看板上能看到「最后推进于 X 分钟前」，不会毫无线索 |

`lastTickAt` **不写进 `<id>.json`**：否则文件 mtime 每 30 秒都动，§5.3.7 基于 mtime 的审计就失效了。
状态文件只在业务状态真正变化时写。

**巡检间隔自适应**（省电，也避免空转）：

| 编排状态 | 间隔 |
|---|---|
| 有 `running` / `verifying` 批次 | 30s |
| 只有 `pending` 且依赖未满足 | 5 分钟 |
| 全部终态（done/failed/cancelled） | 停止巡检该编排，从集合移除 |

### 5.3.5 冷启动恢复（应用重启后）

supervisor 启动时扫一遍全部编排：

| 磁盘上的状态 | 恢复动作 |
|---|---|
| `status=running` 且有 `dispatched`/`running` 批次 | 前端回合已随进程消失（会话记录本身可能还在）→ 当前尝试按 `stalled` 结束，`attempts` 未满则重派新会话，已满则进 L2 |
| `status=running` 但只有 `pending` 批次 | 正常继续（依赖满足就派） |
| `status=running` 且有 `verifying` 批次 | verify 子进程可能被强杀或仍在跑：**结果一律作废**，重新进入静默屏障后复跑 |
| `status=paused_no_window` | 保持暂停；归属工作区出现可用窗口后恢复并重算 deadline |
| `status=fault` | **不自动恢复**（那是自检失败，需要人看决策日志，§5.14 防线 3） |
| `status=stopped` / `awaiting_user` | 保持原状；等待态的计时器在恢复时按剩余时间重建 |

**关键点**：重启后不要试图复活旧会话——会话可能已被删、上下文已丢失。
**spec 在状态里（§4.2），新会话从 spec 重来**，这是持久化设计的直接红利。

### 5.3.6 边界与已知限制

| 情形 | 行为 |
|---|---|
| 窗口全关 | `paused_no_window`，不派发、不烧钱（已定，§9.1 #18） |
| 用户手动停 | `stopped`，supervisor 不再推进该编排（§5.8） |
| 用户手动继续 | `running`，supervisor 重新纳入集合 |
| 编排卡在 `awaiting_user` | 不算 stalled（那是正常等待）；`awaiting_user` 有自己的超时语义（§5.11.1） |
| 编排卡在 `awaiting_arbitration` | 同样不算 stalled；但 L2 投递失败时会降级通知用户（§5.13.2） |
| 应用被强杀 | 状态已落盘（atomfile），下次启动走 §5.3.5 |

### 5.3.7 第二层兜底：编排审计者（auditor）

**为什么需要**：supervisor 是"推进者"，它的失效有两种：
① **不跑了**——看门狗能治（§5.3.4）；
② **跑着但判定错了**——比如依赖判定有 bug 导致某批永远判不出可派，或者永远判不出 stalled。
看门狗只看"巡检有没有执行"，**看不出"判定对不对"**。这种"活着但错着"是最难发现的。

所以需要**一个独立视角的观察者，用不同的判据**。这是工程常识：watchdog 的 watchdog。

**但它必须是"审计者"而不是"第二个调度器"**——否则会把 supervisor 的 bug 一起复制过来。

#### 三条铁律（违反则不如不做）

| # | 铁律 | 原因 |
|---|---|---|
| **1** | **不重复 supervisor 的判断逻辑** | 审计者只看**粗粒度的"有没有进展"**，不碰依赖图、不算 attempts、不判 verify |
| **2** | **只报警与软恢复，不推进业务** | 它**绝不**直接派发 / 判 stalled / 改批次状态——那是 supervisor 的职责，两套调度互相打架是最坏结果 |
| **3** | **判据基于持久化文件的事实，不基于 supervisor 的内存记账** | 读磁盘上 JSON 的内容与 **mtime**，不读 `lastTickAt`（它每轮都动，读了等于没审计） |

#### 判据：两条独立的强异常信号

只审计 `status=running` 的编排。`paused*` / `stopped` / `awaiting_user` / `awaiting_arbitration` 本来就不该有进展，
不在审计范围内——原稿没排除等待态，一个等用户 overnight 的编排会在 2 小时后被误报。

| 信号 | 阈值 | 含义 |
|---|---|---|
| `orchestration.json` 的 mtime 距今超过 `auditIdleMs` | 2 小时（**必须 ≥ 2 × 所有批次中最长的 `timeoutMs`**） | 编排号称在跑却完全没有任何状态变化 |
| 存在 `running` 批次，且 `now > batch.deadline + 3 × batch.timeoutMs` | 按该批自己的超时算 | 单批严重超时且无人处置 |

**两个阈值为什么必须这样取**（否则会误报）：

- 一批正常跑着、**没到回报点就不会有状态变化**，所以 mtime 不动是正常的。
  `auditIdleMs` 必须比「最长合理静默期」长——supervisor 最晚在 `batch.timeoutMs` 判 stalled 并写状态。
  由于批次可各自覆盖 `timeoutMs`，校验必须用**实际最长的那一批**，不能只比 `policy.batchTimeoutMs`。
- 信号 2 比信号 1 更早触发，这是刻意的：**单批严重超时比整体静默更紧急**。
  但在 supervisor 正常工作时信号 2 走不到——它早在 deadline 就判 stalled 并重派了。
  **能走到信号 2，本身就说明 supervisor 失效。**

任一命中即判 `audit_anomaly`（**只记在审计日志，不改编排状态**）。

#### 动作：软恢复 + 上报

```
1. 请求重启 supervisor：cancel 旧 context → 等它退出（宽限 30s）→ 确认退出后才起新实例
   —— Go 不能强杀 goroutine；旧实例不退出就**不起新的**（否则两个调度器并存）
2. 记一条审计日志（带两条信号的实测值，便于事后定位）
3. 重启后一个审计周期（默认 30 分钟）内仍无进展，或旧实例退不出
   → 只做 notify_send 给用户 + 看板标红「需要人工处理 / 重启应用」，**不置 fault**
```

第 3 步原稿写的是「置编排 fault」，与铁律 2「绝不改业务状态」自相矛盾。`fault` 只能由 supervisor 自己的自检写；
auditor 只能通过它自己的审计记录和通知表达异常。

#### 实现形态：独立 goroutine，**不复用 `aischedule`**

| 方案 | 判断 |
|---|---|
| 复用 `internal/aischedule` | ❌ 它的语义是"触发 AI 会话"，审计不需要 AI；且会在用户的定时任务列表里冒出一个内置任务 |
| **orchestration 包内独立 goroutine**（推荐） | ✅ 与 supervisor 明确隔离（不同 goroutine、不同判据、不同频率），不引入用户可见的"系统任务" |

- 频率：默认 **30 分钟**一次（比 supervisor 的 30s 粗两个数量级——它本来就不该高频）。
- 开关：跟随编排功能的总开关，不单独设设置项（避免用户关了它以为还有保护）。
- 代码量预算：**≤ 150 行**。它必须简单到"即使有 bug 也只会多报警，不会破坏正常流程"。

#### 它能兜什么 / 不能兜什么（必须诚实写明）

| 情形 | auditor 能否兜住 |
|---|---|
| supervisor goroutine 卡死（mutex/阻塞）但进程在 | ⚠️ 信号 1 命中 → 请求重启；**旧实例肯退出才算兜住**，不肯退出只能告警要求重启应用 |
| supervisor 判定逻辑错（永远判不出该派的批次） | ✅ 信号 1 命中（mtime 不动）→ 重启；重启后仍错 → 交人 |
| supervisor 疯转（反复派发又失败） | ⚠️ 部分：护栏（§5.14 防线 2 单位时间派发上限）负责拦，auditor 只做二次确认报警 |
| arbiter 死了且交接失败 | ✅ 如果因此编排卡住，信号 1 会命中；但 auditor **不代替交接**，只报警叫人 |
| 应用进程已退出 | ❌ **兜不住**——auditor 也在进程内。靠冷启动恢复（§5.3.5） |
| 应用从未启动 | ❌ 无人能兜 |

**最后两行是关键**：这个兜底覆盖的是"进程活着但内部坏了"，不是"进程不存在"。
进程死掉只有一条路——状态已落盘，下次启动恢复。**不要指望任何定时器能唤醒一个没运行的程序。**

#### 与三层心跳的关系（完整图景）

| 层 | 载体 | 保的是 | 死了怎么救 |
|---|---|---|---|
| 状态真源 | Go 磁盘 | 事实 | 应用重启后读回 |
| **推进（supervisor）** | Go goroutine | 调度能力 | 看门狗重启（§5.3.4） |
| **审计（auditor）** | Go goroutine（独立） | **"推进是否真的在推进"** | 无（它是最外层；它自己坏了靠人去设置页看） |
| 判断（arbiter） | 可替换会话 | 裁决能力 | 交接（§5.13.4） |

**auditor 自己坏了怎么办**：接受。三层都坏属于不可恢复级故障，
但**看板上有一行"上次推进 / 上次审计：X 分钟前"**，用户能立刻看出"这个编排很久没动了"——
不需要用户理解内部结构，只需要看见时间戳不再前进。

### 5.4 verify 由编排器复跑（解 Q1）

**不采信会话自报**：`report.status === 'done'` 后，批次进 `verifying`，编排器**自己**跑 `batch.verify`：

- 全绿 → `policy.review` 开则进 `reviewing`，关则直接 `done`
- 有失败 → `failureReason = verify_failed`；`attempts < max` 回 `pending` 重派（把失败输出喂回去），否则 `failed` → L2
- **verify 必须在静默屏障内跑**（§5.2.2）：同一工作区没有 Worker 在写的时候才启动，否则测到的是别人的半成品

**为什么关键**：Q1 那晚的教训——"声称完成"可以是错的，而且当事人自己不知道自己错了。
复跑是最便宜的客观判据。

**命令形态：exe + argv，不是 shell 字符串**

```js
verify: [{file: 'npm', args: ['run', '-s', 'test:ai'], cwd: 'frontend', timeoutMs: 300000}]
```

- 创建编排时校验：`file` 必须是路径或 PATH 上的可执行名；**不允许** shell 元字符、管道、重定向、`&&` / `;`。
  `cmd /c "..."/ sh -c "..."` 这类包装默认拒绝（要用须在审批卡上单独列出并确认）。
- `cwd` 必须落在 `batch.workspace` 内；环境变量按白名单透传。
- 审批卡**逐条显示完整命令**（原稿的五项里没有它——用户批的是「会跑什么」，不能只看到「有 verify」）。
- 单条超时默认 300s；stdout/stderr 各截断到 8 MB；超时/取消**终止整棵进程树**。
- **不是现成能力**：`cmdbridge` 已有 `procctl` 参数校验、工作目录校验、超时、runId 注册取消、进程树终止与输出上限，
  但 `runCommandSyncConfined` 未导出、通用接口上限 120s、也没有编排级串行队列。需要新建一个窄接口的 verify service，
  复用这些底层件。service 内部异步执行，绑定立即返回，**不得阻塞 Wails 调用**。
- **诚实声明残余风险**：测试/构建子进程本身可以写文件（产物、缓存、快照测试），`owns` 管不到子进程。
  所以 verify 命令被视为**用户已批准的受信任代码**，只保证「用户看得见、串行、有超时」，不保证它的写落在 owns 内。

### 5.5 审查门与返工（解 Q3 + 防 Q2 假绿）

**默认开**（2026-11-26 定）：编排创建时就带 `policy.review = true`，用户可显式关掉，
但默认值不留给"省事"——当晚没有审查就漏了 3 个 🔴，其中 1 个还是「声称已修、测试也绿、实际没接」。

`verify` 通过后进入 `reviewing`，派一次**审查会话**（与 Worker 同一条派发路径，不是 `spawn_agent`）。

#### 5.5.1 为什么不能用 `spawn_agent`（架构约束）

`spawn_agent` 是**前端 AI 工具**（`ai-panel.js` 的 `executeToolInner` 分支，需要 `ctx.session`），
而 Router 是 **Go 代码**——它无法直接调用前端工具。硬要调只有两条歪路：
让某个执行会话代调（那它得同时当执行者和审查者，违背"独立审查"），
或从 Go 反向驱动前端（把调度逻辑漏回 UI，与 §5.3.1 的设计相反）。

**定稿：审查也是"一次派发"**，走与 Worker 完全相同的机制（dispatch 事件 + `ClaimBatch` + 首轮注入），
只是 spec 不同：

```js
ReviewBatch = {
  id: 'review-B3',
  kind: 'review',
  reviewOf: 'B3',              // 被审查的 work 批次；**dependsOn 留空**（§5.5.2）
  spec: '你是只读审查者。审查 <B3 的 writeLog + 当前工作区 diff> ……（含反向验证要求）',
  owns: [],                    // 只读：所有权闸 + 工具表裁剪共同保证
  verify: [],                  // 审查不跑 verify
  model: policy.reviewModel || arbiterModelRef,
  scope: 'read',               // 权限档强制 read（ai_new_session 的「只能继承或更严」校验现成）
}
```

**审查范围要说实话**：本期不自动提交、不强制开始前快照，工作区里可能本来就有用户的未提交改动，
所以**没有可靠的「本批专属 diff」**。审查者拿到的是 `writeLog`（写闸实际放行的路径）+ 这些路径的当前内容 +
工作区 diff，并被告知「不要把既有未提交改动归到本批头上」。这是已知局限，不假装能做到精确归因。

**收益**：
- **架构一致**：只有一条派发路径，不需要"Go 反向调前端"或"跑在父会话里"的特例；
- **天然只读**：`owns: []` 让所有权闸把它挡住，不需要额外机制；
- **可重试可观测**：审查会话同样是独立会话，能在列表里看到、能单独重派、能看它的回报。

#### 5.5.2 审查批次存哪里：`batches[]` 里的 `kind` 字段（不进独立数组）

这是必须定死的结构问题，否则看板会出现"6 个批次怎么变成 12 个"的困惑：

```js
batch.kind = 'work' | 'review'    // 默认 'work'
```

- **进同一个 `batches[]`**：复用同一套状态机（pending→dispatched→running→done），
  不需要为审查单独写一套推进逻辑与认领机制。
- **看板按 `kind` 分层渲染**：工作批次是主行，审查批次作为该批的**子行**（缩进 + 「审查」标签），
  计数用「5/6 批（审查 5/5）」而不是「10/12」。
- **不能用 `dependsOn` 接到被审批次上**——这是原稿的死锁：
  `review-B3.dependsOn = ['B3']` 要求 B3 先 `done`，而 B3 又要等审查通过才 `done`，两边互相等，永远派不出去。
  正确关系是 `reviewOf = 'B3'` + `dependsOn: []`，由 Router 在 **B3 verify 通过时**直接激活它（内部触发，不走 DAG 门控）。
  同时 B3 置 `reviewing`；审查结论回写 B3。
- **`skipped` / `cancelled` 连带**：B3 被跳过或取消时，未派发的 `review-B3` 同步置 `cancelled`。
- 批次总数护栏（≤ 20）与 done 分母都**只数 work 批次**；审查批次另有自己的重试上限（默认 2 次）。

**为什么不放 `batch.review` 子对象**：那就得为它另写一套"派发 + 认领 + 超时判定"，
与 §5.3 的三层心跳重复，且 supervisor 要多一条分支。**复用一个数组比复用一个状态机更省事。**

**审查批次的 `owns: []` 是第一道边界**（§5.2 的写闸），**不是唯一一道**——Worker 本来就拿不到 Shell / 终端 / MCP，
审查批次同理，且 `scope` 强制 `read`。`owns` 与 `scope` 必须由 Go 侧在派发时写死，
**不允许 AI 在 spec 里自己声明**——否则审查者可以给自己开写权限。

**代价**：比 spawn_agent 多一次建会话开销（可接受，审查本来就该独立）。

#### 5.5.3 审查的输出契约

审查会话必须调的仍是 `orchestration_report`（同一工具），但用不同字段：

```
orchestration_report({
  batchId: 'review-B3',        // **审查批次自己的 id**，不是被审查的 B3
  status: 'done',              // 审查本身完成了
  notes: '<审查结论摘要>',
  review: {
    blocking: [{path, line, problem, fix}],   // 🔴
    shouldFix: [{path, line, problem, fix}],  // 🟡
    suggestions: [...]                        // 🟢
  }
})
```

**归属校验不需要特殊分支**：审查会话的执行票据绑定 `{batchId: 'review-B3', role: 'review'}`，
走的仍是 §5.1.0 同一条链（票据 → 批次 → session/attempt → 状态）。「B3 正在被谁审」由服务端的 `reviewOf` 决定，
**不接受模型在参数里指定目标批次**——原稿让审查者把 `batchId` 填成被审批次，等于把校验链的第 3、4 步手工绕开。
额外断言「B3 处于 `reviewing` 且本次 attempt 尚无 review 结论」防重复审查。

#### 5.5.4 判定与返工

- `review.blocking` 非空 → 判定本次尝试失败（`failureReason = review_failed`）：`attempts < max` 则**原批次**回 `pending`，
  重派 prompt = 原 spec + 问题清单 + 上一轮回顾；`attempts = max` 则 `failed` → L2
- 只有 `shouldFix`（🟡）非空 → 同上，但在 history 里标注「仅应修项」；仲裁者可在 L2 决定直接放行
- `blocking` 与 `shouldFix` 都为空 → `done`（🟢 建议只记录，不阻塞）
- 审查会话自己失败（`no_report` / 超时）→ 重派**审查批次**，**不消耗 work 批次的 attempts**；
  审查重试用尽 → `failureReason = review_unavailable`，B3 置 `blocked`，编排进 L2（`awaiting_arbitration`）

**原稿的「生成 rework 批次」已改掉**：返工就是原批次的下一次尝试。另建批次会绕过 `maxAttemptsPerBatch`，
并且它的 `owns` / `dependsOn` 又要重新定义一遍。

**针对 Q2（假绿）的硬规则**：审查 spec 里强制要求**反向验证**——
「对你认为已修的接线类断言，说明'如果把实现删掉，这条测试会不会红'」。这一句直接针对当晚那个假绿。

**审查不可用时不许静默放行**：`review_unavailable` 先走 L2；仲裁者不可用或决定交给人时升 L3，
由用户选择「重试审查 / 放行（记入 history）/ 停止」。**默认不放行**——"审查没跑成"和"审查通过"是两件事。

### 5.6 看板（可视化面板，解 O1/O2）

**新增虚拟标签页**（不是设置页里的 pane）——编排是"要长时间停留、要看大量内容、要和别的标签并列对照"的重面板，
正是 `core/tab-kinds.js` 注释里写的那一族。

`TAB_KINDS` 加一项：

```js
{marker: 'orchestration', kind: 'orchestration', icon: 'branch', label: '编排',
 resolve: (doc) => ({icon: 'branch', label: (doc.orchestrationSpec && doc.orchestrationSpec.title) || '编排'})}
```

（`icon` 需先在 `core/icons.js` 注册；`resolve` 让同类型按 doc 细分标题，与 `appPage` 同款。）

**同时**在 `APP_PAGES` 加一项（`{id:'orchestration', label:'编排', icon:'branch', group:'编排'}`），
让侧栏「应用页面」、菜单、命令面板都能直达，并显示历史编排列表。

**面板分三栏**（宽窗口三列、窄窗口上下叠）：

| 区 | 内容 | 数据来源 |
|---|---|---|
| **批次树** | 依赖图 + 每批状态色 + attempts + 耗时 | 编排状态（`batches[]`）+ `core/widget.js` 的关系图（已有能力，不引新库） |
| **执行会话** | 每个 running 批次对应哪个会话（可点击跳转）+ 状态 + token + 轮次 | `session_list` 数据 + 编排状态里的 `sessionId` |
| **子代理** | 当前批次的子代理树（复用 `buildAgentTree` / `flattenAgentTree`） | 已有纯函数，**直接复用**，不要重写 |

**为什么子代理区能直接复用**：`ai-agent-model.js` 已有 `buildAgentTree`（父子关系 + 成环兜底 + 同层排序）
与 `flattenAgentTree`（折叠父节点、guides 连线、key/guides/isLast 齐全），HUD 也用它。
编排面板只是把「哪批的会话」作为树根传进去。

**操作区**（全部走 `core/overlay-stack.js` 的确认卡，不新写弹层）：
暂停 / 恢复 / 跳过某批 / 强制重派 / **统一停止**（§5.8）/ 导出报告。

**失败诊断**按类别展示，每类一句下一步建议：
`no_report`（会话没回报）/ `verify_failed`（验收没过）/ `stalled`（超时无进展）/
`review_failed`（审查提出返工）/ `review_unavailable`（审查没跑成，不放行）/
`over_budget`（超预算）/ `blocked_by_dep`（上游失败）。

**真·设置项不随页搬走**（AGENTS.md 规则）：模型、并发上限、预算这类开关仍在设置页的编排 pane。

### 5.7 会话列表里的归属：挂在**发起会话**下（不并排）

> 注意用词：本节一律说「发起会话」（`parentSessionId`，永不变），不是「仲裁者」。
> 仲裁者会交接（§5.13.4），但列表归属必须稳定——不能因为换了仲裁者，批次就跳到另一个会话下面。

**现状可复用**：`ai-session-list.js` 的 `orderSessionsWithSides` 已实现「把支线会话插到发起会话之后」
（`session.sideOf` → 按活跃度铺平后再插回发起会话下，发起会话已删 / 成环时按普通会话处理）。
**但那是支线语义**：支线是「发起会话的分叉快照」，`switchSession` 会**重定向回发起会话**、内容在独立标签页里看。
编排批次会话不同：它要**独立打开**（就是那个会话本身），只是**视觉上归属**发起会话。

**设计**：新增字段而不是复用 `sideOf`。

```js
Session.orchestration = {
  id,            // 编排 id
  batchId,       // 批次 id（审查会话是 review-xxx 自己的 id）
  attempt,       // 派发时的尝试序号；重派会新建会话，所以一个会话只对应一个 attempt
  role,          // 'work' | 'review' | 'arbiter'
  parentSessionId, // 发起编排的会话（列表归属用）
}
```

**列表渲染**（扩展现有树渲染，不动 `sideOf` 分支）：
- 发起会话下挂**一组批次子项**，缩进显示（缩进量同支线，图标用编排图标而不是 sidechat）
- 每行右侧带**批次徽标**：`2/6` 或状态点（running 蓝 / done 绿 / failed 红 / rework 黄）
- 点击 = **独立切到该会话**（不是重定向），与普通会话行为一致
- 发起会话行显示汇总「编排 5/6」，同时是这组的**折叠开关**

**折叠而不是归档**（定稿）：编排结束后批次会话**不归档**，只是**默认折叠**。

理由：归档会让会话从列表里消失，复查时得去「已归档」翻；而编排是"要能随时回看每批做了什么"的作业，
折叠保留了可达性、又不会撑开列表。

- **默认折叠**：发起会话行只显示汇总进度，批次子项收起。
- **折叠状态是内存态**，照 `ai-session-list.js:300` 的 `workspaceGroupOverrides` 同款做法
  （`Map<orchestrationId, boolean>`，不持久化、不写 localStorage）——重启后回到默认折叠，与工作区分组一致。
- **用户显式展开后记住**（同一次运行内），切标签、重新渲染都不丢。
- **一个自动展开的例外**：编排里有 `failed` / `blocked` 批次时**默认展开**，
  否则用户睁眼看到「5/6」还得点开才知道哪个挂了。发起会话行同时标红。
- 编排状态丢失 / `orchestration` 字段残缺时按普通会话处理（见下），不会出现"折叠里藏着会话"。

**健壮性要求**（照 `orderSessionsWithSides` 的既有标准）：发起会话已删除 / 编排状态丢失 / `orchestration` 字段残缺时，
按普通会话处理——**渲染不能因为元数据坏了就少一条会话**。

**仲裁者交接后列表不变**：交接只改 `arbiter.sessionId`，`parentSessionId` 与 `Session.orchestration` 都不动。
所以用户看到的位置稳定，只是点进去发现"现在负责仲裁的是另一个会话"（那里有交接记录，§5.13.4）。

### 5.8 统一停止

现有能力是三件，编排要串起来——**但它们分属前端与 Go 两层，Go 不能直接调前端函数**：

| 层 | 现有 | 位置 | 注意 |
|---|---|---|---|
| 会话回合 | `stopGeneration(stream)`：停子代理、取消等待/审批/提问、调 `backend.AIStop`、停工具消息 | `ai-panel.js` | 前端闭包；`stopSessionTurn` 只是对它的薄包装，stream 尚未注册时兜不住 |
| 子代理（级联） | `stopSubTree(agentId)` → `subTreeIdsOf` BFS | `ai-subagents.js` | 参数是 **`agentId`**，不是 `rootSessionId` |
| 命令进程树 | `AIStopShellRun(runId)` / `AICommandStop(jobId)`；交互终端 `TermClose(id)` | Go | 需要具体的 runId / jobId / termId |

**缺的东西**：一张「会话 → 它拥有的 agentId / runId / jobId / termId」资源登记表，和一个前端宿主级停止入口。
没有这两样，统一停止只能停掉模型流，后台命令和终端会变成孤儿。

**`orchestration_control(action: 'stop')` 的顺序**（用户看板按钮走用户控制绑定，顺序相同）：

```
1. Go：编排置 stopped，吊销全部执行票据与 claim（**必须第一步**）
   —— 否则正在跑的会话回报 done 会推进下游，停不干净；之后到达的 report 一律拒收
2. Go：直接停 verify runner（它本来就归 Go 管）
3. Go → 前端：向持有执行会话的窗口发 orchestration-stop 事件，带上要停的 sessionId 列表
4. 前端宿主：对每个 sessionId 调完整的 stopGeneration；
   再按资源登记表停子代理树、AIStopShellRun / AICommandStop、关闭终端；完成后回 ack
5. 未开始的批次置 cancelled（不是 failed——它们没失败）；保留已完成批次的结果与改动（不删、不回滚）
```

**窗口不在了怎么办**：步骤 3 没有接收方 → 编排保持 `stopped`，把「待确认停止」记在状态里；
该会话下次在任何窗口出现时先执行停止再允许别的操作。不强求「点了停止就一定立刻全停」，但**必须保证不会继续推进**（第 1 步已保证）。

**看板上的停止按钮**要显示影响面再确认：「将停止 3 个执行会话与 7 个子代理，保留已完成的 2 批改动」。
影响面数字来自资源登记表，不靠估算。

**停止是可恢复的**：`stopped` 不是终态，看板可「恢复编排」——把 `cancelled` 批次重新置 pending、重算 deadline。
这与「终止」语义分开：终止才清状态（且要二次确认）。

### 5.9 分组：继承**发起会话**，不显式指定

`ai_new_session` 支持指定 `group`（当晚我显式写了 `group: 'Agent'`）。编排**不要**这么做，理由：

- `group` 是**用户的组织维度**（"工作" / "写作" / "日记"），是长期分类；
  编排是**一次临时作业**。把执行会话塞进用户的 group，会在用户的分组里冒出几十个陌生会话。
- 现有 `ai_new_session` 的分组参数是给"用户手动新建"用的，编排自动派生不该占用它。

**定稿**：编排创建时把发起会话的 `group` **拷贝进 `groupSnapshot`**，之后每次派单都用这份快照：

- 发起会话有 group → 所有批次会话同 group（用户的分类习惯自然延续，不会多出一个组）
- 发起会话无 group → 批次会话也无 group
- **用快照而不是每次读发起会话**：长编排跑到一半用户改了分组、或发起会话被删，逐次读取会让同一个编排的批次散落到不同组里
- **归属靠 `orchestration.parentSessionId`**（§5.7），与 group 正交：
  group 决定"在哪个分组桶里"，`orchestration` 决定"挂在哪个会话下面"

注意 `ai_new_session` **目前不会自动继承 group**（省略就是不设分组），这条继承是待新增接线，不是现成行为。

这样列表里看到的是：`工作` 分组 → 发起会话「把 X 做完」→ 缩进的批次会话（带批次徽标）。
不需要用户理解"编排会新建一个分组"。

**仲裁者交接不影响 group**：交接只换 `arbiter`，新仲裁者仍是独立会话（它有自己的 group 或没有），
**不改变已派批次的 group**——那些是派发时定下的。


### 5.10 预算与熔断（解 O2）

- 每批记 `tokensUsed`（从会话用量统计读）与 `wallMs`
- 超 `policy.budgetTokens` → 不再派发新批次、不再为仲裁/重派起新轮，编排转 `blocked` 并发 `notify_send`
- `maxAttemptsPerBatch`（默认 2）用尽 → 该批 `failed`，下游保持 `pending`，进 L2 等仲裁

**预算是「事后熔断」，不是硬上限**：token 用量在模型响应**结束后**才上报（`ai-usage` 由前端流结束时记录），
并发中的多个 Worker 各自还能再烧一轮。所以文档与 UI 一律写「超出后停止派发」，不写「保证不超过」；
要更紧只能靠降低 `maxParallel` 或模型侧的 max_tokens，本方案不另造预估机制。

**查询不是现成的**：`usagestats` 目前只有全局分页的 `AIUsageStatsRequests`，没有按 sessionId 取用量的公开查询。
需要新增一个包内查询（按 SessionID 汇总 / 取最近一条），**不要新增 Wails 绑定**——它是 supervisor 内部用的。

### 5.11 断点续跑与人工拍板

- **续跑**：重派时**新开会话**，只注入该批 `spec` + 「上一轮做了什么 / 卡在哪」（从 `history` 取）。
  不依赖旧会话还活着。**新会话同样继承发起会话 group 与 `orchestration.parentSessionId`**（§5.9 / §5.7），
  所以续跑后列表里的归属不变。

#### 5.11.1 `awaiting_user` 的语义：照 `ask_user` 同款（2026-11-26 定）

`awaiting_user` 是**正常状态**，不是错误——某些批次（设计取舍、破坏性操作）本该有人决定。
但它**必须能自己走完**，否则一项无人值守的编排会永久挂住。

**语义完全照 `ask_user`**：

| 字段 | 含义 | 默认 |
|---|---|---|
| `question` / `options` | 带推荐项的问题（`recommended: true`） | — |
| `timeoutSec` | 等待时长 | 取**设置里 `ask_user` 的默认超时**（不另设一套） |
| `timeoutAction` | 超时后怎么办：`recommended` / `wait` / `abort` / `ai_decide` | 同上 |

**谁能提交、谁来决定超时动作**：

| 角色 | 行为 |
|---|---|
| Worker | 遇到需要用户偏好/外部信息的问题时提交 `awaiting_user`（带 `question`） |
| 仲裁者 | 收到 L2 事件后**先判断自己能不能决定**——能决定就直接用 `orchestration_control` 改派/回答，不惊动用户；确实超出判断范围才把问题升级给用户，并**必须**选定 `timeoutAction` |

选 `wait` = 「宁可挂住也要等」，选 `recommended` = 「超时按推荐的那个走」，`abort` = 该批 failed，
`ai_decide` = 交给仲裁者决定（仲裁者不可用时降为 `blocked`）。

**持久化与计时是新实现**：`resolveAskTimeout` 是前端 `ask_user` 工具的一部分，Go 编排器调不到。
这里复用的是**枚举与默认值来源**（设置里的 `askTimeout` / `askTimeoutAction`）；
`awaiting_user` 的落盘、重启后计时器重建、超时动作执行都要编排引擎自己写。

#### 5.11.2 自主执行模式：勾选后不许 `awaiting_user`（2026-11-26 定）

审批卡上加一个 `createCheckbox`：**「全程由 agent 自主执行」**，**默认不勾**。

| 模式 | 不勾（默认，协作） | 勾（自主） |
|---|---|---|
| `awaiting_user` | 允许，按 §5.11.1 的超时语义走 | **禁止** |
| 遇到无法决定的问题 | 提交 `awaiting_user` 等人 | **必须自己选一个**：要么按最佳判断继续（在 `history` 记「自主模式下的选择 + 理由」），要么报 `blocked` 失败退出 |
| 适合 | 涉及取舍 / 破坏性操作 / 用户在场 | 明确的机械性改造 / 用户不在场（睡觉） |

**实现强制力**：`policy.autoRun = true` 时，`orchestration_report` 收到
`status: 'awaiting_user'` **直接拒绝并要求重新回报**（错误信息见 §5.1.0）。

**自主模式只关闭「问用户」这一个通道，不等于提权**：既有的工具审批、`owns` 写闸、模型白名单、预算、
verify 命令清单全部照常生效；agent 不能借「自主」扩大 owns、换模型或跑未批准的命令。
遇到这些边界仍然只能 `blocked`。

**为什么这个开关值得单独存在**：它把"要不要叫我"从模型的自发行为变成**用户在批准时就定下的策略**。
勾了就该一路跑完，不勾就该在关键处停——不能由执行者临场决定，那正是当晚最大的浪费来源（每个小失败都要我醒）。

#### 5.11.3 开始前快照（可选，默认不勾）（2026-11-26 定）

**不做自动回滚**（改动是资产），但**可以提供快照**让用户留一条后路。

审批卡加 `createCheckbox`：**「编排开始前创建快照」**，**默认不勾**。

- 勾选 → 启动时调既有的 `WipeGuardSnapshot(workspace)`，结果记进 `orchestration.snapshot`
  （复用 wipe-guard 的备份库与查看/还原入口，**不新造快照机制**）。
- **必须处理「没拍成」**：该绑定在总开关/快照开关关闭、工作区不支持时返回 `{Skipped} **而不是 error**`；
  git 工作区超限或扫描超预算时不拍。勾了却没拍成 → 启动前明确告知用户，让用户选「不带快照继续 / 取消」，
  不能静默继续。`Excluded` 非空表示拍了但有文件没进去，同样要提示。
- `SnapshotResult` 没有 `At` 字段，时间戳由编排侧自己记。
- 不勾 → 不创建（大项目快照确实可能几百 MB / 几十秒，不该默认做）。
- **卡上要提示代价**：勾选框旁显示该工作区上一次快照的体积（有记录时），
  如「上次快照 240 MB」（让用户对时间与磁盘有预期）。
- 快照的用途**不是自动回滚**，也不是逐次写前备份，而是：万一编排把工作区搞坏，用户可以走
  设置 → 存储与清理 → 工作区防护 手动还原。这与 wipe-guard 自身的定位一致。

### 5.12 子会话失败如何回到仲裁者（分级通知，不打扰）

执行会话是**独立会话**（不是 `spawn_agent` 子代理），它失败时没人天然知道。三个通道按严重度分级：

| 级别 | 情形 | 动作 | 仲裁者？ |
|---|---|---|---|
| **L1 自动消化** | 瞬时/客观失败：`verify_failed`、`no_report`、`stalled`、`session_gone`、审查提出返工，且 `attempts < max` | 编排器自己重派（把失败原因喂进新 prompt），记 `history` | **不打扰**（只在看板可见） |
| **L2 需要仲裁者知情** | `report=blocked`（**一律进 L2**，它是判断性问题，自动重派只会原样再卡一次）/ 重派用尽 / `review_unavailable` / 仲裁者自己失效 | 投给**当前仲裁者**（`arbiter.sessionId`，不是 `parentSessionId`），带批次 id、失败原因、已尝试次数、建议动作，**并唤醒它** | 唤醒，但它可只回一句 |
| **L3 需要人** | `awaiting_user` / 整体 blocked / `fault` | `notify_send`（状态栏消息中心 + toast）+ 看板高亮；仲裁者同时收到 L2 那类投递 | 用户必须处理 |
| **完成通知**（不算 L3） | 编排整体 `done` | `notify_send` 一条汇总（**不是告警**，是成果汇报） | 仲裁者收到汇总做收尾 |

**完成为什么单独列**：它的语义是"做完了，来看看"，与 L3 的"出事了，来处理"完全不同。
混在一起会让用户以为每次完成都是异常。

**为什么 L1 不打扰仲裁者**：昨晚最大的浪费就是每个小失败都要我醒来判断——重试额度之内的事，
编排器自己能做。仲裁者叫醒一次就是一轮 token。

**L2 的投递形态**（关键）：不能只用普通 `session_send`——它的卡片标注「参考信息，非用户指令」，
母会话可能当闲聊忽略。设计一个**编排事件消息**（新的 `kind: 'orchestration'`）：

```
[编排事件] 批次 B3「工具路径改造」重派 2 次后仍失败
- 失败原因：verify 命令 `npm run -s test:ai` exit 1（12 个用例）
- 已尝试：2/2
- 可执行动作：重派（重置 attempts）/ 跳过该批 / 改 spec / 终止编排
- 看板：点击查看完整历史
```

**保证被看见的三条**：
1. 这类消息**投递即唤醒**母会话（空闲会话立刻起轮，忙则排队——`session_send` 已有语义）；
2. 消息体自带批次上下文与可执行动作，母会话不必回读文件就能决策（对应 D4：不重复烧上下文）；
3. **待仲裁事件以编排状态为准**：`session_send` 的信箱是内存态、有深度上限（10 条）、没有持久 QoS。
   所以 L2 事件先写进编排状态（`awaiting_arbitration` + 待处理事件），唤醒只是通知手段；
   唤醒失败、信箱满、应用重启后，supervisor 巡检时重新投递，直到仲裁被 `orchestration_control` 确认或被用户处理。
   每个事件带 `eventId`，仲裁回复带 `eventId + expectedGeneration`，防重复处理与旧仲裁者的陈旧回复。

**母会话自己死了怎么办**：L2 投递失败（会话已删）→ 降级为 `notify_send` 给用户（L3），
编排状态不受影响（§5.3.1：状态在 Go，与任何会话解耦）。

### 5.13 母会话：绝对上游的仲裁者（不是保姆，也不是执行者）

母会话**不承担编排的推进**（那是 Router 的事），也不干具体的活（那是 Workers 的事）。
它的价值全在**判断**：

| 动作 | 内容 | 为什么必须是它 |
|---|---|---|
| **发起** | 产出批次计划 → 走强制审批（§6.1）→ 启动 | 只有它知道用户到底要什么 |
| **异常仲裁** | Router 报 `fault` / 护栏触发 / 重派用尽时，决定：继续 / 改计划 / 砍批次 / 终止 | **Router 只会算确定量，不会判断"这次失败值不值得再试"** |
| **收尾** | 汇总、写工作日志、向用户汇报 | 它握着目标与原计划，能说清"最终达成到什么程度" |

#### 5.13.1 确定性 vs 判断性：职责分界线

这条线决定了哪些事必须上收，是整套设计的核心不变量。

| 归 Router（可穷举测试） | 归母会话（需判断） |
|---|---|
| 依赖满足了吗 | 这个 `verify` 失败是代码错还是测试写错 |
| `attempts` 用完没 | 该不该放宽某批的 `owns` 边界 |
| `verify` 的 exit code | 这次重派是必要的还是浪费 |
| 预算还剩多少 | 要不要砍掉某个批次、改计划 |
| 会话还在不在 | 这个 `blocked` 是真卡住还是模型偷懒 |

**实施要求**：Router 的代码里**不许出现**"猜"。任何拿不准的情况一律 →
置 `awaiting_arbitration` 并上报母会话，**不自作主张继续推进**。

#### 5.13.2 母会话缺席时（降级，不是崩溃）

| 情形 | Router 行为 |
|---|---|
| 母会话空闲 | L2 投递唤醒它（§5.12） |
| 母会话忙（在跑别的） | 排队，同时把该编排置 `awaiting_arbitration`（暂停下游，不阻塞已完成批次） |
| 母会话已删除 / 找不到 | **先尝试交接**（§5.13.4）；交接也失败才安全停止 |
| 交接也失败 | **安全停止**：不再派发新批次，`notify_send` 给用户，等人工处理 |

**不做"无人仲裁时按 AI 猜测继续"**——没有仲裁者时宁可停下等人。
这也解释了为什么心跳必须与会话解耦（§5.3.1）：母会话是**可替换的**，不是必需品。

#### 5.13.3 与昨晚的差别

昨晚我是"指挥 + 执行 + 汇报"三合一，上下文耗尽就等于项目停摆。

产品化后：
- **职责拆开**：我只做判断（仲裁），推进交给 Router，干活交给 Workers；
- **能力与实例解绑**：我不是"某个会话"，而是"仲裁者"这个**可交接的角色**（怎么保证，见 §5.13.4）；
- **上下文只装判断所需**：目标 + 计划摘要 + 若干争议点 + 汇总——几十轮跑完一个大型改造。

#### 5.13.4 母会话怎么保证不死（仲裁角色 ≠ 会话实例）

这是整条链最上游的节点，必须单独设计。**核心思路：把"仲裁能力"从"某一个会话实例"上解绑。**

类比：CEO 会休假，但"CEO 办公室"一直在，换个人坐进去就行。

##### 模型：`arbiter` 是一个可转移的角色

```js
Orchestration.arbiter = {
  sessionId,        // 当前担任仲裁者的会话
  generation,       // 世代号（每次交接 +1），防旧会话复活后乱改
  assignedAt,
  handoffs: [{from, to, at, reason}],  // 交接历史
}
```

**不是**"发起编排的那个会话"这种模糊概念——那样会话一死就无从追溯。

**generation 的作用**与窗口 `seq`、派发 `claim` 同源：单调递增，防止陈旧写入。
旧会话醒来发现自己的 generation 落后 → 它已成"前任"，**不能再仲裁**，只能转告或旁听。

##### 五层保障（从预防到兜底）

| 层 | 机制 | 触发条件 |
|---|---|---|
| **① 上下文瘦身** | 仲裁请求只带「目标 + 计划摘要 + 本次争议点」，**不带完整对话历史** | 每次都生效 |
| **② 预判式交接** | 仲裁者上下文使用率 > `arbiterRotateAt`（默认 70%）→ 主动开新会话交接 | 见下「使用率从哪来」 |
| **③ 失效检测** | 连续 `arbiterMissLimit` 次仲裁请求无响应（默认 2 次，各等 `arbiterTimeoutMs` 默认 10 分钟）→ 判定失效 | 无使用率上报也能工作 |
| **④ 交接** | 开新会话，注入**角色简报**（见下），`arbiter` 转过去，`generation++` | ②或③触发 |
| **⑤ 兜底降级** | 交接失败（模型不可用 / 归属工作区没有窗口）→ 所有 L2 升 L3，`notify_send` 给用户 + 暂停 | ④失败 |

新仲裁者必须用审批时固定的 `arbiterModelRef`。原稿写「Worker 默认继承仲裁者模型」——交接后仲裁者若换了模型，
未派批次就会跟着悄悄换档，绕过了 §5.15.1 的用户授权。所以继承的是**审批过的 ref**，不是「当前仲裁者碰巧在用的模型」。

**② 的「使用率从哪来」必须写清**（否则这条是空话）——而且**目前并不现成**：
- `ai-usage.db` 只存了每条请求的 `PromptTokens` 等事件，公开查询只有全局分页，**没有「按 sessionId 取最近一条」**；
  模型的上下文窗口也不在这个库里，而在前端模型配置（`contextWindow`）。
- 需要新增：① `usagestats` 包内按 SessionID 取最近一条有效事件的查询（不加 Wails 绑定）；
  ② 把该仲裁会话当前模型的 `contextWindow` 在创建/换模型时记进 `arbiter` 状态。两者都有才算得出使用率。
- 上报时机：每次 L2 事件投递前查一次（那是仲裁者即将消耗上下文的时候）。
- **拿不到使用率时**（老会话 / 未记账 / 模型不返回 usage / 模型没登记窗口）：**跳过 ②，只靠 ③**——
  不猜、不估算。这是"确定性与猜测分离"的同一原则。

**① 是根本**：如果仲裁请求带完整历史，那每次仲裁都在消耗仲裁者的上下文，交接也就变得昂贵
（新会话要读完历史才能接）。带上限在「目标 + 计划摘要 + 争议点」（角色简报 ≤ 2000 字），
任何新会话读一份简报就能上岗——注意 200 字装不下六批计划加卡点，别把上限写成做不到的数。

##### 角色简报（交接时注入，全部来自编排状态，不依赖旧会话对话）

```
你在担任一个编排的「仲裁者」。
- 总目标：<goal>
- 计划：<批次标题 + 状态的一行摘要，不含 spec>
- 已完成：5/6 批（最近：B5 工具路径改造，verify 通过）
- 当前卡点：B6 连续 2 次 verify 失败（`npm test` 12 个用例红），需要你决定：放宽 owns / 改 spec / 跳过
- 你的职责：只做判断性决策（§5.13.1）；确定性的事交给 Router
- 约束：除非用户要求，不要自己动手改文件（你是仲裁者，不是执行者）
```

**这是持久化设计的第二个红利**（第一个是 Workers 可重派）：交接只需读状态，不需读历史。

##### 交接时的用户可见性（重要，否则用户会困惑）

用户可能记得"我是在 A 会话里发起的，怎么 B 会话在问我"。

- 新会话创建时标题明确：**`编排仲裁·接替「<A 的标题>」`**（不是裸的"新会话"）
- 原会话（若还能打开）留一条消息：「仲裁者已交接给 <新会话>，原因是 <上下文将满 / 长时间无响应>」
- 看板的编排详情里显示交接历史（`arbiter.handoffs`），随时可查
- **不做静默交接**——静默会让用户彻底失去对"谁在做主"的认知

##### 为什么不是"让母会话干活时顺便续命"

有过的想法是"母会话定期总结自己、压缩上下文"（self-compact）。**不做**：

- 压缩本身要花一轮 token 与时间，且压缩可能丢关键信息；
- 更根本的是——**它把可靠性寄托在"被压缩的那个实例还活着"上**，而实例死亡正是我们要防的。

交接（换实例）比续命（救实例）可靠一个量级。

##### 与 §5.3.1 的关系

| | 心跳（§5.3.1） | 仲裁者存活（本节） |
|---|---|---|
| 保的是 | **推进能力**（Router） | **判断能力**（arbiter） |
| 载体 | Go goroutine | 可替换的会话 |
| 死了怎么救 | 看门狗重启 | 交接给新实例 |
| 都失效 | 应用退出 → 状态留磁盘 | 降级为用户仲裁 |

两者**互不依赖**：Router 可以活着而仲裁者全死（那就全部 L2→L3 等用户）；
仲裁者活着而 Router 卡死（那就有判断力但没推进，看门狗会重启 Router）。

### 5.14 Router 自己出问题怎么办（四重防线）

Router 是"绝对算法中枢"，但它**不是权威**——它是可被质疑、可被停下的确定性代码。

#### 防线 1：自检 fail-closed

| 情形 | 动作 |
|---|---|
| goroutine panic | `recover` → 置 `fault` → 停止派发新批次 → 保留已完成结果 → 上报 |
| 状态读写失败 | 同上（状态坏了就绝不能继续推进） |
| 状态机进入未知状态 | 同上（不做"尽力恢复"，那是最危险的做法） |
| 运行期发现依赖成环 | 同上（创建时静态校验过，出现即 bug） |

**核心**：`fault` 是**终态之一**，不是"重试几次再说"。宁可停，不可乱推。

#### 防线 2：硬性数值护栏（不依赖 Router 逻辑正确）

这些是**独立于状态机**的纯数值检查，即使 Router 的逻辑有 bug 也绕不过：

| 护栏 | 默认值 | 防什么 |
|---|---|---|
| 批次总数 | ≤ 20 | 计划失控 |
| 单批 `attempts` | ≤ 2 | 反复重派同一批 |
| 整个编排总轮次 | ≤ 200 | 上下文/时间无限膨胀 |
| 总预算 | 用户设定 | 烧钱 |
| 编排最长运行时长 | 24h | 挂死 |
| **单位时间派发次数**（10 分钟窗口） | ≤ 12 | **状态机 bug 导致的死循环派发** |

最后一条是我原来漏掉的：`attempts` 上限只挡"单批反复失败"，挡不住"依赖判定错了导致批次无限循环"。
所以需要一条**时间窗口计数**的独立护栏。

#### 防线 3：决策日志（事后可定位）

每次派发 / 重派 / 判定 `stalled` / 触发护栏，都往 `<id>.log.jsonl` 写一行**带理由**的记录：

```json
{"at":..., "kind":"dispatch", "batch":"B3", "why":"依赖 B1,B2 均 done 且并发 1/2", "input":{...}, "decision":"..."}
```

出事时能回答"它当时在想什么"，而不是只能看到"它做了什么"。

#### 防线 4：它是代码，靠测试保证（不靠 AI 审查）

这是根本区别——**批次执行是 AI，需要 AI 审查；Router 是代码，需要穷举测试。**

- 状态机必须表驱动穷举：依赖推进、`attempts` 计数、并发上限、未知态 fail-closed、护栏触发顺序。
- **dry-run 是纯模拟，不是「真状态推进但不派发」**：`Simulate(plan, script)` 接收一份脚本化的假事件流
  （report 到达 / verify 结果 / 超时 / 窗口消失），在内存副本上跑 Router，输出决策序列；
  **不写真实 `<id>.json`、不发事件、不建会话、不进 supervisor 集合**。真实编排里没有 `policy.dryRun` 这个开关。
- dry-run 同时服务两个场景：上线前的回归测试，以及审批卡上的「预览执行顺序」——后者让用户在批准前看到
  哪些批次会并行、哪些会因 owns 交集被串行、verify 屏障在哪。
- 崩溃恢复：状态在磁盘（§4.1），重启后从磁盘续；`running` 批次在恢复时按 `stalled` 处理并视 attempts 重派。

**验收标准**：dry-run 跑 agent-host-platform 那六批的计划，断言的是**不变量**（依赖顺序不被违反、并发数不超限、
owns 相交的批次不同时 running、attempts 不越界、屏障期间无派发），不是「与当晚人工编排逐条一致」——
当晚的顺序只是一次可行解，不是唯一正确解，拿它当黄金输出会让测试在等价重排上误红。

### 5.15 模型分配：贵在判断，省在干活

`ai_new_session` 已支持 `model` 参数（走子代理模型白名单，省略则继承调用方），基础能力现成。
编排在此之上定义分配策略：

| 角色 | 模型档 | 理由 |
|---|---|---|
| **仲裁者**（母会话 / 交接后的新任） | 用户发起时用的模型，审批时固定为 `arbiterModelRef` | 计划与仲裁判断密度最高 |
| **Router** | 不用模型 | 确定性代码 |
| **Worker（默认）** | `arbiterModelRef` | 省略即用它，行为可预期，交接也不变 |
| **Worker（杂活批次）** | 可显式指定便宜档（须用户授权，§5.15.1） | 照 spec 改文件，判断密度低 |
| **审查门** | 默认 `arbiterModelRef`，可显式指定（同一授权清单） | 审查需要判断力 |

**「审查不低于执行者」无法机械保证**：模型 ref 之间没有可靠的能力偏序，代码没法判断 A 是否「不低于」B。
所以这条改成**展示与提醒**：审批卡上并排列出执行者模型与审查模型，用户自己判断；
不写一个做不到的硬校验。默认两者相同，是最不容易出错的起点。

数据结构：

```js
Batch.model = {
  first: '<ref 或省略>',   // 首次尝试；省略 = arbiterModelRef
  retry: '<ref 或省略>',   // 重派时；省略 = 同 first
}
policy.reviewModel = '<ref 或省略>'  // 省略 = arbiterModelRef
```

**失败升级**：便宜模型第一次失败后，`retry` 可指到另一档——「先省钱试一次，不行再上贵的」。
但它**不是默认行为**：`escalateOnRetry` 默认改为 `false`，且只在用户勾选了模型授权、`retry` 在白名单内时才生效。
原稿默认 `true`，在「默认不许换模型」的前提下要么无效、要么悄悄绕过授权。

#### 5.15.1 换模型必须由用户在审批卡上显式授权（默认不许换）

**默认行为：`batch.model` 一律被忽略，所有 Worker 用 `arbiterModelRef`。**
这条不是保守，是成本纪律——派发换模型等于换钱与换能力，必须先有人点头。

审批卡的「模型委派」区块（走 `overlay-stack` 弹层，控件全部用 `core/form-controls.js` 工厂，
**禁止裸 `<input>` / `<select>` / checkbox**——`test/core/form-controls-factory.test.mjs` 按文件基线会拦）：

| 控件 | 默认 | 说明 |
|---|---|---|
| `createCheckbox`「允许编排为批次指定模型」 | **不勾** | 不勾 = 后续所有模型字段被忽略，全用 `arbiterModelRef` |
| `createInput` + 候选列表「允许指派的模型」 | 空 | 勾选后才出现；可输入（模糊匹配）或从候选点选；上限 5 条 |
| `createSelect`「审查模型」 | `arbiterModelRef` | 可选，但必须在同一白名单内；卡上与执行者模型并排显示（不承诺机械的「不低于」） |

**数据落到 `policy.allowedWorkerModels: ['<ref>']`**（存模型 ref 而非 label，label 会随配置变）。

**Router 的硬校验**（在派发前，不是派发后）：
- 白名单为空 → `batch.model` 全部忽略，用 `arbiterModelRef`（不报错，是正常路径）
- 白名单非空 → `batch.model.first` / `.retry` / `policy.reviewModel` 必须在白名单内；
  不在则**拒绝派发**、置 `awaiting_arbitration`，错误信息里带合法清单
  （照 `subAgentModelPick` 的既有做法：**白名单外一律抛错并附清单**，
  静默回落会让 AI 以为换上了，实际跑的是别的模型）

**为什么不用全局设置**：这是「本次编排允许多花多少钱」的授权，每次不同。
放进设置页会让用户以为"授权一次永久有效"，与成本门禁的初衷冲突。
（复用形态，不复用存储位置。）

**计划里出现白名单外模型时**：审批卡阶段就拦下并提示
「第 3 批指定了 `xxx`，不在你允许的清单里——请加入清单或让 AI 改用继承」，
不等派发时才发现。

**审批卡必须显示模型分配**（否则用户不知道自己批了多少钱）：每批一行 `批次 / 模型 / owns`，
以及"母会话模型"与"审查模型"两行。用户若用便宜模型发起编排，卡上要提示
「母会话模型较弱，仲裁质量可能下降」——**如实提示，不做拦截**。

---

## 6. 规划从哪来（人机交界）

**沿用已有计划审批的交互语义与卡片样式，但编排审批卡本身是新组件**（原因见下）：

1. 用户：「把 X 做完」
2. AI 用 `orchestration_plan` 产出结构化批次表（`title` / `spec` / `owns` / `dependsOn` / `verify`）
3. 走一张**新的结构化编排审批卡**（视觉沿用 `submit_plan` 的卡片样式与「执行」语义）：批次列表 + 每批负责范围 + 依赖关系 + 完整 verify 命令 → 点「执行编排」→ **Go 侧重新校验**后落盘并启动
4. 用户可改：删批次、调依赖、改 owns / verify / 超时（在卡上直接编辑，不走对话）

**这是新组件，不是复用**：现有 `renderPlanTakeover` 只支持 Markdown 预览、命令预授权勾选、切换隔离区、继续规划、执行——
**不支持编辑计划正文或命令**，更没有批次/依赖的概念。新卡需要独立的 draft 状态、表单控件、局部校验与批准载荷。
「复用」仅限样式、`overlay-stack` 确认卡与 `form-controls` 工厂；实现量按「中–大」估，不是「小」。
提交后 Go 侧必须把前端传来的草稿当作**不可信输入**整份重验（模型白名单、依赖、owns、verify），不能只信卡上校验。

### 6.1 发起必须审批，**任何权限档都不例外**

这是**成本门禁**，不是权限门禁——与 `auto` / `full` 档"写操作免审批"是两回事：

- 编排会**新建多个会话、烧大量 token、改大量文件、跑很长时间**，
  一次误发起的代价远超单个工具的误操作。
- 因此 `orchestration_plan` **强制弹审批卡**，`scope === 'full'` 时也不跳过。
- 实现上不能复用「按档位决定弹不弹」的既有分支，要走**独立的强制确认路径**，
  并在工具描述里写明「本工具在任何权限档下都会请求用户确认，不要重试」。

**审批卡必须显示的六项**（缺一项用户就无法判断该不该批）：

| 项 | 为什么必须有 |
|---|---|
| 批次列表 + 每批 `owns` | 让用户看到"会改哪些目录"，这是当晚 C1 风险的人眼兜底 |
| 依赖关系 + dry-run 预览的执行顺序 | 让用户判断顺序合不合理（§5.14 防线 4） |
| **完整 verify 命令**（exe + args + cwd + 超时） | verify 是编排唯一会执行的子进程，且 `owns` 管不到它——用户必须看到具体跑什么 |
| **模型分配 + 换模型授权** | 见 §5.15.1：勾选是否允许指定模型、勾选后填白名单；每批显示用的模型——**不知道自己批了多少钱就等于没批** |
| 预估规模 | 批次数 × 每批大概轮次；**明确写"预估"**，不给假精度 |
| 预算上限 | 默认值可改；超限停止派发（§5.10，是事后熔断不是硬上限，卡上要这样写） |

**另外两个勾选框**（都默认不勾，见 §5.11）：

| 勾选框 | 勾了会怎样 | 不勾（默认） |
|---|---|---|
| **全程由 agent 自主执行** | `awaiting_user` 被禁止（§5.11.2），agent 必须自己决定或报 blocked | 关键处会停下来问你（照 `ask_user` 超时语义） |
| **编排开始前创建快照** | 启动时调 `WipeGuardSnapshot`（§5.11.3），旁注上次快照体积 | 不创建（大项目快照可能几百 MB / 几十秒） |

**卡上的校验要在提交前完成**（不是等派发），且 Go 侧提交后再跑一遍：
- 批次里指定的模型不在白名单 → 当场提示，让用户加入清单或改用继承
- 可能并行且 `owns` 可能相交的批次 → **自动串行并在预览里标出**（不是报错：这是 Router 该自己处理的事，§5.2.2）
- 依赖成环 / 依赖不存在 / work 批次依赖了 review 批次 → 拒绝提交（这是静态检查，运行期不该出现，§5.14 防线 1）
- verify 含 shell 元字符或包装器、cwd 在工作区外 → 拒绝提交
- 没有任何批次设 `verify` → 提示"这些批次改完无法自动验收"（不拦，但要说）

**二次确认的边界**：审批卡是**一次**，但只覆盖「已批准计划内的自动重试」。原稿把「跳过」也列进不再过问，与
§5.0「`orchestration_control` 强制审批」自相矛盾。口径统一为：

| 动作 | 是否再问用户 |
|---|---|
| Router 按 policy 自动重派（L1）、审查提出的返工、暂停后恢复 | **不再问**——都在已批准的 attempts / owns / 模型 / 预算内 |
| 仲裁者调用 `orchestration_control`：跳过批次、重置 attempts、改 spec / owns / verify、换模型、加预算 | **每次都问**——这些改变了用户批准过的边界 |
| 用户自己在看板上点按钮 | 只过影响面确认卡，不重复审批 |

只有 L3（§5.12：`awaiting_user` / 整体 blocked）才会主动叫人。

**为什么复用审批卡**：编排是"要花很多钱和时间"的动作，必须先让人看一眼边界与批次。
这是当晚最大的教训之一——我如果一开始就把六个批次和文件归属列清楚给用户看，
C1（文件越界）的风险会低得多。

---

## 7. 与现有系统的关系

| 能力 | 复用方式 | 改动量 |
|---|---|---|
| 会话创建 | `ai_new_session` 已有（分组 / 权限 / **模型**）；group 用 `groupSnapshot`（§5.9）、model 按批校验（§5.15）；起轮复用 `startSessionTurn`，按 §5.3.3 拆成建会话、StartBatch 签发票据、起轮三步 | 中（group 继承是新增；两阶段派发握手需接线） |
| 投递 | `session_send` 只作旁路与 L2 唤醒；**派单走首轮用户消息**、回收走 `orchestration_report`（§5.1.1）；L2 事件本体持久化在编排状态 | 小–中 |
| 子代理（审查用） | 不用 `spawn_agent`；审查是独立会话（§5.5.1）。看板只复用它的树渲染 | — |
| 子代理树渲染 | `buildAgentTree` / `flattenAgentTree` 纯函数，看板直接复用 | 无 |
| 级联停止 | 需新增「会话 → agentId/runId/jobId/termId」资源登记 + 前端宿主停止入口；现有三件分属两层且参数不同（§5.8） | 中 |
| 会话列表树 | `orderSessionsWithSides` 的渲染思路（**不复用 `sideOf` 字段**，见 §5.7）+ 现有分组折叠的 `workspaceGroupOverrides` 内存态模式 | 中（新增一类子项 + 折叠） |
| 通知 | `notify_send` 已有 | 无 |
| 用量统计 | `ai-usage.db` 已有事件；**按 sessionId 取用量/最近一条的查询要新增**（§5.10 / §5.13.4），不加绑定 | 小 |
| 计划审批卡 | 沿用 `submit_plan` 的样式与「执行」语义；**结构化编辑是新组件**（§6） | 中–大 |
| 表单控件 | `core/form-controls.js` 的 `createCheckbox` / `createInput` / `createSelect`（**禁止裸控件**，护栏会拦） | 无 |
| 模型选择 | `subAgentModelChoicesFrom` + `matchSubAgentModelChoice` 的「白名单 + 模糊匹配 + 越界报错带清单」形态可照抄；存储位置不同（编排 policy，非全局设置） | 小 |
| `ask_user` 超时语义 | `timeoutSec` / `timeoutAction` 的**枚举与默认值**取设置里 `ask_user` 的；持久化与计时要新写（§5.11.1） | 小 |
| 开始快照 | `WipeGuardSnapshot` 已有；需处理 `Skipped` / `Excluded` 非错误返回（§5.11.3） | 小 |
| **工具调用方身份** | **现无**：`OwnerForCall` 只给窗口名。需新增执行票据签发与校验（§5.1.0） | 中 |
| 虚拟标签页 | `TAB_KINDS` 加一项 + 该域视图工厂 + `bridge` 创建点 | 小（已有模式） |
| 应用页面入口 | `APP_PAGES` 加一项 + `bridge-app-page-view` 登记 + 该域 `mount()` | 小（已有模式） |
| 写闸 | `write_file`/`edit_file` 前加 Go 断言；`PatchApply` 在 Go 侧单独加；Worker 裁掉 Shell / 终端 / MCP（§5.2） | 中 |
| verify runner | 复用 `procctl` / 超时 / runId 取消 / 进程树终止 / 输出上限；**窄接口 service 要新写**（§5.4） | 中 |
| 新增 AI 工具 | `ai-tool-defs.js` + `AI_TOOL_CATALOG` + `AI_TOOL_GROUPS` + 执行分支 + 工具卡元数据 + mock | 中（有守卫测试兜底） |
| Go 引擎 | 新建 `internal/orchestration/`（零 Wails 依赖，`Service` 只暴露必要方法） | 中–大 |

**新增绑定面**（必须同步基线 + `gen-backend-types` + mock；下表按职责列，**不再承诺一个凑出来的总数**）：

| 绑定 | 用途 | 调用方 | 鉴权 |
|---|---|---|---|
| `OrchestrationCreate` | 创建（含审批后的草稿与 policy）；Go 侧整份重验 | 审批卡 | 可信窗口 + 工作区 |
| `OrchestrationList` / `OrchestrationGet` | 列表 / 详情，**按调用方工作区过滤** | 看板 / `orchestration_status` | 可信窗口 → 工作区 |
| `OrchestrationReport` | 接收编排回报（含归属校验，§5.1.0） | `orchestration_report` | **执行票据** |
| `OrchestrationControl` | 仲裁者的控制动作（暂停 / 恢复 / 停止 / 跳过 / 重派 / 改未派发批次） | `orchestration_control` | 当前仲裁者会话 + `expectedGeneration` + 审批卡 |
| `OrchestrationUserControl` | 看板按钮的同名动作 | 看板 | 可信窗口 → 工作区 + 影响面确认卡；**不冒充仲裁者** |
| `OrchestrationDelete` | 删除编排记录（仅终态；**不删会话、不回滚改动**） | 看板操作 | 同上 + 二次确认 |
| `OrchestrationClaimBatch` | 认领派发，签发 claimToken | 派发宿主 | 可信窗口 + 工作区匹配 + `expectedAttempt` |
| `OrchestrationStartBatch` | 起轮前确认：attempts++、写 dispatchedAt、签发 executionToken | 派发宿主 | claimToken |
| `OrchestrationAbortStart` | 起轮前基础设施失败时回滚 claim 与 attempts | 派发宿主 | claimToken / executionToken |
| `OrchestrationAuthorizeWrite` | 写路径所有权校验并追加 writeLog | 写工具宿主 / PatchApply 内部复用 | 执行票据 |

原稿的 `OrchestrationAdvance` **删除**：report 到达时 Go 已在同一把锁内推进，再让前端调一次 Advance
只会制造第二个推进入口和竞态。`Report` 与两个 `Control` 的副作用方法**不能只信前端传参**，鉴权列就是硬要求。

**新增事件**（Go → 前端）：
`orchestration-dispatch`（发到归属工作区的窗口，携带 `{orchestrationId, batchId, expectedAttempt}`，各窗口调 `ClaimBatch` 争认领）、
`orchestration-stop`（定向发给持有执行会话的窗口，§5.8）、
`orchestration-changed`（状态变化，看板刷新用，按工作区过滤）。三者都要在 `EVENT_SCOPES` 登记。

---

## 8. 分期

| 期 | 内容 | 能解决 | 人日 |
|---|---|---|---|
| **P0 内核与预览（只 dry-run）** | 数据模型（含 `arbiter` 角色、`groupSnapshot`、完整状态枚举）+ JSON 存储 + 服务端工作区过滤 + 执行票据与可信身份 + `orchestration_report`（含归属校验与幂等）+ 派单注入上游摘要 + 依赖门控 + 状态机穷举测试 + **纯模拟 dry-run** + 可编辑审批卡（含 dry-run 预览；自主执行 / 快照勾选框随各自功能在 P2 / P3 出现，不提前摆一个无效控件）+ 看板标签页（批次树 + 事件流）+ 会话列表归属（§5.7）+ **两阶段派发握手（§5.3.3）** + **只读设计讨论批次的真实派发**（owns 为空、scope=read，用来验证握手与 report 闭环） | D1 D2 D3 O1 | 12–14 |
| **P1 受控写入闭环** | 文件所有权闸（Go 比对、补丁单独校验、Worker 工具裁剪，§5.2）+ 静默屏障（§5.2.2）+ verify runner + verify 复跑（§5.4）+ `no_report` / `session_gone` / `stalled` 判定与自动重派 + 冷启动恢复（§5.3.5）+ **暂停/恢复/停止与资源登记（§5.8）** + **预算熔断（§5.10）** + 硬性护栏全套（§5.14 防线 1–3） | C1 C2 C3 Q1 D4 D5 O2 | 8–10 |
| **P2 质量门** | 审查门（默认开 + 反向验证 + `review_unavailable` 不放行，§5.5）+ 返工 + 模型分配与换模型授权（§5.15）+ `awaiting_user` 超时语义与自主模式（§5.11.1 / §5.11.2）+ 仲裁者交接（§5.13.4）+ supervisor 看门狗（§5.3.4） | Q3 Q2 O3 | 6–7 |
| **P3 自愈与打磨** | 审计者（§5.3.7）+ 开始前快照（§5.11.3）+ 看板执行会话/子代理树/交接历史 + 事件流水页 + 导出报告 | O1 | 3–4 |

**开放真实写入的门禁 = P0 + P1 全部完成**。原稿把写闸、verify、重派放在 P1，却让 P0 就「批准后创建并启动」——
那是一个没有所有权强制、没有验收、没有预算、也没有停止按钮的执行器。现在 P0 只跑 dry-run 和只读批次，
P1 结束前不向用户开放写入类编排。审查门（P2）未就绪前，创建时 `policy.review` 固定为 `false` 并在看板上明示
「审查门尚未启用」；P2 上线后才改为默认 `true`（§9.1 #2）。

**MVP = P0 + P1（约 20–24 人日）**。比初版翻了一倍多，原因是把原稿漏算的必需件补了回来：
可信身份通道、两阶段握手、补丁与命令的写闸边界、verify runner、资源登记与宿主停止、结构化审批卡。
这些不是加戏——少任何一项，P0/P1 都不能安全地对真实仓库派单。

**P0 为什么比初版重**：
1. **执行票据与可信身份 + 两阶段握手**（+2.5）：`OwnerForCall` 只给窗口名，归属校验的前提不存在；握手缺 StartBatch 环节；
2. **状态机穷举测试 + 纯模拟 dry-run**（+1.5）：Router 是唯一推进者，正确性不能留到后期；
3. **可编辑审批卡是新组件**（+1.5）：现有 `submit_plan` 不可编辑；
4. **列表归属**：从一开始就有，避免「先用看板、再补列表」的两轮改造。

**注**：估算前提是「会话创建 / 投递 / 表单控件 / 快照 / 树渲染可复用」。若实现时发现其中某件需要重写，按实际调整。

---

## 9. 已定与待拍板

### 9.1 已定（2026-11-26）

| # | 议题 | 决议 |
|---|---|---|
| 1 | 执行会话的列表处置 | **不自动归档，默认折叠**（§5.7）：折叠保留可达性、不撑开列表；折叠态是内存态，与 `workspaceGroupOverrides` 同款；有 failed/blocked 批次时自动展开并标红 |
| 2 | 审查门默认值 | **默认开**（§5.5）：**P2 上线后**编排创建即带 `policy.review = true`，用户可显式关；审查没跑成不放行（`review_unavailable`）。P0/P1 期间该值固定 false 并在看板明示「审查门尚未启用」（§8） |
| 3 | 编排发起的审批 | **任何权限档都强制审批**（§6.1）：这是成本门禁不是权限门禁；批准后内部重派/返工不再逐次问 |
| 4 | 心跳不依赖会话 | **三层能力分离**（§5.3.1）：状态真源（Go 磁盘）/ 推进能力（Go supervisor）/ 执行能力（有窗口）；三者缺失各有明确定义。supervisor 判定**只用自己账本的时间戳，不问前端**（§5.3.2）；派发走**认领机制**防多窗口双派（§5.3.3）；supervisor 自身有 panic recover + 看门狗自愈（§5.3.4）；重启后走冷启动恢复（§5.3.5）；窗口全关则**暂停**并在下次开窗恢复 |
| 4.1 | **第二层兜底（审计者）** | **加，但只做观察者不做调度者**（§5.3.7）：独立 goroutine（不复用 `aischedule`）、30 分钟一次、≤150 行；判据基于**持久化文件内容与 mtime**（不读 supervisor 的 `lastTickAt`）；两条强异常信号（2 小时无状态变化 / 单批超 deadline+3×自身超时）→ **请求重启 supervisor + 报警 + 记审计日志**，绝不直接派发/判 stalled/改批次状态/**置 fault**；重启须等旧实例确认退出，退不出则告警要求重启应用（Go 不能强杀 goroutine）。只审计 `running` 的编排。**覆盖"进程活着但内部坏了"的一部分，覆盖不了进程死掉** |
| 5 | 子会话失败的通路 | **三级分流**（§5.12）：L1 编排器自己重派不打扰 / L2 唤醒母会话决策 / L3 通知用户 |
| 6 | 架构分层 | **母会话 → Router → Workers 三级**（§3.3）：母会话是绝对上游（最强模型、有判断力），Router 是确定性代码（不用模型），Workers 可指定便宜模型 |
| 7 | Router 自己的可靠性 | **四重防线**（§5.14）：自检 fail-closed / 硬性数值护栏（含单位时间派发上限防死循环）/ 决策日志 / 穷举测试 + dry-run |
| 8 | 职责分界线 | **确定性归 Router，判断性归母会话**（§5.13.1）：Router 代码里不许"猜"，拿不准一律置 `awaiting_arbitration` 上报 |
| 9 | 母会话缺席 | **先尝试交接，再安全停止**（§5.13.2）：不做"无人仲裁时按 AI 猜测继续"；母会话是**可替换的仲裁角色**，不是必需品 |
| 9.1 | **仲裁者存活** | **仲裁角色 ≠ 会话实例**（§5.13.4）：`arbiter{sessionId, generation, handoffs}` 可转移；五层保障 = 上下文瘦身（请求只带目标+计划摘要+争议点）/ 预判式交接（使用率>70%）/ 失效检测（连续 2 次无响应）/ 交接（开新会话注入角色简报，generation++）/ 兜底降级为用户仲裁。**不做 self-compact 续命**（把可靠性寄托在实例还活着上，而那正是要防的） |
| 10 | 模型分配 | **贵在判断、省在干活**（§5.15）：仲裁模型在审批时固定为 `arbiterModelRef`，Worker 默认用它（交接不改变未派批次的模型）/ Router 不用模型 / Worker 可显式指定便宜档 / 审查默认同一模型、可显式指定；**不承诺「审查不低于执行者」的机械校验**（模型间无可靠能力偏序，改为审批卡并列展示）；`escalateOnRetry` 默认 **false** |
| 11 | 换模型须授权 | **默认不许换**（§5.15.1）：审批卡勾选「允许编排为批次指定模型」（默认不勾），勾选后用输入框 + 候选填白名单（上限 5，存模型 ref）；白名单为空则 `batch.model` 全部忽略、全用 `arbiterModelRef`；Router 派发前硬校验，白名单外**拒绝并附清单**，不静默回落 |
| 12 | **编排粒度** | **允许"设计讨论"类批次**（`owns` 为空 = 只读批次，产出走 `report.notes`），否则"先设计再实现"要拆两次编排 |
| 13 | **`awaiting_user` 语义** | **照 `ask_user` 同款**（§5.11.1）：超时与超时动作取 `ask_user` 的默认设置；母会话提交时须自选 `timeoutAction`（`wait` = 宁可挂住 / `recommended` = 超时按推荐走） |
| 14 | **自主执行模式** | 审批卡勾选「全程由 agent 自主执行」（**默认不勾**，§5.11.2）：勾选后 `awaiting_user` **被禁止**，agent 必须自己决定（记理由）或报 `blocked` |
| 15 | **开始前快照** | 可选、**默认不勾**（§5.11.3）：勾了启动时调既有 `WipeGuardSnapshot`，旁注上次快照体积；**不做自动回滚**，快照只作人工后路 |
| 16 | **跨工作区** | **允许，但本期只实现单工作区**（§12.1）：数据结构已按数组预留（`workspaces[]` + `batch.workspace`），校验层限制长度为 1 |
| 17 | **列表归属期次** | **P0**（原建议 P1）：列表缩进归属从一开始就有，避免"先用着看板、再补列表"的两轮改造 |
| 18 | **窗口全关** | **暂停**（§5.3.1）：按**归属工作区**判断——该工作区没有可用窗口就置 `paused_no_window`、冻结批次剩余时限，不烧看不见的钱；其他工作区的窗口不算执行能力；托盘隐藏不算关窗 |
| 19 | **报告归属校验** | **必须做**（§5.1.0）：用 **StartBatch 签发的执行票据**校验（`OwnerForCall` 只给窗口名，不够用），`batchId` / session / attempt 任一不符即拒绝；旧会话迟交报告不覆盖新尝试；幂等键是 `attempt + reportId` |
| 20 | **派单注入上游摘要** | **必须做**（§5.3.0）：只注入**直接依赖**的「改了哪些文件 / 关键结论 / 遗留」，≤1200 字；跨批信息由规划阶段写进后批 spec |
| 21 | **编排按工作区隔离** | **列表与看板在 Go 侧按调用方工作区过滤**（§4.1.1）：一个编排只有一个控制域（归属工作区）；跨工作区不做控制面板、不提供 CLI |
| 22 | **审查批次怎么接**（2026-11-26 审查修订） | 审查批次留在 `batches[]`，但用 **`reviewOf`** 指向被审批次、`dependsOn` 留空，由 Router 在 verify 通过时激活（§5.5.2）。原稿 `review-B3.dependsOn=['B3']` 与「B3 等审查通过才 done」互锁，是死锁 |
| 23 | **写闸的承诺范围**（审查修订） | 只承诺**受控写路径**强制（§5.2）：`write_file` / `edit_file` 走 Go 断言，`PatchApply` 单独校验；Worker **默认拿不到** Shell / 后台命令 / 终端 / MCP。verify 子进程视为用户已批准的受信任代码，`owns` 管不到它——如实声明，不称「系统级沙箱」 |
| 24 | **verify 与并行**（审查修订） | verify 命令是 exe + argv，不走 shell；每个工作区有**静默屏障**（§5.2.2）：有人验收/审查时不派发、等在跑 Worker 收手。owns 交集判不准就串行 |
| 25 | **attempts 与返工**（审查修订） | `attempts` 只在 StartBatch 成功时 +1；返工是**原批次**回 pending，不新建 rework 批次；`rework` / `review_unavailable` 不是状态而是 failureReason |
| 26 | **失败分流**（审查修订） | `report=blocked` 一律 L2（判断性问题，不自动重派）；只有客观/瞬时失败走 L1 |
| 27 | **开放真实写入的门禁**（审查修订） | P0 只跑 dry-run 与只读批次；**P0 + P1 全部完成后才开放写入类编排**（§8）。审查门 P2 上线前 `policy.review` 固定 false 并在看板明示 |
| 28 | **审批后的再确认口径**（审查修订） | 计划内的自动重试不再问；跳过 / 重置 attempts / 改 spec·owns·verify / 换模型 / 加预算**每次都问**（§6.1） |
| 29 | **dry-run 的形态**（审查修订） | 纯内存模拟（不写真状态、不发事件）；验收断言不变量而非「与当晚人工顺序逐条一致」（§5.14 防线 4） |

### 9.2 待拍板

**本期无待拍板项**——§9.1 共 31 条定稿（1–21 主编号、4.1 / 9.1 两个补充项、22–29 为 2026-11-26 审查修订新增）。
新增议题请追加到本节并注明日期。

未来议题（不计入本期）：
- 跨工作区编排的实际落地（§12.1 的接口已预留）
- headless 无人值守（窗口全关仍继续跑）
- 自动合并 / 自动提交

---

## 10. 验证

- 单测：状态机推进（依赖 / 并发 / attempts / 未知态 fail-closed / 护栏顺序）/ `assertWritable` 的 glob 匹配与越权拒绝 /
  `no_report` 判定 / verify 失败重派 / **单位时间派发上限** —— Go 表驱动 + 前端纯函数测试，登记进 `npm test`。
- **dry-run 不变量**：用脚本化事件流跑 agent-host-platform 六批的计划，断言依赖顺序不被违反、并发数不超限、
  owns 相交的批次不同时 running、屏障期间无派发、attempts 不越界；并断言 dry-run **没有**写真实状态文件或发事件。
  不拿「与当晚人工顺序逐条一致」当断言（等价重排会误红）。这是 Router 正确性的主要证据。
- **审查批次无死锁**：B3 verify 通过 → `review-B3` 被激活且 B3 进入 reviewing；审查通过 → B3 done。
  显式断言 `review-*.dependsOn` 为空，防止有人把它改回依赖被审批次。
- 工具守卫：`ai-tool-wiring.test.mjs` 会逐项对账（目录 / 档位 / 执行分支 / 工具卡 / 图标 / 参数提及）。
- 绑定面：`TestAppBindingBaseline` + `gen-backend-types` + mock。
- 端到端（人工）：用 agent-host-platform 的 F1+F4-Go 两批做真实回放——
  它们有明确的 owns（`internal/launchargs` / `internal/aibacking`）、可 verify（`go build` + 单测）、
  依赖清晰。这是现成的验收剧本。
- **模型分配验证**：① 未授权时 `batch.model` 被忽略、全部用 `arbiterModelRef`；② 授权后 `retry` 可换档；
  ③ 仲裁者交接后未派批次**仍用 `arbiterModelRef`**（不随新仲裁者实例漂移）；④ 审批卡并排显示执行者与审查模型。
- **换模型授权验证**：① 不勾选时 `batch.model` 被完全忽略；
  ② 勾选后填白名单，派发给白名单内的模型成功；③ 计划里写白名单外的模型 → **审批卡阶段拦下**，
  错误信息带合法清单；④ 白名单为空时静默继承（不报错，是正常路径）。
- **报告归属校验验证**（§5.1.0）：① 会话 A 提交 `batchId=B2` → **拒绝**（票据不符）；
  ② 已被重派替换的旧会话迟交报告 → 拒绝（attempt 不符）；
  ③ 批次已 `done` 后重复提交 → 拒绝并说明；**同 attempt + 同 reportId + 同正文重试 → 返回上次结果**（幂等）；
  同 reportId 不同正文 → 拒绝；
  ④ 非编排会话调用 `orchestration_report` → 工具根本不在它的工具表里；伪造调用直接到绑定 → 无票据被拒；
  ⑤ 仲裁者中途交接后，原 Worker 的合法 report **仍被接受**（generation 不参与 Worker 校验）；
  ⑥ `turn_finished` 无 report → `no_report`；`waiting_user` / `streaming 中` → **不判** `no_report`。
- **上游摘要注入验证**（§5.3.0）：① 派单 prompt 含直接依赖的「改了哪些文件 / 关键结论 / 遗留」；
  ② **不**递归注入间接依赖；③ 总长度 ≤ `spec + 1200 字`（dry-run 可断言）。
- **工作区隔离验证**（§4.1.1）：① 在 A 工作区窗口看不到 B 工作区的编排（Go 侧过滤，不是前端隐藏）；
  ② B 的窗口收到 B 的 dispatch 事件，A 的窗口收不到；伪造跨工作区 `ClaimBatch` → 拒绝；
  ③ 重开该工作区窗口能重新看到进度，deadline 按 `remainingMs` 重算。
- **执行模式验证**：① 默认（不勾自主）时 `awaiting_user` 正常暂停，超时按 `ask_user` 默认动作；
  ② 勾了自主后提交 `awaiting_user` → `orchestration_report` **拒绝并要求重新回报**；
  ③ 自主模式下 agent 自选并在 `history.autonomousChoice` 留痕。
- **单工作区约束验证**：① `workspaces.length > 1` 在创建时被拒（错误信息指向 §12.1）；
  ② `Batch.workspace` 恒等于 `workspaces[0]`；③ 写闸按 `batch.workspace` 解析 `owns`。
- **心跳与恢复验证**（§5.3）：① 派发后关掉**归属工作区**的全部窗口（其他工作区窗口仍开）→ 编排转 `paused_no_window`；
  重开后恢复，且在跑批次**不会**因暂停时长被判 stalled；② 派发后不回报，超 `batch.timeoutMs` → 判 `stalled`，
  `attempts < max` 重派、`= max` 进 L2；③ 两个窗口同时收到 dispatch → 只有一个 `ClaimBatch` 成功；
  **认领 90 秒后（CLAIM_TTL 已过）第三个窗口再调 ClaimBatch → 仍返回 false**（已 StartBatch 的批次不可再认领）；
  ④ 认领后 StartBatch 前窗口崩 → claim 过期后重发广播；StartBatch 后崩 → 走 stalled/session_gone，不重发；
  ⑤ 派发后立即强杀进程 → 重启后旧 `running` 批次按 stalled 处理、`verifying` 结果作废复跑，**不复活旧会话**；
  ⑥ `fault` 状态重启后**不自动恢复**；⑦ 故意让 supervisor 巡检卡住（测试钩子）→ 看门狗 cancel 旧实例，
  旧实例退出后重启并记 warn；**旧实例不退出 → 不起新实例**，置 fault + 通知。
- **审计者验证**（§5.3.7）：① `running` 编排状态 2 小时无变化 → 请求重启 supervisor 并记审计日志；
  ② 审计者**不得**直接改批次状态、派发或置 `fault`（源码级断言：auditor 分类下无 `dispatch`/`setStatus` 调用）；
  ③ 单批超 `deadline + 3×自身 timeoutMs` → 信号 2 命中；某批把 `timeoutMs` 调大后，`auditIdleMs` 校验按**实际最长批次**算；
  ④ 旧 supervisor 退不出 → **不起第二个**，只通知用户；
  ⑤ 看板显示「上次推进 / 上次审计」两个时间戳；
  ⑥ 正常推进中的编排**不被误判**（mtime 在动 → 不触发）；
  ⑦ `paused_no_window` / `awaiting_user` / `stopped` 的编排**不在审计范围**（挂一夜不报警）；
  ⑧ supervisor 巡检本身**不写** `<id>.json`（否则 mtime 每 30 秒都动，审计失效）。
- **仲裁者交接验证**（§5.13.4）：① 仲裁请求体**只含目标 + 计划摘要 + 争议点**（不带完整历史，可断言长度上限）；
  ② 上下文使用率上报 >70% → 触发预判式交接，新会话标题为「编排仲裁·接替「<原标题>」」，
  原会话留一条交接说明；③ 连续 2 次仲裁请求无响应 → 判定失效并交接；
  ④ 旧仲裁者（generation 落后）尝试写入仲裁结果 → **被拒绝**；
  ⑤ 交接失败（模型不可用）→ L2 升 L3 + 暂停 + 通知用户；
  ⑥ `arbiter.handoffs` 在看板上可见。
- **写闸绕过验证**（§5.2）：① `write_file` / `edit_file` 写 owns 外 → 拒绝；② `PatchApply` 含 owns 外目标 → 整个计划拒绝；
  ③ junction 指向工作区外 → 拒绝；④ 目标文件尚不存在时按最近存在的祖先求值，不报假错；
  ⑤ Worker 的工具表里**没有** `run_command` / `background_command` / 终端 / MCP；⑥ 放行的写入出现在 `writeLog`。
- **verify runner 验证**（§5.4）：① 含 `&&` / 管道 / 重定向 / `cmd /c` 的计划被拒；② cwd 在工作区外被拒；
  ③ 超时终止整棵进程树；④ 绑定立即返回、不阻塞 Wails 调用；⑤ 另一 Worker 仍在写时 verify **不启动**（§5.2.2）。
- **统一停止验证**（§5.8）：停止后到达的 report 被拒；后台命令与终端按资源登记表被停；
  持有会话的窗口已关 → 编排保持 stopped，重开该会话时先执行停止。
- 回归：`critical 只提醒不打断`、会话租约 busy 语义、`assertNotCognitionPath` 均不得受影响。

---

## 11. 明确不做

- 不做节点画布 / DAG 编辑器（批次表 + 依赖列足够）。
- **本期不做跨工作区编排**（数据结构已预留，见 §12.1；实际落地等 agent-host-platform 之后）。
- 不引入新 SQLite（状态是真源，用 JSON + atomfile）。
- 不做"AI 自主决定花钱"——必须人工批准计划。
- 不替代群聊与子代理（三者定位见 §3，文案上必须拉开距离）。
- 不做自动合并 / 自动提交（编排只产出改动与验收记录，提交仍归用户）。
- **不做自动回滚**（§5.11.3）：改动是资产；需要后路就勾"开始前快照"，出事人工还原。

---

## 12. 附：跨工作区预留接口（§12.1）

**本期只实现单工作区，但数据结构按多工作区设计**，避免将来推翻重来。

### 12.1 已预留的三处

| 位置 | 现在 | 将来 |
|---|---|---|
| `Orchestration.workspaces: string[]` | 校验层强制 `length === 1` | 直接放多个，无需改结构 |
| `Batch.workspace` | 恒等于 `workspaces[0]` | 每批可指定不同工作区 |
| `Batch.owns` | 相对 `batch.workspace` 解析 | 语义不变（仍相对本批的工作区） |

### 12.2 落地时必须补的（现在不做，但要知道在哪）

| 议题 | 说明 |
|---|---|
| 写闸的跨工作区判定 | 现在 `assertWritable` 只需比一个根；多工作区时要比"本批所属的那个根" |
| 快照的粒度 | 单工作区一张，多工作区要按工作区各一张（体积与耗时都会涨） |
| 依赖跨工作区 | 允许 A 仓的批次依赖 B 仓的批次？**建议不允许**（耦合太强，收益不明） |
| 会话归属 | 发起会话在 A 仓、批次在 B 仓时，列表缩进该挂哪——需要重新设计 |
| 文件所有权冲突 | 不同工作区的 `owns` 天然不冲突，并行度判定可放宽 |

**这些必须在真正实现跨工作区时逐条过一遍**，尤其"会话归属"与"快照粒度"两项会牵动 UI 与磁盘。

---

## 13. 二次审计的修订留痕（2026-11-26）

本文经过两轮独立审查。记下来不是为了记账，而是**让实现者知道哪些坑已经被踩过**。

### 13.1 第一轮（设计者自审）

修正 19 处，其中关键：报告归属校验缺失、审查门误用 `spawn_agent`（Go 调不到前端工具）、
批次间不传上下文、dispatch 重复广播、owns 比对口径未定义。

### 13.2 第二轮（独立模型审计，逐条已核实）

| 审计发现 | 核实结果 | 处置 |
|---|---|---|
| **审查批次死锁**：`review-B3.dependsOn=['B3']` 与「B3 等审查通过才 done」互锁 | ✅ **真死锁** | 改 `reviewOf` + `dependsOn: []`，Router 在 verify 通过时激活（§5.5.2） |
| **`OwnerForCall` 只返回窗口名**，不能当 sessionId | ✅ 已核实源码注释「返回绑定调用方窗口名」 | 改为 **StartBatch 签发执行票据**（§5.1.0） |
| **`applyWorkspaceWrite` 不覆盖 `PatchApply` / run_command / 终端 / MCP** | ✅ 已核实 `PatchApply` 是独立绑定 | 写闸承诺收窄为「受控写路径」+ Worker 默认不下发命令类工具（§5.2） |
| **ClaimBatch + TTL 会让已起轮批次被二次认领**，且没有绑定写 `dispatchedAt` | ✅ 原设计确实缺这一环 | 改**两阶段握手** Claim → StartBatch → AbortStart（§5.3.3） |
| **`lastTickAt` 落盘会破坏 mtime 审计** | ✅ 落盘则 mtime 每 30s 动，审计判据失效 | 改为只存内存原子变量（§5.3.4） |
| **auditor 不应置 `fault`** | ✅ `fault` 语义是 Router 自检失败，混用会误导 | auditor 只告警 + 请求重启（§5.3.7） |
| **Go 不能强杀 goroutine**，「重启 supervisor」要先等旧实例退出 | ✅ 语言事实 | 改为「确认退出后才起新实例；退不出则告警要求重启应用」（§5.3.4） |
| **`agent_stop` 参数是 agentId，不是 rootSessionId** | ✅ 已核实 | 补「会话 → agentId/runId/jobId/termId 资源登记表」（§5.8） |
| **`stopSessionTurn` 是 `stopGeneration(stream)` 的薄包装**，stream 未注册时兜不住 | ✅ | 统一停止改为走宿主级完整 `stopGeneration`（§5.8） |
| **`submit_plan` 卡片不可编辑**，而编排审批卡要能改批次 | ✅ 已核实无 editable/contenteditable | 审批卡列为**新组件**，不计入「复用」 |
| **attempts 不该在重派时 +1**（起轮失败也消耗重试次数） | ✅ 合理 | 只在 StartBatch 成功时 +1；返工回原批次（§5.5.4） |
| **verify 应该用 exe + argv 不走 shell** | ✅ 避免 shell 注入 | 采纳（§5.4） |
| **C3（并行时全量测试读到半成品）没解决** | ✅ 我的原方案确实漏了 | 新增**静默屏障**：验收/审查期间不派新批次（§5.2.2） |
| **`OrchestrationAdvance` 是多余的第二个推进入口** | ✅ 同一把锁内推进即可 | 删除 |
| **`escalateOnRetry` 默认 true 会在用户不知情时换贵模型** | ✅ 成本纪律 | 默认改 **false** |
| **`arbiterModelRef` 应在审批时固定**，否则交接后模型漂移 | ✅ | 采纳（§4.2） |
| **估算是 20–24 人日不是 14–16** | ✅ 补回漏算项后确实如此 | 采纳（§8） |

### 13.3 复核中纠正了审计的一处判断

| 审计原话 | 我的核实 | 修正 |
|---|---|---|
| 「`bridgeNewSession` 会 `await startSessionTurn` **直到整轮结束**，需要新增「注册 stream 后即返回」的起轮入口」 | `startSessionTurn` 末尾是 `startRound(run); return {ok: true, run}`，**不等整轮**；它会 await 起轮准备（`whenIdle` / 租约 / `assembleSystemContext` / 生命周期钩子），几秒量级 | **不需要新起轮入口**，但必须分两步调：① `bridgeNewSession` 不带 message 只建会话 ② `StartBatch` 签票据 ③ 再 `startSessionTurn` 起轮（§5.3.3） |

**这处为什么会错**：`bridgeNewSession` 里确实写了 `await startSessionTurn(...)`，看到 `await` 容易推断成"等到完成"。
但 `startSessionTurn` 自己不等 `startRound` —— **await 的是"起轮"这个动作，不是"这一轮跑完"**。
结论方向（不能一步到位）仍是对的，只是原因不同。

### 13.4 给实现者的提醒

审计修正的这 17 条里，**有 9 条是「机制写了但底层能力不存在」**——`OwnerForCall` 不是会话身份、
`applyWorkspaceWrite` 不管补丁、`agent_stop` 参数不对、`submit_plan` 不可编辑、goroutine 不能强杀……
这些读文档时看不出来，**只有对着源码核实才会暴露**。

**建议**：实现每个机制前，先花 5 分钟核对它依赖的那个函数/绑定**到底能做什么**，别信文档里"复用 XX 即可"这种话。
