import {createFileIcon} from './fileicons.js';
import {renderSessionOutline, syncSessionOutlineActive} from './session-outline.js';

// ===== 结构视图：解析当前文件并生成可导航的大纲/符号树 =====
// 支持 Markdown 标题层级、HTML/XML 标签树、Python/JS/TS/Go/Java 等语言的
// 类、方法、函数、变量，以及 JSON/YAML/TOML/INI 的键层级。
// 节点统一形状：{kind, label, detail, line, column, endLine, children}

const MAX_TEXT = 8 * 1024 * 1024;
const MAX_NODES = 6000;
const MAX_LABEL = 140;
const SUPPORT_HINT = '支持 Markdown、HTML/XML、Python、JS/TS、Go、Java/Kotlin/C#、C/C++、Rust、PHP、Ruby、Lua、JSON、YAML、TOML/INI、纯文本（章节）';

const ICONS = {
    chevron: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    refresh: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.8 8a4.8 4.8 0 1 1-1.4-3.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M12.8 2.6v3.2H9.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    collapse: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 3.4 3.4 6.2M9.8 3.4l2.8 2.8M6.2 12.6 3.4 9.8M9.8 12.6l2.8-2.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M3.6 8h2.6M9.8 8h2.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    expand: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 6.2 6.2 3.4M12.6 6.2 9.8 3.4M3.4 9.8l2.8 2.8M12.6 9.8 9.8 12.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M3.6 8h2.6M9.8 8h2.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
};

const KIND_GLYPH = {
    class: 'C',
    interface: 'I',
    enum: 'E',
    function: 'f',
    method: 'm',
    variable: 'V',
    field: 'V',
    tag: '<>',
    key: 'K',
    section: 'S',
    module: 'M',
    type: 'T',
    heading: '#',
    chapter: '章',
    file: '',
    index: '#',
};

const KIND_NAME = {
    class: '类',
    interface: '接口',
    enum: '枚举',
    function: '函数',
    method: '方法',
    variable: '变量',
    field: '字段',
    tag: '标签',
    key: '键',
    section: '节',
    module: '模块',
    type: '类型',
    heading: '标题',
    chapter: '章节',
    file: '文件',
    index: '条目',
};

const EXTENSIONS = {
    md: ['markdown', 'Markdown'], markdown: ['markdown', 'Markdown'], mdx: ['markdown', 'Markdown'],
    html: ['html', 'HTML'], htm: ['html', 'HTML'], xhtml: ['html', 'HTML'], vue: ['html', 'Vue'],
    xml: ['xml', 'XML'], svg: ['xml', 'XML'], xsd: ['xml', 'XML'], xsl: ['xml', 'XML'], xslt: ['xml', 'XML'], plist: ['xml', 'XML'],
    py: ['python', 'Python'], pyw: ['python', 'Python'], pyi: ['python', 'Python'],
    js: ['javascript', 'JavaScript'], mjs: ['javascript', 'JavaScript'], cjs: ['javascript', 'JavaScript'], jsx: ['javascript', 'JavaScript'],
    ts: ['javascript', 'TypeScript'], tsx: ['javascript', 'TypeScript'], mts: ['javascript', 'TypeScript'], cts: ['javascript', 'TypeScript'],
    go: ['go', 'Go'],
    java: ['clike', 'Java'], kt: ['clike', 'Kotlin'], kts: ['clike', 'Kotlin'], scala: ['clike', 'Scala'], sc: ['clike', 'Scala'],
    groovy: ['clike', 'Groovy'], gradle: ['clike', 'Gradle'],
    cs: ['clike', 'C#'], swift: ['clike', 'Swift'], dart: ['clike', 'Dart'],
    c: ['clike', 'C/C++'], h: ['clike', 'C/C++'], cpp: ['clike', 'C/C++'], cc: ['clike', 'C/C++'], cxx: ['clike', 'C/C++'], 'c++': ['clike', 'C/C++'],
    hpp: ['clike', 'C/C++'], hh: ['clike', 'C/C++'], hxx: ['clike', 'C/C++'], ino: ['clike', 'C/C++'],
    m: ['clike', 'Objective-C'], mm: ['clike', 'Objective-C'],
    rs: ['rust', 'Rust'],
    php: ['php', 'PHP'], phtml: ['php', 'PHP'],
    rb: ['ruby', 'Ruby'], rake: ['ruby', 'Ruby'], gemspec: ['ruby', 'Ruby'],
    lua: ['lua', 'Lua'],
    sh: ['shell', 'Shell'], bash: ['shell', 'Shell'], zsh: ['shell', 'Shell'], ksh: ['shell', 'Shell'],
    json: ['json', 'JSON'],
    jsonl: ['jsonl', 'JSONL'], ndjson: ['jsonl', 'JSONL'],
    yaml: ['yaml', 'YAML'], yml: ['yaml', 'YAML'],
    toml: ['toml', 'TOML'],
    ini: ['ini', 'INI/Properties'], properties: ['ini', 'INI/Properties'], cfg: ['ini', 'Properties'], conf: ['ini', 'Properties'],
    txt: ['novel', '纯文本'],
};

const RESERVED = new Set([
    'if', 'else', 'elif', 'endif', 'for', 'foreach', 'while', 'do', 'switch', 'case', 'default',
    'catch', 'try', 'finally', 'return', 'throw', 'delete', 'typeof', 'instanceof',
    'in', 'of', 'await', 'yield', 'function', 'class', 'interface', 'enum', 'struct', 'record',
    'object', 'trait', 'protocol', 'extension', 'union', 'namespace', 'module', 'package', 'import',
    'export', 'using', 'include', 'define', 'ifdef', 'ifndef', 'static', 'const', 'let', 'var',
    'public', 'private', 'protected', 'abstract', 'final', 'sealed', 'native', 'synchronized',
    'volatile', 'transient', 'async', 'super', 'this', 'self',
    'where', 'when', 'match', 'loop', 'impl', 'fn', 'func', 'def', 'pass', 'raise', 'from',
    'global', 'nonlocal', 'assert', 'del', 'with', 'lambda', 'not', 'and', 'or', 'is', 'as',
    'true', 'false', 'null', 'undefined', 'void', 'int', 'char', 'float', 'double', 'bool',
    'boolean', 'string', 'byte', 'short', 'long', 'unsigned', 'signed', 'template', 'typename',
    'operator', 'sizeof', 'alignof', 'decltype', 'auto', 'extern', 'inline', 'virtual', 'friend',
    'typedef', 'goto', 'break', 'continue', 'fallthrough', 'select', 'go', 'defer', 'chan', 'map',
    'range', 'type', 'readonly', 'override', 'accessor', 'internal', 'out', 'ref', 'params',
    'event', 'delegate', 'unsafe', 'fixed', 'lock', 'unchecked', 'checked', 'stackalloc', 'nameof',
    'and', 'or', 'xor', 'not', 'shl', 'shr', 'nil', 'true', 'false', 'iota', 'print', 'println',
]);

function baseName(path) {
    const s = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
}

function splitLines(text) {
    return String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
}

function lineStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) starts.push(i + 1);
    }
    return starts;
}

function linePosition(starts, offset) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset) lo = mid;
        else hi = mid - 1;
    }
    return {line: lo + 1, column: offset - starts[lo] + 1};
}

function makeNode(kind, label, line, column) {
    return {
        kind,
        label: String(label == null ? '' : label),
        detail: '',
        line: Math.max(1, Number(line) || 1),
        column: Math.max(1, Number(column) || 1),
        endLine: 0,
        children: [],
    };
}

function clampLabel(text, maxLen) {
    let s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (s.length <= maxLen) return s;
    const cut = s.lastIndexOf(',', maxLen - 2);
    s = (cut > 12 ? s.slice(0, cut) : s.slice(0, maxLen - 2)).replace(/[,\s]+$/, '') + '…';
    return s;
}

// 从 name 之后找到参数括号，生成「名字(参数…)」形式的标签（PyCharm 风格）
function signatureText(origLine, maskedLine, nameIndex, name, maxLen = MAX_LABEL) {
    const raw = String(name || '');
    const start = Number(nameIndex);
    if (!raw || !Number.isFinite(start) || start < 0) return raw;
    const open = maskedLine.indexOf('(', start + raw.length);
    if (open < 0) return clampLabel(raw, maxLen);
    let depth = 0;
    let close = -1;
    for (let i = open; i < maskedLine.length; i++) {
        const ch = maskedLine[i];
        if (ch === '(') depth++;
        else if (ch === ')') {
            depth--;
            if (depth === 0) { close = i; break; }
        }
    }
    if (close < 0) return clampLabel(raw + '(...)', maxLen);
    const between = maskedLine.slice(start + raw.length, open);
    const prefix = (/=/.test(between) || /:[^=]*$/.test(between)) ? raw : origLine.slice(start, open).replace(/\s+/g, '');
    const params = origLine.slice(open, close + 1).replace(/\s+/g, ' ');
    return clampLabel(prefix + params, maxLen);
}

function countChar(text, ch) {
    let n = 0;
    for (let i = 0; i < text.length; i++) if (text[i] === ch) n++;
    return n;
}

