// ai-usage-ui.js：用量 UI 域——本轮用量浮层、统计行弹层（会话 / tokens）与用量合计 /
// 格式化纯函数。方案 V3 从 ai-panel.js 逐字搬移（docs/finished-plans/side-chat-tab.md §7.3）；
// 上下文弹层（renderCtxPopover）依赖面板闭包过深（系统上下文组装 / 记忆缓存 / 附件），
// 留在面板，经 ctx 注入给 toggleStatsPop。
//
// sessionUsageTotals 是纯数据核：面板统计行、两个弹层、支线标签页统计行共用同一份口径。
// 格式化三件套（K/M tok、千分位、时长）原本是面板本地函数，这里收编为唯一来源。

import {isTurnBoundaryMessage} from '../session/ai-session-store.js';
import {overlayStack} from '../../core/overlay-stack.js';
import {iconSvg} from '../../core/icons.js';

export function aiFormatCompactTokens(value) {
    const num = Math.max(0, Math.round(Number(value) || 0));
    if (num < 1000) return String(num);
    if (num < 1000000) {
        const k = num / 1000;
        return (k < 100 ? k.toFixed(1) : k.toFixed(0)).replace(/\.0$/, '') + 'K';
    }
    const m = num / 1000000;
    return (m < 10 ? m.toFixed(1) : m.toFixed(0)).replace(/\.0$/, '') + 'M';
}

export function aiFormatExactCount(value) {
    return Math.max(0, Math.round(Number(value) || 0)).toLocaleString('en-US');
}

export function aiFormatCompactDuration(ms) {
    const total = Math.max(0, Math.round(Number(ms) / 1000));
    if (total < 1) return '不到 1 秒';
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours) return hours + '小时' + (minutes ? minutes + '分' : '');
    if (minutes) return minutes + '分' + (seconds ? seconds + '秒' : '');
    return seconds + '秒';
}

// 本轮用量合计（totalTokens 缺失时用输入 + 输出兜底）
export function turnUsageTotal(message) {
    const usage = message && message.usage;
    if (!usage) return 0;
    const prompt = Number(usage.promptTokens) || 0;
    const completion = Number(usage.completionTokens) || 0;
    return Math.max(0, Number(usage.totalTokens) || (prompt + completion));
}

// TPS 采样下限：单轮生成窗口过短（<200ms）时除法的量化误差太大，改走端到端兜底。
const MIN_TPS_WINDOW_MS = 200;

