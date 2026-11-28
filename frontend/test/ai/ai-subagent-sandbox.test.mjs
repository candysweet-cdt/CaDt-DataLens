// 子代理命令沙箱的接线护栏（能力快照方案 docs/unfinished-plans/subagent-capabilities-redesign.md，
// 取代旧 subagent-sandbox.md 的 scope→沙箱映射护栏）。
//
// 不变量（2026-11-28 能力快照重构后）：
//   P1 沙箱档来自能力快照 fs.mode（派出时定死）：主会话返回 null（主会话边界是审批链）；
//      快照缺失按最窄 read-only，绝不降级成「不沙箱」
//   P2 写根优先取快照 fs.workspaceRoot（派单时解析定死，worktree 优先）；缺失时回退
//      worktree → 会话工作区 → 范围根，取不到交给 Go 侧 fail-closed
//   P3 父档 → 快照的映射在 composeAgentCapabilities 合成（见 agent-capabilities.test.mjs），
//      这里只锁面板消费侧
//   P4 host.default 子代理工具表挂命令四件套（run / background / check / stop）
//   P5 run_command 分支：沙箱时跳过审批、调 AIRunShellCommandConfined
//   P6 background_command 分支：沙箱档走 AICommandStartConfined，且先过项目 deny 规则
//   P7+ 嵌套投递 / 收件箱 / 收尾轮等编排不变量随原护栏保留
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

import {subSandboxPolicy} from '../../src/ai/agent/ai-subagents.js';
import {describeSandboxGrant, sandboxHasResidue, sandboxModeLabel} from '../../src/ai/security/ai-sandbox-grant.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function sourceOf(relPath) {
    return readFileSync(join(SRC, relPath), 'utf8');
}

// 截取一段源码：从 startMarker 起，到 endMarker 之前。
function sliceBetween(text, startMarker, endMarker) {
    const start = text.indexOf(startMarker);
    assert.ok(start >= 0, '找不到起始标记：' + startMarker);
    const end = endMarker ? text.indexOf(endMarker, start) : text.length;
    assert.ok(end > start, '找不到结束标记：' + endMarker);
    return text.slice(start, end);
}

test('P1 沙箱档来自能力快照：主会话 null，快照缺失按最窄 read-only', () => {
    assert.equal(subSandboxPolicy(null), null);
    assert.equal(subSandboxPolicy({id: 'main', scope: 'auto', workspace: 'C:/ws'}), null);
    // 子代理无快照（异常 / 旧数据）：最窄处理，绝不悄悄降级成「不沙箱」
    const narrow = subSandboxPolicy({id: 'sub-1', parentSessionId: 'main', workspace: 'C:/ws'});
    assert.deepEqual(narrow, {mode: 'read-only', workspaceRoot: 'C:/ws'});
});

test('P2 写根优先取快照 fs.workspaceRoot，缺失回退 worktree → 工作区 → 范围根', () => {
    const byCaps = subSandboxPolicy({
        id: 'sub-1',
        parentSessionId: 'main',
        capabilities: {fs: {mode: 'workspace-write', workspaceRoot: 'C:/wt', writableRoots: ['C:/wt']}},
    }, 'C:/fallback');
    assert.deepEqual(byCaps, {mode: 'workspace-write', workspaceRoot: 'C:/wt'});

    const byWorktree = subSandboxPolicy({
        id: 'sub-1',
        parentSessionId: 'main',
        workspace: 'C:/ws',
        worktree: {name: 'wt-a', path: 'C:/ws/.cadt/worktree/wt-a'},
    }, 'C:/fallback');
    assert.equal(byWorktree.workspaceRoot, 'C:/ws/.cadt/worktree/wt-a');

    const byFallback = subSandboxPolicy({id: 'sub-1', parentSessionId: 'main'}, 'C:/fallback');
    assert.equal(byFallback.workspaceRoot, 'C:/fallback');

    // 三处都取不到根时留空（交给 Go 侧 fail-closed，不降级成不沙箱）
    const empty = subSandboxPolicy({id: 'sub-1', parentSessionId: 'main'}, '');
    assert.equal(empty.workspaceRoot, '');
});

