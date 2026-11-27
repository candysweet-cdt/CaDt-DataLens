// 插件插桩点接线护栏（S6）：三个 waterfall 点必须真的接进回合循环，且失败不打断对话。
// 这些行为依赖真实插件总线与 Wails 后端，单测跑不到；按仓库惯例用源码切片锁住接线点。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const panel = read('../../src/ai/ai-panel.js');
const main = read('../../src/main.js');

test('面板注入 hookBus getter，延迟求值（总线 loadPlugins 后才初始化）', () => {
    assert.match(panel, /const hookBusOf = \(\) => \{/);
    assert.match(panel, /opts\.hookBus/);
});

test('fireHook 走 waterfall 且吞错，不打断回合', () => {
    const start = panel.indexOf('function fireHook(');
    assert.notEqual(start, -1, '找不到 fireHook');
    const end = panel.indexOf('\n    function ', start + 10);
    const fn = panel.slice(start, end < 0 ? undefined : end);
    assert.match(fn, /bus\.waterfall\(/);
    assert.match(fn, /catch/);
    assert.match(fn, /return value/);
});

test('三个插桩点：agent/pre-step / agent/request / agent/request-error 都接进回合循环', () => {
    const startRound = panel.slice(
        panel.indexOf('function startRound(target) {'),
        panel.indexOf('function handleToolRound('),
    );
    assert.match(startRound, /fireHook\('agent\/pre-step'/);
    assert.match(startRound, /fireHook\('agent\/request'/);
    // request-error 在 finishStreamError 里
    const errStart = panel.indexOf('function finishStreamError(');
    const errEnd = panel.indexOf('\n    function ', errStart + 10);
    const errFn = panel.slice(errStart, errEnd < 0 ? undefined : errEnd);
    assert.match(errFn, /fireHook\('agent\/request-error'/);
});

test('main.js 把 getPluginHookBus 以 getter 注入面板', () => {
    assert.match(main, /getPluginHookBus/);
    assert.match(main, /hookBus: \(\) => getPluginHookBus\(\)/);
});

test('agent/request 的钩子返回值必须是数组才采用（防插件污染请求）', () => {
    const start = panel.indexOf("fireHook('agent/request'");
    const chunk = panel.slice(start, start + 400);
    assert.match(chunk, /Array\.isArray\(hooked\)/);
});
