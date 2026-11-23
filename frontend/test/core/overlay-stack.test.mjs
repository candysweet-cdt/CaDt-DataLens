// overlay-stack.test.mjs：全局弹层栈的纯逻辑测试（node:test，无 DOM 依赖）。
// 覆盖：栈序与出栈幂等、z-index 档位分配与还原、dispatchEscape 各守卫
// （Shift+Esc / IME / defaultPrevented / data-esc-local / onClose false 透传 /
// consumesEsc false / 死层自愈 / onClose 异常按消费处理）、共享遮罩的 z 保留。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverlayStack, OVERLAY_TIERS } from '../../src/core/overlay-stack.js';

// 手写 DOM 桩：只提供栈模块用到的面（isConnected / classList / style / contains / closest）。
function fakeEl(opts = {}) {
    const classes = new Set(opts.classes || []);
    return {
        isConnected: opts.isConnected !== false,
        classList: { contains: (c) => classes.has(c) },
        contains: () => !!opts.containsAll,
        closest: () => opts.closestResult || null,
        style: {
            _props: new Map(opts.inlineZ ? [['z-index', opts.inlineZ]] : []),
            setProperty(k, v) { this._props.set(k, v); },
            getPropertyValue(k) { return this._props.get(k) || ''; },
            removeProperty(k) { this._props.delete(k); },
        },
    };
}

function fakeEvent(opts = {}) {
    return {
        key: opts.key || 'Escape',
        shiftKey: !!opts.shiftKey,
        isComposing: !!opts.isComposing,
        defaultPrevented: !!opts.defaultPrevented,
        target: opts.target || null,
        prevented: 0,
        stopped: 0,
        preventDefault() { this.prevented++; },
        stopImmediatePropagation() { this.stopped++; },
    };
}

test('open/top/size/has：后开在上，dispose 幂等', () => {
    const stack = createOverlayStack();
    const h1 = stack.open({ id: 'a', kind: 'dialog', onClose: () => true });
    const h2 = stack.open({ id: 'b', kind: 'modal', onClose: () => true });
    assert.equal(stack.size(), 2);
    assert.equal(stack.top().id, 'b');
    assert.equal(stack.has('a'), true);
    h2.dispose();
    h2.dispose(); // 幂等
    assert.equal(stack.size(), 1);
    assert.equal(stack.top().id, 'a');
    h1.dispose();
    assert.equal(stack.top(), null);
    assert.equal(stack.has('a'), false);
});

test('open 缺 onClose 直接抛错', () => {
    const stack = createOverlayStack();
    assert.throws(() => stack.open({ id: 'x', kind: 'modal' }), /onClose/);
});

test('z-index 档位：el = 基准 + 1 + 栈位，underEl = 基准地板', () => {
    const stack = createOverlayStack();
    const mask = fakeEl();
    const dlg = fakeEl();
    stack.open({ id: 'settings', kind: 'dialog', el: dlg, underEl: mask, onClose: () => true });
    assert.equal(dlg.style.getPropertyValue('z-index'), String(OVERLAY_TIERS.dialog + 1));
    assert.equal(mask.style.getPropertyValue('z-index'), String(OVERLAY_TIERS.dialog));
    const dlg2 = fakeEl();
    stack.open({ id: 'name', kind: 'dialog', el: dlg2, underEl: mask, onClose: () => true });
    assert.equal(dlg2.style.getPropertyValue('z-index'), String(OVERLAY_TIERS.dialog + 2));
    // 关掉顶层子对话框：共享遮罩的内联 z 保留（底下还有一个对话框在用）
    stack.top().handle.dispose();
    assert.equal(mask.style.getPropertyValue('z-index'), String(OVERLAY_TIERS.dialog));
    assert.equal(dlg2.style.getPropertyValue('z-index'), '');
    stack.top().handle.dispose();
    assert.equal(mask.style.getPropertyValue('z-index'), ''); // 最后一个走了，遮罩也还原
    assert.equal(dlg.style.getPropertyValue('z-index'), '');
});

test('z-index 还原：原先已有内联值的元素 dispose 后恢复原值', () => {
    const stack = createOverlayStack();
    const el = fakeEl({ inlineZ: '77' });
    const h = stack.open({ id: 'z', kind: 'menu', el, onClose: () => true });
    assert.equal(el.style.getPropertyValue('z-index'), String(OVERLAY_TIERS.menu + 1));
    h.dispose();
    assert.equal(el.style.getPropertyValue('z-index'), '77');
});

test('tierZ：已知档位返回基准，未知档位回退 popover', () => {
    const stack = createOverlayStack();
    assert.equal(stack.tierZ('menu'), OVERLAY_TIERS.menu);
    assert.equal(stack.tierZ('nope'), OVERLAY_TIERS.popover);
});

