// ai-group-model.test.mjs：群 meta 归一化（§6.2）、调用估算（§3.4）、创建前预检（§3.16）
// 与内置主持人模板护栏。方案 docs/finished-plans/ai-group-chat.md。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
    BUILTIN_CHAIR,
    GROUP_MEMBER_MAX,
    TIMEOUT_PRESETS,
    buildGroupDraft,
    deriveMaxSpeeches,
    estimateDiscussionCalls,
    isUnlimitedRounds,
    maxRoundsOf,
    normalizeGroupMeta,
    normalizeGroupMode,
    preflightGroup,
    relayWakes,
    resolveChairModel,
} from '../../../src/ai/group/ai-group-model.js';
import {agentsUpsert, normalizeAgents} from '../../../src/ai/agent/ai-agent-model.js';

const profiles = [
    {
        id: 'p1', name: '大窗账号', provider: 'openai', models: [
            {id: 'm1', model: 'big-1m', contextWindow: 1048576, outputWindow: 8192, reasoningEffort: '', thinking: false},
        ],
    },
    {
        id: 'p2', name: '小窗账号', provider: 'openai', models: [
            {id: 'm1', model: 'small-32k', contextWindow: 32768, outputWindow: 4096, reasoningEffort: '', thinking: false},
        ],
    },
];

const agents = [
    {id: 'a1', name: '架构师', color: 'blue', role: '设计', modelRef: 'p1|m1', personaText: '', chair: false, enabled: true},
    {id: 'a2', name: '审查员', color: 'red', role: '审查', modelRef: 'p2|m1', personaText: '人'.repeat(2000), chair: false, enabled: true},
    {id: 'a3', name: '主持人', color: 'violet', role: '主持', modelRef: 'p1|m1', personaText: '', chair: true, enabled: true},
];

test('normalizeGroupMeta：默认值与钳制', () => {
    const meta = normalizeGroupMeta({});
    assert.equal(meta.v, 2);
    assert.equal(meta.kind, 'group');
    assert.equal(meta.mode, 'roundtable');
    assert.equal(meta.goal, 'explore');
    // G6：默认 5 轮（0 = 不限轮次），不再钳死 1–3
    assert.equal(meta.maxRounds, 5);
    assert.equal(meta.maxSpeeches, 12);
    assert.equal(meta.roundMode, 'sequential');
    assert.equal(meta.timeouts.memberTotalMs, 180000);
    assert.equal(meta.timeouts.chairThinkingMs, 240000);
    assert.equal(meta.chair.kind, 'ai');
    assert.equal(meta.chair.policy, 'round-plan');
    assert.deepEqual(meta.discussion.agenda, []);
    assert.equal(meta.sharedSummary, null);
    // 非法值回默认；轮数上限 20、0 = 不限
    const bad = normalizeGroupMeta({maxRounds: 21, maxSpeeches: -5, goal: 'nope', mode: 'nope', roundMode: 'nope', timeouts: {memberTotalMs: -1}});
    assert.equal(bad.maxRounds, 20);
    assert.equal(bad.maxSpeeches, 1);
    assert.equal(bad.goal, 'explore');
    assert.equal(bad.mode, 'roundtable');
    assert.equal(bad.roundMode, 'sequential');
    assert.equal(bad.timeouts.memberTotalMs, 180000);
    assert.equal(normalizeGroupMeta({maxRounds: 0}).maxRounds, 0);
    assert.equal(normalizeGroupMeta({maxRounds: 9}).maxRounds, 9);
    // 老群（轮数 1–3）原样保留
    assert.equal(normalizeGroupMeta({maxRounds: 2}).maxRounds, 2);
    // 成员截断到上限
    const many = normalizeGroupMeta({memberIds: Array.from({length: GROUP_MEMBER_MAX + 3}, (_, i) => 'a' + i)});
    assert.equal(many.memberIds.length, GROUP_MEMBER_MAX);
    // 侧栏预览截断（G6）
    assert.equal(normalizeGroupMeta({lastPreview: 'x'.repeat(300)}).lastPreview.length, 100);
});

