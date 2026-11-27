// AI 会话磁盘存储：JSONL 事件日志（唯一真源）+ 每会话 meta.json。
// 纯编解码/重放与磁盘适配放在一起，但代码只依赖注入的 backend，不碰 DOM。

// ai-session-store 依赖注入式纯编解码模块，但 worktree 归一与 ai-panel 共用单一来源
//（ai-worktree.js 只 import ai-constants，无环）。
import {normalizeWorktreeState} from '../tools/ai-worktree.js';
import {normalizeActivePlan} from '../core/ai-plan-file.js';

export const AI_SESSION_SCHEMA = 1;

const IMAGE_EXT = {
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/png': 'png',
};

// 会话视频落盘的扩展名表（Go AISessionSaveVideo / VideoPath 只认这个白名单）
const VIDEO_EXT = {
    'video/mp4': 'mp4',
};

export function textOf(value) {
    return typeof value === 'string' ? value : (value == null ? '' : String(value));
}

// 机械提醒注入块（给模型看的，不渲染）：silent 标记是后来才加的，修复前的历史会话
// 里没有这个字段——按内容前缀识别，加载回填时照常隐藏。新注入块的判定不依赖这里。
// 两种形态都要认：裸 <task_todos_check>（旧）与 <system-reminder> 包裹的宿主块（新）。
export function isSilentInjection(content) {
    const text = textOf(content).trim();
    return /^<task_todos_check>/.test(text) ||
        /^<system-reminder>\s*<task_todos_check>/.test(text);
}

