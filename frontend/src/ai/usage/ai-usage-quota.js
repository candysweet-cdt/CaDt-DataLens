// ai-usage-quota.js：账号额度查询管线——模板/脚本拼装请求规格 → Go 哑通道
//（AIUsageHTTPRequest 转发 aigen.HTTPRequest）发同步 HTTP → Worker 沙箱执行
// extractor → 归一化 → 内存 + localStorage 缓存。「官方」模板不走脚本，直接用
// AIUsageQuery 白名单引擎。展示在 ai-model-settings / ai-panel 弹层，配置在
// ai-usage-config-dialog。extractor 沙箱：Worker 全局没有 window.go / DOM，
// prelude 再禁掉网络与派生原语，超时 terminate——导入的配置按不可信输入对待。
import {
    USAGE_CODE_MAX_LENGTH,
    USAGE_TIMEOUT_MAX_SEC,
    USAGE_TIMEOUT_MIN_SEC,
    normalizeUsageConfig,
} from '../core/ai-config-model.js';
import {
    OFFICIAL_USAGE_HOSTS,
    renderUsageVars,
    usageTemplatePresetCode,
} from './ai-usage-templates.js';
import {parseJson} from '../../core/json-safe.js';

// 沙箱单阶段（解析脚本 / 跑 extractor）的硬超时；查询整体另有 HTTP 超时兜底。
const USAGE_WORKER_TIMEOUT_MS = 5000;
// 脚本响应体上限：余额响应远小于生图，256KB 足够。
const USAGE_RESPONSE_MAX_BYTES = 262144;
const USAGE_SNAPSHOT_ITEMS_MAX = 24;
// localStorage 快照键：只存展示数据（items/error/at），绝不存 override apiKey。
// v2：条目结构升级（结构化 resetAt + 百分比优先 used），旧版快照直接作废重查
const USAGE_SNAPSHOT_STORAGE_KEY = 'cadt.ai-usage-cache.v2';

// resetAt 归一：number 按 <1e12 视为秒、否则毫秒；字符串先试数字再按 ISO 解析。
// 无效 / 非正数返回 0（调用方据此不显示倒计时）。
export function normalizeResetAt(raw) {
    if (typeof raw === 'number') {
        if (!Number.isFinite(raw) || raw <= 0) return 0;
        return raw < 1e12 ? raw * 1000 : raw;
    }
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return 0;
    const numeric = Number(text);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

// ── 纯函数（可单测）──────────────────────────────────────────

// 结果条目形状：{planName?, isValid, invalidMessage?, remaining?/total?/used?,
// unit?, extra?, label?/value?（官方引擎条目）}。snapshot：{state:'ok'|'error',
// items, error, at}。
export function normalizeUsageResult(raw) {
    const list = Array.isArray(raw) ? raw : (raw === undefined || raw === null ? [] : [raw]);
    if (!list.length) return {items: [], error: 'extractor 没有返回结果'};
    if (list.length > USAGE_SNAPSHOT_ITEMS_MAX) list.length = USAGE_SNAPSHOT_ITEMS_MAX;
    const items = [];
    for (const entry of list) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return {items: [], error: 'extractor 返回的每个套餐必须是对象'};
        }
        // 字符串字段限长：恶意/异常 extractor 的超长串不进 localStorage 快照
        const str = (value) => (typeof value === 'string' ? value.slice(0, 200) : '');
        const item = {
            planName: str(entry.planName),
            poolName: str(entry.poolName),
            isValid: entry.isValid !== false,
            invalidMessage: str(entry.invalidMessage),
            unit: str(entry.unit),
            extra: str(entry.extra),
        };
        // resetAt：epoc 秒 / 毫秒 / ISO 字符串统一成毫秒时间戳，显示层按倒计时渲染
        if (entry.resetAt != null && entry.resetAt !== '') {
            const resetMs = normalizeResetAt(entry.resetAt);
            if (resetMs > 0) item.resetAt = resetMs;
        }
        // 返赠余额（SenseNova 这类）：外显时并入总额，详情层仍看 extra 文案
        const grant = Number(entry.grantBalance);
        if (Number.isFinite(grant) && grant > 0) item.grantBalance = grant;
        let hasNumber = false;
        for (const key of ['remaining', 'total', 'used']) {
            const value = Number(entry[key]);
            if (Number.isFinite(value)) {
                item[key] = value;
                hasNumber = true;
            }
        }
        if (item.isValid && !hasNumber) {
            return {items: [], error: 'extractor 返回缺少 remaining/total/used 数值字段'};
        }
        items.push(item);
    }
    return {items, error: ''};
}