test('maxRoundsOf / deriveMaxSpeeches / estimateDiscussionCalls（G6 轮次预算）', () => {
    assert.equal(maxRoundsOf({maxRounds: 0}), Infinity);
    assert.equal(maxRoundsOf({maxRounds: 20}), 20);
    assert.equal(maxRoundsOf({}), Infinity);
    assert.equal(maxRoundsOf({maxRounds: 2}), 2);
    assert.equal(isUnlimitedRounds({maxRounds: 0}), true);
    assert.equal(isUnlimitedRounds({maxRounds: 5}), false);
    // 5 人 5 轮 = 25 次发言，不再被固定 12 截断
    assert.equal(deriveMaxSpeeches(5, 5), 25);
    // 2 人 3 轮 → 12 下限兜底
    assert.equal(deriveMaxSpeeches(2, 3), 12);
    // 8 人 20 轮 → 160；超上限的轮数先被钳到 20 再推导
    assert.equal(deriveMaxSpeeches(8, 20), 160);
    assert.equal(deriveMaxSpeeches(8, 40), 160);
    // 不限轮次 → 默认 100
    assert.equal(deriveMaxSpeeches(5, 0), 100);
    // 不限轮次（rounds=0）按发言上限折算：5 人 100 次 → 有效 20 轮做主持开销
    assert.equal(estimateDiscussionCalls(5, 0, 'round-plan', 100), 100 + 2 * 20 + 1);
});

test('normalizeDiscussion：floorRequests 持久化（G6 看板重开不丢）', () => {
    const meta = normalizeGroupMeta({
        discussion: {
            floorRequests: [{from: 'a1', fromName: '架构师', to: '主持人', reason: '需要目录', ts: 123}],
        },
    });
    assert.equal(meta.discussion.floorRequests.length, 1);
    assert.equal(meta.discussion.floorRequests[0].from, 'a1');
    // 轮次号上限放宽（不限轮次时可一直涨）
    assert.equal(normalizeGroupMeta({discussion: {round: 500}}).discussion.round, 500);
});

test('estimateDiscussionCalls：round-plan 13 / adaptive 17（4 成员 × 2 轮，§3.4）', () => {
    assert.equal(estimateDiscussionCalls(4, 2, 'round-plan'), 13);
    assert.equal(estimateDiscussionCalls(4, 2, 'adaptive'), 17);
    assert.equal(estimateDiscussionCalls(3, 1, 'round-plan'), 3 + 2 + 1);
});

test('preflightGroup：大窗绿 / 小窗红 / 人设超长黄', () => {
    const items = preflightGroup({agents, profiles, memberIds: ['a1', 'a2'], sharedTokens: 0, boardTokens: 1200});
    assert.equal(items.length, 2);
    // a1：900 + 0 + 1200 = 2100 / (1M - 8192 - 2048) → 远小于 70% 绿
    assert.equal(items[0].level, 'green');
    // a2：900 + ~1500 + 1200 = 3600 / (32768 - 4096 - 2048 = 26624) ≈ 13.5% → 也绿（窗口按 32K 算仍装得下）
    assert.equal(items[1].level, 'green');
    // 共享对话推高后小窗变红、大窗仍绿
    const stressed = preflightGroup({agents, profiles, memberIds: ['a1', 'a2'], sharedTokens: 90000, boardTokens: 4096});
    assert.equal(stressed[0].level, 'green');
    assert.equal(stressed[1].level, 'red');
    assert.match(stressed[1].detail, /停止参与/);
});

test('preflightGroup：模型不可用 / 已删除成员', () => {
    const items = preflightGroup({agents, profiles, memberIds: ['ghost', 'a1'], sharedTokens: 0, boardTokens: 1200});
    assert.equal(items[0].level, 'red');
    assert.equal(items[0].name, '已删除成员');
    const broken = preflightGroup({agents: [{...agents[1], modelRef: 'p2|ghost'}], profiles, memberIds: ['a2'], sharedTokens: 0, boardTokens: 1200});
    assert.equal(broken[0].level, 'red');
    assert.match(broken[0].detail, /模型不可用/);
});

test('BUILTIN_CHAIR 能通过 agentsUpsert 校验（一键创建默认主持人）', () => {
    const list = [];
    const result = agentsUpsert(list, {...BUILTIN_CHAIR, modelRef: ''}, () => 'chair-id');
    assert.equal(result.ok, true);
    assert.equal(list[0].chair, true);
    assert.equal(list[0].name, '主持人');
    // 重复创建被名字唯一性拦下
    const again = agentsUpsert(list, {...BUILTIN_CHAIR, modelRef: ''}, () => 'chair-2');
    assert.equal(again.ok, false);
    assert.match(again.error, /重名/);
});

