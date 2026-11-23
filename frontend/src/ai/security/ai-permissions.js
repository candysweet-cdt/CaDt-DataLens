// 权限规则与统一决策链的纯函数层。
// 规则文件：<工作区>/.cadt/permissions.json，结构
//   {version:1, command:{allow:[],ask:[],deny:[]}, write:{...}, web:{...}, read:{...}}
// 设置页用行语法编辑：一行一条 Bash(...) / Write(...) / Web(...) / Read(...)，空行与 # 注释忽略。
// read 桶：工作区外读取的项目级授权（Read(D:/xxx/**) 目录树 glob），判定链见 decidePermission。
import {AI_SCOPES} from '../core/ai-constants.js';

export const PERMISSION_VERSION = 1;
export const PERMISSION_KINDS = ['command', 'write', 'web', 'read'];
export const PERMISSION_BEHAVIORS = ['deny', 'ask', 'allow'];

const RULE_LIMIT = 300;
const RULE_TEXT_LIMIT = 400;

const KIND_PREFIX = {command: 'Bash', write: 'Write', web: 'Web', read: 'Read'};
const PREFIX_KIND = {bash: 'command', write: 'write', web: 'web', read: 'read'};

export function emptyPermissionRules() {
    return {
        command: {allow: [], ask: [], deny: []},
        write: {allow: [], ask: [], deny: []},
        web: {allow: [], ask: [], deny: []},
        read: {allow: [], ask: [], deny: []},
    };
}

function normalizeRuleText(value) {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (!text || text.length > RULE_TEXT_LIMIT) return '';
    return text;
}

export function normalizePermissionRules(raw) {
    const out = emptyPermissionRules();
    if (!raw || typeof raw !== 'object') return out;
    for (const kind of PERMISSION_KINDS) {
        const group = raw[kind];
        if (!group || typeof group !== 'object') continue;
        for (const behavior of PERMISSION_BEHAVIORS) {
            const list = Array.isArray(group[behavior]) ? group[behavior] : [];
            const seen = new Set();
            for (const item of list) {
                if (typeof item !== 'string') continue;
                const text = normalizeRuleText(item);
                if (!text || seen.has(text.toLowerCase())) continue;
                seen.add(text.toLowerCase());
                out[kind][behavior].push(text);
                if (out[kind][behavior].length >= RULE_LIMIT) break;
            }
        }
    }
    return out;
}

function wildcardToRegExp(pattern) {
    const escaped = String(pattern)
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
    return new RegExp('^' + escaped + '$', 'i');
}

function pathGlobRegExp(pattern) {
    const value = String(pattern).toLowerCase();
    let out = '';
    for (let i = 0; i < value.length; i += 1) {
        const ch = value[i];
        if (ch === '*') {
            if (value[i + 1] === '*') {
                out += '.*';
                i += 1;
                if (value[i + 1] === '/') i += 1;
            } else {
                out += '[^/]*';
            }
        } else if ('\\^$.|?+()[]{}'.includes(ch)) {
            out += '\\' + ch;
        } else {
            out += ch;
        }
    }
    return new RegExp('^' + out + '$');
}

export function writeRuleSubject(path) {
    return String(path == null ? '' : path).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim();
}

export function webRuleSubject(url) {
    try {
        const parsed = new URL(String(url == null ? '' : url).trim());
        const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
        return host ? 'domain:' + host : '';
    } catch (e) {
        return '';
    }
}

// 网络类审批（web_fetch 与 read_image 的网图通道）：授权语义是「允许访问这个网址」，
// 不是「在工作目录执行这条命令」——审批卡文案、审计 kind/subject 都要按网络处理。
// `web` 标记由发起方显式写入；旧会话的审批对象没有该字段，回落到工具名。
export function isWebApproval(approval) {
    if (!approval || typeof approval !== 'object') return false;
    if (approval.web === true) return true;
    return approval.tool === 'web_fetch';
}

