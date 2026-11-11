# CaDt-DataLens AI 助手审查报告（对照 dsh 源码）

> 审查任务书：`docs/reports/ai-assistant-review-prompt.md`
> 参照物：本地 DeepSeek Harness（dsh）v0.2.2-rc.1 解包源码（`%TEMP%\dsh-review-src\app`，331 个
> `@deepseek-ai/*` 包，未压缩、带 JSDoc）。
> 审查日期：2026-11-11。同日复核：全部声明已逐条对照本仓库与 dsh 源码校验，行号与表述已按实际代码修正。
> 审查员只读，未修改业务代码。

## 总评

CaDt-DataLens 的 AI 助手在**功能覆盖上已达 dsh 的八成以上**：流式双协议、无硬上限的工具循环、
三档权限+写审批、上下文压缩、技能/记忆注入、todolist、重试均已落地且核心链路健壮（有 Go 测试背书）。
**最大差距**集中在三处：①持久化是「快照式 localStorage」而非 dsh 的「事件溯源 JSONL」，导致中断
恢复只能靠归一化兜底（running 工具永久执行中、回合无收尾事件）；②错误只有人读文案、没有稳定分类码，
无法做 QUOTA/CONTEXT_WINDOW_EXCEEDED 等语义化路由与自动恢复；③安全纵深少了「凭据打码」与
「错误码脱敏」两道显示层防线。UI 层经过本轮对齐后与 dsh 的差距已小，主要是滚动/草稿/折叠的
会话级状态保持。

## 审查对象现状概览（我方）

- **前端** `frontend/src/ai-panel.js`（10094 行单文件闭包）：会话/流式渲染/工具桥/技能/记忆/
  写审批/Todolist/变更记录/上下文压缩/设置/三形态面板；事件经 `handleEvent` 统一进入
  （ai-chunk/ai-think/ai-toolcall/ai-done/ai-error/ai-retry，L5784-5905）。
- **后端** `ai.go`（1666 行）：双协议（OpenAI 兼容 + Anthropic）SSE 归一化
  `streamOpenAISSE`/`streamAnthropicSSE`（ai.go:1112/1198）、429/5xx/网络错误指数退避重试
  （`aiRetryDelay` ai.go:709-721：1s→2s→4s…上限 30s、±15% 抖动、遵循 Retry-After、重试次数上限 10、
  仅在未输出流内容前重试）、120s 看门狗（ai.go:32/605）、Windows 系统代理探测（ai_proxy_windows.go）；
  命令执行在 `ai_command_windows.go`。工具的分发/校验/审批在前端 `executeTool`。
- **工具面**：list_dir/read_file/search_text/write_file/edit_file、memory_list/read/write、skill_use、
  plan_mode、ask_user、todo_write、app_control（host 动作桥 main.js:1973 `runAppAction`）、
  env_list/env_create，以及 browser_* 共 11 个（navigate/back/forward/reload/snapshot/screenshot/
  click/type/press_key/evaluate/close，Go 侧 browser_windows.go 有真实绑定）。
  browser_* 与 env_* 为审查日当天新落地，未列入原始审查范围，此处仅记录存在，未做逐项对照。
- **权限模型**：读取/工作区内修改/完全权限 三档 + 计划模式；写操作走 diff 审批卡 +
  会话级/永久授权记忆；app_control 可在设置整体关闭（`appControlOn`，ai-panel.js:554/3894）。
- **持久化**：会话（含消息/待审批/待提问/Todolist/变更记录）存 localStorage
  `datalens-ai-sessions`（单 key 全量 JSON，L6/1143；图片预算 3.2MB + 分级降级，L24/1112-1183）；
  加载时归一化——流式中断 → done、待审批 → cancelled（附说明文案）、待提问 → expired
  （另有 envAsk pending → cancelled），不会卡死（`normalizeMessage` L916-990）。

## 一、Agent 循环与会话

