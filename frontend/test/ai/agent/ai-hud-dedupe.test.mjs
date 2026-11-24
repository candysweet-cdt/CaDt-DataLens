// ai-hud-dedupe.test.mjs：智能体团队 HUD 子代理去重回归。
// 背景：历史会话的 spawn_agent meta 被旧版 normalizeMessage 剥掉 agent.key，兜底源回退到
// toolCallId，与运行期 Map 的 agent-* 判为不同 → 同一子代理在团队视图 / HUD 显示两次（5 → 10）。
// 本测试锁死双维度去重算法 + normalizeMessage 保留身份字段的接线（改实现时同步改这里）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {makeHudDeduper} from '../../../src/ai/agent/ai-head-hud.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const panel = read('../../../src/ai/ai-panel.js');

function sliceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.notEqual(start, -1, '找不到起点：' + startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(end, -1, '找不到终点：' + endMarker);
    return source.slice(start, end);
}

test('makeHudDeduper：key 相同视为同一条', () => {
    const seen = makeHudDeduper();
    assert.equal(seen('agent-1', 'call-1'), false);
    assert.equal(seen('agent-1', 'call-2'), true);   // key 命中
});

test('makeHudDeduper：toolCallId 相同视为同一条（历史数据缺 key 的兜底）', () => {
    const seen = makeHudDeduper();
    assert.equal(seen('agent-1', 'call-1'), false);
    assert.equal(seen('', 'call-1'), true);          // key 为空，靠 callId 命中
    assert.equal(seen('agent-2', 'call-1'), true);   // 即便换了 key，callId 命中仍判重
});

test('makeHudDeduper：两个维度都不同才放行', () => {
    const seen = makeHudDeduper();
    assert.equal(seen('agent-1', 'call-1'), false);
    assert.equal(seen('agent-2', 'call-2'), false);
    assert.equal(seen('agent-3', ''), false);        // 缺 callId 时只按 key
    assert.equal(seen('', 'call-3'), false);         // 缺 key 时只按 callId
    assert.equal(seen('', ''), false);               // 两者都空：不去重（脏数据不误吞）
});

test('makeHudDeduper：复现 5 个子代理 + 历史剥字段消息 → 去重后仍是 5', () => {
    const seen = makeHudDeduper();
    const out = [];
    // 运行期 Map：5 条已完成代理，key=agent-*，toolCallId=call-*
    const registry = [
        ['agent-1', 'call-1'], ['agent-2', 'call-2'], ['agent-3', 'call-3'],
        ['agent-4', 'call-4'], ['agent-5', 'call-5'],
    ];
    for (const [key, callId] of registry) if (!seen(key, callId)) out.push('registry:' + key);
    // 兜底源 session.messages：同样 5 条，但历史数据的 agent.key 已被剥（key=''），只剩 callId
    for (let i = 1; i <= 5; i++) {
        const callId = 'call-' + i;
        const key = '';   // normalizeMessage 旧版剥掉了 agent.key
        if (!seen(key || callId, callId)) out.push('message:' + callId);
    }
    assert.equal(out.length, 5, '5 个子代理去重后应仍是 5，实际：' + out.join(', '));
});

test('normalizeMessage：会话读回保留 agent.key/id 等身份字段（防重复根因）', () => {
    const normalize = sliceBetween(panel, 'message.agent = {', 'if (raw.agent.state === \'running\')');
    // 身份字段必须被重建，缺 key 会让 HUD 去重退化到 toolCallId
    assert.match(normalize, /key:\s*aiTextOf\(raw\.agent\.key\)/, '必须保留 agent.key');
    assert.match(normalize, /id:\s*aiTextOf\(raw\.agent\.id\)/, '必须保留 agent.id（详情视图转录补读依赖）');
    assert.match(normalize, /artifactDir:\s*aiTextOf\(raw\.agent\.artifactDir\)/, '必须保留 agent.artifactDir');
    assert.match(normalize, /depth:\s*Math\.max/, '必须保留 agent.depth');
    assert.match(normalize, /sandboxMode:\s*aiTextOf\(raw\.agent\.sandboxMode\)/, '必须保留 agent.sandboxMode');
});
