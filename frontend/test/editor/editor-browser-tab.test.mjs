// 内嵌浏览器标签页：浮层显隐判定与冻结帧。
// 用最小 DOM 桩跑纯逻辑；真实 WebView2 / Shadow DOM 由浏览器冒烟覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import {browserRectsOverlap, createEditorBrowserTab} from '../../src/editor/editor-browser-tab.js';

const SURFACE = rect(200, 60, 700, 600);

function rect(left, top, right, bottom) {
    return {left, top, right, bottom, width: right - left, height: bottom - top};
}

function fakeEl(r, style = {}) {
    return {
        isConnected: true,
        className: '',
        style: {...style},
        children: [],
        parentNode: null,
        getClientRects: () => (r && r.width > 0 && r.height > 0 ? [r] : []),
        getBoundingClientRect: () => r,
        contains: () => false,
        closest: () => null,
        appendChild(node) {
            this.children.push(node);
            node.parentNode = this;
            node.isConnected = true;
            return node;
        },
        removeChild(node) {
            this.children = this.children.filter((child) => child !== node);
            node.parentNode = null;
        },
        remove() {
            if (this.parentNode) this.parentNode.removeChild(this);
        },
    };
}

// popups: [{selector, rect, style}]；stacking(x,y) 返回命中测试的元素栈
function fakeDom({popups = [], stacking = null, splitVisible = false} = {}) {
    const surface = fakeEl(SURFACE);
    return {
        surface,
        querySelectorAll: (sel) => popups.filter((p) => p.selector === sel).map((p) => {
            const el = fakeEl(p.rect, p.style);
            return el;
        }),
        getElementById: (id) => (id === 'split-mask'
            ? {style: {display: splitVisible ? 'block' : 'none'}}
            : null),
        elementsFromPoint: () => (stacking ? stacking() : [surface]),
        createElement: () => fakeEl(null),
    };
}

function moduleFor(doc, overrides = {}) {
    const deps = {
        file: doc,
        docs: [doc],
        backend: {},
        flash: () => {},
        ctxMenu: null,
        copyText: () => {},
        openBrowserTab: () => {},
        openNameDialog: () => {},
        renderTabs: () => {},
        setFilename: () => {},
        updateWindowTitle: () => {},
        els: {editor: {appendChild: () => {}}},
        ...overrides,
    };
    return createEditorBrowserTab(deps);
}

// ---- 相交判定（纯函数） ----

test('browserRectsOverlap：真正相交才算遮挡，边缘相切/1px 压边不算', () => {
    assert.equal(browserRectsOverlap(rect(300, 100, 400, 200), SURFACE), true);
    assert.equal(browserRectsOverlap(rect(720, 100, 900, 300), SURFACE), false);
    assert.equal(browserRectsOverlap(rect(700, 100, 900, 300), SURFACE), false); // 刚好贴右边界
    assert.equal(browserRectsOverlap(rect(699, 100, 900, 300), SURFACE), false); // 只压进 1px
    assert.equal(browserRectsOverlap(rect(690, 100, 900, 300), SURFACE), true);  // 压进 10px
    assert.equal(browserRectsOverlap(null, SURFACE), false);
    assert.equal(browserRectsOverlap(rect(300, 100, 400, 200), SURFACE, 0), true);
});

// ---- browserVisibleFor：只隐藏确实压住网页区域的浮层 ----

function visibleFor(popups, extra = {}) {
    const dom = fakeDom({popups, ...extra});
    const doc = {id: 'b1', browser: true, browserEl: dom.surface};
    const mod = moduleFor(doc);
    return mod.browserVisibleFor(doc, SURFACE, dom);
}

test('页面上没有任何浮层：网页保持可见', () => {
    assert.equal(visibleFor([]), true);
});

test('AI 面板里的菜单（在网页区域右侧、完全不相交）不再让网页变空白', () => {
    const popups = [{selector: '.ctx-menu:not(.hidden)', rect: rect(720, 300, 900, 520)}];
    assert.equal(visibleFor(popups), true);
});

test('菜单压进网页区域：仍需隐藏原生控件，否则菜单被盖住', () => {
    const popups = [{selector: '.ctx-menu:not(.hidden)', rect: rect(600, 300, 848, 520)}];
    assert.equal(visibleFor(popups), false);
});

