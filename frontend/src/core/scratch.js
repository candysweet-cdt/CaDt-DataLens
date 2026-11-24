// @ts-check
// core/scratch.js：临时文件（explorer「新建 → 临时文件」）的目录约定与纯函数。
//
// 方案：docs/finished-plans/scratch-file.md。三条硬约定，动之前先读方案：
//   1. 落 <工作区>/.cadt/scratch/ —— **不进** .cadt/tmp（那是 AI 的免审写区：覆盖同名文件
//      不需要任何确认，一键清缓存还会连草稿一起清），草稿存储条目也刻意 inCache=false；
//   2. 文件名必须带扩展名 —— 高亮 / 可用视图 / 运行配方全靠扩展名分派，应用没有内容嗅探
//      （方案 §6），所以「选语言」等于「选扩展名」；
//   3. 只有带 doc.draft 标记的文档享受「静默落盘 / 关闭空草稿自动删」这两项特权，
//      普通文档的保存语义一点不动。
//
// 本模块只放纯函数与一次 IO 适配（listScratchDrafts），编排在 explorer-ops.js，
// 自动保存的门在 writing-ui.js / editor-groups.js。

export const SCRATCH_DIR_NAME = 'scratch';
// 相对工作区的路径（提示文案与草稿架标题用，永远正斜杠）
export const SCRATCH_SUBDIR = '.cadt/' + SCRATCH_DIR_NAME;
export const DEFAULT_SCRATCH_EXT = '.md';

/** @param {*} text */
function trimTrailingSlash(text) {
    return String(text || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

// normalizeScratchExt：'.md' / 'md' / 'MD' / 空值 → 统一成小写带点的扩展名。
// 扩展名里出现路径分隔符或通配符时只取第一段，宁可回落默认值也不拼出怪异文件名。
/** @param {*} ext */
export function normalizeScratchExt(ext) {
    let text = String(ext == null ? '' : ext).trim();
    if (!text) return DEFAULT_SCRATCH_EXT;
    text = text.split(/[\\/:*?"<>|\s]/)[0];
    if (!text.startsWith('.')) text = '.' + text;
    // 只剩一个点不算扩展名（'.c' 这种单字母扩展名要留着）
    if (text.length < 2) return DEFAULT_SCRATCH_EXT;
    return text.toLowerCase();
}

// scratchExtFromName：从当前文档名取扩展名（编辑器选区建草稿用）；无扩展名回落 .txt
// ——不能用 .md，选中一段 JSONPath 存成 md 会按 Markdown 预览渲染。
/** @param {*} name */
export function scratchExtFromName(name) {
    const base = String(name || '').split(/[\\/]/).pop() || '';
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1) return '.txt';
    return normalizeScratchExt(base.slice(dot));
}

// scratchDir：草稿目录绝对路径；没有工作区时返回空串（调用方据此判「入口不可用」）。
/** @param {*} workspaceFolder */
export function scratchDir(workspaceFolder) {
    const root = trimTrailingSlash(workspaceFolder);
    return root ? root + '/' + SCRATCH_SUBDIR : '';
}

// isScratchPath：路径是否落在本工作区的草稿目录里（大小写不敏感，兼容反斜杠）。
/** @param {*} workspaceFolder @param {*} path */
export function isScratchPath(workspaceFolder, path) {
    const dir = scratchDir(workspaceFolder);
    if (!dir || !path) return false;
    const prefix = dir.toLowerCase() + '/';
    const target = String(path).replace(/\\/g, '/').toLowerCase();
    return target.startsWith(prefix);
}

const pad2 = (/** @type {number} */ n) => String(n).padStart(2, '0');

// scratchStamp：通用秒级时间戳（本地时间，YYYYMMDD-HHMMSS）。
// 不再参与临时文件命名（已对齐 JetBrains 的 scratch[-N] 风格），保留供其他用途。
/** @param {*} now */
export function scratchStamp(now) {
    const d = now instanceof Date ? now : new Date(Number(now) || Date.now());
    return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
        '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

// scratchDraftName：scratch[-N].<ext>（对齐 JetBrains Scratches：scratch.json / scratch_1.json …）。
// seq>0 时加 _1 / _2 后缀（同扩展名撞名递增，见方案 §2 第 1 条）。
/** @param {*} ext @param {number} [seq] */
export function scratchDraftName(ext, seq = 0) {
    const suffix = seq > 0 ? '_' + seq : '';
    return 'scratch' + suffix + normalizeScratchExt(ext);
}

// isBlankDraftText：空白草稿的判据（关闭标签即自动删除）。BOM / 全角空格也算空。
/** @param {*} text */
export function isBlankDraftText(text) {
    return !String(text == null ? '' : text).replace(/^\uFEFF/, '').trim();
}

// listScratchDrafts(io, workspaceFolder, limit)：按修改时间倒序列出草稿。
// io.readDir(path, limit) 就是后端 ReadDir（返回 {entries:[{name,path,isDir,mtime,size}]}）；
// 目录不存在或读取失败一律当「没有草稿」，草稿架不该因为一次 IO 失败就报错。
/**
 * @typedef {{name: string, path: string, isDir: boolean, mtime: *, size: *}} ScratchEntry
 * @param {{readDir: (dir: string, limit: number) => Promise<{entries: ScratchEntry[]}>}} io
 * @param {*} workspaceFolder
 * @param {number} [limit]
 */
export async function listScratchDrafts(io, workspaceFolder, limit = 200) {
    const dir = scratchDir(workspaceFolder);
    if (!dir || !io || typeof io.readDir !== 'function') return [];
    let listing = null;
    try {
        listing = await io.readDir(dir, limit);
    } catch (e) {
        return [];
    }
    const entries = Array.isArray(listing && listing.entries) ? listing.entries : [];
    return entries
        .filter((entry) => entry && !entry.isDir)
        .map((entry) => ({
            name: entry.name,
            path: entry.path,
            size: Number(entry.size) || 0,
            mtime: Number(entry.mtime) || 0,
        }))
        .sort((a, b) => b.mtime - a.mtime);
}
