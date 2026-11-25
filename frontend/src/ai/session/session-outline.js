// 会话结构（用户消息定位条）：
// 把当前 AI 会话里的每一轮用户消息渲染成一行可点击的定位项，点一下跳到那条消息。
// 数据由 ai-panel 的 bridgeSessionOutline() 提供，跳转也由 ai-panel 执行（消息窗口、
// 滚动与高亮都在那边），本模块只做渲染与键盘/点击交互。
import {splitTurnReminderPrefix} from '../chat/ai-turn-reminder.js';
import {splitQuotePrefix} from '../chat/ai-quote.js';
import {el} from '../../core/dom.js';

const MAX_TEXT = 160;
const MAX_ITEMS = 400;

// 单行预览：把换行、连续空白压成空格，避免行高被撑开
function oneLine(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (s.length <= MAX_TEXT) return s;
    return s.slice(0, MAX_TEXT) + '…';
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

function shortTime(ts) {
    const ms = Number(ts) || 0;
    if (!ms) return '';
    const d = new Date(ms);
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
    return sameDay ? pad(d.getHours()) + ':' + pad(d.getMinutes())
        : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 把 session.messages 压成定位项：只留用户真正说过的话。
// 系统注记（systemNote）、静默注入（silent）、应用注入的指令（app）、模型切换记录都不算一轮。
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
        if (message.systemNote || message.silent || message.app || message.kind === 'model-switch') continue;
        const steer = message.steer === true;
        const withoutReminder = splitTurnReminderPrefix(message.content == null ? '' : String(message.content)).body;
        const text = splitQuotePrefix(withoutReminder).body.replace(/\s+/g, ' ').trim();
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
            text: text || media,
            // 导航滑轨气泡的描述行：该轮助手回复正文预览（无回复则空串）。
            // 与 text 不同，summary 依赖全量 messages，截断后仍按原始 index 取值。
            summary: assistantPreviewAfter(list, i),
            steer,
        });
    }
    const items = all.length > max ? all.slice(all.length - max) : all;
    return {total: all.length, truncated: all.length > items.length, items};
}

// snapshot: {items: [{index, round, text, ts}], activeIndex}
// opts: {onJump(index)}
export function renderSessionOutline(body, snapshot, opts) {
    if (!body) return;
    const options = opts || {};
    const items = (snapshot && snapshot.items) || [];
    const active = Number(snapshot && snapshot.activeIndex);
    const list = el('div', 'so-list');
    for (let i = 0; i < items.length; i += 1) {
        const item = items[i] || {};
        const index = Number(item.index);
        if (!Number.isFinite(index)) continue;
        const row = el('div', 'sb-row so-row' + (index === active ? ' so-current' : '') + (item.steer ? ' so-steer' : ''));
        row.tabIndex = -1;
        row.dataset.index = String(index);
        row.appendChild(el('span', 'so-num', String(item.round || i + 1)));
        if (item.steer) row.appendChild(el('span', 'so-steer-tag', '插话'));
        row.appendChild(el('span', 'so-text', oneLine(item.text) || '（图片消息）'));
        const time = shortTime(item.ts);
        if (time) row.appendChild(el('span', 'so-time', time));
        const jump = () => {
            if (typeof options.onJump === 'function') options.onJump(index);
        };
        row.addEventListener('click', () => {
            row.focus({preventScroll: true});
            jump();
        });
        row.addEventListener('keydown', (e) => {
            const rows = [...body.querySelectorAll('.so-row')];
            const at = rows.indexOf(row);
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (at + 1 < rows.length) rows[at + 1].focus();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (at > 0) rows[at - 1].focus();
            } else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                jump();
            }
        });
        list.appendChild(row);
    }
    body.appendChild(list);
}

// 只更新「当前定位」高亮：滚动时避免整表重建
export function syncSessionOutlineActive(body, activeIndex) {
    if (!body) return;
    const active = String(Number(activeIndex));
    for (const row of body.querySelectorAll('.so-row')) {
        row.classList.toggle('so-current', row.dataset.index === active);
    }
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

    // 视口顶部所在的那一轮：scrollTop 落在某条用户消息之内时就认为定位到它
    function activeFromView() {
        if (!el.messages) return -1;
        const nodes = el.messages.querySelectorAll('.ai-msg.user:not(.archived):not(.ai-app-msg):not(.model-switch)');
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