export function sessionUsageTotals(session) {
    const all = ((session && session.archived) || []).concat((session && session.messages) || []);
    let rounds = 0;
    let steps = 0;
    let prompt = 0;
    let completion = 0;
    let total = 0;
    let cached = 0;
    let turnMs = 0;
    let modelMs = 0;
    let toolMs = 0;
    let genMs = 0;
    let genCompletion = 0;
    let e2eMs = 0;
    let e2eCompletion = 0;
    let ttftMs = 0;
    let ttftCount = 0;
    let hasTools = false;
    for (const message of all) {
        if (!message) continue;
        // 轮次口径与 turnStartAt / 会话分组同源：steer 是本轮补充指示，systemNote 与信箱
        // notice 是机器注入，都不计入「N 轮」（isTurnBoundaryMessage 单一判据）。
        if (isTurnBoundaryMessage(message)) rounds++;
        if (message.role === 'tool') {
            hasTools = true;
            continue;
        }
        if (message.role !== 'assistant') continue;
        steps++;
        let messageCompletion = 0;
        const usage = message.usage;
        if (usage) {
            const p = Number(usage.promptTokens) || 0;
            const c = Number(usage.completionTokens) || 0;
            prompt += p;
            completion += c;
            messageCompletion = c;
            total += Number(usage.totalTokens) || (p + c);
            cached += Number(usage.cachedTokens) || 0;
        }
        const messageModelMs = Number(message.modelMs) || 0;
        const messageTurnMs = Number(message.turnMs) || 0;
        modelMs += messageModelMs;
        toolMs += Number(message.toolMs) || 0;
        turnMs += messageTurnMs;
        const firstTokenMs = Number(message.firstTokenMs) || 0;
        if (firstTokenMs > 0) {
            ttftMs += firstTokenMs;
            ttftCount++;
        }
        // TPS 的分子分母必须同源，否则多步任务会把速度算到极低：
        //  · 分母只用 modelMs（本轮模型往返），绝不回退 turnMs —— turnMs 从用户发消息算起，
        //    包含本轮之前所有步骤与工具调用耗时，几十步的任务会得到几十秒的分母；
        //  · 分母扣掉 TTFT：排队 + 预填充 + 首 token 延迟不属于「生成速度」；
        //  · 没有 usage 的轮次直接跳过，避免「分母涨、分子不涨」稀释均值。
        if (usage && messageCompletion > 0 && messageModelMs > 0) {
            const windowMs = Math.max(0, messageModelMs - firstTokenMs);
            if (windowMs >= MIN_TPS_WINDOW_MS) {
                genMs += windowMs;
                genCompletion += messageCompletion;
            } else {
                // 非流式一次性返回（TTFT ≈ 总耗时）或仅吐了几个 token：
                // 用它算生成速度会得到天文数字，退化为端到端吞吐计权。
                e2eMs += messageModelMs;
                e2eCompletion += messageCompletion;
            }
        }
    }
    // 有真实生成窗口就优先用它；否则退化为端到端吞吐（含 TTFT），仍远好过混入 turnMs。
    let speed = 0;
    if (genCompletion > 0 && genMs > 0) {
        speed = Math.round(genCompletion / (genMs / 1000));
    } else if (e2eCompletion > 0 && e2eMs > 0) {
        speed = Math.round(e2eCompletion / (e2eMs / 1000));
    }
    return {
        rounds, steps, prompt, completion, total, cached, turnMs,
        modelMs, toolMs, hasTools,
        ttftAvg: ttftCount ? ttftMs / ttftCount : 0,
        speed,
        speedKind: genCompletion > 0 && genMs > 0 ? 'gen' : (speed > 0 ? 'e2e' : ''),
    };
}

