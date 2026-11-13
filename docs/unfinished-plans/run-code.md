# 运行代码 v1 方案（未实施）

> 状态：**方案待评审** · 方案日期：2026-11-13 · 目标版本：`v1.1.0`
> 范围：单文件"运行代码"（解释型优先 + 编译型）+ 运行输出面板 + 停止/退出码。
> 不在范围：调试器、断点、LSP、项目管理、多文件工程构建、包管理器安装。

---

## 0. 一句话目标

在数据查看器里按 `F5` 把**当前这个文件**跑起来，输出落在底部面板里，退出码和耗时看得见；跑不动时给出人话的原因。

定位不是"做成 IDE"，而是**脚本化的看数据**：最常见的用法是写十几行 Python 读旁边的 CSV 做统计、用 jq 式的 Node 脚本转一遍 JSON。所以第一优先级是 **cwd = 文件所在目录**（能直接读到旁边的数据文件），而不是工程构建。

### 功能索引

| 编号 | 功能 | 章节 |
|---|---|---|
| 1 | 语言识别与运行配方 | §3 |
| 2 | 运行什么内容（磁盘 / 缓冲区） | §4 |
| 3 | 输出面板与进程控制 | §5 |
| 4 | 后端执行通道 | §6 |
| 5 | 设置项与记忆 | §7 |
| 6 | 安全模型 | §8 |
| 7 | 解释型语言 | §3.1 |
| 8 | 编译型语言（两段式） | §3.2 |
| 9 | 与 AI 的联动（V3） | §11 |

### 默认拍板项（可改）

| 决策 | 默认 | 理由 |
|---|---|---|
| 输出面板 | **新建 `run` 视图**，不用 xterm | 需要"点 `path:line:col` 跳源码"和"stderr 标色"，xterm 做这两件事成本高于收益 |
| 执行通道 | `exec` + 参数数组，**不经 shell 拼接** | 免注入、免引号地狱；只有 `.bat/.cmd/.sh/.ps1` 必须过解释器 |
| 有未保存修改 | 默认**先保存再运行**（可关） | "看到的就是跑的"；关闭或只读模式下退化为临时副本 |
| cwd | 文件所在目录（设置可切工作区根） | 数据查看器场景要读旁边的数据文件 |
| 并发 | 最多 3 个运行并存，面板按标签切换 | 长驻服务（`node server.js`）不会挡住下一次运行 |
| stdin | **V1 不接管**（子进程 stdin 为空 → 读到 EOF） | 第一版不支持交互，绝不假装支持 |
| 语言判定 | 按**扩展名**，不看内容 | `structure.js` 的 EXTENSIONS 已经是唯一真源，复用即可 |
| 工具版本要求 | 从扫描缓存取，不满足就禁用按钮并说明 | 扫描结果本来就是干这个的 |

---

## 1. 现状盘点：五块底座已经齐了

| 底座 | 位置 | 运行代码能直接用的部分 |
|---|---|---|
| 编译器/解释器扫描 | `toolchain_windows.go`（`DetectToolchain`） | 绝对路径 + 版本号，已缓存进 `settings.langEnv[lang].tools[tool]`；10 种语言 24 个工具 |
| 命令执行通道 | `commands.go`（`StartCommand` / `StopCommand` / `RunCommandSync`） | 流式 `cmd-out` / `cmd-exit` 事件、8 MB 输出上限、`taskkill /F /T` 连树终止、`CREATE_NO_WINDOW` |
| 进程环境 | `envvars.go`（`mergeEnv`） | 设置里的私密变量自动注入子进程，与终端行为一致 |
| 底部面板 | `index.html` `#terminal-panel` + `main.js` `dockView` | 已有 `terminal` / `debug` 两个视图，加第三个是既有模式 |
| 编码能力 | `app.go`（`x/text`：UTF-8 / GBK / GB18030） | 中文 Windows 上编译器吐 GBK，转码不用引新依赖 |

**所以这个功能 90% 是"编排"，不是"造轮子"**。真正要新写的只有：运行配方表、输出面板、临时工作目录、编译两段式。

