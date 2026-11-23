# 前端拆分第四阶段：ai-panel.js 与 main.js

> 状态：**阶段一 + M1 + M2 已实施并验证通过；P1 跳过；P2–P4 / M3–M7 待办**（2026-11-24）。本文件既是交接文档，也是本轮实施记录。
> 用户裁定范围（2026-11-23 补充）：**本轮分两阶段串行执行——阶段一：ai/ 目录全量重组（117 文件按域归位 + 测试目录镜像 + 护栏/文档同步）；阶段二：两个低风险试点批（P1 / M1）**。验证采用完整档（静态裸引用扫描 + npm test 全量 + npm run build + 定向冒烟）。阶段二试点完成并验证通过后停下汇报，再决定是否继续后续批次（P2–P4 / M2–M7）。
> 决策依据：phase2/phase3 已建立成熟的 deps 重写 + 分批验证方法论，但明确把这两个文件推迟（「ai-panel 交子代理消息化方案」「main.js 组合根不动」）。本次两份只读调研（ai-panel 19,636 行 / main.js 7,688 行全文逐段读取）确认：可安全拆的叶子块有限，真正的大头被密集测试护栏与硬约束锁死。
> 前置阅读：`docs/finished-plans/frontend-split-phase2.md`（抽取模式与 tokenizer 三坑）、`docs/finished-plans/frontend-split-phase3.md`（目录归位与多域解耦）、`AGENTS.md`（代码规模与质量红线、AI 工具增删改、app_control 三处对齐）。
> 原则：函数体逐字搬移（main.js 系需 tokenizer 重写裸标识符为 deps.X）；每批独立提交、独立验证、可单独 revert；0 新依赖。
>
> **⚠️ 行号全部是 2026-11-24 调研锚点，必然随功能提交漂移。每批动手前必须 grep 重新定位，不要照搬本文行号。**

---

## 0. 给接手会话的导读

0. **先做阶段一（见下方「阶段一：ai/ 目录全量重组」章节）**：ai/ 目录全量重组必须先完成并全绿，才开始阶段二的函数体拆分——目录归位会改变所有 import 路径与测试清单，若与拆分叠加会放大冲突面。
1. **再读第 2 节约束**，尤其是「必须留在主文件」的硬约束和第 2.4 节测试锚点类型——这是所有拆分的边界。
2. **严格串行**：阶段一完成并提交后，才做 P1；P1 完成全部验证并提交后，才开始 M1。每批一个 commit：`refactor(frontend): <模块名>`。
3. **每批固定验证流程见第 7 节**，一步都不能省（尤其对照验证，防止扫描脚本静默失效）。
4. **预期管理**：即使路线图里所有安全批次做完，`ai-panel.js` 仍会远超 3000 行——executeTool 工具分发（~2000 行）、流式核心（~2100 行）、配置/会话持久化中心（~2270 行）三块合计 6,000+ 行被硬约束禁止搬迁。拆分目标是「持续降低、每批可回滚」，不是「本轮达标」。
5. **禁止 git checkout / git restore**（AGENTS.md 硬规则）；失败回滚用编辑工具反向改或 git stash。

---

## 阶段一：ai/ 目录全量重组（117 文件按域归位 + 测试镜像）

> 本阶段先于函数体拆分执行。目标：`frontend/src/ai/` 下 117 个文件按域进子目录，`frontend/test/ai/` 测试目录镜像对应，全部 import / 护栏 / 测试清单 / 文档路径同步更新。**不改变任何函数体**，只移动文件位置与修正路径。

### 阶段一·1 依赖图实测（只读分析已完成）

用一次性脚本 `.cadt/tmp/ai-dep-graph.mjs` 扫描 `frontend/src/**/*.js` 的 import 说明符得到：

- 117 个 AI 文件、**260 条内部依赖边、0 个循环依赖**（Tarjan SCC 全为单点）→ 目录移动可安全分批。
- 外部入口仅 20 处：`main.js` 17、`settings/settings-pane-external-tools.js` 2、`editor/structure.js` 1。
- 测试面：`frontend/test/ai/` 下约 93 个文件引用 `../../src/ai/...`；`package.json` 的 `test:ai` 硬编码 100+ 条路径。
- 护栏内 9 处硬编码 `src/ai/` 路径需同步（见阶段一·3）。
- 超级节点：`ai-panel.js` 内部出度 85（几乎 import 所有域）、`ai-constants.js` 入度 43（被最多文件依赖）—— import 重写围绕它们设计；`ai-panel.js` 留 `ai/` 根不移动。

### 阶段一·2 分组映射（117 文件全归位）

11 个落点（10 子目录 + `ai/` 根保留组合根）。执行第一步自检映射覆盖 `list_dir frontend/src/ai/` 全部 117 文件（无遗漏、无重复）；各域内部保持平铺，不再建更深层目录。

