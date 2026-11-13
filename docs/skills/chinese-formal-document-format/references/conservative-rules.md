# Conservative-Mode Rules

This skill is conservative. Its value depends on you not "helpfully" doing things the user didn't ask for. Read this carefully before formatting.

## The single principle

**Change typography. Do not change words.**

If you find yourself thinking "this would read better if I just changed…" — stop. The user asked for formatting, not editing.

## What you may change (formatting only)

- Font family of any text
- Font size of any text
- Font weight (bold/regular) — only as required by the heading hierarchy
- Alignment (left, center, right, justified)
- Indentation (first-line indent, left/right indent)
- Line spacing
- Paragraph spacing (before/after)
- Page margins, paper size
- Page orientation (if needed; A4 portrait is default)

## What you must NOT change

### Words and characters
- Do not add words. Not even helpful filler like 特此报告, 妥否请批示.
- Do not delete words.
- Do not change synonyms. (User wrote 调研, don't make it 调查.)
- Do not change tense, voice, or person.
- Do not fix typos. (Point them out separately if you notice them.)
- Do not standardize terminology. (If user uses 公司 in one place and 集团 in another, leave it.)

### Inline emphasis
- Preserve the user's inline bold, italic, and underline choices in body text.
- Normalize font weight only where the heading hierarchy explicitly requires it.

### Numbers and dates
- Do not change number formats. (If user wrote `5,000元`, leave it. If they wrote `五千元`, leave it.)
- Do not zero-pad dates. (If user wrote `2026年5月13日`, leave it. If they wrote `2026年05月13日`, point out the deviation from standard but leave it.)
- Do not convert between Arabic and Chinese numerals.

### Punctuation
- Do not change punctuation choices. (User used `1、` for level-3 markers? Apply level-3 styling, but keep `1、`. Apply the format to what's there.)
- Do not change quotation mark style.
- Do not add or remove serial commas / 顿号.

### Structure
- Do not split paragraphs.
- Do not merge paragraphs.
- Do not reorder content.
- Do not add headings the user didn't write.
- Do not promote/demote heading levels. (If user wrote a Level-2 marker `（一）` for what looks like Level-1 content, apply Level-2 styling — that was their choice.)
- Do not add a Table of Contents unless user asks.

### Other content
- Do not insert images.
- Do not insert tables (unless content was clearly tabular and just needs formatting).
- Do not add page numbers.
- Do not add headers/footers.

## Things that look like typography but actually aren't

These are content choices that LOOK like typography decisions, but they're not. Treat them as wording, not formatting.

| Looks like typography but isn't | Why it's wording |
|---|---|
| `1、` vs `1.` vs `1）` for numbering | Different organizations have house style preferences |
| `（一）` vs `(一)` vs `一)` | Half-width vs full-width parens is a wording choice |
| `2026年5月13日` vs `2026年05月13日` | Standard prefers no leading zero, but many orgs zero-pad |
| `XX公司` vs `XX有限公司` vs `XX股份有限公司` | The user has a reason for the form they chose |
| Bullets `•` vs `·` vs `●` | Bullet symbol is a content choice |
| Indent depth (1 char vs 2 char) | 2 is standard, but user may have reason for other |

For items in this list: if the user's choice deviates from the GB/T 9704 standard, point it out **in a brief note after the formatted output**. Format like:

> 注：我注意到几处可能想确认的地方：
> - 日期 `2026年05月13日` 标准是 `2026年5月13日`（月日不补零），是否要改？
> - 三级标题用了 `1、`，标准是 `1.`，是否要统一？

Then wait for the user's decision. Do not change it without confirmation.

## When the user's structure is ambiguous

The user's document may have content that could be a heading or could be body text. Examples:

- A line that says `（一）2026年第一季度销售额同比增长15%` — is this a heading `（一）` followed by content, or is it a Level-2 heading whose entire content is the rest of the line?
- A line that says `1. 一是要加强组织领导` — is this Level-3 heading whose content is `一是要加强组织领导`, or is it a list item?
- A bolded sentence in the middle of a paragraph — emphasis, or a heading?

**For each material ambiguity**:

1. Stop at a checkpoint and ask one concrete question.
2. State the two plausible treatments and the consequence of each.
3. Continue only after the user chooses, or preserve the paragraph as body text when that is the conservative default.

Do not silently pick a heading level, split a paragraph, or guess whether a line is a list item. If the formatting choice is reversible and does not affect text, an evidence-backed default may be used, but the report must still name the affected paragraph.

## When you notice problems in the content

You may notice (while reading to format) that the document has issues unrelated to formatting:

- A factual claim looks wrong
- A 请示 has multiple matters (违反"一文一事"原则)
- A 报告 contains 请批示 language (报告不应夹带请示事项)
- The signature org and title's `关于XX` subject don't align
- Numbers in the text don't add up

**Always point these out** in a brief note after formatting. Do NOT fix them. The user is responsible for content; you're responsible for typography.

Example note format:

> 提醒事项（不影响排版，供参考）：
> - 这是一份"报告"，但第三段出现"请批示"，按规范报告不应夹带请示事项，建议拆分或改文种。
> - 落款是"销售一部"，但标题写的是"公司销售工作"，主体范围不一致，请确认。

## What "conservative" doesn't mean

Conservative ≠ minimal. You should:

- Apply ALL the appropriate typography. Don't half-apply because you're being cautious.
- Format thoroughly. Every paragraph should end up with the right font and indent.
- Process every heading. Don't skip ambiguous ones — handle them with a note instead.
- Set page properties. Margins and line spacing should be correct.

Conservative just means: stay in your lane. Typography lane = full speed ahead. Wording lane = do not enter.

## Confirmation pattern

After formatting, briefly summarize what you did and what you noticed:

```
已完成排版：
- 文种识别：报告
- 字体应用：标题（方正小标宋简体 2号）、正文（仿宋_GB2312 3号）、一级标题（黑体 3号）、二级标题（楷体_GB2312 3号）、三级标题（仿宋加粗 3号）
- 段落：行距固定28磅，首行缩进2字符
- 页面：A4，页边距上37/下35/左28/右26 mm

发现以下需要你确认的地方（未自动修改）：
1. 日期写作 2026年05月13日，标准为 2026年5月13日（月日不补零）
2. 第二段第三行 "完成率达到 95%" 与第一段提到的 "完成率达到 96%" 不一致

需要我处理这两处吗？
```

This makes the user's review easy and respects their authority over content.
