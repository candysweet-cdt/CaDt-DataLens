// AI 输入区「双击 Esc 停止生成」接线护栏。
// 判定与全局搜索「双击 Shift」共用 core/shift-double-tap.js（key: 'Escape'）；
// 输入框监听无法在 node 里派发键盘事件验证，按项目惯例用源码断言钉住三处接线：
// composer 喂 keydown（先于 IME 早退）/ keyup 结算停会话 / 面板挂监听并经 ctx 注入停止能力。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const read = (rel) => readFileSync(join(SRC, rel), 'utf8');

test('ai-composer.js：Escape 状态机实例 + keydown 登记先于 IME 早退', () => {
    const src = read('ai/chat/ai-composer.js');
    assert.match(src, /import \{createShiftDoubleTap\} from '\.\.\/\.\.\/core\/shift-double-tap\.js';/,
        '判定器单一来源，不复制状态机');
    assert.match(src, /createShiftDoubleTap\(\{key: 'Escape'\}\)/, '键位参数化成 Escape');
    const fn = src.match(/function handleComposerKey\(e\) \{[\s\S]*?\n    \}/);
    assert.ok(fn, 'handleComposerKey 应存在');
    const feedAt = fn[0].indexOf('escDoubleTap.onKeyDown(e);');
    const guardAt = fn[0].indexOf('if (e.isComposing || e.keyCode === 229) return;');
    assert.ok(feedAt >= 0, 'keydown 必须喂给状态机');
    assert.ok(guardAt > 0, 'IME 早退应存在');
    assert.ok(feedAt < guardAt, '喂状态机必须先于 IME 早退——组字中的按键也要清零配对');
});

test('ai-composer.js：keyup 结算触发停止，与停止按钮同一条路径（byUser=true）', () => {
    const src = read('ai/chat/ai-composer.js');
    const fn = src.match(/function handleComposerKeyUp\(e\) \{[\s\S]*?\n    \}/);
    assert.ok(fn, 'handleComposerKeyUp（keyup 结算）应存在');
    assert.match(fn[0], /if \(!escDoubleTap\.onKeyUp\(e\)\) return;/, 'keydown 只登记，keyup 才结算');
    assert.match(fn[0], /stopGeneration\(undefined, true\)/, 'byUser=true 才触发 stop 生命周期，与停止按钮一致');
    assert.match(src, /const stopGeneration = ctx\.stopGeneration;/, '停止能力经 ctx 注入，不反向 import 面板');
    assert.match(src, /\n        handleComposerKeyUp,/, 'handleComposerKeyUp 必须导出供面板挂监听');
});

test('ai-panel.js：输入框 keyup 监听 + composerMod 转发 + ctx 注入 stopGeneration', () => {
    const src = read('ai/ai-panel.js');
    assert.match(src, /el\.input\.addEventListener\('keyup', handleComposerKeyUp\);/,
        'keyup 与 keydown 同挂输入框——只有 composer 聚焦时手势才生效');
    assert.match(src, /const handleComposerKeyUp = \(\.\.\.args\) => composerMod\.handleComposerKeyUp\(\.\.\.args\);/,
        '经 composerMod 惰性转发');
    assert.match(src, /stopGeneration: \(\.\.\.args\) => stopGeneration\(\.\.\.args\),/, 'ctx 注入停止能力');
});
