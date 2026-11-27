// core/tooltip.js：全局 tooltip 运行时（data-tip 属性驱动），替代原生 title。
// 单例气泡挂在 body 上：mouseover/focusin 显示（带停留判定），mouseout/focusout/滚动（仅用户手势）/点击/Esc 隐藏；
// 位置优先在锚点下方，越界翻转到上方并做视口钳制。
//
// 显示时机（别改回「悬停即弹」——扫过一排按钮时满屏乱冒，很打扰人）。
// 参照平台两档制（Windows UX 指南：首次 0.5s / 换控件 0.1s；macOS NSInitialToolTipDelay：1s）：
// - 普通 data-tip：指针要停留 SHOW_DELAY_MS(1s) 才出；一路扫过去不停顿，一个都不弹。
// - 热窗口：气泡刚消失后 WARM_WINDOW_MS 内又贴到别的锚点，只等 RESHOW_DELAY_MS(150ms)——
//   这是 Windows 的 TTDT_RESHOW 语义，沿着一排图标看过去不用一秒一个。
// - 设置页 ⓘ 说明点（.info-tip）：立即出——用户是明确来求解释的，等一秒只会让人以为没反应。
// - 单点覆盖：data-tip-delay="<毫秒>"，0 = 立即（写在外层就整块生效，因为取的是最近 [data-tip]）。
// - 气泡还在屏上时切到相邻锚点：立即出，避免两个相邻图标之间空等一大段。
// - 键盘聚焦（focusin）：立即出，Tab 走查不该还要等。
// - 触屏（粗指针）：点击 ⓘ 切换气泡。
//
// 动态内容（AI 面板流式输出每帧贴底滚动 + innerHTML 重建消息体）不许把 tooltip 打死：
// - 滚动分两类：用户手势（滚轮/触摸/翻页键）之后的滚动照旧立即隐藏——气泡不跟手滚动；
//   程序滚动（流式贴底、布局补偿）不掐 tooltip：指针还压在锚点上就跟着锚点重摆（follow），
//   锚点已被重渲染整只换掉就原地换到指针下的新锚点（retether），被挪出指针下才隐藏且进热窗口。
//   处置判定是纯函数 resolveScrollAction（tooltip.test.mjs 有护栏）。
// - 待显示期间同文案的元素被替换（innerHTML 重建），不重置停留窗口：mouseover 每帧对
//   新元素重来会把 1 秒等待无限顺延，永远弹不出来——文案没变就接续原来的定时器。
// - 定时器到点后再验证一次：按指针当前位置（elementFromPoint）重新认锚，认不到才撤——
//   等待期间锚点被换掉/挪走都不影响「指针还压着就该弹」。
//
// 文本经 textContent 写入（不执行 HTML），\n 以 pre-line 换行。
// 替换约定：元素上的 `.title = x` 统一改 `.dataset.tip = x`（HTML 模板 `title="x"` → `data-tip="x"`）；
// document.title（窗口标题）与 iframe 的 title（无障碍名）不属于 tooltip，保持原生。
//
// 交互扩展（默认关，逐锚点 opt-in，别乱挂——只挂在「解释完顺手给出口」的地方）：
// - data-tip-sticky：指针可以从锚点移进气泡里读长说明，移出「锚点+气泡」这个区域才隐藏；
// - data-tip-actions='[{"label":"去关闭","action":"ai:context-slim"}]'：气泡尾部渲染动作链接，
//   点击经 setTooltipActionHandler 注册的回调分发（main.js 接线），分发后隐藏、不开热窗口；
//   挂了 actions 自动启用 sticky（读完了才点得中链接）。
// 动作链接只用 createElement + textContent 渲染，绝不 innerHTML——原始 HTML 不执行是硬要求。

import {parseJson} from './json-safe.js';

export const SHOW_DELAY_MS = 1000; // 首次悬停的「停留」窗口（对齐 macOS 的 1s；别往下调回 250 = 悬停即弹）
export const RESHOW_DELAY_MS = 150; // 热窗口内的再次显示（Windows TTDT_RESHOW 约 initial/5）
const WARM_WINDOW_MS = SHOW_DELAY_MS; // 上一枚气泡消失后多久内算「热」：正好一个停留窗口（同 Windows）
const HIDE_DELAY_MS = 120;
const INSTANT_SELECTOR = '.info-tip';
const BUBBLE_ID = 'app-tip-bubble';
const VIEWPORT_MARGIN = 8;
const GAP = 6;
const COARSE_POINTER = '(pointer: coarse)';
// wheel/touchmove/翻页键之后多长时间内的 scroll 事件算用户滚动；之外算程序滚动（流式贴底等）
const USER_SCROLL_GRACE_MS = 150;
// 会引发滚动的按键：按下后短暂窗口内的 scroll 归为用户滚动，别被误判成程序滚动
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

