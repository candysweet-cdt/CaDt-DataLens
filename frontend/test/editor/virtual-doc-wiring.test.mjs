// virtual-doc-wiring.test.mjs —— 内容区「虚拟文档」标签页的接线守卫。
//
// 「一切皆标签页」：内容区里任何东西都是一个 doc、占一个标签页。doc 分两类：
//   · 文件标签页 path ≠ null
//   · 虚拟标签页 path === null，又分两族：
//       视图型（本文件重点）——doc 上有标记位，createDocEditor 建自定义面板，没有 doc.editor
//       文本型——openVirtualDoc 产出（untitled + viewKind），复用通用编辑器
//
// 视图型类型的单一来源是 `core/tab-kinds.js` 的 TAB_KINDS。本守卫以它为准逐处对账
// 「接线点是否都认得这一类」。历史上这里是从 createDocEditor 的 if 链正则反推类型集合，
// 那种写法有两个洞：漏了图标链（浏览器标签页长期显示成普通文本图标）、
// 完全看不到文本型虚拟文档（复用通用编辑器，没有分支可推）。
//
// 漏接线的代价是**静默降级**——图标退化成文件图标、视图下拉里出现「文本 / 树」、
// 关标签后订阅与 DOM 泄漏。都不会报错，所以必须有守卫。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TAB_KINDS} from '../../src/core/tab-kinds.js';
import {ICONS} from '../../src/core/icons.js';

const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const read = (rel) => readFileSync(join(srcRoot, rel), 'utf8');

const groupsSrc = read('editor/editor-groups.js');
const writingSrc = read('writing/writing-ui.js');
const mainSrc = read('main.js');
// appTabViewOf / APP_TAB_KIND_LABELS 已拆到 shell/app-action-context.js（超线治理第 3 批）
const appActionSrc = read('shell/app-action-context.js');
const bridgeSrc = readdirSync(join(srcRoot, 'bridge'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => read('bridge/' + name))
    .join('\n');

// 整棵 src 树的源码（文本型虚拟文档的 viewKind 产生点散在 ai / bridge / git-graph 多处）
function allSourceFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...allSourceFiles(full));
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}
const srcAll = allSourceFiles(srcRoot).map((file) => readFileSync(file, 'utf8')).join('\n');

// 切出顶层函数体（这些文件的域函数都在 0 缩进的 `function` 层）。
function sliceTopFunction(text, signature) {
    const start = text.indexOf(signature);
    assert.ok(start >= 0, '找不到函数：' + signature);
    const rest = text.slice(start + signature.length);
    const next = /\nfunction [A-Za-z_]/.exec(rest);
    return signature + (next ? rest.slice(0, next.index) : rest);
}

// 切出一个 `const NAME = { … };` 对象字面量的正文（不含外层括号）。
function sliceObjectLiteral(text, signature) {
    const start = text.indexOf(signature);
    assert.ok(start >= 0, '找不到对象字面量：' + signature);
    const rest = text.slice(start + signature.length);
    // 兼容顶格 `};` 与缩进 `    };`（模块内常量在 factory 里，闭合带缩进）。
    // 缩进只吃空格/制表符，不能吃换行——否则会跨过最近的闭合匹配到更后面的。
    const end = rest.search(/\n[ \t]*\};/);
    assert.ok(end >= 0, signature + ' 的闭合括号没找到（结构变了就更新本守卫）');
    return rest.slice(0, end);
}

const createEditorBody = sliceTopFunction(groupsSrc, 'function createDocEditor(doc) {');
const closeDocBody = sliceTopFunction(groupsSrc, 'function closeDocNow(doc, remember = true) {');
const buildTabBody = sliceTopFunction(groupsSrc, 'function buildGroupTab(g, doc, strip) {');
const viewDispatchBody = sliceObjectLiteral(groupsSrc, 'const VIRTUAL_TAB_VIEWS = {');
const viewOptionsBody = sliceTopFunction(writingSrc, 'function viewOptionsFor(fmt, doc) {');
const appTabViewBody = sliceTopFunction(appActionSrc, 'function appTabViewOf(doc) {');
const viewDocBody = sliceTopFunction(bridgeSrc, 'function openVirtualDoc(name, content, opts) {');

