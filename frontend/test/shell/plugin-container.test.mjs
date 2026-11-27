// plugin-container 单测：服务提供 / 查找 / 替换 / 就绪等待 / 撤销（S4 平台原语）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createPluginContainer} from '../../src/shell/plugin-container.js';

test('provide + get + has + require', () => {
    const box = createPluginContainer();
    box.provide('plugin.a.llm', {name: 'a'}, {owner: 'a'});
    assert.equal(box.has('plugin.a.llm'), true);
    assert.equal(box.get('plugin.a.llm').name, 'a');
    assert.equal(box.require('plugin.a.llm').name, 'a');
    assert.equal(box.get('nope'), undefined);
});

test('require 缺失时抛错并列出已注册 key（拼写排查）', () => {
    const box = createPluginContainer();
    box.provide('plugin.a.llm', 1);
    assert.throws(() => box.require('plugin.a.lmm'), /缺少服务.*已提供.*plugin\.a\.llm/s);
});

test('同名重复 provide 抛错，replace:true 才替换，且旧 dispose 被调用', () => {
    const box = createPluginContainer();
    let disposed = 0;
    box.provide('core.llm', 'old', {dispose: () => { disposed += 1; }});
    assert.throws(() => box.provide('core.llm', 'new'), /服务已存在/);
    box.provide('core.llm', 'new', {replace: true});
    assert.equal(box.get('core.llm'), 'new');
    assert.equal(disposed, 1);
});

test('provide 返回的撤销函数只撤自己那一份（被替换后是空操作）', () => {
    const box = createPluginContainer();
    const off = box.provide('core.x', 1);
    off();
    assert.equal(box.has('core.x'), false);
    box.provide('core.y', 1);
    const offY = box.provide('core.z', 1);
    box.provide('core.z', 2, {replace: true});
    offY();
    assert.equal(box.get('core.z'), 2);
});

test('disposeOwner 撤销该插件全部服务并执行 dispose', () => {
    const box = createPluginContainer();
    const done = [];
    box.provide('plugin.a.one', 1, {owner: 'a', dispose: () => done.push('one')});
    box.provide('plugin.a.two', 2, {owner: 'a'});
    box.provide('plugin.b.one', 3, {owner: 'b'});
    assert.equal(box.disposeOwner('a'), 2);
    assert.deepEqual(done, ['one']);
    assert.equal(box.has('plugin.b.one'), true);
    assert.equal(box.size, 1);
});

test('whenReady：后提供的服务能唤醒等待者', async () => {
    const box = createPluginContainer();
    const pending = box.whenReady('plugin.late.svc');
    setTimeout(() => box.provide('plugin.late.svc', 'ready', {owner: 'late'}), 10);
    assert.equal(await pending, 'ready');
});

test('whenReady：已就绪立即 resolve；超时 reject', async () => {
    const box = createPluginContainer();
    box.provide('core.now', 'v');
    assert.equal(await box.whenReady('core.now'), 'v');
    await assert.rejects(() => box.whenReady('core.never', {timeoutMs: 20}), /等待服务超时/);
});

test('inject：按名聚合并等待全部就绪', async () => {
    const box = createPluginContainer();
    box.provide('plugin.a.llm', {id: 'a'});
    const waiting = box.inject(['plugin.a.llm', 'plugin.b.store']);
    setTimeout(() => box.provide('plugin.b.store', {id: 'b'}, {owner: 'b'}), 10);
    const deps = await waiting;
    assert.equal(deps['plugin.a.llm'].id, 'a');
    assert.equal(deps['plugin.b.store'].id, 'b');
});

test('dispose：拒绝等待中的 inject，不让 Promise 永远悬着', async () => {
    const box = createPluginContainer();
    const pending = box.whenReady('core.gone', {timeoutMs: 5000});
    box.dispose();
    await assert.rejects(() => pending, /容器已释放/);
    assert.equal(box.disposed, true);
});

test('list：供诊断展示，不含具体值', () => {
    const box = createPluginContainer();
    box.provide('core.a', {secret: 'x'}, {owner: 'core'});
    const items = box.list();
    assert.equal(items.length, 1);
    assert.equal(items[0].name, 'core.a');
    assert.equal(items[0].owner, 'core');
    assert.equal('value' in items[0], false);
});

test('group 隔离：同名服务在不同 group 各一份，查找先同组再回落全局', () => {
    const box = createPluginContainer();
    box.provide('core.llm', {id: 'global'}, {owner: 'core'});
    box.provide('core.llm', {id: 'g1'}, {owner: 'p1', group: 'realm-a'});
    // 全局视角看到全局服务
    assert.equal(box.get('core.llm').id, 'global');
    // 带 group 查找命中本组
    assert.equal(box.get('core.llm', {group: 'realm-a'}).id, 'g1');
    // 本组没有该服务时回落到全局
    assert.equal(box.get('core.llm', {group: 'realm-b'}).id, 'global');
    assert.equal(box.has('core.llm', {group: 'realm-a'}), true);
    assert.equal(box.require('core.llm', {group: 'realm-a'}).id, 'g1');
    // 同 group 重复 provide 仍抛错；不同 group 同名不冲突
    assert.throws(() => box.provide('core.llm', 1, {owner: 'p2', group: 'realm-a'}), /服务已存在/);
    box.provide('core.llm', {id: 'g2'}, {owner: 'p2', group: 'realm-b'});
    assert.equal(box.get('core.llm', {group: 'realm-b'}).id, 'g2');
});

test('whenReady / inject 尊重 group', async () => {
    const box = createPluginContainer();
    const waiting = box.whenReady('plugin.svc', {group: 'realm-a', timeoutMs: 1000});
    setTimeout(() => box.provide('plugin.svc', 'in-a', {owner: 'p', group: 'realm-a'}), 10);
    assert.equal(await waiting, 'in-a');
    const deps = await box.inject(['plugin.svc'], {group: 'realm-a'});
    assert.equal(deps['plugin.svc'], 'in-a');
});

test('effect：立即执行，撤销函数与 disposeOwner 都跑清理，且幂等', () => {
    const box = createPluginContainer();
    const log = [];
    const off = box.effect(() => { log.push('setup'); return () => log.push('cleanup'); }, {owner: 'p1'});
    assert.deepEqual(log, ['setup']);
    off(); off();
    assert.deepEqual(log, ['setup', 'cleanup'], '撤销函数必须幂等');
    box.effect(() => { log.push('setup2'); return () => log.push('cleanup2'); }, {owner: 'p2'});
    assert.equal(box.disposeOwner('p2'), 1);
    assert.deepEqual(log, ['setup', 'cleanup', 'setup2', 'cleanup2']);
});

test('effect 抛错被吞、不打断容器；dispose 清理全部 effect', () => {
    const logs = [];
    const box = createPluginContainer({logf: (m) => logs.push(m)});
    let cleaned = 0;
    box.effect(() => { throw new Error('boom'); }, {owner: 'p1'});
    box.effect(() => () => { cleaned += 1; }, {owner: 'p2'});
    assert.ok(logs.some((m) => /boom/.test(m)));
    box.dispose();
    assert.equal(cleaned, 1);
    assert.equal(box.disposed, true);
});
