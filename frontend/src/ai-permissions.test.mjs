import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifierModelOptionLabel,
    countPermissionRules,
    decidePermission,
    emptyPermissionRules,
    evaluatePermissionRules,
    formatRuleLines,
    matchPermissionRule,
    normalizePermissionRules,
    parseRuleLines,
    resolveClassifierProfileId,
    webRuleSubject,
    writeRuleSubject,
} from './ai-permissions.js';

test('规则文件归一：忽略非法条目并按 kind/behavior 收敛', () => {
    const rules = normalizePermissionRules({
        command: {allow: ['npm run build:*', '  ', 'npm run build:*', 42], deny: ['git push --force:*']},
        write: {ask: ['src/**']},
        web: null,
        junk: true,
    });
    assert.deepEqual(rules.command.allow, ['npm run build:*']);
    assert.deepEqual(rules.command.deny, ['git push --force:*']);
    assert.deepEqual(rules.write.ask, ['src/**']);
    assert.deepEqual(rules.web, {allow: [], ask: [], deny: []});
    assert.equal(countPermissionRules(rules), 3);
    assert.equal(countPermissionRules(null), 0);
});

test('行语法解析与序列化：Bash/Write/Web，错误行要报出来', () => {
    const parsed = parseRuleLines([
        '# 注释',
        'Bash(git status:*)',
        'Bash(npm run build:*)',
        'Write(docs/**)',
        'Web(domain:example.com)',
        '裸规则 xxx',
        'Bash()',
        'Unknown(x)',
    ].join('\n'), 'allow');
    assert.deepEqual(parsed.rules.command.allow, ['git status:*', 'npm run build:*']);
    assert.deepEqual(parsed.rules.write.allow, ['docs/**']);
    assert.deepEqual(parsed.rules.web.allow, ['domain:example.com']);
    assert.equal(parsed.errors.length, 3);

    const text = formatRuleLines(parsed.rules, 'allow');
    assert.equal(text, [
        'Bash(git status:*)',
        'Bash(npm run build:*)',
        'Write(docs/**)',
        'Web(domain:example.com)',
    ].join('\n'));
    const roundTrip = parseRuleLines(text, 'allow');
    assert.equal(roundTrip.errors.length, 0);
    assert.equal(countPermissionRules(roundTrip.rules), 4);
});

test('匹配：命令前缀 / 精确 / 通配', () => {
    assert.ok(matchPermissionRule('command', 'git status --short', 'git status:*'));
    assert.ok(matchPermissionRule('command', 'git status', 'git status:*'));
    assert.equal(matchPermissionRule('command', 'git statusx', 'git status:*'), false);
    assert.ok(matchPermissionRule('command', 'git status', 'git status'));
    assert.equal(matchPermissionRule('command', 'git status -s', 'git status'), false);
    assert.ok(matchPermissionRule('command', 'npm run build -- --mode prod', 'npm run *'));
    assert.equal(matchPermissionRule('command', 'rm -rf /', 'rm -rf:*'), true);
});

test('匹配：写入路径 glob 与 web 域名', () => {
    assert.ok(matchPermissionRule('write', 'docs/a/b.md', 'docs/**'));
    assert.ok(matchPermissionRule('write', 'docs', 'docs/**'));
    assert.ok(matchPermissionRule('write', 'README.md', '*.md'));
    assert.equal(matchPermissionRule('write', 'docs/a.md', '*.md'), false);
    assert.ok(matchPermissionRule('write', 'src\\a.js', 'src/*.js'));
    assert.equal(writeRuleSubject('.\\src\\a.js'), 'src/a.js');

    assert.equal(webRuleSubject('https://Example.com/path?q=1'), 'domain:example.com');
    assert.ok(matchPermissionRule('web', 'domain:example.com', 'domain:example.com'));
    assert.ok(matchPermissionRule('web', 'domain:api.example.com', '*.example.com'));
    assert.equal(matchPermissionRule('web', 'domain:api.example.com', 'domain:example.com'), false);
});

test('规则求值：deny → ask → allow 顺序', () => {
    const rules = normalizePermissionRules({
        command: {
            allow: ['git status:*'],
            ask: ['git push:*'],
            deny: ['git push --force:*'],
        },
    });
    assert.deepEqual(evaluatePermissionRules(rules, 'command', 'git push --force origin main'), {
        decision: 'deny', rule: 'git push --force:*',
    });
    assert.deepEqual(evaluatePermissionRules(rules, 'command', 'git push origin main'), {
        decision: 'ask', rule: 'git push:*',
    });
    assert.deepEqual(evaluatePermissionRules(rules, 'command', 'git status'), {
        decision: 'allow', rule: 'git status:*',
    });
    assert.deepEqual(evaluatePermissionRules(rules, 'command', 'ls'), {decision: '', rule: ''});
});

