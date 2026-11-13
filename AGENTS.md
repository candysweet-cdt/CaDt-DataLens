# AGENTS.md

## 项目概述
CaDt-DataLens 是一个面向 Windows 的轻量级多格式数据查看与编辑器（JSON/JSONL、YAML、XML/SVG、CSV/TSV、TOML、INI/Properties、Markdown、代码文本、图片、二进制）。

技术栈：Go 后端 + Wails v2（原生窗口 + Windows WebView2）+ 原生 JS 前端（Vite 构建，Ace / jsoneditor / markdown-it / highlight.js）。

设计目标：**单 exe、零依赖、系统提供引擎**——不自带 Chromium、不打包 Node、不做项目索引。许可证 Apache-2.0。

## 目录结构
> 根目录是扁平 Go 包 `main`，没有顶层 `src/`。

### Go 后端（仓库根）
- `main.go`：Wails 启动配置、窗口选项、`//go:embed all:frontend/dist` 资源内嵌、单实例锁
- `app.go`：核心后端——文件读写、编码检测、剪贴板、系统操作、命令行目标解析；`const appVersion` 在 `app.go:33`
- `appdata.go` / `logging.go` / `pathinfo.go`：应用数据目录、日志、路径信息
- `ai.go` / `ai_float.go` / `ai_proxy_*.go` / `ai_command_windows.go`：AI 助手与浮窗、代理
- `sessionstore*.go` / `sessionlock*.go`：AI 会话磁盘存储（追加式 JSONL、每会话 meta、原子替换、fsync 回滚、跨进程写锁、回收站删除）
- `aiconfig*.go`：AI 配置 `ai-config.json` 的原子读写（0600）
- `sessionindex*.go`：AI 会话 SQLite **派生**搜索索引（modernc pure Go，JSONL 为唯一真源）
- `activity.go`：操作留痕（追加式 JSONL、按月分文件滚动分段、跨进程写锁、保留清理；只存操作摘要，不存正文与密钥）
- `sqlview*.go`：CSV/TSV/JSONL 的只读 SQL 查询（导入临时 SQLite，不修改原文件）
- `patch.go` / `patch_app.go` / `patch_cli.go` / `patch_platform_*.go`：`.patch` 解析、严格匹配、两阶段应用（atomic / partial）、字节级备份与撤销、索引与 WAL；`patch_app.go` 只是 Wails 薄包装，`patch_cli.go` 提供 `--check-patch` / `--apply-patch` / `--revert-patch`（不启动窗口）。核心逻辑是不依赖 App 的自由函数，CLI 与界面共用
- `browser*.go` / `devtools_*.go`：内嵌浏览器、开发者工具
- `search.go`：工作区内容搜索（有 `searchBudget`、`searchMaxFileSize` 等硬预算）
- `structuredir.go`：结构化目录导出
- `plugins.go` / `skills.go` / `market.go` / `update.go`：插件、技能注册（`docs/skills` 经 `go:embed` 分发，内置技能首次列出时物化到应用数据 `builtin-skills/`）、市场、检查更新
- `gitinfo.go`：Git 分支/提交面板后端
- `delete*.go`、`envvars*.go`、`terminal_windows.go`、`toolchain_windows.go`、`integration_windows.go`、`installer_cli_windows.go`、`notify_windows.go`、`cursors*`、`windowicon*`：Windows 能力与注册表集成
- `run.go` / `run_shells_*.go`：运行代码（`PrepareRun` 临时副本与工作目录、`RunExec` 流式执行 + GBK 解码 + PATH 前置、stdin 队列 `RunInput` / `RunEndInput`、`RunStop`、临时目录清理）；配方与语言知识在前端 `src/run.js`，Go 侧只负责起进程
- `run_project.go`：项目感知运行（`DetectRunProject` 只读探测项目标记与候选命令，遇 `.git` / 用户主目录停止）；执行仍走 `RunExec`，确认在前端
- `dialogs.go`、`commands.go`、`preview_assets.go`、`debugconsole.go`
- `*_test.go`：与同名源文件对应的单元测试

