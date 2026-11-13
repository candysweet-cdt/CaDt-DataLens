// activity-pane.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// 设置页：操作记录（docs/unfinished-plans/operation-audit-log.md §6.4）
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。


export function createActivityPane(deps) {


const activityView = {entries: [], truncated: false, oldestTs: 0, loading: false};
const ACTIVITY_PAGE_SIZE = 200;

function activityFilterOf() {
    const domain = document.getElementById('activity-filter-domain');
    const actor = document.getElementById('activity-filter-actor');
    const keyword = document.getElementById('activity-filter-keyword');
    return {
        actions: domain && domain.value ? [domain.value] : [],
        actor: actor && actor.value ? actor.value : '',
        keyword: keyword ? keyword.value.trim() : '',
    };
}

async function renderActivityPane(opts = {}) {
    const listEl = document.getElementById('activity-list');
    const statusEl = document.getElementById('activity-list-status');
    const moreBtn = document.getElementById('activity-more');
    if (!listEl || activityView.loading) return;
    if (!deps.backend.ActivityRead) {
        listEl.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'activity-empty';
        empty.textContent = '当前版本不支持操作记录（旧版后端）';
        listEl.appendChild(empty);
        return;
    }
    activityView.loading = true;
    try {
        const query = {limit: ACTIVITY_PAGE_SIZE, ...activityFilterOf()};
        if (opts.append && activityView.oldestTs > 0) query.beforeTs = activityView.oldestTs;
        const parsed = JSON.parse(await deps.backend.ActivityRead(JSON.stringify(query)));
        const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
        activityView.entries = opts.append ? activityView.entries.concat(entries) : entries;
        activityView.truncated = !!parsed.truncated;
        const last = activityView.entries[activityView.entries.length - 1];
        activityView.oldestTs = last && last.ts ? last.ts : 0;
        renderActivityList(listEl);
        if (statusEl) {
            statusEl.textContent = activityView.entries.length
                ? '已加载 ' + activityView.entries.length + ' 条（新→旧）' + (activityView.truncated ? '；可能还有更早记录' : '')
                : '暂无记录（功能未开启或近期没有操作）';
        }
        if (moreBtn) moreBtn.classList.toggle('hidden', !activityView.entries.length || !activityView.truncated);
    } catch (e) {
        if (statusEl) statusEl.textContent = '读取失败：' + ((e && e.message) || e);
    } finally {
        activityView.loading = false;
    }
}

const ACTIVITY_ACTOR_LABEL = {user: '用户', ai: 'AI', system: '系统'};

function activityTimeText(ts) {
    const d = new Date(ts || 0);
    if (!d.getTime()) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function renderActivityList(listEl) {
    listEl.textContent = '';
    if (!activityView.entries.length) {
        const empty = document.createElement('div');
        empty.className = 'activity-empty';
        empty.textContent = '暂无记录';
        listEl.appendChild(empty);
        return;
    }
    const frag = document.createDocumentFragment();
    for (const entry of activityView.entries) {
        frag.appendChild(buildActivityRow(entry));
    }
    listEl.appendChild(frag);
}

function buildActivityRow(entry) {
    const row = document.createElement('div');
    row.className = 'activity-row';

    const time = document.createElement('span');
    time.className = 'act-time';
    time.textContent = activityTimeText(entry.ts);

    const badge = document.createElement('span');
    badge.className = 'act-badge act-badge-' + (ACTIVITY_ACTOR_LABEL[entry.actor] ? entry.actor : 'system');
    badge.textContent = ACTIVITY_ACTOR_LABEL[entry.actor] || '系统';

    const action = document.createElement('span');
    action.className = 'act-action';
    action.textContent = entry.action || '?';

    const target = document.createElement('span');
    target.className = 'act-target';
    target.textContent = entry.target || '';
    target.title = entry.target || '';

    row.append(time, badge, action, target);

    const detailText = entry.detail && Object.keys(entry.detail).length ? JSON.stringify(entry.detail) : '';
    if (detailText) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'act-detail-btn dlg-btn';
        toggle.textContent = '详情';
        const detail = document.createElement('div');
        detail.className = 'act-detail hidden';
        detail.textContent = detailText;
        toggle.addEventListener('click', () => {
            detail.classList.toggle('hidden');
            toggle.textContent = detail.classList.contains('hidden') ? '详情' : '收起';
        });
        row.appendChild(toggle);
        row.appendChild(detail);
    }
    return row;
}

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
if (deps.elsSettings.openActivity) {
    deps.elsSettings.openActivity.addEventListener('click', async () => {
        if (!deps.backend.ActivityPath || !deps.backend.ShowInFolder) return deps.flash('当前版本不支持', true);
        try {
            await deps.backend.ShowInFolder(await deps.backend.ActivityPath());
        } catch (e) {
            deps.flash('打开记录目录失败：' + ((e && e.message) || e), true);
        }
    });
}
if (deps.elsSettings.exportActivityJson) {
    deps.elsSettings.exportActivityJson.addEventListener('click', () => exportActivityRecords('json'));
}
if (deps.elsSettings.exportActivityCsv) {
    deps.elsSettings.exportActivityCsv.addEventListener('click', () => exportActivityRecords('csv'));
}
if (deps.elsSettings.clearActivity) {
    deps.elsSettings.clearActivity.addEventListener('click', () => {
        if (!deps.backend.ActivityClear) return deps.flash('当前版本不支持操作记录', true);
        deps.openCloseConfirm('将删除全部操作记录（包括按月分文件与滚动分段），只保留一条「已清空」标记。确定继续吗？', async () => {
            try {
                await deps.backend.ActivityClear();
                deps.flash('操作记录已清空');
                renderActivityPane();
            } catch (e) {
                deps.flash('清空失败：' + ((e && e.message) || e), true);
            }
        }, '清空', '清空操作记录');
    });
}
{
    const domainSel = document.getElementById('activity-filter-domain');
    const actorSel = document.getElementById('activity-filter-actor');
    const keywordInput = document.getElementById('activity-filter-keyword');
    const refreshBtn = document.getElementById('activity-refresh');
    const moreBtn = document.getElementById('activity-more');
    if (domainSel) domainSel.addEventListener('change', () => renderActivityPane());
    if (actorSel) actorSel.addEventListener('change', () => renderActivityPane());
    if (keywordInput) keywordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') renderActivityPane();
    });
    if (refreshBtn) refreshBtn.addEventListener('click', () => renderActivityPane());
    if (moreBtn) moreBtn.addEventListener('click', () => renderActivityPane({append: true}));
}


    return {renderActivityPane};
}
