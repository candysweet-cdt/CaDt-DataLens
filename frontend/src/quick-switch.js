// quick-switch.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {iconSvg} from './icons.js';

export function createQuickSwitch(deps) {

const quickSwitch = {
    open: false,
    level: 'main',
    rows: [],
    index: 0,
    mainIndex: 0,
    previousFocus: null,
};

function quickSwitchTitleFor(level) {
    return ({
        main: '切换',
        theme: '主题',
        view: '视图模式',
        font: '编辑器字体',
        size: '字号',
        indent: '缩进',
        layout: '布局',
        openmode: '打开方式',
    })[level] || '切换';
}

function currentIndentLabel() {
    if (!deps.file || !deps.file.format) return '';
    const value = deps.getFormatSettings(deps.file.format.id).indent;
    const found = deps.INDENTS.find(([id]) => id === value);
    return found ? found[1] : value;
}

function quickSwitchMainItems() {
    const font = deps.editorFonts.find((f) => f.id === deps.settings.editorFontFamily);
    return [
        {label: '主题', value: deps.currentTheme().name, enter: 'theme'},
        {label: '视图模式', value: deps.file ? deps.viewLabel(deps.currentMode) : '未打开文件', enter: 'view', disabled: !deps.file},
        {label: '编辑器字体', value: font ? font.name : deps.settings.editorFontFamily, enter: 'font'},
        {label: '字号', value: deps.settings.editorFont + ' px', enter: 'size'},
        {label: '缩进', value: currentIndentLabel(), enter: 'indent', disabled: !deps.file || !deps.file.format},
        {label: '布局', enter: 'layout'},
        {label: '打开方式', value: deps.settings.openMode === 'window' ? '多窗口' : '单窗口标签页', enter: 'openmode'},
    ];
}

function quickSwitchSubItems(level) {
    if (level === 'theme') {
        const items = [];
        let prevGroup = '';
        for (const theme of deps.themes) {
            if (prevGroup && theme.group !== prevGroup) items.push({sep: true});
            items.push({label: theme.name, checked: deps.settings.theme === theme.id, action: () => deps.setTheme(theme.id)});
            prevGroup = theme.group;
        }
        return items;
    }
    if (level === 'view') {
        if (!deps.file) return [{label: '（未打开文件）', disabled: true}];
        const splitActive = !!deps.file.splitActive;
        return deps.viewOptionsFor(deps.file.format, deps.file).map(([mode, label]) => ({
            label,
            checked: mode === 'split' ? splitActive
                : (mode === 'sql' ? !!deps.file.sqlActive : (!splitActive && deps.currentMode === mode)),
            disabled: deps.viewDisabled(mode),
            action: () => deps.switchMode(mode),
        }));
    }
    if (level === 'font') {
        return deps.editorFonts.map((font) => ({
            label: font.name,
            checked: deps.settings.editorFontFamily === font.id,
            action: () => {
                deps.settings.editorFontFamily = font.id;
                deps.applySettings();
            },
        }));
    }
    if (level === 'size') {
        return [11, 12, 13, 14, 15, 16, 18, 20].map((size) => ({
            label: size + ' px',
            checked: Number(deps.settings.editorFont) === size,
            action: () => {
                deps.settings.editorFont = size;
                deps.applySettings();
            },
        }));
    }
    if (level === 'indent') {
        const formatId = deps.file && deps.file.format ? deps.file.format.id : '';
        if (!formatId) return [{label: '（未打开文件）', disabled: true}];
        const current = deps.getFormatSettings(formatId).indent;
        return deps.INDENTS.map(([id, label]) => ({
            label,
            checked: current === id,
            action: () => {
                deps.settings.formatSettings[formatId] = {...deps.getFormatSettings(formatId), indent: id};
                deps.applySettings();
                if (deps.currentMode === 'code' && deps.file && deps.file.format && deps.file.format.id === formatId &&
                    deps.file.editor && deps.file.editor.aceEditor) deps.applyAceMode(true);
            },
        }));
    }
    if (level === 'layout') {
        return [
            {label: '文件侧边栏', checked: !!deps.settings.showSidebar, action: () => deps.toggleSidebar()},
            {label: '文件列表', checked: !!deps.settings.showSidebar && deps.settings.sidebarMode === 'list', action: () => deps.setSidebarMode('list')},
            {label: '文件树', checked: !!deps.settings.showSidebar && deps.settings.sidebarMode === 'tree', action: () => deps.setSidebarMode('tree')},
            {label: '结构视图', checked: !!deps.settings.showSidebar && deps.currentSidebarView() === 'structure', action: () => deps.toggleSidebarView('structure')},
            {label: 'Git 面板', checked: !!deps.settings.showSidebar && deps.currentSidebarView() === 'git', action: () => deps.toggleSidebarView('git')},
            {label: '终端面板', checked: !!deps.terminalUI.open, action: () => deps.toggleTerminalPanel()},
            {label: '自动换行', checked: !!deps.settings.codeWrap, action: () => deps.toggleCodeWrap()},
            {label: '窗口置顶', checked: !!deps.settings.alwaysOnTop, action: () => deps.toggleAlwaysOnTop()},
        ];
    }
    if (level === 'openmode') {
        return [
            {
                label: '单窗口标签页',
                checked: deps.settings.openMode === 'tab',
                action: () => { deps.settings.openMode = 'tab'; deps.applySettings(); },
            },
            {
                label: '多窗口',
                checked: deps.settings.openMode === 'window',
                action: () => { deps.settings.openMode = 'window'; deps.applySettings(); },
            },
        ];
    }
    return [];
}

function updateQuickSwitchSelection() {
    let selected = null;
    for (let i = 0; i < quickSwitch.rows.length; i++) {
        const row = quickSwitch.rows[i].el;
        const on = i === quickSwitch.index;
        row.classList.toggle('selected', on);
        if (on) selected = row;
    }
    if (selected && selected.scrollIntoView) {
        try { selected.scrollIntoView({block: 'nearest'}); } catch (e) {}
    }
}

function renderQuickSwitch() {
    deps.els.quickSwitchTitle.textContent = quickSwitchTitleFor(quickSwitch.level);
    deps.els.quickSwitchBack.classList.toggle('hidden', quickSwitch.level === 'main');
    deps.els.quickSwitchList.textContent = '';
    quickSwitch.rows = [];
    const items = quickSwitch.level === 'main' ? quickSwitchMainItems() : quickSwitchSubItems(quickSwitch.level);
    let number = 0;
    for (const item of items) {
        if (item.sep) {
            const sep = document.createElement('div');
            sep.className = 'quick-switch-sep';
            deps.els.quickSwitchList.appendChild(sep);
            continue;
        }
        const idx = number++;
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'quick-switch-item' + (item.disabled ? ' disabled' : '') + (idx === quickSwitch.index ? ' selected' : '');
        const indexEl = document.createElement('span');
        indexEl.className = 'quick-switch-index';
        indexEl.textContent = idx < 9 ? String(idx + 1) : (idx === 9 ? '0' : '');
        const labelEl = document.createElement('span');
        labelEl.className = 'quick-switch-label';
        labelEl.textContent = item.label;
        el.append(indexEl, labelEl);
        if (item.value) {
            const valueEl = document.createElement('span');
            valueEl.className = 'quick-switch-value';
            valueEl.textContent = item.value;
            el.appendChild(valueEl);
        }
        if (item.checked) {
            const checkEl = document.createElement('span');
            checkEl.className = 'quick-switch-check';
            checkEl.innerHTML = iconSvg('check', 12);
            el.appendChild(checkEl);
        }
        el.addEventListener('mouseenter', () => {
            if (item.disabled || quickSwitch.index === idx) return;
            quickSwitch.index = idx;
            updateQuickSwitchSelection();
        });
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            activateQuickSwitch(idx);
        });
        deps.els.quickSwitchList.appendChild(el);
        quickSwitch.rows.push({item, el});
    }
    if (quickSwitch.index >= quickSwitch.rows.length) quickSwitch.index = Math.max(0, quickSwitch.rows.length - 1);
    updateQuickSwitchSelection();
}

