// 零依赖 JSONPath 子集：$ . [] * .. 过滤/切片/联合，以及 JSON 源码路径→行列映射。

export function jsonPathKey(key) {
    return "['" + String(key).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "']";
}

function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function unquote(text) {
    const body = text.slice(1, -1);
    let out = '';
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch !== '\\') {
            out += ch;
            continue;
        }
        const next = body[++i];
        switch (next) {
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'u': {
            const hex = body.slice(i + 1, i + 5);
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
                out += String.fromCharCode(parseInt(hex, 16));
                i += 4;
            }
            break;
        }
        default: out += next == null ? '' : next;
        }
    }
    return out;
}

function splitTopLevel(text) {
    const parts = [];
    let start = 0;
    let depth = 0;
    let quote = null;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            continue;
        }
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
        else if (ch === ',' && depth === 0) {
            parts.push(text.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(text.slice(start));
    return parts;
}

function parseSlice(text) {
    const segs = text.split(':');
    if (segs.length < 2 || segs.length > 3) throw new Error('切片格式无效：' + text);
    const nums = segs.map((seg) => {
        const trimmed = seg.trim();
        if (!trimmed) return null;
        if (!/^-?\d+$/.test(trimmed)) throw new Error('切片必须是整数：' + text);
        return Number(trimmed);
    });
    return {start: nums[0], end: nums[1], step: nums[2] == null ? 1 : nums[2]};
}

function parseBracketStep(content) {
    const text = content.trim();
    if (text === '*') return {type: 'wildcard'};
    if (text.startsWith('?(') && text.endsWith(')')) {
        return {type: 'filter', predicate: new FilterParser(text.slice(2, -1)).parse()};
    }
    const parts = splitTopLevel(text);
    if (parts.length > 1) {
        return {
            type: 'union',
            items: parts.map((part) => parseBracketStep(part)),
        };
    }
    if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
        return {type: 'key', key: unquote(text)};
    }
    if (/^-?\d+$/.test(text)) return {type: 'index', index: Number(text)};
    if (text.includes(':')) return {type: 'slice', ...parseSlice(text)};
    throw new Error('无法解析方括号内容：[' + text + ']');
}

function readBracketContent(text, start) {
    let depth = 0;
    let quote = null;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            continue;
        }
        if (ch === '[') depth++;
        else if (ch === ']') {
            depth--;
            if (depth === 0) return {content: text.slice(start + 1, i), end: i + 1};
        }
    }
    throw new Error('方括号未闭合');
}

function readPathName(text, start) {
    let i = start;
    while (i < text.length && !'.[] \t\r\n'.includes(text[i])) i++;
    return {name: text.slice(start, i), end: i};
}

export function parseJsonPath(expr) {
    const text = String(expr || '').trim();
    if (!text) throw new Error('请输入 JSONPath');
    const steps = [];
    let i = 0;
    if (text[i] === '$') i++;
    while (i < text.length) {
        if (text.startsWith('..', i)) {
            i += 2;
            if (text[i] === '*') {
                steps.push({type: 'recursive'});
                i++;
            } else if (text[i] === '[') {
                const bracket = readBracketContent(text, i);
                steps.push({type: 'recursive'});
                steps.push(parseBracketStep(bracket.content));
                i = bracket.end;
            } else {
                const part = readPathName(text, i);
                if (!part.name) throw new Error('.. 后缺少名称');
                steps.push({type: 'recursiveKey', key: part.name});
                i = part.end;
            }
            continue;
        }
        if (text[i] === '.') {
            i++;
            if (text[i] === '*') {
                steps.push({type: 'wildcard'});
                i++;
            } else {
                const part = readPathName(text, i);
                if (!part.name) throw new Error('. 后缺少名称');
                steps.push({type: 'key', key: part.name});
                i = part.end;
            }
            continue;
        }
        if (text[i] === '[') {
            const bracket = readBracketContent(text, i);
            steps.push(parseBracketStep(bracket.content));
            i = bracket.end;
            continue;
        }
        const part = readPathName(text, i);
        if (!part.name) throw new Error('无法解析：' + text.slice(i));
        steps.push({type: 'key', key: part.name});
        i = part.end;
    }
    if (!steps.length) throw new Error('JSONPath 缺少路径段');
    return steps;
}

function pushUnique(out, seen, node) {
    if (seen.has(node.path)) return;
    seen.add(node.path);
    out.push(node);
}

