# 会话信箱可靠投递：统一语义与状态机方案

> 状态：**已实施**（2026-11-27 成文并落地）
>
> 触发问题：多工作区下，主会话已经停止，子会话结果仍挂在信箱里；用户主动发一条消息后，旧通知才随该轮进入模型上下文。
>
> 实施记录：`ai-agent-notices.js` 收敛为 per-session `DeliveryRecord` 状态机；`ai-session-scope.js` 的压缩准备判定改为按 sessionId；`ai-panel.js` 注入统一自动起轮门禁，压缩所有退出路径统一 `settleCompact`，并在起轮、重读、租约释放、回前台等事件恢复信箱。新增长忙期、在飞清空、urgent 排序、满箱合并、分批续投、跨会话压缩隔离等测试。`npm test` 全量（含 typecheck、AI、UI-core、UI-shell、Maven）与 `npm run build` 通过。
>
> 2026-11-27 全流程复审补充：修复同会话并发起轮、准备态切会话/归档/删除竞态、异步提交误清其他会话输入、队列冲刷重入与同毫秒乱序、纯附件恢复、长文本胶囊草稿丢失、租约重读后截断锚点漂移、溢出恢复重发最新消息、工具轮异常不收尾、压缩失败/取消不冲用户队列、压缩收尾异常泄漏租约，以及早期释放失败无重试等问题。二次复审进一步补齐租约释放同步异常、批量附件切会话、重启后 seq 基线、压缩租约延迟释放和压缩准备期会话对象替换五个边界；三次复审补齐压缩准备取消时已取租约释放、共享租约释放状态机，以及交错队列逐条回滚归位。
>
> 本文只设计前端 AI 会话信箱的投递闭环，不修改子代理收件箱、composer 排队消息、Go 后端或会话存储格式。工作区当前已有部分补丁（异步 busy 重试、`compactStarting` 判定、`flushAllPending` 等），本文用于把这些点状修复收敛为一套可验证的统一语义。

## 0. 结论与决策摘要

| 项 | 决策 |
|---|---|
| 根因 | 信箱在异步唤醒失败后只回填、不保证再次尝试；忙判定与起轮门禁不完全同源；压缩等全局阻塞的退出路径没有完整收口 |
| 核心模型 | 每个会话一份投递状态：`pending / inFlight / timer / generation / attempt`，所有入队、消费、重试、清空都走同一状态机 |
| 投递语义 | `ok/accepted` 只表示**已受理**，不表示模型已看到；`delivered` 才表示通知已进入会话消息并会被请求携带 |
| 重试语义 | 可恢复阻塞不放弃：单会话单定时器，退避到 30 秒后保持低频重试；终态失败才停泊并可见 |
| 压缩语义 | 压缩准备阻塞按 `sessionId` 生效，不再阻塞所有工作区；压缩成功、失败、取消、启动失败统一收口 |
| 租约语义 | 先释放压缩租约，再允许目标会话起轮；租约尚未释放时由投递状态机重试，不并行抢锁 |
| 顺序语义 | 用户排队消息 > 信箱通知 > 系统提醒；通知单批最多 5 条；urgent 优先且保持稳定顺序 |
| 清空语义 | 清空/删除立即使在飞唤醒结果失效，旧异步结果不得把通知复活 |
| 非目标 | 不持久化信箱、不引入 broker/QoS、不跨窗口同步信箱、不新增 Go 绑定、不改变子代理 `inbox` |

## 1. 背景与代码事实

### 1.1 现有三条通道不能混为一谈

| 通道 | 所有者 | 内容 | 消费方式 | 本次是否修改 |
|---|---|---|---|---|
| composer 消息队列 | `ai-message-queue.js` | 用户已亲手发送、因忙碌而排队的消息 | 当前会话 UI 代发；后台走 `startSessionTurn` | 不改，只保留优先级 |
| 会话信箱 | `ai-agent-notices.js` | 子代理结算/提问、支线带回、定时任务、计时器、会话投递等后台注入 | 工具轮边界折叠；空闲唤醒新轮 | **本次重构** |
| 子代理收件箱 | `ai-subagents.js` | 父代理发给运行中子代理的消息 | 子代理下一轮边界消费 | 不改 |

统一语义的第一条纪律：**信箱不是 composer 队列的备份，也不是子代理收件箱的镜像。** 三者可以共用 `startSessionTurn`，但状态、顺序和生命周期分别独立。

### 1.2 当前投递链路

1. 后台子代理终态：`finalizeSubAgent → deliverToParent → deliverAgentNotice`。
2. 信箱按 `sessionId` 入队。
3. 目标忙：留在 `pending`。
4. 目标空闲：`wakeWith` 取最多 5 条，调用 `startSessionTurn`。
5. `startSessionTurn` 经过异步上下文组装、写盘排空、租约获取、生命周期钩子后才注册流。
6. 起轮成功：通知作为 user 消息落盘；起轮失败：通知回填信箱。
7. 工具轮边界：`foldNotices` 把 pending 通知折进当前请求。
8. 流结束：`finishStream → flushAgentNotices` 尝试唤醒残余通知。
9. 用户手动发送：`startSessionTurn → foldNoticesBeforeTurn` 顺带消费 pending。