| 目标目录 | 归入文件 |
|---|---|
| `ai/`（根，不移动） | `ai-panel.js`（阶段二 P1 在此改函数体，新模块落 `ai/session/`） |
| `ai/core/` | `ai-constants.js`、`ai-config-model.js`、`ai-persona.js`、`ai-personalization-ui.js`、`ai-system-context.js`、`ai-system-takeover.js`、`model-catalog.js`、`ai-provider-icons.js`、`ai-mascot-phrases.js`、`ai-plan-file.js`、`ai-notify-policy.js` |
| `ai/agent/` | `ai-agent-model.js`、`ai-agent-tree.js`、`ai-agent-view.js`、`ai-agent-notices.js`、`ai-agent-settings.js`、`ai-subagents.js`、`ai-head-hud.js`、`ai-monitor-view.js` |
| `ai/chat/` | `ai-composer.js`、`ai-message-queue.js`、`ai-compact.js`、`ai-context-slim.js`、`ai-quote.js`、`ai-paste.js`、`ai-slash.js`、`ai-scroll-follow.js`、`ai-auto-collapse.js`、`ai-always-collapse.js`、`ai-stream-retry.js`、`ai-truncation.js`、`ai-turn-reminder.js`、`ai-todos.js`、`ai-reminders.js`、`ai-inbox-wait.js`、`ai-takeover.js`、`ai-ask-cards.js`、`ai-patch-card.js`、`ai-changes-ui.js`、`ai-diff-view.js`、`ai-inline-edit.js`、`ai-sidechat.js`、`ai-layout-motion.js`、`ai-loop-guard.js` |
| `ai/settings/` | `ai-settings-dialog.js`、`ai-model-settings.js`、`ai-preference-settings.js`、`ai-settings-io.js`、`ai-model-picker.js`、`ai-manage-dialogs.js`、`ai-schedule.js`、`ai-timer.js`、`ai-cognition.js`、`ai-cognition-page.js` |
| `ai/tools/` | `ai-tool-defs.js`、`ai-tool-cards.js`、`ai-tool-args.js`、`ai-tool-schedule.js`、`ai-terminal-tools.js`、`ai-browser-tools.js`、`ai-file-tools.js`、`ai-file-refs.js`、`ai-image-encode.js`、`ai-image-policy.js`、`ai-audio-transcode.js`、`ai-worktree.js`、`ai-git.js`、`ai-git-ui.js`、`ai-mcp.js`、`ai-mcp-config.js`、`ai-mcp-settings.js`、`ai-external-tools.js`、`ai-desktop-control.js`、`ai-path-hints.js`、`ai-search-advanced.js` |
| `ai/security/`（新增域） | `ai-permissions.js`、`ai-permission-settings.js`、`ai-command-rules.js`、`ai-local-classifier.js`、`local-classifier-weights.mjs`、`ai-classifier-verdict.js`、`ai-scope-redact.js`、`ai-wipeguard.js`、`ai-write-guard.js`、`ai-sandbox-grant.js`、`ai-read-roots.js`、`ai-app-approval.js`、`ai-action-approval-card.js`、`ai-app-message.js`、`ai-patch-policy.js`、`ai-patch-error.js` |
| `ai/session/` | `ai-session-store.js`、`ai-session-disk.js`、`ai-session-fork.js`、`ai-session-list.js`、`ai-session-scope.js`、`ai-session-send.js`、`ai-session-tools.js`、`session-outline.js`（阶段二 P1 新模块 `ai-session-log.js` 也落此目录） |
| `ai/group/` | `ai-group-model.js`、`ai-group-runtime.js`、`ai-group-store.js`、`ai-group-tools.js`、`ai-group-ui-model.js`、`ai-group-view.js`、`ai-group-sidebar.js`、`ai-group-member-view.js`、`ai-team-model.js`、`ai-team-view.js` |
| `ai/gen/` | `ai-gen-model.js`、`ai-gen-jobs.js`、`ai-gen-settings.js` |
| `ai/usage/` | `ai-usage-ui.js`、`ai-usage-quota.js`、`ai-usage-templates.js`、`ai-usage-config-dialog.js` |

### 阶段一·3 迁移机制（脚本 `scripts/migrate-ai-layout.mjs`）

一次性工具，输入上节映射表，做五件事：

1. **`git mv` 移动源码**：`frontend/src/ai/xxx.js` → `frontend/src/ai/<域>/xxx.js`，保留 git 历史。
2. **全仓重写 import 说明符**：扫 `frontend/src/**/*.js`、`frontend/test/**/*.mjs`、`dev/mock-backend.js`、`.cadt/` 相关脚本；正则覆盖 `from './xxx'`、`from '../ai/xxx'`、`import('./xxx')`、多行 import；按旧 basename 查映射表替换目录前缀，**只改解析出的模块说明符，不盲改字符串**。
3. **更新护栏硬编码路径（9 处，逐处 `read_file` 后精准替换）**：
   - `test/core/form-controls-factory.test.mjs` BASELINE（约 :115–128，10 条 `src/ai/xxx`）；
   - `test/core/icon-guard.test.mjs`（约 :36 `ai/ai-provider-icons.js`）；
   - `test/core/module-scope.test.mjs`：HOSTS（约 :92–152，5 组 `ai/` 路径）+ 3 处动态 import URL `../../src/ai/...`；
   - `test/core/outside-click-guard.test.mjs`（约 :28–30，3 条）；
   - `test/core/overlay-esc-guard.test.mjs`（约 :26–28，2 条）；
   - `test/core/utility-duplication-guard.test.mjs`（约 :36 `ai/ai-persona.js`）；
   - `test/core/widget.test.mjs`（约 :330 `../../src/ai/ai-tool-cards.js`）；
   - `window-close-semantics.test.mjs` / `activity-log.test.mjs` 引用 `ai-panel.js`（留根，路径不变，仅核对）。
4. **测试目录镜像**：`git mv test/ai/xxx.test.mjs` → `test/ai/<域>/xxx.test.mjs`；同步重写 `package.json` 的 `test:ai` 100+ 条路径（`test-manifest.test.mjs` 双向核对，漏改即红）。非 AI 测试里引用 `src/ai/` 的（`test/core/*`、`test/settings/*`、`test/shell/*`、`test/editor/*`）由第 2 步统一重写。
5. **文档与认知索引**：`AGENTS.md`、`docs/` 内的 `frontend/src/ai/xxx.js` 路径按映射更新；`cognition_read` 核对 `frontend/src/ai/` 条目，`cognition_edit` 更新 F/R/A/S 中的路径。

