// plugin-ctx.test.mjs —— 插件回调上下文基座（shell/plugin-ctx.js）的契约。
//
// 这里钉住的是「只加键、不改键」这条纪律的可执行部分：基座必须有哪几个键、
// 身份不能被某个入口的域字段抹掉、flash 不给就没有（而不是留个静默空实现）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {PLUGIN_CTX_ORIGINS, pluginCtxBase, withCtx} from '../../src/shell/plugin-ctx.js';

test('基座恒有 plugin / workspace / sessionId / origin 四个键', () => {
    const ctx = pluginCtxBase();
    assert.deepEqual(Object.keys(ctx).sort(), ['origin', 'plugin', 'sessionId', 'workspace'].sort());
    assert.deepEqual(ctx.plugin, {id: '', name: ''});
    assert.equal(ctx.workspace, '');
    assert.equal(ctx.sessionId, '');
    assert.equal(ctx.origin, '');
});

test('plugin.name 缺省回落 id（插件只给了 id 时不必写两遍）', () => {
    assert.equal(pluginCtxBase({pluginId: 'demo'}).plugin.name, 'demo');
    assert.equal(pluginCtxBase({pluginId: 'demo', pluginName: '  '}).plugin.name, 'demo');
    assert.equal(pluginCtxBase({pluginId: 'demo', pluginName: '演示'}).plugin.name, '演示');
});

test('归一化边界：id / name 去空白，workspace 原样透传', () => {
    const ctx = pluginCtxBase({
        pluginId: ' demo ', pluginName: ' 演示插件 ',
        workspace: 'D:/ws', sessionId: 42, origin: PLUGIN_CTX_ORIGINS.command,
    });
    assert.deepEqual(ctx.plugin, {id: 'demo', name: '演示插件'});
    assert.equal(ctx.workspace, 'D:/ws');
    assert.equal(ctx.sessionId, '42');
    assert.equal(ctx.origin, 'command');
    // 路径不做 trim / 规范化：拼资产与落盘都要和磁盘上的真实目录逐字一致
    const raw = pluginCtxBase({workspace: 'D:/a b/'});
    assert.equal(raw.workspace, 'D:/a b/');
    // 安装目录不放进基座（各入口记录里只有 id/name）：插件自己的目录仍用 cadt.getPluginDir()
    assert.deepEqual(Object.keys(pluginCtxBase({pluginId: 'demo'}).plugin).sort(), ['id', 'name']);
});

test('flash 只在给到时注入，且消息与错误位都归一化', () => {
    const bare = pluginCtxBase({pluginId: 'demo'});
    assert.equal('flash' in bare, false, '不给 flash 就不该有键——不能留静默空实现');

    const calls = [];
    const ctx = pluginCtxBase({
        pluginId: 'demo',
        flash: (message, isError) => calls.push([message, isError]),
    });
    assert.equal(typeof ctx.flash, 'function');
    ctx.flash(null);
    ctx.flash('出错了', true);
    assert.deepEqual(calls, [['', false], ['出错了', true]]);
});

test('withCtx 允许域字段覆盖 workspace / sessionId / origin', () => {
    const base = pluginCtxBase({pluginId: 'demo', workspace: 'D:/a', sessionId: 's0', origin: 'command'});
    const ctx = withCtx(base, {workspace: 'D:/b', sessionId: 's1', origin: 'tool', scope: 'edit'});
    assert.equal(ctx.workspace, 'D:/b');
    assert.equal(ctx.sessionId, 's1');
    assert.equal(ctx.origin, 'tool');
    assert.equal(ctx.scope, 'edit');
});

test('身份恒取基座：域字段写 plugin 也抹不掉', () => {
    const base = pluginCtxBase({pluginId: 'demo', pluginName: '演示'});
    const ctx = withCtx(base, {plugin: {id: '', name: ''}});
    assert.deepEqual(ctx.plugin, {id: 'demo', name: '演示'});
});

test('withCtx 对空基座 / 空域字段安全（不 mutate 入参）', () => {
    assert.deepEqual(withCtx(undefined), {});
    assert.deepEqual(withCtx(null, null), {});
    const base = pluginCtxBase({pluginId: 'demo'});
    const merged = withCtx(base, {a: 1});
    assert.equal('a' in base, false, '基座对象不能被改写');
    assert.equal(merged.a, 1);
});

test('origin 枚举覆盖全部回调入口（新增入口时这里会红）', () => {
    assert.deepEqual(
        Object.keys(PLUGIN_CTX_ORIGINS).sort(),
        ['classifier', 'command', 'editor', 'export', 'open', 'prompt', 'settings', 'tool', 'workspace']);
    for (const [key, value] of Object.entries(PLUGIN_CTX_ORIGINS)) {
        assert.equal(key, value, 'origin 的键与值必须同名，插件才能用字符串比较');
    }
});
