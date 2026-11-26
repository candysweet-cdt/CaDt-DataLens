// 「当前根 / 窗口模式」读取收口的守卫。
//
// 背景（2026-11-26）：多工作区改造里，同一个判定散落在 6 个文件 42 处
// （`window.__harnessWindow` 直接读），加上 ai-panel 里 25 处 `currentWorkspacePath()`。
// 每个判断点都要自己考虑多工作区分支，漏一处就是**长期静默失效**——不报错、不显眼，
// 只是某个功能悄无声息地不工作。一天内踩到同一族的 7 个 bug：
//   徽标与树显示两个仓库 / 跨区判定恒真导致定时任务全废 / 定时胶囊永久隐藏 /
//   标题长期挂「会话无工作区」/ Git 快捷操作按钮消失 / 认知索引页必然报错 / 群聊工具禁用。
//
// 根因不是「某个地方写错了」，而是**判定没有唯一实现、读取没有收口**。
// 本守卫把纪律固定住：以后新增代码只能走 core/root-scope.js，不能自己再判一次。
//
// 与仓库既有守卫同款（icon-guard / form-controls-factory / outside-click-guard）：
// 白名单**只减不增**，新增裸读直接红。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join, relative} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '../../src');

function walkJs(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walkJs(p, out);
        else if (name.endsWith('.js')) out.push(p);
    }
    return out;
}

const rel = (p) => relative(srcRoot, p).replace(/\\/g, '/');

// 允许出现 `window.__harnessWindow` 的位置，按用途分类，只减不增。
const MULTI_MARK_ALLOWED = {
    'core/root-scope.js': '唯一判定实现所在（注释里解释为什么不直接读）',
    'main.js': 'configureMultiProbe 的定义处（全应用唯一读值点）+ switchWindowMode 的写入点',
    'bridge/bridge-ui.js': '启动恢复时置位（--harness / 上次模式记忆）',
};

// 允许在「需要当前根」的位置使用 windowWorkspacePath 的白名单。
// 它只表示**窗口绑定**的工作区，多工作区下恒空；拿它当「当前根」用必然失效。
// 合法用途只有两类：activeSessionByWorkspace 的 key、单工作区分支。
const WINDOW_PATH_ALLOWED = {
    'ai/ai-panel.js': 'activeSession key / 单工作区分支（已在每条路径上加 isMultiWorkspace 早退）',
    'ai/session/ai-session-list.js': '会话列表的「当前工作区分组」判定（窗口级语义，单工作区才用）',
    'main.js': '注释引用（说明面板内部语义）',
};

test('多工作区判定只允许在 root-scope 与其注入/置位点出现', () => {
    const offenders = [];
    for (const file of walkJs(srcRoot)) {
        const name = rel(file);
        const text = readFileSync(file, 'utf8');
        if (!text.includes('__harnessWindow')) continue;
        // 注释行不算（解释背景时提到它是正常的）
        const code = text.split('\n')
            .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
            .join('\n');
        if (!code.includes('__harnessWindow')) continue;
        if (MULTI_MARK_ALLOWED[name]) continue;
        offenders.push(name);
    }
    assert.deepEqual(offenders, [],
        '这些文件直接读/写了 window.__harnessWindow：模式判定必须收口到 core/root-scope.js 的 '
        + 'isMultiWorkspace()。每多一处直接读，就多一份「漏一个分支」的机会——实测一天内因此 '
        + '踩了 7 个静默失效的 bug。\n'
        + offenders.join('\n'));
});

test('root-scope 是唯一实现，且 main.js 注入了 probe', () => {
    const core = readFileSync(join(srcRoot, 'core/root-scope.js'), 'utf8');
    assert.match(core, /export function isMultiWorkspace\(\)/, 'core 必须导出唯一实现');
    assert.match(core, /export function configureMultiProbe\(/, '必须允许宿主注入 probe（core 不持有应用状态）');
    const main = readFileSync(join(srcRoot, 'main.js'), 'utf8');
    assert.match(main, /configureMultiProbe\(\(\) => !!window\.__harnessWindow\)/,
        'main.js 必须注入 probe——这是全应用唯一的「读值点」');
    // 探针在模块加载时注入，必须早于任何可能读取它的调用。
    // 找「真正的调用」时要跳过注释——注释里提到函数名会误导位置比较（本测试自己踩过）。
    const codeLines = main.split('\n').map((line, i) => ({line, i}))
        .filter(({line}) => !/^\s*(\/\/|\*|\/\*)/.test(line));
    const probeLine = codeLines.find(({line}) => line.includes('configureMultiProbe('));
    const firstUseLine = codeLines.find(({line}) => /\bisMultiWorkspace\(\)/.test(line));
    assert.ok(probeLine, 'main.js 必须调用 configureMultiProbe');
    assert.ok(!firstUseLine || probeLine.i < firstUseLine.i,
        'configureMultiProbe 必须在第一次调用 isMultiWorkspace() 之前（第 '
        + (probeLine.i + 1) + ' 行 vs 第 ' + (firstUseLine ? firstUseLine.i + 1 : '—') + ' 行）');
});

test('windowWorkspacePath 只用于窗口级语义', () => {
    const offenders = [];
    for (const file of walkJs(srcRoot)) {
        const name = rel(file);
        const text = readFileSync(file, 'utf8');
        if (!text.includes('windowWorkspacePath')) continue;
        if (WINDOW_PATH_ALLOWED[name]) continue;
        offenders.push(name);
    }
    assert.deepEqual(offenders, [],
        '这些文件用到了 windowWorkspacePath：它是**窗口绑定**的工作区（多工作区下恒空），'
        + '只在 activeSession key / 单工作区分支里合法。要「当前根」请用 '
        + 'sessionScopeRoot(session) 或 viewRoot()。\n'
        + offenders.join('\n'));
});

test('ai-git-ui 的根来自会话作用域，不是窗口绑定', () => {
    const ui = readFileSync(join(srcRoot, 'ai/tools/ai-git-ui.js'), 'utf8');
    assert.match(ui, /const scopeRoot = ctx\.scopeRoot;/, '参数名必须是 scopeRoot（自带语义，防误传窗口根）');
    assert.doesNotMatch(ui, /windowWorkspacePath/,
        'ai-git-ui 不能用窗口绑定根：多工作区下恒空 → 头部 Git 按钮永久隐藏（实测）');
    const panel = readFileSync(join(srcRoot, 'ai/ai-panel.js'), 'utf8');
    assert.match(panel, /scopeRoot: \(\) => sessionScopeRoot\(currentSession\(\)\)/,
        '注入处必须给会话作用域根');
});

test('sessionHasWorkspace 三态不被真值判断替代', () => {
    const core = readFileSync(join(srcRoot, 'core/root-scope.js'), 'utf8');
    assert.match(core, /export function sessionHasWorkspace/, '必须提供三态判定');
    // 三态的价值：区分「确实没有」与「问不到」，前者要提示、后者要回落
    assert.match(core, /return null;/, '问不到（参数缺失）要返回 null 而不是 false');
});