### 阶段一·4 分批与验证节奏（0 环，按叶子→核心）

- 批 1：`gen/`、`usage/`、`session/`、`group/` → `npm run test:ai`；
- 批 2：`agent/`、`tools/` → `npm run test:ai`；
- 批 3：`settings/`、`security/`、`core/` → `npm run test:ai`；
- 批 4：`chat/` + `ai-panel.js` 的 95 条 import 修正（函数体不动）→ `npm run test:ai` + `npm run build`。

每批前 `git status` 留快照；红则就地修复再进下一批。阶段一收口跑 `npm test` 全量 + `npm run build`，全绿后才进入阶段二。迁移后重跑 `.cadt/tmp/ai-dep-graph.mjs`（适配新目录），确认内部边仍无环、无悬空 import。

---

## 1. 目标与背景

`frontend/src/ai/ai-panel.js` 19,636 行（3000 行红线的 6.5 倍）、`frontend/src/main.js` 7,688 行（2.5 倍），两者都是活跃改动热点。AGENTS.md 已把 style.css 列为行数豁免，但这两个 JS 文件不豁免，且是历次带病提交的高风险区。

本方案把它们拆成「factory + 显式 deps 注入」的域模块，沿用 explorer-ops / editor-groups / ai-subagents 等已验证的拆分范式。

---

## 2. 现状与约束

### 2.1 ai-panel.js 结构（实测 19,636 行 / 1,096,839 字节）

- 结构：`// 顶部 1–9 职责注释` → `let permissionLifecycleHook`（:6）+ `export function setPermissionLifecycleHook`（:7–9）→ **95 条顶层 import**（:10–327）→ **唯一大工厂 `export function createAIPanel(options)`（:329–19636）**。
- 工厂体内：**579 个 4 空格缩进的 function/async function**、**39 个 `const xxx = createXxx(...)` 兄弟模块工厂**、**52 处 `// ---------- xxx ----------` 分节注释**、`return {...}` 在 :19171–19635。
- 只有 2 个 export：`:7 setPermissionLifecycleHook`、`:329 createAIPanel`。**无其他具名导出**。
- 唯一 import 点：`frontend/src/main.js:33` `import {createAIPanel} from '../../frontend/src/ai/ai-panel.js';`。全仓无第二处。
- **工厂 + deps 注入模式（双重）**：
  1. 主工厂 `createAIPanel(options)` 把 opts 解包成约 60 个注入能力（:330–484），典型 `typeof opts.X === 'function' ? ... : noop` 兜底。
  2. 39 个内部兄弟模块工厂全部 factory + 显式 deps 注入；let 状态经 **58 处 getter/setter** 传活引用（例 `getStream: () => stream` :18470、`getDismissedPlanApproval`/`setDismissedPlanApproval` :18468-18469）；互引模块用惰性箭头转发解环（:18359、:18369-18372、:18295-18296）。
- **新拆模块必须沿用这套模式**；main.js 不要直接 import 新模块（保持「组合根只认 aiPanel 单例」和测试对 `aiPanel.*` 的锚定）。

### 2.2 ai-panel.js 52 个分节（调研锚点）

| 起 | 分节 | 止（下一节前） |
|---|---|---|
| 910 | 配置与会话持久化 | 1965 |
| 1966 | 懒加载会话 | 2061 |
| 2062 | 存储模式与会话加载 | 2618 |
| 2619 | 会话级流注册表 | 2670 |
| 2671 | 多实例回合租约 | 2733 |
| 2734 | 多实例：当前会话的目录 watch | 2858 |
| 2859 | 每会话系统提示词缓存 | 2896 |
| 2897 | 会话级模型 | 3178 |
| 3179 | 面板基础渲染 | 3188 |
| 3189 | 会话视图宿主 | 3259 |
| 3260 | Todolist / 变更记录 / 授权清单 | 4247 |
| 4248 | 渲染目标（多宿主） | 4306 |
| 4307 | 支线对话标签页的桥 | 4624 |
| 4625 | 中断回合横幅 | 4942 |
| 4943 | 文件引用链接 | 6027 |
| 6028 | 用量 UI 域（阶段 3 拆出 ai-usage-ui.js） | 6068 |
| 6069 | 结构面板的「会话结构」 | 6228 |
| 6229 | 上下文估算 | 6554 |
| 6555 | Composer 统计行 / 上下文弹层 | 6690 |
| 6691 | 路径 / 记忆 / 技能 | 6721 |
| 6722 | 计划落盘 | 7299 |
| 7300 | 外部工具来源 | 7469 |
| 7470 | 浏览器使用 | 7571 |
| 7572 | 行 diff 与写审批 | 7832 |
| 7833 | 后台命令 | 7947 |
| 7948 | Git 快捷操作一次性窄豁免 | 8182 |
| 8183 | 自动审批分类器 | 8630 |
| 8631 | env_create | 9259 |
| 9260 | session_history | 9597 |
| 9598 | 生图/视频 | 9857 |
| 9858 | MCP 配置桥 | 10077 |
| — | **executeTool / executeToolInner（无分节注释，:10062–12062）** | — |
| 12069 | 流式对话 | 13648 |
| 13649 | 思考循环守卫 | 14176 |
| 14177 | 范围与附加内容 | 14229 |
| 14230 | 桌面控制 | 14787 |
| 14788 | 双层级模型选择器 | 15165 |
| 15166 | 常用消息操作 | 15189 |
| 15190 | 输入框右键编辑菜单 | 15467 |
| 15468 | 用户消息原地编辑 | 15942 |
| 15943 | 会话管理 | 16539 |
| 16540 | 对话日志 | 16678 |
| 16679 | 管理对话框 / 提示词 / 记忆 / 技能 | 17336 |
| 17337 | 内容视图：会话 \| 群聊 | 17410 |
| 17411 | 显示方式与几何 | 17489 |
| 17490 | 悬浮窗专用 | 17726 |
| 17727 | 停靠分屏左右互换 | 17801 |
| 17802 | 设置页（空节） | 17804 |
| 17805 | 绑定面板交互 | 18166 |
| 18167 | 底部 composer 接管 | 18215 |
| 18216 | 补丁审批 | 18484 |
| 18485 | 信箱胶囊 | 18599 |
| 18600 | 初始化 | 19635（return 在 19171） |

