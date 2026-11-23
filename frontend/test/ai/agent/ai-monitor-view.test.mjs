// ai-monitor-view：会话监控窗的纯函数测试（流式尾随状态机 + 行组装）。
// 规则：别的窗口的会话事件一律不认领；流式增量就地入账，回合边界（done/error）
// 返回 reload 让控制器从磁盘重放拿权威数据；重放行与活增量合并成渲染行。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createMonitorStreamState,
    monitorEventMatches,
    applyMonitorEvent,
    normalizeReplayRow,
    buildMonitorRows,
    formatMonitorStatus,
} from '../../../src/ai/agent/ai-monitor-view.js';

test('monitorEventMatches：只认领被监控会话的流式事件', () => {
    const state = createMonitorStreamState('s1');
    assert.equal(monitorEventMatches(state, 'ai-chunk', {sessionId: 's1', delta: 'x'}), true);
    assert.equal(monitorEventMatches(state, 'ai-chunk', {sessionId: 's2', delta: 'x'}), false);
    assert.equal(monitorEventMatches(state, 'ai-chunk', null), false);
    // 未登记的流式事件名不认领
    assert.equal(monitorEventMatches(state, 'term-out', {sessionId: 's1'}), false);
});

test('applyMonitorEvent：增量入账与回合边界', () => {
    const state = createMonitorStreamState('s1');
    assert.equal(applyMonitorEvent(state, 'ai-chunk', {sessionId: 's1', delta: '你好'}), 'append');
    assert.equal(applyMonitorEvent(state, 'ai-chunk', {sessionId: 's1', delta: '，世界'}), 'append');
    assert.equal(applyMonitorEvent(state, 'ai-think', {sessionId: 's1', delta: '思考'}), 'append');
    assert.equal(applyMonitorEvent(state, 'ai-toolcall', {sessionId: 's1', index: 0, name: 'read_file', argsDelta: '{"p"}'}), 'append');
    assert.equal(state.content, '你好，世界');
    assert.equal(state.thinking, '思考');
    assert.equal(state.tools.length, 1);
    assert.equal(state.tools[0].name, 'read_file');
    assert.equal(state.tools[0].argsLen, 5); // '{"p"}' = 5 字符
    assert.equal(state.running, true);
    // 同 index 的工具调用合并进同一条
    assert.equal(applyMonitorEvent(state, 'ai-toolcall', {sessionId: 's1', index: 0, argsDelta: 'ath"}'}), 'append');
    assert.equal(state.tools.length, 1);
    assert.equal(state.tools[0].argsLen, 10);
    // 回合边界：清空缓冲并要求从磁盘重放
    assert.equal(applyMonitorEvent(state, 'ai-done', {sessionId: 's1'}), 'reload');
    assert.equal(state.running, false);
    assert.equal(state.content, '');
    assert.equal(state.tools.length, 0);
    // 错误回合同样 reload，且错误信息留在状态里
    assert.equal(applyMonitorEvent(state, 'ai-chunk', {sessionId: 's1', delta: 'x'}), 'append');
    assert.equal(applyMonitorEvent(state, 'ai-error', {sessionId: 's1', message: '超时'}), 'reload');
    assert.equal(state.error, '超时');
    // 别窗会话不认领
    assert.equal(applyMonitorEvent(state, 'ai-chunk', {sessionId: 's2', delta: 'x'}), '');
    assert.equal(state.content, '');
});

test('buildMonitorRows：重放行 + 活增量合并，活行带（实时）标记', () => {
    const entries = [
        {role: 'user', content: '帮我看看这段日志'},
        {role: 'assistant', speaker: '模组助手', content: '看完了，问题在第三行'},
        {role: 'tool', content: ''}, // 空的非用户行被压掉
    ];
    const idle = createMonitorStreamState('s1');
    const rowsIdle = buildMonitorRows(entries, idle);
    assert.equal(rowsIdle.length, 2);
    assert.equal(rowsIdle[0].role, 'user');
    assert.equal(rowsIdle[1].name, '模组助手');
    assert.ok(!rowsIdle[1].live);

    const running = createMonitorStreamState('s1');
    running.running = true;
    running.content = '正在读文件…';
    running.thinking = '先找日志路径';
    const rowsLive = buildMonitorRows(entries, running);
    assert.equal(rowsLive.length, 3);
    const live = rowsLive[2];
    assert.equal(live.live, true);
    assert.equal(live.text, '正在读文件…');
    assert.equal(live.reasoning, '先找日志路径');
    // 只有工具没有正文时，活行文本退化为工具摘要
    const toolsOnly = createMonitorStreamState('s1');
    toolsOnly.running = true;
    toolsOnly.tools.push({index: 0, name: 'list_dir', argsLen: 12});
    const rowsTools = buildMonitorRows(entries, toolsOnly);
    assert.equal(rowsTools[2].text, '（调用 list_dir（参数 12 字符））');
});

test('normalizeReplayRow：形状差异抹平与空行剔除', () => {
    assert.deepEqual(
        normalizeReplayRow({role: 'assistant', speaker: 'A1', content: '发言'}),
        {role: 'assistant', name: 'A1', text: '发言'},
    );
    // 群聊条目 kind 字段兼容
    assert.equal(normalizeReplayRow({kind: 'user', text: '问题'}).role, 'user');
    assert.equal(normalizeReplayRow({role: 'tool', content: ''}), null);
    assert.equal(normalizeReplayRow(null), null);
});

test('formatMonitorStatus：运行 / 出错 / 排队 / 空闲', () => {
    const running = createMonitorStreamState('s1');
    running.running = true;
    assert.equal(formatMonitorStatus(running), '运行中');
    const err = createMonitorStreamState('s1');
    err.error = '超时';
    assert.equal(formatMonitorStatus(err), '出错：超时');
    const queued = createMonitorStreamState('s1');
    queued.note = '消息已排队，本轮结束后送达';
    assert.equal(formatMonitorStatus(queued), '消息已排队，本轮结束后送达');
    assert.equal(formatMonitorStatus(createMonitorStreamState('s1')), '空闲');
});
