// ai-schedule.js：定时任务域（设置页任务列表/编辑器 + sched-fire 触发执行与多窗口认领）。
// 从 ai-panel.js 拆出（docs/unfinished-plans/structure-cleanup.md 阶段 3），函数体逐字搬移；
// sessions 为重赋值 let 且模块内只读，经 getSessions() 访问。
import {iconSvg} from '../../core/icons.js';
import {createInput, createSelect, createTextarea} from '../../core/form-controls.js';
import {pageHeader, commandBar, filterChips, statusBadge, stateBlock, relativeTime} from '../../app-pages/ui-kit.js';
import {describeAISchedule, aiFormatLocalMs, aiClampInt, aiTextOf} from '../core/ai-constants.js';
import {kvGet, kvSet} from '../../core/kv-store.js';

export function createAISchedule(ctx) {
    const opt = ctx.opt;
    const el = ctx.el;
    const backend = ctx.backend;
    const flash = ctx.flash;
    const notifyFailure = typeof ctx.notifyFailure === 'function' ? ctx.notifyFailure : () => {};
    const askConfirm = ctx.askConfirm;
    const openAIDialog = ctx.openAIDialog;
    const closeAIDialog = ctx.closeAIDialog;
    const dialogButton = ctx.dialogButton;
    const enhanceSelect = typeof ctx.enhanceSelect === 'function' ? ctx.enhanceSelect : null;
    const sessionTitleById = ctx.sessionTitleById;
    const sessionActivity = ctx.sessionActivity;
    const currentSession = ctx.currentSession;
    const getSessions = ctx.getSessions;
    const open = ctx.open;
    const newSession = ctx.newSession;
    const persistSessions = ctx.persistSessions;
    const renderSessionList = ctx.renderSessionList;
    const switchSession = ctx.switchSession;
    const streamOf = ctx.streamOf;
    const compactOf = ctx.compactOf;
    const sendAppMessage = ctx.sendAppMessage;
    // 会话信箱（阶段 I）：定时任务改成「一个通知发送方」——与子代理结算走同一条注入管道
    const deliverAgentNotice = typeof ctx.deliverAgentNotice === 'function' ? ctx.deliverAgentNotice : null;
    // 打开定时任务管理的统一出口（虚拟标签页改造后开应用页面标签页，悬浮窗降级回对话框）
    const openSchedulesPage = typeof ctx.openSchedulesPage === 'function' ? ctx.openSchedulesPage : null;

    // ---- 应用页面：定时任务（core/app-pages.js 的 schedules）----
    // host 由应用页面标签页传入（视图工厂 bridge-app-page-view 调 mount）；
    // 不传时优先用「当前已挂载的列表容器」——AI 的 schedule_* 工具在 CRUD 后调
    // renderScheduleSettings() 要能刷新正在看的那个标签页，否则只能看见陈旧列表。

    let mountedList = null;

    function renderScheduleSettings(host) {
        const target = host || mountedList || opt.schedules;
        if (!target) return;
        // 列表渲染顺带刷新头部胶囊与弹层缓存（CRUD 工具与手动操作都汇到这条路径）
        refreshSchedulesUI();
        if (!backend.AIScheduleList) {
            target.innerHTML = '';
            const empty = document.createElement('span');
            empty.className = 'ai-pref-empty';
            empty.textContent = '（当前版本不支持定时任务）';
            target.appendChild(empty);
            return;
        }
        Promise.resolve(backend.AIScheduleList()).then((list) => {
            if (!target.isConnected) return;
            schedCache = Array.isArray(list) ? list : [];
            target.innerHTML = '';
            // 应用页表格容器走筛选/表格行；弹层与对话框仍用窄列表行
            if (target.classList.contains('ap-sched-table')) {
                paintScheduleTable(target);
                return;
            }
            if (!schedCache.length) {
                const empty = document.createElement('span');
                empty.className = 'ai-pref-empty';
                empty.textContent = '（暂无任务）';
                target.appendChild(empty);
                return;
            }
            for (const s of schedCache) {
                target.appendChild(renderScheduleRow(s));
            }
        }).catch((e) => {
            if (target.isConnected) target.textContent = '加载失败：' + ((e && e.message) || e);
        });
    }

    // 应用页面列表的筛选状态（仅影响页面表格，不碰胶囊/弹层的「当前会话」口径）
    let schedFilter = {status: 'all', keyword: ''};
    let schedCache = []; // 最近一次 AIScheduleList 结果，供前端筛选复用

    // 应用页表格行：列对齐（任务 / 类型+排程 / 下次触发 / 目标会话 / 状态 / 操作），
    // 与弹层/对话框共用的 renderScheduleRow 分开——那行是窄列表，本行是宽表格。
    function renderScheduleTableRow(s) {
        const row = document.createElement('div');
        row.className = 'ap-sched-row' + (s.enabled ? '' : ' disabled');
        const kindLabel = s.kind === 'once' ? '单次' : (s.kind === 'interval' ? '循环' : 'cron');
        const scopeBadge = statusBadge(s.scope, s.scope === 'edit' ? 'warn' : 'neutral');
        const target = s.sessionId
            ? (sessionTitleById(s.sessionId) || s.sessionId.slice(0, 8))
            : '每次新建';
        const status = statusBadge(s.enabled ? '启用' : '停用', s.enabled ? 'success' : 'neutral');
        const nextText = s.nextRunAt ? relativeTime(s.nextRunAt) : '—';
        const cells = [
            {cls: 'ap-sched-name', text: s.name},
            {cls: 'ap-sched-kind', text: kindLabel + ' · ' + describeAISchedule(s).replace(/^[^·]+·\s*/, '')},
            {cls: 'ap-sched-next', text: nextText},
            {cls: 'ap-sched-target', text: target},
        ];
        for (const c of cells) {
            const el = document.createElement('span');
            el.className = c.cls;
            el.textContent = c.text;
            el.dataset.tip = c.text;
            row.appendChild(el);
        }
        const scopeCell = document.createElement('span');
        scopeCell.className = 'ap-sched-scope';
        scopeCell.appendChild(scopeBadge);
        row.appendChild(scopeCell);
        row.appendChild(status);
        const actions = document.createElement('span');
        actions.className = 'ap-sched-actions';
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'dlg-icon-btn';
        toggle.dataset.tip = s.enabled ? '暂停任务' : '启用任务';
        toggle.setAttribute('aria-label', toggle.dataset.tip);
        toggle.innerHTML = iconSvg(s.enabled ? 'pause' : 'play', 13);
        toggle.addEventListener('click', () => {
            Promise.resolve(backend.AIScheduleToggle(s.id, !s.enabled)).then(() => {
                renderScheduleSettings();
                flash((s.enabled ? '已停用：' : '已启用：') + s.name);
            }).catch((e) => flash('操作失败：' + ((e && e.message) || e), true));
        });
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'dlg-icon-btn';
        edit.dataset.tip = '编辑任务';
        edit.setAttribute('aria-label', '编辑任务');
        edit.innerHTML = iconSvg('rename', 13);
        edit.addEventListener('click', () => openScheduleEditor(s));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'dlg-icon-btn ap-icon-btn-danger';
        remove.dataset.tip = '删除任务';
        remove.setAttribute('aria-label', '删除任务');
        remove.innerHTML = iconSvg('trash', 13);
        remove.addEventListener('click', () => {
            askConfirm('删除定时任务「' + s.name + '」？', () => {
                Promise.resolve(backend.AIScheduleDelete(s.id)).then(() => {
                    renderScheduleSettings();
                    flash('已删除定时任务：' + s.name);
                }).catch((e) => flash('删除失败：' + ((e && e.message) || e), true));
            });
        });
        actions.append(toggle, edit, remove);
        row.appendChild(actions);
        return row;
    }

    // 按筛选条件过滤应用页列表
    function filteredSchedules() {
        return schedCache.filter((s) => {
            if (schedFilter.status === 'enabled' && !s.enabled) return false;
            if (schedFilter.status === 'disabled' && s.enabled) return false;
            if (schedFilter.keyword) {
                const hay = (s.name + ' ' + (s.prompt || '') + ' ' + describeAISchedule(s)).toLowerCase();
                if (!hay.includes(schedFilter.keyword.toLowerCase())) return false;
            }
            return true;
        });
    }

    function paintScheduleTable(listEl) {
        if (!listEl) return;
        listEl.textContent = '';
        const rows = filteredSchedules();
        if (!rows.length) {
            const cta = document.createElement('button');
            cta.type = 'button';
            cta.className = 'dlg-btn primary';
            cta.textContent = '新建第一个任务';
            cta.addEventListener('click', () => openScheduleEditor(null, {top: true}));
            listEl.appendChild(stateBlock('empty', schedCache.length ? '没有符合条件的任务' : '还没有定时任务。设一个到点提醒，AI 会自动唤醒并干活。', cta));
            return;
        }
        for (const s of rows) listEl.appendChild(renderScheduleTableRow(s));
    }

    // 应用页面标签页的挂载入口：页头 + 命令栏 + 表格式列表 + 事件订阅。
    function mountSchedules(host) {
        if (!host) return null;
        host.textContent = '';
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'dlg-btn primary';
        addBtn.textContent = '新建任务';
        addBtn.addEventListener('click', () => openScheduleEditor(null, {top: true}));
        host.appendChild(pageHeader({
            title: '定时任务',
            desc: '单次 / 固定间隔 / cron 自动唤醒 AI。仅在应用运行期间有效；关闭后挂起，错过的任务不补跑。',
            actions: [addBtn],
        }));

        const chips = filterChips({
            items: [
                {value: 'all', label: '全部'},
                {value: 'enabled', label: '启用中'},
                {value: 'disabled', label: '已停用'},
            ],
            value: schedFilter.status,
            onChange: (v) => { schedFilter.status = v; paintScheduleTable(listEl); },
        });
        const bar = commandBar({
            placeholder: '搜索名称、指令或排程',
            onSearch: (v) => { schedFilter.keyword = v; paintScheduleTable(listEl); },
            filters: [chips.element],
        });
        host.appendChild(bar.element);

        const head = document.createElement('div');
        head.className = 'ap-sched-thead';
        for (const label of ['任务', '排程', '下次触发', '目标会话', '权限', '状态', '操作']) {
            const cell = document.createElement('span');
            cell.textContent = label;
            head.appendChild(cell);
        }
        host.appendChild(head);
        const listEl = document.createElement('div');
        listEl.className = 'ap-sched-table';
        host.appendChild(listEl);
        mountedList = listEl;

        // 跨窗口/工具 CRUD 后的刷新由 main.js 的 schedules-changed 订阅统一驱动
        // （refreshScheduleSettings 会传 mountedList，即本标签页的 listEl）。
        renderScheduleSettings(listEl);
        return () => {
            if (typeof bar.destroy === 'function') bar.destroy();
            if (mountedList === listEl) mountedList = null;
        };
    }

    // ---- 头部定时任务胶囊与弹层（kind=schedules，与计时器胶囊同机制） ----
    // 胶囊 = 当前会话口径：只显示/统计绑定当前会话的启用任务；
    // 其他会话与未绑定任务在「自动化」对话框与设置页可见。
    // 列表缓存一份供弹层同步渲染（避免异步填充把弹层定位撑偏）。
    let scheduleListCache = [];

    function chipEl() {
        return ctx.chipSchedules || null;
    }

    // 胶囊 = 当前会话口径（与计时胶囊一致）：只显示/统计绑定当前会话的启用任务；
    // 其他会话与未绑定任务在「自动化」对话框与设置页可见。
    function currentSessionTasks() {
        const sid = typeof ctx.getSessionId === 'function' ? ctx.getSessionId() : '';
        return scheduleListCache.filter((s) => s && s.enabled && s.sessionId && s.sessionId === sid);
    }

    // 胶囊 DOM 按缓存同步刷新（无后端往返）：显隐与角标都是「绑定当前会话」口径，
    // 切会话走 syncChip 原位重算，不残留上一个会话的任务数。
    function updateChipFromCache() {
        const chip = chipEl();
        if (!chip) return;
        const mine = currentSessionTasks();
        chip.classList.toggle('hidden', !mine.length);
        const countEl = chip.querySelector('.ai-chip-count');
        if (countEl) {
            countEl.textContent = String(mine.length);
            countEl.classList.toggle('hidden', !mine.length);
        }
        const iconEl = chip.querySelector('.ai-chip-icon');
        if (iconEl && !iconEl.dataset.ready) {
            iconEl.dataset.ready = '1';
            iconEl.innerHTML = iconSvg('clock', 12);
        }
    }

    function refreshSchedulesUI(onReady) {
        if (!backend.AIScheduleList) return;
        Promise.resolve(backend.AIScheduleList()).then((list) => {
            scheduleListCache = Array.isArray(list) ? list : [];
            updateChipFromCache();
            // 弹层开着时原位重渲染（重新定位）
            if (typeof ctx.onSchedulesChanged === 'function') ctx.onSchedulesChanged();
            if (typeof onReady === 'function') onReady(scheduleListCache);
        }).catch(() => {
            // 列表读取失败：胶囊回退隐藏（设置页打开时已有错误呈现）
            const chip = chipEl();
            if (chip) chip.classList.add('hidden');
        });
    }

    function renderChip() {
        refreshSchedulesUI();
    }

    // 切会话时的胶囊同步（syncActiveSessionUI 调用）：只按缓存重算显隐/角标，不拉后端。
    // 定时任务只在 CRUD 与触发时变化，那些路径都会先过 refreshSchedulesUI 更新缓存。
    function syncChip() {
        updateChipFromCache();
    }

    // 头部胶囊点击开关弹层（chip 是静态 DOM，工厂时接线一次；与计时胶囊 ai-timer.js 同款）
    const schedChip = chipEl();
    if (schedChip && typeof ctx.togglePop === 'function') {
        schedChip.addEventListener('click', () => ctx.togglePop(schedChip));
    }

    // 弹层（胶囊点开）：只列绑定**当前会话**的启用任务（与胶囊口径一致）；
    // 其他任务在「自动化」对话框与设置页。行点击进编辑器，底部新建与全部管理入口。
    function renderSchedulePop(host) {
        if (!host) return;
        host.textContent = '';
        const title = document.createElement('div');
        title.className = 'ai-chips-pop-title';
        title.textContent = '本会话的定时任务';
        host.appendChild(title);
        refreshSchedulesUI();
        const sorted = currentSessionTasks();
        for (const s of sorted) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'ai-chips-row';
            const badge = document.createElement('span');
            badge.className = 'ai-sched-badge' + (s.enabled ? ' on' : '');
            badge.textContent = s.enabled ? '启用' : '停用';
            const main = document.createElement('span');
            main.className = 'ai-chips-main';
            const nameSpan = document.createElement('span');
            nameSpan.className = 'ai-chips-name';
            nameSpan.textContent = s.name || s.id;
            const subSpan = document.createElement('span');
            subSpan.className = 'ai-chips-sub';
            subSpan.textContent = describeAISchedule(s);
            main.append(nameSpan, subSpan);
            row.append(badge, main);
                        row.addEventListener('click', () => {
                if (typeof ctx.hideChipsPop === 'function') ctx.hideChipsPop();
                openScheduleEditor(s);
            });
            host.appendChild(row);
        }
        if (!sorted.length) {
            const empty = document.createElement('div');
            empty.className = 'ai-chips-empty';
            empty.textContent = '本会话暂无定时任务';
            host.appendChild(empty);
        }
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'ai-chips-row ai-timer-back';
        const addIco = document.createElement('span');
        addIco.className = 'ai-chips-go';
        addIco.innerHTML = iconSvg('plus', 12);
        const addLabel = document.createElement('span');
        addLabel.className = 'ai-chips-name';
        addLabel.textContent = '新建任务…';
        addBtn.append(addIco, addLabel);
        addBtn.addEventListener('click', () => {
            if (typeof ctx.hideChipsPop === 'function') ctx.hideChipsPop();
            openScheduleEditor(null);
        });
        host.appendChild(addBtn);
        const manageBtn = document.createElement('button');
        manageBtn.type = 'button';
        manageBtn.className = 'ai-chips-row ai-timer-back';
        const manageIco = document.createElement('span');
        manageIco.className = 'ai-chips-go';
        manageIco.innerHTML = iconSvg('chevron-right', 12);
        const manageLabel = document.createElement('span');
        manageLabel.className = 'ai-chips-name';
        manageLabel.textContent = '全部管理…';
        manageBtn.append(manageIco, manageLabel);
        manageBtn.addEventListener('click', () => {
            if (typeof ctx.hideChipsPop === 'function') ctx.hideChipsPop();
            if (openSchedulesPage) openSchedulesPage();
            else if (typeof ctx.openSettings === 'function') ctx.openSettings('schedules');
        });
        host.appendChild(manageBtn);
        // 弹层打开即拉最新列表（缓存是上次刷新的快照）
        refreshSchedulesUI();
    }

    // onChange：可选的「任务数据变化后」回调（自动化对话框传入以原位重建）；缺省只刷设置列表
    function renderScheduleRow(s, onChange) {
        const afterChange = () => { renderScheduleSettings(); if (typeof onChange === 'function') onChange(); };
        const row = document.createElement('div');
        row.className = 'ai-sched-row' + (s.enabled ? '' : ' disabled');
        const main = document.createElement('div');
        main.className = 'ai-sched-main';
        const name = document.createElement('span');
        name.className = 'ai-sched-name';
        name.textContent = s.name;
        const badge = document.createElement('span');
        badge.className = 'ai-sched-badge' + (s.enabled ? ' on' : '');
        badge.textContent = s.enabled ? '启用' : '停用';
        const desc = document.createElement('span');
        desc.className = 'ai-sched-desc';
        desc.textContent = describeAISchedule(s) +
            ' · 权限 ' + s.scope +
            (s.sessionId ? ' · 唤醒会话「' + (sessionTitleById(s.sessionId) || s.sessionId.slice(0, 8)) + '」' : ' · 每次新建会话') +
            (s.lastResult ? ' · 最近：' + s.lastResult : '');
        main.append(name, badge, desc);
        const actions = document.createElement('div');
        actions.className = 'ai-sched-actions';
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'ai-pref-btn';
        toggle.innerHTML = iconSvg(s.enabled ? 'pause' : 'play', 12);
        toggle.addEventListener('click', () => {
            Promise.resolve(backend.AIScheduleToggle(s.id, !s.enabled)).then(() => {
                afterChange();
                flash((s.enabled ? '已停用：' : '已启用：') + s.name);
            }).catch((e) => flash('操作失败：' + ((e && e.message) || e), true));
        });
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'ai-pref-btn';
        edit.innerHTML = iconSvg('rename', 12);
        edit.addEventListener('click', () => openScheduleEditor(s));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'ai-pref-btn';
        remove.innerHTML = iconSvg('close', 12);
        remove.addEventListener('click', () => {
            askConfirm('删除定时任务「' + s.name + '」？', () => {
                Promise.resolve(backend.AIScheduleDelete(s.id)).then(() => {
                    afterChange();
                    flash('已删除定时任务：' + s.name);
                }).catch((e) => flash('删除失败：' + ((e && e.message) || e), true));
            });
        });
        actions.append(toggle, edit, remove);
        row.append(main, actions);
        return row;
    }

    function openScheduleEditor(existing, opts) {
        if (!el.dialog || !backend.AIScheduleCreate) return;
        const isEdit = !!existing;
        const node = (tag, cls) => {
            const n = document.createElement(tag);
            if (cls) n.className = cls;
            return n;
        };
        const row = (labelText, control) => {
            const r = node('div', 'ai-sched-field');
            const label = node('label');
            label.textContent = labelText;
            r.append(label, control);
            return r;
        };
        // 表单控件一律走 core/form-controls.js（修复存量裸控件违规）
        const nameCtl = createInput({className: 'dlg-input ai-settings-input', placeholder: '省略则取指令前 30 字'});
        // 会被 enhanceSelect 增强的下拉不要传 dlg-input/ai-settings-input 外观类：
        // 增强器的 wrap 会继承 select 的 class（settings-select.js），外观类跟着套到外层
        // 就与内层 .set-select-btn 形成「框中框」。保留工厂默认 opt-select（纯布局）即可。
        const kindCtl = createSelect({
            options: [
                {value: 'once', label: '单次（once）'},
                {value: 'interval', label: '固定间隔（interval）'},
                {value: 'cron', label: 'cron 表达式'},
            ],
        });
        const valueCtl = createInput({className: 'dlg-input ai-settings-input'});
        const valueLabel = node('label');
        const valueRow = node('div', 'ai-sched-field');
        valueRow.append(valueLabel, valueCtl.element);
        const promptCtl = createTextarea({
            className: 'dlg-input ai-settings-input', rows: 4,
            placeholder: '到点注入给 AI 的指令，例如：检查构建进度并汇报',
        });
        const scopeCtl = createSelect({
            options: [
                {value: 'chat', label: 'chat（纯对话）'},
                {value: 'read', label: 'read（只读访问）'},
                {value: 'edit', label: 'edit（每次询问）'},
            ],
        });
        // 目标会话：默认唤醒当前会话；也可选每次新建
        const targetCtl = createSelect({});
        const targetSel = targetCtl.control;
        const fillTargetOptions = () => {
            targetSel.textContent = '';
            const fresh = node('option');
            fresh.value = '';
            fresh.textContent = '每次新建会话';
            targetSel.appendChild(fresh);
            const recent = getSessions().slice()
                .sort((a, b) => sessionActivity(b) - sessionActivity(a))
                .slice(0, 30);
            for (const s of recent) {
                const opt = node('option');
                opt.value = s.id;
                opt.textContent = '唤醒会话：' + (s.title || '新会话') + (s.archivedAt ? '（已归档）' : '');
                targetSel.appendChild(opt);
            }
        };
        fillTargetOptions();
        const maxRunsCtl = createInput({type: 'number', className: 'dlg-input ai-settings-input', min: 0, placeholder: '0 = 不限'});
        const syncKind = () => {
            const v = kindCtl.control.value;
            if (v === 'once') {
                valueLabel.textContent = '触发时间（本地，如 2026-11-13 09:00）';
                valueCtl.control.placeholder = '留空则用「N 分钟后」';
            } else if (v === 'interval') {
                valueLabel.textContent = '循环间隔（分钟，1–525600）';
                valueCtl.control.placeholder = '如 10 = 每 10 分钟';
            } else {
                valueLabel.textContent = 'cron 表达式（分 时 日 月 周）';
                valueCtl.control.placeholder = '如 0 9 * * 1-5';
            }
        };
        kindCtl.control.addEventListener('change', syncKind);
        syncKind();
        if (isEdit) {
            nameCtl.control.value = existing.name || '';
            kindCtl.control.value = existing.kind || 'once';
            syncKind();
            if (existing.kind === 'interval') valueCtl.control.value = String(existing.intervalMinutes || '');
            else if (existing.kind === 'cron') valueCtl.control.value = existing.cron || '';
            else valueCtl.control.value = existing.at ? aiFormatLocalMs(existing.nextRunAt || existing.lastRunAt) : '';
            promptCtl.control.value = existing.prompt || '';
            scopeCtl.control.value = ['chat', 'read', 'edit'].includes(existing.scope) ? existing.scope : 'chat';
            maxRunsCtl.control.value = String(existing.maxRuns || 0);
        }
        // 目标会话预选：编辑 = 已绑定会话；新建 = 当前会话；不在最近 30 个列表时补选项兜底
        const preselectId = isEdit ? (existing.sessionId || '') : (currentSession() ? currentSession().id : '');
        if (preselectId && targetSel.value !== preselectId) {
            const opt = node('option');
            opt.value = preselectId;
            opt.textContent = '唤醒会话：' + (sessionTitleById(preselectId) || preselectId.slice(0, 8));
            targetSel.appendChild(opt);
        }
        if (preselectId) targetSel.value = preselectId;
        const cancelBtn = node('button', 'dlg-btn');
        cancelBtn.type = 'button';
        cancelBtn.textContent = '取消';
        cancelBtn.addEventListener('click', closeAIDialog);
        const save = node('button', 'dlg-btn primary');
        save.type = 'button';
        save.textContent = isEdit ? '保存' : '创建';
        save.addEventListener('click', () => {
            const v = valueCtl.control.value.trim();
            const input = {
                name: nameCtl.control.value.trim(),
                kind: kindCtl.control.value,
                prompt: promptCtl.control.value.trim(),
                sessionId: targetSel.value,
                scope: scopeCtl.control.value,
                maxRuns: aiClampInt(maxRunsCtl.control.value, 0, 1000000, 0),
            };
            if (input.kind === 'once') {
                input.at = v;
                if (!v) {
                    flash('请填写触发时间', true);
                    return;
                }
            } else if (input.kind === 'interval') {
                input.intervalMinutes = aiClampInt(v, 0, 525600, 0);
                if (input.intervalMinutes <= 0) {
                    flash('请填写循环间隔（分钟）', true);
                    return;
                }
            } else {
                input.cron = v;
                if (!v) {
                    flash('请填写 cron 表达式', true);
                    return;
                }
            }
            const call = isEdit
                ? backend.AIScheduleUpdate(existing.id, input)
                : backend.AIScheduleCreate(input);
            Promise.resolve(call).then(() => {
                closeAIDialog();
                renderScheduleSettings();
                flash((isEdit ? '已保存定时任务：' : '已创建定时任务：') + (input.name || '（未命名）'));
            }).catch((e) => flash('保存失败：' + ((e && e.message) || e), true));
        });
        const body = node('div', 'ai-sched-editor');
        body.append(
            row('名称', nameCtl.element),
            row('类型', kindCtl.element),
            valueRow,
            row('触发指令', promptCtl.element),
            row('目标会话', targetCtl.element),
            row('权限档（新建会话时生效）', scopeCtl.element),
            row('最多触发次数', maxRunsCtl.element),
        );
        openAIDialog(isEdit ? '编辑定时任务' : '新建定时任务', [body], [cancelBtn, save], opts && opts.top ? {top: true} : undefined);
        // 弹窗挂在 body（不在 .apppage-root 里），扫描器扫不到——入 DOM 后逐个增强，
        // 否则类型 / 权限档 / 目标会话三个下拉露浏览器原生菜单（与其它自绘控件两套外观）。
        // 增强器幂等，原生 select 仍是值真源，change 照常派发。
        if (enhanceSelect) {
            for (const ctl of [kindCtl, scopeCtl, targetCtl]) enhanceSelect(ctl.control);
        }
    }
    // ---- 定时任务触发（sched-fire）----
    // 多窗口去重：广播会被所有窗口收到。指定目标会话的任务只由持有该会话的窗口执行，
    // 无人认领则 700ms 后由第一个收到的窗口报告失败；新建会话类任务优先由聚焦窗口执行，
    // 其余窗口让路 250ms 后先到先得（localStorage 标记）。

    function aiDelay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function handleScheduleFire(fire) {
        if (!fire || !fire.scheduleId) return;
        const key = 'datalens-sched-fire-' + fire.scheduleId + '-' + (fire.runNo || 0);
        const claimed = () => {
            if (kvGet(key)) return false;
            kvSet(key, String(Date.now())); // 写不进（配额/隐私模式）也算认领，同原实现
            return true;
        };
        const prompt = aiTextOf(fire.prompt);
        const prefix = '[定时任务 · ' + (aiTextOf(fire.name) || fire.scheduleId) + ']';
        const target = fire.sessionId ? getSessions().find((s) => s.id === fire.sessionId) : null;
        if (fire.sessionId && !target) {
            // 本窗口不持有目标会话：等可能的持有窗口认领，无人认领则报告失败
            setTimeout(() => {
                if (kvGet(key) || !claimed()) return;
                flash('定时任务「' + (aiTextOf(fire.name) || fire.scheduleId) + '」的目标会话不存在', true);
                if (backend.AIScheduleSetResult) {
                    Promise.resolve(backend.AIScheduleSetResult(fire.scheduleId, false, '目标会话不存在')).catch(() => {});
                }
            }, 700);
            return;
        }
        if (!document.hasFocus()) {
            await aiDelay(250);
            if (kvGet(key)) return;
        }
        if (!claimed()) return;
        await runScheduledTurn(fire, target, prefix, prompt);
    }

    // 注入走「会话信箱」（§4.13）：不再 open(true) 强开面板、不再 switchSession 切走用户视图，
    // 也不再 30s 忙等——目标空闲时静默起一轮，忙则排到它下一轮边界（本轮结束后消费）。
    // 失败才 flash + 回写 AIScheduleSetResult（语义与改造前一致）。
    async function runScheduledTurn(fire, target, prefix, prompt) {
        const name = aiTextOf(fire.name) || fire.scheduleId;
        try {
            if (!deliverAgentNotice) throw new Error('当前版本不支持静默注入');
            // 跨工作区口径（§4.13.4）：系统上下文按「本窗口工作区」解析，跨工作区目标注入会拿到
            // 错的工作区规则——保持改造前的失败分支，不在这儿顺手改权限语义。
            if (target && typeof ctx.isSessionLocal === 'function' && !ctx.isSessionLocal(target)) {
                throw new Error('目标会话属于其他工作区，请到对应工作区的窗口处理');
            }
            let session = target;
            if (!session) {
                // 「每次新建会话」形态：没有目标就没有可注入的对象，仍然建一个（用户预期是新对话）
                newSession();
                session = currentSession();
                if (!session) throw new Error('无法创建会话');
                if (fire.scope === 'read' || fire.scope === 'edit') session.scope = fire.scope;
            }
            if (session.archivedAt) {
                // 用户自己设的定时任务，唤醒即恢复归档（§4.13.4：与「外部投递拒收归档会话」是两套语义）
                session.archivedAt = 0;
                persistSessions();
                renderSessionList();
                flash('定时任务目标会话已归档，已自动取消归档：' + (session.title || '新会话'));
            }
            const receipt = deliverAgentNotice(session, {
                kind: 'schedule',
                label: '定时任务 · ' + name,
                content: prefix + '\n' + prompt,
            });
            if (!receipt || !receipt.ok) {
                const reason = receipt && receipt.reason;
                throw new Error(reason === 'gone' ? '目标会话已不存在'
                    : (reason === 'archived' ? '目标会话已归档' : '注入失败（' + (reason || '未知') + '）'));
            }
            const woke = receipt.woke === true;
            flash('定时任务「' + name + '」已触发（第 ' + (fire.runNo || 1) + ' 次' +
                (woke ? '' : '，已排入目标会话的信箱') + '）');
            if (backend.AIScheduleSetResult) {
                Promise.resolve(backend.AIScheduleSetResult(fire.scheduleId, true,
                    '第 ' + (fire.runNo || 1) + ' 次触发已注入会话' + (woke ? '' : '（排队等待中）'))).catch(() => {});
            }
        } catch (e) {
            const detail = String((e && e.message) || e);
            flash('定时任务「' + name + '」触发失败：' + detail, true);
            // A 级：定时任务在后台触发，失败没人盯着状态栏——必须送消息中心。
            notifyFailure('定时任务触发失败', '「' + name + '」：' + detail, {key: 'schedule-fire', kind: 'error'});
            if (backend.AIScheduleSetResult) {
                Promise.resolve(backend.AIScheduleSetResult(fire.scheduleId, false, String((e && e.message) || e))).catch(() => {});
            }
        }
    }

    // ---- 自动化对话框（会话侧栏「自动化」按钮）：设置面板同款模态，任务按对话分组 + 全套操作 ----
    // 行操作（启停 / 编辑 / 删除）复用设置页的 renderScheduleRow，变化后原位重建本对话框。
    function openAutomationDialog() {
        if (!backend.AIScheduleList || !backend.AIScheduleCreate) {
            flash('当前版本不支持定时任务');
            return;
        }
        const body = document.createElement('div');
        body.className = 'ai-automation-body';
        const build = (list) => {
            body.textContent = '';
            const tasks = Array.isArray(list) ? list : [];
            const localGroups = new Map(); // sessionId → tasks（保持首次出现顺序）
            let unbound = [];
            let foreign = 0;
            for (const s of tasks) {
                if (!s.sessionId) {
                    unbound.push(s);
                    continue;
                }
                const session = getSessions().find((x) => x.id === s.sessionId);
                const local = session && (typeof ctx.isSessionLocal !== 'function' || ctx.isSessionLocal(session));
                if (!local) {
                    foreign += 1;
                    continue;
                }
                if (!localGroups.has(s.sessionId)) localGroups.set(s.sessionId, []);
                localGroups.get(s.sessionId).push(s);
            }
            const addGroup = (title, rows) => {
                const groupTitle = document.createElement('div');
                groupTitle.className = 'ai-automation-group';
                groupTitle.textContent = title;
                body.appendChild(groupTitle);
                for (const s of rows) body.appendChild(renderScheduleRow(s, openAutomationDialog));
            };
            // 组间按会话最近活动排序（最近用过的对话靠上）
            const orderedSessions = [...localGroups.keys()].map((id) => getSessions().find((x) => x.id === id))
                .filter(Boolean)
                .sort((a, b) => sessionActivity(b) - sessionActivity(a));
            for (const session of orderedSessions) {
                addGroup('会话「' + (session.title || '新会话') + '」', localGroups.get(session.id));
            }
            if (unbound.length) addGroup('每次新建会话', unbound);
            if (foreign) {
                const note = document.createElement('div');
                note.className = 'ai-automation-group';
                note.textContent = '另有 ' + foreign + ' 个任务在其他工作区 / 已失效的会话';
                body.appendChild(note);
            }
            if (!localGroups.size && !unbound.length) {
                const empty = document.createElement('div');
                empty.className = 'ai-automation-empty';
                const span = document.createElement('span');
                span.textContent = foreign ? '本工作区还没有定时任务' : '还没有定时任务';
                empty.appendChild(span);
                body.appendChild(empty);
            }
        };
        build(scheduleListCache);
        // 统一刷新：走 refreshSchedulesUI（缓存 / 头部胶囊 / chips 弹层一起更新），
        // 完成后对话框仍开着才原位重建（用户可能已切到编辑器）
        refreshSchedulesUI((list) => {
            if (body.isConnected) build(list);
        });
        const foot = [
            dialogButton('全部管理…', 'dlg-btn', () => { closeAIDialog(); if (openSchedulesPage) openSchedulesPage(); else if (typeof ctx.openSettings === 'function') ctx.openSettings('schedules'); }),
            dialogButton('新建任务…', 'dlg-btn primary', () => openScheduleEditor(null)),
            dialogButton('关闭', 'dlg-btn', closeAIDialog),
        ];
        openAIDialog('自动化 · 定时任务', [body], foot);
    }

    return {renderScheduleSettings, mountSchedules, renderScheduleRow, renderSchedulePop, renderChip, syncChip, openScheduleEditor, openAutomationDialog, aiDelay, handleScheduleFire, runScheduledTurn};
}
