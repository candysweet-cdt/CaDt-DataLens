// ai-group-runtime.js：群聊运行时——群状态、磁盘适配、加载/创建/删除、发言路径与流事件。
// G2 单发言路径：按成员模型窗口组装请求（§3.11/§7.1）→ AISendChat → 流事件 → 超时/停止 → 落盘。
// G3 在此接主持人循环；G1 的群状态 / 创建 / 删除 / 订阅保持不变。
// main.js 把 ai-* 事件转发到 handleEvent（payload.id === roundId 精确认领）；侧栏与
// 标签页视图经 subscribe 拿快照。
import {aiClampInt, aiEstimateTokens, aiNowId} from '../core/ai-constants.js';
import {friendlyRetryReason} from '../tools/ai-terminal-tools.js';
import {aiStreamRetryBudget, shouldAutoRetryStream} from '../chat/ai-stream-retry.js';
import {
    FREE_CHAT_CAPS,
    GROUP_LAST_PREVIEW_MAX,
    GROUP_MEMBER_MAX,
    GROUP_MEMBER_MIN,
    GROUP_OUTPUT_RESERVE_TOKENS,
    GROUP_UNLIMITED_ROUNDS_SPEECHES,
    RELAY_CAPS,
    TIMEOUT_PRESETS,
    applyStatePatch,
    buildChairMessages,
    buildMemberMessages,
    chairTimeouts,
    deriveMaxSpeeches,
    fallbackPlan,
    foldPrivateSteps,
    hasHandoffMarker,
    isUnlimitedRounds,
    maxRoundsOf,
    mergeGroupBlock,
    memberTimeouts,
    minutesFromBoard,
    normalizeChair,
    normalizeGroupMeta,
    normalizeGroupMode,
    parseChairContract,
    parseGroupBlock,
    parseMentions,
    relayAskTargets,
    relayStageFocus,
    relayWakes,
    sanitizeChairPlan,
    stripGroupBlock,
    stripHandoffMarker,
} from './ai-group-model.js';
import {
    MEMBER_TOOL_GID_PREFIX,
    MEMBER_TOOL_ROUNDS_MAX,
    assistantToolCallsApiMessage,
    memberToolDefs,
    memberToolsNote,
    toolArgsSummary,
    toolResultApiMessage,
} from './ai-group-tools.js';
import {inspectToolArguments} from '../tools/ai-tool-args.js';
import {createGroupStoreAdapter, encodeGroupEvent, encodeGroupMessage, groupHeaderLine, parsePrivateSteps, replayGroupLog} from './ai-group-store.js';

