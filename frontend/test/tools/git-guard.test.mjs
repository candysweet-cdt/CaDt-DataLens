// 守卫用例：tools/hooks/git-guard.mjs（禁用 git checkout 的跨 harness 钩子）。
//
// 三层都要钉住：① 判定逻辑（哪些命令算、哪些不算）② 三种 harness 的线上协议（退出码 / JSON 决策）
// ③ 误伤边界（grep / 提交信息 / 文档正文里出现 "git checkout" 不能拦）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {analyzeCommand, splitSegments, tokenize} from '../../../tools/hooks/git-guard.mjs';

const GUARD = fileURLToPath(new URL('../../../tools/hooks/git-guard.mjs', import.meta.url));

test('拦下 git checkout 的各种写法', () => {
    const blocked = [
        'git checkout -- explorer.js',
        'git checkout .',
        'git checkout main',
        'git checkout',
        'git checkout -f',
        'git -C sub checkout -- x',
        'git -c core.quotepath=false checkout -- x',
        'git --no-pager checkout x',
        'git --git-dir=.git checkout -- x',
        'git.exe checkout -- x',
        'GIT_PAGER=cat git checkout x',
        'sudo git checkout x',
        // env 的带值选项（-u/-C/-S）不能只跳过选项本身，否则 FOO 会留在命令位
        'env -u FOO git checkout -- x',
        'env -C /tmp git checkout x',
        'env -i git checkout -- x',
        'env FOO=1 git checkout -- x',
        'sudo FOO=1 git checkout -- x',
        'cd frontend && git checkout -- src/main.js',
        'echo hi; git checkout -- x',
        '(git checkout -- x)',
        '"git" checkout -- x',
        'git checko -- x',
        'git checkou -- x',
        // 藏在 shell 包装里
        'bash -c "git checkout -- x"',
        'bash -lc "git checkout -f"',
        'sh -c "cd a && git checkout -- b"',
        'powershell -Command "git checkout -- x"',
        'pwsh -Command "git checkout -- x"',
        'cmd /c "git checkout -- x"',
    ];
    for (const command of blocked) {
        assert.equal(analyzeCommand(command), 'checkout', '应当拦截：' + command);
    }
});

test('拦下 git restore（与 checkout 同效的新写法）', () => {
    const blocked = [
        'git restore explorer.js',
        'git restore .',
        'git restore --source=HEAD~1 -- src/main.js',
        'git restore --worktree a.js',
        'git restore -W a.js',
        'git restore -SW a.js',
        'git restore --staged --worktree a.js',
        'git restore -S -W a.js',
        'git -C sub restore -- x',
        'git.exe restore x',
        'git resto -- x',
        'git rest -- x',
        'echo x && git restore --worktree .',
        'bash -c "git restore -- x"',
        'cmd /c "git restore ."',
    ];
    for (const command of blocked) {
        assert.equal(analyzeCommand(command), 'restore', '应当拦截：' + command);
    }
});

test('放行 git restore --staged（只动暂存区，不碰工作区文件）', () => {
    const allowed = [
        'git restore --staged a.js',
        'git restore --staged -- src/main.js',
        'git restore -S a.js',
        'git restore --source=HEAD~1 --staged src/main.js',
        'git restore --staged .',
    ];
    for (const command of allowed) {
        assert.equal(analyzeCommand(command), '', '不应拦截：' + command);
    }
});

test('不误伤：非 checkout 的 git、以及命令位置不是 git 的字符串', () => {
    const allowed = [
        '',
        'git switch main',
        'git switch -c feat/x',
        'git status',
        'git branch -a',
        'git diff HEAD -- explorer.js',
        'git stash -u',
        'git show HEAD:explorer.js',
        'git checkout-index -a', // 是另一个命令
        // 只在参数/正文里出现 "git checkout"，命令位置不是 git
        'grep -rn "git checkout" docs',
        'git log --grep="git checkout"',
        'echo git checkout',
        'git commit -m "docs: 为什么禁用 git checkout"',
        'node tools/hooks/git-guard.mjs --check "git checkout -- x"',
        // 其他 git 子命令照常可用（撤销暂存、回滚提交、看历史都不碰工作区文件）
        'git reset HEAD -- explorer.js',
        'git reset --soft HEAD~1',
        'git revert --no-edit HEAD',
        'git log --oneline -5',
    ];
    for (const command of allowed) {
        assert.equal(analyzeCommand(command), '', '不应拦截：' + command);
    }
});

test('切段与切词：引号内的控制符不当分隔', () => {
    assert.deepEqual(splitSegments('cd a && git checkout -- b'), ['cd a', 'git checkout -- b']);
    assert.deepEqual(splitSegments('echo "a;b" | cat'), ['echo "a;b"', 'cat']);
    assert.deepEqual(tokenize('git checkout -- "a b.js"'), ['git', 'checkout', '--', 'a b.js']);
    assert.deepEqual(tokenize("bash -c 'git checkout -- x'"), ['bash', '-c', 'git checkout -- x']);
});

test('协议：PreToolUse 拦截 = 退出码 2，放行 = 0', () => {
    const deny = spawnSync(process.execPath, [GUARD], {
        input: JSON.stringify({tool_name: 'Bash', tool_input: {command: 'git checkout -- explorer.js'}}),
        encoding: 'utf8',
    });
    assert.equal(deny.status, 2);
    assert.match(deny.stderr, /已阻止：整文件回退类 git 命令/);
    assert.match(deny.stderr, /git switch/); // 必须给替代做法，否则模型只会换个写法绕

    const allow = spawnSync(process.execPath, [GUARD], {
        input: JSON.stringify({tool_name: 'Bash', tool_input: {command: 'git switch main'}}),
        encoding: 'utf8',
    });
    assert.equal(allow.status, 0);
});

test('协议：非 shell 工具的同名正文不拦（Write 里写文档不能被打断）', () => {
    const result = spawnSync(process.execPath, [GUARD], {
        input: JSON.stringify({tool_name: 'Write', tool_input: {file_path: 'a.md', content: '不要用 git checkout'}}),
        encoding: 'utf8',
    });
    assert.equal(result.status, 0);
});

test('协议：Cursor beforeShellExecution 用 JSON 决策（deny / allow）', () => {
    const deny = spawnSync(process.execPath, [GUARD], {
        input: JSON.stringify({hook_event_name: 'beforeShellExecution', command: 'cd x && git checkout -- a'}),
        encoding: 'utf8',
    });
    assert.equal(deny.status, 0);
    const decision = JSON.parse(deny.stdout.trim());
    assert.equal(decision.permission, 'deny');
    assert.match(decision.agent_message, /git switch/);

    const allow = spawnSync(process.execPath, [GUARD], {
        input: JSON.stringify({hook_event_name: 'beforeShellExecution', command: 'npm test'}),
        encoding: 'utf8',
    });
    assert.equal(allow.status, 0);
    assert.equal(JSON.parse(allow.stdout.trim()).permission, 'allow');
});
