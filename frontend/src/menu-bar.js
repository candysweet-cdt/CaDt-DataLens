// menu-bar.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// IDEA 新 UI 式主菜单：平时隐藏，点三横把工具栏左侧换成横排菜单条；Alt+字母直接唤出对应菜单
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。


export function createMenuBar(deps) {

const tbMenu = document.getElementById('tb-menu');
const menuBar = document.getElementById('menubar');
const toolbarEl = document.getElementById('toolbar');
const menuKeyMap = {KeyF: 'file', KeyE: 'edit', KeyO: 'format', KeyV: 'view', KeyU: 'tools', KeyT: 'theme', KeyH: 'help'};
let openMenuEl = null;

function showMenuBar() {
    toolbarEl.classList.add('menu-active');
    menuBar.classList.remove('hidden');
}

function hideMenuBar() {
    deps.closeAllMenus();
    toolbarEl.classList.remove('menu-active');
    menuBar.classList.add('hidden');
}

function openMenuByKind(kind) {
    const menuEl = menuBar.querySelector('.menu[data-menu="' + kind + '"]');
    if (menuEl) deps.openMenu(menuEl);
}

tbMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    showMenuBar();
});

function clickEditorButton(sel) {
    if (!deps.editor) return;
    const pane = deps.file && deps.file.pane ? deps.file.pane : deps.els.editor;
    const btn = pane.querySelector(sel);
    if (btn) btn.click();
}

function formatDocument() {
    if (!deps.editor || !deps.file) return;
    deps.flushCsvCellEditor();
    const doc = deps.file;
    if (deps.settings.readOnlyMode) {
        deps.flash('只读锁定中，解锁后才能格式化', true);
        return;
    }
    if (doc.large || doc.binary || (doc.format && doc.format.rawOnly)) {
        deps.flash('当前文件不支持格式化', true);
        return;
    }
    if (deps.currentMode === 'tree') {
        deps.flash('格式化请在代码视图或文本视图中使用');
        return;
    }
    const text = deps.editor.getText();
    let value;
    try {
        value = doc.format.parse(text);
    } catch (e) {
        deps.flash(doc.format.name + ' 无效，无法格式化：' + e.message, true);
        return;
    }
    let formatted;
    if (doc.format.id === 'json') {
        const indent = deps.getFormatSettings('json').indent;
        formatted = JSON.stringify(value, null, indent === 'tab' ? '\t' : Number(indent));
    } else {
        formatted = doc.format.stringify(value);
    }
    if (formatted === text) return;
    if (deps.currentMode === 'table') {
        if (!doc.tableUndo) doc.tableUndo = [];
        if (!doc.tableRedo) doc.tableRedo = [];
        doc.tableUndo.push({full: true, before: text, after: formatted});
        if (doc.tableUndo.length > 100) doc.tableUndo.shift();
        doc.tableRedo.length = 0;
    }
    doc.loading = true;
    try {
        if (deps.currentMode === 'code' && deps.editor.aceEditor) {
            const ace = deps.editor.aceEditor;
            ace.selectAll();
            ace.session.replace(ace.getSelectionRange(), formatted);
            ace.selection.moveTo(0, 0);
            ace.clearSelection();
        } else if (deps.currentMode === 'text') {
            const ta = deps.textArea();
            if (ta) {
                ta.focus();
                ta.select();
                let inserted = false;
                try {
                    inserted = document.execCommand('insertText', false, formatted);
                } catch (e) {}
                if (!inserted) {
                    ta.value = formatted;
                    ta.dispatchEvent(new Event('input', {bubbles: true}));
                }
                ta.setSelectionRange(0, 0);
            } else {
                deps.editor.setText(formatted);
            }
        } else {
            deps.editor.setText(formatted);
        }
    } catch (e) {
        deps.flash('格式化失败：' + e.message, true);
        return;
    } finally {
        doc.loading = false;
    }
    deps.markDocDirty(doc);
    deps.updateStatus();
    deps.activityLog.log('file.format', doc.path, {kind: 'format'});
    if (deps.currentMode === 'table') deps.renderCsvTableView(doc);
}


    return {clickEditorButton, formatDocument, hideMenuBar, menuBar, menuKeyMap, openMenuByKind, openMenuEl, showMenuBar};
}
