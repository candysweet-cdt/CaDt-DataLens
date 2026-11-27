// ai-reminders.js：当前会话「任务提醒」清单（防止上下文过长遗漏事情）。
// 独立域模块（factory + deps 注入）：自带触发按钮、弹层 DOM 与 .ai-rem- 样式，
// 不依赖 style.css 新增规则；纯函数（normalizeReminders / remindersForPrompt）可单测。
// 数据存会话（session.reminders，随 meta.json 持久化），AI 经 reminder_* 工具增删改，
// 每轮开始由 assembleSystemContext 注入 <task_reminders> 块。
// 创建对话框用居中弹窗（ctx 注入 openDialog/closeDialog/dialogNode/dialogButton 三件套），
// 输入控件走 form-controls 工厂（表单控件硬规范：禁新增裸 input）。
import {aiTextOf, AI_REMINDER_LIMIT, AI_REMINDER_TITLE_MAX, AI_REMINDER_DETAIL_MAX} from '../core/ai-constants.js';
import {iconSvg} from '../../core/icons.js';
import {createInput} from '../../core/form-controls.js';

// ---------- 纯函数（可单测） ----------

// normalizeReminders 归一并截断：只保留合法条目，id 缺失时补齐，非法状态归 open。
// 方案 A（功能验证报告 §4.3.1）：上限只约束未完成条目（open ≤ 5，标 done 即释放名额），
// 已完成条目保留作历史但只留最近 AI_REMINDER_LIMIT 条（先淘汰最旧的 done），防止历史无限膨胀。
export function normalizeReminders(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const seen = new Set();
    const valid = [];
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const title = aiTextOf(item.title).trim().slice(0, AI_REMINDER_TITLE_MAX);
        if (!title) continue;
        const detail = aiTextOf(item.detail).trim().slice(0, AI_REMINDER_DETAIL_MAX);
        let id = aiTextOf(item.id).trim().slice(0, 64) || 'rem-' + Date.now().toString(36) + '-' + (valid.length + 1);
        while (seen.has(id)) id += '-x';
        seen.add(id);
        valid.push({
            id,
            title,
            detail,
            status: item.status === 'done' ? 'done' : 'open',
            createdAt: Number(item.createdAt) || Date.now(),
        });
    }
    const doneCount = valid.filter((item) => item.status === 'done').length;
    const doneBudget = Math.min(doneCount, AI_REMINDER_LIMIT); // 只留最近的 done
    let doneSeen = 0;
    let openKept = 0;
    const out = [];
    for (const item of valid) {
        if (item.status === 'done') {
            doneSeen++;
            if (doneSeen <= doneCount - doneBudget) continue; // 淘汰最旧的 done
        } else {
            if (openKept >= AI_REMINDER_LIMIT) continue; // 遗留数据超限：按序截断
            openKept++;
        }
        out.push(item);
    }
    return out;
}

// remindersForPrompt 注入用的未完成条目（每轮系统上下文里可见的清单）。
// 缺状态字段的旧数据视为进行中（与徽标计数口径一致）。
export function remindersForPrompt(session) {
    const list = Array.isArray(session && session.reminders) ? session.reminders : [];
    return list.filter((item) => item && item.status !== 'done');
}

// reminderAddBlocked 超上限时的明确报错文案；null 表示可以添加。
// 上限只数未完成条目（与徽标 openCount 同口径）：标 done 即释放名额，报错建议的路径真实可用。
export function reminderAddBlocked(list) {
    const open = Array.isArray(list) ? list.filter((item) => item && item.status !== 'done').length : 0;
    if (open < AI_REMINDER_LIMIT) return null;
    return '任务提醒已达上限（未完成 ' + AI_REMINDER_LIMIT + ' 条）。请先用 reminder_remove 删除不再需要的条目，或用 reminder_update 把已完成的条目标记 done（完成即释放名额）后再添加。';
}

// ---------- UI ----------