### 2.3 main.js 结构（实测 7,688 行 / 382.5 KB）

- **无 export 的顶层入口脚本**（`^export` 零命中），靠 `window.__lens` 等全局对象对外暴露能力。
- 顶部约 120 条 import（:1–125），绝大多数域 UI 已下沉为 `createXxx(deps)` 工厂（settings-ui :2806、writing-ui :2876、editor-groups :2944、explorer-ops :3205、terminal-ui :7444、bridge-ui :7508 等）。
- 启动靠**执行顺序**编排，无 DOMContentLoaded / init() 入口。
- **组合根不可动锚点**：
  1. Wails 引导与事件桥：`await loadWailsRuntime()`(:149)、`createRuntimeAdapter/createBackendProxy`(:157-158)、`window.go = {main:{App:backend}}`(:168)、`createAppEventBridge`(:175)、`setAppEventBridge`(:182)。由 `test/core/event-bridge-guard.test.mjs:26-39` 守卫。
  2. 全局监听：`overlayStack.install(window)`(:129，必须最早)、`createDialogDrag().install`(:133)、`window error/unhandledrejection`(:138,437,443)、拖拽(:7189)、document copy/cut(:6843,6851)、全局 keydown/keyup(:6860,7178,7415)。
  3. appPageMounters 注入：定义 :5556-5573，注入 bridgeUI :7510（含 `initAIPanel()` 兜底 :5561,5566）。
  4. VIRTUAL_TAB_VIEWS 分派：分派表在 `editor/editor-groups.js:173/1430`（**不在 main.js**）；main.js 只经 deps 注入各 createXxxView 工厂(:2973-2980)，由 `test/editor/virtual-doc-wiring.test.mjs` 逐点对账。
  5. 启动顺序：`applySettings()` 必须在 terminalMod 解构后、bridgeUI 前（:7494-7496）；memo 早期 let 间接层(:186-197) 与真钩子回填(:7675-7680) 的 TDZ 规避链不能改成直接引用。
  6. 早期 hook 间接层：`dbSidebarRenderHook/mavenSidebarRenderHook`(:193,195)、`memo*Hook`(:189-192) 因「建得晚」必须留组合根。
  7. 全局事件订阅集中区：:4801-4877（ai-* 事件循环）、:7197-7253（window/workspace/app）、:7351-7391（term-out/exit/cmd-out/exit）——跨模块扇出，留组合根。
  8. `window.__lens` 活引用 getter(:2368-2386)：注释明确「函数拆到域模块后经 const 解构引入，必须用 getter 延迟求值，否则 TDZ」。
- 菜单注册表(:6232-6785) 与全局快捷键(:6843-7174) 本质是组合根接线，下沉收益低风险高，**不建议拆**。

### 2.4 测试耦合（拆分最大的隐性成本）

- **38 个测试文件**读取 ai-panel.js 源码文本断言；**40+ 个**读 main.js。全部登记在 `frontend/package.json` 的 test 脚本清单。
- 三类脆弱锚点（拆走被锚定函数即红）：
  1. **全文 includes/match**：如 `ai-notify-policy.test.mjs:113-116` 用 `/return \{\s*\n\s*toggle,/` 锚定顶层 return；`ai-config-model.test.mjs:358,374` 钉 `case 'ai-param-adjust':` 与各流式 case 必须在 ai-panel.js。
  2. **按 4 空格函数签名切片**：`ai-tool-wiring.test.mjs:33-47` 切 executeTool/executeToolInner；`ai-session-ui-sync.test.mjs:18-24` 切 syncActiveSessionUI；`ai-turn-steer-wiring.test.mjs:205-210` 切 buildApiMessages；`ai-tool-cards.test.mjs:110-118` 切 refreshToolWrap。**函数搬到新文件 → 切片返回空 → 直接红**。
  3. **出现次数精确计数**：`ai-panel-mode-lock.test.mjs:24` 钉 `setMode(` 恰好 5 次；`ai-composer-submit-guard.test.mjs:69-70` 钉 `el.input.addEventListener('keydown'` 恰好 1 次；`ai-tool-cards.test.mjs:160-161` 钉 `toolHalted(` ≥6 次。
- 处理方式只有两种：① 被锚定函数留守主文件；② 同步改测试的 `read(...)` 路径（**新增测试文件必须登记 `frontend/package.json` 清单**，见 `test-manifest.test.mjs:38-50`）。

### 2.5 必须留在 ai-panel.js 主文件的硬约束

