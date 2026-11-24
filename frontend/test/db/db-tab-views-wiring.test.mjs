// db-tab-views-wiring.test.mjs —— 数据表标签页「插件视图切换」的接线守卫。
//
// 事故背景（2026-11-23）：视图切换用 .hidden 类藏表格面板，而 style.css 里后加的
// `.db-tab-view-pane { display: flex }` 与 `.hidden { display: none }` 同特异性、位置更靠后，
// 直接把 display:none 盖掉——结果切到「图」档时表格仍在、插件视图被挤成 0 高度，
// 界面上表现为「点开图什么都没有」。
// 约定：显隐一律用内联 style.display，别用会被同特异性规则覆盖的类。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../../src/db/db-tab-views.js', import.meta.url)), 'utf8');
const css = readFileSync(fileURLToPath(new URL('../../src/style.css', import.meta.url)), 'utf8');

test('视图切换：表格面板显隐必须走内联 display，不得用 .hidden 类', () => {
    assert.ok(/tablePane\.style\.display = 'none'/.test(src), '切到插件视图时用内联 display:none 藏表格');
    assert.ok(/tablePane\.style\.display = ''/.test(src), '切回表格 / 挂载失败回滚时用内联 display 恢复');
    assert.ok(!/tablePane\.classList\.add\('hidden'\)/.test(src),
        '不得再用 .hidden 类藏表格：它与 .db-tab-view-pane 的 display:flex 同特异性且更靠前');
    assert.ok(!/tablePane\.classList\.remove\('hidden'\)/.test(src), '同上，恢复也不走类');
});

test('样式：.db-tab-view-pane.hidden 兜底规则存在（防同特异性覆盖回归）', () => {
    assert.ok(/\.db-tab-views-body > \.db-tab-view-pane\.hidden \{ display: none; \}/.test(css),
        'CSS 里要有更高特异性的兜底，别只依赖 .hidden');
});

test('插件视图宿主：挂载失败要回滚到表格并提示，不能留空白容器', () => {
    assert.ok(/if \(deps\.flash\) deps\.flash\('「' \+ view\.label \+ '」视图加载失败/.test(src),
        'mount 抛错时要 flash 出原因');
    assert.ok(/wrap\.remove\(\);[\s\S]{0,120}tablePane\.style\.display = '';/.test(src),
        '挂载失败要摘掉容器并把表格显回来');
});

test('插件视图宿主：切走 / 关标签必须销毁插件视图并断开观察器', () => {
    assert.ok(/if \(handle && typeof handle\.destroy === 'function'\) handle\.destroy\(\)/.test(src),
        '切视图时要调插件的 destroy');
    assert.ok(/if \(ro\) ro\.disconnect\(\)/.test(src), 'destroy 要断开 ResizeObserver');
    assert.ok(/if \(themeObs\) themeObs\.disconnect\(\)/.test(src), 'destroy 要断开主题 MutationObserver');
});
