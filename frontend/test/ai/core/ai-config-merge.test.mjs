// ai-config-merge.test.mjs —— ai-config.json 三方合并（比较-交换写盘的冲突消解）纯函数测试。
//
// 背景：多窗口共享同一份配置、写盘是整份覆盖。后端 AIConfigWriteIfUnchanged 在磁盘内容
// 已变时回传最新明文，前端用 mergeAIConfig 把两边的改动各自保留。这里逐条钉住规则：
//   1. 只有一方改过 → 用改过的那方
//   2. 两边都改过 → 本窗口优先，并报一条冲突
//   3. activeSessionByWorkspace：本窗口工作区键永远用 mine（含清空），其余键按磁盘
//   4. 带 id 的数组按元素走 1/2，支持增 / 改 / 删（删掉的不会被磁盘复活）
import test from 'node:test';
import assert from 'node:assert/strict';

import {mergeAIConfig} from '../../../src/ai/core/ai-config-merge.js';

test('只有本窗口改过：用本窗口的值', () => {
    const base = {autoTitle: true, retryMax: 5};
    const mine = {autoTitle: false, retryMax: 5};
    const theirs = {autoTitle: true, retryMax: 5};
    const {config, conflicts} = mergeAIConfig(base, mine, theirs);
    assert.equal(config.autoTitle, false);
    assert.deepEqual(conflicts, []);
});

test('只有磁盘改过：用磁盘的值（本窗口没动就不该回滚别人的修改）', () => {
    const base = {notifySound: true};
    const mine = {notifySound: true};
    const theirs = {notifySound: false};
    const {config, conflicts} = mergeAIConfig(base, mine, theirs);
    assert.equal(config.notifySound, false);
    assert.deepEqual(conflicts, []);
});

test('两边改了同一个标量：本窗口优先并报冲突', () => {
    const base = {askTimeout: 300};
    const mine = {askTimeout: 120};
    const theirs = {askTimeout: 600};
    const {config, conflicts} = mergeAIConfig(base, mine, theirs);
    assert.equal(config.askTimeout, 120, '不能丢掉用户刚在打开的窗口里做的修改');
    assert.deepEqual(conflicts, ['askTimeout']);
});

test('键序不同但内容相同不算改过（稳定比较）', () => {
    const base = {persona: {name: 'a', style: 'b'}, retryMax: 5};
    const mine = {persona: {style: 'b', name: 'a'}, retryMax: 5};
    const theirs = {persona: {name: 'a', style: 'b'}, retryMax: 6};
    const {config, conflicts} = mergeAIConfig(base, mine, theirs);
    assert.equal(config.retryMax, 6, '等同值不应视为本窗口改过');
    assert.deepEqual(conflicts, []);
});

test('activeSessionByWorkspace：本窗口键用 mine（含清空），其余键用磁盘最新', () => {
    const base = {activeSessionByWorkspace: {wsA: 's1', wsB: 's2', wsC: 's3'}};
    // 本窗口（wsA）切到 s9；另一窗口把 wsB 改成 s8、并给 wsC 清了条目
    const mine = {activeSessionByWorkspace: {wsA: 's9', wsB: 's2', wsC: 's3'}};
    const theirs = {activeSessionByWorkspace: {wsA: 's1', wsB: 's8', wsC: ''}};
    const {config} = mergeAIConfig(base, mine, theirs, {ownWorkspaceKey: 'wsA'});
    assert.equal(config.activeSessionByWorkspace.wsA, 's9', '本窗口工作区条目只有本窗口有权写');
    assert.equal(config.activeSessionByWorkspace.wsB, 's8', '别人工作区的改动要保留');
    assert.equal(config.activeSessionByWorkspace.wsC, undefined, '别人清空的条目不能被复活');
});

test('activeSessionByWorkspace：本窗口清空自己的条目时也不会被磁盘版本复活', () => {
    const base = {activeSessionByWorkspace: {wsA: 's1'}};
    const mine = {activeSessionByWorkspace: {}};
    const theirs = {activeSessionByWorkspace: {wsA: 's1'}};
    const {config} = mergeAIConfig(base, mine, theirs, {ownWorkspaceKey: 'wsA'});
    assert.equal(config.activeSessionByWorkspace.wsA, undefined);
});

test('profiles 按 id 合并：本窗口新增 / 修改 / 删除都不丢，磁盘新增也保留', () => {
    const base = {profiles: [{id: 'p1', name: 'A'}, {id: 'p2', name: 'B'}]};
    const mine = {profiles: [{id: 'p1', name: 'A2'}, {id: 'p3', name: 'C'}]}; // 改 p1、删 p2、增 p3
    const theirs = {profiles: [{id: 'p1', name: 'A'}, {id: 'p2', name: 'B'}, {id: 'p4', name: 'D'}]};
    const {config, conflicts} = mergeAIConfig(base, mine, theirs);
    const byId = new Map(config.profiles.map((p) => [p.id, p.name]));
    assert.equal(byId.get('p1'), 'A2', '本窗口的修改保留');
    assert.equal(byId.has('p2'), false, '本窗口删掉的不能被磁盘复活');
    assert.equal(byId.get('p3'), 'C', '本窗口新增的保留');
    assert.equal(byId.get('p4'), 'D', '磁盘新增的保留');
    assert.deepEqual(conflicts, []);
});

test('profiles 两边改同一条：本窗口优先并报冲突（带 key:id）', () => {
    const base = {profiles: [{id: 'p1', name: 'A'}]};
    const mine = {profiles: [{id: 'p1', name: 'mine'}]};
    const theirs = {profiles: [{id: 'p1', name: 'theirs'}]};
    const {config, conflicts} = mergeAIConfig(base, mine, theirs);
    assert.equal(config.profiles[0].name, 'mine');
    assert.deepEqual(conflicts, ['profiles:p1']);
});

test('base 缺失（首读失败 / 老版本）时不至于把磁盘配置清空', () => {
    const mine = {retryMax: 5, activeSessionByWorkspace: {wsA: 's1'}};
    const theirs = {retryMax: 7, activeSessionByWorkspace: {wsA: 'old', wsB: 's2'}};
    const {config} = mergeAIConfig(null, mine, theirs, {ownWorkspaceKey: 'wsA'});
    assert.equal(config.retryMax, 5, '本窗口值优先');
    assert.equal(config.activeSessionByWorkspace.wsB, 's2', '磁盘上别的窗口条目仍保留');
});

test('单侧新增整个键：按「改过的那方」取值', () => {
    const base = {};
    const mine = {};
    const theirs = {defaultScope: 'auto'};
    assert.equal(mergeAIConfig(base, mine, theirs).config.defaultScope, 'auto');
    const mine2 = {defaultScope: 'full'};
    assert.equal(mergeAIConfig(base, mine2, theirs).config.defaultScope, 'full');
});
