// ai-compact.js：上下文压缩的应用内核（会话无关，主会话与子代理共用）。
// 从 ai-panel.js 的 `finishCompact` 逐字搬出「cutoff 计算 + summary 形状 + messages 裁剪」，
// 参数化后可被两处调用：
//   - 主会话：磁盘归档（sessionStore.archiveSession）、渲染、队列冲刷仍留在 panel；
//   - 子代理：只做内存裁剪，转录（subAgentTranscripts）是展示层、独立于 messages，
//     所以详情视图全程可看（展示与上下文分离）。
// 压缩请求的组装（system prompt + 转录）也在本模块，避免两处各写一份提示词。
import {aiTextOf} from '../core/ai-constants.js';

// 摘要里保留的尾部条数下限（压缩后至少留这么多条，保证「当前正在做什么」还在上下文里）
export const COMPACT_KEEP_TAIL = 6;
// 压缩后保留的尾部预算占「消息预算」的比例：与 deepseek-harness 的 retainRatio 对齐
// （0.16）。按 token 计而不是按条数计——6 条消息可能只有 2k token，也可能有 60k。
export const COMPACT_RETAIN_RATIO = 0.16;
// 压缩转录的硬上限（提示词输入，不随会话无界增长）
const TRANSCRIPT_MAX = 120000;

// 保留预算（tokens）：messageBudget = 窗口 − 输出预留，再取 retainRatio。
// 与 dsh 的 `retainTokens = floor(messageBudget * 0.16)` 同口径；窗口未知返回 0（回退按条数）。
export function compactRetainBudget(windowSize, reservedOutputTokens) {
    const window = Number(windowSize) || 0;
    if (!(window > 0)) return 0;
    // 输出预留最多占窗口一半：防止模型条目把 outputWindow 填成等于窗口时预算被清零
    const reserved = Math.max(0, Math.min(Number(reservedOutputTokens) || 0, window * 0.5));
    return Math.max(0, Math.floor((window - reserved) * COMPACT_RETAIN_RATIO));
}

// cutoff：保留最近 N 条，并**回退到最近的 user 轮边界**——一轮不能从 assistant / tool
// 中间切开，否则压缩后首条是工具结果，模型看不懂自己在干什么。
export function computeCompactCutoff(messages, keepTail) {
    const list = Array.isArray(messages) ? messages : [];
    const keep = Math.max(1, Number(keepTail) || COMPACT_KEEP_TAIL);
    let cutoff = Math.max(0, list.length - keep);
    while (cutoff > 0 && list[cutoff] && list[cutoff].role !== 'user') cutoff--;
    return cutoff;
}

// token 预算版 cutoff：从尾部按 estimate(message) 累加到预算为止，再回退到 user 轮边界。
// budgetTokens <= 0 或没给 estimate 时退回按条数（旧口径），保证调用方永远拿得到切点。
export function computeCompactCutoffByBudget(messages, budgetTokens, estimate, keepTail) {
    const list = Array.isArray(messages) ? messages : [];
    const budget = Number(budgetTokens) || 0;
    if (!(budget > 0) || typeof estimate !== 'function') {
        return computeCompactCutoff(list, keepTail);
    }
    let used = 0;
    let cut = 0;
    for (let i = list.length - 1; i >= 0; i--) {
        used += Math.max(0, Number(estimate(list[i])) || 0);
        if (used >= budget) {
            cut = i;
            break;
        }
    }
    while (cut > 0 && list[cut] && list[cut].role !== 'user') cut--;
    return cut;
}

// summary 形状：磁盘 meta 与 buildApiMessages 的 `<conversation_summary>` 注入都认这个形状。
export function buildCompactSummary(text, cutoff, trigger, totalMessages) {
    return {
        text: String(text == null ? '' : text).trim(),
        upTo: cutoff,
        createdAt: Date.now(),
        trigger: trigger || null,
        before: {messages: Number(totalMessages) || 0, archived: cutoff},
    };
}

// 压缩后旧消息的 usage 不再代表当前上下文：它计量的是「压缩前整段输入」，实测锚点
// 会因此停在压缩前的占用上（环纹丝不动，直到下一轮响应带回新 usage）。usage 本身
// 保留——统计行总量 / tok/s / 缓存命中与「最近一次 API 实际用量」都依赖它——只打
// 标记让锚点跳过，压缩后估算退回纯字符口径。标记随消息落盘（serializeSessionMessage
// 拷贝全部非 _ 字段），重载后依旧成立。
export function stampPreCompactUsage(messages) {
    for (const message of Array.isArray(messages) ? messages : []) {
        if (message && message.usage && typeof message.usage === 'object') {
            message.usage.preCompact = true;
        }
    }
}

