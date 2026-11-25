// 权限胶囊图标外显护栏：菜单与 composer 胶囊共用同一套档位图标，胶囊上必须常显图标
// （用户要求：不管深色还是浅色主题都要看得见）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const panel = readFileSync(join(SRC, 'ai', 'ai-panel.js'), 'utf8');
const css = readFileSync(join(SRC, 'style.css'), 'utf8');

test('权限图标映射单一来源，四档齐全', () => {
    const fn = panel.match(/function scopeIcon\(scope\) \{[\s\S]*?\n    \}/);
    assert.ok(fn, 'scopeIcon 应存在');
    assert.match(fn[0], /scope === 'full'[\s\S]*?return 'warn'/);
    assert.match(fn[0], /scope === 'auto'[\s\S]*?return 'zap'/);
    assert.match(fn[0], /scope === 'edit'[\s\S]*?return 'shield'/);
    assert.match(fn[0], /return 'eye'/);
});

test('权限菜单与胶囊共用 scopeIcon，不再各写一套映射', () => {
    assert.match(panel, /icon: scopeIcon\(value\)/, '菜单必须使用 scopeIcon');
    assert.match(panel, /iconSvg\(scopeIcon\(scope\), 12\)/, '胶囊必须使用 scopeIcon');
    assert.doesNotMatch(panel, /el\.permission\.textContent = scopeLabel\(scope\)/, '胶囊不能只写文字');
});

test('胶囊插入图标 + 文字 + 箭头三件套', () => {
    assert.match(panel, /icon\.className = 'ai-permission-icon'/);
    assert.match(panel, /label\.className = 'ai-permission-label'/);
    assert.match(panel, /el\.permission\.replaceChildren\(icon, label, chev\)/);
});

test('权限图标有显式尺寸，主题只改颜色不改显示', () => {
    assert.match(css, /#ai-permission \.ai-permission-icon \{[^}]*flex:\s*none;/s);
    assert.match(css, /#ai-permission \.ai-permission-icon svg \{ width: 12px; height: 12px;/);
    assert.match(css, /#ai-permission \.ai-permission-label \{[^}]*text-overflow:\s*ellipsis;/s);
});

test('浅色下权限胶囊有可见的 hover：danger 不再强制透明', () => {
    assert.match(css, /html\[data-theme="light"\] \.ai-composer \.ai-pill:hover \{[^}]*background:\s*var\(--hover\)/s);
    assert.match(css, /html\[data-theme="light"\] \.ai-composer \.ai-pill\.active:hover \{[^}]*background:\s*color-mix\(/s);
    assert.match(css, /html\[data-theme="light"\] #ai-permission\.ai-pill\.danger:hover \{[^}]*background:\s*color-mix\(/s);
    assert.doesNotMatch(css, /html\[data-theme="light"\] #ai-permission\.ai-pill\.danger:hover \{[^}]*background:\s*transparent;/s);
});
