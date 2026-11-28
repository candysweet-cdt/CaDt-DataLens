---
name: plugin-creator
description: 为 CaDt-DataLens 开发插件（plugin.json + cadt.* API：格式/视图/命令/主题、AI 工具与 provider、依赖注入与钩子、后台服务）；用户要给应用加格式或功能时使用
---

# 插件开发（plugin-creator）

CaDt-DataLens 插件 = 一个文件夹：`plugin.json` 清单 + 入口 JS（默认 main.js，≤2MB），运行在界面 WebView 里，权限等同应用本身（无沙箱）。

- 清单必填：`id`（小写连字符，唯一，即安装目录名）、`name`、`author`、`description`；常用可选：`entry`、`extensions`、`version`、`license`、`homepage`、`repository`、`keywords`、`minAppVersion`、`icon`（≤128KB）。
- `dependencies: ["其他插件 id"]`：宿主按拓扑排序先 apply 被依赖者，所以「后启动的插件去取前者提供的服务」不会扑空；缺依赖 / 循环依赖 → 该插件与下游一并跳过并记错误，其余插件照常加载。
- 入口三种写法等价、可混用：脚本式直接 `cadt.xxx()`；`return {apply(ctx)}`；`module.exports = {apply(ctx)}`。不是 ES 模块（`import` / `export` 直接语法错误）；`apply` 可 async，但宿主只等 5 秒。
- 扩展面（`cadt.*`，括号里是入参形状）：
  - 格式：`registerFormat({id, name, extensions, parse(text), stringify(value), aceMode?, rawOnly?, table?, parseTable?, stringifyTable?})`——复用树/表格/代码/文本视图，内置格式优先。
  - 视图：`registerViewer({id, label?, formats, priority?, mount(container, ctx)})`——只渲染不改数据，必须返回 destroy；>10MB 与二进制档不挂插件视图。ctx 含 `{viewerId, mode, pluginId, pluginName, source: {path, name, size}, readOnly, getData(), getSelection(), setSelection(sel), getTheme, onChange(cb), requestSave(text), flash(msg, isError)}`，写回**只能**走 `requestSave`（别碰 doc 内容与脏标记）。
  - 导入器：`registerImporter({id, label?, extensions, convert(ctx)})`——文件内置解析不了（二进制档）且扩展名命中时问一句，convert 返回 string 或 `{text, name}`，结果以只读虚拟文档打开，失败退回二进制视图；ctx 含 `{source, ext, path, name, size, readTextFile(path), readBinaryFile(path), flash}`（二进制上限 1MB，更大走 `runCommandSync`）。
  - 文档导出：`registerDocConverter({id, label?, extensions, convert(ctx)})`——ctx 含 `{source, title, suggestedName, html（已 sanitize，图片引用为相对 img/<name>）, images: [{name, mime, base64}], chooseSavePath(defaultName), writeTextFile(path, content), writeBinaryFile(path, base64, mime), flash}`；Word/PDF 等生成依赖随插件分发。
  - 数据库：`registerDbDriver({id, label, fields, connect(config)})`——侧栏「数据库」按 fields 动态出表单，kind 为 `plugin:<插件id>:<驱动id>`，对象树/网格/控制台复用内置。
  - 命令：`addCommand({id, label, run(env), icon?, description?, category?, contexts?, when?, shortcut?})`——默认进 工具(U) 菜单与命令面板；`contexts` 取 `tools` / `editorContext`，`category` 取 file/edit/format/view/tools/plugin，`shortcut.when` 只认 `editorFocus`；`env` 含 hasFile/formatId/hasSelection/readonly/workspace/editorFocused，`when` 抛错按不满足处理。
  - 主题：`addTheme({id, name, extends?, bg?, accent?, vars?, css?})`（界面配色）/ `addCodeTheme({id, name, extends?, group?, vars?})`（代码高亮）/ `registerIconTheme({id, name, extends?, icons})`（文件图标，键如 `json`、`default_file`）。
  - 设置面板：`registerSettingsPanel({id, label, render(container, ctx)})`——进 设置→插件 的该插件详情页；ctx 提供 `flash` 与本插件的服务操作（start/stop/status/logs），面板不必自己碰 backend。
  - AI 工具：`registerTool({name, description, parameters, readOnly?, timeoutMs?, execute(args, ctx)})`——name 匹配 `^[a-z0-9_]{1,40}$`，description ≤2000 字符（模型只看这段），parameters 是 JSON Schema ≤16KiB，execute 返回 string 或 `{text, images}`，timeoutMs 默认 60s 上限 300s，ctx 含 `{sessionId, scope, signal}`；**三层授权**（全局 / 插件 / 工具）全开才下发，`readOnly` 还需用户单独勾「只读档可用」，对外名 `plugin__<插件id>__<工具名>`，子代理默认看不到，单插件 ≤20 个。
  - AI 上下文：`registerAIContext({id, label?, stable?, text(ctx)})`——注入系统提示词的领域知识，单条 ≤4KiB、合计 ≤12KiB，内容按数据处理。
  - AI provider：`registerAIProvider({id, name, account, models, prepare(ctx)})`——账号以虚拟 profile 进模型选择器，prepare 每轮组装请求时注入动态请求头/请求体补丁。
  - 命令分类器：`registerCommandClassifier({id, label, classify(command, ctx)})`——只输出危险概率 `{score, reason}`，**无 deny 权**；ctx 含 `{cwd, toolName, strictness, threshold, sessionId}`。
  - 进程与服务：`registerService({id, exe, args, cwd?, healthURL?, autoStart?, pollIntervalMs?, logCapBytes?})`——exe 走 PATH 或完整路径、args ≤128、cwd 留空即插件目录、`healthURL` 非空才定期探活（连续 5 次失败转 failed），进程启停 / 探活 / 日志环形缓冲 / 退出清进程树全由 Go 托管（插件不持句柄）；操作 API 返回 Promise：`startService(id)` / `stopService(id)` / `getServiceStatus(id)` / `getServiceLogs(id)`。
  - 命令执行：`runCommandSync({exe, args, cwd, timeoutMs})` 返回 Promise **必须 await**（默认 20s、上限 120s、输出 8MB），`runCommand({exe, args, cwd, onOut, onErr, onExit})` 返回 `{stop()}`。
  - 依赖注入：`provide(name, value, {replace?, group?, dispose?})` 返回撤销函数（同名且无 `replace: true` 时抛错）；`require(name)` 缺失抛错，`getService` / `hasService` 缺失走软降级；`inject(names, {timeoutMs?, group?})` 等全部就绪（默认 5s）；`effect(fn)` 立即执行并登记清理函数。key 用点分，自己提供的叫 `plugin.<插件id>.<名字>`，`group` 做 realm 隔离（同组优先、再回落全局）。
  - 钩子：`on(name, fn, {priority?, once?})` 返回解绑函数，禁用 / 重载时宿主按 owner 整体撤销（priority 大者先跑）；分发用 `emit` / `waterfall` / `parallel` / `serial` / `bail`。核心已埋三个 waterfall 插桩点：`agent/pre-step`、`agent/request`、`agent/request-error`（返回 undefined = 不接管）。钩子是进程内的，不跨窗口、不进事件契约表；`emit` / `waterfall` / `bail` 是同步模式，监听器写成 async 其返回值会被忽略（要异步用 `serial` / `parallel`）。
  - 读取与杂项：`getPluginDir()`（插件安装目录绝对路径）、`getActiveFile()`（→`{path, name, size, formatId}` 或 null）、`getActiveText()`（二进制为 null）、`openPath(path)`、`openVirtualDoc(name, content)`（扩展名定高亮）、`readAsset(path)`（插件目录内图片 → data URL）、`readTextAsset(path)`（插件目录内文本 → Promise<string>，UTF-8、≤1 MiB，白名单 `.md/.txt/.json/.js/.mjs/.csv/.yaml/.yml`，越界/非 UTF-8/超限抛错）、`flash(msg)`。
  - 斜杠技能：`registerSkill({name, description, content(), when?})` 注册 `/技能名` 可调用的技能，返回撤销函数；`name` 小写字母/数字/连字符，`description` 必填，`content()` 惰性返回 string 或 Promise<string>（不在 apply 阶段预加载，≤64K 字符，单点超时 1 s），`when(ctx)` 可选同步布尔。单插件 ≤64 个。重名时工作区技能优先（插件 rank 300），插件不覆盖作者自带技能；禁用插件立即失效补全与 skill_use。ctx 走统一基座（origin=`prompt`，含自己的 `ctx.plugin`）。
  - 平台扩展（都返回撤销函数、按 owner 撤销、有上限）：`registerContextProvider({id, label?, text(ctx)})` 按轮求值的上下文（进提示词，单条 ≤8 KiB）；`onWorkspaceEvent('changed'|'opened', fn)` 订阅工作区事件；`registerPage({id, label?, icon?, group?, mount(root, workspace), perWorkspace?})` 应用页面标签页；`registerFileAction({id, label?, extensions?, run(ctx)})` 文件树右键动作（已接宿主）。**P2 待接 UI（注册不报错但暂无可见效果）**：`registerFileDecorator` / `registerEditorDecoration` / `registerInlineSuggestProvider` / `registerTaskProvider` / `registerProgressReporter` / `registerBackgroundJob` / `registerWorkspaceInitializer`。完整字段见 `docs/plugins/README.md`「平台扩展接口」。
  - `addCommand` 写回：`run(env)` 可返回 `{replaceSelection: text}` / `{insertText: text}` / `{openVirtualDoc: {name, content}}`，宿主走编辑器既有通道替换（脏标记/undo/只读判定在宿主手里）；不返回写回意图则当命令已自行处理。
  - 回调 ctx 基座：命令 env / 视图 / 导入器 / 导出转换器 / AI 工具 / AI 上下文 / 设置面板 / 命令分类器的 ctx 都**还带**同一份基座 `{plugin: {id, name}, workspace, sessionId, origin, flash?}`——`workspace` 是会话根/当前根（没有工作区时空串），`origin` 取 `command`/`editor`/`open`/`export`/`tool`/`prompt`/`settings`/`classifier`，`flash` 只在视图/导入器/导出/设置面板上存在；插件安装目录仍用 `getPluginDir()`。**上面逐条列的只是域字段，基座见本条**。`registerFormat` 的 parse/stringify、`registerDbDriver` 的 connect、`registerAIProvider` 的 prepare **没有** ctx（纯函数 / 数据源配置 / 请求补丁）；`ctx.source` 在导入器与导出上是字符串场景名、在视图上是文件对象，新代码用 `origin` 与 `doc`，旧键不改。
- 安装：设置→插件 添加文件夹或导入 .zip；插件目录默认 exe 旁 `plugins\`，可在设置切到应用数据目录。发布到市场 = 在 Gitee 组织 `cadt-datalens-plugins`（GitHub 镜像）下建与 id 同名的公开仓库、内容放仓库根、清单 `homepage` / `repository` 指向它，市场列表自动出现。
- 迭代已有插件：保持 id 不变，改完把 version 语义化 +1；在插件页禁用再启用即可重载（会重建 DI 容器与钩子总线，上一轮的监听与服务整体撤销）。
- 交付时提醒用户：插件与界面同权限（可读写文件、执行命令、注入模型请求），只装可信来源；注册的 AI 工具需要手动授权才生效。
