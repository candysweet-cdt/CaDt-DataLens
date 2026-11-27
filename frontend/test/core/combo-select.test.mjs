// combo-select.js 的过滤纯函数与工厂链路测试（轻量 DOM 桩，套路同 form-controls-factory）。
// open() 路径涉及 placePopover / overlay-stack，桩补齐 window / getBoundingClientRect /
// style / classList / remove 后整条链路可走通：聚焦开面板 → 输入过滤 → 点候选选中关面板。
import test from 'node:test';
import assert from 'node:assert/strict';
import {filterComboItems, createComboSelect} from '../../src/core/combo-select.js';

function fakeEl(tag) {
    const el = {
        tag,
        parent: null,
        children: [],
        attrs: {},
        dataset: {},
        listeners: {},
        value: '',
        placeholder: '',
        disabled: false,
        offsetWidth: 200,
        offsetHeight: 32,
        style: {
            left: '', top: '', width: '',
            setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {},
        },
        classList: {
            _set: new Set(),
            contains(c) { return this._set.has(c); },
            add(c) { this._set.add(c); },
            remove(c) { this._set.delete(c); },
        },
        // innerHTML 赋值在真实 DOM 会重建子节点（renderPanel 重建行依赖这一点）；
        // 桩里至少要清空 children，否则「重建」变成「追加」
        get innerHTML() { return this._innerHTML || ''; },
        set innerHTML(v) { this._innerHTML = v; this.children.length = 0; },
        append(...nodes) {
            for (const n of nodes) { n.parent = this; this.children.push(n); }
        },
        appendChild(node) { node.parent = this; this.children.push(node); return node; },
        setAttribute(key, value) { this.attrs[key] = String(value); },
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        dispatchEvent(evt) { for (const fn of this.listeners[evt.type] || []) fn(evt); return true; },
        getBoundingClientRect() { return {left: 10, top: 10, width: 200, height: 32, right: 210, bottom: 42}; },
        remove() {
            if (!this.parent) return;
            const at = this.parent.children.indexOf(this);
            if (at >= 0) this.parent.children.splice(at, 1);
            this.parent = null;
        },
        select() {},
        focus() {},
        blur() {},
    };
    // className 与 classList 联动（真实 DOM 语义）：桩里两者不能是独立字段，
    // 否则 `el.className = 'fc-combo-panel hidden'` 之后 classList.contains('hidden') 为假
    Object.defineProperty(el, 'className', {
        get() { return [...el.classList._set].join(' '); },
        set(v) { el.classList._set = new Set(String(v || '').split(/\s+/).filter(Boolean)); },
    });
    return el;
}
globalThis.Event = class Event { constructor(type) { this.type = type; } };
globalThis.window = {innerWidth: 1024, innerHeight: 768};
const body = fakeEl('body');
globalThis.document = {
    createElement: (tag) => fakeEl(tag),
    createTextNode: (text) => ({textContent: String(text)}),
    body,
};

const ITEMS = [
    {value: 'glm-4.7', label: 'GLM-4.7', sub: '智谱'},
    {value: 'alpha-glm', label: 'Alpha GLM'},
    {value: 'zhipu-only', label: 'X', sub: 'glm'},
    {value: 'zeta', label: 'Zeta'},
];

test('filterComboItems：空查询原序全量、副标题降权、无匹配空数组', () => {
    assert.deepEqual(filterComboItems(ITEMS, '').map((it) => it.value), ITEMS.map((it) => it.value));
    // 'glm'：GLM-4.7 前缀(993) > X·glm 副标题(997-200=797) > Alpha GLM 子串(588)。
    // 副标题降 200 分：只靠副标题蹭进来的候选不排在主标题命中前面。
    assert.deepEqual(filterComboItems(ITEMS, 'glm').map((it) => it.value),
        ['glm-4.7', 'zhipu-only', 'alpha-glm']);
    assert.deepEqual(filterComboItems(ITEMS, '不存在词'), []);
});

