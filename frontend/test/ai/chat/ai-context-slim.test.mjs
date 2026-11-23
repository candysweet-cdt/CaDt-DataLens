// ai-context-slim.test.mjs：实时瘦身纯判定的护栏。
// 锁住两类「改了就悄悄裁错」的行为：轮次口径（注入类消息不推保留窗口）与
// 大工具结果处理（跳过表 / 阈值 / 头尾预算 / 指针文案）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isRealUserTurn,
    recentTurnStart,
    pruneToolResult,
    spillWanted,
    spillPointerText,
    slimToolResult,
    pruneThresholdOf,
    foldSupersededToolCalls,
    foldedToolArguments,
    underContextPressure,
    recentToolIndexes,
    slimBreakdownParts,
    shouldInsertShrinkNote,
    SLIM_KEEP_TURNS,
    SLIM_PRUNE_THRESHOLD,
    SLIM_EXTERNAL_PRUNE_THRESHOLD,
    SLIM_ARGS_FOLD_THRESHOLD,
    SLIM_HEAD_CHARS,
    SLIM_SKIP_TOOLS,
    SHRINK_NOTE_COOLDOWN_MS,
} from '../../../src/ai/chat/ai-context-slim.js';

const msg = (role, extra) => Object.assign({role, content: role}, extra || {});
const user = (extra) => msg('user', extra);

// ---------- 轮次口径 ----------

test('isRealUserTurn：只有用户亲手键入的消息算一轮', () => {
    assert.equal(isRealUserTurn(user()), true);
    assert.equal(isRealUserTurn(user({turnStartedAt: 1})), true);
    assert.equal(isRealUserTurn(msg('assistant')), false);
    assert.equal(isRealUserTurn(msg('tool')), false);
    assert.equal(isRealUserTurn(null), false);
});

test('isRealUserTurn：四类注入一律不计轮', () => {
    assert.equal(isRealUserTurn(user({systemNote: true})), false, '轮次提醒 / 待办检查');
    assert.equal(isRealUserTurn(user({steer: true})), false, '插话是本轮补充指示');
    assert.equal(isRealUserTurn(user({notice: true})), false, '信箱折叠（子代理结算 / 计时器到点忙时）');
    assert.equal(isRealUserTurn(user({app: {kind: 'app'}})), false, '应用发起 / 后台唤醒轮');
    assert.equal(isRealUserTurn(user({app: {kind: 'read-image'}, images: [{data: 'x'}]})), false,
        '工具中途自动附加的图片');
});

test('recentTurnStart：保留最近 2 轮，第 3 条真实用户轮之后起裁', () => {
    const messages = [user(), msg('assistant'), user(), msg('assistant'),
        user(), msg('assistant'), user(), msg('assistant')];
    // 真实轮在下标 0/2/4/6：倒数第 3 条是下标 2 → recentStart = 3
    assert.equal(recentTurnStart(messages), 3);
    assert.equal(SLIM_KEEP_TURNS, 2);
});

test('recentTurnStart：不足 3 轮返回 0（全保留）', () => {
    assert.equal(recentTurnStart([user(), msg('assistant'), user()]), 0);
    assert.equal(recentTurnStart([]), 0);
    assert.equal(recentTurnStart([msg('assistant'), msg('tool')]), 0);
});

test('recentTurnStart：注入消息不推窗——连续自主过程整段保留', () => {
    // 1 条真实用户轮 + 一长串自主过程（自动附图 / 信箱折叠 / 唤醒轮 / 插话 / 系统注记）：
    // 旧口径会把 recentStart 推到过程尾部、裁掉仍在用的上下文；新口径必须全保留。
    const messages = [
        user(), msg('assistant'), msg('tool'),
        user({app: {kind: 'read-image'}, images: [{data: 'x'}]}),
        msg('assistant'), msg('tool'),
        user({notice: true}),
        msg('assistant'),
        user({app: {kind: 'timer-wake'}}),
        msg('assistant'),
        user({steer: true}),
        user({systemNote: true}),
        msg('assistant'),
    ];
    assert.equal(recentTurnStart(messages), 0);
});

test('recentTurnStart：注入密集时真实轮仍正确计数', () => {
    const messages = [
        user(), msg('assistant'),
        user({notice: true}), user({app: {kind: 'app'}}),
        user(), msg('assistant'),
        user({steer: true}),
        user(), msg('assistant'),
        user({systemNote: true}),
    ];
    // 真实轮在下标 0 / 4 / 7：倒数第 3 条是下标 0 → recentStart = 1
    assert.equal(recentTurnStart(messages), 1);
});

