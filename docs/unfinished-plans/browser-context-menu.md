# 内嵌浏览器右键菜单改为应用样式

> 2026-11-24 立。状态：**方案待开工**。
> 起因：用户反馈内嵌浏览器标签页里右键弹出的是 WebView2 原生菜单（系统标题栏风格的「在新窗口中打开链接 / 将链接另存为 / 复制链接 / 更多工具 / 检查」），与应用其余部分的 `.ctx-menu` 样式割裂。
> 决策（2026-11-24 用户拍板）：① **换成应用菜单样式（基础项）**——返回/前进/刷新、复制链接、在新标签页打开、用默认浏览器打开；不做「另存为/检查/更多工具」这类需要 CDP 或新增绑定的完整功能。② **统一拦截**——所有右键一律弹应用菜单，不判断、不让权网页自己的 `contextmenu` 菜单（内嵌浏览器不当正经浏览器用，网页自带菜单无保留价值）。

## 1. 现状与根因

内嵌浏览器实例在 `internal/browser/browser_windows.go` 的 `browserCreateOnHost` 创建（`edge.NewChromium()` + `Embed`）。创建时只做了两处初始化脚本注入（`wvInitScript` = `AddScriptToExecuteOnDocumentCreated`）：

- `window.__cadtHost = 'datalens';`
- `browserNewWindowGuardScript`（2026-11-24 加，把 `target=_blank` / `window.open` 改为页内跳转）

**没有关闭 WebView2 的默认右键菜单**：`ICoreWebView2Settings.AreDefaultContextMenusEnabled` 保持默认 `true`，所以右键走 WebView2 原生菜单。

前端标签层 `frontend/src/editor/editor-browser-tab.js` 的 `createBrowserView` 只建工具栏 + `.browser-surface`，网页区域是原生 WebView2 HWND（独立窗口，恒盖在主 WebView 之上），DOM 层收不到网页里的右键事件——所以不能靠给 `.browser-surface` 挂 `contextmenu` 监听解决。

## 2. 技术链路（已逐条查证）

| 环节 | 现状 | 结论 |
| --- | --- | --- |
| 关原生菜单 | `edge.Chromium.GetSettings()` 存在（`third_party/go-webview2/pkg/edge/chromium.go:583`）；`ICoreWebView2Settings.PutAreDefaultContextMenusEnabled(bool)` 存在（`.../ICoreWebView2Settings.go:185`） | 可在创建实例后调用 `settings.PutAreDefaultContextMenusEnabled(false)` |
| 拿右键上下文 | 初始化脚本在页面文档创建时、页面脚本前执行，可监听 `contextmenu`；能取 `clientX/clientY`、`e.target.closest('a[href]')` 的 `href` | 位置、链接地址都能拿到 |
| 掐断网页自己的菜单 | 注入脚本在 `document` 的**捕获阶段**监听 `contextmenu`，调 `e.preventDefault()` + `e.stopImmediatePropagation()` | 页面所有 `contextmenu` 监听器都收不到事件，网页自带的 DOM 菜单不会再弹；无需让权判定 |
| 回传前端 | `edge.Chromium.MessageCallback` 字段（`chromium.go:86`）在 `internal/browser` **未被占用**；页面 `chrome.webview.postMessage(str)` → Go `MessageReceived` → `MessageCallback(message, ...)`（`chromium.go:436-467`）→ `Emit` 事件 → 前端 `appEvents.onWindowOrBroadcast` | 通道现成，可复用 |
| 事件归属 | `frontend/src/core/event-scope.js` 的 `EVENT_SCOPES` 把 `browser-nav/title/error` 登记为 `owned` | 新事件须登记 `owned`（按 id 归属窗口） |
| 弹应用菜单 | `frontend/src/shell/contextmenu.js` 的 `createContextMenu()` → `ctxMenu.open(items, x, y, opts)`，已走 overlay-stack、统一 Esc/外点关闭 | 现成，浏览器工具栏「更多操作」`showBrowserMoreMenu` 已在用 |
| 菜单动作 | `deps.backend.BrowserGoBack/GoForward/Reload`、`deps.openBrowserTab(url, profile)`、`deps.copyText`、`openBrowserExternally(doc)`、`browserTargetUrl` | 基础项全部有现成入口，无需新增 Go 绑定 |

## 3. 关键设计

### 3.1 统一拦截（不做让权判定）

