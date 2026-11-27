// 终端会话管理与菜单：新建/激活/关闭/移除标签页、主题同步、shell 与标签右键菜单、重命名。
// 从 terminal-ui.js 拆出；terminalUI 状态、shell 标签、cwd/theme、runGitCommit 由宿主经 deps 注入。
import {iconSvg} from '../core/icons.js';
import {termKeyAction} from './term-keys.js';
import {matchLinks, linkRangeInRows, linkHitAt} from './term-links.js';

// ===== 终端会话服务与输出缓冲 =====
export function createTerminalSessions(deps) {

// —— term-out 先于 UI 注册到达的兜底 ——
// Go 在 TermCreate 返回前后就开始读 ConPTY 并推 term-out（banner 很快），前端要等
// await TermCreate resolve 后才把 session 注册进 map：先到的事件原先被静默丢弃，
// 首屏 banner/提示符残缺，转义序列被拦腰截断会一直乱下去。现在先暂存，
// attachTermSession 注册后按序回放。
const pendingTermOut = new Map(); // id -> {buf, at}
// popoutLabels：弹出期间记住页签名（含用户自定义名），接回时原样恢复——
// 否则接回按 shell 名重起标签，「本地」会变成「PowerShell 7」（2026-11-21 用户实测）。
const popoutLabels = new Map(); // id -> {label, custom}
const PENDING_TERM_OUT_MAX = 256 * 1024;
// 广播兜底缓冲是**短命**的：owner 登记竞态期（Go 回退广播）每个窗口都会收到
// 非，己会话的输出并暂存——该 id 永远不会被本窗口 attach，条目必须过期丢弃，
// 否则弹几次终端就攒一份永不释放（2026-11-21 审查 P2-1）。
const PENDING_TERM_OUT_TTL = 30 * 1000;
const PENDING_TERM_OUT_MAX_KEYS = 8;

function writeTermOut(data) {
    if (!data || !data.id) return;
    const s = deps.terminalUI.sessions.get(data.id);
    if (s) {
        s.term.write(data.data || '');
        return;
    }
    // 定期清一次过期条目（写入频率高，不能每次都全表扫）
    if (pendingTermOut.size >= PENDING_TERM_OUT_MAX_KEYS) {
        const now = Date.now();
        for (const [key, entry] of pendingTermOut) {
            if (now - entry.at > PENDING_TERM_OUT_TTL) pendingTermOut.delete(key);
        }
    }
    const entry = pendingTermOut.get(data.id);
    if (!entry || Date.now() - entry.at > PENDING_TERM_OUT_TTL) {
        // 新条目或已过期：过期说明这个 id 在本窗口就是无人认领的，丢弃旧尾巴
        pendingTermOut.delete(data.id);
        pendingTermOut.set(data.id, {buf: data.data || '', at: Date.now()});
        return;
    }
    entry.at = Date.now();
    entry.buf += data.data || '';
    if (entry.buf.length > PENDING_TERM_OUT_MAX) entry.buf = entry.buf.slice(-PENDING_TERM_OUT_MAX);
}

function discardPendingTermOut(id) {
    pendingTermOut.delete(id);
}

function flushPendingTermOut(id) {
    const entry = pendingTermOut.get(id);
    if (!entry) return;
    pendingTermOut.delete(id);
    const s = deps.terminalUI.sessions.get(id);
    if (s) s.term.write(entry.buf);
}

// 粘贴进终端：优先走 Go 绑定（WebView2 下 navigator.clipboard.readText 不保证放行）
async function pasteClipboardTo(term) {
    let text = '';
    try {
        if (deps.backend.GetClipboardText) text = String((await deps.backend.GetClipboardText()) || '');
        else if (navigator.clipboard && navigator.clipboard.readText) text = await navigator.clipboard.readText();
    } catch (e) {
        deps.flash('读取剪贴板失败：' + e, true);
        return;
    }
    if (!text) return;
    try {
        term.paste(text);
    } catch (e) {}
}

// ===== 终端链接识别 =====
// —— 终端内链接：hover 下划线 + 手型光标由 xterm 对已注册链接的默认装饰提供，
// Ctrl/Cmd+单击用系统默认程序打开（普通点击留给选区，不动作）。检测纯函数在
// term-links.js；linkHandler 同时接管应用经 OSC 8 转义序列发的真链接的激活。
function registerTermLinks(term) {
    if (!term.registerLinkProvider) return;
    term.registerLinkProvider({
        provideLinks: (y, callback) => {
            let links;
            try {
                links = termLinksAtRow(term, y);
            } catch (e) {
                links = undefined;
            }
            callback(links || []);
        },
    });
}

// provideLinks 的 y 是 1-based 缓冲绝对行号（xterm LinkManager：视口行 + ydisp）；
// range 坐标与内置 OscLinkProvider 同约定：x 为 1-based cell 列、end 含端点、y 1-based。
function termLinksAtRow(term, y) {
    const buffer = term.buffer.active;
    const idx = y - 1;
    if (idx < 0 || !buffer.getLine(idx)) return undefined;
    // 软换行序列：isWrapped = 本行是上一行的延续——向上找序列起点、向下找终点，
    // 长 URL 被换行拆开时跨行拼出完整链接
    let firstIdx = idx;
    while (firstIdx > 0) {
        const prev = buffer.getLine(firstIdx - 1), cur = buffer.getLine(firstIdx);
        if (!prev || !cur || !cur.isWrapped) break;
        firstIdx--;
    }
    let lastIdx = idx;
    for (;;) {
        const next = buffer.getLine(lastIdx + 1);
        if (!next || !next.isWrapped) break;
        lastIdx++;
    }
    const rows = [];
    for (let i = firstIdx; i <= lastIdx; i++) rows.push(termRowData(buffer.getLine(i), i + 1));
    const links = matchLinks(rows.map((r) => r.text).join(''));
    if (!links.length) return undefined;
    return links.map((m) => ({
        text: m.text,
        range: linkRangeInRows(rows, m),
        activate: (ev) => activateTermLink(ev, m.text),
    }));
}

// 行数据：裁尾文本 + 「字符串偏移 → cell 列」映射。宽字符占 2 cell，字符串索引
// 与 cell 列不等（URL 里含中文路径 / 行首是中文时不能按字符串偏移当列号），
// 逐 cell 扫描建立映射；chars 为空的是宽字符后半占位或 null cell，跳过。
function termRowData(line, y) {
    if (!line) return {y, text: '', colOf: null, wideAt: null};
    const colOf = [];
    const wideAt = new Set();
    let off = 0;
    for (let c = 0; c < line.length; c++) {
        const cell = line.getCell(c);
        if (!cell.chars) continue;
        for (let k = 0; k < cell.chars.length; k++) colOf[off + k] = c;
        if (cell.width === 2) wideAt.add(off);
        off += cell.chars.length;
    }
    return {y, text: line.translateToString(true), colOf, wideAt};
}

// 激活：Ctrl/Cmd+单击 → 系统默认程序打开；普通点击不动作
function activateTermLink(ev, text) {
    if (!ev || (!ev.ctrlKey && !ev.metaKey)) return;
    const url = String(text || '');
    if (!/^https?:\/\//i.test(url)) return;
    openTermLinkExternal(url);
}

// 系统默认程序打开（Wails BrowserOpenURL）；无 Wails runtime（dev 浏览器调试）时降级 window.open
function openTermLinkExternal(url) {
    if (deps.rt && deps.rt.BrowserOpenURL) deps.rt.BrowserOpenURL(url);
    else window.open(url, '_blank', 'noopener');
}

// 右键定位链接：把指针位置换算成缓冲行列（cell 尺寸按 .xterm-screen 实测），再对该行
// 重跑链接检测——与 provideLinks 同一条链，软换行跨行的长链接同样命中。命中判定
// 纯函数 linkHitAt 在 term-links.js。指针不在终端画面内返回 ''。
function termLinkAtPointer(s, e) {
    const term = s.term;
    const screen = s.host.querySelector('.xterm-screen');
    if (!screen) return '';
    const rect = screen.getBoundingClientRect();
    if (!rect.width || !rect.height) return '';
    const col = Math.floor((e.clientX - rect.left) / (rect.width / term.cols)) + 1; // 1-based cell 列
    const row = Math.floor((e.clientY - rect.top) / (rect.height / term.rows));     // 视口内 0-based 行
    if (col < 1 || row < 0 || row >= term.rows) return '';
    const bufRow = term.buffer.active.viewportY + row + 1; // 1-based 缓冲行（同 provideLinks 的 y）
    let links;
    try {
        links = termLinksAtRow(term, bufRow);
    } catch (err) {
        return '';
    }
    return linkHitAt(links, bufRow, col, term.cols);
}

// ===== 会话创建与附着 =====
async function createTermSession(shell = '', meta = null) {
    if (!deps.backend.TermCreate) {
        deps.flash('当前版本不支持内置终端', true);
        return null;
    }
    let created;
    try {
        created = await deps.backend.TermCreate(termDefaultCols(), termDefaultRows(), shell, deps.termCwd());
    } catch (e) {
        deps.flash('创建终端失败：' + e, true);
        return null;
    }
    const id = created.id;
    // 流事件归属：term-out/term-exit 定向投本窗口（create 返回前的竞态事件走广播兜底）
    if (deps.backend.RegisterEventOwner) {
        Promise.resolve(deps.backend.RegisterEventOwner('term', id)).catch(() => {});
    }
    const usedShell = created.shell || shell || 'powershell';
    attachTermSession(id, usedShell, {explicitShell: !!shell, aiSessionId: meta && meta.sessionId});
    return {id, shell: usedShell};
}

// attachTermSession：为「已经存在的后端会话」建 xterm 视图与页签。
// AI 的 terminal 工具走的就是这条路（后端 TermCreate 由调用方负责），
// 这样 AI 自建的终端与用户点「新建终端」出来的完全一样（同一份页签与输出流）。
function attachTermSession(id, usedShell, opts = {}) {
    const existing = deps.terminalUI.sessions.get(id);
    if (existing) {
        activateTermSession(id);
        return existing;
    }
    const body = document.getElementById('term-body');
    const host = document.createElement('div');
    host.className = 'term-session';
    body.appendChild(host);
    const term = new window.Terminal({
        fontFamily: '"JetBrains Mono", Consolas, monospace',
        fontSize: 12,
        scrollback: 2000,
        cursorBlink: true,
        theme: deps.termTheme(),
        // 应用经 OSC 8 发的真链接（如 git/gh 出的 hyperlink）也走统一的 Ctrl+单击语义
        linkHandler: {activate: (ev, text) => activateTermLink(ev, text)},
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(host);
    registerTermLinks(term);
    try {
        fit.fit();
    } catch (e) {}
    term.onData((data) => {
        deps.backend.TermWrite(id, data).catch(() => {});
    });
    // Ctrl+C 语义分流（term-keys.js）：有选中时复制而不是把 \x03 发给 shell；
    // 无选中照常中断前台程序。Ctrl+Shift+V 显式粘贴。
    term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown') return true;
        let action;
        try {
            action = termKeyAction(ev, term.hasSelection());
        } catch (e) {
            return true;
        }
        if (action === 'copy') {
            deps.copyText(term.getSelection(), '选中内容');
            return false;
        }
        if (action === 'paste') {
            pasteClipboardTo(term);
            return false;
        }
        return true;
    });
    // 页签命名仿 JetBrains：默认 shell 叫「本地」，重复时加 (2)/(3)；显式选择的 shell 用名字
    const baseName = opts.label || (opts.explicitShell ? (deps.TERM_SHELL_LABELS[usedShell] || usedShell) : '本地');
    let dup = 0;
    for (const s of deps.terminalUI.sessions.values()) {
        if (s.baseName === baseName) dup++;
    }
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'term-tab';
    const label = document.createElement('span');
    label.className = 'term-tab-label';
    label.textContent = dup ? baseName + ' (' + (dup + 1) + ')' : baseName;
    label.dataset.tip = deps.TERM_SHELL_LABELS[usedShell] || usedShell;
    const tabClose = document.createElement('span');
    tabClose.className = 'term-tab-close';
    tabClose.innerHTML = iconSvg('close', 11);
    tabClose.dataset.tip = '关闭终端';
    tab.append(label, tabClose);
    tab.addEventListener('click', (e) => {
        const closeHit = e.target.closest('.term-tab-close');
        if (closeHit) {
            e.preventDefault();
            e.stopPropagation();
            closeTermSession(id);
            return;
        }
        if (e.shiftKey) {
            e.preventDefault();
            closeTermSession(id);
            return;
        }
        activateTermSession(id);
    });
    tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        activateTermSession(id);
        showTermTabMenu(id, e.clientX, e.clientY);
    });
    document.getElementById('term-tabs').appendChild(tab);
    const session = {id, term, fit, host, tab, shell: usedShell, baseName,
        defaultLabel: label.textContent, defaultTitle: label.title, customName: '',
        syncedCols: 0, syncedRows: 0, resizeTimer: null};
    // AI 来源标记（terminal 工具 open 传入发起会话 id）：term-exit 时 main.js 据此把
    // 「shell 已退出」投给 AI 会话信箱；用户自己开的终端没有该标记，退出不打扰会话。
    if (opts.aiSessionId) session.aiSessionId = opts.aiSessionId;
    if (opts.customName) session.customName = opts.customName;
    deps.terminalUI.sessions.set(id, session);
    if (!opts.skipPendingFlush) flushPendingTermOut(id);
    deps.terminalUI.order.push(id);
    // 终端区域右键菜单：指向链接时前置链接动作（复制/内置浏览器/默认程序），
    // 再接常规项（挡掉 WebView2 默认菜单）
    host.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showTermAreaMenu(session, e.clientX, e.clientY, termLinkAtPointer(session, e));
    });
    activateTermSession(id);
    setTimeout(() => {
        try {
            fitTerm(session);
            term.focus();
        } catch (e) {}
    }, 80);
    return session;
}

