# 后台会话的排队消息不会自动续跑（已实施）

> 状态：**已实施（方案 A 2026-11-19；方案 B 2026-11-27）**（2026-11-19 评估成文，当日立项当日落地方案 A；方案 B 于 2026-11-27 落地，见 §10）
> 来源：排查「`currentSession()` 串会话」时的同源发现——队列消费入口把「UI 代发」当成了唯一通路。
> 性质：原为只读评估。行号按 2026-11-19 工作区实测（实施后行号已漂移，以代码为准）；同批只做了一处无争议清理（`ai-subagents.parentSessionOfSub` 的 `currentSession()` 兜底已删，见 §7）。

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| 现象 | 会话 A 在后台生成、用户切到 B；A 的排队消息（含插话/抢占降级）在 A 本轮结束后**不会发出**，直到用户切回 A |
| 根因 | `flushMessageQueue(sessionId)` 里有 `session.id !== sessionId → return`（`ai-message-queue.js:582-583`），把「只能 UI 代发」写成了唯一通路 |
| 消息会丢吗 | **不会**。队列在内存里，切回该会话时 `switchSession` 的 `setTimeout(() => flushMessageQueue(id), 0)`（`ai-panel.js:13605`）会补发 |
| 真实损失 | 语义承诺落空（"本轮结束后发送"）；用户以为已发出；多条排队积压；抢占降级后没打断 |
| 可行性 | **高**。`startSessionTurn` 已是纯内核（`ai-panel.js:10738`），后台起轮已有成熟先例（`wakeWith`，`ai-agent-notices.js:214`） |
| 建议 | 方案 A：把 flush 的"取项"与"发项"拆开，后台会话走内核起轮。半天 + 测试 |
| 优先级 | 中。不做不丢数据，但会反复收到"消息怎么没发出去"的体感投诉 |

## 1. 现状机制

排队消息的一生分三段：**入队 → 消费 → 早退**。

### 1.1 入队（按会话分区）

| 入口 | 位置 | 说明 |
|---|---|---|
| `enqueueComposerMessage` | `ai-message-queue.js:442` | 生成中按 Enter → 排队 |
| `interjectComposerMessage` | `ai-message-queue.js:459` | Ctrl+Enter 插话；压缩中 / 不可 steer 时**静默降级为排队** |
| `preemptComposerMessage` | `ai-message-queue.js:515` | Ctrl+Shift+Enter 抢占；停止窗口内降级为队首排队 |

条目形状（`ai-composer.js:557` 的 `captureComposerMessage`）：`{id, ts, delivery, sessionId, text, attachments[]}`，存进 `model.forSession(sessionId)` —— **数据本身已经按会话隔离**。

### 1.2 消费：唯一入口是 UI 代发

`flushMessageQueue(sessionId)`（`ai-message-queue.js:580`）是唯一把队列项变成请求的地方，但它做的是"把内容灌回输入区再发"：

```js
// ai-message-queue.js:580-604（现状，节选）
async function flushMessageQueue(sessionId) {
    if (!sessionId || streams.has(sessionId) || compactOf(sessionId)) return;
    const session = currentSession();
    if (!session || session.id !== sessionId || session.archivedAt) return;   // ← 早退闸门
    if (currentPendingAskEntry() || planApprovalMessage(session)) return;
    const item = model.forSession(sessionId)[0];
    if (!item) return;
    if ((el.input && el.input.value.trim()) || getAttachments().length) return; // 保护草稿
    ...
    setAttachments((item.attachments || []).map((att) => ({...att})));          // 写 UI
    if (el.input) el.input.value = item.text || '';                             // 写 UI
    const ok = await submitText(item.text || '', null, {preserveScroll: true}); // 内部又用 currentSession()
    ...
}
```

三重依赖把它绑死在"当前查看的会话"上：`currentSession()` 判定、`el.input` 草稿保护、`submitText` 自己再取一次 `currentSession()`。

### 1.3 调用点盘点

