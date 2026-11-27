# 子代理命令执行与 OS 级沙箱（方案）

> 状态：**已实施：阶段 A–D 已于 2026-11-17 落地（见 §4 实施记录）；方案 C 确认采用，2026-11-17 按真机实测修订**
> 决策：2026-11-17 —— 作者在对齐 dsh（`D:\OraSkyC\Project\OpenSource\deepseek-harness`）实现后选择「接受 shell 分裂，继续 C」。本文档是唯一实施依据；§7 保留原复核意见作为过程记录，§8 记录推翻它的实测数据。
> 决策修订（2026-11-27）：子代理缺省权限由「继承父档」改为「封顶 auto」（`min(auto, 父档)`），full 档不再默认继承完全权限；显式传 `sandbox:'full'` 仍是逃生舱，且会给主代理投一条非阻塞警告。同时给子代理命令留痕加轻量审计摘要（命令族 + cwd，不记正文/参数）。理由见 §3.1 与 §6-1。原「full 继承」决策保留在下文作为历史记录。
> 范围：子代理获得命令执行能力，文件效应由 Windows OS 级沙箱强制圈定；不改主会话命令链路、不做子代理审批链路（子代理永远「不问」）、不做 macOS/Linux

## 1. 背景与现状

### 1.1 现状（代码事实）

- 子代理工具白名单 `subToolsForScope(depth, mode, hasWorktree)`（`frontend/src/ai/ai-subagents.js:303`）：只有 list_dir / read_file / read_image / read_video / search_text / web_search / web_fetch / memory_list / memory_read / timer_list / skill_use / env_list（后台模式 + ask_user，深度允许 + spawn_agent，隔离 worktree 额外 + write_file / edit_file）。**没有命令工具**。
- 执行侧用 `allowed` 集合硬挡（`runSubRound` 的工具循环）：范围外调用走独立的确定性拒绝分支——模型侧文案「超出子代理只读范围……不要重试，在最终结论中说明限制」，留痕 `ai.tool` status: denied（2026-11-15 落地）。
- 子代理系统提示已声明「工具范围在派出时已固定，无法从会话内放宽；被拒不要重试、上报父会话」（同日落地，对齐 dsh 的 `SUBAGENT_DELEGATION_CONTEXT` 声明）。
- 主会话命令链路：审批卡 + 自动审批档 + `timeoutMs`（默认 30 s、上限 600 s）→ `AIRunShellCommand`（`internal/cmdbridge/ai_command_windows.go:94`）→ `runCommandSyncRegistered`（`internal/cmdbridge/app_commands.go:59`，`exec.CommandContext` + `envvars.MergeEnv` + `executil.HideCommandWindow` + `procctl` 取消注册）。shell 由 `aiShellInvocation` 选择：**Git Bash → PowerShell 7 → Windows PowerShell → cmd**。
- 2026-11-15 实测：子代理探针调用 run_command / background_command / start_timer 全部被拒——「让子代理跑测试 / 只读探测」在架构上堵死。

### 1.2 dsh 参考事实（2026-11-17 逐文件核对）

