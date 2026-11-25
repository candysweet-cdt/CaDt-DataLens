# 设置页信息架构重组方案

> 状态：未开工。只读评估已完成（见文末「评估依据」），本文是实施方案。
>
> 目标：解决设置侧栏分类维度不统一的问题——「功能」是伪分类、AI 组四种维度混用、
> 三个超载 pane、本体/开关分离、命名撞车。

## 1. 现状问题（评估结论）

| # | 问题 | 证据 |
|---|---|---|
| 1 | 「功能」伪分类：偏好配置 + 管理工具页 + 系统级动作（写注册表）同级混装 | `frontend/index.html:339-346` |
| 2 | AI 组四种维度混用：资源接入 / 安全策略 / 运行行为 / 提示词构成 | `frontend/index.html:303-318` |
| 3 | 三个超载 pane：`editor-tabs` 6 组≈38 行、`ai` 8 组≈47 行、`permissions` 9 组含整套端侧分类器 | `frontend/index.html:426/811/1390` |
| 4 | 本体与开关分离：环境变量本体在功能区、注入开关在 AI 上下文；个性化本体在 persona、注入开关在 context | `index.html:1806 vs 1354`、`1183 vs 1346` |
| 5 | 命名撞车：「诊断」既是侧栏 section 又是 APP_PAGES 的 group；「AI」两边都有 | `frontend/src/core/app-pages.js:45,47` |
| 6 | 字体散落三处：界面/编辑器字体在 editor-tabs、聊天字体在 ai、代码主题在 general | `index.html:453/908/414` |
| 7 | 搜索盲区：只索引 `.settings-pane`，7 个应用页面搜不到；结果标签只显示 pane 名，两个「环境变量」无法区分 | `frontend/src/settings/settings-search.js:14-16,63` |

## 2. 目标终态：按作用域分 5 区

```
① 界面与编辑   通用 · 外观（主题+全部字体+代码主题）· 编辑器（标签页/视图/Markdown）· 写作 · 代码截图 · 快捷键
② AI           模型 · 生图与视频 · 对话行为 · 子代理 · 身份与偏好 · 上下文注入
③ 安全与权限   权限判定 · 端侧分类器 · 工具与插件权限
④ 集成与自动化  运行 · 生命周期 · 定时任务入口 · 环境变量 · 菜单管理 · 插件 · 系统集成
⑤ 维护与诊断   存储与清理 · 开发者 · 应用页面目录 · 关于
```

设计原则：
- **作用域一致**：同一 section 内的项服务同一个用户意图（改外观 / 配 AI / 管安全 / 接系统 / 维护软件）。
- **本体与开关就近**：一个东西的「是什么」和「要不要用」放同一页。
- **命名唯一**：section 名与 APP_PAGES group 名不重复。
- **克制拆分**：不为「每个功能一个页」把侧栏拉长；编辑相关的项留在一起。

## 3. 迁移映射（现 pane → 终态）

| 现 pane | 现 section | 新 section | 终态 pane | 步骤 |
|---|---|---|---|---|
| `general`（常规） | 设置 | ① 界面与编辑 | 通用 | 1（改文案） |
| `general`（外观） | 设置 | ① | 外观（并入全部字体+代码主题） | 2 |
| `editor-tabs` 标签页 | 设置 | ① | 编辑器·标签页 | 2（拆） |
| `editor-tabs` 字体 | 设置 | ① | 并入「外观」 | 2（跨 pane 移行） |
| `editor-tabs` 文件树与代码视图 | 设置 | ① | 编辑器·视图 | 2 |
| `editor-tabs` Markdown 预览 | 设置 | ① | 编辑器·Markdown | 2 |
| `editor-tabs` 写作模式 | 设置 | ① | 写作（独立 pane） | 2 |
| `editor-tabs` 代码截图 | 设置 | ① | 代码截图（独立 pane） | 2 |
| `shortcuts` | 功能 | ① | 快捷键 | 1（挪 section） |
| `models` | AI | ② AI | 模型 | 1 |
| `gen-models` | AI | ② AI | 生图与视频 | 1 |
| `ai` 界面/聊天/通知/超时/迁移 | AI | ② AI | 对话行为 | 2（拆） |
| `ai` 子代理 | AI | ② AI | 子代理（独立） | 2 |
| `persona` | AI | ② AI | 身份与偏好（合并 preferences） | 2 |
| `preferences` | AI | ② AI | 并入「身份与偏好」 | 2 |
| `context` | AI | ② AI | 上下文注入（开关就近后瘦身） | 2 |
| `permissions`（判定/沙箱/审批） | AI | ③ 安全与权限 | 权限判定 | 1（提升 section） |
| `permissions` 端侧分类器 | AI | ③ | 端侧分类器（独立 pane） | 2 |
| `permissions` 子代理沙箱/插件工具 | AI | ③ | 并入权限判定 / 工具与插件权限 | 2 |
| `run` | 功能 | ④ 集成与自动化 | 运行 | 1（挪） |
| `lifecycle` | 功能 | ④ | 生命周期 | 1 |
| `envvars` | 功能 | ④ | 环境变量（+ AI 注入开关） | 1/2 |
| `new-file-menu` | 功能 | ④ | 菜单管理 | 1 |
| `plugins` | 功能 | ④ | 插件 | 1 |
| `integration` | 功能 | ④ | 系统集成 | 1 |
| `developer` | 诊断 | ⑤ 维护与诊断 | 开发者 | 1 |
| `storage` | 诊断 | ⑤ | 存储与清理 | 1 |
| `app-pages` | 页面 | ⑤ | 应用页面目录 | 1 |
| `about` | 其他 | ⑤ | 关于 | 1 |

