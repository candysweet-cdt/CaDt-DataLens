// ai-team-model.test.mjs：团队详情页纯模型（主代理置顶 / 嵌套 / 统计 / 卡片文案）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TEAM_MAIN_KEY, makeMainAgentNode, buildTeamTree, teamAgentStats,
    formatDuration, formatTokens, agentLevelText, agentNodeMeta, taskSnippet, agentTreeText,
} from '../../../src/ai/group/ai-team-model.js';

const agent = (key, extra = {}) => ({
    key, toolCallId: key, subId: 'sub-' + key, name: key, state: 'running', startedAt: 0, depth: 1, ...extra,
});

const rows = (roots) => {
    const out = [];
    const walk = (nodes, level) => {
        for (const node of nodes) {
            out.push({key: node.agent.key, level});
            walk(node.children, level + 1);
        }
    };
    walk(roots, 0);
    return out;
};

test('makeMainAgentNode：会话 id / 标题 / 状态映射到合成根条目', () => {
    const main = makeMainAgentNode({sessionId: 's1', title: '修复登录超时', state: 'streaming'});
    assert.equal(main.key, TEAM_MAIN_KEY);
    assert.equal(main.subId, 's1');
    assert.equal(main.depth, 0);
    assert.equal(main.name, '修复登录超时');
    assert.equal(main.state, 'streaming');
    assert.equal(makeMainAgentNode({}).name, '主代理');
});

test('buildTeamTree：主代理永远置顶，一级子代理挂在它下面', () => {
    const main = makeMainAgentNode({sessionId: 's1', title: '会话', state: 'idle'});
    const roots = buildTeamTree(main, [
        agent('a', {parentSessionId: 's1', startedAt: 10}),
        agent('b', {parentSessionId: 's1', startedAt: 20}),
    ]);
    assert.deepEqual(rows(roots), [
        {key: TEAM_MAIN_KEY, level: 0},
        {key: 'b', level: 1},
        {key: 'a', level: 1},
    ]);
});

test('buildTeamTree：深层链正常嵌套，孙代理吹到对应父节点下', () => {
    const main = makeMainAgentNode({sessionId: 's1'});
    const roots = buildTeamTree(main, [
        agent('a', {parentSessionId: 's1'}),
        agent('a1', {parentSessionId: 'sub-a', depth: 2}),
        agent('a1x', {parentSessionId: 'sub-a1', depth: 3}),
    ]);
    assert.deepEqual(rows(roots), [
        {key: TEAM_MAIN_KEY, level: 0},
        {key: 'a', level: 1},
        {key: 'a1', level: 2},
        {key: 'a1x', level: 3},
    ]);
});

test('buildTeamTree：主代理缺 sessionId 时一级代理成孤儿根，但仍排在主代理之后', () => {
    const main = makeMainAgentNode({sessionId: '', title: '会话'});
    const roots = buildTeamTree(main, [agent('x', {parentSessionId: 's9', state: 'running'})]);
    assert.deepEqual(roots.map((node) => node.agent.key), [TEAM_MAIN_KEY, 'x']);
});

test('buildTeamTree：空输入也返回只有主代理的树', () => {
    const roots = buildTeamTree(makeMainAgentNode({sessionId: 's1'}), []);
    assert.equal(roots.length, 1);
    assert.equal(roots[0].agent.key, TEAM_MAIN_KEY);
    assert.deepEqual(buildTeamTree(null, null).map((n) => n.agent.key), [TEAM_MAIN_KEY]);
});

test('teamAgentStats：按状态计数，未知状态只计入 total', () => {
    assert.deepEqual(teamAgentStats([
        agent('a'), agent('b', {state: 'done'}), agent('c', {state: 'error'}),
        agent('d', {state: 'stopped'}), agent('e', {state: 'weird'}), null,
    ]), {total: 5, running: 1, done: 1, error: 1, stopped: 1});
    assert.deepEqual(teamAgentStats(null), {total: 0, running: 0, done: 0, error: 0, stopped: 0});
});

