// 表单控件「通用替换」的静态护栏。
//
// 2026-11-15：此前只针对某个 textarea 打补丁，各主题各自硬编码了偏蓝的
// --field-focus-bg，运行时动态创建的裸 checkbox / select 仍是浏览器原生外观。
// 现在统一成「主题变量 + 全局零特异性兜底」，这两条断言防止以后又退化成
// 逐处硬编码 / 逐处补 CSS。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileBuiltInThemeCss} from '../../src/core/theme-model.js';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'style.css'), 'utf8');
const themeCss = compileBuiltInThemeCss();

test('所有主题的聚焦底色都走统一中性变量，不再有硬编码蓝色', () => {
    const defs = [...themeCss.matchAll(/--field-focus-bg:\s*([^;]+);/g)].map((m) => m[1].trim());
    // 2026-11-16 主题体系重构后软件主题只剩深色 / 浅色两套（原九套降级为代码主题，
    // 代码主题块只管编辑器观感，不碰聚焦底色这类界面变量）
    assert.equal(defs.length, 2, '软件主题的聚焦底色定义数量异常：' + defs.length);
    for (const value of defs) {
        assert.equal(value, 'var(--hover)', '发现硬编码聚焦底色：' + value);
    }
});

test('原生 checkbox / radio / 无 class select 有全局零特异性兜底，且排除自绘开关', () => {
    assert.ok(css.includes(':where(input[type="checkbox"]'), '缺少 checkbox 全局兜底');
    assert.ok(css.includes('input[type="radio"]'), '缺少 radio 全局兜底');
    assert.ok(css.includes(':where(select:not([class]))'), '缺少无 class select 全局兜底');
    assert.ok(css.includes(':not(:is(.set-switch input))'), '必须排除已自绘的 .set-switch input');
});
