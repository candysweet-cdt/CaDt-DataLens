# Validation record

Validation date: 2026-10-23

## Functional tests

`python3 -m unittest discover -s tests -v` passes 13 tests:

- report formatting with exact content preservation;
- table caption and organization-profile override;
- merged-cell versus unmerged-cell structural distinction;
- multi-paragraph title handling;
- source-overwrite refusal;
- damaged-file refusal;
- strict rejection of content-control markers;
- letter formatting with preserved header, footer, and inline image;
- all bundled before/after examples reformatted and verified end to end.
- numbered complete sentences remain body text while short numbered labels use level-3 heading style.
- the public name, version, trigger words, and retained version history stay synchronized.
- Chinese user guides exist alongside the English executable references.

## End-to-end examples

The three files in `examples/before` produce valid outputs in `examples/after`:

- quarterly report — 15 paragraphs, no tables;
- meeting minutes — 14 paragraphs, metadata block;
- implementation plan — 12 paragraphs and one table with a merged cell.

All three verification reports are `passed`, including:

- paragraph, table, header, and footer text equality;
- paragraph order and table row/cell/merge structure;
- A4 page size and margins;
- Chinese fonts and sizes;
- fixed line spacing and line height;
- alignment and character indents;
- table borders, cell margins, and usable width.

## Paired review

Three independent judges compared the original prose-only skill with this version. All three voted “better” with a clear margin. Their main reasons were the executable formatter/verifier, materially better failure handling, and runtime-neutral release materials.

## Preview validation

The bundled LibreOffice environment initially rendered Chinese as tofu because its isolated setup had no default fontconfig. `scripts/render_preview.py` now creates a temporary fontconfig that includes the host OS font directories. With that configuration, all three example documents render with readable Chinese, and page-level visual checks pass.

## Remaining limits

- Automatic document-type and signature/date detection are heuristic.
- Nested tables, landscape sections, content controls, tracked changes, text boxes, comments, and footnotes require the strict-mode warning path or manual review.
- Exact pagination must be checked on the target machine with the organization's installed fonts.
- The default style is a reference profile, not a legal-compliance determination.
