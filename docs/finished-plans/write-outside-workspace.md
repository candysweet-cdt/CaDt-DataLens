# 工作区外写入：审批卡放行（auto 档绝不自动应用）（实施记录）

> 状态：**已完成**（2026-11-28 实施落地；本文保留设计取舍与手工回归清单）
> 起因：用户指出 auto 档的矛盾行为——`edit_file` / `write_file` 对工作区外路径直接报「路径超出工作区范围」，而 `run_command` 在同一档位可以弹命令审批卡修改工作区外文件。硬拒没有构成安全边界（Go 侧 `SaveFileChecked` 直收绝对路径、无任何工作区检查），只是把模型赶到更危险的通道：shell 改文件没有 diff 审批卡、没有 oldString 唯一匹配校验、没有陈旧写兜底，还在训练模型「edit 不行就上命令」。本方案与读侧方案（`read-outside-workspace.md`）互补：读侧「点名直读 + 按档审批」，写侧**一律弹卡**——用户在对话里提过路径 ≠ 授权写入。

## 1. 设计原则（作者逐条拍板）

1. **写工具捕获越界标记继续走既有 diff 审批管线**：`aiResolveScopePath` 的 `outOfWorkspace` 标记由新函数 `resolveWritePath` 捕获，三个写 case（write_file / edit_file / code_outline maintain）不再在路径闸硬拒；审批、diff 预览、wipeguard、陈旧写兜底全部复用现有管线（探索确认全部按绝对路径语义运作，无二次拦截）。
2. **非 full 档一律转人工，auto 档绝不自动应用**：不变量放进 `decidePermission` 的 write 分支（新输入 `outOfWorkspace`），auto 档 `risky || outOfWorkspace` → ask。读侧 auto 直放的理由（「命令通道本就能绕行」）在写侧只支持「弹卡可过」，不支持「免卡直写」——写比读危险。
3. **写侧不做读侧的「点名直写」**：读卡有「点名直读」（审批只区分谁想读），写卡没有对应物——模型起意与用户点名在写侧同权，都要过卡。
4. **「记住」仍是精确文件路径**：复用写审批卡已有的三档勾选（本会话 / 总是 / 本项目），落 `session.approvedPaths` / `config.approvedPaths` / `.cadt/permissions.json` 的裸路径规则。不开放目录树写授权（写授权比读授权危险，读侧 rootDir 粒度不照搬）；项目规则的绝对路径按段判定（`matchPathGlobRule` 已支持）。
5. **应用数据目录写硬拒，含 full 档**：新 `hardWriteDenyReason`（判定与例外同读侧 `sensitiveReadDenyReason`：ai-artifacts 产物子树与 ai-workspaces 会话沙盒例外），先于审批卡与档位判定执行。full 档原本可写 appdata，本次收紧对齐读侧（读侧 full 档 2026-11-16 同口径修复）——密钥（ai-config.json）与会话正文不允许被 AI 覆盖。
6. **子代理不弹卡**：`subWriteVerdict` 限可写根，工作区外确定性拒绝（越界拒绝文案从「路径超出工作区范围」变为「超出子代理可写范围」，同为确定性拒绝）；编排会话审批放行后再过 `OrchestrationAuthorizeWrite` owns 闸（fail-closed 不变）。

## 2. 实现落点

