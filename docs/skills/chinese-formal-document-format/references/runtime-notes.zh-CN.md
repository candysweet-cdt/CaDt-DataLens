# 安装与运行说明

Skill 主体不依赖某一个 Agent。按当前环境选择下面的路径。

## Codex 或其他可执行命令的 Agent

优先使用运行时提供的 Python。在 Codex 中：

```bash
cd /path/to/chinese-formal-document-format
python scripts/format_docx.py input.docx output.docx
python scripts/verify_docx.py output.docx --reference input.docx
```

如果 `python` 不是平台提供的运行时，替换成对应的绝对路径。

不要直接修改全局安装目录里的 Skill。需要改代码时，先复制到可写项目目录。

## Claude Code 或其他兼容 Skills 的 CLI

把 Skill 文件夹放入对应运行时的 Skills 目录，然后对 Agent 说：

> 按中文正式文档格式排版。

命令相同；没有 `python` 时使用 `python3`：

```bash
cd /path/to/chinese-formal-document-format
python3 scripts/format_docx.py input.docx output.docx
```

首次使用可安装依赖：

```bash
python3 -m pip install -r requirements.txt
```

## Claude.ai 或其他聊天文件界面

上传 `.zip` 或 `.skill` 发布包。如果平台能编辑 DOCX 但不能运行 Python，要求它：

- 使用 `profiles/default.json` 的同一组参数；
- 排版后完成正文完整性和字体、字号、行距、缩进核验；
- 不返回无法下载的近似文本。

如果平台不能生成 DOCX，建议直接提供脚本让用户在本地运行。

## Microsoft Word 加载项

使用加载项时必须：

1. 编辑前保存副本；
2. 保留全部文字、标点、表格、页眉和页脚；
3. 应用 `profiles/default.json` 的页面和段落参数；
4. 导出核验摘要。

页面设置属于文档属性；内容样式可直接设置，也可更新 Word 样式。用户原文必须保持不变。

如果加载项无法证明内容完整性，保存后再用 `format_docx.py` 和 `verify_docx.py` 做第二道检查。

## 字体

DOCX 只保存字体名称，不包含字体文件。接收方的 Word 或 WPS 必须安装对应字体。

- 不要把商业字体打包进 Skill；
- 预览机应安装与目标单位相同的字体；
- 只有预览机缺字体时，也不要擅自替换 DOCX 中的字体名称；
- 最终分页应在安装目标字体的 Word 或 WPS 中检查。

## 中文预览

```bash
python scripts/render_preview.py output.docx preview/
```

脚本会生成临时 `fontconfig`，把宿主系统的标准字体目录交给 LibreOffice，避免隔离环境把中文误渲染成方框。

如果 `soffice` 或 `pdftoppm` 不在 `PATH`：

```bash
python scripts/render_preview.py output.docx preview/ \
  --soffice /absolute/path/to/soffice \
  --pdftoppm /absolute/path/to/pdftoppm
```

macOS 没有 LibreOffice 时会退回 Quick Look，但 Quick Look 只生成首屏缩略图，不能替代逐页检查。
