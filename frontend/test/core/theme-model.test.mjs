// 统一主题数据、继承、校验与 CSS 生成的纯逻辑护栏。
import test from 'node:test';
import assert from 'node:assert/strict';
import definitions from '../../src/core/themes.json' with {type: 'json'};
import {
    BUILTIN_CODE_THEMES, BUILTIN_ICON_THEMES, BUILTIN_UI_THEMES,
    CODE_TOKEN_VARS, EDITOR_CHROME_VARS, UI_THEME_VARS,
    compileBuiltInThemeCss, compileThemeCss, legacyThemeMap,
    normalizeCodeTheme, normalizeIconTheme, normalizeUiTheme, resolveThemeCatalog,
} from '../../src/core/theme-model.js';

test('内置主题数量与 ID 稳定', () => {
    assert.equal(BUILTIN_UI_THEMES.length, 2);
    assert.deepEqual(BUILTIN_UI_THEMES.map((theme) => theme.id), ['dark', 'light']);
    assert.equal(BUILTIN_CODE_THEMES.length, 9);
    assert.equal(BUILTIN_ICON_THEMES.length, 3);
    assert.deepEqual(BUILTIN_ICON_THEMES.map((theme) => theme.id), ['opensource', 'mono', 'plain']);
    assert.ok(UI_THEME_VARS.includes('--gg-lane-0'));
    assert.ok(UI_THEME_VARS.includes('--us-heat-4'));
});

test('所有内置界面主题可完整展开，元数据与变量一致', () => {
    const required = new Set(UI_THEME_VARS);
    for (const theme of BUILTIN_UI_THEMES) {
        for (const key of required) assert.ok(theme.vars[key], theme.id + ' 缺少 ' + key);
        assert.equal(theme.bg.toLowerCase(), theme.vars['--bg'].toLowerCase());
        assert.equal(theme.accent.toLowerCase(), theme.vars['--accent'].toLowerCase());
        assert.ok(BUILTIN_CODE_THEMES.some((style) => style.id === theme.defaultCodeStyle));
    }
});

test('所有内置代码主题具备 25 项代码变量', () => {
    for (const theme of BUILTIN_CODE_THEMES) {
        for (const key of [...CODE_TOKEN_VARS, ...EDITOR_CHROME_VARS]) {
            assert.ok(theme.vars[key], theme.id + ' 缺少 ' + key);
        }
        assert.ok(!('--bg' in theme.vars));
        assert.ok(!('--text' in theme.vars));
    }
});

test('界面主题继承只写差异项，结果与完整声明一致', () => {
    const spec = normalizeUiTheme({
        id: 'violet-night', name: '紫夜', extends: 'dark', bg: '#241f31', accent: '#c58af9',
        vars: {'--bg': '#241f31', '--text': '#e8e3f2', '--accent': '#c58af9'},
    });
    const [resolved] = resolveThemeCatalog([...definitions.uiThemes, spec], 'ui').filter((theme) => theme.id === spec.id);
    assert.equal(resolved.colorScheme, 'dark');
    assert.equal(resolved.vars['--panel'], BUILTIN_UI_THEMES[0].vars['--panel']);
    assert.equal(resolved.vars['--text'], '#e8e3f2');
    assert.equal(resolved.defaultCodeStyle, 'jetbrains-dark');
    assert.match(compileThemeCss(resolved, 'ui'), /html\[data-theme="violet-night"\]/);
});

test('代码主题继承补齐变量并拒绝覆盖界面变量', () => {
    const spec = normalizeCodeTheme({
        id: 'violet-code', name: '紫夜代码', extends: 'jetbrains-dark', group: 'dark',
        vars: {'--editor-bg': '#241f31', '--syn-keyword': '#c58af9'},
    });
    const [resolved] = resolveThemeCatalog([...definitions.codeThemes, spec], 'code').filter((theme) => theme.id === spec.id);
    assert.equal(Object.keys(resolved.vars).length, 25);
    assert.equal(resolved.vars['--syn-string'], BUILTIN_CODE_THEMES[0].vars['--syn-string']);
    assert.throws(() => normalizeCodeTheme({
        id: 'bad-code', name: '坏主题', extends: 'jetbrains-dark', vars: {'--bg': '#000000'},
    }), /未知变量/);
});

test('图标主题继承合并映射并保留模式', () => {
    const svg = '<svg viewBox="0 0 16 16"><path d="M0 0h16v16z"/></svg>';
    const spec = normalizeIconTheme({id: 'my-icons', name: '我的图标', extends: 'opensource', icons: {json: svg}});
    const [resolved] = resolveThemeCatalog([...definitions.iconThemes, spec], 'icon').filter((theme) => theme.id === spec.id);
    assert.equal(resolved.mode, 'opensource');
    assert.equal(resolved.icons.json, svg);
});

test('非法 ID、颜色、变量内容、缺失父主题与循环继承均拒绝', () => {
    assert.throws(() => normalizeUiTheme({id: 'BAD', name: 'x'}), /id 无效/);
    assert.throws(() => normalizeUiTheme({id: 'bad-bg', name: 'x', bg: 'red'}), /六位十六进制/);
    assert.throws(() => normalizeUiTheme({id: 'bad-var', name: 'x', vars: {'--bg': '#000; color:red'}}), /非法内容/);
    assert.throws(() => resolveThemeCatalog([{id: 'missing', name: 'x', extends: 'nope', vars: {}}], 'ui'), /继承目标不存在/);
    const cycle = [
        {id: 'cycle-a', name: 'A', extends: 'cycle-b', vars: {}},
        {id: 'cycle-b', name: 'B', extends: 'cycle-a', vars: {}},
    ];
    assert.throws(() => resolveThemeCatalog(cycle, 'ui'), /继承循环/);
});

test('bg 必须与最终 --bg 一致', () => {
    assert.throws(() => resolveThemeCatalog([{
        id: 'mismatch', name: '不一致', colorScheme: 'dark', bg: '#000000', vars: {'--bg': '#ffffff'},
    }], 'ui'), /bg 与 --bg 不一致/);
});

test('生成 CSS 包含全部内置主题且旧主题迁移只来自数据文件', () => {
    const css = compileBuiltInThemeCss();
    assert.equal([...css.matchAll(/html\[data-theme="[^"]+"\]/g)].length, 2);
    assert.equal([...css.matchAll(/html\[data-theme\]\[data-code-style=/g)].length, 9);
    assert.ok(css.includes('color-scheme: light;'));
    assert.ok(css.includes('--gg-lane-11: #5c6bc0;'));
    assert.ok(css.includes('--us-heat-4: #216e39;'));
    assert.deepEqual(legacyThemeMap(), {
        darcula: 'dark', 'idea-dark': 'dark', night: 'dark',
        'idea-light': 'light', github: 'light', newsprint: 'light',
        harness: 'light', pixyll: 'light', whitey: 'light',
    });
});
