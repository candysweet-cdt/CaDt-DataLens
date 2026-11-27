// 子代理跨进程续跑单测（S6）：快照编码 / 归一 / 续跑判定 / 接线护栏。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
    encodeAgentRun, normalizeAgentRuns, mergeAgentRun, resumePlanOf, wasInterrupted,
    AI_AGENT_RUN_MAX, AI_AGENT_RUN_MSG_MAX,
} from '../../../src/ai/agent/ai-agent-resume.js';

function makeSub(over = {}) {
    return {
        id: 'sub-1', key: 'k1', toolCallId: 'call-1', name: '侦察兵', task: '看一遍仓库',
        depth: 1, mode: 'background', state: 'running', sandboxMode: 'read',
        parentSessionId: 's1', rootSessionId: 's1', maxRounds: 40, startedAt: 1000,
        session: {
            workspace: 'D:/w', scope: 'read', ctxLimit: 0, profileId: 'p1', modelId: 'm1',
            messages: [{role: 'user', content: '看一遍仓库'}, {role: 'assistant', content: '好'}],
        },
        flow: {baseRound: 2, roundNo: 3, usage: {totalTokens: 10}},
        ...over,
    };
}

test('encodeAgentRun：保留重建所必需的字段', () => {
    const run = encodeAgentRun(makeSub(), 'running');
    assert.equal(run.id, 'sub-1');
    assert.equal(run.state, 'running');
    assert.equal(run.baseRound, 2);
    assert.equal(run.rounds, 3);
    assert.equal(run.run.profileId, 'p1');
    assert.equal(run.run.modelId, 'm1');
    assert.equal(run.run.messages.length, 2);
    assert.equal(run.run.scope, 'read');
});

test('encodeAgentRun：转录超限时首条必留、其余取尾部', () => {
    const messages = [{role: 'user', content: 'task'}];
    for (let i = 0; i < AI_AGENT_RUN_MSG_MAX + 20; i += 1) {
        messages.push({role: 'assistant', content: 'm' + i});
    }
    const run = encodeAgentRun(makeSub({session: {...makeSub().session, messages}}), 'running');
    assert.equal(run.run.messages.length, AI_AGENT_RUN_MSG_MAX);
    assert.equal(run.run.messages[0].content, 'task');
    assert.equal(run.run.messages[run.run.messages.length - 1].content,
        'm' + (AI_AGENT_RUN_MSG_MAX + 19));
});

test('encodeAgentRun：缺 id 返回 null', () => {
    assert.equal(encodeAgentRun(null), null);
    assert.equal(encodeAgentRun({}), null);
});

test('normalizeAgentRuns：丢坏数据、按 id 去重、按 updatedAt 倒序、封顶', () => {
    const good = encodeAgentRun(makeSub(), 'running');
    const bad = normalizeAgentRuns([
        null, 'x', {}, {id: 'no-parent', run: {messages: [{}]}},
        {id: 'no-msgs', parentSessionId: 's1', run: {messages: []}},
        good,
        {...good, updatedAt: (good.updatedAt || 0) + 1000, task: '新的'},
    ]);
    assert.equal(bad.length, 1, '同 id 只留一条');
    assert.equal(bad[0].task, '新的', '后者覆盖前者');
    assert.equal(normalizeAgentRuns(undefined).length, 0);
});

test('mergeAgentRun：同 id 替换并置顶，不改变入参', () => {
    const a = encodeAgentRun(makeSub(), 'running');
    const list = mergeAgentRun([a], {...a, id: 'sub-2', task: '另一个'});
    assert.deepEqual(list.map((r) => r.id), ['sub-2', 'sub-1']);
    assert.equal(list.length, 2);
    assert.ok(list.length <= AI_AGENT_RUN_MAX);
});

test('resumePlanOf：可续与三种不可续原因', () => {
    const base = encodeAgentRun(makeSub(), 'running');
    assert.equal(resumePlanOf(base).ok, true);
    assert.match(resumePlanOf({...base, state: 'done'}).reason, /已完成/);
    assert.match(resumePlanOf({...base, rounds: 40, maxRounds: 40}).reason, /轮次预算/);
    assert.match(resumePlanOf({...base, run: {...base.run, messages: []}}).reason, /转录/);
    assert.match(resumePlanOf({...base, run: {...base.run, profileId: ''}}).reason, /模型账号/);
});

test('wasInterrupted：只认进程退出时仍在 running 的快照', () => {
    const base = encodeAgentRun(makeSub(), 'running');
    assert.equal(wasInterrupted(base), true);
    assert.equal(wasInterrupted({...base, state: 'interrupted'}), false);
});

test('接线：面板在启动补载后重建记录，且不自动续跑', () => {
    const panel = readFileSync(new URL('../../../src/ai/ai-panel.js', import.meta.url), 'utf8');
    assert.match(panel, /subagentsMod\.restoreAgentRuns\(session\)/);
    assert.match(panel, /saveAgentRun: \(snapshot\) =>/);
    assert.match(panel, /agentRuns: normalizeAgentRuns\(stored\.agentRuns\)/);
});

test('接线：子代理在轮边界与终态写快照', () => {
    const src = readFileSync(new URL('../../../src/ai/agent/ai-subagents.js', import.meta.url), 'utf8');
    const round = src.slice(src.indexOf('function runSubRound(sub) {'), src.indexOf('function runSubRound(sub) {') + 400);
    assert.match(round, /persistRun\(sub, 'running'\)/);
    const finalize = src.slice(src.indexOf('function finalizeSubAgent('), src.indexOf('function finalizeSubAgent(') + 400);
    assert.match(finalize, /persistRun\(sub, state\)/);
    assert.match(src, /restoreAgentRuns, resumeAgentRun, persistRun,/);
});