test('recentTurnStart：limit 之后的消息不参与判定', () => {
    const messages = [user(), msg('assistant'), user(), msg('assistant'), user(), msg('assistant')];
    assert.equal(recentTurnStart(messages, 4), 0, '只看前 4 条时只有 2 轮');
    assert.equal(recentTurnStart(messages, 5), 1, '前 5 条含 3 轮，倒数第 3 轮在下标 0');
    assert.equal(recentTurnStart(messages, null), 1);
});

// ---------- 大工具结果修剪 ----------

const bigText = (chars) => 'A'.repeat(chars);

test('spillWanted：跳过表内不处理；内置 8 K、外部工具（MCP/插件）50 K 两档阈值', () => {
    // 跳过表：自带窗口或不可重得的操作回执
    for (const name of SLIM_SKIP_TOOLS) {
        assert.equal(spillWanted(name, bigText(200000)), false, name + ' 不该被处理');
    }
    assert.ok(SLIM_SKIP_TOOLS.includes('read_file'), 'read_file 自带行窗口，必须跳过');
    assert.ok(SLIM_SKIP_TOOLS.includes('write_file'), '写入回执不该被落盘');
    // 曾经的漏洞：MCP 工具不在白名单里 → 553 K 回显原样进上下文
    assert.equal(spillWanted('mcp__aoci__aoci_update_entry', bigText(60000)), true, 'MCP 超大结果必须处理');
    assert.equal(spillWanted('mcp__aoci__aoci_update_entry', bigText(20000)), false,
        'MCP 的中等结果（8–50 K）留在上下文，落盘再读回要多花一轮');
    assert.equal(spillWanted('mcp__aoci__aoci_maintain', bigText(SLIM_EXTERNAL_PRUNE_THRESHOLD)), false, '恰好 50 K 不处理');
    assert.equal(spillWanted('mcp__aoci__aoci_maintain', bigText(SLIM_EXTERNAL_PRUNE_THRESHOLD + 1)), true);
    // 第三方插件工具同档（返回体量同样不受我们控制）
    assert.equal(spillWanted('plugin__foo', bigText(20000)), false);
    assert.equal(spillWanted('plugin__foo', bigText(SLIM_EXTERNAL_PRUNE_THRESHOLD + 1)), true);
    // 内置工具仍是 8 K
    assert.equal(spillWanted('list_dir', bigText(SLIM_PRUNE_THRESHOLD + 1)), true);
    assert.equal(spillWanted('web_fetch', bigText(SLIM_PRUNE_THRESHOLD)), false, '恰好等于阈值不处理');
    assert.equal(spillWanted('web_fetch', ''), false);
    assert.equal(spillWanted('web_fetch', null), false);
    // 前缀判定：mcp__ / plugin__ 走宽档，其余走窄档
    assert.equal(pruneThresholdOf('mcp__x__y'), SLIM_EXTERNAL_PRUNE_THRESHOLD);
    assert.equal(pruneThresholdOf('plugin__x'), SLIM_EXTERNAL_PRUNE_THRESHOLD);
    assert.equal(pruneThresholdOf('web_fetch'), SLIM_PRUNE_THRESHOLD);
    assert.equal(pruneThresholdOf(''), SLIM_PRUNE_THRESHOLD);
});

test('pruneToolResult：头 4096 + 尾 1024，中段打标记', () => {
    const text = 'H'.repeat(5000) + 'M'.repeat(5000) + 'T'.repeat(5000);
    const pruned = pruneToolResult('web_fetch', text);
    assert.ok(pruned.startsWith('H'.repeat(SLIM_HEAD_CHARS)));
    assert.ok(pruned.endsWith('T'.repeat(1024)));
    assert.ok(!pruned.includes('M'), '中段必须被裁掉');
    assert.ok(pruned.includes('原文 15000 字符'));
    assert.ok(pruned.includes('不要凭记忆引用被修剪的中段内容'), '标记必须禁止凭记忆引用中段');
    assert.ok(pruned.includes('重新调用该工具获取'));
    assert.ok(pruned.length < text.length);
    assert.equal(pruneToolResult('read_file', bigText(20000)), null, '跳过表内的工具不修剪');
});

