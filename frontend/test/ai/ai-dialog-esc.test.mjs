// ESC 弹层栈护栏（2026-11-20 起）：全局 Esc 归 core/overlay-stack.js 的栈序分发——
// 一次 Esc 只退栈顶层；旧「main.js 手写优先级链 + AI 弹窗让路 + env 编辑器抢跑」全部退役。
// 历史根因（留档）：main.js 在 window 捕获阶段无条件 closeTopDialog()（只认设置对话框栈），
// 比 ai-panel.js 冒泡阶段的 closeAIDialog() 先执行，导致设置窗里以 top 方式打开的 AI 二级
// 弹层被 Esc 连带误关。无法在 node 里派发真实键盘事件，按项目惯例用源码断言钉住接线。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const read = (rel) => readFileSync(join(SRC, rel), 'utf8');

test('main.js：Esc 分支先走弹层栈分发，兜底只在栈真空时执行', () => {
    const main = read('main.js');
    const esc = main.indexOf("} else if (e.key === 'Escape') {");
    assert.ok(esc >= 0, '应有全局 ESC 分支');
    const block = main.slice(esc, esc + 700);
    const dispatchAt = block.indexOf('overlayStack.dispatchEscape(e)');
    assert.ok(dispatchAt >= 0, 'ESC 分支必须先问弹层栈');
    const fallbackAt = block.indexOf('closeTopDialog()');
    assert.ok(fallbackAt > dispatchAt, 'closeTopDialog 只能是栈之后的兜底');
    assert.match(block.slice(dispatchAt, fallbackAt), /size\(\) === 0/,
        '兜底必须带 size 空栈守卫——栈让路（Shift+Esc / data-esc-local）时不能关设置窗');
    // 旧让路 hack 已退役
    assert.ok(!block.includes('isAIDialogOpen'), '旧的 isAIDialogOpen 让路查询应已删除');
});

test('main.js：弹层栈监听先于一切弹层工厂安装', () => {
    const main = read('main.js');
    const installAt = main.indexOf('overlayStack.install(window)');
    assert.ok(installAt >= 0, 'main.js 要安装弹层栈监听');
    // 关键约束：install 必须出现在第一个弹层工厂（createSettingsUI）之前，
    // 否则 window 捕获阶段按注册顺序执行时抢不到 stopImmediatePropagation。
    const firstFactoryAt = main.indexOf('createSettingsUI(');
    assert.ok(firstFactoryAt > installAt, 'install 必须先于第一个弹层工厂（createSettingsUI）');
});

test('ai-panel.js：AI 弹窗经 openAIDialog 进栈，旧让路查询已移除', () => {
    const manage = read('ai/settings/ai-manage-dialogs.js');
    assert.match(manage, /overlayStack\.open\(\{[\s\S]*?id: 'ai-dialog'/,
        'openAIDialog 要把 AI 弹窗注册进全局弹层栈');
    assert.match(manage, /id: 'ai-dialog', kind: 'modal'/, 'AI 弹窗归 modal 档');
    const panel = read('ai/ai-panel.js');
    assert.ok(!panel.includes('isAIDialogOpen'), 'isAIDialogOpen 查询已随栈退役');
    // 面板自己的 Esc 监听只收面板内小浮层，不再关 AI 弹窗本体
    assert.ok(!/if \(e\.key === 'Escape'\)[\s\S]{0,200}closeAIDialog\(\)/.test(panel),
        'ai-panel 的 Esc 监听不得再直接关 AI 弹窗（归栈管）');
});

test('settings-dialogs.js：对话框族逐个进栈，遮罩作 underEl', () => {
    const dialogs = read('settings/settings-dialogs.js');
    assert.match(dialogs, /overlayStack\.open\(\{[\s\S]*?id: 'settings-dialog'/,
        'openDialogEl 要把对话框注册进全局弹层栈');
    assert.match(dialogs, /underEl: deps\.elsDialogs\.mask/, '共享遮罩必须作 underEl 钉档位地板');
    assert.match(dialogs, /disposeFamilyHandlesExcept\(null\)/, 'closeDialogs 要把全族出栈');
});

test('旧跨层特判已退役：抢跑监听与 DOM 反查', () => {
    const envvars = read('settings/settings-pane-envvars.js');
    assert.ok(!/addEventListener\('keydown'[\s\S]{0,120}stopImmediatePropagation/.test(envvars),
        '环境变量编辑器的 window capture 抢跑监听应已删除（归栈）');
    const lightbox = read('shell/image-lightbox.js');
    assert.ok(!lightbox.includes("querySelector('.ctx-menu"), '灯箱的右键菜单 DOM 反查应已删除（归栈）');
    const gitBranch = read('shell/titlebar-git-branch.js');
    assert.ok(!/isToolbarPopOpen\(deps\.els\.runConfigPop\) && e\.key === 'Escape'/.test(gitBranch),
        '标题栏三弹层的逐个点名 Esc 应已删除（归栈）');
});

test('栈模块契约：档位表与分发器存在', () => {
    const stack = read('core/overlay-stack.js');
    for (const tier of ['bar: 100', 'lightbox: 1100', 'dialog: 2100', 'modal: 3100', 'popover: 4100', 'menu: 5100']) {
        assert.ok(stack.includes(tier), `档位表缺 ${tier}`);
    }
    assert.match(stack, /dispatchEscape/, '要有 Esc 分发器');
    assert.match(stack, /stopImmediatePropagation/, '消费时要抢占旧监听');
});
