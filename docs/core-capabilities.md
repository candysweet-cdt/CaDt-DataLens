# core 通用能力清单：写新代码前先查这里

> 2026-11-23 两轮代码收敛后建立。目的：把「通用能力该放哪、禁止重复形态」写成一张可查的表，配合护栏测试（见下）把「靠人记得」变成「机制兜底」。
>
> **使用约定**：写任何工具函数前先扫一眼这张表——如果 core 已有，直接 import，不要再写一份。新增通用能力时，先建 core 模块 + 测试，再把本表对应行补上。

## 已有通用能力（写新代码前先查）

| 能力 | 唯一来源 | 何时用 | 禁止的重复形态 |
|---|---|---|---|
| HTML 转义 | `core/escape.js` `escapeHtml` | 拼 `innerHTML` 的文本/属性，5 实体全转 | 业务模块里再写 `function escapeHtml`（护栏 `utility-duplication-guard` 拦） |
| 字节/时间人可读 | `core/humanize.js` `formatBytes` / `formatFullTime` / `relativeTime` | 体积、时长、相对时间展示 | 局部 `formatBytes`/`humanBytes`/`aiFormatBytes`/`relativeTime` 实现（委托包装可保留旧名） |
| 图标 | `core/icons.js` `iconSvg` | 所有通用 UI 图标 | 内联 `<svg>`、局部图标表、MDL2 码位（`icon-guard` 拦） |
| 表单控件 | `core/form-controls.js` `createSwitch/createCheckbox/createSelect/createInput/createTextarea/createNumber/createSlider/createPathInput` | 动态创建控件（数字步进 / 滑杆含 segments 分段 / 路径+浏览按钮） | 裸 `<input>/<select>/<textarea>`（`form-controls-factory` 拦） |
| 弹层注册 | `core/overlay-stack.js` `overlayStack.open` | 对话框/模态/popover/菜单/灯箱 | 自挂全局 Esc 监听（`overlay-esc-guard` 拦）；自挂 document 外点关闭监听（`outside-click-guard` 拦） |
| 浮层定位 | `core/popover-position.js` `placePopover` | 锚点浮层的视口钳制/翻转 | 局部手写 `Math.max(8, Math.min(rect.left, ...))` |
| 对话框拖动 | `core/dialog-drag.js` `createDialogDrag` | 对话框头部拖动 | 埋在某个业务模块里的 `startDialogDrag` |
| DOM 工厂 | `core/dom.js` `el` / `btn` | 建元素+类名+文本 | 局部 `function el(tag, cls, text)` |
| 短 id | `core/id.js` `newId` / `randomIdSuffix` | 会话/书签/抽屉等短 id | `Date.now().toString(36) + Math.random()...` 手拼 |
| JSON 容错解析 | `core/json-safe.js` `parseJson` | 读 localStorage/磁盘 JSON，失败回 fallback | `try { JSON.parse(x \|\| '[]') } catch {}` 内联 |
| localStorage 读写 | `core/kv-store.js` `kvGet/kvSet/kvGetJson/kvSetJson/kvRemove` | 键值持久化（不认识业务 key） | 散落的 try/catch 读写（settings 三条同步通道除外） |
| 持久化键名 | `core/storage-keys.js` 键名常量 + `draftLSKey/wsDraftLSKey/windowSessionKeyOf/schedFireKey` | 任何 localStorage / 快照键的**定义**与拼接 | 业务模块里写字面量键或自己拼前缀（护栏 `storage-key-guard` 拦）；camelCase 的**设置字段**不是键，不进这里 |
| 文本剪贴板 | `core/clipboard.js` `copyTextToClipboard` | 复制文本（先 Go 绑定后 Web API） | 局部 `copyText` / 裸 `navigator.clipboard.writeText` |
| 路径归一 / 比较 | `core/path-key.js` `legacyPathKey` / `fsPathEquals` / `fsPathContains` / `relativeToFsRoot` | 文件系统路径的 key 生成、相等判断、目录段包含、求相对路径 | 内联 `replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase()`；手写 `startsWith(root + '/')`（护栏 `path-key-guard` 拦） |
| 窗口模式 / 会话根判定 | `core/root-scope.js` `isMultiWorkspace` / `sessionHasWorkspace` | 判断单/多工作区窗口、会话是否有工作区归属（三态） | 直接读 `window.__harnessWindow`（护栏 `root-scope-guard` 拦） |
| 会话状态判定 | `ai/session/ai-session-scope.js` `isArchived/isSideChat/isUnboundSession/isWorkspaceEligibleSession` | 单个维度的会话谓词（归档 / 支线 / 不绑工作区 / 可作候选） | 手写 `isTransientSession(x) \|\| isNoWorkspaceSession(x)`、裸真值判 `archivedAt` / `sideOf` |
| 会话忙 / 起轮门禁 | `ai/session/ai-session-scope.js` `createSessionBusyProbe` / `canStartTurn` / `canSendMessage` | 任何「这个会话忙不忙 / 现在能不能起一轮 / 发送按钮该不该禁用」 | 手写 `streamOf(id) \|\| compactOf(id)`；四处各写一套发送门禁（UI / 内核 / 编辑重发 / 队列冲刷口径必须同源） |
| 附件 → 起轮载荷分组 | `ai/chat/ai-quote.js` `groupAttachmentsForTurn` | 把附件拆成 `images` / `videos` / `texts`（媒体分组、引用与 null 不进文本附件），喂给 `startSessionTurn` | 手动发送 / 排队冲刷 / 原地编辑各写一份 `filter(kind === 'image')` 分组（2026-11-27 收口，护栏 `ai-quote.test.mjs`） |
| 可过滤下拉 | `core/combo-select.js` `createComboSelect` | 输入过滤 + 候选面板的 combobox（过滤复用 `completion.js` 的 `scoreMatch`、副标题降权；面板 body 挂载 + placePopover；外点/Esc 归 overlay-stack） | 复制 settings-select 的 Portal DOM、自挂外点/Esc 监听、再写一份过滤打分 |
| 胶囊徽标 | `core/badge.js` `createBadge` | 五档语义色小标记（`.mi-badge` + tone 类，基类即 accent 档） | 新写一份同形异名徽标 CSS 类；业务代码手拼 `mi-badge` 加色值 |
| 空状态占位 | `core/empty-state.js` `renderEmptyState` | 「无会话/无文件/无结果/无记录」占位（icon 圈 + 标题 + 提示 + 可选动作按钮） | 各域手绘空态 DOM、新写一份 empty 样式类 |

