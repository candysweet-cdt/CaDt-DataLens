# 运行代码方案与实施记录

> 状态：**V1 / V2 / V3 全部已实施（2026-11-13）** · 方案日期：2026-11-13 · 归属版本：**未发布**（CHANGELOG 的「未发布」段；发版时再同步 `app.go` / `wails.json` / NSIS 版本号）
> 范围：单文件运行（解释型 + 编译型）+ 运行输出面板 + stdin + 命令模板 / 自检 + AI 联动 + 项目感知运行 + 命名配置。
> 实施记录见 §13（V1 与收尾补齐）、§14（V2/V3）。
> 未做的只剩：完整交互终端（光标控制 / 密码回显等）、命令模板的可视化向导、项目命令自定义持久化。
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
| 有未保存修改 | **弹窗三选一**：保存并运行 / 临时副本 / 取消（可记住） | 作者决定：自动保存太武断，让用户当次选；记住后不再问 |
| cwd | 文件所在目录（设置可切工作区根） | 数据查看器场景要读旁边的数据文件 |
| 并发 | 最多 3 个运行并存，面板按标签切换 | 长驻服务（`node server.js`）不会挡住下一次运行 |
| stdin | **V2 接管单行输入**：`os.Pipe` + 缓冲队列，面板逐行发送 / `EOF` 结束 | 子进程不读 stdin 也不能阻塞 UI 或 `cmd.Wait()`；V1 曾刻意留空（读到 EOF） |
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
| 运行面板 | `Alt+F11` |
| 运行项目 | `Ctrl+F5`（V3） |
| 清空输出 | 面板按钮 |
| 菜单 | `工具(U) → 运行当前文件` |
| 工具栏 | 代码类格式下，标题栏右侧出现 ▶（非代码格式隐藏，不做常驻） |

> 注意：`F5` 在部分浏览器内核里是刷新，Wails 下 WebView2 不会劫持，但要在 `keydown` 里 `preventDefault()`。

---

## 6. 后端改动

### 6.1 新增文件

| 文件 | 内容 |
|---|---|
| `run.go` | `PrepareRun` / `RunExec` / `RunStop` / `GetRunTempDir` / `CleanupRunTemp` / `CleanupRunTempStale`；输出合并器 `runStream`、GBK 解码、PATH 前置 |
| `run_shells_windows.go` | `resolveRunShell`：复用终端面板的 `findGitBash` / `findPwsh`，不另写一套探测 |
| `run_shells_other.go` | 非 Windows 返回"暂只支持 Windows"（保持成对约定） |
| `run_test.go` | 文件名净化、GBK 解码、PATH 前置、临时副本 / 编译临时目录、清理闸门、输出切分与截断、`cmd.exe` 端到端 |

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
| `runDirtyMode` | `'ask'` | `ask` 每题都问 / `save` 总是保存 / `temp` 总是临时副本 |
| `runCwd` | `'file'` | `'file'` 文件目录 / `'workspace'` 工作区根 |
| `runArgs` | `{}` | 按语言记住面板参数原文（回显用，执行时拆 argv） |
| `runConfigs` | `{}` | 按语言覆盖完整命令行模板（`$TOOL $FILE $DIR $BASE $STEM $EXT $OUT $ARGS`） |
| `runProfiles` | `[]` | 命名运行配置：`{id, name, lang, args, template}` |
| `runActiveProfile` | `''` | 面板顶部当前选中的配置 id，空为默认 |
| `runConfirmSeen` | `[]` | 已确认过"执行本机代码"风险的语言，只提示一次 |
| `runKeepSessions` | `4` | 面板保留的运行标签数 |

设置 → 运行 独立面板：工作目录、未保存修改策略、命令模板覆盖、自检脚本、命名配置、首次确认重置、临时目录。运行面板头部放参数框、配置下拉与 stdin 条。

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

- stdin 只支持**逐行输入**，不是完整交互终端（无光标控制、无密码回显关闭）；程序不读 stdin 时队列会报满并提示，不会卡界面。
- 项目运行（V3）只执行探测出来的固定命令，不解析 `package.json` 里的任意脚本、不自动安装依赖；每次都要用户点「执行」确认。
- 临时副本：同目录依赖与相对路径会失效（§4）。
- 无调试：不给断点、变量面板、步进。
- 只支持本机（不做远程/容器）。

---

## 10. 分期

### V1（✅ 已实施）

- 解释型 8 类（python / node / go run / java / php / ruby / lua / shell 系）
- `run` 面板 + 停止 + 退出码 + 耗时 + `path:line:col` 跳转 + ANSI 子集
- 自动保存、临时副本、首次确认、activity 留痕
- `run_test.go` + 手动验收清单

### V2（✅ 全部已实施）

- ✅ 编译型 C/C++/Rust（两段式）
- ✅ 参数输入（面板输入框、按语言记住、引号/转义解析、shell 类同样接收）
- ✅ 命令模板覆盖（占位符解析不经 shell）与「验证运行环境」自检脚本
- ✅ stdin 单行输入框（`RunInput` / `RunEndInput`）

