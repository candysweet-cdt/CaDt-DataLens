// palette.js：命令面板（Ctrl+Shift+P）。分组动作注册表 + 模糊过滤 + 键盘导航。
// 纯逻辑（分组/评分/标签拆分）在 palette-model.js，这里只管 DOM 渲染与交互。
import {overlayStack} from '../core/overlay-stack.js';
import {iconSvg, resolveIconName} from '../core/icons.js';
import {groupActions} from './palette-model.js';

export function createPalette(options) {
    const mask = options.mask;
    const input = options.input;
    const list = options.list;
    let openState = false;
    let rows = [];
    let index = 0;
    // 弹层栈条目：Esc 归栈分发（input 上的键仍由 handleKey 自理）
    let stackHandle = null;

    // 项的图标槽：文件类型项带 iconHtml/iconClass（fileIconSpec 域），
    // 普通菜单项带命名 icon（经 resolveIconName 校验后走 iconSvg）。
    function renderItemIcon(el, item) {
        if (item.iconHtml) {
            const span = document.createElement('span');
            span.className = 'palette-item-icon' + (item.iconClass ? ' ' + item.iconClass : '');
            span.innerHTML = item.iconHtml; // iconHtml-exception: 文件类型图标来自 fileIconSpec/core/icons.js，非手写字面量
            el.appendChild(span);
            return;
        }
        const name = resolveIconName(item.icon);
        if (name) {
            const span = document.createElement('span');
            span.className = 'palette-item-icon';
            span.innerHTML = iconSvg(name, 14);
            el.appendChild(span);
        }
    }

    function updateSelection() {
        for (let i = 0; i < rows.length; i++) {
            rows[i].el.classList.toggle('selected', i === index);
        }
        const cur = rows[index];
        if (cur && cur.el.scrollIntoView) cur.el.scrollIntoView({block: 'nearest'});
    }

    function render() {
        const query = input.value.trim();
        const groups = groupActions(options.getActions() || [], query);
        rows = [];
        list.textContent = '';
        let number = 0;
        for (const group of groups) {
            if (group.group) {
                const head = document.createElement('div');
                head.className = 'palette-group-head';
                head.innerHTML = iconSvg(group.icon, 13);
                const title = document.createElement('span');
                title.textContent = group.group;
                head.appendChild(title);
                list.appendChild(head);
            }
            for (const {action, text} of group.items) {
                const idx = number++;
                const el = document.createElement('button');
                el.type = 'button';
                el.className = 'quick-switch-item palette-item' + (idx === index ? ' selected' : '');
                renderItemIcon(el, action);
                const labelEl = document.createElement('span');
                labelEl.className = 'quick-switch-label';
                labelEl.textContent = text;
                el.appendChild(labelEl);
                if (action.shortcut) {
                    const sc = document.createElement('span');
                    sc.className = 'quick-switch-value';
                    sc.textContent = action.shortcut;
                    el.appendChild(sc);
                }
                el.addEventListener('click', () => run(idx));
                list.appendChild(el);
                rows.push({item: action, el});
            }
        }
        if (index >= rows.length) index = Math.max(0, rows.length - 1);
        updateSelection();
        if (!rows.length) {
            const empty = document.createElement('div');
            empty.className = 'quick-switch-item disabled';
            empty.textContent = '没有匹配的命令';
            list.appendChild(empty);
        }
    }

    function run(idx) {
        const row = rows[idx];
        if (!row || !row.item || typeof row.item.action !== 'function') return;
        close();
        try {
            row.item.action();
        } catch (e) {}
    }

    function openPalette() {
        openState = true;
        mask.classList.remove('hidden');
        if (stackHandle) stackHandle.dispose();
        stackHandle = overlayStack.open({
            id: 'palette', kind: 'modal', el: mask,
            onClose: () => { close(); return true; },
        });
        input.value = '';
        index = 0;
        render();
        setTimeout(() => input.focus(), 0);
    }

    function close() {
        openState = false;
        if (stackHandle) {
            stackHandle.dispose();
            stackHandle = null;
        }
        mask.classList.add('hidden');
    }

    function toggle() {
        if (openState) close();
        else openPalette();
    }

    function handleKey(e) {
        if (e.key === 'ArrowDown') {
            index = Math.min(rows.length - 1, index + 1);
            updateSelection();
            return true;
        }
        if (e.key === 'ArrowUp') {
            index = Math.max(0, index - 1);
            updateSelection();
            return true;
        }
        if (e.key === 'PageDown') {
            index = Math.min(rows.length - 1, index + 8);
            updateSelection();
            return true;
        }
        if (e.key === 'PageUp') {
            index = Math.max(0, index - 8);
            updateSelection();
            return true;
        }
        if (e.key === 'Enter') {
            run(index);
            return true;
        }
        // Esc 不在这里处理：面板已进全局弹层栈，栈按层序关（input 上的键到不了这里）
        return false;
    }

    input.addEventListener('input', () => {
        index = 0;
        render();
    });
    input.addEventListener('keydown', (e) => {
        if (handleKey(e)) {
            e.preventDefault();
            e.stopPropagation();
        }
    });
    mask.addEventListener('mousedown', (e) => {
        if (e.target === mask) close();
    });

    return {toggle, close, isOpen: () => openState};
}