export function createAIGroupRuntime(deps) {
    const backend = deps.backend;
    const store = createGroupStoreAdapter(backend);
    const getAIConfig = typeof deps.getAIConfig === 'function' ? deps.getAIConfig : (() => null);
    const resolveModel = typeof deps.resolveModel === 'function' ? deps.resolveModel : (() => null);
    const flash = deps.flash || (() => {});
    const notifyFailure = typeof deps.notifyFailure === 'function' ? deps.notifyFailure : () => {};
    // G6 面板化：openGroupView 由 main 注入，把 AI 面板切到群聊视图（不再开内容区标签页）
    const openGroupView = typeof deps.openGroupView === 'function' ? deps.openGroupView : null;
    // G5 落地：群成员只读工具执行体（main 注入 → aiPanel.aiGroupApi.execMemberTool；
    // 路径边界在面板侧钳到群工作区）。缺依赖时成员请求不下发工具，行为回到纯对话。
    const execMemberTool = typeof deps.execMemberTool === 'function' ? deps.execMemberTool : null;
    const getWorkspace = deps.getWorkspace || (() => '');
    // G4：纪要带回会话（走面板信箱 deliverToSessions；会话 id 由宿主提供）
    const deliverToSessions = typeof deps.deliverToSessions === 'function' ? deps.deliverToSessions : null;
    const getCurrentSessionId = typeof deps.getCurrentSessionId === 'function' ? deps.getCurrentSessionId : (() => '');

    // groupId → {meta, messages, events, loaded}
    const groups = new Map();
    // roundId → 流记录（发言中）；结束后移除
    const streams = new Map();
    const groupSeq = new Map();
    // 自由聊天（QQ/微信群式）：groupId → {pending:[用户消息], running, abort}；无 @ 时的轮换接话人游标
    const chatQueues = new Map();
    const chatCursors = new Map();
    let listMode = 'sessions';
    let initPromise = null;
    const listeners = new Set();

    function subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    function notify() {
        const snap = snapshot();
        for (const fn of listeners) {
            try {
                fn(snap);
            } catch (e) {
                console.error('群聊订阅回调失败', e);
            }
        }
    }

    function snapshot() {
        return {listMode, groups: groupList()};
    }

    function groupList() {
        return [...groups.values()].map((g) => g.meta).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }

    async function refreshList() {
        const metas = await store.list();
        const seen = new Set();
        for (const raw of metas || []) {
            let meta = null;
            try {
                meta = normalizeGroupMeta(JSON.parse(raw));
            } catch (e) {
                continue; // 坏 meta 跳过（正文 header 兜底由 Go 侧 synthesize 完成）
            }
            if (!meta.id) continue;
            seen.add(meta.id);
            const existing = groups.get(meta.id);
            if (existing) {
                existing.meta = {...existing.meta, ...meta, updatedAt: Math.max(existing.meta.updatedAt || 0, meta.updatedAt || 0)};
            } else {
                groups.set(meta.id, {meta, messages: [], events: [], loaded: false});
            }
        }
        for (const id of [...groups.keys()]) {
            if (!seen.has(id)) groups.delete(id);
        }
        notify();
    }

    function init() {
        if (initPromise) return initPromise;
        initPromise = refreshList().catch((e) => {
            const detail = String((e && e.message) || e);
            flash('群聊列表加载失败：' + detail, true);
            notifyFailure('群聊列表加载失败', detail, {key: 'group-list-load', kind: 'error', toast: false});
        });
        return initPromise;
    }

    function setListMode(mode) {
        if (mode !== 'sessions' && mode !== 'groups') return;
        if (listMode === mode) return;
        listMode = mode;
        notify();
    }

    async function ensureLoaded(id) {
        const g = groups.get(id);
        if (!g || g.loaded) return g;
        const text = await store.read(id);
        const replay = replayGroupLog(text);
        g.messages = replay.messages;
        g.events = replay.events;
        g.loaded = true;
        return g;
    }

    async function openGroup(id) {
        const g = groups.get(id);
        if (!g) return null;
        try {
            await ensureLoaded(id);
        } catch (e) {
            const detail = String((e && e.message) || e);
            flash('群聊记录读取失败：' + detail, true);
            notifyFailure('群聊记录读取失败', detail, {key: 'group-read', kind: 'error', toast: false});
            return null;
        }
        if (openGroupView) openGroupView({groupId: id, title: g.meta.title});
        return g;
    }

    function agentsOf(config) {
        return (config && Array.isArray(config.agents)) ? config.agents : [];
    }

    // ---------- 创建 / 删除 / meta ----------

    async function createGroup(spec) {
        const source = spec && typeof spec === 'object' ? spec : {};
        const config = getAIConfig();
        const agents = agentsOf(config);
        const memberIds = (Array.isArray(source.memberIds) ? source.memberIds : [])
            .filter((id) => agents.some((agent) => agent && agent.id === id && agent.enabled));
        if (memberIds.length < GROUP_MEMBER_MIN) {
            return {ok: false, error: '至少选择 ' + GROUP_MEMBER_MIN + ' 位可用成员'};
        }
        if (memberIds.length > GROUP_MEMBER_MAX) {
            return {ok: false, error: '最多 ' + GROUP_MEMBER_MAX + ' 位成员'};
        }
        const chairSpec = {...(source.chair && typeof source.chair === 'object' ? source.chair : {})};
        if (chairSpec.kind === 'ai') {
            const chairAgent = agents.find((agent) => agent && agent.id === chairSpec.agentId);
            if (!chairAgent) return {ok: false, error: '主持人智能体不可用，请重新选择'};
            chairSpec.modelRef = chairAgent.modelRef;
        } else if (chairSpec.kind === 'member') {
            if (!memberIds.includes(chairSpec.agentId)) return {ok: false, error: '兼任主持人必须是群成员'};
            chairSpec.modelRef = '';
        } else {
            chairSpec.kind = 'user';
            chairSpec.agentId = '';
            chairSpec.modelRef = '';
        }
        const preset = source.timeoutPreset === 'lenient' ? TIMEOUT_PRESETS.lenient : TIMEOUT_PRESETS.standard;
        const id = aiNowId('group-');
        const meta = normalizeGroupMeta({
            id,
            title: source.title || '未命名群聊',
            topic: source.topic || '',
            goal: source.goal,
            memberIds,
            mode: normalizeGroupMode(source.mode),
            chair: normalizeChair(chairSpec),
            maxRounds: source.maxRounds,
            // 未显式给 maxSpeeches 时按「成员数 × 轮数」推导（G6），不再落回固定 12
            maxSpeeches: Number.isFinite(Number(source.maxSpeeches)) && Number(source.maxSpeeches) > 0
                ? Number(source.maxSpeeches)
                : deriveMaxSpeeches(memberIds.length, source.maxRounds),
            roundMode: 'sequential',
            timeouts: preset.timeouts,
            roles: source.roles || {},
            workspace: getWorkspace() || '',
        });
        meta.updatedAt = Date.now();
        try {
            // 先落 header 再写 meta：sessionstore 的 WriteMeta 不再创建目录（防已删除会话复活），
            // 目录由 Append 的 allowCreate 语义建立。
            await store.append(id, groupHeaderLine(meta) + '\n');
            await store.writeMeta(id, JSON.stringify(meta));
        } catch (e) {
            return {ok: false, error: '群聊创建失败：' + ((e && e.message) || e)};
        }
        groups.set(id, {meta, messages: [], events: [], loaded: true});
        notify();
        if (openGroupView) openGroupView({groupId: id, title: meta.title});
        return {ok: true, id};
    }

    async function deleteGroup(id) {
        // 先收尾在飞请求与讨论/接力循环：删掉 map 之后，运行中的循环仍持有局部引用
        //（`const g = groups.get(...)`），会继续烧模型额度；relays.delete 还会让它们
        // 彻底失联，之后想停也取不到。
        stopAll(id);
        try {
            await store.remove(id);
        } catch (e) {
            const detail = String((e && e.message) || e);
            flash('删除群聊失败：' + detail, true);
            notifyFailure('删除群聊失败', detail, {key: 'group-delete', kind: 'error', toast: false});
            return {ok: false};
        }
        groups.delete(id);
        chatQueues.delete(id);
        chatCursors.delete(id);
        relays.delete(id);
        notify();
        return {ok: true};
    }

    async function saveMeta(id, mutator) {
        const g = groups.get(id);
        if (!g) return;
        if (typeof mutator === 'function') mutator(g.meta);
        g.meta.updatedAt = Date.now();
        try {
            await store.writeMeta(id, JSON.stringify(g.meta));
        } catch (e) {
            const detail = String((e && e.message) || e);
            flash('群聊状态保存失败：' + detail, true);
            notifyFailure('群聊状态保存失败', detail, {key: 'group-meta-save', kind: 'error', toast: false});
        }
        notify();
    }

    // ---------- 发言路径（G2，§7.1 / §3.11 / §3.12） ----------

    function currentRound(meta) {
        return Math.max(1, (meta && meta.discussion && meta.discussion.round) || 1);
    }

    // 消息 round 的统一口径：接力群 = 当前棒次（1 基，回答/总结都归入触发它们的棒）；
    // 其他模式沿用讨论轮次。relays 常量声明在文件后部，调用发生在工厂装配完成后（无 TDZ 问题）。
    function relayRoundOf(groupId, meta) {
        if (meta && meta.mode === 'relay') {
            const r = relays.get(groupId);
            if (r && r.chain.length) return Math.min(r.stage + 1, r.chain.length);
        }
        return currentRound(meta);
    }

    // 侧栏列表的「最近一条」预览（G6）：落盘消息时随 meta 写 lastPreview，重启后仍有预览
    function previewOfMessage(msg) {
        if (!msg) return '';
        const who = msg.kind === 'minutes'
            ? '纪要'
            : (msg.role === 'user' ? '你' : (msg.chair ? '主持人' : (msg.agentName || '成员')));
        const text = String(msg.content || '').replace(/\s+/g, ' ').trim();
        if (!text) return '';
        return (who + '：' + text).slice(0, GROUP_LAST_PREVIEW_MAX);
    }

    function participantsText(meta, agents, self) {
        const lines = ['用户：提出议题、随时插话、点名成员。'];
        for (const id of (meta && meta.memberIds) || []) {
            if (self && id === self.id) continue;
            const agent = agents.find((item) => item && item.id === id);
            lines.push(`- ${agent ? agent.name : '已删除成员'}${agent && agent.role ? '：' + agent.role : ''}`);
        }
        return lines.join('\n');
    }

    // 私有日志解析已下沉 ai-group-store.js（parsePrivateSteps）：成员详情视图共用同一实现。

    async function appendSystemEvent(groupId, evt) {
        const g = groups.get(groupId);
        if (!g) return;
        try {
            await store.append(groupId, encodeGroupEvent({...evt, ts: Date.now()}) + '\n');
        } catch (e) {
            console.error('群聊系统事件落盘失败', e);
        }
        g.events.push({...evt, ts: Date.now()});
    }

    function activeStreamOf(groupId) {
        for (const stream of streams.values()) {
            if (stream.groupId === groupId) return stream;
        }
        return null;
    }

    function clearTimers(stream) {
        if (stream.timers.first) {
            clearTimeout(stream.timers.first);
            stream.timers.first = null;
        }
        if (stream.timers.total) {
            clearTimeout(stream.timers.total);
            stream.timers.total = null;
        }
    }

    function fireTimeout(stream, which) {
        if (stream.finished) return;
        stream.timedOutBy = which;
        stream.timeout = true;
        stream.statusNote = which === 'first' ? '超时未发言' : '发言超时，已停止';
        try {
            backend.AIStop(stream.roundId);
        } catch (e) {
            console.error('AIStop 失败', e);
        }
        notify();
    }

    // 指定成员发言一次（G2 手动路径 / G3 主持人循环的执行单元）。
    // opts.focus：主持人/用户给本条发言的焦点（<chair_focus>）。
    async function speak(groupId, agentId, opts = {}) {
        const g = groups.get(groupId);
        if (!g) return {ok: false, error: '群聊不存在'};
        if (activeStreamOf(groupId)) return {ok: false, error: '已有成员正在发言（串行轮）'};
        const config = getAIConfig();
        const agents = agentsOf(config);
        const agent = agents.find((item) => item && item.id === agentId);
        if (!agent || !agent.enabled) return {ok: false, error: '成员不可用或已停用'};
        if ((g.meta.mutedAgentIds || []).includes(agentId)) return {ok: false, error: '该成员已被静音'};
        const resolved = resolveModel(agent.modelRef);
        if (!resolved || !resolved.profileCfg) return {ok: false, error: `${agent.name} 的模型不可用（账号或模型已删除）`};
        try {
            await ensureLoaded(groupId);
        } catch (e) {
            return {ok: false, error: '群聊记录读取失败：' + ((e && e.message) || e)};
        }
        const timeouts = memberTimeouts(g.meta, agent, config.profiles);
        const focus = String((opts && opts.focus) || '').trim();
        // 私有过程加载 + 确定性折叠（§3.11：只压自己的私有过程，共享对话不压缩）
        let ownSteps = [];
        try {
            ownSteps = parsePrivateSteps(await store.privateRead(groupId, agentId));
        } catch (e) {
            console.error('私有日志读取失败', e);
        }
        const window = resolved.entry && resolved.entry.contextWindow || g.meta.context.preferredWindow || 262144;
        const privateBudget = Math.max(1024, Math.round(window * 0.12));
        const folded = foldPrivateSteps(ownSteps, privateBudget);
        const built = buildMemberMessages({
            member: agent,
            group: g.meta,
            sharedMessages: g.messages,
            ownSteps: folded.steps,
            participantsText: participantsText(g.meta, agents, agent),
            boardText: '',
            focus,
            outputLanguage: (config && config.outputLanguage) || 'zh',
            memberWindow: window,
        });
        // 上下文门禁（§3.11）：共享对话装不下 → 该成员本轮停止参与，其他成员继续
        if (built.overflow) {
            await appendSystemEvent(groupId, {
                type: 'context-overflow',
                agentId,
                text: `${agent.name} 的上下文装不下全部群聊对话（估算 ${built.estimateTokens} > 预算 ${built.budget}），本轮停止参与；可压缩群聊数据或换更大窗口模型`,
            });
            return {ok: false, error: `${agent.name} 的上下文不足，已跳过（可压缩群聊数据或换更大窗口模型）`};
        }

        const seq = (groupSeq.get(groupId) || 0) + 1;
        groupSeq.set(groupId, seq);
        const roundId = groupId + '#' + agentId + '-' + seq;
        // G5 只读工具：非主持人 + 群绑定了工作区 + 执行体可用时下发（主持人契约是
        // 严格 JSON 调度，不掺工具轮）；系统提示词追加 <member_tools> 说明段
        const toolsEnabled = !!execMemberTool && !!g.meta.workspace;
        const memberTools = toolsEnabled ? memberToolDefs() : [];
        if (toolsEnabled) {
            built.messages.splice(1, 0, {role: 'system', content: memberToolsNote()});
        }
        const stream = {
            roundId,
            groupId,
            agentId,
            agentName: agent.name,
            agentColor: agent.color,
            // 使用统计的「供应商」列显示账号名（agentName 是群成员昵称，不是账号）
            modelAccount: (resolved.account && resolved.account.name) || '',
            modelName: resolved.label || (resolved.entry && resolved.entry.model) || '',
            content: '',
            thinking: '',
            startedAt: Date.now(),
            firstActivityAt: 0,
            firstTokenMs: 0,
            statusCode: 0,
            finished: false,
            timeout: false,
            timedOutBy: '',
            statusNote: '',
            error: '',
            chair: false,
            groupBlock: null,
            contract: null,
            timers: {first: null, total: null},
            // 工具轮（G5）：apiMessages 在请求间续接（assistant(tool_calls)+tool 结果），
            // toolCalls 按事件 index 聚合，usage 跨轮累计
            profileCfg: resolved.profileCfg,
            retryMax: aiClampInt(config && config.retryMax, 0, 10, 5),
            apiMessages: built.messages,
            tools: memberTools,
            toolCalls: new Map(),
            toolRounds: 0,
            toolSteps: [],
            usageAcc: null,
            usageFields: null,
        };
        stream.done = new Promise((resolve) => {
            stream.resolve = resolve;
        });
        streams.set(roundId, stream);
        stream.timers.first = setTimeout(() => fireTimeout(stream, 'first'), timeouts.firstActivityMs);
        stream.timers.total = setTimeout(() => fireTimeout(stream, 'total'), timeouts.totalMs);
        notify();
        try {
            const sendResult = backend.AISendChat(roundId, resolved.profileCfg, built.messages, stream.tools, stream.retryMax);
            Promise.resolve(sendResult).catch((e) => failStream(stream, (e && e.message) || String(e)));
        } catch (e) {
            failStream(stream, (e && e.message) || String(e));
            return {ok: false, error: '发送失败：' + ((e && e.message) || e)};
        }
        return {ok: true, roundId, done: stream.done};
    }

    // ---------- 成员工具轮（G5）：ai-done finishReason='tool' → 执行 → 同 roundId 续发 ----------

    // ai-toolcall 事件按 index 聚合（与子代理 handleSubEvent 同款语义）
    function collectToolCalls(stream, payload) {
        const argErrors = new Map();
        const calls = [...stream.toolCalls.values()]
            .filter((call) => call.name)
            .map((call, index) => {
                const check = inspectToolArguments(call.arguments);
                const id = call.id || ('call_gm_' + stream.toolRounds + '_' + index);
                if (!check.valid && !check.repaired) {
                    argErrors.set(id, check.text);
                }
                return {id, name: call.name, arguments: check.text};
            });
        stream.toolCalls.clear();
        return {calls, argErrors};
    }

    async function runMemberToolRound(stream, calls, argErrors) {
        const g = groups.get(stream.groupId);
        const workspace = g ? g.meta.workspace : '';
        stream.toolRounds += 1;
        stream.statusNote = '正在读取工作区文件…';
        // assistant(tool_calls) 必须与 tool 结果一一配对，否则下一轮请求被服务商拒收
        stream.apiMessages.push(assistantToolCallsApiMessage(stream.content, calls));
        for (const call of calls) {
            if (stream.finished || stream.toolAbort) break;
            let result = '';
            const invalidArgs = argErrors && argErrors.get(call.id);
            if (invalidArgs) {
                result = invalidArgs;
            } else if (!stream.tools.length) {
                result = '工具轮次已用尽（单次发言最多 ' + MEMBER_TOOL_ROUNDS_MAX + ' 轮）：请基于已获取的信息直接完成这次发言，不要再调用工具。';
            } else {
                try {
                    result = await execMemberTool(call.name, call.arguments, workspace);
                } catch (e) {
                    result = '工具执行失败：' + ((e && e.message) || e);
                }
            }
            stream.apiMessages.push(toolResultApiMessage(call, result));
            stream.toolSteps.push({
                kind: 'tool',
                name: call.name,
                text: toolArgsSummary(call.name, call.arguments) + ' → ' + String(result || '').slice(0, 160).replace(/\s+/g, ' '),
                ok: !/^(工具执行失败|工具参数|路径超出|工具轮次已用尽|工具 )/.test(String(result || '')),
            });
        }
        // 工具步骤即时写私有日志（gid=tools:<roundId>，与最终发言 turnId 对齐）：
        // 即使后续轮失败 / 超时，读取过程也不丢（§3.13 私有数据归成员自己）
        if (stream.toolSteps.length && !stream.noPrivate) {
            try {
                await store.privateAppend(stream.groupId, stream.agentId, JSON.stringify({
                    gid: MEMBER_TOOL_GID_PREFIX + stream.roundId,
                    agentId: stream.agentId,
                    steps: stream.toolSteps.slice(),
                    ts: Date.now(),
                }) + '\n');
            } catch (e) {
                console.error('群成员工具步骤落盘失败', e);
            }
        }
        if (stream.finished) return;
        if (stream.toolAbort) {
            finishStream(stream, {status: 'stopped'});
            return;
        }
        // 到达轮次上限：本轮起不再下发工具，并给一句收敛提示（防止「拒绝 → 再要」循环）
        if (stream.toolRounds >= MEMBER_TOOL_ROUNDS_MAX) {
            stream.tools = [];
            stream.apiMessages.push({role: 'user', content: '（工具调用轮次已用尽：请基于已获取的信息直接完成这次发言，不要再看文件。）'});
        }
        sendMemberFollowUp(stream);
    }

    function sendMemberFollowUp(stream) {
        if (stream.finished) return;
        // 每个请求独立计时：重挂总时长看门狗（首字看门狗已在 touch 后解除）
        if (stream.timers.total) clearTimeout(stream.timers.total);
        const g = groups.get(stream.groupId);
        const timeouts = g ? memberTimeouts(g.meta, {slowTier: false}, null) : null;
        stream.timers.total = setTimeout(() => fireTimeout(stream, 'total'), timeouts ? timeouts.totalMs : 180000);
        stream.statusNote = '';
        stream.content = '';
        notify();
        try {
            const sendResult = backend.AISendChat(stream.roundId, stream.profileCfg, stream.apiMessages, stream.tools, stream.retryMax);
            Promise.resolve(sendResult).catch((e) => failStream(stream, (e && e.message) || String(e)));
        } catch (e) {
            failStream(stream, (e && e.message) || String(e));
        }
    }

    function touch(stream) {
        if (!stream.firstActivityAt) {
            stream.firstActivityAt = Date.now();
            // 使用统计的首字延迟：整段发言只记第一次（重试/工具轮不重置）
            if (!stream.firstTokenMs) stream.firstTokenMs = Math.max(0, stream.firstActivityAt - (Number(stream.startedAt) || stream.firstActivityAt));
            if (stream.timers.first) {
                clearTimeout(stream.timers.first);
                stream.timers.first = null;
            }
        }
    }

    // 群聊成员 / 主持人的 token 用量也计入使用统计（与主会话同一事实表）。
    // 幂等键用消息 gid：落盘扫描与实时上报都认它，不会重复计数。
    function reportStreamUsage(stream, gid, finishedAt, usage) {
        if (!usage || !stream || !stream.groupId) return;
        const api = backend && backend.AIUsageStatsRecord;
        if (typeof api !== 'function') return;
        let payload = '';
        try {
            payload = JSON.stringify({
                sessionId: 'group:' + stream.groupId,
                messageId: gid,
                ts: finishedAt,
                model: stream.modelName || '',
                modelAccount: stream.modelAccount || stream.agentName || '',
                turnMs: Math.max(0, finishedAt - (Number(stream.startedAt) || finishedAt)),
                modelMs: Math.max(0, finishedAt - (Number(stream.startedAt) || finishedAt)),
                ttftMs: Number(stream.firstTokenMs) || 0,
                statusCode: Number(stream.statusCode) || 0,
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
            // 统计上报是尽力而为：失败不影响群聊
        }
    }

    async function persistSpeech(stream, info) {
        const g = groups.get(stream.groupId);
        if (!g) return;
        const gid = aiNowId('gm-');
        const finishedAt = Date.now();
        reportStreamUsage(stream, gid, finishedAt, info && info.usage);
        const msg = {
            gid,
            role: 'assistant',
            agentId: stream.agentId,
            agentName: stream.agentName,
            agentColor: stream.agentColor,
            model: stream.modelName,
            modelAccount: stream.modelAccount || '',
            statusCode: Number(stream.statusCode) || 0,
            content: stream.content,
            ts: finishedAt,
            turnId: stream.roundId,
            round: relayRoundOf(stream.groupId, g.meta),
            replyTo: '',
            addressedTo: [],
            stance: (stream.groupBlock && stream.groupBlock.stance) || '',
            groupBlock: stream.groupBlock || null,
            usage: info.usage || null,
            hasPrivate: !!(stream.thinking || (stream.toolSteps && stream.toolSteps.length)) && !stream.noPrivate,
            timing: {
                startedAt: stream.startedAt,
                firstActivityAt: stream.firstActivityAt,
                finishedAt,
                ttftMs: stream.firstActivityAt ? stream.firstActivityAt - stream.startedAt : 0,
                totalMs: finishedAt - stream.startedAt,
            },
            timeout: stream.timeout,
            status: info.status,
            error: info.error || '',
            chair: stream.chair === true,
        };
        try {
            await store.append(stream.groupId, encodeGroupMessage(msg) + '\n');
            g.messages.push(msg);
            // 私有步骤（§3.13）：思考链随最终发言落盘；工具调用摘要已在工具轮即时落过
            // （gid=tools:<roundId>，与这条发言的 turnId 对齐），这里不重复写
            if (stream.thinking && !stream.noPrivate) {
                const step = {
                    gid,
                    agentId: stream.agentId,
                    steps: [{kind: 'thinking', text: stream.thinking, signature: info.thinkingSignature || ''}],
                    ts: finishedAt,
                };
                await store.privateAppend(stream.groupId, stream.agentId, JSON.stringify(step) + '\n');
            }
            await saveMeta(stream.groupId, (meta) => {
                meta.messageCount = (meta.messageCount || 0) + 1;
                meta.lastMessageId = gid;
                meta.lastPreview = previewOfMessage(msg);
            });
        } catch (e) {
            const detail = String((e && e.message) || e);
            flash('群聊消息落盘失败：' + detail, true);
            // A 级：群聊消息没写进磁盘会丢历史，需用户回来处理（节流防连续发言刷屏）。
            notifyFailure('群聊消息落盘失败', detail, {key: 'group-msg-save', kind: 'error'});
        }
        if (info.status === 'timeout') {
            await appendSystemEvent(stream.groupId, {
                type: 'speech-timeout',
                agentId: stream.agentId,
                text: `${stream.agentName} 超时未完成发言（${stream.timedOutBy === 'first' ? '等待期内无输出' : '总时长超限'}），已跳过；下一轮可再请`,
            });
        }
    }

    async function finishStream(stream, payload) {
        if (stream.finished) return;
        stream.finished = true;
        clearTimers(stream);
        if (stream.toolCalls) stream.toolCalls.clear(); // 成员流才有工具聚合；chair/compress 流无此字段
        // 主持人流：先解析契约——chairMessage 进正文、原文不落盘（§3.6）；解析失败按错误归档
        if (stream.chair) {
            const contract = parseChairContract(stream.content);
            stream.contract = contract;
            if (!contract) {
                stream.error = '主持人输出无法解析为调度 JSON';
            } else {
                stream.content = contract.chairMessage || '';
            }
        } else {
            // 成员流：剥离 ```group 围栏，结构化块进 groupBlock（§3.5）
            stream.groupBlock = parseGroupBlock(stream.content);
            if (stream.groupBlock) stream.content = stripGroupBlock(stream.content);
        }
        const stopped = payload && payload.finishReason === 'stopped';
        const status = stream.timeout ? 'timeout' : (stopped ? 'stopped' : (stream.error ? 'error' : 'done'));
        await persistSpeech(stream, {
            status,
            usage: (payload && payload.usage) || null,
            thinkingSignature: (payload && payload.thinkingSignature) || '',
            error: stream.error,
        });
        streams.delete(stream.roundId);
        notify();
        if (stream.resolve) {
            stream.resolve({
                status,
                content: stream.content,
                contract: stream.contract,
                usage: (payload && payload.usage) || null,
                error: stream.error,
            });
        }
    }

    async function failStream(stream, message) {
        if (stream.finished) return;
        stream.finished = true;
        clearTimers(stream);
        stream.error = message;
        // 失败流没有可展示的成功状态码；不要把上一个工具轮的 200 带进请求日志
        stream.statusCode = 0;
        const status = stream.timeout ? 'timeout' : 'error';
        const acc = stream.usageFields;
        await persistSpeech(stream, {status, error: message, usage: acc && acc.totalTokens > 0 ? {...acc} : null});
        streams.delete(stream.roundId);
        notify();
        if (stream.resolve) {
            stream.resolve({status, content: stream.content, contract: null, usage: null, error: message});
        }
    }

    // ai-* 流事件入口（main.js 转发）：按 payload.id 精确认领本运行时发起的请求；
    // 不属于群 roundId 命名空间的事件静默忽略（主面板有自己的路由）。
    function handleEvent(name, payload) {
        const stream = streams.get(String((payload && payload.id) || ''));
        if (!stream) return;
        if (name === 'ai-chunk') {
            stream.content += String((payload && payload.delta) || '');
            touch(stream);
        } else if (name === 'ai-think') {
            stream.thinking += String((payload && payload.delta) || '');
            touch(stream);
        } else if (name === 'ai-retry') {
            // reason 是「HTTP 429」这类协议描述，进气泡状态前先翻译成人话
            stream.statusNote = `重试 ${payload.attempt}/${payload.max}：${friendlyRetryReason(payload.reason)}`;
        } else if (name === 'ai-queue') {
            // 冻结（服务端 429 配额）与本地窗口排队要分开说，后者几十秒、前者可能几小时
            if (!payload || !payload.waitMs) stream.statusNote = '';
            else if (payload.kind === 'frozen') stream.statusNote = '服务商配额已用尽，等待恢复…';
            else stream.statusNote = '排队等待限流…';
        } else if (name === 'ai-param-adjust') {
            stream.statusNote = payload.message || '参数已自动调整';
        } else if (name === 'ai-toolcall') {
            if (!stream.toolCalls) return notify(); // chair/compress 流没有工具聚合，忽略
            // 成员工具轮（G5）：按 index 聚合调用（与子代理 handleSubEvent 同款语义）
            const index = Number((payload && payload.index) || 0);
            let call = stream.toolCalls.get(index);
            if (!call) {
                call = {id: '', name: '', arguments: ''};
                stream.toolCalls.set(index, call);
            }
            if (payload && payload.callId) call.id = payload.callId;
            if (payload && payload.name) call.name = payload.name;
            if (payload && payload.argsDelta) call.arguments += payload.argsDelta;
            touch(stream);
        } else if (name === 'ai-done') {
            stream.statusCode = Number((payload && payload.statusCode) || 0) || 0;
            if (!stream.toolCalls) { finishStream(stream, payload); return notify(); } // chair/compress 流无工具逻辑
            // usage 跨工具轮累计：total 用于展示，输入/输出/缓存各字段也一起累计
            if (payload && payload.usage) {
                const usage = payload.usage;
                const acc = stream.usageFields
                    || (stream.usageFields = {promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 0});
                acc.promptTokens += Number(usage.promptTokens) || 0;
                acc.completionTokens += Number(usage.completionTokens) || 0;
                acc.cachedTokens += Number(usage.cachedTokens) || 0;
                acc.cacheWriteTokens += Number(usage.cacheWriteTokens) || 0;
                acc.totalTokens += Number(usage.totalTokens)
                    || ((Number(usage.promptTokens) || 0) + (Number(usage.completionTokens) || 0));
                stream.usageAcc = acc.totalTokens;
            }
            const wantsTools = !!(payload && payload.finishReason === 'tool');
            const collected = collectToolCalls(stream, payload);
            if (!stream.chair && wantsTools && collected.calls.length && execMemberTool && !stream.toolAbort) {
                // 成员工具轮：执行只读工具后同 roundId 续发（done 在最后一轮才 resolve）；
                // 异步兜底：循环内抛错按错误归档，不让 done 悬挂
                Promise.resolve(runMemberToolRound(stream, collected.calls, collected.argErrors))
                    .catch((e) => failStream(stream, '工具轮执行失败：' + ((e && e.message) || e)));
            } else if (wantsTools && collected.calls.length) {
                // 主持人 / 无执行体 / 已停止：工具调用一律拒绝并按错误归档，防无限循环
                failStream(stream, '成员发言不支持工具调用（本轮返回了 ' + collected.calls.length + ' 个工具调用）');
            } else {
                if (stream.usageFields && payload) {
                    payload.usage = {...((payload && payload.usage) || {}), ...stream.usageFields};
                }
                finishStream(stream, payload);
            }
        } else if (name === 'ai-error') {
            // 流中途被掐断 / 流内网关 5xx（retryable）先走自动重试，失败再归档错误
            if (!retryGroupSpeechStream(stream, payload)) {
                failStream(stream, (payload && payload.message) || '请求失败');
            }
        }
        notify();
    }
    // 流中途被网关掐断 / 流内网关 5xx（ai-error.retryable）的自动重试：与主会话
    // retryTruncatedRound 同语义——清掉本轮半截内容后按原 roundId 续发（Go 侧出错
    // 后已释放流注册表条目，同 id 可复用）。成员工具轮中间失败时 apiMessages 已含
    // 此前轮的 assistant(tool_calls)+tool 配对，本轮半截作废后原样续发，不会重放
    // 已执行的工具。预算见 ai-stream-retry.js（retryMax=0 视为关闭）。只有携带
    // 重发上下文（profileCfg/apiMessages）的流可重试；成员/主持人/摘要器三类流
    // 都在创建时存好了这些字段。
    function retryGroupSpeechStream(stream, payload) {
        if (!stream || stream.finished || stream.timeout || stream.error) return false;
        if (!stream.profileCfg || !stream.apiMessages) return false;
        const budget = aiStreamRetryBudget(stream.retryMax);
        if (!shouldAutoRetryStream({retryable: !!(payload && payload.retryable), retried: stream.streamRetried, budget})) return false;
        stream.streamRetried = (stream.streamRetried || 0) + 1;
        stream.content = '';
        stream.thinking = '';
        stream.firstActivityAt = 0;
        if (stream.toolCalls) stream.toolCalls.clear();
        // 已完成的工具轮 token 不因重试作废；重试轮继续累加到同一份合计
        stream.statusNote = '流式连接被中断，正在自动重试…';
        try {
            const sendResult = backend.AISendChat(stream.roundId, stream.profileCfg, stream.apiMessages, stream.tools, stream.retryMax);
            Promise.resolve(sendResult).catch((e) => failStream(stream, (e && e.message) || String(e)));
        } catch (e) {
            failStream(stream, (e && e.message) || String(e));
            return false;
        }
        return true;
    }

    // ---------- 用户消息与停止 ----------

    async function sendUserMessage(groupId, text) {
        const g = groups.get(groupId);
        if (!g) return {ok: false, error: '群聊不存在'};
        const content = String(text || '').trim();
        if (!content) return {ok: false, error: '消息为空'};
        try {
            await ensureLoaded(groupId);
        } catch (e) {
            return {ok: false, error: '群聊记录读取失败：' + ((e && e.message) || e)};
        }
        const gid = aiNowId('gm-');
        const msg = {
            gid,
            role: 'user',
            agentId: '',
            agentName: '',
            agentColor: '',
            model: '',
            content,
            ts: Date.now(),
            turnId: '',
            round: relayRoundOf(groupId, g.meta),
            replyTo: '',
            addressedTo: [],
            stance: '',
            groupBlock: null,
            usage: null,
            hasPrivate: false,
            timing: null,
            timeout: false,
            status: 'done',
            error: '',
        };
        try {
            await store.append(groupId, encodeGroupMessage(msg) + '\n');
        } catch (e) {
            return {ok: false, error: '消息落盘失败：' + ((e && e.message) || e)};
        }
        g.messages.push(msg);
        await saveMeta(groupId, (meta) => {
            meta.messageCount = (meta.messageCount || 0) + 1;
            meta.lastMessageId = gid;
            meta.lastPreview = previewOfMessage(msg);
        });
        const d = discussionOf(groupId);
        if (g.meta.mode === 'relay') {
            // 接力（G7）：运行中/暂停 → 插话进 pendingUser（下一棒开跑前提醒）；
            // 空闲 → 需求即开工，自动从第 1 棒开始
            const r = relayOf(groupId);
            if (r.running || r.paused) {
                if (r.pendingUser.length < 5) r.pendingUser.push(content);
            } else {
                const started = startRelay(groupId, {fresh: true});
                if (!started.ok) flash(started.error || '接力启动失败', true);
            }
        } else if (d.running || d.paused) {
            // 讨论进行中（§3.9）：@A / @全体成员 → 强制进下一次调度，消息由主持人吸收
            noteMentions(groupId, content);
        } else {
            // 闲时（QQ/微信群式）：消息即唤醒——@点名谁谁回，无 @ 轮换一位成员接话；
            // 自由模式成员输出里的 @ 继续接力（受 §12 上限约束）。不 await：发送立即返回。
            runChatDispatch(groupId, msg).catch((e) => {
                const detail = String((e && e.message) || e);
                flash('群聊消息调度失败：' + detail, true);
                notifyFailure('群聊消息调度失败', detail, {key: 'group-dispatch', kind: 'error', toast: false});
            });
        }
        return {ok: true, gid};
    }

    // ---------- 自由聊天路径（消息即唤醒；§4 / §12） ----------

    function chatQueueOf(groupId) {
        let q = chatQueues.get(groupId);
        if (!q) {
            q = {pending: [], running: false, abort: false};
            chatQueues.set(groupId, q);
        }
        return q;
    }

    // 群聊里的系统通知（role:'system' 不进成员上下文，仅用户可见；WeChat 式灰条）
    async function systemNotice(groupId, text) {
        const g = groups.get(groupId);
        if (!g) return;
        const msg = {
            gid: aiNowId('gm-'),
            role: 'system',
            agentId: '',
            agentName: '',
            agentColor: '',
            model: '',
            content: text,
            ts: Date.now(),
            turnId: '',
            round: relayRoundOf(groupId, g.meta),
            replyTo: '',
            addressedTo: [],
            stance: '',
            groupBlock: null,
            usage: null,
            hasPrivate: false,
            timing: null,
            timeout: false,
            status: 'done',
            error: '',
        };
        try {
            await store.append(groupId, encodeGroupMessage(msg) + '\n');
        } catch (e) {
            console.error('系统通知落盘失败', e);
        }
        g.messages.push(msg);
        await saveMeta(groupId, (meta) => {
            meta.messageCount = (meta.messageCount || 0) + 1;
            meta.lastMessageId = msg.gid;
        });
    }

    // 串行队列：用户连发消息按序处理，前一批回复完才跑下一批
    async function runChatDispatch(groupId, userMsg) {
        const q = chatQueueOf(groupId);
        q.pending.push(userMsg);
        if (q.running) return;
        q.running = true;
        try {
            while (q.pending.length && !q.abort) {
                const next = q.pending.shift();
                await runChatTurn(groupId, next);
            }
        } finally {
            q.running = false;
            q.abort = false;
        }
    }

    async function runChatTurn(groupId, userMsg) {
        const g = groups.get(groupId);
        if (!g) return;
        const d = discussionOf(groupId);
        if (d.running || d.paused) return; // 讨论已开始：点名走 forcedIds，不走闲时唤醒
        const config = getAIConfig();
        const agents = agentsOf(config);
        const members = g.meta.memberIds
            .map((id) => agents.find((item) => item && item.id === id))
            .filter((agent) => agent && agent.enabled && !(g.meta.mutedAgentIds || []).includes(agent.id));
        if (!members.length) {
            await systemNotice(groupId, '群里没有可用成员：先到 应用页面 → 智能体 启用成员');
            return;
        }
        // 首批响应者：@点名（全体 = 每人一次）；无 @ → 轮换一位成员接话（§4 默认接话人）
        const mentions = parseMentions(String(userMsg.content || ''), members.map((m) => m.name));
        const queue = [];
        if (mentions.all) {
            for (const m of members) queue.push({id: m.id, gen: 0});
        } else if (mentions.names.length) {
            for (const name of mentions.names) {
                const agent = members.find((m) => m.name === name);
                if (agent && !queue.some((item) => item.id === agent.id)) queue.push({id: agent.id, gen: 0});
            }
        } else {
            const cursor = (chatCursors.get(groupId) || 0) % members.length;
            chatCursors.set(groupId, cursor + 1);
            queue.push({id: members[cursor].id, gen: 0});
        }
        if (!queue.length) {
            await systemNotice(groupId, '没有匹配的成员可回应这条消息');
            return;
        }
        const isFree = g.meta.mode === 'free';
        const turn = {
            replies: 0,
            tokens: 0,
            pairCounts: new Map(),
            perAgent: new Map(),
        };
        while (queue.length && turn.replies < FREE_CHAT_CAPS.maxRepliesPerTurn && turn.tokens < FREE_CHAT_CAPS.maxTokensPerTurn && !chatQueueOf(groupId).abort) {
            if (d.running || d.paused) break; // 讨论中途开始：闲时唤醒让位（点名走 forcedIds）
            const {id, gen} = queue.shift();
            const r = await speak(groupId, id, {focus: gen > 0 ? '群成员在消息里 @ 了你，请回应' : ''});
            if (!r.ok) {
                // 模型不可用 / 上下文不足等：群里明示原因（不静默吞掉）
                await systemNotice(groupId, r.error || '成员调用失败');
                continue;
            }
            const result = await r.done;
            if (result.status !== 'done') continue; // 超时/停止：消息已按 interrupted/error 归档
            turn.replies++;
            turn.perAgent.set(id, (turn.perAgent.get(id) || 0) + 1);
            turn.tokens += (result.usage && result.usage.totalTokens) || 0;
            if (!isFree || gen >= FREE_CHAT_CAPS.maxHops) continue;
            // 自由模式接力：成员输出里的 @ 继续唤醒（单条 ≤2 人、乒乓/单成员/总回复有上限）
            const last = g.messages[g.messages.length - 1];
            if (!last || last.agentId !== id) continue;
            const wakes = relayWakes(last.content, {
                speakerId: id,
                memberNames: members.map((m) => ({id: m.id, name: m.name})),
                generation: gen,
                pairCounts: turn.pairCounts,
                perAgentCounts: turn.perAgent,
            });
            for (const wakeId of wakes) {
                const pairKey = [id, wakeId].sort().join('|');
                turn.pairCounts.set(pairKey, (turn.pairCounts.get(pairKey) || 0) + 1);
                queue.push({id: wakeId, gen: gen + 1});
            }
        }
    }

    // 停止整场：roundId 都以 groupId# 开头，Go 侧前缀匹配全部取消（取消路径补发
    // ai-done finishReason=stopped → finishStream 归档）；自由聊天的排队消息一并清空
    function stopAll(groupId) {
        const q = chatQueues.get(groupId);
        if (q && q.running) q.abort = true;
        if (q) q.pending = [];
        // 接力引擎（G7）同步让位：在飞请求由 AIStop 收尾后，runRelayTurn 按走 stop 归档
        const r = relays.get(groupId);
        if (r && r.running) r.abort = true;
        // 工具轮间隔（无在飞请求）也要拦：置标志让续发停止并按 stopped 归档
        for (const stream of streams.values()) {
            if (stream.groupId === groupId && !stream.finished) stream.toolAbort = true;
        }
        try {
            backend.AIStop(groupId);
        } catch (e) {
            console.error('AIStop 失败', e);
        }
    }

    function stopOne(groupId, agentId) {
        const stream = activeStreamOf(groupId);
        if (stream && stream.agentId === agentId) {
            // 在飞请求由 AIStop 走 ai-done(stopped) 正常收尾；工具轮间隔靠标志拦住续发
            if (!stream.finished) stream.toolAbort = true;
            try {
                backend.AIStop(stream.roundId);
            } catch (e) {
                console.error('AIStop 失败', e);
            }
        }
    }

    // ---------- 讨论引擎（G3，§3.3 / §3.6 / §3.7 / §3.9） ----------

    // 讨论状态为内存态：重启后按 meta.discussion.round 恢复展示，讨论需手动继续
    const discussions = new Map();

    function discussionOf(groupId) {
        let d = discussions.get(groupId);
        if (!d) {
            d = {
                running: false,
                paused: false,
                abort: false,
                phase: 'idle',        // idle | opening | speaking | review | paused | ended
                plan: [],
                nextPlan: null,
                roundDone: false,
                spokenThisRound: new Set(),
                forcedIds: [],        // 用户点名队列（优先于主持人计划，§3.9）
                speeches: 0,
                tokens: 0,
                startedAt: 0,
                chairFails: 0,
                needMinutes: false,
                error: '',
            };
            discussions.set(groupId, d);
        }
        return d;
    }

    function discussionSnapshot(groupId) {
        const d = discussions.get(groupId);
        const g = groups.get(groupId);
        if (!d || !g) return null;
        return {
            running: d.running,
            paused: d.paused,
            phase: d.phase,
            round: currentRound(g.meta),
            maxRounds: g.meta.maxRounds,
            // G6：maxRounds=0 = 不限轮次；视图据此显示「第 N 轮 · 不限」而不是 N/0
            unlimitedRounds: isUnlimitedRounds(g.meta),
            maxSpeeches: g.meta.maxSpeeches,
            speeches: d.speeches,
            spokenCount: d.spokenThisRound.size,
            memberCount: g.meta.memberIds.length,
            error: d.error,
        };
    }

    function chairAgentOf(meta, agents) {
        if (!meta.chair || meta.chair.kind === 'user') return null;
        return agents.find((item) => item && item.id === meta.chair.agentId) || null;
    }

    async function pauseForChairProblem(groupId, type, text) {
        const d = discussionOf(groupId);
        await appendSystemEvent(groupId, {type, text});
        d.paused = true;
        d.phase = 'paused';
        d.error = text;
        notify();
    }

    // 主持人一次调度调用（opening / review / minutes）。契约解析与 chairMessage 归档
    // 在 finishStream 内完成（chair 流）；这里只等结果并做回退判定。
    async function chairTurn(groupId, kind) {
        const g = groups.get(groupId);
        const config = getAIConfig();
        const agents = agentsOf(config);
        const meta = g.meta;
        const chairAgent = chairAgentOf(meta, agents);
        if (!chairAgent) return {ok: false, noChair: true};
        const resolved = resolveModel(chairAgent.modelRef);
        if (!resolved || !resolved.profileCfg) return {ok: false, error: `${chairAgent.name}（主持人）的模型不可用`};
        let chairSteps = [];
        try {
            chairSteps = parsePrivateSteps(await store.privateRead(groupId, chairAgent.id));
        } catch (e) { /* 私有日志读取失败按无过程处理 */ }
        const window = (resolved.entry && resolved.entry.contextWindow) || meta.context.preferredWindow || 262144;
        const folded = foldPrivateSteps(chairSteps, Math.max(1024, Math.round(window * 0.12)));
        const built = buildChairMessages({
            chairAgent,
            meta,
            sharedMessages: g.messages,
            chairSteps: folded.steps,
            kind,
            outputLanguage: (config && config.outputLanguage) || 'zh',
            memberWindow: window,
        });
        if (built.overflow) {
            return {ok: false, overflow: true, error: '主持人的上下文装不下全部群聊对话'};
        }
        const seq = (groupSeq.get(groupId) || 0) + 1;
        groupSeq.set(groupId, seq);
        const roundId = groupId + '#chair-' + kind + '-' + seq;
        const timeouts = chairTimeouts(meta, chairAgent, config.profiles);
        const stream = {
            roundId,
            groupId,
            agentId: chairAgent.id,
            agentName: '主持人',
            agentColor: chairAgent.color,
            modelAccount: (resolved.account && resolved.account.name) || '',
            modelName: resolved.label || '',
            content: '',
            thinking: '',
            startedAt: Date.now(),
            firstActivityAt: 0,
            firstTokenMs: 0,
            statusCode: 0,
            finished: false,
            timeout: false,
            timedOutBy: '',
            statusNote: '主持人正在整理本轮…',
            error: '',
            chair: true,
            groupBlock: null,
            contract: null,
            timers: {first: null, total: null},
            // 自动重试上下文：ai-error.retryable 时按原 roundId 续发（见 retryGroupSpeechStream）
            profileCfg: resolved.profileCfg,
            apiMessages: built.messages,
            tools: [],
            retryMax: aiClampInt(config && config.retryMax, 0, 10, 5),
        };
        stream.done = new Promise((resolve) => {
            stream.resolve = resolve;
        });
        streams.set(roundId, stream);
        stream.timers.first = setTimeout(() => fireTimeout(stream, 'first'), timeouts.totalMs);
        stream.timers.total = setTimeout(() => fireTimeout(stream, 'total'), timeouts.totalMs);
        notify();
        try {
            const sendResult = backend.AISendChat(roundId, resolved.profileCfg, built.messages, [], aiClampInt(config && config.retryMax, 0, 10, 5));
            Promise.resolve(sendResult).catch((e) => failStream(stream, (e && e.message) || String(e)));
        } catch (e) {
            failStream(stream, (e && e.message) || String(e));
            return {ok: false, error: '主持人调用失败：' + ((e && e.message) || e)};
        }
        const result = await stream.done;
        if (result.status !== 'done') return {ok: false, error: result.error || ('主持人调用' + result.status)};
        if (!result.contract) return {ok: false, parseFailed: true, error: result.error || '主持人输出无法解析'};
        return {ok: true, contract: result.contract};
    }

    function nextSpeaker(groupId) {
        const d = discussionOf(groupId);
        const g = groups.get(groupId);
        const meta = g.meta;
        // 用户点名优先（§3.9）：即使本轮已发言也允许追问；同一点名只消费一次
        while (d.forcedIds.length) {
            const id = d.forcedIds.shift();
            if (meta.memberIds.includes(id)) return {agentId: id, focus: '用户点名，请回应相关问题', agendaItem: ''};
        }
        while (d.plan.length) {
            const item = d.plan.shift();
            if (meta.memberIds.includes(item.agentId) && !d.spokenThisRound.has(item.agentId)) return item;
        }
        // 回退：本轮未发言成员按名单顺序（§3.6）
        const fallback = fallbackPlan({memberIds: meta.memberIds, mutedAgentIds: meta.mutedAgentIds, spokenThisRound: [...d.spokenThisRound]});
        return fallback.length ? fallback[0] : null;
    }

    async function generateMinutes(groupId, source) {
        const g = groups.get(groupId);
        if (!g) return;
        const text = (source && source.minutesText) || minutesFromBoard(g.meta);
        const chairAgent = chairAgentOf(g.meta, agentsOf(getAIConfig()));
        const gid = aiNowId('gm-');
        // source 可覆盖署名（接力总结 = 链尾成员，不是主持人）
        const signAgent = source && source.agentName
            ? {id: source.agentId || '', name: source.agentName, color: source.agentColor || ''}
            : null;
        const msg = {
            gid,
            role: 'assistant',
            agentId: signAgent ? signAgent.id : (chairAgent ? chairAgent.id : 'chair'),
            agentName: signAgent ? signAgent.name : '主持人',
            agentColor: signAgent ? signAgent.color : (chairAgent ? chairAgent.color : ''),
            model: (source && source.modelName) || '',
            content: text,
            ts: Date.now(),
            turnId: '',
            round: relayRoundOf(groupId, g.meta),
            replyTo: '',
            addressedTo: [],
            stance: '',
            groupBlock: null,
            usage: null,
            hasPrivate: false,
            timing: null,
            timeout: false,
            status: 'done',
            error: '',
            chair: true,
            kind: 'minutes',
        };
        try {
            await store.append(groupId, encodeGroupMessage(msg) + '\n');
            g.messages.push(msg);
            await saveMeta(groupId, (meta) => {
                meta.minutes = {text, createdAt: Date.now(), source: (source && source.source) || 'board'};
                meta.messageCount = (meta.messageCount || 0) + 1;
                meta.lastMessageId = gid;
                meta.lastPreview = previewOfMessage(msg);
            });
        } catch (e) {
            const detail = String((e && e.message) || e);
            flash('纪要落盘失败：' + detail, true);
            notifyFailure('群聊纪要落盘失败', detail, {key: 'group-minutes-save', kind: 'error'});
        }
    }

    async function runDiscussion(groupId) {
        const d = discussionOf(groupId);
        const g = groups.get(groupId);
        if (!g || d.running) return;
        d.running = true;
        d.error = '';
        if (d.phase === 'idle' || d.phase === 'ended') d.phase = 'opening';
        notify();
        // 群讨论租约（multi-instance-sync P6 收尾）：整场讨论一个群同一时刻只有
        // 一个窗口主持——跨窗口 busy 直接落 error（进程内 refcount 不再放行双主持）。
        // 绑定不可用（旧 mock）时不阻塞讨论，维持旧行为。
        if (backend.GroupLeaseAcquire) {
            try {
                const lease = await backend.GroupLeaseAcquire(groupId, '');
                if (!lease || lease.busy) {
                    d.running = false;
                    d.phase = 'idle';
                    d.error = '群聊正在另一窗口讨论';
                    notify();
                    if (typeof deps.flash === 'function') deps.flash('群聊正在另一窗口讨论', true);
                    return;
                }
                d.leaseHeld = true;
            } catch (e) {}
        }
        try {
            while (!d.abort) {
                const meta = g.meta;
                if (d.paused) {
                    d.phase = 'paused';
                    notify();
                    return;
                }
                if (d.startedAt && Date.now() - d.startedAt > (meta.timeouts.discussionTotalMs || 900000)) {
                    await appendSystemEvent(groupId, {type: 'budget', text: '整场讨论达到时长上限，已停止并生成纪要'});
                    d.needMinutes = true;
                    break;
                }
                if (d.speeches >= meta.maxSpeeches) {
                    await appendSystemEvent(groupId, {type: 'budget', text: `达到发言次数上限（${meta.maxSpeeches}），已停止并生成纪要`});
                    d.needMinutes = true;
                    break;
                }
                if (d.phase === 'opening') {
                    if (!meta.chair || meta.chair.kind === 'user') {
                        // 用户主持：无开场调用，计划=成员顺序（§3.1 用户主持）
                        d.plan = fallbackPlan({memberIds: meta.memberIds, mutedAgentIds: meta.mutedAgentIds, spokenThisRound: []});
                        d.spokenThisRound = new Set();
                        d.phase = 'speaking';
                        continue;
                    }
                    const chair = await chairTurn(groupId, 'opening');
                    if (!chair.ok) {
                        if (chair.overflow) {
                            await pauseForChairProblem(groupId, 'chair-overflow', '主持人的上下文装不下全部群聊对话，讨论已暂停；请压缩群聊数据或更换主持人');
                            return;
                        }
                        d.chairFails++;
                        if (d.chairFails >= 2) {
                            await pauseForChairProblem(groupId, 'chair-fail', '主持人连续两次输出无法解析，讨论已暂停；可更换主持人或用「请发言」手动调度');
                            return;
                        }
                        d.plan = fallbackPlan({memberIds: meta.memberIds, mutedAgentIds: meta.mutedAgentIds, spokenThisRound: []});
                        d.spokenThisRound = new Set();
                        d.phase = 'speaking';
                        continue;
                    }
                    d.chairFails = 0;
                    const agents = agentsOf(getAIConfig());
                    d.plan = sanitizeChairPlan(chair.contract.plan, {
                        agents,
                        memberIds: meta.memberIds,
                        mutedAgentIds: meta.mutedAgentIds,
                        spokenThisRound: [],
                    });
                    d.spokenThisRound = new Set();
                    await saveMeta(groupId, (meta2) => {
                        if (chair.contract.statePatch) applyStatePatch(meta2, chair.contract.statePatch);
                        for (const item of chair.contract.plan) {
                            if (item.agendaItem && !meta2.discussion.agenda.includes(item.agendaItem)) {
                                meta2.discussion.agenda.push(item.agendaItem);
                            }
                        }
                        meta2.discussion.round = 1;
                    });
                    d.phase = 'speaking';
                    continue;
                }
                if (d.phase === 'speaking') {
                    const next = nextSpeaker(groupId);
                    if (!next) {
                        d.phase = 'review';
                        continue;
                    }
                    const r = await speak(groupId, next.agentId, {focus: next.focus});
                    if (!r.ok) {
                        // 成员不可用 / 上下文不足：标记本轮已处理并继续（不阻塞整轮，§3.16）
                        d.spokenThisRound.add(next.agentId);
                        continue;
                    }
                    const result = await r.done;
                    d.speeches++;
                    d.spokenThisRound.add(next.agentId);
                    d.tokens += (result.usage && result.usage.totalTokens) || 0;
                    const last = g.messages[g.messages.length - 1];
                    if (last && last.groupBlock) {
                        await saveMeta(groupId, (meta2) => mergeGroupBlock(meta2, last.agentId, last.agentName || '', last.groupBlock));
                    }
                    continue;
                }
                if (d.phase === 'review') {
                    let roundDone = true;
                    let nextPlan = null;
                    let minutesText = null;
                    if (meta.chair && meta.chair.kind !== 'user') {
                        const chair = await chairTurn(groupId, 'review');
                        if (!chair.ok) {
                            if (chair.overflow) {
                                await pauseForChairProblem(groupId, 'chair-overflow', '主持人的上下文装不下全部群聊对话，讨论已暂停；请压缩群聊数据或更换主持人');
                                return;
                            }
                            d.chairFails++;
                            if (d.chairFails >= 2) {
                                await pauseForChairProblem(groupId, 'chair-fail', '主持人连续两次输出无法解析，讨论已暂停；可更换主持人或用「请发言」手动调度');
                                return;
                            }
                            // 回退：本轮结束，进下一轮或收敛（§3.6）
                        } else {
                            d.chairFails = 0;
                            const contract = chair.contract;
                            await saveMeta(groupId, (meta2) => {
                                if (contract.statePatch) applyStatePatch(meta2, contract.statePatch);
                                if (contract.chairMessage) meta2.discussion.lastRoundSummary = contract.chairMessage.slice(0, 300);
                            });
                            roundDone = contract.roundComplete === true;
                            nextPlan = sanitizeChairPlan(contract.plan, {
                                agents: agentsOf(getAIConfig()),
                                memberIds: meta.memberIds,
                                mutedAgentIds: meta.mutedAgentIds,
                                spokenThisRound: [],
                            });
                            minutesText = contract.minutes;
                            if (contract.done) {
                                d.needMinutes = true;
                                if (minutesText) await generateMinutes(groupId, {minutesText, source: 'polish', modelName: '主持人'});
                                break;
                            }
                        }
                    }
                    if (roundDone) {
                        // G6：maxRounds=0（不限轮次）只受发言上限 / 总时长 / 手动结束约束
                        if (currentRound(meta) >= maxRoundsOf(meta)) {
                            d.needMinutes = true;
                            break;
                        }
                        await saveMeta(groupId, (meta2) => {
                            meta2.discussion.round = currentRound(meta2) + 1;
                        });
                        d.spokenThisRound = new Set();
                        d.plan = Array.isArray(nextPlan) ? nextPlan : [];
                        d.phase = 'speaking';
                        continue;
                    }
                    // 轮未完（adaptive 剩余安排）：继续本轮发言
                    d.plan = Array.isArray(nextPlan) ? nextPlan : [];
                    d.phase = 'speaking';
                    continue;
                }
                break; // 未知阶段兜底退出
            }
        } finally {
            d.running = false;
            // 讨论退出（结束/暂停/出错）都放掉讨论租约：暂停态不长期占锁，
            // 恢复时 runDiscussion 会重新获取。
            if (d.leaseHeld && backend.GroupLeaseRelease) {
                d.leaseHeld = false;
                Promise.resolve(backend.GroupLeaseRelease(groupId)).catch(() => {});
            }
            if (d.needMinutes) {
                d.needMinutes = false;
                d.phase = 'ended';
                if (!g.meta.minutes) await generateMinutes(groupId, {source: 'board'});
            } else if (d.phase !== 'paused') {
                d.phase = 'idle';
            }
            notify();
        }
    }

    function startDiscussion(groupId) {
        const g = groups.get(groupId);
        if (!g) return {ok: false, error: '群聊不存在'};
        const d = discussionOf(groupId);
        if (d.running) return {ok: false, error: '讨论已在进行'};
        if (d.paused) return resumeDiscussion(groupId);
        d.abort = false;
        d.paused = false;
        d.startedAt = Date.now();
        d.speeches = 0;
        d.tokens = 0;
        d.phase = g.meta.discussion.round > 0 ? 'speaking' : 'opening';
        runDiscussion(groupId);
        return {ok: true};
    }

    function pauseDiscussion(groupId) {
        // 当前发言说完后停（§3.9）；在飞请求不打断
        discussionOf(groupId).paused = true;
        notify();
        return {ok: true};
    }

    function resumeDiscussion(groupId) {
        const d = discussionOf(groupId);
        if (!d.paused) return {ok: false, error: '讨论未处于暂停'};
        d.paused = false;
        d.abort = false;
        // 暂停把 phase 置成 'paused'；恢复后回到发言阶段（计划与轮次状态保持不变）
        if (d.phase === 'paused') d.phase = 'speaking';
        runDiscussion(groupId);
        return {ok: true};
    }

    function endDiscussion(groupId) {
        const d = discussionOf(groupId);
        d.abort = true;
        d.needMinutes = true;
        // 「结束并总结」立即中断在飞请求（§3.9）
        stopAll(groupId);
        notify();
        return {ok: true};
    }

    // 用户插话里的点名（§3.9）：@A / @全体成员 → 强制进下一次调度
    function noteMentions(groupId, text) {
        const g = groups.get(groupId);
        if (!g) return;
        const agents = agentsOf(getAIConfig());
        const names = g.meta.memberIds
            .map((id) => {
                const agent = agents.find((item) => item && item.id === id);
                return agent ? agent.name : '';
            })
            .filter(Boolean);
        const mentions = parseMentions(text, names);
        if (!mentions.all && !mentions.names.length) return;
        const d = discussionOf(groupId);
        if (mentions.all) {
            for (const id of g.meta.memberIds) {
                if (!d.forcedIds.includes(id)) d.forcedIds.push(id);
            }
        } else {
            for (const name of mentions.names) {
                const agent = agents.find((item) => item && item.name === name);
                if (agent && g.meta.memberIds.includes(agent.id) && !d.forcedIds.includes(agent.id)) {
                    d.forcedIds.push(agent.id);
                }
            }
        }
        appendSystemEvent(groupId, {type: 'mention', text: '用户点名：' + (mentions.all ? '@全体成员' : '@' + mentions.names.join(' @'))});
    }

    // ---------- 接力引擎（G7：多模型按序交棒，后者可回问前棒） ----------
    // 形态镜像讨论引擎：内存态 + meta.relay 持久化进度；跨窗口租约同款。
    // 交棒 = 成员在回复末尾写【交棒】（模型声明）；回问 = @ 前棒，答完回到提问者。

    const relays = new Map();

    function relayOf(groupId) {
        let r = relays.get(groupId);
        if (!r) {
            r = {
                running: false,
                paused: false,
                abort: false,
                chain: [],            // 棒次快照（启动时按 memberIds 顺序剔除停用/静音）
                stage: 0,             // 0 基当前棒
                passes: 0,
                speeches: 0,
                tokens: 0,
                stageSpeaks: new Map(),  // stage → 本遍该棒已发言次数（含续写/回问续）
                askCounts: new Map(),    // stage → 本遍该棒已回问次数
                pendingUser: [],         // 运行中用户插话（下一棒开跑前以焦点提醒）
                needMinutes: false,      // 「结束并总结」：中断后由最后完成的棒出纪要
                startedAt: 0,
                leaseHeld: false,
                error: '',
            };
            relays.set(groupId, r);
        }
        return r;
    }

    function relayAgentOf(groupId, agentId) {
        return agentsOf(getAIConfig()).find((item) => item && item.id === agentId) || null;
    }

    // 向后扫该成员最近一条 assistant 消息（跳过其间的系统事件/其他成员；串行轮保证安全）
    function lastMemberMessage(g, agentId) {
        const list = Array.isArray(g.messages) ? g.messages : [];
        for (let i = list.length - 1; i >= 0; i--) {
            const msg = list[i];
            if (msg.role === 'assistant' && msg.agentId === agentId) return msg;
        }
        return null;
    }

    function relaySnapshot(groupId) {
        const r = relays.get(groupId);
        const g = groups.get(groupId);
        if (!r || !g) return null;
        const agent = r.chain[r.stage] ? relayAgentOf(groupId, r.chain[r.stage]) : null;
        return {
            running: r.running,
            paused: r.paused,
            stage: Math.min(r.stage + 1, Math.max(1, r.chain.length)),
            stageCount: r.chain.length,
            stageName: agent ? agent.name : '',
            speeches: r.speeches,
            done: !!(g.meta.relay && g.meta.relay.done),
            error: r.error,
        };
    }

    async function relaySpeak(groupId, r, agentId, focus) {
        const res = await speak(groupId, agentId, {focus});
        if (!res.ok) {
            const agent = relayAgentOf(groupId, agentId);
            r.error = res.error || '成员调用失败';
            await appendSystemEvent(groupId, {type: 'relay', text: `${agent ? agent.name : '成员'} 发言失败：${res.error || '未知原因'}`});
            return {ok: false};
        }
        const result = await res.done;
        r.speeches++;
        r.tokens += (result.usage && result.usage.totalTokens) || 0;
        notify();
        return {ok: true, status: result.status};
    }

    // 单棒：发言 → 回问闭环（@ 前棒，答完回来续）→ 检查【交棒】标记；无标记重唤，
    // 到 stageSpeaksMax 由系统代为推进。返回 'advance' | 'stop' | 'error'。
    async function runRelayStage(groupId, r) {
        const g = groups.get(groupId);
        const agentId = r.chain[r.stage];
        const agent = relayAgentOf(groupId, agentId);
        if (!agent || !agent.enabled || (g.meta.mutedAgentIds || []).includes(agentId)) {
            await appendSystemEvent(groupId, {type: 'relay', text: `第 ${r.stage + 1} 棒成员不可用，跳过`});
            return 'advance';
        }
        const count = r.chain.length;
        const earlier = r.chain.slice(0, r.stage)
            .map((id) => {
                const item = relayAgentOf(groupId, id);
                return item ? {id, name: item.name} : null;
            })
            .filter(Boolean);
        const next = r.stage + 1 < count ? relayAgentOf(groupId, r.chain[r.stage + 1]) : null;
        const speaks = () => r.stageSpeaks.get(r.stage) || 0;
        const asks = () => r.askCounts.get(r.stage) || 0;
        // 暂停/中断后续跑：已讲过 → 用续写焦点（不再重发完整开工契约）
        let focus = speaks() > 0
            ? relayStageFocus({kind: 'reawake'})
            : relayStageFocus({kind: 'start', index: r.stage, count, nextName: next ? next.name : ''});
        if (r.pendingUser.length) {
            focus += `\n用户刚补充了 ${r.pendingUser.length} 条消息（见共享对话），请纳入考虑。`;
            r.pendingUser = [];
        }
        while (speaks() < RELAY_CAPS.stageSpeaksMax && !r.abort) {
            if (r.paused) return 'paused'; // 当前发言说完后停（与讨论同款）
            const speech = await relaySpeak(groupId, r, agentId, focus);
            if (!speech.ok) return 'error';
            if (speech.status !== 'done') return 'stop'; // 超时/停止：消息已按 interrupted/error 归档
            r.stageSpeaks.set(r.stage, speaks() + 1);
            const last = lastMemberMessage(g, agentId);
            if (!last) return 'error';
            // 回问优先于交棒标记：问了就等答案，答完再续
            const targets = asks() < RELAY_CAPS.askBacksMax
                ? relayAskTargets(String(last.content || ''), {speakerId: agentId, earlierNames: earlier})
                : [];
            if (targets.length) {
                r.askCounts.set(r.stage, asks() + 1);
                let answered = false;
                for (const targetId of targets) {
                    const answerer = relayAgentOf(groupId, targetId);
                    const answer = await relaySpeak(groupId, r, targetId, relayStageFocus({kind: 'answer', askerName: agent.name}));
                    if (!answer.ok) {
                        // 被回问者静音/停用/调用失败：写灰条说明原因，别让用户以为是引擎漏调度
                        await appendSystemEvent(groupId, {type: 'relay', text: `「${answerer ? answerer.name : '被回问成员'}」无法回答「${agent.name}」的回问：${answer.error || '成员不可用'}`});
                        continue;
                    }
                    if (answer.status !== 'done') return 'stop';
                    answered = true;
                }
                if (answered) {
                    focus = relayStageFocus({kind: 'resume', index: r.stage, count, nextName: next ? next.name : ''});
                    continue;
                }
                await appendSystemEvent(groupId, {type: 'relay', text: `前棒未能回答「${agent.name}」的回问，请基于现有信息继续`});
            } else if (asks() >= RELAY_CAPS.askBacksMax && !hasHandoffMarker(last.content)
                && relayAskTargets(String(last.content || ''), {speakerId: agentId, earlierNames: earlier}).length) {
                await appendSystemEvent(groupId, {type: 'relay', text: `「${agent.name}」的回问次数已达上限，请基于现有信息继续`});
            }
            if (hasHandoffMarker(last.content)) return 'advance';
            if (speaks() < RELAY_CAPS.stageSpeaksMax) {
                focus = relayStageFocus({kind: 'reawake'});
                continue;
            }
            await appendSystemEvent(groupId, {type: 'relay', text: `「${agent.name}」未声明交棒，系统代为推进`});
            return 'advance';
        }
        return r.abort ? 'stop' : 'advance';
    }

    // 成果纪要：最后完成的棒再讲一次总结，其内容经 generateMinutes 落纪要卡片
    async function relaySummarize(groupId, r) {
        const g = groups.get(groupId);
        // 没有实质产出（首棒前就被中断/预算耗尽）不产纪要——纪要须基于已落盘的成员发言，
        // 此时调用方日志也不能说「已生成总结」（见 runRelayTurn 的 budget 分支文案）。
        if (!g || r.stage <= 0) return;
        const doneIdx = Math.min(r.stage, r.chain.length) - 1;
        const agentId = r.chain[doneIdx];
        const agent = agentId ? relayAgentOf(groupId, agentId) : null;
        if (!agent) return;
        const speech = await relaySpeak(groupId, r, agentId,
            '接力已结束。请把本场全部产出整理成一份成果纪要（Markdown）：任务目标、各棒分工与产出、最终成果、遗留问题。只输出纪要本身，不要写【交棒】。');
        if (!speech.ok || speech.status !== 'done') {
            await appendSystemEvent(groupId, {type: 'relay', text: '成果纪要生成失败，可再跑一遍接力'});
            return;
        }
        const last = lastMemberMessage(g, agentId);
        const text = stripHandoffMarker(String((last && last.content) || '')).trim();
        if (!text) return;
        await generateMinutes(groupId, {
            minutesText: text,
            source: 'relay',
            modelName: agent.name,
            agentId: agent.id,
            agentName: agent.name,
            agentColor: agent.color,
        });
    }

    async function runRelayTurn(groupId) {
        const g = groups.get(groupId);
        const r = relayOf(groupId);
        if (!g) return;
        r.running = true;
        r.error = '';
        notify();
        // 群租约（与讨论同款）：整场接力一个群同一时刻只有一个窗口主持
        if (backend.GroupLeaseAcquire) {
            try {
                const lease = await backend.GroupLeaseAcquire(groupId, '');
                if (!lease || lease.busy) {
                    r.running = false;
                    r.error = '群聊正在另一窗口接力';
                    notify();
                    flash('群聊正在另一窗口接力', true);
                    return;
                }
                r.leaseHeld = true;
            } catch (e) {
                // best-effort：租约获取失败按「无租约」继续，由后端 AIGroupAppend 的 busy 语义兜底
                console.error('接力租约获取失败，按无租约继续', e);
            }
        }
        try {
            while (!r.abort && r.stage < r.chain.length) {
                if (r.paused) return;
                if (r.startedAt && Date.now() - r.startedAt > (g.meta.timeouts.discussionTotalMs || 3600000)) {
                    await appendSystemEvent(groupId, {type: 'budget', text: r.stage > 0 ? '接力达到时长上限，已停止并生成总结' : '接力达到时长上限，已停止（尚无产出，未生成总结）'});
                    r.needMinutes = true;
                    break;
                }
                if (g.meta.maxTokensPerDiscussion > 0 && r.tokens >= g.meta.maxTokensPerDiscussion) {
                    await appendSystemEvent(groupId, {type: 'budget', text: r.stage > 0 ? '接力达到 token 预算上限，已停止并生成总结' : '接力达到 token 预算上限，已停止（尚无产出，未生成总结）'});
                    r.needMinutes = true;
                    break;
                }
                const outcome = await runRelayStage(groupId, r);
                if (outcome !== 'advance') break;
                r.stage++;
                await saveMeta(groupId, (meta) => {
                    meta.relay.stage = r.stage;
                    meta.relay.passes = r.passes;
                });
            }
        } finally {
            r.running = false;
            if (r.leaseHeld && backend.GroupLeaseRelease) {
                r.leaseHeld = false;
                // best-effort：租约到期后端自动释放，释放失败无需打断收尾
                Promise.resolve(backend.GroupLeaseRelease(groupId)).catch((e) => console.error('接力租约释放失败', e));
            }
            try {
                await finishRelay(groupId, r);
            } catch (e) {
                console.error('接力收尾失败', e);
            }
            notify();
        }
    }

    // opts.fresh：新需求强制从第 1 棒重跑；缺省时上次未跑完（中断）则从断点棒继续，
    // 已完成（done）的重跑也是全新一遍。「开始接力」按钮走断点续跑语义。
    function startRelay(groupId, opts = {}) {
        const g = groups.get(groupId);
        if (!g) return {ok: false, error: '群聊不存在'};
        if (g.meta.mode !== 'relay') return {ok: false, error: '该群不是接力模式'};
        const r = relayOf(groupId);
        if (r.running) return {ok: false, error: '接力已在进行'};
        if (activeStreamOf(groupId)) return {ok: false, error: '已有成员正在发言（串行轮）'};
        const agents = agentsOf(getAIConfig());
        const muted = new Set(g.meta.mutedAgentIds || []);
        const chain = g.meta.memberIds.filter((id) => {
            const agent = agents.find((item) => item && item.id === id);
            return agent && agent.enabled && !muted.has(id);
        });
        if (chain.length < GROUP_MEMBER_MIN) {
            return {ok: false, error: `可用成员不足（${chain.length} 位，接力至少 ${GROUP_MEMBER_MIN} 棒；先到 应用页面 → 智能体 启用成员）`};
        }
        const relayMeta = g.meta.relay || {};
        const resumeStage = relayMeta.done ? chain.length : Math.min(relayMeta.stage || 0, chain.length);
        const fresh = opts.fresh === true || resumeStage >= chain.length;
        r.chain = chain;
        r.stage = fresh ? 0 : resumeStage;
        r.abort = false;
        r.paused = false;
        r.error = '';
        r.speeches = 0;
        r.tokens = 0;
        r.stageSpeaks = new Map();
        r.askCounts = new Map();
        r.pendingUser = [];
        r.needMinutes = false;
        r.startedAt = Date.now();
        r.passes = ((g.meta.relay && g.meta.relay.passes) || 0) + 1;
        saveMeta(groupId, (meta) => {
            meta.relay.stage = r.stage;
            meta.relay.done = false;
            meta.relay.passes = r.passes;
        }).catch(() => {});
        if (!fresh && r.stage > 0) {
            appendSystemEvent(groupId, {type: 'relay', text: `接力从第 ${r.stage + 1} 棒继续`}).catch(() => {});
        }
        // 不 await：发送路径立即返回，流事件照常推给视图
        runRelayTurn(groupId).catch((e) => {
            r.running = false;
            r.error = String((e && e.message) || e);
            notify();
        });
        return {ok: true};
    }

    function pauseRelay(groupId) {
        const r = relays.get(groupId);
        if (!r || !r.running) return {ok: false, error: '接力未在进行'};
        r.paused = true; // 当前发言说完后停（与讨论同款）
        r.pausedAt = Date.now();
        notify();
        return {ok: true};
    }

    function resumeRelay(groupId) {
        const g = groups.get(groupId);
        const r = relayOf(groupId);
        if (!g) return {ok: false, error: '群聊不存在'};
        if (!r.paused || r.running) return {ok: false, error: '接力未处于暂停'};
        // 「结束并总结」已清 paused，走不到这里；双保险：abort/needMinutes 置位时不允许复活
        if (r.abort || r.needMinutes) return {ok: false, error: '接力已结束，请重新开始'};
        r.paused = false;
        r.abort = false;
        // 暂停时长不计入总时长预算：顺延 startedAt，避免长时间暂停后一恢复就立刻超时
        if (r.pausedAt && r.startedAt) r.startedAt += Date.now() - r.pausedAt;
        r.pausedAt = 0;
        runRelayTurn(groupId).catch((e) => {
            r.running = false;
            r.error = String((e && e.message) || e);
            notify();
        });
        return {ok: true};
    }

    function endRelay(groupId) {
        const r = relays.get(groupId);
        if (!r || (!r.running && !r.paused)) return {ok: false, error: '接力未在进行'};
        r.abort = true;
        r.needMinutes = true;
        // 暂停态没有活跃循环消费 abort/needMinutes：显式清 paused，防止 resumeRelay 复活；
        // 并在这里直接收尾出纪要（running 态则由 runRelayTurn 的 finally 收尾，避免重复）。
        const wasPaused = r.paused;
        r.paused = false;
        // 「结束并总结」立即中断在飞请求；总结由最后完成的棒输出
        stopAll(groupId);
        if (wasPaused) {
            Promise.resolve().then(() => finishRelay(groupId, r)).catch((e) => console.error('接力收尾失败', e));
        }
        notify();
        return {ok: true};
    }

    // 接力收尾：出纪要 + 落 done（runRelayTurn.finally 与暂停态 endRelay 共用）
    async function finishRelay(groupId, r) {
        const completed = !r.abort && r.stage >= r.chain.length && r.chain.length > 0;
        if (r.needMinutes || completed) await relaySummarize(groupId, r);
        if (completed) {
            await saveMeta(groupId, (meta) => {
                meta.relay.done = true;
                meta.relay.stage = r.stage;
            });
            await appendSystemEvent(groupId, {type: 'relay', text: `接力完成 · 共 ${r.chain.length} 棒`});
        }
    }

    // ---------- 手动压缩群聊数据（§3.11：唯一能压缩共享对话的路径） ----------

    // cutoff 计算：默认保留最近 keepRounds 轮全文（§16.14）；keepRounds=0 表示全部进摘要
    function computeCutoff(messages, keepRounds) {
        const list = Array.isArray(messages) ? messages : [];
        const rounds = [...new Set(list.map((m) => m.round || 1))].sort((a, b) => a - b);
        if (!rounds.length) return '';
        if (keepRounds <= 0) return ''; // 全部摘要
        const keepFrom = rounds[Math.max(0, rounds.length - keepRounds)];
        const first = list.find((m) => (m.round || 1) === keepFrom);
        return first ? first.gid : '';
    }

    async function compressShared(groupId, opts = {}) {
        const g = groups.get(groupId);
        if (!g) return {ok: false, error: '群聊不存在'};
        const config = getAIConfig();
        const agents = agentsOf(config);
        // 摘要模型：指定 > 主持人 > 最大窗口成员（§16.13）
        let ref = opts.modelRef || '';
        if (!ref) {
            const chair = chairAgentOf(g.meta, agents);
            if (chair && chair.modelRef) ref = chair.modelRef;
        }
        let resolved = ref ? resolveModel(ref) : null;
        if (!resolved) {
            let best = null;
            for (const id of g.meta.memberIds) {
                const agent = agents.find((item) => item && item.id === id);
                if (!agent) continue;
                const cap = resolveModel(agent.modelRef);
                if (cap && cap.entry && (!best || (cap.entry.contextWindow || 0) > (best.entry.contextWindow || 0))) {
                    best = {...cap, agent};
                }
            }
            resolved = best;
        }
        if (!resolved || !resolved.profileCfg) return {ok: false, error: '没有可用的摘要模型'};
        const keepRounds = Number.isFinite(opts.keepRounds) ? Math.max(0, Math.round(opts.keepRounds)) : 1;
        const cutoff = computeCutoff(g.messages, keepRounds);
        if (keepRounds > 0 && !cutoff) return {ok: false, error: '对话还没有轮次分组，暂无法压缩'};
        const covered = g.messages.filter((m) => (keepRounds > 0 ? (m.round || 1) < (g.messages.find((x) => x.gid === cutoff) || {round: 1}).round : true));
        if (!covered.length) return {ok: false, error: '没有可压缩的历史（最近轮已全文保留）'};
        const window = (resolved.entry && resolved.entry.contextWindow) || 262144;
        const dialogueText = covered
            .map((m) => (m.role === 'user' ? '[用户] ' : '[' + (m.agentName || '成员') + '] ') + (m.content || ''))
            .join('\n\n');
        if (800 + aiEstimateTokens(dialogueText) > window) {
            return {ok: false, error: '所选摘要模型装不下待压缩的对话，请换更大窗口的模型'};
        }
        const messages = [
            {role: 'system', content: '你是讨论记录摘要器：把群聊对话压成一份中文摘要，保留共识、分歧（双方观点）、未决问题、行动项与关键论证；不新增观点、不遗漏分歧；3000 字以内。'},
            {role: 'user', content: '请摘要以下群聊对话（这是完整历史中较早的部分，最近一轮全文保留在原日志）：\n\n' + dialogueText},
        ];
        const seq = (groupSeq.get(groupId) || 0) + 1;
        groupSeq.set(groupId, seq);
        const roundId = groupId + '#compress-' + seq;
        const stream = {
            roundId,
            groupId,
            agentId: 'compress',
            agentName: '摘要器',
            agentColor: '',
            modelAccount: (resolved.account && resolved.account.name) || '',
            modelName: resolved.label || '',
            content: '',
            thinking: '',
            startedAt: Date.now(),
            firstActivityAt: 0,
            firstTokenMs: 0,
            statusCode: 0,
            finished: false,
            timeout: false,
            timedOutBy: '',
            statusNote: '正在生成共享摘要…',
            error: '',
            chair: false,
            noPrivate: true,
            groupBlock: null,
            contract: null,
            timers: {first: null, total: null},
            // 自动重试上下文：ai-error.retryable 时按原 roundId 续发（见 retryGroupSpeechStream）
            profileCfg: resolved.profileCfg,
            apiMessages: messages,
            tools: [],
            retryMax: aiClampInt(config && config.retryMax, 0, 10, 5),
        };
        stream.done = new Promise((resolve) => {
            stream.resolve = resolve;
        });
        streams.set(roundId, stream);
        stream.timers.first = setTimeout(() => fireTimeout(stream, 'first'), g.meta.timeouts.chairMs || 60000);
        stream.timers.total = setTimeout(() => fireTimeout(stream, 'total'), g.meta.timeouts.chairThinkingMs || 240000);
        notify();
        try {
            const sendResult = backend.AISendChat(roundId, resolved.profileCfg, messages, [], aiClampInt(config && config.retryMax, 0, 10, 5));
            Promise.resolve(sendResult).catch((e) => failStream(stream, (e && e.message) || String(e)));
        } catch (e) {
            failStream(stream, (e && e.message) || String(e));
            return {ok: false, error: '摘要调用失败：' + ((e && e.message) || e)};
        }
        const result = await stream.done;
        if (result.status !== 'done' || !result.content) {
            return {ok: false, error: result.error || '摘要生成失败'};
        }
        await saveMeta(groupId, (meta) => {
            meta.sharedSummary = {
                text: result.content,
                cutoffGid: cutoff,
                createdAt: Date.now(),
                createdBy: 'user',
                summarizerModel: resolved.label || '',
            };
        });
        await appendSystemEvent(groupId, {
            type: 'compress',
            text: `群聊数据已压缩：摘要覆盖 ${covered.length} 条历史消息，最近 ${keepRounds} 轮全文保留；原始日志未删除`,
        });
        return {ok: true};
    }

    // ---------- 任务板与纪要（G4，§1.2 / §3.8） ----------

    // 任务板增改（任务模式抽屉）：状态流转 / 负责人改派；变更落盘并记系统事件
    async function updateActionItem(groupId, itemId, patch) {
        const g = groups.get(groupId);
        if (!g) return {ok: false, error: '群聊不存在'};
        const item = (g.meta.discussion.actionItems || []).find((x) => x && x.id === itemId);
        if (!item) return {ok: false, error: '任务不存在'};
        const changes = [];
        await saveMeta(groupId, (meta) => {
            const target = (meta.discussion.actionItems || []).find((x) => x && x.id === itemId);
            if (!target) return;
            if (patch.status && ['todo', 'doing', 'done', 'blocked'].includes(patch.status) && patch.status !== target.status) {
                target.status = patch.status;
                changes.push(`状态 → ${patch.status}`);
            }
            const owner = String(patch.ownerId == null ? '' : patch.ownerId).trim().slice(0, 60);
            if (owner && owner !== target.ownerId) {
                target.ownerId = owner;
                changes.push(`负责人 → ${owner}`);
            }
            const title = String(patch.title == null ? '' : patch.title).trim().slice(0, 200);
            if (title && title !== target.title) {
                target.title = title;
                changes.push('标题已更新');
            }
        });
        if (changes.length) {
            await appendSystemEvent(groupId, {type: 'task-update', text: `任务「${item.title}」：${changes.join('，')}`});
        }
        return {ok: true};
    }

    async function addActionItem(groupId, title, ownerId) {
        const g = groups.get(groupId);
        if (!g) return {ok: false, error: '群聊不存在'};
        const clean = String(title || '').trim().slice(0, 200);
        if (!clean) return {ok: false, error: '任务标题为空'};
        const item = {
            id: 't' + aiNowId(''),
            title: clean,
            ownerId: String(ownerId || '').trim().slice(0, 60),
            status: 'todo',
        };
        await saveMeta(groupId, (meta) => {
            meta.discussion.actionItems.push(item);
        });
        await appendSystemEvent(groupId, {type: 'task-update', text: `新增任务「${clean}」`});
        return {ok: true, item};
    }

    // 纪要润色（§3.8 主持人润色，1 次调用）：契约.minutes 优先，失败保留现有纪要
    async function polishMinutes(groupId) {
        const g = groups.get(groupId);
        if (!g) return {ok: false, error: '群聊不存在'};
        if (!g.meta.minutes) return {ok: false, error: '还没有本场纪要'};
        if (!g.meta.chair || g.meta.chair.kind === 'user') {
            return {ok: false, error: '用户主持模式没有主持人模型可润色，导出现有纪要即可'};
        }
        const chair = await chairTurn(groupId, 'minutes');
        if (chair.ok && chair.contract && chair.contract.minutes) {
            await generateMinutes(groupId, {minutesText: chair.contract.minutes, source: 'polish', modelName: '主持人'});
            return {ok: true, source: 'polish'};
        }
        if (chair.overflow) {
            return {ok: false, error: '主持人的上下文装不下全部群聊对话，无法润色；可先压缩群聊数据'};
        }
        return {ok: false, error: chair.error || '润色失败，保留现有纪要'};
    }

    // 纪要导出 Markdown（SaveFileDialog + SaveFile）
    async function exportMinutes(groupId) {
        const g = groups.get(groupId);
        if (!g || !g.meta.minutes) return {ok: false, error: '还没有本场纪要'};
        if (typeof backend.SaveFileDialog !== 'function' || typeof backend.SaveFile !== 'function') {
            return {ok: false, error: '当前环境不支持保存文件'};
        }
        try {
            const path = await backend.SaveFileDialog(g.meta.title || '群聊纪要');
            if (!path) return {ok: false, canceled: true};
            await backend.SaveFile(path, g.meta.minutes.text || '', 'lf', false, 'utf-8');
            return {ok: true, path};
        } catch (e) {
            return {ok: false, error: (e && e.message) || String(e)};
        }
    }

    // 纪要带回当前 AI 会话（走会话信箱，出现投递卡）
    async function bringMinutesBack(groupId) {
        const g = groups.get(groupId);
        if (!g || !g.meta.minutes) return {ok: false, error: '还没有本场纪要'};
        if (!deliverToSessions) return {ok: false, error: '会话信箱不可用'};
        const sessionId = getCurrentSessionId();
        if (!sessionId) return {ok: false, error: '没有打开的 AI 会话；先开一个会话再带回'};
        const text = '【群聊纪要 · ' + (g.meta.title || '未命名群聊') + '】\n\n' + g.meta.minutes.text;
        const out = await deliverToSessions([sessionId], text, {byUser: true});
        const first = out && Array.isArray(out.results) ? out.results[0] : null;
        if (first && first.ok) return {ok: true};
        return {ok: false, error: (first && first.reason) || '投递失败'};
    }

    return {
        init,
        refreshList,
        setListMode,
        getListMode: () => listMode,
        groupList,
        groupById: (id) => groups.get(id) || null,
        openGroup,
        createGroup,
        deleteGroup,
        saveMeta,
        subscribe,
        handleEvent,
        speak,
        sendUserMessage,
        stopAll,
        stopOne,
        activeStreamOf,
        // 讨论引擎（G3）
        startDiscussion,
        pauseDiscussion,
        resumeDiscussion,
        endDiscussion,
        discussionSnapshot,
        // 接力引擎（G7）
        startRelay,
        pauseRelay,
        resumeRelay,
        endRelay,
        relaySnapshot,
        compressShared,
        // 任务板与纪要（G4）
        updateActionItem,
        addActionItem,
        polishMinutes,
        exportMinutes,
        bringMinutesBack,
        store,
    };
}
