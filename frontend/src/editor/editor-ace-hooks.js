// editor-ace-hooks.js：从 editor-groups.js 拆出的域模块（factory + 显式依赖注入）。
// Ace 会话钩子：模式切换（applyAceMode）、折叠范围调整（import 圆括号块折进括号，
// 占位符保持 Ace 默认 "..."，块内容预览走悬停面板）、多光标、光标位置联动、python token 染色。
//
// deps 与 editor-groups 共用同一对象（main.js 传入的 getter 集），延迟求值。
import hljs from 'highlight.js/lib/common';
import {aceModeFor} from '../core/formats.js';
import {isDocReadOnly} from '../core/readonly.js';
import {setupEditorCompletion} from './editor-completion.js';

// ===== 折叠范围调整 =====
// 折叠范围调整：Go 的 import ( ) 块把圆括号本体折进去，折叠后才显示 import ...。
// 花括号块不动——Ace cstyle 范围起始在 { 之后、结束在 } 之前，配默认占位符正好渲染成 {...}。
// getLine: (row) => string；range 原对象改动后返回。纯函数，导出供测试。
export function adjustCodeFoldRange(getLine, range) {
    if (!range || !range.start || !range.end || range.range) return range;
    const startLine = String(getLine(range.start.row) || '');
    if (startLine.charAt(range.start.column - 1) !== '(') return range;
    if (!/^\s*import\b/.test(startLine.slice(0, range.start.column - 1))) return range;
    range.start.column -= 1;
    const endLine = String(getLine(range.end.row) || '');
    if (endLine.charAt(range.end.column) === ')') range.end.column += 1;
    return range;
}

// 折叠标记悬浮的原生 tooltip（"Fold code"/"Unfold code"）来自 Ace 的无障碍补齐：
// gutter 单元格（Gutter.$renderCell）与行内折叠胶囊（Text.$renderToken 对 fold token）
// 渲染时都会无条件 setAttribute("title", nls(...))，没有开关选项；翻译表置空也无效
// （nls 查表用 || 回退，空串会被跳过）。这里分别包一层 $renderCell / $renderToken，
// 渲染完把折叠标记上的 title 摘掉——空 title 不弹原生 tooltip。
// 一次性全局补丁（窗口内所有 Ace 编辑器共享原型），须在首个编辑器创建前调用；
// createEditorAceHooks 在 editor-groups 模块求值时执行，早于任何编辑器创建。
export function disableAceFoldWidgetTooltips() {
    if (typeof window === 'undefined' || !window.ace || typeof window.ace.require !== 'function') return;
    // gutter：$renderCell 返回 cell 配置对象，DOM 元素挂在 .element 上
    const Gutter = window.ace.require('ace/layer/gutter').Gutter;
    if (Gutter && Gutter.prototype && typeof Gutter.prototype.$renderCell === 'function' && !Gutter.prototype.$renderCell.__foldTitleStripped) {
        const origRenderCell = Gutter.prototype.$renderCell;
        const renderCell = function() {
            const cell = origRenderCell.apply(this, arguments);
            const el = (cell && cell.element) || cell;
            const widget = el && el.querySelector && el.querySelector('.ace_fold-widget[title]');
            if (widget) widget.removeAttribute('title');
            return cell;
        };
        renderCell.__foldTitleStripped = true;
        Gutter.prototype.$renderCell = renderCell;
    }
    // 文本层：title 在 $renderToken 对 fold token 设置、span 随行重建——在创建点摘，
    // 无论哪条渲染路径（$renderLine / $renderLinesFragment / 局部更新）都必经此处。
    // fold span 是本次 $renderToken 最后追加的子元素，token 过滤让非 fold 的调用零开销。
    const Text = window.ace.require('ace/layer/text').Text;
    if (Text && Text.prototype && typeof Text.prototype.$renderToken === 'function' && !Text.prototype.$renderToken.__foldTitleStripped) {
        const origRenderToken = Text.prototype.$renderToken;
        const renderToken = function(parent, screenColumn, token, value) {
            const next = origRenderToken.apply(this, arguments);
            if (token && token.type === 'fold' && parent) {
                const span = parent.lastElementChild;
                if (span && /ace_fold/.test(span.className)) span.removeAttribute('title');
            }
            return next;
        };
        renderToken.__foldTitleStripped = true;
        Text.prototype.$renderToken = renderToken;
    }
}

