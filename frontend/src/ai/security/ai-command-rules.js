// 终端命令会话放行的纯函数：解析简单命令、生成同类签名、匹配规则。
// 只接受单条简单命令；出现管道、重定向、命令串联或子表达式时不做同类放行。
// 同类白名单只覆盖低风险开发命令与纯导航/回显命令；解释器与任意文件读取命令只能按“相同命令”放行。

const INTERPRETER_EXES = new Set([
    'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh',
    'powershell', 'pwsh', 'cmd',
    'python', 'python2', 'python3', 'py',
    'node', 'nodejs', 'deno', 'bun',
    'perl', 'ruby', 'php',
    'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32',
    'sudo', 'runas', 'env', 'xargs', 'eval', 'source',
    'start', 'explorer',
]);

// 纯导航/回显命令：不读文件内容、不产生副作用（分词阶段已排除重定向与命令串联），
// 参数不设白名单——`cd <任意目录>` 只影响本次进程，`echo <任意文本>` 不落地。
const PLAIN_SAFE_EXES = new Set(['pwd', 'cd', 'chdir', 'echo']);

const FAMILY_SPECS = {
    git: {
        subcommands: new Set([
            'status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame',
            'grep', 'shortlog', 'describe', 'whatchanged', 'merge-base',
            'name-rev', 'for-each-ref',
        ]),
        blockedArgs: [
            '--exec', '--upload-pack', '--receive-pack', '--ext-diff', '--textconv',
            '--output', '--config-env', '--open-files-in-pager', '--git-dir',
            '--work-tree', '--no-index', '--exec-path', '-c', '-O*',
        ],
    },
    go: {
        subcommands: new Set(['test', 'build', 'vet', 'list', 'env', 'version', 'doc']),
        blockedArgs: [
            '-o*', '-exec', '-toolexec', '-overlay', '-coverprofile', '-cpuprofile',
            '-memprofile', '-blockprofile', '-mutexprofile', '-trace', '-c', '-w', '-u',
        ],
    },
    npm: {
        subcommands: new Set(['test', 'run', 'ls', 'view', 'outdated']),
        scriptSubcommand: 'run',
        blockedArgs: [
            '--prefix', '--script-shell', '--registry', '--userconfig', '--global',
            '--location', '--workspace', '--filter', '--dir', '--cache', '--tmp',
            '-g*', '-w*', '-C*', '-F*',
        ],
    },
    pnpm: {
        subcommands: new Set(['test', 'run', 'ls', 'view', 'outdated']),
        scriptSubcommand: 'run',
        blockedArgs: [
            '--prefix', '--dir', '--filter', '--workspace-root', '--global',
            '--location', '--store-dir', '--virtual-store-dir', '--cache-dir',
            '-C*', '-F*', '-g*', '-w*',
        ],
    },
    dotnet: {
        subcommands: new Set(['build', 'test', 'list']),
        blockedArgs: ['--output', '-o*', '--project', '-p*', '--configfile', '--packages'],
    },
    cargo: {
        subcommands: new Set(['check', 'build', 'test', 'clippy', 'metadata']),
        blockedArgs: ['--manifest-path', '--target-dir', '--config', '-Z*'],
    },
};

// 只读命令：不读文件内容之外不产生任何副作用，参数不限制（写入型参数在 blockers 里单独拦）。
const READONLY_ANY_ARGS = new Set([
    'basename', 'cal', 'cat', 'chdir', 'cd', 'cmp', 'comm', 'cut', 'date', 'df', 'diff',
    'dirname', 'du', 'echo', 'egrep', 'expand', 'expr', 'false', 'fgrep', 'find',
    'fmt', 'fold', 'free', 'grep', 'groups', 'head', 'hexdump', 'hostname', 'id',
    'locale', 'ls', 'nl', 'nproc', 'numfmt', 'od', 'paste', 'pr', 'printf', 'pwd',
    'readlink', 'realpath', 'rev', 'rg', 'seq', 'sleep', 'sort', 'stat', 'strings', 'tac',
    'tail', 'tr', 'true', 'tsort', 'uname', 'unexpand', 'uniq', 'uptime', 'wc',
    'which', 'whoami',
    // Windows / cmd 常用只读命令
    'attrib', 'dir', 'findstr', 'ipconfig', 'more', 'systeminfo', 'tasklist',
    'ver', 'where', 'whereis', 'cls', 'type',
]);

// 命中任一前缀即判定“不是只读”，回退人工审批。
const READONLY_BLOCKED_ARGS = {
    sort: ['-o', '--output', '--compress-program'],
    tree: ['-o', '--output'],
    find: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fls', '-fprintf'],
    rg: ['--pre', '--pre-glob'],
    file: ['-C', '--compile'],
    hostname: ['-F', '--file'],
    date: ['-s', '--set'],
};

const GIT_READONLY_SUBCOMMANDS = new Set([
    'status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file',
    'blame', 'grep', 'shortlog', 'describe', 'whatchanged', 'merge-base', 'name-rev',
    'for-each-ref', 'show-ref', 'version', 'help', 'reflog', 'stash', 'worktree',
    'submodule', 'notes', 'branch', 'tag', 'remote', 'config',
]);

const GIT_GLOBAL_DANGEROUS = [
    '-C', '--git-dir', '--work-tree', '-c', '--config-env', '--exec-path',
    '--namespace', '--super-prefix', '--attr-source', '--shallow-file', '--bare',
];

export function commandText(value) {
    return String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
}

