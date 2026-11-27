# 前端表单控件规范（硬要求）

> 2026-11-15 定。适用 `frontend/index.html` 与 `frontend/src/**/*.js`。
> 起因：项目长期混用自绘控件与浏览器原生控件，深色主题下「新增变量」等对话框冒出系统蓝勾选框、原生下拉；只改某一处样式会不断复发。

## 1. 硬规则

**禁止新增任何裸原生表单控件**：`<input>`（含 checkbox / radio）、`<select>`、`<textarea>`。四类控件一律走封装：

| 控件 | 动态创建（JS） | 静态 HTML |
| --- | --- | --- |
| 开关 | `createSwitch()` | `label.set-switch` 三段结构 |
| 紧凑行内复选框（文字在 label 内） | `createCheckbox()` | `label.set-check` 内含原生 checkbox + 文字 |
| 下拉 | `createSelect()`；设置页行式下拉用 `createSettingsSelect()` | `select.opt-select`（设置页内自动自绘） |
| 单行输入 | `createInput()` | `input.dlg-input` / `input.ai-settings-input` |
| 多行输入 | `createTextarea()` | `textarea.dlg-input` / `textarea.ai-settings-input.ai-settings-textarea` |

工厂在 `frontend/src/core/form-controls.js`，返回 `{element, control}`：`element` 是要 append 进 DOM 的节点，`control` 是值真源（读 `.value` / `.checked` 用它）。沿用 `settings-select.js` 的惯例——原生控件仍是值真源，只是不再由业务代码手写。

**例外只有一个**：工厂实现（`core/form-controls.js`）自身创建原生 DOM，这是封装的内部实现，不算违规。

## 2. 标准写法

### 动态创建

```js
import {createSwitch, createCheckbox, createSelect, createInput, createTextarea} from '../core/form-controls.js';

const enabled = createSwitch({id: 'foo-enabled', checked: true, onChange: save});
row.appendChild(enabled.element);          // 读值：enabled.control.checked

const compact = createCheckbox({id: 'foo-fuzzy', label: '模糊', checked: false, onChange: save});
row.appendChild(compact.element);          // 读值：compact.control.checked

const scope = createSelect({
    id: 'foo-scope',
    options: [{value: 'a', label: 'A'}, {value: 'b', label: 'B', selected: true}],
    onChange: save,
});
row.appendChild(scope.element);

const name = createInput({id: 'foo-name', placeholder: 'MY_API_KEY', spellcheck: false, autocomplete: 'off'});
const prompt = createTextarea({id: 'foo-prompt', rows: 5, spellcheck: false});
```

### 静态 HTML

```html
<!-- 开关：三段结构固定；标签文字放行内的 .set-title，不要塞进 label（会挤坏 track） -->
<label class="set-switch"><input type="checkbox" id="opt-foo"><span class="set-switch-track"></span><span class="set-switch-thumb"></span></label>

<select id="opt-bar" class="opt-select"></select>
<input id="opt-baz" class="dlg-input" type="text" spellcheck="false" autocomplete="off">
<textarea id="opt-qux" class="dlg-input ai-settings-textarea" rows="5" spellcheck="false"></textarea>
```

## 3. 这些封装各自负责什么

- `.set-switch`：隐藏原生 checkbox，用 `.set-switch-track` / `.set-switch-thumb` 自绘（`style.css` 约 9643 行）。
- `.set-check`：紧凑行内复选框，label 内放原生 checkbox + 文字，外观沿用下方 `:where()` 全局兜底（不与 34×20 的开关混用）。
- `.settings-content select` / `.opt-select`：`appearance:none` + SVG 箭头；设置页行式下拉由 `settings/settings-select.js` 增强成触发器 + 浮层，被增强的原生 select 加 `.set-select-native` 后隐藏。
- `.dlg-input` / `.ai-settings-input`：统一边框、圆角、常态与聚焦背景、外发光。
- `.ai-settings-textarea`：多行编辑器的字体、行高、最小高度；聚焦保持常态背景，不整块铺色。
- `--field-focus-bg` 统一取 `var(--hover)`（中性、随主题协调），11 个主题不许再各写硬编码色值。
- `style.css` 的「全局原生表单控件兜底」用 `:where()` 零特异性给遗留裸控件兜底。**它是兜底，不是许可**：不能因为兜底后好看了就继续写原生控件。

## 4. 存量与执行

