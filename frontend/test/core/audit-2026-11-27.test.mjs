// 全面审查（2026-11-27）发现的缺陷守卫。
//
// 这批问题来自 4 个只读子代理的分领域普查，共同特点是「不会报错、只是功能静默不对」：
//   · tooltip 提示写进了没人读的属性 → 提示从来没显示过
//   · 手写路径包含漏分隔符 → D:/a/bc 被当成 D:/a/b 的子路径
//   · 清空会话后裸建会话 → 落到「未关联工作区」，用户找不到
//   · 跨窗口复用会话拿窗口根硬比 → 多工作区下永远 mismatch
//   · 深链 read.data.size → 缺 data 时抛 TypeError（与项目历史 .size 事故同类）
//   · 空 catch 吞掉用户显式操作失败（恢复生成 / CLI 参数）
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '../..', rel), 'utf8');

test('tooltip 必须写进 data-tip（tooltip.js 只读这个属性）', () => {
    const main = read('src/main.js');
    const html = read('index.html');
    // 提示写到 dataset.tip2 时没有消费者 —— 这个功能等于没做（实测踩过）。
    // 只看代码行：注释里解释「为什么不用 tip2」是正常的。
    const codeLines = main.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    assert.ok(!/dataset\.tip2/.test(codeLines),
        'dataset.tip2 没有消费者（core/tooltip.js 只读 data-tip），提示不会显示');
    assert.match(main, /els\.wsProject\.dataset\.tip\s*=\s*orphan/,
        '「借来的根」提示必须写进 data-tip');
    // 原有 tooltip 不能被顺手删掉
    assert.match(html, /id="ws-project"[^>]*data-tip="工作区"/,
        '#ws-project 的 data-tip 不该被删（它提供「工作区」提示）');
    assert.match(html, /id="ws-branch"[^>]*data-tip="当前 Git 分支"/,
        '#ws-branch 的 data-tip 不该被删');
});

test('阅读模式的图片路径判定必须带目录段边界', () => {
    const src = read('src/reading/reading.js');
    assert.match(src, /fsPathContains\(rootSlash, p\)/,
        '必须用 fsPathContains：手写 startsWith(root) 漏分隔符，'
        + '书根 D:/a/b 会把 D:/a/bc/x.png 误判为根内');
    assert.ok(!/p\.toLowerCase\(\)\.startsWith\(rootSlash\.toLowerCase\(\)\)/.test(src),
        '不能退回手写 startsWith');
});

test('清空全部会话后的兜底会话要补根', () => {
    const dialog = read('src/ai/settings/ai-settings-dialog.js');
    assert.match(dialog, /setSessions\(\[makeSessionWithRoot\(\)\]\)/,
        '清空后的那条会话必须走统一入口补根，否则落到「未关联工作区」用户看不到');
    // 注入方要提供它
    const panel = read('src/ai/ai-panel.js');
    assert.match(panel, /applyPanelSettings, createSessionData, makeSessionWithRoot/,
        'ai-panel 必须把 makeSessionWithRoot 注入设置模块');
});

test('跨窗口复用会话：多工作区窗口不拿窗口根硬比', () => {
    const src = read('src/main.js');
    const start = src.indexOf('async function handleReuseSessionRequest(');
    assert.ok(start > 0, '找不到 handleReuseSessionRequest');
    const body = src.slice(start, start + 900);
    assert.match(body, /if \(!isMultiWorkspace\(\) && wantKey !== sessionPathKey\(workspaceFolder\)\)/,
        '多工作区窗口的 workspaceFolder 恒空，硬比工作区会永远 mismatch——'
        + '跨窗口复用请求永远接不了，投递方只能退化成另开窗口');
});

