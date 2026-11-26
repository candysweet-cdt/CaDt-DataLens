// editor-groups.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// 编辑器分栏（编辑器组 + 二叉分割树，VS Code 式）
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import DOMPurify from 'dompurify';
import {iconSvg} from '../core/icons.js';
import {isDocReadOnly, isTabReadOnlyFixed, isTabReadOnlyLocked} from '../core/readonly.js';
import {isBlankDraftText} from '../core/scratch.js';
import {createEditorAceHooks} from './editor-ace-hooks.js';
import {createEditorSmoothScroll} from './editor-smooth-scroll.js';
import {createEditorCsvView} from './editor-csv-view.js';
import {createEditorSplitPreview} from './editor-split-preview.js';
import {createEditorBrowserTab} from './editor-browser-tab.js';
import {createEditorSqlView} from './editor-sql-view.js';
import {createEditorDocExtras} from './editor-doc-extras.js';
import {createEditorExportMenus} from './editor-export-menus.js';
import {createEditorPluginView} from './editor-plugin-view.js';
import {isPluginViewMode, pluginViewLabel, pluginViewUnavailable, viewerIdFromMode} from '../shell/plugin-viewers.js';
import {createFileIcon, fileIconSpec} from '../core/fileicons.js';
import {formats, detectFormat, defaultMediaMode, isKnownCodeFileName} from '../core/formats.js';
import {tabKindOf, tabIconName} from '../core/tab-kinds.js';
import {showPatchView, disposePatchView} from './patch-view.js';
import {legacyPathKey} from '../core/path-key.js';

