import test from 'node:test';
import assert from 'node:assert/strict';
import {commandFamilySignature, commandText, matchCommandRule} from './ai-command-rules.js';

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
