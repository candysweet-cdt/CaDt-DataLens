// settings-pane-external-tools.js：「外部工具」应用页面（原 设置 → AI → 外部工具，已迁为
// 内容区标签页，见 core/app-pages.js）。上半部分是能力来源矩阵（搜索/抓取/OCR/TTS/ASR 各选
// 关闭 / 本地 MCP / 服务提供商，搜索与抓取另有内置），下半部分是服务提供商配置；
// MCP 服务器组 DOM 常驻 index.html 的 #extcap-park 停靠区，绑定仍归 ai-mcp-settings.js。
// mount/unmount 把停靠 DOM 搬进 / 搬出标签页容器——保持节点身份，启动时按 id 捕获的
// 引用与事件绑定（本模块 els、ai-mcp-settings 的 el）跨开关标签页始终有效。
// 配置读写走 Go（WebToolsConfigGet / Save / ClearKey）。
import {createInput, createSelect, createSwitch} from '../core/form-controls.js';
import {copyTextToClipboard} from '../core/clipboard.js';
import {pageHeader, statusBadge, stateBlock} from '../app-pages/ui-kit.js';
import {
    DEFAULT_PROVIDER_BASE_URL,
    EXTERNAL_CAPABILITIES,
    EXTERNAL_MODE_LABELS,
    defaultExternalToolsConfig,
    effectiveExternalMode,
    externalProviderReady,
    normalizeExternalToolsConfig,
} from '../ai/tools/ai-external-tools.js';
// 桌面控制（Computer Use）的配置行构造（desktop-mcp.md §5.3/§13.5 P2 降级：
// 复制安装命令 + 一键写入 mcp.json 行 + doctor 只读诊断；不做自动安装依赖）
import {DESKTOP_MCP_SERVER, DESKTOP_ALL_TOOLS, DESKTOP_HIGH_RISK_TOOLS, desktopServerConfigRow, desktopConfigNeedsUpgrade, isDesktopToolDef} from '../ai/tools/ai-desktop-control.js';
import {onAppEvent} from '../core/app-events.js';

