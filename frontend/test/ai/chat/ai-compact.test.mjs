// ai-compact.test.mjs：压缩内核（主会话与子代理共用）的纯函数护栏。
// 锁住三处「改了就悄悄出错」的判定：cutoff 必须回退到 user 轮边界、summary 形状要能被
// buildApiMessages 认出来、阈值 clamp 口径与主会话一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    computeCompactCutoff,
    computeCompactCutoffByBudget,
    compactRetainBudget,
    COMPACT_RETAIN_RATIO,
    buildCompactSummary,
    applyCompactToSession,
    stampPreCompactUsage,
    isAnchorUsage,
    compactTranscriptOf,
    buildCompactMessages,
    compactThresholdOf,
    COMPACT_KEEP_TAIL,
} from '../../../src/ai/chat/ai-compact.js';

const msg = (role, extra) => Object.assign({role, content: role}, extra || {});

test('computeCompactCutoff：保留尾部并回退到最近的 user 轮边界', () => {
    // [u a u a u a u a]：keep=3 → cutoff=5（assistant）→ 回退到 4（user）
    const messages = [msg('user'), msg('assistant'), msg('user'), msg('assistant'),
        msg('user'), msg('assistant'), msg('user'), msg('assistant')];
    assert.equal(computeCompactCutoff(messages, 3), 4);
    // keep=6 → cutoff=2 已是 user，不再回退
    assert.equal(computeCompactCutoff(messages, 6), 2);
    // 保留条数超过总数：cutoff=0（不裁剪）
    assert.equal(computeCompactCutoff(messages, 20), 0);
});

test('computeCompactCutoff：工具轮中间不会被切开', () => {
    // 落点恰好是 tool：必须回退到本轮的 user 起点
    const messages = [msg('user'), msg('assistant'), msg('tool'), msg('user'), msg('assistant'), msg('tool'), msg('assistant')];
    assert.equal(computeCompactCutoff(messages, 2), 3, 'cutoff 落在本轮 assistant，回退到 user');
    assert.equal(computeCompactCutoff(messages, 3), 3);
});

test('computeCompactCutoff：全是 assistant 时退到 0（宁可全压也不切碎）', () => {
    const messages = [msg('assistant'), msg('assistant'), msg('assistant')];
    assert.equal(computeCompactCutoff(messages, 1), 0);
    assert.equal(computeCompactCutoff(null), 0);
    assert.equal(COMPACT_KEEP_TAIL, 6);
});

test('compactRetainBudget：窗口−输出预留 后取 16%（与 dsh retainRatio 对齐）', () => {
    assert.equal(COMPACT_RETAIN_RATIO, 0.16);
    assert.equal(compactRetainBudget(200000, 32000), Math.floor(168000 * 0.16));
    // 窗口未知：0（调用方回退按条数）
    assert.equal(compactRetainBudget(0, 1000), 0);
    assert.equal(compactRetainBudget(null, null), 0);
    // 输出预留最多占一半：填成等于窗口也不会把预算清零
    assert.equal(compactRetainBudget(100000, 999999), Math.floor(50000 * 0.16));
    // 负预留按 0
    assert.equal(compactRetainBudget(100000, -5), Math.floor(100000 * 0.16));
});

test('computeCompactCutoffByBudget：按 token 累加到预算，再回退到 user 轮边界', () => {
    // 每个 user 100 token、assistant 50：预算 260 → 从尾部累加
    // assistant(50) user(100) assistant(50) user(100) = 300 ≥ 260 → 切在倒数第二个 user
    const messages = [
        msg('user', {tokens: 100}), msg('assistant', {tokens: 50}),
        msg('user', {tokens: 100}), msg('assistant', {tokens: 50}),
        msg('user', {tokens: 100}), msg('assistant', {tokens: 50}),
    ];
    const estimate = (m) => m.tokens;
    assert.equal(computeCompactCutoffByBudget(messages, 260, estimate), 2);
    // 预算很大：全部保留（cutoff 0）
    assert.equal(computeCompactCutoffByBudget(messages, 100000, estimate), 0);
    // 落点是 tool：回退到本轮 user 起点
    const withTool = [msg('user', {tokens: 10}), msg('assistant', {tokens: 10}), msg('tool', {tokens: 10}),
        msg('user', {tokens: 10}), msg('assistant', {tokens: 10}), msg('tool', {tokens: 10})];
    assert.equal(computeCompactCutoffByBudget(withTool, 15, (m) => m.tokens), 3);
});