export function createEditorGroups(deps) {

// 失败 / 后台事件通知（消息中心 + toast + 节流）：文件被外部改动未重载等
const notifyFailure = (...args) => (typeof deps.notifyFailure === 'function' ? deps.notifyFailure(...args) : undefined);

let editorGroups = [];
let splitRoot = null;
let focusedGroupId = null;
let groupSeq = 0;
let dragTabId = null;
let dragTabGroupId = null;
let dropZone = null;
// 标签组内拖动排序的待提交意图：dragover 时记下「插到哪个标签前/后」，drop 时消费。
// 必须独立于落点元素保存——让位动画（.drop-gap 的 margin）会把目标标签从鼠标底下
// 推开，drop 因此落在让位出来的 .etabs 空白区而非标签上；若只信落点元素就换不了序。
let pendingTabDrop = null; // {gid, targetId, before}

function clearTabDropGaps(strip) {
    const root = strip || document;
    root.querySelectorAll('.tab.drop-gap-before, .tab.drop-gap-after').forEach((t) => {
        t.classList.remove('drop-gap-before', 'drop-gap-after');
    });
}

// 提交组内排序：drop 落在标签或标签条空白区都走这里，消费同一份意图。
function commitTabDrop(gid) {
    const pending = pendingTabDrop;
    pendingTabDrop = null;
    const srcId = dragTabId;
    dragTabId = null;
    dragTabGroupId = null;
    clearTabDropGaps();
    if (!pending || pending.gid !== gid || !srcId || pending.targetId === srcId) return;
    moveTabInGroup(gid, srcId, pending.targetId, pending.before);
}
const SPLIT_MAX_DEPTH = 3;
const SPLIT_MIN_W = 240;
const SPLIT_MIN_H = 180;

// ---- 滚轮平滑滚动域（editor-smooth-scroll.js）：覆盖 Ace 离散跳行的 mousewheel 处理器 ----
const smoothDeps = Object.create(deps);
smoothDeps.getSettings = () => deps.settings;
smoothDeps.getDocs = () => deps.docs;
const smoothScroll = createEditorSmoothScroll(smoothDeps);
const hookAceSmoothScroll = (...a) => smoothScroll.hookAce(...a);
const unhookAceSmoothScroll = (...a) => smoothScroll.unhookAce(...a);

// ---- Ace 会话钩子域：applyAceMode / 折叠范围 / 多光标 / python token（editor-ace-hooks.js） ----
// 派生 deps 注入平滑滚动转发箭头（延迟求值）：applyAceMode 在 setMode 换 session 后要重挂滚轮。
const aceDeps = Object.create(deps);
aceDeps.hookAceSmoothScroll = (...a) => hookAceSmoothScroll(...a);
const aceHooks = createEditorAceHooks(aceDeps);
const applyAceMode = (...a) => aceHooks.applyAceMode(...a);
const hookCodeFoldRanges = (...a) => aceHooks.hookCodeFoldRanges(...a);
const hookMultiCursor = (...a) => aceHooks.hookMultiCursor(...a);
const initCodeFoldHover = (...a) => aceHooks.initCodeFoldHover(...a);

// ---- CSV/TSV 表格视图域（editor-csv-view.js） ----
const csvDeps = Object.create(deps);
csvDeps.markDocDirty = (...a) => markDocDirty(...a);
csvDeps.updateStatus = (...a) => updateStatus(...a);
const csvView = createEditorCsvView(csvDeps);
const createCsvTableView = (...a) => csvView.createCsvTableView(...a);
const renderCsvTableView = (...a) => csvView.renderCsvTableView(...a);
const tableHistory = (...a) => csvView.tableHistory(...a);
const showCsvTableView = (...a) => csvView.showCsvTableView(...a);
const flushCsvCellEditor = (...a) => csvView.flushCsvCellEditor(...a);
const applyCsvTableZoom = (...a) => csvView.applyCsvTableZoom(...a);
const zoomCsvTable = (...a) => csvView.zoomCsvTable(...a);
const enterCsvTable = (...a) => csvView.enterCsvTable(...a);
const leaveCsvTable = (...a) => csvView.leaveCsvTable(...a);

// ---- 分屏与预览视图域（editor-split-preview.js） ----
const spDeps = Object.create(deps);
spDeps.applyAceMode = (...a) => applyAceMode(...a);
spDeps.updateStatus = (...a) => updateStatus(...a);
spDeps.showBanner = (...a) => showBanner(...a);
spDeps.syncTabViewTools = (...a) => syncTabViewTools(...a);
spDeps.patchMarkdownPreview = (...a) => exportMenus.patchMarkdownPreview(...a);
spDeps.renderMarkdownBlocksHtml = (...a) => exportMenus.renderMarkdownBlocksHtml(...a);
const splitPreview = createEditorSplitPreview(spDeps);
const createMarkdownPreview = (...a) => splitPreview.createMarkdownPreview(...a);
const renderMarkdownPreview = (...a) => splitPreview.renderMarkdownPreview(...a);
const restorePreviewScroll = (...a) => splitPreview.restorePreviewScroll(...a);
const capturePreviewScroll = (...a) => splitPreview.capturePreviewScroll(...a);
const showMarkdownPreview = (...a) => splitPreview.showMarkdownPreview(...a);
const enterMarkdownPreview = (...a) => splitPreview.enterMarkdownPreview(...a);
const leaveMarkdownPreview = (...a) => splitPreview.leaveMarkdownPreview(...a);
const showHtmlPreview = (...a) => splitPreview.showHtmlPreview(...a);
const hideHtmlPreview = (...a) => splitPreview.hideHtmlPreview(...a);
const enterHtmlPreview = (...a) => splitPreview.enterHtmlPreview(...a);
const leaveHtmlPreview = (...a) => splitPreview.leaveHtmlPreview(...a);
const releaseHtmlPreview = (...a) => splitPreview.releaseHtmlPreview(...a);
const mdSyncScrollFromAce = (...a) => splitPreview.mdSyncScrollFromAce(...a);
const scheduleSplitPreview = (...a) => splitPreview.scheduleSplitPreview(...a);
const enterSplitView = (...a) => splitPreview.enterSplitView(...a);
const exitSplitView = (...a) => splitPreview.exitSplitView(...a);
const createImageView = (...a) => splitPreview.createImageView(...a);
const showImageView = (...a) => splitPreview.showImageView(...a);
const enterImageView = (...a) => splitPreview.enterImageView(...a);
const createVideoView = (...a) => splitPreview.createVideoView(...a);
const showVideoView = (...a) => splitPreview.showVideoView(...a);
const hideVideoView = (...a) => splitPreview.hideVideoView(...a);
const enterVideoView = (...a) => splitPreview.enterVideoView(...a);
const pauseVideoInDoc = (...a) => splitPreview.pauseVideoInDoc(...a);
const releaseVideo = (...a) => splitPreview.releaseVideo(...a);
const createAudioView = (...a) => splitPreview.createAudioView(...a);
const showAudioView = (...a) => splitPreview.showAudioView(...a);
const hideAudioView = (...a) => splitPreview.hideAudioView(...a);
const enterAudioView = (...a) => splitPreview.enterAudioView(...a);
const pauseAudioInDoc = (...a) => splitPreview.pauseAudioInDoc(...a);
const releaseAudio = (...a) => splitPreview.releaseAudio(...a);
const applyImageZoom = (...a) => splitPreview.applyImageZoom(...a);
const zoomImageBy = (...a) => splitPreview.zoomImageBy(...a);
const enterSvgRender = (...a) => splitPreview.enterSvgRender(...a);
const hideSvgRender = (...a) => splitPreview.hideSvgRender(...a);
const zoomSvgRenderBy = (...a) => splitPreview.zoomSvgRenderBy(...a);
const enterBinaryView = (...a) => splitPreview.enterBinaryView(...a);
const enterTextView = (...a) => splitPreview.enterTextView(...a);

// ---- 插件自定义视图域（editor-plugin-view.js） ----
// 覆盖层形态：底层编辑器照常持有内容，切走 destroy、切回重新 mount。
const pvDeps = Object.create(deps);
pvDeps.hideImageView = (...a) => splitPreview.hideImageView(...a);
pvDeps.hideVideoView = (...a) => splitPreview.hideVideoView(...a);
pvDeps.hideAudioView = (...a) => splitPreview.hideAudioView(...a);
pvDeps.applyAceMode = (...a) => applyAceMode(...a);
pvDeps.showBanner = (...a) => showBanner(...a);
pvDeps.updateStatus = (...a) => updateStatus(...a);
pvDeps.markDocDirty = (...a) => markDocDirty(...a);
const pluginView = createEditorPluginView(pvDeps);
const enterPluginView = (...a) => pluginView.enterPluginView(...a);
const showPluginView = (...a) => pluginView.showPluginView(...a);
const hidePluginView = (...a) => pluginView.hidePluginView(...a);
const disposePluginView = (...a) => pluginView.disposePluginView(...a);

// ---- 浏览器标签域（editor-browser-tab.js） ----
const browserTabDeps = Object.create(deps);
browserTabDeps.renderTabs = (...a) => renderTabs(...a);
browserTabDeps.setFilename = (...a) => setFilename(...a);
const browserTab = createEditorBrowserTab(browserTabDeps);
const createBrowserView = (...a) => browserTab.createBrowserView(...a);
const syncBrowserTab = (...a) => browserTab.syncBrowserTab(...a);
const syncAllBrowserTabs = (...a) => browserTab.syncAllBrowserTabs(...a);

// 虚拟标签页类型 → 视图工厂（键是 core/tab-kinds.js 的 kind）。
// 工厂本体留在各域（binary 在 bridge、浏览器在 editor-browser-tab），本表只做分派；
// 用箭头函数而不是直接引用，保持 deps 的 getter 惰性（域实例在本模块之后才创建）。
const VIRTUAL_TAB_VIEWS = {
    browser: (doc) => createBrowserView(doc),
    memo: (doc) => deps.createMemoView(doc),
    terminal: (doc) => deps.createBgTermView(doc),
    'agent': (doc) => deps.createAgentView(doc),
    team: (doc) => deps.createAgentTeamView(doc),
    sidechat: (doc) => deps.createSideChatView(doc),
    groupmember: (doc) => deps.createGroupMemberView(doc),
    // 应用页面（使用统计 / 定时任务 …）：一个类型装 N 个功能页，按 doc.appPage 分派在工厂内部
    apppage: (doc) => deps.createAppPageView(doc),
    // 数据库（侧栏会话树打开，方案 §11.8）：数据表 / 查询控制台 / Redis 键查看器三个标签类型，
    // 分派都在 main.js 注入的同一工厂内部（按 doc.dbTableSpec / doc.dbConsoleSpec / doc.dbRedisKeySpec）
    dbTable: (doc) => deps.createDbTabView(doc),
    dbConsole: (doc) => deps.createDbTabView(doc),
    dbRedisKey: (doc) => deps.createDbTabView(doc),
};
const updateBrowserTitle = (...a) => browserTab.updateBrowserTitle(...a);
const setBrowserViewport = (...a) => browserTab.setBrowserViewport(...a);
const browserViewportLabel = (...a) => browserTab.browserViewportLabel(...a);

// ---- SQL 查询视图域（editor-sql-view.js） ----
const sqlDeps = Object.create(deps);
sqlDeps.updateStatus = (...a) => updateStatus(...a);
sqlDeps.exitSplitView = (...a) => exitSplitView(...a);
const sqlView = createEditorSqlView(sqlDeps);
const disposeSqlDoc = (...a) => sqlView.disposeSqlDoc(...a);
const closeSqlView = (...a) => sqlView.closeSqlView(...a);
const enterSqlView = (...a) => sqlView.enterSqlView(...a);

// ---- 文档周边杂项域（editor-doc-extras.js） ----
const extrasDeps = Object.create(deps);
extrasDeps.groupDocs = (...a) => groupDocs(...a);
extrasDeps.groupOfDoc = (...a) => groupOfDoc(...a);
extrasDeps.updateStatus = (...a) => updateStatus(...a);
extrasDeps.closeDocsWithConfirm = (...a) => closeDocsWithConfirm(...a);
extrasDeps.requestCloseDoc = (...a) => requestCloseDoc(...a);
extrasDeps.showPathInFolder = (...a) => showPathInFolder(...a);
extrasDeps.reopenClosedTab = (...a) => reopenClosedTab(...a);
extrasDeps.renderMarkdownPreview = (...a) => renderMarkdownPreview(...a);
extrasDeps.syncTabViewTools = (...a) => syncTabViewTools(...a);
const docExtras = createEditorDocExtras(extrasDeps);
const hideBanner = (...a) => docExtras.hideBanner(...a);
const dismissBanner = (...a) => docExtras.dismissBanner(...a);
const showBanner = (...a) => docExtras.showBanner(...a);
const humanizeCounts = (...a) => docExtras.humanizeCounts(...a);
const renderBookmarks = (...a) => docExtras.renderBookmarks(...a);
const toggleBookmark = (...a) => docExtras.toggleBookmark(...a);
const jumpBookmark = (...a) => docExtras.jumpBookmark(...a);
const addBookmarkAt = (...a) => docExtras.addBookmarkAt(...a);
const removeBookmarkAt = (...a) => docExtras.removeBookmarkAt(...a);
const clearDocBookmarks = (...a) => docExtras.clearDocBookmarks(...a);
const applyPendingDocView = (...a) => docExtras.applyPendingDocView(...a);
const rememberDocView = (...a) => docExtras.rememberDocView(...a);
const scheduleGitGutter = (...a) => docExtras.scheduleGitGutter(...a);
const expandAllWithGuard = (...a) => docExtras.expandAllWithGuard(...a);
const setupTreeContextMenu = (...a) => docExtras.setupTreeContextMenu(...a);

// ---- Markdown 块渲染与导出菜单域（editor-export-menus.js） ----
const menusDeps = Object.create(deps);
menusDeps.renderMarkdownPreview = (...a) => renderMarkdownPreview(...a);
menusDeps.updateStatus = (...a) => updateStatus(...a);
menusDeps.closeDocsWithConfirm = (...a) => closeDocsWithConfirm(...a);
menusDeps.requestCloseDoc = (...a) => requestCloseDoc(...a);
menusDeps.showPathInFolder = (...a) => showPathInFolder(...a);
menusDeps.openWithDefaultApp = (...a) => openWithDefaultApp(...a);
menusDeps.reopenClosedTab = (...a) => reopenClosedTab(...a);
menusDeps.groupDocs = (...a) => groupDocs(...a);
menusDeps.groupOfDoc = (...a) => groupOfDoc(...a);
const exportMenus = createEditorExportMenus(menusDeps);
const showSvgMenu = (...a) => exportMenus.showSvgMenu(...a);
const showImageMenu = (...a) => exportMenus.showImageMenu(...a);
const showMdPreviewMenu = (...a) => exportMenus.showMdPreviewMenu(...a);
const showTabMenu = (...a) => exportMenus.showTabMenu(...a);

function nextGroupId() { return 'g' + (++groupSeq); }
function groupById(gid) { return editorGroups.find((g) => g.id === gid) || null; }
function groupOfDoc(docId) { return editorGroups.find((g) => g.docIds.includes(docId)) || null; }
function groupDocs(g) { return (g ? g.docIds.map((id) => deps.docs.find((d) => d.id === id)).filter(Boolean) : []); }
function focusedGroup() { return groupById(focusedGroupId) || editorGroups[0] || null; }
function createGroup(docIds) {
    const g = { id: nextGroupId(), docIds: docIds || [], activeId: (docIds && docIds.length ? docIds[0] : null) };
    editorGroups.push(g);
    if (!focusedGroupId) focusedGroupId = g.id;
    return g;
}
// 新开文件归入当前聚焦组（多开时只 activate 最后一个，其余仍需可见）
function addDocToFocusedGroup(doc) {
    if (!doc) return null;
    const g = focusedGroup() || createGroup();
    if (!g.docIds.includes(doc.id)) g.docIds.push(doc.id);
    return g;
}
function leafDepth(node, gid, d) {
    if (!node) return -1;
    if (typeof node === 'string') return node === gid ? d : -1;
    const a = leafDepth(node.a, gid, d + 1);
    if (a >= 0) return a;
    return leafDepth(node.b, gid, d + 1);
}
function groupDepth(gid) { return splitRoot ? leafDepth(splitRoot, gid, 0) : 0; }
function splitReplaceLeaf(node, gid, dir, side, newGid) {
    const mkSplit = (existing) => ({ dir, ratio: 0.5, a: side === 'before' ? newGid : existing, b: side === 'before' ? existing : newGid });
    if (!node) return mkSplit(gid);
    if (typeof node === 'string') return node === gid ? mkSplit(node) : node;
    if (node.a === gid) return { dir: node.dir, ratio: node.ratio, a: mkSplit(gid), b: node.b };
    if (node.b === gid) return { dir: node.dir, ratio: node.ratio, a: node.a, b: mkSplit(gid) };
    return { dir: node.dir, ratio: node.ratio, a: splitReplaceLeaf(node.a, gid, dir, side, newGid), b: splitReplaceLeaf(node.b, gid, dir, side, newGid) };
}
function collapseTree(node) {
    if (typeof node === 'string') return groupById(node) ? node : null;
    const a = collapseTree(node.a);
    const b = collapseTree(node.b);
    if (a === null) return b;
    if (b === null) return a;
    return { dir: node.dir, ratio: node.ratio, a, b };
}
function removeGroupIfEmpty(gid) {
    if (!gid) return;
    const idx = editorGroups.findIndex((g) => g.id === gid);
    if (idx < 0) return;
    if (editorGroups[idx].docIds.length) return;
    editorGroups.splice(idx, 1);
    if (splitRoot) splitRoot = collapseTree(splitRoot);
    if (focusedGroupId === gid || !groupById(focusedGroupId)) {
        const fg = focusedGroup();
        focusedGroupId = fg ? fg.id : null;
    }
}
function moveTabInGroup(gid, srcId, targetId, before) {
    const g = groupById(gid);
    if (!g) return;
    const si = g.docIds.indexOf(srcId);
    const ti = g.docIds.indexOf(targetId);
    if (si < 0 || ti < 0 || srcId === targetId) return;
    g.docIds.splice(si, 1);
    const idx = g.docIds.indexOf(targetId);
    g.docIds.splice(before ? idx : idx + 1, 0, srcId);
    renderTabs();
}

// ---- app_control 分组动作（完整分组操作）：返回 {ok, ...} 或 {ok:false, error} ----

function docInfoOf(docId) {
    const d = deps.docs.find((item) => item && item.id === docId);
    return d ? {id: d.id, name: d.name || '', path: d.path || ''} : null;
}

function groupSnapshot() {
    const focused = focusedGroup();
    const focusedId = focused ? focused.id : '';
    return editorGroups.map((g, index) => ({
        index,
        id: g.id,
        focused: g.id === focusedId,
        active: (docInfoOf(g.activeId) || {}).name || '',
        docs: g.docIds.map(docInfoOf).filter(Boolean),
    }));
}

function resolveGroupRef(ref) {
    if (typeof ref === 'number' || (typeof ref === 'string' && /^\d+$/.test(ref.trim()))) {
        const index = Number(ref);
        const group = editorGroups[index];
        return group ? {group, index} : null;
    }
    const id = String(ref == null ? '' : ref).trim();
    const index = editorGroups.findIndex((g) => g.id === id);
    return index >= 0 ? {group: editorGroups[index], index} : null;
}

function focusEditorGroup(ref) {
    const hit = resolveGroupRef(ref);
    if (!hit) return {ok: false, error: '找不到编辑器分组：' + String(ref)};
    focusGroupById(hit.group.id);
    return {ok: true, index: hit.index, id: hit.group.id};
}

function moveDocToGroup(docId, ref) {
    const doc = deps.docs.find((item) => item && item.id === docId);
    if (!doc) return {ok: false, error: '找不到标签：' + String(docId)};
    const hit = resolveGroupRef(ref);
    if (!hit) return {ok: false, error: '找不到编辑器分组：' + String(ref)};
    const src = groupOfDoc(doc.id);
    if (!src) return {ok: false, error: '标签不在任何编辑器分组'};
    if (src.id === hit.group.id) return {ok: false, error: '标签已在该分组'};
    src.docIds = src.docIds.filter((id) => id !== doc.id);
    if (src.activeId === doc.id) src.activeId = src.docIds[0] || null;
    removeGroupIfEmpty(src.id);
    hit.group.docIds.push(doc.id);
    hit.group.activeId = doc.id;
    focusedGroupId = hit.group.id;
    renderTabs();
    activateDoc(doc);
    return {ok: true, group: {index: hit.index, id: hit.group.id}};
}

// 把标签拆到同组旁边的新分组（与拖拽到边缘同一条 performDrop 通路）。
function splitDocToGroup(docId, zone) {
    const side = ['left', 'right', 'top', 'bottom'].includes(zone) ? zone : 'right';
    const src = groupOfDoc(docId);
    if (!src) return {ok: false, error: '找不到标签所在的编辑器分组'};
    if (src.docIds.length <= 1) {
        return {ok: false, error: '该分组只有这一个标签：拆分会留下空分组；请先在同一分组保留另一个标签，或用 split_open 并排打开两个文件'};
    }
    performDrop({gid: src.id, zone: side}, docId);
    const group = groupOfDoc(docId);
    return {
        ok: !!(group && editorGroups.length > 1),
        group: group ? {id: group.id, index: editorGroups.findIndex((item) => item.id === group.id)} : null,
        side,
    };
}

function mergeEditorGroup(ref, intoRef) {
    const hit = resolveGroupRef(ref == null ? focusedGroupId : ref);
    if (!hit) return {ok: false, error: '找不到要解散的分组：' + String(ref)};
    const src = hit.group;
    let target = null;
    if (intoRef != null && intoRef !== '') {
        const into = resolveGroupRef(intoRef);
        if (!into) return {ok: false, error: '找不到目标分组：' + String(intoRef)};
        target = into.group;
    } else {
        target = editorGroups.find((g) => g.id !== src.id) || null;
    }
    if (!target) return {ok: false, error: '至少要保留一个编辑器分组'};
    if (target.id === src.id) return {ok: false, error: '源分组与目标分组相同'};
    for (const id of src.docIds) {
        if (!target.docIds.includes(id)) target.docIds.push(id);
    }
    if (!target.activeId || !target.docIds.includes(target.activeId)) {
        target.activeId = (src.activeId && target.docIds.includes(src.activeId)) ? src.activeId : (target.docIds[0] || null);
    }
    src.docIds = [];
    src.activeId = null;
    focusedGroupId = target.id;
    removeGroupIfEmpty(src.id);
    renderTabs();
    const activeDoc = deps.docs.find((d) => d.id === target.activeId);
    if (activeDoc) activateDoc(activeDoc);
    return {ok: true, group: {id: target.id, index: editorGroups.findIndex((g) => g.id === target.id)}};
}

function renderTabs() { renderEditorLayout(); }

function renderEditorLayout() {
    deps.syncRunButtonState();
    // 提示条先移出布局区，避免被整体清空
    if (deps.els.banner && deps.els.banner.parentElement === deps.els.editor) deps.els.editorArea.appendChild(deps.els.banner);
    // 整段重建会把标签条横向滚动位置清零，先按组记下来，重建完原样恢复。
    // 否则任何后台重绘（外部修改标记 / AI 写已打开的文件 / 保存脏标）都会把用户
    // 手动滚到一半的标签条弹回激活标签的定位点，标签多时表现为「怎么都滚不到末尾」。
    const prevStripScroll = new Map();
    for (const stripEl of deps.els.editor.querySelectorAll('.egroup[data-gid] > .etabs')) {
        prevStripScroll.set(stripEl.parentElement.dataset.gid, stripEl.scrollLeft);
    }
    // 记录焦点：整段 textContent='' 再插回会把子树内的焦点丢掉（Ace 的隐藏 textarea 失焦），
    // 自动保存等后台重绘会打断用户打字。重建后若焦点所属 pane 仍是激活则恢复（见函数末尾）。
    const prevActive = document.activeElement;
    const prevActivePane = prevActive && prevActive.closest ? prevActive.closest('.jsoneditor-pane') : null;
    const hadFocusInEditor = !!(prevActive && deps.els.editor.contains(prevActive));
    // 预览滚动位置存进 doc：整段重建会把 pane 摘除插回、DOM scrollTop 归零。
    // 自动保存等后台重绘也会触发本函数，别让用户正在看的预览跳回顶部。
    // 只对活动 doc capture——非活动 doc 的 pane 隐藏，DOM scrollTop 已归零，读了会覆盖持久值。
    if (deps.file) capturePreviewScroll(deps.file);
    deps.els.editor.textContent = '';
    const root = splitRoot || (focusedGroupId || (editorGroups[0] && editorGroups[0].id));
    if (!root || !editorGroups.length) return;
    buildSplitNode(deps.els.editor, root);
    deps.scheduleSessionSave();
    for (const g of editorGroups) {
        const host = deps.els.editor.querySelector('.egroup[data-gid="' + g.id + '"] .ehost');
        if (!host) continue;
        const list = groupDocs(g);
        for (const d of list) {
            if (d.pane && d.pane.parentElement !== host) host.appendChild(d.pane);
        }
        const active = list.find((d) => d.id === g.activeId) || list[0];
        if (active) g.activeId = active.id;
        for (const d of list) {
            if (d.pane) d.pane.classList.toggle('active', d.id === g.activeId);
        }
    }
    // 提示条：放在聚焦分栏的标签条下方
    const fgWrap = deps.els.editor.querySelector('.egroup[data-gid="' + (focusedGroupId || (editorGroups[0] && editorGroups[0].id) || '') + '"]');
    if (fgWrap) {
        const fgHost = fgWrap.querySelector('.ehost');
        if (fgHost && deps.els.banner.parentElement !== fgWrap) fgWrap.insertBefore(deps.els.banner, fgHost);
    }
    // 全局 file 对齐聚焦组（直接更新 chrome，绝不递归回 renderTabs）
    if (!deps.file || !groupOfDoc(deps.file.id)) {
        const fg = focusedGroup();
        const fd = fg ? deps.docs.find((d) => d.id === fg.activeId) : null;
        if (fd) {
            deps.file = fd;
            deps.dirty = !!fd.dirty;
            // file 对齐到新活动 doc 时必须同步 currentMode，否则残留上一个 doc 的
            // 视图模式（browser doc 关闭后状态栏/工具条会卡在「网页视图」）
            deps.currentMode = deps.normalizeLegacySqlMode(fd);
        }
    }
    if (deps.file) {
        setFilename(deps.file.name, deps.file.path);
        renderBreadcrumb(deps.file.path);
        showBanner(deps.file, deps.file.parseError);
        deps.updateWindowTitle();
        updateStatus();
        deps.updateSearchState();
    }
    // 重建完成：先恢复各组标签条的横滚位置（超出新上限由浏览器自动收敛）；
    // 只有首次构建（此前不存在该组的标签条）才做激活标签定位——已有位置就尊重它，
    // 切换标签时的定位由 activateDoc 显式补发，别把用户手动滚出的位置拽回去。
    const freshGids = new Set();
    for (const wrap of deps.els.editor.querySelectorAll('.egroup[data-gid]')) {
        const stripEl = wrap.querySelector(':scope > .etabs');
        if (!stripEl) continue;
        const prev = prevStripScroll.get(wrap.dataset.gid);
        if (prev === undefined) freshGids.add(wrap.dataset.gid);
        else stripEl.scrollLeft = prev;
    }
    if (freshGids.size) scheduleRevealActiveTabs(freshGids);
    // 恢复焦点：重建前焦点在编辑器内、且所属 pane 重建后仍是激活文档时，把它还回去。
    // 自动保存 / 外部修改标记 / AI 写已打开文件等后台重绘不能打断用户打字；
    // 标签切换（activateDoc 移走旧 pane）不会命中，不会抢新标签的焦点。
    if (hadFocusInEditor && prevActivePane) {
        const activePane = deps.els.editor.querySelector('.jsoneditor-pane.active');
        if (activePane && activePane.contains(prevActivePane)) {
            // 按焦点 pane 反查文档，不依赖 deps.file 当前值（多分栏下焦点组可能不是 file 组）
            const doc = deps.docs.find((d) => d.pane === prevActivePane);
            const ed = doc && doc.editor;
            if (ed && ed.aceEditor) {
                try { ed.aceEditor.focus(); } catch (e) {}
            } else if (prevActive && prevActive.isConnected && typeof prevActive.focus === 'function') {
                try { prevActive.focus(); } catch (e) {}
            }
        }
    }
    // 预览滚动恢复：整段重建后 DOM scrollTop 已归零，用 doc 上存的值还回去。
    // 分屏时 restorePreviewScroll 走 mdSyncScrollFromAce（以 Ace 滚动为真源对齐）。
    if (deps.file) restorePreviewScroll(deps.file);
}

function buildSplitNode(parent, node) {
    if (typeof node === 'string') { buildGroup(parent, node); return; }
    const wrap = document.createElement('div');
    wrap.className = 'esplit esplit-' + node.dir;
    const a = document.createElement('div');
    a.className = 'esplit-child';
    a.style.flexBasis = (node.ratio * 100) + '%';
    buildSplitNode(a, node.a);
    const b = document.createElement('div');
    b.className = 'esplit-child';
    buildSplitNode(b, node.b);
    wrap.append(a, makeSplitDivider(node), b);
    parent.appendChild(wrap);
}

function makeSplitDivider(node) {
    const d = document.createElement('div');
    d.className = 'esplit-divider';
    d.addEventListener('mousedown', (e) => {
        const childA = d.previousElementSibling;
        const childB = d.nextElementSibling;
        if (!childA || !childB) return;
        const horiz = node.dir === 'col';
        const start = horiz ? e.clientX : e.clientY;
        const rectA = childA.getBoundingClientRect();
        const total = horiz ? (rectA.width + childB.getBoundingClientRect().width) : (rectA.height + childB.getBoundingClientRect().height);
        const startRatio = node.ratio;
        deps.setDragCursor(horiz ? 'ew' : 'ns');
        document.body.style.userSelect = 'none';
        const move = (ev) => {
            const delta = (horiz ? ev.clientX : ev.clientY) - start;
            node.ratio = Math.min(0.8, Math.max(0.2, startRatio + delta / total));
            childA.style.flexBasis = (node.ratio * 100) + '%';
        };
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            deps.setDragCursor(null);
            document.body.style.userSelect = '';
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        e.preventDefault();
    });
    return d;
}

function buildGroup(parent, gid) {
    const g = groupById(gid);
    const wrap = document.createElement('div');
    wrap.className = 'egroup';
    wrap.dataset.gid = gid;
    const strip = document.createElement('div');
    strip.className = 'etabs';
    // 组内拖动排序兜底：让位动画会把目标标签从鼠标底下滑开，drop 常落在让位出来的
    // .etabs 空白区。这里在标签条层 preventDefault 让 drop 生效，并提交 dragover 时
    // 已记录的意图（dragTabId 非空 = 本组标签在拖，避免接住外部文件拖放）。
    strip.addEventListener('dragover', (e) => {
        if (dragTabId === null || dragTabGroupId !== gid) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    });
    strip.addEventListener('drop', (e) => {
        if (dragTabId === null || dragTabGroupId !== gid) return;
        e.preventDefault();
        e.stopPropagation();
        commitTabDrop(gid);
    });
    const single = editorGroups.length === 1 && !splitRoot;
    const hide = !g || !g.docIds.length || (deps.settings.openMode === 'window' && g.docIds.length === 1 && single);
    if (hide) strip.classList.add('hidden');
    const host = document.createElement('div');
    host.className = 'ehost';
    if (g) for (const d of groupDocs(g)) strip.appendChild(buildGroupTab(g, d, strip));
    wrap.append(strip, host);
    wireHostDnd(host, gid);
    host.addEventListener('mousedown', () => {
        if (focusedGroupId !== gid) focusGroupById(gid);
    });
    parent.appendChild(wrap);
    // 标签条右侧工具区（视图切换 + 标签页操作），每个分栏组独立一份
    if (!hide) {
        const tools = buildGroupTools(gid);
        if (tools) {
            wrap.appendChild(tools);
            syncTabSpacer(wrap);
        }
    }
}

// 工具区（.tb-tools）是绝对定位覆盖层，盖在 .etabs 右端上：末尾 spacer 的宽度就是它占的
// 宽度——滚到最右时给激活标签留出这段，别让「视图切换/更多」把标签压住。
// 宽度只能现场量（offsetWidth），而编辑区收起时 #main-pane 是 display:none，量出来恒为 0：
// 收起态下打开文件（AI 面板点文件链接）会重建标签条，spacer 被记成 0，展开后末尾标签
// 被工具区盖住滚不出来。所以测量收敛到这里，展开瞬间由 refreshTabStripSpacers 重量
// （main.js setEditorCollapsed 的展开分支调用）。
function syncTabSpacer(wrap) {
    const tools = wrap.querySelector('.tb-tools');
    const strip = wrap.querySelector('.etabs');
    if (!tools || !strip) return false;
    let spacer = strip.querySelector(':scope > .tb-spacer');
    if (!spacer) {
        spacer = document.createElement('div');
        spacer.className = 'tb-spacer';
        strip.appendChild(spacer);
    }
    const width = tools.offsetWidth + 'px';
    if (spacer.style.width === width) return false;
    spacer.style.width = width;
    return true;
}

// 编辑区从收起态展开后调用：收起期间重建过的组 spacer 全是 0（工具区宽度量不到），
// 展开后逐组重量；只有 spacer 确实被修正的组才补发激活标签定位——收起期间打开的标签
// 当时 reveal 不了（scrollWidth 与 clientWidth 都是 0，revealActiveTabs 直接跳过），
// 展开后要把它滚出工具区的覆盖范围。纯开合循环（无重建）spacer 不变，不定位，
// 别把用户手动滚出的标签条位置拽回激活标签。
function refreshTabStripSpacers() {
    let changed = false;
    for (const wrap of deps.els.editor.querySelectorAll('.egroup[data-gid]')) {
        if (syncTabSpacer(wrap)) changed = true;
    }
    if (changed) scheduleRevealActiveTabs();
}

// 视图模式图标：局部键 → 注册表键（14 网格散落 SVG 已按 16 网格重画收编 core/icons.js，
// 尺寸由 .tb-view svg 的 CSS 规则统一 14px；sql/code/text/preview/image 与 database/code/
// doc/image 同形复用，不另立键）
const VIEW_ICONS = {
    tree: 'view-tree',
    table: 'view-table',
    sql: 'database',
    code: 'code',
    text: 'doc',
    preview: 'image',
    image: 'image',
    binary: 'view-binary',
    video: 'view-video',
    audio: 'view-audio',
    render: 'view-render',
    patch: 'view-patch',
    split: 'view-split',
};

function viewIconFor(mode) {
    const key = VIEW_ICONS[mode];
    if (key) return iconSvg(key, 14);
    // 插件视图没有内置图标表项：给一个「面板」形状的通用图标，别让按钮变成空白方块
    return isPluginViewMode(mode) ? iconSvg('view-panel', 14) : '';
}

function viewDisabledFor(doc, mode) {
    if (!doc) return true;
    // 插件视图：注册表缺失 / 二进制 / 大文件 / 归属不符，判定单一来源在 shell/plugin-viewers.js
    if (isPluginViewMode(mode)) return !!pluginViewUnavailable(doc, mode);
    if (mode === 'image') return !doc.image;
    if (mode === 'video') return !doc.video;
    if (mode === 'audio') return !doc.audio;
    if (mode === 'binary') return !doc.binary;
    if (mode === 'tree') return !doc.treeAvailable;
    if (mode === 'preview') {
        const previewable = !!(doc.format && doc.format.preview) || !!(deps.isHtmlDoc && deps.isHtmlDoc(doc));
        return !previewable || !!doc.large;
    }
    if (mode === 'table') return !(doc.format && doc.format.table);
    if (mode === 'render') return !deps.isSvgDoc(doc);
    if (mode === 'patch') return !(doc.format && doc.format.patch);
    return false;
}

function buildGroupTools(gid) {
    const g = groupById(gid);
    if (!g || !g.docIds.length) return null;
    const doc = deps.docs.find((d) => d.id === g.activeId) || groupDocs(g)[0];
    if (!doc) return null;
    const tools = document.createElement('div');
    tools.className = 'tb-tools';
    const activeMode = doc.splitActive ? 'split' : doc.mode;
    for (const [mode, label] of deps.viewOptionsFor(doc.format, doc)) {
        // 不可用的视图不显示（IDEA 只列可用视图），不摆灰态占位
        if (viewDisabledFor(doc, mode)) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        // SQL 是覆盖层：选中态独立于当前视图（开着才亮），底层视图按钮保持自己的选中态
        const on = mode === 'sql' ? !!doc.sqlActive : (activeMode === mode);
        btn.className = 'tb-view' + (on ? ' active' : '');
        btn.dataset.mode = mode;
        btn.dataset.tip = label;
        btn.innerHTML = viewIconFor(mode);
        btn.addEventListener('click', async () => {
            if (deps.file !== doc) await activateDoc(doc);
            if (mode === 'sql') {
                deps.switchMode('sql');
            } else if (doc.splitActive || deps.currentMode !== mode) {
                deps.switchMode(mode);
            }
            renderTabs();
        });
        tools.appendChild(btn);
    }
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'tb-more';
    more.dataset.tip = '标签页操作';
    more.innerHTML = iconSvg('more-vertical', 14);
    more.addEventListener('click', () => {
        const r = more.getBoundingClientRect();
        showTabbarToolsMenu(r.left, r.bottom + 4);
    });
    tools.appendChild(more);
    return tools;
}

// 视图切换不一定重建标签条（底部状态栏、设置默认视图、快捷菜单等入口只调 switchMode），
// 这里按各分栏组当前文档同步视图按钮的选中态。
function syncTabViewTools() {
    for (const wrap of document.querySelectorAll('.egroup[data-gid]')) {
        const g = groupById(wrap.dataset.gid);
        const doc = g ? (deps.docs.find((d) => d.id === g.activeId) || groupDocs(g)[0]) : null;
        const activeMode = doc ? (doc.splitActive ? 'split' : doc.mode) : '';
        for (const btn of wrap.querySelectorAll('.tb-view[data-mode]')) {
            const isSql = btn.dataset.mode === 'sql';
            btn.classList.toggle('active', isSql ? !!(doc && doc.sqlActive) : btn.dataset.mode === activeMode);
        }
    }
}

function showTabbarToolsMenu(x, y) {
    if (!deps.ctxMenu) return;
    const clean = deps.docs.filter((d) => !d.dirty);
    deps.ctxMenu.open([
        {label: '新建浏览器标签页', icon: 'search', action: () => deps.openBrowserTab('about:blank')},
        {label: '转到文件…', shortcut: 'Ctrl+Shift+N', icon: 'search', action: () => {}},
        {sep: true},
        {label: '关闭所有标签页', action: () => closeDocsWithConfirm(deps.docs.slice(), '关闭所有标签页将丢弃未保存的修改。')},
        {label: '关闭未修改标签页', disabled: !clean.length, action: () => closeDocsWithConfirm(clean)},
        {sep: true},
        {label: '配置编辑器标签页…', icon: 'gear', action: () => deps.openSettings('editor-tabs')},
    ], x, y);
}

function focusGroupById(gid) {
    focusedGroupId = gid;
    const g = groupById(gid);
    const d = g ? deps.docs.find((x) => x.id === g.activeId) : null;
    if (d && deps.file !== d) activateDoc(d);
}

// 视图型虚拟标签页的图标：图标名来自 core/tab-kinds.js 的注册表（单一来源），
// 这里只负责把名字变成 span。漏注册的图标名会得到空图标而不报错，
// 所以 virtual-doc-wiring.test.mjs 还额外核对「注册表里的 icon 都在 core/icons.js 注册过」。
function virtualTabIcon(name) {
    const span = document.createElement('span');
    span.className = 'tab-icon';
    span.innerHTML = iconSvg(name, 13);
    return span;
}

function tabTooltip(doc) {
    const lockTip = isTabReadOnlyFixed(doc) ? '\n（只读快照，不可解锁）'
        : isTabReadOnlyLocked(doc) ? '\n（本标签只读锁定，右键可解除）' : '';
    // 子代理详情：多行显示父级与任务摘要，让标签栏里看不出归属的纯文本在悬停时说清来路
    if (doc.agentView && doc.agentViewSpec) {
        const spec = doc.agentViewSpec;
        const bits = [doc.name];
        if (spec.parentLabel) bits.push('父：' + spec.parentLabel);
        // 层号 = depth+1（内部 depth 主代理为 0，人读层号以主代理为第 1 层，与 HUD/团队树一致）。
        // editor-groups 不 import ai 域（单向依赖），这里按同一口径就地算。
        if (spec.depth >= 1) bits.push('第 ' + (spec.depth + 1) + ' 层');
        // 运行态行（bridge 层经快照写入 spec.runtimeText）：轮次 · 耗时 · token · 状态
        if (spec.runtimeText) bits.push(spec.runtimeText);
        if (spec.task) bits.push(taskSnippetForTab(spec.task));
        return bits.join('\n') + lockTip;
    }
    return (doc.path || doc.name) + (doc.staleOnDisk ? '\n（已在外部修改）' : '') + lockTip;
}

// 标签 tooltip 里的任务摘要：单行、截断（与 AI 侧 taskSnippet 同口径，这里不引 AI 模块避免反向依赖）
function taskSnippetForTab(task) {
    const line = String(task || '').replace(/\s+/g, ' ').trim();
    if (!line) return '';
    return line.length > 90 ? line.slice(0, 90) + '…' : line;
}

function tabLockTitle(doc) {
    return isTabReadOnlyFixed(doc) ? '只读快照，不可解锁' : '本标签已只读锁定';
}

// 切换标签页只读锁后同步角标，不必重建整条标签栏。
function syncTabReadOnly(doc) {
    if (!doc) return;
    const tab = document.querySelector('.etabs .tab[data-doc-id="' + doc.id + '"]');
    if (!tab) return;
    const locked = isTabReadOnlyLocked(doc);
    tab.classList.toggle('tab-readonly', locked);
    tab.dataset.tip = tabTooltip(doc);
    const existing = tab.querySelector('.tab-lock');
    if (locked && !existing) {
        const lock = document.createElement('span');
        lock.className = 'tab-lock';
        lock.dataset.tip = tabLockTitle(doc);
        lock.innerHTML = iconSvg('lock', 12);
        const close = tab.querySelector('.tab-close');
        if (close) tab.insertBefore(lock, close);
        else tab.appendChild(lock);
    } else if (!locked && existing) {
        existing.remove();
    }
}

function buildGroupTab(g, doc, strip) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (doc.id === g.activeId ? ' active' : '') + (doc.dirty ? ' dirty' : '') + (doc.staleOnDisk ? ' stale' : '') + (isTabReadOnlyLocked(doc) ? ' tab-readonly' : '');
    tab.dataset.docId = String(doc.id);
    tab.dataset.tip = tabTooltip(doc);
    // 视图型虚拟标签页（浏览器 / 终端 / 子代理 …）用注册表指定的固定图标；
    // 其余（含计划 / 差异等无路径文本文档）走按扩展名解析的文件图标。
    const virtualIcon = tabIconName(doc);
    const icon = virtualIcon ? virtualTabIcon(virtualIcon) : createFileIcon(doc.name, 'tab-icon');
    const dot = document.createElement('span');
    dot.className = 'tab-dot';
    const name = document.createElement('span');
    name.className = 'tab-name';
    // 子代理详情：有父级（非主代理，depth>=1）名字前加层级记号，与 tooltip 的父级行同一口径
    if (doc.agentView && doc.agentViewSpec && doc.agentViewSpec.depth >= 1) {
        const nest = document.createElement('span');
        nest.className = 'tab-nest';
        nest.textContent = '↳';
        name.appendChild(nest);
    }
    name.appendChild(document.createTextNode(doc.name));
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.dataset.tip = '关闭';
    close.innerHTML = iconSvg('close', 12);
    close.addEventListener('click', (e) => {
        e.stopPropagation();
        requestCloseDoc(doc);
    });
    if (isTabReadOnlyLocked(doc)) {
        const lock = document.createElement('span');
        lock.className = 'tab-lock';
        lock.dataset.tip = tabLockTitle(doc);
        lock.innerHTML = iconSvg('lock', 12);
        tab.append(icon, dot, name, lock, close);
    } else {
        tab.append(icon, dot, name, close);
    }
    tab.addEventListener('click', (e) => {
        if (e.shiftKey && deps.settings.shiftClickClose !== false) {
            e.preventDefault();
            requestCloseDoc(doc);
            return;
        }
        activateDoc(doc);
    });
    tab.addEventListener('dblclick', () => {
        if (deps.settings.dblClickClose) requestCloseDoc(doc);
    });
    tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        activateDoc(doc);
        showTabMenu(doc, e.clientX, e.clientY);
    });
    tab.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
            e.preventDefault();
            requestCloseDoc(doc);
        }
    });
    // 拖动：组内排序 + 跨区拖出分栏
    tab.draggable = true;
    tab.addEventListener('dragstart', (e) => {
        dragTabId = doc.id;
        dragTabGroupId = g.id;
        pendingTabDrop = null;
        tab.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(doc.id)); } catch (err) {}
    });
    tab.addEventListener('dragend', () => {
        dragTabId = null;
        dragTabGroupId = null;
        pendingTabDrop = null;
        tab.classList.remove('dragging');
        clearTabDropGaps(strip);
        hideSplitMask();
        dropZone = null;
    });
    // dragover 只记录意图 + 画让位，不在这里决定排序：让位动画会把目标从鼠标底下滑走，
    // 真正落点可能是让位出来的空白区；排序统一在 drop（标签或标签条兜底）时提交。
    tab.addEventListener('dragover', (e) => {
        if (dragTabId === null || dragTabGroupId !== g.id || dragTabId === doc.id) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        const r = tab.getBoundingClientRect();
        const before = e.clientX < r.x + r.width / 2;
        pendingTabDrop = {gid: g.id, targetId: doc.id, before};
        clearTabDropGaps(strip);
        if (before) tab.classList.add('drop-gap-before');
        else {
            const next = tab.nextElementSibling;
            if (next && next.classList.contains('tab')) next.classList.add('drop-gap-before');
            else tab.classList.add('drop-gap-after');
        }
    });
    tab.addEventListener('drop', (e) => {
        if (dragTabId === null || dragTabGroupId !== g.id) return;
        e.preventDefault();
        e.stopPropagation();
        commitTabDrop(g.id);
    });
    return tab;
}

