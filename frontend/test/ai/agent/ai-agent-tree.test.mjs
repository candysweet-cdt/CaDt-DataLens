// ai-agent-tree.test.mjs：智能体团队弹层嵌套树纯函数（父子归属 / 排序 / 折叠 / 环保护）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {buildAgentTree, flattenAgentTree} from '../../../src/ai/agent/ai-agent-tree.js';

const agent = (key, extra = {}) => ({
    key,
    toolCallId: key,
    subId: 'sub-' + key,
    name: key,
    state: 'running',
    startedAt: 0,
    ...extra,
});

const levelKeys = (roots) => flattenAgentTree(roots, () => false).map((row) => row.agent.key);
const rowsOf = (roots, collapsed = new Set()) => flattenAgentTree(roots, (key) => collapsed.has(key));

test('buildAgentTree：无父子关系时全部为根，按运行中优先 / 新派在前排序', () => {
    const agents = [
        agent('a', {state: 'done', startedAt: 100}),
        agent('b', {state: 'running', startedAt: 10}),
        agent('c', {state: 'running', startedAt: 50}),
    ];
    const roots = buildAgentTree(agents);
    assert.deepEqual(roots.map((node) => node.agent.key), ['c', 'b', 'a']);
    assert.equal(roots[0].children.length, 0);
    assert.equal(roots[0].descendantCount, 0);
});

test('buildAgentTree：parentSessionId 命中 subId 时挂到父节点下', () => {
    const parent = agent('parent');
    const orphanParent = agent('top');
    const child1 = agent('c1', {parentSessionId: 'sub-parent'});
    const child2 = agent('c2', {parentSessionId: 'sub-parent'});
    const grandchild = agent('g1', {parentSessionId: 'sub-c1'});
    const roots = buildAgentTree([child1, grandchild, parent, child2, orphanParent]);
    assert.deepEqual(levelKeys(roots), ['parent', 'c1', 'g1', 'c2', 'top']);
    assert.equal(roots[1].descendantCount, 0);
    assert.equal(roots[0].descendantCount, 3);
    const c1 = roots[0].children.find((node) => node.agent.key === 'c1');
    assert.equal(c1.children.length, 1);
});

test('buildAgentTree：父不在列表时回落为根，孤儿保留深度信息', () => {
    const orphan = agent('deep', {parentSessionId: 'sub-gone', depth: 2});
    const roots = buildAgentTree([orphan]);
    assert.equal(roots.length, 1);
    const rows = rowsOf(roots);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].level, 0);
    assert.equal(rows[0].agent.depth, 2);
});

test('buildAgentTree：父子成环时不死循环，环内节点回落为根', () => {
    const a = agent('a', {parentSessionId: 'sub-b'});
    const b = agent('b', {parentSessionId: 'sub-a'});
    const roots = buildAgentTree([a, b]);
    // A 被提升为根、B 挂回 A：两条都还在，且行序有限
    assert.equal(levelKeys(roots).length, 2);
    assert.equal(roots.length, 1);
});

test('buildAgentTree：自己指向自己时视为根', () => {
    const a = agent('a', {parentSessionId: 'sub-a'});
    const roots = buildAgentTree([a]);
    assert.equal(roots.length, 1);
    assert.equal(roots[0].children.length, 0);
});

test('buildAgentTree：同层子节点按运行中优先 / 新派在前排序', () => {
    const parent = agent('p');
    const oldDone = agent('old', {parentSessionId: 'sub-p', state: 'done', startedAt: 200});
    const newRunning = agent('new', {parentSessionId: 'sub-p', state: 'running', startedAt: 10});
    const midRunning = agent('mid', {parentSessionId: 'sub-p', state: 'running', startedAt: 99});
    const roots = buildAgentTree([oldDone, parent, newRunning, midRunning]);
    assert.deepEqual(levelKeys(roots), ['p', 'mid', 'new', 'old']);
});

test('flattenAgentTree：折叠父节点后后代不出现，计数为全部后代数', () => {
    const parent = agent('p');
    const child = agent('c', {parentSessionId: 'sub-p'});
    const grandchild = agent('g', {parentSessionId: 'sub-c'});
    const sibling = agent('s');
    const roots = buildAgentTree([parent, child, grandchild, sibling]);
    const rows = rowsOf(roots, new Set(['p']));
    assert.deepEqual(rows.map((row) => row.agent.key), ['p', 's']);
    const p = rows.find((row) => row.agent.key === 'p');
    assert.equal(p.collapsed, true);
    assert.equal(p.childCount, 1);
    assert.equal(p.descendantCount, 2);
    assert.equal(p.level, 0);
});

test('flattenAgentTree：叶子节点不会出现折叠态', () => {
    const roots = buildAgentTree([agent('solo')]);
    const rows = rowsOf(roots, new Set(['solo']));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].collapsed, false);
});

test('flattenAgentTree：空输入与脏输入安全', () => {
    assert.deepEqual(buildAgentTree([]), []);
    assert.deepEqual(buildAgentTree(null), []);
    assert.deepEqual(flattenAgentTree(buildAgentTree([null, undefined])), []);
    assert.deepEqual(flattenAgentTree(null, () => true), []);
});

test('flattenAgentTree：无 key 的条目也能稳定返回行', () => {
    const roots = buildAgentTree([{name: '无 key', state: 'running'}]);
    const rows = rowsOf(roots);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agent.name, '无 key');
});

test('flattenAgentTree：输出 key / guides / isLast 供树形连线使用', () => {
    // 主代理(root) 下两个一级代理，第一个再挂一个孙代理
    const main = agent('main', {subId: 's1'});
    const a = agent('a', {parentSessionId: 's1'});
    const a1 = agent('a1', {parentSessionId: 'sub-a'});
    const b = agent('b', {parentSessionId: 's1'});
    const roots = buildAgentTree([main, a, a1, b]);
    const rows = flattenAgentTree(roots, () => false);
    const of = (key) => rows.find((row) => row.key === key);

    assert.equal(of('main').level, 0);
    assert.deepEqual(of('main').guides, []);
    assert.equal(of('main').isLast, true);          // 唯一根

    // a 不是父的最后一个孩子 → guides[0]=true（其后代左侧竖线要贯穿）
    assert.equal(of('a').level, 1);
    assert.deepEqual(of('a').guides, []);
    assert.equal(of('a').isLast, false);

    // 孙代理 a1：guides[0] 继承「a 还有后续兄弟 b」= true，自身是 a 的独子 → isLast=true
    assert.equal(of('a1').level, 2);
    assert.deepEqual(of('a1').guides, [true]);
    assert.equal(of('a1').isLast, true);

    assert.equal(of('b').level, 1);
    assert.deepEqual(of('b').guides, []);
    assert.equal(of('b').isLast, true);            // 最后一个一级代理
});

test('flattenAgentTree：折叠父节点后其后代的 guides 不残留', () => {
    const main = agent('main', {subId: 's1'});
    const a = agent('a', {parentSessionId: 's1'});
    const a1 = agent('a1', {parentSessionId: 'sub-a'});
    const b = agent('b', {parentSessionId: 's1'});
    const roots = buildAgentTree([main, a, a1, b]);
    const rows = flattenAgentTree(roots, (key) => key === 'main');
    // 主代理折叠后只剩它一行，b 也是主代理的后代，一并隐藏
    assert.deepEqual(rows.map((row) => row.key), ['main']);
    assert.equal(rows[0].collapsed, true);
});
