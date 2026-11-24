// @ts-check
// humanize.js：给人看的「大小 / 时间」格式化唯一来源（零依赖，可放心被任意域 import）。
// 字节数与相对时间此前散落在 settings / ai / shell / app-pages 各域，口径已漂移
// （带不带空格、封顶到哪档、旧时间回退成什么），统一到这里。
// 需要给模型看的紧凑体积（如工具输出）用 formatBytes(n, {compact:true})。

/**
 * 字节数 → 人可读（1024 进制）。默认口径与设置·存储页一致：
 * B/KB/MB/GB/TB，≥100 的档位取整、其余保留 1 位小数、单位前带空格。
 * @param {number} n
 * @param {{compact?:boolean}} [opts] compact=无空格且去尾零（如 '9.2MB'、'5MB'）
 * @returns {string}
 */
export function formatBytes(n, opts = {}) {
    const value = Math.max(0, Number(n) || 0);
    if (value < 1024) return value + (opts.compact ? 'B' : ' B');
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value / 1024;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
    }
    const num = opts.compact
        ? size.toFixed(1).replace(/\.0$/, '')
        : size.toFixed(size >= 100 ? 0 : 1);
    return num + (opts.compact ? '' : ' ') + units[index];
}

/**
 * 完整时间：YYYY-MM-DD HH:mm:ss。非法输入返回「—」。
 * @param {number|Date} ts
 * @returns {string}
 */
export function formatFullTime(ts) {
    const d = ts instanceof Date ? ts : new Date(Number(ts) || 0);
    if (isNaN(d.getTime())) return '—';
    const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前（7 天内）/ 完整时间。
 * 未来时间与超过 7 天的旧时间回退成完整时间，避免「400 天前」这类无信息量文案。
 * @param {number} ts
 * @returns {string}
 */
export function relativeTime(ts) {
    const t = Number(ts) || 0;
    if (!t) return '—';
    const diff = Date.now() - t;
    if (diff < 0) return formatFullTime(t);
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前';
    if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前';
    if (diff < 7 * 86_400_000) return Math.floor(diff / 86_400_000) + ' 天前';
    return formatFullTime(t);
}