export function safeImageName(image) {
    const id = textOf(image && image.id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'img';
    const ext = IMAGE_EXT[textOf(image && image.mime)] || 'png';
    return id + '.' + ext;
}

export function safeVideoName(video) {
    const id = textOf(video && video.id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'vid';
    const ext = VIDEO_EXT[textOf(video && video.mime)] || 'mp4';
    return id + '.' + ext;
}

export function metaSignature(meta) {
    return JSON.stringify(Object.assign({}, meta, {updatedAt: 0}));
}

// 消息指纹：追加式日志只按 _mid 比对公共前缀，消息落盘后被就地改写（工具 running→done、
// 审批 pending→approved、子代理/后台作业收敛…）不会触发重写，重启重放就会读到旧状态
// ——最典型的表现是工具明明执行成功，重启后却成了「执行被中断」。
// 这里只对会被就地改写的字段取轻量指纹（不序列化正文，工具轮次里每轮都要算），
// 持久化时发现指纹变了就从该消息处截断重写。
export function messageFingerprint(message) {
    if (!message || typeof message !== 'object') return '';
    const approval = message.approval && typeof message.approval === 'object' ? message.approval : null;
    const ask = message.ask && typeof message.ask === 'object' ? message.ask : null;
    const envAsk = message.envAsk && typeof message.envAsk === 'object' ? message.envAsk : null;
    const agent = message.agent && typeof message.agent === 'object' ? message.agent : null;
    const bg = message.bg && typeof message.bg === 'object' ? message.bg : null;
    return [
        textOf(message.role),
        textOf(message.status),
        message.interrupted === true ? 1 : 0,
        textOf(message.content).length,
        textOf(message.error).length,
        approval ? textOf(approval.state) + ':' + textOf(approval.source) + ':' + textOf(approval.remember) : '',
        ask ? textOf(ask.state) + ':' + textOf(ask.source) + ':' + textOf(ask.answer).length : '',
        envAsk ? textOf(envAsk.state) : '',
        agent ? textOf(agent.state) + ':' + (Number(agent.rounds) || 0) + ':' + textOf(agent.summary).length : '',
        bg ? textOf(bg.state) + ':' + (bg.code == null ? '' : Number(bg.code)) : '',
        Array.isArray(message.images) ? message.images.length : 0,
        Array.isArray(message.videos) ? message.videos.length : 0,
        // 思考循环守卫的状态在流中被就地改写（warned→pending→continued/stopped）：
        // 不进指纹会被「指纹没变」挡在就地截断之外，重启重放又会回到 pending。
        message.guard ? textOf(message.guard.state) + ':' + textOf(message.guard.action) + ':' + textOf(message.guard.source) : '',
        Number(message.turnMs) || 0,
        Number(message.modelMs) || 0,
        Number(message.firstTokenMs) || 0,
        Number(message.statusCode) || 0,
        Number(message.thinkMs) || 0,
        Number(message.finishedAt) || 0,
        textOf(message.truncated),
        textOf(message.finishReason),
    ].join('|');
}

// 「用户发起回合」的边界消息：会话列表的排序键与时间文案只认它。
// 回合进行中注入的 user 消息不是新回合——轮次提醒 / 待办检查 / 模型切换留痕（systemNote、
// silent），以及工具中途自动附加的截图（带 app + images 但没有 turnStartedAt）。
// 消息渲染的回合分组（groupTurns）、轮次耗时起点（ai-panel.js turnStartAt）与编辑重发锚点
// 用同一个判定，不会出现「分组算一轮、列表跳两次」。
export function isTurnBoundaryMessage(message) {
    if (!message || message.role !== 'user') return false;
    if (message.systemNote) return false;
    // 插话（steer）是本轮补充指示，不是用户发起的新回合：分组 / 列表排序键 / 渲染窗口
    // 都沿用原回合起点（与 ai-panel.js 的 turnStartAt / 瘦身轮次口径一致）。
    if (message.steer) return false;
    // 信箱注入（子代理结算 / 后台作业与终端退出 / 会话投递折叠成的 user 消息，带 notice）
    // 恒出现在轮中间：它有 turnStartedAt（通知到达时刻），若被当成回合起点，这一轮的耗时
    // 就从通知那一刻起算（实测只剩十几秒），列表时间也会跳到通知时刻而不是用户发问时刻。
    // 与 ai-context-slim.js 的轮次切分口径一致。
    if (message.notice) return false;
    if (message.app && Array.isArray(message.images) && message.images.length && !message.turnStartedAt) return false;
    // read_video 自动附加的视频消息与 read_image 同口径：不是用户发起的回合
    if (message.app && Array.isArray(message.videos) && message.videos.length && !message.turnStartedAt) return false;
    return true;
}

// 用量统计的单一累加核（纯函数，无 DOM / 无后端）：sessionUsageTotals 逐条累加当前消息、
// 归档累加器逐条累加被裁剪消息，两边共用同一口径，避免「统计行一套、累加器一套」漂移。
// 放在本模块（isTurnBoundaryMessage 的所在地）以避免与 ai-usage-ui.js / ai-compact.js 循环依赖。
// acc 是裸累加对象（含 TPS 采样的中间量），原地累加并返回；MIN_TPS_WINDOW_MS 与 ai-usage-ui.js
// 的同名常量必须一致（有接线测试锁定）。
export const USAGE_TPS_MIN_WINDOW_MS = 200;

export function emptyUsageAcc() {
    return {
        rounds: 0, steps: 0, prompt: 0, completion: 0, total: 0, cached: 0,
        turnMs: 0, modelMs: 0, toolMs: 0, hasTools: false,
        genMs: 0, genCompletion: 0, e2eMs: 0, e2eCompletion: 0,
        ttftMs: 0, ttftCount: 0,
    };
}

export function accumulateUsage(acc, message) {
    if (!message) return acc;
    if (isTurnBoundaryMessage(message)) acc.rounds += 1;
    if (message.role === 'tool') {
        acc.hasTools = true;
        return acc;
    }
    if (message.role !== 'assistant') return acc;
    acc.steps += 1;
    let messageCompletion = 0;
    const usage = message.usage;
    if (usage) {
        const p = Number(usage.promptTokens) || 0;
        const c = Number(usage.completionTokens) || 0;
        acc.prompt += p;
        acc.completion += c;
        messageCompletion = c;
        acc.total += Number(usage.totalTokens) || (p + c);
        acc.cached += Number(usage.cachedTokens) || 0;
    }
    const messageModelMs = Number(message.modelMs) || 0;
    acc.modelMs += messageModelMs;
    acc.toolMs += Number(message.toolMs) || 0;
    acc.turnMs += Number(message.turnMs) || 0;
    const firstTokenMs = Number(message.firstTokenMs) || 0;
    if (firstTokenMs > 0) {
        acc.ttftMs += firstTokenMs;
        acc.ttftCount += 1;
    }
    // TPS 分子分母同源：分母只用 modelMs − TTFT；短窗口退化为端到端吞吐计权。
    if (usage && messageCompletion > 0 && messageModelMs > 0) {
        const windowMs = Math.max(0, messageModelMs - firstTokenMs);
        if (windowMs >= USAGE_TPS_MIN_WINDOW_MS) {
            acc.genMs += windowMs;
            acc.genCompletion += messageCompletion;
        } else {
            acc.e2eMs += messageModelMs;
            acc.e2eCompletion += messageCompletion;
        }
    }
    return acc;
}

// 归档用量累加器：压缩后归档消息会被 vacuum 搬进 sidecar、离开内存，统计行若只累加
// session.archived + session.messages 就会「压缩一次总量掉一截」（用户 2026-11-27 反馈）。
// 累加器存完整累加快照（含耗时 / TPS 采样），随会话 meta 持久化；统计行把它与当前消息的
// 累加结果合并，于是无论归档是否还在内存、是否跨重启，总量与耗时都不回退。
export function addArchivedUsage(acc, messages) {
    const out = normalizeArchivedUsage(acc) || emptyUsageAcc();
    for (const message of Array.isArray(messages) ? messages : []) accumulateUsage(out, message);
    return out;
}

// 读回归一：meta 里的累加器字段逐项钳到非负有限数；全空对象视为无累加器（兼容半写入脏 meta，
// 否则 {} 会被当成「有效累加器」吞掉仍在内存的归档，历史静默归零）。
export function normalizeArchivedUsage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const num = (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    const out = emptyUsageAcc();
    const keys = ['rounds', 'steps', 'prompt', 'completion', 'total', 'cached',
        'turnMs', 'modelMs', 'toolMs', 'genMs', 'genCompletion', 'e2eMs', 'e2eCompletion', 'ttftMs', 'ttftCount'];
    out.hasTools = raw.hasTools === true;
    let any = out.hasTools;
    for (const key of keys) {
        out[key] = num(raw[key]);
        if (out[key] > 0) any = true;
    }
    return any ? out : null;
}

// 轮次起点：最后一条边界消息的时间（0 = 正文里没有用户发起的回合）。
export function sessionTurnStartTs(session) {
    const messages = (session && session.messages) || [];
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (!isTurnBoundaryMessage(message)) continue;
        return Number(message.turnStartedAt) || Number(message.ts) || 0;
    }
    return 0;
}

// 最近一轮的「结束时间」（列表排序与时间文案的键，opencode 口径）：最后一条已收尾
// assistant 消息的 finishedAt。finishStream 在轮末写入 finishedAt，运行中 / 流式回复
// 没有它——所以工具结果、流式输出不会让会话在列表里跳动（保住 CHANGELOG 里修过的
// 「工具刷屏顶列表」问题），只有一轮真正结束才推进。没有已收尾回复的老会话返回 0，
// 由 sessionActivityTs 回落到轮次起点。
export function sessionEndTs(session) {
    const messages = (session && session.messages) || [];
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (!message || message.role !== 'assistant') continue;
        if (message.status === 'streaming') continue;
        const finished = Number(message.finishedAt) || 0;
        if (finished) return finished;
    }
    return 0;
}

