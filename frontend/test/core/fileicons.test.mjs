// fileicons.test.mjs —— 文件图标解析护栏。
// 2026-11-18 修：fileIconSpec 的 svg 此前固定返回 mono 文字徽章，右键菜单 / 标题栏 /
// 全局搜索与文件树（createFileIcon 走主题链）显示不一致；现要求两条链同源。
import test from 'node:test';
import assert from 'node:assert/strict';
import {fileIconSpec, setFileIconTheme} from '../../src/core/fileicons.js';

test('扩展名映射：新建菜单常用类型都有专属图标 id', () => {
    for (const ext of ['md', 'py', 'js', 'json', 'go', 'java', 'csv', 'cpp', 'vue',
        'ts', 'html', 'css', 'sql', 'sh', 'ps1', 'bat', 'kt', 'lua',
        'yaml', 'xml', 'toml', 'jsonl', 'ini', 'properties']) {
        assert.notEqual(fileIconSpec('新建文件.' + ext).id, 'text', ext + ' 应映射到专属图标');
    }
    assert.equal(fileIconSpec('新建文件.txt').id, 'text');
});

test('默认 opensource 主题：spec.svg 与文件树同源（vscode-icons 彩色图标）', () => {
    const spec = fileIconSpec('新建文件.json');
    assert.equal(spec.id, 'json');
    assert.ok(spec.svg.includes('#f5de19'), '应返回 OS_ICONS 的黄色 JSON 图标，而不是 mono 兜底徽章');
    assert.ok(spec.svg.includes('viewBox="0 0 32 32"'));
});

test('vue：主题与 mono 兜底两条链都要有图标', () => {
    const spec = fileIconSpec('comp.vue');
    assert.equal(spec.id, 'vue');
    assert.ok(spec.svg.includes('#41b883'), 'opensource 主题下应有官方绿色 Vue 图标');
    setFileIconTheme('mono', {});
    assert.ok(fileIconSpec('comp.vue').svg.includes('<text'), 'mono 兜底应有 V 文字徽章');
    setFileIconTheme('opensource', {}); // 还原默认，避免泄漏到其他用例
});

test('plain 主题：一律通用纸页图标', () => {
    setFileIconTheme('plain', {});
    assert.ok(fileIconSpec('x.json').svg.includes('M4 1.5h5.5'), 'plain 主题应返回 PLAIN_FILE');
    setFileIconTheme('opensource', {});
});

test('插件图标主题可覆盖类型并继承 opensource 兜底', () => {
    const custom = '<svg viewBox="0 0 16 16"><rect width="16" height="16" fill="#c58af9"/></svg>';
    setFileIconTheme('my-icons', {'my-icons': {id: 'my-icons', mode: 'opensource', icons: {json: custom}}});
    assert.ok(fileIconSpec('x.json').svg.includes('#c58af9'));
    assert.ok(fileIconSpec('x.go').svg.includes('viewBox="0 0 32 32"'), '未覆盖类型应继承 opensource');
    setFileIconTheme('my-plain', {'my-plain': {id: 'my-plain', mode: 'plain', icons: {}}});
    assert.ok(fileIconSpec('x.json').svg.includes('M4 1.5h5.5'), '继承 plain 模式应返回通用纸页');
    setFileIconTheme('opensource', {});
});
