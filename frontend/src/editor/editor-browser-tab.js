// editor-browser-tab.js：从 editor-groups.js 拆出的域模块（factory + 显式依赖注入）。
// 浏览器使用标签页：内容区内嵌 WebView2、地址与外部打开、视口预设菜单、
// 弹层显隐同步、标题回写。
//
// deps 经 Object.create 委托继承 editor-groups 的 getter 集。
import {iconSvg} from '../core/icons.js';

// 纯函数：两个矩形是否真正相交。pad 用来忽略「边缘刚好相切」的 1px 误差，
// 避免菜单贴着网页区域右边界就被判成遮挡。放在模块顶层供单测直接导入。
export function browserRectsOverlap(a, b, pad = 2) {
    if (!a || !b) return false;
    return a.left < b.right - pad && a.right > b.left + pad &&
        a.top < b.bottom - pad && a.bottom > b.top + pad;
}

export function createEditorBrowserTab(deps) {

// ---- 浏览器使用标签页：内容区内嵌 WebView2（browser-use） ----

// 地址栏目标解析：协议原样；Windows 绝对/UNC 路径转 file://；其余补 https://
function browserTargetUrl(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    if (/^[a-zA-Z]:[\\/]/.test(raw)) return encodeURI('file:///' + raw.replace(/\\/g, '/'));
    if (raw.startsWith('\\\\')) return encodeURI('file:' + raw.replace(/\\/g, '/'));
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
    return 'https://' + raw;
}

// 地址栏里优先用户正在输入的内容，否则用当前页面地址
function browserAddressOf(doc) {
    const typed = doc.browserAddr ? String(doc.browserAddr.value || '').trim() : '';
    if (typed) return typed;
    const current = String(doc.browserUrl || '').trim();
    return current && current !== 'about:blank' ? current : '';
}

function openBrowserExternally(doc) {
    const target = browserAddressOf(doc);
    if (!target) {
        deps.flash('地址栏为空，先输入网址或文件路径', true);
        return;
    }
    const url = browserTargetUrl(target);
    if (!url) return;
    if (deps.rt && deps.rt.BrowserOpenURL) deps.rt.BrowserOpenURL(url);
    else window.open(url, '_blank', 'noopener');
}

// 菜单弹出前先把原生控件藏起来并**等它真正隐藏**，再显示菜单：WebView2 是独立
// HWND，恒盖在主 WebView 之上——在它隐藏前，菜单和定格帧这些 DOM 都盖不住它。
// 旧逻辑先显示菜单、再靠 syncBrowserTab 的 setTimeout(0) 异步隐藏，中间隔了一帧，
// 用户看到菜单被网页盖一下再露出来，即「闪一帧」（更多操作 / 自适应视口菜单皆然）。
// 跨进程隐藏有上限，超时后照常弹菜单，绝不让它卡住。
const BROWSER_MENU_HIDE_TIMEOUT = 150;
function hideBrowserBeforeMenu(doc) {
    if (!doc.browser || !deps.backend.BrowserSetVisible) return Promise.resolve();
    // 等待隐藏期间菜单还没进 DOM，轮询的 syncBrowserTab 会误判「可见」把控件重新
    // Show 出来——用 doc 标志堵住这个窗口，菜单进 DOM 后再放行。
    doc.browserMenuOpening = true;
    const shot = doc.browserSnapshot;
    if (shot && shot.url === (doc.browserUrl || '')) showBrowserSnapshot(doc, shot.src);
    if (!doc.browserApplied || !doc.browserApplied.visible) {
        doc.browserApplied = null; // 作废缓存，让后续 syncBrowserTab 重新判定
        return Promise.resolve();
    }
    doc.browserApplied = null;
    const hide = Promise.resolve(deps.backend.BrowserSetVisible(doc.id, false)).catch(() => {});
    // 宿主忙时不能让菜单卡住弹不出来：最多等 150ms，之后无条件放行
    const timeout = new Promise((resolve) => setTimeout(resolve, BROWSER_MENU_HIDE_TIMEOUT));
    return Promise.race([hide, timeout]);
}

// 菜单已进 DOM：放行同步，让它按菜单矩形重新判定可见性（相交则保持隐藏）
function afterBrowserMenuOpen(doc) {
    doc.browserMenuOpening = false;
    syncBrowserTab(doc);
}

async function showBrowserMoreMenu(doc, anchor) {
    if (!deps.ctxMenu) return;
    const target = browserAddressOf(doc);
    const url = target ? browserTargetUrl(target) : '';
    const rect = anchor.getBoundingClientRect();
    await hideBrowserBeforeMenu(doc);
    deps.ctxMenu.open([
        {label: '用默认浏览器打开', icon: 'browser', disabled: !url, action: () => openBrowserExternally(doc)},
        {label: '复制网页地址', icon: 'copy', disabled: !target, action: () => deps.copyText(target, '网页地址')},
        {label: '在新标签页中打开', icon: 'new-window', disabled: !url, action: () => deps.openBrowserTab(url, doc.browserProfile)},
        {sep: true},
        {label: '刷新页面', icon: 'refresh', action: () => deps.backend.BrowserReload(doc.id).catch(() => {})},
        {label: '停止加载', icon: 'close', disabled: !doc.loading, action: () => deps.backend.BrowserStop(doc.id).catch(() => {})},
    ], rect.left, rect.bottom + 4, {onClose: () => syncBrowserTab(doc)});
    afterBrowserMenuOpen(doc);
}

// ---------- 浏览器视口尺寸与预览缩放（用户菜单或 AI browser_resize 工具控制） ----------
// 分辨率与显示比例是**两件独立的事**（做法对齐 zcode 内置浏览器）：
//   doc.browserViewport = {mode:'fit'} | {mode:'fixed', width, height}
//       —— 页面的 CSS 视口（media query / innerWidth 看到的值）
//   doc.browserZoom = 'fit' | 50 | 75 | 100
//       —— 预览缩放：只改变画面大小，改不动 CSS 视口
// 固定视口时 .browser-surface 的内联尺寸 = 视口 × 显示比例，原生控件铺在这块区域
// 上，Go 侧按「物理宽 /(DPI 比例 × 视口宽)」设置页面缩放，页面逻辑视口因此恰好等于
// 用户设定的宽高。旧实现让控件尺寸兼做两者（RasterizationScale 又不参与布局），
// 结果「选了分辨率页面纹丝不动」。
// .browser-surface 是唯一真源：ResizeObserver 会把新尺寸同步到原生 WebView2。

const BROWSER_VIEWPORT_PRESETS = [
    {label: '1280 × 720（桌面）', width: 1280, height: 720},
    {label: '1440 × 900（桌面）', width: 1440, height: 900},
    {label: '375 × 812（iPhone）', width: 375, height: 812},
    {label: '768 × 1024（iPad）', width: 768, height: 1024},
];

// 预览缩放档位：100% 也需要「放得下」兜底，超过容器一律按 contain 处理
// （原生控件没法像 <webview> 那样靠 transform 缩放，放大到超出容器会盖住界面）。
const BROWSER_ZOOM_OPTIONS = [
    {label: '适应窗口', value: 'fit'},
    {label: '50%', value: 50},
    {label: '75%', value: 75},
    {label: '100%', value: 100},
];

// 固定视口可用容器区域（CSS px）：.browser-view 去掉工具栏
function browserViewportAvail(doc) {
    const surface = doc.browserEl;
    const view = surface && surface.parentElement;
    if (!view || view.isConnected === false) return null;
    const vr = view.getBoundingClientRect();
    const toolbar = view.querySelector('.browser-toolbar');
    const tbH = toolbar ? toolbar.getBoundingClientRect().height : 0;
    const w = vr.width;
    const h = vr.height - tbH;
    if (!(w > 0) || !(h > 0)) return null;
    return {w, h};
}

// contain 等比缩放系数（≤1）：视口多大逻辑尺寸不变，画面缩到放得下
function browserViewportFitScale(doc) {
    const vp = doc.browserViewport;
    if (!vp || vp.mode !== 'fixed' || !(vp.width > 0) || !(vp.height > 0)) return 1;
    const avail = browserViewportAvail(doc);
    if (!avail) return 1;
    return Math.min(1, avail.w / vp.width, avail.h / vp.height);
}

// 实际生效的显示比例：固定档位与「放得下」取小
function browserViewportVisualScale(doc) {
    const fit = browserViewportFitScale(doc);
    const zoom = doc.browserZoom;
    if (!zoom || zoom === 'fit') return fit;
    return Math.min(fit, Number(zoom) / 100);
}

// 按当前可用区刷新 fixed 模式的 surface 内联尺寸（窗口改变时同步重算）
function layoutFixedViewport(doc) {
    const vp = doc.browserViewport;
    if (!doc.browserEl || !vp || vp.mode !== 'fixed' || !(vp.width > 0) || !(vp.height > 0)) return;
    const scale = browserViewportVisualScale(doc);
    const w = Math.max(1, Math.round(vp.width * scale)) + 'px';
    const h = Math.max(1, Math.round(vp.height * scale)) + 'px';
    if (doc.browserEl.style.width !== w) doc.browserEl.style.width = w;
    if (doc.browserEl.style.height !== h) doc.browserEl.style.height = h;
    // 容器尺寸变了「放得下」会重算，按钮上的比例要跟着变（否则显示的还是旧百分比）
    updateBrowserViewportBtn(doc);
}

// 解析「宽×高」文本（支持 × x * 与逗号分隔），非法返回 null
function parseBrowserViewportText(text) {
    const match = String(text || '').trim().match(/^(\d{1,5})\s*[×xX*,:，]\s*(\d{1,5})$/);
    if (!match) return null;
    const width = Math.round(Number(match[1]));
    const height = Math.round(Number(match[2]));
    if (width < 200 || width > 8000 || height < 200 || height > 8000) return null;
    return {mode: 'fixed', width, height};
}

function applyBrowserViewport(doc) {
    if (!doc || !doc.browserEl) return;
    const surface = doc.browserEl;
    const vp = doc.browserViewport;
    if (!vp || vp.mode !== 'fixed' || !(vp.width > 0) || !(vp.height > 0)) {
        surface.classList.remove('browser-surface-fixed');
        surface.style.width = '';
        surface.style.height = '';
        surface.style.flex = '';
        surface.style.margin = '';
    } else {
        surface.classList.add('browser-surface-fixed');
        surface.style.flex = 'none';
        surface.style.margin = 'auto';
        layoutFixedViewport(doc);
    }
    updateBrowserViewportBtn(doc);
    syncBrowserTab(doc);
}

function setBrowserViewport(doc, viewport) {
    if (!doc || !doc.browserEl) return false;
    const wasFixed = !!(doc.browserViewport && doc.browserViewport.mode === 'fixed');
    const nextFixed = !!(viewport && viewport.mode === 'fixed' && viewport.width > 0 && viewport.height > 0);
    doc.browserViewport = nextFixed
        ? {mode: 'fixed', width: Math.round(viewport.width), height: Math.round(viewport.height)}
        : {mode: 'fit'};
    // 从自适应进入固定视口时重置为「适应窗口」；已在固定视口内换尺寸/换预设不动用户选的比例
    if (nextFixed && !wasFixed) doc.browserZoom = 'fit';
    applyBrowserViewport(doc);
    return true;
}

function setBrowserZoom(doc, zoom) {
    if (!doc || !doc.browserEl) return false;
    const valid = BROWSER_ZOOM_OPTIONS.some((option) => option.value === zoom);
    doc.browserZoom = valid ? zoom : 'fit';
    applyBrowserViewport(doc);
    return true;
}

// 显示比例文案：选了固定档位就报真实生效比例（档位被「放得下」兜底时不能报 100%，
// 否则又是一次「选了没变化」的错觉）
function browserViewportScaleLabel(doc) {
    const zoom = doc.browserZoom;
    if (!zoom || zoom === 'fit') return '适应';
    return Math.round(browserViewportVisualScale(doc) * 100) + '%';
}

function browserViewportLabel(doc) {
    const vp = doc.browserViewport;
    if (!vp || vp.mode !== 'fixed' || !(vp.width > 0)) return '自适应';
    return Math.round(vp.width) + '×' + Math.round(vp.height) + ' · ' + browserViewportScaleLabel(doc);
}

function updateBrowserViewportBtn(doc) {
    if (!doc || !doc.browserViewportBtn) return;
    const label = browserViewportLabel(doc);
    if (doc.browserViewportBtn.textContent !== label) doc.browserViewportBtn.textContent = label;
    const tip = '视口尺寸与预览缩放：' + label + '（点击切换预设、比例或自定义）';
    if (doc.browserViewportBtn.dataset.tip !== tip) doc.browserViewportBtn.dataset.tip = tip;
}

async function showBrowserViewportMenu(doc, anchor) {
    if (!deps.ctxMenu) return;
    const rect = anchor.getBoundingClientRect();
    const vp = doc.browserViewport;
    const isFit = !vp || vp.mode !== 'fixed';
    const items = [{label: '自适应容器', checked: isFit, action: () => setBrowserViewport(doc, {mode: 'fit'})}, {sep: true}];
    for (const preset of BROWSER_VIEWPORT_PRESETS) {
        const active = !isFit && Math.round(vp.width) === preset.width && Math.round(vp.height) === preset.height;
        items.push({
            label: preset.label,
            checked: active,
            action: () => setBrowserViewport(doc, {mode: 'fixed', width: preset.width, height: preset.height}),
        });
    }
    items.push({sep: true});
    // 预览缩放与分辨率互不影响：同一分辨率下改比例只缩放画面，页面拿到的视口不变
    for (const option of BROWSER_ZOOM_OPTIONS) {
        const current = doc.browserZoom || 'fit';
        items.push({
            label: '预览缩放：' + option.label,
            checked: !isFit && current === option.value,
            disabled: isFit,
            action: () => setBrowserZoom(doc, option.value),
        });
    }
    items.push({sep: true});
    items.push({label: '自定义尺寸…', action: () => showBrowserViewportDialog(doc)});
    await hideBrowserBeforeMenu(doc);
    deps.ctxMenu.open(items, rect.left, rect.bottom + 4, {onClose: () => syncBrowserTab(doc)});
    afterBrowserMenuOpen(doc);
}

function showBrowserViewportDialog(doc) {
    const vp = doc.browserViewport && doc.browserViewport.mode === 'fixed' ? doc.browserViewport : {width: 1280, height: 800};
    deps.openNameDialog({
        title: '自定义视口尺寸',
        label: '宽 × 高（像素，如 1280×800）',
        value: Math.round(vp.width) + '×' + Math.round(vp.height),
        placeholder: '1280×800',
        okLabel: '应用',
        onSubmit: async (value) => {
            const parsed = parseBrowserViewportText(value);
            if (!parsed) {
                throw new Error('格式应为「宽×高」，宽高各 200–8000 像素');
            }
            setBrowserViewport(doc, parsed);
            deps.flash('浏览器视口已设为 ' + parsed.width + '×' + parsed.height);
        },
    });
}

function createBrowserView(doc) {
    const pane = document.createElement('div');
    pane.className = 'jsoneditor-pane active browser-pane';
    deps.els.editor.appendChild(pane);
    const view = document.createElement('div');
    view.className = 'browser-view';
    const toolbar = document.createElement('div');
    toolbar.className = 'browser-toolbar';
    const mkBtn = (icon, title, action) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'browser-btn';
        // 项目统一走全局 tooltip（data-tip 驱动），别用原生 title——此前 title 参数
        // 收了却没写上去，导致后退/前进/刷新/更多等按钮悬停都没提示。
        if (title) b.dataset.tip = title;
        b.innerHTML = iconSvg(icon, 14);
        b.addEventListener('click', action);
        return b;
    };
    const backBtn = mkBtn('back', '后退', () => deps.backend.BrowserGoBack(doc.id).catch(() => {}));
    const fwdBtn = mkBtn('forward', '前进', () => deps.backend.BrowserGoForward(doc.id).catch(() => {}));
    const reloadBtn = mkBtn('refresh', '刷新', () => deps.backend.BrowserReload(doc.id).catch(() => {}));
    // 左侧浏览器图标：交给系统默认浏览器打开当前地址/文件；右侧「更多」：复制地址、新标签页、刷新等
    const externalBtn = mkBtn('browser', '用默认浏览器打开', () => openBrowserExternally(doc));
    const moreBtn = mkBtn('more', '更多操作', () => showBrowserMoreMenu(doc, moreBtn));
    const addr = document.createElement('input');
    addr.className = 'browser-addr';
    addr.type = 'text';
    addr.spellcheck = false;
    addr.placeholder = '输入网址或文件路径后回车（默认 https://）';
    addr.value = doc.browserUrl && doc.browserUrl !== 'about:blank' ? doc.browserUrl : '';
    addr.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const target = addr.value.trim();
        if (!target) return;
        const url = browserTargetUrl(target);
        if (!url) return;
        doc.browserUrl = url;
        deps.backend.BrowserNavigate(doc.id, url).catch((err) => deps.flash('导航失败：' + err, true));
    });
    // 视口尺寸按钮：预设（桌面/手机/平板）+ 自定义宽高；AI browser_resize 走同一入口
    const viewportBtn = document.createElement('button');
    viewportBtn.type = 'button';
    viewportBtn.className = 'browser-btn browser-viewport-btn';
    viewportBtn.addEventListener('click', () => showBrowserViewportMenu(doc, viewportBtn));
    toolbar.append(backBtn, fwdBtn, reloadBtn, externalBtn, addr, viewportBtn, moreBtn);
    const surface = document.createElement('div');
    surface.className = 'browser-surface';
    const empty = document.createElement('div');
    empty.className = 'browser-empty';
    empty.textContent = '网页区域加载中…';
    surface.appendChild(empty);
    view.append(toolbar, surface);
    pane.appendChild(view);
    doc.pane = pane;
    doc.browserEl = surface;
    doc.browserEmpty = empty;
    doc.browserAddr = addr;
    doc.browserBackBtn = backBtn;
    doc.browserFwdBtn = fwdBtn;
    doc.browserViewportBtn = viewportBtn;
    if (!doc.browserViewport) doc.browserViewport = {mode: 'fit'};
    if (!doc.browserZoom) doc.browserZoom = 'fit';
    updateBrowserViewportBtn(doc);
    if (typeof ResizeObserver === 'function') {
        doc.browserRO = new ResizeObserver(() => syncBrowserTab(doc));
        doc.browserRO.observe(surface);
        doc.browserRO.observe(pane);
    }
    syncBrowserTab(doc);
}

