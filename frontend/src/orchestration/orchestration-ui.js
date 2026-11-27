// orchestration-ui.js：编排域的宿主接线与界面（审批卡 / 看板 / 工具适配）。
//
// 依赖全部经 deps 注入（AI 面板、事件、确认框、表单控件都由 main 接线），
// 本模块不 import main.js，也不在模块顶层抓 DOM。真正判定都在 Go Router。
import {createCheckbox, createInput, createTextarea} from '../core/form-controls.js';
import {copyTextToClipboard} from '../core/clipboard.js';
import {iconSvg} from '../core/icons.js';
import {overlayStack} from '../core/overlay-stack.js';
import {
    acceptsWorkspace, batchDoneRatio, batchStatusLabel, buildPlanRequest, computeAuditIdleMs, failureLabel,
    formatElapsed, formatVerifyEditor, isTerminalStatus, normalizeBatch, ownsFromInput, ownsToInput,
    parseVerifyEditor, statusLabel, summarizeView,
} from './orchestration-model.js';

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
}

function iconButton(label, iconName, className, onClick) {
    const b = el('button', className || 'orch-btn');
    b.type = 'button';
    if (iconName) {
        const ic = el('span', 'orch-btn-icon');
        ic.innerHTML = iconSvg(iconName, 14);
        b.appendChild(ic);
    }
    b.appendChild(document.createTextNode(label));
    if (typeof onClick === 'function') b.addEventListener('click', onClick);
    return b;
}

function labelRow(text, control) {
    const row = el('label', 'orch-field');
    row.appendChild(el('span', 'orch-field-label', text));
    row.appendChild(control);
    return row;
}

function formatWhen(ts) {
    const n = Number(ts) || 0;
    if (!n) return '—';
    try { return new Date(n).toLocaleString(); } catch (e) { return '—'; }
}

