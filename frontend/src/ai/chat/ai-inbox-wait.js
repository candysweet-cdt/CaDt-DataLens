// ai-inbox-wait.js：等待原语（对齐 dsh 的 wait_agent 语义）——等「我自己下一步的新输入」，
// 不消费输入、不指向具体代理。
//
// 为什么这么设计（2026-11-17 五层嵌套实测教训）：
//   旧实现等的是「某个子代理出终态」，于是必须靠守卫补三类坑——子代理把自己算进候选
//   （自等满超时）、跨支定向等被拒、终态记录被 LRU 回收后结论取不到。等自己的收件箱
//   从定义上就没有这三个问题：收件箱是消息流，谁完成谁入队，入队即唤醒。
//
// 只做两件事：
//   1) 有 waiter 时被 notify 唤醒（事件驱动，不轮询等待条件）；
//   2) 心跳只用来检查「调用方已被停止」（用户点停止 / agent_stop / 代理卸载），
//      保证停止后立刻返回，而不是干等到超时。
//
// 竞态闭合顺序：调用方先 onWait 注册，再问 hasPending；注册之前的入队由 hasPending 兜住，
// 注册之后的入队由 notify 兜住——两边都不漏（DSH 的 wait-agent.ts 同样「先订阅再读」）。

const DEFAULT_TICK_MS = 250;

// opts 仅供测试注入时钟；生产不传，走全局 setTimeout。
export function createInboxWaiters(opts) {
    const options = opts || {};
    const setTimer = options.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = options.clearTimeout || ((id) => clearTimeout(id));
    const tickMs = Math.max(10, Number(options.tickMs) || DEFAULT_TICK_MS);

    // ownerId（会话 id / 子代理 id）→ Set<waiter>
    const waiters = new Map();

    function groupOf(ownerId) {
        const key = String(ownerId || '');
        let set = waiters.get(key);
        if (!set) {
            set = new Set();
            waiters.set(key, set);
        }
        return set;
    }

    // 落定一次等待：清理定时器 + 出表 + resolve。done 标记保证幂等（去重后可能被多次触发）。
    function settle(waiter, result) {
        if (waiter.done) return false;
        waiter.done = true;
        if (waiter.deadlineTimer) clearTimer(waiter.deadlineTimer);
        if (waiter.pollTimer) clearTimer(waiter.pollTimer);
        waiter.deadlineTimer = 0;
        waiter.pollTimer = 0;
        const set = waiters.get(waiter.ownerId);
        if (set) {
            set.delete(waiter);
            if (!set.size) waiters.delete(waiter.ownerId);
        }
        waiter.resolve(result);
        return true;
    }

    // 等下一次新输入。
    //   timeoutMs：最长等待毫秒数，0 = 不限时
    //   hasPending()：调用方判断「现在有没有待消费输入」（主代理查信箱、子代理查收件箱）
    //   isStopped()：调用方是否已被停止（用户停止 / agent_stop）
    // 返回 {timedOut, source?}：false = 有新输入可消费（经 notify 唤醒时 source 标明来源）；
    // true = 超时或被停止（stopped 标记区分）。
    function wait(ownerId, config) {
        const cfg = config || {};
        const hasPending = typeof cfg.hasPending === 'function' ? cfg.hasPending : () => false;
        const isStopped = typeof cfg.isStopped === 'function' ? cfg.isStopped : () => false;
        const timeoutMs = Math.max(0, Number(cfg.timeoutMs) || 0);
        // 落地即返回。**先判停止**：用户刚点停止时即便信箱有积压，也该如实回「被停止」，
        // 而不是让模型以为「有新输入」继续跑；再判已有输入（避免明明有消息还睡一轮）。
        if (isStopped()) return Promise.resolve({timedOut: true, stopped: true});
        if (hasPending()) return Promise.resolve({timedOut: false});
        return new Promise((resolve) => {
            const waiter = {
                ownerId: String(ownerId || ''),
                done: false,
                resolve,
                deadlineTimer: 0,
                pollTimer: 0,
            };
            groupOf(waiter.ownerId).add(waiter);
            if (timeoutMs > 0) {
                waiter.deadlineTimer = setTimer(() => settle(waiter, {timedOut: true}), timeoutMs);
            }
            const poll = () => {
                if (waiter.done) return;
                if (isStopped()) {
                    settle(waiter, {timedOut: true, stopped: true});
                    return;
                }
                if (hasPending()) {
                    settle(waiter, {timedOut: false});
                    return;
                }
                waiter.pollTimer = setTimer(poll, tickMs);
            };
            waiter.pollTimer = setTimer(poll, tickMs);
        });
    }

    // 有新输入入队：唤醒该 owner 的全部 waiter（多个 waiter 同时等同一会话是合法的）。
    // 注意语义：notify 只表示「有新东西排队」，真正的注入仍在轮边界做——
    // 若把 notify 当成「立即注入」，会破坏轮次模型（消息在工具调用中间插进上下文）。
    // source：唤醒来源（'steer' 用户插话 / 'notice' 代理通知 / 'agent' 子代理收件箱），
    // 随结果带回给调用方分文案；排队车道（queue）不打扰等待，不走 notify。
    function notify(ownerId, source) {
        const set = waiters.get(String(ownerId || ''));
        if (!set || !set.size) return 0;
        // source 缺省时保持旧结果形状（不带 source 键）：消费方与既有断言都不受影响。
        const result = source === undefined ? {timedOut: false} : {timedOut: false, source};
        let n = 0;
        for (const waiter of [...set]) {
            if (settle(waiter, result)) n++;
        }
        return n;
    }

    // 调用方被停止 / 卸载：立刻放行所有等待，别让它干等满超时。
    function cancel(ownerId) {
        const set = waiters.get(String(ownerId || ''));
        if (!set || !set.size) return 0;
        let n = 0;
        for (const waiter of [...set]) {
            if (settle(waiter, {timedOut: true, stopped: true})) n++;
        }
        return n;
    }

    function sizeOf(ownerId) {
        const set = waiters.get(String(ownerId || ''));
        return set ? set.size : 0;
    }

    // 全部放行（窗口卸载 / 会话清理）：之后 waiter 表为空，不泄漏定时器。
    function clear() {
        let n = 0;
        for (const set of [...waiters.values()]) {
            for (const waiter of [...set]) {
                if (settle(waiter, {timedOut: true, stopped: true})) n++;
            }
        }
        waiters.clear();
        return n;
    }

    return {wait, notify, cancel, sizeOf, clear};
}
