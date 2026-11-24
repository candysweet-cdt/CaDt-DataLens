# 统一主题定义与插件主题包（方案）

> 2026-11-24 立。状态：**已实施并完成自动化与真实界面验收**。
> 目标：把内置主题的声明、色值和映射收进一个数据文件；让插件通过同一套主题模型扩展界面、代码编辑器和文件图标，而不是各自维护一份入口与生命周期。

## 1. 目标与边界

### 1.1 目标

1. 内置主题只有一份数据真源，菜单、设置页、CSS、AI 动作和测试都从它派生。
2. 保留现有三条独立通道：界面主题、代码主题、文件图标主题可以分别选择。
3. 插件可注册同格式的主题，不要求手写完整 CSS 选择器，也不要求复制整套变量。
4. 主题支持继承：插件只写差异项，其余变量继承内置主题。
5. 安装、卸载、禁用和重载插件时，主题样式、菜单项、设置项与当前选择保持一致。
6. 不增加运行时依赖，不增加 Go 绑定方法，不改变现有配色。

### 1.2 不做的事

- 不把 `style.css` 的组件布局、尺寸、动画、弹层规则搬进主题数据文件。
- 不把大段 SVG 图标字面量强行内联进 JSON；统一的是主题声明与映射，图形资产仍按现有资产目录管理。
- 不把界面主题和代码主题重新合并成一个开关。
- 不引入在线主题市场、主题下载器或主题编辑器。
- 不改变插件的信任模型：插件仍与应用同页面、同权限执行，主题包不是沙箱。
- 首版不要求插件免写 JavaScript 入口；纯声明式 `theme.json` 入口可作为后续增强。

## 2. 现状（已核对代码）

### 2.1 三条主题通道

| 通道 | 当前真源 | 运行时开关 | 说明 |
| --- | --- | --- | --- |
| 界面主题 | `frontend/src/main.js` 的 `themes`；`frontend/src/style.css` 的 `:root` 与 `html[data-theme="light"]` | `settings.theme` → `html[data-theme]` | 内置只有深色、浅色两套 |
| 代码主题 | `frontend/src/settings/code-styles.js` 的清单与变量名；`style.css` 的 9 个 `data-code-style` 块 | `settings.codeStyle` → `html[data-code-style]` | `auto` 不写属性，自然回落到界面主题变量 |
| 文件图标主题 | `frontend/src/core/fileicons.js`、`fileicons-os.js` 与 `index.html` 的静态选项 | 独立图标主题设置 | 内置 opensource / mono / plain |

界面主题目前深色变量直接挂在 `:root`，浅色变量覆盖在 `html[data-theme="light"]`。代码主题通过更高特异性的选择器覆盖语法 token 和编辑器观感变量。组件统一消费 `--bg`、`--text`、`--editor-bg`、`--ace-*` 等变量。

### 2.2 切换、持久化与同步

- `setTheme()` 修改 `settings.theme`，调用 `applySettings()`，必要时重绘 Markdown 预览。
- `applyTheme()` 写 `document.documentElement.dataset.theme`，并把 `theme.bg` 传给原生 `SetWindowBg`。
- `applyCodeStyle()` 独立写 `dataset.codeStyle`；`auto` 时删除该属性。
- `applySettings()` 统一落盘到 `datalens-settings`，并经 `settings-changed` 广播全量快照。
- `applyRemoteSettings()` 是跨窗口快照唯一合并入口；主题属于全局偏好，不在 `PER_WINDOW_LAYOUT_KEYS` 中。
- 顶部“主题”菜单同时展示界面主题和“代码主题”子菜单；设置页另有代码主题下拉。

### 2.3 已有插件能力

`cadt.addTheme({id, name, bg, accent, css})` 已能注册界面主题：

1. 校验主题 ID；
2. 在 `document.head` 追加 `<style data-plugin-theme="...">`；
3. 把元数据加入 `deps.themes`，随后出现在主题菜单；
4. 插件代码自行编写 `html[data-theme="<id>"]` CSS。

`cadt.registerIconTheme()` 已有 API 与图标注册表，`setFileIconTheme()` 也已有消费入口，但当前宿主没有注入 `addPluginIconTheme`，调用时会落到未定义函数。图标主题注册表也没有随插件重载清空。

### 2.4 当前问题

