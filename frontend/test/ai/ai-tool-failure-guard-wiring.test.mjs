// ai-tool-failure-guard-wiring.test.mjs：工具熔断的接线守卫（纯函数之外的「真的接上了吗」）。
// 纯函数测试只证明算法对，接线漏了照样不生效——这里用源码断言钉住 executeTool 包装层、
// 回合首轮 reset、配置闭环、应用消息/通知投递与子代理隔离，防止改代码时静默断线。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const src = (rel) => readFileSync(fileURLToPath(new URL('../../src/' + rel, import.meta.url)), 'utf8');
const panelSrc = src('ai/ai-panel.js');
const settingsSrc = src('ai/settings/ai-settings-dialog.js');
const htmlSrc = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
const treeSrc = src('settings/settings-tree.js');

// 截取 executeTool 包装层（到 executeToolInner 定义前），避免被文件里别的同名调用干扰。
const execBlock = (() => {
    const start = panelSrc.indexOf('async function executeTool(name, args, ctx) {');
    const end = panelSrc.indexOf('async function executeToolInner(', start);
    assert.ok(start > 0 && end > start, 'executeTool 包装层必须存在');
    return panelSrc.slice(start, end);
})();

test('executeTool 包装层：先查熔断，命中返回 tool 结果文本（不 throw）', () => {
    assert.match(execBlock, /toolFailureGuard\.shouldBlock\(name, args, sessionId\)/,
        '必须在执行工具前查熔断');
    assert.match(execBlock, /if \(blocked\) \{[\s\S]*?return toolFailureToolResultText\(\);/,
        '熔断命中必须返回 tool 结果文本——throw 会被记成工具失败诱发再试');
});

test('executeTool 包装层：失败记账、成功清零', () => {
    assert.match(execBlock, /catch \(e\) \{[\s\S]*?toolFailureGuard\.recordFailure\(name, args, e, sessionId\)/,
        '工具抛错必须记失败');
    assert.match(execBlock, /toolFailureGuard\.recordSuccess\(name, args, sessionId\)/,
        '工具成功必须清零');
});

test('熔断投递：urgent 应用消息 + notifyDesktop，且只对主对话（子代理隔离）', () => {
    assert.match(execBlock, /!\(Number\(ctx && ctx\.agentDepth\) > 0\)/,
        '必须排除子代理，避免投进主会话信箱串台');
    assert.match(execBlock, /deliverAgentNotice\(ctx\.session, toolFailureNotice\(name, args, blocked\)\)/,
        '必须投 urgent 应用消息（工具轮边界折叠成 user 消息）');
    assert.match(execBlock, /notifyDesktop\(\{[\s\S]*?sessionId,[\s\S]*?\}\)/,
        '必须发右下角通知并传 sessionId（用户不在当前会话才弹）');
});

test('guard 创建用 getter 实时读配置阈值（改设置立即生效）', () => {
    assert.match(panelSrc, /createToolFailureGuard\(\{[\s\S]*?maxAttempts: \(\) => config\.toolFailureMax[\s\S]*?\}\)/,
        'maxAttempts 必须是 getter，不能是固定值快照');
});

test('配置闭环：归一化 → 设置渲染 → change 写回 → 持久化', () => {
    assert.match(panelSrc, /toolFailureMax: resolveToolFailureMax\(stored\.toolFailureMax\)/,
        'config 归一化必须走 resolveToolFailureMax（0 关闭 / 有效 3–20）');
    assert.match(settingsSrc, /opt\.toolFailureMax\.value = String\(resolveToolFailureMax\(getConfig\(\)\.toolFailureMax\)\)/,
        '设置页渲染必须走同一归一化');
    assert.match(settingsSrc, /getConfig\(\)\.toolFailureMax = resolveToolFailureMax\(opt\.toolFailureMax\.value\)[\s\S]*?saveAIConfig\(\)/,
        'change 必须写回并持久化');
});

test('回合首轮 reset 必须在 pre-step 钩子之后（钩子失败不被抹掉）', () => {
    const at = panelSrc.indexOf("if (s.roundNo === 1) {", panelSrc.indexOf('function startRound('));
    assert.ok(at > 0, 'startRound 里必须有首轮分支');
    const block = panelSrc.slice(at, at + 800);
    const hookAt = block.indexOf("fireHook('agent/pre-step'");
    const resetAt = block.indexOf('toolFailureGuard.reset()');
    assert.ok(hookAt > 0 && resetAt > hookAt,
        'reset 必须在 pre-step 钩子之后——钩子可能同步调工具，其失败不该被 reset 抹掉');
});

test('设置项登记：select 选项在 resolveToolFailureMax 值域内 + 风险登记', () => {
    const sel = htmlSrc.match(/<select id="ai-opt-tool-failure-max"[\s\S]*?<\/select>/);
    assert.ok(sel, '设置页必须有 toolFailureMax 的 select');
    const values = [...sel[0].matchAll(/<option value="(\d+)"/g)].map((m) => Number(m[1]));
    assert.ok(values.includes(0), '必须有「关闭」选项（value=0）');
    assert.ok(values.includes(5), '必须有默认值 5');
    for (const v of values) {
        assert.ok(v === 0 || (v >= 3 && v <= 20), '选项 ' + v + ' 必须落在 0 或 3–20');
    }
    assert.ok(treeSrc.includes("'ai-opt-tool-failure-max'"), 'settings-tree 必须有风险登记');
});
