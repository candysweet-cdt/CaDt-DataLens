// ai-search-advanced.js —— search_text 高级参数的归一化与结果格式化（纯函数，无 DOM / 无后端依赖）。
// 与 Go internal/search 的选项口径一一对应：regex / wholeWord / pattern / excludePattern /
// outputMode / context / offset / limit / includeIgnored。两处改动必须同步（advanced_test.go + 本文件测试）。
// 两道独立防线防「一次搜索撑爆上下文」：① 分页 offset/limit（默认每页 50）由 Go 侧切片；
// ② 输出字节预算（formatSearchAnswer 按整条命中边界截断）。结果主动回报返回数/总数/偏移。

const textOf = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value));

// 默认每页条数（与 Go searchDefaultLimit 对齐）。工具描述告诉模型「默认 50，用 offset 翻页」。
export const SEARCH_DEFAULT_LIMIT = 50;
export const SEARCH_HARD_LIMIT = 1000;
// 单次返回给模型的字符预算。超限在「最近一条完整命中」处截断（不切半条），
// 并提示用 offset 继续。32K 字符 ≈ 8K token，远小于任何模型窗口，杜绝单次搜索撑爆。
export const SEARCH_OUTPUT_CHAR_BUDGET = 32000;

const clampInt = (value, fallback, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
};

/**
 * 归一化模型给出的高级参数。缺省值与 Go 侧一致：context=0、offset=0、limit=50、outputMode=content。
 * 非法值一律回落默认值而不抛错——工具入参不该让整轮对话失败。
 * maxResults 是旧参数：模型若仍传它，作为 limit 的兼容别名（新工具定义已不再下发）。
 * regex 保持纯显式（默认 false）：曾尝试按 query 自动识别正则，但实测会把 Windows 路径
 * C:\data\x、TS 类型 string|number 等字面量查询变成非法正则报错或全表命中，净效果更糟，
 * 故改为零命中时强提示（见 regexHintFor），由模型自己决定要不要传 regex:true。
 */
export function normalizeSearchOptions(input = {}) {
    const mode = textOf(input.outputMode).toLowerCase();
    const legacyLimit = Number(input.maxResults);
    const limitFallback = Number.isFinite(legacyLimit) && legacyLimit > 0
        ? clampInt(legacyLimit, SEARCH_DEFAULT_LIMIT, 1, SEARCH_HARD_LIMIT)
        : SEARCH_DEFAULT_LIMIT;
    return {
        regex: input.regex === true || input.regex === 'true',
        wholeWord: input.wholeWord === true || input.wholeWord === 'true',
        // 工具定义下发的字段名是 filePattern；旧实现读的是 pattern。两者都认，
        // 以 filePattern 优先（模型按定义传的名字），pattern 作为既有调用兼容别名。
        pattern: textOf(input.filePattern || input.pattern).trim(),
        excludePattern: textOf(input.excludePattern).trim(),
        outputMode: ['content', 'files', 'count'].includes(mode) ? mode : 'content',
        context: clampInt(input.context, 0, 0, 3),
        offset: clampInt(input.offset, 0, 0, 1000000),
        limit: clampInt(input.limit, limitFallback, 1, SEARCH_HARD_LIMIT),
        includeIgnored: input.includeIgnored === true || input.includeIgnored === 'true',
    };
}

const resultSize = (result) => {
    if (!result) return 0;
    // files/count 模式会把 hits 置空数组（mock 后端如此），不能先命中 hits 就当空结果。
    if (Array.isArray(result.hits) && result.hits.length > 0) return result.hits.length;
    if (Array.isArray(result.fileList)) return result.fileList.length;
    if (Array.isArray(result.counts)) return result.counts.length;
    return 0;
};

