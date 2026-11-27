// 表单控件封装的测试 + 「禁止新增裸原生控件」静态防线。
// 规范见 docs/frontend-form-controls.md / AGENTS.md「前端侧」。
//
// BASELINE 是 2026-11-15 的存量快照，按文件记录裸原生控件数：
//   - 新增任何一处裸 <input>/<select>/<textarea> 或 createElement 表单控件都会让计数超基线而失败；
//   - 迁移存量后把对应数字调小，**永远不要调大**；
//   - 新文件里出现裸用法直接失败（基线里没有该文件）。
// 用 `PRINT_FORM_BASELINE=1 node --test test/core/form-controls-factory.test.mjs` 可重新打印当前快照。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join, dirname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    createSwitch,
    createSelect,
    createInput,
    createTextarea,
    createCheckbox,
    enableTabFillPlaceholder,
    createNumber,
    createSlider,
    createPathInput,
    normalizeNumberInput,
    stepNumber,
    formatNumberValue,
} from '../../src/core/form-controls.js';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---- 轻量 DOM 桩：工厂只用到 createElement / append / appendChild / setAttribute ----
function fakeEl(tag) {
    return {
        tag,
        className: '',
        children: [],
        attrs: {},
        dataset: {},
        listeners: {},
        value: '',
        placeholder: '',
        append(...nodes) { this.children.push(...nodes); },
        appendChild(node) { this.children.push(node); return node; },
        setAttribute(key, value) { this.attrs[key] = String(value); },
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        dispatchEvent(evt) { for (const fn of this.listeners[evt.type] || []) fn(evt); return true; },
    };
}
globalThis.Event = class Event {
    constructor(type) { this.type = type; }
};
globalThis.document = {
    createElement: (tag) => fakeEl(tag),
    createTextNode: (text) => ({textContent: String(text)}),
};

test('createSwitch 生成 .set-switch 三段结构，control 是值真源', () => {
    const {element, control} = createSwitch({id: 'foo-enabled', checked: true});
    assert.equal(element.className, 'set-switch');
    assert.equal(control.type, 'checkbox');
    assert.equal(control.checked, true);
    assert.equal(control.id, 'foo-enabled');
    assert.equal(element.children.length, 3);
    assert.equal(element.children[0], control);
    assert.deepEqual(element.children.slice(1).map((c) => c.className),
        ['set-switch-track', 'set-switch-thumb']);
});

test('createSelect 带 .opt-select 且生成 option', () => {
    const {element, control} = createSelect({
        id: 'foo-scope',
        options: [{value: 'a', label: 'A'}, {value: 'b', label: 'B', selected: true}],
    });
    assert.equal(element, control);
    assert.equal(control.className, 'opt-select');
    assert.equal(control.id, 'foo-scope');
    assert.equal(control.children.length, 2);
    assert.equal(control.children[1].value, 'b');
    assert.equal(control.children[1].textContent, 'B');
    assert.equal(control.children[1].selected, true);
});

test('createInput / createTextarea 带封装 class 且透传常用属性与事件', () => {
    const onChange = () => {};
    const input = createInput({
        id: 'foo-name', type: 'password', placeholder: 'MY_API_KEY',
        spellcheck: false, autocomplete: 'off', onChange,
    });
    assert.equal(input.element, input.control);
    assert.equal(input.control.className, 'dlg-input');
    assert.equal(input.control.type, 'password');
    assert.equal(input.control.placeholder, 'MY_API_KEY');
    assert.equal(input.control.spellcheck, false);
    assert.equal(input.control.autocomplete, 'off');
    assert.deepEqual(input.control.listeners.change, [onChange]);

    const area = createTextarea({id: 'foo-prompt', rows: 5, disabled: true, attrs: {'data-k': 'v'}});
    assert.equal(area.control.className, 'dlg-input ai-settings-textarea');
    assert.equal(area.control.rows, 5);
    assert.equal(area.control.disabled, true);
    assert.equal(area.control.attrs['data-k'], 'v');

    // 存量迁移时显式 className 覆盖默认值，保证各域原有外观零变化
    const legacy = createInput({className: 'ai-settings-input'});
    assert.equal(legacy.control.className, 'ai-settings-input');
});

