// main.js 拆分守卫：已迁出的域不许回流 + 接线契约必须成立。
//
// 背景（2026-11-27）：main.js 一度 8255 行，而 AGENTS.md 规定硬上限 3000 行、
// 「存量超线文件只减不增」（点名了 main.js）。超线的后果不是性能，而是改动半径失控。
//
// ── 为什么这个守卫要有「运行时」那一半 ───────────────────────────────────
// 第一版只有静态文本断言，结果放过了一个阻断级 bug：main.js 用 **getter 属性**接线
// （`get explorer() { return explorer; }`），而模块契约是 **函数**
// （模块里写 `deps.explorer()`）→ 运行时 `deps.explorer is not a function`，
// `currentRoot()` 第一次调用就崩。而 npm test / typecheck / node --check 全绿——
// 因为它们谁都没有真正执行过这些模块。
//
// 教训：**「符号存在」不等于「调用能用」**。凡是拆分产出的模块，守卫必须真的跑一遍。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createViewRoot} from '../../src/shell/view-root.js';
import {createWipeguardRoots} from '../../src/shell/wipeguard-roots.js';
import {createAppActionContext} from '../../src/shell/app-action-context.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const main = readFileSync(here + '../../src/main.js', 'utf8');
// 与 `wc -l` 同口径：末尾换行不算一行（split 会多出一个空元素）
const mainLines = main.split('\n').length - (main.endsWith('\n') ? 1 : 0);

// 拆分完成时的行数快照。**只许往下调**（拆得更多了就改小并说明）；上调等于给堆逻辑开绿灯。
// 8110 → 7791：拆出 shell/app-action-context.js（app_control 动作前置，超线治理第 3 批）。
// 注：基线含工作区里另一会话的编排功能改动（+38 行），仍是净减 319 行。
const MAIN_BASELINE_LINES = 7791;

// 去掉注释行后再匹配：否则 `// 旧写法：function currentRoot()` 这类说明会误报。
const mainCode = main.split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

/** 构造一份「函数形状」的 deps——与 main.js 的接线契约一致。 */
function viewDeps(overrides = {}) {
    let workspace = 'D:/repo';
    return {
        windowWorkspace: () => workspace,
        explorer: () => ({getRoot: () => workspace, setRoot() {}, setMode() {}}),
        aiPanel: () => null,
        mavenUi: () => null,
        syncWorkspaceWatcher: () => {},
        renderWorkspaceCrumbs: () => {},
        updateWindowTitle: () => {},
        refreshGitStatus: () => null,
        memoWorkspaceChanged: () => null,
        logFrontend: () => {},
        sessionPathKey: (p) => String(p == null ? '' : p).toLowerCase(),
        ...overrides,
    };
}

test('已迁出的域不得回流到 main.js（按 function 声明锚定，排除注释）', () => {
    const movedOut = [
        ['currentRoot', 'shell/view-root.js'],
        ['applyViewRoot', 'shell/view-root.js'],
        ['followSessionWorkspace', 'shell/view-root.js'],
        ['followActiveSession', 'shell/view-root.js'],
        ['installSessionFollow', 'shell/view-root.js'],
        ['syncWorkspaceWatcher', 'shell/wipeguard-roots.js'],
        ['currentWatchRoot', 'shell/wipeguard-roots.js'],
        ['watchWipeguardRoot', 'shell/wipeguard-roots.js'],
        ['releaseWipeguardWatch', 'shell/wipeguard-roots.js'],
        ['unwatchWipeguardRoot', 'shell/wipeguard-roots.js'],
        // app_control 动作前置（第 3 批）
        ['appActionDocInfo', 'shell/app-action-context.js'],
        ['appActionFindBrowserDoc', 'shell/app-action-context.js'],
        ['appTabViewOf', 'shell/app-action-context.js'],
        ['appActionDocCaret', 'shell/app-action-context.js'],
        ['appActionResolveDoc', 'shell/app-action-context.js'],
        ['appActionDispatchClick', 'shell/app-action-context.js'],
        ['appActionDispatchKey', 'shell/app-action-context.js'],
        ['appActionDescribeNode', 'shell/app-action-context.js'],
        ['appActionEditableTarget', 'shell/app-action-context.js'],
        ['appActionDocText', 'shell/app-action-context.js'],
        ['appActionTermTail', 'shell/app-action-context.js'],
        ['appActionAIConfig', 'shell/app-action-context.js'],
        ['appActionAgentSnapshot', 'shell/app-action-context.js'],
        ['appActionWorkspacePath', 'shell/app-action-context.js'],
        ['appActionGroupBrief', 'shell/app-action-context.js'],
        ['appActionResolveGroup', 'shell/app-action-context.js'],
        ['appActionInstallUrlFromName', 'shell/app-action-context.js'],
    ];
    const offenders = movedOut
        .filter(([name]) => new RegExp('^\\s*(async\\s+)?function\\s+' + name + '\\s*\\(', 'm').test(mainCode))
        .map(([name, target]) => name + '  ← 应留在 ' + target);
    assert.deepEqual(offenders, [],
        '这些实现已迁到独立模块，不要再写回 main.js（组合根只做接线，不放域逻辑）：\n'
        + offenders.join('\n'));
});