- **策略钉死派生边界**（`packages/subagent/subagent/src/child-agent.ts` 的 `captureDelegatedPolicyOverrides`）：派生时只捕获父会话**显式**设置的 sandbox mode（不复制部署默认、不复制一次性 grant），approval 一律钉死 `policy:'never', source:'delegation'`。
- **写根定义**（`packages/sandbox/sandbox-policy/src/index.ts:197`）：`workspaceRoot = session.header.cwd`（会话不可变 cwd，**不是副本、不是 worktree**）；无 cwd 时回落部署配置。`additionalWritableRoots` 由部署显式列出，**Windows 后端直接拒绝**（`sandbox-local/README.md:133`，`SANDBOX_UNSUPPORTED_POLICY`）。
- **写入白名单推导**（`packages/sandbox/sandbox/src/roots.ts`）：`workspace-write` = 工作区 + 显式额外根 + 平台 temp；`read-only` 为空。Windows 不用系统 temp，而是每次拉起一个**随机私有 temp 目录**并以独立 SID 授权（`sandbox-local/README.md:83`）。
- **Windows 后端**（`packages/sandbox/sandbox-windows-acl/src/`）：`CreateRestrictedToken(WRITE_RESTRICTED|DISABLE_MAX_PRIVILEGE)`，restricting 列表 `read-only=[logonSID, Everyone]` / `workspace-write=[logonSID, Everyone, workspaceSID, tempSID]`，再降到 Low 完整性；每次授予在**一次** `SetNamedSecurityInfoW` 里同时落三件事——能力 SID 的 allow ACE、Everyone 的 `FILE_DELETE_CHILD` deny（只继承到容器）、Low no-write-up 标签；workspace ACE 永久 standing（复用缓存），temp ACE 可撤销；`enforcement` 如实标 `partial`。
- **token 默认 DACL 必须补授权**（`sandbox-windows-acl/src/token.ts` 的 `setTokenDefaultDaclGrant`）：受限令牌不继承任何 restricting SID，新建对象（管道、共享内存）的 write 二次检查必失败。
- **默认档 fail-safe**：`mode` 默认 `read-only`，`workspace-write` 需部署显式 opt-in。
- **免责**（`SAFETY.md`）：沙箱/审批/权限只是减险手段，不构成隔离保证。

### 1.2b ZCode 参考事实（2026-11-17 核对 `D:\OraSkyC\Project\OpenSource\ZCode`）

ZCode **没有 OS 级沙箱实现**——`ExecutionSandboxPolicy`（`packages/contracts/src/interfaces/execution.port.ts:110`）只有 `{enabled, profile?, dangerouslyDisableSandbox?, metadata?}`，第一版是 no-op，靠 trace/telemetry 记录 `sandboxed`。可采纳的是它的**契约纪律**与 **Windows 执行合同**：

- **如实上报优先于假装**：adapter 不支持沙箱时必须暴露 `unsupported` / `no-op`，并把它写进 trace 与工具结果，不能静默降级（`04-bash.md:386`）。
- **沙箱是独立边界**：不与 WebFetch 的预授权域名混同；`dangerouslyDisableSandbox` 只能「策略允许 + 用户批准」后生效（`:161`、`:462`）。⇒ 本项目子代理永远「不问」，所以**不向子代理暴露任何 bypass 参数**。
- **权限分三层**：`ShellParserPort`（跨平台 argv 视图）/ `ShellPermissionPolicy`（只读、危险语义、规则匹配）/ `ExecutionPort`（执行 + timeout + cancel + sandbox），接口必须与具体 shell 解耦（`:168`、`:204`）。⇒ 支持我们「沙箱只管效应、权限分层各司其职」的切法。
- **只读判定必须带 shell 上下文**：`cmd` / `legacy-shell` 下 Bash AST 不能证明只读（`type # & python script.py` 在 AST 里只剩 `type`，CMD 仍执行 Python），因此这两种 shell 不授予免审批（`:170`）。⇒ 我们若在 P2 引入命令分类器，必须知道这条命令在哪个 shell 里跑——沙箱档是 PowerShell，分类器的只读白名单不能沿用 bash 那套。
- **Windows 执行合同**：不要求用户装 Git Bash；`argv` 模式必须解析 `PATHEXT`（`pnpm`/`npm` 是 `.cmd` shim）；`.cmd`/`.bat` 不得直接 spawn，必须显式经 `ComSpec`；`PATH` 按 `;` 拆分并去引号；`env` 的 set/unset 大小写无关（`:197-220`）。
- **文件改动优先专用工具**：读用 `Read`、改用 `Edit`/`ApplyPatch`，不要用 shell 脚本绕过（`:436` 设计结论）。
- **子代理继承**：ZCode 是「继承父 turn 的 runtime config、cwd、approval、sandbox、环境」的**全量继承**（`07-subagent-background-plan.md:49`），与 dsh「只继承显式 override」不同。本项目用第三种：按权限档映射（§3.1），因为本产品没有独立的 sandbox mode 状态。

### 1.3 问题