注入脚本在 `document` 上注册 `contextmenu` 的**捕获阶段**监听（`addEventListener('contextmenu', handler, true)`）。捕获阶段先于页面任何监听器执行，在 handler 里：

1. `e.preventDefault()` —— 阻止浏览器默认菜单（WebView2 原生菜单已由设置关掉，这里是双保险，也阻止网页可能的默认行为）；
2. `e.stopImmediatePropagation()` —— **关键**：阻止事件继续传播到页面注册的 `contextmenu` 监听器，这样在线文档、Gmail 等网页自己画的右键菜单根本不会触发；
3. 从 `e.target.closest('a[href]')` 取 `linkUrl`，从 `e.clientX/clientY` 取位置（换算见 §3.3），`chrome.webview.postMessage` 回传 Go。

不做 `defaultPrevented` 判定、不做 `setTimeout` 延迟决策——一律弹应用菜单。

> 边界：`stopImmediatePropagation` 只拦得住 DOM 事件传播链上的监听器。极少数页面用 `window` 捕获阶段更早的监听或 `pointerdown` 之类另起炉灶画菜单，可能漏网；内嵌浏览器场景接受。

### 3.2 关掉原生菜单

`PutAreDefaultContextMenusEnabled(false)` 全局关闭 WebView2 那层系统菜单。这与 §3.1 不冲突：一个是原生层，一个是 DOM 层，两层都掐掉，右键只留应用菜单。

### 3.3 菜单项与动作映射

| 菜单项 | 触发条件 | 动作（前端执行） |
| --- | --- | --- |
| 返回 | `canGoBack` | `deps.backend.BrowserGoBack(doc.id)` |
| 前进 | `canGoForward` | `deps.backend.BrowserGoForward(doc.id)` |
| 刷新 | 总是 | `deps.backend.BrowserReload(doc.id)` |
| 复制链接 | 右键落在 `<a[href]>` | `deps.copyText(url, '链接地址')` |
| **在新标签页中打开** | 右键落在 `<a[href]>` | `deps.openBrowserTab(browserTargetUrl(url), doc.browserProfile)`——**打开应用自己的浏览器标签页** |
| 用默认浏览器打开 | 右键落在 `<a[href]>` | `openBrowserExternally` 的变体：直接用该 `url` 而非地址栏 |

**「在新标签页中打开」的语义（用户 2026-11-24 特别强调）**：这里打开的是**应用自己的浏览器标签页**，不是系统默认浏览器、也不是 WebView2 原生弹窗。`deps.openBrowserTab(url, profileKey)`（`frontend/src/bridge/bridge-ui.js:81`）会 `createVirtualTabDoc` 建一个 `marker: 'browser'` 的内容区标签页，再调 `deps.backend.BrowserOpen` 创建内嵌 WebView2 实例——与浏览器工具栏「更多操作 → 在新标签页中打开」、AI 回答链接点击完全同一个入口。传 `doc.browserProfile` 让新标签继承当前标签的 profile（cookie/登录态隔离语义一致）。该入口在 `editor-browser-tab.js` 的 deps 里已可用，无需新增绑定。

选中文本场景（无链接）可选加「复制选中文本」，但需把文本回传，属基础项之外的增强，**首版不做**。

### 3.4 坐标系转换

`contextmenu` 的 `clientX/clientY` 是**页面 CSS 视口坐标**，而应用菜单 `ctxMenu.open(items, x, y)` 要的是**主窗口 CSS 坐标**。两者不一致（网页区域在内容区里有偏移，且固定视口有缩放）。转换：

- 在注入脚本里把坐标换算成「相对页面视口的比例」：`relX = clientX / window.innerWidth`、`relY = clientY / window.innerHeight`，连同上下文一起回传；
- 前端收到后，用 `doc.browserEl.getBoundingClientRect()` 得到网页区域在主窗口的位置与尺寸，算出 `x = rect.left + relX * rect.width`、`y = rect.top + relY * rect.height`；
- 固定视口（`browser-surface-fixed`）下 `rect` 是缩放后的可视框，比例换算天然正确。

## 4. 实施步骤（按依赖顺序）

### Go 侧（`internal/browser`）