---

## 2. 一次运行的完整流程

```
F5 / 工具栏 ▶
  ├─ 取活动文档 → 扩展名 → 配方（RUN_RECIPES）
  │    └─ 该格式没有配方 → 按钮禁用，tooltip 说明原因（"JSON 无法直接运行"）
  ├─ 检查工具链：settings.langEnv 缓存 → 无缓存则现场扫一次
  │    ├─ 没装 → 面板显示"未检测到 Python 解释器"，给"去设置扫描"按钮
  │    └─ 版本不满足（如 ts 需要 Node 22.6+）→ 明确说缺什么
  ├─ 准备源文件：
  │    ├─ 有路径且未修改 → 直接用
  │    ├─ 有路径但有未保存修改 → 先保存（默认）／写临时副本
  │    ├─ 无路径（虚拟文档）→ 写临时副本，面板顶部标「临时副本」
  │    └─ 磁盘被外部改过（staleOnDisk）→ 提示后重新加载再跑
  ├─ 需要编译（C/C++/Rust）→ 第 1 步 compile 到临时目录 → 退出码非 0 就停
  ├─ 第 2 步 run
  ├─ 输出流式进面板（stderr 标红、ANSI SGR 上色、`path:line:col` 可点）
  └─ 退出：显示 `退出码 0 · 1.24 s`；非 0 时给「把输出发给 AI 分析」
```

---

## 3. 语言判定与运行配方

配方表放**新文件 `frontend/src/run.js`**，不进 `main.js`（遵循"格式相关逻辑不往 main.js 塞"的约定）；Go 侧只认"要跑什么 exe、什么参数、哪个目录"，不含语言知识。

### 3.1 解释型（V1）

| 扩展名 | 命令 | 前置 | 备注 |
|---|---|---|---|
| `py` `pyw` | `<python> <file>` | python | 建议加 `-u` 免输出缓冲延迟 |
| `js` `mjs` `cjs` | `<node> <file>` | node | |
| `ts` `mts` `cts` | `<node> --experimental-strip-types <file>` | node ≥ 22.6 | 更低的 Node 提示"用 tsx / 升级 Node"，不自动装包 |
| `go` | `<go> run <file>` | go | 单文件 `go run` 不要求 go.mod |
| `java` | `<java> <file>` | JDK ≥ 11 | 走单文件源码启动，**不产生 `.class`**，不污染源目录 |
| `php` | `<php> <file>` | php | |
| `rb` | `<ruby> <file>` | ruby | |
| `lua` | `<lua> <file>` | lua | 用扫描出的 `lua5.4` 等实际名 |
| `sh` `bash` | `<git-bash> <file>` | gitbash | 复用 `findGitBash()`，排除 WSL 的 `bash.exe` |
| `bat` `cmd` | `cmd.exe /c <file>` | 系统自带 | |
| `ps1` | `<pwsh> -NoLogo -File <file>` | pwsh | 无 pwsh 时退 `powershell.exe -File` |

### 3.2 编译型（V2，两段式）

| 扩展名 | 编译 | 运行 |
|---|---|---|
| `c` | `<gcc> -O0 -g -o <tmp>/<base>.exe <file>` | `<tmp>/<base>.exe` |
| `cpp` `cc` `cxx` | `<g++> -O0 -g -std=c++17 -o <tmp>/<base>.exe <file>` | 同上 |
| `rs` | `<rustc> -o <tmp>/<base>.exe <file>` | 同上 |

要点：