| 位置 | 场景 | 后台会话时的结果 |
|---|---|---|
| `ai-panel.js:11457` `finishStream` 里 `flushMessageQueue(session.id)` | 该会话轮末冲刷**自己的**队列 | **早退（死调用）** |
| `ai-panel.js:11459` 同上，`flushMessageQueue(viewing.id)` | 前台会话轮末顺带冲刷自己的队列 | 正常（与上一行重复，先成功的那个清空后另一个自然 return） |
| `ai-panel.js:14377` `finishCompact` 末尾 | 压缩结束冲刷 | 后台压缩时**早退（死调用）** |
| `ai-panel.js:13605` `switchSession` | 切回该会话 | 正常——**目前唯一有效的补发时机** |
| `ai-message-queue.js:385` 队列卡片「插话」按钮 | 卡片只画当前会话 | 正常 |
| `ai-message-queue.js:478 / 534 / 577` composer 三手势的空闲分支 | 发起者一定是当前会话 | 正常 |

注意 `finishStream` 那段还写了另一半：

```js
if (shouldFlush) {
    if (session) flushMessageQueue(session.id);                                  // 意图：发后台会话自己的
    const viewing = currentSession();
    if (viewing && (!session || viewing.id !== session.id)) flushMessageQueue(viewing.id); // 意图：顺带发前台的
}
```

第一行的注释与意图都很明确（作者想让后台会话续跑），实现却被守卫挡掉——**这是"意图对、实现死"的典型**，不是设计取舍。

## 2. 为什么一直没被当 bug

1. 切回会话会补发（`13605`），用户看到的是"慢半拍"而不是"丢了"；
2. 会话列表有未读角标（`finishStream` 的 `setSessionUnread`），至少不会完全无感；
3. 单会话单任务的使用习惯下几乎不触发——要有"切走 + 留了排队消息 + 后台跑完"三个条件叠加。

## 3. 真正的损失（按严重度）

1. **语义破坏**：排队 = "本轮结束后自动发"。后台会话本轮结束了却不动，这个承诺失效；抢占降级更糟——用户以为打断了，实际只是排到了队首。
2. **体感故障**：用户按 Enter 后切去做别的事，回来发现在队列里躺着，且没有任何提示说"没发出去"。
3. **积压放大**：现有设计一次只发一条（每轮 `finishStream` 一次），后台不冲刷 → N 条排队要切回后连续触发 N 轮才发完。
4. 不涉及跨窗口：队列只在发起窗口的内存里（`model` 是模块级 Map），多实例不会互相看到对方的队列。

## 4. 方案

### 4.1 方案 A：后台走内核起轮（推荐）

把 `flushMessageQueue` 拆成"取项"与"发项"两步，发项按会话分两条路：

```js
// 取项：只做守卫，不碰 UI
function takeQueuedItem(sessionId) {
    if (!sessionId || streams.has(sessionId) || compactOf(sessionId)) return null;
    const session = sessionById(sessionId);
    if (!session || session.archivedAt) return null;
    if (currentPendingAskEntry(sessionId) || planApprovalMessage(session)) return null;
    const item = model.forSession(sessionId)[0];
    if (!item) return null;
    // 输入区草稿保护只对"当前会话"有意义（后台会话没有输入区）
    if (session.id === currentSession()?.id &&
        ((el.input && el.input.value.trim()) || getAttachments().length)) return null;
    model.remove(item);
    renderMessageQueue();
    return item;
}

// 发项：当前会话走 UI（看得见地发），后台会话走内核（不碰 UI）
async function dispatchQueuedItem(session, item) {
    if (session.id === currentSession()?.id) {
        setAttachments((item.attachments || []).map((att) => ({...att})));
        if (el.input) el.input.value = item.text || '';
        const ok = await submitText(item.text || '', null, {preserveScroll: true});
        if (!ok) restoreItemAtHead(session, item);   // 现有回退逻辑搬过来
        return;
    }
    const result = await startSessionTurn(session, item.text || '', {
        attachments: mapQueueAttachments(item.attachments),   // 与 submitText 同一口径（images / videos / texts）
        allowPendingEdit: false,
        truncateAt: null,
        preserveScroll: true,
    });
    if (!result.ok) restoreItemAtHead(session, item);          // 失败不丢：放回队首 + 未读 + 桌面通知
}
```