// 列表排序/时间文案的键（单一来源，opencode 口径）：取「最近一轮结束时间」与
// 「最近发问时间」的较大者。一轮里工具结果 / 流式输出都不推进这两个值，所以运行中
// 会话不会在列表里跳动；用户发新一轮时按发问时刻前移，本轮结束时按 finishedAt 再前移。
// 没有已收尾回复的老会话 endTs=0，自然回落到发问时间；两者都没有再回落到写入时间。
// 占位会话只有 meta，读缓存的 endTs / turnTs；已载体的现算，两者同源，补水前后不跳位。
export function sessionActivityTs(session) {
    if (!session) return 0;
    if (session._stub) {
        return Math.max(Number(session._endTs) || 0, Number(session._turnTs) || 0) ||
            Number(session.updatedAt) || Number(session.createdAt) || 0;
    }
    return Math.max(sessionEndTs(session), sessionTurnStartTs(session)) ||
        Number(session.updatedAt) || Number(session.createdAt) || 0;
}

// ---------- 事件编码 ----------

export function encodeSessionHeader(session) {
    return {
        v: AI_SESSION_SCHEMA,
        t: 'header',
        id: textOf(session && session.id),
        title: textOf(session && session.title),
        createdAt: Number(session && session.createdAt) || 0,
        workspace: textOf(session && session.workspace),
    };
}

