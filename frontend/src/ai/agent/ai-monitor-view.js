// ai-monitor-view.js：会话监控窗的只读镜像视图（辅助独立窗第一批）。
// 数据 = 日志重放（会话 replaySessionLog / 群聊 replayGroupLog）+ 应用级广播的
// ai-* 流事件尾随（aichat.Emit 是应用级广播，每个窗口都收得到，按 sessionId 认领）。
// 会话归属不动：原窗口继续持有回合租约与输入权，这里只看；纯函数拆出可单测。

import {replaySessionLog, textOf} from '../session/ai-session-store.js';
import {replayGroupLog} from '../group/ai-group-store.js';
import {createMarkdownRenderer} from '../../core/markdown.js';
import {iconSvg} from '../../core/icons.js';

// 尾随的流式事件集合（与 event-scope.js 的 'session' 档一致，按 sessionId 认领）。
export const MONITOR_STREAM_EVENTS = ['ai-chunk', 'ai-think', 'ai-toolcall', 'ai-done', 'ai-error', 'ai-retry', 'ai-queue'];

// ---- 纯函数（配 frontend/test/ai/ai-monitor-view.test.mjs）----

// createMonitorStreamState 流式尾随状态：sessionId 认领键 + 增量缓冲。
export function createMonitorStreamState(sessionId) {
    return {sessionId: String(sessionId || ''), thinking: '', content: '', tools: [], running: false, note: '', error: ''};
}

// monitorEventMatches 事件是否属于被监控会话（其余窗口的会话事件一律忽略）。
export function monitorEventMatches(state, name, payload) {
    return MONITOR_STREAM_EVENTS.includes(name) && !!payload && String(payload.sessionId || '') === state.sessionId;
}

// applyMonitorEvent 流式事件入账，返回处置方式：
//   'append' —— 增量（chunk/think/toolcall/queue/retry），就地更新活动行；
//   'reload' —— 回合边界（done/error），从磁盘重放拿权威数据，丢弃缓冲；
//   ''       —— 不关心（别窗会话 / 无增量）。
export function applyMonitorEvent(state, name, payload) {
    if (!monitorEventMatches(state, name, payload)) return '';
    switch (name) {
        case 'ai-chunk':
            if (!payload.delta) return '';
            state.running = true;
            state.content += String(payload.delta);
            state.error = '';
            return 'append';
        case 'ai-think':
            if (!payload.delta) return '';
            state.running = true;
            state.thinking += String(payload.delta);
            return 'append';
        case 'ai-toolcall': {
            state.running = true;
            const index = Number(payload.index) || 0;
            let call = state.tools.find((t) => t.index === index);
            if (!call) {
                call = {index, name: '', argsLen: 0};
                state.tools.push(call);
            }
            if (payload.name) call.name = String(payload.name);
            if (payload.argsDelta) call.argsLen += String(payload.argsDelta).length;
            return 'append';
        }
        case 'ai-retry':
            state.note = '请求重试中…';
            return 'append';
        case 'ai-queue':
            state.note = '消息已排队，本轮结束后送达';
            return 'append';
        case 'ai-done':
        case 'ai-error':
            state.error = name === 'ai-error' ? String(payload.message || '回合失败') : '';
            state.running = false;
            state.thinking = '';
            state.content = '';
            state.tools = [];
            state.note = '';
            return 'reload';
        default:
            return '';
    }
}

// normalizeReplayRow 把重放条目压成渲染行（两种日志的形状差异在这里抹平）。
// m：会话 = event.m 消息对象；群聊 = replayGroupLog 的 msg 条目。
export function normalizeReplayRow(m) {
    if (!m || typeof m !== 'object') return null;
    const role = String(m.role || m.kind || 'assistant');
    const name = String(m.speaker || m.agentName || m.name || '');
    const text = textOf(m.content != null ? m.content : (m.text != null ? m.text : ''));
    if (!text && role !== 'user') return null;
    return {role, name, text};
}

// buildMonitorRows 重放行 + 流式尾部 → 渲染行列表；state 有活增量时追加一行
// 「(实时)」assistant，回合结束后由 reload 用磁盘权威数据替换。
export function buildMonitorRows(entries, state) {
    const rows = [];
    for (const m of (entries || [])) {
        const row = normalizeReplayRow(m);
        if (row) rows.push(row);
    }
    if (state && state.running && (state.content || state.thinking || state.tools.length)) {
        const toolText = state.tools
            .filter((t) => t.name)
            .map((t) => '调用 ' + t.name + (t.argsLen ? '（参数 ' + t.argsLen + ' 字符）' : ''))
            .join('；');
        rows.push({
            role: 'assistant',
            name: '',
            text: state.content || (toolText ? '（' + toolText + '）' : '…'),
            reasoning: state.thinking,
            live: true,
        });
    }
    return rows;
}

