// 权限规则与统一决策链的纯函数层。
// 规则文件：<工作区>/.cadt/permissions.json，结构
//   {version:1, command:{allow:[],ask:[],deny:[]}, write:{...}, web:{...}}
// 设置页用行语法编辑：一行一条 Bash(...) / Write(...) / Web(...)，空行与 # 注释忽略。

export const PERMISSION_VERSION = 1;
export const PERMISSION_KINDS = ['command', 'write', 'web'];
export const PERMISSION_BEHAVIORS = ['deny', 'ask', 'allow'];

const RULE_LIMIT = 300;
const RULE_TEXT_LIMIT = 400;

const KIND_PREFIX = {command: 'Bash', write: 'Write', web: 'Web'};
const PREFIX_KIND = {bash: 'command', write: 'write', web: 'web'};

export function emptyPermissionRules() {
    return {
        command: {allow: [], ask: [], deny: []},
        write: {allow: [], ask: [], deny: []},
        web: {allow: [], ask: [], deny: []},
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
    if (kind === 'write') {
        const path = writeRuleSubject(text).toLowerCase();
        const pattern = writeRuleSubject(value).toLowerCase();
        if (!path || !pattern) return false;
        if (pattern.endsWith('/**')) {
            const base = pattern.slice(0, -3);
            if (path === base) return true;
        }
        return pathGlobRegExp(pattern).test(path);
    }
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
            errors.push('第 ' + (index + 1) + ' 行：需要 Bash(...) / Write(...) / Web(...) 格式');
            return;
        }
        const kind = PREFIX_KIND[match[1].toLowerCase()];
        if (!kind) {
            errors.push('第 ' + (index + 1) + ' 行：未知前缀 ' + match[1] + '（只会 Bash / Write / Web）');
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
    if (scope === 'auto') {
        if (readOnly) return {decision: 'allow', source: 'readonly'};
        if (familyAuto) return {decision: 'allow', source: 'family'};
        if (classifierEnabled) return {decision: 'classify', source: 'classifier'};
    }
    return {decision: 'ask', source: 'scope'};
}
