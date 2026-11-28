# CaDt 通用插件供给接口设计（平台扩展面总览）

> 状态：**设计草案，大部分未实施**（2026-11-28 基于现有插件 API 与宿主能力整理，同日评审后补正）——唯一已落地的是 **§5.2 的统一回调 ctx**（`shell/plugin-ctx.js` + 八个入口接线，2026-11-28）；§3 列出的新增接口（`registerSkill` / `readTextAsset` / 写回契约 / 子代理可用插件工具 / `onWorkspaceEvent` / `registerPage` / `registerContextProvider` 等）**全部仍是待办**。P0 前两项（`registerSkill` / `readTextAsset`）见 `plugin-host-extension-p0.md`；**子代理侧（能力快照 / preset / 受控写）已独立成文** `subagent-capabilities-redesign.md`。
> 目标：定义 CaDt 作为通用插件平台，除写作外的各类场景可以供给哪些接口、按什么优先级补、哪些能力故意不开放。本文是平台级总览，不替代 `docs/plugins/README.md` 的具体 API 手册。
> 结论先行：**现有接口已覆盖「文件格式 / 可视化 / 命令 / AI 工具 / 数据源 / 后台服务 / 导入导出 / 外观 / 设置」**。下一步最有价值的扩展不是继续加零散 API，而是补齐 **编辑器交互、AI 技能与工作流、工作区生命周期、侧栏面板、文件操作、任务与通知** 六类通用场景。
>
> **评审补正（2026-11-28，对着代码逐条核过）**：初版把三件事估轻了、把一件事估重了——
> ① `registerEditorContextMenu` **已经是现有能力**（`addCommand` 的 `contexts: ['editorContext']`，`main.js` 已接线），缺的只是「命令如何把结果写回编辑器」，不该再开一个新注册表（§3.1）；
> ② `readTextAsset` **不是 Go 缺口**：`internal/plugins/plugins.go` 的资产白名单已含 `.md/.txt/.json/.js/.mjs/.csv/.yaml`，缺的是前端统一解码入口，零 Go 改动（§3.4）；
> ③ **受控 `readWorkspaceFile` / `writeWorkspaceFile` 从 P1 撤下**，移入「故意不开放」：插件本来就以应用同级权限跑在 WebView 里（无沙箱），这层 API 不提高安全性，只增加要维护的语义（§4）；
> ④ `registerPage` 是唯一必须动 `core/` 的一项（`APP_PAGES` 是静态纯表），成本比初版写的高（§3.6）；
> ⑤ 补两个初版漏掉的高价值项：**子代理可用插件工具**、**`registerContextProvider`**（替代放大 12 KiB 上限）（§3.2）；
> ⑥ `registerEditorAction` / `registerInlineSuggestProvider` 仍可取，但优先级降到 P2——先看 `addCommand` 写回契约够不够用；
> ⑦ **统一 ctx 已落地**（不是待办）：`shell/plugin-ctx.js` 的基座 + 八个入口接线，只加键不改签名，见 §5.2。

## 1. 设计原则

1. **能力下沉，业务上浮**：宿主只提供通用原语（读文件、起服务、发 AI 请求、显示视图、派子代理），写作/数据分析/翻译等业务留在插件。
2. **声明式注册，可逆清理**：所有注册项有 owner、上限、disposer；插件禁用/重载后不残留。
3. **默认安全**：涉及写入、执行命令、访问网络、调用 AI 的接口默认关闭或走审批；插件代码本身不是沙箱，安装信任仍是第一道防线。
4. **复用现有 UI**：命令进命令面板、视图进标签页、设置进设置树、工具进审批链；不为每个插件造一套交互。
5. **零新依赖优先**：能用现有 Go/Wails/前端模块实现的，不引入 Node/Chromium/重型运行时。
6. **稳定契约优先于功能数量**：接口形状、错误语义、生命周期、版本兼容比「多一个 API」重要。

## 2. 现有接口盘点（已具备）