export function createOrchestrationDomain(deps) {
    const backend = deps.backend;
    const getAI = deps.getAI;
    const getWorkspace = deps.getWorkspace;
    const flash = deps.flash || (() => {});
    const confirmAction = deps.confirmAction || ((msg, action) => { action(); });
    const openAppPageTab = deps.openAppPageTab;
    const boards = new Set();
    const inflightClaims = new Set();
    const handoffInFlight = new Set();

    function api() {
        if (!backend) throw new Error('后端不可用');
        return backend;
    }

    function call(name, ...args) {
        const target = api();
        const fn = target[name];
        if (typeof fn !== 'function') throw new Error('当前版本不支持：' + name);
        // 保留 this：浏览器 mock 的编排方法用 this._orch 持有状态；真实 Wails 代理不依赖 this。
        return fn.apply(target, args);
    }

    function aiPanel() {
        const panel = getAI ? getAI() : null;
        return panel || null;
    }

    function ensureAI() {
        if (!aiPanel() && typeof deps.ensureAI === 'function') {
            try { deps.ensureAI(); } catch (e) {}
        }
        return aiPanel();
    }

    // 执行票据只存在当前进程内存里（StartBatch 由宿主放到 session._orchestrationToken）。
    // 不提供“按 sessionId 再取一次”的绑定：否则任何窗口都能拿别人的票据伪造报告/写闸。
    async function tokenForSession(session) {
        return session ? String(session._orchestrationToken || '') : '';
    }

    function infoOf(session) {
        if (!session || !session.orchestration) return null;
        const info = session.orchestration;
        return {
            id: info.id || '',
            batchId: info.batchId || '',
            attempt: Number(info.attempt) || 0,
            role: info.role || '',
            parentSessionId: info.parentSessionId || '',
            generation: Number(info.generation) || 0,
            owns: Array.isArray(info.owns) ? info.owns.slice() : [],
        };
    }

    function notify(message, error) {
        flash(String(message || ''), !!error);
    }

    function openBoard(ws) {
        if (typeof openAppPageTab === 'function') {
            openAppPageTab('orchestration', ws || getWorkspace());
            return true;
        }
        return false;
    }

    // ---------- 审批卡 ----------

    // 编排工具用的确认框：必须能拿到取消结果（原生 confirmAction 是回调式，没有 cancel 回调）。
    function confirm(message, okLabel, title, variant) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                dlg.close();
                resolve(value);
            };
            const dlg = buildDialog(title || '确认', () => {
                if (!settled) {
                    settled = true;
                    resolve(false);
                }
            });
            dlg.body.appendChild(el('div', 'orch-confirm-text', message));
            const cancel = iconButton('取消', '', 'orch-btn', () => finish(false));
            const ok = iconButton(okLabel || '确认', 'check', 'orch-btn ' + (variant === 'danger' ? 'danger' : 'primary'),
                () => finish(true));
            dlg.foot.append(el('span', 'orch-spacer'), cancel, ok);
        });
    }

    function buildDialog(titleText, onDismiss) {
        const mask = el('div', 'orch-mask');
        const dialog = el('div', 'orch-dialog');
        const head = el('div', 'orch-dialog-head');
        head.appendChild(el('div', 'orch-dialog-title', titleText));
        const close = iconButton('', 'close', 'orch-icon-btn', () => closeDialog());
        head.appendChild(close);
        const body = el('div', 'orch-dialog-body');
        const foot = el('div', 'orch-dialog-foot');
        dialog.append(head, body, foot);
        document.body.append(mask, dialog);
        let handle = null;
        let closed = false;
        const onClose = () => {
            if (closed) return;
            closed = true;
            handle && handle.dispose();
            mask.remove();
            dialog.remove();
            if (typeof onDismiss === 'function') onDismiss();
        };
        handle = overlayStack.open({
            id: 'orchestration-dialog', kind: 'modal', el: dialog, underEl: mask,
            onClose,
        });
        mask.addEventListener('click', onClose);
        function closeDialog() { onClose(); }
        return {mask, dialog, head, body, foot, close: closeDialog};
    }

    function buildBatchEditor(batch, index, onChange) {
        const card = el('div', 'orch-batch-card');
        const top = el('div', 'orch-batch-top');
        const badge = el('span', 'orch-badge', batch.id || ('B' + (index + 1)));
        const title = createInput({value: batch.title || '', placeholder: '批次标题'}).control;
        title.className += ' orch-batch-title';
        const del = iconButton('删除', 'trash', 'orch-btn orch-btn-ghost', () => {
            card.remove();
            onChange();
        });
        top.append(badge, title, del);
        const spec = createTextarea({value: batch.spec || '', rows: 4, placeholder: '本批完整任务说明（派单时原样注入）'}).control;
        const owns = createInput({value: ownsToInput(batch.owns), placeholder: '可写 glob，逗号分隔；留空 = 只读'}).control;
        const depends = createInput({value: ownsToInput(batch.dependsOn), placeholder: '依赖的 work 批次 id，逗号分隔；留空 = 无依赖'}).control;
        const verify = createTextarea({value: formatVerifyEditor(batch.verify), rows: 2, placeholder: 'verify JSON（exe + argv），留空 = 无自动验收'}).control;
        const modelInput = createInput({value: (batch.model && (batch.model.first || batch.model.retry)) || '', placeholder: '模型 ref（仅用户授权白名单后生效）；留空 = 仲裁模型'}).control;
        card.append(
            top,
            labelRow('任务说明', spec),
            labelRow('可写路径', owns),
            labelRow('依赖批次', depends),
            labelRow('模型', modelInput),
            labelRow('验收命令', verify),
        );
        Object.assign(card, {__id: batch.id, __title: title, __spec: spec, __owns: owns, __verify: verify});
        card.__read = () => {
            const parsed = parseVerifyEditor(verify.value);
            const modelRef = String(modelInput.value || '').trim();
            return {
                ...normalizeBatch({
                    ...batch,
                    title: title.value,
                    spec: spec.value,
                    owns: ownsFromInput(owns.value),
                    dependsOn: ownsFromInput(depends.value),
                    model: modelRef ? {first: modelRef} : {},
                    verify: parsed.ok ? parsed.value : batch.verify,
                }, index),
                __verifyError: parsed.ok ? '' : parsed.error,
            };
        };
        return card;
    }

    function openApproval(input, ctx) {
        const session = ctx && ctx.session;
        if (!session) return Promise.reject(new Error('编排计划缺少会话上下文'));
        const ai = aiPanel();
        const model = ai && ai.bridgeSessionModelRef ? ai.bridgeSessionModelRef(session.id) : null;
        const windowWs = getWorkspace();
        const sessionWs = String(session.workspace || '').trim();
        if (sessionWs && windowWs && !acceptsWorkspace({root: sessionWs}, windowWs)) {
            return Promise.reject(new Error('会话属于工作区 ' + sessionWs + '，当前窗口是 '
                + windowWs + '；请在会话所属工作区的窗口里发起编排'));
        }
        const basePlan = buildPlanRequest(input, {
            workspace: sessionWs || windowWs,
            sessionId: session.id,
            group: session.group || '',
            scope: session.scope || 'read',
            modelRef: model ? model.ref : '',
        });
        // 设置页的跨编排默认值只在 AI 没显式给该字段时补位；不覆盖本次计划的明确选择。
        const defaults = (deps.getSettings ? deps.getSettings() : null) || {};
        const rawPolicy = input && input.policy && typeof input.policy === 'object' ? input.policy : {};
        if (rawPolicy.maxParallel == null && Number(defaults.orchMaxParallel) > 0) {
            basePlan.policy.maxParallel = Number(defaults.orchMaxParallel);
        }
        if (rawPolicy.maxAttemptsPerBatch == null && Number(defaults.orchMaxAttempts) > 0) {
            basePlan.policy.maxAttemptsPerBatch = Number(defaults.orchMaxAttempts);
        }
        if (rawPolicy.batchTimeoutMs == null && Number(defaults.orchBatchTimeoutSec) > 0) {
            basePlan.policy.batchTimeoutMs = Number(defaults.orchBatchTimeoutSec) * 1000;
        }
        if (rawPolicy.budgetTokens == null && Number(defaults.orchBudgetTokens) > 0) {
            basePlan.policy.budgetTokens = Number(defaults.orchBudgetTokens);
        }
        if (rawPolicy.review == null) {
            basePlan.policy.review = defaults.orchReview !== false;
        }
        basePlan.policy.auditIdleMs = computeAuditIdleMs(
            Number(defaults.orchAuditIdleSec) > 0 ? Number(defaults.orchAuditIdleSec) * 1000 : 2 * 60 * 60 * 1000,
            basePlan.policy, basePlan.batches,
        );
        return new Promise((resolve) => {
            let settled = false;
            let submitting = false;
            let dismissedWhileSubmitting = false;
            const finish = (text) => {
                if (settled) return;
                settled = true;
                resolve(text);
            };
            const dlg = buildDialog('编排计划审批', () => {
                if (submitting) {
                    // 创建请求已在飞：不能先回“未创建”，否则模型可能重复创建。
                    dismissedWhileSubmitting = true;
                    return;
                }
                finish('用户取消了编排计划，未创建。');
            });
            const body = dlg.body;
            const intro = el('div', 'orch-intro');
            intro.append(
                el('div', 'orch-title', basePlan.title),
                el('div', 'orch-goal', basePlan.goal || '（未填写目标）'),
                el('div', 'orch-muted',
                    '你批准的是「已批准边界内的自动重试」；越过 owns / 模型 / 预算 / 计划边界的动作仍会再确认。'
                    + ' Worker 拿不到命令、终端与 MCP，验收命令由编排器自己复跑。'),
                el('div', 'orch-muted',
                    '预估规模：' + basePlan.batches.length + ' 个批次；单批约 3–8 轮，总计约 '
                    + (basePlan.batches.length * 5) + ' 轮（预估，不是承诺）。'),
            );
            body.appendChild(intro);

            const policyRow = el('div', 'orch-policy');
            const concurrent = createInput({type: 'number', min: 1, max: 8, value: String(basePlan.policy.maxParallel)}).control;
            const attempts = createInput({type: 'number', min: 1, max: 2, value: String(basePlan.policy.maxAttemptsPerBatch)}).control;
            const budget = createInput({type: 'number', min: 0, value: String(basePlan.policy.budgetTokens || '')}).control;
            const timeoutSec = createInput({type: 'number', min: 60, value: String(Math.round(basePlan.policy.batchTimeoutMs / 1000))}).control;
            const review = createCheckbox({checked: basePlan.policy.review, label: '审查门（默认开；验收通过后派独立只读审查会话）'}).control;
            const autoRun = createCheckbox({checked: false, label: '全程由 agent 自主执行（禁止 awaiting_user）'}).control;
            const snapshot = createCheckbox({checked: false, label: '编排开始前创建快照（大项目可能几百 MB）'}).control;
            policyRow.append(
                labelRow('并发批次', concurrent), labelRow('单批尝试', attempts),
                labelRow('token 预算（事后熔断）', budget), labelRow('单批超时（秒）', timeoutSec),
                review.parentElement || review, autoRun.parentElement || autoRun, snapshot.parentElement || snapshot,
            );
            body.appendChild(policyRow);
            // 快照代价提示：有历史快照时显示上一次体积，让用户对耗时与磁盘有预期。
            try {
                Promise.resolve(call('WipeGuardSnapshotList', getWorkspace())).then((list) => {
                    const latest = (Array.isArray(list) ? list : [])
                        .slice().sort((a, b) => Number(b.at) - Number(a.at))[0];
                    if (!latest || !(Number(latest.bytes) > 0)) return;
                    const hint = el('span', 'orch-muted', '（上次快照 ' + Math.round(Number(latest.bytes) / (1024 * 1024)) + ' MB）');
                    (snapshot.parentElement || snapshot).appendChild(hint);
                }).catch(() => {});
            } catch (e) {}

            const modelBox = el('div', 'orch-models');
            const allowModels = createCheckbox({checked: false, label: '允许编排为批次指定模型（默认不许）'}).control;
            const modelList = createInput({placeholder: '模型 ref（账号id|模型id），逗号分隔，最多 5 条'}).control;
            const reviewModel = createInput({placeholder: '审查模型 ref；留空 = 仲裁模型'}).control;
            modelList.disabled = true;
            reviewModel.disabled = true;
            allowModels.addEventListener('change', () => {
                modelList.disabled = !allowModels.checked;
                reviewModel.disabled = !allowModels.checked;
            });
            modelBox.append(
                allowModels.parentElement || allowModels,
                labelRow('允许的模型', modelList),
                labelRow('审查模型', reviewModel),
                el('div', 'orch-muted', '当前仲裁模型：' + (model ? model.label + '（' + model.ref + '）' : '继承发起会话')),
            );
            body.appendChild(modelBox);

            const list = el('div', 'orch-batch-list');
            body.appendChild(list);
            const addBatch = iconButton('添加批次', 'plus', 'orch-btn orch-btn-ghost', () => {
                const used = new Set(Array.from(list.children).map((c) => c.__id).filter(Boolean));
                let n = 1;
                while (used.has('B' + n)) n++;
                list.appendChild(buildBatchEditor(normalizeBatch({id: 'B' + n}, list.children.length), list.children.length, noop));
            });
            body.appendChild(addBatch);
            const errorBox = el('div', 'orch-error');
            const previewBox = el('pre', 'orch-preview');
            body.append(errorBox, previewBox);
            const batchCards = [];
            for (let i = 0; i < basePlan.batches.length; i++) {
                const card = buildBatchEditor(basePlan.batches[i], i, noop);
                batchCards.push(card);
                list.appendChild(card);
            }

            const readPlan = () => {
                const batches = [];
                const errors = [];
                Array.from(list.children).forEach((card, index) => {
                    if (!card || typeof card.__read !== 'function') return;
                    const b = card.__read();
                    if (b.__verifyError) errors.push(b.id + '：' + b.__verifyError);
                    delete b.__verifyError;
                    batches.push(b);
                });
                const allowed = ownsFromInput(modelList.value);
                const policy = {
                    ...basePlan.policy,
                    maxParallel: Math.max(1, Math.min(8, Number(concurrent.value) || 2)),
                    maxAttemptsPerBatch: Math.max(1, Math.min(2, Number(attempts.value) || 2)),
                    budgetTokens: Number(budget.value) > 0 ? Number(budget.value) : 0,
                    batchTimeoutMs: Math.max(60, Number(timeoutSec.value) || 1200) * 1000,
                    review: review.checked,
                    reviewExplicit: true,
                    allowWorkerModels: allowModels.checked,
                    allowedWorkerModels: allowed.slice(0, 5),
                    reviewModel: allowModels.checked ? reviewModel.value.trim() : '',
                    autoRun: autoRun.checked,
                    snapshotBeforeStart: snapshot.checked,
                };
                policy.auditIdleMs = computeAuditIdleMs(basePlan.policy.auditIdleMs, policy, batches);
                return {
                    ...basePlan, policy,
                    batches,
                    __errors: errors,
                };
            };
            const preview = async () => {
                const plan = readPlan();
                if (plan.__errors.length) {
                    errorBox.textContent = plan.__errors.join('；');
                    return null;
                }
                const clean = Object.assign({}, plan);
                delete clean.__errors;
                try {
                    const res = await call('OrchestrationPlanPreview', JSON.stringify(clean));
                    if (!res || !res.valid) {
                        errorBox.textContent = (res && res.errors ? res.errors.join('；') : '计划校验失败');
                        previewBox.textContent = '';
                        return null;
                    }
                    errorBox.textContent = '';
                    const previewLines = ['执行顺序预览：'];
                    (res.waves || []).forEach((wave, i) => {
                        previewLines.push(`第 ${i + 1} 波：${wave.join('、') || '（空）'}`);
                    });
                    if ((res.forcedSerial || []).length) previewLines.push('串行约束：' + res.forcedSerial.join('；'));
                    if ((res.warnings || []).length) previewLines.push('提示：' + res.warnings.join('；'));
                    previewBox.textContent = previewLines.join('\n');
                    return {plan: clean, preview: res};
                } catch (e) {
                    errorBox.textContent = (e && e.message) || String(e);
                    return null;
                }
            };
            const previewBtn = iconButton('预览执行顺序', 'play', 'orch-btn orch-btn-ghost', () => { preview().catch(() => {}); });
            const cancel = iconButton('取消', '', 'orch-btn', () => {
                finish('用户取消了编排计划，未创建。');
                dlg.close();
            });
            const submit = iconButton('执行编排', 'check', 'orch-btn primary', async () => {
                const got = await preview();
                if (!got) return;
                submitting = true;
                submit.disabled = true;
                cancel.disabled = true;
                previewBtn.disabled = true;
                try {
                    const created = await call('OrchestrationCreate', JSON.stringify(got.plan));
                    const ai2 = aiPanel();
                    if (ai2 && ai2.bridgeAttachOrchestrationSession && session) {
                        ai2.bridgeAttachOrchestrationSession(session.id, {
                            id: created.id, role: 'arbiter', generation: 1, parentSessionId: session.id,
                        }, '');
                    }
                    if (created.warning) notify(created.warning, false);
                    openBoard(got.plan.workspace);
                    finish('编排已创建并启动：' + created.id + '（' + got.plan.title + '）'
                        + (created.warning ? '\n注意：' + created.warning : ''));
                    dlg.close();
                } catch (e) {
                    const msg = (e && e.message) || String(e);
                    notify('编排创建失败：' + msg, true);
                    if (dismissedWhileSubmitting || settled) {
                        finish('编排创建失败，未创建：' + msg);
                    } else {
                        errorBox.textContent = msg;
                    }
                } finally {
                    submitting = false;
                    submit.disabled = false;
                    cancel.disabled = false;
                    previewBtn.disabled = false;
                }
            });
            dlg.foot.append(previewBtn, el('span', 'orch-spacer'), cancel, submit);
            // 首次打开先跑一次纯内存 dry-run，让用户一眼看到并行顺序；编辑后重新点预览。
            preview().catch(() => {});
            // 卡片删除 / 添加不自动预览；用户点预览或执行时统一重算。
            function noop() {}
        });
    }

    // ---------- 工具适配 ----------

    async function runTool(name, input, ctx) {
        const session = ctx && ctx.session;
        if (name === 'orchestration_plan') {
            return openApproval(input, ctx);
        }
        if (name === 'orchestration_status') {
            const id = String((input && input.orchestrationId) || '').trim();
            if (id) {
                const view = await call('OrchestrationGet', id);
                return [summarizeView(view), ...formatBatchTable(view)].join('\n');
            }
            const list = (await call('OrchestrationList')) || [];
            if (!list.length) return '当前工作区没有编排。';
            return '当前工作区编排：\n' + list.map((item) =>
                `- ${item.id}「${item.title}」${statusLabel(item.status)} · ${item.doneWork}/${item.totalWork} 批` +
                (item.failedWork ? ` · ${item.failedWork} 批失败` : '') +
                (item.hasAttention ? ' · 需要处理' : '')).join('\n');
        }
        if (name === 'orchestration_report') {
            const token = await tokenForSession(session);
            if (!token) throw new Error('本会话不属于任何编排批次，orchestration_report 不可用');
            const payload = Object.assign({}, input, {
                batchId: input && input.batchId,
                reportId: input && input.reportId,
            });
            // awaiting_user 的超时语义与 ask_user 同源：模型省略时由宿主补默认值。
            if (payload.status === 'awaiting_user' && payload.question && typeof payload.question === 'object') {
                const ai = aiPanel();
                const d = ai && ai.bridgeAskTimeoutDefaults ? ai.bridgeAskTimeoutDefaults() : null;
                if (d) {
                    if (!(Number(payload.question.timeoutSec) > 0) && d.timeoutSec > 0) {
                        payload.question.timeoutSec = d.timeoutSec;
                    }
                    if (!payload.question.timeoutAction) {
                        // ask_user 设置 0 = 不限时；编排侧用 timeoutAction=wait 表达「宁可挂住」，
                        // 不能让它走 Go 的缺省 600s + recommended 自动作答。
                        payload.question.timeoutAction = d.timeoutSec > 0
                            ? (d.timeoutAction || 'recommended') : 'wait';
                    }
                }
            }
            // 只允许票据绑定的 batchId 被验证；模型传别人的值会被 Go 拒绝。
            const res = await call('OrchestrationReport', token, JSON.stringify(payload));
            const base = (res && res.message) || '报告已受理';
            if (payload.status === 'awaiting_user') {
                return base + '\n已登记等待用户回答，请结束本轮，不要再继续执行本批；用户回答后会由编排器重新派发。';
            }
            if (payload.status === 'done') {
                return base + '\n编排器将自行复跑验收并派独立审查；本轮可以收尾。';
            }
            return base + '\n已交给编排器/仲裁者，本轮可以收尾。';
        }
        if (name === 'orchestration_control') {
            if (!session) throw new Error('缺少会话上下文');
            if (!session.orchestration || session.orchestration.role !== 'arbiter') {
                throw new Error('只有当前仲裁者可以执行编排控制动作');
            }
            const req = Object.assign({}, input, {
                arbiterSessionId: session.id,
                generation: Number(session.orchestration.generation) || 0,
            });
            const label = String(req.action || '');
            const affected = label === 'stop' ? '这会停止全部执行会话与待派批次（已完成改动保留）。' : '这会改变用户已批准的编排边界。';
            const ok = await confirm(`执行 orchestration_control ${label}？
${affected}`, '确认执行', '编排控制', label === 'stop' ? 'danger' : '');
            if (!ok) return '用户取消了编排控制动作。';
            const res = await call('OrchestrationControl', JSON.stringify(req));
            return '编排控制已受理：' + (res && res.message ? res.message : statusLabel(res && res.status));
        }
        throw new Error('未知编排工具：' + name);
    }

    async function authorizeWrite(session, path) {
        const info = session && session.orchestration;
        if (!info || (info.role !== 'work' && info.role !== 'review')) return {allowed: true};
        const token = await tokenForSession(session);
        if (!token) return {allowed: false, message: '编排执行票据已失效（可能已被重派）；请回报 blocked 或等待新会话'};
        const result = await call('OrchestrationAuthorizeWrite', token, String(path || ''));
        return result || {allowed: false, message: '写闸无响应'};
    }

    async function sendTurnEvent(session, kind, reason) {
        if (!session || !session.orchestration) return;
        const token = await tokenForSession(session);
        if (!token) return;
        try {
            await call('OrchestrationTurnEvent', JSON.stringify({token, kind, reason: reason || ''}));
        } catch (e) {
            // 尽力而为：事件丢失只影响失败分类，deadline 兜底仍会判 stalled。
        }
    }

    function onTurnStarted(session) {
        sendTurnEvent(session, 'turn_started', '').catch(() => {});
    }

    function onTurnWaiting(session, waiting) {
        const info = session && session.orchestration;
        if (!info) return;
        if (waiting) sendTurnEvent(session, 'waiting_approval', '').catch(() => {});
        else sendTurnEvent(session, 'turn_started', '').catch(() => {});
    }

    function onTurnFinished(session, fact) {
        const info = session && session.orchestration;
        if (!info) return;
        if (fact && fact.stopped) {
            sendTurnEvent(session, 'turn_failed', 'user stopped').catch(() => {});
        } else if (fact && fact.status === 'error') {
            sendTurnEvent(session, 'turn_failed', fact.error || 'turn error').catch(() => {});
        } else {
            sendTurnEvent(session, 'turn_finished', '').catch(() => {});
        }
    }

    // ---------- 派发宿主 ----------

    function effectiveModel(view, batch) {
        const o = view.orchestration || {};
        const policy = o.policy || {};
        if (batch.kind === 'review') return policy.reviewModel || o.arbiterModelRef || '';
        const attempt = Number(batch.attempts || 0) + 1;
        const requested = attempt > 1
            ? ((batch.model && batch.model.retry) || (batch.model && batch.model.first) || '')
            : ((batch.model && batch.model.first) || '');
        if (!policy.allowWorkerModels || !requested) return o.arbiterModelRef || '';
        return (policy.allowedWorkerModels || []).includes(requested) ? requested : (o.arbiterModelRef || '');
    }

    async function handleDispatch(payload) {
        if (!payload || !acceptsWorkspace(payload.root, getWorkspace())) return;
        const key = payload.orchestrationId + '#' + payload.batchId;
        if (inflightClaims.has(key)) return;
        inflightClaims.add(key);
        try {
            const claim = await call('OrchestrationClaimBatch', JSON.stringify({
                orchestrationId: payload.orchestrationId,
                batchId: payload.batchId,
                expectedAttempt: payload.expectedAttempt,
            }));
            if (!claim || !claim.ok) return;
            const view = await call('OrchestrationGet', payload.orchestrationId);
            const o = view && view.orchestration;
            const batch = view && (view.batches || []).find((b) => b.id === payload.batchId);
            const ai = ensureAI();
            if (!o || !batch || !ai || !ai.bridgeCreateOrchestrationSession) {
                await call('OrchestrationAbortStart', JSON.stringify({
                    orchestrationId: payload.orchestrationId, batchId: payload.batchId,
                    token: claim.claimToken, reason: '宿主不可用',
                })).catch?.(() => {});
                return;
            }
            const role = batch.kind === 'review' ? 'review' : 'work';
            // owns 为空的 work 是只读设计批次：会话档位也建成 read，与后端 StartResponse 对齐。
            const scope = (role === 'review' || !(batch.owns || []).length)
                ? 'read' : ((o.policy && o.policy.scope) || 'edit');
            const title = role === 'review' ? ('审查 · ' + o.title) : (batch.title || '编排批次');
            const session = await ai.bridgeCreateOrchestrationSession({
                title,
                callerSessionId: o.parentSessionId,
                workspace: (o.workspaces && o.workspaces[0]) || '',
                scope,
                group: o.groupSnapshot || '',
                modelRef: effectiveModel(view, batch),
            });
            let start = null;
            try {
                start = await call('OrchestrationStartBatch', JSON.stringify({
                    orchestrationId: payload.orchestrationId,
                    batchId: payload.batchId,
                    claimToken: claim.claimToken,
                    sessionId: session.id,
                }));
                await ai.bridgeAttachOrchestrationSession(session.id, {
                    id: o.id, batchId: batch.id, attempt: start.attempt, role,
                    parentSessionId: o.parentSessionId, owns: batch.owns || [], generation: 0,
                }, start.executionToken);
                const turn = await ai.bridgeOrchestrationStartTurn(session.id, start.prompt);
                if (turn && turn.ok === false) {
                    throw new Error('起轮被拒：' + (turn.reason || '未知原因'));
                }
            } catch (e) {
                const token = (start && start.executionToken) || claim.claimToken;
                try {
                    await call('OrchestrationAbortStart', JSON.stringify({
                        orchestrationId: payload.orchestrationId, batchId: payload.batchId,
                        token, reason: (e && e.message) || 'start failed',
                    }));
                } catch (abortErr) {
                    // 已超过基础设施回滚窗口：把这次失败按回合失败结清，避免批次挂在 running。
                    if (start && start.executionToken) {
                        try {
                            await call('OrchestrationTurnEvent', JSON.stringify({
                                token: start.executionToken, kind: 'turn_failed',
                                reason: (e && e.message) || 'start failed',
                            }));
                        } catch (turnErr) {}
                    }
                }
                if (ai.bridgeDiscardOrchestrationSession) ai.bridgeDiscardOrchestrationSession(session.id);
                notify('编排派发失败：' + ((e && e.message) || e), true);
            }
        } finally {
            inflightClaims.delete(key);
        }
    }

    async function handleArbiterEvent(payload) {
        if (!payload || !acceptsWorkspace(payload.root, getWorkspace())) return;
        const ai = ensureAI();
        if (payload.sessionId) {
            let delivered = null;
            if (ai && ai.bridgeDeliverOrchestrationEvent) {
                delivered = ai.bridgeDeliverOrchestrationEvent(payload.sessionId, payload.text, payload.eventId);
            }
            if (delivered && delivered.ok === false) {
                notify('仲裁事件投递失败（' + (delivered.reason || '会话不可用') + '），编排状态仍已落盘，请打开看板处理。', true);
            }
            if (ai && ai.bridgeSessionUsage) {
                const usage = ai.bridgeSessionUsage(payload.sessionId);
                if (usage && usage.window > 0) {
                    call('OrchestrationReportArbiterUsage', payload.orchestrationId, payload.sessionId,
                        Number(payload.generation) || 0, Number(usage.used) || 0, Number(usage.window) || 0).catch(() => {});
                }
            }
        } else {
            notify('编排需要人工仲裁，但当前没有可用仲裁会话；请打开看板处理。', true);
        }
        refreshBoards(payload.root);
    }

    async function performHandoff(payload) {
        if (!payload || !acceptsWorkspace(payload.root, getWorkspace())) return;
        if (handoffInFlight.has(payload.orchestrationId)) return;
        handoffInFlight.add(payload.orchestrationId);
        const ai = ensureAI();
        if (!ai || !ai.bridgeCreateOrchestrationSession) { handoffInFlight.delete(payload.orchestrationId); return; }
        try {
            const view = await call('OrchestrationGet', payload.orchestrationId);
            const o = view && view.orchestration;
            if (!o) return;
            const ratio = batchDoneRatio(view);
            const oldTitle = '编排';
            const created = await ai.bridgeCreateOrchestrationSession({
                title: '编排仲裁·接替「' + (o.title || oldTitle) + '」',
                callerSessionId: o.parentSessionId,
                workspace: (o.workspaces && o.workspaces[0]) || '',
                scope: 'read',
                modelRef: o.arbiterModelRef || '',
            });
            await call('OrchestrationSetArbiter', o.id, created.id, payload.reason || '仲裁者交接');
            const fresh = await call('OrchestrationGet', o.id);
            const generation = fresh && fresh.orchestration ? fresh.orchestration.arbiter.generation : 0;
            await ai.bridgeAttachOrchestrationSession(created.id, {
                id: o.id, role: 'arbiter', generation, parentSessionId: o.parentSessionId,
            }, '');
            const brief = [
                '你在担任一个编排的「仲裁者」。',
                '- 总目标：' + (o.goal || ''),
                '- 计划：' + (o.batches || []).filter((b) => b.kind !== 'review')
                    .map((b) => `${b.id}「${b.title}」${batchStatusLabel(b.status)}`).join('；'),
                '- 已完成：' + ratio.work + ' 批',
                '- 你的职责：只做判断性决策；确定性推进交给 Router。',
                '- 约束：除非用户要求，不要自己动手改文件（你是仲裁者，不是执行者）。',
                '- 交接原因：' + (payload.reason || '仲裁者失效 / 上下文将满'),
            ].join('\n');
            if (ai.bridgeOrchestrationStartTurn) {
                await ai.bridgeOrchestrationStartTurn(created.id, brief);
            }
            if (ai.bridgeDeliverOrchestrationEvent && payload.sessionId) {
                ai.bridgeDeliverOrchestrationEvent(payload.sessionId,
                    '［编排交接］仲裁者已交接给会话 ' + created.id + '，原因：' + (payload.reason || '失效'), '');
            }
            notify('编排仲裁已交接给新会话', false);
        } catch (e) {
            notify('仲裁者交接失败：' + ((e && e.message) || e), true);
        } finally {
            handoffInFlight.delete(payload.orchestrationId);
        }
    }

    function handleStop(payload) {
        if (!payload || !acceptsWorkspace(payload.root, getWorkspace())) return;
        const ai = aiPanel();
        if (ai && ai.bridgeStopOrchestrationSessions) {
            ai.bridgeStopOrchestrationSessions(payload.sessionIds || []);
        }
        refreshBoards(payload.root);
    }

    function handleEvent(name, payload) {
        if (name === 'orchestration-dispatch') {
            handleDispatch(payload).catch((e) => notify('编排派发失败：' + ((e && e.message) || e), true));
        } else if (name === 'orchestration-changed' || name === 'orchestration-audit') {
            syncSessionSnapshot(payload).catch(() => {});
            refreshBoards(payload && payload.root);
        } else if (name === 'orchestration-arbiter-event') {
            handleArbiterEvent(payload).catch(() => {});
        } else if (name === 'orchestration-arbiter-handoff') {
            performHandoff(payload).catch(() => {});
        } else if (name === 'orchestration-stop') {
            handleStop(payload);
        }
    }

    // 会话列表投影：父会话显示进度、批次子项显示状态。事件里的 summary 已够父行用；
    // 子项状态再拉一次详情（失败静默，下一次事件会补）。
    // 启动 / 面板初始化后补一次投影：重启后没有历史事件，父会话进度与失败自动展开仍需恢复。
    async function bootstrapSessionProjections() {
        const ai = aiPanel();
        if (!ai || !ai.bridgeApplyOrchestrationSnapshot) return;
        try {
            const list = (await call('OrchestrationList')) || [];
            for (const item of list) {
                try {
                    const view = await call('OrchestrationGet', item.id);
                    if (view && view.orchestration) {
                        ai.bridgeApplyOrchestrationSnapshot(item.id, view.orchestration.parentSessionId || '',
                            item, view.batches || []);
                    }
                } catch (e) {}
            }
        } catch (e) {}
    }

    async function syncSessionSnapshot(payload) {
        if (!payload || !payload.orchestrationId) return;
        const ai = aiPanel();
        if (!ai || !ai.bridgeApplyOrchestrationSnapshot) return;
        let view = null;
        try { view = await call('OrchestrationGet', payload.orchestrationId); } catch (e) {}
        if (!view) return;
        const o = view.orchestration || {};
        ai.bridgeApplyOrchestrationSnapshot(payload.orchestrationId, o.parentSessionId || '', payload.summary || null, view.batches || []);
    }

    function refreshBoards(root) {
        for (const board of boards) {
            if (!root || acceptsWorkspace({root}, board.workspace)) {
                board.refresh().catch(() => {});
            }
        }
    }

    // ---------- 看板 ----------

    function formatBatchTable(view) {
        const lines = [];
        const batches = (view && view.batches) || [];
        for (const b of batches) {
            if (b.kind === 'review') continue;
            lines.push(`${b.id}「${b.title}」${batchStatusLabel(b.status)}` +
                (b.failureReason ? ' · ' + failureLabel(b.failureReason) : '') +
                (b.attempts ? ' · 尝试 ' + b.attempts : '') +
                (b.owns && b.owns.length ? ' · owns ' + b.owns.join(',') : ' · 只读'));
            for (const r of batches.filter((x) => x.kind === 'review' && x.reviewOf === b.id)) {
                lines.push('  ↳ ' + r.id + ' ' + batchStatusLabel(r.status));
            }
        }
        return lines;
    }

    async function userControl(id, action, batchId, extra) {
        const req = Object.assign({orchestrationId: id, action, batchId: batchId || ''}, extra || {});
        const res = await call('OrchestrationUserControl', JSON.stringify(req));
        refreshBoards();
        return res;
    }

    async function promptText(title, message, initial) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            const dlg = buildDialog(title, () => finish(''));
            dlg.body.appendChild(el('div', 'orch-muted', message));
            const ta = createTextarea({value: initial || '', rows: 3}).control;
            dlg.body.appendChild(ta);
            const cancel = iconButton('取消', '', 'orch-btn', () => { finish(''); dlg.close(); });
            const ok = iconButton('提交', 'check', 'orch-btn primary', () => { const v = ta.value.trim(); finish(v); dlg.close(); });
            dlg.foot.append(el('span', 'orch-spacer'), cancel, ok);
            setTimeout(() => ta.focus(), 0);
        });
    }

    async function onBoardAction(board, action, batch, view) {
        const o = view.orchestration;
        const safe = (fn) => async () => {
            try { await fn(); } catch (e) { notify('操作失败：' + ((e && e.message) || e), true); }
        };
        try {
            if (action === 'delete') {
                confirmAction('删除这条编排记录？不会删除任何会话，也不会回滚已完成的改动。', safe(async () => {
                    await call('OrchestrationDelete', o.id);
                    board.selected = '';
                    refreshBoards();
                }), '删除记录', '删除编排', 'danger');
                return;
            }
            if (action === 'answer') {
                const answer = await promptText('回答编排问题', batch.question ? batch.question.text : '请输入回答', '');
                if (!answer) return;
                await userControl(o.id, 'answer', batch.id, {answer});
                return;
            }
            if (action === 'edit_batch') {
                const spec = await promptText('修改未派发批次', '只允许修改尚未派发过的批次；改完立即按新 spec 派发。', batch.spec || '');
                if (!spec) return;
                const draft = {
                    id: batch.id, title: batch.title, spec,
                    owns: batch.owns || [], dependsOn: batch.dependsOn || [],
                    verify: batch.verify || [], timeoutMs: batch.timeoutMs || 0, model: batch.model || {},
                };
                await userControl(o.id, 'update_batch', batch.id, {batch: draft});
                return;
            }
            if (action === 'export') {
                const eventLines = (view.recentEvents || []).map((e) =>
                    `${formatWhen(e.at)} ${e.kind}${e.batch ? ' [' + e.batch + ']' : ''} ${e.why || ''}`);
                const text = [
                    summarizeView(view),
                    formatBatchTable(view).join('\n'),
                    '事件：',
                    eventLines.join('\n'),
                ].join('\n\n');
                const ok = await copyTextToClipboard(text, {goCopy: (t) => call('CopyText', t)});
                notify(ok ? '编排报告已复制到剪贴板' : '复制失败', !ok);
                return;
            }
            if (action === 'stop') {
                const active = (view.batches || []).filter((b) => ['running', 'dispatched', 'reviewing'].includes(b.status));
                confirmAction('将停止 ' + active.length + ' 个执行会话；已完成的批次改动会保留，不会回滚。',
                    safe(async () => { await userControl(o.id, 'stop'); }), '停止编排', '停止编排', 'danger');
                return;
            }
            if (action === 'retry') {
                confirmAction('重置该批 attempts 并重新派发？这会越过原 attempts 上限。',
                    safe(async () => { await userControl(o.id, 'retry', batch.id); }), '重派', '重派批次');
                return;
            }
            if (action === 'skip') {
                confirmAction('跳过该批次？下游依赖可能因此无法满足。',
                    safe(async () => { await userControl(o.id, 'skip', batch.id); }), '跳过', '跳过批次', 'danger');
                return;
            }
            if (action === 'pause' || action === 'resume') {
                await userControl(o.id, action);
                return;
            }
            if (action === 'resolve') {
                const ev = (o.arbitrationQueue || []).find((e) => !e.resolved);
                if (!ev) return;
                const why = await promptText('裁决说明', '事件：' + ev.reason + '\n' + (ev.detail || ''), '');
                if (!why) return;
                await userControl(o.id, 'resolve_arbitration', ev.batchId, {expectedEventId: ev.eventId, answer: why});
                return;
            }
        } catch (e) {
            notify('操作失败：' + ((e && e.message) || e), true);
        }
    }

    function renderBoard(board) {
        const {root} = board;
        root.textContent = '';
        root.className = 'orch-board';
        const wrap = el('div', 'orch-board-wrap');
        root.appendChild(wrap);
        const head = el('div', 'orch-board-head');
        const title = el('div', 'orch-board-title', '编排');
        const refreshBtn = iconButton('刷新', 'refresh', 'orch-btn orch-btn-ghost', () => board.refresh());
        head.append(title, el('span', 'orch-spacer'), refreshBtn);
        wrap.appendChild(head);
        const main = el('div', 'orch-board-main');
        const listCol = el('div', 'orch-board-list');
        const detailCol = el('div', 'orch-board-detail');
        main.append(listCol, detailCol);
        wrap.appendChild(main);
        listCol.textContent = '正在读取…';
        detailCol.textContent = '选择一条编排查看详情。';
        board.refresh = async () => {
            if (!root.isConnected) return;
            try {
                const list = (await call('OrchestrationList')) || [];
                listCol.textContent = '';
                if (!list.length) {
                    listCol.appendChild(el('div', 'orch-empty', '当前工作区还没有编排。在 AI 会话里用 orchestration_plan 发起，或查看帮助了解与群聊/子代理的边界。'));
                    return;
                }
                for (const item of list) {
                    const row = el('button', 'orch-list-row' + (item.id === board.selected ? ' active' : ''));
                    row.type = 'button';
                    const ratio = item.totalWork ? item.doneWork + '/' + item.totalWork : '0/0';
                    row.append(
                        el('span', 'orch-row-title', item.title || item.id),
                        el('span', 'orch-row-meta', statusLabel(item.status) + ' · ' + ratio + (item.hasAttention ? ' · 需处理' : '')),
                    );
                    row.classList.toggle('attention', !!item.hasAttention);
                    row.addEventListener('click', () => {
                        board.selected = item.id;
                        renderBoard(board);
                    });
                    listCol.appendChild(row);
                }
                if (!board.selected && list[0]) board.selected = list[0].id;
                if (board.selected) await renderDetail(detailCol, board);
            } catch (e) {
                listCol.textContent = '读取失败：' + ((e && e.message) || e);
            }
        };
        board.refresh().catch(() => {});
    }

    async function renderDetail(host, board) {
        host.textContent = '正在读取…';
        let view;
        try {
            view = await call('OrchestrationGet', board.selected);
        } catch (e) {
            host.textContent = '读取失败：' + ((e && e.message) || e);
            return;
        }
        const o = view.orchestration;
        host.textContent = '';
        const head = el('div', 'orch-detail-head');
        head.appendChild(el('div', 'orch-detail-title', o.title || o.id));
        const st = el('span', 'orch-state orch-state-' + String(o.status || 'unknown'), statusLabel(o.status));
        head.appendChild(st);
        if (o.status === 'paused_no_window') head.appendChild(el('span', 'orch-muted', '窗口关闭时自动冻结，不会烧钱；重开窗口后恢复。'));
        host.appendChild(head);
        if (o.goal) host.appendChild(el('div', 'orch-detail-goal', o.goal));
        const ratio = batchDoneRatio(view);
        const stats = el('div', 'orch-stats',
            ratio.work + ' 批（审查 ' + ratio.review + '） · attempts/rework ' + (o.stats.rework || 0) +
            ' · ' + (o.stats.tokensUsed || 0) + ' tokens' +
            (o.snapshot ? ' · 开始前快照 ' + (o.snapshot.name || '有') : ''));
        host.appendChild(stats);
        const bar = el('div', 'orch-actions');
        if (typeof deps.openOrchestrationTab === 'function') {
            bar.appendChild(iconButton('在新标签页打开', 'new-window', 'orch-btn orch-btn-ghost', () => {
                deps.openOrchestrationTab({id: o.id, title: o.title, workspace: o.workspaces && o.workspaces[0]});
            }));
        }
        const controls = [
            ['pause', '暂停'], ['resume', '恢复'], ['stop', '停止'],
            ['resolve', '裁决待处理事件'], ['export', '复制报告'],
            ['delete', '删除记录'],
        ];
        for (const [action, label] of controls) {
            if (action === 'delete' && !isTerminalStatus(o.status)) continue;
            if (action === 'resolve' && !(o.arbitrationQueue || []).some((e) => !e.resolved)) continue;
            bar.appendChild(iconButton(label, action === 'stop' ? 'stop' : (action === 'pause' ? 'pause' : (action === 'export' ? 'copy' : 'play')),
                'orch-btn' + (action === 'stop' ? ' danger' : ''), () => onBoardAction(board, action, null, view)));
        }
        host.appendChild(bar);

        const batches = el('div', 'orch-batches');
        const works = (view.batches || []).filter((b) => b.kind !== 'review');
        for (const b of works) {
            batches.appendChild(renderBatchRow(b, view, board));
            for (const r of (view.batches || []).filter((x) => x.kind === 'review' && x.reviewOf === b.id)) {
                batches.appendChild(renderBatchRow(r, view, board, true));
            }
        }
        host.appendChild(batches);

        // 执行会话：批次 → 会话 id，附模型/用量/子代理数；可一键切到该会话。
        const ai = aiPanel();
        const sessions = ai && ai.bridgeListSessions ? (ai.bridgeListSessions('') || []) : [];
        const sessionById = new Map(sessions.map((s) => [s.id, s]));
        const sessionRows = (view.batches || []).filter((b) => b.sessionId);
        if (sessionRows.length) {
            const sessionsBox = el('div', 'orch-section');
            sessionsBox.appendChild(el('div', 'orch-section-title', '执行会话'));
            for (const b of sessionRows) {
                const s = sessionById.get(b.sessionId);
                const usage = ai && ai.bridgeSessionUsage ? ai.bridgeSessionUsage(b.sessionId) : {used: 0, window: 0};
                const agents = ai && ai.bridgeOrchestrationAgents ? (ai.bridgeOrchestrationAgents(b.sessionId) || []) : [];
                const row = el('div', 'orch-session-row');
                const text = [
                    b.id + '「' + b.title + '」',
                    s ? (s.title || b.sessionId) : b.sessionId,
                    s ? '权限 ' + (s.scope || 'read') + ' · ' + (s.messages || 0) + ' 条消息' : '会话不在本窗口列表',
                    usage.window > 0 ? '上下文 ' + Math.round((usage.used / usage.window) * 100) + '%' : '上下文用量未知',
                    agents.length ? '子代理 ' + agents.length : '无子代理',
                ].join(' · ');
                row.appendChild(el('span', 'orch-session-text', text));
                if (s && ai && ai.bridgeSwitchSession) {
                    row.appendChild(iconButton('切到会话', 'sidechat', 'orch-btn orch-btn-ghost', () => {
                        ai.bridgeSwitchSession(b.sessionId).catch((e) => notify('切换失败：' + ((e && e.message) || e), true));
                    }));
                }
                sessionsBox.appendChild(row);
            }
            host.appendChild(sessionsBox);
        }

        // 子代理：聚合所有执行会话的 HUD 条目（复用同一份数据，不重写树构建）。
        if (ai && ai.bridgeOrchestrationAgents) {
            const children = [];
            for (const b of sessionRows) {
                for (const agent of (ai.bridgeOrchestrationAgents(b.sessionId) || [])) {
                    children.push({agent, batch: b});
                }
            }
            if (children.length) {
                const agentsBox = el('div', 'orch-section');
                agentsBox.appendChild(el('div', 'orch-section-title', '子代理'));
                for (const {agent, batch} of children) {
                    agentsBox.appendChild(el('div', 'orch-agent-row',
                        batch.id + ' · ' + (agent.name || agent.subId || agent.key) + ' · ' +
                        (agent.state || 'running') + (agent.rounds ? ' · ' + agent.rounds + ' 轮' : '') +
                        (agent.tokens ? ' · ' + agent.tokens + ' tokens' : '') +
                        (agent.sandboxMode ? ' · 沙箱 ' + agent.sandboxMode : '')));
                }
                host.appendChild(agentsBox);
            }
        }

        // 仲裁者交接历史（可替换角色的审计面）。
        if (o.arbiter && Array.isArray(o.arbiter.handoffs) && o.arbiter.handoffs.length) {
            const handoffBox = el('div', 'orch-section');
            handoffBox.appendChild(el('div', 'orch-section-title', '仲裁者交接'));
            for (const h of o.arbiter.handoffs) {
                handoffBox.appendChild(el('div', 'orch-agent-row',
                    formatWhen(h.at) + ' · ' + (h.from || '—') + ' → ' + (h.to || '—') + ' · ' + (h.reason || '')));
            }
            host.appendChild(handoffBox);
        }
        const events = el('details', 'orch-events');
        events.appendChild(el('summary', '', '最近事件（' + (view.recentEvents || []).length + '）'));
        const list = el('div', 'orch-event-list');
        for (const e of (view.recentEvents || []).slice().reverse()) {
            list.appendChild(el('div', 'orch-event', `${formatWhen(e.at)} ${e.kind}${e.batch ? ' [' + e.batch + ']' : ''} ${e.why || ''}`));
        }
        events.appendChild(list);
        host.appendChild(events);
    }

    function renderBatchRow(b, view, board, review) {
        const row = el('div', 'orch-batch-row' + (review ? ' review' : '') + ' attention-' + String(b.status));
        const top = el('div', 'orch-batch-row-top');
        const badge = el('span', 'orch-badge', b.id);
        const title = el('span', 'orch-batch-title', b.title);
        const state = el('span', 'orch-batch-state', batchStatusLabel(b.status) + (b.attempts ? ' · ' + b.attempts + ' 次' : ''));
        top.append(badge, title, state);
        row.appendChild(top);
        const meta = [];
        if (b.owns && b.owns.length) meta.push('owns：' + b.owns.join(', '));
        else meta.push('只读');
        if (b.failureReason) meta.push('原因：' + failureLabel(b.failureReason));
        if (b.deadline) meta.push('剩余：' + formatElapsed(b.deadline - Date.now()));
        if (b.sessionId) meta.push('会话：' + b.sessionId);
        row.appendChild(el('div', 'orch-batch-meta', meta.join(' · ')));
        const actions = el('div', 'orch-batch-actions');
        if (b.status === 'awaiting_user') {
            actions.appendChild(iconButton('回答', 'question', 'orch-btn orch-btn-ghost', () => onBoardAction(board, 'answer', b, view)));
        }
        if (['failed', 'blocked', 'awaiting_user', 'pending'].includes(b.status) && !review) {
            actions.appendChild(iconButton('重派', 'refresh', 'orch-btn orch-btn-ghost', () => onBoardAction(board, 'retry', b, view)));
        }
        if (b.status === 'pending' && !review && !Number(b.attempts)) {
            actions.appendChild(iconButton('改草稿', 'rename', 'orch-btn orch-btn-ghost', () => onBoardAction(board, 'edit_batch', b, view)));
        }
        if (['pending', 'failed', 'blocked'].includes(b.status) && !review) {
            actions.appendChild(iconButton('跳过', 'close', 'orch-btn orch-btn-ghost', () => onBoardAction(board, 'skip', b, view)));
        }
        if (actions.children.length) row.appendChild(actions);
        return row;
    }

    function mountBoard(root, workspace, options) {
        const wanted = options && options.selected ? String(options.selected) : '';
        const board = {
            root, workspace: workspace || getWorkspace(), selected: wanted,
            refresh: async () => {},
        };
        boards.add(board);
        renderBoard(board);
        const timer = setInterval(() => { board.refresh().catch(() => {}); }, 5000);
        return () => {
            clearInterval(timer);
            boards.delete(board);
        };
    }

    return {
        infoOf,
        runTool,
        authorizeWrite,
        onTurnStarted,
        onTurnFinished,
        onTurnWaiting,
        handleEvent,
        mountBoard,
        openBoard,
        openApproval,
        refreshBoards,
        bootstrapSessionProjections,
    };
}
// createOrchestrationHost：组合根唯一需要的编排入口。把域懒创建、AI 适配器、
// 常驻事件订阅、看板挂载与启动投影都收在本模块，main.js 只保留接线一行。
export function createOrchestrationHost(deps) {
    let domain = null;
    const ensure = () => {
        if (!domain) domain = createOrchestrationDomain(deps);
        return domain;
    };
    const adapter = {
        // 有编排归属的会话才需要域；infoOf 与写闸都 fail-closed，不能依赖“面板初始化时
        // 恰好创建过 domain”的隐式时序。
        infoOf: (session) => (session && session.orchestration ? ensure().infoOf(session) : null),
        runTool: (name, input, ctx) => ensure().runTool(name, input, ctx),
        authorizeWrite: (session, path) => (session && session.orchestration
            ? ensure().authorizeWrite(session, path)
            : Promise.resolve({allowed: true})),
        onTurnStarted: (session) => { if (domain) domain.onTurnStarted(session); },
        onTurnFinished: (session, fact) => { if (domain) domain.onTurnFinished(session, fact); },
        onTurnWaiting: (session, waiting) => { if (domain) domain.onTurnWaiting(session, waiting); },
        refreshProjections: () => ensure().bootstrapSessionProjections(),
    };
    function subscribe(appEvents, getWorkspace) {
        for (const eventName of [
            'orchestration-dispatch', 'orchestration-changed', 'orchestration-stop',
            'orchestration-arbiter-event', 'orchestration-arbiter-handoff', 'orchestration-audit',
        ]) {
            appEvents.onWorkspace(eventName, getWorkspace, (payload) => {
                ensure().handleEvent(eventName, payload);
            });
        }
    }
    return {
        adapter,
        ensure,
        subscribe,
        mountBoard: (root, workspace, options) => ensure().mountBoard(root, workspace, options),
        bootstrapSessionProjections: () => ensure().bootstrapSessionProjections(),
    };
}
