#!/usr/bin/env node
// gen-backend-types.mjs：从 Go 源码 + 绑定基线生成前端 Wails 绑定类型（frontend/src/types/backend.d.ts）。
//
// 为什么要生成而不是手写：
//   v3 的绑定面就是 *App 的方法集（wails v3 pkg/application/bindings.go:236），前端经
//   Call.ByName 动态解析（frontend/src/core/wails-runtime.js 的 createBackendProxy），
//   既没有生成绑定目录，也没有任何类型。手写一份 420 方法的 d.ts 必然漂移，所以做成可重跑脚本。
//
// 两个输入，各管一半：
//   ① 名单 —— testdata/app_bindings_baseline.txt（*App 方法名基线，由
//      app_bindings_guard_test.go 生成与校验，`UPDATE_BINDINGS_BASELINE=1 go test -run
//      TestAppBindingBaseline .` 重算）。它是方法集的单一真源，比扫 Go 猜嵌入关系可靠。
//   ② 签名 —— 扫 Go 源码里所有导出方法声明，按方法名与基线对账。绑定承载类型已经服务化
//      （internal/<域>/service.go 及其它嵌入类型如 *Chat / *GroupStore / *Bridge），逐个解析
//      匿名嵌入链既脆又跟着重构走，所以这里不解析嵌入，直接用名字匹配；同名不同签名记为
//      歧义并回退 unknown。
//
// 映射口径：
//   - ctx context.Context 不出现（v3 由 Go 侧注入）；接收者是 *X / 值接收者都不影响。
//   - 返回值的末位 error 不出现（reject），其余按数量映射为 Promise<T> / Promise<[A, B]>。
//   - Go 基础类型 → string/number/boolean；切片 → T[]；map → Record；
//     无歧义且字段全为基础类型的具名结构体（见 STRUCT_INTERFACES）→ 生成 interface；
//     其余具名结构体暂记 unknown 并在该行上方留 @go 注释（含嵌套子类型或同名多版本的，
//     做全套解析器的复杂度远超收益——调用点都在未开 checkJs 的 .js 里，unknown 不误报）。
//
// 用法：
//   node scripts/gen-backend-types.mjs                     # 写 frontend/src/types/backend.d.ts
//   node scripts/gen-backend-types.mjs --out .cadt/tmp/x.d.ts   # 写到别处审阅
//   node scripts/gen-backend-types.mjs --check             # 只比对，不写（diff 非空则退出码 1）