function finalizeRanges(children, fallbackEnd) {
    for (let i = 0; i < children.length; i++) {
        const node = children[i];
        const next = children[i + 1];
        if (!node.endLine) node.endLine = next ? Math.max(node.line, next.line - 1) : fallbackEnd;
        if (node.children && node.children.length) {
            finalizeRanges(node.children, node.endLine);
            let last = node.line;
            for (const child of node.children) {
                if (child.endLine > node.endLine) child.endLine = node.endLine;
                if (child.endLine > last) last = child.endLine;
            }
            node.endLine = Math.max(node.endLine, last);
        }
        node.endLine = Math.max(Number(node.endLine) || 0, node.line);
    }
}

function capTree(children, limit) {
    let count = 0;
    let truncated = false;
    const walk = (nodes) => {
        const out = [];
        for (const node of nodes) {
            if (count >= limit) { truncated = true; break; }
            count++;
            node.children = walk(node.children || []);
            out.push(node);
        }
        return out;
    };
    return {children: walk(children), truncated};
}

function countTree(children) {
    let n = 0;
    for (const node of children || []) {
        n += 1 + countTree(node.children);
    }
    return n;
}

function detectLanguage(fileName) {
    const base = baseName(fileName).toLowerCase();
    const dot = base.lastIndexOf('.');
    const ext = dot < 0 ? base : base.slice(dot + 1);
    const entry = EXTENSIONS[ext];
    if (!entry) return null;
    return {parser: entry[0], name: entry[1], ext};
}

function parseStructure(fileName, text) {
    const source = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    const totalLines = Math.max(1, source.split('\n').length);
    const root = {
        kind: 'file',
        label: baseName(fileName) || '未命名',
        detail: '',
        line: 1,
        column: 1,
        endLine: totalLines,
        children: [],
    };
    if (!source.trim()) {
        return {root, supported: true, language: '', empty: true, message: '文件为空'};
    }
    if (source.length > MAX_TEXT) {
        return {root, supported: false, reason: '文件过大（超过 8 MB），已跳过结构解析', language: '', hint: ''};
    }
    const lang = detectLanguage(fileName);
    if (!lang) {
        return {root, supported: false, reason: '当前文件类型暂不支持结构视图', language: '', hint: SUPPORT_HINT};
    }
    try {
        const parser = PARSERS[lang.parser];
        if (!parser) {
            return {root, supported: false, reason: '当前文件类型暂不支持结构视图', language: lang.name, hint: SUPPORT_HINT};
        }
        const parsed = parser(source, totalLines, fileName) || {};
        if (parsed.error) {
            return {root, supported: false, reason: parsed.error, language: lang.name, hint: ''};
        }
        const capped = capTree(parsed.children || [], MAX_NODES);
        finalizeRanges(capped.children, totalLines);
        root.children = capped.children;
        root.endLine = totalLines;
        return {
            root,
            supported: true,
            language: lang.name,
            truncated: capped.truncated || !!parsed.truncated,
            empty: !capped.children.length,
            message: parsed.message || '',
        };
    } catch (e) {
        return {root, supported: false, reason: '结构解析失败：' + ((e && e.message) || e), language: lang.name, hint: ''};
    }
}

// ===== Markdown =====

