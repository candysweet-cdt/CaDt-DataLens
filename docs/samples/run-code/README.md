# 运行代码示例（F5 / Ctrl+F5）

配套**运行代码**功能的可执行样例：每个文件都能在 CaDt-DataLens 里打开后直接按 `F5` 跑，
用来人工过一遍 `docs/finished-plans/run-code.md` §11 的 20 条验收清单。全部为合成示例，
只打印文本、读写本目录内的数据文件，不联网、不改动仓库里的其他文件。

## 前置条件

- 用「文件 → 打开文件夹…」选中 `docs/samples/run-code/`，或直接拖入单个文件。
- 语言环境要本机已安装，并在 **设置 → 编程语言** 里扫描过（没扫过时按 F5 会现场扫一次）。
  可在 **设置 → 运行** 里用「验证运行环境」先自检，面板会直接给「自检通过 / 未通过」结论。
- 只读模式下运行被禁用；首次运行某种语言会弹一次风险确认。
- 特定版本要求：`.ts` 需要 Node 22.6+（`--experimental-strip-types`）、Java 需要 JDK 11+
  （单文件源码启动）、C/C++ 需要 `gcc` / `g++`、Rust 需要 `rustc`、`.sh` 需要 Git Bash、
  `projects/make/` 需要系统里有 `make`。缺哪个面板会明确说，不会自动安装。

## 一、基础语言：打开 → F5 → 退出码 0

| 文件 | 说明 |
| --- | --- |
| `hello.py` | Python，附版本号与参数回显（清单 #1） |
| `hello.js` / `hello.ts` | Node.js / TypeScript 原生类型剥离 |
| `hello.go` | `go run` |
| `Hello.java` | 单文件源码启动，不产 `.class`；public 类名与文件名必须一致 |
| `hello.c` / `hello.cpp` / `hello.rs` | 两段式：先编译到应用数据临时目录，成功才运行 |
| `hello.bat` / `hello.ps1` / `hello.sh` | 批处理 / PowerShell / Git Bash；`%*`、`$args`、`$*` 接收参数 |
| `hello.php` / `hello.rb` / `hello.lua` | PHP / Ruby / Lua |

打开 `data.csv` 按 F5 应提示「该格式不支持运行」，活动栏 ▶ 与工具菜单同时灰显（清单 #8）；
打开设置切到只读模式再按 F5 应被拒绝（清单 #9）。

## 二、场景用例

| 文件 | 怎么跑 | 预期（清单编号） |
| --- | --- | --- |
| `read-data.py` | 直接 F5 | 打印 `cwd` 与 `data.csv` 三行合计，证明工作目录 = 文件所在目录（#3） |
| `args-echo.py` | 面板「运行参数」填 `--name "hello world" 42`，回车 | 3 个参数，`hello world` 不被空格切开；参数只进执行步骤 |
| `stdin-echo.py` | F5 后在 stdin 框发两行，再点 `EOF` | 每行被回显，点 EOF 后正常退出（#13）；不点 EOF 会一直等 |
| `long-running.py` | F5 后按 `Shift+F5` | 1 秒内结束、进程树无残留（#6）；也可再按一次 F5 验证多任务并存（#7） |
| `traceback.py` | F5 | 非零退出；点报错里的 `File "...", line N` 跳到对应源码行 |
| `compile-error.c` | F5 | 编译失败停在编译输出，不进入运行；点 `compile-error.c:6:xx` 跳转，中文 gcc 报错不乱码（#5） |
| `exit-code.py` | F5，再点状态行「发给 AI 分析」 | 退出码 3、stderr 标色；AI 输入框被预填但**不会自动发送**（#17） |
| `ansi.py` | F5 | 基础 8 色、粗体 / 暗淡 / 下划线跟随主题 |
| `gbk-output.py` | F5 | GBK 字节被自动转码，中文正常而不是 `?` 或 `ï¿½` |
| `large-output.py` | F5（约 10 MB，会跑几秒） | 到 8 MB 插入截断提示，界面不卡（#12） |

还可以这样组合验证：

- **命名配置**：给 `args-echo.py` 填好参数 → 设置 → 运行 里输入名字点「保存当前配置」→
  再存一套不同参数 → 在面板顶部下拉来回切换，参数框随之载入（#20）。
- **命令模板**：设置 → 运行 选 Python，填 `$TOOL -u $FILE $ARGS` → 跑 `hello.py`，
  命令与默认一致；把路径换成含空格的目录再跑，验证占位符不会被切开（#15）。
- **自检**：设置 → 运行 挑一种语言点「运行自检脚本」；把该语言的环境路径临时改错再跑一次，
  应给出「未检测到环境」与自检未通过结论（#16）。
- **未保存修改**：随便改一行 `hello.py` 不保存按 F5，弹窗三选一；勾「记住」可固定策略。
- **临时副本**：选「临时副本运行」，面板会标注同目录依赖可能失效；此时跑 `read-data.py`
  读不到 `data.csv` 就是预期行为（#4）。

## 三、项目感知运行（Ctrl+F5）

打开 `projects/<kind>/` 里的任意文件，按 `Ctrl+F5`，面板顶部会出现项目根与候选命令，
**点「执行」之后才会启动**（每次都要确认，不记住）：

| 目录 | 探测标记 | 候选命令 |
| --- | --- | --- |
| `projects/node/` | `package.json` | `npm start`、`npm run dev`（验证一次探测出两条） |
| `projects/go/` | `go.mod` | `go run .` |
| `projects/rust/` | `Cargo.toml` | `cargo run` |
| `projects/python/` | `pyproject.toml` + `main.py` | `python main.py` |
| `projects/make/` | `Makefile` | `make`（Windows 通常需自行安装） |

执行后输出里的 `cwd` 应是该子目录，即项目根（#18）。

> **注意边界**：从 `run-code/` 根目录的文件按 `Ctrl+F5` 会一路向上命中**仓库根的 `go.mod`**
> （仓库根有 `.git`，是设计的停止点），这是正确行为而不是误报；想测某个子项目，请从
> `projects/<kind>/` 里的文件触发。探测遇到用户主目录会直接停止，避免主目录里无关的
> `package.json` 被当成项目（#19）。

## 说明

- 编译产物、临时副本、自检脚本都落在 `%APPDATA%\CandySweet\CaDt-DataLens\run\`，
  不污染本目录；超过 7 天的残留会在应用启动时清理。
- `hello.sh` 必须是 LF 行尾，目录里的 `.gitattributes` 已固定；若手动改成 CRLF，
  Git Bash 会把 `\r` 当成命令的一部分报错。
- `compile-error.c` 与 `traceback.py`、`exit-code.py`、`long-running.py` 都是**故意失败 / 故意不结束**的，
  用来验证失败与停止路径，不是样例写错了。
