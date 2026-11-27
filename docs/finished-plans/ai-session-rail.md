# AI 会话消息导航滑轨（session rail）：用户消息刻度 + 两段式气泡定位（方案）

> 状态：**已实施**（2026-11-25 评估定档并当日实现；数据层 summary + session-rail.js + 两段式气泡 + aiSessionRail 开关 + 样式 + 测试全部落地。验证：typecheck 通过、改动相关 44 项测试全绿、前端构建成功。全量 npm test 曾因其他会话恢复的两个未登记测试文件触发 test-manifest 护栏，与本方案无关）
> 决策依据（2026-11-25 多轮确认）——①滑轨形态：AI 面板边缘一条竖直刻度轨道，每刻度对应一轮用户消息，当前阅读位置有高亮块；hover 出两段式气泡（标题 = 用户消息，描述 = 助手回复正文预览），点击定位到该消息（参考 VS Code minimap / 聊天软件的会话导航）。②气泡 summary 取「该轮用户消息之后最近一条 assistant 正文预览」——零磁盘改动、零 token 成本，不用会话级 `session.summary`（整会话一份，无法对应每轮），也不新造逐轮摘要流程。③显示条件叠加：设置开关 `aiSessionRail`（**默认开启**）**且**面板实际宽度 ≥ 600px（dock 默认 380px 不显示，拖宽 / 全屏 / dock-fill 显示）——按宽度而非形态判断，分屏太窄时气泡与刻度会挤。④开关全局同步（不进 `PER_WINDOW_LAYOUT_KEYS`），且不进 AI 可写白名单（与布局形态硬规则一致，界面呈现只能用户手动切）。
> 范围：数据层补 `summary` → 滑轨渲染/交互 → 设置开关接线 → 气泡两段式 → 样式 → 测试。全程复用现有 `session-outline` 骨架，不重写筛选/跳转。

## 1. 背景与现状（代码事实，2026-11-25 核实）

### 1.1 已有的「用户消息定位条」骨架（可复用约 60%）

项目已有一套「会话结构 → 用户消息定位条」实现，本方案的三件核心事（筛用户消息、判定当前位置、点击跳转）都现成：

- **数据筛选** `frontend/src/ai/session/session-outline.js:44` `buildSessionOutlineItems(messages, options)`：从 `session.messages` 筛出 `role === 'user'` 且非 `systemNote/silent/app/model-switch` 的消息，产出 `{index, round, text, ts, steer}`；已处理剥离 `<system-reminder>` 宿主环境块与 `<quote>` 引用前缀（与气泡渲染口径一致）；`MAX_ITEMS=400` 截断（保留最近）。
- **当前位置判定** `session-outline.js:130` `activeFromView()`：按 `.ai-msg.user` 的视口位置算出当前轮（`activeIndex`），供高亮同步。
- **跳转 + 高亮** `session-outline.js:185` `jumpTo(index)`：目标在渲染窗口外时先扩窗（`renderWindowState` + `renderWindows` + `renderMessages(true)`），再 `scrollIntoView({block:'center', behavior:'smooth'})` + `ai-msg-flash` 高亮。
- **控制器** `session-outline.js` `createSessionOutlineController(ctx)`：封装 `snapshot / scheduleSync / notify / jumpTo`；宿主在 `ai-panel.js:6306` 注入 `currentSession / renderWindowState / renderWindows / renderMessages / onPanelStateChange`，快照出口 `ai-panel.js:20088` `bridgeSessionOutline`。
- **现有呈现**：文字行列表，挂在「结构面板」的会话视图（`frontend/src/editor/structure.js:1608` `renderSessionOutline`）。本方案是**另一种呈现形态**（图形滑轨），数据同源，应复用而非另起炉灶。

### 1.2 AI 面板形态与宽度机制（显示条件的落点）

- 形态唯一落地点 `frontend/src/ai/ai-panel.js:17876` `applyMode()`：`mode ∈ {dock, fullscreen}`，DOM 标记为 `#ai-panel.ai-dock` / `#ai-panel.ai-fullscreen`；`float`（独立悬浮窗）是独立进程，内部 mode 仍是 dock。
- dock 自适应占满：`refreshDockFill()`（`ai-panel.js:17859`）在无活动文件时给 `#top-row` 加 `ai-dock-fill`（`style.css:5765`）；编辑区收起时加 `ai-editor-collapsed`（`style.css:5795`）——两者视觉铺满但本质仍是 dock。
- 宽度变化可靠时机（**不能只靠 ResizeObserver**，`ai-panel.js:6421` 明确注释「部分宿主（IAB 节流渲染帧）不派发 RO 回调」）：
  1. 拖分屏边松手 `endResize()`（`ai-panel.js:18245`，写 `settings.aiPanelWidth` + `onLayout()`）；
  2. 形态切换 `applyMode()`（`ai-panel.js:17876`）；
  3. dock 自适应占满 `refreshDockFill()`（`ai-panel.js:17859`）；
  4. 窗口缩放 `onWindowResize()`（`ai-panel.js:18257`）。