test('统一决策链：deny 压过完全权限，危险命令除完全权限外一律单次确认', () => {
    const rules = normalizePermissionRules({command: {deny: ['rm -rf:*']}});
    assert.equal(decidePermission({scope: 'full', kind: 'command', rules, subject: 'rm -rf build'}).decision, 'deny');
    assert.equal(decidePermission({scope: 'auto', kind: 'command', subject: 'rm -rf build', dangerous: true}).decision, 'ask');
    assert.equal(decidePermission({scope: 'auto', kind: 'command', subject: 'rm -rf build', dangerous: true}).singleUse, true);
    assert.equal(decidePermission({scope: 'full', kind: 'command', subject: 'rm -rf build', dangerous: true}).decision, 'allow');
});

test('统一决策链：会话/项目 allow、只读、命令族与分类器', () => {
    const rules = normalizePermissionRules({command: {allow: ['npm test:*']}});
    assert.equal(decidePermission({scope: 'edit', kind: 'command', subject: 'x', sessionAllow: true}).decision, 'allow');
    assert.equal(decidePermission({scope: 'auto', kind: 'command', rules, subject: 'npm test -- --watch'}).source, 'project');
    assert.equal(decidePermission({scope: 'auto', kind: 'command', subject: 'ls -la', readOnly: true}).decision, 'allow');
    assert.equal(decidePermission({scope: 'auto', kind: 'command', subject: 'git status', familyAuto: true}).decision, 'allow');
    assert.equal(decidePermission({scope: 'auto', kind: 'command', subject: 'python x.py', classifierEnabled: true}).decision, 'classify');
    assert.equal(decidePermission({scope: 'auto', kind: 'command', subject: 'python x.py'}).decision, 'ask');
    assert.equal(decidePermission({scope: 'read', kind: 'command', subject: 'ls'}).decision, 'ask');
});

test('统一决策链：写入与网络', () => {
    const rules = normalizePermissionRules({write: {deny: ['.git/**'], ask: ['AGENTS.md']}});
    assert.equal(decidePermission({scope: 'full', kind: 'write', rules, subject: '.git/config'}).decision, 'deny');
    assert.equal(decidePermission({scope: 'auto', kind: 'write', rules, subject: 'AGENTS.md'}).decision, 'ask');
    assert.equal(decidePermission({scope: 'auto', kind: 'write', rules, subject: 'src/a.js', risky: true}).decision, 'ask');
    assert.equal(decidePermission({scope: 'auto', kind: 'write', rules, subject: 'src/a.js'}).decision, 'allow');
    assert.equal(decidePermission({scope: 'edit', kind: 'write', rules, subject: 'src/a.js'}).decision, 'ask');
    assert.equal(decidePermission({scope: 'edit', kind: 'web', subject: 'domain:example.com'}).decision, 'allow');
    assert.equal(decidePermission({scope: 'edit', kind: 'web', rules: normalizePermissionRules({web: {ask: ['domain:example.com']}}), subject: 'domain:example.com'}).decision, 'ask');
});

test('空规则集结构稳定', () => {
    assert.deepEqual(emptyPermissionRules(), normalizePermissionRules(undefined));
});

test('resolveClassifierProfileId：空 / 未知 id 回退跟随当前模型（空串）', () => {
    const profiles = [{id: 'p1', name: 'A', model: 'm1'}, {id: 'p2', name: 'B', model: ''}];
    assert.equal(resolveClassifierProfileId('', profiles), '');
    assert.equal(resolveClassifierProfileId(null, profiles), '');
    assert.equal(resolveClassifierProfileId('  p2 ', profiles), 'p2');
    assert.equal(resolveClassifierProfileId('ghost', profiles), '', '配置被删除后回退为空');
    assert.equal(resolveClassifierProfileId('p1', undefined), '', '无配置列表时回退为空');
});

test('classifierModelOptionLabel：与模型菜单一致的「model · 配置名」格式', () => {
    assert.equal(classifierModelOptionLabel({id: 'p1', name: '演示配置', model: 'deepseek-flash'}), 'deepseek-flash · 演示配置');
    assert.equal(classifierModelOptionLabel({id: 'p2', name: 'Anthropic 官方', model: ''}), 'Anthropic 官方');
    assert.equal(classifierModelOptionLabel({id: 'p3', name: 'claude', model: 'claude'}), 'claude', '同名时只显示一次');
    assert.equal(classifierModelOptionLabel(null), '');
    assert.equal(classifierModelOptionLabel({}), '');
});