子代理无法执行命令，探测类任务（跑测试、`git log`、查版本、错峰验证）只能由主会话串行做或靠读文件耗时间。dsh 的经验是：命令能力可保留 + 策略约束，前提是文件效应有 OS 级兜底。本项目在 Windows 上的对应物是受限令牌 + ACL（纯 Win32，`golang.org/x/sys/windows` 已是直接依赖，0 新依赖）。

## 2. 目标与非目标

### 目标

1. 子代理可按策略执行 `run_command` / `background_command`，文件效应由 OS 沙箱圈定。
2. 派生边界策略快照：sandbox 模式随 spawn 固定，子会话内不可放宽（含孙代理）。
3. fail-closed：沙箱不可用即拒绝执行并在工具结果中说明，绝不静默裸跑。
4. 执行与拒绝落操作留痕（命令输出不落盘）；子代理提示如实声明边界（含 shell 差异）。
5. Windows-only；复用 `golang.org/x/sys/windows`。
6. 每阶段独立提交、独立验证、独立回滚。

### 非目标（明确排除）

- **不做子代理审批链路**：永不弹卡（dsh pin never 同款）；escalation 仅主会话可用。
- **不改主会话命令链路**：审批 / 分类器 / timeout 语义不动；主会话接入沙箱列为 P2 可选延伸（§6）。
- **不承诺隔离保证**：定位为「误操作兜底」而非「对抗性防御」——威胁模型是模型失误与提示注入的**后果收敛**。
- **不做 Git Bash 的沙箱化**：实测结论（§8.2）——Cygwin 在 restricting SID 下无法启动，沙箱档 shell 固定 PowerShell（回退 cmd）。这是显式接受的产品代价，不当作待办。
- 不做 macOS/Linux；v1 不暴露 `additionalWritableRoots` 用户配置（且 Windows 后端本就不支持）。

## 3. 设计

### 3.1 策略词表与派生映射

- `SandboxMode = read-only | workspace-write | danger-full-access`（与 dsh 词表一致）。
- 父权限档 → 子代理 sandbox 快照（spawn 时解析并冻结到 `sub.policy`）：

| 父档 | 子代理 sandbox | 理由 |
| --- | --- | --- |
| read | read-only | 只读契约原样下传 |
| edit | read-only | edit 档的写审批依赖「人在场」，子代理没有审批通道 |
| auto | workspace-write | auto 契约即非风险自主执行 |
| full | danger-full-access | 原决策「继承父的完全权限」（对齐 dsh「继承宽身份」）；**2026-11-27 起仅显式 `sandbox:'full'` 才走到这里**，缺省改为封顶 auto（见下） |

> **2026-11-27 缺省封顶 auto**：`subScopeDowngrade` 的缺省值从「父档」改为 `auto`，即子代理权限 = `min(auto, 父档)`。full 档主会话派出的子代理默认落到 auto → `workspace-write`，命令进沙箱、写效应圈在写根内。
> 理由：full 档子代理此前继承完全权限，命令裸跑不进沙箱、可写工作区外任意路径；而操作留痕不记命令正文/目标路径、子代理转录不落盘（`ai-panel.js`「子代理元数据：转录不落盘」），事后基本无法追溯。auto 的价值不在「限制读」（工作区外读取 auto 与 full 都放行，见 `ai-permissions.js` 的 read 分支），而在把写效应从「整个磁盘」收敛到「一个写根」——在留痕粗糙的现状下，这是唯一可靠的追溯手段。
> 显式传 `sandbox:'full'` 保留为逃生舱（确实需要子代理跨目录写时），此时 `startSubAgent` 向发起方信箱投一条非阻塞 `scope-warning` 消息（新 `buildFullScopeWarning`，前缀「［子代理权限警告］」，走信箱排队不阻塞派单）。配套轻量留痕：命令类工具记 `cmdFamily` + `cwd`，full 档标 `sandbox:'danger-full-access'`，刻意不记命令正文/参数（防密钥泄露）。

### 3.2 写根（对齐 dsh，v1 定死）

