// @ts-check
// notify-throttle.js：通知节流纯逻辑（无状态工厂，测试直接导入）。
//
// 背景：失败提醒改走 toast 后，若不节流，某些后台循环（群聊调度、落盘重试）
// 会在几秒内连弹十几条，反而把用户逼烦。这里按「key + 时间窗口」闸门：
// 同一个 key 在窗口期内只放行第一次，之后静默；窗口过后重新放行。
//
// 与「会话保存失败」那处已有的 30s 局部节流（ai-panel.js 的 sessionStoreErrorAt）
// 是同一思路，这里抽成可复用的纯函数，便于统一口径与单测。

// 创建节流器：返回 (key, nowMs?) => boolean（true=放行，false=窗口内抑制）。
// opts.windowMs 默认 30000；opts.now 可注入时钟便于测试。
// key 集合固定且很小（十几种文案），Map 不会无界增长，无需清理。
/**
 * @param {{windowMs?: number, now?: () => number}} [opts] windowMs 默认 30000；now 可注入时钟（测试用）
 * @returns {(key: string|null|undefined, at?: number) => boolean} true = 放行
 */
export function createNotifyThrottle(opts) {
    const cfg = opts || {};
    const rawWindow = cfg.windowMs;
    const windowMs = typeof rawWindow === 'number' && Number.isFinite(rawWindow) && rawWindow > 0 ? rawWindow : 30000;
    const now = typeof cfg.now === 'function' ? cfg.now : Date.now;
    const lastAt = new Map();
    return function allow(key, at) {
        const k = String(key == null ? '' : key);
        const t = typeof at === 'number' && Number.isFinite(at) ? at : now();
        const prev = lastAt.get(k);
        if (Number.isFinite(prev) && t - prev < windowMs) return false;
        lastAt.set(k, t);
        return true;
    };
}
