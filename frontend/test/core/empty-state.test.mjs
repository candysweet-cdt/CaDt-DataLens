// empty-state.js：空状态占位工厂测试（轻量 DOM 桩，套路同 form-controls-factory）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {renderEmptyState} from '../../src/core/empty-state.js';

function fakeEl(tag) {
    return {
        tag,
        children: [],
        listeners: {},
        append(...nodes) { this.children.push(...nodes); },
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    };
}
globalThis.document = {
    createElement: (tag) => fakeEl(tag),
    createTextNode: (text) => ({textContent: String(text)}),
};

test('renderEmptyState：icon 圈 + 标题 + 提示 + 动作按钮全形态', () => {
    const full = renderEmptyState({
        icon: 'tray', title: '还没有 AI 会话', hint: '新建一个会话开始对话',
        action: {label: '新建会话'},
    });
    assert.equal(full.className, 'empty-state');
    assert.equal(full.children[0].className, 'empty-state-icon');
    assert.ok(String(full.children[0].innerHTML).includes('<svg')); // iconSvg 注入
    assert.equal(full.children[1].className, 'empty-state-title');
    assert.equal(full.children[1].textContent, '还没有 AI 会话');
    assert.equal(full.children[2].className, 'empty-state-hint');
    assert.equal(full.children[3].className, 'dlg-btn empty-state-action');
    assert.equal(full.children[3].textContent, '新建会话');
    assert.equal(full.children[3].type, 'button');
});

test('renderEmptyState：onClick 绑定到动作按钮', () => {
    let clicked = false;
    const withClick = renderEmptyState({title: '空', action: {label: '清除筛选', onClick: () => { clicked = true; }}});
    // 无 icon / 无 hint：children 是 [title, action]
    assert.equal(withClick.children.length, 2);
    withClick.children[1].listeners.click[0]({});
    assert.ok(clicked);
});

test('renderEmptyState：最小形态只有标题，onClick 缺省不挂监听', () => {
    const bare = renderEmptyState({title: '无记录'});
    assert.equal(bare.children.length, 1);
    assert.equal(bare.children[0].className, 'empty-state-title');

    const noHandler = renderEmptyState({title: '空', action: {label: '点我没反应也不会炸'}});
    // onClick 缺省就不该挂监听——真实 DOM 里点按钮天然无害，挂个空函数反而是噪音
    assert.equal(noHandler.children[1].listeners.click, undefined);
});