function applyStep(node, step, out, seen) {
    const value = node.value;
    switch (step.type) {
    case 'key':
        if (isObject(value) && hasOwn(value, step.key)) {
            pushUnique(out, seen, {path: node.path + jsonPathKey(step.key), value: value[step.key]});
        } else if (Array.isArray(value) && /^-?\d+$/.test(step.key)) {
            applyStep(node, {type: 'index', index: Number(step.key)}, out, seen);
        }
        break;
    case 'wildcard':
        if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i++) {
                pushUnique(out, seen, {path: node.path + '[' + i + ']', value: value[i]});
            }
        } else if (isObject(value)) {
            for (const key of Object.keys(value)) {
                pushUnique(out, seen, {path: node.path + jsonPathKey(key), value: value[key]});
            }
        }
        break;
    case 'index':
        if (Array.isArray(value)) {
            const index = step.index < 0 ? value.length + step.index : step.index;
            if (index >= 0 && index < value.length) {
                pushUnique(out, seen, {path: node.path + '[' + index + ']', value: value[index]});
            }
        } else if (isObject(value) && hasOwn(value, String(step.index))) {
            pushUnique(out, seen, {path: node.path + jsonPathKey(step.index), value: value[String(step.index)]});
        }
        break;
    case 'slice':
        if (Array.isArray(value)) {
            const stepValue = step.step || 1;
            const len = value.length;
            let start = step.start == null ? (stepValue > 0 ? 0 : len - 1) : step.start;
            let end = step.end == null ? (stepValue > 0 ? len : -1) : step.end;
            if (start < 0) start += len;
            if (end < 0 && step.end != null) end += len;
            if (stepValue > 0) {
                start = Math.max(0, start);
                end = Math.min(len, end);
                for (let i = start; i < end; i += stepValue) {
                    pushUnique(out, seen, {path: node.path + '[' + i + ']', value: value[i]});
                }
            } else {
                start = Math.min(len - 1, start);
                end = Math.max(-1, end);
                for (let i = start; i > end; i += stepValue) {
                    pushUnique(out, seen, {path: node.path + '[' + i + ']', value: value[i]});
                }
            }
        }
        break;
    case 'filter':
        if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i++) {
                if (step.predicate(value[i])) {
                    pushUnique(out, seen, {path: node.path + '[' + i + ']', value: value[i]});
                }
            }
        } else if (isObject(value)) {
            for (const key of Object.keys(value)) {
                if (step.predicate(value[key])) {
                    pushUnique(out, seen, {path: node.path + jsonPathKey(key), value: value[key]});
                }
            }
        }
        break;
    case 'union':
        for (const item of step.items) applyStep(node, item, out, seen);
        break;
    case 'recursiveKey':
        (function walk(currentPath, currentValue) {
            if (isObject(currentValue) && hasOwn(currentValue, step.key)) {
                pushUnique(out, seen, {path: currentPath + jsonPathKey(step.key), value: currentValue[step.key]});
            }
            if (Array.isArray(currentValue)) {
                for (let i = 0; i < currentValue.length; i++) walk(currentPath + '[' + i + ']', currentValue[i]);
            } else if (isObject(currentValue)) {
                for (const key of Object.keys(currentValue)) walk(currentPath + jsonPathKey(key), currentValue[key]);
            }
        })(node.path, value);
        break;
    case 'recursive':
        (function walk(currentPath, currentValue) {
            if (Array.isArray(currentValue)) {
                for (let i = 0; i < currentValue.length; i++) {
                    const childPath = currentPath + '[' + i + ']';
                    pushUnique(out, seen, {path: childPath, value: currentValue[i]});
                    walk(childPath, currentValue[i]);
                }
            } else if (isObject(currentValue)) {
                for (const key of Object.keys(currentValue)) {
                    const childPath = currentPath + jsonPathKey(key);
                    pushUnique(out, seen, {path: childPath, value: currentValue[key]});
                    walk(childPath, currentValue[key]);
                }
            }
        })(node.path, value);
        break;
    default:
        break;
    }
}

export function queryJsonPath(root, expr) {
    const text = String(expr || '').trim();
    if (text === '$') return [{path: '$', value: root}];
    let nodes = [{path: '$', value: root}];
    for (const step of parseJsonPath(text)) {
        const next = [];
        const seen = new Set();
        for (const node of nodes) applyStep(node, step, next, seen);
        nodes = next;
        if (!nodes.length) break;
    }
    return nodes;
}

// ---- 过滤表达式 ----

class FilterParser {
    constructor(text) {
        this.text = String(text || '');
        this.i = 0;
    }

    skip() {
        while (this.i < this.text.length && /\s/.test(this.text[this.i])) this.i++;
    }

    peek() {
        return this.text[this.i];
    }

