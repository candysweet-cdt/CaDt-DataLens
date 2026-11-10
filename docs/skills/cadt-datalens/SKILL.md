---
name: cadt-datalens
description: 用 CaDt-DataLens 在 Windows 上为用户打开和查看本地数据文件（JSON/JSONL/YAML/XML/SVG/CSV/TSV/TOML/INI/Markdown/常见代码/图片/二进制），支持命令行直接跳转到指定行:列并整行高亮。当用户要求"打开/查看/预览某个本地文件"、"看第 N 行/定位某行"，或你想让用户在图形界面里检查某个文件时使用。
---

# CaDt-DataLens 文件查看器

CaDt-DataLens 是 Windows 桌面端多格式数据查看器（Wails 单 exe，免安装）。当用户要求打开/查看本地文件时，直接用命令行启动它，用户就能在图形界面里浏览；支持树视图、表格视图、代码高亮、Markdown 预览、图片缩放、二进制十六进制视图、分栏对比与结构大纲，还内置 AI 助手面板。

## 本机程序路径

{{EXE_PATH}}

（此路径由「注册全局 Skill」功能在注册时写入；程序移动位置后请在设置里重新注册。）

若已在应用「设置 → 系统集成 → 注册 datalens 命令（加入用户 PATH）」注册过，新开终端里可直接用 `datalens` 代替完整路径。

## 什么时候用

- 用户要求"打开 / 查看 / 预览"本地文件：JSON、JSONL/NDJSON、YAML、XML、SVG、CSV/TSV、TOML、INI/Properties/conf/cfg、Markdown、纯文本/日志，以及常见代码文件（C/C++、C#、Go、Java、Kotlin、Python、JS/TS、Rust、Ruby、PHP、Lua、SQL、Shell、PowerShell、Batch 等）。
- 用户想"看第 N 行"或"定位到某行某列"：用 `--line` / `--column` 或 `文件:行:列` 语法，打开后自动跳转并整行选中。
- 大文件：超过 10 MB 自动转只读，超过 100 MB 拒绝打开；解析失败或未知扩展名会按纯文本打开，不会报错中断。

## 重要：不要阻塞你的流程

这是 GUI 程序，启动后不会退出。**必须以后台方式启动**，否则你的命令会一直挂起等它退出：

- PowerShell：`Start-Process -FilePath "{{EXE_PATH}}" -ArgumentList "C:\data\a.json","--line","42"`
- CMD：`start "" "{{EXE_PATH}}" "C:\data\a.json" --line 42`
- Git Bash：`"{{EXE_PATH}}" "C:\data\a.json" --line 42 &`

## 基本用法

```text
# 打开单个文件
{{EXE_PATH}} "D:\mod\config.json"

# 打开并定位到第 42 行（整行选中）
{{EXE_PATH}} "D:\mod\config.json" --line 42

# 定位到 第 42 行 第 8 列；两种写法等价
{{EXE_PATH}} "D:\mod\config.json" --line 42 --column 8
{{EXE_PATH}} "D:\mod\config.json:42:8"

# VS Code 风格（--goto 仅作标记，可省略）
{{EXE_PATH}} -g "D:\mod\config.json" -l 42

# 一次打开多个文件（多标签页），目录以文件树打开
{{EXE_PATH}} "D:\mod\config.json" "D:\mod\lang\zh_CN.json" "D:\mod\blueprints"

# 强制开一个新窗口（默认复用已有窗口加标签页）
{{EXE_PATH}} --new-window "D:\mod\config.json"

# 行:列参数放在路径之前也可以，会作用于紧随其后的那个路径
{{EXE_PATH}} --line 12 "a.json" --line 7 "b.json"
```

## 行为细节

- **单实例**：默认（单窗口标签页模式）再次调用会把文件转交给已开的窗口，不会开新进程；「设置 → 系统集成 → 多文件打开 = 多窗口」时每次调用都是独立窗口。`--new-window` 在任何模式下都强制新窗口。
- **一目录一窗口**：参数是目录时——当前窗口没有打开目录则本窗口打开；与当前窗口目录相同则提示已打开；不同目录自动开新窗口（文件树浏览、懒加载、自动刷新）。
- **路径**：支持相对路径与含空格路径（用引号包裹）。
- **`文件:行:列` 语法**：仅当该写法对应的实际文件不存在时才按行号拆分（避免与带冒号的真实路径冲突）；`:行:列` 中行号必须为正整数。
- **未知旗标**（以 `-` 开头且不匹配任何已知参数）会被忽略，不会报错。
- **编码**：默认自动识别 UTF-8 / GBK；EOL 与 BOM 原样保留。
- **只读场景**：全局只读锁、大文件只读都不影响"查看"，只是不能编辑。

## 更多参考

- 命令行完整参考（参数表、边界行为、示例）：[reference/cli.md](reference/cli.md)
