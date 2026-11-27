// hook-bus 单测：五模式语义 + 可逆注册（S4 平台原语）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHookBus} from '../../src/core/hook-bus.js';

test('emit：同步串行、按优先级降序、忽略返回值', () => {
    const bus = createHookBus();
    const seen = [];
    bus.on('demo/step', () => seen.push('low'), {priority: 1});
    bus.on('demo/step', () => seen.push('high'), {priority: 9});
    const called = bus.emit('demo/step', {x: 1});
    assert.equal(called, 2);
    assert.deepEqual(seen, ['high', 'low']);
});

test('emit：单个监听器抛错不影响其余监听器，错误进日志', () => {
    const logs = [];
    const bus = createHookBus({logf: (m) => logs.push(m)});
    let reached = false;
    bus.on('demo/err', () => { throw new Error('boom'); }, {priority: 5});
    bus.on('demo/err', () => { reached = true; }, {priority: 1});
    assert.equal(bus.emit('demo/err'), 2);
    assert.equal(reached, true);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /boom/);
});

test('waterfall：值依次穿过，返回 undefined 表示不接管', () => {
    const bus = createHookBus();
    bus.on('demo/wf', (value) => value + 1, {priority: 2});
    bus.on('demo/wf', () => undefined, {priority: 1});
    bus.on('demo/wf', (value) => value * 10, {priority: 0});
    assert.equal(bus.waterfall('demo/wf', 1), 20);
});

test('waterfall：监听器抛错时保留上一步的值', () => {
    const bus = createHookBus({logf: () => {}});
    bus.on('demo/wf2', (value) => value + 1, {priority: 2});
    bus.on('demo/wf2', () => { throw new Error('x'); }, {priority: 1});
    assert.equal(bus.waterfall('demo/wf2', 0), 1);
});

test('parallel：全部并发执行，失败项为 undefined 且不影响其他', async () => {
    const bus = createHookBus({logf: () => {}});
    const order = [];
    bus.on('demo/par', async () => { order.push('a-start'); await new Promise((r) => setTimeout(r, 10)); order.push('a-end'); return 1; });
    bus.on('demo/par', async () => { order.push('b'); return 2; });
    bus.on('demo/par', async () => { throw new Error('bad'); });
    const out = await bus.parallel('demo/par');
    assert.deepEqual(out, [1, 2, undefined]);
    assert.deepEqual(order, ['a-start', 'b', 'a-end']);
});

test('serial：顺序执行，任一抛错即中断并向上抛', async () => {
    const bus = createHookBus();
    const order = [];
    bus.on('demo/ser', async () => { order.push(1); }, {priority: 2});
    bus.on('demo/ser', async () => { order.push(2); throw new Error('stop'); }, {priority: 1});
    bus.on('demo/ser', async () => { order.push(3); }, {priority: 0});
    await assert.rejects(() => bus.serial('demo/ser'), /stop/);
    assert.deepEqual(order, [1, 2]);
});

test('bail：首个非 undefined 返回值终止链', () => {
    const bus = createHookBus();
    const order = [];
    bus.on('demo/bail', () => { order.push(1); return undefined; }, {priority: 3});
    bus.on('demo/bail', () => { order.push(2); return 'hit'; }, {priority: 2});
    bus.on('demo/bail', () => { order.push(3); return 'later'; }, {priority: 1});
    assert.equal(bus.bail('demo/bail'), 'hit');
    assert.deepEqual(order, [1, 2]);
});

test('once：只执行一次', () => {
    const bus = createHookBus();
    let count = 0;
    bus.on('demo/once', () => { count += 1; }, {once: true});
    bus.emit('demo/once');
    bus.emit('demo/once');
    assert.equal(count, 1);
    assert.equal(bus.listenerCount('demo/once'), 0);
});

test('on 返回的解绑函数幂等，offOwner 按插件整体撤销', () => {
    const bus = createHookBus();
    const off = bus.on('demo/a', () => {}, {owner: 'p1'});
    bus.on('demo/a', () => {}, {owner: 'p1'});
    bus.on('demo/b', () => {}, {owner: 'p2'});
    off();
    off();
    assert.equal(bus.listenerCount('demo/a'), 1);
    assert.equal(bus.offOwner('p1'), 1);
    assert.equal(bus.listenerCount('demo/a'), 0);
    assert.equal(bus.listenerCount('demo/b'), 1);
});

test('事件名校验：空名与非法字符被拒绝', () => {
    const bus = createHookBus();
    assert.throws(() => bus.on('', () => {}), /不能为空/);
    assert.throws(() => bus.on('bad name!', () => {}), /只允许/);
    assert.throws(() => bus.on('demo/x', null), /必须是函数/);
});

test('dispose 后不再接受注册', () => {
    const bus = createHookBus();
    bus.dispose();
    assert.equal(bus.disposed, true);
    assert.throws(() => bus.on('demo/x', () => {}), /已释放/);
});