- 面板宽度上限：`endResize` 用 `Math.max(640, innerWidth * 0.6)`（`ai-panel.js:18238`），默认 `aiPanelWidth: 380`（`main.js:2283`）。阈值 600px 意味着默认 dock 不显示、拖宽/全屏/dock-fill 显示。

### 1.3 设置开关范式（新增 `aiSessionRail` 的落点）

- 设置页 AI 面板「界面」卡片在 `frontend/index.html:828` `data-pane="ai"`；开关行照 `ai-opt-show-usage`（`index.html:844`）的 `.set-switch` 静态结构（表单控件硬规范：静态用 class 结构，禁裸 `<input>`）。
- 显示方式下拉 `ai-opt-display-mode`（`index.html:834`）的接线范式：`frontend/src/ai/settings/ai-settings-dialog.js:735` change 监听 → `setMode()` / 写 settings + `saveSettings()`。
- 默认值集中在 `frontend/src/main.js`（如 `sidebarWidth:264` 在 `main.js:2234`、`aiPanelWidth:380` 在 `main.js:2283`）。
- 跨窗口同步：`frontend/src/settings/settings-sync.js:61` `PER_WINDOW_LAYOUT_KEYS`——判类规则（`:52-60`）「窗口自身形态 → 每窗独立；用户偏好/行为开关 → 全局同步」。`aiSessionRail` 属用户偏好，不登记。
- AI 可写白名单 `frontend/src/main.js:712` `APP_SETTING_RULES`：布局形态（aiFloatMode/aiPanelSide）按 2026-11-17 硬规则故意不在白名单；滑轨开关同理不加入。

### 1.4 气泡组件现状

`frontend/src/core/tooltip.js` 是全局 `data-tip` tooltip 运行时，但**只支持单段纯文本**：`tooltip.js:180` `el.textContent = tip`，`\n` 走 pre-line；支持 `data-tip-sticky`（指针可移进气泡）与 `data-tip-actions`（动作链接）。做不出截图里「标题 + 灰色描述」两段层次，需扩展或新建。

## 2. 目标与非目标

### 目标

1. AI 面板边缘一条竖直滑轨，刻度对应当前会话每轮用户消息，当前阅读位置有高亮指示块。
2. hover 刻度出两段式气泡：标题 = 用户消息正文预览，描述 = 该轮助手回复正文预览。
3. 点击刻度定位到对应消息（复用 `jumpTo`），带滚动与高亮。
4. 设置开关 `aiSessionRail`（默认开启）控制显隐；面板宽度 < 600px 时强制隐藏。
5. 复用现有 `session-outline` 数据/跳转骨架，不重写筛选、视口判定、跳转逻辑。

### 非目标（明确排除）

- **不做逐轮摘要生成**：不新增 AI 工具/流程为每轮生成 summary，不改磁盘序列化格式（`ai-session-disk.js`），不做历史会话回填。summary 一律取现成消息的正文预览。
- **不用会话级 `session.summary`**（`ai-compact.js:60`，整会话一份）——无法对应每一轮。
- **不改 AI 面板形态机制**：滑轨不改变 dock/fullscreen/float 的任何行为，只是面板内的一个浮层元素。
- **不做独立视图型标签页**：滑轨是 AI 面板内部浮层，不进 `TAB_KINDS`（`core/tab-kinds.js`）。
- **不进 AI 可写白名单**：开关只能用户手动切（与布局形态硬规则一致）。
- **不做每窗独立**：开关全局同步。
- **不加新依赖**：零 vendor 增量。

## 3. 方案设计

### 3.1 数据链路

```
session.messages
  └─ buildSessionOutlineItems()          筛用户消息 → {index, round, text, ts, steer}
       └─ 补 summary 字段                 从该条之后最近一条 assistant 正文取预览（压空白 + 截断）
            └─ session-rail.js            按比例画刻度 + 当前位置指示块
                 ├─ hover  → 两段式气泡（标题 = text，描述 = summary）
                 └─ click  → 复用 outline controller 的 jumpTo(index)
```

`summary` 取法与现有 `text` 预览完全同款（压空白、截断、剥标记），保持纯函数、可单测。

### 3.2 summary 提取口径（纯函数，新增到 `session-outline.js`）

在 `buildSessionOutlineItems` 循环里，为用户消息项补 `summary`：

