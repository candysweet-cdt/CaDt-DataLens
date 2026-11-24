# 前端 TypeScript 渐进迁移

> 2026-11-23 立。状态：**阶梯 0 与阶梯 1 已落地**（类型门已进 `npm test`，24 个 core 文件开检查），阶梯 2–3 待开工。
> 结论先行：不做「306 个文件一把换后缀」，走 checkJs → 新文件 `.ts` → 按域迁移三级台阶。
> **日常口径**：新增/修改 `core/` 纯逻辑文件时，顺手在文件首行加 `// @ts-check` 并让 `npm run -s typecheck` 保持零错误（不写 `@ts-nocheck`）。

## 1. 为什么现在不做全量迁移

实测（2026-11-23）：

| 指标 | 数值 |
| --- | --- |
| `frontend/src` JS | **306 文件 / 134,933 行**（ai 117、core 48、shell 32、editor 29、settings 22、db 15、bridge 15…） |
| 文件规模分布 | >3000 行 2 个（`ai-panel.js` 19,474、`mock-backend.js` 4,501）、1500–3000 行 7、600–1500 行 45、<600 行 252 |
| 测试 | 40,749 行 `.mjs`，**246 处直接 `import '../../src/*.js'`**，`node --test` 裸跑无转译 |
| 存量类型 | 36 文件 / 228 个 JSDoc 标签 ≈ 0；`frontend/jsconfig.json:3` 是 `checkJs: false`，全仓无 `@ts-check` |
| 注入面 | `deps.*` 576 个去重键、`settings.*` 117 个键 |
| 后端绑定 | Go `*App` 方法 **420 个**（`testdata/app_bindings_baseline.txt`），前端 1054 处 `backend.XXX` 调用，全走 `Call.ByName` Proxy（`frontend/src/core/wails-runtime.js` 的 `createBackendProxy`），无生成绑定 |

三条硬成本决定了不能一把转：

1. **测试链**：`src` 改 `.ts` 后，`node --test` 直跑 `.js` 的 246 处导入全断。Node 的类型擦除默认开启要 **22.18+/23.6+**（AGENTS 写的下限是 20.19+），且 import 说明符必须显式带 `.ts`，还要守 `erasableSyntaxOnly`（禁 `enum` / `namespace` / 参数属性）。
2. **类型面不等于改名**：576 个 `deps` 键 + 117 个 `settings` 键 + 420 个后端方法如果不落到接口上，全是 `any`，收益只剩语法级检查。
3. **时机**：前端仍在按域拆分（每批一个 refactor commit），`ai-panel.js` 19,474 行是 3000 行硬上限的 6 倍、有自己的拆分方案——**先拆后转**。

## 2. 收益（有事故记录，不是泛泛而谈）

`CHANGELOG.md` 里能数出 **10 条 `ReferenceError` / `is not a function` 类事故**，全部是 TS 编译期能报的：

- 接线时漏定义 `hideHtmlPreview` → 应用启动即崩（CHANGELOG:1561）
- `explorer-ops.js` 裸写 `newFileTypeMenuItems(...)`（真身在 `main.js`）→ 右键菜单打不开（:2286）
- `aiReferenceFileMenuItems` 裸引用（:2514）、`oo.render is not a function`（:2568）、`git-graph` 缺 `kvGetJson` 导入（commit 779e5d7）
- `deps` 缺 getter（`newFileTypeMenuItems`）、`splitRoot` 值快照——AGENTS 里两条教训的同一形状

第二类收益是 `deps` 的 576 个键：接口化之后少写一个 getter 就是编译错误，而不是运行期 undefined。
第三类：`TAB_KINDS` / `virtual-doc-wiring` 那套「文档 + 护栏对账」的接缝契约，类型是它的硬版本。

## 3. 三级台阶

### 阶梯 0（已落地）

| 文件 | 作用 |
| --- | --- |
| `scripts/gen-backend-types.mjs` | 生成器：名单取 `testdata/app_bindings_baseline.txt`，签名扫 Go 源码（根 `*.go` + `internal/**/*.go`，跳过 `_test.go`） |
| `frontend/src/types/backend.d.ts` | 产物：`export interface Backend`，420 个方法成员 |
| `frontend/tsconfig.check.json` | `strict` + `noEmit` + `checkJs: false`；`include` 覆盖 `src/**/*.js`，**按文件 `// @ts-check` 开启检查**（`jsconfig.json` 不动） |

生成口径：

- `ctx context.Context` 不出现（v3 由 Go 侧注入）；末位 `error` 不出现（reject），只 `error` 的返回映射 `Promise<void>`，多个非 error 返回值映射元组。
- Go 基础类型 → `string` / `number` / `boolean`；切片 → `T[]`（元素带联合时加括号，`[]*T` → `(T | null)[]`）；`map` → `Record`。具名结构体中**字段全为基础类型且无同名歧义**的（`GitOperationResult` / `PluginInfo` / `AISchedule`，登记在生成器的 `STRUCT_INTERFACES`）生成 interface；其余暂记 `unknown` 并留 `@go` 注释——有嵌套子类型（`SearchResult` / `PatchPreview`）或同名多版本（`LeaseStatus` 三个版本）的做全套解析器复杂度远超收益，且调用点都在未开 checkJs 的 `.js` 里，`unknown` 目前不产生任何误报。
- 平台成对文件优先取 `_windows.go`（本项目只发 Windows）；同名方法优先取接收者为 `App` 的那条，其余才算歧义。
- 当前覆盖：**420/420 全部有签名，精确 263、含 unknown 157、歧义 0、未找到 0**。

验证：