let bubble = null;
let anchor = null;
let showTimer = 0;
let showTimerTarget = null; // 待显示的锚点（同文案替换时换绑，定时器闭包读它而不是捕获旧元素）
let hideTimer = 0;
let lastHiddenAt = 0; // 上一枚气泡真正消失的时刻（热窗口起点）
let lastPointer = null; // 最近一次指针位置：滚动/重渲染后用 elementFromPoint 判断锚点是否还压在指针下
let lastUserScrollGestureAt = 0; // 最近一次用户滚动手势（wheel/touchmove/翻页键）
let installed = false;

// ===== 气泡管理 =====
function ensureBubble() {
    if (bubble) return bubble;
    bubble = document.createElement('div');
    bubble.id = BUBBLE_ID;
    bubble.className = 'app-tip';
    bubble.setAttribute('role', 'tooltip');
    bubble.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bubble);
    return bubble;
}

function bubbleVisible() {
    return !!(bubble && bubble.classList.contains('app-tip-on'));
}

// ===== 显示与隐藏 =====
// warm=true 表示这次隐藏是「指针/焦点离开」，可开热窗口；滚动、点击、Esc、窗口失焦不算
// （那是用户在干别的事，不该让下一个 tooltip 提前冒出来）。
// 例外：程序滚动把内容顶走算「指针被顶离锚点」，也开热窗口——内容动了，不是用户在干别的事。
function hideNow(warm) {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = 0;
    hideTimer = 0;
    showTimerTarget = null;
    // 真的显示过才记热窗口：没露过面的待显示被撤销，不该让下一次秒出
    if (warm === true && bubbleVisible()) lastHiddenAt = Date.now();
    if (anchor) {
        if (anchor.getAttribute('aria-describedby') === BUBBLE_ID) anchor.removeAttribute('aria-describedby');
        anchor = null;
    }
    if (bubble) bubble.classList.remove('app-tip-on', 'app-tip-interactive');
    // 焦点别留在已隐藏的气泡里：Tab 会落到看不见的动作链接上
    if (bubble && bubble.contains(document.activeElement) && document.activeElement.blur) {
        document.activeElement.blur();
    }
}

function scheduleHide(delayMs) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => hideNow(true), delayMs);
}

// 纯图标元素（无可见文本、无 aria-label）把气泡文本兼作可访问名。只补缺，且在悬停意图阶段就写，
// 这样即便气泡因为没停留而没弹出来，无障碍名也在。
function ensureAccessibleName(target) {
    const tip = target.getAttribute('data-tip');
    if (!tip) return;
    if (!target.getAttribute('aria-label') && !String(target.textContent || '').trim()) {
        target.setAttribute('aria-label', tip);
    }
}

// 动作链接行：只用 createElement + textContent（原始 HTML 不执行是硬要求），点击在气泡级委托
function renderTipActions(el, actions) {
    if (!actions.length) return;
    const row = document.createElement('div');
    row.className = 'app-tip-actions';
    for (const item of actions) {
        const link = document.createElement('a');
        link.href = '#'; // 只为可聚焦、可回车激活；真导航在 click 委托里 preventDefault 掉
        link.className = 'app-tip-link';
        link.textContent = item.label;
        link.dataset.tipAction = item.action;
        row.appendChild(link);
    }
    el.appendChild(row);
}

// 指针当前位置命中的元素（无位置记录/超出视口时为 null）
function elementAtPointer() {
    if (!lastPointer || !document.elementFromPoint) return null;
    return document.elementFromPoint(lastPointer.x, lastPointer.y);
}

function tipAtPointer() {
    const el = elementAtPointer();
    return el ? closestTip(el) : null;
}

function pointerOverTip(target) {
    return !!target && tipAtPointer() === target;
}

function pointerInBubble() {
    const el = elementAtPointer();
    return !!(el && bubble && bubble.contains(el));
}

