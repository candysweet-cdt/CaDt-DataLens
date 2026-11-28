# CaDt 插件宿主扩展（P0）：技能注册与文本资产读取（方案）

> 状态：**已实施**（2026-11-28；`registerSkill` / `readTextAsset` 已落地，见 `frontend/src/shell/plugin-skills.js`、`plugin-text-asset.js` 与 `plugins.js` 的 apiFor；测试见 `plugin-skills.test.mjs` / `plugin-text-asset.test.mjs` / `ai-plugin-skills.test.mjs`）。本文保留为设计存档。
> 目标：补齐插件作为「能力供给方」最缺的两个通用接口——`registerSkill`（插件声明可被 `/技能名` 调用的技能）、`readTextAsset`（读随包文本资产）。两者都不绑定具体业务：写作插件只是**首个验证场景**（v8 类插件移植后要能直接 `/webnovel-write 63`），翻译、批注、数据分析类插件同样受益。
> 定位：本文是 `plugin-platform-extension-catalog.md` 里 P0 各项的详细设计，不替代那份平台总览。
> **子代理侧已迁出**：子代理能力/权限体系独立成文 → `docs/finished-plans/subagent-capabilities-redesign.md`（§3.3 只留指针）。
> 结论先行：**不需要重做 Agent 平台**。宿主已有 DI、五模式钩子、Agent Preset/作用域、三协议 LLM、工具链与技能斜杠调用；本方案补两个缺口：①插件技能注册；②插件资产文本读取。
>
> **评审补正（2026-11-28，第二次代码核对）**：实施前必须以本节为准——
> ① `readAsset` 并非「只读图片」：Go 侧白名单已含文本扩展名，缺的是 API 形状（§1.2-2）；
> ② 技能 rank / 缓存失效 / `content` 求值方式三处口径（§3.1）。行号以符号名为准，正文标注的是核对时快照。

## 1. 背景与现状（代码事实，2026-11-28 核实）

### 1.1 已有能力（无需重做）

- **斜杠技能调用**：`frontend/src/ai/chat/ai-slash.js` 已实现 `/技能名` 与 `/技能名 参数`。`slashSkillInvocation` 会把技能作为附件注入本轮，参数作为用户消息发送；`handleSlashText` 对固定命令以外的 token 走技能发现。
- **技能发现**：`frontend/src/ai/ai-panel.js:7733` `resolveSkillDirs` 扫描工作区 `.cadt/skills`、`.agents/skills`、应用数据 `ai-skills`、用户 `~/.agents/skills` 与内置目录；`:7863` `listSkillsRaw` 读取并解析 `SKILL.md` front matter，`:7935` 起按 rank 去重。
- **Agent 循环**：`frontend/src/ai/ai-panel.js` 的 `executeTool`（快照 `:10853`）→ `startRound`（`:13856`）→ `handleToolRound`（`:14479`）→ 工具结果回灌 → 续轮。行号会随文件增长漂移，实施时按符号名定位。
- **平台原语**：`frontend/src/shell/plugins.js:299` 起已有 `provide/require/inject/effect` 与五模式钩子；`ai-agent-preset.js` 已有 Preset 与 agent scope 纯函数。
- **插件生命周期**：`frontend/src/shell/plugins.js:395` `reloadPlugins` 在换代前先 dispose 容器与总线，再 `clear*` 各注册表；插件注册项随禁用/重载整体撤销。
- **插件工具**：`plugins.js:207` `registerTool`，工具默认关闭，须用户在「设置 → AI → 权限 → 插件工具」逐层授权。

### 1.2 现状缺口

1. **插件不能注册技能**：`plugins.js:126` `apiFor` 没有 `registerSkill`；`listSkillsRaw` 只读文件系统目录，不合并插件内存注册表。因此 `/webnovel-write` 无法作为插件技能出现。
2. **缺文本资产读取出口（不是通路）**：`plugins.js:369` 的注释与 JS 实现面向图片 data URL，但 Go 侧白名单其实已含文本/数据扩展名——`internal/plugins/plugins.go:71-84`（`.md .txt .json .js .mjs .csv .yaml/.yml`），`ReadPluginAsset`（`:278`）返回 data URL、数据类上限 48 MB。也就是说插件**今天就能**读 `SKILL.md`，代价是自己剥 `data:…;base64,`、base64 解码、判 UTF-8、自己兜大小。缺的是**统一入口与文本级闸门**，不是文件通路。脚本类资产（`.py / .sh / .ps1`）确实不在白名单。

（原有第三条「子代理写文件工具受限」已迁出：子代理能力/权限体系归 `subagent-capabilities-redesign.md`，本文不再涉及，见 §3.3。）