test('pruneToolResult：命令类尾部预算放宽到 2048', () => {
    const text = bigText(9000) + 'Z'.repeat(3000);
    for (const name of ['run_command', 'background_command']) {
        const pruned = pruneToolResult(name, text);
        assert.ok(pruned.endsWith('Z'.repeat(2048)), name + ' 尾部应保留 2048');
    }
    const fetch = pruneToolResult('web_fetch', text);
    assert.ok(fetch.endsWith('Z'.repeat(1024)), '非命令类仍是 1024');
});

test('spillPointerText：头 + 路径 + 原文长度 + 尾', () => {
    const text = 'H'.repeat(5000) + 'M'.repeat(5000) + 'T'.repeat(3000);
    const path = 'C:/Users/x/AppData/Roaming/CandySweet/CaDt-DataLens/ai-artifacts/session-1/call-1.txt';
    const out = spillPointerText('web_fetch', text, path);
    assert.ok(out.startsWith('H'.repeat(SLIM_HEAD_CHARS)));
    assert.ok(out.includes('原文 13000 字符'));
    assert.ok(out.includes(path), '必须给出可读回的绝对路径');
    assert.ok(out.includes('read_file'), '必须告诉模型怎么读回来');
    assert.ok(out.includes('不需要就别读'), '必须告诉模型什么时候不必回读');
    assert.ok(out.endsWith('T'.repeat(1024)));
    assert.ok(!out.includes('M'), '中段不进上下文');
});

test('slimToolResult：有落盘路径给指针，没有就退回修剪', () => {
    const text = bigText(20000);
    assert.equal(slimToolResult('web_fetch', text, ''), pruneToolResult('web_fetch', text));
    const pointed = slimToolResult('web_fetch', text, 'D:/a/call-1.txt');
    assert.ok(pointed.includes('D:/a/call-1.txt'));
    assert.equal(slimToolResult('read_file', text, 'D:/a/call-1.txt').includes('D:/a/call-1.txt'), true,
        '落盘过的结果即使工具在跳过表里也按指针发（写盘发生在判定之前）');
});

// ---------- 过期工具参数折叠 ----------

const callMsg = (id, name, args) => ({role: 'assistant', content: '', toolCalls: [{id, name, arguments: args}]});
const toolMsg = (id, name, content, status = 'done') => ({role: 'tool', toolCallId: id, name, content, status});
const bigArgs = () => JSON.stringify({entries: 'x'.repeat(SLIM_ARGS_FOLD_THRESHOLD + 100)});
const ROLLBACK = '{"status":"repair_required","applied":0,"remaining":37}';
const APPLIED = '{"status":"applied","applied":37,"remaining":0}';

test('foldSupersededToolCalls：整批退回 + 后续同名调用成功才折叠', () => {
    // ① 退回 → 后续成功：折叠
    const ok = foldSupersededToolCalls([
        callMsg('c1', 'mcp__aoci__aoci_update_entry', bigArgs()),
        toolMsg('c1', 'mcp__aoci__aoci_update_entry', ROLLBACK),
        callMsg('c2', 'mcp__aoci__aoci_update_entry', bigArgs()),
        toolMsg('c2', 'mcp__aoci__aoci_update_entry', APPLIED),
    ]);
    assert.deepEqual([...ok], ['c1']);
    // ② 退回 → 后续也退回：不折叠（旧参数还是下一轮重发的底稿）
    const stillFailing = foldSupersededToolCalls([
        callMsg('c1', 't', bigArgs()),
        toolMsg('c1', 't', ROLLBACK),
        callMsg('c2', 't', bigArgs()),
        toolMsg('c2', 't', ROLLBACK),
    ]);
    assert.equal(stillFailing.size, 0);
    // ③ 成功批次：不折叠
    assert.equal(foldSupersededToolCalls([
        callMsg('c1', 't', bigArgs()),
        toolMsg('c1', 't', APPLIED),
        callMsg('c2', 't', bigArgs()),
        toolMsg('c2', 't', APPLIED),
    ]).size, 0);
    // ④ 参数没超门槛：不折叠
    assert.equal(foldSupersededToolCalls([
        callMsg('c1', 't', '{"a":1}'),
        toolMsg('c1', 't', ROLLBACK),
        callMsg('c2', 't', bigArgs()),
        toolMsg('c2', 't', APPLIED),
    ]).size, 0);
    // ⑤ 同名但不是同一工具：不折叠
    assert.equal(foldSupersededToolCalls([
        callMsg('c1', 'a', bigArgs()),
        toolMsg('c1', 'a', ROLLBACK),
        callMsg('c2', 'b', bigArgs()),
        toolMsg('c2', 'b', APPLIED),
    ]).size, 0);
});

