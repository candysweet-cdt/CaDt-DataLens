// ai-session-send.test.mjs：会话投递选择器的纯函数护栏。
// 交互层（对话框、键盘、滚动）依赖真实 DOM，靠手工回归；这里锁住三条「改了就悄悄错」的判定：
// 标题过滤的大小写与空白处理、上限内的勾选增删、计数文案。
import test from 'node:test';
import assert from 'node:assert/strict';
import {filterSessionRows, togglePicked, pickedLabel, canSubmit, SESSION_PICK_MAX} from '../../../src/ai/session/ai-session-send.js';

const rows = [
    {id: 's1', title: '重构补丁库'},
    {id: 's2', title: 'AI Panel 拆分'},
    {id: 's3', title: ''},
];

test('filterSessionRows：大小写不敏感、去首尾空白、空查询返回全部', () => {
    assert.equal(filterSessionRows(rows, '').length, 3);
    assert.equal(filterSessionRows(rows, '   ').length, 3);
    assert.deepEqual(filterSessionRows(rows, 'panel').map((r) => r.id), ['s2']);
    assert.deepEqual(filterSessionRows(rows, '  补丁  ').map((r) => r.id), ['s1']);
    assert.deepEqual(filterSessionRows(rows, '不存在'), []);
    // 标题缺失的会话不该让过滤炸掉
    assert.deepEqual(filterSessionRows(rows, 's3'), []);
    assert.deepEqual(filterSessionRows(null, 'x'), []);
});

test('togglePicked：勾选/取消互逆，不改原集合', () => {
    const picked = new Set(['s1']);
    const added = togglePicked(picked, 's2', 3);
    assert.equal(added.ok, true);
    assert.deepEqual([...added.picked], ['s1', 's2']);
    assert.deepEqual([...picked], ['s1'], '原集合不被就地修改');

    const removed = togglePicked(added.picked, 's1', 3);
    assert.deepEqual([...removed.picked], ['s2']);
});

test('togglePicked：到上限后拒绝新增，但允许取消已有', () => {
    const full = new Set(Array.from({length: SESSION_PICK_MAX}, (_, i) => 'id' + i));
    const rejected = togglePicked(full, 'new-one', SESSION_PICK_MAX);
    assert.equal(rejected.ok, false);
    assert.match(rejected.message, /最多同时投给 10 个会话/);
    assert.equal(rejected.picked.size, SESSION_PICK_MAX);

    const freed = togglePicked(full, 'id0', SESSION_PICK_MAX);
    assert.equal(freed.ok, true);
    assert.equal(freed.picked.size, SESSION_PICK_MAX - 1);
});

test('togglePicked：空 id 直接拒绝（防止把 undefined 拼进目标列表）', () => {
    const result = togglePicked(new Set(), '', 10);
    assert.equal(result.ok, false);
    assert.equal(result.picked.size, 0);
});

test('pickedLabel：计数带上限，缺省用 10', () => {
    assert.equal(pickedLabel(0, 10), '已选 0/10');
    assert.equal(pickedLabel(3, 10), '已选 3/10');
    assert.equal(pickedLabel(2), '已选 2/10');
});

test('canSubmit：目标与内容缺一不可', () => {
    assert.equal(canSubmit(1, true), true);
    assert.equal(canSubmit(10, true), true);
    assert.equal(canSubmit(0, true), false, '只写内容没选目标不能投');
    assert.equal(canSubmit(1, false), false, '选了目标没写内容不能投（内容由用户自己写）');
    assert.equal(canSubmit(0, false), false);
});