export function createAIUsageUI(ctx) {
    const el = ctx.el;
    const currentSession = ctx.currentSession;
    // 惰性转发：renderCtxPopover 是面板闭包里的函数声明（构造早于定义，运行期才调用）
    const renderCtxPopover = ctx.renderCtxPopover;

    // ---------- 本轮用量浮层 ----------

    let turnUsagePop = null;
    let turnUsageAnchor = null;
    let turnUsageDismiss = null;
    // 页面级浮层的弹层栈条目（body 浮层，popover 档）：Esc 由栈按层序退
    let turnUsageStackHandle = null;

    function closeTurnUsagePop() {
        if (turnUsageStackHandle) {
            turnUsageStackHandle.dispose();
            turnUsageStackHandle = null;
        }
        if (turnUsageDismiss) {
            const dispose = turnUsageDismiss;
            turnUsageDismiss = null;
            dispose();
        }
        if (turnUsagePop) {
            turnUsagePop.remove();
            turnUsagePop = null;
        }
        turnUsageAnchor = null;
    }

    function showTurnUsagePop(anchor, message) {
        closeTurnUsagePop();
        if (!anchor || !message) return;
        const usage = message.usage || {};
        const prompt = Math.max(0, Number(usage.promptTokens) || 0);
        const cached = Math.max(0, Number(usage.cachedTokens) || 0);
        const cacheWrite = Math.max(0, Number(usage.cacheWriteTokens) || 0);
        const completion = Math.max(0, Number(usage.completionTokens) || 0);
        const total = turnUsageTotal(message);
        const uncached = Math.max(0, prompt - cached);
        const hitRate = prompt > 0 && cached > 0 ? Math.min(100, cached / prompt * 100) : -1;

        const pop = document.createElement('div');
        pop.className = 'ai-turn-usage';
        const head = document.createElement('div');
        head.className = 'ai-turn-usage-head';
        const title = document.createElement('span');
        title.className = 'ai-turn-usage-title';
        const glyph = document.createElement('span');
        glyph.className = 'ai-turn-usage-icon';
        glyph.innerHTML = iconSvg('database');
        title.append(glyph, document.createTextNode('本轮用量'));
        const sum = document.createElement('b');
        sum.textContent = aiFormatExactCount(total) + ' tok';
        head.append(title, sum);
        pop.appendChild(head);

        const rows = document.createElement('div');
        rows.className = 'ai-turn-usage-rows';
        const row = (label, value, mono) => {
            const line = document.createElement('div');
            line.className = 'ai-turn-usage-row';
            const name = document.createElement('span');
            name.textContent = label;
            const val = document.createElement('span');
            val.className = 'ai-turn-usage-value' + (mono ? ' num' : '');
            val.textContent = value;
            line.append(name, val);
            rows.appendChild(line);
        };
        const provider = [message.modelAccount, message.model].filter(Boolean).join(' / ');
        row('提供方 / 模型', provider || '—');
        row('缓存命中', hitRate >= 0 ? hitRate.toFixed(1) + '%' : '—');
        row('未缓存输入', aiFormatExactCount(uncached) + ' tok', true);
        row('缓存读取', aiFormatExactCount(cached) + ' tok', true);
        row('缓存写入', aiFormatExactCount(cacheWrite) + ' tok', true);
        row('输出', aiFormatExactCount(completion) + ' tok', true);
        pop.appendChild(rows);
        document.body.appendChild(pop);

        const rect = anchor.getBoundingClientRect();
        const width = pop.offsetWidth || 300;
        const height = pop.offsetHeight || 200;
        const left = Math.min(Math.max(8, rect.left - 6), Math.max(8, window.innerWidth - width - 8));
        let top = rect.top - height - 8;
        if (top < 8) top = Math.min(rect.bottom + 8, Math.max(8, window.innerHeight - height - 8));
        pop.style.left = Math.round(left) + 'px';
        pop.style.top = Math.round(top) + 'px';
        turnUsagePop = pop;
        turnUsageAnchor = anchor;

        // 面板滚动 / 换会话 / 点别处 / Esc 都收起；滚轮滚动时浮层会脱锚，直接关。
        // Esc 归全局弹层栈（body 浮层，popover 档），不再自挂 keydown。
        const onScroll = () => closeTurnUsagePop();
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onScroll);
        turnUsageDismiss = () => {
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onScroll);
        };
        if (turnUsageStackHandle) turnUsageStackHandle.dispose();
        turnUsageStackHandle = overlayStack.open({
            id: 'ai-turn-usage', kind: 'popover', el: pop,
            closeOnOutsideClick: true,
            // 选择器而非节点快照：徽标在浮层存活期间可能被重渲染（换会话/刷新），动态判定才不误关
            anchors: ['[data-ai-act="usage"]'],
            onClose: () => { closeTurnUsagePop(); return true; },
        });
    }

    // 面板的用量徽标点击做「同一个徽标再点 = 关」判定用
    function matchesAnchor(node) {
        return !!turnUsagePop && turnUsageAnchor === node;
    }

    // ---------- 统计行弹层（会话 / tokens；ctx 弹层正文在面板） ----------

    let openStatsPop = '';

    function statsPopEl(kind) {
        if (kind === 'session') return el.sessionPop;
        if (kind === 'token') return el.tokenPop;
        return el.ctxPop;
    }

    function statsPopBtn(kind) {
        if (kind === 'session') return el.statsSessionBtn;
        if (kind === 'token') return el.statsTokenBtn;
        return el.ctxBtn;
    }

    function hideStatsPops() {
        for (const kind of ['session', 'token', 'ctx']) {
            const pop = statsPopEl(kind);
            if (pop) pop.classList.add('hidden');
        }
        openStatsPop = '';
    }

    function hideCtxPop() {
        hideStatsPops();
    }

    function positionStatsPop(kind) {
        const pop = statsPopEl(kind);
        const btn = statsPopBtn(kind);
        if (!pop || !btn || !el.statsWrap) return;
        const wrapRect = el.statsWrap.getBoundingClientRect();
        const btnRect = btn.getBoundingClientRect();
        const width = pop.offsetWidth || 308;
        const left = Math.max(0, Math.min(Math.max(0, wrapRect.width - width), btnRect.left - wrapRect.left));
        pop.style.left = left + 'px';
        pop.style.right = 'auto';
    }

    function renderSessionPopover() {
        if (!el.sessionPop) return;
        const session = currentSession();
        if (!session) return;
        const totals = sessionUsageTotals(session);
        if (el.sessionPopTurns) el.sessionPopTurns.textContent = totals.rounds + ' 轮 ' + totals.steps + ' 步';
        if (el.sessionModel) el.sessionModel.textContent = totals.modelMs > 0 ? aiFormatCompactDuration(totals.modelMs) : '—';
        if (el.sessionTools) el.sessionTools.textContent = totals.hasTools ? aiFormatCompactDuration(totals.toolMs) : '—';
        if (el.sessionTtft) {
            el.sessionTtft.textContent = totals.ttftAvg > 0
                ? (totals.ttftAvg < 1000 ? (totals.ttftAvg / 1000).toFixed(2) : (totals.ttftAvg / 1000).toFixed(1)) + ' 秒'
                : '—';
        }
        if (el.sessionTps) {
            el.sessionTps.textContent = totals.speed > 0 ? totals.speed + ' tok/s' : '—';
            // gen = 纯生成速度（已扣除首 token 延迟）；e2e = 端到端吞吐（无流式时间戳时的兜底）
            el.sessionTps.dataset.tip = totals.speedKind === 'gen'
                ? '生成速度：输出 tokens ÷（模型往返耗时 − 首 token 延迟）'
                : (totals.speedKind === 'e2e'
                    ? '端到端吞吐：输出 tokens ÷ 模型往返耗时（含首 token 延迟）'
                    : '');
        }
    }

    function renderTokenPopover() {
        if (!el.tokenPop) return;
        const session = currentSession();
        if (!session) return;
        const totals = sessionUsageTotals(session);
        const total = totals.total || (totals.prompt + totals.completion);
        const uncached = Math.max(0, totals.prompt - totals.cached);
        const hitRate = totals.prompt > 0 && totals.cached > 0 ? Math.round(totals.cached / totals.prompt * 100) : -1;
        if (el.tokenPopTotal) el.tokenPopTotal.textContent = total > 0 ? aiFormatExactCount(total) + ' tok' : '—';
        if (el.tokenHit) el.tokenHit.textContent = hitRate >= 0 ? hitRate + '%' : '—';
        if (el.tokenUncached) el.tokenUncached.textContent = totals.prompt > 0 ? aiFormatExactCount(uncached) + ' tok' : '—';
        if (el.tokenCached) el.tokenCached.textContent = totals.cached > 0 ? aiFormatExactCount(totals.cached) + ' tok' : '—';
        if (el.tokenOutput) el.tokenOutput.textContent = totals.completion > 0 ? aiFormatExactCount(totals.completion) + ' tok' : '—';
    }

    function toggleStatsPop(kind) {
        if (openStatsPop === kind) {
            hideStatsPops();
            return;
        }
        hideStatsPops();
        const pop = statsPopEl(kind);
        if (!pop) return;
        pop.classList.remove('hidden');
        openStatsPop = kind;
        positionStatsPop(kind);
        if (kind === 'ctx') void renderCtxPopover(true);
        else if (kind === 'session') renderSessionPopover();
        else renderTokenPopover();
    }

    function toggleCtxPop() {
        toggleStatsPop('ctx');
    }

    return {
        closeTurnUsagePop,
        showTurnUsagePop,
        matchesAnchor,
        openStatsPopKind: () => openStatsPop,
        statsPopEl,
        hideStatsPops,
        hideCtxPop,
        positionStatsPop,
        renderSessionPopover,
        renderTokenPopover,
        toggleStatsPop,
        toggleCtxPop,
        // 面板按 usageMod.sessionUsageTotals 转发（ai-panel.js 的别名），漏了这行启动即
        // TypeError: usageMod.sessionUsageTotals is not a function。统计口径仍是模块级纯函数。
        sessionUsageTotals,
    };
}