1. **元数据与色值分离**：改一套主题要同时改 JS 清单和 CSS。
2. **代码主题无法插件化**：`CODE_STYLES`、设置白名单和菜单都是静态内置清单。
3. **插件主题没有统一模型**：只能接收任意 CSS，无法检查变量拼写、继承关系与明暗模式。
4. **重载生命周期不完整**：`loadPlugins()` 删除插件样式，却没有从 `deps.themes` 删除旧主题；再次加载会撞 ID 冲突，导致插件中断。
5. **图标主题接线缺失**：API 已存在，但注册、设置选项、卸载清理没有闭环。
6. **启动迁移表有副本**：`index.html` 的防闪脚本重复维护旧主题映射，正式迁移表在 `code-styles.js`。
7. **启动顺序**：内置设置先应用，插件异步加载；存储的插件主题在样式尚未注册时可能短暂使用错误回退。
8. **主题校验分散**：界面主题只校验非空，代码主题使用启动时生成的静态白名单，插件注册后无法扩展。

## 3. 核心决策

### 3.1 统一主题数据，不统一组件 CSS

新增 `frontend/src/core/themes.json` 作为内置主题声明真源，包含：

- 界面主题；
- 代码主题；
- 文件图标主题声明；
- 旧主题迁移映射；
- 界面主题默认对应的代码主题。

`core/` 是因为主题模型同时被 `settings/`、`shell/plugins.js` 和编辑器消费，不应反向依赖设置模块。

`style.css` 只保留组件规则，以及少数无法用变量表达的组件特例。迁移首版以视觉不变为硬约束，不借机调整布局、阴影、圆角或语义色。

### 3.2 保留三条通道

统一的是**定义格式和注册表**，不是用户选择方式：

- `settings.theme` 继续控制界面；
- `settings.codeStyle` 继续控制编辑器；
- 图标主题设置继续独立。

界面主题可声明 `defaultCodeStyle`，仅在 `codeStyle = auto` 时决定显示名和实际回落主题，不覆盖用户显式选择的代码主题。

### 3.3 变量白名单 + 继承

结构化主题只接受已登记变量：

- 界面变量：从现有 `:root`、浅色覆盖块和主题专属规则中整理出唯一目录；
- 代码变量：沿用现有 `CODE_TOKEN_VARS` 与 `EDITOR_CHROME_VARS`，不扩大代码主题可改的界面变量范围；
- 图标映射：按文件类型键注册，不把任意 CSS 混进图标主题。

主题可 `extends` 同类内置主题或已注册插件主题。运行时递归合并变量，后代覆盖祖先。禁止循环继承，最大深度暂定 8 层；超出即拒绝注册并给出完整继承链。

未知变量、非法颜色、缺字段、重复 ID、继承目标不存在均视为注册错误，不允许半成品进入菜单。

### 3.4 内置 CSS 在构建期生成

由 Vite 配置读取 `themes.json`，调用与运行时相同的纯函数生成内置主题 CSS，并通过 `transformIndexHtml` 注入 `<head>`：

- 开发服务器与生产构建走同一生成器；
- 首屏不需要等待前端模块执行；
- 不新增构建依赖；
- 不把生成文件提交进 `src/` 或手改 `dist/`。

`index.html` 的旧主题防闪映射也由同一份数据生成注入，删除手写副本。未知插件主题在插件注册完成前先回退到默认内置主题，注册完成后再恢复用户选择。

## 4. 数据格式

### 4.1 根结构

```json
{
  "schemaVersion": 1,
  "uiThemes": [],
  "codeThemes": [],
  "iconThemes": [],
  "legacyThemes": {},
  "themeCodeStyleFallback": {}
}
```

### 4.2 界面主题

```json
{
  "id": "dark",
  "name": "深色",
  "extends": null,
  "colorScheme": "dark",
  "bg": "#1e1f22",
  "accent": "#548af7",
  "defaultCodeStyle": "jetbrains-dark",
  "vars": {
    "--bg": "#1e1f22",
    "--panel": "#2b2d30",
    "--text": "#bcbec4",
    "--accent": "#548af7"
  }
}
```

约束：

