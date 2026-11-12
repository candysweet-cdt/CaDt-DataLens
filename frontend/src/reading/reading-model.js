// 阅读模式纯函数模型（docs/reading-mode.md §2/§4/§5/§8）：
// TOC 构建、排序、单元 ID、进度算法、joinSoftLines、失效恢复。
// 无 DOM 依赖，Node --test 可直接跑（reading-model.test.mjs）。

// 卷/章关键词：与 Go 侧 reading.go 正则镜像，改动需两边同步。
const CN_NUM = '0-9零〇一二三四五六七八九十百千万两';
export const RE_VOLUME = new RegExp('^\\s{0,8}(第\\s*[' + CN_NUM + ']+\\s*[卷部篇]|番外卷|扩展卷|设定卷|人物卷|记录卷|扩展章)\\s*[:：、.．\\s]*(.*)$');
export const RE_CHAPTER = new RegExp('^\\s{0,8}(第\\s*[' + CN_NUM + ']+\\s*[章回节话]|序章|楔子|引子|前言|引言|尾声|终章|后记|附录|番外(?:篇|中|之外)?(?:\\s*[' + CN_NUM + ']+)?(?:\\s|[-—·:：、.．]|$))(.*)$');
export const RE_NUM_PRE = new RegExp('^\\s{0,4}([' + CN_NUM + ']+)\\s*[:：、.．]\\s*(.*)$');