test('computeCompactCutoffByBudget：预算缺失时回退按条数（旧口径）', () => {
    const messages = [msg('user'), msg('assistant'), msg('user'), msg('assistant'),
        msg('user'), msg('assistant'), msg('user'), msg('assistant')];
    assert.equal(computeCompactCutoffByBudget(messages, 0, () => 1, 3), computeCompactCutoff(messages, 3));
    assert.equal(computeCompactCutoffByBudget(messages, 100, null, 3), computeCompactCutoff(messages, 3));
    assert.equal(computeCompactCutoffByBudget(null, 100, () => 1), 0);
});

test('buildCompactSummary：summary 形状固定（upTo / trigger / before）', () => {
    const summary = buildCompactSummary('  摘要正文  ', 4, {kind: 'auto'}, 20);
    assert.equal(summary.text, '摘要正文', '首尾空白裁掉');
    assert.equal(summary.upTo, 4);
    assert.deepEqual(summary.trigger, {kind: 'auto'});
    assert.deepEqual(summary.before, {messages: 20, archived: 4});
    assert.equal(typeof summary.createdAt, 'number');
});

test('applyCompactToSession：裁剪消息、写回 summary、返回归档段', () => {
    const session = {messages: [msg('user'), msg('assistant'), msg('user'), msg('assistant')], summary: null};
    const summary = buildCompactSummary('s', 3, null, 4);
    const result = applyCompactToSession(session, summary, 3);
    assert.equal(result.archived.length, 3);
    assert.equal(result.kept, 1);
    assert.equal(session.messages.length, 1);
    assert.equal(session.summary, summary);
    // 越界 cutoff 不能把消息吃光或报错
    const other = {messages: [msg('user')], summary: null};
    assert.equal(applyCompactToSession(other, summary, 99).kept, 0);
    assert.deepEqual(applyCompactToSession(null, summary, 1), {archived: [], kept: 0});
});

// 压缩后旧 usage 计量的是「压缩前整段输入」，锚点不能再信它——否则占用环停在压缩前
// 的百分比不动（实测教训：82% 压缩后仍显示 82%，直到下一轮响应落地才回落）。
test('applyCompactToSession：保留段的 usage 打 preCompact 标，归档段不动', () => {
    const withUsage = (role) => msg(role, {usage: {promptTokens: 100, completionTokens: 10, totalTokens: 110}});
    const session = {messages: [withUsage('user'), withUsage('assistant'), withUsage('user'), withUsage('assistant')], summary: null};
    const archivedBefore = session.messages[1].usage;
    const summary = buildCompactSummary('s', 2, null, 4);
    const result = applyCompactToSession(session, summary, 2);
    // 保留段全部打标（被裁剪前计量过整段上下文），归档段原样
    for (const message of session.messages) {
        assert.equal(isAnchorUsage(message), false, '保留段 usage 不可再作锚点');
        assert.equal(message.usage.preCompact, true);
        assert.equal(message.usage.totalTokens, 110, 'usage 数值保留（统计行依赖）');
    }
    assert.equal(result.archived[1].usage, archivedBefore, '归档段对象未被改动');
    assert.equal(isAnchorUsage(result.archived[1]), true);
    // 二次压缩幂等：已打标不会出问题
    applyCompactToSession(session, summary, 0);
    assert.equal(session.messages[0].usage.preCompact, true);
});

