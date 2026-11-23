// ai-notify-policy.js：通知各通道的投放策略（纯函数，测试直接导入）。
//
// 通道各有各的前提，别混成一个「开不开」开关（2026-11-16 作者定稿，2026-11-17 改消息中心口径）：
//
//   · 消息中心      —— 只记「你需要回来处理」的：失败 / 提问 / 审批 / 计划待批准 / notify_send / 系统事件。
//                     **例行「任务完成」不记**：一轮一条会把列表刷成流水账（同一条会话标题连着刷十几行），
//                     而这件事会话列表上的「已完成未查看」角标已经表达了。
//   · 应用内 toast  —— 「人在软件里，但看的不是这条会话」时弹；**任务完成不弹**。
//   · Windows 系统卡片 —— 「软件在后台」时弹；前台不打扰（任务完成仍走这条：人不在电脑前，得留个卡片）。
//   · 任务栏闪烁    —— 软件在后台时的低强度提示（跟着应用内通知开关走）。
//
// 输入：
//   inApp        设置里的「应用内通知」
//   system       设置里的「Windows 系统通知」
//   foreground   本进程有窗口在前台
//   viewingOther 这条通知的会话不是当前正在看的（面板关着也算 true）
//   completion   这是「任务完成」类通知（不记消息中心、不弹应用内 toast，只可能落系统卡片 / 任务栏闪烁）
export function desktopNotifyTargets(input) {
    const cfg = input || {};
    const background = cfg.foreground !== true;
    const elsewhere = cfg.viewingOther !== false;
    const silentEvent = cfg.completion === true;
    return {
        // 消息中心：任务完成不写（刷屏），其余一律记（可事后查、可点开跳转）
        centerRecord: !silentEvent,
        // 系统卡片只补「你看不到软件」的场景
        systemToast: cfg.system === true && background,
        // 应用内右下角弹层：人就在软件里、只是没停在那个会话上；任务完成不弹
        inAppToast: cfg.inApp === true && !silentEvent && elsewhere && !background,
        // 任务栏闪烁同理，只在人离开了软件时才有意义
        taskbarFlash: cfg.inApp === true && !silentEvent && background,
    };
}

// 系统通知的激活参数（payload）：随通知下发、点击后原样回到前端，格式 "k=v&k2=v2"。
export function buildNotifyActivationPayload(sessionId) {
    const id = String(sessionId || '').trim();
    return id ? 'ai-session=' + encodeURIComponent(id) : '';
}

// 解析激活参数：目前只认 ai-session=<id>；空参数 / 未知键返回 null（点击只拉窗口，不跳转）。
export function parseNotifyActivationPayload(payload) {
    const raw = String(payload || '').trim();
    if (!raw) return null;
    const hit = /(?:^|&)ai-session=([^&]+)/.exec(raw);
    if (!hit) return null;
    const sessionId = decodeURIComponent(hit[1]).trim();
    return sessionId ? {sessionId} : null;
}
