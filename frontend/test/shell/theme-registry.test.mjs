// 主题注册表与插件重载生命周期护栏。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createThemeRegistry, themeRegistry} from '../../src/core/theme-registry.js';
import {initPluginRuntime, loadPlugins} from '../../src/shell/plugins.js';

function fakeDocument() {
    const created = [];
    return {
        created,
        head: {
            appendChild(style) {
                style.connected = true;
                created.push(style);
            },
        },
        createElement() {
            return {
                dataset: {}, textContent: '', connected: false,
                remove() { this.connected = false; },
            };
        },
    };
}

const source = (id, name = id) => ({id, name});

test('注册界面、代码与图标主题后统一可见', () => {
    const registry = createThemeRegistry(undefined);
    const ui = registry.registerUiTheme({
        id: 'violet-night', name: '紫夜', extends: 'dark', bg: '#241f31',
        vars: {'--bg': '#241f31', '--accent': '#c58af9'},
    }, source('theme-pack'));
    const code = registry.registerCodeTheme({
        id: 'violet-code', name: '紫夜代码', extends: 'jetbrains-dark',
        vars: {'--editor-bg': '#241f31'},
    }, source('theme-pack'));
    const icon = registry.registerIconTheme({
        id: 'violet-icons', name: '紫夜图标', extends: 'opensource',
        icons: {json: '<svg viewBox="0 0 16 16"><path d="M0 0h16v16z"/></svg>'},
    }, source('theme-pack'));
    assert.equal(ui.group, 'plugin');
    assert.equal(ui.pluginId, 'theme-pack');
    assert.equal(code.vars['--syn-keyword'], '#cf8e6d');
    assert.equal(icon.mode, 'opensource');
    assert.ok(registry.hasUiTheme('violet-night'));
    assert.ok(registry.hasCodeTheme('violet-code'));
    assert.ok(registry.hasIconTheme('violet-icons'));
    assert.ok(registry.iconThemeMap()['violet-icons']);
});

test('重复 ID 与坏声明不会留下半成品', () => {
    const doc = fakeDocument();
    const registry = createThemeRegistry(doc);
    registry.registerUiTheme({id: 'pack-theme', name: 'P', extends: 'dark', vars: {'--bg': '#241f31'}}, source('p1'));
    assert.throws(() => registry.registerUiTheme({id: 'pack-theme', name: 'P2'}, source('p2')), /已注册/);
    assert.throws(() => registry.registerCodeTheme({id: 'bad-code', name: 'Bad', vars: {'--bg': '#000000'}}, source('p2')), /未知变量/);
    assert.equal(doc.created.length, 1);
    assert.equal(registry.hasCodeTheme('bad-code'), false);
    assert.equal(registry.listUiThemes().filter((theme) => theme.id === 'pack-theme').length, 1);
});

test('清理与重载同一插件不累积样式、不撞自身 ID', () => {
    const doc = fakeDocument();
    const registry = createThemeRegistry(doc);
    const spec = {id: 'reload-theme', name: '重载', extends: 'dark', vars: {'--bg': '#241f31'}};
    for (let i = 0; i < 3; i++) {
        registry.clearPluginThemes();
        registry.registerUiTheme(spec, source('p1'));
        registry.registerCodeTheme({id: 'reload-code', name: '重载代码', extends: 'jetbrains-dark', vars: {'--editor-bg': '#241f31'}}, source('p1'));
    }
    assert.equal(doc.created.length, 6);
    assert.equal(doc.created.filter((style) => style.connected).length, 2);
    registry.clearPluginThemes();
    assert.equal(doc.created.filter((style) => style.connected).length, 0);
    assert.equal(registry.hasUiTheme('reload-theme'), false);
    assert.equal(registry.hasCodeTheme('reload-code'), false);
    assert.equal(registry.hasUiTheme('dark'), true);
});

test('按插件移除只清理该来源，订阅方收到一次通知', () => {
    const registry = createThemeRegistry(undefined);
    registry.registerUiTheme({id: 'p1-theme', name: 'P1', extends: 'dark', vars: {'--bg': '#241f31'}}, source('p1'));
    registry.registerUiTheme({id: 'p2-theme', name: 'P2', extends: 'dark', vars: {'--bg': '#332241'}}, source('p2'));
    let notifications = 0;
    const unsubscribe = registry.subscribe(() => notifications++);
    registry.removePluginThemes('p1');
    assert.equal(notifications, 1);
    assert.equal(registry.hasUiTheme('p1-theme'), false);
    assert.equal(registry.hasUiTheme('p2-theme'), true);
    unsubscribe();
    registry.removePluginThemes('p2');
    assert.equal(notifications, 1);
});

