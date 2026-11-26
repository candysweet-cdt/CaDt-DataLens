// ai-new-session-picker.js：harness 窗口的「新建会话」三选一选择器。
//
// 背景（docs/unfinished-plans/agent-host-platform.md §4.8）：harness 窗口启动时不恢复任何
// 工作区，「新建会话」如果静默建一条无根会话，模型就没有可解析的相对路径。所以 harness 下
// 必须先问清这一轮绑到哪个根：最近工作区 / 打开文件夹 / 会话沙盒。非 harness 窗口不弹
// （直接建，行为与改造前一致）。
//
// 浮层经 core/overlay-stack 注册（Esc 与外点关闭走栈、z-index 由栈按档位分配），
// 行的外观与「账号卡更多菜单」同一套。全程没有输入类控件——将来若要加输入框 / 下拉，
// 必须走 core/form-controls.js 的 createInput / createSelect（仓库硬规范）。

import {overlayStack} from '../../core/overlay-stack.js';
import {el} from '../../core/dom.js';
import {iconSvg} from '../../core/icons.js';

const PICKER_ID = 'ai-new-session-picker';
// 最近工作区最多列 5 个：这不是工作区管理器，多了要滚，也不该盖掉下面两个固定入口。
const RECENT_LIMIT = 5;

let popEl = null;
let stackHandle = null;

function closePicker() {
    const node = popEl;
    const handle = stackHandle;
    popEl = null;
    stackHandle = null;
    if (node && node.parentNode) node.parentNode.removeChild(node);
    // dispose 只出栈（不回调 onClose），所以上面先清句柄再调，避免重入
    if (handle) handle.dispose();
}

function basename(dir) {
    const parts = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || String(dir || '');
}

function addRow(menu, {icon, label, tip, onClick}) {
    const row = el('button', 'ai-new-session-pop-item');
    row.type = 'button';
    row.innerHTML = iconSvg(icon, 13);
    const text = el('span', '', label);
    row.appendChild(text);
    if (tip) row.dataset.tip = tip;
    row.addEventListener('click', () => {
        closePicker();
        if (typeof onClick === 'function') onClick();
    });
    menu.appendChild(row);
    return row;
}

function addSep(menu) {
    menu.appendChild(el('div', 'ai-new-session-pop-sep'));
}

/**
 * 弹出「新建会话」选择器。已开着时先收起（连点不叠层）。
 * @param {{anchor?: HTMLElement|null, recents?: string[], currentWorkspace?: string,
 *          onPickWorkspace?: (dir: string) => void, onOpenFolder?: () => void,
 *          onSandbox?: () => void}} opts
 */
export function showNewSessionPicker(opts) {
    const o = opts || {};
    closePicker();
    if (!o.anchor || typeof document === 'undefined') return;

    const menu = el('div', 'ai-new-session-pop');
    menu.id = PICKER_ID;
    menu.appendChild(el('div', 'ai-new-session-pop-title', '新建会话'));

    const current = String(o.currentWorkspace || '');
    const seen = new Set();
    const recents = (Array.isArray(o.recents) ? o.recents : [])
        .map((dir) => String(dir || ''))
        .filter((dir) => {
            const key = dir.toLowerCase();
            if (!dir || seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, RECENT_LIMIT);

    for (const dir of recents) {
        addRow(menu, {
            icon: 'history',
            label: basename(dir) + (current && dir.toLowerCase() === current.toLowerCase() ? '（当前）' : ''),
            tip: dir,
            onClick: () => { if (typeof o.onPickWorkspace === 'function') o.onPickWorkspace(dir); },
        });
    }
    if (recents.length) addSep(menu);

    addRow(menu, {
        icon: 'open-folder',
        label: '打开文件夹…',
        tip: '选一个目录作为这一轮的根',
        onClick: () => { if (typeof o.onOpenFolder === 'function') o.onOpenFolder(); },
    });
    addRow(menu, {
        icon: 'circle',
        label: '会话沙盒',
        tip: '不绑工作区：根是应用数据下的沙盒目录（可读写，但不注入项目知识）',
        onClick: () => { if (typeof o.onSandbox === 'function') o.onSandbox(); },
    });

    document.body.appendChild(menu);
    popEl = menu;
    const rect = o.anchor.getBoundingClientRect();
    const width = menu.offsetWidth || 168;
    let left = rect.left;
    let top = rect.bottom + 4;
    if (top + menu.offsetHeight > window.innerHeight - 8) top = Math.max(8, rect.top - menu.offsetHeight - 4);
    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = top + 'px';

    stackHandle = overlayStack.open({
        id: PICKER_ID, kind: 'popover', el: menu,
        closeOnOutsideClick: true, anchors: [o.anchor],
        // 外点关闭走 onClose：先拆 DOM 再让栈 dispose（与 ai-model-settings 的卡片菜单同款）
        onClose: () => { closePicker(); return true; },
    });
}

export function closeNewSessionPicker() {
    closePicker();
}