// ===== Ace hooks 入口 =====
export function createEditorAceHooks(deps) {
    disableAceFoldWidgetTooltips();

function applyAceMode(force) {
    if (!force && (deps.currentMode !== 'code' && deps.currentMode !== 'binary')) return;
    if (!deps.editor || !deps.editor.aceEditor) return;
    const want = aceModeFor(deps.file && deps.file.name, deps.file && deps.file.format);
    try {
        if (deps.editor.aceEditor.session.getMode().$id !== want) {
            deps.editor.aceEditor.session.setMode(want);
        }
        const container = deps.editor.aceEditor.container;
        for (const cls of Array.from(container.classList)) {
            if (cls.startsWith('ace-mode-')) container.classList.remove(cls);
        }
        container.classList.add('ace-mode-' + want.split('/').pop());
        const pureJson = !!(deps.file && deps.file.format && deps.file.format.id === 'json' && /\.json$/i.test(deps.file.name || ''));
        deps.editor.aceEditor.session.setUseWorker(pureJson);
        // 关闭 worker 后旧 JSON 校验注解不会自动消失（切到 Markdown 等模式仍留红叉）
        if (!pureJson) {
            try { deps.editor.aceEditor.session.clearAnnotations(); } catch (e) {}
        }
        deps.editor.aceEditor.setReadOnly(isDocReadOnly(deps.file, deps.settings));
        deps.editor.aceEditor.setFontSize(deps.settings.editorFont);
        deps.editor.aceEditor.session.setUseWrapMode(!!deps.settings.codeWrap);
        if (deps.file && deps.file.format) {
            const fs = deps.getFormatSettings(deps.file.format.id);
            const tab = fs.indent === 'tab';
            deps.editor.aceEditor.session.setUseSoftTabs(!tab);
            deps.editor.aceEditor.session.setTabSize(tab ? 4 : Number(fs.indent));
        }
        deps.editor.aceEditor.setDisplayIndentGuides(!!deps.settings.codeGuides);
        deps.editor.aceEditor.setHighlightIndentGuides(!!deps.settings.codeGuides);
        // 补全挂载（幂等）：必须在 applyEditorKeybindings 之前——键位表里的 startAutocomplete
        // 条目要等 language_tools 把命令挂上 commands 才能被 execFor 找到
        setupEditorCompletion(deps.editor.aceEditor, deps.file, deps.settings);
        hookCodeFoldRanges(deps.editor.aceEditor);
        hookMultiCursor(deps.editor.aceEditor);
        // 模式切换后重绑滚轮平滑滚动（幂等；若 jsoneditor 重建了 Ace 实例可恢复绑定）
        if (typeof deps.hookAceSmoothScroll === 'function') deps.hookAceSmoothScroll(deps.editor.aceEditor);
        // 模式切换后重绑编辑器内键位（幂等；若 jsoneditor 重建了 Ace 实例可恢复绑定）
        if (typeof deps.applyEditorKeybindings === 'function') deps.applyEditorKeybindings(deps.editor.aceEditor);
        hookPythonTokenClasses(deps.editor.aceEditor);
        hookCursorTracking(deps.editor.aceEditor);
    } catch (e) {
        console.warn('ace mode switch failed', e);
    }
}

const codeFoldLanguages = {
    json: 'json', json5: 'json', jsonl: 'json',
    yaml: 'yaml', xml: 'xml', html: 'xml', css: 'css',
    javascript: 'javascript', typescript: 'typescript',
    markdown: 'markdown', python: 'python', sh: 'bash', bash: 'bash',
    batchfile: 'dos', powershell: 'powershell', golang: 'go', go: 'go',
    java: 'java', kotlin: 'kotlin', lua: 'lua', sql: 'sql',
    toml: 'ini', ini: 'ini', properties: 'ini', text: 'plaintext',
};

let codeFoldHoverEl = null;
let codeFoldHoverGutter = null;
let codeFoldHoverCode = null;
let codeFoldHoverShowTimer = 0;
let codeFoldHoverHideTimer = 0;
let codeFoldHoverTarget = null;

// ===== 代码折叠悬停 =====
function ensureCodeFoldHover() {
    if (codeFoldHoverEl) return codeFoldHoverEl;
    codeFoldHoverEl = document.createElement('div');
    codeFoldHoverEl.id = 'code-fold-hover';
    codeFoldHoverEl.className = 'hidden';
    codeFoldHoverGutter = document.createElement('pre');
    codeFoldHoverGutter.className = 'code-fold-gutter';
    codeFoldHoverCode = document.createElement('pre');
    codeFoldHoverCode.className = 'code-fold-code';
    codeFoldHoverEl.append(codeFoldHoverGutter, codeFoldHoverCode);
    codeFoldHoverEl.addEventListener('mouseenter', () => {
        clearTimeout(codeFoldHoverHideTimer);
    });
    codeFoldHoverEl.addEventListener('mouseleave', () => {
        codeFoldHoverHideTimer = setTimeout(hideCodeFoldHover, 120);
    });
    document.body.appendChild(codeFoldHoverEl);
    return codeFoldHoverEl;
}

function hideCodeFoldHover() {
    clearTimeout(codeFoldHoverShowTimer);
    clearTimeout(codeFoldHoverHideTimer);
    codeFoldHoverTarget = null;
    if (codeFoldHoverEl) codeFoldHoverEl.classList.add('hidden');
}

function codeFoldLineFromEvent(e) {
    const target = e.target;
    if (!target || !target.closest) return null;
    const line = target.closest('.ace_line');
    if (!line || !line.querySelector('.ace_fold')) return null;
    const ace = deps.editor && deps.editor.aceEditor;
    if (!ace || !ace.container.contains(line)) return null;
    return line;
}

function codeFoldForLine(lineEl) {
    const ace = deps.editor && deps.editor.aceEditor;
    if (!ace || !lineEl || !ace.container.contains(lineEl)) return null;
    let row = null;
    try {
        const rect = lineEl.getBoundingClientRect();
        const position = ace.renderer.screenToTextCoordinates(rect.left + 1, rect.top + rect.height / 2);
        row = position.row;
    } catch (e) {
        return null;
    }
    const folds = ace.session.getAllFolds();
    const starts = folds.filter((fold) => fold.range && fold.range.start && fold.range.start.row === row);
    if (starts.length) {
        starts.sort((left, right) => right.range.end.row - left.range.end.row);
        return {ace, fold: starts[0]};
    }
    const containing = folds.find((fold) => fold.range && row >= fold.range.start.row && row <= fold.range.end.row);
    return containing ? {ace, fold: containing} : null;
}

function codeFoldLanguage(session) {
    const id = session && session.getMode ? String(session.getMode().$id || '').split('/').pop() : '';
    return codeFoldLanguages[id] || 'plaintext';
}

// 包装 session.addFold，建折叠前先调整范围。addFold 是 EditSession 构造时赋的实例属性，
// 不随 setMode 重绑，每个编辑器包一次即可覆盖全部建折路径（gutter 点击/foldAll/视图恢复）。
function hookCodeFoldRanges(ace) {
    if (!ace || ace._foldRangeHooked || typeof ace.session.addFold !== 'function') return;
    ace._foldRangeHooked = true;
    const session = ace.session;
    const origAddFold = session.addFold;
    session.addFold = function (placeholder, range) {
        if (range && !range.range) adjustCodeFoldRange((row) => session.getLine(row), range);
        return origAddFold.call(session, placeholder, range);
    };
}

// ===== 多光标处理 =====
// 多光标：Alt+单击添加光标；中键拖动建立列光标/矩形选区；普通单击回到单光标
function hookMultiCursor(ace) {
    if (!ace || ace._multiCursorHooked || !ace.container) return;
    ace._multiCursorHooked = true;
    try { ace.setOption('enableMultiselect', true); } catch (e) {}

    const pointAt = (e) => {
        try { return ace.renderer.screenToTextCoordinates(e.clientX, e.clientY); } catch (err) { return null; }
    };
    const rangeFor = (start, end) => {
        const range = ace.selection.getRange().clone();
        range.start = {row: start.row, column: start.column};
        range.end = {row: end.row, column: end.column};
        range.cursor = range.end;
        return range;
    };
    const refresh = () => {
        ace.renderer.updateCursor();
        ace.renderer.updateBackMarkers();
    };
    const applyRanges = (ranges) => {
        if (!ranges || !ranges.length) return;
        ace.selection.toSingleRange(ranges[0]);
        for (let i = 1; i < ranges.length; i++) ace.selection.addRange(ranges[i], true);
        refresh();
    };

    let drag = null;
    const onDragMove = (e) => {
        if (!drag) return;
        e.preventDefault();
        const end = pointAt(e);
        if (!end) return;
        const from = ace.session.documentToScreenPosition(drag.start);
        const to = ace.session.documentToScreenPosition(end);
        let ranges = [];
        try { ranges = ace.selection.rectangularRangeBlock(from, to) || []; } catch (err) {}
        applyRanges(ranges);
        ace.renderer.scrollCursorIntoView(end, 0.15);
    };
    const onDragEnd = (e) => {
        if (!drag) return;
        drag = null;
        e.preventDefault();
        e.stopPropagation();
        window.removeEventListener('mousemove', onDragMove, true);
        window.removeEventListener('mouseup', onDragEnd, true);
    };

    ace.container.addEventListener('mousedown', (e) => {
        if (e.target.closest && e.target.closest('.ace_gutter')) return;
        const altAdd = e.button === 0 && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey;
        const middle = e.button === 1;
        if (!altAdd && !middle) return;
        const pos = pointAt(e);
        if (!pos) return;
        e.preventDefault();
        e.stopPropagation();
        ace.focus();
        if (altAdd) {
            ace.selection.addRange(rangeFor(pos, pos));
            refresh();
            return;
        }
        ace.selection.toSingleRange(rangeFor(pos, pos));
        drag = {start: pos};
        refresh();
        window.addEventListener('mousemove', onDragMove, true);
        window.addEventListener('mouseup', onDragEnd, true);
    }, true);
    ace.container.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);
}

