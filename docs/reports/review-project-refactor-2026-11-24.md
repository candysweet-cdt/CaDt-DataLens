# 重构审查报告：project-refactor-2026-11-24

> 审查对象：`docs/reports/project-refactor-2026-11-24.md`（三条并行重构线：后端 Go 结构化 / 前端 2A 按域拆分 / 前端 2B TypeScript 迁移）。
> 审查方式：5 组只读子代理分线核查 + 主代理逐条复核关键证据 + 亲自实跑全部验证命令。
> 审查日期：2026-11-24。审查时工作区干净（HEAD=`5457d70`）。

---

## 0. 总体结论

**三条线的核心技术断言全部属实，无造假、无功能性缺陷、无回归。** 主代理亲自实跑的验证全部通过：

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| Go 全量测试 | `go test ./... -timeout 300s` | ✅ 全包绿 |
| Go 构建 | `go build ./...` | ✅ |
| 绑定面基线 | `go test -run TestAppBindingBaseline .` | ✅ 420 条一致 |
| 类型生成一致性 | `node scripts/gen-backend-types.mjs --check` | ✅ 精确 263 / unknown 157 / 冲突 0 / 未找到 0 |
| 前端类型门 | `npm run -s typecheck` | ✅ 零错误 |
| 前端全量测试 | `npm test` | ✅ 2652 项全绿 |
| 三平台交叉编译 | `tools/check-crossbuild.ps1` | ✅ linux/amd64、darwin/arm64、darwin/amd64 |

报告声称的实测数据也基本准确：根目录 49 个 `.go`（30 非测试 + 19 测试）、非测试 4639 行、总 6923 行、79 个 internal 包、基线 420 条、24 个 `@ts-check`、`ai-panel.js` 19474 行、`main.js` 7307 行——逐项吻合。

**但审查发现 1 个真 bug（已产生错误产物）+ 一批文档/注释层面的疏漏。** 按严重度汇总：

| 严重度 | 数量 | 性质 |
| --- | --- | --- |
| 🔴 中（真 bug） | 1 | 类型生成器 `map[T][]V` 解析错误，已写出错误签名 |
| 🟡 低（文档数据失真） | 6 | 报告/方案的计数与实测不符 |
| 🟡 低（陈旧注释/死代码） | ~15 | 重构后未同步的旧文件引用、1 个孤儿桩 |
| ⚪ 提示（残留风险/技术债） | 2 | 漂移检测不在 `npm test` 门内；非 Windows 绑定面未验 |

**没有发现**：绑定面漂移、服务化嵌入错误、悬空 import、循环依赖、测试锚点漏迁、三处失配、交叉编译桩缺失、任何用户可见行为回归。

---

## 1. 🔴 真 bug：类型生成器把 `map[T][]V` 解析错（已写入产物）

### 证据

- `scripts/gen-backend-types.mjs:226-230`：

  ```js
  } else if (t.startsWith('map[')) {
      const inner = t.slice(4, t.lastIndexOf(']'));
      const val = t.slice(t.lastIndexOf(']') + 1);
      const key = SCALARS.get(inner.trim()) === 'number' ? 'number' : 'string';
      ts = `Record<${key}, ${goTypeToTs(val, named)}>`;
  ```

  用 `lastIndexOf(']')` 切 key/value，遇到值类型本身含 `[]` 时切错位置。对 `map[string][]int`：`lastIndexOf(']')` 指向 `[]int` 的 `]`，得到 `inner="string]["`、`val="int"`。

- **错误产物**：`frontend/src/types/backend.d.ts:472`

  ```ts
  /** @go PatchApply(planID string, files []string, hunks map[string][]int, mode string) → (*patch.PatchApplyResult, error) // 待补: PatchApplyResult */
  PatchApply(planID: string, files: string[], hunks: Record<string, number>, mode: string): Promise<unknown>;
  ```

  同行 `@go` 注释自证 Go 签名是 `map[string][]int`，正确类型应为 `Record<string, number[]>`。当前产物 `Record<string, number>` 是错的。

### 为什么是问题

与报告 B5.5 引以为傲的 `[]*T` 括号修复（`scripts/gen-backend-types.mjs:221-225`）是同类 bug，修了数组元素却漏了 map 值带 `[]` 的情形。违反方案 `docs/finished-plans/frontend-typescript.md` 的「`backend.d.ts` 不撒谎」原则。且 `--check` 查不出——它只比对「生成结果 vs 仓库产物」，生成逻辑本身错时两者一致。