### 1.3 首个验证场景：v8 侧需要适配（不属于本方案宿主改造范围）

- v8 的 TypeScript / Cordis `apply(ctx)` 需映射到 CaDt 的 `cadt.*`。
- 12 个技能改为 CaDt `SKILL.md` 内容，通过新 API 注册。
- `ctx.userQuestions.ask` 映射到 CaDt 的 `ask_user` 工具或主代理裁决。
- 书房/图谱用 `registerViewer`；行内改写依赖宿主遗留的 `aiComplete` 桥，本方案不做。

## 2. 目标与非目标

### 目标

- 新增 `cadt.registerSkill(spec)`，让插件声明式注册可被 `/技能名` 调用的技能。
- 新增 `cadt.readTextAsset(path)`，让插件读取随包文本资产（技能、脚本、模板）。
- 保持现有文件系统技能、斜杠命令与插件工具授权语义不回归。
- （子代理侧不在本文：归 `subagent-capabilities-redesign.md`。）

### 非目标

- 不把 v8 业务代码内置进 CaDt。
- 不原样兼容 DSH npm 包 / Cordis TypeScript 模块。
- 不实现编辑器行内 AI 改写（宿主遗留项，另案）。
- 不改变主会话的文件写入审批链。

## 3. 宿主改造清单

### 3.1 P0：插件技能注册 `cadt.registerSkill(spec)`

#### API 草案

```js
cadt.registerSkill({
  name: 'webnovel-write',
  description: '执行完整写章流程',
  content: () => cadt.readTextAsset('skills/webnovel-write/SKILL.md'),
  // 可选：按工作区/会话条件决定是否暴露
  when: (ctx) => !!ctx.workspace,
});
```

约束：

- `name` 必填，沿用现有斜杠技能名规则（小写字母/数字/连字符；允许 `webnovel-write`）。
- `description` 必填，用于补全副行与技能管理。
- `content` 必填，返回 `string` 或 `Promise<string>`；宿主在扫描/调用时读取，**不在插件 `apply` 阶段预加载全部正文**（避免 5 秒加载上限）。求值口径：`listSkillsRaw` 会把 `content` 一起放进缓存（`ai-panel.js:7920-7931` 组装候选、`:7943` 原样进 list），所以 ① 同步返回值是首选；② 必须支持 async 时**并发读取 + 单点超时**（≤1 s/技能），不能串行 await——否则 12 个技能会把一次扫描拖成 12 个往返；③ 单技能正文 >64 KiB 直接截断并在 `description` 尾部标「（已截断）」，不要撑爆缓存与提示词。
- `when(ctx)` 可选，同步返回布尔；`ctx` 至少含 `{workspace, sessionId}`。条件不满足时不出现在补全、技能管理与 `skill_use`。**实现直接复用 `shell/plugin-ctx.js` 的 `pluginCtxBase()`**（`{plugin, workspace, sessionId, origin}` 恒存在，`origin` 取 `'prompt'` 或新增一档 `'skill'`），不要另拼一个 ctx——基座已经在 8 个入口生效，见 `plugin-platform-extension-catalog.md` §5.2。
- 单插件 ≤ 64 个技能；单技能正文 ≤ 64 KiB（与现有文件技能读取上限一致）。
- 注册返回撤销函数；插件禁用/重载由宿主按 owner 整体撤销。
- **rank 必须显式落一个数**：`AI_SKILL_RANKS`（`ai-panel.js:7709`）现为 workspace 100 / workspace-agents 200 / app 400 / user-agents 500 / builtin 600，新增 `plugin: 300`——即「工作区技能优先，其次插件技能，再次应用/用户/内置」；插件之间同 rank 按注册顺序先到先得。不能只写「放在工作区之后」让实现自己猜。避免插件静默覆盖作者自带技能。

#### 代码落点

1. 新建 `frontend/src/shell/plugin-skills.js`（纯逻辑注册表，参考 `plugin-context.js`）：
   - `registerPluginSkill(pluginId, pluginName, spec)`
   - `getPluginSkills(runtimeCtx)`（求值 `when`、读取 content、归一化）
   - `clearPluginSkills()`
   - 上限校验、重名检测、错误隔离。
2. `frontend/src/shell/plugins.js`：
   - import 新注册表；
   - `apiFor` 新增 `registerSkill`（`:126` 起的 API 对象）；
   - `reloadPlugins` 新增 `clearPluginSkills()`（`:404` 起的 clear 区）；
   - 导出 `getPluginSkillList()` 供 AI 面板消费。