const REMINDER_STYLE = `
.ai-rem-btn { position: relative; }
.ai-rem-badge {
    position: absolute; top: -3px; right: -3px;
    min-width: 13px; height: 13px; padding: 0 3px;
    border-radius: 7px; background: var(--accent, #4c8dff); color: #fff;
    font-size: 9px; line-height: 13px; text-align: center; font-weight: 600;
}
.ai-rem-pop { width: 300px; max-height: 340px; overflow: auto; }
.ai-rem-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 6px; }
.ai-rem-count { opacity: .65; font-size: 11px; }
.ai-rem-row {
    display: flex; align-items: flex-start; gap: 6px;
    padding: 5px 6px; border-radius: 6px;
}
.ai-rem-row:hover { background: var(--hover, rgba(128,128,128,.12)); }
.ai-rem-main { flex: 1; min-width: 0; }
.ai-rem-title { font-size: 12px; line-height: 1.45; word-break: break-word; }
.ai-rem-detail { font-size: 11px; opacity: .65; margin-top: 1px; word-break: break-word; }
.ai-rem-row.done .ai-rem-title { text-decoration: line-through; opacity: .55; }
.ai-rem-status {
    flex: none; font-size: 10px; padding: 1px 6px; margin-top: 1px;
    border-radius: 8px; border: 1px solid var(--border, rgba(128,128,128,.4)); opacity: .8;
}
.ai-rem-acts { flex: none; display: flex; gap: 2px; }
.ai-rem-act {
    border: 0; background: transparent; cursor: pointer; padding: 2px 4px;
    border-radius: 4px; font-size: 11px; color: inherit; opacity: .7;
}
.ai-rem-act:hover { background: var(--hover, rgba(128,128,128,.16)); opacity: 1; }
.ai-rem-empty { padding: 10px 6px; font-size: 12px; opacity: .6; }
.ai-rem-add { display: flex; flex-direction: column; gap: 4px; padding: 6px 4px 2px; border-top: 1px solid var(--border, rgba(128,128,128,.3)); margin-top: 4px; }
.ai-rem-add input {
    width: 100%; box-sizing: border-box; font-size: 12px;
    padding: 4px 6px; border-radius: 6px;
    border: 1px solid var(--border, rgba(128,128,128,.4));
    background: var(--input, transparent); color: inherit;
}
.ai-rem-add-foot { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.ai-rem-add-hint { font-size: 10px; opacity: .55; }
.ai-rem-add-btn { flex: none; }
.ai-rem-btn.hidden { display: none; }
.ai-rem-create-err { font-size: 11px; color: var(--red, #e5534b); min-height: 14px; }
`;

