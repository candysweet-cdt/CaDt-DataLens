# 工作区隔离机制全局评估

> 用途：`docs/finished-plans/agent-host-platform.md`（多工作区换手 + harness + Agent 平台化整合方案）开工前的
> 前置评估——**现有隔离到底靠什么成立、改动会碰到哪一层、哪些约束是硬的**。
> 只读盘点，未改任何源码。行号基于当前工作区状态（注意 `frontend/src/ai/*` 有未提交改动，
> 与 HEAD 存在位移；按符号名检索更可靠）。
> **v6 修订**：参考六个开源 harness（opencode / pi / ZCode / codex / cline / deepseek-harness）后，
> 本报告的 I5（工作区级写者占位）已被撤销——改为路径级写边界 + 越界升权审批。详见方案 §4.6 / §9。
> **v7 修订**：新增 §5.4 并发模型（三件套、三个漏洞、wipe-guard 六个失效模式）与不变量 I14–I16。

## 1. 核心结论

**当前架构里 `workspaceFolder` 一个变量同时承担了三种身份**，本次改造的本质不是「换一个根」，
而是**把三种身份拆开**，然后逐个调用点判断「它要的是哪个身份」。

| 身份 | 管什么 | 代表消费者 |
|---|---|---|
| **E 编辑根** | 人看什么、搜什么、改什么 | 资源管理器、全局搜索（`global-search.js:111`）、文件监听（`main.js:3652`）、Git 面板、终端 cwd、运行配置、Maven/DB 面板 |
| **S 作用域根** | AI 能碰什么、注入什么、往哪写状态 | 71 处 `getScopeRoot()`、`aiProjectRoot`、记忆 / 项目规则 / 认知索引 / 技能来源、沙箱、wipe-guard、worktree、计划与补丁落盘 |
| **W 窗口身份** | 别的窗口/进程怎么找到我 | `WindowRegister`（`window_host.go:104`）、`FindByWorkspace`（`windowreg.go:341`）、`WindowList`、CLI 与 `--ai-session` 转发、窗口标题与任务栏 |

- **需求 A（换手）** 是 E + S + W 三者一起换（换完仍是「一个有工作区的窗口」）。
- **需求 B（harness）** 只让 **S 跟会话走**；E 跟「当前会话」或用户选择；**W 退化为无**。

隔离的强度分布很不均：**磁盘与内核层已经足够强**（会话分桶、按 owner 的 watcher、租约与锁），
**弱的是内存共享状态**（多个单槽缓存）与**「写效应」的覆盖面**（见 §5.3）。这决定改动重心。

## 2. 隔离的四层模型

```
┌ 第 4 层 跨窗口协调 ── windowreg（写权/读权）、路由与投递、CLI 转发
├ 第 3 层 共享事实   ── ai-config.json（三方合并）、settings、最近打开、workspace-sessions
├ 第 2 层 内存状态   ── 每窗口 workspaceFolder 及 30+ 派生；每会话 session.workspace；若干单槽缓存
└ 第 1 层 磁盘与内核 ── .cadt/*（工作区级）、ai-sessions 分桶、租约/锁、watcher owner、wipe-guard 快照
```

**关键性质**：第 1、2 层是「按工作区/窗口天然分区」的；第 3 层是「刻意共享」的；第 4 层是
「按工作区匹配窗口」的。改动的风险几乎都来自**第 2 层的单槽缓存**与**第 3 层的共享文件**，
而不是路径解析本身。

## 3. 第 1 层：磁盘与内核（最强，基本不用动）