test('createComboSelect：结构、初值回填、value getter、setItems 替换候选', () => {
    const combo = createComboSelect({items: ITEMS, value: 'glm-4.7', placeholder: '选择模型…'});
    assert.equal(combo.element.className, 'fc-combo');
    assert.equal(combo.element.children[0], combo.control);
    assert.equal(combo.control.className, 'dlg-input');
    assert.equal(combo.element.children[1].className, 'fc-combo-caret');
    assert.equal(combo.control.value, 'GLM-4.7');
    assert.equal(combo.value, 'glm-4.7');
    assert.equal(combo.control.placeholder, '选择模型…');

    // setItems 整体替换候选：重开面板只剩新列表
    combo.setItems([{value: 'm2', label: 'M2'}]);
    combo.control.listeners.focus[0]({});
    const panel = body.children[body.children.length - 1];
    const rows = panel.children.filter((c) => c.className.includes('fc-combo-item'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].children[1].children[0].textContent, 'M2');
    // 点候选收尾：既验证选中写回，也避免把栈条目带给下一个用例
    rows[0].listeners.click[0]({});
    assert.equal(combo.value, 'm2');
    assert.ok(!body.children.includes(panel));
});

test('createComboSelect：聚焦开面板 → 输入过滤 → 点候选选中关面板并派发 change', () => {
    const seen = [];
    const combo = createComboSelect({items: ITEMS, value: 'glm-4.7', onChange: (e) => seen.push(e.type)});
    combo.control.listeners.focus[0]({});
    // 聚焦：面板挂 body、全量候选、选中行带勾
    const panel = body.children[body.children.length - 1];
    assert.equal(panel.className, 'fc-combo-panel');
    const rows = () => panel.children.filter((c) => c.className.includes('fc-combo-item'));
    assert.equal(rows().length, 4);
    assert.ok(rows()[0].className.includes('selected'));

    // 输入过滤（scoreMatch 排序见 filterComboItems 用例）
    combo.control.value = 'glm';
    combo.control.listeners.input[0]({});
    assert.deepEqual(rows().map((r) => r.children[1].children[0].textContent),
        ['GLM-4.7', 'X', 'Alpha GLM']);

    // 点第一个候选 → 选中、关面板（hidden + 拆节点）、派发 change
    rows()[0].listeners.click[0]({});
    assert.equal(combo.value, 'glm-4.7');
    assert.equal(combo.control.value, 'GLM-4.7');
    assert.deepEqual(seen, ['change']);
    assert.ok(panel.classList.contains('hidden'));
    assert.ok(!body.children.includes(panel));

    // 再聚焦重新开面板：全量候选回来了
    combo.control.listeners.focus[0]({});
    assert.equal(rows().length, 4);
    assert.ok(body.children.includes(panel));

    // 勾位占位：选中行的勾不带 .off，未选中行带（visibility 占位保槽宽）
    assert.ok(rows()[0].children[0].className.includes('fc-combo-check'));
    assert.ok(!rows()[0].children[0].className.includes('off'));
    assert.ok(rows()[1].children[0].className.includes('off'));

    // caret 是 toggle：开着点 = 收面板
    combo.element.children[1].listeners.click[0]({});
    assert.ok(panel.classList.contains('hidden'));

    // 重开 → setItems 打开中替换 → 立即按当前输入重过滤
    combo.control.listeners.focus[0]({});
    combo.control.value = '';
    combo.control.listeners.input[0]({});
    combo.setItems([{value: 'x1', label: 'X1'}, {value: 'x2', label: 'X2'}]);
    assert.deepEqual(rows().map((r) => r.children[1].children[0].textContent), ['X1', 'X2']);

    // Tab 走人：面板跟着收，不悬在 body 上
    combo.control.listeners.keydown[0]({key: 'Tab'});
    assert.ok(panel.classList.contains('hidden'));
    assert.ok(!body.children.includes(panel));
});
