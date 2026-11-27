// palette-model.test.mjs —— 命令面板纯逻辑：标签拆分 / 分组 / 模糊评分 / 组图标。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parsePaletteLabel, fuzzyScore, groupActions, groupIcon, DEFAULT_GROUP_ICON,
} from '../../src/shell/palette-model.js';

test('parsePaletteLabel：中文冒号前缀拆成组 + 文本，去空白', () => {
    assert.deepEqual(parsePaletteLabel('文件： Markdown'), {group: '文件', text: 'Markdown'});
    assert.deepEqual(parsePaletteLabel('AI： 新建会话'), {group: 'AI', text: '新建会话'});
    assert.deepEqual(parsePaletteLabel('  工具 ：  比较文件  '), {group: '工具', text: '比较文件'});
});

test('parsePaletteLabel：无前缀 / 空段 / 英文冒号都归到无组', () => {
    assert.deepEqual(parsePaletteLabel('打开设置'), {group: '', text: '打开设置'});
    assert.deepEqual(parsePaletteLabel('文件：'), {group: '', text: '文件：'});
    assert.deepEqual(parsePaletteLabel('：内容'), {group: '', text: '：内容'});
    // 英文冒号（路径 / URL）不当组前缀
    assert.deepEqual(parsePaletteLabel('打开 D:/data/a.json'), {group: '', text: '打开 D:/data/a.json'});
    assert.deepEqual(parsePaletteLabel(null), {group: '', text: ''});
});

test('fuzzyScore：整串命中 > 任意位置命中 > 子序列命中，不命中为 -1', () => {
    assert.equal(fuzzyScore('Markdown', 'markdown'), 100);
    assert.ok(fuzzyScore('文件： Markdown', 'markdown') > 0);
    assert.ok(fuzzyScore('Markdown', 'mark') > fuzzyScore('Markdown', 'md'));
    assert.equal(fuzzyScore('Markdown', 'zzz'), -1);
    assert.equal(fuzzyScore('Markdown', ''), 1);
});

test('groupActions：按前缀分组、组内保序、去前缀文本、过滤无 action 项', () => {
    const noop = () => {};
    const groups = groupActions([
        {label: '文件： Markdown', shortcut: '.md', action: noop},
        {label: '文件： Python', shortcut: '.py', action: noop},
        {label: '编辑： 撤销', shortcut: 'Ctrl+Z', action: noop},
        {label: '无前缀命令', action: noop},
        {label: '分隔', sep: true},
        {label: '禁用', disabled: true, action: noop},
    ]);
    assert.deepEqual(groups.map((g) => g.group), ['文件', '编辑', '']);
    assert.deepEqual(groups[0].items.map((i) => i.text), ['Markdown', 'Python']);
    assert.equal(groups[0].items[0].action.shortcut, '.md');
    assert.deepEqual(groups[1].items.map((i) => i.text), ['撤销']);
    assert.deepEqual(groups[2].items.map((i) => i.text), ['无前缀命令']);
});

test('groupActions：查询按完整 label 评分（搜组名能命中整组）', () => {
    const noop = () => {};
    const actions = [
        {label: '文件： Markdown', action: noop},
        {label: '文件： Python', action: noop},
        {label: '编辑： 撤销', action: noop},
    ];
    const byGroup = groupActions(actions, '文件');
    assert.deepEqual(byGroup.map((g) => g.group), ['文件']);
    assert.equal(byGroup[0].items.length, 2);
    const byItem = groupActions(actions, '撤销');
    assert.deepEqual(byItem.map((g) => g.group), ['编辑']);
    assert.deepEqual(groupActions(actions, 'zzz'), []);
});

test('groupActions：组图标取注册表键，未知组用兜底图标', () => {
    const noop = () => {};
    const groups = groupActions([
        {label: '文件： Markdown', action: noop},
        {label: '自定义组： 某项', action: noop},
    ]);
    assert.equal(groups[0].icon, 'file');
    assert.equal(groups[1].icon, DEFAULT_GROUP_ICON);
    assert.equal(groupIcon('工具'), 'gear');
    assert.equal(groupIcon(''), DEFAULT_GROUP_ICON);
});
