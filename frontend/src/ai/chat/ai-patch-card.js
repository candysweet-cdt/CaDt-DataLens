// ai-patch-card.js：补丁审批卡（composer 接管区的待审批卡 + 已裁决后的结果态正文）。
// 从 ai-takeover.js 拆出（frontend-split-phase3 A2，同域兄弟模块）；ctx 与宿主同源，
// 宿主分发器 updateComposerTakeover 经 extras 注入（构造期分发器未定义，惰性箭头延迟解析）。
// 函数体逐字搬移；el0 随唯一消费域迁入本模块。
import {iconSvg} from '../../core/icons.js';
import {aiNowId} from '../core/ai-constants.js';

export function createAIPatchCard(ctx, extras) {
    const el = ctx.el;
    const openPath = ctx.openPath;
    const persistSessions = ctx.persistSessions;
    const refreshToolWrap = ctx.refreshToolWrap;
    const decideApproval = ctx.decideApproval;
    const pendingApprovals = ctx.pendingApprovals;
    const renderSessionList = ctx.renderSessionList;
    const getApprovalTakeoverKey = ctx.getApprovalTakeoverKey;
    const setApprovalTakeoverKey = ctx.setApprovalTakeoverKey;
    const getApprovalTakeoverCollapsed = ctx.getApprovalTakeoverCollapsed;
    const setApprovalTakeoverCollapsed = ctx.setApprovalTakeoverCollapsed;
    const AI_CHEVRON_SVG = ctx.AI_CHEVRON_SVG;
    // 等待用户拍板的统一提醒（ai-panel 的 markWaitingOnUser）：补丁审批走的是本模块自己的
    // 登记路径（不经 registerPendingApproval），不单独接一下就会「卡片在等人、通知不响」。
    const notifyWaiting = typeof ctx.notifyWaiting === 'function' ? ctx.notifyWaiting : null;
    const updateComposerTakeover = extras.updateComposerTakeover;

    function requestPatchApproval(session, toolMessage, preview, allowApply) {
        // 停止竞态：PatchSave / 导出等 await 期间用户可能已停止本工具；此时再注册 pending
        // 卡会永久挂起并顶掉下一轮的审批（2026-11-17 复查）。
        if (toolMessage && toolMessage.interrupted) {
            return Promise.resolve({approved: false, cancelled: true});
        }
        const approval = {
            kind: 'patch',
            state: 'pending',
            summary: preview.summary || toolMessage.name,
            relPath: preview.summary || '补丁',
            planId: preview.planId,
            patchId: preview.patchId,
            patchPath: preview.patchPath,
            root: preview.root,
            mode: 'partial', // AI 侧默认允许部分成功（§9.7.1）
            selected: (preview.files || []).filter((f) => f.status === 'ok').map((f) => f.relPath),
            preview,
            allowApply: allowApply !== false,
        };
        toolMessage.approval = approval;
        toolMessage.status = 'pending';
        toolMessage.content = '等待用户审批补丁…';
        persistSessions();
        refreshToolWrap(session, toolMessage);
        const key = toolMessage.toolCallId || aiNowId('patch-');
        const entry = {session, toolMessage, resolve: null, approval};
        pendingApprovals.set(key, entry);
        updateComposerTakeover(true);
        renderSessionList();
        if (notifyWaiting) {
            notifyWaiting(session, approval, 'AI 待审批',
                (session.title || '会话') + ' · 补丁待审批：' + (approval.summary || approval.relPath || '未命名'));
        }
        return new Promise((resolve) => {
            entry.resolve = resolve;
        });
    }

    function renderPatchTakeover(entry) {
        const toolMessage = entry.toolMessage;
        const approval = entry.approval;
        const preview = approval.preview || {files: []};
        const files = preview.files || [];
        const takeoverKey = 'patch:' + (toolMessage.toolCallId || aiNowId('patch-'));
        el.takeover.dataset.takeoverKey = takeoverKey;
        // 与单文件审批一致：临时收起只影响显示，审批本身不取消
        if (getApprovalTakeoverKey() !== takeoverKey) {
            setApprovalTakeoverKey(takeoverKey);
            setApprovalTakeoverCollapsed(false);
        }
        el.takeover.textContent = '';
        if (getApprovalTakeoverCollapsed()) {
            const bar = document.createElement('button');
            bar.type = 'button';
            bar.className = 'ai-takeover-bar';
            const barIcon = document.createElement('span');
            barIcon.className = 'ai-takeover-icon';
            barIcon.innerHTML = iconSvg('diff', 13);
            const barText = document.createElement('span');
            barText.className = 'ai-takeover-bar-text';
            barText.textContent = '补丁待审批 · ' + (approval.summary || '未命名');
            const barStat = document.createElement('span');
            barStat.className = 'ai-approval-stat';
            barStat.append(el0('span', 'add', '+' + (preview.added || 0)), el0('span', 'del', '−' + (preview.removed || 0)));
            const chev = document.createElement('span');
            chev.className = 'ai-takeover-collapse';
            chev.innerHTML = AI_CHEVRON_SVG;
            bar.append(barIcon, barText, barStat, chev);
            bar.addEventListener('click', () => {
                setApprovalTakeoverCollapsed(false);
                updateComposerTakeover(true);
            });
            el.takeover.appendChild(bar);
            return;
        }
        const card = document.createElement('div');
        card.className = 'ai-takeover-card ai-patch-takeover';
        const head = document.createElement('div');
        head.className = 'ai-takeover-head';
        const icon = document.createElement('span');
        icon.className = 'ai-takeover-icon';
        icon.innerHTML = iconSvg('diff', 13);
        const title = document.createElement('span');
        title.className = 'ai-takeover-title';
        title.textContent = '补丁审批 · ' + (approval.summary || '未命名');
        const stat = document.createElement('span');
        stat.className = 'ai-takeover-stat';
        stat.append(
            el0('span', 'add', '+' + (preview.added || 0)),
            el0('span', 'del', '−' + (preview.removed || 0)),
            el0('span', 'files', files.length + ' 文件'),
        );
        // 临时收起：折叠整卡为细条，方便继续查看上方消息；审批本身不受影响
        const collapse = document.createElement('button');
        collapse.type = 'button';
        collapse.className = 'ai-takeover-collapse';
        collapse.innerHTML = AI_CHEVRON_SVG;
        collapse.addEventListener('click', () => {
            setApprovalTakeoverCollapsed(true);
            updateComposerTakeover(true);
        });
        head.append(icon, title, stat, collapse);
        card.appendChild(head);

        const body = document.createElement('div');
        body.className = 'ai-takeover-body';
        const list = document.createElement('div');
        list.className = 'ai-patch-filelist';
        for (const f of files) {
            const row = document.createElement('label');
            row.className = 'ai-patch-filerow ' + (f.status || '');
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = approval.selected.includes(f.relPath);
            box.disabled = f.status !== 'ok' && approval.mode === 'atomic';
            box.addEventListener('change', () => {
                const set = new Set(approval.selected);
                if (box.checked) set.add(f.relPath);
                else set.delete(f.relPath);
                approval.selected = Array.from(set);
                persistSessions();
                updateComposerTakeover(true);
            });
            const path = document.createElement('span');
            path.className = 'ai-patch-path';
            path.textContent = f.relPath;
            const statEl = document.createElement('span');
            statEl.className = 'ai-patch-stat';
            statEl.append(el0('span', 'add', '+' + (f.added || 0)), el0('span', 'del', '−' + (f.removed || 0)));
            const badge = document.createElement('span');
            badge.className = 'ai-patch-badge ' + (f.status || '');
            badge.textContent = {ok: '可应用', conflict: '冲突', blocked: '不可用', unsupported: '不支持'}[f.status] || f.status;
            row.append(box, path);
            if (f.kind === 'add') row.appendChild(el0('span', 'ai-patch-kind', '新建'));
            else if (f.kind === 'delete') row.appendChild(el0('span', 'ai-patch-kind danger', '删除'));
            row.append(statEl, badge);
            list.appendChild(row);
            if (f.reason) {
                const reason = document.createElement('div');
                reason.className = 'ai-patch-reason';
                reason.textContent = '→ ' + f.reason;
                list.appendChild(reason);
            }
        }
        body.appendChild(list);

        const modeRow = document.createElement('div');
        modeRow.className = 'ai-approval-remember ai-patch-moderow';
        const modeLabel = document.createElement('label');
        const modeText = document.createElement('span');
        modeText.textContent = '应用模式：';
        // 两段式切换钮（对齐接管卡按钮观感；裸 select 已按表单控件规范移除）
        const modeGroup = document.createElement('div');
        modeGroup.className = 'patch-mode-group';
        for (const [value, label] of [['partial', '允许部分成功'], ['atomic', '整体成功']]) {
            const opt = document.createElement('button');
            opt.type = 'button';
            opt.className = 'patch-mode-opt' + (approval.mode === value ? ' active' : '');
            opt.textContent = label;
            opt.setAttribute('aria-pressed', String(approval.mode === value));
            opt.addEventListener('click', () => {
                if (approval.mode === value) return;
                approval.mode = value;
                persistSessions();
                updateComposerTakeover(true);
            });
            modeGroup.appendChild(opt);
        }
        modeLabel.append(modeText, modeGroup);
        modeRow.appendChild(modeLabel);
        body.appendChild(modeRow);
        card.appendChild(body);

        const foot = document.createElement('div');
        foot.className = 'ai-takeover-foot ai-approval-takeover-foot';
        // 详情入口：打开 .patch 的补丁视图（逐文件状态、逐行 diff、撤销都在那边）
        const detail = document.createElement('button');
        detail.type = 'button';
        detail.className = 'dlg-btn';
        detail.textContent = '查看详情';
        detail.disabled = !approval.patchPath;
        detail.addEventListener('click', () => {
            if (approval.patchPath) openPath(approval.patchPath);
        });
        foot.appendChild(detail);
        const actions = document.createElement('div');
        actions.className = 'ai-approval-actions';
        const deny = document.createElement('button');
        deny.type = 'button';
        deny.className = 'dlg-btn';
        deny.textContent = '放弃';
        deny.addEventListener('click', () => decideApproval(toolMessage, false, ''));
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'dlg-btn primary';
        const okCount = files.filter((f) => f.status === 'ok' && approval.selected.includes(f.relPath)).length;
        apply.textContent = '应用（' + okCount + ' 个' + (approval.mode === 'partial' ? '，其余跳过' : '') + '）';
        apply.disabled = okCount === 0;
        apply.addEventListener('click', () => decideApproval(toolMessage, true, ''));
        actions.append(deny, apply);
        foot.appendChild(actions);
        card.appendChild(foot);
        el.takeover.appendChild(card);
    }

    // 结果态（已裁决）：展示逐文件结果与撤销提示
    function renderPatchApprovalBody(container, message, approval) {
        const meta = document.createElement('div');
        meta.className = 'ai-approval-meta';
        const path = document.createElement('span');
        path.className = 'ai-approval-path';
        path.textContent = approval.summary || '补丁';
        meta.appendChild(path);
        const stat = document.createElement('span');
        stat.className = 'ai-approval-stat';
        stat.textContent = '模式：' + (approval.mode === 'partial' ? '允许部分成功' : '整体成功');
        meta.appendChild(stat);
        container.appendChild(meta);

        const res = approval.result;
        // 已裁决后仍可跳回补丁视图：逐文件状态、逐行 diff、撤销都在那边
        const appendDetailLink = (applied) => {
            if (!approval.patchPath) return;
            const more = el0('div', 'ai-approval-more');
            const link = el0('button', 'patch-link', applied ? '在补丁视图中查看 / 撤销' : '在补丁视图中查看详情');
            link.type = 'button';
            link.addEventListener('click', () => openPath(approval.patchPath));
            more.appendChild(link);
            container.appendChild(more);
        };
        if (approval.state === 'denied') {
            container.appendChild(el0('div', 'ai-approval-result denied', '已放弃，文件未修改'));
            appendDetailLink(false);
            return;
        }
        if (approval.state === 'cancelled') {
            container.appendChild(el0('div', 'ai-approval-result cancelled', '审批已取消'));
            appendDetailLink(false);
            return;
        }
        if (!res) {
            container.appendChild(el0('div', 'ai-approval-result', '正在应用补丁…'));
            return;
        }
        const box = el0('div', 'ai-approval-result ' + (res.applied > 0 ? 'approved' : 'failed'));
        if (res.applied > 0) {
            box.textContent = '已应用 ' + res.applied + ' 个文件' + (res.skipped ? '，跳过 ' + res.skipped + ' 个' : '') + (res.mode === 'partial' && res.skipped ? '（可在补丁视图里撤销）' : '');
        } else {
            box.textContent = '未应用任何更改' + (res.message ? '：' + res.message : '');
        }
        container.appendChild(box);
        if (res.files && res.files.length) {
            const list = el0('div', 'ai-approval-output');
            list.textContent = res.files.map((f) => {
                const label = {applied: '✓ 已应用', skipped: '⚠ 已跳过', failed: '✗ 失败', notapplied: '· 未执行'}[f.status] || f.status;
                return label + ' ' + f.relPath + (f.reason ? '（' + f.reason + '）' : '');
            }).join('\n');
            container.appendChild(list);
        }
        appendDetailLink(res.applied > 0);
    }

    function el0(tag, cls, text) {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
    }

    return {requestPatchApproval, renderPatchTakeover, renderPatchApprovalBody};
}
