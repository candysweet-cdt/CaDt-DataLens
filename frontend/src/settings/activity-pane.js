// activity-pane.js：操作记录页（docs/unfinished-plans/operation-audit-log.md §6.4）。
//
// 宿主：2026-11-22 起本页是「应用页面」标签页（core/app-pages.js 的 activity），
// 由 mount(host) 建骨架并绑定；设置页原内嵌位置已移除，只留两个真·设置项
// （启用开关 / 保留月数）供 settings-tree 反射。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。

import {createSelect} from '../core/form-controls.js';
import {pageHeader, commandBar, stateBlock, copyButton, relativeTime, formatFullTime} from '../app-pages/ui-kit.js';

// ===== 活动页面入口与筛选 =====
// 页面骨架：筛选栏 + 列表 + 状态 + 分页 + 记录管理动作。
// 本页现在是应用页面标签页，骨架由 mount() 直接建 DOM（分页控件要绑事件）；
// 旧的字符串骨架 activitySkeleton 已随设置页内嵌形态一起移除（零引用死代码）。
export function createActivityPane(deps) {

let hostEl = null;

// 分页状态（2026-11-22 改造：追加式「加载更早记录」→ 真分页）。
// 后端 Read 只支持 ts+seq 复合游标、没有 offset：第 N(>1) 页的游标 = 第 N-1 页最后一条，
// 因此只允许顺序翻页（±1），不做任意跳页。翻过的页缓存在 pages 里，来回翻不重复读文件；
// 筛选变化 / 刷新 / 改每页条数时整表清空并回到第 1 页。
const activityView = {
    page: 1,
    pageSize: 200,
    pages: new Map(),
    loading: false,
};
const ACTIVITY_PAGE_SIZES = [100, 200, 500]; // 后端 Read 的 limit 上限 500
// 动作域 → 中文名（列表显示中文，导出仍保留原始 action）
const ACTIVITY_ACTION_LABEL = {
    file: '文件', tab: '标签页', workspace: '工作区', view: '视图',
    settings: '设置', plugin: '插件', ai: 'AI', app: '应用',
    storage: '存储', activity: '记录',
};

function node(id) {
    return hostEl ? hostEl.querySelector('#' + id) : document.getElementById(id);
}

function activityFilterOf() {
    const domain = node('activity-filter-domain');
    const actor = node('activity-filter-actor');
    const keyword = node('activity-filter-keyword');
    return {
        actions: domain && domain.value ? [domain.value] : [],
        actor: actor && actor.value ? actor.value : '',
        keyword: keyword ? keyword.value.trim() : '',
    };
}

// 取一页数据：命中缓存直接返回；第 1 页无游标，第 N>1 页用第 N-1 页末条做 ts+seq 游标。
// 返回 null 表示「上一页不在缓存里」（只可能出现在竞态/异常路径），调用方回退第 1 页。
async function fetchActivityPage(page) {
    const cached = activityView.pages.get(page);
    if (cached) return cached;
    let cursor = null;
    if (page > 1) {
        const prev = activityView.pages.get(page - 1);
        const last = prev && prev.entries.length ? prev.entries[prev.entries.length - 1] : null;
        if (!last) return null;
        cursor = {ts: last.ts || 0, seq: last.seq || 0};
    }
    const query = {limit: activityView.pageSize, ...activityFilterOf()};
    if (cursor && cursor.ts > 0) {
        query.beforeTs = cursor.ts;
        // 复合游标：同毫秒多条时按 seq 精确切页，不重复/不漏
        if (cursor.seq > 0) query.beforeSeq = cursor.seq;
    }
    const parsed = JSON.parse(await deps.backend.ActivityRead(JSON.stringify(query)));
    const data = {
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        truncated: !!parsed.truncated,
    };
    activityView.pages.set(page, data);
    return data;
}

// ===== 分页与导航 =====
function activityStatusText(data) {
    if (!data || !data.entries.length) return '暂无记录（功能未开启或近期没有操作）';
    return '本页 ' + data.entries.length + ' 条（新→旧）· ' + (data.truncated ? '还有更早记录' : '已到最早');
}

// 分页控件状态：页码文字、上一页/下一页可用性、每页条数回填。
function paintPager(data) {
    const info = node('activity-page-info');
    const first = node('activity-page-first');
    const prev = node('activity-page-prev');
    const next = node('activity-page-next');
    const size = node('activity-page-size');
    if (info) info.textContent = '第 ' + activityView.page + ' 页';
    if (first) first.disabled = activityView.page <= 1;
    if (prev) prev.disabled = activityView.page <= 1;
    if (next) next.disabled = !data || !data.truncated;
    if (size && size.value !== String(activityView.pageSize)) size.value = String(activityView.pageSize);
}

// 切页后把滚动容器拉回顶部：日志列表很长，留在原位会看不到新页的第一条。
function scrollActivityTop() {
    let el = hostEl;
    while (el && el !== document.body) {
        if (el.scrollHeight > el.clientHeight + 4) {
            el.scrollTop = 0;
            return;
        }
        el = el.parentElement;
    }
}

function gotoActivityPage(page) {
    if (page < 1 || activityView.loading) return;
    activityView.page = page;
    scrollActivityTop();
    void renderActivityPane();
}

// ===== 列表渲染 =====
// 渲染当前页。opts.reset=true 表示筛选条件/刷新变化：清空所有缓存页并回到第 1 页。
async function renderActivityPane(opts = {}) {
    const listEl = node('activity-list');
    const statusEl = node('activity-list-status');
    if (!listEl || activityView.loading) return;
    if (opts.reset) {
        activityView.page = 1;
        activityView.pages.clear();
    }
    if (!deps.backend.ActivityRead) {
        listEl.textContent = '';
        listEl.appendChild(stateBlock('info', '当前版本不支持操作记录（旧版后端）'));
        if (statusEl) statusEl.textContent = '';
        paintPager(null);
        return;
    }
    activityView.loading = true;
    try {
        let data = await fetchActivityPage(activityView.page);
        if (!data) {
            // 上一页已不在缓存（竞态）：退回第 1 页重取
            activityView.page = 1;
            activityView.pages.clear();
            data = await fetchActivityPage(1);
        }
        renderActivityList(listEl, data.entries);
        paintPager(data);
        if (statusEl) statusEl.textContent = activityStatusText(data);
    } catch (e) {
        listEl.textContent = '';
        listEl.appendChild(stateBlock('error', '读取失败：' + ((e && e.message) || e)));
        if (statusEl) statusEl.textContent = '';
        paintPager(null);
    } finally {
        activityView.loading = false;
    }
}

const ACTIVITY_ACTOR_LABEL = {user: '用户', ai: 'AI', system: '系统'};

// ===== 详情构造 =====
function actionLabel(action) {
    const text = String(action || '');
    const domain = text.split('.')[0];
    const zh = ACTIVITY_ACTION_LABEL[domain];
    return zh ? zh + ' · ' + text.slice(domain.length + 1) : text;
}

// 格式化 detail：逐行缩进的 JSON（键值着色交给 CSS），替代裸 JSON.stringify 撑乱 flex 行。
function formatDetail(detail) {
    if (!detail || typeof detail !== 'object' || !Object.keys(detail).length) return '';
    try { return JSON.stringify(detail, null, 2); } catch (e) { return String(detail); }
}

function renderActivityList(listEl, entries) {
    listEl.textContent = '';
    if (!entries.length) {
        listEl.appendChild(stateBlock('empty', '暂无记录（功能未开启或近期没有操作）'));
        return;
    }
    const frag = document.createDocumentFragment();
    let lastDay = '';
    for (const entry of entries) {
        const day = new Date(entry.ts || 0).toLocaleDateString();
        if (day !== lastDay) {
            lastDay = day;
            const group = document.createElement('div');
            group.className = 'act-day-group';
            group.textContent = day;
            frag.appendChild(group);
        }
        frag.appendChild(buildActivityRow(entry));
    }
    listEl.appendChild(frag);
}

// 整条记录的 JSON 快照：复制按钮用它（2026-11-22 用户要求「复制整条」，而不是只复制参数）。
// 字段与「导出 JSON」同源（ts / actor / action / target / detail），额外给一份可读时间，
// 粘到别处既能直接读、也保留时间戳；内部字段 v / seq 不输出。
function activityEntryJson(entry) {
    const record = {
        ts: Number(entry.ts) || 0,
        time: formatFullTime(entry.ts),
        actor: String(entry.actor || ''),
        action: String(entry.action || ''),
        target: String(entry.target || ''),
    };
    if (entry.detail && typeof entry.detail === 'object' && Object.keys(entry.detail).length) {
        record.detail = entry.detail;
    }
    try {
        return JSON.stringify(record, null, 2);
    } catch (e) {
        return String(record.target || '');
    }
}

// 展开区内容：对象全文 + 参数 JSON 分两段。对象列在窄内容区会被省略号截断，
// 只靠 hover tooltip 读全文太别扭（2026-11-22 用户反馈），展开后两段都能读。
function buildDetailBody(entry, targetText, detailText) {
    const wrap = document.createElement('div');
    wrap.className = 'act-detail hidden';
    const addSection = (label, text, mono) => {
        const sec = document.createElement('div');
        sec.className = 'act-detail-sec';
        const head = document.createElement('div');
        head.className = 'act-detail-label';
        head.textContent = label;
        const body = document.createElement('pre');
        body.className = 'act-detail-text' + (mono ? ' act-detail-mono' : '');
        body.textContent = text;
        sec.append(head, body);
        wrap.appendChild(sec);
    };
    if (targetText) addSection('对象', targetText, false);
    if (detailText) addSection('详情', detailText, true);
    return wrap;
}

function buildActivityRow(entry) {
    const row = document.createElement('div');
    row.className = 'activity-row';

    const time = document.createElement('span');
    time.className = 'act-time';
    time.textContent = relativeTime(entry.ts);
    time.dataset.tip = formatFullTime(entry.ts);

    const badge = document.createElement('span');
    badge.className = 'act-badge act-badge-' + (ACTIVITY_ACTOR_LABEL[entry.actor] ? entry.actor : 'system');
    badge.textContent = ACTIVITY_ACTOR_LABEL[entry.actor] || '系统';

    const action = document.createElement('span');
    action.className = 'act-action';
    action.textContent = actionLabel(entry.action);
    action.dataset.tip = entry.action || '';

    const targetText = String(entry.target || '');
    const target = document.createElement('span');
    target.className = 'act-target';
    target.textContent = targetText;
    target.dataset.tip = targetText;

    row.append(time, badge, action, target);

    const detailText = formatDetail(entry.detail);
    // 复制钮每行都有（2026-11-22 用户要求：没有参数、对象又短的行也要能复制整条记录）；
    // 展开钮只在内容可能被截断时给——有参数，或对象长到基本必然被省略号截断（>32 字符）。
    // 操作按钮包进一个格子（grid 第 5 列），否则详情钮+复制钮各占一列会挤掉对齐：
    // 只有 5 个子元素的行，若直接 append 两个按钮会变成 7 个，复制钮掉到下一行。
    const ops = document.createElement('span');
    ops.className = 'act-ops';
    const copyBtn = copyButton(() => activityEntryJson(entry), {flash: deps.flash, tip: '复制整条记录（JSON）'});
    // 详情钮**每行都渲染**（2026-11-23 用户要求）：行内结构一致，两个按钮才能在所有行
    // 落在同一列、同一水平位置。内容不会被截断的行把它留成占位（CSS .is-empty 隐形），
    // 既不参与交互也不造成参差——此前「有内容才给详情钮」会让复制钮在有/无详情钮的行
    // 之间左右跳动，窄容器下更明显。
    const detailTextAvailable = Boolean(detailText) || targetText.length > 32;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'act-detail-btn dlg-btn';
    toggle.dataset.tip = '展开 / 收起对象与详情';
    toggle.textContent = '详情';
    const detail = buildDetailBody(entry, targetText, detailText);
    if (detailTextAvailable) {
        toggle.addEventListener('click', () => {
            const hidden = detail.classList.toggle('hidden');
            toggle.textContent = hidden ? '详情' : '收起';
        });
    } else {
        toggle.classList.add('is-empty');
        toggle.disabled = true;
        toggle.tabIndex = -1;
        toggle.setAttribute('aria-hidden', 'true');
    }
    ops.append(toggle, copyBtn);
    row.append(ops, detail);
    return row;
}

// ===== 导出与目录 =====
function activityExportQuery() {
    return {limit: 500, ...activityFilterOf()};
}

function activityCsvCell(value) {
    const text = String(value == null ? '' : value);
    return '"' + text.replace(/"/g, '""') + '"';
}

async function exportActivityRecords(kind) {
    if (!deps.backend.ActivityRead) return deps.flash('当前版本不支持操作记录', true);
    if (!deps.backend.SaveFileDialog || !deps.backend.SaveFile) return deps.flash('当前版本不支持导出', true);
    try {
        const parsed = JSON.parse(await deps.backend.ActivityRead(JSON.stringify(activityExportQuery())));
        const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
        if (!entries.length) return deps.flash('没有可导出的记录（当前筛选条件下）', true);
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        if (kind === 'csv') {
            const rows = [['时间', '来源', '判定来源', '动作', '对象', '详情']];
            for (const e of entries) {
                rows.push([
                    new Date(e.ts || 0).toLocaleString(),
                    ACTIVITY_ACTOR_LABEL[e.actor] || e.actor || '',
                    e.source || '',
                    e.action || '',
                    e.target || '',
                    e.detail && Object.keys(e.detail).length ? JSON.stringify(e.detail) : '',
                ]);
            }
            const csv = '\ufeff' + rows.map((row) => row.map(activityCsvCell).join(',')).join('\r\n');
            const path = await deps.backend.SaveFileDialog('activity-' + stamp + '.csv');
            if (path) await deps.backend.SaveFile(path, csv, 'crlf', true, 'utf-8');
        } else {
            const json = JSON.stringify({exportedAt: Date.now(), count: entries.length, entries}, null, 2);
            const path = await deps.backend.SaveFileDialog('activity-' + stamp + '.json');
            if (path) await deps.backend.SaveFile(path, json, 'lf', false, 'utf-8');
        }
        deps.flash('已导出 ' + entries.length + ' 条记录');
    } catch (e) {
        deps.flash('导出失败：' + ((e && e.message) || e), true);
    }
}

// 两个真·设置项留在设置页：控件在 index.html 的 .settings-pane[data-pane="activity"] 里，
// 由 settings-tree 反射成可写行（opt-activity-log / opt-activity-retention）。
if (deps.elsSettings.activityLog) {
    deps.elsSettings.activityLog.addEventListener('change', () => {
        deps.settings.activityLog = deps.elsSettings.activityLog.checked;
        deps.applySettings();
        deps.flash(deps.settings.activityLog ? '操作记录已开启' : '操作记录已关闭，不再新增记录');
    });
}
if (deps.elsSettings.activityRetention) {
    deps.elsSettings.activityRetention.addEventListener('change', () => {
        const n = Math.round(Number(deps.elsSettings.activityRetention.value) || 12);
        deps.settings.activityRetentionMonths = Math.min(60, Math.max(1, n));
        deps.applySettings();
    });
}

function openActivityDir() {
    if (!deps.backend.ActivityPath || !deps.backend.ShowInFolder) return deps.flash('当前版本不支持', true);
    Promise.resolve(deps.backend.ActivityPath()).then((dir) => deps.backend.ShowInFolder(dir))
        .catch((e) => deps.flash('打开记录目录失败：' + ((e && e.message) || e), true));
}

// ===== 记录管理与挂载 =====
function clearActivity() {
    if (!deps.backend.ActivityClear) return deps.flash('当前版本不支持操作记录', true);
    deps.openConfirmDialog('将删除全部操作记录（包括按月分文件与滚动分段），只保留一条「已清空」标记。确定继续吗？', async () => {
        try {
            await deps.backend.ActivityClear();
            deps.flash('操作记录已清空');
            renderActivityPane();
        } catch (e) {
            deps.flash('清空失败：' + ((e && e.message) || e), true);
        }
    }, '清空', '清空操作记录', 'danger');
}

// 分页按钮工厂：紧凑尺寸（.dlg-btn 默认 min-width:84px 会把三个按钮撑得过宽）
function pagerButton(id, label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dlg-btn';
    btn.id = id;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
}

// 挂到宿主容器（应用页面标签页调用）：建骨架 → 按 id 在宿主内绑定 → 首次渲染。
// 返回卸载函数：摘掉监听并清空缓存，避免关标签后状态与 DOM 一起泄漏。
function mount(host) {
    if (!host) return null;
    host.textContent = '';

    // 页头：主操作区 = 去设置 / 打开目录 / 导出 JSON / 导出 CSV / 清空
    const goSettings = document.createElement('button');
    goSettings.type = 'button';
    goSettings.className = 'dlg-btn';
    goSettings.dataset.tip = '启用开关与保留月数仍在 设置 → 通用 → 操作记录';
    goSettings.textContent = '去设置';
    if (typeof deps.openActivitySettings === 'function') {
        goSettings.addEventListener('click', () => deps.openActivitySettings());
    } else {
        goSettings.classList.add('hidden');
    }
    const openDirBtn = document.createElement('button');
    openDirBtn.type = 'button';
    openDirBtn.className = 'dlg-btn';
    openDirBtn.textContent = '打开目录';
    openDirBtn.addEventListener('click', openActivityDir);
    const exportJsonBtn = document.createElement('button');
    exportJsonBtn.type = 'button';
    exportJsonBtn.className = 'dlg-btn';
    exportJsonBtn.textContent = '导出 JSON';
    exportJsonBtn.addEventListener('click', () => exportActivityRecords('json'));
    const exportCsvBtn = document.createElement('button');
    exportCsvBtn.type = 'button';
    exportCsvBtn.className = 'dlg-btn';
    exportCsvBtn.textContent = '导出 CSV';
    exportCsvBtn.addEventListener('click', () => exportActivityRecords('csv'));
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'dlg-btn';
    clearBtn.textContent = '清空…';
    clearBtn.addEventListener('click', clearActivity);
    host.appendChild(pageHeader({
        title: '操作记录',
        desc: '用户与 AI 的操作留痕（只记摘要，不记文件内容）。筛选后导出与列表同源。',
        actions: [goSettings, openDirBtn, exportJsonBtn, exportCsvBtn, clearBtn],
    }));

    // 命令栏：动作域 / 来源下拉 + 关键字搜索（防抖 200ms）+ 清空筛选
    const domainCtl = createSelect({
        id: 'activity-filter-domain',
        options: [['', '全部动作'], ['file', '文件'], ['tab', '标签页'], ['workspace', '工作区'], ['view', '视图'], ['settings', '设置'], ['plugin', '插件'], ['ai', 'AI'], ['app', '应用'], ['storage', '存储'], ['activity', '记录管理']]
            .map(([value, label]) => ({value, label})),
    }).control;
    const actorCtl = createSelect({
        id: 'activity-filter-actor',
        options: [['', '全部来源'], ['user', '用户'], ['ai', 'AI'], ['system', '系统']]
            .map(([value, label]) => ({value, label})),
    }).control;
    const clearFilterBtn = document.createElement('button');
    clearFilterBtn.type = 'button';
    clearFilterBtn.className = 'dlg-btn';
    clearFilterBtn.dataset.tip = '清除全部筛选条件';
    clearFilterBtn.textContent = '清除筛选';
    clearFilterBtn.addEventListener('click', () => {
        domainCtl.value = '';
        actorCtl.value = '';
        bar.setSearch('', true);
    });
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'dlg-btn';
    refreshBtn.textContent = '刷新';
    refreshBtn.addEventListener('click', () => renderActivityPane({reset: true}));
    const bar = commandBar({
        placeholder: '关键字（动作 / 对象 / 详情）',
        onSearch: () => renderActivityPane({reset: true}),
        filters: [domainCtl, actorCtl, clearFilterBtn, refreshBtn],
    });
    // commandBar 自己带搜索框；给隐藏的旧 keyword input 一个 id 兼容 activityFilterOf
    bar.input.id = 'activity-filter-keyword';
    host.appendChild(bar.element);

    // 表头 + 列表 + 状态 + 分页
    const head = document.createElement('div');
    head.className = 'act-thead';
    for (const label of ['时间', '来源', '动作', '对象', '详情']) {
        const cell = document.createElement('span');
        cell.textContent = label;
        head.appendChild(cell);
    }
    host.appendChild(head);
    const listEl = document.createElement('div');
    listEl.className = 'activity-list';
    listEl.id = 'activity-list';
    host.appendChild(listEl);
    const statusEl = document.createElement('div');
    statusEl.className = 'act-status';
    statusEl.id = 'activity-list-status';
    host.appendChild(statusEl);

    // 分页条：每页条数 + 最新 / 上一页 / 页码 / 下一页（替代追加式「加载更早记录」）
    const pager = document.createElement('div');
    pager.className = 'act-pager';
    const pageSizeCtl = createSelect({
        id: 'activity-page-size',
        options: ACTIVITY_PAGE_SIZES.map((n) => ({value: String(n), label: n + ' 条/页'})),
        value: String(activityView.pageSize),
        title: '每页条数',
    }).control;
    // 增强后 wrap 继承这个类（settings-select.js 的 wrap.className 拷贝原 select 的布局类）：
    // .set-select-btn 默认 30px 高，要压到与 24px 分页按钮齐平
    pageSizeCtl.classList.add('act-page-size');
    pageSizeCtl.addEventListener('change', () => {
        const size = Number(pageSizeCtl.value) || ACTIVITY_PAGE_SIZES[0];
        activityView.pageSize = size;
        activityView.page = 1;
        activityView.pages.clear();
        void renderActivityPane();
    });
    // 「最新」不是回缓存的第 1 页，而是清缓存重取——深翻一段时间后点它要看到新记录
    const firstBtn = pagerButton('activity-page-first', '最新', () => {
        scrollActivityTop();
        void renderActivityPane({reset: true});
    });
    firstBtn.dataset.tip = '回到第 1 页并重新读取最新记录';
    const prevBtn = pagerButton('activity-page-prev', '上一页', () => gotoActivityPage(activityView.page - 1));
    const pageInfo = document.createElement('span');
    pageInfo.className = 'act-page-info';
    pageInfo.id = 'activity-page-info';
    pageInfo.textContent = '第 1 页';
    const nextBtn = pagerButton('activity-page-next', '下一页', () => gotoActivityPage(activityView.page + 1));
    pager.append(pageSizeCtl, firstBtn, prevBtn, pageInfo, nextBtn);
    host.appendChild(pager);

    hostEl = host;
    domainCtl.addEventListener('change', () => renderActivityPane({reset: true}));
    actorCtl.addEventListener('change', () => renderActivityPane({reset: true}));
    renderActivityPane();
    return () => {
        if (typeof bar.destroy === 'function') bar.destroy();
        hostEl = null;
        activityView.page = 1;
        activityView.pages.clear();
    };
}

    return {mount, renderActivityPane};
}
