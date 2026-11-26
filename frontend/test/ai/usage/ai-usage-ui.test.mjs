// ai-usage-ui.test.mjs —— 用量 UI 域纯函数（V3 从 ai-panel.js 收编）：
// sessionUsageTotals 聚合口径 / turnUsageTotal 兜底 / 格式化三件套。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    aiFormatCompactTokens,
    aiFormatExactCount,
    aiFormatCompactDuration,
    turnUsageTotal,
    sessionUsageTotals,
    createAIUsageUI,
} from '../../../src/ai/usage/ai-usage-ui.js';

test('aiFormatCompactTokens：K/M 分档与去尾零', () => {
    assert.equal(aiFormatCompactTokens(999), '999');
    assert.equal(aiFormatCompactTokens(1000), '1K');
    assert.equal(aiFormatCompactTokens(12345), '12.3K');
    assert.equal(aiFormatCompactTokens(150000), '150K');
    assert.equal(aiFormatCompactTokens(1234567), '1.2M');
    assert.equal(aiFormatCompactTokens(-5), '0');
    assert.equal(aiFormatCompactTokens('abc'), '0');
});

test('aiFormatExactCount：千分位与负值钳零', () => {
    assert.equal(aiFormatExactCount(1234567), '1,234,567');
    assert.equal(aiFormatExactCount(-3), '0');
});

test('aiFormatCompactDuration：分档文案', () => {
    assert.equal(aiFormatCompactDuration(400), '不到 1 秒');
    assert.equal(aiFormatCompactDuration(65000), '1分5秒');
    assert.equal(aiFormatCompactDuration(3661000), '1小时1分');
    assert.equal(aiFormatCompactDuration(7200000), '2小时');
});

test('turnUsageTotal：totalTokens 缺失时用输入+输出兜底', () => {
    assert.equal(turnUsageTotal(null), 0);
    assert.equal(turnUsageTotal({usage: null}), 0);
    assert.equal(turnUsageTotal({usage: {totalTokens: 100}}), 100);
    assert.equal(turnUsageTotal({usage: {promptTokens: 30, completionTokens: 12}}), 42);
    // 负数输入参与求和后整体钳零（面板原行为：先 sum 再 max，不逐项钳）
    assert.equal(turnUsageTotal({usage: {promptTokens: -5, completionTokens: 12}}), 7);
});

test('sessionUsageTotals：轮 / 步 / tokens / 缓存聚合', () => {
    const session = {
        archived: [{role: 'user', ts: 1}],
        messages: [
            {role: 'user'},
            {role: 'assistant', usage: {promptTokens: 100, cachedTokens: 40, completionTokens: 50}, modelMs: 1000, firstTokenMs: 100, turnMs: 1200},
            {role: 'tool'},
            {role: 'user'},
            {role: 'assistant', usage: {promptTokens: 60, cachedTokens: 60, completionTokens: 30}, modelMs: 900, firstTokenMs: 90, turnMs: 950},
        ],
    };
    const totals = sessionUsageTotals(session);
    assert.equal(totals.rounds, 3); // 含 archived 里那条
    assert.equal(totals.steps, 2);
    assert.equal(totals.prompt, 160);
    assert.equal(totals.completion, 80);
    assert.equal(totals.cached, 100);
    assert.equal(totals.total, 240);
    assert.equal(totals.hasTools, true);
    assert.ok(totals.speed > 0);
    assert.equal(totals.speedKind, 'gen');
    // TTFT：两条消息均值
    assert.ok(Math.abs(totals.ttftAvg - 95) < 1e-6);
});

test('sessionUsageTotals：轮次口径与回合边界同源（steer / 信箱 notice 不计轮）', () => {
    const session = {messages: [
        {role: 'user', ts: 1, turnStartedAt: 1},
        {role: 'user', notice: true, turnStartedAt: 2, app: {kind: 'subagent'}},
        {role: 'user', ts: 3, steer: true, turnStartedAt: 3},
        {role: 'assistant', usage: {promptTokens: 10, completionTokens: 5}, modelMs: 500, firstTokenMs: 50},
    ]};
    assert.equal(sessionUsageTotals(session).rounds, 1, '后台通知与插话都不算用户发起的一轮');
});

