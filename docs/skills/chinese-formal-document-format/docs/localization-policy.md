# 本地化约定

目标：让中文用户能读懂，同时不牺牲 Agent、代码和跨平台兼容性。

## 使用中文的内容

- `README.md`
- `CHANGELOG.md`
- `docs/` 下的用户说明和版本记录
- `examples/README.md`
- `references/*.zh-CN.md`
- Agent 面向中文用户的解释、提醒、追问和最终总结

## 保持英文的内容

- `SKILL.md` 的执行流程和 Agent 指令
- `scripts/` 中的代码、函数名和日志字段
- CLI flags，例如 `--profile`、`--doc-type`、`--strict`
- JSON keys，例如 `fonts`、`paragraph`、`content_integrity`
- profile keys 和枚举值，例如 `heading1`、`body_item`、`minutes`
- 字体名称、OOXML 标签、文件扩展名和包路径
- 英文技术参考原文件

## 双语文件对应关系

- `references/runtime-notes.md` ↔ `references/runtime-notes.zh-CN.md`
- `references/customization.md` ↔ `references/customization.zh-CN.md`
- `references/format-spec.md` ↔ `references/format-spec.zh-CN.md`
- `references/document-structures.md` ↔ `references/document-structures.zh-CN.md`
- `references/conservative-rules.md` ↔ `references/conservative-rules.zh-CN.md`

英文原文件是执行依据；中文文件是用户阅读版。修改格式规则、限制或失败条件时，两边必须同时更新。

## 输出语言

处理中文文档时，默认用中文向用户说明：

- 识别出的文种；
- 标题、正文和编号层级；
- 格式核验结果；
- 未决问题和风险；
- 输出文件路径。

路径、命令、字段名和值保持原样，不翻译成中文别名。
