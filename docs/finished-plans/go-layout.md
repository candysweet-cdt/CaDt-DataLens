# Go 侧目录与拆包评估

> 状态：**已实施完毕**（2026-11-16）。B1–B4 四批（`998915c` / `79c4706` / `eb2c5df` / `b09fc32`）+ B5 零耦合收尾（`1692006`）+ B6 三域下沉（`2ec9ca1` / `e7a45c8` / `e088f3b` / `4d48808`）+ B7–B12（`ed790d2` / `52580bb` / `86e5af0` / `28f54e1` / `9b624b5`）、C0–C3（`051c418` / `178079a` / `355434e` / `96aa4f7` / `5cad98b` / `971c264` / `5e95a14` / `ffaaa34` / `0a525b6` / `d7c22a5` / `843c133`）与 D 系列（`b3efb83` / `219d394` / `33eff0b` / `b10c2df` / `06d4d0c` / `ad17119`）全部落地，每批 `go test ./...` 与 `wails build -devtools` 全绿。B11 已并入 C1 完成。根目录 180 → **73 个 .go**（56 非测试 + 17 测试）、main 包 40,712 → **5,727 行**，`internal/` 51 个包（39 域 + 12 叶子）。2026-11-14 首轮评估的「暂不抽包」基于当时的高耦合形态，已被实测取代；首轮已落地的部分与判定存档见 §7
> 问题：Go 后端 180 个 `.go`（112 非测试 + 68 测试，40,712 行，module `datalens`）平铺在仓库根、单一 `package main`——能不能像前端那样按域分目录、该拆什么、不该拆什么

## 0. 结论先行（2026-11-16 复测）

1. **硬约束没变，但它只钉住 App，不钉住引擎**：`package main` 与 `type App` 必须留仓库根——`main.go:14` 的 `//go:embed all:frontend/dist` 以包目录为基准；Wails 绑定固定挂 `window.go.main.App`，全部 268 个导出方法必须留在 App 上。所以方向只有一个：**App 留根当壳，引擎下沉 `internal/<域>`**，壳方法委托给包。
2. **首轮「26k 行与 App 交织、抽包先立接口层」的依据已失效**：如今 52/112 非测试文件零 App 引用，`logf`/`appDataDir` 等共享助手已消失，App 结构缩到 16 个字段，候选域的 App 引用几乎全是「挂名绑定方法」（接收者根本不用 `a.`——`mcp_manager.go`、`sqlview.go`、`gitinfo.go`、`ai_gen.go`、`ai_catalog.go` 的 `a.` 引用数全部为 0）。抽包从「设计能力接口层 + 全域改写」降级为「搬文件 + 导出符号 + 壳改调用前缀」的机械活，编译器兜底。
3. **前端零影响**：`frontend/src` 没有任何文件 import `wailsjs/go`（全部直接走 `window.go.main.App` 调用），也没有 models 引用——引擎类型挪包对 JS 不可见，`wailsjs/` 产物由 `wails build` 重生成即可。
4. **分四批抽包已实施完毕**（§3）：`internal/patch` → `internal/mcp` + `internal/sqlview` + `internal/atomfile` → 会话存储族（sessionstore / sessionindex / activity）→ AI 传输层 + timer + gen/catalog。实测根目录 180 → **135 个文件**、main 包 40.7k → **26,861 行**（§4），与预判一致。
5. **不做的事**：把剩余 Wails 绑定层全量下沉（仍需能力接口层，收益递减）；把平台 glue（`*_windows/_other` 成对文件、注册表集成等）摊进十几个 internal 包——它们留在根是本分。根目录的 `third_party/go-webview2/`（2.2M 本地 fork，供补丁注入点）是子目录，不参与平铺计数，维持现状。
6. 首轮的**同包拆文件**（方案 A）落地了一半：patch / ai / app 完成；reading / gitinfo / sqlview / run / sessionindex 未拆。同包拆文件仍是零风险收益，可与对应抽包批次顺手做。

## 1. 三轮测量对比

| 指标 | 2026-11-14（首轮） | 2026-11-15 | 2026-11-16（本轮） |
| --- | --- | --- | --- |
| Go 文件（非测试 + 测试） | 135（84 + 51） | 173（110 + 63） | 180（112 + 68） |
| 总行数 | 33,440 | 38,542 | 40,712 |
| 零 App 引用的非测试文件 | 未测 | 52/110 | 52/112 |
| 使用 EventsEmit 的非测试文件 | 未测 | 13 | 13 |
| 共享助手 `logf` / `appDataDir` | 存在（当时的主要耦合点） | 已消失 | 已消失 |
| App 结构 | 未测 | 16 个字段 | 16 个字段 |
| 「纯引擎 + 壳」先例 | 无（仅讨论） | `patch_app.go`、`mcp_app.go` | + `ai_gen.go`、`ai_catalog.go` 同款形态 |

耦合形态的关键变化：候选域文件里的 `App` 引用几乎全是挂名绑定方法——`mcp_manager.go`、`sqlview.go`、`gitinfo.go`、`ai_gen.go`、`ai_catalog.go` 的 `a.` 引用数为 **0**；sessionindex / activity / sessionstore 只有 5–8 处且全在尾部绑定方法里（`sessionindex.go:561` 起、`activity.go:300` 起、`sessionstore.go:430` 起）。候选域真实消费的 App 能力只剩三类：`a.ctx`（事件）、timer 注册表钩子（已回调化）、reading 的两个内部 scan 方法。

