# 编辑器代码补全（分期方案）

> 状态：**已实施（P0+P1+P2，2026-11-22 评估、方案、实施同日完成；偏离与落地记录见 §15）**。
> P3 AI ghost text 未实施，§14 预评估保留。全文行号按 2026-11-22 实施前工作区实测。
>
> 目标形态：类 JetBrains 的「结构感知本地补全」——候选随上下文而来、模糊匹配、手动触发为主、输入即弹可选。但严格守住本项目底线：**无索引、无 LSP、0 新依赖**——做数据查看器里的够用补全，不做瘦版 IDE。

---

## 1. 结论摘要

1. **可行且便宜**：Ace 补全引擎（`ext/language_tools` + `ace/autocomplete` + snippets）已经躺在 `frontend/public/vendor/jsoneditor.min.js`（1,060,339 B）bundle 内、随 `window.ace` 全局暴露（bundle 内有 `ace.define("ace/ext/language_tools",…)` 与 `enableBasicAutocompletion` 调用路径原文），应用层当前**零启用**。推荐路径下：体积增量 ≈ 0、新依赖 = 0、vendor 新文件 = 0。
2. **JetBrains 的真正来源拿不到，也不该拿**：PSI 解析树 + 全项目索引是 JetBrains 体验的根基，而「换 Monaco」「自建全项目索引」「内置 LSP」三项均在 `docs/reports/optimization-proposals.md:690` 否决清单里（「本项目的核心竞争力恰恰是无索引」）。本项目能做的是**无索引的结构感知本地补全**：SQL 面吃 DB 元数据、数据格式面吃当前文档结构——恰好是本产品编辑强度最高的两个场景。
3. **价值最高点在 SQL 控制台**：现状是裸 `<textarea>`（无高亮无补全，`db-query-editor.js:60-64`），而表/列元数据 API 现成且 Go 侧已带缓存（`DBListObjects` / `DBDescribe`，`dbclient_app.go:29/33`；`internal/dbclient/session.go:219` `describeMeta` 缓存键 `database\x00table`）。SQL 补全也是从 DataGrip 类工具迁移过来的用户的第一预期。
4. **文件编辑器是低成本顺手账**：JSON/YAML/XML/TOML/INI 的 key/标签/段名候选数据全在当前文档里，加一层全文档词法兜底即可达到「JetBrains 本地词」的下限体验。通用编程语言（.go/.py/.js…）只有词法级，不承诺语义。
5. **分期**：P0 SQL 控制台（含 textarea → Ace 前置改造，探针先行）→ P1 文件编辑器（按格式 completer + 词法兜底）→ P2 打磨（打分统一 / quick doc / 候选图标）。AI ghost text 内联补全是另一条线，**不混入本期**（比直觉贵：依赖现成但有三处错配，预评估与便宜版路径见 §14）。
6. **总工作量约 5–8 天**，全部纯前端：无 Go 改动、无新增绑定（因此无 mock-backend 新增义务）、不触碰超线存量文件（`ai-panel.js` / `main.js` 均不动）、不进 `ai-tool-defs` 体系（非 AI 工具）。

---

## 2. 「JetBrains 效果」拆解与可行性映射

| JetBrains 特性 | 依赖什么 | 本项目可行性 | 落法 |
|---|---|---|---|
| 输入即弹（auto popup） | 前缀分析 | ✅ | Ace `enableLiveAutocompletion`；默认关，Ctrl+Space / Alt+/ 手动触发为主（中文 IME 冲突，见 §4.2） |
| CamelHumps / 子串 / 中缀模糊匹配 | 打分器 | ✅ | 自研纯函数打分（`core/completion.js`），口径与命令面板模糊匹配对齐（AI 面板斜杠命令已复用同一套先例，`docs/finished-plans/ai-panel.md:605`） |
| 上下文感知（作用域/类型） | PSI + 索引 | ⚠️ 分面 | SQL 面 ✅（DB 元数据）；JSON/YAML/XML/TOML/INI 面 ✅（当前文档结构）；通用编程语言 ❌（仅词法级） |
| 候选排序 + 类型图标 | 类型系统 | ⚠️ | 排序自研打分；图标走 `core/icons.js` 注册表（新增注册项是规范路径，护栏基线不变红） |
| Quick Documentation（Ctrl+Q） | PSI 文档 | ⚠️ 轻量 | P2：SQL 列候选给 type / pk / notNull / default（`DBDescribe` 返回里现成） |
| Live / Postfix templates | 引擎 | 🔸 低优先 | Ace snippets 已在 bundle 内，本期不暴露 UI |
| Ghost text AI 内联补全 | 云端模型 | 🔸 另线 | P3 另立方案，不进本文范围 |

---

## 3. 现状（代码事实，2026-11-22 核对）

### 3.1 编辑器侧：补全引擎已在包内，未启用

