// ai-session-send.js：会话投递的选择器 UI（用户向）。
// 两个面板：
//   1. 「投递到会话…」——把内容作为挂号信发给选中的会话（多选，≤10，带搜索与键盘操作）。
//      两类入口：会话发起（消息操作条 / 支线标签页——带来源消息或会话身份，列表排除发起方）
//      与全局入口（侧栏按钮 / composer「+」菜单——内容由用户自己写，不挂会话身份，
//      面板当前会话也照常可选）；
//   2. 「通知运行中的会话…」——用户向广播（唯一的多对一形态），列出当前 streaming / compacting
//      的会话，写一条通知投给它们全部。
// 传输层不在这里：投递走 ai-agent-notices.js 的信箱（三态投递与逐目标回执都在那边），
// 本模块只负责「选谁 + 写什么 + 回执怎么讲清楚」。
import {createInput, createTextarea} from '../../core/form-controls.js';

export const SESSION_PICK_MAX = 10;

// 标题过滤（大小写不敏感、去首尾空白）。空查询返回全部。
export function filterSessionRows(rows, query) {
    const q = String(query == null ? '' : query).trim().toLowerCase();
    const list = Array.isArray(rows) ? rows : [];
    if (!q) return list;
    return list.filter((row) => String((row && row.title) || '').toLowerCase().includes(q));
}

// 勾选 / 取消勾选。超过上限时拒绝并给原因——与工具面 session_send 的扇出上限是同一个数。
export function togglePicked(picked, id, max) {
    const limit = Number(max) || SESSION_PICK_MAX;
    const next = new Set(picked || []);
    if (!id) return {ok: false, picked: next, message: '会话 id 为空'};
    if (next.has(id)) {
        next.delete(id);
        return {ok: true, picked: next};
    }
    if (next.size >= limit) return {ok: false, picked: next, message: '最多同时投给 ' + limit + ' 个会话'};
    next.add(id);
    return {ok: true, picked: next};
}

export function pickedLabel(count, max) {
    const limit = Number(max) || SESSION_PICK_MAX;
    return '已选 ' + count + '/' + limit;
}

// 能否提交：既要有目标，也要有内容。内容由用户自己写之后这两条是独立的——
// 少一条就禁用按钮，别让用户点了才看到报错。
export function canSubmit(pickCount, hasContent) {
    return Number(pickCount) > 0 && !!hasContent;
}

const STATE_TEXT = {streaming: '运行中', compacting: '压缩中', idle: '空闲'};