（11-16 增量全部来自生图/视频与主题重构提交 649253b：`ai_gen.go`(384) + `ai_catalog.go`(162) 新域 + 4 个 AI 测试文件 + AI 传输层修改；进行中的未提交改动在 browser / plugins / ai_catalog，均在留根域或 B4 待稳定区。）

## 2. 为什么结论反转

首轮否掉抽包的逻辑链是「域逻辑与 App 交织 → 抽包先立能力接口层 → 跨域调用全过一层接口 → 收益不抵代价」。这条链的第一环断了：

- 数据见 §1：耦合主体已经收敛到「绑定方法」这一层，引擎本身是包级自由函数。
- patch 先例跑通且被复制：纯函数引擎 + `patch_app.go` 壳 + CLI 共用；mcp 全域照抄此形态（引擎 9 文件 2,975 行零耦合 + `mcp_app.go` 壳 11 个绑定）；生图/视频通道（`ai_gen.go`）与工具目录（`ai_catalog.go`）直接按此形态新增。
- 因此成本从「接口层设计 + 全域改写」降为纯搬移，风险由编译器与既有测试兜底。

## 3. 分批施工方案

| 批 | 内容 | 搬移（行，含测试） | 留根 | 备注 |
| --- | --- | --- | --- | --- |
| B1 | `internal/patch` | 3,531（types / parse / match / plan / write / store / platform×2 + 2 个测试文件）+ `patch_review.go` 的纯解析函数 | `patch_app.go`(418)、`patch_cli.go`(440)、`patch_review.go` 壳一行 | 按首轮 §5 蓝图执行（已验证零外部依赖）；CLI 先留 main |
| B2 | `internal/mcp` + `internal/sqlview` + `internal/atomfile` | mcp 2,975（9 引擎 + 4 测试，manager 的 `a.` 引用为 0）+ sqlview 引擎 ~855（sqlview.go 737 − 壳 ~100，+ sqlview_test 215） | `mcp_app.go`(134)；`sqlview.go` 尾部 3 个绑定拆出留根 | `writeFileAtomic`/`writeFileAtomicMode` 定义在 sessionstore.go 但已被 4 个域共用（ai_catalog / aiconfig / mcp_config / sessionstore）——B2 时先提为 `internal/atomfile`（~40 行零依赖叶子包），main 与 B3 的 sessionstore 都 import 它 |
| B3 | `internal/sessionstore`（含 lock 平台对）+ `internal/sessionindex` + `internal/activity` | 3,192（10 文件） | 各文件尾部绑定方法拆成 `*_app.go` 留根（~300 行） | 实测三者符号零交叉（sessionindex 不引用 sessionstore 任何符号）；若做首轮方案 A 剩余部分，sessionindex 的同包拆分并入本批 |
| B4 | `internal/aitransport` + `internal/aitimer` + AI gen/catalog | 2,601（ai_types / http / sse / stream / validate / proxy×2 + timer）+ 899（ai_gen + ai_catalog + 各自测试） | AI 绑定、timer 到点回调接线、gen/catalog 的挂名绑定拆出留根 | timer 注册表已回调化，接口化成本低；`ai_test.go`(1,006) 是混合测试，留 main，B4 不强拆。**等生图/视频线稳定后动** |

**每批验证**：`go build ./... && go vet ./... && go test ./...` → `wails build -devtools` → 对应链路冒烟（B1 已跑 `--check-patch`；B4 的 AI 连通性冒烟需真实账号，未跑——由完整单测与绑定重生成覆盖）→ `git show` 核对是纯搬移。

**实施进度（2026-11-16）**：B1–B4 全部完成，一批一提交：

| 批 | 提交 | 落地内容 |
| --- | --- | --- |
| B1 | `998915c` | `internal/patch`（8 引擎 + 2 测试）；顺带把引擎真实依赖提为共享叶子包：`internal/chardec`（编解码簇）、`internal/atomfile`（原子替换）、`internal/recycle`（回收站）；根留 `patch_app.go` / `patch_cli.go` / `patch_review.go` |
| B2 | `79c4706` | `internal/mcp`（9 引擎 + 4 测试，含假 server `TestMain` 随包迁移）、`internal/sqlview`、`internal/executil`（合并重复的 hide 窗口助手）；根留 `mcp_app.go` / `sqlview_app.go`；`writeFileAtomic` 族下沉 atomfile |
| B3 | `eb2c5df` | `internal/sessionstore`、`internal/sessionindex`、`internal/activity`、`internal/sessionlock`（三方共用的写锁独立成包）、`atomfile.RepairTornTail`（sessionstore / activity 共用）；根留 `sessionstore_app.go` / `sessionindex_app.go` / `activity_app.go`，`app_atomfile.go` 过渡壳删除 |
| B4 | `b09fc32` | `internal/aitransport`（三协议构造/SSE/重试/看门狗/校验/代理 + 事件契约）、`internal/aitimer`、`internal/aigen`、`internal/aicatalog`；根留 `ai_chat.go`（绑定壳）、`ai_stream.go`（流注册表）、`timer_app.go`、`ai_gen_app.go`、`ai_catalog_app.go`、`ai_transport_app.go`（钩子注入）。混合测试 `ai_test.go` 拆两半：传输用例随包，App 层用例留根 |

