# AGENTS.md

## 项目概述
CaDt-DataLens 是一个面向 Windows 的轻量级多格式数据查看与编辑器（JSON/JSONL、YAML、XML/SVG、CSV/TSV、TOML、INI/Properties、Markdown、代码文本、图片、二进制）。

技术栈：Go 后端 + Wails v3（一进程原生多窗口 + Windows WebView2）+ 原生 JS 前端（Vite 构建，Ace / jsoneditor / markdown-it / highlight.js）。

设计目标：**单 exe、零依赖、系统提供引擎**——不自带 Chromium、不打包 Node、不做项目索引。许可证 Apache-2.0。

## 目录结构
> 逐文件/逐包的职责、沿革与暗约束见 `docs/repo-layout.md`（按需读取，不随每轮上下文注入）；认知索引开启时可直接 `cognition_read` 按路径 / 标签 / 关键词查条目。以下只列顶层地图与最关键的结构性约束。

- **根目录是扁平 Go 包 `main`**，没有顶层 `src/`。**`package main` 只能在仓库根**：`//go:embed all:frontend/dist` 以根目录为前提，`type App` 与全部 Wails 绑定方法必须留在根；根目录靠**文件名前缀 + 同包拆文件**分类。纯引擎下沉 `internal/<域>`（不 import main、不碰 App，外部动作经 `Deps` 钩子注入，根壳留 `*_app.go` 挂名绑定）；**平台 glue（`*_windows/_other` 成对文件）留在根**，不摊进 internal。
- `internal/`：可下沉的纯引擎包（AI、存储、检索、终端、补丁、沙箱等各域），逐包职责见 `docs/repo-layout.md`。
- `frontend/`：原生 JS 前端（Vite 构建，Ace / jsoneditor / markdown-it / highlight.js）。`src/` 顶层只留 `main.js`（组合根），其余按域进 `core/` `editor/` `ai/` `shell/` `settings/` `bridge/` `terminal/` `explorer/` `reading/` `writing/` 等目录——新增模块放进对应域目录，不要往顶层加；Go 的目录即包，前端的目录只是分组。`dist/` 是 `go:embed` 产物，**不要手改**。
- `docs/`：方案存档（`finished-plans/` 已实施、`unfinished-plans/` 未开工、`reports/` 评估与复盘）、插件/技能/示例/打包文档；本目录地图见 `docs/repo-layout.md`。
- `plugins/`：随仓库分发的插件样例；`.cadt/`：本应用 AI 助手的本地状态（memory / plan / patches / logs / gen / answers）。
- `build/` + `tools/` + `scripts/`：Wails 构建资源、一键重建脚本、安装包与签名脚本、跨 harness 命令守卫。

## 约定

### 通用
- 回答使用中文；代码注明语言。
- 修改文件前先读取确认；不要改动与任务无关的内容。
- 新增依赖或改变目录结构时说明原因。
- **体积是第一约束**：任何新依赖先问「能否不引入」，体积预算为 0 的改动优先。
  - 不打包 Chromium / Node / ripgrep / SQLite / LSP。
  - **SQLite 例外（作者批准的派生索引，均不存真源数据）**：AI 会话搜索的 `ai-index.db`（2026-11-11 批准，实测整包 +3.9 MB）、AI 定时任务的 `ai-schedule.db`（2026-11-12）与 AI 使用统计的 `ai-usage.db`（2026-11-19）。三者都是纯 Go `modernc.org/sqlite`；前两者可随时删除重建（JSONL / 触发指令原文仍是真源），`ai-usage.db` 的主会话/群聊事实可从 JSONL 回填、但**子代理用量只存在这里（不可重建）**，因此它不进「一键清缓存」、只出现在数据条目里单独删除。**不要**把设置、偏好、模型配置或会话正文搬进 SQLite。
  - **可视化引擎例外（作者批准的 AI 能力扩展，预算 ≤5 MB，2026-11-13 定）**：ECharts 6（1.07 MiB）+ ELK.js 0.12（1.57 MiB）+ 词云两件（~52 KiB）放 `public/vendor/` 懒加载，合计 +2.69 MiB（逐字节实测），全部只产出静态 SVG、不持有活动实例，禁脚本边界不变；能力优先于体积仅限本次，方案见 `docs/finished-plans/visualizer.md`。**不要**拿这个例外给别的依赖开绿灯。
  - 重型前端库（mermaid 2.57 MB 是当前天花板）必须**懒加载**，参考 `main.js` 的 `ensureMermaidScript()`。
  - 明确否决过的方向见 `docs/reports/optimization-proposals.md` 第四节（换 Monaco、内置 SQLite、全项目索引、内置 LSP、打包 rg）。

### 禁止操作（硬规则）