export function createAISessionSend(ctx) {
    const openDialog = ctx.openDialog;
    const closeDialog = ctx.closeDialog;
    const node = ctx.node;
    const flash = ctx.flash;
    const listSessions = ctx.listSessions;
    const stateOf = ctx.stateOf;
    const workspaceName = ctx.workspaceName;
    const deliverToSessions = ctx.deliverToSessions;
    const getComposerText = ctx.getComposerText;
    const clearComposer = ctx.clearComposer;

    const FAIL_TEXT = {
        self: '不能投递给自己',
        not_found: '会话不存在',
        archived: '目标已归档',
        full: '对方信箱已满',
        empty: '内容为空',
    };

    function reasonTextOf(item) {
        return FAIL_TEXT[item.reason] || item.reason || '失败';
    }

    // 回执：成功给一句，失败列前两条原因（更多明细进不了 flash，但对用户已足够判断）
    function reportReceipt(out, okVerb) {
        if (!out || !out.results.length) {
            flash('没有可投递的目标', true);
            return;
        }
        const fails = out.results.filter((item) => !item.ok);
        if (!fails.length) {
            flash(okVerb + ' ' + out.okCount + ' 个会话' + (out.woke ? '（其中 ' + out.woke + ' 个被唤醒）' : ''));
            return;
        }
        if (!out.okCount) {
            flash('投递失败：' + fails.slice(0, 2).map(reasonTextOf).join('；'), true);
            return;
        }
        flash(okVerb + ' ' + out.okCount + ' 个，' + fails.length + ' 个失败：' +
            fails.slice(0, 2).map(reasonTextOf).join('；'), true);
    }

    function stateBadge(kind) {
        const badge = document.createElement('span');
        badge.className = 'ai-send-state ' + kind;
        if (kind === 'streaming' || kind === 'compacting') {
            const dot = document.createElement('span');
            dot.className = 'ai-send-dot';
            badge.appendChild(dot);
        }
        badge.appendChild(document.createTextNode(STATE_TEXT[kind] || kind));
        return badge;
    }

    // ---- 投递到会话（多选 + 搜索 + 键盘） ----
    // 两类进入方式：
    //   a) 会话发起（消息操作条「投递」/ 支线标签页）——发起方是该消息所属会话，列表排除它，
    //      卡片带它的身份；带来源消息时内容只读预览；
    //   b) 全局入口（侧栏按钮 / 列表头部图标 / composer「+」菜单）——options.senderless：
    //      不挂会话身份，当前会话也能勾，内容由用户自己写。
    // options.picked：预选目标（会话行图标进入时用它把该会话先勾上）。
    function openDeliver(message, session, options) {
        const opts = options || {};
        const sender = opts.senderless ? null : (session || null);
        const sourceText = String((message && message.content) || '').trim();
        // 排除对象跟着入口走：会话发起排它自己；全局入口显式传 null（不排除任何人）。
        const rows = listSessions({excludeSessionId: sender ? sender.id : null})
            .filter((row) => !sender || row.id !== sender.id);
        if (!rows.length) {
            flash(sender ? '没有其他可投递的会话' : '没有可投递的会话', true);
            return;
        }
        let picked = new Set((opts.picked || []).filter((id) => rows.some((row) => row.id === id)));
        let cursor = 0;
        let query = '';

        const head = node('div', 'ai-send-head');
        const search = createInput({
            className: 'dlg-input ai-send-search',
            placeholder: '搜索会话标题…',
            attrs: {'aria-label': '搜索会话', 'aria-describedby': 'ai-send-keys'},
        }).control;
        head.append(search);

        // 工具行：左侧实时计数，右侧批量操作（搜索框独占一行，避免输入区被挤窄）
        const count = node('span', 'ai-send-count', pickedLabel(0, SESSION_PICK_MAX));
        const toolbar = node('div', 'ai-send-toolbar');
        const selectAll = document.createElement('button');
        selectAll.type = 'button';
        selectAll.className = 'ai-send-link';
        selectAll.textContent = '全选';
        const clearAll = document.createElement('button');
        clearAll.type = 'button';
        clearAll.className = 'ai-send-link';
        clearAll.textContent = '清空';
        const totalLabel = node('span', 'ai-send-total', rows.length + ' 个可投递会话');
        toolbar.append(totalLabel, node('span', 'ai-send-spacer'), selectAll, clearAll);

        // 内容块：有来源 → 引用式只读预览；无来源 → 可编辑输入（内容由用户自己写）
        let area = null;
        let getText = () => sourceText;
        let contentBlock;
        if (sourceText) {
            contentBlock = node('div', 'ai-send-preview');
            const previewLabel = node('span', 'ai-send-preview-label', '投递内容');
            const previewText = node('div', 'ai-send-preview-text',
                sourceText.length > 180 ? sourceText.slice(0, 180) + '…' : sourceText);
            contentBlock.append(previewLabel, previewText);
        } else {
            contentBlock = node('div', 'ai-send-compose');
            area = createTextarea({
                className: 'dlg-input ai-send-textarea',
                rows: 3,
                placeholder: '要投给对方的结论、约定或需要它知晓的事实',
                attrs: {'aria-label': '投递内容'},
            }).control;
            area.value = String(opts.draft || '').trim();
            getText = () => String(area.value || '').trim();
            contentBlock.append(node('span', 'ai-send-preview-label', '投递内容（自己写）'), area);
        }

        const listBox = node('div', 'ai-send-list');
        listBox.setAttribute('role', 'listbox');
        listBox.setAttribute('aria-multiselectable', 'true');

        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'dlg-btn primary';
        confirm.textContent = '投递';
        confirm.disabled = true;
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'dlg-btn';
        cancel.textContent = '取消';
        cancel.addEventListener('click', () => closeDialog());

        const visible = () => filterSessionRows(rows, query);

        function updateFooter() {
            const items = visible();
            const over = picked.size >= SESSION_PICK_MAX;
            for (const item of listBox.querySelectorAll('.ai-send-row')) {
                const id = item.dataset.sessionId;
                const isPicked = picked.has(id);
                item.classList.toggle('picked', isPicked);
                item.setAttribute('aria-selected', isPicked ? 'true' : 'false');
                const box = item.querySelector('.ai-send-check');
                if (box) box.classList.toggle('on', isPicked);
                // 到上限后未选中的行变暗但仍可点（点了会提示原因，比静默失效好）
                item.classList.toggle('dimmed', over && !isPicked);
            }
            count.textContent = pickedLabel(picked.size, SESSION_PICK_MAX);
            // 内容由用户自己写时必须先有内容：两个条件都满足才放行，避免「能点但点了报错」
            const hasContent = !!getText();
            confirm.disabled = !canSubmit(picked.size, hasContent);
            confirm.textContent = picked.size ? '投递（' + picked.size + '）' : '投递';
            if (!items.length) {
                let empty = listBox.querySelector('.ai-send-empty');
                if (!empty) {
                    empty = node('div', 'ai-send-empty', '没有匹配的会话');
                    listBox.appendChild(empty);
                }
            } else {
                const empty = listBox.querySelector('.ai-send-empty');
                if (empty) empty.remove();
            }
        }

        function renderList() {
            listBox.textContent = '';
            const items = visible();
            if (cursor >= items.length) cursor = Math.max(0, items.length - 1);
            items.forEach((row, index) => {
                const kind = stateOf(row);
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'ai-send-row' + (index === cursor ? ' focus' : '');
                item.dataset.sessionId = row.id;
                item.setAttribute('role', 'option');
                const check = document.createElement('span');
                check.className = 'ai-send-check';
                const main = document.createElement('span');
                main.className = 'ai-send-main';
                const title = document.createElement('span');
                title.className = 'ai-send-title';
                title.textContent = row.title || '新会话';
                title.dataset.tip = row.title || '新会话';
                main.appendChild(title);
                const meta = document.createElement('span');
                meta.className = 'ai-send-meta';
                const ws = workspaceName ? workspaceName(row.workspace || '') : '';
                meta.textContent = [ws, row.unread ? '有未读' : ''].filter(Boolean).join(' · ');
                if (meta.textContent) main.appendChild(meta);
                item.append(check, main, stateBadge(kind));
                item.addEventListener('click', () => pick(row.id, index));
                listBox.appendChild(item);
            });
            updateFooter();
            const focused = listBox.querySelector('.ai-send-row.focus');
            if (focused && typeof focused.scrollIntoView === 'function') {
                focused.scrollIntoView({block: 'nearest'});
            }
        }

        function pick(id, index) {
            const result = togglePicked(picked, id, SESSION_PICK_MAX);
            if (!result.ok) {
                flash(result.message, true);
                return;
            }
            picked = result.picked;
            cursor = Number.isInteger(index) ? index : cursor;
            renderList();
        }

        function submit() {
            const text = getText();
            if (!text) {
                flash('投递内容不能为空', true);
                if (area) {
                    try {
                        area.focus();
                    } catch (e) {}
                }
                return;
            }
            const ids = [...picked];
            if (!ids.length) return;
            closeDialog();
            // 内容由用户自己写的（无来源消息）→ 按「用户指令」投递；转发某条模型消息 → 仍按参考信息。
            // sender 为 null（全局入口）时卡片写「来自用户」，不编造会话身份。
            const out = deliverToSessions(ids, text, {session: sender, byUser: !sourceText});
            reportReceipt(out, '已投递到');
        }

        search.addEventListener('input', () => {
            query = search.value || '';
            cursor = 0;
            renderList();
        });
        search.addEventListener('keydown', (e) => {
            const items = visible();
            if (e.key === 'Escape') {
                e.preventDefault();
                closeDialog();
                return;
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (!items.length) return;
                cursor = Math.min(items.length - 1, cursor + 1);
                renderList();
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (!items.length) return;
                cursor = Math.max(0, cursor - 1);
                renderList();
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                if (e.ctrlKey || e.metaKey) {
                    submit();
                    return;
                }
                if (items[cursor]) pick(items[cursor].id, cursor);
            }
        });
        selectAll.addEventListener('click', () => {
            const items = visible().slice(0, SESSION_PICK_MAX);
            picked = new Set(items.map((row) => row.id));
            if (visible().length > SESSION_PICK_MAX) flash('最多同时投给 ' + SESSION_PICK_MAX + ' 个会话，已取前 ' + SESSION_PICK_MAX + ' 个');
            renderList();
        });
        clearAll.addEventListener('click', () => {
            picked = new Set();
            renderList();
        });
        confirm.addEventListener('click', submit);

        // 键盘提示跟在列表下（随 body 滚动）；按钮走对话框 footer——列表再长也不会把按钮挤出视口
        const keyboard = node('div', 'ai-send-keys', '↑↓ 选择 · Enter 勾选 · Ctrl+Enter 投递');
        keyboard.id = 'ai-send-keys';
        count.classList.add('ai-send-count-foot');
        if (area) {
            area.addEventListener('input', () => updateFooter());
            area.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    submit();
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    closeDialog();
                }
            });
        }
        openDialog('投递到会话', [head, toolbar, contentBlock, listBox, keyboard], [count, cancel, confirm]);
        // 预选（会话行进入）：光标直接落到第一个已勾选的行上
        const firstPicked = visible().findIndex((row) => picked.has(row.id));
        if (firstPicked > 0) cursor = firstPicked;
        renderList();
        // 内容为空时先聚焦内容框（用户得先写），否则聚焦搜索框（直接选目标）
        const needsContent = !!area && !String(area.value || '').trim();
        setTimeout(() => {
            try {
                (needsContent && area ? area : search).focus();
            } catch (e) {}
        }, 0);
    }

    // ---- 通知运行中的会话（用户向广播） ----
    function openBroadcast() {
        const all = listSessions();
        const running = all.filter((row) => {
            const kind = stateOf(row);
            return kind === 'streaming' || kind === 'compacting';
        });
        if (!running.length) {
            const tip = node('div', 'ai-send-empty', '当前没有运行中的会话。空闲会话请用「投递到会话…」逐个指定。');
            openDialog('通知运行中的会话', [tip], [
                (() => {
                    const ok = document.createElement('button');
                    ok.type = 'button';
                    ok.className = 'dlg-btn primary';
                    ok.textContent = '知道了';
                    ok.addEventListener('click', () => closeDialog());
                    return ok;
                })(),
            ]);
            return;
        }
        const label = node('div', 'ai-send-label', '将通知 ' + running.length + ' 个运行中的会话：');
        const chips = node('div', 'ai-send-chips');
        for (const row of running) {
            const kind = stateOf(row);
            const chip = node('span', 'ai-send-chip ' + kind);
            const dot = node('span', 'ai-send-dot');
            chips.append(chip);
            chip.append(dot, node('span', 'ai-send-chip-title', row.title || '新会话'));
        }
        const area = createTextarea({
            className: 'dlg-input ai-send-textarea',
            rows: 3,
            placeholder: '要通知的内容，例如：工作区配置已变更，请按新规则收尾当前任务',
        }).control;
        const draft = String(getComposerText ? getComposerText() : '').trim();
        if (draft) area.value = draft;
        const hint = node('div', 'ai-send-hint',
            '卡片带尾注「系统通知，无需回复，继续当前工作」；它们会在自己的下一轮边界看到，不会被强行打断。');

        const send = document.createElement('button');
        send.type = 'button';
        send.className = 'dlg-btn primary';
        send.textContent = '发送通知';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'dlg-btn';
        cancel.textContent = '取消';
        cancel.addEventListener('click', () => closeDialog());

        function submit() {
            const text = String(area.value || '').trim();
            if (!text) {
                flash('通知内容不能为空', true);
                try {
                    area.focus();
                } catch (e) {}
                return;
            }
            closeDialog();
            const out = deliverToSessions(running.map((row) => row.id), text, {broadcast: true});
            // 通知内容已经发出去了：清掉输入框里的草稿，避免用户再手发一遍
            if (clearComposer && draft) clearComposer();
            reportReceipt(out, '已通知');
        }
        send.addEventListener('click', submit);
        area.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submit();
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                closeDialog();
            }
        });

        openDialog('通知运行中的会话', [label, chips, area, hint], [cancel, send]);
        setTimeout(() => {
            try {
                area.focus();
            } catch (e) {}
        }, 0);
    }

    return {openDeliver, openBroadcast};
}
