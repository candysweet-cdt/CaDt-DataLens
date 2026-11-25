// ai-new-session-focus.test.mjs —— app_control 的 ai_new_session 动作「后台新建 / focus 抢占」合同，
// 以及 scope / model / group 三个可选参数的接线（继承、越宽报错、分组归一）。
//
// bridgeNewSession 在 ai-panel.js 的大闭包里，node 无法直接实例化（依赖 Wails 后端与 DOM），
// 因此按项目 wiring 测试的惯例做源码级断言：锁住参数的三处接线（技能表 / main.js 分发 /
// bridgeNewSession 实现）与后台路径的关键不变量（不切 currentSession、不碰 UI、走 startSessionTurn）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const panel = read('../../src/ai/ai-panel.js');
const main = read('../../src/main.js');
const constants = read('../../src/ai/core/ai-constants.js');

function sliceFunction(source, marker, nextMarker = '\n        bridge') {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, '找不到函数：' + marker);
    const end = source.indexOf(nextMarker, start + marker.length);
    return source.slice(start, end < 0 ? undefined : end);
}

const newSessionFn = () => sliceFunction(panel, 'bridgeNewSession: async (opts2) => {');

test('bridgeNewSession 解析 focus 参数，默认后台', () => {
    const fn = newSessionFn();
    assert.match(fn, /const focus = !!\(opts2 && opts2\.focus\);/);
    // focus 分支必有 open(true)+newSession()（抢占），否则语义反了
    const focusBranch = fn.slice(fn.indexOf('if (focus) {'), fn.indexOf('// 后台路径'));
    assert.match(focusBranch, /open\(true\);/);
    assert.match(focusBranch, /newSession\(\);/);
    assert.match(focusBranch, /submitText\(message\)/);
    // 抢占路径也如实带出发送结果（sent），不能误报「已发送」
    assert.match(focusBranch, /const sent = message \? !!\(await submitText\(message\)\) : null;/);
    assert.match(focusBranch, /id: session\.id, title: session\.title, sent,/);
});

