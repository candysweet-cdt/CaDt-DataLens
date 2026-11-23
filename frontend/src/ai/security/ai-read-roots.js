// ai-read-roots.js：工作区外读取的授权判定（纯函数层）。
// 背景：read_file/list_dir 的路径闸 aiResolveScopePath 把工作区根当硬边界，而应用本身
// 是任意路径查看器，用户点名的工作区外文件是高频正当需求。本模块只做判定，授权链路
// （按档分流：auto/full 直读、read/edit 审批、子代理报回指引）在 ai-panel.js 的
// resolveReadPathWithApproval。三层放行依据：
// ① 用户点名——审批只区分「谁想读」，用户在对话里明确给过的路径不再确认；
//    只认真用户消息：app 卡片（结算通知/跨会话投递/定时注入）、子代理 notice、
//    模型派单 task（from:'agent'）都不算点名——注入能改文件内容与模型输出，改不了真用户消息。
// ② 已批准读根——session.readRoots（审批卡「本会话记住」）/ config.approvedReadRoots
//    （「总是」）/ 项目规则 Read(...)（「本项目」），目录树语义（批准目录即批准其子树）。
// ③ 应用数据目录硬拒——含 ai-config.json（API 密钥）与会话数据，任何档位、点名也不放行：
//    密钥一旦被读就进会话 JSONL 落盘，与 activity-log「不存密钥」同一哲学。
import {extractDrivePaths} from './ai-scope-redact.js';

const READ_ROOTS_LIMIT = 200;

// 单条路径归一：反斜杠→正斜杠、去尾分隔符。与 aiPathKey 的比较口径一致。
export function normalizeReadRoot(value) {
    return String(value == null ? '' : value).replace(/\\/g, '/').trim().replace(/\/+$/, '');
}

// 读根列表归一：去空、大小写不敏感去重、上限 200（同 session.approvedPaths 的上限惯例）。
export function normalizeReadRoots(list) {
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(list) ? list : []) {
        const path = normalizeReadRoot(item);
        if (!path) continue;
        const key = path.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(path);
        if (out.length >= READ_ROOTS_LIMIT) break;
    }
    return out;
}

// root 是否覆盖 path（相等或在 root 子树下）。与 ai-panel.js 的 aiPathInside 同式：
// 大小写不敏感、只认完整目录段（root+'/' 前缀），避免 D:/a/b 误伤 D:/a/bc。
export function readRootCovers(root, path) {
    const r = normalizeReadRoot(root).toLowerCase();
    const p = normalizeReadRoot(path).toLowerCase();
    if (!r || !p) return false;
    return p === r || p.startsWith(r + '/');
}

export function readRootCoversAny(roots, path) {
    return (Array.isArray(roots) ? roots : []).some((root) => readRootCovers(root, path));
}

// 把一个新批准的目录并进读根列表：已被覆盖的不重复加；新根覆盖了旧根（批准更大目录）
// 时替换掉被包含的旧根。返回新数组，不改入参。
export function addReadRoot(list, rootDir) {
    const roots = normalizeReadRoots(list);
    const root = normalizeReadRoot(rootDir);
    if (!root || readRootCoversAny(roots, root)) return roots;
    const merged = roots.filter((item) => !readRootCovers(root, item));
    merged.push(root);
    return normalizeReadRoots(merged);
}

// 真用户消息判定：composer 输入的 user 消息。带 app 元数据（应用消息卡片）、
// notice 标记（子代理收件箱消费的注入消息）、from:'agent'（模型派单 task）都不算。
function isGenuineUserMessage(message) {
    return !!message && message.role === 'user' && !message.app && !message.notice && message.from !== 'agent';
}

// 用户是否在会话里点名过该路径（点名的文件/目录与其子树都算）。
// 扫全量 user 消息：只在「工作区外路径解析失败」这条低频路径上调用，成本可忽略。
export function userNamedPath(session, path) {
    const target = normalizeReadRoot(path);
    if (!target) return false;
    const messages = session && Array.isArray(session.messages) ? session.messages : [];
    for (const message of messages) {
        if (!isGenuineUserMessage(message) || typeof message.content !== 'string') continue;
        for (const mentioned of extractDrivePaths(message.content)) {
            if (readRootCovers(mentioned, target)) return true;
        }
    }
    return false;
}

// 产物子目录：与 Go 侧 internal/aiartifact.DirName 同值。它是应用数据目录下**唯一**
// 对 AI 可读的子树——里面只有工具结果全文与子代理转录，既没有密钥（ai-config.json）
// 也没有会话正文（ai-sessions/）。上下文里「全文在 xxx」的指针指的就是这里。
export const ARTIFACT_DIR_NAME = 'ai-artifacts';

// 产物根（appDir/ai-artifacts）；appDir 为空时返回空串。
export function artifactRootOf(appDir) {
    const dir = normalizeReadRoot(appDir);
    return dir ? dir + '/' + ARTIFACT_DIR_NAME : '';
}

// path 是否落在产物子树里。读它就是「读回自己落盘的工具结果」，不走工作区授权链。
export function isArtifactPath(path, appDir) {
    const artifacts = artifactRootOf(appDir);
    return !!artifacts && readRootCovers(artifacts, path);
}

// 应用数据目录硬拒：path 在 appDir 下时返回拒绝文案，否则返回 null。
// 产物子树例外——那是给模型自己落盘、再自己读回用的区域。
export function sensitiveReadDenyReason(path, appDir) {
    const dir = normalizeReadRoot(appDir);
    if (!dir || !readRootCovers(dir, path)) return null;
    if (isArtifactPath(path, appDir)) return null;
    return '拒绝读取：该路径位于应用数据目录（含 API 密钥与会话数据），AI 不读取其中的文件；' +
        '如需查看请用主界面直接打开。';
}

// 扫描类工具（search_text / glob）的起点不能「包含」应用数据目录：目录树语义下会把
// ai-config.json 等密钥文件扫进结果（单文件读取只有目标文件一个入口，不存在这个面）。
// 起点本身位于应用数据目录内的情况由 sensitiveReadDenyReason 负责，这里只挡严格祖先。
export function scanRootDenyReason(root, appDir) {
    const r = normalizeReadRoot(root);
    const dir = normalizeReadRoot(appDir);
    if (!r || !dir) return null;
    if (!readRootCovers(r, dir) || readRootCovers(dir, r)) return null;
    return '拒绝搜索：该目录包含应用数据目录（含 API 密钥与会话数据），AI 不扫描其中内容；' +
        '请把 path 缩小到不含它的子目录。';
}

// 读类工具的硬拒判定（顺序：路径在应用数据目录内 → 扫描起点包含应用数据目录）。
// 必须在作用域解析的最终绝对路径上调用，且先于「在范围内直接放行」——full 档与
// 工作区内路径同样适用；opts.scanRoot 表示 search_text / glob 的目录起点。
export function hardReadDenyReason(path, appDir, opts) {
    const deny = sensitiveReadDenyReason(path, appDir);
    if (deny) return deny;
    return opts && opts.scanRoot ? scanRootDenyReason(path, appDir) : null;
}
