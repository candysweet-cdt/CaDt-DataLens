// @ts-check
// combo-select.js：可过滤下拉（combobox）——createInput 文本框 + body 挂载候选面板。
// 过滤排序复用 completion.js 的 scoreMatch（前缀 > 驼峰 > 子串 > fuzzy；副标题参与但降权，
// 主标题命中的候选永远排在只靠副标题命中的前面）。面板 body 挂载 + placePopover 视口钳制
// 定位；外点关闭与 Esc 收口 overlay-stack（closeOnOutsideClick + anchors）——本文件不自挂
// 任何 document/window 监听（outside-click-guard / overlay-esc-guard 两道护栏盯着）。
// 值真源：createInput 的原生 input。选中项把 label 写回输入框、current 记 option value；
// 重新聚焦全选文本、输入即过滤；↑↓ 换档、Enter 确认、Esc 归栈按层序退。

import {createInput} from './form-controls.js';
import {iconSvg} from './icons.js';
import {scoreMatch} from './completion.js';
import {placePopover} from './popover-position.js';
import {overlayStack} from './overlay-stack.js';

/**
 * @typedef {object} ComboItem
 * @property {string} value 选项值（写回 value getter / onSelect）
 * @property {string} [label] 显示文本，缺省用 value
 * @property {string} [sub] 副标题（如提供方名），参与过滤但降权
 */

/**
 * 过滤候选：按 scoreMatch 打分排序。副标题命中降 200 分——
 * 「只靠副标题蹭进来」的候选不应排在主标题命中前面。空查询按原顺序全量。
 * @param {ComboItem[]} items
 * @param {string} query
 * @returns {ComboItem[]}
 */
export function filterComboItems(items, query) {
    const q = String(query == null ? '' : query).trim();
    if (!q) return items.slice();
    const scored = [];
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const mLabel = scoreMatch(q, String(it.label == null ? it.value : it.label));
        const mSub = it.sub ? scoreMatch(q, String(it.sub)) : null;
        const labelScore = mLabel ? mLabel.score : -1;
        const subScore = mSub ? mSub.score - 200 : -1;
        if (labelScore < 0 && subScore < 0) continue;
        scored.push({it, score: Math.max(labelScore, subScore), at: i});
    }
    scored.sort((a, b) => b.score - a.score || a.at - b.at);
    return scored.map((s) => s.it);
}

/**
 * @typedef {object} ComboSelectOptions
 * @property {ComboItem[]} [items] 候选列表（工厂持快照，外部改动不影响面板）
 * @property {string} [value] 初始选中的 option value
 * @property {string} [placeholder] 输入框占位文本
 * @property {string} [emptyText] 无匹配文案，缺省「无匹配项」
 * @property {string} [id] 挂到原生 input 上
 * @property {boolean} [disabled]
 * @property {string} [title] tooltip（dataset.tip）
 * @property {string} [className] 追加到 .fc-combo 包装上
 * @property {(e: Event) => void} [onChange] 原生 input 的 change（点选/Enter 后由 select 派发）
 * @property {(e: Event) => void} [onInput] 原生 input 的 input
 * @property {(it: ComboItem) => void} [onSelect] 点选 / Enter 确认某候选
 */
/**
 * 可过滤下拉。返回 {element, control, value, setItems}：control 是原生 input（可见文本真源），
 * value 是 getter 返回当前选中的 option value；setItems(items) 整体替换候选（模型列表重载用）。
 * @param {ComboSelectOptions} [o]
 * @returns {{element: HTMLElement, control: HTMLInputElement, value: string,
 *            close: () => void, setItems: (next: ComboItem[]) => void}}
 */