1. `browserCreateOnHost`（`browser_windows.go:453`）：在 `ctrl.GetCoreWebView2()` 成功后，取 `settings, err := c.GetSettings()`，调 `settings.PutAreDefaultContextMenusEnabled(false)`。失败只记 WARN 不阻断创建（菜单退化为原生，功能不受影响）。
2. 注册 `c.MessageCallback`：解析约定前缀（如 `__cadt_ctxmenu:`）的 JSON，转成结构化上下文，经 `inst.emit("browser-context-menu", {id, x, y, linkUrl})` 推前端。**注意**：`MessageCallback` 目前空闲，但 `MessageReceived` 会把每条消息 `PostWebMessageAsString` 回显给页面（`chromium.go:462`）——非本前缀的消息要原样回显或不干预，避免破坏页面；本前缀消息回显给页面无害但浪费，可接受。
3. 初始化脚本新增 `browserContextMenuScript`（常量放 `browser.go`，与 `browserNewWindowGuardScript` 并列）：实现 §3.1 的捕获阶段统一拦截（`preventDefault` + `stopImmediatePropagation` + `postMessage`），并回传**比例坐标**。
4. 测试：`browser_test.go` 加脚本关键片段静态断言（同 `TestBrowserNewWindowGuardScript` 的套路）。

### 前端

5. `frontend/src/core/event-scope.js`：`EVENT_SCOPES` 加 `'browser-context-menu': 'owned'`；`frontend/test/core/event-scope.test.mjs` 的 expected 清单同步加。
6. `frontend/src/main.js`（`browser-nav` 事件附近，约 :6938）：加 `appEvents.onWindowOrBroadcast('browser-context-menu', ...)`，按 `data.id` 找到 doc，调 `editorBrowserTab` 暴露的处理器（见下一步）。
7. `frontend/src/editor/editor-browser-tab.js`：新增 `showBrowserContextMenu(doc, data)`——按 §3.4 换算坐标，按 §3.3 组装 items，调 `deps.ctxMenu.open(items, x, y, {onClose: () => syncBrowserTab(doc)})`；与 `showBrowserMoreMenu` 一样先 `hideBrowserBeforeMenu` 隐藏原生控件（否则菜单被网页盖住）。在工厂返回值里导出该函数。
8. `frontend/test/editor/editor-browser-tab.test.mjs`：加菜单项组装与坐标换算的纯函数单测（把换算与 items 构造抽成可导入的纯函数）。
9. `dev/mock-backend.js`：无需新增绑定（复用现有 `BrowserGoBack/Forward/Reload`），但如测试需要可加 `browser-context-menu` 事件模拟。

### 文档与收尾

10. `CHANGELOG.md`「未发布」加一条用户可见修复；认知索引 `internal/browser/`、`frontend/src/editor/` 条目更新。
11. 验证：`go test -timeout 300s ./internal/browser/` + `npm test` + `npm run build`；手动在浏览器标签页右键普通链接 / 空白处 / 在线文档，核对一律弹应用菜单。

## 5. 风险与回退

- **COM 回调风险**：`MessageCallback` 是 Go 回调，必须包在 `guardCallback`（`chromium.go:437` 的 `guardCallback` 已提供 panic 保护）内；本方案不在回调里做重活，只解析 JSON + `emit`。
- **`PostWebMessageAsString` 回显**：每条 postMessage 都会被回显给页面，若页面也监听 `window.message` 可能收到噪声。用统一前缀，页面侧不监听即可；可接受。
- **网页自带菜单被屏蔽**：这是决策的有意结果（统一拦截），不是 bug；在线文档/Gmail 等页面的自定义右键菜单将不可用。内嵌浏览器场景接受。
- **极少数漏网**：页面用更早捕获或 `pointerdown` 另画菜单时可能漏过，属已知边界，文档写明。
- **回退**：改一个开关即可恢复原生菜单——把 `PutAreDefaultContextMenusEnabled(false)` 改回 `true`（或不调用），并移除前端事件监听；注入脚本留着也无害（不发消息就没菜单）。

## 6. 不做的事（明确边界）

- 不做「另存为 / 检查 / 更多工具」——这些要么走 CDP（当前 CDP 通道已禁用，见 `browser_windows.go` 的 `BrowserEval` 注释），要么新增 Go 绑定，成本高、风险大。
- 不做选中文本的「复制/搜索」增强，首版只覆盖链接与导航。
- 不做网页自带菜单的让权判定——一律拦截（用户已拍板）。
- 不改应用主 WebView 的右键菜单，只作用于内嵌浏览器实例。