- Ace 不进 npm/Vite 打包：`frontend/package.json` 无任何 ace 依赖；Ace 核心由 `jsoneditor.min.js` 内置并挂 `window.ace` 全局。语法 mode 是独立文件，`frontend/index.html:43-88` 同步加载 44 个 `vendor/ace/mode-*.js`（含 `mode-sql.js`）；**`vendor/ace/` 下没有独立的 `ext-language_tools*.js`**——language_tools 只存在于 jsoneditor bundle 内部。
- 应用代码零命中补全：全仓（排除 node_modules/dist）grep `autocomplet|language_tools|completer|snippet` 仅命中 HTML `autocomplete:'off'` 属性与 AI 域文本。`createDocEditor` 的 JSONEditor 选项没传 autocomplete（`editor-groups.js:1422-1458`）。
- 现成挂接点：`ed.aceEditor` 挂钩区（`editor-groups.js:1461` 起，折叠/多光标/平滑滚动都挂在这）；Ace 会话钩子域是 `editor-ace-hooks.js`（`applyAceMode` 在 :26-67，repo-layout.md 已指认补全类 Ace 会话能力归此域）。
- mode 映射单一来源：`core/formats.js:509-515` `aceModeFor()`；容器已有 `ace-mode-<mode>` class 钩子（`editor-ace-hooks.js:34-38`）。
- 只读判定单一来源：`core/readonly.js:19-23` `isDocReadOnly`（全局锁 / doc.readOnlyFixed / doc.readOnlyLocked / doc.large / doc.binary），生效点 `editor-ace-hooks.js:45`。**补全启用判定必须走它**。
- 大文件守卫在 Go 层：`internal/fileio/fileio.go:23-24`（10 MB 只读档 / 100 MB 拒开），>10 MB 一律 `code` 只读（`editor-groups.js:1563`）→ 大文件天然不触发补全；10 MB 以下大文档的词法扫描仍需限流（§6.3）。
- 样式：`style.css:4261-4510` 已有整套 jsoneditor 内嵌 Ace 主题覆盖；**没有 `.ace_autocomplete` 弹层样式**，需新写并入同一区域。

### 3.2 SQL 控制台侧：裸 textarea，元数据 API 现成

- 输入控件：`db-query-editor.js:60-64` `createTextarea({rows:5, …})`，无高亮无补全；键位仅 Ctrl+Enter 执行（:65-70），`input` 事件使两阶段确认横幅失效（:72-74），防重入靠 `runBtn.disabled` + `run()` 显式检查（:116）。
- 布局位置：`db-tab.js:93-98`，「数据库」标签页 = 对象树 | 表网格子标签 | SQL 控制台 三栏；会话经 `query.setSession(session)` 注入（:136）。
- 元数据 API（前端可调，全部已有，无需新增绑定）：

  | JS 调用 | 返回 | 补全用途 |
  |---|---|---|
  | `DBListDatabases(session.id)` | `string[]` | `库.` 层级 |
  | `DBListObjects(session.id, db)` | `[{name, kind:'table'|'view', rowEstimate}]` | 表/视图候选 |
  | `DBDescribe(session.id, db, table, noCache)` | `DBTableMeta{columns:[{name,type,notNull,default,pk}], pk, indexes, …}` | 列候选 + quick doc |

- 方言仅 sqlite / mysql（`internal/dbclient/dbclient.go:36-37`，`ConnectionConfig.Kind` 即方言）；插件驱动会话被包成同名同形门面（`db-plugin.js:85-98`）→ completer 只依赖这三个方法名即自动兼容插件驱动。
- 写后刷新先例：`db-table-grid.js:150` `loadMeta(noCache)` —— 补全缓存的失效（§5.3）复用同一语义。
- mock：`dev/mock-backend.js:1248-1334` 已覆盖 DBListObjects / DBDescribe（静态演示数据）→ dev 模式下补全可直接联调。

### 3.3 政策红线核查与先例

- 否决清单（`docs/reports/optimization-proposals.md:690-699`）：换 Monaco（+5~10 MB，且无 LSP 拿不到语义补全）、内置 LSP、自建全项目索引。**「语义补全」只作为 Monaco 否决理由出现过，本地无索引补全从未被判过**——本文方案全部落在合规空间内。
- 头部总闸门（同文件 :5）：「优先『不增加安装体积、不增加第三方依赖』的改动」→ 推荐路径 0/0/0（体积/依赖/vendor 文件）。
- 交互先例（候选弹层 + 键盘导航）：群聊 @ 成员补全（`docs/finished-plans/ai-group-chat.md`）、AI composer 斜杠命令补全（复用 palette 模糊打分，`docs/finished-plans/ai-panel.md:605`）。**若走路线 B（自绘弹层），交互契约直接抄这两个先例。**
- 产品叙事顺承：CHANGELOG 已有「编辑器内快捷键随风格联动——默认对齐 JetBrains，VSCode 风格可选」「scratch 对齐 JetBrains 命名」——补全是「对齐 JetBrains」路线的自然下一步。
- 弹层规范（2026-11-20）：Ace 补全弹窗属**编辑器内部小浮层**，不进 `overlay-stack`（规范明文豁免），Esc 由 Ace 自理，不写全局 Esc 监听（`test/core/overlay-esc-guard.test.mjs` 不变红）。

---

## 4. 总体设计

### 4.1 模块划分与依赖方向

```
┌────────────────────────────────────────────────────────────────┐
│ 前端（依赖单向：域模块 → core 纯函数；editor/ 与 db/ 互不 import）│
│                                                                │
│  core/completion.js            纯函数：打分 / 词提取 / 候选归一化 │
│                                 （可测，注册 npm test）          │
│                                                                │
│  editor/editor-completion.js   文件侧接线 createEditorCompletion(deps) │
│    ├─ 挂点：editor-ace-hooks.js（Ace 会话钩子域）                │
│    └─ completer 按 aceMode 分流（JSON/YAML/XML/TOML/INI/词法兜底）│
│                                                                │
│  db/db-completion.js           SQL 侧 createSqlCompletion(deps)  │
│    ├─ 挂点：db-query-editor.js（Ace 化后）                       │
│    ├─ 方言关键词表（表驱动常量，sqlite / mysql 两套）             │
│    └─ 元数据懒聚合缓存 ← Call.ByName：DBListObjects / DBDescribe  │
└────────────────────────────────────────────────────────────────┘
（无 Go 改动、不新增绑定；编辑器全局注册一次 completer，按 editor/session 上下文分流）
```