- 产物落 `%LOCALAPPDATA%\CaDt-DataLens\run\<ts>-<rand>\`，**不写源目录**；启动时清理 7 天前的（照抄 `sqlview` 的清理策略）。
- 运行 exe 时把**编译器所在目录前置到 PATH**：MinGW 产物依赖同目录的 `libstdc++-6.dll` / `libgcc_s_seh-1.dll`，不前置会报"找不到 dll"。
- 编译失败停在编译输出，面板标 `编译失败`，不进入 run。

### 3.3 明确不做的

| 格式 | 处理 |
|---|---|
| `html` `htm` | 不是"运行"，是"在浏览器打开"——已有内嵌浏览器，菜单里给入口，不进运行面板 |
| `sql` | 已有 SQL 查询视图，不重复 |
| `ino` | 需要 arduino-cli 与板子，明确不支持 |
| `json` `yaml` `xml` `csv` `toml` `ini` `md` `txt` | 数据/文档，按钮禁用 |

---

## 4. 运行什么内容

三种状态、三种处理：

| 状态 | 处理 | 面板提示 |
|---|---|---|
| 有路径、无修改 | 直接跑磁盘文件 | 无 |
| 有路径、有未保存修改 | 默认先 `saveDoc()` 再跑 | 「已保存并运行」 |
| 同上，但 `runAutoSave=false` 或 `readOnlyMode` | 写临时副本再跑 | 「临时副本运行（同目录依赖不可用）」 |
| 无路径（`openVirtualDoc`） | 写临时副本 | 同上 |

临时副本的两个真实限制，必须写在提示里而不是让用户猜：

1. **同目录依赖断链**：Python 的 `import helper`、Node 的 `require('./data.json')`、Go 的 `//go:embed` 在临时目录里都会失败。
2. **相对路径失效**：`open('data.csv')` 在临时目录读不到文件——所以临时副本运行时 cwd 仍设为**原文件目录**（若存在），只把脚本文件放临时目录。

---

## 5. 输出面板

### 5.1 为什么不用 xterm

| 方案 | 优点 | 代价 | 结论 |
|---|---|---|---|
| **A. 新建 `run` DOM 面板** | 可点 `path:line:col` 跳源码、stderr 独立样式、按行折叠堆栈 | 自己解析 ANSI（约 80 行 SGR 子集） | **采用** |
| B. 复用终端，把命令打进 shell | 几乎零改动，stdin/Ctrl+C 天然可用 | 引号转义坑、命令回显污染输出、拿不到可靠退出码与结构化跳转 | 备选 |
| C. 只读 xterm 实例 | 真终端渲染、颜色免费 | 链接跳转/折叠要写 link provider；为只读输出用交互终端不划算 | 不采用 |

### 5.2 结构

复用 `#terminal-panel` 容器，`dockView` 增加第三值 `'run'`：

```
#terminal-panel
├─ #terminal-resize        拖动高度（复用）
├─ .term-head              dockView === 'run' 时隐藏（同 debug）
└─ #run-view
   ├─ .run-head            运行标签 ×N（"a.py" / "b.cpp"）+ 清空 + 关闭全部
   ├─ .run-output          输出区（DOM，行级节点，超过 5000 行从头丢）
   └─ .run-status          状态行：▶ 运行中 · 1.2s │ 停止 │ 退出码 1 │ 复制 │ 发给 AI
```

### 5.3 输出渲染

- 每行一个 `div`，`stderr` 行加 `.run-line-err`（左侧红条 + 淡红底），不整段重渲染。
- ANSI：只处理 SGR（`\x1b[...m`）的 8 色 + 粗体 + 重置，其余 CSI 序列直接丢弃，避免乱码。
- **链接识别**：`(.+?):(\d+)(?::(\d+))?` 且路径片段能对应到已存在的文件 → 包成 `.run-link`，点击 `openPathAt(path, line, col)`。编译器报错、Python traceback、Node 堆栈都能命中，这是面板选 DOM 而不是 xterm 的核心理由。
- 输出上限沿用 `commandOutputCap`（8 MB），超限插一行「…已截断…」。

### 5.4 快捷键与入口

| 入口 | 键 |
|---|---|
| 运行当前文件 | `F5`（当前未占用） |
| 停止 | `Shift+F5` |
| 重跑上次命令 | `Ctrl+F5` |
| 清空输出 | 面板按钮 |
| 菜单 | `工具(U) → 运行当前文件` |
| 工具栏 | 代码类格式下，标题栏右侧出现 ▶（非代码格式隐藏，不做常驻） |

