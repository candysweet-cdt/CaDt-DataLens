// ai-subagents.js：子代理域宿主（spawn_agent 运行时 / 收件箱 / 压缩 / 提问 / 后台命令桥 + 块模型纯函数）。
// 详情视图与头部 HUD 已拆至 ai-agent-view.js / ai-head-hud.js（phase3 A4 同域兄弟模块：
// ctx 同源、extras 注入，函数体逐字搬移）；本文件是三域共享状态的持有者与运行时核心。
// 块模型纯函数留守（ai-subagents.test.mjs）。详情视图挂载点：主窗口是内容区标签页
// （bridge-agent-view.js），悬浮窗退回面板内覆盖层 #ai-agent-view。
import {createAIAgentView} from './ai-agent-view.js';
import {createAIHeadHud} from './ai-head-hud.js';
import {createAITeamView} from '../group/ai-team-view.js';
import {agentTreeText} from '../group/ai-team-model.js';
import {normalizeWorktreeState} from '../tools/ai-worktree.js';
import {aiClampInt, aiNowId, aiTextOf, AI_COMPACT_SYSTEM_PROMPT, AI_SCOPES} from '../core/ai-constants.js';
import {parseJson} from '../../core/json-safe.js';
import {aiStreamRetryBudget, shouldAutoRetryStream} from '../chat/ai-stream-retry.js';
import {encodeAgentEvent} from '../session/ai-session-store.js';
import {encodeAgentRun, normalizeAgentRuns, resumePlanOf} from './ai-agent-resume.js';
import {createAgentScope, presetPromptSections} from './ai-agent-preset.js';
import {
    composeAgentCapabilities, subWriteVerdict, subToolDenyText, READ_ONLY_CAPABILITIES,
} from './agent-capabilities.js';
import {
    getAgentPreset, listAgentPresetIds, knownAgentToolNames, isHostPresetId,
    hasPresetGrant, recordPresetGrant, subagentProjectableToolNames,
    HOST_PRESET_DEFAULT, HOST_PRESET_READ_ONLY,
} from './ai-agent-preset-registry.js';
import {AI_TOOL_DEFS, buildSpawnAgentDef} from '../tools/ai-tool-defs.js';
import {inspectToolArguments} from '../tools/ai-tool-args.js';
import {buildSettlementNotice, buildAskNotice, buildFullScopeWarning} from './ai-agent-notices.js';
import {compactTranscriptOf, computeCompactCutoffByBudget, compactRetainBudget, buildCompactSummary, applyCompactToSession, buildCompactMessages, compactThresholdOf, COMPACT_KEEP_TAIL} from '../chat/ai-compact.js';
import {createLoopGuard} from '../chat/ai-loop-guard.js';

// parseTranscriptLines：磁盘转录（JSONL，一行一条 {role,name,text}）→ 转录条目数组。
// 格式契约的另一半在 finalizeSubAgent 的落盘处；坏行跳过而不是整份丢弃——重启后
// 能显示多少算多少，总比「一条坏行让整段记录消失」好。
export function parseTranscriptLines(text) {
    const entries = [];
    for (const line of String(text == null ? '' : text).split('\n')) {
        if (!line.trim()) continue;
        try {
            const row = JSON.parse(line);
            if (!row || typeof row !== 'object') continue;
            entries.push({
                role: String(row.role || ''),
                name: String(row.name || ''),
                text: String(row.text || ''),
            });
        } catch (e) {}
    }
    return entries;
}

// target 是否在 ancestorSessionId 的后代里（`agent_send` 的方向守卫）。
// 从 lookup(target) 的**上级**开始追，因此天然排除自身——`agentUnderSessionBy` 当年从 target
// 起点追，「起点就是祖先」也命中，才引出子代理自等的坑（2026-11-17 实测），这里不再重演。
// lookup(id) 返回该代理的 parentSessionId，查不到返回空串（记录被 LRU 回收即如此）；
// 查不到一律当「不是我的下级」——宁可让模型重派，也不让它把消息投进别人的树。
export function agentDescendsFrom(agentId, ancestorSessionId, lookup) {
    if (!ancestorSessionId) return false;
    const self = String(agentId || '');
    if (!self || self === ancestorSessionId) return false;
    const find = typeof lookup === 'function' ? lookup : () => '';
    let cur = String(find(self) || '');
    for (let guard = 0; cur && guard < 32; guard++) {
        if (cur === ancestorSessionId) return true;
        cur = String(find(cur) || '');
    }
    return false;
}

// 某代理的直属上级会话：运行态优先，终态记录兜底。
export function parentSessionIdOf(agentId, liveOf, recordOf) {
    const live = liveOf ? liveOf.get(agentId) : null;
    if (live && live.parentSessionId) return live.parentSessionId;
    const rec = recordOf ? recordOf.get(agentId) : null;
    return (rec && rec.parentSessionId) || '';
}

// wait_agent 默认 / 最短 / 最长等待时长（对齐 dsh：等的是「我自己下一步的新输入」）。
// 最短 5 秒是防呆：0 曾表示「不限时」，不建 deadline 时会永久悬挂（见 resolveWaitTimeoutSec）。
// 最长 1800 秒（30 分钟）：给长任务留足空等余量，但仍建 deadline，不做不限时。
export const AI_INBOX_WAIT_DEFAULT_SEC = 60;
export const AI_INBOX_WAIT_MIN_SEC = 5;
export const AI_INBOX_WAIT_MAX_SEC = 1800;

// 子代理轮次预算：一轮 = 一次模型请求（一轮里可并行多个工具调用）。
// 默认值可在 设置 → AI 助手 → 子代理 → 默认轮次 调整；单次派单用 spawn_agent 的 maxRounds 覆盖。
// 2026-11-18 默认 50 → 200：bug-hunt 实测多层审计里中间层 50 轮先耗尽自动收尾，
// 还在跑的下级成孤儿，结论没地方投（配合嵌套预算继承与孤儿接管一起收口）。
export const AI_SUB_ROUNDS_MIN = 3;
export const AI_SUB_ROUNDS_MAX = 200;
export const AI_SUB_ROUNDS_DEFAULT = 200;

// 轮次预算的统一解析：配置值缺省 → 内置默认；单次显式值缺省 → 配置值。
// 不能直接用 aiClampInt(explicit, min, max, fallback)：它把 null / '' 算成 0 再 clamp 到 3，
// 于是「没给」会变成「只跑 3 轮」（同 resolveWaitTimeoutSec 的坑）。
export function resolveSubAgentRounds(explicit, configured) {
    const base = (configured === null || configured === undefined || configured === '')
        ? AI_SUB_ROUNDS_DEFAULT
        : aiClampInt(configured, AI_SUB_ROUNDS_MIN, AI_SUB_ROUNDS_MAX, AI_SUB_ROUNDS_DEFAULT);
    if (explicit === null || explicit === undefined || explicit === '') return base;
    return aiClampInt(explicit, AI_SUB_ROUNDS_MIN, AI_SUB_ROUNDS_MAX, base);
}

// wait_agent 的 timeoutSec 解析（导出供单测——这里是「永久悬挂」的唯一入口）。
// 不能用裸 aiClampInt：它走 Math.round(Number(x))，null / '' / false 全部变成 0 且都是
// finite（不会走 fallback），而 0 是不限时。2026-11-17 审查实测：模型传 "timeoutSec": null
// 就会让工具调用永不返回（没有 deadline，只能等 notify 或停止）。
export function resolveWaitTimeoutSec(value) {
    if (value === null || value === undefined || value === '') return AI_INBOX_WAIT_DEFAULT_SEC;
    return aiClampInt(value, AI_INBOX_WAIT_MIN_SEC, AI_INBOX_WAIT_MAX_SEC, AI_INBOX_WAIT_DEFAULT_SEC);
}

// 某子代理收件箱里「会被轮边界注入」的条数。ask 不算：它由 answerSubAsk 就地落定，不进队列。
export function pendingInboxCount(sub) {
    const inbox = sub && sub.inbox;
    if (!inbox) return 0;
    return (inbox.step || []).length + (inbox.turn || []).length;
}

// wait_agent 唤醒文案（导出供单测）。结果是一句话说明，模型读的是文案不是 JSON。
// 来源语义（2026-11-19 重设计，方案 docs/finished-plans/ai-wait-input-gestures.md）：
// 排队消息不打扰等待——只有插话（steer）与代理通知会唤醒，两种来源给不同的行动指令；
// 排队消息只在超时检查点提示（waitTimeoutText）。无来源（心跳 hasPending 兜底结算）时
// 按通用通知文案处理——排队车道不会走到这里。
export function waitWakeText(source) {
    if (source === 'steer') {
        return '用户插话了一条消息（不打断你的任务）：它会在下一条请求的轮边界注入你的上下文，'
            + '继续当前工作即可读到，无需结束本轮。';
    }
    return '收件箱有新输入（子代理完成通知 / 其他代理的消息），已随下一轮上下文注入——'
        + '读完按需继续；若无事可做可直接结束本轮。';
}

// wait_agent 超时文案。hasQueued：输入框是否有排队消息——排队不打扰等待，但模型该在
// 超时检查点知道有消息在等，工作告一段落时可自行收轮去接收（延迟上界 ≈ 一个 timeout），
// 而不是每次都把「超时」理解成「用户没来」继续干等。
export function waitTimeoutText(timeoutSec, hasQueued) {
    const base = '等待超时（' + timeoutSec + 's）：下一步还没有新输入。可继续 wait_agent，或先做别的——'
        + '子代理完成 / 别人投递 / 用户插话都会唤醒你。';
    if (!hasQueued) return base;
    return base + '\n另外：输入框有用户排队的消息（排队不打扰等待，结束本轮后它会作为正式用户消息'
        + '送达）——若当前工作已告一段落，可直接结束本轮去接收。';
}

// 收件箱双队列的纯函数部分（导出供单测：消费顺序与来源前缀是「插队优先、主/用户可辨」的
// 唯一依据，闭包里改动不易测，这里单独留出来）。
// 消费顺序：step（插队）在前、turn（排队）在后——两者各自保持入队顺序。
export function takeInboxBatch(inbox) {
    if (!inbox) return [];
    return [...(inbox.step || []).splice(0), ...(inbox.turn || []).splice(0)];
}

// 来源前缀：三方来源在子代理上下文里必须能区分（agentView 输入行）——
// user = 用户插话；subagent = 下级代理的结算/提问回报（嵌套第 2 层起走这条）；
// 其余（agent）= 派我的那个代理。**不写「主代理」**：嵌套时父是子代理，第 3 层看到
// 「主代理消息」会认错来源（2026-11-17 审查）。
export function inboxMessageText(item) {
    const source = item && item.from;
    const prefix = source === 'user' ? '［用户插话］'
        : (source === 'subagent' ? '［下级代理回报］' : '［上级代理消息］');
    return prefix + ' ' + String((item && item.text) || '');
}

// 冷唤醒准入：终态记录的可用性判断（失败 / 停止 / 上下文已回收都拒绝，附原因）。
export function canReviveRecord(record) {
    if (!record) return {ok: false, reason: 'missing'};
    if (record.state === 'error' || record.state === 'stopped') return {ok: false, reason: 'terminated'};
    if (record.continuable === false || !record.session) return {ok: false, reason: 'recycled'};
    return {ok: true, reason: ''};
}

// 记录是否诞生于本次唤醒之前（陈旧）：冷唤醒给旧记录打 revivedAt，新一轮落账时
// finishedAt 会超过它。**目前无生产调用者**——wait_agent 改成等收件箱后不再拿 record 当结论；
// 保留是因为冷唤醒的「旧结论 vs 新一轮」判定仍需要这个语义（将来若加「等冷却唤醒完成」会用到）。
export function isStaleRecord(record) {
    if (!record || !record.revivedAt) return false;
    return (Number(record.finishedAt) || 0) < record.revivedAt;
}

// 子代理记录按「根会话」归属（wait_agent / agent_send / agent_stop / agent_compact 共用口径）：
// 任一侧为空时放行（兼容旧记录与尚未填充 rootSessionId 的运行），都填了就必须相等。
// 别的任务树的 agentId 不能被投递 / 停止 / 压缩——那会消费对方收件箱或掐掉对方在跑的任务。
export function subTreeOwned(ownerRootId, recordRootId) {
    if (!ownerRootId || !recordRootId) return true;
    return ownerRootId === recordRootId;
}

// 某代理的整棵子树（全部层级的孙代理 / 曾孙代理），返回 id 列表（不含 rootId）。
// 用于 agent_stop 级联：主代理手上只有直接下级的 id，嵌套代理的 id 它看不到。
// subs 是运行态 / 记录条目数组（需带 id 与 parentSessionId），BFS 按 parentSessionId 链展开。
export function subTreeIdsOf(subs, rootId) {
    const root = String(rootId || '');
    const list = subs ? [...subs] : [];
    if (!root || !list.length) return [];
    const byParent = new Map();
    for (const sub of list) {
        if (!sub || !sub.id) continue;
        const pid = String(sub.parentSessionId || '');
        if (!pid) continue;
        if (!byParent.has(pid)) byParent.set(pid, []);
        byParent.get(pid).push(String(sub.id));
    }
    const out = [];
    const seen = new Set([root]);
    const queue = [root];
    while (queue.length) {
        const pid = queue.shift();
        for (const id of byParent.get(pid) || []) {
            if (seen.has(id)) continue;
            seen.add(id);
            out.push(id);
            queue.push(id);
        }
    }
    return out;
}

// 子代理会话 scope（纯读边界，§0.3 第 3 条）：工作区外读授权沿用父会话档的实时判定链
// （ai-read-roots.js 判定时回查父会话，不快照复制），full 封顶 auto——decidePermission 的
// read 分支对 auto 直接放行工作区外，读能力与 full 档等价。这个字段**不再参与沙箱 / 工具面 /
// 写判定**（那是能力快照 fs/tools 的事），沙箱模式见 subSandboxPolicy。
export function subReadScopeOf(parentScope) {
    if (parentScope === 'full') return 'auto';
    return AI_SCOPES.includes(parentScope) ? parentScope : 'read';
}

// 命令审计摘要（路 B 轻量版留痕）：只记命令族（第一个可执行名）与 cwd，绝不记命令正文 /
// 参数——参数可能含密钥、令牌，方案 §5 不记输出正文同理。命令族取不到时返回 null，
// 留痕就不带这两个字段。这是纯函数，供派单工具循环与测试共用。
export function commandAuditSummary(toolName, input) {
    if (toolName !== 'run_command' && toolName !== 'background_command') return null;
    const data = input && typeof input === 'object' ? input : {};
    const detail = {};
    const raw = String(data.command == null ? '' : data.command).replace(/\r\n?/g, '\n').trim();
    const first = raw.split('\n')[0].trim();
    const m = first.match(/^([^\s;&|><]+)/);
    if (m) {
        const base = m[1].split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1|sh)$/i, '').slice(0, 80);
        if (base) detail.cmdFamily = base;
    }
    const cwd = String(data.cwd == null ? '' : data.cwd).trim();
    if (cwd) detail.cwd = cwd.slice(0, 260);
    return Object.keys(detail).length ? detail : null;
}

// 子代理的命令沙箱策略；**主会话返回 null**（主会话的边界是审批链，不是沙箱）。
// 沙箱档来自能力快照 fs.mode（派出时定死），不再从 scope 反推（§5.4）；workspaceRoot 由
// 快照在派单时解析定死（worktree 优先、其次会话工作区）。快照缺失（异常 / 旧数据）按最窄
// read-only 处理，绝不在这里悄悄降级成「不沙箱」；取不到根留空 → Go 侧 fail-closed 拒绝。
export function subSandboxPolicy(session, fallbackRoot) {
    if (!session || !session.parentSessionId) return null;
    const fs = session.capabilities && session.capabilities.fs ? session.capabilities.fs : READ_ONLY_CAPABILITIES.fs;
    const wt = normalizeWorktreeState(session.worktree);
    const root = aiTextOf(fs.workspaceRoot) || (wt && aiTextOf(wt.path)) || aiTextOf(session.workspace) || aiTextOf(fallbackRoot);
    return {mode: fs.mode, workspaceRoot: root};
}

// 工具主参数速览：优先取「点名到具体对象」的字段，避免把整段 JSON 塞进工具行标题。
export function agentToolArgBrief(args) {
    let parsed = null;
    try {
        parsed = typeof args === 'string' ? parseJson(args, {}) : (args || null);
    } catch (e) {
        return '';
    }
    if (!parsed || typeof parsed !== 'object') return '';
    for (const key of ['path', 'pattern', 'query', 'url', 'name', 'task', 'prompt', 'text']) {
        const value = parsed[key];
        if (typeof value !== 'string' || !value.trim()) continue;
        const line = value.replace(/\s+/g, ' ').trim();
        return line.length > 60 ? line.slice(0, 60) + '…' : line;
    }
    return '';
}

// 详情视图的块模型（导出供单测：块 key 与顺序是增量渲染「不重复、不丢块」的唯一依据）。
// 运行态取子代理自己的消息数组，终态取内存转录——两者形状不同，但都收敛到同一组块。
export function agentMessageBlocks(messages) {
    const blocks = [];
    (messages || []).forEach((m, index) => {
        if (!m) return;
        if (m.role === 'user') {
            blocks.push({key: 'm' + index, kind: 'user', text: String(m.content || '')});
        } else if (m.role === 'assistant') {
            const text = String(m.content || '').trim();
            // 思考与流式中间态不渲染，只看已落定的正文与工具
            if (text) blocks.push({key: 'm' + index, kind: 'assistant', text});
        } else if (m.role === 'tool') {
            blocks.push({
                key: 'm' + index, kind: 'tool', name: m.name,
                arg: agentToolArgBrief(m.arguments),
                text: String(m.content || ''), error: m.status === 'error',
            });
        }
    });
    return blocks;
}

export function agentTranscriptBlocks(transcript) {
    const blocks = [];
    (transcript || []).forEach((entry, index) => {
        if (!entry) return;
        if (entry.role === 'assistant') blocks.push({key: 't' + index, kind: 'assistant', text: String(entry.text || '')});
        else if (entry.role === 'tool') blocks.push({key: 't' + index, kind: 'tool', name: entry.name, text: String(entry.text || '')});
    });
    return blocks;
}

// 终态记录的块：**沿用运行态那套消息块**（key 同样是 m<i>），末尾补一张结论摘要卡。
// 为什么不能换成「摘要 + 转录」：done → 唤醒（agent_send / 用户插话）→ done 是子代理最常见的
// 交互形态，两套模型交替会让块 key 从 m<i> 变成 t<i>，正文节点整批删除重建——滚动位置被钳走、
// 图表卡片的 Shadow DOM 全毁，视图看起来就是「每来一条消息就跳回顶部」（2026-11-16 实测）。
// 摘要是本轮 assistant 正文的拷贝时不再重复挂：重复会多出一块，收尾瞬间高度又抖一次。
export function agentRecordBlocks(messages, summary) {
    const blocks = agentMessageBlocks(messages);
    const text = String(summary == null ? '' : summary).trim();
    if (!text) return blocks;
    const last = blocks.length ? blocks[blocks.length - 1] : null;
    if (last && last.kind === 'assistant' && String(last.text || '').trim() === text) return blocks;
    blocks.push({key: 'summary', kind: 'summary', text});
    return blocks;
}

// 签名里带 streaming 标记：流式期间可视化卡片只占位，块落定后签名变化，
// 再渲染一次把占位换成真实卡片（与主消息区的 renderSig/streaming 写法同源）。
export function agentBlockSig(block, streaming) {
    const text = String((block && block.text) || '');
    return (block && block.kind) + '|' + (streaming ? 's' : 'd') + (block && block.error ? '!' : '') +
        (block && block.arg ? '@' + block.arg : '') +
        '|' + text.length + ':' + text.slice(-96);
}

