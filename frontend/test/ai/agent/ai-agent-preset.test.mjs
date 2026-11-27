// ai-agent-preset 单测（S6）：声明式 preset 归一化 + 每 agent 的作用域注册层 agent.ctx。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeAgentPreset,
    presetPromptSections,
    createAgentScope,
    PRESET_TOOLS_MAX,
} from '../../../src/ai/agent/ai-agent-preset.js';

test('normalizeAgentPreset：声明决定 persona / 工具集 / 提示片段 / realm / 变量', () => {
    const p = normalizeAgentPreset({
        id: 'novelist',
        name: '小说家',
        persona: '你是一位小说家',
        promptSections: [
            {id: 'style', text: '文风：克制'},
            {id: '', text: '丢弃'},
        ],
        tools: ['read_file', 'write_file', 'read_file', ''],
        realm: 'novel.writer',
        variables: {chapter: '第三章', empty: ''},
    });
    assert.equal(p.id, 'novelist');
    assert.equal(p.persona, '你是一位小说家');
    assert.deepEqual(p.tools, ['read_file', 'write_file'], '工具去重、空值剔除');
    assert.deepEqual(p.promptSections, [{id: 'style', text: '文风：克制'}]);
    assert.equal(p.realm, 'novel.writer');
    assert.deepEqual(p.variables, {chapter: '第三章', empty: ''});
});

test('normalizeAgentPreset：脏数据不抛错，字段全有值且不引用入参', () => {
    const p = normalizeAgentPreset(null);
    assert.equal(p.id, '');
    assert.equal(p.name, '未命名预设');
    assert.deepEqual(p.tools, []);
    assert.deepEqual(p.promptSections, []);
    assert.deepEqual(p.variables, {});
    const tools = ['read_file'];
    const p2 = normalizeAgentPreset({tools});
    tools.push('mutated');
    assert.deepEqual(p2.tools, ['read_file'], '工具数组必须是新副本');
});

test('normalizeAgentPreset：realm 非法名归空，工具数截断', () => {
    assert.equal(normalizeAgentPreset({realm: 'bad name!'}).realm, '');
    const many = Array.from({length: PRESET_TOOLS_MAX + 10}, (_, i) => 't' + i);
    assert.equal(normalizeAgentPreset({tools: many}).tools.length, PRESET_TOOLS_MAX);
});

test('presetPromptSections：按声明顺序拼提示片段，persona 不混入', () => {
    const p = normalizeAgentPreset({
        persona: '人设',
        promptSections: [{id: 'a', text: 'A'}, {id: 'b', text: 'B'}, {id: 'c', text: ''}],
    });
    assert.equal(presetPromptSections(p), 'A\n\nB');
    assert.ok(!presetPromptSections(p).includes('人设'));
});

test('createAgentScope：每 agent 独立，工具/提示/变量只对该层可见', () => {
    const a = createAgentScope({owner: 'agent-a', realm: 'novel'});
    const b = createAgentScope({owner: 'agent-b', realm: 'novel'});
    a.setTool('write_file', true);
    a.setPrompt('style', '克制');
    a.setVar('chapter', '三');
    assert.equal(a.hasTool('write_file'), true);
    assert.equal(b.hasTool('write_file'), false, '不串到别的 agent');
    assert.equal(b.getPrompt('style'), undefined);
    assert.equal(b.getVar('chapter'), undefined);
    assert.equal(a.owner, 'agent-a');
    assert.equal(a.realm, 'novel');
});

test('createAgentScope：applyPreset 把声明铺进作用域，set 返回幂等撤销', () => {
    const scope = createAgentScope({owner: 'a'});
    scope.applyPreset({
        tools: ['read_file', 'edit_file'],
        promptSections: [{id: 'style', text: '简洁'}],
        variables: {lang: 'zh'},
    });
    assert.deepEqual(scope.toolNames(), ['read_file', 'edit_file']);
    assert.equal(scope.getPrompt('style'), '简洁');
    assert.equal(scope.getVar('lang'), 'zh');
    const off = scope.setTool('read_file', true);
    off(); off();
    assert.equal(scope.hasTool('read_file'), false, '撤销幂等');
});

test('createAgentScope：dispose 清空全部注册，之后不再接受写入', () => {
    const scope = createAgentScope({owner: 'a'});
    scope.setTool('x', 1);
    scope.setPrompt('p', 'v');
    scope.setVar('v', 1);
    scope.dispose();
    assert.equal(scope.disposed, true);
    assert.deepEqual(scope.toolNames(), []);
    assert.deepEqual(scope.promptIds(), []);
    assert.deepEqual(scope.varKeys(), []);
    assert.throws(() => scope.setTool('y', 1), /已释放/);
});

test('createAgentScope：空 key 被拒绝', () => {
    const scope = createAgentScope();
    assert.throws(() => scope.setTool('', 1), /key 不能为空/);
    assert.throws(() => scope.setVar('  ', 1), /key 不能为空/);
});
