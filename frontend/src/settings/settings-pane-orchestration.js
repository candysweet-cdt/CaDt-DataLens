// settings-pane-orchestration.js：设置 → AI → 编排（默认策略）。
//
// 这些是「跨编排的默认值」；单次的模型白名单 / 自主执行 / 快照仍只在审批卡上授权，
// 不做全局设置。控件全部走 core/form-controls 工厂，静态 HTML 只放空容器。
import {createCheckbox, createInput} from '../core/form-controls.js';

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
}

function row(title, desc, control) {
    const wrap = el('div', 'set-row');
    const main = el('div', 'set-main');
    main.append(el('div', 'set-title', title));
    if (desc) main.appendChild(el('div', 'set-desc', desc));
    const ctrl = el('div', 'set-control');
    ctrl.appendChild(control);
    wrap.append(main, ctrl);
    return wrap;
}

export function mountOrchestrationSettings(host, deps) {
    if (!host) return () => {};
    host.textContent = '';
    const settings = () => (deps.getSettings ? deps.getSettings() : {}) || {};
    const save = deps.applySettings || (() => {});
    const patch = (key, value) => {
        const current = settings();
        current[key] = value;
        save(current);
    };

    host.appendChild(el('div', 'set-group-title', '默认策略'));
    const card = el('div', 'set-card');

    const parallel = createInput({
        type: 'number', min: 1, max: 8, value: String(Number(settings().orchMaxParallel) || 2),
        onChange: (e) => patch('orchMaxParallel', Math.max(1, Math.min(8, Number(e.target.value) || 2))),
    }).control;
    parallel.id = 'orch-opt-max-parallel';
    card.appendChild(row('并发批次', '默认 2；owns 有交集的批次永远串行，判不准也串行。', parallel));

    const attempts = createInput({
        type: 'number', min: 1, max: 2, value: String(Number(settings().orchMaxAttempts) || 2),
        onChange: (e) => patch('orchMaxAttempts', Math.max(1, Math.min(2, Number(e.target.value) || 2))),
    }).control;
    attempts.id = 'orch-opt-max-attempts';
    card.appendChild(row('单批尝试上限', '含首次，硬上限 2；重派是原批次的下一次尝试，不新建返工批次。', attempts));

    const timeout = createInput({
        type: 'number', min: 60, max: 7200, value: String(Number(settings().orchBatchTimeoutSec) || 1200),
        onChange: (e) => patch('orchBatchTimeoutSec', Math.max(60, Math.min(7200, Number(e.target.value) || 1200))),
    }).control;
    timeout.id = 'orch-opt-batch-timeout';
    card.appendChild(row('单批超时（秒）', '默认 20 分钟；超时无回报判 stalled。审批卡可按批覆盖。', timeout));

    const audit = createInput({
        type: 'number', min: 120, max: 86400, value: String(Number(settings().orchAuditIdleSec) || 7200),
        onChange: (e) => patch('orchAuditIdleSec', Math.max(120, Math.min(86400, Number(e.target.value) || 7200))),
    }).control;
    audit.id = 'orch-opt-audit-idle';
    card.appendChild(row('审计静默阈值（秒）', '默认 2 小时；必须 ≥ 2 × 最长批次超时，后端会再校验。', audit));

    const budget = createInput({
        type: 'number', min: 0, value: String(Number(settings().orchBudgetTokens) || 0),
        onChange: (e) => patch('orchBudgetTokens', Math.max(0, Math.round(Number(e.target.value) || 0))),
    }).control;
    budget.id = 'orch-opt-budget';
    card.appendChild(row('token 预算（默认）', '0 = 不限；超预算是事后熔断，只停止派发新批次，不保证绝不超。', budget));

    const finalReview = createCheckbox({
        checked: settings().orchFinalReview === true,
        label: '全部完成后默认开终审',
        onChange: (e) => patch('orchFinalReview', e.target.checked),
    });
    finalReview.control.id = 'orch-opt-final-review-default';
    card.appendChild(row('子代理终审', '全部批次完成后派 1–3 个只读终审，检查整体目标与跨批接线；可在审批卡上逐次关闭。', finalReview.element));

    host.appendChild(card);
    host.appendChild(el('div', 'set-desc',
        '模型白名单、自主执行与开始前快照是单次授权，只在编排审批卡上出现；不写入全局设置。'));
    return () => { host.textContent = ''; };
}