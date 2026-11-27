# 事故报告：2026-11-27 沙箱 standing Low 标签导致工作区构建工具失效

- 上报时间：2026-11-27 17:11（用户运行 `tools\rebuild-exe.cmd`，测试门通过后前端构建失败）
- 调查时间：2026-11-27 17:13 – 17:45
- 调查方式：ACL / 进程令牌取证、路径对照实验、进程对照实验、源码逐行对齐、`.cadt` 操作日志交叉验证
- 结论：**16:35 的提权沙箱联调（workspace-write）调用了 `grantWrite`，把 Low no-write-up 完整性标签永久写到仓库根目录（standing 设计）。仓库内所有 exe（含 `node_modules` 里的 esbuild.exe）启动即 Low 完整性，无法删除 node（Medium）在 `%TEMP%` 创建的临时文件，vite 构建报 `Access is denied`。与杀毒软件、Node/依赖版本无关。**

---

## 一、结论

| 项 | 值 |
|---|---|
| 症状 | `rebuild-exe.cmd` 测试门通过后，`vite build` 在 `vite:esbuild-transpile` 阶段失败：`remove C:\Users\admin\AppData\Local\Temp\esbuild-<hex>: Access is denied.`；可稳定复现（2/2） |
| 首次失败 | 2026-11-27 17:11；**16:22 同环境、同依赖构建成功** |
| 触发原因 | 工作区根目录 `D:\OraSkyC\Project\CandySweet\CaDt-DataLens` 被写入 Low 完整性标签（同时残留能力 SID allow ACE 与 Everyone `FILE_DELETE_CHILD` deny） |
| 为什么是现在 | 16:35 的提权联调首次对**真实工作区**执行 workspace-write 沙箱：`grantWrite` 落标签；`revokeWrite` 按设计**保留**标签；`Revoke()` 全仓**无调用点** |
| 为什么报 Access denied | Low 进程删除 Medium（未标注对象默认按 Medium 判定）文件属完整性 write-up 拒绝 → `ERROR_ACCESS_DENIED(5)`；不是句柄共享冲突（`0x80070020`） |
| 影响 | 仓库内任意 exe 以 Low 启动：构建工具（esbuild 这类"先写临时文件、再删除"）必失败；从仓库运行的 `datalens.exe` 同样会失去对 `%APPDATA%` 等 Medium 位置的写权限（潜在，未实际触发） |
| 修复 | 用包内 `sandbox.Revoke()` 提权清理三样痕迹；`npm run build` 7.40s 通过；`rebuild-exe.ps1` 端到端成功（17:44:48 产出新 exe） |
| 状态 | 工作区已恢复；**代码未修，复发条件仍在**（再次对真实工作区跑 workspace-write 沙箱即复发） |

---

## 二、事故链

```text
16:22:47  用户 rebuild-exe.cmd 构建成功（39 分钟内同依赖、同 Node 版本）
16:35:52  子代理沙箱权限联调（提权）：workspace-write 首次对真实工作区生效
          ├─ grantWrite(工作区根) 一次 SetNamedSecurityInfo 写入三样东西：
          │    ① 能力 SID 的 allow ACE（S-1-4-…）
          │    ② Everyone 的 FILE_DELETE_CHILD deny（容器继承）
          │    ③ Low no-write-up 完整性标签（容器+对象继承）
          └─ sandbox 关闭时 revokeWrite 只撤 ①②，Low 标签按设计保留（standing）
17:06–17:08  同会话继续改 sandbox_windows.go / 测试（只是巧合，不是触发点）
17:11:22  用户再次 rebuild-exe.cmd → vite 转译大 chunk 时，esbuild 写 %TEMP%\esbuild-<hex>
          （输入 >1MiB 走临时文件，node 写入）→ Go 服务读取后 os.Remove
          → Low 进程删 Medium 文件 → Access is denied → 构建失败
17:13 起  排查：ACL / 令牌 / 路径对照实验 → 锁定工作区 Low 标签
17:43     提权执行 sandbox.Revoke(工作区根) → 三样痕迹清除
17:44:48  rebuild-exe.ps1 重新构建成功（新 datalens.exe 37,509,632 字节）
```