实施中修正的两处评估偏差：① sessionindex 与 sessionstore 并非「零交叉」——索引同步需要 `store.list/read`，用包内最小 `Store` 接口解耦（sessionindex 不 import sessionstore），标脏调用留在根壳；② `activity.go` 复用 sessionstore 的 `repairTornTail`、`ai_worklog.go` 复用会话写锁，两者按「上提共享叶子」处理，未在包间互相 import。

**纪律**（沿首轮）：每批一提交、纯搬移不顺手改逻辑；`_windows/_other` 成对搬移且后缀保留；测试跟包走，混合测试文件先留 main；新包导出面先 grep 全仓防撞（`createStructurePanel` 教训）；未来包间 import 保持单向（sessionindex → sessionstore 等现无依赖，出现了也要单向）。

## 4. 抽包后的根目录（诚实预期）

| | 抽包前（11-16） | B1–B3 后 | **四批后实测** |
| --- | --- | --- | --- |
| 根目录 .go 文件 | 180 | 146 | **135**（84 非测试 + 51 测试） |
| main 包行数 | 40,712 | 31,636 | **26,861** |
| 非测试文件 | 112 | 89 | **84** |

四批共移走约 13,900 行、45 个文件；根目录剩 `app_*` 核心、Wails 绑定壳、reading/browser/run/gitinfo 等真 App 编排与平台 glue——按方案预期留在 main。

剩余非测试文件的构成（行数为 11-16 实测）：`app_*` 应用核心（3,214）、AI 编排层 `ai_chat/schedule/float/worklog/command`（1,321，真 Wails 编排）、reading（3,344）、browser + devtools（2,292）、run（1,417）、gitinfo（1,138）、plugins/skills/market/update（1,458）、平台 glue（`*_windows/_other`、integration / toolchain / terminal 等）。**这些留在 `package main` 不是债**：它们要么是 268 个 Wails 绑定的宿主，要么是平台差异对，要么真消费 App 状态（`reading.go` 的 14 处 `a.` 引用即此类）。

若之后想继续下沉 reading / run / browser，需要先接口化它们消费的 App 能力（EventsEmit、对话框、settings），成本中等、收益递减；§5 的实验若成立可大幅降低这类成本，先做 spike 再定。

## 5. 可选实验：App 嵌入域服务（未验证，先 spike）

`type App struct { *gitinfo.Service }` 这种嵌入：Go 反射会把提升方法算进 App 的方法集，若 Wails v2 按方法集绑定，域服务可以连方法带逻辑整体下沉、省掉全部壳方法。**这是非文档化行为，先写 10 行 spike 验证**（嵌入一个带导出方法的包级 struct，`wails build` 后看 `frontend/wailsjs/` 绑定产物是否出现该方法）。成立则 reading / run / browser 的下沉成本大降；不成立则维持壳文件模式，本方案不受影响。

## 6. 判定汇总（首轮 vs 本轮）

| 方案 | 首轮判定 | 本轮判定 |
| --- | --- | --- |
| A 同包拆文件 | 推荐 | patch / ai / app 已落地；reading / gitinfo / sqlview / sessionindex 剩余部分仍推荐（零风险，随对应批次做） |
| B 前缀补齐 | 推荐 | 已落地（commands → app_commands 等） |
| C 抽 `internal/patch` | 可选试点 | **B1，照做** |
| D 全量分层 | 不建议 | 绑定层留根这部分维持不建议；但「纯引擎分批下沉」从 D 中拆出，升级为推荐（B1–B4） |

## 7. 首轮评估存档（2026-11-14）

- 首轮判定「暂不抽包」的三个前提——52/84 非测试文件碰 App、26k/33.4k 行与 App 交织、`logf`/`appDataDir` 共享助手横跨全仓——在 2026-11-15 实测中全部消失或弱化，判定随之更新。
- 首轮方案 A 施工图已执行：`patch.go`(2,180) → 7 个 `patch_*.go`；`ai.go`(1,745) → `ai_types` / `ai_chat` / `ai_stream` 等；`app.go`(1,444) → `app_file` / `app_fs` / `app_window`；`commands` / `dialogs` / `preview_assets` / `debugconsole` 补齐 `app_` 前缀。未执行：reading / gitinfo / sqlview / run / sessionindex 的同包拆分。
- 首轮 §6 前端 misfit 四条全部落地：`diff-dialog` → `editor/`、`core/plugins` → `shell/`、`core/widget` 借驻标注（AGENTS.md）、`shell/debugconsole` → `terminal/`。
- 首轮 §5（`internal/patch` 施工要点：错误不回引 main 助手、`patch_test.go` 拆两半、CLI 冒烟链路）并入本轮 B1。
- 2026-11-16 增量记录：649253b 新增 `ai_gen.go` / `ai_catalog.go`（均为纯引擎 + 挂名绑定形态，归入 B4）并修改 AI 传输层；`third_party/go-webview2` 本地 fork 已存在（2.2M，子目录不影响平铺）。

## 8. B5 零耦合收尾与嵌入服务 spike（2026-11-16，提交 `1692006`）

**spike 结论：成立**。把 `*probesvc.Service`（`internal/probesvc`，带一个导出方法）嵌入 `App` 后跑 `wails build -devtools`，`frontend/wailsjs/go/main/App.d.ts` 与 `App.js` 都生成了 `ProbeEmbeddedMethod` 绑定——Wails v2 按 App 的**方法集**生成绑定，提升方法对前端可见；运行时派发未做 UI 冒烟（生成侧证据已足够）。探针随后撤除。含义：reading / run / browser 这类真消费 App 状态的域，可以把域服务整体嵌入 App、省掉逐方法壳；服务内仍需回调注入 EventsEmit/对话框等能力。

