// ai-mcp-settings.test.mjs：MCP 设置页的纯辅助函数——env 合并（不回显语义）、hint 角标、
// 表单校验、状态灯映射。DOM 逻辑不在此测（与 index.html 联动，靠人工验收）。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    mcpMergeEnvRows, mcpToolFlags, mcpValidateServerForm, mcpStatusMeta, mcpApplyServerEnabled,
    createAIMcpSettings,
} from '../../../src/ai/tools/ai-mcp-settings.js';

test('mcpMergeEnvRows：留空 = 保持原值（密码框不回显语义）', () => {
    const existing = {GITHUB_TOKEN: 'secret1', HOME: '/home/x'};
    // 留空 + key 已存在 → 保持原值；显式新值覆盖；新键落盘
    const merged = mcpMergeEnvRows(existing, [
        {key: 'GITHUB_TOKEN', value: ''},          // 不回显的旧值：留空保持
        {key: 'HOME', value: '/new/home'},         // 显式覆盖
        {key: 'NEW_VAR', value: 'abc'},            // 新键
    ]);
    assert.equal(merged.GITHUB_TOKEN, 'secret1');
    assert.equal(merged.HOME, '/new/home');
    assert.equal(merged.NEW_VAR, 'abc');
    // 留空 + key 不存在 → 空值（用户自己加的空值变量）
    assert.equal(mcpMergeEnvRows({}, [{key: 'EMPTY', value: ''}]).EMPTY, '');
    // 空键行跳过；重复键取第一个
    assert.deepEqual(mcpMergeEnvRows({}, [{key: '', value: 'x'}, {key: 'A', value: '1'}, {key: 'A', value: '2'}]).A, '1');
    // 现有键不在行里 = 删除
    assert.equal(mcpMergeEnvRows({OLD: 'x'}, [{key: 'A', value: '1'}]).OLD, undefined);
});

test('mcpToolFlags：annotations 是 hint，destructive 缺省悲观为 true', () => {
    assert.deepEqual(mcpToolFlags(undefined), {readOnly: false, destructive: true, openWorld: false});
    assert.deepEqual(mcpToolFlags(null), {readOnly: false, destructive: true, openWorld: false});
    assert.deepEqual(mcpToolFlags({readOnlyHint: true}), {readOnly: true, destructive: true, openWorld: false});
    assert.deepEqual(mcpToolFlags({readOnlyHint: true, destructiveHint: false, openWorldHint: true}),
        {readOnly: true, destructive: false, openWorld: true});
    // 畸形 annotations 与「显式 false 的 readOnly」都不能宽松
    assert.deepEqual(mcpToolFlags('x'), {readOnly: false, destructive: true, openWorld: false});
    assert.equal(mcpToolFlags({readOnlyHint: false}).readOnly, false);
});

test('mcpValidateServerForm：与 Go 写入期校验同规则', () => {
    const base = {name: 'ok', command: 'npx', args: [], startupTimeoutMs: 30000, callTimeoutMs: 60000, closeTimeoutMs: 5000};
    assert.equal(mcpValidateServerForm(base), '');
    // 名称：非法字符 / 超长 / 空
    assert.match(mcpValidateServerForm({...base, name: 'bad name'}), /服务器名/);
    assert.match(mcpValidateServerForm({...base, name: 'a'.repeat(33)}), /服务器名/);
    assert.match(mcpValidateServerForm({...base, name: ''}), /服务器名/);
    // 缺命令
    assert.match(mcpValidateServerForm({...base, command: '  '}), /缺少启动命令/);
    // 参数超限
    assert.match(mcpValidateServerForm({...base, args: new Array(129).fill('x')}), /参数个数/);
    // 超时越界
    assert.match(mcpValidateServerForm({...base, startupTimeoutMs: 601000}), /超时/);
    assert.match(mcpValidateServerForm({...base, callTimeoutMs: -1000}), /超时/);
    assert.equal(mcpValidateServerForm({...base, closeTimeoutMs: 600000}), '');
});