// 事件里不保存 base64：图片已落 images/ 时只留 file 引用。
// 只有在落盘失败、没有 file 引用时才退回内嵌 data，宁可撑大也不丢图。
export function serializeSessionMessage(message) {
    if (!message || typeof message !== 'object') return null;
    const out = {};
    for (const key of Object.keys(message)) {
        if (key === '_mid' || key === '_stored' || key.startsWith('_')) continue;
        if (key === 'images' || key === 'videos') continue;
        out[key] = message[key];
    }
    if (Array.isArray(message.images)) {
        out.images = message.images
            .filter((image) => image && typeof image === 'object')
            .map((image) => {
                const copy = {};
                for (const key of Object.keys(image)) {
                    if (key === 'data' && image.file) continue;
                    copy[key] = image[key];
                }
                return copy;
            });
    }
    if (Array.isArray(message.videos)) {
        out.videos = message.videos
            .filter((video) => video && typeof video === 'object')
            .map((video) => {
                const copy = {};
                for (const key of Object.keys(video)) {
                    if (key === 'data' && video.file) continue;
                    copy[key] = video[key];
                }
                return copy;
            });
    }
    return out;
}

export function encodeMessageEvent(message, mid, archived) {
    const payload = serializeSessionMessage(message);
    if (!payload || !mid) return null;
    const event = {v: AI_SESSION_SCHEMA, t: 'msg', mid, m: payload};
    if (archived) event.a = 1;
    return event;
}

export function encodeTruncateEvent(keep) {
    return {v: AI_SESSION_SCHEMA, t: 'truncate', keep: Math.max(0, Number(keep) || 0)};
}

export function encodeArchiveEvent(keep, summary) {
    return {
        v: AI_SESSION_SCHEMA,
        t: 'archive',
        keep: Math.max(0, Number(keep) || 0),
        summary: summary && typeof summary === 'object' ? summary : null,
    };
}

export function encodeResetEvent() {
    return {v: AI_SESSION_SCHEMA, t: 'reset'};
}

export function encodeMetaEvent(patch) {
    return {v: AI_SESSION_SCHEMA, t: 'meta', patch: patch && typeof patch === 'object' ? patch : {}};
}

// ── 审计事件（S5）：事件粒度从「消息」下探到「回合 / 工具 / 审批 / 子代理」──────────
//
// 为什么用独立事件而不是塞进 message payload：塞进 payload 的话，「这一轮到底崩了没有」
// 「这个工具最终谁放行的」都要先解消息结构、再按 status 猜，外部插件与审计工具无法消费。
// 独立事件是**注解型**：它们不参与 UI 渲染（UI 仍由 msgs 派生），只供「聚合查询」用，
// 因此 vacuum 整理时允许它们失去与消息的交错顺序（见 internal/sessionstore/vacuum.go）。
//
// 形状约定：每条都带 `id`（回合 id / callId / agentId），缺 id 视为无效事件返回 null——
// 与 encodeMessageEvent 同口径，宁可不写也不要写一条无法关联的孤儿事件。
// 版本落后方（旧版应用）读到这些类型会计 issue 并跳过，不影响正文重放。

/** 审计事件类型全集（前端重放、Go 真空整理、测试三处共用这一份口径）。 */
export const SESSION_AUDIT_EVENT_TYPES = Object.freeze(['turn', 'tool', 'approval', 'agent']);

// 事件溯源的核心不变量：一条事件一旦编码就不可再变（Cordis「一切状态 append 且深冻结」）。
// 冻结只作用于内存对象，不改变 JSON 落盘格式，因此 Go 侧 vacuum / parity 无需同批修改。
// 事件本身是扁平标量结构，递归冻结只为将来加嵌套字段时仍成立。
function deepFreezeEvent(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreezeEvent(child);
    return Object.freeze(value);
}

function auditId(value) {
    return textOf(value).trim();
}

/** 回合事件：phase=start 起轮，phase=close 收尾（reason 记录 done / stop / error / crash）。 */
export function encodeTurnEvent(turnId, phase, reason) {
    const id = auditId(turnId);
    if (!id) return null;
    const event = {v: AI_SESSION_SCHEMA, t: 'turn', id, phase: phase === 'close' ? 'close' : 'start'};
    const why = textOf(reason).trim();
    if (why) event.reason = why.slice(0, 32);
    return deepFreezeEvent(event);
}

