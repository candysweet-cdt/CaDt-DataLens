# CaDt-DataLens 示例数据

用于演示和测试 CaDt-DataLens 支持的文件格式。全部内容为**合成示例**，不代表任何真实项目数据。

## 使用方式

- 在应用中选择「文件 → 打开文件夹…」，选中本目录即可在侧边栏浏览。
- 也可以直接拖入单个文件，或把本目录拖进窗口。
- `json/long-blueprint.json` 约 211 KB、4944 个方块，包含长数组、长字符串和 12 层嵌套元数据，适合测试滚动、树展开和代码视图自动换行。

## 目录

| 目录 | 内容 |
| --- | --- |
| `json/` | 基本 JSON、单行 JSON、12 层深嵌套、约 211 KB 长蓝图；`.jsonc` / `.json5` 扩展名示例；`sample.jsonl` 演示 JSON Lines（每行一个 JSON 值，也支持 `.ndjson`） |
| `yaml/` | 基本 YAML、10 层嵌套 YAML、应用配置（`.yml`） |
| `xml/` | 带属性的 XML、10 层嵌套 XML、SVG 示例 |
| `csv/` | 基本 CSV、带逗号/引号/换行的 CSV、500 行 CSV、TSV |
| `text/` | 文本/代码扩展各一份：txt、log、conf、html、htm、css、js、ts、py、sh、bat、ps1、go、java、kt、lua、sql；`go.mod` / `go.sum`、`main.cpp`、`Program.cs`、`lib.rs`、`index.php`、`Dockerfile`、`Makefile`、`CMakeLists.txt`、`.gitignore` 演示对应语言的代码视图语法高亮；`config.toml`、`app.properties`、`settings.ini`、`device.cfg` 以树视图打开；`markdown-demo.md` 演示预览、代码块高亮和数学公式 |
| `binary/` | PNG、JPEG/JPG/JFIF、GIF、BMP、WebP、ICO、TIF/TIFF、AVIF；`magic-image.dat` 是改扩展名的 PNG，用于测试文件头识别；`sample.bin` 是包含控制字节的任意数据，会按二进制十六进制视图展示 |

## 说明

- `.jsonc` / `.json5` 示例采用标准 JSON 语法，确保树视图可以直接解析；注释/尾逗号可在代码视图或文本视图中查看和编辑。
- `sample.jsonl` 每行是一个独立的 JSON 值（对象、数组或标量均可），空行会被忽略；保存时会写回一行一个 JSON 值。
- 图片文件是生成的小尺寸样本；应用默认显示图片视图，可在视图菜单切换到只读二进制视图。
- 长日志、PDF/压缩包等未列出的二进制类型不属于支持的格式，应用会按普通文本打开。