// 标签条横滚定位：把每个分栏组的激活标签滚进可视区。
// 不用 scrollIntoView —— 它会连带滚动祖先容器，且 inline:'nearest' 对「部分可见」的
// 标签不动作，导致激活标签经常停在可视区外。这里显式改 .etabs 自己的 scrollLeft。
let revealTabsRaf = 0;
let revealTabsFilter = null; // null = 全部组；Set(gid) = 只定位这些组（重建恢复过位置的组不再定位）
function scheduleRevealActiveTabs(gids = null) {
    if (revealTabsRaf) {
        // 同帧合并：无条件定位（null）吞掉组过滤；否则取并集
        if (revealTabsFilter) {
            if (!gids) revealTabsFilter = null;
            else for (const gid of gids) revealTabsFilter.add(gid);
        }
        return;
    }
    revealTabsFilter = gids ? new Set(gids) : null;
    revealTabsRaf = requestAnimationFrame(() => {
        revealTabsRaf = 0;
        const filter = revealTabsFilter;
        revealTabsFilter = null;
        revealActiveTabs(filter);
    });
}
function revealActiveTabs(gids = null) {
    for (const wrap of deps.els.editor.querySelectorAll('.egroup[data-gid]')) {
        if (gids && !gids.has(wrap.dataset.gid)) continue;
        const strip = wrap.querySelector('.etabs');
        if (!strip || strip.classList.contains('hidden') || strip.scrollWidth <= strip.clientWidth) continue;
        const tab = strip.querySelector('.tab.active[data-doc-id]');
        if (!tab) continue;
        // 右侧工具区是绝对定位覆盖在标签条上的；末尾 spacer 的宽度就是它占的宽度，
        // 滚到最右时给激活标签留出这段，别让「视图切换/更多」把标签压住。
        const spacer = strip.querySelector('.tb-spacer');
        const rightInset = spacer ? spacer.offsetWidth : 0;
        const pad = 8;
        const sr = strip.getBoundingClientRect();
        const tr = tab.getBoundingClientRect();
        if (tr.left < sr.left + pad) {
            strip.scrollLeft = Math.max(0, strip.scrollLeft - (sr.left + pad - tr.left));
        } else if (tr.right > sr.right - rightInset - pad) {
            strip.scrollLeft += tr.right - (sr.right - rightInset - pad);
        }
    }
}