// 路径 glob 匹配（write 与 read 共用）：`D:/xxx/**` 覆盖目录本身与其子树。
function matchPathGlobRule(subject, rule) {
    const path = writeRuleSubject(subject).toLowerCase();
    const pattern = writeRuleSubject(rule).toLowerCase();
    if (!path || !pattern) return false;
    if (pattern.endsWith('/**')) {
        const base = pattern.slice(0, -3);
        if (path === base) return true;
    }
    return pathGlobRegExp(pattern).test(path);
}

export function matchPermissionRule(kind, subject, rule) {
    const text = String(subject == null ? '' : subject).trim();
    const value = normalizeRuleText(rule);
    if (!text || !value) return false;
    if (kind === 'command') {
        const target = text.replace(/\s+/g, ' ').toLowerCase();
        const pattern = value.replace(/\s+/g, ' ').toLowerCase();
        if (pattern.endsWith(':*')) {
            const prefix = pattern.slice(0, -2).trim();
            if (!prefix) return false;
            return target === prefix || target.startsWith(prefix + ' ') || target.startsWith(prefix + '\t');
        }
        if (pattern.includes('*')) return wildcardToRegExp(pattern).test(target);
        return target === pattern;
    }
    if (kind === 'write' || kind === 'read') return matchPathGlobRule(text, value);
    if (kind === 'web') {
        const host = text.startsWith('domain:') ? text.slice(7) : text;
        const pattern = value.startsWith('domain:') ? value.slice(7) : value;
        if (!host || !pattern) return false;
        return wildcardToRegExp(pattern).test(host);
    }
    return false;
}

/**
 * 按 deny → ask → allow 顺序取第一条命中规则。
 */
export function evaluatePermissionRules(rules, kind, subject) {
    const group = rules && rules[kind];
    if (!group) return {decision: '', rule: ''};
    for (const behavior of PERMISSION_BEHAVIORS) {
        const list = Array.isArray(group[behavior]) ? group[behavior] : [];
        for (const rule of list) {
            if (matchPermissionRule(kind, subject, rule)) return {decision: behavior, rule};
        }
    }
    return {decision: '', rule: ''};
}

/**
 * 设置页行语法解析。前缀缺失或括号不闭合的行记为错误，不静默丢弃。
 */
export function parseRuleLines(text, behavior) {
    const rules = emptyPermissionRules();
    const errors = [];
    const lines = String(text == null ? '' : text).split(/\r?\n/);
    lines.forEach((raw, index) => {
        const line = String(raw || '').trim();
        if (!line || line.startsWith('#') || line.startsWith('//')) return;
        const match = line.match(/^([A-Za-z]+)\s*\(([\s\S]*)\)$/);
        if (!match) {
            errors.push('第 ' + (index + 1) + ' 行：需要 Bash(...) / Write(...) / Web(...) / Read(...) 格式');
            return;
        }
        const kind = PREFIX_KIND[match[1].toLowerCase()];
        if (!kind) {
            errors.push('第 ' + (index + 1) + ' 行：未知前缀 ' + match[1] + '（只会 Bash / Write / Web / Read）');
            return;
        }
        const content = normalizeRuleText(match[2]);
        if (!content) {
            errors.push('第 ' + (index + 1) + ' 行：规则内容为空');
            return;
        }
        if (rules[kind][behavior].some((rule) => rule.toLowerCase() === content.toLowerCase())) return;
        if (rules[kind][behavior].length >= RULE_LIMIT) {
            errors.push('第 ' + (index + 1) + ' 行：规则数量超过上限 ' + RULE_LIMIT);
            return;
        }
        rules[kind][behavior].push(content);
    });
    return {rules, errors};
}

export function formatRuleLines(rules, behavior) {
    const lines = [];
    for (const kind of PERMISSION_KINDS) {
        const list = rules && rules[kind] && Array.isArray(rules[kind][behavior]) ? rules[kind][behavior] : [];
        for (const rule of list) lines.push(KIND_PREFIX[kind] + '(' + rule + ')');
    }
    return lines.join('\n');
}

