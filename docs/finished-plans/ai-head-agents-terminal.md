# AI 面板头部会话化 + 智能体团队 / 后台终端入口（Tasks HUD）实施计划

> 状态：已完成（2026-11-13 实施；实机手工验收待抽查）
> 决策依据：用户 2026-11-12 给出交互设计（参照主流 harness），要求标题会话化、右侧入口、终端内容区标签页、子代理详情视图
> 范围：AI 面板头部、子代理运行视图、后台命令标签页；不改变会话存储与工具协议

## 1. 目标与非目标

### 目标

1. **标题会话化**：面板头部 `.ai-title` 由固定「AI 助手」改为当前会话标题（宽度受限，溢出 `…`）。标题功能本身已有（首轮即时标题 + 模型总结标题，`config.autoTitle`），只做展示与跟随更新。
2. **右侧入口 chips**：标题右边常驻两个入口——【icon + 智能体团队】【icon + 终端】；宽度不够时只显示 icon（ResizeObserver 切 compact 类）。运行中数量用角标显示。
3. **终端弹层**：点开列出本应用运行期启动过的 `background_command` 作业——每行【运行状态 icon】+ 单行标题（无标题用指令，溢出 `…`）+ `>` svg 按钮。点击行在**内容区以标签页打开**：上下两栏（上=指令信息，下=终端输出），中间分割线可拖拽调高。
4. **智能体团队弹层**：列出子代理（运行中来自内存 `subAgents`，已结束来自本运行期注册表 + 当前会话持久化 meta），带【运行中 / 已完成 / 失败 / 已停止】状态。点击后**替代当前面板内容**打开子代理详情视图，左上角出现 `<- 返回`，点击回到主代理消息流。

### 非目标

- 不改工具协议（spawn_agent / background_command 行为不变）、不改会话存储格式。
- 不做子代理转录的磁盘持久化（与现状一致：转录在内存；结束后保留 summary 于会话 JSONL）。
- 不在面板关闭时做全局角标（工具条 AI 按钮角标留待后续增强）。
- 不接管底部交互终端面板（Alt+F12 的交互终端与本功能无关）。

## 2. 现状要点（代码事实）

- 头部：`index.html` `#ai-head > .ai-head-title-row > .ai-title`（固定文本）+ `.ai-head-actions`；已有 `.ai-chip-btn`（变更 N）与 `.ai-popover`（#ai-changes-pop）样式与模式可复用。
- 会话标题：`finishTitleJob()` / 首轮即时标题都会 `renderSessionList()` —— 头部更新挂在这里即可全覆盖（rename/switch/new/自动标题）。
- 子代理：`subAgents` Map（subId → {id, toolCallId, parentSessionId, name, task, state, startedAt, session(内存消息列表), flow}）；`finalizeSubAgent` 结束后从 Map 删除，`message.agent`（name/task/state/rounds/ms/tokens/summary/note）持久化在父会话工具消息；`subAgentTranscripts`（toolCallId → [{role,name?,text}]）仅 done 保留。
- 后台命令：启动时 `message.bg = {jobId, state:'running', code:null}`、`bgJobCursors.set(jobId,0)`、`commandOutput(jobId,{onOut,onErr,onExit})` → `bgJobLive`（jobId → {session,message,lines,text,timer}）；`backend.AICommandStop(jobId)` / `AICommandCheck` 可用；`syncBgCardState` 同步卡片。
- 内容区自定义标签页先例：`openBrowserTab` 创建 `doc.browser` 文档，`createDocEditor` 特判走 `createBrowserView(doc)`；标签图标在 `buildGroup` 用 `createFileIcon(doc.name,...)`。
- 图标：`icons.js` 已有 check / close / chevron-right / back / terminal / agents / refresh(转动) / warn / play / pause / clock。

## 3. 设计

### 3.1 头部（index.html + ai-panel.js + style.css）

```html
<span class="ai-title" id="ai-session-title">AI 助手</span>
<div class="ai-head-chips" id="ai-head-chips">
  <button type="button" id="ai-chip-agents" class="ai-chip" title="智能体团队">
    <span class="ai-chip-icon"></span><span class="ai-chip-label">智能体团队</span><span class="ai-chip-count hidden"></span>
  </button>
  <button type="button" id="ai-chip-terms" class="ai-chip" title="后台终端">
    <span class="ai-chip-icon"></span><span class="ai-chip-label">终端</span><span class="ai-chip-count hidden"></span>
  </button>
</div>
```

- 标题：`min-width:0` + flex 收缩 + `text-overflow: ellipsis`；无标题回退「AI 助手」。
- `updateHeadIdentity()` 挂进 `renderSessionList()`；panel 初始化时调用一次。
- chips 计数：运行中子代理数 / 运行中后台作业数（>0 显示角标，chip icon 加转动态）。
- 宽度自适应：`ResizeObserver` 观察 `.ai-head-title-row`，宽度 < 420px 时加 `.ai-head-compact` 隐藏 `.ai-chip-label`。
- 弹层：`#ai-chips-pop`（复用 `.ai-popover` 样式），定位在 chip 下方、右侧对齐面板；点击面板其他区域关闭。

### 3.2 终端弹层行与内容区标签页