export function relativeToRoot(path, rootNorm) {
    const shown = textOf(path).replace(/\\/g, '/');
    const root = textOf(rootNorm).replace(/\\/g, '/').replace(/\/+$/, '');
    if (root && shown.toLowerCase().startsWith(root.toLowerCase() + '/')) {
        return shown.slice(root.length + 1);
    }
    return shown;
}

/**
 * filePattern 的前端兜底过滤（Go 侧已下推；旧后端 / mock 仍可能需要）。
 * glob 语义由调用方注入，避免本模块依赖 ai-file-tools.js。
 */
export function filterSearchResult(result, pattern, rootNorm, globMatchPath) {
    if (!pattern) return {result, note: ''};
    const before = resultSize(result);
    const next = {...(result || {})};
    if (Array.isArray(result && result.hits)) {
        next.hits = result.hits.filter((hit) => globMatchPath(pattern, relativeToRoot(hit.path, rootNorm), hit.name));
    }
    if (Array.isArray(result && result.fileList)) {
        next.fileList = result.fileList.filter((path) => globMatchPath(pattern, relativeToRoot(path, rootNorm), ''));
    }
    if (Array.isArray(result && result.counts)) {
        next.counts = result.counts.filter((item) => globMatchPath(pattern, relativeToRoot(item.path, rootNorm), ''));
    }
    let truncated = !!next.truncated;
    if (Array.isArray(next.hits) && next.hits.length > 200) {
        next.hits = next.hits.slice(0, 200);
        truncated = true;
    }
    next.truncated = truncated;
    return {result: next, note: '按 "' + pattern + '" 过滤：命中 ' + resultSize(next) + '（过滤前 ' + before + '）'};
}