### 1.3 故障证据

运行时日志：

- `03:25:02`：`后台通知未能唤醒会话「分支 · 评估工作区无缝切换功能」：busy`
- `03:54:09`：`[通知] 目标正忙，已退回队列等下一边界`

目标会话记录：

- `03:48:32`：一次空闲子代理通知自动唤醒成功，说明基础通路可用。
- `03:49:47`、`03:49:59`：两个后台子代理派出。
- `03:53:17`：主会话结束本轮。
- `03:54:09`：通知唤醒被异步 `busy` 拒绝并回填。
- `03:55:00.756`：用户发消息。
- `03:55:00.767`：另一条子代理通知进入用户这一轮；仍有一条未进入主会话记录，与截图信箱角标 `1` 一致。

### 1.4 最新补丁的有效部分

当前工作区未提交补丁已经做了以下正确方向：

- 信箱 busy 判定接入 `compactStartingOf`。
- 异步 `startSessionTurn` 返回 `ok:false` 后调用 `scheduleRetry`。
- 新通知重置重试预算。
- `foldIntoMessages` 消费清空时清理重试状态。
- 新增 `flushAllPending()`，压缩成功/空摘要时冲刷所有会话。
- 切会话时补冲目标会话信箱。

这些改动应保留为本次重构的行为基础，而不是推翻重写外部 API。

### 1.5 最新补丁仍存在的完整性问题

1. 重试五档累计约 38 秒后放弃；忙期超过该窗口且没有新事件时，通知仍会滞留。
2. `clearMailbox` 不清在飞批次；在飞唤醒失败后会把已清空的通知回填。
3. 压缩的 `ai-error`、Promise reject、同步异常、租约失败、重读失败、取消路径没有统一冲刷。
4. `finishCompact` 在释放压缩租约之前冲目标信箱，可能得到 `other_window/lease_failed`。
5. 信箱满合并分支不重新武装投递；重试已耗尽时不再自愈。
6. 外层 busy 探针与内层门禁仍不同源，尤其缺少 `sessionReloading` 和 `startingTurns` 的外部起轮视角。
7. 现有“重试退避用尽”测试没有推进定时器，只检查队列深度，未真正验证耗尽行为。

## 2. 统一术语与语义

### 2.1 投递状态

| 术语 | 定义 | 是否已经进入模型上下文 |
|---|---|---|
| `accepted` | 通知已通过目标存在、未归档、非空、容量等校验，进入本窗口投递系统 | 否 |
| `pending` | 通知在信箱等待队列中，尚未交给 `startSessionTurn` | 否 |
| `inFlight` | 通知已交给 `startSessionTurn`，正在异步起轮 | 否 |
| `delivered` | 通知已折进 `session.messages`，随后请求会携带 | 是 |
| `parked` | 终态失败，通知保留但不自动重试，等待用户/配置/会话状态变化 | 否 |
| `rejected` | 投递入口直接拒绝：目标不存在、归档、空内容、会话投递满箱等 | 否 |

关键区别：

- **忙不是失败**。忙只意味着 `pending`。
- **唤醒开始不是送达**。`wakeWith` 同步返回时只能说明尝试开始。
- **回执不是模型回复**。`session_send` 的 `ok` 只表示受理，不保证目标会话处理或回复。

### 2.2 数量口径

| API/UI | 口径 |
|---|---|
| `pendingCount(sessionId)` | 仅 pending 条数；保留现有 API 兼容性 |
| `outstandingCount(sessionId)` | pending + inFlight，表示“尚未进入模型上下文”的总数 |
| 信箱角标/弹层 | 使用 `outstandingCount`；inFlight 条目标注“投递中”，不再短暂从用户视野消失 |
| 容量上限 `NOTICE_DEPTH_MAX` | 仍只限制 pending，避免在飞批次阻塞新通知时误拒；inFlight 最多 5 条，总量有界 |

### 2.3 回执口径

`deliverAgentNotice` 继续保持同步返回，不阻塞子代理结算。新增语义字段：

```js
{
  ok: true,
  accepted: true,
  state: 'queued' | 'deferred' | 'in_flight',
  messageId,
  reason,
  woke: true | false // 旧字段：仅表示“已尝试唤醒”，不得用于判断最终送达
}
```

兼容规则：

- 保留 `ok / reason / messageId / woke`，现有调用方和测试无需一次改完。
- `woke` 明确定义为“尝试已启动”，不是“投递成功”。
- `sendToSessions` 的工具回执文案从“已投递”改为“已受理”；`queued/deferred` 时明确“等待目标会话空闲或下一轮边界”。
- `delivered` 是内部状态，不要求同步回执等待模型请求完成。

### 2.4 顺序口径

每条通知在入队时分配单调递增的 `seq`。pending 排序固定为：

1. `urgent=true` 在前；
2. 同为 urgent 时按 `seq` 升序；
3. 普通通知按 `seq` 升序。

收益：

