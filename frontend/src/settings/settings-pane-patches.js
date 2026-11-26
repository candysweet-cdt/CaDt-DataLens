// settings-pane-patches.js：补丁库（.cadt/patches 的最近补丁 + 删除）。
// 删除走 Go 的 PatchDelete：它把 .patch / backup / manifest / meta 送回收站，并从索引里
// 摘掉该 id 的全部历史行；已应用的补丁删掉后无法再撤销，所以删除前二次确认。
//
// 宿主：2026-11-22 起本页是「应用页面」标签页（core/app-pages.js 的 patches），
// 由 mount(root) 在标签页容器里建骨架并绑定。原来的设置 → 开发者 内嵌位置已移除。
//
// 现代化重设计：卡片列表 + 状态筛选 + 搜索 + 排序 + 详情抽屉（复用 patch-view 的 diff
// 渲染思路）+ 整行可点打开补丁视图。分页在前端做（Go PatchList 一次取足够多），不改后端契约。

import {createInput, createSelect} from '../core/form-controls.js';
import {pageHeader, commandBar, filterChips, statusBadge, stateBlock, relativeTime, iconButton, detailDrawer} from '../app-pages/ui-kit.js';

// 状态徽标：文案与色调（tone 决定 CSS class）。未知状态按「未应用」展示原文更保险，
// 但索引只会有这几种，多余的走 default 兜底。
export function patchStatusLabel(status) {
    switch (status) {
        case 'applied': return {text: '已应用', tone: 'ok'};
        case 'partial': return {text: '部分应用', tone: 'warn'};
        case 'applying': return {text: '应用中', tone: 'warn'};
        case 'failed': return {text: '应用中断', tone: 'error'};
        case 'reverted': return {text: '已撤销', tone: 'muted'};
        default: return {text: '未应用', tone: 'muted'};
    }
}

// 行标题：摘要 + 文件数 + 增删统计（纯函数，便于测试）。
export function patchRowTitle(meta) {
    const m = meta || {};
    const files = Array.isArray(m.files) ? m.files.length : 0;
    const parts = [String(m.summary || '补丁')];
    if (files) parts.push(files + ' 个文件');
    parts.push('+' + (Number(m.added) || 0) + ' −' + (Number(m.removed) || 0));
    return parts.join(' · ');
}

// 删除确认文案：已应用的补丁必须点明「无法撤销」。
export function patchDeleteConfirmText(meta) {
    const m = meta || {};
    const base = '将删除补丁「' + String(m.summary || m.id || '') + '」及其补丁文件、备份与元数据（进回收站）。';
    if (m.status === 'applied' || m.status === 'partial') {
        return base + '它已经应用过，删除后无法再撤销，只能手工还原改动的文件。确定继续吗？';
    }
    return base + '确定继续吗？';
}

