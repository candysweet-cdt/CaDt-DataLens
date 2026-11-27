// ai-tool-failure-guard.js：工具连续失败熔断（纯逻辑，无 DOM）。
// 背景：主对话没有工具轮硬上限（AI_TOOL_ROUND_LIMIT 只是轻提醒），模型在 edit_file 的
// oldString 不匹配时会反复重试同一处替换，直到用户手动介入才停（2026-11-28 实测）。
// 按「会话 + 工具名 + 目标路径」记失败，只有错误签名与上次相同才累加；达到阈值后
// 直接返回强提示拦截（不再执行、不再 throw），成功或换路径自动清零。
// 与 propose_patch 的 patchAttempts 同源思路，但覆盖所有工具而非只管补丁。

export const TOOL_FAILURE_GUARD_DEFAULTS = Object.freeze({
    maxAttempts: 5,   // 默认阈值（设置缺省时）
    minAttempts: 3,   // 有效最小值（设置项允许 0 = 关闭，非零时至少 3）
    maxAttemptsCap: 20,
});

// 配置值 → 有效阈值。0 / 缺省 / 非法 → 0（关闭熔断）；非零按 [3, 20] 钳制。
// 与 resolveSubAgentRounds 同款口径：null / '' 不当成 0 参与 clamp。
export function resolveToolFailureMax(value) {
    if (value === null || value === undefined || value === '') return TOOL_FAILURE_GUARD_DEFAULTS.maxAttempts;
    const n = Number(value);
    if (!Number.isFinite(n)) return TOOL_FAILURE_GUARD_DEFAULTS.maxAttempts;
    const r = Math.round(n);
    if (r === 0) return 0; // 显式 0 = 关闭熔断
    if (r < 0) return TOOL_FAILURE_GUARD_DEFAULTS.maxAttempts;
    return Math.min(TOOL_FAILURE_GUARD_DEFAULTS.maxAttemptsCap,
        Math.max(TOOL_FAILURE_GUARD_DEFAULTS.minAttempts, r));
}

// 目标标识取常见路径参数；无路径的工具（run_command 等）退化为命令前缀，
// 避免不同命令的失败混进同一个计数桶。
export function toolFailureScope(name, args) {
    const a = args && typeof args === 'object' ? args : {};
    const raw = a.path || a.filePath || a.file || a.url || a.target || a.command || '';
    const target = String(raw == null ? '' : raw).replace(/\\/g, '/').trim().slice(0, 80);
    return target ? name + '|' + target : name;
}

// 内部隔离 key：会话维度避免不同会话操作同一文件时互相误伤。
function stateKey(name, args, sessionId) {
    const prefix = sessionId ? String(sessionId) + '|' : '';
    return prefix + toolFailureScope(name, args);
}

