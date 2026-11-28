import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
    classifierModelOptionLabel,
    countPermissionRules,
    decidePermission,
    emptyPermissionRules,
    evaluatePermissionRules,
    formatRuleLines,
    isWebApproval,
    matchPermissionRule,
    normalizeDefaultScope,
    normalizePermissionRules,
    parseRuleLines,
    permissionAuditActor,
    resolveClassifierProfileId,
    scopeUpgradedToFull,
    webRuleSubject,
    writeRuleSubject,
} from '../../../src/ai/security/ai-permissions.js';

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

test('统一决策链：Git 快捷操作一次性窄豁免（auto 档、命令通道）', () => {
    // auto + gitFlowSafe → 放行，来源 git-flow
    assert.deepEqual(
        decidePermission({scope: 'auto', kind: 'command', subject: 'git add src/a.js', gitFlowSafe: true}),
        {decision: 'allow', source: 'git-flow'},
    );
    // 非 auto 档不生效（edit 仍逐条询问）
    assert.equal(decidePermission({scope: 'edit', kind: 'command', subject: 'git add src/a.js', gitFlowSafe: true}).decision, 'ask');
    assert.equal(decidePermission({scope: 'read', kind: 'command', subject: 'git add src/a.js', gitFlowSafe: true}).decision, 'ask');
    // 危险命令压过豁免（singleUse 单次确认）
    assert.equal(
        decidePermission({scope: 'auto', kind: 'command', subject: 'git push --force origin main', dangerous: true, gitFlowSafe: true}).decision,
        'ask',
    );
    // 项目 deny / ask 压过豁免
    const denyRules = normalizePermissionRules({command: {deny: ['git push:*']}});
    assert.equal(decidePermission({scope: 'auto', kind: 'command', rules: denyRules, subject: 'git push origin main', gitFlowSafe: true}).decision, 'deny');
    const askRules = normalizePermissionRules({command: {ask: ['git push:*']}});
    assert.equal(decidePermission({scope: 'auto', kind: 'command', rules: askRules, subject: 'git push origin main', gitFlowSafe: true}).decision, 'ask');
    // gitFlowSafe 缺省 false：行为不变
    assert.equal(decidePermission({scope: 'auto', kind: 'command', subject: 'git add src/a.js'}).decision, 'ask');
    // 非命令通道不生效（write 走自己的 risky 判定；.cadt 整树 risky 转人工）
    assert.equal(decidePermission({scope: 'auto', kind: 'write', subject: '.cadt/x', gitFlowSafe: true, risky: true}).decision, 'ask');
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

// 工作区外写入（2026-11-28 写工具放行越界路径）：auto 档绝不自动应用，一律转人工；
// 审批卡「记住」的精确路径（sessionAllow）是唯一免卡通道；full 档在更早分支直放。
test('统一决策链：工作区外写入一律转人工（auto 也不例外）', () => {
    const ask = decidePermission({scope: 'auto', kind: 'write', subject: 'D:/notes/todo.md', outOfWorkspace: true});
    assert.equal(ask.decision, 'ask');
    assert.equal(ask.source, 'out-of-workspace');
    // risky 与 outOfWorkspace 同时存在时按 risky 计（来源用于审计归因，行为同为转人工）
    assert.equal(decidePermission({scope: 'auto', kind: 'write', subject: 'D:/x/.git/config', outOfWorkspace: true, risky: true}).source, 'risky');
    // 审批卡「记住」的文件免再问
    assert.equal(decidePermission({scope: 'auto', kind: 'write', subject: 'D:/notes/todo.md', outOfWorkspace: true, sessionAllow: true}).decision, 'allow');
    // 项目 allow 规则同样免卡（规则存储是裸路径模式，Write(...) 只是设置页行语法）
    const allowAbs = normalizePermissionRules({write: {allow: ['D:/notes/**']}});
    assert.equal(decidePermission({scope: 'auto', kind: 'write', rules: allowAbs, subject: 'D:/notes/todo.md', outOfWorkspace: true}).decision, 'allow');
    // 非 auto 档本来就走 ask，越界不改变行为；full 档直放不变
    assert.equal(decidePermission({scope: 'edit', kind: 'write', subject: 'D:/notes/todo.md', outOfWorkspace: true}).decision, 'ask');
    assert.equal(decidePermission({scope: 'full', kind: 'write', subject: 'D:/notes/todo.md', outOfWorkspace: true}).decision, 'allow');
});

// 删除（delete_path 工具，2026-11-28）：独立 kind——授权写 ≠ 授权删，写侧「记住」
// 不外溢（调用方不传 sessionAllow）。auto 档口径与 write 分支对齐：风险合成（工作区外
// / 展开超量级 / 风险路径 / 脏文件，调用方并入 risky）转人工，其余直删——删除有回收站
// + 删除前 L1 快照双层兜底，可恢复性不低于 auto 档本来就直放的写；full 直删；
// 项目 Delete(...) deny/ask/allow 规则照常生效（deny 压过 full，allow 压过 risky）。
test('统一决策链：删除 auto 档干净清单直删、风险转人工，full 直删', () => {
    const allow = decidePermission({scope: 'auto', kind: 'delete', subject: 'tmp/x.txt', risky: false});
    assert.equal(allow.decision, 'allow');
    assert.equal(allow.source, 'auto');
    const ask = decidePermission({scope: 'auto', kind: 'delete', subject: 'tmp/x.txt', risky: true});
    assert.equal(ask.decision, 'ask');
    assert.equal(ask.source, 'risky');
    assert.equal(decidePermission({scope: 'edit', kind: 'delete', subject: 'tmp/x.txt', risky: false}).decision, 'ask');
    assert.equal(decidePermission({scope: 'full', kind: 'delete', subject: 'tmp/x.txt'}).decision, 'allow');
    const delRules = normalizePermissionRules({delete: {deny: ['.git/**'], allow: ['D:/tmp/**']}});
    assert.equal(decidePermission({scope: 'full', kind: 'delete', rules: delRules, subject: '.git/config'}).decision, 'deny');
    assert.equal(decidePermission({scope: 'auto', kind: 'delete', rules: delRules, subject: 'D:/tmp/a.txt', risky: true}).decision, 'allow');
});

test('接线护栏：.cadt/tmp 是 auto 档写入免审批的唯一 .cadt 豁免', () => {
    // isAutoWriteRisky 在 ai-panel.js 闭包里，这里钉源码形态：
    // 豁免必须精确到 .cadt/tmp 前缀且排在 .cadt 整树 risky 判定之前，防止将来被放宽成通配。
    const panel = readFileSync(new URL('../../../src/ai/ai-panel.js', import.meta.url), 'utf8');
    assert.ok(
        panel.includes("if (rel === '.cadt/tmp' || rel.startsWith('.cadt/tmp/')) return false;"),
        '.cadt/tmp 免审批豁免必须精确到 tmp/ 前缀',
    );
    const tmpIndex = panel.indexOf("rel === '.cadt/tmp'");
    const cadtIndex = panel.indexOf("rel === '.cadt' || rel.startsWith('.cadt/')");
    assert.ok(tmpIndex >= 0 && cadtIndex > tmpIndex, 'tmp 豁免必须先于 .cadt 整树 risky 判定');
    // auto 档 risky 语义（纯函数层）：risky 转人工，非 risky 直发
    assert.equal(decidePermission({scope: 'auto', kind: 'write', subject: '.cadt/tmp/x.html', risky: false}).decision, 'allow');
    assert.equal(decidePermission({scope: 'auto', kind: 'write', subject: '.cadt/tmp/x.html', risky: true}).decision, 'ask');
    assert.equal(decidePermission({scope: 'auto', kind: 'write', subject: '.cadt/permissions.json', risky: true}).decision, 'ask');
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

test('normalizeDefaultScope：非法 / 缺省回退只读访问，合法档位原样保留', () => {
    const cases = [
        ['read', 'read'],
        ['edit', 'edit'],
        ['auto', 'auto'],
        ['full', 'full'],
        [' full ', 'full'],
        ['', 'read'],
        [null, 'read'],
        [undefined, 'read'],
        [42, 'read'],
        ['chat', 'read'],
        ['write', 'read'],
    ];
    for (const [raw, want] of cases) {
        assert.equal(normalizeDefaultScope(raw), want, 'input=' + String(raw));
    }
});

// ---------- read kind：工作区外读取的项目规则与决策 ----------

test('read 规则：行语法解析、目录树 glob 匹配与序列化', () => {
    const parsed = parseRuleLines([
        'Read(D:/Novel/**)',
        'Read(D:/Books/sub/**)',
        'Bash(git status:*)',
        'Read()',
    ].join('\n'), 'allow');
    assert.deepEqual(parsed.rules.read.allow, ['D:/Novel/**', 'D:/Books/sub/**']);
    assert.equal(parsed.errors.length, 1);
    assert.ok(parsed.errors[0].includes('规则内容为空'));
    assert.ok(formatRuleLines(parsed.rules, 'allow').includes('Read(D:/Novel/**)'));

    assert.equal(matchPermissionRule('read', 'D:/Novel/日记星辰/正文/番外0007.md', 'D:/Novel/**'), true);
    assert.equal(matchPermissionRule('read', 'D:/Novel', 'D:/Novel/**'), true);
    assert.equal(matchPermissionRule('read', 'D:/Novels/a.md', 'D:/Novel/**'), false);
    assert.equal(matchPermissionRule('read', 'd:' + String.fromCharCode(92) + 'novel' + String.fromCharCode(92) + 'a.md', 'D:/Novel/**'), true);
    // write 规则不串桶
    assert.equal(matchPermissionRule('write', 'D:/Novel/a.md', 'D:/Novel/**'), true);
    assert.equal(evaluatePermissionRules(parsed.rules, 'read', 'D:/Novel/x.md').decision, 'allow');
});

test('read 归一：非法条目忽略，规则桶完整初始化', () => {
    const rules = normalizePermissionRules({read: {allow: ['D:/A/**', ' ', 42], deny: ['D:/B/**']}});
    assert.deepEqual(rules.read.allow, ['D:/A/**']);
    assert.deepEqual(rules.read.deny, ['D:/B/**']);
    assert.deepEqual(rules.read.ask, []);
    assert.deepEqual(emptyPermissionRules().read, {allow: [], ask: [], deny: []});
});

test('read 决策链：deny 优先、sessionAllow 次之、auto 直放、read/edit 转人工', () => {
    const rules = {read: {allow: [], ask: [], deny: ['D:/secret/**']}};
    assert.deepEqual(
        decidePermission({scope: 'auto', kind: 'read', rules, subject: 'D:/secret/key.md'}),
        {decision: 'deny', source: 'project', rule: 'D:/secret/**'},
    );
    assert.deepEqual(
        decidePermission({scope: 'read', kind: 'read', rules: null, subject: 'D:/x.md', sessionAllow: true}),
        {decision: 'allow', source: 'session'},
    );
    assert.deepEqual(
        decidePermission({scope: 'auto', kind: 'read', rules: null, subject: 'D:/Novel/a.md'}),
        {decision: 'allow', source: 'auto'},
    );
    assert.deepEqual(
        decidePermission({scope: 'read', kind: 'read', rules: null, subject: 'D:/Novel/a.md'}),
        {decision: 'ask', source: 'scope'},
    );
    assert.deepEqual(
        decidePermission({scope: 'edit', kind: 'read', rules: null, subject: 'D:/Novel/a.md'}),
        {decision: 'ask', source: 'scope'},
    );
    // 项目 allow 规则：read/edit 档也放行
    assert.deepEqual(
        decidePermission({scope: 'read', kind: 'read', rules: {read: {allow: ['D:/Novel/**'], ask: [], deny: []}}, subject: 'D:/Novel/a.md'}),
        {decision: 'allow', source: 'project', rule: 'D:/Novel/**'},
    );
    // 项目 ask 规则压过 auto 档
    assert.deepEqual(
        decidePermission({scope: 'auto', kind: 'read', rules: {read: {allow: [], ask: ['D:/Watch/**'], deny: []}}, subject: 'D:/Watch/a.md'}),
        {decision: 'ask', source: 'project', rule: 'D:/Watch/**'},
    );
});

test('isWebApproval：read_image 的网图审批按网络处理，本地读图仍是读', () => {
    // 网图审批（read_image 传 URL / web_fetch）：文案说「本会话允许该网址」、审计记 kind web
    assert.equal(isWebApproval({kind: 'command', tool: 'read_image', web: true, command: 'https://a.com/x.png'}), true);
    assert.equal(isWebApproval({kind: 'command', tool: 'web_fetch', command: 'https://a.com/'}), true,
        '旧会话没有 web 字段，按工具名回落');
    // 本地读图是 read 审批，不能套网络文案
    assert.equal(isWebApproval({kind: 'read', tool: 'read_image', path: 'D:/a.png'}), false);
    // 普通命令审批 / 空值
    assert.equal(isWebApproval({kind: 'command', tool: 'run_command', command: 'npm test'}), false);
    assert.equal(isWebApproval({kind: 'command', tool: 'run_command', web: false, command: 'npm test'}), false);
    assert.equal(isWebApproval(null), false);
});

test('档位竞态：审批等待期间提升到完全权限后，项目 ask 之外一律放行', () => {
    // full + 非项目来源 → 重判放行（分类器/危险/逐次询问都算）
    assert.equal(scopeUpgradedToFull('full', 'classifier'), true);
    assert.equal(scopeUpgradedToFull('full', 'local-classifier'), true);
    assert.equal(scopeUpgradedToFull('full', 'dangerous'), true);
    assert.equal(scopeUpgradedToFull('full', 'scope'), true);
    assert.equal(scopeUpgradedToFull('full', ''), true);
    // 项目 ask 规则有意压过 full：不参与重判
    assert.equal(scopeUpgradedToFull('full', 'project'), false);
    // 非 full 档一律不重判（仍按原判定弹卡）
    assert.equal(scopeUpgradedToFull('auto', 'classifier'), false);
    assert.equal(scopeUpgradedToFull('edit', 'scope'), false);
    assert.equal(scopeUpgradedToFull('read', 'classifier'), false);
});

test('留痕 actor：自动放行不许记成「用户批准」', () => {
    // 用户在审批卡上拍板 / 用户预写的规则与会话授权 → user
    for (const source of ['user', 'project', 'session']) {
        assert.equal(permissionAuditActor(source), 'user', source + ' 应是用户裁定');
    }
    // 模型侧自动判定 → ai（这正是历史实现一律写成 user 的那批）
    for (const source of ['readonly', 'family', 'git-flow', 'classifier', 'local-classifier', 'full', 'auto']) {
        assert.equal(permissionAuditActor(source), 'ai', source + ' 应是 AI 自动判定');
    }
    // 宿主强制与内置默认 → system
    for (const source of ['worktree-isolation', 'agent-caps', 'agent-full', 'agent-caps-go', 'default']) {
        assert.equal(permissionAuditActor(source), 'system', source + ' 应是宿主 / 内置');
    }
    // 未知 / 空来源保守归 ai：宁可少记人的功劳，也不能把自动放行记成人工批准
    for (const source of ['', '   ', null, undefined, 'something-new']) {
        assert.equal(permissionAuditActor(source), 'ai');
    }
});

test('留痕 actor 与决策链对齐：自动来源全覆盖，且都不是 user', () => {
    // 决策链实际会产出的「自动」判定（只读 / 家族 / git 快捷 / 分类器 / 完全权限 / auto 写与读 / web 内置默认）
    const cases = [
        decidePermission({scope: 'auto', kind: 'command', readOnly: true}),
        decidePermission({scope: 'auto', kind: 'command', familyAuto: true}),
        decidePermission({scope: 'auto', kind: 'command', gitFlowSafe: true}),
        decidePermission({scope: 'auto', kind: 'command', classifierEnabled: true}),
        decidePermission({scope: 'full', kind: 'command'}),
        decidePermission({scope: 'auto', kind: 'write'}),
        decidePermission({scope: 'auto', kind: 'read'}),
        decidePermission({scope: 'edit', kind: 'web'}),
    ];
    for (const decision of cases) {
        assert.notEqual(decision.decision, 'ask', '这批输入本应自动判定：' + JSON.stringify(decision));
        assert.notEqual(permissionAuditActor(decision.source), 'user',
            '自动判定不许记成用户批准：' + decision.source);
    }
    // 唯一记 user 的自动路径是「用户自己点过本会话允许」
    assert.equal(permissionAuditActor(decidePermission({scope: 'read', kind: 'command', sessionAllow: true}).source), 'user');
});
