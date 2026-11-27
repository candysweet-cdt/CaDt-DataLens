// form-controls.js：表单控件的统一封装（规范见 docs/frontend-form-controls.md）。
//
// 此前项目只有 CSS class 约定（.set-switch / .opt-select / .dlg-input / .ai-settings-textarea）
// 与 settings-select.js 增强器，运行时动态创建的控件散在各域里手写，于是不断冒出
// 浏览器原生外观。这里把各类控件收成工厂：新 UI 一律经本模块创建，或照规范里的
// 静态结构写；禁止再写裸 <input> / <select> / <textarea> / <input type=checkbox|radio>。
//
// 每个工厂返回 {element, control}：element 是要 append 进 DOM 的节点，
// control 是值真源（原生控件）——沿用 settings-select「原生控件仍是值真源」的惯例。
// 本模块刻意不依赖任何 deps/ctx，属于 core 层的纯 DOM 构造函数（icons.js 除外，同为 core 纯函数层）。

import {iconSvg} from './icons.js';

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

// ── 数字步进输入（fc-number）────────────────────────────────────────────
// [- 输入 +] 一体框，unit 挂框外右侧。值真源是中间的原生 input（字符串形态），
// 按钮 / ↑↓ / 手输三条路都收敛到同一出口：步进走 stepNumber 对齐，失焦走
// normalizeNumberInput 钳制（非法回退上次有效值）。长按连发：400ms 延迟后 110ms 一步。
// 纯逻辑抽成导出函数便于单测（fakeEl 桩不跑定时器，长按只验证绑定）。

/**
 * 失焦规范化：parseFloat 解析失败返回 null（调用方回退上次有效值），成功返回钳到 [min, max] 的数值。
 * @param {string} raw 用户输入原文
 * @param {number} min 下沿
 * @param {number} max 上沿
 */
export function normalizeNumberInput(raw, min, max) {
    const v = parseFloat(String(raw));
    if (!Number.isFinite(v)) return null;
    return Math.min(max, Math.max(min, v));
}

/**
 * 步长的小数位数。Number.toString() 对 < 1e-6 的值走科学计数法（'1e-7'），
 * 直接 split('.') 会得 0 位——这里按指数尾数还原（1e-7 → 7 位，1.5e-7 → 8 位）。
 * @param {number} step 步长（> 0，由 createNumber 守卫；直接调用方自负）
 */
function decimalPlaces(step) {
    const s = String(step);
    const eAt = s.indexOf('e');
    if (eAt >= 0) {
        const mantissa = s.slice(0, eAt);
        const tail = s.slice(eAt + 1); // 形如 '-7' 或 '+21'
        const exp = parseInt(tail, 10);
        const mantissaPlaces = (mantissa.split('.')[1] || '').length;
        return Math.max(0, mantissaPlaces - exp);
    }
    return (s.split('.')[1] || '').length;
}

/**
 * 步进：current + dir*step，按 step 的小数位收敛浮点尾巴，再钳到 [min, max]。
 * @param {number} current 当前值
 * @param {number} dir 方向（±1）
 * @param {number} step 步长
 * @param {number} min 下沿
 * @param {number} max 上沿
 */
export function stepNumber(current, dir, step, min, max) {
    const next = Number((current + dir * step).toFixed(decimalPlaces(step)));
    return Math.min(max, Math.max(min, next));
}

/**
 * 显示格式化：按 step 的小数位收敛浮点尾巴（0.15000 → "0.15"），整数不带小数点。
 * @param {number} v 数值
 * @param {number} step 步长（决定小数位）
 */
export function formatNumberValue(v, step) {
    return Number(v.toFixed(decimalPlaces(step))).toString();
}

/**
 * 数字步进输入。返回 {element, control, value}：control 是原生 input（字符串真源），
 * value 是 getter，实时返回当前数值。
 * @param {object} [o] value/min/max/step/unit/placeholder/disabled/id/title/className/onChange/onInput/attrs
 */