// 网页区域的 CSS 像素矩形（浮层相交判定用）与设备像素矩形（后端 SetBounds 用）
function browserSurfaceCssRect(doc) {
    if (!doc.browserEl || doc.browserEl.isConnected === false) return null;
    const rect = browserRectOf(doc.browserEl);
    return rect && rect.width > 0 && rect.height > 0 ? rect : null;
}

function browserSurfaceRect(doc) {
    const rect = browserSurfaceCssRect(doc);
    if (!rect) return null;
    const dpr = window.devicePixelRatio || 1;
    const x = Math.round(rect.left * dpr);
    const y = Math.round(rect.top * dpr);
    const physW = Math.round(rect.width * dpr);
    const physH = Math.round(rect.height * dpr);
    // 固定视口把逻辑宽高一起交给后端：后端按「物理宽 /(DPI 比例 × 逻辑宽)」设置页面
    // 缩放，页面 CSS 视口因此恒等于设定值（与可视框多大无关）。自适应传 0。
    const vp = doc.browserViewport;
    const fixed = !!(vp && vp.mode === 'fixed' && vp.width > 0 && vp.height > 0);
    return {
        x, y, w: physW, h: physH,
        vpW: fixed ? Math.round(vp.width) : 0,
        vpH: fixed ? Math.round(vp.height) : 0,
    };
}

