# 仓库结构治理（杂物清理 + 前端模块化）实施计划

> 状态：待实施
> 范围：阶段 0–3（仓库卫生、`ai-*` 归目录、`main.js` / `ai-panel.js` 拆分）；Go 拆包明确暂缓（§5）
> 版本号：不变更（纯结构与卫生，无用户可见功能变化）
> 决策依据：2026-11-13 对外部结构批评的评估结论——临时文件混入成立立刻修；Go 扁平是已记录的取舍暂缓；前端主要矛盾是两个万行单体而非 36 个文件平铺

## 1. 背景

外部批评两点：根目录过载（Go 文件 + 临时/二进制文件混放）、`frontend/src` 平铺。实测核对：

- 根目录 111 个 `.go`（约 70 源 + 40 测试，2.56 万行）；`datalens.exe` 已被 gitignore；真正未清理的是 `nul` 与 `autoapprove-probe.md`（均 untracked）。
- `frontend/src` 36 个平铺文件共 4.29 万行，其中 `main.js` 19,633 行 + `ai-panel.js` 14,895 行占 80%。其余文件最大仅 1,898 行，平铺本身不构成主要问题。
- 批评建议的 `src/tests/` 集中测试**不采纳**：`.test.mjs` 与源码同目录是本仓库既有实践，移走只增加 import 路径长度、改名时测试失联。

## 2. 目标与非目标

### 目标

- 阶段 0：清掉 `nul`、`autoapprove-probe.md`，补 `.gitignore` 防复发。
- 阶段 1：`ai-*` 前端文件（8 源 + 7 测试）归入 `src/ai/`，沿用 `reading/` 先例。
- 阶段 2：`main.js` 按域分 7 批抽出，保留组合根职责。
- 阶段 3：`ai-panel.js` 抽出可独立演进的子模块。
- 全程 0 新依赖、不改任何运行时行为、每批可独立提交与回滚。

### 非目标（明确不做）

- 不做 Go 根目录拆包（暂缓理由见 §5）。
- 不建 `src/tests/`、`src/lib/`、`src/features/` 等空目录层；不引入框架/状态库。
- 不改打包方式（仍 Vite 单入口），不动 `frontend/wailsjs/` 与 `frontend/dist/`。
- 不追求把 `main.js` 拆到 0 行：前 3,435 行核心枢纽（标签页、编辑器、菜单、设置骨架、CSV 表格、Markdown 预览）保留在 `main.js`。

## 3. 阶段 0：杂物清理（约 10 分钟）

| 项 | 动作 |
| --- | --- |
| `nul` | Windows 保留设备名误产物（untracked），普通 `del nul` 删不掉；用 `cmd //c del "\\?\D:\OraSkyC\Project\CandySweet\CaDt-DataLens\nul"` |
| `autoapprove-probe.md` | 一次性复测记录（untracked，内容为自动审批第 2 轮结果），直接删除；如作者想留档自行移入 `docs/` |
| `.gitignore` | 追加 `/nul` 与 `/*.exe~`（现仅有 `/datalens.exe~`，防 `CaDt-DataLens-dev.exe~` 类产物复发） |
| 根目录 `datalens.exe` | 已被 gitignore 的本地构建/自更新产物，**保持现状不动** |

验证：`git status` 无上述 untracked 项；资源管理器根目录无残留。

## 4. 阶段 1：`ai-*` 归入 `src/ai/`

### 移动清单（`git mv` 保留历史）

- 源 8：`ai-panel.js`、`ai-session-store.js`、`ai-command-rules.js`、`ai-git.js`、`ai-app-message.js`、`ai-tool-args.js`、`ai-permissions.js`、`ai-config-model.js`
- 测试 7：对应 `.test.mjs`（`ai-panel.js` 无独立测试）
- 全部移至 `frontend/src/ai/`，测试继续与源码同目录。

### 引用更新点

1. `frontend/package.json` test script：`src/ai-xxx` → `src/ai/ai-xxx`（10 个路径）。
2. `main.js:15`：`'./ai-panel.js'` → `'./ai/ai-panel.js'`。
3. `src/ai/*` 内部对共享模块的引用加 `../` 前缀（已定位：`icons.js`、`contextmenu.js`、`image-clipboard.js`、`image-lightbox.js`、`fileicons.js`；以移动后 `npm run build` 报错为准全量修齐）。
4. `ai-*` 之间的相对引用同目录平移，不变。
5. `writing.js:2` 注释提到 `ai-command-rules.test.mjs`，仅注释，顺手同步路径。

### 已确认无影响面

- `plugins/` 样例不 import 任何 `src/` 路径（已验证 scene-carousel）。
- `index.html` 不直接引用 `ai-*` 文件；`frontend/wailsjs/` 与此无关。

### 验证

`cd frontend && npm test`（node --test 全绿）→ `npm run build` → `wails build -devtools` 冒烟 AI 面板（新建会话、发一轮消息）。