test('applyCompactToSession：被裁剪段的用量折进只增累加器（统计行不回退）', () => {
    const withUsage = (role, p, c) => msg(role, {ts: role === 'user' ? 1 : 2,
        usage: {promptTokens: p, completionTokens: c, totalTokens: p + c, cachedTokens: 5}});
    const session = {messages: [
        withUsage('user', 0, 0),
        withUsage('assistant', 100, 10),
        withUsage('user', 0, 0),
        withUsage('assistant', 200, 20),
    ], summary: null};
    const summary = buildCompactSummary('s', 2, null, 4);
    applyCompactToSession(session, summary, 2);
    // 归档段（第 1 条 user + 第 2 条 assistant）用量进累加器
    assert.equal(session.archivedUsage.prompt, 100);
    assert.equal(session.archivedUsage.completion, 10);
    assert.equal(session.archivedUsage.total, 110);
    assert.equal(session.archivedUsage.cached, 5);
    assert.equal(session.archivedUsage.steps, 1);
    assert.equal(session.archivedUsage.rounds, 1);
    // 二次压缩再累加，不覆盖
    const s2 = Object.assign({}, session, {messages: [
        withUsage('user', 0, 0), withUsage('assistant', 300, 30),
    ]});
    applyCompactToSession(s2, summary, 2);
    assert.equal(s2.archivedUsage.total, 110 + 330, '累加器只增不减');
    assert.equal(s2.archivedUsage.rounds, 2);
});

test('applyCompactToSession：旧会话首次压缩把已有 archived 一并折入累加器（审查 S1）', () => {
    // 升级前的旧会话：已有归档但没有 archivedUsage。若首次压缩只折本次裁剪段，
    // 统计行（有累加器后忽略 archived）会丢掉历史归档用量。
    const oldArchived = [{role: 'user', ts: 1},
        {role: 'assistant', usage: {promptTokens: 600, completionTokens: 0, totalTokens: 600}}];
    const session = {archived: oldArchived.slice(), messages: [
        {role: 'user', ts: 2},
        {role: 'assistant', usage: {promptTokens: 120, completionTokens: 0, totalTokens: 120}},
    ], summary: null};
    const summary = buildCompactSummary('s', 2, null, 4);
    applyCompactToSession(session, summary, 2);
    assert.equal(session.archivedUsage.total, 720, '历史归档 600 + 本次裁剪 120，不能只剩 120');
    // 已有累加器时不重复折入旧 archived（幂等）
    const again = applyCompactToSession(session, summary, 0);
    assert.equal(session.archivedUsage.total, 720);
});

test('isAnchorUsage：新鲜 usage 可信，打标 / 缺失不可信', () => {
    assert.equal(isAnchorUsage({role: 'assistant', usage: {promptTokens: 5}}), true, '压缩后的新响应');
    assert.equal(isAnchorUsage({role: 'assistant', usage: {promptTokens: 5, preCompact: true}}), false);
    assert.equal(isAnchorUsage({role: 'assistant'}), false, '无 usage');
    assert.equal(isAnchorUsage(null), false);
});

test('stampPreCompactUsage：独立可用，非对象 usage 跳过', () => {
    const messages = [
        {role: 'assistant', usage: {totalTokens: 1}},
        {role: 'assistant', usage: null},
        {role: 'user'},
    ];
    stampPreCompactUsage(messages);
    assert.equal(messages[0].usage.preCompact, true);
    assert.equal(messages[1].usage, null);
    stampPreCompactUsage(null);
});

test('compactTranscriptOf：带上此前摘要与工具结果，超长从尾部保留', () => {
    const session = {
        summary: {text: '上一轮的摘要'},
        messages: [
            {role: 'user', content: '查依赖'},
            {role: 'tool', name: 'read_file', content: '文件内容'},
            {role: 'assistant', content: ''},
            {role: 'user', content: '继续', images: [{data: 'x'}]},
        ],
    };
    const text = compactTranscriptOf(session);
    assert.ok(text.includes('此前摘要：'));
    assert.ok(text.includes('上一轮的摘要'));
    assert.ok(text.includes('[工具 read_file 结果]'));
    assert.ok(text.includes('文件内容'));
    assert.ok(text.includes('（附图 1 张）'));
    // 空 assistant 不进转录（只留正文与工具）
    assert.ok(!/AI：\n\n/.test(text));
});

