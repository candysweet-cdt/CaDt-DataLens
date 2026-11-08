import './style.css';
import {detectFormat, formats} from './formats.js';

const hasWails = !!(window.go && window.go.main && window.go.main.App);

const sampleJson = `{
  "name": "时空纪元",
  "version": "1.0.0",
  "enabled": true,
  "count": 42,
  "nothing": null,
  "tags": ["模组", "网易", "JSON"],
  "author": {"name": "CandySweet", "role": "owner"},
  "items": [{"id": "spacetime:cable", "count": 64}, {"id": "spacetime:machine", "count": 1}]
}`;

const sampleYaml = `name: 时空纪元
version: 1.0.0
enabled: true
tags:
  - 模组
  - 网易
author:
  name: CandySweet
  role: owner
`;

const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<mod name="时空纪元" version="1.0.0">
  <items>
    <item id="spacetime:cable" count="64"/>
    <item id="spacetime:machine" count="1"/>
  </items>
</mod>
`;

const sampleCsv = `id,name,count
spacetime:cable,线缆,64
spacetime:machine,机器,1
`;

const sampleText = `# 时空纪元 开发笔记

- 电缆：每格每日 4 件
- 机器：2.10+ 运行时配方
`;

const mockScenario = new URLSearchParams(location.search);
const mockDir = 'mock://samples/';
const mockHex = '// 图片文件：sample.png\n// 文件大小：16 字节，以十六进制字节数据只读展示\n\n' +
    '00000000  89 50 4e 47 0d 0a 1a 0a  00 00 00 0d 49 48 44 52  |.PNG........IHDR|\n';
const mockFiles = {
    yaml: {name: 'sample.yaml', content: sampleYaml},
    xml: {name: 'sample.xml', content: sampleXml},
    csv: {name: 'sample.csv', content: sampleCsv},
    text: {name: 'notes.md', content: sampleText},
    json: {name: 'sample.json', content: sampleJson},
};

const mockBackend = {
    async GetStartupFiles() {
        if (mockScenario.has('empty')) return [];
        if (mockScenario.has('gbk')) return [mockDir + 'sample-gbk.json'];
        if (mockScenario.has('image')) return [mockDir + 'sample.png'];
        if (mockScenario.has('large')) return [mockDir + 'large.json'];
        if (mockScenario.has('invalid')) return [mockDir + 'invalid.json'];
        for (const key of ['yaml', 'xml', 'csv', 'text']) {
            if (mockScenario.has(key)) return [mockDir + mockFiles[key].name];
        }
        return [mockDir + 'sample.json'];
    },
    async OpenFile(path, enc) {
        window.__mockLastOpenEnc = enc;
        const base = path.split('/').pop();
        if (base.toLowerCase().endsWith('.png')) {
            return {path, name: base, content: mockHex, size: 16, eol: 'lf', hasBom: false, large: false, enc: 'binary', binary: true};
        }
        const fileEnc = path.includes('gbk') ? 'gbk' : 'utf-8';
        const key = Object.keys(mockFiles).find(k => mockFiles[k].name === base) || 'json';
        let content = mockFiles[key].content;
        let large = false;
        if (path.includes('large')) large = true;
        if (path.includes('invalid')) content = '{ "broken": [1, 2, ';
        return {
            path, name: base, content,
            size: content.length, eol: 'lf', hasBom: false, large, enc: fileEnc,
        };
    },
    async OpenFilesDialog() {
        if (mockScenario.has('multi')) return [mockDir + 'sample.json', mockDir + 'sample.yaml'];
        return [mockDir + 'sample.json'];
    },
    async SaveFileDialog(name) { return 'mock://' + (window.__mockSaveDialogName || name); },
    async SaveFile(path, content, eol, hasBom, enc) {
        window.__mockLastSaveEnc = enc;
        window.__mockLastSavePath = path;
        window.__mockSaves = (window.__mockSaves || []).concat([{path, content, eol, hasBom, enc}]);
        localStorage.setItem('datalens-mock-save', content);
        console.info('[mock] SaveFile', path, content.length, 'chars', enc);
    },
    async SetDirty(flag) { console.info('[mock] SetDirty', flag); },
    async SetWindowBg(r, g, b) { window.__mockWindowBg = [r, g, b]; },
    async GetOpenMode() {
        if (!window.__mockOpenMode) window.__mockOpenMode = 'tab';
        return window.__mockOpenMode;
    },
    async SetOpenMode(mode) { window.__mockOpenMode = mode; },
    async OpenInNewWindows(paths) { window.__mockNewWindows = (window.__mockNewWindows || []).concat([paths]); },
    async OpenNewWindow() { window.__mockNewWindow = (window.__mockNewWindow || 0) + 1; },
    async ShowInFolder(path) { window.__mockShowInFolder = path; },
    async CopyText(text) { window.__mockCopied = text; },
    async ForceClose() { window.__mockForceClosed = (window.__mockForceClosed || 0) + 1; },
    async CheckEncoding(content, enc) {
        if (enc === 'utf-8' || enc === 'gbk' || enc === 'gb18030') return true;
        if (enc === 'us-ascii') return !/[^\x00-\x7f]/.test(content);
        if (enc === 'iso-8859-1') return !/[^\x00-\xff]/.test(content);
        return true;
    },
};

const backend = hasWails ? window.go.main.App : mockBackend;


const mockRt = {
    _max: false,
    _calls: [],
    async WindowIsMaximised() { return this._max; },
    WindowToggleMaximise() { this._max = !this._max; this._calls.push('toggle:' + this._max); },
    WindowMinimise() { this._calls.push('min'); },
    WindowUnminimise() { this._calls.push('unmin'); },
    WindowClose() { this._calls.push('close'); },
    Quit() { this._calls.push('quit'); },
    WindowSetTitle(title) { this._title = title; this._calls.push('title:' + title); },
    EventsOn() {},
};
const rt = window.runtime || (mockScenario.has('winctl') ? mockRt : null);

const els = {
    filename: document.getElementById('filename'),
    banner: document.getElementById('banner'),
    editor: document.getElementById('editor'),
    welcome: document.getElementById('welcome'),
    btnWelcomeOpen: document.getElementById('btn-welcome-open'),
    stMode: document.getElementById('st-mode'),
    stSize: document.getElementById('st-size'),
    stEol: document.getElementById('st-eol'),
    stEnc: document.getElementById('st-enc'),
    stMessage: document.getElementById('st-message'),
    stDirty: document.getElementById('st-dirty'),
    breadcrumb: document.getElementById('breadcrumb'),
    searchInput: document.getElementById('search-input'),
    tabbar: document.getElementById('tabbar'),
};

let editor = null;
let file = null;
let docs = [];
let docSeq = 0;
let autoSaveTimer = 0;
window.__lens = {
    get editor() { return editor; },
    get file() { return file; },
    get docs() { return docs; },
    openCloseConfirm,
    openPaths,
    setTheme,
};
let dirty = false;
let currentMode = 'tree';
let flashTimer = 0;

const settingsKey = 'datalens-settings';
const themes = [
    {id: 'dark', name: '深色', group: 'base', bg: '#1e1f24', accent: '#4f8cff'},
    {id: 'light', name: '浅色', group: 'base', bg: '#ffffff', accent: '#2f6fd0'},
    {id: 'darcula', name: 'Darcula', group: 'idea', bg: '#2b2b2b', accent: '#548af7'},
    {id: 'idea-dark', name: 'IDEA Dark', group: 'idea', bg: '#1e1f22', accent: '#548af7'},
    {id: 'idea-light', name: 'IDEA Light', group: 'idea', bg: '#ffffff', accent: '#3574f0'},
    {id: 'github', name: 'Github', group: 'classic', bg: '#ffffff', accent: '#0969da'},
    {id: 'newsprint', name: 'Newsprint', group: 'classic', bg: '#f7f2e7', accent: '#8a4b2f'},
    {id: 'night', name: 'Night', group: 'classic', bg: '#16181f', accent: '#7aa2f7'},
    {id: 'pixyll', name: 'Pixyll', group: 'classic', bg: '#fdfbf7', accent: '#c24266'},
    {id: 'whitey', name: 'Whitey', group: 'classic', bg: '#ffffff', accent: '#2b6cb0'},
];
const themeIds = new Set(themes.map((t) => t.id));
const uiFonts = [
    {id: 'inter', name: 'Inter', family: '"Inter"'},
    {id: 'system', name: 'Segoe UI', family: '"Segoe UI"'},
];
const editorFonts = [
    {id: 'jetbrains', name: 'JetBrains Mono', family: '"JetBrains Mono"'},
    {id: 'fira', name: 'Fira Code', family: '"Fira Code"'},
    {id: 'consolas', name: 'Consolas', family: 'Consolas'},
    {id: 'cascadia', name: 'Cascadia Code', family: '"Cascadia Code"'},
    {id: 'system', name: '系统等宽', family: 'Consolas, "Courier New"'},
];
const cjkFonts = [
    {id: 'auto', name: '跟随设置', family: '"Microsoft YaHei UI", "微软雅黑"'},
    {id: 'dengxian', name: '等线', family: '"DengXian", "等线"'},
    {id: 'simsun', name: '宋体', family: '"SimSun", "宋体"'},
    {id: 'simhei', name: '黑体', family: '"SimHei", "黑体"'},
    {id: 'kaiti', name: '楷体', family: '"KaiTi", "楷体"'},
    {id: 'fangsong', name: '仿宋', family: '"FangSong", "仿宋"'},
    {id: 'jhenghei', name: '微软正黑体', family: '"Microsoft JhengHei UI", "Microsoft JhengHei", "微软正黑体"'},
];
const formatDefs = [
    {id: 'json', name: 'JSON'},
    {id: 'yaml', name: 'YAML'},
    {id: 'xml', name: 'XML'},
    {id: 'csv', name: 'CSV'},
    {id: 'text', name: '纯文本'},
];
function defaultFormatSettings() {
    return Object.fromEntries(formatDefs.map((f) => [f.id, {
        encoding: 'auto',
        indent: '2',
        eol: 'follow',
        view: f.id === 'text' ? 'code' : 'tree',
    }]));
}
const defaultSettings = {
    fixedKeys: true,
    autoSave: false,
    openMode: 'tab',
    keyWidth: 160,
    editorFont: 13,
    theme: 'dark',
    uiFont: 'inter',
    uiCjkFont: 'auto',
    editorFontFamily: 'jetbrains',
    editorCjkFont: 'auto',
    formatSettings: defaultFormatSettings(),
};
let settings = JSON.parse(JSON.stringify(defaultSettings));
try {
    const stored = JSON.parse(localStorage.getItem(settingsKey) || '{}');
    settings = {...settings, ...stored};
    settings.formatSettings = {...defaultFormatSettings(), ...(stored.formatSettings || {})};
    for (const f of formatDefs) {
        settings.formatSettings[f.id] = {...defaultFormatSettings()[f.id], ...(settings.formatSettings[f.id] || {})};
    }
} catch (e) {}
if (!themeIds.has(settings.theme)) settings.theme = 'dark';
if (!uiFonts.some((f) => f.id === settings.uiFont)) settings.uiFont = 'inter';
if (!editorFonts.some((f) => f.id === settings.editorFontFamily)) settings.editorFontFamily = 'jetbrains';
if (!cjkFonts.some((f) => f.id === settings.uiCjkFont)) settings.uiCjkFont = 'auto';
if (!cjkFonts.some((f) => f.id === settings.editorCjkFont)) settings.editorCjkFont = 'auto';
settings.autoSave = !!settings.autoSave;
if (settings.openMode !== 'window') settings.openMode = 'tab';

function getFormatSettings(id) {
    return settings.formatSettings[id] || defaultFormatSettings()[id] || {encoding: 'auto', indent: '2', eol: 'follow', view: 'tree'};
}

const elsSettings = {
    fixed: document.getElementById('opt-fixed-keys'),
    width: document.getElementById('opt-key-width'),
    widthVal: document.getElementById('opt-key-width-val'),
    font: document.getElementById('opt-font-size'),
    fontVal: document.getElementById('opt-font-size-val'),
    autoSave: document.getElementById('opt-auto-save'),
    openMode: document.getElementById('opt-open-mode'),
    uiFont: document.getElementById('opt-ui-font'),
    uiCjkFont: document.getElementById('opt-ui-cjk-font'),
    editorFontFamily: document.getElementById('opt-editor-font'),
    editorCjkFont: document.getElementById('opt-editor-cjk-font'),
};

function fillFontSelect(select, list) {
    select.textContent = '';
    for (const face of list) {
        const opt = document.createElement('option');
        opt.value = face.id;
        opt.textContent = face.name;
        select.appendChild(opt);
    }
}
fillFontSelect(elsSettings.uiFont, uiFonts);
fillFontSelect(elsSettings.uiCjkFont, cjkFonts);
fillFontSelect(elsSettings.editorFontFamily, editorFonts);
fillFontSelect(elsSettings.editorCjkFont, cjkFonts);

const elsDialogs = {
    mask: document.getElementById('dialog-mask'),
    settings: document.getElementById('dlg-settings'),
    confirm: document.getElementById('dlg-confirm'),
    confirmText: document.getElementById('dlg-confirm-text'),
    confirmOk: document.getElementById('btn-discard'),
};

let syncedOpenMode = null;
function syncOpenMode() {
    if (syncedOpenMode === null) {
        syncedOpenMode = settings.openMode;
        return;
    }
    if (syncedOpenMode === settings.openMode) return;
    syncedOpenMode = settings.openMode;
    if (backend && backend.SetOpenMode) {
        try {
            backend.SetOpenMode(settings.openMode);
        } catch (e) {}
    }
}

let appliedTheme = '';
function currentTheme() {
    return themes.find((t) => t.id === settings.theme) || themes[0];
}

function applyTheme() {
    if (appliedTheme === settings.theme) return;
    const theme = currentTheme();
    document.documentElement.dataset.theme = theme.id;
    appliedTheme = theme.id;
    if (backend && backend.SetWindowBg) {
        const n = parseInt(theme.bg.slice(1), 16);
        try {
            backend.SetWindowBg((n >> 16) & 255, (n >> 8) & 255, n & 255);
        } catch (e) {}
    }
}

function setTheme(id) {
    if (!themeIds.has(id)) return;
    settings.theme = id;
    applySettings();
    flash('主题：' + currentTheme().name);
}

function applySettings() {
    document.documentElement.classList.toggle('keycol-natural', !settings.fixedKeys);
    applyTheme();
    document.documentElement.style.setProperty('--key-col-w', settings.keyWidth + 'px');
    elsSettings.fixed.checked = settings.fixedKeys;
    elsSettings.width.value = String(settings.keyWidth);
    elsSettings.width.disabled = !settings.fixedKeys;
    elsSettings.widthVal.textContent = String(settings.keyWidth);
    elsSettings.font.value = String(settings.editorFont);
    elsSettings.fontVal.textContent = String(settings.editorFont);
    elsSettings.autoSave.checked = !!settings.autoSave;
    elsSettings.openMode.value = settings.openMode;
    syncOpenMode();
    document.documentElement.style.setProperty('--editor-font', settings.editorFont + 'px');
    const uiFace = uiFonts.find((f) => f.id === settings.uiFont) || uiFonts[0];
    const editorFace = editorFonts.find((f) => f.id === settings.editorFontFamily) || editorFonts[0];
    const uiCjk = cjkFonts.find((f) => f.id === settings.uiCjkFont) || cjkFonts[0];
    const editorCjk = cjkFonts.find((f) => f.id === settings.editorCjkFont) || cjkFonts[0];
    document.documentElement.style.setProperty('--ui-font', uiFace.family + ', ' + uiCjk.family + ', sans-serif');
    document.documentElement.style.setProperty('--editor-font-family', editorFace.family + ', ' + editorCjk.family + ', monospace');
    elsSettings.uiFont.value = uiFace.id;
    elsSettings.uiCjkFont.value = uiCjk.id;
    elsSettings.editorFontFamily.value = editorFace.id;
    elsSettings.editorCjkFont.value = editorCjk.id;
    if (editor && editor.aceEditor) {
        try {
            editor.aceEditor.setFontSize(settings.editorFont);
        } catch (e) {}
    }
    try {
        localStorage.setItem(settingsKey, JSON.stringify(settings));
    } catch (e) {}
    if (settings.autoSave && dirty) scheduleAutoSave();
    else if (!settings.autoSave) cancelAutoSave();
}

function openDialogEl(dlg) {
    elsDialogs.mask.classList.remove('hidden');
    elsDialogs.settings.classList.add('hidden');
    elsDialogs.confirm.classList.add('hidden');
    dlg.style.left = '';
    dlg.style.top = '';
    dlg.style.transform = '';
    dlg.classList.remove('hidden');
}

function closeDialogs() {
    elsDialogs.mask.classList.add('hidden');
    elsDialogs.settings.classList.add('hidden');
    elsDialogs.confirm.classList.add('hidden');
    confirmAction = null;
}

function selectSettingsPane(pane) {
    document.querySelectorAll('.snav-item').forEach((b) => b.classList.toggle('active', b.dataset.pane === pane));
    document.querySelectorAll('.settings-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== pane));
}

function openSettings(pane = 'general') {
    openDialogEl(elsDialogs.settings);
    selectSettingsPane(pane);
    if (pane === 'formats') renderFmtTable();
}

function openAbout() {
    openSettings('about');
}

let confirmAction = null;
function openCloseConfirm(message, action, okLabel) {
    elsDialogs.confirmText.textContent = message || '有未保存的修改，关闭后将丢弃。';
    elsDialogs.confirmOk.textContent = okLabel || '丢弃并关闭';
    confirmAction = action || (() => {
        if (backend.ForceClose) backend.ForceClose();
    });
    openDialogEl(elsDialogs.confirm);
}

document.getElementById('btn-discard').addEventListener('click', () => {
    const action = confirmAction;
    confirmAction = null;
    closeDialogs();
    if (action) action();
});
document.getElementById('btn-cancel-close').addEventListener('click', closeDialogs);

let dialogDrag = null;
function startDialogDrag(e) {
    if (e.target.closest('.dialog-close')) return;
    const dlg = e.currentTarget.parentElement;
    const r = dlg.getBoundingClientRect();
    dialogDrag = {el: dlg, dx: e.clientX - r.left, dy: e.clientY - r.top};
    dlg.style.left = r.left + 'px';
    dlg.style.top = r.top + 'px';
    dlg.style.transform = 'none';
    e.preventDefault();
}
window.addEventListener('mousemove', (e) => {
    if (!dialogDrag) return;
    dialogDrag.el.style.left = (e.clientX - dialogDrag.dx) + 'px';
    dialogDrag.el.style.top = (e.clientY - dialogDrag.dy) + 'px';
});
window.addEventListener('mouseup', () => {
    dialogDrag = null;
});
document.querySelectorAll('.dialog-head').forEach((head) => head.addEventListener('mousedown', startDialogDrag));
document.querySelectorAll('.dialog-close').forEach((btn) => btn.addEventListener('click', closeDialogs));
elsDialogs.mask.addEventListener('click', (e) => {
    if (e.target === elsDialogs.mask) closeDialogs();
});

document.querySelectorAll('.snav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
        selectSettingsPane(btn.dataset.pane);
        if (btn.dataset.pane === 'formats') renderFmtTable();
    });
});

const ENCODINGS = [['auto', '自动'], ['utf-8', 'UTF-8'], ['gbk', 'GBK'], ['gb18030', 'GB18030'], ['iso-8859-1', 'ISO-8859-1'], ['us-ascii', 'US-ASCII']];
const CONVERT_ENCODINGS = [['utf-8', 'UTF-8'], ['gbk', 'GBK'], ['gb18030', 'GB18030'], ['iso-8859-1', 'ISO-8859-1'], ['us-ascii', 'US-ASCII']];
const INDENTS = [['2', '2 空格'], ['4', '4 空格'], ['tab', 'Tab']];
const EOLS = [['follow', '跟随原文件'], ['lf', 'LF'], ['crlf', 'CRLF']];
const VIEWS = [['tree', '树视图'], ['code', '代码视图'], ['text', '文本视图']];

function makeSelect(options, value, onChange) {
    const sel = document.createElement('select');
    for (const [v, label] of options) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = label;
        if (v === value) opt.selected = true;
        sel.appendChild(opt);
    }
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
}

const footPopover = document.getElementById('enc-popover');
const FOOT_WIDGETS = {encoding: els.stEnc, view: els.stMode, eol: els.stEol};
let footPopoverKind = null;
const CHECK_ICON = String.fromCharCode(0xE73E);
const WARN_ICON = String.fromCharCode(0xE7BA);

function closeFootPopover() {
    footPopover.classList.add('hidden');
    Object.values(FOOT_WIDGETS).forEach((el) => el && el.classList.remove('active'));
    footPopoverKind = null;
}

function popTitle(text) {
    const t = document.createElement('div');
    t.className = 'enc-title';
    t.textContent = text;
    return t;
}

function popSep() {
    const s = document.createElement('div');
    s.className = 'enc-sep';
    return s;
}

function popFoot(prefix, value) {
    const foot = document.createElement('div');
    foot.className = 'enc-foot';
    foot.textContent = prefix + ': ';
    const b = document.createElement('b');
    b.textContent = value;
    foot.appendChild(b);
    return foot;
}

function popItem(label, opts = {}) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'enc-item' + (opts.current ? ' current' : '');
    const ic = document.createElement('span');
    ic.className = 'enc-ic' + (opts.current ? ' cur' : (opts.iconClass ? ' ' + opts.iconClass : ''));
    ic.textContent = opts.icon || (opts.current ? CHECK_ICON : '');
    const text = document.createElement('span');
    text.textContent = label;
    row.append(ic, text);
    if (opts.disabled) {
        row.disabled = true;
        row.style.opacity = '0.4';
        row.title = opts.disabledTitle || '';
    } else if (opts.onClick) {
        row.addEventListener('click', opts.onClick);
    }
    return row;
}

function toggleBom() {
    if (!file) return;
    file.hasBom = !file.hasBom;
    setDirty(true);
    updateStatus();
    if (footPopoverKind === 'encoding') {
        footPopover.textContent = '';
        renderEncodingMenu();
    }
}

function convertEncoding(enc) {
    if (!file) return;
    if ((file.enc || 'utf-8') === enc) {
        closeFootPopover();
        return;
    }
    file.enc = enc;
    if (enc !== 'utf-8') file.hasBom = false;
    setDirty(true);
    updateStatus();
    flash('编码已转换为 ' + enc.toUpperCase());
    closeFootPopover();
}

async function renderEncodingMenu() {
    const current = file.enc || 'utf-8';
    footPopover.appendChild(popTitle('文件编码'));
    footPopover.appendChild(popItem(
        current === 'utf-8' ? (file.hasBom ? '移除 BOM' : '添加 BOM') : '添加 BOM（仅 UTF-8）',
        {disabled: current !== 'utf-8', disabledTitle: '仅 UTF-8 支持 BOM', onClick: toggleBom}
    ));
    footPopover.appendChild(popSep());
    const rows = [];
    for (const [enc, label] of CONVERT_ENCODINGS) {
        const row = popItem(label, {current: enc === current, onClick: () => convertEncoding(enc)});
        footPopover.appendChild(row);
        if (enc !== current) rows.push({enc, ic: row.querySelector('.enc-ic')});
    }
    footPopover.appendChild(popFoot('文件编码', current.toUpperCase() + (file.hasBom && current === 'utf-8' ? ' BOM' : '')));
    for (const {enc, ic} of rows) {
        try {
            const ok = await backend.CheckEncoding(file.content || '', enc);
            ic.textContent = ok ? CHECK_ICON : WARN_ICON;
            ic.className = 'enc-ic ' + (ok ? 'ok' : 'warn');
            ic.title = ok ? '可无损表示当前内容' : '包含无法表示的字符，转换后可能丢失';
        } catch (e) {}
    }
}

function renderViewMenu() {
    const treeAvailable = !!file.treeAvailable;
    footPopover.appendChild(popTitle('视图'));
    footPopover.appendChild(popItem('树视图', {
        current: currentMode === 'tree',
        disabled: !treeAvailable,
        disabledTitle: '当前文件只支持代码视图',
        onClick: () => { switchMode('tree'); closeFootPopover(); },
    }));
    footPopover.appendChild(popItem('代码视图', {
        current: currentMode === 'code',
        onClick: () => { switchMode('code'); closeFootPopover(); },
    }));
    footPopover.appendChild(popItem('文本视图', {
        current: currentMode === 'text',
        disabled: !treeAvailable,
        disabledTitle: '当前文件只支持代码视图',
        onClick: () => { switchMode('text'); closeFootPopover(); },
    }));
    const label = currentMode === 'tree' ? '树视图' : currentMode === 'text' ? '文本视图' : '代码视图';
    footPopover.appendChild(popFoot('当前', label));
}

function chooseEol(value) {
    if (!file) return;
    const fs = getFormatSettings(file.format.id);
    if (fs.eol === value) {
        closeFootPopover();
        return;
    }
    const before = fs.eol === 'follow' ? file.eol : fs.eol;
    fs.eol = value;
    applySettings();
    const after = value === 'follow' ? file.eol : value;
    if (after !== before) setDirty(true);
    updateStatus();
    flash('保存换行: ' + (value === 'follow' ? '跟随原文件' : value.toUpperCase()));
    closeFootPopover();
}

function renderEolMenu() {
    const fs = getFormatSettings(file.format.id);
    const eff = fs.eol === 'follow' ? file.eol : fs.eol;
    footPopover.appendChild(popTitle('换行符'));
    for (const [value, label] of EOLS) {
        footPopover.appendChild(popItem(label, {
            current: fs.eol === value,
            onClick: () => chooseEol(value),
        }));
    }
    footPopover.appendChild(popFoot('当前', eff.toUpperCase()));
}

function openFootPopover(kind) {
    if (!file) return;
    const anchor = FOOT_WIDGETS[kind];
    if (!anchor) return;
    footPopover.textContent = '';
    footPopover.classList.remove('hidden');
    if (kind === 'encoding') renderEncodingMenu();
    else if (kind === 'view') renderViewMenu();
    else renderEolMenu();
    const r = anchor.getBoundingClientRect();
    const pr = footPopover.getBoundingClientRect();
    footPopover.style.left = Math.max(8, Math.round(r.right - pr.width)) + 'px';
    footPopover.style.top = Math.round(r.top - pr.height - 6) + 'px';
    Object.values(FOOT_WIDGETS).forEach((el) => el && el.classList.remove('active'));
    anchor.classList.add('active');
    footPopoverKind = kind;
}

function toggleFootPopover(kind) {
    if (footPopoverKind === kind && !footPopover.classList.contains('hidden')) closeFootPopover();
    else openFootPopover(kind);
}

Object.entries(FOOT_WIDGETS).forEach(([kind, el]) => {
    if (!el) return;
    el.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFootPopover(kind);
    });
});
footPopover.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.closest && (t.closest('#enc-popover') || t.closest('#statusbar'))) return;
    closeFootPopover();
}, true);
window.addEventListener('blur', () => closeFootPopover());

function renderFmtTable() {
    const table = document.getElementById('fmt-table');
    table.textContent = '';
    const head = document.createElement('div');
    head.className = 'fmt-row fmt-head';
    for (const label of ['格式', '编码', '缩进', '保存换行', '默认视图']) {
        const cell = document.createElement('span');
        cell.textContent = label;
        head.appendChild(cell);
    }
    table.appendChild(head);
    for (const f of formatDefs) {
        const fs = getFormatSettings(f.id);
        const row = document.createElement('div');
        row.className = 'fmt-row';
        const name = document.createElement('span');
        name.textContent = f.name;
        row.appendChild(name);
        const update = (key) => (value) => {
            settings.formatSettings[f.id][key] = value;
            applySettings();
        };
        row.appendChild(makeSelect(ENCODINGS, fs.encoding, update('encoding')));
        row.appendChild(makeSelect(INDENTS, fs.indent, update('indent')));
        row.appendChild(makeSelect(EOLS, fs.eol, update('eol')));
        const viewSel = makeSelect(VIEWS, fs.view, (value) => {
            settings.formatSettings[f.id].view = value;
            applySettings();
            if (file && file.format.id === f.id) switchMode(value);
        });
        if (f.id === 'text') viewSel.disabled = true;
        row.appendChild(viewSel);
        table.appendChild(row);
    }
}

function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function flash(msg, isError) {
    els.stMessage.textContent = msg;
    els.stMessage.classList.toggle('error', !!isError);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { els.stMessage.textContent = ''; }, 5000);
}

function updateWindowTitle() {
    const title = file ? file.name + ' - CaDt-DataLens' : 'CaDt-DataLens';
    document.title = title;
    if (rt && rt.WindowSetTitle) {
        try {
            rt.WindowSetTitle(title);
        } catch (e) {}
    }
}

function anyDirty() {
    return docs.some((d) => d.dirty);
}

function updateBackendDirty() {
    backend.SetDirty(anyDirty());
}

function setDirty(flag) {
    dirty = flag;
    if (file) file.dirty = flag;
    updateBackendDirty();
    els.stDirty.textContent = flag ? '未保存' : '';
    els.filename.classList.toggle('dirty', flag);
    if (file) updateTabDirty(file);
    updateWindowTitle();
    if (flag) scheduleAutoSave();
    else cancelAutoSave();
}

const autoSaveDelay = 1000;

function cancelAutoSave() {
    if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = 0;
    }
}

function scheduleAutoSave() {
    cancelAutoSave();
    if (!settings.autoSave || !dirty || !file || file.large || file.binary || !file.path || !editor) return;
    autoSaveTimer = setTimeout(() => {
        autoSaveTimer = 0;
        if (dirty && file && settings.autoSave) save({auto: true});
    }, autoSaveDelay);
}

function updateTabDirty(doc) {
    const el = els.tabbar.querySelector('.tab[data-doc-id="' + doc.id + '"]');
    if (el) el.classList.toggle('dirty', !!doc.dirty);
}

function renderTabs() {
    els.tabbar.textContent = '';
    const hide = docs.length === 0 || (settings.openMode === 'window' && docs.length === 1);
    els.tabbar.classList.toggle('hidden', hide);
    for (const doc of docs) {
        const tab = document.createElement('div');
        tab.className = 'tab' + (doc === file ? ' active' : '') + (doc.dirty ? ' dirty' : '');
        tab.dataset.docId = String(doc.id);
        tab.title = doc.path || doc.name;
        const dot = document.createElement('span');
        dot.className = 'tab-dot';
        const name = document.createElement('span');
        name.className = 'tab-name';
        name.textContent = doc.name;
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'tab-close';
        close.title = '关闭';
        close.textContent = '\uE8BB';
        close.addEventListener('click', (e) => {
            e.stopPropagation();
            requestCloseDoc(doc);
        });
        tab.addEventListener('click', () => activateDoc(doc));
        tab.addEventListener('auxclick', (e) => {
            if (e.button === 1) {
                e.preventDefault();
                requestCloseDoc(doc);
            }
        });
        tab.append(dot, name, close);
        els.tabbar.appendChild(tab);
        if (doc === file) tab.scrollIntoView({block: 'nearest', inline: 'nearest'});
    }
}

function renderBreadcrumb(path) {
    els.breadcrumb.textContent = '';
    if (!path) return;
    const parts = String(path).split(/[\\/]+/).filter(Boolean);
    let display = parts;
    if (parts.length > 6) {
        display = [parts[0], '…', ...parts.slice(-4)];
    }
    display.forEach((seg, i) => {
        if (i > 0) {
            const sep = document.createElement('span');
            sep.className = 'crumb-sep';
            sep.textContent = '▸';
            els.breadcrumb.appendChild(sep);
        }
        const s = document.createElement('span');
        s.className = 'crumb' + (i === display.length - 1 ? ' crumb-last' : '');
        s.textContent = seg;
        s.title = seg;
        els.breadcrumb.appendChild(s);
    });
}

function treeHistory(action) {
    if (!editor || !editor.dom) return;
    const active = document.activeElement;
    if (active && els.editor.contains(active) && active.blur) active.blur();
    const btn = editor.dom[action];
    if (btn && !btn.disabled) btn.click();
}

function textArea() {
    if (!editor) return null;
    if (editor.textarea) return editor.textarea;
    const pane = file && file.pane ? file.pane : els.editor;
    return pane.querySelector('textarea.jsoneditor-text');
}

function doUndo() {
    if (!editor) return;
    if (currentMode === 'tree') treeHistory('undo');
    else if (currentMode === 'code' && editor.aceEditor) editor.aceEditor.execCommand('undo');
    else if (currentMode === 'text') {
        const ta = textArea();
        if (ta) {
            ta.focus();
            document.execCommand('undo');
        }
    }
}

function doRedo() {
    if (!editor) return;
    if (currentMode === 'tree') treeHistory('redo');
    else if (currentMode === 'code' && editor.aceEditor) editor.aceEditor.execCommand('redo');
    else if (currentMode === 'text') {
        const ta = textArea();
        if (ta) {
            ta.focus();
            document.execCommand('redo');
        }
    }
}

function toggleFocusedNode(action) {
    const active = document.activeElement;
    if (!active || !els.editor.contains(active)) return;
    const tr = active.closest('tr');
    if (!tr) return;
    const btn = tr.querySelector('button.jsoneditor-collapsed, button.jsoneditor-expanded');
    if (!btn) return;
    const collapsed = btn.classList.contains('jsoneditor-collapsed');
    if (action === 'expand' && collapsed) btn.click();
    if (action === 'collapse' && !collapsed) btn.click();
}

function updateStatus() {
    if (!file) return;
    const fmt = file.format;
    const view = currentMode === 'tree' ? '树视图' : currentMode === 'text' ? '文本视图' : '代码视图';
    els.stMode.textContent = fmt.name + ' · ' + view + (file.large || file.binary ? ' · 只读' : '');
    els.stSize.textContent = fmtSize(file.size);
    if (file.binary) {
        els.stEol.textContent = '';
        els.stEnc.textContent = '';
        els.stEol.style.display = 'none';
        els.stEnc.style.display = 'none';
        return;
    }
    els.stEol.style.display = '';
    els.stEnc.style.display = '';
    const eolSetting = fmt ? getFormatSettings(fmt.id).eol : 'follow';
    els.stEol.textContent = (eolSetting === 'follow' ? file.eol : eolSetting).toUpperCase();
    const enc = (file.enc || 'utf-8').toUpperCase();
    els.stEnc.textContent = enc + (file.hasBom && enc === 'UTF-8' ? ' BOM' : '');
}

function showBanner(data, parseError) {
    if (data.binary) {
        els.banner.textContent = '图片等二进制文件：以十六进制字节数据只读展示。';
        els.banner.classList.remove('hidden');
    } else if (data.large) {
        els.banner.textContent = '大文件（' + fmtSize(data.size) + '）：已切换为只读代码模式，不可编辑保存。';
        els.banner.classList.remove('hidden');
    } else if (parseError) {
        els.banner.textContent = data.format.name + ' 解析失败：' + parseError.message + '。已用代码模式打开，可手动修复后保存。';
        els.banner.classList.remove('hidden');
    } else {
        els.banner.classList.add('hidden');
    }
}

function humanizeCounts() {
    if (!editor) return;
    const root = file && file.pane ? file.pane : els.editor;
    const nodes = root.querySelectorAll('div.jsoneditor-value.jsoneditor-object, div.jsoneditor-value.jsoneditor-array');
    nodes.forEach((el) => {
        const m = el.textContent.trim().match(/^[[{]\s*(\d+)\s*[\]}]$/);
        if (!m) return;
        const n = Number(m[1]);
        el.textContent = n + ' 项';
        el.title = (el.classList.contains('jsoneditor-object') ? '对象' : '数组') + '，共 ' + n + ' 项';
    });
}

let countRaf = 0;
const countObserver = new MutationObserver(() => {
    if (countRaf) return;
    countRaf = requestAnimationFrame(() => {
        countRaf = 0;
        humanizeCounts();
    });
});
countObserver.observe(els.editor, {childList: true, subtree: true, characterData: true});

function applyAceMode() {
    if (currentMode !== 'code' || !editor || !editor.aceEditor) return;
    const want = file && file.format && file.format.aceMode === 'json' ? 'ace/mode/json' : 'ace/mode/text';
    try {
        if (editor.aceEditor.session.getMode().$id !== want) {
            editor.aceEditor.session.setMode(want);
        }
        editor.aceEditor.setFontSize(settings.editorFont);
        if (file && file.format) {
            const fs = getFormatSettings(file.format.id);
            const tab = fs.indent === 'tab';
            editor.aceEditor.session.setUseSoftTabs(!tab);
            editor.aceEditor.session.setTabSize(tab ? 4 : Number(fs.indent));
        }
        editor.aceEditor.setDisplayIndentGuides(true);
        editor.aceEditor.setHighlightIndentGuides(true);
    } catch (e) {
        console.warn('ace mode switch failed', e);
    }
}

function snapshotActiveDoc() {
    if (!file || !editor) return;
    file.text = editor.getText();
    file.mode = currentMode;
    file.dirty = dirty;
}

function markDocDirty(doc) {
    if (!doc || !doc.editor) return;
    const text = doc.editor.getText();
    doc.text = text;
    const base = doc.bases[doc.mode];
    const next = doc.untitled ? true : (base == null ? true : text !== base);
    if (file === doc) {
        setDirty(next);
    } else {
        doc.dirty = next;
        updateTabDirty(doc);
        updateBackendDirty();
    }
}

function createDocEditor(doc) {
    if (doc.editor) return;
    const fmt = doc.format;
    const fs = getFormatSettings(fmt.id);
    let startMode = !doc.treeAvailable ? 'code' : (doc.mode === 'code' || doc.mode === 'text' ? doc.mode : 'tree');
    let initialText = null;
    let initialValue = null;
    if (startMode === 'code' || startMode === 'text') {
        initialText = doc.content || '';
    } else {
        try {
            initialValue = fmt.parse(doc.content || '');
        } catch (e) {
            startMode = 'code';
            initialText = doc.content || '';
            doc.treeAvailable = false;
            doc.parseError = e;
        }
    }
    const pane = document.createElement('div');
    pane.className = 'jsoneditor-pane active';
    els.editor.appendChild(pane);
    doc.loading = true;
    const ed = new JSONEditor(pane, {
        mode: startMode,
        modes: doc.treeAvailable ? ['tree', 'code', 'text'] : ['code'],
        mainMenuBar: true,
        navigationBar: !fmt.rawOnly,
        statusBar: false,
        indentation: fs.indent === 'tab' ? '\t' : Number(fs.indent),
        onChange() {
            if (doc.loading) return;
            markDocDirty(doc);
        },
        onModeChange(mode) {
            if (!doc.editor) return;
            doc.mode = mode;
            if (file === doc) {
                currentMode = mode;
                applyAceMode();
                updateStatus();
                updateSearchState();
            }
            setTimeout(() => {
                if (!doc.editor || doc.mode !== mode) return;
                doc.text = doc.editor.getText();
                if (!doc.dirty) doc.bases[mode] = doc.text;
            }, 0);
        },
        onError(err) {
            if (file === doc) flash(err.message, true);
        },
    });
    doc.editor = ed;
    doc.pane = pane;
    if (startMode === 'code' || startMode === 'text') {
        ed.setText(initialText != null ? initialText : '');
    } else {
        ed.set(initialValue);
    }
    if ((doc.large || doc.binary) && ed.aceEditor) {
        ed.aceEditor.setReadOnly(true);
    }
    doc.mode = startMode;
    doc.text = ed.getText();
    if (!doc.dirty) doc.bases[startMode] = doc.text;
    doc.content = null;
    doc.loading = false;
}

function createDoc(data) {
    if (data.binary) {
        return {
            id: ++docSeq,
            path: data.path,
            name: data.name,
            size: data.size,
            eol: data.eol || 'lf',
            hasBom: false,
            large: false,
            enc: 'binary',
            content: data.content,
            format: formats.bytes,
            treeAvailable: false,
            parseError: null,
            mode: 'code',
            text: null,
            rawText: null,
            dirty: false,
            untitled: false,
            binary: true,
            bases: {tree: null, code: null},
        };
    }
    const preview = detectFormat(data.name, '');
    const fsPreview = getFormatSettings(preview.id);
    const format = detectFormat(data.name, data.content, {indent: fsPreview.indent});
    const fs = getFormatSettings(format.id);
    let treeAvailable = !(data.large || format.rawOnly);
    let parseError = null;
    if (treeAvailable) {
        try {
            format.parse(data.content);
        } catch (e) {
            treeAvailable = false;
            parseError = e;
        }
    }
    return {
        id: ++docSeq,
        path: data.path,
        name: data.name,
        size: data.size,
        eol: data.eol,
        hasBom: data.hasBom,
        large: data.large,
        enc: data.enc,
        content: data.content,
        format,
        treeAvailable,
        parseError,
        mode: treeAvailable ? (fs.view === 'code' || fs.view === 'text' ? fs.view : 'tree') : 'code',
        text: null,
        rawText: treeAvailable ? data.content : null,
        dirty: false,
        untitled: false,
        binary: false,
        bases: {tree: null, code: null},
    };
}

function updateDocChrome() {
    if (!file) return;
    els.filename.textContent = file.name;
    els.filename.title = file.path || file.name;
    renderBreadcrumb(file.path);
    showBanner(file, file.parseError);
    els.welcome.classList.add('hidden');
    els.editor.classList.remove('hidden');
    els.searchInput.value = '';
    if (editor && editor.searchBox) editor.searchBox.clear();
    updateWindowTitle();
    updateStatus();
    updateSearchState();
    renderTabs();
}

function showWelcome() {
    cancelAutoSave();
    if (editor) {
        editor.destroy();
        editor = null;
    }
    file = null;
    dirty = false;
    currentMode = 'tree';
    els.editor.classList.add('hidden');
    els.welcome.classList.remove('hidden');
    els.filename.textContent = '未打开文件';
    els.filename.title = '';
    els.filename.classList.remove('dirty');
    els.breadcrumb.textContent = '';
    els.stDirty.textContent = '';
    els.stMessage.textContent = '';
    els.stMode.textContent = '';
    els.stSize.textContent = '';
    els.stEol.textContent = '';
    els.stEnc.textContent = '';
    els.stEol.style.display = '';
    els.stEnc.style.display = '';
    els.banner.classList.add('hidden');
    els.searchInput.value = '';
    closeFootPopover();
    closeDialogs();
    updateSearchState();
    renderTabs();
    updateBackendDirty();
    updateWindowTitle();
}

let activateToken = 0;

async function activateDoc(doc) {
    if (!doc || doc === file) return;
    const token = ++activateToken;
    cancelAutoSave();
    if (settings.autoSave && file && dirty && file.path && !file.large) {
        await save({auto: true});
        if (token !== activateToken) return;
    }
    snapshotActiveDoc();
    file = doc;
    dirty = !!doc.dirty;
    currentMode = doc.mode || 'tree';
    els.welcome.classList.add('hidden');
    els.editor.classList.remove('hidden');
    for (const d of docs) {
        if (d.pane) d.pane.classList.remove('active');
    }
    if (!doc.editor) createDocEditor(doc);
    doc.pane.classList.add('active');
    editor = doc.editor;
    updateDocChrome();
    setDirty(doc.dirty);
    applyAceMode();
    humanizeCounts();
    if (editor && editor.aceEditor) {
        setTimeout(() => {
            if (editor === doc.editor && editor && editor.aceEditor) editor.aceEditor.resize();
        }, 0);
    }
}

function requestCloseDoc(doc) {
    if (!doc) return;
    if (doc.dirty) {
        openCloseConfirm('“' + doc.name + '”有未保存的修改，关闭标签后将丢弃。', () => closeDocNow(doc));
    } else {
        closeDocNow(doc);
    }
}

function closeDocNow(doc) {
    const idx = docs.indexOf(doc);
    if (idx < 0) return;
    const wasActive = doc === file;
    docs.splice(idx, 1);
    if (doc.editor) {
        doc.editor.destroy();
        doc.editor = null;
    }
    if (doc.pane) {
        doc.pane.remove();
        doc.pane = null;
    }
    if (docs.length === 0) {
        editor = null;
        showWelcome();
        return;
    }
    if (wasActive) {
        editor = null;
        file = null;
        dirty = false;
        const next = docs[Math.min(idx, docs.length - 1)];
        activateDoc(next);
    } else {
        renderTabs();
        updateBackendDirty();
    }
}

function findDocByPath(path) {
    const key = String(path || '').replace(/\\/g, '/').toLowerCase();
    return docs.find((d) => String(d.path || '').replace(/\\/g, '/').toLowerCase() === key) || null;
}

async function openPathsHere(paths) {
    const list = (paths || []).filter(Boolean);
    if (!list.length) return;
    let target = null;
    let lastNew = null;
    let lastError = null;
    for (const path of list) {
        const existing = findDocByPath(path);
        if (existing) {
            target = existing;
            continue;
        }
        try {
            const base = String(path).split(/[\\/]/).pop();
            const preview = detectFormat(base, '');
            const enc = getFormatSettings(preview.id).encoding;
            const data = await backend.OpenFile(path, enc);
            const doc = createDoc(data);
            docs.push(doc);
            target = doc;
            lastNew = doc;
        } catch (e) {
            lastError = e;
        }
    }
    if (target) await activateDoc(lastNew || target);
    if (lastError) flash('打开失败：' + lastError, true);
}

async function openInNewWindows(paths) {
    try {
        await backend.OpenInNewWindows(paths);
        flash('已在新窗口打开 ' + paths.length + ' 个文件');
    } catch (e) {
        flash('打开新窗口失败：' + e, true);
    }
}

async function openPaths(paths) {
    const list = (paths || []).filter(Boolean);
    if (!list.length) return;
    if (settings.openMode === 'window') {
        if (docs.length === 0) {
            await openPathsHere([list[0]]);
            if (list.length > 1) await openInNewWindows(list.slice(1));
        } else {
            await openInNewWindows(list);
        }
        return;
    }
    await openPathsHere(list);
}

async function openPath(path) {
    await openPaths([path]);
}

async function openDialog() {
    try {
        const paths = await backend.OpenFilesDialog();
        const list = Array.isArray(paths) ? paths : (paths ? [paths] : []);
        if (list.length) await openPaths(list);
    } catch (e) {
        flash('打开失败：' + e, true);
    }
}

let untitledSeq = 0;

function newDocument() {
    const seq = ++untitledSeq;
    const name = seq === 1 ? '未命名.json' : '未命名 ' + seq + '.json';
    const doc = createDoc({
        path: null,
        name,
        content: '{}',
        size: 2,
        eol: 'lf',
        hasBom: false,
        large: false,
        enc: 'utf-8',
    });
    doc.untitled = true;
    doc.dirty = true;
    docs.push(doc);
    activateDoc(doc);
}

async function openNewWindow() {
    try {
        await backend.OpenNewWindow();
    } catch (e) {
        flash('新建窗口失败：' + e, true);
    }
}

async function showInFolder() {
    if (!file || !file.path) return;
    try {
        await backend.ShowInFolder(file.path);
    } catch (e) {
        flash('打开文件位置失败：' + e, true);
    }
}

async function copyText(text, label) {
    if (!text) return;
    try {
        await backend.CopyText(text);
        flash('已复制' + label);
    } catch (e) {
        flash('复制失败：' + e, true);
    }
}

async function requestReload() {
    const doc = file;
    if (!doc || !doc.path) return;
    if (doc.dirty) {
        openCloseConfirm('重新加载将丢弃未保存的修改。', () => reloadActive(), '丢弃并重新加载');
    } else {
        await reloadActive();
    }
}

async function reloadActive() {
    const doc = file;
    if (!doc || !doc.path) return;
    try {
        const data = await backend.OpenFile(doc.path, getFormatSettings(doc.format.id).encoding);
        const fresh = createDoc(data);
        const keepMode = doc.mode;
        if (doc.editor) doc.editor.destroy();
        if (doc.pane) doc.pane.remove();
        doc.editor = null;
        doc.pane = null;
        doc.loading = false;
        Object.assign(doc, fresh, {id: doc.id, dirty: false, untitled: false, text: null, content: data.content});
        doc.mode = keepMode === 'code' || !doc.treeAvailable ? 'code' : 'tree';
        editor = null;
        createDocEditor(doc);
        doc.pane.classList.add('active');
        editor = doc.editor;
        currentMode = doc.mode;
        updateDocChrome();
        setDirty(false);
        applyAceMode();
        humanizeCounts();
        flash('已重新加载 ' + doc.name);
    } catch (e) {
        flash('重新加载失败：' + e, true);
    }
}

async function saveDoc(doc, opts = {}) {
    if (!doc || doc.large || doc.binary || !doc.editor) return false;
    const fmt = doc.format;
    const fs = getFormatSettings(fmt.id);
    const savedMode = doc.mode;
    const snapshot = doc.editor.getText();
    let text;
    if (!doc.dirty && doc.rawText != null) {
        text = doc.rawText;
    } else if (savedMode === 'code' || savedMode === 'text' || fmt.rawOnly) {
        text = snapshot;
        if (!fmt.rawOnly) {
            try {
                fmt.parse(text);
            } catch (e) {
                if (!opts.auto) flash(fmt.name + ' 无效，未保存：' + e.message, true);
                return false;
            }
        }
    } else {
        let value;
        try {
            value = JSON.parse(snapshot);
        } catch (e) {
            if (!opts.auto) flash('无法读取树内容：' + e.message, true);
            return false;
        }
        text = fmt.stringify(value);
    }
    let path = doc.path;
    if (opts.saveAs || !path) {
        if (opts.auto) return false;
        path = await backend.SaveFileDialog(doc.name || '未命名.json');
        if (!path) return false;
    }
    try {
        const eol = fs.eol === 'follow' ? doc.eol : fs.eol;
        const enc = fs.encoding === 'auto' ? (doc.enc || 'utf-8') : fs.encoding;
        await backend.SaveFile(path, text, eol, doc.hasBom, enc);
        doc.enc = enc;
        doc.path = path;
        doc.name = path.split(/[\\/]/).pop();
        doc.untitled = false;
        doc.mode = savedMode;
        doc.text = snapshot;
        doc.bases[savedMode] = snapshot;
        if (doc.treeAvailable) doc.rawText = text;
        if (doc.parseError) {
            doc.parseError = null;
            if (file === doc) els.banner.classList.add('hidden');
        }
        if (file === doc) {
            const now = doc.editor ? doc.editor.getText() : snapshot;
            if (now !== snapshot) {
                doc.text = now;
                doc.mode = currentMode;
            }
            updateStatus();
            els.filename.textContent = doc.name;
            els.filename.title = doc.path;
            renderBreadcrumb(doc.path);
            renderTabs();
            setDirty(now !== snapshot);
            updateWindowTitle();
        } else {
            doc.dirty = false;
            updateTabDirty(doc);
            renderTabs();
            updateBackendDirty();
        }
        if (!opts.auto && !opts.silent) flash('已保存 ' + doc.name);
        return true;
    } catch (e) {
        flash((opts.auto ? '自动保存失败：' : '保存失败：') + e, true);
        return false;
    }
}

async function save(opts = {}) {
    return saveDoc(file, opts);
}

async function saveAs() {
    return saveDoc(file, {saveAs: true});
}

async function saveAll() {
    let saved = 0;
    let failed = false;
    for (const doc of docs.slice()) {
        if (!doc.dirty || !doc.path) continue;
        const ok = await saveDoc(doc, {silent: true});
        if (ok) saved++;
        else failed = true;
    }
    const skipped = docs.some((d) => d.dirty && !d.path);
    if (saved) {
        flash('已保存 ' + saved + ' 个文件' + (failed || skipped ? '，部分未保存' : ''), failed || skipped);
    } else if (failed || skipped) {
        flash(skipped ? '未命名文件请单独另存为' : '保存失败', true);
    }
}

els.btnWelcomeOpen.addEventListener('click', openDialog);

applySettings();
elsSettings.fixed.addEventListener('change', () => {
    settings.fixedKeys = elsSettings.fixed.checked;
    applySettings();
});
elsSettings.autoSave.addEventListener('change', () => {
    settings.autoSave = elsSettings.autoSave.checked;
    applySettings();
});
elsSettings.openMode.addEventListener('change', () => {
    settings.openMode = elsSettings.openMode.value;
    applySettings();
    renderTabs();
});
elsSettings.width.addEventListener('input', () => {
    settings.keyWidth = Number(elsSettings.width.value);
    applySettings();
});
elsSettings.font.addEventListener('input', () => {
    settings.editorFont = Number(elsSettings.font.value);
    applySettings();
});
elsSettings.uiFont.addEventListener('change', () => {
    settings.uiFont = elsSettings.uiFont.value;
    applySettings();
});
elsSettings.uiCjkFont.addEventListener('change', () => {
    settings.uiCjkFont = elsSettings.uiCjkFont.value;
    applySettings();
});
elsSettings.editorFontFamily.addEventListener('change', () => {
    settings.editorFontFamily = elsSettings.editorFontFamily.value;
    applySettings();
});
elsSettings.editorCjkFont.addEventListener('change', () => {
    settings.editorCjkFont = elsSettings.editorCjkFont.value;
    applySettings();
});

window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (!els.editor.contains(e.target)) return;
    const dir = e.deltaY < 0 ? 1 : -1;
    const next = Math.min(24, Math.max(9, settings.editorFont + dir));
    if (next === settings.editorFont) return;
    settings.editorFont = next;
    applySettings();
    flash('编辑器字号 ' + next);
}, {passive: false, capture: true});

const winControls = document.getElementById('win-controls');
if (rt) {
    const maxBtn = document.getElementById('wc-max');
    const syncMaxIcon = async () => {
        const maximised = await rt.WindowIsMaximised();
        maxBtn.innerHTML = maximised ? '&#xE923;' : '&#xE922;';
        maxBtn.title = maximised ? '还原' : '最大化';
    };
    document.getElementById('wc-min').addEventListener('click', () => rt.WindowMinimise());
    maxBtn.addEventListener('click', async () => {
        rt.WindowToggleMaximise();
        setTimeout(syncMaxIcon, 100);
    });
    document.getElementById('wc-close').addEventListener('click', () => { if (rt.Quit) rt.Quit(); else if (rt.WindowClose) rt.WindowClose(); });
    document.getElementById('toolbar').addEventListener('dblclick', (e) => {
        if (e.target.closest('button, input, select, textarea')) return;
        rt.WindowToggleMaximise();
        setTimeout(syncMaxIcon, 120);
    });
    window.addEventListener('resize', syncMaxIcon);
    syncMaxIcon();
} else {
    winControls.style.display = 'none';
}

const menuBar = document.getElementById('menubar');
let openMenuEl = null;

function clickEditorButton(sel) {
    if (!editor) return;
    const pane = file && file.pane ? file.pane : els.editor;
    const btn = pane.querySelector(sel);
    if (btn) btn.click();
}

function formatDocument() {
    if (!editor || !file) return;
    const doc = file;
    if (doc.large || doc.binary || (doc.format && doc.format.rawOnly)) {
        flash('当前文件不支持格式化', true);
        return;
    }
    if (currentMode === 'tree') {
        flash('格式化请在代码视图或文本视图中使用');
        return;
    }
    const text = editor.getText();
    let value;
    try {
        value = doc.format.parse(text);
    } catch (e) {
        flash(doc.format.name + ' 无效，无法格式化：' + e.message, true);
        return;
    }
    let formatted;
    if (doc.format.id === 'json') {
        const indent = getFormatSettings('json').indent;
        formatted = JSON.stringify(value, null, indent === 'tab' ? '\t' : Number(indent));
    } else {
        formatted = doc.format.stringify(value);
    }
    if (formatted === text) return;
    doc.loading = true;
    try {
        editor.setText(formatted);
    } catch (e) {
        flash('格式化失败：' + e.message, true);
        return;
    } finally {
        doc.loading = false;
    }
    markDocDirty(doc);
    updateStatus();
}

function switchMode(mode) {
    if (!editor || currentMode === mode) return;
    const doc = file;
    if ((mode === 'code' || mode === 'text') && currentMode === 'tree' && doc && !dirty && doc.rawText != null) {
        doc.loading = true;
        try {
            editor.setMode(mode);
            editor.setText(doc.rawText);
        } catch (e) {
            console.warn('switch mode failed', e);
        } finally {
            doc.loading = false;
        }
        return;
    }
    if ((mode === 'code' || mode === 'text') && (currentMode === 'code' || currentMode === 'text') && doc) {
        const text = editor.getText();
        doc.loading = true;
        try {
            editor.setMode(mode);
            editor.setText(text);
        } catch (e) {
            console.warn('switch mode failed', e);
        } finally {
            doc.loading = false;
        }
        return;
    }
    if (mode === 'tree' && (currentMode === 'code' || currentMode === 'text') && doc && doc.format.id !== 'json') {
        let value;
        try {
            value = doc.format.parse(editor.getText());
        } catch (e) {
            flash(doc.format.name + ' 解析失败：' + e.message, true);
            return;
        }
        doc.loading = true;
        try {
            editor.setText(JSON.stringify(value, null, 2));
            editor.setMode('tree');
            editor.set(value);
        } catch (e) {
            flash('切换树视图失败：' + e.message, true);
        } finally {
            doc.loading = false;
        }
        return;
    }
    try {
        editor.setMode(mode);
    } catch (e) {}
}

function focusSearch() {
    els.searchInput.focus();
    els.searchInput.select();
}

function exitApp() {
    if (rt && rt.Quit) rt.Quit();
    else if (rt && rt.WindowClose) rt.WindowClose();
    else window.close();
}

function menuItems(kind) {
    const tree = currentMode === 'tree' && !!file && !(file.format && file.format.rawOnly);
    const canSave = !!file && !file.large && !file.binary;
    const hasPath = !!(file && file.path);
    const hasDirty = docs.some((d) => d.dirty);
    switch (kind) {
        case 'file':
            return [
                {label: '新建', shortcut: 'Ctrl+N', icon: 'E710', action: newDocument},
                {label: '新建窗口', shortcut: 'Ctrl+Shift+N', icon: 'E8A7', action: openNewWindow},
                {sep: true},
                {label: '打开…', shortcut: 'Ctrl+O', icon: 'E8E5', action: openDialog},
                {sep: true},
                {label: '保存', shortcut: 'Ctrl+S', icon: 'E74E', disabled: !canSave, action: () => save()},
                {label: '另存为…', shortcut: 'Ctrl+Shift+S', icon: 'E74E', disabled: !canSave, action: saveAs},
                {label: '保存全部', disabled: !hasDirty, action: saveAll},
                {sep: true},
                {label: '重新加载', icon: 'E72C', disabled: !hasPath, action: requestReload},
                {label: '打开文件位置', icon: 'E8B7', disabled: !hasPath, action: showInFolder},
                {label: '复制文件路径', icon: 'E8C8', disabled: !hasPath, action: () => copyText(file.path, '路径')},
                {label: '复制文件名', icon: 'E8C8', disabled: !hasPath, action: () => copyText(file.name, '文件名')},
                {sep: true},
                {label: '关闭标签', shortcut: 'Ctrl+W', icon: 'E8BB', disabled: !file, action: () => requestCloseDoc(file)},
                {label: '设置…', shortcut: 'Ctrl+,', icon: 'E713', action: () => openSettings('general')},
                {sep: true},
                {label: '退出', icon: 'E8BB', action: exitApp},
            ];
        case 'edit':
            return [
                {label: '撤销', shortcut: 'Ctrl+Z', icon: 'E7A7', action: doUndo},
                {label: '重做', shortcut: 'Ctrl+Y', icon: 'E7A6', action: doRedo},
                {sep: true},
                {label: '查找…', shortcut: 'Ctrl+F', icon: 'E721', action: focusSearch},
            ];
        case 'format':
            return [
                {label: '格式化', shortcut: 'Ctrl+Alt+L', action: formatDocument},
                {label: '压缩', action: () => clickEditorButton('.jsoneditor-compact')},
                {sep: true},
                {label: '排序', disabled: !tree, action: () => clickEditorButton('.jsoneditor-sort')},
                {label: '变换…', disabled: !tree, action: () => clickEditorButton('.jsoneditor-transform')},
            ];
        case 'view': {
            const structured = !!file && !!file.treeAvailable;
            return [
                {label: '树视图', checked: currentMode === 'tree', disabled: !structured, action: () => switchMode('tree')},
                {label: '代码视图', checked: currentMode === 'code', action: () => switchMode('code')},
                {label: '文本视图', checked: currentMode === 'text', disabled: !structured, action: () => switchMode('text')},
                {sep: true},
                {label: '展开全部', shortcut: 'Ctrl+Shift+=', disabled: !tree, action: () => editor && editor.expandAll()},
                {label: '收起全部', shortcut: 'Ctrl+Shift+-', disabled: !tree, action: () => editor && editor.collapseAll()},
            ];
        }
        case 'theme': {
            const items = [];
            let prevGroup = '';
            themes.forEach((theme) => {
                if (prevGroup && theme.group !== prevGroup) items.push({sep: true});
                items.push({
                    label: theme.name,
                    checked: settings.theme === theme.id,
                    swatch: theme.bg,
                    swatchAccent: theme.accent,
                    action: () => setTheme(theme.id),
                });
                prevGroup = theme.group;
            });
            return items;
        }
        case 'help':
            return [
                {label: '快捷键', action: () => openSettings('shortcuts')},
                {label: '关于 CaDt-DataLens', action: () => openSettings('about')},
            ];
        default:
            return [];
    }
}

function renderDropdown(menuEl) {
    const dd = menuEl.querySelector('.dropdown');
    dd.textContent = '';
    for (const it of menuItems(menuEl.dataset.menu)) {
        if (it.sep) {
            const s = document.createElement('div');
            s.className = 'menu-sep';
            dd.appendChild(s);
            continue;
        }
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'menu-item' + (it.disabled ? ' disabled' : '');
        const icon = document.createElement('span');
        icon.className = 'mi-icon' + (it.checked ? ' checked' : '');
        if (it.checked) {
            icon.textContent = '\uE73E';
        } else if (it.swatch) {
            const dot = document.createElement('span');
            dot.className = 'mi-swatch';
            dot.style.background = 'linear-gradient(135deg, ' + it.swatch + ' 55%, ' + it.swatchAccent + ' 55%)';
            icon.appendChild(dot);
        } else if (it.icon) {
            icon.textContent = String.fromCharCode(parseInt(it.icon, 16));
        }
        const label = document.createElement('span');
        label.className = 'mi-label';
        label.textContent = it.label;
        const key = document.createElement('span');
        key.className = 'mi-key';
        key.textContent = it.shortcut || '';
        row.append(icon, label, key);
        row.addEventListener('click', (e) => {
            e.stopPropagation();
            closeAllMenus();
            if (!it.disabled) it.action();
        });
        dd.appendChild(row);
    }
}

function closeAllMenus() {
    document.querySelectorAll('#menubar .menu').forEach((m) => {
        m.classList.remove('open');
        m.querySelector('.dropdown').classList.add('hidden');
    });
    openMenuEl = null;
}

function openMenu(menuEl) {
    closeAllMenus();
    renderDropdown(menuEl);
    menuEl.querySelector('.dropdown').classList.remove('hidden');
    menuEl.classList.add('open');
    openMenuEl = menuEl;
}

document.querySelectorAll('#menubar .menu').forEach((menuEl) => {
    menuEl.querySelector('.menu-label').addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllMenus();
        openMenu(menuEl);
    });
    menuEl.querySelector('.menu-label').addEventListener('mouseenter', () => {
        if (openMenuEl && openMenuEl !== menuEl) openMenu(menuEl);
    });
});
window.addEventListener('blur', () => closeAllMenus());
document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('#menubar')) return;
    closeAllMenus();
}, true);

els.searchInput.addEventListener('input', () => {
    if (!editor || !editor.searchBox) return;
    editor.searchBox.dom.search.value = els.searchInput.value;
    editor.searchBox.forceSearch();
});
els.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        if (editor && editor.searchBox) {
            if (e.shiftKey) editor.searchBox.previous();
            else editor.searchBox.next();
        }
    } else if (e.key === 'Escape') {
        els.searchInput.blur();
    }
});

function updateSearchState() {
    const tree = currentMode === 'tree' && !!file && !(file.format && file.format.rawOnly);
    els.searchInput.disabled = !tree;
    els.searchInput.placeholder = tree ? '搜索节点…' : '代码模式按 Ctrl+F 查找';
    if (!tree) {
        els.searchInput.value = '';
        if (editor && editor.searchBox) editor.searchBox.clear();
    }
}

window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (e.ctrlKey && e.altKey && (key === 'l' || e.code === 'KeyL')) {
        e.preventDefault();
        e.stopPropagation();
        formatDocument();
    } else if (e.ctrlKey && e.shiftKey && key === 's') {
        e.preventDefault();
        e.stopPropagation();
        saveAs();
    } else if (e.ctrlKey && !e.shiftKey && key === 's') {
        e.preventDefault();
        e.stopPropagation();
        save();
    } else if (e.ctrlKey && e.shiftKey && key === 'n') {
        e.preventDefault();
        e.stopPropagation();
        openNewWindow();
    } else if (e.ctrlKey && !e.shiftKey && key === 'n') {
        e.preventDefault();
        e.stopPropagation();
        newDocument();
    } else if (e.ctrlKey && !e.shiftKey && key === 'w') {
        e.preventDefault();
        e.stopPropagation();
        if (file) requestCloseDoc(file);
    } else if (e.ctrlKey && e.key === ',') {
        e.preventDefault();
        e.stopPropagation();
        openSettings('general');
    } else if (e.ctrlKey && key === 'o') {
        e.preventDefault();
        e.stopPropagation();
        openDialog();
    } else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.stopPropagation();
        doUndo();
    } else if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        e.stopPropagation();
        doRedo();
    } else if (e.ctrlKey && e.key.toLowerCase() === 'f') {
        if (currentMode === 'tree' && file && !(file.format && file.format.rawOnly)) {
            e.preventDefault();
            e.stopPropagation();
            focusSearch();
        }
    } else if (e.ctrlKey && (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd' ||
        e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract')) {
        e.preventDefault();
        e.stopPropagation();
        if (!editor || currentMode !== 'tree' || !file || file.format.rawOnly) return;
        const plus = e.key === '+' || e.key === '=' || e.code === 'NumpadAdd';
        if (e.shiftKey) {
            if (plus) editor.expandAll();
            else editor.collapseAll();
        } else {
            toggleFocusedNode(plus ? 'expand' : 'collapse');
        }
    } else if (e.key === 'Escape') {
        closeDialogs();
        closeAllMenus();
        closeFootPopover();
    }
}, {capture: true});

for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    window.addEventListener(type, (e) => {
        if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
            e.preventDefault();
        }
    }, true);
}

if (rt) {
    rt.EventsOn('open-files', (paths) => openPaths(paths));
    rt.EventsOn('confirm-close', () => openCloseConfirm());
}

(async () => {
    if (backend.GetOpenMode) {
        try {
            const mode = await backend.GetOpenMode();
            if (mode === 'tab' || mode === 'window') {
                settings.openMode = mode;
                syncedOpenMode = mode;
                applySettings();
            }
        } catch (e) {}
    }
    const files = await backend.GetStartupFiles();
    if (files && files.length) await openPaths(files);
})();
