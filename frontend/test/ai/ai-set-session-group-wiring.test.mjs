// ai-set-session-group-wiring.test.mjs —— app_control 的 ai_set_session_group 动作与
// get_ai 分组字段的接线守卫（源码级，bridge 在大闭包里无法直接实例化）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const panel = read('../../src/ai/ai-panel.js');
const main = read('../../src/main.js');
const constants = read('../../src/ai/core/ai-constants.js');
const notices = read('../../src/ai/agent/ai-agent-notices.js');

function sliceFunction(source, marker, nextMarker) {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, '找不到：' + marker);
    const end = nextMarker ? source.indexOf(nextMarker, start + marker.length) : -1;
    return source.slice(start, end < 0 ? undefined : end);
}

test('bridgeSetSessionGroup：目标解析优先级与归一', () => {
    const fn = sliceFunction(panel, 'bridgeSetSessionGroup: (id, group, callerSessionId) => {', '\n        // ---------- 生成条目桥');
    // 显式 id > 调用者自己的会话 > 面板当前会话（与 ai_rename_session 同口径）
    assert.match(fn, /wanted\s*\n?\s*\? sessions\.find\(\(s\) => s\.id === wanted\)/);
    assert.match(fn, /\(caller \? sessions\.find\(\(s\) => s\.id === caller\) : null\) \|\| currentSession\(\)/);
    // 归一同新建：resolveSessionGroupName + 工作区既有分组
    assert.match(fn, /resolveSessionGroupName\(group, existingGroups\)/);
    assert.match(fn, /setSessionGroup\(target, next, 'ai'\)/);
    assert.match(fn, /return \{id: target\.id, title: target\.title, group: target\.group \|\| ''\};/);
});

test("setSessionGroup 支持 actor=ai（AI 调用不闪 user 提示、留痕记 ai）", () => {
    const fn = sliceFunction(panel, 'function setSessionGroup(target, presetValue, actor) {', '\n    function ');
    assert.match(fn, /const who = actor === 'ai' \? 'ai' : 'user';/);
    assert.match(fn, /\{actor: who, source: who\}/);
    assert.match(fn, /if \(who === 'user'\) flash\(/);
});

test('main.js 分发 ai_set_session_group，透传 id/group/callerSessionId', () => {
    const body = sliceFunction(main, "case 'ai_set_session_group': {", '\n        case ');
    assert.match(body, /bridgeSetSessionGroup\(p\.id, p\.group, callerSessionId\)/);
    assert.match(body, /return \{updated:/);
    // APP_ACTIONS 已登记（三方一致由 ai-app-actions.test.mjs 强制）
    assert.ok(main.includes("'ai_set_session_group'"), 'APP_ACTIONS 缺 ai_set_session_group');
});

test('技能表声明 ai_set_session_group（不传 id 改自己、空串移出）', () => {
    const line = constants.split('\n').find((l) => l.includes("'- ai_set_session_group"));
    assert.ok(line, '找不到技能表 ai_set_session_group 行');
    assert.match(line, /group,id\?/);
    assert.match(line, /改的是调用者自己所在的会话/);
    assert.match(line, /空串 = 移出分组/);
});

test('get_ai 返回 session.group / callerSession / sessionGroups', () => {
    const fn = sliceFunction(panel, 'bridgeGetState: (callerSessionId) => {', '\n    };');
    assert.match(fn, /sessionGroups/);
    assert.match(fn, /callerSession: callerSession \? \{/);
    // callerSession 块含分组与权限档
    assert.match(fn, /callerSession\.group \|\| ''/);
    assert.match(fn, /currentScopeOf\(callerSession\)/);
    // session 块（面板当前会话）也带 group
    assert.match(fn, /session\.group \|\| '',\n\s*messages:/);
    // bridgeListSessions（get_state 用）也带 group
    const list = sliceFunction(panel, 'bridgeListSessions: (callerSessionId) => {', '\n        // AI 弹窗');
    assert.match(list, /group: s\.group \|\| '',/);
});

test('session_list 输出带分组（有分组才显示）', () => {
    assert.match(notices, /session\.group \? ' · 分组：' \+ session\.group : ''/);
});

test('get_state 用精简会话列表 + 工作区列表，不再下发全量会话表', () => {
    const state = sliceFunction(main, "case 'get_state': {", "\n        case 'get_settings'");
    // sessions 走精简 bridge，不再调用全量 bridgeListSessions
    assert.match(state, /bridgeListSessionsBrief\(callerSessionId\)/);
    assert.doesNotMatch(state, /bridgeListSessions\(callerSessionId\)/);
    // 工作区聚合列表
    assert.match(state, /workspaces: aiPanel && aiPanel\.bridgeListWorkspaces \? aiPanel\.bridgeListWorkspaces\(\) : \[\]/);
    // 技能表同步：声明身份 2 + 运行中 20 的语义与「按 id 找走 session_list / get_ai」的指引
    const line = constants.split('\n').find((l) => l.includes("'- get_state"));
    assert.ok(line, '找不到技能表 get_state 行');
    assert.match(line, /身份会话/);
    assert.match(line, /运行中会话/);
    assert.match(line, /aiPanel\.workspaces/);
    assert.match(line, /session_list \/ get_ai/);
});

test('bridgeListSessionsBrief：身份 2 条必含 + 运行中 20 条上限，字段瘦身', () => {
    const brief = sliceFunction(panel, 'bridgeListSessionsBrief: (callerSessionId) => {', '\n        // get_state 专用：会话涉及的工作区');
    // 身份会话必含（caller + activeId）
    assert.match(brief, /for \(const id of \[caller, activeId\]\)/);
    assert.match(brief, /identity\.push/);
    // 运行中会话上限 20、合计 22
    assert.match(brief, /running\.length >= 20/);
    assert.match(brief, /\.slice\(0, 22\)/);
    // 去重
    assert.match(brief, /seen\.has\(s\.id\)/);
    // 字段最小集（含 state）
    for (const key of ['id: s.id', 'title: s.title', 'workspace: s.workspace', 'state,', 'active:', 'caller:']) {
        assert.ok(brief.includes(key), '精简会话缺字段 ' + key);
    }
    // 全量字段（messages/orchestration 等）不出现
    assert.doesNotMatch(brief, /messages: sessionMessageCount/);
    assert.doesNotMatch(brief, /orchestration:/);
});

test('bridgeListWorkspaces 去重聚合、上限 8、带 current/active 标记', () => {
    const ws = sliceFunction(panel, 'bridgeListWorkspaces: () => {', '\n        // AI 弹窗已进全局弹层栈');
    assert.match(ws, /\.slice\(0, 8\)/);
    assert.match(ws, /current: aiWorkspaceKey\(entry\.path\) === current/);
    assert.match(ws, /active: aiWorkspaceKey\(entry\.path\) === activeWs/);
    assert.match(ws, /sessions: entry\.count/);
});