test('mcpApplyServerEnabled：快捷启停后同步内存 config（不可变），保证勾选即时生效', () => {
    const cfg = {version: 1, enabled: true, mcpServers: {
        a: {command: 'npx', enabled: false, enabledTools: ['x']},
        b: {command: 'uvx', enabled: true},
    }};
    const next = mcpApplyServerEnabled(cfg, 'a', true);
    // 目标条目 enabled 翻转
    assert.equal(next.mcpServers.a.enabled, true);
    // 其余字段与其余条目不变
    assert.equal(next.mcpServers.a.command, 'npx');
    assert.deepEqual(next.mcpServers.a.enabledTools, ['x']);
    assert.deepEqual(next.mcpServers.b, cfg.mcpServers.b);
    // 不可变：原对象不被改动（Go 事件用闭包里的 config 重绘，必须换新对象）
    assert.equal(cfg.mcpServers.a.enabled, false);
    assert.notEqual(next, cfg);
    assert.notEqual(next.mcpServers, cfg.mcpServers);
    // 关闭 / 不存在条目 / 空 config 都安全
    assert.equal(mcpApplyServerEnabled(next, 'a', false).mcpServers.a.enabled, false);
    assert.equal(mcpApplyServerEnabled(cfg, 'nope', true), cfg);
    assert.equal(mcpApplyServerEnabled(null, 'a', true), null);
    const empty = {};
    assert.equal(mcpApplyServerEnabled(empty, 'a', true), empty); // 无 mcpServers 也原样返回
});

test('mcpStatusMeta：六态映射状态灯与文案', () => {
    assert.deepEqual(mcpStatusMeta('connected'), {cls: 'ok', text: '已连接'});
    assert.deepEqual(mcpStatusMeta('connecting'), {cls: 'warn', text: '连接中'});
    assert.deepEqual(mcpStatusMeta('reconnecting'), {cls: 'warn', text: '重连中'});
    assert.deepEqual(mcpStatusMeta('failed', 'gave-up'), {cls: 'err', text: '已放弃'});
    assert.deepEqual(mcpStatusMeta('failed', 'unclosed-generation'), {cls: 'err', text: '关闭未确认（需重启应用）'});
    assert.deepEqual(mcpStatusMeta('closed'), {cls: 'idle', text: '未连接'});
    assert.deepEqual(mcpStatusMeta('waiting-credentials'), {cls: 'idle', text: '未连接'});
});

// ---- 接线护栏：添加 / 编辑服务器必须走独立弹层（不许退回设置页内联展开） ----