// ===== 光标跟踪 =====
function hookCursorTracking(ace) {
    if (!ace || ace._cursorTracked) return;
    ace._cursorTracked = true;
    const update = () => {
        if (deps.file && deps.currentMode === 'code' && deps.file.editor && deps.file.editor.aceEditor === ace) {
            deps.updateCursorPosition();
            if (deps.structurePanel) deps.structurePanel.setCursor(ace.getCursorPosition().row + 1);
        }
    };
    try {
        ace.selection.on('changeCursor', update);
        ace.on('focus', update);
    } catch (e) {}
}

// ===== Python token 类 =====
function applyPythonTokenClasses(ace) {
    if (!ace || !ace.container || !ace.container.classList.contains('ace-mode-python')) return;
    const layer = ace.container.querySelector('.ace_text-layer');
    if (!layer) return;
    for (const el of layer.querySelectorAll('.py-kwarg, .py-doc, .py-dunder, .py-decorator, .py-class')) {
        el.classList.remove('py-kwarg', 'py-doc', 'py-dunder', 'py-decorator', 'py-class');
    }
    for (const line of layer.querySelectorAll('.ace_line')) {
        const spans = [...line.children];
        // 整行都是字符串 → 三引号 docstring（PyCharm 文档字符串：弱绿斜体）
        const nonEmpty = spans.filter((sp) => (sp.textContent || '').trim());
        if (nonEmpty.length && nonEmpty.every((sp) => sp.classList.contains('ace_string'))) {
            for (const sp of nonEmpty) sp.classList.add('py-doc');
        }
        let depth = 0;
        let decoratorNamePending = false;
        for (let i = 0; i < spans.length; i++) {
            const span = spans[i];
            const text = span.textContent || '';
            const cls = span.classList;
            // 行首 @（前面只有空白）是装饰器而非矩阵乘：@ 本体与后随名字一起上装饰器色
            if (cls.contains('ace_keyword') && cls.contains('ace_operator') && text === '@'
                && !spans.slice(0, i).some((sp) => (sp.textContent || '').trim())) {
                span.classList.add('py-decorator');
                decoratorNamePending = true;
                continue;
            }
            if (decoratorNamePending) {
                decoratorNamePending = false;
                if (text.trim() && (cls.contains('ace_identifier') || cls.contains('ace_support'))) {
                    span.classList.add('py-decorator');
                    continue;
                }
            }
            for (const ch of text) {
                if (ch === '(') depth++;
                else if (ch === ')') depth = Math.max(0, depth - 1);
            }
            // def/class 的名字 span：回溯最近的关键字区分两者——dunder 方法名
            // （def __init__）→ 品红（PY.PREDEFINED_DEFINITION）；class 名 → 普通文本色；
            // 普通方法/函数名不加类，走 CSS 的函数色（与 PyCharm 函数声明同蓝）。
            if (cls.contains('ace_entity') && cls.contains('ace_function')) {
                let prevKeyword = '';
                for (let j = i - 1; j >= 0; j--) {
                    const t = (spans[j].textContent || '').trim();
                    if (!t) continue;
                    prevKeyword = t;
                    break;
                }
                if (prevKeyword === 'def' && /^__\w+__$/.test(text.trim())) span.classList.add('py-dunder');
                else if (prevKeyword === 'class') span.classList.add('py-class');
                continue;
            }
            if (depth <= 0 || !cls.contains('ace_identifier')) continue;
            const next = spans[i + 1];
            if (next && next.classList.contains('ace_keyword') && next.classList.contains('ace_operator') && next.textContent === '=') {
                span.classList.add('py-kwarg');
            }
        }
    }
}

