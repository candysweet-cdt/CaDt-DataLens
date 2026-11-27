#!/usr/bin/env node
// tools/hooks/git-guard.mjs —— 禁用「整文件回退」类 git 命令（`git checkout` / `git restore`）的跨 harness 守卫。
//
// 起因（2026-11-21）：有人用 `git checkout -- <文件>` 撤销自己的改动，把一个文件上**多个会话叠加的
// 未提交改动**一起回滚到 HEAD —— 单文件撤销在这类仓库里等价于批量销毁。`git restore` 是同一动作的
// 新名字，同样会丢未提交改动，所以两者一起禁（用户 2026-11-21 明确要求）；但 `git restore --staged`
// 只动暂存区、不碰工作区文件，属于安全形态，放行。
//
// 三种形态一个脚本，靠 stdin 的负载自动识别（不靠命令行开关，配置里少一处出错点）：
//   · Claude Code / CodeBuddy / WorkBuddy：{tool_name, tool_input:{command}} → 拦截 = 退出码 2 + stderr
//   · Cursor：{hook_event_name:'beforeShellExecution', command} → 拦截 = stdout {"permission":"deny"}
//   · 手工自查：node tools/hooks/git-guard.mjs --check "git checkout -- a.js"
//
// 判定口径：**只认命令位置的 git**（`grep "git checkout"`、`echo`、`git log --grep=...` 一律放行），
// 并且看穿 `bash -c` / `cmd /c` / `powershell -Command` 这层引号包装。
//
// 这是护栏不是边界：绕过它很容易（改配置、用别名）。真正的兜底是「不把未提交改动当可丢的东西」——
// 见 AGENTS.md「禁止操作」一节。

import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// 禁用的子命令 + git 的合法前缀缩写（checko/checkou/checkout、rest/resto/restor/restore；
// 更短的前缀如 `check` 会因歧义报错，不必管）
const BLOCKED_SUBCOMMANDS = [
    {name: 'checkout', pattern: /^checko(?:u(?:t)?)?$/},
    {name: 'restore', pattern: /^rest(?:o(?:r(?:e)?)?)?$/},
];
// 能给 git 套壳的执行器
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'winpty']);
// 需要递归看内部的 shell（`bash -c "git checkout …"`）
const NESTED_SHELLS = new Set([
    'bash', 'sh', 'zsh', 'dash', 'ksh', 'cmd', 'cmd.exe',
    'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
]);
// 会执行命令的工具名（hook 的 matcher 已经过滤过一层，这里再兜一层：避免 Write/Edit 的正文被误判）
const SHELL_TOOL = /bash|shell|zsh|powershell|pwsh|cmd|terminal|console|command|exec|run_command/i;
// -C / -c 这类 git 全局选项要连带吃掉它的值
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

const REASON_HEAD = '⛔ 已阻止：整文件回退类 git 命令（git checkout / git restore）';

function reasonText(command, blocked) {
    return [
        REASON_HEAD,
        '',
        '本仓库禁用「会写工作区」的整文件回退命令：`git checkout` 任何形态，以及不带 `--staged` 的 `git restore`',
        '（含缩写、`-f`、以及藏在 shell 包装里的）。`git restore --staged` 只撤暂存、不碰文件，放行。',
        '起因：一次 `git checkout -- <文件>` 想把单个文件的改动撤掉，结果把该文件上多个会话叠加的未提交',
        '改动一起回滚到了 HEAD，无法从备份恢复。`git restore` 是同一动作的新名字，同样会丢改动。',
        '',
        '命中的是：' + (blocked === 'restore' ? 'git restore' : (blocked === 'checkout' ? 'git checkout' : '整文件回退')),
        '被拦的命令：' + String(command || '').replace(/\s+/g, ' ').slice(0, 200),
        '',
        '替代做法：',
        '· 切分支：git switch <分支>（新建 git switch -c <分支>）',
        '· 撤销某一处改动：用编辑工具按 hunk 反向修改；确需整文件回退，先 cp 备份并让用户确认',
        '· 只撤销暂存、不碰文件内容：git restore --staged <路径>（这个形态**允许**）或 git reset HEAD -- <路径>',
        '· 暂时收起全部本地改动：git stash -u（之后 git stash pop 能拿回来）',
        '· 只看历史版本：git show HEAD:<路径>（只读，不写工作区）',
        '',
        '确需回退：请用户自己在终端执行，或由用户临时移除本规则。',
    ].join('\n');
}

function baseName(token) {
    const text = String(token || '').replace(/\\/g, '/');
    return text.slice(text.lastIndexOf('/') + 1).toLowerCase();
}

