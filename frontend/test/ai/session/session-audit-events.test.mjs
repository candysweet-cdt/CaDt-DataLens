// 会话审计事件单测（S5）：编码 / 重放分桶 / 未闭合回合识别 / 未知类型不污染正文。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    encodeSessionHeader,
    encodeMessageEvent,
    encodeSessionLines,
    encodeTurnEvent,
    encodeToolEvent,
    encodeApprovalEvent,
    encodeAgentEvent,
    replaySessionLog,
    interruptedTurnIds,
    SESSION_AUDIT_EVENT_TYPES,
} from '../../../src/ai/session/ai-session-store.js';

const session = {id: 's1', title: 't', createdAt: 1, workspace: 'D:/w'};

function logOf(events) {
    return encodeSessionLines(events.filter(Boolean));
}

test('编码器：四类事件带稳定形状，缺 id 返回 null', () => {
    const turn = encodeTurnEvent('s1#1', 'start');
    assert.deepEqual(turn, {v: turn.v, t: 'turn', id: 's1#1', phase: 'start'});
    assert.equal(encodeTurnEvent('', 'start'), null);
    assert.equal(encodeToolEvent('c1', 'read_file', 'end', false).ok, false);
    assert.equal(encodeToolEvent('c1', 'read_file', 'end', true).ok, true);
    assert.equal(encodeApprovalEvent('c1', 'auto', 'run_command').verdict, 'auto');
    assert.equal(encodeAgentEvent('a1', 'done', 'ok').state, 'ok');
    assert.equal(encodeAgentEvent(null, 'spawn'), null);
});

test('编码器：事件深冻结，落盘后不可再变（事件溯源不变量）', () => {
    const turn = encodeTurnEvent('t1', 'start', 'why');
    assert.ok(Object.isFrozen(turn));
    assert.ok(Object.isFrozen(turn.reason) || typeof turn.reason === 'string');
    assert.throws(() => { turn.phase = 'close'; }, TypeError);
    const tool = encodeToolEvent('c1', 'read_file', 'end', true);
    assert.ok(Object.isFrozen(tool));
});

test('编码器：reason / name 截断且空值不写字段', () => {
    const turn = encodeTurnEvent('t1', 'close', 'x'.repeat(80));
    assert.equal(turn.reason.length, 32);
    const bare = encodeTurnEvent('t2', 'start', '');
    assert.equal('reason' in bare, false);
    const tool = encodeToolEvent('c1', '', 'start');
    assert.equal('name' in tool, false);
});

test('重放：四类事件进 audit 分桶，不影响 messages', () => {
    const text = logOf([
        encodeSessionHeader(session),
        encodeTurnEvent('s1#1', 'start'),
        encodeMessageEvent({role: 'user', content: 'hi', status: 'done'}, 'm1'),
        encodeToolEvent('c1', 'read_file', 'start'),
        encodeToolEvent('c1', 'read_file', 'end', true),
        encodeApprovalEvent('c1', 'allow', 'read_file'),
        encodeAgentEvent('a1', 'spawn'),
        encodeTurnEvent('s1#1', 'close', 'done'),
    ]);
    const replay = replaySessionLog(text);
    assert.equal(replay.issues, 0);
    assert.equal(replay.messages.length, 1);
    assert.equal(replay.audit.turns.length, 2);
    assert.equal(replay.audit.tools.length, 2);
    assert.equal(replay.audit.approvals.length, 1);
    assert.equal(replay.audit.agents.length, 1);
    assert.equal(replay.audit.tools[1].ok, true);
});

test('重放：审计事件缺 id 计 issue 且不入桶', () => {
    const bad = '{"v":1,"t":"tool","phase":"start"}';
    const replay = replaySessionLog(bad + '\n');
    assert.equal(replay.issues, 1);
    assert.equal(replay.audit.tools.length, 0);
});

test('重放：未知事件类型仍计 issue（前向兼容的显式边界）', () => {
    const replay = replaySessionLog('{"v":1,"t":"future-thing","id":"x"}\n');
    assert.equal(replay.issues, 1);
    assert.equal(replay.audit.turns.length, 0);
});

test('interruptedTurnIds：有 start 无 close 才算未闭合', () => {
    const open = replaySessionLog(logOf([
        encodeSessionHeader(session),
        encodeTurnEvent('t1', 'start'),
        encodeTurnEvent('t2', 'start'),
        encodeTurnEvent('t2', 'close', 'done'),
    ]));
    assert.deepEqual(interruptedTurnIds(open), ['t1']);

    const closed = replaySessionLog(logOf([
        encodeSessionHeader(session),
        encodeTurnEvent('t1', 'start'),
        encodeTurnEvent('t1', 'close', 'crash'),
    ]));
    assert.deepEqual(interruptedTurnIds(closed), []);
});

test('interruptedTurnIds：同 id 再次 start 视为新一轮', () => {
    const replay = replaySessionLog(logOf([
        encodeSessionHeader(session),
        encodeTurnEvent('t1', 'start'),
        encodeTurnEvent('t1', 'close', 'done'),
        encodeTurnEvent('t1', 'start'),
    ]));
    assert.deepEqual(interruptedTurnIds(replay), ['t1']);
});

test('interruptedTurnIds：容忍空输入', () => {
    assert.deepEqual(interruptedTurnIds(null), []);
    assert.deepEqual(interruptedTurnIds({}), []);
});

test('事件类型全集与实际编码器对齐（防止加类型忘了登记）', () => {
    assert.deepEqual([...SESSION_AUDIT_EVENT_TYPES], ['turn', 'tool', 'approval', 'agent']);
});
