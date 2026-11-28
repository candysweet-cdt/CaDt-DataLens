# AI 删除工具 delete_path：回收站专用 + 判定链接入（实施记录）

> 状态：**已完成**（2026-11-28 实施落地；本文保留设计取舍与手工回归清单）
> 起因：评估结论——删除是破坏性最高的高危文件操作，却是唯一还走「命令字符串审批」的（`rm` / `Remove-Item` / `find -delete`，且源码注释承认 `Remove-Item -Recurse` 整体漏标，红队 V-01/F-9）。Go 侧回收站能力现成（`internal/recycle` SHFileOperationW + `fsops.DeleteEntry` 校验），只缺 AI 工具壳。作者拍板三条：**工具删除必须进回收站**、**权限档位从紧**、**描述/守则/命令卡三处引导模型用工具替代 shell 删除**；实施中追加**单次删除阈值警告**（超 AI_DELETE_BULK_WARN 个条目在审批卡加警告块，不做会话累计）。

## 1. 设计原则（作者逐条拍板）

1. **必须进回收站，做成跨平台不变量**：新增绑定 `fsops.FS.DeleteEntryRecycle`——Windows 走既有 `deleteEntry`（SHFileOperationW + FOF_ALLOWUNDO，含拒根目录/非普通文件/空字节校验），非 Windows 直接报错而不是退化成 `recycle_other.go` 的 `os.RemoveAll` 硬删。AI 工具只调这个绑定，绝不调 `DeleteEntry`（后者在非 Windows 是硬删）。
2. **独立 `kind='delete'`，授权写 ≠ 授权删；auto 档口径与 write 对齐**：`PERMISSION_KINDS` 加 delete 桶（`Delete(D:/xxx/**)` 行语法），不复用 write——否则 `Write(**)` 规则命中会把删除放行。`decidePermission` 的 delete 分支形状与 write 相同：auto 档风险合成（工作区外 / 展开超量级 / 风险路径 / 脏文件，调用方并入 risky）转人工，其余**直接删不弹卡**——删除有回收站 + 删除前 L1 快照双层兜底，小范围工作区内删除的可恢复性不低于 auto 档本来就直放的写；full 直删走 generic 分支；项目 deny/ask/allow 规则在上方照常生效。edit 档整单弹卡。
3. **删除不提供「记住」**：调用方不传 sessionAllow（写侧 approvedPaths 不外溢到删除），接管卡勾选框段对 delete 跳过，`decideApproval` delete 分支兜底清空——风险合成之外的删除每次必问。
4. **影响面审批**：卡上逐条展示完整真实路径 + 文件大小（`GetPathInfo`）或目录条目数（`ReadDirTree(path, 8)`，照 list_dir 口径：400 项预算、跳 .git/node_modules、截断标记）。**单次阈值双重角色**：展开总条目超过 `AI_DELETE_BULK_WARN`（40，与 wipeguard 的 `WIPEGUARD_DELETE_THRESHOLD` 对齐）或枚举截断时——auto 档不再直删（转人工）且卡上加 `ai-approval-danger` 警告块（对齐危险命令卡红块）。只看单次调用，不做会话累计。
5. **多路径显式清单，禁 glob**：`paths` 数组一次最多 `AI_DELETE_PATHS_LIMIT`（20）条显式路径，**整单一张卡一次批准**（逐条全列）；校验阶段任一条失败（通配符 / appdata / 不存在 / 超上限）**整单拒绝**并列出问题条目——用户批准的是完整清单，部分有效会造成「批的卡和删的东西不一致」；执行阶段单条失败不中断其余、结果汇总。删一类文件的正当路径 = 先 glob 查具体路径再显式传 paths（写进描述）。
6. **删除前 L1 快照（仅文件）**：`wipeguard backupWrite({content:'', existed:true})`——Go 侧 Backup 先读 absPath 磁盘、读失败才退回 Content，所以文件能拿到真实内容快照（删错文件有回收站 + wipeguard 双层）；目录跳过（ReadFile 必失败会落空 blob）。
7. **子代理与群聊不给删除**：能力快照不注入（`agent-capabilities` 只 push write_file/edit_file）+ 执行层 `applyDelete` 对 `parentSessionId` 确定性拒绝双闸。计划模式进 `PLAN_MODE_DENIED_TOOLS`。
8. **命令通道判定不放宽不改动**：`deletionHintFor` 是纯文案层引导（识别面刻意比危险特征表宽，含 Remove-Item 漏标形态），不改 dangerous/risky 分类、不动 ai-shell-choice 三通道。漏标修复另立项（P1）。

## 2. 实现落点