// 补色必须发生在浏览器绘制前：击键会让 Ace 整行重建 DOM（py-* 类随重建丢失），
// 30ms 去抖 setTimeout 晚于绘制，肉眼看到「白→紫」闪烁（2026-11-22 修复）。
// MutationObserver 回调是微任务，在 Ace 渲染任务结束后、本帧绘制前同步执行；
// 本 pass 只改 class（观察器不监听 attributes），不会自触发观察回调。
function hookPythonTokenClasses(ace) {
    if (!ace || ace._pythonTokenHooked) return;
    const layer = ace.container && ace.container.querySelector('.ace_text-layer');
    if (!layer) return;
    ace._pythonTokenHooked = true;
    new MutationObserver(() => applyPythonTokenClasses(ace)).observe(layer, {childList: true, subtree: true});
    try {
        ace.renderer.on('afterRender', () => applyPythonTokenClasses(ace));
    } catch (e) {}
    applyPythonTokenClasses(ace);
}

// ===== 折叠悬停展示 =====
function showCodeFoldHover(lineEl) {
    const found = codeFoldForLine(lineEl);
    if (!found) return;
    const {ace, fold} = found;
    const start = fold.range.start.row;
    const end = fold.range.end.row;
    let lines = ace.session.getLines(start, end);
    const truncated = lines.length > 200;
    if (truncated) lines = lines.slice(0, 200);
    let text = lines.join('\n');
    if (truncated) text += '\n…';
    const gutterText = Array.from({length: lines.length}, (_, index) => String(start + 1 + index)).join('\n');
    ensureCodeFoldHover();
    codeFoldHoverGutter.textContent = gutterText;
    const language = codeFoldLanguage(ace.session);
    let highlighted = '';
    try {
        if (hljs.getLanguage(language)) highlighted = hljs.highlight(text, {language}).value;
    } catch (e) {}
    if (highlighted) codeFoldHoverCode.innerHTML = highlighted;
    else codeFoldHoverCode.textContent = text;
    codeFoldHoverEl.scrollTop = 0;
    codeFoldHoverEl.scrollLeft = 0;
    codeFoldHoverEl.style.visibility = 'hidden';
    codeFoldHoverEl.style.left = '0px';
    codeFoldHoverEl.style.top = '0px';
    codeFoldHoverEl.classList.remove('hidden');
    const width = codeFoldHoverEl.offsetWidth;
    const height = codeFoldHoverEl.offsetHeight;
    const rect = lineEl.getBoundingClientRect();
    const margin = 8;
    let left = Math.min(rect.left, window.innerWidth - width - margin);
    left = Math.max(margin, left);
    let top = rect.bottom + 4;
    if (top + height > window.innerHeight - margin) top = rect.top - height - 4;
    top = Math.max(margin, top);
    codeFoldHoverEl.style.left = left + 'px';
    codeFoldHoverEl.style.top = top + 'px';
    codeFoldHoverEl.style.visibility = '';
    codeFoldHoverTarget = lineEl;
}