> 注意：`F5` 在部分浏览器内核里是刷新，Wails 下 WebView2 不会劫持，但要在 `keydown` 里 `preventDefault()`。

---

## 6. 后端改动

### 6.1 新增文件

| 文件 | 内容 |
|---|---|
| `run.go` | `RunExec` / `PrepareRun` / `CleanupRunTemp`，平台无关的编排与参数校验 |
| `run_windows.go` | 临时目录、PATH 前置、`taskkill` 复用、Defender 友好的目录选择 |
| `run_other.go` | 非 Windows 返回"暂只支持 Windows"（保持成对约定） |
| `run_test.go` | 任务表驱动：配方参数拼装、PATH 前置、临时目录命名与清理、GBK 输出转码 |

### 6.2 API

```go
// 把缓冲区写成临时源文件，返回可直接执行的路径；已有路径时 tempDir 为空
func (a *App) PrepareRun(srcPath, content, tempName string) (*RunPlan, error)

// 带 PATH 前置的流式执行：内部与 StartCommand 共用 startProcess 核心，
// 输出经 GBK 转码后发 run-out / run-exit（不复用 cmd-out，避免影响插件）
func (a *App) RunExec(id, exe string, args []string, cwd, pathPrepend string) error

// 停止：复用 StopCommand 的取消表
func (a *App) RunStop(id string) error

// 清理超过 7 天的临时目录（启动时调一次，静默失败）
func (a *App) CleanupRunTemp() error
```

### 6.3 必须处理的坑

| 坑 | 处理 |
|---|---|
| **GBK 输出乱码** | `StartCommand` 里 `strings.ToValidUTF8` 会把中文 Windows 下 gcc/pip 的 GBK 输出变成 `�`。运行通道必须先用 `x/text` 试 UTF-8，失败再试 GBK，都不行才替换 |
| 中文路径 + 空格 | `exec` 用参数数组天然安全；只有 `.bat/.cmd/.sh/.ps1` 需要引号包裹，统一 `"` 并拒绝含 `"` 的路径 |
| 长驻服务不退出 | 3 个并发上限 + 停止按钮 + 关闭面板时提示"仍有 2 个在运行" |
| 进程树 | 直接复用 `killProcessTree`（`taskkill /F /T`），wrapper shell 下也能真停 |
| 杀软误报 | 临时 exe 落 `%LOCALAPPDATA%` 而不是 `%TEMP%`，Defender 对该路径更宽容 |
| 只读模式 | `settings.readOnlyMode` 下禁用运行按钮（那是"只看不写"模式，语义上不该执行代码） |

### 6.4 不做的事

- 不新增依赖（`x/text` 已在、`go-pty` 与运行通道无关）。
- 不把语言知识搬进 Go（配方在前端，Go 只执行）。
- 不做"打开文件即自动运行"——执行必须来自一次明确的用户动作。

---

## 7. 设置项

新增到 `defaultSettings`（`main.js:3253`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `runAutoSave` | `true` | 有未保存修改时先保存再运行 |
| `runCwd` | `'file'` | `'file'` 文件目录 / `'workspace'` 工作区根 |
| `runArgs` | `{}` | 按格式记住上次参数（面板状态行可临时输入） |
| `runConfigs` | `{}` | 按格式覆盖命令模板（`$FILE $DIR $BASE $EXT` 占位符），V2 |
| `runConfirmSeen` | `[]` | 已确认过"执行本机代码"风险的语言，只提示一次 |
| `runKeepSessions` | `4` | 面板保留的运行标签数 |

设置 → 常用编程语言面板底部加一块「运行」：默认行为、cwd 选择、命令模板覆盖（折叠）+ 「测试运行」按钮（跑一段 `print("ok")` 验证工具链可用）。

---

## 8. 安全模型

与插件安装保持同一套口吻，不夸大也不含糊：

