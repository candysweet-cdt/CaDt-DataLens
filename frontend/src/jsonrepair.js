// jsonrepair.js：把常见"坏 JSON"修成可被 JSON.parse 的文本。
// 保守策略：只做确定性损伤的修复（注释、尾逗号、单引号、智能引号、
// 未加引号的键、NaN/Infinity、Python 风格字面量），不做启发式猜测。

function addFix(fixes, name) {
    if (!fixes.includes(name)) fixes.push(name);
}

// stripTrailingCommas 去掉对象/数组里 } 或 ] 前的逗号（输入已是无注释文本）。
function stripTrailingCommas(s, fixes) {
    let out = '';
    let inStr = false;
    let quote = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            out += ch;
            if (ch === '\\') {
                out += s[i + 1] || '';
                i++;
            } else if (ch === quote) {
                inStr = false;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            inStr = true;
            quote = ch;
            out += ch;
            continue;
        }
        if (ch === ',') {
            let j = i + 1;
            while (j < s.length && /\s/.test(s[j])) j++;
            const next = s[j];
            if (next === '}' || next === ']') {
                addFix(fixes, '尾逗号');
                continue; // 丢弃逗号
            }
        }
        out += ch;
    }
    return out;
}

export function repairJson(input) {
    const fixes = [];
    let s = String(input || '');

    // 预清理
    if (s.charCodeAt(0) === 0xFEFF) {
        s = s.slice(1);
        addFix(fixes, 'BOM 头');
    }
    if (/[\u200B\u200C\u200D\u2060]/.test(s)) {
        s = s.replace(/[\u200B\u200C\u200D\u2060]/g, '');
        addFix(fixes, '零宽字符');
    }
    if (/[\u201C\u201D\u2018\u2019]/.test(s)) {
        s = s.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
        addFix(fixes, '智能引号');
    }

    // 单遍扫描：字符串状态机 + 注释剥离 + 单引号转双引号 + 裸键/字面量
    const out = [];
    let i = 0;
    let inStr = false;
    let strQuote = '"';
    while (i < s.length) {
        const ch = s[i];
        if (inStr) {
            out.push(ch);
            if (ch === '\\' && strQuote === '"') {
                out.push(s[i + 1] || '');
                i += 2;
                continue;
            }
            if (strQuote === "'" && ch === "'" && s[i - 1] !== '\\') {
                out.pop();
                out.push('"');
                inStr = false;
                i++;
                continue;
            }
            if (strQuote === "'" && ch === '"') {
                out.push('\\"');
                i++;
                continue;
            }
            if (strQuote === '"' && ch === '"') {
                inStr = false;
            }
            i++;
            continue;
        }
        // 注释
        if (ch === '/' && s[i + 1] === '/') {
            while (i < s.length && s[i] !== '\n') i++;
            addFix(fixes, '行注释');
            continue;
        }
        if (ch === '/' && s[i + 1] === '*') {
            const end = s.indexOf('*/', i + 2);
            i = end === -1 ? s.length : end + 2;
            addFix(fixes, '块注释');
            continue;
        }
        // 单引号字符串
        if (ch === "'") {
            inStr = true;
            strQuote = "'";
            out.push('"');
            addFix(fixes, '单引号字符串');
            i++;
            continue;
        }
        // 双引号字符串原样保留
        if (ch === '"') {
            inStr = true;
            strQuote = '"';
            out.push(ch);
            i++;
            continue;
        }
        // -Infinity（负号在字面量扫描之外）
        if (ch === '-' && s.startsWith('Infinity', i + 1)) {
            out.push('null');
            addFix(fixes, 'NaN/Infinity');
            i += 1 + 'Infinity'.length;
            continue;
        }
        // 裸字面量：未加引号的键/值、NaN/Infinity、Python 风格字面量
        if (/[A-Za-z_$]/.test(ch)) {
            let j = i;
            while (j < s.length && /[A-Za-z0-9_$]/.test(s[j])) j++;
            const word = s.slice(i, j);
            let k = j;
            while (k < s.length && /\s/.test(s[k])) k++;
            if (s[k] === ':') {
                out.push('"' + word + '"');
                addFix(fixes, '未加引号的键');
            } else if (word === 'NaN' || word === 'Infinity') {
                out.push('null');
                addFix(fixes, 'NaN/Infinity');
            } else if (word === 'undefined' || word === 'None') {
                out.push('null');
                addFix(fixes, word === 'None' ? 'Python 字面量' : 'undefined');
            } else if (word === 'True' || word === 'False') {
                out.push(word.toLowerCase());
                addFix(fixes, 'Python 字面量');
            } else if (word === 'true' || word === 'false' || word === 'null') {
                out.push(word); // 合法 JSON 字面量原样保留
            } else {
                out.push('"' + word + '"');
                addFix(fixes, '未加引号的值');
            }
            i = j;
            continue;
        }
        out.push(ch);
        i++;
    }

    let text = out.join('');
    text = stripTrailingCommas(text, fixes);

    // 验证
    try {
        JSON.parse(text);
    } catch (e) {
        return {ok: false, error: e.message, text, fixes};
    }
    return {ok: true, text, fixes};
}