// 超窗时的兜底：转录按调用方给的预算截断（保留尾部），摘要请求才发得出去。
test('compactTranscriptOf：maxChars 生效，保留尾部并标截断', () => {
    const long = 'A'.repeat(5000) + 'B'.repeat(5000) + 'C'.repeat(5000);
    const session = {messages: [{role: 'user', content: long}]};
    const full = compactTranscriptOf(session);
    const capped = compactTranscriptOf(session, 4000);
    assert.ok(capped.length <= 4000 + 200, '截断后应接近给定预算：' + capped.length);
    assert.ok(capped.includes('较早内容已截断'));
    assert.ok(capped.endsWith('C'.repeat(1000)), '保留尾部（最近的内容）');
    assert.ok(full.length > capped.length);
    // 预算过低时至少留 2000 字符，避免摘要器什么也看不到
    assert.ok(compactTranscriptOf(session, 10).length >= 2000);
});

// 超窗截断的旧摘要：它是对更早历史的滚动累积，必须恒定留在头部。原来摘要与消息一起按
// 尾部截断，cap 被压小时旧摘要总被截掉——超窗压缩反而比正常压缩更容易「失忆」。
test('compactTranscriptOf：超窗截断仍保留头部旧摘要，总量受 cap 约束', () => {
    const session = {
        summary: {text: 'SHORT_SUMMARY'},
        messages: [{role: 'user', content: 'A'.repeat(5000) + 'RECENT_TAIL'}],
    };
    const capped = compactTranscriptOf(session, 4000);
    assert.ok(capped.includes('此前摘要：\nSHORT_SUMMARY'), '旧摘要必须留在头部');
    assert.ok(capped.endsWith('RECENT_TAIL'), '消息转录仍保留最近尾部');
    assert.ok(capped.includes('较早内容已截断'));
    assert.ok(capped.length <= 4000 + 200, '旧摘要计入预算：总量仍接近 cap：' + capped.length);
    // 旧摘要很长时也要保住它，但消息转录至少留 2000 字符（不能只剩旧摘要）
    const longSummary = {summary: {text: 'S'.repeat(9000)}, messages: [{role: 'user', content: 'M'.repeat(5000)}]};
    const capped2 = compactTranscriptOf(longSummary, 4000);
    assert.ok(capped2.includes('S'.repeat(9000)), '超长旧摘要完整保留');
    assert.ok(capped2.length >= 9000 + 2000, '消息转录保底 2000 字符');
});

test('buildCompactMessages：system 为摘要器约束，user 带焦点指令', () => {
    const session = {messages: [{role: 'user', content: 'x'}]};
    const messages = buildCompactMessages(session, '摘要约束', '保住补丁库方案');
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[0].content, '摘要约束');
    assert.ok(messages[1].content.startsWith('请压缩以下对话记录：'));
    assert.ok(messages[1].content.includes('用户压缩指令（摘要须优先落实）：保住补丁库方案'));
    // 无指令时不出现空标题
    assert.ok(!buildCompactMessages(session, 's', '')[1].content.includes('用户压缩指令'));
});

test('compactThresholdOf：默认 0.8，夹在 0.5–0.95', () => {
    assert.equal(compactThresholdOf({}), 0.8);
    assert.equal(compactThresholdOf({autoCompactThreshold: 0.2}), 0.5);
    assert.equal(compactThresholdOf({autoCompactThreshold: 0.99}), 0.95);
    assert.equal(compactThresholdOf({autoCompactThreshold: 0.7}), 0.7);
    assert.equal(compactThresholdOf(null), 0.8);
});
