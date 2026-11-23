// ai-classifier-verdict.js：自动审批「AI 分类器」（远程大模型）输出的容错解析。
// 背景：模型经常不老实——带一段解释、套 ```json 代码块、把结论写进推理、甚至只回一个词。
// 原来的实现在整段输出里抓**第一个** {..} 再 JSON.parse，正文为空或格式漂移时必然失败，
// 于是复核环节长期 fail-closed 转人工（表现为审批卡「分类器输出无法解析」）。
// 这里改为：括号配对扫描取全部顶层对象 → 从后往前逐个尝试 → 短答复纯文本兜底。
// 安全边界：只有明确的 allow 才放行，任何异常 / 歧义一律转人工（fail-closed）。
// 纯函数、无 DOM 依赖，测试见 ai-classifier-verdict.test.mjs。
import {aiTextOf} from '../core/ai-constants.js';

const MAX_CANDIDATES = 12;
const SNIPPET_LIMIT = 60;
const PLAIN_ALLOW_LIMIT = 40;
const REASON_LIMIT = 80;

// 扫描平衡花括号，返回全部顶层 {...} 片段（容忍字符串内的花括号与反斜杠转义）。
export function jsonCandidates(text) {
    const src = String(text == null ? '' : text);
    const out = [];
    for (let i = 0; i < src.length; i += 1) {
        if (src[i] !== '{') continue;
        let depth = 0;
        let quote = '';
        let end = -1;
        for (let j = i; j < src.length; j += 1) {
            const ch = src[j];
            if (quote) {
                if (ch === '\\') {
                    j += 1;
                    continue;
                }
                if (ch === quote) quote = '';
                continue;
            }
            if (ch === '"' || ch === "'") {
                quote = ch;
                continue;
            }
            if (ch === '{') depth += 1;
            else if (ch === '}') {
                depth -= 1;
                if (depth === 0) {
                    end = j;
                    break;
                }
            }
        }
        if (end <= i) continue;
        out.push(src.slice(i, end + 1));
        i = end;
        if (out.length >= MAX_CANDIDATES * 2) break;
    }
    return out;
}

// 诊断用片段：去掉换行与多余空白，截短进 reason（让审批卡能显示模型到底吐了什么）。
export function classifierVerdictSnippet(text) {
    const flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!flat) return '';
    return flat.length > SNIPPET_LIMIT ? flat.slice(0, SNIPPET_LIMIT) + '…' : flat;
}

function verdictFromData(data) {
    if (!data || typeof data !== 'object') return null;
    const decision = aiTextOf(data.decision ?? data.verdict ?? data.result).trim().toLowerCase();
    const reason = aiTextOf(data.reason ?? data.note ?? data.explanation)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, REASON_LIMIT);
    if (!decision) return null;
    if (decision === 'allow' || decision === 'approve' || decision === 'allowed') return {allow: true, reason};
    return {allow: false, reason: reason || '分类器建议人工确认'};
}

function plainVerdict(text) {
    const plain = text.replace(/[`*_#>]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!plain || plain.length > PLAIN_ALLOW_LIMIT) return null;
    if (/\b(ask|deny|reject|manual|unsafe)\b/i.test(plain) || /不许|不允许|转人工|拒绝/.test(plain)) {
        return {allow: false, reason: plain.slice(0, REASON_LIMIT)};
    }
    if (/^(?:decision\s*[:=]\s*)?(allow|approve|allowed)\b/i.test(plain) && !/\bnot\b|\bdon'?t\b|n't\b/i.test(plain)) {
        return {allow: true, reason: plain.slice(0, REASON_LIMIT)};
    }
    return null;
}

/**
 * 解析分类器输出 → {allow, reason}。空输出 / 无法解析 / 歧义一律 allow:false。
 */
export function parseClassifierVerdict(buffer) {
    const raw = String(buffer == null ? '' : buffer);
    const text = raw.trim();
    if (!text) return {allow: false, reason: '分类器输出为空'};
    const candidates = jsonCandidates(text);
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
        let data = null;
        try {
            data = JSON.parse(candidates[i]);
        } catch (e) {
            continue;
        }
        const verdict = verdictFromData(data);
        if (verdict) return verdict;
    }
    const plain = plainVerdict(text);
    if (plain) return plain;
    return {allow: false, reason: '分类器输出无法解析：' + classifierVerdictSnippet(text)};
}
