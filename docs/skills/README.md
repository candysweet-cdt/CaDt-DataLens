# Agent Skills

本目录存放 CaDt-DataLens 随仓库分发的 **Agent Skill**（遵循 [Agent Skills](https://agentskills.io) 规范：一个目录一个技能，入口为 `SKILL.md`）。

| 目录 | 用途 | 分发方式 |
| --- | --- | --- |
| `cadt-datalens/` | 教 AI agent（Claude Code、ZCode、Qoder、OpenCode 等）用命令行调用 CaDt-DataLens 打开和定位本地文件 | 「设置 → 系统集成 → 注册全局 Agent Skill」复制到用户技能目录；同时作为应用内置技能释放到应用数据目录 |
| `cadt-file-layout/` | 内置 AI 助手的文件目录规范：产物落盘位置、三层分区、命名约定、硬禁区与可删除清单 | 应用内置技能，首次列出技能时释放到应用数据目录 |
| `reverse-engineer-anything/` | REA：对原生二进制、托管程序、Electron/JavaScript、固件、浏览器目标做逆向分析，并按需生成 AgentEnv 环境包 | 应用内置技能，首次列出技能时释放到应用数据目录 |
| `chinese-formal-document-format/` | 中文正式文档（公文风格）DOCX 排版：只改版式、不改正文，并核验原文未被改动 | 应用内置技能，首次列出技能时释放到应用数据目录 |
| `landing-page-design/` | 落地页/营销页设计：需求问询、页面结构、转化文案、SEO + 完整视觉系统（字体/间距/圆角/背景/动效）；纯规则无外部依赖 | 应用内置技能，首次列出技能时释放到应用数据目录 |
| `code-review/` | 按严重度审查代码，列出证据与修复建议（只读） | 应用内置技能，首次列出技能时释放到应用数据目录 |
| `json-toolkit/` | 校验、格式化、修复并解释 JSON / JSONL / YAML / TOML / CSV | 应用内置技能，首次列出技能时释放到应用数据目录 |
| `release-notes/` | 根据本次改动生成面向用户的更新日志 / 发布说明 | 应用内置技能，首次列出技能时释放到应用数据目录 |
| `patch-workflow/` | 用 propose_patch 生成 .patch 补丁交给用户审批；含 unified diff 写法、自检清单、失败后的最小修复与重试纪律 | 应用内置技能，首次列出技能时释放到应用数据目录 |
| `cadt-gen-models/` | 帮用户配置生图/视频生成条目：代填除 API Key 外的全部字段，密钥由用户在设置里填写 | 应用内置技能，首次列出技能时释放到应用数据目录 |
| `cadt-mcp-samples/` | 内置 MCP 示例：缺本地 TTS / OCR / ASR 时推荐并用 install_mcp_sample 安装 | 应用内置技能，首次列出技能时释放到应用数据目录 |
| `cadt-mcp-config/` | 帮用户配置本机 MCP 服务器：代填 command/args/cwd 与超时，环境变量值与工具授权由用户完成 | 应用内置技能，首次列出技能时释放到应用数据目录 |
| `web-research/` | 联网检索：web_search 找来源、web_fetch 读正文，最后附 URL 给出结论（只读） | 应用内置技能，首次列出技能时释放到应用数据目录 |
| `docx/` | 创建、编辑、提取 Word 文档，以及 docx↔pdf/Markdown 转换 | 应用内置技能，首次列出技能时释放到应用数据目录 |
| `pdf/` | PDF 生成与处理：合并/拆分、提取文本表格图片、转换、加水印、填表单 | 应用内置技能，首次列出技能时释放到应用数据目录 |
| `skill-creator/` | 为本应用 AI 助手创建或改进技能：把重复工作流沉淀成 SKILL.md | 应用内置技能，首次列出技能时释放到应用数据目录 |
| `plugin-creator/` | 为 CaDt-DataLens 开发插件（plugin.json + cadt.* API） | 应用内置技能，首次列出技能时释放到应用数据目录 |
| `answer-me-with-html/` | 把复杂回答做成一页多面板图文 HTML，写入工作区并在内嵌浏览器打开 | 应用内置技能，首次列出技能时释放到应用数据目录 |

## cadt-datalens：注册到全局技能目录

应用内「设置 → 系统集成 → 注册全局 Agent Skill」会把 `cadt-datalens/` 复制到以下两个常用的 agent 全局技能目录：

| 目标目录 | 读取方 |
| --- | --- |
| `%USERPROFILE%\.agents\skills\cadt-datalens\` | 遵循 Agent Skills 规范的跨 agent 通用目录（ZCode 等） |
| `%USERPROFILE%\.claude\skills\cadt-datalens\` | Claude Code 个人技能目录 |

注册时 `SKILL.md` 中的 `{{EXE_PATH}}` 占位符会被替换为当前 exe 的实际路径，这样 agent 拿到的就是可直接执行的命令；`reference/cli.md` 原样复制。重复勾选即覆盖更新；取消勾选删除技能目录（仅当目录内是本应用写入的内容时才删除）。

### 手动注册 / 取消

不想用界面的话，也可以手动复制本目录到上述目标位置，然后把 `SKILL.md` 里的 `{{EXE_PATH}}` 全部替换成你的 `datalens.exe` 路径。

### 为什么用占位符

技能源文件在仓库里保持与具体机器无关；只有注册（写入用户目录）那一刻才知道当前 exe 在哪。程序移动位置后重新勾选一次即可刷新路径。

## 内置技能：随应用分发

`cadt-datalens/`、`cadt-file-layout/`、`reverse-engineer-anything/`、`chinese-formal-document-format/`、`landing-page-design/`、`code-review/`、`json-toolkit/`、`release-notes/`、`patch-workflow/`、`cadt-gen-models/`、`cadt-mcp-samples/`、`cadt-mcp-config/`、`web-research/`、`docx/`、`pdf/`、`skill-creator/`、`plugin-creator/` 与 `answer-me-with-html/` 通过 `go:embed` 编进 exe。AI 面板首次列出技能时，会把它们释放到：

```text
%APPDATA%\CandySweet\CaDt-DataLens\builtin-skills\
├── .cadt-builtin-version      ← 应用版本标记
├── cadt-datalens\             ← SKILL.md 里的 {{EXE_PATH}} 释放时替换为真实路径
├── cadt-file-layout\
│   ├── SKILL.md
│   └── reference\paths.md
├── reverse-engineer-anything\
├── chinese-formal-document-format\
├── landing-page-design\
├── code-review\
├── json-toolkit\
├── release-notes\
├── patch-workflow\
├── cadt-gen-models\
├── cadt-mcp-samples\
├── cadt-mcp-config\
├── web-research\
├── docx\
├── pdf\
├── skill-creator\
├── plugin-creator\
└── answer-me-with-html\
```

- 在「设置 → AI 助手 → 技能」中显示为「内置」，优先级最低（rank 600），可被工作区、应用级或用户级同名技能覆盖。
- `cadt-file-layout` 是本项目自研的目录规范，随 exe 分发、**对所有工作区生效**；它的 `description` 常驻技能索引，AI 需要新建文件、生成报告 / HTML 页面、整理或清理目录时按需 `skill_use` 加载全文。完整路径表在 `reference/paths.md`，按 `skill_use` 返回的技能目录相对读取。
- 释放目录由应用管理：应用版本变化（或内置技能清单变化）时会删除并重写这几个技能目录，**不要直接修改**；需要定制时把技能复制到工作区 `.cadt/skills` 或应用数据 `ai-skills` 再改。
- 技能内的 `reference/`、`references/`、`scripts/`、`templates/` 等附属文件随技能一起释放，AI 可通过 `read_file` 按 `SKILL.md` 的相对路径读取。
- 升级方式：用上游最新版本覆盖对应目录（保持目录名与 `SKILL.md` 的 `name:` 一致），重新构建即可；`.cadt-builtin-version` 里包含应用版本号与内置技能清单，构建后首次运行自动刷新。

### 上游与许可

| 技能 | 上游 | 本地版本 |
| --- | --- | --- |
| `cadt-file-layout` | 本项目自研 | 随应用版本 |
| `reverse-engineer-anything` | [morluto/rea](https://github.com/morluto/rea)（`.agents/skills/reverse-engineer-anything`） | SKILL v62 |
| `chinese-formal-document-format` | [ianlinkstudy/chinese-formal-document-format](https://github.com/ianlinkstudy/chinese-formal-document-format) | v1.3.0 |
| `landing-page-design` | [elayadesign/ai-design-skills](https://github.com/elayadesign/ai-design-skills) | 2026-11-01 main |
| `cadt-datalens` | 本项目自研 | 随应用版本 |
| `code-review` | 本项目自研 | 随应用版本 |
| `json-toolkit` | 本项目自研 | 随应用版本 |
| `release-notes` | 本项目自研 | 随应用版本 |
| `patch-workflow` | 本项目自研 | 随应用版本 |
| `cadt-gen-models` | 本项目自研 | 随应用版本 |
| `cadt-mcp-samples` | 本项目自研 | 随应用版本 |
| `cadt-mcp-config` | 本项目自研 | 随应用版本 |
| `web-research` | 本项目自研 | 随应用版本 |
| `docx` | 本项目自研 | 随应用版本 |
| `pdf` | 本项目自研 | 随应用版本 |
| `skill-creator` | 本项目自研 | 随应用版本 |
| `plugin-creator` | 本项目自研 | 随应用版本 |
| `answer-me-with-html` | 参考 [qingyuna](https://github.com/qingyuna) 的同名技能（MIT）改写 | 随应用版本 |

后三个技能均为 MIT 许可，许可证文本随技能目录一并存放（`LICENSE`），第三方组件清单见仓库根目录 `THIRD_PARTY_LICENSES.md`。`cadt-file-layout` 随本仓库 Apache-2.0 分发。

`landing-page-design` 的 `description` 做了本应用适配：收敛为「用户明确要求落地页/营销页时才加载」（上游原文是「任何 web UI 都触发」）；正文有一句 `CaDt-DataLens 适配` 引用块，其余内容与上游一致，便于日后同步。其内容改编自 [taste-skill](https://github.com/Leonxlnx/taste-skill)（MIT，作者 Leon Lin），许可声明保留在技能正文末尾。

## 修改与贡献

- `cadt-datalens`：直接编辑 `SKILL.md` 或 `reference/cli.md`，然后重新注册（取消再勾选）即可生效；`SKILL.md` 的 YAML frontmatter 必须保留 `name: cadt-datalens`，它是应用识别"这是自己写入的技能"以决定能否安全删除的标记。
- `cadt-file-layout`：改 `SKILL.md` 时同步 `reference/paths.md`、路径清单（第 4、7、8 节）与脚本规范（第 6 节）；规则要与 `ai-panel.js` 的实际落盘逻辑一致，避免文档与实现打架。
- 内置技能：以适配应用为主（例如补一句"用 `run_command` 执行脚本""产物写到工作区"），其余内容尽量与上游保持一致，方便后续同步。
- 新增内置技能：在 `docs/skills/` 下建目录（至少含一个 `SKILL.md`），把目录名加进 `skills.go` 的 `appBuiltinSkillDirs`；版本标记包含清单，清单变化会自动触发重新释放。`TestBuiltinSkillAssetsPresent` 校验 frontmatter 的 `name:` 与目录名一致、且目录内至少一个文件。
- 技能文案与源码：历史上一批技能正文硬编码在 `ai-constants.js` 的 `AI_BUILTIN_SKILLS`，现已全部文件化；只剩 `cadt-ui`（动作表被四方对账守卫静态解析）、`inline-visual`（正文取自 `core/visual-spec.js` 单一来源）、`orchestrate`（被单测按名断言）三项留在源码。同一技能**不能既硬编码又文件化**——rank 相同时硬编码恒胜出，md 改了不生效；`ai-constants.test.mjs` 有护栏拦这种情况。