test('P4 host.default 子代理工具表挂命令四件套（run / background / check / stop）', () => {
    const text = sourceOf('ai/agent/ai-subagents.js');
    const tools = sliceBetween(text, 'function subToolsForCapabilities(', 'function activeSubCount(');
    for (const name of ['run_command', 'background_command', 'check_command', 'stop_command']) {
        assert.ok(tools.includes('AI_TOOL_DEFS.' + name), '子代理必须能用 ' + name + '（沙箱档执行）');
    }
    // 命令挂载由快照 execution.command 闸住（denied = 不挂，编排强制收窄的只读面没有命令）
    assert.ok(tools.includes("caps.execution.command === 'sandboxed'"),
        '命令四件套必须按快照 execution.command 门控');
});

test('P4b 工具面投影消费能力快照：写工具只由 allow 决定，不再有 hasWorktree 特判', () => {
    const text = sourceOf('ai/agent/ai-subagents.js');
    const tools = sliceBetween(text, 'function subToolsForCapabilities(', 'function activeSubCount(');
    assert.ok(tools.includes('has(\'write_file\')'), '写工具按快照 allow 投影');
    assert.ok(tools.includes('caps.tools.allow'), '投影必须读快照 allow 列表');
    assert.ok(!/hasWorktree/.test(tools), 'worktree 不再是写工具开关（快照在派单时注入前缀与写工具）');
});

test('P4c 编排会话派生的子代理强制收窄为只读 preset（阶段零硬前置，§10.5）', () => {
    const text = sourceOf('ai/agent/ai-subagents.js');
    const resolve = sliceBetween(text, 'function resolveSpawnPreset(', 'async function confirmPresetWriteGrant(');
    assert.ok(resolve.includes("orcRole === 'work' || orcRole === 'review' || orcRole === 'arbiter'"),
        '编排三角色派生都要识别');
    assert.ok(resolve.includes('HOST_PRESET_READ_ONLY'), '强制收窄必须走宿主只读 preset（不信任派单参数）');
    assert.ok(resolve.includes('不支持 isolation=worktree'), '编排派单不得建 worktree（隔离车道也不给）');
    const spawn = sliceBetween(text, 'async function startSubAgent(', 'async function runSubAgent(');
    assert.ok(spawn.includes('canSpawn === false'), '父快照 canSpawn=false 时不能再派（层间只收窄）');
    assert.ok(spawn.includes('resolveSpawnPreset(input, parentSession)'), '派单入口必须走统一 preset 解析（fail-fast 在并发等待之前）');
});

test('P4d spawn_agent 派单读取 preset 且旧 sandbox 参数直接报错（§11.3 破坏性明示）', () => {
    const text = sourceOf('ai/agent/ai-subagents.js');
    const guard = sliceBetween(text, 'function rejectLegacySandboxArg(', 'async function startSubAgent(');
    // 旧 sandbox 参数：inspectToolArguments 不校验键名（旧键原样透传），拦截只能在执行分支——
    // rejectLegacySandboxArg 在派单入口直接抛错给新用法指引，不做静默兼容。
    assert.ok(guard.includes('input.sandbox'), '拒绝守卫必须读取旧 sandbox 参数');
    assert.ok(guard.includes('sandbox 参数已删除'), '拒绝信息必须带新用法指引（preset）');
    // preset 解析与编排收窄在 resolveSpawnPreset（startSubAgent 调用它）
    assert.ok(guard.includes('input.preset'), '派单解析必须读取 input.preset');
    const spawn = sliceBetween(text, 'async function startSubAgent(', 'async function runSubAgent(');
    assert.ok(!spawn.includes('input.sandbox'), 'startSubAgent 主体不得读取旧 sandbox 参数');
    assert.ok(spawn.includes('rejectLegacySandboxArg(input)'), '派单入口必须调用拒绝守卫');
    assert.ok(spawn.includes('composeAgentCapabilities'), '派单必须合成能力快照');
    assert.ok(spawn.includes('sub.session.capabilities = sub.capabilities'), '快照必须挂到会话（写入判定消费）');
    // P0 回归钉：审批通道与工作区根必须从工厂闭包解构（工具 ctx 会遮蔽工厂 ctx）
    assert.ok(text.includes('const requestActionApproval = typeof ctx.requestActionApproval'), '确认卡通道必须从工厂 deps 解构');
    assert.ok(text.includes('const getScopeRoot = typeof ctx.getScopeRoot'), 'worktree 工作区根必须从工厂 deps 解构');
});

