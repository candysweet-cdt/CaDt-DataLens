import './style.css';

const hasWails = !!(window.go && window.go.main && window.go.main.App);

const sampleJson = {
    name: '时空纪元', version: '1.0.0', enabled: true, count: 42, nothing: null,
    tags: ['模组', '网易', 'JSON'],
    author: {name: 'CandySweet', role: 'owner'},
    items: [
        {id: 'spacetime:cable', count: 64},
        {id: 'spacetime:machine', count: 1},
    ],
};

const mockScenario = new URLSearchParams(location.search);
const mockBackend = {
    async GetStartupFile() {
        if (mockScenario.has('empty')) return null;
        if (mockScenario.has('large')) return 'mock://large.json';
        if (mockScenario.has('invalid')) return 'mock://invalid.json';
        return 'mock://sample.json';
    },
    async OpenFile(path) {
        let content = JSON.stringify(sampleJson, null, 2);
        let large = false;
        if (path.includes('large')) large = true;
        if (path.includes('invalid')) content = '{ "broken": [1, 2, ';
        return {
            path, name: path.split('/').pop(), content,
            size: content.length, eol: 'lf', hasBom: false, large,
        };
    },
    async OpenFileDialog() { return 'mock://sample.json'; },
    async SaveFileDialog(name) { return 'mock://' + name; },
    async SaveFile(path, content) {
        localStorage.setItem('jsonlens-mock-save', content);
        console.info('[mock] SaveFile', path, content.length, 'chars');
    },
    async SetDirty(flag) { console.info('[mock] SetDirty', flag); },
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
    EventsOn() {},
};
const rt = window.runtime || (mockScenario.has('winctl') ? mockRt : null);

const els = {
    filename: document.getElementById('filename'),
    banner: document.getElementById('banner'),
    editor: document.getElementById('editor'),
    welcome: document.getElementById('welcome'),
    btnOpen: document.getElementById('btn-open'),
    btnSave: document.getElementById('btn-save'),
    btnWelcomeOpen: document.getElementById('btn-welcome-open'),
    stMode: document.getElementById('st-mode'),
    stSize: document.getElementById('st-size'),
    stEol: document.getElementById('st-eol'),
    stEnc: document.getElementById('st-enc'),
    stMessage: document.getElementById('st-message'),
    stDirty: document.getElementById('st-dirty'),
};

let editor = null;
let file = null;
let loaded = false;
let dirty = false;
let currentMode = 'tree';
let flashTimer = 0;

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

function setDirty(flag) {
    dirty = flag;
    backend.SetDirty(flag);
    els.stDirty.textContent = flag ? '未保存' : '';
    els.filename.classList.toggle('dirty', flag);
    document.title = (flag ? '● ' : '') + (file ? file.name : 'JsonLens') + ' - JsonLens';
}

function updateStatus() {
    if (!file) return;
    els.stMode.textContent = (currentMode === 'tree' ? '树视图' : '代码视图') + (file.large ? ' · 只读' : '');
    els.stSize.textContent = fmtSize(file.size);
    els.stEol.textContent = file.eol.toUpperCase();
    els.stEnc.textContent = 'UTF-8' + (file.hasBom ? ' BOM' : '');
}

function showBanner(data, parseError) {
    if (data.large) {
        els.banner.textContent = '大文件（' + fmtSize(data.size) + '）：已切换为只读代码模式，不可编辑保存。';
        els.banner.classList.remove('hidden');
    } else if (parseError) {
        els.banner.textContent = 'JSON 解析失败：' + parseError.message + '。已用代码模式打开，可手动修复后保存。';
        els.banner.classList.remove('hidden');
    } else {
        els.banner.classList.add('hidden');
    }
}

function createEditor(raw, large) {
    if (editor) {
        editor.destroy();
        editor = null;
    }
    let json = null;
    let parseError = null;
    try {
        json = JSON.parse(raw);
    } catch (e) {
        parseError = e;
    }
    const codeOnly = large || !!parseError;
    const startMode = codeOnly ? 'code' : 'tree';
    editor = new JSONEditor(els.editor, {
        mode: startMode,
        modes: codeOnly ? ['code'] : ['tree', 'code'],
        mainMenuBar: true,
        navigationBar: true,
        statusBar: false,
        indentation: 2,
        onChange() {
            if (loaded) setDirty(true);
        },
        onModeChange(mode) {
            currentMode = mode;
            updateStatus();
        },
        onError(err) {
            flash(err.message, true);
        },
    });
    if (startMode === 'code') {
        editor.setText(raw);
    } else {
        editor.set(json);
    }
    if (large && editor.aceEditor) {
        editor.aceEditor.setReadOnly(true);
    }
    currentMode = startMode;
    return parseError;
}

async function loadData(data) {
    file = data;
    loaded = false;
    els.welcome.classList.add('hidden');
    els.editor.classList.remove('hidden');
    const parseError = createEditor(data.content, data.large);
    loaded = true;
    els.filename.textContent = data.name;
    els.filename.title = data.path || data.name;
    els.btnSave.disabled = !!data.large;
    showBanner(data, parseError);
    updateStatus();
    setDirty(false);
}

async function openPath(path) {
    try {
        const data = await backend.OpenFile(path);
        await loadData(data);
    } catch (e) {
        flash('打开失败：' + e, true);
    }
}

async function openDialog() {
    try {
        const path = await backend.OpenFileDialog();
        if (path) await openPath(path);
    } catch (e) {
        flash('打开失败：' + e, true);
    }
}

async function save() {
    if (!file || file.large || !editor) return;
    let text;
    try {
        text = editor.getText();
        if (currentMode === 'code') JSON.parse(text);
    } catch (e) {
        flash('JSON 无效，未保存：' + e.message, true);
        return;
    }
    let path = file.path;
    if (!path) {
        path = await backend.SaveFileDialog(file.name || 'untitled.json');
        if (!path) return;
    }
    try {
        await backend.SaveFile(path, text, file.eol, file.hasBom);
        file.path = path;
        file.name = path.split(/[\\/]/).pop();
        els.filename.textContent = file.name;
        els.filename.title = path;
        setDirty(false);
        flash('已保存 ' + file.name);
    } catch (e) {
        flash('保存失败：' + e, true);
    }
}

els.btnOpen.addEventListener('click', openDialog);
els.btnWelcomeOpen.addEventListener('click', openDialog);
els.btnSave.addEventListener('click', save);

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
    document.getElementById('wc-close').addEventListener('click', () => rt.WindowClose());
    window.addEventListener('resize', syncMaxIcon);
    syncMaxIcon();
} else {
    winControls.style.display = 'none';
}

window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
    } else if (e.ctrlKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        openDialog();
    }
});

if (rt) {
    rt.EventsOn('open-file', (path) => openPath(path));
}

(async () => {
    const p = await backend.GetStartupFile();
    if (p) await openPath(p);
})();