test('dispatchEscape：一次 Esc 只退栈顶层', () => {
    const stack = createOverlayStack();
    const log = [];
    stack.open({ id: 'low', kind: 'dialog', onClose: () => { log.push('low'); return true; } });
    stack.open({ id: 'high', kind: 'popover', onClose: () => { log.push('high'); return true; } });
    const e = fakeEvent();
    assert.equal(stack.dispatchEscape(e), true);
    assert.deepEqual(log, ['high']); // 底层未被动
    assert.equal(e.prevented, 1);
    assert.equal(e.stopped, 1);
});

test('dispatchEscape：onClose 返回 false = 让路给下一层', () => {
    const stack = createOverlayStack();
    const log = [];
    stack.open({ id: 'low', kind: 'dialog', onClose: () => { log.push('low'); return true; } });
    stack.open({ id: 'high', kind: 'modal', onClose: () => { log.push('high'); return false; } });
    const e = fakeEvent();
    assert.equal(stack.dispatchEscape(e), true);
    assert.deepEqual(log, ['high', 'low']);
    assert.equal(stack.size(), 2); // 让路的层不销毁，还在栈里
});

test('dispatchEscape：空栈不消费，事件流向旧监听', () => {
    const stack = createOverlayStack();
    const e = fakeEvent();
    assert.equal(stack.dispatchEscape(e), false);
    assert.equal(e.prevented, 0);
    assert.equal(e.stopped, 0);
});

test('dispatchEscape：Shift / IME 组合态 / defaultPrevented / 非 Escape 一律让路', () => {
    const stack = createOverlayStack();
    let closed = 0;
    stack.open({ id: 'x', kind: 'menu', onClose: () => { closed++; return true; } });
    assert.equal(stack.dispatchEscape(fakeEvent({ shiftKey: true })), false);
    assert.equal(stack.dispatchEscape(fakeEvent({ isComposing: true })), false);
    assert.equal(stack.dispatchEscape(fakeEvent({ defaultPrevented: true })), false);
    assert.equal(stack.dispatchEscape(fakeEvent({ key: 'Enter' })), false);
    assert.equal(closed, 0);
});

test('dispatchEscape：data-esc-local 在顶层子树内 → 整体让路', () => {
    const stack = createOverlayStack();
    const dlg = fakeEl({ containsAll: true });
    const localInput = { closest: (sel) => (sel === '[data-esc-local]' ? { __el: true } : null) };
    stack.open({ id: 'settings', kind: 'dialog', el: dlg, onClose: () => true });
    const e = fakeEvent({ target: localInput });
    assert.equal(stack.dispatchEscape(e), false); // 让路：Esc 语义归元素（如清搜索词）
    assert.equal(e.prevented, 0);
});

test('dispatchEscape：data-esc-local 不在顶层子树内 → 照常消费', () => {
    const stack = createOverlayStack();
    const dlg = fakeEl({ containsAll: false }); // contains 恒 false = 标记元素不在本层内
    const localInput = { closest: () => ({ __el: true }) };
    let closed = 0;
    stack.open({ id: 'settings', kind: 'dialog', el: dlg, onClose: () => { closed++; return true; } });
    assert.equal(stack.dispatchEscape(fakeEvent({ target: localInput })), true);
    assert.equal(closed, 1);
});

test('dispatchEscape：consumesEsc false 的层被跳过，下层消费', () => {
    const stack = createOverlayStack();
    const log = [];
    stack.open({ id: 'low', kind: 'popover', onClose: () => { log.push('low'); return true; } });
    stack.open({ id: 'hover', kind: 'popover', consumesEsc: false, onClose: () => { log.push('hover'); return true; } });
    assert.equal(stack.dispatchEscape(fakeEvent()), true);
    assert.deepEqual(log, ['low']);
});

test('dispatchEscape：死层自愈——断连 / hidden 的条目被清除后由下层消费', () => {
    const stack = createOverlayStack();
    const log = [];
    stack.open({ id: 'low', kind: 'dialog', onClose: () => { log.push('low'); return true; } });
    const deadDetached = fakeEl({ isConnected: false });
    stack.open({ id: 'dead1', kind: 'modal', el: deadDetached, onClose: () => true });
    const deadHidden = fakeEl({ classes: ['hidden'] });
    stack.open({ id: 'dead2', kind: 'modal', el: deadHidden, onClose: () => true });
    assert.equal(stack.size(), 3);
    assert.equal(stack.dispatchEscape(fakeEvent()), true);
    assert.deepEqual(log, ['low']);
    assert.equal(stack.size(), 1); // 两个死层已顺手清除
});

