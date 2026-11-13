// 运行代码：把当前文件交给本机已检测到的解释器 / 编译器执行，输出落到底部「运行」面板。
//
// 分层：本文件负责「配方 + 面板 + 输出渲染」，后端（run.go）只负责「准备临时文件、起进程、回传输出」。
// 语言知识留在这里（与 structure.js / formats.js 同一原则），Go 侧不认识 python / gcc 这些名字。
//
// 设计取舍（见 docs/finished-plans/run-code.md）：
//   - 输出面板用 DOM 而不是 xterm：要支持「点编译器报错里的 path:line:col 跳源码」；
//   - exec 参数数组，不经 shell 拼接；只有 .bat/.cmd/.sh/.ps1 才交给解释器；
//   - V1 不接管 stdin，交互式程序会拿到 EOF（报错而非卡住）。

import {iconSvg} from './icons.js';

const MAX_LINES = 5000; // 单次运行保留的输出行数，超出从头丢
const MAX_SESSIONS = 4; // 面板保留的运行标签数
const MAX_RUNNING = 3; // 同时运行的任务上限

// ---- 运行配方：扩展名 → 怎么跑 ----

export const RECIPES = {
    py: {lang: 'python', tool: 'python', label: 'Python', run: (c) => ['-u', c.file, ...c.args]},
    pyw: {lang: 'python', tool: 'python', label: 'Python', run: (c) => ['-u', c.file, ...c.args]},
    js: {lang: 'node', tool: 'node', label: 'Node.js', run: (c) => [c.file, ...c.args]},
    mjs: {lang: 'node', tool: 'node', label: 'Node.js', run: (c) => [c.file, ...c.args]},
    cjs: {lang: 'node', tool: 'node', label: 'Node.js', run: (c) => [c.file, ...c.args]},
    ts: {lang: 'node', tool: 'node', label: 'TypeScript', min: [22, 6], run: (c) => ['--experimental-strip-types', c.file, ...c.args]},
    mts: {lang: 'node', tool: 'node', label: 'TypeScript', min: [22, 6], run: (c) => ['--experimental-strip-types', c.file, ...c.args]},
    cts: {lang: 'node', tool: 'node', label: 'TypeScript', min: [22, 6], run: (c) => ['--experimental-strip-types', c.file, ...c.args]},
    go: {lang: 'go', tool: 'go', label: 'Go', run: (c) => ['run', c.file, ...c.args]},
    java: {lang: 'java', tool: 'java', label: 'Java', min: [11, 0], run: (c) => [c.file, ...c.args]},
    php: {lang: 'php', tool: 'php', label: 'PHP', run: (c) => [c.file, ...c.args]},
    rb: {lang: 'ruby', tool: 'ruby', label: 'Ruby', run: (c) => [c.file, ...c.args]},
    lua: {lang: 'lua', tool: 'lua', label: 'Lua', run: (c) => [c.file, ...c.args]},
    c: {
        lang: 'c', tool: 'c', label: 'C', outExt: '.exe',
        build: (c) => ['-O0', '-g', '-o', c.out, c.file],
        run: (c) => [c.out, ...c.args],
    },
    cpp: {
        lang: 'cpp', tool: 'cpp', label: 'C++', outExt: '.exe',
        build: (c) => ['-O0', '-g', '-std=c++17', '-o', c.out, c.file],
        run: (c) => [c.out, ...c.args],
    },
    cc: {lang: 'cpp', tool: 'cpp', label: 'C++', outExt: '.exe', build: (c) => ['-O0', '-g', '-std=c++17', '-o', c.out, c.file], run: (c) => [c.out, ...c.args]},
    cxx: {lang: 'cpp', tool: 'cpp', label: 'C++', outExt: '.exe', build: (c) => ['-O0', '-g', '-std=c++17', '-o', c.out, c.file], run: (c) => [c.out, ...c.args]},
    'c++': {lang: 'cpp', tool: 'cpp', label: 'C++', outExt: '.exe', build: (c) => ['-O0', '-g', '-std=c++17', '-o', c.out, c.file], run: (c) => [c.out, ...c.args]},
    rs: {
        lang: 'rust', tool: 'rust', label: 'Rust', outExt: '.exe',
        build: (c) => ['-o', c.out, c.file],
        run: (c) => [c.out, ...c.args],
    },
    bat: {lang: 'cmd', shell: 'cmd', label: 'Batch', run: (c) => ['/c', c.file, ...c.args]},
    cmd: {lang: 'cmd', shell: 'cmd', label: 'Batch', run: (c) => ['/c', c.file, ...c.args]},
    ps1: {lang: 'powershell', shell: 'pwsh', label: 'PowerShell', run: (c) => ['-NoLogo', '-NoProfile', '-File', c.file, ...c.args]},
    psd1: {lang: 'powershell', shell: 'pwsh', label: 'PowerShell', run: (c) => ['-NoLogo', '-NoProfile', '-File', c.file, ...c.args]},
    psm1: {lang: 'powershell', shell: 'pwsh', label: 'PowerShell', run: (c) => ['-NoLogo', '-NoProfile', '-File', c.file, ...c.args]},
    sh: {lang: 'bash', shell: 'gitbash', label: 'Shell', run: (c) => [c.file, ...c.args]},
    bash: {lang: 'bash', shell: 'gitbash', label: 'Shell', run: (c) => [c.file, ...c.args]},
    zsh: {lang: 'bash', shell: 'gitbash', label: 'Shell', run: (c) => [c.file, ...c.args]},
    ksh: {lang: 'bash', shell: 'gitbash', label: 'Shell', run: (c) => [c.file, ...c.args]},
};

