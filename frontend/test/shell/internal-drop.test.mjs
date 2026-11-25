// internal-drop.test.mjs：应用内文件拖拽落点处理 + 接线断言。
//
// 覆盖：识别自定义 MIME（不误伤 text/plain）、落点高亮与心跳清理、files 落点放行给内部移动、
// drop 读回路径交给路由、以及 explorer/main 的接线。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

import {INTERNAL_PATHS_MIME, encodeDropPaths, decodeDropPaths} from '../../src/core/drop-mime.js';
import {installInternalDrop} from '../../src/shell/internal-drop.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const read = (rel) => readFileSync(join(SRC, rel), 'utf8');

test('drop-mime：路径编解码 roundtrip，坏数据回落空数组', () => {
    const paths = ['D:\\a.png', 'D:\\b.md'];
    assert.deepEqual(decodeDropPaths(encodeDropPaths(paths)), paths);
    assert.deepEqual(decodeDropPaths('not json'), []);
    assert.deepEqual(decodeDropPaths('{}'), []);
    assert.deepEqual(decodeDropPaths(JSON.stringify([1, null, '  '])), []);
});

// 假环境：一个带 data-file-drop-target 的落点元素 + 可控事件派发
function fakeEnv(route) {
    const listeners = new Map();
    const classes = new Set();
    const target = {
        classes,
        classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            contains: (c) => classes.has(c),
        },
        getAttribute: (k) => (k === 'data-file-drop-target' ? route : null),
    };
    const doc = {};
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
        let prevented = false;
        let stopped = false;
        for (const fn of listeners.get(type) || []) {
            fn({
                dataTransfer: {
                    types: [INTERNAL_PATHS_MIME],
                    dropEffect: '',
                    getData: (mime) => (mime === INTERNAL_PATHS_MIME ? encodeDropPaths(['D:\\a.png', 'D:\\b.md']) : ''),
                },
                target: {closest: () => target},
                preventDefault: () => { prevented = true; },
                stopPropagation: () => { stopped = true; },
                ...(props || {}),
            });
        }
        return {prevented, stopped};
    };
    return {win, doc, target, listeners, classes, emit};
}

const opts = (clock, onDrop) => ({
    idleMs: 300,
    now: () => clock.t,
    setTimer: (fn) => { clock.tickFn = fn; return 1; },
    clearTimer: () => { clock.tickFn = null; },
    onDrop,
});

test('dragover(自定义 MIME)：挂高亮 + preventDefault + stopPropagation，心跳兜底清理', () => {
    const env = fakeEnv('ai');
    const clock = {t: 0};
    installInternalDrop(env.win, env.doc, opts(clock));
    const r = env.emit('dragover', {});
    assert.equal(r.prevented, true, '让落点可接收');
    assert.equal(r.stopped, true, '阻止冒泡到文件树内部移动逻辑');
    assert.equal(env.classes.has('file-drop-target-active'), true, '挂高亮遮罩');
    assert.ok(clock.tickFn, '启动心跳');
    clock.t = 500;
    clock.tickFn();
    assert.equal(env.classes.has('file-drop-target-active'), false, '停止 dragover 后超时清理');
});

test('text/plain 拖拽不干预（编辑器选中文字 / 文件树内部移动）', () => {
    const env = fakeEnv('ai');
    installInternalDrop(env.win, env.doc, opts({t: 0}));
    for (const fn of env.listeners.get('dragover') || []) {
        fn({
            dataTransfer: {types: ['text/plain']},
            target: {closest: () => env.target},
            preventDefault: () => {}, stopPropagation: () => {},
        });
    }
    assert.equal(env.classes.size, 0, '不挂高亮');
});

test('files 落点放行给 explorer 内部移动（不拦截、不高亮）', () => {
    const env = fakeEnv('files');
    installInternalDrop(env.win, env.doc, opts({t: 0}));
    const r = env.emit('dragover', {});
    assert.equal(r.prevented, false);
    assert.equal(r.stopped, false);
    assert.equal(env.classes.size, 0, 'files 落点不挂遮罩');
});

test('drop：读回路径 + route 交给 onDrop，并清高亮', () => {
    const env = fakeEnv('editor');
    let got = null;
    installInternalDrop(env.win, env.doc, opts({t: 0}, (paths, route) => { got = {paths, route}; }));
    env.emit('dragover', {});
    assert.equal(env.classes.size, 1);
    const r = env.emit('drop', {});
    assert.equal(r.prevented, true);
    assert.equal(r.stopped, true);
    assert.deepEqual(got, {paths: ['D:\\a.png', 'D:\\b.md'], route: 'editor'});
    assert.equal(env.classes.size, 0, 'drop 后清高亮');
});

test('dragleave(relatedTarget=null) / dragend / blur 清高亮', () => {
    for (const [type, props] of [['dragleave', {relatedTarget: null}], ['dragend', {}], ['blur', {}]]) {
        const env = fakeEnv('ai');
        installInternalDrop(env.win, env.doc, opts({t: 0}));
        env.emit('dragover', {});
        env.emit(type, props);
        assert.equal(env.classes.size, 0, type + ' 应清高亮');
    }
});

test('接线：explorer 写 MIME、main 安装内部落点并喂给 dropRouter', () => {
    const tree = read('explorer/explorer.js');
    assert.match(tree, /import \{INTERNAL_PATHS_MIME, encodeDropPaths\} from '\.\.\/core\/drop-mime\.js';/, '树行引入 MIME');
    assert.match(tree, /e\.dataTransfer\.setData\(INTERNAL_PATHS_MIME, encodeDropPaths\(/, '树行 dragstart 写 MIME');

    const list = read('explorer/explorer-list.js');
    assert.match(list, /row\.draggable = /, '列表行可拖动');
    assert.match(list, /e\.dataTransfer\.setData\(INTERNAL_PATHS_MIME, encodeDropPaths\(/, '列表行 dragstart 写 MIME');

    const main = read('main.js');
    assert.match(main, /import \{installInternalDrop\} from '\.\/shell\/internal-drop\.js';/, 'main 引入');
    assert.match(main, /installInternalDrop\(window, document, \{/, 'main 安装');
    assert.match(main, /dropRouter\.handle\(\{filenames: paths, target: route\}\)/, '落点复用 dropRouter');
});
