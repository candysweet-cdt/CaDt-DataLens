// session-rail.js：AI 会话消息导航滑轨。
// 面板边缘一条竖直轨道，每刻度对应一轮用户消息（数据来自 session-outline 的 snapshot），
// hover 出两段式气泡（标题=用户消息，描述=助手回复预览），点击/键盘定位到该消息。
// 数据筛选、当前位置判定、跳转全部复用 createSessionOutlineController，本模块只做呈现与交互。
// 显隐由宿主按「设置开关 && 面板宽度」判定后调 syncVisibility，本模块不读 window/布局。
import {el} from '../../core/dom.js';

export const RAIL_MIN_WIDTH = 600; // 面板宽度低于此值不显示：分屏太窄时刻度与气泡会挤
const MIN_TICK_GAP_PX = 4; // 抽稀密度：轨道每 4px 最多一个刻度

// 显隐判定（纯函数，配 session-rail.test.mjs）：开关开启且面板够宽才显示。
export function shouldShowRail(enabled, panelWidth, minWidth = RAIL_MIN_WIDTH) {
    return enabled === true && Number(panelWidth) >= minWidth;
}

// 把 snapshot.items 映射成要渲染的刻度。
// 分布：按 items 顺序等距铺满轨道（每轮用户消息一个刻度，视觉均匀）；
// 抽稀：超过轨道高度允许的刻度数时按 step 取样，但强制保留 active 对应的刻度；
// top 为百分比（0-100），active 为是否当前轮。纯函数，可单测。
export function railTicks(snapshot, trackHeight, maxTicks) {
    const items = (snapshot && snapshot.items) || [];
    const active = Number(snapshot && snapshot.activeIndex);
    const n = items.length;
    if (!n) return [];
    const heightCap = Math.max(1, Math.floor((Number(trackHeight) > 0 ? Number(trackHeight) : 400) / MIN_TICK_GAP_PX));
    const explicitCap = Number(maxTicks) > 0 ? Math.round(Number(maxTicks)) : 0;
    const cap = explicitCap > 0 ? Math.max(1, explicitCap) : heightCap;
    const step = Math.max(1, Math.ceil(n / cap));
    const activePos = items.findIndex((item) => Number(item && item.index) === active);
    const ticks = [];
    for (let i = 0; i < n; i += 1) {
        const isActive = i === activePos;
        if (i % step !== 0 && !isActive) continue;
        const item = items[i] || {};
        ticks.push({
            index: Number(item.index),
            round: Number(item.round) || i + 1,
            text: String(item.text || ''),
            summary: String(item.summary || ''),
            steer: item.steer === true,
            top: n === 1 ? 50 : (i / (n - 1)) * 100,
            active: isActive,
        });
    }
    return ticks;
}

// ctx: {panel, snapshot(), onJump(index), scheduleSync()}
// 返回 {render(snapshot), syncActive(activeIndex), syncVisibility(enabled, panelWidth), dispose()}
export function createSessionRail(ctx) {
    const panel = ctx.panel;
    if (!panel) return {render() {}, syncActive() {}, syncVisibility() {}, dispose() {}};

    const root = el('div', 'ai-session-rail hidden');
    root.setAttribute('role', 'navigation');
    root.setAttribute('aria-label', '会话消息导航');
    const track = el('div', 'ai-rail-track');
    root.appendChild(track);
    panel.appendChild(root);

    let currentSnapshot = null;
    let ticks = [];
    let disposed = false;

    function tickNode(tick) {
        const node = el('button', 'ai-rail-tick' + (tick.active ? ' ai-rail-tick-active' : '') + (tick.steer ? ' ai-rail-tick-steer' : ''));
        node.type = 'button';
        node.style.top = tick.top + '%';
        node.dataset.index = String(tick.index);
        // 两段式气泡经全局 tooltip：data-tip-title=标题，data-tip=描述（均 textContent 写入，不执行 HTML）
        node.setAttribute('data-tip-title', tick.text);
        node.setAttribute('data-tip', tick.summary || tick.text);
        node.setAttribute('aria-label', '第 ' + tick.round + ' 轮：' + tick.text + (tick.summary ? '，' + tick.summary : ''));
        node.addEventListener('click', () => {
            if (typeof ctx.onJump === 'function') ctx.onJump(tick.index);
        });
        node.addEventListener('keydown', (e) => {
            const nodes = [...track.querySelectorAll('.ai-rail-tick')];
            const at = nodes.indexOf(node);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const next = e.key === 'ArrowDown' ? at + 1 : at - 1;
                if (next >= 0 && next < nodes.length) nodes[next].focus();
            } else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (typeof ctx.onJump === 'function') ctx.onJump(tick.index);
            }
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
        measureBottom();
        ticks = railTicks(currentSnapshot, track.clientHeight, 0);
        track.textContent = '';
        const frag = document.createDocumentFragment();
        for (const tick of ticks) frag.appendChild(tickNode(tick));
        track.appendChild(frag);
    }

    // 滚动时只切高亮 class：目标刻度已在轨道上就不重建；active 落在被抽稀掉的刻度上时补一次 render。
    function syncActive(activeIndex) {
        if (disposed || !currentSnapshot) return;
        const active = Number(activeIndex);
        const nodes = [...track.querySelectorAll('.ai-rail-tick')];
        const hit = nodes.find((node) => Number(node.dataset.index) === active);
        if (hit) {
            for (const node of nodes) node.classList.toggle('ai-rail-tick-active', node === hit);
            return;
        }
        render({...currentSnapshot, activeIndex: active});
    }

    function syncVisibility(enabled, panelWidth) {
        if (disposed) return;
        root.classList.toggle('hidden', !shouldShowRail(enabled, panelWidth));
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        root.remove();
        ticks = [];
        currentSnapshot = null;
    }

    return {render, syncActive, syncVisibility, dispose, root};
}
