# CaDt-DataLens

> 轻量的 Windows 多格式数据查看与编辑器。
> A lightweight multi-format data viewer and editor for Windows, built with Wails and jsoneditor.

![主界面](docs/screenshots/main-dark.png)

CaDt-DataLens 用桌面窗口打开 JSON、YAML、XML、CSV 和普通文本，不依赖浏览器，不上传文件，所有读写都在本机完成。

## 功能

### 格式与视图

- 结构化格式：JSON / JSONC / JSON5、YAML / YML、XML / SVG、CSV / TSV。
- 文本格式：txt、md、log、ini、toml、html、css、js、ts、py、go、java、sql 等。
- 三种编辑视图：
  - **树视图**：展开/收起节点，直接编辑键和值。
  - **代码视图**：Ace 编辑器，带行号、语法高亮、括号匹配。
  - **文本视图**：纯文本编辑框，适合看原始内容和最简单的文本修改。
- 每个格式可单独配置默认视图，修改后对当前同类文件立即生效。
- 代码视图支持自动换行开关（设置 → 通用设置或视图菜单），默认关闭，长行横向滚动。
- 图片按扩展名/文件头识别，显示为只读十六进制字节视图（超过 1 MB 截断并注明）。
- 未识别的扩展名按纯文本打开。
- 大于 10 MB 的文件切换为只读代码模式；大于 100 MB 拒绝打开。

### 编辑与文件

- 新建、打开、保存、另存为、保存全部、重新加载、关闭标签。
- 撤销/重做；内容恢复到原版后会自动清除“未保存”标记。
- 文件未编辑时，代码/文本视图保留磁盘原文格式；未修改直接保存也不会重排格式。
- 关闭有未保存修改的标签或窗口时确认。
- 自动保存开关：停止输入 1 秒后静默保存当前文件。
- 打开文件位置、复制文件路径/文件名。
- 拖入一个或多个文件即可打开；支持文件对话框多选，也可以直接打开文件夹。
- 文件侧边栏（`Alt+1`）：列表视图列出当前文件所在目录的数据文件，超过 200 个时提示改用文件树视图；文件树视图按 IDE 风格懒加载目录，支持展开/收起和直接打开文件。
- 右键菜单：标签页可关闭/关闭其他/全部/左侧/未修改、复制路径、在新窗口打开、重新打开关闭的标签页；侧边栏文件或目录可打开、复制路径、在文件管理器中显示、刷新、设为文件树根；代码/文本内容区可剪切复制粘贴、查找、格式化、重新加载、折叠。
- 设置 → 系统集成：可把当前程序注册到注册表（加入 JSON/YAML/XML/CSV/文本等格式的“打开方式”）和资源管理器右键菜单（文件/文件夹/文件夹空白处）；只写 HKCU，无需管理员权限，默认程序仍需在 Windows 中确认。
- UTF-8 / GBK / GB18030 / ISO-8859-1 / US-ASCII 编码，自动检测；保留原文件换行符与 UTF-8 BOM。
- 大文件与二进制文件自动只读。

### 外观

- 10 套配色：深色、浅色、Darcula、IDEA Dark、IDEA Light、Github、Newsprint、Night、Pixyll、Whitey。
- 内置字体：Inter、JetBrains Mono、Fira Code。
- 界面字体、编辑器字体、界面中文字体、编辑器中文字体可分别选择，并带实时预览。
- 固定键列与键列宽度可调。
- 编辑器字号 9–24，可用 `Ctrl+滚轮` 调整。
- 所有设置本地持久化。

### 多文件

- **单窗口标签页**：类似代码编辑器的多标签体验，每个标签保留自己的视图、滚动位置和撤销历史。
- **多窗口**：每个文件使用独立窗口；适合并排对照多个文件。
- 在设置 → 通用设置 → “多文件打开”中切换。

## 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 新建 | `Ctrl+N` |
| 新建窗口 | `Ctrl+Shift+N` |
| 打开 | `Ctrl+O` |
| 保存 | `Ctrl+S` |
| 另存为 | `Ctrl+Shift+S` |
| 关闭标签 | `Ctrl+W` |
| 设置 | `Ctrl+,` |
| 撤销 / 重做 | `Ctrl+Z` / `Ctrl+Y` |
| 格式化 | `Ctrl+Alt+L` |
| 文件侧边栏 | `Alt+1` |
| 重新打开关闭的标签页 | `Ctrl+Shift+T` |
| 当前文件在新窗口打开 | `Shift+F4` |
| 搜索节点 | `Ctrl+F`（树视图） |
| 展开 / 收起节点 | `Ctrl+=` / `Ctrl+-` |
| 全部展开 / 收起 | `Ctrl+Shift+=` / `Ctrl+Shift+-` |
| 调整编辑器字号 | `Ctrl+滚轮` |

