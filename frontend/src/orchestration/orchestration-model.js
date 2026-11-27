// orchestration-model.js：编排前端的纯数据归一与展示文案。
//
// 这里不碰 DOM、不调后端：把 AI 给的不可信草稿包成本窗口的 PlanRequest、
// 校验/格式化看板文本、解析审批卡里的 verify 编辑行。后端仍会整份重验。
import {pathKey} from '../core/event-scope.js';

export const ORCH_STATUS_LABELS = Object.freeze({
    planning: '规划中',
    running: '运行中',
    paused: '已暂停',
    paused_no_window: '暂停（窗口已关）',
    stopped: '已停止',
    awaiting_user: '等用户',
    awaiting_arbitration: '等仲裁',
    blocked: '阻塞',
    done: '完成',
    failed: '失败',
    fault: '故障',
});

export const BATCH_STATUS_LABELS = Object.freeze({
    pending: '待派发',
    dispatched: '已广播',
    running: '执行中',
    verifying: '验收中',
    reviewing: '审查中',
    done: '完成',
    failed: '失败',
    blocked: '卡住',
    awaiting_user: '等用户',
    cancelled: '已取消',
    skipped: '已跳过',
});

export const FAILURE_LABELS = Object.freeze({
    no_report: '未回报（no_report）',
    stalled: '超时无进展（stalled）',
    session_gone: '执行会话消失',
    verify_failed: '验收失败',
    review_failed: '审查提出返工',
    review_unavailable: '审查不可用（未放行）',
    over_budget: '超预算',
    blocked_by_dep: '上游失败',
    user_stopped: '用户停止',
    blocked: '执行者报告卡住',
    timeout_abort: '等待用户超时（abort）',
    attempts_exhausted: '尝试次数已用尽',
});

export function statusLabel(status) {
    return ORCH_STATUS_LABELS[String(status || '')] || String(status || '未知');
}

export function batchStatusLabel(status) {
    return BATCH_STATUS_LABELS[String(status || '')] || String(status || '未知');
}

export function failureLabel(reason) {
    const key = String(reason || '');
    return FAILURE_LABELS[key] || (key ? key : '');
}

export function isTerminalStatus(status) {
    return ['done', 'failed', 'stopped', 'fault'].includes(String(status || ''));
}

export function isAttentionStatus(status) {
    return ['awaiting_user', 'awaiting_arbitration', 'blocked', 'paused_no_window', 'fault'].includes(String(status || ''));
}

// 权限档严格度：数值越大越严；编排执行会话只能继承或更严。
const SCOPE_RANK = {full: 0, auto: 1, edit: 2, read: 3};

export function stricterScope(base, wanted) {
    const a = String(base || 'read');
    const b = String(wanted || '');
    if (!(b in SCOPE_RANK)) return a;
    return (SCOPE_RANK[b] || 0) >= (SCOPE_RANK[a] || 0) ? b : a;
}

function textOf(value) {
    return typeof value === 'string' ? value : (value == null ? '' : String(value));
}

