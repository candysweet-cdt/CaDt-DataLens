# 设置页信息架构重组方案

> 状态：**已实施（2026-11-27 归档核验确认）**。五区骨架归位、项级锚点式分类、搜索纳入 APP_PAGES 均已落地（证据见 `CHANGELOG.md:138-146`、`frontend/index.html:307-360`、`frontend/src/settings/settings-search.js:47-58`）。归档时记录三处与原方案的偏离（见下）。
>
> **归档时记录的实现偏离**：① `persona` 与 `preferences` 未合并为「身份与偏好」，仍为两个独立 pane；② 字体未收拢到「外观」，界面/编辑器字体仍在 editor-tabs、聊天字号仍在 ai；③ 搜索未实现 `buildSettingsSearchIndex` 缓存，每次输入重建索引。另：原方案第 2 步的「拆 pane + id 治理」改为锚点式分类（不改 pane id），属实现路径偏离。
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

## 2. 项级归属：判据

> pane 级重组解决「分类说不清」，但用户实际摩擦在**项级**——一个开关的语义归属与操作动线
> 冲突时该听谁的。以下是判据与处置。

**前置检验 L0：先确认是不是真重复**

「同一对象出现在多处」不等于错。三项检验：

1. 写的是同一份数据吗？
2. 各有不可替代的用途吗？
3. 有一致性保证吗（同一出口重绘 / 同一数据源）？

| 检验结果 | 性质 | 处置 |
|---|---|---|
| 三条都满足 | 合理多视图 | 保持 |
| 写同一份但无一致性保证 | 真 bug | 修 |
| 写不同份、语义同一对象 | **正交维度** | 保持 + 加跳转 |

**三级判据（优先级从高到低）**

- **L1 依赖绑定（硬）**：B 的生效依赖 A 的存在/开启 → 必须同页同屏。断裂是「功能走不通」，不是「多跳一步」。
- **L2 动作链（中）**：用户连续做的动作（配账号 → 看余额 → 开显示）→ 放同一页。
- **L3 概念归属（软）**：纯语义分类，只在无依赖、无动作链时用。是兜底，不是首选。

**降级规则**：L1 无法满足时（依赖物在外部系统 / 另一个应用页面），用**带按钮的跳转**代替纯文字
desc，把 L1 降成 L2 的成本。纯文字桥接（「需先在…启用」）不合格——它把搜寻成本转给了用户。

**度量信号**：现有代码大量用 `set-desc` 文字桥接跨页依赖（`index.html:863,946,1162,1349,1743,1912`）。
**依赖提示越多，越说明结构放错了**；它们是症状，不是方案。

**案例：显示额度胶囊 vs 显示 Token 用量**

| 项 | 归属对象 | 现位置 | 判定 |
|---|---|---|---|
| 显示 Token 用量 `ai-opt-show-usage:940` | 对话级（本轮 token） | ai / 聊天行为 | 留 ai，移入「界面」组 |
| 显示额度胶囊 `ai-opt-show-quota-pill:946` | 账号级（账号余额） | ai / 聊天行为 | 移 models，账号列表后 |

- L1：胶囊是双条件 `frontend/src/ai/ai-panel.js:6618`（全局开关 + 当前账号 `usage.enabled`），
  后者在账号卡弹窗里（`frontend/src/ai/usage/ai-usage-config-dialog.js:306-315`）→ 该同页。
- L2：配账号 → 想知道能否看余额 → 开显示，是同一条动作链。
- L3：语义主体是「账号的额度」，不是「对话」。
- **两者并排本身就是粒度错配**：一个属对话、一个属账号，并排会让人以为都是对话显示。
  同理 `ai-opt-export-keys:1162`（全局开关却对「模型面板的账号导出」生效）属同一类。

## 3. 项级处置清单

**必须动（L1 断裂）**

| 项 | 行 | 处置 |
|---|---|---|
| 显示额度胶囊 | 946 | 移 models，账号列表后新建「额度显示」组 |
| 默认桌面控制 | 1426 | 留 permissions，desc「需先安装」改为按钮跳转到外部工具页 |
| 显示 Token 用量 | 940 | 留 ai，移入「界面」组 |

**建议动（L2/L3 错配）**

| 项 | 行 | 处置 |
|---|---|---|
| 聊天字号 + 英/中/代码字体 4 项 | 909-925 | 收拢到 general「外观」，与界面/编辑器字体并列三档 |
| 「聊天行为」13 项显示开关 | 928-995 | 移入已存在的「界面」组；「聊天行为」只留发送快捷键/长文本粘贴/输出语言/自动标题 |
| 显示顶部提示条 | 373 | 移入 general「外观」组 |
| 代码补全 3 项 | 569-584 | 从「文件树与代码视图」拆出「代码补全」小组 |