test('resolveChairModel：AI 主持指向智能体 / user 主持为 null / 失效为 null', () => {
    const meta = normalizeGroupMeta({chair: {kind: 'ai', agentId: 'a3'}});
    assert.equal(resolveChairModel(meta, agents).id, 'a3');
    const userChair = normalizeGroupMeta({chair: {kind: 'user'}});
    assert.equal(resolveChairModel(userChair, agents), null);
    const ghost = normalizeGroupMeta({chair: {kind: 'ai', agentId: 'ghost'}});
    assert.equal(resolveChairModel(ghost, agents), null);
});

test('TIMEOUT_PRESETS：宽松档整体大于标准档', () => {
    for (const key of Object.keys(TIMEOUT_PRESETS.standard.timeouts)) {
        assert.ok(TIMEOUT_PRESETS.lenient.timeouts[key] > TIMEOUT_PRESETS.standard.timeouts[key], key);
    }
});

// ==================== G2：上下文组装（§7.1） / 折叠（§3.11） / 超时档（§3.12） ====================
import {
    buildMemberMessages,
    foldPrivateSteps,
    GROUP_RULES_TEXT,
    memberTimeouts,
    outputLanguageRuleText,
} from '../../../src/ai/group/ai-group-model.js';

const member = agents[0];
const groupMeta = normalizeGroupMeta({id: 'g1', title: '评审', topic: '存储', memberIds: ['a1', 'a2'], goal: 'decide'});

const sharedMessages = [
    {gid: 'gm-u1', role: 'user', content: '议题背景'},
    {gid: 'gm-1', role: 'assistant', agentId: 'a2', agentName: '审查员', content: '我反对', status: 'done'},
    {gid: 'gm-2', role: 'assistant', agentId: 'a1', agentName: '架构师', content: '我支持', status: 'done'},
    {gid: 'gm-x', role: 'assistant', agentId: 'a1', agentName: '架构师', content: '', status: 'error', error: '超时'},
];

test('buildMemberMessages：全量共享对话 + 角色映射 + 尾巴 user 收尾', () => {
    const built = buildMemberMessages({
        member,
        group: groupMeta,
        sharedMessages,
        ownSteps: [{gid: 'gm-2', steps: [{kind: 'thinking', text: '我的思考', signature: 'sig-1'}]}],
        participantsText: '用户：…\n- 审查员：审查',
        boardText: '',
        focus: '回应审查员',
        outputLanguage: 'zh',
        memberWindow: 100000,
    });
    assert.equal(built.messages[0].role, 'system');
    assert.match(built.messages[0].content, /<group_rules>/);
    assert.match(built.messages[0].content, /<chair_focus>\n回应审查员/);
    assert.match(built.messages[0].content, /<participants>/);
    // 他人消息：user + 名字前缀（连续同角色合并进同一 user 段）；无 error 空消息进上下文；自己消息 assistant + thinking 水合
    const dialogue = built.messages.map((m) => m.content || '').join('\n');
    assert.ok(dialogue.includes('[审查员] 我反对'));
    assert.ok(dialogue.includes('[用户] 议题背景'));
    const own = built.messages.find((m) => m.role === 'assistant');
    assert.equal(own.content, '我支持');
    assert.equal(own.thinking, '我的思考');
    assert.equal(own.thinkingSignature, 'sig-1');
    // 上下文里没有模型元数据（模型名/耗时），只有观点
    assert.ok(!built.messages.some((m) => (m.content || '').includes('done')));
    assert.equal(built.overflow, false);
});

test('buildMemberMessages：连续同角色合并为一段 user；尾巴并入其中且仍是 user 结尾', () => {
    const built = buildMemberMessages({
        member,
        group: groupMeta,
        sharedMessages: [
            {gid: 'u1', role: 'user', content: '一'},
            {gid: 'u2', role: 'user', content: '二'},
            {gid: 'a1', role: 'assistant', agentId: 'a2', agentName: '审查员', content: '甲', status: 'done'},
            {gid: 'a2', role: 'assistant', agentId: 'a2', agentName: '审查员', content: '乙', status: 'done'},
        ],
        ownSteps: [],
        participantsText: '',
        boardText: '',
        focus: '',
        outputLanguage: 'zh',
        memberWindow: 100000,
    });
    // system + 全部对话合并为一段 user（部分提供商拒绝连续同角色）
    assert.equal(built.messages.length, 2);
    assert.equal(built.messages[0].role, 'system');
    const blob = built.messages[1].content;
    assert.ok(blob.includes('一') && blob.includes('二'));
    assert.ok(blob.includes('[审查员] 甲') && blob.includes('[审查员] 乙'));
    assert.ok(blob.includes('轮到你'));
    assert.equal(built.messages[1].role, 'user');
});