function moveQuickSwitch(delta) {
    const total = quickSwitch.rows.length;
    if (!total) return;
    let next = quickSwitch.index;
    for (let step = 0; step < total; step++) {
        next = (next + delta + total) % total;
        if (!quickSwitch.rows[next].item.disabled) break;
    }
    quickSwitch.index = next;
    updateQuickSwitchSelection();
}

function activateQuickSwitch(index) {
    const row = quickSwitch.rows[index];
    if (!row || row.item.disabled) return;
    if (row.item.enter) {
        enterQuickSwitchLevel(row.item.enter);
        return;
    }
    if (row.item.action) {
        closeQuickSwitch();
        row.item.action();
    }
}

function enterQuickSwitchLevel(level) {
    if (level === 'main') {
        quickSwitch.level = 'main';
        quickSwitch.index = quickSwitch.mainIndex;
    } else {
        if ((level === 'view' && !deps.file) || (level === 'indent' && (!deps.file || !deps.file.format))) return;
        quickSwitch.mainIndex = quickSwitch.index;
        quickSwitch.level = level;
        const items = quickSwitchSubItems(level);
        let checked = 0;
        let number = 0;
        for (const item of items) {
            if (item.sep) continue;
            if (item.checked && !item.disabled) {
                checked = number;
                break;
            }
            number++;
        }
        quickSwitch.index = checked;
    }
    renderQuickSwitch();
    deps.els.quickSwitch.focus();
}