// termShellLabel：shell id → 展示名（终端窗口头部胶囊用，跟页签重命名无关）。
function termShellLabel(shell) {
    return deps.TERM_SHELL_LABELS[shell] || shell || '本地';
}

function termDefaultCols() {
    return 80;
}

function termDefaultRows() {
    return 24;
}

// ===== 尺寸同步与激活 =====
// xterm 行列与 ConPTY 同步：fit 之后如果行列变了，防抖调 TermResize 让 PTY 跟上。
// 之前只 fit 不 resize：ConPTY 停在创建时的 80x24，shell 按 80 列输出/重绘、
// xterm 按面板实际宽度渲染，错位与重绘残留就是这么来的。拖面板时 mousemove
// 每步都 fit，防抖避免每步都发 TermResize。
function syncTermSize(s) {
    if (!s || !deps.backend.TermResize) return;
    if (s.term.cols === s.syncedCols && s.term.rows === s.syncedRows) return;
    if (s.resizeTimer) clearTimeout(s.resizeTimer);
    s.resizeTimer = setTimeout(() => {
        s.resizeTimer = null;
        const cols = s.term.cols, rows = s.term.rows;
        if (!deps.terminalUI.sessions.has(s.id) || (cols === s.syncedCols && rows === s.syncedRows)) return;
        s.syncedCols = cols;
        s.syncedRows = rows;
        deps.backend.TermResize(s.id, cols, rows).catch(() => {}); // 尽力而为：PTY 已退出时 resize 失败无碍
    }, 120);
}

