// ai-temp-session.test.mjs —— 「新建临时会话」的接线守卫。
//
// 临时会话横跨四处：侧栏分体按钮（index.html）、面板大闭包（ai-panel.js：创建 / 归一 /
// 不绑工作区的三处守卫 / 磁盘重读不丢）、会话列表徽标（ai-session-list.js）、读盘过滤
// （ai-session-disk.js 的 keepMeta，已由 ai-session-disk.test.mjs 覆盖行为）。
// ai-panel 的大闭包 node 里实例化不了（依赖 Wails 后端与 DOM），所以这里按项目 wiring
// 测试的惯例做源码级断言：锁住每条接线，删掉任何一处都会红。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const panel = read('../../src/ai/ai-panel.js');
const list = read('../../src/ai/session/ai-session-list.js');
const html = read('../../index.html');

function sliceFunction(source, marker, nextMarker = '\n    function ') {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, '找不到函数：' + marker);
    const end = source.indexOf(nextMarker, start + marker.length);
    return source.slice(start, end < 0 ? undefined : end);
}

test('侧栏「新建会话」按钮最右边有「⋯」分体按钮，且排在「自动化」之前', () => {
    const split = html.indexOf('class="ai-session-action-split"');
    const main = html.indexOf('id="ai-session-action-new"');
    const more = html.indexOf('id="ai-session-action-more"');
    const auto = html.indexOf('id="ai-session-action-auto"');
    assert.ok(split > 0 && main > split && more > main && auto > more,
        '结构应为 split > 新建会话 > ⋯ > 自动化');
    assert.ok(more - main < 900, '「⋯」必须紧跟在新建会话按钮里（同一个分体容器）');
    // 主体按钮只负责「新建会话」：⋯ 是 split 容器里的兄弟按钮，不是嵌套 button（非法 HTML）
    const between = html.slice(main, more);
    assert.ok(between.includes('新建会话'));
    assert.ok(html.indexOf('</button>', main) < more, '⋯ 必须位于主体按钮之外（不能嵌套 button）');
});

test('「新建会话」按钮内部右侧有 ⌄（选工作区），且是 span 不是嵌套 button', () => {
    const main = html.indexOf('id="ai-session-action-new"');
    const chev = html.indexOf('id="ai-session-action-chev"');
    const closeMain = html.indexOf('</button>', main);
    assert.ok(chev > main, '⌄ 必须在主体按钮内');
    assert.ok(chev < closeMain, '⌄ 必须嵌在主体按钮内部（不是独立胶囊）');
    // button 里不能再嵌 button：⌄ 用 span[role=button]
    const chevTag = html.slice(chev - 60, chev);
    assert.ok(!/<button[^>]*$/.test(chevTag.replace(/<span[^>]*$/, '')), '⌄ 不能是 button（非法嵌套）');
    assert.ok(/<span id="ai-session-action-chev"/.test(html), '⌄ 必须是 span');
});

