# 操作留痕（Activity Audit Log）实施计划

> 状态：已完成（2026-11-12 实施，T1–T9 全量交付）
> 范围：完整 P0 + P1（文件、设置、标签/工作区/视图、AI 审批与工具摘要、查看页、AI 读取）
> 版本号：1.0.0（不变更）
> 决策依据：用户 2026-11-12 确认「完整 P0+P1，先落成文档」

## 1. 目标与非目标

### 目标

- 记录用户与 AI 在应用内的**状态改变类操作**：打开/保存/新建/删除/重命名/移动/格式化文件，关闭未保存标签，修改设置，切换工作区/标签/视图，AI 审批与工具执行摘要。
- 落成可查询的结构化本地日志：设置页可筛选/搜索/导出/清空，AI 可经 `app_control` 读取最近记录帮用户回忆与排障。
- 「谁做的」可区分：`actor=user|ai|system`，自动放行/系统代决带 `source`（user / rule / classifier / ai），满足「自动决策要留痕」。

### 非目标（明确不做）

- 不记录浏览轨迹：滚动、光标移动、输入过程、搜索框每次输入、悬停等高频无状态动作。
- 不记录文件正文、剪贴板内容、选区正文、API Key / Token / 环境变量值。
- 不做云端上报、不做跨设备同步；日志只在本机应用数据目录。
- 不替代已有真源：AI 会话正文仍以 `ai-sessions` JSONL 为准，操作记录只存摘要，不复制正文。
- 不引入 SQLite（派生数据原则见 AGENTS.md；本日志为纯追加 JSONL）。

## 2. 与现有能力的关系

| 现有能力 | 用途 | 与操作记录的区别 |
| --- | --- | --- |
| `logs/{时间}.txt` 运行日志 | 开发者排障（技术细节、错误栈） | 操作记录是**业务事件**、结构化、默认开启，面向用户与 AI |
| `ai-sessions/**/session.v1.jsonl` | AI 会话正文与工具消息 | 操作记录只记 AI 操作的**摘要**（工具名/目标/结果状态），不复制消息正文 |
| `permissionAudit`（内存态） | 设置页展示本次会话的审批判定 | 需要**落盘**并区分 actor/source；本计划将其并入操作记录（设置页展示保留） |
| Git 状态/历史 | 文件内容级变更 | 操作记录记「谁在什么时候做了什么操作」，不替代 Git |

## 3. 存储设计

### 3.1 位置与文件

