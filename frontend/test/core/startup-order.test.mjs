// 启动顺序护栏：避免设置快照、插件导入器与 Vite 别名回归到 TDZ / 常量赋值 / CJS 默认导出问题。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const frontend = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const main = readFileSync(join(frontend, 'src', 'main.js'), 'utf8');
const settingsUi = readFileSync(join(frontend, 'src', 'settings', 'settings-ui.js'), 'utf8');
const bridgeUi = readFileSync(join(frontend, 'src', 'bridge', 'bridge-ui.js'), 'utf8');
const vite = readFileSync(join(frontend, 'vite.config.js'), 'utf8');

test('打开方式同步走显式 setter，不赋值给 const 快照', () => {
    assert.ok(settingsUi.includes('function setSyncedOpenMode(value)'));
    assert.ok(settingsUi.includes('setSyncedOpenMode, setTheme'));
    assert.ok(main.includes('setSyncedOpenMode, toggleAlwaysOnTop'));
    assert.ok(!main.includes('set syncedOpenMode(v)'));
    assert.ok(bridgeUi.includes('deps.setSyncedOpenMode(mode);'));
});

test('插件导入器惰性调用 openVirtualDoc，避免 bridgeUI 解构前 TDZ', () => {
    const block = main.slice(main.indexOf('const pluginImporter = createPluginImporter({'), main.indexOf('const {openWithPluginImporter}'));
    assert.ok(block.includes('openVirtualDoc: (...args) => openVirtualDoc(...args)'));
    assert.ok(!/^\s*openVirtualDoc,\s*$/m.test(block));
});

test('highlight.js 在 Vite 层固定映射到官方 ESM 入口', () => {
    assert.ok(vite.includes('highlight\\.js\\/lib\\/common'));
    assert.ok(vite.includes('./node_modules/highlight.js/es/common.js'));
});