- `id` 使用现有正则 `^[a-z0-9][a-z0-9-]{0,63}$`。
- `bg`、`accent` 使用六位十六进制颜色；`bg` 供原生窗口背景解析，必须与最终 `--bg` 一致。
- `colorScheme` 只能是 `dark` / `light`；缺省继承父主题，显式允许跨明暗模式继承。
- `vars` 的值是字符串，按 CSS 自定义属性原样验证，不在这里执行任意表达式。
- `group`（base / plugin）与来源信息由注册表补充，作者不能在数据里伪造内置身份。

### 4.3 代码主题

```json
{
  "id": "jetbrains-dark",
  "name": "IDEA Dark",
  "group": "dark",
  "extends": null,
  "vars": {
    "--editor-bg": "#1e1f22",
    "--editor-text": "#bcbec4",
    "--syn-keyword": "#cf8e6d"
  }
}
```

约束：

- 必须提供现有 25 项代码变量的最终值；可通过继承满足。
- 不允许覆盖 `--bg`、`--panel`、`--text`、`--accent` 等界面变量。
- `group` 只用于菜单分组，不限制用户自由组合。
- 现有 9 套主题的 ID 与显示名保持不变。

### 4.4 图标主题

```json
{
  "id": "opensource",
  "name": "开源图标集（vscode-icons）",
  "extends": null,
  "mode": "opensource"
}
```

内置声明只保存模式；具体 SVG 仍由 `fileicons.js` / `fileicons-os.js` 的现有资产链提供，不复制进 JSON。插件可提交内联 SVG，必须沿用现有 SVG 校验与实例内 ID 隔离，避免 `url(#id)` 跨图标串色。

### 4.5 旧主题迁移

```json
{
  "darcula": {"theme": "dark", "codeStyle": "darcula"},
  "idea-dark": {"theme": "dark", "codeStyle": "jetbrains-dark"},
  "night": {"theme": "dark", "codeStyle": "tokyo-night"}
}
```

正式迁移、启动防闪和测试都读取这一份映射。用户已显式选择 `codeStyle` 时仍只迁移界面主题，不覆盖代码主题。

## 5. 运行时设计

### 5.1 模块职责

| 模块 | 职责 |
| --- | --- |
| `frontend/src/core/themes.json` | 内置主题声明、迁移映射、默认关系 |
| `frontend/src/core/theme-model.js` | 纯函数：校验、继承展开、CSS 生成、变量目录；加 `// @ts-check` |
| `frontend/src/core/theme-registry.js` | 注册表、插件来源、样式节点、订阅通知、卸载与回退 |
| `frontend/vite.config.js` | 用同一模型生成内置首屏 CSS 与启动迁移数据 |
| `frontend/src/settings/settings-ui.js` | 只消费注册表，不再维护内置主题数组 |
| `frontend/src/main.js` | 组合根接线与持久化，不新增主题业务实现 |

注册表提供读取快照与订阅能力：

- `listUiThemes()` / `listCodeThemes()` / `listIconThemes()`；
- `getUiTheme(id)` / `getCodeStyle(id)`；
- `register(spec, source)` / `removeSource(pluginId)`；
- `subscribe(listener)`；
- `ensureApplied()`：当前选择不存在时回退并返回需要持久化的变更。

### 5.2 CSS 生成规则

- 界面：`html[data-theme="<id>"]`，输出 `color-scheme` 与合并后的变量。
- 代码：保持现有 `html[data-theme][data-code-style="<id>"]` 特异性，避免改变优先级。
- `auto` 仍通过不写 `data-code-style` 实现，不生成特殊 auto 块。
- 每个插件主题使用独立 `<style>` 节点，节点记录 `pluginId` 与主题类型，卸载按来源精确删除。
- 内置主题 CSS 与插件 CSS 使用同一编译函数，避免“内置一套、插件另一套”。

### 5.3 设置与 AI 动作

- `settings.theme`、`settings.codeStyle`、图标主题 ID 的存储格式不变。
- `setTheme`、`setCodeStyle` 和图标切换统一通过注册表校验。
- `main.js` 的 `SETTING_RULES` 不再把代码主题值数组固定为启动时清单；主题类校验委托注册表，AI 返回的可用值也动态生成。
- 菜单和设置下拉订阅注册表；插件加载完成后刷新，不再读静态 `CODE_STYLES`。
- `get_state` 与 `app_control` 的描述可区分配置通道，但动作名 `set_theme` / `set_setting` 不变。