test('子菜单也算：querySelectorAll 的全部节点都检查，不能只看第一个', () => {
    const popups = [
        {selector: '.ctx-menu:not(.hidden)', rect: rect(720, 300, 900, 520)}, // 主菜单在右侧
        {selector: '.ctx-menu:not(.hidden)', rect: rect(450, 300, 698, 480)}, // 子菜单往左展开
    ];
    assert.equal(visibleFor(popups), false);
});

test('全屏遮罩 / 全屏 AI 面板：矩形与网页区域相交，隐藏', () => {
    const full = rect(0, 0, 1280, 800);
    assert.equal(visibleFor([{selector: '#dialog-mask:not(.hidden)', rect: full}]), false);
    assert.equal(visibleFor([{selector: '#ai-panel.ai-fullscreen:not(.hidden)', rect: full}]), false);
});

test('display:none 的浮层（零矩形）不算遮挡', () => {
    assert.equal(visibleFor([{selector: '.ctx-menu:not(.hidden)', rect: rect(0, 0, 0, 0)}]), true);
});

test('visibility:hidden 的残留元素（ai-model-picker 关闭态）不算遮挡', () => {
    // 关闭时元素留在 DOM、矩形非零，靠 inline visibility:hidden 隐藏——必须过滤，
    // 否则模型选择器开过一次后网页就永远被误判成遮挡
    const popups = [{selector: '.ai-model-picker', rect: rect(300, 100, 500, 300), style: {visibility: 'hidden'}}];
    assert.equal(visibleFor(popups), true);
});

test('全量排查补入的 fixed 浮层：相交即隐藏、不相交不误伤', () => {
    const over = rect(300, 100, 500, 300);   // 压住网页区域
    const right = rect(720, 300, 900, 520);  // 右侧 AI 面板范围内，不相交
    const sels = [
        '.ai-model-picker',
        '.ai-model-list-pop',
        '.ai-turn-usage',
        '.enc-popover:not(.hidden)',
        '.ai-dialog.ai-dialog-top:not(.hidden)',
    ];
    for (const sel of sels) {
        assert.equal(visibleFor([{selector: sel, rect: over}]), false, `${sel} 相交时应隐藏`);
        assert.equal(visibleFor([{selector: sel, rect: right}]), true, `${sel} 不相交时不应隐藏`);
    }
});

test('菜单条下拉面板单独判定：父级 .menu 不相交但下拉面板压住网页也要隐藏', () => {
    // .menu.open 的矩形只是顶部按钮，不相交；.dropdown 是 absolute、往下展开压住网页
    const popups = [
        {selector: '#menubar .menu.open', rect: rect(240, 40, 340, 60)},
        {selector: '#menubar .menu > .dropdown:not(.hidden)', rect: rect(240, 65, 500, 400)},
    ];
    assert.equal(visibleFor(popups), false);
    // 下拉没展开（hidden）时：即使 .menu.open 也不影响网页
    assert.equal(visibleFor([{selector: '#menubar .menu.open', rect: rect(240, 40, 340, 60)}]), true);
});

test('分栏拖拽遮罩单独判定：显示时隐藏', () => {
    assert.equal(visibleFor([], {splitVisible: true}), false);
});

test('未列入选择器表的浮层由命中测试兜底；右下角 toast 不算', () => {
    const outside = fakeEl(rect(300, 200, 400, 300));
    assert.equal(visibleFor([], {stacking: () => [outside]}), false);
    const toast = fakeEl(rect(300, 200, 400, 300));
    toast.closest = (sel) => (sel === '#app-toasts' ? {} : null);
    assert.equal(visibleFor([], {stacking: () => [toast]}), true);
});

test('浏览器标签不是当前文件：一律隐藏', () => {
    const doc = {id: 'b1', browser: true, browserEl: fakeEl(SURFACE)};
    const other = {id: 'b2'};
    const mod = moduleFor(doc, {file: other});
    assert.equal(mod.browserVisibleFor(doc, SURFACE, fakeDom()), false);
});

// ---- syncBrowserTab：冻结帧显隐与非重叠浮层自愈 ----

async function nextTick() {
    await new Promise((resolve) => setTimeout(resolve, 10));
}

