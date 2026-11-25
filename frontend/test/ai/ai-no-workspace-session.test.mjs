// ai-no-workspace-session.test.mjs —— 「新建无工作区会话」的接线守卫。
//
// 无工作区会话横跨：会话作用域判定（ai-session-scope.js）、面板大闭包（创建 / 归一 /
// 吸附守卫 / 入口 / 去重）、meta 落盘（ai-session-store.js）、派生（fork / sidechat）、
// 上下文注入（ai-system-context.js）。ai-panel 的大闭包 node 里实例化不了，按项目 wiring
// 测试惯例做源码级断言：锁住每条接线，删掉任何一处都会红。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const scope = read('../../src/ai/session/ai-session-scope.js');
const panel = read('../../src/ai/ai-panel.js');
const store = read('../../src/ai/session/ai-session-store.js');
const fork = read('../../src/ai/session/ai-session-fork.js');
const sidechat = read('../../src/ai/chat/ai-sidechat.js');
const systemCtx = read('../../src/ai/core/ai-system-context.js');

function sliceFunction(source, marker, nextMarker = '\n    function ') {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, '找不到函数：' + marker);
    const end = source.indexOf(nextMarker, start + marker.length);
    return source.slice(start, end < 0 ? undefined : end);
}

// ---- 纯函数：判定（用真实导出验证严格 true 语义） ----

test('isNoWorkspaceSession：只认严格 true', async () => {
    const mod = await import('../../src/ai/session/ai-session-scope.js');
    assert.equal(mod.isNoWorkspaceSession({noWorkspace: true}), true);
    assert.equal(mod.isNoWorkspaceSession({noWorkspace: false}), false);
    assert.equal(mod.isNoWorkspaceSession({}), false);
    assert.equal(mod.isNoWorkspaceSession(null), false);
    assert.equal(mod.isNoWorkspaceSession({temp: true}), false, 'temp 会话不是无工作区会话');
});

// ---- 数据层：产生 / 归一 / 落盘 ----

test('createSessionData：noWorkspace = 只读 + 空 workspace + 标记 + 默认标题「新会话」', () => {
    const fn = sliceFunction(panel, 'function createSessionData(title, sessionOpts)');
    assert.match(fn, /const noWorkspace = !!\(sessionOpts && sessionOpts\.noWorkspace === true\);/);
    assert.match(fn, /scope: \(transient \|\| noWorkspace\) \? 'read' : normalizeDefaultScope\(config\.defaultScope\)/);
    assert.match(fn, /workspace: \(transient \|\| noWorkspace\) \? '' : currentWorkspacePath\(\)/);
    assert.match(fn, /noWorkspace,/);
    assert.match(fn, /desktopEnabled: !transient && !noWorkspace && /);
    // 默认标题回落「新会话」：标题正常生成的前提
    assert.match(fn, /title: title \|\| '新会话'/);
});

test('normalizeSession 读回 noWorkspace（只认 === true）', () => {
    const fn = sliceFunction(panel, 'function normalizeSession(raw, index)');
    assert.match(fn, /noWorkspace: raw\.noWorkspace === true,/);
});

test('buildSessionMeta 落盘 noWorkspace（与 temp 同口径，但读盘不过滤）', () => {
    assert.match(store, /noWorkspace: \(session && session\.noWorkspace\) === true,/);
    // 读盘过滤只认 temp，不能把 noWorkspace 也滤掉（否则就不是持久会话了）
    const disk = read('../../src/ai/session/ai-session-disk.js');
    assert.match(disk, /isTransientSession\(\{temp: meta\.temp\}\)/);
    assert.doesNotMatch(disk, /isNoWorkspaceSession\(\{noWorkspace: meta\.noWorkspace\}\)/);
});

// ---- 吸附守卫：不被工作区收养（核心） ----

test('adopt / sync / 起轮三处守卫都含 noWorkspace', () => {
    const adopt = sliceFunction(panel, 'function adoptWorkspaceSession()');
    assert.match(adopt, /isTransientSession\(current\) \|\| isNoWorkspaceSession\(current\)/, '否则启动会被 bind 收养');

    const sync = sliceFunction(panel, 'async function syncWorkspaceToSession(session)');
    assert.match(sync, /isTransientSession\(session\) \|\| isNoWorkspaceSession\(session\)/, '否则切过去会绑工作区');

    const turn = sliceFunction(panel, 'async function startSessionTurnInner(', '\n    async function ');
    assert.match(turn, /!session\.workspace && !isTransientSession\(session\) && !isNoWorkspaceSession\(session\)/, '否则发第一条消息会被回填工作区');
});

