// ai-context-estimate.js：把会话消息组装成发给模型的 apiMessages（上下文估算/实时瘦身）。
// 从 ai-panel.js 的 buildApiMessages 拆出（phase4 P2），函数体逐字搬移。
// 纯函数直接 import；settings/contextWindowOf 与 4 个输出状态经 deps 注入（getter/setter 活引用）。

import {aiTextOf, aiEstimateTokens, AI_DEFAULT_SYSTEM_PROMPT} from '../core/ai-constants.js';
import {planReferenceBlock} from '../core/ai-plan-file.js';
import {formatSteerMessage} from './ai-message-queue.js';
import {safeToolArguments} from '../tools/ai-tool-args.js';
import {isAnchorUsage} from './ai-compact.js';
import {
    slimToolResult, recentTurnStart, underContextPressure, recentToolIndexes,
    SHRINK_KEEP_TOOL_RESULTS, foldSupersededToolCalls, foldedToolArguments,
} from './ai-context-slim.js';

export function createAIContextEstimate(deps) {
    function buildApiMessages(session, endIndex, systemText) {
        const messages = [{role: 'system', content: systemText || AI_DEFAULT_SYSTEM_PROMPT}];
        deps.setAnchor(null);
        if (!session) return messages;
        if (session.summary && aiTextOf(session.summary.text).trim()) {
            messages.push({
                role: 'system',
                content: '<conversation_summary>\n' + aiTextOf(session.summary.text).trim() + '\n</conversation_summary>',
            });
            // compact 后计划回注（对齐 ZCode plan_file_reference）：归档会丢计划正文，
            // 摘要之后紧跟完整计划，压缩后的下一轮仍能「继续按计划执行 / 修订」。
            const planReference = planReferenceBlock(session);
            if (planReference) messages.push({role: 'system', content: planReference});
        }
        const limit = endIndex == null ? session.messages.length : endIndex;
        // 瞬态注入块去重（实时压缩式剔除）：同类 dedupeKey 的注入只保留**最新一条**发
        // 给模型——旧条目已过时（如清单状态早变了），重发既浪费上下文又可能用旧状态
        // 误导模型。会话历史里照常保留（用户可查），只是组装请求时跳过。
        const lastTransient = new Map();
        for (let i = 0; i < limit; i++) {
            const m = session.messages[i];
            if (m && m.dedupeKey) lastTransient.set(m.dedupeKey, i);
        }
        // tool 消息必须一对一响应最近一条已发送 assistant 的 tool_calls（OpenAI 校验，
        // Anthropic 同理）。停止生成、压缩截断、历史恢复都可能留下孤立 tool 消息——
        // 不跳过会让后续每一轮请求都被 HTTP 400 拒收。
        let pendingCalls = new Set();
        // —— 实时瘦身（组装视角剔除，会话历史原样保留）——
        // 总开关 settings.aiContextSlim（默认开，dsh 同款思路：清理是部署策略恒开）。
        // 轮次口径在 ai-context-slim.js：只有用户亲手键入的消息算一轮，注入类
        // （systemNote / steer / notice / app 自动附图与后台唤醒）不推保留窗口。
        const slim = deps.getSettings().aiContextSlim !== false;
        const recentStart = slim ? recentTurnStart(session.messages, limit) : -1; // -1 = 全部视为「当轮」，各剔除点自然全跳过
        let savedTokens = {reasoning: 0, transient: 0, notes: 0, toolPrune: 0, argsPrune: 0}; // 本次组装剔除的 token，分类记账
        // 应急收缩：窗口占用 ≥ 90% 时把「按龄修剪」放宽成「除最近 5 个工具结果外全修剪」。
        // 只影响发出去的内容（会话历史原样），比直接调模型做摘要便宜得多。
        // 估算必须与提醒条同口径（aiEstimateTokens 对 CJK 有加权，chars/3.2 会把中文
        // 低估一倍以上，压力档就永远不触发）；也不能调 estimateCurrentTokens——那条路会回调进来。
        // 系统提示词与工具参数（整批提交类 MCP 的 args 动辄几十万字符）都要算上。
        let shrinkPressure = false;
        let shrinkRatio = 0; // 触发时的估算占用（整数百分比，注记展示用）
        if (slim) {
            const windowSize = deps.contextWindowOf(session);
            if (windowSize > 0) {
                let used = 0;
                for (let i = 0; i < limit; i++) {
                    const m = session.messages[i];
                    if (!m) continue;
                    if (typeof m.content === 'string' && m.content) used += aiEstimateTokens(m.content);
                    if (typeof m.reasoning === 'string' && m.reasoning) used += aiEstimateTokens(m.reasoning);
                    if (Array.isArray(m.toolCalls)) {
                        for (const tc of m.toolCalls) used += aiEstimateTokens(String((tc && tc.arguments) || ''));
                    }
                }
                if (systemText) used += aiEstimateTokens(systemText);
                shrinkPressure = underContextPressure(used, windowSize);
                shrinkRatio = Math.round(used / windowSize * 100);
            }
        }
        const keepToolIndexes = shrinkPressure ? recentToolIndexes(session.messages, limit, SHRINK_KEEP_TOOL_RESULTS) : null;
        // 整批退回且已被后续成功重试取代的调用：参数不再发出（判定见 ai-context-slim.js）。
        // 只算一份集合，循环里按 toolCallId 命中即折叠。
        const foldedCallIds = slim ? foldSupersededToolCalls(session.messages, limit) : new Set();
        for (let i = 0; i < limit; i++) {
            const message = session.messages[i];
            if (!message) continue;
            // 文件改动汇总卡是纯 UI 载体，不发给模型
            if (message.kind === 'changes-summary') continue;
            // 模型切换 / 应急收缩留痕只是对话里的可视注记，不进入模型上下文
            if (message.kind === 'model-switch' || message.kind === 'slim-note') continue;
            // 瞬态注入块的旧条目：只发最新一条（见 lastTransient）。瘦身关闭时仍去重——
            // 同内容多份纯冗余，与「是否清理上下文」是两回事
            if (message.dedupeKey && lastTransient.get(message.dedupeKey) !== i) {
                savedTokens.transient += aiEstimateTokens(aiTextOf(message.content));
                continue;
            }
            // 轮次提醒注记（如「工具调用轮次已达 N」）：只在产生时随下一请求有效，
            // 之后是纯噪音，历史里不再发
            if (slim && message.systemNote && !message.dedupeKey) {
                savedTokens.notes += aiEstimateTokens(aiTextOf(message.content));
                continue;
            }
            if (message.role === 'tool') {
                if (message.status === 'running') continue;
                if (!pendingCalls.has(message.toolCallId)) continue;
                pendingCalls.delete(message.toolCallId);
                let toolContent = message.content || '';
                // 过时的大工具结果修剪（阈值与头尾预算在 ai-context-slim.js，
                // 参数对齐 dsh tool-result-pruner；命令类尾部预算放宽到 2048）。
                // 常规按龄修剪（倒数第 2 轮以前）；窗口吃紧时放宽到「除最近 N 个结果外全部」，
                // 最近 N 个不动——模型正在用的数据被清掉，它得重跑一遍工具，那比省 token 更贵。
                // S3 落盘预算化后的消息（persistBudgeted）本身已是「头尾 + 指针」形态，
                // 直接透传——二次修剪只会把指针注记剪烂。
                const prunable = slim && !message.persistBudgeted &&
                    (i < recentStart || (keepToolIndexes && !keepToolIndexes.has(i)));
                if (prunable) {
                    // 有落盘路径就换指针（全文在 ai-artifacts/），没有就退回修剪中段。
                    // 压力档把修剪门槛从「值得落盘的体量」降到 2 K——低于落盘阈值的中等结果
                    // 平时不值得动，窗口吃紧时正是它们在堆积。
                    const pruned = slimToolResult(message.name, toolContent, message.artifactPath, shrinkPressure);
                    if (pruned != null) {
                        savedTokens.toolPrune += aiEstimateTokens('x'.repeat(Math.max(0, toolContent.length - pruned.length)));
                        toolContent = pruned;
                    }
                }
                messages.push({
                    role: 'tool',
                    toolCallId: message.toolCallId,
                    name: message.name || '',
                    content: toolContent,
                });
                continue;
            }
            const hasCalls = message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length;
            const hasImages = message.role === 'user' && Array.isArray(message.images) && message.images.some((image) => image && image.data);
            const hasVideos = message.role === 'user' && Array.isArray(message.videos) && message.videos.some((video) => video && video.data);
            let content = message.content;
            if (!content && !hasImages && !hasVideos && message.role === 'user' &&
                ((Array.isArray(message.images) && message.images.length) || (Array.isArray(message.videos) && message.videos.length))) {
                content = '（图片/视频已归档，原始内容见对话日志）';
            }
            // 插话（steer）只在请求里包 user_steer 模板：落盘与气泡仍是用户原文，
            // 否则重放后模板会越包越多（见 ai-message-queue.js formatSteerMessage）。
            if (message.role === 'user' && message.steer && String(content || '').trim()) {
                content = formatSteerMessage(content);
            }
            if (!content && !hasCalls && !hasImages && !hasVideos) continue;
            if (message.role === 'assistant' && message.status === 'error') continue;
            const item = {role: message.role, content};
            if (hasImages) {
                item.images = message.images.filter((image) => image && image.data)
                    .map((image) => ({mime: image.mime, data: image.data}));
            }
            if (hasVideos) {
                item.videos = message.videos.filter((video) => video && video.data)
                    .map((video) => ({mime: video.mime, data: video.data}));
            }
            if (message.role === 'assistant' && message.reasoning && (!slim || i >= recentStart)) {
                // 历史 reasoning 只保留最近 2 轮：思考只服务于当轮行动，旧轮的思考
                // 重发动辄数千 token 且零价值（文件/状态早变了）
                item.thinking = message.reasoning;
                item.thinkingSignature = message.thinkingSignature || '';
            } else if (message.role === 'assistant' && message.reasoning) {
                savedTokens.reasoning += aiEstimateTokens(message.reasoning);
            }
            // 只保留「确有 tool 响应」的调用：多工具批次中途停止/中断会留下残缺批次
            // （如 2 个 calls 只有 1 个执行），OpenAI/Anthropic 会以
            // "insufficient tool messages following tool_calls" 拒收整轮请求。
            let usableCalls = null;
            if (hasCalls) {
                const responded = new Set();
                for (let j = i + 1; j < limit; j++) {
                    const next = session.messages[j];
                    if (!next) continue;
                    if (next.role !== 'tool') break;
                    if (next.status === 'running') continue;
                    if (next.toolCallId) responded.add(next.toolCallId);
                }
                usableCalls = message.toolCalls.filter((call) => responded.has(call.id));
                if (usableCalls.length) {
                    item.toolCalls = usableCalls.map((call) => {
                        // 后端会整轮校验：参数不合法时先修复，避免一条坏历史让后续每轮 400。
                        const args = safeToolArguments(call.arguments);
                        if (!foldedCallIds.has(call.id)) {
                            return {id: call.id, name: call.name, arguments: args};
                        }
                        const folded = foldedToolArguments(args.length);
                        savedTokens.argsPrune += aiEstimateTokens('x'.repeat(Math.max(0, args.length - folded.length)));
                        return {id: call.id, name: call.name, arguments: folded};
                    });
                } else if (!content) {
                    // 全部无响应且无正文：整条不发，避免模型看到悬空的 calls。
                    continue;
                }
            }
            messages.push(item);
            // 实测锚点：只认真正发出去的 assistant（错误/空消息已被上面的 continue 跳过）；
            // 压缩打标的 usage（preCompact）计量的是压缩前上下文，不认——压缩后估算
            // 退回纯字符口径，下一轮响应带回新 usage 后自动恢复「实测 + 增量」
            if (message.role === 'assistant' && isAnchorUsage(message)) {
                deps.setAnchor({index: messages.length - 1, usage: message.usage});
            }
            // 维护「待响应工具调用」集合：assistant 重置为可用 calls，user 清空。
            // 被跳过的 assistant（空内容/错误）不更新集合，其后的孤立 tool 消息自然被跳过。
            if (message.role === 'assistant') {
                pendingCalls = (usableCalls && usableCalls.length) ? new Set(usableCalls.map((call) => call.id)) : new Set();
            } else {
                pendingCalls = new Set();
            }
        }
        deps.setSavedTokens(savedTokens);
        deps.setShrinkPressure(shrinkPressure);
        deps.setShrinkRatio(shrinkRatio);
        return messages;
    }

    return {buildApiMessages};
}