test('同步链路：不相交菜单不隐藏控件；相交浮层隐藏并显示定格帧；关闭后恢复', async () => {
    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    try {
        const calls = [];
        const popups = [];
        const dom = fakeDom({popups});
        globalThis.document = dom;
        globalThis.window = {devicePixelRatio: 1};
        const surface = dom.surface;
        const doc = {id: 'b1', browser: true, browserEl: surface, browserUrl: 'file:///report.html'};
        const backend = {
            BrowserSetBounds: async (...args) => { calls.push(['bounds', ...args]); },
            BrowserSetVisible: async (id, v) => { calls.push(['visible', id, v]); },
            BrowserEnsureZ: async () => { calls.push(['z']); },
            BrowserSnapshot: async () => { calls.push(['snapshot']); return 'AAAA'; },
        };
        const mod = moduleFor(doc, {backend});

        // ① 首次同步：SetBounds + 抓一帧备好定格图
        mod.syncBrowserTab(doc);
        await nextTick();
        assert.equal(calls.some((c) => c[0] === 'bounds'), true);
        await doc.browserSnapshotPending;
        assert.equal(doc.browserSnapshot.url, 'file:///report.html');

        // ② 右侧 AI 面板弹出菜单（不相交）：控件保持可见
        popups.push({selector: '.ctx-menu:not(.hidden)', rect: rect(720, 300, 900, 520)});
        mod.syncBrowserTab(doc);
        await nextTick();
        assert.equal(calls.some((c) => c[0] === 'visible' && c[2] === false), false);
        assert.equal(doc.browserApplied.visible, true);
        assert.equal(doc.browserSnapshotEl || null, null);

        // ③ 菜单展开到网页区域（相交）：隐藏控件，但定格帧仍在
        popups[0].rect = rect(600, 300, 848, 520);
        mod.syncBrowserTab(doc);
        await nextTick();
        assert.equal(calls.some((c) => c[0] === 'visible' && c[2] === false), true);
        assert.equal(doc.browserApplied.visible, false);
        assert.ok(doc.browserSnapshotEl, '相交浮层期间应显示定格帧');
        assert.equal(doc.browserSnapshotEl.src, 'data:image/png;base64,AAAA');

        // ④ 浮层关闭：重新 SetBounds 并撤掉定格帧
        dom.querySelectorAll = () => [];
        mod.syncBrowserTab(doc);
        await nextTick();
        assert.equal(doc.browserApplied.visible, true);
        assert.equal(doc.browserSnapshotEl || null, null);
    } finally {
        if (prevDocument === undefined) delete globalThis.document;
        else globalThis.document = prevDocument;
        if (prevWindow === undefined) delete globalThis.window;
        else globalThis.window = prevWindow;
    }
});

test('syncAllBrowserTabs：多个浏览器标签各自同步，互不被全局锁吞掉', async () => {
    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    try {
        const calls = [];
        const dom = fakeDom({popups: []});
        globalThis.document = dom;
        globalThis.window = {devicePixelRatio: 1};
        // 共用 dom.surface 作为 browserEl：命中测试桩 elementsFromPoint 返回的就是它，
        // 否则会被 browserHasUnknownOverlay 误判成「有浮层遮挡」而一律不显示。
        const docA = {id: 'a', browser: true, browserEl: dom.surface, browserUrl: 'https://a.com'};
        const docB = {id: 'b', browser: true, browserEl: dom.surface, browserUrl: 'https://b.com'};
        const backend = {
            BrowserSetBounds: async (id) => { calls.push(['bounds', id]); },
            BrowserSetVisible: async (id, v) => { calls.push(['visible', id, v]); },
            BrowserEnsureZ: async () => {},
            BrowserSnapshot: async () => '',
        };
        // file 指向 A：B 是非活动标签，应被判定隐藏
        const mod = moduleFor(docA, {file: docA, docs: [docA, docB], backend});
        mod.syncAllBrowserTabs();
        await nextTick();
        assert.ok(calls.some((c) => c[0] === 'bounds' && c[1] === 'a'), '活动标签 A 应摆位/显示');
        assert.ok(calls.some((c) => c[0] === 'visible' && c[1] === 'b' && c[2] === false),
            '非活动标签 B 必须收到隐藏，不能被另一个标签的同步吞掉');
    } finally {
        if (prevDocument === undefined) delete globalThis.document;
        else globalThis.document = prevDocument;
        if (prevWindow === undefined) delete globalThis.window;
        else globalThis.window = prevWindow;
    }
});

