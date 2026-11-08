# CaDt-DataLens 示例数据

用于演示和测试 CaDt-DataLens 支持的文件格式。全部内容为**合成示例**，不代表任何真实项目数据。

## 使用方式

- 在应用中选择「文件 → 打开文件夹…」，选中本目录即可在侧边栏浏览。
- 也可以直接拖入单个文件，或把本目录拖进窗口。
- `json/long-blueprint.json` 约 211 KB、4944 个方块，包含长数组、长字符串和 12 层嵌套元数据，适合测试滚动、树展开和代码视图自动换行。

## 目录

| 目录 | 内容 |
| --- | --- |
| `json/` | 基本 JSON、单行 JSON、12 层深嵌套、约 211 KB 长蓝图；`.jsonc` / `.json5` 扩展名示例 |
| `yaml/` | 基本 YAML、10 层嵌套 YAML、应用配置（`.yml`） |
| `xml/` | 带属性的 XML、10 层嵌套 XML、SVG 示例 |
| `csv/` | 基本 CSV、带逗号/引号/换行的 CSV、500 行 CSV、TSV |
| `text/` | 所有支持的文本扩展各一份：txt、md、markdown、log、ini、properties、conf、cfg、toml、html、htm、css、js、ts、py、sh、bat、ps1、go、java、kt、lua、sql |
| `binary/` | PNG、JPEG/JPG/JFIF、GIF、BMP、WebP、ICO、TIF/TIFF、AVIF；`magic-image.dat` 是改扩展名的 PNG，用于测试文件头识别；`sample.bin` 是任意字节 |

## 说明

- `.jsonc` / `.json5` 示例采用标准 JSON 语法，确保树视图可以直接解析；注释/尾逗号可在代码视图或文本视图中查看和编辑。
- 图片文件是生成的小尺寸样本；应用按扩展名/文件头显示只读十六进制字节数据。
- 长日志、PDF/压缩包等未列出的二进制类型不属于支持的格式，应用会按普通文本打开。
