// app-links-readonly.test.mjs —— 内置法律文档只读视图接线护栏。
// 用户协议 / 隐私协议是内嵌的虚拟文档（无真实路径、无法保存），必须以固定只读
// （readOnlyFixed）打开：不可解锁、右键不出现解锁入口，与审阅快照同一机制。
// app-links.js 顶层 import 了 ?raw 文本，Node 无法直接执行，故按仓库惯例做源码接线断言。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const src = readFileSync(new URL('../../src/shell/app-links.js', import.meta.url), 'utf8');
const mainSrc = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');

test('openBundledDoc 把 readOnlyFixed 标记透传给 openVirtualDoc', () => {
    assert.match(src,
        /openVirtualDoc\(name,\s*text,\s*readOnlyFixed\s*\?\s*\{readOnlyFixed:\s*true\}\s*:\s*undefined\)/,
        'openBundledDoc 必须在 readOnlyFixed 时以 {readOnlyFixed: true} 建虚拟文档');
});

test('用户协议、隐私协议与教程以固定只读打开', () => {
    const terms = src.match(/function showTerms\(\)\s*\{([\s\S]*?)\}/);
    const privacy = src.match(/function showPrivacy\(\)\s*\{([\s\S]*?)\}/);
    const tutorial = src.match(/function showTutorial\(\)\s*\{([\s\S]*?)\}/);
    assert.ok(terms, '必须存在 showTerms');
    assert.ok(privacy, '必须存在 showPrivacy');
    assert.ok(tutorial, '必须存在 showTutorial');
    assert.match(terms[1], /openBundledDoc\([\s\S]*?,\s*true\)/, 'showTerms 必须传 readOnlyFixed=true');
    assert.match(privacy[1], /openBundledDoc\([\s\S]*?,\s*true\)/, 'showPrivacy 必须传 readOnlyFixed=true');
    assert.match(tutorial[1], /openBundledDoc\([\s\S]*?,\s*true\)/, 'showTutorial 必须传 readOnlyFixed=true');
});

// 更新日志不再内嵌：本地 CHANGELOG.md 已近 1 MB，必须以 ?raw 打进前端包是历史做法。
// 现在走内置浏览器打开 Gitee 在线页面，源码与 main.js 都不许再出现 CHANGELOG.md?raw 导入。
test('CHANGELOG.md 不再以 ?raw 打进前端包', () => {
    assert.doesNotMatch(src, /CHANGELOG\.md\?raw/, 'app-links.js 不得再导入 CHANGELOG.md?raw');
    assert.doesNotMatch(mainSrc, /CHANGELOG\.md\?raw/, 'main.js 不得再导入 CHANGELOG.md?raw');
});

test('更新日志在线地址指向 Gitee 仓库的 CHANGELOG.md', () => {
    assert.match(src,
        /appChangelogUrl\s*=\s*'https:\/\/gitee\.com\/candysweet-cdt\/CaDt-DataLens\/blob\/master\/CHANGELOG\.md'/,
        'appChangelogUrl 必须指向 Gitee 在线更新日志');
});

test('showChangelog 走 openBrowserTab，同地址标签复用，缺省降级系统浏览器', () => {
    const fn = src.match(/function showChangelog\(\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(fn, '必须存在 showChangelog');
    assert.match(fn[1], /typeof deps\.openBrowserTab\s*!==\s*'function'/, '未注入时降级');
    assert.match(fn[1], /openExternalUrl\(appChangelogUrl\)/, '降级走系统浏览器打开在线地址');
    assert.match(fn[1], /deps\.docs\.find\(\(d\)\s*=>\s*d\.browser\s*&&\s*d\.browserUrl\s*===\s*appChangelogUrl\)/,
        '复用已打开的同地址浏览器标签');
    assert.match(fn[1], /deps\.activateDoc\(existing\)/, '复用时激活已有标签');
    assert.match(fn[1], /deps\.openBrowserTab\(appChangelogUrl\)/, '新建时走内置浏览器标签');
    // 不再用 openBundledDoc 内嵌更新日志
    assert.doesNotMatch(fn[1], /openBundledDoc/, 'showChangelog 不得再内嵌虚拟文档');
});

test('main.js 给 createAppLinks 注入 openBrowserTab', () => {
    const block = mainSrc.match(/createAppLinks\(\{([\s\S]*?)\n\}\)/);
    assert.ok(block, '必须存在 createAppLinks 调用');
    assert.match(block[1], /get openBrowserTab\(\)\s*\{\s*return openBrowserTab;\s*\}/,
        'createAppLinks 依赖里必须注入 openBrowserTab');
});