- urgent 插队不会把同批 urgent 倒序。
- 在飞批次失败回填时，按同一比较器插回，不会压过更新到达的 urgent 通知。
- 单批最多取 5 条，批次内顺序与全局顺序一致。

### 2.5 一轮之内的注入优先级

维持既有裁决：

```text
用户 composer 排队消息
  > 会话信箱通知
  > <task_reminders> 等系统装配块
```

理由：用户意志优先于后台通知；系统提醒是每轮固有上下文，不参与队列排序。

## 3. 目标与非目标

### 3.1 目标

1. 任何已受理通知在目标会话存在且未归档时，都不会因一次异步 busy 而永久滞留。
2. 多工作区下，一个会话的压缩准备不阻塞其他会话自动起轮。
3. 所有压缩退出路径都解除阻塞并触发信箱重试。
4. 清空、删除、归档使在飞结果失效，不复活旧通知。
5. 同一会话同一时刻最多一个通知起轮尝试；不重复注入、不重复建轮。
6. 后台注入不切会话、不强开面板、不抢用户滚动位置。
7. 可恢复失败有持续低频重试；终态失败有明确停泊与可见提示。
8. 不新增依赖、不新增 Go 绑定、不改会话 JSONL 结构。

### 3.2 非目标

- 不把信箱持久化到磁盘；应用重启后仍按既有语义清空。
- 不引入 MQTT、broker、topic、QoS、跨进程事件总线。
- 不解决跨窗口 `session_send`；目标仍限本窗口内存会话。
- 不重构子代理 `inbox.step / inbox.turn / inbox.ask`。
- 不改变 composer 队列“一轮一条”的既有裁决。
- 不增加后台自动发送开关；通知唤醒与用户排队发送都属于已授权动作。
- 不在信箱层做内容截断；长结论仍由模型输出预算和父会话上下文预算兜底。

## 4. 不变量

以下不变量是实现与测试的共同契约：

1. **不丢**：任一 `accepted` 通知始终存在于 `pending`、`inFlight` 或已落入的 `session.messages` 中。
2. **不重复**：同一通知最多进入模型上下文一次。
3. **单飞**：同一 `sessionId` 同时最多一个 `inFlight` 起轮尝试。
4. **顺序**：pending 严格按 §2.4 排序；失败回填不破坏 urgent 优先级。
5. **清空有效**：`clearMailbox/dropSession/archive` 后，旧 generation 的异步结果不得修改新状态。
6. **用户优先**：同一会话 composer 队列先于信箱通知消费。
7. **后台无视图副作用**：不调用 `switchSession`、不写当前输入区、不改 `activeSessionId`。
8. **忙不等于失败**：busy 不弹错误 toast；可恢复 busy 自动重试。
9. **可恢复不放弃**：只要目标会话仍存在且未归档，retryable 失败不能因尝试次数耗尽而永久放弃。
10. **终态可见**：parked 通知保留在信箱，会话有未读标记，用户能看到原因。
11. **压缩按会话**：`compactStarting` 只阻塞压缩目标，不阻塞其他工作区会话。
12. **租约不抢**：释放租约前不并行启动同一会话的新回合；`other_window` 由重试状态处理。
13. **无残留**：pending 与 inFlight 都为空时，不留 timer；删除会话不留 retry/inFlight 状态。
14. **失败提示去重**：同一停泊原因只提示一次；状态恢复后重新提示。

## 5. 数据模型

### 5.1 每会话投递记录

建议把当前分散的 `notices / waking / retryState` 收敛为一份记录：

```js
// ai-agent-notices.js 内部结构，不对外暴露可变引用。
const deliveries = new Map(); // sessionId -> DeliveryRecord

/**
 * @typedef {Object} DeliveryRecord
 * @property {Array<NoticeItem>} pending
 * @property {{batch: NoticeItem[], token: number, startedAt: number}|null} inFlight
 * @property {number|null} timer
 * @property {number} attempt
 * @property {number} generation
 * @property {string} lastBlock
 * @property {string} parkedReason
 * @property {string} lastNotifiedReason
 * @property {number} nextRetryAt
 */
```

`NoticeItem` 在现有字段基础上增加：

```js
{
  messageId,
  kind,
  label,
  content,
  sender,
  ts,
  urgent,
  seq
}
```

说明：

- `messageId` 是通知身份，不因回填、合并而改变。
- `seq` 只用于本窗口内排序，不写入会话 JSONL。
- `generation` 在清空、删除、归档时递增，用于作废在飞结果。
- `inFlight.token` 与 generation 联合判断异步结果是否仍有效。

### 5.2 兼容 API

对外仍由 `createAIAgentNotices(ctx)` 返回现有 API，并新增：

```js
{
  deliverAgentNotice,
  foldNotices,
  flushNotices,
  flushAllPending,
  foldBeforeTurn,
  dropSession,
  clearMailbox,
  pendingCount,       // 旧口径：pending
  outstandingCount,   // 新口径：pending + inFlight
  listPending,        // 包含 state 字段
  isWaking,           // inFlight !== null
  listSessionsForSend,
  sessionListText,
  sendToSessions,
  deliverToSessions,
  kick,               // 可选暴露给 panel 做生命周期即时触发
}
```

