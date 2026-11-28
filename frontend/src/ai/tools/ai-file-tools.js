// ai-file-tools.js：AI 文件类工具的纯函数（read_file 窗口切片 / edit_file 定位 /
// search_text 通配过滤 / list_dir 人类可读大小 / browser_navigate 的 file:// 解析）。
// ai-panel.js 超线只减不增，这些逻辑从 executeTool 各 case 抽到这里，
// 配套测试见 ai-file-tools.test.mjs。
import {formatBytes} from '../../core/humanize.js';

export const AI_READ_MAX_CHARS = 64 << 10;

// —— read_file ——

// 归一化读取窗口参数：字符模式（offset/limit）与行号模式（startLine/endLine）互斥。
// 不变量不满足时 throw，错误消息会作为工具结果回给模型。
export function normalizeReadWindow(input) {
    const raw = input || {};
    const hasChars = raw.offset != null || raw.limit != null;
    const hasLines = raw.startLine != null || raw.endLine != null;
    if (hasChars && hasLines) {
        throw new Error('offset/limit 与 startLine/endLine 不能混用：字符分页用 offset+limit，按行读取用 startLine+endLine');
    }
    if (hasLines) {
        const startLine = Math.max(1, Math.round(Number(raw.startLine) || 1));
        let endLine = null;
        if (raw.endLine != null) {
            endLine = Math.round(Number(raw.endLine));
            if (!Number.isFinite(endLine) || endLine < 1) endLine = 1;
            if (endLine < startLine) {
                throw new Error('endLine（' + endLine + '）不能小于 startLine（' + startLine + '）');
            }
        }
        return {mode: 'lines', startLine, endLine};
    }
    let offset = Math.round(Number(raw.offset) || 0);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;
    let limit = raw.limit == null ? AI_READ_MAX_CHARS : Math.round(Number(raw.limit));
    if (!Number.isFinite(limit) || limit < 1) {
        throw new Error('limit 至少为 1（当前不传即默认上限 ' + AI_READ_MAX_CHARS + '）');
    }
    return {mode: 'chars', offset, limit: Math.min(limit, AI_READ_MAX_CHARS)};
}

// 按归一化参数切窗口。行号模式输出带右对齐行号 + tab 前缀（对齐编辑器行号；
// 仅供模型引用，edit_file 的 oldString 用不含前缀的原文），截断时给出续读提示。
export function readWindowOf(text, params) {
    const raw = String(text == null ? '' : text);
    const p = params;
    if (p.mode === 'lines') {
        // 与编辑器行号一致：按 \n 切，文件以换行结尾时最后一段不算一行
        const lines = raw.split('\n');
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        const totalLines = lines.length;
        const startLine = Math.min(p.startLine, Math.max(1, totalLines));
        const endLine = Math.min(p.endLine == null ? totalLines : p.endLine, totalLines);
        if (p.startLine > totalLines) {
            return {text: '', hint: '行号超出范围：文件共 ' + totalLines + ' 行', targetLine: totalLines,
                startLine: null, endLine: null, truncated: false, nextStartLine: null, totalLines};
        }
        const width = String(totalLines).length;
        let out = '';
        let truncated = false;
        let nextStartLine = null;
        for (let i = startLine; i <= endLine; i++) {
            const line = lines[i - 1].replace(/\r$/, '');
            const piece = String(i).padStart(width) + '\t' + line + '\n';
            if (out.length + piece.length > AI_READ_MAX_CHARS) {
                truncated = true;
                nextStartLine = i;
                break;
            }
            out += piece;
        }
        if (!out) out = '（空行区间）\n';
        const hint = truncated ? '…（已截断，继续读请 startLine=' + nextStartLine + '）' : '';
        return {text: out, hint, targetLine: startLine, startLine, endLine,
            truncated, nextStartLine, totalLines};
    }
    // 字符模式：无前缀，保持历史输出格式
    const offset = Math.min(p.offset, raw.length);
    const slice = raw.slice(offset, offset + p.limit);
    const truncated = offset + slice.length < raw.length;
    const targetLine = offset > 0 ? (raw.slice(0, offset).match(/\n/g) || []).length + 1 : 1;
    let hint = '';
    if (truncated) hint = '…（已截断，继续读请 offset=' + (offset + slice.length) + '）';
    else if (offset > 0 && !raw.length) hint = '（空文件）';
    else if (offset >= raw.length && raw.length) hint = '（offset 已到文件末尾，共 ' + raw.length + ' 字符）';
    return {text: slice, hint, targetLine, startLine: null, endLine: null,
        truncated, nextOffset: offset + slice.length, totalLines: null};
}

