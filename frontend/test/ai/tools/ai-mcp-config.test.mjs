// ai-mcp-config 测试：AI 代配 MCP 的视图脱敏、部分更新、env/工具授权红线与删除保护。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
    mcpConfigView,
    mcpServerCommandPreview,
    mergeMcpServerConfig,
    planMcpServerDelete,
} from '../../../src/ai/tools/ai-mcp-config.js';

const sampleConfig = () => ({
    version: 1,
    enabled: true,
    mcpServers: {
        playwright: {
            command: 'npx',
            args: ['-y', '@playwright/mcp@latest', '--token=secret-token'],
            enabled: true,
            enabledTools: ['browser_navigate'],
        },
        github: {
            command: 'github-mcp',
            env: {GITHUB_TOKEN: 'ghp_secret'},
            enabledTools: ['create_issue'],
        },
    },
});

test('mcpConfigView：只下发命令/参数个数/env 键名，不下发参数内容与 env 值', () => {
    const view = mcpConfigView(sampleConfig(), {
        enabled: true,
        servers: [{name: 'playwright', state: 'connected', toolCount: 3}],
    }, {search: 'mcp__playwright__search'});
    const playwright = view.servers.find((server) => server.name === 'playwright');
    assert.equal(playwright.command, 'npx');
    assert.equal(playwright.argCount, 3, '参数原文不可下发，只报个数');
    assert.deepEqual(playwright.envKeys, []);
    assert.deepEqual(playwright.enabledTools, ['browser_navigate']);
    assert.equal(playwright.state, 'connected');
    assert.equal(playwright.toolCount, 3);
    const github = view.servers.find((server) => server.name === 'github');
    assert.deepEqual(github.envKeys, ['GITHUB_TOKEN'], '只给 env 键名');
    assert.equal(JSON.stringify(view).includes('ghp_secret'), false, 'env 值不得出现在视图里');
    assert.equal(JSON.stringify(view).includes('secret-token'), false, 'args 原文不得出现在视图里');
    assert.equal(view.bindings.search, 'mcp__playwright__search');
});

test('mergeMcpServerConfig：新建条目默认启用、envKeys 只登记空值、工具授权为空', () => {
    const plan = mergeMcpServerConfig({version: 1, mcpServers: {}}, {
        name: 'fetch',
        command: 'uvx',
        args: ['mcp-server-fetch'],
        envKeys: ['PROXY_URL'],
        enabled: true,
    });
    assert.equal(plan.created, true);
    const server = plan.config.mcpServers.fetch;
    assert.equal(server.command, 'uvx');
    assert.deepEqual(server.args, ['mcp-server-fetch']);
    assert.deepEqual(server.env, {PROXY_URL: ''}, 'AI 只能登记键名，值为空');
    assert.deepEqual(server.enabledTools, [], '工具授权默认全不勾');
    assert.equal(server.enabled, true);
    assert.equal(plan.server.env.PROXY_URL, '');
});

test('mergeMcpServerConfig：部分更新沿用未传字段，env 与 enabledTools 一律拒绝', () => {
    const config = sampleConfig();
    const plan = mergeMcpServerConfig(config, {name: 'playwright', cwd: 'C:/work'});
    const server = plan.config.mcpServers.playwright;
    assert.equal(plan.created, false);
    assert.equal(server.cwd, 'C:/work');
    assert.deepEqual(server.args, ['-y', '@playwright/mcp@latest', '--token=secret-token'], '未传 args 时保留原参数');
    assert.deepEqual(server.enabledTools, ['browser_navigate'], '工具授权不被 AI 覆盖');
    assert.throws(() => mergeMcpServerConfig(config, {name: 'playwright', env: {X: 'y'}}), /env 值不可由 AI 写入/);
    assert.throws(() => mergeMcpServerConfig(config, {name: 'playwright', enabledTools: []}), /工具授权必须由用户/);
});

test('mergeMcpServerConfig：已配环境变量的服务器拒绝任何修改', () => {
    assert.throws(
        () => mergeMcpServerConfig(sampleConfig(), {name: 'github', enabled: false}),
        /已配置环境变量.*不能修改/,
    );
});

test('mergeMcpServerConfig：名称/命令/超时校验', () => {
    assert.throws(() => mergeMcpServerConfig({mcpServers: {}}, {name: 'bad name', command: 'x'}), /服务器名/);
    assert.throws(() => mergeMcpServerConfig({mcpServers: {}}, {name: 'ok'}), /缺少启动命令/);
    assert.throws(() => mergeMcpServerConfig({mcpServers: {}}, {name: 'ok', command: 'x', callTimeoutMs: 9999999}), /秒/);
    assert.throws(() => mergeMcpServerConfig({mcpServers: {}}, {name: 'ok', command: 'x', envKeys: ['bad-key']}), /环境变量名不合法/);
});

test('planMcpServerDelete：env-free 可删，env-bearing 拒绝，缺失返回 deleted=false', () => {
    const plan = planMcpServerDelete(sampleConfig(), 'playwright');
    assert.equal(plan.deleted, true);
    assert.equal(Object.prototype.hasOwnProperty.call(plan.config.mcpServers, 'playwright'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(plan.config.mcpServers, 'github'), true);
    assert.throws(() => planMcpServerDelete(sampleConfig(), 'github'), /已配置环境变量.*不能删除/);
    assert.equal(planMcpServerDelete(sampleConfig(), 'missing').deleted, false);
});

test('接线护栏：app_control 拦截 MCP 动作，写操作必须走命令确认', () => {
    const panel = readFileSync(new URL('../../../src/ai/ai-panel.js', import.meta.url), 'utf8');
    assert.ok(panel.includes("'get_mcp_servers', 'list_mcp_samples', 'install_mcp_sample', 'set_mcp_server', 'delete_mcp_server'"));
    assert.ok(panel.includes('MCP_CONFIG_ACTIONS.includes(action)'));
    assert.ok(panel.includes('backend.MCPInstallSample(id)'), '安装内置示例必须走后端释放+合并');
    // 安装后必须重读 mcp.json（render），不能用内存旧 config（renderAll）——否则新 server
    // 列表不刷新，要重开页面/退出重进才出现（用户实测）。两处安装入口都要覆盖。
    assert.ok(/MCPInstallSample\(id\);[\s\S]{0,300}mcpSettingsMod\.render\(\)/.test(panel),
        'AI 工具安装示例后必须 render() 重读配置，不能只 renderAll()');
    assert.ok(/refreshMcpConfig:[\s\S]{0,400}mcpSettingsMod\.render\(\)/.test(panel),
        'refreshMcpConfig（外部工具页安装后调用）必须 render() 重读配置');
    assert.ok(panel.includes("tool: 'install_mcp_sample'"));
    assert.ok(panel.includes("tool: 'set_mcp_server'"));
    assert.ok(panel.includes("tool: 'delete_mcp_server'"));
    assert.ok(panel.includes('requestCommandApproval(session, ctx.toolMessage'), 'MCP 配置写操作必须经过审批卡');
    assert.ok(panel.includes('session.planMode === true) throw new Error(\'计划模式不修改 MCP 配置'), '计划模式必须硬拒绝');
});

test('mcpServerCommandPreview：审批卡展示完整命令与参数', () => {
    assert.equal(
        mcpServerCommandPreview(sampleConfig().mcpServers.playwright),
        'npx -y @playwright/mcp@latest --token=secret-token',
    );
});
