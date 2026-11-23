// ai-truncation.js：回复被截断的判定与文案（单一来源）。
// 传输层把结束原因归一成 tool / length / stop / unknown 四档（见 internal/aitransport/sse.go
// 的 aiFinishReason）；这里只回答「要不要告诉用户」与说什么，纯函数，便于单测。
//
// length ：输出预算打满（max_tokens / 上下文超限），内容确定被砍断，一律提示。
// unknown ：上游只发了 [DONE] 没给 finish_reason，完整性未知——只在正文停在不该停的位置
//           （冒号 / 逗号 / 破折号等悬空收尾）时才提示，否则正常网关每轮都会挂一条噪音。

// 悬空收尾标点：句子/代码块没有收束就断在这里
const DANGLING_TAIL = '：:，,、…—-—';

// 返回 ''（不提示）/ 'length'（确定截断）/ 'suspect'（疑似被提前结束）。
export function resolveTruncation(finishReason, content) {
    const reason = (typeof finishReason === 'string' ? finishReason : '').trim().toLowerCase();
    if (reason === 'length') return 'length';
    if (reason !== 'unknown') return '';
    const text = typeof content === 'string' ? content.trim() : '';
    if (!text) return '';
    return DANGLING_TAIL.includes(text.slice(-1)) ? 'suspect' : '';
}

// 提示条文案（'' = 不显示）
export function truncatedNotice(kind) {
    if (kind === 'length') return '输出达到上限，回复可能不完整';
    if (kind === 'suspect') return '上游没给结束原因，回复可能不完整';
    return '';
}

// 提示条上「继续」按钮要发的消息：让模型接着上次的断点写，不重复已输出内容。
export const CONTINUATION_PROMPT = '继续（从上次中断处接着写，不要重复已输出的内容）';