import {readFileSync, readdirSync, writeFileSync, mkdirSync} from 'node:fs';
import {join, relative, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = 'testdata/app_bindings_baseline.txt';
const DEFAULT_OUT = 'frontend/src/types/backend.d.ts';

// Go 基础类型 → TS。具名类型（含结构体、别名）不在此表内，走 unknown + @go 注释。
const SCALARS = new Map([
    ['string', 'string'],
    ['bool', 'boolean'],
    ['byte', 'number'], ['rune', 'number'],
    ['int', 'number'], ['int8', 'number'], ['int16', 'number'], ['int32', 'number'], ['int64', 'number'],
    ['uint', 'number'], ['uint8', 'number'], ['uint16', 'number'], ['uint32', 'number'], ['uint64', 'number'],
    ['uintptr', 'number'],
    ['float32', 'number'], ['float64', 'number'],
    ['any', 'unknown'], ['interface{}', 'unknown'], ['error', 'unknown'],
]);

// 具名结构体 → TS interface 的字段表（手工维护，从 Go struct 的 json tag 抄）。
// 只收「字段全是基础类型/基础切片」的无歧义结构体：有嵌套具名类型（SearchResult/PatchPreview）
// 或同名多版本（LeaseStatus 在 memo/sessionstore 各一版）的保持 unknown——做全套解析器的
// 复杂度远超收益，且调用点都在未开 checkJs 的 .js 里，unknown 目前不产生任何误报。
// 改了对应 Go struct 的 json tag 就必须同步这里并重跑生成器。
const STRUCT_INTERFACES = {
    GitOperationResult: [
        ['success', 'boolean'], ['output', 'string'], ['branch?', 'string'], ['path?', 'string'],
        ['conflictFiles?', 'string[]'],
    ],
    PluginInfo: [
        ['id', 'string'], ['name', 'string'], ['version?', 'string'], ['author', 'string'],
        ['description?', 'string'], ['dir', 'string'], ['entry?', 'string'], ['extensions?', 'string[]'],
        ['homepage?', 'string'], ['repository?', 'string'], ['license?', 'string'], ['keywords?', 'string[]'],
        ['minAppVersion?', 'string'], ['iconData?', 'string'], ['enabled', 'boolean'], ['entryOk', 'boolean'],
    ],
    AISchedule: [
        ['id', 'string'], ['name', 'string'], ['kind', 'string'], ['at?', 'string'],
        ['intervalMinutes?', 'number'], ['cron?', 'string'], ['prompt', 'string'], ['sessionId', 'string'],
        ['scope', 'string'], ['enabled', 'boolean'], ['createdAt', 'number'], ['lastRunAt', 'number'],
        ['nextRunAt', 'number'], ['runCount', 'number'], ['maxRuns', 'number'], ['lastResult', 'string'],
    ],
};

// 只在仓库根生效的跳过表：interior 目录一律要扫（internal/plugins 里就有绑定方法，
// 不要把「根目录的 plugins/ 样例」和「internal/plugins 包」混为一谈）。
const SKIP_ROOT_DIRS = new Set(['.git', '.cadt', 'node_modules', 'dist', 'build', 'docs', 'frontend', 'plugins', '.worktree', 'tools', 'scripts']);

// goFiles 收集仓库根的 *.go 与 internal/**/*.go（不含测试文件）：绑定承载类型只可能在这两处。
function goFiles(dir, out = []) {
    for (const ent of readdirSync(dir, {withFileTypes: true})) {
        if (ent.isDirectory()) {
            if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
            // 只有根与 internal/ 树需要扫；其它顶层目录（tools/scripts 等）不含绑定承载类型。
            if (dir === ROOT && (SKIP_ROOT_DIRS.has(ent.name) || ent.name !== 'internal')) continue;
            goFiles(join(dir, ent.name), out);
            continue;
        }
        if (!ent.name.endsWith('.go') || ent.name.endsWith('_test.go')) continue;
        out.push(join(dir, ent.name));
    }
    return out;
}

// matchParen 从 s[i]（必须是 '('）出发找配对 ')' 的下标，找不到返回 -1。
// 用深度扫描而不是正则，避开「参数里的 func(...) 与返回值里的括号被贪心正则吃掉」。
function matchParen(s, i) {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')') {
            depth--;
            if (depth === 0) return j;
        }
    }
    return -1;
}

// matchBracket 从 s[i]（必须是 '['）出发找配对 ']' 的下标，找不到返回 -1。
// 与 matchParen 同理用深度扫描：map[string][]int 的 key 右括号不是 lastIndexOf(']')。
function matchBracket(s, i) {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
        if (s[j] === '[') depth++;
        else if (s[j] === ']') {
            depth--;
            if (depth === 0) return j;
        }
    }
    return -1;
}

// stripBody 切掉返回值后面的函数体（含单行 `{ return X }` 与跨行 `{`）。
// `interface{}` / `map[string]interface{}` 里的花括号不算函数体，按前一个词判定。
// 前导字符要含 `]`：map[string]interface{} 里 interface 前是 ']'，不是空白/括号/逗号。
function stripBody(s) {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
        else if (ch === '{' && depth === 0) {
            if (/(^|[\s(\[, \]])interface$/.test(s.slice(0, i))) continue;
            return s.slice(0, i);
        }
    }
    return s;
}