- 存量裸控件允许保留，按文件登记在 `frontend/test/core/form-controls-factory.test.mjs` 的 `BASELINE` 里。
- 该测试扫描 `index.html` 与 `src/**/*.js`，任何新增裸用法都会让计数超过基线而失败。**BASELINE 只允许调小（迁移存量后），绝不允许调大。** 新增文件里出现裸用法同样失败。
- 新增 UI 与提交前都跑 `npm test`（见 `AGENTS.md`「验证与提交」）。
- 迁移存量优先从动态创建点下手：`ai/ai-panel.js`、`ai/ai-takeover.js`、`ai/ai-tool-cards.js`、`editor/patch-view.js`、`explorer/global-search.js`、`settings/settings-pane-envvars.js`、`settings/settings-pane-plugins.js`、`terminal/terminal-ui.js` 等；每迁一处把对应基线数字减一。
- **首轮已迁移（2026-11-15）**：`ai/ai-manage-dialogs.js`（1 个 select、1 个 textarea、3 个 input）与 `explorer/global-search.js`（1 个 select）改用工厂，基线相应从 6→1、3→2。迁移时给 `createInput` 传 `className` 覆盖默认 `.dlg-input`，保持各域原有外观零变化。
- **2026-11-22 改口径：不再只传域内类**。`className` 是整段覆盖（见第 5 节），只写 `ai-settings-input` 会丢掉 `.dlg-input` 的 7px 圆角 / 12.5px 字号 / hover 边框 / focus 外发光，看上去「像原生控件」（定时任务新建对话框的用户反馈）。现在统一写 `className: 'dlg-input ai-settings-input'`——`dlg-input` 给外观，域内类只给布局（flex / 宽度）；已改 `ai/ai-schedule.js`、`ai/ai-manage-dialogs.js`。
- **暂留一类**：带文字的紧凑行内复选框（技能列表、变量列表等）先按存量豁免。2026-11-17 工厂已补紧凑变体 `createCheckbox()`，`explorer/global-search.js` 的分类勾选已迁移（基线 2→0）；其余存量新写一律用 `createCheckbox`（或改用 `createSwitch` 的开关语义），不要新写裸 checkbox。

## 5. 易错点

- **`className` 是整段覆盖，不是追加**：`applyCommon` 里 `control.className = o.className`。只传域内类（如 `ai-settings-input`）会丢掉 `.dlg-input` 的圆角 / 字号 / hover 边框 / focus 外发光，肉眼像「没用封装」（2026-11-22 定时任务对话框反馈）。要「封装外观 + 域内布局」就并列写 `'dlg-input ai-settings-input'`。
- 不要给 `.set-switch` 的 label 里塞文字，也不要只写 `<input type="checkbox">` 配 `accent-color`——那仍是原生组件。
- 不要在域模块里 `import main.js` 的绑定来造控件；`core/form-controls.js` 无 deps、不依赖声明顺序，可直接 import。
- 不要手写 `innerHTML` 拼表单控件再事后补 class：字符串里的标签同样会被静态扫描抓到。
- 设置页之外的下拉若需要浮层增强，走 `createSettingsSelect` 的接线，不要复制浮层 DOM：工厂返回的 `enhanceSelect(sel)` 对单个 select 幂等增强（main.js 经 deps getter 注入到需要的域，如 `explorer/global-search.js` 的 AI 会话范围下拉）；增强后 wrap 继承原 select 的布局类，触发器外观由各域自己的样式适配（紧凑行在注入样式里覆盖 `.set-select-btn`）。已增强的 select 再调一次不会重复包装，只重新同步触发器文本——程序化改 `select.value` 不派发 change，面板刷新后可补一次调用。
- **主副标题选项**：给 `<option>` 加 `data-subtitle`，`option.text` 写主标题（同时是触发器显示值），`settings-select.js` 会渲染成两行（`.ss-opt-rich` + `.ss-main` / `.ss-sub`）。没有该属性的选项保持单行，完全向后兼容；不要把「名字 · 描述」再拼进一个字符串里让它被截断。

## 6. fc- 组合控件（2026-11-28 起）

三个带结构与交互的控件同样走工厂（样式在 `style.css` 的「core/form-controls.js 的 fc- 工厂控件」段，测试在 `test/core/form-controls-factory.test.mjs`）：

- `createNumber({value, min, max, step, unit, ...})`：`[- 输入 +]` 一体数字步进。按钮 / 键盘 ↑↓ / 手输三条路收敛到导出的纯函数 `stepNumber` / `normalizeNumberInput`（失焦钳制、非法回退上次有效值）；按钮长按连发（400ms 延迟后 110ms 一步）。返回 `{element, control, value}`：control 是中间的原生 input（字符串真源），`value` getter 返回数值。
- `createSlider({value, min, max, step, segments, format, ...})`：原生 `<input type=range>` + `.opt-range`（accent-color 跟主题，与设置页字号/温度滑杆同款），可选右侧等宽读数（`.fc-slider-value`，tabular-nums）。`segments: N` 把轨道分成 N 段只能停 N+1 档——内部 0..N 整数步进（原生 step 锁死拖动与键盘），读取映射回真实区间，轨道下自动加 N+1 个点标位；onChange / onInput 收到的都是映射后的数值。
- `createPathInput({value, placeholder, onBrowse, ...})`：`dlg-input` + 「浏览」按钮。core 不碰后端——`onBrowse(control)` 由调用方注入（闭包里拿 mode/filters 调 Wails 文件对话框，把结果写回 `control.value`）；没传 `onBrowse` 按钮禁用，不给「点了没反应」的假按钮留位置。path 输入默认关闭「空值 Tab 填 placeholder」（这里的 placeholder 是提示语）。

配套组件：可过滤下拉 `core/combo-select.js` 的 `createComboSelect`（面板 body 挂载 + `placePopover` 视口钳制，外点/Esc 走 overlay-stack；过滤复用 `completion.js` 的 `scoreMatch`，副标题命中降 200 分）、胶囊徽标 `core/badge.js` 的 `createBadge`（五档语义色，见 `style.css` `.mi-badge` 段）、空状态占位 `core/empty-state.js` 的 `renderEmptyState`。
