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
| 表单控件 | `core/form-controls.js` `createSwitch/createSelect/createInput/createTextarea` | 动态创建控件 | 裸 `<input>/<select>/<textarea>`（`form-controls-factory` 拦） |
| 弹层注册 | `core/overlay-stack.js` `overlayStack.open` | 对话框/模态/popover/菜单/灯箱 | 自挂全局 Esc 监听（`overlay-esc-guard` 拦）；自挂 document 外点关闭监听（`outside-click-guard` 拦） |
| 浮层定位 | `core/popover-position.js` `placePopover` | 锚点浮层的视口钳制/翻转 | 局部手写 `Math.max(8, Math.min(rect.left, ...))` |
| 对话框拖动 | `core/dialog-drag.js` `createDialogDrag` | 对话框头部拖动 | 埋在某个业务模块里的 `startDialogDrag` |
| DOM 工厂 | `core/dom.js` `el` / `btn` | 建元素+类名+文本 | 局部 `function el(tag, cls, text)` |
| 短 id | `core/id.js` `newId` / `randomIdSuffix` | 会话/书签/抽屉等短 id | `Date.now().toString(36) + Math.random()...` 手拼 |
| JSON 容错解析 | `core/json-safe.js` `parseJson` | 读 localStorage/磁盘 JSON，失败回 fallback | `try { JSON.parse(x \|\| '[]') } catch {}` 内联 |
| localStorage 读写 | `core/kv-store.js` `kvGet/kvSet/kvGetJson/kvSetJson/kvRemove` | 键值持久化（不认识业务 key） | 散落的 try/catch 读写（settings 三条同步通道除外） |
| 文本剪贴板 | `core/clipboard.js` `copyTextToClipboard` | 复制文本（先 Go 绑定后 Web API） | 局部 `copyText` / 裸 `navigator.clipboard.writeText` |

## 语义相近但**不算**重复（别误合并）

- `ai/core/ai-persona.js` 的 `escapeXmlText`、`bridge/memo-docx.js` 的 `escapeXml`：给模型/docx 的 XML 转义（只转 `& < >`），非 HTML innerHTML
- `shell/plugin-context.js` 的 `escapeAttr` / `escapeClosingTag`：插件上下文防注入，非 HTML
- `core/layout-render.js` / `core/wordcloud-render.js` 的 SVG 文本转义：图表产物
- `core/markdown.js` 用的 `markdownRenderer.utils.escapeHtml`：markdown-it 自带，安全链的一部分
- `editor/structure.js` 的 `parseJson`：JSON 语法高亮 tokenizer，不是容错解析
- `shell/message-center.js` 的局部 `relativeTime`：面板专用 `MM-DD HH:mm` 紧凑格式，与 core 口径不同（已加注释）

## 护栏测试（新代码违反即红）

| 护栏 | 管什么 |
|---|---|
| `test/core/utility-duplication-guard.test.mjs` | escapeHtml / formatBytes 只在 core 定义 |
| `test/core/outside-click-guard.test.mjs` | document 级外点关闭走 overlayStack |
| `test/core/overlay-esc-guard.test.mjs` | 全局 Esc 走 overlayStack |
| `test/core/icon-guard.test.mjs` | 图标走 iconSvg |
| `test/core/form-controls-factory.test.mjs` | 控件走 form-controls 工厂 |
| `test/core/test-manifest.test.mjs` | 新测试必须登记进 `npm test` |

**基线规则**：存量豁免按文件计数，只允许调小、不许调大；新文件出现命中直接失败。想让护栏变绿的正确做法是**用对的 core 能力**，不是加豁免。