function wireHostDnd(host, gid) {
    host.addEventListener('dragover', (e) => {
        if (dragTabId === null) return;
        const srcG = groupById(dragTabGroupId);
        const selfSingle = srcG && srcG.id === gid && srcG.docIds.length <= 1;
        const tg = groupById(gid);
        const canSplit = !selfSingle && !!tg && tg.docIds.length > 0 && groupDepth(gid) < SPLIT_MAX_DEPTH;
        const cell = host.parentElement;
        if (!cell) return;
        const rect = cell.getBoundingClientRect();
        const relX = (e.clientX - rect.x) / rect.width;
        const relY = (e.clientY - rect.y) / rect.height;
        let zone = 'center';
        if (canSplit) {
            if (relX < 0.25) zone = 'left';
            else if (relX > 0.75) zone = 'right';
            else if (relY < 0.25) zone = 'top';
            else if (relY > 0.75) zone = 'bottom';
        }
        if (zone === 'left' || zone === 'right') {
            if (rect.width / 2 < SPLIT_MIN_W) zone = 'center';
        } else if (zone === 'top' || zone === 'bottom') {
            if (rect.height / 2 < SPLIT_MIN_H) zone = 'center';
        }
        dropZone = { gid, zone, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        showSplitMask();
    });
    host.addEventListener('dragleave', (e) => {
        if (!host.contains(e.relatedTarget)) { hideSplitMask(); dropZone = null; }
    });
    host.addEventListener('drop', (e) => {
        if (dragTabId === null) return;
        e.preventDefault();
        e.stopPropagation();
        const dz = dropZone;
        hideSplitMask();
        dropZone = null;
        const srcId = dragTabId;
        dragTabId = null;
        dragTabGroupId = null;
        if (!dz) { renderTabs(); return; }
        try {
            performDrop(dz, srcId);
        } catch (err) {
            deps.flash('分栏失败：' + (err && err.message || err), true);
            renderTabs();
        }
    });
}

function ensureSplitMask() {
    let m = document.getElementById('split-mask');
    if (!m) {
        m = document.createElement('div');
        m.id = 'split-mask';
        deps.els.editorArea.appendChild(m);
    }
    return m;
}

function showSplitMask() {
    syncAllBrowserTabs();
    if (!dropZone) return;
    const area = deps.els.editorArea.getBoundingClientRect();
    const r = dropZone.rect;
    let mx = r.x, my = r.y, mw = r.w, mh = r.h;
    if (dropZone.zone === 'left' || dropZone.zone === 'right') mw = r.w / 2;
    if (dropZone.zone === 'right') mx = r.x + r.w / 2;
    if (dropZone.zone === 'top' || dropZone.zone === 'bottom') mh = r.h / 2;
    if (dropZone.zone === 'bottom') my = r.y + r.h / 2;
    const m = ensureSplitMask();
    m.style.left = Math.round(mx - area.x) + 'px';
    m.style.top = Math.round(my - area.y) + 'px';
    m.style.width = Math.round(mw) + 'px';
    m.style.height = Math.round(mh) + 'px';
    m.style.display = 'block';
}

function hideSplitMask() {
    const m = document.getElementById('split-mask');
    if (m) m.style.display = 'none';
    syncAllBrowserTabs();
}

function performDrop(dz, srcId) {
    const doc = deps.docs.find((d) => d.id === srcId);
    if (!doc) { renderTabs(); return; }
    const srcG = groupOfDoc(doc.id);
    if (!srcG) { renderTabs(); return; }
    if (dz.zone === 'center' || (srcG.id === dz.gid && srcG.docIds.length <= 1)) {
        activateDoc(doc);
        renderTabs();
        return;
    }
    const dir = (dz.zone === 'left' || dz.zone === 'right') ? 'col' : 'row';
    const side = (dz.zone === 'left' || dz.zone === 'top') ? 'before' : 'after';
    // 从源组移除
    srcG.docIds = srcG.docIds.filter((id) => id !== doc.id);
    if (srcG.activeId === doc.id) srcG.activeId = srcG.docIds[0] || null;
    removeGroupIfEmpty(srcG.id);
    // 目标组保留剩余文档，新组获得被拖文档
    const tg = groupById(dz.gid);
    if (!tg) { activateDoc(doc); renderTabs(); return; }
    tg.docIds = tg.docIds.filter((id) => id !== doc.id);
    if (tg.activeId === doc.id) tg.activeId = tg.docIds[0] || null;
    const ng = createGroup([doc.id]);
    ng.activeId = doc.id;
    // 单组尚未成树时以该组为根直接生成两层；已有树则替换对应叶子
    const base = splitRoot || dz.gid;
    splitRoot = (typeof base === 'string')
        ? { dir, ratio: 0.5, a: side === 'before' ? ng.id : base, b: side === 'before' ? base : ng.id }
        : splitReplaceLeaf(base, dz.gid, dir, side, ng.id);
    focusedGroupId = ng.id;
    renderTabs();
    activateDoc(doc);
}

function renderBreadcrumb(path) {
    deps.els.breadcrumb.textContent = '';
    if (!path) return;
    const parts = String(path).split(/[\\/]+/).filter(Boolean);
    let display = parts;
    if (parts.length > 6) {
        display = [parts[0], '…', ...parts.slice(-4)];
    }
    display.forEach((seg, i) => {
        if (i > 0) {
            const sep = document.createElement('span');
            sep.className = 'crumb-sep';
            sep.innerHTML = iconSvg('chevron-right', 10);
            deps.els.breadcrumb.appendChild(sep);
        }
        const s = document.createElement('span');
        s.className = 'crumb' + (i === display.length - 1 ? ' crumb-last' : '');
        s.textContent = seg;
        deps.els.breadcrumb.appendChild(s);
    });
}

function treeHistory(action) {
    if (!deps.editor || !deps.editor.dom) return;
    const active = document.activeElement;
    if (active && deps.els.editor.contains(active) && active.blur) active.blur();
    const btn = deps.editor.dom[action];
    if (btn && !btn.disabled) btn.click();
}

function textArea() {
    if (!deps.editor) return null;
    if (deps.editor.textarea) return deps.editor.textarea;
    const pane = deps.file && deps.file.pane ? deps.file.pane : deps.els.editor;
    return pane.querySelector('textarea.jsoneditor-text');
}

function doUndo() {
    if (!deps.editor || isDocReadOnly(deps.file, deps.settings)) return;
    if (deps.currentMode === 'tree') {
        const btn = deps.editor.dom && deps.editor.dom.undo;
        if (btn && !btn.disabled) { treeHistory('undo'); return; }
    } else if (deps.currentMode === 'table') {
        if (deps.file && deps.file.tableUndo && deps.file.tableUndo.length) { tableHistory('undo'); return; }
    } else if (deps.currentMode === 'code' && deps.editor.aceEditor) {
        const um = deps.editor.aceEditor.session.getUndoManager();
        if (um && um.hasUndo()) { deps.editor.aceEditor.execCommand('undo'); return; }
    } else if (deps.currentMode === 'text') {
        const ta = textArea();
        if (ta) {
            ta.focus();
            if (document.execCommand('undo')) return;
        }
    }
    // 操作栈为空但文件仍处于修改状态：Ctrl+Z 直接退回未修改（已保存）状态
    if (deps.file && deps.file.dirty) revertDocToSaved(deps.file);
}

// revertDocToSaved：把文档内容回退到最后一次保存（或打开/新建）时的状态
function revertDocToSaved(doc) {
    if (!doc || !doc.editor) return;
    const target = doc.savedText != null ? doc.savedText : (doc.content != null ? doc.content : '');
    let value = null;
    if (deps.currentMode === 'tree') {
        try { value = doc.format.parse(target); } catch (e) { deps.flash('无法回退：已保存内容解析失败', true); return; }
    }
    doc.loading = true;
    try {
        if (deps.currentMode === 'tree') deps.editor.set(value);
        else deps.editor.setText(target);
        doc.text = target;
        doc.bases[doc.mode] = target;
        doc.dirty = false;
        if (deps.file === doc) {
            deps.setDirty(false);
            updateStatus();
            deps.updateWindowTitle();
        }
        deps.updateTabDirty(doc);
        deps.updateBackendDirty();
        if (deps.currentMode === 'table') renderCsvTableView(doc);
    } finally {
        doc.loading = false;
    }
}

function doRedo() {
    if (!deps.editor || isDocReadOnly(deps.file, deps.settings)) return;
    if (deps.currentMode === 'tree') treeHistory('redo');
    else if (deps.currentMode === 'table') tableHistory('redo');
    else if (deps.currentMode === 'code' && deps.editor.aceEditor) deps.editor.aceEditor.execCommand('redo');
    else if (deps.currentMode === 'text') {
        const ta = textArea();
        if (ta) {
            ta.focus();
            document.execCommand('redo');
        }
    }
}

function toggleFocusedNode(action) {
    const active = document.activeElement;
    if (!active || !deps.els.editor.contains(active)) return;
    const tr = active.closest('tr');
    if (!tr) return;
    const btn = tr.querySelector('button.jsoneditor-collapsed, button.jsoneditor-expanded');
    if (!btn) return;
    const collapsed = btn.classList.contains('jsoneditor-collapsed');
    if (action === 'expand' && collapsed) btn.click();
    if (action === 'collapse' && !collapsed) btn.click();
}

// ---- 状态栏「AI 写入」徽标 ----
// 由 ai-panel 的写操作事件驱动：每次落盘推一次状态，不轮询磁盘，
// 因此外部编辑器 / git 造成的改动不会点亮它。
// 显隐沿用状态栏既有做法（切换 display），自动隐藏时长与 flash() 的 5s 对齐。

function updateStatus() {
    if (deps.aiPanel && deps.aiPanel.refreshContext) {
        try { deps.aiPanel.refreshContext(); } catch (e) {}
    }
    if (!deps.file) return;
    deps.scheduleSessionSave();
    syncTabViewTools();
    const fmt = deps.file.format;
    const view = deps.file.splitActive ? deps.viewLabel('split') : deps.viewLabel(deps.file.sqlActive ? 'sql' : deps.currentMode);
    const roSuffix = !isDocReadOnly(deps.file, deps.settings) ? ''
        : isTabReadOnlyFixed(deps.file) ? ' · 只读快照'
            : isTabReadOnlyLocked(deps.file) ? ' · 本标签只读' : ' · 只读';
    deps.els.stMode.textContent = deps.formatDisplayName(deps.file) + ' · ' + view + roSuffix;
    if (deps.file.browser) {
        const url = String(deps.file.browserUrl || '');
        deps.els.stMode.textContent = '网页 · ' + (url === 'about:blank' ? '空白页' : (url.length > 60 ? url.slice(0, 60) + '…' : url));
        deps.els.stSize.textContent = '';
        deps.els.stZoom.textContent = '';
        deps.els.stMdWidth.style.display = 'none';
        deps.els.stEol.textContent = '';
        deps.els.stEnc.textContent = '';
        const stCount = document.getElementById('st-count');
        if (stCount) stCount.textContent = '';
        if (deps.els.stWriting) deps.els.stWriting.style.display = 'none';
        deps.els.stPos.textContent = '';
        return;
    }
    deps.els.stSize.textContent = deps.fmtSize(deps.file.size);
    const tableZoom = deps.currentMode === 'table' && deps.file.format && deps.file.format.table;
    const svgScale = deps.file.svgRenderScale && (deps.currentMode === 'render' || (deps.file.splitActive && deps.file.splitKind === 'svg'));
    const renderZoom = svgScale ? Math.round(deps.file.svgRenderScale * 100) + '%' : '';
    const zoom = deps.file.image && deps.currentMode === 'image' && deps.file.imageScale
        ? Math.round(deps.file.imageScale * 100) + '%'
        : renderZoom || (tableZoom ? Math.round((deps.file.tableZoom || 1) * 100) + '%' : '');
    deps.els.stZoom.textContent = zoom;
    deps.els.stZoom.dataset.tip = zoom
        ? (tableZoom ? '表格缩放比例（点击选择，Ctrl+滚轮调整）' : '图片缩放比例（点击选择，Ctrl+滚轮调整，双击图片恢复适配）')
        : '';
    const showMdWidth = !!(deps.file.format && deps.file.format.preview && deps.currentMode === 'preview' && !deps.file.large);
    deps.els.stMdWidth.style.display = showMdWidth ? '' : 'none';
    deps.els.stMdWidth.textContent = showMdWidth ? '宽度 · ' + deps.mdPreviewWidthLabel(deps.settings.mdPreviewWidth) : '';
    deps.updateWordCount();
    deps.updateWritingStats();
    deps.applyWritingMode();
    if (deps.file.binary) {
        deps.els.stEol.textContent = '';
        deps.els.stEnc.textContent = '';
        deps.els.stEol.style.display = 'none';
        deps.els.stEnc.style.display = 'none';
        deps.scheduleCursorPosition();
        return;
    }
    deps.els.stEol.style.display = '';
    deps.els.stEnc.style.display = '';
    const eolSetting = fmt ? deps.getFormatSettings(fmt.id).eol : 'follow';
    deps.els.stEol.textContent = (eolSetting === 'follow' ? deps.file.eol : eolSetting).toUpperCase();
    const enc = (deps.file.enc || 'utf-8').toUpperCase();
    deps.els.stEnc.textContent = enc + (deps.file.hasBom && enc === 'UTF-8' ? ' BOM' : '');
    deps.scheduleCursorPosition();
    if (typeof deps.scheduleStructureRefresh === 'function') deps.scheduleStructureRefresh(deps.file);
}


function snapshotActiveDoc() {
    if (!deps.file || !deps.editor) return;
    deps.file.text = deps.editor.getText();
    deps.file.mode = deps.currentMode;
    deps.file.dirty = deps.dirty;
    // 预览滚动位置存进 doc：切标签时 pane 被摘除插回会让 DOM scrollTop 归零，先存下来
    capturePreviewScroll(deps.file);
    if (deps.file.splitActive && deps.file.htmlFrame) deps.file.htmlFrame.srcdoc = '';
}

function markDocDirty(doc) {
    if (!doc || !doc.editor) return;
    const text = doc.editor.getText();
    doc.text = text;
    // 插件视图挂着的文档：把新文本推给视图（ctx.onChange），视图自己决定重绘
    if (typeof doc.pluginViewNotify === 'function') {
        try {
            doc.pluginViewNotify(text);
        } catch (e) {
            console.warn('[plugin-viewer] onChange 抛错：', e);
        }
    }
    // 虚拟文档的内容变更回调（openVirtualDoc 的 opts.onChange）：编辑时把最新文本推回宿主。
    if (typeof doc.virtualDocOnChange === 'function') {
        try {
            doc.virtualDocOnChange(text, doc);
        } catch (e) {
            console.warn('[virtual-doc] onChange 抛错：', e);
        }
    }
    const base = doc.bases[doc.mode];
    const next = doc.untitled ? true : (base == null ? true : text !== base);
    if (deps.file === doc) {
        deps.setDirty(next);
    } else {
        doc.dirty = next;
        deps.updateTabDirty(doc);
        deps.updateBackendDirty();
    }
    if (typeof deps.scheduleStructureRefresh === 'function') {
        doc.structureRev = (doc.structureRev || 0) + 1;
        deps.scheduleStructureRefresh(doc);
    }
    if (doc.splitActive) scheduleSplitPreview(doc);
    scheduleGitGutter(doc);
}

// 补丁视图的宿主上下文：把主界面的能力（打开文件、重载、提示）注入进去，
// 补丁视图本身不直接依赖 main.js 的全局状态。
let patchViewHostCtx = null;

function patchRootPath() {
    if (deps.explorer && typeof deps.explorer.getRoot === 'function') return deps.explorer.getRoot() || '';
    return deps.workspaceFolder || '';
}

function patchAbsPath(rel) {
    const root = patchRootPath().replace(/[\\/]+$/, '');
    if (!root || !rel) return rel || '';
    return root + '/' + String(rel).replace(/\\/g, '/');
}

async function reloadAfterPatch(files) {
    // 不做整树全量刷新（清空重建会闪）；逐文件走轻量差量通知，
    // 120ms 防抖会把同一次补丁应用的多个文件合并成一次局部刷新。
    const explorer = deps.explorer;
    if (explorer && typeof explorer.notifyFileChange === 'function') {
        for (const rel of files || []) explorer.notifyFileChange(patchAbsPath(rel));
    }
    for (const rel of files || []) {
        const doc = deps.findDocByPath(patchAbsPath(rel));
        if (!doc) continue;
        if (doc.dirty) {
            const detail = doc.name + ' 已被补丁修改，但编辑器里有未保存内容，未自动重载';
            deps.flash(detail, true);
            // B 级：磁盘已变但编辑器保留旧内容，继续编辑可能覆盖补丁结果。
            notifyFailure('文件已被修改但未重载', detail, {key: 'stale-patch:' + doc.name, kind: 'error'});
            continue;
        }
        if (doc === deps.file) {
            patchViewHostCtx.suppressNotify = true;
            try { await deps.reloadActive({quiet: true}); } catch (e) {}
            patchViewHostCtx.suppressNotify = false;
        } else {
            doc.staleOnDisk = true;
        }
    }
}

function patchViewContext() {
    if (patchViewHostCtx) return patchViewHostCtx;
    patchViewHostCtx = {
        backend: deps.backend,
        suppressNotify: false,
        getRoot: patchRootPath,
        chooseFolder: (dir) => deps.backend.OpenFolderDialog(dir || ''),
        openPath: (rel) => {
            const abs = patchAbsPath(rel);
            if (abs) deps.openPath(abs);
        },
        notifyChanged: (files) => { reloadAfterPatch(files); },
        flash: (msg, isErr) => deps.flash(msg, isErr),
        // 补丁视图的「只读」开关：改标签只读锁（与右键菜单同一状态），锁变化会触发本视图重渲染
        setDocReadOnly: (doc, locked) => deps.setDocReadOnly(doc, locked),
        // 原生 select 的浮层增强（设置页同款），用于去掉「应用模式」的浏览器原生下拉外观
        enhanceSelect: (sel) => deps.enhanceSelect(sel),
        openConfirmDialog: (message, action, okLabel, title, variant, options) => deps.openConfirmDialog(message, action, okLabel, title, variant, options),
    };
    return patchViewHostCtx;
}

// 补丁在代码视图里除 token 着色外，给整行铺淡底色（Ace marker，fullLine）。
// 超过 5000 行只保留 token 着色，避免 marker 过多拖慢滚动。
function refreshPatchMarkers(doc) {
    const ace = doc && doc.editor && doc.editor.aceEditor;
    if (!ace || !doc.format || !doc.format.patch) return;
    const session = ace.session;
    if (!session) return;
    for (const id of (doc._patchMarkers || [])) {
        try { session.removeMarker(id); } catch (e) {}
    }
    doc._patchMarkers = [];
    const total = session.getLength();
    if (total > 5000) return;
    const aceLib = window.ace;
    if (!aceLib || typeof aceLib.require !== 'function') return;
    let Range = null;
    try { Range = aceLib.require('ace/range').Range; } catch (e) { return; }
    if (!Range) return;
    for (let row = 0; row < total; row += 1) {
        const text = session.getLine(row) || '';
        if (text.startsWith('+++') || text.startsWith('---')) continue;
        let cls = '';
        if (text.startsWith('+')) cls = 'dl-diff-add-line';
        else if (text.startsWith('-')) cls = 'dl-diff-del-line';
        if (!cls) continue;
        try {
            doc._patchMarkers.push(session.addMarker(new Range(row, 0, row, 1), cls, 'fullLine'));
        } catch (e) {
            break;
        }
    }
}


function createDocEditor(doc) {
    if (doc.editor) return;
    // 插件视图未注册（插件被禁用 / 卸载）：回落默认视图，别把标签页卡在一个空模式上
    if (isPluginViewMode(doc.mode) && !pluginView.pluginViewAvailable(doc.mode)) doc.mode = '';
    // 视图型虚拟标签页（浏览器 / 后台终端 / 子代理详情 …）：类型判定与视图工厂分派都在这里，
    // 类型清单的单一来源是 core/tab-kinds.js（视图实现仍在本域与各调用方，不进 core）。
    const virtualKind = tabKindOf(doc);
    if (virtualKind) {
        // 这些视图没有 doc.editor，用 doc.pane 判断是否已建过；
        // 否则每次激活都会再建一套面板，旧面板就留在编辑器里叠着。
        if (doc.pane) return;
        const factory = VIRTUAL_TAB_VIEWS[virtualKind.kind];
        if (factory) factory(doc);
        return;
    }
    const fmt = doc.format;
    const fs = deps.getFormatSettings(fmt.id);
    const showJsonErrors = fmt.id === 'json' && /\.json$/i.test(doc.name || '');
    const patchRequested = !!fmt.patch && (doc.mode === 'patch' || !doc.mode);
    const tableRequested = !!fmt.table && doc.mode === 'table';
    // HTML 与 Markdown 共用 'preview' 模式名：前者是 iframe 纯预览，后者是 Markdown 渲染
    const htmlPreviewRequested = !!(deps.isHtmlDoc && deps.isHtmlDoc(doc)) && doc.mode === 'preview';
    const previewRequested = (!!fmt.preview || htmlPreviewRequested) && doc.mode === 'preview';
    const splitRequested = doc.mode === 'split' && !!deps.splitKindFor(doc);
    const imageRequested = !!fmt.image && doc.mode === 'image';
    const videoRequested = !!fmt.video && doc.mode === 'video';
    const audioRequested = !!fmt.audio && doc.mode === 'audio';
    const binaryMode = !!fmt.image || !!fmt.video || !!fmt.audio || fmt.id === 'bytes';
    let startMode = doc.mode === 'text' ? 'text' : (!doc.treeAvailable ? 'code' : (doc.mode === 'code' ? 'code' : 'tree'));
    if (tableRequested || patchRequested) startMode = 'text';
    if (previewRequested || splitRequested) startMode = 'code';
    let initialText = null;
    let initialValue = null;
    if (startMode === 'code' || startMode === 'text') {
        initialText = doc.content || '';
    } else {
        try {
            initialValue = fmt.parse(doc.content || '');
        } catch (e) {
            startMode = 'code';
            initialText = doc.content || '';
            doc.treeAvailable = false;
            doc.parseError = e;
        }
    }
    const pane = document.createElement('div');
    pane.className = 'jsoneditor-pane active';
    deps.els.editor.appendChild(pane);
    deps.installReadOnlyGuards(pane, doc);
    pane.addEventListener('click', (e) => {
        const target = e.target;
        if (!target || !target.closest) return;
        const fold = target.closest('.jsoneditor-value.value-fold');
        if (fold) {
            const row = fold.closest('tr.jsoneditor-expandable');
            const button = row ? row.querySelector('button.jsoneditor-collapsed') : null;
            if (button) {
                e.preventDefault();
                e.stopPropagation();
                button.click();
                queueMicrotask(humanizeCounts);
                return;
            }
        }
        if (target.closest('button.jsoneditor-collapsed, button.jsoneditor-expanded')) {
            queueMicrotask(humanizeCounts);
        }
    }, true);
    doc.loading = true;
    const ed = new JSONEditor(pane, {
        mode: startMode,
        modes: fmt.table ? ['tree', 'text'] : (doc.treeAvailable ? ['tree', 'code', 'text'] : ['code', 'text']),
        mainMenuBar: true,
        navigationBar: !fmt.rawOnly,
        statusBar: false,
        showErrorTable: showJsonErrors,
        maxVisibleChilds: deps.TREE_MAX_CHILDREN,
        language: 'zh-CN',
        languages: deps.editorLocale,
        indentation: fs.indent === 'tab' ? '\t' : Number(fs.indent),
        onChange() {
            if (doc.loading) return;
            markDocDirty(doc);
        },
        onModeChange(mode) {
            if (!doc.editor) return;
            if (doc.splitActive && mode !== 'code') exitSplitView(doc);
            doc.mode = mode;
            if (deps.file === doc) {
                deps.currentMode = mode;
                applyAceMode();
                updateStatus();
                deps.updateSearchState();
            }
            setTimeout(() => {
                if (!doc.editor || doc.mode !== mode) return;
                doc.text = doc.editor.getText();
                if (!doc.dirty) doc.bases[mode] = doc.text;
                deps.applyReadOnlyToDoc(doc);
                scheduleGitGutter(doc, 300);
            }, 0);
        },
        onError(err) {
            if (deps.file === doc) deps.flash(err.message, true);
        },
    });
    doc.editor = ed;
    doc.pane = pane;
    if (ed.aceEditor) {
        hookCodeFoldRanges(ed.aceEditor);
        hookMultiCursor(ed.aceEditor);
        hookAceSmoothScroll(ed.aceEditor);
        // 编辑器内键位随快捷键风格联动（复制行 / 删除行 / 多选…）；必须在 Ace 建好 commands 后调用
        if (typeof deps.applyEditorKeybindings === 'function') deps.applyEditorKeybindings(ed.aceEditor);
        ed.aceEditor.on('changeSelection', deps.scheduleWordCount);
        ed.aceEditor.on('input', deps.scheduleWordCount);
        // 写作模式：光标变化驱动打字机滚动与段落聚焦（内部自判生效条件）
        ed.aceEditor.on('changeSelection', () => deps.scheduleWritingCaret(ed.aceEditor));
        ed.aceEditor.on('input', () => deps.scheduleWritingCaret(ed.aceEditor));
    }
    if (deps.settings.treeExpandDefault === 'collapse' && startMode === 'tree' && doc.treeAvailable && !doc.large) {
        setTimeout(() => {
            try { if (doc.editor) doc.editor.collapseAll(); } catch (e) {}
        }, 50);
    }
    if (startMode === 'code' || startMode === 'text') {
        ed.setText(initialText != null ? initialText : '');
    } else {
        ed.set(initialValue);
    }
    if (isDocReadOnly(doc, deps.settings) && ed.aceEditor) {
        ed.aceEditor.setReadOnly(true);
    }
    if (ed.aceEditor) {
        try {
            ed.aceEditor.session.setUseWrapMode(!!deps.settings.codeWrap);
            ed.aceEditor.setDisplayIndentGuides(!!deps.settings.codeGuides);
            ed.aceEditor.setHighlightIndentGuides(!!deps.settings.codeGuides);
        } catch (e) {}
    }
    setupTreeContextMenu(doc);
    // 插件视图是覆盖层：底层按常规基础模式建，doc.mode 保留 'plugin:<id>'（视图下拉 /
    // 标签页按钮 / 会话恢复都认这一个字段，不能被下面的基础模式覆盖掉）
    const requestedPluginMode = isPluginViewMode(doc.mode) ? doc.mode : '';
    doc.mode = requestedPluginMode || (splitRequested ? 'split' : previewRequested ? 'preview' : tableRequested ? 'table' : imageRequested ? 'image' : videoRequested ? 'video' : audioRequested ? 'audio' : binaryMode ? 'binary' : startMode);
    // 补丁视图是覆盖层：底层编辑器仍按 text 起始，但 doc.mode 必须记成 patch，
    // 否则首次打开时状态栏显示补丁、视图按钮却选中文本。
    if (patchRequested) doc.mode = 'patch';
    doc.text = ed.getText();
    // 打开/恢复/重载属于程序化全文替换：清掉码字观察基线，下一次观察以当前内容重新起算
    delete doc._writingLast;
    delete doc._writingBase;
    if (fmt.table) createCsvTableView(doc);
    if (fmt.preview) createMarkdownPreview(doc);
    if (fmt.image) createImageView(doc);
    if (fmt.video) createVideoView(doc);
    if (fmt.audio) createAudioView(doc);
    if (patchRequested) showPatchView(doc, patchViewContext());
    if (tableRequested) showCsvTableView(doc);
    if (htmlPreviewRequested) showHtmlPreview(doc);
    else if (previewRequested) showMarkdownPreview(doc);
    if (imageRequested) showImageView(doc);
    if (videoRequested) showVideoView(doc);
    if (audioRequested) showAudioView(doc);
    if (requestedPluginMode) showPluginView(doc);
    if (!doc.dirty) doc.bases[doc.mode] = doc.text;
    deps.applyReadOnlyToDoc(doc);
    doc.content = null;
    doc.loading = false;
    if (fmt.patch) refreshPatchMarkers(doc);
    scheduleGitGutter(doc, 200);
}


function createDoc(data) {
    if (data.binary) {        return {
            id: ++deps.docSeq,
            path: data.path,
            name: data.name,
            size: data.size,
            hexShown: data.hexShown || data.size,
            eol: data.eol || 'lf',
            hasBom: false,
            large: false,
            enc: 'binary',
            content: data.content,
            format: data.image ? formats.image : (data.video ? formats.video : (data.audio ? formats.audio : formats.bytes)),
            image: !!data.image,
            video: !!data.video,
            audio: !!data.audio,
            treeAvailable: false,
            parseError: null,
            // 媒体文档首屏就是它自己的视图（规则单一来源见 core/formats.js）
            mode: defaultMediaMode(data) || 'binary',
            text: null,
            rawText: null,
            dirty: false,
            untitled: false,
            binary: true,
            bases: {tree: null, code: null},
            savedText: data.content,
            diskMtime: data.mtime || '',
            readOnlyLocked: !!data.readOnly,
            readOnlyFixed: !!data.readOnlyFixed,
        };
    }
    const preview = detectFormat(data.name, '');
    const fsPreview = deps.getFormatSettings(preview.id);
    const format = detectFormat(data.name, data.content, {indent: fsPreview.indent});
    const fs = deps.getFormatSettings(format.id);
    let treeAvailable = !(data.large || format.rawOnly);
    let parseError = null;
    if (treeAvailable && !String(data.content || '').trim()) {
        treeAvailable = false;
    } else if (treeAvailable) {
        try {
            format.parse(data.content);
        } catch (e) {
            treeAvailable = false;
            parseError = e;
        }
    }
    const ext = String(data.name || '').split('.').pop().toLowerCase();
    // CMakeLists.txt / Makefile / .gitignore 等已知文件名按代码视图打开（带语法高亮），不算纯文本
    const plainTextView = format.id === 'text' && deps.plainTextExtensions.has(ext)
        && !isKnownCodeFileName(data.name) && !data.large;
    const preferredMode = plainTextView ? 'text' : format.preview
        ? (['split', 'preview', 'code', 'text'].includes(fs.view) ? fs.view : 'preview')
        : format.table
            ? (['table', 'tree', 'text'].includes(fs.view) ? fs.view : 'table')
            : (fs.view === 'code' || fs.view === 'text' ? fs.view : 'tree');
    return {
        id: ++deps.docSeq,
        path: data.path,
        name: data.name,
        size: data.size,
        eol: data.eol,
        hasBom: data.hasBom,
        large: data.large,
        enc: data.enc,
        content: data.content,
        format,
        treeAvailable,
        parseError,
        mode: format.patch ? 'patch' : (plainTextView ? 'text' : format.preview ? (data.large ? 'code' : preferredMode) : (treeAvailable ? preferredMode : 'code')),
        text: null,
        rawText: treeAvailable ? data.content : null,
        dirty: false,
        untitled: false,
        binary: false,
        bases: {tree: null, code: null, text: null, table: null, preview: null},
        savedText: data.content,
        bookmarks: new Set(),
        diskMtime: data.mtime || '',
        // 标签页只读锁：只作用于本 doc；全局锁在 settings.readOnlyMode（判定统一走 core/readonly.js）
        // readOnlyFixed = 固定只读（审阅快照），不可解锁
        readOnlyLocked: !!data.readOnly,
        readOnlyFixed: !!data.readOnlyFixed,
        // 只读审阅文档：虚拟 .diff，走 patch 视图但不做预检、不允许应用
        patchReview: !!data.patchReview,
        reviewNotes: Array.isArray(data.reviewNotes) ? data.reviewNotes : [],
    };
}

function setFilename(name, path) {
    deps.els.filenameText.textContent = name || '';
    deps.els.filename.dataset.tip = path || name || '';
    const icon = deps.els.filenameIcon;
    icon.textContent = '';
    icon.className = 'title-icon';
    delete icon.dataset.fi;
    delete icon.dataset.fiName;
    if (!name || name === '未打开文件') return;
    const spec = fileIconSpec(name);
    icon.innerHTML = spec.svg;
    icon.classList.add(spec.className);
    icon.dataset.fi = spec.id;
    icon.dataset.fiName = name;
}

function updateDocChrome() {
    if (!deps.file) return;
    setFilename(deps.file.name, deps.file.path);
    renderBreadcrumb(deps.file.path);
    showBanner(deps.file, deps.file.parseError);
    deps.els.welcome.classList.add('hidden');
    deps.els.editor.classList.remove('hidden');
    deps.updateWindowTitle();
    updateStatus();
    deps.updateSearchState();
    renderTabs();
    if (deps.aiPanel) deps.aiPanel.refreshDockFill();
    // 有内容被打开 / 切到前台：宿主据此解开编辑区收起态。必须放在 refreshDockFill 之后——
    // 一旦有 activeFile，面板就不再 ai-dock-fill 占满，此时若编辑区还收着就是「面板不满、
    // 内容区不可见」的空白状态。收起从来不是固定锁，看内容就展开。
    if (deps.onDocVisible) deps.onDocVisible(deps.file);
    syncAllBrowserTabs();
    deps.refreshStructureSources();
}

function showWelcome() {
    syncAllBrowserTabs();
    if (!deps.docs.length) {
        editorGroups = [];
        splitRoot = null;
        focusedGroupId = null;
    }
    deps.cancelAutoSave();
    if (deps.editor) {
        deps.editor.destroy();
        deps.editor = null;
    }
    deps.file = null;
    deps.dirty = false;
    deps.currentMode = 'tree';
    deps.els.editor.classList.add('hidden');
    deps.els.welcome.classList.remove('hidden');
    setFilename('未打开文件', '');
    deps.els.filename.classList.remove('dirty');
    deps.els.breadcrumb.textContent = '';
    deps.els.stDirty.textContent = '';
    deps.els.stMessage.textContent = '';
    deps.els.stMode.textContent = '';
    deps.els.stSize.textContent = '';
    deps.els.stEol.textContent = '';
    deps.els.stEnc.textContent = '';
    deps.els.stEol.style.display = '';
    deps.els.stEnc.style.display = '';
    // 关掉最后一个标签回欢迎页时，同步清掉文档相关指示项：字数 / 缩放 / 光标位置。
    // 这三项只在有文档时更新（updateStatus / updateWordCount），漏清会把上一个文件的
    // 「全文 4058 字」「1:1」一直挂在欢迎页状态栏上（网页标签分支已在 updateStatus 清过）。
    deps.els.stCount.textContent = '';
    deps.els.stCount.style.display = 'none';
    deps.els.stZoom.textContent = '';
    deps.els.stPos.textContent = '';
    deps.els.banner.classList.add('hidden');
    deps.closeFootPopover();
    deps.closeDialogs();
    if (deps.els.stWriting) deps.els.stWriting.style.display = 'none';
    deps.applyWritingMode();
    deps.updateSearchState();
    renderTabs();
    deps.updateBackendDirty();
    deps.updateWindowTitle();
    deps.syncExplorerActive();
    if (deps.structurePanel) deps.structurePanel.setDoc(null);
    if (deps.aiPanel) deps.aiPanel.refreshDockFill();
    deps.refreshStructureSources();
}

let activateToken = 0;
let lastTabSwitchLog = {id: null, at: 0};

async function activateDoc(doc) {
    if (!doc) return;
    if (doc === deps.file) {
        const g0 = groupOfDoc(doc.id);
        if (g0) { g0.activeId = doc.id; focusedGroupId = g0.id; }
        // 同一文档重新激活（单例虚拟文档的入口按钮如活动栏便签 / 点已激活的标签页）：
        // updateDocChrome 不走，但「要看到这份内容」的意图是真的——仍要通知宿主解开
        // 编辑区收起态，否则 AI 让位收起后，点便签按钮 / 点当前标签页毫无反应。
        if (deps.onDocVisible) deps.onDocVisible(doc);
        // 即便已是 active，若被手动横滚出可视区，重新聚焦时也应滚回定位
        scheduleRevealActiveTabs();
        return;
    }
    // 切换标签时先暂停上一个标签的视频/音频：面板只是被隐藏，不会自动停音频
    pauseVideoInDoc(deps.file);
    pauseAudioInDoc(deps.file);
    let g = groupOfDoc(doc.id);
    if (!g) {
        g = focusedGroup() || createGroup();
        if (!g.docIds.includes(doc.id)) g.docIds.push(doc.id);
    }
    g.activeId = doc.id;
    focusedGroupId = g.id;
    const token = ++activateToken;
    deps.cancelAutoSave();
    // 切标签前先把上一个文件的改动落盘。临时草稿（doc.draft）不依赖 autoSave 开关：
    // 草稿的预期是「随手写、不用管」，切走再切回来不能丢那一次输入。
    const prev = deps.file;
    if ((deps.settings.autoSave || (prev && prev.draft)) &&
        prev && deps.dirty && prev.path && !prev.large) {
        await deps.save({auto: true});
        if (token !== activateToken) return;
    }
    snapshotActiveDoc();
    deps.file = doc;
    deps.dirty = !!doc.dirty;
    deps.currentMode = deps.normalizeLegacySqlMode(doc);
    deps.els.welcome.classList.add('hidden');
    deps.els.editor.classList.remove('hidden');
    if (!deps.els.editor.querySelector('.egroup[data-gid="' + g.id + '"]')) renderEditorLayout();
    for (const d of groupDocs(g)) {
        if (d.pane) d.pane.classList.remove('active');
    }
    if (!doc.editor) createDocEditor(doc);
    renderBookmarks(doc);
    const host = deps.els.editor.querySelector('.egroup[data-gid="' + g.id + '"] .ehost');
    if (host && doc.pane && doc.pane.parentElement !== host) host.appendChild(doc.pane);
    doc.pane.classList.add('active');
    deps.editor = doc.editor;
    updateDocChrome();
    // 标签条重建只对首次构建的组做激活标签定位（renderEditorLayout），切换标签后
    // 「把激活标签滚进可视区」由这里显式兜底，背景重绘不再抢用户的滚动位置。
    scheduleRevealActiveTabs();
    deps.setDirty(doc.dirty);
    applyAceMode();
    if (doc.splitActive || doc.mode === 'split') enterSplitView(doc);
    humanizeCounts();
    if (deps.editor && deps.editor.aceEditor) {
        setTimeout(() => {
            if (deps.editor === doc.editor && deps.editor && deps.editor.aceEditor) {
                deps.editor.aceEditor.resize();
                if (deps.file === doc) applyPendingDocView(doc);
            }
            // 预览滚动恢复：此时 DOM 布局已就绪（ace.resize 后），scrollHeight 可读。
            // 纯预览用 doc.previewScrollTop，分屏用 Ace 滚动对齐——解决切回跳到顶部 / 双页不对齐。
            if (deps.file === doc) restorePreviewScroll(doc);
        }, 0);
    }
    deps.syncExplorerActive({reveal: false});
    if (deps.structurePanel) deps.structurePanel.setDoc(doc);
    // 操作留痕：标签切换，同一标签 2s 内去重（避免连点噪音）。
    const now = Date.now();
    if (lastTabSwitchLog.id !== doc.id || now - lastTabSwitchLog.at > 2000) {
        lastTabSwitchLog = {id: doc.id, at: now};
        deps.activityLog.log('tab.switch', doc.name, {});
    }
    if (doc.staleOnDisk && !doc.dirty) {
        doc.staleOnDisk = false;
        deps.reloadActive({quiet: true});
    }
}

// ---------- 外部修改检测（写盘前冲突 + 读盘自动刷新） ----------
const externalDocTimers = new Map();

function handleExternalDocChanges(payload) {
    if (!payload || !deps.backend.GetFileStat) return;
    const root = legacyPathKey(payload.root || '')
    if (!root) return;
    const changed = new Set();
    if (payload.overflow) {
        for (const doc of deps.docs) if (doc.path && !doc.browser) changed.add(doc);
    } else {
        for (const rel of payload.paths || []) {
            const full = root + '/' + String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
            for (const doc of deps.docs) {
                if (!doc.path || doc.browser) continue;
                if (doc.path.replace(/\\/g, '/').toLowerCase() === full) changed.add(doc);
            }
        }
    }
    for (const doc of changed) {
        const prev = externalDocTimers.get(doc.id);
        if (prev) clearTimeout(prev);
        externalDocTimers.set(doc.id, setTimeout(() => {
            externalDocTimers.delete(doc.id);
            checkDocExternalChange(doc).catch(() => {});
        }, 350));
    }
}

// 磁盘 mtime 与打开/上次保存时不同：干净文档自动重载，脏文档标记 staleOnDisk（保存时弹冲突）
async function checkDocExternalChange(doc) {
    if (!doc || !doc.path || doc.browser || !deps.backend.GetFileStat) return;
    if (!doc.diskMtime) return;
    let st = null;
    try {
        st = await deps.backend.GetFileStat(doc.path);
    } catch (e) {
        return;
    }
    if (!st || !st.exists || st.mtime === doc.diskMtime) return;
    if (doc.dirty) {
        doc.staleOnDisk = true;
        renderTabs();
        return;
    }
    if (doc === deps.file) {
        await deps.reloadActive({quiet: true});
        deps.flash('文件已在外部修改，已自动重新加载 ' + doc.name);
    } else {
        doc.staleOnDisk = true;
        renderTabs();
    }
}

async function handleAIWorkspaceFileChanged(path) {
    // 文件树不做整树全量刷新：那会清空整棵树、丢掉展开态、逐级重载并抢滚动位置，
    // 连续编辑时看起来就是「一直闪」。改为轻量差量通知（纯内容修改零重绘）。
    const explorer = deps.explorer;
    if (explorer && typeof explorer.notifyFileChange === 'function') explorer.notifyFileChange(path);
    const doc = deps.findDocByPath(path);
    if (!doc) return;
    if (doc.dirty) {
        const detail = 'AI 已修改 ' + doc.name + '，但编辑器中有未保存修改，未自动重载';
        deps.flash(detail, true);
        // B 级：AI 改了磁盘但本地有未保存内容，用户没注意就可能保存覆盖回去。
        notifyFailure('AI 修改的文件未重载', detail, {key: 'stale-ai:' + doc.name, kind: 'error'});
        return;
    }
    if (doc === deps.file) {
        const ok = await deps.reloadActive({quiet: true});
        if (ok) deps.flash('AI 已修改并重载 ' + doc.name);
    } else {
        doc.staleOnDisk = true;
        deps.flash('AI 已修改 ' + doc.name + '，切换到该标签时自动重载');
    }
}

// 草稿正文（判空用）：编辑器优先，还没建编辑器时退回 doc.text
function draftTextOf(doc) {
    if (!doc) return '';
    if (doc.editor && typeof doc.editor.getText === 'function') {
        try {
            return doc.editor.getText();
        } catch (e) {}
    }
    return doc.text == null ? '' : String(doc.text);
}

// isBlankDraft：空白临时草稿——关闭标签即自动删除（不走确认）。
// 只认 doc.draft，普通文档永远不会被判成空白草稿（方案 §7.3 第 2 条）。
function isBlankDraft(doc) {
    return !!doc && !!doc.draft && isBlankDraftText(draftTextOf(doc));
}

function requestCloseDoc(doc) {
    if (!doc) return;
    if (doc === deps.file) flushCsvCellEditor();
    // 空白草稿没有可丢的内容，不必拿「未保存的修改」拦一次
    if (doc.dirty && !isBlankDraft(doc)) {
        deps.openConfirmDialog('“' + doc.name + '”有未保存的修改，关闭标签后将丢弃。', () => closeDocNow(doc), '丢弃并关闭', '关闭标签', 'danger');
    } else {
        closeDocNow(doc);
    }
}

function closeDocNow(doc, remember = true) {
    const idx = deps.docs.indexOf(doc);
    if (idx < 0) return;
    // 空白草稿关标签 = 回收站删掉，不弹确认、不留关闭栈（方案 §7.3 第 2 条）
    const blankDraft = isBlankDraft(doc);
    // 操作留痕：脏标签关闭 = 放弃修改（保存后的关闭到这里 dirty 已清零）。
    if (doc.dirty) deps.activityLog.log('tab.closeDirty', doc.name, {discarded: true});
    else deps.activityLog.log('tab.close', doc.name, {});
    disposeSqlDoc(doc);
    disposePatchView(doc);
    // 视频视图：先断源再摘节点，否则解码器与文件句柄要等 GC 才释放
    releaseVideo(doc);
    releaseAudio(doc);
    releaseHtmlPreview(doc);
    // 插件视图：调插件自己的 destroy 再摘挂载点，漏了会留下定时器 / 全局监听
    disposePluginView(doc);
    const wasActive = doc === deps.file;
    if (doc.path && remember && !blankDraft) {
        deps.closedTabs.push({path: doc.path, name: doc.name});
        if (deps.closedTabs.length > 12) deps.closedTabs.shift();
    }
    // 空白草稿删文件：走回收站（误删可取回），失败静默——关标签不该被一次删除失败挡住
    if (blankDraft && doc.path && deps.backend && deps.backend.DeleteEntry) {
        // 删完再刷文件树的「临时草稿」节点（.cadt 不在文件系统通知范围内）
        const refreshScratchTree = () => {
            if (!deps.explorer || typeof deps.explorer.refreshScratch !== 'function') return;
            try {
                const pending = deps.explorer.refreshScratch();
                if (pending && typeof pending.catch === 'function') pending.catch(() => {});
            } catch (e) {}
        };
        try {
            const pending = deps.backend.DeleteEntry(doc.path);
            if (pending && typeof pending.then === 'function') pending.then(refreshScratchTree, refreshScratchTree);
            else refreshScratchTree();
        } catch (e) {
            refreshScratchTree();
        }
    }
    if (doc.browser && deps.backend.BrowserClose) {
        deps.backend.BrowserClose(doc.id).catch(() => {});
    }
    // 个人浏览器标签关闭 = 用户不想看它了：从恢复列表移除并释放恢复租约
    // （登录态仍在 profile 磁盘里，重开不用重新登录）。见 shell/browser-tab-restore.js。
    if (doc.browser && doc.browserPersist && deps.browserTabRestore) {
        deps.browserTabRestore.notePersonalClosed();
    }
    // 视图型虚拟标签页的统一卸载契约：各域建视图时把清理函数挂到 doc.tabUnmount
    // （后台终端断订阅、子代理/团队卸挂载点、支线退注册、群聊成员退 runtime、便签冲盘并让出写权）。
    // 各域只清理「标签页这一层」——作业继续在后台跑、子代理继续跑、会话内容不受影响。
    // 唯一走别的通道的是浏览器（BrowserClose 要调 Go 侧释放 WebView2 实例），在上面单独处理。
    if (doc.tabUnmount) {
        doc.tabUnmount();
        doc.tabUnmount = null;
    }
    deps.docs.splice(idx, 1);
    if (doc.editor) {
        if (doc.editor.aceEditor) unhookAceSmoothScroll(doc.editor.aceEditor);
        doc.editor.destroy();
        doc.editor = null;
    }
    if (doc.pane) {
        doc.pane.remove();
        doc.pane = null;
    }
    const g = groupOfDoc(doc.id);
    if (g) {
        g.docIds = g.docIds.filter((id) => id !== doc.id);
        if (g.activeId === doc.id) g.activeId = g.docIds[0] || null;
        removeGroupIfEmpty(g.id);
    }
    if (deps.docs.length === 0) {
        editorGroups = [];
        splitRoot = null;
        focusedGroupId = null;
        deps.editor = null;
        showWelcome();
        // 用户主动关掉最后一个标签：允许写入空快照
        deps.saveSessionNow({allowEmpty: true});
        return;
    }
    deps.scheduleSessionSave({allowEmpty: true});
    if (wasActive) {
        deps.editor = null;
        deps.file = null;
        deps.dirty = false;
        let next = null;
        if (g && g.docIds.length) {
            const at = Math.min(idx, g.docIds.length - 1);
            next = deps.docs.find((d) => d.id === g.docIds[at]) || deps.docs.find((d) => d.id === g.docIds[0]);
        }
        if (!next) {
            const fg = focusedGroup();
            next = fg ? deps.docs.find((d) => d.id === fg.activeId) : null;
        }
        if (!next) next = deps.docs[Math.min(idx, deps.docs.length - 1)] || deps.docs[0];
        renderTabs();
        activateDoc(next);
    } else {
        renderTabs();
        deps.updateBackendDirty();
    }
}

function showPathInFolder(path) {
    if (!path) return;
    deps.backend.ShowInFolder(path).catch((e) => deps.flash('打开文件位置失败：' + e, true));
}

// 用系统默认关联程序打开（标签页 / 文件树右键共用）：不经过命令行，空格与中文路径都安全。
function openWithDefaultApp(path) {
    if (!path) return;
    if (!deps.backend.OpenWithDefaultApp) {
        deps.flash('当前版本不支持用默认应用打开', true);
        return;
    }
    Promise.resolve(deps.backend.OpenWithDefaultApp(path))
        .catch((e) => deps.flash('用默认应用打开失败：' + e, true));
}

function closeDocsWithConfirm(list, message) {
    const targets = (list || []).filter((doc) => deps.docs.includes(doc));
    if (!targets.length) return;
    const run = () => {
        for (const doc of targets.slice()) closeDocNow(doc);
    };
    if (targets.some((doc) => doc.dirty)) {
        deps.openConfirmDialog(message || '有未保存的修改，关闭后将丢弃。', run, '丢弃并关闭', '关闭标签', 'danger');
    } else {
        run();
    }
}

function reopenClosedTab() {
    const entry = deps.closedTabs.pop();
    if (!entry) return;
    deps.activityLog.log('tab.reopen', entry.name, {});
    deps.openPath(entry.path);
}


    function setFocusedGroupId(v) { focusedGroupId = v; }
    function setSplitRoot(v) { splitRoot = v; }

    return {activateDoc, setFocusedGroupId, setSplitRoot, addDocToFocusedGroup, get editorGroups() { return editorGroups; }, applyAceMode, applyCsvTableZoom, applyImageZoom, browserViewportLabel, closeDocNow, closeDocsWithConfirm, closeSqlView, createDoc, createDocEditor, createGroup, dismissBanner, doRedo, doUndo, enterAudioView, enterBinaryView, enterCsvTable, enterHtmlPreview, enterImageView, enterMarkdownPreview, enterPluginView, enterSplitView, enterSqlView, enterSvgRender, enterTextView, enterVideoView, exitSplitView, expandAllWithGuard, flushCsvCellEditor, get focusedGroupId() { return focusedGroupId; }, groupDocs, groupOfDoc, groupSnapshot, focusEditorGroup, moveDocToGroup, splitDocToGroup, mergeEditorGroup, handleAIWorkspaceFileChanged, handleExternalDocChanges, hideAudioView, hideBanner, hideHtmlPreview, hidePluginView, hideSvgRender, hideVideoView, hookCodeFoldRanges, hookMultiCursor, hookAceSmoothScroll, unhookAceSmoothScroll, humanizeCounts, initCodeFoldHover, jumpBookmark, addBookmarkAt, removeBookmarkAt, clearDocBookmarks, leaveCsvTable, leaveHtmlPreview, leaveMarkdownPreview, markDocDirty, mdSyncScrollFromAce, moveTabInGroup, openWithDefaultApp, patchViewContext, refreshPatchMarkers, rememberDocView, renderBookmarks, renderBreadcrumb, renderCsvTableView, renderEditorLayout, renderMarkdownPreview, renderTabs, refreshTabStripSpacers, reopenClosedTab, releaseAudio, releaseVideo, requestCloseDoc, revertDocToSaved, scheduleGitGutter, setBrowserViewport, setFilename, showBanner, showHtmlPreview, showImageMenu, showMdPreviewMenu, showPathInFolder, showSvgMenu, get splitRoot() { return splitRoot; }, syncAllBrowserTabs, syncBrowserTab, syncTabReadOnly, textArea, toggleBookmark, toggleFocusedNode, updateBrowserTitle, updateDocChrome, updateStatus, zoomCsvTable, zoomImageBy, zoomSvgRenderBy};
}