// fit + 尺寸同步的统一入口（fit 在宿主隐藏时 measure 不到会抛错，照旧吞掉）
function fitTerm(s) {
    try {
        s.fit.fit();
    } catch (e) {}
    syncTermSize(s);
}

function activateTermSession(id) {
    deps.terminalUI.activeId = id;
    for (const [sid, s] of deps.terminalUI.sessions) {
        s.host.classList.toggle('hidden', sid !== id);
        s.tab.classList.toggle('active', sid === id);
    }
    const s = deps.terminalUI.sessions.get(id);
    if (s) {
        try {
            fitTerm(s);
            s.term.focus();
        } catch (e) {}
    }
}

function fitActiveTerm() {
    const s = deps.terminalUI.sessions.get(deps.terminalUI.activeId);
    if (s) fitTerm(s);
}

// ===== 会话关闭与恢复 =====
async function closeTermSession(id) {
    try {
        await deps.backend.TermClose(id);
    } catch (e) {}
    removeTermSession(id);
    if (!deps.terminalUI.sessions.size) deps.toggleTerminalPanel(false);
    else activateTermSession(deps.terminalUI.order[deps.terminalUI.order.length - 1]);
}

function removeTermSession(id) {
    const s = deps.terminalUI.sessions.get(id);
    if (s) {
        if (s.resizeTimer) clearTimeout(s.resizeTimer);
        try {
            s.term.dispose();
        } catch (e) {}
        s.tab.remove();
        s.host.remove();
    }
    pendingTermOut.delete(id);
    deps.terminalUI.sessions.delete(id);
    deps.terminalUI.order = deps.terminalUI.order.filter((x) => x !== id);
}