test('sessionUsageTotals：短窗口退化端到端吞吐；无 usage 不计速度', () => {
    // modelMs < 200ms 的窗口走 e2e 兜底
    const short = {messages: [
        {role: 'assistant', usage: {promptTokens: 10, completionTokens: 5}, modelMs: 150, firstTokenMs: 10},
    ]};
    const s1 = sessionUsageTotals(short);
    assert.equal(s1.speedKind, 'e2e');
    assert.equal(s1.speed, Math.round(5 / 0.15));
    // 无 usage：速度为 0，kind 为空
    const none = {messages: [{role: 'assistant', content: 'x'}]};
    const s2 = sessionUsageTotals(none);
    assert.equal(s2.speed, 0);
    assert.equal(s2.speedKind, '');
    // 空会话不炸
    assert.equal(sessionUsageTotals(null).rounds, 0);
});

test('sessionUsageTotals：压缩归档用量走累加器，归档出栈后总量不回退、不重复计数', () => {
    // 压缩后归档消息被 vacuum 搬进 sidecar，session.archived 清空；累加器保留历史用量。
    const acc = {prompt: 100, completion: 50, total: 150, cached: 40, steps: 1, rounds: 1};
    const afterCompact = {archivedUsage: acc, messages: [
        {role: 'user', ts: 2},
        {role: 'assistant', usage: {promptTokens: 20, completionTokens: 10, cachedTokens: 5}, modelMs: 500},
    ]};
    const totals = sessionUsageTotals(afterCompact);
    assert.equal(totals.total, 180, '历史 150 + 本轮 30，归档不在内存也不回退');
    assert.equal(totals.prompt, 120);
    assert.equal(totals.completion, 60);
    assert.equal(totals.cached, 45);
    assert.equal(totals.rounds, 2, '归档轮也计入');
    assert.equal(totals.steps, 2);
    // 累加器与内存归档同时存在时只认累加器，避免重复计数
    const withArchived = Object.assign({}, afterCompact, {archived: [
        {role: 'assistant', usage: {promptTokens: 100, completionTokens: 50, totalTokens: 150}},
    ]});
    assert.equal(sessionUsageTotals(withArchived).total, 180, '累加器优先，归档不重复计入');
    // 旧会话没有累加器：维持归档 + 当前消息原口径
    const legacy = {archived: [
        {role: 'assistant', usage: {promptTokens: 100, completionTokens: 50, totalTokens: 150}},
    ], messages: afterCompact.messages};
    assert.equal(sessionUsageTotals(legacy).total, 180);
});

test('sessionUsageTotals：累加器保留耗时 / 工具 / TPS，压缩后不缩水（审查 M2）', () => {
    // 归档段带耗时、工具消息；压缩后归档出栈，这些字段必须从累加器快照恢复。
    const acc = {rounds: 1, steps: 1, prompt: 100, completion: 50, total: 150, cached: 40,
        turnMs: 3000, modelMs: 3500, toolMs: 1200, hasTools: true,
        genMs: 3400, genCompletion: 50, e2eMs: 0, e2eCompletion: 0,
        ttftMs: 200, ttftCount: 1};
    const totals = sessionUsageTotals({archivedUsage: acc, messages: [
        {role: 'assistant', usage: {completionTokens: 10}, modelMs: 500, firstTokenMs: 100},
    ]});
    assert.equal(totals.modelMs, 4000, '3500 + 500，不是只剩尾部 500');
    assert.equal(totals.toolMs, 1200);
    assert.equal(totals.hasTools, true);
    assert.ok(Math.abs(totals.ttftAvg - 150) < 1e-6, '(200 + 100) / 2');
    assert.ok(totals.speed > 0, 'TPS 采样从累加器恢复');
});

test('sessionUsageTotals：空壳累加器不吞掉内存归档（审查 m2）', () => {
    const session = {archivedUsage: {}, archived: [
        {role: 'assistant', usage: {totalTokens: 500}},
    ], messages: []};
    assert.equal(sessionUsageTotals(session).total, 500, '脏 meta 的空累加器应回落原口径');
});

test('createAIUsageUI：返回对象暴露 sessionUsageTotals（面板别名依赖它）', () => {
    // ai-panel.js 用 usageMod.sessionUsageTotals 转发；工厂漏返会启动即
    // TypeError: usageMod.sessionUsageTotals is not a function（2026-11-17 实际事故）
    const ui = createAIUsageUI({
        el: () => null,
        currentSession: () => null,
        renderCtxPopover: () => '',
    });
    assert.equal(typeof ui.sessionUsageTotals, 'function');
    assert.equal(ui.sessionUsageTotals(null).rounds, 0);
    assert.equal(ui.sessionUsageTotals({messages: []}).total, 0);
});
