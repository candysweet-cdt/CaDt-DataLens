---
name: pdf
description: PDF 生成与处理：合并/拆分/提取文本表格图片、Office/HTML/图片转 PDF、加水印、填表单；用 pypdf/PyMuPDF/reportlab/LibreOffice 完成
---

# PDF 处理（pdf）

通过 run_command 执行 Python 完成处理；脚本用 write_file 写入工作区再执行；原文件只读，结果一律输出新文件。

- 环境探测：`python -c "import pypdf, fitz"`；缺库 `pip install pypdf pymupdf pdfplumber reportlab`。
- 提取：文本/表格/图片用 PyMuPDF(fitz) 或 pdfplumber；只取几页时先看页数再决定范围。
- 合并/拆分/旋转/删页/元数据：pypdf（PdfWriter）；加密解密用 pypdf 或 pikepdf。
- 生成：结构化文档用 reportlab；中文必须注册 TTF 字体（如 `pdfmetrics.registerFont(TTFont("hei", "C:/Windows/Fonts/simhei.ttf"))`），否则中文全是黑块。
- Office→PDF：LibreOffice `soffice --headless --convert-to pdf --outdir <目录> <文件>`；HTML→PDF 可用本机 Edge：`msedge --headless --print-to-pdf="<输出>.pdf" file:///<绝对路径>`（矢量输出，勿用截图拼接）。
- 图片→PDF：Pillow `Image.save("out.pdf", save_all=True, append_images=[...])` 即可。
- 交付时报告：输出路径、页数、大小；内容有缺页/乱码要先自查再交付。