// 回放字符预算：ConPTY 环形缓冲 64 KiB，TermRead 上限 20k 字符——够最近几屏加少量回滚。
const TERM_REPLAY_CHARS = 20000;

// attachResumedTermSession：把「当前不归本窗口渲染」的已存在会话接回本窗口。
// 终端独立窗口装载与主窗口收回共用这一条路径。先切事件归属、取环形缓冲快照，
// 再在一个同步段里丢弃暂存缓冲（快照已覆盖）→ 挂载（不 flush）→ 回放，之后到达
// 的输出直接写入：既不丢输出，也不会因回放与缓冲重叠而双写。
async function attachResumedTermSession(id, shell) {
    const existing = deps.terminalUI.sessions.get(id);
    if (existing) {
        activateTermSession(id);
        return existing;
    }
    if (deps.backend.RegisterEventOwner) {
        Promise.resolve(deps.backend.RegisterEventOwner('term', id)).catch(() => {});
    }
    let replay = null;
    let replayFailed = false;
    try {
        replay = await deps.backend.TermRead(id, TERM_REPLAY_CHARS);
    } catch (e) {
        // 快照失败（会话可能已被关）：不丢暂存缓冲，attach 后照常 flush，
        // 保住交接间隙收到的输出（审查 P2-2）。
        replayFailed = true;
    }
    if (!replayFailed) discardPendingTermOut(id);
    const usedShell = shell || (replay && replay.shell) || 'powershell';
    const remembered = popoutLabels.get(id);
    const s = attachTermSession(id, usedShell, {
        label: remembered && remembered.label,
        customName: remembered && remembered.custom ? remembered.label : '',
        explicitShell: !remembered,
        skipPendingFlush: replayFailed ? false : true,
    });
    popoutLabels.delete(id);
    if (replayFailed) {
        flushPendingTermOut(id);
        return s;
    }
    if (s && replay && replay.text) {
        try {
            s.term.write(replay.text);
        } catch (e) {}
    }
    return s;
}