// splitSegments：按 shell 控制符切段（引号内的不切）。`&&` / `||` / `;;` 会被拆成多段，不影响判定。
export function splitSegments(command) {
    const out = [];
    let cur = '';
    let quote = '';
    const text = String(command || '');
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (quote) {
            cur += ch;
            if (ch === '\\' && quote === '"' && i + 1 < text.length) {
                cur += text[i + 1];
                i += 1;
                continue;
            }
            if (ch === quote) quote = '';
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            cur += ch;
            continue;
        }
        if (ch === '\\' && i + 1 < text.length) {
            cur += ch + text[i + 1];
            i += 1;
            continue;
        }
        if (ch === ';' || ch === '\n' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
            out.push(cur);
            cur = '';
            continue;
        }
        cur += ch;
    }
    out.push(cur);
    return out.map((seg) => seg.trim()).filter(Boolean);
}

// tokenize：去引号、按空白切词（引号内的空白不切）。够用即可，不是完整的 shell 词法。
export function tokenize(segment) {
    const out = [];
    let cur = '';
    let quote = '';
    let started = false;
    const text = String(segment || '');
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (quote) {
            if (ch === '\\' && quote === '"' && i + 1 < text.length) {
                cur += text[i + 1];
                i += 1;
                continue;
            }
            if (ch === quote) {
                quote = '';
                continue;
            }
            cur += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            started = true;
            continue;
        }
        if (ch === '\\' && i + 1 < text.length) {
            cur += text[i + 1];
            started = true;
            i += 1;
            continue;
        }
        if (/\s/.test(ch)) {
            if (started || cur) out.push(cur);
            cur = '';
            started = false;
            continue;
        }
        cur += ch;
        started = true;
    }
    if (started || cur) out.push(cur);
    return out;
}

// stripWrappers：去掉前置的环境变量赋值与 sudo/env/time 之类的外壳。
//
// env 的 -u / -C / -S 都带一个值（`env -u FOO git checkout x`）：只跳过选项本身，
// FOO 会留在命令位，baseName 不是 git 就整段放行。外壳可以链式出现（`env -i sudo git …`），
// 赋值也可能出现在外壳之后（`sudo FOO=1 git …`），所以用循环反复剥离。
const ENV_VALUE_OPTS = new Set(['-u', '-C', '-S', '--unset', '--chdir']);

function stripWrappers(tokens) {
    let i = 0;
    for (;;) {
        let moved = false;
        while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
            i += 1;
            moved = true;
        }
        if (i < tokens.length && WRAPPERS.has(baseName(tokens[i]))) {
            const wrapper = baseName(tokens[i]);
            i += 1;
            while (i < tokens.length && tokens[i].startsWith('-')) {
                const opt = tokens[i];
                i += 1;
                if (wrapper === 'env' && ENV_VALUE_OPTS.has(opt) && i < tokens.length) i += 1;
            }
            if (i < tokens.length && /^\d+$/.test(tokens[i])) i += 1; // `time -p 5 cmd` 里的秒数
            moved = true;
        }
        if (!moved) break;
    }
    return tokens.slice(i);
}

// isForbiddenGit：命令位置是 git，且第一个非选项参数是 checkout
function blockedSubcommandOf(name) {
    const sub = baseName(name);
    const hit = BLOCKED_SUBCOMMANDS.find((item) => item.pattern.test(sub));
    return hit ? hit.name : '';
}

// restoreTouchesWorktree：`git restore` 只有「会写工作区」才拦。
// 只撤暂存（`--staged` / `-S`，且没带 `--worktree` / `-W`）不动文件内容，放行；
// 默认形态（不带 --staged）写工作区，照拦。
function restoreTouchesWorktree(args) {
    let staged = false;
    let worktree = false;
    for (const token of args) {
        if (token === '--') break; // 后面全是路径
        if (token === '--staged') staged = true;
        else if (token === '--worktree') worktree = true;
        else if (token.startsWith('--')) continue; // --source=… / --pathspec-from-file=…
        else if (/^-[A-Za-z]+$/.test(token)) {
            if (token.includes('W')) worktree = true;
            if (token.includes('S')) staged = true;
        }
    }
    return worktree || !staged;
}

