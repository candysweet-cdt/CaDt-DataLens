// message-center.test.mjs —— 消息中心：
// 1) 历史迁移纯函数：审批 / 待填写曾被标成 error（红叉图标），读取时统一改成 info（ⓘ），不动真正的错误消息。
// 2) 工厂初始化回归：createMessageCenter 里 let messages = load() 早于 load 依赖的 const，
//    曾因 TDZ 直接抛「Cannot access before initialization」，整个消息中心初始化失败（2026-11-23 运行日志）。
// 3) 清空消息的面板高度收缩动画：关键帧方向、只起一次、逐帧定位、关闭取消、竞态与新消息打断、减少动画。

import test from 'node:test';
import assert from 'node:assert/strict';
import {migrateApprovalKind, createMessageCenter} from '../../src/shell/message-center.js';
import {LAYOUT_MOTION_OPTIONS} from '../../src/ai/chat/ai-layout-motion.js';

test('审批 / 待填写的 error 消息改判为 info', () => {
    for (const title of ['AI 待审批', 'AI 待填写']) {
        const m = {kind: 'error', title};
        assert.equal(migrateApprovalKind(m), true);
        assert.equal(m.kind, 'info');
    }
});

test('60 秒催办的「（仍在等待）」后缀同样迁移', () => {
    const m = {kind: 'error', title: 'AI 待审批（仍在等待）'};
    assert.equal(migrateApprovalKind(m), true);
    assert.equal(m.kind, 'info');
});

test('真正的错误消息与已是 info 的消息不动', () => {
    const failed = {kind: 'error', title: 'AI 任务失败'};
    assert.equal(migrateApprovalKind(failed), false);
    assert.equal(failed.kind, 'error');
    const ok = {kind: 'info', title: 'AI 待审批'};
    assert.equal(migrateApprovalKind(ok), false);
    assert.equal(ok.kind, 'info');
    const other = {kind: 'error', title: '工作区防护提示'};
    assert.equal(migrateApprovalKind(other), false);
    assert.equal(other.kind, 'error');
});

test('空值与脏输入安全返回 false', () => {
    assert.equal(migrateApprovalKind(null), false);
    assert.equal(migrateApprovalKind(undefined), false);
    assert.equal(migrateApprovalKind({}), false);
    assert.equal(migrateApprovalKind({kind: 'error'}), false);
});

