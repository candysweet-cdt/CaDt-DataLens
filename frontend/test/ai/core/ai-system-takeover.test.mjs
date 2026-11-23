// ai-system-takeover 单测：定时结算、默认动作、幂等、按会话取消与优先级选择。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSystemTakeoverHost} from '../../../src/ai/core/ai-system-takeover.js';

function fakeClock(start = 1000) {
    let now = start;
    let seq = 0;
    const timers = new Map();
    return {
        now: () => now,
        setTimer(fn, ms) {
            const id = ++seq;
            timers.set(id, {fn, at: now + ms});
            return id;
        },
        clearTimer(id) {
            timers.delete(id);
        },
        advance(ms) {
            const target = now + ms;
            for (;;) {
                let nextId = 0;
                let next = null;
                for (const [id, timer] of timers) {
                    if (timer.at <= target && (!next || timer.at < next.at)) {
                        nextId = id;
                        next = timer;
                    }
                }
                if (!next) break;
                timers.delete(nextId);
                now = next.at;
                next.fn();
            }
            now = target;
        },
        timerCount: () => timers.size,
    };
}

function actionSpec(overrides) {
    return {
        sessionId: 's1',
        priority: 0,
        title: '检测到重复',
        actions: [
            {value: 'stop', label: '停止', default: true},
            {value: 'continue', label: '继续'},
        ],
        timeoutSec: 30,
        timeoutValue: 'stop',
        ...overrides,
    };
}

test('倒计时到点按 timeoutValue 结算，剩余秒数随假时钟递减', async () => {
    const clock = fakeClock();
    const host = createSystemTakeoverHost({
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
    });
    const {key, done} = host.request(actionSpec());
    const entry = host.pick('s1');
    assert.equal(entry.key, key);
    assert.equal(host.remainingSec(entry), 30);
    clock.advance(10000);
    assert.equal(host.remainingSec(host.pick('s1')), 20);
    clock.advance(20000);
    assert.deepEqual(await done, {value: 'stop', source: 'timeout', reason: ''});
    assert.equal(host.pick('s1'), null);
    assert.equal(host.size(), 0);
    assert.equal(host.settle(key, 'continue'), false, '超时后再次结算必须幂等');
});

test('用户结算只生效一次，后续取消 / 结算都不再改结果', async () => {
    const clock = fakeClock();
    const host = createSystemTakeoverHost({
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
    });
    const {key, done} = host.request(actionSpec());
    assert.equal(host.settle(key, 'continue', 'user'), true);
    assert.equal(host.settle(key, 'stop', 'user'), false);
    assert.equal(host.cancel(key), false);
    assert.deepEqual(await done, {value: 'continue', source: 'user', reason: ''});
    clock.advance(60000);
    assert.equal(host.size(), 0);
});

test('未给 timeoutValue 时回落到 default 动作', async () => {
    const clock = fakeClock();
    const host = createSystemTakeoverHost({
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
    });
    const spec = actionSpec();
    delete spec.timeoutValue;
    const {done} = host.request(spec);
    clock.advance(30000);
    assert.equal((await done).value, 'stop');
});

test('cancelBySession 只取消目标会话，并返回取消条数', async () => {
    const clock = fakeClock();
    const host = createSystemTakeoverHost({
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
    });
    const a = host.request(actionSpec({sessionId: 'a'}));
    const b = host.request(actionSpec({sessionId: 'b'}));
    assert.equal(host.cancelBySession('a', '用户停止'), 1);
    assert.deepEqual(await a.done, {value: null, source: 'cancelled', reason: '用户停止'});
    assert.equal(host.pick('a'), null);
    assert.equal(host.pick('b').key, b.key);
    clock.advance(30000);
    assert.equal((await b.done).source, 'timeout');
});

test('pick 按优先级取最高，同优先级先来后到', () => {
    const clock = fakeClock();
    const host = createSystemTakeoverHost({
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
    });
    const first = host.request(actionSpec({sessionId: 's', priority: 10}));
    const second = host.request(actionSpec({sessionId: 's', priority: 50}));
    const third = host.request(actionSpec({sessionId: 's', priority: 10, key: 'third'}));
    assert.equal(host.pick('s').key, second.key);
    host.settle(second.key, 'stop');
    assert.equal(host.pick('s').key, first.key);
    assert.equal(host.pendingOf('s').map((entry) => entry.key).join(','), first.key + ',' + third.key);
    assert.equal(host.pick('other'), null);
});

test('onChange 覆盖 request / settle；timeoutSec=0 不挂定时器', () => {
    const clock = fakeClock();
    const events = [];
    const host = createSystemTakeoverHost({
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        onChange: (kind, entry) => events.push(kind + ':' + entry.key),
    });
    const {key} = host.request(actionSpec({key: 'k1', timeoutSec: 0}));
    assert.equal(clock.timerCount(), 0);
    assert.equal(host.remainingSec(host.get(key)), 0);
    host.cancel(key, '测试');
    assert.deepEqual(events, ['request:k1', 'settle:k1']);
});

test('非法 spec：无动作或 timeoutValue 不在动作里直接抛错', () => {
    const host = createSystemTakeoverHost({now: () => 0, setTimer: () => 1, clearTimer: () => {}});
    assert.throws(() => host.request({sessionId: 's', actions: []}), /至少需要一个动作/);
    assert.throws(() => host.request(actionSpec({timeoutValue: 'missing'})), /timeoutValue/);
});