**保持（单一主题，语义一致，不因项多而拆）**

通知 7 项（`1052-1097`）· 超时与重试 4 项（`1099-1157`）· 子代理 5 项（`1016-1050`）·
配置迁移 3 项（`1159-1181`）。

**B 类深挖结论：「同一对象分散」四项全部不该合并**

| 对象 | 分散位置 | 实际性质 | 结论 |
|---|---|---|---|
| 记忆 | `829` / `1243` / `1327` | 三个**正交维度**：位置编辑（select）/ 只读回显+入口（`set-desc`，`index.html:1252` 明写「只是预览与入口」）/ 是否注入（context） | 保持。persona 页已有「打开记忆管理…」按钮，是跳转的**正例** |
| 格式 | `#fmt-table` / `fmt-<id>` | 同一数据两种视图（总览横向对比 / 单页看说明），都写 `settings.formatSettings[id]` 且都调 `applySettings()`（`settings-pane-lang.js:546-548,595-597`） | 保持；**约束**：两处必须继续共用 `applySettings()` 才有同步保证 |
| 语言 vs 运行 | `lang-*` vs `run` | 环境检测（`settings.langEnv`）vs 执行方式（`runProfiles/runConfigs/runArgs`），仅运行时消费关系（`$TOOL` ← `effectiveToolEnv`，`run.js:1388`），非配置重复 | 保持；**可加跳转**（现无任何入口，只有报错文字指路） |
| 插件 vs 权限 | `plugins` vs `permissions` | 生命周期管理 vs AI 权限策略；数据源不同（`GetPlugins()` 已安装清单 vs `pluginToolsByPlugin()` 运行时工具注册表） | 保持；**可加跳转**（现无入口） |

> 教训：上一轮把 B 类（「同一对象配置分散」）整体列为「待修」，是**分类错误**——它们不是同一配置被切开，
> 而是正交维度同处一个对象名下。判据 L0 就是为拦住这种误判而设。

**B 类真正可行动项（3 处，低风险，L1 降级规则的应用）**

| 在哪 | 加什么 | 指向 |
|---|---|---|
| `lang-*` pane | 「命令模板 / 运行配置…」按钮 | `openSettings('run')` |
| `run` pane 命令模板组 | 「检测运行环境…」按钮 | `openSettings('lang-<lang>')` |
| `plugins` 每行 | 「AI 工具权限…」按钮 | `openSettings('permissions')`（已有 `openSettings` preset 先例：`settings-pane-plugins.js:433`） |

## 4. 目标终态：按作用域分 5 区

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

## 5. 迁移映射（现 pane → 终态）

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

## 6. 分步实施

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
**项级处置按 §3 清单执行**（额度胶囊移 models、字体收拢到外观、13 项显示开关归「界面」组等）。

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

## 7. 逐文件改动清单

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

## 8. 风险与验证

- **`settingsRowId` 哈希漂移**（第 2 步）：`settingsRowId` 优先取控件自身 id
  （`frontend/src/settings/settings-tree.js:100-106`），**带显式 id 的控件跨 pane 移行不改变 row id**。
  风险只集中在「无 id 控件 / 纯按钮组」——移行时给它们补显式 id 即可，不必依赖哈希漂移。
- **分发器漏改**：`selectSettingsPane` 的 else-if 链与 AI 组展开判断必须同步，否则 pane 打不开。
- **测试门**：`frontend/test/editor/virtual-doc-wiring.test.mjs`、`frontend/test/ai/ai-app-actions.test.mjs`、
  settings 相关用例；`go test -run TestAppBindingBaseline .` 顺手验。
- **提交策略**：第 1 步单独 commit 可 revert；第 2 步按 pane 一批一 commit（editor / ai / permissions）。
- **隔离**：第 2 步改 `index.html` 骨架前用 worktree 隔离试改，回灌前跑测试门。

## 9. 明确不做

- 不把应用页面搬回设置对话框（已迁标签页的方向是对的）。
- 不把每个功能都拆成独立页（侧栏会失控变长）。
- 不重写搜索为全文索引系统（当前机制够用，只补盲区与缓存）。
- 不为了「对称」乱搬个性化的注入开关（persona 与 context 本就同 section）。

## 10. 评估依据

只读评估来自四份并行盘点（静态 pane / 动态 pane / 杂糅诊断 / 项级错位审计）与源码核对：
`frontend/index.html:300-351,354-2008`、`frontend/src/settings/*`、`frontend/src/core/app-pages.js`、
`frontend/src/settings/settings-search.js`、`frontend/src/settings/settings-tree.js:100-106`、
`frontend/src/ai/ai-panel.js:6610-6618`、`frontend/src/ai/usage/ai-usage-config-dialog.js:306-315`。
