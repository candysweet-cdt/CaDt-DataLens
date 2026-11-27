// 应用页面「按工作区开多份」的守卫。
//
// 背景（2026-11-26）：认知索引 / 补丁库的数据物理上在各工作区里（<ws>/.cadt/cognition、
// <ws>/.cadt/patches）。原先应用页面是**全局单例**——`docs.find(d => d.appPage === page.id)`
// 不区分工作区，切走工作区后开着的那份仍按「当前根」取数，于是要么静默显示别的仓库的内容，
// 要么必须手动点刷新才更新。改成 perWorkspace：同一页可以为不同仓库各开一个标签页，
// 各绑各的固定根，页面内显示所属工作区路径。
//
// 本测试锁三件事：
//   1. 哪几个页面是 perWorkspace（编排与认知索引 / 补丁库都是工作区级数据）；
//   2. 标签页去重按 (pageId, 根) —— 不同根必须各开一份；
//   3. 标签名在多工作区下带仓库名、单工作区不带。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {APP_PAGES, appPageOf, appPageTabTitle} from '../../src/core/app-pages.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '../..', rel), 'utf8');

test('perWorkspace 只标真正工作区级的页面', () => {
    const perWs = APP_PAGES.filter((p) => p.perWorkspace).map((p) => p.id).sort();
    assert.deepEqual(perWs, ['cognition', 'orchestration', 'patches'],
        '编排的批次/看板按工作区隔离，与认知索引、补丁库同属工作区级数据；其余页（使用统计 / '
        + '定时任务 / 操作记录 / 外部工具 / 智能体）是全局数据，标成 perWorkspace 会让同一份数据被拆成多个标签页');
    // 每个 perWorkspace 页都要在 desc 里说清是工作区级数据，否则用户不明白为什么会开多份
    for (const id of perWs) {
        const page = appPageOf(id);
        assert.ok(page && page.desc.length > 0, id + ' 缺少说明文案');
    }
});

test('appPageTabTitle：多工作区带仓库名，单工作区不带', () => {
    const patches = appPageOf('patches');
    const usage = appPageOf('usage-stats');
    assert.equal(appPageTabTitle(patches, 'D:\\repo\\日记星辰', true), '补丁库 · 日记星辰');
    assert.equal(appPageTabTitle(patches, 'D:\\repo\\日记星辰', false), '补丁库',
        '单工作区只有一个仓库，加后缀是噪音');
    assert.equal(appPageTabTitle(usage, 'D:\\repo\\x', true), '使用统计',
        '全局页不带工作区名');
    // 根为空（会话沙盒 / 尚未就绪）时不拼出「补丁库 · 」这种残缺标题
    assert.equal(appPageTabTitle(patches, '', true), '补丁库');
    assert.equal(appPageTabTitle(null, 'D:\\repo', true), '');
});

test('标签页去重按 (页面, 工作区)：不同根必须各开一份', () => {
    const src = read('src/bridge/bridge-app-page-view.js');
    // 单例判定必须带上根比较，否则第二个仓库的同一页会被当成重复直接激活
    assert.match(src, /d\.appPage === page\.id[\s\S]{0,120}?sameRoot\(d\.appPageWorkspace, wantRoot\)/,
        'perWorkspace 页的去重要求 appPage 相同**且**根相同');
    // doc.appPage 必须保持**纯页面 id**：appPageOf() 与 appPageMounters[doc.appPage] 都靠它查
    // 元数据与挂载器；拼成 `cognition@d:/...` 复合键会让标签页显示「界面尚未就绪」（实测回归）。
    assert.match(src, /key:\s*page\.id,/, 'doc.appPage 必须是纯页面 id');
    assert.doesNotMatch(src, /key:\s*rootKey \? page\.id \+/,
        '不能把工作区拼进 doc.appPage——它是页面元数据的查找键，不是身份键');
    // 区分工作区靠这两个：
    assert.match(src, /doc\.appPageWorkspace = wantRoot;/, '工作区维度记在 appPageWorkspace 上');
    assert.match(src, /'apppage-' \+ page\.id \+ '-/,
        '标签 id 仍带工作区哈希（展示层不冲突）');
    // mount 的第二个参数就是该标签绑定的根
    assert.match(src, /mount\(root, doc\.appPageWorkspace \|\| ''\)/,
        'mount 必须把绑定的根传给页面（页面据此固定工作区，不再随当前根漂移）');
});

test('perWorkspace 页在 mount 时锁根，不随当前根漂移', () => {
    const patches = read('src/settings/settings-pane-patches.js');
    assert.match(patches, /function mount\(host, workspaceRoot\)/, '补丁库 mount 要接受固定根');
    assert.match(patches, /if \(mountedRoot\) return mountedRoot;/, '根解析优先用 mount 时的固定根');

    const cognition = read('src/ai/settings/ai-cognition-page.js');
    assert.match(cognition, /function mount\(host, workspaceRoot\)/, '认知索引 mount 要接受固定根');
    assert.match(cognition, /if \(mountedRoot\) return mountedRoot;/, '根解析优先用 mount 时的固定根');
});

test('每个标签页独立实例：共用单例会让两个标签互相覆盖', () => {
    const main = read('src/main.js');
    // 补丁库 / 认知索引都有模块级状态（els / allPatches / hostEl / snapshot），
    // 共用实例时第二个标签 mount 会把第一个的状态覆盖掉。
    assert.match(main, /function makePatchesPane\(workspaceRoot\)/, '补丁库要工厂化（每标签一实例）');
    assert.match(main, /'patches': \(root, ws\) => makePatchesPane\(ws\)\.mount\(root, ws\)/,
        '补丁库 mounter 必须每标签新建实例');
    assert.match(main, /cognitionPageInstances = new WeakMap\(\)/, '认知索引实例要按 root 记录（供逐标签刷新）');
    // 刷新要遍历所有开着的认知页标签，不能只刷第一个
    assert.match(main, /function refreshCognitionPageIfVisible\(\) \{[\s\S]{0,400}?for \(const doc of docs\)/,
        '认知页刷新必须遍历所有标签（多工作区下同一页可能开着多份）');
});

test('页面内显示所属工作区（否则多份标签分不清是哪个仓库）', () => {
    const patches = read('src/settings/settings-pane-patches.js');
    assert.match(patches, /'工作区：' \+ mountedRoot/, '补丁库页头要显示工作区路径');
    const cognition = read('src/ai/settings/ai-cognition-page.js');
    assert.match(cognition, /'工作区：' \+ mountedRoot/, '认知索引页头要显示工作区路径');
    // 样式：与既有 .ap-patch-path 同款（小字、muted、负上边距贴住页头）
    const css = read('src/style.css');
    assert.match(css, /\.cog-workspace \{/, '认知索引的工作区行缺样式');
});

test('全局页不受影响：仍然是单例', () => {
    const src = read('src/bridge/bridge-app-page-view.js');
    // 全局页 wantRoot 恒为空 → sameRoot('' , '') 命中 → 复用同一个标签页
    assert.match(src, /const wantRoot = page\.perWorkspace[\s\S]{0,120}?: '';/,
        '全局页的 wantRoot 必须恒为空串，才能保持单例语义');
});