    match(token) {
        if (this.text.startsWith(token, this.i)) {
            this.i += token.length;
            return true;
        }
        return false;
    }

    expect(token) {
        if (!this.match(token)) throw new Error('过滤表达式缺少 ' + token);
    }

    parse() {
        const fn = this.parseOr();
        this.skip();
        if (this.i < this.text.length) throw new Error('过滤表达式无法解析：' + this.text.slice(this.i));
        return fn;
    }

    parseOr() {
        let left = this.parseAnd();
        for (;;) {
            this.skip();
            if (!this.match('||')) break;
            const right = this.parseAnd();
            const prev = left;
            left = (value) => prev(value) || right(value);
        }
        return left;
    }

    parseAnd() {
        let left = this.parseNot();
        for (;;) {
            this.skip();
            if (!this.match('&&')) break;
            const right = this.parseNot();
            const prev = left;
            left = (value) => prev(value) && right(value);
        }
        return left;
    }

    parseNot() {
        this.skip();
        if (this.match('!')) {
            const inner = this.parseNot();
            return (value) => !inner(value);
        }
        if (this.match('(')) {
            const inner = this.parseOr();
            this.skip();
            this.expect(')');
            return inner;
        }
        return this.parseComparison();
    }

    parseComparison() {
        const left = this.parseOperand();
        this.skip();
        let op = null;
        for (const candidate of ['==', '!=', '>=', '<=', '=~', '>', '<']) {
            if (this.match(candidate)) {
                op = candidate;
                break;
            }
        }
        if (!op) return (value) => left(value).exists;
        const right = this.parseOperand();
        if (op === '=~') {
            return (value) => {
                const a = left(value);
                const b = right(value);
                return a.exists && b.value instanceof RegExp && b.value.test(String(a.value));
            };
        }
        return (value) => {
            const a = left(value);
            const b = right(value);
            if (!a.exists || !b.exists) return false;
            switch (op) {
            case '==': return a.value == b.value; // eslint-disable-line eqeqeq
            case '!=': return a.value != b.value; // eslint-disable-line eqeqeq
            case '>': return a.value > b.value;
            case '>=': return a.value >= b.value;
            case '<': return a.value < b.value;
            case '<=': return a.value <= b.value;
            default: return false;
            }
        };
    }

    parseOperand() {
        this.skip();
        if (this.match('@')) {
            const segments = this.readSegments();
            return (value) => {
                let current = value;
                let exists = true;
                for (const segment of segments) {
                    if (current == null) {
                        exists = false;
                        break;
                    }
                    if (segment.type === 'key') {
                        if (isObject(current) && hasOwn(current, segment.key)) current = current[segment.key];
                        else {
                            exists = false;
                            break;
                        }
                    } else {
                        if (!Array.isArray(current)) {
                            exists = false;
                            break;
                        }
                        const index = segment.index < 0 ? current.length + segment.index : segment.index;
                        if (index < 0 || index >= current.length) {
                            exists = false;
                            break;
                        }
                        current = current[index];
                    }
                }
                return {value: current, exists};
            };
        }
        if (this.match('(')) {
            const inner = this.parseOr();
            this.skip();
            this.expect(')');
            return (value) => ({value: inner(value), exists: true});
        }
        const ch = this.peek();
        if (ch === "'" || ch === '"') {
            const value = this.readString();
            return () => ({value, exists: true});
        }
        if (ch === '/') {
            const regex = this.readRegex();
            return () => ({value: regex, exists: true});
        }
        const number = this.readNumber();
        if (number != null) return () => ({value: number, exists: true});
        const ident = this.readIdent();
        if (ident === 'true') return () => ({value: true, exists: true});
        if (ident === 'false') return () => ({value: false, exists: true});
        if (ident === 'null') return () => ({value: null, exists: true});
        throw new Error('无法解析过滤操作数：' + this.text.slice(this.i));
    }

