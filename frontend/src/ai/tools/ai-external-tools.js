// ai-external-tools.js：外部工具来源矩阵与结果格式化（纯函数）。
// 配置真源是 Go 侧 external-tools.json（apiKey 只下发掩码）；这里负责前端归一化、
// 「实际可用来源」的判定（provider 缺 key / mcp 绑定失效都按 off）与工具结果整形。
import {AI_WRITE_SCOPES} from '../core/ai-constants.js';
import {formatBytes} from '../../core/humanize.js';

export const EXTERNAL_CAPABILITIES = [
    {key: 'search', label: '网页搜索', builtin: true},
    {key: 'fetch', label: '网页抓取', builtin: true},
    {key: 'ocr', label: 'OCR / 文件解析'},
    {key: 'tts', label: '语音合成'},
    {key: 'asr', label: '语音识别'},
];

export const EXTERNAL_MODE_LABELS = {
    builtin: '内置',
    provider: '服务提供商',
    mcp: '本地 MCP',
    off: '关闭',
};

export const OCR_TEXT_BUDGET = 40000;
export const TTS_MAX_CHARS = 5000;
export const DEFAULT_PROVIDER_BASE_URL = 'https://api.deepseek.com/v1/tools';

export function defaultExternalToolsConfig() {
    const capabilities = {};
    const mcpBindings = {};
    for (const cap of EXTERNAL_CAPABILITIES) {
        capabilities[cap.key] = {mode: cap.builtin ? 'builtin' : 'off'};
        mcpBindings[cap.key] = '';
    }
    return {
        enabled: false,
        baseUrl: '',
        apiKeySet: false,
        searchCount: 10,
        capabilities,
        mcpBindings,
    };
}

function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

// normalizeExternalToolsConfig：把 Go 掩码配置或旧缓存归一成稳定形状。
export function normalizeExternalToolsConfig(raw) {
    const cfg = defaultExternalToolsConfig();
    const src = raw && typeof raw === 'object' ? raw : {};
    cfg.enabled = src.enabled === true;
    cfg.baseUrl = typeof src.baseUrl === 'string' ? src.baseUrl.trim() : '';
    cfg.apiKeySet = src.apiKeySet === true;
    cfg.searchCount = clampInt(src.searchCount, 1, 50, 10);
    const caps = src.capabilities && typeof src.capabilities === 'object' ? src.capabilities : {};
    for (const cap of EXTERNAL_CAPABILITIES) {
        const entry = caps[cap.key];
        const mode = String((entry && entry.mode) || '').toLowerCase();
        const allowed = cap.builtin ? ['builtin', 'provider', 'mcp', 'off'] : ['provider', 'mcp', 'off'];
        if (allowed.includes(mode)) cfg.capabilities[cap.key] = {mode};
    }
    const bindings = src.mcpBindings && typeof src.mcpBindings === 'object' ? src.mcpBindings : {};
    for (const cap of EXTERNAL_CAPABILITIES) {
        const binding = typeof bindings[cap.key] === 'string' ? bindings[cap.key] : '';
        cfg.mcpBindings[cap.key] = binding.trim().slice(0, 200);
    }
    return cfg;
}

export function externalProviderReady(cfg) {
    return !!(cfg && cfg.enabled === true && cfg.apiKeySet === true);
}

// effectiveExternalMode：配置声明 + 运行条件后的真实来源（工具可见性与执行路由共用）。
// provider 缺总开关 / Key、mcp 无绑定或绑定的工具不在快照里 → 一律按 off。
export function effectiveExternalMode(cfg, capability, mcpToolNames) {
    const mode = String((cfg && cfg.capabilities && cfg.capabilities[capability] && cfg.capabilities[capability].mode) || 'off');
    if (mode === 'builtin') {
        return capability === 'search' || capability === 'fetch' ? 'builtin' : 'off';
    }
    if (mode === 'provider') return externalProviderReady(cfg) ? 'provider' : 'off';
    if (mode === 'mcp') {
        const binding = String((cfg && cfg.mcpBindings && cfg.mcpBindings[capability]) || '');
        return binding && (mcpToolNames || []).includes(binding) ? 'mcp' : 'off';
    }
    return 'off';
}

