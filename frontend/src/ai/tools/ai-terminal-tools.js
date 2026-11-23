// ai-terminal-tools.js：terminal 工具（内置终端读写）的纯函数——ANSI 清洗、read 结果整形、
// send 文本的审批展示。工具执行在 ai-panel.js，这里只做无副作用的数据整形，
// 配套测试见 ai-terminal-tools.test.mjs。

// ANSI / OSC 控制序列：ConPTY 输出里带颜色、光标移动、标题设置等，模型不需要
const ANSI_RE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;

export function stripAnsi(text) {
    return String(text == null ? '' : text).replace(ANSI_RE, '');
}

// 终端输出用 \r\n 换行，且存在「用 \r 回到行首重绘同一行」的进度条；
// 这里统一成 \n，并把只含 \r 的重绘行保留为最后形态（简单起见：按 \r 切取最后一段）。
export function normalizeTermText(text) {
    const lines = stripAnsi(text).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    for (const raw of lines) {
        // 同一行被 \r 反复重绘时只保留最后一次非空形态（"done\r" 的尾巴不能把 "done" 吃掉）
        const segments = raw.split('\r');
        let picked = '';
        for (let i = segments.length - 1; i >= 0; i--) {
            if (segments[i] !== '') {
                picked = segments[i];
                break;
            }
        }
        out.push(picked);
    }
    return out.join('\n').replace(/\n+$/, '');
}

// 取文本最后 N 行（tail）：按 \n 切，丢掉尾部空行后取末尾 N 行。
export function tailText(text, n) {
    const count = Math.floor(Number(n));
    if (!Number.isFinite(count) || count <= 0) return String(text == null ? '' : text);
    const parts = String(text == null ? '' : text).split('\n');
    while (parts.length && parts[parts.length - 1] === '') parts.pop();
    return parts.slice(-count).join('\n');
}

// terminal read 的返回：头部状态 + 输出正文（截断时说明只给了尾部）
// tailLines > 0 时按「最后 N 行」取（优先于 maxChars 的字符口径）。
export function formatTerminalRead(id, res, maxChars, tailLines) {
    const termId = String(id || '').trim() || '?';
    const exited = !!(res && res.exited);
    const head = '终端 ' + termId + (exited ? '（已退出，退出码 ' + Number(res && res.exitCode) + '）' : '（运行中）');
    let text = normalizeTermText(res && res.text);
    const lines = [head];
    const wantTail = Number(tailLines) > 0;
    if (wantTail) {
        text = tailText(text, tailLines);
        lines.push('（按行取最后 ' + Math.floor(Number(tailLines)) + ' 行）');
    } else if (res && res.truncated) {
        lines.push('（只返回了最近约 ' + (Number(maxChars) || 0) + ' 个字符，更早的输出已滚出缓冲）');
    }
    lines.push(text || '（暂无输出：程序可能还在启动，稍等再 read 一次）');
    return lines.join('\n');
}

// 审批卡里展示的「要往终端写什么」：回车换成可见符号，超长截断
export function terminalSendLabel(text, max = 400) {
    const value = String(text == null ? '' : text).replace(/\r\n/g, '⏎').replace(/[\r\n]/g, '⏎');
    return value.length > max ? value.slice(0, max) + '…' : value;
}

// terminal list 的渲染：本地 UI 会话 + 后端状态合并（后端给 exited / last）
export function formatTerminalList(local, backendList) {
    const labelOf = new Map();
    for (const item of Array.isArray(local) ? local : []) {
        if (item && item.id) labelOf.set(item.id, item);
    }
    const infos = Array.isArray(backendList) ? backendList : [];
    if (!labelOf.size && !infos.length) {
        return '当前没有打开的终端。需要长时间交互时先 terminal open（会自动打开底部终端面板）。';
    }
    const order = [];
    for (const info of infos) {
        if (info && info.id && !order.includes(info.id)) order.push(info.id);
    }
    for (const id of labelOf.keys()) {
        if (!order.includes(id)) order.push(id);
    }
    const lines = ['内置终端（' + order.length + ' 个）：'];
    for (const id of order) {
        const localItem = labelOf.get(id) || {};
        const info = infos.find((item) => item && item.id === id) || {};
        const state = info.exited ? '已退出（退出码 ' + Number(info.exitCode) + '）' : '运行中';
        const shell = info.shell || localItem.shell || '';
        const label = localItem.label || shell || id;
        // 名称与 shell 相同时不重复显示（如页签就是 "cmd"）
        const shellPart = shell && label !== shell ? ' · ' + shell : '';
        lines.push('- ' + id + '（' + label + shellPart + ' · ' + state +
            (localItem.active ? ' · 当前页签' : '') + '）' + (info.last ? ' 最后一行：' + info.last : ''));
    }
    lines.push('读输出用 terminal read（id 传上面的 id）；写入用 terminal send（文本自带 \\r 才回车）。');
    return lines.join('\n');
}

// 排队等待时长的用户可读格式（ai-queue / ai-retry 提示用）：9 秒 / 42 秒 / 8.5 分钟 / 9.9 小时。
// 与 formatCommandDuration 分开：那是「已经花了多久」（毫秒精度、英文单位），
// 这是「还要等多久」（可能长达数小时，需要小时档，且 429 冻结常常是几十分钟起）。
// 秒档取整：等待提示里的小数秒没有信息量，还逼着倒计时每 100ms 重写文案。
export function formatWaitDuration(ms) {
    if (ms == null) return '';
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '';
    const s = n / 1000;
    if (s < 60) return Math.round(s) + ' 秒';
    if (s < 3600) return (s / 60).toFixed(s < 600 ? 1 : 0) + ' 分钟';
    return (s / 3600).toFixed(1) + ' 小时';
}

// ai-retry 原因的用户可读文案：Go 侧给的是「HTTP 429」/「网络错误」这类原始描述，
// 原样拼进提示条用户看不懂。可重试的只有 429 与 5xx（aiRetryableStatus），
// 按类翻译；其余状态码理论上不会出现，原样透传兜底。
export function friendlyRetryReason(reason) {
    const raw = String(reason || '').trim() || '请求失败';
    const m = /^HTTP (\d{3})$/.exec(raw);
    if (!m) return raw;
    const code = Number(m[1]);
    if (code === 429) return '服务商限流';
    if (code >= 500) return '服务商暂时不可用（HTTP ' + code + '）';
    return 'HTTP ' + code;
}

// 命令耗时格式化（run_command 工具卡头部徽标用）：ms → 1.25 s / 12.3 s / 2 m 05 s。
// 口径与 run.js 的 F5 运行计时一致（<10s 两位小数）；非法 / 负值返回 ''，调用方据此不渲染。
export function formatCommandDuration(ms) {
    if (ms == null) return ''; // Number(null) 是 0，会伪装成「0.00 s」，先挡掉
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 60000) {
        const s = n / 1000;
        return s.toFixed(s < 10 ? 2 : 1) + ' s';
    }
    const m = Math.floor(n / 60000);
    const s = Math.round((n % 60000) / 1000);
    // 59.9 s 舍入进位：2 m 60 s 不出现，写成 2 m 00 s
    if (s === 60) return (m + 1) + ' m 00 s';
    return m + ' m ' + String(s).padStart(2, '0') + ' s';
}
