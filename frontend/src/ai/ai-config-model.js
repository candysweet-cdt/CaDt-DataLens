// ai-config-model.js：AI 配置「账号 + 多模型」数据层（纯函数，无 DOM 依赖，可单测）。
// 账号（profile）保存连接信息（provider / baseURL / apiKey / 代理 / 请求头）；
// models[] 下每个模型条目有独立的上下文窗口 / 输出窗口 / 输入能力 / 推理等级配置。
// 旧版单模型字段（model / maxTokens / contextWindow / …）保留为激活条目的镜像，
// 旧版本 exe 回滚后仍能读到一份可用配置；新逻辑一律以 models[] 为准。

export const CONTEXT_WINDOW_MIN = 2048;
export const CONTEXT_WINDOW_MAX = 8388608; // 8M tokens
export const OUTPUT_WINDOW_MIN = 1;
export const OUTPUT_WINDOW_MAX = 2097152; // 2M tokens
export const THINKING_BUDGET_MIN = 1024;
export const THINKING_BUDGET_MAX = 393215;

export const MODALITY_KEYS = ['text', 'image', 'video', 'audio'];
export const MODALITY_LABELS = {text: '文本', image: '图像', video: '视频', audio: '音频'};

export function clampNumber(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

// 窗口类输入支持 K / M 单位：'256K' → 262144、'1M' → 1048576、'131K' → 134144、
// '1.5M' → 1572864、'4096' → 4096；非法输入（负数 / 非数字 / 空串）返回 null。
export function parseTokenAmount(raw) {
    if (typeof raw === 'number') {
        if (!Number.isFinite(raw) || raw <= 0) return null;
        return Math.round(raw);
    }
    const text = String(raw == null ? '' : raw).trim().replace(/[,\s_]/g, '');
    if (!text) return null;
    const match = text.match(/^(\d+(?:\.\d+)?)([kKmM])?$/);
    if (!match) return null;
    const base = Number(match[1]);
    if (!Number.isFinite(base) || base <= 0) return null;
    const unit = (match[2] || '').toLowerCase();
    const scale = unit === 'k' ? 1024 : (unit === 'm' ? 1024 * 1024 : 1);
    const value = Math.round(base * scale);
    return value > 0 ? value : null;
}

// 数字回显：能精确表示成整 K / M 时用单位显示（262144 → '256K'），否则原样。
export function formatTokenAmount(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n >= 1048576 && n % 1048576 === 0) return (n / 1048576) + 'M';
    if (n >= 1024 && n % 1024 === 0) return (n / 1024) + 'K';
    return String(n);
}

// 窗口字段归一：先按 K/M 解析，再 clamp；解析失败退回数字 clamp（含回退值）。
export function windowValue(value, min, max, fallback) {
    const parsed = parseTokenAmount(value);
    if (parsed != null) return clampNumber(parsed, min, max, fallback);
    return clampNumber(value, min, max, fallback);
}

export function defaultModalities() {
    // 默认勾选文本 + 图像；视频 / 音频留待模型与发送通道支持后再开。
    return {text: true, image: true, video: false, audio: false};
}

export function normalizeModalities(raw) {
    const out = defaultModalities();
    if (raw && typeof raw === 'object') {
        for (const key of MODALITY_KEYS) {
            if (raw[key] === true || raw[key] === false) out[key] = raw[key];
        }
    }
    return out;
}

export function normalizeModelEntry(raw, idGen) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        id: String(source.id || '').trim() || (idGen ? idGen() : 'model-' + Date.now().toString(36)),
        model: String(source.model || '').trim(),
        contextWindow: windowValue(source.contextWindow, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX, 128000),
        outputWindow: windowValue(
            source.outputWindow != null ? source.outputWindow : source.maxTokens,
            OUTPUT_WINDOW_MIN, OUTPUT_WINDOW_MAX, 4096),
        modalities: normalizeModalities(source.modalities),
        reasoningEffort: ['low', 'medium', 'high'].includes(source.reasoningEffort) ? source.reasoningEffort : '',
        thinking: source.thinking === true,
        thinkingBudget: clampNumber(source.thinkingBudget, THINKING_BUDGET_MIN, THINKING_BUDGET_MAX, 8000),
    };
}