// blockedGitSubcommand：命令位置是 git，且第一个非选项参数是禁用的子命令 → 返回子命令名（'' = 放行）
function blockedGitSubcommand(tokens) {
    if (!tokens.length) return '';
    const head = baseName(tokens[0]);
    if (head !== 'git' && head !== 'git.exe') return '';
    let i = 1;
    while (i < tokens.length) {
        const token = tokens[i];
        if (!token.startsWith('-')) break;
        const option = token.split('=')[0];
        i += 1;
        // `-C dir` / `--git-dir path` 带一个值；`--git-dir=path` 自带等号
        if (!token.includes('=') && GIT_OPTIONS_WITH_VALUE.has(option)) i += 1;
    }
    const hit = blockedSubcommandOf(tokens[i] || '');
    if (!hit) return '';
    // restore 的「只撤暂存」形态不写工作区，放行（用户 2026-11-21 追加的口径）
    if (hit === 'restore' && !restoreTouchesWorktree(tokens.slice(i + 1))) return '';
    return hit;
}

// analyzeCommand：命中禁用命令返回子命令名（'checkout' / 'restore'），否则返回空串。
// depth 限制递归层数，避免病态输入。
export function analyzeCommand(command, depth = 0) {
    for (const segment of splitSegments(command)) {
        const tokens = stripWrappers(tokenize(segment));
        if (!tokens.length) continue;
        const hit = blockedGitSubcommand(tokens);
        if (hit) return hit;
        if (depth >= 3) continue;
        const head = baseName(tokens[0]);
        if (!NESTED_SHELLS.has(head)) continue;
        // bash -c / bash -lc / cmd /c / powershell -Command 之后的部分当新命令再看一遍
        const flagIndex = tokens.findIndex((token, index) => index > 0 &&
            (/^-[A-Za-z]*c$/.test(token) || /^-command$/i.test(token) || /^\/c$/i.test(token)));
        if (flagIndex > 0 && flagIndex + 1 < tokens.length) {
            const inner = analyzeCommand(tokens.slice(flagIndex + 1).join(' '), depth + 1);
            if (inner) return inner;
        }
    }
    return '';
}

function extractCommand(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const toolInput = payload.tool_input || payload.toolInput || payload.input || {};
    const raw = payload.command ?? toolInput.command ?? toolInput.script ?? toolInput.code ?? toolInput.cmd;
    return typeof raw === 'string' ? raw : '';
}

function isShellCall(payload, isCursorEvent) {
    if (isCursorEvent) return true; // beforeShellExecution 只会在执行 shell 时触发
    const name = String((payload && (payload.tool_name || payload.toolName)) || '');
    if (!name) return true; // 认不出工具名就查一遍：宁可多拦，不漏拦
    return SHELL_TOOL.test(name);
}

function readStdin() {
    try {
        return readFileSync(0, 'utf8');
    } catch (e) {
        return '';
    }
}

function main() {
    const argv = process.argv.slice(2);
    const checkIndex = argv.indexOf('--check');
    if (checkIndex >= 0) {
        const command = argv[checkIndex + 1] || '';
        const hit = analyzeCommand(command);
        process.stdout.write((hit ? 'BLOCK(' + hit + ')  ' : 'ALLOW  ') + command + '\n');
        if (hit) process.stderr.write(reasonText(command, hit) + '\n');
        process.exit(hit ? 2 : 0);
    }

    const raw = readStdin().trim();
    let payload = null;
    try {
        payload = raw ? JSON.parse(raw) : null;
    } catch (e) {
        payload = null; // 负载不是 JSON：放行（钩子不该把整个流程卡死）
    }
    const event = String((payload && (payload.hook_event_name || payload.hookEventName)) || '');
    const isCursorEvent = event === 'beforeShellExecution' || event === 'afterShellExecution' ||
        (!(payload && (payload.tool_input || payload.toolInput)) && typeof (payload && payload.command) === 'string');

    const command = extractCommand(payload);
    const hit = (command && isShellCall(payload, isCursorEvent)) ? analyzeCommand(command) : '';

    if (isCursorEvent) {
        // Cursor 读 stdout 的 JSON 决策；allow 也要显式回一条（failClosed 下空输出会被当成失败）
        process.stdout.write(JSON.stringify(hit
            ? {permission: 'deny', user_message: '已阻止整文件回退（git checkout / git restore）', agent_message: reasonText(command, hit)}
            : {permission: 'allow'}) + '\n');
        process.exit(0);
    }
    if (hit) {
        process.stderr.write(reasonText(command, hit) + '\n');
        process.exit(2); // 2 = 拦截，stderr 回填给模型
    }
    process.exit(0);
}

const invokedDirectly = (() => {
    try {
        return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
    } catch (e) {
        return false;
    }
})();

if (invokedDirectly) main();
