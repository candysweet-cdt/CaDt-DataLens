// @ts-check
// code-outline.js：跨语言源码大纲解析器（读）+ 分节注释编辑计划（写前纯计算）。
// 按扩展名选语言规则表，逐行正则提取分节/函数/类；JS/TS 委托 file-outline.js 的 parseOutline
// 作为单一解析真源（依赖单向、避免循环），保证 gen-file-maps.mjs 与 .map.md 行号口径不变。
// 无 DOM、无 backend、无副作用：输入字符串，输出结构化数据。

import {parseOutline} from './file-outline.js';

/** @typedef {{n: number, title: string}} Section */
/** @typedef {{n: number, type: 'function'|'arrow'|'case'|'class', name: string}} SymbolEntry */
/** @typedef {{lines: number, sections: Section[], symbols: SymbolEntry[], language: string}} CodeOutline */
/** @typedef {{line: number, text: string}} SectionEdit */
/** @typedef {{title: string, symbolNames?: string[], startName?: string, endName?: string}} SectionPlan */
/** @typedef {{label: string, lineComment: string|null, blockComment: [string,string]|null, functions: RegExp[], classes: RegExp[], headingAsSection?: boolean}} LangRule */

// 通用分节注释：任意行注释符 + 3+ 个 =/- + 标题 + 可选尾部装饰 + 可选块注释收尾。
const RE_SECTION_GENERIC = /^\s*(?:\/\/|#|;|--|<!--|\/\*)\s*([=-])\1{2,}\s*(.+?)\s*(?:\1{3,})?\s*(?:-->|\*\/)?\s*$/;
// Markdown 标题直接当分节。
const RE_HEADING = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/;

/**
 * @param {string} pattern
 * @param {string} [flags]
 */
const re = (pattern, flags) => new RegExp(pattern, flags || '');

/** @type {Record<string, LangRule>} */
const LANG_RULES = {
    javascript: {label: 'JavaScript', lineComment: '//', blockComment: null, functions: [], classes: []},
    typescript: {label: 'TypeScript', lineComment: '//', blockComment: null, functions: [], classes: []},
    go: {
        label: 'Go', lineComment: '//', blockComment: null,
        functions: [/^\s{0,4}func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/],
        classes: [/^\s{0,4}type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/],
    },
    python: {
        label: 'Python', lineComment: '#', blockComment: null,
        functions: [/^\s{0,4}(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/],
        classes: [/^\s{0,4}class\s+([A-Za-z_]\w*)/],
    },
    java: {label: 'Java', lineComment: '//', blockComment: null, functions: [cLikeFn()], classes: [cLikeClass()]},
    c: {label: 'C', lineComment: '//', blockComment: null, functions: [cLikeFn()], classes: [cLikeClass()]},
    cpp: {label: 'C++', lineComment: '//', blockComment: null, functions: [cLikeFn()], classes: [cLikeClass()]},
    csharp: {label: 'C#', lineComment: '//', blockComment: null, functions: [cLikeFn()], classes: [cLikeClass()]},
    swift: {label: 'Swift', lineComment: '//', blockComment: null, functions: [cLikeFn()], classes: [cLikeClass()]},
    kotlin: {label: 'Kotlin', lineComment: '//', blockComment: null, functions: [cLikeFn()], classes: [cLikeClass()]},
    rust: {
        label: 'Rust', lineComment: '//', blockComment: null,
        functions: [/^\s{0,4}(?:pub(?:\([^)]*\))?\s+)?(?:async\s+|unsafe\s+|const\s+|extern\s+)*fn\s+([A-Za-z_]\w*)\s*\(/],
        classes: [/^\s{0,4}(?:pub\s+)?(?:struct|enum|trait|impl)\s+([A-Za-z_]\w*)/],
    },
    ruby: {
        label: 'Ruby', lineComment: '#', blockComment: null,
        functions: [/^\s{0,4}def\s+([A-Za-z_]\w*[?!]?)/],
        classes: [/^\s{0,4}class\s+([A-Za-z_]\w*)/],
    },
    php: {
        label: 'PHP', lineComment: '//', blockComment: null,
        functions: [/^\s{0,4}(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+([A-Za-z_]\w*)\s*\(/],
        classes: [/^\s{0,4}(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/],
    },
    sql: {
        label: 'SQL', lineComment: '--', blockComment: null,
        functions: [re('^\\s{0,4}CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:FUNCTION|PROCEDURE)\\s+(\\w+)', 'i')],
        classes: [],
    },
    shell: {
        label: 'Shell', lineComment: '#', blockComment: null,
        functions: [/^\s{0,4}(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/, /^\s{0,4}function\s+([A-Za-z_]\w*)/],
        classes: [],
    },
    markdown: {label: 'Markdown', lineComment: '<!--', blockComment: ['<!--', '-->'], functions: [], classes: [], headingAsSection: true},
    html: {label: 'HTML', lineComment: '<!--', blockComment: ['<!--', '-->'], functions: [], classes: []},
    xml: {label: 'XML', lineComment: '<!--', blockComment: ['<!--', '-->'], functions: [], classes: []},
    yaml: {label: 'YAML', lineComment: '#', blockComment: null, functions: [], classes: []},
    plaintext: {label: '纯文本', lineComment: '#', blockComment: null, functions: [], classes: []},
};

/** C 系函数声明：类型 + 名字 + 参数 + `{`，排除 if/for/return 等控制关键字。 */
function cLikeFn() {
    return /^\s{0,4}(?!(?:if|for|while|switch|return|catch|else|new|delete|sizeof)\b)(?:[\w<>[\]?.*]+\s+)+([A-Za-z_]\w*)\s*\([^;{]*\)\s*(?:throws\s+[\w\s,.]*)?\{?\s*$/;
}
/** C 系类/结构声明。 */
function cLikeClass() {
    return /^\s{0,4}(?:(?:public|private|internal|abstract|final|sealed|static)\s+)*(?:class|struct|interface|enum)\s+([A-Za-z_]\w*)/;
}

/** @type {Record<string, string>} 扩展名 → 语言 id。 */
const EXT_LANG = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    go: 'go', py: 'python', pyw: 'python',
    java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    cs: 'csharp', rs: 'rust', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin', kts: 'kotlin',
    sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell',
    md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
    yaml: 'yaml', yml: 'yaml',
};

/**
 * 按扩展名识别语言；未识别回退 plaintext（仍做通用分节/函数猜测，不报错）。
 * @param {string} path
 * @param {string} [text] 预留：扩展名缺失时可凭内容嗅探（当前未启用）
 * @returns {{id: string, label: string}}
 */
export function detectLanguage(path, text) {
    const name = String(path || '').split(/[\\/]/).pop() || '';
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
    const id = EXT_LANG[ext] || 'plaintext';
    const rule = LANG_RULES[id];
    return {id, label: rule ? rule.label : '纯文本'};
}

/**
 * 通用语言扫描：分节注释 + 函数/类声明。
 * @param {string} text
 * @param {LangRule} rule
 * @returns {{lines: number, sections: Section[], symbols: SymbolEntry[]}}
 */
function scanGeneric(text, rule) {
    const lines = text.split('\n');
    /** @type {Section[]} */
    const sections = [];
    /** @type {SymbolEntry[]} */
    const symbols = [];
    lines.forEach((line, i) => {
        const n = i + 1;
        const sec = line.match(RE_SECTION_GENERIC);
        if (sec) {
            const title = sec[2].replace(/[=-]{3,}\s*$/, '').trim();
            if (title) sections.push({n, title});
            return;
        }
        for (const reCls of rule.classes) {
            const m = line.match(reCls);
            if (m) { symbols.push({n, type: 'class', name: m[1]}); return; }
        }
        for (const reFn of rule.functions) {
            const m = line.match(reFn);
            if (m) { symbols.push({n, type: 'function', name: m[1]}); return; }
        }
    });
    if (rule.headingAsSection) {
        lines.forEach((line, i) => {
            const m = line.match(RE_HEADING);
            if (m) sections.push({n: i + 1, title: m[1]});
        });
        sections.sort((a, b) => a.n - b.n);
    }
    return {lines: lines.length, sections, symbols};
}

/**
 * 解析源码大纲。JS/TS 委托 file-outline.js 的 parseOutline（单一真源），其他语言走规则表。
 * @param {string} text
 * @param {string} langId
 * @returns {CodeOutline}
 */
export function outlineForLanguage(text, langId) {
    const id = LANG_RULES[langId] ? langId : 'plaintext';
    const rule = LANG_RULES[id];
    const base = (id === 'javascript' || id === 'typescript')
        ? parseOutline(text)
        : scanGeneric(text, rule);
    return {lines: base.lines, sections: base.sections, symbols: base.symbols, language: id};
}

/**
 * 按语言生成一条分节注释行（纯文本，不含缩进）。
 * @param {LangRule} rule
 * @param {string} title
 * @returns {string}
 */
function formatSectionLine(rule, title) {
    if (rule.blockComment) return rule.blockComment[0] + ' ===== ' + title + ' ===== ' + rule.blockComment[1];
    return (rule.lineComment || '#') + ' ===== ' + title + ' =====';
}

/**
 * 从符号行往上回溯，返回文档注释块的首行（0-based）。
 * 分节注释必须插在整段文档注释之前——插在文档注释结束符与函数之间会拆散 JSDoc 与它的函数。
 * @param {string[]} lines
 * @param {number} symbolIdx 符号所在行的 0-based 下标
 * @param {LangRule} rule
 * @returns {number} 0-based 插入行
 */
function docBlockStartLine(lines, symbolIdx, rule) {
    let start = symbolIdx;
    let i = symbolIdx - 1;
    const blockEnd = rule.blockComment ? rule.blockComment[1] : '*/';
    const blockStart = rule.blockComment ? rule.blockComment[0] : '/*';
    let scanning = true;
    while (scanning && i >= 0) {
        const t = lines[i].trim();
        if (RE_SECTION_GENERIC.test(t)) {
            scanning = false;
        } else if (t.endsWith(blockEnd) || t.endsWith('-->')) {
            const open = t.endsWith('-->') ? '<!--' : blockStart;
            let j = i;
            while (j >= 0 && !lines[j].trim().includes(open)) j--;
            if (j >= 0) {
                start = j;
                i = j - 1;
            } else {
                scanning = false;
            }
        } else if (rule.lineComment && t.startsWith(rule.lineComment)) {
            start = i;
            i--;
        } else {
            scanning = false;
        }
    }
    return start;
}

/**
 * 计算分节注释插入计划：按模型给的语义分区，把注释插到该分区首个符号的文档注释块之前。
 * 只算编辑、不写文件；已有分节注释的符号会跳过（幂等，重复维护不会叠加注释）；找不到的分区跳过。
 * @param {string} text 源码全文
 * @param {string} langId 语言 id
 * @param {SectionPlan[]} plans 语义分区方案（title + symbolNames / startName）
 * @returns {SectionEdit[]} 按行号升序的编辑列表
 */
export function planSectionComments(text, langId, plans) {
    const rule = LANG_RULES[langId] || LANG_RULES.plaintext;
    const lines = text.split('\n');
    const outline = outlineForLanguage(text, langId);
    /** @type {Map<string, number>} */
    const byName = new Map();
    for (const sym of outline.symbols) if (!byName.has(sym.name)) byName.set(sym.name, sym.n);
    /** @type {SectionEdit[]} */
    const edits = [];
    const used = new Set();
    for (const plan of plans || []) {
        // 标题必须单行且限长：模型可能传含换行的标题，原样拼进注释会向源码注入任意代码。
        const title = String((plan && plan.title) || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (!title) continue;
        let symbolLine = 0;
        if (plan.startName && byName.has(plan.startName)) symbolLine = byName.get(plan.startName) || 0;
        if (!symbolLine) {
            for (const name of (Array.isArray(plan.symbolNames) ? plan.symbolNames : [])) {
                const n = byName.get(name);
                if (n && (!symbolLine || n < symbolLine)) symbolLine = n;
            }
        }
        if (!symbolLine) continue;
        const symbolIdx = symbolLine - 1;
        const insertIdx = docBlockStartLine(lines, symbolIdx, rule);
        const insertLine = insertIdx + 1; // 1-based
        if (used.has(insertLine)) continue;
        // 幂等：文档注释块内及其正上方一行已有分节注释就不再插入，避免重复维护叠加。
        // 上次插入的分节注释位于文档块首行之前（insertIdx-1），必须一并检查。
        let already = false;
        for (let k = Math.max(0, insertIdx - 1); k <= symbolIdx; k++) {
            if (RE_SECTION_GENERIC.test(lines[k])) { already = true; break; }
        }
        if (already) continue;
        used.add(insertLine);
        edits.push({line: insertLine, text: formatSectionLine(rule, title)});
    }
    edits.sort((a, b) => a.line - b.line);
    return edits;
}

/**
 * 把编辑列表应用到源码文本，返回新文本（供执行分支落盘；纯函数便于测试）。
 * @param {string} text
 * @param {SectionEdit[]} edits
 * @returns {string}
 */
export function applySectionEdits(text, edits) {
    const lines = text.split('\n');
    const at = new Map();
    for (const edit of edits) {
        if (!Number.isInteger(edit.line) || edit.line < 1 || edit.line > lines.length) {
            throw new Error('分节注释插入行号越界：' + edit.line + '（文件共 ' + lines.length + ' 行）');
        }
        const arr = at.get(edit.line) || [];
        arr.push(edit.text);
        at.set(edit.line, arr);
    }
    const out = [];
    for (let i = 1; i <= lines.length; i++) {
        const ins = at.get(i);
        if (ins) for (const s of ins) out.push(s);
        out.push(lines[i - 1]);
    }
    return out.join('\n');
}