function patchTimeText(ms) {
    const d = new Date(Number(ms) * 1000 || 0);
    if (!d.getTime()) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 页面骨架：标签页宿主里由 mount() 注入（id 保持不变，纯渲染函数照常按 id 查询）。
export function patchStoreSkeleton() {
    return `
<div class="set-group-title">补丁库</div>
<div class="set-card">
    <div class="set-row">
        <div class="set-main">
            <div class="set-title">最近补丁<button type="button" class="info-tip" data-tip="AI 提交过的补丁（.cadt/patches）。删除会把补丁文件、备份与元数据送进回收站；已应用的补丁删除后无法再撤销。" aria-label="补丁库说明"></button></div>
            <div class="set-desc" id="patch-store-path">存储目录：—</div>
        </div>
        <div class="set-control">
            <button type="button" id="patch-store-refresh" class="dlg-btn">刷新</button>
        </div>
    </div>
    <div class="set-row-top">
        <div id="patch-store-list" class="patch-store-list"></div>
    </div>
</div>`;
}

export function createSettingsPanePatches(deps) {
    // 当前宿主里的元素（mount 时按 id 在宿主内查询，兼容多宿主的将来）
    let els = {listEl: null, pathEl: null, refreshBtn: null};
    let loading = false;
    let allPatches = [];            // 一次取回的全量补丁（前端筛选/排序/分页）
    let patchFilter = {status: 'all', keyword: '', sort: 'time'};
    let patchPage = 1;
    const PAGE_SIZE = 30;
    let openDrawer = null;          // 当前详情抽屉句柄
    let mountedRoot = '';           // 本标签页绑定的工作区（perWorkspace：一个标签一个仓库）

    function root() {
        // 应用页面标签页在 mount 时给了固定根：一律用它，不再随「当前根」漂移
        //（否则切走工作区后，开着的那份补丁库会去列别的仓库的补丁）。
        if (mountedRoot) return mountedRoot;
        return typeof deps.root === 'function' ? deps.root() : (deps.root || '');
    }

    function emptyText(text, action) {
        const listEl = els.listEl;
        if (!listEl) return;
        listEl.textContent = '';
        listEl.appendChild(stateBlock('empty', text, action));
    }

    // 旧 tone（ok/warn/error/muted）→ ui-kit tone（success/warn/danger/neutral）
    function toneOf(raw) {
        return {ok: 'success', warn: 'warn', error: 'danger', muted: 'neutral'}[raw] || 'neutral';
    }

    // 在补丁视图中打开（复用 backend.PatchPreviewFile 契约，由宿主 openPatchFile 建标签页）
    function openPatch(meta) {
        if (!meta || !meta.patchPath) return deps.flash('该补丁没有可预览的文件', true);
        if (typeof deps.openPatchFile === 'function') deps.openPatchFile(meta.patchPath, root());
        else deps.flash('当前宿主不支持打开补丁视图', true);
    }

    // 详情抽屉：展示补丁元信息 + 文件列表 + 操作（打开视图 / 撤销 / 删除）
    function showDetail(meta) {
        if (openDrawer) { openDrawer.close(); openDrawer = null; }
        const body = document.createElement('div');
        body.className = 'ap-patch-detail';
        const label = patchStatusLabel(meta.status);
        body.appendChild(statusBadge(label.text, toneOf(label.tone)));
        const rows = [
            ['摘要', meta.summary || '—'],
            ['创建时间', relativeTime(Number(meta.createdAt) * 1000) + '（' + patchTimeText(meta.createdAt) + '）'],
            ['文件数', String((meta.files || []).length)],
            ['增删', '+' + (meta.added || 0) + ' −' + (meta.removed || 0)],
            ['存储路径', meta.patchPath || '—'],
        ];
        if (meta.appliedAt) rows.push(['应用时间', relativeTime(Number(meta.appliedAt) * 1000)]);
        if (meta.revertedAt) rows.push(['撤销时间', relativeTime(Number(meta.revertedAt) * 1000)]);
        for (const [k, v] of rows) {
            const line = document.createElement('div');
            line.className = 'ap-detail-kv';
            const key = document.createElement('span');
            key.className = 'ap-detail-k';
            key.textContent = k;
            const val = document.createElement('span');
            val.className = 'ap-detail-v';
            val.textContent = v;
            val.dataset.tip = v;
            line.append(key, val);
            body.appendChild(line);
        }
        if ((meta.files || []).length) {
            const filesTitle = document.createElement('div');
            filesTitle.className = 'ap-detail-section';
            filesTitle.textContent = '文件列表';
            body.appendChild(filesTitle);
            const files = document.createElement('div');
            files.className = 'ap-patch-files';
            for (const f of meta.files) {
                const fRow = document.createElement('div');
                fRow.className = 'ap-patch-file';
                fRow.textContent = f;
                fRow.dataset.tip = f;
                files.appendChild(fRow);
            }
            body.appendChild(files);
        }
        const actions = document.createElement('div');
        actions.className = 'ap-detail-actions';
        actions.appendChild(iconButton({icon: 'doc', tip: '在补丁视图中打开（可应用/撤销）', label: '打开视图', onClick: () => openPatch(meta)}));
        if (meta.status === 'applied' && typeof deps.backend.PatchRevert === 'function') {
            actions.appendChild(iconButton({
                icon: 'restore', tip: '从备份撤销这份补丁', label: '撤销', danger: true,
                onClick: () => deps.openConfirmDialog('撤销补丁「' + (meta.summary || meta.id) + '」并从备份还原文件？', async () => {
                    try {
                        const res = await deps.backend.PatchRevert(meta.id, root(), 'abort');
                        deps.flash(res && res.ok ? '补丁已撤销' : ('撤销失败：' + ((res && res.message) || '未知原因')), !(res && res.ok));
                        if (openDrawer) { openDrawer.close(); openDrawer = null; }
                        refreshPatchStore();
                    } catch (e) {
                        deps.flash('撤销失败：' + ((e && e.message) || e), true);
                    }
                }, '撤销', '撤销补丁', 'danger'),
            }));
        }
        actions.appendChild(iconButton({icon: 'trash', tip: '删除补丁（进回收站，已应用项无法再撤销）', label: '删除', danger: true, onClick: () => {
            if (openDrawer) { openDrawer.close(); openDrawer = null; }
            deletePatchRecord(meta);
        }}));
        body.appendChild(actions);

        const drawer = detailDrawer({title: meta.summary || '补丁详情', onClose: () => { if (openDrawer === drawer) openDrawer = null; }, content: body});
        openDrawer = drawer;
        // 抽屉挂到不滚动的 apppage-pane（定位锚）：absolute 抽屉固定在视口，不随内层
        // .apppage-scroll 的列表内容滚走（认知索引同款）
        const hostPane = els.listEl && els.listEl.closest('.apppage-pane');
        (hostPane || document.body).appendChild(drawer.element);
    }

    function buildRow(meta) {
        const row = document.createElement('div');
        row.className = 'patch-store-row';
        row.dataset.tip = '点击查看补丁详情';

        const time = document.createElement('span');
        time.className = 'ps-time';
        time.textContent = relativeTime(Number(meta.createdAt) * 1000);
        time.dataset.tip = patchTimeText(meta.createdAt);

        const label = patchStatusLabel(meta.status);
        row.appendChild(statusBadge(label.text, toneOf(label.tone)));

        const summary = document.createElement('span');
        summary.className = 'ps-summary';
        summary.textContent = patchRowTitle(meta);
        summary.dataset.tip = summary.textContent;

        const openBtn = iconButton({icon: 'doc', tip: '打开补丁视图', onClick: (e) => { e.stopPropagation(); openPatch(meta); }});
        const del = iconButton({icon: 'trash', tip: '删除补丁', danger: true, onClick: (e) => { e.stopPropagation(); deletePatchRecord(meta); }});
        const actions = document.createElement('span');
        actions.className = 'ps-actions';
        actions.append(openBtn, del);

        row.append(time, summary, actions);
        row.addEventListener('click', () => showDetail(meta));
        return row;
    }

    function filteredPatches() {
        let list = allPatches.slice();
        if (patchFilter.status !== 'all') list = list.filter((m) => m.status === patchFilter.status);
        if (patchFilter.keyword) {
            const kw = patchFilter.keyword.toLowerCase();
            list = list.filter((m) => (String(m.summary || '') + ' ' + (m.files || []).join(' ')).toLowerCase().includes(kw));
        }
        if (patchFilter.sort === 'size') list.sort((a, b) => (b.added + b.removed) - (a.added + a.removed));
        else list.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
        return list;
    }

    function paintList() {
        const listEl = els.listEl;
        if (!listEl) return;
        const rows = filteredPatches();
        if (!rows.length) {
            emptyText(allPatches.length ? '没有符合条件的补丁' : '还没有补丁记录');
            return;
        }
        const start = (patchPage - 1) * PAGE_SIZE;
        const pageRows = rows.slice(start, start + PAGE_SIZE);
        listEl.textContent = '';
        const frag = document.createDocumentFragment();
        for (const meta of pageRows) frag.appendChild(buildRow(meta));
        listEl.appendChild(frag);
        if (rows.length > PAGE_SIZE) {
            const foot = document.createElement('div');
            foot.className = 'ap-patch-foot';
            foot.textContent = '共 ' + rows.length + ' 条 · 第 ' + patchPage + '/' + Math.ceil(rows.length / PAGE_SIZE) + ' 页';
            const prev = iconButton({icon: 'chevron-left', tip: '上一页', onClick: () => { if (patchPage > 1) { patchPage--; paintList(); } }});
            const next = iconButton({icon: 'chevron-right', tip: '下一页', onClick: () => { if (patchPage < Math.ceil(rows.length / PAGE_SIZE)) { patchPage++; paintList(); } }});
            foot.append(prev, next);
            listEl.appendChild(foot);
        }
    }

    async function refreshPatchStore() {
        const listEl = els.listEl;
        if (!listEl) return;
        if (!deps.backend.PatchList) {
            emptyText('当前版本不支持补丁库（旧版后端）');
            return;
        }
        if (loading) return;
        loading = true;
        try {
            const dir = root();
            if (els.pathEl && deps.backend.PatchStoreDir) {
                try {
                    const storeDir = await deps.backend.PatchStoreDir(dir);
                    els.pathEl.textContent = '存储目录：' + (storeDir || '—');
                } catch (e) {
                    els.pathEl.textContent = '存储目录：—';
                }
            }
            // 一次取足够多（500），前端做筛选/排序/分页，不改 Go 绑定签名
            const list = await deps.backend.PatchList(dir, 500);
            allPatches = Array.isArray(list) ? list : [];
            patchPage = 1;
            paintList();
        } catch (e) {
            emptyText('读取失败：' + ((e && e.message) || e));
        } finally {
            loading = false;
        }
    }

    function deletePatchRecord(meta) {
        if (!meta || !meta.id) return;
        if (!deps.backend.PatchDelete) {
            deps.flash('当前版本不支持删除补丁', true);
            return;
        }
        deps.openConfirmDialog(patchDeleteConfirmText(meta), async () => {
            try {
                await deps.backend.PatchDelete(meta.id, root());
                deps.flash('补丁已删除（文件已进回收站）');
            } catch (e) {
                deps.flash('删除失败：' + ((e && e.message) || e), true);
            }
            refreshPatchStore();
        }, '删除', '删除补丁', 'danger');
    }

    // 挂到宿主容器（应用页面标签页调用）：建骨架 → 按 id 取元素 → 绑定 → 首次加载。
    // 返回卸载函数（关标签时由 doc.tabUnmount 调用）。
    //
    // workspaceRoot：该标签页绑定的固定根。补丁库的数据在 <ws>/.cadt/patches，是**工作区级**的，
    // 所以应用页面按工作区开多份，每份各看各的仓库。传了就一直用它（不随「当前根」漂移），
    // 这也让页头的「存储目录」稳定显示所属工作区；不传则回落 deps.root()（旧调用/单测）。
    function mount(host, workspaceRoot) {
        if (!host) return null;
        host.textContent = '';
        mountedRoot = String(workspaceRoot || '');

        const refreshBtn = document.createElement('button');
        refreshBtn.type = 'button';
        refreshBtn.className = 'dlg-btn';
        refreshBtn.textContent = '刷新';
        refreshBtn.addEventListener('click', () => refreshPatchStore());
        const pathEl = document.createElement('div');
        pathEl.className = 'ap-patch-path';
        pathEl.textContent = '存储目录：—';
        host.appendChild(pageHeader({
            title: '补丁库',
            desc: 'AI 提交过的补丁（.cadt/patches）。点行查看详情，可打开补丁视图应用/撤销；删除会送回收站。',
            actions: [refreshBtn],
        }));
        // 页头显示所属工作区：同一个「补丁库」现在可能开着两三份，不标出来分不清是哪个仓库。
        // 多工作区下只显示仓库名会重名（两个仓库同叫 src），所以给完整路径，用 title 兜住长路径。
        if (mountedRoot) {
            pathEl.textContent = '工作区：' + mountedRoot;
            pathEl.title = mountedRoot;
        }
        host.appendChild(pathEl);

        const chips = filterChips({
            items: [
                {value: 'all', label: '全部'},
                {value: 'applied', label: '已应用'},
                {value: 'unapplied', label: '未应用'},
                {value: 'failed', label: '失败'},
                {value: 'reverted', label: '已撤销'},
            ],
            value: patchFilter.status,
            onChange: (v) => { patchFilter.status = v; patchPage = 1; paintList(); },
        });
        const sortCtl = createSelect({
            options: [{value: 'time', label: '按时间'}, {value: 'size', label: '按改动量'}],
            onChange: () => { patchFilter.sort = sortCtl.value; patchPage = 1; paintList(); },
        }).control;
        const bar = commandBar({
            placeholder: '搜索摘要或文件路径',
            onSearch: (v) => { patchFilter.keyword = v; patchPage = 1; paintList(); },
            filters: [chips.element, sortCtl],
        });
        host.appendChild(bar.element);

        const listEl = document.createElement('div');
        listEl.className = 'patch-store-list';
        listEl.id = 'patch-store-list';
        host.appendChild(listEl);
        els = {listEl, pathEl, refreshBtn};
        refreshPatchStore();
        return () => {
            if (openDrawer) { openDrawer.close(); openDrawer = null; }
            if (typeof bar.destroy === 'function') bar.destroy();
            els = {listEl: null, pathEl: null, refreshBtn: null};
            allPatches = [];
        };
    }

    return {mount, refreshPatchStore, deletePatchRecord};
}