const SHELL_FALLBACK = {
    pwsh: {shell: 'powershell', label: 'PowerShell'},
};

// 自检脚本：设置 → 运行 里「验证运行环境」用，按扩展名索引。
// 每段都只打印固定标记、不读写文件，跑在应用数据的临时目录里，不碰用户文件。
export const SELF_TEST = {
    py: {name: 'cadt_selftest.py', code: 'print("cadt-selftest-ok")\n'},
    js: {name: 'cadt_selftest.js', code: 'console.log("cadt-selftest-ok");\n'},
    ts: {name: 'cadt_selftest.ts', code: 'console.log("cadt-selftest-ok");\n'},
    go: {name: 'cadt_selftest.go', code: 'package main\nimport "fmt"\nfunc main() { fmt.Println("cadt-selftest-ok") }\n'},
    java: {name: 'CadTSelfTest.java', code: 'public class CadTSelfTest { public static void main(String[] a) { System.out.println("cadt-selftest-ok"); } }\n'},
    c: {name: 'cadt_selftest.c', code: '#include <stdio.h>\nint main(void) { puts("cadt-selftest-ok"); return 0; }\n'},
    cpp: {name: 'cadt_selftest.cpp', code: '#include <iostream>\nint main() { std::cout << "cadt-selftest-ok" << std::endl; }\n'},
    rs: {name: 'cadt_selftest.rs', code: 'fn main() { println!("cadt-selftest-ok"); }\n'},
    php: {name: 'cadt_selftest.php', code: '<?php echo "cadt-selftest-ok\\n";\n'},
    rb: {name: 'cadt_selftest.rb', code: 'puts "cadt-selftest-ok"\n'},
    lua: {name: 'cadt_selftest.lua', code: 'print("cadt-selftest-ok")\n'},
    bat: {name: 'cadt_selftest.bat', code: '@echo cadt-selftest-ok\n'},
    ps1: {name: 'cadt_selftest.ps1', code: 'Write-Output "cadt-selftest-ok"\n'},
    sh: {name: 'cadt_selftest.sh', code: 'echo cadt-selftest-ok\n'},
};
export const SELF_TEST_MARK = 'cadt-selftest-ok';

// 「发给 AI 分析」的提示词：只取尾部 200 行 / 12000 字符，避免把整个输出塞进上下文。
// 纯函数，便于单测；空输出返回空串，由调用方决定提示。
export function buildRunAnalysisPrompt(text, meta) {
    const lines = String(text || '').split('\n');
    let tail = lines.slice(-200).join('\n').trim();
    if (!tail) return '';
    if (tail.length > 12000) tail = '…（前面已省略）\n' + tail.slice(-12000);
    const m = meta || {};
    return [
        '这段运行输出是什么问题？请给出原因和可执行的修复建议。',
        '',
        '文件：' + (m.file || ''),
        '语言：' + (m.lang || ''),
        '退出码：' + (m.code == null ? '（仍在运行或已停止）' : m.code),
        '',
        '```text',
        tail,
        '```',
    ].join('\n');
}

// ---- 小工具 ----

// 下面几个纯函数导出给 node:test 用（src/run.test.mjs），业务代码不直接依赖
export function extOf(name) {
    const base = String(name || '').replace(/\\/g, '/').split('/').pop();
    const dot = base.lastIndexOf('.');
    return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function stemOf(name) {
    const base = String(name || '').replace(/\\/g, '/').split('/').pop();
    const dot = base.lastIndexOf('.');
    return dot <= 0 ? base : base.slice(0, dot);
}

export function joinPath(dir, name) {
    const d = String(dir || '').replace(/[\\/]+$/, '');
    if (!d) return name;
    return d + (d.includes('\\') ? '\\' : '/') + name;
}

function dirOf(path) {
    const s = String(path || '');
    const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i <= 0 ? '' : s.slice(0, i);
}

export function cmdText(exe, args) {
    const list = (args || []).map((a) => (/\s/.test(a) ? '"' + a + '"' : a));
    return [exe].concat(list).join(' ');
}

// 把「运行参数」输入框里的文本拆成 argv（不经 shell）：支持单双引号与转义。
// Windows 路径里的反斜杠必须原样保留，所以只在后面跟引号 / 空白 / 反斜杠时才当转义符。
// 引号未闭合时按普通字符收尾，不抛错——输入框随时可能处于「还没打完」的状态。
export function splitRunArgs(text) {
    const out = [];
    const s = String(text || '');
    let cur = '';
    let quote = '';
    let has = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '\\' && quote !== "'" && i + 1 < s.length && /["'\\\s]/.test(s[i + 1])) {
            cur += s[++i];
            has = true;
            continue;
        }
        if (quote) {
            if (ch === quote) quote = '';
            else cur += ch;
            has = true;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            has = true;
            continue;
        }
        if (/\s/.test(ch)) {
            if (has) {
                out.push(cur);
                cur = '';
                has = false;
            }
            continue;
        }
        cur += ch;
        has = true;
    }
    if (has) out.push(cur);
    return out;
}

// 命令模板：先按引号规则拆成 token，再逐 token 替换占位符。
// 关键点：占位符值（路径常含空格）永远是「一个 argv」，不经 shell 拼接；
// $ARGS 单独展开成多个 argv，用户不写 $ARGS 就等于忽略面板里的运行参数。
const RUN_TEMPLATE_VARS = /\$(TOOL|FILE|DIR|BASE|STEM|EXT|OUT)\b/g;