| 机制 | 现状 | 对改动的意义 |
|---|---|---|
| 会话磁盘分桶 | `<root>/<ws8>/<id>/`，桶归属以 `meta.workspace` 为真源（`sessionstore.go:272`），未绑定会话有 `_unbound` 桶（`:49`） | harness 不需要新存储模型，直接复用 |
| 会话回合租约 | 一次 Acquire = 「根门闩共享 + 会话独占」；进程内按**归属窗口名**分桶，跨窗口 Busy（`lease_service.go:60-120`） | 已经防住「同一会话两窗口双回合」；写者唯一只需补「同一工作区两会话」 |
| 工作区段缓存 | `.cadt/logs`（ws-worklog）、`.cadt/tmp`（ws-tmp）在崩溃自愈里按根清理（`specs.go:186,191`、`crashrecovery_app.go:111`） | 仅崩溃后首轮 + 按根去重；harness 不登记则不会触发，但别的窗口登记同一根时会清掉 harness 正在用的 tmp |
| 工作区级数据 | worktrees / gen / answers / scratch / memo / cognition / memory / plan / patches（`specs.go:203-256`） | 全部按工作区物理分离——**多仓库共存本来就成立**，harness 天然安全 |
| watcher 归属 | `WatchWorkspaceFor(owner, root)`，owner = 窗口名（`app_field_bindings.go:92-104`）；资源监听同构（`memo` / `ai-session` 按 key） | 一个窗口一个根是**结构性的**；换手 = 换 owner 的根；harness 若要监多个仓库需扩成多 owner/multi-root |
| 认知索引并发 | `resourcelease` + CAS + 只减不增基线（`cognition/service.go:366,715`） | 已有跨进程写保护，harness 下多个会话改同一卷是安全的 |
| 跨进程实例 | 单实例锁 + 第二实例转发（`secondinstance`） | 与工作区无关，不受影响 |

**结论**：第 1 层不需要为 harness 做任何结构性改造。唯一要处理的是「一个窗口只能监听一个根」。

## 4. 第 2 层：内存状态与单槽缓存（风险集中区）

### 4.1 每窗口状态

`workspaceFolder` 是窗口单值，派生出一大票状态：树根、面包屑、Git、Maven、DB、便签作用域、
终端 cwd、运行配置、scratch 目录、写作用域、AI 列表分组…（`main.js:3467` 的 `openFolderWorkspace`
就是这套派生的「全量刷新」函数）。

**这既是资产也是债**：资产是「换手只需调它一次，全部派生自动跟随」；债是**它默认 E/S/W 三者同源**。

### 4.2 单槽缓存（harness 的隐性雷区）

| 缓存 | 位置 | harness 下的后果 |
|---|---|---|
| 技能列表 `skillsCache` | `ai-panel.js` 的 `resolveSkillDirs` 之后 | A 仓库的 `.cadt/skills` / `.agents/skills` 喂给 B 仓库会话 |
| 认知 overview 预取 | `ai-cognition.js:192`（`{ws, snapshot}` 单槽） | 两个工作区会话交替起轮时索引块静默消失（`ws` 不等即返回空） |
| 项目权限规则 | `ai-permission-settings.js:695`（`{key, rules, at}` + 3s TTL） | 串规则 |
| wipe-guard | 单根状态机：`key !== wsKey` 即清 `watchWindow` 与 `lastFingerprint`（`ai-wipeguard.js:397`） | 交替会话时阈值永远攒不够；`preCommand` 与 `postCommand` 可能分属两个仓库 |
| 前端会话列表分组 | `workspaceGroupOverrides`（按 key 的 Map） | 已正确（Map 结构） |

**模式**：凡是「Map 按 `workspaceKey`」的都对；凡是「单槽 + 一个 ws 字段」的都要改成 Map。

### 4.3 共享事实层（第 3 层）

| 共享物 | 机制 | 对改动的意义 |
|---|---|---|
| `ai-config.json` | 多窗口共享单文件，已有**三方合并**（`ai-config-merge.js:1-10`） | 新增任何「全局配置 + 窗口局部」的字段都能沿用这个模式 |
| `activeSessionByWorkspace` | 按工作区 key 记录当前会话（`ai-session-scope.js:51`） | **已经是「多工作区共存」的正确形态**，harness 直接复用 |
| `cadt.workspace-sessions.v1` | **按工作区 key 的 Map**（`session-restore.js:44,75-91`），含 30 条上限与「只收该工作区文件」过滤 | 换手恢复快照的现成基础 |
| `cadt.session.v1` | **单槽，最后保存者赢**（`session-restore.js:13`） | harness 必须独立 key，否则会互相覆盖（§4.5 已写） |
| `rememberActiveSession` / 最近打开 | 共享，无按窗口分区 | 需确认换手/多窗口下的「最近」语义是否要按窗口 |