`kick` 是内部状态机入口；panel 已有 `flushAgentNotices/flushAllAgentNotices` 可继续作为薄壳，不必一次改掉所有调用名。

## 6. 统一忙态与阻塞原因

### 6.1 单一判定源

`ai-agent-notices.js` 不再自行组合 `streamOf / compactOf / compactStartingOf`。由 `ai-panel.js` 注入：

```js
canAutoStartTurn(sessionId)
```

panel 中的实现语义：

```js
function canAutoStartTurn(sessionId) {
  if (!sessionId) return {ok: false, reason: 'no_session'};
  if (isSessionBusy(sessionId, {includeCompactStarting: true})) {
    return {ok: false, reason: 'busy'};
  }
  if (sessionReloading.has(sessionId)) {
    return {ok: false, reason: 'reloading'};
  }
  if (startingTurns.has(sessionId)) {
    return {ok: false, reason: 'starting'};
  }
  return {ok: true, reason: ''};
}
```

注意：`startingTurns` 只用于**外部自动起轮**判定，不能塞进 `startSessionTurn` 自己使用的 `isSessionBusy`，否则自己会把自己判忙。

### 6.2 压缩准备改为按会话

当前 `compactStarting` 是全局布尔值。建议改为：

```js
let compactStartingSessionId = '';
```

`createSessionBusyProbe` 的 `compactStartingOf` 签名改为接收 `sessionId`：

```js
compactStartingOf: (sessionId) => !!sessionId && sessionId === compactStartingSessionId
```

理由：`startCompact` 在置位前已经通过 `options.session || currentSession()` 知道目标会话，不存在“准备阶段不知道阻塞谁”的前提。按会话判定可以直接消除多工作区串扰。

### 6.3 阻塞原因分类

| 原因 | 类别 | 自动重试 | 用户提示 |
|---|---|---|---|
| `stream` | retryable | 是 | 否 |
| `compact` | retryable | 是 | 否 |
| `compact_starting` | retryable | 是 | 否 |
| `reloading` | retryable | 是 | 否 |
| `starting` | retryable | 是 | 否 |
| `editing` | retryable | 是 | 否；保留编辑态保护 |
| `sessions_pending` | retryable | 是 | 否 |
| `busy` | retryable | 是 | 否 |
| `other_window` | retryable | 是，30 秒低频 | 首次 debug，不弹错误 |
| `lease_failed` | retryable | 是 | 首次可见一次 |
| `save_failed` | retryable | 是，但保持租约由既有逻辑处理 | 首次可见一次 |
| `stale_reload` | retryable | 是 | 首次可见一次 |
| `over_budget` | recoverable | 触发一次自动压缩；压缩结束后重试 | 超阈说明一次 |
| `no_profile` | terminal | 否；配置变化/新通知时 kick | 停泊可见 |
| `no_backend` | terminal | 否 | 停泊可见 |
| `archived` | terminal | 否；取消归档时 kick | 拒收或停泊按入口语义 |
| `session_deleted` | terminal | 否 | 丢弃并记录 debug |
| `load_failed` | terminal | 否；用户重试加载后 kick | 停泊可见 |

## 7. 投递状态机

### 7.1 状态图

```text
EMPTY
  │ enqueue
  ▼
PENDING ── kick + 可起轮 ──► IN_FLIGHT
  ▲                          │
  │                          ├─ ok ──► delivered ──► EMPTY / PENDING(还有余量)
  │                          │
  │                          └─ retryable failure ──► 回填 ──► PENDING
  │
  ├─ terminal failure ──► PARKED(通知仍保留)
  │
  └─ clear / delete / archive ──► generation++ ──► EMPTY
```

`PENDING` 本身不代表正在计时；它可能处于 busy 等待、编辑态延后、定时器等待或事件等待。统一由 `armRetry` 管理。

### 7.2 核心入口 `kick(sessionId)`

```js
function kick(sessionId) {
  const record = getRecord(sessionId);
  const session = sessionById(sessionId);

  if (!session) {
    dropSession(sessionId);
    return {ok: false, reason: 'gone'};
  }
  if (!record.pending.length && !record.inFlight) {
    clearRetry(sessionId);
    return {ok: false, reason: 'empty'};
  }
  if (record.inFlight) return {ok: true, state: 'in_flight'};

  const gate = canAutoStartTurn(sessionId);
  if (!gate.ok) {
    record.lastBlock = gate.reason;
    armRetry(sessionId);
    return {ok: true, state: 'queued', reason: gate.reason};
  }

  const batch = takeBatch(record.pending, NOTICE_FOLD_MAX);
  const token = ++record.generationToken;
  record.inFlight = {batch, token, startedAt: Date.now()};
  notifyChanged();

  let run;
  try {
    run = startSessionTurn(session, noticeText(batch), {
      app: noticeApp(batch),
      allowPendingEdit: false,
      truncateAt: null,
      preserveScroll: true,
    });
  } catch (error) {
    settleFailure(sessionId, token, {ok: false, reason: 'sync_error'}, error);
    return {ok: true, state: 'in_flight'};
  }

  Promise.resolve(run).then((result) => {
    settleResult(sessionId, token, result);
  }).catch((error) => {
    settleFailure(sessionId, token, {ok: false, reason: 'rejected'}, error);
  });

  return {ok: true, accepted: true, state: 'in_flight', woke: true};
}
```