**B5 范围**（实测零 `a.` 引用的收尾域）：

| 域 | 去向 | 备注 |
| --- | --- | --- |
| gitinfo（873 行，15 绑定） | `internal/gitinfo` | 纯引擎；`LooksBinary` 上提 `chardec` 共用 |
| webtools（522） | `internal/webtools` | 搜索/抓取，代理沿用 aitransport |
| envvars（199 + 平台对 101） | `internal/envvars` | DPAPI 平台对随包；`MergeEnv` 导出给命令桥/运行/终端 |
| aiworklog（182） | `internal/aiworklog` | Logf 注入 |
| structuredir（216） | `internal/structuredir` | 对话框与写盘留根 |
| runproject（155） | `internal/runproject` | 只读探测 |
| aiusage（318） | `internal/aiusage` | Version 注入 |
| update（119） | `internal/update` + `internal/vercmp` | 版本比较上提共享叶子 |
| skills（229） | **保留根目录** | `//go:embed all:docs/skills` 路径相对包目录，不能下沉 |

**最终结构（2026-11-16）**：根目录 **125 个 .go**（82 非测试 + 43 测试）、main 包 **22,948 行**；`internal/` **25 个包**（19 个域包 + 6 个共享叶子）。剩余根目录文件全是 Wails 绑定壳、真消费 App 状态的编排（reading / browser / run / ai_chat）与平台 glue。

## 9. B6 三域下沉与共享叶子补齐（2026-11-16）

嵌入服务 spike 成立后，B6 分四个可单独回滚的提交完成：

| 提交 | 范围 | 说明 |
| --- | --- | --- |
| `2ec9ca1` | B6-0 `internal/appdata` | 应用数据路径拼装下沉共享叶子，根目录留同名薄包装 |
| `e7a45c8` | B6a `internal/reading` | 扫描/解析/搜索与 4 个测试随包；`Reader` 嵌入 App；注入 Logf / Emit / DebugEnabled / RegisterPreviewRoot，启动清理改 `CleanupCacheOnStartup` |
| `e088f3b` | B6b `internal/run` + `internal/procctl` | 运行通道与平台 shell 探测随包；`Runner` 嵌入 App；run 与命令桥共用的取消表/进程树终止/参数校验提为 `internal/procctl`，命令桥改调共享实现。**已知有意变更（2026-11-17 审查确认接受）**：取消表统一错误文案为「任务 id %q 已在运行」「同时运行的任务超过上限 16」，且同步命令（AI run_command / 插件同步）一并纳入 16 上限（原同步路径不查上限），见 CHANGELOG「未发布」 |
| `4d48808` | B6c `internal/browser` | WebView2 宿主、CDP 桥、平台 stub 与 5 个集成测试随包；`Host` 嵌入 App；注入 Logf / Emit / FindParent；`ProfileRoot` / `ActiveProfileDirs` 导出给存储清理 |

**结果**：根目录 129 → **114 个 .go**（78 非测试 + 36 测试）、main 包 23,994 → **17,161 行**；`internal/` 30 个包（22 域 + 8 叶子）。起点是 B6 实测基线——§8 的 125/22,948 是 B5 终点测量值，其后两个 feat 提交又入了 4 个文件；终点数字精确无误。Wails 绑定产物在四批前后无差异（提升方法与原壳方法同名），前端零改动；每批 `go test ./... -timeout 300s` 与 `wails build -devtools` 全绿，browser 批含真实 WebView2 集成用例。

## 10. B7–B12 批次与 B11 暂缓（2026-11-16）

| 提交 | 范围 | 说明 |
| --- | --- | --- |
| `ed790d2` | B7 `internal/search` | search / search_rg / glob 与测试随包；`Searcher` 嵌入 App；`SkipDir` 导出给目录树共用忽略表 |
| `52580bb` | B8 `internal/aischedule` | 调度器与派生 SQLite 随包；`Scheduler` 嵌入 App；`Close` / `Path` 为包级函数；`Start` 同为包级（曾误为导出方法、被提升成 `Start` 绑定，2026-11-17 审查修正） |
| `86e5af0` | B9 `internal/cmdbridge` + `internal/shellpath` | 进程桥与 AI 终端命令随包；`findGitBash` / `findPwsh` 提为共享叶子，run 去掉钩子、终端留薄包装 |
| `28f54e1` | B10 `internal/terminal` | ConPTY 会话与 AI 读取接口随包；`Terminal` 嵌入 App |
| `9b624b5` | B12 `internal/toolchain` | 语言环境检测随包；`Toolchain` 嵌入 App |

**结果**：根目录 114 → **99 个 .go**（69 非测试 + 30 测试）、main 包 17,161 → **12,391 行**；`internal/` 36 个包（27 域 + 9 叶子）。每批 `go test ./... -timeout 300s` 与 `wails build -devtools` 全绿；绑定面注记：B8 曾因 `Scheduler.Start` 导出方法多出一个 `Start` 绑定（2026-11-17 修正为包级函数后与基线一致）。

**B11（plugins / market / skills）暂缓**：`plugins.go` 反复读改写根 `AppConfig`（PluginsPathMode / DisabledPlugins），`market.go` 读 DataSource，另有两个 runtime 文件对话框；`skills.go` 的 `//go:embed all:docs/skills` 需改由根壳传 `embed.FS`。施工要点：注入窄配置钩子（读写插件路径模式与禁用列表、读市场源）、文件选择器、embed.FS；测试需改为构造测试服务而非 `NewApp()`。按「收益递减」与平台 glue 留根口径，暂不实施——剩余根目录为 App 核心、绑定壳、平台 glue、CLI 与插件/技能宿主。