## 5. 工具相对路径解析（完整链路）

### 5.1 收口点

**`aiResolveScopePath(value, session)` 是唯一的相对路径解析入口**（`ai-panel.js:6974-6993`），
但函数体内 `const root = getScopeRoot()`（`:6975`）——**收了 `session` 却只用来判档位**。
调用点全部经它：

| 场景 | 调用链 |
|---|---|
| 读类（`read_file` / `read_image` / `read_video` / `list_dir` / `ocr` / `transcribe_audio` / 图片参考） | `resolveReadPathWithApproval`（`:7029`）→ `aiResolveScopePath` |
| 扫描类（`search_text` / `glob`） | `resolveScanRoot` → 同上（`{scanRoot:true}`，「记住」粒度是目录） |
| 写类（`write_file` / `edit_file`） | `aiResolveScopePath`（`:11698`、`:11749`）→ **越界直接抛错，无审批通道** |
| 命令 cwd（`run_command` / `background_command`） | `commandCwdOf`（`:6998`）→ `aiResolveScopePath`；持有隔离区时默认落在隔离区 |
| 前端引用芯片（回复里的裸文件名） | `pickOpenFileMatch(ref, openFiles)` → 回落 `aiResolveScopePath`（`:5202-5205`） |
| 补丁 | `propose_patch` 走 Go 侧根校验（`PATCH_PATH_DENIED`），前端只传根 |

**含义**：把 `aiResolveScopePath` 改成 `scopeRootOf(session)`，读写 / 扫描 / 命令 cwd 一次性解决——
这是整次改造里**性价比最高的一处**。写工具的 fail-closed 性质也保证「越界即拒」，不会因为换根而放宽。

### 5.2 第二个必须同批改的基准：`aiRelPath`

`write_file` / `edit_file` 在解析出绝对路径后，**又用 `aiRelPath(getScopeRoot(), path)` 现算相对路径**
（`:11699`、`:11750`），而这个 relPath 是四件事的输入：

1. `assertNotCognitionPath(relPath)`——防 AI 直写 `.cadt/cognition` 的安全闸（`:10186-10190`）；
2. `wipeguard.backupWrite({ws: getScopeRoot(), relPath, ...})`——写前快照的落盘位置（`:11722`）；
3. worktree 写闸（`mainRootWriteVerdict` 按相对根判定）；
4. 变更卡展示。

**若只改 `aiResolveScopePath` 而不改这两处 `aiRelPath`**：绝对路径落在会话根，相对路径却按窗口根算，
在 harness / 换手下会算出 `../../other-repo/x` 这类 relPath，导致：

- 变更卡展示错路径（用户看到不存在的相对位置）；
- `wipeguard.backupWrite` 的 `ws` 与 `rel` 错位——**已核实不会造成路径穿越写**：`internal/wipeguard/backup.go:85-124`
  里 blob 用内容哈希（CAS）、索引行追加到固定文件，`Rel` 只是元数据字段（`:95`）；真正的后果是
  `WS = WorkspaceKey(call.WS)`（`:92`）把备份归到**错误的**工作区，`WipeGuardList(ws)` 过滤后用户在
  会话根下找不到这条备份（功能性缺陷，非安全缺陷）；
- worktree 写闸（`mainRootWriteVerdict` 按相对根判定）判错，`assertNotCognitionPath` 虽然靠正则路径段
  仍能命中，但不应依赖这个巧合。

**这两处必须与 §5.1 同批改。**

### 5.3 授权语义（现状，改动不得放宽）