**dsh 的做法**：turn 内 `while(true)` 逐 step（dsh-agent-loop/lib/index.js:739），靠「assistant 无
tool-call / max-tokens / blocked / aborted / error」收尾，**无硬性轮数上限**（Config 仅有
maxParallelToolCalls，index.js:1313-1321）；工具结果回传严格配对（`tool/call` 记 seq →
`tool/result` 用 `sourceEventSeqs` 引用，dsh-session/lib/types/repair.js:111-172）；step 失败时
`ToolCallRecovery`（类定义在 **dsh-session**，repair.js:84；agent-loop 仅调用）合成错误 tool/result
补写——已开始的调用 `TOOL_OUTCOME_UNKNOWN`（repair.js:17：「…Its outcome is unknown… retry only
if the operation is read-only or idempotent…」）、未开始的 `TOOL_NOT_STARTED`（repair.js:18：
「…Retry it if it is still needed.」），保证 call/result 永远配对；错误链 `errorChain`
（dsh-llm/lib/types/error.js:95）完整写回 turn/end；重启恢复靠事件重放 + `openTurnClosers`
合成收尾事件（`reason:{kind:"interrupted"}`，repair.js:187-189）。

**我方对照**：
- 做得好：工具结果以 tool 消息紧跟 assistant（tool_calls）写入历史，正常路径配对；**无硬性轮数
  上限与 dsh 一致**——每 40 轮（`AI_TOOL_ROUND_LIMIT`，ai-panel.js:9）注入一次「适时总结收尾」
  软提醒（L5426-5438），停止只由用户中止/上下文压缩/模型自然结束触发；会话加载归一化把
  「流式中断→done、待审批→cancelled+文案、待提问→expired」，不会卡死 UI（L916-990）。
- `P1` **中断回合无收尾事件**：应用在工具执行中退出，tool 消息以 `status:'running'` 落盘
  （L935 白名单原样保留），重启后永久显示「执行中…」（L2193/L2588）。dsh 会合成
  `TOOL_OUTCOME_UNKNOWN` 收尾。
- `P2` **followup/steer 队列缺失**：dsh 有 durable inbox（next-turn/next-step 两级注入，事件溯源
  可恢复，dsh-agent-loop/lib/index.js:79-86）；我方排队消息（`messageQueue`，L623）仅内存态，
  重启即失。

## 二、流式与重试

**dsh 的做法**：错误先归类为稳定 machine code（providerError，dsh-llm-deepseek/lib/index.js:1771-1790：
AUTH/QUOTA/RATE_LIMIT/SERVER/CONTEXT_WINDOW_EXCEEDED/INVALID_REQUEST/MALFORMED_RESPONSE/
EMPTY_RESPONSE/TIMEOUT 等，「route on this, never by parsing `message`」，dsh-llm/lib/types/error.js:13）；
重试策略按 code 白名单（默认 5 次、initial 500ms、maxDelay 10s、jitter 0.1、指数 `500ms×2^(n-1)`，
dsh-llm/lib/types/retry-policy.js:12-22 + dsh-llm-retry/lib/index.js:44-49）；Retry-After ≤ maxDelay
时原样遵循，**超过 maxDelay 不是 clamp**——normal 策略放弃重试、always 策略退回本地指数退避
（dsh-llm-retry/lib/index.js:177-181）；重试「计划→等待→开始」双事件落盘可审计（llm/retry +
llm/retry-started，index.js:149-151）；SSE 解析委托 eventsource-parser，心跳（SSE 注释行）喂看门狗，
空闲超时 300s 且只在 await 期间计时（dsh-llm-deepseek/lib/index.js:35-36、dsh-timeout/lib/index.js:86-133）；
finish 但零内容编码为 `EMPTY_RESPONSE`（safe-to-repeat，重试白名单首位）。