## 支持的文件类型

| 类型 | 扩展名 | 默认处理 |
| --- | --- | --- |
| JSON | `.json` `.jsonc` `.json5` | 树视图 / 代码视图 / 文本视图 |
| YAML | `.yaml` `.yml` | 树视图 / 代码视图 / 文本视图 |
| XML | `.xml` `.svg` | 树视图 / 代码视图 / 文本视图 |
| CSV | `.csv` `.tsv` | 树视图 / 代码视图 / 文本视图 |
| 文本 | `.txt` `.md` `.log` `.ini` `.toml` `.html` `.css` `.js` `.ts` `.py` `.go` `.java` `.sql` 等 | 代码视图 |
| 图片 | `.png` `.jpg` `.jpeg` `.gif` `.bmp` `.webp` `.ico` `.tif` `.tiff` `.avif` `.heic` `.psd` 等 | 只读字节数据 |
| 其他 | 任意扩展名 | 纯文本 |

## 示例数据

`docs/samples/` 按格式提供可直接打开的合成示例，说明见 [示例说明](docs/samples/README.md)。包含 12 层嵌套 JSON、约 211 KB / 4944 个方块的长蓝图、长日志、CSV、SVG，以及 PNG/JPEG/GIF/BMP/WebP/ICO/TIFF/AVIF 和原始字节等二进制样本。

## 构建

前置条件：

- Windows 10/11（需要 WebView2 Runtime）。
- Go 1.26+。
- Node.js 20.19+（或 22.12+）。
- Wails CLI v2.17.1+。

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.1
git clone https://github.com/candysweet-cdt/CaDt-DataLens.git
cd CaDt-DataLens
wails build
```

产物在 `build/bin/CaDt-DataLens.exe`。可以运行 `wails doctor` 检查环境。

## 开发

```bash
wails dev
```

前端也可以单独在浏览器里用 mock 数据调试：

```bash
cd frontend
npm install
npm run dev
```

打开 `http://localhost:5173/`。可用的 mock 场景：`?yaml`、`?xml`、`?csv`、`?text`、`?image`、`?large`、`?invalid`、`?multi`、`?empty`、`?gbk`。mock 路径使用 `mock://samples/`，不会读写真实磁盘文件。

## 项目结构

```text
app.go                     Go 后端：文件读写、编码、剪贴板、系统操作
main.go                    Wails 配置、单实例/多窗口启动
app_test.go                Go 单元测试
frontend/src/main.js       界面、标签页、设置、编辑器、文件菜单
frontend/src/formats.js    格式驱动（JSON/YAML/XML/CSV/文本/字节）
frontend/src/style.css     布局、主题、Ace/jsoneditor 样式
frontend/index.html        窗口结构、菜单、设置对话框
frontend/public/vendor     jsoneditor 及图标资源
frontend/public/fonts      Inter / JetBrains Mono / Fira Code + OFL 许可
docs/screenshots           README 截图
```

## 已知限制

- 仅面向 Windows；未对 macOS/Linux 做验收。
- Windows 11 不允许程序静默修改默认打开方式，首次关联 `.json` 等类型需要在“打开方式”中手动选择本程序并勾选“始终”。
- 除了按图片识别的格式外，其他二进制文件会按纯文本展示（按设计）。
- 图片字节视图只展示前 1 MB。
- 在树视图编辑后再切到代码/文本视图或保存，会使用编辑器序列化后的格式；未编辑时保留原文件文本。
- 多窗口模式使用独立进程；窗口之间共享设置，但不会自动同步已经打开的文件列表。

## 许可证

项目代码基于 **Apache License 2.0** 开源，详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。

第三方组件的完整许可说明见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。

内置字体使用 SIL Open Font License 1.1，详见 [frontend/public/fonts/OFL.txt](frontend/public/fonts/OFL.txt)。
jsoneditor 使用 Apache License 2.0，详见 [frontend/public/vendor/LICENSE.jsoneditor](frontend/public/vendor/LICENSE.jsoneditor) 与 [NOTICE.jsoneditor](frontend/public/vendor/NOTICE.jsoneditor)。

主题中的产品名称（Darcula、IDEA 等）仅用于标识配色来源，本项目与 JetBrains 无隶属关系。

## 第三方组件

- [Wails v2](https://github.com/wailsapp/wails) — MIT
- [jsoneditor](https://github.com/josdejong/jsoneditor) — Apache-2.0
- [js-yaml](https://github.com/nodeca/js-yaml) — MIT
- [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) — MIT
- [Papa Parse](https://github.com/mholt/PapaParse) — MIT
- [Inter](https://github.com/rsms/inter) — OFL-1.1
- [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) — OFL-1.1
- [Fira Code](https://github.com/tonsky/FiraCode) — OFL-1.1
