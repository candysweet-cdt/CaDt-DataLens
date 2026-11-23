// ai-turn-reminder.js：每轮环境块（<system-reminder>）的标记与展示纯函数单一来源。
// 与 ai-quote.js 同架构：块拼在 user content 前缀、随消息落 JSONL（历史字节不随轮次漂移，
// 服务商前缀缓存才能命中）；气泡渲染 / 编辑重发 / 导出 / 会话摘要用 splitTurnReminderPrefix
// 拆掉包装只取用户正文。只认本模块包装生成的严格形状（开头紧跟已知子块标签），
// 避免把用户手写的同名标签误判成注入块。
import {aiTextOf} from '../core/ai-constants.js';

const OPEN_TAG = '<system-reminder>';
// 注入块至少含一个子块才生成，所以开头必须是已知子块标签之一。
// task_todos_check：轮末清单催促（tool 轮边界注入），与起轮的 task_todos 同属宿主环境块。
// cognition_index / cognition_nudge：认知索引的轮上下文块（ai-cognition.js，排在 blocks 末尾，
// 其余块全空时会成为开头子块——不认它会把注入块当用户正文拆不回去）。
// plan_status：计划审批卡真实状态（ai-system-context.js，继续规划讨论轮注入）——无 todos /
// reminders 时它排在 blocks 开头，漏认会把整个 <system-reminder> 当用户正文显示在气泡里
// （2026-11-22 实测 bug）。
const PREFIX_RE = /^<system-reminder>\n<(?:workspace_context|task_todos|task_todos_check|task_reminders|plan_status|attachments|cognition_index|cognition_nudge)>[\s\S]*?\n<\/system-reminder>[ \t]*\n*/;

// 注入内容里的 </system-reminder> 会提前闭合包装；换成全角斜杠，内容基本原样保留
// （与 ai-quote.js 的 neutralizeQuoteText 同口径）。
export function neutralizeTurnReminderText(text) {
    return aiTextOf(text).replace(/<\/system-reminder\s*>/gi, '<／system-reminder>');
}

// 空内容（无工作区 / 无清单 / 无提醒 / 无附件）返回空串——不生成只有包装的空块。
export function wrapTurnReminder(inner) {
    const body = neutralizeTurnReminderText(inner).trim();
    if (!body) return '';
    return OPEN_TAG + '\n' + body + '\n' + '</system-reminder>';
}

// 拆出开头连续的注入块：{reminder, body}（reminder 是第一个块，body 是其后正文）。
// 不匹配时 reminder 为空、body 原样返回。
// 循环剥离而不是只剥一块：重试（重新生成）曾把已落盘的 content 原样再发一遍，起轮又包一层
// 新的环境块 → 历史消息里叠成「新块 + 旧块 + 正文」，只剥一块会把旧块当用户正文显示
// （2026-11-24 实测：重试后气泡露出 <system-reminder><cognition_index>…）。
export function splitTurnReminderPrefix(content) {
    const text = aiTextOf(content);
    const first = PREFIX_RE.exec(text);
    if (!first) return {reminder: '', body: text};
    let rest = text.slice(first[0].length);
    for (;;) {
        const next = PREFIX_RE.exec(rest);
        if (!next) break;
        rest = rest.slice(next[0].length);
    }
    return {reminder: first[0].trim(), body: rest};
}