function openQuickSwitch() {
    if (quickSwitch.open || deps.isDialogOpen()) return;
    deps.closeAllMenus();
    quickSwitch.open = true;
    quickSwitch.level = 'main';
    quickSwitch.index = 0;
    quickSwitch.mainIndex = 0;
    const active = document.activeElement;
    quickSwitch.previousFocus = active &&
        !(active.closest && (active.closest('#tb-menu') || active.closest('#menubar') || active.closest('.ctx-menu'))) ? active : null;
    deps.els.quickSwitchMask.classList.remove('hidden');
    renderQuickSwitch();
    deps.els.quickSwitch.focus();
}

function closeQuickSwitch() {
    if (!quickSwitch.open) return;
    quickSwitch.open = false;
    deps.els.quickSwitchMask.classList.add('hidden');
    const previous = quickSwitch.previousFocus;
    quickSwitch.previousFocus = null;
    if (previous && previous.isConnected && typeof previous.focus === 'function' &&
        previous !== document.body && previous !== document.documentElement) {
        try {
            previous.focus();
            return;
        } catch (e) {}
    }
    deps.focusFindEditor();
}

function toggleQuickSwitch() {
    if (quickSwitch.open) closeQuickSwitch();
    else openQuickSwitch();
}

function handleQuickSwitchKey(e) {
    if (!quickSwitch.open) return false;
    if (e.key === 'Escape') {
        if (quickSwitch.level === 'main') closeQuickSwitch();
        else enterQuickSwitchLevel('main');
        return true;
    }
    if (e.key === 'ArrowDown') {
        moveQuickSwitch(1);
        return true;
    }
    if (e.key === 'ArrowUp') {
        moveQuickSwitch(-1);
        return true;
    }
    if (e.key === 'Enter') {
        activateQuickSwitch(quickSwitch.index);
        return true;
    }
    if ((e.key === 'ArrowLeft' || e.key === 'Backspace') && quickSwitch.level !== 'main') {
        enterQuickSwitchLevel('main');
        return true;
    }
    if (!e.ctrlKey && !e.altKey && !e.metaKey && /^[0-9]$/.test(e.key)) {
        const index = e.key === '0' ? 9 : Number(e.key) - 1;
        if (index < quickSwitch.rows.length) {
            activateQuickSwitch(index);
            return true;
        }
    }
    return false;
}

deps.els.quickSwitchMask.addEventListener('click', (e) => {
    if (e.target === deps.els.quickSwitchMask) closeQuickSwitch();
});
deps.els.quickSwitch.addEventListener('click', (e) => e.stopPropagation());
deps.els.quickSwitchBack.addEventListener('click', (e) => {
    e.stopPropagation();
    enterQuickSwitchLevel('main');
});


    return {handleQuickSwitchKey, openQuickSwitch, quickSwitch, toggleQuickSwitch};
}