test('newSession 空会话复用排除 noWorkspace（当前 + 列表两处）', () => {
    const create = sliceFunction(panel, 'function newSession()');
    assert.match(create, /!isTransientSession\(current\) &&\s*\n\s*!isNoWorkspaceSession\(current\)/);
    assert.match(create, /\.filter\(\(item\) => !isTransientSession\(item\) && !isNoWorkspaceSession\(item\)\)/);
});

test('legacy 回退不回填 noWorkspace 的工作区；认知预取跳过', () => {
    const legacy = sliceFunction(panel, 'function loadLegacySessions(rawList)');
    assert.match(legacy, /!session\.workspace && !isNoWorkspaceSession\(session\)/, 'legacy 回填不能收养无工作区会话');
    assert.match(panel, /!isTransientSession\(session\) && !isNoWorkspaceSession\(session\)\) await cognitionMod\.prefetchTurnCache\(session\)/);
});

test('派生：分支 / 支线继承 noWorkspace 且清空 workspace', () => {
    const branchFn = sliceFunction(panel, 'function branchSessionAt(', '\n    function ');
    assert.match(branchFn, /isTransientSession\(branch\) \|\| isNoWorkspaceSession\(branch\)\) branch\.workspace = ''/);
    assert.match(fork, /noWorkspace: src\.noWorkspace === true,/);
    assert.match(sidechat, /child\.temp === true \|\| child\.noWorkspace === true\) child\.workspace = ''/);
});

// ---- 上下文：不注入工作区知识 + 独立定性块 ----

test('系统上下文：判定扩展 + noWorkspace 独立定性块（不含「关闭应用后消失」）', () => {
    assert.match(systemCtx, /import \{isTransientSession, isNoWorkspaceSession\}/);
    assert.match(systemCtx, /const transient = isTransientSession\(session\) \|\| isNoWorkspaceSession\(session\);/);
    assert.match(systemCtx, /if \(transientOnly\) \{/);
    assert.match(systemCtx, /<no_workspace_session>/);
    assert.match(systemCtx, /这是一条不绑定工作区的持久会话/);
    assert.match(systemCtx, /重启应用后仍可继续/);
    // 「关闭应用后不再显示」只属于临时会话块，不能出现在无工作区块里
    const block = sliceFunction(systemCtx, '} else if (noWorkspaceOnly) {', '\n        // 支线定性块');
    assert.doesNotMatch(block, /关闭应用后不再显示/);
});

// ---- 入口与去重 ----

test('newNoWorkspaceSession：用 noWorkspace 造会话、空标题、不接草稿、展开分组', () => {
    const fn = sliceFunction(panel, 'function newNoWorkspaceSession()');
    assert.match(fn, /createSessionData\('', \{noWorkspace: true\}\)/);
    assert.match(fn, /loadComposerDraft\(session\.id, null\)/, '不接工作区草稿');
    assert.match(fn, /sessionListMod\.expandWorkspaceGroup\(''\)/, '展开「未关联工作区」分组');
    assert.match(fn, /discardVirginOnLeave\(current\)/);
    assert.match(fn, /persistSessions\(\)/, '持久会话必须落盘');
    assert.match(fn, /isNoWorkspaceSession\(current\)/, '空会话复用判定');
    assert.match(fn, /logActivity\([^)]*noWorkspace: true/);
});

test('两个新建菜单都给出「新建无工作区会话」入口', () => {
    const newMenu = sliceFunction(panel, 'function showNewSessionMenu()');
    assert.match(newMenu, /label: '新建无工作区会话'/);
    assert.match(newMenu, /newNoWorkspaceSession\(\)/);
    const listMenu = sliceFunction(panel, 'function showSessionListMenu()');
    assert.match(listMenu, /label: '新建无工作区会话'/);
    assert.match(listMenu, /newNoWorkspaceSession\(\)/);
});

test('dedupe：无工作区空会话用独立 key，避免跨窗口误删', () => {
    const fn = sliceFunction(panel, 'function dedupeVirginSessions()');
    assert.match(fn, /isNoWorkspaceSession\(session\)/);
    assert.match(fn, /'\\u0000no-workspace'/, '哨兵含不可能字符，避免与真实工作区 key 撞名');
});

test('会话列表不给无工作区会话加「临时」徽标', () => {
    const list = read('../../src/ai/session/ai-session-list.js');
    // 徽标判定只认 isTransientSession：新类型不设 temp，不会命中，无需改列表代码
    assert.match(list, /if \(isTransientSession\(session\)\) \{/);
    assert.match(list, /badge\.textContent = '临时';/);
    assert.doesNotMatch(list, /isNoWorkspaceSession/, '列表不该为新类型加任何徽标判定');
});