export function countPermissionRules(rules) {
    let total = 0;
    for (const kind of PERMISSION_KINDS) {
        for (const behavior of PERMISSION_BEHAVIORS) {
            total += rules && rules[kind] && Array.isArray(rules[kind][behavior]) ? rules[kind][behavior].length : 0;
        }
    }
    return total;
}

// ---------- 自动审批分类器的模型选择 ----------

// 分类器请求模型存「配置 id」；空串 / 配置已删除 = 跟随当前模型。
export function resolveClassifierProfileId(rawId, profiles) {
    const id = String(rawId == null ? '' : rawId).trim();
    if (!id || !Array.isArray(profiles)) return '';
    return profiles.some((profile) => profile && typeof profile === 'object' && profile.id === id) ? id : '';
}

// 下拉选项标签，与模型菜单的「model · 配置名」格式一致；缺 model 时退回配置名。
export function classifierModelOptionLabel(profile) {
    if (!profile || typeof profile !== 'object') return '';
    const model = String(profile.model || '').trim();
    const name = String(profile.name || '').trim();
    const primary = model || name;
    if (!primary) return '';
    return name && name !== primary ? primary + ' · ' + name : primary;
}

/**
 * 统一决策链：项目 deny → 不可长期放行的危险命令 → 项目 ask → 会话/项目 allow
 * → 模式默认（完全权限 / 自动审批 / 逐次询问）。返回的 decision 可能是
 * allow / ask / deny / classify（自动审批 + 分类器开）。
 */
export function decidePermission(input) {
    const {
        scope = 'read',
        kind = 'command',
        rules = null,
        subject = '',
        sessionAllow = false,
        familyAuto = false,
        readOnly = false,
        dangerous = false,
        risky = false,
        classifierEnabled = false,
        gitFlowSafe = false,
    } = input || {};
    const hit = evaluatePermissionRules(rules, kind, subject);
    if (hit.decision === 'deny') return {decision: 'deny', source: 'project', rule: hit.rule};
    if (dangerous && scope !== 'full') return {decision: 'ask', source: 'dangerous', singleUse: true};
    if (hit.decision === 'ask') return {decision: 'ask', source: 'project', rule: hit.rule};
    if (sessionAllow) return {decision: 'allow', source: 'session'};
    if (hit.decision === 'allow') return {decision: 'allow', source: 'project', rule: hit.rule};
    if (scope === 'full') return {decision: 'allow', source: 'full'};
    if (kind === 'write') {
        if (scope === 'auto') {
            if (risky) return {decision: 'ask', source: 'risky'};
            return {decision: 'allow', source: 'auto'};
        }
        return {decision: 'ask', source: 'scope'};
    }
    if (kind === 'web') return {decision: 'allow', source: 'default'};
    if (kind === 'read') {
        // 工作区外读取：auto 档直接放行（auto 契约即非风险自主执行，命令通道本就能绕行）；
        // read/edit 档转人工（read 档没有命令等其他通道；edit 与其命令审批口径一致）。
        // 用户点名 / 已批准读根（sessionAllow）已在上方统一放行；full 档在路径闸就不越界。
        if (scope === 'auto') return {decision: 'allow', source: 'auto'};
        return {decision: 'ask', source: 'scope'};
    }
    if (scope === 'auto') {
        // Git 快捷操作一次性窄豁免：只在 auto 档、命令通道、令牌有效且命令静态安全时放行。
        // 危险命令 / 项目 deny/ask 已在上方拦截，这里只兜 auto 档常规 git 写命令。
        if (gitFlowSafe) return {decision: 'allow', source: 'git-flow'};
        if (readOnly) return {decision: 'allow', source: 'readonly'};
        if (familyAuto) return {decision: 'allow', source: 'family'};
        if (classifierEnabled) return {decision: 'classify', source: 'classifier'};
    }
    return {decision: 'ask', source: 'scope'};
}

