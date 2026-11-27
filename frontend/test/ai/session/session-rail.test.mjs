import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {shouldShowRail, railTicks, nextRailScroll, RAIL_MIN_WIDTH} from '../../../src/ai/session/session-rail.js';

// 会话消息导航滑轨：显隐条件、短横线布局、滚轮步进与视觉契约。

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

test('railTicks：每轮一条短横线，按固定像素间距排列', () => {
    const snapshot = {items: [
        {index: 0, round: 1, text: 'a', summary: 'A'},
        {index: 2, round: 2, text: 'b', summary: 'B'},
        {index: 5, round: 3, text: 'c', summary: 'C'},
    ], activeIndex: 5};
    const {ticks, contentHeight, gap} = railTicks(snapshot, 400);
    assert.equal(ticks.length, 3);
    assert.equal(gap, 8);
    // 刻度块（3 条 = 24px）在 400px 轨道里垂直居中：offset (400-24)/2 = 188
    assert.deepEqual(ticks.map((t) => t.top), [192, 200, 208]);
    assert.deepEqual(ticks.map((t) => t.index), [0, 2, 5]);
    assert.deepEqual(ticks.map((t) => t.summary), ['A', 'B', 'C']);
    assert.deepEqual(ticks.map((t) => t.active), [false, false, true]);
    assert.equal(contentHeight, 400, '内容不足一屏时铺满可视高度');
});

test('railTicks：单条消息在轨道中部，不再贴顶', () => {
    const {ticks, contentHeight} = railTicks({items: [{index: 0, round: 1, text: 'a'}], activeIndex: 0}, 400);
    assert.equal(ticks.length, 1);
    assert.equal(ticks[0].top, 200);
    assert.equal(ticks[0].active, true);
    assert.equal(contentHeight, 400);
});

test('railTicks：空快照返回空刻度', () => {
    assert.deepEqual(railTicks(null, 400).ticks, []);
    assert.deepEqual(railTicks({items: []}, 400).ticks, []);
});

test('railTicks：超过可视高度不抽稀，内容高度供滑轨滚动', () => {
    const items = [];
    for (let i = 0; i < 100; i += 1) items.push({index: i, round: i + 1, text: '第' + i, summary: ''});
    const {ticks, contentHeight} = railTicks({items, activeIndex: 97}, 40);
    assert.equal(ticks.length, 100, '每一轮都必须保留，不能为了塞进视口而抽稀');
    assert.equal(contentHeight, 800, '上下各留半个间距，末尾刻度也能完整露出');
    assert.equal(ticks[97].top, 780);
    assert.equal(ticks[97].active, true);
});

test('railTicks：显式 maxTicks 仅拉大间距，不减少刻度', () => {
    const items = [];
    for (let i = 0; i < 20; i += 1) items.push({index: i, round: i + 1, text: 't' + i});
    const {ticks, gap, contentHeight} = railTicks({items, activeIndex: -1}, 4000, 5);
    assert.equal(ticks.length, 20);
    assert.equal(gap, 998);
    assert.equal(contentHeight, 4000);
});

test('railTicks：插话项保留 steer 标记', () => {
    const {ticks} = railTicks({items: [
        {index: 0, round: 1, text: 'a'},
        {index: 1, round: 1, text: '插话', steer: true},
    ], activeIndex: -1}, 400);
    assert.deepEqual(ticks.map((t) => t.steer), [false, true]);
});

test('nextRailScroll：小滚轮逐项滚动并夹在边界内', () => {
    assert.equal(nextRailScroll(0, 1, 40, 796), 8);
    assert.equal(nextRailScroll(20, -1, 40, 796), 12);
    assert.equal(nextRailScroll(0, -100, 40, 796), 0);
    assert.equal(nextRailScroll(740, 100, 40, 796), 756);
});

test('nextRailScroll：大滚轮按可视高度翻页，不可滚动时保持零', () => {
    assert.equal(nextRailScroll(20, 120, 40, 796), 140, '120px 滚轮按三个可视高度步进');
    assert.equal(nextRailScroll(20, -120, 40, 796), 0);
    assert.equal(nextRailScroll(12, 100, 40, 40), 0);
});

test('视觉契约：短横线、即时 tooltip、隐藏滑轨滚动条且固定在面板左缘', () => {
    const rail = readFileSync(new URL('../../../src/ai/session/session-rail.js', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../../../src/style.css', import.meta.url), 'utf8');
    assert.match(rail, /node\.setAttribute\('data-tip-delay', '0'\)/, '悬停必须立即显示 tooltip');
    assert.match(rail, /node\.setAttribute\('data-tip-placement', 'right'\)/, '左缘滑轨的气泡必须向右展开');
    assert.match(css, /\.ai-session-rail \{[^}]*left:\s*2px;[^}]*width:\s*18px/s, '滑轨必须固定在面板左缘');
    assert.match(css, /\.ai-rail-tick \{[^}]*width:\s*12px;[^}]*height:\s*2px;[^}]*border-radius:\s*1px/s, '刻度必须是短横线而不是圆点');
    assert.match(css, /\.ai-rail-track \{[^}]*overflow-y:\s*scroll;[^}]*scrollbar-width:\s*none/s, '滑轨内容必须可滚动但不显示第二条滚动条');
});
