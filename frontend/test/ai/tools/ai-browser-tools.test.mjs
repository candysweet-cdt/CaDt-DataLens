// ai-browser-tools.test.mjs —— 内嵌浏览器工具的脚本构造与入参归一（纯函数）。
// 注入脚本不可读性很强，测试只锁「关键结构」：条件拼接方式、参数转义、非法组合拒绝。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    WAIT_DEFAULT_MS,
    WAIT_MAX_MS,
    WAIT_MIN_MS,
    buildHoverScript,
    buildPressKeyScript,
    buildScrollScript,
    buildSelectScript,
    buildTextClickScript,
    buildWaitProbe,
    clampWaitTimeout,
    describeKeyCombo,
    describeWait,
    keyEventInit,
    resolveSessionBrowserTabId,
} from '../../../src/ai/tools/ai-browser-tools.js';

test('clampWaitTimeout：缺省 5000，非法回落默认，夹在 200–60000', () => {
    assert.equal(clampWaitTimeout(undefined), WAIT_DEFAULT_MS);
    assert.equal(clampWaitTimeout('abc'), WAIT_DEFAULT_MS);
    assert.equal(clampWaitTimeout(0), WAIT_DEFAULT_MS);
    assert.equal(clampWaitTimeout(-5), WAIT_DEFAULT_MS);
    assert.equal(clampWaitTimeout(1), WAIT_MIN_MS);
    assert.equal(clampWaitTimeout(999999), WAIT_MAX_MS);
    assert.equal(clampWaitTimeout('800'), 800);
    assert.equal(clampWaitTimeout(820.6), 821);
});

test('buildWaitProbe：多条件用 && 连接，内容走 JSON 转义', () => {
    const probe = buildWaitProbe({selector: '#a b', text: '完了', url: '/done'});
    assert.ok(probe.startsWith('JSON.stringify({ok: ('));
    assert.ok(probe.includes('&&'));
    // 选择器里的空格与中文都要原样进到 JSON 字符串字面量里
    assert.ok(probe.includes('"#a b"'));
    assert.ok(probe.includes('"完了"'));
    assert.ok(probe.includes('"/done"'));
    // 单条件时不出现多余的 &&
    assert.ok(!buildWaitProbe({selector: '#x'}).includes('&&'));
    assert.throws(() => buildWaitProbe({}), /至少给出/);
});

test('describeWait：按给出的条件拼中文描述，空条件为空串', () => {
    assert.equal(describeWait({}), '');
    assert.equal(describeWait({selector: '#a'}), '元素 #a 出现');
    assert.ok(describeWait({text: '成功', url: '/ok'}).includes('页面出现文本「成功」'));
    assert.ok(describeWait({text: '成功', url: '/ok'}).includes('且'));
});

test('buildScrollScript：selector / byPx / position 三选一，多给少给都报错', () => {
    assert.ok(buildScrollScript({selector: '#footer'}).includes('scrollIntoView'));
    assert.ok(buildScrollScript({byPx: -300}).includes('window.scrollBy(0, -300)'));
    assert.ok(buildScrollScript({position: 'bottom'}).includes('scrollTo(0,'));
    assert.ok(buildScrollScript({position: 'TOP'}).includes('window.scrollTo(0, 0)'));
    // 三选一的边界
    assert.throws(() => buildScrollScript({}), /三选一/);
    assert.throws(() => buildScrollScript({selector: '#a', byPx: 100}), /三选一/);
    assert.throws(() => buildScrollScript({position: 'middle'}), /三选一/);
    // byPx = 0 视为未给（不滚动就不是有效指令）
    assert.throws(() => buildScrollScript({byPx: 0}), /三选一/);
});

test('buildHoverScript：派发三个事件且 selector 转义，空选择器直接拒绝', () => {
    const script = buildHoverScript('.menu > li[data-x="1"]');
    assert.ok(script.includes('mouseover'));
    assert.ok(script.includes('mouseenter'));
    assert.ok(script.includes('mousemove'));
    assert.ok(script.includes('".menu > li[data-x=\\"1\\"]"'));
    assert.throws(() => buildHoverScript('  '), /selector 为空/);
});