// WebView2 是独立 HWND，永远盖在主 WebView 之上。旧逻辑只要页面里「有」浮层就隐藏
// 整个控件——哪怕菜单在右侧 AI 面板里、完全没压住网页，用户也会看到整页变空白
// （2026-11-15 反馈）。现在只对**实际与网页区域相交**的浮层隐藏控件；相交时把
// 最近一帧网页截图铺在区域上，内容看上去是「定格」而不是消失。
// 全屏遮罩 / 覆盖整窗的面板也在这里，它们的矩形天然与网页区域相交。
const BROWSER_POPUP_SELECTORS = [
    '#dialog-mask:not(.hidden)',
    '.ai-model-editor-mask:not(.hidden)',
    '#palette-mask:not(.hidden)',
    '#quick-switch-mask:not(.hidden)',
    '.gs-mask:not(.hidden)', // gs/jp/diff/js 四个遮罩共享此类
    '#ai-panel.ai-fullscreen:not(.hidden)',
    '.img-lightbox:not(.hidden)',
    '.dialog:not(.hidden)',
    '.ctx-menu:not(.hidden)',
    '#menubar .menu.open',
    // 下拉面板是 absolute、从菜单条往下展开的，父级 .menu 的矩形盖不住它，
    // 必须单独按面板矩形判定（2026-11-15 全量排查）
    '#menubar .menu > .dropdown:not(.hidden)',
    '.tb-pop:not(.hidden)',
    '.msg-center-pop',
    '.set-select-pop.open',
    '.ai-popover:not(.hidden)',
    '.ai-usage-pop',
    '.ai-turn-usage',
    '.ai-model-picker', // 关闭态是 inline visibility:hidden，browserRectOf 会滤掉
    '.ai-model-list-pop',
    '.ai-dialog.ai-dialog-top:not(.hidden)', // 从设置窗打开记忆/技能管理：fixed 挂 body
    '.enc-popover:not(.hidden)', // 状态栏编码/视图浮层：fixed
];