test('buildMemberMessages：sharedSummary + cutoff（手动压缩语义）', () => {
    const withSummary = normalizeGroupMeta({
        ...groupMeta,
        sharedSummary: {text: '此前讨论摘要', cutoffGid: 'gm-1', createdAt: 1, createdBy: 'user', summarizerModel: 'x'},
    });
    const built = buildMemberMessages({
        member,
        group: withSummary,
        sharedMessages: [
            {gid: 'gm-old', role: 'user', content: '被摘要覆盖的旧消息'},
            {gid: 'gm-1', role: 'user', content: 'cutoff 边界'},
            {gid: 'gm-2', role: 'assistant', agentId: 'a2', agentName: '审查员', content: 'cutoff 之后', status: 'done'},
        ],
        ownSteps: [],
        participantsText: '',
        boardText: '',
        focus: '',
        outputLanguage: 'zh',
        memberWindow: 100000,
    });
    const all = built.messages.map((m) => m.content || '').join('\n');
    assert.ok(all.includes('此前讨论摘要'));
    assert.ok(all.includes('cutoff 之后'));
    assert.ok(!all.includes('被摘要覆盖的旧消息'));
});

test('buildMemberMessages：小窗口 → overflow（该成员停止参与）', () => {
    const built = buildMemberMessages({
        member,
        group: groupMeta,
        sharedMessages: [{gid: 'u', role: 'user', content: '长'.repeat(9000)}],
        ownSteps: [],
        participantsText: '',
        boardText: '',
        focus: '',
        outputLanguage: 'zh',
        memberWindow: 8192,
    });
    assert.equal(built.overflow, true);
    assert.equal(built.window, 8192);
});

test('foldPrivateSteps：超预算保留最近步骤 + 已省略标记；预算内原样', () => {
    const steps = [
        {kind: 'thinking', text: '旧'.repeat(500)},
        {kind: 'thinking', text: '中'.repeat(500)},
        {kind: 'thinking', text: '新'.repeat(100)},
    ];
    const folded = foldPrivateSteps(steps, 50);
    assert.equal(folded.omitted, 2);
    assert.equal(folded.steps[0].kind, 'omitted');
    assert.equal(folded.steps[folded.steps.length - 1].text, '新'.repeat(100));
    const intact = foldPrivateSteps(steps, 100000);
    assert.equal(intact.omitted, 0);
    assert.deepEqual(intact.steps, steps);
});

test('memberTimeouts：标准档 / 思考档（首活动翻倍）/ slowTier 覆盖', () => {
    const plain = memberTimeouts(groupMeta, {id: 'x', name: 'X', modelRef: 'p1|m1'}, profiles);
    assert.equal(plain.tier, 'standard');
    assert.equal(plain.firstActivityMs, 45000);
    assert.equal(plain.totalMs, 180000);
    // 本文件 profiles 无 reasoning 条目；思考档用本地条目验证推导与放宽
    const reasoningProfiles = [{id: 'p3', name: 'r', models: [{id: 'm1', model: 'r', contextWindow: 262144, outputWindow: 4096, reasoningEffort: 'medium', thinking: false}]}];
    const reasoning = memberTimeouts(groupMeta, {id: 'y', name: 'Y', modelRef: 'p3|m1'}, reasoningProfiles);
    assert.equal(reasoning.tier, 'thinking');
    assert.equal(reasoning.firstActivityMs, 90000);
    assert.equal(reasoning.totalMs, 240000);
    const slowMarked = memberTimeouts(groupMeta, {id: 'z', name: 'Z', modelRef: 'p1|m1', slowTier: true}, profiles);
    assert.equal(slowMarked.tier, 'thinking');
    assert.equal(slowMarked.totalMs, 240000);
});