function plainMarkdownText(text) {
    let s = String(text == null ? '' : text);
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    s = s.replace(/`([^`]+)`/g, '$1');
    s = s.replace(/<[^>]+>/g, '');
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
    s = s.replace(/__([^_]+)__/g, '$1');
    s = s.replace(/\*([^*]+)\*/g, '$1');
    s = s.replace(/_([^_]+)_/g, '$1');
    s = s.replace(/~~([^~]+)~~/g, '$1');
    s = s.replace(/\s+/g, ' ').trim();
    return s || String(text || '').trim();
}

function parseMarkdown(source) {
    const lines = splitLines(source);
    const children = [];
    const stack = [{level: 0, children}];
    let fence = null;
    let frontMatterEnd = -1;
    if (lines.length > 0 && /^\s*---\s*$/.test(lines[0])) {
        for (let i = 1; i < Math.min(lines.length, 120); i++) {
            if (/^\s*(?:---|\.\.\.)\s*$/.test(lines[i])) { frontMatterEnd = i; break; }
        }
    }

    function addHeading(level, rawLabel, lineIndex, column) {
        while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
        const parent = stack[stack.length - 1];
        const label = plainMarkdownText(rawLabel) || String(rawLabel || '').trim();
        if (!label) return;
        const node = makeNode('heading', label, lineIndex + 1, column);
        parent.children.push(node);
        stack.push({level, children: node.children});
    }

    for (let i = 0; i < lines.length; i++) {
        if (i <= frontMatterEnd) continue;
        const line = lines[i];
        const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
        if (fenceMatch) {
            if (!fence) fence = {char: fenceMatch[1][0], len: fenceMatch[1].length};
            else if (fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.len) fence = null;
            continue;
        }
        if (fence) continue;
        const atx = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        if (atx) {
            addHeading(atx[1].length, atx[2], i, Math.max(1, line.indexOf(atx[2]) + 1));
            continue;
        }
        if (line.trim() && i + 1 < lines.length && !/^[ \t]*[-*+>|]/.test(line)) {
            const underline = /^\s{0,3}(?:=+|-+)\s*$/.exec(lines[i + 1]);
            if (underline) {
                const level = underline[0].trim().startsWith('=') ? 1 : 2;
                addHeading(level, line.trim(), i, Math.max(1, line.search(/[^\s]/) + 1));
                i++;
            }
        }
    }
    return {children};
}

// ===== HTML / XML =====

const HTML_VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function parseAttributes(attrText) {
    const attrs = {};
    const re = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let m;
    while ((m = re.exec(attrText || ''))) {
        attrs[m[1].toLowerCase()] = m[3] != null ? m[3] : (m[4] != null ? m[4] : (m[5] != null ? m[5] : ''));
    }
    return attrs;
}

function parseTagOpen(text, i) {
    let j = i + 1;
    if (!/[A-Za-z_]/.test(text[j] || '')) return null;
    const nameStart = j;
    while (j < text.length && /[A-Za-z0-9_:.-]/.test(text[j])) j++;
    const name = text.slice(nameStart, j);
    let quote = null;
    while (j < text.length) {
        const ch = text[j];
        if (quote) {
            if (ch === quote) quote = null;
            j++;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; j++; continue; }
        if (ch === '>') {
            const selfClose = text[j - 1] === '/';
            return {
                name,
                nameStart,
                end: j + 1,
                selfClose,
                attrText: text.slice(nameStart + name.length, selfClose ? j - 1 : j),
            };
        }
        j++;
    }
    return null;
}

function parseTagClose(text, i) {
    const m = /^<\/\s*([A-Za-z_][\w:.-]*)\s*>/.exec(text.slice(i, i + 240));
    if (!m) return null;
    return {name: m[1], end: i + m[0].length};
}

function parseHtml(source, totalLines, fileName) {
    const ext = baseName(fileName).toLowerCase().split('.').pop();
    const htmlMode = ['html', 'htm', 'xhtml', 'vue'].includes(ext);
    const starts = lineStarts(source);
    const rootChildren = [];
    const stack = [{name: '', node: null, children: rootChildren}];
    const lowerVoid = htmlMode ? HTML_VOID : new Set();
    let i = 0;
    let truncated = false;
    let nodeCount = 0;

    while (i < source.length) {
        const lt = source.indexOf('<', i);
        if (lt < 0) break;
        i = lt;
        if (source.startsWith('<!--', i)) {
            const end = source.indexOf('-->', i + 4);
            i = end < 0 ? source.length : end + 3;
            continue;
        }
        if (source.startsWith('<![CDATA[', i)) {
            const end = source.indexOf(']]>', i + 9);
            i = end < 0 ? source.length : end + 3;
            continue;
        }
        if (source.startsWith('<?', i)) {
            const end = source.indexOf('?>', i + 2);
            i = end < 0 ? source.length : end + 2;
            continue;
        }
        if (source.startsWith('<!', i)) {
            const end = source.indexOf('>', i + 2);
            i = end < 0 ? source.length : end + 1;
            continue;
        }
        if (source.startsWith('</', i)) {
            const close = parseTagClose(source, i);
            if (!close) { i++; continue; }
            const pos = linePosition(starts, i);
            const name = close.name.toLowerCase();
            let found = -1;
            for (let k = stack.length - 1; k > 0; k--) {
                if (stack[k].name === name) { found = k; break; }
            }
            if (found > 0) {
                for (let k = stack.length - 1; k >= found; k--) {
                    const entry = stack[k];
                    if (entry.node) entry.node.endLine = Math.max(entry.node.line, pos.line);
                }
                stack.length = found;
            }
            i = close.end;
            continue;
        }
        const open = parseTagOpen(source, i);
        if (!open) { i++; continue; }
        const pos = linePosition(starts, open.nameStart);
        const attr = parseAttributes(open.attrText);
        const lower = open.name.toLowerCase();
        let label = open.name;
        if (attr.id) label += '#' + attr.id;
        else if (attr.class) label += attr.class.trim().split(/\s+/).slice(0, 2).map((c) => '.' + c).join('');
        const node = makeNode('tag', label, pos.line, pos.column);
        if (lower === 'link') node.detail = attr.href || '';
        else if (lower === 'script') node.detail = attr.src || '';
        else if (lower === 'meta') node.detail = attr.charset ? 'charset=' + attr.charset : (attr.name || attr.property || attr['http-equiv'] || '');
        else if (lower === 'title' || lower === 'h1' || lower === 'h2' || lower === 'h3') {
            const closeText = source.indexOf('</' + lower, open.end);
            if (closeText > open.end) {
                const text = source.slice(open.end, closeText).replace(/\s+/g, ' ').trim();
                if (text) node.detail = clampLabel(text, 60);
            }
        }
        stack[stack.length - 1].children.push(node);
        nodeCount++;
        if (nodeCount >= MAX_NODES) { truncated = true; break; }

        const selfClose = open.selfClose || lowerVoid.has(lower);
        i = open.end;
        if (selfClose) {
            node.endLine = pos.line;
            continue;
        }
        if (lower === 'script' || lower === 'style') {
            const closeRe = new RegExp('</\\s*' + lower + '\\s*>', 'i');
            const rest = source.slice(i);
            const closeMatch = closeRe.exec(rest);
            if (closeMatch) {
                const closeStart = i + closeMatch.index;
                const closePos = linePosition(starts, closeStart);
                node.endLine = closePos.line;
                i = closeStart + closeMatch[0].length;
                // script/style 内容整体跳过：节点不再压栈，避免后面的标签挂到脚本里
                continue;
            }
        }
        stack.push({name: lower, node, children: node.children});
    }
    while (stack.length > 1) {
        const entry = stack.pop();
        if (entry.node && !entry.node.endLine) entry.node.endLine = totalLines;
    }
    return {children: rootChildren, truncated};
}

// ===== Python =====

function indentWidth(line) {
    let w = 0;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === ' ') w++;
        else if (ch === '\t') w += 4;
        else break;
    }
    return w;
}

function maskPythonLines(lines) {
    const out = [];
    let triple = null;
    for (const line of lines) {
        let res = '';
        let i = 0;
        while (i < line.length) {
            if (triple) {
                const end = line.indexOf(triple, i);
                if (end < 0) {
                    res += ' '.repeat(line.length - i);
                    i = line.length;
                } else {
                    res += ' '.repeat(end + triple.length - i);
                    i = end + triple.length;
                    triple = null;
                }
                continue;
            }
            const ch = line[i];
            if (ch === '#') {
                res += ' '.repeat(line.length - i);
                break;
            }
            if (ch === '\'' || ch === '"') {
                const three = ch + ch + ch;
                if (line.startsWith(three, i)) {
                    triple = three;
                    res += '   ';
                    i += 3;
                    continue;
                }
                let j = i + 1;
                res += ' ';
                while (j < line.length) {
                    if (line[j] === '\\') { res += '  '; j += 2; continue; }
                    if (line[j] === ch) { res += ' '; j++; break; }
                    res += ' ';
                    j++;
                }
                i = j;
                continue;
            }
            res += ch;
            i++;
        }
        out.push(res);
    }
    return out;
}

function parsePython(source) {
    const lines = splitLines(source);
    const masked = maskPythonLines(lines);
    const root = {kind: 'root', children: []};
    const stack = [{indent: -1, kind: 'root', node: root}];
    let pendingDecorators = [];
    let lastCode = 0;
    for (let i = 0; i < lines.length; i++) {
        const code = masked[i];
        if (!code.trim()) continue;
        const orig = lines[i];
        const indent = indentWidth(orig);
        if (/^\s*@/.test(code)) {
            const dm = /^\s*@\s*([A-Za-z_][\w.]*)/.exec(code);
            if (dm) pendingDecorators.push({indent, label: '@' + dm[1]});
            lastCode = i + 1;
            continue;
        }
        while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
            const scope = stack.pop();
            if (!scope.node.endLine) scope.node.endLine = Math.max(scope.node.line, lastCode);
        }
        const parent = stack[stack.length - 1];
        let kind = null;
        let name = null;
        let nameIndex = -1;
        let match = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(code);
        if (match) {
            kind = parent.kind === 'class' ? 'method' : 'function';
            name = match[1];
            nameIndex = match.index + match[0].lastIndexOf(name);
        } else {
            match = /^\s*class\s+([A-Za-z_]\w*)/.exec(code);
            if (match) {
                kind = 'class';
                name = match[1];
                nameIndex = match.index + match[0].lastIndexOf(name);
            }
        }
        if (kind) {
            const node = makeNode(kind, name, i + 1, nameIndex + 1);
            node.label = signatureText(orig, code, nameIndex, name);
            if (pendingDecorators.length && pendingDecorators.every((d) => d.indent === indent)) {
                node.detail = pendingDecorators.map((d) => d.label).join(' ');
            }
            parent.node.children.push(node);
            pendingDecorators = [];
            stack.push({indent, kind: kind === 'class' ? 'class' : 'function', node});
            lastCode = i + 1;
            continue;
        }
        if ((parent.kind === 'root' && indent === 0) || parent.kind === 'class') {
            const vm = /^\s*([A-Za-z_]\w*)\s*(?::[^=]*)?=(?!=)/.exec(code);
            if (vm && !RESERVED.has(vm[1])) {
                const node = makeNode(parent.kind === 'class' ? 'field' : 'variable', vm[1], i + 1, vm.index + vm[0].lastIndexOf(vm[1]) + 1);
                parent.node.children.push(node);
            }
        }
        pendingDecorators = [];
        lastCode = i + 1;
    }
    while (stack.length > 1) {
        const scope = stack.pop();
        if (!scope.node.endLine) scope.node.endLine = Math.max(scope.node.line, lastCode);
    }
    return {children: root.children};
}

// ===== 花括号语言（JS/TS、Go、Java 系、Rust、PHP） =====

function maskCLikeLines(lines, style) {
    const out = [];
    let blockComment = false;
    let quote = null;
    let quoteEscape = false;
    for (const line of lines) {
        let res = '';
        let i = 0;
        while (i < line.length) {
            if (blockComment) {
                const end = line.indexOf('*/', i);
                if (end < 0) {
                    res += ' '.repeat(line.length - i);
                    i = line.length;
                } else {
                    res += ' '.repeat(end + 2 - i);
                    i = end + 2;
                    blockComment = false;
                }
                continue;
            }
            if (quote) {
                const ch = line[i];
                if (quoteEscape) { res += ' '; quoteEscape = false; i++; continue; }
                if (ch === '\\') { res += ' '; quoteEscape = true; i++; continue; }
                if (ch === quote) { res += ' '; quote = null; i++; continue; }
                res += ' ';
                i++;
                continue;
            }
            const ch = line[i];
            if ((style === 'php' || style === 'ruby') && ch === '#') {
                res += ' '.repeat(line.length - i);
                break;
            }
            if (style === 'lua' && ch === '-' && line[i + 1] === '-') {
                res += ' '.repeat(line.length - i);
                break;
            }
            if (ch === '/' && line[i + 1] === '/') {
                res += ' '.repeat(line.length - i);
                break;
            }
            if (ch === '/' && line[i + 1] === '*') {
                blockComment = true;
                res += '  ';
                i += 2;
                continue;
            }
            if (ch === '"' || ch === '\'' || ch === '`') {
                quote = ch;
                res += ' ';
                i++;
                continue;
            }
            res += ch;
            i++;
        }
        out.push(res);
    }
    return out;
}

