import test from 'node:test';
import assert from 'node:assert/strict';
import {
    analyzeDangerousCommand,
    analyzeReadOnlyCommand,
    collectCommandFamilies,
    commandFamilySignature,
    commandText,
    matchCommandRule,
    splitCommandSegments,
} from './ai-command-rules.js';

test('同类签名：白名单开发命令', () => {
    const cases = [
        ['git status --short', 'git status'],
        ['git diff HEAD~1 -- src/a.js', 'git diff'],
        ['go test ./... -count=1', 'go test'],
        ['go build ./...', 'go build'],
        ['npm run build -- --mode production', 'npm run build'],
        ['pnpm run test', 'pnpm run test'],
        ['npm test -- --watch', 'npm test'],
        ['cargo test -- --nocapture', 'cargo test'],
    ];
    for (const [command, want] of cases) {
        assert.equal(commandFamilySignature(command)?.signature, want, command);
    }
});

test('同类签名：导航与回显命令直接放行', () => {
    const cases = [
        ['pwd', 'pwd'],
        ['pwd -P', 'pwd'],
        ['cd src/components', 'cd'],
        ['cd /d D:\\repo', 'cd'],
        ['chdir ..', 'chdir'],
        ['echo hello world', 'echo'],
    ];
    for (const [command, want] of cases) {
        assert.equal(commandFamilySignature(command)?.signature, want, command);
    }
});

test('同类签名：解释器、复合命令与危险参数不放行', () => {
    const cases = [
        'powershell -NoProfile -Command "Get-Process"',
        'pwsh -NoProfile -Command "Get-Date"',
        'cmd /c dir',
        'bash -lc "rm -rf /"',
        'python -c "print(1)"',
        'node -e "process.exit(0)"',
        'git diff && rm -rf build',
        'git diff | cat',
        'git diff > out.txt',
        'git diff $(pwd)',
        'git diff `pwd`',
        'git push origin master',
        'git reset --hard',
        'git status; rm -rf build',
        'git diff --output=foo',
        'git diff --ext-diff',
        'git -C other status',
        'go test -exec foo',
        'go build -o bin/app',
        'go build -obin/app',
        'go env -w GOPROXY=x',
        'npm exec ls',
        'npm run build --prefix other',
        'npm run build -Cother',
        'pnpm --filter app test',
        'rm -rf node_modules',
        'cat secret.txt',
        'ls',
        'ls -la',
        'dir',
        'whoami',
        'cd src && rm -rf build',
        'cd src; rm -rf build',
        'pwd > where.txt',
        'echo hi > note.txt',
        'echo $(whoami)',
    ];
    for (const command of cases) {
        assert.equal(commandFamilySignature(command), null, command);
    }
});

test('匹配规则：exact 与 family 都绑定 cwd', () => {
    const rules = [
        {mode: 'exact', command: 'powershell -NoProfile -Command "Get-Process"', cwdKey: 'd:/repo'},
        {mode: 'family', signature: 'git diff', cwdKey: 'd:/repo'},
    ];
    assert.ok(matchCommandRule(rules, 'powershell -NoProfile -Command "Get-Process"', 'd:/repo'));
    assert.equal(matchCommandRule(rules, 'powershell -NoProfile -Command "Get-Date"', 'd:/repo'), null);
    assert.ok(matchCommandRule(rules, 'git diff HEAD~1', 'd:/repo'));
    assert.equal(matchCommandRule(rules, 'git diff HEAD~1', 'd:/other'), null);
    assert.ok(matchCommandRule(rules, '  git diff HEAD~1  ', 'd:/repo'));
    assert.equal(matchCommandRule([], 'git diff', 'd:/repo'), null);
});

test('commandText 只做换行归一与首尾空白裁剪', () => {
    assert.equal(commandText('  git status\r\n'), 'git status');
    assert.equal(commandText(null), '');
});

test('复合命令分段：顶层运算符拆分，重定向与替换判为不安全', () => {
    assert.deepEqual(splitCommandSegments('echo a && echo b')?.segments, ['echo a', 'echo b']);
    assert.equal(splitCommandSegments('git log | head -20')?.segments.length, 2);
    assert.equal(splitCommandSegments('echo "a && b"')?.segments.length, 1);
    assert.equal(splitCommandSegments('echo a > out.txt'), null);
    assert.equal(splitCommandSegments('echo `pwd`'), null);
    assert.equal(splitCommandSegments('echo $(pwd)'), null);
    assert.equal(splitCommandSegments('echo a &'), null);
    assert.equal(splitCommandSegments('echo "unclosed'), null);
    assert.equal(splitCommandSegments('cd src && ls'), null);
});

