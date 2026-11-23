// ai-group-tools.test.mjs：群成员只读工具（G5）——定义过滤、API 消息形状、参数摘要、
// 提示词片段；路径边界守卫 resolveWithinRoot（ai-file-tools）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MEMBER_TOOL_NAMES,
    MEMBER_TOOL_ROUNDS_MAX,
    assistantToolCallsApiMessage,
    memberToolDefs,
    memberToolsNote,
    toolArgsSummary,
    toolResultApiMessage,
} from '../../../src/ai/group/ai-group-tools.js';
import {resolveWithinRoot} from '../../../src/ai/tools/ai-file-tools.js';

test('memberToolDefs：过滤出四个只读工具且形状可下发（name/schema）', () => {
    const defs = memberToolDefs();
    assert.deepEqual(defs.map((d) => d.name), MEMBER_TOOL_NAMES);
    assert.deepEqual(MEMBER_TOOL_NAMES, ['read_file', 'list_dir', 'search_text', 'glob']);
    for (const def of defs) {
        assert.equal(def.name, def.name);
        assert.ok(def.description, def.name + ' 缺描述');
        assert.ok(def.parameters && def.parameters.properties, def.name + ' 缺 schema');
        // 不允许写工具混进来
        assert.ok(!/write|edit|command/.test(def.name));
    }
});

test('assistantToolCallsApiMessage / toolResultApiMessage：与面板 buildApiMessages 同契约', () => {
    const calls = [{id: 'call_1', name: 'read_file', arguments: '{"path":"a.md"}'}];
    const assistant = assistantToolCallsApiMessage('我先读一下', calls);
    assert.equal(assistant.role, 'assistant');
    assert.equal(assistant.content, '我先读一下');
    assert.equal(assistant.toolCalls[0].id, 'call_1');
    assert.equal(assistant.toolCalls[0].name, 'read_file');
    assert.equal(assistant.toolCalls[0].arguments, '{"path":"a.md"}');
    const result = toolResultApiMessage(calls[0], '文件内容…');
    assert.equal(result.role, 'tool');
    assert.equal(result.toolCallId, 'call_1');
    assert.equal(result.name, 'read_file');
    assert.equal(result.content, '文件内容…');
    // 空入参防御
    assert.deepEqual(assistantToolCallsApiMessage('', null).toolCalls, []);
    assert.equal(toolResultApiMessage(null, 'x').toolCallId, '');
});

test('toolArgsSummary：各工具的摘要形态', () => {
    assert.equal(toolArgsSummary('read_file', '{"path":"第0001章-引言.md"}'), '第0001章-引言.md');
    assert.equal(toolArgsSummary('read_file', '{"path":"a.md","startLine":12}'), 'a.md（自 12）');
    assert.equal(toolArgsSummary('list_dir', '{}'), '.');
    assert.equal(toolArgsSummary('search_text', '{"query":"弃书","path":"正文"}'), '"弃书" @ 正文');
    assert.equal(toolArgsSummary('glob', '{"pattern":"*.md"}'), '*.md');
    assert.equal(toolArgsSummary('read_file', '不是json'), '(无参数)');
});

test('memberToolsNote：列出全部工具名 + 轮次上限', () => {
    const note = memberToolsNote();
    for (const name of MEMBER_TOOL_NAMES) assert.ok(note.includes(name), note);
    assert.ok(note.includes(String(MEMBER_TOOL_ROUNDS_MAX)));
    assert.ok(note.includes('<member_tools>'));
});

test('resolveWithinRoot：相对路径拼接、根内绝对路径放行、越界拒绝', () => {
    const ws = 'D:/novel';
    assert.deepEqual(resolveWithinRoot(ws, '正文/第0001章.md'), {ok: true, path: 'D:/novel/正文/第0001章.md'});
    assert.deepEqual(resolveWithinRoot(ws, '.'), {ok: true, path: ws});
    assert.deepEqual(resolveWithinRoot(ws, ''), {ok: true, path: ws});
    // 根内绝对路径放行（模型可能回读工具结果里见过的路径）
    assert.deepEqual(resolveWithinRoot(ws, 'D:/novel/正文/a.md'), {ok: true, path: 'D:/novel/正文/a.md'});
    // .. 消解后仍在根内
    assert.deepEqual(resolveWithinRoot(ws, '正文/../a.md'), {ok: true, path: 'D:/novel/a.md'});
    // 越界：.. 逃逸 / 根外绝对路径 / 根锚定伪相对
    assert.equal(resolveWithinRoot(ws, '../other/x').ok, false);
    assert.equal(resolveWithinRoot(ws, '../../etc/passwd').ok, false);
    assert.equal(resolveWithinRoot(ws, 'C:/Windows/x').ok, false);
    assert.equal(resolveWithinRoot(ws, '/etc/passwd').ok, false);
    // 大小写漂移（Windows）不误拒
    assert.deepEqual(resolveWithinRoot(ws, 'D:/NOVEL/正文/a.md'), {ok: true, path: 'D:/NOVEL/正文/a.md'});
    // 空根拒绝
    assert.equal(resolveWithinRoot('', 'a.md').ok, false);
    // 反斜杠风格归一
    assert.deepEqual(resolveWithinRoot('D:\\novel', '正文\\a.md'), {ok: true, path: 'D:/novel/正文/a.md'});
    // 引号包裹（模型常带）
    assert.deepEqual(resolveWithinRoot(ws, '"正文/a.md"'), {ok: true, path: 'D:/novel/正文/a.md'});
});

test('resolveWithinRoot：带 // 的假协议根（mock://）不误判越界', () => {
    const ws = 'mock://samples';
    assert.deepEqual(resolveWithinRoot(ws, 'sample.json'), {ok: true, path: 'mock://samples/sample.json'});
    assert.deepEqual(resolveWithinRoot(ws, 'config/inner.json'), {ok: true, path: 'mock://samples/config/inner.json'});
    assert.deepEqual(resolveWithinRoot(ws, '.'), {ok: true, path: ws});
    // 越界照旧拒绝
    assert.equal(resolveWithinRoot(ws, '../other.json').ok, false);
    assert.equal(resolveWithinRoot(ws, 'D:/elsewhere/x').ok, false);
});