test('buildSelectScript：按 value 优先、再按文本，未给条件直接拒绝', () => {
    const byValue = buildSelectScript('#city', {value: 'sh'});
    assert.ok(byValue.includes('"#city"'));
    assert.ok(byValue.includes('wantValue = "sh"'));
    assert.ok(byValue.includes('SELECT'));
    assert.ok(buildSelectScript('#city', {label: '上海'}).includes('"上海"'));
    assert.throws(() => buildSelectScript('', {value: 'x'}), /selector 为空/);
    assert.throws(() => buildSelectScript('#city', {}), /至少给一个/);
});

test('buildTextClickScript：按文本找最小可点击元素，空文本直接拒绝', () => {
    const script = buildTextClickScript('提交');
    assert.ok(script.includes('"提交"'));
    assert.ok(script.includes('cands.sort'));
    // 排序保证「最小」命中：先比文本长度，再比子节点数
    assert.ok(script.indexOf('textOf(a).length - textOf(b).length') > 0);
    assert.throws(() => buildTextClickScript('   '), /text 为空/);
});

test('keyEventInit / describeKeyCombo：修饰符别名映射，未识别别名忽略', () => {
    const init = keyEventInit('k', ['Ctrl', 'shift', 'nope']);
    assert.equal(init.key, 'k');
    assert.equal(init.ctrlKey, true);
    assert.equal(init.shiftKey, true);
    assert.equal(init.altKey, undefined);
    assert.equal(init.metaKey, undefined);
    assert.equal(keyEventInit('', []).key, 'Enter');
    assert.equal(keyEventInit('Enter', ['cmd']).metaKey, true);
    assert.equal(describeKeyCombo('k', ['ctrl', 'shift']), 'Ctrl+Shift+k');
    assert.equal(describeKeyCombo('Tab', ['ctrl', 'ctrl']), 'Ctrl+Tab');
    assert.equal(describeKeyCombo('', []), 'Enter');
});

test('buildPressKeyScript：把修饰符写进 KeyboardEvent 构造参数', () => {
    const script = buildPressKeyScript('s', ['ctrl']);
    assert.ok(script.includes('"ctrlKey":true'));
    assert.ok(script.includes('KeyboardEvent("keydown"'));
    assert.ok(script.includes('KeyboardEvent("keyup"'));
    assert.ok(!buildPressKeyScript('s', []).includes('ctrlKey'));
});

test('resolveSessionBrowserTabId：open_browser_tab 登记 id，close 关当前才清空，其它动作保持', () => {
    // AI 用 app_control open_browser_tab 打开网页后必须把 id 登记到会话，
    // 否则 browser_screenshot 会另开 about:blank 截到白图（2026-11-22 高频 bug）。
    assert.equal(
        resolveSessionBrowserTabId('open_browser_tab', {url: 'https://x'}, {browserTab: {id: 'browser-abc'}}, ''),
        'browser-abc');
    // 结果结构异常时不篡改当前值
    assert.equal(resolveSessionBrowserTabId('open_browser_tab', {}, {}, 'browser-old'), 'browser-old');
    assert.equal(resolveSessionBrowserTabId('open_browser_tab', {}, null, 'browser-old'), 'browser-old');
    // 关闭的正是当前标签页 → 清空；关的是别的标签页 → 保持
    assert.equal(resolveSessionBrowserTabId('close_browser_tab', {id: 'browser-old'}, {closed: true}, 'browser-old'), '');
    assert.equal(resolveSessionBrowserTabId('close_browser_tab', {id: 'browser-other'}, {closed: true}, 'browser-old'), 'browser-old');
    // 无关动作一律保持
    assert.equal(resolveSessionBrowserTabId('screenshot', {}, {image: 'x'}, 'browser-old'), 'browser-old');
    assert.equal(resolveSessionBrowserTabId('get_state', {}, 'ok', 'browser-old'), 'browser-old');
});
