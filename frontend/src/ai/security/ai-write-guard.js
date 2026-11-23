// ai-write-guard.js：write_file 陈旧缓冲防护（并发会话覆盖丢码防线）。
// 背景：write_file 是「整文件覆盖」语义——会话拿着旧缓冲调用时会把其他会话/外部程序
// 在此期间写入的内容静默清掉。edit_file（执行时重读盘 + oldString 严格唯一匹配）与
// propose_patch（两阶段严格匹配 + 应用前快照）天然不受陈旧缓冲影响，不走本闸门。
// 机制：每个会话对每个路径记「最后一次读取」的磁盘指纹（mtime，来自 Go OpenFile 的
// FileData.Mtime，UnixNano 字符串）；write_file 覆盖已存在文件前比对——本会话没读过
// → 拒绝；读过但磁盘已变化 → 拒绝并提示重读。落盘走 SaveFileChecked（expectMtime）
// 再做一道竞态兜底，与编辑器保存冲突保护（main.js 的 diskMtime）同一思想。
// 指纹只挂运行时内存（session._readStats 下划线字段，同 ai-session-store 的 _mids 等
// 先例），不进持久化；应用重启后由首次 read_file 重建。

const READ_STATS_FIELD = '_readStats';

function readStatsOf(session) {
    if (!session || typeof session !== 'object') return null;
    if (!(session[READ_STATS_FIELD] instanceof Map)) session[READ_STATS_FIELD] = new Map();
    return session[READ_STATS_FIELD];
}

function normalizeMtime(value) {
    return value == null ? '' : String(value);
}

// 读取成功后记录指纹（read_file 执行成功时调用；offset 只影响展示，不影响指纹）
export function recordRead(session, path, mtime, size) {
    const stats = readStatsOf(session);
    if (!stats || !path) return;
    stats.set(String(path), {
        mtime: normalizeMtime(mtime),
        size: Math.max(0, Math.round(Number(size) || 0)) || null,
        at: Date.now(),
    });
}

// 写入成功后回写指纹（SaveFileChecked 返回新 mtime）：同会话对该文件的后续写入不需重读
export function recordWrite(session, path, mtime) {
    const stats = readStatsOf(session);
    if (!stats || !path) return;
    stats.set(String(path), {
        mtime: normalizeMtime(mtime),
        size: null, // 写入结果只有 mtime，新尺寸未知；下次读取时补上
        at: Date.now(),
    });
}

// 校验 write_file 对已存在文件的写入新鲜度：
// - 新文件（exists=false）：无覆盖风险，直接放行
// - 本会话从未读过该文件：硬拒绝——凭旧记忆整体覆盖正是并发丢码的形态
// - 读过但磁盘 mtime 与记录不一致：拒绝并提示重读
export function checkWriteFresh(session, path, disk, label) {
    const info = disk || {};
    if (!info.exists) return {ok: true};
    const shown = label || path || '该文件';
    const stats = readStatsOf(session);
    const last = stats ? stats.get(String(path)) : null;
    if (!last) {
        return {
            ok: false,
            reason: 'unread',
            message: '拒绝写入：' + shown + ' —— 本会话尚未 read_file 读取该文件。' +
                '整体覆盖会静默丢弃其他会话或外部程序写入的内容；请先 read_file 确认当前内容后再写入' +
                '（若只改局部，建议改用 edit_file 做最小替换）。',
        };
    }
    const diskMtime = normalizeMtime(info.mtime);
    if (diskMtime !== last.mtime) {
        const sizeNote = (last.size != null && info.size != null && Number(info.size) !== last.size)
            ? '，大小 ' + last.size + ' → ' + Number(info.size) + ' 字节'
            : '';
        return {
            ok: false,
            reason: 'stale',
            message: '拒绝写入：' + shown + ' —— 文件在本会话读取后已被外部修改' +
                (sizeNote ? '（' + sizeNote.slice(2) + '）' : '') +
                '。为避免覆盖他人改动，请先 read_file 重新读取当前内容再重试' +
                '（局部修改建议用 edit_file）。',
        };
    }
    return {ok: true};
}