- **禁止 `git checkout` 与 `git restore`（会写工作区的形态）**：`git checkout -- <文件>`、`git checkout <分支>`、`git restore <文件>`、`git restore --source=… `、`-W`、`-f`、缩写 `git checko` / `git rest`，以及藏在 shell 包装（`bash -c`、`cmd /c`、`pwsh -Command`）里的，一律不允许。**例外**：`git restore --staged <路径>`（只撤暂存、不碰文件内容）放行——带了 `--worktree` / `-W` 就照拦。
  - 起因：2026-11-21 一次 `git checkout -- explorer.js` 想撤掉「自己的」改动，把该文件上**多个并行会话叠加的未提交改动**一起回滚到 HEAD；wipe-guard 快照早于那次改动，恢复不回来。`git restore` 是同一动作的新名字，同样丢改动，所以一起禁。
  - 替代：切分支用 `git switch`；撤销某个 hunk 用编辑工具反向改；整文件回退先 `cp` 备份并让用户确认；只撤销暂存用 `git restore --staged <路径>` 或 `git reset HEAD -- <路径>`；整体收起用 `git stash -u`；只看旧版本用 `git show HEAD:<路径>`。
  - 实现：`tools/hooks/git-guard.mjs`（PreToolUse → 退出码 2 + stderr；Cursor 的 `beforeShellExecution` → `{"permission":"deny"}`），四份配置分别覆盖 WorkBuddy / CodeBuddy（`.workbuddy/settings.json`，另含 `permissions.deny`）、Claude Code 系（`.claude/settings.json`）、Cursor（`.cursor/hooks.json`）、ZCode（仓库根 `zcode.json`：`hooks.enabled:true` + PreToolUse `process` 型挂 node，免 shell 引号问题；**项目钩子要在 ZCode 客户端信任工作区后才注册**，未信任时日志报 `config_project_hooks_pending_trust` 且静默放行）。**新增 harness 就在它自己的配置里挂同一个脚本**（PreToolUse 事件、matcher `Bash`）。
  - 判定口径：只认**命令位置**的 `git`——`grep "git checkout"`、`git log --grep=…`、提交信息里出现这个词都不拦；`Write`/`Edit` 正文不经过这条判定。
  - 边界：护栏不是沙箱（换别名、改配置都能绕）。真正的纪律是「**未提交的改动不是可丢的东西**」：同文件多会话叠加改动时，任何整文件回退都必须先备份 + 用户确认。要再加同类命令（`reset --hard`、`clean -fd`、`stash drop`…）在脚本的 `BLOCKED_SUBCOMMANDS` 表里加一条即可，`--check` 可当场验证。
- **`.workbuddy/` 下只有 `settings.json` 可以入库**（hook / 权限规则要对所有会话生效），其余是本机状态（见 `.gitignore` 的 `.workbuddy/*` + `!.workbuddy/settings.json`）。

### 代码规模与质量红线（写码必读）

> 2026-11-14 定，源自 phase 2/3 前端拆分与历次带病提交的实测教训。行数不是目标，职责单一才是；每条红线背后都有真实事故。

**文件规模**
- 新建源码文件目标 ≤ 1500 行，**硬上限 3000 行**（Go 与前端同规）；豁免类不计上限：测试文件（`*_test.go` / `*.test.mjs`）、样式、HTML、表驱动常量（`structure.js`、`run.js`、`ai/tools/ai-tool-defs.js`、`ai/core/ai-constants.js`、`dev/mock-backend.js`）。
- 拆分信号看职责不看行数：文件里出现第二个互不相关域（靠分节注释隔开的两类功能）就必须拆，几百行也不留——「现在无痛拆」的成本远低于「将来被迫拆」。
- 存量超线文件「只减不增」：不往里加新域，改动到哪顺手收敛到哪。当前超线（2026-11-14 实测，按 3000 行口径）：前端 `ai/ai-panel.js`（1.1 万行，拆分方案另立）、`main.js`（4.4k 组合根）；Go 侧无超线。

**函数与命名**
- 函数 < 200 行，参数 ≤ 5 个，嵌套 ≤ 4 层；超限拆辅助函数。
- 新导出名先 grep 全仓防撞（`createStructurePanel` 重名教训）；文件头保留 2–3 行职责注释（现有模块惯例：`// xxx.js：...`）。

**依赖与状态**
- 依赖单向：main.js → 域模块 → 纯函数模块（formats/structure/markdown 等）；域模块之间不互相 import，跨域一律经 deps/ctx 注入或组合根接线；禁止反向 import main.js；不引入循环依赖。
- 导出可变 let 状态一律 getter 活引用，禁止值快照（splitRoot 教训）；跨模块回写走宿主 setter。

**错误处理**
- 禁止空 catch 吞错；`.catch(() => {})` 仅限尽力而为路径（事后清理/状态同步）并注明忽略原因。
- `console.assert` 不中断执行，禁止当校验用；关键不变量显式 throw。
- 用户可见错误走 flash/状态栏；诊断信息走调试日志（debug-console.jsonl），不要弹窗打断用户。