const markers = TAB_KINDS.map((s) => s.marker).sort();
const kinds = TAB_KINDS.map((s) => s.kind).sort();

test('注册表标记位 ↔ 视图工厂分派表一致', () => {
    // 分派表的键是 kind（可能带引号，如 'agent'）
    const dispatched = [...viewDispatchBody.matchAll(/^\s{4}'?([A-Za-z]+)'?\s*:/gm)].map((m) => m[1]).sort();
    assert.deepEqual(dispatched, kinds,
        '两边不一致：漏分派 → 标签打开是空白；多分派 → 死代码');
});

test('createDocEditor 经 tabKindOf 走注册表，不再手写标记位 if 链', () => {
    assert.match(createEditorBody, /tabKindOf\(doc\)/, 'createDocEditor 应经 tabKindOf 判定类型');
    assert.match(createEditorBody, /if \(doc\.pane\) return;/, '虚拟标签页必须用 doc.pane 兜住重复建面板');
    const hardcoded = markers.filter((m) => new RegExp('if \\(doc\\.' + m + '\\)').test(createEditorBody));
    assert.deepEqual(hardcoded, [], '这些标记位还在 createDocEditor 里手写 if 链（应改为注册表分派）');
});

test('viewOptionsFor 用 suppressesViewOptions 判定，不手写标记位清单', () => {
    assert.match(viewOptionsBody, /suppressesViewOptions\(doc\)/, 'viewOptionsFor 应经 suppressesViewOptions 判定');
    const hardcoded = markers.filter((m) => new RegExp('doc\\.' + m + '\\b').test(viewOptionsBody));
    assert.deepEqual(hardcoded, [],
        '这些标记位还在 viewOptionsFor 里手写：漏一个 → 虚拟标签页出现文件视图下拉');
});

test('虚拟标签页卸载走统一契约 doc.tabUnmount', () => {
    assert.match(closeDocBody, /if \(doc\.tabUnmount\)/, 'closeDocNow 应调用统一的 doc.tabUnmount');
    // 各域建视图时必须挂上清理函数（浏览器例外：走 BrowserClose 释放 WebView2 实例）
    const owners = [
        'bridge-terminal-view.js', 'bridge-agent-view.js', 'bridge-team-view.js',
        'bridge-sidechat-view.js', 'bridge-group-member-view.js', 'bridge-memo-view.js',
        'bridge-database-view.js',
    ];
    const missing = owners.filter((file) => !/doc\.tabUnmount\s*=/.test(read('bridge/' + file)));
    assert.deepEqual(missing, [], '这些域没挂 doc.tabUnmount：关标签后订阅 / 监听 / DOM 会泄漏');
    // 浏览器单独走 Go 侧释放
    assert.match(closeDocBody, /BrowserClose/, '浏览器标签页要靠 BrowserClose 释放 WebView2 实例');
});

test('每个虚拟文档都有创建点，且经 doc 工厂成对传 marker + key', () => {
    // 只传 marker 不传 key → doc.<marker> === undefined → 去重判断恒假，每次点开都新建一个标签。
    // 同时这条也覆盖「创建点存在」：marker 只出现在工厂参数里，不再散落成对象键。
    for (const marker of markers) {
        const use = new RegExp('marker:\\s*[\'"]' + marker + '[\'"]\\s*,\\s*key\\b', 'm');
        assert.match(bridgeSrc, use,
            marker + ' 的创建点缺失，或没有成对传 marker + key（见 core/virtual-tab-doc.js 注释）');
    }
});

test('每个虚拟文档的图标名都在 core/icons.js 注册过', () => {
    const missing = TAB_KINDS.filter((spec) => !ICONS[spec.icon]).map((spec) => spec.marker + ' → ' + spec.icon);
    assert.deepEqual(missing, [], '图标名没注册：iconSvg 会静默返回空串，标签上什么都不显示');
});

