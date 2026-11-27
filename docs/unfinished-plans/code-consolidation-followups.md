# 代码收敛跟进项（未完成）：#4 弹层外点关闭 / 锚点定位剩余站点 + clamp 收归

> 来源：2026-11-23 一次全面代码审查（「通用能力埋在具体模块 / 重复造轮子」）。
> 原文件的 **#3（`ShowInFolder` 下沉 `internal/shellexec`）** 与 **附录「顺手做」项** 已实施，已拆分归档到 `docs/finished-plans/code-consolidation-followups.md`。
> 本文件只保留尚未完成的部分：#4 的剩余站点迁移，以及复查新发现的 `clampInt` / `clampText` 收归。
>
> 状态：**基础设施已落地，剩余站点待迁移（2026-11-23）**。

---

## #4 弹层「外点关闭」与「锚点视口定位」仍是各写各的

> **状态：基础设施已落地，部分站点已迁移（2026-11-23）。**
> - 新增 `core/popover-position.js` 的 `placePopover(el, anchor, {placement, align, gap, margin})`（视口钳制 + 自动翻上方）。
> - `core/overlay-stack.js` 的 `open()` 新增 `closeOnOutsideClick` + `anchors`（共享 document `pointerdown` 捕获，只看栈顶活层，`pendingActivate` 跳过打开当帧）。
> - 护栏 `frontend/test/core/outside-click-guard.test.mjs` 按文件基线卡新增站点（基线只许减不许增）。
> - 已迁移：`shell/message-center.js`（定位 + 外点关闭）、`shell/titlebar-popovers.js`（定位）、`ai/ai-model-picker.js`、`ai/ai-agent-settings.js`（分组建议）、`ai/ai-usage-ui.js`（用量弹层）、`ai/ai-panel.js`（模型列表弹层）——外点关闭均改为 `open({closeOnOutsideClick, anchors})` 并删除各自自挂的 document 监听与 dismiss 句柄。
> - 剩余站点（仍在护栏白名单内，各写各的）：`ai/ai-reminders.js:414`、`ai/group/ai-group-view.js:416`、`shell/titlebar-git-branch.js:618`、`reading/reading.js:1160,1199`、`explorer/explorer.js:1474`，以及 `ai/ai-panel.js` 的用量弹层（当前无弹层栈条目，需先补 open/close 生命周期）。范式与 message-center 相同（定位 → `placePopover`；外点关闭 → `open({closeOnOutsideClick, anchors})`），逐处替换即可。以下保留原始现状与方案记录。

### 现状（实施前盘点）

`core/overlay-stack.js` 已收口「Esc 栈序 + z-index 档位」两件事，文件头注释明确「所有关闭路径（按钮/遮罩点击/外点/blur/resize）都应收口到 `handle.dispose()`」，但**机制上没提供**外点关闭与锚点定位，导致：

**外点关闭 ~14 处**，同一模式各写一遍（`document.addEventListener('mousedown'|'pointerdown', e => { if (!pop.contains(target) && !anchor.contains(target)) close() }, true)` + 手动 remove）：
- `ai/ai-agent-settings.js:75`、`ai/ai-model-picker.js:299`、`ai/ai-panel.js:14883`、`ai/ai-panel.js:15005`、`ai/ai-usage-ui.js:235`、`ai/ai-reminders.js:414`、`ai/ai-group-view.js:402`、`shell/message-center.js:312`、`settings/settings-select.js:505`、`shell/titlebar-git-branch.js:618`、`reading/reading.js:1145/1181/1184`、`editor/foot-menus.js:338`、`main.js:6689`、`explorer/explorer.js:1364`。

**锚点视口钳制定位 ~7 处**（`Math.max(8, Math.min(rect.left, innerWidth - width - 8))` + 底部溢出翻上方）：
- `shell/titlebar-popovers.js:31`（已有独立函数，但锁在 shell 域）、`ai/ai-agent-settings.js:60`、`ai/ai-model-picker.js:304`、`ai/ai-panel.js:14870/14986`、`ai/ai-reminders.js:400`、`ai/ai-changes-ui.js:128`、`shell/message-center.js:295`。
- `core/tooltip.js:150` 的 `positionBubble` 有完整实现，但是私有、不导出。

### 目标

把这两件「弹层三件套」的另外两件并入 `core/overlay-stack.js` 的 `open()` 选项，让浮层只声明意图，不再各挂 document 监听、各写定位数学。

### 方案

1. `overlayStack.open()` 新增两个可选参数：
   - `closeOnOutsideClick: true` + `anchors: HTMLElement[]`：内部装**一个共享** document `pointerdown` 捕获监听（整个栈只装一次，按栈顶判定），命中「点在 el 与 anchors 之外」即 `dispose()`。
   - `position: {anchor: HTMLElement, placement?: 'auto'|'bottom'|'top', margin?: number, gap?: number, container?: HTMLElement}`：open 时与 resize/scroll 时（栈内统一挂）把 el 摆到 anchor 附近并做视口钳制。
2. 定位数学抽成 `core/popover-position.js` 的 `placePopover(el, anchor, opts)`（`container` 支持「相对容器」模式，供 AI 面板这类与面板滚动容器而非 viewport 绑定的浮层用），`core/tooltip.js` 的 `positionBubble` 后续改为复用。
3. 逐个迁移调用点，**保留各自的 toggle 语义**：
   - 「点锚点再点一次 = 关」：由 `anchors` 命中判定 + 调用方自己的 toggle 处理，栈只管「点到别处就关」。
   - 「打开事件本身不应立即触发关闭」：`shell/message-center.js:312`、`reading/reading.js:1184` 用 `setTimeout(...,0)` 延迟注册——共享监听必须保留这个细节（打开当帧的 pointerdown 不入栈判定）。
4. 迁移顺序：先做定位（`popover-position.js` + 7 处 → `position` 选项），再做外点关闭（`closeOnOutsideClick` → 14 处）。两步都可独立验证。

> 实现偏离：`position` 选项未真正并入 `open()`——实际是调用方直接调 `placePopover`，`overlay-stack.js` 无 `position` 参数。后续迁移按现状范式（调用方直接调 `placePopover`）执行即可。

### 风险与验证

- 风险：toggle 语义细微差别（有的点锚点收起、有的忽略）；`ai/ai-panel.js` 在 `overlay-esc-guard.test.mjs` 豁免清单里（面板内自管小浮层），迁移时要保留其「相对面板容器」定位。
- 护栏：`overlay-esc-guard.test.mjs`、`icon-guard.test.mjs` 基线在迁移期间**只减不增**。
- 验证：`npm test`；手动核对外点关闭、锚点翻转、Esc 栈序三层叠加场景。

---

## 复查新发现的遗漏（待收归）

- `clampInt(value, min, max, fallback)` 仍有 5 份独立实现：`ai/ai-external-tools.js:43`、`ai/ai-gen-model.js:25`、`ai/ai-group-model.js:103`、`ai/ai-session-tools.js:11`，以及 `ai/ai-search-advanced.js:7`（**参数顺序不同**：`fallback` 在 `min/max` 前，合并时须逐个核对调用点）。`ai/ai-constants.js` 已有权威的 `aiClampInt`，可将前四份同签名者收归它；`ai-search-advanced` 那份单独评估。
- 字符串截断 `clampText` 亦有 ~7 份实现（是否压缩空白语义各异），同属此类，触碰相关模块时顺手做。