export function createSettingsPaneExternalTools(deps) {
    const backend = (deps && deps.backend) || {};
    const flash = (deps && deps.flash) || (() => {});
    const getMcpToolDefs = (deps && deps.getMcpToolDefs) || (() => []);
    const getAiPanel = (deps && deps.getAiPanel) || (() => null);
    // ensureAiPanel：取 AI 面板并在未建时初始化（宿主注入；缺省退回纯读）
    const ensureAiPanel = (deps && deps.ensureAiPanel) || getAiPanel;
    const openExternalUrl = (deps && deps.openExternalUrl) || (() => {});
    const enhanceSetSelects = (deps && deps.enhanceSetSelects) || null;
    const confirmAction = (deps && deps.confirmAction) || ((message, action) => {
        if (window.confirm(message)) action();
    });

    const els = {
        list: document.getElementById('extcap-list'),
        provider: document.getElementById('extcap-provider'),
        desktop: document.getElementById('extcap-desktop'),
        samples: document.getElementById('ai-opt-mcp-samples'),
        samplesList: document.getElementById('ai-opt-mcp-samples-list'),
    };
    let config = defaultExternalToolsConfig();
    let loading = false;
    let errorText = '';
    let samples = [];
    let samplesError = '';
    let samplesOpen = false;
    let sampleInstalling = '';
    let desktopMcpConfig = null;  // MCPConfig（懒加载，仅桌面卡片用）
    let desktopBusy = '';         // 'toggle' | 'install' 进行中标记
    let saveState = {text: '', tone: 'neutral'}; // 保存反馈（页头徽标）
    let saveStamp = 0;            // 最近一次成功保存时间（页头「已保存」副文案）
    let saveSeq = 0;              // 保存竞态序号：只让最后一次结果更新徽标
    let headBadge = null;         // 页头保存状态徽标节点

    function fieldRow(title, desc, ...controls) {
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
        for (const control of controls) if (control) box.appendChild(control);
        row.append(main, box);
        return row;
    }

    function button(label, className, onClick) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = className || 'dlg-btn';
        el.textContent = label;
        if (onClick) el.addEventListener('click', onClick);
        return el;
    }

    function infoTip(label, text) {
        const tip = document.createElement('button');
        tip.type = 'button';
        tip.className = 'info-tip';
        tip.dataset.tip = text;
        tip.setAttribute('aria-label', label + '说明');
        return tip;
    }

    function fieldRowWithTip(title, desc, tipText, ...controls) {
        const row = fieldRow(title, desc, ...controls);
        const titleEl = row.querySelector('.set-title');
        if (titleEl) titleEl.appendChild(infoTip(title, tipText));
        return row;
    }

    async function load() {
        if (loading) return;
        loading = true;
        try {
            if (typeof backend.WebToolsConfigGet !== 'function') {
                errorText = '当前后端版本不支持外部工具配置（请重新构建或更新应用）';
                return;
            }
            config = normalizeExternalToolsConfig(await backend.WebToolsConfigGet());
            errorText = '';
        } catch (e) {
            errorText = '配置读取失败：' + ((e && e.message) || e);
        } finally {
            loading = false;
        }
    }

    function payload(patch) {
        const next = Object.assign({}, config, patch || {});
        return {
            enabled: next.enabled,
            baseUrl: next.baseUrl,
            apiKey: (patch && patch.apiKey) || '',
            searchCount: next.searchCount,
            capabilities: next.capabilities,
            mcpBindings: next.mcpBindings,
        };
    }

    function setSaveState(text, tone) {
        saveState = {text, tone};
        if (headBadge) {
            headBadge.className = 'ap-badge ap-badge-' + tone;
            headBadge.textContent = text;
        }
    }

    async function save(patch) {
        if (typeof backend.WebToolsConfigSave !== 'function') {
            flash('当前后端版本不支持外部工具配置', true);
            return;
        }
        const seq = ++saveSeq;
        setSaveState('保存中…', 'warn');
        try {
            await backend.WebToolsConfigSave(payload(patch));
            config = normalizeExternalToolsConfig(await backend.WebToolsConfigGet());
            const panel = getAiPanel();
            if (panel && typeof panel.refreshExternalTools === 'function') {
                Promise.resolve(panel.refreshExternalTools()).catch(() => {});
            }
            if (seq === saveSeq) {
                saveStamp = Date.now();
                setSaveState('已保存 ' + new Date(saveStamp).toLocaleTimeString(), 'success');
            }
            paint();
        } catch (e) {
            if (seq === saveSeq) setSaveState('保存失败', 'danger');
            flash('外部工具配置保存失败：' + ((e && e.message) || e), true);
        }
    }

    function mcpToolOptions() {
        return (getMcpToolDefs() || []).map((def) => ({value: def.name, label: def.name}));
    }

    // capabilityState：把提示升级为「有效性徽标 + 说明」，让矩阵一眼可扫。
    // tone ∈ success | warn | danger | neutral；text 是徽标短文案；hint 是详细说明。
    function capabilityState(cap, mode, liveNames) {
        if (mode === 'off') return {tone: 'neutral', text: '关闭', hint: '不向 AI 注册该工具。'};
        if (mode === 'builtin') return {tone: 'success', text: '可用', hint: '使用应用内置实现，失败后可自动回退。'};
        if (mode === 'provider') {
            return externalProviderReady(config)
                ? {tone: 'success', text: '可用', hint: '上传到服务提供商，按量计费；审批卡会显示文件与预估费用。'}
                : {tone: 'warn', text: '待配置', hint: '服务提供商未启用或缺少 API Key，当前不可用（见下方配置）。'};
        }
        if (mode === 'mcp') {
            const binding = config.mcpBindings[cap.key] || '';
            if (!binding) return {tone: 'warn', text: '待绑定', hint: '尚未选择 MCP 工具，当前不可用。'};
            if (!liveNames.includes(binding)) return {tone: 'danger', text: '已失效', hint: '绑定的工具当前不可用（服务器被禁用/删除或工具未勾选），请重选。'};
            return {tone: 'success', text: '可用', hint: '交本机 MCP 服务器处理；仅写权限档（非计划模式）向 AI 开放，调用按写工具审批。'};
        }
        return {tone: 'neutral', text: '', hint: ''};
    }

    function paintCapabilities() {
        if (!els.list) return;
        els.list.textContent = '';
        const liveNames = mcpToolOptions().map((item) => item.value);
        for (const cap of EXTERNAL_CAPABILITIES) {
            const mode = config.capabilities[cap.key].mode;
            const options = [];
            if (cap.builtin) options.push({value: 'builtin', label: EXTERNAL_MODE_LABELS.builtin});
            options.push({value: 'provider', label: EXTERNAL_MODE_LABELS.provider});
            options.push({value: 'mcp', label: EXTERNAL_MODE_LABELS.mcp});
            options.push({value: 'off', label: EXTERNAL_MODE_LABELS.off});
            const modeSelect = createSelect({
                className: 'opt-select',
                options: options.map((item) => Object.assign({selected: item.value === mode}, item)),
                onChange: (event) => {
                    const caps = Object.assign({}, config.capabilities, {[cap.key]: {mode: event.target.value}});
                    void save({capabilities: caps});
                },
            });
            const controls = [modeSelect.element];
            if (mode === 'mcp') {
                const live = mcpToolOptions();
                if (!live.length) live.push({value: '', label: '（未检测到已启用的 MCP 工具）'});
                const binding = config.mcpBindings[cap.key] || '';
                const bindingSelect = createSelect({
                    className: 'opt-select',
                    options: live.map((item) => Object.assign({selected: item.value === binding}, item)),
                    onChange: (event) => {
                        const bindings = Object.assign({}, config.mcpBindings, {[cap.key]: event.target.value});
                        void save({mcpBindings: bindings});
                    },
                });
                controls.push(bindingSelect.element);
            }
            const state = capabilityState(cap, mode, liveNames);
            const card = document.createElement('div');
            card.className = 'set-card ap-cap-card';
            const row = fieldRow(cap.label, state.hint, ...controls);
            const titleEl = row.querySelector('.set-title');
            if (titleEl) {
                titleEl.style.display = 'flex';
                titleEl.style.alignItems = 'center';
                titleEl.style.gap = '6px';
                titleEl.appendChild(statusBadge(state.text, state.tone));
            }
            card.appendChild(row);
            els.list.appendChild(card);
        }
    }

    function paintProvider() {
        if (!els.provider) return;
        els.provider.textContent = '';
        const switchCtl = createSwitch({
            checked: config.enabled,
            onChange: (event) => { void save({enabled: event.target.checked}); },
        });
        const keyInput = createInput({
            type: 'password',
            className: 'ai-settings-input extcap-key-input',
            placeholder: config.apiKeySet ? '已保存；留空保持不变' : 'sk-...（只保存在本机）',
            autocomplete: 'new-password',
            onChange: (event) => {
                const value = event.target.value.trim();
                if (!value) return; // 留空 = 保持原值；清空走右侧按钮
                void save({apiKey: value}).then(() => { event.target.value = ''; });
            },
        });
        const keyControls = [keyInput.element];
        if (config.apiKeySet) {
            keyControls.push(button('清除 Key', 'dlg-btn', async () => {
                try {
                    await backend.WebToolsConfigClearKey();
                    await load();
                    paint();
                    const panel = getAiPanel();
                    if (panel && typeof panel.refreshExternalTools === 'function') {
                        Promise.resolve(panel.refreshExternalTools()).catch(() => {});
                    }
                } catch (e) {
                    flash('清除 API Key 失败：' + ((e && e.message) || e), true);
                }
            }));
        }
        const baseInput = createInput({
            className: 'ai-settings-input extcap-base-url',
            value: config.baseUrl,
            placeholder: DEFAULT_PROVIDER_BASE_URL,
            spellcheck: false,
            onChange: (event) => { void save({baseUrl: event.target.value.trim()}); },
        });
        const countInput = createInput({
            type: 'number',
            className: 'ai-settings-input ai-font-size-num',
            value: config.searchCount,
            min: 1,
            max: 50,
            step: 1,
            onChange: (event) => {
                const n = Math.max(1, Math.min(50, Math.round(Number(event.target.value) || 10)));
                event.target.value = String(n);
                void save({searchCount: n});
            },
        });
        els.provider.append(
            fieldRowWithTip('启用服务提供商', '', '各能力选择「服务提供商」时必须启用并配置 API Key；搜索 / 抓取选择「内置」时不受影响。', switchCtl.element),
            fieldRowWithTip('API Key', '仅保存在本机', '保存在应用数据目录（0600）；不会回显明文，也不会写入日志。', ...keyControls),
            fieldRowWithTip('基础地址', '留空用 DeepSeek 默认地址', '留空 = ' + DEFAULT_PROVIDER_BASE_URL + '（程序自动追加 /search、/fetch、/ocr、/tts、/asr）。', baseInput.element),
            fieldRowWithTip('每次搜索结果数', '实际最多返回 10 条', '可设置 1–50；实际返回还受工具单次上限 10 约束。', countInput.element),
            fieldRow(
                '相关链接', '',
                button('API 文档', 'dlg-btn', () => openExternalUrl('https://api-docs.deepseek.com/zh-cn/api/search')),
                button('价格', 'dlg-btn', () => openExternalUrl('https://api-docs.deepseek.com/zh-cn/quick_start/pricing')),
                button('获取 Key', 'dlg-btn', () => openExternalUrl('https://platform.deepseek.com')),
            ),
        );
    }

    async function loadSamples() {
        samplesError = '';
        if (typeof backend.MCPSamplesList !== 'function') {
            samples = [];
            return;
        }
        try {
            const list = await backend.MCPSamplesList();
            samples = Array.isArray(list) ? list : [];
        } catch (e) {
            samples = [];
            samplesError = '内置示例读取失败：' + ((e && e.message) || e);
        }
    }

    function paintSamples() {
        if (!els.samples || !els.samplesList) return;
        els.samples.classList.toggle('hidden', !samples.length && !samplesError);
        els.samplesList.classList.toggle('hidden', !samplesOpen);
        const btn = els.samples;
        if (btn) btn.textContent = samplesOpen ? '收起示例' : '查看示例';
        if (!samplesOpen) return;
        els.samplesList.textContent = '';
        if (samplesError) {
            const hint = document.createElement('div');
            hint.className = 'fmt-hint hint-indent';
            hint.textContent = samplesError;
            els.samplesList.appendChild(hint);
            return;
        }
        if (!samples.length) {
            const hint = document.createElement('div');
            hint.className = 'fmt-hint hint-indent';
            hint.textContent = '当前版本没有可用示例。';
            els.samplesList.appendChild(hint);
            return;
        }
        for (const sample of samples) {
            const envText = (sample.envKeys || []).length ? '；安装后需填写环境变量：' + sample.envKeys.join('、') : '';
            const preText = (sample.prerequisites || []).length ? '前置：' + sample.prerequisites.join('、') + '。' : '';
            const desc = String(sample.description || '') + ' ' + preText +
                '安装后公开工具名：' + sample.publicToolName + envText + '。';
            const card = document.createElement('div');
            card.className = 'set-card';
            const control = document.createElement('div');
            if (sample.installed) {
                const done = document.createElement('span');
                done.className = 'set-desc';
                done.textContent = '已安装';
                control.appendChild(done);
            } else {
                const installBtn = button('安装', 'dlg-btn primary', () => {
                    if (sampleInstalling) return;
                    confirmAction(
                        '将释放内置脚本并在本机注册 MCP 服务器「' + sample.serverName + '」：\n' +
                        sample.commandPreview + '\n该命令会在本机执行，安装后 AI 可按工具「' + sample.toolName + '」调用它。确认安装？',
                        () => { void installSample(sample); },
                        '确认安装',
                        '安装内置 MCP 示例',
                    );
                });
                installBtn.disabled = !!sampleInstalling;
                control.appendChild(installBtn);
            }
            const row = fieldRow(sample.name, desc, control);
            card.appendChild(row);
            els.samplesList.appendChild(card);
        }
    }

    async function installSample(sample) {
        if (typeof backend.MCPInstallSample !== 'function') {
            flash('当前后端版本不支持安装内置示例', true);
            return;
        }
        sampleInstalling = sample.id;
        paintSamples();
        try {
            const result = await backend.MCPInstallSample(sample.id);
            flash('已安装内置 MCP 示例「' + (result.name || sample.name) + '」');
            await loadSamples();
            const panel = getAiPanel();
            if (panel && typeof panel.refreshMcpConfig === 'function') {
                Promise.resolve(panel.refreshMcpConfig()).catch(() => {});
            }
        } catch (e) {
            flash('安装示例失败：' + ((e && e.message) || e), true);
        } finally {
            sampleInstalling = '';
            paintSamples();
        }
    }

    function bindSamples() {
        if (!els.samples) return;
        els.samples.addEventListener('click', () => {
            samplesOpen = !samplesOpen;
            paintSamples();
        });
    }

    // ===== 桌面控制（Computer Use）卡片 =====
    // 形态（2026-11-22 用户二次裁决，取代「开关 + 安装按钮」两件套）：
    //   ① 开关即安装——打开开关就装依赖，首次在开关下面显示进度条 + 上游日志；
    //   ② 装好后在开关下面列出上游**全部工具**（Go 侧 internal/desktopmcp.AllTools），
    //      默认全选，用户可逐项取消。
    // mcp.json 的 enabledTools 是唯一的工具可见性闸（空数组 = 一个都不给，server 也不启动）；
    // 会话授权与控制模式是另外两道闸，不在这张卡片上。

    let desktopPlan = null;   // MCPDesktopPlan() 快照（wheel 路径、上游工具清单、notes）
    let desktopInstall = {running: false, percent: 0, stage: '', detail: '', line: '', error: '', done: false};
    let installStarting = false; // 安装作业启动中（await 链期间也要挡住重复点击）

    function desktopRow() {
        return (desktopMcpConfig && desktopMcpConfig.mcpServers && desktopMcpConfig.mcpServers[DESKTOP_MCP_SERVER]) || null;
    }

    // 桌面工具计数：MCP 快照里 windows server 已注册的工具数（0 = 未就绪 / 未启动 / 未勾选）
    function desktopToolCount() {
        return getMcpToolDefs().filter(isDesktopToolDef).length;
    }

    // 工具清单优先用后端 plan（真相在上游 wheel），拿不到时退到前端常量（浏览器 mock）
    function desktopToolList() {
        if (desktopPlan && Array.isArray(desktopPlan.tools) && desktopPlan.tools.length) return desktopPlan.tools;
        return DESKTOP_ALL_TOOLS.map((name) => ({name}));
    }

    function refreshPanelSnapshot() {
        const panel = getAiPanel();
        if (panel && typeof panel.refreshMcpConfig === 'function') {
            Promise.resolve(panel.refreshMcpConfig()).catch(() => {}); // 尽力而为：拉新快照
        }
    }

    async function loadDesktopPlan() {
        if (typeof backend.MCPDesktopPlan !== 'function') {
            desktopPlan = null;
            return;
        }
        try {
            const plan = await backend.MCPDesktopPlan();
            desktopPlan = (plan && typeof plan === 'object') ? plan : null;
        } catch (e) {
            desktopPlan = null; // plan 只用于预览与清单：拿不到就降级，不阻塞卡片
        }
    }

    // 页面重建时把正在跑的安装进度接回来（事件只在推送时刻有效）
    async function loadDesktopInstallStatus() {
        if (typeof backend.MCPDesktopInstallStatus !== 'function') return;
        try {
            const st = await backend.MCPDesktopInstallStatus();
            if (!st || typeof st !== 'object') return;
            desktopInstall.running = !!st.running;
            if (st.error) desktopInstall.error = String(st.error);
            if (st.done) {
                desktopInstall.done = true;
                desktopInstall.percent = 100;
                desktopInstall.detail = '安装完成';
            } else if (st.progress && typeof st.progress === 'object') {
                desktopInstall.percent = Number(st.progress.percent) || 0;
                desktopInstall.stage = String(st.progress.stage || '');
                desktopInstall.detail = String(st.progress.detail || '');
            }
        } catch (e) {
            // 状态查询是尽力而为：拿不到就当没有作业，卡片照常显示
        }
    }

    async function loadDesktop() {
        if (typeof backend.MCPGetConfig !== 'function') return;
        try {
            desktopMcpConfig = await backend.MCPGetConfig();
            if (!desktopMcpConfig || typeof desktopMcpConfig !== 'object') desktopMcpConfig = {mcpServers: {}};
            if (!desktopMcpConfig.mcpServers) desktopMcpConfig.mcpServers = {};
        } catch (e) {
            desktopMcpConfig = null; // 读取失败不阻塞整页：卡片显示为不可用
        }
        await loadDesktopPlan();
        await loadDesktopInstallStatus();
    }

    function copyText(text) {
        // 先 Go 绑定再 Web API（core/clipboard.js）；两者都失败才提示
        copyTextToClipboard(text, {goCopy: typeof backend.CopyText === 'function' ? (value) => backend.CopyText(value) : null})
            .then((ok) => flash(ok ? '已复制到剪贴板' : '复制失败：剪贴板不可用', !ok));
    }

    // 写 mcp.json 前**重读一次**（2026-11-23 审查 H2）：桌面卡片与 ai-mcp-settings 管理同一份
    // 文件的不同 server 行，各自持有快照。用户在本页停留期间若从 MCP 列表增/删了别的 server，
    // 用陈旧快照整文件覆盖会丢掉那些改动。这里以最新磁盘内容为准，只替换 windows 行。
    // 读失败时退回内存快照（不阻塞用户操作），至少不比改动前更差。
    async function freshConfig() {
        if (typeof backend.MCPGetConfig === 'function') {
            try {
                const latest = await backend.MCPGetConfig();
                if (latest && typeof latest === 'object' && latest.mcpServers) {
                    desktopMcpConfig = latest;
                    return latest;
                }
            } catch (e) {
                // 尽力而为：读失败继续用内存快照
            }
        }
        return desktopMcpConfig;
    }

    // 把 windows 行写回最新配置：freshConfig + 只替换该 server 行。
    async function writeDesktopRow(row) {
        const base = await freshConfig();
        if (!base) return null;
        const next = Object.assign({}, base, {version: 1});
        next.mcpServers = Object.assign({}, base.mcpServers);
        next.mcpServers[DESKTOP_MCP_SERVER] = row;
        await backend.MCPWriteConfig(next);
        desktopMcpConfig = next;
        return next;
    }

    // 安装进度事件：Go 侧 desktopmcp.Install 逐阶段推送（release → uv → warm → done/error）
    let desktopEventBound = false;
    function bindDesktopInstallEvent() {
        if (desktopEventBound) return;
        desktopEventBound = true;
        onAppEvent('mcp-desktop-install', (payload) => {
            if (!payload || typeof payload !== 'object') return;
            const phase = String(payload.phase || 'running');
            if (payload.stage) desktopInstall.stage = String(payload.stage);
            if (typeof payload.detail === 'string') desktopInstall.detail = payload.detail;
            if (typeof payload.line === 'string') desktopInstall.line = payload.line;
            if (typeof payload.percent === 'number') desktopInstall.percent = payload.percent;
            if (phase === 'error') {
                desktopInstall.running = false;
                desktopInstall.error = String(payload.error || '安装失败');
            } else if (phase === 'done') {
                desktopInstall.running = false;
                desktopInstall.done = true;
                desktopInstall.error = '';
                desktopInstall.percent = 100;
                desktopInstall.detail = '安装完成';
                // 装完刷新两处：plan（wheel 就绪）与 MCP 快照（工具出现）
                void loadDesktopPlan().then(() => {
                    refreshPanelSnapshot();
                    paintDesktop();
                });
            } else {
                desktopInstall.running = true;
                desktopInstall.error = '';
            }
            paintDesktop();
        });
    }

    // 开关「启用」：已安装时只切 enabled；未安装时先写入配置行再启动异步安装。
    async function setDesktopEnabled(on) {
        if (typeof backend.MCPWriteConfig !== 'function' || !desktopMcpConfig) {
            flash('当前后端版本不支持写入 MCP 配置', true);
            return;
        }
        desktopBusy = 'toggle';
        try {
            const base = await freshConfig();
            if (!base) {
                flash('读取 MCP 配置失败', true);
                return;
            }
            await writeDesktopRow(Object.assign({}, desktopRow(), {enabled: !!on}));
            refreshPanelSnapshot();
            flash(on ? '桌面控制已启用' : '桌面控制已停用（各会话的授权保留，重新启用后恢复）');
        } catch (e) {
            flash('保存失败：' + ((e && e.message) || e), true);
        } finally {
            desktopBusy = '';
            paintDesktop();
        }
    }

    // 安装：写配置行（含内置 wheel 路径与全量工具勾选）→ 起后端异步作业 → 进度走事件。
    // 已存在时是「更新配置」而不是重装：只覆盖我们管理的字段，保留用户别的自定义项与
    // 已取消的工具勾选（enabledTools 只在「空」时才补成全量）。
    async function startDesktopInstall() {
        if (desktopInstall.running || installStarting) {
            flash('安装正在进行中，请稍候');
            return;
        }
        if (typeof backend.MCPDesktopInstallStart !== 'function') {
            flash('当前后端版本不支持异步安装（需要重新构建应用）', true);
            return;
        }
        // 竞态守卫：第一次 await 之前就置位（M1）——双击时第二次调用在此处就被挡住，
        // 不会重复写配置 / 重复 flash。失败或成功启动后再释放。
        installStarting = true;
        desktopBusy = 'install';
        paintDesktop();
        try {
            const base = await freshConfig();
            if (!base) {
                flash('读取 MCP 配置失败', true);
                return;
            }
            await loadDesktopPlan(); // 拿 wheel 绝对路径与上游工具清单
            const existing = desktopRow();
            const row = Object.assign({}, existing || {}, desktopServerConfigRow(desktopPlan));
            const kept = Array.isArray(existing && existing.enabledTools) ? existing.enabledTools : [];
            if (kept.length) row.enabledTools = kept.slice(); // 尊重用户已经取消的勾选
            await writeDesktopRow(row);

            desktopInstall = {running: true, percent: 1, stage: 'release', detail: '准备安装', line: '', error: '', done: false};
            installStarting = false; // 后端作业已接手，后续防重交给 desktopInstall.running
            const res = await backend.MCPDesktopInstallStart();
            if (res && res.busy) {
                flash('已有一个安装作业在跑，进度见下方');
            } else {
                flash('开始安装：内置组件已就绪，首次会下载 Python 3.14 与依赖（约 100–190 MB）');
            }
            refreshPanelSnapshot();
        } catch (e) {
            installStarting = false;
            desktopInstall.running = false;
            flash('安装失败：' + ((e && e.message) || e), true);
        } finally {
            desktopBusy = '';
            paintDesktop();
        }
    }

    // 单个工具开关：直接改 mcp.json 的 enabledTools（唯一的可见性闸）。
    // 不允许清空——空数组语义是「一个都不给」，server 连进程都不会起。
    async function setDesktopToolEnabled(name, on) {
        try {
            const base = await freshConfig();
            if (!base) return;
            const row = base.mcpServers[DESKTOP_MCP_SERVER];
            const current = Array.isArray(row && row.enabledTools) ? row.enabledTools.slice() : [];
            const next = on
                ? (current.includes(name) ? current : current.concat([name]))
                : current.filter((tool) => tool !== name);
            if (!next.length) {
                flash('至少要保留一个工具：勾选为空时这个服务器不会启动', true);
                paintDesktop();
                return;
            }
            await writeDesktopRow(Object.assign({}, row, {enabledTools: next}));
            refreshPanelSnapshot();
        } catch (e) {
            flash('保存失败：' + ((e && e.message) || e), true);
        }
        paintDesktop();
    }

    // 进度区：stage/detail 文本 + 细进度条（百分比是阶段估算，不是字节进度）
    function desktopProgressNode() {
        const wrap = document.createElement('div');
        wrap.className = 'extcap-desktop-progress';
        const bar = document.createElement('div');
        bar.className = 'extcap-desktop-progress-bar';
        const fill = document.createElement('div');
        fill.className = 'extcap-desktop-progress-fill';
        fill.style.width = Math.max(2, Math.min(100, desktopInstall.percent || 0)) + '%';
        bar.appendChild(fill);
        const text = document.createElement('div');
        text.className = 'extcap-desktop-progress-text' + (desktopInstall.error ? ' is-error' : '');
        if (desktopInstall.error) {
            text.textContent = '安装失败：' + desktopInstall.error;
        } else {
            const pct = desktopInstall.percent ? desktopInstall.percent + '% · ' : '';
            const detail = desktopInstall.detail || '安装中…';
            text.textContent = pct + detail + (desktopInstall.line ? '（' + desktopInstall.line + '）' : '');
        }
        wrap.append(bar, text);
        return wrap;
    }

    // 工具开关列表：上游全部工具，一工具一行（名字 + 风险标注 + 说明 + 开关）
    function desktopToolsNode(row) {
        const list = document.createElement('div');
        list.className = 'extcap-desktop-tools';
        const enabledTools = Array.isArray(row.enabledTools) ? row.enabledTools : [];
        for (const tool of desktopToolList()) {
            const name = String((tool && tool.name) || (typeof tool === 'string' ? tool : '') || '');
            if (!name) continue;
            const line = document.createElement('div');
            line.className = 'extcap-desktop-tool';
            const label = document.createElement('div');
            label.className = 'extcap-desktop-tool-name';
            const strong = document.createElement('span');
            strong.textContent = name;
            label.appendChild(strong);
            if (DESKTOP_HIGH_RISK_TOOLS.includes(name)) {
                const risk = document.createElement('span');
                risk.className = 'extcap-desktop-tool-risk';
                risk.textContent = '可改系统';
                label.appendChild(risk);
            }
            if (tool && tool.note) {
                const note = document.createElement('span');
                note.className = 'extcap-desktop-tool-note';
                note.textContent = tool.note;
                label.appendChild(note);
            }
            const sw = createSwitch({
                checked: enabledTools.includes(name),
                onChange: (event) => void setDesktopToolEnabled(name, event.target.checked),
            });
            line.append(label, sw.element);
            list.appendChild(line);
        }
        return list;
    }

    function paintDesktop() {
        if (!els.desktop) return;
        bindDesktopInstallEvent();
        els.desktop.textContent = '';
        const row = desktopRow();
        const installed = !!row;
        const enabled = installed && row.enabled !== false;
        const count = desktopToolCount();
        const installing = desktopInstall.running;
        const needsUpgrade = installed && desktopConfigNeedsUpgrade(row, desktopPlan);
        const plan = desktopPlan || {};
        const preview = desktopServerConfigRow(desktopPlan);
        const desc = installing
            ? (desktopInstall.detail || '正在安装依赖…')
            : (needsUpgrade
                ? '当前是本应用的旧版配置（缺 --no-control 或仍从 PyPI 拉取）。点「更新配置」升级，不需要重装'
                : (installed
                    ? (count
                        ? 'AI 可操作第三方原生窗口（读取界面 / 点击 / 输入 / 滚动 / 剪贴板）。真正动手前还要进入控制模式，面板顶部会显示提示'
                        : '已安装；server 启动后工具会出现在下面（首次启动会下载依赖）')
                    : '打开开关即安装：内置组件随应用分发，首次会下载 Python 3.14 与依赖（约 100–190 MB，需几分钟）'));
        const sw = createSwitch({
            checked: enabled || installing,
            disabled: desktopBusy === 'toggle',
            onChange: (event) => {
                const on = event.target.checked;
                if (on && !installed) {
                    void startDesktopInstall();
                    return;
                }
                void setDesktopEnabled(on);
            },
        });
        const actions = [];
        if (needsUpgrade) {
            actions.push(button(installing ? '更新中…' : '更新配置', 'dlg-btn', () => void startDesktopInstall()));
        }
        if (installed) {
            actions.push(button('复制启动命令', 'dlg-btn', () => copyText(preview.command + ' ' + preview.args.join(' '))));
        }
        if (installing && typeof backend.MCPDesktopInstallStart === 'function') {
            const busy = button('安装中…', 'dlg-btn', () => {});
            busy.disabled = true;
            actions.push(busy);
        }
        els.desktop.appendChild(fieldRow('启用桌面控制', desc, ...actions, sw.element));
        if (installing || desktopInstall.error) {
            els.desktop.appendChild(desktopProgressNode());
        }
        if (installed && !installing) {
            // 工具清单的光靠 plan：plan 没拿到（旧后端 / mock）时用前端常量降级
            if (!plan.tools) {
                const hint = document.createElement('div');
                hint.className = 'extcap-desktop-progress-text';
                hint.textContent = '工具清单待后端就绪后显示；当前按已知的 ' + DESKTOP_ALL_TOOLS.length + ' 个工具列出。';
                els.desktop.appendChild(hint);
            }
            els.desktop.appendChild(desktopToolsNode(row));
        }
    }

    // 页头：统一标题 + 保存状态徽标。页头节点在 mount 时 prepend 到 root，
    // 不进 #extcap-park（否则会被 unmount 一起搬回停靠区）。
    function ensureHead(root) {
        if (!root) return;
        if (headEl && headEl.parentElement === root) return;
        headBadge = statusBadge(saveState.text || '就绪', saveState.tone);
        headEl = pageHeader({
            title: '外部工具',
            desc: '配置 AI 的联网能力来源、服务提供商与本机 MCP 服务器。所有改动即时保存到本机。',
            actions: [headBadge],
        });
        headEl.classList.add('ap-extcap-head');
        root.insertBefore(headEl, root.firstChild);
    }

    let headEl = null;

    function paint() {
        if (els.list) els.list.textContent = '';
        if (els.provider) els.provider.textContent = '';
        if (errorText) {
            if (els.list) els.list.appendChild(stateBlock('error', errorText));
            return;
        }
        paintCapabilities();
        paintProvider();
        paintDesktop();
        paintSamples();
        // 动态创建的行式下拉需要设置页增强器接管（与其它动态 pane 一致）
        if (typeof enhanceSetSelects === 'function') enhanceSetSelects();
    }

    async function renderExternalToolsPane() {
        await Promise.all([load(), loadSamples(), loadDesktop()]);
        paint();
    }

    // ---- 应用页面标签页装载（bridge-app-page-view.js 经 main.js 的 appPageMounters 调用）----

    // 把停靠区 DOM 搬进标签页根容器；已在目标容器里时跳过（防重复装载）。
    function moveParkInto(root) {
        if (!els.list || els.list.parentElement === root) return;
        const park = document.getElementById('extcap-park');
        if (!park) return;
        root.classList.add('extcap-root'); // 沿用设置 pane 的纵向节奏（flex + gap）
        for (const child of Array.from(park.children)) root.appendChild(child);
    }

    // 挂到宿主容器：搬 DOM → 加载配置并渲染 → 返回卸载函数（把 DOM 搬回停靠区）。
    // 根容器内容全部来自停靠区（bridge 每次开标签新建 root），卸载时整体搬回即可。
    function mount(root) {
        if (!root) return null;
        moveParkInto(root);
        ensureHead(root);
        renderExternalToolsPane().catch((e) => console.error('外部工具页面渲染失败', e));
        // MCP 服务器组（总开关 + 服务器列表）的渲染归 ai-panel 的 ai-mcp-settings。
        // 该组已迁出设置弹层，refreshSettings 不再覆盖本页：不在这里补一次按配置渲染，
        // 开关就停在 index.html 的静态未勾、列表空（用户侧表现＝看不到工具、开关刷新又弹回）。
        const panel = ensureAiPanel();
        if (panel && typeof panel.renderMcpSettings === 'function') {
            try {
                panel.renderMcpSettings();
            } catch (e) {
                console.error('MCP 服务器组渲染失败', e);
            }
        }
        return () => {
            // 页头是 mount 时新建的、不属于停靠区：单独移除，避免残留到下次挂载。
            if (headEl) {
                if (headEl.parentNode) headEl.parentNode.removeChild(headEl);
                headEl = null;
                headBadge = null;
            }
            const park = document.getElementById('extcap-park');
            if (!park || !els.list) return;
            for (const child of Array.from(root.children)) park.appendChild(child);
        };
    }

    bindSamples();

    return {mount, renderExternalToolsPane};
}