3. `frontend/src/ai/ai-panel.js`：
   - `listSkillsRaw`（`:7863`）在文件系统 candidates 之后合并插件技能（插件技能 `path` 为空、`source: 'plugin'`、`rank: AI_SKILL_RANKS.plugin`、`rootOrder/localOrder` 按注册顺序）；
   - `skillSourceLabel`（`:7853`）新增 `plugin` → 「插件」；
   - **缓存失效走 `invalidateSkillsCache()`（`:7961`）**，不要写「各根 `at = 0`」：后者只清面板桶，斜杠模块自己的 5 秒缓存（`ai-slash.js` 的 `skillsCache`）要靠 `invalidateSkillsCache` 里的 `slashSkillsInvalidate` 一起清，否则补全要等 TTL 过期，「立即失效」的验收项会飘；
   - 订阅 `cadt-plugins-loaded`（`plugins.js:383` 广播，面板 `:1472` 已有监听点，可在同一处顺手调用）。
4. `frontend/src/ai/chat/ai-slash.js`：**无需改**——`addAttachment` 对内置技能已用 `path: ''`（`ai-slash.js` 的 `invokeSkillItem`），插件技能同形。
5. `frontend/src/settings/ai-manage-dialogs.js`：技能管理列表自动显示插件技能；如需「禁用/隐藏」沿用现有 `disabledSkills/hiddenSkills`，按名字生效。
6. **模型可见的 API 清单要同步两处**：`frontend/src/ai/core/ai-constants.js` 的 plugin-creator 技能正文（`:589-598`，模型唯一的 `cadt.*` 清单）+ `docs/plugins/README.md`（现有 28 节，新增 API 各占一节）。只改 README 等于没告诉模型。

#### 验收

- 安装测试插件并注册 `demo-write` 后，输入 `/demo-write 63` 立即发起一轮，附件含技能正文，用户消息为 `63`。
- 禁用插件后**立即**失效（`invalidateSkillsCache()` 同步清面板与斜杠两处缓存，不等 5 秒 TTL）——补全与 `skill_use` 均不再返回该技能。
- 工作区存在同名技能时不被插件覆盖。
- 插件 `content()` 抛错只跳过该技能，不阻断其他技能与对话。

### 3.2 P0：插件文本资产读取 `cadt.readTextAsset(path)`

#### API 草案

```js
const text = await cadt.readTextAsset('skills/webnovel-write/SKILL.md');
```

约束：

- 只读插件目录内文本资产；路径相对插件目录，禁止 `..` 穿越与绝对路径（安全边界由 Go 侧 `ReadPluginAsset` 的逐段校验 + `EvalSymlinks` 越界判定兜底，`internal/plugins/plugins.go:283-331`）。
- **扩展名白名单以 Go 侧为准**，不是「任意文本」：当前 `pluginDataAssetMimeTypes`（`plugins.go:71-84`）覆盖 `.md .txt .json .js .mjs .csv .yaml/.yml`。写作插件的 `.md` 技能与 `.js` 脚本够用；若要读 `.py / .sh / .ps1`，先在那张表里加两行（`text/x-python`、`text/x-shellscript` 一类）并补 `plugins_asset_test.go` 一例，不要在前端另开一条读通道。
- UTF-8 解码；上限 1 MiB（脚本/技能够用，超过明确报错）——这是**前端文本级闸门**，与 Go 侧 48 MB 的数据资产上限是两个概念。
- 返回 `Promise<string>`；不存在/越界/超限/二进制抛错。
- 与现有 `readAsset`（返回 data URL）并存，不改变旧语义。

#### 代码落点

**结论：纯前端实现，零 Go 改动、零新增 Wails 绑定。**

1. 新建 `frontend/src/shell/plugin-text-asset.js`（纯函数，可单测）：
   - `decodeDataUrl(dataUrl)` → `{mime, base64}`，格式不符抛错；
   - `dataUrlToText(dataUrl, maxBytes)` → 解码 + UTF-8 校验（用 `TextDecoder('utf-8', {fatal: true})`，非 UTF-8 明确报「不是 UTF-8 文本」而不是给一串乱码）+ 大小闸；
   - Base64 解码不要用 `atob` 手搓：`atob` 给的是 Latin-1 字符串，直接当文本用会让中文全变乱码——要么 `Uint8Array` + `TextDecoder`，要么沿用仓库已有的解码工具（写之前先查 `docs/core-capabilities.md`，不要重造）。
2. `frontend/src/shell/plugins.js` `apiFor` 新增 `readTextAsset(path)`：`host.readPluginAsset(plugin.id, path)` → `dataUrlToText(...)`。**不碰 `host` 结构、不加新 hook**——现有 hook 已够。
3. 唯一可能需要动 Go 的地方是扩展名白名单（见上），且只加常量行 + 测试，不新增绑定面。
4. 文档：`docs/plugins/README.md` 新增「读取文本资产」一节；`ai-constants.js` 的 plugin-creator 清单里 `readAsset` 那行补一句分工（图片走 `readAsset`，文本走 `readTextAsset`）。