```
读类越界 → resolveReadPathWithApproval：
   ① 应用数据目录硬拒（sensitiveReadDenyReason / scanRootDenyReason，ai-read-roots.js:102-129）
   ② 用户点名 / 已批准读根 → 直读
   ③ auto 档 → 直读（!!）
   ④ read / edit 档 → 弹审批卡
写类越界 → 直接 throw（fail-closed），full 档除外
```

**③ 是这次讨论里最关键的一条**：auto 档对工作区外路径**直接放行**。所以「把别的工作区的可解析路径
注入上下文」在 auto 档等于**静默跨仓库读**。这也是 §4.3 采用「其它工作区只给无路径摘要」的根本原因——
不是为了省 token，而是为了不把 auto 档的静默读扩大成跨仓库。

## 5.4 并发模型（v7 新增）

### 5.4.1 三件套

| 机制 | 粒度 | 跨进程 | 进程内重入 | 防丢更新 |
|---|---|---|---|---|
| `sessionlock`（`sessionlock/lock.go`） | 文件 | ✅ LockFileEx / flock | ❌ 无 refcount | ✅ |
| `resourcelease` | 文件 | ✅（底层 sessionlock） | ✅ refcount + Shared/NoShare/Wait | ✅ |
| `atomfile` | 文件 | — | — | ❌ **只防半截** |

`atomfile.WriteFileAtomic` 的注释明确：「只保证目标要么是旧内容、要么是完整新内容」——
两个并发写谁最后 rename 谁赢，**不能替代锁**。

### 5.4.2 漏洞 A：`resourcelease` 的 refcount 在多窗口下失效

```go
// resourcelease.go（Acquire 内）
case st.exclusive > 0:
    st.exclusive++       // 不区分是谁，同进程直接放行
    return &Lease{...}, nil
```

`st` 是进程级全局状态。v2「一窗口一进程」没问题；**v3 一进程多窗口后，同进程两窗口
获取同一把独占锁会互相放行**。

已按窗口名分桶修补：
- `sessionLeases[id].holders[ownerKey]`（`lease_service.go:92-102`）
- `memoLeases[path].holders[ownerKey]`（`memo/memo.go:161-173`）

**未修补**：`cognition.Service.acquireLease`（`cognition/service.go:366-368`）直接
`resourcelease.Acquire`，无窗口分桶 → 同工作区两会话可同时写认知卷（CAS 只能挡住
「基于旧基线的写」，挡不住「各自读到最新后并发写」）。

### 5.4.3 漏洞 B：`SaveFile` 是裸 `os.WriteFile`

```go
// internal/fileio/fileio.go:365-374
return os.WriteFile(path, raw, 0644)   // 无锁、非原子
```

**机械判据**：搜 `backend.SaveFile(` 即全部无保护写点（24 处）。会丢用户内容的：
`MEMORY.md`（整份覆盖）、`permissions.json`（读改写）。其余是半截文件风险
（计划落盘、导出、群纪要、粘贴临时文件）。

### 5.4.4 漏洞 C：跨窗口共享的 localStorage 无锁

Wails 多窗口共享同一 WebView2 user data 目录 → localStorage 共享且无锁。
`cadt.session.v1` 是单槽（harness 会污染普通窗口）；settings 靠 `settings-changed` 广播 +
`applyRemoteSettings` 合并缓解；`cadt.workspace-sessions.v1` 是按工作区 key 的 Map，同键并发丢一个。

### 5.4.5 wipe-guard 专项（最不能失效的一处）

现状是**单实例单根状态机**（`ai-wipeguard.js:276-284`）：`watchWindow` / `wsKey` /
`lastFingerprint` / `fingerprintTimer` / `settleTimer` / `lastAlarmAt` 全是单值，且
`handleWorkspaceEvent` 在 `key !== wsKey` 时**清零**（`:401-407`）。