// 取可见元素的矩形；display:none（getClientRects 为空）、visibility:hidden
// （如 ai-model-picker 关闭态：留在 DOM 里但不可命中）与零尺寸元素一律忽略
function browserRectOf(el) {
    if (!el || el.isConnected === false) return null;
    if (typeof el.getClientRects === 'function' && !el.getClientRects().length) return null;
    if (typeof el.getBoundingClientRect !== 'function') return null;
    const vis = el.style && el.style.visibility;
    if (vis === 'hidden' || vis === 'collapse') return null;
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        try {
            const css = window.getComputedStyle(el);
            if (css && (css.visibility === 'hidden' || css.visibility === 'collapse')) return null;
        } catch { /* 测试桩可能不支持，忽略 */ }
    }
    const rect = el.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? rect : null;
}

// 兜底：没列进选择器表的浮层（以后新增的 popover 等）用命中测试抽检 9 个点。
// 只要网页区域上压着别的元素就认为被遮挡；右下角 toast 不算——它只是短提示，
// 不该让整页闪一下空白。
function browserHasUnknownOverlay(doc, surface, dom) {
    if (!dom || typeof dom.elementsFromPoint !== 'function' || !doc.browserEl) return false;
    const pad = 8;
    const w = surface.right - surface.left;
    const h = surface.bottom - surface.top;
    if (w < pad * 3 || h < pad * 3) return false;
    const xs = [surface.left + pad, surface.left + w / 2, surface.right - pad];
    const ys = [surface.top + pad, surface.top + h / 2, surface.bottom - pad];
    for (const x of xs) {
        for (const y of ys) {
            const stack = dom.elementsFromPoint(x, y);
            if (!stack || !stack.length) continue;
            const top = stack[0];
            if (top === doc.browserEl || (doc.browserEl.contains && doc.browserEl.contains(top))) continue;
            if (top.contains && top.contains(doc.browserEl)) continue; // 编辑器/body 等祖先
            if (top.closest && top.closest('#app-toasts')) continue;
            return true;
        }
    }
    return false;
}