test('依赖必须传函数形状（传 getter 属性会在运行时炸）', () => {
    // 模块内部统一写 `deps.xxx()`。若 main.js 传 `get xxx() { return obj }`，
    // 那么 deps.xxx 是对象，deps.xxx() 就是「对象当作函数调用」→ TypeError。
    // 这个 bug 曾经 npm test 全绿却让应用启动即崩，所以必须有这条断言。
    //
    // 只在 createViewRoot / createWipeguardRoots 的实参块里检查——main.js 别处
    // 有大量合法的 getter 注入（bridgeUI / titlebarPopovers / contextMenu…），全局匹配会误伤。
    // 用花括号配对取块，不能用固定长度切片（会越界到下一个函数）。
    function factoryBlock(factory) {
        const at = mainCode.indexOf(factory + '({');
        assert.ok(at > 0, '找不到 ' + factory + ' 的接线');
        let depth = 0;
        for (let i = at + factory.length; i < mainCode.length; i++) {
            const ch = mainCode[i];
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) return mainCode.slice(at, i + 1);
            }
        }
        assert.fail(factory + ' 的接线块没闭合');
        return '';
    }
    const joined = factoryBlock('createViewRoot') + '\n' + factoryBlock('createWipeguardRoots') +
        '\n' + factoryBlock('createAppActionContext');
    assert.ok(!/\bget\s+\w+\s*\(\)\s*\{/.test(joined),
        '这三个模块的接线不能用 getter 属性：模块契约是「函数」形式（deps.xxx()）。'
        + '传 getter 会让 deps.xxx 直接是值，deps.xxx() 抛 TypeError —— '
        + '而这在 npm test / typecheck / node --check 里都看不出来。改用 `xxx: () => yyy`。');
    // 正向确认：关键依赖确实是函数形状
    for (const key of ['windowWorkspace', 'explorer', 'normalizeWsKey', 'refreshGitStatus']) {
        assert.match(joined, new RegExp('\\b' + key + ':\\s*(\\(\\)\\s*=>|\\()'),
            'deps.' + key + ' 必须以函数形式接线');
    }
    // refreshGitStatus / memoWorkspaceChanged 特别容易多包一层闭包：
    // `() => () => refreshGitStatus` 会让模块拿到恒真的函数工厂，真正的刷新从未执行。
    assert.ok(!/refreshGitStatus:\s*\(\)\s*=>\s*\(\)\s*=>/.test(joined),
        'refreshGitStatus 不要写成 `() => () => xxx`：模块拿到的是函数工厂而非函数，'
        + 'typeof === "function" 恒真，但真正的刷新从未执行（静默失效）');
});

test('view-root 模块能用函数形状 deps 跑通（运行时契约）', () => {
    const vr = createViewRoot(viewDeps());
    // 四个入口都要真的调一遍——这正是第一版守卫缺的那一步。
    assert.doesNotThrow(() => vr.currentRoot(), 'currentRoot 必须可调用');
    assert.equal(vr.currentRoot(), 'D:/repo', '单工作区下 currentRoot = 窗口绑定根');
    assert.doesNotThrow(() => vr.followActiveSession(), 'followActiveSession 必须可调用（面板为 null 时安全返回）');
    assert.doesNotThrow(() => vr.installSessionFollow(), 'installSessionFollow 必须可调用（面板为 null 时安全返回）');
    // 首次换根：lastFocusedRoot 初始为空，所以不短路
    assert.equal(vr.applyViewRoot('D:/other'), true, '首次换根应当返回 true');
    assert.equal(vr.lastFocusedRoot, 'D:/other', '换根后视图跟随根更新');
    // 同根再调：短路返回 false（这条曾被写反，正是「同根短路」的语义核心）
    assert.equal(vr.applyViewRoot('D:/other'), false, '同根应当短路返回 false');
    // 空根 = 保持树不动 + 标「借来的根」
    assert.equal(vr.applyViewRoot(''), false, '空根不换树，返回 false');
    assert.equal(vr.viewRootOrphan, true, '空根且已有跟随根 → 标记为借来的根');
});

