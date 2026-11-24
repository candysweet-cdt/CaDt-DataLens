// @ts-check
// 操作留痕前端服务：把状态改变类操作格式化成结构化记录，脱敏后攒批交给 Go 落盘。
// 设计约束（docs/unfinished-plans/operation-audit-log.md）：
// - 只记操作摘要，永不记文件正文、剪贴板、API Key / Token；
// - 写失败静默（不打断用户操作），开关关闭时 log() 直接返回；
// - target 里的文件路径由调用方传入，可在配置里注入 relativize 相对化到工作区。

const SECRET_KEY_PATTERN = /(apikey|api[-_]?key|token|secret|password|passwd|pwd|authorization|bearer|private[-_]?key|credential)/i;
const SECRET_MASK = '***';
const LONG_TEXT_MASK = '<长文本>';
const LONG_TEXT_LIMIT = 200;      // detail 内字符串超过该长度按长文本处理
const DETAIL_JSON_LIMIT = 2048;   // 单条 detail 序列化上限，超限整体替换为截断标记
const DETAIL_DEPTH_LIMIT = 3;     // 对象嵌套深度上限，超出记 {…}
const FLUSH_DELAY_MS = 200;       // 攒批窗口
const FLUSH_BATCH_MAX = 20;       // 攒满即发
const RETENTION_DEFAULT = 12;
const RETENTION_MIN = 1;
const RETENTION_MAX = 60;

// 动作大类：设置页筛选用；action 约定为 domain.verb 点分格式。
export const ACTIVITY_DOMAINS = ['file', 'tab', 'workspace', 'view', 'settings', 'plugin', 'ai', 'app', 'activity', 'storage'];

/** @param {*} months */
function clampRetention(months) {
    const n = Math.round(Number(months) || RETENTION_DEFAULT);
    if (!Number.isFinite(n) || n < RETENTION_MIN) return RETENTION_DEFAULT;
    return Math.min(n, RETENTION_MAX);
}

/** @param {*} key */
function looksSecretKey(key) {
    return SECRET_KEY_PATTERN.test(String(key || ''));
}

/** @param {*} value @param {number} depth */
function sanitizeValue(value, depth) {
    if (value == null) return null;
    const type = typeof value;
    if (type === 'string') {
        return value.length > LONG_TEXT_LIMIT ? LONG_TEXT_MASK : value;
    }
    if (type === 'number' || type === 'boolean') return value;
    if (type !== 'object') return String(value).slice(0, LONG_TEXT_LIMIT);
    if (depth >= DETAIL_DEPTH_LIMIT) return Array.isArray(value) ? {length: value.length} : '{…}';
    if (Array.isArray(value)) {
        if (value.length === 0) return [];
        // 数组只记长度摘要，避免整段配置/文件列表进日志（方案第 5 节）。
        return {length: value.length};
    }
    /** @type {Record<string, any>} */
    const out = {};
    for (const [key, val] of Object.entries(value)) {
        out[key] = looksSecretKey(key) ? SECRET_MASK : sanitizeValue(val, depth + 1);
    }
    return out;
}

/**
 * 对操作留痕的 detail 实施脱敏（方案第 5 节）：秘密键打码、长文本截断、
 * 对象降维（数组只记 length）、整体序列化尺寸封顶。
 * @param {*} detail 任意操作详情（原始值 / 对象 / 数组）
 * @returns {object|undefined} 脱敏后的 detail；原始值为 null/undefined 时返回 undefined；
 *   非对象原始值包成 {value}；超尺寸返回 {truncated: true}
 */
export function sanitizeDetail(detail) {
    if (detail == null) return undefined;
    if (typeof detail !== 'object') {
        return {value: sanitizeValue(detail, 0)};
    }
    const sanitized = sanitizeValue(detail, 0);
    if (typeof sanitized !== 'object' || sanitized == null) {
        return {value: sanitized};
    }
    try {
        if (JSON.stringify(sanitized).length > DETAIL_JSON_LIMIT) {
            return {truncated: true};
        }
    } catch (e) {
        return {truncated: true};
    }
    return sanitized;
}

/**
 * 创建操作留痕服务（主入口）：状态改变类操作格式化成结构化记录，脱敏后攒批交给 Go 落盘。
 * 写失败静默（不打断用户操作），开关关闭时 log() 直接返回。
 * @param {object} [deps] 依赖注入
 * @param {{ActivityAppend?: Function}} [deps.backend] 后端绑定对象，需含 ActivityAppend(payload) 方法
 * @param {Record<string, any>|(() => Record<string, any>)} [deps.settings] 设置对象或 () => settings 的 getter；activityLog !== false 时启用，
 *   activityRetentionMonths 控制保留月数（1–60，默认 12）
 * @param {Function} [deps.relativize] 可选，把 target 里的绝对路径转成相对工作区路径
 * @returns {{log: Function, flush: Function, isEnabled: Function}}
 *   log(action, target, detail, opts) 记一条；opts.actor / opts.source 默认 'user'，opts.noRel 保持 target 原样；
 *   flush() 立即清空攒批队列；isEnabled() 返回当前开关状态
 */
export function createActivityLog({backend, settings, relativize} = {}) {
    const conf = typeof settings === 'function' ? settings : () => settings || {};
    /** @type {Record<string, any>[]} */
    let pending = [];
    let timer = 0;
    let seq = 0;

    function isEnabled() {
        return !!(conf().activityLog !== false);
    }

    function flush() {
        if (timer) {
            clearTimeout(timer);
            timer = 0;
        }
        if (!pending.length) return;
        const entries = pending;
        pending = [];
        if (!backend || typeof backend.ActivityAppend !== 'function') return;
        const payload = JSON.stringify({
            entries,
            retentionMonths: clampRetention(conf().activityRetentionMonths),
        });
        try {
            const result = backend.ActivityAppend(payload);
            if (result && typeof result.catch === 'function') {
                // 写失败不影响用户操作；Go 侧有运行日志可查。
                result.catch(() => {});
            }
        } catch (e) {}
    }

    function schedule() {
        if (timer) return;
        timer = setTimeout(() => {
            timer = 0;
            flush();
        }, FLUSH_DELAY_MS);
    }

    /** @param {*} action @param {*} target @param {*} detail @param {{actor?: string, source?: string, noRel?: boolean}} [opts] */
    function log(action, target, detail, opts = {}) {
        if (!isEnabled()) return;
        const actor = opts.actor || 'user';
        const source = opts.source || actor;
        const path = target == null ? '' : String(target);
        // opts.noRel：target 保持原样（如 workspace.open 的根目录本身）。
        pending.push({
            v: 1,
            ts: Date.now(),
            actor,
            source,
            action: String(action || ''),
            target: !opts.noRel && relativize && path ? relativize(path) : path,
            detail: sanitizeDetail(detail),
            seq: ++seq,
        });
        if (pending.length >= FLUSH_BATCH_MAX) {
            flush();
            return;
        }
        schedule();
    }

    return {log, flush, isEnabled};
}
