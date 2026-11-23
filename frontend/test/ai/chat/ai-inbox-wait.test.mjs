// ai-inbox-wait.test.mjs：等待原语的护栏（对齐 dsh wait_agent 的语义）。
// 这些用例锁住「改了就悄悄坏」的四处：落地即有输入不空等、notify 唤醒、
// 超时/停止各自返回、owner 之间互不串扰（否则一个会话的入队会唤醒别人的等待）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {createInboxWaiters} from '../../../src/ai/chat/ai-inbox-wait.js';

// 假时钟：让超时与心跳都变成确定性推进，测试毫秒级完成。
function fakeClock() {
    let now = 0;
    let seq = 0;
    const timers = new Map();
    return {
        now: () => now,
        setTimeout(fn, ms) {
            const id = ++seq;
            timers.set(id, {at: now + (Number(ms) || 0), fn});
            return id;
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        advance(ms) {
            const target = now + ms;
            for (;;) {
                let nextId = null;
                let nextTimer = null;
                for (const [id, timer] of timers) {
                    if (timer.at <= target && (!nextTimer || timer.at < nextTimer.at)) {
                        nextId = id;
                        nextTimer = timer;
                    }
                }
                if (!nextTimer) break;
                timers.delete(nextId);
                now = nextTimer.at;
                nextTimer.fn();
            }
            now = target;
        },
        pending: () => timers.size,
    };
}

function makeWaiters(tickMs) {
    const clock = fakeClock();
    const waiters = createInboxWaiters({
        tickMs: tickMs || 50,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
    });
    return {clock, waiters};
}

test('落地即有输入：不发定时器、立刻返回 timedOut:false', async () => {
    const {clock, waiters} = makeWaiters();
    const result = await waiters.wait('s1', {timeoutMs: 1000, hasPending: () => true});
    assert.deepEqual(result, {timedOut: false});
    assert.equal(clock.pending(), 0, '不该留下任何定时器');
    assert.equal(waiters.sizeOf('s1'), 0);
});

test('notify 唤醒：等待中的 waiter 立刻拿到「有新输入」', async () => {
    const {clock, waiters} = makeWaiters();
    let has = false;
    const pending = waiters.wait('s1', {timeoutMs: 10000, hasPending: () => has});
    assert.equal(waiters.sizeOf('s1'), 1, '等待期间要在表里');
    has = true;
    assert.equal(waiters.notify('s1'), 1, '入队即唤醒');
    assert.deepEqual(await pending, {timedOut: false});
    assert.equal(waiters.sizeOf('s1'), 0, '唤醒后必须出表（否则泄漏）');
    assert.equal(clock.pending(), 0, '定时器也要清干净');
    assert.equal(waiters.notify('s1'), 0, '重复 notify 幂等');
});

test('notify 带 source：来源随结果带回（排队不打扰等待，只有插话/通知会唤醒）', async () => {
    const {clock, waiters} = makeWaiters();
    const steer = waiters.wait('s1', {timeoutMs: 10000, hasPending: () => false});
    assert.equal(waiters.notify('s1', 'steer'), 1);
    assert.deepEqual(await steer, {timedOut: false, source: 'steer'});

    const notice = waiters.wait('s2', {timeoutMs: 10000, hasPending: () => false});
    assert.equal(waiters.notify('s2', 'notice'), 1);
    assert.deepEqual(await notice, {timedOut: false, source: 'notice'});

    const agent = waiters.wait('s3', {timeoutMs: 10000, hasPending: () => false});
    assert.equal(waiters.notify('s3', 'agent'), 1);
    assert.deepEqual(await agent, {timedOut: false, source: 'agent'});

    // 落地即有输入 / 心跳结算的路径没有 notify 来源：结果保持旧形状（无 source 键）。
    assert.deepEqual(await waiters.wait('s4', {timeoutMs: 1000, hasPending: () => true}), {timedOut: false});
    assert.equal(clock.pending(), 0, '所有等待结算后不留定时器');
});

test('超时：到点返回 timedOut:true，且不留定时器', async () => {
    const {clock, waiters} = makeWaiters();
    const pending = waiters.wait('s1', {timeoutMs: 1000, hasPending: () => false});
    clock.advance(1000);
    assert.deepEqual(await pending, {timedOut: true});
    assert.equal(waiters.sizeOf('s1'), 0);
    assert.equal(clock.pending(), 0);
});

test('被停止：心跳发现后立刻返回 stopped:true，不等满超时', async () => {
    const {clock, waiters} = makeWaiters();
    let stopped = false;
    const pending = waiters.wait('s1', {timeoutMs: 10000, hasPending: () => false, isStopped: () => stopped});
    stopped = true;
    clock.advance(50);
    assert.deepEqual(await pending, {timedOut: true, stopped: true});
    assert.equal(clock.pending(), 0);
});

test('调用时已停止：直接返回，不注册 waiter', async () => {
    const {clock, waiters} = makeWaiters();
    const result = await waiters.wait('s1', {timeoutMs: 1000, hasPending: () => false, isStopped: () => true});
    assert.deepEqual(result, {timedOut: true, stopped: true});
    assert.equal(waiters.sizeOf('s1'), 0);
    assert.equal(clock.pending(), 0);
});

test('竞态：注册前入队不丢（注册后由心跳发现）', async () => {
    const {clock, waiters} = makeWaiters();
    let has = false;
    const pending = waiters.wait('s1', {timeoutMs: 10000, hasPending: () => has});
    // 模拟「notify 恰好发生在注册之前」：表里没有 waiter，notify 是空操作。
    has = true;
    assert.equal(waiters.notify('s1'), 1, '即便 notify 落空，心跳也要兜住');
    assert.deepEqual(await pending, {timedOut: false});
    // 另一种顺序：没人 notify，只有 hasPending 变真——心跳同样要发现。
    const clock2 = makeWaiters();
    let has2 = false;
    const pending2 = clock2.waiters.wait('s2', {timeoutMs: 10000, hasPending: () => has2});
    has2 = true;
    clock2.clock.advance(50);
    assert.deepEqual(await pending2, {timedOut: false});
});

test('owner 隔离：唤醒一个会话不打扰另一个', async () => {
    const {clock, waiters} = makeWaiters();
    const a = waiters.wait('s1', {timeoutMs: 10000, hasPending: () => false});
    const b = waiters.wait('s2', {timeoutMs: 10000, hasPending: () => false});
    assert.equal(waiters.notify('s1'), 1);
    assert.deepEqual(await a, {timedOut: false});
    assert.equal(waiters.sizeOf('s2'), 1, 's2 必须还在等');
    waiters.cancel('s2');
    assert.deepEqual(await b, {timedOut: true, stopped: true});
});

test('同一 owner 多个 waiter 一起放行，cancel/clear 清干净', async () => {
    const {clock, waiters} = makeWaiters();
    const all = [
        waiters.wait('s1', {timeoutMs: 10000, hasPending: () => false}),
        waiters.wait('s1', {timeoutMs: 10000, hasPending: () => false}),
    ];
    assert.equal(waiters.sizeOf('s1'), 2);
    assert.equal(waiters.cancel('s1'), 2);
    for (const result of await Promise.all(all)) assert.equal(result.stopped, true);
    assert.equal(waiters.sizeOf('s1'), 0);

    const one = waiters.wait('s2', {timeoutMs: 10000, hasPending: () => false});
    assert.equal(waiters.clear(), 1);
    assert.deepEqual(await one, {timedOut: true, stopped: true});
    assert.equal(clock.pending(), 0, 'clear 之后不留定时器');
});

test('不限时（timeoutMs=0）也可被 notify 唤醒', async () => {
    const {clock, waiters} = makeWaiters();
    let has = false;
    const pending = waiters.wait('s1', {timeoutMs: 0, hasPending: () => has});
    clock.advance(60);
    has = true;
    waiters.notify('s1');
    assert.deepEqual(await pending, {timedOut: false});
    assert.equal(clock.pending(), 0);
});
