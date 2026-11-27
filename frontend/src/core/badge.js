// @ts-check
// badge.js：胶囊徽标（.mi-badge）——菜单项与通用 UI 共用的语义色小标记。
// 基类与五档语义色的样式都在 style.css 的 .mi-badge 段（基类即 accent 档）；
// 这里只负责按 tone 拼类名，不内置任何文案或图标。

import {el} from './dom.js';

/**
 * 胶囊徽标。tone：accent（默认，可省略）/ success / warn / danger / muted。
 * @param {{text?: string|number, tone?: 'accent'|'success'|'warn'|'danger'|'muted'}} [o]
 * @returns {HTMLElement}
 */
export function createBadge(o = {}) {
    const tone = o.tone && o.tone !== 'accent' ? ' ' + o.tone : '';
    return el('span', 'mi-badge' + tone, o.text == null ? '' : String(o.text));
}
