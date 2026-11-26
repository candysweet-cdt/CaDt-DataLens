// ai-harness-wiring 接线守卫（agent-host-platform 批次 F-核心）。
// 背景：A–F 的独立审查抓到的三个 🔴 全是「约定写了、接线漏了」——harness 下 wipe-guard
// 既不报警也不投递，而单看每个文件都「看起来对」。这里把每条接线钉成源码断言：
//   ① 面板返回对象必须真的导出 currentSessionScopeRoot（main.js 有 typeof 守卫，漏了静默回落）；
//   ② wipeguardIsAIActive 必须按根扫描在跑的会话（不是拿当前会话去比对）；
//   ③ 指纹兜底的 preCommand / postCommand 必须用会话根与新形式；
//   ④ bridge-ui 的 harness 分支、⑤ 独立快照槽、⑥ WindowRegister 的 seq、⑦ switchRootLight 换手。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const src = (rel) => readFileSync(fileURLToPath(new URL('../../src/' + rel, import.meta.url)), 'utf8');
const panelSrc = src('ai/ai-panel.js');
const mainSrc = src('main.js');
const bridgeUiSrc = src('bridge/bridge-ui.js');
const restoreSrc = src('shell/session-restore.js');
const pickerSrc = src('ai/session/ai-new-session-picker.js');

test('① 面板必须导出 currentSessionScopeRoot（main.js 靠 typeof 守卫嗅探）', () => {
    // 两条都要：ctx getter 供内部注入用；**面板 return 对象上的属性**才是 main.js 真正调到的那个。
    // 只断言 getter 会假绿——这正是本轮踩过的坑（getter 有、return 对象没有，测试却通过）。
    assert.ok(/get currentSessionScopeRoot\(\) \{ return currentSessionScopeRoot; \}/.test(panelSrc),
        'ai-panel.js 需要 ctx getter（内部注入用）');
    const returnBlock = panelSrc.slice(panelSrc.lastIndexOf('\n    return {'));
    assert.ok(/\n\s+currentSessionScopeRoot,\s*\n/.test(returnBlock),
        'ai-panel.js 的面板 return 对象必须带 currentSessionScopeRoot 属性——'
        + '只定义函数不算，main.js 的 typeof aiPanel.currentSessionScopeRoot 会恒假、'
        + 'currentWatchRoot() 回落树根，harness 下树根为空 ⇒ wipe-guard 监听与周期校准全部不注册');
    assert.ok(mainSrc.includes("typeof aiPanel.currentSessionScopeRoot !== 'function'"),
        'main.js 的 currentSessionScopeRoot 必须保留 typeof 守卫（面板未初始化 / 旧宿主）');
    // currentWatchRoot 已拆到 shell/wipeguard-roots.js（main.js 超线治理）
    const rootsSrc = src('shell/wipeguard-roots.js');
    assert.match(rootsSrc, /deps\.currentSessionScopeRoot\(\)[\s\S]{0,120}?deps\.currentRoot\(\)/,
        'currentWatchRoot 必须会话根优先、视图根兜底（用裸窗口绑定根会让多工作区下退化成无根，监听失明）');
});

test('② wipeguardIsAIActive 按根扫描在跑的会话，不拿当前会话当标尺', () => {
    const at = panelSrc.indexOf('wipeguardIsAIActive: (root) =>');
    assert.ok(at > 0, 'wipeguardIsAIActive 必须存在');
    const body = panelSrc.slice(at, at + 1200);
    assert.ok(body.includes('for (const sess of sessions)'),
        '必须逐个会话按根判定：A 会话在跑、用户切到 B 会话时，A 根的告警仍要算活跃');
    assert.ok(/isSessionBusy\(sess\.id\)/.test(body),
        '在飞与压缩中的会话都算活跃（口径同 ai-session-scope.js 的 isSessionBusy）');
    assert.ok(!/if \(root && aiWorkspaceKey\(root\) !== aiWorkspaceKey\(sessionScopeRoot\(currentSession\(\)\)\)\) return false;/.test(body),
        '不许再拿「当前会话根」当标尺（历史 bug：切走后告警不投递，活跃根还会被 LRU 优先淘汰）');
});