// ===== 定位与内容渲染 =====
// 摆位（锚点在 showFor 里先落到 anchor 上）：越界翻到上方并做视口钳制。
// follow/retether 重摆复用同一段数学。锚点离文档或量不出面积就撤——不弹到 (0,0) 垃圾位。
function positionBubble() {
    if (!bubble || !anchor || !anchor.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    if (!rect.width && !rect.height) {
        hideNow();
        return;
    }
    // 量宽高前先摆到左上角，避免上一次位置残留导致测量翻页
    bubble.style.left = '0px';
    bubble.style.top = '0px';
    const width = bubble.offsetWidth;
    const height = bubble.offsetHeight;
    let x = rect.left + rect.width / 2 - width / 2;
    x = Math.max(VIEWPORT_MARGIN, Math.min(x, window.innerWidth - width - VIEWPORT_MARGIN));
    let y = rect.bottom + GAP;
    if (y + height > window.innerHeight - VIEWPORT_MARGIN && rect.top - height - GAP >= VIEWPORT_MARGIN) {
        y = rect.top - height - GAP;
    }
    bubble.style.left = Math.round(x) + 'px';
    bubble.style.top = Math.round(Math.max(VIEWPORT_MARGIN, y)) + 'px';
}

// 两段式气泡内容：data-tip-title 存在时渲染「标题 + 描述」两行，否则维持原来的单段纯文本。
// 一律 createElement + textContent，绝不 innerHTML（原始 HTML 不执行是硬要求）。
function renderTipContent(el, target, tip) {
    el.textContent = '';
    const title = target.getAttribute('data-tip-title');
    if (title) {
        const head = document.createElement('div');
        head.className = 'app-tip-title';
        head.textContent = title;
        el.appendChild(head);
        const body = document.createElement('div');
        body.className = 'app-tip-body';
        body.textContent = tip;
        el.appendChild(body);
    } else {
        el.textContent = tip;
    }
}

function showFor(target) {
    const tip = target && target.getAttribute ? target.getAttribute('data-tip') : null;
    // 锚点已离文档（流式重渲染换掉）就不弹：getBoundingClientRect 全 0，气泡会飞到左上角
    if (!tip || !target.isConnected) return;
    const el = ensureBubble();
    renderTipContent(el, target, tip);
    const actions = parseTipActions(target.getAttribute('data-tip-actions'));
    renderTipActions(el, actions);
    // 只有交互气泡（sticky / 带动作链接）才收指针事件；默认 pointer-events:none，
    // 隐形气泡挡住下面 UI 是事故。隐藏态由 .app-tip-on 复合选择器兜底，双保险。
    el.classList.toggle('app-tip-interactive', target.hasAttribute('data-tip-sticky') || actions.length > 0);
    el.classList.add('app-tip-on');
    ensureAccessibleName(target);
    target.setAttribute('aria-describedby', BUBBLE_ID);
    anchor = target;
    positionBubble();
}

// ===== 动作解析 =====
// 延迟判定（纯函数，tooltip.test.mjs 有护栏）：显式 data-tip-delay 优先，其次 ⓘ 说明点立即，
// 气泡还在屏上换内容不留空档，热窗口内只等 reshow，其余一律走「停留」窗口。
export function resolveTipDelay({
    delayAttr = null,
    instant = false,
    showing = false,
    warm = false,
    baseDelay = SHOW_DELAY_MS,
    reshowDelay = RESHOW_DELAY_MS,
} = {}) {
    if (delayAttr !== null && delayAttr !== undefined && String(delayAttr).trim() !== '') {
        const n = Number(delayAttr);
        if (Number.isFinite(n) && n >= 0) return n;
    }
    if (instant) return 0;
    if (showing) return 0;
    if (warm) return Math.min(reshowDelay, baseDelay);
    return baseDelay;
}

// 滚动时的气泡处置（纯函数，tooltip.test.mjs 有护栏）。AI 面板流式输出每帧贴底滚动，
// 一刀切「滚动即隐藏」会把正看着的气泡反复掐灭、把待显示永远摁到不了点，所以分五类：
// - 'hide-user'：用户手势（滚轮/触摸/翻页键）后的滚动——照旧立即隐藏，不开热窗口；
// - 'keep-pending'：气泡不在屏上——待显示交给到点后的再验证，不在滚动里抢先取消；
// - 'follow'：程序滚动且指针还压在锚点上——气泡跟着锚点重摆；
// - 'retether'：程序滚动且锚点已被重渲染整只换掉——指针下还有 [data-tip] 就原地换锚；
// - 'hide'：程序滚动把锚点挪出指针下——隐藏但进热窗口（是内容动了，不是用户在干别的事）。
export function resolveScrollAction({
    userGesture = false,
    bubbleVisible = false,
    anchorConnected = false,
    pointerOverAnchor = false,
} = {}) {
    if (userGesture) return 'hide-user';
    if (!bubbleVisible) return 'keep-pending';
    if (anchorConnected && pointerOverAnchor) return 'follow';
    if (!anchorConnected) return 'retether';
    return 'hide';
}

// data-tip-actions 解析（纯函数，tooltip.test.mjs 有护栏）：JSON 数组 [{label, action}]，
// label/action 均非空才收；形状不对整段丢弃——显示链路不为坏数据中断，也不 console 噪音。
export function parseTipActions(raw, {maxActions = 3, maxLabelLength = 24} = {}) {
    if (!raw || typeof raw !== 'string') return [];
    const list = parseJson(raw, []);
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const item of list) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const label = String(item.label || '').trim();
        const action = String(item.action || '').trim();
        if (!label || !action) continue;
        out.push({label: label.slice(0, maxLabelLength), action});
        if (out.length >= maxActions) break;
    }
    return out;
}