test('syncAllBrowserTabs：非活动浏览器标签被隐藏后，切回活动态能恢复显示', async () => {
    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    try {
        const dom = fakeDom({popups: []});
        globalThis.document = dom;
        globalThis.window = {devicePixelRatio: 1};
        // 共用 dom.surface 作为 browserEl：命中测试桩 elementsFromPoint 返回的就是它，
        // 否则会被 browserHasUnknownOverlay 误判成「有浮层遮挡」而一律不显示。
        const docA = {id: 'a', browser: true, browserEl: dom.surface, browserUrl: 'https://a.com'};
        const docB = {id: 'b', browser: true, browserEl: dom.surface, browserUrl: 'https://b.com'};
        const backend = {
            BrowserSetBounds: async () => {},
            BrowserSetVisible: async () => {},
            BrowserEnsureZ: async () => {},
            BrowserSnapshot: async () => '',
        };
        // 直接构造 deps（不走 moduleFor 的展开复制）：file 必须是 getter 活引用，
        // 与 main.js 的 `get file() { return file; }` 一致——activateDoc 切换的是
        // 宿主变量，模块内部经 deps.file 读到的应是新值。
        let currentFile = docA;
        const deps = {
            get file() { return currentFile; },
            docs: [docA, docB],
            backend,
            flash: () => {}, ctxMenu: null, copyText: () => {}, openBrowserTab: () => {},
            openNameDialog: () => {}, renderTabs: () => {}, setFilename: () => {},
            updateWindowTitle: () => {}, els: {editor: {appendChild: () => {}}},
        };
        const mod = createEditorBrowserTab(deps);
        // 第一阶段：A 活动，B 隐藏
        mod.syncAllBrowserTabs();
        await nextTick();
        assert.equal(docB.browserApplied.visible, false, 'B 初始应隐藏');
        // 第二阶段：切到 B（模拟 activateDoc 改了宿主 file 变量）
        currentFile = docB;
        mod.syncAllBrowserTabs();
        await nextTick();
        assert.equal(docB.browserApplied.visible, true, '切回 B 后应重新摆位显示');
        assert.equal(docA.browserApplied.visible, false, 'A 变为非活动应被隐藏');
    } finally {
        if (prevDocument === undefined) delete globalThis.document;
        else globalThis.document = prevDocument;
        if (prevWindow === undefined) delete globalThis.window;
        else globalThis.window = prevWindow;
    }
});

// ---- 固定视口：contain 等比缩放，不再把控件铺出标签页区域 ----

// 动态 surface 桩：矩形跟随内联宽高（模拟真实布局：fixed 尺寸 + margin:auto 居中）
function fakeSurfaceIn(viewRect, toolbarH) {
    const el = fakeEl(null);
    el.classList = {add() {}, remove() {}};
    el.parentElement = {
        isConnected: true,
        getBoundingClientRect: () => viewRect,
        querySelector: (sel) => (sel === '.browser-toolbar'
            ? {getBoundingClientRect: () => rect(0, 0, viewRect.width, toolbarH)}
            : null),
    };
    el.getBoundingClientRect = () => {
        const availW = viewRect.width;
        const availH = viewRect.height - toolbarH;
        const w = el.style.width ? parseFloat(el.style.width) : availW;
        const h = el.style.height ? parseFloat(el.style.height) : availH;
        const left = (availW - w) / 2;
        const top = toolbarH + (availH - h) / 2;
        return rect(left, top, left + w, top + h);
    };
    el.getClientRects = () => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? [r] : [];
    };
    return el;
}

test('固定视口 1280×720 放进 900×564 区域：contain 缩放到 900×506，逻辑视口原样上报', async () => {
    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    try {
        const calls = [];
        globalThis.document = fakeDom({popups: []});
        globalThis.window = {devicePixelRatio: 1};
        const surface = fakeSurfaceIn(rect(0, 0, 900, 600), 36);
        globalThis.document.elementsFromPoint = () => [surface];
        const doc = {id: 'b1', browser: true, browserEl: surface, browserUrl: 'https://example.com', browserViewport: {mode: 'fit'}};
        const backend = {
            BrowserSetBounds: async (...args) => { calls.push(args); },
            BrowserSetVisible: async () => {},
            BrowserSnapshot: async () => '',
        };
        const mod = moduleFor(doc, {backend});
        mod.setBrowserViewport(doc, {mode: 'fixed', width: 1280, height: 720});
        await nextTick();
        assert.equal(calls.length, 1, '切换预设后恰好一次 SetBounds');
        const [id, x, y, w, h, vpW, vpH] = calls[0];
        assert.equal(id, 'b1');
        assert.equal(w, 900);
        assert.equal(h, 506); // round(720 * min(900/1280, 564/720))
        assert.equal(vpW, 1280, '逻辑视口原样交给后端，由后端按缩放设页面视口');
        assert.equal(vpH, 720);
        assert.ok(x >= 0 && y >= 36 && y + h <= 600, '控件矩形不得越出网页区域盖住工具栏/外部界面');
        assert.equal(doc.browserApplied.vpW, 1280, '逻辑视口纳入已应用缓存');
        assert.equal(doc.browserApplied.vpH, 720);
    } finally {
        if (prevDocument === undefined) delete globalThis.document;
        else globalThis.document = prevDocument;
        if (prevWindow === undefined) delete globalThis.window;
        else globalThis.window = prevWindow;
    }
});