// popOutTermSession：把会话弹出为独立窗口（ConPTY 不动，事件归属由新窗口接管）。
// Go 建窗成功后本窗口立即卸掉页签；弹出窗口若没起来或被关掉，Go 会广播
// term-popout-closed 指定交还目标，原窗口把会话接回来（attachResumedTermSession）。
async function popOutTermSession(id) {
    if (!deps.backend.PopOutTerminal) {
        deps.flash('当前版本不支持独立终端窗口', true);
        return;
    }
    try {
        await deps.backend.PopOutTerminal(id);
    } catch (e) {
        deps.flash('弹出终端失败：' + e, true);
        return;
    }
    const s = deps.terminalUI.sessions.get(id);
    if (s) popoutLabels.set(id, {label: s.customName || s.defaultLabel, custom: !!s.customName});
    removeTermSession(id);
    if (!deps.terminalUI.sessions.size) deps.toggleTerminalPanel(false);
}

// ===== 主题与右键菜单 =====
function syncTerminalTheme() {
    for (const s of deps.terminalUI.sessions.values()) {
        try {
            s.term.options.theme = deps.termTheme();
        } catch (e) {}
    }
}

window.addEventListener('resize', () => {
    if (deps.terminalUI.open) fitActiveTerm();
});

deps.els.gitRefresh.addEventListener('click', () => deps.refreshGitStatus());