// 官方白名单引擎（AIUsageResult）→ snapshot。Supported=false 给出选模板的引导文案。
export function officialSnapshotFromResult(result) {
    if (!result || typeof result !== 'object') {
        return {state: 'error', items: [], error: '查询无结果', at: Date.now()};
    }
    if (result.error) {
        return {state: 'error', items: [], error: String(result.error), at: Date.now()};
    }
    if (!result.supported) {
        return {
            state: 'error',
            items: [],
            error: '该服务商不在官方查询白名单（已内置 DeepSeek / OpenRouter / SiliconFlow）；其他服务商请选脚本模板',
            at: Date.now(),
        };
    }
    const items = (Array.isArray(result.items) ? result.items : []).map((item) => ({
        label: String((item && item.label) || ''),
        value: String((item && item.value) || ''),
        isValid: true,
        planName: '',
        invalidMessage: '',
        unit: '',
        extra: '',
    }));
    if (!items.length) {
        return {state: 'error', items: [], error: '响应中没有可展示的余额条目', at: Date.now()};
    }
    return {state: 'ok', items, at: Date.now()};
}

function usageErrorSnippet(body) {
    const text = String(body || '').trim();
    if (!text) return '';
    return text.length > 200 ? text.slice(0, 200) + '…' : text;
}

// 沙箱脚本（prelude + 消息处理）。网络原语必须从**实例与原型链两层摘除**：
// WebIDL 把 fetch/XHR 等定义在 DedicatedWorkerGlobalScope.prototype 上，只写
// `self[name] = undefined` 是在 globalThis 建 own property 遮蔽，恶意脚本经
// `Object.getPrototypeOf(self).fetch` 能拿回原生函数（2026-11-19 审查在 Chromium
// 实测复现）。原型属性是 configurable 的，delete 生效；被摘引用不保留，用户代码
// 无法还原。prelude 先于消息处理运行，用户代码拿不到未摘除的窗口期。
// 返回值是字符串方便测试断言禁用表；实际由 Blob URL 加载。
export function buildUsageWorkerScript() {
    return [
        "'use strict';",
        "const _deny = (name) => {",
        "  try { delete self[name]; } catch (_) {}",
        "  try { self[name] = undefined; } catch (_) {}",
        "  const proto = Object.getPrototypeOf(self);",
        "  try { delete proto[name]; } catch (_) {}",
        "};",
        "['fetch','XMLHttpRequest','WebSocket','EventSource','importScripts','Worker',",
        " 'SharedWorker','indexedDB','open','caches','sendBeacon'].forEach(_deny);",
        "try {",
        "  navigator.sendBeacon = undefined;",
        "  delete Object.getPrototypeOf(navigator).sendBeacon;",
        "} catch (_) {}",
        'let _cfg = null;',
        'self.onmessage = (event) => {',
        '  const data = event.data || {};',
        '  try {',
        "    if (data.type === 'run') {",
        "      _cfg = new Function('return (' + data.code + ')')();",
        "      if (!_cfg || typeof _cfg !== 'object' || Array.isArray(_cfg)) throw new Error('脚本顶层必须是对象字面量');",
        '      const req = _cfg.request;',
        "      if (!req || typeof req !== 'object') throw new Error('缺少 request 配置');",
        "      if (typeof req.url !== 'string' || !req.url.trim()) throw new Error('缺少 request.url');",
        "      const url = req.url.trim().toLowerCase();",
        "      if (!url.startsWith('http://') && !url.startsWith('https://')) throw new Error('request.url 必须以 http(s):// 开头');",
        '      const headers = {};',
        '      if (req.headers != null && typeof req.headers === \'object\') {',
        '        for (const [name, value] of Object.entries(req.headers)) {',
        "          if (typeof value !== 'string' && typeof value !== 'number') throw new Error('request.headers 的值必须是字符串');",
        '          headers[String(name)] = String(value);',
        '        }',
        '      }',
        '      let body = \'\';',
        '      if (req.body != null) body = typeof req.body === \'string\' ? req.body : JSON.stringify(req.body);',
        "      const method = typeof req.method === 'string' && req.method.trim() ? req.method.trim().toUpperCase() : 'GET';",
        "      self.postMessage({ type: 'request', request: { url: req.url.trim(), method, headers, body } });",
        "    } else if (data.type === 'response') {",
        "      if (!_cfg || typeof _cfg.extractor !== 'function') throw new Error('缺少 extractor 函数');",
        '      const resp = data.response || {};',
        '      let parsed = resp.body;',
        '      try { parsed = JSON.parse(resp.body); } catch (_) { /* 非 JSON 响应原样传字符串 */ }',
        '      const raw = _cfg.extractor(parsed);',
        '      let safe;',
        '      try { safe = JSON.parse(JSON.stringify(raw)); } catch (_) { throw new Error(\'extractor 返回值无法序列化（含函数或循环引用）\'); }',
        "      self.postMessage({ type: 'result', raw: safe });",
        '    }',
        "  } catch (err) { self.postMessage({ type: 'error', error: String((err && err.message) || err) }); }",
        '};',
    ].join('\n');
}

