// file-drop-router.test.mjs：外部拖放落点路由（纯逻辑 + 分派）与 DOM 属性契约。
//
// 分两种断言：
//   ① 行为——载荷归一（去重/去空白/未知落点归 none）与四个落点的分派结果；
//   ② 契约——index.html 的 data-file-drop-target 标注、行级 data-drop-dir、以及旧的
//      「5 秒 pending 目录」hack 必须彻底消失（它正是本次重构要替换掉的猜法）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

import {DROP_ROUTES, normalizeDropPaths, routeExternalDrop, createFileDropRouter} from '../../src/shell/file-drop-router.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readSrc = (rel) => readFileSync(join(ROOT, 'src', rel), 'utf8');

test('normalizeDropPaths：去空白、批内去重（大小写不敏感）、保序', () => {
    assert.deepEqual(normalizeDropPaths(['D:\\a.png', '  ', 'd:\\A.PNG', 'D:\\b.md']), ['D:\\a.png', 'D:\\b.md']);
    assert.deepEqual(normalizeDropPaths(null), []);
    assert.deepEqual(normalizeDropPaths([1, 2]), ['1', '2']);
});

test('routeExternalDrop：未知/缺失落点一律 none，属性只认 data-drop-dir', () => {
    assert.equal(routeExternalDrop(null).target, 'none');
    assert.equal(routeExternalDrop({filenames: ['D:\\a']}).target, 'none');
    const unknown = routeExternalDrop({filenames: ['D:\\a'], target: 'nope'});
    assert.equal(unknown.target, 'none');
    assert.equal(unknown.rawTarget, 'nope');
    const files = routeExternalDrop({
        filenames: ['D:\\a.png'],
        target: 'files',
        attrs: {'data-drop-dir': '  D:\\work\\docs  ', 'data-path': 'D:\\work\\docs'},
    });
    assert.equal(files.target, DROP_ROUTES.FILES);
    assert.equal(files.dir, 'D:\\work\\docs');
    assert.deepEqual(files.paths, ['D:\\a.png']);
});

// 一个最小的假 deps：记录每个处理器收到的参数，flash 收集提示文案
function fakeDeps(overrides) {
    const calls = {open: [], copy: [], db: [], ai: [], flash: []};
    const deps = {
        flash: (msg, isError) => calls.flash.push({msg, isError: !!isError}),
        openPaths: (paths) => calls.open.push(paths),
        copyIntoDir: (paths, dir) => calls.copy.push({paths, dir}),
        workspaceFolder: () => 'D:\\work',
        dbDrop: (paths) => calls.db.push(paths),
        aiAttach: (paths) => calls.ai.push(paths),
        ...(overrides || {}),
    };
    return {deps, calls};
}

test('router：编辑区 / AI / 数据库 分派，多文件保序', async () => {
    const a = fakeDeps();
    const router = createFileDropRouter(a.deps);
    await router.handle({filenames: ['D:\\1.png', 'D:\\2.png'], target: 'editor'});
    await router.handle({filenames: ['D:\\3.md'], target: 'ai'});
    await router.handle({filenames: ['D:\\4.db'], target: 'db'});
    assert.deepEqual(a.calls.open, [['D:\\1.png', 'D:\\2.png']]);
    assert.deepEqual(a.calls.ai, [['D:\\3.md']]);
    assert.deepEqual(a.calls.db, [['D:\\4.db']]);
    assert.equal(a.calls.flash.length, 0);
});

test('router：文件树落点优先 data-drop-dir，其次工作区根；无工作区只提示不复制', async () => {
    const withDir = fakeDeps();
    await createFileDropRouter(withDir.deps).handle({
        filenames: ['D:\\x.png'], target: 'files', attrs: {'data-drop-dir': 'D:\\work\\sub'},
    });
    assert.deepEqual(withDir.calls.copy, [{paths: ['D:\\x.png'], dir: 'D:\\work\\sub'}]);

    const root = fakeDeps();
    await createFileDropRouter(root.deps).handle({filenames: ['D:\\x.png'], target: 'files'});
    assert.deepEqual(root.calls.copy, [{paths: ['D:\\x.png'], dir: 'D:\\work'}]);

    const noWs = fakeDeps({workspaceFolder: () => ''});
    const out = await createFileDropRouter(noWs.deps).handle({filenames: ['D:\\x.png'], target: 'files'});
    assert.equal(out.handled, 0);
    assert.equal(noWs.calls.copy.length, 0);
    assert.equal(noWs.calls.flash.length, 1);
    assert.equal(noWs.calls.flash[0].isError, true);
});

