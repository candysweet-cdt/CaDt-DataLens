# CaDt-DataLens 命令行完整参考

面向 AI agent 与脚本调用。程序为 Windows GUI 单 exe，启动后常驻，所有调用都应以后台方式启动（见下）。

## 启动方式（避免阻塞）

GUI 进程不会退出，同步调用会一直等待。请使用：

- PowerShell：`Start-Process -FilePath "<exe>" -ArgumentList "<文件>",...`
- CMD：`start "" "<exe>" <文件>...`
- Bash：`<exe> <文件>... &`

若已通过应用「设置 → 系统集成 → 注册 datalens 命令」把 exe 目录加入用户 PATH，`<exe>` 可直接写 `datalens`（对注册之后新开的终端生效）。

## 参数一览

| 参数 | 简写 | 说明 |
| --- | --- | --- |
| `<路径>` | — | 文件或目录，可传多个；目录以左侧文件树打开 |
| `--line <N>` | `-l <N>` / `--line=<N>` | 跳转到第 N 行并整行选中（作用于紧随其后的路径；若之后没有路径则作用于最后一个路径） |
| `--column <N>` | `-c <N>` / `--column=<N>` | 在行内再定位列（1 起）；可单独使用，也可与 `--line` 组合 |
| `--goto` | `-g` | 兼容 VS Code 风格的标记参数，本身无效果 |
| `--new-window` | — | 强制开新窗口；缺省时单窗口模式复用已开窗口的标签页 |

未知参数（以 `-` 开头且不匹配已知参数）会被忽略；行号/列号必须为正整数，非法值按 0 处理（即不定位）。

## `文件:行:列` 语法

`a.json:42` → 第 42 行；`a.json:42:8` → 第 42 行第 8 列。

仅当整个参数作为路径不存在时才尝试按 `:行(:列)` 拆分，且拆分出的前缀必须真实存在——带冒号的真实路径（如 UNC 路径）不受影响。

## 单实例与多窗口

- 默认「单窗口标签页」模式：程序已在运行时，新调用把**文件**转交给已有窗口（追加标签页并置前），本进程随即退出。
- **目录遵循「一目录一窗口」**：转交目标为目录时——接收窗口没有打开目录则本窗口打开；与接收窗口目录相同则提示已打开；不同目录自动开独立新窗口。
- 「多窗口」模式（设置 → 系统集成）：每次调用启动独立窗口进程。
- `--new-window` 在任何模式下都强制新窗口。

## 打开行为

- **格式**：JSON/JSONC/JSON5、JSONL/NDJSON、YAML、XML/SVG、CSV/TSV、Markdown、TOML、INI/Properties/conf/cfg、纯文本/日志、常见代码文件、图片（PNG/JPEG/GIF/BMP/WebP/ICO/TIFF/AVIF）、未知二进制（只读 hex）。
- **默认视图**：JSON 系→树视图；CSV/TSV→表格视图；Markdown→预览；txt/log/conf→记事本式文本；图片→图片视图；其余代码→代码视图；均可在界面右上切换。
- **大文件**：>10 MB 只读；>100 MB 拒绝打开。
- **编码**：自动识别 UTF-8/GBK，可手动切换；保存时按原编码与 EOL 写回。
- **未保存确认**：关闭有修改的文件会弹确认框，agent 无需处理。

## 示例

```powershell
# 打开当前目录下的配置并定位到 errors 数组第 3 条
Start-Process -FilePath "D:\tools\datalens.exe" -ArgumentList "D:\mod\blueprint.json","--line","120"

# 同时打开多个蓝图
Start-Process -FilePath "D:\tools\datalens.exe" -ArgumentList "a.json","b.jsonl","D:\mod\blueprints"

# 强制新窗口对比两个文件
Start-Process -FilePath "D:\tools\datalens.exe" -ArgumentList "--new-window","old.json"
Start-Process -FilePath "D:\tools\datalens.exe" -ArgumentList "--new-window","new.json"
```

## 退出码

无特殊退出码；程序常驻时由用户手动关闭。后台启动的调用立即返回。