## 11. C 系列：B11 落地与剩余收口（2026-11-16）

| 提交 | 范围 | 说明 |
| --- | --- | --- |
| `051c418` | C0a `internal/clipboard` | 剪贴板图片读取与平台 stub、测试随包；粘贴绑定只改调用点 |
| `178079a` | C0b `internal/previewassets` | token 注册表与 /__local/ 中间件随包；reading 去掉 B6a 引入的 RegisterPreviewRoot 钩子 |
| `355434e` | C0c `internal/aiconfig` | ai-config.json 原子读写随包，Store 嵌入 App |
| `96aa4f7` | C0d webtools 配置 | external-tools.json 路径/加载/掩码合并并入 internal/webtools |
| `5cad98b` | C1a `internal/plugins` | 插件安装/更新/删除、资产读取与市场随包；路径模式/禁用列表/市场源经窄配置钩子注入；对话框留根壳；Git 测试拆回根目录 |
| `971c264` | C1b `internal/skills` | 物化与 agent 技能注册随包；根壳保留 //go:embed 并注入 embed.FS |
| `5e95a14` | C2a `internal/screenshot` | 窗口截图随包，FindParent 钩子注入 |
| `ffaaa34` | C2b `internal/notify` | Toast/闪烁/前台判定随包，IconID 与日志钩子注入 |
| `0a525b6` | C2c `internal/watch` | 监听状态收进 Watcher，App 四个字段移除 |
| `d7c22a5` | C3a `internal/mcpsamples` | MCP 示例释放与 mcp.json 合并随包，根壳保留 //go:embed 三份脚本 |
| `843c133` | C3b `internal/patchcli` + patch sidecar | 补丁 CLI 整体下沉；sidecar 读写/文本读取提为 internal/patch 导出能力 |

**结果**：根目录 99 → **79 个 .go**（60 非测试 + 19 测试）、main 包 12,391 → **7,595 行**；`internal/` 46 个包（34 域 + 12 叶子）。绑定名保持不变（注：C1a 曾把内部助手提为 `Manager.EnsureDir` 导出方法、多出一个 `EnsureDir` 绑定，2026-11-17 修正为包级函数）；每批全量 `go test ./... -timeout 300s` 与最终 `wails build -devtools` 全绿。

**停止线**：剩余根目录为 App 核心与 Wails 绑定壳、平台 glue（`integration_windows` / `cursors` / `windowicon` / `devtools` / `console`）、CLI 生命周期（`convert_cli` / `installer_cli` / `main`）、补丁与存储的薄壳（`patch_app` / `patch_review` / `storage_app`）以及 `webtools_app` 等转发壳。继续拆分的收益已低于维护成本，布局工作到此结束。

## 12. D 系列：文件系统、集成与 AI 对话收口（2026-11-16）

| 提交 | 范围 | 说明 |
| --- | --- | --- |
| `b3efb83` | D1a `internal/fileio` | 打开/保存、外部修改校验、图片与二进制判定、编码探测随包；FileData 根别名 |
| `219d394` + `33eff0b` | D1b `internal/fsops` | 目录树/列举、新建改名、复制移动、data URL 落盘随包；三个系统对话框留根；预算常量与 EntryExists 导出给测试 |
| `b10c2df` | D2 `internal/integration` | 文件关联/右键菜单/PATH 集成随包，Registrar 嵌入 App；安装器 CLI 改调导出函数 |
| `06d4d0c` | D3 `internal/debugconsole` | 调试控制台日志追加/增量读/裁剪随包，Console 嵌入 App；导出与开窗留根壳 |
| `ad17119` | D4 `internal/aichat` | AI 对话与流注册表、看门狗随包，Chat 嵌入 App；aitransport 看门狗挂载点改指 aichat |

**结果**：根目录 79 → **73 个 .go**（56 非测试 + 17 测试）、main 包 7,595 → **5,727 行**；`internal/` 51 个包（39 域 + 12 叶子）。绑定名不变，最终 `wails build -devtools` 通过。

**剩余不可拆项（收益 < 成本）**：`convert_cli.go`（App convert 生命周期与主入口共用状态）、`app_window.go` 的 appConfig/窗口编排、`logging.go`（跨包 Logf 已够用）、`patch_app.go` / `mcp_app.go` / `sessionstore_app.go`（绑定壳与生命周期）、以及 `ai_float` / `app_dialogs` / `installer_cli` / `delete` / `app_pathinfo` 等平台 glue。继续拆需要为单个绑定再造服务与测试脚手架，属于为行数而搬。

## 13. E 系列：根目录残余引擎收口（2026-11-16）