test('标签图标走注册表查询，不再手写标记位三元链', () => {
    assert.match(buildTabBody, /tabIconName\(doc\)/, 'buildGroupTab 应经 tabIconName 取图标名');
    // 只看图标赋值那一行：buildGroupTab 里还有 doc.agentView 的层级标记（↳）等合法用法
    const iconLine = /const icon = [^\n]*/.exec(buildTabBody);
    assert.ok(iconLine, 'buildGroupTab 里找不到 `const icon = …`（结构变了就更新本守卫）');
    const hardcoded = markers.filter((m) => new RegExp('doc\\.' + m + '\\b').test(iconLine[0]));
    assert.deepEqual(hardcoded, [],
        '这些标记位还在图标链里手写：漏一个 → 该标签显示成普通文本图标');
    assert.match(iconLine[0], /createFileIcon\(/, '缺文件图标回落：文件标签页会没有图标');
});

test('appTabViewOf 经 tabKindOf 描述视图型虚拟标签页', () => {
    assert.match(appTabViewBody, /tabKindOf\(doc\)/, 'appTabViewOf 应经 tabKindOf 取 kind / label');
    const hardcoded = markers.filter((m) => new RegExp('doc\\.' + m + '\\b').test(appTabViewBody));
    assert.deepEqual(hardcoded, [], '这些标记位还在 appTabViewOf 里手写 if 链');
});

test('appTabViewOf 的数据库 desc：Redis 键带连接/库，控制台不重复连接名', () => {
    assert.match(appTabViewBody, /doc\.dbRedisKeySpec/,
        'Redis 键标签页缺 desc 分支：AI 只看到键名，不知道它连的是哪个连接哪个库');
    const from = appTabViewBody.indexOf('if (doc.dbConsoleSpec)');
    const to = appTabViewBody.indexOf('if (doc.dbRedisKeySpec)');
    assert.ok(from >= 0 && to > from, 'appTabViewOf 的 dbConsoleSpec 分支结构变了就更新本守卫');
    // 控制台的 name 已是连接名：desc 再写「连接「…」」会注入成 查询控制台「x」（连接「x」…）
    assert.doesNotMatch(appTabViewBody.slice(from, to), /连接「/,
        '控制台 desc 不得重复连接名（name 里已经有了）');
});

// ---- 文本型虚拟文档（openVirtualDoc）：复用通用编辑器，没有 createDocEditor 分支 ----

test('openVirtualDoc 产出的文档仍是「无路径」文档', () => {
    assert.match(viewDocBody, /path:\s*null/, 'openVirtualDoc 必须保持 path: null（有 path 会被当成磁盘文件参与保存 / 重载）');
    assert.match(viewDocBody, /doc\.viewKind\s*=/, '缺少 viewKind：AI 的 workspace_context 会把这类视图当成「未保存的新文档」');
});

test('每个 viewKind 都能在 APP_TAB_KIND_LABELS 里找到标签', () => {
    const labels = sliceObjectLiteral(appActionSrc, 'const APP_TAB_KIND_LABELS = {');
    // 键的缩进不必固定：main.js 里是 4 空格，模块里（factory 内）是 8 空格
    const known = new Set([...labels.matchAll(/^[ \t]+([A-Za-z]+)\s*:/gm)].map((m) => m[1]));
    // viewKind 的取值来源：显式传 `viewKind: '...'` 与 openVirtualDoc 的兜底值
    const used = new Set([...srcAll.matchAll(/viewKind:\s*'([A-Za-z]+)'/g)].map((m) => m[1]));
    const fallback = /viewKind = options\.viewKind \|\| '([A-Za-z]+)'/.exec(bridgeSrc);
    if (fallback) used.add(fallback[1]);
    const missing = [...used].filter((k) => !known.has(k)).sort();
    assert.deepEqual(missing, [],
        '这些 viewKind 没有对应标签：AI 的 workspace_context 会退化成「标签页」，用户看到没头没尾的描述');
});

test('文本型虚拟文档不屏蔽文件视图下拉（计划 / 差异该有预览选项）', () => {
    // viewOptionsFor 经 suppressesViewOptions，只屏蔽视图型；这条钉住语义边界本身
    assert.doesNotMatch(viewOptionsBody, /viewKind/,
        'viewKind 不该进 viewOptionsFor 的屏蔽条件：.md 计划文档需要预览视图');
});