- 从当前用户消息的 `index + 1` 向后扫，取**第一条 `role === 'assistant'` 且非 `silent/systemNote/app`** 的消息；
- 取该 assistant 消息的正文（`content`，若有 `reasoning`/工具结果结构则只取正文文本），复用 `oneLine()` 压空白 + `MAX_TEXT=160` 截断；
- 边界：扫到下一轮用户消息即停（避免跨轮错配）；末尾待回复（无后续 assistant）返回空串；中间隔 tool 消息则跳过继续找；
- 抽成纯函数 `assistantPreviewAfter(messages, userIndex)`，与 `buildSessionOutlineItems` 一起配表驱动测试。

### 3.3 滑轨渲染（`session-rail.js`，新文件）

职责单一：只做呈现与交互，数据/跳转全部经注入的 controller。

- **刻度分布**：按 `item.index / messages.length`（或 `i / items.length`）映射到轨道纵向百分比；`activeIndex` 对应项高亮为指示块。
- **当前位置块**：跟随 `scheduleSync` 的 `activeIndex` 更新，不整轨重建（复用 `syncSessionOutlineActive` 思路，只切 class）。
- **交互**：hover 刻度 → 两段式气泡；click → `onJump(index)`（即 controller 的 `jumpTo`）。
- **键盘可达**：刻度可 focus，方向键/Enter 定位（照 `renderSessionOutline` 的 keydown 范式，`session-outline.js:96`）。
- **刻度过密**：`MAX_ITEMS=400`，长会话刻度会挤成实线——按轨道像素高度抽稀（如每 ≥4px 一个刻度）或聚合，具体阈值实现时定。

### 3.4 显隐控制（JS 加 class，不纯 CSS）

因宽度阈值需 JS 读 `offsetWidth`，且监听时机多，采用 JS 控制：

- `syncRailVisibility()`：`rail.classList.toggle('hidden', !(settings.aiSessionRail && panel.offsetWidth >= 600))`；
- 挂载时机：`endResize` / `applyMode` / `refreshDockFill` / `onWindowResize`（见 1.2）+ 设置变更回调；`ResizeObserver` 可作增强但**不能作为唯一来源**；
- 阈值 600 抽成常量 `AI_RAIL_MIN_WIDTH`，配纯函数 `shouldShowRail(enabled, panelWidth, minWidth)` 单测。

### 3.5 设置开关接线

| 落点 | 改动 |
|---|---|
| `frontend/index.html`（`data-pane="ai"` 界面卡片） | 加一行 `.set-switch` 开关 `#ai-opt-session-rail`，描述「面板够宽时显示会话消息导航滑轨」 |
| `frontend/src/ai/settings/ai-settings-dialog.js` | `opt` 解构加 `sessionRail`；`refreshChatSettings` 回填 checked；change 监听写 `settings.aiSessionRail` + `saveSettings()` + 通知 ai-panel 刷新显隐 |
| `frontend/src/main.js` | 默认值 `aiSessionRail: true` |
| `frontend/src/settings/settings-sync.js` | 不改（全局同步，不登记 `PER_WINDOW_LAYOUT_KEYS`） |
| `frontend/src/main.js` `APP_SETTING_RULES` | 不改（不进 AI 可写白名单） |

设置变更到 ai-panel 的通知：优先复用现有 `settings-changed` 广播通道（`applySettings()` 出口），ai-panel 的 `syncRailVisibility` 挂到该时机；不新开第四条同步通道（设置同步硬规范）。

### 3.6 气泡两段式

优先扩展 `core/tooltip.js` 支持两段式（新增可选 `data-tip-title` + 现有 `data-tip` 作描述，气泡内分两行渲染）；若影响面过大，则新建气泡组件——但须遵守：

- 文本一律 `textContent` 写入，**原始 HTML 不执行**（`tooltip.js` 硬要求）；
- 新弹层走 `core/overlay-stack.js` 注册、关闭收口 `handle.dispose()`，不自挂全局 Esc / 不手写 z-index（弹层硬规范 + `overlay-esc-guard.test.mjs` 护栏）；
- 外点关闭走 `overlayStack.open({closeOnOutsideClick:true, anchors})`，不自挂 document pointerdown（外点关闭护栏）。

## 4. 改动清单（精确到文件）