---

## 三、证据链

### 3.1 工作区根目录 ACL（决定性命中）

清理前 `icacls` 输出（节选）：

```text
D:\OraSkyC\Project\CandySweet\CaDt-DataLens
    Everyone:(CI)(DENY)(DC)
    S-1-4-1018292873-730639092:(OI)(CI)(W,D,DC)
    MicrosoftAccount\1213hzc@gmail.com:(OI)(CI)(W,D)      ← 非沙箱写入，未动
    ...
    Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)      ← 罪魁祸首
```

- `S-1-4-…` 是 `workspaceWriteSIDString` 派生的能力 SID（`internal/sandbox` 独有形态）；
- `Everyone:(CI)(DENY)(DC)` = `grantWrite` 落下的 ambient-delete deny；
- `Mandatory Label\Low … (NW)` = `buildLowLabelACL` 落的 Low no-write-up 标签。

三样与 `grantWrite`（`internal/sandbox/sandbox_windows.go:562`）的写入内容逐项一致。

### 3.2 进程令牌（Low vs Medium）

| 进程 | 父进程 | 完整性 SID | 结论 |
|---|---|---|---|
| `esbuild.exe`（仓库内原路径） | node / PowerShell（均 Medium） | `S-1-16-4096`（Low） | 被工作区标签带低 |
| node（同上） | — | `S-1-16-8192`（Medium） | 正常 |
| PowerShell（同上） | — | `S-1-16-8192`（Medium） | 正常 |
| `sleepy.exe`（自编译 Go，**由同一个 node spawn**） | node | `S-1-16-8192`（Medium） | 说明不是「node 子进程被批量降权」 |

结论：**进程完整性跟随可执行文件所在位置的标签**（本机 build 26300 实测），与启动者是谁无关。

### 3.3 路径对照实验（规则范围）

同一个 esbuild.exe（原哈希）复制到不同位置后启动：

| 位置 | 进程完整性 |
|---|---|
| 仓库内 `frontend\node_modules\@esbuild\win32-x64`（原目录） | **Low** |
| 仓库内 `frontend\node_modules`（根） | **Low** |
| 仓库内 `.cadt\tmp\probe`（任意子目录） | **Low** |
| `D:\OraSkyC\Project\CandySweet`（仓库外父目录） | Medium |
| `C:\Users\admin\AppData\Local\cadt-probe` | Medium |
| `%TEMP%`（同哈希 / 追加 1 字节改哈希） | 均 Medium |

规则范围 = **本仓库根目录整棵树**；与哈希无关，与父进程无关。

### 3.4 对照实验与排除项

| 假设 | 证据 | 结论 |
|---|---|---|
| 杀软 / 360 锁文件 | ①「被别的进程打开且未共享删除」实测返回**共享冲突** `0x80070020`，与 esbuild 的 `Access is denied`(5) 不符；② 普通 Node 在 `%TEMP%` 写/读/删 9MB（同 `esbuild-` 前缀）20/20 成功；③ 纯 Go 程序写/读/删 12MB 成功；④ Go 进程 A 建文件、进程 B 删除成功；⑤ 同 node 启动的 `sleepy.exe` 为 Medium；⑥ Defender 实时防护关闭，360 托盘未运行（驱动常驻但无行为证据） | 排除 |
| Node / 依赖升级 | Node 24.22.1 自 11/5 安装；esbuild 0.28.2 文件时间 11/18；16:22 同环境构建成功 | 排除 |
| 路径/哈希信誉规则 | 同哈希换路径即 Medium；改哈希不解决；仓库内任意子目录都 Low | 排除"仅那一个文件" |
| Codex 沙箱账户 | esbuild 令牌 UserSid 仍是 `admin`、非 AppContainer；`CodexSandboxOffline/Online` 是独立本地账户，形态不符 | 排除（`%TEMP%` 里 `CodexSandboxUsers` ACE 为 Codex 安装遗留，与本事故无关，观察项） |