const CN_DIGIT = {'零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9};
const CN_UNIT = {'十': 10, '百': 100, '千': 1000, '万': 10000, '亿': 1e8};

export function parseCnNumeral(s) {
    s = String(s || '').trim();
    if (!s) return NaN;
    if (/^[0-9]+$/.test(s)) return parseFloat(s);
    let total = 0, section = 0, digit = 0;
    for (const ch of s) {
        if (ch in CN_DIGIT) {
            digit = CN_DIGIT[ch];
        } else if (ch in CN_UNIT) {
            const u = CN_UNIT[ch];
            if (u >= 10000) {
                let value = section + digit;
                if (value === 0) value = 1;
                section = value * u;
                total += section;
                section = 0;
            } else {
                if (digit === 0) digit = 1;
                section += digit * u;
            }
            digit = 0;
        } else {
            return NaN;
        }
    }
    return total + section + digit;
}

// 阅读分组：详情 -1 → 前言 0 → 正文 1 → 番外 2 → 扩展/附录 3
export const GROUP = {DETAIL: -1, FRONT: 0, MAIN: 1, EXTRA: 2, APPENDIX: 3};

export function numeralPart(head) {
    head = String(head || '').trim();
    if (head.startsWith('第')) head = head.slice(1).replace(/^[\s\t]+/, '');
    let end = head.length;
    for (let j = 0; j < head.length; j++) {
        const ch = head[j];
        if (!((ch >= '0' && ch <= '9') || ch in CN_DIGIT)) {
            end = j;
            break;
        }
    }
    return head.slice(0, end);
}

// classifyChapterTitle 标题/文件名 → {group, num, hasNum, ok}
export function classifyChapterTitle(s) {
    const key = {group: GROUP.MAIN, num: 0, hasNum: false, ok: false};
    const m = RE_VOLUME.exec(s || '');
    if (m) {
        const head = m[1].trim();
        if (head.startsWith('第')) {
            const n = parseCnNumeral(numeralPart(head));
            if (Number.isFinite(n)) {
                if (n === 0) {
                    return {group: GROUP.DETAIL, num: 0, hasNum: true, ok: true};
                }
                key.num = n;
                key.hasNum = true;
            }
            key.ok = true;
            return key;
        }
        key.group = GROUP.APPENDIX;
        key.ok = true;
        return key;
    }
    const c = RE_CHAPTER.exec(s || '');
    if (c) {
        const head = c[1].trim();
        if (head.startsWith('第')) {
            const n = parseCnNumeral(numeralPart(head));
            if (Number.isFinite(n)) {
                if (n === 0) key.group = GROUP.FRONT;
                key.num = n;
                key.hasNum = true;
            }
        } else if (['序章', '楔子', '引子', '前言', '引言'].includes(head)) {
            key.group = GROUP.FRONT;
        } else if (head === '后记' || head === '附录') {
            key.group = GROUP.APPENDIX;
        } else if (head === '尾声' || head === '终章') {
            key.group = GROUP.MAIN; // 无数字，自然排在编号章节之后
        } else { // 番外…
            key.group = GROUP.EXTRA;
            let rest = head.replace(/^番外/, '').replace(/^篇/, '').trim();
            rest = rest.replace(/[\s\t\-—·:：、.．]+$/, '');
            const n = parseCnNumeral(rest);
            if (Number.isFinite(n)) {
                key.num = n;
                key.hasNum = true;
            }
        }
        key.ok = true;
        return key;
    }
    const p = RE_NUM_PRE.exec(s || '');
    if (p) {
        const n = parseCnNumeral(p[1]);
        if (Number.isFinite(n)) {
            return {group: GROUP.MAIN, num: n, hasNum: true, ok: true};
        }
    }
    return key;
}

// naturalLess 自然序：数字段按数值，其余按码点；相等返回 false。
export function naturalLess(a, b) {
    const ra = Array.from(String(a));
    const rb = Array.from(String(b));
    let i = 0, j = 0;
    while (i < ra.length && j < rb.length) {
        const da = ra[i] >= '0' && ra[i] <= '9';
        const db = rb[j] >= '0' && rb[j] <= '9';
        if (da && db) {
            let ia = i, jb = j;
            while (ia < ra.length && ra[ia] >= '0' && ra[ia] <= '9') ia++;
            while (jb < rb.length && rb[jb] >= '0' && rb[jb] <= '9') jb++;
            const na = parseFloat(ra.slice(i, ia).join(''));
            const nb = parseFloat(rb.slice(j, jb).join(''));
            if (na !== nb) return na < nb;
            i = ia;
            j = jb;
            continue;
        }
        const ca = ra[i].codePointAt(0);
        const cb = rb[j].codePointAt(0);
        if (ca !== cb) return ca < cb;
        i++;
        j++;
    }
    return ra.length - i < rb.length - j;
}

export function compareSortKeys(a, b) {
    if (a.group !== b.group) return a.group - b.group;
    if (a.hasNum !== b.hasNum) return a.hasNum ? -1 : 1;
    if (a.hasNum && a.num !== b.num) return a.num - b.num;
    if (a.title !== b.title) return naturalLess(a.title, b.title) ? -1 : 1;
    return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
}

export function minutesFor(words) {
    return Math.max(1, Math.ceil((words || 0) / 400));
}

// --- 单元 ID ---

export function unitIdOf(rel, offset, block) {
    return rel + '#' + (block ? 'B' : 'L') + offset;
}

export function parseUnitId(id) {
    const m = /^(.*)#([LB])(\d+)$/.exec(String(id || ''));
    if (!m) return null;
    return {rel: m[1], block: m[2] === 'B', offset: parseInt(m[3], 10)};
}

// --- 路径归一化（localStorage key） ---

export function normalizeBookKey(path) {
    // Windows 路径大小写不敏感：整体小写（CJK 无大小写不受影响），/ 分隔，去尾 /
    let p = String(path || '').replace(/\\/g, '/').trim().toLowerCase();
    p = p.replace(/\/+$/, '');
    return p;
}

// --- 节点工厂 ---

function fileBase(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
}

function isVolumeName(name) {
    return RE_VOLUME.test(name);
}

function makeNode(partial) {
    return Object.assign({
        id: '', kind: 'section', title: '', rel: '', offset: 1, endOffset: Infinity,
        level: 1, words: 0, minutes: 1, children: [], renderable: true, group: GROUP.MAIN,
    }, partial);
}

// buildHeadingTree 把扁平标题列表按 level 嵌套。
export function buildHeadingTree(headings) {
    const root = {children: [], level: 0};
    const stack = [root];
    for (const h of headings) {
        const node = Object.assign({}, h, {children: []});
        while (stack.length > 1 && stack[stack.length - 1].level >= h.level) stack.pop();
        stack[stack.length - 1].children.push(node);
        stack.push(node);
    }
    return root.children;
}

// --- 章区间计算 ---

// chapterRanges 计算文件内的章区间：章关键词命中 → split 兜底（最浅层 ≥2）→ 整文件一章。
function chapterRanges(f, options) {
    const headings = f.headings || [];
    if (f.ext === '.epub') {
        // spine 项即章：headings 由 Go 侧生成（offset = spine 序号）
        if (!headings.length) {
            return [{title: fileBase(f.name), offset: 1, endOffset: Infinity, words: f.words || 0, level: 1}];
        }
        return headings.map((h, i) => ({
            title: h.title, offset: h.offset,
            endOffset: i + 1 < headings.length ? headings[i + 1].offset : Infinity,
            words: h.words || 0, level: 1,
        }));
    }
    if (options && options.chapterLevel) {
        const at = headings.filter((h) => h.level === options.chapterLevel);
        if (at.length) {
            return at.map((h, i) => ({
                title: h.title, offset: h.offset,
                endOffset: i + 1 < at.length ? at[i + 1].offset : Infinity,
                words: h.words || 0, level: h.level,
            }));
        }
    }
    const hits = headings.filter((h) => RE_CHAPTER.test(h.title));
    if (hits.length) {
        return hits.map((h, i) => ({
            title: h.title, offset: h.offset,
            endOffset: i + 1 < hits.length ? hits[i + 1].offset : Infinity,
            words: h.words || 0, level: h.level,
        }));
    }
    // split 兜底：无章关键词但同层 ≥2 个标题
    if (headings.length >= 2) {
        let minLevel = Infinity;
        for (const h of headings) minLevel = Math.min(minLevel, h.level);
        const tops = headings.filter((h) => h.level === minLevel);
        if (tops.length >= 2) {
            return tops.map((h, i) => ({
                title: h.title, offset: h.offset,
                endOffset: i + 1 < tops.length ? tops[i + 1].offset : Infinity,
                words: h.words || 0, level: h.level,
            }));
        }
    }
    const first = headings.length && RE_CHAPTER.test(headings[0].title) ? headings[0] : null;
    return [{
        title: first ? first.title : fileBase(f.name),
        offset: 1, endOffset: Infinity, words: f.words || 0,
        level: first ? first.level : 1, wholeFile: true,
    }];
}

// sectionsFor 章区间内的子标题（嵌套树）。
function sectionsFor(headings, range, block, rel) {
    if (range.wholeFile) {
        const rest = headings.filter((h) => h.offset > 1);
        return buildHeadingTree(rest.map((h) => sectionNode(h, rel, block)));
    }
    const rest = headings.filter((h) => h.offset > range.offset &&
        (Number.isFinite(range.endOffset) ? h.offset < range.endOffset : true));
    return buildHeadingTree(rest.map((h) => sectionNode(h, rel, block)));
}

function sectionNode(h, rel, block) {
    const ck = classifyChapterTitle(h.title);
    const node = makeNode({
        id: unitIdOf(rel, h.offset, block),
        kind: 'section',
        title: h.title,
        rel,
        offset: h.offset,
        endOffset: Infinity,
        level: h.level,
        words: h.words || 0,
        minutes: minutesFor(h.words),
        group: ck.ok ? ck.group : GROUP.MAIN,
    });
    node.sortKey = {group: ck.group, num: ck.num, hasNum: ck.hasNum, title: h.title, rel};
    return node;
}

// buildFileChapters 普通文件 → 章节点数组（split 一文件多章；file 一文件一章）。
function buildFileChapters(f, options) {
    const base = fileBase(f.name);
    const block = f.ext === '.docx' || f.ext === '.epub';
    const fileKey = classifyChapterTitle(base);
    const ranges = chapterRanges(f, options);
    const headings = f.headings || [];
    return ranges.map((r) => {
        const ck = classifyChapterTitle(r.title);
        const node = makeNode({
            id: unitIdOf(f.rel, r.offset, block),
            kind: 'chapter',
            title: r.title,
            rel: f.rel,
            offset: r.offset,
            endOffset: r.endOffset,
            level: r.level,
            words: r.words || 0,
            minutes: minutesFor(r.words),
            group: ck.ok ? ck.group : GROUP.MAIN,
            children: sectionsFor(headings, r, block, f.rel),
        });
        node.sortKey = {group: ck.group, num: ck.num, hasNum: ck.hasNum, title: base, rel: f.rel};
        node.fileTitle = base;
        return node;
    });
}

// buildVolumeFile 第N卷.md / 番外卷.md：文件本身是卷，章为文件内章级标题。
function buildVolumeFile(f, options) {
    const base = fileBase(f.name);
    const key = classifyChapterTitle(base);
    const headings = f.headings || [];
    let hits = headings.filter((h) => RE_CHAPTER.test(h.title));
    if (!hits.length && headings.length >= 2) {
        let minLevel = Infinity;
        for (const h of headings) minLevel = Math.min(minLevel, h.level);
        const tops = headings.filter((h) => h.level === minLevel);
        if (tops.length >= 2) hits = tops;
    }
    const block = f.ext === '.docx';
    const children = hits.map((h, i) => {
        const ck = classifyChapterTitle(h.title);
        const node = makeNode({
            id: unitIdOf(f.rel, h.offset, block),
            kind: 'chapter',
            title: h.title,
            rel: f.rel,
            offset: h.offset,
            endOffset: i + 1 < hits.length ? hits[i + 1].offset : Infinity,
            level: h.level,
            words: h.words || 0,
            minutes: minutesFor(h.words),
            group: ck.ok ? ck.group : GROUP.MAIN,
        });
        node.sortKey = {group: ck.group, num: ck.num, hasNum: ck.hasNum, title: h.title, rel: f.rel};
        node.fileTitle = base;
        return node;
    });
    const node = makeNode({
        kind: 'volume',
        title: base,
        rel: f.rel,
        offset: 1,
        endOffset: hits.length ? hits[0].offset : Infinity, // 卷首语区间
        words: f.words || 0,
        minutes: minutesFor(f.words),
        group: key.group,
        children,
    });
    node.sortKey = {group: key.group, num: key.num, hasNum: key.hasNum, title: base, rel: f.rel};
    return node;
}

// --- TOC 构建 ---

// buildBookModel 从扫描结果构建全书模型。options: {chapterLevel: null|1|2|3}
export function buildBookModel(scan, options) {
    options = options || {};
    const model = {
        root: scan.root,
        title: scan.title || '',
        author: scan.author || '',
        intro: scan.intro || '',
        profile: scan.profile || 'file',
        confidence: scan.confidence || 0,
        warnings: scan.warnings || [],
        scanMs: scan.scanMs || 0,
        top: [],
        detail: null,
        chapters: [],
        totalWords: 0,
    };
    const rootItems = [];
    const dirGroups = new Map(); // 一级目录 → 文件列表
    for (const f of scan.files || []) {
        model.totalWords += f.words || 0;
        const slash = f.rel.lastIndexOf('/');
        const dir = slash >= 0 ? f.rel.slice(0, slash) : '';
        const base = fileBase(f.name);
        if (!dir && isVolumeName(base)) {
            rootItems.push(buildVolumeFile(f, options));
        } else if (!dir) {
            rootItems.push(...buildFileChapters(f, options));
        } else {
            const top = dir.split('/')[0];
            if (!dirGroups.has(top)) dirGroups.set(top, []);
            dirGroups.get(top).push(f);
        }
    }
    for (const [top, bucket] of dirGroups) {
        const key = classifyChapterTitle(top);
        const children = [];
        // 目录下可再有子目录卷（如 扩展章/沈世安列传/），一层展开
        const subGroups = new Map();
        for (const f of bucket) {
            const slash = f.rel.indexOf('/');
            const rest = f.rel.slice(slash + 1);
            const innerSlash = rest.lastIndexOf('/');
            if (innerSlash >= 0) {
                const sub = rest.slice(0, innerSlash);
                if (!subGroups.has(sub)) subGroups.set(sub, []);
                subGroups.get(sub).push(f);
            } else if (isVolumeName(fileBase(f.name))) {
                children.push(buildVolumeFile(f, options));
            } else {
                children.push(...buildFileChapters(f, options));
            }
        }
        for (const [sub, subBucket] of subGroups) {
            const subKey = classifyChapterTitle(sub);
            const subChildren = [];
            for (const f of subBucket) subChildren.push(...buildFileChapters(f, options));
            subChildren.sort((a, b) => compareSortKeys(a.sortKey, b.sortKey));
            const vol = makeNode({
                kind: 'volume', title: sub, rel: top + '/' + sub,
                renderable: false, group: subKey.group, children: subChildren,
            });
            vol.sortKey = {group: subKey.group, num: subKey.num, hasNum: subKey.hasNum, title: sub, rel: top + '/' + sub};
            children.push(vol);
        }
        children.sort((a, b) => compareSortKeys(a.sortKey, b.sortKey));
        const vol = makeNode({
            kind: 'volume', title: top, rel: top,
            renderable: false, group: key.group, children,
        });
        vol.sortKey = {group: key.group, num: key.num, hasNum: key.hasNum, title: top, rel: top};
        rootItems.push(vol);
    }
    rootItems.sort((a, b) => compareSortKeys(a.sortKey, b.sortKey));
    model.top = rootItems;
    model.detail = rootItems.find((n) => n.group === GROUP.DETAIL) || null;
    // 展平章流（详情页除外；卷内章按目录序），并给章标注所属卷标题
    for (const item of rootItems) {
        if (item === model.detail) continue;
        collectChapters(item, model.chapters, item.kind === 'volume' ? item.title : '');
    }
    return model;
}

function collectChapters(node, out, volumeTitle) {
    if (node.kind === 'volume') {
        for (const child of node.children) collectChapters(child, out, node.title);
        return;
    }
    if (node.kind === 'chapter') {
        node.volumeTitle = volumeTitle || '';
        out.push(node);
    }
}

// flattenTreePreorder 文档树先序（§7.2 上一节/下一节用）：父 → 子 → 下一兄弟。
export function flattenTreePreorder(nodes) {
    const out = [];
    const walk = (list) => {
        for (const n of list) {
            out.push(n);
            if (n.children && n.children.length) walk(n.children);
        }
    };
    walk(nodes || []);
    return out;
}

// --- 章流定位与进度 ---

// flattenChapters 返回章流并附 cumWords（字数加权用）。
export function flattenChapters(model) {
    const out = [];
    let cum = 0;
    for (const ch of model.chapters) {
        ch.cumWords = cum;
        out.push(ch);
        cum += ch.words || 0;
    }
    if (cum > 0) model.totalWords = cum;
    return out;
}

// computeProgress 字数加权进度：已读单元字数 + 当前单元 × 单元内比例。
export function computeProgress(chapters, totalWords, currentIndex, ratio) {
    if (!chapters.length) return 0;
    totalWords = totalWords || chapters.reduce((s, c) => s + (c.words || 0), 0) || 1;
    const idx = Math.max(0, Math.min(currentIndex, chapters.length - 1));
    const before = chapters[idx].cumWords || 0;
    const cur = (chapters[idx].words || 0) * Math.max(0, Math.min(1, ratio || 0));
    return Math.max(0, Math.min(1, (before + cur) / totalWords));
}

// locateUnit 进度恢复（§8.2）：ID → rel+标题+序号 → 全书标题 → 比例 → 第一章。
export function locateUnit(chapters, saved, model) {
    if (!chapters.length) return {index: 0, matched: 'empty'};
    if (saved) {
        if (saved.lastUnitId) {
            const i = chapters.findIndex((c) => c.id === saved.lastUnitId);
            if (i >= 0) return {index: i, matched: 'id'};
        }
        if (saved.lastRel && saved.lastUnitTitle) {
            const hit = nearestBy(chapters, (c) => c.rel === saved.lastRel && c.title === saved.lastUnitTitle, saved.lastUnitOrdinal);
            if (hit >= 0) return {index: hit, matched: 'rel-title'};
        }
        if (saved.lastUnitTitle) {
            const hit = nearestBy(chapters, (c) => c.title === saved.lastUnitTitle, saved.lastUnitOrdinal);
            if (hit >= 0) return {index: hit, matched: 'title'};
        }
        if (typeof saved.progress === 'number' && saved.progress > 0) {
            const total = model && model.totalWords ? model.totalWords : 1;
            let best = 0, bestDiff = Infinity;
            chapters.forEach((c, i) => {
                const center = ((c.cumWords || 0) + (c.words || 0) / 2) / total;
                const diff = Math.abs(center - saved.progress);
                if (diff < bestDiff) {
                    bestDiff = diff;
                    best = i;
                }
            });
            return {index: best, matched: 'progress'};
        }
    }
    return {index: 0, matched: 'first'};
}

function nearestBy(chapters, predicate, ordinal) {
    const ord = ordinal || 0;
    let best = -1, bestDiff = Infinity;
    chapters.forEach((c, i) => {
        if (!predicate(c)) return;
        const diff = Math.abs(c.offset - ord);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = i;
        }
    });
    return best;
}