// dom 参数供单测注入最小 DOM 桩；生产走全局 document
function browserVisibleFor(doc, surfaceRect, dom) {
    if (doc !== deps.file || !surfaceRect) return false;
    const root = dom || (typeof document !== 'undefined' ? document : null);
    if (!root) return false;
    const split = root.getElementById && root.getElementById('split-mask');
    if (split && split.style && split.style.display === 'block') return false;
    for (const sel of BROWSER_POPUP_SELECTORS) {
        const nodes = root.querySelectorAll ? root.querySelectorAll(sel) : [];
        for (const el of nodes) {
            const rect = browserRectOf(el);
            if (rect && browserRectsOverlap(rect, surfaceRect)) return false;
        }
    }
    return !browserHasUnknownOverlay(doc, surfaceRect, root);
}

// ---- 冻结帧：浮层压住网页时保留页面内容 ----
// 控件可见时用 BrowserSnapshot 轻量抓一帧（Go 侧单次短超时、隐藏态不 Show）；
// 隐藏时把这一帧铺在 .browser-surface 上，浮层关闭后立刻移除恢复实时渲染。
const BROWSER_SNAPSHOT_GAP = 2000; // ms，正常浏览时约 2s 刷一帧，不额外打扰宿主线程

function browserSnapshotRefresh(doc, force) {
    if (!doc.browser || !deps.backend.BrowserSnapshot || !doc.browserApplied || !doc.browserApplied.visible) return Promise.resolve('');
    if (doc.browserSnapshotPending) return doc.browserSnapshotPending;
    const now = Date.now();
    if (!force && doc.browserSnapshotAt && now - doc.browserSnapshotAt < BROWSER_SNAPSHOT_GAP) return Promise.resolve('');
    doc.browserSnapshotAt = now;
    const url = doc.browserUrl || '';
    const pending = deps.backend.BrowserSnapshot(doc.id).then((b64) => {
        if (!b64) return '';
        doc.browserSnapshot = {url, src: 'data:image/png;base64,' + b64};
        // 抓帧期间浮层才打开：补上定格图，别让用户一直对着空白（地址变了就用不上）
        if (doc.browserApplied && !doc.browserApplied.visible &&
            doc.browserSnapshot.url === (doc.browserUrl || '')) {
            showBrowserSnapshot(doc, doc.browserSnapshot.src);
        }
        return doc.browserSnapshot.src;
    }).catch(() => '').finally(() => {
        if (doc.browserSnapshotPending === pending) doc.browserSnapshotPending = null;
    });
    doc.browserSnapshotPending = pending;
    return pending;
}

