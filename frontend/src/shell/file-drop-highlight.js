// file-drop-highlight.js：外部拖放高亮（file-drop-target-active 类）的兜底清理。
//
// 背景：这个类由 Wails v3 runtime 内部加/减（runtime/src/window.ts 的 setupDropTargetListeners），
// 但它的 dragleave 处理器在 relatedTarget === null（离开窗口）时明确 return，且没有 dragend
// 处理。OS 文件拖放的 dragend 只在拖拽源（资源管理器）触发，本窗口永远收不到——于是
// 「拖进 AI 面板 → 再挪回文件夹 / 拖到别的窗口」时，类没人摘，提示遮罩永久悬浮。
//
// 兜底策略（不依赖 runtime 的单次 dragleave）：
//   1. dragover（Files）→ 更新心跳；只要还在落点上，runtime 会持续加类，我们不碰。
//   2. 心跳超时（默认 200ms 没 dragover）→ 清全部高亮。拖出窗口后 dragover 停止，
//      这是唯一还能观察到的「拖拽已离开」信号，能覆盖 dragleave 丢失的场景。
//   3. dragleave(relatedTarget==null) / drop / dragend / window blur → 立即清。
//
// 所有 DOM 与时钟依赖经参数注入（win/doc/now/setTimer/clearTimer），node 可直测。
// 只处理含 Files 的拖拽：文件树内部拖拽是 text/plain，用的是另一套 .drop-target 类，互不干扰。

const ACTIVE_CLASS = 'file-drop-target-active';
const DEFAULT_IDLE_MS = 300;

function hasFiles(e) {
    if (!e || !e.dataTransfer || !e.dataTransfer.types) return false;
    // dragover 高频（拖拽时 60–100Hz）：indexOf 避免 Array.from 每次分配临时数组。
    try {
        return e.dataTransfer.types.indexOf('Files') >= 0;
    } catch (err) {
        return false;
    }
}

/**
 * installDropHighlightFallback 挂兜底监听。
 * @param {object} win window（提供 addEventListener/removeEventListener）
 * @param {object} doc document（提供 querySelectorAll）
 * @param {object} [opts] {idleMs, now, setTimer, clearTimer}
 * @returns {function} 卸载函数（摘监听 + 停定时器 + 清残留高亮）
 */
export function installDropHighlightFallback(win, doc, opts) {
    if (!win || !doc || typeof win.addEventListener !== 'function') return () => {};
    const o = opts || {};
    const idleMs = Number(o.idleMs) > 0 ? Number(o.idleMs) : DEFAULT_IDLE_MS;
    const now = typeof o.now === 'function' ? o.now : () => Date.now();
    const setTimer = typeof o.setTimer === 'function' ? o.setTimer : (fn, ms) => setInterval(fn, ms);
    const clearTimer = typeof o.clearTimer === 'function' ? o.clearTimer : (id) => clearInterval(id);

    let lastOverAt = 0;
    let timer = 0;

    function clear() {
        let removed = 0;
        try {
            const nodes = doc.querySelectorAll('.' + ACTIVE_CLASS);
            for (const node of nodes) {
                if (node && node.classList && node.classList.contains(ACTIVE_CLASS)) {
                    node.classList.remove(ACTIVE_CLASS);
                    removed++;
                }
            }
        } catch (err) {
            // 兜底路径：DOM 查询失败不能再抛（拖放清理不该中断主流程）
        }
        stopTimer();
        return removed;
    }

    function stopTimer() {
        if (timer) {
            clearTimer(timer);
            timer = 0;
        }
    }

    function ensureTimer() {
        if (timer) return;
        timer = setTimer(() => {
            if (now() - lastOverAt > idleMs) clear();
        }, idleMs);
    }

    function onOver(e) {
        if (!hasFiles(e)) return;
        lastOverAt = now();
        // 只在已经有高亮时开心跳（普通文件拖拽不进落点时没类，不必起定时器）
        try {
            if (doc.querySelector('.' + ACTIVE_CLASS)) ensureTimer();
        } catch (err) {}
    }

    function onLeave(e) {
        if (!hasFiles(e)) return;
        // 子元素间移动 relatedTarget 非 null，交给 runtime 处理；离开窗口才由我们补。
        if (!e.relatedTarget) clear();
    }

    function onEnd() { clear(); }
    function onDrop() { clear(); }
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