// 锚点可信判定：带 preCompact 标记的 usage 计量的是压缩前的上下文，不能当实测锚点。
export function isAnchorUsage(message) {
    return !!(message && message.usage && typeof message.usage === 'object' && !message.usage.preCompact);
}

// 应用：裁剪 messages 并写回 summary，返回被归档的那段（调用方决定是否落盘 / 推送归档列表）。
// 保留段里的 usage 一并打 preCompact 标记：它们是在裁剪**之前**计量、包含已归档内容的。
export function applyCompactToSession(session, summary, cutoff) {
    if (!session) return {archived: [], kept: 0};
    const limit = Math.max(0, Math.min(Number(cutoff) || 0, session.messages.length));
    const archived = session.messages.slice(0, limit);
    session.messages = session.messages.slice(limit);
    stampPreCompactUsage(session.messages);
    session.summary = summary;
    return {archived, kept: session.messages.length};
}

// 压缩转录：喂给摘要模型的对话记录（工具结果也带上，否则摘要会丢掉关键事实）。
// maxChars 是转录上限：默认 TRANSCRIPT_MAX；上下文已超模型窗口时由调用方按窗口比例
// 传一个更小的值——**摘要请求本身也必须能发出去**，否则压缩这条路就死在自己身上了。
export function compactTranscriptOf(session, maxChars) {
    const source = session || {};
    const cap = Math.max(2000, Number(maxChars) || TRANSCRIPT_MAX);
    // 旧摘要单独留在头部：它是对更早历史的滚动累积。原来把旧摘要拼进 transcript 一起按
    // 尾部截断，而超窗兜底会把 cap 压小——旧摘要恰好排在最前，总是第一个被截掉，滚动链条
    // 就此断掉，超窗压缩的摘要质量反而比正常压缩更差。现在旧摘要恒定保留，只截消息中段。
    let priorSummary = '';
    if (source.summary && aiTextOf(source.summary.text).trim()) {
        priorSummary = '此前摘要：\n' + aiTextOf(source.summary.text).trim();
    }
    const parts = [];
    for (const message of source.messages || []) {
        if (!message) continue;
        if (message.role === 'tool') {
            if (aiTextOf(message.content).trim()) {
                parts.push('[工具 ' + (message.name || '') + ' 结果]\n' + aiTextOf(message.content).trim());
            }
            continue;
        }
        const text = aiTextOf(message.content).trim();
        const imageCount = Array.isArray(message.images) ? message.images.length : 0;
        if (!text && !imageCount) continue;
        parts.push((message.role === 'user' ? '用户' : 'AI') + '：\n' + (text || '（仅图片）') +
            (imageCount ? '\n（附图 ' + imageCount + ' 张）' : ''));
    }
    let transcript = parts.join('\n\n');
    // 截断预算扣掉旧摘要占的篇幅，保证「旧摘要 + 消息转录」总量仍受 cap 约束——超窗兜底
    // 正是靠 cap 保证摘要请求一定发得出去，不能为了保旧摘要把这个保证破坏；但消息转录至少
    // 留 2000 字符，避免摘要器只看到旧摘要、对最近发生了什么一无所知。
    const prefix = priorSummary ? priorSummary.length + 2 : 0;
    const msgCap = Math.max(2000, cap - prefix);
    if (transcript.length > msgCap) transcript = '…（较早内容已截断）\n\n' + transcript.slice(-msgCap);
    return priorSummary ? priorSummary + '\n\n' + transcript : transcript;
}

// 压缩请求的消息体（system = 摘要器约束；user = 转录 + 可选焦点指令）。
export function buildCompactMessages(session, systemPrompt, instruction, maxTranscriptChars) {
    const focus = aiTextOf(instruction).slice(0, 500);
    return [
        {role: 'system', content: systemPrompt},
        {
            role: 'user',
            content: '请压缩以下对话记录：\n\n' + compactTranscriptOf(session, maxTranscriptChars) +
                (focus ? '\n\n用户压缩指令（摘要须优先落实）：' + focus : ''),
        },
    ];
}

// 自动压缩阈值（0.5–0.95，默认 0.8）：主会话与子代理共用同一口径。
export function compactThresholdOf(config) {
    const value = Number(config && config.autoCompactThreshold) || 0.8;
    return Math.min(0.95, Math.max(0.5, value));
}