test('read_video 下发按会话视频能力裁剪，执行守卫用同一判定', () => {
    const src = sourceOf('ai/agent/ai-subagents.js');
    const tools = sliceBetween(src, 'function subToolsForCapabilities(', 'function activeSubCount(');
    assert.ok(tools.includes('videoCapableOf(session)'), '子代理 read_video 必须按会话视频能力注册');
    assert.ok(!/\[[^\]]*AI_TOOL_DEFS\.read_video[^\]]*\]/.test(tools),
        'read_video 不该在数组字面量里无条件注册，应按能力插位');

    const panel = sourceOf('ai/ai-panel.js');
    const branch = sliceBetween(panel, "case 'read_video': {", "case 'search_text': {");
    assert.ok(branch.includes('videoCapableOf(session)'), 'read_video 执行守卫必须与下发同判定');
});

test('P7 子代理挂 wait_agent，且等的是自己的收件箱（不指向具体代理）', () => {
    const text = sourceOf('ai/agent/ai-subagents.js');
    const tools = sliceBetween(text, 'function subToolsForCapabilities(', 'function activeSubCount(');
    // 2026-11-17 实测：子代理工具表没有 wait_agent，用 background 派单后结果只能靠结算通知回流，
    // 那条路对子代理会话不可靠（B 支一条支线的第 5 层汇报丢失）。能派单就必须能收。
    // spawn/wait/agent_send 三件套都在同一个 canSpawn 条件块里（层级 + 快照双闸）。
    const spawnBlock = sliceBetween(tools, 'if (canSpawn) {', '\n        }');
    assert.ok(spawnBlock.includes('AI_TOOL_DEFS.wait_agent'), '能派单的层必须同时挂 wait_agent');
    assert.ok(spawnBlock.includes('AI_TOOL_DEFS.agent_send'), '能派单的层必须同时挂 agent_send（嵌套提问要能作答）');

    // 语义已改为 dsh 的「等自己下一步的新输入」：不再按 agentId 定向等，
    // 因此也不再有祖先判定与自等风险（那套守卫随旧实现一起删掉）。
    assert.ok(!text.includes('agentCanBeWaitedBy'), '定向等待的守卫应随旧语义一起删除');
    const waitFn = sliceBetween(text, 'async function waitForInbox(', '// 工具分发薄壳');
    assert.ok(waitFn.includes('inboxWaiters.wait('), '等待必须走收件箱原语（事件驱动）');
    assert.ok(waitFn.includes('countPending'), '要先判定「是否已有待消费输入」，避免明明有消息还睡一轮');
    assert.ok(!waitFn.includes('agentId'), '不按具体代理等待');
    assert.ok(!waitFn.includes('aiDelay('), '不许退化成轮询等待');
    // 收尾轮不消费收件箱（runSubRound 的 !s.wrapUp）：此时必须立即返回，否则空等满超时。
    assert.ok(waitFn.includes('wrapUp'), '收尾轮守卫必须在，否则最后一步改进程会白等');
    // 2026-11-17 审查抓到：车道快照曾从**工具 ctx** 取（那里只有 session/toolMessage/stream），
    // 恒为 undefined ⇒ 判定等于关掉。它必须来自模块 ctx。
    assert.ok(!waitFn.includes('ctx.queueLanesOf'), 'queueLanesOf 不能从工具 ctx 取（那里没有）');
    assert.ok(text.includes('const queueLanesOf = ctx.queueLanesOf'), '要从模块 ctx 解包一次供闭包使用');
    // 2026-11-19 排队语义重设计：排队车道不算待消费输入（不打扰等待，唤醒也读不到内容），
    // 只有 steer 算；queue 只在超时检查点提示「输入框有排队消息」。
    assert.ok(waitFn.includes('lanesOf(viewer.id).steer'), 'countPending 只认 steer 车道');
    assert.ok(waitFn.includes('lanesOf(viewer.id).queue'), '超时检查点要提示排队消息');
    // 停止要立刻生效：两处统一停止入口都必须调 cancel
    assert.ok(text.includes('inboxWaiters.cancel(sub.id)'), 'stopSubAgent 必须放行等待（不等心跳）');
    const panel = sourceOf('ai/ai-panel.js');
    assert.ok(panel.includes('inboxWaiters.cancel(sessionId)'), 'stopGeneration 必须放行等待');
});

