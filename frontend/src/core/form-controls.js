// form-controls.js：表单控件的统一封装（规范见 docs/frontend-form-controls.md）。
//
// 此前项目只有 CSS class 约定（.set-switch / .opt-select / .dlg-input / .ai-settings-textarea）
// 与 settings-select.js 增强器，运行时动态创建的控件散在各域里手写，于是不断冒出
// 浏览器原生外观。这里把四类控件收成工厂：新 UI 一律经本模块创建，或照规范里的
// 静态结构写；禁止再写裸 <input> / <select> / <textarea> / <input type=checkbox|radio>。
//
// 每个工厂返回 {element, control}：element 是要 append 进 DOM 的节点，
// control 是值真源（原生控件）——沿用 settings-select「原生控件仍是值真源」的惯例。
// 本模块刻意不依赖任何 deps/ctx，属于 core 层的纯 DOM 构造函数。

const CONTROL_CLASS = {
    select: 'opt-select',
    input: 'dlg-input',
    textarea: 'dlg-input ai-settings-textarea',
};

function applyAttrs(control, o) {
    for (const [key, value] of Object.entries(o.attrs || {})) {
        if (value == null || value === false) continue;
        control.setAttribute(key, value === true ? '' : String(value));
    }
}

// 空值按 Tab 时用 placeholder 填默认值（createInput / createTextarea 默认启用）。
// 行为：空值 + Tab（非 Shift/Ctrl/Alt/Meta 组合）→ 填 placeholder，派发 input/change 让上层持久化；
// 不 preventDefault，填完 Tab 照常移到下一个焦点。已填值 / 组合键 / 无 placeholder 一律不动。
// 不想要此行为的输入框传 tabFillPlaceholder: false 关闭。
export function enableTabFillPlaceholder(control) {
    if (!control || (control.dataset && control.dataset.tabFillBound)) return control;
    if (control.dataset) control.dataset.tabFillBound = '1';
    control.addEventListener('keydown', (e) => {
        if (!e || e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
        if (String(control.value == null ? '' : control.value).length) return;
        const ph = control.placeholder == null ? '' : String(control.placeholder);
        if (!ph) return;
        control.value = ph;
        if (typeof control.dispatchEvent === 'function') {
            control.dispatchEvent(new Event('input', {bubbles: true}));
            control.dispatchEvent(new Event('change', {bubbles: true}));
        }
    });
    return control;
}

function applyCommon(control, o) {
    if (o.id) control.id = o.id;
    // className 是显式指定：覆盖默认封装 class，便于迁移存量时保持各域原有外观
    // （例如 AI 设置用 .ai-settings-input 而不是叠加 .dlg-input）
    if (o.className) control.className = o.className;
    if (o.value != null) control.value = String(o.value);
    if (o.placeholder != null) control.placeholder = String(o.placeholder);
    if (o.title != null) control.dataset.tip = String(o.title);
    if (o.disabled) control.disabled = true;
    if (o.spellcheck === false) control.spellcheck = false;
    if (o.autocomplete) control.autocomplete = o.autocomplete;
    if (typeof o.onChange === 'function') control.addEventListener('change', o.onChange);
    if (typeof o.onInput === 'function') control.addEventListener('input', o.onInput);
    applyAttrs(control, o);
    return control;
}

// 开关：必须保持 label.set-switch > (input + track + thumb) 三段结构，
// 标签文字放在行内的 .set-title / 外部元素，不要塞进 label（会挤坏 track 布局）。
export function createSwitch(o = {}) {
    const element = document.createElement('label');
    element.className = 'set-switch';
    const control = document.createElement('input');
    control.type = 'checkbox';
    control.checked = !!o.checked;
    if (o.id) control.id = o.id;
    if (o.disabled) control.disabled = true;
    if (o.title != null) element.dataset.tip = String(o.title);
    if (typeof o.onChange === 'function') control.addEventListener('change', o.onChange);
    applyAttrs(control, o);
    const track = document.createElement('span');
    track.className = 'set-switch-track';
    const thumb = document.createElement('span');
    thumb.className = 'set-switch-thumb';
    element.append(control, track, thumb);
    return {element, control};
}

// 紧凑行内复选框（文字在 label 内）：用于「勾选框 + 文字」挤在一行的窄场景
// （全局搜索的分类勾选等）。外观保持原生 checkbox（全局 :where() 兜底统一），
// 不走 .set-switch 的 34×20 开关尺寸。
export function createCheckbox(o = {}) {
    const element = document.createElement('label');
    element.className = 'set-check';
    const control = document.createElement('input');
    control.type = 'checkbox';
    control.checked = !!o.checked;
    applyCommon(control, o);
    if (o.title != null) element.dataset.tip = String(o.title);
    element.append(control, document.createTextNode(String(o.label == null ? '' : o.label)));
    return {element, control};
}

/**
 * 下拉选择框（.opt-select）。options 每项 {value, label, selected}。
 * 值真源是返回的 control（原生 select）；需要行式设置项下拉时用 createSettingsSelect。
 * @param {object} [o] 选项：options / id / value / className / onChange / attrs…
 * @returns {{element: HTMLElement, control: HTMLSelectElement}} 元素与原生控件
 */
export function createSelect(o = {}) {
    const control = document.createElement('select');
    control.className = CONTROL_CLASS.select;
    for (const option of o.options || []) {
        const item = document.createElement('option');
        item.value = String(option.value == null ? '' : option.value);
        item.textContent = String(option.label == null ? item.value : option.label);
        if (option.selected) item.selected = true;
        control.appendChild(item);
    }
    applyCommon(control, o);
    return {element: control, control};
}

export function createInput(o = {}) {
    const control = document.createElement('input');
    control.type = o.type || 'text';
    control.className = CONTROL_CLASS.input;
    if (o.min != null) control.min = String(o.min);
    if (o.max != null) control.max = String(o.max);
    if (o.step != null) control.step = String(o.step);
    applyCommon(control, o);
    // 默认启用「空值 Tab 填 placeholder」；显式 tabFillPlaceholder:false 可关闭
    if (o.tabFillPlaceholder !== false) enableTabFillPlaceholder(control);
    return {element: control, control};
}

export function createTextarea(o = {}) {
    const control = document.createElement('textarea');
    control.className = CONTROL_CLASS.textarea;
    if (o.rows) control.rows = Number(o.rows);
    applyCommon(control, o);
    if (o.tabFillPlaceholder !== false) enableTabFillPlaceholder(control);
    return {element: control, control};
}