// --- joinSoftLines（§10.2） ---

const CJK_CLASS = '[\\u4e00-\\u9fff\\u3040-\\u30ff\\uac00-\\ud7af\\u3000-\\u303f\\uff01-\\uff65\\u300c-\\u300f]';
const CJK_END_RE = new RegExp(CJK_CLASS + '$');
const CJK_START_RE = new RegExp('^' + CJK_CLASS);
const FENCE_RE = /^ {0,3}(```+|~~~+)/;
const SPECIAL_LINE_RE = /^ {0,3}(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\||<)/;
const INDENT_CODE_RE = /^( {4,}|\t)\S/;
const HARD_BREAK_RE = /(\s{2,}|\\)$/;

// joinSoftLines 合并段内单换行：CJK 相邻直接拼接，否则补空格；
// 硬换行（行尾两空格或反斜杠）保留。跳过围栏代码/缩进代码/表格/HTML/标题/列表/引用。
export function joinSoftLines(md) {
    const lines = String(md || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const out = [];
    let segment = [];
    let inFence = false;
    const flush = () => {
        if (segment.length) {
            let joined = segment[0];
            for (let i = 1; i < segment.length; i++) {
                const direct = CJK_END_RE.test(joined.slice(-1)) && CJK_START_RE.test(segment[i].slice(0, 1));
                joined += direct ? segment[i] : ' ' + segment[i];
            }
            out.push(joined);
            segment = [];
        }
    };
    for (const line of lines) {
        if (inFence) {
            out.push(line);
            if (FENCE_RE.test(line)) inFence = false;
            continue;
        }
        if (FENCE_RE.test(line)) {
            flush();
            out.push(line);
            inFence = true;
            continue;
        }
        if (!line.trim()) {
            flush();
            out.push(line);
            continue;
        }
        if (SPECIAL_LINE_RE.test(line) || INDENT_CODE_RE.test(line)) {
            flush();
            out.push(line);
            continue;
        }
        if (segment.length && HARD_BREAK_RE.test(segment[segment.length - 1])) {
            flush(); // 硬换行：保留既有段，另起一段
            segment = [line];
            continue;
        }
        segment.push(line);
    }
    flush();
    return out.join('\n');
}

// stripFrontMatter 提取并移除 YAML front matter，返回 {text, meta}。
export function stripFrontMatter(md) {
    const s = String(md || '').replace(/\r\n/g, '\n');
    if (!s.startsWith('---')) return {text: s, meta: null};
    const end = s.indexOf('\n---', 3);
    if (end < 0) return {text: s, meta: null};
    const block = s.slice(4, end);
    const meta = {};
    for (const line of block.split('\n')) {
        const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
        if (m) meta[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, '');
    }
    return {text: s.slice(end + 4).replace(/^\n+/, ''), meta};
}
