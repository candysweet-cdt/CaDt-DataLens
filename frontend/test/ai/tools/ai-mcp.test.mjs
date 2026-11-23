// ai-mcp.test.mjs：MCP 前端逻辑层——schema 兜底、结果转字符串、isError 不当异常、整代快照原子性。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAIMcp, mcpNotesBlock} from '../../../src/ai/tools/ai-mcp.js';

function makeMod(backend) {
    return createAIMcp({backend: backend || {}});
}

test('sanitizeSchema：null / 缺 type / 顶层非 object 降级为宽松 object', () => {
    const mod = makeMod();
    // null 与缺 type
    assert.deepEqual(mod.sanitizeSchema(null), {type: 'object', properties: {}, required: []});
    assert.deepEqual(mod.sanitizeSchema({properties: {a: {type: 'string'}}}),
        {type: 'object', properties: {a: {type: 'string'}}, required: []});
    // 顶层非 object：数组 / 字符串 / 数字
    assert.deepEqual(mod.sanitizeSchema([]), {type: 'object', properties: {}, required: []});
    assert.deepEqual(mod.sanitizeSchema('oops'), {type: 'object', properties: {}, required: []});
    assert.deepEqual(mod.sanitizeSchema(42), {type: 'object', properties: {}, required: []});
    // 合法 schema 保留 properties / required（过滤非字符串项）与 additionalProperties
    const good = {type: 'object', properties: {p: {type: 'number'}}, required: ['p', 3], additionalProperties: false};
    assert.deepEqual(mod.sanitizeSchema(good),
        {type: 'object', properties: {p: {type: 'number'}}, required: ['p'], additionalProperties: false});
    // properties 非对象 / 数组时忽略
    assert.deepEqual(mod.sanitizeSchema({type: 'object', properties: 'x'}).properties, {});
    assert.deepEqual(mod.sanitizeSchema({type: 'object', properties: [1]}).properties, {});
});

test('mcpToolToDef：公开名作 name，rawName/server 作元数据', () => {
    const mod = makeMod();
    const def = mod.mcpToolToDef({
        publicName: 'mcp__github__create_issue',
        server: 'github',
        rawName: 'create_issue',
        description: '[MCP:github] 建议题',
        inputSchema: {type: 'object', properties: {title: {type: 'string'}}, required: ['title']},
        openWorld: true,
    });
    assert.equal(def.name, 'mcp__github__create_issue');
    assert.equal(def.description, '[MCP:github] 建议题');
    assert.deepEqual(def.parameters.required, ['title']);
    assert.equal(def.mcpRawName, 'create_issue');
    assert.equal(def.mcpServer, 'github');
    assert.equal(def.mcpOpenWorld, true);
});

test('callTool：结果转字符串；isError 不当异常；后端错误上抛', async () => {
    const calls = [];
    const mod = makeMod({
        MCPCallTool: async (name, args) => {
            calls.push({name, args});
            if (name === 'mcp__s__err') return {text: 'boom: 业务失败', isError: true};
            if (name === 'mcp__s__ok') return {text: 'ok text', isError: false};
            throw new Error('未知 MCP 工具');
        },
    });
    assert.equal(await mod.callTool('mcp__s__ok', {a: 1}), 'ok text');
    // isError 原样返回文本，不抛异常
    assert.equal(await mod.callTool('mcp__s__err', null), 'boom: 业务失败');
    // args 非 JSON 对象时归一为 {}
    assert.equal(await mod.callTool('mcp__s__ok', 'oops'), 'ok text');
    assert.deepEqual(JSON.parse(calls[calls.length - 1].args), {});
    // 后端抛错上抛（模型 API 层表现为工具失败）
    await assert.rejects(() => mod.callTool('mcp__s__missing', {}), /未知 MCP 工具/);
    // args 序列化进入后端调用
    assert.deepEqual(JSON.parse(calls[0].args), {a: 1});
});