// —— edit_file ——

// 定位 oldString：默认要求恰好命中一处；CRLF 文件且精确匹配失败时按文件换行重试一次。
// replaceAll=true 时多处命中改为全量替换。返回 {next, count} 或 {error}。
export function locateEditTarget(text, oldString, newString, replaceAll) {
    let needle = oldString;
    let replacement = newString;
    let first = text.indexOf(needle);
    if (first < 0 && text.includes('\r\n') && !oldString.includes('\r')) {
        needle = oldString.replace(/\r?\n/g, '\r\n');
        replacement = newString.replace(/\r?\n/g, '\r\n');
        first = text.indexOf(needle);
    }
    if (first < 0) {
        return {error: '未找到 oldString，请先 read_file 并逐字复制（注意缩进与换行）'};
    }
    let count = 1;
    let at = first;
    while ((at = text.indexOf(needle, at + needle.length)) >= 0) count++;
    if (count > 1 && !replaceAll) {
        return {error: 'oldString 多处命中（' + count + ' 处），请提供更长的唯一上下文，或传 replaceAll=true 全部替换'};
    }
    const next = replaceAll
        ? text.split(needle).join(replacement)
        : text.slice(0, first) + replacement + text.slice(first + needle.length);
    return {next, count, needle, replacement};
}

// —— list_dir ——

// 字节数的人类可读形式（1024 基，紧凑无空格、去尾零）—— 格式化实现统一到 core/humanize.js。
// 保留旧守卫：非有限值/负数返回空串，调用方据此不显示大小（喂给模型的工具输出里显示「0B」会误导）。
export function humanSizeBytes(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return '';
    return formatBytes(v, {compact: true});
}

// list_dir 递归树（Go ReadDirTree 的结果）→ ├──/└── 文本。目录名带 / 后缀，
// 文件带人类可读大小；Omitted 目录补一行「…（还有条目未列出）」。
// 节点结构见 app_fs.go DirTreeNode；nodes 传 null 时返回占位（空目录）。
export function renderDirTreeText(nodes) {
    const lines = [];
    const walk = (children, prefix) => {
        const list = Array.isArray(children) ? children : [];
        for (let i = 0; i < list.length; i++) {
            const node = list[i] || {};
            const last = i === list.length - 1;
            const branch = last ? '└── ' : '├── ';
            if (node.isDir) {
                lines.push(prefix + branch + (node.name || '') + '/');
            } else {
                const sizeText = humanSizeBytes(node.size);
                lines.push(prefix + branch + (node.name || '') + (sizeText ? '（' + sizeText + '）' : ''));
            }
            if (node.isDir && Array.isArray(node.children) && node.children.length) {
                walk(node.children, prefix + (last ? '    ' : '│   '));
            }
            if (node.isDir && node.omitted) {
                lines.push(prefix + (last ? '    ' : '│   ') + '…（还有条目未列出）');
            }
        }
    };
    walk(nodes, '');
    return lines;
}

// —— search_text ——