**当前无运行期危害**：`Backend` 接口类型在 `frontend/src/**/*.js` 中零引用（类型全在构建期擦除），`PatchApply` 的 3 个调用点（`ai-panel.js:11269`、`ai/tools/ai-worktree.js:1045`、`editor/patch-view.js:677`）都传 `null` 作 hunks 且所在文件未开 `@ts-check`。但生成器作为长期设施必须修正。

### 修改方法

仿照已有的 `matchParen`（`scripts/gen-backend-types.mjs:97`）写一个 `matchBracket`，从 `t.indexOf('[')`（即 `map[` 的 `[`）出发找**配对**的 `]`，用它替代两个 `lastIndexOf(']')`：

```js
} else if (t.startsWith('map[')) {
    const keyOpen = 3;                       // "map[" 的 '['
    const keyClose = matchBracket(t, keyOpen);
    const inner = t.slice(4, keyClose);
    const val = t.slice(keyClose + 1);
    const key = SCALARS.get(inner.trim()) === 'number' ? 'number' : 'string';
    ts = `Record<${key}, ${goTypeToTs(val, named)}>`;
```

修后重跑 `node scripts/gen-backend-types.mjs`（不带 `--check`）再生成产物，`frontend/src/types/backend.d.ts:472` 应变为 `hunks: Record<string, number[]>`；再跑 `npm run typecheck` + `npm test` 确认无回归。建议给 `goTypeToTs` 补一组表驱动用例（`map[string][]int` → `Record<string, number[]>`、`map[int][]*T` → `Record<number, (T | null)[]>`），避免同类 bug 再犯。

---

## 2. 🟡 报告/方案文档数据失真（6 处）

| # | 位置 | 报告写的 | 实测 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | `docs/reports/project-refactor-2026-11-24.md:213` | `test/ai/` 顶层测试 127 → **7** | **36** | 迁移提交 `133dd23` 后就是 36 个根测试 + 91 个入域测试 = 127；「7」从未成立。同错误见 `docs/finished-plans/frontend-split-phase4.md:318` |
| 2 | 报告 `:175,198,241,255` | **35** 个测试读 `ai-panel.js` 源码文本 | 精确统计 **37** | 方案 `frontend-split-phase4.md` §2.4 又写 38，三个文档三个数字。建议统一口径（写「约 35–38」或精确值 37） |
| 3 | 报告 `:58,148` | 删除 **26** 个 `*_app.go` | `77a4e76` 实际删除 **27** 个 | 方案 `go-layout.md:228` 写 25 个但只列 24 个文件名。建议逐一对账后写死一个数并三处统一 |
| 4 | 报告 `:110` + `go-layout.md:239` | internal 包 **74 → 79** | 起点实为 **75**（`git ls-tree 224cc70 internal/` = 75） | 74+4=78≠79；新增 4 包（windowreg/secondinstance/eventowner/winutil）无误，起点写错 |
| 5 | `docs/finished-plans/frontend-typescript.md:90` | 补 **175** 个 unknown | 同文档 `:105` 与产物头注均为 **157** | 精度提升提交 `b1aa18a` 后漏同步，改为 157 |
| 6 | 报告 `:318` + `tools/rebuild-exe.ps1:193-194` + `frontend-typescript.md:104` | `--check` 在「Go 测试**之后**」 | 实际在 Go 测试**之前**（`rebuild-exe.ps1:199` vs `go test` 在 `:214`） | 功能无影响（仍在测试门内、仍计入失败摘要），改注释为「之前」即可 |

> 说明：审查初期曾怀疑报告 §5.2 写了错误的 Wails 模块路径 `wails.io/v3` 导致「grep 命中 0」成假守卫——**经核实为误判**，报告与 AGENTS.md 均未写该字符串。但 AGENTS.md:77 的「零 Wails 依赖（grep 命中 0）」措辞过宽：internal 里确有 3 个非测试文件 import 了 Wails 组织维护的 `github.com/wailsapp/go-webview2`（`internal/browser/browser_com_windows.go:19`、`browser_windows.go:26`、`internal/winutil/winutil_windows.go:19`）。严格成立的是「零 Wails **框架**（`github.com/wailsapp/wails/v3`）依赖、零 `application.WebviewWindow` 句柄依赖」。建议把口径精确化，并在 grep 时写明具体模式 `github.com/wailsapp/wails/v3`，使验证可复现。

---

## 3. 🟡 陈旧注释引用与死代码

重构改了文件名/合并了文件，但一批注释仍指向已不存在的旧文件。**均不影响编译/绑定面/测试**，但违反报告 §10 自己强调的「工具口径与注释要随现实更新」纪律，会误导后续维护者。