function intOf(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function stringList(value) {
    return Array.isArray(value) ? value.map((v) => textOf(v).trim()).filter(Boolean) : [];
}

function normalizeVerify(value) {
    return (Array.isArray(value) ? value : []).map((item) => {
        const raw = item && typeof item === 'object' ? item : {};
        return {
            file: textOf(raw.file).trim(),
            args: Array.isArray(raw.args) ? raw.args.map(textOf) : [],
            ...(textOf(raw.cwd).trim() ? {cwd: textOf(raw.cwd).trim()} : {}),
            ...(Number(raw.timeoutMs) > 0 ? {timeoutMs: Math.round(Number(raw.timeoutMs))} : {}),
        };
    }).filter((item) => item.file);
}

export function normalizeBatch(b, index) {
    const raw = b && typeof b === 'object' ? b : {};
    return {
        id: textOf(raw.id).trim() || ('B' + (index + 1)),
        title: textOf(raw.title).trim() || ('批次 ' + (index + 1)),
        spec: textOf(raw.spec).trim(),
        owns: stringList(raw.owns),
        dependsOn: stringList(raw.dependsOn),
        verify: normalizeVerify(raw.verify),
        ...(Number(raw.timeoutMs) > 0 ? {timeoutMs: Math.round(Number(raw.timeoutMs))} : {}),
        model: {
            ...(textOf(raw.model && raw.model.first).trim() ? {first: textOf(raw.model.first).trim()} : {}),
            ...(textOf(raw.model && raw.model.retry).trim() ? {retry: textOf(raw.model.retry).trim()} : {}),
        },
    };
}

// AI 工具载荷 + 当前会话上下文 → 提交后端的 PlanRequest（workspace / parent / arbiter 不受模型控制）。
export function buildPlanRequest(input, context) {
    const ctx = context || {};
    const raw = input && typeof input === 'object' ? input : {};
    const rawPolicy = raw.policy && typeof raw.policy === 'object' ? raw.policy : {};
    const baseScope = textOf(ctx.scope) || 'read';
    const scope = stricterScope(baseScope, rawPolicy.scope || (baseScope === 'full' ? 'edit' : baseScope));
    const reviewExplicit = Object.prototype.hasOwnProperty.call(rawPolicy, 'review');
    const policy = {
        scope,
        maxParallel: intOf(rawPolicy.maxParallel, 1, 8, 2),
        maxAttemptsPerBatch: intOf(rawPolicy.maxAttemptsPerBatch, 1, 2, 2),
        ...(Number(rawPolicy.budgetTokens) > 0 ? {budgetTokens: Math.round(Number(rawPolicy.budgetTokens))} : {}),
        ...(Number(rawPolicy.maxTotalRounds) > 0 ? {maxTotalRounds: Math.round(Number(rawPolicy.maxTotalRounds))} : {}),
        ...(Number(rawPolicy.maxWallMs) > 0 ? {maxWallMs: Math.round(Number(rawPolicy.maxWallMs))} : {}),
        batchTimeoutMs: intOf(rawPolicy.batchTimeoutMs, 60_000, 2 * 60 * 60 * 1000, 20 * 60 * 1000),
        auditIdleMs: intOf(rawPolicy.auditIdleMs, 2 * 60 * 60 * 1000, 24 * 60 * 60 * 1000, 2 * 60 * 60 * 1000),
        arbiterTimeoutMs: 10 * 60 * 1000,
        arbiterMissLimit: 2,
        arbiterRotateAt: 0.7,
        review: reviewExplicit ? rawPolicy.review !== false : true,
        reviewExplicit,
        reviewModel: textOf(rawPolicy.reviewModel).trim(),
        escalateOnRetry: false,
        allowWorkerModels: rawPolicy.allowWorkerModels === true,
        allowedWorkerModels: stringList(rawPolicy.allowedWorkerModels).slice(0, 5),
        autoRun: rawPolicy.autoRun === true,
        snapshotBeforeStart: rawPolicy.snapshotBeforeStart === true,
    };
    // 审计阈值必须 ≥ 2 × 最长批次超时（后端也会校验）。
    let maxBatch = policy.batchTimeoutMs;
    const batches = (Array.isArray(raw.batches) ? raw.batches : []).map(normalizeBatch);
    for (const b of batches) {
        if (b.timeoutMs && b.timeoutMs > maxBatch) maxBatch = b.timeoutMs;
    }
    policy.auditIdleMs = Math.max(policy.auditIdleMs, 2 * maxBatch);
    return {
        title: textOf(raw.title).trim() || '未命名编排',
        goal: textOf(raw.goal).trim(),
        workspace: textOf(ctx.workspace),
        parentSessionId: textOf(ctx.sessionId),
        arbiterSessionId: textOf(ctx.sessionId),
        groupSnapshot: textOf(ctx.group),
        arbiterModelRef: textOf(ctx.modelRef),
        policy,
        batches,
    };
}

export function acceptsWorkspace(payloadRoot, workspace) {
    return !!payloadRoot && !!workspace && pathKey(payloadRoot) === pathKey(workspace);
}

export function batchDoneRatio(view) {
    const batches = Array.isArray(view && view.batches) ? view.batches : [];
    const work = batches.filter((b) => b.kind !== 'review');
    const review = batches.filter((b) => b.kind === 'review');
    const done = work.filter((b) => b.status === 'done' || b.status === 'skipped').length;
    const reviewDone = review.filter((b) => b.status === 'done').length;
    return {work: `${done}/${work.length}`, review: `${reviewDone}/${review.length}`, done, total: work.length};
}

export function formatElapsed(ms) {
    const n = Math.max(0, Number(ms) || 0);
    if (n < 1000) return '0s';
    const sec = Math.floor(n / 1000);
    if (sec < 60) return sec + 's';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + 'm' + (sec % 60 ? (sec % 60) + 's' : '');
    const hour = Math.floor(min / 60);
    return hour + 'h' + (min % 60 ? (min % 60) + 'm' : '');
}

// 看板/工具用的一句话摘要；不代替完整详情。
export function summarizeView(view) {
    const o = view && view.orchestration ? view.orchestration : view;
    if (!o) return '编排不存在';
    const ratio = batchDoneRatio(view || o);
    const lines = [
        `「${o.title || o.id}」${statusLabel(o.status)} · ${ratio.work} 批（审查 ${ratio.review}）` +
            (o.stats && o.stats.tokensUsed ? ` · ${o.stats.tokensUsed} tokens` : ''),
    ];
    if (o.goal) lines.push('目标：' + o.goal);
    const attention = (Array.isArray(view && view.batches) ? view.batches : o.batches || [])
        .filter((b) => b.status === 'failed' || b.status === 'blocked' || b.status === 'awaiting_user');
    for (const b of attention.slice(0, 8)) {
        lines.push(`- ${b.id}「${b.title}」${batchStatusLabel(b.status)}` +
            (b.failureReason ? `：${failureLabel(b.failureReason)}` : '') +
            (b.attempts ? `（attempts ${b.attempts}）` : ''));
    }
    return lines.join('\n');
}

// 审批卡里的 verify 文本：每行一条 JSON（也接受整段 JSON 数组）。
// 编辑体验优先简单；真正的结构校验仍在 Go。
export function parseVerifyEditor(text) {
    const raw = textOf(text).trim();
    if (!raw) return {ok: true, value: []};
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return {ok: false, value: [], error: 'verify 必须是 JSON 数组'};
        return {ok: true, value: normalizeVerify(parsed)};
    } catch (e) {
        const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const out = [];
        for (const line of lines) {
            try {
                const item = JSON.parse(line);
                if (!item || typeof item !== 'object') throw new Error('not object');
                out.push(item);
            } catch (err) {
                return {ok: false, value: [], error: 'verify 行无法解析：' + line};
            }
        }
        return {ok: true, value: normalizeVerify(out)};
    }
}

export function formatVerifyEditor(verify) {
    const list = normalizeVerify(verify);
    if (!list.length) return '';
    return JSON.stringify(list, null, 2);
}

export function ownsToInput(owns) {
    return stringList(owns).join(', ');
}

export function ownsFromInput(text) {
    return textOf(text).split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
}

// computeAuditIdleMs：审计阈值必须 ≥ 2 × 最长批次超时（含逐批 timeoutMs），
// 同时不把设置页给的更大默认值静默改小。审批卡编辑后按当前卡片重算。
export function computeAuditIdleMs(defaultMs, policy, batches) {
    let maxBatch = Number(policy && policy.batchTimeoutMs) || 0;
    for (const b of (Array.isArray(batches) ? batches : [])) {
        const timeout = Number(b && b.timeoutMs) || 0;
        if (timeout > maxBatch) maxBatch = timeout;
    }
    return Math.max(Number(defaultMs) || 0, 2 * maxBatch);
}