- 目录：`%APPDATA%\CandySweet\CaDt-DataLens\activity\`
- 文件：按月 `YYYY-MM.jsonl`；单文件超过 5 MB 时滚动为 `YYYY-MM-2.jsonl`、`-3`…
- 保留：默认保留 12 个月（设置里可改 1–60）；超出按文件修改时间删除最旧。
- 权限：文件 0600。

### 3.2 单条记录格式

```json
{"v":1,"ts":1794489731916,"actor":"user","source":"user","action":"file.save","target":"frontend/src/main.js","detail":{"bytes":12345,"mode":"save"},"seq":1024}
```

- `v`：schema 版本（固定 1）
- `ts`：毫秒时间戳
- `actor`：`user` / `ai` / `system`
- `source`：`user` / `ai` / `rule` / `classifier` / `system`（同一 actor 下的判定来源）
- `action`：稳定事件名（见第 4 节），snake 之外统一用点分 `domain.verb`
- `target`：对象（文件/目录/设置键/标签/工作区）；文件路径尽量相对工作区根
- `detail`：可省略；只放摘要字段，禁止正文
- `seq`：可选，进程内单调序号（便于排序与去重）

### 3.3 写入策略

- 单一写者：所有写入经 Go 绑定方法，前端不直接落盘。
- 追加写：`os.OpenFile(O_APPEND|O_CREATE|O_WRONLY, 0600)`，进程内 mutex；跨进程（多窗口）用 `activity.lock`（复用 `sessionlock` 的 `LockFileEx` 模式）串行。
- fsync：攒批（最多 500ms 或 20 条）统一 flush，应用退出前 flush；失败只写运行日志，**绝不阻塞用户操作**。
- 单条上限 8 KB；超长 `detail` 截断并标记 `truncated:true`。
- 启动与退出各记一条 `app.start` / `app.exit`（`actor=system`）。

## 4. 事件清单

### 4.1 P0（必须）

| action | 触发点（main.js） | actor | target | detail |
| --- | --- | --- | --- | --- |
| `file.open` | `openPaths` / `openPathsHere` / `openTargets` | user | 相对路径 | `{format, size, line?, column?, batch?}` |
| `file.save` | `saveDoc` | user | 相对路径 | `{bytes, mode:"save"}` |
| `file.saveAs` | `saveAs` | user | 相对路径 | `{from, bytes}` |
| `file.create` | 新建文件/未命名标签保存 | user | 相对路径 | `{bytes}` |
| `file.delete` | 资源管理器删除（`DeleteEntry`） | user | 相对路径 | `{count, toRecycle:true}` |
| `file.rename` | `RenameEntry` | user | 新路径 | `{from}` |
| `file.move` | `MoveEntry`（拖放/粘贴移动） | user | 新目录 | `{from, count}` |
| `file.format` | `formatDocument` / 小说排版 | user | 相对路径 | `{kind:"format"}` |
| `tab.closeDirty` | `closeDocNow` 关闭脏标签 | user | 标签名 | `{discarded:true|false}` |
| `settings.change` | `applySettings` 差异 + AI `set_setting` | user/ai | 设置键 | `{from, to}`（脱敏见 5） |
| `ai.approve` | 审批通过（写文件 / 命令 / 网络 / 应用操作） | user | 审批对象 | `{kind, rule?, source}` |
| `ai.deny` | 审批拒绝 | user | 审批对象 | `{kind, rule?, source}` |
| `ai.tool` | 工具执行结束 | ai | 工具名 + 目标摘要 | `{status:"done"|"error", ms, error?}` |

### 4.2 P1（同批交付）

| action | 触发点 | actor | target | detail |
| --- | --- | --- | --- | --- |
| `tab.open` | 新标签 | user | 标签名 | `{format}` |
| `tab.switch` | `activateDoc` | user | 标签名 | `{}`（同一标签 2s 内去重） |
| `tab.close` | `closeDocNow`（非脏） | user | 标签名 | `{}` |
| `tab.reopen` | `reopenClosedTab` | user | 标签名 | `{}` |
| `workspace.open` | `openFolderSmart` / 打开文件夹 | user | 工作区路径 | `{}` |
| `view.switch` | `switchMode` | user | 视图名 | `{from}` |
| `plugin.change` | 插件启用/禁用/安装/卸载 | user | 插件 id | `{op}` |
| `ai.session` | 新建/切换/归档/删除会话 | user | 会话 id | `{op, title}` |

### 4.3 明确不记录

滚动、光标、选中、每次键入、查找框输入、hover、右键菜单展开、窗口尺寸拖动。

## 5. 脱敏规则（前端统一 sanitizer）

- 设置键白名单 + 秘密键黑名单：`apiKey` / `token` / `secret` / `password` / `authorization` 等值一律写 `"***"`；长字符串（>200 字）写 `"<长文本>"`。
- 设置只记 `{key, from, to}`：布尔、枚举、数字、短字符串原样；对象型设置（如模型配置列表）只记「增/删/改 + 名称」，不记密钥与完整配置。
- 环境变量：只记名称与操作（`env.create/remove`），永不记值；`env_list` 不产生记录。
- 文件路径：在工作区内时相对化；工作区外保留绝对路径（用户主动打开）。
- 图片/附件：只记数量与 mime，不记 base64。
- AI 相关：`ai.tool` 的 target 取工具主参数摘要（如文件路径、命令前 120 字，命令按现有审批规则同样脱敏）；不记工具返回正文。

## 6. 代码落点

### 6.1 Go 侧（新增 `activity.go`，无平台差异）

```go
// 前端不直接写盘；以下方法均做单条校验、脱敏兜底、滚动与保留清理。
func (a *App) ActivityAppend(entriesJSON string) error
func (a *App) ActivityRead(queryJSON string) (string, error) // {limit, beforeTs, actions[], actor, keyword}
func (a *App) ActivityClear() error
func (a *App) ActivityPath() (string, error) // 打开目录 / 导出用
```

- 复用 `appDataRoot()`、`writeAppLog`、`sessionlock` 的锁模式与原子追加/fsync 思路（见 `sessionstore.go`）。
- `ActivityRead` 从新到旧扫最近的文件，命中 `limit` 即停；返回 `{entries, truncated, files}`。
- `ActivityClear`：写一条 `activity.clear`（`actor=user`）到新文件，再删除旧文件（保留清空动作本身）。
- 静态断言测试：JSONL 每行可解析、字段齐全、无换行注入。

### 6.2 前端服务（新增 `frontend/src/activity-log.js`）

```js
export function createActivityLog({backend, settings}) {
    return {
        log(action, target, detail, opts) {}, // opts: {actor, source}
        flush() {},
        isEnabled() {},
    };
}
```

- 只做「格式化 + 攒批（≤200ms）+ 调用 `ActivityAppend`」；失败静默并写运行日志。
- 统一 `sanitizeDetail(action, detail)` 实施第 5 节规则，附单测 `activity-log.test.mjs`。
- 关闭记录（设置项）时 `log()` 直接返回；`app.start/app.exit` 不受开关影响？**受**开关影响，保持一致性。

### 6.3 设置项（`config.json` / settings）

- `activityLog`（bool，默认 true）
- `activityRetentionMonths`（number，默认 12，范围 1–60）

### 6.4 设置页「操作记录」（main.js + index.html）

- 新增设置分区 `activity`，入口放进「设置 → 通用」下方或独立导航项（遵循现有设置导航结构）。
- 顶部：启用开关、保留月数、打开目录、导出（当前筛选结果 JSON/CSV）、清空（二次确认）。
- 列表：时间、actor 徽标（用户/AI/系统）、动作、对象、详情（可展开）；筛选：动作大类、actor、时间范围、关键字搜索；虚拟滚动或分页（默认最近 500 条，滚动加载更早）。
- 隐私提示一行：「仅记录操作与设置变更，不记录文件内容与密钥；仅存本机」。

### 6.5 AI 读取（app_control）

- 新增动作 `get_activity {limit?, actions?, actor?, sinceTs?, keyword?}`（只读，所有权限档可用）。
- 返回最近 N 条（默认 50，上限 500）的紧凑文本/JSON。
- 同步更新：`APP_ACTIONS`、cadt-ui 技能动作表、`app_control` 工具描述与 `<tool_catalog>` 备注。

## 7. 触发点清单（按文件）

- `frontend/src/main.js`
  - 文件：`openPaths`、`openPathsHere`、`openTargets`、`saveDoc`、`saveAs`、`formatDocument`、`DeleteEntry` 调用处（L11928–11998 一带）、`RenameEntry`、`MoveEntry`（L11641–11719 一带）。
  - 标签：`activateDoc`、`closeDocNow`、`reopenClosedTab`、新建标签路径。
  - 工作区：`openFolderSmart`、`openFolderDialog`；视图：`switchMode`。
  - 设置：`applySettings`（对比旧值）、`APP_ACTION set_setting` 分支。
- `frontend/src/ai-panel.js`
  - 审批：`logPermission` 改为「内存 + 落盘」（`ai.approve` / `ai.deny`）。
  - 工具：工具调用收尾处记 `ai.tool`（复用现有 status/耗时字段）。
  - 会话：新建/切换/归档/删除入口记 `ai.session`。
- `frontend/src/explorer.js`：删除/重命名/拖放移动若不经 main.js，统一回调到 activity 服务（避免重复记录）。

## 8. 测试与验收

### 自动化

- Go：追加/读取/滚动到 `-2` 文件/保留清理/`ActivityClear` 标记/并发追加不撕裂。
- 前端：`activity-log.test.mjs`（脱敏：密钥、长文本、相对路径；关闭开关不写；批量合并）。
- 静态断言：每个 P0/P1 action 在代码中都有触发点（脚本扫描 action 名与调用处）。

### 手工验收清单

1. 打开/保存/另存为/新建/删除/重命名/移动/格式化各一次 → 查看页逐条出现且字段正确。
2. 关闭脏标签（放弃/保存两路）→ `tab.closeDirty` 的 `discarded` 正确。
3. 改主题/字号/自动保存开关 → `settings.change` 有旧值→新值；改 API Key → 值为 `***`。
4. AI 写文件审批通过/拒绝 → `ai.approve` / `ai.deny` 区分 actor/source；工具执行 → `ai.tool`。
5. 关闭记录开关 → 不再新增（运行日志有说明）；重新打开后恢复。
6. 清空 → 只剩 `activity.clear`；导出 JSON/CSV 可打开。
7. AI 问「我刚才改了什么」→ `app_control get_activity` 能返回最近操作摘要。
8. 一个月滚动/超 5 MB 场景用测试数据模拟（可临时改 cap）。

## 9. 分阶段任务清单

- [x] T1 Go：`activity.go`（append/read/clear/path + 锁 + 滚动 + 保留 + 单测）
- [x] T2 前端：`activity-log.js`（sanitize + 攒批 + 开关 + 单测）
- [x] T3 P0 触发点：文件 + 设置 + 脏标签
- [x] T4 P0 AI：审批落盘 + 工具摘要（`ai-panel.js`）
- [x] T5 P1 触发点：标签/工作区/视图/插件/AI 会话
- [x] T6 设置页「操作记录」：列表/筛选/导出/清空/开关/保留
- [x] T7 `app_control get_activity` + 技能/工具目录同步
- [x] T8 回归：`go test ./...`、`npm test`、构建（`wails build -devtools` 通过；实机手工清单待发布前抽查）
- [x] T9 文档：CHANGELOG、README（设置说明）、本文件状态改为「已完成」

## 9.1 实施记录与偏差（2026-11-12）

- 滚动分段号从 `-1` 开始连续编号（原文写 `-2`、`-3`；实现为 `YYYY-MM-1.jsonl`、`-2`…）。
- 保留清理按**文件名里的月份**判断过期（比文件修改时间更确定）；`retentionMonths` 非法（<1 或 >60）时跳过清理。
- `app.start` / `app.exit` 由前端服务记录（受开关控制，见 6.2 的结论）；AI 悬浮窗、独立调试控制台、转换模式窗口不记录。
- `ActivityAppend` 请求体为 `{entries, retentionMonths}`——保留月数随批携带，Go 侧无需读取前端设置。
- detail 脱敏量化：字符串 >200 字记 `<长文本>`；对象嵌套 ≤3 层；数组只记 `{length}`；单条 detail 序列化 >2 KB 记 `{truncated:true}`；秘密键名（apiKey/token/secret/password/authorization 等，含大小写与连写下划线变体）一律 `***`。Go 侧兜底：单条 >8 KB 时 detail 替换为截断标记，非对象 detail 丢弃。
- `settings.change`：单次 applySettings 最多逐键记 8 条，超出合并为一条汇总（`{count, keys}`），防止会话恢复批量改设置刷屏；首次调用只建快照。
- `ai.tool` 只记主回合工具轮（含参数非法的 error）；`spawn_agent` 子代理内部工具不单独记录。
- `view.switch` 通过包装实现：原 `switchMode` 改名 `applySwitchMode`，外壳比较 `currentMode` 与 `splitActive` 变化后记录。
- `get_activity` 的 `actions` 过滤支持大类前缀（传 `file` 命中全部 `file.*`）；Go 查询同时支持 `sinceTs` 与 `beforeTs`。
- 设置页列表用 DOM 逐行构建（textContent，防注入），详情 JSON 点击展开；导出 JSON / CSV 仅导出当前筛选条件下的最近 500 条（CSV 带 BOM，Excel 可直接打开）。

## 10. 风险与回滚

- 隐私：默认只记操作摘要；密钥脱敏有单测；日志仅在应用数据目录，用户可清空/关闭。
- 性能：攒批 + 异步；写失败不影响主流程；单条 8 KB 上限。
- 多窗口并发：文件锁 + 单写者；最坏情况是某次写入失败（运行日志可见）。
- 回滚：设置关闭即可停止记录；删除 `activity` 目录即清除全部历史；代码层可按 T1–T7 反序回退，不影响其他功能。

## 11. 待确认（默认值已给出）

- 保留时长默认 12 个月（1–60 可调）。
- `view.switch` / `tab.switch` 是否算「噪音」：默认记录，但同一标签/视图 2s 内去重；如嫌多可在设置里按类别关闭（后续增强）。
- AI 工具摘要是否包含命令正文：默认前 120 字（沿用审批展示口径），可在设置里只记「已执行」。
