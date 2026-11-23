// ai-cognition-page.js：应用页面「认知索引」——工作区 .cadt/cognition/ 卷的只读浏览。
// 路径地图（overview lines）+ FRAS 条目详情 + 关键词命中 + 治理状态条；页面只读不写卷
// （卷只能经 cognition_edit 的 CAS 写）。入口条件可见：APP_PAGES 的 visibleWhen=aiCognition，
// 开关翻转后的刷新由 main.js 的 settings-changed 订阅驱动（refreshCognitionPageIfVisible）。

import {pageHeader, statusBadge, commandBar, filterChips, stateBlock, detailDrawer, copyButton, iconButton} from '../../app-pages/ui-kit.js';
import {iconSvg} from '../../core/icons.js';

// drift 四态的页面措辞与解释（悬停提示）
const DRIFT_KINDS = [
    {key: 'missing', label: '缺文件', tip: '索引里有条目、工作区里文件已不存在'},
    {key: 'orphan', label: '孤儿条目', tip: '工作区里有文件、索引里没有条目'},
    {key: 'stale', label: '已过期', tip: '文件内容自建卷后变过，条目可能陈旧'},
    {key: 'unbaselined', label: '未记账', tip: 'baseline 里缺失的文件（尚未收进治理基准）'},
];

export function createAICognitionPage(deps) {
    let hostEl = null;
    let statusEl = null;
    let listEl = null;
    let bar = null;
    let openDrawer = null;
    let snapshot = null; // overview ReadResult（exists/lines/entries/bytes/fingerprint…）
    let chipsValue = 'all';
    let lastSearch = '';
    let loadSeq = 0;
    let searchSeq = 0;
    let detailSeq = 0;
    let page = 1;                 // 当前页（列表与搜索结果共用，切换筛选/搜索时归 1）
    const PAGE_SIZE = 30;         // 与补丁库同款前端分页，避免 205 条一次铺开

    function alive() { return !!(hostEl && hostEl.isConnected); }
    function workspace() { return String((deps.getWorkspace && deps.getWorkspace()) || ''); }
    function readSupported() { return !!(deps.backend && typeof deps.backend.CognitionRead === 'function'); }
    function cognitionOn() { return !!(deps.settings && deps.settings.aiCognition === true); }

    // ---- 渲染原子 ----

    function chip(text) {
        const el = document.createElement('span');
        el.className = 'cog-chip';
        el.textContent = String(text);
        return el;
    }

    // 列表行：图标 + 路径（命中模式带 FRAS 首行预览）+ 标签；整行可点开详情
    function rowEl(item, preview) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'cog-row';
        row.dataset.tip = '查看条目详情';
        const isDir = !!item.dir || String(item.path || '').endsWith('/');
        const ic = document.createElement('span');
        ic.className = 'cog-row-ic';
        ic.innerHTML = iconSvg(isDir ? 'folder' : 'doc', 13);
        const main = document.createElement('div');
        main.className = 'cog-row-main';
        const path = document.createElement('div');
        path.className = 'cog-row-path';
        path.textContent = String(item.path || '');
        main.appendChild(path);
        if (preview) {
            const sub = document.createElement('div');
            sub.className = 'cog-row-sub';
            sub.textContent = preview;
            main.appendChild(sub);
        }
        row.append(ic, main);
        const labels = Array.isArray(item.labels) ? item.labels : [];
        if (labels.length) {
            const tags = document.createElement('div');
            tags.className = 'cog-row-tags';
            for (const t of labels) tags.appendChild(chip(t));
            row.appendChild(tags);
        }
        row.addEventListener('click', () => openDetail(String(item.path || '')));
        return row;
    }

    // chips（全部/文件/目录）对两类列表统一生效：目录条目 = 带 dir 标记或路径尾 /
    function applyChips(list) {
        if (chipsValue === 'file') return list.filter((it) => !(it.dir || String(it.path || '').endsWith('/')));
        if (chipsValue === 'dir') return list.filter((it) => it.dir || String(it.path || '').endsWith('/'));
        return list;
    }

    function paintList(child) {
        listEl.textContent = '';
        if (child) listEl.appendChild(child);
    }
    function paintListLoading() { paintList(stateBlock('loading', '加载中…')); }
    function paintListError(e) {
        paintList(stateBlock('error', '认知索引读取失败：' + ((e && e.message) || e)));
    }

    // ---- 状态条 ----

    function renderStatusBase() {
        if (!alive() || !statusEl) return;
        statusEl.textContent = '';
        statusEl.classList.add('hidden');
        if (!snapshot || !snapshot.exists) return;
        statusEl.classList.remove('hidden');
        if (snapshot.scene) statusEl.appendChild(statusBadge('scene: ' + snapshot.scene, 'neutral'));
        statusEl.appendChild(statusBadge(snapshot.entries + ' 条', 'neutral'));
        statusEl.appendChild(statusBadge(snapshot.bytes + ' 字节', 'neutral'));
        const fp = String(snapshot.fingerprint || '');
        if (fp) {
            const fpWrap = document.createElement('span');
            fpWrap.className = 'cog-fp';
            fpWrap.dataset.tip = '卷指纹（CAS 基准）';
            fpWrap.textContent = fp.slice(0, 8);
            fpWrap.appendChild(copyButton(() => fp, {flash: deps.flash, tip: '复制卷指纹'}));
            statusEl.appendChild(fpWrap);
        }
    }

    // 治理状态（预算 + drift 四态）：尽力而为——status 读失败只藏状态条，不打断列表
    async function loadStatus(ws, seq) {
        if (!alive() || !readSupported()) return;
        try {
            const res = JSON.parse(await deps.backend.CognitionStatus(ws, false));
            if (seq !== loadSeq || !alive() || !statusEl || !snapshot) return;
            statusEl.appendChild(statusBadge(
                '预算 ' + res.entries + '/' + res.budgetEntries + ' 条 · ' + res.bytes + '/' + res.budgetBytes + ' 字节', 'neutral'));
            for (const kind of DRIFT_KINDS) {
                const n = res[kind.key] && Number(res[kind.key].total) || 0;
                if (!n) continue;
                const badge = statusBadge(kind.label + ' ' + n, 'warn');
                badge.dataset.tip = kind.tip;
                statusEl.appendChild(badge);
            }
        } catch (e) {
            // 尽力而为路径：状态条是辅助信息，读失败不值得打断主列表，也不刷错误态
        }
    }

    // ---- 列表 ----

    // 分页页脚：共 N 条 · 第 x/y 页 + 上一页/下一页（与补丁库 ap-patch-foot 同款）。
    // 复用 ui-kit 的 iconButton，图标走 core/icons.js 注册表。
    function pageFoot(total, totalPages) {
        const foot = document.createElement('div');
        foot.className = 'ap-patch-foot cog-page-foot';
        foot.textContent = '共 ' + total + ' 条 · 第 ' + page + '/' + totalPages + ' 页';
        const prev = iconButton({icon: 'chevron-left', tip: '上一页', onClick: () => {
            if (page > 1) { page--; repaintCurrent(); }
        }});
        const next = iconButton({icon: 'chevron-right', tip: '下一页', onClick: () => {
            if (page < totalPages) { page++; repaintCurrent(); }
        }});
        foot.append(prev, next);
        return foot;
    }

    // 统一分页渲染：切片 + 行 + 页脚。previewOf 由调用方给（概览无预览，搜索带 FRAS 首行）。
    function paintPaged(items, previewOf) {
        if (!items.length) return false;
        const totalPages = Math.ceil(items.length / PAGE_SIZE);
        if (page > totalPages) page = totalPages;
        const start = (page - 1) * PAGE_SIZE;
        const rows = items.slice(start, start + PAGE_SIZE);
        paintList(null);
        for (const item of rows) listEl.appendChild(rowEl(item, previewOf ? previewOf(item) : ''));
        if (totalPages > 1) listEl.appendChild(pageFoot(items.length, totalPages));
        return true;
    }

    // 翻页时按当前视图重绘：搜索态重放关键词（保留页码），概览态直接渲染快照。
    function repaintCurrent() {
        if (lastSearch) onSearch(lastSearch, false);
        else renderList();
    }

    function renderList() {
        if (!alive() || !listEl) return;
        const lines = snapshot && snapshot.exists ? applyChips(snapshot.lines || []) : [];
        if (!paintPaged(lines, null)) {
            paintList(stateBlock('empty', chipsValue === 'all' ? '没有条目' : '没有符合条件的条目'));
        }
    }

    function renderHits(res) {
        if (!alive() || !listEl) return;
        const hits = applyChips(res.hitEntries || []);
        if (!paintPaged(hits, (hit) => String(hit.f || hit.r || hit.a || hit.s || ''))) {
            paintList(stateBlock('empty', '没有匹配的条目'));
        }
        // 截断由后端决定：hitEntries 数 < hitCount 才是「后端收窄」；chips 本地过滤不算截断
        const fetched = Array.isArray(res.hitEntries) ? res.hitEntries.length : 0;
        if (res.hitCount && fetched < Number(res.hitCount)) {
            listEl.appendChild(stateBlock('info', '命中 ' + res.hitCount + ' 条，仅展示前 ' + fetched + ' 条（可收窄关键词）'));
        }
    }

    function paintEmptyVolume() {
        if (!alive() || !listEl) return;
        if (statusEl) { statusEl.textContent = ''; statusEl.classList.add('hidden'); }
        let action = null;
        if (!cognitionOn()) {
            action = document.createElement('button');
            action.type = 'button';
            action.className = 'dlg-btn primary';
            action.textContent = '去设置开启';
            action.addEventListener('click', () => {
                if (typeof deps.openCognitionSettings === 'function') deps.openCognitionSettings();
            });
        }
        paintList(stateBlock('empty',
            cognitionOn()
                ? '此工作区尚未建立认知索引。已开启：可在 AI 会话中让它按目录分批建立 .cadt/cognition/ 认知卷（末批后跑 cognition_status 收基准）。'
                : '此工作区尚未建立认知索引。它是 AI 的语义层（这个文件是什么 / 改它要动谁 / 有什么暗约束），适合反复编码的工作区。',
            action));
    }

    // ---- 详情抽屉 ----

    function fieldBlock(label, value) {
        const block = document.createElement('div');
        block.className = 'cog-field';
        const head = document.createElement('div');
        head.className = 'cog-field-label';
        head.textContent = label;
        const body = document.createElement('div');
        body.className = 'cog-field-value';
        body.textContent = String(value);
        block.append(head, body);
        return block;
    }

    function entryTextOf(e) {
        const labels = Array.isArray(e.labels) && e.labels.length ? ' [' + e.labels.join(' ') + ']' : '';
        let text = String(e.path || '') + labels;
        for (const [k, v] of [['F: ', e.f], ['R: ', e.r], ['A: ', e.a], ['S: ', e.s]]) {
            if (v) text += '  ' + k + v;
        }
        return text;
    }

    async function openDetail(path) {
        const ws = workspace();
        if (!ws || !readSupported()) return;
        const seq = ++detailSeq;
        if (openDrawer) { openDrawer.close(); openDrawer = null; }
        let entry = null;
        try {
            const res = JSON.parse(await deps.backend.CognitionRead(ws, JSON.stringify({paths: [path]})));
            entry = Array.isArray(res.hitEntries) ? res.hitEntries.find((e) => String(e.path || '').replace(/\/$/, '') === String(path).replace(/\/$/, '')) : null;
        } catch (e) {
            if (seq !== detailSeq) return;
            if (typeof deps.flash === 'function') deps.flash('条目详情读取失败：' + ((e && e.message) || e), true);
            return;
        }
        // 竞态守卫：await 期间又点了别的行 → 旧响应直接丢弃；否则会遗留孤儿抽屉、泄漏 overlay handle
        if (seq !== detailSeq || !alive()) return;
        // 建新抽屉前再关一次（await 期间可能有别的 openDetail 抢先建了抽屉）
        if (openDrawer) { openDrawer.close(); openDrawer = null; }
        const body = document.createElement('div');
        body.className = 'cog-detail';
        if (!entry) {
            body.appendChild(stateBlock('empty', '没有读到该条目的正文（可能刚被其他窗口改过，刷新后重试）'));
        } else {
            const labels = Array.isArray(entry.labels) && entry.labels.length ? entry.labels : [];
            if (labels.length) {
                const tags = document.createElement('div');
                tags.className = 'cog-row-tags';
                for (const t of labels) tags.appendChild(chip(t));
                body.appendChild(tags);
            }
            if (entry.f) body.appendChild(fieldBlock('职责（F）', entry.f));
            if (entry.r) body.appendChild(fieldBlock('强关联（R）', entry.r));
            if (entry.a) body.appendChild(fieldBlock('对外契约（A）', entry.a));
            if (entry.s) body.appendChild(fieldBlock('暗约束（S）', entry.s));
            body.appendChild(copyButton(() => entryTextOf(entry), {flash: deps.flash, label: '复制条目'}));
        }
        const drawer = detailDrawer({
            title: String(path),
            onClose: () => { if (openDrawer === drawer) openDrawer = null; },
            content: body,
        });
        openDrawer = drawer;
        // 抽屉挂到不滚动的 apppage-pane（定位锚）：absolute 抽屉固定在视口，不随内层
        // .apppage-scroll 的列表内容滚走（认知索引 / 补丁库同款）
        const hostPane = hostEl && hostEl.closest('.apppage-pane');
        (hostPane || document.body).appendChild(drawer.element);
    }

    // ---- 搜索（FRAS 关键词走后端 query；空词回落 overview 本地过滤） ----

    function onSearch(v, resetPage = true) {
        lastSearch = v;
        if (resetPage) page = 1;
        const ws = workspace();
        if (!v || !snapshot || !snapshot.exists || !ws || !readSupported()) {
            searchSeq++;
            renderList();
            return;
        }
        const seq = ++searchSeq;
        paintListLoading();
        deps.backend.CognitionRead(ws, JSON.stringify({query: v})).then((raw) => {
            if (seq !== searchSeq || !alive()) return;
            renderHits(JSON.parse(raw));
        }).catch((e) => {
            if (seq !== searchSeq || !alive()) return;
            paintListError(e);
        });
    }

    // ---- 装载与骨架 ----

    async function reload() {
        const seq = ++loadSeq;
        page = 1;
        const ws = workspace();
        if (!ws) {
            snapshot = null;
            renderStatusBase();
            paintList(stateBlock('info', '认知索引按工作区生效：先打开一个工作区'));
            return;
        }
        if (!readSupported()) {
            snapshot = null;
            renderStatusBase();
            paintList(stateBlock('info', '当前版本不支持认知索引（请更新应用）'));
            return;
        }
        paintListLoading();
        try {
            const res = JSON.parse(await deps.backend.CognitionRead(ws, '{}'));
            if (seq !== loadSeq || !alive()) return;
            snapshot = res;
            renderStatusBase();
            if (!res.exists) {
                paintEmptyVolume();
                return;
            }
            renderList();
            loadStatus(ws, seq);
        } catch (e) {
            if (seq !== loadSeq || !alive()) return;
            snapshot = null;
            renderStatusBase();
            paintListError(e);
        }
    }

    function mount(host) {
        if (!host) return null;
        host.textContent = '';
        host.classList.add('cog-root');
        hostEl = host;

        const refreshBtn = iconButton({icon: 'refresh', tip: '重新读取认知索引', label: '刷新', onClick: () => reload()});
        host.appendChild(pageHeader({
            title: '认知索引',
            desc: '工作区 .cadt/cognition/ 的语义索引浏览：路径地图、条目职责 / 强关联 / 契约 / 暗约束。卷由 AI 会话维护，这里只读。',
            actions: [refreshBtn],
        }));

        statusEl = document.createElement('div');
        statusEl.className = 'cog-status hidden';
        host.appendChild(statusEl);

        const chips = filterChips({
            items: [
                {value: 'all', label: '全部'},
                {value: 'file', label: '文件'},
                {value: 'dir', label: '目录'},
            ],
            value: chipsValue,
            onChange: (v) => { chipsValue = v; page = 1; lastSearch ? onSearch(lastSearch) : renderList(); },
        });
        bar = commandBar({
            placeholder: '搜索路径、标签或职责 / 关联 / 契约 / 约束关键词',
            onSearch: (v) => onSearch(v),
            filters: [chips.element],
        });
        host.appendChild(bar.element);

        listEl = document.createElement('div');
        listEl.className = 'cog-list';
        host.appendChild(listEl);

        reload();
        return () => {
            if (bar && typeof bar.destroy === 'function') bar.destroy();
            if (openDrawer) { openDrawer.close(); openDrawer = null; }
            if (hostEl) hostEl.classList.remove('cog-root');
            host.textContent = '';
            hostEl = null;
            statusEl = null;
            listEl = null;
            bar = null;
            snapshot = null;
            searchSeq++;
            loadSeq++;
            detailSeq++;
        };
    }

    // 开关翻转 / 外部要求时的重读：未挂载时静默跳过（标签页关着就是没有宿主）
    function refresh() {
        if (!alive()) return;
        lastSearch = '';
        if (bar && typeof bar.setSearch === 'function') bar.setSearch('', false);
        reload();
    }

    return {mount, refresh};
}
