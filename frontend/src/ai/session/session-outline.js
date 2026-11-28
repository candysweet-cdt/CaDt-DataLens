// 会话大纲数据层：把当前 AI 会话的用户消息压成定位项（buildSessionOutlineItems），
// 供 AI 面板的会话滑轨（session-rail.js）渲染刻度与气泡。渲染/跳转已随「会话结构」来源
// 下线，本模块只保留纯数据函数与定位条控制器（snapshot / 视口判定 / jumpTo）。
import {splitTurnReminderPrefix} from '../chat/ai-turn-reminder.js';
import {splitQuotePrefix} from '../chat/ai-quote.js';

const MAX_TEXT = 160;
const MAX_ITEMS = 400;

// 单行预览：把换行、连续空白压成空格，避免行高被撑开
function oneLine(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (s.length <= MAX_TEXT) return s;
    return s.slice(0, MAX_TEXT) + '…';
}

// 快捷操作（Git 快捷操作 + 其他快捷操作：维护认知索引 / 生成更新日志 / 维护文件大纲）
// 是用户主动发起的一轮，与亲手键入的消息一样计入滑轨。所有快捷操作发送时 app.kind='git'
// （见 ai-git-ui.js），旧会话的「维护文件大纲」是 kind='outline'；label 前缀作兜底兼容。
// 定时任务（schedule）、截图（browser/read-image）、信箱通知等其余应用消息不算一轮。
export function isShortcutMessage(message) {
    if (!message || message.role !== 'user') return false;
    const app = message.app;
    if (!app) return false;
    const kind = String(app.kind || '');
    if (kind === 'git' || kind === 'outline') return true;
    return /^(Git 快捷操作 · |快捷操作 · )/.test(String(app.label || ''));
}

// 会话消息导航滑轨的气泡描述：取某轮用户消息之后最近一条助手回复的正文预览。
// 从 userIndex + 1 向后扫：跳过 tool 结果与注入类消息（systemNote/silent/app/model-switch），
// 遇到下一条真正的用户轮次（含插话 steer）即停——避免把下一轮的回复错配到本轮；
// 找到第一条有效 assistant 就取 content 正文，压成一行并截断（与用户预览同款口径）。
// 末尾待回复（无后续助手）返回空串。纯函数，配 session-outline.test.mjs 表驱动测试。
export function assistantPreviewAfter(messages, userIndex) {
    const list = Array.isArray(messages) ? messages : [];
    const from = Number(userIndex);
    if (!Number.isFinite(from) || from < 0) return '';
    const isInjected = (m) => !!(m && (m.systemNote || m.silent || m.app || m.kind === 'model-switch'));
    for (let i = Math.floor(from) + 1; i < list.length; i += 1) {
        const m = list[i];
        if (!m || isInjected(m)) continue;
        if (m.role === 'user') break; // 下一轮（含插话）开始，本轮没有可归属的助手回复
        if (m.role === 'assistant') return oneLine(m.content == null ? '' : String(m.content));
    }
    return '';
}

// 把 session.messages 压成定位项：只留用户真正说过的话 + 用户主动发起的快捷操作。
// 系统注记（systemNote）、静默注入（silent）、非快捷操作的应用注入指令（app）、模型切换
// 记录都不算一轮；快捷操作（app.kind=git/outline）例外，按用户轮次计入并用卡片 label 作标题。
// 预览只取正文：开头的 <system-reminder> 宿主环境块随用户消息一起落盘，直接预览会
// 把整行显示成注记（workspace_context 等）；环境块之后可能还有 <quote> 引用标记，
// 同样要剥掉只留用户真正说的话（与气泡渲染/编辑重发口径一致），否则整行变成标记原文。
// 只有环境块和引用、没有正文也没有图片/视频的纯注入消息没有可定位的内容，不占行。
// options.max 限制最多返回多少条（保留最近的），返回里带 total / truncated。
export function buildSessionOutlineItems(messages, options) {
    const opts = options || {};
    const max = Number(opts.max) > 0 ? Math.round(Number(opts.max)) : MAX_ITEMS;
    const list = Array.isArray(messages) ? messages : [];
    const all = [];
    let round = 0;
    for (let i = 0; i < list.length; i += 1) {
        const message = list[i];
        if (!message || message.role !== 'user') continue;
        const shortcut = isShortcutMessage(message);
        if (!shortcut && (message.systemNote || message.silent || message.app || message.kind === 'model-switch')) continue;
        const steer = message.steer === true;
        const withoutReminder = splitTurnReminderPrefix(message.content == null ? '' : String(message.content)).body;
        // 快捷操作正文是整段提示词，气泡标题用卡片上的 label（如「Git 快捷操作 · 提交并推送」）。
        const text = shortcut
            ? String((message.app && message.app.label) || '快捷操作')
            : splitQuotePrefix(withoutReminder).body.replace(/\s+/g, ' ').trim();
        const images = Array.isArray(message.images) ? message.images.length : 0;
        const videos = Array.isArray(message.videos) ? message.videos.length : 0;
        const media = images ? '（' + images + ' 张图片）' : (videos ? '（' + videos + ' 个视频）' : '');
        if (!text && !media) continue;
        // 插话（steer）不是新回合、不占新轮号，但它是用户说过的话：必须可定位，标「插话」。
        if (!steer) round += 1;
        all.push({
            index: i,
            round: round || 1,
            ts: Number(message.ts) || Number(message.turnStartedAt) || 0,
            // 气泡标题走同一套单行截断：超长提示词/粘贴的长文不能整段撑满 tooltip。
            text: oneLine(text || media),
            // 导航滑轨气泡的描述行：该轮助手回复正文预览（无回复则空串）。
            // 与 text 不同，summary 依赖全量 messages，截断后仍按原始 index 取值。
            summary: assistantPreviewAfter(list, i),
            steer,
        });
    }
    const items = all.length > max ? all.slice(all.length - max) : all;
    return {total: all.length, truncated: all.length > items.length, items};
}

