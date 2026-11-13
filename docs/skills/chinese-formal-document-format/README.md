<div align="center">

<sub>鼓翼成长星球 · 中文正式文档排版 Skill</sub>

# 中文正式文档排版

> 只改格式，不改一个字。

上传一份中文 DOCX，让 Agent 按正式材料版式整理标题、正文、分级标题、落款、日期和表格，同时自动核验：**原文有没有被悄悄改动**。

[![Release](https://img.shields.io/github/v/release/ianlinkstudy/chinese-formal-document-format?display_name=tag&label=release)](https://github.com/ianlinkstudy/chinese-formal-document-format/releases)
[![Tests](https://github.com/ianlinkstudy/chinese-formal-document-format/actions/workflows/tests.yml/badge.svg)](https://github.com/ianlinkstudy/chinese-formal-document-format/actions/workflows/tests.yml)
[![License](https://img.shields.io/badge/license-MIT-2f6f75.svg)](LICENSE)
[![Agent](https://img.shields.io/badge/agent-Codex%20%7C%20Claude%20Code%20%7C%20Cursor-18324a.svg)](https://skills.sh)

```bash
npx skills add ianlinkstudy/chinese-formal-document-format
```

[能做什么](#能做什么) · [安装与第一次使用](#安装与第一次使用) · [真实案例](#真实案例) · [常见问题](#常见问题) · [下载](#版本与下载)

</div>

---

<p align="center">
  <img src="docs/chinese-formal-document-before-after.png" alt="中文正式文档排版前后对比：会议纪要" width="100%">
</p>

<p align="center"><sub>同一份会议纪要，排版前后。文字、数字、标点和段落内容保持一致。</sub></p>

## 为什么需要它

中文正式材料真正麻烦的，不是把文字放大或加粗，而是同时守住三件事：

1. 标题和正文层级要正确；
2. 页面、字体、字号、行距、缩进和表格要统一；
3. 排版过程中不能偷偷改掉任何一个字。

这个 Skill 把排版交给确定性脚本，把文种和结构歧义留给 Agent 询问用户，再通过独立核验报告证明内容没有变化。

它不是“一键润色公文”，而是一套**保守、可核验的 DOCX 格式化工具**。

---

## 能做什么

| 任务 | 输出 | 常见说法 |
|---|---|---|
| 正式文档排版 | 新 DOCX + 格式报告 + 核验报告 | “按正式文档格式排一下” |
| 报告 / 总结 | 标题、主送、分级标题、落款和日期统一 | “整理季度报告格式” |
| 实施方案 / 工作计划 | 一、（一）、1.、（1）层级识别 | “按方案版式排版” |
| 会议纪要 | 元数据、议题、决定事项和日期治理 | “把会议纪要排成正式版” |
| 函 / 通知 / 请示 | 常见正式材料版式，并提示文种边界 | “按函件格式整理” |
| 组织模板覆盖 | 自定义字体、页边距、行距与表格样式 | “按我们公司的模板排版” |
| 内容完整性检查 | 段落、表格、页眉页脚逐项比对 | “确认没有改我的字” |

### 默认版式

| 元素 | 字体 | 字号 |
|---|---|---|
| 标题 | 方正小标宋简体 | 二号，22 pt |
| 正文 | 仿宋_GB2312 | 三号，16 pt |
| 一级标题 `一、` | 黑体 | 三号 |
| 二级标题 `（一）` | 楷体_GB2312 | 三号 |
| 三级标题 `1.` / `1、` | 仿宋_GB2312 加粗 | 三号 |
| 四级标题 `（1）` | 仿宋_GB2312 | 三号 |
| 表格 | 表头黑体，内容仿宋_GB2312 | 四号，14 pt |

页面为 A4，页边距上 37 mm、下 35 mm、左 28 mm、右 26 mm；正文固定行距 28 pt，首行缩进 2 字符。

默认样式参照 GB/T 9704-2012 的常见做法，不代表任何单位自动合规。正式发文仍应以本单位现行模板和制度为准。

---

## 安装与第一次使用

### 1. 安装

任选一种方式。

#### 推荐：使用 skills 安装器

```bash
npx skills add ianlinkstudy/chinese-formal-document-format
```

适用于 Codex、Claude Code、Cursor、OpenClaw、Hermes 等支持 Skills 的环境。

#### 手动安装到 Codex

下载 [最新 Release](https://github.com/ianlinkstudy/chinese-formal-document-format/releases/latest)，解压后将整个 `chinese-formal-document-format` 文件夹放进：

```text
~/.codex/skills/
```

#### Git clone 兜底

```bash
git clone https://github.com/ianlinkstudy/chinese-formal-document-format.git \
  ~/.codex/skills/chinese-formal-document-format
```

### 2. 装完先自检

这个 Skill 不只有 `SKILL.md`。安装目录还应包含：

```text
profiles/     版式配置
scripts/      排版与核验脚本
references/   规则和参考文档
templates/    DOCX 模板
examples/     匿名示例与预览
tests/        自动测试
```

如果只安装了 `SKILL.md`，说明安装器版本过旧或安装不完整。优先升级 `skills` 后重装，或者使用上面的 `git clone`。

### 3. 把材料交给 Agent

上传可编辑的 `.docx`，然后直接说：

> 使用“中文正式文档排版”Skill 处理附件。先保留原文件，再输出一份新 DOCX 和核验报告。不得改动任何文字、数字、标点、段落顺序、表格和页眉页脚。完成后告诉我内容完整性、版式核验结果、需要人工确认的问题和字体风险。

明确的文种更稳：

```text
按季度报告排版
按实施方案排版
按会议纪要排版
按函件排版
```

### 4. 检查交付物

正常情况下会得到：

```text
输出.docx
输出.docx.format-report.json
输出.docx.verify-report.json
```

最重要的两个结果：

```text
content_integrity.passed = true
status = passed
```

完整图文说明：[PDF 使用手册](docs/usage-guide.zh-CN.pdf) · [Markdown 源稿](docs/usage-guide.zh-CN.md)

---

## 真实案例

所有案例均为虚构、脱敏材料，保留源文件、格式化结果、验证报告和页面预览。

### 会议纪要

重点：会议元数据、议题层级、正文和落款日期。

<p align="center">
  <img src="examples/previews/after/02-minutes/page-1.png" alt="会议纪要排版结果" width="72%">
</p>

[源文件](examples/before/02-minutes.docx) · [排版结果](examples/after/02-minutes.docx) · [核验报告](examples/reports/02-minutes.verify.json) · [PDF 预览](examples/previews/after/02-minutes/02-minutes.pdf)

### 季度报告

重点：标题、正文层级、落款与日期，以及多页正文的稳定性。

<p align="center">
  <img src="examples/previews/after/01-quarterly-report/page-1.png" alt="季度报告排版结果" width="72%">
</p>

[源文件](examples/before/01-quarterly-report.docx) · [排版结果](examples/after/01-quarterly-report.docx) · [核验报告](examples/reports/01-quarterly-report.verify.json) · [PDF 预览](examples/previews/after/01-quarterly-report/01-quarterly-report.pdf)

### 带合并表格的实施方案

重点：标题层级、表格字体、边框、列宽，以及合并单元格结构保持不变。

<p align="center">
  <img src="examples/previews/after/03-digital-plan-table/page-1.png" alt="带合并表格的实施方案排版结果" width="72%">
</p>

[源文件](examples/before/03-digital-plan-table.docx) · [排版结果](examples/after/03-digital-plan-table.docx) · [核验报告](examples/reports/03-digital-plan-table.verify.json) · [PDF 预览](examples/previews/after/03-digital-plan-table/03-digital-plan-table.pdf)

---

## 核心保证

脚本在保存前后比较：

- 每个正文段落及段落顺序；
- 每个表格的行、列、单元格和合并关系；
- 每个单元格中的文字；
- 页眉和页脚文字；
- 段落、表格、图片关系和页面结构数量。

任意一项变化，脚本停止，不交付“看起来排好了、实际漏了内容”的文件。

独立核验还会检查：

- A4 页面与四边页边距；
- 中文字体名称和字号；
- 固定行距；
- 对齐方式和首尾缩进；
- 表格表头与正文样式；
- 源文件与输出文件的完整文本结构。

### 编号不等于标题

- `1. 完成情况`：短标签，可以按三级标题处理；
- `1. 由市场部牵头，于10月25日前完成任务。`：完整句子，保持正文样式。

Skill 会依据句子的完整度和位置判断，层级仍不清楚时向你确认。

---

## 常见问题

### 它会改写、润色或补全我的正文吗？

不会。排版与写作分开。日期习惯、报告夹带请示语、数字前后不一致、缺失落款等问题只会提示，不会自动修改。

### 为什么强调“只用 DOCX”？

`.docx` 有可校验的段落和表格结构。`.doc`、扫描 PDF 和图片需要先转成可编辑 DOCX，再人工核对转换结果。

### 能否使用我们单位的字体和页边距？

可以。复制 `profiles/example-org.json`，建立单位自己的 profile，并在排版和核验时使用同一个配置。

### 字体为什么可能和预览不一样？

DOCX 只保存字体名称，不包含字体文件。目标电脑需要安装对应字体；不要为了预览好看而擅自替换正式文件里的字体名称。

### 修订痕迹、文本框和内容控件怎么办？

`--strict` 模式会停止并报告风险。先接受或清理修订，必要时压平内容控件，再重新排版。

### 能自动加红头、文号、印章和版记吗？

不能。默认只处理已有正文和结构的排版，不生成法定公文要素，也不替代单位审批。

### 内容完整性检查失败还能用吗？

不能。先定位失败的段落、表格或页眉页脚，修复后重新运行，不能带着失败报告交付。

### 这个 Skill 会上传我的文档吗？

不会。排版、核验和预览都在本机完成；仓库中没有遥测、云端上传或密钥依赖。

---

## 隐私、安全与边界

- 原始 DOCX 不会被覆盖，输出始终写入新文件；
- 默认不联网、不上传正文、不收集 telemetry；
- 示例均为虚构且脱敏；
- 不随包分发商业字体；
- 外发文档前仍需自行检查作者信息、修订记录和隐藏元数据；
- 复杂内容控件、文本框和异常合并表格不能证明完全可处理时，脚本会停止或提示。

安全说明见 [SECURITY.md](SECURITY.md)。

---

## 版本与下载

当前版本：**1.3.0**

- [查看最新 Release](https://github.com/ianlinkstudy/chinese-formal-document-format/releases/latest)
- [下载 ZIP 安装包](https://github.com/ianlinkstudy/chinese-formal-document-format/releases/latest/download/chinese-formal-document-format-v1.3.0.zip)
- [下载 `.skill` 包](https://github.com/ianlinkstudy/chinese-formal-document-format/releases/latest/download/chinese-formal-document-format-v1.3.0.skill)
- [查看更新日志](CHANGELOG.md)
- [查看完整迭代记录](docs/iterations.md)

### 仓库结构

```text
chinese-formal-document-format/
├── SKILL.md
├── README.md
├── VERSION
├── CHANGELOG.md
├── profiles/
├── scripts/
├── references/
├── templates/
├── examples/
├── docs/
└── tests/
```

### 开发与测试

```bash
python3 -m pip install -r requirements.txt
python3 -m unittest discover -s tests -v
```

提交改动前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 许可

代码和文档采用 [MIT License](LICENSE)。个人使用和商业使用均可，分发时请保留许可证声明。

---

<div align="center">

**鼓翼成长星球 · 出品与持续维护**

先把正式材料排好，再把内容本身写好。

</div>