test('foldSupersededToolCalls：stopped 也算整批未接收，两种 JSON 空格都认', () => {
    const stopped = '{"status": "stopped", "applied": 0}';
    const out = foldSupersededToolCalls([
        callMsg('c1', 't', bigArgs()),
        toolMsg('c1', 't', stopped),
        callMsg('c2', 't', bigArgs()),
        toolMsg('c2', 't', APPLIED),
    ]);
    assert.deepEqual([...out], ['c1']);
});

test('foldedToolArguments：说明原因与原长度，并禁止复用', () => {
    const text = foldedToolArguments(44156);
    const parsed = JSON.parse(text);
    assert.ok(parsed.note.includes('44156'));
    assert.ok(parsed.note.includes('整批未接收'));
    assert.ok(parsed.note.includes('不要复用'));
    assert.ok(text.length < 300);
});

// ---------- 应急收缩 ----------

test('underContextPressure：≥90% 才算压力，窗口未知恒 false', () => {
    assert.equal(underContextPressure(90, 100), true);
    assert.equal(underContextPressure(95, 100), true);
    assert.equal(underContextPressure(89, 100), false);
    assert.equal(underContextPressure(1000, 0), false, '窗口未知（未配模型）时不启用');
    assert.equal(underContextPressure(NaN, 100), false);
});

test('recentToolIndexes：只数已落定的工具结果，取最近 N 个', () => {
    const messages = [
        {role: 'user', content: 'x'},
        {role: 'tool', toolCallId: 'a', status: 'done'},
        {role: 'tool', toolCallId: 'b', status: 'done'},
        {role: 'assistant', content: ''},
        {role: 'tool', toolCallId: 'c', status: 'running'},
        {role: 'tool', toolCallId: 'd', status: 'error'},
    ];
    // 保留 2 个：最近的 done/error（d、b），running 的 c 不算
    assert.deepEqual([...recentToolIndexes(messages, messages.length, 2)].sort((x, y) => x - y), [2, 5]);
    assert.equal(recentToolIndexes(messages, messages.length, 0).size, 0);
    assert.equal(recentToolIndexes(messages, 2, 5).size, 1, 'limit 之外的不算');
});

// ---------- 已省量分类明细 ----------

test('slimBreakdownParts：固定顺序、过滤零项、坏值归零', () => {
    const parts = slimBreakdownParts({reasoning: 62000, transient: 30000, notes: 0, toolPrune: 9000});
    assert.deepEqual(parts.map((p) => p.key), ['reasoning', 'transient', 'toolPrune']);
    assert.deepEqual(parts.map((p) => p.label), ['旧轮思考', '重复注入', '工具结果中段']);
    assert.deepEqual(slimBreakdownParts({}), []);
    assert.deepEqual(slimBreakdownParts(null), []);
    assert.deepEqual(slimBreakdownParts({reasoning: -5, transient: 'x'}), []);
});

// ---------- 应急收缩留痕判定 ----------

test('shouldInsertShrinkNote：从未记过即记（含坏值归零）', () => {
    assert.equal(shouldInsertShrinkNote(0, 1000, 1000), true);
    assert.equal(shouldInsertShrinkNote(undefined, 1000, 1000), true);
    assert.equal(shouldInsertShrinkNote(null, 1000, 1000), true);
    assert.equal(shouldInsertShrinkNote(-1, 1000, 1000), true);
});

test('shouldInsertShrinkNote：冷却期内不记，期满与越界再记', () => {
    const cooldown = 30 * 60 * 1000;
    assert.equal(shouldInsertShrinkNote(1000, 1000 + cooldown - 1, cooldown), false);
    assert.equal(shouldInsertShrinkNote(1000, 1000 + cooldown, cooldown), true);
    assert.equal(shouldInsertShrinkNote(1000, 1000 + cooldown * 3, cooldown), true);
});

test('shouldInsertShrinkNote：冷却参数缺省用内置值', () => {
    assert.equal(shouldInsertShrinkNote(1000, 1000 + SHRINK_NOTE_COOLDOWN_MS - 1), false);
    assert.equal(shouldInsertShrinkNote(1000, 1000 + SHRINK_NOTE_COOLDOWN_MS), true);
});