| 失效 | 触发 | 后果 |
|---|---|---|
| F1 换根清零基线 | A→B→A 频繁切换 | 阈值攒不够 → **漏报** |
| F2 监听根不跟会话（`main.js:3652` 用 explorer 根） | harness 下树根与登记根脱钩 | 主信号收不到 |
| F3 pre/post 跨根比较（签名带 root 但调用点传现取窗口根） | 换手瞬间 | **误报「整仓清空」** |
| F4 `snapshotTick` / 周期校准取空根直接 return（`:451`、`:365`） | harness 无窗口根 | 防护静默失效、无日志 |
| F5 `lastAlarmAt` 全局 | A 刚报警 | B 的真破坏被抑制 2 分钟 |
| F6 watcher 单根 | 切到 B 后 A 无监听 | A 完全失明 |

修法见方案 §4.9.7：pre/post 同根 + watcher 跟会话根（S1）；per-root 状态表 + 多根 watcher
（用 `ResourceWatcher.Watch(owner, kind, key, dir)`，`resource.go:53`）+ 冷却按根 + 快照按根轮转（S3）。

## 6. 隔离不变量清单

| # | 不变量 | 强度 | 依据 | 换手 | harness |
|---|---|---|---|---|---|
| I1 | 同一会话同时只有一个回合 | **硬**（安全） | 租约 `lease_service.go:60-120` | 保持 | 保持 |
| I2 | 应用数据目录不可被 AI 读/扫 | **硬**（安全） | `ai-read-roots.js:102-129` | 保持 | 保持 |
| I3 | 写工具越界即拒（无审批兜底） | **硬**（安全） | `aiResolveScopePath` 不捕获 | 保持（根换会话） | 保持 |
| I4 | `.cadt/cognition` 不可直写 | **硬** | `assertNotCognitionPath` | **依赖 §5.2 同批改** | 同左 |
| I5 | 同一工作区只有一个写者 | ~~软（策略）~~ **v6 撤销** | `FindByWorkspace` / `IsWorkspaceOpen` | ~~改为原子换主~~ 退回纯体验守卫 | ~~放宽为写者唯一~~ 改路径级写边界（codex Read/Write/Deny + 升权审批） |
| I6 | 一个窗口只监听一个根 | 软（结构） | `WatchWorkspaceFor(owner, root)` | 换手即换根 | 需扩多根或按会话根 |
| I7 | 项目状态（记忆/规则/认知/计划/补丁）跟随工作区 | 软 | `.cadt/*` 物理布局 | 换手即换 | 跟会话根 |
| I8 | 跨窗口配置一致 | 软 | `ai-config.json` 三方合并 | 保持 | 保持 |
| I9 | 窗口布局不互相污染 | 软 | `PER_WINDOW_LAYOUT_KEYS` + `cadt.session.v1` 归属校验 | 保持 | **需独立快照槽** |
| I10 | 缓存按工作区分区 | 软（易漏） | 各域自管 | 需改 Map | 需改 Map |
| I11 | 崩溃自愈不误删他人在用的临时文件 | 软 | 按根去重 + 仅崩溃后首轮 | 保持 | 需确认 harness 不登记导致的反向暴露 |
| I12 | CLI / 文件投递按工作区路由到正确窗口 | 软 | `window_route.go` 最深命中 + 复用投递 | 换手瞬间有短窗口期 | harness 需补「会话→工作区」弱映射 |
| I13 | 切根的开销只随「进入新工作区」增长，不随「切会话次数」增长 | 软（体验） | 见 §7.1 | 换手需轻量路径 | **harness 必须做轻量换根 + 重活去重** |
| I14 | 破坏防护的基线不因切换会话而清零 | **硬**（安全） | 现状会清零（`ai-wipeguard.js:401-407`） | **必须修**（§5.4.5 F1） | 同左 |
| I15 | 命令前后指纹必须同一根比较 | **硬**（安全） | 签名带 root 但调用点现取窗口根（F3） | **必须修** | 同左 |
| I16 | 并发写同一文件不丢更新 | 软→硬（视文件） | 走专用服务的有锁；走 `SaveFile` 的没有（§5.4.3） | 保持现状 | `MEMORY.md` / `permissions.json` 必须补锁 |

## 7. 改动影响的整体判断