**验证与提交**
- 新增/修改纯逻辑必须配测试：Go 表驱动 `*_test.go`；前端测试统一放 `frontend/test/<域>/`（镜像 `src/<域>/`），**并登记进 `npm test` 清单**（漏登记 = 测试从未跑过）；护栏 `test/core/no-src-tests.test.mjs` 禁止 `src/` 下再出现 `*.test.mjs`。
- 提交前跑改动面的测试 + 构建；**测试/构建命令不许接 grep/tail 等管道核对结果**（会吞退出码，M3 带病提交教训），要看退出码本身。
- **`go test` 禁止前台阻塞等待**：一律丢后台执行（后台任务 / 独立终端，输出重定向到日志），前台用 `sleep` 或计时器轮询日志判断是否结束；必须显式带 `-timeout`（全量建议 `-timeout 300s`）。会拉子进程的用例（MCP 假 server / ConPTY / WebView2）一旦回归，前台阻塞会把整个会话和桌面一起拖死（2026-11-16 教训：假 server 的 `TestMain` 没随包迁移，子进程递归跑全量测试，进程树指数增长，机器黑屏）。
- 测试文件跨包迁移时，`TestMain` 与它服务的测试必须同批同包移动；子进程自调用的测试（如 MCP 假 server）靠 `TestMain` 识别运行模式，漏搬即递归启动。搬完先跑一条最小用例验证子进程模式生效，再跑全量。
- conventional commits + 中文描述（feat/fix/refactor/docs/test/chore/perf）；一次提交一个主题；重构类一批一 commit、可单独 revert；提交信息写明行为变化，提交前核对 `git show` 的 diff 与描述一致（d5ad6ac 教训）。

### Go 侧
- **根目录只有四类文件**（2026-11-24 结构化后，方案见 `docs/finished-plans/go-layout.md` §15）：① 应用核心与生命周期（`main.go` / `app_core.go` / `app_window.go` / `app_infra.go` 应用数据+日志 · `app_dialogs.go` 文件对话框 · `crashrecovery_app.go`）；② 宿主接线（`host_wails.go` 事件出口与 wailsApp 指针 · `host_wiring.go` 各引擎 deps 注入 · `embed_assets.go` 三份 `//go:embed`）；③ 窗口宿主（`window_host.go` 注册表与跨窗投递 · `window_factory.go` 建窗 · `window_geometry.go` 几何记忆 · `window_close.go` 托盘与退出 · `window_aux.go` 辅助窗与热键 · `window_aux_bindings.go` 五类辅助窗绑定 · `window_route.go` 文件路由）；④ 平台 glue（`platform_windows.go` / `platform_other.go`，5 对 Wails glue 合并）与 CLI（`convert_cli.go` / `mcp_variant*.go`）。另有 `app_field_bindings.go`（包装 App 嵌入字段的绑定壳）。**新增根文件先想清楚属于哪一类**，不属于任何一类的多半该下沉 `internal/<域>`。
- **绑定承载走「服务化嵌入」而不是逐方法壳**：`internal/<域>` 里写 `type Service struct{}`，根 `app_core.go` 用**未导出类型别名**（`type memoService = memo.Service` + `*memoService`）匿名嵌入 `App`——Go 的方法集提升让这些方法自动进 `*App`，Wails v3 的绑定面就是 `*App` 方法集（`pkg/application/bindings.go:236` 用 `ptrType.NumMethod()`），前端 FQN 仍是 `main.App.<Method>`，**前端零改动**。别名是为了绕开「同一类型只能匿名嵌入一次」（`App` 已有 `*sessionstore.Service`）。
  - **纪律**：`Service` 类型**只放确实要暴露给前端的方法**；包内其余能力保持包级函数或小写方法——每个导出方法都会变成前端可调绑定（历史事故：`Scheduler.Start`、`Manager.EnsureDir`）。服务化后把根壳文件整个删掉，`init` 注入移进 `host_wiring.go`。
  - **守卫**：`app_bindings_guard_test.go` 用反射枚举 `*App` 方法集并与 `testdata/app_bindings_baseline.txt`（当前 420 条）逐行比对，多一个少一个都红。改完绑定面**必须**跑它：`go test -run TestAppBindingBaseline .`；确属预期的变更用 `UPDATE_BINDINGS_BASELINE=1 go test -run TestAppBindingBaseline .` 更新基线，并在提交信息里写明差集。
- **`internal/` 零 Wails 依赖**（79 包一致，2026-11-24 复测 grep 命中 0）：窗口状态这类强依赖 `application.WebviewWindow` 的宿主编排留根；纯状态机用泛型参数注入窗口句柄（`internal/windowreg` 的 `State[W]` / `Registry[W]`，根传 `W = *application.WebviewWindow`）。窗口几何 key、辅助窗查找、第二实例转发计划、事件归属表都已按此下沉（`windowreg` / `windowgeom` / `secondinstance` / `eventowner`）。纯平台能力（控制台附着、异步隐藏窗口、WebView2 参数注入、系统光标）下沉 `internal/winutil`；依赖 `findWailsWindow` / Wails 内部结构的 glue 合并为根 `platform_windows.go` / `platform_other.go`（原 windowicon / devtools / screenshot / trayhost / browser）。
- 平台相关代码成对出现：`xxx_windows.go` + `xxx_other.go`（或单文件内按 build tag 分节，如 `platform_windows.go` / `platform_other.go`），不要在一个文件里堆 `runtime.GOOS` 判断。**同 build tag 的多个平台文件可以直接合并**（Go 的 build 约束是文件级的，tag 相同的文件合并后编译语义不变），前提是别把 `OpenDevTools` 这类绑定方法在桩里漏掉。
- 新增导出方法后无需生成绑定：前端经 `Call.ByName` 动态解析；**必须**在 `dev/mock-backend.js` 补同名 mock。
- **平台无关文件里不许出现 Windows 专属符号**（`syscall` 的 `HideWindow`/`CreationFlags`、`UTF16PtrFromString`、`golang.org/x/sys/windows` 等）；防黑窗统一用 `executil.HideCommandWindow`。守两道：`crossplatform_guard_test.go`（静态扫，毫秒级）+ `tools\check-crossbuild.cmd`（真编 linux/darwin，约 5 秒）。`_other.go` 桩**同样要能编译**——2026-11-17 交叉编译发现三个包从未在非 Windows 下编过（其中 `browser_other.go` 连参数重名都没人发现）。评估与分期见 `docs/reports/cross-platform.md`。
- 文件大小硬限制（`app_core.go` 的 `largeFileBytes` / `maxFileBytes` / `imagePreviewLimit`，图片 hex 上限 `app_file.go` 的 `imageHexLimit`）：>10 MB 只读、>100 MB 拒绝打开、图片预览 32 MB、二进制 hex 1 MB。放宽限制前先确认性能。