| 项 | 取值 | 说明 |
| --- | --- | --- |
| `workspaceRoot` | **该子代理的 cwd**（`aiResolveScopePath` 解析后的绝对路径） | 隔离 worktree 子代理天然落在 `.cadt/worktree/<slug>`；普通子代理落在会话工作区。语义与 dsh 的 `session.header.cwd` 一致 |
| 私有 temp | 每次 spawn 一个随机目录（`os.MkdirTemp`），TMP/TEMP 重写指向它，独立 SID 授权，进程退出后撤销 ACE 并删目录 | 对齐 dsh：系统 temp **永不**整体授权 |
| 额外写根 | v1 不支持 | Windows 后端本就不支持；不引入 v1 之外的可注入面 |
| 读范围 | 不受沙箱限制 | 沙箱只管写效应；读边界由既有权限档管 |

- `background_command` 同样放行；后台 job 挂在子代理上，子代理终止即 kill（Job Object `KILL_ON_JOB_CLOSE`）。
- 写根与 temp 必须互不包含（对齐 dsh `assertPrivateTempDisjoint`），任一方向重叠直接 fail-closed。

### 3.3 Windows enforcement（Go 侧，按实测修订）

新包 `internal/sandbox/`（`sandbox_windows.go` + `sandbox_other.go` 桩；纯引擎，不 import main）。任一步失败即停：

1. **令牌**：`OpenProcessToken` → 取登录会话 SID（`TokenGroups` 里带 `SE_GROUP_LOGON_ID` 的项）→ `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE|WRITE_RESTRICTED, restricting=[logon, Everyone, workspaceSID, tempSID])` → `SetTokenInformation(TokenIntegrityLevel, Low)` → **`SetTokenInformation(TokenDefaultDacl)` 补一条 restricting SID 的全权 ACE**（缺这步新建管道与 Cygwin 初始化全挂，dsh 同一处修复）。
2. **SID 派生**：workspace SID = `sha256(规范化工作区路径)` 前 8 字节取模成 `S-1-4-x-y`；temp SID 再加第三个子授权 `-1` 做域分离。workspace ACE 同 dsh 一样永久 standing（复用缓存），temp ACE 可撤销。
3. **授予**：`GetNamedSecurityInfoW(DACL|LABEL)` → `SetEntriesInAclW` 合并两条记录（Everyone 的 `FILE_DELETE_CHILD` deny `CONTAINER_INHERIT` + 能力 SID 的 `GRANT_MASK` allow `OI|CI`）→ `SetNamedSecurityInfoW` 一次写入 DACL + Low 标签。整段 get-merge-set 走 per-path `LockFileEx` 排他锁。幂等：三条记录都已存在则跳过（`SetNamedSecurityInfoW` 会 eager 传播整棵树，大树几十秒）。
4. **启动形态**：子进程**继承宿主的隐藏控制台**（`AllocConsole` + `ShowWindow(SW_HIDE)`，懒执行一次），`CreationFlags = 0`。**禁用** `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE` / `HideWindow`——实测三者一律 `0xC0000142`（STATUS_DLL_INIT_FAILED）。
   > 为什么不是 `DETACHED_PROCESS`：它能跑 `cmd.exe`，但 **PowerShell 在无控制台时静默退出**（exit 0、什么都不执行，5.1 与 7 都是，实测）。沙箱档的 shell 是 PowerShell，所以 v1 用隐藏控制台；`sandbox.Policy.ShareConsole` 保留两种形态，`DETACHED` 留给只用 cmd 的场景。
   > 已知副作用：`AllocConsole` 是进程级的一次性动作，会改变宿主 stdout/stderr 指向；控制台已隐藏，非沙箱命令仍走 `CREATE_NO_WINDOW`，不受影响。
