// ai-subagents.test.mjs：子代理运行时的纯函数护栏（收件箱消费顺序 / 来源前缀 / 冷唤醒准入）。
// 闭包内的运行时（runSubRound、事件状态机）依赖 DOM 与网络，端到端行为靠手工回归清单；
// 这里锁住「改一处就会悄悄变味」的三条判定。
import test from 'node:test';
import assert from 'node:assert/strict';
import {takeInboxBatch, inboxMessageText, canReviveRecord, isStaleRecord, subAgentScopeOf, subScopeDowngrade, subTreeOwned, subTreeIdsOf, resolveWaitTimeoutSec, resolveSubAgentRounds, pendingInboxCount, waitWakeText, waitTimeoutText, agentDescendsFrom, parentSessionIdOf, agentMessageBlocks, agentRecordBlocks, agentTranscriptBlocks, agentBlockSig, agvToolDefaultCollapsed, agentViewTabName, agentViewRuntimeText, agentToolArgBrief, parseTranscriptLines, AI_INBOX_WAIT_MAX_SEC} from '../../../src/ai/agent/ai-subagents.js';

test('takeInboxBatch：插队（step）先于排队（turn），各自保持入队顺序', () => {
    const inbox = {
        step: [{text: '紧急 A'}, {text: '紧急 B'}],
        turn: [{text: '排队 1'}, {text: '排队 2'}],
        ask: null,
    };
    const batch = takeInboxBatch(inbox);
    assert.deepEqual(batch.map((item) => item.text), ['紧急 A', '紧急 B', '排队 1', '排队 2']);
    // 消费即清空：同一批不会被下一轮重复注入
    assert.equal(inbox.step.length, 0);
    assert.equal(inbox.turn.length, 0);
    assert.equal(takeInboxBatch(inbox).length, 0);
});

test('takeInboxBatch：空收件箱与缺字段都安全', () => {
    assert.deepEqual(takeInboxBatch(null), []);
    assert.deepEqual(takeInboxBatch({}), []);
    assert.deepEqual(takeInboxBatch({step: [{text: 'x'}]}).length, 1);
});

test('inboxMessageText：三方来源前缀可辨（用户 / 上级代理 / 下级回报）', () => {
    assert.equal(inboxMessageText({text: '补充线索'}), '［上级代理消息］ 补充线索');
    assert.equal(inboxMessageText({text: '插一句', from: 'user'}), '［用户插话］ 插一句');
    // 嵌套时父是子代理：不能用「主代理」字眼，否则第 3 层会认错来源
    assert.equal(inboxMessageText({text: '已完成', from: 'subagent'}), '［下级代理回报］ 已完成');
    assert.equal(inboxMessageText(null), '［上级代理消息］ ');
});

test('canReviveRecord：done 可续，失败/停止/已回收都拒绝', () => {
    assert.deepEqual(canReviveRecord(null), {ok: false, reason: 'missing'});
    assert.deepEqual(canReviveRecord({state: 'error', session: {}}), {ok: false, reason: 'terminated'});
    assert.deepEqual(canReviveRecord({state: 'stopped', session: {}}), {ok: false, reason: 'terminated'});
    assert.deepEqual(canReviveRecord({state: 'done', continuable: false, session: null}), {ok: false, reason: 'recycled'});
    assert.deepEqual(canReviveRecord({state: 'done', continuable: true, session: null}), {ok: false, reason: 'recycled'});
    assert.deepEqual(canReviveRecord({state: 'done', continuable: true, session: {id: 'sub-1'}}), {ok: true, reason: ''});
});