### 前端侧
- `main.js` 是组合根：改动前先按域找到对应模块（editor-groups / writing-ui / settings-ui / terminal-ui / bridge-ui / explorer-ops / structure-panel 等），不要把域逻辑回填进 main.js；新域一律新建模块（从 main.js 拆出的模块需要 deps 重写裸标识符，参考 explorer-ops 先例）。
- 域模块的约定是「factory + 显式依赖注入」：`export function createXxx(deps)`，依赖一律 `deps.X` 延迟求值，main.js 侧传 getter（`get X() { return X; }`）——不依赖声明顺序、不拍 let 快照。新增域照此办理，不要在模块顶层 import main.js 的绑定。
- 格式相关逻辑放 `formats.js`，结构解析放 `structure.js`，不要往 `main.js` 里塞新的格式分支。
- 界面设计原则：避免不必要的辅助标签与说明，让布局本身发挥解释作用（Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.）。
- **表单控件硬规范（2026-11-15 定）**：禁止新增裸 `<input>` / `<select>` / `<textarea>`（含 checkbox / radio），一律用 `core/form-controls.js` 的 `createSwitch / createSelect / createInput / createTextarea`（动态）或 `docs/frontend-form-controls.md` 里的静态 class 结构；设置页行式下拉用 `createSettingsSelect`。`style.css` 的 `:where()` 全局兜底只兜存量，不是继续写原生控件的许可；`test/core/form-controls-factory.test.mjs` 按文件基线卡新增，**基线只允许调小，不许调大**。
- **弹层硬规范（2026-11-20 定）**：新增页面级浮层（对话框/模态/popover/菜单/灯箱）必须经 `core/overlay-stack.js` 的 `overlayStack.open({id, kind, el, onClose})` 注册、所有关闭路径收口 `handle.dispose()`，Esc 由栈按层序退——**不要再写自己的 window/document 级 Esc 监听，也不要在 style.css 手写弹层 z-index**（档位由栈分配）；**外点关闭走同一栈的 `open({closeOnOutsideClick: true, anchors})`，不要再自挂 document `pointerdown`/`mousedown` 外点监听**（护栏 `test/core/outside-click-guard.test.mjs`，白名单只许减不许增）；锚点定位走 `core/popover-position.js` 的 `placePopover`。面板/视图内部的小浮层不进栈、可自挂 Esc；元素级 Esc 语义 ≠「关所在层」的输入框打 `data-esc-local`。护栏 `test/core/overlay-esc-guard.test.mjs` 扫描全局 Esc 监听，非豁免文件直接红——**新弹层让测试变绿的正确做法是注册进栈，不是加豁免**。方案见 `docs/finished-plans/overlay-stack.md`。
- **通用工具函数硬规范（2026-11-23 定）**：写工具函数前先查 `docs/core-capabilities.md`——转义（`core/escape.js`）、字节/时间格式化（`core/humanize.js`）、DOM 工厂（`core/dom.js`）、短 id（`core/id.js`）、JSON 容错解析（`core/json-safe.js`）、localStorage 读写（`core/kv-store.js`）、文本剪贴板（`core/clipboard.js`）等已有唯一实现，**禁止在业务模块重写**；护栏 `test/core/utility-duplication-guard.test.mjs` 按文件基线卡新增（只许减不许增），新文件出现重复实现直接红。语义相近但不同的转义（XML / 插件上下文 / 图表 SVG）不算重复，已在清单里逐条说明。
- **类型检查硬规范（2026-11-24 定）**：`frontend/tsconfig.check.json` + `npm run typecheck` 已挂进 `npm test` 的**前置门**（`checkJs: false`，按文件首行 `// @ts-check` 开启）。新增或修改 `core/` 纯逻辑文件时顺手加 `// @ts-check` 并让 tsc 保持零错误，**不许写 `@ts-nocheck`**（真要豁免就照 `test/core/icon-guard.test.mjs` 的基线机制做「只减不增」）。Wails 绑定面类型在 `frontend/src/types/backend.d.ts`，由 `scripts/gen-backend-types.mjs` 从 `testdata/app_bindings_baseline.txt`（420 条）生成——**改绑定面就必须重跑生成器**（`node scripts/gen-backend-types.mjs --check` 可验），手改文件无效。方案与后续台阶见 `docs/unfinished-plans/frontend-typescript.md`。
- **图标硬规范（2026-11-22 定，icon-consolidation 落地）**：通用 UI 图标一律走 `core/icons.js` 的 `iconSvg()`——业务代码**禁止内联 `<svg>` 字面量、禁止自建局部图标表 / 影子工厂（`icons` 对象、`icon()` 一类）、禁止遗留 MDL2 码位（`icon: 'E8C8'` 类）**；`iconHtml` 只允许 `iconSvg()` 来源，其他来源必须带 `// iconHtml-exception:` 原因注释。合理例外域（不算散落、禁止并入注册表）：文件类型 `core/fileicons*.js`、品牌 `ai/core/ai-provider-icons.js`、AI 可视化引擎 `core/widget.js` / `core/*-render.js`。护栏 `test/core/icon-guard.test.mjs`（已登记 `npm test`）按文件基线只减不增——**新图标让测试保持绿的正确做法是先登记注册表再用 iconSvg()，不是加豁免**；尺寸注意：无 CSS `svg` 规则的容器里 iconSvg 默认 14px 会替代 SVG 的 100% 默认撑满，按容器显式传尺寸。规范全文见 `docs/icon-guidelines.md`，方案见 `docs/finished-plans/icon-consolidation.md`。
- **设置同步硬规范（2026-11-22 定）**：`settings` 的持久化与跨窗口同步只有三条通道，别开第四条——① `applySettings()`（settings-ui.js）：全量重绘 + 落盘 + `settings-changed` 广播，设置页/菜单等用户可见变更的唯一出口；② `persistSettingsLight()`：只落盘 + 广播不重绘，拖分割线 / `rememberScratchExt` 等高频或局部小改动走它；③ `applyRemoteSettings()`：跨窗快照**唯一合并入口**（剥 `PER_WINDOW_LAYOUT_KEYS` 后原地合并 + 落盘 + 重绘，不再广播防环）。**禁止**在任何其他文件直写 `localStorage.setItem(settingsKey…)`、新增第二个 `EventsEmit('settings-changed')`、或绕过合并入口直并快照（历史直写点漏广播 = 别的窗口内存副本停在旧值）。新增「窗口自身形态」类键（面板显隐/宽度/形态、窗口模式、当前选择——如 `runActiveProfile`）必须登记 `PER_WINDOW_LAYOUT_KEYS`（settings-sync.js），偏好与数据键默认同步；判类规则见该注释。`applyAlwaysOnTop` 带值未变守卫——Wails `SetAlwaysOnTop` 会无条件把窗口提到本档 Z 序最顶（win32 实测），去掉守卫会复现「点侧边栏图标两窗来回闪」。护栏 `test/settings/settings-windowops.test.mjs`（已登记 `npm test`）。
- Markdown 渲染链：markdown-it → DOMPurify → hljs / KaTeX / mermaid；涉安全的改动（sanitize、外链、内嵌 HTML）必须保守，**原始 HTML 不执行是硬要求**。
- 预览/表格等大 DOM 操作注意避免整段 `innerHTML` 重渲染。