## 语义相近但**不算**重复（别误合并）

- `ai/core/ai-persona.js` 的 `escapeXmlText`、`bridge/memo-docx.js` 的 `escapeXml`：给模型/docx 的 XML 转义（只转 `& < >`），非 HTML innerHTML
- `shell/plugin-context.js` 的 `escapeAttr` / `escapeClosingTag`：插件上下文防注入，非 HTML
- `core/layout-render.js` / `core/wordcloud-render.js` 的 SVG 文本转义：图表产物
- `core/markdown.js` 用的 `markdownRenderer.utils.escapeHtml`：markdown-it 自带，安全链的一部分
- `editor/structure.js` 的 `parseJson`：JSON 语法高亮 tokenizer，不是容错解析
- **路径归一的「同形不同义」（2026-11-26 普查确认，不要合并）**：
  - `ai/session/ai-session-scope.js` 的 `normalizePath` / `workspaceKey`：解析 `.`/`..`、保留 scheme 与盘符；输出是 Go `WorkspaceBucketKey` 的 sha256 输入，改一字符就换磁盘分桶（有跨语言测试锁死）
  - `ai/security/ai-wipeguard.js` 的 `normalizeWsKey`：UNC `//` 与 scheme 口径与上面**故意不同**，是 wipeguard per-root 状态表的 key
  - `ai/tools/ai-file-tools.js` 的 `normalizeLocalFilePath` / `resolveWithinRoot`：安全边界，越界必须**拒绝**而非静默归一（`..` 语义与 `legacyPathKey` 相反）
  - `core/jsonpath.js` 的 `jsonPathKey`：JSONPath 段转义（`['a\\b']`），与文件系统无关，只是形态像
  - `ai/settings/ai-cognition.js` 的 `normalizeRelKey`、`ai/security/ai-permissions.js` 的 `writeRuleSubject`：相对 key / glob subject，套绝对路径 key 会改变 `**` 匹配语义
- `shell/message-center.js` 的局部 `relativeTime`：面板专用 `MM-DD HH:mm` 紧凑格式，与 core 口径不同（已加注释）
- `shell/palette-model.js` 的 `fuzzyScore`：命令面板口径（整串 > 任意位置 > 子序列 + 中文冒号组前缀拆分），服务全屏面板形态；与 `completion.js` 的 `scoreMatch`（前缀>驼峰>子串>fuzzy，锚点下拉用）**不要互并**（2026-11-28 全仓扫查确认）
- `core/combo-select.js` 的 `.fc-combo-empty`：下拉面板内一行轻提示，不是页面级空态——别换成 `renderEmptyState` 的大块占位（icon 圈放进窄面板反而突兀）
- 交互芯片（`.dbg-chip` / `.mcfg-chip` / `.ai-pill` / `.ai-paste-pill` 等，可点/可移除）与方形首字徽标（`.ws-project-badge` / `.pp-badge`，avatar 形态）：不是 `createBadge` 的语义色胶囊，勿收编
- AI 技能文档内嵌的 `.badge ok|no|warn`（`ai/core/ai-constants.js`）：渲染给模型看的技能 HTML 文档，非应用 UI

## 护栏测试（新代码违反即红）

| 护栏 | 管什么 |
|---|---|
| `test/core/utility-duplication-guard.test.mjs` | escapeHtml / formatBytes 只在 core 定义 |
| `test/core/outside-click-guard.test.mjs` | document 级外点关闭走 overlayStack |
| `test/core/overlay-esc-guard.test.mjs` | 全局 Esc 走 overlayStack |
| `test/core/icon-guard.test.mjs` | 图标走 iconSvg |
| `test/core/form-controls-factory.test.mjs` | 控件走 form-controls 工厂 |
| `test/core/test-manifest.test.mjs` | 新测试必须登记进 `npm test` |
| `test/core/storage-key-guard.test.mjs` | 持久化键名只在 `core/storage-keys.js` 定义（同前缀但非键的字面量逐条登记原因，只减不增） |
| `test/core/backend-constants-parity.test.mjs` | 前后端同一件事的阈值逐项相等（run_command 超时 / MCP 超时 / 补丁上限 / 会话读取 / DB 行数 / 快照节拍 / 视频 / search 分页） |
| `test/core/event-contract-guard.test.mjs` | 事件契约双向对账：前端订阅的必须有发射方、Go 发射的必须有消费者（预留项逐条登记原因，有发射方后自动红） |

**基线规则**：存量豁免按文件计数，只允许调小、不许调大；新文件出现命中直接失败。想让护栏变绿的正确做法是**用对的 core 能力**，不是加豁免。
