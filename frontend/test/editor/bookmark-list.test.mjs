// bookmark-list 测试：书签聚合 / 行预览 / AI 文本格式的纯函数，
// 加一条全链路接线护栏（技能动作表 ↔ APP_ACTIONS ↔ runAppAction 分发 ↔
// 计划模式拦截 ↔ quick-switch 书签层级 ↔ 键位登记与派发）——五动作四处对齐
// 由 ai-app-actions.test.mjs 机械对账，这里补它覆盖不到的形状断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {bookmarkOverview, formatBookmarkListText, linePreview} from '../../src/editor/bookmark-list.js';

const srcRoot = new URL('../../src/', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, srcRoot), 'utf8');

function fakeDoc(path, name, rows, text) {
    return {path, name, bookmarks: new Set(rows), editor: {getText: () => text}};
}

test('linePreview：去缩进、越界空串、超长截断加省略号', () => {
    const lines = ['    function main() {', '', 'x'.repeat(100)];
    assert.equal(linePreview(lines, 1), 'function main() {');
    assert.equal(linePreview(lines, 2), '');
    assert.equal(linePreview(lines, 99), '');
    assert.equal(linePreview(lines, 3).endsWith('…'), true);
    assert.equal(linePreview(null, 1), '');
});

test('bookmarkOverview：只聚合有书签的打开文档，行号升序且 1-based，按路径排序', () => {
    const docs = [
        fakeDoc('D:/a/x.js', 'x.js', [40, 12], 'a\nb\nc'),
        {path: 'D:/a/empty.js', name: 'empty.js', bookmarks: new Set()},
        {path: '', name: 'no-path', bookmarks: new Set([0])},
        {path: 'D:/a/bad.js', name: 'bad.js', bookmarks: new Set([-1, 1.5])},
        fakeDoc('D:/b/y.md', 'y.md', [0], '# 标题'),
    ];
    const groups = bookmarkOverview(docs);
    assert.deepEqual(groups.map((g) => g.path), ['D:/a/x.js', 'D:/b/y.md']);
    assert.deepEqual(groups[0].rows.map((r) => r.line), [13, 41]);
    assert.equal(groups[0].rows[0].preview, ''); // 文本只有 3 行，越界行无预览
    assert.equal(groups[1].rows[0].preview, '# 标题');
    assert.deepEqual(bookmarkOverview([]), []);
    assert.deepEqual(bookmarkOverview(null), []);
});

test('formatBookmarkListText：分组文本、计数与空态指引', () => {
    assert.ok(formatBookmarkListText([]).includes('当前没有书签'));
    assert.ok(formatBookmarkListText(null).includes('当前没有书签'));
    const text = formatBookmarkListText([
        {path: 'D:/a/x.js', name: 'x.js', rows: [{row: 11, line: 12, preview: 'function main() {'}]},
    ]);
    assert.ok(text.includes('D:/a/x.js'));
    assert.ok(text.includes('- 12: function main() {'));
    assert.ok(text.includes('1 个文件 1 个书签'));
    assert.ok(text.includes('goto_bookmark'));
});

test('接线护栏：五动作三处清单 + 计划模式拦截 + quick-switch 层级 + 键位', () => {
    const constants = read('ai/core/ai-constants.js');
    const main = read('main.js');
    const panel = read('ai/ai-panel.js');
    const quickSwitch = read('shell/quick-switch.js');
    const keybindings = read('core/keybindings.js');
    const actions = ['list_bookmarks', 'add_bookmark', 'remove_bookmark', 'clear_bookmarks', 'goto_bookmark'];
    for (const action of actions) {
        assert.ok(constants.includes(`'- ${action}`), 'cadt-ui 技能动作表缺 ' + action);
        assert.ok(main.includes(`'${action}'`), 'main.js 缺 ' + action + ' 登记');
        assert.ok(main.includes(`case '${action}':`), 'runAppAction 缺 ' + action + ' 分发');
    }
    assert.ok(panel.includes("action === 'add_bookmark' || action === 'remove_bookmark' || action === 'clear_bookmarks'"),
        '计划模式拦截缺书签写动作');
    assert.ok(panel.includes('书签是用户可见的编辑器状态'), '计划模式拒绝文案缺书签语义');
    assert.ok(quickSwitch.includes("bookmarks: '书签"), 'quick-switch 缺书签层级标题');
    assert.ok(quickSwitch.includes("e.key === 'Delete' && quickSwitch.level === 'bookmarks'"), 'quick-switch 缺 Delete 删书签');
    assert.ok(quickSwitch.includes('openQuickSwitchAt'), 'quick-switch 缺按层级打开入口');
    assert.ok(keybindings.includes("'edit.bookmarkList'"), '键位表缺书签总览');
    assert.ok(main.includes("keymap.is(kb, 'edit.bookmarkList')"), '键位派发缺书签总览');
    assert.ok(main.includes("openQuickSwitchAt('bookmarks')"), '书签总览未指向 quick-switch 书签层级');
    // app_control 常驻 description 点名书签动作族（可发现性，memo 先例）
    const toolDefs = read('ai/tools/ai-tool-defs.js');
    assert.ok(toolDefs.includes('list_bookmarks / add_bookmark / remove_bookmark / clear_bookmarks / goto_bookmark'),
        'app_control 描述缺书签动作族');
});
