// ai-session-fork.test.mjs：会话分叉纯函数护栏（消息快照、设置与授权凭据的继承）。
// 面板侧的动作（正在流式时拒绝分叉、index 必须落在 assistant 消息上）仍靠手工回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import {forkMessages, forkSettings} from '../../../src/ai/session/ai-session-fork.js';

const source = {
    workspace: 'D:/proj',
    scope: 'edit',
    profileId: 'profile-a',
    modelId: 'deepseek-v4',
    ctxLimit: 262144,
    systemPrompt: '你是助手',
    promptTemplateId: 'pt-1',
    summary: {text: '摘要', upto: 3},
    approvedPaths: ['D:/proj/a.js'],
    readRoots: ['D:/other'],
    messages: [
        {role: 'user', content: '问题'},
        {role: 'assistant', content: '回答', status: 'done'},
        {role: 'assistant', content: '生成的', status: 'streaming'},
        {role: 'user', content: '追问', kind: 'changes-summary'},
    ],
};

test('forkMessages：有效 index 只取到该条', () => {
    const r = forkMessages(source, 1);
    assert.equal(r.ok, true);
    assert.equal(r.messages.length, 2, '到第 2 条为止');
    assert.equal(r.messages[1].content, '回答');
});

test('forkMessages：index 无效或未提供时取全部', () => {
    for (const index of [undefined, null, -1, 99, 1.5, '1']) {
        const r = forkMessages(source, index);
        assert.equal(r.ok, true);
        assert.equal(r.messages.length, 3, '全量 4 条减去改动汇总卡：' + index);
    }
});

test('forkMessages：剔除纯 UI 注记（改动汇总卡）', () => {
    const r = forkMessages(source);
    assert.ok(!r.messages.some((m) => m.kind === 'changes-summary'));
});

test('forkMessages：残留生成态归为已完成', () => {
    const r = forkMessages(source);
    const gen = r.messages.find((m) => m.content === '生成的');
    assert.equal(gen.status, 'done', '否则新会话会一直显示流式中');
});

test('forkMessages：深拷贝隔离（改结果不影响源）', () => {
    const r = forkMessages(source);
    r.messages[0].content = '被改';
    assert.equal(source.messages[0].content, '问题');
});

test('forkMessages：空源与坏数据兜底', () => {
    assert.deepEqual(forkMessages(null).messages, []);
    assert.deepEqual(forkMessages({}).messages, []);
    assert.equal(forkMessages({messages: 'x'}).ok, true);
});

test('forkSettings：继承模型、人设与提示词模板', () => {
    const s = forkSettings(source);
    assert.equal(s.profileId, 'profile-a');
    assert.equal(s.modelId, 'deepseek-v4');
    assert.equal(s.ctxLimit, 262144, '本次会话上下文上限随 fork 继承');
    assert.equal(s.systemPrompt, '你是助手');
    assert.equal(s.promptTemplateId, 'pt-1');
    assert.equal(s.scope, 'edit', '不再强制只读');
    assert.equal(s.workspace, 'D:/proj');
});

test('forkSettings：授权凭据一次性快照且深拷贝', () => {
    const s = forkSettings(source);
    assert.deepEqual(s.approvedPaths, ['D:/proj/a.js']);
    assert.deepEqual(s.readRoots, ['D:/other']);
    s.approvedPaths.push('D:/proj/b.js');
    assert.equal(source.approvedPaths.length, 1, '不联动源会话');
});

test('forkSettings：空源给出安全默认', () => {
    const s = forkSettings(null);
    assert.equal(s.scope, 'read');
    assert.equal(s.workspace, '');
    assert.equal(s.ctxLimit, 0, '上限默认不设限');
    assert.deepEqual(s.approvedPaths, []);
    assert.deepEqual(s.readRoots, []);
    assert.equal(s.summary, null);
    assert.equal(s.temp, false, '普通会话派生出来的仍是普通会话');
});

// 临时会话（session.temp）派生：分叉 / 支线必须继承一次性语义，否则「分个支就变成
// 会注入 AGENTS.md / 记忆、重启后还在的普通会话」，一次性语义被静默突破。
test('forkSettings：临时会话的派生仍是临时会话（temp 继承 + 只认严格 true）', () => {
    assert.equal(forkSettings({...source, temp: true}).temp, true);
    assert.equal(forkSettings({...source, temp: 'true'}).temp, false, '脏值不继承');
    assert.equal(forkSettings({...source}).temp, false);
});