export function applyRunTemplate(template, ctx) {
    const values = {
        $TOOL: ctx.tool || '',
        $FILE: ctx.file || '',
        $DIR: ctx.dir || '',
        $BASE: ctx.base || '',
        $STEM: ctx.stem || '',
        $EXT: ctx.ext || '',
        $OUT: ctx.out || '',
    };
    const out = [];
    for (const token of splitRunArgs(template)) {
        if (token === '$ARGS') {
            out.push(...(ctx.args || []));
            continue;
        }
        out.push(token.replace(RUN_TEMPLATE_VARS, (name) => values[name] || ''));
    }
    return out;
}

// version 形如 "Python 3.12.1" / "openjdk version \"17.0.2\"" / "v20.11.0"，只取第一组 x.y
export function versionOf(text) {
    const m = String(text || '').match(/(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2])] : null;
}

export function versionAtLeast(version, min) {
    if (!version || !min) return true;
    if (version[0] !== min[0]) return version[0] > min[0];
    return version[1] >= min[1];
}

// ---- ANSI 上色（只认 SGR，其余 CSI 丢弃；不引入依赖） ----

const ANSI_RE = /\x1b\[([0-9;]*)m|\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

const SGR_FG = {30: 0, 31: 1, 32: 2, 33: 3, 34: 4, 35: 5, 36: 6, 37: 7};

export function ansiSegments(text) {
    const segments = [];
    let fg = '';
    let bold = false;
    let last = 0;
    let m;
    ANSI_RE.lastIndex = 0;
    const push = (chunk) => {
        if (!chunk) return;
        const cls = ['run-t'];
        if (fg) cls.push(fg);
        if (bold) cls.push('run-bold');
        segments.push({text: chunk, cls: cls.join(' ')});
    };
    while ((m = ANSI_RE.exec(text))) {
        push(text.slice(last, m.index));
        last = m.index + m[0].length;
        if (m[1] === undefined) continue; // 非 SGR（移动光标、清屏等）直接丢掉
        const codes = m[1] === '' ? [0] : m[1].split(';').map((n) => Number(n) || 0);
        for (const code of codes) {
            if (code === 0) {
                fg = '';
                bold = false;
            } else if (code === 1) {
                bold = true;
            } else if (code === 22) {
                bold = false;
            } else if (SGR_FG[code] !== undefined) {
                fg = 'run-fg-' + SGR_FG[code];
            } else if (code >= 90 && code <= 97) {
                fg = 'run-fg-' + (code - 90);
            } else if (code === 39) {
                fg = '';
            }
        }
    }
    push(text.slice(last));
    return segments;
}

// ---- 输出里的位置引用：双击/单击可跳到源码 ----

const REF_RULES = [
    // Python traceback：File "C:\a\b.py", line 12
    {re: /File "([^"]+)", line (\d+)/g, path: 1, line: 2, col: 0},
    // gcc / rustc / node / go：C:\a\b.c:12:5（路径必须含分隔符，避免把普通单词当路径）
    {re: /((?:[A-Za-z]:[\\/]|\/)[^\s"'<>|]+?\.[A-Za-z0-9_]{1,8}):(\d+)(?::(\d+))?/g, path: 1, line: 2, col: 3},
];

export function splitRefs(text) {
    const hits = [];
    for (const rule of REF_RULES) {
        rule.re.lastIndex = 0;
        let m;
        while ((m = rule.re.exec(text))) {
            hits.push({
                start: m.index,
                end: m.index + m[0].length,
                path: m[rule.path],
                line: Number(m[rule.line]) || 1,
                col: rule.col ? Number(m[rule.col]) || 1 : 1,
            });
        }
    }
    if (!hits.length) return [{text}];
    hits.sort((a, b) => a.start - b.start);
    const parts = [];
    let cursor = 0;
    for (const hit of hits) {
        if (hit.start < cursor) continue; // 重叠的引用丢掉后者
        if (hit.start > cursor) parts.push({text: text.slice(cursor, hit.start)});
        parts.push({text: text.slice(hit.start, hit.end), ref: hit});
        cursor = hit.end;
    }
    if (cursor < text.length) parts.push({text: text.slice(cursor)});
    return parts;
}

// ---- 控制器 ----

export function createRunController(deps) {
    const sessions = new Map();
    const order = [];
    const exitWaiters = new Map();
    let seq = 0;
    let activeId = '';
    let els = null;
    let pendingProject = null;

    function mount() {
        els = {
            view: document.getElementById('run-view'),
            tabs: document.getElementById('run-tabs'),
            body: document.getElementById('run-body'),
            status: document.getElementById('run-status'),
            clear: document.getElementById('run-clear'),
            closeAll: document.getElementById('run-close-all'),
            panelClose: document.getElementById('run-panel-close'),
            args: document.getElementById('run-args-input'),
            inputBar: document.getElementById('run-input-bar'),
            stdin: document.getElementById('run-stdin-input'),
            stdinSend: document.getElementById('run-stdin-send'),
            stdinEof: document.getElementById('run-stdin-eof'),
            projectBar: document.getElementById('run-project-bar'),
            projectRoot: document.getElementById('run-project-root'),
            projectNote: document.getElementById('run-project-note'),
            projectCmd: document.getElementById('run-project-cmd'),
            projectGo: document.getElementById('run-project-go'),
            projectCancel: document.getElementById('run-project-cancel'),
        };
        if (els.projectGo) els.projectGo.addEventListener('click', runProjectFromChoice);
        if (els.projectCancel) els.projectCancel.addEventListener('click', () => {
            hideProjectChoice();
            const session = sessions.get(activeId);
            if (session) appendLine(session, '▸ 已取消项目运行', 'info');
        });
        if (els.clear) els.clear.addEventListener('click', () => clearActive());
        if (els.closeAll) els.closeAll.addEventListener('click', () => closeAll());
        if (els.panelClose) els.panelClose.addEventListener('click', () => deps.hidePanel());
        if (els.stdinSend) els.stdinSend.addEventListener('click', sendInput);
        if (els.stdinEof) els.stdinEof.addEventListener('click', endInput);
        if (els.stdin) {
            els.stdin.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                e.stopPropagation();
                sendInput();
            });
        }
        if (els.args) {
            // 输入即记住（按当前任务的语种），回车直接跑，省得再去按 F5
            els.args.addEventListener('input', persistArgs);
            els.args.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                e.stopPropagation();
                persistArgs();
                run();
            });
        }
        deps.onEvent('run-out', onRunOut);
        deps.onEvent('run-exit', onRunExit);
        syncArgs(currentLang());
    }

    // 参数输入框按「当前活动任务的语言」隔离：切标签时回显那次任务用过的参数
    function currentLang() {
        const session = sessions.get(activeId);
        if (session) return session.recipe.lang;
        const recipe = recipeFor(deps.getActiveDoc());
        return recipe ? recipe.lang : '';
    }

    function persistArgs() {
        if (!els || !els.args) return;
        const lang = currentLang();
        if (lang) deps.setArgs(lang, els.args.value);
    }

    function syncArgs(lang) {
        if (!els || !els.args || !lang) return;
        els.args.value = deps.argsText(lang);
    }

    // ---------- 对外动作 ----------

    function recipeFor(doc) {
        return doc ? RECIPES[extOf(doc.name || doc.path)] || null : null;
    }

    function isSupported(doc) {
        return !!recipeFor(doc);
    }

    async function run() {
        const doc = deps.getActiveDoc();
        if (!doc) {
            deps.flash('没有打开的文件', true);
            return;
        }
        if (doc.binary || doc.large) {
            deps.flash('二进制或超大文件不能运行', true);
            return;
        }
        if (deps.isReadOnly()) {
            deps.flash('只读模式下不执行代码', true);
            return;
        }
        const ext = extOf(doc.name || doc.path);
        const recipe = RECIPES[ext];
        if (!recipe) {
            deps.flash('该格式不支持运行：' + (ext ? '.' + ext : '无扩展名'), true);
            return;
        }
        const running = [...sessions.values()].filter((s) => s.state === 'running' || s.state === 'building').length;
        if (running >= MAX_RUNNING) {
            deps.flash('同时运行超过 ' + MAX_RUNNING + ' 个，先停止一个', true);
            deps.showRunPanel();
            return;
        }

        // 面板里看到的参数就是这次运行的参数；按语言记住，切回同语言的任务时回显
        if (els && els.args) deps.setArgs(recipe.lang, els.args.value);

        // 首次运行某语言：明示「以你的权限执行本机代码」
        if (!deps.hasConfirmed(recipe.lang)) {
            const ok = await deps.confirmRun(recipe.label, recipe.lang);
            if (!ok) return;
        }

        // 未保存修改：弹窗让用户选（保存并运行 / 临时副本 / 取消）
        let content = '';
        const dirty = !!doc.dirty || !doc.path;
        if (dirty) {
            const choice = await deps.askDirtyChoice({name: doc.name || '', canSave: !!doc.path});
            if (choice === 'cancel' || !choice) return;
            if (choice === 'save') {
                const saved = await deps.saveDoc();
                if (!saved) return;
            } else {
                content = deps.getDocText() || '';
            }
        }

        const session = createSession(doc, recipe);
        activate(session.id);
        deps.showRunPanel();

        const tool = await resolveTool(recipe);
        if (!tool.ok) {
            appendLine(session, tool.error, 'err');
            finishSession(session, 'failed', null);
            return;
        }
        if (recipe.min && !versionAtLeast(versionOf(tool.version), recipe.min)) {
            appendLine(session, sessionLabel(recipe) + ' 版本过低：当前 ' + (tool.version || '未知') +
                '，需要 ' + recipe.min.join('.') + '+', 'err');
            if (recipe.lang === 'node') appendLine(session, '提示：TypeScript 也可用 tsx / ts-node 执行，本应用不会自动安装。', 'err');
            finishSession(session, 'failed', null);
            return;
        }

        let workspace;
        try {
            workspace = await deps.backend.PrepareRun({
                srcPath: doc.path || '',
                content,
                tempName: doc.name || '',
                needTemp: !!recipe.build,
            });
        } catch (e) {
            appendLine(session, '准备运行环境失败：' + errText(e), 'err');
            finishSession(session, 'failed', null);
            return;
        }
        session.tempDir = workspace.tempDir || '';
        if (workspace.tempCopy) {
            appendLine(session, '▸ 使用临时副本运行（同目录依赖与相对路径可能不可用）', 'info');
        }

        const outPath = recipe.outExt
            ? joinPath(workspace.tempDir, stemOf(doc.name || workspace.sourcePath) + recipe.outExt)
            : '';
        // 工作目录：默认文件所在目录（读旁边的数据文件），设置里可改成工作区根
        const workDir = deps.resolveWorkDir(workspace.workDir) || workspace.workDir;
        const ctx = {
            file: workspace.sourcePath,
            dir: workDir,
            base: doc.name || '',
            stem: stemOf(doc.name || workspace.sourcePath),
            ext,
            tool: tool.path,
            out: outPath,
            args: deps.argsFor(recipe.lang),
        };
        const steps = makeSteps(recipe, tool, ctx, deps.templateFor(recipe.lang));

        session.steps = steps;
        session.label = sessionLabel(recipe);
        session.state = 'running';
        session.startedAt = performance.now();
        startTimer(session);
        renderStatus();
        await execSteps(session, steps);
    }

    // 设置 → 运行 的「验证运行环境」：跑一段只打印固定标记的最小脚本。
    // 不碰用户文件、不弹确认框、忽略用户模板（目的是验证工具链本身），但走同一条执行通道。
    async function selfTest(ext) {
        const info = SELF_TEST[ext];
        const recipe = RECIPES[ext];
        if (!info || !recipe) {
            deps.flash('该语言没有自检脚本', true);
            return;
        }
        if (deps.isReadOnly()) {
            deps.flash('只读模式下不执行代码', true);
            return;
        }
        if ([...sessions.values()].filter((s) => s.state === 'running').length >= MAX_RUNNING) {
            deps.flash('同时运行超过 ' + MAX_RUNNING + ' 个，先停止一个', true);
            deps.showRunPanel();
            return;
        }
        const session = createSession({name: '自检 ' + recipe.label}, recipe);
        session.selfTest = true;
        activate(session.id);
        deps.showRunPanel();
        appendLine(session, '▸ 自检 ' + recipe.label + '：临时脚本只打印一行标记，不改动任何文件', 'info');

        const tool = await resolveTool(recipe);
        if (!tool.ok) {
            appendLine(session, tool.error, 'err');
            finishSession(session, 'failed', null);
            return;
        }
        if (recipe.min && !versionAtLeast(versionOf(tool.version), recipe.min)) {
            appendLine(session, recipe.label + ' 版本过低：当前 ' + (tool.version || '未知') +
                '，需要 ' + recipe.min.join('.') + '+', 'err');
            finishSession(session, 'failed', null);
            return;
        }
        let workspace;
        try {
            workspace = await deps.backend.PrepareRun({
                srcPath: '',
                content: info.code,
                tempName: info.name,
                needTemp: !!recipe.build,
            });
        } catch (e) {
            appendLine(session, '准备自检环境失败：' + errText(e), 'err');
            finishSession(session, 'failed', null);
            return;
        }
        session.tempDir = workspace.tempDir || '';
        const outPath = recipe.outExt
            ? joinPath(workspace.tempDir, stemOf(info.name) + recipe.outExt)
            : '';
        const ctx = {
            file: workspace.sourcePath,
            dir: workspace.workDir || workspace.tempDir || '',
            base: info.name,
            stem: stemOf(info.name),
            ext,
            tool: tool.path,
            out: outPath,
            args: [],
        };
        const steps = makeSteps(recipe, tool, ctx, '');
        session.steps = steps;
        session.state = 'running';
        session.startedAt = performance.now();
        startTimer(session);
        renderStatus();
        await execSteps(session, steps);
    }

    // 由配方（或用户命令模板）生成 1~2 个执行步骤；正常运行、自检与项目运行共用。
    // 模板是完整命令行，第一个 token 是可执行文件；编译型的 build 步骤仍用默认配方。
    function makeSteps(recipe, tool, ctx, template) {
        const cmd = template ? applyRunTemplate(template, ctx) : null;
        const override = !!(cmd && cmd.length);
        const steps = [];
        if (recipe.build) {
            steps.push({
                kind: 'build',
                exe: tool.path,
                args: recipe.build(ctx),
                cwd: ctx.dir,
                pathPrepend: '',
            });
            steps.push({
                kind: 'run',
                exe: override ? cmd[0] : ctx.out,
                args: override ? cmd.slice(1) : recipe.run(ctx).slice(1),
                cwd: ctx.dir,
                // 编译产物依赖编译器同目录的运行时 dll（MinGW），必须前置 PATH
                pathPrepend: dirOf(tool.path),
            });
        } else {
            steps.push({
                kind: 'run',
                exe: override ? cmd[0] : tool.path,
                args: override ? cmd.slice(1) : recipe.run(ctx),
                cwd: ctx.dir,
                pathPrepend: '',
            });
        }
        return steps;
    }

    async function execSteps(session, steps) {
        let total = 0;
        for (const step of steps) {
            if (session.cancelled || session.closed) break;
            session.phase = step.kind;
            session.eofSent = false;
            renderStatus();
            appendLine(session, '▸ ' + (step.kind === 'build' ? '编译：' : '运行：') + cmdText(step.exe, step.args), 'info');
            const id = session.id + '-' + step.kind;
            const exit = await startStep(session, id, step);
            if (!exit) {
                finishSession(session, 'failed', null, total);
                return;
            }
            total += exit.durationMs || 0;
            if (step.kind === 'build' && exit.code !== 0) {
                appendLine(session, '▸ 编译失败，未执行', 'err');
                finishSession(session, 'failed', exit.code, total);
                return;
            }
            session.code = exit.code;
        }
        if (session.closed) return; // 面板已关：不再收尾，临时目录由 closeSession 清理
        if (session.cancelled) {
            finishSession(session, 'stopped', null, total);
            return;
        }
        finishSession(session, (session.code || 0) === 0 ? 'exited' : 'failed', session.code, total);
    }

    function startStep(session, id, step) {
        return new Promise((resolve) => {
            exitWaiters.set(id, (data) => resolve({code: data.code | 0, durationMs: data.durationMs | 0}));
            Promise.resolve(deps.backend.RunExec(id, step.exe, step.args, step.cwd || '', step.pathPrepend || ''))
                .catch((e) => {
                    exitWaiters.delete(id);
                    appendLine(session, '启动失败：' + errText(e), 'err');
                    resolve(null);
                });
        });
    }

    function stop() {
        const session = sessions.get(activeId);
        if (!session) return;
        if (session.state !== 'running') {
            deps.flash('当前没有正在运行的任务');
            return;
        }
        session.cancelled = true;
        const suffix = session.phase === 'build' ? '-build' : '-run';
        deps.backend.RunStop(session.id + suffix).catch(() => {});
        // run-exit 会带回 -1，由 execSteps 收尾
    }

    function togglePanel() {
        deps.showRunPanel();
    }

    function hasRunning() {
        return [...sessions.values()].some((s) => s.state === 'running');
    }

    function clearActive() {
        const session = sessions.get(activeId);
        if (!session) return;
        session.outEl.textContent = '';
        session.lineCount = 0;
    }

    function closeAll() {
        for (const id of order.slice()) closeSession(id);
    }

    // ---------- 会话与 DOM ----------

    function createSession(doc, recipe) {
        const id = 'run-' + ++seq;
        const title = doc.name || '未命名';
        const session = {
            id,
            title,
            recipe,
            label: sessionLabel(recipe),
            state: 'running',
            phase: recipe.build ? 'build' : 'run',
            eofSent: false,
            code: null,
            startedAt: performance.now(),
            durationMs: 0,
            cancelled: false,
            pending: [],
            rafId: 0,
            lineCount: 0,
            tempDir: '',
            steps: [],
            timer: null,
        };
        const wrap = document.createElement('div');
        wrap.className = 'run-session';
        const out = document.createElement('div');
        out.className = 'run-output';
        out.addEventListener('scroll', () => {
            const nearBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 32;
            session.pinned = nearBottom;
        });
        wrap.appendChild(out);
        els.body.appendChild(wrap);

        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'run-tab';
        const label = document.createElement('span');
        label.className = 'run-tab-label';
        label.textContent = title;
        label.title = title;
        const close = document.createElement('span');
        close.className = 'run-tab-close';
        close.innerHTML = iconSvg('close', 11);
        close.title = '关闭';
        tab.append(label, close);
        tab.addEventListener('click', (e) => {
            if (e.target.closest('.run-tab-close')) {
                closeSession(id);
                return;
            }
            activate(id);
        });
        els.tabs.appendChild(tab);

        session.wrapEl = wrap;
        session.outEl = out;
        session.tabEl = tab;
        session.pinned = true;
        sessions.set(id, session);
        order.push(id);
        while (order.length > MAX_SESSIONS) closeSession(order[0]);
        return session;
    }

    function activate(id) {
        const session = sessions.get(id);
        if (!session) return;
        activeId = id;
        for (const [sid, s] of sessions) {
            s.wrapEl.classList.toggle('hidden', sid !== id);
            s.tabEl.classList.toggle('active', sid === id);
        }
        syncArgs(session.recipe.lang);
        if (els && els.stdin) els.stdin.value = '';
        renderStatus();
    }

    function closeSession(id) {
        const session = sessions.get(id);
        if (!session) return;
        session.closed = true;
        if (session.state === 'running' || session.state === 'building') {
            const suffix = session.phase === 'build' ? '-build' : '-run';
            deps.backend.RunStop(session.id + suffix).catch(() => {});
        }
        if (session.tempDir) {
            deps.backend.CleanupRunTemp(session.tempDir).catch(() => {});
            session.tempDir = '';
        }
        stopTimer(session);
        if (session.rafId) cancelAnimationFrame(session.rafId);
        session.wrapEl.remove();
        session.tabEl.remove();
        sessions.delete(id);
        const idx = order.indexOf(id);
        if (idx >= 0) order.splice(idx, 1);
        if (activeId === id) {
            activeId = order.length ? order[order.length - 1] : '';
            if (activeId) activate(activeId);
            else renderStatus();
        }
    }

    function finishSession(session, state, code, durationMs) {
        session.state = state;
        session.code = code == null ? session.code : code;
        if (durationMs != null) session.durationMs = durationMs;
        else session.durationMs = Math.round(performance.now() - session.startedAt);
        stopTimer(session);
        flushPending(session);
        if (session.selfTest) {
            const text = session.outEl.innerText || '';
            const ok = state === 'exited' && text.includes(SELF_TEST_MARK);
            appendLine(session, ok
                ? '✓ 自检通过：' + session.label + ' 能正常编译 / 执行文件'
                : '✗ 自检未通过：没有看到预期输出，请检查上面的报错或 设置 → 编程语言 里的环境',
                ok ? 'info' : 'err');
        }
        if (session.tempDir) deps.backend.CleanupRunTemp(session.tempDir).catch(() => {});
        session.tempDir = '';
        deps.logActivity(session.title, {
            lang: session.recipe.lang,
            code: session.code == null ? -1 : session.code,
            ms: session.durationMs,
            state,
        });
        renderStatus();
        if (state === 'failed' && !session.closed) {
            deps.flash('运行失败（退出码 ' + (session.code == null ? '?' : session.code) + '）', true);
        }
    }

    // ---------- 输出 ----------

    function onRunOut(data) {
        if (!data || !data.id) return;
        const baseId = String(data.id).replace(/-(run|build)$/, '');
        const session = sessions.get(baseId);
        if (!session) return;
        const stream = data.stream === 'err' ? 'err' : 'out';
        for (const line of String(data.data || '').split('\n')) {
            if (line === '') continue;
            session.pending.push({line, stream});
        }
        scheduleFlush(session);
    }

    function onRunExit(data) {
        if (!data || !data.id) return;
        const waiter = exitWaiters.get(data.id);
        if (waiter) {
            exitWaiters.delete(data.id);
            waiter(data);
        }
    }

    function scheduleFlush(session) {
        if (session.rafId) return;
        session.rafId = requestAnimationFrame(() => {
            session.rafId = 0;
            flushPending(session);
        });
    }

    function flushPending(session) {
        if (!session.pending.length) return;
        const batch = session.pending;
        session.pending = [];
        const fragment = document.createDocumentFragment();
        for (const item of batch) fragment.appendChild(buildLine(item.line, item.stream));
        session.outEl.appendChild(fragment);
        session.lineCount += batch.length;
        if (session.lineCount > MAX_LINES) {
            const drop = session.lineCount - MAX_LINES;
            for (let i = 0; i < drop && session.outEl.firstChild; i++) session.outEl.removeChild(session.outEl.firstChild);
            session.lineCount -= drop;
        }
        if (session.pinned) session.outEl.scrollTop = session.outEl.scrollHeight;
    }

    function buildLine(text, stream) {
        const row = document.createElement('div');
        row.className = 'run-line' + (stream === 'err' ? ' run-line-err' : '');
        const segments = ansiSegments(text);
        if (!segments.length) {
            row.textContent = '';
            return row;
        }
        for (const seg of segments) {
            for (const part of splitRefs(seg.text)) {
                if (part.ref) {
                    const link = document.createElement('button');
                    link.type = 'button';
                    link.className = seg.cls + ' run-ref';
                    link.textContent = part.text;
                    link.title = '跳到 ' + part.ref.path + ':' + part.ref.line;
                    link.addEventListener('click', () => deps.openLocation(part.ref.path, part.ref.line, part.ref.col));
                    row.appendChild(link);
                } else {
                    const span = document.createElement('span');
                    span.className = seg.cls;
                    span.textContent = part.text;
                    row.appendChild(span);
                }
            }
        }
        return row;
    }

    function appendLine(session, text, kind) {
        const row = buildLine(text, kind === 'err' ? 'err' : 'out');
        if (kind === 'info') row.classList.add('run-line-info');
        session.outEl.appendChild(row);
        session.lineCount += 1;
        if (session.pinned) session.outEl.scrollTop = session.outEl.scrollHeight;
    }

    // ---------- stdin ----------

    function activeStepId(session) {
        return session.id + '-' + (session.phase || 'run');
    }

    function inputAvailable(session) {
        return !!session && session.state === 'running' && session.phase !== 'build' && !session.eofSent;
    }

    async function sendInput() {
        const session = sessions.get(activeId);
        if (!inputAvailable(session) || !els || !els.stdin) return;
        const text = els.stdin.value;
        try {
            await deps.backend.RunInput(activeStepId(session), text);
            appendLine(session, '» ' + text, 'info');
            els.stdin.value = '';
            els.stdin.focus();
        } catch (e) {
            deps.flash('发送输入失败：' + errText(e), true);
        }
    }

    async function endInput() {
        const session = sessions.get(activeId);
        if (!session || session.state !== 'running' || session.phase === 'build') return;
        try {
            await deps.backend.RunEndInput(activeStepId(session));
            session.eofSent = true;
            appendLine(session, '» 已关闭输入端（EOF）', 'info');
            renderStatus();
        } catch (e) {
            deps.flash('关闭输入失败：' + errText(e), true);
        }
    }

    // ---------- 项目感知运行（V3） ----------

    // 只在面板里列出候选命令，用户点「执行」才真的起进程；不记住、每次都要确认。
    function showProjectChoice(info) {
        if (!els || !els.projectBar) return;
        const cmds = (info && info.commands) || [];
        if (!cmds.length) {
            deps.flash((info && info.note) || '没有可运行的项目命令', true);
            return;
        }
        pendingProject = info;
        els.projectRoot.textContent = info.root || '';
        els.projectRoot.title = info.root || '';
        els.projectNote.textContent = info.note || '';
        els.projectNote.classList.toggle('hidden', !info.note);
        els.projectCmd.textContent = '';
        cmds.forEach((cmd, i) => {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = cmd.label || cmd.exe || ('命令 ' + (i + 1));
            els.projectCmd.appendChild(opt);
        });
        els.projectBar.classList.remove('hidden');
        deps.showRunPanel();
    }

    function hideProjectChoice() {
        pendingProject = null;
        if (!els) return;
        if (els.projectBar) els.projectBar.classList.add('hidden');
        if (els.projectNote) els.projectNote.classList.add('hidden');
    }

    async function runProjectFromChoice() {
        const info = pendingProject;
        if (!info || !els || !els.projectCmd) return;
        const cmd = (info.commands || [])[Number(els.projectCmd.value) || 0];
        hideProjectChoice();
        if (!cmd) return;
        await runProject(info, cmd);
    }

    async function runProject(info, cmd) {
        if (deps.isReadOnly()) {
            deps.flash('只读模式下不执行代码', true);
            return;
        }
        if ([...sessions.values()].filter((s) => s.state === 'running').length >= MAX_RUNNING) {
            deps.flash('同时运行超过 ' + MAX_RUNNING + ' 个，先停止一个', true);
            deps.showRunPanel();
            return;
        }
        const recipe = {lang: 'project', label: (info.kind || '项目') + ' 项目', run: () => []};
        const session = createSession({name: cmd.label || '项目运行'}, recipe);
        activate(session.id);
        deps.showRunPanel();
        appendLine(session, '▸ 项目根：' + (info.root || '') + '（' + (info.marker || '') + '）', 'info');
        const steps = [{
            kind: 'run',
            exe: cmd.exe,
            args: cmd.args || [],
            cwd: cmd.cwd || info.root || '',
            pathPrepend: '',
        }];
        session.steps = steps;
        session.state = 'running';
        session.startedAt = performance.now();
        startTimer(session);
        renderStatus();
        await execSteps(session, steps);
    }

    // ---------- 发给 AI 分析 ----------

    function askAI(session) {
        const prompt = buildRunAnalysisPrompt(session.outEl.innerText || '', {
            file: session.title || '',
            lang: session.label,
            code: session.code == null ? '（仍在运行或已停止）' : session.code,
        });
        if (!prompt) {
            deps.flash('还没有可分析的输出', true);
            return;
        }
        deps.askAI(prompt);
    }

    // ---------- 状态行 ----------

    function startTimer(session) {
        stopTimer(session);
        session.timer = setInterval(() => {
            if (sessions.get(activeId) === session) renderStatus();
        }, 200);
    }

    function stopTimer(session) {
        if (session.timer) {
            clearInterval(session.timer);
            session.timer = null;
        }
    }

    function renderStatus() {
        if (!els || !els.status) return;
        els.status.textContent = '';
        const session = sessions.get(activeId);
        if (els.inputBar) els.inputBar.classList.toggle('hidden', !inputAvailable(session));
        if (!session) {
            const hint = document.createElement('span');
            hint.className = 'run-status-hint';
            hint.textContent = '按 F5 运行当前文件';
            els.status.appendChild(hint);
            return;
        }
        const dot = document.createElement('span');
        dot.className = 'run-dot run-dot-' + session.state;
        const stateText = {
            running: session.phase === 'build' ? '编译中' : '运行中',
            exited: '已完成',
            failed: '已退出（非 0）',
            stopped: '已停止',
        }[session.state] || session.state;
        const label = document.createElement('span');
        label.className = 'run-state-text';
        label.textContent = stateText;
        const meta = document.createElement('span');
        meta.className = 'run-meta';
        const elapsed = session.state === 'running'
            ? Math.round(performance.now() - session.startedAt)
            : session.durationMs;
        const bits = [(elapsed / 1000).toFixed(elapsed < 10000 ? 2 : 1) + ' s'];
        if (session.code != null) bits.push('退出码 ' + session.code);
        bits.push(session.label);
        meta.textContent = bits.join(' · ');
        els.status.append(dot, label, meta);

        if (session.state === 'running') {
            const stopBtn = document.createElement('button');
            stopBtn.type = 'button';
            stopBtn.className = 'run-btn run-btn-stop';
            stopBtn.innerHTML = iconSvg('close', 11) + '<span>停止</span>';
            stopBtn.addEventListener('click', stop);
            els.status.appendChild(stopBtn);
        }
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'run-btn';
        copyBtn.textContent = '复制输出';
        copyBtn.addEventListener('click', () => {
            const text = session.outEl.innerText || '';
            if (!text) return;
            deps.copyText(text, '运行输出');
        });
        els.status.appendChild(copyBtn);
        if (session.outEl.childNodes.length) {
            const aiBtn = document.createElement('button');
            aiBtn.type = 'button';
            aiBtn.className = 'run-btn';
            aiBtn.textContent = '发给 AI 分析';
            aiBtn.title = '把输出尾部 200 行填进 AI 输入框，不会自动发送';
            aiBtn.addEventListener('click', () => askAI(session));
            els.status.appendChild(aiBtn);
        }
    }

    // ---------- 工具链 ----------

    async function resolveTool(recipe) {
        if (recipe.shell) {
            let shell = recipe.shell;
            try {
                const info = await deps.backend.ResolveRunShell(shell);
                return {ok: true, path: info.path, version: ''};
            } catch (e) {
                const fallback = SHELL_FALLBACK[shell];
                if (fallback) {
                    try {
                        const info = await deps.backend.ResolveRunShell(fallback.shell);
                        return {ok: true, path: info.path, version: ''};
                    } catch (e2) {
                        // 落到下面的统一错误
                    }
                }
                return {ok: false, error: '无法运行：' + errText(e) + '（可在 设置 → 系统集成 检查）'};
            }
        }
        const tool = await deps.ensureToolchain(recipe.lang, recipe.tool);
        if (!tool || !tool.path) {
            return {ok: false, error: '未检测到 ' + recipe.label + ' 的运行环境。请到 设置 → 编程语言 → ' + recipe.label + ' 里扫描或手动指定路径。'};
        }
        return {ok: true, path: tool.path, version: tool.version || ''};
    }

    function sessionLabel(recipe) {
        return recipe.label || recipe.lang;
    }

    function errText(e) {
        if (!e) return '未知错误';
        if (typeof e === 'string') return e;
        return e.message || String(e);
    }

    return {mount, run, selfTest, showProjectChoice, currentLang, stop, togglePanel, isSupported, hasRunning, clearActive, closeAll};
}