### 3.1 后端：指向已删除/改名文件的注释

| 位置 | 现状 | 改为 |
| --- | --- | --- |
| `app_core.go:163`、`:168`、`:278` | 「见 `app_close_action.go`」 | 该文件已改名 `window_close.go`，三处改之（`beginGracefulQuit` 实际在 `window_close.go:144`） |
| `host_wails.go:4` | 「经 `windowmeta.go` 的 windowState 归属」 | `windowmeta.go` 已删除并入 `window_host.go`，改为「经 `window_host.go`」或「经 `internal/windowreg` 的 State」 |
| `window_factory.go:6` | 「见 `windowmeta.go`」 | 改为「见 `window_host.go`」 |
| `window_aux.go:8` | 「绑定在 `aux_windows.go`」 | 已改名 `window_aux_bindings.go`（正是本次修复的 `_windows` 后缀陷阱），改之 |
| `app_fs_test.go:3` | 「`app_fs.go` 的 ReadDirTree 测试」 | `app_fs.go` 已删除并入 `app_dialogs.go`、实现下沉 `internal/fsops`，改为「fsops.FS.ReadDirTree 的测试」 |
| `internal/fileio/fileio.go:4` | 「留在根壳（`app_fs.go` / `app_window.go`）」 | `app_fs.go` 已不存在，改为「`app_dialogs.go` / `app_window.go`」 |
| `internal/winutil/service.go:5` | 「平台实现在 `cursors_windows.go` / `cursors_other.go`」 | 已并入 `winutil_windows.go` / `winutil_other.go` |
| `internal/browser/browser.go:21`、`internal/notify/notify.go:11`、`internal/screenshot/screenshot.go:9`、`internal/tray/tray.go:16` | 「`main/windowicon_windows.go`」 | 改为 `platform_windows.go` |

> 需**保留**的历史沿革型表述（准确且有价值，不要改）：`window_aux.go:5`、`window_aux_bindings.go:4-5`、`window_host.go:5`、`window_aux_test.go:4`、`app_dialogs.go:5`、`internal/windowreg/windowreg.go:5,12` 中的「原…/合并而来/别改回去」。

### 3.2 死桩：`platform_other.go:21`

```go
func applyTaskbarIcon() {}
```

`platform_windows.go` 中**没有** `applyTaskbarIcon`，只有 `applyTaskbarIconTo(hwnd uintptr)`（`:100`）；全仓 `applyTaskbarIcon(` 无任何调用点。这是合并时把 Windows 侧已改名的旧函数桩原样带过来的孤儿。Go 允许未使用的包级函数，不影响编译，但会误导后来者以为存在这个跨平台接缝。**建议直接删除该行**。

### 3.3 前端：源码注释中的旧扁平路径

均为 `//` 注释，零功能影响，可选修正：

- `frontend/src/main.js:3864`（`ai/ai-notify-policy.js` → `core/`）、`:3925`（`ai/ai-wipeguard.js` → `security/`）、`:5183`（`ai/ai-agent-settings.js` → `agent/`）
- `frontend/src/bridge/bridge-ui.js:26`（`ai/ai-group-member-view.js` → `group/`）
- `frontend/src/shell/message-center.js:4,43`（`ai/ai-notify-policy.js` → `core/`）
- `frontend/src/dev/mock-backend.js:581`（`src/ai/ai-file-tools.js` → `tools/`）
- `frontend/src/core/visual-spec.js:2`（`ai/ai-constants.js` → `core/`）
- `docs/repo-layout.md:73`：`frontend/src/ai/ai-context-slim.js` 实际在 `frontend/src/ai/chat/ai-context-slim.js`（方案 `frontend-split-phase4.md` 阶段一第 5 步明确要求同步 docs 路径，此为漏项）

---

## 4. 🟡 潜伏 bug：类型生成器 `stripBody` 对裸 `map[string]interface{}` 返回会截断签名

### 证据

`scripts/gen-backend-types.mjs:118-131` 的 `stripBody` 仅在 `{` 前紧邻单词是 `interface` 且其前字符属于 `[\s(\[,]` 时跳过花括号；`map[string]interface{}` 中 `interface` 前是 `]`，不匹配。子代理用 Node 复现：`stripBody(" map[string]interface{} { return nil }")` → `" map[string]interface"`（丢了 `{}`）。

**当前产物无错**：现有 `map[string]interface{}` 返回都是元组形式（如 `backend.d.ts:208`），元组在括号内 depth>0 不受影响；裸形式只有 `map[string]any`（`MCPDesktopInstallStatus`，`backend.d.ts:412-413`，正确）与 `map[string]string`。但一旦新增裸 `map[string]interface{}` 返回的绑定方法，签名会被静默截断成无效 Go 类型并回退 unknown，且 `--check` 照样「一致」。