### AI 工具增删改（动 `ai-tool-defs.js` 必读）

> 给 AI 的文案与文档是工具的一部分：改了工具不改文案 = 只改了一半。2026-11-16 定（背景：list_dir 加 depth 参数时漏改目录文案、漏补 mock-backend）。

**新增工具**
- `AI_TOOL_DEFS` 定义（描述写清「何时用 / 何时不用 / 与相邻工具的分工」）；**必须**同步登记 `AI_TOOL_CATALOG` + `AI_TOOL_GROUPS`（一致性测试见 `ai-tool-defs.test.mjs`，漏目录直接红，规则详情 `.cadt/memory/ai-tool-catalog-rule.md`）。
- 下发范围：`toolsForScope` 档位清单、计划模式白名单、子代理 `subToolsForScope`（`ai-subagents.js`）按需同步。
- 执行分支：`ai-panel.js` 的 `executeToolInner` 加 `case '<名字>'`（异步记得 await；`executeTool` 是生命周期钩子包装层，case 一律写在内层）；工具卡 `ai-tool-cards.js` 的 `toolMeta` 补 `verb` + `icon`（图标名必须在 `core/icons.js` 注册，否则渲染为空不报错）。
- **接线守卫**：`frontend/test/ai/ai-tool-wiring.test.mjs` 会逐个工具核对「目录 ↔ 档位下发 ↔ 执行分支 ↔ 工具卡元数据 ↔ 图标注册」，并交叉核对「描述里提到的参数名 ↔ `parameters.properties` ↔ 执行分支读的 `input.*`」，漏一处直接红；执行分支确实不在 `ai-panel.js` 时登记到该文件的 `EXECUTED_ELSEWHERE` 并写明原因。
- **加参数**（改已有工具同理）：`properties` 加字段 + 写 `description`（模型只看这个）；描述里提到参数名就必须已声明——词表命中的参数名会被守卫当「参数提及」校验，确属取值 / 输出字段 / 别的工具参数时登记 `PROSE_TOKENS` 并写原因。
- Go 绑定方法（v3 无生成绑定目录）；**`dev/mock-backend.js` 补同名 mock**（漏了 dev 模式调用即崩）。
- 配套测试：纯函数进 `*.test.mjs` / `*_test.go`，并登记 `npm test` 清单。