| 部分 | 位置 |
|---|---|
| 回收站专用绑定 | `internal/fsops/delete_platform_windows.go`（`DeleteEntryRecycle` → `deleteEntry`）+ `delete_platform_other.go`（报错）；绑定基线 +1（449 条），`backend.d.ts` 重生成 |
| 工具定义 | `ai-tool-defs.js`：`AI_TOOL_DEFS.delete_path`（path 单条 + paths 数组 ≤20，required 空、二选一）+ CATALOG（group write）+ `toolsForScope` 写组 + 编排裁剪白名单 work 分支（删除仍要过 owns 闸） |
| 判定链 | `ai-permissions.js`：PERMISSION_KINDS / KIND_PREFIX / PREFIX_KIND / emptyPermissionRules / parseRuleLines 文案 / matchPermissionRule / decidePermission delete 分支（auto：risky→ask，否则 allow/auto）；`ai-permission-settings.js`：kind 标签、规则表格桶、auditRulePattern |
| 目标收集 | `ai-file-tools.js` `collectDeleteTargets(input, limit)` 纯函数：paths 优先 / 单条回退 / 拒通配符与空串 / 钳上限，错误点名条目 |
| 执行链 | `ai-panel.js`：case 'delete_path'（collectDeleteTargets → 逐条 resolveDeleteEntry（resolveWritePath 越界捕获 + appdata 硬拒 → GetPathInfo/ReadDirTree 影响面 → wipeguard 快照），任一条 throw 整单拒并列条目）→ `applyDelete`（toolHalted → mainRootWriteVerdict 逐条 → 子代理拒 → risky 合成 → decidePermission 逐条任一 deny 整单拒 → 一卡或直删 → 编排 owns 闸逐条 → DeleteEntryRecycle 逐条、失败汇总）；`requestDeleteApproval`（kind delete + entries 清单）；`decideApproval` delete 分支 + audit kind 'delete'；PLAN_MODE_DENIED_TOOLS |
| 审批卡 | `ai-takeover.js`：折叠条「删除待审批」、正文（多条逐条清单 / 单条路径 + 影响面 + 回收站说明 + 批量警告 + 工作区外计数提示）、记住勾选段跳过；`ai-tool-cards.js`：toolMeta（删除/trash）+ renderApprovalBody delete 状态文案（已移入回收站/已取消，未删除/删除失败）+ 工作区外提示分文案 |
| 阈值常量 | `ai-constants.js` `AI_DELETE_BULK_WARN = 40`（对齐 wipeguard `WIPEGUARD_DELETE_THRESHOLD`，auto 直删上界 + 卡红块阈值）+ `AI_DELETE_PATHS_LIMIT = 20`（单次显式路径上限） |
| 引导三通道 | 工具 description（Prefer over shell deletion commands）+ `ai-system-context.js` Tool rules 新行 + `ai-command-rules.js` `deletionHintFor`（导出纯函数）+ 命令审批卡 note 追加提示 |
| mock | `dev/mock-backend.js` `DeleteEntryRecycle`（转发 DeleteEntry） |

## 3. 已知边界（明确不做）

- 不提供「记住」：风险合成之外的删除每次必问（full 除外）；噪音问题再议专用 approvedDeletePaths。
- glob / 通配符仍禁：删一类文件 = 先 glob 后显式 paths；单次上限 20 条，超过分批发起。
- 整单原子性不做「跳过坏条目继续删」：校验阶段任一失败整单拒；执行阶段单条失败仅汇总不中断（回收站语义下安全）。
- 命令通道判定不放宽不改动；`Remove-Item -Recurse` 漏标修复另立项。
- 目录删除不做逐文件 L1 快照（回收站 + L3 兜底）；ReadDirTree 不计忽略目录，卡片已注明口径。
- 非 Windows 平台 delete_path 不可用（绑定报错），与「必须可恢复」不变量一致。

## 4. 手工回归清单（wails3 dev）

1. **auto 档直删**：删工作区内小文件 → 不弹卡直接进回收站，工具结果「已移入系统回收站」，操作记录可见 `ai.approve`（来源自动权限档）+ wipeguard L1 记录。
2. **auto 档弹卡边界**：删 >40 项的目录 / 工作区外路径 / AGENTS.md / 有未保存修改的文件 → 弹卡；超量级时带红块警告；拒绝 → 条目未动。
3. **多路径一卡**：跨目录 3 个文件一次 paths → 一张卡逐条列全清单 → 批准全部进回收站；结果「已移入系统回收站 3 个条目（清单共 3 条）」。
4. **坏条目整单拒**：清单混一个不存在路径或 appdata 路径 → 整单不发卡、错误点名该条目；混项目 Delete deny 命中条目 → 整单拒并列规则。
5. **上限**：paths 传 21 条 → 直接拒并提示分批。
6. **edit 档**：删除一律弹卡（直删不生效）。
7. **full 档**：直删不弹卡，工具结果「已移入系统回收站」。
8. **appdata 硬拒**：删应用数据目录内条目 → 硬拒（复用 hardWriteDenyReason），整单未发起。
9. **通配符**：`path`/`paths` 含 `*`/`?` → 拒并指引「先 glob 查具体路径再显式传 paths」。
10. **子代理 / 计划模式**：均确定性拒绝。
11. **命令卡引导**：auto/edit 档发 `rm x.txt` / `Remove-Item -Recurse dist` → 命令审批卡出现「检测到删除命令…建议改用 delete_path」。
12. **dev 模式**：mock 下单条与多路径删除正常（内存 FS 移除）。