test('formatDuration / formatTokens：人类可读且边界正确', () => {
    assert.equal(formatDuration(1200), '1s');
    assert.equal(formatDuration(59000), '59s');
    assert.equal(formatDuration(90000), '1分30秒');
    assert.equal(formatDuration(180000), '3分钟');
    assert.equal(formatDuration(3900000), '1小时5分');
    assert.equal(formatTokens(0), '');
    assert.equal(formatTokens(999), '999 tokens');
    assert.equal(formatTokens(12500), '12.5K tokens');
    assert.equal(formatTokens(2000000), '2M tokens');
});

test('agentLevelText：层号含主代理（depth 0 = 第 1 层），单一来源', () => {
    assert.equal(agentLevelText(0), '第 1 层');
    assert.equal(agentLevelText(1), '第 2 层');
    assert.equal(agentLevelText(4), '第 5 层');
    assert.equal(agentLevelText(undefined), '第 1 层');
});

test('agentNodeMeta：按可用字段拼文案，缺字段跳过', () => {
    assert.deepEqual(agentNodeMeta({
        depth: 2, sandboxMode: 'workspace-write', mode: 'background', rounds: 12,
        ms: 90000, tokens: 12500, inboxCount: 1,
    }), ['第 3 层', '沙箱 可写', '后台', '12 轮', '1分30秒', '12.5K tokens', '待处理 1']);
    assert.deepEqual(agentNodeMeta({depth: 1}), ['第 2 层']);
    assert.deepEqual(agentNodeMeta({depth: 0}), []);
    assert.deepEqual(agentNodeMeta(null), []);
    assert.deepEqual(agentNodeMeta({compacting: true}), ['压缩中']);
});

test('taskSnippet：折叠空白并按上限截断', () => {
    assert.equal(taskSnippet('  多行\n任务   文本 '), '多行 任务 文本');
    assert.equal(taskSnippet('abcdefghijkl', 10), 'abcdefghij…');
    assert.equal(taskSnippet(''), '');
    assert.equal(taskSnippet(null), '');
});

test('agentTreeText：主代理看到整棵树、每行带 id，并标明自己是根', () => {
    const text = agentTreeText({isMain: true, id: 's1', title: '修复登录超时'}, [
        agent('a', {parentSessionId: 's1', depth: 1, sandboxMode: 'read-only', mode: 'background', rounds: 3, task: '调研 CLI'}),
        agent('a1', {parentSessionId: 'sub-a', depth: 2}),
        agent('b', {parentSessionId: 's1', depth: 1, state: 'done'}),
    ]);
    assert.match(text, /你是：主代理（根节点）/);
    assert.match(text, /团队：运行中 2 · 共 3/);
    assert.match(text, /- \[主代理\] 修复登录超时（根）/);
    assert.match(text, /- \[运行中\] a · id=sub-a · 第 2 层 · 沙箱 只读 · 后台 · 3 轮 · 调研 CLI/);
    assert.match(text, /  - \[运行中\] a1 · id=sub-a1 · 第 3 层/);
    assert.match(text, /- \[已完成\] b · id=sub-b/);
});

test('agentTreeText：子代理只看到自己这一支，并标出「（你）」', () => {
    const text = agentTreeText({isMain: false, id: 'sub-a1', name: '通信链路调查', depth: 2}, [
        agent('a', {parentSessionId: 's1'}),
        agent('a1', {parentSessionId: 'sub-a', depth: 2}),
        agent('a1x', {parentSessionId: 'sub-a1', depth: 3}),
        agent('a2', {parentSessionId: 'sub-a', depth: 2}),
        agent('b', {parentSessionId: 's1'}),
    ]);
    assert.match(text, /你是：「通信链路调查」 id=sub-a1（第 3 层）/);
    assert.match(text, /本支：运行中 2 · 共 2/);
    assert.doesNotMatch(text, /id=sub-b/);
    assert.doesNotMatch(text, /id=sub-a2/);
    assert.match(text, /- \[运行中\] a1 · id=sub-a1 · 第 3 层 · （你）/);
    assert.match(text, /  - \[运行中\] a1x · id=sub-a1x · 第 4 层/);
});

test('agentTreeText：空团队与查不到自己时的兜底文案', () => {
    assert.match(agentTreeText({isMain: true, id: 's1'}, []), /（还没有派出子代理）/);
    const orphan = agentTreeText({isMain: false, id: 'sub-missing', name: '失联代理'}, [agent('x')]);
    assert.match(orphan, /团队记录里暂时查不到你自己/);
    assert.match(orphan, /id=sub-x/);
});