test('isStaleRecord：唤醒前的记录算陈旧，唤醒后落账的不算', () => {
    // wait_agent 用它挡住「冷唤醒后立刻拿到上一轮结论」的误报（2026-11-15 实测缺陷）
    const cases = [
        ['无唤醒标记（普通终态记录）', {finishedAt: 1000}, false],
        ['空记录', null, false],
        ['唤醒晚于落账：陈旧', {revivedAt: 2000, finishedAt: 1000}, true],
        ['唤醒早于落账：新一轮已落账', {revivedAt: 1000, finishedAt: 2000}, false],
        // 同一毫秒按「已落账」处理：误判成陈旧会一直等到超时，代价更高
        ['同一毫秒：不算陈旧', {revivedAt: 1000, finishedAt: 1000}, false],
        ['缺 finishedAt 但有 revivedAt：陈旧', {revivedAt: 1000}, true],
        ['脏字符串按数字容错', {revivedAt: '2000', finishedAt: '1000'}, true],
    ];
    for (const [name, record, expected] of cases) {
        assert.equal(isStaleRecord(record), expected, name);
    }
});

// 子代理记录按任务树归属（wait_agent / agent_send / agent_stop / agent_compact 共用）：
// 别的会话的 agentId 不能被投递或停止。任一侧为空时放行（兼容旧记录）。
test('subTreeOwned：根会话不同拒绝，缺字段放行', () => {
    assert.equal(subTreeOwned('root-a', 'root-a'), true);
    assert.equal(subTreeOwned('root-a', 'root-b'), false, '别的会话的任务树一律拒绝');
    assert.equal(subTreeOwned('root-a', ''), true, '记录缺 rootSessionId（旧数据）放行');
    assert.equal(subTreeOwned('', 'root-b'), true, '调用方无会话（系统路径）放行');
    assert.equal(subTreeOwned(undefined, undefined), true);
});

test('subTreeIdsOf：按 parentSessionId 链展开整棵子树（含多级、不含根与兄弟）', () => {
    const subs = [
        {id: 'A', parentSessionId: 'main'},
        {id: 'A1', parentSessionId: 'A'},
        {id: 'A11', parentSessionId: 'A1'},
        {id: 'A111', parentSessionId: 'A11'},
        {id: 'A2', parentSessionId: 'A'},
        {id: 'B', parentSessionId: 'main'},
        {id: 'B1', parentSessionId: 'B'},
    ];
    assert.deepEqual(subTreeIdsOf(subs, 'A'), ['A1', 'A2', 'A11', 'A111']);
    assert.deepEqual(subTreeIdsOf(subs, 'A1'), ['A11', 'A111']);
    assert.deepEqual(subTreeIdsOf(subs, 'B'), ['B1']);
    assert.deepEqual(subTreeIdsOf(subs, 'main'), ['A', 'B', 'A1', 'A2', 'B1', 'A11', 'A111']);
    assert.deepEqual(subTreeIdsOf(subs, 'missing'), []);
    assert.deepEqual(subTreeIdsOf(null, 'A'), []);
    assert.deepEqual(subTreeIdsOf(subs, ''), []);
});

test('subTreeIdsOf：脏数据成环不死循环，非字符串 id 归一', () => {
    const cyclic = [
        {id: 'A', parentSessionId: 'B'},
        {id: 'B', parentSessionId: 'A'},
        {id: 'C', parentSessionId: 'A'},
    ];
    const ids = subTreeIdsOf(cyclic, 'A');
    assert.ok(ids.includes('C'));
    assert.ok(ids.length <= 2);
    assert.deepEqual(subTreeIdsOf([{id: 7, parentSessionId: 'A'}], 'A'), ['7']);
});

