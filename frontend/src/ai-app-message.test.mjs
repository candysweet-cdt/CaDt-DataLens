import test from 'node:test';
import assert from 'node:assert/strict';
import {APP_MESSAGE_ICONS, appMessageIcon, detectAppMessage, normalizeAppMessage} from './ai-app-message.js';

test('normalizeAppMessage 补齐默认值并截断超长字段', () => {
    assert.deepEqual(normalizeAppMessage({kind: 'git', label: 'Git 快捷操作 · 提交'}), {
        kind: 'git',
        label: 'Git 快捷操作 · 提交',
        icon: '',
    });
    assert.equal(normalizeAppMessage(null).label, '应用消息');
    assert.equal(normalizeAppMessage({label: 'x'.repeat(200)}).label.length, 80);
    assert.equal(normalizeAppMessage({kind: 'k'.repeat(100)}).kind.length, 32);
    assert.equal(normalizeAppMessage({icon: 'i'.repeat(100)}).icon.length, 32);
});

test('appMessageIcon 支持 kind 映射、自定义图标与未知回落', () => {
    assert.equal(appMessageIcon({kind: 'git'}), 'git');
    assert.equal(appMessageIcon({kind: 'schedule'}), 'clock');
    assert.equal(appMessageIcon({kind: 'plugin'}), APP_MESSAGE_ICONS.plugin);
    assert.equal(appMessageIcon({kind: 'unknown-kind'}), 'info');
    assert.equal(appMessageIcon({kind: 'git', icon: 'warn'}), 'warn');
    assert.equal(appMessageIcon({kind: 'git', icon: 'not-a-real-icon'}), 'git');
});

test('旧会话按固定前缀识别应用消息', () => {
    const git = detectAppMessage('［Git 快捷操作 · 提交并推送］\n工作区：D:/repo');
    assert.deepEqual(git, {kind: 'git', label: 'Git 快捷操作 · 提交并推送', icon: ''});
    const scheduled = detectAppMessage('[定时任务 · 每日巡检]\n请检查构建');
    assert.deepEqual(scheduled, {kind: 'schedule', label: '定时任务 · 每日巡检', icon: ''});
    assert.equal(detectAppMessage('普通用户消息'), null);
    assert.equal(detectAppMessage(''), null);
});