// 动作分发回调：main.js 安装时注入，tooltip.js 不认识任何业务动作 id
let actionHandler = null;
export function setTooltipActionHandler(fn) {
    actionHandler = typeof fn === 'function' ? fn : null;
}

function showDelayFor(target, alreadyShowing) {
    const warm = lastHiddenAt > 0 && Date.now() - lastHiddenAt <= WARM_WINDOW_MS;
    return resolveTipDelay({
        delayAttr: target.getAttribute('data-tip-delay'),
        instant: !!(target.closest && target.closest(INSTANT_SELECTOR)),
        showing: alreadyShowing,
        warm,
    });
}

function closestTip(target) {
    return target && target.closest ? target.closest('[data-tip]') : null;
}

// 定时器到点后再验证：等待期间流式重渲染可能把锚点换掉/挪走——
// 指针还压着就弹（被换了就按当前位置重新认锚），不在任何 [data-tip] 上才撤。
function showForValidated(target) {
    if (target && target.isConnected && pointerOverTip(target)) {
        showFor(target);
        return;
    }
    const cur = tipAtPointer();
    if (cur) showFor(cur);
    else hideNow();
}

// 锚点被重渲染整只换掉且没派发边界事件时的续命：指针下还有 [data-tip] 就把气泡原地换到
// 新锚点；指针在气泡里（sticky 阅读中）不动。返回 false 表示认不到锚点，交给调用方隐藏。
function retetherAfterReplacement() {
    if (!bubbleVisible() || !anchor || anchor.isConnected) return true;
    if (pointerInBubble()) return true;
    const cur = tipAtPointer();
    if (!cur) return false;
    clearTimeout(hideTimer);
    hideTimer = 0;
    showFor(cur);
    return true;
}