### V3（✅ 全部已实施）

- ✅ 失败时「把输出发给 AI 分析」——复用 AI 面板，只预填输入框不自动发送；尾部 200 行 / 12000 字符上限
- ✅ 项目感知运行（`npm start` / `go run .` / `cargo run` …），`Ctrl+F5` + 面板内确认
- ✅ 运行配置命名保存（多套参数与模板预设）

---

## 11. 验收清单

手工验收请直接用 `docs/samples/run-code/` 里的可执行样例，该目录的 `README.md` 逐条对应下表，
并标了每项需要填的参数 / 点的按钮。

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
| 13 | `input()` 程序按 F5 | 出现 stdin 条，发一行后程序读到并继续；点 EOF 后正常退出 |
| 14 | 程序完全不读 stdin，连发 40 行 | 提示输入队列已满，界面不卡，可停止 |
| 15 | 设置 → 运行 写模板 `$TOOL -u $FILE $ARGS` | 运行命令与默认一致；路径含空格不被切开 |
| 16 | 自检脚本（如 Python 未装） | 面板明确给出「未检测到环境」与自检未通过结论 |
| 17 | 失败输出点「发给 AI 分析」 | AI 输入框被预填，未自动发送模型请求 |
| 18 | `Ctrl+F5` 在有 `package.json` 的项目里 | 面板列出 `npm start`，点「执行」后才跑，cwd=项目根 |
| 19 | 用户主目录有无关 `package.json` | 探测到主目录即停，不误报为项目 |
| 20 | 保存两套命名配置并切换 | 参数框与模板随之载入，删除后下拉同步 |

---

## 12. 与项目约定的一致性

- **体积增量：0**——不引新依赖（`x/text` 已在），复用 xterm 之外的纯 DOM。
- 代码放新文件（`run.js` / `run.go`），不往 `main.js` 的格式分支里加东西。
- 平台相关成对：`run_windows.go` + `run_other.go`。
- 用户可见改动同步 `CHANGELOG.md` 与 `README.md`；实施完成后本文移入 `docs/finished-plans/`。
- 版本号三处同步（`app.go` / `wails.json` / NSIS）。

---

## 13. 实施记录（2026-11-13）

实际落地与上面的方案有 5 处偏离，均记录在此，避免以后对不上：

| 项 | 方案 | 实际 | 原因 |
|---|---|---|---|
| 未保存修改 | 默认先保存（开关） | 弹窗三选一 + 可记住（`runDirtyMode`） | 作者决定：自动保存太武断 |
| 编译型语言 | 排 V2 | 随 V1 一起做 | 作者决定 |
| 重跑上次命令 / 项目运行 | `Ctrl+F5` | 不做「重跑上次」；`Ctrl+F5` 改给 V3 项目运行 | 面板已能改参数并回车重跑；项目感知运行需要一个独立且不冲突的入口 |
| 临时目录 | `%LOCALAPPDATA%` | `%APPDATA%\CandySweet\CaDt-DataLens\run\` | 沿用 `appDataRoot()`，与项目其他数据同处 |
| 平台文件 | `run_windows.go` + `run_other.go` | `run_shells_windows.go` + `run_shells_other.go` | 只有 shell 解析涉及平台；其余复用 `commands.go` 已有的 Windows 能力 |

新增文件：`run.go`、`run_shells_windows.go`、`run_shells_other.go`、`run_test.go`、`frontend/src/run.js`、`frontend/src/run.test.mjs`。

改动文件：`app.go`（启动时空跑一次 `CleanupRunTempStale`）、`frontend/src/main.js`（设置默认值与归一化、`dockView='run'`、F5/Shift+F5/Alt+F11、工具菜单三项、运行控制器接线、dirty / 首次确认对话框、`openDocAtLocation`、`ensureToolchainForRun`、`runArgsText` / `setRunArgs`）、`frontend/index.html`（运行面板、参数输入框、活动栏 ▶、两个对话框、设置 → 运行、快捷键说明）、`frontend/src/style.css`（`.run-*`）、`package.json`（test 脚本加入 run.test.mjs）。

V1 收尾时验证：`go build ./...`、`go test ./...`（13 s 全绿）、`npm test`（137 通过）、`npm run build`、`wails build -s` 均通过。V2/V3 后的最新数据见 §14。

已知未覆盖：GUI 内的实际点击链路未做自动化冒烟（本机无头截图不稳定），需人工过一遍 §11 的 12 条验收清单。

### 13.1 收尾补齐（同日）

首次自验收收发现四处「有实现没接通」，已全部补上：

| 断点 | 症状 | 补法 |
|---|---|---|
| `settings.runArgs` 是死配置 | 只有 `argsFor` 读取端，没有任何写入端，参数永远是空数组；面板里 `#run-args-input` 也只是一段孤立 DOM | `run.js` 的 `splitRunArgs` 解析引号/转义并保留 Windows 反斜杠路径；输入框 `input` 事件按语言记住（防抖 400 ms 落盘）、回车直接运行、切标签回显；`main.js` 提供 `argsText` / `setArgs` |
| 脚本类不收参数 | `.bat/.cmd/.ps1/.sh` 等配方丢弃 `c.args` | 9 条 shell 配方全部补 `...c.args`；编译步骤仍不带参数 |
| 7 天自动清理从未触发 | `CleanupRunTempStale` 有实现有测试，但全项目无调用点，设置页与 CHANGELOG 却已承诺自动清理 | `app.go` 的 `startup()` 里异步跑一次（幂等、失败不影响启动、多窗口重复无害） |
| 活动栏 ▶ 不随文件变 | 工具菜单有灰显，活动栏按钮始终可点（点了才提示不支持），与 §11 验收第 8 条不符 | `syncRunButtonState()` 在标签渲染、只读切换、初始化时同步 `disabled` 与 `title` |