1. **只在用户显式触发时执行**（F5 / 菜单 / 按钮），不做任何内容驱动的自动执行。
2. **首次运行某个语言**弹一次确认：「将以你的权限在本机执行该文件，仅运行你信任的代码」，勾选后写入 `runConfirmSeen` 不再问。
3. **不经 shell 拼接**：`exec(exe, args...)`，杜绝命令注入。
4. **私密环境变量会注入**（与终端一致，用户需要知道），设置页已明示该行为。
5. **操作留痕**：每次运行写一条 `activity.log('code.run', 文件名, {lang, code, ms})`，只记摘要不记输出正文（沿用 `activity.go` 的脱敏原则）。
6. 运行不写源文件——除了"先保存"那一步，而那是用户自己的未保存修改。

---

## 9. 边界与已知限制（写进 UI，不藏着）

- 无 stdin：`input()` / `prompt()` 会立刻拿到 EOF 报错，不是卡死。面板给一行提示「该程序在等待输入（暂不支持交互）」。
- 单文件：不做工程构建。目录里有 `go.mod` / `package.json` / `Cargo.toml` 时只提示"检测到项目文件，v1 只运行当前文件"。
- 临时副本：同目录依赖与相对路径会失效（§4）。
- 无调试：不给断点、变量面板、步进。
- 只支持本机（不做远程/容器）。

---

## 10. 分期

### V1（建议先做，约 1 天）

- 解释型 8 类（python / node / go run / java / php / ruby / lua / shell 系）
- `run` 面板 + 停止 + 退出码 + 耗时 + `path:line:col` 跳转 + ANSI 子集
- 自动保存、临时副本、首次确认、activity 留痕
- `run_test.go` + 手动验收清单

### V2（约 0.5 天）

- 编译型 C/C++/Rust（两段式）
- 参数输入、命令模板覆盖、`测试运行`
- stdin 单行输入框（可选接 `RunInput`）

### V3

- 失败时「把输出发给 AI 分析」——复用现有 AI 面板，输入框预填「这段运行输出是什么问题」+ 输出尾部 200 行，成本极低、感知价值高
- 项目感知运行（`npm start` / `go run .` / `cargo run`）
- 运行配置命名保存（多套参数）

---

## 11. 验收清单

| # | 场景 | 期望 |
|---|---|---|
| 1 | 打开 `hello.py`（无修改）按 F5 | 面板出现输出，退出码 0，耗时可读 |
| 2 | 同上但 Python 未安装 | 面板提示"未检测到 Python"，给跳设置按钮，不弹异常 |
| 3 | `import` 同目录模块的 py 有未保存修改 | 默认先保存，运行成功 |
| 4 | 关掉 `runAutoSave` 再跑同一文件 | 走临时副本，面板标"临时副本"，`import` 失败并说明原因 |
| 5 | 中文 Windows 下 gcc 编译报错 | 中文乱码不出现（GBK 已转码），报错行可点击跳转 |
| 6 | `while True: pass` | 停止按钮 1 秒内结束，进程树无残留（任务管理器确认） |
| 7 | `node server.js` 长驻 | 面板显示运行中，再按 F5 起第二个，互不干扰 |
| 8 | 打开 `.json` 按 F5 | 按钮禁用，菜单项灰显 |
| 9 | 只读模式下按 F5 | 拒绝执行并说明原因 |
| 10 | 打开 `.bat` 含中文路径与空格 | 正常执行（引号处理正确） |
| 11 | `file:line` 链接点击 | 跳到对应标签页的对应行列 |
| 12 | 单次输出 20 MB（`dir /s`） | 到 8 MB 截断并提示，UI 不卡 |

---

## 12. 与项目约定的一致性

- **体积增量：0**——不引新依赖（`x/text` 已在），复用 xterm 之外的纯 DOM。
- 代码放新文件（`run.js` / `run.go`），不往 `main.js` 的格式分支里加东西。
- 平台相关成对：`run_windows.go` + `run_other.go`。
- 用户可见改动同步 `CHANGELOG.md` 与 `README.md`；实施完成后本文移入 `docs/finished-plans/`。
- 版本号三处同步（`app.go` / `wails.json` / NSIS）。
