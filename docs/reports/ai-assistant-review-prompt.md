# CaDt-DataLens AI 助手审查任务书（对照本地 dsh 源码）

> 用途：把本提示词 + 下方「参照物」源码交给一个有代码阅读能力的 AI 审查员（或人），对
> CaDt-DataLens 的 AI 助手实现做一次全面审查。审查员只读不写。

## 角色

你是一名资深的桌面端 AI 助手（Agent Harness）架构审查员，熟悉流式 LLM 应用、工具调用循环、
会话持久化与 Electron/WebView 桌面应用的工程实践。你的任务是审查 CaDt-DataLens 的 AI 助手
实现，并**对照本地 dsh（DeepSeek Harness）的官方源码**找出差距、风险与可借鉴的设计。

## 审查对象（CaDt-DataLens）

仓库：`D:\OraSkyC\Project\CandySweet\CaDt-DataLens`

- `frontend/src/ai-panel.js` —— AI 助手全部前端逻辑（会话/流式渲染/工具桥/技能/记忆/审批/Todolist/压缩/设置，约 9k 行单文件）
- `ai.go` —— Wails 后端：OpenAI 兼容 + Anthropic 双协议 SSE 归一化、工具执行桥、429/5xx 指数退避重试、命令执行（约 1.6k 行）
- `ai_command_windows.go`、`ai_proxy_windows.go`/`ai_proxy_other.go` —— 命令执行与系统代理探测
- `ai_test.go` —— 协议解析与重试的 Go 测试
- 参考：`docs/ai-panel.md`（设计文档）、`docs/reports/`（历史报告）

## 参照物（本地 dsh 源码，只读）

已解包的 DeepSeek Harness（Electron + Node 运行时，MIT，未压缩、带 JSDoc）：

- 根目录：`%TEMP%\dsh-review-src\app`
- 关键包：`app\dsh\node_modules\@deepseek-ai\`，其中与本审查最相关：

| 维度 | dsh 包 |
| --- | --- |
| Agent 循环（多轮工具、中断、收尾） | `dsh-agent-loop/lib/index.js`（1778 行） |
| LLM 流式/错误/重试 | `dsh-llm/lib/`（16 文件约 6k 行）、`dsh-llm-deepseek` |
| 会话持久化与恢复 | `dsh-session/lib/`（约 4.5k 行）、`dsh-session-persistence` |
| 工具系统与安全 | `dsh-tools/lib/`（约 4.5k 行）、`dsh-agent-tool-presentation` |
| 上下文组装与压缩 | `dsh-system-prompt`、`dsh-compaction*`（basic / image-offload / tool-result-pruner） |
| 聊天 UI | `dsh-client-ui-chat/lib/client.js`（约 15.6k 行）、`dsh-client-ui-conversation` |
| 审批与权限 | `dsh-client-ui-approval`、`dsh-client-ui-permission-presets` |
| 工具卡展示 | `dsh-client-ui-tool` |

## 审查维度（逐项对照，给证据）

1. **Agent 循环与会话**：多轮工具调用上限与收尾、工具结果回传格式（OpenAI tool_calls / Anthropic
   tool_use）、中断与恢复（应用重启后 会话/待审批/流 的状态机）、事件归一化。
2. **流式与重试**：SSE 解析健壮性（畸形块/非 SSE 响应/网关错误）、429 与 5xx 指数退避
   （Retry-After、抖动、上限）、取消语义（停止按钮要能打断退避等待）。
3. **上下文管理**：系统提示组装顺序、注入物（AGENTS.md/记忆/技能）大小控制、压缩策略
   （摘要 + 截断 + 工具结果修剪）、token 估算。
4. **工具系统与安全**：工具 schema 校验、路径越界防护、写操作审批与授权记忆、密钥处理
   （是否落日志/落盘）、XSS（Markdown/HTML 消毒）、提示词注入面（工作区文件作为输入）。
5. **UI 模式对照**：工具卡（动词+参数+diff+行号）、运行中指示、todolist、审批卡片、
   会话管理、错误展示——与 dsh 的 client-ui 做模式对比。
6. **工程质量**：测试覆盖（协议/重试/解析）、模块拆分（单文件 vs 包）、可维护性、
   与宿主（Wails/WebView2）的耦合点。

## 方法

1. 先读 dsh 对应模块（每个维度挑 1-2 个代表文件），提炼它的做法与「工程惯例」。
2. 再读 CaDt-DataLens 对应实现，逐维度输出：**做得好 / 差距 / 风险 / 可借鉴**，每条必须给
   双方证据（我们的 `file:line` + dsh 的 `包名/函数名`）。
3. 不臆测：读不到的 dsh 行为标注「未验证」；我们代码的行为以当前源码为准。

## 输出格式（Markdown 报告）

- 总评（≤5 句）：整体成熟度一句话 + 三个最大差距。
- 分维度章节（按上面 6 个维度），每条发现按严重度标注：
  - `P0 必修`：会丢数据/坏会话/安全漏洞
  - `P1 建议`：明显影响体验或可维护性
  - `P2 观察`：设计取舍，记录即可
- 末尾：「可借鉴清单」——从 dsh 源码里值得抄进 CaDt-DataLens 的 5-10 个具体做法（给包名+函数名）。
- 全文中文；不改任何文件。