| 场景 | 现有接口 | 能做什么 | 主要边界 |
| --- | --- | --- | --- |
| 文件格式 | `registerFormat` | 新扩展名的树/表格/代码/文本解析与序列化 | 内置格式优先；解析失败退文本 |
| 自定义视图 | `registerViewer` | 地图、图表、3D、播放器等自绘视图 | 只渲染；写回经 `requestSave`；≤10 MB |
| 导入转换 | `registerImporter` | 二进制/未知格式转文本或虚拟文档 | 打开链询问；结果只读 |
| 导出转换 | `registerDocConverter` | Word/PDF 等重格式导出 | 统一 HTML+图片上下文 |
| 命令 | `addCommand` | 工具菜单、编辑器右键（`contexts: ['editorContext']`）、命令面板、快捷键 | 内置快捷键优先；`when` 控制可用性；**只能自己改 DOM/走进程桥，没有「写回编辑器」契约** |
| 主题 | `addTheme` / `addCodeTheme` / `registerIconTheme` | 界面、代码、文件图标主题 | 变量白名单；继承链上限 |
| AI 工具 | `registerTool` | 给模型提供领域工具 | 三层授权；默认关闭；计划模式拒绝；**子代理默认看不到** |
| AI 上下文 | `registerAIContext` | 向系统提示注入领域知识 | 单条 4 KiB / 合计 12 KiB；按数据处理 |
| AI Provider | `registerAIProvider` | 虚拟模型账号、动态请求头/体补丁 | 三协议；密钥不可读；同步 prepare |
| 数据库 | `registerDbDriver` | 新数据库类型、对象树、网格、SQL 控制台 | v1 只读；危险 SQL 两阶段确认 |
| 后台服务 | `registerService` | 托管本地 sidecar、健康检查、日志、退出清理 | 不做沙箱；只装可信插件 |
| 设置 | `registerSettingsPanel` | 插件专属设置页 | 表单控件遵循全局规范 |
| 命令风险 | `registerCommandClassifier` | 端侧命令危险概率分类 | 无 deny 权；核心统一裁决 |
| 平台原语 | `provide/require/inject/effect` | 服务依赖、组合、生命周期 | 点分服务名；owner 撤销 |
| 回调上下文 | `pluginCtxBase` / `withCtx`（`shell/plugin-ctx.js`） | 八个回调入口共享 `{plugin:{id,name,dir}, workspace, sessionId, origin, flash?}` 基座，各自再加域方法 | 命令 / AI 工具没有 `flash`；`source` 一义多义保留，用 `origin` / `doc` 消歧（§5.2） |
| 钩子 | `on/emit/waterfall/parallel/serial/bail` | 进程内事件通信与决策接管；核心已埋 `agent/pre-step`、`agent/request`、`agent/request-error` 三个 waterfall | 不跨窗口；同步模式注意 async；**宿主事件（工作区切换等）尚未转发进总线** |
| 进程桥 | `runCommandSync/runCommand` | 执行脚本/命令、流式输出 | 插件拥有同等系统权限 |
| 资产 | `getPluginDir/readAsset` | 取安装目录、读图片**与受限文本/数据资产**（Go 白名单含 `.md .txt .json .js .mjs .csv .yaml`，返回 data URL、数据类 48 MB） | 缺统一文本入口与文本级闸门（要插件自己 base64 解码）；脚本类 `.py/.sh/.ps1` 不在白名单 |

## 3. 建议新增的通用接口（按场景）

### 3.1 编辑器交互类

**先纠正一个判断**：编辑器右键入口**已经存在**，不需要新接口——`addCommand({contexts: ['editorContext']})` 早在 `plugin-commands-model.js` 的 `COMMAND_CONTEXTS` 里，`main.js` 已把它注入编辑器右键菜单（`editor/editor-menus.js` 消费）。真正缺的是**命令做完之后怎么把结果写回去**：现在插件只能自己改 DOM 或起进程，拿不到「替换选区 / 插入文本」这条统一路径（脏标记、undo、只读判定都在宿主手里）。

| 建议 | 场景 | 说明 | 优先级 |
| --- | --- | --- | --- |
| **`addCommand` 的写回契约**（不是新接口） | 选区翻译、格式化、改写、批注 | `run(env)` 允许返回 `{replaceSelection: text}` / `{insertText: text}` / `{openVirtualDoc}`，由宿主做替换 + 脏标记 + undo 接入；`env` 已带 `hasSelection` / `readonly` / `editorFocused` | **P1（性价比最高）** |
| `registerEditorDecoration(spec)` | 错误下划线、便签、书签、语义高亮 | 插件声明 marker 范围与样式，宿主复用 Ace marker 生命周期 | P2 |
| `registerInlineSuggestProvider(spec)` | AI 行内补全、写作续写 | 宿主管理 Ace widget / 幽灵文本，插件只提供异步建议；采纳/拒绝由宿主统一 | P2（UI 复杂，写作插件多是「整章生成」而非行内补全） |
| ~~`registerEditorContextMenu(spec)`~~ | — | **已有能力，删除此条**：`addCommand` + `contexts:['editorContext']` 就是它 | 已具备 |
| ~~`registerEditorAction(spec)`~~ | — | 与上一行重叠：先看「写回契约 + `addCommand`」够不够用，不够再抽象成独立注册表 | 降级为 P2 / 待观察 |

