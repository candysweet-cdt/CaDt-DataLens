// 调试控制台：两种形态共用同一套渲染与采集逻辑。
//  1) 停靠模式（默认）：挂载到底部面板容器（#debug-view），与终端共用面板、可互相切换；
//  2) 独立窗口模式：由主窗口「独立窗口」按钮拉起新进程（--new-window --debug-console），
//     全窗口渲染，日志通过 remote 轮询跨进程中继文件获取。
// 只做采集与展示，不阻塞主界面：日志进入环形缓冲，rAF 批量追加，DOM 节点有上限。
//
// 用法（main.js）：
//   const dc = createDebugConsole({mount: document.getElementById('debug-view'), relay, onDetach, onClose});
//   console[level] 补丁里调用 dc.push(level, args)
import {iconSvg} from './icons.js';

const MAX_ENTRIES = 600;       // 缓冲条数上限
const MAX_TEXT = 4000;         // 单条文本长度上限
const LEVELS = {debug: '调试', info: '信息', warn: '警告', error: '错误'};
const LEVEL_ALIAS = {log: 'info', info: 'info', debug: 'debug', warn: 'warn', error: 'error', trace: 'debug'};

function formatArg(arg) {
    if (arg == null) return String(arg);
    const t = typeof arg;
    if (t === 'string') return arg;
    if (t === 'number' || t === 'boolean' || t === 'bigint') return String(arg);
    if (t === 'function') return '[Function ' + (arg.name || 'anonymous') + ']';
    if (arg instanceof Error) {
        const head = (arg.name || 'Error') + ': ' + (arg.message || '');
        const stack = String(arg.stack || '').split('\n').slice(1, 4).join('\n');
        return stack ? head + '\n' + stack : head;
    }
    try {
        const seen = new WeakSet();
        const json = JSON.stringify(arg, (k, v) => {
            if (typeof v === 'object' && v !== null) {
                if (seen.has(v)) return '[Circular]';
                seen.add(v);
            }
            if (typeof v === 'function') return '[Function]';
            return v;
        }, 2);
        if (typeof json === 'string') return json;
    } catch (e) {}
    try { return String(arg); } catch (e) { return Object.prototype.toString.call(arg); }
}

