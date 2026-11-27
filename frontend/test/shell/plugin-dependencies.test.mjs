// plugin-dependencies 单测：依赖排序 / 缺依赖 / 循环 / 顺序稳定（S7）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {orderByDependencies} from '../../src/shell/plugin-dependencies.js';

test('无依赖时保持原顺序', () => {
    const errors = [];
    const out = orderByDependencies([{id: 'a'}, {id: 'b'}, {id: 'c'}], errors);
    assert.deepEqual(out.map((s) => s.id), ['a', 'b', 'c']);
    assert.deepEqual(errors, []);
});

test('被依赖者一定排在前面（即使原顺序相反）', () => {
    const errors = [];
    const out = orderByDependencies([
        {id: 'consumer', dependencies: ['provider']},
        {id: 'provider'},
    ], errors);
    assert.deepEqual(out.map((s) => s.id), ['provider', 'consumer']);
    assert.deepEqual(errors, []);
});

test('三层链按拓扑排，同层维持原序', () => {
    const errors = [];
    const out = orderByDependencies([
        {id: 'top', dependencies: ['mid']},
        {id: 'other'},
        {id: 'mid', dependencies: ['base']},
        {id: 'base'},
    ], errors);
    assert.deepEqual(out.map((s) => s.id), ['other', 'base', 'mid', 'top']);
    assert.deepEqual(errors, []);
});

test('依赖解开后立刻插回原位置，不打乱无依赖插件之间的顺序', () => {
    const errors = [];
    // a 就绪后 b 应当紧跟着出现，而不是被排到 c 之后（FIFO 实现会给出 [a, c, b]）
    const out = orderByDependencies([
        {id: 'a'},
        {id: 'b', dependencies: ['a']},
        {id: 'c'},
    ], errors);
    assert.deepEqual(out.map((s) => s.id), ['a', 'b', 'c']);
    assert.deepEqual(errors, []);
});

test('缺依赖：跳过该插件并报错，其余照常', () => {
    const errors = [];
    const out = orderByDependencies([
        {id: 'a'},
        {id: 'b', name: '乙', dependencies: ['ghost']},
        {id: 'c'},
    ], errors);
    assert.deepEqual(out.map((s) => s.id), ['a', 'c']);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /缺少依赖插件 ghost/);
    assert.match(errors[0], /乙/);
});

test('依赖被跳过时下游一并跳过（不半启动）', () => {
    const errors = [];
    const out = orderByDependencies([
        {id: 'missing-parent-dependant', dependencies: ['ghost']},
        {id: 'child', dependencies: ['missing-parent-dependant']},
        {id: 'ok'},
    ], errors);
    assert.deepEqual(out.map((s) => s.id), ['ok']);
    assert.equal(errors.length, 2);
});

test('循环依赖：环上全部跳过并报一条错误', () => {
    const errors = [];
    const out = orderByDependencies([
        {id: 'a', dependencies: ['b']},
        {id: 'b', dependencies: ['a']},
        {id: 'c'},
    ], errors);
    assert.deepEqual(out.map((s) => s.id), ['c']);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /循环依赖/);
    assert.match(errors[0], /a、b/);
});

test('插件 id 重复：保留首个并报错', () => {
    const errors = [];
    const out = orderByDependencies([{id: 'a', name: '甲'}, {id: 'a', name: '甲2'}], errors);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, '甲');
    assert.match(errors[0], /id 重复/);
});

test('自依赖视为循环', () => {
    const errors = [];
    const out = orderByDependencies([{id: 'self', dependencies: ['self']}], errors);
    assert.deepEqual(out, []);
    assert.match(errors[0], /循环依赖/);
});

test('非数组输入不抛错', () => {
    assert.deepEqual(orderByDependencies(null), []);
    assert.deepEqual(orderByDependencies([null, {id: ''}]), []);
});
