// ai-panel.js：右侧 AI 助手面板（批次 2–6：会话 / 流式聊天 / 思考链 / 三形态 / 工具桥 / 记忆 / 技能 / 写审批 / Todolist / 变更记录 / 提示词 / 压缩 / 设置）
// 设计文档见 docs/ai-panel.md。
const AI_CONFIG_KEY = 'datalens-ai';
const AI_SESSIONS_KEY = 'datalens-ai-sessions';
const AI_CHAT_INPUT_LIMIT = 100000;
const AI_MESSAGE_LIMIT = 200;
const AI_WRITE_LIMIT = 256 * 1024;
const AI_DIFF_MAX_LINES = 4000;
const AI_DIFF_PREVIEW_LIMIT = 40;
const AI_CHANGES_LIMIT = 200;
const AI_TODO_LIMIT = 50;
const AI_IMAGE_LIMIT = 6;
const AI_IMAGE_MAX_INPUT_BYTES = 12 * 1024 * 1024;
const AI_IMAGE_MAX_DIM = 1600;
const AI_IMAGE_MAX_BASE64 = 3 * 1024 * 1024;
const AI_IMAGE_MESSAGE_BUDGET = 6 * 1024 * 1024;
const AI_IMAGE_STORAGE_BUDGET = 3.2 * 1024 * 1024;
const AI_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const AI_DEFAULT_SYSTEM_PROMPT = [
    '你是 CaDt-DataLens 桌面应用内的 AI 助手。',
    '回答准确、简洁，优先使用 Markdown；代码使用带语言标记的代码块；不确定的信息要明确说明。',
].join('\n');

const AI_BUILTIN_SKILLS = [
    {
        name: 'code-review',
        description: '按严重度审查代码，列出证据与修复建议（只读）',
        content: [
            '# 代码审查',
            '',
            '按以下顺序工作：',
            '1. 明确审查对象：用户指定的文件/目录；未指定时先从当前上下文推断，仍不明确就问用户。',
            '2. 用 list_dir / read_file / search_text 读取完整实现和调用方，不要只看片段。',
            '3. 输出 Markdown 审查报告，按「严重 / 重要 / 建议」排序。每条给出：位置（文件:行号）、问题与触发条件、影响、具体修复建议（必要时给代码）。',
            '4. 覆盖：正确性、边界条件、错误处理、安全（注入/越权/密钥）、性能、可读性与一致性。',
            '5. 没有问题就明确说「未发现需要修改的问题」，不要硬凑。',
            '本技能只读；不要修改文件。',
        ].join('\n'),
    },
    {
        name: 'json-toolkit',
        description: '校验、格式化、修复并解释 JSON / JSONL / YAML / TOML / CSV',
        content: [
            '# JSON / 数据文件工具',
            '',
            '- 先确认格式与编码；读取时使用 read_file，不要凭猜测重写整份文件。',
            '- 校验：指出错误位置（行:列或字段路径）、原因和最小修复方式。JSON 常见问题包括尾逗号、单引号、注释、未转义换行和缺逗号。',
            '- 格式化：保持键顺序和原有数据语义；不要擅自改字段名、数值精度或空值含义。',
            '- 解释结构：给出字段路径、类型、示例值和可选/必填判断。',
            '- 需要写入时先 read_file 确认原文，并用 edit_file 做最小替换；写操作会走审批。',
            '- 数据量大时先采样并说明采样范围，不要编造未读取的内容。',
        ].join('\n'),
    },
    {
        name: 'release-notes',
        description: '根据本次改动生成面向用户的更新日志 / 发布说明',
        content: [
            '# 更新日志 / 发布说明',
            '',
            '1. 汇总依据：当前会话中的变更记录、git diff/提交信息（如用户提供）以及用户描述；没有依据的内容不要编造。',
            '2. 面向最终用户写：说明「能做什么、有什么变化、修复了什么」，不要堆工程术语。',
            '3. 使用 Markdown，按「新增 / 改进 / 修复 / 移除」分组；每条一句话，必要时附一句使用方式。',
            '4. 保持克制：小改动不要写成大版本；没有内容的分类直接省略。',
            '5. 最后给出建议的版本号与发布日期（若用户未指定版本，不要擅自写入文件）。',
        ].join('\n'),
    },
];

const AI_BUILTIN_PROMPTS = [
    {id: 'builtin-default', name: '默认助手', builtin: true, content: AI_DEFAULT_SYSTEM_PROMPT},
    {
        id: 'builtin-data',
        name: '数据解释',
        builtin: true,
        content: [
            '你是数据解读助手，服务于 CaDt-DataLens 的 JSON / YAML / XML / CSV / 日志查看场景。',
            '优先解释字段含义、数据结构、异常值与统计特征；引用数据时给出字段路径或行号。',
            '不确定的数据不要编造；需要更多上下文时明确指出缺什么。',
            '回答用中文，先给结论，再给必要的细节。',
        ].join('\n'),
    },
    {
        id: 'builtin-code',
        name: '代码助手',
        builtin: true,
        content: [
            '你是代码助手，服务于本地数据查看与分析工作流。',
            '给出可直接运行的代码片段，注明依赖与输入输出；优先沿用当前项目的语言与风格。',
            '修改建议要说明影响范围与风险；涉及文件写入时提醒用户确认。',
            '回答简洁，代码使用带语言标记的代码块。',
        ].join('\n'),
    },
];

const AI_PRESETS = [
    {id: 'deepseek', name: 'DeepSeek（OpenAI）', provider: 'openai', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-flash'},
    {id: 'deepseek-anthropic', name: 'DeepSeek（Anthropic）', provider: 'anthropic', baseURL: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash'},
    {id: 'qwen', name: '通义千问', provider: 'openai', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus'},
    {id: 'glm', name: '智谱 GLM', provider: 'openai', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6'},
    {id: 'kimi', name: 'Kimi', provider: 'openai', baseURL: 'https://api.moonshot.cn/v1', model: 'kimi-latest'},
    {id: 'openrouter', name: 'OpenRouter', provider: 'openai', baseURL: 'https://openrouter.ai/api/v1', model: 'openrouter/auto'},
    {id: 'ollama', name: 'Ollama', provider: 'openai', baseURL: 'http://localhost:11434/v1', model: 'llama3.1'},
    {id: 'anthropic', name: 'Anthropic 官方', provider: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-sonnet-4-5'},
];

const AI_COMPACT_SYSTEM_PROMPT = [
    '你是会话上下文压缩器。',
    '请把给定的对话记录压缩成 Markdown 摘要，保留：用户偏好与约束、已做出的决定、关键事实与数据、涉及的文件路径、未完成事项与下一步。',
    '不要编造未出现的信息；不要输出客套话；尽量不超过 800 字。',
].join('\n');

const AI_COMMANDS = [
    {name: '/context', desc: '查看上下文用量估算'},
    {name: '/compact', desc: '压缩上下文：摘要 + 保留最近 6 条'},
    {name: '/clear', desc: '清空当前会话消息'},
    {name: '/help', desc: '列出可用命令'},
    {name: '/model', desc: '切换 AI 配置'},
    {name: '/export', desc: '导出会话为 Markdown'},
    {name: '/memory', desc: '打开记忆管理'},
    {name: '/skill', desc: '打开技能管理'},
    {name: '/plan', desc: '进入计划模式（/plan off 关闭，/plan 指令 直接开始规划）'},
    {name: '/init', desc: '生成 AGENTS.md 模板（走写审批）'},
];

function aiClamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function aiClampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return aiClamp(n, min, max);
}

function aiNowId(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function aiTextOf(value) {
    return value == null ? '' : String(value);
}

function aiIsCJK(code) {
    return (code >= 0x2e80 && code <= 0x9fff) ||
        (code >= 0xac00 && code <= 0xd7af) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xff00 && code <= 0xffef) ||
        (code >= 0x20000 && code <= 0x2ffff);
}

function aiEstimateTokens(text) {
    let cjk = 0;
    let ascii = 0;
    for (const ch of String(text || '')) {
        if (aiIsCJK(ch.codePointAt(0))) cjk++;
        else ascii++;
    }
    return Math.ceil(ascii / 4 + cjk * 0.75);
}

function aiFormatTime(ts) {
    const date = new Date(ts || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    return pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function aiFormatDuration(ms) {
    const total = Math.max(0, Math.round(Number(ms) / 1000));
    if (total < 1) return '不到 1 秒';
    if (total < 60) return total + ' 秒';
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    if (minutes < 60) return minutes + ' 分' + (seconds ? ' ' + seconds + ' 秒' : '');
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return hours + ' 小时' + (rest ? ' ' + rest + ' 分' : '');
}

function aiFormatSessionTime(ts) {
    const date = new Date(Number(ts) || Date.now());
    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate();
    if (sameDay) return aiFormatTime(date.getTime());
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (date.getFullYear() === yesterday.getFullYear() &&
        date.getMonth() === yesterday.getMonth() &&
        date.getDate() === yesterday.getDate()) {
        return '昨天 ' + aiFormatTime(date.getTime());
    }
    if (date.getFullYear() === now.getFullYear()) {
        return (date.getMonth() + 1) + ' 月 ' + date.getDate() + ' 日';
    }
    return date.getFullYear() + '/' + (date.getMonth() + 1) + '/' + date.getDate();
}

function aiNormalizeImage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    let mime = aiTextOf(raw.mime).trim().toLowerCase();
    if (mime === 'image/jpg') mime = 'image/jpeg';
    if (!AI_IMAGE_MIMES.includes(mime)) return null;
    const data = aiTextOf(raw.data).replace(/\s+/g, '');
    const logFile = aiTextOf(raw.logFile);
    if (!data && !logFile) return null;
    if (data && data.length > AI_IMAGE_MAX_BASE64) return null;
    return {
        id: aiTextOf(raw.id) || aiNowId('img-'),
        mime,
        data,
        name: aiTextOf(raw.name) || '图片',
        width: Math.max(0, Number(raw.width) || 0),
        height: Math.max(0, Number(raw.height) || 0),
        logFile,
    };
}

function aiImageSrc(image) {
    if (!image || !image.data) return '';
    return 'data:' + image.mime + ';base64,' + image.data;
}

function aiImageExt(mime) {
    if (mime === 'image/jpeg') return 'jpg';
    if (mime === 'image/webp') return 'webp';
    if (mime === 'image/gif') return 'gif';
    return 'png';
}

function aiEstimateImageTokens(image) {
    const width = Number(image && image.width) || 0;
    const height = Number(image && image.height) || 0;
    if (width > 0 && height > 0) return Math.max(85, Math.min(1600, Math.ceil(width * height / 750)));
    return 800;
}

function aiImageStats(messages) {
    let count = 0;
    let tokens = 0;
    for (const message of messages || []) {
        for (const image of (message && message.images) || []) {
            if (!image || !image.data) continue;
            count++;
            tokens += aiEstimateImageTokens(image);
        }
    }
    return {count, tokens};
}

function aiSafeFileStem(name) {
    return String(name || 'AI 会话').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'AI 会话';
}

export function createAIPanel(options) {
    const opts = options || {};
    const panel = opts.panel;
    if (!panel) throw new Error('AI 面板节点不存在');
    const dockParent = opts.dockParent;
    const overlayParent = opts.overlayParent;
    const backend = opts.backend || {};
    const settings = opts.settings || {};
    const saveSettings = typeof opts.saveSettings === 'function' ? opts.saveSettings : () => {};
    const flash = typeof opts.flash === 'function' ? opts.flash : () => {};
    const copyText = typeof opts.copyText === 'function' ? opts.copyText : async () => {};
    const renderMarkdown = typeof opts.renderMarkdown === 'function'
        ? opts.renderMarkdown
        : (text) => '<pre>' + String(text || '').replace(/[&<>]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c])) + '</pre>';
    const askConfirm = typeof opts.confirm === 'function'
        ? opts.confirm
        : (message, action) => { if (window.confirm(message)) action(); };
    const showNameDialog = typeof opts.nameDialog === 'function' ? opts.nameDialog : null;
    const openSettings = typeof opts.openSettings === 'function' ? opts.openSettings : () => {};
    const setDragCursor = typeof opts.setDragCursor === 'function' ? opts.setDragCursor : () => {};
    const onLayout = typeof opts.onLayout === 'function' ? opts.onLayout : () => {};
    const getWorkspaceContext = typeof opts.getWorkspaceContext === 'function' ? opts.getWorkspaceContext : () => ({workspaceFolder: '', activeFile: null, openFiles: []});
    const getScopeRoot = typeof opts.getScopeRoot === 'function' ? opts.getScopeRoot : () => '';
    const getSelection = typeof opts.getSelection === 'function' ? opts.getSelection : () => null;
    const pickFiles = typeof opts.pickFiles === 'function' ? opts.pickFiles : null;
    const showContextMenu = typeof opts.showContextMenu === 'function' ? opts.showContextMenu : null;
    const openPath = typeof opts.openPath === 'function' ? opts.openPath : () => {};
    const isFileDirty = typeof opts.isFileDirty === 'function' ? opts.isFileDirty : () => false;
    const onFileChanged = typeof opts.onFileChanged === 'function' ? opts.onFileChanged : () => {};
    const isMock = !!opts.isMock;
    const floatWindow = !!opts.floatWindow;
    const mockEmpty = !!opts.mockEmpty;
    const activityButton = opts.activityButton || null;
    const toolbarButton = opts.toolbarButton || null;

    const el = {
        head: panel.querySelector('#ai-head'),
        close: panel.querySelector('#ai-close'),
        changesBtn: panel.querySelector('#ai-changes'),
        changesCount: panel.querySelector('#ai-changes-count'),
        moreBtn: panel.querySelector('#ai-more'),
        changesPop: panel.querySelector('#ai-changes-pop'),
        modeSeg: panel.querySelector('#ai-mode-seg'),
        todos: panel.querySelector('#ai-todos'),
        messages: panel.querySelector('#ai-messages'),
        scrollBtn: panel.querySelector('#ai-scroll-btn'),
        slash: panel.querySelector('#ai-slash'),
        ctxBanner: panel.querySelector('#ai-ctx-banner'),
        ctxBannerText: panel.querySelector('#ai-ctx-banner-text'),
        ctxCompact: panel.querySelector('#ai-ctx-compact'),
        dialog: panel.querySelector('#ai-dialog'),
        dialogTitle: panel.querySelector('#ai-dialog-title'),
        dialogBody: panel.querySelector('#ai-dialog-body'),
        dialogFoot: panel.querySelector('#ai-dialog-foot'),
        dialogClose: panel.querySelector('#ai-dialog-close'),
        composer: panel.querySelector('.ai-composer'),
        queue: panel.querySelector('#ai-queue'),
        takeover: panel.querySelector('#ai-takeover'),
        attach: panel.querySelector('#ai-attach'),
        attachBtn: panel.querySelector('#ai-attach-btn'),
        permission: panel.querySelector('#ai-permission'),
        plan: panel.querySelector('#ai-plan'),
        modelChip: panel.querySelector('#ai-model-chip'),
        input: panel.querySelector('#ai-input'),
        hint: panel.querySelector('#ai-hint'),
        send: panel.querySelector('#ai-send'),
        stop: panel.querySelector('#ai-stop'),
        statsWrap: panel.querySelector('.ai-stats-wrap'),
        stats: panel.querySelector('#ai-stats'),
        statsTurns: panel.querySelector('#ai-stats-turns'),
        statsSpeed: panel.querySelector('#ai-stats-speed'),
        statsTotal: panel.querySelector('#ai-stats-total'),
        statsCache: panel.querySelector('#ai-stats-cache'),
        statsSessionBtn: panel.querySelector('#ai-stats-session'),
        statsTokenBtn: panel.querySelector('#ai-stats-token'),
        statsSep: panel.querySelector('#ai-stats-sep'),
        sessionPop: panel.querySelector('#ai-session-pop'),
        sessionPopTurns: panel.querySelector('#ai-session-pop-turns'),
        sessionModel: panel.querySelector('#ai-session-model'),
        sessionTools: panel.querySelector('#ai-session-tools'),
        sessionTtft: panel.querySelector('#ai-session-ttft'),
        sessionTps: panel.querySelector('#ai-session-tps'),
        tokenPop: panel.querySelector('#ai-token-pop'),
        tokenPopTotal: panel.querySelector('#ai-token-pop-total'),
        tokenHit: panel.querySelector('#ai-token-hit'),
        tokenUncached: panel.querySelector('#ai-token-uncached'),
        tokenCached: panel.querySelector('#ai-token-cached'),
        tokenOutput: panel.querySelector('#ai-token-output'),
        ctxBtn: panel.querySelector('#ai-ctx-btn'),
        ctxRing: panel.querySelector('#ai-ctx-ring'),
        statsCtxPct: panel.querySelector('#ai-stats-ctx-pct'),
        ctxPop: panel.querySelector('#ai-ctx-pop'),
        ctxPopPct: panel.querySelector('#ai-ctx-pop-pct'),
        ctxPopSize: panel.querySelector('#ai-ctx-pop-size'),
        ctxSegSystem: panel.querySelector('#ai-ctx-seg-system'),
        ctxSegTools: panel.querySelector('#ai-ctx-seg-tools'),
        ctxSegMessages: panel.querySelector('#ai-ctx-seg-messages'),
        ctxTokSystem: panel.querySelector('#ai-ctx-tok-system'),
        ctxTokTools: panel.querySelector('#ai-ctx-tok-tools'),
        ctxTokMessages: panel.querySelector('#ai-ctx-tok-messages'),
        ctxPopCompact: panel.querySelector('#ai-ctx-pop-compact'),
    };

    const sessionListEl = document.getElementById('ai-session-list');
    const sessionNewBtn = document.getElementById('ai-session-new');
    const sessionMoreBtn = document.getElementById('ai-session-more');

    const opt = {
        profile: document.getElementById('ai-opt-profile'),
        modelList: document.getElementById('ai-model-list'),
        modelCreate: document.getElementById('ai-model-create'),
        modelEditorMask: document.getElementById('dlg-model-editor-mask'),
        modelEditor: document.getElementById('dlg-model-editor'),
        modelTitle: document.getElementById('dlg-model-title'),
        modelEditorClose: document.getElementById('ai-model-editor-close'),
        modelEditorCancel: document.getElementById('ai-model-editor-cancel'),
        modelEditorSave: document.getElementById('ai-model-editor-save'),
        preset: document.getElementById('ai-opt-preset'),
        presetAdd: document.getElementById('ai-opt-preset-add'),
        add: document.getElementById('ai-opt-add'),
        dup: document.getElementById('ai-opt-dup'),
        del: document.getElementById('ai-opt-del'),
        name: document.getElementById('ai-opt-name'),
        provider: document.getElementById('ai-opt-provider'),
        baseURL: document.getElementById('ai-opt-baseurl'),
        apiKey: document.getElementById('ai-opt-apikey'),
        keyToggle: document.getElementById('ai-opt-key-toggle'),
        model: document.getElementById('ai-opt-model'),
        models: document.getElementById('ai-opt-models'),
        temp: document.getElementById('ai-opt-temp'),
        tempVal: document.getElementById('ai-opt-temp-val'),
        maxTokens: document.getElementById('ai-opt-maxtokens'),
        reasoningGroup: document.getElementById('ai-opt-reasoning-group'),
        reasoning: document.getElementById('ai-opt-reasoning'),
        thinkingGroup: document.getElementById('ai-opt-thinking-group'),
        thinking: document.getElementById('ai-opt-thinking'),
        budget: document.getElementById('ai-opt-budget'),
        contextWindow: document.getElementById('ai-opt-context'),
        test: document.getElementById('ai-opt-test'),
        status: document.getElementById('ai-opt-status'),
        dir: document.getElementById('ai-opt-dir'),
        proxy: document.getElementById('ai-opt-proxy'),
        proxyURL: document.getElementById('ai-opt-proxy-url'),
        headers: document.getElementById('ai-opt-headers'),
        memoryMode: document.getElementById('ai-opt-memory-mode'),
        memoryPath: document.getElementById('ai-opt-memory-path'),
        threshold: document.getElementById('ai-opt-threshold'),
        openMemory: document.getElementById('ai-opt-open-memory'),
        openSkills: document.getElementById('ai-opt-open-skills'),
        injectContext: document.getElementById('ai-opt-inject-context'),
        injectAgents: document.getElementById('ai-opt-inject-agents'),
        sendKey: document.getElementById('ai-opt-sendkey'),
        chatFont: document.getElementById('ai-opt-chatfont'),
        chatFontVal: document.getElementById('ai-opt-chatfont-val'),
        chatFontEn: document.getElementById('ai-opt-chatfont-en'),
        chatFontCjk: document.getElementById('ai-opt-chatfont-cjk'),
        chatFontCode: document.getElementById('ai-opt-chatfont-code'),
        showThinking: document.getElementById('ai-opt-show-thinking'),
        showUsage: document.getElementById('ai-opt-show-usage'),
        assistantCard: document.getElementById('ai-opt-assistant-card'),
        maxSessions: document.getElementById('ai-opt-maxsessions'),
        logEnabled: document.getElementById('ai-opt-log-enabled'),
        notifyInApp: document.getElementById('ai-opt-notify-inapp'),
        notifySystem: document.getElementById('ai-opt-notify-system'),
        notifyFinish: document.getElementById('ai-opt-notify-finish'),
        notifyError: document.getElementById('ai-opt-notify-error'),
        notifyAsk: document.getElementById('ai-opt-notify-ask'),
        notifySound: document.getElementById('ai-opt-notify-sound'),
        askTimeout: document.getElementById('ai-opt-ask-timeout'),
        askTimeoutAction: document.getElementById('ai-opt-ask-action'),
        logPath: document.getElementById('ai-opt-log-path'),
        openLogs: document.getElementById('ai-opt-open-logs'),
        prompt: document.getElementById('ai-opt-prompt'),
        promptText: document.getElementById('ai-opt-prompt-text'),
        promptSave: document.getElementById('ai-opt-prompt-save'),
        promptNew: document.getElementById('ai-opt-prompt-new'),
        promptDel: document.getElementById('ai-opt-prompt-del'),
        promptDefault: document.getElementById('ai-opt-prompt-default'),
        exportKeys: document.getElementById('ai-opt-export-keys'),
        exportBtn: document.getElementById('ai-opt-export'),
        importBtn: document.getElementById('ai-opt-import'),
        clearSessions: document.getElementById('ai-opt-clear-sessions'),
        approved: document.getElementById('ai-opt-approved'),
        approvedClear: document.getElementById('ai-opt-approved-clear'),
    };

    let config = loadAIConfig();
    let sessions = loadAISessions();
    let stream = null;
    let oneShot = null;
    let compactSeq = 0;
    let modelEditorState = null;
    let mode = floatWindow ? 'dock' : normalizeFloatMode(settings.aiFloatMode);
    let stickBottom = true;
    let processFoldState = new Map();
    const thinkFoldState = new Map();
    // 消息懒加载：每会话记录当前渲染窗口起点；首屏至少覆盖约 1M tokens 上下文，上滑触顶再往前补。
    const renderWindows = new Map();
    const AI_RENDER_INITIAL_TOKENS = 1000000;
    const AI_RENDER_STEP_TOKENS = 250000;
    let loadingEarlier = false;
    let processTicker = 0;
    let pendingEdit = null;
    let attachments = [];
    let attachSeq = 0;
    let appDirPromise = null;
    let memoryFallbackNotified = false;
    let logSaveErrorShown = false;
    let lastSystemPrompt = AI_DEFAULT_SYSTEM_PROMPT;
    let lastContextMeta = null;
    let drag = null;
    let settingsStatusTimer = 0;
    let fontSaveTimer = 0;
    let lastApplied = {font: 0, thinking: null, usage: null};
    let slashState = {open: false, index: 0, items: []};
    let noteSeq = 0;
    const pendingApprovals = new Map();
    const pendingAsks = new Map();
    const askDrafts = new Map();
    const todoStates = new Map();
    let archivedExpanded = false;
    let dismissedPlanApproval = '';
    const messageQueue = [];
    let queueSeq = 0;
    let interjectPending = false;

    // ---------- 配置与会话持久化 ----------

    function defaultProfile() {
        return {
            id: aiNowId('profile-'),
            name: '配置',
            provider: 'openai',
            baseURL: '',
            apiKey: '',
            model: '',
            temperature: 0.7,
            maxTokens: 4096,
            thinking: false,
            thinkingBudget: 8000,
            reasoningEffort: '',
            contextWindow: 128000,
            proxy: '',
            extraHeaders: {},
        };
    }

    function normalizeProfile(raw, index) {
        if (!raw || typeof raw !== 'object') return null;
        return {
            id: aiTextOf(raw.id) || aiNowId('profile-'),
            name: aiTextOf(raw.name) || ('配置 ' + (index + 1)),
            provider: raw.provider === 'anthropic' ? 'anthropic' : 'openai',
            baseURL: aiTextOf(raw.baseURL),
            apiKey: aiTextOf(raw.apiKey),
            model: aiTextOf(raw.model),
            temperature: aiClamp(Number(raw.temperature) || 0, 0, 2),
            maxTokens: aiClampInt(raw.maxTokens, 1, 393216, 4096),
            thinking: raw.thinking === true,
            thinkingBudget: aiClampInt(raw.thinkingBudget, 1024, 393215, 8000),
            reasoningEffort: ['low', 'medium', 'high'].includes(raw.reasoningEffort) ? raw.reasoningEffort : '',
            contextWindow: aiClampInt(raw.contextWindow, 2048, 1048576, 128000),
            proxy: aiTextOf(raw.proxy),
            extraHeaders: raw.extraHeaders && typeof raw.extraHeaders === 'object' ? raw.extraHeaders : {},
        };
    }

    function loadAIConfig() {
        let stored = {};
        try {
            stored = JSON.parse(localStorage.getItem(AI_CONFIG_KEY) || '{}') || {};
        } catch (e) {
            stored = {};
        }
        const out = {
            profiles: [],
            activeProfileId: '',
            activeSessionId: aiTextOf(stored.activeSessionId),
            memoryMode: stored.memoryMode === 'app' ? 'app' : 'workspace',
            approvedPaths: Array.isArray(stored.approvedPaths) ? stored.approvedPaths : [],
            disabledSkills: Array.isArray(stored.disabledSkills) ? stored.disabledSkills : [],
            prompts: [],
            activePromptId: aiTextOf(stored.activePromptId),
            autoCompactThreshold: aiClamp(Number(stored.autoCompactThreshold) || 0.8, 0.5, 0.95),
            logEnabled: stored.logEnabled !== false,
            notifyInApp: stored.notifyInApp !== false,
            notifySystem: stored.notifySystem === true,
            notifyFinish: stored.notifyFinish !== false,
            notifyError: stored.notifyError !== false,
            notifyAsk: stored.notifyAsk !== false,
            notifySound: stored.notifySound !== false,
            askTimeout: aiClampInt(stored.askTimeout, 0, 3600, 300),
            askTimeoutAction: ['recommended', 'wait', 'abort', 'ai_decide'].includes(stored.askTimeoutAction)
                ? stored.askTimeoutAction
                : 'recommended',
        };
        if (Array.isArray(stored.prompts)) {
            stored.prompts.forEach((raw, index) => {
                if (!raw || typeof raw !== 'object') return;
                const id = aiTextOf(raw.id);
                const content = aiTextOf(raw.content);
                if (!id || !content.trim()) return;
                out.prompts.push({
                    id,
                    name: aiTextOf(raw.name) || ('模板 ' + (index + 1)),
                    content,
                    builtin: !!raw.builtin,
                });
            });
        }
        for (const builtin of AI_BUILTIN_PROMPTS) {
            const existing = out.prompts.find((prompt) => prompt.id === builtin.id);
            if (existing) {
                existing.builtin = true;
                if (!existing.name) existing.name = builtin.name;
            } else {
                out.prompts.push({...builtin});
            }
        }
        if (!out.prompts.some((prompt) => prompt.id === out.activePromptId)) {
            out.activePromptId = out.prompts[0] ? out.prompts[0].id : '';
        }
        if (Array.isArray(stored.profiles)) {
            const seen = new Set();
            stored.profiles.forEach((raw, index) => {
                const profile = normalizeProfile(raw, index);
                if (!profile) return;
                let id = profile.id;
                let suffix = 2;
                while (seen.has(id)) id = profile.id + '-' + suffix++;
                profile.id = id;
                seen.add(id);
                out.profiles.push(profile);
            });
        }
        // 浏览器 dev mock 下给一个可点开即用的演示配置；真实应用首次运行保持空态。
        if (isMock && !mockEmpty && !out.profiles.length) {
            out.profiles.push(normalizeProfile({
                id: 'mock-demo',
                name: '演示配置',
                provider: 'openai',
                baseURL: 'https://api.deepseek.com/v1',
                apiKey: '',
                model: 'deepseek-flash',
                temperature: 0.7,
                maxTokens: 4096,
                contextWindow: 1048576,
            }, 0));
        }
        if (!out.profiles.some((p) => p.id === out.activeProfileId)) {
            out.activeProfileId = out.profiles.length ? out.profiles[0].id : '';
        }
        return out;
    }

    function saveAIConfig() {
        try {
            localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(config));
        } catch (e) {}
    }

    function normalizeApproval(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const state = ['pending', 'approved', 'denied', 'cancelled', 'failed'].includes(raw.state) ? raw.state : 'cancelled';
        const kind = raw.kind === 'command' ? 'command' : 'file';
        return {
            state,
            kind,
            error: aiTextOf(raw.error),
            command: aiTextOf(raw.command).slice(0, 8000),
            cwd: aiTextOf(raw.cwd),
            tool: kind === 'command' ? 'run_command' : (raw.tool === 'edit_file' ? 'edit_file' : 'write_file'),
            path: aiTextOf(raw.path),
            relPath: aiTextOf(raw.relPath),
            added: Math.max(0, Number(raw.added) || 0),
            removed: Math.max(0, Number(raw.removed) || 0),
            newFile: !!raw.newFile,
            dirty: !!raw.dirty,
            truncated: !!raw.truncated,
            diff: Array.isArray(raw.diff)
                ? raw.diff.map((line) => ({
                    t: line && ['+', '-', '…'].includes(line.t) ? line.t : ' ',
                    text: aiTextOf(line && line.text),
                })).slice(0, AI_DIFF_PREVIEW_LIMIT + 8)
                : [],
            remember: ['session', 'always'].includes(raw.remember) ? raw.remember : '',
        };
    }

    function parseAskQuestions(input) {
        if (!input || typeof input !== 'object') return [];
        const source = Array.isArray(input.questions)
            ? input.questions
            : (input.question ? [{
                id: 'q1',
                question: input.question,
                options: input.options,
                allow_custom: input.allow_custom,
            }] : []);
        const questions = [];
        const usedIds = new Set();
        source.slice(0, 5).forEach((raw, index) => {
            if (!raw || typeof raw !== 'object') return;
            const question = aiTextOf(raw.question).trim().slice(0, 1000);
            if (!question) return;
            let id = aiTextOf(raw.id).trim().slice(0, 64) || ('q' + (index + 1));
            while (usedIds.has(id)) id = id + '-' + (index + 1);
            usedIds.add(id);
            const options = (Array.isArray(raw.options) ? raw.options : [])
                .map((option) => ({
                    label: aiTextOf(option && option.label).trim().slice(0, 160),
                    description: aiTextOf(option && option.description).trim().slice(0, 300),
                    recommended: !!(option && option.recommended),
                }))
                .filter((option) => option.label)
                .slice(0, 8);
            const allowCustom = raw.allow_custom !== false && raw.allowCustom !== false;
            if (!options.length && !allowCustom) return;
            questions.push({
                id,
                question,
                header: aiTextOf(raw.header).trim().slice(0, 80),
                detail: aiTextOf(raw.detail).trim().slice(0, 500),
                options,
                multiSelect: raw.multiSelect === true || raw.multi_select === true,
                allowCustom,
            });
        });
        return questions;
    }

    function normalizeAsk(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const questions = parseAskQuestions(raw);
        if (!questions.length) return null;
        const answersRaw = Array.isArray(raw.answers) ? raw.answers : [];
        const answers = questions.map((question, index) => {
            const found = answersRaw.find((answer) => answer && aiTextOf(answer.id) === question.id) || answersRaw[index];
            let selected = Array.isArray(found && found.selected)
                ? found.selected.map((label) => aiTextOf(label)).filter((label) => question.options.some((option) => option.label === label))
                : [];
            selected = [...new Set(selected)];
            if (!question.multiSelect) selected = selected.slice(0, 1);
            let custom = aiTextOf(found && found.custom).slice(0, 500);
            // 兼容旧版单问题记录：raw.answer 是选项标签或自定义文本。
            if (raw.answer && index === 0 && !selected.length && !custom) {
                const legacy = aiTextOf(raw.answer);
                if (question.options.some((option) => option.label === legacy)) selected = [legacy];
                else if (legacy) custom = legacy.slice(0, 500);
            }
            return {id: question.id, selected, custom};
        });
        const states = ['pending', 'answered', 'timeout', 'timeout_abort', 'cancelled', 'expired'];
        return {
            questions,
            answers,
            state: states.includes(raw.state) ? raw.state : 'cancelled',
            answer: aiTextOf(raw.answer).slice(0, 1000),
            source: aiTextOf(raw.source),
            deadline: Number(raw.deadline) || 0,
            answeredAt: Number(raw.answeredAt) || 0,
            timeoutSec: Math.max(0, Number(raw.timeoutSec) || 0),
            timeoutAction: ['recommended', 'wait', 'abort', 'ai_decide'].includes(raw.timeoutAction)
                ? raw.timeoutAction
                : 'recommended',
        };
    }

    function normalizeTodos(raw) {
        if (!Array.isArray(raw)) return [];
        const list = [];
        for (const item of raw.slice(0, AI_TODO_LIMIT)) {
            if (!item || typeof item !== 'object') continue;
            const content = aiTextOf(item.content).replace(/\s+/g, ' ').trim().slice(0, 200);
            if (!content) continue;
            const status = ['pending', 'in_progress', 'completed'].includes(item.status) ? item.status : 'pending';
            list.push({content, status});
        }
        return list;
    }

    function normalizeChange(raw) {
        if (!raw || typeof raw !== 'object' || !raw.path) return null;
        return {
            path: aiTextOf(raw.path),
            relPath: aiTextOf(raw.relPath) || aiTextOf(raw.path),
            tool: raw.tool === 'edit_file' ? 'edit_file' : 'write_file',
            added: Math.max(0, Number(raw.added) || 0),
            removed: Math.max(0, Number(raw.removed) || 0),
            time: Number(raw.time) || Date.now(),
        };
    }

    function normalizeMessage(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const role = ['user', 'assistant', 'tool'].includes(raw.role) ? raw.role : '';
        if (!role) return null;
        const message = {
            role,
            content: aiTextOf(raw.content),
            ts: Number(raw.ts) || Date.now(),
        };
        if (role === 'user') {
            message.turnStartedAt = Number(raw.turnStartedAt) || 0;
            message.images = Array.isArray(raw.images)
                ? raw.images.map(aiNormalizeImage).filter(Boolean).slice(0, AI_IMAGE_LIMIT)
                : [];
        }
        if (role === 'tool') {
            message.toolCallId = aiTextOf(raw.toolCallId);
            message.name = aiTextOf(raw.name);
            message.arguments = aiTextOf(raw.arguments);
            message.status = ['running', 'pending', 'done', 'error'].includes(raw.status) ? raw.status : 'done';
            message.approval = normalizeApproval(raw.approval);
            if (message.approval && message.approval.state === 'pending') {
                message.approval.state = 'cancelled';
                message.status = 'done';
                if (!message.content) message.content = '审批已取消（会话重新加载）';
            }
            message.ask = normalizeAsk(raw.ask);
            if (message.ask && message.ask.state === 'pending') {
                message.ask.state = 'expired';
                message.ask.answeredAt = Date.now();
                message.status = 'done';
                if (!message.content) message.content = '用户未回答（页面已关闭）';
            } else if (raw.ask && !message.ask && message.status === 'pending') {
                message.status = 'done';
                if (!message.content) message.content = '问题数据无效，已取消';
            }
            return message;
        }
        if (role === 'assistant') {
            message.reasoning = aiTextOf(raw.reasoning);
            message.thinkingSignature = aiTextOf(raw.thinkingSignature);
            message.model = aiTextOf(raw.model);
            message.planMode = raw.planMode === true;
            message.thinkMs = Number(raw.thinkMs) || 0;
            message.finishedAt = Number(raw.finishedAt) || 0;
            message.turnMs = Math.max(0, Number(raw.turnMs) || 0);
            message.status = ['done', 'stopped', 'error', 'streaming'].includes(raw.status) ? raw.status : 'done';
            if (message.status === 'streaming') message.status = 'done';
            message.error = aiTextOf(raw.error);
            message.toolCalls = Array.isArray(raw.toolCalls)
                ? raw.toolCalls.map((call) => ({
                    id: aiTextOf(call && call.id),
                    name: aiTextOf(call && call.name),
                    arguments: aiTextOf(call && call.arguments),
                })).filter((call) => call.id && call.name)
                : [];
            message.usage = raw.usage && typeof raw.usage === 'object'
                ? {
                    promptTokens: Number(raw.usage.promptTokens) || 0,
                    completionTokens: Number(raw.usage.completionTokens) || 0,
                    totalTokens: Number(raw.usage.totalTokens) || 0,
                    cachedTokens: Number(raw.usage.cachedTokens) || 0,
                }
                : null;
            if (message.status === 'done' && !message.content && !message.reasoning && !message.toolCalls.length) return null;
        }
        return message;
    }

    function normalizeSession(raw, index) {
        if (!raw || typeof raw !== 'object') return null;
        const messages = Array.isArray(raw.messages)
            ? raw.messages.map(normalizeMessage).filter(Boolean)
            : [];
        return {
            id: aiTextOf(raw.id) || aiNowId('session-'),
            title: aiTextOf(raw.title) || ('会话 ' + (index + 1)),
            createdAt: Number(raw.createdAt) || Date.now(),
            scope: ['read', 'edit', 'full'].includes(raw.scope) ? raw.scope : 'read',
            profileId: aiTextOf(raw.profileId),
            systemPrompt: aiTextOf(raw.systemPrompt),
            promptTemplateId: aiTextOf(raw.promptTemplateId),
            messages: messages.slice(-AI_MESSAGE_LIMIT),
            summary: raw.summary && typeof raw.summary === 'object' ? raw.summary : null,
            archived: Array.isArray(raw.archived) ? raw.archived : [],
            archivedAt: Number(raw.archivedAt) || 0,
            planMode: raw.planMode === true,
            round: Number(raw.round) || 0,
            logFile: aiTextOf(raw.logFile),
            logSavedAt: Number(raw.logSavedAt) || 0,
            todos: normalizeTodos(raw.todos),
            changes: Array.isArray(raw.changes)
                ? raw.changes.map(normalizeChange).filter(Boolean).slice(-AI_CHANGES_LIMIT)
                : [],
            approvedPaths: Array.isArray(raw.approvedPaths)
                ? raw.approvedPaths.filter((path) => typeof path === 'string' && path).slice(0, 200)
                : [],
        };
    }

    function createSessionData(title) {
        return {
            id: aiNowId('session-'),
            title: title || '新会话',
            createdAt: Date.now(),
            scope: 'read',
            profileId: '',
            systemPrompt: '',
            promptTemplateId: '',
            messages: [],
            summary: null,
            archived: [],
            archivedAt: 0,
            planMode: false,
            round: 0,
            todos: [],
            changes: [],
            approvedPaths: [],
        };
    }

    function maxSessions() {
        return aiClampInt(settings.aiMaxSessions, 2, 500, 50);
    }

    function loadAISessions() {
        let raw = [];
        try {
            raw = JSON.parse(localStorage.getItem(AI_SESSIONS_KEY) || '[]');
        } catch (e) {
            raw = [];
        }
        const out = [];
        const seen = new Set();
        if (Array.isArray(raw)) {
            raw.forEach((item, index) => {
                const session = normalizeSession(item, index);
                if (!session) return;
                let id = session.id;
                let suffix = 2;
                while (seen.has(id)) id = session.id + '-' + suffix++;
                session.id = id;
                seen.add(id);
                out.push(session);
            });
        }
        while (out.length > maxSessions()) {
            const index = out.findIndex((session) => !session.archivedAt);
            out.splice(index >= 0 ? index : 0, 1);
        }
        if (!out.length) out.push(createSessionData());
        return out;
    }

    function sessionImageBytes(images) {
        let bytes = 0;
        for (const image of images || []) bytes += image && image.data ? image.data.length : 0;
        return bytes;
    }

    function sessionImageEntries() {
        const entries = [];
        for (const session of sessions) {
            const lists = [session.messages, Array.isArray(session.archived) ? session.archived : []];
            for (const list of lists) {
                for (const message of list) {
                    if (!message || !Array.isArray(message.images) || !message.images.length) continue;
                    if (!message.images.some((image) => image && image.data)) continue;
                    entries.push({
                        message,
                        ts: Number(message.ts) || 0,
                        bytes: sessionImageBytes(message.images),
                    });
                }
            }
        }
        entries.sort((a, b) => b.ts - a.ts);
        return entries;
    }

    function stripImageData(message) {
        message.images = (message.images || []).map((image) => {
            if (!image || !image.data) return image;
            if (!image.logFile) return null;
            return {...image, data: ''};
        }).filter(Boolean);
    }

    function trimSessionImagesForStorage() {
        const entries = sessionImageEntries();
        let used = 0;
        for (const entry of entries) {
            if (used === 0 || used + entry.bytes <= AI_IMAGE_STORAGE_BUDGET) {
                used += entry.bytes;
                continue;
            }
            stripImageData(entry.message);
        }
    }

    function stripSessionImages(keepNewest) {
        sessionImageEntries().forEach((entry, index) => {
            if (!keepNewest || index > 0) {
                stripImageData(entry.message);
            }
        });
    }

    function persistSessions() {
        while (sessions.length > maxSessions()) {
            let index = sessions.findIndex((session) => !session.archivedAt);
            if (index < 0) index = 0;
            const removed = sessions.splice(index, 1)[0];
            if (removed && removed.id === config.activeSessionId) {
                config.activeSessionId = sessions.length ? sessions[0].id : '';
            }
        }
        for (const session of sessions) {
            if (session.messages.length > AI_MESSAGE_LIMIT) {
                session.messages = session.messages.slice(-AI_MESSAGE_LIMIT);
            }
        }
        trimSessionImagesForStorage();
        const save = () => {
            localStorage.setItem(AI_SESSIONS_KEY, JSON.stringify(sessions));
        };
        try {
            save();
        } catch (e) {
            try {
                stripSessionImages(true);
                save();
            } catch (e2) {
                try {
                    stripSessionImages(false);
                    save();
                } catch (e3) {}
            }
        }
        saveAIConfig();
    }

    function currentSession() {
        return sessions.find((s) => s.id === config.activeSessionId) || sessions[0] || null;
    }

    function activeProfile() {
        const found = config.profiles.find((p) => p.id === config.activeProfileId);
        return found || config.profiles[0] || null;
    }

    function providerLabel(profile) {
        return profile && profile.provider === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容';
    }

    function promptById(id) {
        return config.prompts.find((prompt) => prompt.id === id) || null;
    }

    function effectiveSystemPrompt(session) {
        const own = aiTextOf(session && session.systemPrompt).trim();
        if (own) return own;
        const bySession = promptById(session && session.promptTemplateId);
        if (bySession && bySession.content.trim()) return bySession.content;
        const active = promptById(config.activePromptId);
        if (active && active.content.trim()) return active.content;
        return AI_DEFAULT_SYSTEM_PROMPT;
    }

    function configForProfile(profile) {
        return {
            provider: profile.provider,
            baseURL: profile.baseURL,
            apiKey: profile.apiKey,
            model: profile.model,
            temperature: profile.temperature,
            maxTokens: profile.maxTokens,
            proxy: profile.proxy || '',
            extraHeaders: profile.extraHeaders || {},
            thinking: profile.provider === 'anthropic' && profile.thinking === true,
            thinkingBudget: aiClampInt(profile.thinkingBudget, 1024, 393215, 8000),
            reasoningEffort: profile.provider === 'anthropic' ? '' : (profile.reasoningEffort || ''),
        };
    }

    function updateSessionTitleFromText(session, text) {
        if (session.title && session.title !== '新会话' && session.title !== '会话') return;
        const title = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 24);
        if (title) session.title = title;
    }

    // ---------- 面板基础渲染 ----------

    function isOpen() {
        return !panel.classList.contains('hidden');
    }

    function ensureOpen() {
        if (!isOpen()) open(true);
    }

    function updateEntryButtons() {
        const open = isOpen();
        for (const button of [activityButton, toolbarButton]) {
            if (!button) continue;
            button.classList.toggle('active', open);
            button.setAttribute('aria-pressed', String(open));
        }
    }

    function renderProfileSelect() {
        renderModelChip();
        const active = activeProfile();
        if (opt.profile) {
            opt.profile.innerHTML = '';
            if (!config.profiles.length) {
                const option = document.createElement('option');
                option.value = '';
                option.textContent = '（未配置）';
                opt.profile.appendChild(option);
            } else {
                for (const profile of config.profiles) {
                    const option = document.createElement('option');
                    option.value = profile.id;
                    option.textContent = profile.name;
                    optSelect(opt.profile, option);
                }
            }
            opt.profile.value = active ? active.id : '';
        }
    }

    function optSelect(select, option) {
        select.appendChild(option);
    }

    function sessionActivity(session) {
        const last = session.messages[session.messages.length - 1];
        return Number(last && last.ts) || Number(session.createdAt) || 0;
    }

    function renderSessionList() {
        if (!sessionListEl) return;
        const scrollTop = sessionListEl.scrollTop;
        sessionListEl.innerHTML = '';
        const current = currentSession();
        const ordered = sessions.slice().sort((a, b) => sessionActivity(b) - sessionActivity(a));
        if (!ordered.length) {
            const empty = document.createElement('div');
            empty.className = 'ai-session-empty';
            const text = document.createElement('div');
            text.textContent = '还没有会话';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'dlg-btn';
            button.textContent = '新建会话';
            button.addEventListener('click', () => {
                ensureOpen();
                newSession();
            });
            empty.append(text, button);
            sessionListEl.appendChild(empty);
            return;
        }

        const renderItem = (session, archived) => {
            const item = document.createElement('div');
            item.className = 'ai-session-item' + (current && current.id === session.id ? ' active' : '') + (archived ? ' archived' : '');
            item.dataset.aiSessionId = session.id;
            item.tabIndex = 0;
            item.setAttribute('role', 'button');
            const main = document.createElement('div');
            main.className = 'ai-session-main';
            const title = document.createElement('div');
            title.className = 'ai-session-title';
            title.textContent = session.title || '新会话';
            title.title = session.title || '新会话';
            const meta = document.createElement('div');
            meta.className = 'ai-session-meta';
            meta.textContent = (archived ? '已归档 · ' : '') + session.messages.length + ' 条消息 · ' + aiFormatSessionTime(sessionActivity(session));
            main.append(title, meta);
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'ai-session-more';
            more.title = '会话操作';
            more.textContent = '⋯';
            more.addEventListener('click', (e) => {
                e.stopPropagation();
                const rect = more.getBoundingClientRect();
                showSessionMenu(session, rect.left, rect.bottom + 4);
            });
            item.append(main, more);
            item.addEventListener('click', () => {
                ensureOpen();
                if (!current || current.id !== session.id) switchSession(session.id);
            });
            item.addEventListener('keydown', (e) => {
                if (e.target !== item) return;
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                ensureOpen();
                switchSession(session.id);
            });
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                showSessionMenu(session, e.clientX, e.clientY);
            });
            sessionListEl.appendChild(item);
        };

        const activeList = ordered.filter((session) => !session.archivedAt);
        const archivedList = ordered.filter((session) => session.archivedAt);
        for (const session of activeList) renderItem(session, false);
        if (!activeList.length) {
            const empty = document.createElement('div');
            empty.className = 'ai-session-archive-empty';
            empty.textContent = '没有进行中的会话';
            sessionListEl.appendChild(empty);
        }
        if (archivedList.length) {
            const head = document.createElement('button');
            head.type = 'button';
            head.className = 'ai-session-arch-head' + (archivedExpanded ? ' expanded' : '');
            head.setAttribute('aria-expanded', String(archivedExpanded));
            const chev = document.createElement('span');
            chev.className = 'ai-session-arch-chev';
            chev.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            const label = document.createElement('span');
            label.textContent = '已归档 ' + archivedList.length;
            head.append(chev, label);
            head.addEventListener('click', () => {
                archivedExpanded = !archivedExpanded;
                renderSessionList();
            });
            sessionListEl.appendChild(head);
            if (archivedExpanded) {
                for (const session of archivedList) renderItem(session, true);
            }
        }
        sessionListEl.scrollTop = scrollTop;
    }

    function showSessionMenu(session, x, y) {
        if (!showContextMenu) return;
        showContextMenu([
            {label: '新建会话', action: () => { ensureOpen(); newSession(); }},
            {sep: true},
            {label: '重命名会话…', action: () => renameSession(session)},
            {label: '导出会话…', action: () => exportSession(session)},
            {label: session.archivedAt ? '取消归档' : '归档会话', action: () => archiveSession(session, !session.archivedAt)},
            {sep: true},
            {label: '删除会话', danger: true, action: () => deleteSession(session)},
        ], x, y);
    }

    function showSessionListMenu() {
        if (!sessionMoreBtn || !showContextMenu) return;
        const rect = sessionMoreBtn.getBoundingClientRect();
        const session = currentSession();
        showContextMenu([
            {label: '新建会话', action: () => { ensureOpen(); newSession(); }},
            {sep: true},
            {label: '重命名当前会话…', disabled: !session, action: () => renameSession(session)},
            {label: '导出当前会话…', disabled: !session, action: () => exportSession(session)},
            {label: session && session.archivedAt ? '取消归档当前会话' : '归档当前会话', disabled: !session, action: () => archiveSession(session, !(session && session.archivedAt))},
            {sep: true},
            {label: '删除当前会话', danger: true, disabled: !session, action: () => deleteSession(session)},
            {sep: true},
            {label: '打开对话日志目录', action: openAILogDir},
        ], rect.left, rect.bottom + 4);
    }

    // ---------- Todolist / 变更记录 / 授权清单 ----------

    function todoStateOf(session) {
        let state = todoStates.get(session.id);
        if (!state) {
            state = {collapsed: false, userExpanded: false, timer: 0};
            todoStates.set(session.id, state);
        }
        return state;
    }

    function renderTodos() {
        if (!el.todos) return;
        const session = currentSession();
        const list = session && Array.isArray(session.todos) ? session.todos : [];
        if (!session || !list.length) {
            el.todos.classList.add('hidden');
            el.todos.innerHTML = '';
            return;
        }
        el.todos.classList.remove('hidden');
        const state = todoStateOf(session);
        const done = list.filter((todo) => todo.status === 'completed').length;
        const allDone = done === list.length;
        if (!allDone) {
            state.collapsed = false;
            state.userExpanded = false;
            if (state.timer) {
                clearTimeout(state.timer);
                state.timer = 0;
            }
        }
        el.todos.innerHTML = '';
        el.todos.classList.toggle('collapsed', state.collapsed);
        const head = document.createElement('button');
        head.type = 'button';
        head.className = 'ai-todos-head';
        const chev = document.createElement('span');
        chev.className = 'ai-todos-chev';
        chev.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        const label = document.createElement('span');
        label.className = 'ai-todos-label';
        label.textContent = allDone ? '任务完成（' + list.length + ' 项）' : '任务清单';
        const progress = document.createElement('span');
        progress.className = 'ai-todos-progress';
        progress.textContent = done + '/' + list.length;
        head.append(chev, label, progress);
        head.title = state.collapsed ? '展开任务清单' : '收起任务清单';
        head.addEventListener('click', () => {
            state.collapsed = !state.collapsed;
            state.userExpanded = true;
            if (state.collapsed && state.timer) {
                clearTimeout(state.timer);
                state.timer = 0;
            }
            renderTodos();
        });
        el.todos.appendChild(head);
        if (!state.collapsed) {
            const body = document.createElement('div');
            body.className = 'ai-todos-body';
            for (const todo of list) {
                const item = document.createElement('div');
                item.className = 'ai-todo-item ' + todo.status;
                const icon = document.createElement('span');
                icon.className = 'ai-todo-icon';
                icon.textContent = todo.status === 'completed' ? '✓' : (todo.status === 'in_progress' ? '▶' : '○');
                const text = document.createElement('span');
                text.className = 'ai-todo-text';
                text.textContent = todo.content;
                item.append(icon, text);
                body.appendChild(item);
            }
            el.todos.appendChild(body);
        }
        if (allDone && !state.collapsed && !state.userExpanded && !state.timer) {
            state.timer = setTimeout(() => {
                state.timer = 0;
                if (currentSession() && currentSession().id === session.id) {
                    state.collapsed = true;
                    renderTodos();
                }
            }, 3000);
        }
    }

    function updateChangesUI() {
        if (!el.changesBtn) return;
        const session = currentSession();
        const count = session && Array.isArray(session.changes) ? session.changes.length : 0;
        if (el.changesCount) el.changesCount.textContent = String(count);
        el.changesBtn.classList.toggle('hidden', count === 0);
        el.changesBtn.title = count ? '本会话变更记录（' + count + '）' : '本会话暂无变更';
        if (!count) hideChangesPopover();
        else if (el.changesPop && !el.changesPop.classList.contains('hidden')) renderChangesPopover();
    }

    function renderChangesPopover() {
        if (!el.changesPop) return;
        const session = currentSession();
        el.changesPop.innerHTML = '';
        if (!session || !session.changes.length) {
            el.changesPop.classList.add('hidden');
            return;
        }
        const title = document.createElement('div');
        title.className = 'ai-pop-title';
        title.textContent = '变更记录（' + session.changes.length + '）';
        el.changesPop.appendChild(title);
        const list = document.createElement('div');
        list.className = 'ai-pop-list';
        for (const change of session.changes.slice().reverse()) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'ai-change-row';
            row.title = '打开 ' + change.path;
            const path = document.createElement('span');
            path.className = 'ai-change-path';
            path.textContent = change.relPath || change.path;
            const stat = document.createElement('span');
            stat.className = 'ai-change-stat';
            const add = document.createElement('span');
            add.className = 'add';
            add.textContent = '+' + change.added;
            const del = document.createElement('span');
            del.className = 'del';
            del.textContent = '−' + change.removed;
            stat.append(add, del);
            const time = document.createElement('span');
            time.className = 'ai-change-time';
            time.textContent = aiFormatTime(change.time);
            row.append(path, stat, time);
            row.addEventListener('click', () => {
                hideChangesPopover();
                try {
                    openPath(change.path);
                } catch (e) {}
            });
            list.appendChild(row);
        }
        el.changesPop.appendChild(list);
    }

    function showChangesPopover() {
        if (!el.changesPop || !el.changesBtn) return;
        renderChangesPopover();
        if (!currentSession() || !currentSession().changes.length) return;
        el.changesPop.classList.remove('hidden');
        const panelRect = panel.getBoundingClientRect();
        const btnRect = el.changesBtn.getBoundingClientRect();
        const width = 260;
        let left = btnRect.right - panelRect.left - width;
        left = Math.max(8, Math.min(left, panel.clientWidth - width - 8));
        el.changesPop.style.left = left + 'px';
        el.changesPop.style.top = (btnRect.bottom - panelRect.top + 6) + 'px';
    }

    function hideChangesPopover() {
        if (el.changesPop) el.changesPop.classList.add('hidden');
    }

    function renderApprovedSettings() {
        if (!opt.approved) return;
        opt.approved.innerHTML = '';
        const paths = config.approvedPaths || [];
        if (!paths.length) {
            const empty = document.createElement('span');
            empty.className = 'ai-approved-empty';
            empty.textContent = '（无，所有写操作每次询问）';
            opt.approved.appendChild(empty);
        } else {
            for (const path of paths) {
                const row = document.createElement('div');
                row.className = 'ai-approved-row';
                const text = document.createElement('span');
                text.className = 'ai-approved-path';
                text.textContent = path;
                text.title = path;
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'ai-approved-remove';
                remove.title = '移除授权';
                remove.textContent = '×';
                remove.addEventListener('click', () => {
                    config.approvedPaths = config.approvedPaths.filter((item) => aiPathKey(item) !== aiPathKey(path));
                    saveAIConfig();
                    renderApprovedSettings();
                    flash('已移除授权：' + path);
                });
                row.append(text, remove);
                opt.approved.appendChild(row);
            }
        }
        if (opt.approvedClear) opt.approvedClear.disabled = !(config.approvedPaths || []).length;
    }

    function emptyState(kind) {
        const box = document.createElement('div');
        box.className = 'ai-empty';
        if (kind === 'no-profile') {
            const title = document.createElement('strong');
            title.textContent = '尚未配置 AI';
            const text = document.createElement('span');
            text.textContent = '在「设置 → 模型」中填写 Base URL、API Key 与模型后即可开始对话。';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'dlg-btn primary';
            button.textContent = '打开 AI 设置';
            button.addEventListener('click', () => openSettings('models'));
            box.append(title, text, button);
        } else {
            const title = document.createElement('strong');
            title.textContent = '开始新的对话';
            const text = document.createElement('span');
            text.textContent = '直接输入问题，或输入 / 查看斜杠命令。';
            box.append(title, text);
        }
        return box;
    }

    function messageWindowTokens(message) {
        if (!message) return 0;
        let text = aiTextOf(message.content);
        if (message.reasoning) text += message.reasoning;
        if (message.arguments) text += message.arguments;
        return aiEstimateTokens(text);
    }

    function alignWindowToTurn(session, start) {
        if (start <= 0) return 0;
        for (let i = start; i >= 0; i--) {
            if (session.messages[i].role === 'user') return i;
        }
        return 0;
    }

    function windowStartFrom(session, fromIndex, needTokens) {
        let tokens = 0;
        let start = 0;
        for (let i = fromIndex - 1; i >= 0; i--) {
            tokens += messageWindowTokens(session.messages[i]);
            start = i;
            if (tokens >= needTokens) break;
        }
        return alignWindowToTurn(session, start);
    }

    function renderWindowState(session) {
        const len = session.messages.length;
        let state = renderWindows.get(session.id);
        // 消息变少（/compact、编辑重发、清空）时旧窗口索引失效，重新计算。
        if (state && len < state.len) state = null;
        if (!state) {
            const profile = activeProfile();
            const need = Math.max(AI_RENDER_INITIAL_TOKENS, Number(profile && profile.contextWindow) || 0);
            state = {start: windowStartFrom(session, len, need), len};
            renderWindows.set(session.id, state);
        }
        state.len = len;
        if (state.start > len) state.start = 0;
        return state;
    }

    function renderLoadEarlier(start) {
        const row = document.createElement('div');
        row.className = 'ai-load-earlier';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ai-load-earlier-btn';
        btn.textContent = '↑ 上方还有 ' + start + ' 条更早消息，点击或上滑加载';
        btn.addEventListener('click', () => loadEarlierMessages());
        row.appendChild(btn);
        el.messages.appendChild(row);
    }

    function loadEarlierMessages() {
        if (loadingEarlier) return;
        const session = currentSession();
        if (!session) return;
        const state = renderWindows.get(session.id);
        if (!state || state.start <= 0) return;
        loadingEarlier = true;
        try {
            const oldStart = state.start;
            const newStart = windowStartFrom(session, oldStart, AI_RENDER_STEP_TOKENS);
            const row = el.messages.querySelector('.ai-load-earlier');
            if (newStart >= oldStart) {
                if (row) row.remove();
                return;
            }
            const prevHeight = el.messages.scrollHeight;
            const prevTop = el.messages.scrollTop;
            state.start = newStart;
            const fragment = document.createDocumentFragment();
            const groups = groupTurns(session, newStart, oldStart);
            groups.forEach((group) => renderTurn(group, session, false, fragment));
            el.messages.insertBefore(fragment, row ? row.nextSibling : el.messages.firstChild);
            if (row) {
                if (newStart <= 0) row.remove();
                else {
                    const btn = row.querySelector('.ai-load-earlier-btn');
                    if (btn) btn.textContent = '↑ 上方还有 ' + newStart + ' 条更早消息，点击或上滑加载';
                }
            }
            // 保持视口内容不动：新增内容在顶部，补偿对应高度。
            el.messages.scrollTop = prevTop + (el.messages.scrollHeight - prevHeight);
        } finally {
            loadingEarlier = false;
        }
        updateScrollButton();
    }

    function renderMessages(keepScroll) {
        if (!el.messages) return;
        const session = currentSession();
        el.messages.innerHTML = '';
        slashState.open = false;
        renderTodos();
        updateChangesUI();
        if (!session) return;
        if (!activeProfile() && !session.messages.length) {
            el.messages.appendChild(emptyState('no-profile'));
            updateContextCount();
            updateScrollButton();
            updateComposerTakeover();
            return;
        }
        if (!session.messages.length) {
            el.messages.appendChild(emptyState('empty'));
            updateContextCount();
            updateScrollButton();
            updateComposerTakeover();
            return;
        }
        const state = renderWindowState(session);
        if (state.start > 0) renderLoadEarlier(state.start);
        const groups = groupTurns(session, state.start);
        groups.forEach((group, groupIndex) => {
            renderTurn(group, session, groupIndex === groups.length - 1);
        });
        if (stream && stream.sessionId === session.id) ensureProcessTicker();
        if (!keepScroll || stickBottom) {
            scrollToBottom(false);
        }
        updateContextCount();
        updateScrollButton();
        updateComposerTakeover();
    }

    function groupTurns(session, startIndex = 0, endIndex = session.messages.length) {
        const groups = [];
        let current = null;
        for (let i = Math.max(0, startIndex); i < endIndex; i++) {
            const message = session.messages[i];
            if (!current || message.role === 'user') {
                current = {
                    user: message.role === 'user' ? message : null,
                    startIndex: i,
                    items: [],
                };
                groups.push(current);
                if (message.role === 'user') continue;
            }
            current.items.push({message, index: i});
        }
        return groups;
    }

    function turnFinalItem(group) {
        const last = group.items[group.items.length - 1];
        if (!last || last.message.role !== 'assistant') return null;
        const message = last.message;
        return (message.status === 'streaming' || message.content || message.status === 'error' || message.status === 'stopped' || message.reasoning)
            ? last
            : null;
    }

    function turnStartMs(group) {
        if (!group.user) return 0;
        return Number(group.user.turnStartedAt) || Number(group.user.ts) || 0;
    }

    function turnDurationMs(group, finalItem, streamingFinal) {
        if (streamingFinal && stream) return Math.max(0, Date.now() - (Number(stream.startedAt) || turnStartMs(group)));
        if (finalItem && finalItem.message.turnMs) return finalItem.message.turnMs;
        return 0;
    }

    function processFoldLabel(group, finalItem, turnRunning) {
        const ms = turnRunning && stream
            ? Math.max(0, Date.now() - (Number(stream.startedAt) || turnStartMs(group)))
            : turnDurationMs(group, finalItem, false);
        const duration = ms ? '，用时 ' + aiFormatDuration(ms) : '';
        if (turnRunning) return '处理中' + duration;
        if (!finalItem) return '未完成' + duration;
        if (finalItem.message.status === 'error') return '已失败' + duration;
        if (finalItem.message.status === 'stopped') return '已停止' + duration;
        return '已完成' + duration;
    }

    function aiThinkKey(message, index) {
        const session = currentSession();
        const ts = Number(message && message.ts) || 0;
        return (session ? session.id : '') + ':' + (ts || (index != null ? 'i' + index : '0'));
    }

    function aiThinkLabel(message, streaming) {
        if (streaming) return '正在思考…';
        const chars = String(message && message.reasoning || '').length;
        const ms = Number(message && message.thinkMs) || 0;
        const time = ms > 0 ? (ms < 1000 ? '<1 秒' : Math.max(1, Math.round(ms / 1000)) + ' 秒') : '';
        return '已深度思考' + (time ? ' · ' + time : '') + ' · ' + chars + ' 字';
    }

    function renderThinkBody(body, message, streaming) {
        if (!body) return;
        const scrollTop = body.scrollTop;
        body.classList.add('ai-md');
        body.innerHTML = renderMarkdown((message && message.reasoning) || '');
        if (!streaming) enhanceAICodeBlocks(body);
        body.scrollTop = scrollTop;
    }

    function toggleThink(think) {
        if (!think) return;
        const collapsed = !think.classList.contains('collapsed');
        think.classList.toggle('collapsed', collapsed);
        const key = think.dataset.thinkKey;
        if (key) thinkFoldState.set(key, collapsed);
    }

    function renderProcessThinking(message, index) {
        const think = document.createElement('div');
        think.className = 'ai-think';
        const key = aiThinkKey(message, index);
        think.dataset.thinkKey = key;
        if (thinkFoldState.get(key) === true) think.classList.add('collapsed');
        const head = document.createElement('button');
        head.type = 'button';
        head.className = 'ai-think-head';
        const chev = document.createElement('span');
        chev.className = 'ai-think-chev';
        chev.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        const label = document.createElement('span');
        label.className = 'ai-think-label';
        label.textContent = aiThinkLabel(message, false);
        head.append(chev, label);
        head.addEventListener('click', () => toggleThink(think));
        const body = document.createElement('div');
        body.className = 'ai-think-body';
        renderThinkBody(body, message, false);
        think.append(head, body);
        return think;
    }

    function renderTurn(group, session, isLastGroup, parent) {
        const host = parent || el.messages;
        if (group.user) renderMessage(group.user, group.startIndex, session, host);
        const finalItem = turnFinalItem(group);
        const processAll = finalItem ? group.items.filter((item) => item !== finalItem) : group.items.slice();
        const askItems = processAll.filter((item) => item.message.ask && item.message.ask.state !== 'pending');
        const processItems = processAll.filter((item) => !item.message.ask);
        const turnRunning = !!(stream && stream.sessionId === session.id && isLastGroup);
        const streamingFinal = turnRunning && finalItem && stream.assistant === finalItem.message;
        const finalReasoning = !turnRunning && finalItem && finalItem.message.reasoning && settings.aiShowThinking !== false;
        const hasBody = processItems.length > 0 || !!finalReasoning;
        const duration = turnRunning && stream
            ? Math.max(0, Date.now() - (Number(stream.startedAt) || turnStartMs(group)))
            : turnDurationMs(group, finalItem, false);
        if (hasBody || (finalItem && duration)) {
            const key = session.id + ':' + (group.user ? 'u' + group.user.ts : 'g' + group.startIndex);
            const fold = document.createElement('div');
            fold.className = 'ai-process' + (turnRunning ? ' streaming' : '');
            fold.dataset.processKey = key;
            if (turnRunning) fold.dataset.processStart = String(Number(stream.startedAt) || turnStartMs(group));
            const expanded = turnRunning
                ? (processFoldState.has(key) ? processFoldState.get(key) : true)
                : (processFoldState.has(key) ? processFoldState.get(key) : false);
            fold.classList.toggle('collapsed', !expanded);
            const head = document.createElement('button');
            head.type = 'button';
            head.className = 'ai-process-head';
            head.disabled = !hasBody;
            const chev = document.createElement('span');
            chev.className = 'ai-process-chev';
            chev.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            if (!hasBody) chev.style.visibility = 'hidden';
            const label = document.createElement('span');
            label.className = 'ai-process-label';
            label.textContent = processFoldLabel(group, finalItem, turnRunning);
            head.append(chev, label);
            let body = null;
            const ensureBody = () => {
                if (body) return body;
                body = document.createElement('div');
                body.className = 'ai-process-body';
                for (const item of processItems) {
                    // 过程折叠展开时，中间轮次的思考链也一并展开（与最终回答的思考链保持一致）。
                    renderMessage(item.message, item.index, session, body, item.message.role === 'assistant' ? {expandThinking: true} : undefined);
                }
                if (finalReasoning) body.appendChild(renderProcessThinking(finalItem.message, finalItem.index));
                fold.appendChild(body);
                return body;
            };
            head.addEventListener('click', () => {
                if (!hasBody) return;
                const next = fold.classList.contains('collapsed');
                processFoldState.set(key, next);
                if (next) ensureBody();
                fold.classList.toggle('collapsed', !next);
            });
            fold.appendChild(head);
            if (expanded && hasBody) ensureBody();
            host.appendChild(fold);
        }
        for (const item of askItems) {
            renderMessage(item.message, item.index, session, host);
        }
        if (finalItem) {
            const showFinal = finalItem.message.content || finalItem.message.status !== 'done';
            if (showFinal) renderMessage(finalItem.message, finalItem.index, session, host, {hideThinking: !streamingFinal});
        }
    }

    function ensureProcessTicker() {
        if (processTicker || !stream) return;
        processTicker = setInterval(() => {
            if (!stream || !isOpen()) {
                stopProcessTicker();
                return;
            }
            for (const fold of el.messages.querySelectorAll('.ai-process.streaming')) {
                const label = fold.querySelector('.ai-process-label');
                const start = Number(fold.dataset.processStart) || 0;
                if (label && start) label.textContent = '处理中，用时 ' + aiFormatDuration(Date.now() - start);
            }
        }, 1000);
    }

    function stopProcessTicker() {
        if (!processTicker) return;
        clearInterval(processTicker);
        processTicker = 0;
    }

    function showImagePreview(image) {
        if (!image || !image.data) return;
        const img = document.createElement('img');
        img.className = 'ai-image-preview';
        img.src = aiImageSrc(image);
        img.alt = image.name || '图片';
        openAIDialog('图片预览 · ' + (image.name || '图片'), [img],
            [dialogButton('关闭', 'dlg-btn primary', closeAIDialog)]);
    }

    function appendUserImages(wrap, images) {
        if (!Array.isArray(images) || !images.length) return;
        const strip = document.createElement('div');
        strip.className = 'ai-user-images';
        for (const image of images) {
            if (!image.data) {
                if (!image.logFile) continue;
                const missing = document.createElement('div');
                missing.className = 'ai-user-image-missing';
                missing.textContent = '图片已归档';
                missing.title = image.logFile;
                strip.appendChild(missing);
                continue;
            }
            const img = document.createElement('img');
            img.className = 'ai-user-image';
            img.src = aiImageSrc(image);
            img.alt = image.name || '图片';
            img.title = (image.name || '图片') + (image.width && image.height ? ' · ' + image.width + '×' + image.height : '');
            img.loading = 'lazy';
            img.addEventListener('click', () => showImagePreview(image));
            strip.appendChild(img);
        }
        if (strip.childNodes.length) wrap.appendChild(strip);
    }

    function renderMessage(message, index, session, parent, options) {
        const wrap = document.createElement('div');
        wrap.className = 'ai-msg ' + message.role;
        wrap.dataset.aiIdx = String(index);
        if (message.role === 'tool') {
            renderToolMessage(wrap, message);
        } else if (message.role === 'assistant') {
            if (message.status === 'error') wrap.classList.add('error');
            if (message.status === 'streaming') wrap.classList.add('streaming');
            const meta = document.createElement('div');
            meta.className = 'ai-msg-meta';
            wrap.appendChild(meta);
            const bubble = document.createElement('div');
            bubble.className = 'ai-bubble';
            const md = document.createElement('div');
            md.className = 'ai-md';
            bubble.appendChild(md);
            wrap.appendChild(bubble);
            updateAssistantElement(wrap, message, message.status === 'streaming', options);
        } else {
            const bubble = document.createElement('div');
            bubble.className = 'ai-user-bubble';
            appendUserImages(bubble, message.images);
            if (message.content) {
                const text = document.createElement('div');
                text.className = 'ai-user-text';
                text.textContent = message.content;
                bubble.appendChild(text);
            }
            wrap.appendChild(bubble);
            // 时间和操作仿 dsh：平时隐藏，hover 用户消息时显示在胶囊下方。
            const foot = document.createElement('div');
            foot.className = 'ai-user-foot';
            const meta = document.createElement('div');
            meta.className = 'ai-msg-meta';
            meta.textContent = aiFormatTime(message.ts);
            foot.appendChild(meta);
            wrap.appendChild(foot);
            appendActions(wrap, message, index, session, foot);
        }
        (parent || el.messages).appendChild(wrap);
    }

    function toolArgsSummary(value) {
        const text = aiTextOf(value);
        if (!text) return '';
        try {
            const parsed = JSON.parse(text);
            return JSON.stringify(parsed).slice(0, 120);
        } catch (e) {
            return text.replace(/\s+/g, ' ').slice(0, 120);
        }
    }

    function toolStateText(message) {
        const approval = message.approval;
        if (approval) {
            const command = approval.kind === 'command';
            if (approval.state === 'pending') return '等待审批…';
            if (approval.state === 'approved') {
                if (message.status === 'running') return command ? '执行中…' : '应用中…';
                return command ? '已执行' : '已应用';
            }
            if (approval.state === 'denied') return '已放弃';
            if (approval.state === 'cancelled') return '已取消';
            if (approval.state === 'failed') return command ? '执行失败' : '应用失败';
        }
        if (message.status === 'pending') return '等待审批…';
        if (message.status === 'running') return '执行中…';
        return message.status === 'error' ? '失败' : '完成';
    }

    function renderCommandApprovalBody(container, message, approval) {
        const meta = document.createElement('div');
        meta.className = 'ai-approval-meta';
        const label = document.createElement('span');
        label.className = 'ai-approval-path';
        label.textContent = '终端命令';
        meta.appendChild(label);
        if (approval.cwd) {
            const cwd = document.createElement('span');
            cwd.className = 'ai-command-cwd';
            cwd.textContent = approval.cwd;
            cwd.title = approval.cwd;
            meta.appendChild(cwd);
        }
        container.appendChild(meta);
        const line = document.createElement('pre');
        line.className = 'ai-command-line';
        line.textContent = approval.command;
        container.appendChild(line);
        if (approval.state === 'pending') {
            const actions = document.createElement('div');
            actions.className = 'ai-approval-actions';
            const deny = document.createElement('button');
            deny.type = 'button';
            deny.className = 'dlg-btn';
            deny.dataset.aiApprove = 'deny';
            deny.textContent = '放弃';
            const apply = document.createElement('button');
            apply.type = 'button';
            apply.className = 'dlg-btn primary';
            apply.dataset.aiApprove = 'apply';
            apply.textContent = '执行';
            actions.append(deny, apply);
            container.appendChild(actions);
            return;
        }
        const result = document.createElement('div');
        result.className = 'ai-approval-result ' + approval.state;
        result.textContent = approval.state === 'approved'
            ? (message.status === 'running' ? '正在执行命令…' : '命令已执行')
            : approval.state === 'denied'
                ? '已放弃，命令未执行'
                : (approval.state === 'failed'
                    ? ('执行失败：' + (approval.error || '无法执行命令'))
                    : '审批已取消');
        container.appendChild(result);
        if (message.content) {
            const output = document.createElement('div');
            output.className = 'ai-approval-output';
            output.textContent = message.content;
            container.appendChild(output);
        }
    }

    function renderApprovalBody(container, message, approval) {
        if (approval.kind === 'command') {
            renderCommandApprovalBody(container, message, approval);
            return;
        }
        const meta = document.createElement('div');
        meta.className = 'ai-approval-meta';
        const path = document.createElement('span');
        path.className = 'ai-approval-path';
        path.textContent = approval.relPath || approval.path;
        path.title = approval.path || '';
        const stat = document.createElement('span');
        stat.className = 'ai-approval-stat';
        const add = document.createElement('span');
        add.className = 'add';
        add.textContent = '+' + approval.added;
        const del = document.createElement('span');
        del.className = 'del';
        del.textContent = '−' + approval.removed;
        stat.append(add, del);
        if (approval.newFile) {
            const tag = document.createElement('span');
            tag.className = 'ai-approval-tag';
            tag.textContent = '新文件';
            stat.appendChild(tag);
        }
        meta.append(path, stat);
        container.appendChild(meta);

        if (approval.dirty) {
            const warn = document.createElement('div');
            warn.className = 'ai-approval-warn';
            warn.textContent = '该文件在编辑器中存在未保存修改；应用后不会自动重载，请手动重新加载。';
            container.appendChild(warn);
        }

        if (approval.diff && approval.diff.length) {
            const diff = document.createElement('div');
            diff.className = 'ai-diff';
            for (const line of approval.diff) {
                if (line.t === '…') {
                    const gap = document.createElement('div');
                    gap.className = 'ai-diff-line gap';
                    gap.textContent = '…';
                    diff.appendChild(gap);
                    continue;
                }
                const row = document.createElement('div');
                row.className = 'ai-diff-line ' + (line.t === '+' ? 'add' : (line.t === '-' ? 'del' : 'ctx'));
                const sign = document.createElement('span');
                sign.className = 'ai-diff-sign';
                sign.textContent = line.t === '+' ? '+' : (line.t === '-' ? '−' : ' ');
                const text = document.createElement('span');
                text.className = 'ai-diff-text';
                text.textContent = line.text || ' ';
                row.append(sign, text);
                diff.appendChild(row);
            }
            container.appendChild(diff);
            if (approval.truncated) {
                const more = document.createElement('div');
                more.className = 'ai-approval-more';
                more.textContent = '…（diff 预览已截断）';
                container.appendChild(more);
            }
        }

        if (approval.state === 'pending') {
            const options = document.createElement('div');
            options.className = 'ai-approval-remember';
            const sessionLabel = document.createElement('label');
            const sessionBox = document.createElement('input');
            sessionBox.type = 'checkbox';
            sessionBox.dataset.aiRemember = 'session';
            sessionLabel.append(sessionBox, document.createTextNode(' 本会话允许此文件'));
            const alwaysLabel = document.createElement('label');
            const alwaysBox = document.createElement('input');
            alwaysBox.type = 'checkbox';
            alwaysBox.dataset.aiRemember = 'always';
            alwaysLabel.append(alwaysBox, document.createTextNode(' 总是允许此文件'));
            options.append(sessionLabel, alwaysLabel);
            container.appendChild(options);

            const actions = document.createElement('div');
            actions.className = 'ai-approval-actions';
            const deny = document.createElement('button');
            deny.type = 'button';
            deny.className = 'dlg-btn';
            deny.dataset.aiApprove = 'deny';
            deny.textContent = '放弃';
            const apply = document.createElement('button');
            apply.type = 'button';
            apply.className = 'dlg-btn primary';
            apply.dataset.aiApprove = 'apply';
            apply.textContent = '应用';
            actions.append(deny, apply);
            container.appendChild(actions);
        } else {
            const result = document.createElement('div');
            result.className = 'ai-approval-result ' + approval.state;
            result.textContent = approval.state === 'approved'
                ? (message.status === 'running'
                    ? '正在应用更改…'
                    : (approval.remember === 'pre' ? '已按授权自动应用更改' : '已应用更改'))
                : approval.state === 'denied'
                    ? '已放弃，文件未修改'
                    : (approval.state === 'failed'
                        ? ('应用失败：' + (approval.error || '写入文件失败'))
                        : '审批已取消');
            container.appendChild(result);
            if (message.content) {
                const output = document.createElement('div');
                output.className = 'ai-approval-output';
                output.textContent = message.content;
                container.appendChild(output);
            }
        }
    }

    function askStateLabel(ask) {
        return {
            pending: '等待回答',
            answered: '已回答',
            timeout: '已超时',
            timeout_abort: '超时停止',
            cancelled: '已取消',
            expired: '已过期',
        }[ask.state] || ask.state;
    }

    function askResultText(ask) {
        if (ask.state === 'timeout' && ask.source === 'timeout_recommended') return '超时未回答，已自动采用推荐项';
        if (ask.state === 'timeout') return '超时未回答，已交给 AI 决定并继续';
        if (ask.state === 'timeout_abort') return '超时未回答，已停止本轮';
        if (ask.state === 'cancelled') return '问题已取消';
        if (ask.state === 'expired') return '页面已关闭，问题未回答';
        return '';
    }

    function renderAskCard(wrap, message) {
        const ask = message.ask;
        const card = document.createElement('div');
        card.className = 'ai-ask-card ' + ask.state;
        const head = document.createElement('div');
        head.className = 'ai-ask-head';
        const icon = document.createElement('span');
        icon.className = 'ai-ask-icon';
        icon.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6.2 6.3a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.7.6-.7 1.1v.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".75" fill="currentColor"/></svg>';
        const title = document.createElement('span');
        title.className = 'ai-ask-title';
        title.textContent = ask.questions.length > 1 ? 'AI 提问 · ' + ask.questions.length + ' 个问题' : 'AI 提问';
        const state = document.createElement('span');
        state.className = 'ai-ask-state';
        state.textContent = askStateLabel(ask);
        head.append(icon, title, state);
        card.appendChild(head);
        if (ask.state === 'pending') {
            const pending = document.createElement('div');
            pending.className = 'ai-ask-question';
            pending.textContent = '等待在底部输入框回答…';
            card.appendChild(pending);
            wrap.appendChild(card);
            return;
        }
        ask.questions.forEach((question, index) => {
            const block = document.createElement('div');
            block.className = 'ai-ask-record';
            const q = document.createElement('div');
            q.className = 'ai-ask-question';
            q.textContent = (ask.questions.length > 1 ? (index + 1) + '. ' : '') + question.question;
            block.appendChild(q);
            if (question.detail) {
                const detail = document.createElement('div');
                detail.className = 'ai-ask-detail';
                detail.textContent = question.detail;
                block.appendChild(detail);
            }
            const answer = (ask.answers || []).find((item) => item.id === question.id) || {};
            const lines = [];
            if (answer.selected && answer.selected.length) lines.push('选择：' + answer.selected.join('、'));
            if (answer.custom) lines.push('补充：' + answer.custom);
            const answerEl = document.createElement('div');
            answerEl.className = 'ai-ask-answer' + (lines.length ? '' : ' empty');
            answerEl.textContent = lines.length ? lines.join('；') : '未回答';
            block.appendChild(answerEl);
            card.appendChild(block);
        });
        const note = askResultText(ask);
        if (note) {
            const result = document.createElement('div');
            result.className = 'ai-ask-result';
            result.textContent = note;
            card.appendChild(result);
        }
        wrap.appendChild(card);
    }

    function renderToolMessage(wrap, message) {
        if (message.ask) {
            renderAskCard(wrap, message);
            return;
        }
        const card = document.createElement('div');
        const approval = message.approval;
        const isCommand = message.name === 'run_command';
        card.className = 'ai-tool-card ' + (message.status || 'done') + (approval ? ' has-approval' : '') + (isCommand ? ' command' : '');
        if (approval && approval.state === 'pending') card.classList.add('approval-pending');
        wrap.appendChild(card);
        const head = document.createElement('button');
        head.type = 'button';
        head.className = 'ai-tool-head';
        const chev = document.createElement('span');
        chev.className = 'ai-tool-chev';
        chev.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        const name = document.createElement('span');
        name.className = 'ai-tool-name';
        name.textContent = message.name || 'tool';
        const args = document.createElement('span');
        args.className = 'ai-tool-args';
        args.textContent = toolArgsSummary(message.arguments);
        if (isCommand) {
            try {
                const command = aiTextOf(JSON.parse(message.arguments || '{}').command).trim();
                if (command) {
                    args.textContent = command.replace(/\s+/g, ' ');
                    args.title = command;
                }
            } catch (e) {}
        }
        const state = document.createElement('span');
        state.className = 'ai-tool-state';
        state.textContent = toolStateText(message);
        head.append(chev, name, args, state);
        head.addEventListener('click', () => {
            card.dataset.userToggled = '1';
            card.classList.toggle('collapsed');
        });
        const body = document.createElement('div');
        body.className = 'ai-tool-body';
        if (approval) {
            body.classList.add('ai-tool-approval-body');
            renderApprovalBody(body, message, approval);
        } else {
            body.textContent = message.content || (message.status === 'running' ? '执行中…' : '（无输出）');
        }
        card.append(head, body);
        if (approval && approval.state === 'pending') return;
        // 终端命令默认只显示一行摘要（命令 + 状态），点击展开完整输出。
        if (isCommand) {
            card.classList.add('collapsed');
            return;
        }
        if (message.status !== 'running' && message.status !== 'error') card.classList.add('collapsed');
    }

    function enhanceAICodeBlocks(root) {
        if (!root) return;
        const blocks = [];
        root.querySelectorAll('.md-code-frame').forEach((frame) => blocks.push(frame));
        root.querySelectorAll('pre').forEach((pre) => {
            if (!pre.closest('.md-code-frame')) blocks.push(pre);
        });
        for (const block of blocks) {
            const code = block.querySelector('code') || block;
            const wrap = document.createElement('div');
            wrap.className = 'ai-code-wrap';
            block.parentNode.insertBefore(wrap, block);
            wrap.appendChild(block);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'ai-code-copy';
            button.title = '复制代码';
            button.textContent = '复制';
            button.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                copyText(code.textContent || '', '代码');
            });
            wrap.appendChild(button);
        }
    }

    function updateAssistantElement(wrap, message, streaming, options) {
        if (!wrap) return;
        const hideThinking = !!(options && options.hideThinking);
        const expandThinking = !!(options && options.expandThinking);
        wrap.classList.toggle('streaming', !!streaming);
        if (!streaming) wrap.classList.remove('actions-visible');
        const meta = wrap.querySelector('.ai-msg-meta');
        if (meta) {
            meta.innerHTML = '';
            const who = document.createElement('span');
            who.textContent = 'AI';
            const model = document.createElement('span');
            model.className = 'ai-model';
            model.textContent = message.model || '';
            const time = document.createElement('span');
            time.textContent = aiFormatTime(message.ts);
            meta.append(who);
            if (model.textContent) meta.appendChild(model);
            meta.appendChild(time);
        }

        let think = wrap.querySelector('.ai-think');
        if (settings.aiShowThinking !== false && !hideThinking && (message.reasoning || streaming)) {
            const thinkKey = aiThinkKey(message, Number(wrap.dataset.aiIdx));
            if (!think) {
                think = document.createElement('div');
                think.className = 'ai-think';
                think.dataset.thinkKey = thinkKey;
                const head = document.createElement('button');
                head.type = 'button';
                head.className = 'ai-think-head';
                const chev = document.createElement('span');
                chev.className = 'ai-think-chev';
                chev.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
                const label = document.createElement('span');
                label.className = 'ai-think-label';
                head.append(chev, label);
                head.addEventListener('click', () => toggleThink(think));
                const body = document.createElement('div');
                body.className = 'ai-think-body';
                think.append(head, body);
                wrap.insertBefore(think, wrap.querySelector('.ai-bubble'));
            }
            think.dataset.thinkKey = thinkKey;
            think.classList.toggle('thinking', !!streaming);
            const head = think.querySelector('.ai-think-head');
            const label = think.querySelector('.ai-think-label');
            if (label) label.textContent = aiThinkLabel(message, !!streaming);
            renderThinkBody(think.querySelector('.ai-think-body'), message, !!streaming);
            const storedThink = thinkFoldState.get(thinkKey);
            if (storedThink !== undefined) think.classList.toggle('collapsed', storedThink);
            else if (!streaming && !expandThinking) think.classList.add('collapsed');
            else think.classList.remove('collapsed');
            if (head) head.title = '展开 / 收起思考过程';
        } else if (think) {
            think.remove();
        }

        const md = wrap.querySelector('.ai-md');
        if (md) {
            md.classList.toggle('error-text', message.status === 'error' && !message.content);
            if (message.status === 'error' && !message.content) {
                md.textContent = message.error ? ('请求失败：' + message.error) : '请求失败';
            } else if (message.content) {
                md.innerHTML = renderMarkdown(message.content);
                enhanceAICodeBlocks(md);
            } else if (streaming) {
                md.innerHTML = '<div class="ai-typing"><span></span><span></span><span></span></div>';
            } else if (message.status === 'stopped') {
                md.textContent = '（已停止生成）';
            } else {
                md.textContent = '';
            }
            const oldError = wrap.querySelector('.ai-error-box');
            if (oldError) oldError.remove();
            if (message.status === 'error' && message.error && message.content) {
                const error = document.createElement('div');
                error.className = 'ai-error-box';
                error.textContent = message.error;
                wrap.querySelector('.ai-bubble').appendChild(error);
            }
        }
        wrap.classList.toggle('error', message.status === 'error');

        if (!streaming) appendActions(wrap, message, Number(wrap.dataset.aiIdx), currentSession());
        updateUsage(wrap, message);
    }

    function updateUsage(wrap, message) {
        let usage = wrap.querySelector('.ai-usage');
        const show = settings.aiShowUsage !== false && message.usage && (message.usage.totalTokens || message.usage.promptTokens || message.usage.completionTokens);
        if (!show) {
            if (usage) usage.remove();
            return;
        }
        if (!usage) {
            usage = document.createElement('div');
            usage.className = 'ai-usage';
            wrap.appendChild(usage);
        }
        usage.textContent = 'tokens：输入 ' + (message.usage.promptTokens || 0) +
            ' · 输出 ' + (message.usage.completionTokens || 0) +
            ' · 合计 ' + (message.usage.totalTokens || 0);
    }

    async function acceptPlan(session, message) {
        if (!session || stream || !session.planMode || !message || !message.planMode) return;
        if (currentScopeOf(session) === 'read') {
            flash('当前为「仅可查看」，执行阶段无法修改文件；请先在下方切换权限', true);
            return;
        }
        session.planMode = false;
        dismissedPlanApproval = '';
        persistSessions();
        updateScopeUI();
        updateComposerTakeover(true);
        renderMessageQueue();
        renderMessages(true);
        const ok = await submitText('计划已批准，请立即按上面的计划开始执行，不要重复计划内容。');
        if (!ok) {
            session.planMode = true;
            persistSessions();
            updateScopeUI();
            updateComposerTakeover(true);
            renderMessages(true);
        }
    }

    function appendActions(wrap, message, index, session, target) {
        const host = target || wrap;
        let actions = host.querySelector(':scope > .ai-msg-actions');
        if (!actions) {
            actions = document.createElement('div');
            actions.className = 'ai-msg-actions';
            host.appendChild(actions);
        }
        actions.innerHTML = '';
        const sessionNow = session || currentSession();
        const lastAssistant = sessionNow ? lastAssistantIndex(sessionNow) : -1;
        const lastUser = sessionNow ? lastUserIndex(sessionNow) : -1;
        const icon = (path) => '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
        const icons = {
            copy: icon('<rect x="5.2" y="5.2" width="7.6" height="7.6" rx="1.4"/><path d="M3.6 10.2V3.9c0-.7.6-1.3 1.3-1.3h6.3"/>'),
            edit: icon('<path d="M3.2 12.8l.6-2.7L10.6 3.3c.5-.5 1.3-.5 1.8 0l.3.3c.5.5.5 1.3 0 1.8L5.9 12.2l-2.7.6z"/><path d="M9.6 4.4l2 2"/>'),
            regenerate: icon('<path d="M12.6 6.4A5 5 0 1 1 3.4 9.6"/><path d="M12.8 3.2v3.4H9.4"/>'),
            retry: icon('<path d="M12.6 6.4A5 5 0 1 1 3.4 9.6"/><path d="M12.8 3.2v3.4H9.4"/>'),
        };
        const add = (act, label, disabled) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'ai-msg-action';
            button.dataset.aiAct = act;
            button.title = label;
            button.setAttribute('aria-label', label);
            button.innerHTML = icons[act] || label;
            button.disabled = !!disabled;
            actions.appendChild(button);
        };
        if (message.role === 'user') {
            add('copy', '复制');
            if (index === lastUser && !stream) add('edit', '编辑重发');
        } else {
            add('copy', '复制');
            if (message.status === 'error') {
                if (!stream) add('retry', '重试');
            } else if (index === lastAssistant && !stream) {
                add('regenerate', '重新生成');
            }
        }
    }

    function isStreamingMessage(session, index) {
        return !!(stream && stream.sessionId === session.id && index === session.messages.length - 1);
    }

    function lastAssistantIndex(session) {
        for (let i = session.messages.length - 1; i >= 0; i--) {
            if (session.messages[i].role === 'assistant') return i;
        }
        return -1;
    }

    function lastUserIndex(session) {
        for (let i = session.messages.length - 1; i >= 0; i--) {
            if (session.messages[i].role === 'user') return i;
        }
        return -1;
    }

    function turnStartAt(session, assistantIndex) {
        for (let i = Math.min(assistantIndex, session.messages.length - 1); i >= 0; i--) {
            const message = session.messages[i];
            if (message.role === 'user') return Number(message.turnStartedAt) || Number(message.ts) || 0;
        }
        return 0;
    }

    function scrollToBottom(smooth) {
        if (!el.messages) return;
        const top = Math.max(0, el.messages.scrollHeight - el.messages.clientHeight);
        if (smooth && el.messages.scrollTo) el.messages.scrollTo({top, behavior: 'smooth'});
        else el.messages.scrollTop = top;
        stickBottom = true;
        updateScrollButton();
    }

    function updateScrollButton() {
        if (!el.scrollBtn || !el.messages) return;
        const distance = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight;
        el.scrollBtn.classList.toggle('hidden', distance <= 200);
    }

    function positionOverlays() {
        if (!el.composer) return;
        const panelRect = panel.getBoundingClientRect();
        const composerRect = el.composer.getBoundingClientRect();
        if (!panelRect.height) return;
        // composer 下面还有统计行：以 composer 顶边为基准，避免按钮/菜单压在输入框上。
        const bottom = Math.max(8, panelRect.bottom - composerRect.top + 8);
        if (el.slash) {
            el.slash.style.bottom = bottom + 'px';
            el.slash.style.left = Math.max(9, composerRect.left - panelRect.left) + 'px';
            el.slash.style.right = Math.max(9, panelRect.right - composerRect.right) + 'px';
        }
        if (el.scrollBtn) {
            el.scrollBtn.style.bottom = bottom + 'px';
            // 居中挂在 composer 正上方（CSS 里用 translateX(-50%) 对齐中心）。
            const center = composerRect.left - panelRect.left + composerRect.width / 2;
            el.scrollBtn.style.left = center + 'px';
            el.scrollBtn.style.right = 'auto';
        }
        if (openStatsPop) positionStatsPop(openStatsPop);
    }

    // ---------- 上下文估算 ----------

    function buildApiMessages(session, endIndex, systemText) {
        const messages = [{role: 'system', content: systemText || AI_DEFAULT_SYSTEM_PROMPT}];
        if (!session) return messages;
        if (session.summary && aiTextOf(session.summary.text).trim()) {
            messages.push({
                role: 'system',
                content: '<conversation_summary>\n' + aiTextOf(session.summary.text).trim() + '\n</conversation_summary>',
            });
        }
        const limit = endIndex == null ? session.messages.length : endIndex;
        for (let i = 0; i < limit; i++) {
            const message = session.messages[i];
            if (!message) continue;
            if (message.role === 'tool') {
                if (message.status === 'running') continue;
                messages.push({
                    role: 'tool',
                    toolCallId: message.toolCallId,
                    name: message.name || '',
                    content: message.content || '',
                });
                continue;
            }
            const hasCalls = message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length;
            const hasImages = message.role === 'user' && Array.isArray(message.images) && message.images.some((image) => image && image.data);
            let content = message.content;
            if (!content && !hasImages && message.role === 'user' && Array.isArray(message.images) && message.images.length) {
                content = '（图片已归档，原始图片见对话日志）';
            }
            if (!content && !hasCalls && !hasImages) continue;
            if (message.role === 'assistant' && message.status === 'error') continue;
            const item = {role: message.role, content};
            if (hasImages) {
                item.images = message.images.filter((image) => image && image.data)
                    .map((image) => ({mime: image.mime, data: image.data}));
            }
            if (message.role === 'assistant' && message.reasoning) {
                item.thinking = message.reasoning;
                item.thinkingSignature = message.thinkingSignature || '';
            }
            if (hasCalls) {
                item.toolCalls = message.toolCalls.map((call) => ({
                    id: call.id,
                    name: call.name,
                    arguments: call.arguments || '{}',
                }));
            }
            messages.push(item);
        }
        return messages;
    }

    async function contextSummaryText() {
        const session = currentSession();
        const profile = activeProfile();
        const bundle = await assembleSystemContext(session, attachments);
        lastSystemPrompt = bundle.text;
        lastContextMeta = bundle.meta;
        const apiMessages = buildApiMessages(session, null, bundle.text);
        let chars = 0;
        let cjk = 0;
        for (const message of apiMessages) {
            const text = aiTextOf(message.content);
            chars += text.length;
            for (const ch of text) if (aiIsCJK(ch.codePointAt(0))) cjk++;
        }
        const tokens = aiEstimateTokens(apiMessages.map((m) => m.content).join('\n'));
        const imageStats = aiImageStats(apiMessages);
        const totalTokens = tokens + imageStats.tokens;
        const windowSize = profile ? profile.contextWindow : 128000;
        const percent = windowSize > 0 ? (totalTokens / windowSize * 100) : 0;
        const userCount = session ? session.messages.filter((m) => m.role === 'user').length : 0;
        const assistantCount = session ? session.messages.filter((m) => m.role === 'assistant').length : 0;
        const toolCount = session ? session.messages.filter((m) => m.role === 'tool').length : 0;
        let lastUsage = null;
        if (session) {
            for (let i = session.messages.length - 1; i >= 0; i--) {
                const message = session.messages[i];
                if (message.role === 'assistant' && message.usage) {
                    lastUsage = message.usage;
                    break;
                }
            }
        }
        const lines = [
            '上下文估算（字符近似，非精确 tokenizer）',
            '消息：' + userCount + ' 条用户 / ' + assistantCount + ' 条助手 / ' + toolCount + ' 条工具结果（共 ' + apiMessages.length + ' 条发送项，含 system）',
            '字符：' + chars + '（其中 CJK ' + cjk + '）',
            '图片：' + imageStats.count + ' 张（估算 ' + imageStats.tokens + ' tokens）',
            '估算 tokens：' + totalTokens + ' / 窗口 ' + windowSize + '（' + percent.toFixed(1) + '%）',
            '系统注入：AGENTS.md ' + (bundle.meta.agents.loaded ? '✓ ' + bundle.meta.agents.chars + ' 字符' : '—') +
                ' · 记忆 ' + (bundle.meta.memory.loaded ? '✓ ' + bundle.meta.memory.mode + ' ' + bundle.meta.memory.chars + ' 字符' : '—') +
                ' · 技能 ' + bundle.meta.skills.count + ' 个' +
                ' · 附加 ' + bundle.meta.attachments.count + ' 项',
        ];
        if (bundle.meta.memory.error && bundle.meta.memory.error !== '') {
            lines.push('记忆未注入：' + bundle.meta.memory.error);
        }
        if (lastUsage) {
            lines.push('最近一次 API 实际用量：输入 ' + (lastUsage.promptTokens || 0) +
                ' · 输出 ' + (lastUsage.completionTokens || 0) +
                ' · 合计 ' + (lastUsage.totalTokens || 0));
        } else {
            lines.push('尚无 API 用量数据（接口返回 usage 后显示）。');
        }
        if (session && session.summary && session.summary.text) {
            lines.push('已压缩：摘要 ' + session.summary.text.length + ' 字符，归档 ' +
                ((session.archived || []).length) + ' 条（归档不发送；命令面板「AI： 查看已归档消息」或导出 Markdown 可查看）。');
        }
        if (percent >= 80) lines.push('提示：上下文接近窗口上限，可考虑新建会话。');
        return lines.join('\n');
    }

    function updateContextCount() {
        if (el.contextCount) {
            const session = currentSession();
            const messages = buildApiMessages(session, null, lastSystemPrompt);
            const chars = messages.reduce((sum, message) => sum + aiTextOf(message.content).length, 0);
            const extra = attachments.reduce((sum, item) => sum + aiTextOf(item.content).length, 0);
            const imageCount = aiImageStats(messages).count + attachments.filter((item) => item.kind === 'image').length;
            el.contextCount.textContent = '上下文约 ' + (chars + extra) + ' 字符' + (imageCount ? ' · 图片 ' + imageCount + ' 张' : '');
        }
        updateCtxBanner();
        renderStats();
    }

    // ---------- Composer 统计行 / 上下文弹层 ----------

    function toolsTokenEstimate(session) {
        return aiEstimateTokens(JSON.stringify(toolsForScope(currentScopeOf(session), !!(session && session.planMode))));
    }

    function aiFormatCompactTokens(value) {
        const num = Math.max(0, Math.round(Number(value) || 0));
        if (num < 1000) return String(num);
        if (num < 1000000) {
            const k = num / 1000;
            return (k < 100 ? k.toFixed(1) : k.toFixed(0)).replace(/\.0$/, '') + 'K';
        }
        const m = num / 1000000;
        return (m < 10 ? m.toFixed(1) : m.toFixed(0)).replace(/\.0$/, '') + 'M';
    }

    function aiFormatExactCount(value) {
        return Math.max(0, Math.round(Number(value) || 0)).toLocaleString('en-US');
    }

    function aiFormatCompactDuration(ms) {
        const total = Math.max(0, Math.round(Number(ms) / 1000));
        if (total < 1) return '不到 1 秒';
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const seconds = total % 60;
        if (hours) return hours + '小时' + (minutes ? minutes + '分' : '');
        if (minutes) return minutes + '分' + (seconds ? seconds + '秒' : '');
        return seconds + '秒';
    }

    function sessionUsageTotals(session) {
        const all = ((session && session.archived) || []).concat((session && session.messages) || []);
        let rounds = 0;
        let steps = 0;
        let prompt = 0;
        let completion = 0;
        let total = 0;
        let cached = 0;
        let turnMs = 0;
        let modelMs = 0;
        let toolMs = 0;
        let timedMs = 0;
        let timedCompletion = 0;
        let ttftMs = 0;
        let ttftCount = 0;
        let hasTools = false;
        for (const message of all) {
            if (!message) continue;
            if (message.role === 'user') rounds++;
            if (message.role === 'tool') {
                hasTools = true;
                continue;
            }
            if (message.role !== 'assistant') continue;
            steps++;
            let messageCompletion = 0;
            const usage = message.usage;
            if (usage) {
                const p = Number(usage.promptTokens) || 0;
                const c = Number(usage.completionTokens) || 0;
                prompt += p;
                completion += c;
                messageCompletion = c;
                total += Number(usage.totalTokens) || (p + c);
                cached += Number(usage.cachedTokens) || 0;
            }
            const messageModelMs = Number(message.modelMs) || 0;
            const messageTurnMs = Number(message.turnMs) || 0;
            modelMs += messageModelMs;
            toolMs += Number(message.toolMs) || 0;
            turnMs += messageTurnMs;
            const speedBase = messageModelMs || messageTurnMs;
            if (speedBase > 0) {
                timedMs += speedBase;
                timedCompletion += messageCompletion;
            }
            const firstTokenMs = Number(message.firstTokenMs) || 0;
            if (firstTokenMs > 0) {
                ttftMs += firstTokenMs;
                ttftCount++;
            }
        }
        return {
            rounds, steps, prompt, completion, total, cached, turnMs,
            modelMs, toolMs, hasTools,
            ttftAvg: ttftCount ? ttftMs / ttftCount : 0,
            speed: timedMs > 300 && timedCompletion > 0 ? Math.round(timedCompletion / (timedMs / 1000)) : 0,
        };
    }

    function setStatItem(node, text) {
        if (!node) return;
        node.textContent = text;
        node.classList.toggle('hidden', !text);
    }

    function renderStats() {
        if (!el.stats) return;
        const session = currentSession();
        const show = !!(session && ((session.messages && session.messages.length) || (session.archived && session.archived.length)));
        el.stats.classList.toggle('hidden', !show);
        if (!show) {
            hideStatsPops();
            return;
        }
        const totals = sessionUsageTotals(session);
        setStatItem(el.statsTurns, totals.rounds + ' 轮 ' + totals.steps + ' 步');
        setStatItem(el.statsSpeed, totals.speed > 0 ? totals.speed + ' tok/s' : '');
        setStatItem(el.statsTotal, totals.total > 0 ? aiFormatCompactTokens(totals.total) + ' tok' : '');
        const cacheRate = totals.prompt > 0 && totals.cached > 0 ? Math.round(totals.cached / totals.prompt * 100) : 0;
        setStatItem(el.statsCache, cacheRate > 0 ? '缓存命中 ' + cacheRate + '%' : '');
        const tokenVisible = totals.total > 0 || totals.prompt > 0 || totals.completion > 0;
        if (el.statsTokenBtn) el.statsTokenBtn.classList.toggle('hidden', !tokenVisible);
        if (el.statsSep) el.statsSep.classList.toggle('hidden', !tokenVisible);
        const {tokens, windowSize, percent} = estimateCurrentTokens();
        const pct = Math.max(0, Math.round(percent * 100));
        if (el.statsCtxPct) el.statsCtxPct.textContent = pct + '%';
        if (el.ctxRing) el.ctxRing.style.setProperty('--ctx-pct', String(Math.min(100, pct)));
        if (el.ctxBtn) el.ctxBtn.title = '上下文约 ' + aiFormatCompactTokens(tokens) + ' / ' + aiFormatCompactTokens(windowSize) + ' tokens（估算）';
        if (openStatsPop === 'ctx') void renderCtxPopover(false);
        else if (openStatsPop === 'session') renderSessionPopover();
        else if (openStatsPop === 'token') renderTokenPopover();
    }

    let openStatsPop = '';

    function statsPopEl(kind) {
        if (kind === 'session') return el.sessionPop;
        if (kind === 'token') return el.tokenPop;
        return el.ctxPop;
    }

    function statsPopBtn(kind) {
        if (kind === 'session') return el.statsSessionBtn;
        if (kind === 'token') return el.statsTokenBtn;
        return el.ctxBtn;
    }

    function hideStatsPops() {
        for (const kind of ['session', 'token', 'ctx']) {
            const pop = statsPopEl(kind);
            if (pop) pop.classList.add('hidden');
        }
        openStatsPop = '';
    }

    function hideCtxPop() {
        hideStatsPops();
    }

    function positionStatsPop(kind) {
        const pop = statsPopEl(kind);
        const btn = statsPopBtn(kind);
        if (!pop || !btn || !el.statsWrap) return;
        const wrapRect = el.statsWrap.getBoundingClientRect();
        const btnRect = btn.getBoundingClientRect();
        const width = pop.offsetWidth || 308;
        const left = Math.max(0, Math.min(Math.max(0, wrapRect.width - width), btnRect.left - wrapRect.left));
        pop.style.left = left + 'px';
        pop.style.right = 'auto';
    }

    function renderSessionPopover() {
        if (!el.sessionPop) return;
        const session = currentSession();
        if (!session) return;
        const totals = sessionUsageTotals(session);
        if (el.sessionPopTurns) el.sessionPopTurns.textContent = totals.rounds + ' 轮 ' + totals.steps + ' 步';
        if (el.sessionModel) el.sessionModel.textContent = totals.modelMs > 0 ? aiFormatCompactDuration(totals.modelMs) : '—';
        if (el.sessionTools) el.sessionTools.textContent = totals.hasTools ? aiFormatCompactDuration(totals.toolMs) : '—';
        if (el.sessionTtft) {
            el.sessionTtft.textContent = totals.ttftAvg > 0
                ? (totals.ttftAvg < 1000 ? (totals.ttftAvg / 1000).toFixed(2) : (totals.ttftAvg / 1000).toFixed(1)) + ' 秒'
                : '—';
        }
        if (el.sessionTps) el.sessionTps.textContent = totals.speed > 0 ? totals.speed + ' tok/s' : '—';
    }

    function renderTokenPopover() {
        if (!el.tokenPop) return;
        const session = currentSession();
        if (!session) return;
        const totals = sessionUsageTotals(session);
        const total = totals.total || (totals.prompt + totals.completion);
        const uncached = Math.max(0, totals.prompt - totals.cached);
        const hitRate = totals.prompt > 0 && totals.cached > 0 ? Math.round(totals.cached / totals.prompt * 100) : -1;
        if (el.tokenPopTotal) el.tokenPopTotal.textContent = total > 0 ? aiFormatExactCount(total) + ' tok' : '—';
        if (el.tokenHit) el.tokenHit.textContent = hitRate >= 0 ? hitRate + '%' : '—';
        if (el.tokenUncached) el.tokenUncached.textContent = totals.prompt > 0 ? aiFormatExactCount(uncached) + ' tok' : '—';
        if (el.tokenCached) el.tokenCached.textContent = totals.cached > 0 ? aiFormatExactCount(totals.cached) + ' tok' : '—';
        if (el.tokenOutput) el.tokenOutput.textContent = totals.completion > 0 ? aiFormatExactCount(totals.completion) + ' tok' : '—';
    }

    function toggleStatsPop(kind) {
        if (openStatsPop === kind) {
            hideStatsPops();
            return;
        }
        hideStatsPops();
        const pop = statsPopEl(kind);
        if (!pop) return;
        pop.classList.remove('hidden');
        openStatsPop = kind;
        positionStatsPop(kind);
        if (kind === 'ctx') void renderCtxPopover(true);
        else if (kind === 'session') renderSessionPopover();
        else renderTokenPopover();
    }

    function toggleCtxPop() {
        toggleStatsPop('ctx');
    }

    let ctxPopSeq = 0;
    async function renderCtxPopover(refreshSystem) {
        const seq = ++ctxPopSeq;
        const session = currentSession();
        if (!session || !el.ctxPop || el.ctxPop.classList.contains('hidden')) return;
        let systemText = lastSystemPrompt || AI_DEFAULT_SYSTEM_PROMPT;
        if (refreshSystem) {
            try {
                const bundle = await assembleSystemContext(session, attachments);
                lastSystemPrompt = bundle.text;
                lastContextMeta = bundle.meta;
                systemText = bundle.text;
            } catch (e) {}
        }
        if (seq !== ctxPopSeq || currentSession() !== session || el.ctxPop.classList.contains('hidden')) return;
        const profile = activeProfile();
        const windowSize = (profile && profile.contextWindow) || 128000;
        const messages = buildApiMessages(session, null, systemText);
        let systemTokens = 0;
        let messageTokens = 0;
        messages.forEach((message, index) => {
            const tokens = aiEstimateTokens(aiTextOf(message.content)) + aiImageStats([message]).tokens;
            if (index === 0 && message.role === 'system') systemTokens += tokens;
            else messageTokens += tokens;
        });
        for (const item of attachments) {
            messageTokens += item.kind === 'image' ? aiEstimateImageTokens(item) : aiEstimateTokens(aiTextOf(item.content));
        }
        const toolTokens = toolsTokenEstimate(session);
        const total = systemTokens + messageTokens + toolTokens;
        const pct = windowSize > 0 ? Math.round(total / windowSize * 100) : 0;
        if (el.ctxPopPct) el.ctxPopPct.textContent = pct + '%';
        if (el.ctxPopSize) el.ctxPopSize.textContent = '~' + aiFormatCompactTokens(total) + ' / ' + aiFormatCompactTokens(windowSize);
        const raw = [systemTokens, toolTokens, messageTokens].map((tokens) => windowSize > 0 ? tokens / windowSize * 100 : 0);
        const sum = raw.reduce((a, b) => a + b, 0);
        const scale = sum > 100 ? 100 / sum : 1;
        const nodes = [el.ctxSegSystem, el.ctxSegTools, el.ctxSegMessages];
        nodes.forEach((node, index) => {
            if (node) node.style.width = (raw[index] * scale).toFixed(2) + '%';
        });
        if (el.ctxTokSystem) el.ctxTokSystem.textContent = '~' + aiFormatCompactTokens(systemTokens);
        if (el.ctxTokTools) el.ctxTokTools.textContent = '~' + aiFormatCompactTokens(toolTokens);
        if (el.ctxTokMessages) el.ctxTokMessages.textContent = '~' + aiFormatCompactTokens(messageTokens);
    }

    // ---------- 路径 / 记忆 / 技能 ----------

    function aiNormalizePath(value) {
        const raw = aiTextOf(value).replace(/\\/g, '/');
        if (!raw) return '';
        const scheme = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i);
        let prefix = '';
        let rest = raw;
        if (scheme) {
            prefix = scheme[1] + '://';
            rest = raw.slice(scheme[0].length);
        } else {
            const drive = raw.match(/^[A-Za-z]:/);
            if (drive) {
                prefix = drive[0];
                rest = raw.slice(2);
            }
        }
        const absolute = rest.startsWith('/');
        const parts = [];
        for (const segment of rest.split('/')) {
            if (!segment || segment === '.') continue;
            if (segment === '..') {
                if (parts.length) parts.pop();
                continue;
            }
            parts.push(segment);
        }
        return prefix + (absolute ? '/' : '') + parts.join('/');
    }

    function aiPathDir(value) {
        return aiTextOf(value).replace(/[\\/][^\\/]*$/, '');
    }

    function aiIsAbsolutePath(value) {
        const text = aiTextOf(value);
        return /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('/') || text.startsWith('\\\\') || text.startsWith('mock://');
    }

    function aiJoinPath(root, rel) {
        const base = aiTextOf(root).replace(/[\\/]+$/, '');
        if (!rel || rel === '.') return base;
        if (aiIsAbsolutePath(rel)) return rel;
        const useBackslash = base.includes('\\') && !base.startsWith('mock://');
        return base + (useBackslash ? '\\' : '/') + String(rel).replace(/^\.?[\\/]+/, '');
    }

    function aiProjectRoot() {
        const context = getWorkspaceContext() || {};
        const workspace = aiTextOf(context.workspaceFolder);
        if (workspace) return workspace;
        if (context.activeFile && context.activeFile.path) return aiPathDir(context.activeFile.path);
        return getScopeRoot() || '';
    }

    function aiPathInside(root, path) {
        const r = aiNormalizePath(root).replace(/\/+$/, '').toLowerCase();
        const p = aiNormalizePath(path).toLowerCase();
        if (!r) return false;
        return p === r || p.startsWith(r + '/');
    }

    function aiResolveScopePath(value, session) {
        const root = getScopeRoot() || '';
        const rel = aiTextOf(value).trim() || '.';
        const absolute = aiIsAbsolutePath(rel);
        if (currentScopeOf(session || currentSession()) === 'full') {
            if (!root && !absolute) throw new Error('完全权限下没有工作区，请提供绝对路径');
            return absolute ? aiNormalizePath(rel) : aiNormalizePath(aiJoinPath(root, rel));
        }
        if (!root) throw new Error('当前没有工作区范围，请先打开文件或文件夹');
        const path = absolute ? aiNormalizePath(rel) : aiNormalizePath(aiJoinPath(root, rel));
        if (!aiPathInside(root, path)) throw new Error('路径超出工作区范围：' + rel);
        return path;
    }

    function getAIAppDir() {
        if (!appDirPromise) {
            appDirPromise = Promise.resolve(backend.AIAppDir ? backend.AIAppDir() : '').catch(() => '');
        }
        return appDirPromise;
    }

    async function resolveMemoryDir() {
        const project = aiProjectRoot();
        if (config.memoryMode === 'workspace' && project) {
            return {dir: aiNormalizePath(aiJoinPath(project, '.cadt/memory')), mode: 'workspace', project};
        }
        const app = aiNormalizePath(await getAIAppDir());
        if (!app) throw new Error('无法定位应用数据目录');
        if (config.memoryMode === 'workspace' && !project && !memoryFallbackNotified) {
            memoryFallbackNotified = true;
            flash('未打开工作区，记忆临时使用应用数据目录');
        }
        return {dir: aiNormalizePath(aiJoinPath(app, 'ai-memory')), mode: 'app', project};
    }

    async function resolveSkillDirs() {
        const dirs = [];
        const app = aiNormalizePath(await getAIAppDir());
        if (app) dirs.push({source: 'app', dir: aiNormalizePath(aiJoinPath(app, 'ai-skills'))});
        const project = aiProjectRoot();
        if (project) dirs.push({source: 'workspace', dir: aiNormalizePath(aiJoinPath(project, '.cadt/skills'))});
        return dirs;
    }

    async function readTextFile(path, maxChars) {
        if (!backend.OpenFile) throw new Error('当前版本不支持读取文件');
        const data = await backend.OpenFile(path, 'auto');
        if (!data) throw new Error('读取失败');
        if (data.isDir) throw new Error('这是目录，不是文件');
        if (data.large) throw new Error('文件过大（>10 MB）');
        if (data.binary) throw new Error('二进制文件不可作为文本读取');
        let text = aiTextOf(data.content);
        if (maxChars && text.length > maxChars) text = text.slice(0, maxChars) + '\n…（已截断）';
        return {text, data};
    }

    function parseSkillText(text, fallbackName) {
        let name = fallbackName;
        let description = '';
        let body = text;
        if (text.startsWith('---')) {
            const end = text.indexOf('\n---', 3);
            if (end > 0) {
                const front = text.slice(3, end);
                body = text.slice(end + 4).replace(/^\r?\n/, '');
                for (const line of front.split(/\r?\n/)) {
                    const nameMatch = line.match(/^\s*name:\s*(.*)$/i);
                    const descMatch = line.match(/^\s*description:\s*(.*)$/i);
                    if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, '') || name;
                    if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, '');
                }
            }
        }
        if (!description) {
            for (const line of body.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#') || trimmed === '---') continue;
                description = trimmed.slice(0, 80);
                break;
            }
        }
        return {name: name || fallbackName, description: description || '（无描述）', content: text};
    }

    let skillsCache = {at: 0, list: []};

    function skillSourceLabel(source) {
        if (source === 'builtin') return '内置';
        if (source === 'workspace') return '工作区';
        return '应用';
    }

    async function listSkillsRaw(force) {
        if (!force && Date.now() - skillsCache.at < 5000) return skillsCache.list;
        const merged = new Map();
        for (const builtin of AI_BUILTIN_SKILLS) {
            merged.set(builtin.name, {
                name: builtin.name,
                description: builtin.description,
                path: '',
                source: 'builtin',
                content: builtin.content,
                builtin: true,
            });
        }
        for (const source of await resolveSkillDirs()) {
            let listing;
            try {
                listing = await backend.ReadDir(source.dir, 500);
            } catch (e) {
                continue;
            }
            for (const entry of (listing && listing.entries) || []) {
                if (!entry || entry.isDir === undefined) continue;
                let path = null;
                let fallback = entry.name;
                if (entry.isDir) {
                    path = aiJoinPath(entry.path, 'SKILL.md');
                    if (!entry.name) fallback = 'skill';
                } else if (String(entry.name || '').toLowerCase().endsWith('.md')) {
                    path = entry.path;
                    fallback = String(entry.name).replace(/\.md$/i, '');
                }
                if (!path) continue;
                let read;
                try {
                    read = await readTextFile(path, 64 << 10);
                } catch (e) {
                    continue;
                }
                const skill = parseSkillText(read.text, fallback);
                merged.set(skill.name, {
                    name: skill.name,
                    description: skill.description,
                    path,
                    source: source.source,
                    content: read.text,
                    builtin: false,
                });
            }
        }
        const disabled = new Set((config.disabledSkills || []).map((name) => String(name).toLowerCase()));
        const list = [...merged.values()].map((skill) => ({
            ...skill,
            disabled: disabled.has(skill.name.toLowerCase()),
        })).sort((a, b) => a.name.localeCompare(b.name));
        skillsCache = {at: Date.now(), list};
        return list;
    }

    async function listSkills(force) {
        return (await listSkillsRaw(force)).filter((skill) => !skill.disabled);
    }

    function invalidateSkillsCache() {
        skillsCache = {at: 0, list: []};
    }

    const AI_TOOL_DEFS = {
        list_dir: {
            name: 'list_dir',
            description: '列出工作区范围内的目录条目。path 为相对范围根的路径，默认当前范围根。',
            parameters: {
                type: 'object',
                properties: {path: {type: 'string', description: '目录路径，默认 "."'}},
            },
        },
        read_file: {
            name: 'read_file',
            description: '读取工作区范围内的文本文件，单次最多 64KB。offset 为起始字符偏移量，默认 0。',
            parameters: {
                type: 'object',
                properties: {
                    path: {type: 'string', description: '相对范围根的文件路径'},
                    offset: {type: 'integer', description: '起始字符偏移，默认 0'},
                },
                required: ['path'],
            },
        },
        search_text: {
            name: 'search_text',
            description: '在工作区范围内搜索文本，返回命中文件、行号与预览（最多 200 条）。',
            parameters: {
                type: 'object',
                properties: {query: {type: 'string', description: '要搜索的文本'}},
                required: ['query'],
            },
        },
        memory_list: {
            name: 'memory_list',
            description: '列出持久记忆目录中的 Markdown 文件。',
            parameters: {type: 'object', properties: {}},
        },
        memory_read: {
            name: 'memory_read',
            description: '读取一个持久记忆文件（文件名必须是 .md，且不带路径）。',
            parameters: {
                type: 'object',
                properties: {name: {type: 'string', description: '记忆文件名，如 user-preferences.md'}},
                required: ['name'],
            },
        },
        memory_write: {
            name: 'memory_write',
            description: '写入持久记忆文件。用于记录用户偏好、项目事实与跨会话结论；写入后应同步维护 MEMORY.md 索引。',
            parameters: {
                type: 'object',
                properties: {
                    name: {type: 'string', description: '记忆文件名（安全字符，.md 结尾）'},
                    content: {type: 'string', description: '完整文件内容（最多 64KB）'},
                },
                required: ['name', 'content'],
            },
        },
        skill_use: {
            name: 'skill_use',
            description: '加载一个技能的完整 SKILL.md 指令并遵循它。所有范围档均可用。',
            parameters: {
                type: 'object',
                properties: {name: {type: 'string', description: '技能名称'}},
                required: ['name'],
            },
        },
        ask_user: {
            name: 'ask_user',
            description: '向用户提出一个或多个问题并等待回答。关键选择、补充信息或需要用户拍板时使用。最多 5 个问题，每题可单选或多选，可在最合理的一项上标记 recommended=true；不要用它询问可以自行查证的信息。',
            parameters: {
                type: 'object',
                properties: {
                    questions: {
                        type: 'array',
                        description: '1–5 个问题，一次向用户提出',
                        items: {
                            type: 'object',
                            properties: {
                                id: {type: 'string', description: '稳定问题 id（可省略）'},
                                question: {type: 'string', description: '清晰、具体的问题'},
                                header: {type: 'string', description: '可选短标题'},
                                detail: {type: 'string', description: '可选补充说明'},
                                options: {
                                    type: 'array',
                                    description: '0–8 个选项；无选项且允许自定义时显示输入框',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            label: {type: 'string', description: '选项标题'},
                                            description: {type: 'string', description: '选项说明（可选）'},
                                            recommended: {type: 'boolean', description: '是否为 AI 推荐项'},
                                        },
                                        required: ['label'],
                                    },
                                },
                                multiSelect: {type: 'boolean', description: '是否可多选，默认 false'},
                                allow_custom: {type: 'boolean', description: '是否允许自定义回答，默认 true'},
                            },
                            required: ['question'],
                        },
                    },
                },
                required: ['questions'],
            },
        },
        write_file: {
            name: 'write_file',
            description: '创建新文件或整体覆盖工作区内的文本文件。写操作会先显示 diff 并由用户审批；需「工作区内修改」或「完全权限」。',
            parameters: {
                type: 'object',
                properties: {
                    path: {type: 'string', description: '相对范围根的文件路径'},
                    content: {type: 'string', description: '完整文件内容（最多 256KB）'},
                },
                required: ['path', 'content'],
            },
        },
        edit_file: {
            name: 'edit_file',
            description: '在工作区文件中把唯一的 oldString 替换为 newString。oldString 必须逐字复制且只出现一次；写操作需审批；需「工作区内修改」或「完全权限」。',
            parameters: {
                type: 'object',
                properties: {
                    path: {type: 'string', description: '相对范围根的文件路径'},
                    oldString: {type: 'string', description: '要替换的原文，必须逐字唯一'},
                    newString: {type: 'string', description: '替换后的文本，可为空字符串表示删除'},
                },
                required: ['path', 'oldString', 'newString'],
            },
        },
        todo_write: {
            name: 'todo_write',
            description: '创建或更新当前会话的任务清单。多步任务先规划，每完成一步更新状态；需「工作区内修改」或「完全权限」。',
            parameters: {
                type: 'object',
                properties: {
                    todos: {
                        type: 'array',
                        description: '完整任务列表（最多 50 项），每次调用会整体替换旧列表',
                        items: {
                            type: 'object',
                            properties: {
                                content: {type: 'string', description: '任务描述'},
                                status: {type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '任务状态'},
                            },
                            required: ['content', 'status'],
                        },
                    },
                },
                required: ['todos'],
            },
        },
        run_command: {
            name: 'run_command',
            description: '在终端执行一条命令并返回退出码、stdout、stderr。shell 优先级：Git Bash → PowerShell 7 → Windows PowerShell → cmd。用于测试、构建、git 查看等；不要运行交互式或长驻命令。编辑档每条命令需用户审批，完全权限免审批。',
            parameters: {
                type: 'object',
                properties: {
                    command: {type: 'string', description: '要执行的完整命令'},
                    cwd: {type: 'string', description: '工作目录，默认范围根；完全权限下可为绝对路径'},
                    timeoutMs: {type: 'integer', description: '超时毫秒，默认 30000，最大 120000'},
                },
                required: ['command'],
            },
        },
    };

    function toolsForScope(scope, planMode) {
        const list = [
            AI_TOOL_DEFS.list_dir,
            AI_TOOL_DEFS.read_file,
            AI_TOOL_DEFS.search_text,
            AI_TOOL_DEFS.memory_list,
            AI_TOOL_DEFS.memory_read,
            AI_TOOL_DEFS.skill_use,
            AI_TOOL_DEFS.ask_user,
        ];
        if (!planMode) list.push(AI_TOOL_DEFS.memory_write);
        if (scope === 'edit' || scope === 'full') {
            list.push(AI_TOOL_DEFS.todo_write);
            if (!planMode) list.push(AI_TOOL_DEFS.write_file, AI_TOOL_DEFS.edit_file, AI_TOOL_DEFS.run_command);
        }
        return list;
    }

    const MEMORY_NAME_RULE = /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,64}\.md$/i;

    function memoryFileName(value) {
        const name = String(value == null ? '' : value).trim();
        if (!MEMORY_NAME_RULE.test(name) || name.includes('..')) throw new Error('记忆文件名无效（仅允许安全字符且以 .md 结尾）');
        return name;
    }

    // ---------- 行 diff 与写审批 ----------

    function aiPathKey(path) {
        return aiNormalizePath(path).replace(/\/+$/, '').toLowerCase();
    }

    function aiRelPath(root, path) {
        const base = aiNormalizePath(root).replace(/\/+$/, '');
        const full = aiNormalizePath(path);
        if (base && full.toLowerCase().startsWith(base.toLowerCase() + '/')) return full.slice(base.length + 1);
        return full;
    }

    function aiAddUnique(list, value) {
        if (!Array.isArray(list) || !value) return;
        const key = aiPathKey(value);
        if (!list.some((item) => aiPathKey(item) === key)) list.push(value);
    }

    function isPathApproved(session, path) {
        const key = aiPathKey(path);
        if ((config.approvedPaths || []).some((item) => aiPathKey(item) === key)) return true;
        return !!(session && (session.approvedPaths || []).some((item) => aiPathKey(item) === key));
    }

    function diffLinesOf(text) {
        const normalized = aiTextOf(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (!normalized) return [];
        const lines = normalized.split('\n');
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        return lines;
    }

    function computeLineDiff(oldText, newText) {
        const a = diffLinesOf(oldText);
        const b = diffLinesOf(newText);
        const ops = [];
        if (a.length + b.length > AI_DIFF_MAX_LINES || a.length * b.length > 4000000) {
            let start = 0;
            while (start < a.length && start < b.length && a[start] === b[start]) start++;
            let endA = a.length;
            let endB = b.length;
            while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
                endA--;
                endB--;
            }
            for (let i = 0; i < start; i++) ops.push({t: ' ', text: a[i]});
            for (let i = start; i < endA; i++) ops.push({t: '-', text: a[i]});
            for (let j = start; j < endB; j++) ops.push({t: '+', text: b[j]});
            for (let i = endA; i < a.length; i++) ops.push({t: ' ', text: a[i]});
            return ops;
        }
        const n = a.length;
        const m = b.length;
        const dp = new Array(n + 1);
        for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                dp[i][j] = a[i] === b[j]
                    ? dp[i + 1][j + 1] + 1
                    : Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < n && j < m) {
            if (a[i] === b[j]) {
                ops.push({t: ' ', text: a[i]});
                i++;
                j++;
            } else if (dp[i + 1][j] >= dp[i][j + 1]) {
                ops.push({t: '-', text: a[i]});
                i++;
            } else {
                ops.push({t: '+', text: b[j]});
                j++;
            }
        }
        while (i < n) ops.push({t: '-', text: a[i++]});
        while (j < m) ops.push({t: '+', text: b[j++]});
        return ops;
    }

    function diffStats(ops) {
        let added = 0;
        let removed = 0;
        for (const op of ops) {
            if (op.t === '+') added++;
            else if (op.t === '-') removed++;
        }
        return {added, removed};
    }

    function buildDiffPreview(ops) {
        const keep = new Array(ops.length).fill(false);
        let changed = false;
        for (let i = 0; i < ops.length; i++) {
            if (ops[i].t === ' ') continue;
            changed = true;
            for (let k = Math.max(0, i - 2); k <= Math.min(ops.length - 1, i + 2); k++) keep[k] = true;
        }
        if (!changed && ops.length) keep[0] = true;
        const lines = [];
        let last = -1;
        let truncated = false;
        for (let i = 0; i < ops.length; i++) {
            if (!keep[i]) continue;
            if (last >= 0 && i > last + 1) {
                if (lines.length >= AI_DIFF_PREVIEW_LIMIT) {
                    truncated = true;
                    break;
                }
                lines.push({t: '…', text: ''});
            }
            if (lines.length >= AI_DIFF_PREVIEW_LIMIT) {
                truncated = true;
                break;
            }
            lines.push({t: ops[i].t, text: ops[i].text});
            last = i;
        }
        return {lines, truncated};
    }

    async function readOptionalText(path) {
        try {
            const read = await readTextFile(path, null);
            return {exists: true, text: read.text, data: read.data};
        } catch (e) {
            const message = String((e && e.message) || e);
            if (/not exist|no such file|cannot find|找不到|不存在/i.test(message)) {
                return {exists: false, text: '', data: null};
            }
            throw e;
        }
    }

    function requestApproval(session, toolMessage, info) {
        const approval = {
            state: 'pending',
            tool: info.tool,
            path: info.path,
            relPath: info.relPath,
            added: info.added,
            removed: info.removed,
            newFile: info.newFile,
            dirty: isFileDirty(info.path),
            truncated: info.truncated,
            diff: info.diff,
            remember: '',
        };
        toolMessage.approval = approval;
        toolMessage.status = 'pending';
        toolMessage.content = '等待用户审批…';
        persistSessions();
        refreshToolWrap(session, toolMessage);
        const key = toolMessage.toolCallId || aiNowId('approval-');
        return new Promise((resolve) => {
            pendingApprovals.set(key, {session, toolMessage, resolve, approval});
        });
    }

    function requestCommandApproval(session, toolMessage, info) {
        const approval = {
            state: 'pending',
            kind: 'command',
            tool: 'run_command',
            command: info.command,
            cwd: info.cwd,
            remember: '',
        };
        toolMessage.approval = approval;
        toolMessage.status = 'pending';
        toolMessage.content = '等待用户审批命令…';
        persistSessions();
        refreshToolWrap(session, toolMessage);
        const key = toolMessage.toolCallId || aiNowId('approval-');
        return new Promise((resolve) => {
            pendingApprovals.set(key, {session, toolMessage, resolve, approval});
        });
    }

    function decideApproval(toolMessage, approved, remember) {
        if (!toolMessage) return;
        const key = toolMessage.toolCallId;
        const entry = pendingApprovals.get(key);
        if (!entry) return;
        pendingApprovals.delete(key);
        const approval = entry.approval;
        approval.state = approved ? 'approved' : 'denied';
        approval.remember = remember || '';
        if (approval.kind !== 'command') {
            if (approved && remember === 'always') {
                aiAddUnique(config.approvedPaths, approval.path);
                saveAIConfig();
                renderApprovedSettings();
            } else if (approved && remember === 'session' && entry.session) {
                aiAddUnique(entry.session.approvedPaths, approval.path);
            }
        }
        toolMessage.status = 'running';
        toolMessage.content = approval.kind === 'command'
            ? (approved ? '正在执行命令…' : '用户取消了本次命令')
            : (approved ? '正在应用更改…' : '用户放弃了本次更改');
        persistSessions();
        refreshToolWrap(entry.session, toolMessage);
        entry.resolve({approved: !!approved, remember: remember || ''});
    }

    function cancelPendingApprovals(reason) {
        for (const [key, entry] of pendingApprovals) {
            entry.approval.state = 'cancelled';
            entry.toolMessage.status = 'done';
            entry.toolMessage.content = reason || '审批已取消';
            pendingApprovals.delete(key);
            entry.resolve({approved: false, cancelled: true});
            refreshToolWrap(entry.session, entry.toolMessage);
        }
        if (pendingApprovals.size) pendingApprovals.clear();
        persistSessions();
    }

    function askTimeoutActionOf(ask) {
        const hasRecommended = (ask.questions || []).some((question) => question.options.some((option) => option.recommended));
        if (ask.timeoutAction === 'recommended' && !hasRecommended) {
            return 'ai_decide';
        }
        return ask.timeoutAction || 'recommended';
    }

    function askAnswerSummary(ask, answers) {
        for (const answer of answers || []) {
            if (answer && answer.selected && answer.selected.length) return answer.selected.join('、');
            if (answer && answer.custom) return answer.custom;
        }
        return '';
    }

    function formatAskAnswers(ask, answers, prefix) {
        const lines = [prefix];
        ask.questions.forEach((question, index) => {
            const answer = (answers || []).find((item) => item && item.id === question.id) || (answers || [])[index] || {selected: [], custom: ''};
            lines.push((index + 1) + '. ' + question.question);
            const selected = Array.isArray(answer.selected) ? answer.selected : [];
            if (selected.length) lines.push('   选择：' + selected.join('、'));
            if (answer.custom) lines.push('   补充：' + answer.custom);
            if (!selected.length && !answer.custom) lines.push('   未回答');
        });
        return lines.join('\n');
    }

    function removeAskDraft(key) {
        askDrafts.delete(key);
    }

    function askCountdownText(ask) {
        if (!ask || ask.state !== 'pending' || !ask.deadline) return '';
        const left = Math.max(0, Math.ceil((ask.deadline - Date.now()) / 1000));
        if (!left) return '';
        const action = askTimeoutActionOf(ask);
        const label = {recommended: '按 AI 推荐项继续', abort: '停止本轮', ai_decide: '交给 AI 决定'}[action] || '继续';
        const mm = Math.floor(left / 60);
        const ss = left % 60;
        return '超时后' + label + ' · 剩余 ' + mm + ':' + String(ss).padStart(2, '0');
    }

    function updateAskCountdown(entry) {
        if (!entry || !isOpen() || currentSession() !== entry.session) return;
        const key = entry.toolMessage.toolCallId || entry.key;
        panel.querySelectorAll('.ai-ask-countdown').forEach((node) => {
            if (node.dataset.askKey === key) node.textContent = askCountdownText(entry.ask);
        });
    }

    function clearAskTimers(entry) {
        if (!entry) return;
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.ticker) clearInterval(entry.ticker);
        entry.timer = 0;
        entry.ticker = 0;
    }

    function settleAsk(key, data) {
        const entry = pendingAsks.get(key);
        if (!entry) return;
        pendingAsks.delete(key);
        clearAskTimers(entry);
        removeAskDraft(key);
        const ask = entry.ask;
        ask.state = data.state;
        ask.answers = Array.isArray(data.answers) ? data.answers : (ask.answers || []);
        ask.answer = data.answer || askAnswerSummary(ask, ask.answers);
        ask.source = data.source || '';
        ask.answeredAt = Date.now();
        ask.deadline = 0;
        entry.toolMessage.status = 'done';
        entry.toolMessage.content = data.result;
        persistSessions();
        refreshToolWrap(entry.session, entry.toolMessage);
        updateComposerTakeover();
        entry.resolve(data.result);
        if (data.stop && entry.stream) {
            entry.stream.stopped = true;
            setTimeout(() => {
                if (stream === entry.stream) stopGeneration();
            }, 0);
        }
    }

    function handleAskTimeout(entry) {
        if (!entry || !pendingAsks.has(entry.key)) return;
        const action = askTimeoutActionOf(entry.ask);
        if (action === 'abort') {
            settleAsk(entry.key, {
                state: 'timeout_abort',
                result: '用户未在时限内回答（超时），已停止本轮。',
                stop: true,
            });
            return;
        }
        if (action === 'recommended') {
            const answers = entry.ask.questions.map((question) => {
                const recommended = question.options.filter((option) => option.recommended).map((option) => option.label);
                return {
                    id: question.id,
                    selected: question.multiSelect ? recommended : recommended.slice(0, 1),
                    custom: '',
                };
            });
            if (answers.some((answer) => answer.selected.length)) {
                settleAsk(entry.key, {
                    state: 'timeout',
                    answers,
                    answer: askAnswerSummary(entry.ask, answers),
                    source: 'timeout_recommended',
                    result: formatAskAnswers(entry.ask, answers, '用户未在时限内回答（超时），已自动采用推荐项：'),
                });
                return;
            }
        }
        settleAsk(entry.key, {
            state: 'timeout',
            source: 'timeout_ai',
            result: '用户未在时限内回答（超时）。请根据上下文自行决定每个问题的答案，并继续执行。',
        });
    }

    function setupAskTimer(entry) {
        if (!entry || !entry.ask.deadline) return;
        const delay = Math.max(0, entry.ask.deadline - Date.now());
        entry.timer = setTimeout(() => handleAskTimeout(entry), delay);
        entry.ticker = setInterval(() => updateAskCountdown(entry), 1000);
    }

    function submitAskAnswers(entry, answers) {
        if (!entry || !entry.ask || entry.ask.state !== 'pending') return;
        const normalized = entry.ask.questions.map((question, index) => {
            const source = answers && answers[index] ? answers[index] : {};
            let selected = Array.isArray(source.selected)
                ? source.selected.map((label) => aiTextOf(label)).filter((label) => question.options.some((option) => option.label === label))
                : [];
            selected = [...new Set(selected)];
            if (!question.multiSelect) selected = selected.slice(0, 1);
            let custom = aiTextOf(source.custom).trim().slice(0, 500);
            if (!question.multiSelect && custom) selected = [];
            return {id: question.id, selected, custom};
        });
        if (!normalized.some((answer) => answer.selected.length || answer.custom)) {
            flash('请至少回答一个问题', true);
            return;
        }
        settleAsk(entry.key, {
            state: 'answered',
            answers: normalized,
            answer: askAnswerSummary(entry.ask, normalized),
            source: 'user',
            result: formatAskAnswers(entry.ask, normalized, '用户回答：'),
        });
    }

    function cancelPendingAsks(reason) {
        for (const [key, entry] of pendingAsks) {
            clearAskTimers(entry);
            removeAskDraft(key);
            entry.ask.state = 'cancelled';
            entry.ask.answers = [];
            entry.ask.answer = '';
            entry.ask.source = 'cancelled';
            entry.ask.answeredAt = Date.now();
            entry.ask.deadline = 0;
            entry.toolMessage.status = 'done';
            entry.toolMessage.content = reason || '用户未回答';
            pendingAsks.delete(key);
            entry.resolve(reason || '用户未回答');
            refreshToolWrap(entry.session, entry.toolMessage);
        }
        if (pendingAsks.size) pendingAsks.clear();
        persistSessions();
        updateComposerTakeover();
    }

    function notifyAskRequested(session, toolMessage) {
        if (config.notifyAsk === false || !toolMessage.ask) return;
        const ask = toolMessage.ask;
        const first = ask.questions[0];
        const prefix = ask.questions.length > 1 ? ask.questions.length + ' 个问题：' : '';
        notifyDesktop({
            kind: 'ask',
            title: 'AI 需要你的回答',
            body: (session.title || '会话') + ' · ' + prefix + appToastPreview(first ? first.question : '', 80),
            sessionId: session.id,
        });
    }

    async function runAskQuestion(input, ctx) {
        if (!ctx || !ctx.session || !ctx.toolMessage) throw new Error('ask_user 缺少会话上下文');
        const questions = parseAskQuestions(input);
        if (!questions.length) throw new Error('ask_user 至少需要一个有效问题');
        const timeoutSec = aiClampInt(config.askTimeout, 0, 3600, 300);
        const timeoutAction = ['recommended', 'wait', 'abort', 'ai_decide'].includes(config.askTimeoutAction)
            ? config.askTimeoutAction
            : 'recommended';
        const useTimer = timeoutSec > 0 && timeoutAction !== 'wait';
        const ask = {
            questions,
            answers: questions.map((question) => ({id: question.id, selected: [], custom: ''})),
            state: 'pending',
            answer: '',
            source: '',
            deadline: useTimer ? Date.now() + timeoutSec * 1000 : 0,
            answeredAt: 0,
            timeoutSec,
            timeoutAction,
        };
        const toolMessage = ctx.toolMessage;
        toolMessage.ask = ask;
        toolMessage.status = 'pending';
        toolMessage.content = '等待用户回答…';
        persistSessions();
        return new Promise((resolve) => {
            const key = toolMessage.toolCallId || aiNowId('ask-');
            const entry = {key, session: ctx.session, toolMessage, ask, resolve, stream: ctx.stream, timer: 0, ticker: 0};
            pendingAsks.set(key, entry);
            setupAskTimer(entry);
            if (isOpen() && currentSession() === ctx.session) renderMessages(true);
            else refreshToolWrap(ctx.session, toolMessage);
            updateComposerTakeover();
            notifyAskRequested(ctx.session, toolMessage);
        });
    }

    function recordChange(session, info) {
        if (!session) return;
        session.changes.push({
            path: info.path,
            relPath: info.relPath,
            tool: info.tool,
            added: info.added,
            removed: info.removed,
            time: Date.now(),
        });
        if (session.changes.length > AI_CHANGES_LIMIT) {
            session.changes = session.changes.slice(-AI_CHANGES_LIMIT);
        }
        persistSessions();
        updateChangesUI();
    }

    function notifyFileChanged(path) {
        try {
            onFileChanged(path);
        } catch (e) {}
    }

    async function applyWorkspaceWrite(session, toolMessage, info) {
        const preApproved = currentScopeOf(session) === 'full' || isPathApproved(session, info.path);
        if (preApproved) {
            toolMessage.approval = {
                state: 'approved',
                tool: info.tool,
                path: info.path,
                relPath: info.relPath,
                added: info.added,
                removed: info.removed,
                newFile: info.newFile,
                dirty: isFileDirty(info.path),
                truncated: info.truncated,
                diff: info.diff,
                remember: 'pre',
            };
            toolMessage.status = 'running';
            toolMessage.content = '已授权，正在应用更改…';
            refreshToolWrap(session, toolMessage);
        } else {
            const decision = await requestApproval(session, toolMessage, info);
            if (!decision.approved) {
                return decision.cancelled
                    ? '用户已停止生成，写操作已取消。'
                    : '用户放弃了本次更改，文件未修改。';
            }
        }
        try {
            await backend.SaveFile(info.path, info.content, info.eol || '', !!info.hasBom, info.enc || 'utf-8');
        } catch (e) {
            if (toolMessage.approval) {
                toolMessage.approval.state = 'failed';
                toolMessage.approval.error = String((e && e.message) || e);
            }
            throw e;
        }
        recordChange(session, info);
        notifyFileChanged(info.path);
        return '已应用更改：' + info.relPath + '（+' + info.added + ' −' + info.removed + '）';
    }

    async function executeTool(name, args, ctx) {
        const input = args && typeof args === 'object' ? args : {};
        switch (name) {
            case 'list_dir': {
                const rel = aiTextOf(input.path).trim() || '.';
                const path = aiResolveScopePath(rel, ctx && ctx.session);
                const listing = await backend.ReadDir(path, 200);
                const entries = (listing && listing.entries) || [];
                const lines = ['目录：' + rel];
                for (const entry of entries) {
                    lines.push((entry.isDir ? '[D] ' : '[F] ') + entry.name);
                }
                if (!entries.length) lines.push('（空目录）');
                if (listing && listing.truncated) lines.push('…（条目过多已截断）');
                return lines.join('\n');
            }
            case 'read_file': {
                const path = aiResolveScopePath(input.path, ctx && ctx.session);
                const offset = Math.max(0, Math.round(Number(input.offset) || 0));
                const read = await readTextFile(path, null);
                let text = read.text;
                if (offset > 0) text = text.slice(Math.min(offset, text.length));
                if (text.length > 64 << 10) text = text.slice(0, 64 << 10) + '\n…（已截断，最多 64KB）';
                return '文件：' + (input.path || path) + '（' + read.data.size + ' 字节）\n\n' + text;
            }
            case 'search_text': {
                const query = aiTextOf(input.query).trim();
                if (!query) throw new Error('搜索内容为空');
                const root = getScopeRoot();
                if (!root) throw new Error('当前没有工作区范围，请先打开文件或文件夹');
                const result = await backend.SearchWorkspace(root, query, false, 200);
                const hits = (result && result.hits) || [];
                if (!hits.length) return '没有找到匹配：' + query;
                const rootNorm = aiNormalizePath(root).replace(/\/+$/, '');
                const lines = hits.map((hit) => {
                    let shown = aiNormalizePath(hit.path);
                    if (rootNorm && shown.toLowerCase().startsWith(rootNorm.toLowerCase() + '/')) {
                        shown = shown.slice(rootNorm.length + 1);
                    }
                    return shown + ':' + hit.line + ': ' + hit.preview;
                });
                if (result.truncated) lines.push('…（结果已截断）');
                return lines.join('\n');
            }
            case 'memory_list': {
                const mem = await resolveMemoryDir();
                if (backend.AIEnsureDir) await backend.AIEnsureDir(mem.dir);
                let listing;
                try {
                    listing = await backend.ReadDir(mem.dir, 200);
                } catch (e) {
                    return '记忆目录为空：' + mem.dir;
                }
                const files = (listing.entries || []).filter((entry) => !entry.isDir && /\.md$/i.test(entry.name));
                if (!files.length) return '记忆目录为空：' + mem.dir;
                return '记忆目录（' + mem.mode + '）：' + mem.dir + '\n' + files.map((file) => '- ' + file.name).join('\n');
            }
            case 'memory_read': {
                const name = memoryFileName(input.name);
                const mem = await resolveMemoryDir();
                const read = await readTextFile(aiJoinPath(mem.dir, name), 64 << 10);
                return '记忆文件：' + name + '\n\n' + read.text;
            }
            case 'memory_write': {
                const name = memoryFileName(input.name);
                let content = aiTextOf(input.content);
                if (!content.trim()) throw new Error('记忆内容为空');
                if (content.length > 60 << 10) {
                    content = content.slice(0, 60 << 10) + '\n…（内容过长，已截断到 60KB）';
                }
                const mem = await resolveMemoryDir();
                if (backend.AIEnsureDir) await backend.AIEnsureDir(mem.dir);
                await backend.SaveFile(aiJoinPath(mem.dir, name), content, 'lf', false, 'utf-8');
                return '已写入记忆 ' + name + '（' + content.length + ' 字符，' + mem.mode + '）';
            }
            case 'skill_use': {
                const name = aiTextOf(input.name).trim();
                if (!name) throw new Error('技能名称为空');
                const skills = await listSkills(true);
                const skill = skills.find((item) => item.name.toLowerCase() === name.toLowerCase());
                if (!skill) throw new Error('技能不存在：' + name);
                return '技能：' + skill.name + '（' + skillSourceLabel(skill.source) + '）\n\n' + skill.content + '\n\n请遵循该技能指令。';
            }
            case 'ask_user': {
                return await runAskQuestion(input, ctx);
            }
            case 'write_file': {
                if (!ctx || !ctx.session || !ctx.toolMessage) throw new Error('写操作缺少会话上下文');
                const path = aiResolveScopePath(input.path, ctx.session);
                const relPath = aiRelPath(getScopeRoot(), path);
                const content = aiTextOf(input.content);
                if (!content.trim()) throw new Error('文件内容为空');
                if (content.length > AI_WRITE_LIMIT) throw new Error('内容过长（上限 256KB）');
                const existing = await readOptionalText(path);
                if (existing.data && existing.data.size > 512 << 10) {
                    throw new Error('目标文件过大（>512KB），暂不支持 AI 改写');
                }
                const oldText = existing.exists ? existing.text : '';
                if (existing.exists && oldText === content) return '文件内容未变化：' + relPath;
                const ops = computeLineDiff(oldText, content);
                const stats = diffStats(ops);
                const preview = buildDiffPreview(ops);
                return applyWorkspaceWrite(ctx.session, ctx.toolMessage, {
                    tool: 'write_file',
                    path,
                    relPath,
                    content,
                    eol: existing.exists ? existing.data.eol : '',
                    hasBom: existing.exists ? !!existing.data.hasBom : false,
                    enc: existing.exists ? existing.data.enc : 'utf-8',
                    newFile: !existing.exists,
                    added: stats.added,
                    removed: stats.removed,
                    truncated: preview.truncated,
                    diff: preview.lines,
                });
            }
            case 'edit_file': {
                if (!ctx || !ctx.session || !ctx.toolMessage) throw new Error('写操作缺少会话上下文');
                const path = aiResolveScopePath(input.path, ctx.session);
                const relPath = aiRelPath(getScopeRoot(), path);
                const oldString = aiTextOf(input.oldString);
                const newString = aiTextOf(input.newString);
                if (!oldString) throw new Error('oldString 不能为空');
                if (oldString === newString) throw new Error('oldString 与 newString 相同，无需修改');
                if (newString.length > AI_WRITE_LIMIT) throw new Error('newString 过长（上限 256KB）');
                const existing = await readOptionalText(path);
                if (!existing.exists) throw new Error('文件不存在：' + relPath + '（新建文件请用 write_file）');
                if (existing.data && existing.data.size > 512 << 10) {
                    throw new Error('目标文件过大（>512KB），暂不支持 AI 改写');
                }
                const text = existing.text;
                let needle = oldString;
                let replacement = newString;
                let first = text.indexOf(needle);
                if (first < 0 && text.includes('\r\n') && !oldString.includes('\r')) {
                    // 模型常把 CRLF 文件里的 oldString 写成 LF；仅在精确匹配失败时按文件换行重试一次。
                    needle = oldString.replace(/\r?\n/g, '\r\n');
                    replacement = newString.replace(/\r?\n/g, '\r\n');
                    first = text.indexOf(needle);
                }
                if (first < 0) throw new Error('未找到 oldString，请先 read_file 并逐字复制（注意缩进与换行）');
                const second = text.indexOf(needle, first + needle.length);
                if (second >= 0) throw new Error('oldString 多处命中（至少 2 处），请提供更长的唯一上下文');
                const next = text.slice(0, first) + replacement + text.slice(first + needle.length);
                if (next === text) return '文件内容未变化：' + relPath;
                const ops = computeLineDiff(text, next);
                const stats = diffStats(ops);
                const preview = buildDiffPreview(ops);
                return applyWorkspaceWrite(ctx.session, ctx.toolMessage, {
                    tool: 'edit_file',
                    path,
                    relPath,
                    content: next,
                    eol: existing.data.eol,
                    hasBom: !!existing.data.hasBom,
                    enc: existing.data.enc,
                    newFile: false,
                    added: stats.added,
                    removed: stats.removed,
                    truncated: preview.truncated,
                    diff: preview.lines,
                });
            }
            case 'todo_write': {
                if (!ctx || !ctx.session) throw new Error('todo_write 缺少会话上下文');
                if (!Array.isArray(input.todos)) throw new Error('todos 必须是数组');
                if (input.todos.length > AI_TODO_LIMIT) throw new Error('任务过多（上限 ' + AI_TODO_LIMIT + ' 项）');
                const list = [];
                for (const item of input.todos) {
                    const content = aiTextOf(item && item.content).replace(/\s+/g, ' ').trim();
                    if (!content) throw new Error('任务内容不能为空');
                    const status = item && item.status;
                    if (!['pending', 'in_progress', 'completed'].includes(status)) {
                        throw new Error('任务状态无效：' + aiTextOf(status));
                    }
                    list.push({content: content.slice(0, 200), status});
                }
                const session = ctx.session;
                session.todos = list;
                const state = todoStates.get(session.id);
                if (state) {
                    clearTimeout(state.timer);
                    todoStates.delete(session.id);
                }
                persistSessions();
                if (isOpen() && currentSession() === session) renderTodos();
                const done = list.filter((todo) => todo.status === 'completed').length;
                return '已更新任务清单：' + list.length + ' 项（' + done + ' 项已完成）';
            }
            case 'run_command': {
                if (!ctx || !ctx.session || !ctx.toolMessage) throw new Error('命令执行缺少会话上下文');
                const command = aiTextOf(input.command).trim();
                if (!command) throw new Error('命令不能为空');
                if (!backend.AIRunShellCommand) throw new Error('当前版本不支持执行命令');
                const cwd = aiResolveScopePath(aiTextOf(input.cwd).trim() || '.', ctx.session);
                const timeoutMs = aiClampInt(input.timeoutMs, 1000, 120000, 30000);
                const preApproved = currentScopeOf(ctx.session) === 'full';
                if (!preApproved) {
                    const decision = await requestCommandApproval(ctx.session, ctx.toolMessage, {command, cwd});
                    if (!decision.approved) {
                        return decision.cancelled
                            ? '用户已停止生成，命令未执行。'
                            : '用户取消了本次命令，未执行。';
                    }
                }
                ctx.toolMessage.status = 'running';
                ctx.toolMessage.content = '执行中…';
                refreshToolWrap(ctx.session, ctx.toolMessage);
                let result;
                try {
                    result = await backend.AIRunShellCommand(command, cwd, timeoutMs);
                } catch (e) {
                    const approval = ctx.toolMessage.approval;
                    if (approval && approval.kind === 'command') {
                        approval.state = 'failed';
                        approval.error = String((e && e.message) || e);
                    }
                    throw e;
                }
                const clip = (text) => {
                    const value = aiTextOf(text).replace(/\r\n/g, '\n').trimEnd();
                    return value.length > 16000 ? value.slice(0, 16000) + '\n…（输出已截断）' : value;
                };
                const lines = [
                    '命令：' + command,
                    'Shell：' + ((result && result.shell) || '未知') +
                        ' · 退出码：' + (result && result.code != null ? result.code : -1) +
                        ' · 用时：' + ((result && result.durationMs) || 0) + ' ms',
                ];
                if (result && result.timedOut) lines.push('（命令超时，已终止；以下为已捕获输出）');
                const stdout = clip(result && result.stdout);
                const stderr = clip(result && result.stderr);
                if (stdout) lines.push('stdout：\n' + stdout);
                if (stderr) lines.push('stderr：\n' + stderr);
                if (!stdout && !stderr) lines.push('（无输出）');
                return lines.join('\n');
            }
            default:
                throw new Error('未知工具：' + name);
        }
    }

    function workspaceRulesText(scope, planMode) {
        if (scope !== 'read' && scope !== 'edit' && scope !== 'full') return '';
        const root = getScopeRoot() || '';
        const full = scope === 'full';
        const scopeText = scope === 'edit'
            ? '编辑档：可读取工作区、写入持久记忆，并通过 write_file / edit_file 修改工作区文件，可用 run_command 执行命令（每条命令先经用户审批）。工作区写操作会先显示 diff 并由用户审批；已授权文件除外。'
            : (full
                ? '完全权限：可读取与修改工作区内外文件，写操作与终端命令不再请求审批。请严格按用户意图操作，避免破坏性改动。'
                : '读取档：可列目录、读文件、搜索文本、读写持久记忆；不要尝试修改工作区文件或执行命令。');
        const lines = [
            '<workspace_rules>',
            '范围根：' + (root || '（未打开工作区）'),
            scopeText + (planMode ? '（当前为计划模式：不提供 write_file / edit_file，只做只读探索并输出计划）' : ''),
            '工具守则：',
            full ? '- 路径参数可使用绝对路径；相对路径按范围根解析。' : '- 路径参数相对范围根；禁止访问范围外路径。',
            '- 先 list_dir / read_file 确认事实，再回答或引用。',
            '- search_text 用于定位文本，结果不足时改用 read_file。',
            '- memory_* 用于用户偏好、项目事实与跨会话结论；写后更新 MEMORY.md 索引。',
            '- skill_use 返回技能全文；加载后遵循其中指令。',
            '- ask_user 用于必须由用户拍板的关键选择；问题与选项要具体，能在某一项上给出推荐时标记 recommended=true；不要用它询问可以自行查证的信息。',
            ...(planMode ? [
                '- 计划模式：只做只读探索并输出计划；不要调用写工具或 run_command（它们也不可用）。',
            ] : []),
            ...(scope === 'edit' || full ? [
                ...(planMode ? [] : [
                    '- 修改文件前必须先 read_file 确认内容；不要凭记忆构造 oldString。',
                    '- edit_file 的 oldString 必须逐字复制且只出现一次；多处命中时请扩大上下文使其唯一，未命中时重新读取文件。',
                    '- write_file 用于新建文件或整体覆盖；不要修改 .git 等版本库内部文件。',
                    '- run_command 用于测试、构建、git 查看等一次性命令；不要运行交互式或长驻命令，必要时用 timeoutMs 控制超时。',
                ]),
                '- 多步任务先用 todo_write 规划，并在每完成一步后更新任务状态。',
                ...(full && !planMode ? ['- 完全权限下没有审批兜底（含终端命令）：破坏性操作前先向用户说明。'] : []),
                ...(scope === 'edit' && !planMode ? ['- 写操作被用户放弃时，按用户意图调整方案，不要重复发起同一改动。'] : []),
            ] : []),
            '</workspace_rules>',
        ];
        return lines.join('\n');
    }

    function formatAttachmentBlock(item) {
        if (!item) return '';
        if (item.kind === 'skill') {
            return '<skill_manual name="' + item.label.replace(/"/g, '&quot;') + '">\n' + item.content + '\n</skill_manual>';
        }
        const attrs = ' name="' + String(item.label || '').replace(/"/g, '&quot;') + '"' +
            (item.path ? ' path="' + String(item.path).replace(/"/g, '&quot;') + '"' : '');
        return '<attachment' + attrs + '>\n' + item.content + '\n</attachment>';
    }

    async function assembleSystemContext(session, attachmentList) {
        const base = effectiveSystemPrompt(session);
        const parts = [base];
        if (session && session.planMode) {
            parts.push([
                '<plan_mode>',
                '当前处于计划模式：只允许只读探索与 ask_user，write_file / edit_file / run_command 不可用。',
                '请输出一份可执行的 Markdown 计划：目标、涉及文件、按顺序的步骤、验证方式、风险与回滚。',
                '不要开始实现；用户会在界面上点击「执行计划」后才进入执行。',
                '</plan_mode>',
            ].join('\n'));
        }
        const meta = {
            agents: {loaded: false, chars: 0, path: ''},
            memory: {loaded: false, chars: 0, path: '', mode: ''},
            skills: {count: 0, names: []},
            workspace: {loaded: false, files: 0},
            attachments: {count: 0, chars: 0},
            errors: [],
        };

        if (settings.aiInjectAgentsMd !== false) {
            const project = aiProjectRoot();
            if (project) {
                const path = aiJoinPath(project, 'AGENTS.md');
                try {
                    const read = await readTextFile(path, 64 << 10);
                    parts.push('<agents_md path="' + path.replace(/"/g, '&quot;') + '">\n' + read.text + '\n</agents_md>');
                    meta.agents = {loaded: true, chars: read.text.length, path};
                } catch (e) {
                    meta.agents.path = path;
                }
            }
        }

        try {
            const mem = await resolveMemoryDir();
            const read = await readTextFile(aiJoinPath(mem.dir, 'MEMORY.md'), 8 << 10);
            parts.push('<memory mode="' + mem.mode + '" path="' + mem.dir.replace(/"/g, '&quot;') + '">\n' + read.text + '\n</memory>');
            meta.memory = {loaded: true, chars: read.text.length, path: mem.dir, mode: mem.mode};
        } catch (e) {
            meta.memory.error = (e && e.message) || String(e);
        }

        try {
            const skills = await listSkills();
            if (skills.length) {
                parts.push('<skills>\n' + skills.map((skill) =>
                    '- ' + skill.name + '：' + skill.description + '（' + skillSourceLabel(skill.source) + '）'
                ).join('\n') + '\n</skills>');
                meta.skills = {count: skills.length, names: skills.map((skill) => skill.name)};
            }
        } catch (e) {
            meta.errors.push('技能索引：' + ((e && e.message) || e));
        }

        if (settings.aiInjectContext !== false) {
            const context = getWorkspaceContext() || {};
            const lines = ['<workspace_context>'];
            const root = getScopeRoot() || '';
            if (root) lines.push('范围根：' + root);
            if (context.activeFile && context.activeFile.path) {
                lines.push('当前活动文件：' + context.activeFile.path);
            }
            const openFiles = Array.isArray(context.openFiles) ? context.openFiles.slice(0, 20) : [];
            if (openFiles.length) {
                lines.push('已打开文件：');
                for (const path of openFiles) lines.push('- ' + path);
            }
            lines.push('</workspace_context>');
            parts.push(lines.join('\n'));
            meta.workspace = {loaded: true, files: openFiles.length};
        }

        const rules = workspaceRulesText(currentScopeOf(session), !!(session && session.planMode));
        if (rules) parts.push(rules);

        if (attachmentList && attachmentList.length) {
            const blocks = attachmentList.map(formatAttachmentBlock).filter(Boolean);
            if (blocks.length) {
                parts.push('<attachments>\n' + blocks.join('\n\n') + '\n</attachments>');
                meta.attachments = {
                    count: attachmentList.length,
                    chars: attachmentList.reduce((sum, item) => sum + aiTextOf(item.content).length, 0),
                };
            }
        }

        return {text: parts.join('\n\n'), meta};
    }

    function currentScopeOf(session) {
        const scope = session && session.scope;
        return ['read', 'edit', 'full'].includes(scope) ? scope : 'read';
    }

    // ---------- 流式对话 ----------

    function setStreamingUI(active) {
        if (el.stop) el.stop.classList.toggle('hidden', !active);
        if (el.send) el.send.classList.toggle('hidden', !!active);
        if (el.input) {
            el.input.placeholder = active
                ? '输入消息：Enter 排队，Ctrl+Enter 插话'
                : '发消息或粘贴图片；/ 调用指令，@ 提及文件';
        }
        updateSendState();
        updateComposerTakeover();
        if (stream) {
            const profile = activeProfile();
            if (el.hint) el.hint.textContent = '生成中 · Enter 排队 · Ctrl+Enter 插话' + (profile && profile.model ? ' · ' + profile.model : '');
        } else if (oneShot) {
            if (el.hint) el.hint.textContent = '正在压缩上下文…';
        }
        renderMessageQueue();
    }

    function updateSendState() {
        if (!el.send) return;
        const hasProfile = !!activeProfile();
        const busy = !!stream || !!oneShot;
        const session = currentSession();
        const archived = !!(session && session.archivedAt);
        const hasText = !!(el.input && el.input.value.trim());
        const hasImages = attachments.some((item) => item.kind === 'image');
        el.send.disabled = !hasProfile || busy || archived || (!hasText && !hasImages);
        if (el.stop) el.stop.classList.toggle('hidden', !busy);
        if (el.send) el.send.classList.toggle('hidden', busy);
        if (!busy && el.hint) {
            el.hint.textContent = archived ? '会话已归档，取消归档后可继续' : (hasProfile ? '' : '未配置 AI，请先在设置中配置');
        }
    }

    function scheduleStreamRender() {
        if (!stream || stream.renderTimer) return;
        stream.renderTimer = setTimeout(() => {
            if (!stream) return;
            stream.renderTimer = 0;
            if (!isOpen()) return;
            const session = currentSession();
            if (!session || session.id !== stream.sessionId) return;
            const index = session.messages.indexOf(stream.assistant);
            if (index < 0) return;
            let wrap = el.messages.querySelector('.ai-msg.assistant[data-ai-idx="' + index + '"]');
            if (!wrap) return;
            updateAssistantElement(wrap, stream.assistant, true);
            positionOverlays();
            if (stickBottom) scrollToBottom(false);
            else updateScrollButton();
        }, 80);
    }

    function newAssistantMessage(profile) {
        return {
            role: 'assistant',
            content: '',
            reasoning: '',
            thinkingSignature: '',
            model: profile && profile.model ? profile.model : '',
            ts: Date.now(),
            status: 'streaming',
            usage: null,
            error: '',
            toolCalls: [],
        };
    }

    function sessionById(id) {
        return sessions.find((session) => session.id === id) || null;
    }

    function refreshToolWrap(session, toolMessage) {
        if (!session || !isOpen() || currentSession() !== session) return;
        const index = session.messages.indexOf(toolMessage);
        const wrap = el.messages.querySelector('.ai-msg.tool[data-ai-idx="' + index + '"]');
        if (!wrap) {
            renderMessages(true);
            return;
        }
        wrap.innerHTML = '';
        renderToolMessage(wrap, toolMessage);
    }

    async function submitText(text, truncateAt) {
        const value = String(text == null ? '' : text).trim();
        const imageAttachments = attachments.filter((item) => item.kind === 'image').map(aiNormalizeImage).filter(Boolean);
        const textAttachments = attachments.filter((item) => item.kind !== 'image');
        if ((!value && !imageAttachments.length) || stream || oneShot) return false;
        if (value.length > AI_CHAT_INPUT_LIMIT) {
            flash('消息过长（上限 ' + AI_CHAT_INPUT_LIMIT + ' 字符）', true);
            return false;
        }
        const session = currentSession();
        if (!session) return false;
        if (session.archivedAt) {
            flash('该会话已归档，请先在会话菜单中取消归档', true);
            return false;
        }
        const profile = activeProfile();
        if (!profile) {
            renderMessages();
            updateSendState();
            return false;
        }
        if (!backend.AISendChat) {
            showNote('当前版本不支持 AI 对话（后端方法缺失）。', true);
            return false;
        }

        let cut = truncateAt;
        if (cut == null && pendingEdit && pendingEdit.index != null) cut = pendingEdit.index;
        const windowSize = profile.contextWindow || 128000;
        try {
            const previewBundle = await assembleSystemContext(session, textAttachments);
            const previewMessages = buildApiMessages(session, cut != null && cut >= 0 ? cut : null, previewBundle.text);
            let previewTokens = aiEstimateTokens(previewMessages.map((message) => aiTextOf(message.content)).join('\n')) +
                aiEstimateTokens(value) +
                aiImageStats(previewMessages).tokens;
            for (const item of imageAttachments) previewTokens += aiEstimateImageTokens(item);
            for (const item of textAttachments) previewTokens += aiEstimateTokens(aiTextOf(item.content));
            previewTokens += toolsTokenEstimate(session);
            if (windowSize > 0 && previewTokens > windowSize * 0.9) {
                flash('上下文预计约 ' + previewTokens + ' tokens，超过窗口 ' + windowSize +
                    ' 的 90%，请先 /compact 或减少附加内容', true);
                updateCtxBanner();
                return false;
            }
        } catch (e) {}

        if (cut != null && cut >= 0) session.messages = session.messages.slice(0, cut);
        pendingEdit = null;

        const turnStartedAt = Date.now();
        session.messages.push({
            role: 'user',
            content: value,
            images: imageAttachments,
            ts: turnStartedAt,
            turnStartedAt,
        });
        updateSessionTitleFromText(session, value || '图片对话');
        renderSessionList();
        queueLogSave(session);
        session.profileId = profile.id;
        const scope = currentScopeOf(session);
        session.scope = scope;
        const assistant = newAssistantMessage(profile);
        assistant.planMode = !!session.planMode;
        session.messages.push(assistant);
        session.round = (Number(session.round) || 0) + 1;
        const baseRound = session.round;

        stream = {
            sessionId: session.id,
            baseRound,
            roundNo: 0,
            roundId: session.id + '#' + baseRound + '-0',
            assistant,
            startedAt: turnStartedAt,
            thinkStartedAt: 0,
            roundStartedAt: 0,
            firstTokenAt: 0,
            renderTimer: 0,
            finished: false,
            stopped: false,
            toolCalls: new Map(),
            tools: toolsForScope(scope, !!session.planMode),
            profileCfg: configForProfile(profile),
            systemPrompt: AI_DEFAULT_SYSTEM_PROMPT,
            scope,
            plan: !!session.planMode,
        };
        stickBottom = true;
        if (el.input) {
            el.input.value = '';
            resizeInput();
        }
        hideSlash();
        renderMessages();
        setStreamingUI(true);
        positionOverlays();

        let bundle = {text: AI_DEFAULT_SYSTEM_PROMPT, meta: null};
        const attachmentList = textAttachments.slice();
        try {
            bundle = await assembleSystemContext(session, attachmentList);
        } catch (e) {
            showNote('上下文注入失败：' + ((e && e.message) || e), true);
        }
        lastSystemPrompt = bundle.text;
        lastContextMeta = bundle.meta;
        attachments = [];
        attachSeq = 0;
        renderAttachments();
        updateContextCount();
        if (!stream || stream.sessionId !== session.id || stream.stopped) return true;
        stream.systemPrompt = bundle.text;
        startRound();
        return true;
    }

    function startRound() {
        const s = stream;
        if (!s) return;
        const session = sessionById(s.sessionId);
        if (!session) {
            finishStream();
            return;
        }
        if (s.stopped) {
            if (s.assistant.status === 'streaming') s.assistant.status = 'stopped';
            finishStream();
            return;
        }
        if (s.roundNo >= 15) {
            showNote('已达到 15 轮工具调用上限，自动结束本轮。');
            if (s.assistant.status === 'streaming') s.assistant.status = 'done';
            finishStream();
            return;
        }
        s.roundNo += 1;
        s.roundId = session.id + '#' + s.baseRound + '-' + s.roundNo;
        s.thinkStartedAt = 0;
        s.roundStartedAt = Date.now();
        s.firstTokenAt = 0;
        s.toolCalls.clear();
        const index = session.messages.indexOf(s.assistant);
        if (index < 0) {
            finishStream();
            return;
        }
        if (isOpen() && currentSession() === session) {
            const wrap = el.messages.querySelector('.ai-msg.assistant[data-ai-idx="' + index + '"]');
            if (wrap) updateAssistantElement(wrap, s.assistant, true);
        }
        const apiMessages = buildApiMessages(session, index, s.systemPrompt);
        try {
            const result = backend.AISendChat(s.roundId, s.profileCfg, apiMessages, s.tools);
            if (result && typeof result.then === 'function') {
                result.catch((e) => {
                    if (stream !== s) return;
                    finishStreamError((e && e.message) || String(e || '请求失败'));
                });
            }
        } catch (e) {
            finishStreamError((e && e.message) || String(e || '请求失败'));
        }
    }

    function finishStreamError(message) {
        if (!stream) return;
        stream.assistant.status = 'error';
        stream.assistant.error = String(message || '请求失败');
        finishStream();
    }

    const TOAST_ICONS = {
        success: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="5.7" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5.4 8.2l1.8 1.8 3.4-3.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        error: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="5.7" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6 6l4 4M10 6l-4 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
        ask: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="5.7" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6.3 6.3a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".75" fill="currentColor"/></svg>',
    };

    function appToastPreview(text, max) {
        const clean = String(text || '')
            .replace(/```[\s\S]*?```/g, ' [代码] ')
            .replace(/[#>*_`~]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return clean.length > max ? clean.slice(0, max) + '…' : clean;
    }

    function showAppToast(options) {
        const host = document.getElementById('app-toasts');
        if (!host) return;
        const kind = options.kind || 'info';
        const toast = document.createElement('div');
        toast.className = 'app-toast ' + kind;
        const icon = document.createElement('span');
        icon.className = 'app-toast-icon';
        icon.innerHTML = TOAST_ICONS[kind === 'success' ? 'success' : (kind === 'error' ? 'error' : 'ask')];
        const main = document.createElement('div');
        main.className = 'app-toast-main';
        const title = document.createElement('div');
        title.className = 'app-toast-title';
        title.textContent = options.title || '';
        const body = document.createElement('div');
        body.className = 'app-toast-body';
        body.textContent = options.body || '';
        main.append(title, body);
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'app-toast-close';
        close.title = '关闭通知';
        close.textContent = '×';
        toast.append(icon, main, close);
        let timer = 0;
        const dismiss = () => {
            if (timer) clearTimeout(timer);
            timer = 0;
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 180);
        };
        close.addEventListener('click', (e) => {
            e.stopPropagation();
            dismiss();
        });
        toast.addEventListener('click', () => {
            if (options.sessionId && sessions.some((session) => session.id === options.sessionId)) {
                ensureOpen();
                switchSession(options.sessionId);
            }
            dismiss();
        });
        host.appendChild(toast);
        while (host.children.length > 3) host.firstElementChild.remove();
        requestAnimationFrame(() => toast.classList.add('show'));
        timer = setTimeout(dismiss, 9000);
    }

    function notifyDesktop(options) {
        const inApp = config.notifyInApp !== false;
        const system = config.notifySystem === true;
        if (!inApp && !system) return;
        if (inApp) showAppToast(options);
        if (system && backend.NotifySystemToast) {
            try {
                backend.NotifySystemToast(options.title || 'CaDt-DataLens', options.body || '', config.notifySound === false);
            } catch (e) {}
        }
        if (!inApp) return;
        const unfocused = document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus());
        if (!unfocused) return;
        if (backend.NotifyAttention) {
            try {
                backend.NotifyAttention(!!config.notifySound);
            } catch (e) {}
        }
    }

    function notifyTurnFinished(session, assistant, stopped) {
        if (!session || !assistant || stopped || assistant.status === 'stopped') return;
        if (assistant.status === 'error') {
            if (config.notifyError === false) return;
            notifyDesktop({
                kind: 'error',
                title: 'AI 任务失败',
                body: (session.title || '会话') + ' · ' + (assistant.error || '请求失败'),
                sessionId: session.id,
            });
            return;
        }
        if (assistant.status !== 'done' || !String(assistant.content || '').trim()) return;
        if (config.notifyFinish === false) return;
        notifyDesktop({
            kind: 'success',
            title: 'AI 任务完成',
            body: (session.title || '会话') + ' · ' + appToastPreview(assistant.content, 90),
            sessionId: session.id,
        });
    }

    function commitThinkTime(s) {
        if (!s || !s.assistant || !s.thinkStartedAt || s.assistant.thinkMs) return;
        s.assistant.thinkMs = Math.max(0, Date.now() - s.thinkStartedAt);
    }

    function markFirstToken(s) {
        if (s && !s.firstTokenAt) s.firstTokenAt = Date.now();
    }

    function commitRoundTiming(s) {
        if (!s || !s.assistant) return;
        const started = Number(s.roundStartedAt) || 0;
        if (!started) return;
        s.assistant.modelMs = Math.max(0, Date.now() - started);
        s.assistant.firstTokenMs = s.firstTokenAt ? Math.max(0, s.firstTokenAt - started) : 0;
        s.roundStartedAt = 0;
    }

    function finishStream() {
        const current = stream;
        if (!current) return;
        if (current.renderTimer) {
            clearTimeout(current.renderTimer);
            current.renderTimer = 0;
        }
        current.finished = true;
        commitThinkTime(current);
        commitRoundTiming(current);
        if (current.assistant.status === 'streaming') current.assistant.status = 'done';
        const session = sessionById(current.sessionId);
        if (session) {
            const idx = session.messages.indexOf(current.assistant);
            if (idx >= 0) {
                current.assistant.finishedAt = Date.now();
                const started = turnStartAt(session, idx);
                if (started) current.assistant.turnMs = Math.max(0, current.assistant.finishedAt - started);
            }
        }
        notifyTurnFinished(session, current.assistant, current.stopped);
        const shouldFlush = interjectPending || (!current.stopped && current.assistant.status === 'done');
        interjectPending = false;
        stream = null;
        stopProcessTicker();
        persistSessions();
        renderSessionList();
        queueLogSave(session);
        if (session && currentSession() === session && isOpen()) {
            renderMessages(true);
        }
        setStreamingUI(false);
        updateContextCount();
        updateScrollButton();
        updateComposerTakeover(true);
        if (shouldFlush) {
            if (session) flushMessageQueue(session.id);
            const viewing = currentSession();
            if (viewing && (!session || viewing.id !== session.id)) flushMessageQueue(viewing.id);
        }
    }

    async function handleToolRound(s, calls) {
        if (stream !== s) return;
        const session = sessionById(s.sessionId);
        if (!session) {
            finishStream();
            return;
        }
        commitThinkTime(s);
        persistSessions();
        const requestingAssistant = s.assistant;
        const toolStartedAt = Date.now();
        let toolTimingSaved = false;
        const saveToolTiming = () => {
            if (toolTimingSaved) return;
            toolTimingSaved = true;
            if (!requestingAssistant) return;
            requestingAssistant.toolMs = (Number(requestingAssistant.toolMs) || 0) + Math.max(0, Date.now() - toolStartedAt);
            persistSessions();
        };
        const allowedTools = new Set((s.tools || toolsForScope(s.scope, s.plan)).map((tool) => tool.name));
        for (const call of calls) {
            if (stream !== s || s.stopped) {
                saveToolTiming();
                return;
            }
            const toolMessage = {
                role: 'tool',
                toolCallId: call.id,
                name: call.name,
                arguments: call.arguments,
                content: '',
                status: 'running',
                ts: Date.now(),
            };
            session.messages.push(toolMessage);
            if (isOpen() && currentSession() === session) renderMessages(true);
            let result = null;
            try {
                if (!allowedTools.has(call.name)) throw new Error('当前范围不允许工具：' + call.name);
                const parsed = call.arguments ? JSON.parse(call.arguments) : {};
                result = await executeTool(call.name, parsed, {session, toolMessage, stream: s});
            } catch (e) {
                if (stream === s) {
                    toolMessage.status = 'error';
                    toolMessage.content = '工具执行失败：' + ((e && e.message) || e);
                }
            }
            if (stream !== s || s.stopped) {
                saveToolTiming();
                return;
            }
            if (result != null) {
                toolMessage.status = 'done';
                toolMessage.content = String(result);
            }
            persistSessions();
            refreshToolWrap(session, toolMessage);
        }
        if (stream !== s || s.stopped) {
            saveToolTiming();
            return;
        }
        if (s.roundNo >= 15) {
            saveToolTiming();
            showNote('已达到 15 轮工具调用上限，自动结束本轮。');
            if (s.assistant.status === 'streaming') s.assistant.status = 'done';
            finishStream();
            return;
        }
        const profile = activeProfile();
        const assistant = newAssistantMessage(profile);
        assistant.planMode = !!s.plan;
        session.messages.push(assistant);
        s.assistant = assistant;
        s.thinkStartedAt = 0;
        if (isOpen() && currentSession() === session) {
            renderMessages(true);
            setStreamingUI(true);
        }
        saveToolTiming();
        startRound();
    }

    function handleEvent(name, payload) {
        if (oneShot && payload && payload.id === oneShot.id) {
            if (name === 'ai-chunk' && payload.delta) {
                oneShot.buffer += payload.delta;
                if (el.hint) el.hint.textContent = '正在压缩上下文… 已生成 ' + oneShot.buffer.length + ' 字符';
            } else if (name === 'ai-done') {
                finishCompact(payload);
            } else if (name === 'ai-error') {
                const message = String(payload.message || '请求失败');
                oneShot = null;
                setStreamingUI(false);
                updateSendState();
                showNote('压缩失败：' + message, true);
            }
            return;
        }
        if (!stream || !payload || payload.id !== stream.roundId) return;
        const current = stream;
        switch (name) {
            case 'ai-chunk':
                if (payload.delta) {
                    markFirstToken(current);
                    current.assistant.content += payload.delta;
                    scheduleStreamRender();
                }
                break;
            case 'ai-think':
                if (payload.delta) {
                    markFirstToken(current);
                    if (!current.thinkStartedAt) current.thinkStartedAt = Date.now();
                    current.assistant.reasoning += payload.delta;
                    scheduleStreamRender();
                }
                break;
            case 'ai-toolcall': {
                markFirstToken(current);
                const index = Number(payload.index) || 0;
                let call = current.toolCalls.get(index);
                if (!call) {
                    call = {id: '', name: '', arguments: ''};
                    current.toolCalls.set(index, call);
                }
                if (payload.callId) call.id = payload.callId;
                if (payload.name) call.name = payload.name;
                if (payload.argsDelta) call.arguments += payload.argsDelta;
                break;
            }
            case 'ai-done': {
                if (current.renderTimer) {
                    clearTimeout(current.renderTimer);
                    current.renderTimer = 0;
                }
                commitRoundTiming(current);
                if (payload.thinkingSignature) current.assistant.thinkingSignature = payload.thinkingSignature;
                if (payload.usage) current.assistant.usage = payload.usage;
                if (payload.finishReason === 'stopped') {
                    current.assistant.status = 'stopped';
                    finishStream();
                    return;
                }
                const calls = [...current.toolCalls.values()]
                    .filter((call) => call.name)
                    .map((call, index) => ({
                        id: call.id || ('call_' + current.roundNo + '_' + index),
                        name: call.name,
                        arguments: call.arguments || '{}',
                    }));
                if (payload.finishReason === 'tool' && calls.length) {
                    current.assistant.status = 'done';
                    current.assistant.toolCalls = calls;
                    const session = sessionById(current.sessionId);
                    const idx = session ? session.messages.indexOf(current.assistant) : -1;
                    const wrap = idx >= 0 ? el.messages.querySelector('.ai-msg.assistant[data-ai-idx="' + idx + '"]') : null;
                    if (wrap) updateAssistantElement(wrap, current.assistant, false);
                    handleToolRound(current, calls);
                    return;
                }
                current.assistant.status = 'done';
                finishStream();
                break;
            }
            case 'ai-error':
                finishStreamError(payload.message || '请求失败');
                break;
            default:
                break;
        }
    }

    function stopGeneration() {
        if (!stream) {
            if (oneShot) cancelOneShot();
            return;
        }
        const current = stream;
        const sessionId = current.sessionId;
        current.stopped = true;
        cancelPendingApprovals('用户已停止生成，写操作已取消');
        cancelPendingAsks('用户已停止生成，问题未回答');
        try {
            if (backend.AIStop) backend.AIStop(sessionId);
        } catch (e) {}
        // 后端若没有及时回 ai-done，兜底结束，避免界面一直卡在“生成中”。
        setTimeout(() => {
            if (stream !== current) return;
            const session = sessionById(sessionId);
            if (session) {
                for (const message of session.messages) {
                    if (message.role === 'tool' && message.status === 'running') {
                        message.status = 'error';
                        message.content = '用户已停止';
                    }
                }
            }
            if (current.assistant.status === 'streaming') current.assistant.status = 'stopped';
            if (session && currentSession() === session) renderMessages(true);
            finishStream();
        }, 1200);
    }

    // ---------- 范围与附加内容 ----------

    let editHintShown = new Set();

    function currentScope() {
        return currentScopeOf(currentSession());
    }

    function scopeLabel(scope) {
        if (scope === 'full') return '完全权限';
        if (scope === 'edit') return '工作区内修改';
        return '仅可查看';
    }

    function updateScopeUI() {
        const session = currentSession();
        if (el.permission) {
            const scope = currentScope();
            el.permission.textContent = scopeLabel(scope);
            const root = getScopeRoot() || '';
            el.permission.title = '权限：' + scopeLabel(scope) + '\n' + (root ? '范围根：' + root : '未打开工作区');
            el.permission.classList.toggle('active', scope === 'full');
        }
        if (el.plan) {
            const plan = !!(session && session.planMode);
            el.plan.classList.toggle('active', plan);
            el.plan.setAttribute('aria-pressed', String(plan));
            el.plan.textContent = plan ? '计划 · 开' : '计划';
            el.plan.title = plan
                ? '计划模式已开启：AI 只读探索并给出计划，批准后再执行'
                : '计划模式：先只读探索并给出计划，批准后执行';
        }
    }

    function applyScope(scope) {
        const session = currentSession();
        if (!session) return;
        session.scope = scope;
        persistSessions();
        updateScopeUI();
        updateSendState();
        if (scope !== 'full' && !getScopeRoot()) {
            showNote('当前没有工作区范围：请先打开文件或文件夹，工具才能执行。', true);
        }
        if (scope === 'edit' && !editHintShown.has(session.id)) {
            editHintShown.add(session.id);
            flash('已切换为「工作区内修改」：AI 写文件前会显示 diff、执行命令前会请求确认');
        }
        if (scope === 'full' && !editHintShown.has('full-' + session.id)) {
            editHintShown.add('full-' + session.id);
            flash('已启用「完全权限」：写操作与终端命令不再审批，且可访问工作区外路径');
        }
    }

    function confirmFullPermission(onConfirm) {
        const warning = dialogNode('div', 'ai-dialog-hint',
            '启用完全权限后，AI 可以直接修改文件、在终端执行命令且不再逐次审批，并且可以访问工作区外路径。仅建议在你信任当前任务时使用。');
        warning.style.color = 'var(--red)';
        const label = document.createElement('label');
        label.className = 'ai-dialog-hint';
        label.style.display = 'flex';
        label.style.alignItems = 'center';
        label.style.gap = '6px';
        const check = document.createElement('input');
        check.type = 'checkbox';
        label.append(check, document.createTextNode('我已了解风险，并愿意继续'));
        const cancel = dialogButton('取消', 'dlg-btn', closeAIDialog);
        const enable = dialogButton('启用完全权限', 'dlg-btn primary', () => {
            if (!check.checked) return;
            closeAIDialog();
            onConfirm();
        });
        enable.disabled = true;
        check.addEventListener('change', () => { enable.disabled = !check.checked; });
        openAIDialog('确认启用完全权限？', [warning, label], [cancel, enable]);
    }

    function setScope(scope) {
        if (!['read', 'edit', 'full'].includes(scope)) return;
        const session = currentSession();
        if (!session) return;
        if (scope === 'full') {
            if (currentScopeOf(session) === 'full') return;
            confirmFullPermission(() => applyScope('full'));
            return;
        }
        applyScope(scope);
    }

    function setPlanMode(on, announce) {
        const session = currentSession();
        if (!session) return false;
        if (stream || oneShot) {
            if (announce !== false) flash('生成中不能切换计划模式', true);
            return false;
        }
        session.planMode = !!on;
        persistSessions();
        updateScopeUI();
        updateSendState();
        if (!stream) renderMessages(true);
        renderMessageQueue();
        if (announce !== false) {
            flash(session.planMode ? '已开启计划模式：AI 只读探索后给出计划' : '已关闭计划模式');
        }
        return true;
    }

    function togglePlanMode() {
        const session = currentSession();
        if (!session) return;
        setPlanMode(!session.planMode);
        if (el.input) el.input.focus();
    }

    function handlePlanCommand(arg) {
        const value = String(arg || '').trim();
        if (value.toLowerCase() === 'off' || value === '关闭') {
            setPlanMode(false);
            return;
        }
        if (!setPlanMode(true, !value)) return;
        if (value) void submitText(value);
    }

    function showPermissionMenu() {
        if (!el.permission || !showContextMenu) return;
        const rect = el.permission.getBoundingClientRect();
        const scope = currentScope();
        showContextMenu([
            {label: '仅可查看', checked: scope === 'read', action: () => setScope('read')},
            {label: '工作区内修改', checked: scope === 'edit', action: () => setScope('edit')},
            {label: '完全权限', checked: scope === 'full', action: () => setScope('full')},
        ], rect.left, rect.top - 104);
    }

    function reasoningLevelOf(profile) {
        if (!profile || profile.provider !== 'anthropic') return 'auto';
        if (!profile.thinking) return 'off';
        const budget = Number(profile.thinkingBudget) || 8000;
        if (budget <= 2048) return 'low';
        if (budget <= 10000) return 'medium';
        return 'high';
    }

    function reasoningLabel(profile) {
        if (!profile || profile.provider !== 'anthropic') return '自动';
        return {off: '关', low: '低', medium: '中', high: '高'}[reasoningLevelOf(profile)] || '中';
    }

    function effortLabel(profile) {
        if (!profile) return '';
        if (profile.provider === 'anthropic') return reasoningLabel(profile);
        return {low: '低', medium: '中', high: '高'}[profile.reasoningEffort] || '自动';
    }

    function renderModelChip() {
        if (!el.modelChip) return;
        const profile = activeProfile();
        if (!profile) {
            el.modelChip.textContent = '选择模型';
            el.modelChip.title = '未配置模型，点击打开设置';
            return;
        }
        const model = profile.model || profile.name || '未命名模型';
        el.modelChip.textContent = model + ' · ' + effortLabel(profile);
        el.modelChip.title = '模型：' + model + '\n配置：' + profile.name + '\n推理强度：' + effortLabel(profile);
    }

    function switchProfile(id) {
        if (!config.profiles.some((profile) => profile.id === id)) return;
        config.activeProfileId = id;
        saveAIConfig();
        renderProfileSelect();
        refreshSettingsPane();
        updateComposerState();
        if (isOpen()) renderMessages(true);
    }

    function setReasoningLevel(level) {
        const profile = activeProfile();
        if (!profile) return;
        if (profile.provider !== 'anthropic') {
            profile.reasoningEffort = ['low', 'medium', 'high'].includes(level) ? level : '';
            saveAIConfig();
            refreshSettingsPane();
            renderModelChip();
            flash('推理强度：' + effortLabel(profile));
            return;
        }
        if (level === 'off') {
            profile.thinking = false;
        } else {
            profile.thinking = true;
            profile.thinkingBudget = level === 'low' ? 1024 : (level === 'high' ? 16000 : 8000);
            clampThinkingBudget(profile, 'thinking');
        }
        saveAIConfig();
        refreshSettingsPane();
        renderModelChip();
        flash('推理等级：' + reasoningLabel(profile));
    }

    function showModelMenu() {
        if (!el.modelChip || !showContextMenu) return;
        const rect = el.modelChip.getBoundingClientRect();
        const current = activeProfile();
        const modelItems = config.profiles.map((profile) => ({
            label: (profile.model || profile.name) + ' · ' + profile.name,
            checked: current && profile.id === current.id,
            action: () => switchProfile(profile.id),
        }));
        modelItems.push({sep: true});
        modelItems.push({label: '模型设置…', action: () => openSettings('models')});
        const levelItems = current && current.provider === 'anthropic'
            ? [
                {label: '关闭', checked: reasoningLevelOf(current) === 'off', action: () => setReasoningLevel('off')},
                {label: '低（1024）', checked: reasoningLevelOf(current) === 'low', action: () => setReasoningLevel('low')},
                {label: '中（8000）', checked: reasoningLevelOf(current) === 'medium', action: () => setReasoningLevel('medium')},
                {label: '高（16000）', checked: reasoningLevelOf(current) === 'high', action: () => setReasoningLevel('high')},
            ]
            : [
                {label: '自动（由模型决定）', checked: !(current && current.reasoningEffort), action: () => setReasoningLevel('auto')},
                {label: '低', checked: !!(current && current.reasoningEffort === 'low'), action: () => setReasoningLevel('low')},
                {label: '中', checked: !!(current && current.reasoningEffort === 'medium'), action: () => setReasoningLevel('medium')},
                {label: '高', checked: !!(current && current.reasoningEffort === 'high'), action: () => setReasoningLevel('high')},
            ];
        showContextMenu([
            {label: '模型', submenu: modelItems},
            {label: current && current.provider === 'anthropic' ? '推理等级' : '推理强度', submenu: levelItems},
        ], rect.left, rect.top - 96);
    }

    function showAttachMenu() {
        if (!el.attachBtn || !showContextMenu) return;
        const rect = el.attachBtn.getBoundingClientRect();
        showContextMenu([
            {label: '当前文件', action: () => attachCurrentFile()},
            {label: '选中内容', action: () => attachSelection()},
            {label: '附加文件…', action: () => attachFilesDialog()},
            {label: '技能…', action: () => showSkillPicker()},
            {sep: true},
            {label: '指令', submenu: [
                {label: '压缩上下文', action: () => startCompact()},
                {label: '初始化 AGENTS.md', action: () => runInitAgentsMd()},
                {label: '提示词…', action: () => showPromptDialog()},
                {label: '记忆管理…', action: () => showMemoryDialog()},
                {label: '技能管理…', action: () => showSkillsDialog()},
            ]},
        ], rect.left, rect.top - 240);
    }

    function showMoreMenu() {
        if (!el.moreBtn || !showContextMenu) return;
        const rect = el.moreBtn.getBoundingClientRect();
        const items = floatWindow ? [
            {label: '新建会话', action: () => newSession()},
            {label: '重命名会话…', action: () => renameSession()},
            {label: '删除会话', action: () => deleteSession()},
            {label: '导出会话…', action: () => exportSession()},
            {sep: true},
        ] : [];
        items.push(
            {label: '提示词…', action: () => showPromptDialog()},
            {label: '记忆管理…', action: () => showMemoryDialog()},
            {label: '技能管理…', action: () => showSkillsDialog()},
            {sep: true},
            {label: '对话日志目录…', action: openAILogDir},
            {label: '模型设置…', action: () => openSettings('models')},
        );
        showContextMenu(items, rect.left - 160, rect.bottom + 4);
    }

    function renderAttachments() {
        if (!el.attach) return;
        el.attach.innerHTML = '';
        el.attach.classList.toggle('hidden', !attachments.length);
        for (const item of attachments) {
            const chip = document.createElement('span');
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'ai-chip-remove';
            remove.title = '移除';
            remove.textContent = '×';
            remove.addEventListener('click', () => {
                attachments = attachments.filter((current) => current.id !== item.id);
                renderAttachments();
                updateContextCount();
            });
            if (item.kind === 'image') {
                chip.className = 'ai-chip ai-chip-image';
                chip.title = item.name + (item.width && item.height ? ' · ' + item.width + '×' + item.height : '');
                const img = document.createElement('img');
                img.className = 'ai-chip-img';
                img.src = aiImageSrc(item);
                img.alt = item.name || '图片';
                img.draggable = false;
                img.addEventListener('click', () => showImagePreview(item));
                chip.append(img, remove);
            } else {
                chip.className = 'ai-chip';
                const label = document.createElement('span');
                label.className = 'ai-chip-label';
                label.textContent = (item.kind === 'skill' ? '技能 · ' : (item.kind === 'selection' ? '选中 · ' : '文件 · ')) + item.label;
                label.title = item.path || item.label;
                chip.append(label, remove);
            }
            el.attach.appendChild(chip);
        }
        updateContextCount();
        updateSendState();
    }

    function addAttachment(item) {
        if (!item) return false;
        if (item.kind === 'image') {
            if (!item.data) return false;
            if (attachments.filter((current) => current.kind === 'image').length >= AI_IMAGE_LIMIT) {
                flash('每条消息最多附加 ' + AI_IMAGE_LIMIT + ' 张图片', true);
                return false;
            }
            const currentBytes = attachments
                .filter((current) => current.kind === 'image')
                .reduce((sum, current) => sum + sessionImageBytes([current]), 0);
            if (currentBytes + item.data.length > AI_IMAGE_MESSAGE_BUDGET) {
                flash('图片总量超过上限，请减少图片或先发送当前消息', true);
                return false;
            }
            item.id = 'att-' + (++attachSeq);
            attachments.push(item);
            renderAttachments();
            el.input && el.input.focus();
            return true;
        }
        if (!item.content) return false;
        if (item.content.length > 64 << 10) {
            item.content = item.content.slice(0, 64 << 10) + '\n…（已截断到 64KB）';
        }
        const total = attachments.reduce((sum, current) => sum + aiTextOf(current.content).length, 0);
        if (total + item.content.length > 256 << 10) {
            flash('附加内容总量超过 256KB，请减少文件或选区', true);
            return false;
        }
        const duplicate = attachments.some((current) => {
            if (item.kind === 'skill' && current.kind === 'skill') {
                return current.label === item.label;
            }
            if (item.kind === 'selection' && current.kind === 'selection') {
                return current.content === item.content;
            }
            if (item.kind === 'file' && current.kind === 'file') {
                return !!item.path && current.path === item.path;
            }
            return false;
        });
        if (duplicate) {
            flash('该内容已经附加');
            return false;
        }
        item.id = 'att-' + (++attachSeq);
        attachments.push(item);
        renderAttachments();
        el.input && el.input.focus();
        return true;
    }

    function loadImageElement(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                resolve(img);
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('无法读取图片'));
            };
            img.src = url;
        });
    }

    async function prepareImageAttachment(file) {
        if (!file) throw new Error('没有图片数据');
        if (file.size > AI_IMAGE_MAX_INPUT_BYTES) throw new Error('图片超过 12MB');
        let source = file;
        let width = 0;
        let height = 0;
        if (typeof createImageBitmap === 'function') {
            source = await createImageBitmap(file);
            width = source.width;
            height = source.height;
        } else {
            source = await loadImageElement(file);
            width = source.naturalWidth || source.width;
            height = source.naturalHeight || source.height;
        }
        const scale = Math.min(1, AI_IMAGE_MAX_DIM / Math.max(width || 1, height || 1));
        const outWidth = Math.max(1, Math.round(width * scale));
        const outHeight = Math.max(1, Math.round(height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = outWidth;
        canvas.height = outHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('无法创建图片画布');
        ctx.drawImage(source, 0, 0, outWidth, outHeight);
        if (source && typeof source.close === 'function') source.close();
        let mime = 'image/png';
        let dataUrl = canvas.toDataURL('image/png');
        if (dataUrl.length > AI_IMAGE_MAX_BASE64) {
            let quality = 0.86;
            mime = 'image/jpeg';
            dataUrl = canvas.toDataURL(mime, quality);
            while (dataUrl.length > AI_IMAGE_MAX_BASE64 && quality > 0.45) {
                quality -= 0.1;
                dataUrl = canvas.toDataURL(mime, quality);
            }
        }
        if (dataUrl.length > AI_IMAGE_MAX_BASE64) throw new Error('压缩后图片仍然过大');
        const comma = dataUrl.indexOf(',');
        if (comma < 0) throw new Error('图片编码失败');
        return {
            mime,
            data: dataUrl.slice(comma + 1),
            width: outWidth,
            height: outHeight,
            bytes: Math.round((dataUrl.length - comma - 1) * 3 / 4),
            name: (file.name && file.name !== 'image.png') ? file.name : '粘贴的图片',
        };
    }

    async function handleInputPaste(e) {
        const data = e.clipboardData;
        if (!data || !data.items) return;
        const files = [];
        for (const item of data.items) {
            if (item && item.kind === 'file' && String(item.type || '').startsWith('image/')) {
                const file = item.getAsFile();
                if (file) files.push(file);
            }
        }
        if (!files.length) return;
        const text = data.getData('text/plain');
        if (!text) e.preventDefault();
        const room = AI_IMAGE_LIMIT - attachments.filter((item) => item.kind === 'image').length;
        if (room <= 0) {
            flash('每条消息最多附加 ' + AI_IMAGE_LIMIT + ' 张图片', true);
            return;
        }
        for (const file of files.slice(0, room)) {
            try {
                const prepared = await prepareImageAttachment(file);
                prepared.kind = 'image';
                prepared.label = prepared.name;
                addAttachment(prepared);
            } catch (err) {
                flash('图片处理失败：' + ((err && err.message) || err), true);
            }
        }
        if (files.length > room) flash('超出图片数量上限，已附加 ' + room + ' 张', true);
    }

    async function attachPath(path, opts) {
        if (!path) return false;
        try {
            const read = await readTextFile(path, 64 << 10);
            const name = (read.data && read.data.name) || String(path).split(/[\\/]/).pop();
            return addAttachment({kind: 'file', label: name, path, content: read.text});
        } catch (e) {
            flash('附加文件失败：' + ((e && e.message) || e), true);
            return false;
        }
    }

    async function attachCurrentFile() {
        const context = getWorkspaceContext() || {};
        const path = context.activeFile && context.activeFile.path;
        if (!path) {
            flash('当前没有打开的文件', true);
            return false;
        }
        return attachPath(path, {focus: true});
    }

    function attachSelection() {
        const selection = getSelection ? getSelection() : null;
        if (!selection || !aiTextOf(selection.text).trim()) {
            flash('当前没有选中的内容', true);
            return false;
        }
        return addAttachment({
            kind: 'selection',
            label: selection.name || '选中内容',
            path: selection.path || '',
            content: selection.text,
        });
    }

    async function attachFilesDialog() {
        if (!pickFiles) {
            flash('当前版本不支持选择附加文件', true);
            return;
        }
        let paths;
        try {
            paths = await pickFiles();
        } catch (e) {
            flash('选择文件失败：' + ((e && e.message) || e), true);
            return;
        }
        if (!paths || !paths.length) return;
        for (const path of paths) {
            await attachPath(path);
        }
    }

    async function showSkillPicker() {
        let skills;
        try {
            skills = await listSkills(true);
        } catch (e) {
            showNote('读取技能失败：' + ((e && e.message) || e), true);
            return;
        }
        if (!skills.length) {
            showNote('未找到技能。技能目录：应用数据 ai-skills 与工作区 .cadt/skills。', true);
            return;
        }
        if (!showContextMenu) {
            return;
        }
        const rect = el.attachSkill ? el.attachSkill.getBoundingClientRect() : {right: 200, bottom: 200};
        showContextMenu(skills.map((skill) => ({
            label: skill.name + ' — ' + skill.description,
            action: () => {
                addAttachment({
                    kind: 'skill',
                    label: skill.name,
                    path: skill.path,
                    content: skill.content,
                });
            },
        })), rect.right + 4, rect.bottom + 4);
    }

    function refreshContext() {
        updateScopeUI();
        updateContextCount();
        refreshMemoryPath();
    }

    // ---------- 常用消息操作 ----------

    function findMessageWrap(index) {
        return el.messages.querySelector('.ai-msg[data-ai-idx="' + index + '"]');
    }

    function copyMessage(message) {
        if (!message) return;
        copyText(message.content || '', 'AI 消息');
    }

    function selectAllAIText() {
        if (!el.messages || !window.getSelection) return;
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el.messages);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    function showAIMessageContextMenu(event) {
        if (!showContextMenu) return;
        const selection = window.getSelection ? window.getSelection() : null;
        const selectedText = selection ? String(selection.toString() || '') : '';
        const anchor = selection && selection.anchorNode;
        const selectionInside = !!(anchor && el.messages && (el.messages === anchor || el.messages.contains(anchor)));
        const wrap = event.target && event.target.closest ? event.target.closest('.ai-msg') : null;
        const index = wrap ? Number(wrap.dataset.aiIdx) : -1;
        const session = currentSession();
        const message = session && Number.isInteger(index) && index >= 0 ? session.messages[index] : null;
        const codeEl = event.target && event.target.closest ? event.target.closest('.ai-md pre, .ai-md code') : null;
        const codeText = codeEl ? String(codeEl.textContent || '') : '';
        const items = [];
        if (selectedText.trim() && selectionInside) {
            items.push({label: '复制所选', shortcut: 'Ctrl+C', icon: 'E8C8', action: () => copyText(selectedText, '所选文本')});
        }
        if (codeText.trim()) {
            items.push({label: '复制代码', icon: 'E8C8', action: () => copyText(codeText, '代码')});
        }
        if (message) {
            const label = message.role === 'assistant' ? '复制整条回复' : (message.role === 'user' ? '复制这条消息' : '复制工具输出');
            items.push({label, icon: 'E8C8', action: () => copyMessage(message)});
        }
        if (items.length) items.push({sep: true});
        items.push({label: '全选对话', action: selectAllAIText});
        showContextMenu(items, event.clientX, event.clientY);
    }

    function attachmentsFromImages(images) {
        return (images || []).filter((image) => image && image.data).map((image) => ({
            kind: 'image',
            label: image.name || '图片',
            mime: image.mime,
            data: image.data,
            width: image.width,
            height: image.height,
        }));
    }

    function regenerateLast() {
        if (stream) return;
        const session = currentSession();
        if (!session) return;
        const assistantIndex = lastAssistantIndex(session);
        if (assistantIndex < 0) return;
        const userIndex = lastUserIndex(session);
        if (userIndex < 0) return;
        const userMessage = session.messages[userIndex];
        const userText = userMessage.content;
        const images = attachmentsFromImages(userMessage.images);
        session.messages = session.messages.slice(0, userIndex);
        attachments = images;
        renderAttachments();
        persistSessions();
        submitText(userText, userIndex);
    }

    function retryLast() {
        regenerateLast();
    }

    function editLast() {
        if (stream) return;
        const session = currentSession();
        if (!session) return;
        const userIndex = lastUserIndex(session);
        if (userIndex < 0) return;
        const message = session.messages[userIndex];
        if (!el.input) return;
        el.input.value = message.content;
        attachments = attachmentsFromImages(message.images);
        renderAttachments();
        pendingEdit = {index: userIndex};
        resizeInput();
        updateSendState();
        if (el.hint) el.hint.textContent = '编辑中：发送将从这条消息重新开始';
        el.input.focus();
        const end = el.input.value.length;
        el.input.setSelectionRange(end, end);
    }

    function handleMessageClick(e) {
        const approveBtn = e.target.closest('[data-ai-approve]');
        if (approveBtn) {
            const wrap = approveBtn.closest('.ai-msg');
            const session = currentSession();
            const index = wrap ? Number(wrap.dataset.aiIdx) : -1;
            const message = session && index >= 0 ? session.messages[index] : null;
            if (message) {
                const card = approveBtn.closest('.ai-tool-card');
                const always = card && card.querySelector('input[data-ai-remember="always"]');
                const sessionBox = card && card.querySelector('input[data-ai-remember="session"]');
                const remember = always && always.checked ? 'always' : (sessionBox && sessionBox.checked ? 'session' : '');
                decideApproval(message, approveBtn.dataset.aiApprove === 'apply', remember);
            }
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        const button = e.target.closest('.ai-msg-action');
        if (!button) return;
        const wrap = button.closest('.ai-msg');
        if (!wrap) return;
        const index = Number(wrap.dataset.aiIdx);
        const session = currentSession();
        const message = session && session.messages[index];
        if (!message) return;
        const action = button.dataset.aiAct;
        if (action === 'copy') copyMessage(message);
        else if (action === 'edit') editLast();
        else if (action === 'regenerate') regenerateLast();
        else if (action === 'retry') retryLast();
    }

    // ---------- 会话管理 ----------

    function switchSession(id) {
        if (!sessions.some((s) => s.id === id)) return;
        config.activeSessionId = id;
        saveAIConfig();
        stickBottom = true;
        pendingEdit = null;
        renderSessionList();
        renderMessages();
        updateComposerState();
        setTimeout(() => flushMessageQueue(id), 0);
    }

    function newSession() {
        const session = createSessionData();
        pendingEdit = null;
        sessions.push(session);
        config.activeSessionId = session.id;
        persistSessions();
        renderSessionList();
        if (sessionListEl) sessionListEl.scrollTop = 0;
        renderMessages();
        updateComposerState();
        if (el.input) el.input.focus();
    }

    function renameSession(target) {
        const session = target && target.id ? target : currentSession();
        if (!session) return;
        if (!showNameDialog) {
            const next = window.prompt('重命名会话', session.title);
            if (next && next.trim()) {
                session.title = next.trim().slice(0, 60);
                persistSessions();
                renderSessionList();
                queueLogSave(session);
            }
            return;
        }
        showNameDialog({
            title: '重命名会话',
            label: '会话名称',
            value: session.title,
            okLabel: '重命名',
            onSubmit: (value) => {
                const next = String(value || '').trim();
                if (!next) throw new Error('会话名称不能为空');
                session.title = next.slice(0, 60);
                persistSessions();
                renderSessionList();
                queueLogSave(session);
            },
        });
    }

    function archiveSession(target, archived) {
        const session = target && target.id ? target : currentSession();
        if (!session) return;
        if (stream && stream.sessionId === session.id) {
            flash('请先停止当前会话的生成', true);
            return;
        }
        if (oneShot && oneShot.sessionId === session.id) {
            flash('该会话正在压缩上下文，请先停止', true);
            return;
        }
        session.archivedAt = archived ? Date.now() : 0;
        if (archived) clearQueueForSession(session.id);
        const isCurrent = currentSession() && currentSession().id === session.id;
        if (archived && isCurrent) {
            const next = sessions
                .filter((item) => item.id !== session.id && !item.archivedAt)
                .sort((a, b) => sessionActivity(b) - sessionActivity(a))[0];
            if (!next) {
                const fresh = createSessionData();
                sessions.push(fresh);
                persistSessions();
                switchSession(fresh.id);
            } else {
                persistSessions();
                switchSession(next.id);
            }
            flash('已归档会话：' + (session.title || '新会话'));
            return;
        }
        persistSessions();
        renderSessionList();
        updateComposerState();
        flash((archived ? '已归档会话：' : '已取消归档：') + (session.title || '新会话'));
    }

    function deleteSession(target) {
        const session = target && target.id ? target : currentSession();
        if (!session) return;
        if (stream && stream.sessionId === session.id) {
            flash('请先停止当前会话的生成', true);
            return;
        }
        if (oneShot && oneShot.sessionId === session.id) {
            flash('该会话正在压缩上下文，请先停止', true);
            return;
        }
        askConfirm('删除会话「' + (session.title || '新会话') + '」及其全部消息？', () => {
            sessions = sessions.filter((s) => s.id !== session.id);
            clearQueueForSession(session.id);
            if (!sessions.length) sessions.push(createSessionData());
            const next = sessions[Math.max(0, Math.min(sessions.length - 1, 0))];
            config.activeSessionId = sessions.some((s) => s.id === config.activeSessionId) ? config.activeSessionId : next.id;
            if (!sessions.some((s) => s.id === config.activeSessionId)) config.activeSessionId = next.id;
            persistSessions();
            renderSessionList();
            renderMessages();
            updateComposerState();
        }, '删除', '删除会话');
    }

    function exportSession(target) {
        const session = target && target.id ? target : currentSession();
        if (!session) return;
        const markdown = buildSessionMarkdown(session);
        if (!backend.SaveFileDialog || !backend.SaveFile) {
            flash('当前版本不支持导出会话', true);
            return;
        }
        Promise.resolve(backend.SaveFileDialog(aiSafeFileStem(session.title) + '.md')).then((path) => {
            if (!path) {
                flash('已取消导出');
                return;
            }
            return backend.SaveFile(path, markdown, 'lf', false, 'utf-8').then(() => {
                flash('已导出会话：' + path);
            });
        }).catch((e) => {
            flash('导出会话失败：' + ((e && e.message) || e), true);
        });
    }

    function buildSessionMarkdown(session) {
        const lines = ['# ' + (session.title || 'AI 会话'), '', '> 导出时间：' + new Date().toLocaleString(), ''];
        if (session.summary && session.summary.text) {
            lines.push('## 会话摘要', '', session.summary.text, '');
        }
        for (const message of session.messages) {
            if (message.role === 'tool') {
                lines.push('## 工具调用：' + (message.name || 'tool'), '');
                if (message.arguments) lines.push('参数：`' + message.arguments + '`', '');
                if (message.ask) appendAskMarkdown(lines, message.ask);
                lines.push('```text', message.content || '（无输出）', '```', '');
            } else if (message.role === 'user') {
                lines.push('## 用户', '', message.content || '', '');
                for (const image of message.images || []) {
                    const src = aiImageSrc(image);
                    if (src) lines.push('![图片](<' + src + '>)', '');
                    else if (image.logFile) lines.push('（图片已归档：`' + image.logFile + '`）', '');
                }
            } else {
                lines.push('## AI' + (message.model ? '（' + message.model + '）' : ''), '');
                if (message.reasoning) {
                    lines.push('> 思考过程：', '>', '> ' + message.reasoning.replace(/\n/g, '\n> '), '');
                }
                lines.push(message.content || '', '');
                if (message.status === 'error' && message.error) lines.push('> 错误：' + message.error, '');
            }
            lines.push('---', '');
        }
        if (Array.isArray(session.changes) && session.changes.length) {
            lines.push('## 变更记录', '');
            for (const change of session.changes) {
                lines.push('- `' + (change.relPath || change.path) + '` +' + change.added + ' −' + change.removed +
                    ' · ' + new Date(change.time).toLocaleString());
            }
            lines.push('');
        }
        if (Array.isArray(session.archived) && session.archived.length) {
            lines.push('## 已归档消息（压缩前，不发送）', '');
            for (const message of session.archived) {
                if (!message || !message.role) continue;
                const label = message.role === 'user' ? '用户' : (message.role === 'tool' ? ('工具：' + (message.name || '')) : 'AI');
                lines.push('### ' + label, '', message.content || '（无内容）', '');
            }
        }
        return lines.join('\n');
    }

    // ---------- 对话日志（自动落盘） ----------

    async function getAILogRoot() {
        const root = aiNormalizePath(await getAIAppDir());
        if (!root) throw new Error('无法定位应用数据目录');
        return aiJoinPath(root, 'ai-logs');
    }

    async function ensureAILogDir() {
        const dir = await getAILogRoot();
        if (backend.AIEnsureDir) await backend.AIEnsureDir(dir);
        return dir;
    }

    function logTimestamp(ts) {
        return new Date(Number(ts) || Date.now()).toLocaleString();
    }

    function logTruncate(text, max) {
        const value = aiTextOf(text);
        if (value.length <= max) return value;
        return value.slice(0, max) + '\n…（已截断 ' + (value.length - max) + ' 字符）';
    }

    function appendAskMarkdown(lines, ask) {
        if (!ask) return;
        (ask.questions || []).forEach((question, index) => {
            lines.push('问题 ' + (index + 1) + '：' + question.question, '');
            for (const option of question.options || []) {
                lines.push('- ' + option.label + (option.recommended ? '（推荐）' : '') +
                    (option.description ? ' — ' + option.description : ''));
            }
            const answer = (ask.answers || []).find((item) => item.id === question.id) || {};
            const selected = Array.isArray(answer.selected) ? answer.selected : [];
            if (selected.length) lines.push('回答：' + selected.join('、'));
            if (answer.custom) lines.push('补充：' + answer.custom);
            if (!selected.length && !answer.custom) lines.push('回答：（未回答）');
            lines.push('');
        });
        const result = askResultText(ask);
        if (result) lines.push('状态：' + askStateLabel(ask) + ' · ' + result, '');
    }

    function appendLogMessage(lines, message, level) {
        if (!message || !message.role) return;
        if (message.role === 'user') {
            const images = (message.images || []).map(aiNormalizeImage).filter(Boolean);
            if (!message.content && !images.length) return;
            lines.push(level + ' 用户 · ' + logTimestamp(message.ts), '');
            if (message.content) lines.push(message.content, '');
            for (const image of images) {
                if (image.logFile) lines.push('![图片](<' + image.logFile + '>)', '');
            }
            return;
        }
        if (message.role === 'tool') {
            lines.push(level + ' 工具：' + (message.name || 'tool') + ' · ' + (message.status || 'done'), '');
            if (message.arguments) lines.push('参数：`' + logTruncate(message.arguments, 4000) + '`', '');
            if (message.ask) appendAskMarkdown(lines, message.ask);
            lines.push('```text', logTruncate(message.content || '（无输出）', 50000), '```', '');
            return;
        }
        if (!message.content && !message.reasoning && !(message.toolCalls || []).length && !message.error) return;
        lines.push(level + ' AI' + (message.model ? '（' + message.model + '）' : '') + ' · ' + logTimestamp(message.ts), '');
        if (message.turnMs) lines.push('用时：' + aiFormatDuration(message.turnMs), '');
        if (message.reasoning) {
            lines.push('<details>', '<summary>思考过程</summary>', '', message.reasoning, '', '</details>', '');
        }
        if (message.content) lines.push(message.content, '');
        if (Array.isArray(message.toolCalls) && message.toolCalls.length) {
            lines.push('工具调用：' + message.toolCalls.map((call) => call.name).filter(Boolean).join('、'), '');
        }
        if (message.usage && message.usage.totalTokens) {
            lines.push('tokens：输入 ' + (message.usage.promptTokens || 0) + ' · 输出 ' + (message.usage.completionTokens || 0) +
                ' · 合计 ' + message.usage.totalTokens, '');
        }
        if (message.status === 'error' && message.error) lines.push('> 错误：' + message.error, '');
    }

    function buildConversationLogMarkdown(session) {
        const lines = ['# ' + (session.title || 'AI 会话'), ''];
        lines.push('- 会话 ID：`' + session.id + '`');
        lines.push('- 创建时间：' + new Date(Number(session.createdAt) || Date.now()).toLocaleString());
        lines.push('- 最近更新：' + new Date().toLocaleString());
        const profile = config.profiles.find((item) => item.id === session.profileId);
        if (profile) lines.push('- 最后配置：' + profile.name + (profile.model ? '（' + profile.model + '）' : ''));
        lines.push('');
        if (session.summary && session.summary.text) {
            lines.push('## 会话摘要', '', session.summary.text, '');
        }
        const archived = Array.isArray(session.archived) ? session.archived : [];
        if (archived.length) {
            lines.push('## 已归档消息（压缩前，不进入当前上下文）', '');
            for (const message of archived) appendLogMessage(lines, message, '###');
            lines.push('');
        }
        lines.push('## 当前对话', '');
        for (const message of session.messages) appendLogMessage(lines, message, '###');
        if (Array.isArray(session.changes) && session.changes.length) {
            lines.push('', '## 变更记录', '');
            for (const change of session.changes) {
                lines.push('- `' + (change.relPath || change.path) + '` +' + change.added + ' −' + change.removed +
                    ' · ' + new Date(change.time).toLocaleString());
            }
        }
        return lines.join('\n');
    }

    async function saveConversationLog(session) {
        if (!config.logEnabled || !session) return;
        if (!backend.SaveFile || !backend.SaveDataURL) return;
        try {
            const dir = await ensureAILogDir();
            if (!session.logFile) {
                session.logFile = aiSafeFileStem(session.title || 'AI 会话') + '-' + String(session.id).slice(-8) + '.md';
            }
            const archived = Array.isArray(session.archived) ? session.archived : [];
            const messages = archived.concat(session.messages);
            const imagesDir = aiJoinPath(dir, 'images');
            let imagesSaved = false;
            let imagesDirReady = false;
            for (const message of messages) {
                if (!message || message.role !== 'user' || !Array.isArray(message.images)) continue;
                for (let i = 0; i < message.images.length; i++) {
                    const image = aiNormalizeImage(message.images[i]);
                    if (!image) continue;
                    message.images[i] = image;
                    if (!image.logFile) {
                        if (!imagesDirReady) {
                            if (backend.AIEnsureDir) await backend.AIEnsureDir(imagesDir);
                            imagesDirReady = true;
                        }
                        const name = aiSafeFileStem(String(session.id).slice(-16) + '-' + (image.id || aiNowId('img-')))
                            .replace(/\s+/g, '_').slice(0, 100) + '.' + aiImageExt(image.mime);
                        const rel = 'images/' + name;
                        await backend.SaveDataURL(aiJoinPath(imagesDir, name), aiImageSrc(image));
                        image.logFile = rel;
                        imagesSaved = true;
                    }
                }
            }
            if (imagesSaved) persistSessions();
            const markdown = buildConversationLogMarkdown(session);
            await backend.SaveFile(aiJoinPath(dir, session.logFile), markdown, 'lf', false, 'utf-8');
            session.logSavedAt = Date.now();
            persistSessions();
        } catch (e) {
            if (!logSaveErrorShown) {
                logSaveErrorShown = true;
                flash('对话日志保存失败：' + ((e && e.message) || e), true);
            }
        }
    }

    const logTimers = new Map();
    const logQueues = new Map();

    function queueLogSave(session) {
        if (!config.logEnabled || !session) return;
        const existing = logTimers.get(session.id);
        if (existing) clearTimeout(existing);
        logTimers.set(session.id, setTimeout(() => {
            logTimers.delete(session.id);
            const previous = logQueues.get(session.id) || Promise.resolve();
            const next = previous.catch(() => {}).then(() => saveConversationLog(session));
            logQueues.set(session.id, next);
            next.finally(() => {
                if (logQueues.get(session.id) === next) logQueues.delete(session.id);
            });
        }, 400));
    }

    async function openAILogDir() {
        try {
            const dir = await ensureAILogDir();
            if (backend.ShowInFolder) await backend.ShowInFolder(dir);
            else flash('日志目录：' + dir);
        } catch (e) {
            flash('打开日志目录失败：' + ((e && e.message) || e), true);
        }
    }

    // ---------- 管理对话框 / 提示词 / 记忆 / 技能 ----------

    function openAIDialog(title, bodyNodes, footerNodes) {
        if (!el.dialog) return;
        if (el.dialogTitle) el.dialogTitle.textContent = title || '';
        if (el.dialogBody) {
            el.dialogBody.innerHTML = '';
            for (const node of bodyNodes || []) if (node) el.dialogBody.appendChild(node);
        }
        if (el.dialogFoot) {
            el.dialogFoot.innerHTML = '';
            for (const node of footerNodes || []) if (node) el.dialogFoot.appendChild(node);
        }
        el.dialog.classList.remove('hidden');
    }

    function closeAIDialog() {
        if (!el.dialog) return;
        el.dialog.classList.add('hidden');
        if (el.dialogBody) el.dialogBody.innerHTML = '';
        if (el.dialogFoot) el.dialogFoot.innerHTML = '';
    }

    function dialogNode(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function dialogButton(label, className, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className || 'dlg-btn';
        button.textContent = label;
        button.addEventListener('click', onClick);
        return button;
    }

    function injectionStatusText(meta) {
        if (!meta) return '注入状态：—';
        const agents = meta.agents && meta.agents.loaded ? '✓ ' + meta.agents.chars + ' 字符' : '—';
        const memory = meta.memory && meta.memory.loaded ? '✓ ' + meta.memory.mode + ' ' + meta.memory.chars + ' 字符' : '—';
        const workspace = meta.workspace && meta.workspace.loaded ? '✓ ' + meta.workspace.files + ' 个文件' : '—';
        const skills = meta.skills ? meta.skills.count + ' 个' : '0 个';
        return '注入状态：AGENTS.md ' + agents + ' · 记忆 ' + memory + ' · 技能 ' + skills + ' · 上下文 ' + workspace;
    }

    async function showPromptDialog() {
        const session = currentSession();
        if (!session) return;
        const status = dialogNode('div', 'ai-dialog-hint', '注入状态：统计中…');
        const select = document.createElement('select');
        select.className = 'opt-select';
        const currentOption = document.createElement('option');
        currentOption.value = '';
        currentOption.textContent = '（当前生效值）';
        select.appendChild(currentOption);
        for (const prompt of config.prompts) {
            const option = document.createElement('option');
            option.value = prompt.id;
            option.textContent = prompt.name + (prompt.id === config.activePromptId ? '（默认）' : '');
            select.appendChild(option);
        }
        select.value = promptById(session.promptTemplateId) ? session.promptTemplateId : '';
        const textarea = document.createElement('textarea');
        textarea.spellcheck = false;
        textarea.value = effectiveSystemPrompt(session);
        select.addEventListener('change', () => {
            const prompt = promptById(select.value);
            textarea.value = prompt ? prompt.content : effectiveSystemPrompt(session);
        });
        const selectRow = dialogNode('div', 'ai-dialog-field');
        selectRow.append(dialogNode('span', '', '模板'), select);
        const textRow = dialogNode('div', 'ai-dialog-field');
        textRow.append(dialogNode('span', '', '系统提示词'), textarea);
        const footer = [
            dialogButton('清除会话覆盖', 'dlg-btn', () => {
                session.systemPrompt = '';
                session.promptTemplateId = '';
                persistSessions();
                closeAIDialog();
                showNote('已清除本会话的提示词覆盖，恢复默认模板。');
            }),
            dialogButton('取消', 'dlg-btn', closeAIDialog),
            dialogButton('保存到本会话', 'dlg-btn primary', () => {
                const value = String(textarea.value || '').trim();
                const prompt = promptById(select.value);
                if (!value) {
                    session.systemPrompt = '';
                    session.promptTemplateId = '';
                } else if (prompt && value === prompt.content.trim()) {
                    session.systemPrompt = '';
                    session.promptTemplateId = prompt.id;
                } else {
                    session.systemPrompt = value;
                    session.promptTemplateId = '';
                }
                persistSessions();
                closeAIDialog();
                showNote('已保存本会话提示词（下一轮生效）。');
                updateContextCount();
            }),
        ];
        openAIDialog('会话提示词', [selectRow, textRow, status], footer);
        try {
            const bundle = await assembleSystemContext(session, attachments);
            status.textContent = injectionStatusText(bundle.meta);
        } catch (e) {
            status.textContent = '注入状态统计失败：' + ((e && e.message) || e);
        }
    }

    function showArchivedDialog() {
        const session = currentSession();
        if (!session) return;
        const archived = Array.isArray(session.archived) ? session.archived : [];
        const body = dialogNode('div', 'ai-mgr-list');
        if (session.summary && session.summary.text) {
            body.appendChild(dialogNode('div', 'ai-dialog-hint', '当前摘要：\n' + session.summary.text));
        }
        if (!archived.length) {
            body.appendChild(dialogNode('div', 'ai-mgr-empty', '没有已归档消息。执行 /compact 后，压缩前的消息会保存在这里（不随请求发送）。'));
        } else {
            for (const message of archived) {
                if (!message || !message.role) continue;
                const row = dialogNode('div', 'ai-mgr-row');
                const main = dialogNode('div', 'ai-mgr-main');
                const label = message.role === 'user' ? '用户' : (message.role === 'tool' ? ('工具：' + (message.name || '')) : 'AI');
                main.appendChild(dialogNode('div', 'ai-mgr-name', label));
                main.appendChild(dialogNode('div', 'ai-mgr-meta', String(message.content || '（无内容）').slice(0, 200)));
                row.appendChild(main);
                body.appendChild(row);
            }
        }
        openAIDialog('已归档消息（不发送）', [body], [dialogButton('关闭', 'dlg-btn primary', closeAIDialog)]);
    }

    async function showMemoryDialog() {
        let mem;
        try {
            mem = await resolveMemoryDir();
            if (backend.AIEnsureDir) await backend.AIEnsureDir(mem.dir);
        } catch (e) {
            showNote('读取记忆目录失败：' + ((e && e.message) || e), true);
            return;
        }
        const pathBox = dialogNode('div', 'ai-mgr-path', '模式：' + mem.mode + '\n目录：' + mem.dir);
        pathBox.style.whiteSpace = 'pre-wrap';
        const list = dialogNode('div', 'ai-mgr-list');
        const newRow = dialogNode('div', 'ai-dialog-field');
        const nameInput = document.createElement('input');
        nameInput.className = 'ai-settings-input';
        nameInput.placeholder = '新文件名，如 user-preferences.md';
        nameInput.spellcheck = false;
        newRow.append(dialogNode('span', '', '新建文件'), nameInput,
            dialogButton('创建', 'dlg-btn', async () => {
                const name = String(nameInput.value || '').trim();
                if (!MEMORY_NAME_RULE.test(name) || name.includes('..')) {
                    flash('记忆文件名无效（安全字符，且以 .md 结尾）', true);
                    return;
                }
                try {
                    await backend.SaveFile(aiJoinPath(mem.dir, name), '', 'lf', false, 'utf-8');
                    nameInput.value = '';
                    await reload();
                } catch (e) {
                    flash('创建失败：' + ((e && e.message) || e), true);
                }
            }));

        async function reload() {
            list.innerHTML = '';
            let entries = [];
            try {
                const listing = await backend.ReadDir(mem.dir, 200);
                entries = ((listing && listing.entries) || []).filter((entry) => !entry.isDir);
            } catch (e) {
                entries = [];
            }
            if (!entries.length) {
                list.appendChild(dialogNode('div', 'ai-mgr-empty', '记忆目录为空。AI 在任意权限下都可通过 memory_write 写入。'));
                return;
            }
            entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
            for (const entry of entries) {
                const row = dialogNode('div', 'ai-mgr-row');
                const main = dialogNode('div', 'ai-mgr-main');
                main.appendChild(dialogNode('div', 'ai-mgr-name', entry.name));
                let size = Number(entry.size);
                if (!Number.isFinite(size)) {
                    try {
                        const info = await backend.OpenFile(entry.path, 'auto');
                        size = Number(info && info.size);
                    } catch (e) {
                        size = NaN;
                    }
                }
                const meta = [];
                if (Number.isFinite(size)) meta.push(size + ' 字节');
                main.appendChild(dialogNode('div', 'ai-mgr-meta', meta.join(' · ') || '点击「打开」查看内容'));
                const actions = dialogNode('div', 'ai-mgr-actions');
                actions.appendChild(dialogButton('打开', 'dlg-btn', () => openPath(entry.path)));
                actions.appendChild(dialogButton('删除', 'dlg-btn', () => {
                    askConfirm('删除记忆文件「' + entry.name + '」？（移入回收站）', async () => {
                        try {
                            if (!backend.DeleteEntry) throw new Error('当前版本不支持删除');
                            await backend.DeleteEntry(entry.path);
                            await reload();
                        } catch (e) {
                            flash('删除失败：' + ((e && e.message) || e), true);
                        }
                    }, '删除', '删除记忆文件');
                }));
                row.append(main, actions);
                list.appendChild(row);
            }
        }

        const modeButton = dialogButton(config.memoryMode === 'app' ? '切换到工作区模式' : '切换到应用数据模式', 'dlg-btn', () => {
            config.memoryMode = config.memoryMode === 'app' ? 'workspace' : 'app';
            memoryFallbackNotified = false;
            saveAIConfig();
            closeAIDialog();
            showMemoryDialog();
        });
        const footer = [
            dialogButton('在设置中打开', 'dlg-btn', () => { closeAIDialog(); openSettings('ai'); }),
            modeButton,
            dialogButton('刷新', 'dlg-btn', reload),
            dialogButton('关闭', 'dlg-btn primary', closeAIDialog),
        ];
        openAIDialog('记忆管理', [pathBox, list, newRow], footer);
        await reload();
    }

    async function attachSkillByName(name) {
        let skills;
        try {
            skills = await listSkills(true);
        } catch (e) {
            showNote('读取技能失败：' + ((e && e.message) || e), true);
            return;
        }
        const target = skills.find((skill) => skill.name.toLowerCase() === String(name || '').toLowerCase());
        if (!target) {
            showNote('未找到技能：' + name, true);
            return;
        }
        addAttachment({kind: 'skill', label: target.name, path: target.path, content: target.content});
        showNote('已加载技能：' + target.name + '（随下一轮发送）');
    }

    async function createAppSkill(name, description) {
        const app = aiNormalizePath(await getAIAppDir());
        if (!app) throw new Error('无法定位应用数据目录');
        const dirName = String(name || '').replace(/[\\/:*?"<>|]/g, '-').trim();
        if (!dirName) throw new Error('技能名称不能为空');
        const skillDir = aiJoinPath(aiJoinPath(app, 'ai-skills'), dirName);
        const file = aiJoinPath(skillDir, 'SKILL.md');
        if (backend.AIEnsureDir) await backend.AIEnsureDir(skillDir);
        const content = [
            '---',
            'name: ' + JSON.stringify(String(name)),
            'description: ' + JSON.stringify(String(description || '（待补充）')),
            '---',
            '',
            '# ' + name,
            '',
            '（在此编写技能指令：说明何时使用、步骤、注意事项。）',
        ].join('\n');
        await backend.SaveFile(file, content, 'lf', false, 'utf-8');
        invalidateSkillsCache();
        return file;
    }

    async function showSkillsDialog() {
        const list = dialogNode('div', 'ai-mgr-list');
        const status = dialogNode('div', 'ai-dialog-hint', '技能来源：内置技能、应用数据 ai-skills 与工作区 .cadt/skills；同名时工作区优先，其次应用目录。');
        const newRow = dialogNode('div', 'ai-dialog-field');
        const nameInput = document.createElement('input');
        nameInput.className = 'ai-settings-input';
        nameInput.placeholder = '技能名称';
        nameInput.spellcheck = false;
        const descInput = document.createElement('input');
        descInput.className = 'ai-settings-input';
        descInput.placeholder = '描述（一句话）';
        descInput.spellcheck = false;
        newRow.append(dialogNode('span', '', '新建技能'), nameInput, descInput,
            dialogButton('创建', 'dlg-btn', async () => {
                const name = String(nameInput.value || '').trim();
                if (!name) {
                    flash('技能名称不能为空', true);
                    return;
                }
                try {
                    const file = await createAppSkill(name, String(descInput.value || '').trim());
                    nameInput.value = '';
                    descInput.value = '';
                    flash('已创建技能：' + file);
                    await reload();
                } catch (e) {
                    flash('创建技能失败：' + ((e && e.message) || e), true);
                }
            }));

        function toggleSkill(skill, enabled) {
            const disabled = new Set((config.disabledSkills || []).map((value) => String(value).toLowerCase()));
            if (enabled) disabled.delete(skill.name.toLowerCase());
            else disabled.add(skill.name.toLowerCase());
            config.disabledSkills = [...disabled];
            saveAIConfig();
            invalidateSkillsCache();
            updateContextCount();
        }

        async function reload() {
            list.innerHTML = '';
            let skills = [];
            try {
                skills = await listSkillsRaw(true);
            } catch (e) {
                list.appendChild(dialogNode('div', 'ai-mgr-empty', '读取技能失败：' + ((e && e.message) || e)));
                return;
            }
            if (!skills.length) {
                list.appendChild(dialogNode('div', 'ai-mgr-empty', '还没有技能。可在下方新建，或把 SKILL.md 放进技能目录。'));
                return;
            }
            for (const skill of skills) {
                const row = dialogNode('div', 'ai-mgr-row');
                const check = document.createElement('input');
                check.type = 'checkbox';
                check.checked = !skill.disabled;
                check.title = '启用 / 禁用该技能';
                check.addEventListener('change', () => {
                    toggleSkill(skill, check.checked);
                    status.textContent = '已' + (check.checked ? '启用' : '禁用') + '技能：' + skill.name + '（下一轮生效）';
                });
                const main = dialogNode('div', 'ai-mgr-main');
                const sourceLabel = skillSourceLabel(skill.source);
                main.appendChild(dialogNode('div', 'ai-mgr-name', skill.name + '（' + sourceLabel + '）'));
                main.appendChild(dialogNode('div', 'ai-mgr-meta', skill.description));
                const actions = dialogNode('div', 'ai-mgr-actions');
                if (!skill.builtin) {
                    actions.appendChild(dialogButton('打开', 'dlg-btn', () => openPath(skill.path)));
                    actions.appendChild(dialogButton('目录', 'dlg-btn', () => {
                        const dir = aiPathDir(skill.path);
                        if (backend.ShowInFolder) backend.ShowInFolder(dir);
                        else openPath(dir);
                    }));
                }
                row.append(check, main, actions);
                list.appendChild(row);
            }
        }

        const footer = [
            dialogButton('刷新', 'dlg-btn', async () => { await reload(); }),
            dialogButton('关闭', 'dlg-btn primary', closeAIDialog),
        ];
        openAIDialog('技能管理', [status, list, newRow], footer);
        await reload();
    }

    // ---------- 上下文压缩 / 超限提示 / init ----------

    function estimateCurrentTokens() {
        const session = currentSession();
        const profile = activeProfile();
        const messages = buildApiMessages(session, null, lastSystemPrompt);
        const text = messages.map((message) => aiTextOf(message.content)).join('\n');
        let tokens = aiEstimateTokens(text) + aiImageStats(messages).tokens;
        for (const item of attachments) {
            tokens += item.kind === 'image' ? aiEstimateImageTokens(item) : aiEstimateTokens(aiTextOf(item.content));
        }
        tokens += toolsTokenEstimate(session);
        const windowSize = (profile && profile.contextWindow) || 128000;
        return {tokens, windowSize, percent: windowSize > 0 ? tokens / windowSize : 0};
    }

    function updateCtxBanner() {
        if (!el.ctxBanner) return;
        const {tokens, windowSize, percent} = estimateCurrentTokens();
        const threshold = aiClamp(Number(config.autoCompactThreshold) || 0.8, 0.5, 0.95);
        const show = percent >= threshold;
        el.ctxBanner.classList.toggle('hidden', !show);
        if (show && el.ctxBannerText) {
            el.ctxBannerText.textContent = '上下文约 ' + Math.round(percent * 100) + '%（约 ' + tokens + ' / ' + windowSize +
                ' tokens，估算），建议压缩';
        }
    }

    function compactTranscript(session) {
        const parts = [];
        if (session.summary && aiTextOf(session.summary.text).trim()) {
            parts.push('此前摘要：\n' + aiTextOf(session.summary.text).trim());
        }
        for (const message of session.messages) {
            if (!message) continue;
            if (message.role === 'tool') {
                if (aiTextOf(message.content).trim()) {
                    parts.push('[工具 ' + (message.name || '') + ' 结果]\n' + aiTextOf(message.content).trim());
                }
                continue;
            }
            const text = aiTextOf(message.content).trim();
            const imageCount = Array.isArray(message.images) ? message.images.length : 0;
            if (!text && !imageCount) continue;
            parts.push((message.role === 'user' ? '用户' : 'AI') + '：\n' + (text || '（仅图片）') +
                (imageCount ? '\n（附图 ' + imageCount + ' 张）' : ''));
        }
        let transcript = parts.join('\n\n');
        if (transcript.length > 120000) transcript = '…（较早内容已截断）\n\n' + transcript.slice(-120000);
        return transcript;
    }

    function startCompact() {
        if (stream) {
            showNote('请先停止当前生成，再压缩上下文。', true);
            return;
        }
        if (oneShot) {
            showNote('已有压缩任务在进行中。', true);
            return;
        }
        const session = currentSession();
        const profile = activeProfile();
        if (!session || !profile) {
            showNote('请先配置 AI 并创建会话。', true);
            return;
        }
        if (session.archivedAt) {
            showNote('该会话已归档，请先取消归档再压缩。', true);
            return;
        }
        if (session.messages.length <= 6) {
            showNote('消息太少（≤6 条），无需压缩。');
            return;
        }
        if (!backend.AISendChat) {
            showNote('当前版本不支持压缩。', true);
            return;
        }
        const id = session.id + '#compact-' + Date.now() + '-' + (++compactSeq);
        oneShot = {id, kind: 'compact', sessionId: session.id, buffer: '', startedAt: Date.now()};
        showNote('正在压缩上下文…（可点停止取消）');
        setStreamingUI(true);
        updateSendState();
        const messages = [
            {role: 'system', content: AI_COMPACT_SYSTEM_PROMPT},
            {role: 'user', content: '请压缩以下对话记录：\n\n' + compactTranscript(session)},
        ];
        Promise.resolve(backend.AISendChat(id, configForProfile(profile), messages, [])).catch((e) => {
            if (!oneShot || oneShot.id !== id) return;
            const message = (e && e.message) || String(e);
            oneShot = null;
            setStreamingUI(false);
            updateSendState();
            showNote('压缩失败：' + message, true);
        });
    }

    function finishCompact(payload) {
        const current = oneShot;
        if (!current || current.kind !== 'compact') return;
        const session = sessionById(current.sessionId);
        oneShot = null;
        setStreamingUI(false);
        updateSendState();
        if (!session) return;
        const text = String(current.buffer || '').trim();
        if (!text) {
            showNote('压缩失败：模型没有返回摘要。', true);
            return;
        }
        let cutoff = Math.max(0, session.messages.length - 6);
        while (cutoff > 0 && session.messages[cutoff] && session.messages[cutoff].role !== 'user') cutoff--;
        const archived = session.messages.slice(0, cutoff);
        session.messages = session.messages.slice(cutoff);
        session.archived = (session.archived || []).concat(archived).slice(-400);
        session.summary = {text, upTo: cutoff, createdAt: Date.now()};
        persistSessions();
        queueLogSave(session);
        if (isOpen() && currentSession() === session) renderMessages(true);
        updateContextCount();
        updateComposerTakeover(true);
        showNote('已压缩上下文：摘要 ' + text.length + ' 字符，保留最近 ' + session.messages.length + ' 条，归档 ' + archived.length + ' 条。');
        flushMessageQueue(session.id);
    }

    function cancelOneShot() {
        const current = oneShot;
        if (!current) return;
        oneShot = null;
        try {
            if (backend.AIStop) backend.AIStop(current.id);
        } catch (e) {}
        setStreamingUI(false);
        updateSendState();
        showNote('已取消压缩。');
    }

    async function runInitAgentsMd() {
        if (stream || oneShot) {
            showNote('请先停止当前生成，再生成 AGENTS.md。', true);
            return;
        }
        const project = aiProjectRoot();
        if (!project) {
            showNote('没有工作区，无法生成 AGENTS.md。', true);
            return;
        }
        const path = aiJoinPath(project, 'AGENTS.md');
        try {
            const read = await readTextFile(path, 1024);
            if (read && read.text != null) {
                showNote('AGENTS.md 已存在：' + path + '\n如需修改请直接在编辑器中打开。', true);
                return;
            }
        } catch (e) {
            // 文件不存在时继续创建。
        }
        const session = currentSession();
        if (!session) return;
        const content = [
            '# AGENTS.md',
            '',
            '## 项目概述',
            '（一句话说明这个项目/目录是做什么的。）',
            '',
            '## 目录结构',
            '- `src/`：',
            '- `docs/`：',
            '',
            '## 约定',
            '- 回答使用中文；代码注明语言。',
            '- 修改文件前先读取确认；不要改动与任务无关的内容。',
            '- 新增依赖或改变目录结构时说明原因。',
            '',
            '## 常用命令',
            '```bash',
            '# 构建 / 测试命令',
            '```',
        ].join('\n');
        const ops = computeLineDiff('', content);
        const stats = diffStats(ops);
        const preview = buildDiffPreview(ops);
        const callId = aiNowId('call_init_');
        const assistantMessage = {
            role: 'assistant',
            content: '按要求生成 AGENTS.md 模板。',
            reasoning: '',
            thinkingSignature: '',
            toolCalls: [{id: callId, name: 'write_file', arguments: JSON.stringify({path: 'AGENTS.md'})}],
            model: '',
            status: 'done',
            ts: Date.now(),
        };
        const toolMessage = {
            role: 'tool',
            toolCallId: callId,
            name: 'write_file',
            arguments: JSON.stringify({path: 'AGENTS.md'}),
            content: '',
            status: 'pending',
            ts: Date.now(),
        };
        session.messages.push(assistantMessage, toolMessage);
        if (isOpen() && currentSession() === session) renderMessages(true);
        const result = await applyWorkspaceWrite(session, toolMessage, {
            tool: 'write_file',
            path,
            relPath: 'AGENTS.md',
            content,
            eol: 'lf',
            hasBom: false,
            enc: 'utf-8',
            newFile: true,
            added: stats.added,
            removed: stats.removed,
            truncated: preview.truncated,
            diff: preview.lines,
        });
        toolMessage.status = 'done';
        toolMessage.content = result;
        persistSessions();
        queueLogSave(session);
        if (isOpen() && currentSession() === session) renderMessages(true);
    }

    // ---------- 斜杠命令 ----------

    function hideSlash() {
        slashState.open = false;
        slashState.index = 0;
        slashState.items = [];
        if (el.slash) {
            el.slash.classList.add('hidden');
            el.slash.innerHTML = '';
        }
    }

    function updateSlash() {
        if (!el.slash || !el.input) return;
        const value = el.input.value;
        if (!value.startsWith('/') || value.includes(' ') || value.includes('\n')) {
            hideSlash();
            return;
        }
        const query = value.slice(1).toLowerCase();
        const items = AI_COMMANDS.filter((cmd) => cmd.name.slice(1).toLowerCase().startsWith(query));
        if (!items.length) {
            hideSlash();
            return;
        }
        slashState.items = items;
        slashState.index = aiClamp(slashState.index, 0, items.length - 1);
        slashState.open = true;
        el.slash.innerHTML = '';
        items.forEach((command, index) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'ai-slash-item' + (index === slashState.index ? ' selected' : '');
            item.dataset.aiSlashIndex = String(index);
            const name = document.createElement('span');
            name.textContent = command.name;
            const desc = document.createElement('span');
            desc.className = 'ai-slash-desc';
            desc.textContent = command.desc;
            item.append(name, desc);
            item.addEventListener('click', () => {
                slashState.index = index;
                runSlashCommand(items[index]);
            });
            item.addEventListener('mousemove', () => {
                if (slashState.index === index) return;
                slashState.index = index;
                el.slash.querySelectorAll('.ai-slash-item').forEach((row, rowIndex) => {
                    row.classList.toggle('selected', rowIndex === index);
                });
            });
            el.slash.appendChild(item);
        });
        el.slash.classList.remove('hidden');
        positionOverlays();
    }

    async function runSlashCommand(command) {
        if (!command) return;
        const typed = el.input ? String(el.input.value || '').trim() : '';
        const argText = typed.startsWith(command.name) ? typed.slice(command.name.length).trim() : '';
        hideSlash();
        if (el.input) {
            el.input.value = '';
            resizeInput();
        }
        updateSendState();
        switch (command.name) {
            case '/context':
                try {
                    showNote(await contextSummaryText());
                } catch (e) {
                    showNote('上下文统计失败：' + ((e && e.message) || e), true);
                }
                break;
            case '/compact':
                startCompact();
                break;
            case '/clear':
                clearCurrentSession();
                break;
            case '/help':
                showNote('可用命令：\n' + AI_COMMANDS.map((cmd) => cmd.name + '  —  ' + cmd.desc).join('\n'));
                break;
            case '/model':
                showNote('使用输入框右下角的模型胶囊切换配置。');
                if (el.modelChip) el.modelChip.focus();
                break;
            case '/export':
                exportSession();
                break;
            case '/memory':
                await showMemoryDialog();
                break;
            case '/skill':
                if (argText) await attachSkillByName(argText);
                else await showSkillsDialog();
                break;
            case '/plan':
                handlePlanCommand(argText);
                break;
            case '/init':
                await runInitAgentsMd();
                break;
            default:
                showNote('未知命令，输入 /help 查看可用命令。', true);
                break;
        }
    }

    function handleSlashText(text) {
        const name = String(text || '').trim().split(/\s+/)[0];
        const command = AI_COMMANDS.find((cmd) => cmd.name === name);
        if (command) runSlashCommand(command);
        else showNote('未知命令：' + name + '\n输入 /help 查看可用命令。', true);
    }

    function clearCurrentSession() {
        if (stream || oneShot) {
            showNote('请先停止当前生成，再清空会话。', true);
            return;
        }
        const session = currentSession();
        if (!session) return;
        askConfirm('清空当前会话的全部消息？', () => {
            session.messages = [];
            session.summary = null;
            session.archived = [];
            persistSessions();
            renderMessages();
            updateComposerState();
        }, '清空', '清空会话');
    }

    function showNote(text, isError) {
        if (!el.messages) return;
        const empty = el.messages.querySelector('.ai-empty');
        if (empty) empty.remove();
        const note = document.createElement('div');
        note.className = 'ai-note' + (isError ? ' error' : '');
        note.textContent = text;
        note.dataset.aiNote = String(++noteSeq);
        el.messages.appendChild(note);
        while (el.messages.querySelectorAll('.ai-note').length > 6) {
            const first = el.messages.querySelector('.ai-note');
            if (first) first.remove();
        }
        scrollToBottom(true);
    }

    // ---------- 显示方式与几何 ----------

    function normalizeFloatMode(value) {
        return value === 'fullscreen' ? 'fullscreen' : 'dock';
    }

    // 停靠模式自适应：内容区没有打开文件时占满内容区，打开文件后回到分屏宽度。
    function refreshDockFill() {
        if (floatWindow || !dockParent) return;
        const ctx = getWorkspaceContext() || {};
        const fill = mode === 'dock' && isOpen() && !ctx.activeFile;
        dockParent.classList.toggle('ai-dock-fill', fill);
        if (mode !== 'dock') return;
        if (fill) {
            panel.style.width = '';
        } else {
            const width = aiClamp(Number(settings.aiPanelWidth) || 380, 280, 640);
            settings.aiPanelWidth = width;
            panel.style.width = width + 'px';
        }
        positionOverlays();
    }

    function applyMode(nextMode, persist) {
        mode = normalizeFloatMode(nextMode);
        if (persist) {
            settings.aiFloatMode = mode;
            saveSettings();
        }
        panel.classList.remove('ai-dock', 'ai-snap', 'ai-float', 'ai-maximized', 'ai-fullscreen');
        panel.style.left = '';
        panel.style.top = '';
        panel.style.right = '';
        panel.style.bottom = '';
        panel.style.width = '';
        panel.style.height = '';
        if (mode === 'fullscreen') {
            if (dockParent) dockParent.classList.remove('ai-dock-fill');
            if (overlayParent && panel.parentElement !== overlayParent) overlayParent.appendChild(panel);
            panel.classList.add('ai-fullscreen');
        } else {
            if (dockParent && panel.parentElement !== dockParent) dockParent.appendChild(panel);
            panel.classList.add('ai-dock');
        }
        refreshDockFill();
        updateModeButtons();
        positionOverlays();
        setTimeout(() => {
            onLayout();
            if (stickBottom) scrollToBottom(false);
            else updateScrollButton();
        }, 0);
    }

    function updateModeButtons() {
        if (!el.modeSeg) return;
        el.modeSeg.querySelectorAll('button').forEach((button) => {
            button.classList.toggle('active', button.dataset.aiMode === mode);
        });
    }

    function openFloatWindow() {
        if (floatWindow) return;
        if (!backend.OpenAIFloatWindow) {
            flash('当前版本不支持独立窗口', true);
            return;
        }
        const root = getScopeRoot() || '';
        Promise.resolve(backend.OpenAIFloatWindow(root)).then(() => {
            flash('已在独立窗口打开 AI 助手');
            open(false);
        }).catch((e) => flash('打开独立窗口失败：' + ((e && e.message) || e), true));
    }

    function setMode(next) {
        if (next === 'float') {
            openFloatWindow();
            return;
        }
        if (next === 'snap') next = 'dock';
        if (!['dock', 'fullscreen'].includes(next)) return;
        applyMode(next, true);
        if (isOpen()) requestAnimationFrame(() => el.input && el.input.focus());
    }

    function toggleFullscreen() {
        applyMode(mode === 'fullscreen' ? 'dock' : 'fullscreen', true);
    }

    function reloadStoredAIState() {
        if (floatWindow) return;
        config = loadAIConfig();
        sessions = loadAISessions();
        if (!sessions.some((session) => session.id === config.activeSessionId)) {
            config.activeSessionId = sessions[0] ? sessions[0].id : '';
        }
        renderSessionList();
        renderProfileSelect();
        renderMessages(true);
        updateComposerState();
    }

    function open(force) {
        const show = floatWindow ? true : (typeof force === 'boolean' ? force : !isOpen());
        if (show) {
            if (!floatWindow) {
                if (stream || oneShot) renderSessionList();
                else reloadStoredAIState();
            }
            if (window.innerWidth < 900 && settings.showSidebar && typeof opts.collapseSidebar === 'function') {
                opts.collapseSidebar();
            }
            panel.classList.remove('hidden');
            applyMode(mode, false);
            renderSessionList();
            renderProfileSelect();
            stickBottom = true;
            renderMessages(false);
            updateComposerState();
            positionOverlays();
            refreshMemoryPath();
            setTimeout(() => {
                if (el.input) el.input.focus();
                if (stickBottom) scrollToBottom(false);
            }, 0);
        } else {
            panel.classList.add('hidden');
            if (dockParent) dockParent.classList.remove('ai-dock-fill');
            hideSlash();
            hideCtxPop();
            closeAIDialog();
        }
        if (!floatWindow) {
            settings.aiPanelOpen = show;
            saveSettings();
        }
        updateEntryButtons();
        updateContextCount();
        onLayout();
    }

    function toggle(force) {
        open(force);
    }

    function startResize(e, dir) {
        if (floatWindow || mode !== 'dock' || dir !== 'l') return;
        if (dockParent && dockParent.classList.contains('ai-dock-fill')) return;
        const rect = panel.getBoundingClientRect();
        drag = {
            kind: 'resize',
            pointerId: e.pointerId,
            startX: e.clientX,
            startWidth: rect.width,
        };
        const target = e.currentTarget;
        if (target && target.setPointerCapture) {
            try { target.setPointerCapture(e.pointerId); } catch (err) {}
        }
        setDragCursor('ew');
        document.body.style.userSelect = 'none';
        e.preventDefault();
        e.stopPropagation();
    }

    function moveResize(e) {
        if (!drag || drag.kind !== 'resize') return;
        const width = aiClamp(drag.startWidth - (e.clientX - drag.startX), 280, 640);
        panel.style.width = width + 'px';
    }

    function endResize() {
        if (!drag) return;
        if (drag.kind === 'resize') {
            settings.aiPanelWidth = aiClamp(panel.offsetWidth, 280, 640);
            saveSettings();
            onLayout();
        }
        drag = null;
        setDragCursor(null);
        document.body.style.userSelect = '';
    }

    function onWindowResize() {
        if (!isOpen()) return;
        if (mode === 'dock' && !floatWindow) applyMode('dock', false);
    }

    // ---------- 设置页 ----------

    function setSettingsStatus(text, kind) {
        if (!opt.status) return;
        opt.status.textContent = text || '—';
        opt.status.classList.toggle('ok', kind === 'ok');
        opt.status.classList.toggle('error', kind === 'error');
        clearTimeout(settingsStatusTimer);
        if (kind) {
            settingsStatusTimer = setTimeout(() => {
                opt.status.classList.remove('ok', 'error');
            }, 8000);
        }
    }

    function settingsFormDisabled(disabled) {
        for (const node of [opt.profile, opt.name, opt.provider, opt.baseURL, opt.apiKey, opt.model, opt.temp, opt.maxTokens, opt.reasoning, opt.thinking, opt.budget, opt.contextWindow, opt.proxy, opt.proxyURL, opt.headers, opt.test, opt.models, opt.dup, opt.del]) {
            if (node) node.disabled = !!disabled;
        }
        if (opt.profile) opt.profile.disabled = false;
    }

    function refreshThinkingVisibility() {
        const profile = activeProfile();
        const anthropic = !!profile && profile.provider === 'anthropic';
        if (opt.thinkingGroup) opt.thinkingGroup.classList.toggle('hidden', !anthropic);
        if (opt.reasoningGroup) opt.reasoningGroup.classList.toggle('hidden', !profile || anthropic);
        if (opt.reasoning && profile) opt.reasoning.value = profile.reasoningEffort || '';
    }

    function clampThinkingBudget(profile, editedField) {
        if (!profile || profile.provider !== 'anthropic' || !profile.thinking) return;
        profile.thinkingBudget = aiClampInt(profile.thinkingBudget, 1024, 393215, 8000);
        if (profile.maxTokens > profile.thinkingBudget) return;
        if (editedField === 'maxTokens') {
            profile.thinkingBudget = Math.max(1024, profile.maxTokens - 1024);
            if (profile.maxTokens <= profile.thinkingBudget) {
                profile.maxTokens = 2048;
                profile.thinkingBudget = 1024;
            }
        } else {
            profile.maxTokens = Math.min(393216, profile.thinkingBudget + 4096);
        }
    }

    function refreshSettingsPane() {
        const profile = activeProfile();
        renderProfileSelect();
        refreshThinkingVisibility();
        if (opt.profile) opt.profile.value = profile ? profile.id : '';
        settingsFormDisabled(!profile);
        if (!profile) {
            if (opt.name) opt.name.value = '';
            if (opt.baseURL) opt.baseURL.value = '';
            if (opt.apiKey) opt.apiKey.value = '';
            if (opt.model) opt.model.value = '';
            if (opt.temp) opt.temp.value = '0.7';
            if (opt.tempVal) opt.tempVal.textContent = '0.7';
            if (opt.maxTokens) opt.maxTokens.value = '4096';
            if (opt.reasoning) opt.reasoning.value = '';
            if (opt.thinking) opt.thinking.checked = false;
            if (opt.budget) opt.budget.value = '8000';
            if (opt.contextWindow) opt.contextWindow.value = '128000';
            if (opt.provider) opt.provider.value = 'openai';
            if (opt.proxy) opt.proxy.value = 'system';
            if (opt.proxyURL) { opt.proxyURL.value = ''; opt.proxyURL.disabled = true; }
            if (opt.headers) opt.headers.value = '';
            return;
        }
        if (opt.name) opt.name.value = profile.name;
        if (opt.provider) opt.provider.value = profile.provider;
        if (opt.baseURL) opt.baseURL.value = profile.baseURL;
        if (opt.apiKey) opt.apiKey.value = profile.apiKey;
        if (opt.model) opt.model.value = profile.model;
        if (opt.temp) opt.temp.value = String(profile.temperature);
        if (opt.tempVal) opt.tempVal.textContent = String(profile.temperature);
        if (opt.maxTokens) opt.maxTokens.value = String(profile.maxTokens);
        if (opt.reasoning) opt.reasoning.value = profile.reasoningEffort || '';
        if (opt.thinking) opt.thinking.checked = profile.thinking === true;
        if (opt.budget) opt.budget.value = String(profile.thinkingBudget);
        if (opt.contextWindow) opt.contextWindow.value = String(profile.contextWindow);
        if (opt.proxy) {
            const proxy = aiTextOf(profile.proxy);
            const mode = proxy === 'direct' ? 'direct' : (proxy && proxy !== 'system' ? 'custom' : 'system');
            opt.proxy.value = mode;
            if (opt.proxyURL) {
                opt.proxyURL.value = mode === 'custom' ? proxy : '';
                opt.proxyURL.disabled = mode !== 'custom';
            }
        }
        if (opt.headers) {
            opt.headers.value = Object.entries(profile.extraHeaders || {})
                .map(([name, value]) => name + '=' + value).join('\n');
        }
    }

    function refreshChatSettings() {
        if (opt.sendKey) opt.sendKey.value = settings.aiSendKey === 'ctrl-enter' ? 'ctrl-enter' : 'enter';
        const chatFont = aiClampInt(settings.aiChatFont, 10, 32, 13);
        if (opt.chatFont) opt.chatFont.value = String(chatFont);
        if (opt.chatFontVal) opt.chatFontVal.value = String(chatFont);
        if (opt.chatFontEn) {
            opt.chatFontEn.value = settings.aiChatFontEn || 'follow';
            if (!opt.chatFontEn.value) opt.chatFontEn.value = 'follow';
        }
        if (opt.chatFontCjk) {
            opt.chatFontCjk.value = settings.aiChatFontCjk || 'follow';
            if (!opt.chatFontCjk.value) opt.chatFontCjk.value = 'follow';
        }
        if (opt.chatFontCode) {
            opt.chatFontCode.value = settings.aiChatCodeFont || 'follow';
            if (!opt.chatFontCode.value) opt.chatFontCode.value = 'follow';
        }
        if (opt.showThinking) opt.showThinking.checked = settings.aiShowThinking !== false;
        if (opt.showUsage) opt.showUsage.checked = settings.aiShowUsage !== false;
        if (opt.assistantCard) opt.assistantCard.checked = settings.aiAssistantCard === true;
        if (opt.maxSessions) opt.maxSessions.value = String(aiClampInt(settings.aiMaxSessions, 2, 500, 50));
        if (opt.logEnabled) opt.logEnabled.checked = config.logEnabled !== false;
        if (opt.notifyInApp) opt.notifyInApp.checked = config.notifyInApp !== false;
        if (opt.notifySystem) opt.notifySystem.checked = config.notifySystem === true;
        if (opt.notifyFinish) opt.notifyFinish.checked = config.notifyFinish !== false;
        if (opt.notifyError) opt.notifyError.checked = config.notifyError !== false;
        if (opt.notifyAsk) opt.notifyAsk.checked = config.notifyAsk !== false;
        if (opt.notifySound) opt.notifySound.checked = config.notifySound !== false;
        if (opt.askTimeout) opt.askTimeout.value = String(aiClampInt(config.askTimeout, 0, 3600, 300));
        if (opt.askTimeoutAction) opt.askTimeoutAction.value = config.askTimeoutAction || 'recommended';
        if (opt.logPath) {
            opt.logPath.textContent = '统计中…';
            getAILogRoot().then((dir) => {
                if (opt.logPath) opt.logPath.textContent = dir;
            }).catch(() => {
                if (opt.logPath) opt.logPath.textContent = '不可用';
            });
        }
        if (opt.memoryMode) opt.memoryMode.value = config.memoryMode === 'app' ? 'app' : 'workspace';
        if (opt.injectContext) opt.injectContext.checked = settings.aiInjectContext !== false;
        if (opt.injectAgents) opt.injectAgents.checked = settings.aiInjectAgentsMd !== false;
        if (opt.threshold) opt.threshold.value = String(aiClamp(Number(config.autoCompactThreshold) || 0.8, 0.5, 0.95));
        renderApprovedSettings();
    }

    function refreshMemoryPath() {
        if (!opt.memoryPath) return;
        opt.memoryPath.textContent = '记忆目录：统计中…';
        resolveMemoryDir().then((mem) => {
            opt.memoryPath.textContent = '记忆目录（' + mem.mode + '）：' + mem.dir;
        }).catch((e) => {
            opt.memoryPath.textContent = '记忆目录：' + ((e && e.message) || e);
        });
    }

    function closeSettingsDialogForPanel() {
        const dlg = document.getElementById('dlg-settings');
        if (!dlg || dlg.classList.contains('hidden')) return;
        const button = dlg.querySelector('.dialog-close');
        if (button) button.click();
    }

    function renderPresetSelect() {
        if (!opt.preset) return;
        opt.preset.innerHTML = '';
        for (const preset of AI_PRESETS) {
            const option = document.createElement('option');
            option.value = preset.id;
            option.textContent = preset.name;
            opt.preset.appendChild(option);
        }
    }

    function refreshPromptSettings() {
        if (!opt.prompt) return;
        const previous = opt.prompt.value;
        opt.prompt.innerHTML = '';
        for (const prompt of config.prompts) {
            const option = document.createElement('option');
            option.value = prompt.id;
            option.textContent = prompt.name + (prompt.builtin ? '（内置）' : '') +
                (prompt.id === config.activePromptId ? ' · 默认' : '');
            opt.prompt.appendChild(option);
        }
        if (previous && promptById(previous)) opt.prompt.value = previous;
        else opt.prompt.value = config.activePromptId || (config.prompts[0] && config.prompts[0].id) || '';
        const selected = promptById(opt.prompt.value);
        if (opt.promptText) opt.promptText.value = selected ? selected.content : '';
        if (opt.promptDel) opt.promptDel.disabled = !selected || !!selected.builtin;
    }

    function addPresetProfile() {
        if (!opt.preset) return;
        const preset = AI_PRESETS.find((item) => item.id === opt.preset.value);
        if (!preset) return;
        const profile = defaultProfile();
        profile.name = preset.name;
        profile.provider = preset.provider;
        profile.baseURL = preset.baseURL;
        profile.model = preset.model;
        config.profiles.push(profile);
        config.activeProfileId = profile.id;
        saveAIConfig();
        renderProfileSelect();
        renderModelList();
        openModelEditor(profile.id);
        setSettingsStatus('预设已添加：' + preset.name + '，请填写 API Key', 'ok');
    }

    function providerLabelFor(profile) {
        return profile && profile.provider === 'anthropic' ? 'Anthropic 原生' : 'OpenAI 兼容';
    }

    function renderModelList() {
        if (!opt.modelList) return;
        opt.modelList.innerHTML = '';
        if (!config.profiles.length) {
            const empty = document.createElement('div');
            empty.className = 'ai-model-empty';
            empty.textContent = '还没有配置模型。点击下方「新建模型」，或选择一个预设后添加。';
            opt.modelList.appendChild(empty);
            return;
        }
        for (const profile of config.profiles) {
            const card = document.createElement('div');
            card.className = 'ai-model-card' + (profile.id === config.activeProfileId ? ' active' : '');
            const head = document.createElement('div');
            head.className = 'ai-model-card-head';
            const name = document.createElement('span');
            name.className = 'ai-model-name';
            name.textContent = profile.name || '未命名模型';
            const provider = document.createElement('span');
            provider.className = 'ai-model-provider';
            provider.textContent = providerLabelFor(profile);
            head.append(name, provider);
            if (profile.id === config.activeProfileId) {
                const badge = document.createElement('span');
                badge.className = 'ai-model-badge';
                badge.textContent = '当前';
                head.appendChild(badge);
            }
            const meta = document.createElement('div');
            meta.className = 'ai-model-meta';
            meta.textContent = [
                profile.model || '未填写模型 ID',
                profile.baseURL || '未填写 Base URL',
                profile.apiKey ? 'Key 已配置' : 'Key 未配置',
                '窗口 ' + (profile.contextWindow || 128000) + ' tokens',
            ].join(' · ');
            const actions = document.createElement('div');
            actions.className = 'ai-model-actions';
            if (profile.id !== config.activeProfileId) {
                actions.appendChild(dialogButton('设为当前', 'dlg-btn', () => setActiveModel(profile.id)));
            }
            actions.appendChild(dialogButton('编辑', 'dlg-btn', () => openModelEditor(profile.id)));
            actions.appendChild(dialogButton('复制', 'dlg-btn', () => duplicateModel(profile.id)));
            actions.appendChild(dialogButton('删除', 'dlg-btn', () => deleteModel(profile.id)));
            card.append(head, meta, actions);
            opt.modelList.appendChild(card);
        }
    }

    function setActiveModel(id) {
        const profile = config.profiles.find((item) => item.id === id);
        if (!profile) return;
        config.activeProfileId = id;
        saveAIConfig();
        refreshSettingsPane();
        renderProfileSelect();
        renderModelList();
        updateComposerState();
        flash('已切换到模型：' + (profile.name || profile.model || '未命名'));
    }

    function openModelEditor(id) {
        if (!opt.modelEditor) return;
        let profile = id ? config.profiles.find((item) => item.id === id) : null;
        if (id && !profile) return;
        const previousActiveId = config.activeProfileId;
        if (profile) {
            modelEditorState = {
                isCreate: false,
                editingId: profile.id,
                previousActiveId,
                snapshot: JSON.parse(JSON.stringify(profile)),
            };
        } else {
            profile = defaultProfile();
            profile.name = '模型 ' + (config.profiles.length + 1);
            config.profiles.push(profile);
            modelEditorState = {
                isCreate: true,
                newId: profile.id,
                previousActiveId,
                snapshot: null,
            };
        }
        config.activeProfileId = profile.id;
        saveAIConfig();
        refreshSettingsPane();
        renderModelList();
        if (opt.modelTitle) opt.modelTitle.textContent = modelEditorState.isCreate ? '新建模型' : '编辑模型';
        if (opt.modelEditorMask) opt.modelEditorMask.classList.remove('hidden');
        opt.modelEditor.classList.remove('hidden');
        setTimeout(() => {
            if (opt.name) {
                opt.name.focus();
                opt.name.select();
            }
        }, 50);
    }

    function closeModelEditor(save) {
        const state = modelEditorState;
        if (!state) {
            if (opt.modelEditor) opt.modelEditor.classList.add('hidden');
            return;
        }
        const profile = activeProfile();
        if (save) {
            const name = String((opt.name && opt.name.value) || '').trim();
            const model = String((opt.model && opt.model.value) || '').trim();
            if (!name) {
                setSettingsStatus('配置名称不能为空', 'error');
                if (opt.name) opt.name.focus();
                return;
            }
            if (!model) {
                setSettingsStatus('模型 ID 不能为空', 'error');
                if (opt.model) opt.model.focus();
                return;
            }
            if (profile) {
                profile.name = name;
                profile.model = model;
            }
            if (state.isCreate) config.activeProfileId = profile ? profile.id : config.activeProfileId;
            else config.activeProfileId = state.previousActiveId || (profile ? profile.id : '');
            saveAIConfig();
            modelEditorState = null;
            if (opt.modelEditor) opt.modelEditor.classList.add('hidden');
            if (opt.modelEditorMask) opt.modelEditorMask.classList.add('hidden');
            refreshSettingsPane();
            renderProfileSelect();
            renderModelList();
            updateComposerState();
            flash('模型配置已保存：' + name);
            return;
        }
        if (state.isCreate) {
            config.profiles = config.profiles.filter((item) => item.id !== state.newId);
            config.activeProfileId = state.previousActiveId ||
                (config.profiles[0] ? config.profiles[0].id : '');
        } else {
            const editing = config.profiles.find((item) => item.id === state.editingId);
            if (editing && state.snapshot) Object.assign(editing, state.snapshot);
            config.activeProfileId = state.previousActiveId || (editing ? editing.id : '');
        }
        modelEditorState = null;
        if (opt.modelEditor) opt.modelEditor.classList.add('hidden');
        if (opt.modelEditorMask) opt.modelEditorMask.classList.add('hidden');
        saveAIConfig();
        refreshSettingsPane();
        renderProfileSelect();
        renderModelList();
        updateComposerState();
    }

    function duplicateModel(id) {
        const profile = config.profiles.find((item) => item.id === id);
        if (!profile) return;
        const copy = JSON.parse(JSON.stringify(profile));
        copy.id = aiNowId('profile-');
        copy.name = (profile.name || '模型') + ' 副本';
        config.profiles.push(copy);
        config.activeProfileId = copy.id;
        saveAIConfig();
        refreshSettingsPane();
        renderProfileSelect();
        renderModelList();
        openModelEditor(copy.id);
    }

    function deleteModel(id) {
        const profile = config.profiles.find((item) => item.id === id);
        if (!profile) return;
        askConfirm('删除模型配置「' + (profile.name || profile.model || '未命名') + '」？', () => {
            config.profiles = config.profiles.filter((item) => item.id !== id);
            if (config.activeProfileId === id) {
                config.activeProfileId = config.profiles[0] ? config.profiles[0].id : '';
            }
            saveAIConfig();
            refreshSettingsPane();
            renderProfileSelect();
            renderModelList();
            updateComposerState();
            flash('已删除模型配置：' + (profile.name || profile.model || '未命名'));
        }, '删除', '删除模型');
    }

    function exportAIConfig() {
        const includeKeys = !!(opt.exportKeys && opt.exportKeys.checked);
        const data = {
            version: 1,
            exportedAt: new Date().toISOString(),
            profiles: config.profiles.map((profile) => ({
                ...profile,
                apiKey: includeKeys ? profile.apiKey : '',
            })),
            prompts: config.prompts.map((prompt) => ({
                id: prompt.id,
                name: prompt.name,
                content: prompt.content,
                builtin: !!prompt.builtin,
            })),
            activePromptId: config.activePromptId,
            memoryMode: config.memoryMode,
            approvedPaths: config.approvedPaths,
            disabledSkills: config.disabledSkills,
            autoCompactThreshold: config.autoCompactThreshold,
            logEnabled: config.logEnabled !== false,
            notifyInApp: config.notifyInApp !== false,
            notifySystem: config.notifySystem === true,
            notifyFinish: config.notifyFinish !== false,
            notifyError: config.notifyError !== false,
            notifyAsk: config.notifyAsk !== false,
            notifySound: config.notifySound !== false,
            askTimeout: config.askTimeout,
            askTimeoutAction: config.askTimeoutAction,
        };
        const json = JSON.stringify(data, null, 2);
        const defaultName = 'cadt-ai-config.json';
        const save = async () => {
            let path = '';
            if (backend.ShowSaveFileDialog) path = await backend.ShowSaveFileDialog('导出 AI 配置', defaultName, '*.json');
            else if (backend.SaveFileDialog) path = await backend.SaveFileDialog(defaultName);
            else throw new Error('当前版本不支持保存对话框');
            if (!path) {
                flash('已取消导出');
                return;
            }
            await backend.SaveFile(path, json, 'lf', false, 'utf-8');
            flash('AI 配置已导出：' + path);
        };
        save().catch((e) => flash('导出失败：' + ((e && e.message) || e), true));
    }

    async function importAIConfig() {
        if (!backend.ShowOpenFileDialog) {
            flash('当前版本不支持导入对话框', true);
            return;
        }
        try {
            const path = await backend.ShowOpenFileDialog('导入 AI 配置', '*.json');
            if (!path) {
                flash('已取消导入');
                return;
            }
            const read = await readTextFile(path, 4 << 20);
            const data = JSON.parse(read.text);
            if (!data || typeof data !== 'object') throw new Error('配置格式无效');
            let importedProfiles = 0;
            for (const raw of Array.isArray(data.profiles) ? data.profiles : []) {
                const profile = normalizeProfile(raw, config.profiles.length);
                if (!profile) continue;
                const existing = config.profiles.find((item) => item.id === profile.id);
                if (existing) {
                    const keepKey = existing.apiKey;
                    Object.assign(existing, profile);
                    if (!profile.apiKey) existing.apiKey = keepKey;
                } else {
                    config.profiles.push(profile);
                }
                importedProfiles++;
            }
            for (const raw of Array.isArray(data.prompts) ? data.prompts : []) {
                if (!raw || !aiTextOf(raw.id) || !aiTextOf(raw.content).trim()) continue;
                if (String(raw.id).startsWith('builtin-')) continue;
                const existing = config.prompts.find((item) => item.id === raw.id);
                if (existing) {
                    if (existing.builtin) continue;
                    existing.name = aiTextOf(raw.name) || existing.name;
                    existing.content = aiTextOf(raw.content);
                } else {
                    config.prompts.push({
                        id: aiTextOf(raw.id),
                        name: aiTextOf(raw.name) || '导入模板',
                        content: aiTextOf(raw.content),
                        builtin: false,
                    });
                }
            }
            if (data.activePromptId && promptById(aiTextOf(data.activePromptId))) {
                config.activePromptId = aiTextOf(data.activePromptId);
            }
            if (data.memoryMode === 'app' || data.memoryMode === 'workspace') config.memoryMode = data.memoryMode;
            if (Number.isFinite(Number(data.autoCompactThreshold))) {
                config.autoCompactThreshold = aiClamp(Number(data.autoCompactThreshold), 0.5, 0.95);
            }
            if (typeof data.logEnabled === 'boolean') config.logEnabled = data.logEnabled;
            for (const key of ['notifyInApp', 'notifySystem', 'notifyFinish', 'notifyError', 'notifyAsk', 'notifySound']) {
                if (typeof data[key] === 'boolean') config[key] = data[key];
            }
            if (Number.isFinite(Number(data.askTimeout))) config.askTimeout = aiClampInt(data.askTimeout, 0, 3600, 300);
            if (['recommended', 'wait', 'abort', 'ai_decide'].includes(data.askTimeoutAction)) {
                config.askTimeoutAction = data.askTimeoutAction;
            }
            for (const pathValue of Array.isArray(data.approvedPaths) ? data.approvedPaths : []) {
                aiAddUnique(config.approvedPaths, pathValue);
            }
            for (const name of Array.isArray(data.disabledSkills) ? data.disabledSkills : []) {
                aiAddUnique(config.disabledSkills, name);
            }
            if (!config.profiles.some((profile) => profile.id === config.activeProfileId)) {
                config.activeProfileId = config.profiles[0] ? config.profiles[0].id : '';
            }
            saveAIConfig();
            invalidateSkillsCache();
            refreshSettingsPane();
            refreshChatSettings();
            refreshPromptSettings();
            renderProfileSelect();
            updateComposerState();
            if (isOpen()) renderMessages(true);
            setSettingsStatus('已导入 ' + importedProfiles + ' 个配置', 'ok');
        } catch (e) {
            flash('导入失败：' + ((e && e.message) || e), true);
        }
    }

    function updateProfileField(field, value) {
        const profile = activeProfile();
        if (!profile) return;
        profile[field] = value;
        saveAIConfig();
        if (field === 'name') renderProfileSelect();
        if (field === 'provider' || field === 'model') renderProfileSelect();
        if (field === 'provider') refreshThinkingVisibility();
        if (['name', 'provider', 'model', 'baseURL', 'apiKey', 'contextWindow'].includes(field) && opt.modelList) renderModelList();
        updateComposerState();
    }

    function addProfile() {
        const profile = defaultProfile();
        profile.name = '配置 ' + (config.profiles.length + 1);
        config.profiles.push(profile);
        config.activeProfileId = profile.id;
        saveAIConfig();
        refreshSettingsPane();
        renderProfileSelect();
        updateComposerState();
        if (isOpen()) renderMessages(true);
        if (opt.name) {
            opt.name.focus();
            opt.name.select();
        }
    }

    function duplicateProfile() {
        const profile = activeProfile();
        if (!profile) return;
        const copy = JSON.parse(JSON.stringify(profile));
        copy.id = aiNowId('profile-');
        copy.name = profile.name + ' 副本';
        config.profiles.push(copy);
        config.activeProfileId = copy.id;
        saveAIConfig();
        refreshSettingsPane();
        renderProfileSelect();
        updateComposerState();
        if (isOpen()) renderMessages(true);
    }

    function deleteProfile() {
        const profile = activeProfile();
        if (!profile) return;
        askConfirm('删除配置「' + profile.name + '」？', () => {
            config.profiles = config.profiles.filter((p) => p.id !== profile.id);
            if (!config.profiles.some((p) => p.id === config.activeProfileId)) {
                config.activeProfileId = config.profiles.length ? config.profiles[0].id : '';
            }
            saveAIConfig();
            refreshSettingsPane();
            renderProfileSelect();
            updateComposerState();
            renderMessages(true);
        }, '删除', '删除配置');
    }

    function bindSettingsPane() {
        if (!opt.name && !opt.modelList) return;
        if (opt.profile) opt.profile.addEventListener('change', () => {
            if (!opt.profile.value || !config.profiles.some((p) => p.id === opt.profile.value)) return;
            config.activeProfileId = opt.profile.value;
            saveAIConfig();
            refreshSettingsPane();
            renderProfileSelect();
            updateComposerState();
            if (isOpen()) renderMessages(true);
            setSettingsStatus('已切换配置', 'ok');
        });
        if (opt.add) opt.add.addEventListener('click', addProfile);
        if (opt.dup) opt.dup.addEventListener('click', duplicateProfile);
        if (opt.del) opt.del.addEventListener('click', deleteProfile);
        if (opt.name) opt.name.addEventListener('change', () => {
            const profile = activeProfile();
            if (!profile) return;
            const next = String(opt.name.value || '').trim();
            if (!next) {
                opt.name.value = profile.name;
                return;
            }
            updateProfileField('name', next.slice(0, 60));
            refreshSettingsPane();
        });
        if (opt.provider) opt.provider.addEventListener('change', () => {
            updateProfileField('provider', opt.provider.value === 'anthropic' ? 'anthropic' : 'openai');
            const profile = activeProfile();
            if (profile && profile.provider === 'anthropic' && profile.thinking) {
                clampThinkingBudget(profile, 'thinking');
                saveAIConfig();
                refreshSettingsPane();
            }
        });
        for (const [node, field] of [[opt.baseURL, 'baseURL'], [opt.apiKey, 'apiKey'], [opt.model, 'model']]) {
            if (!node) continue;
            node.addEventListener('input', () => updateProfileField(field, String(node.value || '').trim()));
        }
        if (opt.temp) {
            const apply = () => {
                const value = aiClamp(Number(opt.temp.value) || 0, 0, 2);
                if (opt.tempVal) opt.tempVal.textContent = String(value);
                updateProfileField('temperature', value);
            };
            opt.temp.addEventListener('input', apply);
        }
        if (opt.maxTokens) opt.maxTokens.addEventListener('change', () => {
            const value = aiClampInt(opt.maxTokens.value, 1, 393216, 4096);
            opt.maxTokens.value = String(value);
            updateProfileField('maxTokens', value);
            const profile = activeProfile();
            if (profile) {
                clampThinkingBudget(profile, 'maxTokens');
                saveAIConfig();
                refreshSettingsPane();
            }
        });
        if (opt.reasoning) opt.reasoning.addEventListener('change', () => {
            updateProfileField('reasoningEffort', opt.reasoning.value || '');
            renderModelChip();
        });
        if (opt.thinking) opt.thinking.addEventListener('change', () => {
            const profile = activeProfile();
            if (!profile) return;
            profile.thinking = !!opt.thinking.checked;
            clampThinkingBudget(profile, 'thinking');
            saveAIConfig();
            refreshSettingsPane();
            if (profile.thinking) setSettingsStatus('扩展思考已开启：请求省略 temperature，预算 ' + profile.thinkingBudget, 'ok');
        });
        if (opt.budget) opt.budget.addEventListener('change', () => {
            const profile = activeProfile();
            if (!profile) return;
            profile.thinkingBudget = aiClampInt(opt.budget.value, 1024, 393215, 8000);
            clampThinkingBudget(profile, 'thinkingBudget');
            saveAIConfig();
            refreshSettingsPane();
            setSettingsStatus('思考预算已设为 ' + profile.thinkingBudget + ' tokens', 'ok');
        });
        if (opt.contextWindow) opt.contextWindow.addEventListener('change', () => {
            const value = aiClampInt(opt.contextWindow.value, 2048, 1048576, 128000);
            opt.contextWindow.value = String(value);
            updateProfileField('contextWindow', value);
            updateContextCount();
        });
        if (opt.keyToggle) opt.keyToggle.addEventListener('click', () => {
            if (!opt.apiKey) return;
            const show = opt.apiKey.type === 'password';
            opt.apiKey.type = show ? 'text' : 'password';
            opt.keyToggle.textContent = show ? '隐藏' : '显示';
        });
        if (opt.test) opt.test.addEventListener('click', async () => {
            const profile = activeProfile();
            if (!profile) return;
            setSettingsStatus('测试中…');
            try {
                const message = await backend.AITestConnection(configForProfile(profile));
                setSettingsStatus(message || '连接成功', 'ok');
            } catch (e) {
                setSettingsStatus('失败：' + ((e && e.message) || e), 'error');
            }
        });
        if (opt.models) opt.models.addEventListener('click', async () => {
            const profile = activeProfile();
            if (!profile) return;
            setSettingsStatus('获取中…');
            try {
                const models = await backend.AIListModels(configForProfile(profile));
                const list = Array.isArray(models) ? models : [];
                if (!list.length) {
                    setSettingsStatus('未返回模型');
                    return;
                }
                setSettingsStatus('可用模型（' + list.length + '）：' + list.slice(0, 8).join('、') +
                    (list.length > 8 ? ' 等' : ''), 'ok');
            } catch (e) {
                setSettingsStatus('失败：' + ((e && e.message) || e), 'error');
            }
        });
        if (opt.memoryMode) opt.memoryMode.addEventListener('change', () => {
            config.memoryMode = opt.memoryMode.value === 'app' ? 'app' : 'workspace';
            memoryFallbackNotified = false;
            saveAIConfig();
            refreshMemoryPath();
            updateContextCount();
        });
        if (opt.injectContext) opt.injectContext.addEventListener('change', () => {
            settings.aiInjectContext = !!opt.injectContext.checked;
            saveSettings();
            updateContextCount();
        });
        if (opt.injectAgents) opt.injectAgents.addEventListener('change', () => {
            settings.aiInjectAgentsMd = !!opt.injectAgents.checked;
            saveSettings();
            updateContextCount();
        });
        if (opt.sendKey) opt.sendKey.addEventListener('change', () => {
            settings.aiSendKey = opt.sendKey.value === 'ctrl-enter' ? 'ctrl-enter' : 'enter';
            saveSettings();
            updateSendState();
        });
        if (opt.chatFont) {
            opt.chatFont.addEventListener('input', () => setAIChatFont(opt.chatFont.value));
        }
        if (opt.chatFontVal) {
            opt.chatFontVal.addEventListener('change', () => setAIChatFont(opt.chatFontVal.value));
            opt.chatFontVal.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    setAIChatFont(opt.chatFontVal.value);
                }
            });
        }
        const bindChatFontSelect = (node, key) => {
            if (!node) return;
            node.addEventListener('change', () => {
                settings[key] = node.value || 'follow';
                saveSettings();
                applyPanelSettings();
            });
        };
        bindChatFontSelect(opt.chatFontEn, 'aiChatFontEn');
        bindChatFontSelect(opt.chatFontCjk, 'aiChatFontCjk');
        bindChatFontSelect(opt.chatFontCode, 'aiChatCodeFont');
        if (panel) {
            panel.addEventListener('wheel', (e) => {
                if (!e.ctrlKey || e.altKey || e.metaKey || !e.deltaY) return;
                e.preventDefault();
                const step = e.deltaY < 0 ? 1 : -1;
                setAIChatFont(aiClampInt(settings.aiChatFont, 10, 32, 13) + step, {deferSave: true});
            }, {passive: false});
        }
        if (opt.showThinking) opt.showThinking.addEventListener('change', () => {
            settings.aiShowThinking = !!opt.showThinking.checked;
            saveSettings();
            applyPanelSettings();
        });
        if (opt.showUsage) opt.showUsage.addEventListener('change', () => {
            settings.aiShowUsage = !!opt.showUsage.checked;
            saveSettings();
            applyPanelSettings();
        });
        if (opt.assistantCard) opt.assistantCard.addEventListener('change', () => {
            settings.aiAssistantCard = !!opt.assistantCard.checked;
            saveSettings();
            applyPanelSettings();
        });
        if (opt.maxSessions) opt.maxSessions.addEventListener('change', () => {
            settings.aiMaxSessions = aiClampInt(opt.maxSessions.value, 2, 500, 50);
            opt.maxSessions.value = String(settings.aiMaxSessions);
            saveSettings();
            persistSessions();
            renderSessionList();
            if (isOpen()) renderMessages(true);
        });
        if (opt.logEnabled) opt.logEnabled.addEventListener('change', () => {
            config.logEnabled = !!opt.logEnabled.checked;
            saveAIConfig();
            setSettingsStatus(config.logEnabled ? '已开启自动对话日志' : '已关闭自动对话日志', 'ok');
            if (config.logEnabled) queueLogSave(currentSession());
        });
        const bindNotifyToggle = (node, key, label) => {
            if (!node) return;
            node.addEventListener('change', () => {
                config[key] = !!node.checked;
                saveAIConfig();
                setSettingsStatus(label + (node.checked ? '：已开启' : '：已关闭'), 'ok');
            });
        };
        bindNotifyToggle(opt.notifyInApp, 'notifyInApp', '应用内通知');
        bindNotifyToggle(opt.notifySystem, 'notifySystem', 'Windows 系统通知');
        bindNotifyToggle(opt.notifyFinish, 'notifyFinish', '任务完成通知');
        bindNotifyToggle(opt.notifyError, 'notifyError', '任务失败通知');
        bindNotifyToggle(opt.notifyAsk, 'notifyAsk', 'AI 提问通知');
        bindNotifyToggle(opt.notifySound, 'notifySound', '失焦提醒（闪烁/提示音）');
        if (opt.askTimeout) opt.askTimeout.addEventListener('change', () => {
            config.askTimeout = aiClampInt(opt.askTimeout.value, 0, 3600, 300);
            opt.askTimeout.value = String(config.askTimeout);
            saveAIConfig();
            setSettingsStatus(config.askTimeout > 0 ? 'AskQuestion 超时：' + config.askTimeout + ' 秒' : 'AskQuestion 不超时', 'ok');
        });
        if (opt.askTimeoutAction) opt.askTimeoutAction.addEventListener('change', () => {
            config.askTimeoutAction = ['recommended', 'wait', 'abort', 'ai_decide'].includes(opt.askTimeoutAction.value)
                ? opt.askTimeoutAction.value
                : 'recommended';
            opt.askTimeoutAction.value = config.askTimeoutAction;
            saveAIConfig();
            const labels = {recommended: '按 AI 推荐项继续', wait: '继续阻塞等待', abort: '直接停止本轮', ai_decide: '交给 AI 决定'};
            setSettingsStatus('AskQuestion 超时处理：' + labels[config.askTimeoutAction], 'ok');
        });
        if (opt.openLogs) opt.openLogs.addEventListener('click', openAILogDir);
        if (opt.approvedClear) opt.approvedClear.addEventListener('click', () => {
            if (!config.approvedPaths.length) return;
            askConfirm('清除全部「总是允许」的文件写操作授权？清除后恢复逐次审批。', () => {
                config.approvedPaths = [];
                saveAIConfig();
                renderApprovedSettings();
                flash('已清除全部写操作授权');
            }, '清除', '清除授权');
        });
        if (opt.presetAdd) opt.presetAdd.addEventListener('click', addPresetProfile);
        if (opt.modelCreate) opt.modelCreate.addEventListener('click', () => openModelEditor(null));
        if (opt.modelEditorClose) opt.modelEditorClose.addEventListener('click', () => closeModelEditor(false));
        if (opt.modelEditorMask) opt.modelEditorMask.addEventListener('click', () => closeModelEditor(false));
        if (opt.modelEditorCancel) opt.modelEditorCancel.addEventListener('click', () => closeModelEditor(false));
        if (opt.modelEditorSave) opt.modelEditorSave.addEventListener('click', () => closeModelEditor(true));
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modelEditorState) {
                e.preventDefault();
                e.stopPropagation();
                closeModelEditor(false);
            }
        }, true);
        if (opt.openMemory) opt.openMemory.addEventListener('click', () => {
            closeSettingsDialogForPanel();
            open(true);
            showMemoryDialog();
        });
        if (opt.openSkills) opt.openSkills.addEventListener('click', () => {
            closeSettingsDialogForPanel();
            open(true);
            showSkillsDialog();
        });
        if (opt.proxy) opt.proxy.addEventListener('change', () => {
            const profile = activeProfile();
            if (!profile) return;
            const mode = opt.proxy.value;
            if (opt.proxyURL) opt.proxyURL.disabled = mode !== 'custom';
            if (mode === 'system') profile.proxy = 'system';
            else if (mode === 'direct') profile.proxy = 'direct';
            else {
                profile.proxy = String((opt.proxyURL && opt.proxyURL.value) || '').trim() || 'http://';
                if (opt.proxyURL) opt.proxyURL.value = profile.proxy;
            }
            saveAIConfig();
            setSettingsStatus('代理已更新（下一轮生效）', 'ok');
        });
        if (opt.proxyURL) opt.proxyURL.addEventListener('change', () => {
            const profile = activeProfile();
            if (!profile || !opt.proxy || opt.proxy.value !== 'custom') return;
            profile.proxy = String(opt.proxyURL.value || '').trim();
            saveAIConfig();
            setSettingsStatus('代理地址已保存', 'ok');
        });
        if (opt.headers) opt.headers.addEventListener('change', () => {
            const profile = activeProfile();
            if (!profile) return;
            const lines = String(opt.headers.value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
            if (lines.length > 8) {
                setSettingsStatus('自定义请求头最多 8 条', 'error');
                refreshSettingsPane();
                return;
            }
            const headers = {};
            for (const line of lines) {
                const eq = line.indexOf('=');
                const colon = line.indexOf(':');
                const index = eq >= 0 ? eq : colon;
                if (index <= 0) {
                    setSettingsStatus('请求头格式：Header=value', 'error');
                    refreshSettingsPane();
                    return;
                }
                const name = line.slice(0, index).trim();
                const value = line.slice(index + 1).trim();
                if (name) headers[name] = value;
            }
            profile.extraHeaders = headers;
            saveAIConfig();
            setSettingsStatus('自定义请求头已保存（' + Object.keys(headers).length + ' 条）', 'ok');
            refreshSettingsPane();
        });
        if (opt.threshold) opt.threshold.addEventListener('change', () => {
            config.autoCompactThreshold = aiClamp(Number(opt.threshold.value) || 0.8, 0.5, 0.95);
            opt.threshold.value = String(config.autoCompactThreshold);
            saveAIConfig();
            updateCtxBanner();
        });
        if (opt.prompt) opt.prompt.addEventListener('change', () => {
            const selected = promptById(opt.prompt.value);
            if (opt.promptText) opt.promptText.value = selected ? selected.content : '';
            if (opt.promptDel) opt.promptDel.disabled = !selected || !!selected.builtin;
        });
        if (opt.promptSave) opt.promptSave.addEventListener('click', () => {
            const selected = promptById(opt.prompt && opt.prompt.value);
            if (!selected) return;
            const content = String((opt.promptText && opt.promptText.value) || '').trim();
            if (!content) {
                setSettingsStatus('模板内容不能为空', 'error');
                return;
            }
            selected.content = content;
            saveAIConfig();
            refreshPromptSettings();
            updateContextCount();
            setSettingsStatus('模板已保存：' + selected.name, 'ok');
        });
        if (opt.promptNew) opt.promptNew.addEventListener('click', () => {
            const content = String((opt.promptText && opt.promptText.value) || '').trim() || AI_DEFAULT_SYSTEM_PROMPT;
            const create = (name) => {
                const prompt = {id: aiNowId('prompt-'), name: String(name || '').trim().slice(0, 40) || '新模板', content, builtin: false};
                config.prompts.push(prompt);
                saveAIConfig();
                refreshPromptSettings();
                if (opt.prompt) opt.prompt.value = prompt.id;
                if (opt.promptText) opt.promptText.value = prompt.content;
                setSettingsStatus('已新建模板：' + prompt.name, 'ok');
            };
            if (showNameDialog) {
                showNameDialog({title: '新建提示词模板', label: '模板名称', placeholder: '例如：数据解释（精简）', okLabel: '创建', onSubmit: create});
            } else {
                const name = window.prompt('模板名称', '新模板');
                if (name) create(name);
            }
        });
        if (opt.promptDel) opt.promptDel.addEventListener('click', () => {
            const selected = promptById(opt.prompt && opt.prompt.value);
            if (!selected) return;
            if (selected.builtin) {
                setSettingsStatus('内置模板不可删除', 'error');
                return;
            }
            askConfirm('删除模板「' + selected.name + '」？', () => {
                config.prompts = config.prompts.filter((prompt) => prompt.id !== selected.id);
                if (config.activePromptId === selected.id) {
                    config.activePromptId = config.prompts[0] ? config.prompts[0].id : '';
                }
                saveAIConfig();
                refreshPromptSettings();
                updateContextCount();
                setSettingsStatus('已删除模板：' + selected.name, 'ok');
            }, '删除', '删除模板');
        });
        if (opt.promptDefault) opt.promptDefault.addEventListener('click', () => {
            const selected = promptById(opt.prompt && opt.prompt.value);
            if (!selected) return;
            config.activePromptId = selected.id;
            saveAIConfig();
            refreshPromptSettings();
            updateContextCount();
            setSettingsStatus('默认提示词模板：' + selected.name, 'ok');
        });
        if (opt.exportBtn) opt.exportBtn.addEventListener('click', exportAIConfig);
        if (opt.importBtn) opt.importBtn.addEventListener('click', importAIConfig);
        if (opt.clearSessions) opt.clearSessions.addEventListener('click', () => {
            askConfirm('清空全部 AI 会话（含消息、任务清单与变更记录）？', () => {
                sessions = [createSessionData()];
                messageQueue.length = 0;
                config.activeSessionId = sessions[0].id;
                persistSessions();
                renderSessionList();
                renderMessages(true);
                updateComposerState();
                setSettingsStatus('已清空全部会话', 'ok');
            }, '清空', '清空全部会话');
        });
        if (backend.AIAppDir) {
            Promise.resolve(backend.AIAppDir()).then((dir) => {
                if (opt.dir && dir) opt.dir.textContent = '应用数据目录：' + dir;
            }).catch(() => {});
        }
        refreshChatSettings();
        refreshSettingsPane();
        renderPresetSelect();
        refreshPromptSettings();
    }

    // ---------- 绑定面板交互 ----------

    function resizeInput() {
        if (!el.input) return;
        el.input.style.height = 'auto';
        const height = Math.min(180, Math.max(44, el.input.scrollHeight));
        el.input.style.height = height + 'px';
    }

    function submitFromComposer() {
        if (!el.input) return;
        const text = el.input.value;
        const trimmed = text.trim();
        if (!trimmed && !attachments.some((item) => item.kind === 'image')) return;
        if (trimmed.startsWith('/')) {
            handleSlashText(trimmed);
            return;
        }
        if (stream || oneShot) {
            enqueueComposerMessage();
            return;
        }
        submitText(text);
    }

    function handleComposerKey(e) {
        if (e.isComposing || e.keyCode === 229) return;
        if (slashState.open) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                slashState.index = Math.min(slashState.items.length - 1, slashState.index + 1);
                updateSlash();
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                slashState.index = Math.max(0, slashState.index - 1);
                updateSlash();
                return;
            }
            if (e.key === 'Tab') {
                e.preventDefault();
                const command = slashState.items[slashState.index];
                if (command && el.input) {
                    el.input.value = command.name;
                    updateSlash();
                    const end = el.input.value.length;
                    el.input.setSelectionRange(end, end);
                }
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                runSlashCommand(slashState.items[slashState.index]);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                hideSlash();
                return;
            }
        }
        if (e.key !== 'Enter') return;
        if (stream || oneShot) {
            if (e.shiftKey || e.altKey) return;
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) {
                interjectComposerMessage();
            } else {
                enqueueComposerMessage();
            }
            return;
        }
        const ctrlEnter = settings.aiSendKey === 'ctrl-enter';
        const shouldSend = ctrlEnter ? (e.ctrlKey || e.metaKey) : (!e.shiftKey && !e.altKey);
        if (!shouldSend) return;
        e.preventDefault();
        submitFromComposer();
    }

    function bindPanelInteractions() {
        for (const button of [activityButton, toolbarButton]) {
            if (button) button.addEventListener('click', () => toggle());
        }
        if (el.close) el.close.addEventListener('click', () => {
            if (floatWindow) {
                try {
                    if (window.runtime && window.runtime.Quit) {
                        window.runtime.Quit();
                        return;
                    }
                } catch (e) {}
                try {
                    if (backend.ForceClose) backend.ForceClose();
                } catch (e) {}
                return;
            }
            open(false);
        });
        if (el.head) {
            el.head.addEventListener('dblclick', (e) => {
                if (floatWindow || e.target.closest('button, select, input, textarea')) return;
                toggleFullscreen();
            });
        }
        if (el.modeSeg) {
            el.modeSeg.addEventListener('click', (e) => {
                const button = e.target.closest('button[data-ai-mode]');
                if (button) setMode(button.dataset.aiMode);
            });
        }
        if (sessionNewBtn) sessionNewBtn.addEventListener('click', () => {
            ensureOpen();
            newSession();
        });
        if (sessionMoreBtn) sessionMoreBtn.addEventListener('click', showSessionListMenu);
        if (el.moreBtn) el.moreBtn.addEventListener('click', showMoreMenu);
        if (el.attachBtn) el.attachBtn.addEventListener('click', showAttachMenu);
        if (el.permission) el.permission.addEventListener('click', showPermissionMenu);
        if (el.plan) el.plan.addEventListener('click', togglePlanMode);
        if (el.modelChip) el.modelChip.addEventListener('click', showModelMenu);
        if (el.promptsBtn) el.promptsBtn.addEventListener('click', () => showPromptDialog());
        if (el.memoryBtn) el.memoryBtn.addEventListener('click', () => showMemoryDialog());
        if (el.skillsBtn) el.skillsBtn.addEventListener('click', () => showSkillsDialog());
        if (el.ctxCompact) el.ctxCompact.addEventListener('click', startCompact);
        if (el.statsSessionBtn) el.statsSessionBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleStatsPop('session');
        });
        if (el.statsTokenBtn) el.statsTokenBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleStatsPop('token');
        });
        if (el.ctxBtn) el.ctxBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleCtxPop();
        });
        if (el.ctxPopCompact) el.ctxPopCompact.addEventListener('click', () => {
            hideCtxPop();
            startCompact();
        });
        if (el.dialogClose) el.dialogClose.addEventListener('click', closeAIDialog);
        if (el.changesBtn) {
            el.changesBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (el.changesPop && el.changesPop.classList.contains('hidden')) showChangesPopover();
                else hideChangesPopover();
            });
        }
        document.addEventListener('pointerdown', (e) => {
            if (openStatsPop) {
                const pop = statsPopEl(openStatsPop);
                const inPop = pop && pop.contains(e.target);
                const onTrigger = e.target.closest('#ai-ctx-btn') || e.target.closest('#ai-stats-session') || e.target.closest('#ai-stats-token');
                if (!inPop && !onTrigger) hideStatsPops();
            }
            if (!el.changesPop || el.changesPop.classList.contains('hidden')) return;
            if (e.target.closest('#ai-changes') || e.target.closest('#ai-changes-pop')) return;
            hideChangesPopover();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                hideCtxPop();
                hideChangesPopover();
                if (el.dialog && !el.dialog.classList.contains('hidden')) closeAIDialog();
            }
        });
        if (el.messages) {
            el.messages.addEventListener('click', handleMessageClick);
            el.messages.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                showAIMessageContextMenu(e);
            });
            el.messages.addEventListener('scroll', () => {
                const distance = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight;
                stickBottom = distance <= 80;
                updateScrollButton();
                if (el.messages.scrollTop <= 24) loadEarlierMessages();
            });
        }
        panel.addEventListener('contextmenu', (e) => {
            if (el.messages && el.messages.contains(e.target)) return;
            // 全屏模式下 AI 面板挂在主编辑区内：阻止事件落到主编辑区的空白右键菜单
            e.stopPropagation();
            if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
            e.preventDefault();
        });
        if (el.scrollBtn) el.scrollBtn.addEventListener('click', () => scrollToBottom(true));
        if (el.input) {
            el.input.addEventListener('input', () => {
                resizeInput();
                updateSendState();
                updateSlash();
            });
            el.input.addEventListener('keydown', handleComposerKey);
            el.input.addEventListener('paste', handleInputPaste);
            el.input.addEventListener('blur', () => {
                setTimeout(() => {
                    if (document.activeElement !== el.input) hideSlash();
                }, 150);
            });
        }
        if (el.send) el.send.addEventListener('click', submitFromComposer);
        if (el.stop) el.stop.addEventListener('click', stopGeneration);
        panel.querySelectorAll('.ai-resize').forEach((handle) => {
            handle.addEventListener('pointerdown', (e) => startResize(e, handle.dataset.aiResize));
        });
        window.addEventListener('pointermove', moveResize);
        window.addEventListener('pointerup', endResize);
        window.addEventListener('pointercancel', endResize);
        window.addEventListener('resize', onWindowResize);
    }

    function aiFontFace(id) {
        if (!id || id === 'follow') return '';
        const fonts = opts.fonts || {};
        const pick = (list, key) => {
            const face = (list || []).find((item) => item.id === key);
            return face ? face.family : '';
        };
        if (id.startsWith('ui:')) return pick(fonts.latin, id.slice(3));
        if (id.startsWith('mono:')) return pick(fonts.mono, id.slice(5));
        if (id.startsWith('cjk:')) return pick(fonts.cjk, id.slice(4));
        return '';
    }

    function aiChatFontStacks() {
        const fonts = opts.fonts || {};
        const faces = (list) => list || [];
        const uiEn = (faces(fonts.latin).find((face) => face.id === settings.uiFont) || {}).family || '"Inter"';
        const editorEn = (faces(fonts.mono).find((face) => face.id === settings.editorFontFamily) || {}).family || uiEn;
        const uiCjk = (faces(fonts.cjk).find((face) => face.id === settings.uiCjkFont) || {}).family || '"Microsoft YaHei UI", "微软雅黑"';
        const en = aiFontFace(settings.aiChatFontEn) || uiEn;
        const cjk = aiFontFace(settings.aiChatFontCjk) || uiCjk;
        const code = aiFontFace(settings.aiChatCodeFont) || editorEn;
        return {
            chat: en + ', ' + cjk + ', sans-serif',
            code: code + ', ' + cjk + ', monospace',
        };
    }

    function syncChatFontControls() {
        const value = aiClampInt(settings.aiChatFont, 10, 32, 13);
        if (opt.chatFont) opt.chatFont.value = String(value);
        if (opt.chatFontVal) opt.chatFontVal.value = String(value);
    }

    function scheduleFontSave() {
        if (fontSaveTimer) clearTimeout(fontSaveTimer);
        fontSaveTimer = setTimeout(() => {
            fontSaveTimer = 0;
            saveSettings();
        }, 300);
    }

    function setAIChatFont(value, options) {
        const next = aiClampInt(value, 10, 32, 13);
        const current = aiClampInt(settings.aiChatFont, 10, 32, 13);
        if (next !== current) {
            settings.aiChatFont = next;
            applyPanelSettings();
            syncChatFontControls();
        }
        if (options && options.deferSave) scheduleFontSave();
        else saveSettings();
    }

    function applyPanelSettings() {
        if (!panel) return;
        const font = aiClampInt(settings.aiChatFont, 10, 32, 13);
        panel.style.setProperty('--ai-chat-font', font + 'px');
        const stacks = aiChatFontStacks();
        panel.style.setProperty('--ai-chat-font-family', stacks.chat);
        panel.style.setProperty('--ai-chat-code-font', stacks.code);
        const thinking = settings.aiShowThinking !== false;
        const usage = settings.aiShowUsage !== false;
        panel.classList.toggle('ai-assistant-card', settings.aiAssistantCard === true);
        const changed = lastApplied.thinking !== thinking || lastApplied.usage !== usage;
        lastApplied = {font, thinking, usage};
        if (changed && isOpen()) renderMessages(true);
        updateSendState();
        positionOverlays();
    }

    // ---------- 底部 composer 接管：提问 / 计划批准 ----------

    function currentPendingAskEntry() {
        const session = currentSession();
        if (!session) return null;
        for (const entry of pendingAsks.values()) {
            if (entry.session === session && entry.ask && entry.ask.state === 'pending') return entry;
        }
        return null;
    }

    function planApprovalMessage(session) {
        if (!session || stream || oneShot || !session.planMode) return null;
        const index = lastAssistantIndex(session);
        if (index < 0 || index !== session.messages.length - 1) return null;
        const message = session.messages[index];
        if (!message || message.role !== 'assistant' || !message.planMode || message.status !== 'done' ||
            !String(message.content || '').trim()) return null;
        return message;
    }

    function planApprovalKey(session, message) {
        return session.id + ':' + (Number(message.ts) || 0) + ':' + String(message.content || '').length;
    }

    function askTakeoverKey(entry) {
        return entry.toolMessage.toolCallId || entry.key;
    }

    function askDraftFor(entry) {
        const key = askTakeoverKey(entry);
        let draft = askDrafts.get(key);
        if (draft) return draft;
        draft = {
            answers: entry.ask.questions.map((question) => ({
                selected: question.options.filter((option) => option.recommended)
                    .map((option) => option.label)
                    .slice(0, question.multiSelect ? 8 : 1),
                custom: '',
            })),
        };
        askDrafts.set(key, draft);
        return draft;
    }

    function renderAskTakeover(entry) {
        const ask = entry.ask;
        const draft = askDraftFor(entry);
        const key = askTakeoverKey(entry);
        el.takeover.dataset.takeoverKey = 'ask:' + key;
        el.takeover.textContent = '';
        const card = document.createElement('div');
        card.className = 'ai-takeover-card ai-ask-takeover';
        const head = document.createElement('div');
        head.className = 'ai-takeover-head';
        const icon = document.createElement('span');
        icon.className = 'ai-ask-icon';
        icon.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6.2 6.3a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.7.6-.7 1.1v.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".75" fill="currentColor"/></svg>';
        const title = document.createElement('span');
        title.className = 'ai-takeover-title';
        title.textContent = 'AI 提问' + (ask.questions.length > 1 ? ' · ' + ask.questions.length + ' 个问题' : '');
        head.append(icon, title);
        if (ask.deadline) {
            const countdown = document.createElement('span');
            countdown.className = 'ai-ask-countdown';
            countdown.dataset.askKey = key;
            countdown.textContent = askCountdownText(ask);
            head.appendChild(countdown);
        }
        const body = document.createElement('div');
        body.className = 'ai-takeover-body';
        ask.questions.forEach((question, index) => {
            const block = document.createElement('div');
            block.className = 'ai-ask-form-q';
            if (question.header) {
                const header = document.createElement('div');
                header.className = 'ai-ask-header';
                header.textContent = question.header;
                block.appendChild(header);
            }
            const q = document.createElement('div');
            q.className = 'ai-ask-question';
            q.textContent = (ask.questions.length > 1 ? (index + 1) + '. ' : '') + question.question;
            block.appendChild(q);
            if (question.detail) {
                const detail = document.createElement('div');
                detail.className = 'ai-ask-detail';
                detail.textContent = question.detail;
                block.appendChild(detail);
            }
            const options = document.createElement('div');
            options.className = 'ai-ask-options';
            const answerDraft = draft.answers[index];
            for (const option of question.options) {
                const selected = answerDraft.selected.includes(option.label);
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'ai-ask-option' + (option.recommended ? ' recommended' : '') + (selected ? ' selected' : '');
                const label = document.createElement('span');
                label.className = 'ai-ask-option-label';
                label.textContent = option.label;
                button.appendChild(label);
                if (option.recommended) {
                    const badge = document.createElement('span');
                    badge.className = 'ai-ask-badge';
                    badge.textContent = '推荐';
                    button.appendChild(badge);
                }
                if (option.description) {
                    const desc = document.createElement('span');
                    desc.className = 'ai-ask-option-desc';
                    desc.textContent = option.description;
                    button.appendChild(desc);
                }
                button.addEventListener('click', () => {
                    if (question.multiSelect) {
                        const at = answerDraft.selected.indexOf(option.label);
                        if (at >= 0) answerDraft.selected.splice(at, 1);
                        else answerDraft.selected.push(option.label);
                    } else {
                        answerDraft.selected = selected ? [] : [option.label];
                        answerDraft.custom = '';
                    }
                    renderAskTakeover(entry);
                });
                options.appendChild(button);
            }
            if (options.childNodes.length) block.appendChild(options);
            if (question.allowCustom) {
                const custom = document.createElement('div');
                custom.className = 'ai-ask-custom';
                const input = document.createElement('input');
                input.className = 'ai-ask-input';
                input.type = 'text';
                input.placeholder = question.options.length ? '其他回答…' : '输入回答…';
                input.spellcheck = false;
                input.value = answerDraft.custom;
                input.addEventListener('input', () => {
                    answerDraft.custom = input.value;
                });
                custom.appendChild(input);
                block.appendChild(custom);
            }
            body.appendChild(block);
        });
        const foot = document.createElement('div');
        foot.className = 'ai-takeover-foot';
        const hint = document.createElement('span');
        hint.className = 'ai-takeover-hint';
        hint.textContent = '可留空跳过；超时按设置处理';
        const stop = document.createElement('button');
        stop.type = 'button';
        stop.className = 'dlg-btn';
        stop.textContent = '停止本轮';
        stop.addEventListener('click', () => stopGeneration());
        const submit = document.createElement('button');
        submit.type = 'button';
        submit.className = 'dlg-btn primary';
        submit.textContent = '提交回答';
        submit.addEventListener('click', () => submitAskAnswers(entry, draft.answers));
        foot.append(hint, stop, submit);
        card.append(head, body, foot);
        el.takeover.appendChild(card);
    }

    function renderPlanTakeover(session, message) {
        const key = planApprovalKey(session, message);
        el.takeover.dataset.takeoverKey = 'plan:' + key;
        el.takeover.textContent = '';
        const card = document.createElement('div');
        card.className = 'ai-takeover-card ai-plan-takeover';
        const head = document.createElement('div');
        head.className = 'ai-takeover-head';
        const icon = document.createElement('span');
        icon.className = 'ai-plan-takeover-icon';
        icon.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5h9v9h-9z" fill="none" stroke="currentColor" stroke-width="1.2" rx="1"/><path d="M5.5 6h5M5.5 8.4h5M5.5 10.8h3" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';
        const title = document.createElement('span');
        title.className = 'ai-takeover-title';
        title.textContent = '计划等待批准';
        const mode = document.createElement('span');
        mode.className = 'ai-takeover-mode';
        mode.textContent = '计划模式';
        head.append(icon, title, mode);
        const body = document.createElement('div');
        body.className = 'ai-takeover-body';
        const preview = document.createElement('div');
        preview.className = 'ai-plan-preview';
        const text = String(message.content || '').trim();
        preview.textContent = text.length > 1600 ? text.slice(0, 1600) + '\n…' : text;
        body.appendChild(preview);
        const foot = document.createElement('div');
        foot.className = 'ai-takeover-foot';
        const hint = document.createElement('span');
        hint.className = 'ai-takeover-hint';
        hint.textContent = currentScopeOf(session) === 'read' ? '执行计划前请切换到编辑权限' : '批准后开始执行';
        if (currentScopeOf(session) === 'read') {
            const permission = document.createElement('button');
            permission.type = 'button';
            permission.className = 'dlg-btn';
            permission.textContent = '切换编辑权限';
            permission.addEventListener('click', () => {
                setScope('edit');
                updateComposerTakeover(true);
                renderMessageQueue();
            });
            foot.appendChild(permission);
        }
        const continueBtn = document.createElement('button');
        continueBtn.type = 'button';
        continueBtn.className = 'dlg-btn';
        continueBtn.textContent = '继续规划';
        continueBtn.addEventListener('click', () => {
            dismissedPlanApproval = key;
            updateComposerTakeover(true);
            renderMessageQueue();
            if (el.input) el.input.focus();
            flash('输入补充意见后发送，AI 会继续完善计划');
        });
        const accept = document.createElement('button');
        accept.type = 'button';
        accept.className = 'dlg-btn primary';
        accept.textContent = '执行计划';
        accept.addEventListener('click', () => acceptPlan(session, message));
        foot.append(hint, continueBtn, accept);
        card.append(head, body, foot);
        el.takeover.appendChild(card);
    }

    function updateComposerTakeover(force) {
        if (!el.takeover || !el.composer) return;
        const ask = currentPendingAskEntry();
        const session = currentSession();
        const plan = ask ? null : planApprovalMessage(session);
        const planKey = plan ? planApprovalKey(session, plan) : '';
        let key = '';
        if (ask) key = 'ask:' + askTakeoverKey(ask);
        else if (plan && dismissedPlanApproval !== planKey) key = 'plan:' + planKey;
        if (!force && key && el.takeover.dataset.takeoverKey === key) return;
        if (!key) {
            el.takeover.dataset.takeoverKey = '';
            el.takeover.classList.add('hidden');
            el.takeover.textContent = '';
            el.composer.classList.remove('ai-takeover-active');
            positionOverlays();
            return;
        }
        el.takeover.dataset.takeoverKey = key;
        el.takeover.classList.remove('hidden');
        el.composer.classList.add('ai-takeover-active');
        if (ask) renderAskTakeover(ask);
        else if (plan) renderPlanTakeover(session, plan);
        positionOverlays();
        if (stickBottom) scrollToBottom(false);
    }

    function currentQueueItems() {
        const session = currentSession();
        return session ? messageQueue.filter((item) => item.sessionId === session.id) : [];
    }

    function captureComposerMessage() {
        if (!el.input) return null;
        const text = String(el.input.value || '').trim();
        const items = attachments.slice();
        if (!text && !items.some((item) => item.kind === 'image')) return null;
        const session = currentSession();
        if (!session) return null;
        const item = {
            id: ++queueSeq,
            sessionId: session.id,
            text,
            attachments: items,
            ts: Date.now(),
        };
        el.input.value = '';
        resizeInput();
        attachments = [];
        renderAttachments();
        hideSlash();
        updateSendState();
        return item;
    }

    function renderMessageQueue() {
        if (!el.queue) return;
        const items = currentQueueItems();
        const session = currentSession();
        const plan = session ? planApprovalMessage(session) : null;
        const planKey = plan ? planApprovalKey(session, plan) : '';
        const showPlanReminder = !!(plan && dismissedPlanApproval === planKey);
        el.queue.innerHTML = '';
        el.queue.classList.toggle('hidden', !items.length && !showPlanReminder);
        if (showPlanReminder) {
            const row = document.createElement('div');
            row.className = 'ai-queue-row ai-plan-reminder';
            const badge = document.createElement('span');
            badge.className = 'ai-queue-badge';
            badge.textContent = '计划';
            const text = document.createElement('span');
            text.className = 'ai-queue-text';
            text.textContent = '计划等待批准';
            const view = document.createElement('button');
            view.type = 'button';
            view.className = 'ai-queue-action';
            view.textContent = '查看';
            view.addEventListener('click', () => {
                dismissedPlanApproval = '';
                updateComposerTakeover(true);
                renderMessageQueue();
            });
            row.append(badge, text, view);
            el.queue.appendChild(row);
        }
        for (const item of items) {
            const row = document.createElement('div');
            row.className = 'ai-queue-row';
            const badge = document.createElement('span');
            badge.className = 'ai-queue-badge';
            badge.textContent = '排队';
            const text = document.createElement('span');
            text.className = 'ai-queue-text';
            const imageCount = (item.attachments || []).filter((att) => att.kind === 'image').length;
            const attachCount = (item.attachments || []).filter((att) => att.kind !== 'image').length;
            const meta = [];
            if (imageCount) meta.push(imageCount + ' 张图片');
            if (attachCount) meta.push(attachCount + ' 个附件');
            text.textContent = (item.text || '（无文字）') + (meta.length ? ' · ' + meta.join(' · ') : '');
            text.title = item.text || '';
            const interject = document.createElement('button');
            interject.type = 'button';
            interject.className = 'ai-queue-action';
            interject.textContent = '插话';
            interject.title = '停止当前回复并立即发送这条消息';
            interject.addEventListener('click', () => {
                const index = messageQueue.indexOf(item);
                if (index < 0) return;
                if (!stream || stream.sessionId !== item.sessionId) {
                    flushMessageQueue(item.sessionId);
                    return;
                }
                messageQueue.splice(index, 1);
                messageQueue.unshift(item);
                renderMessageQueue();
                flash('插话已排队，正在停止当前回复…');
                interjectPending = true;
                stopGeneration();
            });
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'ai-queue-action';
            remove.textContent = '×';
            remove.title = '移除这条排队消息';
            remove.addEventListener('click', () => {
                const index = messageQueue.indexOf(item);
                if (index >= 0) messageQueue.splice(index, 1);
                renderMessageQueue();
            });
            row.append(badge, text, interject, remove);
            el.queue.appendChild(row);
        }
        if (el.hint && (stream || oneShot)) {
            el.hint.textContent = items.length
                ? '已排队 ' + items.length + ' 条 · Enter 继续排队 · Ctrl+Enter 插话'
                : '生成中 · Enter 排队 · Ctrl+Enter 插话';
        }
        positionOverlays();
    }

    function enqueueComposerMessage() {
        if (!stream && !oneShot) return false;
        const text = el.input ? String(el.input.value || '').trim() : '';
        if (text.startsWith('/')) {
            handleSlashText(text);
            return true;
        }
        const item = captureComposerMessage();
        if (!item) return false;
        messageQueue.push(item);
        renderMessageQueue();
        flash('已加入排队：' + (item.text ? item.text.slice(0, 24) : '图片'));
        return true;
    }

    function interjectComposerMessage() {
        const session = currentSession();
        if (!session) return;
        const text = el.input ? String(el.input.value || '').trim() : '';
        if (text.startsWith('/')) {
            handleSlashText(text);
            return;
        }
        const item = captureComposerMessage();
        if (!item) return;
        if (oneShot) {
            messageQueue.push(item);
            renderMessageQueue();
            flash('正在压缩上下文，消息已排队');
            return;
        }
        if (!stream || stream.sessionId !== session.id) {
            messageQueue.push(item);
            renderMessageQueue();
            flushMessageQueue(session.id);
            return;
        }
        messageQueue.unshift(item);
        renderMessageQueue();
        flash('插话已排队，正在停止当前回复…');
        interjectPending = true;
        stopGeneration();
    }

    async function flushMessageQueue(sessionId) {
        if (!sessionId || stream || oneShot) return;
        const session = currentSession();
        if (!session || session.id !== sessionId || session.archivedAt) return;
        if (currentPendingAskEntry() || planApprovalMessage(session)) return;
        const index = messageQueue.findIndex((item) => item.sessionId === sessionId);
        if (index < 0) return;
        const item = messageQueue[index];
        messageQueue.splice(index, 1);
        renderMessageQueue();
        attachments = (item.attachments || []).map((att) => ({...att}));
        renderAttachments();
        if (el.input) el.input.value = item.text || '';
        resizeInput();
        const ok = await submitText(item.text || '');
        if (!ok) {
            messageQueue.splice(Math.min(index, messageQueue.length), 0, item);
            if (el.input) el.input.value = '';
            attachments = [];
            renderAttachments();
            resizeInput();
            renderMessageQueue();
            updateSendState();
        }
    }

    function clearQueueForSession(sessionId) {
        for (let i = messageQueue.length - 1; i >= 0; i--) {
            if (messageQueue[i].sessionId === sessionId) messageQueue.splice(i, 1);
        }
        renderMessageQueue();
    }

    function updateComposerState() {
        renderProfileSelect();
        updateScopeUI();
        updateSendState();
        updateContextCount();
        updateSlash();
        updateComposerTakeover();
        renderMessageQueue();
    }

    // ---------- 初始化 ----------

    function init() {
        if (!config.activeSessionId || !sessions.some((s) => s.id === config.activeSessionId)) {
            config.activeSessionId = sessions[0].id;
            saveAIConfig();
        }
        renderSessionList();
        renderProfileSelect();
        renderAttachments();
        updateScopeUI();
        applyMode(mode, false);
        bindPanelInteractions();
        bindSettingsPane();
        applyPanelSettings();
        renderMessages();
        updateComposerState();
        panel.classList.toggle('hidden', floatWindow ? false : !settings.aiPanelOpen);
        refreshDockFill();
        updateEntryButtons();
        updateModeButtons();
        if (floatWindow || settings.aiPanelOpen) {
            stickBottom = true;
            setTimeout(() => {
                if (el.input) el.input.focus();
                scrollToBottom(false);
            }, 0);
        }
    }

    function paletteActions() {
        const actions = [
            {label: 'AI： 新建会话', action: () => { open(true); newSession(); }},
            {label: 'AI： 上下文统计（/context）', action: () => { open(true); contextSummaryText().then(showNote).catch((e) => showNote('上下文统计失败：' + ((e && e.message) || e), true)); }},
            {label: 'AI： 清空当前会话（/clear）', action: () => { open(true); clearCurrentSession(); }},
            {label: 'AI： 会话提示词…', action: () => { open(true); showPromptDialog(); }},
            {label: 'AI： 记忆管理…', action: () => { open(true); showMemoryDialog(); }},
            {label: 'AI： 技能管理…', action: () => { open(true); showSkillsDialog(); }},
            {label: 'AI： 压缩上下文（/compact）', action: () => { open(true); startCompact(); }},
            {label: 'AI： 查看已归档消息', action: () => { open(true); showArchivedDialog(); }},
            {label: 'AI： 生成 AGENTS.md（/init）', action: () => { open(true); runInitAgentsMd(); }},
            {label: 'AI： 导出会话为 Markdown', action: () => { open(true); exportSession(); }},
            {label: 'AI： 打开对话日志目录', action: openAILogDir},
        ];
        for (const profile of config.profiles) {
            actions.push({
                label: 'AI： 切换配置 ' + profile.name + (profile.model ? '（' + profile.model + '）' : ''),
                action: () => {
                    config.activeProfileId = profile.id;
                    saveAIConfig();
                    refreshSettingsPane();
                    renderProfileSelect();
                    updateComposerState();
                    if (isOpen()) renderMessages(true);
                    flash('已切换 AI 配置：' + profile.name);
                },
            });
        }
        return actions;
    }

    init();

    return {
        toggle,
        open,
        isOpen,
        setMode,
        applySettings: applyPanelSettings,
        refreshSettings: () => {
            refreshSettingsPane();
            refreshChatSettings();
            refreshPromptSettings();
            renderPresetSelect();
            renderModelList();
            refreshMemoryPath();
        },
        handleEvent,
        refreshContext,
        closeModelEditor,
        attachPath,
        attachSelection,
        paletteActions,
        getMode: () => mode,
        refreshDockFill,
        getScope: currentScope,
    };
}