### 修改方法

放宽正则允许 `]` 前导（如 `/(^|[\s(\[, \]])interface$/`），或在扫描到 `interface{}` 字面序列时整体跳过其 `{}`。与第 1 节的 `map[T][]V` 修复一并做，共用一组表驱动用例。

---

## 5. 🟡 精度不一致：已登记结构体遇包限定名仍映射 unknown

### 证据

`scripts/gen-backend-types.mjs:231` 直接用完整类型名 `t` 查 `STRUCT_INTERFACES`。Go 里 `(*plugins.PluginInfo, error)` 的 `t = "plugins.PluginInfo"` 未命中，落到 `:234` 具名类型分支 → unknown。产物 `frontend/src/types/backend.d.ts:180-181`：

```ts
/** @go AddPluginFromFolder(ctx context.Context) → (*plugins.PluginInfo, error) // 待补: PluginInfo */
AddPluginFromFolder(): Promise<unknown>;
```

`ImportPluginFromZip` 同样（`:392-393`）。而 `GetPlugins` 用非限定名则正确得到 `(PluginInfo | null)[]`（`:320`）。`@go` 注释还写「待补: PluginInfo」，实际已登记，只是没匹配上。报告 B6「具名结构体 interface 3 个」的覆盖率口径因此有水分。

### 修改方法

查表前取末段：`const base = t.split('.').pop()`，用 `base` 匹配 `STRUCT_INTERFACES`（同时 `named.add` 也用 base，避免注释里出现带包的待补名）。改后 `AddPluginFromFolder` / `ImportPluginFromZip` 应返回 `Promise<PluginInfo | null>`。

---

## 6. ⚪ 残留风险与技术债（知悉即可，非本次重构失实）

### 6.1 漂移检测不在 `npm test` 门内

`frontend/package.json:10` 的 `test` 只前置 `typecheck`（`tsc` 只验 d.ts 自洽，验不出它与绑定基线脱节）；`gen-backend-types.mjs --check` 仅在 `tools/rebuild-exe.ps1:199`。这是方案有意设计（报告 B7、方案 §5.3），不算实现错误。但 AGENTS.md:91 要求「改绑定面就必须重跑生成器」，而日常只跑 `npm test` 的开发流程无法拦住漂移，只有走 rebuild-exe.ps1 才能拦。

建议二选一：① 在 `package.json` 加 `pretest`（仓库根执行 `node ../scripts/gen-backend-types.mjs --check`）；② 在 AGENTS 硬规范里明确「`npm test` 绿 ≠ 无绑定面漂移，构建门才验」。

### 6.2 非 Windows 绑定面未验，且交叉编译工具查不出

`internal/cmdbridge/ai_command_windows.go`、`internal/integration/integration_windows.go`、`internal/toolchain/toolchain_windows.go` 无 `_other.go` 对应文件，其上的绑定方法（`AICommandStart*`、`AIRunShellCommand*`、`DetectToolchain`、`ListLangPackages` 等，经 `app_core.go` 嵌入 `*App`）在非 Windows 构建中整块消失。`check-crossbuild.ps1` 只用 `go vet`（编译测试但不**运行**），所以 `TestAppBindingBaseline` 从未在 linux/darwin 上真正执行；报告「三平台全绿」只证明可编译，不证明绑定面一致。

**注意**：这些文件来自更早提交（f066828 / 98365fb），**非本次重构引入**，且 `installercli_other.go` 等已保证调用链在非 Windows 不悬空，不会编译失败。建议知悉；若要严谨，补 `*_other.go` 桩（返回「当前平台不支持」）并在 CI 加一步 `GOOS=linux go test -run TestAppBindingBaseline .`，至少在报告 §7 验证表注明「交叉编译只验编译通过，未验非 Windows 绑定面」。

### 6.3 绑定守卫 UPDATE 路径未做 banned 名检查

`app_bindings_guard_test.go:84-97` 的 `UPDATE_BINDINGS_BASELINE=1` 分支写完基线直接 `return`，负向断言（`:104-110`，查 Start/Close/EnsureDir/ServiceStartup）只在其后的读取路径执行。若误用 UPDATE 且恰好把内部助手提升成绑定，该次运行会把事故名写进基线且不报错，下次常规运行/CI 才红。安全网最终仍有效，但反馈延迟一个提交。建议把 `:104-110` 的 banned 检查提到 UPDATE 写文件之前，或 UPDATE 分支内对 `current` 也跑一遍。