- 新导出名 `createEditorCompletion` / `createSqlCompletion` 落笔前先 grep 全仓防撞（AGENTS.md 命名规则）。
- completer 走 `language_tools.addCompleter()` 全局注册（同一 `window.ace` 运行时内所有实例共享），因此**一个入口函数内部按上下文分流**，而不是每域各注册一个——`getCompletions(editor, session, …)` 里判断 session 归属（db 控制台实例带标记 vs 文档编辑器按 `aceModeFor`）。
- `main.js` 不加域逻辑：`editor-completion` 经 main.js getter 注入；`db-completion` 由 `db-tab.js` 在建 SQL 控制台时注入 backend/session 依赖。

### 4.2 触发与键位（含中文 IME 冲突）

- **主触发：Ctrl+Space 手动**；**第二键：Alt+/**。原因：Ctrl+Space 在 Windows 中文输入法下是中英切换，JetBrains 国内用户的常见改键点，本项目不能踩。
- 键位登记进 `core/editor-keybindings.js` 键位表（JetBrains / VSCode 两风格都要有，`src/editor/editor-keybindings.js` 负责重绑到 Ace CommandManager）——命令名 `startAutocomplete`。
- live 模式（`enableLiveAutocompletion`）为设置可选项，**默认关**；打开后每键触发候选（Ace 内置节流外，completer 内部再加 debounce，见 §6.3）。
- 弹层内交互用 Ace 默认：↑↓ 选择、Enter 确认、Tab 插入、Esc 关闭——与「对齐 JetBrains」键位风格一致，无额外定制。
- 插入行为注意：YAML/TOML/INI 的值候选插入必须尊重会话缩进单位（`session.getTabString()`），避免补全破坏缩进。

### 4.3 候选打分

- 排序：前缀命中 > CamelHumps > 子串 > 中缀；同档按出现序。实现进 `core/completion.js` 纯函数，口径与命令面板模糊匹配对齐（具体算法实施时从 palette 侧对齐或独立实现，以测试锁定行为）。
- 候选形状走 Ace 原生 `{caption, value, score, meta, completer}` + `getDocTooltip`（P2 起）。
- ~~图标：在 `core/icons.js` 注册 completion-* 命名项~~ **实施偏离（见 §15）**：Ace 弹层行渲染没有图标槽位（行内只有 caption + meta 文本），改渲染器属侵入 vendored 行为——类型区分改用 meta 文本（表/视图/列类型/键/段/SQL/文档），未新增 icons.js 条目。

### 4.4 能力探测与降级

- 启用前探测：`window.ace && typeof window.ace.require === 'function' && window.ace.require('ace/ext/language_tools')` 存在才挂；探测失败**静默降级为无补全**（尽力而为路径，catch 注明忽略原因——补全缺失不属于「用户可见错误」，不打 flash 不弹窗）。
- 该依赖来自 jsoneditor bundle 的内部结构，**升级 jsoneditor 时必须回归本功能**（登记进 §11 风险清单）。

---

## 5. P0：SQL 控制台补全

### 5.1 前置：textarea → Ace（探针先行，路线二选一）

**步骤 0（半小时）：写最小探针验证 `typeof window.ace.edit === 'function'`**——jsoneditor bundle 暴露的 `window.ace` 是否带独立 `edit()` API 决定路线：

- **路线 A（推荐，探针通过）**：SQL 控制台直接 `window.ace.edit(container)` + `mode-sql`，容器沿用 `ace-mode-sql` class 钩主题。附带收益：SQL 语法高亮、只读态/键位与文件编辑器同构。**禁止再加载第二份独立 ace 核心文件**（会与 jsoneditor 内置 `window.ace` 冲突）。
- **路线 B（探针失败）**：保持 textarea，补全弹层自绘——交互契约抄 @ 成员补全先例（弹层定位 / 键盘导航 / 胶囊镜像思路，`docs/finished-plans/ai-group-chat.md`），无语法高亮；「SQL 控制台 Ace 化」另立决策（涉及 vendor 策略，需作者批准，不在本文拍板）。

两路线的 completer / 缓存 / 测试契约完全一致，差异只在宿主控件与弹层渲染层。

改造注意（db-query-editor.js 有在途改动，动手前协调）：Ctrl+Enter、防重入、确认横幅失效、`runBtn.disabled` 四个既有行为逐一回归；`db-tab.js` 布局三栏尺寸不回归。

### 5.2 SQL completer 契约

- **关键词层**：sqlite / mysql 两套方言关键词表（表驱动常量，可独立成文件豁免行数红线；Ace `mode-sql` 的方言关键字表可作种子，实施时核对 vendored 版本 API，否则内置精简表）。按 `SessionInfo.kind`（sqlite→`DBOpen`、mysql→`DBConnect`，`db-tab.js:119-121`）选表。
- **标识符层**：表/视图候选来自 `DBListObjects`（首次弹出触发一次，缓存）；列候选来自 `DBDescribe`。
- **点号上下文**：光标前缀解析（纯函数，进测试）——
  - `ident.` → 该表列候选；`db.ident.` → 跨库列候选（mysql）；
  - 别名解析：`FROM tbl AS a` / `FROM tbl a` / `JOIN tbl a` 基础形态，别名 → 真实表 → `DBDescribe`；
  - 解析不出表（如 `SELECT * FROM ` 刚敲完）→ 降级为对象清单候选。
- **无上下文**：词首（≥1 字符）给 关键词 + 表/视图 + 当前 SQL 中已出现表的列 的合并集。
- **失败降级**：任何元数据请求失败（断连 / 空闲回收 / 插件驱动不支持）→ 静默回落纯关键词，不打断输入。

### 5.3 元数据懒聚合缓存（db-completion 内部）

- 按会话缓存：`sessionId → { objects, columnsByTable: Map }`；单飞（同表并发 `DBDescribe` 只发一次）。
- 失效时机：`setSession` 换会话 / disconnect；`DBQuery` 返回含 DDL（`QueryOutcome.statements/writes`，Go 侧 `classifyStatement` 已分类）→ 失效该会话全部列缓存；写网格 `DBApplyChanges` 不失效（不改 schema）。
- **不新增 Go 绑定**（无 mock-backend 义务）；预热不后台批量拉全库——只对当前 SQL 里出现过的表按需 `DBDescribe`，与「无索引」定位一致。

### 5.4 验收标准

1. SQL 控制台有语法高亮（路线 A）；Ctrl+Enter / 取消 / 两阶段确认行为零回归。
2. `FROM ` 后弹表/视图；`表.` 后弹列（含类型 meta）；词首弹关键词；Ctrl+Space / Alt+/ 手动触发可用；Esc 关闭。
3. 会话切换 / 断连后候选降级为关键词且无报错；dev mock 模式下全流程可演示。
4. 同表重复触发不再发 `DBDescribe`（缓存命中）；含 DDL 的查询执行后列缓存已失效。
5. `go build` 无改动、`npm test` 全绿（含新测试）。

---

## 6. P1：文件编辑器补全

### 6.1 接线点与启用判定

- 挂点在 `editor-ace-hooks.js`（Ace 会话钩子域）：`applyAceMode` 旁挂一次 completer 注册；`getCompletions` 内部按 `aceModeFor` 结果分流。
- 启用判定：`settings.completion.files === true` 且 `!isDocReadOnly(doc)`（`core/readonly.js` 单一来源）且非写作模式。**只读 doc（含大文件只读档）一律不挂**——与 `setReadOnly` 同一判定口径。
- 虚拟文本 doc（untitled / 计划 / scratch）走通用编辑器，自动获得词法补全，不特殊处理。

### 6.2 按格式 completer

| 格式 | 候选来源 | 备注 |
|---|---|---|
| JSON / JSONL | 全文档 key 词表（一期简化；同层兄弟 key 感知列 P2） | key 词表与值词法合并去重 |
| YAML | key 词表 + 值词法 | 插入尊重缩进单位 |
| XML / SVG | 文档内标签名 + 属性名 | 闭合标签由 Ace xml mode 自理 |
| TOML / INI / Properties | 段名 + 键词表 | 插入尊重缩进 |
| 其余全部（含 .go/.py/.js…） | 关键词层（§6.5，零成本顺带）+ 全文档词法兜底 | 仅关键词/词法级，不承诺语义 |

- 词法兜底：≥3 字符词去重词表；来源即当前文档文本。
- **词表是全局注册 completer 的内部分流，不在 `formats.js` 加新格式分支**（formats.js 只继续回答 mode 映射）。

### 6.3 大文档限流

- 词表构建上限：文本 > 2 MB 或去重词 > 8000 → 只扫光标附近窗口（前后 ~1000 行），候选取窗口内词。
- 缓存与失效：词表按 doc 会话缓存，`change` 事件 debounce ~300ms 后标记失效、下次触发重建；live 模式下 completer 内部再加 ~150ms debounce。
- JSON key 表大文档同样限流（>1 MB 时降级为仅词法）。

### 6.4 验收标准

1. 编辑非只读 JSON/YAML/XML/TOML/INI/文本时 Ctrl+Space 出候选；只读 doc、大文件只读档无补全。
2. 词法兜底在所有文本模式可用；markdown/scratch 文档获得词法补全。
3. live 开关关闭时每键不弹；打开后行为正常可关回。
4. 写作模式、AI composer、CSV 网格、diff/对比窗不受影响（无全局副作用）。
5. 2 MB 文本（构造样例）触发补全 < 100 ms（词表命中缓存时）。

### 6.5 多语言支持的处理原则（2026-11-22 补记）

「多语言」不按语言数摊（44 个 mode ≠ 44 份适配），按**编辑强度**分三层。实现形态是「2 个结构 completer + 1 个关键词 completer + 1 个词法兜底」吃下全部 mode，而不是 44 份语言适配：

| 层 | 覆盖 | 候选来源 | 成本 |
|---|---|---|---|
| 结构感知（P0/P1 已覆盖） | SQL、JSON/JSONL/YAML/XML/TOML/INI | DB 元数据 / 当前文档结构 | §5 / §6.2 契约 |
| 关键词层（零成本顺带） | 全部编程语言 mode | Ace mode 高亮规则自带的关键词表（**实施实测：vendored mode 无 `$keywordList`**，python/js/go 均 0 命中——探测代码保留，有该表的 mode 自动带上；SQL 控制台用手写方言语法表） | ~1 个 completer |
| 词法兜底 | 全部文本模式 | 当前文档词表（§6.2） | 已含 |

**治理规则（新增 per-language completer 的准入条件，防止膨胀成 44 份适配）**：

1. 该语言用户在本应用里**真的「写」得多**（SQL 之于查询、配置格式之于数据文件）；只看或偶尔改的语言一律词法兜底。
2. 候选数据必须来自**客户端已有数据**（文档内容 / Ace mode 关键词表 / DB 元数据）。**语言关键词表（小、稳定、语法级）允许手维护或从 mode 提取**（P0 的 sqlite/mysql 方言表即此性质）；**API/stdlib 词典（大、常更新）禁止手维护**——必腐化，且是变相索引；禁止为某一种语言引入依赖、词典文件或 LSP。

**明确不做**：HTML/CSS 的 emmet 类展开（新依赖）、snippet 库（`vendor/ace/` 只随包了 44 个 mode 文件，snippet 文件未随包，新增 vendor 文件走例外流程，P2 也不建议）、各语言 stdlib API 表。

---

## 7. P2：体验打磨

- 打分统一：`core/completion.js` 打分函数与命令面板口径对齐，CamelHumps / 中缀支持补齐。
- Quick doc：`getDocTooltip` —— SQL 列给 `type / pk / notNull / default`（`DBDescribe` 现成字段）；JSON key 出现次数。
- 候选图标：§4.3 注册表项接入弹层渲染。
- 设置收口：§8 三个开关全量落位 + 设置树反射（`settings-tree` 扫 DOM）验证。

---

## 8. 设置项

`settings.completion = { files: true, sql: true, live: false }`，设置树编辑器相关节三行 `createSwitch`（表单硬规范；基线不调大）：

| 行 | 默认 | 说明 |
|---|---|---|
| 文件编辑器代码补全 | 开 | P1 总开关 |
| SQL 控制台代码补全 | 开 | P0 总开关 |
| 输入时自动弹出 | 关 | live 模式；关=仅 Ctrl+Space / Alt+/ 手动 |

- 持久化与跨窗同步只走三通道（`applySettings` / `persistSettingsLight` / `applyRemoteSettings`）；属偏好键，默认同步，**不**登记 `PER_WINDOW_LAYOUT_KEYS`。
- 开关只控制「挂/不挂」，不做运行时热卸载复杂逻辑：切换后对新聚焦的编辑器生效即可（与 `applySettings` 全量重绘节奏一致）。

---

## 9. 改动面清单

| 文件 | 动作 | 规模预估 |
|---|---|---|
| `frontend/src/core/completion.js` | **新增**：打分 / 词提取 / 归一化纯函数 | ~300 行 |
| `frontend/src/editor/editor-completion.js` | **新增**：文件侧接线 + 格式分流 completer | ~400 行 |
| `frontend/src/db/db-completion.js` | **新增**：SQL completer + 点号上下文解析 + 元数据缓存 | ~500 行（关键词表独立常量文件不计红线） |
| `frontend/src/editor/editor-ace-hooks.js` | 追加：completer 注册挂点（几行） | 微 |
| `frontend/src/db/db-query-editor.js` | P0：textarea → Ace（路线 A）或弹层宿主（路线 B） | ~100 行增改 |
| `frontend/src/db/db-tab.js` | 追加：注入 db-completion 依赖 + 缓存失效钩子 | 微 |
| `frontend/src/core/editor-keybindings.js` | 追加：`startAutocomplete` 两风格键位 | 微 |
| `frontend/src/style.css` | 追加：`.ace_autocomplete` 弹层样式（并入 4261-4510 主题区） | ~60 行 |
| `frontend/src/core/icons.js` | 追加：completion-* 图标注册项 | 微 |
| `frontend/src/settings/settings-ui.js` | 追加：`settings.completion` 默认值/归一化 + 三行开关 | ~60 行 |
| `frontend/index.html` / vendor | **不动**（路线 A/B 都不新增 vendor 文件） | 0 |
| Go 侧 / mock-backend | **不动** | 0 |

- `main.js` 仅在组合根接线 `editor-completion`（getter 注入），无域逻辑回填。
- 超线存量文件（`ai-panel.js`、`main.js`）不承载任何本功能逻辑。

---

## 10. 测试计划（全部登记 `npm test` 清单）

| 测试文件 | 覆盖 |
|---|---|
| `frontend/test/core/completion.test.mjs` | 打分排序（前缀/CamelHumps/子串/中缀）、词提取、限流上限、归一化 |
| `frontend/test/db/db-completion.test.mjs` | 点号上下文解析、别名解析、方言关键词表选择、缓存单飞与失效（DDL / 换会话）、失败降级 |
| `frontend/test/editor/editor-completion.test.mjs` | 接线：只读 doc 不挂、能力探测失败静默降级、按 aceMode 分流、live 开关行为 |

- 护栏自检：`no-src-tests`（测试只进 `frontend/test/`）、`form-controls-factory`（开关走工厂，基线不调大）、`icon-guard`（图标先进注册表）、`overlay-esc-guard`（不写全局 Esc 监听）。
- 收尾：用户可见变更进 `CHANGELOG.md` + README 编辑器小节；全部实施后本文移入 `docs/finished-plans/`。

---

## 11. 风险与护栏

1. **`window.ace.edit` 探针结果未知（P0 唯一分叉点）**：路线 B 保底可用（自绘弹层，交互先例现成）；无论哪条路都**不允许加载第二份 ace 核心**。探针失败且想要高亮时，须先另评「单一 ace 实例」问题（vendor 策略 + 作者批准）。
2. **language_tools 来自 jsoneditor bundle 内部结构**：升级 jsoneditor 可能移除/改形 → 能力探测 + 静默降级兜底；把「升级 jsoneditor 回归补全」写进升级检查项。
3. **Ctrl+Space 与中文 IME 冲突**：Alt+/ 第二键 + 设置总开关兜底；README 说明改键入口。
4. **db 域并行改动**：`db-query-editor.js` / `db-tab.js` 当前有未提交改动——动手前与在途会话协调，**只追加不回退**（AGENTS.md「未提交的改动不是可丢的东西」）。
5. **live 模式性能**：词表缓存 + 双层 debounce + 硬上限（§6.3）；2 MB 样例进测试。
6. **期望管理**：通用编程语言仅词法级。README / CHANGELOG 文案把补全卖点绑定在「SQL 控制台 + 数据格式文件」，不宣传「IDE 级语义补全」。
7. **「无索引」定位自检**：不做后台批量预拉全库元数据、不做跨文档词表、不做持久化补全缓存文件——补全数据只活在前端内存与既有会话里。

---

## 12. 边界（明确不做）

- ❌ LSP / 跨文件索引 / 语义补全（政策否决，见 §3.3）。
- ❌ AI ghost text 内联补全——**本文不立项**；预评估结论与手动触发 v1 路径见 §14。
- ❌ snippet / live template 管理 UI（Ace snippets 引擎在包内，本期不暴露）。
- ❌ CSV/TSV 网格内补全（表格域，非文本补全场景）；`db-table-grid` 结果网格同理。
- ❌ 写作模式、AI composer / 群聊输入框（各自已有阅读/斜杠/@ 体系，不混入）。
- ❌ diff / 对比窗 / 只读视图（只读判定已天然排除）。
- ❌ 后台全库元数据预热（违背无索引定位，见 §11.7）。

---

## 13. 工作量汇总

| 阶段 | 内容 | 估计 |
|---|---|---|
| P0 | 探针 + textarea→Ace 迁移（0.5–1 天）；SQL completer + 缓存（1–1.5 天）；测试回归（0.5–1 天） | **2–3 天** |
| P1 | completer 注册 + 词法兜底（1 天）；JSON/YAML/XML/TOML 分流（1–1.5 天）；设置项 + 测试（0.5–1 天） | **2–3 天** |
| P2 | 打分统一 / quick doc / 图标 / 收口 | **1–2 天** |
| P3 v1 | 手动触发 AI 补全试探（先延迟探针，见 §14；自动 ghost text 视探针另评） | **1–2 天** |

依赖关系：P0 与 P1 互相独立（P1 不依赖路线 A/B 结果），可只做其一；P2 建议最后一批；P3 v1 建议在 P1 落地后试探。

---

## 15. 落地与偏离记录（2026-11-22 实施）

- **路线 A 落地**：探针通过——`window.ace.edit` 存在、`startAutocomplete` 命令在 bundle 内、`enableBasicAutocompletion` setter 支持数组 completer（`Array.isArray(e)?e:m`）且启用时自动挂 Ctrl+Space 命令。
- **候选图标撤下（偏离 §4.3）**：Ace 弹层行渲染没有图标槽位（无 icon 类，行内只有 caption + meta 文本），改渲染器属侵入 vendored 行为——类型区分改用 meta 文本（表/视图/列类型/键/段/SQL/文档），`core/icons.js` 未新增条目。
- **关键词层（§6.5）实测**：vendored mode 文件无 `$keywordList`（python/javascript/golang 均 0 命中）——文件编辑器实际为「结构感知 + 词法兜底」两层，`modeKeywords` 探测代码保留（有该表的 mode 自动带上）；SQL 控制台关键词为手写方言语法表（方案允许的语法级表）。
- **quick doc 提前**：`getDocTooltip` 给 SQL 列候选附 类型 · 主键 · NOT NULL · 默认值（P2 内容随 P0 一起落地）。
- **词表节流落地**：session 级缓存 + 双阈值（脏标记后 300ms 内复用旧表，3s TTL 重建），方案 §6.3 的节流即此实现。
- **测试基建**：npm test 清单过 240 文件后超出 Windows cmd 8191 字符上限（「命令行太长」整批不跑），拆 `test:ai` / `test:ui-core` / `test:ui-shell` 三子脚本串行（失败即停），`test-manifest` 守卫改扫全部 script 并集（双向核对 + 禁重复登记语义不变）。
- **实现期抓出的两个真 bug**（测试先行验证价值）：`loadObjects` 首飞返回被置 null 的 promise（首次弹窗丢对象清单）；列缓存键与 `objectsDb` 落定存在竞态（先拉对象再拉列，键才稳定）。
- **验收**：新增 36 例（core 13 / editor 8 / db 15），前端全量 2445 例绿；`npm run build` 通过。

### 15.1 三代理并行审查后的修复（2026-11-22 同日）

审查分三路：逻辑与单测（对抗实验）/ 规范合规（AGENTS.md 红线逐条 + 守卫测试）/ 运行时契约（vendored bundle 逐条核验）。规范路全绿零违规；另两路各抓到 2 个 P1，全部修复：

1. **quick doc 原是死代码（运行时契约）**：bundle 的 tooltip 查找要求 `候选.completerId === completer.id`，自定义 completer 的候选没有该字段 → `getDocTooltip` 永不被调。修复：列候选**直接携带 `docText`**（bundle tooltip 兜底渲染候选自带的 docText），`getDocTooltip` 整个移除（文件侧 completer 同理，本无 tooltip 数据）。
2. **弹层主题 CSS 大半失效（运行时契约）**：弹层容器挂在 `document.body` 且继承编辑器主题类（恒不带 ace_dark），bundle 运行时注入的 `.ace_editor.ace_autocomplete`（0,2,0 白底）压过原 `.ace_autocomplete`（0,1,0）。修复：选择器抬到 `.ace_editor.ace_autocomplete`，背景/文字/边框/阴影/高亮色加 `!important`。
3. **loadObjects 空库/失败结果被永久缓存（逻辑）**：`[]` 为 truthy，「失败置 null 允许重试」是死代码；并发第二调用者拿空数组不等在途 promise。修复：空结果不缓存（保持 null 下次重试）+ 并发等待在途 promise。
4. **getSession 抛异常时 callback 调用 0 次（逻辑）**：catch 分支二次调用 getSession 且无保护。修复：入口一次取（异常按无会话降级）+ `done` 标志保证 callback 恰好一次。
5. **noCache 单飞竞态（逻辑）**：describe 在途时 DDL 落地，下一轮复用旧 pending → 失效被吞、旧 schema 缓存到会话结束。修复：`metaEpoch` 代次（在途旧请求完成时不再写缓存）+ `pending.clear()` + needsFresh 改由「真正发出 noCache 请求」的完成回调复位（复用旧 pending 的轮次不复位）。
6. **顺手收敛的 P2**：JSON 键与文档词重复候选 → caption 去重（结构层先到先得）；ALIAS_STOP 补 except/intersect/minus；点号链不可解析（≥3 段）回退关键词层（弹层不再消失）；matchFilter 非法 limit / extractWords 非法 minLen 钳制；SQL 控制台 placeholder 文案与 textarea 对齐；空 catch 补忽略原因注释。
7. **测试 36 → 39 例**：新增 getSession 抛异常（恰一次回调）、空库重试（DBListDatabases 二次真实发出）、DDL 与在途描述竞态（旧结果不写缓存 + 下一轮 noCache）。
8. **文档自洽修正**：§9「index.html 不动」指 vendor/资产层面，设置三行按 §8 落在 index.html；§4.1 草案名 `createEditorCompletion` 实际落地为 `setupEditorCompletion`；接线走**同域直 import**（editor-ace-hooks→editor-completion、db-query-editor→db-completion），非 main.js getter 注入——依赖方向仍合规（同域）。
9. **已知边界（接受并记录）**：YAML 块标量内的缩进行会误报为键（词法容错代价）；`isDdlSql` 词边界扫描会被名为 comment 的列/字符串字面量误判（多一轮无害刷新）；引号/中文名表名与 ≥3 段点号链不解析（回退通用候选）；设置开关对已挂载编辑器不热生效（§8 豁免，重开标签/切模式/重启后生效）；**text 视图不挂补全**（applyAceMode 门槛只放行 code/binary，text 宿主是否 Ace 待真机确认后另评）。
10. **审查后回归**：39 例新测试全绿；规范路 56 例守卫绿；运行时路 61 例邻域回归绿。

### 15.2 实机反馈修复（2026-11-22 同日）

真机跑起来后四条反馈，全部处理：

1. **JSON 解析错误托盘（图1，编辑器底部）**：酱色红底真凶 = jsoneditor 原生 `.jsoneditor .jsoneditor-text-errors tr.parse-error { background-color: rgba(238,46,46,.44) }`——特异性 (0,3,1) 压过普通 tr 覆盖（44% 红叠暗底即截图酱色）；首版只覆盖了普通 tr 所以没杀干净。现代化：覆盖 parse-error 变体（!important）+ 杀原生黄顶线（#ffc700→--border）+ 面板底色（panel2）+ 行 hover + 跳行 accent + 报错文本编辑器字体 + 「Ln N」列 mono 弱化；红 X 图标 sprite 保留，结构与跳行交互不动。
2. **弹层 JetBrains 化（图2/3 对齐图4/5）**：行首类型图标——meta 文本 → `iconSvg` 装饰（关键词/SQL=`code`、键=`braces`（新登记）、段=`structured-dir`、标签=`tag`、属性=`rename`、文档=`doc`、表=`view-table`、视图=`eye`、SQL 列类型=默认 `database`）。**装饰挂载的实机验证教训**：最初挂在 setup 时 `popup.renderer.on('afterRender')`——实测 setup 时 `completer.popup` 尚为 null（popup 在首次 showPopup 时才创建，Hook 静默落空）且 popup renderer 根本不发 afterRender 事件；改为 getCompletions 内惰性挂 MutationObserver（popup 未就绪则 setTimeout 重试一次并装饰已渲染行），机制与 python token 补色同款。配套行距/8px 圆角/选中行底色/meta 弱化（ui-font 11.5px）。**配色通道（2026-11-23 引入、2026-11-28 实机反馈否决回退）**：曾改跟编辑器代码主题走（`--editor-bg`/`--editor-text`/`--ace-selection`/`--ace-gutter`）——用户实机验证否决：深色界面配浅色代码主题（github-light 的 `--editor-bg:#fff`）时弹层白底刺眼，「深色模式下弹的面板竟然是白色」。**最终口径：弹层配色跟界面主题走**（面板底 + 界面文字 + hover 选中行 + faint meta），与 tooltip/菜单等应用浮层同惯例——深色界面下弹层恒为深色，代码主题只影响编辑器区与语法 token、不影响弹层。教训：JetBrains「弹层跟编辑器配色」成立的前提是编辑器配色方案与 UI 主题一体（JetBrains 没有本项目这种「UI 主题 × 代码主题」二维分离）；在分离体系里浮层应跟 UI 主题。JetBrains 的底部快捷键提示条未做（需自管 popup 兄弟节点定位，投入产出低，需要时另评）。
3. **「输入时自动弹出」默认关（作者要求的「默认开」实施后回退）**：实机验证发现 **vendored bundle 的 live afterExec 路径不可靠**——最小 completer（与本项目代码无关）+ live:true 也复现渲染冻结，真实键入后 `ed.completer` 未创建（live 处理器未走通）；按「默认开」实施后回退默认关，开关保留、语义 `===true`，设置变更热生效的接线保留。待升级 vendored Ace/jsoneditor 后重新评估 live。
4. **「打开开关后已开编辑器不自动弹」（根因）**：live 选项只在编辑器创建时快照，开关变更不作用于已挂载编辑器（审查报告 §15.1 第 9 条的已知边界，用户实锤命中）。修复：`editor-completion.js` 新增 `refreshCompletionSettings(entries, settings)`（已挂载只翻 live 选项、未挂载按需补挂；关 files 仍不做热卸载），main.js 组合根接线 `applyCompletionSettingsToAllDocs`（镜像键位 `applyToAll` 模式遍历 docs），settings-ui `applySettings` 调用——启动时 docs 为空无副作用，跨窗广播后的 applySettings 也自然覆盖远端窗口。bundle 实锤 live 机制存在（`enableLiveAutocompletion:{set:…commands.on("afterExec",o)}` + `liveAutocompletionThreshold` 默认 0），但见第 3 条的路径问题。
5. **测试 39 → 41 例**：normalize 默认值翻新、热生效（已挂载翻 live / 未挂载补挂）、弹层行图标装饰（stub DOM，幂等 + 无 meta 跳过 + 未知 meta 走默认）。
6. **图标合规**：`braces` 先登记 `core/icons.js` 注册表再使用；行图标经 `iconSvg()` 注入，非 CSS 内联 svg/影子表（icon-guard 口径）。

---

## 14. 附：P3 AI 内联补全（ghost text）预评估（2026-11-22 补记）

> 来源：评估讨论中「AI 助手已是现成的，ghost text 应该也挺便宜」的追问。结论：**依赖确实现成、0 新依赖，但「便宜」不成立**——成本不在依赖，在三处错配（§14.2）。本节为预评估，不改变「本文不立项」的边界（§12）。

### 14.1 复用盘点（诚实版）

| 可复用（薄薄一层） | 复用不了（形状不同） |
|---|---|
| provider 配置存储与 HTTP 管线（base URL / key / auth） | 会话体系（JSONL 会话、消息队列、回合生命周期）——补全是**无会话单发小请求** |
| `ai-usage-quota` 配额统计钩子 | 系统提示词 / 工具链 / 审批链——补全没有工具调用、没有审批动作 |
| settings 通道、模型清单、调试日志 | 流式渲染进面板的整条链——ghost text 渲染目标是编辑器光标处，不是消息卡片 |

真正的新工程：**Ace 没有原生 ghost text**——灰色文本渲染（marker/decoration）、Tab 接受、Esc 取消、每次击键取消上一发请求的竞态与缓存，全部自建，落编辑器域（与 §4.1 依赖方向一致，AI 域管线经 deps 注入，不反向 import）。

### 14.2 三处错配（为什么不是「调一下 AI」）

1. **延迟错配（致命项）**：ghost text 的体验期望是击键停顿后 <500 ms 出灰字；chat 网关类模型首 token 通常 1–5 s（推理型更慢）。这是模型属性，**代码救不了慢模型**——体验上限锁死在所配 provider 上。→ 必须先做延迟探针：拿网关最快的非推理小模型实测首 token，**>1.5 s 则自动 ghost text 不立项**。
2. **调用形状与成本错配**：聊天是一次会话几发请求；补全是每次键入停顿一发（debounce ~1 s），活跃编辑一小时几十上百发。配额统计需要独立「补全小模型」档位与用量展示，不能拿主力模型配额硬扛。
3. **隐私与质量错配**：光标上下文（本地数据文件内容）在用户**没有显式动作**时持续外发到 provider——需要独立明示授权开关（授权语义与 `docs/finished-plans/read-outside-workspace.md` 同级，不能搭聊天审批的便车）；且现有配置多为 chat/推理模型，补全理想形态是 FIM（fill-in-middle）小模型，用 chat 模型 prompt hack 质量打折。

### 14.3 便宜版：手动触发 v1（推荐的试探路径）

把「自动 ghost」降级为「**手动触发**」（如 Alt+\ 或快捷键呼出）：

- 用户主动请求 → 等 1–3 s 可接受，延迟错配大幅缓解；
- 无每键停顿触发 → debounce / 请求竞态 / 调用量三件套的大半复杂度直接砍掉；
- 复用同一 provider 管线，估计 **1–2 天**（探针 0.5 天内先行）。

结论建议：P1 落地后做手动触发 v1 试探；自动 ghost text 视探针数据另评（模型够快才值得投入 3–5 天做完整自动体验）。

### 14.4 与本地补全的分工（一句话）

P0+P1 花 5–8 天买到的是**离线、0 成本、即时**的补全；AI ghost text 花 3–5 天买到的是**取决于模型**的体验。两者互补不互替：本地补全负责「记住已有名字」，AI 补全负责「写出下一行」。
