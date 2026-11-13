# 路径速查表

配合 `cadt-file-layout` 的 `SKILL.md` 使用。字段含义：

- **真源 / 派生**：真源删了数据就丢了；派生可随时删除重建。
- **入 git**：默认是否被版本控制跟踪（最终以项目 `.gitignore` 为准）。
- **可手改**：AI 或用户能否直接编辑该文件，不改由应用托管。

## 工作区：`<工作区根>/.cadt/`

| 路径 | 写入方 | 真源 / 派生 | 生命周期 | 入 git | 可手改 |
| --- | --- | --- | --- | --- | --- |
| `memory/MEMORY.md` | 记忆功能 | 真源（索引） | 长期 | 否（默认忽略） | 是 |
| `memory/<主题>.md` | 记忆功能 | 真源 | 长期 | 否 | 是 |
| `skills/<name>/SKILL.md` | 技能管理 / 用户 | 真源 | 长期 | 否 | 是 |
| `answers/<slug>.html` | `answer-me-with-html` | 真源，但一次性 | 用完可删 | 否 | 是 |
| `patches/<ts>-<slug>.patch` | `propose_patch` / 补丁视图 | 真源 | 撤销需求结束前保留 | 否 | 否（只读） |
| `patches/index.jsonl` | 应用 | 真源（追加式索引，含 WAL 记录） | 长期 | 否 | 否 |
| `patches/manifest/<id>.json` | 应用 | 真源（原 hash / mtime / 编码 / EOL） | 随补丁 | 否 | 否 |
| `patches/backup/<id>/` | 应用 | 真源（应用前原始字节） | 撤销需求结束前保留 | 否 | 否 |
| `permissions.json` | 用户（权限页） | 真源 | 长期 | 否 | 仅用户 |
| `git-commit-style.json` | Git 快捷操作 | 真源 | 长期 | 否 | 是（走审批） |
| 根目录下 `tmp-*` 脚本 | AI（本轮） | 临时 | 用完即删 | 否 | 是（用前确认是本轮创建） |

无工作区（只打开单个文件）时，补丁相关文件回退到应用数据目录的 `patches/`，由应用自己管理。

## 应用数据：`%APPDATA%\CandySweet\CaDt-DataLens\`

AI 助手**只读**，不写、不改、不删。

| 路径 | 写入方 | 真源 / 派生 | 说明 |
| --- | --- | --- | --- |
| `config.json` | 应用 | 真源 | 后端配置：打开方式、插件目录模式、禁用插件 |
| `WebView2/` | WebView2 | 真源 | 浏览器用户数据，界面设置所在的 localStorage |
| `plugins/` | 用户 / 应用 | 真源 | 设置选「应用数据目录」时的插件目录 |
| `ai-config.json` | 应用 | 真源 | profiles / prompts / preferences / 审批白名单；原子写、0600 |
| `ai-sessions/` | 应用 | **真源** | 每会话追加式 JSONL + meta + 外置图片 |
| `ai-index.db` | 应用 | **派生** | 会话搜索 FTS 索引，删除后首次搜索自动重建 |
| `ai-schedule.db` | 应用 | **派生** | 定时任务定义索引；触发指令原文仍是真源 |
| `ai-memory/` | 记忆功能（app 模式） | 真源 | 记忆不跟项目走，换工作区仍在 |
| `ai-skills/` | 技能管理 / 用户 | 真源 | 应用级技能（rank 400） |
| `builtin-skills/` | 应用 | 派生 | 随 exe 分发的内置技能，版本变化时删除重写；不要直接改 |
| `builtin-skills/.cadt-builtin-version` | 应用 | 派生 | 版本标记：`appVersion + 内置技能目录清单` |
| `activity/` | 应用 | 真源 | 操作留痕，按月分文件滚动；只存摘要，不存正文与密钥 |
| `logs/` | 应用 | 派生 | 运行日志 |
| `patches/` | 应用 | 真源 | 无工作区时的补丁与备份回退目录 |

## 脚本相关路径

| 路径 | 归属 | 说明 |
| --- | --- | --- |
| `<项目>/scripts/`、`tools/` 等 | 项目（用户态） | 用户明确要的正式脚本，沿用项目语言、命名与换行习惯 |
| `<工作区>/.cadt/tmp-*` | AI 本轮临时产物 | 优先级最低的落盘方式：优先用 `run_command` 内联命令或「运行代码」临时副本；确需文件才用，用完即删 |
| `<技能目录>/scripts/` | 技能作者 | 随技能分发；从技能根执行或用 `skill_use` 返回的技能目录拼绝对路径 |
| `<技能目录>/requirements.txt` | 技能作者 | 声明技能脚本依赖，不静默安装 |
| `builtin-skills/<name>/scripts/` | 应用 | 内置技能脚本，**只读**，版本变化会被覆盖 |

应用「运行代码」用临时副本执行、不修改原文件；`run_command` 每条在独立进程、工作目录由 `cwd` 决定。两者都不要求把脚本写进工作区。

## 技能扫描优先级

rank 越小越优先，同名技能只保留优先级最高的一份：

| rank | 来源 | 目录 |
| --- | --- | --- |
| 100 | 工作区 | `<工作区根>/.cadt/skills/` |
| 200 | 工作区·通用 | `<工作区根>/.agents/skills/` |
| 400 | 应用 | `%APPDATA%/CandySweet/CaDt-DataLens/ai-skills/` |
| 500 | 用户·通用 | `~/.agents/skills/` |
| 600 | 内置 | `%APPDATA%/CandySweet/CaDt-DataLens/builtin-skills/` |

`cadt-file-layout` 本身是 rank 600 的内置技能：所有工作区都能看到，但工作区里有同名技能时会被覆盖。要定制，把目录复制到 `.cadt/skills/cadt-file-layout/` 再改 `SKILL.md`。

## 真源与派生的判断口径

- 会话正文只存在 `ai-sessions/` 的 JSONL 里；`ai-index.db` 只是给它建的搜索索引。
- 补丁正文只存在 `.cadt/patches/*.patch`；`index.jsonl` 是索引，`backup/` 是撤销依据，二者都不能当正文改。
- 设置、偏好、模型配置、会话正文**一律不放进 SQLite**。两个 `.db` 都是可丢弃的派生索引。
- 派生文件损坏或版本不匹配时，删除后让应用重建，不要手工修数据。

## 维护

应用新增或迁移路径时，同步更新本表、`SKILL.md` 的路径清单（第 4、7、8 节）与脚本规范（第 6 节）；新增内置技能目录还要同步 `skills.go` 的 `appBuiltinSkillDirs`（版本标记会因清单变化自动刷新 `builtin-skills/`）。