### 3.2 AI 技能与工作流类

| 建议接口 | 场景 | 说明 |
| --- | --- | --- |
| `registerSkill(spec)` | `/webnovel-write`、`/translate` 等斜杠技能 | 插件声明技能名、描述、正文提供函数；接入现有 `listSkillsRaw` 与 slash 调用 |
| **子代理可用插件工具**（不是新注册项，是拼装口径） | 子代理查设定库、角色卡、项目索引 | `subToolsForScope` 目前只拼内置工具表；把 `authorizedPluginToolDefs` 的同一份三层授权结果也拼进子代理表即可，用户勾过的授权天然继承 |
| `registerContextProvider(spec)` | 「本章任务书」这类随会话变化的大块上下文 | 按轮惰性求值、宿主限长 + 来源标记，复用 `renderPluginContextBlocks` 渲染链；**不放大** `registerAIContext` 的 4/12 KiB 上限（那是稳定知识，语义不同） |
| `registerAgentPreset(spec)` | 写作模式、审阅模式、数据分析模式 | 声明 persona、工具集、提示片段、变量；会话创建时可选并持久化 |
| `registerSubagentRole(spec)` | 起草、审读、事实提取等专用子代理 | 声明角色提示、工具白名单、权限能力、模型偏好；复用现有子代理系统。**归属子代理侧改造**：由 `subagent-capabilities-redesign.md` 的 `registerAgentPreset` 统一承载（preset 即角色组合），本文不单列 |
| `registerWorkflow(spec)` | 多步骤流水线 | 声明步骤、依赖、输入输出、审批点；宿主负责调度/恢复/展示，插件负责每步实现 |
| ~~`registerQuestionHandler(spec)`~~ | — | **不开**：宿主已有 `ask_user`（AI 侧）+ 审批卡（用户侧）两条通道，第三条只会分裂；插件要问就让模型调 `ask_user` |

**优先级**：P0（`registerSkill`，详细设计见 `plugin-host-extension-p0.md`）、P1（子代理可用插件工具 / ContextProvider / Preset / SubagentRole）、P2（Workflow）。注意插件工具在**计划模式下不下发**（`plugin-tools.js` 的 `toolIsAvailable` 硬拒），「先规划再执行」的插件要自己处理这个断档。

### 3.3 工作区与生命周期类

| 建议接口 | 场景 | 说明 |
| --- | --- | --- |
| `onWorkspaceEvent(name, fn)` | 打开/切换/关闭工作区、文件变化 | 宿主把现有 `workspace-changed` 等事件以稳定契约暴露给插件。**这是本类里最便宜的一项**：钩子总线已有五模式，缺的只是「宿主事件转发进总线」这一跳 |
| `registerWorkspaceInitializer(spec)` | 项目脚手架、模板生成 | 新建/打开工作区时提供初始化动作，写入走审批 |
| `registerWorkspacePanel(spec)` | 项目状态、TODO、依赖、写作书房 | 侧栏或内容区面板，宿主负责容器/主题/生命周期。**与 `core/app-pages.js` 的静态表冲突，见 §3.6** |
| `registerFileDecorator(spec)` | 文件树徽标、状态、图标 | 根据路径/内容给文件树附加信息，不改变文件本体；需要宿主提供 per-file 查询 + 节流，成本中等 |

**优先级**：P1。`onWorkspaceEvent` 半天能落地、收益最大；`registerWorkspacePanel` 与 `registerPage` 是一件事的两种形态，合并处理。

### 3.4 文件与数据操作类

