// ai-loop-guard.js：思考重复检测（纯逻辑，无 DOM）。
// 尾部行窗口上同时看「最高同文重复次数」与「不同行占比」：只认完全相同的整行，
// 正常清单 / 代码引用不会命中；达到阈值返回 warn / prompt，供流式接线决定提示或接管。

export const LOOP_GUARD_DEFAULTS = Object.freeze({
    // 只看最近 600 行：循环一旦持续，旧内容会被新重复挤出窗口，比例始终很低。
    windowLines: 600,
    // 短行噪声太大（括号、空行、return 之类），不参与计数。
    minLineChars: 8,
    // 太短的思考不下结论，避免开场几句口头语误判。
    minLines: 120,
    minChars: 2000,
    // 历史会话标定：正常思考不同行占比普遍 > 70%，循环在 3%–7%；
    // 最高重复次数正常最坏 8 次，循环是 60+。
    warnRepeat: 8,
    warnRatio: 0.25,
    promptRepeat: 15,
    promptRatio: 0.2,
});

function normalizeConfig(options) {
    const source = options && typeof options === 'object' ? options : {};
    const config = {...LOOP_GUARD_DEFAULTS};
    for (const key of Object.keys(LOOP_GUARD_DEFAULTS)) {
        const value = Number(source[key]);
        if (Number.isFinite(value) && value >= 0) config[key] = value;
    }
    config.windowLines = Math.max(1, Math.round(config.windowLines));
    config.warnRepeat = Math.max(1, Math.round(config.warnRepeat));
    config.promptRepeat = Math.max(config.warnRepeat, Math.round(config.promptRepeat));
    return config;
}

// 增量喂入流式增量；内部维护环形行窗口与行频表，push 的开销与窗口大小同级。
export function createLoopGuard(options) {
    const config = normalizeConfig(options);
    const ring = [];
    const counts = new Map();
    let pending = '';
    let chars = 0;

    function evictOldest() {
        const text = ring.shift();
        const next = (counts.get(text) || 0) - 1;
        if (next > 0) counts.set(text, next);
        else counts.delete(text);
    }

    function addLine(raw) {
        const text = String(raw == null ? '' : raw).trim();
        if (text.length < config.minLineChars) return;
        ring.push(text);
        counts.set(text, (counts.get(text) || 0) + 1);
        while (ring.length > config.windowLines) evictOldest();
    }

    function push(delta) {
        const text = String(delta == null ? '' : delta);
        if (!text) return;
        chars += text.length;
        pending += text;
        const parts = pending.split('\n');
        pending = parts.pop() || '';
        for (const line of parts) addLine(line);
    }

    // 流结束时最后一行可能没有换行符：flush 把它计入窗口。
    function flush() {
        if (!pending) return;
        addLine(pending);
        pending = '';
    }

    function stats() {
        let maxRepeat = 0;
        for (const count of counts.values()) {
            if (count > maxRepeat) maxRepeat = count;
        }
        const lines = ring.length;
        const uniq = counts.size;
        return {
            chars,
            lines,
            uniq,
            ratio: lines ? uniq / lines : 1,
            maxRepeat,
        };
    }

    function verdict() {
        const value = stats();
        if (value.lines < config.minLines || value.chars < config.minChars) return '';
        if (value.ratio < config.promptRatio && value.maxRepeat >= config.promptRepeat) return 'prompt';
        if (value.ratio < config.warnRatio && value.maxRepeat >= config.warnRepeat) return 'warn';
        return '';
    }

    function reset() {
        pending = '';
        chars = 0;
        ring.length = 0;
        counts.clear();
    }

    return {config, push, flush, stats, verdict, reset};
}

// 离线分析入口：整段 reasoning 一次性判定（诊断历史会话 / 测试共用）。
export function analyzeReasoningLoop(reasoning, options) {
    const guard = createLoopGuard(options);
    guard.push(reasoning);
    guard.flush();
    return {stats: guard.stats(), level: guard.verdict()};
}
