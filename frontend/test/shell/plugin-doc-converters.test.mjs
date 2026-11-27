// 文档格式转换器扩展点护栏（cadt.registerDocConverter）：注册 → 可列举 → 插件重载清空 →
// 重复注册报错进 lastLoadErrors 而不炸运行时 → convert(ctx) 可执行且 ctx 原样透传。
// Word/PDF 等重格式导出依赖全在插件侧（体积约束），扩展点本身必须稳；一个转换器
// 服务所有接入场景（便签面板 / AI 回答另存 / 阅读导出…）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {initPluginRuntime, loadPlugins, getPluginDocConverters} from '../../src/shell/plugins.js';

const source = (code) => ({GetPluginSources: async () => [{id: 't1', name: 'T1', code}]});

test('文档转换器：注册 → 可列举 → 重载清空', async () => {
    initPluginRuntime({});
    const errors = await loadPlugins(source(
        'cadt.registerDocConverter({id: "doc", label: "Word(.doc)", extensions: ["doc"], convert(ctx) { return ctx.suggestedName; }})'));
    assert.deepEqual(errors, []);
    const list = getPluginDocConverters();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 't1:doc', '全 id 带插件前缀');
    assert.equal(list[0].pluginId, 't1');
    // 显示名必须存进记录：导出 ctx 的 ctx.plugin.name 取它，漏了就会回落成插件 id
    assert.equal(list[0].pluginName, 'T1');
    assert.equal(list[0].label, 'Word(.doc)');
    assert.deepEqual(list[0].extensions, ['doc']);

    // 重载（插件禁用/卸载路径）清空注册表
    await loadPlugins({GetPluginSources: async () => []});
    assert.equal(getPluginDocConverters().length, 0);
});

test('文档转换器：非法注册报错进 lastLoadErrors，不炸运行时', async () => {
    initPluginRuntime({});
    // 缺 convert 函数
    const e1 = await loadPlugins(source('cadt.registerDocConverter({id: "bad"})'));
    assert.equal(e1.length, 1);
    assert.match(e1[0], /缺少 convert 函数/);
    // id 非法
    const e2 = await loadPlugins(source('cadt.registerDocConverter({id: "BAD_ID", label: "x", convert(){}})'));
    assert.equal(e2.length, 1);
    assert.match(e2[0], /id 无效/);
    // 重复注册：第一次成功、第二次报错
    const e3 = await loadPlugins(source(
        'cadt.registerDocConverter({id: "doc", label: "A", convert(){}});' +
        'cadt.registerDocConverter({id: "doc", label: "B", convert(){}});'));
    assert.equal(e3.length, 1);
    assert.match(e3[0], /已注册/);
    assert.equal(getPluginDocConverters().length, 1);
    // 旧宿主守卫：没有扩展点的插件代码直接 return 不报错
    const e4 = await loadPlugins(source('if (!cadt.registerDocConverter) return;'));
    assert.deepEqual(e4, []);
});

test('文档转换器：convert(ctx) 由消费方组装并原样透传', async () => {
    initPluginRuntime({});
    await loadPlugins(source(
        'cadt.registerDocConverter({id: "cap", label: "C", convert(ctx) { globalThis.__capCtx = ctx; return ctx.suggestedName; }})'));
    const cv = getPluginDocConverters()[0];
    const stub = {
        chooseSavePath: async () => '',
        writeTextFile: async () => {},
        writeBinaryFile: async () => {},
        flash: () => {},
    };
    const result = await cv.convert({
        source: 'memo', title: '快捷便签 · 工作区', suggestedName: '便签-工作区',
        html: '<html></html>',
        images: [{name: 'x.png', mime: 'image/png', base64: 'AAAA'}],
        chooseSavePath: stub.chooseSavePath, writeTextFile: stub.writeTextFile,
        writeBinaryFile: stub.writeBinaryFile, flash: stub.flash,
    });
    const captured = globalThis.__capCtx;
    delete globalThis.__capCtx;
    assert.equal(result, '便签-工作区', 'convert 的返回值原样回传（测试/调试用）');
    assert.equal(captured.source, 'memo');
    assert.equal(captured.suggestedName, '便签-工作区');
    assert.equal(captured.html, '<html></html>');
    assert.deepEqual(captured.images, [{name: 'x.png', mime: 'image/png', base64: 'AAAA'}]);
    assert.ok(typeof captured.writeBinaryFile === 'function', '二进制落盘原语就位');
});