| 建议接口 | 场景 | 说明 |
| --- | --- | --- |
| `readTextAsset(path)` | 读取插件内技能/脚本/模板 | **纯前端实现，零 Go 改动**：Go 侧资产白名单（`internal/plugins/plugins.go` 的 `pluginDataAssetMimeTypes`）已含 `.md .txt .json .js .mjs .csv .yaml`，`ReadPluginAsset` 返回 data URL；缺的是「剥 data URL + base64 解码 + UTF-8 校验 + 1 MiB 文本级闸门」的统一入口。脚本类 `.py/.sh/.ps1` 按需补白名单两行 |
| `registerFileAction(spec)` | 文件树右键动作 | 针对路径/扩展名提供批量处理、转换、归档；P2 |
| ~~`readWorkspaceFile` / `writeWorkspaceFile` / `watchWorkspace`~~ | — | **撤下**（原 P1）：插件本来就以应用同级权限跑在 WebView 里（`plugin-creator` 技能正文原文「权限等同应用本身（无沙箱）」），给它一层「受控读写」不提高安全性，只多出一套要维护的语义（冲突检测、只读锁、审计）。插件要读写就 `runCommandSync` / `registerViewer` 的 `ctx.requestSave` / `registerDocConverter` 的 `writeTextFile`。详见 §4 |

**优先级**：P0（`readTextAsset`，详细设计见 `plugin-host-extension-p0.md`）、P2（文件树动作）。受控读写不做——那是伪安全。

### 3.5 任务、进度与通知类

| 建议接口 | 场景 | 说明 |
| --- | --- | --- |
| `registerTaskProvider(spec)` | 长耗时分析、批处理、写作流程 | 插件提供 start/status/cancel，宿主在任务面板展示进度 |
| ~~`registerNotificationChannel(spec)`~~ | — | **不做**：`flash` + 消息中心已覆盖，自造通道只会分裂 |
| `registerBackgroundJob(spec)` | 定时/批量作业 | 复用 `registerService` + 宿主调度；声明 cron/interval 与权限 |
| `registerProgressReporter(spec)` | 流水线步骤进度 | 与 workflow 配合，宿主显示阶段胶囊 |

**优先级**：P2（`registerTaskProvider` / `registerProgressReporter` / `registerBackgroundJob`）。现有 `registerService` + `runCommand` + `plugin__` 工具已能覆盖多数，进度展示先用 `flash` / `openVirtualDoc` 顶着，等两个真实插件跑过再抽象。
**不做**：`registerNotificationChannel` —— `flash` + 消息中心已经覆盖用户可见通知，插件自造通道只会分裂。

### 3.6 导航与内容区类

| 建议接口 | 场景 | 说明 |
| --- | --- | --- |
| `registerPage(spec)` | 独立内容页（书房、分析报告、播放器） | 比 `registerViewer` 更完整：可注册标签页/路由，拥有独立工具栏。**实现有真实成本**：`core/app-pages.js` 的 `APP_PAGES` 是纯静态表，`core/tab-kinds.js` 的 `appPage` 又按它 `resolve` 图标与标题，插件不能直接往 core 注册——需要给 core 加一个**可注入的 resolver**（由 `main.js` 在启动时接上 `shell/` 的插件注册表），否则会打破「core 不 import 域」的依赖方向。这是本清单里唯一必须动 `core/` 的一项 |
| `registerSidebarView(spec)` | 侧栏新视图 | 与 `registerPage` 重叠度高：先做 Page（内容区标签页已有成熟底座），侧栏等真实需求再拆 |
| `registerToolbar(spec)` | 上下文工具栏 | 同上，先不做 |

**优先级**：P1（`registerPage`，按上面的 resolver 方案单独立项）、P2（侧栏 / 工具栏）。`registerViewer` 绑定具体文件格式，`registerPage` 面向独立业务页面，两者别混。

## 4. 故意不开放 / 暂不开放的能力