test('resolveWaitTimeoutSec：null / 空串 / false 不许变成「不限时」（会永久悬挂）', () => {
    // aiClampInt(null) 会给出 0，而 0 是不建 deadline 的「不限时」——工具调用会永不返回。
    assert.equal(resolveWaitTimeoutSec(null), 60, 'null 要回落默认，不能是 0');
    assert.equal(resolveWaitTimeoutSec(undefined), 60);
    assert.equal(resolveWaitTimeoutSec(''), 60, '空串同样不能当 0');
    assert.equal(resolveWaitTimeoutSec(false), 5, 'false=0 也要被抬到最短 5 秒，不能是不限时');
    assert.equal(resolveWaitTimeoutSec(0), 5, '显式 0 也抬到最短值：不再保留「不限时」');
    assert.equal(resolveWaitTimeoutSec(-30), 5);
    assert.equal(resolveWaitTimeoutSec('30'), 30, '数字字符串照常解析');
    assert.equal(AI_INBOX_WAIT_MAX_SEC, 1800, '上限常量应为 1800');
    assert.equal(resolveWaitTimeoutSec(9999), 1800, '上限钳到 AI_INBOX_WAIT_MAX_SEC（1800）');
    assert.equal(resolveWaitTimeoutSec('abc'), 60, '解析不了回落默认');
});

test('waitWakeText：按唤醒来源给不同的行动指令（排队不打扰等待，不会作为来源出现）', () => {
    // 插话：明确「无需结束本轮」——结束反而会把它降级成排队（fallbackSteerToQueue）
    const steer = waitWakeText('steer');
    assert.ok(steer.includes('插话'), '要点名来源是用户插话');
    assert.ok(steer.includes('无需结束本轮'), '插话不许指挥模型收轮');
    // 通知 / 子代理收件箱 / 无来源兜底：同一条通用文案（内容已随下一轮上下文注入）
    for (const source of ['notice', 'agent', '', undefined]) {
        const text = waitWakeText(source);
        assert.ok(text.includes('收件箱有新输入'), '通用文案要说明输入已在收件箱');
        assert.ok(text.includes('下一轮上下文注入'), '要说明注入时机');
        assert.ok(!text.includes('插话'), '通用文案不冒充插话');
    }
});

test('waitTimeoutText：有排队消息时在超时检查点提示，没有就保持原口径', () => {
    const base = waitTimeoutText(60, false);
    assert.ok(base.includes('等待超时（60s）'), '基础文案不变');
    assert.ok(!base.includes('排队'), '无排队消息不提示');

    const queued = waitTimeoutText(60, true);
    assert.ok(queued.startsWith(base), '提示追加在基础文案之后');
    assert.ok(queued.includes('排队的消息'), '要提示输入框有排队消息');
    assert.ok(queued.includes('结束本轮'), '给出出口：可结束本轮去接收');
    // 排队语义的核心约束：提示只能「建议」，不能像插话唤醒那样指挥（排队 = 不打扰）
    assert.ok(!queued.includes('立即结束'), '不许指挥模型立即收轮');
});

test('pendingInboxCount：只数会被轮边界注入的 step+turn，ask 不算', () => {
    assert.equal(pendingInboxCount(null), 0);
    assert.equal(pendingInboxCount({}), 0);
    assert.equal(pendingInboxCount({inbox: {step: [], turn: []}}), 0);
    assert.equal(pendingInboxCount({inbox: {step: [{text: 'a'}], turn: [{text: 'b'}, {text: 'c'}]}}), 3);
    // ask 由 answerSubAsk 就地落定，不进队列；算进来会让 wait_agent 误报「有新输入」
    assert.equal(pendingInboxCount({inbox: {step: [], turn: [], ask: {askId: 'x'}}}), 0);
});