补齐后新增 5 个前端测试块（`splitRunArgs` 3 组 + 配方参数 2 组），`npm test` 132 → 137 全绿。

---

## 14. V2 / V3 实施记录（2026-11-13）

起点：V1 提交 `fc8d857`（`feat(run-code): F5 运行代码、运行输出面板与参数输入`），在其之上继续。作者要求「开始前先 commit」，所以 V2/V3 的改动与该提交分离。

| 块 | 落地 | 关键取舍 / 踩到的坑 |
|---|---|---|
| V2-a stdin | `run.go` 加 `runStdin`（`os.Pipe` + 32 行队列 + pump goroutine）、`RunInput` / `RunEndInput`；运行面板加 stdin 条，编译阶段隐藏，输入回显 | 用 `os.Pipe` 而非 `io.Pipe`：`cmd.Stdin` 是 `*os.File` 时 `os/exec` 不另起 copy goroutine，`cmd.Wait()` 不依赖我们何时关写端。正常 EOF 走 `eof` channel 让 pump **先排空队列再关**，进程退出才强制关 fd 唤醒阻塞的 Write——第一版直接 `close(done)` 会丢掉刚入队的那行，被自举辅助进程测试抓到 |
| V2-b 模板与自检 | `applyRunTemplate` 纯函数（先 `splitRunArgs` 再逐 token 替换，`$ARGS` 展开成多个 argv）；抽出 `makeSteps` 供正常运行 / 自检 / 项目运行共用；`SELF_TEST` 15 段最小脚本 | 模板是完整命令行，占位符值永远是「一个 argv」，路径含空格不会被切开，全程不经 shell。自检**忽略用户模板**，验证的是工具链本身；临时副本落在应用数据目录，不碰用户文件 |
| V3-a AI 联动 | `ai-panel.js` 加 `bridgeSetDraft`（只填输入框、触发原生 `input` 事件、不发送）；`buildRunAnalysisPrompt` 纯函数（尾部 200 行 / 12000 字符） | 模型调用是外部付费动作，坚持「预填不自动发送」，发送权留给用户 |
| V3-b 项目运行 | `run_project.go` 的 `DetectRunProject`（向上 8 层、遇 `.git` / 用户主目录停止、只读探测）；`Ctrl+F5` + 运行面板内确认条 | 不用弹窗：面板确认条更贴合「列出命令再确认」，也绕开对话框体系的 Promise 悬空坑。测试抓到**用户主目录里的 `package.json` 被误判为项目**，才补上 home 边界；命令每次都要点「执行」，不记住 |
| V3-c 命名配置 | `settings.runProfiles` / `runActiveProfile`，设置页增删、面板顶部下拉载入 | 配置是**预设**而非运行时分支：选中即把参数与模板载入当前语言，面板里看到的仍是这次真正会用的值，避免「显示一套、跑另一套」 |

新增文件：`run_project.go`、`run_project_test.go`。

改动文件：`run.go` / `run_test.go`（stdin）、`frontend/src/run.js`（模板、自检、项目、AI、配置、stdin）、`frontend/src/main.js`（设置、快捷键、菜单、mock、AI 桥接）、`frontend/src/ai-panel.js`（draft 桥）、`frontend/index.html`、`frontend/src/style.css`、`frontend/wailsjs/`（重新生成绑定）、README / CHANGELOG / AGENTS.md。

验证：`go test ./...` 13.8 s 全绿（新增 stdin 2 例、项目探测 4 组）、`npm test` **143 通过**（新增模板 4 组、AI 提示词 2 组）、`npm run build`、`wails build -s -devtools` 成功（产物 `build/bin/CaDt-DataLens.exe`）。

已知未覆盖：GUI 点击链路仍未自动化冒烟，§11 新增的第 13–20 条需人工过一遍；项目命令在 Windows 上依赖 `npm.cmd` / `make` 等能被 `exec.LookPath` 找到，缺失时面板显示启动失败而不是预先禁用；stdin 不是完整交互终端（无光标控制 / 密码回显关闭）。