**我方对照**：
- 做得好：重试已覆盖 429/5xx/网络错误、指数 1s→30s+抖动、遵循 Retry-After、次数上限 10
  （ai.go:239-241）、仅在未输出任何流内容前重试（ai.go:602-603）、可被停止/看门狗取消；SSE 行缓冲
  4MB、逐行 touch 喂看门狗（120s，ai.go:32/605/1131）；**前端有「空回复兜底」**：finish 且零内容时
  删除空 assistant 自动重试一轮（emptyRetried 标记，ai-panel.js:5868-5891）；畸形 JSON/非 SSE/
  HTTP 401/429 退避/重试耗尽/400 不重试均有 Go 测试（ai_test.go:565-962）。
- `P1` **无错误分类码**：错误只有人读文案，无法按 code 路由（如 QUOTA 不该重试、
  CONTEXT_WINDOW_EXCEEDED 应触发压缩恢复——见维度三）。dsh「route on code, never parse message」。
- `P1` **Retry-After 无上限**：`aiRetryDelay` 直接采用服务器给的非负秒数（可能 3600s，ai.go:709-714，
  30s 上限只作用于本地指数分支 ai.go:715-718），而看门狗 120s 会在等待期内触发误杀→报空闲超时。
  dsh 的对策是「超限放弃重试（normal）/退回本地退避（always）」，我方任选其一皆可修复
  （或直接 clamp ≤30s/60s）。
- `P2` **EMPTY_RESPONSE 无独立归类**：空回复兜底是前端 ad-hoc 处理（每轮仅重试一次，之后按正常
  完成收尾 L5893-5895）；dsh 归为 machine code、统一进重试策略；后端无对应测试。
- `P2` **畸形流块即中断**：单个 JSON 坏块 `return 解析失败`（streamOpenAISSE ai.go:1146-1148）；
  dsh 同样报错但归类 MALFORMED_RESPONSE 计入重试策略，我方可考虑「跳过坏块计数」的容错模式。

## 三、上下文管理

**dsh 的做法**：阈值 0.8 + **headroom 预留 65536** + retain 0.16（dsh-compaction-basic/lib/index.js:
15-63）；三个触发点（步间压力 agent/pre-step / 模型切换预估 agent:request / **CONTEXT_WINDOW_EXCEEDED
溢出恢复 agent/request-error**，index.js:829-903）；切点用 tool-call/result 配对计数校验
（`toolPairingBalancedBefore`，dsh-compaction/lib/index.js:80，防止把工具调用与其结果切开）；摘要指令
作为**最后一条 user message** 走真前缀复用 KV cache（index.js:233-238），固定 8 段结构
（index.js:246-283），摘要必须比被替换区域小（事务，index.js:601）；工具结果修剪 8192 码点阈值→
头 4096+尾 1024 按码点切（dsh-compaction-tool-result-pruner/lib/index.js:11-13）。

**我方对照**：
- 做得好：autoCompactThreshold 0.8 与 dsh 一致（可调 0.5-0.95，ai-panel.js:689/7449/7563）；压缩
  摘要+保留近期+归档不回传；**裁切有配对保护**——切点回退到 user 消息边界
  （`while (… role !== 'user') cutoff--`，L7600-7601），buildApiMessages 还会跳过孤立 tool 消息防
  400（L2972-2989）；token 估算字符近似（ASCII/4 + CJK×0.75，UI 标注「估算」）务实。
- `P1` **无溢出自动恢复**：CONTEXT_WINDOW_EXCEEDED 只会报错让用户手动 /compact（finishStreamError
  仅记录 L5473-5478，maybeAutoCompact 只在一轮结束后调用）；dsh 在 request-error 时自动压缩并重试。
- `P2` **无 headroom 预留**：0.8×窗口不含 completion 预留，长回复可能顶满。
- `P2` **无工具结果统一修剪**：各工具有内部截断（read_file 64KB 字符 L4627、run_command 各
  16000 字符 L5010-5012、search 200 条 L4635），截断后全文驻留上下文直至压缩；dsh 在进上下文前
  统一修剪。
