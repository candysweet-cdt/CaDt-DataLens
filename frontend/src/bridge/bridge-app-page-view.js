// bridge-app-page-view.js：应用页面在内容区的标签页（「一切皆标签页」的第二族）。
//
// 与第一族（子代理详情 / 支线对话 / 便签…）的区别：那族装载「一个具体业务对象」，
// 这族装载「一个功能页面」（使用统计 / 外部工具 / 定时任务 / 操作记录 / 补丁库）。
// 页面清单与元数据在 core/app-pages.js，内容渲染仍归原域——本模块只负责：
//   建标签页 → 建容器 → 调该页的 mount(root, workspaceRoot) → 关标签时调它返回的卸载函数。
//
// 各页的 mount 由 main.js 经 deps.appPageMounters 注入（键 = appPage id），
// 这样 bridge 域不需要 import settings/ 或 ai/（同级域互相不 import）。
//
// ── 按工作区开多份 ────────────────────────────────────────────────────────
// 标了 perWorkspace 的页（认知索引 / 补丁库）数据物理上在各工作区里（.cadt/cognition、
// .cadt/patches）。这类页按**工作区**去重：同一个页面可以为不同仓库各开一个标签页，
// 各绑各的根，互不干扰——用户能并排看两个仓库的索引，而不是切过去再点刷新。
// 全局页（使用统计 / 定时任务…）仍是单例，全应用只有一个。
// 页面内要显示自己是哪个工作区（标签名带仓库名 + 页头给完整路径）。
import {appPageOf, appPageTabTitle} from '../core/app-pages.js';
import {createVirtualTabDoc} from '../core/virtual-tab-doc.js';
import {pathKey} from '../core/event-scope.js';
import {isMultiWorkspace} from '../core/root-scope.js';

export function createBridgeAppPageView(deps) {

// 根比较走 core 的唯一实现 pathKey（分隔符/尾斜杠/大小写归一口径全仓一致）。
// 不要在这里内联写 replace(/\\/g,'/')...——那是重复实现，改了这边忘那边就出现
// 「同一个目录判定相等/不等」两套答案（本轮已因此踩过 bug）。
function sameRoot(a, b) {
    return pathKey(a) === pathKey(b);
}

// 当前是否多工作区窗口。标题加不加仓库名、perWorkspace 页是否分副本都看它。
// 直接用 core/root-scope 的唯一实现（不在这里再判断一次全局标记）。
function isMulti() {
    return isMultiWorkspace();
}

// 打开应用页面标签页。
// pageId：APP_PAGES 的 id。
// workspaceRoot：可选，perWorkspace 页要绑的根（不传则取 deps.currentRoot()）。
// 同一页 + 同一根已开着 → 切过去；perWorkspace 页换了根 → 另开一个标签页（不是复用）。
function openAppPageTab(pageId, workspaceRoot) {
    const page = appPageOf(pageId);
    if (!page) return null;
    const multi = isMulti();
    const wantRoot = page.perWorkspace
        ? String(workspaceRoot || (typeof deps.currentRoot === 'function' ? deps.currentRoot() : '') || '')
        : '';
    const existing = deps.docs.find((d) => d.appPage === page.id
        && (!page.perWorkspace || sameRoot(d.appPageWorkspace, wantRoot)));
    if (existing) {
        deps.activateDoc(existing);
        return existing;
    }
    // 标签 id 带工作区哈希（纯展示用，避免两个仓库的同一页在标签栏同名冲突）；
    // 但 **doc.appPage 必须保持纯页面 id**：它同时被 appPageOf() 与 appPageMounters[doc.appPage]
    // 用来查页面元数据与挂载器，拼成复合键就查不到 → 标签页显示「界面尚未就绪」（实测）。
    // 工作区维度由 doc.appPageWorkspace 承担（上面 openAppPageTab 的去重已按 (page, root) 比对）。
    const rootKey = page.perWorkspace ? wantRoot.replace(/\\/g, '/').toLowerCase() : '';
    const title = appPageTabTitle(page, wantRoot, multi);
    const doc = createVirtualTabDoc({
        id: rootKey ? 'apppage-' + page.id + '-' + Math.abs(hashKey(rootKey)) : 'apppage-' + page.id,
        name: title,
        format: {id: 'apppage', name: title, extensions: [], aceMode: 'text', rawOnly: true},
        mode: 'apppage',
        marker: 'appPage',
        key: page.id,
    });
    doc.appPageWorkspace = wantRoot;
    deps.docs.push(doc);
    deps.addDocToFocusedGroup(doc);
    deps.activateDoc(doc);
    return doc;
}

// 稳定的 32 位字符串哈希：只用于给标签 id 造不冲突的后缀（同一根每次得到同一个值）。
function hashKey(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
        h = (h * 31 + text.charCodeAt(i)) | 0;
    }
    return h;
}

function createAppPageView(doc) {
    const page = appPageOf(doc.appPage);
    const pane = document.createElement('div');
    pane.className = 'jsoneditor-pane active apppage-pane';
    deps.els.editor.appendChild(pane);
    // 滚动与定位分层：pane 不滚动，仅作抽屉（.ap-drawer，position:absolute）的定位锚；
    // 真正滚动的是内层 .apppage-scroll。抽屉挂到 pane 上就固定在视口，不再随列表内容滚走。
    const scroll = document.createElement('div');
    scroll.className = 'apppage-scroll';
    pane.appendChild(scroll);
    const root = document.createElement('div');
    root.className = 'apppage-root';
    scroll.appendChild(root);
    doc.pane = pane;
    doc.appPageRoot = root;

    const mount = deps.appPageMounters ? deps.appPageMounters[doc.appPage] : null;
    if (typeof mount !== 'function') {
        root.textContent = '应用页面「' + (page ? page.label : doc.appPage) + '」不可用：界面尚未就绪。';
        root.classList.add('empty');
        return;
    }
    // 第二个参数是该标签页绑定的工作区（全局页传空串）。perWorkspace 页把它当**固定根**，
    // 不再每次现取「当前根」——这正是「一个标签页一个仓库」的实现点。
    const unmount = mount(root, doc.appPageWorkspace || '');
    // 应用页面标签页里的原生 select 走设置页同款浮层增强（.apppage-root select 已在扫描器
    // 覆盖范围内，只是此前只在切设置页时才调）。mount 后补一次，去掉浏览器原生外观。
    // 异步渲染的 select（如使用统计的每页条数）由各页自行增强，这里覆盖同步建好的筛选栏。
    if (typeof deps.enhanceSetSelects === 'function') deps.enhanceSetSelects();
    // 统一卸载契约（closeDocNow 只调这一条）：页面自己退订 / 释放图表实例
    doc.tabUnmount = () => {
        if (typeof unmount === 'function') unmount();
        doc.tabUnmount = null;
        doc.appPageRoot = null;
    };
}

return {openAppPageTab, createAppPageView};
}
