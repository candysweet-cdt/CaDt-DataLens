// file-drop-highlight.test.mjs：拖放高亮兜底清理的单元 + 接线测试。
//
// 根因：Wails runtime 的 dragleave 在 relatedTarget==null（离开窗口）时 return，且无 dragend，
// 导致 file-drop-target-active 永久残留（提示遮罩一直悬浮）。这里验证兜底清理的各条路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

import {installDropHighlightFallback} from '../../src/shell/file-drop-highlight.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const read = (rel) => readFileSync(join(SRC, rel), 'utf8');

// 假 DOM：一个可增删 file-drop-target-active 的元素 + 可控 relatedTarget 的事件派发
function fakeEnv() {
    const listeners = new Map();
    const classes = new Set(['file-drop-target-active']);
    const doc = {
        querySelector: (sel) => (sel === '.file-drop-target-active' && classes.size ? {tag: 'active'} : null),
        querySelectorAll: (sel) => (sel === '.file-drop-target-active' && classes.size
            ? [{classList: {
                contains: (c) => c === 'file-drop-target-active' && classes.has(c),
                remove: (c) => classes.delete(c),
            }}]
            : []),
    };
    const win = {
        addEventListener: (type, fn) => {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        },
        removeEventListener: (type, fn) => {
            const arr = listeners.get(type) || [];
            const i = arr.indexOf(fn);
            if (i >= 0) arr.splice(i, 1);
        },
    };
    const emit = (type, props) => {
        for (const fn of listeners.get(type) || []) fn({dataTransfer: {types: ['Files']}, ...(props || {})});
    };
    return {win, doc, listeners, classes, emit,
        tick: (fn, ms) => fn(), // 直接触发心跳回调
    };
}

const opts = (clock) => ({
    idleMs: 300,
    now: () => clock.t,
    setTimer: (fn) => { clock.tickFn = fn; return 1; },
    clearTimer: () => { clock.tickFn = null; },
});

test('dragleave(relatedTarget=null) 离开窗口 → 立即清高亮', () => {
    const env = fakeEnv();
    installDropHighlightFallback(env.win, env.doc, opts({t: 0}));
    assert.equal(env.classes.size, 1);
    env.emit('dragleave', {relatedTarget: null});
    assert.equal(env.classes.size, 0, '离开窗口必须清掉残留高亮');
});

test('子元素间移动（relatedTarget 非 null）不误清，交给 runtime', () => {
    const env = fakeEnv();
    installDropHighlightFallback(env.win, env.doc, opts({t: 0}));
    env.emit('dragleave', {relatedTarget: {tag: 'child'}});
    assert.equal(env.classes.size, 1, '子元素间移动不该清高亮');
});

test('心跳：dragover 持续更新，停止超过阈值才清（覆盖 dragleave 丢失的拖出窗口场景）', () => {
    const env = fakeEnv();
    const clock = {t: 0};
    installDropHighlightFallback(env.win, env.doc, opts(clock));

    // dragover 让心跳活起来
    env.emit('dragover', {});
    assert.ok(clock.tickFn, 'dragover 应启动心跳定时器');
    clock.t = 200;
    clock.tickFn();
    assert.equal(env.classes.size, 1, '200ms 未超时，不清');

    // 拖出窗口后 dragover 停止，时间越过阈值 → 清
    clock.t = 400;
    clock.tickFn();
    assert.equal(env.classes.size, 0, '超过 300ms 没 dragover，清掉残留高亮');
});

test('dragover 会重置心跳（拖拽中偶发停顿不误清）', () => {
    const env = fakeEnv();
    const clock = {t: 0};
    installDropHighlightFallback(env.win, env.doc, opts(clock));
    env.emit('dragover', {}); // lastOverAt=0
    clock.t = 250;
    env.emit('dragover', {}); // lastOverAt=250（重置）
    clock.tickFn();           // now=250, 差 0，不清
    assert.equal(env.classes.size, 1);
    clock.t = 600;            // 差 350 > 300
    clock.tickFn();
    assert.equal(env.classes.size, 0);
});

test('drop / dragend / blur 都立即清；非 Files 拖拽不干预', () => {
    for (const type of ['drop', 'dragend', 'blur']) {
        const env = fakeEnv();
        installDropHighlightFallback(env.win, env.doc, opts({t: 0}));
        env.emit(type, {});
        assert.equal(env.classes.size, 0, type + ' 应清高亮');
    }
    const env = fakeEnv();
    installDropHighlightFallback(env.win, env.doc, opts({t: 0}));
    for (const fn of env.listeners.get('dragleave') || []) {
        fn({dataTransfer: {types: ['text/plain']}, relatedTarget: null});
    }
    assert.equal(env.classes.size, 1, 'text/plain 拖拽（文件树内部拖拽）不干预');
});

test('uninstall 摘监听并清残留', () => {
    const env = fakeEnv();
    const uninstall = installDropHighlightFallback(env.win, env.doc, opts({t: 0}));
    uninstall();
    assert.equal(env.classes.size, 0);
    env.emit('dragover', {});
    assert.equal(env.listeners.get('dragover').length, 0, '监听应已摘除');
});

test('接线：main.js 安装兜底，并在 app-file-drop 处理末尾同步清一次', () => {
    const main = read('main.js');
    assert.match(main, /import \{installDropHighlightFallback\} from '\.\/shell\/file-drop-highlight\.js';/, '引入兜底模块');
    assert.match(main, /installDropHighlightFallback\(window, document\);/, '启动时安装');
    assert.match(main, /appEvents\.onWindow\('app-file-drop', \(data\) => \{/, '事件处理改成函数体（末尾清高亮）');
    assert.match(main, /querySelectorAll\('\.file-drop-target-active'\)\.forEach\(\(el\) => el\.classList\.remove\('file-drop-target-active'\)\)/,
        'drop 到达时同步清高亮');
});
