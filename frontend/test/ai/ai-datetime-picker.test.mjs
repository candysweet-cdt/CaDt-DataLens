// ai-datetime-picker.test.mjs：自绘日期时间选择器（纯函数行为 + 接线守卫）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {
    parseValue, formatValue, FIELDS_DATE, FIELDS_TIME, FIELDS_DATETIME,
} from '../../src/ai/settings/ai-datetime-picker.js';

const read = (rel) => readFileSync(fileURLToPath(new URL('../../' + rel, import.meta.url)), 'utf8');

test('parseValue：支持空格/T 分隔、可选秒；非法返回 null', () => {
    assert.deepEqual(parseValue('2026-11-27 09:05'), {y: 2026, mo: 11, d: 27, h: 9, mi: 5, s: 0});
    assert.deepEqual(parseValue('2026-11-27T09:05:30'), {y: 2026, mo: 11, d: 27, h: 9, mi: 5, s: 30});
    assert.deepEqual(parseValue('2026-11-27'), {y: 2026, mo: 11, d: 27, h: 0, mi: 0, s: 0});
    assert.equal(parseValue('not-a-date'), null);
});

test('formatValue：只输出 fields 启用的粒度（组件通用性的核心）', () => {
    const v = {y: 2026, mo: 11, d: 27, h: 9, mi: 5, s: 30};
    assert.equal(formatValue(v, FIELDS_DATE), '2026-11-27');
    assert.equal(formatValue(v, FIELDS_TIME), '09:05:30');
    assert.equal(formatValue(v, FIELDS_DATETIME), '2026-11-27 09:05');
    assert.equal(formatValue(v, ['month', 'day']), '11-27');
    assert.equal(formatValue(v, ['hour', 'minute']), '09:05');
});

test('接线：浮层走 overlay-stack + placePopover，图标走 iconSvg，无原生 datetime-local', () => {
    const src = read('src/ai/settings/ai-datetime-picker.js');
    assert.ok(/overlayStack\.open\(/.test(src), '浮层必须注册进 overlay-stack');
    assert.ok(/closeOnOutsideClick:\s*true/.test(src), '外点关闭走同一栈');
    assert.ok(/placePopover\(/.test(src), '定位走 core/popover-position');
    assert.ok(/iconSvg\('calendar'/.test(src), '日历图标走注册表');
    assert.ok(!/type:\s*'datetime-local'/.test(src), '不得创建原生 datetime-local 控件');
});

test('接线：弹窗用自绘控件替换原生 datetime，日历头部箭头分列两侧', () => {
    const sched = read('src/ai/settings/ai-schedule.js');
    assert.ok(/createDateTimePicker\(/.test(sched), '编辑器必须创建自绘日期时间控件');
    assert.ok(!/type:\s*'datetime-local'/.test(sched), '编辑器不得再建原生 datetime-local');
    const picker = read('src/ai/settings/ai-datetime-picker.js');
    assert.ok(/hd\.append\(prev, title, next\)/.test(picker), '日历头部必须是 ‹ 标题 › 三段式');
});

test('接线：触发器支持手输（input change 直接回调，不被强制选择）', () => {
    const src = read('src/ai/settings/ai-datetime-picker.js');
    assert.ok(/createInput\(\{/.test(src), '手输框走 form-controls 工厂');
    assert.ok(/input\.addEventListener\('change'/.test(src), '手输 change 必须回调');
});
