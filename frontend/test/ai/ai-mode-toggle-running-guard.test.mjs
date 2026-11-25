// 会话运行中禁用「计划 / 隔离」用户入口的接线护栏。
//
// 需求（2026-11-24）：会话正在运行时，composer 的「计划」「隔离」两个 pill 与权限菜单里
// 对应的两项都不能给用户点（纯 UI 防误触）；AI 自己调工具进入两种模式不受影响——
// 底层 setPlanMode 的 force / worktree.blockFor 的 allowRunning 守卫保持原样。
// 依赖真实 DOM / 后端，只能在源码层面锁住这些接线点（同 ai-plan-worktree.test.mjs 惯例）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const panel = read('../../src/ai/ai-panel.js');
const worktree = read('../../src/ai/tools/ai-worktree.js');
const css = read('../../src/style.css');

function sliceFunction(source, marker) {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, '找不到函数：' + marker);
    const rest = source.slice(start + marker.length);
    const next = rest.search(/\n {4}(?:async )?function /);
    return next < 0 ? source.slice(start) : source.slice(start, start + marker.length + next);
}

test('syncModeTogglesRunning：按当前会话的流/压缩判运行，同时禁用两个 pill', () => {
    const fn = sliceFunction(panel, 'function syncModeTogglesRunning() {');
    assert.match(fn, /const session = currentSession\(\)/);
    assert.match(fn, /streamOf\(session\.id\) \|\| compactOf\(session\.id\)/, '口径与底层守卫一致：流或压缩在跑');
    assert.match(fn, /el\.plan\.disabled = running/);
    assert.match(fn, /el\.worktreeToggle\.disabled = running/);
});

test('setStreamingUI 在流开始/结束都调用 syncModeTogglesRunning', () => {
    const fn = sliceFunction(panel, 'function setStreamingUI() {');
    assert.match(fn, /syncModeTogglesRunning\(\)/, '流态变化必须同步两个 pill 的禁用态');
});

test('权限菜单「计划模式」「隔离工作区」两项运行中 disabled', () => {
    const fn = sliceFunction(panel, 'function showPermissionMenu() {');
    // 菜单里算运行中的口径与 pill 同源
    assert.match(fn, /streamOf\(session\.id\) \|\| compactOf\(session\.id\)/);
    const planItem = fn.slice(fn.indexOf("label: '计划模式'"), fn.indexOf("label: '隔离工作区'"));
    assert.match(planItem, /disabled: running/, '计划模式项要禁用');
    const wtItem = fn.slice(fn.indexOf("label: '隔离工作区'"));
    assert.match(wtItem, /disabled: running/, '隔离工作区项要禁用');
});

test('底层 AI 路径不受影响：force / allowRunning 两个绕过开关仍在', () => {
    const setPlan = sliceFunction(panel, 'function setPlanMode(on, announce, force, target) {');
    assert.match(setPlan, /force !== true/, 'AI 工具仍可用 force 切计划模式');
    const createForSession = sliceFunction(worktree, 'async function createForSession(');
    assert.match(createForSession, /opts && opts\.allowRunning/, 'AI 工具仍可用 allowRunning 建隔离区');
});

test('CSS 有 pill 禁用态视觉（含亮色主题覆盖）', () => {
    assert.match(css, /\.ai-pill:disabled/);
    assert.match(css, /html\[data-theme="light"\] \.ai-composer \.ai-pill:disabled/);
});