    readSegments() {
        const segments = [];
        for (;;) {
            this.skip();
            if (this.match('.')) {
                let name = '';
                while (this.i < this.text.length && /[A-Za-z0-9_$@-]/.test(this.text[this.i])) {
                    name += this.text[this.i++];
                }
                if (!name) throw new Error('过滤路径缺少字段名');
                segments.push({type: 'key', key: name});
                continue;
            }
            if (this.peek() === '[') {
                const bracket = readBracketContent(this.text, this.i);
                const text = bracket.content.trim();
                if (/^-?\d+$/.test(text)) {
                    segments.push({type: 'index', index: Number(text)});
                } else if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
                    segments.push({type: 'key', key: unquote(text)});
                } else {
                    throw new Error('过滤路径只支持数字下标或引号键名');
                }
                this.i = bracket.end;
                continue;
            }
            break;
        }
        return segments;
    }

    readString() {
        const quote = this.text[this.i];
        let end = this.i + 1;
        for (; end < this.text.length; end++) {
            if (this.text[end] === '\\') end++;
            else if (this.text[end] === quote) break;
        }
        if (end >= this.text.length) throw new Error('字符串未闭合');
        const raw = this.text.slice(this.i, end + 1);
        this.i = end + 1;
        return unquote(raw);
    }

    readRegex() {
        let end = this.i + 1;
        for (; end < this.text.length; end++) {
            if (this.text[end] === '\\') end++;
            else if (this.text[end] === '/') break;
        }
        if (end >= this.text.length) throw new Error('正则未闭合');
        const body = this.text.slice(this.i + 1, end);
        let flags = '';
        end++;
        while (end < this.text.length && /[gimsuy]/.test(this.text[end])) flags += this.text[end++];
        this.i = end;
        return new RegExp(body, flags.replace(/g/g, ''));
    }

    readNumber() {
        const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.i));
        if (!match) return null;
        this.i += match[0].length;
        return Number(match[0]);
    }

    readIdent() {
        let end = this.i;
        while (end < this.text.length && /[A-Za-z]/.test(this.text[end])) end++;
        const word = this.text.slice(this.i, end);
        this.i = end;
        return word;
    }
}

// ---- JSON 源码路径→行列映射（1 基） ----

function lineColAt(starts, index) {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (starts[mid] <= index) low = mid;
        else high = mid - 1;
    }
    return {line: low + 1, column: index - starts[low] + 1};
}

function jsonStringAt(sc) {
    const quote = sc.text[sc.i];
    let i = sc.i + 1;
    for (; i < sc.text.length; i++) {
        if (sc.text[i] === '\\') i++;
        else if (sc.text[i] === quote) break;
    }
    if (i >= sc.text.length) throw new Error('字符串未闭合');
    const raw = sc.text.slice(sc.i, i + 1);
    sc.i = i + 1;
    return unquote(raw);
}

function skipJsonSpace(sc) {
    while (sc.i < sc.text.length && /\s/.test(sc.text[sc.i])) sc.i++;
}

function parseJsonValue(sc, path, starts, map) {
    skipJsonSpace(sc);
    map.set(path, lineColAt(starts, sc.i));
    const ch = sc.text[sc.i];
    if (ch === '{') {
        sc.i++;
        skipJsonSpace(sc);
        if (sc.text[sc.i] === '}') {
            sc.i++;
            return;
        }
        for (;;) {
            skipJsonSpace(sc);
            if (sc.text[sc.i] !== '"') throw new Error('对象键必须是字符串');
            const key = jsonStringAt(sc);
            skipJsonSpace(sc);
            if (sc.text[sc.i] !== ':') throw new Error('缺少冒号');
            sc.i++;
            parseJsonValue(sc, path + jsonPathKey(key), starts, map);
            skipJsonSpace(sc);
            if (sc.text[sc.i] === ',') {
                sc.i++;
                continue;
            }
            if (sc.text[sc.i] === '}') {
                sc.i++;
                return;
            }
            throw new Error('对象未正确结束');
        }
    }
    if (ch === '[') {
        sc.i++;
        skipJsonSpace(sc);
        if (sc.text[sc.i] === ']') {
            sc.i++;
            return;
        }
        let index = 0;
        for (;;) {
            parseJsonValue(sc, path + '[' + index + ']', starts, map);
            index++;
            skipJsonSpace(sc);
            if (sc.text[sc.i] === ',') {
                sc.i++;
                continue;
            }
            if (sc.text[sc.i] === ']') {
                sc.i++;
                return;
            }
            throw new Error('数组未正确结束');
        }
    }
    if (ch === '"') {
        jsonStringAt(sc);
        return;
    }
    const start = sc.i;
    while (sc.i < sc.text.length && !',]} \t\r\n'.includes(sc.text[sc.i])) sc.i++;
    if (sc.i === start) throw new Error('缺少值');
}

export function buildJsonLineMap(text) {
    const source = String(text == null ? '' : text);
    const map = new Map();
    try {
        const starts = [0];
        for (let i = 0; i < source.length; i++) {
            if (source[i] === '\n') starts.push(i + 1);
        }
        const sc = {text: source, i: 0};
        parseJsonValue(sc, '$', starts, map);
        skipJsonSpace(sc);
        if (sc.i < source.length) throw new Error('JSON 末尾有多余内容');
    } catch (e) {
        return new Map();
    }
    return map;
}
