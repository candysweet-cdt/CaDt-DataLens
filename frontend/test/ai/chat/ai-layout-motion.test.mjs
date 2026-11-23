// ai-layout-motion 护栏：AI 面板布局高度补间的判定口径。
// 三处（工具卡折叠 / 队列增减 / padding 让位）共用这套判定，避免各处魔法数字漂移。
import test from 'node:test';
import assert from 'node:assert/strict';
import {LAYOUT_MOTION_MS, MIN_MOTION_DELTA_PX, shouldAnimateLayout, heightKeyframes, LAYOUT_MOTION_OPTIONS} from '../../../src/ai/chat/ai-layout-motion.js';

test('shouldAnimateLayout：高度明显变化才播', () => {
    assert.equal(shouldAnimateLayout(120, 40, false, true), true, '收缩 80px 该播');
    assert.equal(shouldAnimateLayout(40, 120, false, true), true, '展开 80px 也该播');
    assert.equal(shouldAnimateLayout(120, 120, false, true), false, '高度不变不播');
    assert.equal(shouldAnimateLayout(120, 120.5, false, true), false, '半像素差是噪声，不播');
});

test('shouldAnimateLayout：减少动画 / 无 animate 能力时不播', () => {
    assert.equal(shouldAnimateLayout(120, 40, true, true), false, '系统减少动画时不播');
    assert.equal(shouldAnimateLayout(120, 40, false, false), false, '运行时不支持 Element.animate 时不播');
    assert.equal(shouldAnimateLayout(120, 40, true, false), false);
});

test('shouldAnimateLayout：非法高度安全回落，不抛错', () => {
    assert.equal(shouldAnimateLayout(NaN, 40, false, true), false);
    assert.equal(shouldAnimateLayout(120, undefined, false, true), false);
    assert.equal(shouldAnimateLayout('120', 40, false, true), true, '数字字符串可强制转换');
    assert.equal(shouldAnimateLayout(null, 40, false, true), true, 'null 转 0，等价于「从零展开」');
});

test('heightKeyframes / options：关键帧与时长口径', () => {
    assert.deepEqual(heightKeyframes(120.4, 39.6), [
        {height: '120px', overflow: 'hidden'},
        {height: '40px', overflow: 'hidden'},
    ], '四舍五入到整数 px，且带 overflow:hidden');
    assert.equal(LAYOUT_MOTION_MS, 180, '时长保持项目 120–180ms 家族量级');
    assert.equal(MIN_MOTION_DELTA_PX, 1);
    assert.deepEqual({...LAYOUT_MOTION_OPTIONS}, {duration: 180, easing: 'ease'});
    assert.equal(Object.isFrozen(LAYOUT_MOTION_OPTIONS), true, '选项对象冻结，避免调用方误改');
});