test('后台路径：不打开面板、不切会话、不碰输入区，走 startSessionTurn', () => {
    const fn = newSessionFn();
    const bg = fn.slice(fn.indexOf('// 后台路径'));
    // 后台路径不得出现抢占三件套
    assert.doesNotMatch(bg, /\bopen\(true\)/);
    assert.doesNotMatch(bg, /\bnewSession\(\)/);
    assert.doesNotMatch(bg, /\bsubmitText\(/);
    assert.doesNotMatch(bg, /setActiveSessionId\(/);
    // 必须经会话级内核起轮，且落盘 + 刷列表
    assert.match(bg, /createSessionData\(title \|\| undefined, \{/);
    assert.match(bg, /sessions\.push\(session\)/);
    assert.match(bg, /persistSessions\(\)/);
    assert.match(bg, /startSessionTurn\(session, message\)/);
});

test('后台继承调用方会话：省略 scope/model 走继承，callerSessionId 命中优先', () => {
    const fn = newSessionFn();
    // 基准是「调用方自己的会话」：callerSessionId 命中优先，回退面板当前会话
    assert.match(fn, /const baseSession = \(callerId \? sessionById\(callerId\) : null\) \|\| currentSession\(\);/);
    assert.match(fn, /const baseScope = currentScopeOf\(baseSession\) \|\| 'read';/);
    // 省略 scope = 继承调用方档位（resolvedScope 初值 = baseScope）
    assert.match(fn, /let resolvedScope = baseScope;/);
    // 调用方在后台时，省略 model 从 baseSession 取（不用 inheritModelRef——它读 currentSession 是别人）
    assert.match(fn, /else if \(baseSession && baseSession !== currentSession\(\)\)/);
    assert.match(fn, /if \(p && e\) resolvedModel = \{account: p, entry: e\};/);
});

test('scope 越宽报错：只许继承或更严（SCOPE_RANK 单向）', () => {
    const fn = newSessionFn();
    assert.match(fn, /const SCOPE_RANK = \{full: 0, auto: 1, edit: 2, read: 3\};/);
    assert.match(fn, /if \(!AI_SCOPES\.includes\(wanted\)\)/);
    assert.match(fn, /\(SCOPE_RANK\[wanted\] \|\| 0\) < \(SCOPE_RANK\[baseScope\] \|\| 0\)/);
    assert.match(fn, /新会话不能更宽（只能继承或更严）/);
});

test('model 走子代理自选模型白名单，group 走 resolveSessionGroupName 归一', () => {
    const fn = newSessionFn();
    assert.match(fn, /resolvedModel = subAgentModelPick\(opts2\.model\);/);
    assert.match(fn, /resolveSessionGroupName\(opts2\.group, existingGroups\)/);
});

test('focus 复用空会话：scope 无条件应用 resolvedScope（杜绝继承更宽档提权）', () => {
    const fn = newSessionFn();
    const focusBranch = fn.slice(fn.indexOf('if (focus) {'), fn.indexOf('// 后台路径'));
    assert.match(focusBranch, /if \(title\) session\.title = title\.slice\(0, 60\);/);
    // scope 无条件应用（省略时 resolvedScope=调用方档位），不能让复用会话保留更宽档位
    assert.match(focusBranch, /const appliedScope = resolvedScope \|\| 'read';/);
    assert.match(focusBranch, /const scopeChanged = currentScopeOf\(session\) !== appliedScope;/);
    assert.match(focusBranch, /if \(scopeChanged\) session\.scope = appliedScope;/);
    // model 有 resolvedModel（显式或调用方在后台）时无条件 pin
    assert.match(focusBranch, /if \(resolvedModel\) pinSessionModel\(session, resolvedModel\.account, resolvedModel\.entry\);/);
    // group 省略表示不改（复用空会话可能用户已归类）
    assert.match(focusBranch, /if \(hasGroup\) session\.group = resolvedGroup;/);
});

test('createSessionData 接受 scope/model/group 覆盖，省略仍走继承', () => {
    const create = sliceFunction(panel, 'function createSessionData(title, sessionOpts) {', '\n    function ');
    assert.match(create, /const modelTarget = sessionOpts && sessionOpts\.model;/);
    assert.match(create, /const scopeOverride = sessionOpts && sessionOpts\.scope;/);
    assert.match(create, /const inherited = inheritModelRef\(\);/);
    assert.match(create, /profileId: modelTarget \? /);
    assert.match(create, /scope: \(transient \|\| noWorkspace\) \? 'read' : \(AI_SCOPES\.includes\(scopeOverride\)/);
    assert.match(create, /group: normalizeSessionGroup\(groupOverride\),/);
});

test('main.js 透传全部新参数，note 带生效档位/模型/分组', () => {
    const start = main.indexOf("case 'ai_new_session': {");
    assert.notEqual(start, -1);
    const body = main.slice(start, start + 1400);
    assert.match(body, /const focus = p\.focus === true;/);
    assert.match(body, /scope: p\.scope, model: p\.model, group: p\.group,/);
    assert.match(body, /callerSessionId,/);
    assert.match(body, /focus \? '并已切到该会话' : '（后台运行，面板当前会话未变）'/);
    assert.match(body, /'权限：' \+ session\.scope/);
    assert.match(body, /'分组：' \+ session\.group/);
    // note 按 sent 如实生成：发送失败时不说「已发送」
    assert.match(body, /else if \(session && session\.sent === false\) sendPart = '会话已建但消息发送失败（见面板错误提示）'/);
});

test('技能表声明全部参数与继承/更严语义', () => {
    const line = constants.split('\n').find((l) => l.includes("'- ai_new_session"));
    assert.ok(line, '找不到技能表 ai_new_session 行');
    assert.match(line, /focus\?/);
    assert.match(line, /默认后台创建/);
    assert.match(line, /focus=true 才抢占面板/);
    assert.match(line, /scope\?/);
    assert.match(line, /只能继承或向下/);
    assert.match(line, /model\?/);
    assert.match(line, /子代理模型/);
    assert.match(line, /group\?/);
    assert.match(line, /归一/);
});
