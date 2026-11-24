# 项目重构报告（2026-11-24）

> **共享报告**：本次前后端并行推进两条结构重构线，各自成章、互不覆盖。
>
> | 章节 | 范围 | 负责人 | 状态 |
> | --- | --- | --- | --- |
> | [第一部分：后端（Go）结构化](#第一部分后端go结构化) | 根目录 `package main` + `internal/` 分层 | 后端会话 | ✅ 已实施并提交 |
> | [第二部分：前端拆分与 TypeScript 迁移](#第二部分前端拆分与-typescript-迁移) | `frontend/src` 按域拆分 + TS 渐进迁移 | 前端会话 | ⏳ 由前端会话填写 |
>
> 两章独立提交、独立验证。后端线全程**前端零改动、绑定面零变化**；前端线的方案见
> `docs/unfinished-plans/frontend-split-phase4.md` 与 `docs/unfinished-plans/frontend-typescript.md`。

---

# 第一部分：后端（Go）结构化

## 1. 结论先行

`package main` 从 **107 个 `.go` / 9149 行**（84 非测试 + 23 测试）收敛到 **49 个 / 6923 行**（30 非测试 + 19 测试，非测试代码 −30%）。三个提交，全程：

- **绑定面不变**：420 条方法名基线逐行一致（守卫测试保证）；
- **前端零改动**：FQN 仍是 `main.App.<Method>`，mock 与调用点一个字没动；
- **全绿**：`go build` / `go test ./... -timeout 300s` / 三平台交叉编译（`linux/amd64`、`darwin/arm64`、`darwin/amd64`）。

## 2. 为什么要做

上一轮 Go 结构化（`docs/finished-plans/go-layout.md` §1–§14）在 v2 时代写下"布局收口"的停止线。但 Wails v3 一进程多窗口迁移带来 9 个新的窗口宿主文件（约 2300 行）从未评估，加上此后新增的引擎绑定壳，根目录又平铺回 107 个文件。实测把债分成三类：

| 债 | 规模 | 本质 |
| --- | --- | --- |
| 绑定壳原子化过度 | 约 40 文件 / 1500 行 | 每域一个 `*_app.go` 只做「init 注入 + 一行转发」，中位数 30 行 |
| v3 多窗口宿主从未结构化 | 9 文件 / 2300 行 | `windowmeta` / `window_factory` / `window_geometry` 等强依赖 Wails，与纯状态混在一起 |
| 测试没跟包走 | 2 文件 / 450 行 | `window_geometry_test` / `aux_windows_test` 测的是纯函数，却留在根 |

文件行数分布极偏：**≥300 行的只有 5 个非测试文件**，中位数约 30 行——不是代码太多，是文件太碎。

## 3. 三条判定口径（本轮确立，已写进 AGENTS.md）

1. **`internal/` 零 Wails 依赖**（实测 79 个包 grep 命中 0）。强依赖 `application.WebviewWindow` 的窗口宿主编排**留根**；纯状态用泛型参数注入窗口句柄（`State[W]` / `Registry[W]`，根传 `W = *application.WebviewWindow`）。
2. **绑定承载走服务化嵌入，不再逐方法壳**：`internal/<域>` 写 `type Service struct{}`，根用**未导出类型别名**匿名嵌入 `App`：
   ```go
   type memoService = memo.Service
   type App struct {
       *memoService   // 方法集提升 → 自动进 *App 方法集
   }
   ```
   Wails v3 的绑定面就是 `*App` 方法集（`pkg/application/bindings.go:236` 的 `ptrType.NumMethod()` 会遍历提升方法），FQN 仍是 `main.App.<Method>`。别名是为了绕开「同一类型只能匿名嵌入一次」（`App` 已有 `*sessionstore.Service`）。
3. **先建守卫再动手**：没有绑定面基线，就无法区分「改造出错」和「预期变化」。

## 4. 实施批次

| 批 | 内容 | 结果 |
| --- | --- | --- |
| 0 | **绑定面守卫** | `app_bindings_guard_test.go` + `testdata/app_bindings_baseline.txt`（420 条）。反射枚举 `*App` 方法集，排序逐行比对，多一个少一个都红；禁止 `Start`/`Close`/`EnsureDir` 这类内部助手名进基线（历史事故 `Scheduler.Start`、`Manager.EnsureDir`） |
| 1 | **宿主接线合并** | 9 个纯 init 壳 → `host_wiring.go`；3 个 embed 壳 → `embed_assets.go`；`wails_app.go` → `host_wails.go` |
| 2 | **纯逻辑下沉** | 新增 `internal/windowreg` / `secondinstance` / `eventowner`，几何 key 并入 `internal/windowgeom`；根侧用类型别名让窗口族调用点只做大小写导出化 |
| 3 | **服务化收编** | 26 个 `*_app.go` 删除，绑定随各域 `Service` 提升；`init` 注入统一搬进 `host_wiring.go`。含最厚的 gitinfo（37 绑定）/ dbclient（24）/ desktopmcp（异步安装作业 + 进度事件） |
| 4 | **窗口宿主收敛** | `windowmeta`+`window_app` → `window_host.go`；`terminal_window`+`ai_float`+`global_hotkey` → `window_aux.go`；`app_close_action` → `window_close.go` |
| 5 | **平台能力下沉** | 零 App/Wails 依赖的 4 对平台文件 → 新包 `internal/winutil`；`notify` 的 init 并入 `windowicon` |
| 6 | **文件合并** | 5 对 Wails 平台 glue → `platform_windows/other.go`；`appservices`+`resource_watch` → `app_field_bindings.go`；`app_fs`+`app_dialogs` → `app_dialogs.go`；`appdata`+`logging` → `app_infra.go`；`winutil` 包内 4 对 → 2 文件 |
| 7 | **测试归位与文档** | 纯逻辑测试随包迁；集成测试留根并改名对齐实现；AGENTS / repo-layout / go-layout §15 / CHANGELOG 同步 |

## 5. 关键技术点

### 5.1 服务化嵌入的两个坑

- **嵌入类型撞名**：Go 的匿名嵌入要求同一类型只能出现一次。`App` 已有 `*sessionstore.Service`，所以每个域必须用未导出别名（`memoService`、`dbclientService`…）让字段名互不相同——字段名不进绑定面，方法提升不受影响。
- **`Service` 的导出面就是绑定面**：包内其余能力必须保持包级函数或小写方法。`cognition` 是特例——包内已有 `Service`（引擎），绑定承载类型改叫 `Bindings`，由 `NewBindings(logf)` 构造。

### 5.2 泛型注入保持 internal 零 Wails 依赖

窗口状态机原本和 `*application.WebviewWindow` 混在根 `windowmeta.go`。做法是把它抽成泛型 `internal/windowreg`：

```go
type State[W any] struct { /* 纯状态，不调用 W 的任何方法 */ }
type Registry[W any] struct { /* 命名策略、查找、计数 */ }
```

根侧用类型别名 `type windowState = windowreg.State[*application.WebviewWindow]` + `var winReg = windowreg.New[*application.WebviewWindow]()`，让 9 个窗口文件的调用点只做大小写导出化（`st.name()` → `st.Name()`），编译器兜底。

### 5.3 `_windows.go` 后缀陷阱（实测修复）

`aux_windows.go`（五类辅助窗绑定）因文件名以 `_windows` 结尾，被 Go 当成 **GOOS=windows 构建约束**——非 Windows 构建里这些绑定整块消失。`tools/check-crossbuild.cmd` 报 `app.GetAuxWindowKind undefined` 才暴露。已更名 `window_aux_bindings.go` 并在文件头写明不要再改回去。**新增窗口文件时注意：只有以 `_windows.go` / `_other.go` 结尾才会被当作平台文件。**

### 5.4 平台文件的"下沉 vs 合并"二分

平台文件分两类，处理方式不同：

- **纯平台能力**（控制台附着、异步隐藏窗口、WebView2 参数、系统光标）：零 App/Wails 依赖 → 下沉 `internal/winutil`。这其实纠正了一个过时口径——AGENTS 原写"平台 glue 留根"，但 internal 里 clipboard/recycle/shellexec/executil/tray/notify/screenshot 早就是平台包了。
- **真 Wails glue**（`findWailsWindow` 枚举本进程窗口、`appIconID`、反射 Wails 内部结构打开 DevTools）：与 v3 版本强绑定 → 留根，但 5 对同 tag 文件合并为 `platform_windows.go` / `platform_other.go`。Go 的 `//go:build` 是文件级的，tag 相同的文件合并不改变编译语义；合并时必须保留 `OpenDevTools` 这类绑定方法的非 Windows 桩。

### 5.5 internal 包内的"过度拆分"边界

实测各包文件数/平均行数后，只动了 `internal/winutil`（上一轮自己照搬平台对结构造成：11 文件才 262 行，平均 23 行/文件 → 合并为 5 文件）。**其余包克制未动**：

- `internal/mcp` 的 4 个小文件（env / generation / image / name）职责各自清晰，合并会变成"MCP 杂项"文件，违反「出现第二个域就拆」；
- `plugins/manager.go`（4 行）、`cmdbridge/bridge.go`（15 行）是包级主类型 + 注入点载体，单独成文件是 Go 惯例；
- `atomfile` 合并只省 1 文件却要挪包注释，不值。

**判断原则：文件数少不是目标，职责单一才是。**

## 6. 实测数据

| 指标 | 起点 | 终点 |
| --- | --- | --- |
| 根目录 `.go` | 107（84 非测试 + 23 测试） | **49**（30 非测试 + 19 测试） |
| 根目录非测试行数 | 6589 | **4639**（−30%） |
| 根目录总行数 | 9149 | **6923** |
| `internal/` 包数 | 74 | **79**（+windowreg / secondinstance / eventowner / winutil） |
| 绑定方法 | 285 显式 + 提升 | **420，不变** |
| 前端改动 | — | **0 行** |

## 7. 验证

| 项 | 结果 |
| --- | --- |
| `go build ./...` | ✅ |
| `go test ./... -timeout 300s`（后台执行） | ✅ 全包绿 |
| `go test -run TestAppBindingBaseline .` | ✅ 420 条一致 |
| `tools/check-crossbuild.cmd`（三平台真编） | ✅ linux/amd64、darwin/arm64、darwin/amd64 |
| `gofmt` / `go vet` | ✅ 新增代码全部规范 |

## 8. 提交记录

```
6ccea23  test(go): 新增 Wails 绑定方法名基线守卫        2 files, +569
77a4e76  refactor(go): 根目录结构化（服务化/下沉/合并）  131 files, +4120 −3594
ce55d18  docs: 同步结构化的规范与方案记录               4 files, +137 −1
```

守卫测试单独先提交（基线在原始代码上生成，单独可编译验证）；主体重构一次提交——`app_core.go` 被多批反复修改，强拆会产生中间态编译不过的 commit；文档最后同步。提交边界严格按文件清单逐个 `git add`，未卷入并行会话的前端改动。

## 9. 停止线：剩下 49 个为什么不再合

| 类别 | 数量 | 理由 |
| --- | --- | --- |
| 真 Wails glue 平台对 | 2 | 依赖 `findWailsWindow` / `appIconID` / 反射内部结构，与 v3 强绑定 |
| 真宿主编排壳 | 8 | 有对话框/锁/事件编排，或包装的 `*Watcher`/`*Registry` 已是 App 嵌入字段（再套 Service 会把 `Start`/`Stop` 提升成绑定） |
| CLI / 构建变体 | 3 | 与 `main.go` 共用启动状态，带相反 build tag（`mcp` / `!mcp`）不能合 |
| 应用核心 + 宿主接线 + 窗口宿主 | 16 | 职责单一 |
| 集成测试 | 19 | 走绑定层测集成，留根合理；纯逻辑测试已随包迁走 |

刻意没合并 `event_owner.go`（事件路由）+ `window_route.go`（文件路由）——职责不同，合进 `window_host.go` 会让职责变杂。**为行数而合并损害边界，不值。**

## 10. 经验教训

1. **先建安全网再重构**：420 条绑定基线守卫是全程唯一能区分"改错"与"预期变化"的机制。没有它，26 个域的服务化就是盲改。
2. **Wails v3 的方法集绑定是重构杠杆**：理解 `bindings.go` 用 `ptrType.NumMethod()` 遍历后，服务化从"每域写壳"降级为"加个嵌入字段"，前端零改动。
3. **交叉编译是平台文件的唯一真相**：Windows 上永远绿，`_windows` 后缀陷阱和三平台桩缺失只有真编别的平台才暴露。
4. **工具口径要随现实更新**：「平台 glue 留根」的旧约定早被 internal 现状打破，重构时先复核口径再照做。
5. **克制**：文件数不是 KPI。合并同族、下沉纯逻辑、保留职责边界，三者之间的取舍才是重构的价值所在。

---

# 第二部分：前端拆分与 TypeScript 迁移

> **占位**：本部分由前端并行会话填写。该线的工作独立于后端重构，后端线全程未改动 `frontend/` 下任何文件。
>
> 已知背景（摘自前端会话自己的文档，供衔接参考，非本节结论）：
> - 按域拆分方案：`docs/unfinished-plans/frontend-split-phase4.md`
> - TypeScript 渐进迁移方案：`docs/unfinished-plans/frontend-typescript.md`（阶梯 0 已落地）
> - 该线的未提交改动：`frontend/src/types/`、`frontend/tsconfig.types.json`、`scripts/gen-backend-types.mjs`、`docs/unfinished-plans/frontend-typescript.md`
>
> 请前端会话补充：目标与动机、阶梯/批次、实测数据、关键技术点、验证结果、提交记录、停止线与经验教训。
