// ai-mcp-settings.js：MCP 服务器设置页——总开关、服务器列表/状态灯、行内编辑器、
// 工具勾选面板（token 估算 / 只读批量勾选 / stale 对账标黄）、探测与重启。
// 绑定 index.html 的 ai-opt-mcp-* 元素；配置读写走 Go（MCPGetConfig / MCPWriteConfig），
// 状态来自 mcpMod.getState()（Go 事件整代快照，本模块不自行维护连接态）。
// readOnlyHint 是服务器自填的 hint，绝不作为安全判断——批量勾选只是省点击，授权动作是用户点按钮本身。
import {aiEstimateTokens} from '../core/ai-constants.js';
import {createInput, createTextarea} from '../../core/form-controls.js';
import {DESKTOP_MCP_SERVER} from './ai-desktop-control.js';
import {escapeHtml} from '../../core/escape.js';

const MCP_SERVER_NAME_RULE = /^[A-Za-z0-9_-]{1,32}$/;
const MCP_TIMEOUT_MAX_MS = 600000;

// ---- 可测纯辅助函数 ----

// mcpMergeEnvRows：env 编辑行 → 配置 map。value 留空 + key 已存在 = 保持原值（密码框不回显，
// 不能把留空当成「删值」）；key 空行跳过；其余覆盖。
export function mcpMergeEnvRows(existing, rows) {
    const out = {};
    const seen = new Set();
    for (const row of rows || []) {
        const key = String(row.key || '').trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const value = String(row.value || '');
        out[key] = value === '' && Object.prototype.hasOwnProperty.call(existing || {}, key)
            ? existing[key]
            : value;
    }
    return out;
}

// mcpToolFlags：annotations 只作展示角标与留痕，绝不作为审批/安全判断。
// destructive 缺省 = true（悲观默认）。
export function mcpToolFlags(annotations) {
    const a = annotations && typeof annotations === 'object' ? annotations : {};
    return {
        readOnly: a.readOnlyHint === true,
        destructive: a.destructiveHint !== false,
        openWorld: a.openWorldHint === true,
    };
}

// mcpValidateServerForm：写入前表单校验（与 Go 写入期校验同规则，用户当场看到错在哪）。
// MCP_NOTES_MAX_CHARS：单条「使用约定」上限，与 Go 的 mcpNotesMaxChars 同值——
// 它原样进系统提示词，每个 server 都占上下文。
export const MCP_NOTES_MAX_CHARS = 1000;

export function mcpValidateServerForm(form) {
    const name = String(form.name || '').trim();
    if (!MCP_SERVER_NAME_RULE.test(name)) {
        return '服务器名只能用字母数字下划线连字符，最长 32';
    }
    if (!String(form.command || '').trim()) {
        return '缺少启动命令';
    }
    if ((form.args || []).length > 128) {
        return '参数个数超过上限 128';
    }
    if (Array.from(String(form.notes || '')).length > MCP_NOTES_MAX_CHARS) {
        return '使用约定最长 ' + MCP_NOTES_MAX_CHARS + ' 字';
    }
    for (const [label, value] of [['启动超时', form.startupTimeoutMs], ['调用超时', form.callTimeoutMs], ['关闭超时', form.closeTimeoutMs]]) {
        if (value < 0 || value > MCP_TIMEOUT_MAX_MS) {
            return label + '必须在 0 或 1–' + (MCP_TIMEOUT_MAX_MS / 1000) + ' 秒之间';
        }
    }
    return '';
}

// mcpStatusMeta：六态 → 状态灯颜色与文案（§9.1）。
export function mcpStatusMeta(state, reason) {
    switch (state) {
        case 'connected': return {cls: 'ok', text: '已连接'};
        case 'connecting': return {cls: 'warn', text: '连接中'};
        case 'reconnecting': return {cls: 'warn', text: '重连中'};
        case 'failed': return {cls: 'err', text: reason === 'unclosed-generation' ? '关闭未确认（需重启应用）' : '已放弃'};
        default: return {cls: 'idle', text: '未连接'};
    }
}