5. **shell**：沙箱档命令固定走 PowerShell（`shellpath.FindPwsh()` → `powershell.exe` → `cmd.exe`），**永不解析 Git Bash**。`aiShellInvocation` 增加 `sandboxed bool` 参数，非沙箱档行为零变化。
6. **Job Object**：`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，子代理终止连带杀全进程树（补 `RunStop` 的树杀缺口）。
7. **失败分类**：任一步失败 → `SANDBOX_UNAVAILABLE`，工具结果明确「沙箱不可用，命令未执行」，**不降级裸跑**。
8. `enforcement` 如实标 `partial`（硬链接别名可绕过、读不受限、AppContainer 打过包 SID 的树读不了）。

### 3.4 派生边界与前端

- `spawn_agent` 时解析并冻结 `sub.policy = {sandboxMode, workspaceRoot}`；`subToolsForScope` 按 policy 挂载命令四件套 `run_command` / `background_command` / `check_command` / `stop_command`（三种模式都挂，效应由 Go 侧管）。
  > **实施订正（2026-11-17）**：后台三件套必须一起挂——只给 `background_command` 不给 `check`/`stop`，模型起了作业也读不到、停不掉。对应 Go 侧新增 `AICommandStartConfined(command, cwd, mode, workspaceRoot)`：作业退出后由 `startCommandConfined` 的收尾路径撤 temp 授权、删目录、杀残留进程树。
  > 策略不再单独存字段：`subSandboxPolicy(session)` 由既有持久字段现算——`session.scope`（父档继承而来）+ `session.worktree`（隔离区绝对路径，优先）+ `session.workspace`。这样恢复会话、孙代理递归都不用额外序列化。
  > 子代理不弹审批，但**项目 deny 规则照旧生效**：只调 `evaluatePermissionRules` 取 `deny`，不问、不跑分类器（用户的禁令不是「需要人判断」的事）。
  > 已知粗糙处：`stop_command` 按 jobId 直接停，没有「只能停自己起的作业」的归属校验（jobId 对模型不透明，暂无实际风险，P3 再收紧）。
- 子代理系统提示新增两段：「你可执行命令，文件效应被沙箱圈定在 <mode>：<root>」+「**沙箱内 shell 是 PowerShell，不是 bash**；命令请用 PowerShell 语法，`ls`/`grep`/`sed` 这类写法不要用」。
- 拒绝文案沿用现有确定性拒绝分支形状，新增 `sandbox-denied`（OS 层拒绝）与 `sandbox-unavailable` 两种 status，留痕 `ai.tool` 对应。
- 子代理详情视图（HUD）显示 `沙箱 只读 / 可写 / 完全`（`ai-head-hud.js` 副标题，读派出时定死的 `sub.sandboxMode`；未知档位原样回显，不猜）。
- 卡片如实显示 `PowerShell 7` / `Windows PowerShell` / `Command Prompt`——用户一眼能看出这条命令没走 Git Bash。
- **沙箱状态必须如实进卡片与留痕**（ZCode 契约纪律 §1.2b）：`sandbox: workspace-write (partial)` / `sandbox: unavailable` / `sandbox: bypassed(full)` 三态之一，不允许「看起来沙箱了其实没沙箱」。`enforcement=partial` 也进卡片。
- **不向子代理暴露任何 bypass 参数**：子代理永远「不问」，`dangerouslyDisableSandbox` 这类字段只可能出现在主会话（P2），且必须走审批。

### 3.5 审计（已实施 2026-11-17）

- 执行：`logActivity('ai.tool', name, {status, ms, depth, sandbox?})`，沿用「不记命令输出正文」；子代理工具循环此前只在「范围外拒绝」时留痕，现在**每次工具执行都留痕**（子代理的命令无人可问，留痕是唯一审计面）。
- status 词表新增两种，与 `done` / `error` 并列：
  - `sandbox-denied`：命令失败且 stderr 命中 ACL 拒绝特征串（Go 侧 `detectSandboxDenial`，用 `chardec.DecodeBytes` 自动解 UTF-8 / GBK，认「拒绝访问」「Access is denied」「is denied」「Permission denied」等）；**宁可漏判成 `error` 也不误判**——把「工具链崩了」记成「沙箱拒绝」会误导排查。
  - `sandbox-unavailable`：沙箱建不起来（fail-closed 拒绝执行），`error` 文案里带「沙箱不可用」。
- 成功执行不单列 status（仍是 `done`），档位记在 `sandbox` 字段（`read-only` / `workspace-write`），设置页操作记录可按它筛。
- **后台作业的拒绝已能分类**（2026-11-17 补齐）：作业退出时 Go 侧按缓冲里的 `[stderr]` 行调同一个 `detectSandboxDenial`，结论放进 `AICommandJobStatus.sandboxDenied`；`check_command` 轮询到就把这次调用记成 `sandbox-denied`，并在结果里加一句「这条命令被沙箱拒绝」。
- `stop_command` 做归属校验：只能停**本任务树**（`rootSessionId` 相同）起的作业，越界确定性拒绝并记 `denied`——子代理跑命令后没人看着，不能让它顺手掐掉别的会话的后台作业。
- 字段命名：工具消息上承载覆盖的字段叫 **`activityStatus`**（不是 `sandboxStatus`）——它同时承载沙箱拒绝、沙箱不可用与作业归属拒绝三类确定性结果，用沙箱命名会让第三类无处安放；档位另记在 `sandbox` 字段。留痕读取处按 `activityStatus || (error ? 'error' : 'done')` 取，拒绝不会被记成普通成功。

## 4. 阶段划分（每阶段独立提交）

1. **阶段 A（Go 沙箱引擎）— 已实施（2026-11-17）**：`internal/sandbox`（令牌、默认 DACL、SID 派生、ACL 三重授予与撤销、幂等跳过、Job、fail-closed、temp 与写根互不包含）+ 11 例真机测试。
2. **阶段 B（执行链接线）— 已实施（2026-11-17）**：`sandbox.Policy.ShareConsole`、`runCommandSyncConfined`（沙箱档不调 `HideCommandWindow`）、`aiShellInvocation(command, sandboxed)`、新绑定 `AIRunShellCommandConfined(command, cwd, timeoutMs, runId, mode, workspaceRoot)`、结果带 `sandboxMode` / `enforcement` / `tempDir`。主会话不启用沙箱，行为零变化。
3. **阶段 C（子代理挂载）— 已实施（2026-11-17）**：`subSandboxPolicy` / `subSandboxModeOf`（`ai-subagents.js`）、`subToolsForScope` 挂命令四件套、子代理系统提示声明「沙箱 + PowerShell 语法 + 后台三件套用法」、`run_command` 与 `background_command` 分支按会话分流（沙箱 → `AIRunShellCommandConfined` / `AICommandStartConfined`，主会话 → 审批链不变）、结果行回显沙箱档位与写根。Go 侧 `AICommandStartConfined` + `startCommandConfined`（作业退出后收尾）。护栏 `frontend/test/ai/ai-subagent-sandbox.test.mjs`（8 例）+ `internal/cmdbridge` 3 例。
   > 余量：无（HUD 档位标签、`stop_command` 归属校验、后台作业的 `sandbox-denied` 分类均已在 2026-11-17 补齐）。
4. **阶段 D（收尾）— 撤销工具与设置页说明已实施（2026-11-17）**：`sandbox.Scan` / `sandbox.Revoke`（引擎）+ 根壳 `sandbox_app.go` 的两个绑定 + AI 设置 → 权限 → 「子代理命令沙箱」小节（说明 + 检查 / 清除授权两个按钮）。
   > `Revoke` 只删「完全匹配本应用签名」的条目：能力 SID 的 allow ACE、Everyone 的 `FILE_DELETE_CHILD` deny（按 ACE 逐条重建 ACL，**不能**用 `REVOKE_ACCESS`——那会把 Everyone 的其它授权一起删掉），以及没有其它能力授权时的 Low 标签。若重建后 ACL 为空则放弃并报错（空 DACL = 全员拒绝，比留着残留更糟）。
   > 余量：无（README / CHANGELOG 的用户向说明已随 2026-11-17 的收口补上）。
5. **阶段 E（Low 标签事故修复）— 已实施（2026-11-27）**：workspace-write 的唯一写根改为每次调用新建的私有临时目录（方向④），Low 标签不再落真实工作区/worktree；`TMP/TEMP` 与 `TempDir` 回显同步指向该目录。新增启动残留自检（延迟 2 秒异步 Scan、用户确认后 Revoke、不阻塞首屏）、包内 `SeSecurityPrivilege` 统一启用、AGENTS.md 联调硬规则与源码守卫测试。详见 `docs/reports/incident-2026-11-27-sandbox-low-label.md`。

## 5. 风险与代价（如实记录）

- **工程量**：Go 侧 1000–1500 行 + Windows 集成测试，数周级。
- **永久副作用（2026-11-27 已修复）**：原方案把 Low 完整性标签永久打到 workspace 树，导致仓库内所有 exe（含 `node_modules` 构建工具）以 Low 启动。现改为只给每次调用的私有临时目录打标签，执行结束连目录删除，工作区不再残留。历史残留仍可用 `sandbox.Revoke`（设置 → 权限 → 子代理命令沙箱 → 清除授权）清理；启动自检会提示。
- **shell 分裂**：沙箱档不能用 Git Bash（§8.2 实测），命令语义在档位间不同。这是本方案最贵的产品代价，靠提示词与卡片如实显示兜住。
- **介质**：FAT/exFAT 卷作为写根直接失败（移动盘常见）；NULL-DACL 目录在 grant/revoke 往返后不等价；写根目录需 caller-owned 且有 `WRITE_OWNER`（仅 Modify 的目录会响亮失败）。
  > 实测补充（子代理 5 层嵌套测试）：失败场景是**工作区目录归另一个账户所有**——目录由本地 `admin` 账户创建、应用以 Microsoft 账户运行，继承来的 `Modify` 不含 `WRITE_DAC`，于是 `auto` 档每个子代理的 `run_command` 都报「沙箱不可用，命令未执行：… 授权写根 … Access is denied」。`t.TempDir()` 下的单测全过（该目录的所有者就是当前账户），说明这不是特权问题（写 SACL 无 `SeSecurityPrivilege` 也可行），而是该目录的 ACL 改不动。
  > 现状：`diagnoseGrantFailure`（`sandbox_windows.go`）把失败翻成三种可读结论，其中「目录属于另一个账户」会附补救命令 `icacls "<目录>" /grant "*<当前账户SID>:(OI)(CI)WD"`（需管理员）。**语义不变**——仍 fail-closed，不降级裸跑、也不静默降成 read-only。
- **工具链子集**：命名管道受限，libuv 的 piped stdio 孙进程可能 EPERM；`go build` / `npm` 的失败面要靠实测收敛并写进文档。
- **体积**：0 新依赖。

## 6. 未决问题

1. ~~full → danger-full-access 是否放行~~ → 原拍板「继承」（§3.1）；**2026-11-27 修订为缺省封顶 auto、显式 full 才继承 + 非阻塞警告**（§3.1 决策修订段）。
2. ~~沙箱不可用的兜底~~ → **已拍板：fail-closed 报错**（§3.3-7）。
3. **主会话命令是否同样接入沙箱**：阶段 D 单独评估（auto 档收益最大，代价是兼容性回归面）。
4. **命令族白名单是否还要**：v1 不加（效应兜底已够，分类器是启发式不是边界）。若 P2 要加，必须遵守 ZCode 那条约束（§1.2b）：**分类判定要带 shell 上下文**——沙箱档命令跑在 PowerShell 里，bash 的 AST 只读白名单在这里不成立。
5. ~~隔离 worktree 子代理的 cwd~~ → **已定（2026-11-17）**：worktree 本来就是「显式长路径、不做前缀注入」（`ai-worktree.js` 文件头），写根就是 `wt.path` 那一个目录，不需要两个根。**补充（同日复查后）**：`run_command` / `background_command` 在隔离会话里未显式传 cwd 时已默认落在 `.cadt/worktree/<slug>`（`commandCwdOf`），模型无需再手动传；主根命令显式 `cwd='.'`。

## 7. 原复核意见（2026-11-17，已被决策推翻，保留过程记录）

> 该节曾建议「降级为闭合命令集 `run_check`」。作者 2026-11-17 决定仍走 C，理由是需求（子代理要能真正跑命令、做错峰验证）比闭合集合更宽。以下三条批评**部分成立**，已写进 §5：
>
> 1. 写根是真实工作区 ⇒ `workspace-write` 允许的正是最可能出事的操作（无 git 的散落数据目录没有撤销手段）。缓解：写根取子代理 cwd，隔离 worktree 子代理天然被圈在自己的 slug 目录；普通子代理仍是会话工作区，风险如实记录。
> 2. 沙箱覆盖不到「读 + 外发」这条注入路径（`read-only` 下照样联网、照样读用户目录）。缓解：无——如实声明 `partial`，不宣传成隔离。
> 3. 成本/收益：1000–1500 行 + 数周。已接受。
>
> `docs/unfinished-plans/run-check.md` 保留为存档方案；若 C 在 P1 实测中因工具链失败面不可接受而回退，它是首选替代。

## 8. 实测记录（2026-11-17，Windows 11 + Wails GUI 宿主真机）

证据代码：`tools/sandbox-poc/`（GUI 子系统 exe，不参与产品构建）。

```sh
go build -ldflags "-H windowsgui" -o poc.exe ./tools/sandbox-poc
poc.exe C:\path\to\poc.log
```

### 8.1 控制台（决定性）

受限令牌（`WRITE_RESTRICTED|DISABLE_MAX_PRIVILEGE`，restricting=[logon, Everyone]，Low IL，已补默认 DACL 授权）下：

| 启动标志 | cmd.exe | Git Bash |
| --- | --- | --- |
| 无标志 | `0xC0000142` | `0xC0000142` |
| `HideWindow` | `0xC0000142` | — |
| `CREATE_NO_WINDOW` | `0xC0000142` | — |
| `CREATE_NO_WINDOW + HideWindow` | `0xC0000142` | — |
| `CREATE_NEW_CONSOLE` | `0xC0000142` | — |
| **`DETACHED_PROCESS`** | **✅ 正常，git 孙进程正常** | ❌ `NtCreateDirectoryObject(\BaseNamedObjects)` |
| 宿主 `AllocConsole` + 隐藏后继承 | ✅ 正常，git 孙进程正常 | ❌ 同上 |

结论：**只有「不建控制台」或「继承一个已存在的控制台」能活**；`executil.HideCommandWindow` 现有的 `0x08000000` 是必死组合。

### 8.1b PowerShell 必须有控制台（决定 v1 形态）

同一令牌下再测两种 shell：

| 启动形态 | cmd.exe | pwsh 7 | powershell.exe 5.1 |
| --- | --- | --- | --- |
| `DETACHED_PROCESS` | ✅ `CMD_OK` | ✅ 输出正常 | ❌ exit 0，**什么都不执行**（写文件也不落盘） |
| 继承隐藏控制台 | ✅ `CMD_OK` | ✅ 输出正常、写文件成功 | ✅ 输出正常、写文件成功 |

所以 v1 选「继承隐藏控制台」：沙箱档的 shell 是 PowerShell，只有这种形态能让它真正执行。
另有一条实测：商店版 `pwsh.exe` 已在别的 Job 里，`AssignProcessToJobObject` 会返回
`Access is denied`——Job 只是顺带杀树的增强、不是边界，故改为**尽力而为**，失败不阻断执行
（停止仍由 `procctl` 的 taskkill 树杀兜住）。

### 8.2 Git Bash（决定性）

- 受限 + Low IL：先死在 `cygheap_user::init: NtSetInformationToken(TokenDefaultDacl), 0xC0000022`；补上默认 DACL 授权后推进到 `NtCreateDirectoryObject(\BaseNamedObjects)` 致命错。
- 受限**去掉 Low IL**：推进到 `CreateFileMapping S-1-5-21-<用户SID>` 致命错。

结论：**restricting SID 是根因**——Cygwin 要在 `\BaseNamedObjects` 建目录对象、按用户 SID 建共享内存，而 restricting 列表里没有用户 SID，write 的二次检查必拒；补默认 DACL 只能修「新对象自身 DACL」，修不了父容器的创建权；把用户 SID 加进列表等于取消沙箱。⇒ 沙箱档 shell 固定 PowerShell/cmd。

### 8.3 写效应

未授予任何写根时，`echo probe > %TEMP%\...` 在受限子进程里返回「拒绝访问」——授权边界真实生效（与 dsh 的 `read-only` 语义一致）。