// 脚本 → 请求规格（发给 Go 哑通道的字段名与 aigen.HTTPSpec 对齐）。
export function buildUsageSpec(request, profile, usage) {
    const timeoutSec = Math.min(Math.max(Number(usage.timeoutSec) || 10, USAGE_TIMEOUT_MIN_SEC), USAGE_TIMEOUT_MAX_SEC);
    return {
        url: String(request.url || ''),
        method: String(request.method || 'GET'),
        headers: request.headers && typeof request.headers === 'object' ? request.headers : {},
        body: String(request.body || ''),
        proxy: String((profile && profile.proxy) || ''),
        timeoutSec,
        maxBytes: USAGE_RESPONSE_MAX_BYTES,
    };
}

// 查询节流：有缓存且未到 autoIntervalMin 视为新鲜（0 = 不自动查，只在手动时刷）。
export function usageStale(snapshot, intervalMin, now = Date.now()) {
    const interval = Number(intervalMin) || 0;
    if (interval <= 0) return !snapshot || !snapshot.at;
    if (!snapshot || !snapshot.at) return true;
    return (now - snapshot.at) >= interval * 60000;
}

export function formatUsageAmount(value, unit) {
    if (value === -1) return '∞';
    const text = Number(value).toFixed(2);
    return unit === '%' ? text + '%' : (text + (unit ? ' ' + unit : ''));
}

// cc-switch 口径：颜色一律按**剩余**算（不是已用），只给数值上色。
// 剩余 >20% 绿(normal)、≤20% 橙(warning)、≤0 红(danger)；没有比例（余额）不上色。
// 对齐 cc-switch quotaRules.ts 的 WARN_BELOW_PERCENT=20 / toneForLeft。
export const USAGE_WARN_BELOW_PERCENT = 20;
export function usageTone(item) {
    if (!item || item.isValid === false) return 'danger';
    if (Number.isFinite(item.total) && item.total > 0 && Number.isFinite(item.remaining)) {
        const left = Math.max(0, (item.remaining / item.total) * 100);
        if (left <= 0) return 'danger';
        if (left < USAGE_WARN_BELOW_PERCENT) return 'warning';
        return 'normal';
    }
    // 有已用百分比（unit=%）但没 total：按 100-used 当剩余
    if (item.unit === '%' && Number.isFinite(item.used)) {
        const left = 100 - item.used;
        if (left <= 0) return 'danger';
        if (left < USAGE_WARN_BELOW_PERCENT) return 'warning';
        return 'normal';
    }
    return 'normal';
}

// 单条目的展示文案（余额行主句 + 弹层行共用）。
// 百分比条目（unit === '%'）一律显示「已用 X%」——remaining 是原始额度数（token 数），
// 不能套 % 单位（2026-11-19 修复「112911.76%」）。
export function usageItemText(item) {
    if (!item) return '';
    if (item.isValid === false) return item.invalidMessage || '已失效';
    if (item.label && item.value) return item.label + ' ' + item.value;
    const unit = item.unit || '';
    if (unit === '%' && Number.isFinite(item.used)) {
        return (item.planName ? item.planName + ' ' : '') + '已用 ' + formatUsageAmount(item.used, unit);
    }
    // unit=% 时 remaining 实际是 token 数（SenseNova 这类），不能拼成 660000.00%
    if (Number.isFinite(item.remaining)) return '余额 ' + formatUsageAmount(item.remaining, unit === '%' ? '' : unit);
    if (Number.isFinite(item.used)) return (item.planName ? item.planName + ' ' : '') + '已用 ' + formatUsageAmount(item.used, unit);
    if (Number.isFinite(item.total)) return (item.planName ? item.planName + ' ' : '') + '总额 ' + formatUsageAmount(item.total, unit);
    return item.planName || '';
}