#### 验收

- 能读取插件内 `SKILL.md` 与 `.js` 脚本文本；读取图片仍走原 `readAsset`。
- `../`、绝对路径、符号链接越界、非白名单扩展名、>1 MiB、非 UTF-8 五类输入均被拒绝，且错误信息说清是哪一类。
- 读取失败不影响插件其他注册项。

### 3.3 子代理受控写：**已迁出本文**

子代理能力/权限体系已独立成文：**`docs/finished-plans/subagent-capabilities-redesign.md`**（对齐 DSH 的能力快照模型，含编排 owns 阶段零、审批语义、Go 侧 symlink 防线、v2 快照等）。本文 §3.3 原有的「设计约束清单」与该文档重复，已删除以免两处真源；涉及 `subToolsForScope` / `applyWorkspaceWrite` / `ai-tool-defs.js` / `ai-agent-resume.js` / `orchestration-ui.js` 的改动全部归那份文档。

插件侧唯一相关的接口面是 `cadt.registerAgentPreset`（插件声明 drafting / review 等角色），**由 redesign 文档 §4 定义**，不在本文范围内。

## 4. 推荐实施顺序

1. **阶段一（0.5–1 人日）**：`readTextAsset`（纯前端解码 + 可选 Go 白名单补行；无 AI 行为变化）。
2. **阶段二（1–2 人日）**：`registerSkill` + AI 面板合并 + `invalidateSkillsCache` + 模型可见清单 + 测试。
3. **阶段三（0.5 人日）**：文档、示例插件、端到端验收。

合计 **2–3.5 人日**；不触及 Go agent loop，不改 `internal/aichat`，不重做平台原语。（子代理侧改动不在本文，见 `subagent-capabilities-redesign.md`。）

## 5. 测试与验证

### 单元测试

- `frontend/test/shell/plugin-skills.test.mjs`：注册/撤销/上限/重名/条件/内容错误隔离/async 超时。
- `frontend/test/shell/plugin-text-asset.test.mjs`：data URL 解码、UTF-8 校验、1 MiB 闸、非白名单扩展名、乱码拒绝。
- `frontend/test/ai/ai-plugin-skills.test.mjs`：文件技能与插件技能合并、rank 300、缓存失效（含斜杠模块）、斜杠调用附件。
- 新测试要**同时**登记进 `frontend/package.json` 的 `test:ai` / `test:ui-shell` 子脚本——`frontend/test/core/test-manifest.test.mjs` 是那条「漏登记就永远不会跑」的双向守卫，登记本身在 package.json，不是往这个守卫文件里加东西。

### 端到端

1. 写一个最小测试插件：注册 `demo-write` 技能与一个只读工具。
2. 安装启用后，在 AI 面板输入 `/demo-write 63`，确认技能附件与参数正确发送。
3. 禁用插件，确认技能与工具同时消失，缓存不残留。
4. 回归现有 `/skill`、文件系统技能、spawn/wait/send、审批链。

### 构建

- `npm run typecheck`（或仓库现行前端检查命令）
- `npm test`（禁止用 grep/tail 管道吞退出码）
- `npm run build`
- 如新增 Go 绑定：`go test -run TestAppBindingBaseline .` 并更新基线；本方案优先不新增绑定。

## 6. 风险与边界

- **提示词注入**：插件技能正文与现有文件技能一样属于附件数据；宿主不得把插件文本当系统指令执行。
- **重名冲突**：必须固定 rank 与诊断，不能静默覆盖作者技能。
- **加载时限**：插件 `apply` 只有 5 秒，技能正文必须惰性读取，不能在加载时批量拉取。
- **体积约束**：不引入新依赖，纯 JS 注册表 + 现有文件读取通道即可。

## 7. 交付物

- 宿主代码：`shell/plugin-skills.js`、`shell/plugin-text-asset.js`、`shell/plugins.js`、`ai/ai-panel.js`；（可选）`internal/plugins/plugins.go` 白名单两行 + 资产测试。
- 文档：`docs/plugins/README.md` 新增两节 API 说明；**`frontend/src/ai/core/ai-constants.js` 的 plugin-creator 技能正文同步**（模型唯一的 `cadt.*` 清单）。
- 测试：上述三组单测 + 一个最小示例插件（并在 `package.json` 的 test 子脚本登记）。
- 验收报告：端到端步骤结果与回归清单。