- `P2` **切点粒度粗于 dsh**：我方回退到 user 边界安全但保守（可能多保留内容）；dsh 的配对计数
  允许紧贴工具对切割，保留窗口更精准。

## 四、工具系统与安全

**dsh 的做法**：双端 schema 校验（模型侧 execute 前再验一次，dsh-tools/lib/index.js:337-342，违规
抛 ToolArgsError/INVALID_ARGS）；审批服务不可用时 degrade 为 deny（dsh-tools/lib/pipeline.js:598-615）；
args 快照+deepFreeze 防执行期篡改（pipeline.js:327-331）；工具声明 `timeoutMs`（cooperative timeout，
dsh-tool-call-timeout-policy）；并行需工具显式声明 concurrency-safe（fail-closed，pipeline.js:279-288）；
abort 时为每个未派发调用补 isError 结果（pipeline.js:220-228）。

**我方对照**：
- 做得好：路径越界防护（**工作区外路径仅完全权限档可达**——完全权限可用任意路径，其余档绝对路径
  也必须落在工作区内才放行；`aiResolveScopePath` L3425-3437 + `aiPathInside` L3418-3425）、
  read_file 64KB 上限、search 200 条上限、记忆文件名白名单（`MEMORY_NAME_RULE` L3927，执行点
  L4011/7223）、写审批+授权记忆（session/always 两级，L2305-2315/4197-4215）+设置可清除
  （L8901-8909）、run_command 超时可配 1s–120s（默认 30s，L4986/ai_command_windows.go:62-67）且
  超时不算错误（回传已捕获输出）、密钥不落日志（日志仅 provider/host/model/计数 ai.go:273-274，
  API Key 只在请求头，ai.go:63-64 注释明示）、app_control 可整体关闭、恢复时待审批归一为 cancelled。
- `P2` **路径校验仅在前端一层**：Go 绑定方法（OpenFile/SearchWorkspace/AIRunShellCommand 等）
  本身通用、无独立范围校验，防越界依赖前端 executeTool 正确传参；纵深上少一道。
- `P2` **无统一 args schema 校验层**：各工具在执行器内手工校验（executeTool switch），遗漏风险靠
  review 兜底；dsh 双端校验+路径化错误更稳。
- `P2` **工具执行无独立超时**（仅 run_command 有 timeoutMs；list_dir/read_file 等依赖后端实现
  自身的边界）。
- `P2` DOMPurify 放行 `c:` URI 协议（`ADD_URI_PROTOCOL:['c']`，main.js:4457，为本地图片
  resolveAIImages）：`c:` 开头的链接 href 也会通过消毒，虽在 WebView 内不可导航，建议
  resolveAIImages 之外的 href 保持默认白名单。

## 五、UI 模式对照

**dsh 的做法**：工具卡头部四件套（图标+动词+单行摘要+右缘量化徽章）；状态机五态
preparing/running/ok/error/stopped（dsh-client-ui-tool/lib/client.js:336）——preparing 不可展开
（:1637）、error/stopped 隐藏量化徽章只留错误摘要（:1651-1653）、**终端非零退出把 ok 升格为 error**
（`terminalCardModel` client.js:1004，从输出尾部 `[exit code: N]` 标记解析，:983）；折叠默认全收起；
diff 行内预览限 9 行、read/search 限 8 行，终端全量但容器 224px 滚动（CSS
--dsl-terminal-output-max-height）；「跟随底部」是意图对象（25px 容差 client.js:1774+平滑动画期忽略
+scrollend 结算 :4724+500ms 采样 :1506）；会话切换保持三层状态（语义滚动位 `chatScrollPositions`
Map chat client.js:15344/草稿快照 dsh-client-ui-conversation/lib/client.js:4389,4538/折叠选择
`createChatStore` chat client.js:4455-4473）；AI 输出**凭据打码**（dsh-client-ui-secret-mask：
`CREDENTIAL_FORMATS` 28 种、`VISIBLE_PREFIX` 8 字符+可复制掩码+挂载即重置隐藏）；模型/标题文本先
normalize（dsh-session-title/lib/types/normalize.js:56：剥 OSC/CSI/双向字符+字节预算截断不劈码点）；
危险权限档切换带「我已了解风险」确认（dsh-client-ui-permission-presets:167-171）；审批卡
Enter=允许/Esc=拒绝（含输入法 composing 防误触，dsh-client-ui-approval/lib/client.js:71-91）。