export function externalToolsAvailability(cfg, mcpToolNames) {
    const out = {};
    for (const cap of EXTERNAL_CAPABILITIES) {
        out[cap.key] = effectiveExternalMode(cfg, cap.key, mcpToolNames);
    }
    return out;
}

// externalCapabilityUsable：某来源在某权限档 / 计划模式下能否向模型下发。
// - 搜索/抓取：内置与 provider 全档可用（含计划模式）；MCP 沿用 MCP 边界（写档、非计划）
// - OCR / ASR：provider 全档（读文件，不写工作区）；MCP 同上
// - TTS：必须写工作区产物目录，写档且非计划模式
export function externalCapabilityUsable(capability, mode, scope, planMode) {
    if (!mode || mode === 'off') return false;
    if (capability === 'tts') return AI_WRITE_SCOPES.includes(scope) && !planMode;
    if (mode === 'mcp') return AI_WRITE_SCOPES.includes(scope) && !planMode;
    return true;
}

// defaultSearchCount：设置里的条数受工具单次上限 10 约束。
export function defaultSearchCount(cfg) {
    const raw = cfg && cfg.searchCount != null ? cfg.searchCount : undefined;
    return clampInt(raw, 1, 10, 10);
}

export function formatExternalMoney(amount) {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return '约 ¥0';
    const text = value >= 0.01 ? value.toFixed(3) : value.toFixed(4);
    return '约 ¥' + text.replace(/0+$/, '').replace(/\.$/, '');
}

export function formatAudioClock(ms) {
    const total = Math.max(0, Math.round(Number(ms) / 1000) || 0);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ':' + String(s).padStart(2, '0');
}

export function formatOcrOutput(result) {
    const pages = Array.isArray(result && result.pages) ? result.pages : [];
    const pageCount = Math.max(0, Math.round(Number(result && result.pageCount) || pages.length));
    const lines = ['DeepSeek OCR（' + pageCount + ' 页，' + formatExternalMoney(pageCount * 0.0015) + '）'];
    if (!pages.length) {
        lines.push('', '（没有识别到文字）');
        return lines.join('\n');
    }
    let budget = OCR_TEXT_BUDGET;
    let omittedFrom = 0;
    let omittedTo = 0;
    for (let i = 0; i < pages.length; i++) {
        const page = pages[i] || {};
        const heading = '--- 第 ' + (Number(page.index) + 1 || i + 1) + ' 页 ---';
        const note = page.finishReason === 'length' ? '\n（该页输出达到上限，文本可能不完整）' : '';
        const block = heading + '\n' + String(page.text || '') + note;
        if (budget - block.length <= 0) {
            omittedFrom = (Number(page.index) + 1) || (i + 1);
            omittedTo = (Number(pages[pages.length - 1].index) + 1) || pages.length;
            break;
        }
        budget -= block.length;
        lines.push('', block);
    }
    if (omittedFrom) {
        lines.push('', '…（正文超过 ' + OCR_TEXT_BUDGET + ' 字符，已省略第 ' + omittedFrom + '–' + omittedTo +
            ' 页；不自动重试，避免重复计费）');
    }
    return lines.join('\n');
}

export function formatTtsOutput(result) {
    const chars = Math.max(0, Math.round(Number(result && result.chars) || 0));
    const voice = String((result && result.voice) || 'stella');
    const shownPath = String((result && (result.relPath || result.path)) || '');
    return [
        'DeepSeek TTS（' + chars + ' 字符，voice=' + voice + '）',
        '已保存：' + shownPath + '（' + formatBytes(result && result.bytes) + '）',
    ].join('\n');
}

export function formatAsrOutput(result) {
    const durationMs = Math.max(0, Number(result && result.durationMs) || 0);
    const cost = durationMs / 3600000 * 0.78;
    const text = String((result && result.text) || '').trim();
    return [
        'DeepSeek ASR（' + formatAudioClock(durationMs) + '，' + formatExternalMoney(cost) + '）',
        '',
        text || '（没有识别到文字）',
    ].join('\n');
}

// formatMcpSourceLine：来源=本地 MCP 时统一的结果首行。
export function formatMcpSourceLine(binding) {
    return '来源：本地 MCP（' + String(binding || '') + '）';
}