export function createNumber(o = {}) {
    const min = Number.isFinite(o.min) ? o.min : -Infinity;
    const max = Number.isFinite(o.max) ? o.max : Infinity;
    const step = Number.isFinite(o.step) && o.step > 0 ? o.step : 1;
    const initial = parseFloat(o.value);
    // 构造即钳制：初值越界别等失焦才纠（createNumber({value:100, min:0, max:50}) 应直接是 50）
    let current = Number.isFinite(initial) ? Math.min(max, Math.max(min, initial)) : 0;

    const element = document.createElement('span');
    element.className = 'fc-number' + (o.className ? ' ' + o.className : '');
    const box = document.createElement('span');
    box.className = 'fc-number-box';
    const control = document.createElement('input');
    control.className = 'fc-number-input';
    control.spellcheck = false;
    control.setAttribute('inputmode', 'decimal');
    const dec = document.createElement('button');
    dec.type = 'button';
    dec.className = 'fc-number-btn';
    dec.innerHTML = iconSvg('minus', 12);
    const inc = document.createElement('button');
    inc.type = 'button';
    inc.className = 'fc-number-btn';
    inc.innerHTML = iconSvg('plus', 12);
    if (o.id) control.id = o.id;
    if (o.placeholder != null) control.placeholder = String(o.placeholder);
    if (typeof o.onChange === 'function') control.addEventListener('change', o.onChange);
    if (typeof o.onInput === 'function') control.addEventListener('input', o.onInput);
    if (o.title != null) element.dataset.tip = String(o.title);
    if (o.disabled) { control.disabled = true; dec.disabled = true; inc.disabled = true; }
    applyAttrs(control, o);

    function render() {
        control.value = formatNumberValue(current, step);
        dec.disabled = !!o.disabled || current <= min;
        inc.disabled = !!o.disabled || current >= max;
    }
    function commit(v) {
        current = v;
        render();
        control.dispatchEvent(new Event('input', {bubbles: true}));
        control.dispatchEvent(new Event('change', {bubbles: true}));
    }
    function stepValue(dir) {
        const next = stepNumber(current, dir, step, min, max);
        if (next !== current) commit(next);
    }
    // 长按连发：按下立即步进一次，400ms 后每 110ms 一步；抬起/移出/失焦即停。
    // mousedown preventDefault 防止焦点从输入框滑到按钮，打断失焦钳制。
    // 持有期间节点被卸载时 mouseup/mouseleave 都不会来——interval 里自查 isConnected 断链。
    function bindHold(btn, dir) {
        let delayTimer = null;
        let repeatTimer = null;
        const stop = () => { clearTimeout(delayTimer); clearInterval(repeatTimer); delayTimer = null; repeatTimer = null; };
        btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            stepValue(dir);
            delayTimer = setTimeout(() => {
                repeatTimer = setInterval(() => {
                    if (!element.isConnected) { stop(); return; }
                    stepValue(dir);
                }, 110);
            }, 400);
        });
        for (const type of ['mouseup', 'mouseleave', 'blur', 'pointercancel']) btn.addEventListener(type, stop);
    }
    bindHold(dec, -1);
    bindHold(inc, 1);
    control.addEventListener('blur', () => {
        const v = normalizeNumberInput(control.value, min, max);
        if (v === null) { render(); return; } // 非法输入回退上次有效值
        if (v !== current) commit(v);
        else render();
    });
    control.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') control.blur();
        else if (e.key === 'ArrowUp') { e.preventDefault(); stepValue(1); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); stepValue(-1); }
    });

    box.append(dec, control, inc);
    element.append(box);
    if (o.unit != null && o.unit !== '') {
        const unit = document.createElement('span');
        unit.className = 'fc-number-unit';
        unit.textContent = String(o.unit);
        element.append(unit);
    }
    render();
    return {
        element,
        control,
        get value() { return current; },
    };
}

// ── 滑杆（fc-slider）──────────────────────────────────────────────────
// 原生 <input type=range>（默认 .opt-range：accent-color 跟主题，与设置页字号/温度滑杆同款），
// 可选右侧等宽读数。segments 指定段数：轨道分成 N 段只能停 N+1 档 —— 内部 0..N 整数
// 步进（原生 step 锁死拖动与键盘），读取时映射回真实区间；分档时轨道下自动加 N+1 个
// 点标位。注意回调载荷与 createInput/createNumber 不同：onChange / onInput 收到的都是
// 映射后的数值（number，连续模式即原值），不是 Event。

/**
 * 滑杆。返回 {element, control, value}：value 是 getter，返回映射后的数值。
 * @param {object} [o] min/max/step/value/segments/format/showValue/rangeClassName/disabled/id/title/className/onInput/onChange/attrs
 */