实现要点：

- `canAutoStartTurn` 必须在取 batch 之前调用，尽量避免无谓回填。
- 即使检查通过，异步起轮仍可能失败；`settleFailure` 是正确性兜底。
- `inFlight` 存在时直接返回，不叠加第二个起轮尝试。

### 7.3 成功 `settleSuccess`

1. 校验 `record.inFlight.token === token` 且 generation 未变化。
2. 清 `inFlight`。
3. 清 timer/attempt/lastBlock/parkedReason/lastNotifiedReason。
4. 若 pending 仍有条目，再次 `kick`：
   - 当前流已注册 → 自动进入 busy 等待；
   - 不起流即返回成功 → 可以继续下一批。
5. 不额外 toast；通知卡片和会话状态就是结果。

### 7.4 失败 `settleFailure`

1. 先校验 token/generation；失效则什么都不做。
2. 清 `inFlight`。
3. 将 batch 按 §2.4 的比较器插回 pending，不简单 `unshift`。
4. 设置会话未读标记。
5. 按 §6.3 分类：
   - retryable/recoverable → `armRetry`；
   - terminal → `park`。
6. 非 busy 的失败只提示一次；busy/waking/starting/reloading 不弹错误。

### 7.5 折叠消费

工具轮边界和用户起轮前都调用同一内部函数：

```js
function foldIntoMessages(session, limit, skipRender) {
  const batch = takeBatch(record.pending, limit || NOTICE_FOLD_MAX);
  if (!batch.length) return 0;

  session.messages.push({
    role: 'user',
    content: noticeText(batch),
    ts: Date.now(),
    turnStartedAt: Date.now(),
    app: noticeApp(batch),
    notice: true,
    // 可选诊断字段；不改变既有 replay 语义。
    noticeIds: batch.map((item) => item.messageId),
  });

  if (!record.pending.length) clearRetry(sessionId);
  else armRetry(sessionId); // 还有余量时不能依赖下一次工具轮
  notifyChanged();
  if (!skipRender && isViewed(session)) renderMessages(true);
  persistSessions();
  return batch.length;
}
```

`noticeIds` 只用于诊断和测试去重；若担心会话 schema 扩张，可只保留在内存消息，不写入 JSONL。实现时应确认现有 replay 会原样保留未知字段，否则不持久化该字段。

### 7.6 清空、删除、归档

```js
function invalidate(sessionId) {
  const record = getRecord(sessionId);
  record.generation += 1;
  record.pending = [];
  record.inFlight = null;
  clearRetry(sessionId);
  record.parkedReason = '';
  record.lastNotifiedReason = '';
  notifyChanged();
}
```

- `clearMailbox` 调 `invalidate`。
- `dropSession` 调 `invalidate` 后删除整条记录。
- 归档会话按既有语义清信箱；取消归档后 `kick`。
- 在飞 `startSessionTurn` 仍可能继续执行，但其结果不能回填；若已经开始写消息，则属于既有回合生命周期，不能靠信箱 generation 撤回。

## 8. 重试策略

### 8.1 退避曲线

```text
800ms → 2s → 5s → 10s → 30s → 30s → 30s …
```

规则：

- 每个会话最多一个 timer。
- retryable 失败不设次数上限；只要 pending 非空且会话存在，就继续低频重试。
- 成功后 attempt 归零。
- 新通知不叠加 timer；若已有 timer，直接复用。
- 阻塞原因变化时更新 `lastBlock`，但不重置 attempt，避免频繁抖动。
- 每次重试不打印日志；只在 `EMPTY→PENDING`、`PENDING→IN_FLIGHT`、`IN_FLIGHT→PARKED`、`PARKED→PENDING` 等状态变化时记录 debug。
- WebView 后台定时器被节流时，`visibilitychange/focus`、流结束、压缩结束、切会话等事件会立即补 kick。

这不是高频轮询：稳定后每个“确实有未投通知”的会话每 30 秒最多一次，且大部分时间由事件即时触发。

### 8.2 终态停泊

`no_profile / no_backend / load_failed / archived` 等终态失败：

- 通知保留；
- 不自动 timer 重试；
- 会话显示未读/信箱条目；
- 同一原因只提示一次；
- 下列事件可以重新 kick：
  - 用户新发通知；
  - 模型配置变化；
  - 会话重新加载成功；
  - 取消归档；
  - 应用回前台；
  - 用户切到该会话。

### 8.3 `over_budget`

信箱层不自己循环重试，而是通过 panel 注入：

```js
onOverBudget(session)
```

panel 调 `maybeAutoCompact(session)`。每个 pending episode 最多触发一次自动压缩；压缩结束后统一 kick。若自动压缩关闭或无法执行，通知停泊并显示“上下文超阈，通知暂存信箱”。

### 8.4 `other_window`

