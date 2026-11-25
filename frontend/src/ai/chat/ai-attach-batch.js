// ai-attach-batch.js：外部拖放「一次拖多个文件进 AI 面板」的纯逻辑（去重 + 汇总文案）。
//
// 附件的构造与准入在 ai-composer.js（图片降采样 / 视频校验 / 张数与预算），这里只做两件
// 可离线推演的事：① 批内按路径去重（含「输入区已有同路径附件」）；② 结束时给用户的
// 一句话汇总。分开是为了让这两条规则能在 node 里直接测，不必搭 DOM。

// attachPathKey 路径比较键：Windows 下大小写不敏感，反斜杠统一成正斜杠。
function attachPathKey(path) {
    return String(path == null ? '' : path).trim().replace(/\\/g, '/').toLowerCase();
}

/**
 * dedupeAttachPaths 批内 + 与已有附件去重，保留拖入顺序。
 * @param {string[]} paths 本次拖入的路径
 * @param {string[]} [existing] 已经在输入区里的附件路径（只有带 path 的附件才算）
 * @returns {{paths: string[], skipped: number}} skipped = 被判定为重复而跳过的条数
 */
export function dedupeAttachPaths(paths, existing) {
    const seen = new Set();
    for (const path of existing || []) {
        const key = attachPathKey(path);
        if (key) seen.add(key);
    }
    const out = [];
    let skipped = 0;
    for (const raw of paths || []) {
        const path = String(raw == null ? '' : raw).trim();
        if (!path) {
            skipped++;
            continue;
        }
        const key = attachPathKey(path);
        if (seen.has(key)) {
            skipped++;
            continue;
        }
        seen.add(key);
        out.push(path);
    }
    return {paths: out, skipped};
}

/**
 * attachSummary 附加结果汇总文案（空串 = 不必提示）。
 * 单条成功不打扰（用户看得见 chip），多条或确实有跳过时给一句。
 * @param {number} attached 成功附加条数
 * @param {number} skipped 跳过条数（重复 / 触上限 / 处理失败）
 * @returns {string}
 */
export function attachSummary(attached, skipped) {
    const ok = Math.max(0, Number(attached) || 0);
    const skip = Math.max(0, Number(skipped) || 0);
    if (skip > 0) return '已附加 ' + ok + ' 个文件，跳过 ' + skip + ' 个';
    if (ok > 1) return '已附加 ' + ok + ' 个文件';
    return '';
}