test('tabFillPlaceholder：createInput 默认启用，空值 + Tab 填 placeholder 并派发 input/change', () => {
    const {control} = createInput({placeholder: '默认值'});
    const inputs = [];
    const changes = [];
    control.addEventListener('input', () => inputs.push(control.value));
    control.addEventListener('change', () => changes.push(control.value));

    // 空值 + 普通 Tab → 填入 placeholder
    control.listeners.keydown[0]({key: 'Tab'});
    assert.equal(control.value, '默认值');
    assert.deepEqual(inputs, ['默认值']);
    assert.deepEqual(changes, ['默认值']);

    // 已有值不再覆盖
    control.listeners.keydown[0]({key: 'Tab'});
    assert.equal(control.value, '默认值');
    assert.equal(inputs.length, 1);
});

test('tabFillPlaceholder：Shift+Tab / 组合键 / 无 placeholder / 显式关闭 都不填', () => {
    const {control} = createInput({placeholder: '默认值'});
    control.listeners.keydown[0]({key: 'Tab', shiftKey: true});
    assert.equal(control.value, '');
    control.listeners.keydown[0]({key: 'Tab', ctrlKey: true});
    assert.equal(control.value, '');
    control.listeners.keydown[0]({key: 'Enter'});
    assert.equal(control.value, '');

    const noPh = createInput({tabFillPlaceholder: true});
    noPh.control.listeners.keydown[0]({key: 'Tab'});
    assert.equal(noPh.control.value, '');

    const optedOut = createInput({placeholder: '默认值', tabFillPlaceholder: false});
    assert.equal(optedOut.control.listeners.keydown, undefined);

    // textarea 同样默认启用
    const area = createTextarea({placeholder: '默认正文'});
    area.control.listeners.keydown[0]({key: 'Tab'});
    assert.equal(area.control.value, '默认正文');

    // 重复绑定守卫：同一控件重复启用只挂一个 keydown
    enableTabFillPlaceholder(control);
    assert.equal(control.listeners.keydown.length, 1);
});

test('createCheckbox 生成紧凑行内勾选（label 内带文字），control 是值真源', () => {
    const onChange = () => {};
    const {element, control} = createCheckbox({
        id: 'gs-fuzzy-enabled', label: '模糊', checked: true,
        disabled: true, title: '提示', onChange,
    });
    assert.equal(element.className, 'set-check');
    assert.equal(control.type, 'checkbox');
    assert.equal(control.checked, true);
    assert.equal(control.disabled, true);
    assert.equal(control.id, 'gs-fuzzy-enabled');
    assert.equal(element.dataset.tip, '提示');
    assert.equal(element.children[0], control);
    assert.equal(element.children[1].textContent, '模糊');
    assert.deepEqual(control.listeners.change, [onChange]);
});

// ---- 数字步进 / 滑杆 / 路径输入（fc- 工厂，2026-11-28 起） ----

test('stepNumber / normalizeNumberInput / formatNumberValue 纯函数', () => {
    // 步进：对齐与边界
    assert.equal(stepNumber(30, 1, 5, 5, 600), 35);
    assert.equal(stepNumber(600, 1, 5, 5, 600), 600);   // 顶格不再加
    assert.equal(stepNumber(5, -1, 5, 5, 600), 5);      // 到底不再减
    assert.equal(stepNumber(0.1, 1, 0.05, 0, 2), 0.15); // 浮点尾巴收敛
    // 失焦规范化：越界钳制 + 非法回退
    assert.equal(normalizeNumberInput('42', 5, 600), 42);
    assert.equal(normalizeNumberInput('9999', 5, 600), 600);
    assert.equal(normalizeNumberInput('1', 5, 600), 5);
    assert.equal(normalizeNumberInput('abc', 5, 600), null);
    assert.equal(normalizeNumberInput('', 5, 600), null);
    // 显示格式化：按 step 小数位收敛
    assert.equal(formatNumberValue(30, 5), '30');
    assert.equal(formatNumberValue(0.1500000001, 0.05), '0.15');
});

