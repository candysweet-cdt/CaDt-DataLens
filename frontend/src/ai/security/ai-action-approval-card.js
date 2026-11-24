// ai-action-approval-card.js：通用动作审批卡（composer 接管区的 kind='action'）。
// 高危 app_control 动作（修改危险设置 / 安装卸载插件）共用：动作、目标、原值→新值、
// 发起会话、来源与危险度（低/中/高）一眼可核对；一次性授权，不提供「记住」。
// ctx 与 ai-takeover 同源（el / decideApproval / takeover 访问器），分发器经 extras 惰性注入。
import {iconSvg} from '../../core/icons.js';
import {createCheckbox} from '../../core/form-controls.js';

const RISK_LABELS = {low: '低风险', medium: '中风险', high: '高风险'};

export function createAIActionApprovalCard(ctx, extras) {
    const el = ctx.el;
    const decideApproval = ctx.decideApproval;
    const getApprovalTakeoverKey = ctx.getApprovalTakeoverKey;
    const setApprovalTakeoverKey = ctx.setApprovalTakeoverKey;
    const getApprovalTakeoverCollapsed = ctx.getApprovalTakeoverCollapsed;
    const setApprovalTakeoverCollapsed = ctx.setApprovalTakeoverCollapsed;
    const AI_CHEVRON_SVG = ctx.AI_CHEVRON_SVG;
    const updateComposerTakeover = extras.updateComposerTakeover;

    function renderActionTakeover(entry) {
        const toolMessage = entry.toolMessage;
        const approval = entry.approval;
        const risk = ['low', 'medium', 'high'].includes(approval.risk) ? approval.risk : 'medium';
        const titleText = approval.actionTitle || '动作审批';
        const takeoverKey = 'approval:' + (toolMessage.toolCallId || '');
        el.takeover.dataset.takeoverKey = takeoverKey;
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
            barIcon.innerHTML = iconSvg('shield', 13);
            const barText = document.createElement('span');
            barText.className = 'ai-takeover-bar-text';
            barText.textContent = '动作待审批 · ' + titleText;
            const chev = document.createElement('span');
            chev.className = 'ai-takeover-collapse';
            chev.innerHTML = AI_CHEVRON_SVG;
            bar.append(barIcon, barText, chev);
            bar.addEventListener('click', () => {
                setApprovalTakeoverCollapsed(false);
                updateComposerTakeover(true);
            });
            el.takeover.appendChild(bar);
            return;
        }
        const card = document.createElement('div');
        card.className = 'ai-takeover-card ai-approval-takeover ai-action-takeover risk-' + risk;
        const head = document.createElement('div');
        head.className = 'ai-takeover-head';
        const icon = document.createElement('span');
        icon.className = 'ai-takeover-icon';
        icon.innerHTML = iconSvg('shield', 13);
        const title = document.createElement('span');
        title.className = 'ai-takeover-title';
        title.textContent = titleText;
        const badge = document.createElement('span');
        badge.className = 'ai-action-risk risk-' + risk;
        badge.textContent = RISK_LABELS[risk];
        const collapse = document.createElement('button');
        collapse.type = 'button';
        collapse.className = 'ai-takeover-collapse';
        collapse.innerHTML = AI_CHEVRON_SVG;
        collapse.addEventListener('click', () => {
            setApprovalTakeoverCollapsed(true);
            updateComposerTakeover(true);
        });
        head.append(icon, title, badge, collapse);

        const body = document.createElement('div');
        body.className = 'ai-takeover-body';
        const detail = document.createElement('div');
        detail.className = 'ai-action-detail';
        const addRow = (key, value, opts) => {
            const options = opts || {};
            const row = document.createElement('div');
            row.className = 'ai-action-row';
            const keyEl = document.createElement('span');
            keyEl.className = 'ai-action-key';
            keyEl.textContent = key;
            const valEl = document.createElement('span');
            valEl.className = 'ai-action-val' + (options.mono ? ' mono' : '') + (options.scroll ? ' ai-action-script' : '');
            valEl.textContent = value == null || value === '' ? '—' : String(value);
            row.append(keyEl, valEl);
            detail.appendChild(row);
        };
        addRow('动作', approval.actionName === 'set_setting' ? '修改设置'
            : approval.actionName === 'install_plugin' ? '安装插件'
                : approval.actionName === 'uninstall_plugin' ? '卸载插件'
                    : (approval.actionName || '应用操作'));
        if (approval.scriptHash) {
            // 脚本审批：展示独立的 scriptText 全文（不经 target 截断），与执行的脚本是同一段。
            addRow('脚本', approval.scriptText || '（无内容）', {mono: true, scroll: true});
        } else if (approval.target) {
            addRow('目标', approval.target);
        }
        if (approval.oldValue || approval.newValue) {
            addRow('变更', (approval.oldValue || '—') + '  →  ' + (approval.newValue || '—'));
        }
        if (approval.origin) addRow('来源', approval.origin);
        const owner = approval.ownerSessionId || (entry.session && entry.session.id) || '';
        const ownerTitle = entry.session && entry.session.title ? entry.session.title : '';
        addRow('发起会话', (ownerTitle ? ownerTitle + ' · ' : '') + (owner || '—'), {mono: true});
        body.appendChild(detail);
        for (const warning of approval.warnings || []) {
            const note = document.createElement('div');
            note.className = 'ai-action-note' + (risk === 'high' ? ' danger' : '');
            const noteIcon = document.createElement('span');
            noteIcon.className = 'ai-action-note-icon';
            noteIcon.innerHTML = iconSvg('warn', 12);
            const noteText = document.createElement('span');
            noteText.textContent = warning;
            note.append(noteIcon, noteText);
            body.appendChild(note);
        }
        if (risk === 'high') {
            const note = document.createElement('div');
            note.className = 'ai-action-note danger';
            const noteIcon = document.createElement('span');
            noteIcon.className = 'ai-action-note-icon';
            noteIcon.innerHTML = iconSvg('warn', 12);
            const noteText = document.createElement('span');
            // 脚本审批卡有「本会话允许相同脚本」勾选框，不能再说「不会记住」（M2：文案自相矛盾）
            noteText.textContent = approval.scriptHash
                ? '高风险操作：批准后会立即执行；勾选「本会话允许相同脚本」后，相同脚本在本会话不再重复询问。'
                : '高风险操作：批准后会立即执行，且不会记住本次授权。';
            note.append(noteIcon, noteText);
            body.appendChild(note);
        }

        const foot = document.createElement('div');
        foot.className = 'ai-takeover-foot ai-approval-takeover-foot';
        const hint = document.createElement('span');
        hint.className = 'ai-takeover-hint';
        hint.textContent = '由 AI 发起 · 批准后才执行';
        // browser_evaluate 脚本审批专有：勾上后本会话内相同脚本免重复确认（只记指纹，不落长期规则）。
        let sessionBox = null;
        if (approval.scriptHash) {
            const box = createCheckbox({
                label: '本会话允许相同脚本',
                attrs: {'data-ai-script-remember': 'session'},
            });
            sessionBox = box.control;
            foot.appendChild(box.element);
        }
        const actions = document.createElement('div');
        actions.className = 'ai-approval-actions';
        const readRemember = () => (sessionBox && sessionBox.checked ? 'session' : '');
        const deny = document.createElement('button');
        deny.type = 'button';
        deny.className = 'dlg-btn';
        deny.textContent = '拒绝';
        // 拒绝不携带 remember：避免审计记录出现「已拒绝 + remember=session」的自相矛盾
        deny.addEventListener('click', () => decideApproval(toolMessage, false));
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'dlg-btn ' + (risk === 'high' ? 'danger' : 'primary');
        apply.textContent = '批准并执行';
        apply.addEventListener('click', () => decideApproval(toolMessage, true, readRemember()));
        actions.append(deny, apply);
        foot.append(hint, actions);
        card.append(head, body, foot);
        el.takeover.appendChild(card);
    }

    return {renderActionTakeover};
}
