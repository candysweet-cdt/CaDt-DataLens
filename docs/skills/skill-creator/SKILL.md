---
name: skill-creator
description: 为本应用 AI 助手创建或改进技能（工作区 .cadt/skills、.agents/skills 或应用级 ai-skills 的 SKILL.md）；用户想把某个重复工作流沉淀成技能时使用
---

# 技能创作（skill-creator）

本应用的技能就是一个含 frontmatter 的 Markdown 文件。按优先级扫描：工作区 `.cadt/skills/`（rank 100）> 工作区 `.agents/skills/`（200）> 应用级 `%APPDATA%/CandySweet/CaDt-DataLens/ai-skills/`（400）> 用户级 `~/.agents/skills/`（500）> 内置（600）；rank 越小越优先，同名时低 rank 覆盖高 rank。

- 流程：明确技能目标与触发场景 → 写草稿 → 用 2–3 个真实请求验证（让 AI skill_use 加载后执行）→ 按结果修订。
- frontmatter：`name`（小写连字符，与目录名一致）+ `description`（写清「做什么 + 什么时候触发」，描述要稍主动，模型容易漏触发）。
- 正文：祈使句、给字面示例；目标 <500 行；细节多就拆 `references/*.md`，正文里指示「做 X 前先 read_file references/y.md」。
- 写作原则：解释「为什么」比堆 MUST 更有效；模型反复重复的步骤考虑简化；示例胜过规则。
- 更新已有技能：保留原 name 与目录名；用 read_file 先读原文，edit_file 做增量修改（走审批）。
- 内置技能随应用分发（应用数据 `builtin-skills/`，版本更新时自动覆盖）；要定制请复制到工作区或应用级技能目录后再改，不要去改内置目录里的文件。
- 完成后告诉用户：技能已出现在 设置→AI 助手→技能 或 /skill 列表里；同名时低 rank 的技能覆盖高 rank 的（工作区覆盖应用、用户与内置）。