test('router：未标注落点什么都不做，处理器抛错收口成一条提示', async () => {
    const quiet = fakeDeps();
    const out = await createFileDropRouter(quiet.deps).handle({filenames: ['D:\\a'], target: 'git-panel'});
    assert.equal(out.target, 'none');
    assert.equal(quiet.calls.flash.length, 0);
    assert.equal(quiet.calls.open.length + quiet.calls.copy.length + quiet.calls.db.length + quiet.calls.ai.length, 0);

    const boom = fakeDeps({aiAttach: () => { throw new Error('读图炸了'); }});
    const result = await createFileDropRouter(boom.deps).handle({filenames: ['D:\\a.png'], target: 'ai'});
    assert.equal(result.handled, 0);
    assert.equal(boom.calls.flash.length, 1);
    assert.match(boom.calls.flash[0].msg, /拖放处理失败：读图炸了/);
});

test('index.html：四个落点标注齐备，body 不再是落点（未标注区域无效果）', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /<body[^>]*data-file-drop-target/, 'body 不能兜底成落点——否则「其他面板无效果」不成立');
    for (const [id, route] of [['editor-area', 'editor'], ['sb-body', 'files'], ['database-panel', 'db'], ['ai-panel', 'ai']]) {
        const tag = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`));
        assert.ok(tag, '找不到元素：' + id);
        assert.match(tag[0], new RegExp(`data-file-drop-target="${route}"`), id + ' 的落点应是 ' + route);
        assert.match(tag[0], /data-drop-hint="[^"]+"/, id + ' 应有拖放提示文案（面板级遮罩用）');
    }
});

test('落点遮罩：面板级提示遮罩走 CSS 伪元素，不进弹层栈、不拦 hit-test', () => {
    const css = readFileSync(join(ROOT, 'src', 'style.css'), 'utf8');
    assert.match(css, /\[data-drop-hint\]\.file-drop-target-active::after \{/, '遮罩由伪元素实现');
    assert.match(css, /content: attr\(data-drop-hint\)/, '文案取自 data-drop-hint');
    assert.match(css, /pointer-events: none/, '遮罩不参与 hit-test，Wails 的 closest 判定不受影响');
});

test('文件树行标注 data-drop-dir；旧 5 秒 pending 目录 hack 已彻底移除', () => {
    const tree = readSrc('explorer/explorer.js');
    assert.match(tree, /row\.dataset\.fileDropTarget = 'files';/, '树行必须标 files 落点');
    assert.match(tree, /row\.dataset\.dropDir = node\.isDir \? node\.path : parentPath\(node\.path\);/, '目录行=自身、文件行=父目录');
    assert.doesNotMatch(tree, /onExternalDrop/, '树模块不再有 onExternalDrop 接缝');

    const list = readSrc('explorer/explorer-list.js');
    assert.match(list, /row\.dataset\.dropDir = parentDirOf\(entry\.path\);/, '列表行落点=父目录');

    const appActions = readSrc('shell/app-actions.js');
    const main = readSrc('main.js');
    assert.doesNotMatch(appActions, /pendingExternalDrop/, 'app-actions 不该再有 pending 目录状态');
    assert.doesNotMatch(main, /pendingExternalDrop|setPendingExternalDrop|getPendingExternalDrop/,
        'main.js 不该再消费 pending 目录');
    assert.match(main, /appEvents\.onWindow\('app-file-drop', \(data\) => \{[\s\S]*?dropRouter\.handle\(data\)[\s\S]*?\}\);/,
        '事件应交给路由（函数体里还同步清高亮）');
});
