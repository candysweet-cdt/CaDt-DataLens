# Customization profiles

Use a JSON profile when an organization's internal convention differs from the reference profile.

## Create a profile

Copy `profiles/example-org.json`, rename it after the organization, and change only the keys that differ. The formatter merges the override into `profiles/default.json`.

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

Then run:

```bash
python scripts/format_docx.py input.docx output.docx --profile profiles/my-org.json
python scripts/verify_docx.py output.docx \
  --reference input.docx \
  --profile profiles/my-org.json
```

## Profile governance

- Record the organization name and approval date in the profile's `description`.
- Keep one active profile per organization.
- Do not silently change a profile between formatting and verification.
- Treat the profile as a local convention, not as evidence of statutory compliance.
- When an organization has several document classes with different page settings, create separate named profiles rather than branching logic inside `SKILL.md`.

## Overridable fields

The default profile exposes:

- page dimensions and four margins;
- Chinese fonts for title, body, heading levels, and tables;
- title, body, heading, signature, date, and table sizes;
- body line spacing;
- title, signature, and date paragraph spacing;
- first-line and right-side character indents;
- table header/body fonts, border colour and size, alignment, vertical alignment, and repeated header rows.

Values use millimetres for page geometry and points for type and spacing. Character indents are expressed in Chinese characters.