**我方对照**：
- 做得好：工具卡四件套本轮刚对齐（动词/图标/主参数/diff 统计/行号 diff/$ 命令块，ai-panel.js
  L2469-2684）；完成态默认折叠与 dsh 一致（L2681-2684）；写审批卡含 diff 预览+记住选择（比 dsh
  审批卡信息更足，dsh 审批卡只放命令文本）；「跟随底部」有 stickBottom 阈值（80px，L9259）与
  「加载更早」按 token 预算分页（AI_RENDER_*_TOKENS，L595-596/1731-1778）；流式状态条与
  transcript 隔离（80ms 防抖增量更新，L5243-5260；状态条固定于消息区底部，style.css:4906-4907）；
  prefers-reduced-motion 部分尊重（style.css:4903-4905）；diff 预览限 40 行
  （AI_DIFF_PREVIEW_LIMIT，L4108-4137）+ 容器 220px 滚动（style.css:6056-6058）。
- `P1` **终端非零退出未升格错误**：run_command 结果文本已带「退出码：N」（L5016-5018，并随 tool
  消息回传模型），但前端不解析退出码，非零退出卡片仍显示「完成」（L2194）。dsh 从输出尾部标记
  解析 exit/signal 并升格——我方只差卡片侧解析一步。
- `P1` **AI 输出无凭据打码**：read_file 读到 .env/API key 时密钥会明文进入聊天记录（截图/导出即
  泄露）。建议按 dsh 的 28 种凭据格式清单做显示层打码（保留前 8 字符+掩码+挂载即隐藏）。
- `P2` **会话切换三层状态缺失**：语义滚动位置不保持（switchSession→renderMessages 跳底部，
  L6700-6710）；输入框全局共享（跨会话泄漏，既不按会话保存也不清空）；折叠状态仅内存级保留
  （key 含 session.id，重启丢失，L2002）。dsh 三层均为持久语义状态。
- `P2` diff 预览 40 行（比 dsh 行内 9 行宽松，信息密度可再权衡）。
- `P2` 无 LLM 会话标题生成（现为「会话 N」兜底 L999 / 首条消息截 24 字符 L1274-1278）；dsh 有
  normalize+字节预算截断的标题管线。若做生成，标题必须走 normalize（防控制字符注入标题栏）。
- `P2` 错误展示未按错误码区分（AUTH 类应隐藏 provider 原文，防文案泄漏）。
- `P2` 压缩完成后消息流内无「已压缩」标记（dsh 有 sticky CompactionItem），归档只在弹层可见。

## 六、工程质量

- 做得好：协议/重试/解析有 Go 测试（TestAIStreamRetry429Backoff/TestAIStreamRetryExhausted/
  TestAIStreamNoRetryOn400/TestAIStreamMalformedChunk/TestAIStreamNonSSE/TestAIStreamHTTPError/
  TestAIRetryDelayExponential，ai_test.go:565-962）；设计文档与实现同步（docs/ai-panel.md）；
  关键常量集中在文件头（AI_*）。
- `P1` **前端单文件约 10k 行**：ai-panel.js 一个闭包承载全部逻辑，改一处需全文检索；dsh 按职责拆
  331 包。建议按「会话存储/事件路由/渲染/工具桥/设置」渐进拆模块。