| 部分 | 位置 |
|---|---|
| 写侧硬拒纯函数 | `frontend/src/ai/security/ai-read-roots.js`：`hardWriteDenyReason(path, appDir)`（与 `hardReadDenyReason` 同段并列，无 scanRoot 语义——写没有目录起点） |
| 决策链 | `frontend/src/ai/security/ai-permissions.js`：`decidePermission` 新输入 `outOfWorkspace`（缺省 false，additive），write 分支 auto 档 `risky \|\| outOfWorkspace` → ask（source `out-of-workspace`，落操作记录审计） |
| 写路径解析 | `frontend/src/ai/ai-panel.js` `resolveWritePath(inputPath, session)`：try `aiResolveScopePath` → catch 取 `absPath` 标记越界 → `hardWriteDenyReason` 硬拒 → 返回 `{path, outOfWorkspace}` |
| 写 case 换用 | write_file（12615→12646）/ edit_file（12666→12701）/ code_outline maintain（11134→11162）：`outOfWorkspace` 随 info 传入 `applyWorkspaceWrite` |
| 审批判定 | `applyWorkspaceWrite`：`decidePermission` 传 `outOfWorkspace: info.outOfWorkspace === true`；`requestApproval` 的 approval 对象带 `outOfWorkspace` 供卡片提示 |
| 审批卡提示 | `ai-takeover.js` 写卡 diff 上方 + `ai-tool-cards.js` `renderApprovalBody`：「该文件在工作区外。批准仅对这一个文件生效（可勾选记住，免下次再问）；应用数据目录始终拒绝写入。」 |
| 工具描述 | `ai-tool-defs.js` write_file / edit_file：description 补越界审批语义；`path` 参数说明照 read_file 口径补 "or an absolute path outside the workspace (an approval card asks first)" |
| 档位守则 | `ai-system-context.js`：auto 档守则补「writes outside the workspace always ask first」；路径守则句拆分读写口径（读：点名 / 已批准 / auto 直读、read/edit 弹卡；写：非 full 一律先弹卡） |
| wipeguard 顺手修复 | 三个 `backupWrite` 调用点补 `existed: true`——守卫 `!call.existed`（ai-wipeguard.js:689）导致 L1 写前快照自接入以来从未真正触发（存量 bug，本次改动面上修复） |

## 3. 已知边界（明确不做）

- wipeguard watcher / L3 定期快照 / Restore 只覆盖工作区根：工作区外文件的 L1 写前备份会落盘（内容寻址库不校验位置），但无法经工作区恢复链找回——记录局限，不扩 watcher。
- 命令通道行为不变：auto 档命令改工作区外仍走命令审批 / 分类器（写工具弹卡后，模型没有动机再绕命令通道）。
- 编排会话：审批卡放行后再过 `OrchestrationAuthorizeWrite` owns 闸（fail-closed，不变）；工作区外路径通常不在 owns 内，会被拒绝——编排纪律优先。
- full 档 appdata 收紧是行为变化：以前 full 可直写应用数据目录，现在任何档都拒绝（对齐读侧）。
- 「记住」粒度保持精确文件路径，不做目录树写授权。

## 4. 手工回归清单（wails3 dev）

1. **auto 档弹卡**：让 AI edit_file 一个工作区外文件 → 弹 diff 写审批卡（含工作区外提示行）；批准 → 落盘成功，工具结果「已应用更改：<绝对路径>」；拒绝 → 文件未动。
2. **记住免再问**：勾「本会话允许此文件」→ 同文件第二次写入直接应用；另一文件仍弹卡。勾「总是」→ 重启后仍免；勾「本项目」→ `.cadt/permissions.json` 出现 `Write(D:/xxx/...md)` 裸路径规则。
3. **edit 档**：工作区外 edit_file 同样弹卡（原为硬拒）。
4. **full 档**：工作区外直写不弹卡（不变）；写应用数据目录内文件 → 硬拒「拒绝写入」（新收紧）。
5. **appdata 硬拒**：任意档写 ai-config.json 所在目录 → 硬拒；写 ai-artifacts 子树 → 弹卡（产物子树例外）。
6. **计划模式 / 子代理**：计划模式写文件仍入口硬拒；子代理写工作区外仍确定性拒绝（文案变为「超出子代理可写范围」）。
7. **编排**：编排 work 角色写工作区外 → 审批卡放行后仍被 owns 闸拒绝（fail-closed）。
8. **wipeguard**：写入工作区外文件后，wipeguard 备份索引出现 L1 记录（修复验证：`existed` 传入前从未落过）。
9. **命令通道对照**：auto 档用 run_command 改工作区外文件 → 命令审批卡（行为不变）。
10. **操作记录**：auto 档越界写弹卡时，设置 → 操作记录可见 `ai.ask`（来源 out-of-workspace）审计行。
