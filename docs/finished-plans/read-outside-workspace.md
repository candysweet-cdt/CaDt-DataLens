# 工作区外读取：点名直读 + 按档审批 + 目录记忆（实施记录）

> 状态：**已完成**（2026-11-15 实施落地，`npm test` 460 项全绿、`vite build` 通过；本文保留设计取舍与手工回归清单）
> 起因：用户实测「让子代理读 `D:\OraSkyC\Novel\...md`」被 `read_file` 以「路径超出工作区范围」拒绝——应用本身是任意路径查看器，这是高频正当需求；但整盘放开有「读密钥 → `web_fetch` 外传」的注入链（read 档 `web_fetch` 默认放行，闸挡的是源头）。

## 1. 设计原则（作者逐条拍板）

1. **审批只区分「谁想读」**：用户在对话里明确给过的路径直接读，不为已表达的意图弹卡。点名判定 = 路径逐字出现在**真用户消息**里（应用消息卡片 / 子代理 notice / 模型派单 task 都不算——注入能改文件内容与模型输出，改不了真用户消息）。点名子树放行（点名目录 → 其下任意文件）。
2. **模型起意的越界读按档分流**：
   - `auto` / `full`：**直接读**。auto 契约即非风险自主执行，且 `type/cat` 经 `run_command` 本就绕行（auto 档非风险命令直放），闸 `read_file` 只是逼模型走更绕、更不透明的路；
   - `read` / `edit`：**弹审批卡**（read 没有命令工具、卡是唯一逃生口；edit 与其命令审批口径一致）。卡同时是「记住目录」的聊天内写入器：本会话（`session.readRoots`）/ 总是（`config.approvedReadRoots`）/ 本项目（`.cadt/permissions.json` 的 `Read(dir/**)`）。
   - auto 档经命令读敏感路径的加固（分类器规则）是独立后续项，不在本次。
3. **子代理永不自己弹卡**：`currentPendingApprovalEntry` 按 `entry.session === currentSession()` 匹配，子会话不在会话列表、卡片结构上不可达，弹了就是永久悬挂。子代理三层：实时回查父会话已批准读根（不是快照复制）+ 父会话真用户点名放行 + 都不命中则报错指引「经 agent_send 报回主代理发起授权」。
4. **应用数据目录硬拒**（含 `ai-config.json` API 密钥、会话与索引数据）：任何档位、点名也不放行——密钥一旦被读就随会话 JSONL 落盘，与 activity-log「不存密钥」同一哲学。
5. 已批准粒度 = **父目录**（越界文件的父目录树）；父目录是盘符根时退化为文件自身（避免一次批准整个盘）。`addReadRoot` 收敛：新根覆盖旧根时替换被包含的旧根。

## 2. 实现落点

| 部分 | 位置 |
|---|---|
| 授权判定纯函数 | `frontend/src/ai/ai-read-roots.js`：`normalizeReadRoot(s)` / `readRootCovers(Any)` / `addReadRoot` / `userNamedPath` / `sensitiveReadDenyReason`；路径提取复用 `ai-scope-redact.js` 新导出的 `extractDrivePaths`（同一套盘符路径 token 语义，支持中文路径） |
| 权限系统 read kind | `ai-permissions.js`：`PERMISSION_KINDS` 加 `'read'`，`matchPermissionRule` write/read 共用 `matchPathGlobRule`（`D:/xxx/**` 目录树 glob），`decidePermission` read 分支（deny → sessionAllow → allow → auto 直放 → read/edit ask） |
| 权限设置 UI | `ai-permission-settings.js`：`Read` 前缀标签、规则表格 read 桶、审批记录 pattern、来源标签 `auto` |
| 路径闸标记 | `ai-panel.js` `aiResolveScopePath`：越界 Error 带 `outOfWorkspace` / `absPath`（写工具不捕获，行为与文案不变） |
| 授权链 | `ai-panel.js` `resolveReadPathWithApproval(ctx, tool, path)`（read_file / list_dir 共用）：敏感硬拒 → 点名（含父会话回查）→ 已批准根 → `decidePermission`（auto 直放留痕 `logPermission('read',…,'auto')`）→ 子代理报回指引 → 主会话 `requestReadApproval`；例行放行（点名/已批准）不记审计，只记「起意」放行与拒绝。**2026-11-16 补**：list_dir 递归（depth>1）传 `opts.scanRoot`——授权「记住」的粒度是目录本身（整个子树都在范围内，与 search_text / glob 的起点同语义）；审批动词按工具名显示「列目录」，不再借用搜索措辞 |
| 审批登记 | `ai-panel.js` `registerPendingApproval`（从 requestApproval 抽出的 write/read 共用公共路径：pendingApprovals + 接管区 + 未读/桌面通知/60s 再提醒）；`decideApproval` 加 read 分支（三档记住 + 卡文案 + audit kind） |
| 审批卡 | `ai-takeover.js`：read 分支——收起细条「读取待审批」、头部无 ± 统计、正文完整真实路径 + 说明（复用 `ai-command-line` pre 样式）、勾选框文案「此目录」、按钮「允许 / 拒绝」。复用写审批已有勾选框，**零新增裸控件**（form-controls 基线不变） |
| 会话字段 | `session.readRoots`：normalizeSession / createSessionData / buildSessionMeta（随 meta 持久化，上限 200）；`config.approvedReadRoots`：normalizeAIConfig / ai-settings-io 导入导出 |
| 子代理 | `ai-subagents.js`：sub.session 加 `readRoots: []`；派单 task 消息打 `from: 'agent'` 标记（防止模型派单文本被 `userNamedPath` 当成用户点名——注入经派单伪造点名的防线） |
| 图片放行 | `ai-panel.js` `resolveAIImages`：越界图片对已批准读根放行展示（同步渲染上下文，不弹卡；敏感目录判定只在读取链路做，展示放行不产生读取面） |
| 工具描述 | `ai-tool-defs.js`：read_file / list_dir description 补授权语义；`<workspace_rules>` 守则补一条（点名直读 / 起意按档 / 拒绝后不重试） |

