// ai-session-merge.js：磁盘全量重读结果与内存会话的合并（纯函数）。
//
// 背景：打开面板 / 别的窗口写过东西时，面板会走「loadMetas → flush → loadAll → 整份替换
// sessions」这条重读链。loadAll 要整份重放所有会话正文（会话多时秒级），这段窗口里用户
// 对**任何**会话做的元数据改动（改名 / 置顶 / 归档 / 分组 / 未读 / 待办）只会写内存与
// 磁盘队列，等 next 到达时被磁盘版本整份覆盖——「刚置顶的又没了」。
//
// 判定依据是 store 在 writeMetaIfChanged 里打的 `_metaWrittenAt`（本窗口真正写 meta 的
// 时刻）：只有「本轮读盘开始之后」被本窗口写过的会话才保留内存 meta；更早的写入在
// flush 之后已经在磁盘上了，用磁盘版本结果相同。
//
// 只搬 meta 字段：正文相关（messageCount / archivedCount / turnTs / endTs，以及
// messages / archived / _mids / _fps / _logStat 等）一律以磁盘版本为准，避免把落后的
// 内存正文当成新版写回去。

// 由正文派生、不能拿内存值覆盖磁盘的 meta 键。
const BODY_DERIVED_KEYS = new Set(['v', 'messageCount', 'archivedCount', 'turnTs', 'endTs']);

/**
 * 用「本轮读盘开始之后被本窗口写过的会话」的内存 meta 覆盖磁盘结果。
 * @param {Array<object>} memory 当前内存里的 sessions
 * @param {Array<object>} next loadAll 读回来的会话（会被就地修改并返回）
 * @param {{readStartedAt?: number, metaOf?: (session: object) => object}} opts
 *   metaOf：把会话对象转成 meta.json 形态（传 buildSessionMeta）
 * @returns {Array<object>} next
 */
export function mergeLoadedSessions(memory, next, opts = {}) {
    if (!Array.isArray(next)) return Array.isArray(next) ? next : [];
    const metaOf = typeof opts.metaOf === 'function' ? opts.metaOf : null;
    if (!metaOf) return next;
    const readStartedAt = Number(opts.readStartedAt) || 0;
    const memoryById = new Map();
    for (const session of Array.isArray(memory) ? memory : []) {
        if (session && session.id) memoryById.set(session.id, session);
    }
    for (const disk of next) {
        if (!disk || !disk.id) continue;
        const live = memoryById.get(disk.id);
        if (!live) continue;
        if (!(Number(live._metaWrittenAt) > readStartedAt)) continue;
        const meta = metaOf(live);
        if (!meta || typeof meta !== 'object') continue;
        for (const key of Object.keys(meta)) {
            if (BODY_DERIVED_KEYS.has(key)) continue;
            disk[key] = meta[key];
        }
    }
    return next;
}
