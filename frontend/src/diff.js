// 行级 diff（Myers）与结构化语义 diff，零依赖。

export function diffLineOps(aLines, bLines) {
    const n = aLines.length;
    const m = bLines.length;
    if (!n && !m) return [];
    if (n + m > 20000) return coarseDiff(aLines, bLines);
    const max = n + m;
    const v = new Map();
    v.set(1, 0);
    const trace = [];
    for (let d = 0; d <= max; d++) {
        trace.push(new Map(v));
        for (let k = -d; k <= d; k += 2) {
            const left = v.has(k - 1) ? v.get(k - 1) : -Infinity;
            const right = v.has(k + 1) ? v.get(k + 1) : -Infinity;
            let x;
            if (k === -d || (k !== d && left < right)) x = right;
            else x = left + 1;
            let y = x - k;
            while (x < n && y < m && aLines[x] === bLines[y]) {
                x++;
                y++;
            }
            v.set(k, x);
            if (x >= n && y >= m) return backtrack(trace, aLines, bLines, d);
        }
    }
    return coarseDiff(aLines, bLines);
}

function backtrack(trace, aLines, bLines, steps) {
    const ops = [];
    let x = aLines.length;
    let y = bLines.length;
    for (let d = steps; d >= 0; d--) {
        const v = trace[d];
        const k = x - y;
        const left = v.has(k - 1) ? v.get(k - 1) : -Infinity;
        const right = v.has(k + 1) ? v.get(k + 1) : -Infinity;
        const prevK = k === -d || (k !== d && left < right) ? k + 1 : k - 1;
        const prevX = v.has(prevK) ? v.get(prevK) : 0;
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
            ops.push({type: 'equal', text: aLines[x - 1]});
            x--;
            y--;
        }
        if (d > 0) {
            if (x === prevX) {
                ops.push({type: 'add', text: bLines[y - 1]});
                y--;
            } else {
                ops.push({type: 'del', text: aLines[x - 1]});
                x--;
            }
        }
    }
    ops.reverse();
    return ops;
}

// 超大文件退化为「公共前缀/后缀 + 中间整段替换」，避免 Myers 在极端输入下耗时失控
function coarseDiff(aLines, bLines) {
    let prefix = 0;
    while (prefix < aLines.length && prefix < bLines.length && aLines[prefix] === bLines[prefix]) prefix++;
    let suffix = 0;
    while (suffix < aLines.length - prefix && suffix < bLines.length - prefix &&
        aLines[aLines.length - 1 - suffix] === bLines[bLines.length - 1 - suffix]) suffix++;
    const ops = [];
    for (let i = 0; i < prefix; i++) ops.push({type: 'equal', text: aLines[i]});
    for (let i = prefix; i < aLines.length - suffix; i++) ops.push({type: 'del', text: aLines[i]});
    for (let i = prefix; i < bLines.length - suffix; i++) ops.push({type: 'add', text: bLines[i]});
    for (let i = aLines.length - suffix; i < aLines.length; i++) ops.push({type: 'equal', text: aLines[i]});
    return ops;
}

export function splitDiffLines(text) {
    const normalized = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    if (!normalized) return [];
    return normalized.split('\n');
}

// unified diff 文本（带 @@ 头，上下文 3 行），供 <pre> 直接渲染
export function unifiedDiff(aText, bText, context = 3) {
    const a = splitDiffLines(aText);
    const b = splitDiffLines(bText);
    const ops = diffLineOps(a, b);
    const changes = [];
    for (let i = 0; i < ops.length; i++) {
        if (ops[i].type !== 'equal') changes.push(i);
    }
    if (!changes.length) return {text: '', ops, added: 0, removed: 0};
    const hunks = [];
    let start = Math.max(0, changes[0] - context);
    let last = changes[0];
    for (let i = 1; i < changes.length; i++) {
        if (changes[i] - last <= context * 2) {
            last = changes[i];
            continue;
        }
        hunks.push([start, Math.min(ops.length, last + context + 1)]);
        start = Math.max(0, changes[i] - context);
        last = changes[i];
    }
    hunks.push([start, Math.min(ops.length, last + context + 1)]);
    let oldLine = 1;
    let newLine = 1;
    let cursor = 0;
    const out = [];
    let added = 0;
    let removed = 0;
    for (const [hunkStart, hunkEnd] of hunks) {
        while (cursor < hunkStart) {
            if (ops[cursor].type !== 'add') oldLine++;
            if (ops[cursor].type !== 'del') newLine++;
            cursor++;
        }
        let oldCount = 0;
        let newCount = 0;
        for (let i = hunkStart; i < hunkEnd; i++) {
            if (ops[i].type !== 'add') oldCount++;
            if (ops[i].type !== 'del') newCount++;
        }
        out.push('@@ -' + oldLine + ',' + oldCount + ' +' + newLine + ',' + newCount + ' @@');
        for (let i = hunkStart; i < hunkEnd; i++) {
            const op = ops[i];
            if (op.type === 'add') {
                added++;
                out.push('+' + op.text);
                newLine++;
            } else if (op.type === 'del') {
                removed++;
                out.push('-' + op.text);
                oldLine++;
            } else {
                out.push(' ' + op.text);
                oldLine++;
                newLine++;
            }
        }
        cursor = hunkEnd;
    }
    return {text: out.join('\n'), ops, added, removed};
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pathKey(key) {
    return "['" + String(key).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "']";
}

function describeValue(value) {
    if (value === undefined) return '';
    try {
        const text = JSON.stringify(value);
        return text.length > 180 ? text.slice(0, 180) + '…' : text;
    } catch (e) {
        return String(value);
    }
}

export function semanticDiff(a, b) {
    const out = [];
    (function walk(left, right, path) {
        if (left === right) return;
        if (isPlainObject(left) && isPlainObject(right)) {
            const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
            for (const key of [...keys].sort()) {
                const hasLeft = Object.prototype.hasOwnProperty.call(left, key);
                const hasRight = Object.prototype.hasOwnProperty.call(right, key);
                const nextPath = path + pathKey(key);
                if (!hasRight) out.push({kind: 'remove', path: nextPath, before: left[key]});
                else if (!hasLeft) out.push({kind: 'add', path: nextPath, after: right[key]});
                else walk(left[key], right[key], nextPath);
            }
            return;
        }
        if (Array.isArray(left) && Array.isArray(right)) {
            const limit = Math.min(left.length, right.length);
            for (let i = 0; i < limit; i++) walk(left[i], right[i], path + '[' + i + ']');
            for (let i = limit; i < left.length; i++) out.push({kind: 'remove', path: path + '[' + i + ']', before: left[i]});
            for (let i = limit; i < right.length; i++) out.push({kind: 'add', path: path + '[' + i + ']', after: right[i]});
            return;
        }
        out.push({kind: 'change', path, before: left, after: right});
    })(a, b, '$');
    return out;
}

export function semanticEntryText(entry) {
    if (entry.kind === 'add') return describeValue(entry.after);
    if (entry.kind === 'remove') return describeValue(entry.before);
    return describeValue(entry.before) + ' → ' + describeValue(entry.after);
}