失败回退直接照抄 `wakeWith` 的成熟分支（`ai-agent-notices.js:228-245`）：回队首、`setSessionUnread(session, 'done')`、`notifyDesktop({kind:'error', …})`，并把 `over_budget` 单独给人话（"上下文已超阈，排队消息暂存在队列"）。

**为什么这是低风险**：`startSessionTurn` 已经是纯内核（`session` 参数一路用到底，预算预检 / 租约 / 权限档 / 计划模式全在内部），后台起轮有 `wakeWith` 这个跑了很久的先例；差别只是内容来自队列而不是信箱。

### 4.2 方案 B：彻底解耦

把 `dispatchQueuedItem` 做成队列模块的对外 API，UI 与后台共用；`flushMessageQueue` 退化为薄壳。改动面更大（队列模块要注入 `submitText` / `startSessionTurn` / 会话查询，4 个调用点全要跟着改），收益是"以后加第三条发送路径不用再拆一次"。

> **已落地（2026-11-27），见 §10。** 上面这段的成本估算是评估当时的：方案 A 落地后，`startSessionTurn` / `sessionById` / `setSessionUnread` 等依赖本来就已注入队列模块，所以真做起来不是「让后台补上代发的能力」，而是「删掉代发」——队列模块净减代码。

### 4.3 方案 C：不做，只加可见性

- 会话列表给"有待发消息"的会话加徽标（`model.hasItems(sessionId)` 已有现成 API，`ai-session-list.js` 只需读它）；
- 后台 `finishStream` 且 `hasItems` 时打一条未读 + 一条消息中心记录（"排队消息未发出：切回后继续"）。

成本约 0.1 天，语义问题不解决，但把"静默"变成"可见"。

### 4.4 对比

| 维度 | A | B | C |
|---|---|---|---|
| 解决语义 | 是 | 是 | 否 |
| 改动面 | `ai-message-queue.js` 一个函数拆两段 + 两处死调用变活 | 队列模块 API + 4 调用点 | 列表 UI + 一条通知 |
| 风险 | 低（复用 `wakeWith` 模式） | 中（跨模块依赖注入） | 极低 |
| 估计 | 0.5 天 + 测试 | 1–1.5 天（A 落地后实测 ≈ 半小时） | 0.1 天 |
| 结论 | 已实施（2026-11-19） | **已实施（2026-11-27）** | 未做 |

## 5. 风险与不变量

| 项 | 处理 |
|---|---|
| 后台自动发送 = 真烧 token | 排队本来就是用户按了发送；与 `wakeWith` 同性质。可选加设置项（§6-1） |
| 上下文超阈 | `startSessionTurn` 的预算预检会返回 `over_budget`；**必须**回队首而不是丢弃，并给可见提示 |
| 权限档 / 计划模式 | 全部由 `startSessionTurn` 按 `session.scope` / `session.planMode` 处理，与手动发送一致；不做任何"后台降档" |
| 待回答 / 计划待批准 | `takeQueuedItem` 保留 `currentPendingAskEntry(sessionId)` 与 `planApprovalMessage(session)` 守卫，有卡就不发 |
| 跨窗口写权 | `startSessionTurn` 内部取租约，失败返回 `lease_failed` / `other_window`；按普通失败回队，等下次轮末再试 |
| 顺序 | 维持"一轮一条"：一次 `finishStream` 只发队首一条，下一条等这一轮结束。不要在 flush 里循环（会与 `anyStreaming` 打架） |
| steer 残留 | `finishStream` 已做 `fallbackSteerToQueue`，残留项以 `delivery:'queue'` 正常发出 |
| 滚动位置 | 后台路径必须 `preserveScroll: true`，且任何 `renderMessages` / `setStreamingUI` 调用都要 `isViewed` 守卫（不要在后台路径刷前台 UI——与 2026-11-19 计划模式串台同一类错误） |

## 6. 开放问题

> **2026-11-19 作者裁定：三条全部不做。** 一轮一条就是正常语义——要合并成一串，用户自己组织那一条消息即可（排队不是「消息合并器」）；后台自动发送不设开关（排队＝用户已亲手按下发送，与信箱唤醒同性质）；成功不额外提示（发出去了本身就是结果，只有失败需要可见）。下面三条仅作为历史提问保留。