// formatMonitorStatus 监控状态文案（纯函数）。
export function formatMonitorStatus(state) {
    if (state.running) return '运行中';
    if (state.error) return '出错：' + state.error;
    if (state.note) return state.note;
    return '空闲';
}

// ---- 控制器 ----

// createAIMonitorView 监控窗视图工厂：mount(container) 渲染头 + 时间线并订阅事件。
export function createAIMonitorView(deps) {
    const state = createMonitorStreamState(deps.sessionId);
    const markdownRenderer = createMarkdownRenderer().renderMarkdownHtml;
    let rootEl = null;
    let bodyEl = null;
    let statusEl = null;
    let titleEl = null;
    let disposed = false;
    let pinned = true; // 贴底跟随：用户向上滚动即让位，回到底部恢复
    let unsubs = [];
    let reloadTimer = 0;

    function rowsEl() { return bodyEl; }

    function scrollFollow() {
        if (!bodyEl) return;
        bodyEl.addEventListener('scroll', () => {
            if (!bodyEl) return;
            pinned = bodyEl.scrollTop + bodyEl.clientHeight >= bodyEl.scrollHeight - 32;
        }, {passive: true});
    }

    function renderRow(row) {
        const wrap = document.createElement('div');
        wrap.className = 'monitor-row monitor-' + (row.role === 'user' ? 'user' : (row.live ? 'live' : 'assistant'));
        const meta = document.createElement('div');
        meta.className = 'monitor-row-meta';
        const who = row.role === 'user' ? (row.name || '用户') : (row.name || (deps.kind === 'group' ? '群聊' : '助手'));
        meta.textContent = who + (row.live ? '（实时）' : '');
        wrap.appendChild(meta);
        if (row.reasoning) {
            const think = document.createElement('div');
            think.className = 'monitor-reasoning';
            think.textContent = row.reasoning;
            wrap.appendChild(think);
        }
        const body = document.createElement('div');
        body.className = 'monitor-row-text';
        if (row.text) {
            if (row.role === 'user') {
                body.textContent = row.text;
            } else {
                // 助手消息走共享渲染链（DOMPurify 兜底，与面板同一来源）。
                try { body.innerHTML = markdownRenderer(row.text); } catch (e) { body.textContent = row.text; }
            }
        }
        wrap.appendChild(body);
        return wrap;
    }

    function renderAll() {
        if (!bodyEl) return;
        const entries = currentEntries();
        const rows = buildMonitorRows(entries, state);
        bodyEl.textContent = '';
        for (const row of rows) bodyEl.appendChild(renderRow(row));
        if (!rows.length) {
            const empty = document.createElement('div');
            empty.className = 'monitor-empty';
            empty.textContent = '会话还没有落盘消息。运行中的回合会实时出现在这里。';
            bodyEl.appendChild(empty);
        }
        if (pinned) bodyEl.scrollTop = bodyEl.scrollHeight;
    }

    function updateStatus() {
        if (statusEl) statusEl.textContent = formatMonitorStatus(state);
        if (statusEl) statusEl.classList.toggle('running', !!state.running);
    }

    function currentEntries() {
        return lastReplayed;
    }

    let lastReplayed = [];

    function applyReplay(text) {
        if (deps.kind === 'group') {
            const replay = replayGroupLog(text);
            lastReplayed = replay.messages || [];
            if (replay.header && !titleEl.dataset.done) {
                const name = replay.header.name || replay.header.title || '';
                if (name) setTitle(String(name));
            }
        } else {
            const replay = replaySessionLog(text);
            lastReplayed = replay.messages || [];
            if (replay.header && !titleEl.dataset.done) {
                const name = replay.header.title || replay.header.name || '';
                if (name) setTitle(String(name));
            }
        }
        renderAll();
    }

    function setTitle(text) {
        titleEl.dataset.done = '1';
        titleEl.textContent = text;
        try { if (window.runtime && window.runtime.WindowSetTitle) window.runtime.WindowSetTitle(text + ' · 会话监控 · CaDt-DataLens'); } catch (e) {}
    }

    async function reload() {
        if (disposed) return;
        try {
            const text = deps.kind === 'group'
                ? String(await deps.backend.AIGroupRead(deps.sessionId) || '')
                : String(await deps.backend.AISessionRead(deps.sessionId) || '');
            applyReplay(text);
        } catch (e) {
            if (bodyEl) {
                bodyEl.textContent = '';
                const empty = document.createElement('div');
                empty.className = 'monitor-empty';
                empty.textContent = '会话数据读取失败：' + ((e && e.message) || e);
                bodyEl.appendChild(empty);
            }
        }
        updateStatus();
    }

    function scheduleReload() {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => reload().catch(() => {}), 300);
    }

    // 就地更新活动行：完整重渲染会打断长会话的阅读位置，增量直接改最后一行文本。
    function appendLive() {
        if (!bodyEl) return;
        const entries = currentEntries();
        const rows = buildMonitorRows(entries, state);
        const liveRow = rows.length && rows[rows.length - 1].live ? rows[rows.length - 1] : null;
        let last = bodyEl.lastElementChild;
        if (!liveRow) { renderAll(); return; }
        if (!last || !last.classList.contains('monitor-live')) {
            renderAll();
            return;
        }
        const textEl = last.querySelector('.monitor-row-text');
        const thinkEl = last.querySelector('.monitor-reasoning');
        if (textEl && liveRow.text) {
            try { textEl.innerHTML = markdownRenderer(liveRow.text); } catch (e) { textEl.textContent = liveRow.text; }
        }
        if (thinkEl && liveRow.reasoning) thinkEl.textContent = liveRow.reasoning;
        if (pinned) bodyEl.scrollTop = bodyEl.scrollHeight;
        updateStatus();
    }

    function mount(container) {
        rootEl = document.createElement('div');
        rootEl.className = 'monitor-root';
        const head = document.createElement('div');
        head.className = 'aux-window-head';
        const label = document.createElement('span');
        label.className = 'aux-window-title';
        label.textContent = deps.kind === 'group' ? '群聊监控' : '会话监控';
        head.appendChild(label);
        titleEl = document.createElement('span');
        titleEl.className = 'aux-window-pill';
        titleEl.textContent = deps.kind === 'group' ? '群聊' : '会话';
        head.appendChild(titleEl);
        if (deps.workspace) {
            const wsPill = document.createElement('span');
            wsPill.className = 'aux-window-pill';
            wsPill.textContent = String(deps.workspace).replace(/^.*[\\/]/, '') || '工作区';
            wsPill.title = deps.workspace;
            head.appendChild(wsPill);
        }
        statusEl = document.createElement('span');
        statusEl.className = 'monitor-status';
        statusEl.textContent = '空闲';
        head.appendChild(statusEl);
        const spacer = document.createElement('div');
        spacer.className = 'aux-window-spacer';
        head.appendChild(spacer);
        const actions = [];
        if (deps.origin && deps.backend && deps.backend.WindowFocusByName) {
            actions.push({icon: 'new-window', tip: '回到主窗口', onClick: () => deps.onOpenHome && deps.onOpenHome()});
        }
        actions.push({icon: 'close', tip: '关闭', onClick: () => deps.onClose && deps.onClose()});
        for (const a of actions) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'aux-window-btn';
            btn.dataset.tip = a.tip;
            btn.setAttribute('aria-label', a.tip);
            btn.innerHTML = iconSvgOf(a.icon);
            btn.addEventListener('click', (e) => { e.stopPropagation(); a.onClick(e); });
            head.appendChild(btn);
        }
        bodyEl = document.createElement('div');
        bodyEl.className = 'monitor-body aux-window-body';
        rootEl.append(head, bodyEl);
        container.textContent = '';
        container.appendChild(rootEl);
        scrollFollow();
        updateStatus();
        reload();
        for (const name of MONITOR_STREAM_EVENTS) {
            unsubs.push(deps.appEvents.onApp(name, (payload) => {
                const how = applyMonitorEvent(state, name, payload);
                if (how === 'append') appendLive();
                else if (how === 'reload') scheduleReload();
            }));
        }
    }

    function dispose() {
        disposed = true;
        clearTimeout(reloadTimer);
        for (const off of unsubs) { try { off(); } catch (e) {} }
        unsubs = [];
    }

    return {mount, dispose, reloadForTest: reload};
}

// iconSvgOf 监控窗的极小图标集：统一走注册表（尺寸对齐同窗 main.js 按钮的 iconSvg(_, 12) 惯例）。
function iconSvgOf(name) {
    const keys = {close: 'close', 'new-window': 'new-window', refresh: 'refresh'};
    return iconSvg(keys[name] || 'close', 12);
}