// 命中路径 → 绝对路径（后端可能给绝对路径，也可能给相对 root 的路径）。
export function absoluteSearchPath(path, rootNorm) {
    const shown = textOf(path).replace(/\\/g, '/');
    if (/^[a-zA-Z]:\//.test(shown) || shown.startsWith('//')) return shown;
    const root = textOf(rootNorm).replace(/\\/g, '/').replace(/\/+$/, '');
    if (root && shown.toLowerCase().startsWith(root.toLowerCase() + '/')) return shown;
    return root ? root + '/' + shown.replace(/^\/+/, '') : shown;
}

// 单文件搜索：传文件作为 path 时，后端按父目录扫，结果缩到这一个文件。
export function filterSearchResultToFile(result, fileAbs, rootNorm) {
    const target = textOf(fileAbs).replace(/\\/g, '/').toLowerCase();
    const same = (path) => absoluteSearchPath(path, rootNorm).toLowerCase() === target;
    const next = {...(result || {})};
    if (Array.isArray(result && result.hits)) next.hits = result.hits.filter((hit) => same(hit.path));
    if (Array.isArray(result && result.fileList)) next.fileList = result.fileList.filter((path) => same(path));
    if (Array.isArray(result && result.counts)) next.counts = result.counts.filter((item) => same(item.path));
    return next;
}

// 「看着像正则却没开 regex」的信号 token，用于零命中时提示（不自动执行，零风险）。
// 收两类：① 反斜杠转义类 \d \w \b \s（字面量里少见，Windows 路径 C:\data 用的是单反斜杠，
// 而这里匹配的是「反斜杠+字母」即 \d 这种双字符写法）；② (? 构造、| 或、^ 锚点。
// 不收 . + ? $ * 与裸括号——file.ts / C++ / $HOME / foo(x) / arr[0] 都是合法字面量。
// 只在零命中时提示：有命中说明字面量搜索有效，绝不打扰，更不改变搜索语义。
const REGEX_HINT_TOKENS = [
    '\\b', '\\d', '\\w', '\\s', '\\B', '\\D', '\\W', '\\S',
    '(?', '|', '^',
];

/**
 * 零命中时的正则提示：查询含正则语法但未启用 regex 时，明确提醒「忘了传 regex:true」——
 * 这正是模型最常犯的错。只提示、不自动重搜、不改搜索语义，由模型自己决定是否重试，
 * 因此即便信号是字面量（如 string|number），最坏也只是多一句可忽略的提示，不会污染结果。
 * regex 已开或查询无信号时返回空串。
 */
export function regexHintFor(query, regex) {
    if (regex) return '';
    const q = textOf(query);
    const found = [];
    for (const token of REGEX_HINT_TOKENS) {
        if (q.includes(token) && !found.includes(token)) found.push(token);
    }
    if (!found.length) return '';
    return '；提示：查询含正则语法（' + found.join(' ') + '）但未启用 regex，已按字面量搜索且零命中。' +
        '若你本意是正则匹配（忘传 regex:true），请传 regex:true 重试；若本就是字面量，可缩小 path / filePattern 再搜';
}

/**
 * 把后端结果拼成给模型看的纯文本。
 * content: `相对路径:行号: 预览`，context>0 时每条命中附 `行号- / 行号+` 前后文；
 * files:   只要文件清单（大结果先拿清单再 read_file，省 token）；
 * count:   每文件命中数。
 */
// 把每条命中渲染成一组行（content 模式含前后文）。返回 string[]，每组是一条完整命中。
function hitGroups(hits, rootNorm) {
    return hits.map((hit) => {
        const group = [relativeToRoot(hit.path, rootNorm) + ':' + hit.line + ': ' + textOf(hit.preview)];
        for (const ctx of hit.before || []) group.push('    ' + ctx.line + '- ' + textOf(ctx.text));
        for (const ctx of hit.after || []) group.push('    ' + ctx.line + '+ ' + textOf(ctx.text));
        return group;
    });
}

// 单条 context 行的字符上限：context:3 的长代码行可达数 MB，正是「7MB 搜索」的元凶。
// 主命中行（group[0]）不截（它含路径:行号:预览，预览已在 Go 侧限长）；只截前后文行。
const CONTEXT_LINE_MAX = 200;

// 字节预算：按「整条命中」累加，超过预算就停在最近一条完整命中处（绝不切半条）。
// 边界保护：① 第一条就超预算时仍保留它（否则输出空、offset 原地打转），但把它的
// context 行压到 CONTEXT_LINE_MAX；② 每条的 context 行先截断再计预算，杜绝单行撑爆。
// 返回 {groups, dropped}：dropped 是被预算挡下的命中条数，供提示用。
function budgetGroups(groups, budget) {
    const kept = [];
    let used = 0;
    for (let i = 0; i < groups.length; i++) {
        const raw = groups[i];
        const group = [raw[0], ...raw.slice(1).map((line) =>
            line.length > CONTEXT_LINE_MAX ? line.slice(0, CONTEXT_LINE_MAX) + '…' : line)];
        const bytes = group.reduce((sum, line) => sum + line.length + 1, 0);
        if (used + bytes > budget && kept.length > 0) break;
        used += bytes;
        kept.push(group);
    }
    return {groups: kept, dropped: groups.length - kept.length};
}

// 分页回报：优先用后端给的 total/returned/offset，缺省时退回本地可见条数（兼容旧后端/mock）。
// shown = 本次实际显示条数（预算截断后可能小于后端 returned）；续取 offset 一律按 shown 算，
// 避免「回报说返回 50 条、屏幕只显示 2 条」时按 50 续取把未显示的 48 条永久跳过。
// hasMore 由后端 total 推导；total 缺失时不伪造总数。
function pagingNote(result, shown, offset, {hasBudgetDrop = false} = {}) {
    const backendReturned = Number(result && result.returned);
    const backendTotal = Number(result && result.total);
    const off = Number.isFinite(Number(result && result.offset)) ? Number(result.offset) : offset;
    const hasTotal = Number.isFinite(backendTotal);
    const returned = Number.isFinite(backendReturned) ? backendReturned : shown;
    const head = '本次显示 ' + shown + ' 条' +
        (hasTotal ? ' / 本次取回 ' + returned + ' 条 / 共 ' + backendTotal + ' 条' : '') +
        '（offset ' + off + '）';
    // 已达扫描硬顶时提醒收窄条件（total 封顶 1000，取不到第 1001 条之后）。
    const capped = hasTotal && backendTotal >= 1000
        ? '；已达扫描上限，可能有更多命中，请缩小 path / pattern 或 filePattern 再搜' : '';
    // 单一续取提示：有预算截断按 shown，否则按后端 returned；有 total 时以 total 判断是否还有。
    let more = '';
    if (hasBudgetDrop && shown > 0) {
        more = '；用 offset=' + (off + shown) + ' 继续取未显示部分';
    } else if (hasTotal && off + shown < backendTotal) {
        more = '；用 offset=' + (off + shown) + ' 继续取下一页';
    }
    return head + more + capped;
}

export function formatSearchAnswer(result, opts = {}, meta = {}) {
    const rootNorm = textOf(meta.rootNorm);
    const start = textOf(meta.start);
    const scopeNote = textOf(meta.scopeNote);
    const filterNote = textOf(meta.filterNote);
    const mode = opts.outputMode || 'content';
    const offset = Number.isFinite(Number(opts.offset)) ? Number(opts.offset) : 0;
    const budget = Number.isFinite(Number(opts.outputCharBudget))
        ? Number(opts.outputCharBudget) : SEARCH_OUTPUT_CHAR_BUDGET;

    if (resultSize(result) === 0) {
        return '没有找到匹配' + (meta.query ? '：' + meta.query : '') +
            (start ? '（起点：' + start + '）' : '') + (scopeNote ? '（' + scopeNote + '）' : '') +
            (filterNote ? '（' + filterNote + '）' : '') +
            regexHintFor(meta.query, opts.regex);
    }

    const lines = [];
    let dropped = 0;
    let shown = 0;
    let groups = [];
    if (mode === 'files') {
        const files = (result && result.fileList) || [];
        const budgeted = budgetGroups(files.map((path) => [relativeToRoot(path, rootNorm)]), budget);
        dropped = budgeted.dropped;
        groups = budgeted.groups;
        shown = groups.length;
    } else if (mode === 'count') {
        const counts = (result && result.counts) || [];
        const budgeted = budgetGroups(counts.map((item) => [relativeToRoot(item.path, rootNorm) + ': ' + item.count]), budget);
        dropped = budgeted.dropped;
        groups = budgeted.groups;
        shown = groups.length;
    } else {
        const hits = (result && result.hits) || [];
        const budgeted = budgetGroups(hitGroups(hits, rootNorm), budget);
        dropped = budgeted.dropped;
        groups = budgeted.groups;
        shown = groups.length;
    }
    const note = pagingNote(result, shown, offset, {hasBudgetDrop: dropped > 0});
    if (mode === 'files') lines.push('匹配文件（' + note + '）：');
    else if (mode === 'count') lines.push('每文件命中数（' + note + '）：');
    else lines.unshift(note);
    for (const group of groups) lines.push(...group);
    if (scopeNote) lines.unshift(scopeNote);
    else if (start && mode === 'content') lines.unshift('搜索起点：' + start + '；以下路径相对该起点');
    if (filterNote) lines.push('（' + filterNote + '）');
    // 只保留 pagingNote 里那一条续取提示，这里仅说明「被预算截断」的事实，不再重复 offset。
    if (dropped > 0) lines.push('…（输出超过字符预算：前后文行已限长，另有 ' + dropped + ' 条未显示，按上面的 offset 续取）');
    else if (result && result.truncated && !(Number.isFinite(Number(result && result.total)))) {
        lines.push('…（结果已截断）');
    }
    if (result && result.artifactSkipped) lines.push('…（源码命中已占满窗口，产物档 dist/build 等未检索）');
    return lines.join('\n');
}
