---
name: docx
description: 创建、编辑、提取 Word (.docx/.doc) 文档，以及 docx↔pdf/Markdown 转换；用 python-docx/pandoc/LibreOffice 完成
---

# Word 文档处理（docx）

通过 run_command 在本机执行 Python / pandoc / LibreOffice 完成任务；生成脚本用 write_file 写入工作区再执行。

- 环境探测：`python -c "import docx"`；缺库用 `pip install python-docx`；提取文本可用 pandoc（`pandoc -f docx -t markdown 文件`）。
- 创建：优先 python-docx；标题用内置 Heading 样式（不要手工加粗模拟），中文正文常见 宋体/微软雅黑 小四或五号，行距约 1.3；列表、表格、页眉页脚均有现成 API。
- 编辑：原文件只读，输出到 `<原名>_updated.docx`；用户明确要求原地改时先复制 `<原名>_backup.docx` 备份。
- 提取/分析：pandoc 转 Markdown 最快；需要逐段落/表格结构时用 python-docx 遍历。
- 转换：docx→PDF 用 LibreOffice（`soffice --headless --convert-to pdf --outdir <目录> <文件>`）；.doc→.docx 同理（`--convert-to docx`）。没装 LibreOffice 先向用户说明并征得同意再安装，不要拿 Word/WPS 凑合。
- 中文引号在 Python/JS 字符串里注意转义；长文档先 read_file 采样再动手，不要凭空编造内容。
- 写工作区文件会走审批；交付时报告输出文件路径。
