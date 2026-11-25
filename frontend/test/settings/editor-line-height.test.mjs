// editor-line-height.test.mjs：代码编辑器行高设置（editorLineHeight）的接线护栏。
// 背景：vendored Ace 从字体度量（measureNode.clientHeight，font:inherit）算行高，
// 不认 setOption('lineHeight')；行高必须经 --editor-line-height → .ace_editor line-height
// → 显式 checkForSizeChanges 重算 才能生效。任一手断开都会让设置变成「拖了没反应」。
// 无法在 node 里跑真实 WebView，按项目惯例用源码断言钉住全链路。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

test('main.js：editorLineHeight 有 schema / 默认值 1.5 / 归一化夹在 1.2–2', () => {
    const src = read('src/main.js');
    assert.match(src, /editorLineHeight:\s*\{type:\s*'number',\s*min:\s*1\.2,\s*max:\s*2\}/,
        '设置树 schema 必须登记 editorLineHeight 范围，供 app_control 反射与取值整形');
    assert.match(src, /editorLineHeight:\s*1\.5/, '默认行高必须是 1.5（对齐 JetBrains 观感）');
    assert.match(src, /settings\.editorLineHeight\s*=\s*Math\.min\(2,\s*Math\.max\(1\.2,\s*Number\(settings\.editorLineHeight\)\s*\|\|\s*1\.5\)\)/,
        '存量配置的非法行高值必须归一化，且范围与滑块/schema 一致');
});

test('index.html + settings-ui.js：行高滑块存在且双向绑定', () => {
    const html = read('index.html');
    const idAt = html.indexOf('id="opt-editor-line-height"');
    const slider = html.slice(html.lastIndexOf('<input', idAt), idAt + 200);
    assert.match(slider, /type="range"/, '行高控件必须是 range 滑块');
    assert.match(slider, /min="1\.2"/, '行高滑块下限 1.2');
    assert.match(slider, /max="2"/, '行高滑块上限 2');
    assert.match(html, /id="opt-editor-line-height-val"/, '必须有行高数值回显');

    const ui = read('src/settings/settings-ui.js');
    assert.match(ui, /editorLineHeight:\s*document\.getElementById\('opt-editor-line-height'\)/,
        'settings-ui 必须捕获行高滑块元素');
    assert.match(ui, /editorLineHeightVal:\s*document\.getElementById\('opt-editor-line-height-val'\)/,
        'settings-ui 必须捕获数值回显元素');
    assert.match(ui, /elsSettings\.editorLineHeight\.value\s*=\s*String\(deps\.settings\.editorLineHeight\)/,
        'applySettings 必须把当前行高回填到滑块');
    assert.match(ui, /elsSettings\.editorLineHeightVal\.textContent\s*=\s*String\(deps\.settings\.editorLineHeight\)/,
        'applySettings 必须回填数值回显');
});

test('main.js：行高滑块的 input 事件走 applySettings 统一出口', () => {
    const src = read('src/main.js');
    const at = src.indexOf("elsSettings.editorLineHeight.addEventListener('input'");
    assert.ok(at >= 0, '必须绑定行高滑块的 input 事件');
    const body = src.slice(at, at + 260);
    assert.match(body, /settings\.editorLineHeight\s*=\s*Number\(elsSettings\.editorLineHeight\.value\)/,
        '事件必须把滑块值写回 settings');
    assert.match(body, /applySettings\(\)/, '必须走 applySettings 统一出口（落盘 + 广播 + 重绘）');
});

test('settings-ui.js：applySettings 先写 CSS 变量，再显式触发 Ace 度量重算', () => {
    const ui = read('src/settings/settings-ui.js');
    const varAt = ui.indexOf("setProperty('--editor-line-height'");
    assert.ok(varAt >= 0, 'applySettings 必须写 --editor-line-height CSS 变量');
    const aceAt = ui.indexOf('checkForSizeChanges()', varAt);
    assert.ok(aceAt >= 0, '必须显式触发 Ace 字体度量重算——setFontSize 在字号未变时会跳过度量');
    assert.ok(varAt < aceAt, 'CSS 变量必须先写入，Ace 才能量到新行高');
    assert.match(ui.slice(aceAt - 400, aceAt), /ace\.renderer\.\$textLayer/,
        '重算必须落在 renderer.$textLayer 上（Ace getLineHeight 的度量源）');
});

test('style.css：主编辑器与 SQL 控制台的 Ace 都读行高变量', () => {
    const css = read('src/style.css');
    const mainAt = css.indexOf('.jsoneditor .ace_editor,');
    const mainBlock = css.slice(mainAt, css.indexOf('}', mainAt));
    assert.match(mainBlock, /line-height:\s*var\(--editor-line-height,\s*1\.5\)/,
        '主编辑器 Ace 必须用 --editor-line-height（Ace measureNode 靠 font:inherit 继承）');
    const sqlAt = css.indexOf('.db-sql-ace.ace_editor {');
    const sqlBlock = css.slice(sqlAt, css.indexOf('}', sqlAt));
    assert.match(sqlBlock, /line-height:\s*var\(--editor-line-height,\s*1\.5\)/,
        'SQL 控制台 Ace 也要跟随同一变量');
});