| 层 | 换手（A）影响 | harness（B）影响 | 判断 |
|---|---|---|---|
| 磁盘/内核 | 无（换根即可） | **几乎无**（分桶 / 租约 / .cadt 天然支持） | 不需要重构 |
| 内存窗口状态 | 调一次 `openFolderWorkspace` | 需把 E 与 S 分开 | 中等 |
| 单槽缓存 | 无（单工作区不变） | **全部要 Map 化** | 机械但易漏 |
| 共享事实 | 无 | 新增 harness 槽 + 会话→工作区弱映射 | 小，但必须做 |
| 工具路径 | **必须与根改会话同批** | 同左 + `aiRelPath` 同批 | **最关键** |
| 写效应覆盖 | 换手要挡住进行中回合 | **路径级写边界必须覆盖所有写工具**（不再有窗口级占位） | 见 §8 |
| **性能（切根开销）** | 单次换手可接受，但钩子会重复跑 | **「切会话 = 重开工作区」会线性叠加** | 见 §7.1 |
| **根归属（v6）** | 窗口根降级为会话根的投影 | 同一套模型，只是不强求窗口根唯一 | 见方案 §2 |

### 7.1 性能：切根开销会不会随会话切换次数叠加

**会，除非显式设计。** 成本三档（代码依据）：

- **轻**（毫秒级）：`explorer.setRoot` 只 `tree=null` + 读一层（`explorer.js:891`）；认知卷 / 技能目录 /
  AGENTS.md / 记忆 / 项目规则（几个小文件）。
- **中**（数十 ms ~ 数秒，视仓库）：`git status`（**无内建上限**）；wipe-guard 指纹
  （有硬预算 200ms 墙钟 + 5 万条目，`fingerprint.go:31-37`，超限降级 `Sampled`）；
  监听注册（`ReadDirectoryChangesW` 一次调用，`watch.go:75`）；大会话正文首读。
- **重**（无上限）：工作区 open 钩子（`main.js:3504` → `runForWorkspace` 真跑用户命令）；
  Maven 扫描 + 全量 `applySettings` 重绘。

**默认实现会重复**：每次换根都重跑中/重档；`lifecycle-hooks.js` 的 `runningByWs` 只防并发、不防先后重复，
所以切来切去会反复执行同一工作区的 open 钩子。落地方案见
`docs/finished-plans/agent-host-platform.md` §4.6（轻量换根 `switchRootLight` + 重活按工作区去重 +
换手序列化）。对应不变量 I13。

## 8. 两条最容易被低估的结论

**8.1 「写效应清单」比「路径类工具」大得多（v6 措辞调整）。** 写效应不只有
`write_file` / `edit_file` / `run_command`：
`memory_write`（**无锁整份覆盖** `MEMORY.md`，`ai-panel.js:10681-10692`）、
`write_worklog`（**有跨进程锁**：`sessionlock.LockFile` + 进程内 `worklogMu`，连根 INDEX 的读改写也在锁内，
`aiworklog.go:104-148`）、`cognition_edit`（resourcelease + CAS，安全）、`propose_patch` /
补丁应用（库存 root）、`worktree_manage`、计划落盘、便签写入（resourcelease）、
`generate_image/video` 产物、`text_to_speech`。

**并发安全性逐个不同，不能一概而论**：

| 写点 | 并发保护 | 同工作区两会话并发写会怎样 |
|---|---|---|
| `.cadt/logs/*`（worklog） | `sessionlock` 文件锁 + 进程内 mutex | **安全**（后写等待，不丢条目） |
| `.cadt/cognition/*` | resourcelease + CAS + 单写者 | 安全（CAS 冲突会拒绝） |
| `.cadt/memo` | resourcelease | 安全 |
| `.cadt/patches/*` | 补丁记录自带 root | 安全（互不干扰） |
| `.cadt/memory/MEMORY.md` | **无** | **丢更新**（整份覆盖，最后写者赢）→ S2 必须加锁 |
| `.cadt/permissions.json` | 仅窗口内串行（`enqueueProjectRulesMutation`） | **丢更新**（跨窗口/跨会话读改写）→ S2 提升为文件锁 |
| `.cadt/worktree` 孤儿清理 | 按**会话 meta 的 `worktree.path`** 判定 + fail-safe（`storage_app.go:56`、`storage.go:156`） | **安全**（多会话各持 worktree 都算登记，不会被当孤儿删） |