// parseDecl 解析一条完整的方法声明，返回 {name, params, rets} 或 null。
// 接收者允许匿名：`func (*Store) X()` 与 `func (s *Store) X()` 都合法（前者常见于纯转发壳）。
function parseDecl(sig) {
    const recvOpen = sig.indexOf('(');
    if (recvOpen < 0) return null;
    const recvClose = matchParen(sig, recvOpen);
    if (recvClose < 0) return null;
    const recvSrc = sig.slice(recvOpen + 1, recvClose);
    const recvM = /(\*?)([A-Za-z0-9_]+)\s*$/.exec(recvSrc);
    const recv = recvM ? recvM[2] : '';
    const nameM = /^\s*([A-Z][A-Za-z0-9_]*)\s*\(/.exec(sig.slice(recvClose + 1));
    if (!nameM) return null;
    const paramsOpen = recvClose + 1 + nameM[0].length - 1;
    const paramsClose = matchParen(sig, paramsOpen);
    if (paramsClose < 0) return null;
    const paramsSrc = sig.slice(paramsOpen + 1, paramsClose);

    let rest = stripBody(sig.slice(paramsClose + 1)).trim();
    let retsSrc = rest;
    if (rest.startsWith('(')) {
        const close = matchParen(rest, 0);
        retsSrc = close > 0 ? rest.slice(1, close) : '';
    }
    const rets = retsSrc ? splitTopLevel(retsSrc).map((r) => r.trim()).filter(Boolean) : [];
    return {name: nameM[1], params: parseParams(paramsSrc), rets, recv};
}
// parenDelta 统计一行里圆括号的净深度，用于把跨行声明的签名拼回来（Go 允许参数换行）。
function parenDelta(line) {
    let d = 0;
    for (const ch of line) {
        if (ch === '(') d++;
        else if (ch === ')') d--;
    }
    return d;
}

// splitTopLevel 按 depth 0 的逗号切分参数/返回值，跳过 func(...)、map[...] 内部的逗号。
function splitTopLevel(s) {
    const parts = [];
    let buf = '';
    let depth = 0;
    for (const ch of s) {
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        if (ch === ',' && depth === 0) {
            parts.push(buf);
            buf = '';
            continue;
        }
        buf += ch;
    }
    if (buf.trim()) parts.push(buf);
    return parts.map((p) => p.trim()).filter(Boolean);
}

// parseParams 把 "a, b string, c []int, d ...interface{}" 展开为 [{name, goType, variadic}]。
function parseParams(src) {
    const out = [];
    for (const group of splitTopLevel(src)) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/.exec(group);
        if (m) {
            // "a, b string" 形态已在 splitTopLevel 里拆成两段，后一段才带类型；前一段没类型，
            // 由调用方回填（见下方回填逻辑）。
            out.push({name: m[1], goType: m[2].trim(), variadic: m[2].startsWith('...')});
            continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(group)) {
            out.push({name: group, goType: null, variadic: false});
            continue;
        }
        out.push({name: null, goType: group, variadic: group.startsWith('...')});
    }
    // "a, b string" → 无类型段继承下一段的类型
    for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].goType === null && out[i + 1]?.goType) {
            out[i].goType = out[i + 1].goType;
            out[i].variadic = out[i + 1].variadic;
        }
    }
    return out.filter((p) => p.goType);
}

// goTypeToTs 把 Go 类型写法转成 TS，同时返回是否出现了解析不了的具名类型。
function goTypeToTs(goType, named) {
    let t = goType.trim();
    if (t.startsWith('...')) t = t.slice(3);

    // ctx context.Context 参数由调用方先剔除；这里只兜返回值里意外出现的写法。
    if (t === 'context.Context') return 'unknown';

    const ptr = t.startsWith('*');
    if (ptr) t = t.slice(1);

    let ts;
    if (SCALARS.has(t)) {
        ts = SCALARS.get(t);
    } else if (t.startsWith('[]')) {
        const elem = goTypeToTs(t.slice(2), named);
        // 元素类型带 | 联合（如 []*Struct → 'Struct | null'）时必须加括号，
        // 否则 'Struct | null[]' 会被 TS 读成 'Struct | (null[])'，语义错位。
        ts = elem.includes('|') ? `(${elem})[]` : `${elem}[]`;
    } else if (t.startsWith('map[')) {
        // 用配对扫描找 key 的 ']'：lastIndexOf(']') 会把 map[string][]int 的值切片括号误当 key 结束，
        // 得到 inner="string][" / val="int"，错生成 Record<string, number> 而非 Record<string, number[]。
        const keyClose = matchBracket(t, 3);
        if (keyClose < 0) {
            ts = 'unknown';
        } else {
            const inner = t.slice(4, keyClose);
            const val = t.slice(keyClose + 1);
            const key = SCALARS.get(inner.trim()) === 'number' ? 'number' : 'string';
            ts = `Record<${key}, ${goTypeToTs(val, named)}>`;
        }
    } else if (Object.prototype.hasOwnProperty.call(STRUCT_INTERFACES, t.split('.').pop())) {
        // 已登记的无歧义结构体：用真 interface 名，不再记 unknown。
        // 取末段匹配——Go 签名里常带包名（*plugins.PluginInfo → t="plugins.PluginInfo"）。
        ts = t.split('.').pop();
    } else if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(t)) {
        // 具名类型（结构体 / 别名 / 其它包的导出类型）：暂记 unknown，登记待补
        named.add(t.split('.').pop());
        ts = 'unknown';
    } else {
        ts = 'unknown';
    }
    return ptr && ts !== 'unknown' && !ts.endsWith('null') ? `${ts} | null` : ts;
}

