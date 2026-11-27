// @ts-check
// ai-schedule-scope.js：定时任务的权限档与时间解析纯函数（无 DOM、无后端）。
// 从 ai-schedule.js 抽出，便于表驱动单测与 typecheck。权限档口径与主体系对齐：
//   strictness（越大越严）：full 0 < auto 1 < edit 2 < read 3；inherit 是「继承」哨兵，不参与排序。
// 上限规则（用户定）：显式档不得比 max(目标会话权限, 创建任务时所在会话权限) 更宽。

/** 定时任务可选权限档（含 inherit 哨兵）。 */
export const SCHEDULE_SCOPES = ['inherit', 'read', 'edit', 'auto', 'full'];

/** 严格度：数值越大越严；inherit 不参与比较。 @type {Record<string, number>} */
const STRICTNESS = Object.freeze({full: 0, auto: 1, edit: 2, read: 3});

/**
 * 归一权限档：非法 / 空值回退 inherit；旧 chat 映射为 inherit。
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeScheduleScope(raw) {
    const v = String(raw == null ? '' : raw).trim();
    if (!v || v === 'chat') return 'inherit';
    return SCHEDULE_SCOPES.includes(v) ? v : 'inherit';
}

/**
 * 严格度数值：越宽越小；未知档按最严 read 处理（保守）。
 * @param {string} scope
 * @returns {number}
 */
function strictnessOf(scope) {
    const v = String(scope || '');
    return Object.prototype.hasOwnProperty.call(STRICTNESS, v) ? STRICTNESS[v] : STRICTNESS.read;
}

/**
 * 取两个权限档中「更宽」的一档作为上限（数值越小越宽）。
 * inherit 视作最宽（full），因为它尚未解析——保证上限不会被 inherit 意外收紧。
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
export function widerScope(a, b) {
    const na = normalizeScheduleScope(a);
    const nb = normalizeScheduleScope(b);
    if (na === 'inherit' || nb === 'inherit') return 'full';
    return strictnessOf(na) <= strictnessOf(nb) ? na : nb;
}

/**
 * 计算编辑器里可选的权限档列表： inherit + 不比上限更宽的所有档。
 * @param {string} targetScope 目标会话权限（绑定会话时）；新建会话传空
 * @param {string} currentScope 创建任务时所在会话权限
 * @param {boolean} bound 是否绑定已有会话
 * @returns {string[]} 形如 ['inherit','read',...]
 */
export function scheduleScopeOptions(targetScope, currentScope, bound) {
    const cap = widerScope(bound ? targetScope : currentScope, currentScope);
    const capStrict = strictnessOf(cap);
    const options = ['inherit'];
    for (const s of ['read', 'edit', 'auto', 'full']) {
        if (strictnessOf(s) >= capStrict) options.push(s);
    }
    return options;
}

/**
 * 触发时解析任务真正应采用的权限档。
 * - inherit + 绑定会话 → 目标会话自身权限
 * - inherit + 新建会话 → 设置默认档（settingsDefaultScope）
 * - 显式档 → 直接用（编辑器已保证不越上限）
 * @param {string} taskScope 任务存的 scope
 * @param {string} targetSessionScope 目标会话权限（绑定时）
 * @param {string} settingsDefaultScope 设置里的新会话默认权限
 * @param {boolean} bound 是否绑定已有会话
 * @returns {string} 解析后的具体档（不含 inherit）
 */
export function resolveScheduleScope(taskScope, targetSessionScope, settingsDefaultScope, bound) {
    const s = normalizeScheduleScope(taskScope);
    if (s !== 'inherit') return s;
    if (bound) {
        const t = normalizeScheduleScope(targetSessionScope);
        return t === 'inherit' ? 'read' : t;
    }
    const d = normalizeScheduleScope(settingsDefaultScope);
    return d === 'inherit' ? 'read' : d;
}

/**
 * 把 once 的「倒计时分钟」或「日期时间」输入解析为后端 at 字符串（本地时间）。
 * @param {{mode:'countdown'|'datetime', minutes?:number, datetime?:string, now?:Date}} input
 * @returns {{ok:true, at:string}|{ok:false, error:string}}
 */
export function resolveOnceAt(input) {
    const now = input.now instanceof Date ? input.now : new Date();
    if (input.mode === 'countdown') {
        const mins = Number(input.minutes);
        if (!Number.isFinite(mins) || mins <= 0) return {ok: false, error: '倒计时分钟需为正数'};
        return {ok: true, at: new Date(now.getTime() + mins * 60000).toISOString()};
    }
    const raw = String(input.datetime || '').trim();
    if (!raw) return {ok: false, error: '请选择日期时间'};
    // 自绘控件输出 'YYYY-MM-DD HH:mm[:ss]'（本地时间）；也兼容 ISO 的 T 分隔。
    const m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
    if (!m) return {ok: false, error: '日期时间格式应为 YYYY-MM-DD HH:mm'};
    const local = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    const ms = local.getTime();
    if (!Number.isFinite(ms)) return {ok: false, error: '日期时间无效'};
    if (ms <= now.getTime()) return {ok: false, error: '日期时间需晚于当前时刻'};
    return {ok: true, at: local.toISOString()};
}

/**
 * 判断 once 的现有 at 字符串应回填到「倒计时」还是「日期时间」输入。
 * 距现在 ≤ 24h 视为倒计时（取整分钟），否则日期时间。
 * @param {string} at
 * @param {Date} [now]
 * @returns {{mode:'countdown'|'datetime', minutes:number, datetime:string}}
 */
export function splitOnceAt(at, now) {
    const base = now instanceof Date ? now : new Date();
    const ms = Date.parse(String(at || ''));
    if (!Number.isFinite(ms)) return {mode: 'countdown', minutes: 30, datetime: ''};
    const diffMin = Math.round((ms - base.getTime()) / 60000);
    if (diffMin > 0 && diffMin <= 1440) {
        const d = new Date(ms);
        /** @param {number} n */
        const pad = (n) => String(n).padStart(2, '0');
        return {
            mode: 'countdown',
            minutes: diffMin,
            datetime: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
                'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()),
        };
    }
    const d = new Date(ms);
    /** @param {number} n */
    const pad = (n) => String(n).padStart(2, '0');
    return {
        mode: 'datetime',
        minutes: Math.max(1, diffMin),
        datetime: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
            'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()),
    };
}