test('agentDescendsFrom：只能发给自己的下级（排除自身 / 兄弟 / 祖先）', () => {
    // 任务树：main → A1 → A1-1 → A1-1-1；A1 → A1-2；main → B1
    const parents = {'A1': 'main', 'A1-1': 'A1', 'A1-1-1': 'A1-1', 'A1-2': 'A1', 'B1': 'main'};
    const lookup = (id) => parents[id] || '';
    assert.equal(agentDescendsFrom('A1-1', 'A1', lookup), true, '直接下级');
    assert.equal(agentDescendsFrom('A1-1-1', 'A1', lookup), true, '隔代下级');
    assert.equal(agentDescendsFrom('A1', 'A1', lookup), false, '自身必须排除（旧实现的坑）');
    assert.equal(agentDescendsFrom('A1-2', 'A1-1', lookup), false, '兄弟不行');
    assert.equal(agentDescendsFrom('A1', 'A1-1', lookup), false, '祖先不行（防互等 / 乱喊话）');
    assert.equal(agentDescendsFrom('B1', 'A1', lookup), false, '别的根分支不行');
    assert.equal(agentDescendsFrom('gone', 'A1', lookup), false, '记录被回收一律当不是我的');
    assert.equal(agentDescendsFrom('A1-1', '', lookup), false, '没有祖先会话时不放行');
    assert.equal(agentDescendsFrom('A1-1', 'A1', null), false, '缺 lookup 保守返回 false');
    // 脏数据成环不能死循环
    const cyclic = (id) => (id === 'X' ? 'Y' : (id === 'Y' ? 'X' : ''));
    assert.equal(agentDescendsFrom('X', 'Z', cyclic), false);
});

test('parentSessionIdOf：运行态优先，终态记录兜底', () => {
    const live = new Map([['a', {parentSessionId: 'main'}]]);
    const records = new Map([['b', {parentSessionId: 'a'}]]);
    assert.equal(parentSessionIdOf('a', live, records), 'main');
    assert.equal(parentSessionIdOf('b', live, records), 'a', '运行态查不到时退回记录');
    assert.equal(parentSessionIdOf('c', live, records), '', '都没有时返回空串');
    assert.equal(parentSessionIdOf('a', null, null), '');
});

test('resolveSubAgentRounds：配置缺省 → 内置 200；单次缺省 → 配置值；不许把「没给」当 3 轮', () => {
    // 与 resolveWaitTimeoutSec 同一个坑：aiClampInt(null) 会算成 0 再钳到下限
    // 2026-11-18 默认 50 → 200：多层审计里中间层 50 轮先饿死，孤儿结论没处投
    assert.equal(resolveSubAgentRounds(undefined, undefined), 200, '两者都缺省 = 内置默认');
    assert.equal(resolveSubAgentRounds(null, null), 200, 'null 要回落，不能变成 3');
    assert.equal(resolveSubAgentRounds('', ''), 200);
    assert.equal(resolveSubAgentRounds(undefined, 120), 120, '设置里的值生效');
    assert.equal(resolveSubAgentRounds(null, 120), 120, '单次没给就吃配置');
    assert.equal(resolveSubAgentRounds(30, 120), 30, '单次点名优先');
    assert.equal(resolveSubAgentRounds(1, 120), 3, '低于下限钳到 3');
    assert.equal(resolveSubAgentRounds(9999, 120), 200, '高于上限钳到 200');
    assert.equal(resolveSubAgentRounds(undefined, 9999), 200, '配置越界也钳');
    assert.equal(resolveSubAgentRounds(undefined, 1), 3, '配置低于下限钳到 3');
    assert.equal(resolveSubAgentRounds('80', 120), 80, '数字字符串照常解析');
    assert.equal(resolveSubAgentRounds('abc', 120), 120, '解析不了回落配置值');
});

test('subAgentScopeOf：权限档继承父会话，只读由工具白名单保证', () => {
    // 完全权限下子代理也必须能读工作区外文件——否则 spawn 出去做跨目录调研会被路径校验拦死
    assert.equal(subAgentScopeOf('full'), 'full');
    assert.equal(subAgentScopeOf('auto'), 'auto');
    assert.equal(subAgentScopeOf('edit'), 'edit');
    assert.equal(subAgentScopeOf('read'), 'read');
    // 历史会话 / 缺字段 / 脏数据：退回只读，不意外放大读取范围
    assert.equal(subAgentScopeOf(undefined), 'read');
    assert.equal(subAgentScopeOf(''), 'read');
    assert.equal(subAgentScopeOf('admin'), 'read');
});

