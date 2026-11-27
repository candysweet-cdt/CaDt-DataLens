// editor-plugin-view.js：插件自定义视图（cadt.registerViewer）的宿主运行时。
//
// 形态与图片 / 视频 / 音频视图一致——**覆盖层**：底层 JSONEditor 照常创建并持有内容，
// 插件视图是 pane 里的一个绝对定位容器。切走就 destroy 并清空容器，切回来重新 mount，
// 所以不存在「视图实例跟着标签页活一整天」的隐性状态。
//
// 四条硬约束（docs/unfinished-plans/plugin-extension-roadmap.md 2.2）：
//   1. 视图只渲染不改数据——ctx 没有写接口，写回一律经 requestSave 上抛编辑器；
//   2. 必须能 destroy：切视图 / 关标签一律调用（closeDocNow → disposePluginView）；
//   3. >10 MB 与二进制档不挂插件视图（判定单一来源在 shell/plugin-viewers.js）；
//   4. 主题切换调 setTheme，不重挂。
import {isDocReadOnly} from '../core/readonly.js';
import {PLUGIN_CTX_ORIGINS, pluginCtxBase, withCtx} from '../shell/plugin-ctx.js';
import {
    getPluginViewerByMode, isPluginViewMode, pluginViewerBlockedReason, viewerIdFromMode,
} from '../shell/plugin-viewers.js';