v6 不再用「窗口级写权」挡这个（六家参考实现无一先例），改为**路径级写边界 + 越界升权审批**：
写根 = 会话根 + 显式附加可写根。因此这批工具的路径**都必须按会话根解析并落在写边界内**，
否则会出现「write_file 受边界约束、memory_write 不受」的不一致。
**真正的数据丢失风险仍由会话租约挡住**（I1，2026-11-21 事故），不是靠窗口占位。

**8.2 「一个窗口一个监听根」是结构性约束，不是 bug。** E 身份天生单根。换手是换根（自然成立），
但 harness 想让 E 也跟会话走的话，就会出现「一个窗口要看多个仓库的树」——这需要
`ResourceWatcher` 那套多 key 机制上移到工作区监听层，或明确「harness 的树只显示当前会话根」。
**建议选后者**：harness 的文件树跟随当前会话，切会话即换根，避免多根监听的复杂度。

## 9. 建议

1. **顺序不变**：P0（纯函数）→ P1（换手骨架）→ **P2a（`aiResolveScopePath` + `aiRelPath` +
   读写/命令/扫描同批）** → P2b（单槽缓存 Map 化 + 上下文分层）→ P3（harness 窗口形态）。
2. **`aiResolveScopePath` 与两处 `aiRelPath` 是同一个原子改动**，不要拆 commit——拆开就是「路径与相对路径
   不同源」的窗口期。
3. **单槽缓存一次性清完**：技能 / 认知 overview / 项目规则 / wipe-guard 四个，统一改成按 `workspaceKey`
   的 Map，并用同一份测试模式覆盖。
4. **路径级写边界要按「写效应清单」覆盖**，不是只覆盖「路径类工具」（§8.1）——记忆与工作日志也是写点。
5. **harness 的 E 身份跟随当前会话**，不做多根监听（§8.2）。
6. **切根要走两条路径**：真正打开工作区（对话框 / 最近打开 / 启动恢复）走完整流程；会话切换引起的
   根变更走「轻量换根」——重活（open 钩子 / git status / 指纹基线）按工作区在一次运行内只做一次（§7.1）。
7. **不要碰**：会话分桶、租约、`.cadt/*` 物理布局、`ai-config.json` 三方合并、应用数据目录硬拒。
8. **（v6）不要引入窗口级写权占位**：六个参考 harness 无一先例；靠「会话租约 + 路径级边界 + 升权审批」，
   并让 `IsWorkspaceOpen` 退回纯体验守卫。

## 10. 已核实与仍需实测

**已核实（本轮排除的疑虑）**：
- `wipeguard.backupWrite` 的 `relPath` 不参与落盘路径构造（`internal/wipeguard/backup.go:85-124`：
  blob 走内容哈希 CAS、索引追加到固定文件，`Rel` 仅元数据）→ **不存在路径穿越写**；
  真实后果是备份被归到错误工作区、`WipeGuardList(ws)` 过滤后找不到。
- `assertNotCognitionPath` 的正则按路径段匹配，`../` 前缀仍能命中——但不应依赖，见 §5.2。

**仍需实测**：
- `WindowList` / 窗口切换器在 harness 下的表达（目前只下发 `workspace` 字段）。
- 两窗口同时改 `.cadt/permissions.json`（前端只有窗口内串行，`enqueueProjectRulesMutation`）的丢更新概率。
- `.cadt/tmp` 被别的窗口崩溃自愈清掉时，harness 会话的粘贴/中间产物损失面。
- 记忆与工作日志是「最后写者赢」（无锁，`ai-panel.js:10681-10692`）——写者唯一覆盖到它们之后是否还有遗漏写点。
