// 守卫：在设置里新建/保存/删除模型账号后，AI 面板主区的「尚未配置 AI / 未配置模型」空态
// 必须立即刷新，而不是要关掉重开才消失。
// 根因：空态在 ai-panel.js 的 renderMessagesInner 里按 profileOf(session) 画到 DOM 上，
// 账号增删改的是内存 config.profiles，不重绘就停在旧空态。switchProfile / importAIConfig
// 收尾都调了 renderMessages(true)，唯独模型账号的增删只调了 updateComposerState（只刷发送按钮/hint）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const modelSettingsSrc = readFileSync(
    fileURLToPath(new URL('../../src/ai/settings/ai-model-settings.js', import.meta.url)), 'utf8');
const panelSrc = readFileSync(
    fileURLToPath(new URL('../../src/ai/ai-panel.js', import.meta.url)), 'utf8');

test('模型账号模块有主区刷新钩子，且包含 renderMessages(true)', () => {
    assert.ok(/const\s+refreshMainView\s*=/.test(modelSettingsSrc),
        'ai-model-settings.js 必须有 refreshMainView 钩子');
    const hook = modelSettingsSrc.match(/const\s+refreshMainView\s*=\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\};/);
    assert.ok(hook, 'refreshMainView 钩子体必须能解析到');
    assert.ok(/renderMessages\(true\)/.test(hook[1]),
        'refreshMainView 必须调用 renderMessages(true) 重绘主区空态（updateComposerState 不重画主区）');
    assert.ok(/isOpen\(\)/.test(hook[1]),
        'refreshMainView 必须先在 isOpen() 时再重绘，避免面板关着时白做 DOM 操作');
});

test('新建/保存、取消、删除模型账号后都要触发主区刷新', () => {
    // closeModelEditor 有两条收尾路径：save=true（保存）与 isCreate 取消；deleteModel 回调是删除。
    // 三处都必须走 refreshMainView，不能退回只调 updateComposerState 的旧写法。
    const saveFlash = "refreshMainView();\n            flash('模型账号已保存：'";
    assert.ok(modelSettingsSrc.includes(saveFlash),
        '保存模型账号后必须 refreshMainView()（不能只 updateComposerState）');
    const deleteFlash = "refreshMainView();\n            flash('已删除模型账号：'";
    assert.ok(modelSettingsSrc.includes(deleteFlash),
        '删除模型账号后必须 refreshMainView()');
    // 取消分支：closeModelEditor 里 modelEditorState=null 后的收尾（无 flash）
    const cancelBlock = modelSettingsSrc.match(/modelEditorState\s*=\s*null;\s*\n\s*disposeEditorStack\(\);([\s\S]*?)\n    \}/);
    assert.ok(cancelBlock, '应能定位 closeModelEditor 的取消收尾块');
    assert.ok(/refreshMainView\(\)/.test(cancelBlock[1]),
        '取消新建模型账号后也必须 refreshMainView()（新建中途取消要恢复成无模型空态）');
});

test('主区空态确实由 renderMessages 按 profileOf 绘制（刷新点有效的前提）', () => {
    assert.ok(/if\s*\(!profileOf\(session\)\s*&&\s*!session\.messages\.length\)/.test(panelSrc),
        'ai-panel.js 必须仍按 profileOf(session) 绘制无模型空态');
    assert.ok(/emptyState\('no-profile'\)/.test(panelSrc),
        '无模型空态必须是 emptyState("no-profile")');
});