test('继承主题卸载后，已展开的子主题仍可独立使用', () => {
    const registry = createThemeRegistry(undefined);
    registry.registerUiTheme({id: 'parent-theme', name: '父主题', extends: 'dark', vars: {'--bg': '#241f31'}}, source('parent'));
    registry.registerUiTheme({id: 'child-theme', name: '子主题', extends: 'parent-theme', vars: {'--text': '#e8e3f2'}}, source('child'));
    registry.removePluginThemes('parent');
    assert.equal(registry.getUiTheme('child-theme').vars['--bg'], '#241f31');
    registry.registerCodeTheme({id: 'after-parent', name: '后续主题', extends: 'jetbrains-dark', vars: {'--editor-bg': '#241f31'}}, source('other'));
    assert.equal(registry.hasCodeTheme('after-parent'), true);
});

test('当前主题缺失时回退，非当前主题卸载不修改设置', () => {
    const registry = createThemeRegistry(undefined);
    registry.registerUiTheme({id: 'current-theme', name: '当前', extends: 'dark', vars: {'--bg': '#241f31'}}, source('p1'));
    registry.registerCodeTheme({id: 'current-code', name: '当前代码', extends: 'jetbrains-dark', vars: {'--editor-bg': '#241f31'}}, source('p1'));
    const settings = {theme: 'current-theme', codeStyle: 'current-code', iconTheme: 'opensource'};
    assert.equal(registry.reconcileSettings(settings), false);
    registry.removePluginThemes('p1');
    assert.equal(registry.reconcileSettings(settings), true);
    assert.deepEqual(settings, {theme: 'dark', codeStyle: 'auto', iconTheme: 'opensource'});
    assert.equal(registry.reconcileSettings(settings), false);
});

test('高级 css 与结构化变量进入同一插件样式节点', () => {
    const doc = fakeDocument();
    const registry = createThemeRegistry(doc);
    registry.registerUiTheme({
        id: 'raw-theme', name: 'Raw', extends: 'dark', vars: {'--bg': '#241f31'},
        css: 'html[data-theme="raw-theme"] .x { color: var(--text); }',
    }, source('p1'));
    assert.match(doc.created[0].textContent, /--bg: #241f31;/);
    assert.match(doc.created[0].textContent, /html\[data-theme="raw-theme"\] \.x/);
});

test('插件重载：三类主题可重复加载，失败插件会回滚本轮主题', async () => {
    initPluginRuntime({});
    const code = `
        cadt.addTheme({id: 'plugin-night', name: '插件夜', extends: 'dark', vars: {'--bg': '#241f31'}});
        cadt.addCodeTheme({id: 'plugin-code', name: '插件代码', extends: 'jetbrains-dark', vars: {'--editor-bg': '#241f31'}});
        cadt.registerIconTheme({id: 'plugin-icons', name: '插件图标', extends: 'opensource', icons: {json: '<svg viewBox="0 0 16 16"><path d="M0 0h16v16z"/></svg>'}});
    `;
    const backend = {GetPluginSources: async () => [source('theme-plugin', '主题插件')]};
    backend.GetPluginSources = async () => [{...source('theme-plugin', '主题插件'), code}];
    assert.deepEqual(await loadPlugins(backend), []);
    assert.ok(themeRegistry.hasUiTheme('plugin-night'));
    assert.ok(themeRegistry.hasCodeTheme('plugin-code'));
    assert.ok(themeRegistry.hasIconTheme('plugin-icons'));
    assert.deepEqual(await loadPlugins(backend), []);
    assert.equal(themeRegistry.listUiThemes().filter((theme) => theme.id === 'plugin-night').length, 1);

    const failing = {GetPluginSources: async () => [{
        ...source('bad-plugin', '坏插件'),
        code: "cadt.addTheme({id: 'partial-theme', name: '半成品', extends: 'dark'}); throw new Error('boom');",
    }]};
    const errors = await loadPlugins(failing);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /boom/);
    assert.equal(themeRegistry.hasUiTheme('partial-theme'), false);
    assert.equal(themeRegistry.hasUiTheme('plugin-night'), false);
});

test('连续请求插件重载时，最新请求最终生效', async () => {
    initPluginRuntime({});
    let release;
    const first = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const backend = {
        GetPluginSources: async () => {
            calls++;
            if (calls === 1) return first;
            return [{...source('latest', '最新插件'), code: "cadt.addTheme({id: 'latest-theme', name: '最新', extends: 'dark'});"}];
        },
    };
    const oldLoad = loadPlugins(backend);
    const newLoad = loadPlugins(backend);
    release([{...source('old', '旧插件'), code: "cadt.addTheme({id: 'old-theme', name: '旧', extends: 'dark'});"}]);
    await Promise.all([oldLoad, newLoad]);
    assert.equal(themeRegistry.hasUiTheme('latest-theme'), true);
    assert.equal(themeRegistry.hasUiTheme('old-theme'), false);
});
