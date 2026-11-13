# Changelog

## 1.3.0 - 2026-10-24

- Added the “鼓翼成长星球” brand attribution to the Skill and user-facing README.
- Documented that branding applies to the Skill, manual, release notes, and sharing materials rather than to formatted user documents.
- Kept the technical Skill name, invocation behavior, formatting rules, and DOCX content-preservation guarantee unchanged.
- Raised the package version so shared files can be distinguished from 1.2.0.

## 1.2.0 - 2026-10-23

- Made the Skill description Chinese-first for Chinese users.
- Added a user-facing language rule: explanations, warnings, questions, and summaries default to Chinese.
- Added Chinese `.zh-CN.md` guides for runtime, customization, typography, document structures, and conservative rules.
- Kept `SKILL.md`, code, CLI flags, JSON keys, profile keys, font names, and OOXML identifiers in English where compatibility is better.
- Added an explicit localization policy so Chinese documentation and executable behavior remain synchronized.

## 1.1.2 - 2026-10-23

- Reconstructed and documented the unversioned iterations that preceded 0.9.0.
- Added evidence for the August 10 ad-hoc generator, August 11 skill scaffold, August 21 tender-document field test, and August 26 generic DOCX builder.
- Clarified that “0.9.0 前史” milestones are retrospective labels, not historical release numbers.

## 1.1.1 - 2026-10-23

- Added bare requests such as “排版”“排一下”“整理格式”“调格式” to the triggering description when the input is a Chinese DOCX.
- Added the complete version history and release process under `docs/iterations.md`.
- Added a publishing and distribution playbook for global and mainland-China audiences.

## 1.1.0 - 2026-10-23

- Renamed the skill from `soe-document-format` to `chinese-formal-document-format`.
- Changed the display name to “中文正式文档排版” to cover formal documents beyond state-owned enterprises and statutory official documents.
- Kept GB/T 9704 as a reference profile while making organization-specific overrides explicit.

## 1.0.1 - 2026-10-23

- Fixed false heading detection for numbered full sentences such as `1. 由市场部牵头，于10月25日前完成任务。`.
- Complete numbered statements now remain body text; only short label-like numbered paragraphs receive the level-3 heading style.
- Added regression coverage for distinguishing heading-like and body-like numbered paragraphs.

## 1.0.0 - 2026-10-23

- Added a deterministic DOCX formatting CLI.
- Added content and structure integrity checks run before saving.
- Added a separate typography verifier.
- Added font-aware PDF/PNG preview generation for systems whose isolated LibreOffice profile hides CJK fonts.
- Added organization-specific JSON profiles.
- Added runtime-neutral installation and execution guidance.
- Added failure handling for damaged files, missing dependencies, unsupported structures, and font-rendering limits.
- Added unit tests and anonymized before/after examples.
- Added table-caption handling, merged-cell structure checks, image/header/footer preservation checks, and page-break protection for headings and signature blocks.
- Clarified that the default style references GB/T 9704-2012 and is not a compliance certificate.

## 0.9.0 - 2026-08-26

- Consolidated the rule-only Skill after the August field tests.
- Covered reports, plans, letters, and meeting minutes with conservative content-preservation rules.
- Included format references and four DOCX templates.
- Added same-line level-2 heading/body handling, table typography, explicit DOCX output, and Codex-specific operating guidance.
- Did not yet include a deterministic formatter, independent verifier, organization profiles, or runtime-neutral packaging.

### Before 0.9.0

- 2026-08-10: built a one-off GB/T 9704-formatted feedback document from a Python generator.
- 2026-08-11: created the reusable `soe-document-format` Skill scaffold with references and four templates.
- 2026-08-21: field-tested document formatting on a multi-page procurement invitation, including cover, TOC, tables, page breaks, and cleanup.
- 2026-08-26: built a generic Markdown-to-DOCX formatter, then folded same-line heading and table rules into the Skill snapshot.