test('P10 嵌套投递：结算与提问都经 deliverToParent，不只看 sessions 表', () => {
    // 2026-11-17 五层嵌套实测：层5 的结论没回到层4。根因是 sessionById(parentSessionId)
    // 对子代理会话恒为 null（子会话不进 sessions 表），于是第 2 层起的通知全部静默丢失。
    const text = sourceOf('ai/agent/ai-subagents.js');
    assert.ok(text.includes('function deliverToParent('), '必须有统一的父级投递入口');
    const fn = sliceBetween(text, 'function deliverToParent(', 'function finalizeSubAgent(');
    assert.ok(fn.includes('subAgents.get(sub.parentSessionId)'), '先看父是不是运行中的子代理');
    assert.ok(fn.includes("from: 'subagent'"), '嵌套回报在收件箱里要有自己的来源前缀');
    assert.ok(fn.includes('deliverAgentNotice'), '父是主会话时仍走会话信箱');
    const fin = sliceBetween(text, 'function finalizeSubAgent(', '// 停止时未消费的收件箱条数');
    assert.ok(fin.includes('deliverToParent(sub,'), '结算通知必须走 deliverToParent');
    const ask = sliceBetween(text, 'function runSubAskQuestion(', '// 回答路由');
    assert.ok(ask.includes('deliverToParent(sub,'), '提问通知必须走 deliverToParent（否则嵌套提问到不了父代理）');
    assert.ok(!ask.includes('sessionById(sub.parentSessionId)'), '提问不得再只看 sessions 表');
});

test('P11 收件箱来源前缀三方可辨：用户插话 / 主代理消息 / 下级代理回报', () => {
    const text = sourceOf('ai/agent/ai-subagents.js');
    const fn = sliceBetween(text, 'export function inboxMessageText(', '// 冷唤醒准入');
    assert.ok(fn.includes('［用户插话］') && fn.includes('［上级代理消息］') && fn.includes('［下级代理回报］'),
        '三种来源都必须有独立前缀，否则嵌套时父代理分不清谁说的');
});

test('P12 嵌套提问可作答：能派单的层同时挂 agent_send，且方向限死自己的下级', () => {
    // 2026-11-17 审查发现：buildAskNotice 教父代理用 agent_send(askId=…) 作答，但子代理工具表
    // 里没有它 —— 嵌套时父是子代理，收得到提问却答不了，只能等 120s 放行。
    const text = sourceOf('ai/agent/ai-subagents.js');
    const tools = sliceBetween(text, 'function subToolsForCapabilities(', 'function activeSubCount(');
    // 用「同一条件块里挂载」而不是字符距离——距离断言会被无关的文案改动撞红（刚发生过）
    const spawnBlock = sliceBetween(tools, 'if (canSpawn) {', '\n        }');
    assert.ok(spawnBlock.includes('AI_TOOL_DEFS.agent_send'),
        'agent_send 必须与「还能派单」同条件（到层级上限的层没有下级）');
    // 方向守卫：子代理只能发自己的下级，不能给祖先 / 兄弟喊话
    const sendFn = sliceBetween(text, 'function sendToSubAgent(', '// agent_stop 执行体');
    assert.ok(sendFn.includes('agentDescendsFrom('), '子代理调用必须过「是不是我的下级」判定');
    assert.ok(sendFn.includes('viewer.parentSessionId'), '只对子代理视角生效，主代理不受限');
    // 系统提示要教它怎么用（否则模型不会想到去回答）
    const prompt = sliceBetween(text, 'function subSystemPromptFor(', 'function subToolsForCapabilities(');
    assert.ok(prompt.includes('askId='), '提示里要给出作答形式');
    assert.ok(prompt.includes('只能发给自己派出的下级'), '提示里要写清方向限制');
});