/** 工具事件：phase=start / end，end 带 ok。 */
export function encodeToolEvent(callId, name, phase, ok) {
    const id = auditId(callId);
    if (!id) return null;
    const event = {v: AI_SESSION_SCHEMA, t: 'tool', id, phase: phase === 'end' ? 'end' : 'start'};
    const toolName = textOf(name).trim();
    if (toolName) event.name = toolName.slice(0, 64);
    if (phase === 'end') event.ok = ok !== false;
    return deepFreezeEvent(event);
}

/** 审批事件：verdict = allow / deny / auto（分类器自动放行）。 */
export function encodeApprovalEvent(callId, verdict, tool) {
    const id = auditId(callId);
    if (!id) return null;
    const event = {v: AI_SESSION_SCHEMA, t: 'approval', id, verdict: textOf(verdict).trim() || 'allow'};
    const toolName = textOf(tool).trim();
    if (toolName) event.tool = toolName.slice(0, 64);
    return deepFreezeEvent(event);
}

/** 子代理事件：phase = spawn / done / stopped。 */
export function encodeAgentEvent(agentId, phase, state) {
    const id = auditId(agentId);
    if (!id) return null;
    const event = {v: AI_SESSION_SCHEMA, t: 'agent', id, phase: textOf(phase).trim() || 'spawn'};
    const value = textOf(state).trim();
    if (value) event.state = value.slice(0, 24);
    return deepFreezeEvent(event);
}

export function encodeSessionLines(events) {
    if (!Array.isArray(events) || !events.length) return '';
    const lines = [];
    for (const event of events) {
        if (!event) continue;
        try {
            lines.push(JSON.stringify(event));
        } catch (e) {}
    }
    return lines.length ? lines.join('\n') + '\n' : '';
}

// ---------- 重放 ----------

// 载入自愈：同一 mid 只许一条消息持有，重复者改配新 mid（newMidFn 注入，保持本模块纯函数）。
// 历史 mid 键指纹表下，重复 mid 会让 persist 公共前缀在首条上永假，每次落盘都 truncate +
// 整段重追加（2026-11-28 事故：一个会话 300 MB，其中九成是复印）。返回改配数量，0 = 无重复。
// 消息一条不丢，只动后出现者的 _mid；先到先得，与「重放按位置追加」的口径一致。
export function dedupeMessageMids(messages, newMidFn) {
    if (!Array.isArray(messages)) return 0;
    const seen = new Set();
    let healed = 0;
    for (const message of messages) {
        if (!message || typeof message !== 'object') continue;
        const mid = textOf(message._mid);
        if (!mid || seen.has(mid)) {
            message._mid = typeof newMidFn === 'function' ? newMidFn() : mid + '-dup' + (++healed);
            healed++;
        }
        seen.add(textOf(message._mid));
    }
    return healed;
}