**修改工具（含加参数）**
- `description` 同步：新行为、参数语义、行为指引（如「一次递归代替逐层调用」）写进描述——描述是模型唯一的行为依据。
- 目录 `blurb` 若变，`ai-tool-defs.test.mjs` 的精确断言同步改。
- 联动检查：调度原则（`ai-tool-defs.js` 内 system prompt 段）、档位守则（`ai-system-context.js`）、**相邻工具描述里的分工句**（如 glob 描述里「要列某一层目录用 list_dir」）是否需要跟着改。
- 授权 / 审批语义变化同步 `read-outside-workspace.md` 等方案文档。
- **命令执行 / 审批语义改动**：先读 `docs/finished-plans/ai-shell-choice.md`（`shell` 参数、`psScriptDanger` 特征表、
  脚本档三层判定与「端侧只拦不放」的理由）。改 `aiShellInvocation`、`shellScriptPolicy`、`psScriptDanger`
  任一处都要同步那三个通道：工具描述 ↔ 系统提示词守则 ↔ 审批链；`dangerous` 会短路分类器（`ai-permissions.js:254`），
  所以「想让分类器判」就必须别把它标成 dangerous。
- **已知盲区：脚本内的 shell 不受任何规则约束**（2026-11-18 事故根因，详见 `docs/reports/incident-2026-11-18-workspace-wipe.md`）。
  `analyzeDangerousCommand` / `analyzeReadOnlyCommand` 只作用于 `run_command` 的**命令文本**；AI 自己写的
  `.mjs` / `.py` / `.sh` 在进程内 `execSync` / `subprocess` / `eval` 起真实 shell 时，规则层完全看不到。
  `find . -delete` 本身判得出 `find-delete`（`ai-command-rules.js:536`）也进不了只读白名单，但那次执行绕过了整条判定链。
  因此：① 不要以为加了规则就防住了脚本逃逸；② 红队 / 渗透 / 批量文件操作类任务必须把探针沙箱固定到
  `.cadt/tmp/sandbox-*` 并在脚本头断言 `pwd`；③ 改这类能力时评估「工作区完整性哨兵 / 工作树快照」兜底（方案见报告第五节）——**已落地**：wipeguard（`wipeguard_app.go` + `internal/wipeguard/`）做写前快照 + watcher 检测 + 定期快照，详见 Go 后端清单条目。

**删除工具**
- def、`AI_TOOL_CATALOG` 条目、`toolsForScope` / 计划模式 / 子代理白名单、`dev/mock-backend.js` 同名 mock、Go 绑定与调用分支一并清；测试里的精确断言同步删。

**app_control 动作（第二套「工具」，同样三处对齐）**
- 动作清单有三份：`ai-constants.js` 的 cadt-ui 技能「动作表」（模型唯一看得到的清单）、`main.js` 的 `APP_ACTIONS`（错误提示列它）、`runAppAction` 的 `switch` + `MCP_CONFIG_ACTIONS`（真正分发）。新增/删除动作三处必须同时改。
- 守卫 `frontend/test/ai/ai-app-actions.test.mjs` 三方对账，并要求技能表**一条一个动作**（`- action_name {params}：说明`）——历史上用 `；` / `/` 塞多个动作的行没法机械核对，格式现在由测试强制。
- 已实现但刻意不给模型的动作，登记该文件的 `UNDOCUMENTED`（写原因）；参数写进技能表，别只写在 `description` 里。

**收尾**：用户可见变更进 `CHANGELOG.md`（见下节）。

### 内容区标签页（「一切皆标签页」，新增一类时必读）

内容区里不存在第二种呈现单位：任何值得人看或操作的东西都是一个 `doc`、占一个标签页。doc 分两类：

- **文件标签页** `path ≠ null`；
- **虚拟标签页** `path === null`，又分两族：
  - **视图型**——doc 上有标记位（`doc.browser` / `doc.bgTerm` / `doc.agentView` / `doc.agentTeam` / `doc.sideChat` / `doc.groupMember` / `doc.memo`），`createDocEditor` 建自定义面板，没有 `doc.editor`；
  - **文本型**——`openVirtualDoc` 产出（`untitled` + `viewKind`：计划 / 差异 / 只读文档），**复用通用编辑器**。

**视图型的单一来源是 `frontend/src/core/tab-kinds.js` 的 `TAB_KINDS`**（marker / kind / icon / label）。放 `core/` 是因为 `editor/` 与 `bridge/` 是互不 import 的同级域，两边都要认这几类；**视图工厂不进表**（否则 `core/ → editor/` 成反向依赖），仍由各域提供、经 `VIRTUAL_TAB_VIEWS` 在 `editor-groups.js` 分派。

新增一类视图型虚拟标签页：