```bash
node scripts/gen-backend-types.mjs                 # 重新生成
node scripts/gen-backend-types.mjs --check         # CI 用：与仓库内容不一致则退出码 1
npm run -s typecheck                               # frontend/ 下；tsc -p tsconfig.check.json
```

**重新生成的时机**：后端任何改动绑定面的提交（`UPDATE_BINDINGS_BASELINE=1 go test -run TestAppBindingBaseline .` 后基线变了）之后必须重跑，否则类型与运行时脱节。

### 阶梯 1（已落地）

1. `frontend/package.json` 加 devDependency `typescript` 与 `"typecheck": "tsc -p tsconfig.check.json"`（只进 node_modules，**不进 dist、不进 exe**——类型全被擦除，`dist` 仍 15 MB）。
2. `npm test` 前置 `typecheck`（**不挂进门的类型会烂掉**）：`npm run -s typecheck && test:ai && test:ui-core && test:ui-shell && test:maven`。
3. 新文件以后可直接写 `.ts`：`jsconfig.json` 保持 `allowJs` / `checkJs: false`，TS 从 `.js` 模块体推断类型，`.ts` 可以 import 老 `.js`——渐进迁移能成立的关键。
4. **已开 `// @ts-check` 的 core 文件（24 个，strict 下零错误）**：
   - 首批 13 个：`escape` / `dom` / `json-safe` / `id` / `readonly` / `clipboard` / `render-cache` / `notify-throttle` / `humanize` / `popover-position` / `kv-store` / `tab-kinds` / `virtual-tab-doc`
   - 第二批 11 个纯函数模块：`diff` / `jsonrepair` / `jsonschema` / `keymap` / `event-scope` / `activity-log` / `app-pages` / `shift-double-tap` / `scratch` / `editor-keybindings` / `overlay-stack`
5. 待办：定 Node 下限（≥22.18，存量迁移后测试链才能继续裸跑 `node --test`）或给测试引 `tsx`。**这一条需要作者拍板**。

开检查的顺序建议：先把**有单测的纯函数模块**开完（`formats` / `diff` / `jsonpath` / `jsonrepair` / `jsonschema` / `keymap` / `event-scope` / `activity-log` / `app-pages` / `overlay-stack`…），再碰 DOM 重、状态多的文件。每个文件的开销主要在补 JSDoc（`noImplicitAny`）与把 `object` 型参数收窄成真形状。

### 阶梯 2（按域换后缀，一个目录一批）

顺序按「纯逻辑多、DOM 少」→「DOM 重、状态多」：

1. `core/`（48 文件，252 个小文件里大半在这）——先给 `deps` 型模块写 3–5 个接口：`Deps` / `Settings` / `AppState`。
2. `bridge/`、`settings/`、`shell/`、`terminal/`、`db/`、`reading/`、`explorer/`、`git-graph/`、`maven/`、`writing/`
3. `editor/`（29 文件，`editor-groups.js` 2104 行，受前端拆分批次影响，排在后面）

每批的验收：`tsc -p tsconfig.types.json --noEmit` 零错误、`npm test` 全绿、`npm run build` 产物 diff 只有哈希变化。
**目录内后缀必须一致**（不要同一个目录一半 `.js` 一半 `.ts`），因为 Node ESM 与 Vite 对显式后缀的要求不同。

### 阶梯 3（ai 域，最后一个）

`ai/` 117 文件，其中 `ai-panel.js` 19,474 行必须**先按既有拆分方案拆完再迁**。迁移前先把 `backend.d.ts` 里 175 个 `unknown` 的返回值补成真 interface（从 Go 结构体生成），否则 ai 域大量 `await backend.X()` 的结果仍是 `unknown`。

## 4. 不变式（迁移期间别破的规矩）

- **不改产物体积**：类型擦除，`dist`（当前 15 MB）与 exe 一个字节不变；`typescript` 只进 devDependencies。
- **不写 `@ts-nocheck` 逃逸**：真需要豁免就按现有护栏的样式做「按文件基线、只减不增」（参考 `frontend/test/core/icon-guard.test.mjs` 的基线机制），否则一个文件一句就把护栏废了。
- **护栏跟着改后缀**：`icon-guard`、`form-controls-factory`、`no-src-tests`、`outside-click-guard`、`utility-duplication-guard` 都按 `.js` 后缀扫 `src`（如 `frontend/test/core/icon-guard.test.mjs:59`），迁移某目录时同批加 `.ts` / `.tsx`。
- **`.d.ts` 不撒谎**：类型只写在有测试或护栏覆盖的行为上；类型与运行时不符比没有类型更贵。
- **`backend.d.ts` 永不手改**：要改就改 Go、改基线、改生成器。

## 5. 决议（2026-11-24）

1. **换后缀暂缓，checkJs 作为当前终态**：24 个 core 文件开 `@ts-check` 后，`npm test` 门已能拦住历史上那 10 条 `ReferenceError` 类事故；换后缀要动 246 处测试 import + 5 个按 `.js` 扫描的护栏，而类型全在构建期擦除、对单 exe 产物零影响，性价比不足。真需要复杂泛型时再重评。
2. **Node 下限**：若将来换后缀，抬到 22.18+（Node 只是 dev 工具，用户跑 exe 不需要；约束只在 `AGENTS.md` / `README.md` 两行文档），**不引 `tsx`**（纯新增依赖）。当前不换后缀，故暂不改文档。
3. **`--check` 已挂测试门**：`tools/rebuild-exe.ps1` 在 Go 测试后、前端测试前跑 `node scripts/gen-backend-types.mjs --check`，失败计入「绑定类型」走同一套失败摘要与强行构建流程。
4. **unknown 按需补**：已补 3 个无歧义结构体（精确 245→263、unknown 175→157）；嵌套子类型与同名多版本的保持 unknown（理由见阶梯 0 生成口径）。