test('outputLanguageRuleText：三档语义', () => {
    assert.match(outputLanguageRuleText('zh'), /中文/);
    assert.match(outputLanguageRuleText('en'), /English/);
    assert.match(outputLanguageRuleText('auto'), /相同的语言/);
    assert.ok(GROUP_RULES_TEXT.includes('不得 @全体成员'));
});

// ==================== 自由聊天（消息即唤醒；§4 / §12） ====================

test('normalizeGroupMeta：free 模式通过归一', () => {
    const meta = normalizeGroupMeta({id: 'g1', mode: 'free', memberIds: ['a1', 'a2']});
    assert.equal(meta.mode, 'free');
    assert.equal(normalizeGroupMeta({mode: 'weird'}).mode, 'roundtable');
});

test('relayWakes：@B 唤醒、@all 禁止、单条 ≤2 人、不唤醒自己', () => {
    const memberNames = [{id: 'a1', name: '架构师'}, {id: 'a2', name: '审查员'}, {id: 'a3', name: '评审'}];
    const base = {speakerId: 'a1', memberNames, generation: 0, pairCounts: new Map(), perAgentCounts: new Map()};
    // 单人点名
    assert.deepEqual(relayWakes('@审查员 你怎么看？', base), ['a2']);
    // 单条最多 @2 人（第三个被截掉）
    assert.deepEqual(relayWakes('@审查员 @评审 @架构师 都说说', base), ['a2', 'a3']);
    // 成员 @all 禁止：不接力
    assert.deepEqual(relayWakes('@全体成员 集合', base), []);
    // 不唤醒自己
    assert.deepEqual(relayWakes('@架构师 收到', base), []);
    // 非成员名不 wake
    assert.deepEqual(relayWakes('@路人 你好', base), []);
    // 代码块里的 @ 忽略
    assert.deepEqual(relayWakes('看这段：```json\n{"a":"@审查员"}\n```', base), []);
});

test('relayWakes：乒乓/单成员/链深上限', () => {
    const memberNames = [{id: 'a1', name: '架构师'}, {id: 'a2', name: '审查员'}];
    // 同对成员互相唤醒 ≤2 次：a1↔a2 已 2 次后不再唤醒
    const pairCounts = new Map([['a1|a2', 2]]);
    assert.deepEqual(relayWakes('@审查员 再说说', {speakerId: 'a1', memberNames, generation: 0, pairCounts, perAgentCounts: new Map()}), []);
    // 被点名者本回合已回 3 次：不再唤醒
    const perAgent = new Map([['a2', 3]]);
    assert.deepEqual(relayWakes('@审查员 来', {speakerId: 'a1', memberNames, generation: 0, pairCounts: new Map(), perAgentCounts: perAgent}), []);
    // 链深到顶（generation ≥ maxHops）：不再唤醒
    assert.deepEqual(relayWakes('@审查员 来', {speakerId: 'a1', memberNames, generation: 6, pairCounts: new Map(), perAgentCounts: new Map()}), []);
});

// ==================== AI 代建群聊（app_control create_group） ====================

function draftAgents() {
    return normalizeAgents([
        {id: 'a1', name: '架构师', modelRef: 'p1|m1'},
        {id: 'a2', name: '审查员', modelRef: 'p2|m1'},
        {id: 'a3', name: '主持人', modelRef: 'p1|m1', chair: true},
        {id: 'a4', name: '停用者', modelRef: 'p1|m1', enabled: false},
    ], () => 'g');
}

test('buildGroupDraft：缺省值（roundtable / decide / 5 轮 / 自动选主持人）', () => {
    const draft = buildGroupDraft({agents: draftAgents(), params: {members: ['架构师', '审查员']}});
    assert.equal(draft.ok, true);
    assert.deepEqual(draft.spec.memberIds, ['a1', 'a2']);
    assert.equal(draft.spec.mode, 'roundtable');
    assert.equal(draft.spec.goal, 'decide');
    // G6：默认 5 轮；发言上限按成员数×轮数推导（2 人 × 5 轮 → 12 下限兜底）
    assert.equal(draft.spec.maxRounds, 5);
    assert.equal(draft.spec.maxSpeeches, 12);
    assert.equal(draft.spec.timeoutPreset, 'standard');
    assert.deepEqual(draft.spec.chair, {kind: 'ai', agentId: 'a3', policy: 'round-plan'});
    assert.deepEqual(draft.members.map((m) => m.name), ['架构师', '审查员']);
    assert.deepEqual(draft.chair, {kind: 'ai', name: '主持人', policy: 'round-plan'});
    // 显式轮数直传（含不限轮次 0）
    assert.equal(buildGroupDraft({agents: draftAgents(), params: {members: ['架构师', '审查员'], rounds: 0}}).spec.maxRounds, 0);
    assert.equal(buildGroupDraft({agents: draftAgents(), params: {members: ['架构师', '审查员'], rounds: 20}}).spec.maxSpeeches, 40);
    assert.equal(buildGroupDraft({agents: draftAgents(), params: {members: ['架构师', '审查员'], rounds: 21}}).ok, false);
});

