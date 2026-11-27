// ai-schedule-scope.test.mjs：定时任务权限档与时间解析纯函数（表驱动）。
// 覆盖：旧 chat 兼容、inherit 解析、上限取更宽档、once 倒计时/日期时间输入。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SCHEDULE_SCOPES, normalizeScheduleScope, widerScope,
    scheduleScopeOptions, resolveScheduleScope, resolveOnceAt, splitOnceAt,
} from '../../src/ai/settings/ai-schedule-scope.js';

test('normalizeScheduleScope：空/旧 chat/非法回退 inherit，合法档原样', () => {
    assert.equal(normalizeScheduleScope(''), 'inherit');
    assert.equal(normalizeScheduleScope(null), 'inherit');
    assert.equal(normalizeScheduleScope('chat'), 'inherit');
    assert.equal(normalizeScheduleScope('danger'), 'inherit');
    for (const s of SCHEDULE_SCOPES) assert.equal(normalizeScheduleScope(s), s);
});

test('widerScope：取更宽档（full<auto<edit<read），inherit 视作最宽', () => {
    assert.equal(widerScope('edit', 'full'), 'full');
    assert.equal(widerScope('read', 'auto'), 'auto');
    assert.equal(widerScope('edit', 'edit'), 'edit');
    assert.equal(widerScope('inherit', 'read'), 'full');
    assert.equal(widerScope('read', 'inherit'), 'full');
});

test('scheduleScopeOptions：绑定会话上限=max(目标,创建会话)，只列不比上限更宽的档', () => {
    // 目标 full、创建会话 edit → 上限 full → 全档可选
    assert.deepEqual(scheduleScopeOptions('full', 'edit', true),
        ['inherit', 'read', 'edit', 'auto', 'full']);
    // 目标 read、创建会话 full → 上限 full → 全档可选（max 取更宽）
    assert.deepEqual(scheduleScopeOptions('read', 'full', true),
        ['inherit', 'read', 'edit', 'auto', 'full']);
    // 两个都 edit → 上限 edit → 只有 inherit/read/edit
    assert.deepEqual(scheduleScopeOptions('edit', 'edit', true),
        ['inherit', 'read', 'edit']);
    // 新建会话（bound=false）上限只看创建会话：read → inherit/read
    assert.deepEqual(scheduleScopeOptions('full', 'read', false),
        ['inherit', 'read']);
});

test('resolveScheduleScope：inherit 绑定沿用会话、新建取设置默认；显式档直接用', () => {
    assert.equal(resolveScheduleScope('inherit', 'edit', 'read', true), 'edit');
    assert.equal(resolveScheduleScope('inherit', 'full', 'read', true), 'full');
    assert.equal(resolveScheduleScope('inherit', '', 'auto', false), 'auto');
    assert.equal(resolveScheduleScope('chat', '', 'read', false), 'read'); // 旧 chat=inherit
    assert.equal(resolveScheduleScope('full', 'edit', 'read', true), 'full'); // 显式档不重算上限
});

test('resolveOnceAt：倒计时 = now + N 分钟；日期时间按本地解析为 ISO', () => {
    const now = new Date(2026, 10, 27, 10, 0, 0);
    const cd = resolveOnceAt({mode: 'countdown', minutes: 30, now});
    assert.equal(cd.ok, true);
    assert.equal(cd.at, new Date(2026, 10, 27, 10, 30, 0).toISOString());

    const dt = resolveOnceAt({mode: 'datetime', datetime: '2026-11-28 09:05', now});
    assert.equal(dt.ok, true);
    assert.equal(dt.at, new Date(2026, 10, 28, 9, 5, 0).toISOString());
});

test('resolveOnceAt：非法输入给出错误', () => {
    assert.equal(resolveOnceAt({mode: 'countdown', minutes: 0}).ok, false);
    assert.equal(resolveOnceAt({mode: 'datetime', datetime: ''}).ok, false);
    assert.equal(resolveOnceAt({mode: 'datetime', datetime: 'not-a-date'}).ok, false);
    assert.equal(resolveOnceAt({mode: 'datetime', datetime: '2020-01-01 09:00'}).ok, false); // 过去
});

test('splitOnceAt：距现在 ≤24h 视为倒计时，否则日期时间', () => {
    const now = new Date(2026, 10, 27, 10, 0, 0);
    const near = splitOnceAt(new Date(2026, 10, 27, 10, 30).toISOString(), now);
    assert.equal(near.mode, 'countdown');
    assert.equal(near.minutes, 30);
    const far = splitOnceAt(new Date(2026, 10, 29, 10, 0).toISOString(), now);
    assert.equal(far.mode, 'datetime');
    assert.ok(far.datetime.startsWith('2026-11-29'));
});
