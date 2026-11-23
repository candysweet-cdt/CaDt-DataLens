// ai-app-actions.test.mjs —— app_control 动作表的三方一致守卫。
//
// app_control 的动作清单有三份，改一处忘另一处都不会报错：
//   1. cadt-ui 技能里的「动作表」（`ai-constants.js`）：**模型唯一能看到的动作清单**——
//      表里写了但代码没有 → 模型调用即「未知动作」；代码有但表里没写 → 模型永远不知道能用；
//   2. `APP_ACTIONS`（`main.js`）：错误提示与可用性提示列的是它；
//   3. `runAppAction` 的 switch（`main.js`）+ MCP 代配的 `MCP_CONFIG_ACTIONS`（`ai-panel.js`）：
//      真正执行的分发。
//
// 本守卫三者对账。技能表要求「一条一个动作」的固定格式（历史上同一行用 `；`/`/` 塞多个动作，
// 没法机械核对）——格式本身也是测试的一部分。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const srcRoot = new URL('../../src/', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, srcRoot), 'utf8');

const constantsSrc = read('ai/core/ai-constants.js');
const panelSrc = read('ai/ai-panel.js');
const mainSrc = read('main.js');

// 1) cadt-ui 技能的动作表：`- action_name …`
function skillActions(text) {
    const start = text.indexOf("name: 'cadt-ui'");
    assert.ok(start >= 0, '找不到 cadt-ui 技能');
    const nextSkill = text.indexOf("name: 'cadt-gen-models'", start);
    const segment = text.slice(start, nextSkill > 0 ? nextSkill : text.length);
    return [...segment.matchAll(/^\s*'- ([a-z][a-z0-9_]+)(?=[ {：])/gm)].map((m) => m[1]);
}

// 2) main.js 的 APP_ACTIONS 数组
function listedActions(text) {
    const start = text.indexOf('const APP_ACTIONS = [');
    assert.ok(start >= 0, '找不到 APP_ACTIONS');
    const end = text.indexOf('];', start);
    return [...text.slice(start, end).matchAll(/'([a-z][a-z0-9_]+)'/g)].map((m) => m[1]);
}

// 3a) runAppAction 的 switch 分发
// 只按前缀定位（签名后续可能追加参数，如 callerSessionId）；switch 体仍取到下一个函数定义为止。
function dispatchedActions(text) {
    const signature = 'async function runAppAction(action, params, scope';
    const start = text.indexOf(signature);
    assert.ok(start >= 0, '找不到 runAppAction');
    const rest = text.slice(start + signature.length);
    const next = /\n(?:async )?function [A-Za-z_]/.exec(rest);
    const body = next ? rest.slice(0, next.index) : rest;
    return [...body.matchAll(/case '([a-z][a-z0-9_]+)':/g)].map((m) => m[1]);
}

// 3b) MCP 代配动作（不进 switch，走 runMcpConfigAction）
function mcpActions(text) {
    const hit = /const MCP_CONFIG_ACTIONS = \[([^\]]*)\]/.exec(text);
    assert.ok(hit, '找不到 MCP_CONFIG_ACTIONS');
    return [...hit[1].matchAll(/'([a-z][a-z0-9_]+)'/g)].map((m) => m[1]);
}

// 允许「已实现但刻意不给模型」的动作：{动作: 原因}。
// 生命周期钩子 2026-11-21 改名（pre_command → lifecycle_hook）：旧名保留为静默别名，
// 历史会话 / 记忆里的调用仍能命中同一分支，但技能表只下发新名——别再教模型旧词。
const UNDOCUMENTED = {
    get_pre_commands: '生命周期钩子旧动作名（现 get_lifecycle_hooks），仅兼容历史调用',
    add_pre_command: '生命周期钩子旧动作名（现 add_lifecycle_hook），仅兼容历史调用',
    update_pre_command: '生命周期钩子旧动作名（现 update_lifecycle_hook），仅兼容历史调用',
    remove_pre_command: '生命周期钩子旧动作名（现 remove_lifecycle_hook），仅兼容历史调用',
};

const skill = skillActions(constantsSrc);
const registered = listedActions(mainSrc);
const dispatched = [...dispatchedActions(mainSrc), ...mcpActions(panelSrc)];

test('技能动作表 ↔ APP_ACTIONS 双向一致', () => {
    const notInApp = skill.filter((action) => !registered.includes(action));
    assert.deepEqual(notInApp, [], '技能里写了这些动作，但 APP_ACTIONS 没登记（模型调用会失败）');
    const notInSkill = registered.filter((action) => !skill.includes(action) && !UNDOCUMENTED[action]);
    assert.deepEqual(notInSkill, [],
        '这些动作实现了但技能表没写：模型永远不知道能调；确属内部动作就登记本文件的 UNDOCUMENTED 并写原因');
});

test('每个登记的动作都有分发（switch 或 MCP 代配）', () => {
    const missing = registered.filter((action) => !dispatched.includes(action));
    assert.deepEqual(missing, [], '这些动作在 APP_ACTIONS 里但没有执行分支：调用即「未知动作」');
});

test('分发里没有未登记的动作（删动作时清干净）', () => {
    const phantom = dispatched.filter((action) => !registered.includes(action));
    assert.deepEqual(phantom, [], '这些动作有执行分支但不在 APP_ACTIONS 里（删动作时没清分发 / 错误提示不会列出）');
});

test('动作清单无重复', () => {
    for (const [label, list] of [['技能表', skill], ['APP_ACTIONS', registered]]) {
        const dup = [...new Set(list.filter((item, index) => list.indexOf(item) !== index))];
        assert.deepEqual(dup, [], label + ' 里有重复动作');
    }
});

// 改名后的别名方向守卫：旧名只能做静默别名，不能回潮进技能表；新名必须两处齐全。
test('生命周期钩子：技能表只发新名，旧名仅兼容', () => {
    const legacy = ['get_pre_commands', 'add_pre_command', 'update_pre_command', 'remove_pre_command'];
    const next = ['get_lifecycle_hooks', 'add_lifecycle_hook', 'update_lifecycle_hook', 'remove_lifecycle_hook'];
    for (const action of legacy) {
        assert.ok(!skill.includes(action), '技能表不应再下发旧名：' + action);
        assert.ok(UNDOCUMENTED[action], '旧名要在 UNDOCUMENTED 登记兼容原因：' + action);
    }
    for (const action of next) {
        assert.ok(skill.includes(action), '新名必须进技能表：' + action);
        assert.ok(registered.includes(action), '新名必须进 APP_ACTIONS：' + action);
        assert.ok(dispatched.includes(action), '新名必须有分发：' + action);
    }
});