APP_PAGES group 改名（`frontend/src/core/app-pages.js:43-49`）：

| 旧 group | 新 group | 页 |
|---|---|---|
| 数据 | 统计 | usage-stats |
| AI | 智能体 | external-tools / agents / cognition |
| 自动化 | 定时 | schedules |
| 诊断 | 记录 | activity |
| 开发 | 补丁 | patches |

> 说明：group 只影响菜单/目录的连排分组，不影响任何设置项 id。

## 4. 分步实施

### 第 1 步：骨架归位（零 row-id 变更，低风险）

只改侧栏 section 归属与显示文案，不动 pane 内部结构。

- `frontend/index.html:300-351`：把 section 从「设置/页面/功能/诊断/其他」改为「①~⑤」五段；
  `permissions` 按钮从 `#snav-ai` 组下提升为独立 section 项（`data-pane="permissions"` 不变）。
- `frontend/src/settings/settings-ui.js:884`：AI 组展开判断去掉 `permissions`（已不在 AI 组内）。
- `frontend/src/core/app-pages.js:43-49`：group 按上表改名。
- 验证：`settings-tree.js` 无需改（id 只由 pane+group+title 生成，section 不参与）；
  `TestAppBindingBaseline` 不受影响（不改后端）。

> 为什么零风险：`settingsRowId`（`settings-tree.js:100-106`）用 `[pane, group, title]` 哈希，
> **section 不参与**。只挪按钮位置、改 section 文案，所有 `set_setting_row` 引用与风险分级完好。

### 第 2 步：内脏拆分（中风险，需 id 治理）

拆超载 pane、合并 persona/preferences、字体收拢、开关就近。

- `editor-tabs` → 「编辑器」（标签页/视图/Markdown）+ 「写作」+ 「代码截图」三个 pane；
  字体组移入「外观」。
- `ai` → 「对话行为」（界面/聊天/通知/超时/迁移）+ 「子代理」两个 pane。
- `permissions` → 「权限判定」+ 「端侧分类器」两个 pane。
- `persona` + `preferences` 合并为「身份与偏好」；`context` 的「个性化」「用户偏好」注入开关移入该页。
- `context` 的「环境变量」注入开关移入 `envvars` 页。
- **id 治理**：拆分/移行时给所有控件补显式 id（多数已有 `opt-*`/`ai-opt-*`），
  补不齐的更新 `testdata/app_bindings_baseline.txt` 无关项，改为更新前端测试里的精确断言，并在提交信息写明。
- 同步 `settings-ui.js` 的 `selectSettingsPane` 分发与 AI 组展开判断。

### 第 3 步：搜索与收尾（低风险）

- `frontend/src/settings/settings-search.js`：索引纳入 `core/app-pages.js` 的 7 个页面；
  结果行带完整 section 路径（消歧同名「环境变量」）；`buildSettingsSearchIndex` 加缓存。
- `frontend/src/main.js`：`appPageMounters`（:5240-5257）与 `renderAppPagesNav`（:5277-5322）按新 group 核对。
- 回归：`npm test`、相关 `*.test.mjs`。

## 5. 逐文件改动清单

| 文件 | 改动 | 步骤 |
|---|---|---|
| `frontend/index.html` | 侧栏 section 骨架（:300-351）、pane 容器拆分/合并/重排 | 1,2 |
| `frontend/src/settings/settings-ui.js` | `selectSettingsPane`（:855-915）、AI 组展开判断（:884） | 1,2 |
| `frontend/src/core/app-pages.js` | group 改名 | 1 |
| `frontend/src/settings/settings-search.js` | 纳入 app-pages、路径消歧、缓存 | 3 |
| `frontend/src/main.js` | appPageMounters / renderAppPagesNav 核对 | 3 |
| `frontend/src/settings/settings-tree.js` | 无需改（确认 PROTECTED/HIGH/MEDIUM 集合仍匹配） | 2 复核 |
| `frontend/src/settings/settings-pane-*.js` | pane 名变更时同步 mount 分发 | 2 |
| `CHANGELOG.md` / `README.md` | 用户可见变更 | 收尾 |

## 6. 风险与验证

- **最高风险：`settingsRowId` 哈希漂移**（第 2 步）。对策：给控件补显式 id，不靠哈希漂移。
- **分发器漏改**：`selectSettingsPane` 的 else-if 链与 AI 组展开判断必须同步，否则 pane 打不开。
- **测试门**：`frontend/test/editor/virtual-doc-wiring.test.mjs`、`frontend/test/ai/ai-app-actions.test.mjs`、
  settings 相关用例；`go test -run TestAppBindingBaseline .` 顺手验。
- **提交策略**：第 1 步单独 commit 可 revert；第 2 步按 pane 一批一 commit（editor / ai / permissions）。
- **隔离**：第 2 步改 `index.html` 骨架前用 worktree 隔离试改，回灌前跑测试门。

## 7. 明确不做

- 不把应用页面搬回设置对话框（已迁标签页的方向是对的）。
- 不把每个功能都拆成独立页（侧栏会失控变长）。
- 不重写搜索为全文索引系统（当前机制够用，只补盲区与缓存）。
- 不为了「对称」乱搬个性化的注入开关（persona 与 context 本就同 section）。

## 8. 评估依据

只读评估来自三份并行盘点（静态 pane / 动态 pane / 杂糅诊断）与源码核对：
`frontend/index.html:300-351,354-2008`、`frontend/src/settings/*`、`frontend/src/core/app-pages.js`、
`frontend/src/settings/settings-search.js`、`frontend/src/settings/settings-tree.js:100-106`。