test('自适应模式：上报 0 视口（页面随控件尺寸走），物理尺寸按 dpr 换算', async () => {
    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    try {
        const calls = [];
        globalThis.document = fakeDom({popups: []});
        globalThis.window = {devicePixelRatio: 1.25};
        const surface = fakeSurfaceIn(rect(0, 0, 800, 600), 40);
        globalThis.document.elementsFromPoint = () => [surface];
        const doc = {id: 'b1', browser: true, browserEl: surface, browserUrl: 'https://example.com', browserViewport: {mode: 'fixed', width: 4000, height: 3000}};
        const backend = {
            BrowserSetBounds: async (...args) => { calls.push(args); },
            BrowserSetVisible: async () => {},
            BrowserSnapshot: async () => '',
        };
        const mod = moduleFor(doc, {backend});
        mod.setBrowserViewport(doc, {mode: 'fit'});
        await nextTick();
        const [, , , w, h, vpW, vpH] = calls[0];
        assert.equal(w, 1000); // 800css * 1.25
        assert.equal(h, 700);
        assert.equal(vpW, 0);
        assert.equal(vpH, 0);
    } finally {
        if (prevDocument === undefined) delete globalThis.document;
        else globalThis.document = prevDocument;
        if (prevWindow === undefined) delete globalThis.window;
        else globalThis.window = prevWindow;
    }
});

test('预览缩放：档位只缩画面不改逻辑视口，超过「放得下」按实际比例显示', async () => {
    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    try {
        const calls = [];
        globalThis.document = fakeDom({popups: []});
        globalThis.window = {devicePixelRatio: 1};
        const surface = fakeSurfaceIn(rect(0, 0, 900, 600), 36);
        globalThis.document.elementsFromPoint = () => [surface];
        const doc = {id: 'b1', browser: true, browserEl: surface, browserUrl: 'https://example.com', browserViewport: {mode: 'fit'}};
        const backend = {
            BrowserSetBounds: async (...args) => { calls.push(args); },
            BrowserSetVisible: async () => {},
            BrowserSnapshot: async () => '',
        };
        const mod = moduleFor(doc, {backend});
        // 进入固定视口：默认「适应窗口」，900×506
        mod.setBrowserViewport(doc, {mode: 'fixed', width: 1280, height: 720});
        await nextTick();
        assert.equal(mod.browserViewportLabel(doc), '1280×720 · 适应');

        // 50%：画面减半，逻辑视口不变，按钮按真实比例显示
        mod.setBrowserZoom(doc, 50);
        await nextTick();
        const last = calls[calls.length - 1];
        assert.equal(last[3], 640, '50% 时可视宽 = 1280 × 0.5');
        assert.equal(last[4], 360);
        assert.equal(last[5], 1280, '缩放不改变页面逻辑视口');
        assert.equal(mod.browserViewportLabel(doc), '1280×720 · 50%');

        // 100% 超出容器：按 contain 兜底到 70%，按钮显示真实比例而不是「100%」
        mod.setBrowserZoom(doc, 100);
        await nextTick();
        assert.equal(mod.browserViewportLabel(doc), '1280×720 · 70%');

        // 回自适应：缩放档位不再参与显示
        mod.setBrowserViewport(doc, {mode: 'fit'});
        await nextTick();
        assert.equal(mod.browserViewportLabel(doc), '自适应');
    } finally {
        if (prevDocument === undefined) delete globalThis.document;
        else globalThis.document = prevDocument;
        if (prevWindow === undefined) delete globalThis.window;
        else globalThis.window = prevWindow;
    }
});

// ---- 菜单弹出前预隐藏原生控件（消除闪一帧）----

