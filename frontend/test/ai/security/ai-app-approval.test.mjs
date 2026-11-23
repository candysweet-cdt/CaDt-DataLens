// ai-app-approval.test.mjs：插件来源判定（官方市场）与安装/卸载权限矩阵、
// 动作审批规格归一的护栏。见 app_control 的 install_plugin / uninstall_plugin / set_setting_row。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isOfficialPluginSource,
    normalizeActionApprovalSpec,
    parsePluginRepoUrl,
    pluginInstallRoute,
    pluginUninstallRoute,
} from '../../../src/ai/security/ai-app-approval.js';

test('parsePluginRepoUrl：https / git@ / ssh / .git 后缀', () => {
    assert.deepEqual(parsePluginRepoUrl('https://gitee.com/cadt-datalens-plugins/git-flow'), {
        host: 'gitee.com', org: 'cadt-datalens-plugins', repo: 'git-flow', fullName: 'cadt-datalens-plugins/git-flow',
    });
    assert.equal(parsePluginRepoUrl('https://github.com/cadt-datalens-plugins/bak-json.git').repo, 'bak-json');
    assert.equal(parsePluginRepoUrl('git@github.com:cadt-datalens-plugins/bak-json.git').host, 'github.com');
    assert.equal(parsePluginRepoUrl('ssh://git@gitee.com/cadt-datalens-plugins/git-flow').org, 'cadt-datalens-plugins');
    assert.equal(parsePluginRepoUrl(''), null);
    assert.equal(parsePluginRepoUrl('not a url'), null);
    assert.equal(parsePluginRepoUrl('https://gitee.com/only-org'), null);
});

test('isOfficialPluginSource：Gitee/GitHub 的 cadt-datalens-plugins 才算官方', () => {
    assert.equal(isOfficialPluginSource('https://gitee.com/cadt-datalens-plugins/git-flow'), true);
    assert.equal(isOfficialPluginSource('https://www.github.com/cadt-datalens-plugins/bak-json'), true);
    assert.equal(isOfficialPluginSource('git@github.com:cadt-datalens-plugins/bak-json.git'), true);
    assert.equal(isOfficialPluginSource('https://gitee.com/someone/git-flow'), false);
    assert.equal(isOfficialPluginSource('https://gitlab.com/cadt-datalens-plugins/git-flow'), false);
    assert.equal(isOfficialPluginSource('https://github.com/evil/cadt-datalens-plugins'), false);
});

test('安装矩阵：full 直通 / auto 官方直通与非官方审批 / edit 全审批 / read 拒绝', () => {
    assert.equal(pluginInstallRoute('full', false), 'direct');
    assert.equal(pluginInstallRoute('auto', true), 'direct');
    assert.equal(pluginInstallRoute('auto', false), 'approve');
    assert.equal(pluginInstallRoute('edit', true), 'approve');
    assert.equal(pluginInstallRoute('edit', false), 'approve');
    assert.equal(pluginInstallRoute('read', true), 'deny');
    assert.equal(pluginInstallRoute('read', false), 'deny');
});

test('卸载矩阵：full 直通，read 拒绝，其余一律审批（永久删除）', () => {
    assert.equal(pluginUninstallRoute('full'), 'direct');
    assert.equal(pluginUninstallRoute('auto'), 'approve');
    assert.equal(pluginUninstallRoute('edit'), 'approve');
    assert.equal(pluginUninstallRoute('read'), 'deny');
});

test('动作审批规格归一：字段裁剪 / 危险度兜底 / 警告上限', () => {
    const ok = normalizeActionApprovalSpec({
        action: 'set_setting',
        title: '修改设置：层级上限',
        target: 'AI / 子代理 / 层级上限（ai-opt-subagent-depth）',
        oldValue: '3',
        newValue: '8',
        risk: 'high',
        warnings: ['放宽层级会让 AI 更深地自我派发'],
        locate: {pane: 'ai', row: 'ai-opt-subagent-depth'},
        sessionId: 's1',
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.spec.risk, 'high');
    assert.equal(ok.spec.locate.pane, 'ai');
    assert.equal(ok.spec.action, 'set_setting');
    const fallback = normalizeActionApprovalSpec({title: 'x', risk: 'nope'});
    assert.equal(fallback.spec.risk, 'medium');
    const many = normalizeActionApprovalSpec({title: 'x', warnings: Array.from({length: 10}, (_, i) => 'w' + i)});
    assert.equal(many.spec.warnings.length, 6);
    assert.equal(normalizeActionApprovalSpec({}).ok, false);
    assert.equal(normalizeActionApprovalSpec({title: '   '}).ok, false);
});
