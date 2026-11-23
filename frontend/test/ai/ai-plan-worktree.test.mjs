// 计划批准卡「在隔离区中执行」开关：批准指令差异化纯函数 + 三处接线护栏。
// 开关本身依赖真实 DOM / Wails 后端，只能在源码层面锁住接线点（同 ai-tool-wiring 惯例）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planApprovalInstruction} from '../../src/ai/tools/ai-tool-cards.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const takeover = read('../../src/ai/chat/ai-takeover.js');
const toolCards = read('../../src/ai/tools/ai-tool-cards.js');
const panel = read('../../src/ai/ai-panel.js');
const worktree = read('../../src/ai/tools/ai-worktree.js');

function sliceFunction(source, marker) {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, '找不到函数：' + marker);
    const rest = source.slice(start + marker.length);
    const next = rest.search(/\n {4}(?:async )?function /);
    return next < 0 ? source.slice(start) : source.slice(start, start + marker.length + next);
}

// ---- 纯函数：批准指令 ----

test('planApprovalInstruction：未勾选隔离区时维持旧文案（detectAppMessage 前缀不变）', () => {
    const text = planApprovalInstruction(false, null);
    assert.match(text, /^计划已批准，请立即按/);
    assert.match(text, /submit_plan 提交的计划开始执行/);
    assert.match(text, /计划模式已随批准自动退出/);
    assert.doesNotMatch(text, /隔离工作区/);
});

test('planApprovalInstruction：勾选隔离区时告知路径、主根只读、export 回灌', () => {
    const text = planApprovalInstruction(true, {worktree: {name: 'plan-abcd1234'}});
    assert.match(text, /^计划已批准，请立即按/); // 两种文案共用前缀，历史会话仍能认回
    assert.match(text, /\.cadt\/worktree\/plan-abcd1234\//);
    assert.match(text, /不要改主根同名文件/);
    assert.match(text, /主根只读/);
    assert.match(text, /worktree_manage\(action=export\)/);
    assert.match(text, /默认在隔离区里执行/);
});

test('planApprovalInstruction：勾选但会话没有 worktree 名时用占位 slug，不崩', () => {
    const text = planApprovalInstruction(true, null);
    assert.match(text, /\.cadt\/worktree\/<slug>\//);
});

// ---- 接线：开关默认关 + 透传 + 建区时序 ----

test('接管卡：左下角静态提示已换成开关，默认关，勾选随 acceptPlan 透传', () => {
    const render = sliceFunction(takeover, 'function renderPlanTakeover(session, plan) {');
    assert.doesNotMatch(render, /'批准后开始执行'/, '静态提示必须删掉');
    assert.match(render, /textContent = '在隔离区中执行'/);
    assert.match(render, /createSwitch\(\{[\s\S]*?checked: false/, '默认不勾选');
    assert.match(render, /inWorktree: wtSwitch\.control\.checked/);
    assert.match(render, /acceptPlan\(session, Array\.from\(selectedGrants\.values\(\)\), \{/);
});

test('面板包装层：落盘前先建隔离区，失败即返回（审批卡保留可重试）', () => {
    const fn = sliceFunction(panel, 'const acceptPlan = async (session, grantItems, opts) => {');
    assert.match(fn, /opts\.inWorktree/);
    assert.match(fn, /worktreeMod\.createForSession\(session, 'plan', \{skipConfirm: true, allowRunning: true\}\)/);
    // 建区失败在 writePlanFileForApproval 之前返回——否则 activePlan 置 approved、审批卡消失无法重试
    const createIdx = fn.indexOf('worktreeMod.createForSession');
    const writeIdx = fn.indexOf('await writePlanFileForApproval(session)');
    assert.ok(createIdx > 0 && writeIdx > createIdx, '建隔离区必须早于计划落盘');
    assert.match(fn, /if \(!added\) \{[\s\S]*?return;/);
});

test('工具卡：批准指令按 inWorktree 差异化，且不再自建隔离区（已前移到包装层）', () => {
    const fn = sliceFunction(toolCards, 'async function acceptPlan(session, grantItems, opts) {');
    assert.match(fn, /planApprovalInstruction\(inWorktree, session\)/);
    assert.doesNotMatch(fn, /createWorktreeForPlan/, '建区已前移到包装层，这里不该再建');
});

test('createForSession：skipConfirm / allowRunning 两个选项接线存在', () => {
    const fn = sliceFunction(worktree, 'async function createForSession(session, label, opts) {');
    assert.match(fn, /scope !== 'full' && !\(opts && opts\.skipConfirm\)/);
    assert.match(fn, /isRunning\(session\.id\) && !\(opts && opts\.allowRunning\)/);
});