// 审批卡等待期间档位可能被提升到完全权限（分类器最长 12s）：卡片发起前按当前档位重判。
// 项目 ask 规则有意压过 full（用户显式要求该命令必问），其余来源（scope / dangerous /
// classifier）在 full 下都应直接放行——否则会出现「已经开了完全权限还弹卡」的竞态
// （2026-11-17 实测：auto 下发起的 sed 判定在切到 full 后返回 ask，卡片照弹）。
export function scopeUpgradedToFull(scope, source) {
    return scope === 'full' && String(source || '') !== 'project';
}

// ---------- 端侧命令分类器：严格度阈值 ----------

// 严格度三档的 allow 阈值（危险概率 score < T 才放行）。三档共用同一语义：
// 内置线性模型与插件分类器只产出 score，判定统一在这里做（docs/finished-plans/local-command-classifier.md §5）。
export const LOCAL_CLASSIFIER_THRESHOLDS = {loose: 0.30, standard: 0.15, strict: 0.07};
export const LOCAL_CLASSIFIER_STRICTNESS_LABELS = {loose: '宽松', standard: '标准', strict: '严格'};
// 连续失败熔断阈值：分类器连续抛错 N 次后本会话内停用，避免每条命令都空等。
export const LOCAL_CLASSIFIER_FAIL_LIMIT = 5;

export function normalizeLocalClassifierStrictness(raw) {
    const value = String(raw == null ? '' : raw).trim();
    return Object.prototype.hasOwnProperty.call(LOCAL_CLASSIFIER_THRESHOLDS, value) ? value : 'standard';
}

export function localClassifierThreshold(strictness) {
    return LOCAL_CLASSIFIER_THRESHOLDS[normalizeLocalClassifierStrictness(strictness)];
}

// score → allow/ask 判定。端侧模型无 deny 权：score ≥ T 一律转人工。
export function judgeLocalClassifier(score, strictness) {
    const threshold = localClassifierThreshold(strictness);
    const value = Number(score);
    const safe = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
    return {allow: safe < threshold, score: safe, threshold};
}

// ---------- 新会话默认权限档 ----------

// 新会话默认权限档（设置 → AI）：只接受现有权限档集合内的值，
// 非法 / 缺省回退 'read'（只读访问，历史默认行为）。
export function normalizeDefaultScope(raw) {
    const value = String(raw == null ? '' : raw).trim();
    return AI_SCOPES.includes(value) ? value : 'read';
}

// ---------- 操作留痕的 actor 归属 ----------

// 归属按**判定来源**分，不看是否经过审批卡：
//   user   —— 用户在审批卡上拍板，或用户预先写下的授权（项目规则 / 会话规则 / 设置页）
//   ai     —— 模型侧自动判定（只读 / 家族 / git 快捷 / 端侧与云端分类器 / 完全权限直通）
//   system —— 宿主强制（工作区隔离守卫）与产品内置默认（web 默认放行）
// 未知来源归 ai：把自动放行记成人工批准是最坏的失真方向，宁可少记人的功劳。
const PERMISSION_ACTOR_BY_SOURCE = {
    user: 'user',
    project: 'user',
    session: 'user',
    readonly: 'ai',
    family: 'ai',
    'git-flow': 'ai',
    classifier: 'ai',
    'local-classifier': 'ai',
    full: 'ai',
    auto: 'ai',
    'worktree-isolation': 'system',
    'agent-worktree': 'system',
    default: 'system',
};

/**
 * 审批判定来源 → 操作留痕 actor。
 * 历史实现把 allow/deny 一律写成 actor:'user'，导致规则 / 家族 / 分类器 / 完全权限的
 * 自动放行在留痕页全部显示成「用户批准」（谁批的看不出来）。
 */
export function permissionAuditActor(source) {
    const key = String(source == null ? '' : source).trim();
    return PERMISSION_ACTOR_BY_SOURCE[key] || 'ai';
}
