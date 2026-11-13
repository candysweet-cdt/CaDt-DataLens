// schema-panel.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// ---- JSON Schema 校验 ----
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {validateJsonSchema} from './jsonschema.js';
import {buildJsonLineMap} from './jsonpath.js';

export function createSchemaPanel(deps) {

const schemaState = {open: false, doc: null, lineMap: new Map(), errors: [], previousFocus: null};

function schemaEls() {
    return {
        mask: document.getElementById('js-mask'),
        summary: document.getElementById('js-summary'),
        list: document.getElementById('js-list'),
        schema: document.getElementById('js-schema'),
        close: document.getElementById('js-close'),
        reselect: document.getElementById('js-reselect'),
    };
}

function closeSchemaPanel() {
    if (!schemaState.open) return;
    schemaState.open = false;
    const {mask} = schemaEls();
    if (mask) mask.classList.add('hidden');
    const prev = schemaState.previousFocus;
    schemaState.previousFocus = null;
    if (prev && prev.isConnected && typeof prev.focus === 'function') {
        try { prev.focus(); } catch (e) {}
    }
}

function renderSchemaErrors(errors) {
    const {list} = schemaEls();
    if (!list) return;
    list.textContent = '';
    if (!errors.length) {
        const ok = document.createElement('div');
        ok.className = 'js-ok';
        ok.textContent = '校验通过，没有发现不符合 Schema 的数据。';
        list.appendChild(ok);
        return;
    }
    const fragment = document.createDocumentFragment();
    for (const error of errors) {
        const row = document.createElement('div');
        row.className = 'js-row';
        const path = document.createElement('span');
        path.className = 'js-path';
        path.textContent = error.path;
        const keyword = document.createElement('span');
        keyword.className = 'js-keyword';
        keyword.textContent = error.keyword || '';
        const message = document.createElement('span');
        message.className = 'js-message';
        message.textContent = error.message;
        row.append(path, keyword, message);
        row.addEventListener('click', async () => {
            const loc = schemaState.lineMap.get(error.path);
            if (loc && schemaState.doc && deps.docs.includes(schemaState.doc)) {
                closeSchemaPanel();
                await deps.selectLineInDoc(schemaState.doc, loc.line, loc.column);
            } else {
                await deps.copyText(error.path, '路径');
            }
        });
        fragment.appendChild(row);
    }
    list.appendChild(fragment);
}

async function openSchemaValidation() {
    const doc = deps.file;
    if (!doc || doc.binary || doc.large || !doc.format || (doc.format.id !== 'json' && doc.format.id !== 'jsonl')) {
        deps.flash('JSON Schema 校验仅支持 JSON/JSONL 文件', true);
        return;
    }
    if (!deps.backend.OpenFilesDialog) {
        deps.flash('当前环境不支持选择 Schema 文件', true);
        return;
    }
    let paths = [];
    try {
        paths = await deps.backend.OpenFilesDialog();
    } catch (e) {
        deps.flash('选择 Schema 文件失败：' + e, true);
        return;
    }
    const schemaPath = (paths || [])[0];
    if (!schemaPath) return;
    let schema;
    try {
        const data = await deps.backend.OpenFile(schemaPath, 'auto');
        if (!data || data.binary) throw new Error('Schema 是二进制文件');
        schema = JSON.parse(String(data.content == null ? '' : data.content));
    } catch (e) {
        deps.flash('读取 Schema 失败：' + ((e && e.message) || e), true);
        return;
    }
    const text = deps.structureTextForDoc(doc);
    let value;
    try {
        value = doc.format.parse(text);
    } catch (e) {
        deps.flash('当前文件解析失败：' + ((e && e.message) || e), true);
        return;
    }
    const errors = validateJsonSchema(value, schema);
    if (!schemaState.open) schemaState.previousFocus = document.activeElement;
    schemaState.open = true;
    schemaState.doc = doc;
    schemaState.errors = errors;
    schemaState.lineMap = doc.format.id === 'json' ? buildJsonLineMap(text) : new Map();
    const elsS = schemaEls();
    elsS.mask.classList.remove('hidden');
    elsS.summary.textContent = errors.length
        ? (doc.name + ' · ' + errors.length + ' 个错误')
        : (doc.name + ' · 校验通过');
    elsS.schema.textContent = 'Schema：' + (deps.baseNameOf(schemaPath) || schemaPath);
    renderSchemaErrors(errors);
    if (elsS.list) elsS.list.scrollTop = 0;
}

function bindSchemaPanel() {
    const elsS = schemaEls();
    if (!elsS.mask) return;
    if (elsS.close) elsS.close.addEventListener('click', closeSchemaPanel);
    if (elsS.reselect) elsS.reselect.addEventListener('click', () => openSchemaValidation());
    elsS.mask.addEventListener('mousedown', (e) => {
        if (e.target === elsS.mask) closeSchemaPanel();
    });
    document.addEventListener('keydown', (e) => {
        if (!schemaState.open || e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        closeSchemaPanel();
    }, true);
}
bindSchemaPanel();


    return {openSchemaValidation};
}