export function replaySessionLog(text) {
    const result = {
        header: null,
        messages: [],
        archived: [],
        summary: null,
        meta: {},
        issues: 0,
        torn: false,
        droppedTransient: 0,
        // 审计事件（S5）：按类型分桶保留，供「这一轮崩没崩」「这个工具谁放行的」这类
        // 聚合查询使用。它们不参与消息渲染，也不影响 truncate / archive 的 keep 语义。
        audit: {turns: [], tools: [], approvals: [], agents: []},
    };
    const raw = textOf(text);
    if (!raw) return result;
    const lines = raw.split('\n');
    if (!raw.endsWith('\n')) {
        // 没有换行结尾的尾行视为未提交；append 前也会把它截掉，保持读写一致。
        result.torn = true;
        lines.pop();
    } else {
        lines.pop();
    }
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event = null;
        try {
            event = JSON.parse(trimmed);
        } catch (e) {
            result.issues++;
            continue;
        }
        if (!event || typeof event !== 'object') {
            result.issues++;
            continue;
        }
        if (Number(event.v) > AI_SESSION_SCHEMA) {
            result.issues++;
            continue;
        }
        switch (event.t) {
            case 'header':
                result.header = event;
                break;
            case 'msg': {
                if (!event.m || typeof event.m !== 'object') {
                    result.issues++;
                    break;
                }
                const message = Object.assign({}, event.m, {_mid: textOf(event.mid)});
                (event.a ? result.archived : result.messages).push(message);
                break;
            }
            case 'truncate': {
                const keep = Math.max(0, Math.min(result.messages.length, Number(event.keep) || 0));
                result.messages = result.messages.slice(0, keep);
                break;
            }
            case 'archive': {
                const keep = Math.max(0, Math.min(result.messages.length, Number(event.keep) || 0));
                const moved = result.messages.slice(0, keep);
                result.messages = result.messages.slice(keep);
                result.archived = result.archived.concat(moved);
                if (event.summary && typeof event.summary === 'object') result.summary = event.summary;
                break;
            }
            case 'reset':
                result.messages = [];
                result.archived = [];
                result.summary = null;
                break;
            case 'meta': {
                const patch = event.patch && typeof event.patch === 'object' ? event.patch : {};
                Object.assign(result.meta, patch);
                if (Object.prototype.hasOwnProperty.call(patch, 'summary')) {
                    result.summary = patch.summary && typeof patch.summary === 'object' ? patch.summary : null;
                }
                break;
            }
            case 'turn':
            case 'tool':
            case 'approval':
            case 'agent': {
                const id = textOf(event.id).trim();
                if (!id) {
                    result.issues++;
                    break;
                }
                const bucket = event.t === 'turn' ? result.audit.turns
                    : event.t === 'tool' ? result.audit.tools
                        : event.t === 'approval' ? result.audit.approvals
                            : result.audit.agents;
                bucket.push(event);
                break;
            }
            default:
                result.issues++;
                break;
        }
    }
    // 同类 dedupeKey 的机械注入只保留最新一条（口径与 buildApiMessages 发送侧一致：
    // 同 key 旧条目本就不会发给模型，读盘再留着纯属冗余）。节流失效期（2026-11-19
    // 修复前）每批工具都重插一条 <task_todos_check>，单会话落盘过 339 条——这里统一
    // 折叠掉，丢弃数交给加载方置 _needsRewrite，下次持久化整份重写把磁盘也清掉。
    // 必须在事件重放完成后做：truncate 的 keep 语义基于完整重放序列，中途剔除会错位。
    // archived 不动：已离开上下文，重写收益小。
    const lastByKey = new Map();
    for (let i = 0; i < result.messages.length; i++) {
        const key = textOf(result.messages[i] && result.messages[i].dedupeKey);
        if (key) lastByKey.set(key, i);
    }
    if (lastByKey.size) {
        const kept = [];
        for (let i = 0; i < result.messages.length; i++) {
            const message = result.messages[i];
            const key = textOf(message && message.dedupeKey);
            if (key && lastByKey.get(key) !== i) {
                result.droppedTransient++;
                continue;
            }
            kept.push(message);
        }
        if (result.droppedTransient) result.messages = kept;
    }
    return result;
}

// interruptedTurnIds：找出「有 start 没 close」的回合 id（S5）。
//
// 用途是崩溃尾部闭合：进程被杀 / 关窗时来不及写 close，下次载入由调用方据此补一条
// `turn/close reason=crash`——这样日志本身就能回答「这一轮是正常结束还是崩的」，
// 而不是只能靠「消息 status 还是 running」去猜。正常结束的回合在收尾时已写过 close，
// 这里自然返回空数组。
//
// 口径：按出现顺序配对，同一 id 后一次 start 视为新一轮（清掉旧的未闭合态）；
// 重复 close 幂等。没有 id 的事件在重放阶段已计 issue，不会进 audit。
export function interruptedTurnIds(replay) {
    const turns = (replay && replay.audit && Array.isArray(replay.audit.turns)) ? replay.audit.turns : [];
    const open = new Set();
    for (const event of turns) {
        const id = textOf(event && event.id).trim();
        if (!id) continue;
        if (event.phase === 'close') open.delete(id);
        else open.add(id);
    }
    return [...open];
}