test('createNumber：fc-number 结构、按钮/键盘步进、失焦钳制回退、value getter', () => {
    const seen = [];
    const num = createNumber({value: 30, min: 5, max: 600, step: 5, unit: '秒', onChange: (e) => seen.push(e.type)});
    assert.equal(num.element.className, 'fc-number');
    const box = num.element.children[0];
    assert.equal(box.className, 'fc-number-box');
    assert.equal(box.children[0].className, 'fc-number-btn');
    assert.equal(box.children[1], num.control);
    assert.equal(box.children[2].className, 'fc-number-btn');
    assert.equal(num.element.children[1].className, 'fc-number-unit');
    assert.equal(num.element.children[1].textContent, '秒');
    assert.equal(num.control.className, 'fc-number-input');
    assert.equal(num.control.value, '30');
    assert.equal(num.value, 30);

    // 按钮 + 一步：30 → 35，派发 input+change（长按连发的定时器必须在测试内清掉，
    // 否则 Node 事件池不空、--test 进程永不退出）
    box.children[2].listeners.mousedown[0]({preventDefault() {}});
    box.children[2].listeners.mouseup[0]({});
    assert.equal(num.value, 35);
    assert.deepEqual(seen, ['change']);
    assert.equal(num.control.value, '35');

    // 键盘 ↑↓
    num.control.listeners.keydown[0]({key: 'ArrowUp', preventDefault() {}});
    assert.equal(num.value, 40);
    num.control.listeners.keydown[0]({key: 'ArrowDown', preventDefault() {}});
    assert.equal(num.value, 35);

    // 失焦：非法回退上次有效值
    num.control.value = 'abc';
    num.control.listeners.blur[0]({});
    assert.equal(num.value, 35);
    assert.equal(num.control.value, '35');

    // 失焦：越界钳到上沿
    num.control.value = '9999';
    num.control.listeners.blur[0]({});
    assert.equal(num.value, 600);
    assert.equal(box.children[2].disabled, true); // 到顶后 + 禁用
});

test('createNumber：初值越界构造即钳制；科学计数法小步长不失效', () => {
    const clamped = createNumber({value: 100, min: 0, max: 50, step: 5});
    assert.equal(clamped.value, 50);
    assert.equal(clamped.control.value, '50');
    assert.equal(clamped.element.children[0].children[2].disabled, true); // 到顶 + 禁用
    // String(1e-7) 是 '1e-7'，split('.') 取小数位会得 0——必须按指数尾数还原
    assert.equal(stepNumber(0, 1, 1e-7, 0, 1), 1e-7);
    assert.equal(formatNumberValue(0.15, 1e-7), '0.15');
});

test('createSlider：segments 无初值/零跨度兜底档位 0；浮点区间缺省 step 放行 any', () => {
    const noValue = createSlider({min: 0, max: 2, segments: 4});
    assert.equal(noValue.control.value, '0');
    assert.equal(noValue.value, 0);
    const zeroSpan = createSlider({min: 1, max: 1, segments: 4});
    assert.equal(zeroSpan.control.value, '0');
    assert.equal(zeroSpan.value, 1);
    const floatRange = createSlider({min: 0.1, max: 1});
    assert.equal(floatRange.control.step, 'any');
});

test('createSlider：连续模式走 opt-range，读数实时跟随', () => {
    let latest = null;
    const slider = createSlider({min: 0, max: 2, step: 0.05, value: 0.7, onInput: (v) => { latest = v; }});
    assert.equal(slider.element.className, 'fc-slider');
    assert.equal(slider.control.className, 'opt-range');
    assert.equal(slider.control.min, '0');
    assert.equal(slider.control.max, '2');
    assert.equal(slider.control.step, '0.05');
    assert.equal(slider.value, 0.7);
    const readout = slider.element.children[0].children[1];
    assert.equal(readout.className, 'fc-slider-value');
    assert.equal(readout.textContent, '0.7');
    slider.control.value = '1.5';
    slider.control.listeners.input[0]({});
    assert.equal(latest, 1.5);
    assert.equal(readout.textContent, '1.5');
    // showValue: false 不生成读数
    const bare = createSlider({min: 0, max: 10, value: 2, showValue: false});
    assert.equal(bare.element.children[0].children.length, 1);
});

