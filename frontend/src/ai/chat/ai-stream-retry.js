// ai-stream-retry.js：流式响应被上游掐断（unexpected EOF）后的自动重试预算。
// 纯函数，供 ai-panel 判定；语义与 Go 侧 ai-error.retryable 配合。

// 单轮对话内最多自动重试几次。retryMax 是用户给 429/5xx 配的网络重试次数，
// 断流重试要整轮重新生成（可能几分钟、上万 token），不跟着放开到 10 次。
export const AI_STREAM_RETRY_LIMIT = 2;

// aiStreamRetryBudget：由设置的 retryMax 推出断流重试预算；retryMax=0 视为关闭。
export function aiStreamRetryBudget(retryMax) {
    const value = Number(retryMax);
    const base = Number.isFinite(value) ? Math.trunc(value) : 5;
    return Math.max(0, Math.min(base, AI_STREAM_RETRY_LIMIT));
}

// shouldAutoRetryStream：只认后端标的 retryable（流中途被掐断）；用户已停止、
// 或预算用尽都不重试。
export function shouldAutoRetryStream({retryable, stopped, retried, budget} = {}) {
    if (retryable !== true || stopped) return false;
    return Number(retried || 0) < Number(budget || 0);
}