| 文件 | 改动 |
|---|---|
| `frontend/src/ai/session/session-outline.js` | `buildSessionOutlineItems` 每条补 `summary`；新增纯函数 `assistantPreviewAfter` |
| **新增** `frontend/src/ai/session/session-rail.js` | 滑轨渲染、刻度映射、当前位置块、hover/click、键盘可达、抽稀；复用 `createSessionOutlineController` |
| `frontend/src/ai/ai-panel.js` | 接线 controller；新增 `syncRailVisibility()` + `AI_RAIL_MIN_WIDTH`；挂到 4 处时机 + 设置变更 |
| `frontend/index.html` | 设置页 AI「界面」卡片加 `.set-switch` 开关 `#ai-opt-session-rail` |
| `frontend/src/ai/settings/ai-settings-dialog.js` | 开关回填 + change 监听写 settings |
| `frontend/src/main.js` | 默认值 `aiSessionRail: true` |
| `frontend/src/style.css` | 滑轨/刻度/指示块/气泡样式（`.ai-session-rail` 默认 `hidden`） |
| `frontend/src/core/tooltip.js`（或新气泡组件） | 两段式气泡；`textContent` 写入；如需新弹层走 overlay-stack |
| `frontend/test/ai/session-rail.test.mjs`（新） | summary 提取、刻度映射、`shouldShowRail` 纯函数测试 |
| `frontend/test/ai/` 测试清单 | 新测试登记进 `npm test`（漏登记 = 从未跑过） |

## 5. 硬约束与风险

1. **气泡不用 innerHTML**：`tooltip.js` 硬要求 `textContent` 写入，原始 HTML 不执行（Markdown 渲染链安全底线）。
2. **active 同步走 `scheduleSync`**（rAF 节流，`session-outline.js:148`），不自挂 scroll 监听；虚拟窗口渲染（`renderWindows`）下滚动/重绘频繁。
3. **刻度过密**：`MAX_ITEMS=400`，长会话需抽稀/聚合，否则轨道变实线。
4. **summary 回溯口径**：跳过 tool 消息、遇下一轮用户消息即停、末尾待回复兜底空串，避免气泡空白或跨轮错配。
5. **宽度监听不能只靠 RO**（`ai-panel.js:6421`），须覆盖 4 处时机 + window.resize 兜底。
6. **新开关不进 AI 可写白名单**（与 aiFloatMode/aiPanelSide 硬规则一致）；全局同步，不进 `PER_WINDOW_LAYOUT_KEYS`。
7. **设置同步三条通道**（`applySettings` / `persistSettingsLight` / `applyRemoteSettings`）：开关变更走 `applySettings()`，不新开通道、不在别处直写 `localStorage`。
8. **弹层规范**：新气泡若独立成层，须进 overlay-stack；不写全局 Esc 监听、不手写 z-index、不自挂外点监听（三道护栏）。

## 6. 实施步骤（建议分批，可独立验证）

1. **数据层**：`session-outline.js` 补 `summary` + `assistantPreviewAfter` 纯函数 + 表驱动测试；先跑 `npm test` 验证。
2. **滑轨渲染**：新建 `session-rail.js`，复用 controller 做刻度/指示块/点击；接 `ai-panel.js`。
3. **气泡**：扩展 tooltip 两段式（或新建走 overlay-stack）；接 hover。
4. **显隐 + 设置**：`syncRailVisibility()` 挂 4 处时机；设置页开关 + 默认值 + 接线。
5. **样式**：`style.css` 滑轨/气泡样式。
6. **验证**：`npm test`（含 typecheck 前置门）+ 前端构建 + 手动验收（默认开启/关闭、分屏窄/拖宽/全屏、hover 气泡、点击定位、跨窗同步）。

## 7. 验证方式

- **纯函数测试**：summary 提取（含 tool 消息间隔、末尾待回复、跨轮截断）、刻度映射、`shouldShowRail` 真值表——登记进 `npm test`。
- **构建/类型**：`npm test`（含 `npm run typecheck` 前置门）、`npm run build`。
- **手动验收清单**：
  1. 默认开启：新用户面板够宽时滑轨出现；分屏 380px 时不出现；拖宽过 600px 出现。
  2. 设置关闭：开关关掉后任何宽度都不出现；重开生效。
  3. 全屏 / dock-fill：出现。
  4. hover 刻度：气泡显示「用户消息标题 + 助手正文预览」，长文本截断，无 HTML 注入。
  5. click 刻度：定位到对应消息并高亮；目标在渲染窗口外时能扩窗跳转。
  6. 滚动消息：当前位置指示块跟随；长会话刻度不糊成实线。
  7. 跨窗口：一个窗口改开关，别的窗口同步（全局同步）。
  8. AI 不可改：`set_setting` 尝试写 `aiSessionRail` 应被拒（不在白名单）。

## 8. 待办 / 未决

- 刻度抽稀的具体像素阈值（建议每 ≥4px 一个刻度，实现时按实测调）。
- 气泡最终形态：扩展 `core/tooltip.js` vs 新建组件——实现时先试扩展，影响面大再新建。
- summary 正文提取对 assistant 消息多段结构（reasoning / 工具结果 / 文本）的取值细节，按实际消息形状定。