| # | 约束 | 出处 |
|---|---|---|
| 1 | executeToolInner 所有 `case '<工具名>'` 必须在 ai-panel.js；executeTool 只是生命周期包装层（pre/post-tool-use 钩子） | AGENTS.md:98；ai-panel.js:10057-10076、:10078；ai-tool-wiring.test.mjs:10,46-47,172-177 |
| 2 | 执行分支外移须登记 ai-tool-wiring.test.mjs 的 `EXECUTED_ELSEWHERE` 并写原因（当前为空对象） | AGENTS.md:99；测试 :26-28 |
| 3 | app_control 动作四处对齐：ai-constants.js 技能动作表 + main.js APP_ACTIONS + main.js runAppAction switch + ai-panel.js MCP_CONFIG_ACTIONS | AGENTS.md:123-126；ai-panel.js:9861,10936-11031；ai-app-actions.test.mjs:3-8,73-91 |
| 4 | app_control 分支里的 request_desktop_control、memo/bookmark/click/set_setting_row 计划模式拦截、open_browser_tab 读权限链、screenshot 图片回注、browserTabId 共享，都依赖主闭包 pendingApprovals/session/persistSessions（注释 :10967-10968 明说「执行体在本闭包内，故不进 runAppAction 的 switch」） | ai-panel.js:10941-11029 |
| 5 | permissionLifecycleHook 模块级单例 + setPermissionLifecycleHook 导出（多实例会互相覆盖，是当前单例硬约束的一部分） | ai-panel.js:6-9,424,7692-7698 |
| 6 | `#ai-panel` 单例（不做面板多实例，42 处 CSS 选择器） | AGENTS.md:154；side-chat-tab.md:59,109 |
| 7 | 形态只由用户手势改；setMode 出现次数 5；无标题栏 dblclick | ai-panel-mode-lock.test.mjs:1-25 |
| 8 | 顶层 return 以 `toggle,` 开头且导出 switchSession | ai-notify-policy.test.mjs:113-116；main.js:4253 |
| 9 | 输入框 keydown 只绑定一处且为固定包装层 | ai-composer-submit-guard.test.mjs:67-72 |
| 10 | syncActiveSessionUI 必须含 9 项 chrome 刷新；6 条路径必须调它；switchSession 不得手写清单（历史事故） | ai-session-ui-sync.test.mjs:26-59 |
| 11 | plan_mode 按 ctx.session 改、setPlanMode 四参、非当前会话早退 | ai-session-ui-sync.test.mjs:61-80 |
| 12 | 流式事件 case 'ai-chunk'/'ai-think'/... 必须在 ai-panel.js | ai-config-model.test.mjs:363-375（对 Go internal/aitransport/types.go 逐事件核对） |
| 13 | 配置/会话持久化中心、流式核心、session_history、面板几何/初始化留守（循环依赖 / 注入面过大） | side-chat-tab.md:311-319；session-messaging.md:372,389 |
| 14 | 新模块必须 factory + 显式 deps、getter 活引用、不反向 import main.js、不引入循环依赖 | AGENTS.md:57-58,80；module-scope.test.mjs:1-11 |
| 15 | 纯工具函数不得在新模块重写（escape/format/id/kv 等） | AGENTS.md:85 + utility-duplication-guard.test.mjs |

### 2.6 循环依赖 / 值快照高风险状态（ai-panel 内）

- `config`/`sessions`(:779-780)：几乎所有域读写，拆走必然回调宿主 → 循环。必须经 deps getter/setter（`getConfig: () => config` 现有惯例 :3392/:14811）。
- `streams`/`stream`/`oneShot`(:796-798)：热路径，兄弟模块已通过 `streamOf/compactOf` 注入；直接读 `stream` 快照会在切会话后读到旧流（AGENTS.md:58 明令禁止）。
- `renderTarget`(:4253)：同步 try/finally 临时态；拆渲染函数必须整体搬（含 `msgHost`/`renderSessionOf`/`withRenderTarget`，:4254-4268）。
- `lastBuildAnchor`/`lastBuildSavedTokens`(:6233-6243)：由 buildApiMessages(:6245) 写、renderStats/paintCtxPop(:6572/:6605) 读；拆上下文估算块必须连这些状态整包搬。
- `approvalTakeoverKey`/`dismissedPlanApproval`(:18213/:900)：已通过 getX/setX 传给 takeover/queue 模块，再拆须继续活引用。

---

## 3. 完整分期路线图：ai-panel.js

按风险从低到高。判据沿用 AGENTS.md:48（新文件目标 ≤1500 / 硬上限 3000）、side-chat-tab.md:275-286（注入面 ≤8 项可搬；>15 项或读写 streams/config/回合流程不搬）、session-messaging.md:389（注入面大于收益则留守）。