---

## 7. 逐线核查通过项（无问题，存档备查）

### 7.1 后端 Go 结构化（第一部分）

- **绑定面守卫真实且双向有效**：`app_bindings_guard_test.go` + `testdata/app_bindings_baseline.txt`（420 条唯一）用 `reflect.TypeOf(&App{}).NumMethod()` 枚举含提升方法；审查子代理用 Go overlay 注入合成变更实测——注入多余导出方法报「多出 1 个绑定」、改名已提升的 `GitPatchID` 报「绑定丢失 1 个」，两个方向都能拦。基线自守卫提交 `6ccea23` 到 HEAD 逐字节未变。
- **服务化嵌入正确**：`app_core.go:65-160` 的未导出类型别名与匿名嵌入一一对应，`NewApp()` 逐一初始化无遗漏；扫描全部 48 个被嵌入类型的 303 个导出方法，匹配 `Start|Stop|Close|EnsureDir|Init|...` 等内部助手名 0 命中；cognition 特例（`Service` 引擎 / `Bindings` 承载）正确，未把引擎的 `Edit/Read/Status` 提升成绑定；gitinfo 37 / dbclient 24 绑定与基线吻合。
- **测试归位真实**：`window_geometry_test.go` / `aux_windows_test.go` 的纯函数测试已迁到 `internal/windowgeom/keys_test.go`、`internal/windowreg/windowreg_test.go`（用 `New[struct{}]()` 占位句柄不碰 Wails），仍测到纯函数；依赖真实 `winReg` 的集成测试留根。
- **internal 零 Wails 框架依赖**：79 包，grep `github.com/wailsapp/wails` 0 命中；泛型 `State[W]` / `Registry[W]` 只存取句柄不调用其方法；根侧类型别名正确。
- **`_windows` 后缀陷阱已修复**：`aux_windows.go` → `window_aux_bindings.go`，文件头有明确警示；全仓 34 个 `*_windows.go` 均为真平台文件。
- **平台文件成对 + build tag 正确**：31 个 `*_other.go` 全带 `//go:build !windows`；`OpenDevTools` 等非 Windows 桩齐全（`platform_other.go:46`，在 420 条基线中）。

### 7.2 前端 2A 按域拆分

- **0 悬空 import、0 环**：119 个源文件、367 条相对 import，Tarjan SCC 全单点；127 个测试、162 条相对 import 全部可解析（2 条「未解析」是断言字符串字面量，非 import）。
- **测试锚点全部迁移正确**：`read()` / `new URL()` 基准、护栏裸路径（module-scope / form-controls / icon-guard / outside-click / overlay-esc）、P2 的 `ai-turn-steer-wiring.test.mjs:13` 改读新模块，均在位且测试全绿。
- **5 个拆出模块接线全部正确**：`aux-window-modes.js` / `bookmark-actions.js` / `ai-context-estimate.js` / `plugin-importer.js` / `ai-group-bridge.js` 均用 factory + deps getter 活引用，无漏传/值快照/裸引用 main.js/残留定义/循环依赖；M2 书签动作的 app_control 三处对齐（技能表 / APP_ACTIONS / switch）完好，守卫测试全绿。仅 2 条注释措辞夸大（称「getter 注入」实为函数直接注入，但都是稳定引用无快照风险），见 3.3 同类问题。
- **manifest 同步**：`package.json` 的 `test:ai` 登记 127 条与磁盘 127 个测试文件双向零差异。

### 7.3 前端 2B TypeScript 迁移

- 420 方法签名齐全（精确 263 / unknown 157 / 冲突 0 / 未找到 0）；3 个 `STRUCT_INTERFACES` 字段与 Go struct json tag 逐字段一致；`[]*T` 括号修复真实现（`gen-backend-types.mjs:224-225`，产物 `(AISchedule | null)[]`）；平台成对文件优先 `_windows.go` / App 接收者优先逻辑正确；类型门接线（package.json / tsconfig.check.json / typescript@^5.9.3）正确；`jsconfig.json` 未动；24 个 `@ts-check`、全 src 0 个 `@ts-nocheck`；三个提交文件清单与报告 B9 一致。

### 7.4 三线隔离

后端三提交碰 `frontend/` 文件数 0；前端 2A 四提交、2B 三提交碰 `.go` 文件数均为 0。报告「两/三线独立提交、互不卷入」属实。

---

## 8. 建议修复顺序