function showBrowserSnapshot(doc, src) {
    const surface = doc.browserEl;
    if (!surface || !src) return;
    let img = doc.browserSnapshotEl;
    if (!img || img.isConnected === false) {
        img = document.createElement('img');
        img.className = 'browser-freeze';
        img.alt = '';
        img.style.position = 'absolute';
        img.style.left = '0';
        img.style.top = '0';
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'fill';
        img.style.pointerEvents = 'none';
        img.style.userSelect = 'none';
        surface.appendChild(img);
        doc.browserSnapshotEl = img;
    }
    if (img.src !== src) img.src = src;
}

function clearBrowserSnapshot(doc) {
    const img = doc.browserSnapshotEl;
    if (!img) return;
    if (typeof img.remove === 'function') img.remove();
    else if (img.parentNode && img.parentNode.removeChild) img.parentNode.removeChild(img);
    doc.browserSnapshotEl = null;
}

// 同步去重锁按 doc 独立，不能用全局单例：syncAllBrowserTabs 遍历多个浏览器标签时，
// 全局锁会让第一个之外的调用全被吞掉——切标签那一刻若撞上 250ms 轮询刚占的锁，
// 非活动标签的「隐藏」就丢了，原生 WebView2 HWND 从此永久盖在其他视图上（无重试路径）。
// WeakSet 不污染 doc、随 doc 回收，每个标签各自去重即可。
const browserSyncPending = new WeakSet();
function syncBrowserTab(doc) {
    if (!doc.browser || browserSyncPending.has(doc) || !deps.backend.BrowserSetBounds) return;
    browserSyncPending.add(doc);
    // setTimeout 而非 rAF：后台标签页 rAF 冻结会让 bounds/可见性同步永久卡住
    setTimeout(() => {
        browserSyncPending.delete(doc);
        if (!deps.docs.includes(doc) || !doc.browserEl) return;
        // 窗口/分栏尺寸变了：固定视口先按新可用区重算 contain 缩放，再取矩形
        layoutFixedViewport(doc);
        const rect = browserSurfaceRect(doc);
        const cssRect = browserSurfaceCssRect(doc);
        // 菜单弹出等待隐藏期间：一律按「不可见」处理，绝不能把原生控件 Show 回来
        // （否则它盖住正在弹出的菜单，就是那帧闪烁）。菜单进 DOM 后由 afterBrowserMenuOpen 放行。
        const visible = !doc.browserMenuOpening && !!rect && browserVisibleFor(doc, cssRect);
        const last = doc.browserApplied;
        // 轮询同步会反复进来：状态没变就别再跨进程调后端
        if (!visible) {
            if (last && !last.visible) return;
            const hidden = {visible: false};
            doc.browserApplied = hidden;
            const shot = doc.browserSnapshot;
            // 只展示与当前地址一致的帧，避免导航后露出上一页的内容
            if (shot && shot.url === (doc.browserUrl || '')) showBrowserSnapshot(doc, shot.src);
            deps.backend.BrowserSetVisible(doc.id, false).catch(() => {
                // 后端失败也照样记成「已隐藏」的话就再无重试路径（原生窗口会一直压在
                // 弹层/菜单上面）。撤回状态，下一轮 250ms 轮询重试。
                if (doc.browserApplied === hidden) doc.browserApplied = null;
            });
            return;
        }
        if (last && last.visible && last.x === rect.x && last.y === rect.y && last.w === rect.w && last.h === rect.h &&
            last.vpW === rect.vpW && last.vpH === rect.vpH) {
            // 状态没变就不重调 SetBounds；但主 WebView 重建/重排控件窗口会重新
            // 抢占子窗口 z 顶盖住内嵌控件（用户看是黑屏，点一下才恢复）——
            // z 序幂等自检很便宜（Go 侧一次 GetWindow 扫描，已在顶则零副作用）。
            if (deps.backend.BrowserEnsureZ) deps.backend.BrowserEnsureZ(doc.id).catch(() => {});
            // 地址变了且已加载完立刻重抓；否则按节流周期刷新，保证浮层打开时有可用的定格帧
            browserSnapshotRefresh(doc, !!doc.browserSnapshot && !doc.loading &&
                doc.browserSnapshot.url !== (doc.browserUrl || ''));
            return;
        }
        const applied = {visible: true, x: rect.x, y: rect.y, w: rect.w, h: rect.h, vpW: rect.vpW, vpH: rect.vpH};
        doc.browserApplied = applied;
        deps.backend.BrowserSetBounds(doc.id, rect.x, rect.y, rect.w, rect.h, rect.vpW, rect.vpH).then(() => {
            if (!deps.docs.includes(doc)) return;
            clearBrowserSnapshot(doc);      // 原生控件已 Show，撤掉定格帧
            browserSnapshotRefresh(doc, false); // 为下一次浮层备好新帧
        }).catch(() => {
            // 首次 Show/SetBounds 失败（宿主忙、看门狗超时）时若仍记成已应用，
            // 后面轮询全部走「状态没变」分支 → 原生控件永远不显示，只能靠点一下
            // 触发新矩形才恢复。撤回状态让轮询自愈。
            if (doc.browserApplied === applied) doc.browserApplied = null;
        });
    }, 0);
}

function syncAllBrowserTabs() {
    for (const d of deps.docs) {
        if (d.browser) syncBrowserTab(d);
    }
}

function updateBrowserTitle(doc, title) {
    if (!title || title === 'about:blank') return;
    if (doc.name !== title) {
        doc.name = title;
        deps.renderTabs();
    }
    if (doc === deps.file) {
        deps.setFilename(doc.name, '');
        deps.updateWindowTitle();
    }
}

    return {
        browserTargetUrl,
        browserAddressOf,
        openBrowserExternally,
        hideBrowserBeforeMenu,
        afterBrowserMenuOpen,
        showBrowserMoreMenu,
        setBrowserViewport,
        setBrowserZoom,
        browserViewportLabel,
        createBrowserView,
        browserVisibleFor,
        syncBrowserTab,
        syncAllBrowserTabs,
        updateBrowserTitle,
    };
}