test('③ 指纹兜底：preCommand 传会话根，postCommand 用快照自带根的新形式', () => {
    const pre = panelSrc.match(/preCommand\((.*?)\)/g) || [];
    assert.equal(pre.length, 2, '应有 run_command / background_command 两处 preCommand');
    for (const call of pre) {
        assert.ok(call.includes('sessionScopeRoot(ctx.session)'),
            'preCommand 必须传会话根：harness 下窗口根为空，传窗口根等于整条兜底静默关闭 —— ' + call);
    }
    assert.ok(panelSrc.includes('postCommand(wgFpBefore)'),
        'postCommand 必须用新形式（只传快照）：根取自快照本身，换手期间不会跨仓库比较');
    assert.ok(!/postCommand\(getScopeRoot\(\)/.test(panelSrc),
        '不许再给 postCommand 传窗口根');
});

test('④ bridge-ui：读 GetWindowHarness、置 window.__harnessWindow、只跳过「窗口工作区」恢复、自动开面板', () => {
    assert.ok(bridgeUiSrc.includes('backend.GetWindowHarness'), 'bridge-ui 必须探测 --harness 窗口');
    assert.ok(bridgeUiSrc.includes('window.__harnessWindow = true'), 'harness 标记是 scopeRootOf 第 3 步与独立快照槽的依据');
    // 跳过的是「窗口工作区 / 目标目录的环境」，不是「任何标签」：readSession() 走
    // sessionKeyOf 的独立槽，读自己的快照是安全的（中央指挥 2026-11-26 裁定，代改 bridge-ui）。
    assert.ok(/if \(!floatWindow && !harnessWindow && deps\.backend\.GetPathInfo\)/.test(bridgeUiSrc),
        'harness 下不读目标目录的 workspaceSession 快照（那份会把上个工作区拉回来）');
    assert.ok(!/else if \(!harnessWindow\) \{/.test(bridgeUiSrc),
        '不许再把 readSession() 整段跳过：那会让每次开 harness 都是空窗（它读的是自己的槽）');
    assert.ok(/else \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*const sess = deps\.readSession\(\);/.test(bridgeUiSrc) ||
        /const sess = deps\.readSession\(\);/.test(bridgeUiSrc),
        'readSession() 恢复必须保留');
    assert.ok(/if \(harnessWindow\) \{\s*if \(!deps\.aiPanel\) deps\.initAIPanel\(\);/.test(bridgeUiSrc),
        'harness 窗口要自动打开 AI 面板（它就是主界面）');
});

test('⑤ session-restore：harness 用独立快照槽，且不被 auxWindowNoSession 整体禁用', () => {
    // 键名与分槽规则都搬进了 core/storage-keys.js（E 批的键名 registry）：这里锁「入口」而不锁
    // 字面量的落点——restore 侧必须经 windowSessionKeyOf 取槽，键值本身由 registry 单测覆盖。
    assert.ok(/windowSessionKeyOf\(isMultiWorkspace\(\)\)/.test(restoreSrc),
        'harness 必须有独立槽位（harness 快照与普通窗口单槽分开，见 storage-keys 的 windowSessionKeyOf）');
    assert.ok(restoreSrc.includes('windowSessionKeyOf') && restoreSrc.includes('WORKSPACE_SESSIONS_KEY'),
        '快照槽与按工作区槽都必须从 core/storage-keys.js 取键，不许在业务模块写键名字面量');
    assert.ok(/function sessionKeyOf\(\) \{\s*return windowSessionKeyOf\(isMultiWorkspace\(\)\);/.test(restoreSrc),
        '读写两处都要按窗口形态选槽（模式判定走 core/root-scope 的 isMultiWorkspace，不直接读全局标记）');
    const auxAt = restoreSrc.indexOf('function auxWindowNoSession()');
    const auxBody = restoreSrc.slice(auxAt, auxAt + 600);
    const auxReturn = auxBody.slice(auxBody.indexOf('return '), auxBody.indexOf('}', auxBody.indexOf('return ')));
    assert.ok(!auxReturn.includes('__harnessWindow'),
        'harness 不能进 auxWindowNoSession 的返回值（那是整块禁用读写；harness 的写入要保留）');
    assert.ok(restoreSrc.includes('kvSetJson(sessionKeyOf(), sess)') && restoreSrc.includes('kvGetJson(sessionKeyOf(), null)'),
        '保存与读取都必须走 sessionKeyOf');
});

test('⑥ WindowRegister 必须带自增序号（Go 侧签名是 (workspace, seq)）', () => {
    assert.ok(/backend\.WindowRegister\(dir \|\| '', windowRegSeq\)/.test(mainSrc),
        'main.js 必须传第二个自增序号：Go 侧 WindowRegister(ctx, workspace, seq) 少传会被绑定层拒绝');
    assert.ok(/windowRegSeq \+= 1/.test(mainSrc), '序号要自增');
});

test('⑦ harness 下切会话走原地换手（switchRootLight），不是开新窗口', () => {
    assert.ok(mainSrc.includes("openMode: isMultiWorkspace() ? 'in-place' : 'new-window'"),
        'decideSessionOpen 的 openMode 必须由 isMultiWorkspace() 推导（模式判定收口在 core/root-scope）');
    assert.ok(/case 'switchInPlace':[\s\S]{0,240}switchRootLight\(dir\)/.test(mainSrc),
        'switchInPlace 分支必须调 switchRootLight(dir)——只切根 + 轻刷，不跑 lifecycle 钩子');
});

test('⑧ 新建会话选择器：浮层走 overlayStack，无裸表单控件', () => {
    assert.ok(pickerSrc.includes('overlayStack.open('), '选择器浮层必须注册进 overlay-stack（Esc / 外点 / z-index 档位）');
    for (const tag of ['<input', '<select', '<textarea']) {
        assert.ok(!pickerSrc.includes(tag), '选择器里不许出现裸 ' + tag + '（仓库硬规范：表单控件走 core/form-controls.js）');
    }
    assert.ok(panelSrc.includes('showNewSessionPicker('), 'ai-panel 必须接上选择器');
    // 2026-11-26 改口径：「新建会话」**始终直接建在当前根**（单/多工作区一致，无根则建会话沙盒），
    // 选择器降级为按钮右侧 ⌄ 的入口——挑工作区是例外，不该成为每次新建的必经步骤。
    assert.ok(/function requestNewSession\(\) \{\s*if \(!viewRoot\(\)\) \{\s*newNoWorkspaceSession\(\);/.test(panelSrc),
        'requestNewSession 必须直接在当前根建会话，无根时建成会话沙盒（不再弹选择器）');
    assert.ok(panelSrc.includes('requestNewSessionHere('), '选择器必须保留独立入口（右侧 ⌄）');
});