| 能力 | 原因 | 替代方案 |
| --- | --- | --- |
| **受控 `readWorkspaceFile` / `writeWorkspaceFile` / `watchWorkspace`** | 插件在 WebView 里已是应用同级权限（无沙箱），这层 API 不提高安全性，只增加要维护的语义：冲突检测、只读锁、审计、路径归一都要再做一遍，且与主会话审批链形成第二套口径 | `runCommandSync` / `registerViewer` 的 `ctx.requestSave` / `registerDocConverter` 的 `writeTextFile` / `getActiveFile` + `getActiveText` |
| **`registerNotificationChannel`** | `flash` + 消息中心已覆盖 | 用 `flash(msg, isError)`；要留痕就 `openVirtualDoc` |
| **~~本方案里给子代理开文件写能力~~ → 已迁出** | 子代理能力/权限体系由 `subagent-capabilities-redesign.md` 整体重设计（能力快照 + preset + 编排 owns 阶段零），不再由插件方案局部打补丁 | 现状下：隔离试改用 `spawn_agent(isolation: 'worktree')`；写正文由主代理做。新模型落地后按那份文档为准 |
| **`registerQuestionHandler`** | 宿主已有 `ask_user`（AI 侧）与审批卡（用户侧）两条通道，第三条分裂 | 让模型调 `ask_user`；插件自己的 UI 用 `registerViewer` / `registerPage` |
| 任意改写主界面布局 | 破坏统一交互与可访问性 | `registerPage` / `registerSettingsPanel` |
| 绕过审批直接写文件 | 破坏只读锁、冲突检测、审计 | 现有写工具（AI 侧）/ `runCommandSync`（插件侧，权限等同应用） |
| 插件自建命令执行沙箱 | 权限碎片化、难以审计 | 复用宿主审批链与 OS 沙箱 |
| 读取 AI API Key / 环境变量值 | 凭据泄露风险 | `registerAIProvider` 由用户填密钥；env 仅名称可见 |
| 任意注册全局快捷键 | 与内置键位冲突 | `addCommand.shortcut`，内置优先 |
| 无限制后台进程/网络请求 | 资源滥用、卸载残留 | `registerService` 托管 + 健康检查 + 退出清理 |
| 插件直接修改其他插件状态 | 破坏隔离与可预测性 | DI 服务 + 事件总线 |
| 原样加载 Node/Cordis 插件 | 体积与运行时冲突，CaDt 明确不打包 Node | CaDt 适配入口 |

## 5. 通用插件契约（所有新接口共同遵守）

### 5.1 注册与生命周期

- 每个 spec 有稳定 `id`、`name/label`、可选 `description`。
- 注册返回 disposer；宿主在插件禁用/重载时按 owner 统一撤销。
- 上限在注册时校验，超限明确报错，不静默丢弃。
- 异步内容惰性加载，不在 `apply` 的 5 秒窗口内做重活。

### 5.2 上下文 `ctx`

**已落地（2026-11-28）**：基座在 `frontend/src/shell/plugin-ctx.js`（`pluginCtxBase()` / `withCtx()`），
命令 / 视图 / 导入器 / 导出转换器 / AI 工具 / AI 上下文 / 设置面板 / 命令分类器 八个入口全部接上。
新接口一律以它打底，**不要再另造一套**：

```js
{
  plugin: {id, name},        // 身份（安装目录仍用 cadt.getPluginDir()：记录里只有 id/name）
  workspace,                 // 会话根 / 当前根；没有工作区时是空串，不是 undefined
  sessionId,                 // 非 AI 入口为空串
  origin,                    // command | editor | open | export | tool | prompt | settings | classifier
  flash,                     // 可选：只在视图 / 导入器 / 导出 / 设置面板上注入
}
```

- 各入口在自己那份上追加域方法（`requestSave` / `readTextFile` / `chooseSavePath` / `signal`…），
  基座只负责「我是谁、在哪个工作区、谁在调我」。
- `flash` **不给就是没有**：留一个静默空实现会让插件以为提示成功了。
- 上下文是只读快照 + 能力方法，不暴露内部可变对象；异步能力自带超时。

**纪律：只加键，不改键。** 插件是市场分发的第三方代码，改名 / 换类型都是破坏性变更。
`source` 一名三义（导入器 `'open'`、导出 `'memo'`、视图 `{path, name, size}`）**原样保留**，
新增 `origin`（场景）与 `doc`（视图里的文件对象）消歧；旧键永不移除。

**刻意不归一化**（已写进 plugin-ctx.js 头注释）：

| 回调 | 为什么不给基座 |
| --- | --- |
| `registerFormat.parse / stringify` | 纯函数，结构面板 / 表格 / worker 都会调，可能不在主线程；给宿主能力等于开一条绕过脏标记的通道 |
| `registerDbDriver.connect(config)` | 数据源配置，与界面无关，只有连接参数 |
| `registerAIProvider.prepare(ctx)` | 请求补丁上下文（只有 `accountId` 等请求侧字段），不是「插件在界面里干活」 |

**为什么不重写现有签名**：`convert(ctx)` → `convert(ctx, opts)`、`env` 改名 `ctx` 这类改动，唯一好处是
「看起来整齐」，代价是所有已发布插件失效 + 必须升大版本。宿主侧的真实收益（一份 ctx 构造代码、
新接口不再各造一套）靠基座就能拿到，不需要动任何现有签名。

### 5.3 错误与降级

- 单个插件/单个注册项失败不阻断其他插件。
- 用户可见错误走 flash/消息中心；诊断走调试日志。
- 可选能力缺失时返回明确错误或降级，不静默吞错。