## 6. 插件 API

### 6.1 界面主题

现有 `cadt.addTheme()` 升级为接受结构化 `vars`，继续支持可选 `css` 作为高级扩展：

```js
cadt.addTheme({
    id: 'violet-night',
    name: '紫夜',
    extends: 'dark',
    colorScheme: 'dark',
    bg: '#241f31',
    accent: '#c58af9',
    defaultCodeStyle: 'jetbrains-dark',
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

`css` 只用于变量无法表达的特殊组件样式；内置主题不得使用该逃生口。插件已拥有页面执行权限，因此不把 `css` 当作安全边界，但文档必须明确它会影响整个应用页面。

### 6.2 代码主题

新增 `cadt.addCodeTheme()`：

```js
cadt.addCodeTheme({
    id: 'violet-code',
    name: '紫夜代码',
    extends: 'jetbrains-dark',
    group: 'dark',
    vars: {
        '--editor-bg': '#241f31',
        '--syn-keyword': '#c58af9',
        '--syn-string': '#9ece6a'
    }
});
```

注册成功后自动进入代码主题菜单与设置页；禁止通过该 API 改界面变量。

### 6.3 图标主题

沿用 `cadt.registerIconTheme()`，补齐宿主接线、动态设置选项和卸载清理。API 形状不扩大。

### 6.4 错误与冲突

- ID 在各自通道内唯一；不同通道允许同名。
- 插件不得注册 `group: 'base'` 或覆盖内置 ID。
- 重复 ID、坏变量、循环继承、缺失父主题均拒绝整项注册。
- 错误信息带插件名、主题 ID 和具体原因，并纳入现有插件加载错误清单。
- 注册采用“先校验、再生成、最后挂载”；失败不留下样式节点或菜单项。

## 7. 生命周期与持久化

### 7.1 插件加载

1. 进入重载时按 `pluginId` 移除旧主题、代码主题、图标主题及样式节点。
2. 清空旧注册项后再执行插件代码。
3. 插件注册完成后刷新菜单、设置页和图标下拉。
4. 所有插件完成后统一执行一次 `ensureApplied()`。
5. 若当前主题已不存在，回退到该通道默认值；需要改设置时走现有 `applySettings()` 落盘与广播。
6. 若当前主题仍存在，只刷新样式与元数据，不改用户选择。

不得在清空阶段立即回退并广播，否则每次重载都会造成跨窗口设置抖动。

### 7.2 卸载、禁用与加载失败

- 卸载当前正在使用的插件主题时，回退到默认内置主题并持久化。
- 仅卸载非当前主题时，不修改设置。
- 插件加载失败时，该插件本轮注册主题全部失效；不能保留上一轮样式。
- 多窗口各自加载插件；设置广播只传主题 ID，不传 CSS 或插件对象。

### 7.3 并发重载

`loadPlugins()` 用 Promise 队列严格串行。每次请求按调用顺序执行，前一次完成后才清理并挂载后一次结果；队列失败不会阻断后续刷新。这样无需依赖 generation 比较，也不会出现旧请求晚到覆盖新状态。

## 8. 启动与首屏

1. `index.html` 在读取 `datalens-settings` 前先拿到生成的内置迁移表。
2. 旧主题 ID 迁移为深色 / 浅色，未知 ID 暂用默认内置主题。
3. Vite 注入的内置主题 CSS 在首屏前可用。
4. 前端模块应用内置设置，再异步加载插件。
5. 插件主题注册后，注册表恢复 `settings.theme` 的原值并应用样式。
6. 原生窗口背景在最终主题确定后重新同步一次。

这样冷启动不会把已安装插件主题误判为坏设置，也不会在插件样式尚未存在时显示插件 ID 的空壳状态。

## 9. 迁移步骤

### 阶段 A：建立模型，内置行为不变

1. 提取 `theme-model.js` 与 `themes.json`，迁入 2 套界面主题、9 套代码主题、旧主题迁移表和 auto 回落关系。
2. 从 `style.css` 删除对应变量块，改由 Vite 生成注入；保留组件特例并逐条核对。
3. 让菜单、设置页、AI 校验和 `applyTheme` 改读统一注册表。
4. 删除 `main.js` 的内置 `themes` 与 `code-styles.js` 的色板职责；保留迁移期适配导出，直至调用点全部迁完。
5. 增加快照对比测试，确保生成 CSS 与迁移前计算样式一致。

### 阶段 B：修复并统一插件生命周期

1. 新增主题注册表，改造 `addTheme` 使用结构化模型。
2. 修复重载残留、ID 冲突和当前主题回退。
3. 补齐 `addCodeTheme` 与动态白名单、菜单、设置选项。
4. 补齐图标主题宿主接线、重载清理和动态选项。
5. 串行化插件重载，移除晚到结果覆盖新状态的可能。

### 阶段 C：文档、示例与收尾

1. 更新 `docs/plugins/README.md`，给出继承式界面主题与代码主题示例。
2. 在 `docs/plugins/examples/` 增加一个纯配色示例插件。
3. 更新 `docs/repo-layout.md` 的主题模块职责。
4. 用户可见变化写入 `CHANGELOG.md`；若 README 有主题说明，同步更新。
5. 全部验收通过后，把本文从 `unfinished-plans/` 移入 `finished-plans/`。

## 10. 测试计划

### 10.1 纯逻辑测试

新增 `frontend/test/core/theme-model.test.mjs`，并登记进 `npm test` 的 `test:ui-core`：

- 2 套界面主题、9 套代码主题、3 套内置图标声明数量与 ID 稳定；
- 所有内置主题可完整展开，无缺变量、无循环继承；
- 插件继承只写差异项时，结果与完整声明一致；
- 未知变量、非法 ID、非法颜色、跨类型继承、循环继承均拒绝；
- 代码主题不能覆盖界面变量；
- CSS 选择器与现有特异性一致；
- 9 条旧主题迁移与显式 `codeStyle` 保留规则不变；
- `bg` 与最终 `--bg` 一致。

### 10.2 注册表与接线测试

新增 `frontend/test/shell/theme-registry.test.mjs`，登记进 `test:ui-shell`：

- 注册 / 卸载 / 禁用 / 失败后无残留样式和菜单项；
- 重复重载同一插件主题不报冲突；
- 卸载当前主题回退并只生成一次持久化请求；
- 非当前主题卸载不改设置；
- 旧世代异步结果不能覆盖新世代；
- 界面、代码、图标三类订阅方都收到刷新通知。

改造现有 `frontend/test/settings/code-styles.test.mjs`：从静态扫描 `style.css` 改为校验统一模型与生成 CSS；旧主题迁移断言保留。

### 10.3 构建与静态护栏

- `npm run typecheck`：新增核心纯逻辑文件开启 `// @ts-check`。
- `npm test`：全量前端测试。
- `npm run build`：验证 Vite 在开发与生产两种模式下都注入内置主题 CSS。
- 增加静态断言：`style.css` 不再出现内置 `data-code-style` 色板块；`index.html` 不再手写旧主题迁移表。
- 不新增 Go 绑定；若实现范围意外变化，必须运行 `go test -run TestAppBindingBaseline .` 并重跑绑定类型生成器检查。

