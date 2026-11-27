// session-rail.js：AI 会话消息导航滑轨。
// 面板左缘一条可滚动的短横线列表，每项对应一轮用户消息（数据来自 session-outline 的 snapshot）。
// hover 立即出两段式气泡（标题=用户消息，描述=助手回复预览），点击/键盘定位到该消息。
// 数据筛选、当前位置判定、跳转全部复用 createSessionOutlineController，本模块只做呈现与交互。
// 显隐由宿主按「设置开关 && 面板宽度」判定后调 syncVisibility，本模块不读 window/布局。
import {el} from '../../core/dom.js';

export const RAIL_MIN_WIDTH = 600; // 面板宽度低于此值不显示：分屏太窄时刻度与气泡会挤
const TICK_GAP_PX = 8; // 短横线之间的固定间距；超出可视高度时由滑轨自身滚动浏览

// 显隐判定（纯函数，配 session-rail.test.mjs）：开关开启且面板够宽才显示。
export function shouldShowRail(enabled, panelWidth, minWidth = RAIL_MIN_WIDTH) {
    return enabled === true && Number(panelWidth) >= minWidth;
}

// 把 snapshot.items 映射成要渲染的刻度：每轮一条短横线，不抽稀、不压缩。
// top 为相对滑轨内容顶部的像素位置；active 为是否当前轮。纯函数，可单测。
export function railTicks(snapshot, trackHeight, maxTicks) {
    const items = (snapshot && snapshot.items) || [];
    const active = Number(snapshot && snapshot.activeIndex);
    const n = items.length;
    if (!n) return {ticks: [], contentHeight: 0, gap: TICK_GAP_PX};
    const height = Number(trackHeight) > 0 ? Number(trackHeight) : 400;
    const explicitCap = Number(maxTicks) > 0 ? Math.round(Number(maxTicks)) : 0;
    const gap = explicitCap > 0 ? Math.max(TICK_GAP_PX, (height - TICK_GAP_PX) / Math.max(1, explicitCap - 1)) : TICK_GAP_PX;
    const contentHeight = Math.max(height, TICK_GAP_PX * n);
    // 刻度块整体在轨道内垂直居中：消息很少时不再贴着顶部（内容超过一屏才从顶部铺开滚动）。
    const span = TICK_GAP_PX + gap * (n - 1);
    const offset = contentHeight > height ? 0 : Math.max(0, (height - span) / 2);
    const ticks = items.map((item, i) => ({
        index: Number(item && item.index),
        round: Number(item && item.round) || i + 1,
        text: String(item && item.text || ''),
        summary: String(item && item.summary || ''),
        steer: item && item.steer === true,
        top: offset + TICK_GAP_PX / 2 + i * gap,
        active: Number(item && item.index) === active,
    }));
    return {ticks, contentHeight, gap};
}

// 滚轮步进：小滚轮逐项，大滚轮/触控板按可视高度翻页；返回夹在内容范围内的新 scrollTop。
export function nextRailScroll(scrollTop, deltaY, viewportHeight, contentHeight) {
    const top = Math.max(0, Number(scrollTop) || 0);
    const viewport = Math.max(1, Number(viewportHeight) || 1);
    const content = Math.max(viewport, Number(contentHeight) || viewport);
    const max = content - viewport;
    if (!max) return 0;
    const delta = Number(deltaY) || 0;
    if (!delta) return top;
    const unit = Math.abs(delta) >= viewport ? viewport : TICK_GAP_PX;
    const step = Math.max(1, Math.round(Math.abs(delta) / unit)) * unit;
    return Math.max(0, Math.min(max, top + Math.sign(delta) * step));
}

