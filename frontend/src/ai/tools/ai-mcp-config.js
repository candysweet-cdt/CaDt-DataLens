// ai-mcp-config.js：AI 代配 MCP 服务器的纯逻辑（app_control 的 get_mcp_servers /
// set_mcp_server / delete_mcp_server）。安全边界与生图条目同构但更严：
// - 可代填 command / args / cwd / 超时 / 启停；
// - env 键可以由 AI 登记（值留空，由用户填），但 env 值、已配 env 的服务器不可改，
//   已配 env 的服务器也不可由 AI 删除；
// - enabledTools（工具授权）永远不由 AI 设置，用户在设置页勾选。
import {mcpValidateServerForm} from './ai-mcp-settings.js';

const MCP_NAME_RULE = /^[A-Za-z0-9_-]{1,32}$/;
const MCP_ENV_KEY_RULE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MCP_ENV_KEYS_MAX = 32;

function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function cloneConfig(config) {
    return JSON.parse(JSON.stringify(config && typeof config === 'object' ? config : {}));
}

// mcpConfigView：给 AI 的只读视图。参数内容与环境变量值一律不下发；
// 只给命令、参数个数、环境变量键名、已授权工具名与运行态。
export function mcpConfigView(config, snapshot, bindings) {
    const cfg = config && typeof config === 'object' ? config : {};
    const servers = cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
    const live = new Map(((snapshot && snapshot.servers) || []).map((server) => [String(server.name || ''), server]));
    const list = Object.keys(servers).sort().map((name) => {
        const server = servers[name] || {};
        const state = live.get(name);
        return {
            name,
            enabled: server.enabled !== false,
            command: String(server.command || ''),
            argCount: Array.isArray(server.args) ? server.args.length : 0,
            cwd: String(server.cwd || ''),
            envKeys: Object.keys(server.env || {}).sort(),
            enabledTools: Array.isArray(server.enabledTools) ? [...server.enabledTools] : [],
            state: state ? String(state.state || 'closed') : 'closed',
            toolCount: state ? Math.max(0, Number(state.toolCount) || 0) : 0,
        };
    });
    return {
        enabled: cfg.enabled !== false,
        servers: list,
        bindings: Object.assign({}, bindings || {}),
    };
}

function normalizeEnvKeys(raw) {
    if (!Array.isArray(raw)) throw new Error('envKeys 必须是字符串数组（只登记键名，值由用户填写）');
    const out = [];
    const seen = new Set();
    for (const item of raw) {
        const key = String(item || '').trim();
        if (!MCP_ENV_KEY_RULE.test(key)) {
            throw new Error('环境变量名不合法：' + (key || '（空）') + '（字母/数字/下划线，字母或下划线开头）');
        }
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(key);
    }
    if (out.length > MCP_ENV_KEYS_MAX) throw new Error('环境变量最多登记 ' + MCP_ENV_KEYS_MAX + ' 个');
    return out;
}

function normalizeTimeout(value) {
    // 越界交给 mcpValidateServerForm 拒绝（与设置页同一套错误文案），这里只收敛为整数
    return Math.round(Number(value) || 0);
}

// mergeMcpServerConfig：新建/部分更新。incoming 只接受
// {name, command?, args?, cwd?, enabled?, startupTimeoutMs?, callTimeoutMs?, closeTimeoutMs?, envKeys?}。
// 返回 {config, name, created, server}；server 只在审批卡里用（含 args 原文）。
export function mergeMcpServerConfig(config, incoming) {
    const input = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {};
    if (has(input, 'env')) {
        throw new Error('env 值不可由 AI 写入；只允许用 envKeys 登记键名，值由用户在设置里填写');
    }
    if (has(input, 'enabledTools')) {
        throw new Error('enabledTools 不可由 AI 设置；工具授权必须由用户在设置页勾选');
    }
    const name = String(input.name || '').trim();
    if (!MCP_NAME_RULE.test(name)) {
        throw new Error('服务器名只能用字母数字下划线连字符，最长 32');
    }
    const next = cloneConfig(config);
    next.version = 1;
    next.mcpServers = next.mcpServers && typeof next.mcpServers === 'object' ? next.mcpServers : {};
    const existing = next.mcpServers[name];
    if (existing) {
        const envKeys = Object.keys(existing.env || {});
        if (envKeys.length) {
            throw new Error('服务器「' + name + '」已配置环境变量（值可能含密钥），AI 不能修改；请让用户在设置里编辑');
        }
    }
    let args = existing && Array.isArray(existing.args) ? [...existing.args] : [];
    if (has(input, 'args')) {
        if (!Array.isArray(input.args)) throw new Error('args 必须是字符串数组（每项一个参数）');
        args = input.args.map((item) => {
            if (typeof item !== 'string') throw new Error('args 每项都必须是字符串');
            return item;
        });
    }
    let env = existing && existing.env ? Object.assign({}, existing.env) : {};
    if (has(input, 'envKeys')) {
        env = {};
        for (const key of normalizeEnvKeys(input.envKeys)) env[key] = '';
    }
    const merged = {
        command: has(input, 'command') ? String(input.command || '').trim() : String((existing && existing.command) || ''),
        args,
        env,
        cwd: has(input, 'cwd') ? String(input.cwd || '').trim() : String((existing && existing.cwd) || ''),
        enabled: has(input, 'enabled') ? input.enabled !== false : (existing ? existing.enabled !== false : true),
        startupTimeoutMs: has(input, 'startupTimeoutMs')
            ? normalizeTimeout(input.startupTimeoutMs) : Number((existing && existing.startupTimeoutMs) || 0),
        callTimeoutMs: has(input, 'callTimeoutMs')
            ? normalizeTimeout(input.callTimeoutMs) : Number((existing && existing.callTimeoutMs) || 0),
        closeTimeoutMs: has(input, 'closeTimeoutMs')
            ? normalizeTimeout(input.closeTimeoutMs) : Number((existing && existing.closeTimeoutMs) || 0),
        enabledTools: existing && Array.isArray(existing.enabledTools) ? [...existing.enabledTools] : [],
    };
    const error = mcpValidateServerForm(Object.assign({name}, merged));
    if (error) throw new Error(error);
    next.mcpServers[name] = merged;
    return {config: next, name, created: !existing, server: merged};
}

// planMcpServerDelete：只生成删除后的配置；已配环境变量的服务器拒绝（用户手动删）。
export function planMcpServerDelete(config, name) {
    const key = String(name || '').trim();
    if (!key) throw new Error('delete_mcp_server 需要 name');
    const next = cloneConfig(config);
    const servers = next.mcpServers && typeof next.mcpServers === 'object' ? next.mcpServers : {};
    const server = servers[key];
    if (!server) return {config: next, name: key, deleted: false, note: '没有找到该服务器'};
    if (Object.keys(server.env || {}).length) {
        throw new Error('服务器「' + key + '」已配置环境变量，AI 不能删除；请让用户在设置里手动删除');
    }
    delete servers[key];
    next.mcpServers = servers;
    return {config: next, name: key, deleted: true, server};
}

// mcpServerCommandPreview：审批卡展示用（用户可见，含参数原文）。
export function mcpServerCommandPreview(server) {
    const args = Array.isArray(server && server.args) ? server.args : [];
    return [String((server && server.command) || ''), ...args.map((item) => String(item))].filter(Boolean).join(' ');
}
