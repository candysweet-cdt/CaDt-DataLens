import {iconSvg, renderMenuIcon} from './icons.js';

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

export function createContextMenu() {
    const root = el('div', 'ctx-menu hidden');
    document.body.appendChild(root);
    let panels = [root];
    let isOpen = false;
    let openOptions = {};

    function closeDeeper(depth) {
        while (panels.length > depth + 1) {
            const panel = panels.pop();
            panel.remove();
        }
    }

    function close() {
        const onClose = openOptions.onClose;
        closeDeeper(0);
        root.classList.add('hidden');
        root.textContent = '';
        isOpen = false;
        openOptions = {};
        if (typeof onClose === 'function') {
            try { onClose(); } catch (e) {}
        }
    }

    function place(panel, x, y) {
        panel.classList.remove('hidden');
        panel.style.left = '0px';
        panel.style.top = '0px';
        panel.style.maxHeight = '';
        panel.style.overflowY = '';
        let width = panel.offsetWidth;
        let height = panel.offsetHeight;
        const margin = 8;
        // 菜单比视口还高时限制高度并内部滚动，避免被窗口截断
        const maxH = window.innerHeight - margin * 2;
        if (height > maxH) {
            panel.style.maxHeight = maxH + 'px';
            panel.style.overflowY = 'auto';
            height = maxH;
            width = panel.offsetWidth;
        }
        let left = Math.min(x, window.innerWidth - width - margin);
        let top = Math.min(y, window.innerHeight - height - margin);
        left = Math.max(margin, left);
        top = Math.max(margin, top);
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
    }

    function placeSubmenu(panel, anchor) {
        panel.classList.remove('hidden');
        panel.style.left = '0px';
        panel.style.top = '0px';
        panel.style.maxHeight = '';
        panel.style.overflowY = '';
        const rect = anchor.getBoundingClientRect();
        let width = panel.offsetWidth;
        let height = panel.offsetHeight;
        const margin = 8;
        const maxH = window.innerHeight - margin * 2;
        if (height > maxH) {
            panel.style.maxHeight = maxH + 'px';
            panel.style.overflowY = 'auto';
            height = maxH;
            width = panel.offsetWidth;
        }
        let left = rect.right + 2;
        if (left + width > window.innerWidth - margin) left = rect.left - width - 2;
        left = Math.max(margin, left);
        let top = rect.top - 4;
        if (top + height > window.innerHeight - margin) top = window.innerHeight - height - margin;
        top = Math.max(margin, top);
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
    }

    function openSubmenu(anchor, items, depth) {
        closeDeeper(depth);
        const panel = el('div', 'ctx-menu ctx-sub');
        panel.style.zIndex = String(120 + depth + 1);
        panels.push(panel);
        document.body.appendChild(panel);
        render(panel, items, depth + 1);
        placeSubmenu(panel, anchor);
    }

    // 胶囊徽标（如权限菜单「自动审批」旁的 AI 标识）：item.badge 为短文本。
    function renderBadge(item) {
        if (!item.badge) return null;
        const badge = el('span', 'mi-badge');
        badge.innerHTML = iconSvg('sparkles', 9);
        badge.appendChild(el('span', 'mi-badge-text', String(item.badge)));
        return badge;
    }

    function render(panel, items, depth) {
        for (const item of items || []) {
            if (item.sep) {
                panel.appendChild(el('div', 'menu-sep'));
                continue;
            }
            const rich = !!item.description;
            const badge = renderBadge(item);
            const row = el('button', 'menu-item ctx-item' + (rich ? ' ctx-rich' : '') +
                (item.disabled ? ' disabled' : '') + (item.danger ? ' danger' : ''));
            row.type = 'button';
            const icon = el('span', 'mi-icon');
            renderMenuIcon(icon, rich ? {...item, checked: false} : item);
            const label = el('span', 'mi-label', item.label);
            const key = el('span', 'mi-key', item.shortcut || '');
            if (rich) {
                const text = el('span', 'mi-text');
                if (badge) {
                    const line = el('span', 'mi-line');
                    line.append(label, badge);
                    text.append(line, el('span', 'mi-desc', item.description));
                } else {
                    text.append(label, el('span', 'mi-desc', item.description));
                }
                row.append(icon, text, key);
                if (item.selected || item.checked) {
                    const check = el('span', 'mi-check');
                    check.innerHTML = iconSvg('check', 14);
                    row.appendChild(check);
                }
            } else {
                row.append(icon, label);
                if (badge) row.appendChild(badge);
                row.append(key);
            }
            if (item.submenu && item.submenu.length) {
                const arrow = el('span', 'ctx-arrow');
                arrow.innerHTML = iconSvg('chevron-right', 10);
                row.appendChild(arrow);
                row.addEventListener('mouseenter', () => {
                    if (!item.disabled) openSubmenu(row, item.submenu, depth);
                });
                row.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (!item.disabled) openSubmenu(row, item.submenu, depth);
                });
            } else {
                row.addEventListener('mouseenter', () => closeDeeper(depth));
                row.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (item.disabled) return;
                    close();
                    item.action();
                });
            }
            panel.appendChild(row);
        }
    }

    function open(items, x, y, options) {
        close();
        isOpen = true;
        openOptions = options || {};
        render(root, items, 0);
        place(root, x == null ? 24 : x, y == null ? 24 : y);
    }

    document.addEventListener('pointerdown', (e) => {
        if (!isOpen) return;
        if (e.target.closest && e.target.closest('.ctx-menu')) return;
        close();
    }, true);
    window.addEventListener('keydown', (e) => {
        if (!isOpen) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close();
        }
    }, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', (e) => {
        if (!isOpen) return;
        if (e.target && e.target.closest && e.target.closest('.ctx-menu')) return;
        // AI 流式输出会自动滚动消息区；面板内菜单不应因此被关闭
        if (openOptions.ignoreScrollWithin && e.target && e.target.closest && e.target.closest(openOptions.ignoreScrollWithin)) return;
        close();
    }, true);

    return {open, close};
}