// 错误签名：抹掉数字、路径、文件名、引号内容与多余空白，只留错误类型骨架。
// 目的：模型微调 oldString / 行号后错误文本里的数字会变，但错误类型不变 → 仍算同类失败；
// 而错误类型不同的失败（「未找到」vs「多处命中」）互不累加，避免误伤。
export function normalizeToolError(error) {
    let s = String(error == null ? '' : (error && error.message) || error);
    s = s.replace(/^工具执行失败[:：]\s*/, '');
    s = s.replace(/[A-Za-z]:[\\/][^\s，。；,;）)]+/g, '<path>'); // Windows 绝对路径（正/反斜杠）
    s = s.replace(/(?:^|[\s(（])[\w./\\-]+\.[\w]{1,5}\b/g, '<file>'); // 文件名（含相对路径，兼容反斜杠）
    s = s.replace(/\d+/g, '#'); // 数字：行号、处数、字节数
    s = s.replace(/[「『'"`][^「」『』'"`]*[」』'"`]/g, '<q>'); // 引号内的具体值
    s = s.replace(/\s+/g, ' ').trim().toLowerCase();
    return s.slice(0, 200);
}

export function createToolFailureGuard(options) {
    const source = options && typeof options === 'object' ? options : {};
    // maxAttempts 可以是数字，也可以是 getter（实时读设置，改阈值后无需重建 guard）。
    // 返回 0 表示关闭熔断：shouldBlock 恒不命中，记账也跳过。
    const maxAttemptsSource = source.maxAttempts;
    function threshold() {
        const raw = typeof maxAttemptsSource === 'function' ? maxAttemptsSource() : maxAttemptsSource;
        const n = Number(raw);
        return Number.isFinite(n) ? Math.round(n) : TOOL_FAILURE_GUARD_DEFAULTS.maxAttempts;
    }
    const states = new Map(); // stateKey -> {sig, count}

    // 调用前检查：已达阈值返回上次失败状态（供生成拦截提示），否则 null。
    // 阈值 0（关闭）时不拦截。
    function shouldBlock(name, args, sessionId) {
        const max = threshold();
        if (max <= 0) return null;
        const st = states.get(stateKey(name, args, sessionId));
        return st && st.count >= max ? st : null;
    }

    // 失败后记账：错误签名相同则累加，不同则重置为本次（count=1）。返回当前次数。
    // 阈值 0（关闭）时不记账——否则关掉期间攒的旧账在重新开启后会立刻误熔断。
    function recordFailure(name, args, error, sessionId) {
        if (threshold() <= 0) return 0;
        const key = stateKey(name, args, sessionId);
        const sig = normalizeToolError(error);
        const prev = states.get(key);
        const count = prev && prev.sig === sig ? prev.count + 1 : 1;
        states.set(key, {sig, count});
        return count;
    }

    // 成功即清零：换策略（write_file）或重读后修好都让该路径恢复可用。
    function recordSuccess(name, args, sessionId) {
        states.delete(stateKey(name, args, sessionId));
    }

    function reset() {
        states.clear();
    }

    function stats() {
        return [...states.entries()].map(([key, st]) => ({key, ...st}));
    }

    return {threshold, shouldBlock, recordFailure, recordSuccess, reset, stats};
}

// 熔断强提示全文（AI 面向）：明确禁止重试 + 给出可操作的换策略路径。
// 作为应用消息（role: user）投递——弱模型对「用户明确指令」的服从度高于工具返回文本。
export function toolFailureGiveupText(name, args, state) {
    return [
        '【工具熔断】同一操作（' + toolFailureScope(name, args) + '）已连续失败 ' +
            (state && state.count || 0) + ' 次，且每次都是同一类错误：' +
            (state && state.sig || '未知错误'),
        '这是应用发出的强制指令，优先级高于任何工具输出：禁止再用相同或相近的参数重试这个工具，继续重试不会成功。',
        '请改用以下方式之一：',
        '① 先用 read_file 重读该文件当前内容（文件可能已被其他会话或用户改动，oldString 已失效）；',
        '② 基于重读后的原文重新构造 oldString，或直接用 write_file 整文件写入；',
        '③ 若仍无法完成，向用户说明卡点并停止本轮，不要继续调用工具。',
    ].join('\n');
}

// tool 结果通道的极简文本：只需满足 tool_calls↔tool 结果配对，完整指引走应用消息，
// 避免同一段提示在上下文里出现两次（tool 结果 + user 消息）稀释注意力。
export function toolFailureToolResultText() {
    return '【工具熔断】已停止执行该工具（连续同类失败达上限）；请按随后附带的应用消息指示处理，不要重试。';
}

// 应用消息投递 payload（给 deliverAgentNotice）：urgent 让它在下一个工具轮边界优先折叠进上下文。
export function toolFailureNotice(name, args, state) {
    return {
        kind: 'tool-failure',
        label: '工具熔断 · ' + name,
        content: toolFailureGiveupText(name, args, state),
        urgent: true,
    };
}

// 用户 toast 文案（应用内即时提示）：简短告知熔断发生，AI 将自行换策略。
export function toolFailureToastText(name, args, state) {
    return '工具熔断：' + toolFailureScope(name, args) +
        ' 连续失败 ' + (state && state.count || 0) + ' 次已停止，AI 将换策略处理。';
}
