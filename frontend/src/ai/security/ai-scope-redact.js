// ai-scope-redact.js：非完全权限档回给模型的**成段文本**里，收敛真实绝对路径。
// 单条路径的显示口径在 ai-panel.js 的 aiDisplayPath（工作区内用相对路径、范围外只留文件名）；
// 这里处理的是自由文本——Go 后端报错会带完整路径，例如
// `GetFileAttributesEx D:/…/小说/番外0007.md: The system cannot find the path specified.`，
// 只读档下不该把盘符、用户名与目录结构发回给模型。边界口径与 aiResolveScopePath 一致：
// 只有 full（完全权限）不设边界，其余档（read/edit/auto）一律收敛。

// 工作区内的路径统一用这个记号打头，既保留「哪个文件」的信息，又不暴露真实根。
export const SCOPE_ROOT_MARK = '<工作区>';
// 工作区外的绝对路径只留文件名（与 aiDisplayPath 的口径一致）。
export const OUT_OF_SCOPE_MARK = '（范围外）';

// 盘符绝对路径：正反斜杠都算分隔符。字符类里排除空白、引号、竖线与中英文句读，
// 避免把 `D:/a/b.md: The system…` 里的说明文字一起吃进路径。
const DRIVE_TOKEN_RE = /(^|[^\w])([A-Za-z]:[\\/][^\s"'|<>，。；、：（）【】「」]*)/g;

// 反斜杠→正斜杠是 1 比 1 替换，长度不变，因此可以在归一化副本上找位置、回原文切片。
function flattenSlashes(text) {
    return text.replace(/\\/g, '/');
}

function basenameOf(path) {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
}

// 把工作区根（大小写不敏感、两种分隔符）替换成 SCOPE_ROOT_MARK。
// 只认完整目录段：根后面必须是分隔符或结束，避免 `D:/a/b` 误伤 `D:/a/bc`。
function replaceScopeRoot(source, root) {
    const needle = flattenSlashes(String(root == null ? '' : root)).trim().replace(/\/+$/, '');
    if (!needle) return source;
    const flat = flattenSlashes(source);
    const hay = flat.toLowerCase();
    const lower = needle.toLowerCase();
    let out = '';
    let head = 0;
    let from = 0;
    for (;;) {
        const at = hay.indexOf(lower, from);
        if (at < 0) break;
        const next = flat.charAt(at + lower.length);
        if (next && next !== '/') {
            from = at + 1;
            continue;
        }
        out += source.slice(head, at) + SCOPE_ROOT_MARK;
        head = at + lower.length;
        from = head;
    }
    return out + source.slice(head);
}

// 残余的盘符绝对路径（非完全权限档本来不该出现）统一抹成「（范围外）文件名」。
function maskDrivePaths(text) {
    return text.replace(DRIVE_TOKEN_RE, (match, lead, token) => {
        // 末尾的句读/冒号是句子标点，不属于路径本身（Go 报错是 `…md: The system cannot…`）
        const trail = (token.match(/[:.,;]+$/) || [''])[0];
        const core = trail ? token.slice(0, token.length - trail.length) : token;
        const name = basenameOf(core);
        return lead + (name ? OUT_OF_SCOPE_MARK + name : OUT_OF_SCOPE_MARK) + trail;
    });
}

// scope !== 'full' 时收敛文本里的绝对路径；full 档原样返回（完全权限下模型本就该看到真实路径）。
export function redactScopePaths(text, root, scope) {
    const source = String(text == null ? '' : text);
    if (!source || scope === 'full') return source;
    return maskDrivePaths(replaceScopeRoot(source, root));
}

// 提取文本里的盘符绝对路径（末尾句读剥离，反斜杠归一为正斜杠），供「用户点名路径」判定
// （ai-read-roots.js 的 userNamedPath）与路径脱敏共用同一套 token 语义。
export function extractDrivePaths(text) {
    const source = String(text == null ? '' : text);
    if (!source) return [];
    const out = [];
    for (const match of source.matchAll(DRIVE_TOKEN_RE)) {
        const token = match[2];
        // 末尾的句读/冒号是句子标点，不属于路径本身（与 maskDrivePaths 同口径）
        const trail = (token.match(/[:.,;]+$/) || [''])[0];
        const core = trail ? token.slice(0, token.length - trail.length) : token;
        if (core) out.push(core.replace(/\\/g, '/'));
    }
    return out;
}