### 10.4 手动验收

1. 冷启动分别选深色、浅色、旧版迁移主题、插件主题，无错误底色闪现。
2. 深色 UI 分别搭配浅色 / 深色代码主题，编辑器与界面按预期独立切换。
3. 打开设置页与主题菜单，三类主题选项一致，刷新插件后无重复项。
4. 安装主题插件后立即切换；禁用、卸载、重新启用当前主题，均正确回退或恢复。
5. 连续刷新插件多次，主题不丢失、不重复、不出现加载错误。
6. 打开两个窗口，在一个窗口切主题，另一个窗口同步；卸载主题后两窗均回退。
7. 分别检查文件树、编辑器、Markdown 预览、图表、终端和原生窗口背景。
8. 用一个坏主题插件验证变量拼错、继承缺失和 ID 冲突都有明确错误，且应用继续可用。

## 11. 验收标准

- 内置主题声明只存在于 `themes.json`，不存在第二份内置色板或迁移表。
- 迁移前后 2 套界面主题、9 套代码主题的视觉计算样式一致。
- 插件可注册界面主题和代码主题；图标主题插件链路可用。
- 同一插件无限次重载不累积样式、不产生重复菜单项、不撞自身 ID。
- 卸载正在使用的主题后，设置、DOM、原生窗口背景和其他窗口全部回退到默认内置主题。
- 主题相关纯逻辑、生命周期、构建和手动验收全部通过。