1. **先修真 bug**（第 1 节）：`map[T][]V` 解析 → 重跑生成器 → 补表驱动测试。顺带修第 4、5 节两个潜伏/精度问题（同一文件，一次改完）。
2. **订正文档数据**（第 2 节 6 处）：报告与方案的数字、顺序描述统一到实测值。
3. **清理陈旧注释与死桩**（第 3 节）：优先后端指向已删文件的 6 处 + `platform_other.go` 孤儿桩；前端注释可选。
4. **补守卫**（第 6.1 / 6.3 节，可选）：`pretest` 接 `--check`；UPDATE 分支补 banned 检查。
5. 修完重跑：生成器 `--check` → `npm run typecheck` → `npm test` → `go test ./... -timeout 300s` → `go build ./...`。

---

## 9. 🔴 附加 bug：已完成的子代理在团队视图 / HUD 弹层重复显示（5 → 10）

> 此问题由用户在审查过程中发现（截图：团队详情 10 条、HUD 角标 10，实际只有 5 个子代理），独立于本次三线重构，但一并记录。经运行时数据 + 源码双向验证，根因明确。

### 9.1 现象

- 「智能体团队」详情视图与 HUD「智能体团队」弹层里，每个已完成的子代理出现**两次**，且两遍顺序**相反**；
- HUD 角标显示 `10`（实际 5 个子代理）——因为 `setChipCount` 直接取 `listAgentsForHud().length`（`ai-head-hud.js:210-213`）；
- 两个视图共用同一数据源 `listAgentsForHud()`（`ai-team-view.js:144,152`、`ai-head-hud.js:330`），所以一起重复。

### 9.2 根因：会话读回时 `normalizeMessage` 剥掉了 `agent.key`，导致 HUD 去重键不一致

`listAgentsForHud()`（`frontend/src/ai/agent/ai-head-hud.js:113-167`）合并 4 个数据源，用 `seen` Set 去重。四个来源的 key 口径：

| 源 | 去重 key | 出处 |
| --- | --- | --- |
| ① subAgents | `sub.key`（`agent-*`） | `ai-head-hud.js:119` |
| ② agentRegistry | map key = `sub.key`（`agent-*`） | `ai-head-hud.js:130-132` |
| ③ subAgentRecords | `rec.key`（`agent-*`） | `ai-head-hud.js:138-139` |
| ④ session.messages | `(m.agent && m.agent.key) \|\| m.toolCallId` | `ai-head-hud.js:156` |

**内存态下四源 key 一致，不会重复。** 问题出在应用重启后的读回链路：

1. **落盘完整**：`serializeSessionMessage`（`frontend/src/ai/session/ai-session-store.js:171-178`）原样序列化整个 `agent` 对象，**含 `key`/`id`/`depth`/`artifactDir`/`sandboxMode`**；
2. **读回剥字段**：`normalizeMessage`（`frontend/src/ai/ai-panel.js:1817-1826`）重建 `message.agent` 时**只保留 8 个字段**（name/task/state/rounds/ms/tokens/summary/note），把 `key`/`id`/`depth`/`artifactDir`/`sandboxMode` 全丢了；
3. **运行期 Map 不受影响**：面板重读会话时整体替换 `sessions`，但 `agentRegistry`/`subAgentRecords` 是独立运行期 Map，仍持有全部已完成代理（key=`agent-*`）；
4. **去重失效**：第 4 源 `:156` 的 `m.agent.key` 为 `undefined`，回退到 `m.toolCallId`（形如 `chatcmpl-tool-*`），与 ①②③ 的 `agent-*` 不再相等 → `seen.has(key)` 判重失效 → 同一子代理被 push 两次：
   - 第一次来自 registry/records（key=`agent-*`，带 `subId`、真实 `startedAt`）；
   - 第二次来自 messages（key=`chatcmpl-tool-*`，无 `subId`、无 `startedAt`）。

**「顺序相反」也吻合**：`buildAgentTree` 按 `startedAt` 倒序排根（`ai-agent-tree.js:5,10,60`）。第一遍有真实 `startedAt` → 新→旧；第二遍无 `startedAt`（按 0 处理，稳定排序保持插入顺序）→ 旧→新。

### 9.3 运行时数据实证

对当前会话持久化文件 `ai-sessions/35dc7bd8/session-mwu13bmu1sju5/session.v1.jsonl` 解析，spawn_agent 消息的 `agent` 字段集合精确分成两类：

```
5 条: ms,name,note,rounds,state,summary,task,tokens        ← 恰好是 normalizeMessage 重建的 8 字段（key 被剥）
3 条: artifactDir,depth,id,key,mode,ms,name,note,rounds,sandboxMode,state,summary,task,tokens  ← 内存态新派（含 key/id）
```