test('wipeguard-roots 模块能用函数形状 deps 跑通（运行时契约）', () => {
    const vr = createViewRoot(viewDeps());
    const wg = createWipeguardRoots({
        backend: () => null,
        wipeguardCtrl: () => null,
        currentSessionScopeRoot: () => '',
        explorer: () => null,
        currentRoot: () => vr.currentRoot(),
        normalizeWsKey: (ws) => String(ws == null ? '' : ws).toLowerCase(),
    });
    assert.doesNotThrow(() => wg.currentWatchRoot(), 'currentWatchRoot 必须可调用');
    assert.doesNotThrow(() => wg.syncWorkspaceWatcher(), 'syncWorkspaceWatcher 必须可调用（backend 为 null 时安全返回）');
    assert.doesNotThrow(() => wg.watchWipeguardRoot(''), '空根不该炸');
    assert.doesNotThrow(() => wg.releaseWipeguardWatch('D:/repo'), '未登记的根不该炸');
    assert.doesNotThrow(() => wg.unwatchWipeguardRoot('D:/repo'), '未登记的根不该炸');
    // 冷却语义：首次放行（返回 false 并记账），冷却期内拦截（true），过期后放行
    assert.equal(wg.tryMarkNotify('k', 1000, 100), false, '首次不在冷却期 → 放行');
    assert.equal(wg.tryMarkNotify('k', 1050, 100), true, '冷却期内 → 拦截');
    assert.equal(wg.tryMarkNotify('k', 1200, 100), false, '过期后 → 放行');
});

test('app-action-context 模块能用函数形状 deps 跑通（运行时契约）', () => {
    const docs = [{id: 'd1', name: 'a.json', path: 'D:/repo/a.json', mode: 'code'}];
    const mod = createAppActionContext({
        docs: () => docs,
        file: () => docs[0],
        findDocByPath: (p) => docs.find((d) => d.path === p) || null,
        currentRoot: () => 'D:/repo',
        aiPanel: () => null,
        aiGroupRuntime: () => null,
        backend: () => null,
    });
    // 关键入口真跑一遍——静态文本匹配抓不到 deps 契约错
    assert.equal(mod.appActionDocInfo(docs[0]).path, 'D:/repo/a.json');
    assert.equal(mod.appActionDocInfo(null), null);
    assert.equal(mod.appActionResolveDoc('active').path, 'D:/repo/a.json', 'active 应解析到 file');
    assert.equal(mod.appActionResolveDoc('D:/repo/a.json').path, 'D:/repo/a.json', '路径应走 findDocByPath');
    assert.equal(mod.appActionWorkspacePath('sub/b.json'), 'D:/repo\\sub/b.json', '相对路径按当前根解析');
    assert.equal(mod.appActionWorkspacePath('D:/abs.json'), 'D:/abs.json', '绝对路径原样返回');
    assert.equal(mod.appTabViewOf(docs[0]), null, '文件标签不是虚拟视图');
    assert.deepEqual(mod.appTabViewOf({name: '计划', viewKind: 'plan', path: null}),
        {kind: 'plan', label: '计划文档', name: '计划'});
    assert.throws(() => mod.appActionAIConfig(), /AI 面板未初始化/, '面板未初始化应明确报错');
    assert.throws(() => mod.appActionResolveGroup('x'), /群聊运行时未初始化/);
});

test('main.js 行数只减不增', () => {
    assert.ok(mainLines <= MAIN_BASELINE_LINES,
        'main.js 现有 ' + mainLines + ' 行，超过拆分后基线 ' + MAIN_BASELINE_LINES + ' 行。\n'
        + 'AGENTS.md 规定：存量超线文件「只减不增」。新增逻辑请放进对应域模块，'
        + '组合根只保留接线（函数注入 / 事件订阅 / 初始化顺序）。');
});
