// ai-file-refs.js：AI 回复里的文件引用识别（纯函数，零 I/O）。
// 只做形状判定与打开文件的 basename 匹配；存在性校验（GetPathInfo）与范围解析
// （aiResolveScopePath）在渲染链（ai-panel 的 enhanceAIFileRefs）里做。
// 配套守则：<workspace_rules> 要求模型用反引号包相对路径（可带 :行[:列] / :起-止 后缀），
// 前端据此把真实存在的文件渲染成可点击芯片。

// 行列后缀：`path:42` / `path:42:8`；列号可省。1–7 位数字，避免吃掉扩展名里的点。
// 行区间：`path:42-56`（AI 描述一个函数跨行时的自然写法），取起始行跳转、结束行进 tooltip。
// 两种正则互斥匹配（:42:8 先走 LINE_COL_RE；:42-56 里的 :56 不在串尾，不会被 LINE_COL_RE 抢走）。
const LINE_COL_RE = /:(\d{1,7})(?::(\d{1,7}))?$/;
const LINE_RANGE_RE = /:(\d{1,7})-(\d{1,7})$/;
// 扩展名：点 + 首字母 + 至多 9 个字母数字——"1.5"（扩展名 "5" 非字母）这类数字不命中。
const EXT_RE = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;
// URL scheme（http: / https: / file: …）。注意放过 Windows 盘符 "D:"（后面跟 / 或 \）。
// 该检查在行/区间后缀剥离之后做（见 parseFileRef 内注释），避免裸文件名+行号被误判。
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:(?!\/\/[A-Za-z])/;

export function parseFileRef(raw) {
    let text = String(raw == null ? '' : raw).trim();
    if (!text || text.length > 300) return null;
    // 含空白不是可点击路径（"src / dist"、命令片段都不命中）
    if (/\s/.test(text)) return null;
    // URL 与通配/非法文件名字符直接排除
    if (text.includes('://')) return null;
    if (/[*?"<>|]/.test(text)) return null;
    let line = 0;
    let col = 0;
    let lineEnd = 0;
    const m = LINE_COL_RE.exec(text);
    if (m && m.index > 0) {
        line = parseInt(m[1], 10) || 0;
        col = m[2] ? (parseInt(m[2], 10) || 0) : 0;
        text = text.slice(0, m.index);
        if (!text || !EXT_RE.test(text)) return null;
    } else {
        // 行区间后缀：剥掉 :起-止，行号取起始值；倒序区间（如 :84-65）视为模型笔误，
        // 直接不命中（保持普通 code），不做静默换序。
        const r = LINE_RANGE_RE.exec(text);
        if (r && r.index > 0) {
            line = parseInt(r[1], 10) || 0;
            lineEnd = parseInt(r[2], 10) || 0;
            if (!lineEnd || lineEnd < line) return null;
            if (lineEnd === line) lineEnd = 0; // 退化区间 :42-42 归一成单行 :42
            text = text.slice(0, r.index);
            if (!text || !EXT_RE.test(text)) return null;
        }
    }
    // 无扩展名（README、src/ 目录、裸 token）不做候选；至少要有一个字母
    if (!EXT_RE.test(text)) return null;
    // scheme 检查放在后缀剥离之后：`model-catalog.js:42` 这类「裸文件名+行号」剥掉后
    // 只剩无冒号路径，不该被误判成 URL scheme（mailto:/http: 剥完仍带 scheme，照样拒；
    // Windows 盘符 "D:" 后跟 / 或 \ 放行）。
    if (SCHEME_RE.test(text) && !/^[A-Za-z]:[\\/]/.test(text)) return null;
    if (!/[A-Za-z]/.test(text)) return null;
    const out = {
        path: text.replace(/\\/g, '/'),
        line,
        col,
    };
    // lineEnd 只在区间命中时出现，普通引用返回形状保持三键不变
    if (lineEnd) out.lineEnd = lineEnd;
    return out;
}

// 裸文件名（不含目录）按「已打开的标签页」解析：模型常直接写 basename 谈论它刚编辑的
// 文件，而那个文件通常正开着。命中返回打开文档的原始路径，未命中返回 ''。
export function pickOpenFileMatch(ref, openFiles) {
    if (!ref || ref.path.includes('/')) return '';
    const base = ref.path.toLowerCase();
    for (const p of Array.isArray(openFiles) ? openFiles : []) {
        const s = String(p || '');
        if (!s) continue;
        const name = s.replace(/\\/g, '/').split('/').pop().toLowerCase();
        if (name === base) return s;
    }
    return '';
}

// 把 inline code 就地升级成文件引用（dataset + class + tooltip）。存在性校验仍由调用方做。
// **不做 isConnected 判定**：整屏重放时 renderMessage 先建游离的 wrap、渲染完才 append，
// 而 stat 结果缓存命中时这里是**同步**调用——曾经在「未挂载」分支直接 return，state 停在
// pending 让该节点永不再试，表现就是「第一次进对话链接正常，切走再切回退化成普通代码」。
// 换新节点也不怕：节点会随整块 innerHTML 一起丢弃，新节点自己会走一遍（缓存已命中）。
export function applyFileRefChip(code, abs, ref) {
    if (!code || !code.dataset) return;
    code.dataset.aiRefState = 'file';
    code.dataset.aiRefPath = String(abs || '');
    code.dataset.aiRefLine = String((ref && ref.line) || 0);
    code.dataset.aiRefCol = String((ref && ref.col) || 0);
    if (code.classList && typeof code.classList.add === 'function') code.classList.add('ai-file-ref');
    const at = ref && ref.line
        ? (' · 第 ' + ref.line + (ref.lineEnd ? '–' + ref.lineEnd : '') + ' 行' + (ref.col ? ' 第 ' + ref.col + ' 列' : ''))
        : '';
    code.dataset.tip = String(abs || '') + at;
}