### 5.4 安全分级

| 级别 | 示例 | 默认策略 |
| --- | --- | --- |
| L0 纯计算/渲染 | 主题、视图、格式解析 | 注册即用 |
| L1 只读本地 | 读当前文件与文本资产、查状态 | 路径/大小限制 |
| L2 写入/执行 | 写文件、跑命令、后台服务 | 审批或显式授权 |
| L3 网络/AI/凭据 | 外部 API、模型调用 | 用户配置 + 授权 + 超时 |

## 6. 优先级路线图

### P0：插件能力供给的硬门槛（约 2–3.5 人日，详见专文）

- `registerSkill`（插件注册斜杠技能）
- `readTextAsset`（文本资产读取——**零 Go 改动**，纯前端解码）

详见 `docs/unfinished-plans/plugin-host-extension-p0.md`。

**子代理侧已独立成文**（2026-11-28）：子代理能力快照 / `registerAgentPreset` / 受控写 / 编排 owns 阶段零，全部归 `subagent-capabilities-redesign.md`——那份文档整体推翻「子代理默认只读 + scope 同时代表权限与审批」的旧设计，能力由 preset × 派单参数 × 父级上限合成不可变快照，默认仍只读但角色可声明写。插件方案不再重复承载。

### P1：通用平台高价值扩展（约 2–4 周，按项拆分）

1. `addCommand` 的**写回契约**（`{replaceSelection}` / `{insertText}`）——编辑器交互类里性价比最高的一项
2. `onWorkspaceEvent`（半天可落地：宿主事件转发进钩子总线）
3. **子代理可用插件工具**（拼装口径，不是新注册面）
4. `registerPage` / `registerWorkspacePanel`（需先给 `core/app-pages.js` 加可注入 resolver）
5. `registerContextProvider`（**不放大** `registerAIContext` 的 12 KiB）
6. `registerAgentPreset` / `registerSubagentRole`

### P2：高级工作流（按需求立项）

- `registerWorkflow` + 进度/任务面板
- `registerEditorDecoration` / 行内建议 Provider
- 文件树装饰 / 动作
- `registerBackgroundJob`（复用 `registerService`）

## 7. 典型插件场景映射

| 插件类型 | 需要的接口组合 |
| --- | --- |
| 网文写作工作台 | `registerSkill` + `registerContextProvider` + 子代理可用插件工具 + `registerPage` + `registerTool`（**写入由主会话做**，子代理只审查） |
| 翻译插件 | `addCommand`（编辑器右键 + 写回契约）+ `registerAIProvider` + `registerSettingsPanel` |
| 数据可视化 | `registerFormat` + `registerViewer` + `addCommand` |
| 数据库客户端 | `registerDbDriver` + `registerSettingsPanel` + `registerService` |
| 文档转换套件 | `registerImporter` + `registerDocConverter` + `registerFormat` |
| 项目分析/仪表盘 | `registerPage` + `onWorkspaceEvent` + `registerTool` |
| 自动化批处理 | `addCommand` + `registerBackgroundJob`（+ `runCommandSync` 自身进度） |
| 本地 AI 网关 | `registerAIProvider` + `registerService` + `registerSettingsPanel` |
| 主题/图标包 | `addTheme` + `addCodeTheme` + `registerIconTheme` |
| 文件树增强 | `registerFileDecorator` + `registerFileAction` |

## 8. 实施建议

- 先做 P0 三项（详见专文），用 v8 类写作插件作为**首个**真实试金石；接口按通用扩展设计，不为单个插件开口子（v8 只是最挑剔的用例，不是接口的服务对象）。
- P1 每项独立提交、独立示例插件、独立验收，避免一次扩太大。
- 新接口先写契约文档与测试，再实现；实现后补到 `docs/plugins/README.md`。
- 维护 `minAppVersion` 与兼容矩阵；破坏性变更升大版本。
- 观察市场插件实际需求，P2 不为抽象而抽象。

## 9. 参考

- 现有插件 API：`docs/plugins/README.md`
- P0 宿主扩展详细设计：`docs/unfinished-plans/plugin-host-extension-p0.md`
- Agent 宿主平台：`docs/finished-plans/agent-host-platform.md`
- 插件工具安全：`docs/finished-plans/plugin-tool-security.md`
- 代码现状：`frontend/src/shell/plugins.js`、`frontend/src/ai/chat/ai-slash.js`、`frontend/src/ai/agent/ai-subagents.js`