模拟第 4 循环的 key 产出：5 条旧格式记录的 key 全部退化成 `chatcmpl-tool-*`，与 registry 的 `agent-*` 不同——重复机制完全复现。

### 9.4 修复方案

**主修复（根因，改 `frontend/src/ai/ai-panel.js:1817-1826`）**：`normalizeMessage` 重建 `message.agent` 时补回身份字段：

```js
message.agent = {
    key: aiTextOf(raw.agent.key),                       // 新增：恢复 sub.key，保证 HUD 去重键一致
    id: aiTextOf(raw.agent.id),                         // 新增：恢复 sub.id（详情视图磁盘补读转录也依赖它，见 ai-agent-view.js:185 注释）
    depth: Number(raw.agent.depth) || 0,                // 建议一并恢复
    artifactDir: aiTextOf(raw.agent.artifactDir),       // 建议一并恢复（父子挂靠 / 转录分桶）
    sandboxMode: aiTextOf(raw.agent.sandboxMode),       // 建议一并恢复（截图第一遍有「(完全)」标签、第二遍没有，即此字段）
    name: aiTextOf(raw.agent.name).slice(0, 16),
    task: aiTextOf(raw.agent.task),
    state: agentState,
    rounds: Math.max(0, Number(raw.agent.rounds) || 0),
    ms: Math.max(0, Number(raw.agent.ms) || 0),
    tokens: Math.max(0, Number(raw.agent.tokens) || 0),
    summary: aiTextOf(raw.agent.summary),
    note: aiTextOf(raw.agent.note),
};
```

恢复 `m.agent.key` 后，第 4 源拿到 `agent-*`，`seen.has(key)` 命中，重复条目被跳过。

**配套加固（改 `ai-head-hud.js:159-163`）**：第 4 源 push 的对象补 `subId: m.agent.id`、`parentSessionId: m.agent.artifactDir || ''`、`startedAt`，让纯重启后兜底条目能参与父子挂靠、并修正排序（否则即使不重复，兜底条目的层级与顺序也不准）。

> 备选（不推荐）：在 `listAgentsForHud` 里再加一个 `toolCallId` Set 判重（`rec.toolCallId` 与 `m.toolCallId` 同为模型 `call.id`，可作统一键）。改动更大且治标不治本——`normalizeMessage` 丢字段还会影响详情视图转录补读（`ai-agent-view.js:185`），主修复一并解决这些。

### 9.5 应补的回归测试

当前**无任何 `listAgentsForHud` 去重测试**（`ai-agent-tree.test.mjs` 只测树构建，fixture 都带 `subId`、无重复 key）。

1. 新增 `frontend/test/ai/agent/ai-head-hud.test.mjs`（或把 `listAgentsForHud` 抽成纯函数后测）：构造 registry/records 各含 1 条 `key='agent-1'`、`toolCallId='call-1'` 的记录 + `session.messages` 含一条 `role=tool, name=spawn_agent, toolCallId='call-1', agent={name,...}`（**故意不带 `key`**，模拟归一化后状态），断言输出长度为 1、且 `key==='agent-1'`。这是能锁死本 bug 的回归测试。
2. `normalizeMessage` 测试：断言对带 `agent.key`/`agent.id` 的 tool 消息**保留**这两个字段（当前会丢）。
3. `ai-agent-tree.test.mjs` 补一例：明确「树不去重、上游必须去重」的契约（或若决定在树里兜底，则断言重复 subId 只剩 1 行）。

### 9.6 验证方式

修复后：① 重启应用，确认团队视图 / HUD 角标恢复为 5；② 跑 `npm test` 全绿；③ 新会话里派子代理 → 重启 → 再打开团队视图，确认不重复（覆盖主修复路径）。

---

## 10. 修复实施记录（2026-11-24，用户确认后执行）

> 用户确认「开始修复」后，上述全部问题已实施修复。本节记录实际改动与验证。

### 10.1 已修复项

