// ai-mcp.js：MCP 客户端前端逻辑层——工具注册表（整代快照替换）、MCP 工具 → 工具定义转换、
// tools/call 转发。设置页 UI 在 ai-mcp-settings.js；Go 侧世代/重连在 mcp_manager.go。
// 硬约束（§5.4）：registry 只被整代快照替换，绝不增量合并——「要么全有要么全无」。
import {aiEstimateTokens} from './ai-constants.js';

// mcpNotesBlock：把各 server 的「使用约定」拼成系统提示词块。
// 只列有内容的 server；整块为空时返回空串（不占上下文）。约定是**数据**不是指令：
// mcp.json 可能被拷贝、示例分发甚至插件注入，尖括号必须转义——否则 notes 里一句
// "</mcp_server_notes>" 就能闭合块、往 system 角色里塞任意"守则"。换行压平同时覆盖
// \r 与 U+2028/2029（JSON.stringify 不会转义它们，原样进块会破坏块结构）。
export function mcpNotesBlock(servers) {
    const rows = [];
    for (const server of Array.isArray(servers) ? servers : []) {
        const name = String((server && server.name) || '').trim();
        const notes = String((server && server.notes) || '').trim();
        if (!name || !notes) continue;
        rows.push('- ' + name + '：' + notes
            .replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;'));
    }
    if (!rows.length) return '';
    return [
        '<mcp_server_notes>',
        '以下是用户为特定 MCP server 写的使用约定，调用这些 server 的工具时优先遵循：',
        ...rows,
        '</mcp_server_notes>',
    ].join('\n');
}

export function createAIMcp(ctx) {
    const backend = (ctx && ctx.backend) || {};

    let enabled = false;
    let loaded = false; // 是否至少收到过一次快照：区分「总开关关闭」与「还没拉过」
    let servers = []; // [{name, state, reason, toolCount, tools, staleTools, lastError, attempt, maxAttempt, nextRetryAt}]

    // applySnapshot 整表替换当前注册表。两个事件（tools-changed / status-changed）
    // 都携带全量快照，前端不做增量合并——原子性由 Go 侧世代保证，这里只做整表接管。
    function applySnapshot(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') return; // 畸形载荷：保留现状，不清空
        enabled = snapshot.enabled === true;
        loaded = true;
        const list = Array.isArray(snapshot.servers) ? snapshot.servers : [];
        servers = list.map((server) => ({
            name: String(server.name || ''),
            state: String(server.state || 'closed'),
            reason: String(server.reason || ''),
            toolCount: Math.max(0, Math.round(Number(server.toolCount) || 0)),
            tools: Array.isArray(server.tools) ? server.tools : [],
            staleTools: Array.isArray(server.staleTools) ? server.staleTools : [],
            lastError: String(server.lastError || ''),
            attempt: Math.max(0, Math.round(Number(server.attempt) || 0)),
            maxAttempt: Math.max(0, Math.round(Number(server.maxAttempt) || 0)),
            nextRetryAt: Math.max(0, Math.round(Number(server.nextRetryAt) || 0)),
            // 用户给这个 server 写的使用约定（进系统提示词，见 mcpNotesBlock）
            notes: String(server.notes || ''),
        }));
    }

    // sanitizeSchema：远端 schema 不可信。null / 缺 type / 顶层非 object 一律降级为宽松
    // object，保证请求层不会因非法 schema 被模型 API 拒绝。
    function sanitizeSchema(schema) {
        if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
            return {type: 'object', properties: {}, required: []};
        }
        const out = {type: 'object', properties: {}};
        const props = schema.properties;
        if (props && typeof props === 'object' && !Array.isArray(props)) out.properties = props;
        out.required = Array.isArray(schema.required)
            ? schema.required.filter((item) => typeof item === 'string')
            : [];
        if (schema.additionalProperties !== undefined) {
            out.additionalProperties = schema.additionalProperties;
        }
        return out;
    }

    // mcpToolToDef：MCP 快照工具 → 工具定义表形态 {name, description, parameters}。
    function mcpToolToDef(tool) {
        const def = {
            name: String((tool && tool.publicName) || ''),
            description: String((tool && tool.description) || ''),
            parameters: sanitizeSchema(tool && tool.inputSchema),
        };
        if (tool && tool.rawName) def.mcpRawName = String(tool.rawName);
        if (tool && tool.server) def.mcpServer = String(tool.server);
        if (tool && tool.openWorld) def.mcpOpenWorld = true;
        return def;
    }

    // mcpToolDefs：注入 toolsForScope 的同步读取口（组装路径上不塞 RPC，只读缓存）。
    function mcpToolDefs() {
        if (!enabled) return [];
        const out = [];
        for (const server of servers) {
            if (!server.tools.length) continue;
            out.push(...server.tools.map(mcpToolToDef)); // server.tools 整代替换：要么全有要么全无
        }
        return out;
    }

    // toolTokenEstimate：单工具 schema+描述的 token 估算（工具勾选面板展示用）。
    function toolTokenEstimate(tool) {
        return aiEstimateTokens(JSON.stringify(mcpToolToDef(tool)));
    }

    // routeInfo：公开名 → 路由信息（server / 原始名 / openWorld），留痕用。
    function routeInfo(publicName) {
        for (const server of servers) {
            const tool = server.tools.find((t) => t.publicName === publicName);
            if (tool) {
                return {server: server.name, rawName: String(tool.rawName || ''), openWorld: tool.openWorld === true};
            }
        }
        return null;
    }

    // callTool：公开名直通 Go 路由（查表发原始名，公开名绝不发给 server）。
    // isError 是 server 侧业务失败：不当异常，文本原样返回由模型自行收敛。
    async function callTool(name, args) {
        if (typeof backend.MCPCallTool !== 'function') {
            throw new Error('MCP 客户端不可用（后端未提供 MCPCallTool）');
        }
        const payload = JSON.stringify(args && typeof args === 'object' ? args : {});
        const result = await backend.MCPCallTool(name, payload);
        if (result && typeof result.text === 'string') return result.text;
        return String((result && result.text) || '');
    }

    // refresh 兜底拉取：初始化/会话恢复后先拉一次，防错过启动早期事件；
    // Go 侧 MCPSnapshot 会触发惰性启动。失败不阻塞（旧后端 / MCP 未启用时 registry 留空）。
    async function refresh() {
        if (typeof backend.MCPSnapshot !== 'function') return;
        applySnapshot(await backend.MCPSnapshot());
    }

    return {
        applySnapshot,
        mcpToolDefs,
        mcpToolToDef,
        sanitizeSchema,
        toolTokenEstimate,
        routeInfo,
        callTool,
        refresh,
        // 状态读取口（设置页 / 诊断）：返回快照副本，调用方不得直接改内部状态
        getState: () => ({enabled, loaded, servers: servers.map((server) => Object.assign({}, server))}),
    };
}
