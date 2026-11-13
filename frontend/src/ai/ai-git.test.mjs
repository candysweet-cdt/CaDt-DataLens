import test from 'node:test';
import assert from 'node:assert/strict';
import {GIT_ACTIONS, GIT_COMMIT_STYLE_PATH, buildGitActionPrompt} from './ai-git.js';

test('Git 动作顺序与标签符合菜单约定', () => {
    assert.deepEqual(GIT_ACTIONS.map((item) => item.id), ['commit-push', 'commit', 'push', 'pull']);
    assert.deepEqual(GIT_ACTIONS.map((item) => item.label), ['提交并推送', '提交代码', '推送代码', '拉取代码']);
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
