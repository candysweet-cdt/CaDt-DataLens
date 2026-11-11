// 终端命令会话放行的纯函数：解析简单命令、生成同类签名、匹配规则。
// 只接受单条简单命令；出现管道、重定向、命令串联或子表达式时不做同类放行。
// 同类白名单只覆盖低风险开发命令；解释器与任意文件读取命令只能按“相同命令”放行。

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
 * 返回同类命令签名（如 `git diff`、`npm run build`）；不满足白名单或含复合语法时返回 null。
 */
export function commandFamilySignature(command) {
    const tokens = commandTokens(command);
    if (!tokens || tokens.length < 2) return null;
    const exe = commandExecutable(tokens[0]);
    if (!exe || INTERPRETER_EXES.has(exe)) return null;
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