function fmtTime(d) {
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

export function createDebugConsole(opts = {}) {
    // detached：独立窗口模式（全窗口、无拖拽、关闭即关窗）；
    // mount：停靠模式的挂载容器；remote：从外部源轮询日志（独立窗口用）；
    // relay：把本地捕获的日志批量转出（主窗口用，跨进程喂给独立窗口）。
    const detached = !!opts.detached;
    const mount = opts.mount || null;
    const remote = typeof opts.remote === 'function' ? opts.remote : null;
    const relay = typeof opts.relay === 'function' ? opts.relay : null;
    const onDetach = typeof opts.onDetach === 'function' ? opts.onDetach : null;
    const onClose = typeof opts.onClose === 'function' ? opts.onClose : null;
    const onExport = typeof opts.onExport === 'function' ? opts.onExport : null;
    const entries = [];   // {level, text, time}
    const counts = {debug: 0, info: 0, warn: 0, error: 0};
    const filters = {debug: true, info: true, warn: true, error: true};
    let opened = !detached;   // 停靠模式始终处于"显示"状态（可见性由父容器控制）
    let bodyEl = null;
    let flushScheduled = false;
    let dirty = false;
    let stick = true;
    let relayQueue = [];
    let relayTimer = 0;

    // ---------- 面板骨架 ----------
    const panel = document.createElement('div');
    panel.className = 'dbg-console ' + (detached ? 'detached hidden' : 'docked');
    panel.innerHTML =
        '<div class="dbg-head">' +
            '<span class="dbg-title">调试控制台</span>' +
            '<div class="dbg-chips">' +
                Object.keys(LEVELS).map((lv) =>
                    '<button type="button" class="dbg-chip" data-level="' + lv + '" title="显示/隐藏' + LEVELS[lv] + '">' +
                        LEVELS[lv] + '<span class="dbg-chip-count">0</span></button>').join('') +
            '</div>' +
            '<div class="dbg-tools">' +
                (!detached && onDetach ?
                    '<button type="button" class="dbg-btn" data-act="detach" title="在独立窗口中打开">' + iconSvg('new-window', 12) + '</button>' : '') +
                '<button type="button" class="dbg-btn" data-act="export" title="导出日志">' + iconSvg('download', 12) + '</button>' +
                '<button type="button" class="dbg-btn" data-act="copy" title="复制全部日志">' + iconSvg('copy', 12) + '</button>' +
                '<button type="button" class="dbg-btn" data-act="clear" title="清空">' + iconSvg('eraser', 12) + '</button>' +
                '<button type="button" class="dbg-btn" data-act="close" title="' + (detached ? '关闭窗口 (F12)' : '关闭面板') + '">' +
                    iconSvg('close', 12) + '</button>' +
            '</div>' +
        '</div>' +
        '<div class="dbg-body"></div>';
    if (detached || !mount) document.body.appendChild(panel);
    else mount.appendChild(panel);
    bodyEl = panel.querySelector('.dbg-body');
    // 用户停留在底部时跟随新日志；上滚查看历史时保持位置
    bodyEl.addEventListener('scroll', () => {
        stick = bodyEl.scrollTop + bodyEl.clientHeight >= bodyEl.scrollHeight - 24;
    });

    // ---------- 渲染 ----------
    function makeRow(entry, frag) {
        const row = document.createElement('div');
        row.className = 'dbg-row lvl-' + entry.level;
        const time = document.createElement('span');
        time.className = 'dbg-time';
        time.textContent = entry.time;
        const lvl = document.createElement('span');
        lvl.className = 'dbg-lvl';
        lvl.textContent = entry.level === 'error' ? 'E' : entry.level === 'warn' ? 'W' : entry.level === 'info' ? 'I' : 'D';
        const msg = document.createElement('span');
        msg.className = 'dbg-msg';
        msg.textContent = entry.text;
        row.append(time, lvl, msg);
        frag.appendChild(row);
    }

    function applyFilters() {
        for (const lv of Object.keys(filters)) {
            panel.classList.toggle('hide-' + lv, !filters[lv]);
        }
        for (const chip of panel.querySelectorAll('.dbg-chip')) {
            chip.classList.toggle('off', !filters[chip.dataset.level]);
        }
    }

    function updateCounts() {
        for (const chip of panel.querySelectorAll('.dbg-chip')) {
            const c = chip.querySelector('.dbg-chip-count');
            const n = counts[chip.dataset.level] || 0;
            c.textContent = n > 999 ? '999+' : String(n);
        }
    }

    function renderAll() {
        bodyEl.textContent = '';
        const frag = document.createDocumentFragment();
        for (const e of entries) makeRow(e, frag);
        bodyEl.appendChild(frag);
        updateCounts();
        bodyEl.scrollTop = bodyEl.scrollHeight;
        stick = true;
    }

    function flush() {
        if (!opened || !dirty) return;
        dirty = false;
        // 只增量追加：缓冲区截断时整表重绘
        const frag = document.createDocumentFragment();
        const rendered = bodyEl.childElementCount;
        if (entries.length < rendered) {
            renderAll();
            return;
        }
        for (let i = rendered; i < entries.length; i++) makeRow(entries[i], frag);
        if (frag.childNodes.length) {
            bodyEl.appendChild(frag);
            while (bodyEl.childElementCount > MAX_ENTRIES) bodyEl.removeChild(bodyEl.firstElementChild);
            if (stick) bodyEl.scrollTop = bodyEl.scrollHeight;
        }
        updateCounts();
    }

    function scheduleFlush() {
        dirty = true;
        if (flushScheduled) return;
        flushScheduled = true;
        const run = () => {
            if (!flushScheduled) return;
            flushScheduled = false;
            flush();
        };
        // 正常用 rAF 合帧；页面在后台时 rAF 会被暂停，用定时器兜底保证实时性
        if (!document.hidden && typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(run);
            setTimeout(run, 150);
        } else {
            setTimeout(run, 16);
        }
    }

    // ---------- 采集与转发 ----------
    function scheduleRelay() {
        if (!relay || relayTimer || !relayQueue.length) return;
        relayTimer = setTimeout(() => {
            relayTimer = 0;
            if (!relayQueue.length) return;
            const batch = relayQueue;
            relayQueue = [];
            try { relay(batch); } catch (e) {}
        }, 150);
    }

    function addEntry(level, text, time) {
        const lv = LEVEL_ALIAS[level] || 'info';
        let t = String(text == null ? '' : text);
        if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT) + '…';
        const entry = {level: lv, text: t, time: time || fmtTime(new Date())};
        entries.push(entry);
        counts[lv] = (counts[lv] || 0) + 1;
        if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
        scheduleFlush();
        if (relay) {
            relayQueue.push({t: entry.time, lv: entry.level, msg: entry.text});
            if (relayQueue.length > 400) relayQueue.splice(0, relayQueue.length - 400);
            scheduleRelay();
        }
    }

    function push(level, args) {
        const text = Array.isArray(args) ? args.map(formatArg).join(' ') : formatArg(args);
        addEntry(level, text);
    }

    // ---------- 显示控制（独立窗口用；停靠模式由父容器控制） ----------
    function open() {
        if (opened || !detached) return;
        opened = true;
        panel.classList.remove('hidden');
        renderAll();
    }

    function close() {
        if (!opened || !detached) return;
        opened = false;
        panel.classList.add('hidden');
    }

    function toggle() {
        if (!detached) return;
        if (opened) close();
        else open();
    }

    // ---------- 交互 ----------
    function exportLog() {
        if (!onExport) return;
        if (!entries.length) return;
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const date = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
        const clock = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
        const name = 'debug-console-' + date + '_' + clock.replace(/:/g, '-') + '.log';
        const head =
            '# CaDt-DataLens 调试控制台导出\n' +
            '# 时间: ' + date + ' ' + clock + '\n' +
            '# 条数: ' + entries.length + '（调试 ' + counts.debug + ' / 信息 ' + counts.info +
            ' / 警告 ' + counts.warn + ' / 错误 ' + counts.error + '）\n\n';
        const body = entries.map((en) => '[' + en.time + '] [' + LEVELS[en.level] + '] ' + en.text).join('\n');
        Promise.resolve(onExport(name, head + body)).catch(() => {});
    }

    panel.addEventListener('click', (e) => {
        const chip = e.target.closest('.dbg-chip');
        if (chip) {
            const lv = chip.dataset.level;
            filters[lv] = !filters[lv];
            applyFilters();
            return;
        }
        const act = e.target.closest('.dbg-btn')?.dataset.act;
        if (!act) return;
        if (act === 'close') {
            if (onClose) onClose();
            else close();
        } else if (act === 'detach') {
            if (onDetach) onDetach();
        } else if (act === 'export') {
            exportLog();
        } else if (act === 'clear') {
            entries.length = 0;
            counts.debug = counts.info = counts.warn = counts.error = 0;
            bodyEl.textContent = '';
            updateCounts();
        } else if (act === 'copy') {
            const text = entries.map((en) => '[' + en.time + '] [' + LEVELS[en.level] + '] ' + en.text).join('\n');
            try { navigator.clipboard.writeText(text).catch(() => {}); } catch (e) {}
        }
    });

    // F12：独立窗口里关闭窗口；停靠模式由 main.js 统一处理
    window.addEventListener('keydown', (e) => {
        if (e.key !== 'F12' || e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return;
        if (!detached) return;
        e.preventDefault();
        e.stopPropagation();
        if (onClose) onClose();
    }, true);

    // 独立窗口：轮询主窗口写入的中继日志（首次从尾部历史开始）
    if (remote) {
        let offset = -1;
        const poll = async () => {
            try {
                const chunk = await remote(offset);
                if (chunk && typeof chunk.offset === 'number') offset = chunk.offset;
                const data = (chunk && chunk.data) || '';
                if (!data) return;
                for (const line of data.split('\n')) {
                    if (!line) continue;
                    try {
                        const e = JSON.parse(line);
                        addEntry(e.lv, e.msg, e.t);
                    } catch (err) {}
                }
            } catch (e) {}
        };
        setInterval(poll, 300);
        setTimeout(poll, 20);
    }

    applyFilters();

    return {push, open, close, toggle, isOpen: () => opened};
}
