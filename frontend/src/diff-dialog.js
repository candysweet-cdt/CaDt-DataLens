// diff-dialog.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// ---- 两个文件 Diff ----
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {detectFormat} from './formats.js';
import {unifiedDiff, semanticDiff, semanticEntryText} from './diff.js';

export function createDiffDialog(deps) {

const diffState = {open: false, previousFocus: null, running: false};

function diffEls() {
    return {
        mask: document.getElementById('diff-mask'),
        a: document.getElementById('diff-a'),
        b: document.getElementById('diff-b'),
        run: document.getElementById('diff-run'),
        close: document.getElementById('diff-close'),
        semantic: document.getElementById('diff-semantic'),
        summary: document.getElementById('diff-summary'),
        semanticList: document.getElementById('diff-semantic-list'),
        output: document.getElementById('diff-output'),
    };
}

function fillDiffSelect(select, entries) {
    select.textContent = '';
    for (const [path, name] of entries) {
        const option = document.createElement('option');
        option.value = path;
        option.textContent = name + ' — ' + path;
        select.appendChild(option);
    }
}

function openDiffDialog(pathA, pathB) {
    const elsD = diffEls();
    if (!elsD.mask) return;
    const candidates = deps.docs.filter((d) => d.path && !d.binary);
    const map = new Map(candidates.map((d) => [d.path, d.name]));
    if (pathA && !map.has(pathA)) map.set(pathA, deps.baseNameOf(pathA) || pathA);
    if (pathB && !map.has(pathB)) map.set(pathB, deps.baseNameOf(pathB) || pathB);
    if (map.size < 2) {
        deps.flash('至少打开两个文本文件才能比较', true);
        return;
    }
    const entries = [...map.entries()].sort((x, y) => x[1].localeCompare(y[1], 'zh-CN'));
    fillDiffSelect(elsD.a, entries);
    fillDiffSelect(elsD.b, entries);
    if (pathA && map.has(pathA)) elsD.a.value = pathA;
    if (pathB && map.has(pathB)) elsD.b.value = pathB;
    if (elsD.b.value === elsD.a.value) {
        const other = entries.find(([path]) => path !== elsD.a.value);
        if (other) elsD.b.value = other[0];
    }
    diffState.open = true;
    diffState.previousFocus = document.activeElement;
    elsD.mask.classList.remove('hidden');
    elsD.semanticList.classList.add('hidden');
    elsD.semanticList.textContent = '';
    elsD.output.textContent = '';
    elsD.summary.textContent = pathA || pathB ? '正在比较…' : '选择两个文件后点击“比较”';
    if (pathA || pathB) runDiffCompare();
}

function closeDiffDialog() {
    if (!diffState.open) return;
    diffState.open = false;
    const {mask} = diffEls();
    if (mask) mask.classList.add('hidden');
    const prev = diffState.previousFocus;
    diffState.previousFocus = null;
    if (prev && prev.isConnected && typeof prev.focus === 'function') {
        try { prev.focus(); } catch (e) {}
    }
}

async function diffReadText(path) {
    const doc = deps.findDocByPath(path);
    if (doc) {
        if (doc.editor) return doc.editor.getText();
        if (doc.text != null) return doc.text;
    }
    const data = await deps.backend.OpenFile(path, 'auto');
    if (!data || data.binary) throw new Error('二进制文件不支持比较');
    return String(data.content == null ? '' : data.content);
}

function renderDiffText(text) {
    const {output} = diffEls();
    if (!output) return;
    output.textContent = '';
    if (!text) {
        output.textContent = '两个文件内容相同。';
        return;
    }
    const lines = text.split('\n');
    const limit = 8000;
    const shown = lines.slice(0, limit);
    const fragment = document.createDocumentFragment();
    for (const line of shown) {
        const row = document.createElement('span');
        row.className = 'diff-line' + (line.startsWith('@@') ? ' diff-hunk' :
            line.startsWith('+') ? ' diff-add' :
                line.startsWith('-') ? ' diff-del' : ' diff-ctx');
        row.textContent = line || ' ';
        fragment.appendChild(row);
    }
    if (lines.length > limit) {
        const more = document.createElement('span');
        more.className = 'diff-line diff-hunk';
        more.textContent = '… 仅显示前 ' + limit + ' 行';
        fragment.appendChild(more);
    }
    output.appendChild(fragment);
}

function parseForDiff(path, text) {
    const driver = detectFormat(path, text);
    if (!driver || typeof driver.parse !== 'function') return null;
    try {
        return {driver, value: driver.parse(text)};
    } catch (e) {
        return null;
    }
}

async function runDiffCompare() {
    const elsD = diffEls();
    if (!elsD.a || !elsD.b || diffState.running) return;
    const pathA = elsD.a.value;
    const pathB = elsD.b.value;
    if (!pathA || !pathB) {
        elsD.summary.textContent = '请选择两个文件';
        return;
    }
    if (deps.samePathValue(pathA, pathB)) {
        elsD.summary.textContent = '两个文件相同，请选择不同的文件';
        return;
    }
    diffState.running = true;
    if (elsD.run) elsD.run.disabled = true;
    elsD.summary.textContent = '正在读取并比较…';
    try {
        const [textA, textB] = await Promise.all([diffReadText(pathA), diffReadText(pathB)]);
        const result = unifiedDiff(textA, textB);
        renderDiffText(result.text);
        let summary = (result.added || result.removed)
            ? '文本差异：+' + result.added + ' 行 / -' + result.removed + ' 行'
            : '文本内容相同';
        elsD.semanticList.textContent = '';
        elsD.semanticList.classList.add('hidden');
        if (elsD.semantic && elsD.semantic.checked) {
            const a = parseForDiff(pathA, textA);
            const b = parseForDiff(pathB, textB);
            if (a && b) {
                const entries = semanticDiff(a.value, b.value);
                summary += ' · 语义差异 ' + entries.length + ' 处';
                if (entries.length) {
                    const fragment = document.createDocumentFragment();
                    for (const entry of entries) {
                        const row = document.createElement('div');
                        row.className = 'diff-sem-row diff-sem-' + entry.kind;
                        const kind = document.createElement('span');
                        kind.className = 'diff-sem-kind';
                        kind.textContent = entry.kind === 'add' ? '新增' : (entry.kind === 'remove' ? '删除' : '修改');
                        const path = document.createElement('span');
                        path.className = 'diff-sem-path';
                        path.textContent = entry.path;
                        const value = document.createElement('span');
                        value.className = 'diff-sem-value';
                        value.textContent = semanticEntryText(entry);
                        row.append(kind, path, value);
                        row.addEventListener('click', () => deps.copyText(entry.path, '路径'));
                        fragment.appendChild(row);
                    }
                    elsD.semanticList.appendChild(fragment);
                    elsD.semanticList.classList.remove('hidden');
                }
            } else {
                summary += ' · 当前格式无可用的数据感知比较';
            }
        }
        elsD.summary.textContent = summary;
    } catch (e) {
        elsD.summary.textContent = '比较失败：' + ((e && e.message) || e);
        renderDiffText('');
    } finally {
        diffState.running = false;
        if (elsD.run) elsD.run.disabled = false;
    }
}

function bindDiffDialog() {
    const elsD = diffEls();
    if (!elsD.mask) return;
    if (elsD.run) elsD.run.addEventListener('click', runDiffCompare);
    if (elsD.close) elsD.close.addEventListener('click', closeDiffDialog);
    if (elsD.semantic) elsD.semantic.addEventListener('change', runDiffCompare);
    elsD.mask.addEventListener('mousedown', (e) => {
        if (e.target === elsD.mask) closeDiffDialog();
    });
    document.addEventListener('keydown', (e) => {
        if (!diffState.open || e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        closeDiffDialog();
    }, true);
}
bindDiffDialog();


    return {openDiffDialog};
}