### 3.5 esbuild 为什么命中

- esbuild JS 层对 **>1 MiB 的 transform 输入**先写临时文件再让 Go 服务读：`node_modules/esbuild/lib/main.js:1057` 的 `input.length > 1024 * 1024` 分支 → `fsAsync.writeFile`（由 node/Medium 写入 `%TEMP%\esbuild-<hex>`）→ Go 服务 `inputFS` 读取后 `os.Remove`。
- 失败时残留文件尺寸 = 输入尺寸（实测 12,000,000 字节；vite chunk 9,205,322 字节），确认是**输入临时文件**的删除被拒。
- 因此：Low 的 esbuild 服务删除 Medium 的临时文件 → 失败；小输入（<1MiB 走管道）不受影响，与"测试门/小模块转换正常、只有大 chunk 转译失败"的现象一致。

### 3.6 错误码辨识（Access denied ≠ 共享冲突）

| 场景（实测） | 返回 |
|---|---|
| 文件被另一句柄打开且未共享删除，`DeleteFile` | `ERROR_SHARING_VIOLATION`（`0x80070020`，"正由另一进程使用"） |
| Low 进程删除 Medium 文件（完整性 write-up） | `ERROR_ACCESS_DENIED`（5，"拒绝访问"） |
| 本事故 esbuild 报错 | `remove …: Access is denied.` → 指向权限/完整性，而非句柄 |

---

## 四、根因

**直接原因**：`internal/sandbox` 的 workspace-write 模式需要让 Low 受限子进程能写工作区，因此 `grantWrite` 把工作区根的完整性标签降为 Low/NW。标签一旦落下就随继承作用于整棵树，**standing 保留**（`revokeWrite` 注释：「写根的标签本就是 standing」），只有 `Revoke()` 会连标签一起清——而全仓 `rg` 确认 **`sandbox.Revoke` 没有任何调用点**（`sandbox.New` 仅出现在 `internal/cmdbridge/ai_command_windows.go:260,396`）。

**触发路径**：16:35 的提权联调对真实工作区执行了 workspace-write（日志原文：「提权后复测：auto 档命令通道可用，写根内成功、写根外被拒」）。联调只验证了「写效应圈在工作区内」，未评估「工作区里的可执行文件从此以 Low 启动」的副作用。

**为什么以前没暴露**：`grantWrite` 只在沙箱实际执行时写入；16:35 之前从未对真实工作区成功执行过（非提权那次因写 SACL 缺 `SeSecurityPrivilege` 直接失败，标签没落下）。所以 11-18 至 11-27 的历次构建都正常。

**机理补充**：Low 进程对 Medium 对象只能读、不能写/删（write-up 默认拒绝）；未带标签的对象在访问检查中按 Medium 处理。因此 Low 的 esbuild 能读取 node 写的临时文件，却在 `os.Remove` 一步被拒。

---

## 五、处置与验证

1. **清理**：临时工具 `.cadt/tmp/revoke/main.go`（`git check-ignore` 确认 `.cadt/` 被忽略，不进仓库）：
   - 自行 `AdjustTokenPrivileges` 启用 `SeSecurityPrivilege`（仓库代码里没有这一步，是 16:35 日志提过的"可选优化"）；
   - 调用 `sandbox.Scan` / `sandbox.Revoke`，按包签名精确删除三样痕迹，其余 ACE 不动；
   - 提权运行（UAC）结果：`granted=true deny=true labeled=true` → **`granted=false deny=false labeled=false`**。