// 轻量 DOM 桩：只覆盖本模块用到的 createElement / getElementById 与节点属性读写。
function fakeEl(tag) {
    return {
        tag,
        className: '',
        textContent: '',
        value: '',
        placeholder: '',
        type: '',
        checked: false,
        id: '',
        innerHTML: '',
        children: [],
        dataset: {},
        style: {},
        attrs: {},
        listeners: {},
        parentElement: null,
        setAttribute(key, value) { this.attrs[key] = String(value); },
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        append(...nodes) { this.children.push(...nodes); },
        appendChild(node) { this.children.push(node); return node; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        closest() { return null; },
        fire(type, event) { for (const fn of this.listeners[type] || []) fn(event || {}); },
    };
}

const domNodes = new Map();
globalThis.document = {
    createElement: (tag) => fakeEl(tag),
    getElementById: (id) => {
        if (!domNodes.has(id)) domNodes.set(id, fakeEl('div'));
        return domNodes.get(id);
    },
};

function collectByClass(node, cls, out = []) {
    if (!node) return out;
    if (String(node.className || '').split(/\s+/).includes(cls)) out.push(node);
    for (const child of node.children || []) collectByClass(child, cls, out);
    return out;
}

function collectControls(node, out = []) {
    if (!node) return out;
    if (node.tag === 'input' || node.tag === 'textarea') out.push(node);
    for (const child of node.children || []) collectControls(child, out);
    return out;
}

function setupMcpSettings(overrides = {}) {
    const calls = [];
    const writes = [];
    const flashes = [];
    const mod = createAIMcpSettings(Object.assign({
        backend: {
            MCPGetConfig: async () => ({version: 1, enabled: true, mcpServers: {
                everything: {command: 'npx', args: ['-y', 'everything'], enabledTools: ['search']},
            }}),
            MCPWriteConfig: async (next) => { writes.push(next); },
        },
        getMcpState: () => ({enabled: true, servers: []}),
        flash: (msg) => { flashes.push(msg); },
        confirmAction: (msg, action) => action(),
        onChanged: () => {},
        openAIDialog: (title, body, footer, options) => calls.push({title, body, footer, options}),
        closeAIDialog: () => {},
        dialogButton: (label, className, onClick) => {
            const btn = fakeEl('button');
            btn.textContent = label;
            btn.className = className || 'dlg-btn';
            btn.addEventListener('click', onClick);
            return btn;
        },
    }, overrides));
    return {mod, calls, writes, flashes};
}

test('添加服务器走独立弹层（openAIDialog），不是设置页内联展开', async () => {
    const {mod, calls} = setupMcpSettings();
    await mod.render();
    await new Promise((r) => setTimeout(r, 0));

    document.getElementById('ai-opt-mcp-add').fire('click');

    assert.equal(calls.length, 1, '点「添加服务器」应弹出独立弹层');
    assert.match(calls[0].title, /添加 MCP 服务器/);
    assert.equal(calls[0].options.top, true, '弹层要置顶（不被设置页裁剪）');
    assert.equal(calls[0].options.wide, true);
    // 表单字段齐全
    const titles = collectByClass(calls[0].body[0], 'set-title').map((n) => n.textContent);
    for (const want of ['名称', '启动命令', '参数（每行一个）', '工作目录', '环境变量',
        '启动超时（秒）', '调用超时（秒）', '关闭超时（秒）']) {
        assert.ok(titles.includes(want), '弹层缺少字段：' + want);
    }
    // 底部按钮：取消 / 保存
    assert.deepEqual(calls[0].footer.map((b) => b.textContent), ['取消', '保存']);
    // 表单控件一律走 form-controls 工厂：createInput / createTextarea 默认带 .dlg-input；
    // createNumber（fc-number 步进框）的封装观感在 .fc-number 外框上，内层 input 挂工厂自带 .fc-number-input
    const controls = collectControls(calls[0].body[0]);
    assert.ok(controls.length >= 7);
    for (const ctl of controls) {
        const cls = String(ctl.className || '');
        assert.ok(cls.includes('dlg-input') || cls.includes('fc-number-input'),
            '控件未走工厂封装：' + ctl.className);
    }
});

test('列表「编辑」也走同一个弹层，并回填已有服务器的配置', async () => {
    const {mod, calls} = setupMcpSettings();
    await mod.render();
    await new Promise((r) => setTimeout(r, 0));

    const editBtn = fakeEl('button');
    editBtn.dataset.mcpEdit = 'everything';
    editBtn.closest = (sel) => (sel === 'button[data-mcp-edit]' ? editBtn : null);
    document.getElementById('ai-opt-mcp-list').fire('click', {target: editBtn});

    assert.equal(calls.length, 1, '点「编辑」应弹出独立弹层');
    assert.match(calls[0].title, /编辑 MCP 服务器 · everything/);
    const controls = collectControls(calls[0].body[0]);
    assert.equal(controls[0].value, 'everything'); // 名称回填
    assert.equal(controls[1].value, 'npx');         // 启动命令回填
    assert.equal(controls[2].value, '-y\neverything'); // 参数逐行回填
});

test('弹层保存走 MCPWriteConfig 并带上表单值', async () => {
    const {mod, calls, writes} = setupMcpSettings();
    await mod.render();
    await new Promise((r) => setTimeout(r, 0));

    document.getElementById('ai-opt-mcp-add').fire('click');
    const controls = collectControls(calls[0].body[0]);
    controls[0].value = 'new-server';
    controls[1].value = 'uvx';
    controls[2].value = 'mcp-server';
    controls[3].value = 'C:/tmp';

    const saveBtn = calls[0].footer.find((b) => b.textContent === '保存');
    saveBtn.fire('click');
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(writes.length, 1, '保存应写盘');
    const saved = writes[0].mcpServers['new-server'];
    assert.ok(saved, '写盘内容缺少新服务器');
    assert.equal(saved.command, 'uvx');
    assert.deepEqual(saved.args, ['mcp-server']);
    assert.equal(saved.cwd, 'C:/tmp');
    assert.equal(saved.startupTimeoutMs, 30000);
    assert.equal(saved.callTimeoutMs, 60000);
    assert.equal(saved.closeTimeoutMs, 5000);
});
