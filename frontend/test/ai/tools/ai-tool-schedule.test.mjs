// ai-tool-schedule.test.mjs：一轮内工具调用的并行批次划分。
// 锁住两件事：只有只读工具能并发（写/命令/未知一律串行）、批次内顺序与原调用顺序一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    groupToolCalls,
    isParallelToolCall,
    PARALLEL_MAX_BATCH,
    PARALLEL_READ_TOOLS,
} from '../../../src/ai/tools/ai-tool-schedule.js';

const call = (name, path) => ({id: name + '-' + (path || ''), name, arguments: JSON.stringify(path ? {path} : {})});

test('isParallelToolCall：只读工具可并发，写/命令/MCP 一律串行', () => {
    for (const name of PARALLEL_READ_TOOLS) assert.equal(isParallelToolCall(name), true, name);
    for (const name of ['write_file', 'edit_file', 'run_command', 'background_command', 'spawn_agent',
        'mcp__aoci__aoci_update_entry', 'web_fetch', '', null]) {
        assert.equal(isParallelToolCall(name), false, String(name));
    }
});

test('groupToolCalls：相邻只读合成一批，写操作打断批次', () => {
    const calls = [call('read_file', 'a'), call('list_dir', 'b'), call('write_file', 'c'), call('read_file', 'd')];
    const groups = groupToolCalls(calls);
    assert.equal(groups.length, 3);
    assert.deepEqual(groups[0].map((c) => c.name), ['read_file', 'list_dir']);
    assert.deepEqual(groups[1].map((c) => c.name), ['write_file']);
    assert.deepEqual(groups[2].map((c) => c.name), ['read_file']);
});

test('groupToolCalls：并发上限生效，超出的另起一批', () => {
    const calls = Array.from({length: 6}, (_, i) => call('read_file', 'f' + i));
    const groups = groupToolCalls(calls);
    assert.equal(groups[0].length, PARALLEL_MAX_BATCH);
    assert.equal(groups.length, 2);
    assert.equal(groups[1].length, 6 - PARALLEL_MAX_BATCH);
    // 顺序不能乱：展平后应与输入完全一致
    assert.deepEqual(groups.flat().map((c) => c.id), calls.map((c) => c.id));
});

test('groupToolCalls：eligible 谓词决定资格（工作区外读退回串行）', () => {
    const calls = [call('read_file', 'in1'), call('read_file', 'out'), call('read_file', 'in2')];
    const eligible = (c) => isParallelToolCall(c.name) && !c.arguments.includes('out');
    const groups = groupToolCalls(calls, eligible);
    assert.equal(groups.length, 3, '中间那个不合格，两侧不能跨过它合并');
    assert.deepEqual(groups.map((g) => g.length), [1, 1, 1]);
});

test('groupToolCalls：边界输入不炸', () => {
    assert.deepEqual(groupToolCalls([]), []);
    assert.deepEqual(groupToolCalls(null), []);
    assert.deepEqual(groupToolCalls([null, undefined]), []);
    // maxBatch 给 0 / 非法值退回默认上限（只有 3 个调用，全部进同一批）
    const calls = Array.from({length: 3}, (_, i) => call('read_file', 'x' + i));
    assert.equal(groupToolCalls(calls, null, 0).length, 1);
    assert.equal(groupToolCalls(calls, null, 0)[0].length, 3);
});