test('dispatchEscape：自定义 isAlive 优先于默认探活', () => {
    const stack = createOverlayStack();
    const el = fakeEl(); // connected 且不 hidden，但业务侧判定已关闭
    stack.open({
        id: 'custom', kind: 'modal', el,
        isAlive: () => false,
        onClose: () => true,
    });
    assert.equal(stack.dispatchEscape(fakeEvent()), false);
    assert.equal(stack.size(), 0);
});

test('dispatchEscape：onClose 抛异常按已消费处理，不向外抛', () => {
    const stack = createOverlayStack();
    stack.open({ id: 'boom', kind: 'menu', onClose: () => { throw new Error('boom'); } });
    const e = fakeEvent();
    assert.equal(stack.dispatchEscape(e), true);
    assert.equal(e.stopped, 1);
});

test('dispatchEscape：onClose 连带出栈多条后仍能继续向下消费', () => {
    const stack = createOverlayStack();
    const log = [];
    const hLow = stack.open({ id: 'low', kind: 'dialog', onClose: () => { log.push('low'); return true; } });
    stack.open({ id: 'mid', kind: 'dialog', onClose: () => { log.push('mid'); return true; } });
    stack.open({
        id: 'high', kind: 'modal',
        onClose: () => { log.push('high'); hLow.dispose(); return false; }, // 连带把底层也拆了
    });
    assert.equal(stack.dispatchEscape(fakeEvent()), true);
    assert.deepEqual(log, ['high', 'mid']); // low 已被连带出栈，不再被消费
    assert.equal(stack.size(), 2); // mid 消费后未自拆（无元素托管）仍在栈里，由探活兜底
});

test('dispatchOutsideClick：点在 el 内放行、点在 el 外关闭，打开当帧不判定', async () => {
    const stack = createOverlayStack();
    const inside = fakeEl();
    const outside = fakeEl();
    const panel = fakeEl();
    panel.contains = (t) => t === inside;
    let closed = 0;
    stack.open({ id: 'pop', kind: 'popover', el: panel, closeOnOutsideClick: true, onClose: () => { closed++; return true; } });
    // 打开当帧的 pointerdown 不关闭（pendingActivate）
    assert.equal(stack.dispatchOutsideClick(fakeEvent({ target: outside })), false);
    await new Promise((r) => setTimeout(r, 0));
    // 点在内部不关
    assert.equal(stack.dispatchOutsideClick(fakeEvent({ target: inside })), false);
    assert.equal(stack.size(), 1);
    assert.equal(closed, 0);
    // 点在外部关闭：必须走 onClose（浮层在回调里移除 DOM，否则残留后被面板盖住）
    assert.equal(stack.dispatchOutsideClick(fakeEvent({ target: outside })), true);
    assert.equal(closed, 1);
    assert.equal(stack.size(), 0);
});

test('dispatchOutsideClick：anchors 命中不关闭', async () => {
    const stack = createOverlayStack();
    const anchorTarget = fakeEl();
    const anchor = { contains: (t) => t === anchorTarget };
    const outside = fakeEl();
    const panel = fakeEl();
    panel.contains = () => false;
    stack.open({ id: 'pop', kind: 'popover', el: panel, closeOnOutsideClick: true, anchors: [anchor], onClose: () => true });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(stack.dispatchOutsideClick(fakeEvent({ target: anchorTarget })), false);
    assert.equal(stack.size(), 1);
    assert.equal(stack.dispatchOutsideClick(fakeEvent({ target: outside })), true);
    assert.equal(stack.size(), 0);
});

test('dispatchOutsideClick：选择器 anchors 动态判定（锚点重渲染后仍放行）', async () => {
    const stack = createOverlayStack();
    const panel = fakeEl();
    panel.contains = () => false;
    // 用选择器字符串作 anchor
    stack.open({ id: 'pop', kind: 'popover', el: panel, closeOnOutsideClick: true,
        anchors: ['[data-ai-act="usage"]'], onClose: () => true });
    await new Promise((r) => setTimeout(r, 0));
    // 模拟重渲染后的新徽标节点：closest 命中选择器 → 放行
    const newBadge = {closest: (sel) => (sel === '[data-ai-act="usage"]' ? {} : null)};
    assert.equal(stack.dispatchOutsideClick(fakeEvent({ target: newBadge })), false);
    assert.equal(stack.size(), 1);
    // 点别处 → 关闭
    assert.equal(stack.dispatchOutsideClick(fakeEvent({ target: fakeEl() })), true);
    assert.equal(stack.size(), 0);
});

test('dispatchOutsideClick：未启用该选项的层不响应', () => {
    const stack = createOverlayStack();
    stack.open({ id: 'plain', kind: 'popover', onClose: () => true });
    assert.equal(stack.dispatchOutsideClick(fakeEvent({ target: fakeEl() })), false);
    assert.equal(stack.size(), 1);
});
