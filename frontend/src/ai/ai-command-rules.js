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
 * 返回同类命令签名（如 `git diff`、`npm run build`、`pwd`）；不满足白名单或含复合语法时返回 null。
 */
export function commandFamilySignature(command) {
    const tokens = commandTokens(command);
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
 * 把命令按顶层 `&&`、`||`、`;`、`|` 拆成片段。出现重定向、命令替换、反引号、
 * 换行、单个 `&`（后台执行）或未闭合引号时返回 null：这些一律不自动放行。
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
        if (ch === '\n' || ch === '\r' || ch === '>' || ch === '<') return null;
        let operatorLength = 0;
        if (ch === '&' && text[i + 1] === '&') operatorLength = 2;
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
            flags.add(value);
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

function gitSegmentIsReadOnly(tokens) {
    const args = tokens.slice(1);
    if (args.some((arg) => GIT_GLOBAL_DANGEROUS.some((flag) => arg === flag || arg.startsWith(flag + '=')))) {
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

export const DANGER_LABELS = {
    'rm-recursive-force': '递归强制删除文件',
    'rmdir-recursive': '递归删除目录',
    'del-force': '强制/递归删除文件',
    'disk-destructive': '磁盘或分区破坏性操作',
    'shutdown': '关机 / 重启',
    'git-reset-hard': '丢弃全部未提交修改（reset --hard）',
    'git-clean-force': '强制清理未跟踪文件（clean -f）',
    'git-push-force': '强制推送或删除远端分支',
    'git-discard-worktree': '丢弃工作区修改（checkout / restore）',
    'git-stash-drop': '清除 stash 记录',
    'git-worktree-force': '强制删除 worktree',
    'git-branch-force-delete': '强制删除分支',
    'git-update-ref-delete': '删除 Git 引用（update-ref -d）',
    'robocopy-mirror': '镜像目录（会删除目标端多余文件）',
};

function gitSegmentDangerRule(args) {
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
            if (positional.some((arg) => arg.startsWith('+'))) return 'git-push-force';
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

function segmentDangerRule(tokens) {
    const exe = commandExecutable(tokens[0]);
    const args = tokens.slice(1);
    const lowerArgs = args.map((arg) => String(arg).toLowerCase());
    const flags = shortFlagSet(args);
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
    if (exe === 'format' || exe === 'diskpart' || exe === 'dd' || exe.startsWith('mkfs')) {
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
        return {dangerous: false, ruleId: '', label: ''};
    }
    // 分段失败时不能让危险命令漏标：对最常见的破坏操作做一次原文扫描。
    const text = commandText(command);
    const rawRules = [
        [/\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive[^\n]*--force|--force[^\n]*--recursive)\b/i, 'rm-recursive-force'],
        [/\bgit\s+reset\s+[^\n]*--hard\b/i, 'git-reset-hard'],
        [/\bgit\s+clean\s+[^\n]*(?:-[a-z]*f|--force)\b/i, 'git-clean-force'],
        [/\bgit\s+push\s+[^\n]*(?:--force|--mirror|--delete|\s-f(?:\s|$)|\+[^\s]+:)/i, 'git-push-force'],
    ];
    for (const [pattern, ruleId] of rawRules) {
        if (pattern.test(text)) return {dangerous: true, ruleId, label: DANGER_LABELS[ruleId] || ruleId, segment: text};
    }
    return {dangerous: false, ruleId: '', label: ''};
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
        let line = String(raw || '').trim();
        line = line.replace(/^`+/, '').replace(/`+$/, '').trim();
        line = line.replace(/^[$#>]\s*/, '').replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s*/, '').trim();
        if (!line || line.length > 200) continue;
        const signature = commandFamilySignature(line);
        if (!signature || seen.has(signature.signature)) continue;
        seen.add(signature.signature);
        found.push(signature.signature);
        if (found.length >= 6) break;
    }
    return found;
}