// ---------- 定位条控制器（方案 M5 从 ai-panel.js 搬入） ----------
// 数据快照 / 视口吸附 / 跳到某一轮；消息窗口（renderWindows）与重绘由宿主注入，
// 结构面板的刷新通知（onPanelStateChange）也走宿主。面板侧保留同名函数声明做转发，
// 既有调用点（renderMessages / appendToolCard 等）零改动。
export function createSessionOutlineController(ctx) {
    const el = ctx.el;
    const currentSession = ctx.currentSession;
    const onPanelStateChange = ctx.onPanelStateChange;
    const renderWindowState = ctx.renderWindowState;
    const renderWindows = ctx.renderWindows;
    const renderMessages = ctx.renderMessages;
    const onActiveChange = typeof ctx.onActiveChange === 'function' ? ctx.onActiveChange : null;

    const OUTLINE_MAX_ITEMS = 400;
    let activeIndex = -1;
    let frame = 0;
    let timer = 0;

    function snapshot() {
        const session = currentSession();
        if (!session) return {sessionId: '', items: [], activeIndex: -1};
        const built = buildSessionOutlineItems(session.messages, {max: OUTLINE_MAX_ITEMS});
        return {
            sessionId: session.id,
            total: built.total,
            truncated: built.truncated,
            items: built.items,
            activeIndex,
        };
    }

    // 视口顶部所在的那一轮：scrollTop 落在某条用户消息之内时就认为定位到它。
    // 只有滑轨里的消息参与高亮：普通用户消息 + 快捷操作卡片（index 在 items 里）；
    // 定时任务 / 截图 / 通知等应用消息不在 items 里，滚到它们时不高亮任何刻度。
    function activeFromView() {
        if (!el.messages) return -1;
        const valid = new Set(snapshot().items.map((item) => item.index));
        const nodes = [...el.messages.querySelectorAll('.ai-msg.user:not(.archived):not(.model-switch)')]
            .filter((node) => valid.has(Number(node.dataset.aiIdx)));
        if (!nodes.length) return -1;
        const top = el.messages.getBoundingClientRect().top;
        const pick = (node) => {
            const idx = Number(node.dataset.aiIdx);
            return Number.isFinite(idx) ? idx : -1;
        };
        for (const node of nodes) {
            if (node.getBoundingClientRect().bottom > top + 4) return pick(node);
        }
        return pick(nodes[nodes.length - 1]);
    }

    function scheduleSync() {
        if (frame) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            const next = activeFromView();
            if (next === activeIndex) return;
            activeIndex = next;
            if (onActiveChange) onActiveChange(activeIndex);
            notify();
        });
    }

    // 结构面板要跟着变的时机（开合 / 显示方式 / 消息变化）统一从这里通知
    function notify() {
        if (!onPanelStateChange) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
            try {
                onPanelStateChange();
            } catch (e) {}
        }, 140);
    }

    // 跳到某一轮用户消息：目标在窗口之外时先把更早的消息放进来
    function jumpTo(index) {
        const session = currentSession();
        const idx = Math.round(Number(index));
        if (!session || !Number.isFinite(idx) || idx < 0 || idx >= session.messages.length) return false;
        const state = renderWindowState(session);
        if (idx < state.start) {
            state.start = Math.max(0, idx - 8);
            state.len = session.messages.length;
            renderWindows.set(session.id, state);
            renderMessages(true);
        }
        const node = el.messages ? el.messages.querySelector('.ai-msg[data-ai-idx="' + idx + '"]') : null;
        if (!node) return false;
        if (node.scrollIntoView) node.scrollIntoView({block: 'center', behavior: 'smooth'});
        node.classList.remove('ai-msg-flash');
        void node.offsetWidth;
        node.classList.add('ai-msg-flash');
        setTimeout(() => node.classList.remove('ai-msg-flash'), 1600);
        activeIndex = idx;
        if (onActiveChange) onActiveChange(activeIndex);
        notify();
        return true;
    }

    return {snapshot, scheduleSync, notify, jumpTo};
}
