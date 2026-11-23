// AI 输入框 Ctrl+Z / Ctrl+Y 护栏。
// 背景：main.js 的全局快捷键无条件把 Ctrl+Z/Y 抢去做编辑器 undo/redo，
// 结果在 AI 会话输入框（原生 textarea）里按 Ctrl+Z 撤销的是代码文件，不是刚打的字。
// 修复分三层：输入框挡冒泡、全局冒泡层豁免普通输入控件、捕获层同样豁免。
// 这些接线无法在 node 里直接派发键盘事件验证，按项目惯例用源码断言钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const read = (rel) => readFileSync(join(SRC, rel), 'utf8');
const norm = (s) => s.replace(/\s+/g, ' ').trim();

test('AI 输入框：Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z 只挡冒泡，不 preventDefault', () => {
    const src = read('ai/chat/ai-composer.js');
    const guard = `(e.ctrlKey || e.metaKey) && !e.altKey && e.key &&
            (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
            e.stopPropagation();
            return;
        }`;
    assert.ok(norm(src).includes(norm(guard)), 'handleComposerKey 里必须有撤销/重做的冒泡拦截');
    const at = src.indexOf('if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key &&');
    assert.ok(at >= 0, '拦截块应存在');
    const block = src.slice(at, at + 320);
    assert.match(block, /e\.stopPropagation\(\);/);
    assert.ok(!/preventDefault/.test(block), '不能 preventDefault，否则 textarea 的原生撤销栈不生效');
});

test('全局豁免只放行普通输入控件，Ace / jsoneditor 仍走编辑器撤销', () => {
    const main = read('main.js');
    const helper = main.match(/function isPlainTextUndoTarget\(\) \{[\s\S]*?\n\}/);
    assert.ok(helper, '应有 isPlainTextUndoTarget 判定（单一来源）');
    assert.match(helper[0], /isTypingTarget\(\)/);
    assert.match(helper[0], /closest\('\.ace_editor'\)/, 'Ace 仍走 doUndo/doRedo');
    assert.match(helper[0], /matches\('textarea\.jsoneditor-text'\)/, 'jsoneditor 仍走 doUndo/doRedo');
});

test('全局冒泡层与捕获层都要调用豁免判定', () => {
    const main = read('main.js');
    // 撤销 / 重做走快捷键风格查表（core/keymap.js），条件是「keymap.is(kb, 'edit.undo')」
    assert.match(main, /keymap\.is\(kb, 'edit\.undo'\)\) \{\s*if \(isPlainTextUndoTarget\(\)\) return;/);
    assert.match(main, /keymap\.is\(kb, 'edit\.redo'\)\) \{\s*if \(isPlainTextUndoTarget\(\)\) return;/);
    // 捕获层：代码模式空撤销栈回退保存态的拦截器，同样不能在输入框里触发
    const capture = main.match(/window\.addEventListener\('keydown', \(e\) => \{\s*if \(!e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey\) return;[\s\S]*?\}, true\);/);
    assert.ok(capture, 'Ctrl+Z 捕获拦截器应存在');
    assert.match(capture[0], /isPlainTextUndoTarget\(\)/, '捕获层也要豁免输入控件，否则在 AI 输入框撤销会回退代码文件');
});

test('右键菜单的撤销/重做仍保留（与键盘共用原生撤销栈）', () => {
    // 菜单结构泛化到 shell/edit-menu.js（全局输入面兜底共用同一份），composer 经
    // openEditMenu 委托并覆盖粘贴（图片 / 折叠分支）；撤销/重做仍是 execCommand 原生命令。
    const src = read('shell/edit-menu.js');
    assert.match(src, /label: '撤销', shortcut: 'Ctrl\+Z'[\s\S]*?execEditable\(target, 'undo'\)/);
    assert.match(src, /label: '重做', shortcut: 'Ctrl\+Y'[\s\S]*?execEditable\(target, 'redo'\)/);
    const composer = read('ai/chat/ai-composer.js');
    assert.match(composer, /openEditMenu\(showContextMenu, event, target, \{paste: \(\) => pasteIntoEditable\(target\)\}\)/);
});
