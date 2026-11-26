// scope-root.test.mjs：作用域根 scopeRootOf 的四步取值 + decideSessionOpen 的原地换手分支。
//
// 背景：改造前 ai-panel 的 getScopeRoot() = 工作区文件夹 || 活动文件父目录，与会话无关——
// 在 A 仓库开会话、切标签到 B 仓库，工具就按 B 解析路径。scopeRootOf 把「取根」收成唯一
// 来源，本文件锁死它的**取值顺序**（顺序错 = 读到别的仓库的 AGENTS.md / 记忆 / 规则）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    activeFileDir,
    decideSessionOpen,
    scopeRootOf,
    windowWorkspace,
} from '../../../src/ai/session/ai-session-scope.js';

const SESSION_WS = 'D:\\Work\\MyRepo'; // 会话绑定的工作区
const WINDOW_WS = 'D:/code/OtherRepo'; // 本窗口打开的工作区
const ACTIVE_FILE = 'D:\\code\\ThirdRepo\\src\\main.js'; // 当前活动文件（别的工作区）

// ---- 第 4 步的两个来源（单独锁一遍归一语义）----

test('windowWorkspace：只认显式工作区，反斜杠/尾斜杠归一，空值返回空', () => {
    assert.equal(windowWorkspace(WINDOW_WS), WINDOW_WS);
    assert.equal(windowWorkspace('D:\\code\\OtherRepo\\'), 'D:/code/OtherRepo');
    assert.equal(windowWorkspace('D:/code//OtherRepo///'), 'D:/code/OtherRepo');
    assert.equal(windowWorkspace(''), '');
    assert.equal(windowWorkspace('   '), '');
    assert.equal(windowWorkspace(null), '');
    assert.equal(windowWorkspace(undefined), '');
});

test('activeFileDir：取父目录；只有文件名或空值返回空', () => {
    assert.equal(activeFileDir(ACTIVE_FILE), 'D:/code/ThirdRepo/src');
    assert.equal(activeFileDir('D:\\a\\b.js'), 'D:/a');
    assert.equal(activeFileDir('main.js'), '', '裸文件名没有可解析的父目录');
    assert.equal(activeFileDir(''), '');
    assert.equal(activeFileDir(null), '');
});

// ---- scopeRootOf 的五条路径 ----

test('scopeRootOf ①：会话工作区优先，且归一（反斜杠/尾斜杠/点段/盘符）', () => {
    assert.equal(scopeRootOf({workspace: SESSION_WS}, {}), 'D:/Work/MyRepo');
    assert.equal(scopeRootOf({workspace: 'D:\\Work\\MyRepo\\'}, {}), 'D:/Work/MyRepo');
    assert.equal(scopeRootOf({workspace: 'D:/Work/./MyRepo/../MyRepo'}, {}), 'D:/Work/MyRepo');
    assert.equal(scopeRootOf({workspace: 'd:/work/myrepo'}, {}), 'd:/work/myrepo', '归一不折大小写（key 才折）');
    assert.equal(scopeRootOf({workspace: 'C:\\'}, {}), 'C:', '盘符根去尾斜杠');
    assert.equal(scopeRootOf({workspace: '\\\\server\\share\\proj'}, {}), '/server/share/proj');
});

test('scopeRootOf ②：noWorkspace 会话取 backing workspace（会话沙盒）', () => {
    const session = {id: 's-1', noWorkspace: true};
    const env = {backingWorkspaceOf: (s) => (s === session ? 'C:\\appdata\\ai-workspaces\\s-1' : '')};
    assert.equal(scopeRootOf(session, env), 'C:/appdata/ai-workspaces/s-1');
});

test('scopeRootOf ②：noWorkspace 取不到 backing 时就是无根，不回落到窗口/活动文件', () => {
    const env = {windowWorkspace: WINDOW_WS, activeFilePath: ACTIVE_FILE};
    assert.equal(scopeRootOf({noWorkspace: true}, env), '',
        '沙盒会话绝不能拿窗口工作区当根——那是别的仓库');
    assert.equal(scopeRootOf({noWorkspace: true}, {...env, backingWorkspaceOf: () => ''}), '');
    assert.equal(scopeRootOf({noWorkspace: true}, {...env, backingWorkspaceOf: () => '   '}), '');
});

test('scopeRootOf ②：workspace 与 noWorkspace 同时存在时以 workspace 为准', () => {
    const session = {workspace: SESSION_WS, noWorkspace: true};
    const env = {backingWorkspaceOf: () => 'C:/appdata/ai-workspaces/s-1'};
    assert.equal(scopeRootOf(session, env), 'D:/Work/MyRepo');
});

test('scopeRootOf ③：harness 窗口里未绑定会话 → 空串（无根），活动文件也不兜底', () => {
    const env = {isHarness: true, windowWorkspace: WINDOW_WS, activeFilePath: ACTIVE_FILE};
    assert.equal(scopeRootOf({id: 's-unbound'}, env), '');
    assert.equal(scopeRootOf({id: 's-unbound', workspace: ''}, env), '');
});

test('scopeRootOf ④：非 harness 无绑定会话回落窗口工作区', () => {
    const env = {windowWorkspace: WINDOW_WS, activeFilePath: ACTIVE_FILE};
    assert.equal(scopeRootOf({id: 's-legacy'}, env), WINDOW_WS, '窗口工作区优先于活动文件目录');
    assert.equal(scopeRootOf(null, env), WINDOW_WS);
});