// ctx: {panel, snapshot(), onJump(index)}
// 返回 {render(snapshot), syncActive(activeIndex), syncVisibility(enabled, panelWidth), dispose()}
export function createSessionRail(ctx) {
    const panel = ctx.panel;
    if (!panel) return {render() {}, syncActive() {}, syncVisibility() {}, dispose() {}};

    const root = el('div', 'ai-session-rail hidden');
    root.setAttribute('role', 'navigation');
    root.setAttribute('aria-label', '会话消息导航');
    const track = el('div', 'ai-rail-track');
    track.tabIndex = 0;
    track.setAttribute('aria-label', '滚轮浏览会话消息，方向键选择，回车定位');
    root.appendChild(track);
    panel.appendChild(root);

    let currentSnapshot = null;
    let ticks = [];
    let contentHeight = 0;
    let activeIndex = -1;
    let disposed = false;

    function tickNode(tick) {
        const node = el('button', 'ai-rail-tick' + (tick.active ? ' ai-rail-tick-active' : '') + (tick.steer ? ' ai-rail-tick-steer' : ''));
        node.type = 'button';
        node.style.top = tick.top + 'px';
        node.dataset.index = String(tick.index);
        // 两段式气泡经全局 tooltip：data-tip-title=标题，data-tip=描述（均 textContent 写入，不执行 HTML）
        // data-tip-delay=0：会话滑轨是明确来查内容的，悬停立即显示，不走全局 1 秒停留窗口。
        node.setAttribute('data-tip-delay', '0');
        node.setAttribute('data-tip-placement', 'right');
        node.setAttribute('data-tip-title', tick.text);
        node.setAttribute('data-tip', tick.summary || tick.text);
        node.setAttribute('aria-label', '第 ' + tick.round + ' 轮：' + tick.text + (tick.summary ? '，' + tick.summary : ''));
        node.addEventListener('click', () => {
            if (typeof ctx.onJump === 'function') ctx.onJump(tick.index);
        });
        return node;
    }

    function measureBottom() {
        // 底部堆叠区（输入/统计/任务卡）浮在消息区上，滑轨底边要避开它。
        // 与 ai-panel 的 syncMessagesUnderflow 同口径：量 .ai-bottom-stack 实测高度。
        const stack = panel.querySelector('.ai-bottom-stack');
        const h = stack ? Math.round(stack.getBoundingClientRect().height) : 0;
        root.style.setProperty('--ai-rail-bottom', Math.max(0, h) + 'px');
    }

    function render(snapshot) {
        if (disposed) return;
        currentSnapshot = snapshot || null;
        activeIndex = Number(currentSnapshot && currentSnapshot.activeIndex) || -1;
        measureBottom();
        const layout = railTicks(currentSnapshot, track.clientHeight, 0);
        ticks = layout.ticks;
        contentHeight = layout.contentHeight;
        track.textContent = '';
        track.style.setProperty('--ai-rail-content-height', contentHeight + 'px');
        const frag = document.createDocumentFragment();
        for (const tick of ticks) frag.appendChild(tickNode(tick));
        track.appendChild(frag);
        // 新会话/新渲染不继承上一段会话的浏览位置。
        track.scrollTop = 0;
        ensureActiveVisible(false);
    }

    // 轨道高度变了（面板切形态 / 拖宽 / 窗口缩放 / 从隐藏变可见）时只重排刻度位置，
    // 不重建节点、不重置滚动位置——刻度块要随轨道重新垂直居中。
    function reflow() {
        if (disposed || !currentSnapshot || !ticks.length) return;
        if (track.clientHeight <= 0) return;
        const layout = railTicks(currentSnapshot, track.clientHeight, 0);
        ticks = layout.ticks;
        contentHeight = layout.contentHeight;
        track.style.setProperty('--ai-rail-content-height', contentHeight + 'px');
        const nodes = [...track.querySelectorAll('.ai-rail-tick')];
        for (let i = 0; i < nodes.length && i < ticks.length; i += 1) {
            nodes[i].style.top = ticks[i].top + 'px';
        }
        ensureActiveVisible(false);
    }

    const resizeObserver = typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => reflow())
        : null;
    if (resizeObserver) resizeObserver.observe(track);

    function visibleNodes() {
        return [...track.querySelectorAll('.ai-rail-tick')];
    }

    function focusNode(node) {
        if (!node) return;
        node.focus({preventScroll: true});
        const top = Number.parseFloat(node.style.top) || 0;
        const half = node.offsetHeight / 2;
        const viewport = track.clientHeight;
        if (top - half < track.scrollTop) track.scrollTop = Math.max(0, top - half);
        else if (top + half > track.scrollTop + viewport) track.scrollTop = top + half - viewport;
    }

    function ensureActiveVisible(smooth = true) {
        const hit = visibleNodes().find((node) => Number(node.dataset.index) === activeIndex);
        if (!hit) return;
        const top = Number.parseFloat(hit.style.top) || 0;
        const half = hit.offsetHeight / 2;
        const viewport = track.clientHeight;
        const max = Math.max(0, contentHeight - viewport);
        let next = track.scrollTop;
        if (top - half < next) next = Math.max(0, top - half);
        else if (top + half > next + viewport) next = Math.min(max, top + half - viewport);
        if (next !== track.scrollTop) {
            if (smooth && track.scrollTo) track.scrollTo({top: next, behavior: 'smooth'});
            else track.scrollTop = next;
        }
    }

    function syncActive(index) {
        if (disposed || !currentSnapshot) return;
        activeIndex = Number(index);
        currentSnapshot = {...currentSnapshot, activeIndex};
        const nodes = visibleNodes();
        const hit = nodes.find((node) => Number(node.dataset.index) === activeIndex);
        for (const node of nodes) node.classList.toggle('ai-rail-tick-active', node === hit);
        ensureActiveVisible();
    }

    function onWheel(e) {
        if (!ticks.length || contentHeight <= track.clientHeight) return;
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // 横向滚动不劫持
        e.preventDefault();
        e.stopPropagation();
        track.scrollTop = nextRailScroll(track.scrollTop, e.deltaY, track.clientHeight, contentHeight);
    }

    function onKeyDown(e) {
        const nodes = visibleNodes();
        if (!nodes.length) return;
        const current = nodes.indexOf(document.activeElement);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const next = e.key === 'ArrowDown' ? Math.min(nodes.length - 1, current + 1) : Math.max(0, current - 1);
            focusNode(nodes[next]);
        } else if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            focusNode(e.key === 'Home' ? nodes[0] : nodes[nodes.length - 1]);
        } else if ((e.key === 'Enter' || e.key === ' ') && current < 0) {
            e.preventDefault();
            const active = nodes.find((node) => Number(node.dataset.index) === activeIndex) || nodes[0];
            focusNode(active);
        }
    }

    track.addEventListener('wheel', onWheel, {passive: false});
    track.addEventListener('keydown', onKeyDown);

    function syncVisibility(enabled, panelWidth) {
        if (disposed) return;
        root.classList.toggle('hidden', !shouldShowRail(enabled, panelWidth));
        if (!root.classList.contains('hidden')) {
            reflow();
            ensureActiveVisible(false);
        }
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        track.removeEventListener('wheel', onWheel);
        track.removeEventListener('keydown', onKeyDown);
        if (resizeObserver) resizeObserver.disconnect();
        root.remove();
        ticks = [];
        currentSnapshot = null;
    }

    return {render, syncActive, syncVisibility, dispose, root};
}