2. **ACL 复核**：`icacls` 已无 `S-1-4-*`、无 `Everyone … DENY(DC)`、无 `Mandatory Label\Low`；`MicrosoftAccount\1213hzc@gmail.com:(OI)(CI)(W,D)` 原样保留（非沙箱写入，建议另查）。
3. **行为复核**：原路径 `esbuild.exe` 启动令牌恢复为 `S-1-16-8192`（Medium）。
4. **构建复核**：`npm run build` → `✓ built in 7.40s`，退出码 0。
5. **端到端复核**：`powershell -File tools/rebuild-exe.ps1 -SkipTest` 成功，17:44:48 产出新 `datalens.exe`（37,509,632 字节），旧版按脚本惯例改名为 `datalens.running-old-20261127-174448.exe`（下次运行自动清理）。

---

## 六、修复闭环（原遗留风险与必须修复项）

> **闭环状态（2026-11-27 当日修复）**：方向④已落地——workspace-write 的唯一写根改为每次调用新建的私有临时目录，Low 标签不再落真实工作区；启动残留自检、特权启用与联调纪律均已补齐。真实工作区 ACL 复核无沙箱残留，`npm test` / `npm run build` / `go test ./...` 通过。

- **P0 · `Revoke` 入口（已存在，报告原判断已过时）**：`internal/sandbox/service.go` 的 `SandboxScan`/`SandboxRevoke` 绑定、根 App 嵌入、设置页 AI→权限的「检查/清除授权」按钮、mock 与 d.ts 均已存在。本次未新增绑定，补的是**启动自检**（见 P2）。
- **P0 · standing 标签设计冲突（已修复：方向④）**：`internal/cmdbridge/ai_command_windows.go` 两处调用点不再把真实工作区/worktree 作为 `WorkspaceRoot`，而是传本次调用新建的私有临时目录；`Sandbox.Env`/`Configure`/`TempDir` 同步把 `TMP/TEMP` 和回显指向该目录。Low 标签只落私有目录，`Close` 清 temp 授权后 `RemoveAll` 删除目录 → 零残留。代价：auto 档子代理只能写私有临时目录，不能直接写工作区/worktree（用户已拍板接受）。
- **P1 · 联调纪律（已修复）**：AGENTS.md 新增硬规则——测试一律 `t.TempDir()`、人工联调用 `.cadt/tmp/sandbox-*` 并断言 `pwd`，确需真实工作区须先 `Scan`、事后 `Revoke` 且限维护者明确授权；新增 `sandbox_workspace_guard_test.go` 机械拦截 `WorkspaceRoot: os.Getwd()` 等写法。
- **P1 · 特权启用（已修复）**：`internal/sandbox/sandbox_windows.go` 新增 `enableSecurityPrivilege()`，在 `grantWrite`/`Revoke` 写 SACL 前统一 `AdjustTokenPrivileges` 启用 `SeSecurityPrivilege`（`sync.Once` 缓存）；无法启用时 fail-closed 并明确提示以管理员身份运行。`Scan` 是只读操作，不需要该特权。
- **P2 · 启动自检（已修复）**：`frontend/src/ai/security/ai-sandbox-startup-check.js` 在首屏完成后延迟 2 秒异步 `SandboxScan`，不参与启动 await 链、不影响启动性能；发现残留只弹确认框，用户确认后才 `SandboxRevoke`，失败静默记日志。
- **观察项（未闭环，与本事故无关）**：仓库根上的 `MicrosoftAccount\1213hzc@gmail.com:(OI)(CI)(W,D)` 显式 ACE 来源不明（非沙箱），建议维护者确认是否保留；`.cadt/tmp` 下另有历史联调残留（`datalens-db-fix.exe` 等），与本事故无关。

---

## 七、教训