export function createAIReminders(ctx) {
    const panel = ctx.panel;
    const currentSession = ctx.currentSession;
    const persistSessions = ctx.persistSessions;
    const flash = ctx.flash;

    let remBtn = null;
    let remBadge = null;
    let remPop = null;
    let mounted = false;

    function activeList() {
        const session = currentSession();
        return session && Array.isArray(session.reminders) ? session.reminders : [];
    }

    function openCount() {
        return activeList().filter((item) => item && item.status !== 'done').length;
    }

    // ensureStyle 样式只注入一次（float / dock 两形态共用同一 document）。
    function ensureStyle() {
        if (document.getElementById('ai-reminders-style')) return;
        const style = document.createElement('style');
        style.id = 'ai-reminders-style';
        style.textContent = REMINDER_STYLE;
        document.head.appendChild(style);
    }

    function mount() {
        if (mounted || !panel || !panel.isConnected) return;
        const actions = panel.querySelector('.ai-head-actions');
        if (!actions) return;
        ensureStyle();
        remBtn = document.createElement('button');
        remBtn.type = 'button';
        remBtn.id = 'ai-reminders-btn';
        remBtn.className = 'ai-icon-btn ai-rem-btn';
        remBtn.setAttribute('aria-haspopup', 'true');
        remBtn.innerHTML = iconSvg('bell');
        remBadge = document.createElement('span');
        remBadge.className = 'ai-rem-badge hidden';
        remBadge.textContent = '0';
        remBtn.appendChild(remBadge);
        remBtn.addEventListener('click', () => {
            if (remPop && !remPop.classList.contains('hidden')) hidePopover();
            else showPopover();
        });
        // 放在「更多」按钮之前；找不到锚点就追加到尾部
        const anchor = actions.querySelector('#ai-changes') || actions.querySelector('#ai-more');
        if (anchor) actions.insertBefore(remBtn, anchor);
        else actions.appendChild(remBtn);
        remPop = document.createElement('div');
        remPop.id = 'ai-reminders-pop';
        remPop.className = 'ai-popover ai-rem-pop hidden';
        panel.appendChild(remPop);
        mounted = true;
        refresh();
    }

    function refresh() {
        if (!mounted) return;
        const count = openCount();
        if (remBadge) {
            remBadge.textContent = String(count);
            remBadge.classList.toggle('hidden', count === 0);
        }
        if (remBtn) {
            // 无未完成条目时不显示铃铛；创建入口在消息框「+」→ 任务提醒
            remBtn.classList.toggle('hidden', count === 0);
        }
        if (remPop && !remPop.classList.contains('hidden')) renderPopover();
    }

    // addReminder 写入一条提醒：弹层底部表单与「+」菜单创建对话框共用这条路径。
    // 成功返回 null（已持久化并刷新 UI），失败返回给用户看的错误文案。
    function addReminder(title, detail) {
        const session = currentSession();
        if (!session) return '当前没有会话';
        const blocked = reminderAddBlocked(activeList());
        if (blocked) return blocked;
        session.reminders = normalizeReminders(activeList().concat([{
            id: 'rem-' + Date.now().toString(36),
            title,
            detail,
            status: 'open',
            createdAt: Date.now(),
        }]));
        persistSessions();
        renderPopover();
        refresh();
        return null;
    }

    function closeCreateDialog() {
        if (typeof ctx.closeDialog === 'function') ctx.closeDialog();
    }

    // 「+」菜单的手动创建对话框（居中弹窗）：标题必填 + 简述可选
    function openCreateDialog() {
        const session = currentSession();
        if (!session) {
            flash('当前没有会话，无法添加任务提醒', true);
            return;
        }
        if (typeof ctx.openDialog !== 'function') {
            flash('当前版本不支持创建对话框', true);
            return;
        }
        closeCreateDialog();
        const errEl = ctx.dialogNode ? ctx.dialogNode('div', 'ai-rem-create-err', '') : document.createElement('div');
        const titleField = createInput({
            maxLength: AI_REMINDER_TITLE_MAX,
            placeholder: '提醒标题（必填，≤' + AI_REMINDER_TITLE_MAX + ' 字）',
            spellcheck: false,
        });
        const detailField = createInput({
            maxLength: AI_REMINDER_DETAIL_MAX,
            placeholder: '补充说明（可选，≤' + AI_REMINDER_DETAIL_MAX + ' 字）',
            spellcheck: false,
        });
        const close = () => closeCreateDialog();
        const submit = () => {
            const value = titleField.control.value.trim();
            if (!value) {
                errEl.textContent = '提醒标题不能为空';
                titleField.control.focus();
                return;
            }
            const err = addReminder(value, detailField.control.value.trim());
            if (err) {
                errEl.textContent = err;
                return;
            }
            close();
            flash('任务提醒已添加（' + openCount() + ' 条未完成）');
        };
        ctx.openDialog('新建任务提醒',
            [titleField.element, detailField.element, errEl],
            [
                ctx.dialogButton('取消', 'dlg-btn', close),
                ctx.dialogButton('添加', 'dlg-btn primary', submit),
            ]);
        for (const control of [titleField.control, detailField.control]) {
            control.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    submit();
                } else if (e.key === 'Escape') {
                    e.stopPropagation();
                    close();
                }
            });
        }
        titleField.control.focus();
    }

    function renderPopover() {
        if (!remPop) return;
        remPop.innerHTML = '';
        const session = currentSession();
        const list = activeList();
        const head = document.createElement('div');
        head.className = 'ai-rem-head';
        const title = document.createElement('span');
        title.className = 'ai-pop-title';
        title.textContent = '任务提醒';
        const count = document.createElement('span');
        count.className = 'ai-rem-count';
        // 口径与徽标/上限一致：只数未完成（已完成保留作历史，不占名额）
        count.textContent = session ? (openCount() + '/' + AI_REMINDER_LIMIT) : '';
        head.append(title, count);
        remPop.appendChild(head);
        if (!session) {
            const empty = document.createElement('div');
            empty.className = 'ai-rem-empty';
            empty.textContent = '当前没有会话。';
            remPop.appendChild(empty);
            return;
        }
        if (!list.length) {
            const empty = document.createElement('div');
            empty.className = 'ai-rem-empty';
            empty.textContent = '暂无提醒。添加后每轮对话开始都会注入给 AI，防止上下文过长遗漏事情。';
            remPop.appendChild(empty);
        }
        for (const item of list.slice().reverse()) {
            const row = document.createElement('div');
            row.className = 'ai-rem-row' + (item.status === 'done' ? ' done' : '');
            const main = document.createElement('div');
            main.className = 'ai-rem-main';
            const name = document.createElement('div');
            name.className = 'ai-rem-title';
            name.textContent = item.title;
            main.appendChild(name);
            if (item.detail) {
                const detail = document.createElement('div');
                detail.className = 'ai-rem-detail';
                detail.textContent = item.detail;
                main.appendChild(detail);
            }
            const status = document.createElement('span');
            status.className = 'ai-rem-status';
            status.textContent = item.status === 'done' ? '完成' : '进行';
            const acts = document.createElement('div');
            acts.className = 'ai-rem-acts';
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'ai-rem-act';
            toggle.textContent = item.status === 'done' ? '恢复' : '完成';
            toggle.addEventListener('click', () => {
                item.status = item.status === 'done' ? 'open' : 'done';
                persistSessions();
                renderPopover();
                refresh();
            });
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'ai-rem-act';
            remove.textContent = '删除';
            remove.addEventListener('click', () => {
                session.reminders = activeList().filter((entry) => entry !== item);
                persistSessions();
                renderPopover();
                refresh();
            });
            acts.append(toggle, remove);
            row.append(main, status, acts);
            remPop.appendChild(row);
        }
        // 手动新增：标题必填，描述可选
        const add = document.createElement('div');
        add.className = 'ai-rem-add';
        const titleInput = document.createElement('input');
        titleInput.type = 'text';
        titleInput.placeholder = '提醒标题（必填，≤' + AI_REMINDER_TITLE_MAX + ' 字）';
        titleInput.maxLength = AI_REMINDER_TITLE_MAX;
        const detailInput = document.createElement('input');
        detailInput.type = 'text';
        detailInput.placeholder = '补充说明（可选，≤' + AI_REMINDER_DETAIL_MAX + ' 字）';
        detailInput.maxLength = AI_REMINDER_DETAIL_MAX;
        const foot = document.createElement('div');
        foot.className = 'ai-rem-add-foot';
        const hint = document.createElement('span');
        hint.className = 'ai-rem-add-hint';
        hint.textContent = '最多 ' + AI_REMINDER_LIMIT + ' 条未完成';
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'dlg-btn ai-rem-add-btn';
        addBtn.textContent = '添加';
        const submit = () => {
            const value = titleInput.value.trim();
            if (!value) {
                flash('提醒标题不能为空', true);
                return;
            }
            const err = addReminder(value, detailInput.value.trim());
            if (err) {
                flash(err, true);
                return;
            }
            titleInput.value = '';
            detailInput.value = '';
        };
        addBtn.addEventListener('click', submit);
        for (const input of [titleInput, detailInput]) {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    submit();
                }
            });
        }
        foot.append(hint, addBtn);
        add.append(titleInput, detailInput, foot);
        remPop.appendChild(add);
    }

    function showPopover() {
        if (!remPop || !remBtn || !panel) return;
        renderPopover();
        remPop.classList.remove('hidden');
        const panelRect = panel.getBoundingClientRect();
        const btnRect = remBtn.getBoundingClientRect();
        const width = 300;
        let left = btnRect.right - panelRect.left - width;
        left = Math.max(8, Math.min(left, panel.clientWidth - width - 8));
        remPop.style.left = left + 'px';
        remPop.style.top = (btnRect.bottom - panelRect.top + 6) + 'px';
    }

    function hidePopover() {
        if (remPop) remPop.classList.add('hidden');
    }

    // 点击面板其他区域时收起弹层（与 changes 弹层的交互一致）
    document.addEventListener('mousedown', (e) => {
        if (!remPop || remPop.classList.contains('hidden')) return;
        if (remPop.contains(e.target) || (remBtn && remBtn.contains(e.target))) return;
        hidePopover();
    });

    return {mount, refresh, hidePopover, openCreateDialog, closeCreateDialog};
}