test('只读分析：常用只读命令与 git 只读子命令', () => {
    const cases = [
        'ls -la',
        'cat package.json',
        'pwd',
        'dir /b',
        'type package.json',
        'git status',
        'git log --oneline -5',
        'git diff HEAD~1 -- src/a.js',
        'git branch -a',
        'git remote -v',
        'git config --get remote.origin.url',
        'git stash list',
        'pwd && ls',
        'git log | head -20',
        'find . -name "*.js"',
        'rg TODO src',
        'sort -u list.txt',
        'hostname',
        'date',
        'wc -l package.json',
    ];
    for (const command of cases) {
        assert.equal(analyzeReadOnlyCommand(command).readOnly, true, command);
    }
});

test('只读分析：写参数、任意执行与未知命令不放行', () => {
    const cases = [
        'ls > out.txt',
        'cat a.txt | tee b.txt',
        'git reset --hard',
        'git branch -d feat',
        'git tag v1.0.0',
        'git remote add origin url',
        'git config user.name demo',
        'git -C other status',
        'sed -i s/a/b/ file.txt',
        'sort -o out.txt list.txt',
        'find . -name "*.js" -exec rm {} \\;',
        'hostname new-name',
        'date -s 12:00',
        'uniq in.txt out.txt',
        'echo hi > note.txt',
        'npm run build',
        'rm -rf build',
        'powershell -NoProfile -Command "Get-Date"',
    ];
    for (const command of cases) {
        assert.equal(analyzeReadOnlyCommand(command).readOnly, false, command);
    }
});

test('危险命令：单次确认清单', () => {
    const cases = [
        ['rm -rf build', 'rm-recursive-force'],
        ['rm -r -f build', 'rm-recursive-force'],
        ['rm --recursive --force build', 'rm-recursive-force'],
        ['rmdir /s /q dist', 'rmdir-recursive'],
        ['rd /s /q dist', 'rmdir-recursive'],
        ['del /s *.tmp', 'del-force'],
        ['git reset --hard HEAD~1', 'git-reset-hard'],
        ['git clean -fd', 'git-clean-force'],
        ['git push --force origin main', 'git-push-force'],
        ['git push -f', 'git-push-force'],
        ['git push --delete origin feat', 'git-push-force'],
        ['git checkout .', 'git-discard-worktree'],
        ['git checkout -- src/a.js', 'git-discard-worktree'],
        ['git restore src/a.js', 'git-discard-worktree'],
        ['git stash clear', 'git-stash-drop'],
        ['git branch -D feat', 'git-branch-force-delete'],
        ['shutdown /s', 'shutdown'],
        ['robocopy a b /mir', 'robocopy-mirror'],
        ['cd src && rm -rf build', 'rm-recursive-force'],
        ['rm -rf build > log.txt', 'rm-recursive-force'],
    ];
    for (const [command, ruleId] of cases) {
        assert.equal(analyzeDangerousCommand(command).dangerous, true, command);
        assert.equal(analyzeDangerousCommand(command).ruleId, ruleId, command);
    }
});

test('危险命令：普通删除与只读操作不误报', () => {
    const cases = [
        'rm build/file.txt',
        'del file.txt',
        'git push origin main',
        'git checkout feat',
        'git restore --staged src/a.js',
        'git clean -n',
        'git reset --soft HEAD~1',
        'ls -la',
    ];
    for (const command of cases) {
        assert.equal(analyzeDangerousCommand(command).dangerous, false, command);
    }
});

test('计划预授权：从正文与代码块提取同类命令签名', () => {
    const plan = [
        '1. 先运行 `git status` 确认状态。',
        '2. 执行 `npm run build` 并 `go test ./...`。',
        '```bash',
        'git diff --stat',
        '```',
        '其余内容不影响结果。',
    ].join('\n');
    const families = collectCommandFamilies(plan);
    assert.deepEqual(families, ['git status', 'npm run build', 'go test', 'git diff']);
});
