# 项目重构报告（2026-11-24）

> **共享报告**：本次前后端并行推进两条结构重构线，各自成章、互不覆盖。
>
> | 章节 | 范围 | 负责人 | 状态 |
> | --- | --- | --- | --- |
> | [第一部分：后端（Go）结构化](#第一部分后端go结构化) | 根目录 `package main` + `internal/` 分层 | 后端会话 | ✅ 已实施并提交 |
> | [2A：前端按域拆分](#2a前端按域拆分) | `frontend/src/ai` 按域归位 + `main.js`/`ai-panel.js` 拆叶子块 | 前端拆分会话 | ✅ 已实施并提交（4 提交） |
| [2B：TypeScript 渐进迁移](#2btypescript-渐进迁移) | TS 阶梯 0–1（类型门 + 24 个 core 文件） | TS 会话 | ✅ 已实施并提交（3 提交） |
>
> 两章独立提交、独立验证。后端线全程**前端零改动、绑定面零变化**；前端线的方案见
> `docs/unfinished-plans/frontend-split-phase4.md` 与 `docs/finished-plans/frontend-typescript.md`。

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

# 2A：前端按域拆分

> 本线独立于后端重构：后端线全程未改 `frontend/`，本线也未碰 Go 文件。两条线的提交严格按文件清单 `git add`，互不卷入。方案见 `docs/unfinished-plans/frontend-split-phase4.md`。

## A1. 结论先行

`frontend/src/ai/` 从 **117 个平铺文件**收敛为 **10 个域子目录 + 根目录 1 个组合根**（`ai-panel.js`）；`test/ai/` 的 127 个测试镜像拆到对应子目录。随后从 `main.js` / `ai-panel.js` 拆出 5 个内聚子模块。4 个提交，全程：

- **纯结构改动**：函数体逐字搬移，用户可见行为零变化；
- **全绿**：每批 `npm test` 全量 2652 项 + `npm run build`；
- **依赖图 0 环**：迁移前后用一次性脚本核对，无悬空 import。

## A2. 为什么要做

`ai/` 平铺 117 个 `ai-*.js`、`ai-panel.js` 达 1.1 万行（3000 行红线的 6.5 倍），是历次并行会话**频繁撞文件**的重灾区。实测把债分成三类：

| 债 | 规模 | 本质 |
| --- | --- | --- |
| 目录平铺 | 117 文件 | 无域分组，任何改动都散落在一层 |
| 测试源码锚定 | 35 个测试读 `ai-panel.js` 源码文本 | 拆函数必须同步改测试，否则静默红 |
| 组合根超线 | ai-panel 19636 行 / main 7688 行 | 39 个域已拆成兄弟工厂，剩下是高度耦合的调度核心 |

## A3. 实施批次

| 批 | 内容 | 结果 |
| --- | --- | --- |
| 阶段一 | **ai/ 全量归位**：116 文件按 agent/chat/core/gen/group/security/session/settings/tools/usage 十域归位，`ai-panel.js` 留根；127 测试镜像拆到 `test/ai/<域>/`，7 个留根 | 259 文件，+937 −884；全仓相对路径（import / read() / new URL() / 动态 import / 断言正则 / 护栏裸路径）按新旧目录重算 |
| M1 | `main.js` 的 5 类辅助窗启动器 → `shell/aux-window-modes.js`（~250 行） | `auxWindowKind` 顶层 await 留组合根 |
| M2 | 5 个书签 app_control case → `editor/bookmark-actions.js`（~93 行） | main.js 净减 62 行 |
| P2 | `buildApiMessages`（195 行）→ `ai/chat/ai-context-estimate.js` | 4 个输出状态留主闭包经 setter 写回；测试切片改读新模块 |
| M3+P3 | 插件导入器 → `shell/plugin-importer.js`（118 行）；内容视图切换（5 状态 + 4 函数）→ `ai/group/ai-group-bridge.js`（88 行） | 主文件引用改走 getter |

**P1 跳过**（用户裁定）：调研发现落盘机 `createAIConversationLog` 早已在 `ai-session-disk.js`，`ai-panel.js` 剩余的会话日志只是薄别名 + 诊断 UI（注入面 20+ 符号），强拆违反「注入面 >15 不搬」红线且收益极小。

## A4. 关键技术点

### A4.1 相对路径重算不是「加个目录前缀」那么简单

文件移入子目录后，所有相对路径层级都要变：`./ai-xxx.js` → `../core/ai-xxx.js`、`../../src/ai/xxx` → `../../../src/ai/<域>/xxx`。迁移脚本按**新旧目录算 `path.relative`** 重写每类引用点（import / read() / new URL() / 动态 import / 断言正则 / 护栏裸路径），而不是简单插字符串。踩过的坑：留根测试的层级、测试里 `read('../../' + rel)` 自带基准、断言字符串被误改、动态 import 变量路径——都靠全量测试兜住并逐个修复。

### A4.2 测试锚点必须跟着一起迁

35 个测试用 `read('ai/ai-panel.js')` + 正则切片断言源码文本。拆 P2 时把 `ai-turn-steer-wiring.test.mjs` 的切片改读新模块——**只搬函数不改测试 = 静默红**。这是"并行会话撞文件"的真正根源：不是文件大，是测试锚定源码文本。

### A4.3 无 export 顶层脚本的护栏误报

`module-scope.test.mjs` 靠「宿主顶层符号」扫描裸用，但 `main.js` 是无 export 顶层脚本，deps 对象的 getter 键（`get flash()`）会被误判成裸用宿主同名符号。按方案预案改用 `.cadt/tmp-*` 一次性静态扫描，**并做对照验证**（注入一个已知裸用 bug 确认扫描能抓到），不往 HOSTS 里硬塞 main.js。

### A4.4 状态留主闭包，只搬函数体

P2 的 4 个输出状态被 8+ 处读取，P3 的 5 个视图状态被 return 面读取——整包搬会大改所有读取点。做法是**状态留主闭包，函数经 deps getter/setter 读写**。这既符合「导出可变 let 状态活引用」的约定，也把注入面压到 6 项以内。

## A5. 实测数据

| 指标 | 起点 | 终点 |
| --- | --- | --- |
| `src/ai/` 顶层文件 | 117 | **1**（`ai-panel.js`）+ 10 域目录 |
| `test/ai/` 顶层测试 | 127 | **7**（组合根/跨多域）+ 10 域目录 |
| `ai-panel.js` 行数 | 19636 | **19474**（P2 −190、P3 −62；大头仍锁死） |
| `main.js` 行数 | 7688 | **7307**（M1/M2/M3 累计 −380） |
| 内部依赖边 / 环 | 260 / 0 | 迁移后复核仍 0 环 |
| `npm test` | — | **2652 项全绿**（每批） |
| 用户可见行为 | — | **零变化** |

## A6. 验证

| 项 | 结果 |
| --- | --- |
| `npm test`（每批） | ✅ 2652 项全绿 |
| `npm run build`（每批） | ✅ 成功（仅既有 chunk 体积警告） |
| 迁移前后依赖图脚本 | ✅ 0 环、无悬空 import |
| M1/M2/M3/P2/P3 deps 静态扫描 | ✅ 含对照验证（注入已知 bug 确认能抓到） |
| 运行态冒烟（便签独立窗） | ✅ 开窗/关窗正常、无运行时错误；内容空白系数据原因（未打开工作区 + 全局便签为空），非回归 |

## A7. 提交记录

```
133dd23  refactor(frontend): AI 源码按域归位并拆出辅助窗模块   259 files, +937 −884
c691a98  refactor(frontend): 拆出书签动作模块                  4 files, +119 −72
db05fd3  refactor(frontend): 拆出上下文组装模块                5 files, +238 −207
224cc70  refactor(frontend): 拆出插件导入器与群聊视图桥        6 files, +244 −196
```

## A8. 停止线：剩下为什么不拆

用括号配对精确重算后，`main.js` 129 个顶层函数只有 4 个超 100 行：`runAppAction`（1013，app_control 分发枢纽，M7 文档判定"爆炸半径最大"）、`initAIPanel`（517，被 11 处调用）、`menuItems`（273，菜单注册表）、`saveDoc`（146）。`ai-panel.js` 剩下的是 `executeToolInner`（~2000）、流式核心（~1800）、初始化（~830）——与主闭包深度耦合，读写 30+ 状态，且被 35 个测试锚定。

| 类别 | 理由 |
| --- | --- |
| 组合根调度逻辑（runAppAction / initAIPanel / executeToolInner / 流式核心） | 注入面 >15，硬拆引入循环依赖，违反 AGENTS.md 红线 |
| 菜单/事件注册表（menuItems / 全局监听块） | 本质是组合根接线，下沉收益低风险高 |
| 表驱动常量（`defaultSettings` 620 行） | 豁免类，不是技术债 |

**判断原则：组合根行数超标是固有属性，不是"没拆干净"。** 39 个域已拆成兄弟工厂，继续拆剩下部分只会制造接线混乱。曾误判 `defaultFormatSettings`（620 行）为可拆纯函数，精确重算后实为 7 行——体量统计必须按真实函数体边界，不能把紧随的顶层常量算进去。

## A9. 经验教训

1. **依赖图先行**：0 环是目录重组的许可证；先跑脚本再动手，比拆到一半发现环强得多。
2. **路径重写要算层级**：`path.relative` 重算新旧目录，别用字符串拼接；测试里的 `read()` 包装、断言字符串、动态 import 变量都是隐藏引用点。
3. **测试锚点是真债**：35 个测试锚定源码文本，拆函数必须同步迁测试——这比拆文件本身更费时，也更关键。
4. **对照验证不可省**：一次性扫描脚本必须注入已知 bug 证明它能抓到，否则可能是一直返回绿的假守卫。
5. **克制**：状态留闭包 + 函数薄转发，比整包搬迁安全；注入面 >15 就不搬。文件行数不是 KPI，职责边界才是。

---

# 2B：TypeScript 渐进迁移

> 本线独立于前端拆分线（2A）与后端结构化线（第一部分）：不换任何文件后缀、不改函数体，
> 只做「加类型 + 把类型门接进测试」。3 个提交全程 `npm test` 2652 项全绿、`npm run build` 通过，
> 产物 `dist` 仍 15 MB（类型全在构建期擦除）。方案与决议见 `docs/finished-plans/frontend-typescript.md`。

## B1. 结论先行

给前端装上一道**类型门**，但不做「306 个文件一把换后缀」。三步：

1. **绑定面有类型**：`scripts/gen-backend-types.mjs` 从绑定基线 + Go 源码生成 `backend.d.ts`，420 个 Wails 绑定方法全部有签名（精确 263 / unknown 157）；
2. **类型门进 CI 链**：`tsconfig.check.json` + `npm run typecheck` 挂在 `npm test` 最前面，`rebuild-exe.ps1` 的测试门再加一道 `--check` 防绑定面漂移；
3. **24 个 core 文件开 `@ts-check`**：`strict` 下零错误，历史上那 10 条 `ReferenceError` / `is not a function` 类事故从此在编译期被拦。

**关键取舍**：换后缀暂缓，`checkJs` 作为当前终态。理由见 B8。

## B2. 为什么要做（收益有事故记录佐证）

`CHANGELOG.md` 里能数出 **10 条** `ReferenceError` / `is not a function` 类事故，全是 TS 编译期能报的：

- 接线漏定义 `hideHtmlPreview` → 应用启动即崩、窗口起不来（CHANGELOG:1561）
- `explorer-ops.js` 裸写 `newFileTypeMenuItems(...)`（真身在 `main.js`）→ 右键菜单打不开（:2286）
- `aiReferenceFileMenuItems` 裸引用（:2514）、`oo.render is not a function`（:2568）、git-graph 缺 `kvGetJson` 导入（commit 779e5d7）
- 图标键漏登记 → 按钮静默渲染为空、测试全绿也看不见（只能靠护栏后补）

第二类是 `deps` 的 **576 个去重键** + `settings` 的 117 个键——接口化后少写一个 getter 就是编译错误，而非运行期 undefined。

## B3. 现状实测（动手前）

| 指标 | 数值 |
| --- | --- |
| `src` JS | **306 文件 / 134,933 行**（ai 117、core 48、shell 32、editor 29…） |
| 文件规模 | >3000 行 2 个（`ai-panel.js` 19,474、`mock-backend.js` 4,501）、1500–3000 行 7、600–1500 行 45、<600 行 252 |
| 测试 | 40,749 行 `.mjs`，**246 处直接 `import '../../src/*.js'`**，`node --test` 裸跑无转译 |
| 存量类型 | 36 文件 / 228 个 JSDoc 标签 ≈ 0；`jsconfig.json` 是 `checkJs: false`，全仓无 `@ts-check` |
| 后端绑定 | Go `*App` 方法 **420 个**，前端 1054 处 `backend.XXX` 调用，全走 `Call.ByName` Proxy，无任何生成类型 |

三条硬成本决定了不能一把转：① 改后缀会打断 246 处测试 import 与 5 个按 `.js` 扫描的护栏；② 类型面工作量在接口设计而非改名；③ 当时前后端两线正在并行重构，大范围改名会搅烂在飞 diff。

## B4. 实施批次

| 批 | 内容 | 结果 |
| --- | --- | --- |
| 阶梯 0 | **绑定类型生成器 + 产物**：`gen-backend-types.mjs` 以 `testdata/app_bindings_baseline.txt`（420 条）为名单、扫 Go 源码取签名，生成 `backend.d.ts` | 420/420 有签名；新增独立 `tsconfig.check.json`（`strict` + `noEmit` + `checkJs:false`），`jsconfig.json` 不动 |
| 阶梯 1a | **类型门接进测试**：`package.json` 加 `typescript@^5.9.3` devDependency + `typecheck` 脚本，`npm test` 前置 `typecheck` | 首批 13 个 core 文件开 `@ts-check`，顺带揪出 2 处真问题（见 B5.1） |
| 阶梯 1b | **再开 11 个纯函数模块** | `diff` / `jsonrepair` / `jsonschema` / `keymap` / `event-scope` / `activity-log` / `app-pages` / `shift-double-tap` / `scratch` / `editor-keybindings` / `overlay-stack`，累计 24 个 |
| 续作 | **精度提升 + 测试门接线** | 生成器加 `STRUCT_INTERFACES`（3 个无歧义结构体）；`[]*T` 映射 bug 修正；`rebuild-exe.ps1` 挂 `--check` |

## B5. 关键技术点

### B5.1 类型检查揪出的真问题（不是噪声）

- `core/dom.js` 的 `el()` 把 `string|number` 直接赋给 `textContent`（setter 只收 `string`）→ 改显式 `String()`，与原先隐式转换等价；测试断言按真实 DOM 语义从 `0` 改成 `'0'`。
- `core/notify-throttle.js` 的 `Number.isFinite(cfg.windowMs) && cfg.windowMs > 0` 不会收窄类型 → 先取局部量再判，默认值 30000 口径不变。

### B5.2 名单取基线、签名扫源码——为什么要分开

绑定承载类型已服务化（`*Chat` / `*GroupStore` / `*Bridge` / `*Store`…），逐个解析 `App` 的匿名嵌入链既脆弱又随重构变动。所以**方法名单一真源取绑定基线**（`UPDATE_BINDINGS_BASELINE=1 go test -run TestAppBindingBaseline .` 可随时重算），**签名扫 Go 源码按名字匹配**。平台成对文件优先取 `_windows.go`，同名方法优先取接收者为 `App` 的那条，其余才算歧义回退。

### B5.3 分文件 opt-in，不全局开 checkJs

`tsconfig.check.json` 的 `include` 覆盖全部 `src/**/*.js`，但 `checkJs: false`——只有文件首行写了 `// @ts-check` 的才检查。这样 306 个存量文件不会一次爆出数千错误，可以逐个开、每批零错误。禁止 `@ts-nocheck` 逃逸。

### B5.4 JSDoc 注释笔误也是债

加检查后暴露 3 处本就写错的注释：`diff.js` 注释里的 `@@` 与 `<pre>` 被 TS 当 JSDoc 标签解析（TS1003）、`overlay-stack.js` 的 `HTMLElement=` 可选语法写错（TS1109）。这些以前没人检查所以一直错着。

### B5.5 `[]*T` 的 TS 运算符优先级 bug

补 interface 后才现形：`[]*AISchedule` 映射成 `AISchedule | null[]`，被 TS 读成 `AISchedule | (null[])`（本意是 `(AISchedule | null)[]`）。修法是元素类型含 `|` 时加括号。之前元素都是 `unknown`，`unknown | null[]` 看不出问题。

### B5.6 类型精度的克制

`STRUCT_INTERFACES` 只收「字段全为基础类型、无嵌套具名类型、无同名歧义」的 3 个结构体（`GitOperationResult` / `PluginInfo` / `AISchedule`）。`SearchResult` / `PatchPreview` 嵌套子类型、`LeaseStatus` 有三个同名不同字段的版本（memo / sessionstore / 文档建议各一）——做全套解析器 + 包消歧的复杂度远超收益，且调用点都在未开 checkJs 的 `.js` 里，unknown 目前不产生任何误报。

## B6. 实测数据

| 指标 | 起点 | 终点 |
| --- | --- | --- |
| 开 `@ts-check` 的 core 文件 | 0 | **24**（strict 零错误） |
| 绑定方法签名 | 无类型 | **420/420 有签名**（精确 263 / unknown 157 / 歧义 0 / 未找到 0） |
| 具名结构体 interface | 0 | **3**（GitOperationResult / PluginInfo / AISchedule） |
| `npm test` | 2652 项 | **2652 项全绿**（typecheck 已进前置门） |
| `dist` 体积 | 15 MB | **15 MB**（类型擦除，产物零影响） |
| 文件后缀改动 | — | **0 个** |

## B7. 验证

| 项 | 结果 |
| --- | --- |
| `npm run -s typecheck` | ✅ 零错误（全量 306 个 JS 在编译程序里） |
| `npm test` | ✅ 2652 项全绿（含 typecheck 前置门） |
| `npm run build` | ✅ 成功，`dist` 仍 15 MB |
| `node scripts/gen-backend-types.mjs --check` | ✅ 与仓库内容一致 |
| `go build .` | ✅ 通过 |
| `rebuild-exe.ps1` PowerShell 语法解析 | ✅ 无错误 |

## B8. 停止线：为什么不换后缀（决议）

**换后缀暂缓，`checkJs` 作为当前终态。** 24 个文件开检查后，`npm test` 门已能拦住历史那 10 条事故；换后缀要动 246 处测试 import + 5 个按 `.js` 扫描的护栏（`icon-guard` 等），迁移期长期处于半迁移态，而类型全在构建期擦除、对单 exe 产物零影响，性价比不足。真需要复杂泛型时再重评。

若将来换后缀：**Node 下限抬到 22.18+**（Node 只是 dev 工具，用户跑 exe 不需要；约束只在 `AGENTS.md` / `README.md` 两行文档），**不引 `tsx`**（纯新增依赖，违反「能不引入就不引入」）。

## B9. 提交记录

```
b1ecff8  chore(frontend): 落地类型检查门（绑定类型生成 + 首批 13 个 core 文件）  22 files, +1198 −15
df56275  chore(frontend): 再开 11 个 core 模块的 @ts-check（累计 24 个）          13 files, +190 −35
b1aa18a  chore(frontend): 绑定类型精度提升与测试门接线（--check + 3 个 interface）  5 files, +141 −54
```

三次提交严格按文件清单 `git add`，未卷入并行会话的改动（后端 Go 文件、前端拆分、浏览器右键菜单）。

## B10. 经验教训

1. **先建门再铺量**：类型门（`npm test` 前置）先立起来，后面每批开检查才有强制力；不进门的检查会逐渐烂掉。
2. **名单与签名分离**：方法名取受守卫的基线、签名扫源码，绕开了服务化后嵌入链难解析的问题，也让生成器不随重构漂移。
3. **opt-in 而非全开**：`checkJs: false` + 逐文件 `@ts-check`，把「一次性数千错误」拆成「每批零错误」。
4. **精度要克制**：嵌套类型与同名多版本的保持 unknown——做全套解析器的复杂度远超收益，尤其调用点还没开检查时。
5. **换后缀不是目标**：类型擦除对产物零影响时，为语法好看付 246 处 import + 5 个护栏的代价不值。职责边界和性价比才是判断依据，与后端线「文件数不是 KPI」同一条原则。