1. **`core/tab-kinds.js` 加一条表项**（marker / kind / icon / label；icon 必须在 `core/icons.js` 注册过，否则静默渲染成空）；
2. **各域写视图工厂** + 在 `editor-groups.js` 的 `VIRTUAL_TAB_VIEWS` 登记分派（键 = `kind`）；
3. **`src/bridge/*.js` 建创建点**：`createVirtualTabDoc({ …, marker: 'xxx', key })`（`core/virtual-tab-doc.js`，marker 与 key **必须成对**传，只给 marker 会让去重判断恒假、每次点开都新建一个）；
4. **视图里挂 `doc.tabUnmount`**——`closeDocNow` 只调这一条统一契约（浏览器例外，走 `BrowserClose` 释放 WebView2）。

其余接线点自动生效，**不需要动**：`createDocEditor` 分派、`viewOptionsFor` 屏蔽、标签图标、`appTabViewOf` 的 AI 上下文描述。

文本型（`openVirtualDoc`）走另一条路：必须保持 `path: null` + `viewKind`，新增 `viewKind` 要把标签加进 `main.js` 的 `APP_TAB_KIND_LABELS`，否则 AI 上下文退化成「标签页」。**文本型不屏蔽文件视图下拉**（`.md` 计划文档需要预览）。

守卫 `frontend/test/editor/virtual-doc-wiring.test.mjs` 以 `TAB_KINDS` 为准逐点对账（分派表 / 图标链 / 图标注册 / 统一卸载 / 创建点 / `appTabViewOf`），另覆盖文本族的 `viewKind` 接线。设计依据见 `docs/finished-plans/tab-registry.md`。

**边界（常驻 UI 不是标签页，别硬改）**：AI 面板（`#ai-panel` 单例硬约束）、设置对话框、阅读模式（`#editor` 的兄弟节点，独占式 `show()`/`close()`）、底部 dock（`terminal` / `debug` / `run` / `graph` 自成 4 态切换器）、调试台、各类浮层、辅助窗口（文件对比 / 实时预览）。

**第二族：应用页面**（2026-11-22）——「一个功能页面」而不是「一个业务对象」。使用统计 / 定时任务 / 操作记录 / 补丁库原本嵌在设置对话框里，本质是浏览与管理数据的重面板（要长时间停留、要看大量内容、要能并列对照），现在各自是一个内容区标签页；同日「外部工具」（原 设置 → AI → 外部工具）整体迁入同一族；2026-11-23「智能体」（原 设置 → AI → 智能体，群聊成员管理）以同款停靠区形态迁入（`#agents-park` + `ai-agent-settings.js` 的 `mountAgentsPane`，pane 不带 `.settings-pane` 类，AI 指引口径「应用页面 → 智能体」，方案见 `docs/finished-plans/agents-app-page.md`）：

- 清单单一来源 `core/app-pages.js` 的 `APP_PAGES`（id / label / icon / group / desc）；`TAB_KINDS` 里 `appPage` 一项用 `resolve(doc)` 按 `doc.appPage` 细分图标与标签。
- 各页内容渲染**仍在原域**，经 `mount(root)` 返回卸载函数（`settings-pane-usage-stats.js` / `settings-pane-patches.js` / `activity-pane.js` / `ai-schedule.js` 的 `mountSchedules`）。视图工厂 `bridge/bridge-app-page-view.js` 只负责建标签页与调 mount；挂载器由 `main.js` 的 `appPageMounters` 注入（`bridge/` 不 import `settings/` 或 `ai/`）。**外部工具是特例**：整段 DOM 常驻 index.html 尾部的 `#extcap-park` 停靠区，`settings-pane-external-tools.js` 的 mount/unmount 把它搬进/搬出标签页容器——保持节点身份，`ai-mcp-settings.js` 启动时按 id 捕获的引用与事件绑定跨开关标签页始终有效；容器加 `.extcap-root`（flex+gap 沿用设置 pane 纵向节奏）；MCP 世代事件到达时标签开着才刷新（`refreshExternalToolsPaneIfVisible` 判 `doc.appPage`）。
- 入口四层：活动栏 `ab-app-pages`（侧栏「应用页面」面板，按分组列出页面，点行直接开标签页——最常用入口）、菜单「工具 → 应用页面」子菜单、活动栏 `ab-more` 弹层、命令面板（`paletteActions()` 递归展开菜单 submenu，**进菜单即自动可搜**）。设置页另有「页面 → 应用页面」目录 pane 作发现入口。侧栏面板走 `settings.sidebarView = 'app-pages'`（与 files / git / structure / chats 同一套切换器），内容由 `renderAppPagesNav` 渲染。
- **真·设置项不随页搬走**：这些页里的开关仍留在设置页（`settings-tree` 靠扫设置页 DOM 反射，搬走 AI 的 `set_setting_row` 就照不到，`plugin-path-mode` 还是高风险可写项）。当前只有「操作记录」涉及：`opt-activity-log` / `opt-activity-retention` 留在设置页，页内只放浏览与记录管理动作。「外部工具」是整体迁移的例外：MCP/能力来源各行随页离开了设置树（AI 对 MCP 服务器仍有 get/set/delete_mcp_server 专用动作），AI 指引路径统一为「应用页面 → 外部工具」。设置目录页（`settings-pane-app-pages.js`）点行开标签页后**顺带关闭设置弹层**（`closeSettings` 依赖注入）。