test('createSlider：segments 分段锁档，点标位 N+1 个，读取映射回真实区间', () => {
    const slider = createSlider({min: 0, max: 2, value: 0.5, segments: 4});
    assert.equal(slider.control.min, '0');
    assert.equal(slider.control.max, '4');
    assert.equal(slider.control.step, '1');
    assert.equal(slider.control.value, '1'); // 0.5 → 档位 1
    assert.equal(slider.value, 0.5);
    const dots = slider.element.children[1];
    assert.equal(dots.className, 'fc-slider-dots');
    assert.equal(dots.children.length, 5);
    slider.control.value = '4';
    slider.control.listeners.input[0]({});
    assert.equal(slider.value, 2);
    // 初值越界钳进档位范围
    const clamped = createSlider({min: 0, max: 2, value: 99, segments: 4});
    assert.equal(clamped.control.value, '4');
});

test('createPathInput：dlg-input + 浏览按钮，onBrowse 收到 control；无 onBrowse 禁用按钮', () => {
    let picked = null;
    const path = createPathInput({value: 'D:\\a', onBrowse: (ctl) => { picked = ctl; ctl.value = 'D:\\b'; }});
    assert.equal(path.element.className, 'fc-path');
    assert.equal(path.control.className, 'dlg-input');
    assert.equal(path.control.value, 'D:\\a');
    const btn = path.element.children[1];
    assert.equal(btn.className, 'fc-path-btn');
    assert.equal(btn.children[0].textContent, '浏览');
    btn.listeners.click[0]({});
    assert.equal(picked, path.control);
    assert.equal(path.control.value, 'D:\\b');

    const noBrowse = createPathInput({placeholder: '选择导出位置…'});
    assert.equal(noBrowse.element.children[1].disabled, true);
    // path 输入不启用 Tab 填 placeholder（placeholder 是提示语，填进去语义不对）
    assert.equal(noBrowse.control.listeners.keydown, undefined);

    // disabled 必须连浏览按钮一起禁（否则能点开对话框往禁用输入框写值）
    const disabled = createPathInput({disabled: true, onBrowse: () => {}});
    assert.equal(disabled.control.disabled, true);
    assert.equal(disabled.element.children[1].disabled, true);
});

// ---- 静态防线 ----

// 2026-11-15 存量快照。迁移一处就把对应数字减一；新增一处会让测试失败。
const BASELINE = {
    'index.html': 19, // palette-input 已改用 .dlg-input 封装
    'src/ai/settings/ai-manage-dialogs.js': 1,
    'src/ai/tools/ai-mcp-settings.js': 2,
    // phase3 A2 把 ai-takeover 的补丁卡 / ask 卡拆成兄弟模块：4 处裸控件随域迁移
    // （ask-cards 2 + patch-card 2），宿主 11 → 7，总量不变、非新增债务
    'src/ai/chat/ai-ask-cards.js': 2,
    'src/ai/ai-panel.js': 2,
    'src/ai/chat/ai-patch-card.js': 2,
    'src/ai/chat/ai-reminders.js': 4,
    'src/ai/session/ai-session-list.js': 1,
    'src/ai/chat/ai-takeover.js': 7,
    'src/ai/settings/ai-timer.js': 3,
    'src/ai/tools/ai-tool-cards.js': 2,
    'src/editor/editor-browser-tab.js': 1,
    'src/editor/editor-csv-view.js': 1,
    'src/editor/editor-sql-view.js': 2,
    'src/editor/foot-menus.js': 1,
    'src/editor/patch-view.js': 4,
    'src/reading/reading.js': 1,
    'src/settings/settings-pane-envvars.js': 1,
    'src/settings/settings-pane-lang.js': 3,
    'src/settings/settings-pane-plugins.js': 1,
    'src/terminal/terminal-ui.js': 2,
};

function sourceFiles() {
    const out = [join(FRONTEND, 'index.html')];
    const src = join(FRONTEND, 'src');
    for (const rel of readdirSync(src, {recursive: true, encoding: 'utf8'})) {
        const norm = rel.replace(/\\/g, '/');
        if (!norm.endsWith('.js')) continue;
        if (norm === 'core/form-controls.js') continue; // 封装实现本身是唯一例外
        out.push(join(src, rel));
    }
    return out;
}