// collectMethods 扫 Go 源码，返回 name → [{params, rets, receiver, file}]
function collectMethods() {
    const byName = new Map();
    for (const file of goFiles(ROOT)) {
        const lines = readFileSync(file, 'utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.startsWith('func (')) continue;
            // 拼回跨行签名
            let sig = line;
            let depth = parenDelta(line);
            let j = i;
            while (depth > 0 && j + 1 < lines.length) {
                j++;
                sig += ` ${lines[j].trim()}`;
                depth += parenDelta(lines[j]);
            }
            const parsed = parseDecl(sig);
            if (!parsed) continue;
            const {name, params, rets, recv} = parsed;
            const entry = {params, rets, recv, file: relative(ROOT, file).replace(/\\/g, '/')};
            const key = JSON.stringify([entry.params, entry.rets]);
            const list = byName.get(name) ?? [];
            if (!list.some((x) => JSON.stringify([x.params, x.rets]) === key)) list.push(entry);
            byName.set(name, list);
        }
    }
    return byName;
}

// pickDecl 在多条同名声明里挑出真正进 *App 方法集的那条：
//   ① 接收者是 App 本体；② 平台成对文件取 _windows.go（本项目只发 Windows）；③ 唯一一条。
// 都挑不出来才算真歧义（同名方法挂在两个不相干类型上）。
function pickDecl(decls) {
    if (decls.length === 1) return decls[0];
    const app = decls.filter((d) => d.recv === 'App');
    if (app.length === 1) return app[0];
    const win = decls.filter((d) => d.file.endsWith('_windows.go'));
    if (win.length === 1) return win[0];
    return null;
}

function tsParamName(p, idx) {
    const base = p.name && p.name !== '_' ? p.name : `arg${idx + 1}`;
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(base) ? base : `arg${idx + 1}`;
}

// renderMethod 把一个 Go 方法声明渲染成 TS 接口成员行（含必要的 @go 注释）。
function renderMethod(name, entry) {
    const named = new Set();
    const parts = [];
    entry.params.forEach((p, i) => {
        const t = p.goType.trim();
        if (t === 'context.Context') return; // Wails 注入，不走 JS
        const ts = goTypeToTs(t, named);
        parts.push(p.variadic ? `...${tsParamName(p, i)}: ${ts}[]` : `${tsParamName(p, i)}: ${ts}`);
    });

    let nonError = entry.rets.filter((r) => r.trim() !== 'error');
    let ret;
    if (nonError.length === 0) {
        ret = 'void';
    } else if (nonError.length === 1) {
        ret = goTypeToTs(nonError[0], named);
    } else {
        ret = `[${nonError.map((r) => goTypeToTs(r, named)).join(', ')}]`;
    }
    // 多返回值是 Wails 打包的数组；单返回值 nil 指针在 JSON 里是 null（goTypeToTs 已带）。
    const tsRet = ret === 'void' ? 'Promise<void>' : `Promise<${ret}>`;
    const line = `    ${name}(${parts.join(', ')}): ${tsRet};`;

    // 只有回退到 unknown 的地方留 @go 注释，避免 420 行全都是注释噪音。
    if (ret.includes('unknown') || parts.some((p) => p.includes('unknown'))) {
        const goSig = `(${entry.params.map((p) => `${p.name ?? '_'} ${p.goType}`).join(', ')}) → (${entry.rets.join(', ')})`;
        const todo = named.size ? ` // 待补: ${[...named].join(', ')}` : '';
        return `    /** @go ${name}${goSig}${todo} */\n${line}`;
    }
    return line;
}

function main() {
    const args = process.argv.slice(2);
    const outIdx = args.indexOf('--out');
    const outPath = outIdx >= 0 ? args[outIdx + 1] : DEFAULT_OUT;
    const check = args.includes('--check');

    const names = readFileSync(join(ROOT, BASELINE), 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));

    const byName = collectMethods();
    const stats = {typed: 0, fallback: 0, ambiguous: 0, missing: 0};
    const missing = [];
    const ambiguous = [];
    const lines = [];

    for (const name of names) {
        const decls = byName.get(name);
        if (!decls || decls.length === 0) {
            stats.missing++;
            missing.push(name);
            lines.push(`    /** @go 未在源码中找到同名声明（可能只在非 Go 侧或已被合并） */`);
            lines.push(`    ${name}(...args: unknown[]): Promise<unknown>;`);
            continue;
        }
        const decl = pickDecl(decls);
        if (!decl) {
            stats.ambiguous++;
            ambiguous.push(`${name}（${decls.map((d) => d.file).join(' / ')}）`);
            lines.push(`    /** @go 同名声明签名不一致，回退 unknown：${decls.map((d) => d.file).join(' / ')} */`);
            lines.push(`    ${name}(...args: unknown[]): Promise<unknown>;`);
            continue;
        }
        const rendered = renderMethod(name, decl);
        lines.push(rendered);
        if (rendered.includes('unknown')) stats.fallback++;
        else stats.typed++;
    }

    // 具名结构体 interface 声明块（只含 STRUCT_INTERFACES 里登记的无歧义类型）
    const structDecls = [];
    for (const [name, fields] of Object.entries(STRUCT_INTERFACES)) {
        const body = fields.map(([field, ts]) => `    ${field}: ${ts};`).join('\n');
        structDecls.push(`export interface ${name} {\n${body}\n}`);
    }

    const total = names.length;
    const header = [
        '// backend.d.ts：Wails 绑定面类型——**自动生成，不要手改**。',
        '//',
        `// 生成：node scripts/gen-backend-types.mjs（名单来自 ${BASELINE}，${total} 个方法）`,
        '// 名单由 app_bindings_guard_test.go 校验，前端 FQN 是 main.App.<Method>；',
        '// 运行时经 Call.ByName 动态解析（frontend/src/core/wails-runtime.js 的 createBackendProxy）。',
        '//',
        `// 本次签名覆盖：精确 ${stats.typed} / 含 unknown ${stats.fallback} / 签名冲突 ${stats.ambiguous} / 未找到 ${stats.missing}`,
        '// 含 unknown 的行上方有 @go 注释，写明 Go 原始签名与待补的结构体名。',
        '//',
        '// 用法（阶梯 1 之后，jsconfig 仍保持 checkJs:false）：',
        "//   /** @type {import('../types/backend').Backend} */",
        '//   const backend = createBackendProxy(Call);',
        '',
        ...structDecls,
        'export interface Backend {',
    ];
    const footer = ['}', '', 'export type BackendMethod = keyof Backend;', ''];
    const content = [...header, ...lines, ...footer].join('\n');

    console.log(`名单 ${total} 个：精确 ${stats.typed}、含 unknown ${stats.fallback}、签名冲突 ${stats.ambiguous}、未找到 ${stats.missing}`);
    if (ambiguous.length) console.log(`签名冲突（多条同名声明）：\n  ${ambiguous.join('\n  ')}`);
    if (missing.length) console.log(`未找到声明：${missing.join(', ')}`);

    const target = join(ROOT, outPath);
    if (check) {
        let prev = '';
        try {
            prev = readFileSync(target, 'utf8');
        } catch {
            console.log(`${outPath} 不存在，--check 视为不一致`);
            process.exitCode = 1;
            return;
        }
        if (prev !== content) {
            console.log(`${outPath} 与生成结果不一致（请重新生成并提交）`);
            process.exitCode = 1;
            return;
        }
        console.log(`${outPath} 与生成结果一致`);
        return;
    }
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, content, 'utf8');
    console.log(`已写入 ${outPath}`);
}

main();
