# CaDt-DataLens 插件开发指南

插件是一个**文件夹**：内含一份 `plugin.json` 清单和一个 JavaScript 入口文件。插件运行在界面（WebView）里，可以通过 `cadt.*` API 注册新的文件格式、工具菜单命令、主题和 AI provider。设置 → 插件 里可以添加、导入、启用/禁用和删除插件。

> **信任模型（重要）**：插件代码与主界面在同一个页面上下文执行，拥有与应用**相同的权限**——包括读写本机文件、执行命令、访问 AI 会话配置，以及注册 AI provider 后在每轮模型请求里注入请求头与请求体字段。应用对插件不做沙箱隔离，安装/导入插件前请确认来源可信；从仓库地址或插件市场安装时会弹确认框明示该风险。

## 快速开始

```text
my-plugin/
├── plugin.json     ← 清单（必需）
└── main.js         ← 入口（默认名，可在清单里改）
```

`plugin.json`：

```json
{
    "id": "bak-json",
    "name": "JSON 备份查看",
    "version": "1.0.0",
    "author": "你的名字",
    "description": "把 .bak 文件按 JSON 解析",
    "entry": "main.js",
    "extensions": ["bak"],
    "license": "MIT",
    "homepage": "https://gitee.com/xxx/bak-json",
    "repository": "https://gitee.com/xxx/bak-json",
    "keywords": ["json", "备份"],
    "minAppVersion": "1.0.0",
    "icon": "icon.svg"
}
```

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `id` | ✓ | 小写字母/数字/连字符，≤64 字符；同时是安装目录名，全局唯一 |
| `name` | ✓ | 显示名称 |
| `author` | ✓ | 作者，显示在插件列表 |
| `version` | | 建议语义化版本 |
| `description` | | 描述，显示在插件列表 |
| `entry` | | 入口 JS 文件（相对插件目录），默认 `main.js`，≤2 MB |
| `extensions` | | 该插件涉及的扩展名，仅作列表展示 |
| `license` | | 许可证（SPDX 标识，如 `MIT`），显示在插件列表 |
| `homepage` | | 主页链接（http/https），插件列表可点击 |
| `repository` | | 源码仓库链接（http/https），插件列表可点击 |
| `keywords` | | 关键词标签（最多显示 6 个） |
| `minAppVersion` | | 需要的最低应用版本（如 `1.0.2`）；当前应用版本过低时列表会黄字提醒 |
| `icon` | | 图标文件（相对路径，png/jpg/svg，≤128 KB），显示在插件列表 |