### 前端 `frontend/`
- `src/main.js`：界面主体（标签页、设置、编辑器、菜单、CSV 表格、Markdown 预览）——最大的单文件，改动务必先定位函数再动手
- `src/formats.js`：格式驱动层（parse / stringify 双向转换，插件格式也走这里）
- `src/structure.js`：17 种语言的结构/大纲解析（纯函数，无 DOM 依赖）
- `src/explorer.js`：文件树（惰性加载 + 内存缓存 + 自动刷新）
- `src/run.js`：运行代码（扩展名 → 运行配方、命令模板 / 自检脚本 / 项目确认、stdin、dirty 决策、输出面板与 ANSI / `path:line:col` 跳转、AI 分析提示词）；`src/run.test.mjs` 覆盖纯函数
- `src/patch-view.js`：补丁视图（文件卡 / hunk / 模式切换 / 应用 / 撤销），只做渲染，解析与写入全走 Go
- `src/ai-panel.js`、`src/palette.js`、`src/contextmenu.js`、`src/icons.js`、`src/fileicons*.js`、`src/plugins.js`、`src/jsonrepair.js`、`src/debugconsole.js`
- `src/ai-session-store.js`：AI 会话 JSONL 编解码/重放 + 磁盘适配（图片外置、增量持久化）
- `src/activity-log.js`：操作留痕前端服务（脱敏 sanitizer、攒批 ≤200ms/20 条调 `ActivityAppend`；开关与保留月数在设置 → 操作记录）
- `src/markdown.js`：共享 Markdown 渲染/sanitize（main.js 与阅读模式共用，规则单一来源）
- `src/widget.js`：AI 回答里 `svg` / `html` 围栏的可视化卡片（Shadow DOM 承载 + DOMPurify 清洗，样式隔离、主题变量继承；`<style>` 先抽出单独清洗再注入 shadow，外链 `url()` / `@import` 与 `position:fixed` 会被处理；只有 AI 面板传 `env.aiWidgets` 时启用）。配套内置技能 `inline-visual`（对话内卡片）与 `answer-me-with-html`（多面板页面），规则改动要同步这两个技能
- `src/reading/`：阅读模式（`reading.js` 控制器、`reading-model.js` 纯函数 TOC/排序/进度/joinSoftLines、`reading-state.js` localStorage 进度/书签/统计、`reading-view.js` 书架/详情/目录 DOM、`reading-render.js` md/txt/docx/epub 渲染 + LRU、`reading-search.js` 章内/全书查找、`reading-tts.js` 朗读）；Go 侧对应 `reading*.go`；方案见 `docs/finished-plans/reading-mode.md`；**只读，禁止调用写接口**
- `src/style.css`：布局、主题、Ace/jsoneditor 样式；`src/reading.css`：阅读模式样式（`.rd-` 前缀）
- `index.html`：窗口结构、菜单、设置对话框
- `public/vendor/`：jsoneditor、mermaid 等第三方资源；`public/fonts/`：Inter / JetBrains Mono / Fira Code（OFL）
- `wailsjs/`：Wails 自动生成的绑定，**不要手改**
- `dist/`：构建产物，经 `go:embed` 编进 exe，**不要手改**

### `docs/`
- `packaging.md`（打包与发布）、`plugins/`、`skills/`、`samples/`、`screenshots/`、`icons/`、`legal/`
- `finished-plans/`：已实施完的方案存档（`ai-panel.md`、`ai-panel-v2.md`、`ai-panel-v3.md`、`ai-head-agents-terminal.md`、`operation-audit-log.md`、`writing-mode.md`、`reading-mode.md`）
- `unfinished-plans/`：未开工/进行中的方案（目前：`structure-cleanup.md`）；`ai-patch-approval.md`、`run-code.md` 已实施完并移入 `finished-plans/`
- `icon-guidelines.md`
- `reports/optimization-proposals.md`：体积与性能优化提案（含实测体积基线）