### 文档与提交
- 用户可见的改动同步更新 `CHANGELOG.md` 与 `README.md` 对应小节。
- 方案文档放 `docs/unfinished-plans/`，全部实施后移入 `docs/finished-plans/`。
- 版本号四处需一致：`app_core.go` 的 `appVersion`、`wails.json` 的 `productVersion`、`build/windows/info.json`（v3 syso 版本资源）、`build/windows/installer/wails_tools.nsh` 的 `INFO_PRODUCTVERSION`（见 `docs/packaging.md`）。

## 常用命令

前置：Windows 10/11 + WebView2 Runtime、Go 1.26+、Node.js 20.19+（或 22.12+）、Wails CLI v3.1.0+（`wails3`，仅用于生成 Windows 资源）。

```bash
# 环境检查
wails3 doctor

# 开发运行（wails3 dev：Vite 热更新 + 应用窗口；fresh clone 先 `cd frontend && npm install && npm run build`——dist 被 gitignore，缺它 go:embed 编译失败）
wails3 dev
# 或者只构建启动（不跑 Vite dev server）
go build -o datalens.exe . && ./datalens.exe

# 一键构建并替换根目录便携副本 datalens.exe（tools/rebuild-exe.cmd 双击入口）：开头选是否跑
# Go 测试（1 进行 / 2 跳过只跑前端），测试门（Go + 前端）通过才构建，失败可按提示
# 「1 复制失败信息到剪贴板（粘贴给 AI 修复）」/「2 跳过测试强行构建」/其他退出；
# 构建流程：npm run build → wails3 generate syso（图标/清单/版本资源）→ go build -tags production；
# 自动优雅关闭运行中的实例，锁死时改名让路 datalens.running-old-*.exe、下次运行清理；
# -SkipTest 跳过测试门 / -KeepRunning 不停实例 / -Devtools 带调试面板
powershell -ExecutionPolicy Bypass -File tools/rebuild-exe.ps1

# 构建安装包（双击入口 tools/build-installer.cmd；需 NSIS 3 + signtool；
# 内部是前端构建 + syso + go build + 签名 + WebView2 引导器 + makensis + 验签，不跑测试门）
powershell -ExecutionPolicy Bypass -File tools/build-installer.ps1

# Go 测试
go test ./...

# 重训端侧命令分类器（产出 frontend/src/ai/security/local-classifier-weights.mjs，语料/硬指标在脚本内）
node scripts/train-local-classifier.mjs --version factory-YYYY-MM-DD-1

# 后端测试（含 Windows 集成测试）
go test -v -run 'Windows|Integrat' ./

# 前端单独调试（浏览器 + mock 数据）
cd frontend
npm install
npm run dev
# 打开 http://localhost:5173/
# mock 场景：?jsonl ?yaml ?xml ?csv ?text ?image ?line ?large ?invalid ?multi ?empty ?gbk
```

## 命令行能力（改动 CLI 时参考）

```bat
CaDt-DataLens.exe "D:\data\sample.json:42:8"
CaDt-DataLens.exe --line 42 "D:\data\sample.json"
CaDt-DataLens.exe -g "D:\data\sample.json:42"
CaDt-DataLens.exe --help
```

- **打开定位**：`路径[:行[:列]]`、`--line/-l`、`--column/-c`、`--goto/-g`，行列从 1 开始。**不存在的路径不再静默丢弃**——照常进打开目标，前端报「打开失败」（agent 调用打错路径必须有失败信号）；解析在 `internal/launchargs.ParseOpenTargets`。
- **定点打开**：`--open-settings=<pane>`（设置页）、`--ai-session=<id>`（AI 会话，转发到归属工作区窗口；会话→工作区解析在 `internal/sessionstore.ResolveSessionWorkspace`）、`--memo` 便签定位点（`cadt-memo://<workspace|global>/<block|item>/<id>`，面板右键「复制定位点」得到；冷启动经 `GetStartupMemoLocator` 消费、转发走 `app-open-memo` 事件）。
- **窗口形态**：`--new-window`、`--ai-float`（AI 浮窗）、`--debug-console`（调试台）、`--quit`（优雅退出运行实例）。
- **多窗口文件投递按工作区路由**：祖先链逐级向上与已登记工作区键精确匹配取最深命中（嵌套工作区内层窗口拿子目录文件），无归属投主窗口；窗口工作区来自前端 `WindowRegister` 实时登记。
- **headless 子命令**：`--convert`（`internal/convertcli`）、`--check-patch` / `--apply-patch` / `--revert-patch`（`internal/patchcli`）、`--integrate/--unintegrate`（安装包，`internal/installercli`）。
- **`--help/-h` 打印全部参数**（`cliUsageText()` 拼接 launchargs/convertcli/patchcli 三段 usage）、`--version/-v` 打印版本。**新增开关必须写进对应 Usage 常量**——`cli_help_guard_test.go` 对源码开关字面量与 help 文本双向对账，漏写直接红。
- 转发决策在根包 `secondInstancePlan`（纯函数，表驱动测试 `secondinstance_plan_test.go`）；程序已在运行时新命令转发到现有窗口。