| 批次 | 新模块 | 锚点区间 | ≈行 | 职责 | 风险 | 测试改动 |
|---|---|---|---|---|---|---|
| **P1【本轮试点】** | `ai/session/ai-session-log.js`（阶段一后落点；原写 `ai/ai-session-log.js`） | 16540–16678 | 140 | 会话对话日志落盘（getAILogRoot/ensureAILogDir/queueLogSave/openAILogDir/showSessionDiagnostics） | 低 | 0（0 个测试锚定这些函数名） |
| P2 | `ai/ai-context-estimate.js` | 6229–6690 | 460 | buildApiMessages 瘦身组装 / 上下文估算 / Composer 统计行与弹层；4 个 lastBuild* 状态整包搬 | 中低 | 改 ai-turn-steer-wiring.test.mjs:205-210 切片路径 |
| P3 | `ai/ai-group-bridge.js` | 17337–17409 + 19248–19271 + 19032–19051 | 200 | 群聊视图挂载/卸载、aiGroupApi、bridgeShow* 薄转发 | 中 | 同步 main.js 接线；群聊测试不读源码 |
| P4（动手前重评） | `ai/ai-panel-view-switch.js` | 17337–17801 | 465 | setPanelView / 浮窗几何 / 分屏互换 | 高 | ai-panel-mode-lock.test.mjs:24 钉 setMode( 恰好 5 处；ai-auto-collapse 钉显示方式菜单 |

**明确暂缓（本路线图不排期）**：
- `bindPanelInteractions` 事件绑定（17805–18166，~360 行）：注入面 >15、热路径、ai-composer-submit-guard.test.mjs 钉 keydown 唯一性。
- 审批域（7572–8630 + 18167–18484，~2400 行）：超 1500 行 + 触碰 permissionLifecycleHook 单例 + ai-ask-pause/ai-permissions/ai-config-model 多处源码锚定。

**禁止搬迁（硬约束）**：executeTool/executeToolInner（10062–12062）、流式核心（12069–14180）、配置/会话持久化中心（910–3178）、消息渲染家族（3179–4624 + 4943–6027，11 个测试锚定）、面板几何/初始化。

**预估终态**：19,636 → P1 后约 19,500 → P2/P3 全完成后约 18,900。

---

## 4. 完整分期路线图：main.js

| 批次 | 新模块 | 锚点区间 | ≈行 | 职责 | 风险 | 测试改动 |
|---|---|---|---|---|---|---|
| **M1【本轮试点】** | `shell/aux-window-modes.js` | 499–744 | 250 | 便签/监控/对比/查看/预览五种独立窗渲染（auxWindowKind/auxToast/closeAuxWindowSelf/buildAuxWindowHead + 5 个 startXxxWindowMode） | 低 | 0（无测试锚定这 5 个 starter；window-close-semantics 只锁 startConsoleWindowMode，不在本块） |
| **M2【已实施】** | `editor/bookmark-actions.js` | 原 3614–3671（实测 main.js:1409-1469） | ~93 | 书签 UI 与 app_control 共用动作（list/add/remove/clear/goto + appActionBookmarkDoc） | 低-中 | 0（书签测试测纯函数，不读分发源码） |
| M3 | `shell/plugin-importer.js` | 3300–3409 | 110 | 插件文档导入器（已有分节注释标识） | 中 | 少量 |
| M4 | `shell/window-switch.js` | 6027–6053 | 27 | 多窗口切换列表缓存 | 中 | 改 window-switch-wiring.test.mjs:20-30 |
| M5 | `shell/console-window.js` | 201–473 + 746–754 | 280 | 调试台 + 诊断日志单一入口 | 中高 | 改 window-close-semantics.test.mjs:22-48、session-restore.test.mjs:105-142 |
| M6 | `shell/workspace-session.js` | 3762–3837 | 75 | 工作区打开/关闭 + 跨窗口会话复用 | 中高 | 中 |
| M7（最后，单独评估） | `shell/app-control-actions.js` | 926–2366 | 1440 | app_control 动作表与 runAppAction 分发 | 高 | 三方对账 ai-app-actions.test.mjs + window.__lens.runAppAction + AI 面板调用，爆炸半径最大 |

**留守组合根（不可拆）**：Wails 引导与事件桥、全局监听、appPageMounters 注入、VIRTUAL_TAB_VIEWS 分派、启动顺序硬约束、早期 hook TDZ 间接层、全局事件订阅集中区、window.__lens 活引用 getter；菜单注册表与全局快捷键。

**预估终态**：7,688 → M1 后约 7,440 → M2–M6 全完成约 7,100 → 含 M7 约 5,700。

**M7 特别提示**：runAppAction(:1309-2366，约 1057 行) 是最违反 200 行函数红线的一块，收益最大但被三方对账锁死，依赖面覆盖全文件。必须在 A/B/C 类低风险批建立信心后再做。

---

## 5. 试点批 P1 实施步骤：`ai/session/ai-session-log.js`

> 落点说明：阶段一已把 session 域归位到 `ai/session/`，故本模块落 `ai/session/ai-session-log.js`（原调研写 `ai/ai-session-log.js`，执行时按此调整）。行号为调研锚点，动手前 grep 重定位。

1. **重定位**：grep 确认 16540–16678 的精确边界（getAILogRoot 起到 showSessionDiagnostics 止），确认 `createAIConversationLog`(:16555) 构造点随块搬迁。
2. **建新模块**：新建 `frontend/src/ai/session/ai-session-log.js`，文件头 2–3 行职责注释；`export function createAISessionLog(deps)`；deps 注入 `getConfig/getSessions/sessionById/flash/conversationLog`（全部 getter 活引用，不拍快照）。函数体逐字搬移，仅把裸标识符改为 deps.X。
3. **改宿主**：ai-panel.js import 新工厂（路径 `./session/ai-session-log.js`）；在工厂内构造 `logMod = createAISessionLog({...})`；删掉原 ~140 行；在 3 个调用点（renameSession :16293、bridgeRenameSession :19423、paletteActions :18655）保留薄别名 `const queueLogSave = (...args) => logMod.queueLogSave(...args)`（其余被调函数同理）。**保持 createAIPanel 的 return 面完全不变**。
4. **登记护栏**：`frontend/test/core/module-scope.test.mjs` 的 HOSTS 新增 `{host: 'ai/ai-panel.js', modules: ['ai/session/ai-session-log.js']}`（参照该文件 :144-152 现有 ai-* 条目格式）。
5. **验证**：走第 7 节完整流程。

**零测试锚定依据**：全仓 grep `queueLogSave|getAILogRoot|ensureAILogDir|openAILogDir|showSessionDiagnostics` 在 `frontend/test/` 下 0 命中（唯一相关 ai-session-disk.test.mjs 测的是已拆出的 ai-session-disk.js，不动本块）。

> **⚠️ P1 已裁定跳过（2026-11-24，用户拍板）**：动手前复核发现，本调研基于旧快照，块主体的落盘机 `createAIConversationLog`（含 `queueLogSave`/`appendAskMarkdown`）早已拆进 `frontend/src/ai/session/ai-session-disk.js:1087-1306`。ai-panel.js 现存的只是它的薄别名 + 路径解析（getAILogRoot/ensureAILogDir/openAILogDir）+ 诊断 UI（showSessionDiagnostics），后者依赖 openAIDialog/dialogNode/dialogButton/closeAIDialog、backend、flash、showNote、currentSession、replaySessionLog、aiTextOf、aiFormatBytes、effectiveStorageMode 等 20+ 符号，且 `conversationLog.appendAskMarkdown` 被块外的 markdown 构建函数共用。按 AGENTS.md「注入面 >15 项不搬」红线，强拆违反判据且收益极小（主体已拆出），故跳过 P1。阶段二只做 M1。

---

## 6. 试点批 M1 实施步骤：`frontend/src/shell/aux-window-modes.js`

1. **重定位**：grep 确认 499–744（auxWindowKind 到最后一个 startXxxWindowMode）；确认 `consoleWindowMode`/`terminalWindowMode`(:213/:224) **不在本块**、留在 main.js。
2. **建新模块**：新建 `frontend/src/shell/aux-window-modes.js`，`export function createAuxWindowModes(deps)`；deps 注入 backend/rt/appEvents/applySettings/baseNameOf/iconSvg/normalizeTermText/consoleWindowMode/terminalWindowMode + 5 个已存在的 view 工厂（createBridgeMemoView/createAIMonitorView/createDiffWindowView/createLightView/createPreviewWindowView）+ createContextMenu。全部 getter 活引用。
3. **改宿主**：main.js import 新工厂并构造 `auxWindowModes = createAuxWindowModes({...})`（consoleWindowMode/terminalWindowMode 用 getter 从主文件读）；删掉原 ~250 行；把 bridgeUI 的 6 个 deps getter（main.js:7561-7566 的 5 个 aux starter + auxWindowKind）改指向新模块返回面。**`auxWindowKind` 是顶层 await Promise，必须经 getter 读取，不能改形态**。
4. **登记护栏**：module-scope 的 HOSTS 新增 `{host: 'main.js', modules: ['shell/aux-window-modes.js']}`。若扫描器对无 export 的顶层脚本不适用，按 phase2 先例改用 `.cadt/tmp-*.mjs` 独立静态扫描脚本兜底，并在执行结果里说明。
5. **验证**：走第 7 节完整流程。

**零测试锚定依据**：无测试对 startMemoWindowMode/startMonitorWindowMode/buildAuxWindowHead/auxToast 等做源码断言；window-close-semantics.test.mjs:32-36 只锁 startConsoleWindowMode（不在本块）。

---

## 7. 验证方式（完整档，每批固定）

1. **静态裸引用扫描**：运行 `npm test` 中的 `core/module-scope.test.mjs`（依赖 HOSTS 登记正确）；另按 phase2 方法论写一次性扫描脚本核对 deps 键一致性 / return 键 vs 调用方解构 / 裸引用与反向悬空，放 `.cadt/tmp-*.mjs` 用完即删。**必须做对照验证**：往旧版注入一个已知 bug 确认扫描能抓到，防止扫描脚本本身静默失效。
2. **全量测试**：在 `frontend/` 下 `npm test`（当前基线约 818 项，全绿才算过；测试/构建命令**不接 grep/tail 管道**，看退出码本身）。
3. **构建**：`npm run build`（vite），再用 `wails3 build -devtools` 验证 Wails 打包（不许用 `wails build -s` 跳过前端）。
4. **定向冒烟**：
   - P1：重命名会话、打开会话诊断、命令面板里触发日志目录打开，确认日志正常落盘。
   - M1：分别打开便签/会话监控/文件对比/查看/预览五种辅助窗口，确认渲染与关窗正常，主窗口不受影响。
5. **通用冒烟**：开 3 种格式标签、切主题、设置保存；`debug-console.jsonl` 无新 error。
6. 每批验证通过才提交；任一失败即单批 revert（编辑工具反向改或 git stash，**禁止 git checkout / git restore**）。

---

## 8. 风险与收尾

**主要风险**：
1. 行号漂移——每批动手前 grep 重定位，不照搬本文行号。
2. deps 漏注入——module-scope 护栏 + 对照验证双保险。
3. 测试切片失效——试点批特意选 0 锚定块规避；后续批次逐批同步改测试路径并登记 package.json 清单。
4. 层叠/TDZ——auxWindowKind 顶层 await Promise 与 window.__lens getter 形态不变。
5. 多会话并行改动冲突——动手前检查工作树，若有在途未提交改动先与用户确认（phase3 的 Z 归位就因 12 个在途文件而推迟）。
6. tokenizer 重写三坑（phase2 记录）：of-in 非声明上下文 / import 绑定进 topLevel / 对象简写位展开 `key: deps.X`。

**收尾**（阶段一 + 试点完成后）：更新 AGENTS.md 目录清单与 CHANGELOG.md / README.md（用户可见行为无变化，记为 refactor）；用 cognition_edit 维护受影响条目（ai-panel.js / main.js / module-scope.test.mjs 及阶段一归位后的各 ai/ 子目录条目的 F/R/A/S）。**本文件暂留 `docs/unfinished-plans/`**（P2–P4 / M2–M7 未实施，未达「全部实施后移入 finished-plans」的条件）；待全部批次完成后再移入。

**不在本方案范围**：P2–P4、M2–M7 的实施；style.css 拆分（已判定必要性低）；Go 侧（结构健康，无需动）。阶段二验证通过后停下汇报，是否继续后续批次由用户另行决定。

### 8.1 本轮实施记录（2026-11-24）

**阶段一：ai/ 目录全量重组（已实施）**
- 116 个源码文件按 10 域归位（agent/chat/core/gen/group/security/session/settings/tools/usage），`ai-panel.js` 留 `ai/` 根作组合根；127 个测试文件镜像拆到 `test/ai/<域>/`，7 个组合根/跨多域测试留根。
- 一次性迁移脚本（`.cadt/tmp-*`，用完即删）按 basename 查映射表，重算所有相对路径层级（import / read() / new URL() / 动态 import / 断言正则 / HOSTS 裸路径），同步 `package.json` 的 `test:ai` 清单（127 条）。
- 修复了迁移暴露的边角：留根测试路径层级、`read()` 自带基准包装、断言字符串被误改、动态 import 变量路径、正则字面量里的 import 断言。
- 验证：`npm test` 全量 2652 项全绿（1495+649+487+21）；`npm run build` 成功。
- 认知索引：15 条旧扁平路径条目迁到新域路径，更新 `cognition_app.go` 的 R 引用。

**阶段二 P1（跳过）**：见第 5 节末尾裁定——落盘机早已拆出、诊断 UI 注入面超红线。

**阶段二 M1（已实施）**：从 main.js:494-745 拆出 5 个辅助窗启动器 + 头部/提示基建到 `frontend/src/shell/aux-window-modes.js`（`createAuxWindowModes(deps)`，257 行）；backend/rt/appEvents/applySettings/baseNameOf 经 getter 注入，纯函数/工厂直接 import；`auxWindowKind` 顶层 await Promise 按硬约束留 main.js；bridgeUI 的 5 个 deps getter 改指向模块返回面。
- 验证：module-scope 对无 export 顶层脚本误报（deps getter 键被当裸用），按文档预案改用 `.cadt/tmp-m1-scan.mjs` 一次性静态扫描（含对照验证：注入已知裸用 bug 确认能抓到）；`npm test` 全量 2652 项全绿；`npm run build` 成功。
- 冒烟边界：辅助窗需带 `--aux-kind` 参数启动独立窗口，app_control 不跨窗口、无法模拟；运行态冒烟需在重启后的独立窗口手动进行。
  - 后续补测（用户重建 exe 后）：桌面控制打开便签独立窗，标题/尺寸正确、Alt+F4 关窗正常、无运行时错误；便签窗内容空白系数据原因（全局便签为空 + 当前未打开工作区），与 M1 无关（deps 传法已 git 对比逐字一致）。

**阶段二 M2（已实施）**：从 main.js:1409-1469 拆出 5 个书签 case + `appActionBookmarkDoc` 到 `frontend/src/editor/bookmark-actions.js`（`createBookmarkActions(deps)`，93 行）；`bookmarkOverview`/`formatBookmarkListText` 纯函数直接 import，编辑器域函数（findDocByPath/openPaths/selectLineInDoc/addBookmarkAt/removeBookmarkAt/clearDocBookmarks/rememberDocView）与 docs/file 经 deps getter 注入；main.js 的 5 个 case 改为薄转发，删除原 `appActionBookmarkDoc` 定义。验证同 M1（module-scope 对无 export 顶层脚本误报，改用一次性静态扫描 + 对照验证）；`npm test` 全量 2652 项全绿、`npm run build` 成功。

---

## 附录：关键 path:line 速查

> ⚠️ 以下行号是 2026-11-24 调研锚点。阶段一目录重组会改变 import 路径（测试路径也镜像到 `test/ai/<域>/`），但 ai-panel.js / main.js 函数体行数基本不变；每批动手前 grep 重新定位，不照搬行号。

- `frontend/src/ai/ai-panel.js`（阶段一后仍在 `ai/` 根）：createAIPanel 工厂 :329；executeTool 包装层 :10062；executeToolInner :10078；MCP_CONFIG_ACTIONS :9861；对话日志块 :16540-16678；return 面 :19171-19635。
- `frontend/src/main.js`：aiPanel import :33；Wails 引导 :149-182；APP_ACTIONS/runAppAction :926-2366；createAIPanel 调用 :4366；appPageMounters :5556-5573；window.__lens :2368-2386；bridgeUI deps :7508-7609；启动顺序 :7494-7496。
- `frontend/test/core/module-scope.test.mjs`：HOSTS 清单 :92-153；裸符号扫描断言 :155-180。
- `frontend/test/ai/ai-tool-wiring.test.mjs`：executeTool 切片 :33-47；EXECUTED_ELSEWHERE :26-28；报错文案 :172-177。
- `frontend/test/ai/ai-app-actions.test.mjs`：三方对账 :3-8,73-91。
- `frontend/test/ai/ai-panel-mode-lock.test.mjs`：setMode 计数 :24。
- `docs/finished-plans/frontend-split-phase2.md`：tokenizer 三坑（§2 实施记录）、验证纪律（§5）。
- `docs/finished-plans/frontend-split-phase3.md`：多域解耦范式、HOSTS 登记先例。
