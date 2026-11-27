// badge.js：胶囊徽标工厂测试（轻量 DOM 桩，套路同 form-controls-factory）。
// 档位样式本体在 style.css 的 .mi-badge 段，这里只验证类名拼装契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createBadge} from '../../src/core/badge.js';

function fakeEl(tag) {
    return {
        tag,
        children: [],
        append(...nodes) { this.children.push(...nodes); },
    };
}
globalThis.document = {
    createElement: (tag) => fakeEl(tag),
    createTextNode: (text) => ({textContent: String(text)}),
};

test('createBadge：默认 accent 档，tone 拼进类名，空文本不炸', () => {
    assert.equal(createBadge({text: '默认'}).className, 'mi-badge');
    assert.equal(createBadge({text: '已完成', tone: 'success'}).className, 'mi-badge success');
    assert.equal(createBadge({text: '等待审批', tone: 'warn'}).className, 'mi-badge warn');
    assert.equal(createBadge({text: '已过期', tone: 'danger'}).className, 'mi-badge danger');
    assert.equal(createBadge({text: '只读', tone: 'muted'}).className, 'mi-badge muted');
    // accent 是基类档，不重复拼类名
    assert.equal(createBadge({text: '默认', tone: 'accent'}).className, 'mi-badge');
    // 无入参：空文本徽标（占位场景）
    const bare = createBadge({});
    assert.equal(bare.className, 'mi-badge');
    assert.equal(bare.textContent, '');
});