1. **要不要开关**？"后台会话的排队消息自动发送"（默认开 / 默认关）。默认关会让 A 方案退化成 C。→ **不做**。
2. **多条排队要不要连发**？现在"一轮一条"，3 条排队 = 3 轮往返。连发需要在 `finishStream` 后循环 dispatch，与自动压缩 / notice 唤醒会抢同一会话，得排优先级。→ **不做**（合并由用户自己把内容写进一条消息）。
3. **后台发出后要不要提示**？建议 `notifyDesktop` 一条轻量记录（`kind:'success'`，`completion:true` 不刷消息中心），或只在会话行显示"已发 N 条"。→ **不做**（失败才提示）。

## 7. 同批已清理（无争议）

`ai-subagents.parentSessionOfSub`（`ai-subagents.js:602`）原本在父会话与根会话都查不到时兜底 `currentSession()`，会把子代理的结算/记录挂到用户正看着的另一个对话上。父与根都没了，这条子代理也没有归宿，改为返回 `null`（三处调用点只把它喂给 `profileOf` / `entryOf`，二者对 `null` 安全，回落窗口默认模型）。

## 8. 测试建议

- **纯函数**：`takeQueuedItem` 的守卫矩阵（busy / compacting / archived / ask / plan / 非当前会话带草稿）各一条。
- **源码守卫**：`finishStream` 的 `flushMessageQueue(session.id)` 不得再是死调用——断言 `flushMessageQueue` 内不存在"目标不是当前会话就 return"的唯一通路，或断言存在后台分支（本仓库惯例：接线用源码断言兜住静默退化，见 `ai-tool-wiring.test.mjs`）。
- **手测**：A 会话长任务运行中切到 B，在 B 里给 A 留 2 条排队消息 → A 结束后逐条发出（切回 A 可见两条用户消息与两条 AI 回复），B 的输入框与滚动不受影响。

## 9. 实施记录（2026-11-19，方案 A）

用户实测复现后当日落地（测试会话：发「1」→ AI `sleep 10s` → 后台发「2」，切回才发出）。落地范围严格按 §4.1，未做 B / C：

| 落点 | 内容 |
|---|---|
| `ai-message-queue.js` `takeQueuedItem(sessionId)` | 守卫 + 摘除一步完成：忙（流 / 压缩）、归档、待回答卡、计划待批准、**当前会话的输入区草稿**；其余与旧逻辑逐条等价 |
| `flushMessageQueue(sessionId, opts)` | 只做分派——当前会话 → `flushThroughComposer`（原 UI 代发路径原样保留），后台会话 → `flushInBackground`（内核起轮） |
| `flushInBackground` | 引用前缀用 `quoteMarkupFromAttachments`、附件用 `queuedAttachmentsPayload`（与 `submitText` 同一口径），调 `startSessionTurn(session, text, {allowPendingEdit:false, truncateAt:null, preserveScroll:true})`；**不碰 `el.input` / 不刷前台视图** |
| 失败处理 | 回插该会话队首（不丢）+ 状态栏人话（over_budget / archived / 另一窗口 / 其他）+ 会话未读标记；`scheduleFlushRetry` 2.5s 单次自愈（`fromRetry` 防无限打转），busy 只重试不打扰 |
| 接线 | `ai-panel.js` 的 `createAIMessageQueue({...})` 注入 `sessionById` / `startSessionTurn` / `setSessionUnread`；`finishStream` 与 `finishCompact` 原有的 `flushMessageQueue(session.id)` 由此从死调用变成活路径，调用点零改动 |

**刻意不做的**（**2026-11-19 作者裁定：三条全部不做，不是遗留待办**）：① 连发（§6-2）——一轮一条就是正常语义，要合并成一串由用户自己组织那一条消息（排队不是「消息合并器」）；② 没有加「后台自动发送」开关（§6-1）——排队本来就是用户亲手按下发送，与 `wakeWith` 同性质，加开关等于给默认行为打折；③ 没有 `notifyDesktop`（§6-3）——后台成功发出本身就是结果，用状态栏只在**失败**时提示。