test('⋯ 按钮绑定 showNewSessionMenu，菜单里给出临时会话入口', () => {
    assert.match(panel, /const sessionActionNewMoreBtn = document\.getElementById\('ai-session-action-more'\);/);
    assert.match(panel, /if \(sessionActionNewMoreBtn\) \{\s*\n\s*sessionActionNewMoreBtn\.addEventListener\('click', \(\) => \{\s*\n\s*ensureOpen\(\);\s*\n\s*showNewSessionMenu\(\);/);
    const menu = sliceFunction(panel, 'function showNewSessionMenu()');
    assert.match(menu, /label: '新建临时会话'/);
    assert.match(menu, /action: \(\) => \{ ensureOpen\(\); newTempSession\(\); \}/);
    assert.match(menu, /label: '新建会话'/, '菜单里常规新建仍在，临时会话是额外一项');
});

test('newTempSession 用 transient 造会话，且不接工作区草稿', () => {
    const fn = sliceFunction(panel, 'function newTempSession()');
    assert.match(fn, /createSessionData\(AI_TEMP_SESSION_TITLE, \{transient: true\}\)/);
    assert.match(fn, /loadComposerDraft\(session\.id, null\)/, '临时会话不接管工作区草稿');
    assert.match(fn, /sessions\.push\(session\)/);
    assert.match(fn, /persistSessions\(\)/, '仍要落盘（磁盘只作留档）');
    assert.match(fn, /setActiveSessionId\(session\.id\)/);
    // 它归「未关联工作区」分组，该分组默认收起：revealSession 展开分组并滚到新会话
    assert.match(fn, /sessionListMod\.revealSession\(session\.id, session\)/);
    // 离开的空会话一律清理（普通空会话也要删，否则留一条 0 消息残留）
    assert.match(fn, /discardVirginOnLeave\(current\);/);
    assert.doesNotMatch(fn, /if \(isTransientSession\(current\)\) discardVirginOnLeave/, '不能只清理临时空会话');
});

test('起轮路径不回绑工作区（临时会话发第一条消息也不能被收养）', () => {
    // 起轮内核现在是 startSessionTurnInner（外层 startSessionTurn 只做起轮中的登记/注销）
    const fn = sliceFunction(panel, 'async function startSessionTurnInner(', '\n    async function ');
    assert.match(fn, /if \(!session\.workspace && !isMultiWorkspace\(\)[\s\S]{0,80}?!isUnboundSession\(session\)\)/,
        'startSessionTurn 会把空 workspace 回填成当前工作区——这条最常走的路径必须挡住');
});

test('legacy / 回退存储模式也不把临时会话带回来', () => {
    const fn = sliceFunction(panel, 'function loadLegacySessions(rawList)');
    assert.match(fn, /if \(isTransientSession\(session\)\) return;/,
        'legacy 读盘不过滤 = 临时会话跨重启存活（磁盘侧 keepMeta 挡不住 localStorage）');
});

test('「没动过的临时会话」判定：默认标题就能算 virgin，切走才会被删', () => {
    const fn = sliceFunction(panel, 'function isVirginSession(session)');
    assert.match(fn, /if \(title === AI_TEMP_SESSION_TITLE\) return isTransientSession\(session\);/,
        '临时会话标题是「临时会话」而不是「新会话」，不放行则 discardVirginOnLeave 恒 false（死代码）');
    assert.match(panel, /const AI_TEMP_SESSION_TITLE = '临时会话';/, '标题单一来源');
});

test('临时会话的派生（分支 / 支线）继承 temp 且不绑工作区', () => {
    const branchFn = sliceFunction(panel, 'function branchSessionAt(', '\n    function ');
    assert.match(branchFn, /Object\.assign\(branch, forkSettings\(source\)\)/);
    assert.match(branchFn, /isUnboundSession\(branch\)/,
        '分支兜底绑定会把临时/无工作区会话变成工作区会话');

    const sidechat = read('../../src/ai/chat/ai-sidechat.js');
    assert.match(sidechat, /Object\.assign\(child, inherited\)/);
    assert.match(sidechat, /isUnboundSession\(child\)/);
    assert.match(sidechat, /forkSettings\(owner\)/);
});

test('createSessionData：临时会话 = 只读 + 不绑工作区 + temp 标记 + 桌面控制默认关', () => {
    const fn = sliceFunction(panel, 'function createSessionData(title, sessionOpts)');
    assert.match(fn, /const transient = !!\(sessionOpts && sessionOpts\.transient === true\);/);
    assert.match(fn, /scope: \(transient \|\| noWorkspace\) \? 'read' : \(AI_SCOPES\.includes\(scopeOverride\)/);
    // 多工作区下默认 workspace 也留空（不猜根），见 ai-no-workspace-session.test.mjs 同款断言
    assert.match(fn, /workspace: \(transient \|\| noWorkspace \|\| isMultiWorkspace\(\)\) \? '' : windowWorkspacePath\(\)/);
    assert.match(fn, /temp: transient,/);
    assert.match(fn, /desktopEnabled: !transient && !noWorkspace && /);
});

test('normalizeSession 读回 temp 标记（只认 === true）', () => {
    const fn = sliceFunction(panel, 'function normalizeSession(raw, index)');
    assert.match(fn, /temp: raw\.temp === true,/);
});

test('临时会话不被吸附到工作区：adopt / sync / 空会话复用三处守卫', () => {
    const adopt = sliceFunction(panel, 'function adoptWorkspaceSession()');
    assert.match(adopt, /isUnboundSession\(current\)/, '否则会被 bind 成工作区会话');

    const sync = sliceFunction(panel, 'async function syncWorkspaceToSession(session)');
    assert.match(sync, /isUnboundSession\(session\)/, '否则切过去会把会话绑到当前工作区');

    const create = sliceFunction(panel, 'function newSession()');
    assert.match(create, /!isUnboundSession\(current\)/, '当前空临时/无工作区会话不能被「新建会话」复用');
    assert.match(create, /\.filter\(\(item\) => !isUnboundSession\(item\)\)/, '列表里的空临时/无工作区会话不参与复用');
});

test('磁盘重读不把临时会话弄丢、也不把它当「别处删了」', () => {
    const apply = sliceFunction(panel, 'function applyLoadedSessions(next, readStartedAt)');
    assert.match(apply, /const keptTransient = sessions\.filter\(\(session\) => isTransientSession\(session\)/);
    assert.match(apply, /sessions = keptTransient\.length \? next\.concat\(keptTransient\) : next;/);

    const differ = sliceFunction(panel, 'function metasDiffer(metas)');
    assert.match(differ, /if \(isTransientSession\(session\)\) continue;/);
});

test('临时会话不预取认知索引；会话列表给「临时」徽标', () => {
    assert.match(panel, /if \(!isUnboundSession\(session\)\) await cognitionMod\.prefetchTurnCache\(session\);/);
    assert.match(list, /if \(isTransientSession\(session\)\) \{/);
    assert.match(list, /badge\.className = 'ai-session-badge temp';/);
    assert.match(list, /badge\.textContent = '临时';/);
});
