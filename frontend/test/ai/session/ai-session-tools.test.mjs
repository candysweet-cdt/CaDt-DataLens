// ai-session-tools 测试：跨会话检索的结果渲染与会话日志摘要（纯函数，无 DOM）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AI_SESSION_DIGEST_MAX_CHARS,
    AI_SESSION_MESSAGE_MAX_CHARS,
    formatSessionSearchResult,
    messageTextOf,
    sessionLogDigest,
} from '../../../src/ai/session/ai-session-tools.js';

function logOf(events) {
    return events.map((event) => JSON.stringify(event)).join('\n') + '\n';
}

const HEADER = {
    v: 1, t: 'header', id: 's-demo', title: '会话 A', createdAt: 1700000000000, workspace: 'D:/ws-a',
};

function msgEvent(mid, role, content, ts) {
    return {v: 1, t: 'msg', mid, m: {role, content, ts}};
}

test('formatSessionSearchResult：按会话分组、标注角色、给 session_read 提示', () => {
    const out = formatSessionSearchResult('工作日志', {
        brief: true,
        truncated: false,
        hits: [
            {sessionId: 's1', title: '会话一', role: 'user', snippet: '记得写工作日志', ts: 1700000000000},
            {sessionId: 's1', title: '会话一', role: 'assistant', snippet: '好的，已写', ts: 1700000060000},
            {sessionId: 's2', title: '会话二', role: 'tool', snippet: '写工作日志失败', ts: 0},
        ],
    });
    assert.match(out, /会话检索：工作日志/);
    assert.equal((out.match(/●/g) || []).length, 2, '两个会话应各有一个分组头');
    assert.match(out, /● 会话一 · id: s1|● 会话一（/, '分组头要带标题与 id');
    assert.match(out, /\[用户\] 记得写工作日志/);
    assert.match(out, /\[助手\] 好的，已写/);
    assert.match(out, /\[工具\] 写工作日志失败/);
    assert.match(out, /session_read\(id/, '要给出后续动作提示');
});

test('formatSessionSearchResult：无命中与截断提示', () => {
    const empty = formatSessionSearchResult('不存在的词', {hits: []});
    assert.match(empty, /没有找到匹配的会话内容/);
    const truncated = formatSessionSearchResult('x', {
        truncated: true,
        hits: [{sessionId: 's1', title: 'T', role: 'user', snippet: 'x'}],
    });
    assert.match(truncated, /结果已截断/);
});

test('messageTextOf：字符串与分段数组都取到正文', () => {
    assert.equal(messageTextOf({content: 'abc'}), 'abc');
    assert.equal(messageTextOf({content: [{text: 'ab'}, 'cd', null]}), 'abcd');
    assert.equal(messageTextOf(null), '');
});

test('sessionLogDigest：默认读最近 N 条并带头部信息', () => {
    const raw = logOf([
        HEADER,
        msgEvent('m1', 'user', '第一条', 1700000001000),
        msgEvent('m2', 'assistant', '第二条', 1700000002000),
        msgEvent('m3', 'user', '第三条', 1700000003000),
    ]);
    const out = sessionLogDigest(raw, {limit: 2, workspace: 'D:/ws-a'});
    assert.match(out, /会话：会话 A · id: s-demo/);
    assert.match(out, /工作区：D:\/ws-a/);
    assert.match(out, /消息 3 条/);
    assert.match(out, /第三条/, 'limit=2 应包含最后一条');
    assert.match(out, /第二条/);
    assert.ok(!out.includes('第一条'), 'limit=2 不该包含更早的消息');
    assert.ok(!out.includes('别的工作区'), '同工作区不该提示跨工作区');
});

test('sessionLogDigest：跨工作区要显式提醒', () => {
    const raw = logOf([HEADER, msgEvent('m1', 'user', '内容', 1700000001000)]);
    const out = sessionLogDigest(raw, {workspace: 'E:/other'});
    assert.match(out, /别的工作区/);
});

test('sessionLogDigest：query 定位命中消息及前后各一条', () => {
    const raw = logOf([
        HEADER,
        msgEvent('m1', 'user', '开场白', 1700000001000),
        msgEvent('m2', 'assistant', '这里提到 rebuild-exe', 1700000002000),
        msgEvent('m3', 'user', '无关内容', 1700000003000),
    ]);
    const out = sessionLogDigest(raw, {query: 'rebuild-exe'});
    assert.match(out, /开场白/, '命中消息前一条应带出');
    assert.match(out, /这里提到 rebuild-exe/);
    assert.match(out, /无关内容/, '命中消息后一条应带出');
});

test('sessionLogDigest：query 无命中时明确说明', () => {
    const raw = logOf([HEADER, msgEvent('m1', 'user', '内容', 1700000001000)]);
    const out = sessionLogDigest(raw, {query: '找不到的词'});
    assert.match(out, /没有在该会话里找到关键词/);
});

test('sessionLogDigest：超长消息按单条上限截断、总量受预算约束', () => {
    const long = 'x'.repeat(AI_SESSION_MESSAGE_MAX_CHARS * 3);
    const events = [HEADER];
    for (let i = 0; i < 40; i++) events.push(msgEvent('m' + i, 'assistant', long, 1700000000000 + i));
    const out = sessionLogDigest(logOf(events), {limit: 40});
    assert.ok(out.length <= AI_SESSION_DIGEST_MAX_CHARS + 400, '输出应受总预算约束，实际 ' + out.length);
    assert.ok(!out.includes(long), '单条消息必须被截断');
    assert.match(out, /已按输出预算截断/);
});

test('sessionLogDigest：空日志与撕裂尾行不崩', () => {
    assert.match(sessionLogDigest(''), /没有可读的消息/);
    const torn = JSON.stringify(HEADER) + '\n' + JSON.stringify(msgEvent('m1', 'user', '完整', 1)) + '\n' + '{"v":1,"t":"msg","mi';
    const out = sessionLogDigest(torn);
    assert.match(out, /尾部未提交/);
    assert.match(out, /完整/);
});