if (deps.els.gitSplitter) {
    let gitSplitting = false;
    let gitSplitStartY = 0;
    let gitSplitStartH = 0;
    deps.els.gitSplitter.addEventListener('mousedown', (e) => {
        if (!deps.els.gitCommitArea) return;
        gitSplitting = true;
        gitSplitStartY = e.clientY;
        gitSplitStartH = deps.els.gitCommitArea.offsetHeight;
        deps.setDragCursor('ns');
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!gitSplitting) return;
        const h = Math.min(300, Math.max(90, gitSplitStartH - (e.clientY - gitSplitStartY)));
        deps.els.gitCommitArea.style.height = h + 'px';
        deps.els.gitCommitArea.style.flex = 'none';
    });
    window.addEventListener('mouseup', () => {
        if (!gitSplitting) return;
        gitSplitting = false;
        deps.setDragCursor(null);
        document.body.style.userSelect = '';
        deps.settings.gitCommitAreaHeight = Math.min(300, Math.max(90, deps.els.gitCommitArea.offsetHeight));
        deps.applySettings();
    });
}

// 新建终端的 shell 菜单（JetBrains 风格）：列出本机可用 shell，选中即新建页签
async function showTermShellMenu() {
    if (!deps.ctxMenu) return;
    let shells = [];
    try {
        shells = deps.backend.TermShells ? await deps.backend.TermShells() : [];
    } catch (e) {}
    if (!shells.length) {
        deps.flash('没有可用的 Shell', true);
        return;
    }
    const r = deps.els.termShellMenu.getBoundingClientRect();
    deps.ctxMenu.open(shells.map((s) => ({
        label: s.name,
        action: () => createTermSession(s.id),
    })), r.left, r.bottom + 4);
}
if (deps.els.termPanelClose) deps.els.termPanelClose.addEventListener('click', () => deps.toggleTerminalPanel(false));

// 终端区域右键菜单：指向链接时前置「复制链接 / 内置浏览器打开 / 默认程序打开」，
// 下面照常给 复制选中（无选中置灰）/ 粘贴 / 清屏
function showTermAreaMenu(s, x, y, linkUrl) {
    if (!deps.ctxMenu) return;
    let hasSel = false;
    try {
        hasSel = s.term.hasSelection();
    } catch (e) {}
    const items = [];
    if (linkUrl) {
        items.push(
            {label: '复制链接', icon: 'copy', action: () => deps.copyText(linkUrl, '链接')},
            {label: '内置浏览器打开', icon: 'browser', action: () => deps.openBrowserTab(linkUrl)},
            {label: '默认程序打开', icon: 'new-window', action: () => openTermLinkExternal(linkUrl)},
            {sep: true},
        );
    }
    items.push(
        {label: '复制', icon: 'copy', shortcut: 'Ctrl+C', disabled: !hasSel,
            action: () => { try { deps.copyText(s.term.getSelection(), '选中内容'); } catch (e) {} }},
        {label: '粘贴', icon: 'paste', shortcut: 'Ctrl+V', action: () => pasteClipboardTo(s.term)},
        {sep: true},
        {label: '清屏', icon: 'eraser', action: () => { try { s.term.clear(); s.term.focus(); } catch (e) {} }},
    );
    deps.ctxMenu.open(items, x, y);
}