// 子代理详情视图改成内容区标签页后，正文按「块 + 签名」增量渲染：块 key 决定复用，
// 签名决定重写。这两条错了就是「点开全空」或「图表每 300ms 重建」，所以单列护栏。

test('agentMessageBlocks：消息收敛成块，空白正文与未知角色不产生块', () => {
    const blocks = agentMessageBlocks([
        {role: 'user', content: '查出所有 TODO'},
        {role: 'assistant', content: '   '},   // 流式中间态：没有正文就不渲染
        {role: 'assistant', content: '  开始找  '},
        {role: 'tool', name: 'search_text', content: 'a.js:1', status: 'done'},
        {role: 'tool', name: 'read_file', content: '越界', status: 'error'},
        null,
    ]);
    assert.deepEqual(blocks.map((b) => b.kind), ['user', 'assistant', 'tool', 'tool']);
    assert.deepEqual(blocks.map((b) => b.key), ['m0', 'm2', 'm3', 'm4']);
    assert.equal(blocks[1].text, '开始找');   // 两端空白裁掉，避免纯空白抖动触发重渲染
    assert.equal(blocks[3].error, true);
    assert.deepEqual(agentMessageBlocks(null), []);
});

test('agentTranscriptBlocks：转录只收 assistant / tool，下标即 key', () => {
    const blocks = agentTranscriptBlocks([
        {role: 'assistant', text: '过程 1', live: true},
        {role: 'tool', name: 'list_dir', text: 'a\nb'},
        null,
    ]);
    assert.deepEqual(blocks.map((b) => b.key), ['t0', 't1']);
    assert.equal(blocks[1].name, 'list_dir');
    assert.deepEqual(agentTranscriptBlocks(null), []);
});

// 收尾/唤醒必须共用同一套块（key 同为 m<i>）：换成「摘要 + 转录」会整段换模型，
// 节点全删重建 → 滚动位置被钳走、图表卡片销毁（2026-11-16 实测缺陷）。
test('agentRecordBlocks：终态沿用消息块，摘要只在「不是最后一条正文」时补一张卡', () => {
    const messages = [
        {role: 'user', content: '查看 sample.json'},
        {role: 'assistant', content: '结论：结构完好'},
    ];
    const same = agentRecordBlocks(messages, ' 结论：结构完好 ');
    // 摘要就是最后一条 assistant 正文：不重复挂块（多一块会让收尾瞬间高度再抖一次）
    assert.deepEqual(same.map((b) => b.kind), ['user', 'assistant']);
    assert.deepEqual(same.map((b) => b.key), ['m0', 'm1']);
    // 摘要来自 note / 摘录：补一张 summary 卡，块仍在同一套 key 空间里追加
    const extra = agentRecordBlocks(messages, '（用户停止）仅完成一半');
    assert.deepEqual(extra.map((b) => b.kind), ['user', 'assistant', 'summary']);
    assert.deepEqual(extra.map((b) => b.key), ['m0', 'm1', 'summary']);
    assert.equal(extra[2].text, '（用户停止）仅完成一半');
    // 空摘要不挂卡；没有会话消息时也只有摘要卡
    assert.deepEqual(agentRecordBlocks(messages, '   ').map((b) => b.kind), ['user', 'assistant']);
    assert.deepEqual(agentRecordBlocks([], '只有摘要').map((b) => b.key), ['summary']);
    assert.deepEqual(agentRecordBlocks(null, ''), []);
});