function initCodeFoldHover() {
    if (!deps.els.editor) return;
    ensureCodeFoldHover();
    deps.els.editor.addEventListener('mouseover', (e) => {
        const line = codeFoldLineFromEvent(e);
        if (!line || line === codeFoldHoverTarget) return;
        if (!codeFoldForLine(line)) return;
        codeFoldHoverTarget = line;
        clearTimeout(codeFoldHoverShowTimer);
        clearTimeout(codeFoldHoverHideTimer);
        if (codeFoldHoverEl) codeFoldHoverEl.classList.add('hidden');
        codeFoldHoverShowTimer = setTimeout(() => showCodeFoldHover(line), 280);
    });
    deps.els.editor.addEventListener('mouseout', (e) => {
        const line = codeFoldLineFromEvent(e);
        const related = e.relatedTarget;
        if (related && ((line && line.contains(related)) || (codeFoldHoverEl && codeFoldHoverEl.contains(related)))) return;
        if (!codeFoldHoverTarget) return;
        if (line && line !== codeFoldHoverTarget) return;
        clearTimeout(codeFoldHoverShowTimer);
        codeFoldHoverHideTimer = setTimeout(hideCodeFoldHover, 140);
    });
    document.addEventListener('pointerdown', (e) => {
        if (codeFoldHoverEl && e.target && codeFoldHoverEl.contains(e.target)) return;
        hideCodeFoldHover();
    }, true);
    window.addEventListener('scroll', (e) => {
        if (codeFoldHoverEl && e.target && codeFoldHoverEl.contains(e.target)) return;
        hideCodeFoldHover();
    }, true);
    window.addEventListener('resize', hideCodeFoldHover);
    window.addEventListener('blur', hideCodeFoldHover);
}

    return {
        applyAceMode,
        hookCodeFoldRanges,
        hookMultiCursor,
        hookCursorTracking,
        applyPythonTokenClasses,
        hookPythonTokenClasses,
        initCodeFoldHover,
        hideCodeFoldHover,
    };
}