// 会话自定义分组名归一：trim + 上限截断，空/脏值一律归 ''（= 未分组）。
// 与 normalizeSession（读回）和 buildSessionMeta（写盘）共用单一口径，避免两处判定漂移。
export const AI_SESSION_GROUP_MAX = 24;
// 编排归属（会话 → 批次）：只存稳定的业务字段；执行票据 executionToken 绝不落盘，
// 只活在当前进程内存里，重启后旧票据作废由 supervisor 按 stalled 重派。
export function normalizeSessionOrchestration(value) {
    const raw = value && typeof value === 'object' ? value : null;
    if (!raw) return null;
    const id = textOf(raw.id).trim();
    const role = textOf(raw.role).trim();
    if (!id || !['work', 'review', 'arbiter'].includes(role)) return null;
    return {
        id,
        batchId: textOf(raw.batchId).trim(),
        attempt: Math.max(0, Number(raw.attempt) || 0),
        role,
        parentSessionId: textOf(raw.parentSessionId).trim(),
        generation: Math.max(0, Number(raw.generation) || 0),
        owns: Array.isArray(raw.owns) ? raw.owns.filter((p) => typeof p === 'string' && p).slice(0, 64) : [],
    };
}

export function normalizeSessionGroup(value) {
    return textOf(value).trim().slice(0, AI_SESSION_GROUP_MAX);
}

// 模型指定分组名 → 实际采用的分组名：先按 normalizeSessionGroup 归一（trim + 24 字上限），
// 再与既有分组比对「去所有空白 + 小写」的键，命中就复用既有原样名字——防止模型拼出
// 「前端 / 前端  / 前端 项目」这类近义分组把列表切碎。空值 / 纯空白归 ''（移出分组）。
// existingNames 是同一工作区已有的非空分组名数组（顺序即优先级，取第一个命中项）。
export function resolveSessionGroupName(requested, existingNames) {
    const wanted = normalizeSessionGroup(requested);
    if (!wanted) return '';
    const key = wanted.replace(/\s+/g, '').toLowerCase();
    for (const name of Array.isArray(existingNames) ? existingNames : []) {
        const existing = normalizeSessionGroup(name);
        if (existing && existing.replace(/\s+/g, '').toLowerCase() === key) return existing;
    }
    return wanted;
}

