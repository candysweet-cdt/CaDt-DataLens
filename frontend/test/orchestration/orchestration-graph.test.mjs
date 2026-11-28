// orchestration-graph.test.mjs：执行顺序依赖图的纯布局（不碰 DOM）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildExecutionGraph, dependencyWaves} from '../../src/orchestration/orchestration-graph.js';

const plan = {
    batches: [
        {id: 'A', title: '迁移 A', dependsOn: []},
        {id: 'B', title: '迁移 B', dependsOn: []},
        {id: 'C', title: '前端 C', dependsOn: []},
        {id: 'D', title: '文档 D', dependsOn: ['A', 'B']},
        {id: 'E', title: '守卫 E', dependsOn: ['C']},
    ],
};

test('同波次节点共享列，依赖边与终审列按数据生成', () => {
    const layout = buildExecutionGraph(plan, {waves: [['A', 'B', 'C'], ['D', 'E']]}, {
        finalReview: true, finalReviewCount: 2, maxParallel: 3,
    });
    assert.equal(layout.waves.length, 2);
    assert.equal(layout.nodes.length, 5);
    assert.equal(layout.finalNodes.length, 2);
    assert.equal(layout.barrier.kind, 'barrier');

    const x = (id) => layout.nodes.find((n) => n.id === id).x;
    assert.equal(x('A'), x('B'));
    assert.equal(x('B'), x('C'));
    assert.equal(x('D'), x('E'));
    assert.ok(x('D') > x('A'), '下一波必须排在右侧');
    assert.equal(layout.finalNodes[0].x, layout.finalNodes[1].x);

    const pairs = layout.edges.map((e) => e.from.id + '>' + e.to.id);
    for (const pair of ['A>D', 'B>D', 'C>E', 'D>all-done', 'E>all-done', 'all-done>final-review-1', 'all-done>final-review-2']) {
        assert.ok(pairs.includes(pair), '缺少边 ' + pair + '；实际 ' + pairs.join(', '));
    }
});

test('dependencyWaves：按 dependsOn 分层，同层保持计划顺序且不混入审查批次', () => {
    const waves = dependencyWaves([
        {id: 'A', kind: 'work', dependsOn: []},
        {id: 'B', kind: 'work', dependsOn: []},
        {id: 'C', kind: 'work', dependsOn: ['A', 'B']},
        {id: 'R', kind: 'review', dependsOn: []},
        {id: 'D', kind: 'work', dependsOn: ['C']},
    ]);
    assert.deepEqual(waves, [['A', 'B'], ['C'], ['D']]);
});

test('无终审时没有汇合屏障与终审列；未出现在 waves 的批次兜底到最后一列', () => {
    const layout = buildExecutionGraph(plan, {waves: [['A', 'B', 'C']]}, {
        finalReview: false, maxParallel: 3,
    });
    assert.equal(layout.barrier, null);
    assert.equal(layout.finalNodes.length, 0);
    assert.equal(layout.waves.length, 2, 'D/E 未出现在 waves 时应兜底追加');
    assert.deepEqual(layout.waves[1], ['D', 'E']);
    assert.equal(layout.nodes.find((n) => n.id === 'D').x, layout.nodes.find((n) => n.id === 'E').x);
});