export function commandTokens(command) {
    const text = commandText(command);
    if (!text || text.includes('\n')) return null;
    // 命令替换/子表达式可能在引号内执行，直接判为不可同类放行。
    if (text.includes('`') || text.includes('$(') || text.includes('${')) return null;
    const tokens = [];
    let current = '';
    let quote = '';
    for (const ch of text) {
        if (quote) {
            if (ch === quote) quote = '';
            else current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === ';' || ch === '&' || ch === '|' || ch === '>' || ch === '<') return null;
        if (/\s/.test(ch)) {
            if (current) {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        current += ch;
    }
    if (quote) return null;
    if (current) tokens.push(current);
    return tokens.length ? tokens : null;
}

function commandExecutable(token) {
    return String(token || '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
}

// 穿透前置环境变量赋值与包装器，找到真正要执行的 exe（红队 F3）：
// `env FLOOD=x python3 -c "…"` 的 tokens[0] 是 env，解释器内联代码检测曾对它完全失明。
function resolveExe(tokens) {
    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
        const exe = commandExecutable(token);
        if (exe === 'env' || exe === 'nice' || exe === 'nohup' || exe === 'command' || exe === 'time') continue;
        return {exe, index: i};
    }
    return {exe: '', index: 0};
}

function argBlocked(arg, prefixes) {
    const value = String(arg || '').toLowerCase();
    return prefixes.some((prefix) => {
        const p = String(prefix).toLowerCase();
        // 末尾 * 表示短选项的粘连写法（-oC:\path、-Cdir）也要拦截。
        if (p.endsWith('*')) {
            const base = p.slice(0, -1);
            return value === base || value.startsWith(base);
        }
        return value === p || value.startsWith(p + '=');
    });
}

/**
 * 剥离前置的纯 `cd <dir> &&` 导航段，返回剩余命令；不满足返回 null。
 *
 * 只接受「恰好一段 cd/chdir + 一条后续命令」：多段串联、`||`、`;`、管道、重定向、
 * 命令替换、反引号、换行、未闭合引号一律拒绝（词法层由 splitCommandSegments 兜底）。
 * cd 只换执行目录，与调用方直接传 cwd 参数等价，而后者本就走家族自动放行——
 * 这里让 cd 写法获得同等待遇，不放宽任何「执行什么」的判定。
 */
function stripLeadingCd(command) {
    const text = commandText(command);
    if (!text.includes('&&') || /[|;]/.test(text)) return null;
    const split = splitCommandSegments(text, {keepCdCompound: true});
    if (!split || !split.compound || split.segments.length !== 2) return null;
    const head = commandTokens(split.segments[0]);
    if (!head || head.length !== 2) return null;
    const exe = commandExecutable(head[0]);
    if (exe !== 'cd' && exe !== 'chdir') return null;
    return split.segments[1];
}

/**
 * 返回同类命令签名（如 `git diff`、`npm run build`、`pwd`）；不满足白名单或含复合语法时返回 null。
 */
export function commandFamilySignature(command) {
    let tokens = commandTokens(command);
    if (!tokens) {
        const rest = stripLeadingCd(command);
        if (rest == null) return null;
        tokens = commandTokens(rest);
    }
    if (!tokens) return null;
    const exe = commandExecutable(tokens[0]);
    if (!exe || INTERPRETER_EXES.has(exe)) return null;
    if (PLAIN_SAFE_EXES.has(exe)) return {signature: exe, exe, sub: ''};
    if (tokens.length < 2) return null;
    const spec = FAMILY_SPECS[exe];
    if (!spec) return null;
    if (tokens[1].startsWith('-')) return null;
    const sub = tokens[1].toLowerCase();
    if (!spec.subcommands.has(sub)) return null;
    let signature = exe + ' ' + sub;
    let argIndex = 2;
    if (spec.scriptSubcommand === sub) {
        const script = tokens[2];
        if (!script || script.startsWith('-')) return null;
        signature += ' ' + script.toLowerCase();
        argIndex = 3;
    }
    for (let i = argIndex; i < tokens.length; i += 1) {
        if (argBlocked(tokens[i], spec.blockedArgs)) return null;
    }
    return {signature, exe, sub};
}

/**
 * 在会话规则中查找命中项；exact 与 family 都要求 cwdKey 相同。
 */
export function matchCommandRule(rules, command, cwdKey) {
    if (!Array.isArray(rules) || !rules.length) return null;
    const text = commandText(command);
    for (const rule of rules) {
        if (!rule || rule.cwdKey !== cwdKey) continue;
        if (rule.mode === 'exact' && rule.command === text) return rule;
    }
    const family = commandFamilySignature(text);
    if (!family) return null;
    for (const rule of rules) {
        if (!rule || rule.cwdKey !== cwdKey) continue;
        if (rule.mode === 'family' && rule.signature === family.signature) return rule;
    }
    return null;
}

// ---------- 只读 / 危险命令静态分析（对齐 zcode 的 argv 级策略） ----------

/**
 * 把命令按顶层 `&&`、`||`、`;`、`|`、换行族拆成片段。出现重定向、命令替换、反引号
 * 或未闭合引号时返回 null：这些一律不自动放行。
 *
 * 换行族包含 `\n`、单独 `\r`、`\r\n`、NEL(U+0085)、LS(U+2028)、PS(U+2029)：
 * PowerShell 词法把后四者都当行终止符。此前遇 `\r`/`\n` 直接 return null，等于
 * **任何多行命令都跳过整套段级检测**、只跑 4 条原文兜底——`format C: /y`、
 * `shutdown /s`、`Remove-Item -Recurse` 因此整体漏标（红队 V-01 / F-9）。
 * 能切段就必须切段：段级规则的覆盖远好于原文兜底。
 */
export function splitCommandSegments(command, options) {
    const text = commandText(command);
    if (!text) return null;
    const segments = [];
    let quote = '';
    let start = 0;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (quote) {
            if (ch === quote) quote = '';
            i += 1;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            i += 1;
            continue;
        }
        if (ch === '`') return null;
        if (ch === '$' && (text[i + 1] === '(' || text[i + 1] === '{')) return null;
        if (ch === '>' || ch === '<') return null;
        let operatorLength = 0;
        if (ch === '\r' && text[i + 1] === '\n') operatorLength = 2;
        else if (ch === '\r' || ch === '\n' || ch === '\u0085' || ch === '\u2028' || ch === '\u2029') operatorLength = 1;
        else if (ch === '&' && text[i + 1] === '&') operatorLength = 2;
        else if (ch === '|' && text[i + 1] === '|') operatorLength = 2;
        else if (ch === '|' || ch === ';') operatorLength = 1;
        else if (ch === '&') return null;
        if (!operatorLength) {
            i += 1;
            continue;
        }
        const segment = text.slice(start, i).trim();
        if (!segment) return null;
        segments.push(segment);
        i += operatorLength;
        start = i;
    }
    if (quote) return null;
    const last = text.slice(start).trim();
    if (!last) return null;
    segments.push(last);
    if (segments.length > 1 && !(options && options.keepCdCompound)) {
        // cd 会改变后续片段的执行目录，复合命令里不自动放行。
        for (const segment of segments) {
            const tokens = commandTokens(segment);
            const exe = tokens ? commandExecutable(tokens[0]) : '';
            if (exe === 'cd' || exe === 'chdir') return null;
        }
    }
    return {segments, compound: segments.length > 1};
}

function shortFlagSet(args) {
    const flags = new Set();
    for (const arg of args) {
        const value = String(arg || '').toLowerCase();
        if (/^-[a-z]+$/.test(value)) {
            for (const ch of value.slice(1)) flags.add(ch);
        } else if (value.startsWith('--')) {
            // --long=value 拆出 --long 前缀：判定处用 flags.has('--force-with-lease')
            // 精确匹配时，`--force-with-lease=origin/main` 必须命中，否则强制推送漏判。
            const eq = value.indexOf('=');
            flags.add(eq > 0 ? value.slice(0, eq) : value);
        }
    }
    return flags;
}

function argsHitPrefixes(args, prefixes) {
    return args.some((arg) => {
        const value = String(arg || '').toLowerCase();
        return prefixes.some((prefix) => value === prefix || value.startsWith(prefix));
    });
}

// git 全局危险旗标命中判定：长选项支持 --flag=value（`--git-dir=/x`），
// 短选项支持粘连值（`-C/other`、`-cfoo=bar`）。判定处统一用本函数，
// 避免 `-C/other` 因 `arg.startsWith('-C=')` 为假而漏判。
function gitGlobalFlagHit(arg, flag) {
    const value = String(arg || '').toLowerCase();
    if (flag.length === 2 && flag.startsWith('-')) {
        // 短选项（-C / -c）：`-C`、`-C/path`、`-Cpath` 都命中
        return value === flag || value.startsWith(flag);
    }
    return value === flag || value.startsWith(flag + '=');
}

function gitSegmentIsReadOnly(tokens) {
    const args = tokens.slice(1);
    if (args.some((arg) => GIT_GLOBAL_DANGEROUS.some((flag) => gitGlobalFlagHit(arg, flag)))) {
        return false;
    }
    if (args.some((arg) => arg.startsWith('--output') || arg === '--ext-diff' || arg === '--textconv')) return false;
    const sub = args.find((arg) => !arg.startsWith('-'));
    if (!sub || !GIT_READONLY_SUBCOMMANDS.has(sub)) return false;
    const rest = args.slice(args.indexOf(sub) + 1);
    const positional = rest.filter((arg) => !arg.startsWith('-'));
    const flags = rest.filter((arg) => arg.startsWith('-'));
    const flagSet = shortFlagSet(flags);
    const listFlag = flagSet.has('l') || flagSet.has('--list');
    switch (sub) {
        case 'reflog':
            return !positional.length || positional[0] === 'show';
        case 'stash':
            return !positional.length || ['list', 'show'].includes(positional[0]);
        case 'worktree':
            return !positional.length || positional[0] === 'list';
        case 'submodule':
            return !positional.length || ['status', 'summary'].includes(positional[0]);
        case 'notes':
            return !positional.length || ['list', 'show'].includes(positional[0]);
        case 'branch':
            // branch NAME 会创建分支；只有显式 --list 才允许带操作数。
            if (positional.length && !listFlag) return false;
            return flags.every((flag) => [
                '-l', '--list', '-a', '--all', '-r', '--remotes', '-v', '-vv',
                '--verbose', '--show-current', '--no-color', '--color', '--column', '--no-column',
            ].includes(flag));
        case 'tag':
            if (positional.length && !listFlag) return false;
            return flags.every((flag) => [
                '-l', '--list', '-n', '--color', '--no-color', '--column', '--no-column',
            ].includes(flag) || /^-n\d+$/.test(flag));
        case 'remote':
            return (!positional.length || ['show', 'get-url'].includes(positional[0])) &&
                flags.every((flag) => ['-v', '--verbose'].includes(flag));
        case 'config':
            return ['--get', '--get-all', '--get-regexp', '-l', '--list'].some((flag) => args.includes(flag));
        default:
            return true;
    }
}

// ---------- Git 快捷操作一次性窄豁免（2026-11-16） ----------
// auto 档下点「Git 快捷操作」后，AI 经 run_command 执行常规 git 写命令时不再逐条弹审批卡。
// 令牌由 ai-panel.js 管理（点快捷操作时打、15 分钟过期、按会话 + git 根限定），这里只做
// 命令本身的静态判定：安全写子命令放行，危险变体 / 复合命令 / 全局旗标 / cwd 越界一律不放行。
// 危险检测（analyzeDangerousCommand）与项目规则仍先行，本函数只在它们都通过后生效。
// 只读子命令（status/diff/log 等）本就能被 analyzeReadOnlyCommand 放行，无需列进豁免集。
export const GIT_FLOW_SAFE_SUBCOMMANDS = new Set([
    'add', 'commit', 'push', 'pull', 'merge', 'fetch', 'stash',
]);

// 指定远端执行程序的旗标：本地 / file:// 远端下等于拉起任意程序，分类器看不出风险，
// 与解释器内联代码同属「argv 级分析盲区」——危险检测与豁免检查都拦。
const GIT_EXEC_PROGRAM_FLAGS = ['--exec', '--upload-pack', '--receive-pack'];

function normPathKey(value) {
    return String(value == null ? '' : value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Git 快捷操作流程内的命令是否可免审批（仅静态判定，不查令牌状态）。
 * 返回 true 表示：单条简单 git 命令 + 子命令在安全集 + 无危险旗标 + cwd 在 git 根内。
 * 复合命令（&& / ; / | / 重定向 / 命令替换）一律不放行，由原审批链逐段处理。
 */
export function gitFlowSafeCommand(command, gitRoot, cwd) {
    const split = splitCommandSegments(command);
    if (!split || split.compound) return false;
    const tokens = commandTokens(command);
    if (!tokens || !tokens.length) return false;
    if (commandExecutable(tokens[0]) !== 'git') return false;
    const args = tokens.slice(1);
    if (args.some((arg) => GIT_GLOBAL_DANGEROUS.some((flag) => gitGlobalFlagHit(arg, flag)))) return false;
    if (args.some((arg) => argBlocked(arg, GIT_EXEC_PROGRAM_FLAGS))) return false;
    const sub = args.find((arg) => !arg.startsWith('-'));
    if (!sub || !GIT_FLOW_SAFE_SUBCOMMANDS.has(sub)) return false;
    // cwd 必须在 git 根内（子目录允许，git 会向上找仓库）
    const root = normPathKey(gitRoot);
    const dir = normPathKey(cwd);
    if (!root || !dir || (dir !== root && !dir.startsWith(root + '/'))) return false;
    // AI 隔离 worktree（.cadt/worktree/）内令牌豁免失效：cwd 在隔离区时 git 命令作用于
    // 草稿分支，「Git 快捷操作」的静默放行会误导用户以为在改主根——回退逐条审批。
    const relInRoot = dir.slice(root.length + 1);
    if (relInRoot === '.cadt/worktree' || relInRoot.startsWith('.cadt/worktree/')) return false;
    const rest = args.slice(args.indexOf(sub) + 1);
    const positional = rest.filter((arg) => !arg.startsWith('-'));
    const flags = shortFlagSet(rest);
    // 跳过 pre-commit / pre-push 等钩子的变体不享受豁免（未经用户许可不得 --no-verify）
    if (flags.has('--no-verify')) return false;
    switch (sub) {
        case 'push':
            // 强制 / 删除远端分支：危险检测已拦，这里双保险；`+ref` 与 `:ref` 都是 refspec 写法
            if (flags.has('f') || flags.has('--force') || flags.has('--force-with-lease') ||
                flags.has('d') || flags.has('--delete') || flags.has('--mirror')) return false;
            if (positional.some((arg) => arg.startsWith('+') || arg.startsWith(':'))) return false;
            return true;
        case 'stash':
            // 只放行流程用到的 create/pop/push/apply/save 与只读 list/show；drop/clear/branch 不放行
            if (!positional.length) return true;
            if (!['create', 'pop', 'push', 'apply', 'save', 'list', 'show'].includes(positional[0])) return false;
            // push / save 的 -u / --include-untracked 会把未跟踪文件也收进 stash（流程没用到）
            if ((positional[0] === 'push' || positional[0] === 'save') &&
                (flags.has('u') || flags.has('--include-untracked') || flags.has('a') || flags.has('--all'))) return false;
            return true;
        case 'commit':
            // --amend 改写历史提交；-a/--all 自动暂存全部已跟踪修改，与提示词「逐文件 git add」冲突；
            // -n 是 --no-verify 的短写法。
            if (flags.has('--amend') || flags.has('n')) return false;
            if (flags.has('a') || flags.has('--all')) return false;
            return true;
        case 'add':
            // 提示词明确「不要 git add -A / git add .」：豁免与提示词约束对齐
            if (flags.has('a') || flags.has('--all') || flags.has('u') || flags.has('--update')) return false;
            return !positional.some((arg) => arg === '.' || arg === './' || arg === '..' || arg === '../');
        case 'pull':
            // 流程固定 --no-rebase；--rebase 会改写本地提交形状，不放行
            return !(flags.has('r') || flags.has('--rebase'));
        case 'merge':
            // --abort 放弃进行中的合并，不放行
            return !flags.has('--abort');
        default:
            return true;
    }
}

function segmentIsReadOnly(tokens) {
    const exe = commandExecutable(tokens[0]);
    if (!exe) return false;
    if (exe === 'git') return gitSegmentIsReadOnly(tokens);
    if (!READONLY_ANY_ARGS.has(exe)) return false;
    const args = tokens.slice(1);
    const blocked = READONLY_BLOCKED_ARGS[exe];
    if (blocked && argsHitPrefixes(args, blocked)) return false;
    if (exe === 'hostname' || exe === 'date') {
        // hostname NAME 设置主机名，date 带操作数会设置系统时间。
        if (args.some((arg) => !arg.startsWith('-'))) return false;
    }
    if (exe === 'uniq') {
        // uniq in out 会写文件。
        if (args.filter((arg) => !arg.startsWith('-')).length > 1) return false;
    }
    return true;
}

/**
 * 单条命令（可含管道 / && / ; 分段）是否整体只读。只读即自动审批档直接放行。
 */
export function analyzeReadOnlyCommand(command) {
    const split = splitCommandSegments(command);
    if (!split) return {readOnly: false, reason: 'complex'};
    for (const segment of split.segments) {
        const tokens = commandTokens(segment);
        if (!tokens || !tokens.length) return {readOnly: false, reason: 'parse'};
        if (!segmentIsReadOnly(tokens)) return {readOnly: false, reason: 'command', segment};
    }
    return {readOnly: true};
}

// 解释器 + 内联代码（node -e / python -c / bash -c / powershell -Command …）：
// 代码作为 argv 传入，绕过了 argv 级的只读与危险分析（bash -c "rm -rf /" 在分段里看不到 rm），
// 端侧线性模型对这类也给极低分（实测 node -e 在 0.03–0.06，低于 0.15 阈值直接放行）。
// 因此一律走危险规则做单次确认：不经分类器、不长期放行。
// 短标志按字母判定（bash -lc 同样命中），长选项与子命令按整词判定。
// cmd /c 刻意不在清单内：它常被工具链用来包一层单命令，拦了误伤远大于收益。
const INLINE_CODE_SHORT_FLAGS = {
    node: ['e', 'p'],
    nodejs: ['e', 'p'],
    bun: ['e'],
    python: ['c'],
    python2: ['c'],
    python3: ['c'],
    py: ['c'],
    perl: ['e'],
    ruby: ['e'],
    php: ['r'],
    bash: ['c'],
    sh: ['c'],
    zsh: ['c'],
    dash: ['c'],
    ksh: ['c'],
    fish: ['c'],
};

const INLINE_CODE_WORDS = {
    node: ['--eval', '--print'],
    nodejs: ['--eval', '--print'],
    bun: ['--eval'],
    deno: ['eval'],
};

// PowerShell 的长参数是单横线写法，不能按短选项拆字母（-command 会被拆出 c）。
const POWERSHELL_INLINE_WORDS = ['-c', '-command', '-encodedcommand', '-enc', '-ec'];

function isInterpreterInlineCode(exe, args, flags) {
    if (!exe) return false;
    if (exe === 'powershell' || exe === 'pwsh') {
        return args.some((arg) => POWERSHELL_INLINE_WORDS.includes(String(arg).toLowerCase()));
    }
    const words = INLINE_CODE_WORDS[exe];
    if (words && args.some((arg) => words.includes(String(arg).toLowerCase()))) return true;
    const letters = INLINE_CODE_SHORT_FLAGS[exe];
    if (!letters) return false;
    return letters.some((ch) => flags.has(ch));
}

export const DANGER_LABELS = {
    'rm-recursive-force': '递归强制删除文件',
    'rmdir-recursive': '递归删除目录',
    'del-force': '强制/递归删除文件',
    'disk-destructive': '磁盘或分区破坏性操作',
    'shutdown': '关机 / 重启',
    'download-exec': '下载并执行外部代码',
    'persistence': '创建计划任务 / 服务持久化',
    'security-disable': '关闭系统安全防护',
    'forensics-clear': '清除日志 / 快照等痕迹',
    'credential-dump': '转储进程内存凭据',
    'registry-destructive': '删除注册表键值',
    'fs-wipe': '覆写清零磁盘数据',
    'privilege-grant': '添加用户 / 提权到管理员组',
    'find-delete': '批量删除文件（find -delete）',
    'boot-tamper': '篡改引导配置（bcdedit / bootrec）',
    'git-reset-hard': '丢弃全部未提交修改（reset --hard）',
    'git-clean-force': '强制清理未跟踪文件（clean -f）',
    'git-push-force': '强制推送或删除远端分支',
    'git-exec-program': '指定远端执行程序（--receive-pack / --upload-pack / --exec）',
    'git-discard-worktree': '丢弃工作区修改（checkout / restore）',
    'git-stash-drop': '清除 stash 记录',
    'git-worktree-force': '强制删除 worktree',
    'git-branch-force-delete': '强制删除分支',
    'git-update-ref-delete': '删除 Git 引用（update-ref -d）',
    'robocopy-mirror': '镜像目录（会删除目标端多余文件）',
    'interpreter-inline-code': '解释器内联代码执行（-e / -c / -Command）',
    'ps-file-delete': '删除 / 移动 / 改名文件（PowerShell）',
    'ps-file-write': '写入或覆盖文件（PowerShell）',
    'ps-code-exec': '动态执行代码 / 启动或终止进程（PowerShell）',
    'ps-persistence': '修改服务 / 计划任务 / 注册表 / 账户（PowerShell）',
    'ps-reflection': '反射调用 .NET 类型（PowerShell）',
    'secret-env-exposure': '环境变量值泄漏（软件存储的密钥类变量）',
};

// 原文级危险模式：所有命令都扫，不依赖分段成功（红队 F3）。
// `curl … | sh` 会被 splitCommandSegments 切成两段，段级检测互相看不见管道关系；
// 重定向 / 命令替换无法分段时更只能靠这里。命中即单次确认，误拦代价低（点一次允许）。
const RAW_DANGER_RULES = [
    [/\bmsiexec\b[^\n]*\/i\s+https?:/i, 'download-exec'],
    [/\bmshta\b\s+(https?:|\\\\)/i, 'download-exec'],
    [/\bregsvr32\b[^\n]*\/i\s*:?\s*https?:/i, 'download-exec'],
    [/\bschtasks\b[^\n]*\/create\b/i, 'persistence'],
    [/\bsc(\.exe)?\s+config\b[^\n]*binpath\b/i, 'persistence'],
    [/\bnet\s+(localgroup|user)\b[^\n]*\/add\b/i, 'privilege-grant'],
    [/\breg(\.exe)?\s+delete\b/i, 'registry-destructive'],
    [/\bregedit\b[^\n]*\/(import|restore)\b/i, 'registry-destructive'],
    [/\bwevtutil\b\s+cl\b/i, 'forensics-clear'],
    [/\bvssadmin\b[^\n]*delete\b/i, 'forensics-clear'],
    [/\bfsutil\b[^\n]*deletejournal\b/i, 'forensics-clear'],
    [/\bcipher\b\s+\/w:/i, 'fs-wipe'],
    [/\bset-mppreference\b[^\n]*-disablerealtimemonitoring\b/i, 'security-disable'],
    [/\b(add|set)-mppreference\b[^\n]*-exclusion(path|process|extension|ipaddress)?\b/i, 'security-disable'],
    [/\brundll32\b[^\n]*comsvcs\.dll[^\n]*minidump\b/i, 'credential-dump'],
    [/\bfind\s+[^;&|\n]*-delete\b/i, 'find-delete'],
];

// 下载器 / 执行壳（管道落地检测用）
const DOWNLOAD_EXES = new Set(['curl', 'wget', 'certutil', 'bitsadmin', 'iwr', 'invoke-webrequest', 'invoke-restmethod', 'ftp', 'tftp']);
const SHELL_EXES = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'fish', 'powershell', 'pwsh', 'python', 'python3']);
// 管道落地正则：用于命令替换子串（引号内的 | 让分段器看不见跨段关系）
const RAW_PIPE_EXEC = /\b(curl|wget|certutil|bitsadmin|iwr|invoke-webrequest|invoke-restmethod|ftp|tftp)\b[^|;&\n]*\|\s*(sh|bash|zsh|ksh|dash|fish|powershell|pwsh|python3?)\b/i;

// 真管道 / 顺序链的下载执行：分段成功时 `curl … | sh` 的 | 已把下载器与执行壳
// 切成相邻段（红队 F3：段级检测互相看不见管道关系）——按段间首词关系检测。
// && 顺序链同样命中（下载后执行语义一致）。
function pipelineDownloadExec(segments) {
    for (let i = 0; i + 1 < segments.length; i += 1) {
        const a = commandTokens(segments[i]);
        const b = commandTokens(segments[i + 1]);
        if (!a || !b) continue;
        if (DOWNLOAD_EXES.has(resolveExe(a).exe) && SHELL_EXES.has(resolveExe(b).exe)) return true;
    }
    return false;
}

function gitSegmentDangerRule(args) {
    // 指定远端执行程序的旗标：等效任意程序执行，分类器不可见，一律单次确认
    if (args.some((arg) => argBlocked(arg, GIT_EXEC_PROGRAM_FLAGS))) return 'git-exec-program';
    const sub = args.find((arg) => !arg.startsWith('-'));
    if (!sub) return '';
    const rest = args.slice(args.indexOf(sub) + 1);
    const positional = rest.filter((arg) => !arg.startsWith('-'));
    const flags = shortFlagSet(rest);
    switch (sub) {
        case 'reset':
            return rest.includes('--hard') ? 'git-reset-hard' : '';
        case 'clean':
            return flags.has('f') || flags.has('--force') ? 'git-clean-force' : '';
        case 'push': {
            if (flags.has('f') || flags.has('--force') || flags.has('--mirror')) return 'git-push-force';
            if (flags.has('d') || flags.has('--delete')) return 'git-push-force';
            if (flags.has('--force-with-lease')) return 'git-push-force';
            // `+ref` 强制推送、`:ref` 删除远端分支：与 -f / -d 等价
            if (positional.some((arg) => arg.startsWith('+') || arg.startsWith(':'))) return 'git-push-force';
            return '';
        }
        case 'checkout':
            if (flags.has('f') || flags.has('--force')) return 'git-discard-worktree';
            if (rest.includes('--') || positional.includes('.')) return 'git-discard-worktree';
            return '';
        case 'restore': {
            const stagedOnly = (flags.has('s') || flags.has('--staged')) && !flags.has('w') && !flags.has('--worktree');
            return stagedOnly ? '' : 'git-discard-worktree';
        }
        case 'stash':
            return positional[0] === 'clear' || positional[0] === 'drop' ? 'git-stash-drop' : '';
        case 'worktree':
            return positional[0] === 'remove' && (flags.has('f') || flags.has('--force')) ? 'git-worktree-force' : '';
        case 'branch':
            return flags.has('d') || flags.has('--delete') ? 'git-branch-force-delete' : '';
        case 'update-ref':
            return flags.has('d') ? 'git-update-ref-delete' : '';
        default:
            return '';
    }
}

// 包装器（nice -n 5 bash -c …）带参时 resolveExe 穿不干净：按「段内任一 token 是
// 解释器且后面跟内联标志」兜底扫描。引号内容是单个 token（commandTokens 引号成组），
// `git commit -m "node -e demo"` 这类示例文本不会误中。
function segmentHasInlineCode(tokens) {
    for (let i = 0; i < tokens.length - 1; i += 1) {
        const exe = commandExecutable(tokens[i]);
        if (!INTERPRETER_EXES.has(exe)) continue;
        const rest = tokens.slice(i + 1);
        if (isInterpreterInlineCode(exe, rest, shortFlagSet(rest))) return true;
    }
    return false;
}

function segmentDangerRule(tokens) {
    // 穿透前置赋值 / env / nice 等包装（红队 F3：env python3 -c 曾全档放行）
    const resolved = resolveExe(tokens);
    const exe = resolved.exe;
    const args = tokens.slice(resolved.index + 1);
    const lowerArgs = args.map((arg) => String(arg).toLowerCase());
    const flags = shortFlagSet(args);
    if (isInterpreterInlineCode(exe, args, flags) || segmentHasInlineCode(tokens)) return 'interpreter-inline-code';
    if (exe === 'rm') {
        const recursive = flags.has('r') || flags.has('--recursive');
        const force = flags.has('f') || flags.has('--force');
        return recursive && force ? 'rm-recursive-force' : '';
    }
    if (exe === 'rmdir' || exe === 'rd') {
        return lowerArgs.includes('/s') ? 'rmdir-recursive' : '';
    }
    if (exe === 'del' || exe === 'erase') {
        return lowerArgs.includes('/s') ? 'del-force' : '';
    }
    if (exe === 'format' || exe === 'diskpart' || exe === 'dd' || exe.startsWith('mkfs')
        // PowerShell 磁盘 cmdlet（红队 F3：Format-Volume 等带连字符，不在经典清单里）
        || exe === 'format-volume' || exe === 'clear-disk' || exe === 'remove-partition' || exe === 'initialize-disk') {
        return 'disk-destructive';
    }
    if (exe === 'shutdown') return 'shutdown';
    if (exe === 'robocopy') {
        return lowerArgs.includes('/mir') ? 'robocopy-mirror' : '';
    }
    if (exe === 'remove-item') {
        // PowerShell 长参数是单横线写法，不能按短选项拆字母。
        const recurse = lowerArgs.includes('-recurse') || lowerArgs.includes('-r');
        const force = lowerArgs.includes('-force') || lowerArgs.includes('-fo');
        return recurse && force ? 'rm-recursive-force' : '';
    }
    if (exe === 'set-mppreference' || exe === 'add-mppreference') return 'security-disable';
    if (exe === 'schtasks') return 'persistence';
    if (exe === 'wevtutil' && lowerArgs.includes('cl')) return 'forensics-clear';
    if (exe === 'vssadmin' && lowerArgs.includes('delete')) return 'forensics-clear';
    if (exe === 'cipher' && lowerArgs.some((arg) => arg.startsWith('/w'))) return 'fs-wipe';
    if (exe === 'find' && lowerArgs.includes('-delete')) return 'find-delete';
    if (exe === 'git') {
        const sub = args.find((arg) => !arg.startsWith('-'));
        if (!sub) return '';
        return gitSegmentDangerRule(args.slice(args.indexOf(sub)));
    }
    return '';
}

/**
 * 危险命令检测：命中即要求单次确认，任何授权都不能长期放行。
 * 含 cd 的复合命令仍逐段检测；完全无法分段（重定向 / 命令替换）时退回保守正则扫描。
 */
export function analyzeDangerousCommand(command) {
    const split = splitCommandSegments(command, {keepCdCompound: true});
    if (split) {
        for (const segment of split.segments) {
            const tokens = commandTokens(segment);
            if (!tokens || !tokens.length) continue;
            const ruleId = segmentDangerRule(tokens);
            if (ruleId) return {dangerous: true, ruleId, label: DANGER_LABELS[ruleId] || ruleId, segment};
        }
    }
    // 真管道 / 顺序链的下载执行按段间关系检测（见 pipelineDownloadExec）
    if (split && pipelineDownloadExec(split.segments)) {
        return {dangerous: true, ruleId: 'download-exec', label: DANGER_LABELS['download-exec'], segment: commandText(command)};
    }
    // 原文级模式对所有命令都扫（红队 F3）：分段成功时 curl … | sh 也会被切成
    // 两个互不可见的段；重定向 / 命令替换无法分段时更只能靠这里。
    // 纯 echo/printf 回显段跳过——打印示例代码/文档是常见操作（对照实测曾误拦
    // echo "curl -s … | sh"）；含命令替换的段不跳，替换内容会真执行。
    const scanSegments = split ? split.segments : [commandText(command)];
    for (const segment of scanSegments) {
        if (split && !/[$(`]/.test(segment)) {
            const tokens = commandTokens(segment);
            const exe = tokens ? resolveExe(tokens).exe : '';
            if (exe === 'echo' || exe === 'printf') continue;
        }
        // 命令替换内容真执行（双引号内 $( 同样）：对 $( 起的子串扫管道落地——
        // 引号内的 | 让分段器看不见跨段关系（实测 echo "$(curl x | sh)" 曾漏标）
        const sub = segment.includes('$(') ? segment.slice(segment.indexOf('$(')) : '';
        if (sub && RAW_PIPE_EXEC.test(sub)) {
            return {dangerous: true, ruleId: 'download-exec', label: DANGER_LABELS['download-exec'], segment};
        }
        for (const [pattern, ruleId] of RAW_DANGER_RULES) {
            if (pattern.test(segment)) return {dangerous: true, ruleId, label: DANGER_LABELS[ruleId] || ruleId, segment};
        }
    }
    const text = commandText(command);
    if (!split) {
        // 分段失败时不能让危险命令漏标：对最常见的破坏操作做一次原文扫描。
        // 含命令替换的管道落地（echo "$(curl x | sh)"）：替换内容真执行，全文扫描
        const pipeExec = /\b(curl|wget|certutil|bitsadmin|iwr|invoke-webrequest|invoke-restmethod|ftp|tftp)\b[^|;&\n]*\|\s*(sh|bash|zsh|ksh|dash|fish|powershell|pwsh|python3?)\b/i;
        if (pipeExec.test(text)) {
            return {dangerous: true, ruleId: 'download-exec', label: DANGER_LABELS['download-exec'], segment: text};
        }
        // 原文扫描也要跑完整规则表：分段失败不代表规则不适用（红队 F-9：
        // `echo hi > /dev/null && format C: /y` 因 `>` 无法分段，只跑下面 4 条就漏了）
        for (const [pattern, ruleId] of RAW_DANGER_RULES) {
            if (pattern.test(text)) return {dangerous: true, ruleId, label: DANGER_LABELS[ruleId] || ruleId, segment: text};
        }
        const rawRules = [
            [/\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive[^\n]*--force|--force[^\n]*--recursive)\b/i, 'rm-recursive-force'],
            // 分开写的短标志（rm -r -f / rm -f -r）：上面的合并形态正则抓不到，兜底扫描必须补
            [/\brm\b(?=[^\n]*\s(?:--recursive|-[a-z]*r)(?:\s|$))(?=[^\n]*\s(?:--force|-[a-z]*f)(?:\s|$))/i, 'rm-recursive-force'],
            [/\bgit\s+reset\s+[^\n]*--hard\b/i, 'git-reset-hard'],
            [/\bgit\s+clean\s+[^\n]*(?:-[a-z]*f|--force)\b/i, 'git-clean-force'],
            [/\bgit\s+push\s+[^\n]*(?:--force|--mirror|--delete|\s-f(?:\s|$)|\+[^\s]+:)/i, 'git-push-force'],
            // 跨平台破坏族：这些在段级规则里有，但分段失败时曾整体漏标（format / shutdown /
            // Remove-Item / del / dd 全部 0 命中，见红队 V-01 与 F-9 的对照表）
            [/\bformat(\.com)?\s+(?:[a-z]:|\/dev\/|\\)/i, 'disk-destructive'],
            [/\b(shutdown|reboot)\b[^\n]*?(?:\/s\b|\/r\b|\/p\b|\/h\b|-[srph]\b)/i, 'shutdown'],
            [/\b(remove-item|ri)\b[^\n]*-recurse\b/i, 'rm-recursive-force'],
            [/\b(del|erase)\b[^\n]*\/[fsq]\b/i, 'del-force'],
            [/\b(rmdir|rd)\b[^\n]*\/s\b/i, 'rmdir-recursive'],
            [/\bdd\b[^\n]*\bof=\/dev\//i, 'disk-destructive'],
            [/\b(bcdedit|bootrec)\b[^\n]*\//i, 'boot-tamper'],
            [/\bdiskpart\b[^\n]*\bclean\b/i, 'disk-destructive'],
        ];
        for (const [pattern, ruleId] of rawRules) {
            if (pattern.test(text)) return {dangerous: true, ruleId, label: DANGER_LABELS[ruleId] || ruleId, segment: text};
        }
    }
    return {dangerous: false, ruleId: '', label: ''};
}

// ---------- 显式 shell（run_command / background_command 的 shell 入参） ----------
//
// 指定 shell 后，command 正文是那个 shell 的脚本语言，argv 级的只读 / 危险分析看不见内容
// （与「解释器 + 内联代码」同理，见 isInterpreterInlineCode）。分三层判定：
//
//   1) 本模块的 psScriptDanger：**全文**扫已知破坏特征（含 PowerShell 别名），命中即单次确认，
//      不问分类器。这一层要确定性——误报只多一次点击，漏报是事故。
//   2) 端侧分类器：只拦不放（训练语料里 PowerShell 安全样本极薄、别名又追不全，
//      见 ai-panel.js 的 shellPolicy.script 分支）。
//   3) AI 分类器：真正决定「只读脚本能不能免点」，它认识 ri / gci / sc 这些别名。
//
// 除 gitbash 外一律按脚本处理：不套会话 / 命令族授权、不走 Git 快捷豁免，否则等于用新参数
// 开了一条降级审批的后门。缺省（空串）与 gitbash 不进这个分支：自动档就是本机 bash。
export const SHELL_VALUES = ['gitbash', 'pwsh', 'powershell', 'cmd'];

// 语句起始位置（行首 / 空白 / 分号 / 管道 / 脚本块 / 子表达式之后）——避免子串误判
// （`-Recurse` 里的 rd、`Format-Table` 里的 format 都不能算破坏命令）。
const PS_STMT = '(^|[\\s;|{(&])';
// 末尾用 (?![\w.-]) 而不是 \b：`format` 不能匹配 `format-table`、`sc` 不能匹配 `sc.exe`
// （后者是服务控制器，单独列进持久化规则）、`reg` 不能匹配 `reg.exe`。
function psNames(names) {
    return new RegExp(PS_STMT + ' *(' + names.join('|') + ')(?![\\w.-])', 'i');
}

// 危险特征表：顺序即优先级，先命中先报（标签越具体越好）。
const PS_DANGER_RULES = [
    // 删除 / 移动 / 改名 / 清空内容（含 cmd 同名命令与 PowerShell 别名）
    [psNames(['remove-item', 'ri', 'rm', 'rmdir', 'rd', 'del', 'erase', 'move-item', 'mv', 'move',
        'rename-item', 'ren', 'clear-content', 'clc']), 'ps-file-delete'],
    // 写文件 / 覆盖内容（含别名 sc / ac / ni / si / sp / rp 与 cmd 同名 copy / mkdir）
    [psNames(['set-content', 'sc', 'add-content', 'ac', 'out-file', 'tee-object', 'export-csv', 'export-clixml',
        'new-item', 'ni', 'set-item', 'si', 'set-itemproperty', 'sp', 'new-itemproperty', 'remove-itemproperty', 'rp',
        'copy-item', 'copy', 'cpi', 'mkdir', 'md', 'start-transcript']), 'ps-file-write'],
    // 重定向写盘（> / >> / 2> / *>）：PowerShell 里 > 是重定向，不是比较运算
    [/[0-9*]?>>?/, 'ps-file-write'],
    // 下载落地到文件
    [/\s-outfile\b/i, 'download-exec'],
    // 动态执行 / 启动或终止进程
    [psNames(['invoke-expression', 'iex', 'invoke-command', 'icm', 'start-process', 'saps', 'stop-process', 'kill',
        'spps', 'start-job', 'sajb', 'debug-process']), 'ps-code-exec'],
    // 调用操作符 & 与点源 .（两者都能执行任意命令）。`.` 后面必须跟空白再接路径
    // （`. .\profile.ps1`）——`.\src` 这种相对路径参数因此不会被误判。
    [new RegExp(PS_STMT + ' *&'), 'ps-code-exec'],
    [new RegExp(PS_STMT + ' *\\.\\s+[\\w$@\'"\\\\./]'), 'ps-code-exec'],
    // 服务 / 计划任务 / 注册表 / 账户 / 权限 / 日志
    [psNames(['set-service', 'new-service', 'remove-service', 'stop-service', 'start-service', 'restart-service',
        'suspend-service', 'resume-service', 'sc.exe', 'schtasks', 'register-scheduledtask',
        'new-scheduledtaskaction', 'unregister-scheduledtask', 'reg', 'reg.exe', 'wevtutil', 'vssadmin',
        'bcdedit', 'set-acl', 'takeown', 'icacls', 'new-localuser', 'remove-localuser',
        'add-localgroupmember', 'remove-localgroupmember']), 'ps-persistence'],
    [psNames(['clear-eventlog']), 'forensics-clear'],
    [/\bnet\s+(user|localgroup|share|stop|start|session)\b/i, 'persistence'],
    // 磁盘 / 分区（format 后不能跟 -，否则 Format-Table 会误报）
    [psNames(['format-volume', 'format', 'clear-disk', 'initialize-disk', 'remove-partition', 'new-partition',
        'resize-partition', 'set-disk', 'diskpart']), 'disk-destructive'],
    // 安全基线 / 关机 / 凭据
    [/\b(set|add)-mppreference\b|set-executionpolicy/i, 'security-disable'],
    [psNames(['stop-computer', 'restart-computer', 'shutdown']), 'shutdown'],
    [/mimikatz/i, 'credential-dump'],
    // 反射 / 动态类型：唯一能绕开 cmdlet 名检测的路径（[IO.File]::WriteAllText / Add-Type 编译执行）
    [/\[\s*(io|system|microsoft)\./i, 'ps-reflection'],
    [/\badd-type\b/i, 'ps-reflection'],
];

/**
 * PowerShell 脚本的危险特征扫描（**全文**，不依赖分段）：破坏力常藏在管道、脚本块与别名里
 * （`gci -r | ri -fo`、`Where-Object { Remove-Item $_ }`），只看段首会漏。
 * 未命中不代表安全，只表示「没有已知破坏特征」——由分类器复核。
 */
export function psScriptDanger(command) {
    const text = commandText(command);
    if (!text) return {dangerous: false, ruleId: '', label: ''};
    for (const [pattern, ruleId] of PS_DANGER_RULES) {
        if (pattern.test(text)) return {dangerous: true, ruleId, label: DANGER_LABELS[ruleId] || ruleId};
    }
    return {dangerous: false, ruleId: '', label: ''};
}

/**
 * 显式 shell 的审批口径。
 * - script=true：命令是目标 shell 的脚本，只读 / 会话 / 命令族 / Git 豁免全部作废；
 * - danger=null：没有已知破坏特征，交给分类器（端侧只拦不放，AI 分类器才可放行）。
 */
export function shellScriptPolicy(shell, command) {
    const value = String(shell || '').trim().toLowerCase();
    if (!value || value === 'gitbash') return {script: false, danger: null};
    // cmd 与 bash 同属 argv 风格，复用现有危险规则；PowerShell 走脚本特征扫描。
    const danger = value === 'cmd' ? analyzeDangerousCommand(command) : psScriptDanger(command);
    return {script: true, danger: danger.dangerous ? danger : null};
}

// ---------- 环境变量值泄漏（作者拍板口径，2026-11-16） ----------
// AI 系统上下文明确告知模型「要用某个变量就在命令里引用 $名称 / %名称%」，而 env_list
// 存的正是密钥类变量：`echo $OPENAI_API_KEY` 曾被只读白名单与 AI 分类器接连放行。
// 口径：只硬拦**软件 env_list 存储（启用中）的变量名**——命令引用这些名字或整表 dump
// 环境变量时强制人工审批：复用 dangerous 通道（decidePermission 在会话/项目授权与
// 分类器之前直接 ask singleUse，端侧与 AI 分类器均无权放行；完全权限档用户自担）。
// 没存在软件里的变量走正常流程，不拦。

function envVarNamePattern(name) {
    const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // bash $NAME / ${NAME}（含 ${NAME:-x}）· PowerShell $env:NAME / Env:NAME · cmd %NAME% / %NAME:…%
    return new RegExp(
        '\\$\\{?' + esc + '(?![A-Za-z0-9_])'
        + '|\\benv:\\s*' + esc + '(?![A-Za-z0-9_])'
        + '|%' + esc + '[:%]',
        'i');
}

function isEnvAssignment(arg) {
    return /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(arg));
}

// 受管名字是否出现在文本里（大小写不敏感的整词包含）。
function mentionsManagedName(text, names) {
    const lower = String(text || '').toLowerCase();
    return names.some((n) => lower.includes(n.toLowerCase()));
}

// 整表 dump：输出会包含全部环境变量值（名单非空时即命中）。
// 注意不能用 resolveExe：它把 env 当包装器跳过，裸 env（后面没有真命令）在这里
// 恰恰是 dump 本体。这里自带一个把 env 当终点的解析。
function envDumpSegmentRule(tokens, names) {
    let exe = '';
    let cmdIdx = -1;
    for (let i = 0; i < tokens.length; i += 1) {
        const token = String(tokens[i]);
        if (isEnvAssignment(token)) continue;
        const candidate = commandExecutable(token);
        if (candidate === 'nice' || candidate === 'nohup' || candidate === 'command' || candidate === 'time') continue;
        exe = candidate;
        cmdIdx = i;
        break;
    }
    if (!exe) return '';
    const args = tokens.slice(cmdIdx + 1);
    // env 后面还有真命令（非赋值、非旗标）→ 只是在包装执行，dump 判定交给该命令自身。
    const hasCommandArg = args.some((arg) => !isEnvAssignment(arg) && !String(arg).startsWith('-'));
    const hasManagedArg = args.some((arg) => names.some((n) => String(arg).toLowerCase() === n.toLowerCase()));
    if (exe === 'printenv') return (!args.length || hasManagedArg) ? 'printenv 打印环境变量值' : '';
    if (exe === 'env' && !hasCommandArg) return 'env 无目标命令时打印全部环境变量';
    // cmd 的 `set NAME` 会打印以 NAME 开头的全部变量值；bash 的同名形式无害，但分不清
    // 目标 shell，按保守处理：参数里出现受管名字（或无参）即判。
    if (exe === 'set' && (!args.length || args.some((arg) => !String(arg).startsWith('-') && hasManagedArg))) {
        return 'set 打印 shell 变量';
    }
    if (exe === 'export' && !args.length) return 'export 无参数打印全部环境变量';
    if ((exe === 'declare' || exe === 'typeset')
        && (shortFlagSet(args).has('p') || shortFlagSet(args).has('x'))) {
        return 'declare -p/-x 打印变量值';
    }
    // PowerShell Env: 驱动器整表（Get-ChildItem Env: / gci env: / ls env:…）；带具体名字的
    // 形态（Env:NAME）已由名字级模式覆盖。
    if (args.some((arg) => /^env:$/i.test(String(arg)))) return '列出全部环境变量（PowerShell Env: 驱动器）';
    return '';
}

/**
 * 环境变量值泄漏检测：managedNames 传软件 env_list 里启用中的变量名（只传名字）。
 * 返回形状与 analyzeDangerousCommand 一致，命中时直接并入 dangerous 通道。
 */
export function analyzeEnvValueExposure(command, managedNames) {
    const names = (Array.isArray(managedNames) ? managedNames : [])
        .map((n) => String(n == null ? '' : n).trim())
        .filter((n) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(n));
    const text = commandText(command);
    if (!text || !names.length) return {dangerous: false};
    // 名字级引用：整段原文扫，覆盖命令替换 / 重定向等无法分段的形态。
    // 所有模式都要求展开语法前缀（$ / env: / %），纯提及变量名不拦。
    for (const name of names) {
        if (envVarNamePattern(name).test(text)) {
            return {
                dangerous: true,
                ruleId: 'secret-env-exposure',
                label: '命令引用了软件存储的环境变量 ' + name + '（可能回显其值）',
                segment: text,
            };
        }
    }
    const split = splitCommandSegments(command, {keepCdCompound: true});
    if (split) {
        for (const segment of split.segments) {
            const tokens = commandTokens(segment);
            if (!tokens || !tokens.length) {
                // 分词失败的段（引号内的命令替换分段器看不见，如 echo "$(printenv KEY)"）：
                // 内容无法静态求值，出现受管名字或 env 读取即保守判泄漏。
                if (mentionsManagedName(segment, names) || /\bprintenv\b/i.test(segment) || /\$env:/i.test(segment)) {
                    return {
                        dangerous: true,
                        ruleId: 'secret-env-exposure',
                        label: '命令含无法解析的子命令且涉及软件存储的环境变量（可能回显其值）',
                        segment,
                    };
                }
                continue;
            }
            const reason = envDumpSegmentRule(tokens, names);
            if (reason) {
                return {
                    dangerous: true,
                    ruleId: 'secret-env-exposure',
                    label: reason + '，会输出软件存储的环境变量值',
                    segment,
                };
            }
        }
    } else if (mentionsManagedName(text, names) || /\bprintenv\b/i.test(text) || /\$env:/i.test(text) || /\benv:\s*$/im.test(text)) {
        // 无法分段（重定向 / 命令替换 / 多行）且涉及受管变量或环境读取：保守判定。
        return {
            dangerous: true,
            ruleId: 'secret-env-exposure',
            label: '命令无法静态解析且涉及软件存储的环境变量（可能输出其值）',
            segment: text,
        };
    }
    if (/\breg(\.exe)?\s+query\b[^\n]*\benvironment\b/i.test(text)) {
        return {
            dangerous: true,
            ruleId: 'secret-env-exposure',
            label: 'reg query Environment 会导出环境变量值',
            segment: text,
        };
    }
    return {dangerous: false};
}

/**
 * 从计划正文里提取可预授权的同类命令签名（代码块 / 行内代码优先），最多 6 条。
 */
export function collectCommandFamilies(text) {
    const source = String(text || '');
    const candidates = [];
    const codeRe = /```[\s\S]*?```|`[^`\n]+`/g;
    let match;
    while ((match = codeRe.exec(source))) {
        const block = match[0].replace(/^```[^\n]*\n?/, '').replace(/```$/, '');
        for (const line of block.split('\n')) candidates.push(line);
    }
    for (const line of source.split('\n')) candidates.push(line);
    const found = [];
    const seen = new Set();
    for (const raw of candidates) {
        const line = cleanCommandCandidateLine(raw);
        if (!line || line.length > 200) continue;
        const signature = commandFamilySignature(line);
        if (!signature || seen.has(signature.signature)) continue;
        seen.add(signature.signature);
        found.push(signature.signature);
        if (found.length >= 6) break;
    }
    return found;
}

// 清洗候选命令行：剥反引号、$ # > 提示符前缀、列表符与序号（正文扫描与申报命令共用）。
function cleanCommandCandidateLine(raw) {
    let line = String(raw == null ? '' : raw).trim();
    line = line.replace(/^`+/, '').replace(/`+$/, '').trim();
    line = line.replace(/^[$#>]\s*/, '').replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s*/, '').trim();
    return line;
}

/**
 * submit_plan 申报命令的归一与静态预判（批准卡展示 + 预授权形态判定）。
 * 预判只决定「能否预授权与卡片标注」，不改执行期判定链（dangerous 短路仍在会话规则之前）。
 * 返回条目：{command, purpose, mode, signature, dangerous, dangerLabel, reason}
 *   mode: 'family' 同类放行签名 / 'exact' 全文精确匹配 / null 不预授权（复合命令或危险命令）。
 * 最多 8 条；与 mergePlanGrantItems（批准卡合并）配套。
 */
export function normalizePlanDeclaredCommands(rawCommands) {
    const list = Array.isArray(rawCommands) ? rawCommands : [];
    const found = [];
    const seen = new Set();
    for (const raw of list) {
        if (found.length >= 8) break;
        // 容错：模型可能把条目写成纯字符串（schema 要求 {command}，但不为它多耗一轮重试）。
        const item = typeof raw === 'string' ? {command: raw} : (raw && typeof raw === 'object' ? raw : {});
        const cleaned = cleanCommandCandidateLine(item.command);
        if (!cleaned || cleaned.length > 200) continue;
        const entry = {
            command: cleaned,
            purpose: String(item.purpose == null ? '' : item.purpose).trim().replace(/\s+/g, ' ').slice(0, 80),
            mode: null,
            signature: '',
            dangerous: false,
            dangerLabel: '',
            reason: '',
        };
        const tokens = commandTokens(cleaned);
        const danger = analyzeDangerousCommand(cleaned);
        if (danger.dangerous) {
            // 危险命令（含复合命令里藏的危险段）只展示不预授权：执行期仍逐次单次确认。
            entry.dangerous = true;
            entry.dangerLabel = danger.label || danger.ruleId || '';
            entry.reason = '危险命令执行时仍需单次确认';
        } else {
            // 家族签名先判：带前置 cd 的白名单命令在执行期走自动放行，计划预授权
            // 用同一签名口径，避免卡片写「不预授权」而执行时却没弹卡的错位。
            const family = commandFamilySignature(cleaned);
            if (family) {
                entry.mode = 'family';
                entry.signature = family.signature;
            } else if (!tokens) {
                entry.reason = '含管道 / 重定向 / 命令串联，不做预授权';
            } else {
                // 白名单外的单条简单命令（含解释器跑脚本）退到 exact 全文匹配。
                entry.mode = 'exact';
            }
        }
        const key = entry.mode === 'family' ? 'f:' + entry.signature
            : entry.mode === 'exact' ? 'e:' + entry.command
                : 'x:' + entry.command;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(entry);
    }
    return found;
}

/**
 * 批准卡命令清单合并：AI 申报条目（权威，带 purpose）在前，正文扫描出的同类签名（兜底）补后，
 * 去重、总上限 10。扫描签名与申报的 family 签名相同则丢弃（申报优先）。
 */
export function mergePlanGrantItems(declared, scrapedSignatures) {
    const items = [];
    const seen = new Set();
    for (const entry of Array.isArray(declared) ? declared : []) {
        if (!entry || typeof entry !== 'object') continue;
        const key = entry.mode === 'family' ? 'f:' + entry.signature
            : entry.mode === 'exact' ? 'e:' + entry.command
                : 'x:' + entry.command;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(entry);
        if (items.length >= 10) return items;
    }
    for (const signature of Array.isArray(scrapedSignatures) ? scrapedSignatures : []) {
        if (!signature || seen.has('f:' + signature)) continue;
        seen.add('f:' + signature);
        items.push({command: signature, purpose: '', mode: 'family', signature, dangerous: false, dangerLabel: '', reason: ''});
        if (items.length >= 10) return items;
    }
    return items;
}