test('初始化不抛错，并在读取时剔除旧的「AI 任务完成」流水', () => {
    const prevDoc = globalThis.document;
    const prevStore = globalThis.localStorage;
    globalThis.document = {getElementById: () => null};
    globalThis.localStorage = {
        data: Object.create(null),
        getItem(k) {
            return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null;
        },
        setItem(k, v) {
            this.data[k] = String(v);
        },
        removeItem(k) {
            delete this.data[k];
        },
    };
    try {
        localStorage.setItem('datalens-message-center', JSON.stringify([
            {id: 'm1', ts: 1, kind: 'success', title: 'AI 任务完成', body: ''},
            {id: 'm2', ts: 2, kind: 'info', title: '保留我', body: ''},
        ]));
        // 这一步曾在 load() 里引用尚未初始化的 const 而抛 ReferenceError
        const center = createMessageCenter({});
        assert.deepEqual(Object.keys(center).sort(), ['add', 'clearAll', 'refreshBadge', 'togglePanel']);
        const kept = JSON.parse(localStorage.getItem('datalens-message-center'));
        assert.equal(kept.length, 1);
        assert.equal(kept[0].title, '保留我');
    } finally {
        if (prevDoc === undefined) delete globalThis.document;
        else globalThis.document = prevDoc;
        if (prevStore === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = prevStore;
    }
});

// ---- 动画测试用的轻量 DOM / WAAPI 模拟 ----
// 关键点：textContent 赋值真的清空 children；offsetHeight 由当前内容动态量出（有行=260、空态=80），
// 这样「清空前后量高度」与真实 DOM 一致，能测出 old→new 的真实关键帧方向。

function fakeElement(tag = 'div') {
    return {
        tagName: tag.toUpperCase(),
        children: [],
        style: {
            getPropertyValue() { return ''; },
            setProperty() {},
            removeProperty() {},
        },
        dataset: {},
        classList: {toggle() {}, add() {}, remove() {}, contains() { return false; }},
        innerHTML: '',
        isConnected: true,
        listeners: new Map(),
        _textContent: '',
        _measureHeight: () => 0,
        get textContent() { return this._textContent; },
        set textContent(v) { this._textContent = String(v); this.children.length = 0; },
        get offsetHeight() { return this._measureHeight(); },
        get offsetWidth() { return 340; },
        appendChild(child) { this.children.push(child); return child; },
        append(...children) { this.children.push(...children); },
        addEventListener(type, fn) { this.listeners.set(type, fn); },
        remove() { this.isConnected = false; },
        click() { this.listeners.get('click')?.({stopPropagation() {}}); },
        getBoundingClientRect() { return {left: 900, right: 980, top: 740, bottom: 770, width: 80, height: 30}; },
    };
}

// 面板高度按内容量：有消息行=260，空态=80，都没有=0
function measurePanel(panel) {
    panel._measureHeight = () => {
        if (panel.children.some((c) => String(c.className).includes('msg-center-row'))) return 260;
        if (panel.children.some((c) => String(c.className).includes('msg-center-empty'))) return 80;
        return 0;
    };
}

function installMessageCenterDom() {
    const prev = {
        document: globalThis.document,
        localStorage: globalThis.localStorage,
        window: globalThis.window,
        requestAnimationFrame: globalThis.requestAnimationFrame,
    };
    const button = fakeElement('button');
    const badge = fakeElement();
    const panels = [];
    const frames = [];
    globalThis.document = {
        getElementById(id) { return id === 'btn-messages' ? button : id === 'msg-badge' ? badge : null; },
        createElement: fakeElement,
        body: {appendChild(el) { panels.push(el); }},
    };
    globalThis.localStorage = {
        data: Object.create(null),
        getItem(k) { return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null; },
        setItem(k, v) { this.data[k] = String(v); },
    };
    globalThis.window = {innerWidth: 1000, innerHeight: 800, matchMedia: () => ({matches: false})};
    globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
    window.requestAnimationFrame = globalThis.requestAnimationFrame;
    return {
        button, panels, frames,
        restore() {
            for (const [key, value] of Object.entries(prev)) {
                if (value === undefined) delete globalThis[key];
                else globalThis[key] = value;
            }
        },
    };
}

// 每次 animate() 返回一个独立的动画对象并记录调用，便于断言「只起一次」与关键帧方向
function installAnimations(panel) {
    const calls = [];
    panel.animate = (keyframes, options) => {
        const listeners = new Map();
        const anim = {
            keyframes, options,
            playState: 'running',
            cancelled: false,
            addEventListener(type, fn) { listeners.set(type, fn); },
            cancel() {
                if (this.playState === 'idle') return;
                this.cancelled = true;
                this.playState = 'idle';
                listeners.get('cancel')?.();
            },
            fireFinish() { this.playState = 'finished'; listeners.get('finish')?.(); },
        };
        calls.push(anim);
        return anim;
    };
    return calls;
}

function clearButton(panel) {
    return panel.children[0].children.find((el) => el.className === 'msg-center-clear');
}

test('清空消息：从清空前高度收缩到空态高度，只起一次动画并逐帧定位', () => {
    const dom = installMessageCenterDom();
    try {
        const center = createMessageCenter({});
        center.add({kind: 'info', title: '测试消息', body: '内容'});
        center.togglePanel(dom.button);
        const panel = dom.panels[0];
        measurePanel(panel);
        const calls = installAnimations(panel);
        assert.equal(calls.length, 0, '首次打开面板不应起高度动画');

        clearButton(panel).click();
        assert.equal(panel.children.some((el) => el.textContent === '暂无消息'), true);
        assert.equal(calls.length, 1, '整个清空流程只起一次动画');
        assert.deepEqual(calls[0].keyframes, [
            {height: '260px', overflow: 'hidden'},
            {height: '80px', overflow: 'hidden'},
        ], '从清空前的 260px 收缩到空态 80px');
        assert.deepEqual(calls[0].options, LAYOUT_MOTION_OPTIONS);
        assert.equal(dom.frames.length, 1, '动画起时排了一帧 follow 逐帧重定位');

        calls[0].fireFinish();
        assert.equal(dom.frames.length, 1, 'finish 前排队的残留帧还在');
        dom.frames.shift()();
        assert.equal(dom.frames.length, 0, '动画结束后残留帧执行时不再续排 follow 链');
    } finally {
        dom.restore();
    }
});

test('关闭面板会取消进行中的动画，残留帧不再定位', () => {
    const dom = installMessageCenterDom();
    try {
        const center = createMessageCenter({});
        center.add({kind: 'info', title: '测试消息', body: '内容'});
        center.togglePanel(dom.button);
        const panel = dom.panels[0];
        measurePanel(panel);
        const calls = installAnimations(panel);
        clearButton(panel).click();
        const anim = calls[0];
        const pendingFrame = dom.frames[0];

        center.togglePanel(dom.button);
        assert.equal(anim.cancelled, true, '关闭面板取消进行中的动画');
        assert.equal(panel.isConnected, false, '面板已移除');

        pendingFrame();
        assert.equal(dom.frames.length, 1, '过期帧不再续排 follow 链');
    } finally {
        dom.restore();
    }
});

test('动画进行中新消息进来：取消旧动画，不起从 0 展开的错误动画', () => {
    const dom = installMessageCenterDom();
    try {
        const center = createMessageCenter({});
        center.add({kind: 'info', title: '测试消息', body: '内容'});
        center.togglePanel(dom.button);
        const panel = dom.panels[0];
        measurePanel(panel);
        const calls = installAnimations(panel);
        clearButton(panel).click();
        const shrinkAnim = calls[0];

        // 收缩动画进行中，新消息到达 → refreshBadge 重绘面板
        center.add({kind: 'info', title: '新消息', body: '内容'});
        assert.equal(shrinkAnim.cancelled, true, '旧收缩动画被取消，避免把新列表压向空态高度');
        assert.equal(calls.length, 1, 'refreshBadge 路径不应再起任何高度动画');
        assert.equal(panel.children.some((c) => String(c.className).includes('msg-center-row')), true,
            '面板内容恢复为消息列表');
    } finally {
        dom.restore();
    }
});

test('系统减少动画时清空消息直接切换，不调用 animate', () => {
    const dom = installMessageCenterDom();
    try {
        window.matchMedia = () => ({matches: true});
        const center = createMessageCenter({});
        center.add({kind: 'info', title: '测试消息', body: '内容'});
        center.togglePanel(dom.button);
        const panel = dom.panels[0];
        measurePanel(panel);
        const calls = installAnimations(panel);
        clearButton(panel).click();
        assert.equal(calls.length, 0, '减少动画时不调用 animate');
        assert.equal(dom.frames.length, 0, '不排逐帧回调');
        assert.equal(panel.children.some((el) => el.textContent === '暂无消息'), true);
    } finally {
        dom.restore();
    }
});