export function createEditorPluginView(deps) {

// 已 mount 的 doc 集合：主题变更时只遍历这些（不扫全部标签页）
const live = new Set();
let themeObserver = null;

function currentTheme() {
    const root = document.documentElement;
    return (root && root.dataset && root.dataset.theme) || 'dark';
}

function docText(doc) {
    const editor = doc && doc.editor;
    if (editor) {
        try {
            const text = editor.getText();
            if (typeof text === 'string') return text;
        } catch (e) {
            // 树视图遇到当前内容解析不了时会抛：退回最近一次快照文本（尽力而为）
        }
    }
    if (!doc) return '';
    return String(doc.text != null ? doc.text : (doc.content || ''));
}

function docSelection(doc) {
    const ace = doc && doc.editor && doc.editor.aceEditor;
    if (!ace) return null;
    try {
        const range = ace.getSelectionRange();
        const model = ace.session.doc;
        return {
            start: model.positionToIndex(range.start),
            end: model.positionToIndex(range.end),
        };
    } catch (e) {
        return null;
    }
}

function setDocSelection(doc, sel) {
    const ace = doc && doc.editor && doc.editor.aceEditor;
    if (!ace || !sel) return false;
    try {
        const Range = ace.Range || (window.ace && window.ace.require && window.ace.require('ace/range').Range);
        if (!Range) return false;
        const model = ace.session.doc;
        const length = model.getLength();
        const start = Math.max(0, Math.min(length, Number(sel.start) || 0));
        const rawEnd = sel.end == null ? start : Number(sel.end);
        const end = Math.max(start, Math.min(length, Number.isFinite(rawEnd) ? rawEnd : start));
        const from = model.indexToPosition(start);
        const to = model.indexToPosition(end);
        ace.selection.setRange(new Range(from.row, from.column, to.row, to.column));
        ace.focus();
        return true;
    } catch (e) {
        return false;
    }
}

// 写回：只走编辑器文本通道，脏标记与只读判定全用既有实现。
// 视图自己绝不碰 doc.content / doc.dirty —— 那是「插件绕过脏标记」的口子。
function requestSave(doc, text) {
    if (!doc || typeof text !== 'string') return false;
    if (isDocReadOnly(doc, deps.settings)) {
        deps.flash('只读模式下插件视图不能写回内容', true);
        return false;
    }
    const editor = doc.editor;
    if (!editor) return false;
    const mode = doc.mode;
    const loading = doc.loading;
    doc.loading = true;
    try {
        let inner = 'code';
        try {
            inner = editor.getMode && editor.getMode() === 'text' ? 'text' : 'code';
        } catch (e) {
            inner = 'code';
        }
        try {
            if (editor.getMode && editor.getMode() === 'tree') editor.setMode(inner);
        } catch (e) {
            // 树视图切代码失败（内容与结构格式不符）：仍然按文本写入，由编辑器自报错误
        }
        editor.setText(text);
        doc.text = text;
    } catch (e) {
        deps.flash('写回失败：' + ((e && e.message) || e), true);
        return false;
    } finally {
        doc.loading = loading;
    }
    // setMode 触发的 onModeChange 会把 doc.mode 改成 code：恢复插件模式再算脏，
    // 否则 bases[mode] 比对错位、状态栏也会显示成代码视图。
    doc.mode = mode;
    if (deps.file === doc) deps.currentMode = mode;
    deps.markDocDirty(doc);
    deps.updateStatus();
    return true;
}

function buildContext(doc, viewer) {
    const callbacks = new Set();
    doc.pluginViewCallbacks = callbacks;
    doc.pluginViewNotify = (text) => {
        for (const cb of [...callbacks]) {
            try {
                cb(text);
            } catch (e) {
                console.warn('[plugin-viewer] onChange 回调抛错：', e);
            }
        }
    };
    // 身份与位置走 shell/plugin-ctx.js 的基座（plugin / workspace / origin 恒存在）；
    // source 是历史键（对象形态，{path,name,size}），doc 是同一对象的语义明确别名——
    // 导入器 / 导出转换器那边 source 是字符串场景名，两者不能同名同义，见 plugin-ctx.js 头注释。
    const docRef = {path: doc.path || '', name: doc.name || '', size: Number(doc.size || 0) || 0};
    return withCtx(pluginCtxBase({
        pluginId: viewer.pluginId,
        pluginName: viewer.pluginName,
        workspace: deps.workspaceFolder || '',
        sessionId: '',
        origin: PLUGIN_CTX_ORIGINS.editor,
    }), {
        viewerId: viewer.id,
        mode: viewer.mode,
        pluginId: viewer.pluginId,
        pluginName: viewer.pluginName,
        source: docRef,
        doc: docRef,
        readOnly: isDocReadOnly(doc, deps.settings),
        getData: () => docText(doc),
        getSelection: () => docSelection(doc),
        setSelection: (sel) => setDocSelection(doc, sel),
        getTheme: currentTheme,
        onChange: (cb) => {
            if (typeof cb !== 'function') return () => {};
            callbacks.add(cb);
            return () => callbacks.delete(cb);
        },
        requestSave: (text) => requestSave(doc, text),
        flash: (msg, isError) => deps.flash(String(msg == null ? '' : msg), !!isError),
    });
}

function ensureHost(doc) {
    if (!doc || !doc.pane) return null;
    if (doc.pluginViewHost && doc.pluginViewBody) return doc.pluginViewHost;
    const host = document.createElement('div');
    host.className = 'plugin-view-host';
    const body = document.createElement('div');
    body.className = 'plugin-view-body';
    host.appendChild(body);
    doc.pane.appendChild(host);
    doc.pluginViewHost = host;
    doc.pluginViewBody = body;
    return host;
}

// 拆掉当前 mount：destroy → 清容器 → 断观察者。可重复调用（幂等）。
function teardown(doc) {
    if (!doc) return;
    live.delete(doc);
    const handle = doc.pluginViewHandle;
    doc.pluginViewHandle = null;
    doc.pluginViewMode = '';
    doc.pluginViewCallbacks = null;
    doc.pluginViewNotify = null;
    if (doc.pluginViewObserver) {
        try {
            doc.pluginViewObserver.disconnect();
        } catch (e) {
            // 观察者已断开 / 环境不支持：忽略（清理路径，不影响功能）
        }
        doc.pluginViewObserver = null;
    }
    if (doc.pluginViewFrame) {
        cancelAnimationFrame(doc.pluginViewFrame);
        doc.pluginViewFrame = 0;
    }
    if (handle && typeof handle.destroy === 'function') {
        try {
            handle.destroy();
        } catch (e) {
            // 插件的 destroy 抛错不能影响关标签 / 切视图：记一条诊断继续清理
            console.warn('[plugin-viewer] destroy 抛错：', e);
        }
    }
    const body = doc.pluginViewBody;
    if (body) body.textContent = '';
}

function callResize(doc) {
    const handle = doc && doc.pluginViewHandle;
    if (!handle || typeof handle.resize !== 'function') return;
    try {
        handle.resize();
    } catch (e) {
        console.warn('[plugin-viewer] resize 抛错：', e);
    }
}

// 布局变化（分栏拖拽 / 窗口缩放 / 面板开合）合并成一次 resize：只走 rAF，不重建视图
function scheduleResize(doc) {
    if (!doc || doc.pluginViewFrame) return;
    doc.pluginViewFrame = requestAnimationFrame(() => {
        doc.pluginViewFrame = 0;
        callResize(doc);
    });
}

function ensureThemeObserver() {
    if (themeObserver) return;
    const root = document.documentElement;
    if (!root || typeof MutationObserver !== 'function') return;
    // 主题切换的唯一出口是 html[data-theme]（settings-ui 的 applySettings / 插件主题）：
    // 盯属性比在每个切换入口插一行更可靠，也不会漏掉插件主题。
    themeObserver = new MutationObserver(() => applyTheme());
    themeObserver.observe(root, {attributes: true, attributeFilter: ['data-theme']});
}

function applyTheme() {
    const theme = currentTheme();
    for (const doc of live) {
        const handle = doc.pluginViewHandle;
        if (!handle || typeof handle.setTheme !== 'function') continue;
        try {
            handle.setTheme(theme);
        } catch (e) {
            console.warn('[plugin-viewer] setTheme 抛错：', e);
        }
    }
}

function mountFor(doc) {
    const viewer = getPluginViewerByMode(doc && doc.mode);
    if (!viewer) {
        deps.flash('插件视图不可用（插件已禁用或卸载）', true);
        return false;
    }
    const blocked = pluginViewerBlockedReason(viewer, doc);
    if (blocked) {
        deps.flash(blocked, true);
        return false;
    }
    const host = ensureHost(doc);
    if (!host) return false;
    teardown(doc);
    const ctx = buildContext(doc, viewer);
    let handle = null;
    try {
        handle = viewer.mount(doc.pluginViewBody, ctx);
    } catch (e) {
        console.warn('[plugin-viewer] mount 抛错：', e);
        doc.pluginViewNotify = null;
        doc.pluginViewCallbacks = null;
        if (doc.pluginViewBody) doc.pluginViewBody.textContent = '';
        deps.flash('插件视图「' + viewer.label + '」加载失败：' + ((e && e.message) || e), true);
        return false;
    }
    if (handle && typeof handle === 'object') {
        doc.pluginViewHandle = handle;
    } else {
        // 允许 mount 直接返回 undefined（插件不关心重排 / 主题）：补一个空壳，
        // 免得后面每次都要判空——destroy 也按空操作处理。
        doc.pluginViewHandle = {};
    }
    doc.pluginViewMode = doc.mode;
    live.add(doc);
    ensureThemeObserver();
    if (typeof ResizeObserver === 'function' && doc.pluginViewHost) {
        doc.pluginViewObserver = new ResizeObserver(() => scheduleResize(doc));
        doc.pluginViewObserver.observe(doc.pluginViewHost);
    }
    return true;
}

function showPluginView(doc) {
    if (!doc || !doc.pane) return false;
    if (!doc.pluginViewHandle || doc.pluginViewMode !== doc.mode) {
        if (!mountFor(doc)) return false;
    }
    doc.pane.classList.add('plugin-view-active');
    scheduleResize(doc);
    return true;
}

function hidePluginView(doc) {
    if (!doc) return;
    if (doc.pane) doc.pane.classList.remove('plugin-view-active');
    teardown(doc);
}

// 切到插件视图：与 enterImageView / enterBinaryView 同构（先收起其它覆盖层再定位模式）
function enterPluginView(doc, mode) {
    if (!doc || !doc.editor || !isPluginViewMode(mode)) return;
    const previous = doc.mode;
    deps.hideImageView(doc);
    deps.hideVideoView(doc);
    deps.hideAudioView(doc);
    doc.mode = mode;
    deps.currentMode = mode;
    if (!showPluginView(doc)) {
        // 挂不上（插件被卸载 / 文件超限 / mount 抛错）：退回切换前的视图，不留白屏
        hidePluginView(doc);
        const back = previous && !isPluginViewMode(previous) ? previous : 'text';
        doc.mode = back;
        deps.currentMode = back;
        try {
            deps.editor.setMode(back === 'tree' ? 'tree' : back === 'text' ? 'text' : 'code');
        } catch (e) {
            // 回退失败也要让底层编辑器至少是可见的：忽略异常，状态栏会用 doc.mode 反映实际
        }
        if (doc.pane) doc.pane.classList.add('active');
    }
    deps.applyAceMode();
    deps.showBanner(doc, doc.parseError);
    deps.updateStatus();
    deps.updateSearchState();
}

// 关标签：销毁视图并摘掉挂载点（closeDocNow 调用；漏了不报错但会泄漏）
function disposePluginView(doc) {
    if (!doc) return;
    teardown(doc);
    if (doc.pane) doc.pane.classList.remove('plugin-view-active');
    if (doc.pluginViewHost) {
        doc.pluginViewHost.remove();
        doc.pluginViewHost = null;
    }
    doc.pluginViewBody = null;
}

// 当前文档的视图是否还能挂（插件被卸载后标签页停在旧模式时，createDocEditor 用它回落）
function pluginViewAvailable(mode) {
    return !!getPluginViewerByMode(mode);
}

return {
    applyTheme,
    disposePluginView,
    enterPluginView,
    hidePluginView,
    pluginViewAvailable,
    requestSave,
    scheduleResize,
    showPluginView,
    viewerIdFromMode,
};
}
