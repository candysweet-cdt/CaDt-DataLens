// test/core/dom.test.mjs：core/dom.js 的 el(tag, cls, text) 三态语义。
// 这套语义是从十几个模块逐字搬来的（空 cls 跳过、text 为 null/undefined 不设），
// 迁移时任何一处变化都会改变已有 DOM 输出的类名/文本，所以在这里钉死。
import test from 'node:test';
import assert from 'node:assert/strict';

// dom.js 只在调用时读全局 document，给一个最小桩即可（不引 jsdom，体积预算 0）
const created = [];
globalThis.document = {
    createElement(tag) {
        const node = {tagName: tag, className: '', textContent: null};
        created.push(node);
        return node;
    },
};

const {el} = await import('../../src/core/dom.js');

test('el：建出请求的标签，空 cls / 缺省 text 时不写属性', () => {
    const node = el('div');
    assert.equal(node.tagName, 'div');
    assert.equal(node.className, '');
    assert.equal(node.textContent, null);
});

test('el：cls 与 text 一起设置', () => {
    const node = el('span', 'a b', '文本');
    assert.equal(node.className, 'a b');
    assert.equal(node.textContent, '文本');
});

test('el：text 为空串会写入（≠ 不设置——空串同样清空内容）', () => {
    const node = el('p', 'cls', '');
    assert.equal(node.textContent, '');
});

test('el：text 为 null / undefined 时不写 textContent', () => {
    assert.equal(el('p', '', null).textContent, null);
    assert.equal(el('p', '', undefined).textContent, null);
});

test('el：数字 0 是合法文本（不能被 falsy 判断吃掉）', () => {
    // 真实 DOM 的 textContent 是字符串：赋 number 由 setter 转成 '0'，dom.js 现在显式 String()（等价）。
    assert.equal(el('td', '', 0).textContent, '0');
});

test('el：falsy 的 cls（空串）不覆盖默认 className', () => {
    assert.equal(el('div', '', 'x').className, '');
    assert.equal(el('div', null, 'x').className, '');
});

test('el：每次调用建一个新节点，不复用', () => {
    const before = created.length;
    el('div');
    el('div');
    assert.equal(created.length, before + 2);
});