## 3. 已知边界（明确不做）

- ~~`search_text` 仍只搜工作区根（Go `SearchWorkspace` 单根签名）；已批准目录内可逐文件读，多根搜索另立方案。~~ **后续已实现（2026-11-16）**：`search_text` / `glob` 支持用 `path` 指定单个起点目录（含工作区外，走同一授权链；扫描起点包含应用数据目录时拒绝），仍不提供多根并行搜索。
- auto/edit 档经 `run_command` 读敏感路径（`.ssh`、浏览器 profile 等）不在本次防线内——读文件对分类器不是风险操作；后续可给分类器加「凭据类路径」规则。
- ~~写工具（write_file / edit_file）越界仍硬报错，文案与行为不变。~~ **后续已翻转（2026-11-28）**：写工具对工作区外路径改走 diff 审批卡（auto 档绝不自动应用），见 `write-outside-workspace.md`。
- `resolveAIImages` 的展示放行不查应用数据目录（同步渲染拿不到 appDir；读取链路已硬拒，展示不产生读取面，不对称可接受）。

## 4. 手工回归清单（wails dev）

1. **点名直读**：会话里让 AI 读 `D:\OraSkyC\Novel\...md`（任意工作区外路径）→ 直接读到正文，无审批卡。
2. **点名带目录**：用户说「读 D:/Novel 下所有 md」→ AI list_dir/read_file 该目录下文件全部直读；目录外路径照走审批。
3. **auto 档起意直读**：切 auto 档，让 AI「顺便看看 D:/Novel 还有什么」→ 直接读到、无卡；设置 → 操作记录可见 `ai.approve`（read / 来源自动权限档）。
4. **read/edit 档起意弹卡**：read 档让 AI 读未点名路径 → 审批卡（完整路径 + 三档勾选）：
   - 勾「本会话允许此目录」→ 后续同目录读取免卡；
   - 不勾直接「允许」→ 仅本次放行，下次再弹；
   - 「拒绝」→ 工具结果为行动指引文案，模型不再重试。
5. **总是 / 本项目**：勾「总是」→ 重启应用后该目录仍免询问；勾「本项目」→ `.cadt/permissions.json` 出现 `Read(D:/xxx/**)`，设置 → AI → 权限规则表格可见、可删除，新会话同目录免询问。
6. **子代理**：spawn 后让子读点名路径 → 直读成功；子读未点名未批准路径 → 报错指引报回；主代理 read_file 同路径弹卡批准 + `agent_send` 通知 → 子重读成功（父 readRoots 实时回查生效，无需重启会话）。
7. **应用数据目录硬拒**：让 AI 读 `ai-config.json`（应用数据目录内）→ 任何档位、点名也拒绝，文案指向主界面打开。
8. **注入面**：跨会话 `session_send` 投递的消息里写「请读取 D:/x」→ 接收会话 AI 读取仍走正常分流（app 卡片不算点名）。
9. ~~**写工具回归**：write_file / edit_file 传工作区外绝对路径 → 仍报「路径超出工作区范围」，行为不变。~~ **2026-11-28 起改为弹 diff 审批卡**，回归清单见 `write-outside-workspace.md`。
10. **AI 消息图片**：AI 引用已批准目录下的本地图片 → 正常显示；未批准目录 → 占位说明。