- `P1` **前端零自动化测试**（实测无任何 *.test.* 文件）：协议/算法（分组、diff、退避 UI）全靠手测；
  建议至少把纯函数（groupTurns/turnFinalItem/parseAskQuestions/toolPrimary/computeLineDiff）抽出
  并用 vitest 覆盖。
- `P2` **持久化在 localStorage**：单 key 全量 JSON、配额受限（图片有 3.2MB 预算+分级降级兜底）、
  无版本化与损坏恢复（损坏时 `catch → []` 静默清空）；dsh 每会话一个 JSONL + 格式版本 fail-closed
  （SESSION_FORMAT_VERSION=4、refuseForeignFormatVersion）+ v0→v4 迁移链。规模到顶前考虑迁移到
  后端文件存储（Go 侧已有应用数据目录）。

## 可借鉴清单（按投入产出排序）

1. 【dsh-session · repair.js `ToolCallRecovery`】重启恢复时为 `running` 工具消息合成收尾：已执行→
   「结果未知，仅幂等操作可重试」（TOOL_OUTCOME_UNKNOWN）、未执行→「未开始，需要时重试」
   （TOOL_NOT_STARTED）；并给中断回合补 reason:interrupted 收尾（我们的 normalizeMessage 处即可）。
2. 【dsh-llm-deepseek · `providerError`（lib/index.js:1771）】错误先归一为 machine code（AUTH/
   RATE_LIMIT/SERVER/QUOTA/CONTEXT_WINDOW_EXCEEDED/EMPTY_RESPONSE/MALFORMED_RESPONSE…），UI 按
   code 决定展示（AUTH 隐原文）与行为（压缩恢复、是否重试）；文案只供人读。
3. 【dsh-compaction-basic · `toolPairingBalancedBefore`】我方切点已回退 user 边界（安全但保守）；
   dsh 的配对计数允许紧贴工具对切割，保留窗口更精准——可作为保留策略的精细化方向。
4. 【dsh-compaction-tool-result-pruner】工具结果超 8192 码点时头 4096+尾 1024、中间替换标记（按
   码点切）——在消息进上下文前统一修剪，延后压缩触发（我方现为各工具内部截断+全文驻留）。
5. 【dsh-llm-retry · recover（lib/index.js:177-181）】Retry-After 超过 maxDelay 的语义二选一：
   normal 放弃重试 / always 退回本地退避（dsh 非 clamp）。我方现状是原样等待→被 120s 看门狗误杀，
   任选其一皆可修复；重试等待可发出「计划/开始」两段（已有 ai-retry，够用）。
6. 【dsh-compaction-basic · request-error 恢复】收到 CONTEXT_WINDOW_EXCEEDED 类错误时自动
   「修剪+压缩+重试一次」，而不是让用户手动 /compact。
7. 【dsh-client-ui-tool · `terminalCardModel`（lib/client.js:1004）】终端结果尾部 `[exit code: N]`
   标记解析，非零退出把「完成」升格「失败」（红色摘要）。我方结果文本已带退出码
   （ai-panel.js:5016-5018），只差卡片侧解析。
8. 【dsh-client-ui-secret-mask】聊天渲染层凭据打码（28 种格式清单+保留前 8 字符+掩码+挂载即重置）；
   同时作用于导出 Markdown。
9. 【dsh-client-ui-chat + dsh-client-ui-conversation】会话切换保持三件套：语义滚动位置
   （`chatScrollPositions` Map，chat client.js:15344）/输入草稿快照（conversation client.js:4389,4538）/
   折叠选择（`createChatStore`，chat client.js:4455-4473）——localStorage per-session key 即可。
10. 【dsh-session-title · `normalizeSessionTitle`（lib/types/normalize.js:56）】若做 LLM 标题生成，
    先实现 normalize（剥 OSC/CSI/双向字符+字节预算截断不劈码点）再做生成，顺序不可反。