// 取账号的激活模型条目：按 activeModelId 精确匹配，缺省退回首条目；无条目返回 null。
export function modelEntryOf(account, activeModelId) {
    const models = account && Array.isArray(account.models) ? account.models : [];
    if (!models.length) return null;
    const id = String(activeModelId || '');
    return models.find((entry) => entry && entry.id === id) || models[0];
}

// 确保 account.models 为归一化的非空数组；旧版单模型 profile 迁移为首条目，
// 并把旧字段同步为激活条目（缺省首条目）的镜像。
export function migrateAccountModels(account, activeModelId, idGen) {
    if (!account || typeof account !== 'object') return [];
    const seen = new Set();
    let models = Array.isArray(account.models)
        ? account.models
            .filter((raw) => raw && typeof raw === 'object')
            .map((raw) => normalizeModelEntry(raw, idGen))
            .filter((entry) => {
                if (seen.has(entry.id)) return false;
                seen.add(entry.id);
                return true;
            })
        : [];
    if (!models.length) {
        models = [normalizeModelEntry({
            id: account.id ? account.id + '-m1' : '',
            model: account.model,
            contextWindow: account.contextWindow,
            outputWindow: account.maxTokens,
            reasoningEffort: account.reasoningEffort,
            thinking: account.thinking,
            thinkingBudget: account.thinkingBudget,
        }, idGen)];
    }
    account.models = models;
    const mirror = modelEntryOf(account, activeModelId) || models[0];
    account.model = mirror.model;
    account.maxTokens = mirror.outputWindow;
    account.contextWindow = mirror.contextWindow;
    account.reasoningEffort = mirror.reasoningEffort;
    account.thinking = mirror.thinking;
    account.thinkingBudget = mirror.thinkingBudget;
    return models;
}

// 组装发请求用的 AIConfig：连接类字段取账号，模型类字段取条目。
export function configForModel(account, entry) {
    const provider = account && account.provider === 'anthropic' ? 'anthropic' : 'openai';
    return {
        provider,
        baseURL: account ? String(account.baseURL || '') : '',
        apiKey: account ? String(account.apiKey || '') : '',
        model: entry ? String(entry.model || '') : '',
        temperature: account ? Number(account.temperature) || 0 : 0,
        maxTokens: entry ? entry.outputWindow : 4096,
        proxy: account ? String(account.proxy || '') : '',
        extraHeaders: (account && account.extraHeaders && typeof account.extraHeaders === 'object')
            ? account.extraHeaders : {},
        thinking: provider === 'anthropic' && !!entry && entry.thinking === true,
        thinkingBudget: entry ? entry.thinkingBudget : 8000,
        reasoningEffort: provider === 'anthropic' ? '' : (entry ? (entry.reasoningEffort || '') : ''),
    };
}

// 解析模型引用（自动审批分类器等场景）：'accountId|modelId'；兼容旧格式（纯账号 id
// 解析为该账号首条目）。无效 / 已删除返回 ''（跟随当前模型）。
export function resolveModelRef(rawRef, profiles) {
    const ref = String(rawRef == null ? '' : rawRef).trim();
    if (!ref || !Array.isArray(profiles)) return '';
    const sep = ref.indexOf('|');
    const accountId = sep >= 0 ? ref.slice(0, sep) : ref;
    const modelId = sep >= 0 ? ref.slice(sep + 1) : '';
    const account = profiles.find((p) => p && typeof p === 'object' && p.id === accountId);
    if (!account) return '';
    const models = Array.isArray(account.models) ? account.models : [];
    if (modelId) {
        return models.some((entry) => entry && entry.id === modelId) ? ref : '';
    }
    return models[0] ? accountId + '|' + models[0].id : '';
}

// 下拉 / 菜单选项标签：模型名 · 账号名（与模型菜单一致）；缺模型名时退回账号名。
export function modelRefLabel(account, entry) {
    const model = entry && entry.model ? String(entry.model).trim() : '';
    const name = account && account.name ? String(account.name).trim() : '';
    const primary = model || name;
    if (!primary) return '';
    return name && name !== primary ? primary + ' · ' + name : primary;
}