test('agentBlockSig：正文追加即变，生成中与落定不同签名（占位→真实卡片）', () => {
    const base = {key: 'm1', kind: 'assistant', text: '```mermaid\ngraph TD;A-->B'};
    const grown = {...base, text: base.text + '\n```'};
    assert.notEqual(agentBlockSig(base, true), agentBlockSig(grown, true));
    // 同一份文本：流式（只占位）与落定（挂载卡片）必须不同，否则图永远停在占位
    assert.notEqual(agentBlockSig(base, true), agentBlockSig(base, false));
    // 类型与失败标记参与签名：同一文本切成工具行不能被复用
    assert.notEqual(agentBlockSig(base, false), agentBlockSig({...base, kind: 'tool'}, false));
    assert.notEqual(agentBlockSig({...base, kind: 'tool'}, false), agentBlockSig({...base, kind: 'tool', error: true}, false));
    // 只看尾部：长正文不会把签名字符串撑大
    const long = {kind: 'assistant', text: 'x'.repeat(5000) + 'TAIL'};
    assert.ok(agentBlockSig(long, false).length < 160);
});

test('agvToolDefaultCollapsed：长输出与噪声工具默认收起，短输出展开', () => {
    // 短输出的普通工具直接铺开
    assert.equal(agvToolDefaultCollapsed('read_file', 'a.js:1'), false);
    assert.equal(agvToolDefaultCollapsed('write_file', 'ok'), false);
    // 长输出默认收起（阈值 400）
    assert.equal(agvToolDefaultCollapsed('read_file', 'x'.repeat(400)), false, '正好 400 仍展开');
    assert.equal(agvToolDefaultCollapsed('read_file', 'x'.repeat(401)), true, '超过 400 收起');
    // 命令/搜索/列目录这类即使输出短也默认收起（多行噪声）
    for (const name of ['run_command', 'background_command', 'search_text', 'list_dir', 'glob', 'check_command']) {
        assert.equal(agvToolDefaultCollapsed(name, 'ok'), true, name + ' 应默认收起');
    }
    // 缺字段容错
    assert.equal(agvToolDefaultCollapsed(null, null), false);
    assert.equal(agvToolDefaultCollapsed(undefined, undefined), false);
});

test('agentViewTabName：状态前缀可辨，名字清洗，未知状态不加前缀', () => {
    assert.equal(agentViewTabName('调研子代理', 'running'), '⟳ 调研子代理');
    assert.equal(agentViewTabName('调研子代理', 'done'), '✓ 调研子代理');
    assert.equal(agentViewTabName('调研子代理', 'error'), '✕ 调研子代理');
    assert.equal(agentViewTabName('调研子代理', 'stopped'), '■ 调研子代理');
    assert.equal(agentViewTabName('调研子代理', ''), '调研子代理', '无状态不加前缀');
    assert.equal(agentViewTabName('  调研  子代理 ', 'done'), '✓ 调研 子代理', '空白折叠');
    assert.equal(agentViewTabName('', 'running'), '⟳ 子代理', '空名回退');
    assert.equal(agentViewTabName(null, null), '子代理');
});

test('agentViewRuntimeText：轮次 · 耗时 · token · 状态，缺字段跳过', () => {
    assert.equal(agentViewRuntimeText(null), '');
    assert.equal(agentViewRuntimeText({state: 'running', rounds: 3, ms: 12500, tokens: 55800}),
        '轮次 3 · 13s · 55.8k tok · 运行中');
    assert.equal(agentViewRuntimeText({state: 'done', rounds: 0, ms: 0, tokens: 0}), '已完成', '零值跳过只留状态');
    assert.equal(agentViewRuntimeText({state: 'error'}), '失败');
    assert.equal(agentViewRuntimeText({rounds: 2}), '轮次 2', '无状态只留轮次');
    // ms 至少显示 1s（运行中不足 1 秒时不显示 0s）
    assert.equal(agentViewRuntimeText({state: 'running', ms: 100}), '1s · 运行中');
});

