// @ts-check
// empty-state.js：空状态占位——icon 圈 + 标题 + 提示 + 可选动作按钮。
// 统一「无会话 / 无文件 / 无搜索结果 / 无记录」的空观感；图标一律走 icons.js
// 注册表（没有的先登记再引用，icon-guard 盯着）。动作按钮复用 .dlg-btn 外观，
// 仅以 .empty-state-action 修饰成弱化强调色。

import {el} from './dom.js';
import {iconSvg} from './icons.js';

/**
 * 空状态占位。icon 是 icons.js 的注册名；action 可选 {label, onClick}。
 * @param {{icon?: string, title?: string, hint?: string,
 *          action?: {label: string, onClick?: (e: Event) => void}}} [o]
 * @returns {HTMLElement}
 */
export function renderEmptyState(o = {}) {
    const root = el('div', 'empty-state');
    if (o.icon) {
        const icon = el('span', 'empty-state-icon');
        icon.innerHTML = iconSvg(String(o.icon), 18);
        root.append(icon);
    }
    if (o.title) root.append(el('div', 'empty-state-title', String(o.title)));
    if (o.hint) root.append(el('div', 'empty-state-hint', String(o.hint)));
    if (o.action && o.action.label) {
        const btn = /** @type {HTMLButtonElement} */ (el('button', 'dlg-btn empty-state-action', String(o.action.label)));
        btn.type = 'button';
        if (typeof o.action.onClick === 'function') btn.addEventListener('click', o.action.onClick);
        root.append(btn);
    }
    return root;
}
