// ai-session-stub-hydrate.test.mjs —— 懒加载会话（_stub）的「画到就补水」护栏。
//
// 事故场景（2026-11-24 实测）：打开 / 切换到某个仓库后，AI 面板一直停在「正在载入对话…」，
// 点「新建会话」毫无反应，只有在左侧会话列表里硬点一次别的会话才恢复。三处原因串成一条链：
//   S1 把「当前会话」换成另一个会话的路径不止 switchSession 一种（工作区变更的
//      adoptWorkspaceSession switch 分支 → refreshSessionUI、配置读盘后的工作区对齐、
//      删除会话兜底），它们都不调 ensureSessionLoaded
//   S2 renderMessagesInner 画到 _stub 只显示载入态、不补水 → 永久停住
//   S3 newSession 的空会话复用判定把 _stub 当「没发过消息」→ 点新建只弹一句
//      「当前会话为空，已复用」，界面纹丝不动
//
// ai-panel 是大闭包（依赖 Wails 后端与 DOM），按项目惯例用源码级断言钉住这三条不变量。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const panel = readFileSync(join(SRC, 'ai', 'ai-panel.js'), 'utf8');

function sliceFunction(source, marker, nextMarker = '\n    function ') {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, '找不到函数：' + marker);
    const end = source.indexOf(nextMarker, start + marker.length);
    return source.slice(start, end < 0 ? undefined : end);
}

test('S2：渲染到 _stub 必须顺手补水，不能只画载入态', () => {
    const fn = sliceFunction(panel, 'function renderMessagesInner(keepScroll)');
    const stubBlock = fn.match(/if \(session\._stub\) \{[\s\S]*?\n        \}/);
    assert.ok(stubBlock, 'renderMessagesInner 应保留 _stub 分支');
    assert.match(stubBlock[0], /正在载入对话…/, '载入态文案保留');
    assert.match(stubBlock[0], /ensureSessionLoaded\(session\)/,
        '画到 stub 就必须调用 ensureSessionLoaded——否则换了当前会话的非切换路径会永久停在载入态');
    // 补水失败时 _stub 已被清掉并打了 _loadError：面板要重绘一次退出载入态，
    // 但只在仍是当前会话（且是面板而非支线宿主）时重绘；_stub 还在同理跳过，
    // 否则重绘 → 再画载入态 → 再补水 会自激。
    assert.match(stubBlock[0], /if \(ok \|\| session\._stub \|\| !forPanel \|\| currentSession\(\) !== session\) return;/);
    assert.match(stubBlock[0], /renderMessages\(true\);/);
});

test('S1：adoptWorkspaceSession 切会话时只改 active（渲染侧兜底），别再新增不补水的渲染入口', () => {
    const adopt = sliceFunction(panel, 'function adoptWorkspaceSession()');
    // 这条是背景说明：adopt 自身不做 IO，补正文的责任在渲染兜底（上一条测试）。
    // 若将来有人在 adopt 里补 ensureSessionLoaded 也可以，但必须至少有一处覆盖它。
    assert.match(adopt, /setActiveSessionId\(next\.id\);/);
    const stubRender = sliceFunction(panel, 'function renderMessagesInner(keepScroll)');
    assert.match(stubRender, /ensureSessionLoaded\(session\)/);
});

test('S3：newSession 的「空会话复用」不把 _stub 当空会话', () => {
    const fn = sliceFunction(panel, 'function newSession()');
    assert.match(fn, /if \(current && !current\._stub && !current\.archivedAt && !isUnboundSession\(current\) &&/,
        '懒加载占位的 messages 空只是还没读：当成空会话复用 → 点新建会话等于什么都没做');
    // 列表里的空会话候选同样不能是 stub（isVirginSession 已排除，这里钉住依赖关系）
    assert.match(fn, /\.filter\(\(item\) => item !== current && isVirginSession\(item\)\)/);
    const virgin = sliceFunction(panel, 'function isVirginSession(session)');
    assert.match(virgin, /if \(session\._stub\) return false;/);
});

test('会话就绪判定：初值 false，legacy 直通也要画真内容', () => {
    assert.match(panel, /let sessionsLoaded = false;/,
        '初值必须保守：legacy 模式下乐观 true 会用占位会话写 activeSessionId');
    const pending = sliceFunction(panel, 'function sessionsPending()');
    assert.match(pending, /return !sessionsLoaded;/);
    // 三条 bootstrap 路径都要置位；legacy 直通分支还必须刷新 UI，否则初值改 false 后永远停在加载态
    assert.match(panel, /if \(storageMode\(\) === 'legacy'\) \{[\s\S]{0,260}?refreshSessionUI\(\);/);
});

test('ensureSessionLoaded 仍是唯一的按需补水入口，且有并发去重', () => {
    const fn = sliceFunction(panel, 'function ensureSessionLoaded(session)');
    assert.match(fn, /if \(!session \|\| !session\._stub\) return Promise\.resolve\(true\);/);
    assert.match(fn, /const running = hydrateJobs\.get\(session\.id\);/);
    assert.match(fn, /hydrateJobs\.set\(session\.id, job\);/);
    // 补成功后：支线标签页宿主也要重画（它们共用同一套渲染，DOM 还停在占位载入态）
    assert.match(fn, /notifySideChatHosts\(session\.id\);/);
    // 面板自己只在这个会话仍是当前查看对象时重绘
    assert.match(fn, /if \(isOpen\(\) && currentSession\(\) === session\) \{/);
    // 对象被磁盘重读淘汰后不再补写（旧快照重写会回滚别人刚写入的内容）
    assert.match(fn, /sessions\.includes\(session\)/);
});