| 提交 | 范围 | 说明 |
| --- | --- | --- |
| `67c837d` | E1 `internal/launchargs` | 打开目标（path:line:column）、设置页、AI 会话、单实例 ID 与开关判定随包；OpenTarget 随包 |
| `b36b81c` | E2 `internal/appconfig` | config.json 结构、默认值、归一化与路径随包；插件 / 打开方式 / 开发者模式共用同一份 Read/Save |
| `1377174` | E3 `internal/applog` | 运行日志文件与轮转（保留 20 个）、分级写入、开发者模式、Wails Logger 随包；根留 5 个绑定壳与 writeAppLog 别名 |
| `3edb7c2` | E4 `internal/convertcli` | --convert 类型、目标格式表、输入展开与参数解析随包；根留隐藏窗口生命周期（请求 / 结果 / 超时） |
| `e272a16` | E5 fileio 收敛读图 | 删除根目录重复的 ReadImageAsDataURL（扩展名白名单版），统一 fileio 内容嗅探（32 MB、补 svg MIME）；绑定名统一 ReadImageAsDataURL |
| `40ddbf0` | E6 `internal/installercli` | 安装器 --integrate/--unintegrate 解析与执行随包，main 只留一行调用 |

**结果**：根目录 73 → **69 个 .go**（54 非测试 + 15 测试）、main 包 5,727 → **4,631 行**；`internal/` 51 → **56 个包**。绑定变化仅两处：`OpenTarget` 命名空间改为 `launchargs`、`ReadImageDataURL` 绑定移除（统一为 `ReadImageAsDataURL`），`frontend/wailsjs` 由 wails build 重生成。

**停止线更新**：剩余 4,631 行中，`main.go` / `app_core.go` 是 Wails 生命周期与 App 结构（必须在根）；17 个 `*_app.go` 是绑定壳；`patch_app` / `mcp_app` / `sessionstore_app` / `storage_app` 是较厚的壳但不含独立引擎；其余为 `windowicon` / `cursors` / `console` / `devtools` / `webview_args` / `app_dialogs` / `ai_float` / `delete` / `app_pathinfo` 等平台 glue。继续拆需要为单个绑定再造服务与测试脚手架，收益低于维护成本。

## 14. F 系列：三次收口后的残余再评估（2026-11-16）

E 系列后再审根目录，确认仍有三处「壳里有引擎编排」和两处「独立小引擎」，按批实施：

| 提交 | 范围 | 说明 |
| --- | --- | --- |
| `fc74f9c` | F1 `internal/newwindow` | OpenNewWindow / OpenDirInNewWindow / OpenWorkspaceForConversation / OpenInNewWindows 的目录校验与进程拉起随包；根留四行转发绑定，多文件多窗口先 SetOpenMode 再调包 |
| `bb4c911` | F2 fsops 吸收 | PathInfo + GetPathInfo 与 DeleteEntry（路径校验 + 回收站）并入 `internal/fsops.FS`，删除根 `app_pathinfo.go` / `delete.go`；测试同批迁入包内，存储清理改用 `RemoveToRecycleBin` |
| `571164a` | F3 `internal/sessionstore.Service` | 十个 AISession* 绑定随 Service 嵌入 App；派生索引标脏改为 OnBodyChange / OnMetaChange / OnRemove / OnClear 四个宿主钩子，根壳只剩 AppDataDir 与钩子接线 |
| `83792dd` | F4 patch 编排 | SavePatch（内容去重、预检失败清理、sidecar 基线、索引写入）与 DeletePatch（锁、索引摘除、回收站）移入 `internal/patch`；patch_app.go 只剩转发 |
| `aa6c0d0` | F5 `internal/mcp.Client` | MCP* 八个绑定与 Manager 生命周期（含互斥状态）收进 Client，App 少两个字段；InitClient 注入事件出口并加载配置，CloseClient 统一退出关闭 |

**结果**：根目录 69 → **64 个 .go**（52 非测试 + 12 测试）、main 包 4,631 → **3,961 行**（−670 行）；`internal/` 56 → **57 个包**。绑定名全部保持不变（提升方法），`frontend/wailsjs` 由 wails build 重生成；每批全量 `go test ./... -timeout 300s` 与 `wails build -devtools` 全绿。

**最终停止线**：剩余根目录为 `main.go` / `app_core.go`（Wails 生命周期与 App 结构）、十余个 `*_app.go` 转发壳、`storage_app.go` 的位置映射接线，以及 `windowicon` / `cursors` / `console` / `devtools` / `webview_args` / `app_dialogs` / `ai_float` / `app_window`（config/剪贴板/资源管理器）等平台 glue。按 AGENTS 口径平台 glue 留根是本分；继续拆任何一项都需要造有状态服务或跨包搬 Windows API，收益已明确低于维护成本，布局工作收口。

## 15. G 系列：Wails v3 多窗口时代的二期结构化（2026-11-24）

> 上一次评估（§14）的停止线写在 v2 时代。v3 一进程多窗口迁移带来 9 个新的窗口宿主文件（约 2300 行）从未评估过，根目录又回到 **107 个 .go / 9149 行**——§14 的「收口」结论对新代码不成立。

### 15.1 判定口径（本轮确立，写进 AGENTS.md「Go 侧」）

1. **`internal/` 零 Wails 依赖**（实测 74 个包 grep 命中 0）。强依赖 `application.WebviewWindow` 的窗口宿主编排**留根**；纯状态用泛型参数注入句柄（`State[W]` / `Registry[W]`，根传 `W = *application.WebviewWindow`）。
2. **绑定承载走服务化嵌入**，不再每域一个转发壳：`internal/<域>` 写 `type Service struct{}`，根用**未导出类型别名**匿名嵌入 `App`（`type memoService = memo.Service` + `*memoService`，绕开「同一类型只能匿名嵌入一次」——`App` 已有 `*sessionstore.Service`）。Wails v3 绑定面就是 `*App` 方法集（`pkg/application/bindings.go:236` 的 `ptrType.NumMethod()` 会遍历到提升方法），FQN 仍是 `main.App.<Method>`，**前端零改动**。
3. **`Service` 只导出确实要暴露给前端的方法**，其余保持包级/小写——每个导出方法都会变成前端可调绑定（历史事故 `Scheduler.Start` / `Manager.EnsureDir`）。
4. **先建守卫再动手**：绑定面基线测试是所有搬移的安全网，没有它就无法区分「改造出错」与「预期变化」。

