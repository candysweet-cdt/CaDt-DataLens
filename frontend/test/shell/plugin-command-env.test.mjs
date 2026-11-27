// plugin-command-env.test.mjs —— 插件命令 env 构造（shell/plugin-command-env.js）。
//
// 这层是从 main.js 迁出的（组合根「只减不增」），所以测试顺带钉住迁出后的运行时契约：
// deps 一律传函数（传值会在编辑器整体替换后读到旧对象）、异常一律降级为 false 而不是冒泡。

import test from 'node:test';
import assert from 'node:assert/strict';
import {createPluginCommandEnv} from '../../src/shell/plugin-command-env.js';

function makeDeps(overrides = {}) {
    const state = {
        mode: 'code',
        editor: {aceEditor: {isFocused: () => true, getSelectedText: () => '选中文本'}},
        textArea: {selectionStart: 0, selectionEnd: 0},
        file: {name: 'a.json', format: {id: 'json'}},
        settings: {readOnly: false},
        readonly: false,
    };
    for (const [key, value] of Object.entries(overrides)) state[key] = value;
    return {
        state,
        deps: {
            currentMode: () => state.mode,
            editor: () => state.editor,
            textArea: () => state.textArea,
            file: () => state.file,
            settings: () => state.settings,
            workspace: () => 'D:/ws',
            isDocReadOnly: () => state.readonly,
        },
    };
}

test('基座 + 编辑器域字段齐备，origin=command、sessionId 恒空', () => {
    const {deps} = makeDeps();
    const env = createPluginCommandEnv(deps)({pluginId: 'demo', pluginName: '演示插件'});
    assert.deepEqual(env.plugin, {id: 'demo', name: '演示插件'});
    assert.equal(env.workspace, 'D:/ws');
    assert.equal(env.sessionId, '', '命令不属于任何 AI 会话');
    assert.equal(env.origin, 'command');
    assert.equal(env.hasFile, true);
    assert.equal(env.formatId, 'json');
    assert.equal(env.hasSelection, true);
    assert.equal(env.editorFocused, true);
    assert.equal(env.readonly, false);
    assert.equal('flash' in env, false, '命令没有 flash：提示走状态栏，不从这里发');
});

test('不传 cmd 时只有基座（快捷键匹配阶段还不知道会命中谁）', () => {
    const {deps} = makeDeps();
    const env = createPluginCommandEnv(deps)();
    assert.deepEqual(env.plugin, {id: '', name: ''});
    assert.equal(env.origin, 'command');
});

test('非 code 模式的选区来自 textArea；没有文档时 hasFile=false、formatId 为空串', () => {
    const {deps, state} = makeDeps();
    state.mode = 'text';
    state.file = null;
    state.textArea = {selectionStart: 3, selectionEnd: 9};
    const env = createPluginCommandEnv(deps)({pluginId: 'demo'});
    assert.equal(env.hasSelection, true);
    assert.equal(env.editorFocused, false, 'code 之外没有 Ace 焦点概念');
    assert.equal(env.hasFile, false);
    assert.equal(env.formatId, '');
});

test('deps 抛错一律降级为 false，不让坏编辑器状态阻断菜单渲染', () => {
    const deps = {
        currentMode: () => {
            throw new Error('boom');
        },
        editor: () => {
            throw new Error('boom');
        },
        textArea: () => null,
        file: () => {
            throw new Error('boom');
        },
        settings: () => ({readOnly: true}),
        workspace: () => 'D:/ws',
        isDocReadOnly: () => {
            throw new Error('boom');
        },
    };
    const env = createPluginCommandEnv(deps)({pluginId: 'demo'});
    assert.equal(env.hasSelection, false);
    assert.equal(env.editorFocused, false);
    assert.equal(env.hasFile, false);
    assert.equal(env.readonly, false);
});

test('只读判定取 isDocReadOnly 的结果（与编辑器保存链同一实现）', () => {
    const {deps, state} = makeDeps();
    state.readonly = true;
    assert.equal(createPluginCommandEnv(deps)({pluginId: 'demo'}).readonly, true);
});

test('deps 是活引用：编辑器整体替换后下次调用读新对象', () => {
    const {deps, state} = makeDeps();
    const env = createPluginCommandEnv(deps);
    assert.equal(env({pluginId: 'demo'}).hasSelection, true);
    state.editor = {aceEditor: {isFocused: () => false, getSelectedText: () => ''}};
    const next = env({pluginId: 'demo'});
    assert.equal(next.hasSelection, false, '不能把 editor 拍成快照');
    assert.equal(next.editorFocused, false);
});

test('workspace getter 抛错降级为空串（多工作区切换的瞬时抖动不能炸菜单）', () => {
    const {deps} = makeDeps();
    const broken = {
        ...deps,
        workspace: () => {
            throw new Error('切根竞态');
        },
    };
    assert.equal(createPluginCommandEnv(broken)({pluginId: 'demo'}).workspace, '');
});
