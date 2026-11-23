// aux-window-modes.js：辅助独立窗（便签 / 会话监控 / 文件对比 / 查看 / 实时预览）的启动编排。
// 从 main.js 拆出（phase4 M1），函数体逐字搬移；backend/rt/appEvents/applySettings/baseNameOf 经 deps 注入（getter 活引用）。

import {iconSvg} from '../core/icons.js';
import {createContextMenu} from './contextmenu.js';
import {normalizeTermText} from '../ai/tools/ai-terminal-tools.js';
import {createBridgeMemoView} from '../bridge/bridge-memo-view.js';
import {createAIMonitorView} from '../ai/agent/ai-monitor-view.js';
import {createDiffWindowView} from '../editor/diff-window-view.js';
import {createLightView} from '../editor/light-view.js';
import {createPreviewWindowView, pickPreviewKind} from '../editor/preview-window-view.js';

export function createAuxWindowModes(deps) {
    // 辅助窗的轻提示：没有状态栏，走底部浮动条（自管超时，不进弹层栈）。
    let auxToastTimer = 0;
    function auxToast(msg, isErr) {
        let host = document.getElementById('aux-toast');
        if (!host) {
            host = document.createElement('div');
            host.id = 'aux-toast';
            document.body.appendChild(host);
        }
        host.textContent = String(msg == null ? '' : msg);
        host.classList.toggle('error', !!isErr);
        host.classList.add('show');
        clearTimeout(auxToastTimer);
        auxToastTimer = setTimeout(() => host.classList.remove('show'), 2600);
    }

    function closeAuxWindowSelf() {
        try { if (window.runtime && window.runtime.WindowClose) window.runtime.WindowClose(); } catch (e) {}
    }

    // buildAuxWindowHead 辅助窗统一头部：标题 + 上下文胶囊 + 动作按钮。
    // 无边框窗口，头部即拖动区（body.*-only CSS 对 .aux-window-head 开 drag）。
    function buildAuxWindowHead({title, pill, pillTitle, actions}) {
        const head = document.createElement('div');
        head.className = 'aux-window-head';
        const label = document.createElement('span');
        label.className = 'aux-window-title';
        label.textContent = title;
        head.appendChild(label);
        if (pill) {
            const pillEl = document.createElement('span');
            pillEl.className = 'aux-window-pill';
            pillEl.textContent = pill;
            if (pillTitle) pillEl.title = pillTitle;
            head.appendChild(pillEl);
        }
        const spacer = document.createElement('div');
        spacer.className = 'aux-window-spacer';
        head.appendChild(spacer);
        for (const a of (actions || [])) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'aux-window-btn';
            btn.dataset.tip = a.tip || a.label || '';
            btn.setAttribute('aria-label', a.tip || a.label || '');
            btn.innerHTML = iconSvg(a.icon || 'close', 12);
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                a.onClick(e);
            });
            head.appendChild(btn);
        }
        return head;
    }

    // 便签独立窗口：桌面便签形态（置顶小窗）。复用主窗口同一套便签视图、
    // store 与租约（memoApi.flushAll 走同一落盘链），外部变更经 resource-changed 同步。
    async function startMemoWindowMode() {
        window.__auxWindowMode = 'memo';
        document.documentElement.classList.remove('app-booting');
        document.body.classList.add('memo-only');
        try { deps.applySettings(); } catch (e) {}
        let info = null;
        try { info = deps.backend.GetStartupMemo ? await deps.backend.GetStartupMemo() : null; } catch (e) {}
        if (!info || !info.scope) { closeAuxWindowSelf(); return; }
        const scope = info.scope === 'workspace' ? 'workspace' : 'global';
        const wsRoot = String(info.workspace || '');
        let memoFlush = () => {};
        const head = buildAuxWindowHead({
            title: '便签',
            pill: scope === 'workspace' ? (deps.baseNameOf(wsRoot) || '工作区') : '全局',
            pillTitle: scope === 'workspace' ? wsRoot : '全局便签',
            actions: [{
                icon: 'close',
                tip: '关闭',
                onClick: () => { memoFlush(); closeAuxWindowSelf(); },
            }],
        });
        const host = document.createElement('div');
        host.className = 'aux-window-body';
        document.body.append(head, host);
        const menu = createContextMenu();
        const memoView = createBridgeMemoView({
            get backend() { return deps.backend; },
            get flash() { return auxToast; },
            get els() { return {editor: host}; },
            get ctxMenu() { return menu; },
            get workspaceFolder() { return wsRoot; },
            get rt() { return deps.rt; },
            normalizeTermText,
            initialScope: () => scope,
        });
        memoView.createMemoView({memo: true});
        memoFlush = () => {
            try { if (memoView.memoApi && memoView.memoApi.flushAll) memoView.memoApi.flushAll().catch(() => {}); } catch (e) {}
        };
        // 外部变更同步：AI 写入 / 其他窗口保存 → 重载（与主窗口同一 resource-changed 链）。
        deps.appEvents.onApp('resource-changed', (payload) => memoView.memoOnResourceEvent(payload));
        // 关窗前 flush：防抖窗口内的最后一下编辑不落盘就丢了（1s 防抖 + mtime CAS 兜底）。
        window.addEventListener('pagehide', memoFlush, {once: true});
    }

    // 会话监控窗：只读镜像——渲染被监控会话/群聊的 JSONL 时间线并尾随流式事件。
    // 不改会话归属：原窗口继续持有回合租约，这里只看 + 停止 + 跳回发起窗口。
    async function startMonitorWindowMode() {
        window.__auxWindowMode = 'monitor';
        document.documentElement.classList.remove('app-booting');
        document.body.classList.add('monitor-only');
        try { deps.applySettings(); } catch (e) {}
        let info = null;
        try { info = deps.backend.GetStartupMonitorSession ? await deps.backend.GetStartupMonitorSession() : null; } catch (e) {}
        if (!info || !info.sessionId) { closeAuxWindowSelf(); return; }
        const monitor = createAIMonitorView({
            get backend() { return deps.backend; },
            get appEvents() { return deps.appEvents; },
            toast: auxToast,
            sessionId: String(info.sessionId),
            kind: info.kind === 'group' ? 'group' : 'session',
            workspace: String(info.workspace || ''),
            origin: String(info.origin || ''),
            onOpenHome: () => {
                if (info.origin && deps.backend.WindowFocusByName) deps.backend.WindowFocusByName(info.origin);
            },
            onClose: () => closeAuxWindowSelf(),
        });
        monitor.mount(document.body);
    }

    // 文件对比窗：读取两个文件 → 行级 diff + 可选语义差异，只读展示。
    async function startDiffWindowMode() {
        window.__auxWindowMode = 'diff';
        document.documentElement.classList.remove('app-booting');
        document.body.classList.add('diff-only');
        try { deps.applySettings(); } catch (e) {}
        let info = null;
        try { info = deps.backend.GetStartupDiff ? await deps.backend.GetStartupDiff() : null; } catch (e) {}
        if (!info || !info.left || !info.right) { closeAuxWindowSelf(); return; }
        const left = String(info.left);
        const right = String(info.right);
        let rerun = () => {};
        const head = buildAuxWindowHead({
            title: '文件对比',
            pill: (deps.baseNameOf(left) || left) + ' ↔ ' + (deps.baseNameOf(right) || right),
            pillTitle: left + '\n' + right,
            actions: [
                {
                    icon: 'refresh',
                    tip: '重新比较',
                    onClick: () => rerun(),
                },
                {icon: 'close', tip: '关闭', onClick: () => closeAuxWindowSelf()},
            ],
        });
        const host = document.createElement('div');
        host.className = 'aux-window-body';
        document.body.append(head, host);
        const view = createDiffWindowView({
            get backend() { return deps.backend; },
            toast: auxToast,
            left,
            right,
            baseNameOf: deps.baseNameOf,
            container: host,
            onTitle: (text) => {
                try { if (window.runtime && window.runtime.WindowSetTitle) window.runtime.WindowSetTitle(text + ' · 文件对比 · CaDt-DataLens'); } catch (e) {}
            },
        });
        view.mount();
        rerun = () => view.run();
    }

    // 轻量查看窗：一个文件一个只读窗（文本高亮 / 图片），不占工作区归属，
    // 不会与打开它的主窗口抢会话/监听/租约——「双击即看」的正路。
    async function startLightWindowMode() {
        window.__auxWindowMode = 'light';
        document.documentElement.classList.remove('app-booting');
        document.body.classList.add('light-only');
        try { deps.applySettings(); } catch (e) {}
        let info = null;
        try { info = deps.backend.GetStartupLight ? await deps.backend.GetStartupLight() : null; } catch (e) {}
        if (!info || !info.path) { closeAuxWindowSelf(); return; }
        const path = String(info.path);
        const head = buildAuxWindowHead({
            title: '查看',
            pill: deps.baseNameOf(path) || path,
            pillTitle: path,
            actions: [{icon: 'close', tip: '关闭', onClick: () => closeAuxWindowSelf()}],
        });
        const host = document.createElement('div');
        host.className = 'aux-window-body';
        document.body.append(head, host);
        const view = createLightView({
            get backend() { return deps.backend; },
            path,
            baseNameOf: deps.baseNameOf,
            container: host,
        });
        view.mount();
        try { if (window.runtime && window.runtime.WindowSetTitle) window.runtime.WindowSetTitle((deps.baseNameOf(path) || path) + ' · 查看 · CaDt-DataLens'); } catch (e) {}
    }

    // 实时预览外置窗：markdown/HTML/SVG/图片的只读镜像，轮询磁盘 mtime 跟随保存。
    // 源文件在主窗口编辑，预览窗只读——写作时预览丢第二屏的形态。
    async function startPreviewWindowMode() {
        window.__auxWindowMode = 'preview';
        document.documentElement.classList.remove('app-booting');
        document.body.classList.add('preview-only');
        try { deps.applySettings(); } catch (e) {}
        let info = null;
        try { info = deps.backend.GetStartupPreview ? await deps.backend.GetStartupPreview() : null; } catch (e) {}
        if (!info || !info.path) { closeAuxWindowSelf(); return; }
        const path = String(info.path);
        const head = buildAuxWindowHead({
            title: '实时预览',
            pill: deps.baseNameOf(path) || path,
            pillTitle: path,
            actions: [
                ...(info.origin && deps.backend.WindowFocusByName ? [{
                    icon: 'new-window',
                    tip: '回到主窗口',
                    onClick: () => deps.backend.WindowFocusByName(info.origin),
                }] : []),
                {icon: 'close', tip: '关闭', onClick: () => closeAuxWindowSelf()},
            ],
        });
        const host = document.createElement('div');
        host.className = 'aux-window-body';
        document.body.append(head, host);
        const view = createPreviewWindowView({
            get backend() { return deps.backend; },
            path,
            kind: pickPreviewKind(path),
            container: host,
        });
        view.mount();
        window.addEventListener('pagehide', () => view.dispose(), {once: true});
    }

    return {
        auxToast, closeAuxWindowSelf, buildAuxWindowHead,
        startMemoWindowMode, startMonitorWindowMode, startDiffWindowMode,
        startLightWindowMode, startPreviewWindowMode,
    };
}
