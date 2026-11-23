// ai-scroll-follow.js：AI 消息区「贴底跟随」判定的单一来源。
//
// 只有**用户手势**（滚轮 / 触摸 / 拖滚动条）引起的 scrollTop 变化才算用户接管滚动。布局变化同样会改 scrollTop 与「距底距离」：任务清单、审批卡、消息队列都挂在
// .ai-bottom-stack 这个 overlay 上，出现后消息区靠 padding-bottom 让位（scrollHeight 变大），
// 滚动条 thumb 被顶上去，视觉上就是「滚动条被往上拖」。此时若把「距底 > 80」当成用户上翻，
// 之后流式内容再多也不会再跟到底——用户看到的是「打开任务面板后就不跟随触底了」。
//
// 另一条更容易漏的路径：底部 overlay 收起 / 面板缩放 / 重绘会把 scrollTop 钳小，监听里
// 「scrollTop 比上一帧小 → 用户上滚」的判定同样会被骗。所以判定与手势状态都收在这里，
// 供 ai-panel 的滚动监听与留白刷新共用，并有 ai-scroll-follow.test.mjs 作护栏。

// 距底多少像素以内算「在底部」（恢复贴底 / 判定贴底态）
export const BOTTOM_SLACK = 80;
// 严格贴底：真的停在最底（留白变化后据此自愈「被误判掉的贴底态」）
export const STRICT_BOTTOM_PX = 4;
// 用户手势结束后仍算「用户在滚」的宽限期：覆盖滚轮惯性、触摸惯性、拖拽松手余波
export const USER_SCROLL_GRACE_MS = 900;
// 兜底：连续这么多次 scrollTop 减小（且间隔在窗口内）就当用户拖动。
// 布局变化的一次钳位是「单发」的，攒不到这个次数；而真实拖动 Chromium 逐帧派发 scroll，
// 几乎没有不到 3 次的情况——这条只防「某环境不发 wheel / touch」时用户彻底无法上翻。
export const SHRINK_BURST = 3;
export const SHRINK_BURST_GAP_MS = 150;

function defaultClock() {
    return typeof performance !== 'undefined' && performance && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
}

// 用户手势窗口：note() 刷新宽限期，begin()/end() 覆盖拖拽全程（拖滚动条可以持续几秒，
// 中间不产生 wheel，只靠时间窗会把后段的滚动误判成布局变化）。
export function createScrollGesture(clock) {
    const now = typeof clock === 'function' ? clock : defaultClock;
    let until = -Infinity;
    let held = false;
    const note = (ms) => {
        until = now() + (typeof ms === 'number' ? ms : USER_SCROLL_GRACE_MS);
    };
    return {
        // 滚轮 / 触摸移动：每次输入刷新宽限期
        note,
        // 手指按下 / 触摸开始 / 拖拽开始
        begin() {
            held = true;
        },
        // 松手：结束 hold，但保留一段宽限期吃掉惯性（未处于 hold 时是空操作，
        // 避免点击消息正文后也把「用户在滚」的宽限期续上）
        end(ms) {
            if (!held) return;
            held = false;
            note(ms);
        },
        active() {
            return held || now() <= until;
        },
        reset() {
            held = false;
            until = -Infinity;
        },
    };
}

// 连续减小计数器：给「没有手势事件、但滚得像个真人」的路径兜底
export function createShrinkBurst(clock) {
    const now = typeof clock === 'function' ? clock : defaultClock;
    let count = 0;
    let lastAt = -Infinity;
    return {
        // 记录一次 scrollTop 减小；返回是否已攒到「像用户拖动」
        push() {
            const at = now();
            count = at - lastAt <= SHRINK_BURST_GAP_MS ? count + 1 : 1;
            lastAt = at;
            return count >= SHRINK_BURST;
        },
        reset() {
            count = 0;
            lastAt = -Infinity;
        },
    };
}

// 内容异步长高后要不要补底：工具卡自动展开、截图/图片 onload、widget 出图都只在
// 「贴底态、且当前没有用户手势」时跟随；用户正在读历史就一个字都不动。
export function shouldRefollowGrowth(stickBottom, gap, byUser) {
    if (stickBottom !== true || byUser === true) return false;
    const value = Number(gap);
    if (!Number.isFinite(value)) return false; // 量不到就别动
    return value > STRICT_BOTTOM_PX;
}

// 一次 scroll 事件之后该不该继续贴底。
// prev: {stickBottom, lastTop, byUser}；scroll: {top, distance}
// 返回 {stickBottom, refollow}：refollow=true 表示「贴底态被非用户原因挤离了底部」，调用方补一次贴底。
export function nextStickState(prev, scroll) {
    const stick = !!(prev && prev.stickBottom);
    const lastTop = Number(prev && prev.lastTop) || 0;
    const byUser = !!(prev && prev.byUser);
    const top = Number(scroll && scroll.top) || 0;
    const distance = Number(scroll && scroll.distance);
    const nearBottom = !(distance > BOTTOM_SLACK); // NaN / 负数（顶部 overscroll）都按「在底部」处理
    if (byUser) {
        // 用户往上滚半像素也解除贴底：只按距底判定的话，轻微上翻后下方内容增长不产生
        // scroll 事件（scrollTop 没变），下一帧就会被整段拽回底部
        if (top < lastTop) return {stickBottom: false, refollow: false};
        return {stickBottom: nearBottom, refollow: false};
    }
    // 非用户手势：落在近底（内容变短 / 重排把位置带回来）就恢复贴底，其余一律不夺权
    if (nearBottom) return {stickBottom: true, refollow: false};
    return {stickBottom: stick, refollow: stick};
}