test('P13 收尾轮真的不下发工具，幻觉调用直接收尾（不死循环）', () => {
    // 旧实现：注释写「收尾轮不带工具」，实际每次请求都发完整工具表；模型在收尾轮
    // 仍能调 read_file / spawn_agent，调 ask_user 还会空等父代理 120s。
    const text = sourceOf('ai/agent/ai-subagents.js');
    const round = sliceBetween(text, 'const apiMessages = buildApiMessages(', 'async function runSubToolRound(');
    assert.ok(/const tools = s\.wrapUp \? \[\] : subToolsForCapabilities\(/.test(round),
        'wrapUp 时必须传空工具表');
    assert.ok(round.includes('AISendChat(s.roundId, s.profileCfg, apiMessages, tools,'),
        '请求要用上面算好的 tools，而不是再调一次投影');
    const toolRound = sliceBetween(text, 'async function runSubToolRound(', 'const toolMessage = {');
    assert.ok(toolRound.includes('if (s.wrapUp)'), '收尾轮收到工具调用要单独处理');
    assert.ok(toolRound.includes("finalizeSubAgent(sub, 'done')"), '拒绝后必须立即收尾，不能进下一轮');
});

test('P14 孤儿接管与投递兜底：父终态不级联，但下级必须有归处', () => {
    // 2026-11-18 bug-hunt 实测：层3「工具动作接线审查」50 轮预算耗尽自动 done（终态不级联，
    // 下级结论可能还有价值，agent_stop 才显式级联），它派出的三个层4 对账子代理还在跑；
    // 结算时 deliverToParent 两头落空——父不在 subAgents、sessionById(子代理会话 id) 恒 null，
    // 四条「结论未能投递」flash，结论就地蒸发。
    const text = sourceOf('ai/agent/ai-subagents.js');
    // ① finalizeSubAgent 终态必须尝试接管运行中的下级
    const fin = sliceBetween(text, 'function finalizeSubAgent(', '// 停止时未消费的收件箱条数');
    assert.ok(fin.includes('adoptOrphanChildren(sub)'), '终态必须调用孤儿接管');
    assert.ok(fin.includes('session.messages.includes(sub.parentToolMessage)'),
        '刷新前先验证 toolMessage 归属：孤儿改挂根会话后 indexOf 落空会退化成整屏重渲染');
    // ② 接管实现：直属运行中下级改挂运行中祖父，没有就挂根会话
    const adopt = sliceBetween(text, 'function adoptOrphanChildren(', 'function finalizeSubAgent(');
    assert.ok(adopt.includes("item.state === 'running' && item.parentSessionId === sub.id"),
        '只接管直属运行中下级（孙代理挂直属下级身上，子树自然保持成树）');
    assert.ok(adopt.includes("grand && grand.state === 'running'"), '优先挂运行中的祖父（收件箱投递可达）');
    assert.ok(adopt.includes('sub.rootSessionId'), '没有运行中祖父时挂根会话（信箱投递可达）');
    assert.ok(adopt.includes('agentRegistry.get(kid.key)'), '注册表里的归属要同步改');
    // ③ deliverToParent 兜底：父 id 不在 sessions 表且未被接管时，按终态记录回落根会话
    const dlv = sliceBetween(text, 'function deliverToParent(', 'function adoptOrphanChildren(');
    assert.ok(dlv.includes('parentRecord.rootSessionId'), '父已终态且未被接管时按记录回落根会话');
});

test('P15 嵌套预算继承：子代理再派单未点名 maxRounds 时继承派出方的上限', () => {
    // 2026-11-18 bug-hunt 实测诱因：主代理派层2给了 maxRounds 80，层2 派层3没传 → 落回
    // 设置默认 50 → 中间层先饿死自动收尾，下级成孤儿。显式点名永远优先，主代理派单不继承。
    const text = sourceOf('ai/agent/ai-subagents.js');
    const fn = sliceBetween(text, 'async function startSubAgent(', 'async function runSubAgent(');
    assert.ok(fn.includes('spawnCallerSession.parentSessionId'), '只有子代理派单才继承（主会话不是子代理）');
    assert.ok(fn.includes('parentLiveSub.maxRounds'), '未点名时继承派出方自己的轮次上限');
    assert.ok(fn.includes('roundsExplicit'), '显式点名仍优先于继承');
    assert.ok(fn.includes('resolveSubAgentRounds(roundsInput,'), '继承值也必须过统一钳制');
});

test('P16 子代理写判定消费能力快照：deny 规则在前、Go 权威判定在落盘前（§5.2/§5.5）', () => {
    const panel = sourceOf('ai/ai-panel.js');
    const branch = sliceBetween(panel, 'let decision;', 'logPermission(\'write\', rel, decision.decision');
    // 项目 deny/ask 规则先于能力快照（§5.2）：子代理不能审批，ask 同样确定性拒绝
    assert.ok(branch.includes("evaluatePermissionRules(rules, 'write', rel)"),
        '子代理分支必须先过项目 write 规则（deny 与 ask 都拦）');
    assert.ok(branch.includes('subWriteVerdict(subCaps, info.path)'), '子代理分支必须按快照快筛');
    assert.ok(branch.includes('session.parentSessionId ? session.capabilities'), '只对子代理会话生效，主会话走审批链');
    assert.ok(branch.includes('decidePermission({'), '主会话 decidePermission 零改动（§0.3 第 2 条）');
    assert.ok(!branch.includes('agentWorktreeWriteVerdict'), 'worktree 特判不应回归（快照已注入前缀）');
    // Go 权威判定在编排写闸之后、落盘之前
    const write = sliceBetween(panel, 'async function applyWorkspaceWrite(', 'function webToolLimit(');
    const orchAt = write.indexOf('authorizeWrite');
    const goAt = write.indexOf('backend.WriteBoundaryCheck(');
    const saveAt = write.indexOf('backend.SaveFileChecked(');
    assert.ok(orchAt > 0 && goAt > orchAt && saveAt > goAt,
        'guard 链顺序：编排写闸 → Go 写边界 → SaveFileChecked（§5.2）');
    assert.ok(write.includes("subCaps.fs.mode === 'workspace-write'"), 'Go 判定只对 workspace-write 生效（full 不设边界）');
});

test('P6 background_command 分支：沙箱档走 AICommandStartConfined，且先过项目 deny 规则', () => {
    const text = sourceOf('ai/ai-panel.js');
    const branch = sliceBetween(text, "case 'background_command': {", "case 'check_command': {");

    assert.ok(branch.includes('subSandboxPolicy(ctx.session'), '后台命令也要按会话判定沙箱');
    const sandboxAt = branch.indexOf('if (sandbox) {');
    const elseAt = branch.indexOf('} else {');
    const approveAt = branch.indexOf('approveCommandForRun');
    assert.ok(sandboxAt >= 0 && elseAt > sandboxAt, '后台分支必须先判沙箱，再走 else 的审批链');
    assert.ok(approveAt > elseAt, '审批只能出现在非沙箱分支：子代理永远不问');
    assert.ok(!branch.slice(sandboxAt, elseAt).includes('approveCommandForRun'), '沙箱分支里不得出现审批');

    const denyAt = branch.indexOf('evaluatePermissionRules');
    const callAt = branch.indexOf('backend.AICommandStartConfined(');
    assert.ok(denyAt > 0 && callAt > denyAt, '沙箱分支必须先过项目 deny 规则，再起作业');
    assert.ok(branch.includes('job.sandboxMode'), '启动结果必须如实回显沙箱档位');
});

test('P7 留痕：沙箱拒绝 / 不可用各自成 status，主循环与子代理循环都按它记', () => {
    const panel = sourceOf('ai/ai-panel.js');
    assert.ok(panel.includes("activityStatus = 'sandbox-denied'"), '命令被沙箱拦住要标 sandbox-denied');
    assert.ok(panel.includes("activityStatus = 'sandbox-unavailable'"), '沙箱建不起来要标 sandbox-unavailable');
    assert.ok(panel.includes('const logStatus = toolMessage.activityStatus'),
        '主循环留痕必须让沙箱状态优先于 done/error');
    assert.ok(panel.includes('sandbox: toolMessage.sandbox'), '留痕要带沙箱档位');

    const sub = sourceOf('ai/agent/ai-subagents.js');
    assert.ok(sub.includes('status: toolMessage.activityStatus ||'),
        '子代理工具循环也必须按沙箱状态留痕（子代理命令无人可问，留痕是唯一审计面）');
    assert.ok(sub.includes('sandbox: toolMessage.sandbox'), '子代理留痕同样带档位');

    // 字段名收口：activityStatus 是「留痕状态覆盖」，也承载作业归属拒绝（denied）——
    // 别退回沙箱专属命名，否则非沙箱的拒绝语义会无处安放。
    assert.ok(!panel.includes('sandboxStatus'), '不得残留 sandboxStatus 字段名');
    assert.ok(!sub.includes('sandboxStatus'), '不得残留 sandboxStatus 字段名');
});

test('P8 授权残留：文案如实列出三样痕迹，设置页有检查/清除入口', () => {
    const clean = {root: 'C:/ws', workspaceSid: 'S-1-4-1-2'};
    assert.equal(sandboxHasResidue(clean), false);
    assert.match(describeSandboxGrant(clean), /没有沙箱痕迹/);
    assert.equal(sandboxHasResidue(null), false);

    const all = {root: 'C:/ws', workspaceSid: 'S-1-4-1-2', granted: true, denyPresent: true, labeled: true};
    assert.equal(sandboxHasResidue(all), true);
    const text = describeSandboxGrant(all);
    assert.match(text, /写权授权/);
    assert.match(text, /删除子项 deny/);
    assert.match(text, /Low 完整性标签/);
    assert.match(text, /S-1-4-1-2/);

    // 只有其中一样也算残留（部分清理失败不能假装干净）
    assert.equal(sandboxHasResidue({root: 'C:/ws', labeled: true}), true);

    const settings = sourceOf('ai/security/ai-permission-settings.js');
    assert.ok(settings.includes('backend.SandboxScan('), '设置页要能检查残留');
    assert.ok(settings.includes('backend.SandboxRevoke('), '设置页要能清除授权');
});

test('P9 HUD 档位标签、后台拒绝分类与作业归属校验', () => {
    assert.equal(sandboxModeLabel('read-only'), '只读');
    assert.equal(sandboxModeLabel('workspace-write'), '可写');
    assert.equal(sandboxModeLabel('danger-full-access'), '完全');
    assert.equal(sandboxModeLabel('weird'), 'weird'); // 未知值原样回显，不猜

    const hud = sourceOf('ai/agent/ai-head-hud.js');
    assert.ok(hud.includes('sandboxMode: sub.sandboxMode'), 'HUD 要读派出时定死的档位');
    assert.ok(hud.includes('ai-agent-badge ai-sandbox-badge'), '档位要渲染成胶囊标识');
    assert.ok(hud.includes('appendBit(agentSandboxBadge(agent.sandboxMode))'), '档位胶囊要嵌在副标题原「沙箱 …」文本的位置');
    assert.ok(!hud.includes("'沙箱 ' + sandboxModeLabel"), '副标题不再拼「沙箱 …」文本（胶囊已承载）');

    const panel = sourceOf('ai/ai-panel.js');
    const check = sliceBetween(panel, "case 'check_command': {", "case 'stop_command': {");
    assert.ok(check.includes('st.sandboxDenied'), '后台作业的拒绝只能在轮询时分类');
    assert.ok(check.includes("ctx.toolMessage.activityStatus = 'sandbox-denied'"), '轮询到拒绝要留痕');

    const stop = sliceBetween(panel, "case 'stop_command': {", "case 'schedule_create': {");
    assert.ok(stop.includes('rootSessionIdOf(ctx.session)'), 'stop_command 必须校验作业归属，不能按 jobId 乱停');
});

test('P17 复活重建沙箱档与隔离区登记（2026-11-28 审查补的存量缺口）', () => {
    // 复活（reviveSubAgent）此前不重建 sub.sandboxMode / sub.worktree：HUD 档位徽标退化、
    // 终态留痕丢 sandbox 标记、systemPrompt 丢 worktree 段、worktreeNamesForSession
    // 收集不到该隔离区（export/discard 看不见它）。能力快照随 v2 记录恢复后，这三样
    // 必须从记录里重建。
    const text = sourceOf('ai/agent/ai-subagents.js');
    const revive = sliceBetween(text, 'function reviveSubAgent(', '// agent_send 执行体');
    assert.ok(revive.includes('sub.capabilities = (sub.session && sub.session.capabilities) || READ_ONLY_CAPABILITIES'),
        '能力快照必须随记录恢复（缺快照按最窄只读兜底）');
    assert.ok(revive.includes('sub.sandboxMode = sub.capabilities && sub.capabilities.fs'), '沙箱档必须重建');
    assert.ok(revive.includes('sub.worktree = (sub.session && sub.session.worktree) || null'), '隔离区登记必须重建');
    assert.ok(revive.includes('!!sub.worktree'), 'systemPrompt 的 worktree 位必须读重建后的值（不是 record.worktree）');
    assert.ok(revive.includes("toolMessage.agent.sandboxMode = sub.sandboxMode"), '派单卡片档位照常回显');
});

test('P5 run_command 分支：沙箱时跳过审批并调 AIRunShellCommandConfined', () => {
    const text = sourceOf('ai/ai-panel.js');
    const branch = sliceBetween(text, "case 'run_command': {", "case 'background_command': {");

    assert.ok(branch.includes('subSandboxPolicy(ctx.session'), '分支必须按会话判定是否沙箱');
    const sandboxAt = branch.indexOf('if (sandbox) {');
    const elseAt = branch.indexOf('} else {');
    const approveAt = branch.indexOf('approveCommandForRun');
    assert.ok(sandboxAt >= 0 && elseAt > sandboxAt, '分支必须先判沙箱，再走 else 的审批链');
    assert.ok(approveAt > elseAt, '审批只能出现在「非沙箱」的 else 分支里：子代理永远不问');
    assert.ok(!branch.slice(sandboxAt, elseAt).includes('approveCommandForRun'), '沙箱分支里不得出现审批');
    assert.ok(branch.includes('AIRunShellCommandConfined('), '沙箱档必须走受限入口');
    assert.ok(branch.includes('result.sandboxMode'), '结果必须如实回显沙箱档位');

    // 项目 deny 规则是用户的明确禁令，不是「需要人判断」的事：子代理不弹审批，但仍须遵守。
    // 注意比对「调用点」（带括号），别被前面的能力探测 `!backend.AIRunShellCommandConfined` 命中。
    const denyAt = branch.indexOf('evaluatePermissionRules');
    const callAt = branch.indexOf('backend.AIRunShellCommandConfined(');
    assert.ok(denyAt > 0 && callAt > denyAt,
        '沙箱分支必须先过项目 deny 规则（只取 deny，不问、不跑分类器）');
});
