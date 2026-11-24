// @ts-check
// popover-position.js：锚点浮层的视口钳制定位（唯一来源）。
// 收口此前散落各浮层的 `Math.max(m, Math.min(x, innerWidth - w - m))` + 「底部放不下翻上方」
// 手写数学（titlebar 下拉 / 消息中心 / 模型选择器 / 提醒弹层等）。前提：浮层 position:fixed
// 且已挂到 body；宽度需要调用方先设好（本函数按当前 offsetWidth 量）。

const DEFAULT_MARGIN = 8;
const DEFAULT_GAP = 4;

/**
 * 把浮层摆到锚点旁并做视口钳制。默认底部优先、放不下翻上方。
 * @param {HTMLElement} el 浮层（position:fixed，已挂 body）
 * @param {HTMLElement} anchor 锚点
 * @param {{margin?:number, gap?:number, placement?:'auto'|'bottom'|'top', align?:'left'|'center'|'right', viewport?:{width:number,height:number}}} [opts]
 *        viewport 仅供测试注入，缺省读 window.innerWidth/innerHeight
 * @returns {{left:number, top:number}|null} 计算坐标（整数像素）；入参不全返回 null
 */
export function placePopover(el, anchor, opts = {}) {
    if (!el || !anchor) return null;
    const margin = opts.margin == null ? DEFAULT_MARGIN : opts.margin;
    const gap = opts.gap == null ? DEFAULT_GAP : opts.gap;
    const placement = opts.placement || 'auto';
    const align = opts.align || 'left';
    const viewW = opts.viewport ? opts.viewport.width : window.innerWidth;
    const viewH = opts.viewport ? opts.viewport.height : window.innerHeight;

    const rect = anchor.getBoundingClientRect();
    // 量宽高前先摆到左上角，避免上一次位置残留导致测量翻页（tooltip 同款做法）
    el.style.left = '0px';
    el.style.top = '0px';
    const width = el.offsetWidth;
    const height = el.offsetHeight;

    let x;
    if (align === 'center') x = rect.left + rect.width / 2 - width / 2;
    else if (align === 'right') x = rect.right - width;
    else x = rect.left;
    x = Math.max(margin, Math.min(x, viewW - width - margin));

    const below = rect.bottom + gap;
    const above = rect.top - height - gap;
    let y;
    if (placement === 'top') y = above;
    else if (placement === 'bottom') y = below;
    else {
        y = below;
        if (y + height > viewH - margin && above >= margin) y = above;
    }
    y = Math.max(margin, Math.min(y, viewH - height - margin));

    const pos = {left: Math.round(x), top: Math.round(y)};
    el.style.left = pos.left + 'px';
    el.style.top = pos.top + 'px';
    return pos;
}
