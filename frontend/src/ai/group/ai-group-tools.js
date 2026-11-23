// ai-group-tools.js：群成员只读文件工具（G5 遗留项落地，2026-11-19）。
// 成员发言请求带上 read_file / list_dir / search_text / glob 四个只读工具，
// 执行回路在 ai-group-runtime（ai-done finishReason='tool' → 执行 → 同 roundId 续发）；
// 实际执行体在 ai-panel 的 execMemberTool（复用面板的读取/搜索/格式化闭包），
// 路径边界一律 resolveWithinRoot（群所属工作区，越界即拒）。
// 本模块只放纯函数：工具清单过滤、API 消息形状、参数摘要、系统提示词片段。可单测。
import {AI_TOOL_DEFS} from '../tools/ai-tool-defs.js';
import {parseJson} from '../../core/json-safe.js';

// 成员可用的只读工具名（不含写工具 / 命令 / 联网——群成员的权限面固定为此清单）
export const MEMBER_TOOL_NAMES = ['read_file', 'list_dir', 'search_text', 'glob'];
// 单次发言的工具调用轮上限（每轮可并行多个调用）；到顶后追加「请直接发言」的收敛提示
export const MEMBER_TOOL_ROUNDS_MAX = 4;
// 工具步骤进私有日志的 gid 前缀：与最终发言的 turnId（roundId）对齐，成员详情可按发言分组
export const MEMBER_TOOL_GID_PREFIX = 'tools:';

// 只读工具的定义（AI_TOOL_DEFS 是按名索引的定义表；按 MEMBER_TOOL_NAMES 顺序取，
// 给 AISendChat 的 tools 参数用，形状与面板一致——「原样发 API，勿就地改」）
export function memberToolDefs() {
    const out = [];
    for (const name of MEMBER_TOOL_NAMES) {
        const def = AI_TOOL_DEFS[name];
        if (def) out.push(def);
    }
    return out;
}

// 工具轮的 assistant 消息（API 形状，与面板 buildApiMessages 输出同契约：
// camelCase toolCalls，Go 传输层负责转 OpenAI/Anthropic 线格式）
export function assistantToolCallsApiMessage(content, calls) {
    return {
        role: 'assistant',
        content: String(content || ''),
        toolCalls: (Array.isArray(calls) ? calls : []).map((call) => ({
            id: String(call.id || ''),
            name: String(call.name || ''),
            arguments: String(call.arguments || '{}'),
        })),
    };
}

// 工具结果消息（API 形状）；必须与上一条 assistant 的 toolCalls 一一配对，
// 否则 OpenAI/Anthropic 会以「insufficient tool messages」拒收整轮请求
export function toolResultApiMessage(call, content) {
    return {
        role: 'tool',
        toolCallId: String((call && call.id) || ''),
        name: String((call && call.name) || ''),
        content: String(content == null ? '' : content),
    };
}

// 参数摘要（私有日志 / 成员详情用）：一眼看出调了什么、读了哪个文件
export function toolArgsSummary(name, argsJson) {
    let args = {};
    try {
        args = typeof argsJson === 'string' ? (parseJson(argsJson, {}) || {}) : (argsJson || {});
    } catch (e) {
        args = {};
    }
    const pick = (...keys) => {
        for (const key of keys) {
            const value = args[key];
            if (value != null && String(value).trim()) return String(value).trim();
        }
        return '';
    };
    let detail = '';
    if (name === 'read_file') detail = pick('path');
    else if (name === 'list_dir') detail = pick('path') || '.';
    else if (name === 'search_text') detail = '"' + pick('query') + '"' + (pick('path') ? ' @ ' + pick('path') : '');
    else if (name === 'glob') detail = pick('pattern') + (pick('path') ? ' @ ' + pick('path') : '');
    else detail = pick('path', 'query', 'pattern', 'url');
    const suffix = name === 'read_file' ? pick('startLine', 'offset') : '';
    return (detail ? detail : '(无参数)') + (suffix ? `（自 ${suffix}）` : '');
}

// 成员系统提示词的工具说明段（作为第二条 system 注入，面板同款多 system 契约）
export function memberToolsNote() {
    return [
        '<member_tools>',
        '你可以使用只读工具查看工作区文件（路径相对工作区根；写文件 / 执行命令不在你的权限内）：',
        '- read_file {path, offset?, limit?, startLine?, endLine?}：读文件内容',
        '- list_dir {path?, depth?}：列目录（depth>1 递归）',
        '- search_text {query, path?, caseSensitive?, ...}：全文搜索',
        '- glob {pattern, path?}：按通配符找文件（如 第00*.md、src/**/*.ts）',
        '议题引用到正文 / 章节 / 代码 / 数据时，先用工具读到实际内容再发言——不要凭猜测评价没读过的材料；',
        '引用时注明文件名。工具调用轮次有上限（' + MEMBER_TOOL_ROUNDS_MAX + ' 轮），读关键文件即可，不要漫游。',
        '</member_tools>',
    ].join('\n');
}