test('buildGroupDraft：free 模式缺省由用户主持；成员支持 id 去重', () => {
    const draft = buildGroupDraft({agents: draftAgents(), params: {members: ['a1', '架构师', '审查员'], mode: 'free'}});
    assert.equal(draft.ok, true);
    assert.deepEqual(draft.spec.memberIds, ['a1', 'a2']);
    assert.deepEqual(draft.spec.chair, {kind: 'user', agentId: '', policy: 'round-plan'});
    assert.equal(draft.chair.name, '用户自己');
});

test('buildGroupDraft：chair 字符串 / 成员兼任 / 用户主持', () => {
    const byName = buildGroupDraft({agents: draftAgents(), params: {members: ['架构师', '审查员'], chair: '主持人', policy: 'adaptive'}});
    assert.equal(byName.ok, true);
    assert.deepEqual(byName.spec.chair, {kind: 'ai', agentId: 'a3', policy: 'adaptive'});
    const member = buildGroupDraft({agents: draftAgents(), params: {members: ['架构师', '审查员'], chair: {kind: 'member', agent: '审查员'}}});
    assert.equal(member.ok, true);
    assert.deepEqual(member.spec.chair, {kind: 'member', agentId: 'a2', policy: 'round-plan'});
    const user = buildGroupDraft({agents: draftAgents(), params: {members: ['架构师', '审查员'], chair: {kind: 'user'}}});
    assert.equal(user.ok, true);
    assert.equal(user.spec.chair.kind, 'user');
});

test('buildGroupDraft：主持人校验（未标记 / 已停用 / 兼任非成员）', () => {
    const notChair = buildGroupDraft({agents: draftAgents(), params: {members: ['架构师', '审查员'], chair: '审查员'}});
    assert.equal(notChair.ok, false);
    assert.match(notChair.error, /没有主持人标记/);
    const disabled = buildGroupDraft({agents: draftAgents(), params: {members: ['架构师', '审查员'], chair: '停用者'}});
    assert.equal(disabled.ok, false);
    assert.match(disabled.error, /已停用/);
    const memberOutside = buildGroupDraft({agents: draftAgents(), params: {members: ['架构师', '审查员'], chair: {kind: 'member', agent: '主持人'}}});
    assert.equal(memberOutside.ok, false);
    assert.match(memberOutside.error, /必须是群成员/);
    const noAgent = buildGroupDraft({agents: draftAgents(), params: {members: ['架构师', '审查员'], chair: {kind: 'ai'}}});
    assert.equal(noAgent.ok, false);
    assert.match(noAgent.error, /需要 agent/);
});

test('buildGroupDraft：没有主持人标记的智能体时 roundtable 报错、free 可建', () => {
    const agents = normalizeAgents([
        {id: 'b1', name: '甲', modelRef: 'p1|m1'},
        {id: 'b2', name: '乙', modelRef: 'p1|m1'},
    ], () => 'g');
    const failed = buildGroupDraft({agents, params: {members: ['甲', '乙']}});
    assert.equal(failed.ok, false);
    assert.match(failed.error, /没有可用的主持人/);
    assert.equal(buildGroupDraft({agents, params: {members: ['甲', '乙'], mode: 'free'}}).ok, true);
});