| # | 对应章节 | 改动 |
| --- | --- | --- |
| 1 | §9 重复显示 | `ai-panel.js:1817` 的 `normalizeMessage` 补回 `key/id/depth/artifactDir/sandboxMode`；`ai-head-hud.js` 新增导出纯函数 `makeHudDeduper()`（key + toolCallId 双维度判重），`listAgentsForHud` 四源统一用它去重，兜底条目补 `subId/parentSessionId/startedAt`。历史会话（key 已被剥）靠 toolCallId 维度仍能去重，**无需用户手动清理旧数据**。 |
| 2 | §9 回归测试 | 新增 `frontend/test/ai/agent/ai-hud-dedupe.test.mjs`（5 例：双维度判重 4 例 + 复现 5→5 + normalizeMessage 接线断言），登记进 `package.json` 的 `test:ai`。 |
| 3 | §1 生成器真 bug | `gen-backend-types.mjs` 新增 `matchBracket()` 修 `map[T][]V`；`stripBody` 正则允许 `]` 前导修裸 `map[string]interface{}`；`STRUCT_INTERFACES` 查表取 `t.split('.').pop()` 修包限定名。重跑生成：`backend.d.ts:470` → `hunks: Record<string, number[]>`，`AddPluginFromFolder`/`ImportPluginFromZip` → `Promise<PluginInfo \| null>`。精度 263→265、unknown 157→155。 |
| 4 | §2 文档数据 | 报告与方案：`test/ai` 顶层 7→36、`internal` 起点 74→75、服务化壳数口径统一为 26（27 减 window_app）、`--check` 顺序「Go 测试前」、方案陈旧 175 改为动态口径；`rebuild-exe.ps1` 注释同步。 |
| 5 | §3 陈旧注释/死桩 | 后端 12 处指向已删文件的注释改为现名（`app_close_action.go`→`window_close.go`、`windowmeta.go`→`window_host.go`、`aux_windows.go`→`window_aux_bindings.go`、`app_fs.go`→`app_dialogs.go`、`cursors_*`→`winutil_*`、`windowicon_windows.go`→`platform_windows.go`）；删除 `platform_other.go` 的孤儿桩 `applyTaskbarIcon()`；前端 7 处旧扁平路径注释 + `docs/repo-layout.md:73` 归位。 |
| 6 | §6.3 守卫加固 | `app_bindings_guard_test.go` 把 banned 名检查抽成 `checkBannedBindings()`，UPDATE 分支写基线前也跑一遍，避免误用 UPDATE 把事故名写进基线。 |

### 10.2 验证结果

| 验证项 | 结果 |
| --- | --- |
| `go build ./...` / `go test ./... -timeout 300s` | ✅ 全绿 |
| `go test -run TestAppBindingBaseline .` | ✅ 420 条一致 |
| `node scripts/gen-backend-types.mjs --check` | ✅ 精确 265 / unknown 155 / 一致 |
| 三平台交叉编译 | ✅ linux/darwin amd64+arm64 |
| `npm run -s test:ai` | ✅ **1500 项全绿**（修复前 1495，含新增 5 项去重测试） |
| `npm run -s test:maven` | ✅ 21 项全绿 |
| `test:ui-core` / `test:ui-shell` | ✅ 全绿（并行主题会话收口后复测） |
| `npm run -s typecheck` | ✅ 零错误（并行主题会话收口后复测） |
| **`npm test`（整条链）** | ✅ **全绿**（最终复测，退出码 0） |

### 10.3 并行会话干扰说明（已消解）

修复期间，另一并行会话正在本工作区开发「主题系统」（新文件 `frontend/src/core/theme-model.js`、`theme-registry.js`、`themes.json`、`docs/unfinished-plans/theme-system.md`，以及 `index.html`/`style.css`/`code-styles.js` 的改动）。这些文件**本轮审查开始时不存在**（首轮 `typecheck` 退出码 0），且**本修复一个字都没碰**。

修复刚完成时它们尚未收口，一度导致 `typecheck` 与 `test:ui-core`/`test:ui-shell` 报红（报错全部落在主题文件与主题用例上，与本修复无关）。**最终复测时该会话已收口，整条 `npm test` 链恢复全绿，干扰已消解。** 本次未改动任何主题系统文件。

---

## 11. 未修项（均为低优先，用户可决定是否处理）

审查发现的问题中，纯文档类的 1–3 项已按用户确认修掉（报告 263/157→265/155、2 条注释措辞、AGENTS.md 口径精确化）。**剩余刻意未改的 2 项**均涉及流程 / CI 取舍，不影响功能与验证全绿：

1. **§6.1 绑定漂移检测不在 `npm test` 门内**（方案有意设计）：`--check` 只在 `rebuild-exe.ps1` 构建门里，日常只跑 `npm test` 拦不住绑定面漂移。若要闭环可加 `pretest`；否则建议在 AGENTS 注明「npm test 绿 ≠ 无漂移」。
2. **§6.2 非 Windows 绑定面未验**（既有技术债，非本次重构引入）：`cmdbridge`/`integration`/`toolchain` 的 `_windows.go` 无 `_other.go` 桩，交叉编译只验编译不验绑定面。若要严谨可补桩 + CI 加 `GOOS=linux go test -run TestAppBindingBaseline .`。
