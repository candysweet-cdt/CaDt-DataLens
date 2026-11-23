// ai-timer 纯函数测试：计时器的会话隔离（显示过滤 + 会话内上限计数）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {filterTimersForSession, countSessionTimers, snapshotTimersForTree, secondsUntilClock, createAITimer} from '../../../src/ai/settings/ai-timer.js';

function makeTimers(entries) {
    const timers = new Map();
    for (const info of entries) timers.set(info.id, info);
    return timers;
}

test('filterTimersForSession：只显示归属当前会话的计时器', () => {
    const timers = makeTimers([
        {id: 't1', label: 'A 的倒计时'},
        {id: 't2', label: 'B 的正计时'},
        {id: 't3', label: 'A 的正计时'},
    ]);
    const sessionIdOf = (id) => ({t1: 'sess-a', t2: 'sess-b', t3: 'sess-a'}[id] || '');
    const visible = filterTimersForSession(timers, sessionIdOf, 'sess-a');
    assert.deepEqual(visible.map((t) => t.id).sort(), ['t1', 't3']);
    const visibleB = filterTimersForSession(timers, sessionIdOf, 'sess-b');
    assert.deepEqual(visibleB.map((t) => t.id), ['t2']);
});

test('filterTimersForSession：归属不明（跨窗同步）的计时器保持可见', () => {
    const timers = makeTimers([
        {id: 't1', label: '本会话的'},
        {id: 't2', label: '别的窗口启动的，本实例无归属记录'},
    ]);
    const sessionIdOf = (id) => (id === 't1' ? 'sess-a' : '');
    const visible = filterTimersForSession(timers, sessionIdOf, 'sess-a');
    assert.deepEqual(visible.map((t) => t.id).sort(), ['t1', 't2']);
});

test('countSessionTimers：会话内上限只数归属自己的运行中计时器', () => {
    const timers = makeTimers([
        {id: 't1'}, {id: 't2'}, {id: 't3'}, {id: 't4'}, {id: 't5'}, // 本会话 5 个
        {id: 'x1'}, // 别的会话
        {id: 'x2'}, // 归属不明（跨窗）
    ]);
    const sessionIdOf = (id) => ({t1: 'a', t2: 'a', t3: 'a', t4: 'a', t5: 'a', x1: 'b'}[id] || '');
    assert.equal(countSessionTimers(timers, sessionIdOf, 'a'), 5);
    assert.equal(countSessionTimers(timers, sessionIdOf, 'b'), 1);
    // 空注册表 / 非法输入兜底
    assert.equal(countSessionTimers(makeTimers([]), sessionIdOf, 'a'), 0);
    assert.equal(countSessionTimers(null, sessionIdOf, 'a'), 0);
    assert.equal(filterTimersForSession(null, sessionIdOf, 'a').length, 0);
});

// timer_list 只读快照：只暴露会话链内、归属明确的计时器，并算好已计 / 剩余
test('snapshotTimersForTree：按会话链过滤，归属不明与其它会话一律不外泄', () => {
    const timers = makeTimers([
        {id: 't1', mode: 'countup', label: '主代理正计时', startMs: 1000, marks: [{atMs: 2000}]},
        {id: 't2', mode: 'countdown', label: '主代理倒计时', startMs: 1000, endMs: 31000},
        {id: 'x1', mode: 'countup', label: '别的会话', startMs: 1000},
        {id: 'x2', mode: 'countup', label: '跨窗归属不明', startMs: 1000},
    ]);
    const sessionIdOf = (id) => ({t1: 'root-a', t2: 'sub-parent', x1: 'sess-b'}[id] || '');
    const snap = snapshotTimersForTree(timers, sessionIdOf, ['sub-1', 'sub-parent', 'root-a'], 11000);
    assert.deepEqual(snap.map((t) => t.id), ['t1', 't2'], '只保留会话链上启动的两枚');
    assert.equal(snap[0].elapsedMs, 10000);
    assert.equal(snap[0].marks, 1);
    assert.equal(snap[0].remainingMs, 0, '正计时没有剩余');
    assert.equal(snap[1].remainingMs, 20000);
    assert.equal(snap[1].mode, 'countdown');
    assert.deepEqual(snapshotTimersForTree(timers, sessionIdOf, [], 11000), [], '会话链为空一律不暴露');
    assert.deepEqual(snapshotTimersForTree(null, sessionIdOf, ['root-a'], 11000), []);
});