// 详情视图工具行的默认折叠判定（导出供单测）。子代理详情是只读速览，长输出默认收起、
// 点箭头展开；短输出直接铺开。命令/搜索/列目录这类工具即使输出不长也常带多行噪声，
// 一律默认收起，避免一屏被工具输出占满（主消息区工具卡同款策略）。
export function agvToolDefaultCollapsed(name, text) {
    const len = String((text == null ? '' : text)).length;
    if (len > 400) return true;
    return ['run_command', 'background_command', 'search_text', 'list_dir', 'glob', 'check_command'].includes(name);
}

// 子代理详情标签页标题的状态前缀（导出供单测）：纯文本符号，不上色、控制范围。
// running 带转圈符号，让一标签栏里一眼看出谁还在跑；终态用对勾/叉/方块区分。
export function agentViewTabName(name, state) {
    const base = String(name || '子代理').replace(/\s+/g, ' ').trim() || '子代理';
    const prefix = {running: '⟳ ', done: '✓ ', error: '✕ ', stopped: '■ '}[state] || '';
    return prefix + base;
}

// 运行态行文本（标签 tooltip 用）：轮次 · 耗时 · token · 状态，与详情头部同口径。
export function agentViewRuntimeText(snapshot) {
    if (!snapshot) return '';
    const bits = [];
    if (snapshot.rounds) bits.push('轮次 ' + snapshot.rounds);
    if (snapshot.ms) bits.push(Math.max(1, Math.round(snapshot.ms / 1000)) + 's');
    if (snapshot.tokens) bits.push((snapshot.tokens / 1000).toFixed(1) + 'k tok');
    const stateText = {running: '运行中', done: '已完成', error: '失败', stopped: '已停止'}[snapshot.state] || snapshot.state || '';
    if (stateText) bits.push(stateText);
    return bits.join(' · ');
}