### 15.2 批次

| 批 | 内容 | 结果 |
| --- | --- | --- |
| 0 | **绑定面基线守卫** | `app_bindings_guard_test.go` + `testdata/app_bindings_baseline.txt`：反射枚举 `*App` 方法集（**420** 条，含嵌入服务提升方法），过滤 wails 的 `internalServiceMethods`（`ServiceName` / `ServiceStartup` / `ServiceShutdown` / `ServeHTTP`），排序后逐行比对；多一个少一个都红，并禁止 `Start` / `Close` / `EnsureDir` 这类代表名进基线 |
| 1 | **宿主接线合并**（零逻辑） | 9 个「只做 init 注入、零绑定」的壳 → `host_wiring.go`；3 个 embed 壳 → `embed_assets.go`；`wails_app.go` 更名 `host_wails.go`。**init 顺序纪律**：同包 init 按文件名字典序执行，`embed_assets.go`（e）早于 `host_wiring.go`（h），所以 `desktopmcp.Logf` 必须写成转发闭包而不是取 `mcp.Logf` 函数值（2026-11-23 审查 M3 的坑） |
| 2 | **纯逻辑下沉** | 新增 `internal/windowreg`（`Mode` / `Spec` / `State[W]` / `Registry[W]` / `PathKey` / 辅助窗查找，约 480 行 + 测试 196 行）与 `internal/secondinstance`（`Decide` + `Plan`/`Group`/`Deps`，约 125 行 + 表驱动测试 157 行）、`internal/eventowner`（约 100 行 + 测试 99 行）；几何 key 并入 `internal/windowgeom`（`RestoreKey` / `PersistKey` + 测试）。根侧全部用类型别名 + 薄包装，**窗口族 9 个文件的调用点只做大小写导出化**（`st.name()` → `st.Name()` 等约 100 处，编译器兜底） |
| 3 | **服务化收编 25 个绑定壳**（4 小批：存储族 / AI 族 / 开发者族 / 文件与调试族） | 删除 `memo_app` `activity_app` `sessionindex_app` `usage_stats_app` `app_preview_assets` `ai_artifact_app` `ai_catalog_app` `ai_gen_app` `ai_image_policy_app` `ai_usage_app` `ai_worklog_app` `cognition_app` `maven_app` `sandbox_app` `run_project_app` `structuredir_app` `sqlview_app` `update_app` `envvars_app` `patch_review` `webtools_app` `webtools_config` `dbclient_app` `gitinfo_app`；`init` 注入统一搬进 `host_wiring.go`。**cognition 是特例**：包内已有 `Service`（引擎），绑定承载类型叫 `Bindings`，由 `NewBindings(logf)` 构造 |
| 4 | **窗口宿主收敛** | `windowmeta.go` + `window_app.go` → `window_host.go`；`terminal_window.go` + `ai_float.go` + `global_hotkey.go` → `window_aux.go`；`app_close_action.go` 更名 `window_close.go`。`window_factory.go` / `window_geometry.go` 保持独立（职责单一、且是最活跃的建窗路径，不做文件级重写） |
| 5 | **测试归位与文档** | `secondinstance_plan_test.go` → `internal/secondinstance/`；`window_geometry_test.go` + `aux_windows_test.go` → `internal/windowgeom/keys_test.go` + `internal/windowreg/windowreg_test.go`；新增 `window_route_test.go`（依赖 `winReg` 的真实路由语义留根）与 `window_aux_test.go` |

### 15.3 结果与偏差

| 指标 | 起点 | 终点 |
| --- | --- | --- |
| 根目录 `.go` | 107（84 非测试 + 23 测试） | **49**（30 非测试 + 19 测试） |
| 根目录非测试行数 | 6589 | **4639**（−30%） |
| 根目录总行数 | 9149 | **6923** |
| `internal/` 包数 | 74 | **79**（+windowreg / +secondinstance / +eventowner / +winutil） |
| 绑定方法 | 285 显式 + 提升 | **420（不变）**，基线一致 |
| 前端改动 | — | **0 行** |

**三处有意的偏差**（按「职责单一优先于文件数」裁定）：

1. `browser_app_windows.go` 带 `//go:build windows`，不能并进平台无关的 `host_wiring.go`，保持独立。
2. `crashrecovery_app.go` 有实质逻辑（自愈清理），不是纯 init 接线，保持独立。
3. **六个「真消费 App 状态」的壳不合并**（`patch_app` / `storage_app` / `plugins_app` / `wipeguard_app` / `oauthquota_app` / `timer_app` / `mcp_desktop_app`）：原计划塞进一个 `app_bindings_host.go`，但那是六个互不相关的域——违反「一个文件出现第二个域就必须拆」的红线。文件数比职责边界次要。

### 15.4 下一轮若继续（本轮未做）