test('agentToolArgBrief：取点名到对象的字段，畸形 JSON 与空值返回空串', () => {
    // path 优先于更靠后的 name：工具行标题要能一眼看出「读了哪个文件」
    assert.equal(agentToolArgBrief('{"name":"x","path":"src/main.js"}'), 'src/main.js');
    assert.equal(agentToolArgBrief('{"query":"spawn_agent"}'), 'spawn_agent');
    // 多行参数压成一行（标题是单行文本）
    assert.equal(agentToolArgBrief('{"pattern":"a\\n  b"}'), 'a b');
    // 超长截断，避免把整段任务描述塞进标题
    assert.equal(agentToolArgBrief(JSON.stringify({task: 'x'.repeat(200)})).length, 61);
    assert.equal(agentToolArgBrief('not json'), '');
    assert.equal(agentToolArgBrief('{}'), '');
    assert.equal(agentToolArgBrief(''), '');
    assert.equal(agentToolArgBrief('{"path":"   "}'), '');
});

test('subScopeDowngrade：只严不宽，父档更宽时降档生效', () => {
    // 降档生效：请求档比父档严
    assert.equal(subScopeDowngrade('full', 'auto'), 'auto');
    assert.equal(subScopeDowngrade('full', 'read'), 'read');
    assert.equal(subScopeDowngrade('auto', 'read'), 'read');
    assert.equal(subScopeDowngrade('auto', 'edit'), 'edit');
    assert.equal(subScopeDowngrade('edit', 'read'), 'read');
});

test('subScopeDowngrade：请求档比父档宽时被忽略（不升档红线）', () => {
    // 不升档：父档更严，请求更宽一律回退父档
    assert.equal(subScopeDowngrade('read', 'full'), 'read');
    assert.equal(subScopeDowngrade('read', 'auto'), 'read');
    assert.equal(subScopeDowngrade('read', 'edit'), 'read');
    assert.equal(subScopeDowngrade('edit', 'full'), 'edit');
    assert.equal(subScopeDowngrade('edit', 'auto'), 'edit');
    assert.equal(subScopeDowngrade('auto', 'full'), 'auto');
});

test('subScopeDowngrade：同档、缺省与非法值都回退父档', () => {
    // 同档：请求等于父档，原样返回
    for (const scope of ['read', 'edit', 'auto', 'full']) {
        assert.equal(subScopeDowngrade(scope, scope), scope);
    }
    // 缺省 / 非法：回退父档（继承）
    assert.equal(subScopeDowngrade('auto', undefined), 'auto');
    assert.equal(subScopeDowngrade('auto', null), 'auto');
    assert.equal(subScopeDowngrade('auto', ''), 'auto');
    assert.equal(subScopeDowngrade('auto', 'danger-full-access'), 'auto');
    assert.equal(subScopeDowngrade('auto', 'read-only'), 'auto');
    // 父档本身非法时先归一成 read，再降档仍 read
    assert.equal(subScopeDowngrade('weird', 'full'), 'read');
    assert.equal(subScopeDowngrade('weird', 'read'), 'read');
});

// 磁盘转录的格式契约（写盘在 finalizeSubAgent，读回在 loadAgentTranscriptFromDisk）：
// 坏行跳过、空行忽略、缺字段归一成空串，绝不因为一行坏了整段记录消失。
test('parseTranscriptLines：JSONL 解析，坏行跳过', () => {
    const text = [
        JSON.stringify({role: 'assistant', name: '', text: '开始'}),
        '',
        JSON.stringify({role: 'tool', name: 'read_file', text: '结果'}),
        'not-json',
        JSON.stringify({role: 'assistant'}),
    ].join('\n');
    const entries = parseTranscriptLines(text);
    assert.equal(entries.length, 3);
    assert.deepEqual(entries[0], {role: 'assistant', name: '', text: '开始'});
    assert.deepEqual(entries[1], {role: 'tool', name: 'read_file', text: '结果'});
    assert.deepEqual(entries[2], {role: 'assistant', name: '', text: ''}, '缺字段归一成空串');
    assert.deepEqual(parseTranscriptLines(''), []);
    assert.deepEqual(parseTranscriptLines(null), []);
});