test('applySnapshot：整代替换的原子性与 enabled 门控', () => {
    const mod = makeMod();
    assert.deepEqual(mod.mcpToolDefs(), []);

    mod.applySnapshot({
        enabled: true,
        servers: [
            {name: 'a', state: 'connected', toolCount: 1, tools: [{publicName: 'mcp__a__t1', description: 'x'}]},
            {name: 'b', state: 'connected', toolCount: 2, tools: [
                {publicName: 'mcp__b__t2', description: 'y'},
                {publicName: 'mcp__b__t3', description: 'z'},
            ]},
        ],
    });
    const defs = mod.mcpToolDefs();
    assert.equal(defs.length, 3);
    assert.deepEqual(defs.map((d) => d.name), ['mcp__a__t1', 'mcp__b__t2', 'mcp__b__t3']);

    // 整代表换：新一代缺了 t3 就真的没有 t3（绝不残留旧代条目）
    mod.applySnapshot({
        enabled: true,
        servers: [{name: 'a', state: 'connected', toolCount: 1, tools: [{publicName: 'mcp__a__t1', description: 'x'}]}],
    });
    assert.deepEqual(mod.mcpToolDefs().map((d) => d.name), ['mcp__a__t1']);

    // 总开关关闭：全部移除
    mod.applySnapshot({enabled: false, servers: [{name: 'a', state: 'closed', tools: [{publicName: 'mcp__a__t1'}]}]});
    assert.deepEqual(mod.mcpToolDefs(), []);

    // 畸形载荷：保留现状不清空
    mod.applySnapshot({enabled: true, servers: [{name: 'a', state: 'connected', tools: [{publicName: 'mcp__a__t1'}]}]});
    mod.applySnapshot(null);
    mod.applySnapshot('oops');
    assert.deepEqual(mod.mcpToolDefs().map((d) => d.name), ['mcp__a__t1']);
});

test('getState：状态读取口返回副本语义的数据', () => {
    const mod = makeMod();
    mod.applySnapshot({enabled: true, servers: [{name: 'a', state: 'reconnecting', attempt: 2, maxAttempt: 10, nextRetryAt: 123}]});
    const st = mod.getState();
    assert.equal(st.enabled, true);
    assert.equal(st.servers[0].state, 'reconnecting');
    assert.equal(st.servers[0].attempt, 2);
    assert.equal(st.servers[0].maxAttempt, 10);
    assert.equal(st.servers[0].nextRetryAt, 123);
    // servers 数组是新构造的（每次 applySnapshot 重建），外部改它不影响内部
    st.servers.length = 0;
    assert.equal(mod.getState().servers.length, 1);
});

test('toolTokenEstimate：给出正的 token 估算', () => {
    const mod = makeMod();
    const est = mod.toolTokenEstimate({publicName: 'mcp__s__t', description: '工具说明文本', inputSchema: {type: 'object'}});
    assert.ok(est > 0, `估算应大于 0，实际 ${est}`);
});

test('refresh：旧后端（无 MCPSnapshot）静默留空', async () => {
    const mod = makeMod({});
    await mod.refresh(); // 不抛
    assert.deepEqual(mod.mcpToolDefs(), []);
    const mod2 = makeMod({MCPSnapshot: async () => ({enabled: true, servers: []})});
    await mod2.refresh();
    assert.equal(mod2.getState().enabled, true);
});

// ---------- 使用约定（mcp_server_notes） ----------

test('mcpNotesBlock：只列有内容的 server，空则不占上下文', () => {
    assert.equal(mcpNotesBlock([]), '');
    assert.equal(mcpNotesBlock(null), '');
    assert.equal(mcpNotesBlock([{name: 'a'}, {name: 'b', notes: '   '}]), '', '空白约定等于没写');
    const block = mcpNotesBlock([
        {name: 'aoci', notes: '提交前先校验字段长度；\n按来源分批'},
        {name: 'other'},
    ]);
    assert.ok(block.startsWith('<mcp_server_notes>'));
    assert.ok(block.endsWith('</mcp_server_notes>'));
    assert.ok(block.includes('- aoci：提交前先校验字段长度； 按来源分批'), '多行要压成一行，别破坏块结构');
    assert.ok(!block.includes('other'), '没写约定的 server 不出现');
    assert.equal(block.split('\n').length, 4);
});

test('快照带 notes：原文透传到 getState', async () => {
    const mod = makeMod({MCPSnapshot: async () => ({
        enabled: true,
        servers: [{name: 'aoci', state: 'ready', toolCount: 1, tools: [], notes: '先校验再提交'}],
    })});
    await mod.refresh();
    assert.equal(mod.getState().servers[0].notes, '先校验再提交');
    assert.ok(mcpNotesBlock(mod.getState().servers).includes('先校验再提交'));
    // 缺字段时归一成空串（不出现 undefined 进模板）
    const mod2 = makeMod({MCPSnapshot: async () => ({enabled: true, servers: [{name: 'x'}]})});
    await mod2.refresh();
    assert.equal(mod2.getState().servers[0].notes, '');
});