## 5. 暂缓项：Go 根目录拆包（记录不做的理由）

- 扁平根包是 AGENTS.md 记录在案的设计；文件按前缀分组（`ai_*`、`browser_*`、`reading_*`、`session*`），`*_windows.go`/`*_other.go` 成对平铺，AGENTS.md 已充当目录地图。
- 几乎全部逻辑挂在 `*App` 方法上，Wails 绑定自 App 结构体生成；拆包需 facade 化重构约 70 个源文件，收益仅为导航性，成本/风险不成比例。
- 触发条件（满足其一时重启本节）：单包超过 4 万行；或某域（如 sessionstore/activity）需要被独立复用。届时叶子优先：`sessionstore*` → `internal/sessionstore`、`activity*` → `internal/activity`、`pathinfo`、`logging`。

## 6. 阶段 2：拆 `main.js`（主线）

### 现状锚点

- 19,633 行、699 个顶层定义、约 175 个模块级状态变量、11 处 `// =====` 分节注释。
- 仓库已有成熟抽取模式：factory + 依赖注入（`createExplorer` / `createPalette` / `createAIPanel` / `createReadingMode`），新模块照此办理，不引入全局单例。

### 批次（由小到大、由低耦合到高耦合，每批独立提交）

| 批 | 行段锚点 | 内容 | 目标文件 | 规模 |
| --- | --- | --- | --- | --- |
| B6 | 18429–18601 | Win11/系统光标候选 | `cursor-themes.js` | ~170 行 |
| B8 | 19220–19633 | 进程桥/虚拟文档、浏览器标签页、git 浅集成 | `bridge-ui.js`（或按 3 域拆小） | ~415 行 |
| B7 | 18602–19219 | 内置终端 | `terminal-ui.js` | ~620 行 |
| B1 | 3436–4320 | 操作留痕 UI（设置页 + 事件桥） | 并入现有 `activity-log.js` 或新建 `activity-ui.js` | ~890 行 |
| B4 | 12776–14625 | 标题栏弹层：项目选择 + Git 分支 | `titlebar-popovers.js` | ~1,850 行 |
| B2 | 4321–6930 | 写作模式 UI | `writing-ui.js`（排版纯逻辑已在 `writing.js`） | ~2,610 行 |
| B3 | 6931–12775 | 编辑器分栏（编辑器组 + 二叉分割树） | `editor-groups.js` | ~5,845 行，最大，最后做 |

行段以实施时实际 grep 为准；分节注释之间的隐式段落（设置对话框、CSV 表格、Markdown 预览，位于 0–3435 与 14626–18428 区间内）本阶段不动，留作后续独立批次，避免单批过大。

### 约束

- 每批：纯移动 + 改 import + 显式注入依赖（DOM 引用、状态 getter/setter 经 ctx 对象传入），函数体不改写。
- 模块级状态（~175 个）是主要风险：被抽域涉及的状态随域走或经 ctx 注入；禁止新增全局、禁止循环 import。B3 与核心标签页状态交叠最深，放最后，动手前先产出状态归属清单。
- 提交信息统一 `refactor(frontend): 拆出 <域>`，便于单批 revert。

### 验证（每批必做）

`npm test` → `npm run build` → `wails build -devtools` → 定向冒烟（如 B7 开内置终端执行一条命令；B3 双栏分割/拖拽/合并）+ 通用冒烟（开 3 种格式标签、切主题、设置保存）。

## 7. 阶段 3：拆 `ai-panel.js`

- 现状：14,895 行，顶层仅 20 个定义（多为常量与 localStorage key），约 498 个函数全部在 `createAIPanel` 闭包内。
- 策略：不动闭包骨架，按域把成组的渲染/纯逻辑抽为 `src/ai/` 内兄弟模块（以 ctx 传入）。实施时先产出闭包函数地图再定批次；候选：流式渲染与消息列表、工具卡片、子代理卡片、定时任务 UI、Git 快捷操作 UI、会话列表/侧栏、输入区与附件。
- 常量随首个使用它们的模块走，或集中 `ai-constants.js`。
- 验证同阶段 2，AI 域冒烟另加：新建会话、工具审批卡、spawn_agent 卡片、定时任务触发一次。

## 8. 文档同步

- AGENTS.md「目录结构」节：阶段 1 完成后同步 `src/ai/`，阶段 2/3 逐批补新模块清单。
- CHANGELOG.md 记一条结构整理（对贡献者/插件作者可见）。
- 全部实施后本方案移入 `docs/finished-plans/`。

## 9. 风险与回滚

- 每批独立提交，`git revert` 单批可回。
- 最大风险是运行时未定义变量（构建不报、运行才炸）：冒烟按批次域定向覆盖；抽取域时先 grep 该域函数对模块级状态的引用。
- 阶段 1 纯机械移动，风险最低，先行交付可立刻验证流程。
