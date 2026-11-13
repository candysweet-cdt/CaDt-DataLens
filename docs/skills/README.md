# Agent Skills

本目录存放 CaDt-DataLens 随仓库分发的 **Agent Skill**（遵循 [Agent Skills](https://agentskills.io) 规范：一个目录一个技能，入口为 `SKILL.md`）。

| 目录 | 用途 | 分发方式 |
| --- | --- | --- |
| `cadt-datalens/` | 教 AI agent（Claude Code、ZCode、Qoder、OpenCode 等）用命令行调用 CaDt-DataLens 打开和定位本地文件 | 「设置 → 系统集成 → 注册全局 Agent Skill」复制到用户技能目录 |
| `reverse-engineer-anything/` | REA：对原生二进制、托管程序、Electron/JavaScript、固件、浏览器目标做逆向分析，并按需生成 AgentEnv 环境包 | 应用内置技能，首次列出技能时释放到应用数据目录 |
| `chinese-formal-document-format/` | 中文正式文档（公文风格）DOCX 排版：只改版式、不改正文，并核验原文未被改动 | 应用内置技能，首次列出技能时释放到应用数据目录 |

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

`reverse-engineer-anything/` 与 `chinese-formal-document-format/` 通过 `go:embed` 编进 exe。AI 面板首次列出技能时，会把它们释放到：

```text
%APPDATA%\CandySweet\CaDt-DataLens\builtin-skills\
├── .cadt-builtin-version      ← 应用版本标记
├── reverse-engineer-anything\
└── chinese-formal-document-format\
```

- 在「设置 → AI 助手 → 技能」中显示为「内置」，优先级最低（rank 600），可被工作区、应用级或用户级同名技能覆盖。
- 释放目录由应用管理：应用版本变化时会删除并重写这两个技能目录，**不要直接修改**；需要定制时把技能复制到工作区 `.cadt/skills` 或应用数据 `ai-skills` 再改。
- 技能内的 `references/`、`scripts/`、`templates/` 等附属文件随技能一起释放，AI 可通过 `read_file` 按 `SKILL.md` 的相对路径读取。
- 升级方式：用上游最新版本覆盖对应目录（保持目录名与 `SKILL.md` 的 `name:` 一致），重新构建即可；`.cadt-builtin-version` 里包含应用版本号，构建后首次运行自动刷新。

### 上游与许可

| 技能 | 上游 | 本地版本 |
| --- | --- | --- |
| `reverse-engineer-anything` | [morluto/rea](https://github.com/morluto/rea)（`.agents/skills/reverse-engineer-anything`） | SKILL v62 |
| `chinese-formal-document-format` | [ianlinkstudy/chinese-formal-document-format](https://github.com/ianlinkstudy/chinese-formal-document-format) | v1.3.0 |

两者均为 MIT 许可，许可证文本随技能目录一并存放（`LICENSE`），第三方组件清单见仓库根目录 `THIRD_PARTY_LICENSES.md`。

## 修改与贡献

- `cadt-datalens`：直接编辑 `SKILL.md` 或 `reference/cli.md`，然后重新注册（取消再勾选）即可生效；`SKILL.md` 的 YAML frontmatter 必须保留 `name: cadt-datalens`，它是应用识别“这是自己写入的技能”以决定能否安全删除的标记。
- 内置技能：以适配应用为主（例如补一句“用 `run_command` 执行脚本”“产物写到工作区”），其余内容尽量与上游保持一致，方便后续同步。
