# Runtime notes

The Skill body is runtime-neutral. Use the first available path below.

## Codex or another shell-capable agent

Use the bundled Python environment when the runtime provides one. In Codex, run:

```bash
cd /path/to/chinese-formal-document-format
python scripts/format_docx.py input.docx output.docx
python scripts/verify_docx.py output.docx --reference input.docx
```

If `python` does not point to the bundled runtime, replace it with the absolute runtime path supplied by the platform.

Do not edit the skill from the installed global directory. Copy it to a writable project folder first.

## Claude Code or another Skills-compatible CLI

Install or place the skill folder in that runtime's Skills directory, then ask for “按中文正式文档格式排版”. The shell workflow is the same.

Use `python3` when `python` is unavailable:

```bash
cd /path/to/chinese-formal-document-format
python3 scripts/format_docx.py input.docx output.docx
```

Install the dependency once if needed:

```bash
python3 -m pip install -r requirements.txt
```

## Claude.ai or another chat file interface

Upload the packaged `.zip` or `.skill` file through the product's Skills or file interface. If the product cannot run Python but can edit DOCX files, require it to use the same `profiles/default.json` values and run the content-integrity and typography checks.

If the product cannot produce a DOCX file, attach the script and ask the user to run it rather than returning an approximate answer in chat.

## Microsoft Word add-in

Use the add-in's document model when it can:

1. save a copy before editing;
2. preserve all text, punctuation, tables, headers, and footers;
3. apply the page and paragraph settings from `profiles/default.json`;
4. export the verification summary.

Page setup is a document property. Content styling may be direct formatting or a style update. Keep the user's wording untouched.

If the add-in cannot report content integrity, run `scripts/format_docx.py` and `scripts/verify_docx.py` on the saved DOCX as a second gate.

## Font availability

The DOCX stores font names, not the font files. The recipient's Word or WPS must have the configured fonts installed. Do not bundle proprietary fonts with the skill.

For a reliable visual preview, install the same fonts used by the organization on the rendering machine. When only preview rendering lacks the fonts, keep the correct names in the DOCX and use structural verification.

## Preview renderer

Use:

```bash
python scripts/render_preview.py output.docx preview/
```

The script writes a temporary `fontconfig` that includes the standard font directories of the host OS before invoking LibreOffice. This avoids the common false alarm where an isolated LibreOffice profile cannot see the system's Chinese fonts and renders every CJK character as tofu.

If the runtime does not expose `soffice` or `pdftoppm` on `PATH`, pass their paths:

```bash
python scripts/render_preview.py output.docx preview/ \
  --soffice /absolute/path/to/soffice \
  --pdftoppm /absolute/path/to/pdftoppm
```

On macOS, the script falls back to Quick Look for a first-page thumbnail when LibreOffice is unavailable. Quick Look does not replace a page-by-page check.