// 封装 class 白名单：只有这些 class 的静态写法算「已封装」。
// 之前只判「标签里有没有 class=」，于是 class="随便什么" 也能绕过——
// index.html 里 109 处裸控件全部落在基线之外，护栏等于没设。
const ALLOWED_CLASS_TOKENS = new Set([
    'ai-input',
    'ai-font-size-num',
    'find-input',
    'gb-search',
    'git-message',
    'sb-filter-input',
    'settings-search',
    'sub-agent-choice',
    'writing-goal-input',
    'mcfg-input-sm',
    'mcfg-textarea',
]);
const ALLOWED_CLASS_PREFIXES = ['dlg-', 'opt-', 'mcfg-', 'ai-settings-', 'run-'];

function hasWrappedClass(tag) {
    const m = tag.match(/\bclass="([^"]*)"/);
    if (!m) return false;
    const tokens = m[1].trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return false;
    // 每个 token 都必须是白名单：混进一个野 class 就按未封装算。
    return tokens.every((t) => ALLOWED_CLASS_TOKENS.has(t) ||
        ALLOWED_CLASS_PREFIXES.some((prefix) => t.startsWith(prefix)));
}

function countRawControls(text) {
    // 已封装的 .set-switch 结构内部的隐藏 checkbox 不算裸用法
    const cleaned = text.replace(
        /<label[^>]*class="[^"]*set-switch[^"]*"[^>]*>[\s\S]*?<\/label>/g, '',
    );
    let count = 0;
    for (const m of cleaned.matchAll(/<(?:input|select|textarea)\b[^>]*>/gi)) {
        if (hasWrappedClass(m[0])) continue; // 带白名单封装 class 的静态写法才合规
        count++;
    }
    for (const _m of cleaned.matchAll(/createElement\(\s*['"](?:input|select|textarea)['"]\s*\)/gi)) {
        count++;
    }
    return count;
}

function scan() {
    const counts = {};
    for (const file of sourceFiles()) {
        const n = countRawControls(readFileSync(file, 'utf8'));
        if (n > 0) counts[relative(FRONTEND, file).replace(/\\/g, '/')] = n;
    }
    return counts;
}

const snapshot = scan();
if (process.env.PRINT_FORM_BASELINE === '1') {
    console.log('CURRENT_RAW_CONTROL_COUNTS=' + JSON.stringify(snapshot, null, 2));
}

// 防止扫描器本身空转（module-scope 扫描器曾因正则漏匹配长期假绿）
test('扫描器自测：抓得到裸控件、放得过封装结构', () => {
    assert.equal(countRawControls('<input type="checkbox">'), 1);
    assert.equal(countRawControls('<select><option>x</option></select>'), 1);
    assert.equal(countRawControls('<textarea></textarea>'), 1);
    assert.equal(countRawControls("document.createElement('select')"), 1);
    assert.equal(countRawControls('<input class="dlg-input" type="text">'), 0);
    assert.equal(countRawControls('<label class="set-switch"><input type="checkbox"></label>'), 0);
    // 任意 class 不能放行：这是原先的绕过口子
    assert.equal(countRawControls('<input class="whatever" type="text">'), 1);
    assert.equal(countRawControls('<input class="dlg-input evil" type="text">'), 1);
    assert.equal(countRawControls('<input class="" type="text">'), 1);
    assert.equal(countRawControls("const el = document.createElement('div');"), 0);
});

test('禁止新增裸原生表单控件（按文件基线，只许减不许增）', () => {
    for (const [file, count] of Object.entries(snapshot)) {
        const base = BASELINE[file];
        assert.ok(base !== undefined,
            `新文件 ${file} 出现 ${count} 处裸原生控件；请改用 core/form-controls.js 工厂或静态封装结构`);
        assert.ok(count <= base,
            `${file} 的裸原生控件从 ${base} 增到 ${count}；新增 UI 一律用封装（迁移存量后把基线调小）`);
    }
});