export function createComboSelect(o = {}) {
    // 快照持有：工厂复制调用方的数组，setItems 也整体替换内部列表——
    // 双方互不 Aliasing，调用方数组被外部改动不会串进候选面板
    let items = /** @type {ComboItem[]} */ (Array.isArray(o.items) ? o.items.slice() : []);
    let current = o.value != null ? String(o.value) : '';
    /** @type {ComboItem[]} */
    let shown = [];
    let activeIdx = -1;
    /** @type {{dispose: Function}|null} */
    let handle = null;

    const element = document.createElement('span');
    element.className = 'fc-combo' + (o.className ? ' ' + o.className : '');
    const built = createInput({
        placeholder: o.placeholder,
        spellcheck: false,
        id: o.id,
        autocomplete: 'off',
        tabFillPlaceholder: false,
        onChange: o.onChange,
        onInput: o.onInput,
    });
    const control = built.control;
    if (o.disabled) control.disabled = true;
    if (o.title != null) element.dataset.tip = String(o.title);

    const caret = document.createElement('span');
    caret.className = 'fc-combo-caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.innerHTML = iconSvg('chevron-down', 12);
    // caret 是 toggle 语义：开着点 = 收，收着点 = 聚焦开面板
    caret.addEventListener('click', () => { if (isOpen()) close(); else control.focus(); });

    const panel = document.createElement('span');
    panel.className = 'fc-combo-panel hidden';

    const selected = items.find((it) => String(it.value) === current);
    if (selected) control.value = String(selected.label == null ? selected.value : selected.label);

    /** @param {ComboItem} it */
    function labelOf(it) { return String(it.label == null ? it.value : it.label); }

    function isOpen() { return !panel.classList.contains('hidden'); }

    // 面板挂 body 绕开父容器 overflow 裁剪（settings-select Portal 版同思路）；
    // 关闭即拆节点，不留孤儿。可见性由 .hidden（全局 display:none）表达。
    function placePanel() {
        const rect = element.getBoundingClientRect();
        panel.style.width = Math.round(rect.width) + 'px';
        placePopover(panel, element, {gap: 4});
    }

    /**
     * 重建候选行（shown 由本次过滤结果决定；activeIdx 不在这里动，调用方负责）。
     * @param {string} query
     */
    function renderPanel(query) {
        panel.innerHTML = '';
        shown = filterComboItems(items, query);
        if (!shown.length) {
            const empty = document.createElement('span');
            empty.className = 'fc-combo-empty';
            empty.textContent = o.emptyText || '无匹配项';
            panel.append(empty);
            return;
        }
        shown.forEach((it, i) => {
            const isSelected = String(it.value) === current;
            const row = document.createElement('span');
            row.className = 'fc-combo-item'
                + (isSelected ? ' selected' : '')
                + (i === activeIdx ? ' active' : '');
            const check = document.createElement('span');
            // 用专用 .off 而不是全局 .hidden——全局 .hidden 是 display:none，会把勾位整个
            // 拿掉导致选中/未选中行的主文本错位；.off 只 visibility 占位保槽宽
            check.className = 'fc-combo-check' + (isSelected ? '' : ' off');
            check.innerHTML = iconSvg('check', 12);
            const main = document.createElement('span');
            main.className = 'fc-combo-main';
            const name = document.createElement('span');
            name.className = 'fc-combo-name';
            name.textContent = labelOf(it);
            main.append(name);
            if (it.sub) {
                const sub = document.createElement('span');
                sub.className = 'fc-combo-sub';
                sub.textContent = String(it.sub);
                main.append(sub);
            }
            row.append(check, main);
            // 点击候选时输入框不失焦，就不会出现「blur 先关面板、click 落空」的时序
            row.addEventListener('mousedown', /** @param {MouseEvent} e */ (e) => e.preventDefault());
            row.addEventListener('click', () => select(it));
            panel.append(row);
        });
    }

    function open() {
        if (isOpen() || control.disabled) return;
        activeIdx = -1;
        document.body.append(panel);
        panel.classList.remove('hidden');
        renderPanel('');
        handle = overlayStack.open({
            // 不传固定 id：多个 combo 实例可同时开，has(id) 类查询语义会错
            kind: 'menu',
            el: panel,
            onClose: () => close(),
            // 面板挂 body，defaultIsAlive 查 panel.isConnected 永远为真；
            // 改查宿主——宿主被卸载后栈把本层当死层剔除，Esc 不会被它吞掉
            isAlive: () => element.isConnected,
            closeOnOutsideClick: true,
            anchors: [element],
        });
        placePanel();
    }

    function close() {
        if (!isOpen()) return;
        panel.classList.add('hidden');
        if (handle) { handle.dispose(); handle = null; }
        panel.remove();
    }

    /** @param {ComboItem} it */
    function select(it) {
        current = String(it.value);
        control.value = labelOf(it);
        close();
        control.dispatchEvent(new Event('change', {bubbles: true}));
        if (typeof o.onSelect === 'function') o.onSelect(it);
    }

    /** @param {number} i */
    function setActive(i) {
        activeIdx = i;
        renderPanel(control.value);
    }

    // 聚焦全选文本：输入即整体替换、顺手全量过滤，而不是在已选 label 后面追加
    control.addEventListener('focus', () => { control.select(); open(); });
    control.addEventListener('input', () => {
        activeIdx = -1;
        if (!isOpen()) open();
        renderPanel(control.value);
        placePanel();
    });
    control.addEventListener('keydown', /** @param {KeyboardEvent} e */ (e) => {
        if (e.key === 'Escape') return; // Esc 归 overlay-stack 按层序关面板
        if (e.key === 'Tab') { close(); return; } // Tab 走人：面板跟着收，别悬在 body 上
        if (!isOpen()) {
            if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); open(); }
            return;
        }
        if (!shown.length) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive(Math.min(activeIdx + 1, shown.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive(Math.max(activeIdx - 1, 0));
        } else if (e.key === 'Enter' && activeIdx >= 0) {
            e.preventDefault();
            select(shown[activeIdx]);
        }
    });

    element.append(built.element, caret);
    return {
        element,
        control,
        get value() { return current; },
        /**
         * 收口面板。面板挂 body、不随宿主自动消失——宿主视图卸载前必须调用；
         * Tab 走人会自动收，漏调时下一次 Esc/外点分发也会借 isAlive 把死层剔除。
         */
        close,
        /**
         * 整体替换候选（列表重载场景）；已选值不在新列表里时保留 current，
         * 由调用方决定要不要清（与 AI 模型列表刷新的既有语义一致）。
         * 面板打开中替换会立即按当前输入重过滤。
         * @param {ComboItem[]} next
         */
        setItems(next) {
            items = Array.isArray(next) ? next.slice() : [];
            if (isOpen()) { activeIdx = -1; renderPanel(control.value); }
        },
    };
}