### 其他
- `build/`：Wails 构建资源与 `build/bin` 产物；`build/windows` 放 NSIS 脚本
- `scripts/build-installer.ps1`：构建 + 代码签名
- `plugins/`：随仓库分发的插件样例（如 `scene-carousel`）
- `.cadt/`：本应用 AI 助手的持久记忆

## 约定

### 通用
- 回答使用中文；代码注明语言。
- 修改文件前先读取确认；不要改动与任务无关的内容。
- 新增依赖或改变目录结构时说明原因。
- **体积是第一约束**：任何新依赖先问「能否不引入」，体积预算为 0 的改动优先。
  - 不打包 Chromium / Node / ripgrep / SQLite / LSP。
  - **SQLite 例外（作者批准的派生索引，均不存真源数据）**：AI 会话搜索的 `ai-index.db`（2026-11-11 批准，实测整包 +3.9 MB）与 AI 定时任务的 `ai-schedule.db`（2026-11-12）。两者都是纯 Go `modernc.org/sqlite`、可随时删除重建（JSONL / 触发指令原文仍是真源）。**不要**把设置、偏好、模型配置或会话正文搬进 SQLite。
  - 重型前端库（mermaid 2.57 MB 是当前天花板）必须**懒加载**，参考 `main.js` 的 `ensureMermaidScript()`。
  - 明确否决过的方向见 `docs/reports/optimization-proposals.md` 第四节（换 Monaco、内置 SQLite、全项目索引、内置 LSP、打包 rg）。

### Go 侧
- 平台相关代码按现有约定分文件成对出现：`xxx_windows.go` + `xxx_other.go`，不要在一个文件里堆 `runtime.GOOS` 判断。
- 新增导出方法后，`frontend/wailsjs/` 由 `wails dev` / `wails build` 重新生成。
- 新增/修改逻辑要补 `*_test.go`；现有测试多为表驱动，跟随即可。
- 文件大小硬限制（`app.go`）：>10 MB 只读、>100 MB 拒绝打开、图片预览 32 MB、二进制 hex 1 MB。放宽限制前先确认性能。

### 前端侧
- `main.js` 很大，改动前先 `search_text` 定位函数名，避免整文件重读。
- 格式相关逻辑放 `formats.js`，结构解析放 `structure.js`，不要往 `main.js` 里塞新的格式分支。
- Markdown 渲染链：markdown-it → DOMPurify → hljs / KaTeX / mermaid；涉安全的改动（sanitize、外链、内嵌 HTML）必须保守，**原始 HTML 不执行是硬要求**。
- 预览/表格等大 DOM 操作注意避免整段 `innerHTML` 重渲染。

### 文档与提交
- 用户可见的改动同步更新 `CHANGELOG.md` 与 `README.md` 对应小节。
- 方案文档放 `docs/unfinished-plans/`，全部实施后移入 `docs/finished-plans/`。
- 版本号三处需一致：`app.go` 的 `appVersion`、`wails.json` 的 `productVersion`、NSIS 脚本（见 `docs/packaging.md`）。

## 常用命令

前置：Windows 10/11 + WebView2 Runtime、Go 1.26+、Node.js 20.19+（或 22.12+）、Wails CLI v2.17.1+。

```bash
# 环境检查
wails doctor

# 开发（热重载）
wails dev

# 构建 exe（产物 build/bin/CaDt-DataLens.exe）
wails build -devtools

# 构建安装包（需 NSIS 3，makensis 在 PATH）
wails build -nsis -installscope user

# 构建 + 代码签名
powershell -ExecutionPolicy Bypass -File scripts/build-installer.ps1

# Go 测试
go test ./...

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
```

支持 `--line/-l`、`--column/-c`、`--goto/-g`，行列从 1 开始；程序已在运行时新命令转发到现有窗口。
