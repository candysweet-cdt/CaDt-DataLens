// 工具调用参数规范化：保证发给 API 的 arguments 一定是合法 JSON 对象。
// 模型偶发在参数末尾多写一个 } 或截断，非法文本一旦进入会话历史，
// 之后每一轮请求都会被后端校验拒收，所以存储与发送两端都要过这一层。
import {repairJson} from './jsonrepair.js';

function parseObject(text) {
    if (!text) return null;
    try {
        const value = JSON.parse(text);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch (e) {
        return null;
    }
}

// 字符串感知的括号平衡扫描：取文本里第一个完整的 JSON 对象。
export function firstJsonObject(text) {
    const s = String(text || '');
    const start = s.indexOf('{');
    if (start < 0) return '';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') {
            inStr = true;
            continue;
        }
        if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) return s.slice(start, i + 1);
        }
    }
    return '';
}

function stripFence(text) {
    const m = String(text || '').trim().match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/);
    return m ? m[1].trim() : '';
}

export function inspectToolArguments(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return {text: '{}', valid: false, repaired: false};
    if (parseObject(text)) return {text, valid: true, repaired: false};
    const candidates = [];
    const fence = stripFence(text);
    if (fence) {
        if (parseObject(fence)) return {text: fence, valid: false, repaired: true};
        candidates.push(fence);
    }
    const repaired = repairJson(text);
    if (repaired && repaired.ok && repaired.text) candidates.push(repaired.text);
    const first = firstJsonObject(fence || text);
    if (first) {
        if (parseObject(first)) return {text: first, valid: false, repaired: true};
        candidates.push(first);
        const repairedFirst = repairJson(first);
        if (repairedFirst && repairedFirst.ok && repairedFirst.text) candidates.push(repairedFirst.text);
    }
    for (const candidate of candidates) {
        if (parseObject(candidate)) return {text: candidate, valid: false, repaired: true};
    }
    return {text: '{}', valid: false, repaired: false};
}

export function safeToolArguments(raw) {
    return inspectToolArguments(raw).text;
}