- 视为 retryable，但不属于本窗口 busy。
- 使用 30 秒档位，避免频繁 probe。
- 不弹“投递失败”toast；debug 记录 owner 即可。
- 资源 watch/focus/租约释放成功时立即 kick。
- 不等待锁、不强制抢锁，遵守多实例方案既有语义。

## 9. 压缩生命周期统一收口

### 9.1 所有退出路径

新增 panel 内部 helper：

```js
function settleCompact(current, outcome) {
  if (!current || !oneShot || oneShot.id !== current.id) return;

  oneShot = null;
  compactStartingSessionId = '';
  setStreamingUI(false);
  updateSendState();

  if (current.leaseHeld) {
    current.leaseHeld = false;
    releaseTurnLease(current.sessionId);
  }

  // 其他会话没有压缩租约，可立即恢复。
  flushAllAgentNotices({excludeId: current.sessionId});

  // 压缩目标可能仍在异步写盘/释放租约。
  // 直接 kick 一次；若拿到 other_window，由信箱重试状态处理。
  flushAgentNotices(current.sessionId);
}
```

调用点必须覆盖：

- `finishCompact` 成功；
- 空摘要失败；
- `ai-error` 事件；
- `AISendChat` Promise reject；
- `begin()` 同步异常；
- 租约获取失败；
- 会话已删除；
- 会话重读失败；
- 等待上一轮写盘失败；
- `cancelOneShot()` 用户取消。

UI 提示与 `outcome` 由调用方决定，但状态清理和信箱恢复只能走 `settleCompact` 一处。

### 9.2 为什么目标可以先 kick 再等租约

`releaseTurnLease` 为了终态写盘正确性，可能延迟释放。正确性要求不是“必须同步等到锁空”，而是：

1. 不并行抢锁；
2. 锁没释放时 `startSessionTurn` 返回 `other_window`；
3. 信箱把通知保留并进入 30 秒重试；
4. 租约释放成功后的事件再补一次即时 kick。

因此不需要为了信箱正确性去修改租约 API；只需保证调用顺序是“先发起 release，再尝试 kick”。

### 9.3 按会话压缩的好处

- A 工作区压缩时，B 工作区空闲会话可正常接收子代理通知。
- 不再需要靠 `flushAllPending` 弥补“全局误阻塞”。
- `flushAllPending` 仍保留，用于应用回前台、配置恢复等全局事件。

## 10. 事件接线表

| 事件 | 处理 |
|---|---|
| `deliverAgentNotice` | 入队后 `kick(sessionId)` |
| 工具轮边界 `handleToolRound` | `foldNotices(sessionId)`，随当前请求注入 |
| `startSessionTurn` 写 user 消息前 | `foldBeforeTurn(session)`，用户新轮顺带消费 |
| `finishStream` | 先 composer 队列，后 `flushAgentNotices(session.id)` |
| 压缩统一收口 | 先 release，再 `flushAllAgentNotices` + 目标 kick |
| `startingTurns.finally` | `kick(sessionId)`，解除外部起轮占位 |
| `sessionReloading.finally` | `kick(sessionId)`，重读完成后恢复 |
| 租约释放成功 | `kick(sessionId)` |
| `switchSession` | `kick(id)`，不替代用户手动发送 |
| 应用 `focus/visibilitychange` | `flushAllPending()` |
| 模型/后端配置变化 | `flushAllPending()`，唤醒 parked |
| 取消归档 | `kick(sessionId)` |
| 清空/删除/归档 | `invalidate(sessionId)`，作废在飞结果 |

事件触发是即时性优化；**正确性最终由状态机和持续低频重试保证**，不依赖每个事件都齐全。

## 11. 边界规则

### 11.1 信箱满与合并

- 容量仍检查 `pendingCount >= NOTICE_DEPTH_MAX`。
- `session / session-user` 满箱：拒收并返回 `full`。
- 子代理结算/提问：合并到最后一条同类 pending 通知，不丢内容。
- 合并后必须 `kick`：
  - 空闲则立即唤醒；
  - 忙则确保 retry timer 已武装；
  - 即使之前 attempt 耗尽，也重新获得预算。
- 若没有可合并的 pending，只有 inFlight，则允许创建一条 pending 合并项；容量限制不计算 inFlight。

### 11.2 urgent 与在飞批次

- urgent 只影响 pending 排序，不中断在飞 `startSessionTurn`。
- 在飞批次失败回填时按 `urgent + seq` 插回，保证新到的 urgent 仍优先。
- 单批 5 条消费后仍有 pending，立即 `kick`；当前流已注册则进入等待，下一轮末再消费。

### 11.3 编辑态保护

保留既有规则：目标正是当前会话且 `pendingEdit.index != null` 时，本次自动唤醒改为 deferred。状态机持续低频重试，用户结束编辑后由事件或 timer 恢复。

### 11.4 后台 UI

- 不调用 `switchSession`。
- 不写 `el.input`、不切附件、不抢滚动位置。
- `renderMessages` 仅在 `currentSession() === session` 时执行。
- 信箱角标使用 `outstandingCount`，inFlight 也可见。
- 后台成功不 toast；失败/提问/审批沿用既有通知策略。