export function createAISubagents(ctx) {
    const el = ctx.el;
    const panel = ctx.panel;
    const backend = ctx.backend;
    const flash = ctx.flash;
    const notifyFailure = typeof ctx.notifyFailure === 'function' ? ctx.notifyFailure : () => {};
    const renderMarkdown = ctx.renderMarkdown;
    const openTermTab = ctx.openTermTab;
    // 能力确认卡（§6.3）与隔离 worktree 的工作区根：**必须从工厂 deps ctx 解构**——
    // startSubAgent(ctx, input) 的形参 ctx 是工具 ctx（只有 session/toolMessage/stream），
    // 会遮蔽工厂 ctx；曾因直接读 ctx.requestActionApproval / ctx.getScopeRoot 导致确认卡
    // 永不弹、worktree 派单恒抛「没有工作区范围」（2026-11-28 审查实证）。
    const requestActionApproval = typeof ctx.requestActionApproval === 'function' ? ctx.requestActionApproval : null;
    const getScopeRoot = typeof ctx.getScopeRoot === 'function' ? ctx.getScopeRoot : null;
    // 详情视图的宿主出口：主窗口在内容区开标签页（bridge-agent-view.js），悬浮窗退回面板覆盖层
    const openAgentTab = typeof ctx.openAgentTab === 'function' ? ctx.openAgentTab : null;
    const isFloatWindow = typeof ctx.isFloatWindow === 'function' ? ctx.isFloatWindow : () => false;
    // 正文增强链（代码复制钮 / 本地图片 / mermaid·echarts·svg 可视化卡片）：与主消息区同一条
    const enhanceAnswerBody = typeof ctx.enhanceAnswerBody === 'function' ? ctx.enhanceAnswerBody : null;
    // 工具行动词+图标映射：复用主消息区 toolMeta（经 ctx 注入），缺省时详情视图回退裸工具名
    const toolMeta = typeof ctx.toolMeta === 'function' ? ctx.toolMeta : null;
    const currentSession = ctx.currentSession;
    const persistSessions = ctx.persistSessions;
    const sessionById = ctx.sessionById;
    const entryOf = ctx.entryOf;
    const profileOf = ctx.profileOf;
    // read_video 下发按会话视频能力裁剪（与主会话同判定）；缺省恒 true 兼容无该依赖的测试
    const videoCapableOf = typeof ctx.videoCapableOf === 'function' ? ctx.videoCapableOf : (() => true);
    const configForProfile = ctx.configForProfile;
    // 子代理请求配置（模型档）：设置 → AI 助手 → 子代理里指定了专用模型就走它，否则跟随
    // 派出方的模型。缺省回退 configForProfile，兼容不含该依赖的测试上下文。
    const subAgentConfigFor = typeof ctx.subAgentConfigFor === 'function' ? ctx.subAgentConfigFor : configForProfile;
    // 子代理模型档目标（null = 跟随派出方）。缺省返回 null，兼容不含该依赖的测试上下文。
    const subAgentModelTarget = typeof ctx.subAgentModelTarget === 'function' ? ctx.subAgentModelTarget : () => null;
    // 本次派单点名的模型（白名单校验在 ai-panel 一侧完成；候选外的值直接抛错）。
    const subAgentModelPick = typeof ctx.subAgentModelPick === 'function' ? ctx.subAgentModelPick : () => null;
    // 自选模型候选清单：孙代理的 spawn_agent 也要看到同一份候选（def 动态生成）。
    const subAgentModelChoices = typeof ctx.subAgentModelChoices === 'function' ? ctx.subAgentModelChoices : () => [];
    const executeTool = ctx.executeTool;
    // read_image 把画面挂成独立 user 消息：必须在工具批次结束后落盘（批次中途 push 会拆开
    // assistant(tool_calls) 与 tool 结果），与主循环共用面板那一份 flush。
    const flushToolImages = typeof ctx.flushToolImages === 'function' ? ctx.flushToolImages : null;
    const buildApiMessages = ctx.buildApiMessages;
    const refreshToolWrap = ctx.refreshToolWrap;
    const renderSessionList = ctx.renderSessionList;
    const aiDelay = ctx.aiDelay;
    const syncBgCardState = ctx.syncBgCardState;
    const reconcileBgJobs = ctx.reconcileBgJobs;
    const toolArgsErrorText = ctx.toolArgsErrorText;
    const agentRegistry = ctx.agentRegistry;
    const bgJobIndex = ctx.bgJobIndex;
    const bgJobLive = ctx.bgJobLive;
    const bgJobCursors = ctx.bgJobCursors;
    const bgUpdateListeners = ctx.bgUpdateListeners;
    const getChipsPopKind = ctx.getChipsPopKind;
    const setChipsPopKind = ctx.setChipsPopKind;
    const getConfig = ctx.getConfig;
    const newAssistantMessage = ctx.newAssistantMessage;
    const getSessions = ctx.getSessions;
    // 懒加载会话补正文（面板注入）：详情头部的状态兜底要用它——只补「所属会话」这一个，
    // 绝不为了找一个 spawn_agent 记录去扫全部会话。
    const ensureSessionLoaded = typeof ctx.ensureSessionLoaded === 'function'
        ? ctx.ensureSessionLoaded
        : () => Promise.resolve(true);
    // 操作留痕（ai-panel 闭包 helper）：子代理工具拒绝落盘；activity 为空时静默降级
    const logActivity = ctx.logActivity;
    // 压缩判定需要「窗口大小」与「当前上下文估算」——与主会话同一口径，不另立一套
    const contextWindowOf = ctx.contextWindowOf;
    // 保留预算的输出预留（模型条目 outputWindow / 全局 maxTokens），与主会话同源
    const outputReserveOf = ctx.outputReserveOf || (() => 0);
    const estimateApiMessagesTokens = ctx.estimateApiMessagesTokens;
    // 实测 usage 锚点：与主会话同一口径（锚点由面板的 buildApiMessages 侧信道提供）
    const estimateApiMessagesContext = ctx.estimateApiMessagesContext;
    const getBuildAnchor = ctx.getBuildAnchor || (() => null);
    // 等待原语（ai-inbox-wait.js）：子代理收件箱入队即唤醒在该代理上 wait_agent 的调用方
    // （典型是父代理在等这个下级回报）。内容仍在轮边界由 consumeSubInbox 注入。
    const inboxWaiters = ctx.inboxWaiters;
    // 主会话「消息队列两条车道」的快照：{queue: 有排队消息, steer: 有待注入插话}。
    // **必须在这里取**：工具 ctx 只有 {session, toolMessage, stream}，从那里读恒为 undefined
    // （等于把这个判定关掉）。排队不打扰等待——只有 steer 算 wait_agent 的待消费输入；
    // queue 只用于超时检查点提示「输入框有排队消息」（见 waitForInbox 超时分支）。
    const queueLanesOf = ctx.queueLanesOf;

    // —— 随域迁入的子代理状态与限额常量（原 ai-panel.js 闭包级）——
    const AI_SUB_LIMIT_DEFAULT = 20;
    const AI_SUB_LIMIT_MAX = 20;
    const AI_SUB_DEPTH_MAX = 20;
    // wait_agent 的默认 / 最短 / 最长时长在模块级（AI_INBOX_WAIT_DEFAULT_SEC / _MIN_SEC / _MAX_SEC），
    // 因为 resolveWaitTimeoutSec 是导出的纯函数，三者必须同一来源。
    // 主对话没有逐轮硬上限（靠 auto-compact 控体量）；子代理的轮次预算可在设置里调
    // （AI_SUB_ROUNDS_DEFAULT 是内置默认），撞顶时由强制收尾轮产出结论（见 runSubRound）。
    // AI_SUB_MESSAGES_MAX 是第二道闸门：工具调用多时可能先撞消息数而不是轮次。
    const AI_SUB_MESSAGES_MAX = 400;
    // 终态记录保留上限（LRU）：超出先降级为「仅状态 + 结论摘要、不可续」，再超就删最早的。
    // 冷唤醒与子代理压缩都需要活引用（sub.session / profile / entry），不能 done 即删。
    const AI_SUB_RECORDS_MAX = 20;
    // 只留摘要（不可续）的记录上限：降级本身不再占用"活跃记录"配额，
    // 但也不能无限留壳，超出后从最旧的降级记录开始真删。
    const AI_SUB_DEGRADED_MAX = 8;
    // 子代理系统提示（§12.1）：只读 / 写授权两套开场白 + 公共尾部，按能力快照拼装；
    // preset 的 promptSections（persona / 角色文案）追加在末尾。越权防护话术（工具面派出时
    // 固定）是公共的——写授权只改变「能不能写」，不改变「不能从会话内升权」。
    // 三套开场白按**实际工具面**（tools.allow 里有没有写工具）选择，不是按 fs.mode：
    // host.default 在 auto 父档下 fs.mode=workspace-write 但没有写工具（写效应只经沙箱命令），
    // 按 mode 选会让提示词承诺工具面没有的能力（2026-11-28 审查指出的三处失真）。
    // commandOn：只读头的「不要执行命令」与命令通道段落自相矛盾，按 execution.command 联动。
    const AI_SUB_PROMPT_HEADER_READONLY = (commandOn) => [
        '你是主代理派出的只读子代理：独立完成任务后输出最终结论，不与用户直接交互。',
        '约束：只做只读探索（列目录 / 读文件 / 看图片（本地文件或公网图片 URL）/ 搜索 / 联网检索 / 记忆读取 / 技能加载）；不要尝试修改文件'
            + (commandOn ? '；命令通道仅用于只读验证（写效应会被沙箱拒绝）' : '；不要尝试执行命令')
            + '；不要直接向最终用户发问（后台模式可用 ask_user 问主代理，由主代理决定）。',
    ].join('\n');
    const AI_SUB_PROMPT_HEADER_WRITE = (rootsText) => [
        '你是主代理派出的子代理：独立完成任务后输出最终结论，不与用户直接交互。',
        '约束：文件写入只落在授权的可写范围内（' + rootsText + '），范围外写入会被直接拒绝；其余操作与只读子代理同一边界；不要直接向最终用户发问（后台模式可用 ask_user 问主代理，由主代理决定）。',
    ].join('\n');
    const AI_SUB_PROMPT_HEADER_FULL = [
        '你是主代理派出的完全权限子代理：独立完成任务后输出最终结论，不与用户直接交互。',
        '约束：文件写入没有路径边界（完全授权，可写工作区外任意路径）、命令不进沙箱——只在任务确有必要时动用；操作留痕不记命令正文与目标路径，事后难以追溯；不要直接向最终用户发问（后台模式可用 ask_user 问主代理，由主代理决定）。',
    ].join('\n');
    const AI_SUB_PROMPT_TAIL = [
        '你的工具范围在派出时已固定，无法从会话内放宽：范围外工具会被直接拒绝——不要换参数或写法重试，在最终结论中说明该限制即可，由主代理决定如何处理。',
        'timer_list 是主会话计时器的只读共享时钟：可用来对齐时间基准（正计时已计时长 / 倒计时剩余），但不能启动、停止或打标记；读数只是调用瞬间的快照，不会阻塞等待，不要靠反复调用来「等 N 秒」。',
        // 投递契约（§4.8）：投递层不截断（阶段 B 移除了 8000 字符上限），结论的紧凑性靠这里自律。
        '结果投递契约：主代理只会收到你的最终结论文本，看不到你的完整转录、工具输出或推理过程——最终结论必须自带结果与关键证据（path:line），不要指望父代理从过程记录里找信息。',
        '完成后输出一段结构化最终结论（要点 + 证据 path:line），它是你返回给主代理的唯一结果。',
    ].join('\n');

    const subAgents = new Map();      // subId -> 子代理运行态
    const subAgentTranscripts = new Map(); // spawn key -> [{role, name?, text}]
    // agentId -> 终态记录（含 sub.session / profile / entry 活引用）：冷唤醒、子代理压缩、
    // HUD 兜底都靠它。subAgents 仍只含运行中——事件路由先查 subAgents，records 只作兜底。
    const subAgentRecords = new Map();
    // 子代理压缩流注册表：compactId -> {id, subId, buffer, startedAt, auto, live}。
    // **不能复用全局 oneShot**（§4.10.1）：后台子代理压缩时父会话常在流式，全局锁会互相卡死。
    const subCompacts = new Map();
    let subCompactSeq = 0;

    // 详情视图（phase3 A4a 拆出的同域兄弟模块）：ctx 同源直传；块模型纯函数与运行态注册表
    // （const Map 活引用）、运行时动作经 extras 注入（运行时函数在后文定义，惰性箭头延迟解析）。
    // 留守侧调用点（subThrottleRender / subTranscriptPush / 运行时刷新）与返回面经同名别名零改动。
    const viewMod = createAIAgentView(ctx, {
        agentMessageBlocks, agentRecordBlocks, agentTranscriptBlocks, agentBlockSig, canReviveRecord,
        agvToolDefaultCollapsed,
        subAgents, subAgentRecords, subAgentTranscripts,
        steerSubAgent: (...args) => steerSubAgent(...args),
        queueSubAgentMessage: (...args) => queueSubAgentMessage(...args),
        reviveSubAgent: (...args) => reviveSubAgent(...args),
        stopSubAgent: (...args) => stopSubAgent(...args),
        // 详情视图的手动停止：级联停掉该代理派出的全部下级（自停 / 自动停止仍走 stopSubAgent）
        stopSubAgentDeep: (...args) => stopSubTree(...args),
        startSubCompact: (...args) => startSubCompact(...args),
        agentStateBadge: (...args) => agentStateBadge(...args),
        // 重启后从磁盘补读转录（正文在 ai-artifacts，见 finalizeSubAgent 的落盘）
        loadAgentTranscript: (...args) => loadAgentTranscriptFromDisk(...args),
        toolMeta,
    });
    const agentViews = viewMod.agentViews;
    const scheduleAgentViewRender = (...args) => viewMod.scheduleAgentViewRender(...args);
    const refreshAgentViewIfOpen = (key) => {
        // 详情正文刷新 + 内容区标签页状态订阅同步（一处接线覆盖 running/done/stop/收件箱等全部变化）
        notifyAgentViewListeners(key);
        return viewMod.refreshAgentViewIfOpen(key);
    };
    const renderAgentView = (...args) => viewMod.renderAgentView(...args);
    const openAgentView = (...args) => viewMod.openAgentView(...args);
    const mountAgentView = (...args) => viewMod.mountAgentView(...args);
    const unmountAgentView = (...args) => viewMod.unmountAgentView(...args);

    // 团队详情视图（内容区标签页）：数据取自 HUD 的同源条目（listAgentsForHud 支持指定会话）。
    // 与 HUD 互引：teamMod 先声明、后赋值，HUD 的 onAgentsChanged 经闭包延迟读取。
    let teamMod = null;

    // 头部 HUD（phase3 A4b 拆出的同域兄弟模块）：ctx 同源直传；运行态注册表（const Map 活引用）
    // 与运行时动作 / 视图入口经 extras 注入。留守侧调用点（运行时刷新 / 派单归属判定）与
    // 返回面经同名惰性别名零改动。
    const hudMod = createAIHeadHud(ctx, {
        subAgents, subAgentRecords,
        unseenInboxCount: (...args) => unseenInboxCount(...args),
        openAgentView: (...args) => openAgentView(...args),
        onAgentsChanged: () => {
            if (teamMod) teamMod.refreshTeamViewsIfOpen();
        },
    });
    const sessionTitleOf = (...args) => hudMod.sessionTitleOf(...args);
    const sessionTitleById = (...args) => hudMod.sessionTitleById(...args);
    const updateHeadIdentity = (...args) => hudMod.updateHeadIdentity(...args);
    const bgJobStateOf = (...args) => hudMod.bgJobStateOf(...args);
    const rootSessionIdOf = (...args) => hudMod.rootSessionIdOf(...args);
    const hudSessionId = (...args) => hudMod.hudSessionId(...args);
    const bgEntryOwnerId = (...args) => hudMod.bgEntryOwnerId(...args);
    const isBgEntryOfHud = (...args) => hudMod.isBgEntryOfHud(...args);
    const hudBgEntries = (...args) => hudMod.hudBgEntries(...args);
    const sessionHasLiveBgJob = (...args) => hudMod.sessionHasLiveBgJob(...args);
    const runningBgCount = (...args) => hudMod.runningBgCount(...args);
    const listAgentsForHud = (...args) => hudMod.listAgentsForHud(...args);
    const setChipCount = (...args) => hudMod.setChipCount(...args);
    const notifyBackgroundActivity = (...args) => hudMod.notifyBackgroundActivity(...args);
    const refreshHeadChips = (...args) => hudMod.refreshHeadChips(...args);
    const updateHeadHud = (...args) => hudMod.updateHeadHud(...args);
    const hideChipsPop = (...args) => hudMod.hideChipsPop(...args);
    const positionChipsPop = (...args) => hudMod.positionChipsPop(...args);
    const agentStateBadge = (...args) => hudMod.agentStateBadge(...args);
    const agentStatusIcon = (...args) => hudMod.agentStatusIcon(...args);
    const bgJobFirstLine = (...args) => hudMod.bgJobFirstLine(...args);
    const taskSnippet = (...args) => hudMod.taskSnippet(...args);
    const openBgTermInContent = (...args) => hudMod.openBgTermInContent(...args);
    const renderChipsPop = (...args) => hudMod.renderChipsPop(...args);
    const toggleChipsPop = (...args) => hudMod.toggleChipsPop(...args);
    const initHud = (...args) => hudMod.initHud(...args);
    // HUD 就绪后建团队视图（依赖 listAgentsForHud，故排在 hudMod 之后）
    teamMod = createAITeamView(ctx, {
        listAgentsForHud: (...args) => listAgentsForHud(...args),
        openAgentView: (...args) => openAgentView(...args),
    });
    const mountTeamView = (...args) => teamMod.mountTeamView(...args);
    const unmountTeamView = (...args) => teamMod.unmountTeamView(...args);
    // 收件箱（阶段 C 起启用）：排队 / 插队 / 提问挂起。这里先建结构，B 阶段不消费。
    function newSubInbox() {
        return {step: [], turn: [], ask: null};
    }

    // 上限统计 subAgents 里所有层级的运行中子代理（不含主代理），由设置页配置。
    function subAgentLimit() {
        return aiClampInt(getConfig().subAgentMax, 1, AI_SUB_LIMIT_MAX, AI_SUB_LIMIT_DEFAULT);
    }

    // 0 = 不设限；N = 整棵树最多 N 层（**含主代理**：主代理第 1 层，直接派出的子代理第 2 层）。
    // 内部 depth 仍以主代理为 0，判定时 +1 换算成层号，与界面/工具文案同一口径。
    // 设置里的默认轮次预算（spawn_agent 未点名 maxRounds 时用）。值经纯函数钳制，
    // 也顺手喂给工具描述，让模型看到的是真实默认值而不是写死的 50。
    function subAgentRoundsDefault() {
        return resolveSubAgentRounds(undefined, getConfig().subAgentRounds);
    }

    // 层级上限含主代理：3 = 主代理 + 2 层子代理（子代理能派孙代理，孙代理不能再派）。
    // 0 仍在钳制范围内表示「不设限」，保留给显式选择放宽的用户；缺字段时回落 3
    // （与 ai-panel 的 config 默认一致）。层数比「子代理嵌套层数」大 1，因为主代理占第 1 层。
    function subAgentMaxDepth() {
        return aiClampInt(getConfig().subAgentMaxDepth, 0, AI_SUB_DEPTH_MAX, 3);
    }

    // depth 是当前代理自己的 depth；它派出的子代理层号是 depth + 2。
    function subAgentCanSpawn(depth) {
        const maxDepth = subAgentMaxDepth();
        return !maxDepth || depth + 1 < maxDepth;
    }

    function subSystemPromptFor(depth, mode, caps, hasWorktree) {
        const fs = caps && caps.fs ? caps.fs : READ_ONLY_CAPABILITIES.fs;
        const commandOn = !!(caps && caps.execution && caps.execution.command === 'sandboxed');
        const allow = new Set(caps && caps.tools && Array.isArray(caps.tools.allow) ? caps.tools.allow : []);
        const canWriteFiles = allow.has('write_file') || allow.has('edit_file');
        // 开场白按实际工具面选（见上方三套头部常量的注释）：写工具在 → WRITE / FULL；
        // 没有写工具 → READONLY（命令段措辞随 execution.command 联动）。
        let text;
        if (canWriteFiles && fs.mode === 'danger-full-access') {
            text = AI_SUB_PROMPT_HEADER_FULL;
        } else if (canWriteFiles) {
            text = AI_SUB_PROMPT_HEADER_WRITE((fs.writableRoots || []).join('、') || '（见派单信息）');
        } else {
            text = AI_SUB_PROMPT_HEADER_READONLY(commandOn);
        }
        if (mode === 'background') {
            text += '\n你在后台运行：主代理不会等你结束，完成后由系统把结论通知给它；期间可以安心把探索做完整。';
            text += '\n关键决策点可以用 ask_user 向主代理提问（由主代理决定答案，或转询用户）：等待回答期间你的轮次暂停，约 2 分钟没有回答就请基于现有上下文自行决定并继续。';
        }
        // 再派下层：层级允许 + 快照 delegation.canSpawn 双闸（快照只收窄不放宽，§3）。
        if (subAgentCanSpawn(depth) && (!caps || caps.delegation.canSpawn !== false)) {
            text += '\n需要并行 / 隔离调查时可以再用 spawn_agent 派下一层只读子代理（并发数与层级受设置限制）；简单问题直接自己做。'
                + '\n用 mode=\'background\' 派出后可以 wait_agent 等下一步输入：下级的完成通知会进你的收件箱，'
                + '任一回报到达时 wait 立即返回，你在下一轮开头读到；不 wait 也可以，通知同样会在下一轮注入。'
                + '\n下级向你提问时（收件箱里的「［子代理提问 · X］… askId=…」）用 agent_send(agentId=…, askId=…, message=…) 作答；'
                + '也可以 agent_send 给运行中的下级补线索（urgent=true 插队纠正方向）。你只能发给自己派出的下级——'
                + '要向上汇报请写在最终结论里，主代理会收到。';
        }
        if (hasWorktree) {
            text += '\n你有一个隔离 git worktree 作为草稿工作区：所有文件改动写到 .cadt/worktree/<slug>/…（相对范围根，路径见派单信息），隔离前缀之外的写会被拒绝；写操作自动应用（隔离区即审批边界），隔离前缀之外一律不要写。'
                + '\n不要 commit 到隔离分支；完成后在结论里列出你改动的文件清单，由主代理决定是否导出补丁回灌主根。';
        }
        if (commandOn) {
            // 命令通道（沙箱档）：shell 是 PowerShell，模型必须提前知道，否则会照着 bash 习惯写
            // ls / grep / sed 然后一头撞死。命令边界来自快照 fs.mode（§5.4）。
            text += '\n你可以用 run_command 验证结论（跑测试、git log、查版本、看构建是否还过）。命令在 OS 沙箱里执行：'
                + (hasWorktree
                    ? '写效应只允许落在你的隔离 worktree（.cadt/worktree/<slug>/）内'
                    : '写效应只允许落在本次任务的工作区根内')
                + '，其余写入由系统拒绝。'
                + '\n**沙箱里的 shell 是 PowerShell，不是 bash**：用 PowerShell 语法（Get-ChildItem / Select-String / Test-Path），不要用 ls / grep / sed / awk；git、go、npm 等外部命令本身不受影响。'
                + '\n耗时任务（构建、长测试、watch）用 background_command 起、check_command 轮询、stop_command 收尾，别用 run_command 干等。'
                + '\n被沙箱拒绝或提示「沙箱不可用」时不要重试、不要绕道用别的工具改文件，在结论里如实写「因沙箱限制未验证」。'
                + '\n其中报「授权写根 … Access is denied」是宿主机权限问题（工作区目录属于另一个账户，当前账户没有它的「更改权限」），'
                + '本次会话的命令通道不可用：改用只读工具完成调查，并在结论里说明哪些结论未用命令验证。';
        } else {
            text += '\n你没有命令通道（run_command / background_command 未授权）：不要尝试执行命令；'
                + '需要验证的结论在最终结论中如实写「未用命令验证」。';
        }
        // preset 的提示片段（§4.1 promptSections）：persona / 角色文案追加在基础提示之后；
        // preset 已卸载时按快照能力降级运行（§8.2），片段自然消失即可，不报错。
        if (caps && caps.preset) {
            const entry = getAgentPreset(caps.preset);
            const sections = entry ? presetPromptSections(entry.preset) : '';
            if (sections) text += '\n\n' + sections;
        }
        return text;
    }

    // 子代理工具面投影（§5.1）：由能力快照 tools.allow/deny 决定「许可」，环境条件决定
    // 「可用」——视频能力 / 认知开关 / 后台 ask_user / 层级再派都是环境闸，不是权限闸。
    // 快照在派单时定死（不可变），集合在每个模型步骤前重新解析（兼容插件动态注册的
    // 环境变化）；已开始的调用继续执行，新步骤使用新集合。
    function subToolsForCapabilities(sub) {
        const caps = sub && sub.capabilities ? sub.capabilities : READ_ONLY_CAPABILITIES;
        const allow = new Set(caps.tools && Array.isArray(caps.tools.allow) ? caps.tools.allow : []);
        const deny = new Set(caps.tools && Array.isArray(caps.tools.deny) ? caps.tools.deny : []);
        const has = (name) => allow.has(name) && !deny.has(name);
        const session = sub.session;
        const depth = sub.depth;
        const mode = sub.mode;
        // 再派下层：层级允许 + 快照 delegation.canSpawn 双闸（快照只收窄不放宽，§3）。
        const canSpawn = subAgentCanSpawn(depth)
            && (!caps.delegation || caps.delegation.canSpawn !== false);
        // 顺序与旧实现一致：read_video 保持 splice(4,0) 位次契约（code_outline 注释同源）。
        const list = [
            AI_TOOL_DEFS.list_dir, AI_TOOL_DEFS.read_file, AI_TOOL_DEFS.read_image, AI_TOOL_DEFS.search_text,
            AI_TOOL_DEFS.web_search, AI_TOOL_DEFS.web_fetch,
            // 代码大纲：只读读取（maintain 由会话权限档判定）。
            AI_TOOL_DEFS.code_outline,
            AI_TOOL_DEFS.memory_list, AI_TOOL_DEFS.memory_read,
            // 主会话计时器的只读快照：子代理与孙代理共享本表，只有读权（不能启动 / 停止 / 打标记）
            AI_TOOL_DEFS.timer_list,
            // 团队树只读：子代理看到自己这一支（含自己派出的下级），用于汇报结构 / 拿下级 id
            AI_TOOL_DEFS.agent_tree,
            AI_TOOL_DEFS.skill_use, AI_TOOL_DEFS.env_list,
        ].filter((def) => has(def.name));
        // 认知索引只读两件（可选启用，默认关，§5.2）：调查任务可查条目；edit 不派——发现条目
        // 该维护时汇报回父代理去 cognition_edit（快照写能力不含它）。
        if (has('cognition_read') && typeof ctx.cognitionOn === 'function' && ctx.cognitionOn()) {
            list.push(AI_TOOL_DEFS.cognition_read, AI_TOOL_DEFS.cognition_status);
        }
        // ask_user 只在后台模式挂载（§4.5 原语 6 的实现陷阱）：阻塞模式的父回合被 await
        // 占住，没人能回答，挂上去必然 120s 超时——按模式硬性区分，不靠提示词自觉。
        // 快照 interaction.askParent=false（§0.1 第 3 条拆分）时不挂。
        if (has('ask_user') && mode === 'background'
            && (!caps.interaction || caps.interaction.askParent !== false)) list.push(AI_TOOL_DEFS.ask_user);
        if (canSpawn) {
            list.push(buildSpawnAgentDef(subAgentModelChoices(), subAgentRoundsDefault()), AI_TOOL_DEFS.wait_agent);
            // agent_send 与 spawn/wait 同批挂：能派单就必须能收回报、也能回答下级的提问。
            // 此前只有主代理有它，于是嵌套提问（层3 问 → 层2 答）在层2 手里没有作答工具，
            // 只能等 120s 超时按 ai_decide 放行（2026-11-17 审查发现，方案文档 §5）。
            // 只有「还能派单的层」才可能有下级，到层级上限的层给了也没对象；方向限死为自己的下级。
            list.push(AI_TOOL_DEFS.agent_send);
        }
        // 写工具：只由快照 tools.allow 决定（§5.3）——worktree 是隔离方式，不再是写工具开关；
        // worktree 子代理的快照在派单时已注入 write_file / edit_file 与前缀 writableRoots。
        if (has('write_file')) list.push(AI_TOOL_DEFS.write_file);
        if (has('edit_file')) list.push(AI_TOOL_DEFS.edit_file);
        // 命令通道：快照 execution.command='sandboxed' 才挂（'denied' = 不挂载，§5.4），写效应
        // 圈在快照 fs 的沙箱根内，子代理永不弹审批。沙箱不可用时工具直接报错，不降级裸跑。
        // 后台三件套必须一起挂：只给 background_command 而不给 check/stop，模型起了作业
        // 也读不到、停不掉（等于把进程扔在后台自生自灭）。
        if (caps.execution && caps.execution.command === 'sandboxed') {
            for (const def of [AI_TOOL_DEFS.run_command, AI_TOOL_DEFS.background_command,
                AI_TOOL_DEFS.check_command, AI_TOOL_DEFS.stop_command]) {
                if (has(def.name)) list.push(def);
            }
        }
        // read_video 插位契约与旧实现一致（search_text 之后、web_search 之前）：子代理会话能
        // 接收视频才注册（与主会话同判定）；上游被快照收窄时按相邻只读工具兜底。
        if (has('read_video') && videoCapableOf(session)) {
            const anchor = list.includes(AI_TOOL_DEFS.search_text) ? list.indexOf(AI_TOOL_DEFS.search_text)
                : (list.includes(AI_TOOL_DEFS.read_image) ? list.indexOf(AI_TOOL_DEFS.read_image) : -1);
            list.splice(anchor >= 0 ? anchor + 1 : 0, 0, AI_TOOL_DEFS.read_video);
        }
        return list;
    }

    function activeSubCount() {
        let n = 0;
        for (const sub of subAgents.values()) if (sub.state === 'running') n++;
        return n;
    }

    function subTranscriptPush(sub, entry) {
        let list = subAgentTranscripts.get(sub.key);
        if (!list) {
            list = [];
            subAgentTranscripts.set(sub.key, list);
        }
        list.push(entry);
        while (list.length > 200) list.shift();
        // 工具行的出现/落定不经过 ai-chunk（长命令执行期间没有增量），详情视图得自己刷，
        // 否则「正在跑的工具」要等下一次正文增量才出现。300ms 节流在 scheduleAgentViewRender 里。
        refreshAgentViewIfOpen(sub.key);
    }

    function subThrottleRender(sub) {
        if (sub.renderTimer) return;
        sub.renderTimer = setTimeout(() => {
            sub.renderTimer = 0;
            const session = sessionById(sub.parentSessionId);
            if (session && sub.parentToolMessage) refreshToolWrap(session, sub.parentToolMessage);
            // 子代理详情视图开着时同步实时刷新（docs/finished-plans/ai-head-agents-terminal.md）
            for (const view of agentViews) {
                if (view.subId ? view.subId === sub.id : view.toolCallId === sub.key) scheduleAgentViewRender(view);
            }
        }, 350);
    }

    // ---- 后台命令桥接（供 main.js 的内容区终端标签页读取/订阅/停止） ----

    function bgJobSnapshot(jobId) {
        const entry = bgJobIndex.get(String(jobId || ''));
        if (!entry) return null;
        const live = bgJobLive.get(String(jobId || ''));
        const bg = (entry.message && entry.message.bg) || {};
        return {
            jobId: String(jobId || ''),
            command: entry.command,
            cwd: entry.cwd,
            startedAt: entry.startedAt,
            state: bg.state || 'unknown',
            code: bg.code == null ? null : bg.code,
            log: (live && live.text) || String(entry.message.bgLog || ''),
        };
    }

    function notifyBgListeners(jobId) {
        for (const fn of bgUpdateListeners) {
            try { fn(jobId); } catch (e) {}
        }
    }

    // ---- 子代理详情标签页桥接（供内容区标签页读取运行态、订阅状态变化） ----
    // key 兼容两种：bridge 标签存的是 subId（sub.id），运行态通知带的是 sub.key（toolCallId）。
    // 快照只返回纯数据，运行态注册表不外泄（bridge 域单向依赖，只经 ai-panel 桥方法访问）。
    const agentViewListeners = new Set();

    function agentViewSnapshot(key) {
        const id = String(key || '');
        if (!id) return null;
        const sub = subAgents.get(id) || [...subAgents.values()].find((s) => s.key === id) || null;
        if (sub) {
            return {
                key: sub.key, subId: sub.id, state: sub.state || 'running',
                rounds: sub.flow ? sub.flow.roundNo : 0,
                ms: Math.max(0, Date.now() - sub.startedAt),
                tokens: sub.flow && sub.flow.usage ? (Number(sub.flow.usage.totalTokens) || 0) : 0,
                name: sub.name || '',
            };
        }
        const rec = subAgentRecords.get(id) || [...subAgentRecords.values()].find((r) => r.key === id) || null;
        if (rec) {
            return {
                key: rec.key || '', subId: rec.id, state: rec.state,
                rounds: rec.rounds || 0, ms: rec.ms || 0, tokens: rec.tokens || 0,
                name: rec.name || '',
            };
        }
        return null;
    }

    function notifyAgentViewListeners(key) {
        for (const fn of agentViewListeners) {
            try { fn(String(key || '')); } catch (e) {}
        }
    }

    async function bridgeStopBgJob(jobId) {
        if (!backend.AICommandStop) throw new Error('当前版本不支持停止后台命令');
        const st = await backend.AICommandStop(String(jobId || ''));
        bgJobCursors.set(String(jobId || ''), Number(st && st.cursor) || 0);
        syncBgCardState(String(jobId || ''), st);
        return st || null;
    }

    // 子代理的父会话（嵌套时取中间那层，否则取根）。
    // 父与根都被删除时返回 null——这里只剩「模型档案 / 条目回落」用途（profileOf/entryOf
    // 对 null 安全），绝不能拿面板当前会话顶上：那会把子代理的结算与记录挂到用户正看着的
    // 另一个对话上，而父会话没了这条子代理本来也没有归宿。
    function parentSessionOfSub(sub) {
        return sessionById(sub && sub.parentSessionId) || sessionById(sub && sub.rootSessionId) || null;
    }

    // 会话信箱（面板后构造，惰性取）：结算与提问通知都经它投递，本模块不持有队列。
    function noticesLike() {
        if (typeof ctx.getNotices !== 'function') return null;
        const mod = ctx.getNotices();
        return mod && typeof mod.deliverAgentNotice === 'function' ? mod : null;
    }

    // 建记录 + 注册 + 启动首轮，**不等待终态**（阶段 B 把 spawn 拆成 start / await 两段）。
    // mode='background'：超限直接报错、立即返回 agentId，主代理继续自己的回合；
    // mode='blocking'（默认）：等待空位后阻塞——行为与旧实现逐字一致，工具结果仍是唯一出口。
    // 旧 sandbox 参数已删除（能力快照方案 §11.3）：不做静默兼容，直接报错并给新用法指引——
    // 依赖旧行为的提示词 / 技能必须有失败信号，否则旧逃生舱（sandbox:'full'）静默失效。
    // inspectToolArguments 不校验参数键名，旧键会原样透传到这里，执行分支是唯一拦截点。
    function rejectLegacySandboxArg(input) {
        const legacy = aiTextOf(input && input.sandbox).trim();
        if (legacy) {
            throw new Error('spawn_agent 的 sandbox 参数已删除（能力快照方案）：请改用 preset 参数'
                + '（host.default / host.read-only / host.full-write 或插件角色 id）。本次派单被拒绝，sandbox 值：' + legacy);
        }
    }

    // preset 解析（§4 / §10.5 阶段零）：编排会话（Worker / 审查者 / 仲裁者）派生的一切子代理
    // 强制收窄为只读 preset——宿主侧注入，不信任派单参数（阶段零硬前置：owns 写闸对子代理
    // 会话 fail-open，见 orchestration-ui.js authorizeWrite；「写闸认子代理 + fail-closed」
    // 是独立后续项，修好前强制收窄是唯一防线）。未注册的 preset 直接失败，错误信息带
    // 合法候选清单（§4.2）。放在并发等待之前调用：fail-fast，没理由等空位等完再报错。
    function resolveSpawnPreset(input, parentSession) {
        const orcRole = parentSession.orchestration && parentSession.orchestration.role
            ? String(parentSession.orchestration.role) : '';
        const forcedReadOnly = orcRole === 'work' || orcRole === 'review' || orcRole === 'arbiter';
        if (forcedReadOnly && String(aiTextOf(input && input.isolation)).trim() === 'worktree') {
            throw new Error('编排会话（' + orcRole + '）派生的子代理强制只读，不支持 isolation=worktree 隔离');
        }
        const requestedPresetId = forcedReadOnly ? HOST_PRESET_READ_ONLY : aiTextOf(input && input.preset).trim();
        const presetEntry = getAgentPreset(requestedPresetId || HOST_PRESET_DEFAULT);
        if (!presetEntry) {
            throw new Error('preset「' + requestedPresetId + '」未注册或已卸载。可用 preset：'
                + listAgentPresetIds().join('、'));
        }
        return presetEntry;
    }

    // 能力确认（§6.3）：涉工作区写入的插件 preset，首次派单时走主会话审批卡一次性确认——
    // 不是每次操作弹卡；确认记录按「插件 + preset + 工作区 + 声明摘要」保存，插件把
    // writableRoots 改宽后旧确认自动失效、重新弹卡。审批通道读**工厂闭包**的
    // requestActionApproval（工厂 deps 解构，见上方遮蔽注释）。嵌套派单（父是子代理）没有
    // 审批通道，未确认一律降级只读。worktree 隔离不受此闸约束：它是隔离车道（改动经
    // export 人工审批回灌），不是 preset 写能力。返回 grantPresetWrite（是否放行 preset 写能力）。
    async function confirmPresetWriteGrant(parentSession, parentLiveSub, toolMessage, presetEntry) {
        if (isHostPresetId(presetEntry.preset.id)) return true;
        const decl = presetEntry.preset.fs || {};
        const writeCapable = decl.mode === 'workspace-write'
            || (Array.isArray(presetEntry.preset.tools)
                && (presetEntry.preset.tools.includes('write_file') || presetEntry.preset.tools.includes('edit_file')));
        if (!writeCapable) return true;
        if (hasPresetGrant(presetEntry.owner, presetEntry.preset.id, parentSession.workspace, decl)) return true;
        if (parentLiveSub || !requestActionApproval) return false;
        const rootsText = (decl.writableRoots || []).join('、') || '整个工作区';
        const answer = await ctx.requestActionApproval(parentSession, toolMessage, {
            action: 'agent-preset-grant',
            title: 'AI 请求授予子代理 preset 写入能力',
            target: 'preset「' + (presetEntry.preset.name || presetEntry.preset.id) + '」（插件 ' + presetEntry.owner + '）',
            newValue: '工作区写入：' + rootsText,
            risk: 'high',
            warnings: [
                '该 preset 的子代理可以直接修改授权范围内的文件（不再逐次审批）',
                '可写范围由插件声明：' + rootsText,
                '拒绝后本次子代理按只读运行；确认按 插件 + preset + 工作区 记住一次，preset 声明改动后需重新确认',
            ],
            source: '主代理派单点名 preset：' + presetEntry.preset.id,
        });
        if (answer && answer.approved) {
            recordPresetGrant(presetEntry.owner, presetEntry.preset.id, parentSession.workspace, decl);
            return true;
        }
        if (answer && answer.cancelled) {
            // 用户按了停止：整次派单中止——「停止」是本轮语义，不是「拒绝写能力」，
            // 绝不能带着一个用户没拍板的子代理继续跑。
            throw new Error('用户已停止生成，派单取消。');
        }
        // 显式拒绝：本次子代理按只读降级（§6.3 拒绝后恢复默认只读），派单继续
        return false;
    }

    async function startSubAgent(ctx, input) {
        if (!backend.AISendChat) throw new Error('当前版本不支持子代理');
        const mode = String(aiTextOf(input && input.mode) || 'blocking').toLowerCase() === 'background'
            ? 'background' : 'blocking';
        const name = aiTextOf(input.name).trim() || '子代理';
        const task = aiTextOf(input.task).trim();
        if (!task) throw new Error('task 不能为空');
        rejectLegacySandboxArg(input);
        // 预算继承（2026-11-18 bug-hunt 实测缺陷）：嵌套派单（派出方本身是子代理）未点名
        // maxRounds 时继承派出方自己的轮次上限，而不是每层都落回设置默认——否则中间层
        // 预算先耗尽强制收尾，还在跑的下级成孤儿，结论投递两头落空（见 adoptOrphanChildren）。
        // 主代理派单不继承（主会话不是子代理，走设置默认）；显式点名永远优先。
        const spawnCallerSession = (ctx && ctx.session) || null;
        const parentSession = ctx.session;
        const parentLiveSub = spawnCallerSession && spawnCallerSession.parentSessionId
            ? subAgents.get(spawnCallerSession.id) : null;
        // 再派下层的快照闸（§3 delegation）：父代理快照 canSpawn=false（如编排强制收窄的
        // 只读 preset）就不允许再派——层间传递只收窄不放宽。
        if (parentLiveSub && parentLiveSub.capabilities
            && parentLiveSub.capabilities.delegation && parentLiveSub.capabilities.delegation.canSpawn === false) {
            throw new Error('你的能力快照不允许再派子代理（只读授权）：请自己完成调查并在最终结论中汇报');
        }
        const presetEntry = resolveSpawnPreset(input, parentSession);
        const roundsExplicit = input ? input.maxRounds : undefined;
        const roundsInput = (roundsExplicit === null || roundsExplicit === undefined || roundsExplicit === '')
            ? (parentLiveSub ? parentLiveSub.maxRounds : undefined)
            : roundsExplicit;
        const maxRounds = resolveSubAgentRounds(roundsInput, getConfig().subAgentRounds);
        const parentDepth = aiClampInt(ctx && ctx.agentDepth, 0, AI_SUB_DEPTH_MAX, 0);
        const depth = parentDepth + 1;
        // 层级上限 = 全局设置与父快照 delegation.maxDepth 取 min（§3：快照只收窄不放宽）。
        const parentCapsMaxDepth = (parentLiveSub && parentLiveSub.capabilities
            && Number(parentLiveSub.capabilities.delegation.maxDepth) > 0)
            ? Number(parentLiveSub.capabilities.delegation.maxDepth) : 0;
        const globalMaxDepth = subAgentMaxDepth();
        const maxDepth = globalMaxDepth && parentCapsMaxDepth
            ? Math.min(globalMaxDepth, parentCapsMaxDepth)
            : (globalMaxDepth || parentCapsMaxDepth);
        // 层号含主代理（主代理 = 第 1 层），depth 从主代理派出的第 1 层子代理开始算。
        if (maxDepth && depth + 1 > maxDepth) {
            throw new Error('子代理层级已达上限（最多 ' + maxDepth + ' 层，含主代理）');
        }
        // 并发上限覆盖全部层级：主代理派单时等待空位，子代理再派直接拒绝（否则会与祖先互相等待）。
        // activeSubCount 只数「运行中」，历史记录不计——所以这是**并发**上限，不是累计总数上限。
        // 后台模式不等待：排到队尾再等空位等于把工具调用变回阻塞，直接让模型稍后重试或改阻塞模式。
        const limit = subAgentLimit();
        if (activeSubCount() >= limit) {
            if (depth > 1) throw new Error('子代理并发已达上限 ' + limit + '（含各层级运行中的），无法继续派出');
            if (mode === 'background') {
                throw new Error('子代理并发已达上限 ' + limit + '，暂时无法派出后台子代理（可等现有子代理完成后再派，或改用阻塞模式排队）');
            }
            while (activeSubCount() >= limit) await aiDelay(300);
        }
        // 子代理归属到「根会话」：头部智能体团队 / 后台终端按会话展示时，
        // 嵌套子代理派出的任务也算在最初那个会话名下。
        const rootSessionId = rootSessionIdOf(parentSession);
        // 计时器只读共享用：派单时把「最初发起任务的主会话 id」逐层透传。
        // 递归派单时 parentSessionId 会变成上一层子代理 id，支线会话里光靠 rootSessionId 会丢主会话。
        const originSessionId = parentSession.originSessionId || parentSession.id;
        // 子代理继承「发起它的会话」的模型；设置里指定了子代理专用模型（模型档）时改用那个。
        // 「派出时定死」与沙箱档位同一处理：窗口 / 视频能力 / 压缩基数 / 请求模型全部同源。
        // 模型档三级优先：本次调用点名的（已过白名单，候选外直接抛错）> 设置里的默认子代理模型
        // > 跟随派出它的会话。抛错即派单失败，错误信息里带合法候选清单。
        const pickedModel = subAgentModelPick(input && input.model);
        const modelTarget = pickedModel || subAgentModelTarget();
        const profile = modelTarget ? modelTarget.account : profileOf(parentSession);
        const entry = modelTarget ? modelTarget.entry : entryOf(parentSession);
        if (!profile) throw new Error('无可用 AI 配置');
        const toolMessage = ctx.toolMessage;
        const grantPresetWrite = await confirmPresetWriteGrant(parentSession, parentLiveSub, toolMessage, presetEntry);
        // id 先落到局部变量：对象字面量里的 agentCtx 要用它当 owner，若在 sub 初始化期间
        // 直接写 sub.id 会触发暂时性死区（Cannot access 'sub' before initialization，
        // 压缩后变量名形如 ur）——对象字面量求值完成前 const sub 尚未初始化。
        const subId = aiNowId('sub-');
        const sub = {
            id: subId,
            key: aiNowId('agent-'),
            toolCallId: toolMessage.toolCallId || aiNowId('agent-'),
            depth,
            mode,
            parentSessionId: parentSession.id,
            rootSessionId,
            parentToolMessage: toolMessage,
            name: name.slice(0, 16),
            task,
            maxRounds,
            state: 'running',
            startedAt: Date.now(),
            renderTimer: 0,
            heartbeat: 0,
            resolve: null,
            // settled：终态 promise（阶段 E 的 wait_agent 与 blocking 模式共用）。
            settled: null,
            session: null,
            flow: null,
            inbox: newSubInbox(),
            // 每 live agent 的扁平注册层 agent.ctx（S6）：工具 / 提示 / 变量只对该 agent 可见，
            // 终态时由 finalizeSubAgent dispose，不残留、不串到别的 agent。realm 取 preset 的
            // 隔离域（点分命名空间），preset 的工具 / 提示 / 变量在快照合成后铺进作用域。
            agentCtx: createAgentScope({owner: subId, realm: presetEntry.preset.realm || ''}),
        };
        toolMessage.agent = {
            key: sub.key,
            // id / artifactDir：重启后详情视图靠它们从磁盘补读转录（ai-artifacts/<根会话>/sub-<id>.txt）。
            // 落盘目录用根会话 id，删根会话时才能一并清掉嵌套代理的产物。
            id: sub.id,
            artifactDir: rootSessionId || sub.parentSessionId,
            depth,
            mode,
            name: sub.name,
            task,
            state: 'running',
            rounds: 0,
            ms: 0,
            tokens: 0,
            summary: '',
            note: '',
        };
        sub.session = {
            id: sub.id,
            title: '',
            parentSessionId: parentSession.id,
            rootSessionId,
            originSessionId,
            workspace: parentSession.workspace || '',
            // 模型 pin 到本次派单实际要用的账号/条目（模型档或父会话）：上下文窗口最窄处
            // （contextWindowOf）与视频能力都从这里解析，不能在请求侧换模型而不改这里。
            profileId: profile.id,
            modelId: entry ? entry.id : '',
            // 继承母会话的「本次会话上下文上限」：省占用的意图覆盖整个会话活动
            //（子代理 auto-compact 的窗口基数随 contextWindowOf 一并收窄）
            ctxLimit: Number(parentSession.ctxLimit) || 0,
            systemPrompt: parentSession.systemPrompt || '',
            promptTemplateId: parentSession.promptTemplateId || '',
            // 权限档退化为纯读边界（§0.3 第 3 条）：full 封顶 auto，其余继承父档；读授权判定时
            // 实时回查父会话（ai-read-roots），写与工具面由能力快照决定（不再走 scope）。
            scope: subReadScopeOf(parentSession.scope),
            planMode: false,
            // from:'agent'：派单 task 是主代理模型写的，不是用户输入——「用户点名路径」判定
            // （ai-read-roots.js userNamedPath）据此排除，防止注入经派单文本伪造点名。
            messages: [{role: 'user', content: task, ts: Date.now(), turnStartedAt: Date.now(), from: 'agent'}],
            todos: [],
            changes: [],
            approvedPaths: [],
            // 已批准的工作区外读根：新建为空；判定时实时回查父会话（ai-panel.js 授权链），不快照复制
            readRoots: [],
            summary: null,
            archived: [],
            round: 0,
        };
        sub.profile = profile;
        sub.entry = entry;
        // 每 agent 注册层铺上 preset 的工具 / 提示 / 变量（S6，§4.4）：能力快照是它的输入之一，
        // 不是替代——createAgentScope 仍是该 agent 的注册层，normalizeAgentPreset 仍是唯一归一化入口。
        // 尽力而为：铺装失败只影响 preset 声明的提示片段 / 变量（能力面走快照），不阻断派单。
        try {
            sub.agentCtx.applyPreset(presetEntry.preset);
        } catch (e) {}
        const assistant = newAssistantMessage(profile, entry);
        sub.session.messages.push(assistant);
        // 能力快照预跑校验（worktreePath 置空）：把 preset 非法工具名 / 父档不足 / 可写根逃逸
        // 等非法情形全部提前到 GitWorktreeAdd 之前暴露——否则合成失败会把已建的隔离区变成
        // 磁盘孤儿（sub 未注册，worktree_manage 的 export/discard 都看不见它）。worktree 注入
        // 分支只做收窄、不引入新的失败源，预跑通过则下方正式合成必过。
        try {
            composeAgentCapabilities({
                preset: presetEntry.preset,
                owner: presetEntry.owner,
                parentScope: parentSession.scope,
                parentSessionId: parentSession.id,
                workspaceRoot: parentSession.workspace || '',
                worktreePath: '',
                parentToolFace: parentLiveSub && parentLiveSub.capabilities
                    ? parentLiveSub.capabilities.tools.allow
                    : null,
                knownTools: knownAgentToolNames(),
                projectableTools: subagentProjectableToolNames(),
                globalMaxDepth,
                parentCapsMaxDepth,
                grantPresetWrite,
            });
        } catch (e) {
            throw new Error('子代理能力合成失败：' + ((e && e.message) || e));
        }
        // 隔离 worktree（spawn isolation='worktree'）：给子代理一份独立草稿区，写效应圈定在
        // .cadt/worktree/<slug>/ 内。创建失败让 spawn 直接报错——静默降级会让子代理把改动
        // 写进主根，违背隔离承诺。label 用子代理名（Go 侧 slugify + sub.id 尾段保证唯一）。
        // getScopeRoot 读工厂闭包（工具 ctx 没有它，见上方遮蔽注释）。
        if (String(aiTextOf(input && input.isolation)).trim() === 'worktree') {
            const root = getScopeRoot ? aiTextOf(getScopeRoot()) : '';
            if (!root) throw new Error('当前没有工作区范围：隔离 worktree 建在主根的 .cadt/worktree/ 下，请先打开文件夹');
            let added;
            try {
                added = await backend.GitWorktreeAdd(root, sub.name, sub.id);
            } catch (e) {
                throw new Error('创建子代理隔离 worktree 失败：' + ((e && e.message) || e));
            }
            sub.worktree = {name: added.name, branch: added.branch, path: added.path, baseSha: added.baseSha, createdAt: Date.now()};
            sub.session.worktree = sub.worktree;
        }
        // 能力快照合成（§3 / §10.3）：preset × 派单参数 × 父级约束在派单时一次算死，运行期
        // 不可变（deep freeze）、续跑不能扩大。相对可写根在这里相对会话工作区解析为绝对路径
        // 并定死；worktree 已创建后传前缀，快照注入 writableRoots = 前缀 + 写工具（§7 语义纯化）。
        try {
            sub.capabilities = composeAgentCapabilities({
                preset: presetEntry.preset,
                owner: presetEntry.owner,
                parentScope: parentSession.scope,
                parentSessionId: parentSession.id,
                workspaceRoot: parentSession.workspace || '',
                worktreePath: sub.worktree ? sub.worktree.path : '',
                parentToolFace: parentLiveSub && parentLiveSub.capabilities
                    ? parentLiveSub.capabilities.tools.allow
                    : null,
                knownTools: knownAgentToolNames(),
                projectableTools: subagentProjectableToolNames(),
                globalMaxDepth,
                parentCapsMaxDepth,
                grantPresetWrite,
            });
        } catch (e) {
            throw new Error('子代理能力合成失败：' + ((e && e.message) || e));
        }
        sub.session.capabilities = sub.capabilities;
        // 沙箱档位在派出时定死（与工具表、系统提示同源）：HUD 与详情只读它，不再各自推导。
        const sandboxPolicy = subSandboxPolicy(sub.session);
        sub.sandboxMode = sandboxPolicy ? sandboxPolicy.mode : '';
        toolMessage.agent.sandboxMode = sub.sandboxMode;
        toolMessage.agent.preset = sub.capabilities.preset;
        // 完全权限子代理：给发起方投一条非阻塞警告消息（走信箱，忙则排队到下一轮边界，
        // 不打断当前轮、不阻塞派单）。仅 danger-full-access 触发——唯一入口是宿主内置
        // host.full-write（仅父档 full 可派），是用户/主代理的知情确认（沿用原逃生舱机制）。
        if (sub.sandboxMode === 'danger-full-access') {
            const hub = noticesLike();
            if (hub) hub.deliverAgentNotice(parentSession, buildFullScopeWarning({name: sub.name, agentId: sub.id}));
        }
        sub.flow = {
            sessionId: sub.id,
            baseRound: 1,
            roundNo: 0,
            roundId: sub.id + '#1-0',
            assistant,
            startedAt: Date.now(),
            thinkStartedAt: 0,
            roundStartedAt: 0,
            firstTokenAt: 0,
            renderTimer: 0,
            finished: false,
            stopped: false,
            wrapUp: false,
            toolCalls: new Map(),
            profileCfg: subAgentConfigFor(profile, entry),
            systemPrompt: subSystemPromptFor(depth, mode, sub.capabilities, !!sub.worktree),
            usage: null,
        };
        subAgents.set(sub.id, sub);
        auditAgent(sub, 'spawn');
        agentRegistry.set(sub.key, {
            subId: sub.id, key: sub.key, toolCallId: sub.toolCallId, depth,
            parentSessionId: sub.parentSessionId, rootSessionId,
            name: sub.name, task: sub.task, state: 'running', startedAt: sub.startedAt,
            mode, rounds: 0, ms: 0, tokens: 0, summary: '',
            sandboxMode: sub.sandboxMode,
            preset: sub.capabilities.preset,
        });
        notifyBackgroundActivity();
        persistSessions();
        refreshToolWrap(parentSession, toolMessage);
        // 先挂 resolve 再启动子代理轮：runSubRound 的同步失败路径（请求抛错/轮次上限/
        // 消息越限/索引丢失）会立刻 finalizeSubAgent，若此时 resolve 尚未挂上，主代理的
        // await 会永远悬挂（实测：子代理失败后主代理卡死无反馈）。见 2026-11-14 修复。
        const outcomePromise = new Promise((resolve) => { sub.resolve = resolve; });
        sub.settled = outcomePromise;
        runSubRound(sub);
        return {sub, outcome: outcomePromise};
    }

    // 阻塞模式：派单即等待终态（调用方拿到结论文本作为工具结果）。
    // 后台模式不走这里——ai-panel 的 spawn_agent case 用 startSubAgent 直接返回回执。
    async function runSubAgent(ctx, input) {
        const started = await startSubAgent(ctx, input);
        const outcome = await started.outcome;
        return outcome.text;
    }

    function runSubRound(sub) {
        const s = sub.flow;
        // 每个轮边界刷一次运行态快照：进程在长回合中被杀时，重启后能续到「最近一轮」，
        // 而不是只能回到派单时的第一条消息。
        persistRun(sub, 'running');
        if (sub.state !== 'running' || s.stopped) {
            finalizeSubAgent(sub, s.stopped ? 'stopped' : sub.state);
            return;
        }
        // 收件箱消费（唯一消费点，§4.3）：先消费再判定预算 / 压缩，避免刚到的指令被
        // 压进摘要；wrapUp 收尾轮不消费（残余随终态进 records，结算文案会标注）。
        if (!s.wrapUp) consumeSubInbox(sub);
        // 轮边界压缩（§4.10.2）：顺序固定为「先消费收件箱再判压缩」，否则刚到的指令会被
        // 压进摘要；预算已尽（wrapUp 在即）不再压缩，把剩余轮次留给收尾。
        if (!s.wrapUp && s.roundNo < sub.maxRounds && maybeStartSubCompact(sub)) return;
        if (!s.wrapUp && (s.roundNo >= sub.maxRounds || sub.session.messages.length > AI_SUB_MESSAGES_MAX)) {
            // 预算用尽不再直接收尾：先跑一轮「无工具强制总结」——探索成果不能扔，
            // 占位符只会让主代理拿不到任何可用结论（2026-11-14 实测）。
            // 收尾轮不下发任何工具：模型只能输出文本（工具表的选择见 runSubRound 里的 tools；
            // Go 侧空数组不下发 tools 字段）。万一模型仍幻觉出工具调用，runSubToolRound
            // 直接拒绝并立即收尾——否则「拒绝 → 再请求 → 再幻觉」在收尾轮会没有轮次上限兜底。
            // roundId 继续递增保唯一。
            s.wrapUp = true;
            sub.session.messages.push({
                role: 'user',
                content: '轮次预算已用尽。不要再探索、不要调用任何工具：立即基于上面已完成的探索输出最终结论——要点 + 证据（path:line）。这是你返回给主代理的唯一结果。',
                ts: Date.now(),
            });
            const wrapAssistant = newAssistantMessage(sub.profile || profileOf(parentSessionOfSub(sub)), sub.entry || entryOf(parentSessionOfSub(sub)));
            sub.session.messages.push(wrapAssistant);
            s.assistant = wrapAssistant;
            runSubRound(sub);
            return;
        }
        s.roundNo += 1;
        s.roundId = sub.id + '#' + s.baseRound + '-' + s.roundNo;
        s.toolCalls.clear();
        s.thinkStartedAt = 0;
        s.roundStartedAt = Date.now();
        s.firstTokenAt = 0;
        // 循环守卫每轮独立：上一轮的重复不能把新 Assistant 消息直接判死。
        s.loopGuard = createLoopGuard();
        // 子代理固定用派出时的配置；标签跟随实际配置，避免与主对话的模型切换串味。
        if (s.assistant && s.profileCfg && s.profileCfg.model) s.assistant.model = s.profileCfg.model;
        const index = sub.session.messages.indexOf(s.assistant);
        if (index < 0) {
            finalizeSubAgent(sub, 'error', '内部错误：子代理消息索引丢失');
            return;
        }
        const apiMessages = buildApiMessages(sub.session, index, s.systemPrompt);
        // 收尾轮明确不下发工具（注释承诺的「模型只能输出文本」）。Go 侧三套 body 都是
        // `if len(tools) > 0` 才写 tools 字段，空数组等价于「无工具」，不会让服务商报错。
        const tools = s.wrapUp ? [] : subToolsForCapabilities(sub);
        try {
            const request = backend.AISendChat(s.roundId, s.profileCfg, apiMessages, tools, getConfig().retryMax);
            if (request && typeof request.then === 'function') {
                request.catch((e) => finalizeSubAgent(sub, 'error', (e && e.message) || String(e || '请求失败')));
            }
        } catch (e) {
            finalizeSubAgent(sub, 'error', (e && e.message) || String(e || '请求失败'));
        }
    }

    // 流中途被网关掐断 / 流内网关 5xx（ai-error.retryable）的自动重试：与主会话
    // retryTruncatedRound 同语义——半截 assistant 整条作废、换空 assistant 重发
    // （runSubRound 会换新 roundId、清 toolCalls 与循环守卫）。预算见 ai-stream-retry.js
    // （retryMax=0 视为关闭）。当前轮的工具尚未执行（工具轮在 done 后才跑），作废无副作用；
    // 收尾轮（wrapUp）同样受益：传输故障先重试，重试耗尽才回退「转录摘录」。
    function retrySubAgentRound(sub, payload) {
        const s = sub.flow;
        if (sub.state !== 'running' || s.stopped) return false;
        const budget = aiStreamRetryBudget(getConfig().retryMax);
        if (!shouldAutoRetryStream({
            retryable: !!(payload && payload.retryable),
            stopped: !!s.stopped,
            retried: s.streamRetried,
            budget,
        })) return false;
        const idx = sub.session.messages.indexOf(s.assistant);
        if (idx < 0) return false;
        s.streamRetried = (s.streamRetried || 0) + 1;
        sub.session.messages.splice(idx, 1);
        const assistant = newAssistantMessage(
            sub.profile || profileOf(parentSessionOfSub(sub)),
            sub.entry || entryOf(parentSessionOfSub(sub)));
        sub.session.messages.push(assistant);
        s.assistant = assistant;
        runSubRound(sub);
        subThrottleRender(sub);
        return true;
    }

    async function runSubToolRound(sub, calls, argErrors) {
        const s = sub.flow;
        // 收尾轮本就不下发工具（见 runSubRound 的 tools 选择）。模型仍幻觉出工具调用时
        // 一律拒绝并**立即收尾**——否则「拒绝 → 再请求 → 再幻觉」会在收尾轮无限循环，
        // 而 wrapUp 已没有轮次上限兜底（模型此刻该做的是写总结，不是再要工具）。
        if (s.wrapUp) {
            for (const call of calls) {
                sub.session.messages.push({
                    role: 'tool',
                    toolCallId: call.id,
                    name: call.name,
                    arguments: call.arguments,
                    content: '收尾轮不再执行工具（轮次预算已用尽）：请直接输出最终结论。',
                    status: 'error',
                    ts: Date.now(),
                });
            }
            subTranscriptPush(sub, {role: 'tool', name: (calls[0] && calls[0].name) || 'tool',
                text: '收尾轮拒绝工具调用，直接收尾'});
            finalizeSubAgent(sub, 'done');
            return;
        }
        // 子代理工具执行期间喂自己的流看门狗（与主流工具心跳同理）
        if (!sub.heartbeat && backend.AITouchStream) {
            sub.heartbeat = setInterval(() => {
                if (sub.state !== 'running') {
                    clearInterval(sub.heartbeat);
                    sub.heartbeat = 0;
                    return;
                }
                try { backend.AITouchStream(sub.id); } catch (e) {}
            }, 45000);
        }
        for (const call of calls) {
            if (sub.state !== 'running' || s.stopped) break;
            const toolMessage = {
                role: 'tool',
                toolCallId: call.id,
                name: call.name,
                arguments: call.arguments,
                content: '',
                status: 'running',
                ts: Date.now(),
            };
            sub.session.messages.push(toolMessage);
            const invalidArgs = argErrors && argErrors.get(call.id);
            if (invalidArgs) {
                toolMessage.status = 'error';
                toolMessage.content = invalidArgs;
                subTranscriptPush(sub, {role: 'tool', name: call.name, text: invalidArgs.slice(0, 600)});
                continue;
            }
            // 执行前 guard（§5.2）：范围外工具确定性拒绝、不进审批链路（单调拒绝，后续
            // 插件/监听器不能重新放行）；模型侧文案明确「不重试、上报父会话」并说明缺什么
            // 权限（§6.1），拒绝本身落操作留痕（不含工具输入）。
            const allowed = new Set(subToolsForCapabilities(sub).map((tool) => tool.name));
            if (!allowed.has(call.name)) {
                toolMessage.status = 'error';
                toolMessage.content = subToolDenyText(call.name, sub.capabilities);
                subTranscriptPush(sub, {role: 'tool', name: call.name, text: toolMessage.content.slice(0, 600)});
                logActivity('ai.tool', call.name, {status: 'denied', ms: 0, depth: sub.depth});
                continue;
            }
            let result = null;
            let parsed = {};
            const toolExecStart = Date.now();
            try {
                parsed = call.arguments ? JSON.parse(call.arguments) : {};
                result = await executeTool(call.name, parsed, {session: sub.session, toolMessage, stream: s, agentDepth: sub.depth});
            } catch (e) {
                toolMessage.status = 'error';
                toolMessage.content = '工具执行失败：' + ((e && e.message) || e);
            }
            if (sub.state !== 'running' || s.stopped) break;
            if (result != null) {
                toolMessage.status = 'done';
                toolMessage.content = String(result);
            }
            // 操作留痕：子代理工具执行摘要（不记返回正文）。activityStatus 是工具给出的
            // 「留痕状态覆盖」——沙箱拒绝 / 沙箱不可用 / 作业归属拒绝各自成一种 status，
            // 优先于 done / error；子代理的命令无人可问，留痕是唯一的审计面。
            // 路 B 轻量版：命令类工具带命令族 + cwd（不含正文 / 参数，防密钥泄露），
            // full 档标 sandbox:'danger-full-access' 让「未沙箱裸跑」在留痕里可见。
            const audit = commandAuditSummary(call.name, parsed);
            logActivity('ai.tool', call.name, {
                status: toolMessage.activityStatus || (toolMessage.status === 'error' ? 'error' : 'done'),
                ms: Math.max(0, Date.now() - toolExecStart),
                depth: sub.depth,
                ...(toolMessage.sandbox ? {sandbox: toolMessage.sandbox} : {}),
                ...(sub.sandboxMode === 'danger-full-access' ? {sandbox: 'danger-full-access'} : {}),
                ...(audit || {}),
            });
            subTranscriptPush(sub, {role: 'tool', name: call.name, text: String(toolMessage.content || '').slice(0, 600)});
        }
        if (sub.state !== 'running' || s.stopped) {
            // 停止时排队的图片也挂上：它们属于已完成的工具结果，丢掉会让转录与请求对不上
            if (flushToolImages) flushToolImages(sub.session);
            finalizeSubAgent(sub, s.stopped ? 'stopped' : sub.state);
            return;
        }
        // 工具批次结束才挂 read_image 的图片消息（批次中途 push 会拆开 assistant(tool_calls)
        // 与 tool 结果，下一轮请求会被服务商拒收）。
        if (flushToolImages) flushToolImages(sub.session);
        // 队列里的投递必须先消费成 user 消息、再 push 空的 assistant 续写目标。
        // 顺序反了（assistant 在前）时，runSubRound 用 buildApiMessages(sub.session,
        // indexOf(assistant)) 组装请求，只取 assistant 之前的历史，这条投递被整体排除，
        // 模型要再等一轮才看到（2026-11-16 实测：投递后仍按原任务多跑一轮）。
        // wrapUp 收尾轮不消费（与 runSubRound 同口径，残余随终态进 records）。
        if (!s.wrapUp) consumeSubInbox(sub);
        const assistant = newAssistantMessage(sub.profile || profileOf(parentSessionOfSub(sub)), sub.entry || entryOf(parentSessionOfSub(sub)));
        sub.session.messages.push(assistant);
        s.assistant = assistant;
        s.thinkStartedAt = 0;
        runSubRound(sub);
    }

    // 子代理的 token 用量也计入使用统计：与主会话写同一张事实表，sessionId 用子代理会话 id。
    // 子代理消息只活在内存与 ai-artifacts 转录里（会话 JSONL 只有最后一轮的汇总），
    // 兜底扫描拿不到，所以必须在这里每轮流结束时实时上报。
    function reportSubUsage(sub, assistant, usage) {
        if (!usage || !sub || !sub.id) return;
        const api = backend && backend.AIUsageStatsRecord;
        if (typeof api !== 'function') return;
        let payload = '';
        try {
            payload = JSON.stringify({
                sessionId: sub.id,
                ts: Number(assistant && assistant.ts) || Date.now(),
                model: (assistant && assistant.model) || '',
                modelAccount: (assistant && assistant.modelAccount) || '',
                turnMs: Number(assistant && assistant.turnMs) || 0,
                modelMs: Number(assistant && assistant.modelMs) || 0,
                ttftMs: Number(assistant && assistant.firstTokenMs) || 0,
                statusCode: Number(assistant && assistant.statusCode) || 0,
                usage: {
                    promptTokens: Number(usage.promptTokens) || 0,
                    completionTokens: Number(usage.completionTokens) || 0,
                    totalTokens: Number(usage.totalTokens) || 0,
                    cachedTokens: Number(usage.cachedTokens) || 0,
                    cacheWriteTokens: Number(usage.cacheWriteTokens) || 0,
                },
            });
        } catch (e) {
            return;
        }
        try {
            const result = api.call(backend, payload);
            if (result && typeof result.then === 'function') {
                result.then(() => {}).catch(() => {});
            }
        } catch (e) {
            // 统计上报是尽力而为：失败不影响子代理
        }
    }

    function handleSubEvent(name, payload, sub) {
        const s = sub.flow;
        if (!payload || payload.id !== s.roundId) return;
        switch (name) {
            case 'ai-chunk':
                if (payload.delta) {
                    if (!s.firstTokenAt) s.firstTokenAt = Date.now();
                    s.assistant.content += payload.delta;
                    // 转录里维护一条「进行中」的助手条目，流式更新最后一条
                    const list = subAgentTranscripts.get(sub.key);
                    const last = list && list.length ? list[list.length - 1] : null;
                    if (last && last.role === 'assistant' && last.live) last.text = s.assistant.content;
                    else subTranscriptPush(sub, {role: 'assistant', text: s.assistant.content, live: true});
                    subThrottleRender(sub);
                }
                break;
            case 'ai-think':
                // 子代理没有 composer 可接管：高阈值直接自动停止，原因写进记录摘要。
                if (payload.delta && sub.state === 'running') {
                    if (!s.firstTokenAt) s.firstTokenAt = Date.now();
                    s.assistant.reasoning += payload.delta;
                    if (!s.loopGuard) s.loopGuard = createLoopGuard();
                    s.loopGuard.push(payload.delta);
                    if (s.loopGuard.verdict() === 'prompt') {
                        const stats = s.loopGuard.stats();
                        s.assistant.guard = {
                            state: 'stopped',
                            action: 'stop',
                            source: 'subagent',
                            repeats: stats.maxRepeat,
                            ratio: stats.ratio,
                            chars: stats.chars,
                            lines: stats.lines,
                            detectedAt: Date.now(),
                            answeredAt: Date.now(),
                        };
                        stopSubAgent(sub, '检测到思考循环，已自动停止', {autoStop: true});
                    }
                }
                break;
            case 'ai-toolcall': {
                if (!s.firstTokenAt) s.firstTokenAt = Date.now();
                const index = Number(payload.index) || 0;
                let call = s.toolCalls.get(index);
                if (!call) {
                    call = {id: '', name: '', arguments: ''};
                    s.toolCalls.set(index, call);
                }
                if (payload.callId) call.id = payload.callId;
                if (payload.name) call.name = payload.name;
                if (payload.argsDelta) call.arguments += payload.argsDelta;
                break;
            }
            case 'ai-done': {
                if (payload.usage) {
                    s.usage = payload.usage;
                    // 子代理没有主会话的 finishStream：用本轮起点补请求耗时/首字后再上报
                    if (s.roundStartedAt && s.assistant) {
                        const finishedAt = Date.now();
                        s.assistant.modelMs = Math.max(0, finishedAt - s.roundStartedAt);
                        s.assistant.firstTokenMs = s.firstTokenAt ? Math.max(0, s.firstTokenAt - s.roundStartedAt) : 0;
                        s.assistant.turnMs = s.assistant.modelMs;
                    }
                    if (s.assistant) s.assistant.statusCode = Number(payload.statusCode) || 0;
                    reportSubUsage(sub, s.assistant, payload.usage);
                }
                // 结束「进行中」转录条目
                const list = subAgentTranscripts.get(sub.key);
                const last = list && list.length ? list[list.length - 1] : null;
                if (last && last.role === 'assistant' && last.live) {
                    last.text = String(s.assistant.content || '').slice(0, 2000);
                    last.live = false;
                }
                // 插队打断（原语 4）：主动停止当前在飞调用只是为了把新消息提到下一步边界，
                // **不是终止**——丢弃本轮半截工具调用、清停止标记，直接续轮；收件箱在
                // runSubRound 开头被消费。s.steerKick 只由 steerSubAgent 置位，
                // 用户停止走 stopSubAgent（它先清标记，所以不会被误判成续轮）。
                if (sub.steerKick) {
                    sub.steerKick = false;
                    s.toolCalls.clear();
                    s.stopped = false;
                    if (s.assistant && s.assistant.status === 'streaming') s.assistant.status = 'done';
                    // 插队消息先消费成 user 消息，再 push 空的 assistant——顺序反了会被
                    // buildApiMessages 的 index 截断排除，插队指令要再等一轮才生效（同
                    // runSubToolRound 的 2026-11-16 实测）。
                    if (!s.wrapUp) consumeSubInbox(sub);
                    const nextAssistant = newAssistantMessage(
                        sub.profile || profileOf(parentSessionOfSub(sub)),
                        sub.entry || entryOf(parentSessionOfSub(sub)));
                    sub.session.messages.push(nextAssistant);
                    s.assistant = nextAssistant;
                    s.thinkStartedAt = 0;
                    runSubRound(sub);
                    return;
                }
                const argErrors = new Map();
                const calls = [...s.toolCalls.values()]
                    .filter((call) => call.name)
                    .map((call, index) => {
                        const check = inspectToolArguments(call.arguments);
                        const id = call.id || ('call_sub_' + s.roundNo + '_' + index);
                        if (!check.valid && !check.repaired) {
                            argErrors.set(id, toolArgsErrorText(call.name, call.arguments));
                        }
                        return {id, name: call.name, arguments: check.text};
                    });
                s.toolCalls.clear();
                if (payload.finishReason === 'tool' && calls.length) {
                    // 写回 assistant 消息（镜像主路径）：buildApiMessages 只带
                    // 「assistant 自带 toolCalls 且有配对 tool 响应」的轮次，不写回
                    // 会把 tool 结果整条丢出历史，下一轮请求还会落进
                    // 「assistant 末条续写」形态，触发网关 reasoning_content 校验
                    // 400（2026-11-14 实测）。
                    s.assistant.toolCalls = calls;
                    s.assistant.status = 'done';
                    runSubToolRound(sub, calls, argErrors);
                    return;
                }
                finalizeSubAgent(sub, 'done');
                break;
            }
            case 'ai-error':
                // 流中途被掐断 / 流内网关 5xx（retryable）先走自动重试：探索半途的
                // 传输故障不该直接判死，也不该触发下面的「摘录兜底」。
                if (retrySubAgentRound(sub, payload)) break;
                if (s.wrapUp) {
                    // 收尾总结请求自身失败（如 60 条消息的上下文超窗）：
                    // 回退为转录摘录，不让探索成果跟着一起丢。
                    finalizeSubAgent(sub, 'done', subDigestOf(sub)
                        + '\n（收尾总结请求失败：' + (payload.message || '请求失败') + '）');
                    break;
                }
                finalizeSubAgent(sub, 'error', payload.message || '请求失败');
                break;
        }
    }

    // 收尾兜底：从转录拼探索记录摘录（tool 条目已在推送时截到 600 字）
    function subDigestOf(sub) {
        const list = subAgentTranscripts.get(sub.key) || [];
        const lines = [];
        for (const entry of list) {
            if (entry.role === 'tool') lines.push('- ' + entry.name + ': ' + String(entry.text || '').trim());
        }
        if (!lines.length) return '达到轮次上限，无可用探索记录';
        return '（未完成收尾总结，以下为探索记录摘录）\n' + lines.slice(-12).join('\n');
    }

    // 终态记录入册（LRU）：先保证活引用可用（冷唤醒 / 压缩要 sub.session），
    // 超出上限时最早的记录先降级为「仅状态 + 结论摘要、不可续」，再超就整条丢弃。
    function pushSubAgentRecord(sub, state, summary) {
        const s = sub.flow;
        const record = {
            id: sub.id,
            key: sub.key,
            toolCallId: sub.toolCallId,
            name: sub.name,
            task: sub.task,
            maxRounds: sub.maxRounds,
            depth: sub.depth,
            mode: sub.mode || 'blocking',
            sandboxMode: sub.sandboxMode || '',
            preset: sub.capabilities ? sub.capabilities.preset : '',
            capabilities: sub.capabilities || null,
            parentSessionId: sub.parentSessionId,
            rootSessionId: sub.rootSessionId,
            state,
            summary,
            note: sub.note || '',
            rounds: s ? s.roundNo : 0,
            ms: Math.max(0, Date.now() - sub.startedAt),
            tokens: s && s.usage ? (Number(s.usage.totalTokens) || 0) : 0,
            startedAt: sub.startedAt,
            finishedAt: Date.now(),
            // 冷唤醒所需的活引用（continuable=false 时清空）
            session: sub.session || null,
            profile: sub.profile || null,
            entry: sub.entry || null,
            baseRound: s ? (Number(s.baseRound) || 1) : 1,
            continuable: state === 'done',
        };
        subAgentRecords.delete(sub.id);
        subAgentRecords.set(sub.id, record);
        let degraded = 0;
        for (const rec of subAgentRecords.values()) {
            if (rec && rec.continuable === false) degraded++;
        }
        while (subAgentRecords.size > AI_SUB_RECORDS_MAX) {
            const oldestKey = subAgentRecords.keys().next().value;
            const oldest = subAgentRecords.get(oldestKey);
            if (oldest && oldest.continuable !== false && degraded < AI_SUB_DEGRADED_MAX) {
                // 降级：丢活引用，只留状态与结论摘要（HUD 仍可展示，冷唤醒拒绝）。
                // 必须 delete + set：Map.set 对已存在的 key 不改变顺序，原地 set 后
                // 下一轮 while 会再取到同一个 key 走 else 直接把摘要删掉。
                subAgentRecords.delete(oldestKey);
                subAgentRecords.set(oldestKey, {
                    ...oldest,
                    session: null, profile: null, entry: null, continuable: false,
                });
                subAgentTranscripts.delete(oldest.key);
                degraded++;
            } else {
                subAgentRecords.delete(oldestKey);
                subAgentTranscripts.delete(oldestKey);
            }
        }
        return record;
    }

    // 投向「发起方」的唯一入口（结算与提问共用）。
    // 关键：子代理会话**不进 sessions 表**（见 ai-panel.js 的子会话判据），所以
    // sessionById(parentSessionId) 对嵌套代理恒为 null——第 2 层起的结算 / 提问通知
    // 曾因此全部静默丢失（2026-11-17 五层嵌套实测：层5-A2a 的结论没回到层4-A2）。
    // 父是运行中的子代理时投它的收件箱（下一轮边界消费），否则按下面两级解析：
    //   ① 真实会话（父是主会话，或孤儿已改挂根会话）→ 会话信箱；
    //   ② 父 id 是已终态的子代理且没被接管（防御：接管前后的竞态、旧记录）→
    //      按它的终态记录回落 rootSessionId 投根会话信箱（2026-11-18 bug-hunt 实测：
    //      四个孤儿结算曾在此两头落空，只留 flash）。
    // 返回是否投出，供调用方决定要不要降级提示。
    function deliverToParent(sub, notice) {
        if (!sub || !sub.parentSessionId) return false;
        const parentSub = subAgents.get(sub.parentSessionId);
        if (parentSub && parentSub.state === 'running') {
            queueSubAgentMessage(parentSub, notice.content, {from: 'subagent'});
            return true;
        }
        const hub = noticesLike();
        if (!hub) return false;
        const parentRecord = subAgentRecords.get(sub.parentSessionId);
        const parent = sessionById(sub.parentSessionId)
            || (parentRecord ? sessionById(parentRecord.rootSessionId) : null);
        if (!parent) return false;
        const receipt = hub.deliverAgentNotice(parent, notice);
        return !!(receipt && receipt.ok);
    }

    // 孤儿接管（2026-11-18 bug-hunt 实测缺陷）：父代理走到终态**不级联**停运行中的下级
    // （done 的下级结论可能还有价值；agent_stop 才显式级联，见 stopSubTree），但父结死后
    // 下级结算时 deliverToParent 会两头落空。终态时把仍在运行的直属下级改挂到最近的
    // 运行中祖先（祖父，收件箱投递可达）；没有运行中祖先就挂根会话（信箱投递可达）。
    // 孙代理挂在直属下级身上，直属下级活着，子树自然保持成树，无需递归改写。
    // 返回接管摘要（null = 没有运行中的下级，无需接管）。
    function adoptOrphanChildren(sub) {
        const kids = [...subAgents.values()].filter((item) =>
            item.state === 'running' && item.parentSessionId === sub.id);
        if (!kids.length) return null;
        const grand = subAgents.get(sub.parentSessionId);
        const target = (grand && grand.state === 'running') ? grand.id : (sub.rootSessionId || '');
        if (!target) return null;
        for (const kid of kids) {
            kid.parentSessionId = target;
            if (kid.session) kid.session.parentSessionId = target;
            const reg = agentRegistry.get(kid.key);
            if (reg) reg.parentSessionId = target;
        }
        return {count: kids.length, target: target};
    }

    // 后台命令作业退出：把「已结束」通知投给发起方。
    // 发起者还是运行中的子代理 → 进它的收件箱（下一轮边界消费，runSubRound 开头唯一消费点）；
    // 已结算 / 主会话发起 → 投根会话信箱（deliverAgentNotice 三态投递：忙排队、闲唤醒）。
    // 目标都不在（会话已删等）返回 false，调用方静默放弃——作业卡片状态本身已收敛。
    function deliverBgExitNotice(entry, notice) {
        if (!entry || !notice) return false;
        const creator = entry.session;
        if (creator && creator.parentSessionId) {
            const sub = subAgents.get(creator.id);
            if (sub && sub.state === 'running') {
                queueSubAgentMessage(sub, notice.content, {from: 'subagent'});
                return true;
            }
        }
        const ownerId = bgEntryOwnerId(entry);
        const target = ownerId ? sessionById(ownerId) : null;
        if (!target) return false;
        const hub = noticesLike();
        if (!hub) return false;
        const receipt = hub.deliverAgentNotice(target, notice);
        return !!(receipt && receipt.ok);
    }

    // 子代理生命周期落日志（S6 切片）：spawn / 终态各记一条 agent 审计事件。
    // 边界要写清楚：这是「**持久可查**」，不是「**可续跑**」——重启后仍按 stopped 收敛，
    // 恢复运行需要运行态快照（方案 S6 的剩余部分）。价值在于：日志能回答「这次崩溃时
    // 派出了几个子代理、它们最后到哪个状态」，而不是只剩界面上的已消失卡片。
    function auditAgent(sub, phase, state) {
        if (!sub || !ctx.auditEvent) return;
        const parentSessionId = sub.parentSessionId || (sub.session && sub.session.id);
        if (!parentSessionId) return;
        try {
            const event = encodeAgentEvent(sub.id, phase, state);
            if (event) ctx.auditEvent(parentSessionId, event);
        } catch (e) {}
    }

    // 运行态快照落盘（S6）：跨进程续跑的唯一依据。母会话侧落进 meta.json 的 agentRuns，
    // 剪枝 / 上限 / 校验都在 ai-agent-resume 里。失败只记诊断——快照丢了的后果是「续不上」，
    // 不该影响本次运行。
    function persistRun(sub, state) {
        if (!sub || !ctx.saveAgentRun) return;
        try {
            const snapshot = encodeAgentRun(sub, state);
            if (snapshot) ctx.saveAgentRun(snapshot);
        } catch (e) {}
    }

    function finalizeSubAgent(sub, state, note, options) {
        if (sub.state !== 'running') return;
        sub.state = state;
        auditAgent(sub, state === 'done' ? 'done' : 'stopped', state);
        persistRun(sub, state);
        sub.note = note || '';
        // 兜底：任何终态都不留挂起的提问（否则 ask_user 的 await 永远不返回）
        if (sub.inbox && sub.inbox.ask) settleSubAsk(sub, '', 'stopped');
        if (sub.renderTimer) {
            clearTimeout(sub.renderTimer);
            sub.renderTimer = 0;
        }
        if (sub.heartbeat) {
            clearInterval(sub.heartbeat);
            sub.heartbeat = 0;
        }
        // 释放该 agent 的作用域注册层（S6）：终态后工具/提示/变量不再对该 agent 可见。
        if (sub.agentCtx && !sub.agentCtx.disposed) sub.agentCtx.dispose();
        const s = sub.flow;
        s.stopped = state !== 'done';
        if (s.assistant && s.assistant.status === 'streaming') {
            s.assistant.status = state === 'done' ? 'done' : state;
        }
        try {
            if (backend.AIStop) backend.AIStop(sub.id);
        } catch (e) {}
        let summary = note || '';
        if (!summary && s.assistant) {
            summary = String(s.assistant.content || '').trim();
        }
        if (state === 'error' && !summary) summary = '子代理执行失败';
        if (!summary && s.wrapUp) summary = subDigestOf(sub);
        if (state === 'stopped') {
            // 守卫触发的自停不能冒充「用户停止」，否则主代理会误以为人拍板过。
            const autoStop = !!(options && options.autoStop);
            summary = summary
                ? (autoStop ? '' : '（用户停止）') + summary
                : (autoStop ? '已自动停止' : '（用户停止）');
        }
        // 阶段 B 决策（§4.4）：投递层不再截断。原 AI_SUB_SUMMARY_MAX（8000 字符）会把
        // 调研/扫描类子代理的长报告拦腰砍断且无路可取回，等于白跑。长度控制全部前移：
        // 投递契约（结论自带 path:line 证据）+ 模型单响应上限 + wrapUp 收尾轮。
        summary = summary.trim();
        const meta = sub.parentToolMessage && sub.parentToolMessage.agent;
        if (meta) {
            meta.state = state;
            meta.rounds = s.roundNo;
            meta.ms = Math.max(0, Date.now() - sub.startedAt);
            meta.tokens = s.usage ? (Number(s.usage.totalTokens) || 0) : 0;
            meta.summary = summary;
            meta.note = note || '';
        }
        const reg = agentRegistry.get(sub.key);
        if (reg) {
            reg.state = state;
            reg.summary = summary;
            reg.rounds = s.roundNo;
            reg.ms = Math.max(0, Date.now() - sub.startedAt);
            reg.tokens = s.usage ? (Number(s.usage.totalTokens) || 0) : 0;
        }
        refreshHeadChips();
        refreshAgentViewIfOpen(sub.key);
        subAgents.delete(sub.id);
        // 终态记录：done 可续（冷唤醒），error/stopped 不可续但仍可查（「停止并收集记录」）。
        // 转录一律保留至本运行期——原语 2 要拿它做「收集对话记录」；内存由 records LRU 兜底。
        pushSubAgentRecord(sub, state, summary);
        // 转录落盘：内存里的转录只活到本进程退出，`agent_stop` 承诺的「收集过程记录」
        // 因此重启即失效。这里顺手留一份到 ai-artifacts/<根会话>/sub-<agentId>.txt
        // ——用**根会话** id 分桶：嵌套代理的 parentSessionId 是上层子代理的会话 id，
        // 落在那里的话删根会话清不掉（读回时详情视图带 artifactDir，两边口径一致）。
        // 随根会话删除、可被一键清缓存回收。纯留档，失败不影响结算，所以不 await。
        try {
            const list = subAgentTranscripts.get(sub.key) || [];
            if (list.length && backend.AIArtifactWrite) {
                const text = list.map((entry) => JSON.stringify({
                    role: entry.role || '',
                    name: entry.name || '',
                    text: entry.text || '',
                })).join('\n');
                Promise.resolve(backend.AIArtifactWrite(
                    sub.rootSessionId || sub.parentSessionId, 'sub-' + sub.id, text)).catch(() => {});
            }
        } catch (e) {}
        try {
            if (sub.resolve) sub.resolve({ok: state === 'done', text: summary, state});
        } catch (e) {}
        persistSessions();
        const session = sessionById(sub.parentSessionId);
        // 接管守卫：toolMessage 只属于派出它的那个会话。孤儿改挂根会话后 session 是根会话、
        // toolMessage 却在已死父代理的转录里，indexOf 落空会退化成整屏重渲染——先验证归属。
        if (session && sub.parentToolMessage && session.messages.includes(sub.parentToolMessage)) {
            refreshToolWrap(session, sub.parentToolMessage);
        }
        // 孤儿接管：先于本代理自己的结算投递无所谓（两者独立），但要在 subAgents.delete
        // 之后跑——找下级按 parentSessionId === sub.id，子代理条目还在表里。
        const adopted = adoptOrphanChildren(sub);
        if (adopted) {
            const targetSub = subAgents.get(adopted.target);
            const targetSession = sessionById(adopted.target);
            const targetName = (targetSub && targetSub.name)
                || (targetSession && (targetSession.title || '主会话'))
                || '上级';
            flash('子代理「' + sub.name + '」已结束，' + adopted.count + ' 个运行中的下级改由「' + targetName + '」接管');
        }
        // 结算通知（原语 5 / 7）：后台模式专属——阻塞模式的结论已经作为工具结果交给主代理，
        // 再注入一份就是重复上下文。stopped 由发起方（用户 / agent_stop）自己知道，不发通知。
        if (sub.mode === 'background' && (state === 'done' || state === 'error')) {
            // 嵌套时父是子代理：投它的收件箱，由它下一轮边界消费（deliverToParent 判）。
            const delivered = deliverToParent(sub, buildSettlementNotice({
                name: sub.name, agentId: sub.id, state, summary, note,
                unconsumed: unseenInboxCount(sub),
            }));
            // 投不出去不能静默：父会话已结束 / 已归档时结论就此蒸发（嵌套里尤其难察觉）。
            if (!delivered) {
                const detail = '子代理「' + sub.name + '」的结论未能投递（父会话已结束或已归档）';
                flash(detail, true);
                notifyFailure('子代理结论未能投递', detail, {key: 'sub-deliver', kind: 'error'});
            }
        }
        if (state === 'error') {
            const detail = String(note || '执行出错');
            flash('子代理「' + sub.name + '」失败：' + detail, true);
            // A 级：子代理在后台失败，用户没盯着状态栏就会漏掉。
            notifyFailure('子代理失败', '「' + sub.name + '」：' + detail, {key: 'sub-error', kind: 'error'});
        } else if (state === 'stopped') flash('子代理「' + sub.name + '」已停止');
    }

    // 停止时未消费的收件箱条数（阶段 C 起会非零；结算文案与工具回执都要标出来）。
    function unseenInboxCount(sub) {
        const inbox = sub && sub.inbox;
        if (!inbox) return 0;
        const n = (inbox.step || []).length + (inbox.turn || []).length + (inbox.ask ? 1 : 0);
        return n;
    }

    // 会话删除：它名下的终态记录与转录一并丢弃（records 是 LRU，但死会话的活引用没理由留着）
    function dropSubAgentRecordsOf(sessionId) {
        if (!sessionId) return 0;
        let n = 0;
        for (const [agentId, rec] of [...subAgentRecords]) {
            if (rec.parentSessionId !== sessionId && rec.rootSessionId !== sessionId) continue;
            subAgentRecords.delete(agentId);
            subAgentTranscripts.delete(rec.key);
            n++;
        }
        return n;
    }

    // ---- 子代理收件箱（对齐 dsh 的双队列：step 插队 / turn 排队）----

    // 入队即唤醒在 `sub.id` 上 wait_agent 的调用方（父代理等下级回报走这条）。
    // 只唤醒不注入：注入仍是轮边界 consumeSubInbox 的事。
    function notifyInbox(sub) {
        if (!sub || !inboxWaiters) return;
        if (typeof inboxWaiters.notify === 'function') inboxWaiters.notify(sub.id, 'agent');
    }

    // 唯一消费点。step 在前、turn 在后（插队优先），消费后清空。
    // 每条都落一条 notice user 消息，并同步进转录供详情视图查看。
    function consumeSubInbox(sub) {
        const batch = takeInboxBatch(sub.inbox);
        if (!batch.length) return 0;
        const ts = Date.now();
        for (const item of batch) {
            const content = inboxMessageText(item);
            sub.session.messages.push({role: 'user', content, ts, turnStartedAt: ts, notice: true});
            subTranscriptPush(sub, {role: 'user', text: content});
        }
        refreshAgentViewIfOpen(sub.key);
        return batch.length;
    }

    // 排队：子代理下一轮边界可见（不打断在飞调用）。
    function queueSubAgentMessage(sub, text, opts) {
        const item = {text: String(text || ''), from: (opts && opts.from) || 'agent', ts: Date.now()};
        sub.inbox.turn.push(item);
        notifyInbox(sub);
        refreshHeadChips();
        refreshAgentViewIfOpen(sub.key);
        return item;
    }

    // 插队：插到队首并打断当前在飞模型调用。注意与主对话不同——主对话的「插话」已改为
    // 不打断（turn steering），子代理的插队仍是抢占语义（对齐旧的「停止当前回复并立即发送」）。
    // 压缩中降级为排队——压缩流正拿摘要，AIStop 会连摘要一起丢（§4.10.4）。
    function steerSubAgent(sub, text, opts) {
        const item = {text: String(text || ''), from: (opts && opts.from) || 'agent', ts: Date.now()};
        sub.inbox.step.unshift(item);
        notifyInbox(sub);
        refreshHeadChips();
        refreshAgentViewIfOpen(sub.key);
        if (sub.compacting) return {item, kicked: false, degraded: true};
        sub.steerKick = true;
        try {
            if (backend.AIStop) backend.AIStop(sub.id);
        } catch (e) {}
        return {item, kicked: true, degraded: false};
    }

    // 统一停止：用户停止主回合、主代理 agent_stop、HUD 停止按钮都走这里。
    // 保留收件箱内容（停止当前轮 ≠ 清空队列），并把未消费条数写进结算文案。
    function stopSubAgent(sub, reason, options) {
        if (!sub || sub.state !== 'running') return false;
        // 先放行它自己身上的 wait_agent：停止必须立刻返回，而不是等 250ms 心跳
        // （心跳只是兜底——会话被删 / 流已摘除时没有别的唤醒源）。
        if (inboxWaiters && typeof inboxWaiters.cancel === 'function') inboxWaiters.cancel(sub.id);
        // 插队标记必须清掉：否则 AIStop 引发的事件会被误判成「插队续轮」
        sub.steerKick = false;
        // 挂起中的提问先落定：否则 ask_user 那个 await 会一直悬着（工具轮不算结束）
        settleSubAsk(sub, '', 'stopped');
        // 压缩中停止：AIStop(sub.id) 的「精确 id 或 id# 前缀」匹配会连压缩流一起取消，
        // 这里同步清注册表与标记，避免 compacting 永久卡住（§4.10.4）
        for (const [compactId, job] of [...subCompacts]) {
            if (job.subId !== sub.id) continue;
            subCompacts.delete(compactId);
        }
        sub.compacting = false;
        sub.compactRequested = false;
        sub.flow.stopped = true;
        try {
            if (backend.AIStop) backend.AIStop(sub.id);
        } catch (e) {}
        finalizeSubAgent(sub, 'stopped', reason || '', options);
        return true;
    }

    // 过程记录摘要（原语 2「停止并收集记录」）：最后一条输出 + 最近工具调用概览。
    function subRunDigest(key) {
        const list = subAgentTranscripts.get(key) || [];
        const tools = list.filter((entry) => entry.role === 'tool');
        const lastAssistant = [...list].reverse().find((entry) => entry.role === 'assistant' && !entry.live);
        const lines = [];
        if (lastAssistant && String(lastAssistant.text || '').trim()) {
            lines.push('最后一条输出：', String(lastAssistant.text).trim());
        }
        if (tools.length) {
            lines.push('已执行工具 ' + tools.length + ' 次，最近：');
            for (const entry of tools.slice(-8)) {
                lines.push('- ' + (entry.name || 'tool') + '：' + String(entry.text || '').trim().slice(0, 160));
            }
        }
        return lines.join('\n') || '（没有可用的过程记录）';
    }

    // 冷唤醒：对 done 且记录仍持有活引用的子代理继续派活（baseRound+1，事件路由照旧）。
    function reviveSubAgent(record, text, opts) {
        if (!record || record.continuable === false || !record.session || !record.profile) return null;
        // 唤醒时间戳：新一轮落账前，wait_agent 靠它识别「手上这份是唤醒前的旧结论」，
        // 不把上一轮结果当成本轮结果返回（2026-11-15 实测缺陷）。
        record.revivedAt = Date.now();
        const parent = sessionById(record.parentSessionId);
        const toolMessage = parent
            ? parent.messages.find((m) => m.role === 'tool' && m.toolCallId === record.toolCallId) || null
            : null;
        const sub = {
            id: record.id,
            key: record.key,
            toolCallId: record.toolCallId,
            depth: record.depth,
            mode: record.mode || 'background',
            parentSessionId: record.parentSessionId,
            rootSessionId: record.rootSessionId,
            parentToolMessage: toolMessage,
            name: record.name,
            task: record.task,
            maxRounds: Number(record.maxRounds) || AI_SUB_ROUNDS_DEFAULT,
            state: 'running',
            startedAt: Date.now(),
            renderTimer: 0,
            heartbeat: 0,
            resolve: null,
            settled: null,
            session: record.session,
            profile: record.profile,
            entry: record.entry,
            inbox: newSubInbox(),
        };
        // 能力快照随记录恢复（v2 快照带全绝对路径，§8.2）；缺快照按最窄只读兜底。
        // 沙箱档与隔离区也一并重建（存量缺口，2026-11-28 审查补）：复活前 sub.sandboxMode
        // 为空 → HUD 档位徽标退化、终态留痕丢 sandbox 标记；worktree 只存在于
        // record.session.worktree → systemPrompt 丢 worktree 段、worktreeNamesForSession
        // 收集不到该隔离区（export/discard 看不见它）。
        sub.capabilities = (sub.session && sub.session.capabilities) || READ_ONLY_CAPABILITIES;
        sub.sandboxMode = sub.capabilities && sub.capabilities.fs ? sub.capabilities.fs.mode : 'read-only';
        sub.worktree = (sub.session && sub.session.worktree) || null;
        const assistant = newAssistantMessage(record.profile, record.entry);
        sub.flow = {
            sessionId: sub.id,
            baseRound: (Number(record.baseRound) || 1) + 1,
            roundNo: 0,
            roundId: sub.id + '#' + ((Number(record.baseRound) || 1) + 1) + '-0',
            assistant,
            startedAt: Date.now(),
            thinkStartedAt: 0,
            roundStartedAt: 0,
            firstTokenAt: 0,
            renderTimer: 0,
            finished: false,
            stopped: false,
            wrapUp: false,
            toolCalls: new Map(),
            profileCfg: subAgentConfigFor(record.profile, record.entry),
            systemPrompt: subSystemPromptFor(record.depth, record.mode, (record.session && record.session.capabilities) || null, !!sub.worktree),
            usage: null,
        };
        // 终态记录移出（重新变 live）：事件路由、HUD、LRU 都以 subAgents 为准
        subAgentRecords.delete(sub.id);
        subAgents.set(sub.id, sub);
        auditAgent(sub, 'spawn');
        if (toolMessage && toolMessage.agent) {
            toolMessage.agent.state = 'running';
            toolMessage.agent.note = '';
            // 复活重建（同上注释）：派单卡片的档位与角色名照常回显
            toolMessage.agent.sandboxMode = sub.sandboxMode;
            toolMessage.agent.preset = sub.capabilities ? sub.capabilities.preset : '';
        }
        const reg = agentRegistry.get(sub.key);
        if (reg) {
            reg.state = 'running';
            reg.summary = '';
            reg.note = '';
        }
        notifyBackgroundActivity();
        persistSessions();
        if (toolMessage && parent) refreshToolWrap(parent, toolMessage);
        // 投递消息必须先消费成 user 消息、再 push 空的 assistant 续写目标。
        // 顺序反了（assistant 在前）时，runSubRound 用 buildApiMessages(sub.session,
        // indexOf(assistant)) 组装请求，只会取到 assistant 之前的消息，这条投递被整体排除，
        // 模型只能续写唤醒前的旧上下文，产出上一轮的答案（2026-11-16 实测：last=0、
        // len≈上一轮长度）。runSubRound 开头的 consumeSubInbox 此时收件箱已空，是 no-op。
        queueSubAgentMessage(sub, text, {from: (opts && opts.from) || 'agent'});
        if (opts && opts.urgent) sub.inbox.step.unshift(sub.inbox.turn.pop());
        consumeSubInbox(sub);
        sub.session.messages.push(assistant);
        const outcomePromise = new Promise((resolve) => { sub.resolve = resolve; });
        sub.settled = outcomePromise;
        runSubRound(sub);
        return sub;
    }

    // agent_send 执行体：运行中排队 / 插队，已完成冷唤醒，失败记录拒绝。
    function sendToSubAgent(input, ctx, owned) {
        const agentId = aiTextOf(input && input.agentId).trim();
        const message = aiTextOf(input && input.message).trim();
        if (!agentId) throw new Error('agentId 不能为空');
        if (!message) throw new Error('message 不能为空');
        // 方向守卫：子代理只能给自己派出的下级发（回答它们的提问 / 补线索 / 冷唤醒）。
        // 放开给祖先或兄弟会让整棵树变成可以互相喊话的聊天室，且与「父等子」的等待模型纠缠。
        const viewer = ctx && ctx.session;
        if (viewer && viewer.parentSessionId) {
            const under = agentDescendsFrom(agentId, viewer.id,
                (id) => parentSessionIdOf(id, subAgents, subAgentRecords));
            if (!under) {
                throw new Error('子代理只能给自己派出的下级发消息：' + agentId + ' 不是你的下级' +
                    '（要向上汇报请在最终结论里写，主代理会收到）');
            }
        }
        const urgent = input && input.urgent === true;
        const askId = aiTextOf(input && input.askId).trim();
        const live = subAgents.get(agentId);
        if (live) {
            if (owned && !owned(live.rootSessionId)) throw new Error('子代理 ' + agentId + ' 不属于当前会话，无法投递');
            // 提问回答（阶段 D）：命中挂起中的 askId 就地落定，不再走队列
            const answered = answerSubAsk(live, askId, message);
            if (answered) return answered;
            if (urgent) {
                const r = steerSubAgent(live, message, {from: 'agent'});
                return '已插队投递给子代理「' + live.name + '」：打断了它当前的模型调用，' +
                    '消息将在下一步最前注入。' + (r.degraded ? '（它正在压缩上下文，本次改为排队，压缩完成后消费）' : '');
            }
            queueSubAgentMessage(live, message, {from: 'agent'});
            return '已排队投递给子代理「' + live.name + '」：它当前轮结束后（下一轮边界）可见。';
        }
        const record = subAgentRecords.get(agentId);
        if (!record) throw new Error('找不到子代理 ' + agentId + '（可能已被清理）：可用 wait_agent 或重新 spawn_agent');
        if (owned && !owned(record.rootSessionId)) throw new Error('子代理 ' + agentId + ' 不属于当前会话，无法投递');
        const gate = canReviveRecord(record);
        if (!gate.ok) {
            if (gate.reason === 'terminated') {
                throw new Error('子代理「' + record.name + '」已' + (record.state === 'error' ? '失败' : '停止') +
                    '，不能继续；需要的话重新 spawn_agent 派单');
            }
            if (gate.reason === 'recycled') {
                // 优先透出真实原因：v1 旧快照的不可续原因是「快照版本过旧」（restoreAgentRuns
                // 存在 resumeReason / note），笼统的「上下文已回收」会误导诊断方向。
                const why = record.resumeReason || record.note || '';
                throw new Error('子代理「' + record.name + '」无法继续'
                    + (why ? '：' + why : '（终态记录超出上限，上下文已回收）') + '；请重新派单');
            }
            throw new Error('找不到子代理 ' + agentId + '（可能已被清理）');
        }
        const revived = reviveSubAgent(record, message, {from: 'agent', urgent});
        if (!revived) throw new Error('子代理「' + record.name + '」无法唤醒（缺少父会话或模型配置）；请重新派单');
        return '已唤醒子代理「' + revived.name + '」（id=' + revived.id + '，第 ' + (revived.flow.baseRound) +
            ' 轮起继续），消息已投递。完成后会照常通知你。';
    }

    // agent_stop 执行体：停止运行中的子代理并收集过程记录；对终态记录返回历史摘要。
    // 停止目标及其整棵子树（全部层级的孙代理 / 曾孙代理）：主代理只有直接下级的 id，
    // 不能要求它逐个点名嵌套代理。按层级从深到浅停，父代理收尾时下级已经落定。
    function stopSubTree(sub, reason) {
        const all = [...subAgents.values()];
        const ids = [sub.id, ...subTreeIdsOf(all, sub.id)];
        const targets = ids
            .map((id) => subAgents.get(id))
            .filter((item) => item && item.state === 'running')
            .sort((a, b) => (b.depth || 0) - (a.depth || 0));
        for (const item of targets) stopSubAgent(item, reason || '主代理停止');
        return targets;
    }

    function stopSubAgentByInput(input, ctx, owned) {
        const agentId = aiTextOf(input && input.agentId).trim();
        // 省略 agentId：停掉本会话任务树里所有运行中的子代理（含孙代理与更深层级）。
        // 这是「把子代理和孙代理全停了」的入口——嵌套代理的 id 从来不会回到主代理手上。
        // 调用者本身是子代理时只看自己这一支（防将来给子代理放开 agent_stop 时误停兄弟 / 祖先）。
        if (!agentId) {
            const all = [...subAgents.values()];
            const caller = ctx && ctx.session;
            const scope = caller && caller.parentSessionId ? new Set(subTreeIdsOf(all, caller.id)) : null;
            const running = all
                .filter((sub) => sub.state === 'running'
                    && (!scope || scope.has(sub.id))
                    && (!owned || owned(sub.rootSessionId || sub.parentSessionId)))
                .sort((a, b) => (b.depth || 0) - (a.depth || 0));
            if (!running.length) return '当前没有运行中的子代理可停止。';
            const lines = running.map((sub) => '- 「' + sub.name + '」'
                + (sub.depth >= 1 ? '（第 ' + (sub.depth + 1) + ' 层）' : ''));
            for (const sub of running) stopSubAgent(sub, '主代理停止');
            return '已停止 ' + running.length + ' 个子代理（含各层级）：\n' + lines.join('\n');
        }
        const live = subAgents.get(agentId);
        if (live) {
            if (owned && !owned(live.rootSessionId)) throw new Error('子代理 ' + agentId + ' 不属于当前会话，未停止');
            const unconsumed = unseenInboxCount(live);
            const name = live.name;
            const key = live.key;
            const stopped = stopSubTree(live, '主代理停止');
            const record = subAgentRecords.get(agentId);
            const summary = (record && record.summary) || '';
            const cascaded = stopped.filter((sub) => sub.id !== live.id);
            return '已停止子代理「' + name + '」' +
                (cascaded.length ? '及其 ' + cascaded.length + ' 个下级（含各层级）' : '') +
                (unconsumed ? '（停止时仍有 ' + unconsumed + ' 条未消费消息）' : '') + '。\n' +
                (cascaded.length ? '一并停止：' + cascaded.map((sub) => '「' + sub.name + '」').join('、') + '\n' : '') +
                (summary ? '进度与结论：\n' + summary + '\n' : '') +
                '过程记录：\n' + subRunDigest(key);
        }
        const record = subAgentRecords.get(agentId);
        if (!record) throw new Error('找不到子代理 ' + agentId + '（可能已被清理）');
        if (owned && !owned(record.rootSessionId)) throw new Error('子代理 ' + agentId + ' 不属于当前会话，未停止');
        // 父代理已结束、它派出的下级可能还在跑：按记录 id 继续级联停掉
        const cascadeIds = new Set(subTreeIdsOf([...subAgents.values()], record.id));
        const cascaded = [...subAgents.values()]
            .filter((sub) => sub.state === 'running' && cascadeIds.has(sub.id))
            .sort((a, b) => (b.depth || 0) - (a.depth || 0));
        for (const sub of cascaded) stopSubAgent(sub, '主代理停止');
        const stateText = {done: '已完成', error: '已失败', stopped: '已停止'}[record.state] || record.state;
        return '子代理「' + record.name + '」' + stateText +
            '（轮次 ' + (record.rounds || 0) + ' · 用时 ' + Math.round((record.ms || 0) / 1000) + 's）' +
            (cascaded.length ? '；它的 ' + cascaded.length + ' 个下级仍在运行，已一并停止' : '') + '。\n' +
            '结论：\n' + (record.summary || '（无结论）') + '\n' +
            '过程记录：\n' + subRunDigest(record.key);
    }

    // ---- 子代理压缩（§4.10）：auto-compact 在轮边界触发；手动由 agent_compact 与详情视图发起 ----

    function subContextTokens(sub) {
        const s = sub.flow;
        if (!s) return 0;
        try {
            const built = buildApiMessages(sub.session, null, s.systemPrompt);
            if (typeof estimateApiMessagesContext === 'function') {
                return estimateApiMessagesContext(built, getBuildAnchor()).tokens;
            }
            return estimateApiMessagesTokens(built);
        } catch (e) {
            return 0;
        }
    }

    // 轮边界判定（runSubRound 调用）。返回 true = 已发起压缩，本轮先不继续（压缩完成后续轮）。
    function maybeStartSubCompact(sub) {
        if (sub.compacting) return false;
        const manual = sub.compactRequested === true;
        if (!manual && getConfig().autoCompact !== true) return false;
        if ((sub.session.messages || []).length <= COMPACT_KEEP_TAIL) {
            sub.compactRequested = false;
            return false;
        }
        if (manual) {
            sub.compactRequested = false;
            return startSubCompact(sub, {auto: false});
        }
        const windowSize = contextWindowOf(sub.session);
        if (windowSize <= 0) return false;
        const threshold = compactThresholdOf(getConfig());
        const over = subContextTokens(sub) >= windowSize * threshold;
        if (!over) {
            // 这一轮没超阈：上次压缩起效了，连续计数清零（与主会话 autoCompactCount 同语义）
            sub.compactStreak = 0;
            return false;
        }
        // 连续 2 次仍超阈：不再自动压缩，交给 AI_SUB_MESSAGES_MAX / wrapUp 收尾兜底
        if ((Number(sub.compactStreak) || 0) >= 2) return false;
        return startSubCompact(sub, {auto: true});
    }

    // 发起压缩。target 可以是运行中的 sub，也可以是 done 记录的 record（两者的 session /
    // profile / entry 形状一致）——后者用于「已完成子代理立即压缩，之后唤醒以精简上下文继续」。
    function startSubCompact(target, opts) {
        if (!target || !target.session) return false;
        const live = subAgents.get(target.id) || null;
        if (live && live.compacting) return false;
        const profile = target.profile || (live ? live.profile : null);
        if (!profile || !backend.AISendChat) return false;
        const entry = target.entry || null;
        const id = target.id + '#compact-' + Date.now() + '-' + (++subCompactSeq);
        if (live) live.compacting = true;
        subCompacts.set(id, {
            id, subId: target.id, buffer: '', startedAt: Date.now(),
            auto: !!(opts && opts.auto), live: !!live,
        });
        refreshHeadChips();
        if (live) refreshAgentViewIfOpen(live.key);
        const messages = buildCompactMessages(target.session, AI_COMPACT_SYSTEM_PROMPT, (opts && opts.instruction) || '');
        const flowCfg = (live && live.flow && live.flow.profileCfg) || subAgentConfigFor(profile, entry);
        try {
            const req = backend.AISendChat(id, flowCfg, messages, [], getConfig().retryMax);
            if (req && typeof req.then === 'function') {
                req.catch((e) => failSubCompact(id, (e && e.message) || '压缩请求失败'));
            }
        } catch (e) {
            failSubCompact(id, (e && e.message) || '压缩请求失败');
        }
        return true;
    }

    function failSubCompact(id, message) {
        const job = subCompacts.get(id);
        if (!job) return;
        subCompacts.delete(id);
        const sub = subAgents.get(job.subId) || null;
        if (sub) {
            sub.compacting = false;
            sub.compactFails = (Number(sub.compactFails) || 0) + 1;
            // 连续两次失败：别把预算耗在压缩上，置 wrapUp 让收尾轮产出结论
            if (sub.compactFails >= 2 && sub.flow && !sub.flow.wrapUp) {
                sub.flow.wrapUp = true;
                sub.session.messages.push({
                    role: 'user',
                    content: '（压缩连续失败，改为尽快收尾：不要再探索，立即基于已完成的工作输出最终结论与证据。）',
                    ts: Date.now(),
                    systemNote: true,
                });
            }
            refreshHeadChips();
            refreshAgentViewIfOpen(sub.key);
            if (sub.state === 'running') runSubRound(sub);
        }
        if (!job.auto && message) flash('子代理压缩失败：' + message, true);
    }

    // 压缩流事件（panel 的 handleEvent 在 subAgents 分支**之前**转到本函数，见 §4.10.1）：
    // 压缩 roundId 是 subId#compact-…，落到 handleSubEvent 会因 roundId 不匹配被静默丢弃。
    function handleSubCompactEvent(name, payload, job) {
        if (!job) return;
        if (name === 'ai-chunk' && payload && payload.delta) {
            job.buffer += payload.delta;
            return;
        }
        if (name === 'ai-error') {
            failSubCompact(job.id, (payload && payload.message) || '压缩失败');
            return;
        }
        if (name !== 'ai-done') return;
        const text = String(job.buffer || '').trim();
        if (!text) {
            failSubCompact(job.id, '模型没有返回摘要');
            return;
        }
        subCompacts.delete(job.id);
        const sub = subAgents.get(job.subId) || null;
        const record = subAgentRecords.get(job.subId) || null;
        const session = (sub && sub.session) || (record && record.session) || null;
        if (!session) return;
        // 保留预算按 token 计（窗口−输出预留 的 16%，与 dsh 的 retainRatio 对齐）
        const retainBudget = compactRetainBudget(contextWindowOf(session), outputReserveOf(session));
        const cutoff = computeCompactCutoffByBudget(
            session.messages, retainBudget, (message) => estimateApiMessagesTokens([message]), COMPACT_KEEP_TAIL);
        if (cutoff > 0) {
            const summary = buildCompactSummary(text, cutoff,
                {kind: job.auto ? 'auto' : 'manual', scope: 'subagent'}, session.messages.length);
            // 零改动生效：buildApiMessages 对 session.summary 是通用形状判断，
            // 下一条请求会自动带上第二条 system <conversation_summary>。
            applyCompactToSession(session, summary, cutoff);
        }
        if (sub) {
            sub.compacting = false;
            sub.compactFails = 0;
            sub.compactStreak = (Number(sub.compactStreak) || 0) + 1;
            refreshHeadChips();
            refreshAgentViewIfOpen(sub.key);
            if (sub.state === 'running') runSubRound(sub);
        } else if (record) {
            refreshHeadChips();
        }
    }

    // agent_compact 执行体：运行中 → 请求在下一轮边界执行；done 可续记录 → 立即压缩。
    function compactSubAgentByInput(input, owned) {
        const agentId = aiTextOf(input && input.agentId).trim();
        if (!agentId) throw new Error('agentId 不能为空');
        const live = subAgents.get(agentId);
        if (live) {
            if (owned && !owned(live.rootSessionId)) throw new Error('子代理 ' + agentId + ' 不属于当前会话，未压缩');
            if (live.compacting) return '子代理「' + live.name + '」正在压缩上下文，本次请求已合并。';
            live.compactRequested = true;
            return '已请求压缩子代理「' + live.name + '」：将在当前工具轮结束后的轮边界执行（不打断在飞工作）。' +
                '完成后它会以精简上下文继续；摘要与规模可在它的详情视图查看。';
        }
        const record = subAgentRecords.get(agentId);
        if (!record) throw new Error('找不到子代理 ' + agentId + '（可能已被清理）');
        if (owned && !owned(record.rootSessionId)) throw new Error('子代理 ' + agentId + ' 不属于当前会话，未压缩');
        const gate = canReviveRecord(record);
        if (!gate.ok) {
            throw new Error(gate.reason === 'terminated'
                ? '子代理「' + record.name + '」已终止，无需压缩'
                : '子代理「' + record.name + '」的上下文已回收（终态记录超出上限），无法压缩');
        }
        const count = (record.session && record.session.messages || []).length;
        if (count <= COMPACT_KEEP_TAIL) {
            return '子代理「' + record.name + '」当前只有 ' + count + ' 条消息（≤' + COMPACT_KEEP_TAIL + '），无需压缩。';
        }
        if (record.session.summary) {
            return '子代理「' + record.name + '」的上下文已经是压缩后的（已保留摘要），无需再压。';
        }
        startSubCompact(record, {auto: false});
        return '已发起压缩子代理「' + record.name + '」的上下文（压缩前 ' + count + ' 条消息）。' +
            '完成后 agent_send 唤醒将以精简上下文继续；结果可在它的详情视图查看。';
    }

    // wait_agent 执行体（对齐 dsh：等「我自己下一步的新输入」，不指向具体代理）。
    // 工具结果是一句话说明（模型读的是文案，不是 JSON）。
    // 为什么不再等「某个子代理的终态」（2026-11-17 五层嵌套实测）：旧实现必须靠守卫补
    // 自等超时 / 跨支误拒 / 记录被 LRU 回收后结论取不到三类坑；等自己的收件箱从定义上没有这些。
    //
    // reportedPending：同一轮内「已经报告过有新输入」的记录（对齐 dsh wait-agent 的 seen 集合）。
    // 没有它时，模型在同一轮里重复调 wait_agent 会每次都立刻拿到「有新输入」（注入只在轮边界，
    // 计数本轮不会变），于是可以自旋到用户手动停——主代理没有逐轮硬上限。
    const reportedPending = new WeakMap();  // stream -> {ownerId, count}

    async function waitForInbox(input, ctx) {
        const viewer = ctx && ctx.session;
        if (!viewer) throw new Error('当前没有会话上下文');
        // timeoutSec 的缺省必须自己判：aiClampInt 用 Math.round(Number(x))，
        // null / '' / false 都会变成 0 并且是 finite（不走 fallback），而 0 曾表示「不限时」
        // ——不建 deadline，一旦 notify 与停止都不来就永久悬挂。现在最小 5 秒、缺省 60 秒，
        // 不再保留「不限时」：等不到就返回，让模型自己决定下一步。
        const rawTimeout = input ? input.timeoutSec : undefined;
        const timeoutSec = resolveWaitTimeoutSec(rawTimeout);
        const sub = subAgents.get(viewer.id);
        // 收尾轮不消费收件箱（runSubRound 的 !s.wrapUp 守卫）：等下去永远拿不到输入。
        if (sub && sub.flow && sub.flow.wrapUp) {
            return '轮次预算已用尽（收尾轮不再消费新输入）：不要再等待，立即基于现有上下文输出最终结论。';
        }
        // caller 是子代理会话但已不在运行态（被停止 / 记录回收）：它没有信箱也不会有新输入。
        if (!sub && viewer.parentSessionId) {
            return '你这一轮已经结束（上下文可能已回收），不会有新输入进来：不要再等待。';
        }
        if (!inboxWaiters) return '当前版本不支持等待原语：请直接继续工作，或结束本轮等新消息。';
        const hub = noticesLike();
        // 注意：这是**模块 ctx**取到的 getter（工具 ctx 只有 session/toolMessage/stream，
        // 拿不到它）；改成从工具 ctx 读会恒为 undefined，判定等于关掉。
        const lanesOf = typeof queueLanesOf === 'function' ? queueLanesOf : () => ({queue: false, steer: false});
        const countPending = () => {
            if (sub) return pendingInboxCount(sub);
            const noticeCount = hub && typeof hub.pendingCount === 'function' ? hub.pendingCount(viewer.id) : 0;
            // 排队车道（queue）不计入待消费输入：排队不打扰等待（本轮结束后由 flush 送达），
            // 算进去只会让排队一条消息就把等待白白唤醒一轮（唤醒了也读不到内容）。
            return noticeCount + (lanesOf(viewer.id).steer ? 1 : 0);
        };
        const isStopped = () => {
            if (sub) return sub.state !== 'running';
            if (!ctx.stream) return true;
            // finished 也要算停止：finishStream 只置 finished 并摘流（不置 stopped），
            // 漏了它会让等待跑满整个 timeoutSec。
            return !!(ctx.stream.stopped || ctx.stream.finished);
        };
        const roundKey = ctx.stream || null;
        const countNow = countPending();
        if (roundKey) {
            const prev = reportedPending.get(roundKey);
            if (prev && prev.ownerId === viewer.id && prev.count === countNow) {
                return '这些输入本轮已经报告过了（注入发生在轮边界，本轮内不会再变）：' +
                    '不要再 wait_agent，直接结束本轮即可读到。';
            }
        }
        const result = await inboxWaiters.wait(viewer.id, {
            timeoutMs: timeoutSec * 1000,
            hasPending: () => countPending() > 0,
            isStopped,
        });
        if (result && result.stopped) {
            return '等待被停止：可稍后再 wait_agent，或等新消息进来时再继续。';
        }
        if (!result || result.timedOut) {
            // 超时检查点顺带提示「输入框有排队消息」：排队不打扰等待，但模型该知道有消息
            // 在等，工作告一段落时可自行收轮去接收（只有主会话有输入框排队，子代理恒无）。
            return waitTimeoutText(timeoutSec, lanesOf(viewer.id).queue);
        }
        if (roundKey) reportedPending.set(roundKey, {ownerId: viewer.id, count: countPending()});
        // 唤醒来源分文案：notify 带回的 source 优先；心跳 / 落地即有的兜底结算没有 source，
        // 按当前车道推断（steer 挂着给插话文案，否则通用通知文案——排队不唤醒等不到这）。
        const wakeSource = (result && result.source) || (lanesOf(viewer.id).steer ? 'steer' : '');
        return waitWakeText(wakeSource);
    }

    // 工具分发薄壳（panel 的 agent_tool case 转调；各阶段在此追加）
    // agent_tree：把自己所在的团队树交给模型（含各层级 id、状态、任务摘要与「你」的标注）。
    // 主代理看到整棵任务树，子代理只看自己这一支——嵌套代理的 id 只有这里才会回到主代理手上。
    function agentTreeOf(ctx) {
        const viewerSession = ctx && ctx.session;
        if (!viewerSession) throw new Error('当前没有会话上下文');
        const owner = rootSessionIdOf(viewerSession);
        const isMain = !viewerSession.parentSessionId;
        const live = subAgents.get(viewerSession.id);
        // 自查深度：运行态优先；已结束（冷唤醒窗口 / 只留终态记录）退回记录里的 depth，
        // 缺两者时才兜底 1——否则第 5 层的代理会把自己标成「第 2 层」。
        const record = live ? null : subAgentRecords.get(viewerSession.id);
        const viewer = isMain
            ? {isMain: true, id: viewerSession.id, title: viewerSession.title || ''}
            : {
                isMain: false,
                id: viewerSession.id,
                name: (live && live.name) || viewerSession.title || '子代理',
                depth: live ? live.depth : ((record && record.depth) || 1),
            };
        return agentTreeText(viewer, listAgentsForHud(owner));
    }

    function handleAgentTool(name, input, ctx) {
        // 子代理记录按任务树隔离（与 wait_agent / stop_command 同一口径）：别的会话的 agentId
        // 不能投递 / 停止 / 压缩——投递会消费对方收件箱，停止会掐掉对方在跑的任务。
        const owner = ctx && ctx.session ? rootSessionIdOf(ctx.session) : '';
        const owned = (rootId) => subTreeOwned(owner, rootId);
        if (name === 'agent_tree') return agentTreeOf(ctx);
        if (name === 'agent_send') return sendToSubAgent(input, ctx, owned);
        if (name === 'agent_stop') return stopSubAgentByInput(input, ctx, owned);
        if (name === 'wait_agent') return waitForInbox(input, ctx);
        if (name === 'agent_compact') return compactSubAgentByInput(input, owned);
        throw new Error('工具「' + name + '」尚未启用');
    }

    // ---- 子代理提问（原语 6）：子发问 → 父作答 → 子续轮 ----

    // 提问超时：默认 120s 后按 ai_decide 语义放行（不悬挂，不让父代理的一次疏忽卡死子代理）。
    const SUB_ASK_TIMEOUT_SEC = 120;

    function subAskQuestions(input) {
        const list = Array.isArray(input && input.questions) ? input.questions : [];
        const out = [];
        for (const q of list.slice(0, 8)) {
            const text = aiTextOf(q && q.question).trim();
            if (!text) continue;
            const options = Array.isArray(q && q.options)
                ? q.options.map((opt) => aiTextOf(opt && opt.label).trim()).filter(Boolean)
                : [];
            out.push({text, options});
        }
        return out;
    }

    function askAnswerText(answer, how) {
        if (how === 'timeout') return '主代理未及时回答，请基于现有上下文自行决定并继续。';
        if (how === 'stopped') return '主代理已停止本次任务，无需再回答。';
        return '主代理的回答：' + String(answer || '').trim();
    }

    // 落定挂起的提问（回答 / 超时 / 子代理被停止）。
    function settleSubAsk(sub, answer, how) {
        const ask = sub && sub.inbox ? sub.inbox.ask : null;
        if (!ask) return false;
        sub.inbox.ask = null;
        if (ask.timer) {
            clearTimeout(ask.timer);
            ask.timer = 0;
        }
        // 记住 askId：超时后父代理迟到的回答要降级为普通排队消息并标注（不报错）
        sub.lastAskId = ask.askId;
        refreshHeadChips();
        refreshAgentViewIfOpen(sub.key);
        try {
            if (ask.resolve) ask.resolve(askAnswerText(answer, how));
        } catch (e) {}
        return true;
    }

    // 子代理侧 ask_user 执行体（executeTool 的 ask_user case 转调）：
    // 不建 pendingAsks UI、不挂用户输入区——挂 sub.inbox.ask 并向父代理投递提问卡片。
    // **仅后台模式可用**：阻塞模式的父回合被 await 占住，没人能回答，必然超时。
    function runSubAskQuestion(input, ctx) {
        const sub = subAgents.get(ctx && ctx.session && ctx.session.id);
        if (!sub) throw new Error('子代理上下文已失效（可能已被停止）');
        if (sub.mode !== 'background') {
            throw new Error('阻塞模式的子代理不能向主代理提问（主代理正等你的结论）：请基于现有信息自行决定并完成');
        }
        if (sub.inbox.ask) throw new Error('已有一个等待主代理回答的提问（askId=' + sub.inbox.ask.askId + '），请等回答或先自行决定');
        const questions = subAskQuestions(input);
        if (!questions.length) throw new Error('ask_user 至少需要一个有效问题');
        const askId = (ctx.toolMessage && ctx.toolMessage.toolCallId) || aiNowId('ask-');
        const entry = {askId, questions, resolve: null, timer: 0, createdAt: Date.now()};
        sub.inbox.ask = entry;
        // 嵌套时父是子代理（deliverToParent 判）：提问同样要能到达它。
        deliverToParent(sub, buildAskNotice({
            name: sub.name, agentId: sub.id, askId, questions,
        }));
        refreshHeadChips();
        refreshAgentViewIfOpen(sub.key);
        const timeoutMs = SUB_ASK_TIMEOUT_SEC * 1000;
        entry.timer = setTimeout(() => {
            if (sub.inbox.ask !== entry) return;
            settleSubAsk(sub, '', 'timeout');
        }, timeoutMs);
        return new Promise((resolve) => {
            entry.resolve = resolve;
        });
    }

    // 回答路由：命中挂起提问就地落定；askId 是已超时的那次则降级为普通排队消息。
    function answerSubAsk(sub, askId, message) {
        const ask = sub && sub.inbox ? sub.inbox.ask : null;
        if (ask && (!askId || ask.askId === askId)) {
            settleSubAsk(sub, message, 'answered');
            return '已回答子代理「' + sub.name + '」的提问（askId=' + ask.askId + '）：它会把这条当作提问结果继续。';
        }
        if (askId && sub.lastAskId === askId) {
            queueSubAgentMessage(sub, '（迟到的回答）' + message, {from: 'agent'});
            return '该提问已超时放行（子代理已自行决定继续），回答已作为普通消息排队，并标注「迟到的回答」。';
        }
        return '';
    }

    function stopSubAgentsOf(sessionId) {
        for (const sub of [...subAgents.values()]) {
            const owner = sub.rootSessionId || sub.parentSessionId;
            if (owner !== sessionId || sub.state !== 'running') continue;
            stopSubAgent(sub, '会话停止');
        }
    }

    // 本会话派生的子代理隔离区（含运行中与终态记录）：worktree_manage 的 export/discard
    // 按 name 操作时以此判定「本会话拥有的」——别的会话的隔离区不可触碰。
    function worktreeNamesForSession(sessionId) {
        const out = [];
        const seen = new Set();
        const collect = (sub) => {
            const wt = sub && sub.worktree;
            const owner = sub && (sub.parentSessionId || sub.rootSessionId);
            if (wt && wt.name && wt.baseSha && owner === sessionId && !seen.has(wt.name)) {
                seen.add(wt.name);
                out.push({name: wt.name, baseSha: wt.baseSha});
            }
        };
        for (const sub of subAgents.values()) collect(sub);
        for (const record of subAgentRecords.values()) collect(record);
        return out;
    }

    // 磁盘转录补读：应用重启后内存缓存已空，但结算时落过一份到
    // ai-artifacts/<父会话>/sub-<agentId>.txt（见 finalizeSubAgent），从那里还原过程记录。
    // 返回 [{role, name, text}]，与 subTranscriptPush 的条目同形；读不到/文件被清返回 null。
    async function loadAgentTranscriptFromDisk(parentSessionId, agentId) {
        if (!backend.AIArtifactRead || !parentSessionId || !agentId) return null;
        let text = '';
        try {
            text = await backend.AIArtifactRead(parentSessionId, 'sub-' + agentId);
        } catch (e) {
            return null;
        }
        const entries = parseTranscriptLines(text);
        return entries.length ? entries : null;
    }

    // ── 跨进程续跑（S6）──────────────────────────────────────────────────────
    //
    // 载入时把会话里的 agentRuns 快照重建成「可续」记录：session / profile / entry 三个
    // 活引用全部按 id 重新解析，转录来自快照。**不自动起轮**——用户可能并不想继续上次那件事，
    // 自动续跑会消耗 token 且可能重复执行上次未完成的写操作。状态一律记 interrupted，
    // 由用户/主代理显式触发 resumeAgentRun。
    function restoreAgentRuns(session) {
        if (!session || !session.id) return 0;
        const runs = normalizeAgentRuns(session.agentRuns);
        let restored = 0;
        for (const run of runs) {
            if (subAgentRecords.has(run.id) || subAgents.has(run.id)) continue;
            const plan = resumePlanOf(run);
            const detail = run.run;
            const profile = (typeof ctx.profileOf === 'function' && detail.profileId)
                ? ctx.profileOf(detail.profileId) : null;
            const entry = (profile && typeof ctx.entryOf === 'function')
                ? ctx.entryOf(profile, detail.modelId) : null;
            subAgentRecords.set(run.id, {
                id: run.id,
                key: run.key,
                toolCallId: run.toolCallId,
                name: run.name,
                task: run.task,
                maxRounds: run.maxRounds,
                depth: run.depth,
                mode: run.mode,
                sandboxMode: run.sandboxMode,
                preset: run.presetId || '',
                capabilities: run.capabilities || null,
                parentSessionId: run.parentSessionId,
                rootSessionId: run.rootSessionId,
                // 一律 interrupted：不假装还在跑，也不假装已完成。
                state: 'interrupted',
                summary: '',
                note: plan.ok ? '进程重启，可续跑' : ('进程重启，不可续跑：' + plan.reason),
                rounds: run.rounds,
                ms: 0,
                tokens: 0,
                startedAt: run.startedAt,
                finishedAt: 0,
                session: {
                    id: run.id,
                    title: '',
                    parentSessionId: run.parentSessionId,
                    rootSessionId: run.rootSessionId,
                    originSessionId: detail.originSessionId,
                    workspace: detail.workspace,
                    profileId: detail.profileId,
                    modelId: detail.modelId,
                    ctxLimit: detail.ctxLimit,
                    systemPrompt: detail.systemPrompt,
                    promptTemplateId: detail.promptTemplateId,
                    scope: detail.scope,
                    // 能力快照随 v2 快照恢复（全绝对路径，§8.2）；v1 旧快照为 null → 不可续跑
                    capabilities: run.capabilities || null,
                    planMode: false,
                    messages: detail.messages,
                    todos: [],
                    changes: [],
                    approvedPaths: [],
                    readRoots: [],
                    summary: null,
                    archived: [],
                    round: run.rounds,
                    worktree: detail.worktree || null,
                },
                profile: profile || null,
                entry: entry || null,
                baseRound: run.baseRound,
                continuable: plan.ok,
                resumeAvailable: plan.ok,
                resumeReason: plan.reason,
                restoredAt: Date.now(),
            });
            restored += 1;
        }
        if (restored) refreshHeadChips();
        return restored;
    }

    // 续跑一个重启后留下的子代理：复用冷唤醒（reviveSubAgent），它会重建 flow、
    // 把「继续」作为一条用户消息投进去并起轮。返回 {ok, error?} 供 UI 直接提示。
    function resumeAgentRun(agentId) {
        const record = subAgentRecords.get(aiTextOf(agentId));
        if (!record) return {ok: false, error: '找不到该子代理的运行记录'};
        if (subAgents.has(record.id)) return {ok: false, error: '该子代理正在运行'};
        // 注意：record 是「记录」形状（session/continuable），不是快照形状（run），
        // 所以不能拿 resumePlanOf(record) 判——那会永远报「缺少运行态」。可续性在载入
        // 重建记录时已经算过，存在 resumeAvailable / resumeReason 上。
        if (record.resumeAvailable !== true) {
            return {ok: false, error: record.resumeReason || '该记录不可续跑'};
        }
        const rounds = Number(record.rounds) || 0;
        const cap = Number(record.maxRounds) || 0;
        if (cap > 0 && rounds >= cap) {
            return {ok: false, error: '已用满轮次预算（' + rounds + '/' + cap + '）'};
        }
        if (!record.profile || !record.session) {
            return {ok: false, error: '缺少模型账号或转录，无法续跑（可能已被压缩或删除）'};
        }
        record.note = '';
        const sub = reviveSubAgent(record, '（进程重启后继续上次未完成的任务：先接手已有进展，不要重复已完成的部分）',
            {from: 'agent'});
        if (!sub) return {ok: false, error: '续跑失败：记录不可唤醒'};
        return {ok: true, agentId: sub.id};
    }

    return {
        subAgentLimit, subAgentMaxDepth, subAgentCanSpawn, subSystemPromptFor, subToolsForCapabilities, subReadScopeOf,
        activeSubCount, subTranscriptPush, subThrottleRender,
        sessionTitleOf, sessionTitleById, updateHeadIdentity,
        bgJobStateOf, rootSessionIdOf, hudSessionId, bgEntryOwnerId, isBgEntryOfHud, hudBgEntries,
        sessionHasLiveBgJob, runningBgCount, listAgentsForHud, setChipCount,
        notifyBackgroundActivity, refreshHeadChips, updateHeadHud,
        hideChipsPop, positionChipsPop, agentStateBadge, agentStatusIcon, bgJobFirstLine, taskSnippet,
        openBgTermInContent, renderChipsPop, toggleChipsPop,
        // 详情视图：openAgentView 由面板内部（chips 弹层）调用；mount/unmount 给内容区标签页用
        openAgentView, mountAgentView, unmountAgentView, renderAgentView,
        mountTeamView, unmountTeamView,
        parentSessionOfSub, runSubAgent, startSubAgent, runSubRound, handleSubEvent, finalizeSubAgent, stopSubAgentsOf, initHud,
        deliverBgExitNotice,
        pushSubAgentRecord, unseenInboxCount, dropSubAgentRecordsOf,
        restoreAgentRuns, resumeAgentRun, persistRun,
        consumeSubInbox, queueSubAgentMessage, steerSubAgent, stopSubAgent, subRunDigest,
        reviveSubAgent, sendToSubAgent, stopSubAgentByInput, handleAgentTool, answerSubAsk,
        runSubAskQuestion, settleSubAsk, waitForInbox,
        compactSubAgentByInput, maybeStartSubCompact, startSubCompact, handleSubCompactEvent,
        worktreeNamesForSession,
        subCompacts,
        subAgents, subAgentTranscripts, subAgentRecords,
        loadAgentTranscriptFromDisk,
        bgJobSnapshot, notifyBgListeners, bridgeStopBgJob,
        agentViewSnapshot, agentViewListeners, notifyAgentViewListeners,
    };
}