export function createSlider(o = {}) {
    const min = Number.isFinite(o.min) ? o.min : 0;
    const max = Number.isFinite(o.max) ? o.max : 100;
    const segments = Number.isFinite(o.segments) && o.segments > 0 ? Math.floor(o.segments) : 0;

    const element = document.createElement('span');
    element.className = 'fc-slider' + (o.className ? ' ' + o.className : '');
    const line = document.createElement('span');
    line.className = 'fc-slider-line';
    const control = document.createElement('input');
    control.type = 'range';
    control.className = o.rangeClassName || 'opt-range';
    if (o.id) control.id = o.id;
    if (o.disabled) control.disabled = true;
    if (o.title != null) element.dataset.tip = String(o.title);
    applyAttrs(control, o);
    if (segments) {
        control.min = '0';
        control.max = String(segments);
        control.step = '1';
        // 无初值（NaN）兜底到档位 0；max === min 时跨度为 0，同样落档位 0
        const span = max - min;
        const rawIdx = span > 0 ? Math.round(((parseFloat(o.value) - min) / span) * segments) : 0;
        const idx = Number.isFinite(rawIdx) ? Math.min(segments, Math.max(0, rawIdx)) : 0;
        control.value = String(idx);
    } else {
        control.min = String(min);
        control.max = String(max);
        if (Number.isFinite(o.step) && o.step > 0) control.step = String(o.step);
        // 浮点区间不传 step 时原生默认 step=1 会把滑杆锁死在锚点上，放行 'any'
        else if (!Number.isInteger(min) || !Number.isInteger(max)) control.step = 'any';
        control.value = String(Number.isFinite(parseFloat(o.value)) ? parseFloat(o.value) : min);
    }

    const fmt = typeof o.format === 'function'
        ? o.format
        : (v) => String(Math.round(v * 1e6) / 1e6); // 默认读数：收敛映射产生的浮点尾巴
    function real() {
        const raw = parseFloat(control.value);
        if (!segments) return raw;
        return min + (max - min) * (raw / segments);
    }
    let valueEl = null;
    if (o.showValue !== false) {
        valueEl = document.createElement('span');
        valueEl.className = 'fc-slider-value';
        valueEl.textContent = fmt(real());
    }
    control.addEventListener('input', () => {
        if (valueEl) valueEl.textContent = fmt(real());
        if (typeof o.onInput === 'function') o.onInput(real());
    });
    control.addEventListener('change', () => {
        if (typeof o.onChange === 'function') o.onChange(real());
    });
    line.append(control);
    if (valueEl) line.append(valueEl);
    element.append(line);
    if (segments) {
        const dots = document.createElement('span');
        dots.className = 'fc-slider-dots';
        for (let i = 0; i <= segments; i++) dots.append(document.createElement('i'));
        element.append(dots);
    }
    return {element, control, get value() { return real(); }};
}

// ── 路径输入（fc-path）───────────────────────────────────────────────
// dlg-input + 「浏览」按钮的组合。core 不碰后端：onBrowse(control) 由调用方注入
// （闭包里拿 mode / filters 调 Wails 文件对话框，把结果写回 control.value）。
// 没传 onBrowse 时按钮禁用——不给「点了没反应」的假按钮留位置。

/**
 * 路径输入框。返回 {element, control}：control 是原生 input。
 * @param {object} [o] value/placeholder/browseLabel/icon/onBrowse/onChange/onInput/disabled/id/title/className/attrs
 */
export function createPathInput(o = {}) {
    const element = document.createElement('span');
    element.className = 'fc-path' + (o.className ? ' ' + o.className : '');
    const built = createInput({
        value: o.value,
        placeholder: o.placeholder,
        spellcheck: false,
        id: o.id,
        onChange: o.onChange,
        onInput: o.onInput,
        attrs: o.attrs,
        tabFillPlaceholder: false, // placeholder 是提示语（如「选择导出位置…」），Tab 填充语义不对
    });
    const control = built.control;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fc-path-btn';
    btn.innerHTML = iconSvg(o.icon || 'folder', 13);
    const label = document.createElement('span');
    label.textContent = o.browseLabel || '浏览';
    btn.append(label);
    if (o.disabled) { control.disabled = true; btn.disabled = true; }
    if (typeof o.onBrowse === 'function') {
        btn.addEventListener('click', () => { if (!btn.disabled) o.onBrowse(control); });
    } else {
        btn.disabled = true;
    }
    if (o.title != null) element.dataset.tip = String(o.title);
    element.append(built.element, btn);
    return {element, control};
}
