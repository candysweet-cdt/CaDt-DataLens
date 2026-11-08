const SUBMENU_ARROW = '\uE76C';

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

    function closeDeeper(depth) {
        while (panels.length > depth + 1) {
            const panel = panels.pop();
            panel.remove();
        }
    }

    function close() {
        closeDeeper(0);
        root.classList.add('hidden');
        root.textContent = '';
        isOpen = false;
    }

    function place(panel, x, y) {
        panel.classList.remove('hidden');
        panel.style.left = '0px';
        panel.style.top = '0px';
        const width = panel.offsetWidth;
        const height = panel.offsetHeight;
        const margin = 8;
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
        const rect = anchor.getBoundingClientRect();
        const width = panel.offsetWidth;
        const height = panel.offsetHeight;
        const margin = 8;
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

    function render(panel, items, depth) {
        for (const item of items || []) {
            if (item.sep) {
                panel.appendChild(el('div', 'menu-sep'));
                continue;
            }
            const row = el('button', 'menu-item ctx-item' + (item.disabled ? ' disabled' : '') + (item.danger ? ' danger' : ''));
            row.type = 'button';
            const icon = el('span', 'mi-icon' + (item.checked ? ' checked' : '') +
                (item.iconClass ? ' ' + item.iconClass : ''));
            if (item.checked) icon.textContent = '\uE73E';
            else if (item.iconHtml) {
                icon.innerHTML = item.iconHtml;
                if (item.iconClass) icon.dataset.fi = item.iconClass.replace(/^fi-/, '');
            } else if (item.icon) icon.textContent = String.fromCharCode(parseInt(item.icon, 16));
            const label = el('span', 'mi-label', item.label);
            const key = el('span', 'mi-key', item.shortcut || '');
            row.append(icon, label, key);
            if (item.submenu && item.submenu.length) {
                row.appendChild(el('span', 'ctx-arrow', SUBMENU_ARROW));
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

    function open(items, x, y) {
        close();
        isOpen = true;
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
        close();
    }, true);

    return {open, close};
}
