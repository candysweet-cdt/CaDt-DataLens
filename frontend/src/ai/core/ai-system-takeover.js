// ai-system-takeover.js：系统接管的注册表与倒计时（无 DOM 的纯状态机）。
// 只服务「应用发起、模型不可见」的接管请求（如思考循环守卫）：结算结果只回给调用方，
// 不生成任何 user / tool 消息，绝不进入模型上下文；ask_user / 审批等模型可见交互仍走各自通道。

function defaultSetTimer(fn, ms) {
    return setTimeout(fn, ms);
}

function defaultClearTimer(id) {
    clearTimeout(id);
}

export function createSystemTakeoverHost(options) {
    const source = options && typeof options === 'object' ? options : {};
    const now = typeof source.now === 'function' ? source.now : Date.now;
    const setTimer = typeof source.setTimer === 'function' ? source.setTimer : defaultSetTimer;
    const clearTimer = typeof source.clearTimer === 'function' ? source.clearTimer : defaultClearTimer;
    const onChange = typeof source.onChange === 'function' ? source.onChange : () => {};
    const entries = new Map();
    let seq = 0;

    function finish(entry, value, kind, reason) {
        if (!entry || entry.state !== 'pending') return false;
        entry.state = 'settled';
        entry.value = value;
        entry.source = kind || 'user';
        entry.reason = String(reason || '');
        entry.settledAt = now();
        if (entry.timer) {
            clearTimer(entry.timer);
            entry.timer = 0;
        }
        entries.delete(entry.key);
        entry.resolve({value, source: entry.source, reason: entry.reason});
        onChange('settle', entry);
        return true;
    }

    function request(spec) {
        const input = spec && typeof spec === 'object' ? spec : {};
        const actions = (Array.isArray(input.actions) ? input.actions : [])
            .filter((action) => action && action.value != null);
        if (!actions.length) throw new Error('系统接管至少需要一个动作');
        const key = String(input.key || 'sys-' + (++seq));
        if (entries.has(key)) throw new Error('系统接管 key 已存在：' + key);
        let timeoutValue = input.timeoutValue;
        if (timeoutValue == null) {
            const fallback = actions.find((action) => action.default) || actions[actions.length - 1];
            timeoutValue = fallback.value;
        }
        if (!actions.some((action) => action.value === timeoutValue)) {
            throw new Error('timeoutValue 不在 actions 中');
        }
        const timeoutSec = Math.max(0, Number(input.timeoutSec) || 0);
        const requestedAt = now();
        const entry = {
            key,
            spec: {...input, actions},
            sessionId: String(input.sessionId || ''),
            priority: Number(input.priority) || 0,
            state: 'pending',
            requestedAt,
            deadline: timeoutSec > 0 ? requestedAt + timeoutSec * 1000 : 0,
            timer: 0,
            resolve: null,
        };
        const done = new Promise((resolve) => {
            entry.resolve = resolve;
        });
        if (timeoutSec > 0) {
            entry.timer = setTimer(() => {
                if (entry.state !== 'pending') return;
                finish(entry, timeoutValue, 'timeout', '');
            }, timeoutSec * 1000);
        }
        entries.set(key, entry);
        onChange('request', entry);
        return {key, entry, done};
    }

    function get(key) {
        return entries.get(String(key)) || null;
    }

    function settle(key, value, kind, reason) {
        return finish(get(key), value, kind || 'user', reason);
    }

    function cancel(key, reason) {
        return finish(get(key), null, 'cancelled', reason || 'cancelled');
    }

    function cancelBySession(sessionId, reason) {
        const id = String(sessionId || '');
        let count = 0;
        for (const entry of [...entries.values()]) {
            if (entry.sessionId !== id) continue;
            if (finish(entry, null, 'cancelled', reason || 'cancelled')) count += 1;
        }
        return count;
    }

    // 同会话多个待接管时取优先级最高的；同优先级按先来后到，保证不会因为 Map 顺序漂移。
    function pick(sessionId) {
        const id = String(sessionId || '');
        let best = null;
        for (const entry of entries.values()) {
            if (entry.sessionId !== id) continue;
            if (!best || entry.priority > best.priority ||
                (entry.priority === best.priority && entry.requestedAt < best.requestedAt)) {
                best = entry;
            }
        }
        return best;
    }

    function pendingOf(sessionId) {
        const id = String(sessionId || '');
        return [...entries.values()]
            .filter((entry) => entry.sessionId === id)
            .sort((a, b) => (b.priority - a.priority) || (a.requestedAt - b.requestedAt));
    }

    function remainingMs(entry) {
        if (!entry || !entry.deadline) return 0;
        return Math.max(0, entry.deadline - now());
    }

    function remainingSec(entry) {
        if (!entry || !entry.deadline) return 0;
        return Math.ceil(remainingMs(entry) / 1000);
    }

    function size() {
        return entries.size;
    }

    return {
        request, settle, cancel, cancelBySession, pick, get, pendingOf,
        remainingMs, remainingSec, size,
    };
}
