# 单位样式配置

当某个单位的内部规范不同于默认参考版时，不要修改 Skill 主逻辑，使用 JSON profile 覆盖。

## 创建配置

复制 `profiles/example-org.json`，按单位名称重命名，只修改有差异的字段。程序会把配置合并到 `profiles/default.json`。

```json
{
  "name": "某某集团内部材料版",
  "page": {
    "margin_top_mm": 36,
    "margin_bottom_mm": 34,
    "margin_left_mm": 30,
    "margin_right_mm": 28
  },
  "fonts": {
    "title": "黑体",
    "body": "仿宋",
    "heading1": "黑体",
    "heading2": "楷体"
  },
  "paragraph": {
    "body_line_pt": 28
  }
}
```

使用配置：

```bash
python scripts/format_docx.py input.docx output.docx --profile profiles/my-org.json
python scripts/verify_docx.py output.docx \
  --reference input.docx \
  --profile profiles/my-org.json
```

## 管理规则

- 在 profile 的 `description` 中写清单位名称和确认日期；
- 同一单位只维护一个当前生效 profile；
- 排版和核验必须使用同一个 profile；
- profile 是单位内部样式，不等同于法定合规结论；
- 同一单位有多个文种、纸张或版式时，建立多个命名 profile，不要把条件分支写进 `SKILL.md`。

## 可覆盖字段

- 页面宽高和四个页边距；
- 标题、正文、各级标题和表格中文字体；
- 标题、正文、标题层级、落款、日期和表格字号；
- 正文固定行距；
- 标题、落款和日期的段前段后；
- 首行缩进和右侧缩进；
- 表格表头/正文字体、边框颜色与粗细、对齐、垂直对齐和跨页重复表头。

页面尺寸使用毫米，字号和间距使用磅；字符缩进按汉字字符数表示。
