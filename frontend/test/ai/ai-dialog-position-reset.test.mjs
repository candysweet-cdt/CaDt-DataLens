// 守卫：模型账号编辑器 / 环境变量编辑器靠 .dialog 的 translate(-50%,-50%) 居中，
// 而 createDialogDrag 拖头部会写内联 transform:none + left/top 像素值。打开时若不清，
// ui-dialog-in 入场动画结束后会回落到残留的内联定位，弹窗先偏一下再跳回（开合闪现）。
// 标准弹窗族在 openDialogEl 里清了，这两个独立弹窗必须同样处理。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const modelSrc = readFileSync(
    fileURLToPath(new URL('../../src/ai/settings/ai-model-settings.js', import.meta.url)), 'utf8');
const envSrc = readFileSync(
    fileURLToPath(new URL('../../src/settings/settings-pane-envvars.js', import.meta.url)), 'utf8');

function assertClearsInlinePosition(src, label, removeHiddenLine) {
    const at = src.indexOf(removeHiddenLine);
    assert.ok(at >= 0, `${label} 应能定位到 classList.remove('hidden')`);
    const before = src.slice(Math.max(0, at - 400), at);
    for (const prop of ['left', 'top', 'transform']) {
        assert.ok(new RegExp(`\\.style\\.${prop}\\s*=\\s*''`).test(before),
            `${label} 打开前必须清空内联 style.${prop}（对齐 openDialogEl，防拖拽残留导致入场跳位）`);
    }
}

test('打开模型账号编辑器前清掉拖拽残留的内联定位', () => {
    assertClearsInlinePosition(modelSrc, 'openModelEditor',
        "opt.modelEditor.classList.remove('hidden');");
});

test('打开环境变量编辑器前清掉拖拽残留的内联定位', () => {
    assertClearsInlinePosition(envSrc, 'openEnvVarEditor',
        "dlg.classList.remove('hidden');");
});