// 文件名/相对路径通配：* 任意串、** 跨目录、? 单字符（都不跨 /，** 除外）；
// **/ 可匹配「零个目录段」（src/**/*.js 命中 src/a.js）；模式含 / 时匹配相对路径，
// 否则匹配文件名；大小写不敏感（Windows 语义）。Go 侧 globMatchPath 与本函数同规则。
export function globMatchPath(pattern, relPath, name) {
    const pat = String(pattern || '').trim();
    if (!pat) return true;
    const subject = String(relPath || '').replace(/\\/g, '/');
    const target = pat.includes('/') ? subject : String(name || subject.split('/').pop() || '');
    const wildcard = pat.replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0000');
    let re = '';
    for (const ch of wildcard) {
        if (ch === '\u0001') re += '(?:.*/)?';
        else if (ch === '\u0000') re += '.*';
        else if (ch === '*') re += '[^/]*';
        else if (ch === '?') re += '[^/]';
        else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    try {
        return new RegExp('^' + re + '$', 'i').test(target);
    } catch (e) {
        // 非法模式按「不过滤」处理，避免一次坏参数把搜索整个打挂
        return true;
    }
}

// —— 附件路径引用（非文本文件不读内容，只投递路径 + 读法）——

// 按扩展名给出的处理建议。对齐 ZCode 的 resolvedPathReferenceAttachment：
// 二进制/超大文件既不原样传（会炸上下文）也不静默丢弃（用户以为发过去了），
// 而是让模型拿路径 + 明确的读法自己去取。
const ATTACHMENT_HINTS = [
    {ext: ['pdf'], how: '用 ocr 工具识别其中的文字（扫描件用 rich_layout_recognition），或加载 pdf 技能处理'},
    {ext: ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt'], how: '用 ocr 工具读取，或加载 docx 技能处理'},
    {ext: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'], how: '先用命令解压到 .cadt/tmp/ 再看里面的文件'},
    {ext: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'], how: '用 read_image 工具把画面附加到对话'},
    {ext: ['mp4'], how: '用 read_video 工具把视频附加到对话（需 OpenAI 兼容协议）'},
    {ext: ['mp3', 'wav', 'm4a', 'ogg', 'flac'], how: '用 text_to_speech 之外的路径无法直接听，可先用命令转文字再 read_file'},
];

// attachmentPathHint(path, reason) → 注入 <attachments> 的说明文本。
// reason: 'binary'（二进制不可当文本读）| 'large'（超过文本读取上限）。
// 返回空串表示路径为空（调用方据此跳过）。
export function attachmentPathHint(path, reason) {
    const clean = String(path || '').trim();
    if (!clean) return '';
    const name = clean.replace(/\\/g, '/').split('/').pop() || clean;
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    const matched = ATTACHMENT_HINTS.find((entry) => entry.ext.includes(ext));
    const how = matched
        ? matched.how
        : '用 read_file 工具读取（若是二进制，改用对应技能或命令处理）';
    const why = reason === 'large' ? '超过文本读取上限（10 MB）' : '是二进制文件';
    return '（未读入正文：' + name + ' ' + why + '，无法作为文本注入对话。\n' +
        '路径：' + clean + '\n' +
        '处理建议：' + how + '）';
}

// —— browser_navigate 的 file:// 解析 ——

// 解码后的本地路径做段归一：\→/、折叠空段与 .、解析 ..（盘符/UNC 分享为地板）。
// 只接受「盘符:/...」与「//server/share/...」两种绝对形式；file:foo.html 会被 URL
// 解析成 file:///foo.html（驱动器相对），语义不明确，一并拒绝。失败返回 ''。
function normalizeLocalFilePath(raw) {
    const text = String(raw || '').replace(/\\/g, '/');
    const drive = /^[A-Za-z]:\//.exec(text);
    const unc = text.startsWith('//');
    let prefix = '';
    let rest = '';
    if (drive) {
        prefix = text.slice(0, 2);
        rest = text.slice(3);
    } else if (unc) {
        rest = text.slice(2);
    } else {
        return '';
    }
    const out = [];
    for (const part of rest.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
            // URL 解析器已把 .. 挡在盘符/分享根内，但解码后出现的 ..（%2e%2e）要在这里兜住
            if (out.length <= (unc ? 2 : 0)) return '';
            out.pop();
            continue;
        }
        out.push(part);
    }
    if (unc) return out.length >= 2 ? '//' + out.join('/') : '';
    return prefix + '/' + out.join('/');
}

// file:// 导航目标解析：把 URL 解析成解码后的本地绝对路径。只做解析与归一，不判权限——
// 授权链在 ai-panel 的 resolveReadPathWithApproval（与 read_file 同口径：工作区内直开；
// 工作区外点名/已批准读根直开，read/edit 弹审批、auto/full 直开，应用数据目录硬拒）。
// 通过返回 {ok:true, url（规范化后的可导航地址）, path（解码 + 段归一的本地路径）}；
// 失败返回 {ok:false, reason}。
export function normalizeFileUrlTarget(raw) {
    const text = String(raw || '').trim();
    let u;
    try {
        u = new URL(text);
    } catch (e) {
        return {ok: false, reason: 'file:// 地址格式无效：' + text + '（示例：file:///D:/dir/page.html）'};
    }
    if (u.protocol !== 'file:') {
        return {ok: false, reason: '不是 file:// 地址：' + text};
    }
    let decoded;
    try {
        decoded = decodeURIComponent(u.pathname);
    } catch (e) {
        return {ok: false, reason: 'file:// 地址编码无效：' + text};
    }
    const host = String(u.hostname || '').toLowerCase();
    // pathname 恒以 / 开头：本机形式 /D:/dir/x → D:/dir/x；UNC 形式由 host 拼回 //server/share
    const joined = host && host !== 'localhost' ? '//' + u.hostname + decoded : decoded.replace(/^\//, '');
    const path = normalizeLocalFilePath(joined);
    if (!path) {
        return {ok: false, reason: 'file:// 需要绝对路径（示例：file:///D:/dir/page.html）：' + text};
    }
    return {ok: true, url: u.href, path};
}

// —— 群成员只读工具的路径边界（ai-group-tools 执行链用） ——

// 把模型给的 rel（相对工作区根，或恰好落在根内的绝对路径）解析为根内的绝对路径。
// 越界（.. 逃逸 / 根外绝对路径 / 空根）一律拒绝；返回 {ok:true, path} 或 {ok:false, error}。
// 斜杠风格归一为 /（Windows 的 Go 绑定两种都接受）；盘符 / UNC / mock:// 这类带 // 的
// 假协议根都支持——base 与 resolved 用**同一套**段规范化，避免 // 被吞导致前缀误判。
export function resolveWithinRoot(root, rel) {
    const base = String(root || '').replace(/\\/g, '/').replace(/[\\/]+$/, '');
    if (!base) return {ok: false, error: '群聊未绑定工作区，文件工具不可用'};
    const raw = String(rel == null ? '' : rel).trim().replace(/^["']|["']$/g, '');
    if (!raw || raw === '.') return {ok: true, path: base};
    const unified = raw.replace(/\\/g, '/');
    const baseNorm = base.replace(/\\/g, '/').toLowerCase();
    let joined;
    if (/^[A-Za-z]:\//.test(unified) || unified.startsWith('//')) {
        // 绝对路径：必须落在根内（含等于根本身）
        const lower = unified.toLowerCase();
        if (lower !== baseNorm && !lower.startsWith(baseNorm + '/')) {
            return {ok: false, error: '路径超出群聊工作区（' + root + '）：' + raw};
        }
        joined = unified;
    } else if (unified.startsWith('/')) {
        // 根锚定的「伪相对」（/etc/x）：落点不可预测，一律拒绝
        return {ok: false, error: '路径超出群聊工作区（' + root + '）：' + raw};
    } else {
        joined = base + '/' + unified.replace(/^\/+/, '');
    }
    // 段规范化（解析 . / ..），保留盘符与 UNC/mock:// 的前缀结构；
    // 没有点段时原样返回（mock:// 这类双斜杠协议不被重拼吞掉）
    const hasDotSeg = joined.split('/').some((seg) => seg === '.' || seg === '..');
    if (!hasDotSeg) {
        return {ok: true, path: joined.replace(/\/+$/, '') || base};
    }
    const drive = /^[A-Za-z]:$/.test(joined.slice(0, 2)) ? joined.slice(0, 2) : '';
    const unc = !drive && joined.startsWith('//');
    let rest = joined;
    if (drive) rest = joined.slice(3);
    else if (unc) rest = joined.slice(2);
    const out = [];
    for (const part of rest.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (!out.length) return {ok: false, error: '路径超出群聊工作区（' + root + '）：' + raw};
            out.pop();
            continue;
        }
        out.push(part);
    }
    let resolved = out.join('/');
    if (drive) resolved = drive + '/' + resolved;
    if (unc) resolved = '//' + resolved;
    if (!resolved) return {ok: true, path: base};
    // 前缀校验对 base 做同样规范化（mock://samples → mock:/samples），双斜杠不误判
    const canon = (p) => {
        let s = p.replace(/\\/g, '/');
        const d = /^[A-Za-z]:$/.test(s.slice(0, 2)) ? s.slice(0, 2) : '';
        const u = !d && s.startsWith('//');
        if (d) s = s.slice(3);
        else if (u) s = s.slice(2);
        const segs = s.split('/').filter((seg) => seg && seg !== '.');
        let r = segs.join('/');
        if (d) r = d + '/' + r;
        if (u) r = '//' + r;
        return r.toLowerCase();
    };
    const resolvedNorm = canon(resolved);
    const baseCanon = canon(base);
    if (resolvedNorm !== baseCanon && !resolvedNorm.startsWith(baseCanon + '/')) {
        return {ok: false, error: '路径超出群聊工作区（' + root + '）：' + raw};
    }
    return {ok: true, path: resolved};
}

// —— delete_path 的目标收集（纯函数，ai-panel 执行链用） ——

// 从工具入参收集删除目标清单：paths 数组优先（多路径批量），否则回退单条 path；
// 空数组视为未传。逐条 trim、拒空串与通配符（批量删除的影响面必须在卡上逐条可见，
// glob 让模型先查出具体路径再显式传入）、钳上限（超过让模型分批发起）。
// 返回 {ok:true, rawList} 或 {ok:false, error}（错误点名问题条目，模型可自行修正）。
export function collectDeleteTargets(input, limit) {
    const max = Number(limit) || 20;
    const rawPaths = input && Array.isArray(input.paths) && input.paths.length ? input.paths : null;
    const list = rawPaths || (input && input.path != null && input.path !== '' ? [input.path] : []);
    if (!list.length) {
        return {ok: false, error: 'delete_path 需要提供 path（单条）或 paths（数组，一次最多 ' + max + ' 条）'};
    }
    if (list.length > max) {
        return {ok: false, error: '一次最多删除 ' + max + ' 个条目（收到 ' + list.length + ' 条）：请分批发起，每批一张审批卡。'};
    }
    const bad = [];
    const rawList = [];
    for (const item of list) {
        const raw = String(item == null ? '' : item).trim();
        if (!raw) {
            bad.push('（空路径）');
            continue;
        }
        if (/[*?]/.test(raw)) {
            bad.push(raw);
            continue;
        }
        rawList.push(raw);
    }
    if (bad.length) {
        return {ok: false, error: 'delete_path 不支持通配符或空路径（一次只能删明确列出的条目' +
            (rawPaths ? '，paths 共 ' + list.length + ' 条' : '') + '）：' + bad.join('、') +
            '。要删一类文件请先用 glob 查出具体路径，再显式传入 paths。'};
    }
    return {ok: true, rawList};
}