// 终端标签页右键菜单（JetBrains 风格）：新建/重命名/清屏/关闭
async function showTermTabMenu(id, x, y) {
    if (!deps.ctxMenu) return;
    const s = deps.terminalUI.sessions.get(id);
    if (!s) return;
    const others = [...deps.terminalUI.sessions.values()].filter((v) => v.id !== id);
    let shells = [];
    try {
        shells = deps.backend.TermShells ? await deps.backend.TermShells() : [];
    } catch (e) {}
    const items = [
        {label: '新建终端（默认 Shell）', icon: 'plus', action: () => createTermSession()},
    ];
    if (shells.length) {
        items.push({
            label: '用其他 Shell 新建终端',
            icon: 'terminal',
            submenu: shells.map((sh) => ({label: sh.name, action: () => createTermSession(sh.id)})),
        });
    }
    if (deps.backend.PopOutTerminal) {
        items.push({label: '在独立窗口打开', icon: 'new-window', action: () => popOutTermSession(id)});
    }
    items.push(
        {label: '重命名标签页', icon: 'rename', action: () => renameTermSession(s)},
        {label: '清屏', icon: 'eraser', action: () => { try { s.term.clear(); s.term.focus(); } catch (e) {} }},
        {sep: true},
        {label: '关闭', shortcut: 'Shift+点击', icon: 'close', action: () => closeTermSession(id)},
        {label: '关闭其他标签页', disabled: !others.length, action: () => { for (const o of others) closeTermSession(o.id); }},
        {label: '关闭所有标签页', action: () => { for (const o of [...deps.terminalUI.sessions.values()]) closeTermSession(o.id); }},
    );
    deps.ctxMenu.open(items, x, y);
}

// ===== 重命名与宿主 API =====
// 重命名终端标签页：清空并确定则恢复默认名
function renameTermSession(s) {
    if (!s) return;
    deps.openNameDialog({
        title: '重命名终端标签页',
        label: '名称',
        value: s.customName || s.defaultLabel,
        okLabel: '确定',
        onSubmit: async (value) => {
            const name = String(value || '').trim();
            const label = s.tab.querySelector('.term-tab-label');
            if (!label) return;
            if (name) {
                s.customName = name;
                label.textContent = name;
                label.dataset.tip = name;
            } else {
                s.customName = '';
                label.textContent = s.defaultLabel;
                label.dataset.tip = s.defaultTitle;
            }
        },
    });
}

// AI 面板的终端桥（main.js 以 getter 注入 ai-panel）：AI 自建/操作终端时与用户共用同一份 UI 状态
// （页签、xterm、底部面板）。这里只做转发，不做权限判断——审批在 ai-panel 的 terminal 工具里，
// 与 run_command 共用同一条命令审批链。
function terminalHostApi() {
    return {
        async open(shell, meta) {
            const created = await createTermSession(shell || '', meta || null);
            if (!created) throw new Error('创建终端失败（详见状态栏提示）');
            deps.toggleTerminalPanel(true);
            activateTermSession(created.id);
            return created;
        },
        list() {
            return [...deps.terminalUI.sessions.values()].map((s) => ({
                id: s.id,
                shell: s.shell,
                label: s.customName || s.defaultLabel || s.id,
                active: deps.terminalUI.activeId === s.id,
            }));
        },
        send(id, data) {
            if (!deps.terminalUI.sessions.has(id)) throw new Error('终端不在界面上（可能已被用户弹出为独立窗口）：' + id);
            return deps.backend.TermWrite(id, data);
        },
        focus(id) {
            if (!deps.terminalUI.sessions.has(id)) return false;
            deps.toggleTerminalPanel(true);
            activateTermSession(id);
            return true;
        },
        close(id) {
            return closeTermSession(id);
        },
    };
}

return {activateTermSession, attachResumedTermSession, closeTermSession, createTermSession, fitActiveTerm, popOutTermSession, removeTermSession,
        renameTermSession, showTermShellMenu, showTermTabMenu, syncTerminalTheme, terminalHostApi, termShellLabel,
        termDefaultCols, termDefaultRows, writeTermOut};
}
