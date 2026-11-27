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
    assert.deepEqual(OTHER_ACTIONS.map((item) => item.id), ['cognition-maintain', 'release-notes', 'outline-maintain']);
    assert.deepEqual(OTHER_ACTIONS.map((item) => item.label), ['维护认知索引', '生成更新日志', '维护文件大纲']);
    const cognition = OTHER_ACTIONS.find((item) => item.id === 'cognition-maintain');
    assert.equal(cognition.requiresCognition, true, '维护认知索引只在 aiCognition 打开时显示');
    assert.equal(OTHER_ACTIONS.find((item) => item.id === 'release-notes').requiresCognition, undefined);
    assert.equal(OTHER_ACTIONS.find((item) => item.id === 'outline-maintain').requiresCognition, undefined);
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

test('提交/推送/拉取提示词覆盖第 5 题多选与五项行为偏好字段', () => {
    const fiveFields = ['allowCrossFiles', 'autoResolveConflict', 'autoSetUpstream', 'autoStashOnPull', 'allowAmend'];
    // 首次询问与 JSON 示例出现在提交类流程（STYLE_RULES 所在处）
    for (const id of ['commit', 'commit-push']) {
        const text = buildGitActionPrompt(id, {root: 'D:/repo', branch: 'main'});
        assert.ok(text.includes('最多 8 个问题'), id + ' 应提示最多 8 题');
        assert.ok(text.includes('附加行为偏好'), id + ' 应包含第 5 题');
        assert.ok(text.includes('多选'), id + ' 第 5 题应为多选');
        assert.ok(text.includes('"version":3'), id + ' JSON 应升到 v3');
        for (const field of fiveFields) {
            assert.ok(text.includes('"' + field + '":false'), id + ' JSON 示例应含 ' + field);
            assert.ok(text.includes(field + '=true'), id + ' 应说明 ' + field + ' 的含义');
        }
        assert.ok(text.includes('remark'), id + ' 应说明兼容既有 remark 字段');
        // 第 6 题：多远端才问，repository 字段进入 JSON 示例
        assert.ok(text.includes('第 6 题'), id + ' 应包含第 6 题');
        assert.ok(text.includes('多于一个上游远端'), id + ' 应说明仅多远端时才问第 6 题');
        assert.ok(text.includes('git remote'), id + ' 应说明先检测远端');
        assert.ok(text.includes('"repository":["origin"]'), id + ' JSON 示例应含 repository 字段');
    }
    // 附加行为偏好覆盖规则注入所有四个 git 流程
    for (const id of ['commit', 'commit-push', 'push', 'pull']) {
        const text = buildGitActionPrompt(id, {root: 'D:/repo', branch: 'main'});
        assert.ok(text.includes('附加行为偏好 · 按配置覆盖'), id + ' 应注入行为覆盖规则');
        assert.ok(text.includes('逐文件'), id + ' 应说明冲突逐文件智能判断');
        assert.ok(text.includes('git stash'), id + ' 应说明拉取自动 stash');
        assert.ok(text.includes('git push -u'), id + ' 应说明推送自动设上游');
        assert.ok(text.includes('--amend'), id + ' 应说明 amend 偏好');
    }
    // repository 联动只出现在推送类流程
    for (const id of ['push', 'commit-push']) {
        const text = buildGitActionPrompt(id, {root: 'D:/repo', branch: 'main'});
        assert.ok(text.includes('repository 非空时按其中每个远端逐一执行 git push'), id + ' 应按 repository 逐一推送');
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