## 12. 诊断与可观测性

### 12.1 Debug 日志

只在状态变化时记录，字段包含：

```text
[通知] sessionId state=... reason=... pending=N inFlight=0/1 attempt=N nextRetryAt=...
```

禁止每次 timer tick 打日志，避免后台会话刷屏。

### 12.2 会话列表与信箱

- `session_list` 的 `state` 增加 `starting / reloading` 或统一归入 `busy`，必须与真实可投递状态一致。
- 信箱弹层每条显示 `queued / in_flight / parked`。
- parked 条目显示终端原因，不伪装成“下轮可见”。
- 角标不因 batch 从 pending 移到 inFlight 而瞬间消失。

### 12.3 失败提示去重

- `lastNotifiedReason` 只在原因变化或状态恢复后清零。
- `busy / starting / reloading / other_window` 不弹错误。
- `no_profile / no_backend / load_failed / over_budget` 首次停泊提示一次。
- 同一会话同一原因不重复 `notifyDesktop`。

## 13. 实施步骤

### 阶段 0：先固化故障测试

文件：`frontend/test/ai/agent/ai-agent-notices.test.mjs`

新增假定时器/可控 Promise 用例：

1. 异步 `ok:false/busy` 后自动重试成功。
2. 连续忙超过 38 秒，转空闲后无需用户操作自动投递。
3. 清空信箱时唤醒在飞，失败后 pending 仍为 0。
4. 信箱满合并后重新武装投递。
5. urgent 在在飞失败回填后仍保持优先。
6. pending 清空后无残留 timer。

这些测试应先红，作为后续实现的验收基线。

### 阶段 1：统一 busy 语义

文件：

- `frontend/src/ai/session/ai-session-scope.js`
- `frontend/src/ai/ai-panel.js`
- `frontend/test/ai/session/ai-session-scope.test.mjs`

改动：

1. `compactStartingOf(sessionId)` 支持按会话判断。
2. panel 用 `compactStartingSessionId` 替代全局布尔值。
3. 注入 `canAutoStartTurn(sessionId)`，覆盖 stream/compact/compactStarting/reloading/starting。
4. 信箱模块改用注入判定，删除自行拼接 busy 条件的逻辑。

验收：A 会话压缩准备时，B 空闲会话可立即起轮。

### 阶段 2：重构信箱状态机

文件：`frontend/src/ai/agent/ai-agent-notices.js`

改动：

1. 合并 `notices / waking / retryState` 为 per-session `DeliveryRecord`。
2. 引入 pending/inFlight/generation/seq。
3. 所有投递、消费、重试、清空走 `kick/settleResult/settleFailure/invalidate`。
4. 重试改为 30 秒封顶、持续低频。
5. 新增 `outstandingCount`，`listPending` 返回状态。
6. 保留旧 API 字段，新增 `accepted/state`。

验收：阶段 0 测试全绿；现有 39 条信箱测试保持兼容。

### 阶段 3：压缩与生命周期收口

文件：`frontend/src/ai/ai-panel.js`

改动：

1. 新增 `settleCompact(current, outcome)`。
2. 所有成功/失败/取消/启动失败路径调用它。
3. 调整顺序：清 oneShot/compactStarting → 释放租约 → flush 其他会话 → kick 目标。
4. `startingTurns.finally`、`sessionReloading.finally`、租约释放成功后 kick。
5. 保留 `flushAllAgentNotices` 薄壳。

验收：压缩成功、空摘要、ai-error、reject、同步异常、租约失败、取消七类路径都能恢复信箱。

### 阶段 4：语义与 UI 文案

文件：

- `frontend/src/ai/agent/ai-agent-notices.js`
- `frontend/src/ai/ai-panel.js`
- 相关 UI 测试

改动：

1. `sendToSessions` 回执“已投递”改“已受理”。
2. queued/deferred/inFlight/parked 状态可见。
3. 角标使用 outstanding 口径。
4. busy 不弹错误；终态失败去重。

### 阶段 5：全量验证

- `node --test frontend/test/ai/agent/ai-agent-notices.test.mjs`
- `node --test frontend/test/ai/session/ai-session-scope.test.mjs`
- 新增/修改测试登记进 `frontend/package.json` 的 `test:ai`
- `cd frontend && npm test`
- `cd frontend && npm run build`
- 多工作区真机验收（见 §15）

本次不改 Go，无需更新后端绑定基线；若实现时新增 Go 方法，必须另跑 `TestAppBindingBaseline` 和类型生成器。

## 14. 测试矩阵

### 14.1 单元状态机

| 用例 | 预期 |
|---|---|
| 空闲入队 | 立即 inFlight，最终 delivered |
| 目标有 stream | pending，不调 startSessionTurn |
| 外层判空闲、内层异步 busy | batch 回填，timer 自动重试 |
| 忙超过 38 秒后空闲 | 仍自动 delivered |
| 同一会话并发两条通知 | 只有一个 inFlight；第二条 pending |
| 在飞期间来 urgent | urgent 排在新 pending 队首；失败回填后仍优先 |
| 10 条 pending 后再来结算 | 合并；空闲时自动投递 |
| 清空时 inFlight | generation 作废；失败不回填 |
| 删除时 inFlight | 记录删除；迟到结果无副作用 |
| 单批 6 条 | 首批 5 条，余 1 条随后自动续投 |
| no_profile | parked；配置变化后 kick |
| over_budget | 触发一次自动压缩；结束后 kick |
| other_window | 30 秒低频重试，不弹错误 |
| pending 清空 | timer 清零，无空 flush |