function methodInfoFromLine(code) {
    const trimmed = code.trim();
    if (!trimmed || trimmed.startsWith('@')) return null;
    const p = code.indexOf('(');
    if (p < 0) return null;
    const eq = code.indexOf('=');
    if (eq >= 0 && eq < p) return null;
    let j = p - 1;
    while (j >= 0 && /\s/.test(code[j])) j--;
    const endName = j;
    while (j >= 0 && /[A-Za-z0-9_$.#~]/.test(code[j])) j--;
    let name = code.slice(j + 1, endName + 1).replace(/^~/, '');
    if (!name || !/[A-Za-z_$]/.test(name) || RESERVED.has(name)) return null;
    const last = code.trim().slice(-1);
    if (last !== '{' && last !== ';') return null;
    if (/^\s*(?:return|throw|new|delete|await|yield|typeof|instanceof|case|else|try|do|finally|goto|using|typedef|#)\b/.test(code)) return null;
    return {name, nameIndex: j + 1};
}

function jsTypeInfo(code) {
    const m = /^\s*(?:export\s+(?:default\s+)?|declare\s+|abstract\s+|default\s+|public\s+|private\s+|protected\s+|readonly\s+|static\s+)*(class|interface|enum)\s+([A-Za-z_$][\w$]*)/.exec(code);
    if (!m) return null;
    return {kind: m[1], name: m[2], nameIndex: m.index + m[0].lastIndexOf(m[2])};
}

function jsTypeAlias(code) {
    const m = /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/.exec(code);
    return m ? {kind: 'type', name: m[1], nameIndex: m.index + m[0].lastIndexOf(m[1])} : null;
}

function jsFunctionDecl(code) {
    const m = /^\s*(?:export\s+(?:default\s+)?|declare\s+|async\s+|default\s+)*function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(code);
    return m ? {kind: 'function', name: m[1], nameIndex: m.index + m[0].lastIndexOf(m[1])} : null;
}

function jsArrowFunction(code, parent) {
    const m = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*/.exec(code);
    if (!m) return null;
    const tail = code.slice(m[0].length);
    const fnHead = /^(?:async\s+)?(?:function\b|(?:\([^;]*\)|[A-Za-z_$][\w$]*)\s*=>)/.exec(tail);
    if (!fnHead) return null;
    return {
        kind: parent.kind === 'class' ? 'method' : 'function',
        name: m[1],
        nameIndex: m.index + m[0].lastIndexOf(m[1]),
    };
}

function jsMethod(code, parent) {
    if (parent.kind !== 'class' && parent.kind !== 'interface' && parent.kind !== 'enum') return null;
    const hit = methodInfoFromLine(code);
    if (!hit) return null;
    return {kind: 'method', name: hit.name, nameIndex: hit.nameIndex};
}

function jsClassField(code, parent) {
    if (parent.kind !== 'class' && parent.kind !== 'interface' && parent.kind !== 'enum') return null;
    const m = /^\s*(?:static\s+|readonly\s+|public\s+|private\s+|protected\s+|declare\s+|abstract\s+|override\s+|accessor\s+)*([A-Za-z_$#][\w$]*)\s*(?::[^=;]+)?(?:=|;)/.exec(code);
    if (!m) return null;
    if (code.includes('(') && !code.includes('=>')) return null;
    const name = m[1];
    if (!name || RESERVED.has(name)) return null;
    return {kind: 'field', name, nameIndex: m.index + m[0].lastIndexOf(m[1])};
}

function jsVariable(code, parent) {
    if (parent.kind !== 'root' && parent.kind !== 'module' && parent.kind !== 'function') return null;
    const m = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(code);
    if (!m) return null;
    return {kind: 'variable', name: m[1], nameIndex: m.index + m[0].lastIndexOf(m[1])};
}

function goTypeEqual(code) {
    const m = /^\s*type\s+([A-Za-z_]\w*)\s+(struct|interface)\s*\{/.exec(code);
    if (m) return {kind: m[2] === 'interface' ? 'interface' : 'class', name: m[1], nameIndex: m.index + m[0].lastIndexOf(m[1]), detail: m[2]};
    const alias = /^\s*type\s+([A-Za-z_]\w*)\s*=\s*([^\s{]+)/.exec(code);
    if (alias) return {kind: 'type', name: alias[1], nameIndex: alias.index + alias[0].indexOf(alias[1]), detail: alias[2], container: false};
    return null;
}

function goFunc(code) {
    const m = /^\s*func\s*(?:\(([^)]*)\))?\s*([A-Za-z_]\w*)\s*\(/.exec(code);
    if (!m) return null;
    const name = m[2];
    const nameIndex = m.index + m[0].lastIndexOf(name);
    const recv = (m[1] || '').trim();
    let detail = '';
    let kind = 'function';
    if (recv) {
        const parts = recv.split(/\s+/).filter(Boolean);
        const last = parts[parts.length - 1] || '';
        detail = last.replace(/^\*/, '').replace(/^\[\]/, '').split('.').pop();
        kind = 'method';
    }
    return {kind, name, nameIndex, detail};
}

function goField(code, parent) {
    if (parent.kind !== 'class') return null;
    if (code.includes('(')) return null;
    const m = /^\s*(?:[A-Za-z_]\w*)\s+([\[\]\w.*]+)\s*(?:`[^`]*`)?\s*$/.exec(code);
    if (!m) return null;
    const word = m[0].trim().split(/\s+/);
    const name = word[0];
    if (!name || RESERVED.has(name) || name.startsWith('//')) return null;
    return {kind: 'field', name, nameIndex: code.indexOf(name), detail: m[1]};
}

function goInterfaceMethod(code) {
    const m = /^\s*([A-Za-z_]\w*)\s*\(/.exec(code);
    if (!m || RESERVED.has(m[1])) return null;
    return {kind: 'method', name: m[1], nameIndex: m.index + m[0].lastIndexOf(m[1])};
}

function goConstVar(code, parent) {
    if (parent.kind !== 'root') return null;
    const m = /^\s*(?:const|var)\s+([A-Za-z_]\w*)/.exec(code);
    if (!m) return null;
    return {kind: 'variable', name: m[1], nameIndex: m.index + m[0].lastIndexOf(m[1])};
}

function clikeTypeInfo(code) {
    const m = /^\s*(?:@[A-Za-z_]\w*(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|abstract|final|sealed|static|data|record|open|partial|export|declare|non-sealed|value)\s+)*(class|interface|enum(?:\s+(?:class|struct))?|record|struct|object|trait|protocol|extension|union)\s+([A-Za-z_]\w*)/.exec(code);
    if (!m) return null;
    const detail = m[1].replace(/\s+/g, ' ');
    const key = detail.split(' ')[0];
    let kind = 'class';
    if (key === 'interface' || key === 'trait' || key === 'protocol') kind = 'interface';
    else if (key === 'enum') kind = 'enum';
    return {kind, name: m[2], nameIndex: m.index + m[0].lastIndexOf(m[2]), detail};
}

function clikeNamespace(code) {
    const m = /^\s*namespace\s+([A-Za-z_][\w:.]*)/.exec(code);
    if (!m) return null;
    return {kind: 'module', name: m[1], nameIndex: m.index + m[0].lastIndexOf(m[1])};
}

function clikeFunc(code, parent) {
    if (code.trim().startsWith('#')) return null;
    const hit = methodInfoFromLine(code);
    if (!hit) return null;
    const kind = (parent.kind === 'class' || parent.kind === 'interface' || parent.kind === 'enum') ? 'method' : 'function';
    return {kind, name: hit.name, nameIndex: hit.nameIndex};
}

function rustFn(code, parent) {
    const m = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?(?:extern(?:\s+"[^"]*")?\s+)?fn\s+([A-Za-z_]\w*)/.exec(code);
    if (!m) return null;
    const kind = parent.kind === 'class' || parent.kind === 'interface' ? 'method' : 'function';
    return {kind, name: m[1], nameIndex: m.index + m[0].lastIndexOf(m[1])};
}

function rustType(code) {
    const m = /^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|union)\s+([A-Za-z_]\w*)/.exec(code);
    if (!m) return null;
    const kind = m[1] === 'trait' ? 'interface' : (m[1] === 'enum' ? 'enum' : 'class');
    return {kind, name: m[2], nameIndex: m.index + m[0].lastIndexOf(m[2]), detail: m[1]};
}

function rustImpl(code) {
    const m = /^\s*(?:unsafe\s+)?impl(?:<[^>]*>)?\s+([^\s{]+)(?:\s+for\s+([^\s{]+))?\s*\{/.exec(code);
    if (!m) return null;
    const target = m[1];
    const forType = m[2];
    const label = 'impl ' + target + (forType ? ' for ' + forType : '');
    return {kind: 'class', name: target, nameIndex: m.index + m[0].lastIndexOf(target), label, detail: forType ? 'for ' + forType : ''};
}

function rustMod(code) {
    const m = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/.exec(code);
    if (!m) return null;
    return {kind: 'module', name: m[1], nameIndex: m.index + m[0].lastIndexOf(m[1]), label: 'mod ' + m[1]};
}

function rustField(code, parent) {
    if (parent.kind !== 'class' || !parent.node || parent.node.detail !== 'struct') return null;
    const m = /^\s*(?:pub(?:\([^)]*\))?\s+)?([A-Za-z_]\w*)\s*:\s*([^,}]+)/.exec(code);
    if (!m) return null;
    return {kind: 'field', name: m[1], nameIndex: m.index + m[0].lastIndexOf(m[1]), detail: m[2].trim(), container: false};
}

function rustConst(code, parent) {
    if (parent.kind !== 'root' && parent.kind !== 'module') return null;
    const m = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Za-z_]\w*)/.exec(code);
    if (!m) return null;
    return {kind: 'variable', name: m[1], nameIndex: m.index + m[0].lastIndexOf(m[1])};
}

function rustTypeAlias(code) {
    const m = /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/.exec(code);
    return m ? {kind: 'type', name: m[1], nameIndex: m.index + m[0].lastIndexOf(m[1]), container: false} : null;
}

function phpType(code) {
    const m = /^\s*(?:(?:public|private|protected|abstract|final|readonly|static)\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/.exec(code);
    if (!m) return null;
    const kind = m[1] === 'interface' || m[1] === 'trait' ? 'interface' : (m[1] === 'enum' ? 'enum' : 'class');
    return {kind, name: m[2], nameIndex: m.index + m[0].lastIndexOf(m[2]), detail: m[1]};
}

function phpFunction(code, parent) {
    const m = /^\s*(?:(?:public|private|protected|static|abstract|final|async)\s+)*function\s*&?\s*([A-Za-z_]\w*)\s*\(/.exec(code);
    if (!m) return null;
    const kind = (parent.kind === 'class' || parent.kind === 'interface') ? 'method' : 'function';
    return {kind, name: m[1], nameIndex: m.index + m[0].lastIndexOf(m[1])};
}

function clikeField(code, parent) {
    if (parent.kind !== 'class' && parent.kind !== 'interface' && parent.kind !== 'enum') return null;
    const trimmed = code.trim();
    if (!trimmed.endsWith(';') || trimmed.includes('(')) return null;
    const body = trimmed.slice(0, -1);
    const eq = body.indexOf('=');
    const decl = eq >= 0 ? body.slice(0, eq) : body;
    const m = /([A-Za-z_$][\w$]*)\s*(?::[^=]*)?$/.exec(decl);
    if (!m) return null;
    const name = m[1];
    if (!name || RESERVED.has(name)) return null;
    const before = decl.slice(0, m.index).trim();
    if (!before) return null;
    const declStart = code.indexOf(decl);
    return {kind: 'field', name, nameIndex: (declStart >= 0 ? declStart : 0) + m.index, container: false};
}

function phpVariable(code, parent) {
    if (parent.kind !== 'root') return null;
    const m = /^\s*\$([A-Za-z_]\w*)\s*=/.exec(code);
    if (!m) return null;
    return {kind: 'variable', name: '$' + m[1], nameIndex: m.index + m[0].lastIndexOf('$' + m[1])};
}

const PROFILES = {
    javascript: {
        style: 'c',
        rules: [
            {contexts: ['root', 'function', 'class', 'interface', 'module'], container: true, detect: jsTypeInfo},
            {contexts: ['root', 'function', 'class', 'interface', 'module'], container: false, detect: jsTypeAlias},
            {contexts: ['root', 'function', 'class', 'interface', 'module'], container: true, detect: jsFunctionDecl},
            {contexts: ['root', 'function', 'class', 'interface', 'module'], container: true, detect: jsArrowFunction},
            {contexts: ['class', 'interface', 'enum'], container: true, detect: jsMethod},
            {contexts: ['class', 'interface', 'enum'], container: false, detect: jsClassField},
            {contexts: ['root', 'module', 'function'], container: false, detect: jsVariable},
        ],
    },
    go: {
        style: 'go',
        rules: [
            {contexts: ['root'], container: true, detect: goTypeEqual},
            {contexts: ['root'], container: true, detect: goFunc},
            {contexts: ['class'], container: false, detect: goField},
            {contexts: ['interface'], container: false, detect: goInterfaceMethod},
            {contexts: ['root'], container: false, detect: goConstVar},
        ],
    },
    clike: {
        style: 'c',
        rules: [
            {contexts: ['root', 'class', 'interface', 'enum', 'module', 'function'], container: true, detect: clikeTypeInfo},
            {contexts: ['root', 'class', 'interface', 'enum', 'module', 'function'], container: true, detect: clikeNamespace},
            {contexts: ['root', 'class', 'interface', 'enum', 'module', 'function'], container: true, detect: clikeFunc},
            {contexts: ['class', 'interface', 'enum'], container: false, detect: clikeField},
        ],
    },
    rust: {
        style: 'c',
        rules: [
            {contexts: ['root', 'class', 'interface', 'module', 'function'], container: true, detect: rustType},
            {contexts: ['root', 'class', 'interface', 'module', 'function'], container: true, detect: rustImpl},
            {contexts: ['root', 'class', 'interface', 'module', 'function'], container: true, detect: rustMod},
            {contexts: ['root', 'class', 'interface', 'module', 'function'], container: true, detect: rustFn},
            {contexts: ['class'], container: false, detect: rustField},
            {contexts: ['root', 'module'], container: false, detect: rustConst},
            {contexts: ['root', 'module'], container: false, detect: rustTypeAlias},
        ],
    },
    php: {
        style: 'php',
        rules: [
            {contexts: ['root', 'class', 'interface', 'enum', 'module', 'function'], container: true, detect: phpType},
            {contexts: ['root', 'class', 'interface', 'enum', 'module', 'function'], container: true, detect: phpFunction},
            {contexts: ['root'], container: false, detect: phpVariable},
        ],
    },
};

function parseBrace(source, totalLines, profile) {
    const lines = splitLines(source);
    const masked = maskCLikeLines(lines, profile.style);
    const root = {kind: 'root', children: [], bodyDepth: 0};
    const stack = [{node: root, bodyDepth: 0, kind: 'root'}];
    let depth = 0;
    let lastCode = 0;
    for (let i = 0; i < lines.length; i++) {
        const code = masked[i];
        const orig = lines[i];
        while (stack.length > 1 && depth < stack[stack.length - 1].bodyDepth) {
            const scope = stack.pop();
            if (!scope.node.endLine) scope.node.endLine = Math.max(scope.node.line, i);
        }
        if (code.trim()) {
            const parent = stack[stack.length - 1];
            if (depth === parent.bodyDepth) {
                for (const rule of profile.rules) {
                    if (!rule.contexts.includes(parent.kind)) continue;
                    const hit = rule.detect(code, parent);
                    if (!hit || !hit.name) continue;
                    if (!hit.label && RESERVED.has(hit.name)) continue;
                    const kind = hit.kind || 'function';
                    const noParams = kind === 'variable' || kind === 'field' || kind === 'type' || kind === 'module';
                    const label = hit.label || (noParams ? hit.name : signatureText(orig, code, hit.nameIndex, hit.name));
                    const node = makeNode(kind, label, i + 1, (hit.nameIndex || 0) + 1);
                    node.detail = hit.detail || '';
                    parent.node.children.push(node);
                    let bodyDepth = null;
                    if (rule.container !== false && hit.container !== false) {
                        const opens = countChar(code, '{');
                        const closes = countChar(code, '}');
                        if (opens > 0) {
                            const after = depth + opens - closes;
                            if (after > depth) bodyDepth = after;
                        } else if (!/;\s*$/.test(code) && !/:\s*$/.test(code)) {
                            for (let k = i + 1; k < Math.min(lines.length, i + 20); k++) {
                                const nextCode = masked[k];
                                if (!nextCode.trim()) continue;
                                if (nextCode.includes('{')) { bodyDepth = depth + 1; break; }
                                if (/;\s*$/.test(nextCode)) break;
                            }
                        }
                    }
                    if (bodyDepth != null) stack.push({node, bodyDepth, kind: node.kind});
                    break;
                }
            }
        }
        if (code.trim()) lastCode = i + 1;
        depth += countChar(code, '{') - countChar(code, '}');
        if (depth < 0) depth = 0;
    }
    while (stack.length > 1) {
        const scope = stack.pop();
        if (!scope.node.endLine) scope.node.endLine = Math.max(scope.node.line, lastCode || totalLines);
    }
    return {children: root.children};
}

function parseJavaScript(source, totalLines) {
    return parseBrace(source, totalLines, PROFILES.javascript);
}

function parseGo(source, totalLines) {
    return parseBrace(source, totalLines, PROFILES.go);
}

function parseClike(source, totalLines) {
    return parseBrace(source, totalLines, PROFILES.clike);
}

function parseRust(source, totalLines) {
    return parseBrace(source, totalLines, PROFILES.rust);
}

function parsePhp(source, totalLines) {
    return parseBrace(source, totalLines, PROFILES.php);
}

// ===== Ruby / Lua（按缩进层级） =====

function parseIndentDefs(source, style, patterns) {
    const lines = splitLines(source);
    const masked = maskCLikeLines(lines, style);
    const root = {kind: 'root', children: []};
    const stack = [{indent: -1, kind: 'root', node: root}];
    let lastCode = 0;
    for (let i = 0; i < lines.length; i++) {
        const code = masked[i];
        if (!code.trim()) continue;
        const orig = lines[i];
        const indent = indentWidth(orig);
        while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
            const scope = stack.pop();
            if (!scope.node.endLine) scope.node.endLine = Math.max(scope.node.line, lastCode);
        }
        const parent = stack[stack.length - 1];
        for (const pattern of patterns) {
            const m = pattern.re.exec(code);
            if (!m) continue;
            const name = m[pattern.nameGroup || 1];
            if (!name || RESERVED.has(name)) break;
            const node = makeNode(pattern.kind || 'function', name, i + 1, m.index + m[0].lastIndexOf(name) + 1);
            node.label = signatureText(orig, code, m.index + m[0].lastIndexOf(name), name);
            if (pattern.detail) node.detail = pattern.detail(m);
            parent.node.children.push(node);
            stack.push({indent, kind: node.kind === 'class' ? 'class' : 'function', node});
            break;
        }
        lastCode = i + 1;
    }
    while (stack.length > 1) {
        const scope = stack.pop();
        if (!scope.node.endLine) scope.node.endLine = Math.max(scope.node.line, lastCode);
    }
    return {children: root.children};
}

function parseRuby(source) {
    return parseIndentDefs(source, 'ruby', [
        {re: /^\s*class\s+([A-Za-z_]\w*)/, kind: 'class'},
        {re: /^\s*module\s+([A-Za-z_]\w*)/, kind: 'module'},
        {re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/, kind: 'method'},
    ]);
}

function parseLua(source) {
    return parseIndentDefs(source, 'lua', [
        {re: /^\s*(?:local\s+)?function\s+([A-Za-z_]\w*(?:[.:][A-Za-z_]\w*)?)/, kind: 'function'},
    ]);
}

function parseShell(source) {
    const lines = splitLines(source);
    const children = [];
    for (let i = 0; i < lines.length; i++) {
        const m = /^\s*(?:function\s+)?([A-Za-z_][\w.-]*)\s*\(\)\s*\{?/.exec(lines[i]) || /^\s*function\s+([A-Za-z_][\w.-]*)/.exec(lines[i]);
        if (!m || RESERVED.has(m[1])) continue;
        const node = makeNode('function', m[1], i + 1, m.index + m[0].lastIndexOf(m[1]) + 1);
        children.push(node);
    }
    return {children};
}

// ===== JSON / JSONL =====

function jsonTokens(text, starts) {
    const tokens = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }
        if (ch === '{' || ch === '}' || ch === '[' || ch === ']' || ch === ':' || ch === ',') {
            const pos = linePosition(starts, i);
            tokens.push({type: ch, value: ch, line: pos.line, column: pos.column});
            i++;
            continue;
        }
        if (ch === '"') {
            const start = i;
            i++;
            let value = '';
            while (i < text.length) {
                const c = text[i];
                if (c === '\\') {
                    const esc = text[i + 1];
                    const map = {'"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t'};
                    if (esc === 'u') {
                        const hex = text.slice(i + 2, i + 6);
                        value += String.fromCharCode(parseInt(hex, 16) || 0);
                        i += 6;
                    } else {
                        value += map[esc] || esc || '';
                        i += 2;
                    }
                    continue;
                }
                if (c === '"') { i++; break; }
                value += c;
                i++;
            }
            const pos = linePosition(starts, start);
            tokens.push({type: 'string', value, line: pos.line, column: pos.column});
            continue;
        }
        const start = i;
        while (i < text.length && !/[\s{}\[\]:,]/.test(text[i])) i++;
        if (i === start) i++;
        const pos = linePosition(starts, start);
        tokens.push({type: 'primitive', value: text.slice(start, i), line: pos.line, column: pos.column});
    }
    return tokens;
}

function parseJson(source) {
    try {
        JSON.parse(source);
    } catch (e) {
        return {error: 'JSON 解析失败：' + ((e && e.message) || e)};
    }
    const starts = lineStarts(source);
    const tokens = jsonTokens(source, starts);
    let p = 0;
    let truncated = false;
    const ARRAY_LIMIT = 200;

    function parseValue() {
        const tok = tokens[p];
        if (!tok) throw new Error('意外的结尾');
        if (tok.value === '{') {
            p++;
            const children = [];
            while (tokens[p] && tokens[p].value !== '}') {
                const key = tokens[p];
                if (key.type !== 'string') throw new Error('对象键应为字符串');
                p++;
                if (!tokens[p] || tokens[p].value !== ':') throw new Error('缺少冒号');
                p++;
                const val = parseValue();
                const node = makeNode('key', key.value, key.line, key.column);
                node.children = val.children;
                node.detail = val.detail || '';
                if (val.children.length === 0 && val.container) node.detail = val.detail || '';
                children.push(node);
                if (tokens[p] && tokens[p].value === ',') p++;
            }
            p++;
            return {children, detail: '{}'};
        }
        if (tok.value === '[') {
            p++;
            const children = [];
            let index = 0;
            let primitiveCount = 0;
            while (tokens[p] && tokens[p].value !== ']') {
                const itemTok = tokens[p];
                const val = parseValue();
                if (val.container || val.children.length) {
                    if (children.length < ARRAY_LIMIT) {
                        const node = makeNode('index', '[' + index + ']', itemTok.line, itemTok.column);
                        node.children = val.children;
                        node.detail = val.detail || '';
                        children.push(node);
                    } else {
                        truncated = true;
                    }
                } else {
                    primitiveCount++;
                }
                index++;
                if (tokens[p] && tokens[p].value === ',') p++;
            }
            p++;
            return {children, detail: '[' + index + ' 项]', container: true, primitiveCount};
        }
        p++;
        return {children: [], detail: '', container: false};
    }

    try {
        const rootValue = parseValue();
        if (tokens[p] && p < tokens.length) {
            // 多余 token：交给 JSON.parse 已经校验过，这里仅防止死循环
        }
        return {children: rootValue.children, truncated};
    } catch (e) {
        return {error: 'JSON 结构解析失败：' + ((e && e.message) || e)};
    }
}

function shiftLines(children, offset) {
    for (const node of children) {
        node.line += offset;
        node.endLine += offset;
        shiftLines(node.children, offset);
    }
}

function parseJsonl(source) {
    const lines = splitLines(source);
    const children = [];
    let truncated = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        let parsed;
        try {
            JSON.parse(line);
        } catch (e) {
            return {error: '第 ' + (i + 1) + ' 行 JSON 解析失败：' + e.message};
        }
        parsed = parseJson(line);
        if (parsed.error) return parsed;
        const node = makeNode('index', '第 ' + (i + 1) + ' 行', i + 1, 1);
        node.children = parsed.children;
        shiftLines(node.children, i);
        node.detail = parsed.children.length ? '' : '标量';
        children.push(node);
        if (children.length >= 300) { truncated = true; break; }
    }
    return {children, truncated};
}

// ===== YAML =====

function findYamlColon(content) {
    let quote = null;
    for (let i = 0; i < content.length; i++) {
        const ch = content[i];
        if (quote) {
            if (ch === quote) quote = null;
            if (ch === '\\') i++;
            continue;
        }
        if (ch === '"' || ch === '\'') { quote = ch; continue; }
        if (ch === ':') {
            if (i + 1 >= content.length || /\s/.test(content[i + 1])) return i;
        }
    }
    return -1;
}

function parseYaml(source) {
    const lines = splitLines(source);
    const children = [];
    const stack = [{indent: -1, children}];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim() || /^\s*#/.test(line) || /^\s*(?:---|\.\.\.)\s*$/.test(line)) continue;
        const prefixMatch = /^(\s*)/.exec(line);
        let indent = prefixMatch ? prefixMatch[1].replace(/\t/g, '    ').length : 0;
        let content = line.slice(prefixMatch ? prefixMatch[1].length : 0);
        let isItem = false;
        if (content.startsWith('- ')) {
            isItem = true;
            indent += 2;
            content = content.slice(2);
        } else if (content === '-') {
            continue;
        }
        const colon = findYamlColon(content);
        if (colon < 0) continue;
        let key = content.slice(0, colon).trim();
        if (!key) continue;
        if (key.startsWith('&') || key.startsWith('!')) {
            const pieces = key.split(/\s+/);
            key = pieces.length > 1 ? pieces.slice(1).join(' ') : key;
        }
        if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith('\'') && key.endsWith('\''))) {
            key = key.slice(1, -1);
        }
        while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
        const parent = stack[stack.length - 1];
        const node = makeNode('key', key, i + 1, (prefixMatch ? prefixMatch[1].length : 0) + (isItem ? 2 : 0) + 1);
        parent.children.push(node);
        stack.push({indent, children: node.children});
    }
    return {children};
}

// ===== TOML / INI =====

function parseTomlLike(source, iniMode) {
    const lines = splitLines(source);
    const children = [];
    let current = children;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || (iniMode && trimmed.startsWith(';'))) continue;
        const section = /^\s*(\[\[?\s*[^\]]+\s*\]\]?)\s*$/.exec(line);
        if (section) {
            const raw = section[1].trim();
            const label = raw;
            const node = makeNode('section', label, i + 1, Math.max(1, line.indexOf('[') + 1));
            children.push(node);
            current = node.children;
            continue;
        }
        const eq = line.search(/[=:]/);
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, '');
        if (!key || key.startsWith('-')) continue;
        const node = makeNode('key', key, i + 1, Math.max(1, line.search(/[^\s]/) + 1));
        current.push(node);
    }
    return {children};
}

// ===== 纯文本章节（写作模式）=====

// 章节标题：行首（≤8 空格容错）「第X章/回/节/卷/部/篇/话」或 序章/楔子/引子/尾声/终章/番外/后记
const CHAPTER_LINE = /^\s{0,8}(第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章回节卷部篇话]|序章|楔子|引子|尾声|终章|番外[篇中之外]?|后记)\s*[:：、.．\s]*(.*)$/;

// 与 main.js countWords 同口径：CJK 字符逐个计 + 拉丁词计 1（structure.js 不 import main.js，本地同款小函数）
function countWordsLite(s) {
    const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    const latin = (s.match(/[A-Za-z0-9]+(?:[''-][A-Za-z0-9]+)*/g) || []).length;
    return cjk + latin;
}

function parseNovelChapters(source, totalLines) {
    const lines = splitLines(source);
    const matches = [];
    let truncated = false;
    for (let i = 0; i < lines.length; i++) {
        const m = CHAPTER_LINE.exec(lines[i]);
        if (!m) continue;
        if (matches.length >= MAX_NODES) {
            truncated = true;
            break;
        }
        const unit = m[1].replace(/\s+/g, '');
        const indent = /^\s{0,8}/.exec(lines[i])[0].length;
        matches.push({
            line: i + 1,
            column: indent + 1,
            label: clampLabel(lines[i].trim(), MAX_LABEL),
            // 卷级只认「第X卷/部/篇」；「番外篇」等固定章名虽以「篇」结尾，仍属章级
            isVolume: /^第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[卷部篇]$/.test(unit),
        });
    }
    if (!matches.length) return {children: [], message: '未找到章节标题'};
    // endLine：章 → 下一个章节匹配（任意层级）前；卷 → 下一个卷前；用倒序单遍 O(n)
    let nextAny = totalLines + 1;
    let nextVolume = totalLines + 1;
    for (let i = matches.length - 1; i >= 0; i--) {
        const match = matches[i];
        match.endLine = Math.max(match.line, (match.isVolume ? nextVolume : nextAny) - 1);
        nextAny = match.line;
        if (match.isVolume) nextVolume = match.line;
    }
    // 层级：卷/部/篇作父节点，章/回/节/话挂其下；无卷则平铺
    const children = [];
    let currentVolume = null;
    for (const match of matches) {
        const node = makeNode('chapter', match.label, match.line, match.column);
        node.endLine = match.endLine;
        // 章节字数：line..endLine 原文切片，与 countWords 同口径
        node.detail = countWordsLite(lines.slice(match.line - 1, match.endLine).join('\n')) + ' 字';
        if (match.isVolume) {
            children.push(node);
            currentVolume = node;
        } else if (currentVolume) {
            currentVolume.children.push(node);
        } else {
            children.push(node);
        }
    }
    return truncated ? {children, truncated: true} : {children};
}

// ===== 调度 =====

const PARSERS = {
    markdown: parseMarkdown,
    novel: parseNovelChapters,
    html: parseHtml,
    xml: parseHtml,
    python: parsePython,
    javascript: parseJavaScript,
    go: parseGo,
    clike: parseClike,
    rust: parseRust,
    php: parsePhp,
    ruby: parseRuby,
    lua: parseLua,
    shell: parseShell,
    json: parseJson,
    jsonl: parseJsonl,
    yaml: parseYaml,
    toml: (source) => parseTomlLike(source, false),
    ini: (source) => parseTomlLike(source, true),
};

// ===== 结构面板 UI =====

function keyOf(node, root) {
    if (root) return '__root__';
    return node.kind + '|' + node.line + '|' + node.column + '|' + node.label;
}

function nodeHasChildren(node) {
    return !!(node && node.children && node.children.length);
}

function walkNodes(children, fn) {
    for (const node of children || []) {
        fn(node);
        walkNodes(node.children, fn);
    }
}

export function createStructurePanel(options) {
    const {body, refreshBtn, collapseBtn, getText, getCursorLine, onJump, parseAsync, onSessionJump} = options || {};
    let doc = null;
    let result = null;
    let visible = false;
    let collapsed = new Set();
    let selectedKey = '';
    let currentKey = '';
    let lastDocId = null;
    let currentLine = 0;
    let parseSeq = 0;
    // 两个数据源：文件结构 / 当前 AI 会话的用户消息定位条。
    // sources 由调用方按「内容区当前显示什么」决定；pref 是用户在两者都存在时的偏好。
    let sources = {file: true, session: false};
    let sourcePref = 'file';
    let outline = null;
    let outlineSig = '';
    let outlineActive = -1;

    if (refreshBtn) {
        refreshBtn.innerHTML = ICONS.refresh;
        refreshBtn.addEventListener('click', () => refresh());
    }
    if (collapseBtn) {
        collapseBtn.addEventListener('click', toggleCollapseAll);
    }
    updateCollapseButton();

    function documentText() {
        if (!doc) return '';
        if (typeof getText === 'function') return String(getText(doc) || '');
        return String(doc.text || doc.rawText || doc.content || '');
    }

    function resetViewState(nextDoc) {
        if (!nextDoc || nextDoc.id !== lastDocId) {
            collapsed.clear();
            selectedKey = '';
            currentKey = '';
            currentLine = 0;
        }
        lastDocId = nextDoc ? nextDoc.id : null;
    }

    // 有效来源：只有一个可用时用它；两个都在时听用户偏好（默认文件结构）。
    function effectiveSource() {
        if (!sources.file) return sources.session ? 'session' : 'none';
        if (!sources.session) return 'file';
        return sourcePref === 'session' ? 'session' : 'file';
    }

    function refresh() {
        if (!body) return;
        if (effectiveSource() === 'session') {
            renderSession();
            return;
        }
        if (!doc) {
            result = null;
            renderMessage('打开文件后在这里查看结构', '');
            updateCollapseButton();
            return;
        }
        if (doc.binary) {
            result = null;
            renderMessage(doc.image ? '图片文件没有结构视图' : '二进制文件没有结构视图', '');
            updateCollapseButton();
            return;
        }
        resetViewState(doc);
        const text = documentText();
        const name = doc.name || doc.path || '';
        const seq = ++parseSeq;
        const safeParse = () => {
            try {
                return parseStructure(name, text);
            } catch (e) {
                return {supported: false, reason: '结构解析失败：' + ((e && e.message) || e), root: {children: []}};
            }
        };
        const applyParsed = (parsed) => {
            if (seq !== parseSeq) return;
            result = parsed;
            if (!parsed.supported) {
                renderMessage(parsed.reason || '无法解析结构', parsed.hint || '');
                updateCollapseButton();
                return;
            }
            render();
            syncCursorFromSource();
            updateCollapseButton();
        };
        if (typeof parseAsync === 'function') {
            parseAsync(name, text, doc).then(applyParsed).catch((e) => {
                applyParsed({
                    supported: false,
                    reason: '结构解析失败：' + ((e && e.message) || e),
                    root: {children: []},
                });
            });
            return;
        }
        applyParsed(safeParse());
    }

    function syncCursorFromSource() {
        if (typeof getCursorLine !== 'function') return;
        try {
            const line = Number(getCursorLine());
            if (Number.isFinite(line) && line > 0) setCursor(line);
        } catch (e) {}
    }

    // 会话结构：当前会话的用户消息定位条（数据由 ai-panel 提供）
    function renderSession() {
        body.textContent = '';
        updateCollapseButton();
        if (!outline) {
            renderMessage('正在读取会话结构…', '');
            return;
        }
        if (!(outline.items || []).length) {
            renderMessage('当前会话还没有用户消息', '');
            return;
        }
        renderSessionOutline(body, outline, {
            onJump: (index) => {
                if (typeof onSessionJump === 'function') onSessionJump(index);
            },
        });
    }

    function renderMessage(text, hint, buttonText, action) {
        body.textContent = '';
        const wrap = document.createElement('div');
        wrap.className = 'sb-empty st-empty';
        const line = document.createElement('div');
        line.textContent = text;
        wrap.appendChild(line);
        if (hint) {
            const sub = document.createElement('div');
            sub.className = 'st-empty-hint';
            sub.textContent = hint;
            wrap.appendChild(sub);
        }
        if (buttonText && action) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sb-empty-btn';
            btn.textContent = buttonText;
            btn.addEventListener('click', action);
            wrap.appendChild(btn);
        }
        body.appendChild(wrap);
    }

    function makeRow(node, isRoot) {
        const key = keyOf(node, isRoot);
        const hasKids = nodeHasChildren(node);
        const row = document.createElement('div');
        row.className = 'sb-row st-row' + (isRoot ? ' st-root' : '') +
            (selectedKey === key ? ' selected' : '') +
            (currentKey === key ? ' st-current' : '');
        row.dataset.key = key;
        row.dataset.line = String(node.line);
        row.tabIndex = -1;

        const chev = document.createElement('span');
        chev.className = 'sb-chev' + (hasKids && !collapsed.has(key) ? ' open' : '');
        if (hasKids) {
            chev.innerHTML = ICONS.chevron;
            chev.title = collapsed.has(key) ? '展开' : '折叠';
        }
        row.appendChild(chev);

        if (isRoot) {
            row.appendChild(createFileIcon(doc && doc.name ? doc.name : node.label, 'sb-icon'));
        } else {
            const icon = document.createElement('span');
            icon.className = 'st-icon st-kind-' + node.kind;
            icon.title = KIND_NAME[node.kind] || node.kind;
            icon.textContent = KIND_GLYPH[node.kind] || '·';
            row.appendChild(icon);
        }

        const label = document.createElement('span');
        label.className = 'st-label';
        label.textContent = node.label || (isRoot ? (doc && doc.name) || '' : '');
        row.appendChild(label);

        const detailText = isRoot
            ? (result && result.language ? result.language + (result.empty ? '' : ' · ' + countTree(node.children) + ' 项') : '')
            : (node.detail || '');
        if (detailText) {
            const detail = document.createElement('span');
            detail.className = 'st-detail';
            detail.textContent = detailText;
            detail.title = detailText;
            row.appendChild(detail);
        }

        row.addEventListener('click', (e) => {
            row.focus({preventScroll: true});
            const onChev = e.target && e.target.closest ? e.target.closest('.sb-chev') : null;
            if (onChev && hasKids) {
                if (e.detail > 1) return;
                toggle(key);
                return;
            }
            selectedKey = key;
            updateRowStates();
            if (typeof onJump === 'function') onJump(node, isRoot);
        });
        row.addEventListener('dblclick', (e) => {
            if (e.target && e.target.closest && e.target.closest('.sb-chev')) return;
            if (hasKids) {
                e.preventDefault();
                toggle(key);
            }
        });
        row.addEventListener('keydown', (e) => {
            const rows = [...body.querySelectorAll('.st-row')];
            const idx = rows.indexOf(row);
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (idx + 1 < rows.length) rows[idx + 1].focus();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (idx > 0) rows[idx - 1].focus();
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                if (hasKids && collapsed.has(key)) toggle(key);
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                if (hasKids && !collapsed.has(key)) toggle(key);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                selectedKey = key;
                updateRowStates();
                if (typeof onJump === 'function') onJump(node, isRoot);
            } else if (e.key === ' ') {
                e.preventDefault();
                if (hasKids) toggle(key);
            }
        });
        return row;
    }

    function appendNode(node, parent, isRoot) {
        parent.appendChild(makeRow(node, isRoot));
        const key = keyOf(node, isRoot);
        if (!nodeHasChildren(node) || collapsed.has(key)) return;
        const box = document.createElement('div');
        box.className = 'sb-children';
        for (const child of node.children) appendNode(child, box, false);
        parent.appendChild(box);
    }

    function render() {
        body.textContent = '';
        if (!result || !result.root) return;
        const rootNode = result.root;
        appendNode(rootNode, body, true);
        if (!rootNode.children.length) {
            const status = document.createElement('div');
            status.className = 'sb-row st-status';
            status.textContent = result.message || '未找到可显示的结构项';
            body.appendChild(status);
        }
        if (result.truncated) {
            const status = document.createElement('div');
            status.className = 'sb-row st-status';
            status.textContent = '仅显示前 ' + MAX_NODES + ' 项';
            body.appendChild(status);
        }
        updateRowStates();
    }

    function updateRowStates() {
        for (const row of body.querySelectorAll('.st-row')) {
            const key = row.dataset.key;
            row.classList.toggle('selected', key === selectedKey);
            row.classList.toggle('st-current', key === currentKey);
        }
    }

    function toggle(key) {
        if (collapsed.has(key)) collapsed.delete(key);
        else collapsed.add(key);
        render();
        updateCollapseButton();
        const row = body.querySelector('.st-row[data-key="' + CSS.escape(key) + '"]');
        if (row) row.focus({preventScroll: true});
    }

    function allContainerKeys() {
        const keys = [];
        if (result && result.root) {
            if (result.root.children && result.root.children.length) keys.push('__root__');
            walkNodes(result.root.children, (node) => {
                if (nodeHasChildren(node)) keys.push(keyOf(node, false));
            });
        }
        return keys;
    }

    function hasExpandedContainer() {
        const keys = allContainerKeys();
        return keys.some((key) => !collapsed.has(key));
    }

    function toggleCollapseAll() {
        const keys = allContainerKeys();
        if (!keys.length) return;
        if (hasExpandedContainer()) {
            for (const key of keys) collapsed.add(key);
        } else {
            collapsed.clear();
        }
        if (result) render();
        updateCollapseButton();
    }

    function updateCollapseButton() {
        if (!collapseBtn) return;
        const expanded = hasExpandedContainer();
        collapseBtn.innerHTML = expanded ? ICONS.collapse : ICONS.expand;
        collapseBtn.title = expanded ? '全部折叠' : '全部展开';
    }

    function setDoc(next) {
        if (next !== doc) {
            doc = next || null;
            result = null;
            collapsed.clear();
            selectedKey = '';
            currentKey = '';
            currentLine = 0;
            lastDocId = null;
            if (visible) refresh();
            return;
        }
        if (visible) refresh();
    }

    function setVisible(next) {
        const want = !!next;
        if (visible === want) {
            if (want && effectiveSource() === 'session') {
                if (!body.firstChild) renderSession();
                return;
            }
            if (want && !result && doc) refresh();
            return;
        }
        visible = want;
        if (!visible) {
            refreshBtn && (refreshBtn.disabled = false);
            return;
        }
        if (refreshBtn) refreshBtn.disabled = false;
        refresh();
    }

    function setCursor(line) {
        const n = Number(line);
        currentLine = Number.isFinite(n) && n > 0 ? n : 0;
        if (!visible) return;
        if (!result || !result.root) {
            if (currentKey) { currentKey = ''; updateRowStates(); }
            return;
        }
        let best = null;
        const pick = (nodes) => {
            for (const node of nodes || []) {
                const end = Math.max(node.endLine || 0, node.line);
                if (currentLine >= node.line && currentLine <= end) {
                    best = node;
                    pick(node.children);
                    break;
                }
            }
        };
        pick(result.root.children);
        const nextKey = best ? keyOf(best, false) : (result.root.children.length ? '__root__' : '');
        if (nextKey === currentKey) return;
        currentKey = nextKey;
        updateRowStates();
    }

    function setSelected(key) {
        selectedKey = key || '';
        updateRowStates();
    }

    // ---- 数据源切换（文件结构 / 会话结构） ----

    // 调用方按「内容区当前显示什么」传 {file, session}；返回生效的来源。
    function setSources(next) {
        const src = {file: !!(next && next.file), session: !!(next && next.session)};
        const changed = src.file !== sources.file || src.session !== sources.session;
        sources = src;
        if (changed) refresh();
        return effectiveSource();
    }

    // 用户在两者都存在时切换偏好；返回生效的来源（不可用时自动回落）。
    function setSource(pref) {
        const want = pref === 'session' ? 'session' : 'file';
        if (want !== sourcePref) {
            sourcePref = want;
            refresh();
        }
        return effectiveSource();
    }

    // 会话大纲快照：{sessionId, items: [{index, round, text, ts}], activeIndex}
    function setSessionOutline(snapshot) {
        const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : [];
        const sig = (snapshot && snapshot.sessionId ? snapshot.sessionId : '') + '|' +
            items.map((item) => (item.index + ':' + (Number(item.ts) || 0))).join(',');
        const active = snapshot && Number.isFinite(Number(snapshot.activeIndex)) ? Number(snapshot.activeIndex) : -1;
        const sameItems = !!outline && sig === outlineSig;
        outline = {sessionId: (snapshot && snapshot.sessionId) || '', items, activeIndex: active};
        outlineSig = sig;
        outlineActive = active;
        if (effectiveSource() !== 'session') return;
        // 只是滚动位置变了：不重建 DOM，避免拖动时闪
        if (sameItems) {
            syncSessionOutlineActive(body, outlineActive);
            return;
        }
        renderSession();
    }

    // structureText 把当前结构树渲染成文本。format：
    //   tree     —— 与「结构化目录」一致（├──/└──，首行文件名）
    //   indent   —— 两空格逐层缩进
    //   markdown —— Markdown 嵌套列表
    //   mermaid  —— Mermaid mindmap 语法
    // lineNums 为 true 时每个节点附 :L行号（根节点是文件本身，不带）。
    // 忽略折叠状态，导出全量。
    function structureText(format, lineNums) {
        // 会话结构没有可导出的文件树
        if (effectiveSource() !== 'file') return '';
        if (!result || !result.root) return '';
        const fmt = format || 'tree';
        const rootLabel = String(result.root.label || (doc && doc.name) || '结构');
        const suffix = (node) => (node.detail ? ' ' + node.detail : '') + (lineNums && node.line ? ' :L' + node.line : '');
        const lines = [];
        const walk = (children, prefix, depth) => {
            for (let i = 0; i < children.length; i++) {
                const node = children[i] || {};
                const last = i === children.length - 1;
                const label = String(node.label || '') + suffix(node);
                if (fmt === 'tree') {
                    lines.push(prefix + (last ? '└── ' : '├── ') + label);
                } else if (fmt === 'indent') {
                    lines.push('  '.repeat(depth + 1) + label);
                } else if (fmt === 'markdown') {
                    lines.push('  '.repeat(depth + 1) + '- ' + label);
                } else {
                    lines.push('  '.repeat(depth + 2) + mermaidSafe(label));
                }
                if (nodeHasChildren(node)) {
                    walk(node.children, fmt === 'tree' ? prefix + (last ? '    ' : '│   ') : prefix, depth + 1);
                }
            }
        };
        const kids = result.root.children || [];
        if (fmt === 'mermaid') {
            lines.push('mindmap');
            lines.push('  root((' + mermaidSafe(rootLabel) + '))');
            walk(kids, '', 0);
        } else {
            lines.push(fmt === 'markdown' ? '- ' + rootLabel : rootLabel);
            walk(kids, '', 0);
        }
        return lines.join('\n');
    }

    // mermaidSafe 把会触发 mindmap 形状语法的半角括号换成全角，避免节点文本破坏渲染
    function mermaidSafe(text) {
        return String(text)
            .replace(/\(/g, '（').replace(/\)/g, '）')
            .replace(/\[/g, '【').replace(/\]/g, '】')
            .replace(/\{/g, '｛').replace(/\}/g, '｝');
    }

    return {
        setDoc,
        setVisible,
        refresh,
        setCursor,
        setSelected,
        setSources,
        setSource,
        setSessionOutline,
        getSource: effectiveSource,
        getResult: () => result,
        getDocId: () => (doc ? doc.id : null),
        structureText,
    };
}

export {parseStructure, detectLanguage};