安装方式（设置 → 插件）：**添加插件** 选文件夹；**导入插件(.zip)** 选压缩包（zip 里 `plugin.json` 在根目录或唯一顶层子目录都可以）。插件目录默认在 exe 旁的 `plugins\`，可在设置里切换到 `%APPDATA%\CandySweet\CaDt-DataLens\plugins`。

## 插件 API

入口文件是一个普通 JS 脚本体，加载时会以 `cadt` 为参数执行（相当于 `new Function('cadt', code)`）。可用的 API：

### `cadt.registerFormat(driver)`

注册新的文件格式，复用内置的树 / 表格 / 代码 / 文本视图。

```js
cadt.registerFormat({
    id: 'bak-json',            // 必需，全局唯一，不能与内置格式同名
    name: 'JSON 备份',         // 必需，显示名
    extensions: ['bak'],       // 必需，小写扩展名（不带点）
    parse: (text) => JSON.parse(text),          // 树视图 / 编辑用
    stringify: (value) => JSON.stringify(value, null, 2),  // 保存 / 切视图用
    // 可选：
    // aceMode: 'json'                    // 代码视图高亮（Ace 模式名）
    // rawOnly: true                      // 不提供树视图（纯文本类）
    // table: true, parseTable(text), stringifyTable(headers, rows)  // 表格视图
});
```

- 内置格式优先：与内置格式扩展名相同的插件格式不会被用到（例如注册 `.json` 无效）。
- `parse` 抛异常时该文件自动退回文本视图，不会中断。
- 注册后即刻生效：之后打开的匹配文件会使用该格式；已打开的文件不受影响。
- 格式会出现在 设置 → 文件格式 树里，可获得独立的编码/缩进/换行/默认视图配置。

### `cadt.addCommand(spec)`

注册命令。默认进菜单栏 **工具(U)**，同时自动出现在命令面板（Ctrl+Shift+P）。

```js
cadt.addCommand({
    id: 'char-count',          // 插件内唯一，会加插件前缀
    label: '统计当前文件字符数',
    run(env) {
        const text = cadt.getActiveText();
        cadt.flash((env.hasFile ? env.formatId : '无文件') + ' · ' + (text ? text.length : 0) + ' 字符');
    },
});
```

**可选字段**（都可省略，向后兼容旧写法）：

| 字段 | 说明 |
| --- | --- |
| `icon` | 菜单图标名（`core/icons.js` 里注册的名称），缺省不显示 |
| `description` | 一句话说明，显示在右键菜单的副行 |
| `category` | 命令面板分组：`file` / `edit` / `format` / `view` / `tools` / `plugin`（默认 `plugin`） |
| `contexts` | 出现在哪些入口，取值 `tools` / `editorContext`（默认 `['tools']`）；命令面板对所有命令开放，无需声明 |
| `when` | `(env) => boolean`，返回 false 时该项变灰不执行（`editorContext` 里直接不出现）；抛错按不满足处理 |
| `shortcut` | `{key: 'Ctrl+Alt+F', when?: 'editorFocus'}`，`when` 只支持 `'editorFocus'`（编辑器聚焦时才生效） |

```js
cadt.addCommand({
    id: 'fmt-sql', label: '格式化 SQL', icon: 'wand',
    description: '格式化选中或全文的 SQL',
    category: 'format',
    contexts: ['tools', 'editorContext'],
    when: (env) => env.formatId === 'sql' && !env.readonly,
    shortcut: {key: 'Ctrl+Alt+F', when: 'editorFocus'},
    run(env) { /* … */ },
});
```

`run(env)` 与 `when(env)` 收到同一份上下文快照：

| 字段 | 说明 |
| --- | --- |
| `hasFile` | 是否有活动文件 |
| `formatId` | 当前格式 id（如 `json` / `csv`），无文件为空串 |
| `hasSelection` | 是否有选中文本 |
| `readonly` | 当前文档是否只读（全局只读锁或标签锁） |
| `workspace` | 当前工作区目录，未打开工作区为空串 |
| `editorFocused` | 编辑器是否有焦点 |

规则与边界：

- **快捷键不抢占内置键位**：内置动作优先匹配，只有没命中任何内置键时才会落到插件命令；同键多插件命令时先注册者生效。
- 对话框打开或正在输入框里打字时，插件快捷键不触发。
- `contexts` 里的未知值会被静默剔除；全部无效时按 `['tools']` 处理。
- `when` 抛异常一律当「条件不满足」，一条坏命令不会阻断整个菜单渲染。

### `cadt.addTheme({id, name, extends?, bg?, accent?, vars?, css?})`

注册界面主题，出现在 主题(T) 菜单里。推荐只写差异项，其余变量继承内置 `dark` 或 `light`：

```js
cadt.addTheme({
    id: 'my-theme',
    name: '我的主题',
    extends: 'dark',
    bg: '#241f31',             // 窗口底色（菜单色块也用它）
    accent: '#c58af9',         // 强调色
    vars: {
        '--bg': '#241f31',
        '--text': '#e8e3f2',
        '--muted': '#9d94b8',
        '--border': '#3a3350',
        '--accent': '#c58af9',
        '--on-accent': '#1b1626'
    }
});
```

- `extends` 可继承内置主题或先注册的插件主题，最多 8 层，禁止循环。
- `vars` 只接受应用登记的界面变量；未知变量、非法颜色、`bg` 与最终 `--bg` 不一致都会拒绝注册。
- 不写 `bg` / `accent` 时从继承主题或对应变量推导。
- 可选 `css` 是高级扩展，会追加到同一主题样式节点；它影响整个应用页面，不是安全隔离边界。
- 旧式“只传 `css`”写法仍可用，但新主题应优先使用 `extends + vars`。

### `cadt.addCodeTheme({id, name, extends?, group?, vars?})`

注册独立于界面主题的代码配色，自动进入 主题(T) → 代码主题 与设置页：

```js
cadt.addCodeTheme({
    id: 'my-code',
    name: '我的代码主题',
    extends: 'jetbrains-dark',
    group: 'dark',
    vars: {
        '--editor-bg': '#241f31',
        '--syn-keyword': '#c58af9',
        '--syn-string': '#9ece6a'
    }
});
```

代码主题必须最终具备 25 项语法与编辑器变量，可通过继承补齐；禁止覆盖 `--bg` / `--text` / `--accent` 等界面变量。

### `cadt.registerIconTheme({id, name, extends?, icons})`

注册文件图标主题，自动进入设置页的“文件图标主题”下拉：

```js
cadt.registerIconTheme({
    id: 'my-icons',
    name: '我的图标',
    extends: 'opensource',
    icons: {
        json: '<svg viewBox="0 0 16 16"><path d="M0 0h16v16z"/></svg>',
        default_file: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>'
    }
});
```

缺失类型优先使用 `default_file`，再回退到继承主题或内置文字缩写图标。插件禁用、卸载或加载失败后，注册项与样式会一并清理；当前正在使用的主题不存在时回退到内置默认主题。

### `cadt.registerCommandClassifier(spec)`

注册端侧命令风险分类器（自动审批链使用，需含本 API 的应用版本）。端侧分类器只产出危险概率、**无 deny 权**：`score ≥ 严格度阈值` 一律转人工，多个启用的分类器全部执行、保守合并取最高分；分类器抛异常跳过继续，连续 5 次失败本会话内自动停用。

```js
cadt.registerCommandClassifier({
    id: 'onnx-semantics',        // 插件内唯一，^[a-z0-9][a-z0-9-]{0,63}$
    label: '语义分类器（ONNX）',  // 审批卡 / 权限记录里显示
    classify(command, ctx) {     // 可返回 Promise
        // ctx: {cwd, toolName, strictness, threshold, sessionId}
        return {score: 0.02, reason: '只读查询'};   // score = 危险概率 [0,1]
    },
});
```

完整示例见 [`examples/command-classifier-onnx/`](examples/command-classifier-onnx/)（接线演示 + 上架指引）。

### `cadt.registerAIProvider(spec)`

注册一个 **AI provider**：它以「虚拟账号」出现在 设置 → AI 助手 → 模型账号 和模型选择器里，并可在本轮组装请求配置时注入动态请求头 / 请求体补丁。请求与 SSE 解码仍由应用（Go 侧）完成，代理、超时、重试、错误分类等既有能力全部保留。

```js
cadt.registerAIProvider({
    id: 'local-demo',                 // 插件内唯一，^[a-z0-9][a-z0-9-]{0,63}$
    name: '示例 · 本地服务',          // 账号显示名
    account: {                        // 连接信息，注册时固定
        provider: 'openai',           // openai（默认）| anthropic | responses
        baseURL: 'http://127.0.0.1:8000/v1',
        apiKey: '',
        temperature: 0.7,
        proxy: '',
        extraHeaders: {},            // 静态请求头
    },
    models: [                         // 至少 1 条，最多 50 条
        {model: 'demo-chat', contextWindow: 128000, outputWindow: 4096},
    ],
    prepare(ctx) {                    // 可选：每轮组装请求配置时调用一次
        // ctx: {sessionId, accountId, providerId, model, baseURL}（不含密钥）
        return {
            extraHeaders: {'x-demo-session': ctx.sessionId.slice(0, 16)},
            extraBody: {tool_choice: 'none'},
        };
    },
});
```

规则与边界：

- **虚拟账号只在内存里**：带 `pluginAI` 标记，保存配置时会被剔除，绝不写进 `ai-config.json` 或 localStorage 镜像；插件禁用 / 卸载 / 加载失败后账号随之消失。账号在设置页只读，改连接信息要改插件代码并重新加载。
- `prepare(ctx)` 必须同步返回；抛异常只忽略本轮补丁，不中断对话。**拿不到 `apiKey`**，动态凭据请走 `extraHeaders` 补丁。
- 补丁只放行 `extraHeaders` / `extraBody` 两个白名单字段，`baseURL` / `apiKey` / `model` 由 `account` 与所选模型决定。请求头合计 ≤ 8 条（动态头优先），请求体补丁 ≤ 32 字段 / 64 KiB。
- `stream` 恒为 `true`（SSE 解码依赖），插件无法通过补丁关掉。协议支持三种：`openai`（`/chat/completions`）、`anthropic`（`/v1/messages`）、`responses`（`/responses`，也可在 设置 → AI 助手 → 模型账号 里手动选）。
- `responses` 走 OpenAI Responses API：消息映射成 `input`（system → `instructions`、工具结果 → `function_call_output`、assistant 工具调用 → `function_call`），工具是扁平的 `{type,name,description,parameters}`；流事件解析 `output_text.delta` / `reasoning_text.delta` / `output_item.done` / `completed`。**依赖 data JSON 里的 `type` 字段**；工具参数取 `output_item.done` 的完整 `arguments`，不拼接 `function_call_arguments.delta` 增量。
- 典型用途：按会话派生关联 ID、给特定网关补 `tool_choice` / 工具声明、注入租户标记等。不适合做协议级改写或出口 IP 轮换（代理应走 `account.proxy` 或系统代理）。
- 完整可运行示例见 [`examples/ai-provider-demo/`](examples/ai-provider-demo/)。

### `cadt.registerTool(spec)`

让插件向 **AI** 提供工具。**默认关闭**：注册只是登记能力，必须由用户在 设置 → AI → 权限 → 插件工具 逐层授权后，工具定义才会下发给模型。

```js
cadt.registerTool({
    name: 'query_jira',                  // 插件内唯一，^[a-z0-9_]{1,40}$
    description: '按 JQL 查询 Jira 工单并返回摘要（何时用 / 何时不用 / 与相邻工具的分工，模型只看这段）',
    parameters: {
        type: 'object',
        properties: {jql: {type: 'string', description: 'JQL 表达式'}},
        required: ['jql'],
    },
    readOnly: true,                      // 声明「只读」——只是候选资格，见下
    timeoutMs: 60000,                    // 可选，默认 60s，上限 300s
    async execute(args, ctx) {
        // ctx: {sessionId, scope（权限档）, signal（AbortSignal）}
        return JSON.stringify(await fetchJira(args.jql));
    },
});
```

**三层授权**（缺一不可，都在 设置 → AI → 权限 → 插件工具）：

1. **全局总闸**：关掉后所有插件工具都不下发。
2. **插件级**：允许此插件向 AI 提供工具。
3. **工具级**：逐个工具开关。

`readOnly: true` 只是**候选资格**，不等于能在只读档使用：还需用户在该工具旁显式勾上「只读档可用」（默认关）。作者声明意图、用户确认授权，是双人复核——插件不能自己给自己发通行证。

规则与边界：

- **下发条件**：三层授权全开 + 非计划模式 +（普通工具须 `edit` / `auto` / `full` 档；`readOnly` 工具在用户勾了「只读档可用」后，`read` 档也给）。
- **执行一律走审批链**：与 MCP 工具同一套判定与同一张审批卡，按权限档、项目规则、端侧分类器决定放行或转人工。`readOnly` 只影响下发，不影响审批。
- **工具名带来源**：对外公开名是 `plugin__<插件id>__<工具名>`，工具卡显示「插件 · 工具名」并标出插件来源。
- **子代理默认看不到**插件工具（副作用在子代理里发生更难归因）；需要时在主会话调用。
- **上限**：单插件 ≤ 20 个、全局 ≤ 50 个；`description` ≤ 2000 字符；`parameters` ≤ 16 KiB。超限**注册时报错**（进插件加载错误，不会静默丢弃）。
- **计划模式**：一律拒绝，与内置写工具、MCP 同口径。
- **返回值**：`string` 直接作为工具结果；`{text, images}` 取 `text`（当前版本不把 images 注入对话，会在正文里注明）。

> **必须知道的限制**：审批只约束「**AI 调用插件工具**」这一条路径，**约束不了插件代码自己干活**。插件以 `new Function` 在主文档执行，加载那一刻就拥有与本应用相同的权限（可 `cadt.runCommand` 起进程、可读写本机文件）。所以插件工具授权的作用是**收窄 AI 的能力面**，不是把插件关进沙箱——真正的防线仍然是「只安装可信来源的插件」。详见 `docs/finished-plans/plugin-tool-security.md`。

### `cadt.registerViewer(spec)`

注册一个**自定义视图**：让某个格式多出一个「用自己的渲染器画」的视图（地图、图表、3D、播放器等）。与 `registerFormat` 的区别是——`registerFormat` 只能把数据喂给内置四种视图，`registerViewer` 自己决定怎么画。

```js
cadt.registerViewer({
    id: 'geo-map',                       // 全局唯一，^[a-z0-9][a-z0-9-]{0,63}$
    label: '地图',                        // 视图下拉 / 标签页按钮上的名字（≤40 字）
    formats: ['geojson'],                // 归属：格式 id 或扩展名（不带点），两者都匹配
    priority: 10,                        // 可选，视图下拉里越大越靠前（默认 0）
    mount(container, ctx) {
        // container 是一个空的 div，铺满内容区；自建 DOM / canvas / 第三方库全在插件侧
        const canvas = document.createElement('canvas');
        container.appendChild(canvas);
        let theme = ctx.getTheme();
        const off = ctx.onChange((text) => redraw(text));
        return {
            resize() {},                                  // 容器尺寸变化（分栏拖拽 / 窗口缩放）
            setTheme(name) { theme = name; redraw(); },    // 主题切换：改配色，不要重挂
            destroy() { off(); canvas.remove(); },         // 切视图 / 关标签时调用，必须断干净
        };
    },
});
```

**ctx 提供什么**：

| 成员 | 说明 |
| --- | --- |
| `getData()` | 当前文档文本（视图拿到的是原始文本，不是树的解析结果） |
| `getSelection()` / `setSelection({start, end})` | 字符偏移的选区读写（底层是 Ace；树视图下为 `null`） |
| `getTheme()` | `'dark'` / `'light'` / 插件主题 id |
| `onChange(cb)` | 文本变化回调，返回退订函数 |
| `requestSave(text)` | **写回的唯一出口**：交给编辑器走脏标记与只读判定，返回是否写入成功 |
| `flash(msg, isError)` | 状态栏提示 |
| `source` | `{path, name, size}` |
| `readOnly` | 当前是否只读（只读时 `requestSave` 直接拒绝） |

规则与边界：

- **视图只渲染不改数据**：ctx 没有直接写接口。要让用户的改动落地就调用 `requestSave(text)`——文本交给编辑器后，脏标记、自动保存、只读锁、外部修改检测全部照旧生效。
- **必须实现 `destroy()`**：切换视图、关闭标签都会调用。定时器、`window` 监听、`ResizeObserver`、第三方实例一律在那里释放；漏了就是泄漏，宿主不会替你兜底。
- **视图是覆盖层**：底层编辑器仍持有内容，切走即销毁、切回重新 `mount`，所以不要在 mount 之外缓存 DOM 引用；视图内部状态（缩放 / 滚动）不跨切换保留。
- **大文件不挂**：二进制文件与 `>10 MB` 的只读档不提供插件视图（视图菜单里直接不出现），避免把整份内容塞进插件。
- **主题切换走 `setTheme(theme)`**，不要重挂；主题值来自 `html[data-theme]`。
- **注册上限**：单插件 ≤ 10 个、全局 ≤ 30 个；`id` 全局唯一（视图模式串是 `plugin:<id>`，撞了就切不过去）。超限与非法声明在**注册时报错**并进插件加载错误，不静默丢弃。
- 插件禁用 / 卸载后，停在旧模式的标签页在下次打开时自动回落到默认视图。
- 示例见 [`examples/geojson-viewer/`](examples/geojson-viewer/)（地图视图 + 导入器，零第三方依赖）。

### `cadt.registerImporter(spec)`

注册一个**文档导入转换器**：某个文件内置解析不了（只能看二进制）时，问用户一句要不要用插件把它转成文本。典型场景是 PDF→Markdown、docx→md、OCR 后再编辑。

```js
cadt.registerImporter({
    id: 'pdf-md',                     // 插件内唯一，^[a-z0-9][a-z0-9-]{0,63}$
    label: 'PDF 转 Markdown',
    extensions: ['pdf'],              // 触发条件：这些扩展名（不带点、小写）
    async convert(ctx) {
        const bytes = await ctx.readBinaryFile(ctx.path);   // base64
        const markdown = await toMarkdown(bytes);
        // 返回 string → 直接当正文；返回 {text, name} → 顺便建议一个新文件名
        return {text: markdown, name: ctx.name.replace(/\.pdf$/i, '') + '.md'};
    },
});
```

`convert(ctx)` 的 `ctx`：`{source: 'open', ext, path, name, size, readTextFile(path), readBinaryFile(path), flash(msg, isError)}`。

规则与边界：

- **只在打开链询问**：文件内置解析不了（二进制视图）且扩展名命中时才弹确认框；用户拒绝或 `convert` 抛错一律**退回原有的二进制视图**——导入失败不会让文件打不开。
- **结果以只读虚拟文档打开**：导入是「转换」不是「编辑」，标签页带只读锁。
- **建议文件名**：返回 `{text, name}` 时用 `name`（例如 `report.md` 才会走 Markdown 渲染）；不返回则沿用原文件名。
- **读接口不新增 Go 绑定**：`readTextFile` 走内置 `OpenFile`；`readBinaryFile` 先走读图通道（`ReadImageAsDataURL`，图片类型 ≤32 MB），其余类型退回十六进制视图，**上限 1 MB**，超过直接抛错。更大的二进制请用插件自己的通道（`cadt.runCommandSync` 等）读取。
- **`--convert` 命令行不走插件**：CLI 转换在 Go 侧（`internal/convertcli`），看不到前端插件。
- 同一扩展名被多个导入器声明时只取**第一个**注册的，不弹多选。
- 示例见 [`examples/geojson-viewer/`](examples/geojson-viewer/) 的 `bin-peek`。

### `cadt.getPluginDir()`

返回当前插件的安装目录（绝对路径，字符串）。插件可用它拼自己的资源 / 脚本路径，例如把配套服务源码放在插件目录下的 `server/`：

```js
const dir = cadt.getPluginDir();          // 如 D:\...\plugins\my-plugin
const serverDir = dir.replace(/[\\/]+$/, '') + '/server';
```

### `cadt.registerService(spec)`

注册一个**后台服务**，交给应用统一托管：软件启动时自动拉起（可选）、定期健康检查、退出时自动停掉整棵进程树。插件不持有进程句柄、不做守护——进程的启停 / 探活 / 日志缓冲 / 退出清理全在应用内置的 `appservices` 引擎里。

```js
cadt.registerService({
    id: 'server',                          // 插件内唯一，^[a-z0-9][a-z0-9-]{0,63}$
    exe: 'python',                         // 可执行文件（在 PATH 里或完整路径）
    args: ['main.py', 'serve'],            // 参数（≤128 个）
    cwd: cadt.getPluginDir() + '/server',  // 工作目录；留空 = 插件目录
    healthURL: 'http://127.0.0.1:3000/v1/models', // 可选：探活地址（http/https）
    autoStart: true,                       // 软件启动时自动拉起
    pollIntervalMs: 5000,                  // 可选：探活间隔（≥500ms，默认 3000）
    logCapBytes: 262144,                   // 可选：日志环形缓冲上限（默认 256 KiB）
});
```

规则与边界：

- 服务在插件加载完成后统一同步给应用：新增 / 变更的 `autoStart` 服务拉起，被禁用 / 卸载插件的服务自动停止。
- `healthURL` 非空时定期 GET 探活（超时 2s，2xx–4xx 视为存活），连续 5 次失败标记 `failed`；留空则只按进程存活判定。
- 状态机：`stopped` / `starting` / `running` / `failed`；进程意外退出自动转 `failed` 并记录原因。
- 日志按行收进环形缓冲（默认 256 KiB，超出丢最早的），可用 `cadt.getServiceLogs(id)` 或设置面板的 ctx 读取。
- 服务声明只在内存里，不落盘；exe / args / cwd 的合法性由插件负责，应用只做启停与健康检查，**不做沙箱**。只托管可信来源的插件服务。
- 操作 API（均返回 Promise）：`cadt.startService(id)` / `cadt.stopService(id)` / `cadt.getServiceStatus(id)` / `cadt.getServiceLogs(id)`，其中 `id` 是插件内短 id。

### `cadt.registerDbDriver(spec)`

注册一个**数据库驱动**：让侧栏「数据库」面板支持新的数据库类型。连接表单字段由驱动声明（宿主动态渲染），连接后的会话由驱动实现——对象树、表数据网格、SQL 控制台全部复用内置界面，宿主不关心传输与协议（HTTP 型数据库直接 `fetch`；需要本地 sidecar 的配合 `registerService` 托管）。

```js
cadt.registerDbDriver({
    id: 'clickhouse',                    // 插件内唯一，^[a-z0-9][a-z0-9-]{0,63}$
    label: 'ClickHouse (HTTP)',          // 侧栏分组名与添加对话框标题（≤40 字）
    fields: [                            // 连接表单（1–12 个）
        {key: 'url', label: 'HTTP 地址', type: 'text', default: 'http://127.0.0.1:8123', required: true},
        {key: 'user', label: '用户', type: 'text', default: 'default'},
        {key: 'password', label: '密码', type: 'password'},   // password = DPAPI 加密存储，不进工作区清单
        {key: 'database', label: '默认库', type: 'text', default: 'default'},
    ],
    async connect(config) {              // config = 表单收集值（password 已合并明文）
        async function sql(query) {
            const res = await fetch(config.url, {method: 'POST', body: query});
            if (!res.ok) throw new Error('ClickHouse ' + res.status + '：' + (await res.text()).slice(0, 500));
            return res.json();
        }
        return {
            info: {server: 'ClickHouse', database: config.database},
            async listDatabases() {
                const json = await sql('SELECT name FROM system.databases ORDER BY name FORMAT JSON');
                return json.data.map((r) => String(r.name));
            },
            async listObjects(db) { /* → [{name, kind: 'table'|'view', rowEstimate}] */ },
            async describe(db, table) { /* → {table, kind, columns:[{name,type,notNull,pk}], pk, indexes, rowEstimate} */ },
            async browse(req) { /* → {columns, rows, nulls, truncated, elapsedMs, message} */ },
            async query({queryId, sql, confirmed, limit}) { /* → {status:'ok'|'confirm', confirm?, result, writes?} */ },
            async cancel(queryId) {},    // 可选
            async close() {},            // 可选
        };
    },
});
```

**会话契约**（方法名与返回形状与内置 SQLite/MySQL 绑定一致，网格与控制台零改动复用）：

| 方法 | 入参 | 返回 |
| --- | --- | --- |
| `listDatabases()` | — | `string[]` |
| `listObjects(db)` | 库名 | `[{name, kind: 'table'\|'view', rowEstimate?}]` |
| `describe(db, table)` | 库名、表名 | `{table, kind, columns:[{name,type,notNull,default?,pk}], pk, indexes?, rowEstimate?}` |
| `browse(req)` | `{database, table, sortColumn, sortDesc, filters, offset, limit}` | `{columns, rows: string[][], nulls: bool[][], truncated, elapsedMs?, message?}` |
| `query(o)` | `{queryId, sql, confirmed, limit}` | `{status: 'ok'\|'confirm', confirm?: 'danger'\|'missingWhere', message?, result, statements?, writes?}` |
| `cancel(queryId)` / `close()` | — | 可选，无返回 |

规则与边界：

- **kind 与注册表**：驱动的全局类型串是 `plugin:<插件id>:<驱动id>`，工作区清单按它分组；插件禁用 / 卸载后引用它的条目打开时明确报「驱动未注册」，不会静默空白。上限：单插件 ≤ 5 个、全局 ≤ 20 个、单驱动 fields ≤ 12 项，超限注册时报错。
- **v1 只读**：插件会话一律不可编辑（网格编辑 = dirty model + 单事务提交 + 乐观并发，是内置 sqlite/mysql 的 SQL 契约；插件侧的受控写入等契约稳定后另开）。`query` 返回的 `writes` 只用于留痕计数。
- **危险确认走同一 UI**：`query` 返回 `status:'confirm'`（`confirm: 'danger' | 'missingWhere'`）时宿主弹同一确认层，用户确认后带 `confirmed: true` 重发——插件自己也应当做同等拦截，两道防线。
- **密文字段**：`type:'password'`（或 `secret: true`）的字段经 DPAPI 加密存储（键 `dbplug:<条目id>:<字段键>`），绝不进 localStorage 与跨窗同步；编辑对话框留空 = 保持不变。`connect` 拿到的 config 已合并明文，只在闭包内使用。
- **超时**：宿主对每次插件调用包 120s 超时；插件应在 connect/query 里自设更短的超时与 `AbortController`。
- **工作区清单**：用户添加的连接配置（非密文字段）存 `settings.dbWorkspaceDatabases`，条目形如 `{kind: 'plugin:<插件id>:<驱动id>', name, config, …}`，按工作区生效、跨窗同步。
- **传输选择**：HTTP SQL 接口（ClickHouse/Trino/Presto 等）直接 `fetch`；数据库自带代理协议不可直连时，用 `registerService` 起本地 sidecar 再调它的 HTTP 接口；裸 TCP 协议（如 PostgreSQL wire）当前无桥接通道，做协议客户端不如把驱动下沉到核心（见 `internal/dbclient` 的 Driver 接口，MySQL/SQLite 先例）。
- 完整可运行示例见 [`plugins/db-clickhouse-http/`](../../plugins/db-clickhouse-http/)（真实 ClickHouse HTTP 接口，零依赖）。

### `cadt.registerSettingsPanel(spec)`

注册一个**插件专属设置面板**：在 设置 → 插件设置 下出现独立导航项，适合放服务开关、状态、日志、说明等自定义内容。

```js
cadt.registerSettingsPanel({
    id: 'zcode',                 // 插件内唯一，^[a-z0-9][a-z0-9-]{0,63}$
    label: 'ZCode 反代',          // 导航项与插件卡片按钮文字（≤40 字）
    render(container, ctx) {     // 同步渲染；容器是空的 div，可自由 append DOM
        const st = document.createElement('div');
        container.appendChild(st);
        ctx.getServiceStatus('server').then((s) => { st.textContent = s.state; });
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '启动服务';
        btn.addEventListener('click', () => ctx.startService('server'));
        container.appendChild(btn);
    },
});
```

`ctx` 提供：

| 成员 | 说明 |
| --- | --- |
| `flash(msg, isErr)` | 状态栏提示 |
| `startService(id)` / `stopService(id)` | 启停本插件服务（Promise） |
| `getServiceStatus(id)` / `getServiceLogs(id)` | 查状态 / 读日志（Promise） |
| `openExternal(url)` | 用系统浏览器打开链接 |

规则与边界：

- 面板只在内存里；插件禁用 / 卸载后导航项与面板自动消失。
- `render` 必须同步返回；异步数据自行 `.then()` 填充。重渲染时请自己清理上一次的定时器 / 监听（容器会被复用）。
- 面板内表单控件遵循全局表单规范：动态控件用 `core/form-controls.js` 的 `createSwitch` / `createSelect` / `createInput` / `createTextarea`，不要写裸 `<input>`。
- 完整可运行示例见随仓库分发的 `plugins/zcode2api/`（注册虚拟账号 + 后台服务 + 设置面板三合一）。

### `cadt.registerDocConverter(spec)`

注册一个**文档格式转换器**——通用的导出能力扩展点。应用的各导出场景（快捷便签面板、AI 回答另存、阅读导出……）把内容组装成统一的 `ctx`（HTML + 图片字节 + 落盘原语）交给转换器；转换器负责生成目标格式并落盘。设计意图：Word / PDF 这类重格式的生成依赖较重（docx 打包库、pdf 生成库），放在插件侧随插件分发，核心应用保持零依赖——内置导出只有 Markdown 与 HTML，其余交给市场插件；一个转换器插件安装后，**所有**接入扩展点的导出菜单自动获得该格式，无需各场景重复实现。

```js
cadt.registerDocConverter({
    id: 'word-doc',                        // 插件内唯一，^[a-z0-9][a-z0-9-]{0,63}$
    label: 'Word 文档（.doc，图片存旁侧）',// 导出菜单显示名，≤60 字符
    extensions: ['doc'],                   // 目标扩展名（展示用）
    async convert(ctx) {
        // ctx.source：消费场景标识（如 'memo'）；后续场景接入会扩展
        // ctx.title / ctx.suggestedName：内容标题与建议文件名主名（不含扩展名）
        // ctx.html：完整 HTML 文档，图片引用统一为相对 img/<name>，与 ctx.images 一一对应
        // ctx.images：[{name: 'xxx.png', mime: 'image/png', base64: '…'}]（字节就绪）
        const path = await ctx.chooseSavePath(ctx.suggestedName + '.doc');
        if (!path) return;                // 用户取消：返回空串
        const dir = path.replace(/[\\/][^\\/]+$/, '');
        for (const image of ctx.images) {
            await ctx.writeBinaryFile(dir + '/img/' + image.name, image.base64, image.mime);
        }
        await ctx.writeTextFile(path, ctx.html);
        ctx.flash('已导出：' + path);
    },
});
```

`convert(ctx)` 的上下文：

| 成员 | 说明 |
| --- | --- |
| `source` | 消费场景标识（如 `'memo'`），同一转换器可服务多个场景 |
| `title` / `suggestedName` | 内容标题与建议文件名主名（不含扩展名，扩展名由转换器自定） |
| `html` | 完整 HTML 文档（已 sanitize），图片引用统一为相对 `img/<name>`，与 `images` 一一对应 |
| `images` | `[{name, mime, base64}]`：文档引用的全部图片，字节就绪 |
| `chooseSavePath(defaultName)` | 保存对话框，返回完整路径；取消返回 `''` |
| `writeTextFile(path, content)` | UTF-8 文本落盘（路径来自 chooseSavePath） |
| `writeBinaryFile(path, base64, mime)` | 二进制落盘（base64 + MIME） |
| `flash(message, isErr)` | 状态栏消息 |

规则与边界：

- 当前消费方：快捷便签面板的导出菜单（内置 Markdown / HTML 两项固定在前，转换器项以分隔线排在后面）；插件禁用 / 卸载 / 加载失败后其菜单项消失，不影响内置导出。后续更多场景接入同一扩展点。
- `convert(ctx)` 抛异常由消费方捕获并以「插件导出失败：…」提示，不会破坏界面状态；用户取消对话框请让 `convert` 直接 `return`，不要抛错。
- 图片交付形态：`ctx.html` 引用相对 `img/<name>`、`ctx.images` 提供字节——**写旁侧文件**（Word 推荐：其 HTML 导入对 data URI 支持不稳）或按 PDF 库能力内嵌，由转换器自定；未成功落盘的图片建议在正文降级标注。
- 生成逻辑与第三方依赖全部随插件分发（入口 ≤ 2 MB，资产另计），核心应用不为此引入任何依赖。
- 参考实现：内置的 Word .docx 导出（`src/bridge/memo-docx.js`）即按本 ctx 契约开发；PDF 等更重格式（需引生成库）适合走本扩展点发布到插件市场。

### 命令执行（进程桥）

```js
// 同步执行（超时默认 20s，上限 120s；输出上限 8MB）
// 返回 Promise（命令在 Go 侧异步执行），必须 await —— 不 await 只会拿到一个
// Promise（读 stdout 得到 undefined），失败还会变成未处理的 Promise 拒绝。
const res = await cadt.runCommandSync({exe: 'git', args: ['status', '--porcelain'], cwd: 'D:
epo', timeoutMs: 15000});
// await 后 res = {code: 0, stdout: '...', stderr: '...'}；非零退出码不是异常，看 code

// 流式执行
const job = cadt.runCommand({
    exe: 'git', args: ['log', '-n', '10'], cwd: 'D:
epo',
    onOut(line) { cadt.openVirtualDoc('输出.txt', line); },
    onErr(line) {},
    onExit(code) { cadt.flash('命令结束：' + code); },
});
job.stop(); // 提前终止
```

### 虚拟文档

```js
cadt.openVirtualDoc('Git 差异 — main.diff', patchText);  // 扩展名决定高亮（.diff → diff 高亮）
```

以未命名标签页打开文本内容，保存时走"另存为"。

### 运行时辅助

| API | 说明 |
| --- | --- |
| `cadt.getActiveFile()` | 当前文件信息 `{path, name, size, formatId}`，无文件时为 `null` |
| `cadt.getActiveText()` | 当前文件文本（按当前视图取值），二进制文件为 `null` |
| `cadt.openPath(path)` | 用本程序打开一个文件或目录 |
| `cadt.flash(message)` | 在右下角弹出提示 |
| `cadt.runCommandSync(opts)` | 同步执行命令，返回 `Promise<{code, stdout, stderr}>`（**必须 await**，见上） |
| `cadt.runCommand(opts)` | 流式执行命令，返回 `{stop()}`（见上） |
| `cadt.openVirtualDoc(name, content)` | 以未命名标签页打开文本 |

## 目录与切换

- 默认（便携）：`<exe 目录>\plugins\<插件 id>\`，跟程序走，复制目录即可带走。
- 可选（应用数据）：`%APPDATA%\CandySweet\CaDt-DataLens\plugins\<插件 id>\`。
- 在 设置 → 插件 里切换目录模式；切换后列表按新目录展示，已安装插件不会自动迁移。

## 发布到插件市场

插件市场默认 = Gitee 组织 [`cadt-datalens-plugins`](https://gitee.com/cadt-datalens-plugins) 的公开仓库（Gitee API v5 org repos 列出，仓库根 `plugin.json` 提供元数据）。GitHub 组织 [`cadt-datalens-plugins`](https://github.com/cadt-datalens-plugins) 是其**镜像**，两边仓库同名同内容；模型配置表仓库 [`cadt-datalens-data/model-catalog`](https://gitee.com/cadt-datalens-data/model-catalog) 同样在 GitHub 有镜像：

1. 在组织下建公开仓库（仓库名建议与插件 `id` 一致），推送插件内容到**仓库根**（清单 + 入口 + 资产，不要包子目录）；
2. `plugin.json` 里 `homepage` / `repository` 指向仓库地址，`minAppVersion` 锁定依赖的应用 API 版本；
3. 推送后市场列表自动出现，无需登记；更新插件 = 推新版本 tag / 提交并更新清单 `version`；Gitee 与 GitHub 两侧需同步推送（镜像内容保持一致）。

应用内可在 设置 → 插件 → 插件市场 切换「数据源」（默认 Gitee，可选 GitHub）：切换后市场列表、从仓库地址安装的示例地址与 AI 模型配置表的默认同步地址都会跟随所选源；自定义的模型配置表地址（设置 → AI → 模型 → 配置表）优先于数据源默认。

参考：[`examples/command-classifier-onnx/README.md`](examples/command-classifier-onnx/README.md) 的上架指引一节。

## 安全说明

插件代码运行在界面上下文中，能力等同于用户自己运行的脚本（可以调用应用的全部后端接口）。注册了 AI provider 的插件还能在每轮模型请求里注入任意请求头与请求体字段，等同于接管该账号的请求内容——只安装可信来源的插件。应用会在导入时校验清单格式、入口路径与压缩包结构（防路径穿越、限大小），并对补丁做白名单与体积限制，但不做代码沙箱。

## 完整示例

见 [`examples/bak-json/`](examples/bak-json/)：把 `.bak` 文件按 JSON 解析，解析失败自动退回文本视图，并注册一个演示命令与主题。
AI provider 的完整示例见 [`examples/ai-provider-demo/`](examples/ai-provider-demo/)：注册虚拟账号 + 每轮动态请求头 / 请求体补丁。
