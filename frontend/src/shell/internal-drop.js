// internal-drop.js：应用内文件拖拽（文件树行 → 编辑区 / AI 面板 / 数据库面板）的落点处理。
//
// 与 OS 外部拖放（Wails 的 Files 链路 + window_drop.go）并行的第二条链路：
//   - 拖拽源在 explorer 的树行/列表行，dragstart 时写入自定义 MIME（core/drop-mime.js）；
//   - 本模块在 window 捕获阶段监听 dragover：识别自定义 MIME → 让落点可接收 + 挂高亮类
//     （复用外部拖放同一套 .file-drop-target-active 遮罩）；drop 时读回路径 → 交给路由。
//
// 为什么用 window 捕获而非给每个落点挂监听：落点是 index.html 上已有的 data-file-drop-target
// 元素，集中处理不必改各域；且捕获阶段先于 explorer 行的内部移动 drop 逻辑，能 stopPropagation
// 避免「拖到 AI 面板却触发了背后文件行的移动」。
//
// 只认自定义 MIME：编辑器选中文本拖拽（text/plain）、文件树内部移动（text/plain + .drop-target）
// 都不带它，完全不干预。
//
// 依赖注入（win/doc/now/...）使 node 可直测。

import {INTERNAL_PATHS_MIME, decodeDropPaths} from '../core/drop-mime.js';

const ACTIVE_CLASS = 'file-drop-target-active';
const DEFAULT_IDLE_MS = 300;

function hasInternalPaths(e) {
    if (!e || !e.dataTransfer || !e.dataTransfer.types) return false;
    // dragover 是高频事件（拖拽时 60–100Hz）：直接 indexOf，不 Array.from 分配临时数组。
    // dataTransfer.types 在 WebView2/Chromium 是 readonly string[]，indexOf 可用。
    try {
        return e.dataTransfer.types.indexOf(INTERNAL_PATHS_MIME) >= 0;
    } catch (err) {
        return false;
    }
}

// findDropTarget 从事件目标向上找最近的 [data-file-drop-target]（与 Wails runtime 的 closest 同口径）。
function findDropTarget(doc, target) {
    if (!target || typeof target.closest !== 'function') return null;
    try {
        return target.closest('[data-file-drop-target]');
    } catch (err) {
        return null;
    }
}

/**
 * installInternalDrop 挂应用内拖拽落点处理。
 * @param {object} win window
 * @param {object} doc document
 * @param {object} deps {onDrop(paths, route), now, setTimer, clearTimer, idleMs}
 * @returns {function} 卸载函数
 */
export function installInternalDrop(win, doc, deps) {
    if (!win || !doc || typeof win.addEventListener !== 'function') return () => {};
    const d = deps || {};
    const idleMs = Number(d.idleMs) > 0 ? Number(d.idleMs) : DEFAULT_IDLE_MS;
    const now = typeof d.now === 'function' ? d.now : () => Date.now();
    const setTimer = typeof d.setTimer === 'function' ? d.setTimer : (fn, ms) => setInterval(fn, ms);
    const clearTimer = typeof d.clearTimer === 'function' ? d.clearTimer : (id) => clearInterval(id);

    let lastOverAt = 0;
    let timer = 0;
    let activeTarget = null;

    function clear() {
        if (activeTarget && activeTarget.classList) activeTarget.classList.remove(ACTIVE_CLASS);
        activeTarget = null;
        stopTimer();
    }
    function stopTimer() {
        if (timer) { clearTimer(timer); timer = 0; }
    }
    function ensureTimer() {
        if (timer) return;
        timer = setTimer(() => { if (now() - lastOverAt > idleMs) clear(); }, idleMs);
    }

    function onOver(e) {
        if (!hasInternalPaths(e)) return;
        const target = findDropTarget(doc, e.target);
        if (!target) return;
        const route = target.getAttribute('data-file-drop-target') || '';
        // files 落点（文件树面板）保留 explorer 自己的「内部移动」语义，不接管。
        if (route === 'files') return;
        // 让落点可接收（否则 drop 不触发），并阻止冒泡到文件树行的内部移动逻辑。
        e.preventDefault();
        e.stopPropagation();
        try { e.dataTransfer.dropEffect = 'copy'; } catch (err) {}
        lastOverAt = now();
        if (activeTarget !== target) {
            if (activeTarget && activeTarget.classList) activeTarget.classList.remove(ACTIVE_CLASS);
            activeTarget = target;
        }
        if (activeTarget.classList) activeTarget.classList.add(ACTIVE_CLASS);
        ensureTimer();
    }

    function onLeave(e) {
        if (!hasInternalPaths(e)) return;
        // 离开窗口（relatedTarget=null）立即清；子元素间移动保留高亮。
        if (!e.relatedTarget) clear();
    }

    function onDrop(e) {
        if (!hasInternalPaths(e)) return;
        const target = findDropTarget(doc, e.target);
        if (!target) return;
        const route = target.getAttribute('data-file-drop-target') || '';
        // files 落点交给 explorer 内部移动逻辑，不在这里处理。
        if (route === 'files') return;
        e.preventDefault();
        e.stopPropagation();
        const paths = decodeDropPaths(e.dataTransfer.getData(INTERNAL_PATHS_MIME));
        clear();
        if (paths.length && typeof d.onDrop === 'function') d.onDrop(paths, route);
    }

    function onEnd() { clear(); }
    function onBlur() { clear(); }

    const listeners = [
        ['dragover', onOver, true],
        ['dragleave', onLeave, true],
        ['drop', onDrop, true],
        ['dragend', onEnd, true],
        ['blur', onBlur, false],
    ];
    for (const [type, fn, capture] of listeners) win.addEventListener(type, fn, capture);

    return function uninstall() {
        for (const [type, fn, capture] of listeners) win.removeEventListener(type, fn, capture);
        clear();
    };
}