test('hideBrowserBeforeMenu：可见控件先发隐藏并等完成，期间 browserMenuOpening 堵住轮询 Show', async () => {
    const prevWindow = globalThis.window;
    globalThis.window = {devicePixelRatio: 1};
    try {
        const calls = [];
        let resolveHide;
        const doc = {
            id: 'b1', browser: true, browserEl: fakeEl(SURFACE), browserUrl: 'https://example.com',
            browserApplied: {visible: true, x: 1, y: 2, w: 3, h: 4, scale: 1},
        };
        const backend = {
            BrowserSetBounds: async (...a) => { calls.push(['bounds', ...a]); },
            BrowserSetVisible: (id, v) => { calls.push(['visible', id, v]); return new Promise((r) => { resolveHide = r; }); },
            BrowserSnapshot: async () => '',
        };
        const mod = moduleFor(doc, {backend});

        const pending = mod.hideBrowserBeforeMenu(doc);
        assert.equal(doc.browserMenuOpening, true, '等待期间必须堵住轮询');
        assert.deepEqual(calls[0], ['visible', 'b1', false], '立即发隐藏请求');
        assert.equal(doc.browserApplied, null, '作废可见缓存，避免状态卡死');

        // 等待期间轮询进来：browserMenuOpening 让它按不可见处理，不会 Show
        mod.syncBrowserTab(doc);
        await nextTick();
        assert.equal(calls.some((c) => c[0] === 'bounds'), false, '菜单弹出前不得重新摆位/显示控件');

        resolveHide();
        await pending;
        mod.afterBrowserMenuOpen(doc);
        assert.equal(doc.browserMenuOpening, false, '菜单进 DOM 后放行');
        await nextTick(); // 等 afterBrowserMenuOpen 触发的 syncBrowserTab 异步回调跑完
    } finally {
        if (prevWindow === undefined) delete globalThis.window;
        else globalThis.window = prevWindow;
    }
});

test('hideBrowserBeforeMenu：控件已隐藏时不重复发隐藏请求', async () => {
    const calls = [];
    const doc = {
        id: 'b1', browser: true, browserEl: fakeEl(SURFACE), browserUrl: 'https://example.com',
        browserApplied: {visible: false},
    };
    const backend = {
        BrowserSetVisible: (id, v) => { calls.push(['visible', id, v]); return Promise.resolve(); },
    };
    const mod = moduleFor(doc, {backend});
    await mod.hideBrowserBeforeMenu(doc);
    assert.equal(calls.length, 0, '已隐藏就不必再跨进程调用');
    assert.equal(doc.browserMenuOpening, true);
});

test('createBrowserView：工具栏按钮写入 data-tip（全局 tooltip，非原生 title）', async () => {
    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    try {
        const mkEl = () => ({
            className: '', dataset: {}, style: {}, children: [],
            classList: {add() {}, remove() {}, toggle() {}},
            appendChild(n) { this.children.push(n); n.parentNode = this; return n; },
            append(...ns) { for (const n of ns) { this.children.push(n); n.parentNode = this; } },
            addEventListener() {},
            getBoundingClientRect: () => rect(0, 0, 800, 600),
            getClientRects: () => [rect(0, 0, 800, 600)],
            isConnected: true,
        });
        globalThis.document = {
            createElement: mkEl,
            getElementById: () => ({style: {display: 'none'}}),
            querySelectorAll: () => [],
            elementsFromPoint: () => [],
        };
        globalThis.window = {devicePixelRatio: 1};
        const doc = {id: 'b1', browser: true, browserUrl: 'about:blank', browserViewport: {mode: 'fit'}};
        const backend = {
            BrowserSetBounds: async () => {},
            BrowserSetVisible: async () => {},
            BrowserSnapshot: async () => '',
        };
        const mod = moduleFor(doc, {backend});
        mod.createBrowserView(doc);
        await nextTick(); // 等末尾 syncBrowserTab 的异步回调跑完，别在测试结束后访问桩
        // 后退/前进走 mkBtn 的 title → data-tip；视口按钮单独写，也一并核对
        assert.equal(doc.browserBackBtn.dataset.tip, '后退');
        assert.equal(doc.browserFwdBtn.dataset.tip, '前进');
        assert.equal(doc.browserViewportBtn.dataset.tip.startsWith('视口尺寸与预览缩放：'), true);
    } finally {
        if (prevDocument === undefined) delete globalThis.document;
        else globalThis.document = prevDocument;
        if (prevWindow === undefined) delete globalThis.window;
        else globalThis.window = prevWindow;
    }
});