**测试**：`test/ai/ai-message-queue.test.mjs` 新增 5 例（`queuedAttachmentsPayload` 分组 / 后台成功走内核且不碰输入区 / 失败回插队首 + 未读 + 红字提示 / 忙时不取项 / 当前会话仍走输入区）；`test/ai/ai-turn-steer-wiring.test.mjs` 的重试与 import 断言同步到新实现，并加断言「后台分支必须调 `startSessionTurn`」。均登记在 `npm test`。

## 10. 实施记录（2026-11-27，方案 B：彻底解耦）

方案 A 落地一年后再评估：**代发不提供任何发送语义**，它不是设计而是存量路径。理由链：

1. 视图渲染本来就在内核里——`startSessionTurnInner` 用 `viewed = isOpen() && currentSession() === session` 守卫渲染（`ai-panel.js`），`setStreamingUI()` 内部已刷新发送按钮。当前会话起轮后气泡与流式光标由内核负责，代发没有贡献。
2. 代发独有的只剩四样，三样是负担：`ctxGate` 快拦（内核权威预检 `over_budget` + `onQueueOverBudget` 已等价）、`allowPendingEdit: true`（冲刷不该截断用户正在编辑的那条）、`onStarted` 清输入框（只因为代发先往里写了东西）、一份**与后台路径并行的** reason → 人话映射表。
3. 它带来一个真实隐患：`flushThroughComposer` 先 `el.input.value = item.text` 再 `await submitText(...)`；`await` 窗口里用户切走会话，那段文字就留在**别的会话**的输入框里——「冲刷入口 + 失败收尾都要 `dropComposerDraft`」这套补偿正是为它存在。
4. 反证：`wakeWith`（后台通知唤醒）/ 定时任务 / 编排 / 群消息 / 原地编辑重发全部直连 `startSessionTurn`，从来没人给它们加代发；只剩「当前会话的队列冲刷」这一条例外，说明它是历史包袱。

| 落点 | 内容 |
|---|---|
| `ai-message-queue.js` | 删 `flushThroughComposer`；`flushInBackground` → `dispatchQueuedItem`（所有会话唯一的发送路径）；`flushMessageQueue` 只做「取项 → dispatch」，不再按 `currentSession` 分叉 |
| 依赖面 | 移除已无用的 `submitText` / `setAttachments` / `renderAttachments` / `resizeInput` / `updateSendState` / `dropComposerDraft`；新增 `describeTurnFailure`（失败文案单一来源）。`takeQueuedItem` 的守卫矩阵与草稿保护**一字未动** |
| 失败文案 | `ai-panel.js` 的 `flashTurnStartFailure` 重构为 `turnStartFailureText(result, opts)` + 薄壳；`submitText` 不再自建分支表，`no_backend` / `no_profile` 的副作用（`showNote` / 重绘）留在原处；队列侧 `queued: true` 走「留在队列」措辞，非当前会话带会话名 |
| 不变量 | 一轮一条、`fromRetry` 单次自愈、失败回插队首 + 未读 + 状态栏、`over_budget` 触发兜底压缩、`preserveScroll: true`、`allowPendingEdit: false` 全部保留 |
| 测试 | `ai-message-queue.test.mjs`：把「当前会话仍走输入区代发」反转为「同样走内核」，两例草稿补偿测试换成**输入区零写入**回归守卫（`value` 用 getter/setter 计数，旧路径必然写 ≥1 次）；`ai-turn-steer-wiring.test.mjs` 断言合并为「唯一分派路径必须调 `startSessionTurn`」并禁字面量 `flushThroughComposer` / `flushInBackground`；`ai-draft-hygiene.test.mjs` 断言队列侧不再注入 `dropComposerDraft`；`ai-archived-readonly.test.mjs` 跟随文案来源迁移 |

**验证**：`npm test` 全量（含 typecheck 前置门）退出码 0。

**行为变化（用户可见）**：前台会话的排队消息不再在输入框里闪一下，直接出现在对话区；冲刷失败的提示措辞与手动发送统一。