// mcpApplyServerEnabled：列表行快捷启停成功后同步内存 config 的 enabled（不可变更新）。
// toggle 走 MCPSetServerEnabled 独立 RPC，绕过 writeConfig，前端 config 不会自动更新；
// 而 Go applyConfig 必发 mcp-tools-changed → 前端 renderAll/renderList 读 config 重绘，
// 不同步这里，勾选就会被旧 config 打回，只能切页 loadConfig 才恢复。
export function mcpApplyServerEnabled(config, name, enabled) {
    if (!config || !config.mcpServers || !Object.prototype.hasOwnProperty.call(config.mcpServers, name)) return config;
    const next = Object.assign({}, config);
    next.mcpServers = Object.assign({}, config.mcpServers);
    next.mcpServers[name] = Object.assign({}, config.mcpServers[name], {enabled: !!enabled});
    return next;
}

// ---- 设置面板工厂 ----

export function createAIMcpSettings(ctx) {
    const backend = (ctx && ctx.backend) || {};
    const getMcpState = (ctx && ctx.getMcpState) || (() => ({enabled: false, servers: []}));
    const flash = (ctx && ctx.flash) || (() => {});
    const confirmAction = (ctx && ctx.confirmAction) || ((message, action) => { if (window.confirm(message)) action(); });
    const onChanged = (ctx && ctx.onChanged) || (() => {});
    // 服务器编辑器用独立弹层（仿「添加生图模型」的居中弹窗），这三个是弹层三件套
    const openAIDialog = (ctx && ctx.openAIDialog) || null;
    const closeAIDialog = (ctx && ctx.closeAIDialog) || (() => {});
    const dialogButton = (ctx && ctx.dialogButton) || ((label, className, onClick) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = className || 'dlg-btn';
        btn.textContent = label;
        if (onClick) btn.addEventListener('click', onClick);
        return btn;
    });

    let config = null;      // MCPConfig（Go 读写）
    let editingName = null; // null = 未在编辑；'' = 新建；其他 = 编辑该 server
    let toolsPanel = null;  // {name, tools, checked:Set}
    let openDiagName = null;

    const el = {
        enabled: document.getElementById('ai-opt-mcp-enabled'),
        add: document.getElementById('ai-opt-mcp-add'),
        list: document.getElementById('ai-opt-mcp-list'),
    };

    function bind() {
        if (el.enabled) {
            el.enabled.addEventListener('change', async () => {
                const checked = el.enabled.checked;
                // 首次渲染前 config 可能还没读（旧路径下这里静默 return，点了像没反应）：
                // 先补读一次，仍拿不到就把勾选回弹，不留下「看着开了其实没写」的假象。
                if (!config) await loadConfig().catch(() => {});
                if (!config) {
                    el.enabled.checked = !checked;
                    flash('MCP 配置读取失败，开关未保存', true);
                    return;
                }
                await writeConfig(Object.assign({}, config, {enabled: checked}));
            });
        }
        if (el.add) {
            el.add.addEventListener('click', () => {
                openServerEditor('');
            });
        }
    }

    async function loadConfig() {
        if (typeof backend.MCPGetConfig !== 'function') {
            config = {version: 1, enabled: true, mcpServers: {}};
            return;
        }
        try {
            const cfg = await backend.MCPGetConfig();
            config = cfg && typeof cfg === 'object' ? cfg : {version: 1, enabled: true, mcpServers: {}};
            if (!config.mcpServers) config.mcpServers = {};
        } catch (e) {
            config = null;
            renderList();
            if (el.editor) el.editor.innerHTML = '<div class="fmt-hint hint-indent">配置文件读取失败：' + escapeHtml(String((e && e.message) || e)) + '</div>';
            throw e; // 调用方（refreshSettings）已有 flash 渠道
        }
    }

    async function writeConfig(next) {
        if (!next.mcpServers) next.mcpServers = {};
        next.version = 1;
        try {
            await backend.MCPWriteConfig(next);
            config = next;
            editingName = null;
            toolsPanel = null;
            onChanged();
            renderAll();
            return true;
        } catch (e) {
            flash('MCP 配置保存失败：' + String((e && e.message) || e), true);
            return false;
        }
    }

    function statusOf(name) {
        const st = getMcpState();
        const server = (st.servers || []).find((s) => s.name === name);
        return server || {name, state: 'closed', tools: [], staleTools: [], toolCount: 0};
    }

    function renderAll() {
        renderSwitch();
        renderList();
        renderToolsPanel();
    }

    function renderSwitch() {
        if (el.enabled && config) el.enabled.checked = config.enabled !== false;
    }

    function renderList() {
        if (!el.list) return;
        if (!config) {
            el.list.innerHTML = '';
            return;
        }
        const names = Object.keys(config.mcpServers).filter((name) => name !== DESKTOP_MCP_SERVER);
        if (!names.length) {
            el.list.innerHTML = '<div class="fmt-hint hint-indent">尚未配置服务器。npx / uvx 型命令首次启动可能需要下载依赖，稍慢属正常。</div>';
            return;
        }
        const st = getMcpState();
        const frag = document.createElement('div');
        for (const name of names) {
            const cfg = config.mcpServers[name];
            const meta = mcpStatusMeta(statusOf(name).state, statusOf(name).reason);
            const live = st.servers.find((s) => s.name === name);
            const toolCount = live ? (live.toolCount || 0) : 0;
            const enabledOn = cfg.enabled !== false;
            const row = document.createElement('div');
            row.className = 'ai-mcp-server-row';
            row.innerHTML =
                '<span class="ai-mcp-lamp ai-mcp-lamp-' + meta.cls + '" data-tip="' + escapeHtml(meta.text) + '"></span>' +
                '<span class="ai-mcp-server-name">' + escapeHtml(name) + '</span>' +
                '<span class="ai-mcp-server-tools">' + toolCount + '/' + (cfg.enabledTools || []).length + ' 工具</span>' +
                '<label class="ai-mcp-inline-label"><input type="checkbox" data-mcp-toggle="' + escapeHtml(name) + '"' + (enabledOn ? ' checked' : '') + '>启用</label>' +
                '<button type="button" class="dlg-btn" data-mcp-tools="' + escapeHtml(name) + '">工具</button>' +
                '<button type="button" class="dlg-btn" data-mcp-edit="' + escapeHtml(name) + '">编辑</button>' +
                '<button type="button" class="dlg-btn" data-mcp-remove="' + escapeHtml(name) + '">删除</button>';
            frag.appendChild(row);
            // 诊断行：状态灯点击展开（重连细节 / 最近 stderr 由 Go 侧日志承载，这里给状态与原因）
            if (openDiagName === name) {
                const diag = document.createElement('div');
                diag.className = 'ai-mcp-diag';
                const s = statusOf(name);
                const lastErr = s.lastError ? escapeHtml(s.lastError) : '（无）';
                const retry = s.nextRetryAt && s.state === 'reconnecting'
                    ? '，下次重试 ' + new Date(s.nextRetryAt).toLocaleTimeString()
                    : '';
                const attempt = s.state === 'reconnecting' ? '（第 ' + s.attempt + '/' + s.maxAttempt + ' 次）' : '';
                diag.innerHTML = '<div class="fmt-hint hint-indent">状态：' + escapeHtml(meta.text) + attempt + retry +
                    '；最近错误：' + lastErr + '</div>' +
                    '<button type="button" class="dlg-btn" data-mcp-probe="' + escapeHtml(name) + '">测试连接</button> ' +
                    '<button type="button" class="dlg-btn" data-mcp-restart="' + escapeHtml(name) + '">重启</button>' +
                    '<span class="ai-mcp-probe-result" data-mcp-probe-result="' + escapeHtml(name) + '"></span>';
                frag.appendChild(diag);
            }
        }
        el.list.innerHTML = '';
        el.list.appendChild(frag);
    }

    // ---- 服务器编辑器：独立弹层（仿「添加生图模型」的居中弹窗） ----

    // fieldRow / fieldStack：与生图模型弹层同构的行式布局（.set-row / .set-row-top）。
    // 多行输入（参数、环境变量）走 fieldStack 独占整行——塞进 .set-control 会被定宽压成窄缝。
    function fieldRow(title, desc, ...controlEls) {
        const row = document.createElement('div');
        row.className = 'set-row';
        const main = document.createElement('div');
        main.className = 'set-main';
        const t = document.createElement('div');
        t.className = 'set-title';
        t.textContent = title;
        main.appendChild(t);
        if (desc) {
            const d = document.createElement('div');
            d.className = 'set-desc';
            d.textContent = desc;
            main.appendChild(d);
        }
        const box = document.createElement('div');
        box.className = 'set-control';
        for (const el of controlEls) if (el) box.appendChild(el);
        row.append(main, box);
        return row;
    }

    function fieldStack(title, desc, controlEl) {
        const row = document.createElement('div');
        row.className = 'set-row-top';
        const main = document.createElement('div');
        main.className = 'set-main';
        const t = document.createElement('div');
        t.className = 'set-title';
        t.textContent = title;
        main.appendChild(t);
        if (desc) {
            const d = document.createElement('div');
            d.className = 'set-desc';
            d.textContent = desc;
            main.appendChild(d);
        }
        row.appendChild(main);
        if (controlEl) row.appendChild(controlEl);
        return row;
    }

    // openServerEditor：添加 / 编辑服务器的弹层。name 为空串 = 新建。
    function openServerEditor(name) {
        if (!openAIDialog) {
            flash('对话框不可用，无法打开服务器编辑器', true);
            return;
        }
        const cfg = (name && config.mcpServers[name]) || {};
        const isNew = !name;
        editingName = name;

        const nameCtl = createInput({value: name || '', placeholder: '例如 everything', maxlength: 32, spellcheck: false});
        const cmdCtl = createInput({value: cfg.command || '', placeholder: '例如 npx、可执行文件路径', spellcheck: false});
        const argsCtl = createTextarea({value: (cfg.args || []).join('\n'), rows: 4, spellcheck: false, placeholder: '每行一个参数'});
        const cwdCtl = createInput({value: cfg.cwd || '', placeholder: '留空 = 继承应用目录', spellcheck: false});
        // 使用约定：原样注入系统提示词的 <mcp_server_notes> 块。上限与 Go 侧 ValidateServer 一致。
        const notesCtl = createTextarea({
            value: cfg.notes || '', rows: 3, spellcheck: false,
            placeholder: '例如：提交前先校验字段长度；一次最多提交 10 条；按来源分批提交',
        });
        notesCtl.control.maxLength = MCP_NOTES_MAX_CHARS;
        const timeoutCtl = (seconds, label) => createInput({
            type: 'number', className: 'dlg-input ai-mcp-timeout',
            value: seconds, min: 1, max: 600, attrs: {'aria-label': label},
        });
        const t1Ctl = timeoutCtl(Math.round((cfg.startupTimeoutMs || 30000) / 1000), '启动超时（秒）');
        const t2Ctl = timeoutCtl(Math.round((cfg.callTimeoutMs || 60000) / 1000), '调用超时（秒）');
        const t3Ctl = timeoutCtl(Math.round((cfg.closeTimeoutMs || 5000) / 1000), '关闭超时（秒）');

        // 环境变量：值不回显（密码框），留空 = 保持原值
        const envBox = document.createElement('div');
        envBox.className = 'ai-mcp-env-list';

        function collectEnvRows() {
            return [...envBox.querySelectorAll('.ai-mcp-env-row')].map((line) => ({
                key: line.querySelector('.ai-mcp-env-key').value,
                initialKey: line.querySelector('.ai-mcp-env-key').dataset.initialKey || '',
                value: line.querySelector('.ai-mcp-env-val').value,
            }));
        }

        function renderEnvRows(rows) {
            envBox.innerHTML = '';
            for (const row of rows) {
                const line = document.createElement('div');
                line.className = 'ai-mcp-env-row';
                const keyCtl = createInput({className: 'dlg-input ai-mcp-env-key', placeholder: '变量名', value: row.key || '', spellcheck: false});
                keyCtl.control.dataset.initialKey = row.key || '';
                const valCtl = createInput({className: 'dlg-input ai-mcp-env-val', type: 'password', placeholder: '值（留空 = 保持原值）', autocomplete: 'new-password'});
                line.append(keyCtl.element, valCtl.element);
                envBox.appendChild(line);
            }
        }

        renderEnvRows(Object.keys(cfg.env || {}).map((key) => ({key, value: ''})));

        const envAddBtn = document.createElement('button');
        envAddBtn.type = 'button';
        envAddBtn.className = 'dlg-btn';
        envAddBtn.textContent = '加一条环境变量';
        envAddBtn.addEventListener('click', () => {
            renderEnvRows(collectEnvRows().concat([{key: '', value: ''}]));
        });
        const envWrap = document.createElement('div');
        envWrap.append(envBox, envAddBtn);

        const body = document.createElement('div');
        body.append(
            fieldRow('名称', '字母数字下划线连字符，最长 32；也用作工具前缀 mcp__名称__', nameCtl.element),
            fieldRow('启动命令', '例如 npx、可执行文件路径；将在本机执行', cmdCtl.element),
            fieldStack('参数（每行一个）', '', argsCtl.element),
            fieldRow('工作目录', '留空 = 继承应用目录', cwdCtl.element),
            fieldStack('使用约定', '会注入系统提示词（≤1000 字），告诉模型这个 server 该怎么用；不要写密钥', notesCtl.element),
            fieldStack('环境变量', '值留空 = 保持原值；已存的值不回显', envWrap),
            fieldRow('启动超时（秒）', '等待服务器进程就绪的上限', t1Ctl.element),
            fieldRow('调用超时（秒）', '单次 tools/call 的等待上限', t2Ctl.element),
            fieldRow('关闭超时（秒）', '停止进程并等待退出的上限', t3Ctl.element),
        );

        const cancelBtn = dialogButton('取消', 'dlg-btn', () => {
            editingName = null;
            closeAIDialog();
        });
        const saveBtn = dialogButton('保存', 'dlg-btn primary', () => {
            void saveServerEditor();
        });

        openAIDialog((isNew ? '添加 MCP 服务器' : '编辑 MCP 服务器') + (name ? ' · ' + name : ''),
            [body], [cancelBtn, saveBtn], {top: true, wide: true});

        // 收集与落盘：闭包持有控件，不再依赖 DOM id 查询
        async function saveServerEditor() {
            const serverName = nameCtl.control.value.trim();
            const command = cmdCtl.control.value.trim();
            const args = argsCtl.control.value.split('\n').map((s) => s.trim()).filter(Boolean);
            const cwd = cwdCtl.control.value.trim();
            const t1 = Math.max(0, Math.round(Number(t1Ctl.control.value) || 0)) * 1000;
            const t2 = Math.max(0, Math.round(Number(t2Ctl.control.value) || 0)) * 1000;
            const t3 = Math.max(0, Math.round(Number(t3Ctl.control.value) || 0)) * 1000;
            // 环境变量：mcpMergeEnvRows 只输出当前行 → 删键 / 改名自动生效；留空 = 保持原值
            const existing = Object.assign({}, (editingName && config.mcpServers[editingName]) || {}).env || {};
            const env = mcpMergeEnvRows(existing, collectEnvRows().filter((r) => r.key));

            // cwd 必须进 form：漏掉它会让「工作目录」看着填了却从不落盘
            const form = {
                name: serverName, command, args, cwd, startupTimeoutMs: t1, callTimeoutMs: t2, closeTimeoutMs: t3,
                // 使用约定：空白就删掉该字段（不留下 notes:''），与 Go 侧的 omitempty 口径一致
                ...(notesCtl.control.value.trim() ? {notes: notesCtl.control.value.trim().slice(0, MCP_NOTES_MAX_CHARS)} : {}),
            };
            const error = mcpValidateServerForm(form);
            if (error) {
                flash(error, true);
                return;
            }
            if (!isNew && serverName !== editingName && config.mcpServers[serverName]) {
                flash('服务器名 ' + serverName + ' 已存在', true);
                return;
            }
            const proceed = () => {
                const next = Object.assign({}, config);
                next.mcpServers = Object.assign({}, config.mcpServers);
                if (!isNew && editingName && editingName !== serverName) delete next.mcpServers[editingName];
                next.mcpServers[serverName] = Object.assign({
                    enabledTools: (editingName && !isNew && config.mcpServers[editingName] && config.mcpServers[editingName].enabledTools) || [],
                }, form, {env});
                void writeConfig(next).then((ok) => {
                    if (!ok) return; // 落盘失败：弹层保持打开，用户改完再试
                    closeAIDialog();
                    // §15.1 两步走：保存成功 → 异步拉工具清单 → 打开勾选面板（默认全不勾）
                    openToolsPanel(serverName);
                });
            };
            if (isNew) {
                confirmAction('该命令会在本机执行，等同于你自己运行它：\n' + command + (args.length ? ' ' + args.join(' ') : '') + '\n确认添加？', proceed);
            } else {
                proceed();
            }
        }
    }

    // ---- 工具勾选面板 ----

    async function openToolsPanel(name) {
        if (typeof backend.MCPListServerTools !== 'function') return;
        let tools;
        try {
            tools = await backend.MCPListServerTools(name);
        } catch (e) {
            flash('拉取工具清单失败：' + String((e && e.message) || e), true);
            return;
        }
        const cfg = config.mcpServers[name] || {};
        toolsPanel = {
            name,
            tools: tools || [],
            checked: new Set(cfg.enabledTools || []),
        };
        renderToolsPanel();
    }

    function renderToolsPanel() {
        if (!el.list) return;
        let panel = el.list.querySelector('#ai-opt-mcp-tools');
        if (!toolsPanel) {
            if (panel) panel.remove();
            return;
        }
        // 面板跟随所属服务器行展开（插在行后，同诊断行）。整块列表重绘会把面板一起清掉，
        // renderAll 的顺序是 renderList → renderToolsPanel，这里每次重新挂回去。
        const rowBtn = el.list.querySelector('button[data-mcp-tools="' + CSS.escape(toolsPanel.name) + '"]');
        const row = rowBtn && rowBtn.closest('.ai-mcp-server-row');
        if (!row) {
            // 服务器被删除 / 改名：面板一并收起
            toolsPanel = null;
            if (panel) panel.remove();
            return;
        }
        // 每次重建 panel 节点：panel.innerHTML 只替换子节点、不换 panel 本身，
        // 复用节点会让下方 4 个按钮与 change 监听逐次叠加（MCP 事件高频触发时持续累积）。
        // 新建节点让旧节点连同其监听器一起被 GC，是消除累积的最小可靠修法。
        if (panel) panel.remove();
        panel = document.createElement('div');
        panel.id = 'ai-opt-mcp-tools';
        const anchor = row.nextElementSibling && row.nextElementSibling.classList.contains('ai-mcp-diag')
            ? row.nextElementSibling
            : row;
        anchor.after(panel);
        const st = getMcpState().servers.find((s) => s.name === toolsPanel.name);
        const stale = new Set((st && st.staleTools) || []);
        const rows = toolsPanel.tools.map((tool) => {
            const flags = mcpToolFlags(tool.annotations);
            const badges = [];
            if (flags.destructive) badges.push('<span class="ai-mcp-badge ai-mcp-badge-warn" data-tip="destructiveHint（服务器自填，不可作为安全保证）">写</span>');
            if (flags.openWorld) badges.push('<span class="ai-mcp-badge ai-mcp-badge-warn" data-tip="openWorldHint：工具会接触外部实体">外</span>');
            const tokens = aiEstimateTokens(JSON.stringify({d: tool.description, s: tool.inputSchema}));
            const isStale = stale.has(tool.name);
            return '<label class="ai-mcp-tool-row' + (isStale ? ' ai-mcp-stale' : '') + '">' +
                '<input type="checkbox" data-mcp-tool="' + escapeHtml(tool.name) + '"' + (toolsPanel.checked.has(tool.name) ? ' checked' : '') + '> ' +
                '<span class="ai-mcp-tool-name">' + escapeHtml(tool.name) + badges.join('') + (isStale ? ' <span class="ai-mcp-badge ai-mcp-badge-stale" data-tip="该工具已不在服务器清单中，保存时将被移除">已失效</span>' : '') + '</span>' +
                '<span class="ai-mcp-tool-desc">' + escapeHtml(String(tool.description || '').slice(0, 120)) + '</span>' +
                '<span class="ai-mcp-tool-tokens">≈' + tokens + ' tok</span></label>';
        }).join('');
        panel.innerHTML =
            '<div class="ai-mcp-tools-head"><b>' + escapeHtml(toolsPanel.name) + ' 的工具</b>' +
            '<button type="button" class="dlg-btn" id="ai-mcp-tools-ro">勾选只读声明</button> ' +
            '<button type="button" class="dlg-btn" id="ai-mcp-tools-all">全选</button> ' +
            '<button type="button" class="dlg-btn" id="ai-mcp-tools-save">保存勾选</button> ' +
            '<button type="button" class="dlg-btn" id="ai-mcp-tools-close">关闭</button></div>' +
            '<div class="fmt-hint hint-indent">「只读」等角标是服务器自行填写的声明，不可作为安全保证；勾选 = 授权 AI 调用该工具。</div>' +
            '<div class="ai-mcp-tools-list">' + rows + '</div>';
        panel.querySelector('#ai-mcp-tools-ro').addEventListener('click', () => {
            for (const tool of toolsPanel.tools) {
                if (tool.annotations && tool.annotations.readOnlyHint === true) toolsPanel.checked.add(tool.name);
            }
            syncCheckboxes();
        });
        panel.querySelector('#ai-mcp-tools-all').addEventListener('click', () => {
            toolsPanel.checked = new Set(toolsPanel.tools.map((tool) => tool.name));
            syncCheckboxes();
        });
        panel.querySelector('#ai-mcp-tools-close').addEventListener('click', () => {
            toolsPanel = null;
            renderToolsPanel();
        });
        panel.querySelector('#ai-mcp-tools-save').addEventListener('click', () => {
            // stale 的工具不再保存：server 已不存在该工具，勾了也拿不到
            const live = new Set(toolsPanel.tools.map((tool) => tool.name));
            const checked = [...toolsPanel.checked].filter((toolName) => live.has(toolName));
            const next = Object.assign({}, config);
            next.mcpServers = Object.assign({}, config.mcpServers);
            next.mcpServers[toolsPanel.name] = Object.assign({}, next.mcpServers[toolsPanel.name], {enabledTools: checked});
            void writeConfig(next);
        });
        syncCheckboxes();
        // 勾选联动
        panel.addEventListener('change', (e) => {
            const box = e.target.closest('input[data-mcp-tool]');
            if (!box) return;
            if (box.checked) toolsPanel.checked.add(box.dataset.mcpTool);
            else toolsPanel.checked.delete(box.dataset.mcpTool);
        });
    }

    function syncCheckboxes() {
        const panel = el.list && el.list.querySelector('#ai-opt-mcp-tools');
        if (!panel) return;
        for (const box of panel.querySelectorAll('input[data-mcp-tool]')) {
            box.checked = toolsPanel.checked.has(box.dataset.mcpTool);
        }
    }

    // ---- 列表交互（事件委托） ----

    function bindList() {
        if (!el.list) return;
        el.list.addEventListener('change', async (e) => {
            const toggle = e.target.closest('input[data-mcp-toggle]');
            if (!toggle) return;
            if (typeof backend.MCPSetServerEnabled !== 'function') return;
            const name = toggle.dataset.mcpToggle;
            const nextEnabled = toggle.checked;
            try {
                await backend.MCPSetServerEnabled(name, nextEnabled);
                // 独立 RPC 绕过 writeConfig，内存 config 不会自动更新；Go 事件到达时
                // renderAll 读的是旧 config，会把勾选打回。这里先同步再重绘，保证即时生效。
                config = mcpApplyServerEnabled(config, name, nextEnabled);
                renderList();
                renderToolsPanel(); // renderList 会清掉行内的工具面板，重新挂回
                onChanged();
            } catch (err) {
                flash('切换失败：' + String((err && err.message) || err), true);
                toggle.checked = !toggle.checked;
            }
        });
        el.list.addEventListener('click', (e) => {
            const lamp = e.target.closest('.ai-mcp-lamp');
            if (lamp) {
                const row = lamp.closest('.ai-mcp-server-row');
                const name = row && row.querySelector('.ai-mcp-server-name');
                if (name) {
                    openDiagName = openDiagName === name.textContent ? null : name.textContent;
                    renderList();
                }
                return;
            }
            const probe = e.target.closest('button[data-mcp-probe]');
            if (probe) return void runProbe(probe.dataset.mcpProbe, probe);
            const restart = e.target.closest('button[data-mcp-restart]');
            if (restart) {
                if (typeof backend.MCPRestartServer !== 'function') return;
                backend.MCPRestartServer(restart.dataset.mcpRestart).catch((err) => flash('重启失败：' + String((err && err.message) || err), true));
                return;
            }
            const toolsBtn = e.target.closest('button[data-mcp-tools]');
            if (toolsBtn) return void openToolsPanel(toolsBtn.dataset.mcpTools);
            const editBtn = e.target.closest('button[data-mcp-edit]');
            if (editBtn) {
                openServerEditor(editBtn.dataset.mcpEdit);
                return;
            }
            const removeBtn = e.target.closest('button[data-mcp-remove]');
            if (removeBtn) {
                const name = removeBtn.dataset.mcpRemove;
                confirmAction('删除服务器 ' + name + '？（配置将立即写盘，其进程停止）', () => {
                    const next = Object.assign({}, config);
                    next.mcpServers = Object.assign({}, config.mcpServers);
                    delete next.mcpServers[name];
                    void writeConfig(next);
                });
            }
        });
    }

    async function runProbe(name, button) {
        const resultHost = el.list.querySelector('[data-mcp-probe-result="' + CSS.escape(name) + '"]');
        if (!resultHost || typeof backend.MCPProbeServer !== 'function') return;
        button.disabled = true;
        resultHost.textContent = '探测中…';
        try {
            const res = await backend.MCPProbeServer(name, config.mcpServers[name] || {command: ''});
            if (res.error) {
                resultHost.textContent = '失败（' + res.stage + '）：' + res.error + '；耗时 ' + res.durationMs + 'ms';
            } else {
                resultHost.textContent = '成功：' + res.toolCount + ' 个工具，耗时 ' + res.durationMs + 'ms' + (res.cleanupError ? '；' + res.cleanupError : '');
            }
        } catch (e) {
            resultHost.textContent = '探测失败：' + String((e && e.message) || e);
        }
        button.disabled = false;
    }

    function render() {
        void loadConfig().then(() => {
            renderAll();
        }).catch(() => {}); // loadConfig 失败已在面板内展示错误，这里不再重复 flash
    }

    bind();
    bindList();

    return {
        render,          // 设置页打开 / 配置变化时刷新（ai-panel refreshSettings 调）
        renderAll,       // Go 状态事件到达时轻量刷新状态灯
    };
}