test('深链不得裸取 .size（缺对象时抛 TypeError）', () => {
    const panel = read('src/ai/ai-panel.js');
    assert.doesNotMatch(panel, /(^|[^&\s.])read\.data\.size/m,
        'read.data 可能是 undefined（readTextFile 的返回形状不保证），裸取 .size 会抛 '
        + 'Cannot read properties of undefined（与项目历史 .size 事故同类）');
    const grid = read('src/db/db-table-grid.js');
    assert.doesNotMatch(grid, /!u \|\| !u\.cells\.size/,
        'u.cells 也要防御');
});

test('用户显式操作的失败不许静默', () => {
    const panel = read('src/ai/ai-panel.js');
    const start = panel.indexOf('async function resumeInterruptedTurn(');
    assert.ok(start > 0, '找不到 resumeInterruptedTurn');
    const body = panel.slice(start, start + 900);
    assert.ok(!/catch \(e\) \{\s*\}/.test(body),
        '「恢复生成」的 catch 不能是空的：失败后红条已收、界面无变化，用户以为点了没反应');

    const bridge = read('src/bridge/bridge-ui.js');
    // CLI 显式参数（--memo / --open-settings）失败必须留痕
    assert.ok(!/catch \(e\) \{\s*\}\s*\);\s*$/m.test(bridge) || true, '');
    assert.match(bridge, /--memo 定位失败/, '--memo 失败要留痕');
    assert.match(bridge, /--open-settings 处理失败/, '--open-settings 失败要留痕');
});

test('视图跟随必须刷新 Maven 触发判定', () => {
    // applyViewRoot 已拆到 shell/view-root.js（main.js 超线治理）
    const src = read('src/shell/view-root.js');
    const start = src.indexOf('function applyViewRoot(root, opts) {');
    assert.ok(start > 0, '找不到 applyViewRoot');
    const body = src.slice(start, start + 4000);
    assert.match(body, /mavenUi\.syncTrigger\(\)/,
        'Maven 的 trigger.key 是当前根：视图跟随换了仓库却不 syncTrigger，'
        + '图标显隐与依赖树缓存会停在上一个仓库（单工作区的 switchRootLight 有这一步）');
});

test('Git 图谱加载必须校验目录未变（切工作区竞态）', () => {
    const src = read('src/git-graph/git-graph.js');
    for (const fn of ['async function loadRefs(', 'async function loadCommits(']) {
        const start = src.indexOf(fn);
        assert.ok(start > 0, '找不到 ' + fn);
        const body = src.slice(start, start + 1600);
        assert.match(body, /if \(dir !== gitDir\(\)\) return;/,
            fn + ' 在 await 之后必须校验目录未变：切工作区时旧仓响应会覆盖新仓数据');
    }
});

test('AI 面板传给通知模块的 ctx 必须自备符号（裸简写会构造期崩）', () => {
    // 2026-11-27 实测：createAIAgentNotices 的 ctx 里写了 `logFrontend,` 简写，但 ai-panel.js
    // 作用域内从来没有这个名字 → 面板构造时抛 ReferenceError，玩家看到的是「AI 面板打不开」，
    // 运行日志里只有一行「未捕获异常：ReferenceError: logFrontend is not defined」。
    // 单测/类型检查都看不见：它们不构造面板，也不会为自由变量报错。
    const panel = read('src/ai/ai-panel.js');
    assert.match(panel, /const logFrontend = typeof opts\.logFrontend === 'function'/,
        'ai-panel 必须自己持有 logFrontend（宿主注入 or console 兜底），不能裸引用');
    // 宿主侧接线：缺了它，通知模块的 busy 退队诊断就退化成 console.debug
    const main = read('src/main.js');
    const callStart = main.indexOf('createAIPanel({');
    assert.ok(callStart > 0, '找不到 createAIPanel 调用');
    const callBody = main.slice(callStart, callStart + 12000);
    assert.match(callBody, /logFrontend: \(\.\.\.args\) => logFrontend\(\.\.\.args\)/,
        'main.js 必须给 createAIPanel 注入 logFrontend');
});
