# Reference typography

This is the default reference profile for Chinese formal documents and workplace materials. It uses common settings associated with GB/T 9704-2012 but does not claim that every organization must use that standard. The issuing organization's current template and document-control policy take precedence.

The executable source of truth is `profiles/default.json`. Read this file when explaining a measurement or building a custom profile.

## Page setup

| Property | Value | Notes |
|----------|-------|-------|
| Paper size | A4 (210 × 297 mm) | Equivalent in DXA: 11906 × 16838 |
| Top margin | 37 mm | ≈ 2098 DXA |
| Bottom margin | 35 mm | ≈ 1984 DXA |
| Left margin | 28 mm | ≈ 1587 DXA |
| Right margin | 26 mm | ≈ 1474 DXA |
| Line spacing | **Fixed value 28pt** (固定值28磅) | `<w:spacing w:line="560" w:lineRule="exact"/>` |
| Standard layout | 22 lines per page × 28 chars per line | Result of A4 + above margins + 28pt line spacing |

**Unit conversion notes**:
- 1 inch = 25.4 mm = 1440 DXA = 72 points
- 1 mm ≈ 56.69 DXA
- 1 point = 20 (twentieths of a point) in OOXML `w:line`

## Chinese font size system (字号)

Reference table mapping Chinese typography sizes to points and OOXML half-points (used by docx):

| Chinese size | Points | docx half-points | When used |
|--------------|--------|------------------|-----------|
| 初号 | 42pt | 84 | Rarely |
| 小初 | 36pt | 72 | Rarely |
| 一号 | 26pt | 52 | Rarely |
| 小一 | 24pt | 48 | Rarely |
| **二号** | **22pt** | **44** | **Title** |
| 小二 | 18pt | 36 | Rarely |
| **三号** | **16pt** | **32** | **Body, all headings, signature, date** |
| 小三 | 15pt | 30 | Sometimes used for compact docs |
| 四号 | 14pt | 28 | Table content |
| 小四 | 12pt | 24 | Footnotes |
| 五号 | 10.5pt | 21 | Annotations |

## Element-by-element specification

### Title (标题)

- Font: **方正小标宋简体** (fallback: 方正小标宋_GBK or 小标宋体)
- Size: **2号 (22pt)**
- Color: Black (#000000)
- Weight: Regular (the font itself reads bold)
- Alignment: **Center**
- Spacing before: 24pt (line break visual)
- Spacing after: 24pt
- Indent: None
- Pattern: 关于XX的报告 / XX工作方案 / 关于XX的函 / XX会议纪要

The fallback names above are guidance for a human choosing fonts. Do not silently replace the configured font name inside the DOCX unless the user approves that organization-specific override.

For multi-line titles, break with line wrapping such that lines are roughly equal length, with the meaning intact (不能拆词). Word's word wrap typically does this acceptably; if the result looks awkward, manually insert line breaks.

### Recipient (主送机关) — optional

- Font: 仿宋_GB2312
- Size: 3号 (16pt)
- Alignment: Left
- Indent: None (顶格)
- Ends with: 全角冒号 `：`
- Examples: `各分公司、各部门：` / `XX公司：` / `XX省国资委：`

For 函件 sent to a single peer organization, this is the recipient name.
For 报告/方案 sent to an upper org, this is that org's name.
For 会议纪要, typically not used.

### Body text (正文)

- Font: 仿宋_GB2312
- Size: 3号 (16pt)
- Alignment: Justified (两端对齐)
- First-line indent: 2 characters at 16 pt = 32 pt = 640 twips (DXA), expressed as both `firstLineChars="200"` and `firstLine="640"`
- Spacing before/after: 0
- Line spacing: Fixed 28pt (inherits from page setup)
- Inline bold, italic, and underline in the source body are preserved as the author's emphasis.

### Heading hierarchy

All headings use 3号 (16pt) — the same size as body. The differentiator is **font**.

#### Level 1 (一级标题)

- Marker pattern: `一、` `二、` ... `十、`
- Font: **黑体** (Heiti / SimHei) — fallback Microsoft YaHei
- Weight: Regular (the font itself is heavy)
- Alignment: Justified
- First-line indent: 2 characters
- Spacing before: 0 (some orgs use 6pt; default to 0 unless user requests)
- Spacing after: 0

#### Level 2 (二级标题)

- Marker pattern: `（一）` `（二）` ... (use Chinese full-width parentheses, not English)
- Font: **楷体_GB2312** (fallback: STKaiti, 楷体)
- Weight: Regular
- Alignment: Justified
- First-line indent: 2 characters
- Spacing before/after: 0

**Same-line heading + body** (common in 公文): when a Level-2 marker and its body share one line (`（一）加强组织领导。各级各部门……`), split the paragraph into two runs — the heading phrase through the first `。` in 楷体_GB2312, the remaining text in 仿宋_GB2312. A standalone Level-2 line (e.g., an action item ending in `；`) is styled entirely in 楷体_GB2312.

#### Level 3 (三级标题)

- Marker pattern: `1.` `2.` ... (a half-width period, not 、 or 。)
- Font: **仿宋_GB2312**
- Weight: **Bold** (this is the ONLY level where bold matters)
- Alignment: Justified
- First-line indent: 2 characters
- Spacing before/after: 0

`1.` is only a level-3 heading when the paragraph is a short, label-like heading. A complete numbered sentence or action item remains body text in 仿宋_GB2312 3号 without artificial bold. The numbering pattern alone does not decide the role.

The same distinction applies to `（1）`: use the fourth-level heading style for a label, but keep a complete sentence as body text.

#### Level 4 (四级标题)

- Marker pattern: `（1）` `（2）` ... (Chinese full-width parens, half-width number)
- Font: 仿宋_GB2312
- Weight: Regular
- Alignment: Justified
- First-line indent: 2 characters
- Spacing before/after: 0

#### Beyond Level 4

If the user has deeper hierarchy (`①②③` or `a) b) c)`), keep them as 仿宋_GB2312 regular. Most public documents don't go beyond Level 4; if they do, the content itself usually needs restructuring (which this skill doesn't do).

