# Agent Skills

本目录存放 CaDt-DataLens 的 **Agent Skill**（遵循 [Agent Skills](https://agentskills.io) 规范：一个目录一个技能，入口为 `SKILL.md`），用于教 AI agent（Claude Code、ZCode、Qoder、OpenCode 等支持该规范的工具）如何调用 CaDt-DataLens 为用户打开和定位本地文件。

## 目录结构

```text
docs/skills/
├── README.md                  ← 本文件（面向第三方开发者）
└── cadt-datalens/             ← 技能本体，注册时整目录复制
    ├── SKILL.md               ← 技能入口：何时用、怎么调、注意事项
    └── reference/
        └── cli.md             ← 命令行完整参考（按需阅读）
```

## 注册机制

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

## 修改与贡献

- 直接编辑 `cadt-datalens/SKILL.md` 或 `reference/cli.md`，然后重新注册（取消再勾选）即可生效。
- `SKILL.md` 的 YAML frontmatter 必须保留 `name: cadt-datalens`，它是应用识别"这是自己写入的技能"以决定能否安全删除的标记。