// 重置倒计时：只剩两个单位（27d2h / 1h55m / 55m），对齐 cc-switch countdownStr。
// 到期或没有 resetAt 返回 ''。
export function formatUsageCountdown(resetAt, now = Date.now()) {
    const ms = normalizeResetAt(resetAt);
    if (!ms) return '';
    const diff = ms - now;
    if (diff <= 0) return '';
    const totalMinutes = Math.floor(diff / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return days + 'd' + hours + 'h';
    if (hours > 0) return hours + 'h' + minutes + 'm';
    return minutes + 'm';
}

// 余额行结构化文案：segments 数组，每段 {label 灰字前缀, value 上色值, tone}。
// 对齐 cc-switch：档名/「余额」等文案灰、只有数字上色；多套餐**完整列出**每段
//（不聚合「N 个套餐」）；官方条目过滤零信息量的「账户可用」。
export function usageHeadlineParts(snapshot, now = Date.now()) {
    if (!snapshot) return {segments: [{label: '', value: '待查询', tone: 'muted'}]};
    if (snapshot.state === 'error') return {segments: [{label: '', value: snapshot.error || '查询失败', tone: 'danger'}]};
    const items = (Array.isArray(snapshot.items) ? snapshot.items : []).filter((item) => item);
    if (!items.length) return {segments: []};

    const segments = [];
    for (const item of items) {
        if (item.isValid === false) {
            segments.push({label: item.planName ? item.planName + ' · ' : '', value: item.invalidMessage || '已失效', tone: 'danger'});
            continue;
        }
        // 官方引擎条目：label/value 是明细行；「账户可用」零信息量，有别的行时跳过
        if (item.label && item.value) {
            if (item.label === '账户可用' && items.length > 1) continue;
            segments.push({label: item.label + ' ', value: item.value, tone: 'normal'});
            continue;
        }
        const unit = item.unit || '';
        const prefix = item.planName ? item.planName + ' ' : '';
        let value;
        if (unit === '%' && Number.isFinite(item.used)) value = '已用 ' + formatUsageAmount(item.used, unit);
        else if (Number.isFinite(item.remaining)) value = formatUsageAmount(item.remaining, unit === '%' ? '' : unit);
        else if (Number.isFinite(item.used)) value = '已用 ' + formatUsageAmount(item.used, unit);
        else if (Number.isFinite(item.total)) value = '总额 ' + formatUsageAmount(item.total, unit);
        else value = '';
        if (!value) continue;
        segments.push({label: prefix, value, tone: usageTone(item)});
    }
    if (!segments.length) {
        const only = items.find((item) => item.label && item.value);
        if (only) segments.push({label: only.label + ' ', value: only.value, tone: 'normal'});
    }
    return {segments};
}

// ── 显示规范 v1（2026-11-20 定稿，全文见 docs/finished-plans/ai-quota-display.md §11）──
// 账号卡外显与选择器分组头的唯一口径：币种只留符号（¥48.47，不写 CNY/USD）；
// 窗口短名 5 小时→5h / 每周→7d / 每月→30d；百分比最多 1 位小数；倒计时 ⏱ + 两单位；
// 段间「 · 」；只有数值上色，按剩余比例 ≤0 红 / <20% 橙 / 其余绿，币种数值不上色。

// 窗口短名：匹配不上时去空格原样保留。
export function shortWindowName(name) {
    const text = String(name || '').trim();
    if (!text) return '';
    if (/^5\s*小时$/.test(text)) return '5h';
    if (/^(每周|7\s*天|本周)$/.test(text)) return '7d';
    if (/^(每月|30\s*天|月)$/.test(text)) return '30d';
    return text.replace(/\s+/g, '');
}

// 货币单位 → 符号；其余（'%' / 'tokens' / 空）返回 ''。
export function currencySymbolOf(unit) {
    const text = String(unit || '').trim().toLowerCase();
    if (text === 'cny' || text === 'rmb' || text === '元' || text === '人民币') return '¥';
    if (text === 'usd' || text === '美元') return '$';
    return '';
}

// 百分比紧凑文案：clamp 0–100，最多 1 位小数，整数不带小数（0.00% → 0%）。
export function formatPercentCompact(pct) {
    const value = Math.min(100, Math.max(0, Number(pct) || 0));
    const rounded = Math.round(value * 10) / 10;
    return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + '%';
}

function toneForLeft(leftPct) {
    if (leftPct <= 0) return 'danger';
    if (leftPct < USAGE_WARN_BELOW_PERCENT) return 'warning';
    return 'normal';
}

// planName「通用池 · 5 小时」→ {pool:'通用池', window:'5h'}；无「·」时池名取 poolName。
function poolAndWindow(item) {
    const planText = String(item.planName || '').trim();
    const sep = planText.indexOf('·');
    if (sep >= 0) {
        return {
            pool: String(item.poolName || '').trim() || planText.slice(0, sep).trim(),
            window: shortWindowName(planText.slice(sep + 1)),
        };
    }
    return {pool: String(item.poolName || '').trim(), window: shortWindowName(planText)};
}

const CURRENCY_PAREN_RE = /[（(]\s*(cny|rmb|usd|美元|人民币|元)\s*[）)]/i;

// 官方条目的币种与数值：label「总额余额（CNY）」+ value「49.05」→ ¥49.05；
// value 自带 ¥/$ 前缀时直接沿用（SiliconFlow「总余额 ¥4.7」），不重复加符号。
function currencyOfOfficialItem(item) {
    const label = String(item.label || '');
    const value = String(item.value || '').trim();
    let symbol = '';
    const paren = CURRENCY_PAREN_RE.exec(label);
    if (paren) symbol = currencySymbolOf(paren[1]);
    let amount = value;
    const lead = /^[¥$]\s*/.exec(amount);
    if (lead) {
        symbol = symbol || lead[0].trim();
        amount = amount.slice(lead[0].length);
    }
    return {symbol, amount};
}

// 主余额条目：总额 → 总余额 → 剩余 → 余额 → 首行（OpenRouter 只有「剩余」，落第三档）。
function primaryOfficialItem(items) {
    const byKeyword = (keyword) => items.find((item) => String(item.label).includes(keyword));
    return byKeyword('总额') || byKeyword('总余额') || byKeyword('剩余') || byKeyword('余额') || items[0];
}

function invalidPart(item) {
    const {pool, window} = poolAndWindow(item);
    return {
        label: (pool + window) || String(item.label || item.planName || ''),
        value: item.invalidMessage || '已失效',
        tone: 'danger',
        countdown: '',
    };
}

// 紧凑段（账号卡行与 tooltip 共用）：{prefix, parts:[{label, value, tone, countdown}]}。
// 形态判定：官方 label/value 或货币 remaining → 币种型（只显示总额）；remaining+total
//（非货币单位，SenseNova 积分这类）→ 剩余型（换算百分比）；unit=% 只剩 used → 已用型。
// extra（"已用 $X / $Y"、"返赠 N"）与绝对值不上外显行，留给详情弹层。
// now 可注入（倒计时按分钟向下取整，测试要钉住与时钟同一瞬点，否则跨 1ms 就掉进上一分钟）。
function usageCompactParts(snapshot, now = Date.now()) {
    if (!snapshot) return null;
    if (snapshot.state === 'error') {
        return {prefix: '', parts: [{label: '', value: snapshot.error || '查询失败', tone: 'danger', countdown: ''}]};
    }
    const items = (Array.isArray(snapshot.items) ? snapshot.items : []).filter((item) => item);
    if (!items.length) return null;
    const valid = items.filter((item) => item.isValid !== false);
    if (!valid.length) return {prefix: '', parts: items.map(invalidPart)};
    const invalidParts = () => items.filter((item) => item.isValid === false).map(invalidPart);

    // ① 币种型（官方引擎 label/value）：只显示总额，赠送/充值/可用留详情层
    const official = valid.filter((item) => item.label && item.value && item.label !== '账户可用' && item.label !== '账户');
    if (official.length) {
        const primary = primaryOfficialItem(official);
        const {symbol, amount} = currencyOfOfficialItem(primary);
        const value = symbol
            ? symbol + amount
            : String(primary.label).replace(CURRENCY_PAREN_RE, '').trim() + ' ' + amount;
        return {prefix: '', parts: [{label: '', value, tone: '', countdown: ''}, ...invalidParts()]};
    }

    // ② 币种 remaining（NewAPI 这类）：同货币求和，符号前缀
    const currencyParts = [];
    const seenSymbols = new Set();
    for (const item of valid) {
        if (!Number.isFinite(item.remaining)) continue;
        const symbol = currencySymbolOf(item.unit);
        if (!symbol || seenSymbols.has(symbol)) continue;
        seenSymbols.add(symbol);
        let sum = 0;
        for (const row of valid) {
            if (currencySymbolOf(row.unit) === symbol) sum += Number(row.remaining) || 0;
        }
        currencyParts.push({label: '', value: symbol + sum.toFixed(2), tone: '', countdown: ''});
    }
    if (currencyParts.length) return {prefix: '', parts: [...currencyParts, ...invalidParts()]};

    // ③ 剩余型：remaining/total 换算成剩余百分比，池名直接拼在窗口短名前
    const remainingItems = valid.filter((item) =>
        Number.isFinite(item.remaining) && Number.isFinite(item.total) && item.total > 0);
    if (remainingItems.length) {
        const parts = [];
        for (const item of items) {
            if (item.isValid === false) {
                parts.push(invalidPart(item));
                continue;
            }
            if (!remainingItems.includes(item)) continue;
            const {pool, window} = poolAndWindow(item);
            const leftPct = Math.min(100, Math.max(0, (item.remaining / item.total) * 100));
            parts.push({
                label: pool + window,
                value: formatPercentCompact(leftPct),
                tone: toneForLeft(leftPct),
                countdown: formatUsageCountdown(item.resetAt, now),
            });
        }
        return {prefix: '剩余：', parts};
    }

    // ④ 已用型：unit=% 只有 used（cc-switch 系窗口档）
    const usedItems = valid.filter((item) => item.unit === '%' && Number.isFinite(item.used));
    if (usedItems.length) {
        const parts = [];
        for (const item of items) {
            if (item.isValid === false) {
                parts.push(invalidPart(item));
                continue;
            }
            if (!usedItems.includes(item)) continue;
            const {pool, window} = poolAndWindow(item);
            const usedPct = Math.min(100, Math.max(0, item.used));
            parts.push({
                label: pool + window,
                value: formatPercentCompact(usedPct),
                tone: toneForLeft(100 - usedPct),
                countdown: formatUsageCountdown(item.resetAt, now),
            });
        }
        return {prefix: '已用：', parts};
    }

    // ⑤ 兜底：headline 首段原样
    const segments = usageHeadlineParts(snapshot, now).segments || [];
    if (!segments.length) return null;
    return {
        prefix: '',
        parts: segments.map((segment) => ({
            label: '',
            value: String(segment.label || '').trim() + String(segment.value || ''),
            tone: segment.tone || '',
            countdown: '',
        })),
    };
}

// 账号卡外显的紧凑行（显示规范 v1）；null = 无数据（调用方显示「待查询」）。
export function usageCompactLine(snapshot, now = Date.now()) {
    return usageCompactParts(snapshot, now);
}

// 纯文本版（tooltip / 单行场景）：倒计时作「（3h15m 后重置）」后缀。
export function formatUsageCompactText(snapshot, now = Date.now()) {
    const compact = usageCompactParts(snapshot, now);
    if (!compact) return '';
    const body = compact.parts.map((part) => {
        const head = part.label ? part.label + ': ' : '';
        const tail = part.countdown ? '（' + part.countdown + ' 后重置）' : '';
        return head + part.value + tail;
    }).join(' · ');
    return compact.prefix + body;
}

// 选择器分组头的单值摘要：取「最紧」的约束——
// 已用型取已用最高窗口（5h 70%）；剩余型取剩余最低段（通用池5h 1.8%）；币种型取总额。
export function usageTightSummary(snapshot) {
    const compact = usageCompactParts(snapshot);
    if (!compact || !compact.parts.length) return null;
    if (compact.prefix) {
        const numeric = compact.parts
            .map((part) => ({part, pct: parseFloat(part.value)}))
            .filter((row) => Number.isFinite(row.pct));
        if (!numeric.length) return null;
        const pick = compact.prefix === '已用：'
            ? numeric.reduce((best, row) => (row.pct > best.pct ? row : best))
            : numeric.reduce((best, row) => (row.pct < best.pct ? row : best));
        return {label: pick.part.label ? pick.part.label + ' ' : '', value: pick.part.value, tone: pick.part.tone};
    }
    const first = compact.parts[0];
    return {label: '', value: first.value, tone: first.tone || ''};
}

// 查询时间相对文案（data-tip 里给绝对时间）。
export function formatUsageAge(at, now) {
    if (!at) return '';
    const diff = Math.max(0, (now || Date.now()) - at);
    if (diff < 60000) return '刚刚查询';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前查询';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前查询';
    return Math.floor(diff / 86400000) + ' 天前查询';
}

// ── 快照存储（localStorage 只存展示数据）───────────────────────

function loadSnapshotStore(storage) {
    try {
        const raw = storage.getItem(USAGE_SNAPSHOT_STORAGE_KEY);
        if (!raw) return {};
        const parsed = parseJson(raw, null);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
        return {}; // 损坏即弃：快照只是展示缓存，重新查询即可
    }
}

function saveSnapshotStore(storage, store) {
    try {
        storage.setItem(USAGE_SNAPSHOT_STORAGE_KEY, JSON.stringify(store));
    } catch (_) {
        // 尽力而为：隐私模式 / 配额满时静默放弃持久化，内存缓存仍然生效
    }
}

// ── 查询管线 ─────────────────────────────────────────────────

export function createAIUsageQuota(deps) {
    // deps.backend 是 getter（组合根约定）：求值兼容直接传对象（测试）与传 getter 两种形态
    const backend = () => (typeof deps.backend === 'function' ? deps.backend() : (deps.backend || null));
    // workerFactory：沙箱 Worker 的构造缝（默认真 Worker；node 测试环境没有 Worker，注入假件走同一消息协议）
    const makeWorker = typeof deps.workerFactory === 'function'
        ? deps.workerFactory
        : (url) => new Worker(url);
    const cache = new Map(); // profileId → snapshot（模块级活状态，getter 语义）
    const inflight = new Map(); // profileId → Promise（并发去重）
    let store = null; // localStorage 快照，首次用到时懒加载

    function ensureStore() {
        if (!store) {
            try {
                store = loadSnapshotStore(window.localStorage);
            } catch (_) {
                store = {};
            }
            for (const [id, snapshot] of Object.entries(store)) {
                if (!cache.has(id) && snapshot && typeof snapshot === 'object') cache.set(id, snapshot);
            }
        }
        return store;
    }

    function persist() {
        const target = ensureStore();
        for (const [id, snapshot] of cache.entries()) target[id] = snapshot;
        try {
            saveSnapshotStore(window.localStorage, target);
        } catch (_) {
            // window 不可用（测试环境）时静默放弃
        }
    }

    function peek(profileId) {
        ensureStore();
        return cache.get(profileId) || null;
    }

    function invalidate(profileId) {
        cache.delete(profileId);
        const target = ensureStore();
        delete target[profileId];
        try {
            saveSnapshotStore(window.localStorage, target);
        } catch (_) { /* 同上：尽力而为 */ }
    }

    function errorSnapshot(error) {
        return {state: 'error', items: [], error, at: Date.now()};
    }

    // 「官方」模板的查询入参：连接字段取账号，apiKey/baseUrl 允许覆盖。
    function officialQueryConfig(profile, usage) {
        return {
            baseURL: String(usage.baseUrl || (profile && profile.baseURL) || ''),
            apiKey: String(usage.apiKey || (profile && profile.apiKey) || ''),
            proxy: String((profile && profile.proxy) || ''),
            extraHeaders: (profile && profile.extraHeaders && typeof profile.extraHeaders === 'object')
                ? profile.extraHeaders : {},
        };
    }

    // host 是否在官方白名单（sweep 用来避免对白名单外账号反复自动查询）。
    function officialSupported(profile, usage) {
        const base = String(usage.baseUrl || (profile && profile.baseURL) || '');
        const match = base.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/);
        const hostport = match ? match[1] : base.split('/')[0];
        const at = hostport.lastIndexOf('@');
        let host = at >= 0 ? hostport.slice(at + 1) : hostport;
        const colon = host.lastIndexOf(':');
        if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) host = host.slice(0, colon);
        host = host.toLowerCase();
        return OFFICIAL_USAGE_HOSTS.some((known) => host === known || host.endsWith('.' + known));
    }

    function usageVarsFor(profile, usage) {
        const vars = {
            baseUrl: String(usage.baseUrl || (profile && profile.baseURL) || ''),
            apiKey: String(usage.apiKey || (profile && profile.apiKey) || ''),
        };
        const extra = usage.extraFields && typeof usage.extraFields === 'object' ? usage.extraFields : {};
        for (const [key, value] of Object.entries(extra)) {
            vars[key] = String(value);
        }
        return vars;
    }

    // 沙箱单阶段通信：发消息 → 等对应回包，超时 terminate。
    function workerPhase(worker, message, wantType, phaseLabel) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(phaseLabel + '超时（沙箱已终止）'));
            }, USAGE_WORKER_TIMEOUT_MS);
            const onMessage = (event) => {
                const data = event.data || {};
                if (data.type === 'error') {
                    cleanup();
                    reject(new Error(data.error || '沙箱执行失败'));
                    return;
                }
                if (data.type !== wantType) return;
                cleanup();
                resolve(data);
            };
            const cleanup = () => {
                clearTimeout(timer);
                // 真 Worker 恒有 removeEventListener；测试假件可能只实现 addEventListener
                if (typeof worker.removeEventListener === 'function') {
                    worker.removeEventListener('message', onMessage);
                }
            };
            worker.addEventListener('message', onMessage);
            worker.postMessage(message);
        });
    }

    // 脚本模板查询：Worker 解析脚本 → request 出沙箱 → Go 发请求 → 响应回沙箱跑 extractor。
    async function runScriptQuery(profile, usage) {
        const backendRef = backend();
        const isOAuth = usage.template === 'oauth';
        const sendName = isOAuth ? 'AIOAuthQuotaFetch' : 'AIUsageHTTPRequest';
        if (!backendRef || typeof backendRef[sendName] !== 'function') {
            throw new Error('当前版本不支持' + (isOAuth ? 'OAuth 额度查询' : '脚本额度查询') + '通道');
        }
        const code = String(usage.code || '').trim();
        if (!code) throw new Error('脚本是空的（先选模板或粘贴脚本）');
        if (code.length > USAGE_CODE_MAX_LENGTH) throw new Error('脚本超过 64KB 上限');
        const rendered = renderUsageVars(code, usageVarsFor(profile, usage));
        const blobURL = URL.createObjectURL(new Blob([buildUsageWorkerScript()], {type: 'text/javascript'}));
        let worker = null;
        try {
            // Worker 构造也可能同步抛（极端环境无 Worker 构造器），放进 try 才能保证 blob 释放
            worker = makeWorker(blobURL);
            const {request} = await workerPhase(worker, {type: 'run', code: rendered}, 'request', '脚本解析');
            const result = isOAuth
                ? await backendRef.AIOAuthQuotaFetch(usage.planProvider, String(request.url || ''))
                : await backendRef.AIUsageHTTPRequest(JSON.stringify(buildUsageSpec(request, profile, usage)));
            if (!result || typeof result !== 'object') throw new Error('查询通道无返回');
            if (result.error && !result.status) throw new Error(result.error);
            if (Number(result.status) >= 400) {
                const snippet = usageErrorSnippet(result.body);
                throw new Error('HTTP ' + result.status + (snippet ? '：' + snippet : ''));
            }
            const extracted = await workerPhase(
                worker,
                {type: 'response', response: {status: result.status, body: String(result.body || '')}},
                'result',
                '响应提取',
            );
            return normalizeUsageResult(extracted.raw);
        } finally {
            if (worker) worker.terminate();
            URL.revokeObjectURL(blobURL);
        }
    }

    async function runQuery(profile, usage) {
        if (!profile || !usage.enabled) return errorSnapshot('用量查询未启用');
        try {
            if (usage.template === 'official') {
                const backendRef = backend();
                if (!backendRef || typeof backendRef.AIUsageQuery !== 'function') {
                    return errorSnapshot('当前版本不支持官方用量查询');
                }
                return officialSnapshotFromResult(await backendRef.AIUsageQuery(officialQueryConfig(profile, usage)));
            }
            if (usage.template !== 'custom' && !usageTemplatePresetCode(usage.template, usage.planProvider)) {
                return errorSnapshot('模板预设缺失');
            }
            // 预设模板的脚本运行时取自预设表（修正随版本走，不落盘）；自定义用 code 本体
            const code = usage.template === 'custom'
                ? usage.code
                : usageTemplatePresetCode(usage.template, usage.planProvider);
            const norm = await runScriptQuery(profile, {...usage, code});
            if (norm.error) return errorSnapshot(norm.error);
            return {state: 'ok', items: norm.items, at: Date.now()};
        } catch (err) {
            return errorSnapshot((err && err.message) || String(err));
        }
    }

    // 查询一个账号（结果写缓存，绝不 throw——失败也是 snapshot）。force 绕过节流。
    async function queryAccountUsage(profile, opts = {}) {
        const id = profile && profile.id;
        const usage = normalizeUsageConfig(profile && profile.usage);
        if (!id) return errorSnapshot('账号无效');
        ensureStore();
        if (!opts.force) {
            const cached = cache.get(id);
            if (!usageStale(cached, usage.autoIntervalMin, Date.now())) return cached;
        }
        const pending = inflight.get(id);
        if (pending) return pending;
        const job = runQuery(profile, usage).finally(() => inflight.delete(id));
        inflight.set(id, job);
        const snapshot = await job;
        cache.set(id, snapshot);
        persist();
        return snapshot;
    }

    // 弹窗「测试脚本」：同一条管线但不写缓存。
    async function testConfig(profile, usageDraft) {
        const usage = normalizeUsageConfig(usageDraft);
        return runQuery(profile, usage);
    }

    // 卡片自动刷新：对开启查询且过期的账号并发补查，批完回调一次（触发重渲染）。
    // 白名单外的「官方」模板不打扰（查了也只得到不支持文案）。
    function sweep(profiles, onChange) {
        const now = Date.now();
        const jobs = [];
        for (const profile of profiles || []) {
            const usage = normalizeUsageConfig(profile && profile.usage);
            if (!usage.enabled || inflight.has(profile.id)) continue;
            if (usage.template === 'official' && !officialSupported(profile, usage)) continue;
            if (!usageStale(peek(profile.id), usage.autoIntervalMin, now)) continue;
            jobs.push(queryAccountUsage(profile));
        }
        if (!jobs.length) return;
        Promise.all(jobs).then(() => {
            if (typeof onChange === 'function') onChange();
        });
    }

    return {queryAccountUsage, testConfig, peek, invalidate, sweep};
}