### Signature / 落款 (sender organization name)

- Font: 仿宋_GB2312
- Size: 3号 (16pt)
- Alignment: **Right**
- Right indent: 2 characters (≈ 640 DXA)
- Spacing before: 600 DXA (creates visual gap from preceding body)
- Pattern: Full organization name, e.g., `天府阳光云服务有限公司`

### Date (成文日期)

- Font: 仿宋_GB2312
- Size: 3号 (16pt)
- Alignment: **Right**
- Right indent: 4 characters (≈ 1280 DXA — further right than signature)
- Format: Arabic numerals in Chinese frame, e.g., `2026年5月13日`
- **No leading zeros**: `2026年5月13日`, NOT `2026年05月13日`
- Spacing after: 600 DXA (creates space before any subsequent content)

### Special elements

**附件说明** (when document has attachments):
- Format: `附件：1.附件一名称` (note period after number, no terminating punctuation)
- Font: 仿宋_GB2312 3号
- Position: After body, before signature
- Indent: 2 characters left

**附注** (notes, e.g., contact info):
- Format: `（联系人：XXX  电话：XXX-XXXXXXXX）` (with 全角 parentheses)
- Font: 仿宋_GB2312 3号
- Position: After date
- Indent: 2 characters left

### Tables (表格)

Table captions (`表1　双方客户群体对比`) are centered, 仿宋_GB2312 3号 (16pt), bold, no first-line indent. Table content uses 仿宋_GB2312 四号 (14pt) with the header row in 黑体 四号, all cells centered both axes, thin uniform borders.

The default profile distributes explicit column widths across the usable width (≈8844 DXA with this page setup), disables autofit, repeats the header row, and adds 80 DXA top/bottom plus 120 DXA left/right cell margins. Cell paragraphs use single line spacing rather than the fixed 28pt body rule.

## Word style mapping recommendation

When applying formatting via Word's style system (preferred over direct character formatting), map to these style IDs:

| Skill element | Word style name | Style ID |
|---------------|-----------------|----------|
| Title | Title | `Title` |
| Recipient | Normal | (no special style, just direct formatting) |
| Body | Normal | `Normal` (override font and indent) |
| Level 1 heading | Heading 1 | `Heading1` |
| Level 2 heading | Heading 2 | `Heading2` |
| Level 3 heading | Heading 3 | `Heading3` |
| Level 4 heading | Heading 4 | `Heading4` |
| Signature | Normal (with direct alignment) | n/a |
| Date | Normal (with direct alignment) | n/a |

Note: in OOXML, style ID and visible name can differ. `Heading 1` displays as the name, `Heading1` is the ID.

## Color codes used in this skill

| Purpose | Hex | RGB |
|---------|-----|-----|
| Default text | 000000 | 0,0,0 |
| Red (if user requests 红头 in future) | C00000 | 192,0,0 |

This skill does not use color beyond black for text.