export function buildSessionMeta(session) {
    const summary = session && session.summary && typeof session.summary === 'object' ? session.summary : null;
    return {
        v: AI_SESSION_SCHEMA,
        id: textOf(session && session.id),
        title: textOf(session && session.title),
        createdAt: Number(session && session.createdAt) || 0,
        updatedAt: Number(session && session.updatedAt) || 0,
        // 轮次起点（列表排序与时间文案的键）：占位沿用缓存值，已载体的现算——和 messageCount 同理，
        // 占位不能把现算出来的 0 写回 meta.json。
        turnTs: session && session._stub
            ? Math.max(0, Number(session._turnTs) || 0)
            : sessionTurnStartTs(session),
        // 最近一轮结束时间（列表排序键，opencode 口径）：占位沿用缓存值，已载体的现算。
        // 老 meta 没有这个字段时读成 0，sessionActivityTs 会回落到 turnTs。
        endTs: session && session._stub
            ? Math.max(0, Number(session._endTs) || 0)
            : sessionEndTs(session),
        workspace: textOf(session && session.workspace),
        scope: ['read', 'edit', 'auto', 'full'].includes(session && session.scope) ? session.scope : 'read',
        // 临时会话：磁盘只作留档，启动加载据它把这些会话滤掉（见 ai-session-disk 的 keepMeta）。
        // 只认严格 true——与 isTransientSession 同一口径，脏值不能把普通会话变成一次性的。
        temp: (session && session.temp) === true,
        // 无工作区会话：持久保留、不绑工作区。读盘不过滤（与 temp 的区别）。
        noWorkspace: (session && session.noWorkspace) === true,
        profileId: textOf(session && session.profileId),
        modelId: textOf(session && session.modelId),
        // 本次会话上下文上限（模型选择器档位，0 = 不设限；随会话持久化，子代理派生时继承）
        ctxLimit: Number(session && session.ctxLimit) || 0,
        systemPrompt: textOf(session && session.systemPrompt),
        promptTemplateId: textOf(session && session.promptTemplateId),
        planMode: !!(session && session.planMode),
        // 会话级桌面控制启用状态（随会话持久化；控制模式本身仍只存内存，重启即清）
        desktopEnabled: (session && session.desktopEnabled) === true,
        // 当前计划（唯一真源）：{title, goal, files, steps, verification, risks, markdown,
        // status:'pending'|'approved', ts, fileRel}。审批卡 / 落盘 / 回注 / 列表角标都读它，
        // 消息不承载计划内容。空计划归一成 null，不写空壳。
        activePlan: normalizeActivePlan(session && session.activePlan),
        // 子代理运行态快照（S6）：跨进程续跑的唯一依据。写侧已归一 + 截断（ai-agent-resume），
        // 这里只做形状兜底，空数组不写字段（旧会话保持字节不变）。
        ...(Array.isArray(session && session.agentRuns) && session.agentRuns.length
            ? {agentRuns: session.agentRuns}
            : {}),
        browserTabId: textOf(session && session.browserTabId),
        // 用户交给 AI 的标签（禁止 AI 关闭）：与 browserTabId 一起持久化
        browserTabAdopted: (session && session.browserTabAdopted) === true,
        round: Number(session && session.round) || 0,
        archivedAt: Number(session && session.archivedAt) || 0,
        pinned: !!(session && session.pinned),
        // 会话自定义分组（工作区内归类）：随 meta 持久化，与 normalizeSession 同一归一口径
        group: normalizeSessionGroup(session && session.group),
        // 回合在飞标记：起轮置位、finishStream 清除。进程被外部强杀（重建脚本 / 任务管理器）
        // 时来不及走收尾，标记残留在 meta.json 里——下次读盘据此挂「回合中断」横幅，
        // 把「进程死了」与「用户自己停了」区分开（后者经 stopGeneration→finishStream，标记已清）。
        turnInFlight: (session && session.turnInFlight) === true,
        // 后台结束、用户尚未查看的会话：'' / 'done' / 'error'（列表右侧状态圆点用）
        unread: session && (session.unread === 'done' || session.unread === 'error') ? session.unread : '',
        // 懒加载占位（_stub）只有 meta、messages 是空数组：条数必须沿用缓存值，否则会把 0 写进
        // meta.json，下次启动整个列表都变「0 条消息」。已载体的会话一律现算。
        messageCount: session && session._stub
            ? Math.max(0, Number(session._msgCount) || 0)
            : (Array.isArray(session && session.messages) ? session.messages.length : 0),
        archivedCount: session && session._stub
            ? Math.max(0, Number(session._archivedCount) || 0)
            : (Array.isArray(session && session.archived) ? session.archived.length : 0),
        // 压缩归档的累计用量（只增不减）：统计行读它，归档出栈 / 重启后总量不回退。
        archivedUsage: normalizeArchivedUsage(session && session.archivedUsage),
        logFile: textOf(session && session.logFile),
        logSavedAt: Number(session && session.logSavedAt) || 0,
        todos: Array.isArray(session && session.todos) ? session.todos : [],
        // 本会话任务提醒（AI reminder_* 工具 / 面板弹层维护；跟随会话存储，会话删了提醒也没了）
        reminders: Array.isArray(session && session.reminders) ? session.reminders : [],
        changes: Array.isArray(session && session.changes) ? session.changes : [],
        approvedPaths: Array.isArray(session && session.approvedPaths) ? session.approvedPaths : [],
        // browser_evaluate 审批卡「本会话允许相同脚本」的指纹集合（随会话持久化，跨重启保留）
        browserScriptAllow: Array.isArray(session && session.browserScriptAllow)
            ? session.browserScriptAllow.filter((h) => typeof h === 'string' && h).slice(0, 200) : [],
        // 已批准的工作区外读根（读审批卡「本会话记住」；跨重启保留授权）
        readRoots: Array.isArray(session && session.readRoots) ? session.readRoots : [],
        // 支线对话：指向母会话 id（普通会话为空）。sideOf 不嵌套——创建时已扁平化到一层。
        sideOf: textOf(session && session.sideOf),
        // 编排归属：只落稳定元数据（票据在 session._orchestrationToken，不序列化）。
        orchestration: normalizeSessionOrchestration(session && session.orchestration),
        // OpenCode 稳定会话标识：随 meta 持久化，重启后沿用同一 ID（否则每次读盘都会重新生成）。
        opencodeSessionId: textOf(session && session.opencodeSessionId),
        // 隔离 worktree 会话态（唯一归属凭证；fork/支线/投递新建的会话没有该字段 → null，
        // 保证「一会话一 worktree」不被复制破坏）。恢复校验在 ai-worktree.js 的 blockFor。
        worktree: normalizeWorktreeState(session && session.worktree),
        summary,
    };
}