// ===== 绑定安装 =====
export function installTooltip() {
    if (installed) return;
    installed = true;

    document.addEventListener('mouseover', (e) => {
        lastPointer = {x: e.clientX, y: e.clientY};
        // 悬停在气泡上（sticky 交互区）：只续命，不当作新锚点处理
        if (bubbleVisible() && bubble.contains(e.target)) {
            clearTimeout(hideTimer);
            hideTimer = 0;
            return;
        }
        const target = closestTip(e.target);
        if (!target) {
            // 移到没有 tooltip 的地方：撤掉还没到点的待显示，别「鼠标已经走了才弹出来」
            if (showTimer) {
                clearTimeout(showTimer);
                showTimer = 0;
                showTimerTarget = null;
            }
            return;
        }
        if (target === anchor) {
            // 120ms 隐藏窗口内快速回到同一锚点：撤掉待隐藏，别「回来了又消失」
            clearTimeout(hideTimer);
            hideTimer = 0;
            return;
        }
        // 流式重渲染把待显示中的锚点整只换掉（同文案、旧元素已离文档）：
        // 接续原来的定时器继续等，别把停留窗口重置回去——否则每帧重建一次就永远差一秒。
        if (showTimer && showTimerTarget && !showTimerTarget.isConnected &&
            showTimerTarget.getAttribute('data-tip') === target.getAttribute('data-tip')) {
            showTimerTarget = target;
            anchor = target;
            ensureAccessibleName(target);
            clearTimeout(hideTimer);
            hideTimer = 0;
            return;
        }
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
        showTimer = 0;
        hideTimer = 0;
        anchor = target;
        showTimerTarget = target;
        ensureAccessibleName(target);
        const delay = showDelayFor(target, bubbleVisible());
        if (delay <= 0) {
            showFor(target);
            return;
        }
        showTimer = setTimeout(() => {
            showTimer = 0;
            showForValidated(showTimerTarget);
        }, delay);
    });

    document.addEventListener('mouseout', (e) => {
        if (!anchor) return;
        const related = e.relatedTarget;
        // 在锚点子树内移动（含移动到锚点的另一子元素）不隐藏
        if (related && related.closest && closestTip(related) === anchor) return;
        // sticky：气泡属于悬停区域，移进去 / 在里面挪动都不隐藏。
        // 非交互气泡 pointer-events:none，related 落不进来，此判空转。
        if (related && bubble && bubble.contains(related)) return;
        scheduleHide(HIDE_DELAY_MS);
    });

    // 指针位置留档 + 静默换锚兜底：部分 DOM 变更不派发边界事件（元素在指针下被换掉），
    // 气泡会一直挂在离文档的旧锚点上——指针一动就重新对位。
    document.addEventListener('pointermove', (e) => {
        lastPointer = {x: e.clientX, y: e.clientY};
        if (anchor && !anchor.isConnected && !retetherAfterReplacement()) hideNow(true);
    }, {passive: true});

    // 键盘聚焦立即显示：Tab 走查时不该还要等停留
    document.addEventListener('focusin', (e) => {
        // Tab 进了气泡里的动作链接：留住气泡
        if (bubbleVisible() && bubble.contains(e.target)) {
            clearTimeout(hideTimer);
            hideTimer = 0;
            return;
        }
        const target = closestTip(e.target);
        if (!target) return;
        clearTimeout(hideTimer);
        clearTimeout(showTimer);
        showTimer = 0;
        showTimerTarget = null;
        hideTimer = 0;
        showFor(target);
    });

    document.addEventListener('focusout', () => scheduleHide(HIDE_DELAY_MS));

    // 滚动处置见 resolveScrollAction：用户滚动照旧立即隐藏（气泡不跟手滚动）；
    // 程序滚动（AI 流式贴底、布局补偿）不掐 tooltip——跟随重摆 / 原地换锚 / 挪出指针下才隐藏。
    window.addEventListener('scroll', () => {
        const action = resolveScrollAction({
            userGesture: Date.now() - lastUserScrollGestureAt <= USER_SCROLL_GRACE_MS,
            bubbleVisible: bubbleVisible(),
            anchorConnected: !!(anchor && anchor.isConnected),
            pointerOverAnchor: !!(anchor && anchor.isConnected && pointerOverTip(anchor)),
        });
        if (action === 'hide-user') {
            hideNow();
            return;
        }
        if (action === 'keep-pending') return;
        if (action === 'follow') {
            // 指针还压在锚点上：气泡跟着锚点重摆，顺手撤掉待隐藏
            clearTimeout(hideTimer);
            hideTimer = 0;
            positionBubble();
            return;
        }
        if (action === 'retether' && retetherAfterReplacement()) return;
        hideNow(true); // 程序滚动把锚点挪出指针下：进热窗口，用户再贴回来不用重等一秒
    }, true);
    // 用户滚动手势登记：滚轮 / 触摸拖动 / 翻页键，之后短暂窗口内的 scroll 算用户滚动
    window.addEventListener('wheel', () => {
        lastUserScrollGestureAt = Date.now();
    }, {passive: true, capture: true});
    window.addEventListener('touchmove', () => {
        lastUserScrollGestureAt = Date.now();
    }, {passive: true, capture: true});
    document.addEventListener('pointerdown', (e) => {
        // 气泡内按下（点动作链接）：不能先把气泡藏掉，否则 click 落空。触屏点链接也走这条
        if (bubbleVisible() && bubble.contains(e.target)) return;
        const target = closestTip(e.target);
        const coarse = window.matchMedia && window.matchMedia(COARSE_POINTER).matches;
        if (coarse && target && target.classList.contains('info-tip')) {
            if (target === anchor) {
                hideNow();
            } else {
                clearTimeout(hideTimer);
                clearTimeout(showTimer);
                showTimer = 0;
                showTimerTarget = null;
                showFor(target);
            }
            return;
        }
        hideNow();
    }, true);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            hideNow();
            return;
        }
        // 翻页键/方向键引发的滚动归为用户滚动（走隐藏），别被误判成程序滚动
        if (SCROLL_KEYS.has(e.key)) lastUserScrollGestureAt = Date.now();
    });
    window.addEventListener('blur', () => hideNow());

    // 动作链接点击委托：链接只在气泡里有，containment 兜底防误伤
    document.addEventListener('click', (e) => {
        const link = e.target && e.target.closest ? e.target.closest('.app-tip-link') : null;
        if (!link || !bubble || !bubble.contains(link)) return;
        e.preventDefault();
        const action = link.dataset.tipAction || '';
        const handler = actionHandler;
        hideNow(false); // 点完界面在变（如开设置），不开热窗口
        if (handler && action) handler(action);
    });
}