- `resource_watch_app.go`（112 行，5 绑定）与 `appservices_app.go`（47 行，6 绑定）：**刻意不服务化**——它们包装的 `*watch.Watcher` / `*appservices.Registry` 本身就是 App 的嵌入字段（Watcher 的导出方法已经在绑定面里），再套一层 Service 要么重复绑定、要么把 Registry 的 `Start`/`Stop`/`Sync`/`List`/`Logs` 全部提升成前端可调方法（正是 `Scheduler.Start`、`Manager.EnsureDir` 那类事故）。要动就得先把 Registry 改成 `Service` 的未导出字段并清掉 App 上的直连，收益低于风险。
- 平台 glue 10 个成对文件（`windowicon` / `cursors` / `console` / `devtools` / `windowhide` / `webview_args` / `screenshot` / `notify` / `trayhost`）继续留根：它们是 Windows API 对，摊进 internal 只会把平台差异散到更多包里。

### 15.5 实测附带修复与平台能力下沉

**`aux_windows.go` 被误判为 Windows 专用文件**：结构性收获之一——文件名里的 `_windows` 被 Go 当成 **GOOS=windows 构建约束**，非 Windows 构建里这些绑定整块消失——`tools/check-crossbuild.cmd` 报 `app.GetAuxWindowKind undefined` 才暴露。已改名 `window_aux_bindings.go` 并在文件头写明不要再改回去。**新增窗口相关文件时注意这个后缀陷阱**（只有以 `_windows.go` / `_other.go` 结尾才会被当作平台文件）。

**平台能力下沉 `internal/winutil`（再收 11 个文件）**：复核发现 AGENTS「平台 glue 留根」这条口径早被 internal 现状打破——clipboard / recycle / shellexec / executil / envvars / sandbox / tray / notify / screenshot 早已是 internal 平台包。真正必须留根的只有依赖 `findWailsWindow` / `appIconID` / `wailsApp` 或 Wails 内部结构的 glue。于是把**零 App/Wails 依赖**的 4 对平台能力搬进新包 `internal/winutil`：`console`（AttachParentConsole）· `windowhide`（HideWindowAsync）· `webview_args`（SetWebViewExtraBrowserArguments）· `cursors`（SystemCursors，经 `Service` 嵌入提升 `GetSystemCursors` 绑定）。根侧只留一行转发调用点；另把 `notify_app_windows.go` 的纯 init 注入并入 `windowicon_windows.go`（两者共用 `appIconID`）。跨平台 vet 与真编三平台全绿。

### 15.6 三期：同平台文件合并 + 同族绑定壳合并（再收 10 个）

下沉到底之后，剩下的文件里还有一类冗余：**同 build tag 的平台文件**和**同族的绑定壳**可以按文件级合并（Go 的 `//go:build` 是文件级的，tag 相同的文件合并不改变编译语义）。

| 合并 | 结果 | 说明 |
| --- | --- | --- |
| `windowicon_windows` + `trayhost_windows` + `devtools_windows` + `browser_app_windows` + `screenshot_app_windows` | → `platform_windows.go` | 5 个都是 `//go:build windows`，且共享 `appIconID` / `findWailsWindow` 符号，合并后依赖更清晰；`init` 里的注入按原顺序排列 |
| 对应 4 个 `*_other.go` | → `platform_other.go` | `//go:build !windows`，保留 `OpenDevTools` 绑定桩（否则非 Windows 构建丢绑定） |
| `appservices_app` + `resource_watch_app` | → `app_field_bindings.go` | 都是「包装 App 嵌入字段的绑定壳」（`*appservices.Registry` / `*watch.Watcher`），不服务化（会把 Registry/Watcher 的 Start/Stop 提升成绑定） |
| `app_dialogs` + `app_fs` | → `app_dialogs.go` | 同是文件对话框绑定，共用 `dialogOwner` / `isDialogCancelled` 助手 |
| `appdata` + `logging` | → `app_infra.go` | 应用级基础设施，logging 本就 import appdata |

**没有合并的**：`event_owner.go`（事件归属路由）+ `window_route.go`（文件投递路由）——虽然都涉及窗口归属，但一个是事件分发、一个是文件路由，合进 `window_host.go` 会让职责变杂，违反「出现第二个域就拆」的红线。为行数而合并损害边界，不值。

**验证**：合并后 `go build ./...` / `go test ./... -timeout 300s` 全绿，`tools/check-crossbuild.cmd` 三平台全过（这是平台文件合并最关键的正确性证明），绑定基线 420 条不变。

### 15.7 最终停止线：剩下 49 个为什么收不动

- **真 Wails glue（2 个平台对）**：`platform_windows.go` / `platform_other.go` 依赖 `findWailsWindow`（枚举本进程 Wails 窗口的 Win32 代码）、`appIconID`、或反射 Wails 内部结构（`OpenDevTools` 靠反射读 `mainWindow` 字段）——与 Wails v3 版本强绑定，不可下沉。
- **真宿主编排（8 个）**：`patch_app` / `storage_app` / `plugins_app` / `wipeguard_app` / `oauthquota_app` / `timer_app` / `app_debugconsole` / `app_field_bindings`。前几个有对话框/锁/事件编排，后者包装的 `*Watcher`/`*Registry` 已是 App 嵌入字段。
- **CLI / 变体（3 个）**：`convert_cli` / `mcp_variant` / `mcp_variant_default` 与 `main.go` 共用启动状态，且带 build tag（`mcp` 与 `!mcp` 相反，不能合并）。
- **应用核心 + 宿主接线 + 窗口宿主（约 16 个）**：职责单一，已在 §15.2 收口。
- **测试（19 个）**：走绑定层的集成测试留根，纯逻辑测试已随包迁走。

