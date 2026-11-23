// 工具调用参数规范化：保证发给 API 的 arguments 一定是合法 JSON 对象。
// 模型偶发在参数末尾多写一个 } 或截断，非法文本一旦进入会话历史，
// 之后每一轮请求都会被后端校验拒收，所以存储与发送两端都要过这一层。
import {repairJson} from '../../core/jsonrepair.js';
import {parseJson} from '../../core/json-safe.js';
import {WIDGET_LANGS} from '../../core/visual-spec.js';

// 识别「可视化围栏语言被误发成工具名」：模型偶尔把 ```svg / ```mermaid / ```graph
// 等正文围栏标记当成 function_call 的名字发出去（截图里还见过 svg</arg_value:xxx> 这种
// 序列化噪声混进名字）。返回命中的规范围栏语言，否则返回 null。
// 只在工具白名单拒绝的分支调用，即使误判也只是换一条提示文案，不影响任何执行。
export function detectFenceToolMisuse(name) {
    const raw = String(name == null ? '' : name).trim();
    if (!raw) return null;
    // 取开头的语言标记，忽略后面混入的序列化噪声（如 </arg_value:…>）。
    const m = raw.match(/^[A-Za-z][A-Za-z0-9]*/);
    if (!m) return null;
    const token = m[0].toLowerCase();
    return WIDGET_LANGS.has(token) ? token : null;
}

// 围栏误用的针对性纠错文案：明确告诉模型可视化走正文围栏、不是工具调用。
export function fenceToolMisuseMessage(lang) {
    return '「' + lang + '」是正文代码围栏的语言标记，不是可调用工具。' +
        '可视化内容请直接写在回复正文的 ```' + lang + ' 围栏代码块里，应用会把它渲染成卡片；' +
        '不要作为工具调用发出。';
}

function parseObject(text) {
    if (!text) return null;
    const value = parseJson(text, null);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
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