- 数据源：新增 `bgJobIndex`（jobId → {session, message, command, cwd, startedAt}），`background_command` 启动成功时登记；运行期有效，重启后不列（作业句柄已丢，卡片状态属于既有持久化行为）。
- 行：状态 icon（running=refresh 转 / exited=check / stopped=pause / error=warn）+ 单行标题（`command` 首行，截 60 字）+ `chevron-right`。
- 行点击 → `opts.openTermTab({jobId, command, cwd})`（main.js 提供）。
- **内容区标签页（main.js）**：`doc.bgTerm = jobId` 自定义文档（对齐 browser doc 模式）；`createDocEditor` 特判 `createBgTermView(doc)`：
  - 上栏：命令（可复制）、工作目录、状态、jobId、启动时间、停止按钮（`aiPanel.bridgeStopBgJob`）。
  - 分割线：拖拽改上下比例，比例存 `localStorage('datalens-bgterm-split')`。
  - 下栏：输出 `<pre>`；数据来自 `aiPanel.bridgeBgJob(jobId)` 快照 + `bridgeOnBgUpdate(cb)` 推送；贴底自动滚动。
  - 标签图标特判为 terminal SVG；同名 jobId 重复打开激活既有标签；关闭标签不影响作业。
- 视图守卫：`availableViews`/`switchMode` 等对 `doc.bgTerm` 与 browser 同等处理（无可切换视图）。

### 3.3 智能体团队弹层与详情视图

- 团队列表（按 toolCallId 去重）：运行中（`subAgents`，任意会话，标注所属会话）→ 本运行期注册表 `agentRegistry`（启动时登记、`finalizeSubAgent` 更新终态）→ 当前会话持久化 meta（重启后兜底，扫描 `name==='spawn_agent'` 的工具消息）。
- 状态映射：running=运行中（accent）、done=已完成（绿）、error=失败（红）、stopped=已停止（灰）。
- 行点击 → `openAgentView({subId?, toolCallId})`：`#ai-agent-view` 绝对定位覆盖消息区，头部 [back icon] [名称 + 状态徽标 + 轮次/耗时/tokens]；正文按可用数据渲染：
  1. 运行中：实时渲染 `sub.session.messages`（用户任务 → assistant 正文（markdown）→ tool 卡片行），`subThrottleRender` 里联动刷新；
  2. 已结束（本运行期）：`agentRegistry.summary` + `subAgentTranscripts` 转录；
  3. 重启后：仅 meta 摘要。
- `finalizeSubAgent` 末尾调用 `refreshAgentViewIfOpen(toolCallId)`，结束后视图自动落到终态。
- 返回按钮恢复消息流（`renderMessages()`）；期间主会话照常流式（返回即见）。

### 3.4 ai-panel 对外桥接（返回对象新增）

- `bridgeBgJob(jobId)` → `{jobId, command, cwd, startedAt, state, code, log}`（找不到返回 null）
- `bridgeOnBgUpdate(cb)` → 订阅输出/退出推送（节流合并）
- `bridgeStopBgJob(jobId)` → `AICommandStop` + 卡片同步，返回 `{state, code}`
- 新 host 选项 `openTermTab`（main.js 传 `openBgTermTab`）

## 4. 代码落点

- `frontend/index.html`：头部 chips、`#ai-chips-pop`、`#ai-agent-view`
- `frontend/src/ai-panel.js`：头部身份/chips/弹层/详情视图/`bgJobIndex`/桥接
- `frontend/src/main.js`：`openBgTermTab`、`createBgTermView`、buildGroup 图标特判、视图守卫、host 配置
- `frontend/src/style.css`：`.ai-chip*`、`.ai-chips-pop` 行、`.ai-agent-view*`、`.bgterm-*`

## 5. 任务清单

- [x] H2 index.html 容器
- [x] H3 ai-panel.js 头部 + 弹层 + 详情视图 + 桥接
- [x] H4 main.js 终端标签页
- [x] H5 style.css
- [x] H6 回归（esbuild / npm test 111 通过 / vite build / wails build）
- [x] H7 CHANGELOG / README / 方案状态

## 5.1 实施记录与偏差（2026-11-13）

- chip 角标语义：有运行中任务显示**运行中数量**（chip 加 `ai-chip-live` 转动态），否则显示条目总数。
- 弹层定位改为「chip 下方左对齐、超出面板右缘时收回到面板内」——chip 在头部左侧，按右对齐算会把弹层推出面板。
- HUD 状态注册表（`agentRegistry` / `bgJobIndex` 等）声明提到闭包顶部，并加 `hudReady` 闸门：`renderSessionList` 的早期调用（构造期可能先于子代理段声明执行）跳过 HUD 更新，避免 TDZ。
- 终端列表数据源 `bgJobIndex` 只含本运行期启动的作业（句柄不跨重启）；重启后弹层为空但给引导文案，会话卡片的历史输出不受影响。
- 子代理详情视图是面板内绝对定位覆盖层（含 composer 一起被覆盖），返回按钮恢复；主会话流式渲染照常，返回即见。
- 结束态视图优先显示「最终结论」（meta.summary），其下跟过程转录（`subAgentTranscripts`，仅本运行期 done 的子代理保留）；error/stopped 的转录按既有行为丢弃，只显示状态与摘要。

## 6. 风险与回滚

- 主消息流零改动：详情视图是覆盖层，返回即恢复；chips 只读聚合不写状态。
- 后台作业索引仅在运行期有效：重启后弹层只列会话内持久化 meta 的子代理、终端列表为空（卡片仍可看历史输出）——与「作业句柄不跨重启」的既有事实一致。
- 回滚：按 H4 → H3 → H2 反序摘除即可，无数据迁移。
