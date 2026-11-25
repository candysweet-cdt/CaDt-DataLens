// 模型选择器布局护栏：设置齿轮必须是搜索框「外面」的独立按钮，不是框内图标。
// 用户反馈：齿轮放在搜索框里会被误读成搜索选项，应作为独立动作入口与搜索框并排。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const js = readFileSync(new URL('../../../src/ai/settings/ai-model-picker.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../../src/style.css', import.meta.url), 'utf8');

test('设置齿轮挂在 topRow 上，与 searchWrap 平级而非塞在搜索框内', () => {
    assert.match(js, /topRow\.append\(searchWrap, settingsBtn\)/, '齿轮应与搜索框并排在 topRow');
    assert.match(js, /searchWrap\.append\(searchIco, search\)/, 'searchWrap 里只能有放大镜 + 输入框');
    assert.doesNotMatch(js, /searchWrap\.append\([^)]*settingsBtn/, '齿轮不能再塞回 searchWrap');
    assert.match(js, /picker\.append\(topRow, listBox, limitRow\)/);
});

test('齿轮按钮有独立描边尺寸，与搜索框视觉分层', () => {
    const block = css.match(/\.ai-model-picker-settings \{([^}]*)\}/s);
    assert.ok(block, '缺少 .ai-model-picker-settings 规则');
    assert.match(block[1], /border:\s*1px solid var\(--border\)/, '齿轮要有独立描边');
    assert.match(block[1], /width:\s*32px/, '与搜索框同高的独立按钮');
    assert.match(css, /\.ai-model-picker-toprow \{[^}]*display:\s*flex/s, '搜索行是 flex 并排容器');
});
