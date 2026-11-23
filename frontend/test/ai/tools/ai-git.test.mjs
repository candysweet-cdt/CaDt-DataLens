import test from 'node:test';
import assert from 'node:assert/strict';
import {GIT_ACTIONS, OTHER_ACTIONS, GIT_COMMIT_STYLE_PATH, buildGitActionPrompt} from '../../../src/ai/tools/ai-git.js';
import {ICONS} from '../../../src/core/icons.js';

test('Git 动作顺序与标签符合菜单约定', () => {
    assert.deepEqual(GIT_ACTIONS.map((item) => item.id), ['commit-push', 'commit', 'push', 'pull']);
    assert.deepEqual(GIT_ACTIONS.map((item) => item.label), ['提交并推送', '提交代码', '推送代码', '拉取代码']);
    // 菜单图标走 core/icons.js 命名注册表；每个动作必须带已登记的图标键
    assert.deepEqual(GIT_ACTIONS.map((item) => item.icon), ['git-commit-push', 'git-commit', 'upload', 'download']);
    for (const item of GIT_ACTIONS) {
        assert.ok(ICONS[item.icon], '未登记的图标键：' + item.icon);
        assert.equal(item.isGit, true, 'git 动作必须带 isGit 标记（决定是否打 git 写命令豁免令牌）');
    }
});

test('其他操作动作表：维护认知索引随开关显隐，图标全部已登记', () => {
    assert.deepEqual(OTHER_ACTIONS.map((item) => item.id), ['cognition-maintain', 'release-notes']);
    assert.deepEqual(OTHER_ACTIONS.map((item) => item.label), ['维护认知索引', '生成更新日志']);
    const cognition = OTHER_ACTIONS.find((item) => item.id === 'cognition-maintain');
    assert.equal(cognition.requiresCognition, true, '维护认知索引只在 aiCognition 打开时显示');
    assert.equal(OTHER_ACTIONS.find((item) => item.id === 'release-notes').requiresCognition, undefined);
    for (const item of OTHER_ACTIONS) {
        assert.ok(ICONS[item.icon], '未登记的图标键：' + item.icon);
        assert.ok(item.msgIcon && ICONS[item.msgIcon], '应用消息图标未登记：' + item.msgIcon);
        assert.notEqual(item.isGit, true, '其他操作不应打 git 写命令豁免令牌');
    }
});

test('提交类提示词包含风格配置、首次询问与超时默认', () => {
    for (const id of ['commit', 'commit-push']) {
        const text = buildGitActionPrompt(id, {root: 'D:/repo', branch: 'main'});
        assert.ok(text.includes(GIT_COMMIT_STYLE_PATH));
        assert.ok(text.includes('ask_user'));
        assert.ok(text.includes('timeoutAction="recommended"'));
        assert.ok(text.includes('Conventional Commits'));
        assert.ok(text.includes('Co-authored-by'));
        assert.ok(text.includes('不要 git add -A'));
        assert.ok(text.includes('granularity'));
        assert.ok(text.includes('提交粒度'));
    }
});

test('推送/拉取提示词覆盖非快进自动合并与冲突先询问', () => {
    for (const id of ['push', 'pull', 'commit-push']) {
        const text = buildGitActionPrompt(id, {root: 'D:/repo', branch: 'dev'});
        assert.ok(text.includes('git pull --no-rebase --no-edit'));
        assert.ok(text.includes('不要询问用户'));
        assert.ok(text.includes('ask_user'));
        assert.ok(text.includes('冲突'));
    }
    for (const id of ['push', 'commit-push']) {
        const text = buildGitActionPrompt(id, {root: 'D:/repo', branch: 'dev'});
        assert.ok(text.includes('不要使用 git push --force'));
    }
});

test('拉取提示词保护本地未提交改动', () => {
    const text = buildGitActionPrompt('pull', {root: 'D:/repo', branch: 'main'});
    assert.ok(text.includes('本地未提交改动'));
    assert.ok(text.includes('不要丢弃用户改动'));
});

test('工作区与分支注入提示词，未知动作返回空串', () => {
    const text = buildGitActionPrompt('pull', {root: 'D:/repo', branch: 'main'});
    assert.ok(text.includes('D:/repo'));
    assert.ok(text.includes('main'));
    assert.equal(buildGitActionPrompt('nope', {}), '');
});

test('维护认知索引提示词：先 status、只经 cognition_edit、不直写卷', () => {
    const text = buildGitActionPrompt('cognition-maintain', {root: 'D:/repo'});
    assert.ok(text.includes('D:/repo'));
    assert.ok(text.includes('cognition_status'));
    assert.ok(text.includes('cognition_edit'));
    assert.ok(text.includes('scene=code'));
    assert.ok(text.includes('不要用 write_file / edit_file 直写'));
    assert.ok(text.includes('meta'));
    assert.ok(text.includes('CAS'));
});

test('生成更新日志提示词：面向用户、分组、不擅自写文件', () => {
    const text = buildGitActionPrompt('release-notes', {root: 'D:/repo', branch: 'dev'});
    assert.ok(text.includes('D:/repo'));
    assert.ok(text.includes('dev'));
    assert.ok(text.includes('新增 / 改进 / 修复 / 移除'));
    assert.ok(text.includes('不要擅自写入文件'));
    assert.ok(text.includes('CHANGELOG.md'));
});