test('buildGroupDraft：成员校验（未知 / 停用 / 去重后不足 / 超上限）', () => {
    const agents = draftAgents();
    const unknown = buildGroupDraft({agents, params: {members: ['架构师', '路人']}});
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /找不到智能体「路人」/);
    assert.match(unknown.error, /架构师/);
    assert.ok(!unknown.error.includes('停用者'), '停用智能体不出现在候选里');
    const disabled = buildGroupDraft({agents, params: {members: ['架构师', '停用者']}});
    assert.equal(disabled.ok, false);
    assert.match(disabled.error, /已停用/);
    const tooFew = buildGroupDraft({agents, params: {members: ['架构师', 'a1']}});
    assert.equal(tooFew.ok, false);
    assert.match(tooFew.error, /至少需要/);
    const tooManyAgents = normalizeAgents(Array.from({length: GROUP_MEMBER_MAX + 1}, (_, i) => ({id: 'm' + i, name: '成员' + i, modelRef: 'p1|m1'})), () => 'g');
    const tooMany = buildGroupDraft({agents: tooManyAgents, params: {members: tooManyAgents.map((a) => a.name)}});
    assert.equal(tooMany.ok, false);
    assert.match(tooMany.error, /最多/);
});

test('buildGroupDraft：非法 mode / goal / rounds / timeout / policy 明确报错', () => {
    const agents = draftAgents();
    const base = {members: ['架构师', '审查员']};
    assert.match(buildGroupDraft({agents, params: {...base, mode: 'nope'}}).error, /mode/);
    assert.match(buildGroupDraft({agents, params: {...base, goal: 'nope'}}).error, /goal/);
    // G6：rounds 合法域是 0（不限）–20；0 不再报错，21 / -1 / 非整数报错
    assert.equal(buildGroupDraft({agents, params: {...base, rounds: 0}}).ok, true);
    assert.match(buildGroupDraft({agents, params: {...base, rounds: 21}}).error, /rounds/);
    assert.match(buildGroupDraft({agents, params: {...base, rounds: -1}}).error, /rounds/);
    assert.match(buildGroupDraft({agents, params: {...base, timeout: 'slow'}}).error, /timeout/);
    assert.match(buildGroupDraft({agents, params: {...base, policy: 'nope'}}).error, /policy/);
});

test('buildGroupDraft：title / topic 去两端空白，参数透传给 createGroup', () => {
    const draft = buildGroupDraft({agents: draftAgents(), params: {
        members: ['架构师', '审查员'], title: '  存储方案评审  ', topic: ' 对比 A/B  ', mode: 'task', goal: 'plan', rounds: 3, timeout: 'lenient',
    }});
    assert.equal(draft.ok, true);
    assert.equal(draft.spec.title, '存储方案评审');
    assert.equal(draft.spec.topic, '对比 A/B');
    assert.equal(draft.spec.mode, 'task');
    assert.equal(draft.spec.goal, 'plan');
    assert.equal(draft.spec.maxRounds, 3);
    assert.equal(draft.spec.timeoutPreset, 'lenient');
});

// 模式取值归一化的唯一来源：新建草稿 / 运行时 createGroup / 读盘都走它。
// 草稿层曾自带「非 task 即 roundtable」的三元，把 free 静默改写成圆桌——自由聊天在 UI 上
// 完全不可达（运行时本可正确处理 free），故此函数与三处接线一并钉死。
test('normalizeGroupMode：三值直传，其他值回落圆桌', () => {
    assert.equal(normalizeGroupMode('free'), 'free');
    assert.equal(normalizeGroupMode('task'), 'task');
    assert.equal(normalizeGroupMode('roundtable'), 'roundtable');
    for (const bad of ['', null, undefined, 'Free', 'nope', 0, {}]) {
        assert.equal(normalizeGroupMode(bad), 'roundtable');
    }
});

test('群模式接线：草稿层与运行时都经 normalizeGroupMode，不再自己写三元', () => {
    const read = (rel) => readFileSync(new URL('../../../src/ai' + rel, import.meta.url), 'utf8');
    const sidebar = read('/group/ai-group-sidebar.js');
    // 两种写法都算合规：对象字面量直传，或先存局部 const mode 再简写返回（relay 模式重构后用后者）
    const goesThroughNormalize = sidebar.includes('mode: normalizeGroupMode(createControls.mode.control.value)') ||
        sidebar.includes('const mode = normalizeGroupMode(createControls.mode.control.value)');
    assert.ok(goesThroughNormalize, '草稿层的 mode 必须经 normalizeGroupMode 归一');
    assert.equal(sidebar.includes("=== 'task' ? 'task' : 'roundtable'"), false);
    const runtime = read('/group/ai-group-runtime.js');
    assert.ok(runtime.includes('mode: normalizeGroupMode(source.mode)'));
});