test('scopeRootOf ④：窗口没有工作区时回落活动文件父目录', () => {
    assert.equal(scopeRootOf({id: 's'}, {activeFilePath: ACTIVE_FILE}), 'D:/code/ThirdRepo/src');
    assert.equal(scopeRootOf({id: 's'}, {activeFileDir: ACTIVE_FILE}), 'D:/code/ThirdRepo/src',
        '旧键名 activeFileDir 同样按文件路径折算');
});

test('scopeRootOf ④：窗口与活动文件都没有 → 空串', () => {
    assert.equal(scopeRootOf({id: 's'}, {}), '');
    assert.equal(scopeRootOf({id: 's'}), '', 'env 可省略');
    assert.equal(scopeRootOf(undefined, undefined), '');
});

// ---- 本改造的核心断言：会话根 > 窗口根 ----

test('会话根 > 窗口根：两者不同时一律取会话根', () => {
    const session = {id: 's-ai', workspace: SESSION_WS};
    const env = {windowWorkspace: WINDOW_WS, activeFilePath: ACTIVE_FILE};
    const root = scopeRootOf(session, env);
    assert.equal(root, 'D:/Work/MyRepo');
    assert.notEqual(root, windowWorkspace(WINDOW_WS));
    assert.notEqual(root, activeFileDir(ACTIVE_FILE));
    // harness 下同样取会话根（第 1 步在第 3 步之前）
    assert.equal(scopeRootOf(session, {...env, isHarness: true}), 'D:/Work/MyRepo');
});

test('会话根 > 窗口根：归一后的等价写法仍取会话根，且与窗口根不同源', () => {
    const session = {workspace: 'd:\\work\\myrepo\\'};
    assert.equal(scopeRootOf(session, {windowWorkspace: WINDOW_WS}), 'd:/work/myrepo');
    assert.equal(scopeRootOf(session, {windowWorkspace: SESSION_WS}).toLowerCase(),
        windowWorkspace(SESSION_WS).toLowerCase(), '同根时两侧归一结果一致（大小写只在 key 层折）');
});

// ---- decideSessionOpen：原地换手 ----

// 改造前（openMode 缺省）的四个场景：逐字保留，任何一条变了都是回归。
const LEGACY_CASES = [
    [{dir: '', currentKey: '', targetKey: 'd:/a'}, 'invalid'],
    [{dir: 'D:/a', isFloat: true, currentKey: 'd:/b', targetKey: 'd:/a'}, 'invalid'],
    [{dir: 'D:/a', currentKey: 'd:/a', targetKey: 'd:/a'}, 'same'],
    [{dir: 'D:/a', currentKey: '', targetKey: 'd:/a'}, 'current'],
    [{dir: 'D:/a', currentKey: 'd:/b', targetKey: 'd:/a', reuseHit: true}, 'reused'],
    [{dir: 'D:/a', currentKey: 'd:/b', targetKey: 'd:/a', canSoftSwitch: true}, 'window'],
    [{dir: 'D:/a', currentKey: 'd:/b', targetKey: 'd:/a', canNewWindow: true}, 'window'],
    [{dir: 'D:/a', currentKey: 'd:/b', targetKey: 'd:/a'}, 'invalid'],
];

test('decideSessionOpen：openMode 缺省 = 改造前行为（表驱动逐条）', () => {
    for (const [state, action] of LEGACY_CASES) {
        assert.equal(decideSessionOpen(state).action, action, JSON.stringify(state));
    }
});

test("decideSessionOpen：openMode='new-window' 与缺省逐字一致", () => {
    for (const [state, action] of LEGACY_CASES) {
        const explicit = decideSessionOpen({...state, openMode: 'new-window'});
        const implicit = decideSessionOpen(state);
        assert.deepEqual(explicit, implicit, JSON.stringify(state));
        assert.equal(explicit.action, action, JSON.stringify(state));
    }
});

test("decideSessionOpen：openMode='in-place' + 跨根 → switchInPlace", () => {
    const state = {dir: 'D:/a', currentKey: 'd:/b', targetKey: 'd:/a', openMode: 'in-place'};
    assert.deepEqual(decideSessionOpen(state), {action: 'switchInPlace'});
});

test("decideSessionOpen：openMode='in-place' 不需要新窗口能力", () => {
    // 原地换手不新开窗口，后端没有软切换 / 新窗口能力也必须给 switchInPlace
    const state = {dir: 'D:/a', currentKey: 'd:/b', targetKey: 'd:/a', openMode: 'in-place'};
    assert.equal(decideSessionOpen({...state, canSoftSwitch: false, canNewWindow: false}).action, 'switchInPlace');
    assert.equal(decideSessionOpen({...state, canSoftSwitch: true}).action, 'switchInPlace');
});

test("decideSessionOpen：in-place 不越过前置分支（invalid / same / current / reused 优先）", () => {
    const base = {dir: 'D:/a', currentKey: 'd:/b', targetKey: 'd:/a', openMode: 'in-place'};
    assert.equal(decideSessionOpen({...base, dir: ''}).action, 'invalid');
    assert.equal(decideSessionOpen({...base, isFloat: true}).action, 'invalid');
    assert.equal(decideSessionOpen({...base, currentKey: 'd:/a'}).action, 'same');
    assert.equal(decideSessionOpen({...base, currentKey: ''}).action, 'current');
    assert.equal(decideSessionOpen({...base, reuseHit: true}).action, 'reused',
        '目标工作区已在别的存活窗口时优先复用，不抢过来');
});