## 12. 风险与回退

| 风险 | 控制方式 |
| --- | --- |
| 提取变量时漏项导致局部颜色失控 | 先建立变量目录与快照对比，逐块迁移；组件特例不自动删除 |
| 构建期注入与运行时生成不一致 | 两者调用同一纯函数，测试直接比对输出 |
| 插件主题冷启动短暂回退 | 启动先应用内置回退，插件加载完成后恢复原选择 |
| 动态代码主题扩大 UI 变量覆盖 | 代码变量独立白名单，注册与测试双重拒绝 |
| 重载引发跨窗口设置广播风暴 | 清理阶段不广播，全部加载完成后只回退一次 |
| 插件 CSS 影响范围过大 | 文档明确高级 `css` 的风险；结构化主题为默认推荐写法 |
| 图标资产迁移破坏现有 SVG 渐变 | 首版只迁声明与映射，保留资产加载和实例 ID 隔离逻辑 |

## 13. 实施记录（2026-11-24）

### 已完成

- 新增 `core/themes.json`（588 行）、`core/theme-model.js`、`core/theme-registry.js`；2 套界面主题、9 套代码主题、3 套内置图标声明与迁移表已统一。
- Vite 构建期注入内置主题 CSS 与启动迁移数据；`style.css` 移除 525 行主题色板，只保留组件规则。
- 设置页、主题菜单、快速切换、AI `set_theme` / `set_setting` 与 `get_state` 已改读动态注册表；新增 `iconTheme` 设置项。
- 插件 `addTheme` 升级为结构化继承，新增 `addCodeTheme`，补齐 `registerIconTheme`；重载串行、失败回滚、卸载回退与图标即时刷新已实现。
- 新增主题模型、注册表、文件图标测试并登记 `npm test`；更新插件指南、`theme-pack` 示例、README、CHANGELOG 与 repo-layout。
- `npm run typecheck`、`npm test`（全量）、`npm run build` 通过。
- 用脚本对比迁移前后全部主题变量：2 套 UI + 9 套代码主题逐项一致。
- 独立浏览器验收页确认：插件界面 / 代码 / 图标主题同时注册，继承色值与编辑器底色正确；卸载后注册数与插件样式节点归零。
- 生产预览确认：启动注入生效，浅色首屏 `--bg = #ffffff`、`color-scheme = light`，代码主题下拉包含 9 套内置主题。

### 启动阻塞修复与真实界面验收

原阻塞项已按最小改动修复，并加入 `frontend/test/core/startup-order.test.mjs`：

1. `syncedOpenMode` 快照改为 `setSyncedOpenMode()` 显式 setter，消除常量赋值。
2. `pluginImporter` 对 `openVirtualDoc` 使用惰性包装，消除 bridgeUI 解构前 TDZ。
3. Vite 将 `highlight.js/lib/common` 固定映射到官方 `es/common.js`，开发扫描与运行均正常。

真实应用界面（Vite dev + mock 后端）验收结果：

- 启动无异常，设置页可正常打开。
- 实际点击切换内置浅色主题、GitHub Light 代码主题、mono 图标主题，DOM、计算样式与 localStorage 一致。
- mock 插件主题“演示主题”可实际点击切换，`--bg = #241f31`，插件样式节点正确挂载。
- 动态注册插件代码主题与图标主题后，设置页立即出现新选项；实际选择后编辑器底色 / token 与文件图标 SVG 正确更新。
- 模拟禁用全部插件后，界面 / 代码 / 图标三类当前主题一起回退为 dark / auto / opensource， localStorage 同步更新，插件样式节点归零。
- 冷启动保留 `plugin-demo` 选择，插件加载完成后恢复为 `--bg = #241f31`，无启动错误。
- 通过 mock `settings-changed` 事件验证跨窗口接收路径：主题、代码主题、图标主题快照均合并、重绘并持久化。
- `npm run typecheck`、`npm test`、`npm run build` 全部通过。

回退时可按阶段独立撤销：先恢复静态设置消费，再移除 Vite 注入，最后恢复 `style.css` 主题块。每个阶段单独提交，确保不需要整体回滚插件系统。