// 导出面回归：ai-panel 是按名字调用工厂返回值的，漏导出不会在构建期报错，
// 只在运行时炸（例：switchSession 调 timerMod.render() → "render is not a function"，
// 顺带让「切会话后才能投递」的定时任务唤醒全部失败）。这里逐个校验调用点用到的成员。
test('createAITimer：导出 ai-panel 依赖的全部 API', () => {
    const api = createAITimer({
        getBackend: () => null,
        getSessionId: () => '',
        getChip: () => null,
    });
    const required = [
        'start', 'stop', 'sync', 'syncFromBackend', 'snapshot', 'onFired', 'onStopped',
        'render', 'renderPop', 'openCreateDialog', 'closeCreateDialog',
    ];
    for (const name of required) {
        assert.equal(typeof api[name], 'function', '缺少导出：' + name);
    }
});

// start 的会话归属：AI 工具必须显式传「发起调用的会话」，缺省才回落面板当前会话。
// （后台会话运行中用户切到别的对话时，拿可见会话记归属会让到点唤醒与 5 个上限都错到别的会话上。）
function makeStartBackend() {
    const running = [];
    let seq = 0;
    return {
        running,
        async StartTimer(mode, seconds, label) {
            const now = Date.now();
            const created = {id: 'tm' + (++seq), mode, label, startMs: now, endMs: now + seconds * 1000};
            running.push(created);
            return {list: running.slice(), created};
        },
    };
}

// 用例结束必须把本地注册表清空：render 在无计时器时才收掉秒表 interval，否则 node --test 不退出
function drainTimers(api, backend) {
    for (const t of backend.running) api.onStopped({id: t.id});
}

test('createAITimer.start：显式归属优先于面板当前会话（后台会话启动的计时器唤醒自己）', async () => {
    const backend = makeStartBackend();
    const fired = [];
    const api = createAITimer({
        getBackend: () => backend,
        getSessionId: () => 'sess-visible',
        getChip: () => null,
        onFire: (payload) => fired.push(payload),
    });
    const created = await api.start('countdown', 30, '后台会话的等待', 'sess-background');
    assert.deepEqual(api.snapshot(['sess-background']).map((t) => t.id), [created.id]);
    assert.equal(api.snapshot(['sess-visible']).length, 0, '不能记到面板当前会话上');
    api.onFired({id: created.id, label: created.label});
    assert.equal(fired.length, 1);
    assert.equal(fired[0].sessionId, 'sess-background', '到点唤醒的目标是发起会话');
});

test('createAITimer.start：缺省归属回落到面板当前会话（手动创建）', async () => {
    const backend = makeStartBackend();
    const api = createAITimer({
        getBackend: () => backend,
        getSessionId: () => 'sess-visible',
        getChip: () => null,
    });
    const created = await api.start('countup', 0, '手动正计时');
    assert.deepEqual(api.snapshot(['sess-visible']).map((t) => t.id), [created.id]);
    assert.equal(api.snapshot(['sess-background']).length, 0);
    drainTimers(api, backend);
});

test('createAITimer.start：会话内上限按归属会话计数，不误伤面板当前会话', async () => {
    const backend = makeStartBackend();
    const api = createAITimer({
        getBackend: () => backend,
        getSessionId: () => 'sess-visible',
        getChip: () => null,
    });
    for (let i = 0; i < 5; i += 1) await api.start('countdown', 60, '后台 ' + i, 'sess-background');
    await assert.rejects(() => api.start('countdown', 60, '第六个', 'sess-background'), /上限/);
    // 面板当前会话一个计时器都没有：不应被后台会话的 5 个拦下
    await api.start('countdown', 60, '可见会话自己建的', 'sess-visible');
    drainTimers(api, backend);
});

// secondsUntilClock：到点时刻 → 距现在的秒数（创建对话框选时刻替代手输秒）。
test('secondsUntilClock：当天未到 / 已过按明天 / 非法格式', () => {
    // 固定 now：2026-11-15 10:00:00 本地时间
    const now = new Date(2026, 10, 15, 10, 0, 0, 0).getTime();
    // 当天未到：14:30 → 4.5 小时
    assert.equal(secondsUntilClock('14:30', now), 4.5 * 3600);
    // 已过（今早 8 点）→ 明天 8 点：22 小时
    assert.equal(secondsUntilClock('08:00', now), 22 * 3600);
    // 等于现在 → 视为已过，按明天算（24h）
    assert.equal(secondsUntilClock('10:00', now), 24 * 3600);
    // 单位数时刻容错
    assert.equal(secondsUntilClock('8:05', now), 22 * 3600 + 5 * 60);
    // 非法：格式错 / 越界
    assert.equal(secondsUntilClock('not-a-time', now), 0);
    assert.equal(secondsUntilClock('25:00', now), 0);
    assert.equal(secondsUntilClock('12:60', now), 0);
    assert.equal(secondsUntilClock('', now), 0);
});