### 14.2 接线/源码守卫

- `settleCompact` 的每个退出路径都必须调用，不允许散落 `oneShot=null`。
- `flushAgentNotices(session.id)` 必须发生在 `releaseTurnLease` 发起之后。
- 信箱模块不得再出现“目标不是当前会话就 return”的寻址条件。
- 后台路径不得调用 `switchSession` 或写 `el.input`。
- `canAutoStartTurn` 必须包含 `sessionReloading` 与 `startingTurns`。
- `compactStartingOf` 必须按 sessionId 判断。

### 14.3 多工作区真机

1. A、B 两个工作区各开会话；A 停止，B 停止。
2. 给 A 派后台子代理，主会话不发送任何消息。
3. 子代理完成 → A 自动唤醒，B 视图不动。
4. A 压缩期间给 B 派子代理 → B 完成能自动唤醒，不被 A 压缩阻塞。
5. A 压缩失败/取消 → A、B 的积压通知都恢复。
6. 用户正在 B 输入时，A 的通知不得写入 B 输入区或抢 B 滚动位置。
7. 清空 A 信箱时若唤醒在飞 → 清空后不得复活。

## 15. 验收标准

必须同时满足：

1. 子代理完成后，无需用户发消息，通知自动进入目标模型上下文。
2. 目标忙 5 分钟再空闲，通知仍能自动送达。
3. 多工作区之间不串会话、不串输入区、不串视图。
4. 一个会话压缩不阻塞其他会话通知。
5. 压缩所有退出路径都恢复信箱。
6. 同一通知不重复注入，同一会话不并行起两轮。
7. 清空/删除后迟到异步结果不复活通知。
8. pending/inFlight 为空时无 timer、无 waking 残影。
9. busy 不弹错误；终态失败只提示一次。
10. 用户 composer 队列始终优先于信箱通知。
11. `npm test` 与 `npm run build` 通过。

## 16. 风险与回滚

### 16.1 风险

| 风险 | 控制 |
|---|---|
| 持续重试导致 token 消耗 | 只有真正拿到起轮权才发请求；busy/租约忙不烧 token；terminal 失败停泊 |
| 后台定时器被浏览器节流 | 事件 kick 补偿；稳定 30 秒兜底；focus/visibilitychange 全量冲刷 |
| 状态机重构影响旧调用方 | 保留 `ok/reason/messageId/woke`；分批迁移；先加测试再改内部 |
| `noticeIds` 改变 JSONL schema | 默认不持久化；只用内存字段；必要时确认 replay 原样保留 |
| 压缩按会话改动影响旧测试 | 先改纯 probe 测试，再改 panel 接线；保留 `includeCompactStarting` 显式语义 |
| 在飞 startSessionTurn 无法取消 | 不新增 watchdog 并行重试；沿用既有回合生命周期，保证最多一个 inFlight |

### 16.2 回滚

- 不改磁盘结构和 Go API，回滚仅涉及前端提交。
- 可按阶段回滚：先回状态机、再回 busy 语义、最后回压缩收口。
- 若新状态机出现回归，可临时恢复旧 `notices/waking/retryState` 实现，但必须保留阶段 0 的故障测试，避免再次带回“用户发消息才投递”。
- 不引入功能开关；信箱正确性不应允许用户意外关闭。

## 17. 与既有方案的关系

- [session-messaging.md](./session-messaging.md)：保留“一条管道 N 个发送方”、单批 ≤5、用户队列优先、后台不切视图、信箱不持久化等裁决；本文补齐其投递失败后的闭环。
- [ai-queue-background-flush.md](./ai-queue-background-flush.md)：保留 composer 队列独立语义和“一轮一条”；本文不把信箱并进 composer 队列。
- [multi-instance-sync.md](./multi-instance-sync.md)：保留回合租约单写者、`other_window`、终态写盘后释放；本文只规定信箱如何等待与重试，不修改锁实现。
- [session-compaction-disk-growth.md](../unfinished-plans/session-compaction-disk-growth.md)：压缩存储/磁盘语义不变；本文只收口压缩对信箱投递的生命周期影响。

## 18. 最终设计判定

这个问题的正确抽象不是“多重试几次”，而是：

> **信箱是一份按会话隔离的未送达投递账本；任何已受理通知，在进入模型上下文前都必须有明确状态、明确owner和明确恢复路径。**

只要坚持以下三条，故障就不会再依赖用户手动发送来兜底：

1. `accepted` 之后不丢：pending、inFlight、delivered 三态可追踪；
2. retryable 不放弃：状态机持续低频重试，事件只负责更快；
3. 生命周期全收口：流、压缩、重读、租约、清空都使在飞结果和等待状态进入确定状态。