1. **"给目录改安全属性"的功能，必须评估可执行文件的连带效应**：完整性标签会随继承作用到整棵树上的所有 exe，改变它们的运行令牌——这不是"只影响写入范围"的局部改动。
2. **standing 状态要有生命周期**：凡是"设一次、长期保留"的全局副作用，就必须有成对的清理入口与可见状态（Scan），否则一次联调就能把开发环境弄坏。
3. **错误码是第一手证据**：`Access denied(5)` 与共享冲突(`0x80070020`)、`ERROR_USER_MAPPED_FILE` 指向完全不同的机理；排查时先用最小实验把错误码语义钉死，再选嫌疑人。
4. **"路径对照实验"能快速定性**：同一文件换位置/换哈希/换父进程启动，三步即可区分"文件信誉规则"与"目录级策略"。
5. **先查自己的日志与代码**：`.cadt/logs` 16:35 的条目已把 `grantWrite`/Low 标签/`standing` 写清楚；本次排查绕了杀软与依赖两圈才回到自家实现。
6. **未提交改动不是可丢的东西，环境状态也不是**：本次修复只动 ACL，不碰任何源码与未提交改动；清理工具放 `.cadt/tmp`（gitignored），不影响并行会话。

---

## 附录 A：关键命令

```powershell
# 1) 看工作区是否带沙箱痕迹（Low 标签 / 能力 SID / Everyone deny）
icacls "D:\OraSkyC\Project\CandySweet\CaDt-DataLens"
#    关注：Mandatory Label\Low …、S-1-4-…、Everyone … (DENY)(DC)

# 2) 看某个 exe 启动后的完整性级别（OpenProcessToken + GetTokenInformation(TokenIntegrityLevel)）
#    S-1-16-4096=Low，S-1-16-8192=Medium

# 3) 清理（需管理员；.cadt/tmp/revoke 为一次性工具，可用 go build 重建）
C:\Users\admin\AppData\Local\Temp\cadt-sandbox-revoke.exe "D:\OraSkyC\Project\CandySweet\CaDt-DataLens" --revoke
#    before: granted=true deny=true labeled=true
#    after:  granted=false deny=false labeled=false

# 4) 验证
icacls "D:\OraSkyC\Project\CandySweet\CaDt-DataLens" | Select-String "Mandatory Label"
cd frontend; npm run build
```

## 附录 B：相关代码位置

| 位置 | 作用 |
|---|---|
| `internal/sandbox/sandbox_windows.go:537` `buildLowLabelACL` | 造 Low no-write-up 标签 ACL（继承到容器与对象） |
| `internal/sandbox/sandbox_windows.go:562` `grantWrite` | 一次 `SetNamedSecurityInfo` 落能力 SID allow + Everyone deny + Low 标签 |
| `internal/sandbox/sandbox_windows.go:608`–`610` | `SECURITY_INFORMATION(daclSecurityInformation\|labelSecurityInformation)` 写入点 |
| `internal/sandbox/sandbox_windows.go:615` `revokeWrite` | 只撤能力 ACE，**保留** Low 标签（standing 设计） |
| `internal/sandbox/sandbox_windows.go:679` `Scan` / `:719` `Revoke` | 只读诊断 / 完整清理（含标签）；**当前无调用方** |
| `internal/cmdbridge/ai_command_windows.go:260`、`:396` | `sandbox.New` 仅有的调用点（AI 命令执行链） |
| `frontend/node_modules/esbuild/lib/main.js:1057` | >1MiB 输入走临时文件（本事故的命中点） |
| `.cadt/logs/2026/11/2026-11-27.md` 16:35:52 条 | 事故直接诱因（提权联调）的操作记录 |

## 附录 C：未闭环项

- 把 esbuild 的 `>1MiB` 临时文件阈值临时调大后，2–12MB 输入走管道在本事故期间**挂死**（0.27.7 同样挂死）；标签移除后未复测，机理未定位。与本次构建失败不是同一问题，但建议在沙箱修复后回归确认大输入路径的可用性。