import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldShowRail, railTicks, RAIL_MIN_WIDTH} from '../../../src/ai/session/session-rail.js';

// 会话消息导航滑轨的纯判定层：显隐条件 + 刻度分布/抽稀。

test('shouldShowRail：开关开启且面板够宽才显示', () => {
    assert.equal(shouldShowRail(true, RAIL_MIN_WIDTH), true);
    assert.equal(shouldShowRail(true, RAIL_MIN_WIDTH + 100), true);
    assert.equal(shouldShowRail(true, RAIL_MIN_WIDTH - 1), false); // 分屏太窄
    assert.equal(shouldShowRail(false, 2000), false); // 开关关闭
    assert.equal(shouldShowRail('true', 2000), false); // 非布尔 true 不算开启
});

test('shouldShowRail：支持自定义阈值', () => {
    assert.equal(shouldShowRail(true, 480, 480), true);
    assert.equal(shouldShowRail(true, 479, 480), false);
});

test('railTicks：每轮一个刻度，按比例均匀分布在 0-100', () => {
    const snapshot = {items: [
        {index: 0, round: 1, text: 'a', summary: 'A'},
        {index: 2, round: 2, text: 'b', summary: 'B'},
        {index: 5, round: 3, text: 'c', summary: 'C'},
    ], activeIndex: 5};
    const ticks = railTicks(snapshot, 400);
    assert.equal(ticks.length, 3);
    assert.deepEqual(ticks.map((t) => t.top), [0, 50, 100]);
    assert.deepEqual(ticks.map((t) => t.index), [0, 2, 5]);
    assert.deepEqual(ticks.map((t) => t.summary), ['A', 'B', 'C']);
    assert.deepEqual(ticks.map((t) => t.active), [false, false, true]);
});

test('railTicks：单条消息居中在 50%', () => {
    const ticks = railTicks({items: [{index: 0, round: 1, text: 'a'}], activeIndex: 0}, 400);
    assert.equal(ticks.length, 1);
    assert.equal(ticks[0].top, 50);
    assert.equal(ticks[0].active, true);
});

test('railTicks：空快照返回空数组', () => {
    assert.deepEqual(railTicks(null, 400), []);
    assert.deepEqual(railTicks({items: []}, 400), []);
});

test('railTicks：超过轨道密度时抽稀，但保留 active 刻度', () => {
    const items = [];
    for (let i = 0; i < 100; i += 1) items.push({index: i, round: i + 1, text: '第' + i, summary: ''});
    // 轨道 40px → 每 4px 一个 → 最多 10 个刻度；active=97（会被 step=10 抽掉，需强制保留）
    const ticks = railTicks({items, activeIndex: 97}, 40);
    assert.ok(ticks.length <= 11, '抽稀后刻度数不超过上限 + 1（补的 active）');
    assert.ok(ticks.some((t) => t.index === 97 && t.active), 'active 刻度必被保留');
});

test('railTicks：显式 maxTicks 覆盖轨道高度推算', () => {
    const items = [];
    for (let i = 0; i < 20; i += 1) items.push({index: i, round: i + 1, text: 't' + i});
    const ticks = railTicks({items, activeIndex: -1}, 4000, 5);
    assert.ok(ticks.length <= 5);
    assert.ok(ticks.length >= 4); // 20/5=4，正好 4 个
});

test('railTicks：插话项带 steer 标记', () => {
    const ticks = railTicks({items: [
        {index: 0, round: 1, text: 'a'},
        {index: 1, round: 1, text: '插话', steer: true},
    ], activeIndex: -1}, 400);
    assert.deepEqual(ticks.map((t) => t.steer), [false, true]);
});
