// @ts-check
// file-outline.js：从源码文本提取「分节注释 / 顶层函数 / case 分支」的纯函数解析器。
// 供两处共用（单一真源，避免两套解析漂移）：
//   ① scripts/gen-file-maps.mjs —— 为超大文件生成静态符号地图 md；
//   ② AI 工具 get_file_outline —— 模型运行时按需取某个文件的实时大纲。
// 无 DOM、无 backend、无副作用：输入字符串，输出结构化数组。

/** @typedef {{n: number, title: string}} Section */
/** @typedef {{n: number, type: 'function'|'arrow'|'case', name: string}} SymbolEntry */
/** @typedef {{lines: number, sections: Section[], symbols: SymbolEntry[]}} Outline */

// 分节：行首 `//` 后紧跟 3+ 个 `=` 或 `-`（含 `// ---- xxx ----` / `// ---------- xxx ----------`）。
const RE_SECTION = /^\s*\/\/[\s]*([=-])\1{2,}\s*(.+?)\s*(?:\1{3,})?\s*$/;
// 函数：缩进 ≤4 空格的 function / async function / export function 声明。
const RE_FUNC = /^\s{0,4}(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
// 箭头：缩进 ≤4 空格的 `const|let x = (...) =>` 形式。
const RE_ARROW_HEAD = /^\s{0,4}(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/;
// case：任意缩进的 `case 'xxx':`（ai-panel 的 executeToolInner 缩进 12，main.js 的 menuItems 缩进 8）。
const RE_CASE = /^\s*case\s+['"]([\w-]+)['"]\s*:/;

/**
 * 判定箭头函数：匹配行本身以 `;` 结束且无 `=>` 时，是普通表达式初始化
 * （如 `const detail = (err && ...) || String(err);`），直接否定；否则向后看若干行找 `=>`。
 * 跨行参数列表里可能出现 `{`（对象默认值）或参数间的 `;`，这些不再作为提前终止条件——
 * 否则 `(a = {x: 1}, b) => a` 这类跨行箭头会被误判为非函数。
 * @param {string[]} lines
 * @param {number} idx
 */
function isArrowInit(lines, idx) {
    const first = lines[idx];
    if (first.indexOf(';') >= 0 && first.indexOf('=>') < 0) return false;
    for (const line of lines.slice(idx, idx + 8)) {
        if (line.indexOf('=>') >= 0) return true;
    }
    return false;
}

/**
 * 解析源码文本，返回大纲结构。
 * @param {string} text 源码全文
 * @returns {Outline}
 */
export function parseOutline(text) {
    const lines = text.split('\n');
    /** @type {Section[]} */
    const sections = [];
    /** @type {SymbolEntry[]} */
    const symbols = [];
    lines.forEach((line, i) => {
        const n = i + 1;
        const sec = line.match(RE_SECTION);
        if (sec) {
            const title = sec[2].replace(/[=-]{3,}\s*$/, '').trim();
            if (title) sections.push({n, title});
            return;
        }
        const fn = line.match(RE_FUNC);
        if (fn) {
            symbols.push({n, type: 'function', name: fn[1]});
            return;
        }
        const ar = line.match(RE_ARROW_HEAD);
        if (ar && isArrowInit(lines, i)) {
            symbols.push({n, type: 'arrow', name: ar[1]});
            return;
        }
        const cs = line.match(RE_CASE);
        if (cs) symbols.push({n, type: 'case', name: cs[1]});
    });
    return {lines: lines.length, sections, symbols};
}

/**
 * 把大纲渲染成给模型看的紧凑文本（带行号，分节附「至」行）。
 * 符号索引支持分页（offset/limit）与按分节过滤（section），避免超大文件的输出撑爆上下文。
 * @param {string} srcPath 展示用的源路径
 * @param {Outline} outline
 * @param {{sectionsOnly?: boolean, offset?: number, limit?: number, section?: string}} [opts]
 * @returns {string}
 */
export function formatOutlineText(srcPath, outline, opts = {}) {
    const {lines, sections, symbols} = outline;
    const LIMIT_MAX = 500;
    // 用 ?? 而非 ||：显式传 0 要被夹到 1，不能被当成「未提供」回落到默认 200。
    const limit = Math.max(1, Math.min(LIMIT_MAX, Math.round(Number(opts.limit ?? 200)) || 1));
    const offset = Math.max(0, Math.round(Number(opts.offset ?? 0)) || 0);
    const section = typeof opts.section === 'string' ? opts.section.trim() : '';

    // 分节导航带序号（1-based），始终全量——分节最多几十条，体积很小，且是模型选段的依据。
    const sectionRows = sections.map((s, i) => {
        const end = i + 1 < sections.length ? sections[i + 1].n - 1 : lines;
        return {idx: i + 1, n: s.n, end, title: s.title};
    });

    // 按 section 过滤符号：匹配「分节标题」子串，落在该分节 [start, end] 行区间内的符号。
    let scoped = symbols;
    let matchedSections = [];
    if (section) {
        matchedSections = sectionRows.filter((row) => row.title.toLowerCase().includes(section.toLowerCase()));
        const ranges = matchedSections.map((row) => [row.n, row.end]);
        scoped = symbols.filter((sym) => ranges.some(([a, b]) => sym.n >= a && sym.n <= b));
    }

    const out = [];
    out.push('# ' + srcPath + ' · 大纲');
    out.push('共 ' + lines + ' 行；分节 ' + sections.length + ' 个，符号 ' + symbols.length + ' 个' +
        (section ? '（已按分节「' + section + '」过滤）' : '') + '。');
    out.push('定位顺序：先看分节找大区 → 再看符号找具体函数 → 最后 read_file 对应行段。');
    out.push('分页：符号索引默认每页 ' + limit + ' 条（上限 ' + LIMIT_MAX + '），用 offset 续取；section 传分节标题子串可只看某段。');
    out.push('');
    out.push('## 分节导航（序号 · 起始行-结束行 · 标题）');
    sectionRows.forEach((row) => out.push(row.idx + '. ' + row.n + '-' + row.end + '  ' + row.title));
    if (!sectionRows.length) out.push('（无分节注释）');

    if (opts.sectionsOnly) {
        out.push('');
        out.push('（sectionsOnly：本次不列符号索引）');
        return out.join('\n');
    }

    out.push('');
    if (section && !matchedSections.length) {
        out.push('## 符号索引');
        out.push('没有标题包含「' + section + '」的分节。可选分节见上方导航，把 section 换成其中的标题文字。');
        return out.join('\n');
    }
    out.push('## 符号索引（行号 · 类型 · 名称）');
    const shown = scoped.slice(offset, offset + limit);
    shown.forEach((s) => out.push(s.n + '  ' + s.type + '  ' + s.name));
    if (!shown.length) out.push('（本页无符号——offset 超出范围，或该分节内没有浅层符号）');
    const filterNote = section ? '（分节「' + section + '」内）' : '';
    out.push('本次返回 ' + shown.length + ' 条 / 共 ' + scoped.length + ' 条' + filterNote +
        ' / offset=' + offset + ' / limit=' + limit + '。');
    if (offset + shown.length < scoped.length) {
        out.push('未取完：用 offset=' + (offset + shown.length) + ' 续取' +
            (section ? '（section 保持「' + section + '」）' : '') + '。');
    }
    return out.join('\n');
}
