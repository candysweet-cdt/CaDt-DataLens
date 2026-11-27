// orchestration-ui.js：编排域的宿主接线与界面（审批卡 / 看板 / 工具适配）。
//
// 依赖全部经 deps 注入（AI 面板、事件、确认框、表单控件都由 main 接线），
// 本模块不 import main.js，也不在模块顶层抓 DOM。真正判定都在 Go Router。
import {createCheckbox, createInput, createTextarea} from '../core/form-controls.js';
import {copyTextToClipboard} from '../core/clipboard.js';
import {iconSvg} from '../core/icons.js';
import {overlayStack} from '../core/overlay-stack.js';
import {isMultiWorkspace} from '../core/root-scope.js';
import {
    acceptsWorkspace, batchDoneRatio, batchStatusLabel, buildPlanRequest, computeAuditIdleMs, failureLabel,
    formatElapsed, isTerminalStatus, ownsFromInput, ownsToInput,
    statusLabel, summarizeView,
} from './orchestration-model.js';
import {buildExecutionGraph, renderExecutionGraph} from './orchestration-graph.js';

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

    // 计划结构由母会话生成：标题/描述/依赖/范围/验收只读，用户只调参数（超时/模型）。
    function advancedSummary(hint) {
        const summary = el('summary', 'orch-advanced-summary');
        summary.appendChild(el('span', 'orch-advanced-name', '高级设置'));
        if (hint) summary.appendChild(el('span', 'orch-advanced-hint', hint));
        const chev = el('span', 'orch-advanced-chevron');
        chev.innerHTML = iconSvg('chevron-right', 12);
        summary.appendChild(chev);
        return summary;
    }

    function readOnlyRow(text, value, mono) {
        const row = el('div', 'orch-field orch-field-read');
        row.appendChild(el('span', 'orch-field-label', text));
        const valueNode = el('div', 'orch-read-value' + (mono ? ' orch-read-mono' : ''),
            value == null || value === '' ? '—' : String(value));
        row.appendChild(valueNode);
        return row;
    }

    function buildBatchEditor(batch, index) {
        const card = el('div', 'orch-batch-card');
        const head = el('div', 'orch-batch-head');
        head.append(
            el('span', 'orch-badge', batch.id || ('B' + (index + 1))),
            el('div', 'orch-batch-title', batch.title || ('批次 ' + (index + 1))),
        );
        const specText = batch.spec || '（无描述）';
        const spec = el('div', 'orch-batch-spec', specText);
        const bits = [];
        bits.push(batch.owns && batch.owns.length
            ? '范围 ' + ownsToInput(batch.owns) : '只读');
        if (batch.dependsOn && batch.dependsOn.length) bits.push('依赖 ' + ownsToInput(batch.dependsOn));
        bits.push(batch.verify && batch.verify.length ? '验收 ' + batch.verify.length + ' 条' : '无自动验收');
        const meta = el('div', 'orch-batch-meta', bits.join(' · '));
        card.append(head, spec);
        if (specText.length > 140) {
            const toggle = el('button', 'orch-desc-toggle', '展开描述');
            toggle.type = 'button';
            toggle.addEventListener('click', () => {
                const expanded = card.classList.toggle('expanded');
                toggle.textContent = expanded ? '收起描述' : '展开描述';
            });
            card.appendChild(toggle);
        }
        card.appendChild(meta);
        return card;
    }

    // 审批卡编辑器：渲染在 composer 接管区（失败时退回弹窗），DOM 只构建一次，
    // 折叠/展开复用同一份节点，避免收起再展开丢掉用户编辑。
    function createPlanEditor(basePlan, opts) {
        const session = opts.session;
        const parentModel = opts.model;
        const call = opts.call;
        const notify = opts.notify;
        const openBoard = opts.openBoard;
        const bodyNode = el('div', 'orch-plan-editor');
        const footNodes = [];
        const continueText = '用户选择继续编排（尚未执行）。请等待用户补充意见；收到后用 orchestration_plan 重新提交完整修订版，不要直接执行或重复创建。';
        let built = false;
        let api = null;
        let submitting = false;
        let cancelled = false;
        let continueRequested = false;
        let resultText = '';
        let lastError = '';
        let submitPromise = null;
        let list = null;
        let errorBox = null;
        let graphSvg = null;
        let graphError = null;
        let graphNote = null;
        let graphRetry = null;
        let lastPreview = null;
        let continueBtn = null;
        let submitBtn = null;
        let review = null;
        let finalReview = null;
        let finalCount = null;
        let finalCountRow = null;
        let autoRun = null;
        let snapshot = null;
        let allowModels = null;
        let modelList = null;
        let reviewModel = null;
        let finalReviewModel = null;
        let modelRows = [];

        const showError = (message) => {
            if (!errorBox) return;
            errorBox.textContent = String(message || '');
            if (errorBox.textContent) {
                try { errorBox.scrollIntoView({block: 'nearest'}); } catch (e) {}
            }
        };

        const showGraphError = (message) => {
            if (graphError) {
                graphError.textContent = String(message || '执行顺序预览失败');
                graphError.hidden = false;
            }
            if (graphRetry) graphRetry.hidden = false;
            if (graphSvg) graphSvg.style.display = 'none';
            if (graphNote) graphNote.textContent = '';
        };

        const renderGraph = () => {
            if (!graphSvg || !lastPreview) return;
            const layout = buildExecutionGraph(basePlan, lastPreview, {
                finalReview: !!(finalReview && finalReview.checked),
                finalReviewCount: Number(finalCount && finalCount.value) || 1,
                maxParallel: basePlan.policy.maxParallel,
            });
            renderExecutionGraph(graphSvg, layout);
            graphSvg.style.display = '';
            if (graphError) {
                graphError.textContent = '';
                graphError.hidden = true;
            }
            if (graphRetry) graphRetry.hidden = true;
            if (graphNote) {
                const notes = ['同列可并行，实际派发受并发上限（' + layout.maxParallel
                    + '）与 owns 交集约束；跨列按依赖推进。'];
                if ((lastPreview.forcedSerial || []).length) {
                    notes.push('串行约束：' + lastPreview.forcedSerial.join('；'));
                }
                if ((lastPreview.warnings || []).length) {
                    notes.push('提示：' + lastPreview.warnings.join('；'));
                }
                graphNote.textContent = notes.join('\n');
            }
        };

        const preview = async () => {
            if (!list) return null;
            const plan = readPlan();
            try {
                const res = await call('OrchestrationPlanPreview', JSON.stringify(plan));
                if (!res || !res.valid) {
                    showGraphError(res && res.errors ? res.errors.join('；') : '计划校验失败');
                    return null;
                }
                showError('');
                lastPreview = res;
                renderGraph();
                return {plan, preview: res};
            } catch (e) {
                showGraphError((e && e.message) || String(e));
                return null;
            }
        };

        const setBusy = (busy) => {
            submitting = !!busy;
            if (submitBtn) submitBtn.disabled = submitting;
            if (continueBtn) continueBtn.disabled = submitting;
        };

        const submit = () => {
            if (submitting) return Promise.resolve();
            submitPromise = (async () => {
                const got = await preview();
                if (!got || cancelled) return;
                setBusy(true);
                lastError = '';
                try {
                    const created = await call('OrchestrationCreate', JSON.stringify(got.plan));
                    if (cancelled) {
                        // 创建请求已发出后用户停止生成：不能把整条编排留在后台跑。
                        try {
                            await call('OrchestrationUserControl', JSON.stringify({
                                orchestrationId: created.id, action: 'stop',
                            }));
                        } catch (e) {}
                        resultText = '编排已创建，但用户停止了生成，已请求停止：' + created.id;
                        return;
                    }
                    const ai2 = aiPanel();
                    if (ai2 && ai2.bridgeAttachOrchestrationSession && session) {
                        ai2.bridgeAttachOrchestrationSession(session.id, {
                            id: created.id, role: 'arbiter', generation: 1, parentSessionId: session.id,
                        }, '');
                    }
                    if (created.warning) notify(created.warning, false);
                    openBoard(got.plan.workspace);
                    resultText = '编排已创建并启动：' + created.id + '（' + got.plan.title + '）'
                        + (created.warning ? '\n注意：' + created.warning : '');
                    if (api) api.finish(true);
                } catch (e) {
                    lastError = (e && e.message) || String(e);
                    notify('编排创建失败：' + lastError, true);
                    showError(lastError);
                } finally {
                    setBusy(false);
                }
            })();
            return submitPromise;
        };

        const readPlan = () => {
            const batches = basePlan.batches.map((batch) => ({...batch}));
            const allowed = ownsFromInput(modelList ? modelList.value : '');
            const finalReviewOn = !!(finalReview && finalReview.checked);
            const policy = {
                ...basePlan.policy,
                review: !!(review && review.checked),
                reviewExplicit: true,
                allowWorkerModels: !!(allowModels && allowModels.checked),
                allowedWorkerModels: (allowModels && allowModels.checked) ? allowed.slice(0, 5) : [],
                reviewModel: allowModels && allowModels.checked && reviewModel ? reviewModel.value.trim() : '',
                finalReview: finalReviewOn,
                finalReviewCount: finalReviewOn
                    ? Math.max(1, Math.min(3, Number(finalCount && finalCount.value) || 1)) : 0,
                finalReviewModel: allowModels && allowModels.checked && finalReviewModel
                    ? finalReviewModel.value.trim() : '',
                autoRun: !!(autoRun && autoRun.checked),
                snapshotBeforeStart: !!(snapshot && snapshot.checked),
            };
            policy.auditIdleMs = computeAuditIdleMs(basePlan.policy.auditIdleMs, policy, batches);
            return {
                ...basePlan, policy,
                batches,
            };
        };

        const syncModelInputs = () => {
            const allowed = !!(allowModels && allowModels.checked);
            const reviewOn = !!(review && review.checked);
            const finalOn = !!(finalReview && finalReview.checked);
            if (modelList) modelList.disabled = !allowed;
            if (reviewModel) reviewModel.disabled = !allowed;
            if (finalReviewModel) finalReviewModel.disabled = !allowed || !finalOn;
            for (const row of modelRows) {
                if (!row) continue;
                if (row.dataset.role === 'allowed') row.style.display = allowed ? '' : 'none';
                else if (row.dataset.role === 'review') row.style.display = allowed && reviewOn ? '' : 'none';
                else if (row.dataset.role === 'final') row.style.display = allowed && finalOn ? '' : 'none';
            }
        };

        const updateFinalCountVisibility = () => {
            const on = !!(finalReview && finalReview.checked);
            if (finalCountRow) finalCountRow.style.display = on ? '' : 'none';
            if (finalCount) finalCount.disabled = !on;
            syncModelInputs();
        };

        const build = () => {
            built = true;
            bodyNode.textContent = '';
            const intro = el('div', 'orch-intro');
            intro.append(
                el('div', 'orch-title', basePlan.title),
                el('div', 'orch-goal', basePlan.goal || '（未填写目标）'),
                el('div', 'orch-muted',
                    '预估 ' + basePlan.batches.length + ' 批 · 约 ' + (basePlan.batches.length * 5)
                    + ' 轮；批准后只在计划边界内自动重试。'),
            );
            bodyNode.appendChild(intro);

            // 执行顺序是审批的第一信息：波次列 + dependsOn 边常驻展示，不再藏在按钮后面。
            const graphCard = el('div', 'orch-graph-card');
            const graphHead = el('div', 'orch-graph-head');
            graphHead.appendChild(el('div', 'orch-graph-title', '执行顺序'));
            const graphLegend = el('div', 'orch-graph-legend');
            const legendItem = (cls, text) => {
                const item = el('span', 'orch-legend-item');
                item.append(el('i', cls), document.createTextNode(text));
                return item;
            };
            graphLegend.append(
                legendItem('orch-legend-line', '依赖'),
                legendItem('orch-legend-dash', '审查门'),
                legendItem('orch-legend-parallel', '∥ 同列并行'),
            );
            graphRetry = iconButton('重试', 'refresh', 'orch-link-btn', () => { preview().catch(() => {}); });
            graphRetry.hidden = true;
            graphHead.append(graphLegend, graphRetry);
            graphSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            graphSvg.setAttribute('class', 'orch-graph-svg');
            const graphScroll = el('div', 'orch-graph-scroll');
            graphScroll.appendChild(graphSvg);
            graphError = el('div', 'orch-graph-error');
            graphError.hidden = true;
            graphNote = el('div', 'orch-graph-note', '正在生成执行顺序…');
            graphCard.append(graphHead, graphScroll, graphError, graphNote);
            bodyNode.appendChild(graphCard);

            // 审批选项与高级设置同一张卡：结构参数只读展示，用户只调审批选项与模型/执行参数。
            const policyCard = el('div', 'orch-policy-card');
            const chips = el('div', 'orch-policy-chips');
            const chip = (label, value) => {
                const c = el('span', 'orch-chip');
                c.append(el('b', '', label), document.createTextNode(' ' + value));
                return c;
            };
            chips.append(
                chip('权限', String(basePlan.policy.scope || 'read')),
                chip('并发', String(basePlan.policy.maxParallel)),
                chip('单批尝试', String(basePlan.policy.maxAttemptsPerBatch)),
                chip('单批超时', formatElapsed(Number(basePlan.policy.batchTimeoutMs) || 0)),
                chip('token 预算', Number(basePlan.policy.budgetTokens) > 0
                    ? String(basePlan.policy.budgetTokens) : '不限'),
            );
            policyCard.appendChild(chips);

            const toggles = el('div', 'orch-policy-toggles');
            const reviewBox = createCheckbox({checked: basePlan.policy.review !== false, label: '逐批审查门'});
            const finalReviewBox = createCheckbox({
                checked: basePlan.policy.finalReview === true,
                label: '全部完成后开子代理终审',
            });
            review = reviewBox.control;
            finalReview = finalReviewBox.control;
            finalCount = createInput({
                type: 'number', min: 1, max: 3,
                value: String(basePlan.policy.finalReviewCount || 1),
            }).control;
            finalCountRow = labelRow('终审数量', finalCount);
            finalCountRow.classList.add('orch-final-count-row');
            toggles.append(reviewBox.element, finalReviewBox.element, finalCountRow);
            policyCard.appendChild(toggles);

            const advanced = el('details', 'orch-advanced orch-plan-advanced');
            advanced.appendChild(advancedSummary('模型 · 自主执行 · 快照'));
            const advGrid = el('div', 'orch-advanced-grid');
            const allowModelsBox = createCheckbox({checked: false, label: '允许为批次/审查/终审指定模型'});
            allowModels = allowModelsBox.control;
            modelList = createInput({placeholder: '模型 ref（账号id|模型id），逗号分隔，最多 5 条'}).control;
            reviewModel = createInput({placeholder: '留空 = 继承母会话'}).control;
            finalReviewModel = createInput({placeholder: '留空 = 继承母会话'}).control;
            const autoRunBox = createCheckbox({checked: false, label: '全程由 agent 自主执行（禁止 awaiting_user）'});
            autoRun = autoRunBox.control;
            const snapshotBox = createCheckbox({checked: false, label: '编排开始前创建快照（大项目可能几百 MB）'});
            snapshot = snapshotBox.control;
            const allowedRow = labelRow('允许的模型', modelList);
            const reviewModelRow = labelRow('审查模型', reviewModel);
            const finalModelRow = labelRow('终审模型', finalReviewModel);
            allowedRow.dataset.role = 'allowed';
            reviewModelRow.dataset.role = 'review';
            finalModelRow.dataset.role = 'final';
            modelRows = [allowedRow, reviewModelRow, finalModelRow];
            advGrid.append(
                allowModelsBox.element,
                allowedRow,
                reviewModelRow,
                finalModelRow,
                autoRunBox.element,
                snapshotBox.element,
            );
            advanced.appendChild(advGrid);
            policyCard.appendChild(advanced);
            policyCard.appendChild(el('div', 'orch-plan-note',
                '当前母会话模型：' + (parentModel
                    ? parentModel.label + '（' + parentModel.ref + '）'
                    : '继承发起会话')));
            bodyNode.appendChild(policyCard);

            finalReview.addEventListener('change', () => {
                updateFinalCountVisibility();
                renderGraph();
            });
            finalCount.addEventListener('input', renderGraph);
            review.addEventListener('change', syncModelInputs);
            allowModels.addEventListener('change', syncModelInputs);
            updateFinalCountVisibility();

            // 快照代价提示：有历史快照时显示上一次体积，让用户对耗时与磁盘有预期。
            try {
                Promise.resolve(call('WipeGuardSnapshotList', getWorkspace())).then((snapList) => {
                    const latest = (Array.isArray(snapList) ? snapList : [])
                        .slice().sort((a, b) => Number(b.at) - Number(a.at))[0];
                    if (!latest || !(Number(latest.bytes) > 0)) return;
                    const hint = el('span', 'orch-muted',
                        '（上次快照 ' + Math.round(Number(latest.bytes) / (1024 * 1024)) + ' MB）');
                    snapshotBox.element.appendChild(hint);
                }).catch(() => {});
            } catch (e) {}

            bodyNode.appendChild(el('div', 'orch-section-title', '批次'));
            list = el('div', 'orch-batch-list');
            for (let i = 0; i < basePlan.batches.length; i++) {
                list.appendChild(buildBatchEditor(basePlan.batches[i], i));
            }
            bodyNode.appendChild(list);

            errorBox = el('div', 'orch-error');
            bodyNode.appendChild(errorBox);

            const footHint = el('span', 'orch-foot-hint',
                '计划结构由母会话生成；需要改结构请继续编排并说明。');
            continueBtn = iconButton('继续编排', '', 'dlg-btn', () => {
                if (submitting) return;
                cancelled = true;
                continueRequested = true;
                notify('已继续编排，请补充意见后再提交修订版', false);
                if (api && typeof api.continue === 'function') api.continue();
                else if (api) api.finish(false);
            });
            submitBtn = iconButton('执行编排', 'check', 'dlg-btn primary', () => { submit().catch(() => {}); });
            footNodes.push(footHint, el('span', 'orch-spacer'), continueBtn, submitBtn);
            preview().catch(() => {});
        };

        return {
            get title() { return '编排计划审批'; },
            get subtitle() { return basePlan.title; },
            get resultText() { return resultText; },
            get lastError() { return lastError; },
            get continueRequested() { return continueRequested; },
            get continueText() { return continueText; },
            waitForSubmit: () => submitPromise || Promise.resolve(),
            submit: () => submit(),
            cancel: () => {
                cancelled = true;
                if (api && !submitting) api.finish(false);
            },
            // 停止生成时 AI 面板会直接撤掉 pendingApprovals；这里只标记取消，
            // 让仍在飞的创建请求落地后自行停止编排。
            cancelFromHost: () => { cancelled = true; },
            mount(bodyHost, footHost, nextApi) {
                if (!built) build();
                api = nextApi || null;
                bodyHost.appendChild(bodyNode);
                for (const node of footNodes) footHost.appendChild(node);
            },
        };
    }

    function openModalPlanEditor(editor) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (approved) => {
                if (settled) return;
                settled = true;
                const text = approved
                    ? (editor.resultText || '编排已创建。')
                    : '用户取消了编排计划，未创建。';
                dlg.close();
                resolve(text);
            };
            const dlg = buildDialog('编排计划审批', () => finish(false));
            editor.mount(dlg.body, dlg.foot, {finish});
        });
    }

    function openApproval(input, ctx) {
        const session = ctx && ctx.session;
        if (!session) return Promise.reject(new Error('编排计划缺少会话上下文'));
        const ai = aiPanel();
        const model = ai && ai.bridgeSessionModelRef ? ai.bridgeSessionModelRef(session.id) : null;
        const windowWs = getWorkspace();
        const sessionWs = String(session.workspace || '').trim();
        const planWs = sessionWs || windowWs;
        if (!planWs) return Promise.reject(new Error('当前会话没有绑定工作区，无法发起编排'));
        const basePlan = buildPlanRequest(input, {
            workspace: planWs,
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
        if (rawPolicy.finalReview == null) {
            basePlan.policy.finalReview = defaults.orchFinalReview === true;
        }
        basePlan.policy.auditIdleMs = computeAuditIdleMs(
            Number(defaults.orchAuditIdleSec) > 0 ? Number(defaults.orchAuditIdleSec) * 1000 : 2 * 60 * 60 * 1000,
            basePlan.policy, basePlan.batches,
        );
        const editor = createPlanEditor(basePlan, {
            session, model, call, notify, openBoard,
        });
        const bridge = ai && ai.bridgeRequestOrchestrationPlanApproval;
        if (typeof bridge !== 'function' || !ctx.toolMessage) {
            return openModalPlanEditor(editor).then(async (text) => {
                await editor.waitForSubmit();
                if (editor.continueRequested) return editor.continueText;
                return editor.resultText || text;
            });
        }
        return Promise.resolve(bridge(session, ctx.toolMessage, editor)).then(async (res) => {
            // 创建请求可能比“停止/关闭”晚到：等它落地再决定给模型什么结果，
            // 避免实际已创建却回报“未创建”导致模型重复发起。
            await editor.waitForSubmit();
            if (editor.continueRequested) return editor.continueText;
            if (editor.resultText) return editor.resultText;
            if (res && res.approved) return '编排计划已批准。';
            return res && res.cancelled
                ? '用户停止生成，编排计划未创建。'
                : '用户取消了编排计划，未创建。';
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
                const ai = aiPanel();
                const sessions = ai && ai.bridgeListSessions
                    ? (ai.bridgeListSessions(session ? session.id : '') || [])
                    : [];
                const byId = new Map(sessions.map((item) => [item.id, item]));
                return [summarizeView(view), ...formatBatchTable(view, byId)].join('\n');
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
        // 空串 = 继承母会话：bridgeCreateOrchestrationSession 会按 parentSessionId
        // 解析发起会话「当前」模型，而不是审批时固定下来的旧 arbiterModelRef。
        if (batch.finalReview) return policy.finalReviewModel || '';
        if (batch.kind === 'review') return policy.reviewModel || '';
        const attempt = Number(batch.attempts || 0) + 1;
        const requested = attempt > 1
            ? ((batch.model && batch.model.retry) || (batch.model && batch.model.first) || '')
            : ((batch.model && batch.model.first) || '');
        if (!policy.allowWorkerModels || !requested) return '';
        return (policy.allowedWorkerModels || []).includes(requested) ? requested : '';
    }

    async function handleDispatch(payload) {
        // 多工作区 harness 聚焦别的仓库时也要接派发：各窗口都收到事件，后端 ClaimBatch
        // 的 90 秒互斥保证只有一个窗口认领，不会重复建会话；不再按当前根把事件丢掉。
        if (!payload || (!acceptsWorkspace(payload.root, getWorkspace()) && !isMultiWorkspace())) return;
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
            const title = role === 'review'
                ? ((batch.finalReview ? '终审 · ' : '审查 · ') + o.title)
                : (batch.title || '编排批次');
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
            const parentModel = ai.bridgeSessionModelRef ? ai.bridgeSessionModelRef(o.parentSessionId) : null;
            const created = await ai.bridgeCreateOrchestrationSession({
                title: '编排仲裁·接替「' + (o.title || oldTitle) + '」',
                callerSessionId: o.parentSessionId,
                workspace: (o.workspaces && o.workspaces[0]) || '',
                scope: 'read',
                // 仲裁交接也跟随母会话当前模型；不再沿用可能已删除的审批时 ref。
                modelRef: parentModel && parentModel.ref ? parentModel.ref : '',
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
            if (!root || acceptsWorkspace(root, board.workspace)) {
                board.refresh().catch(() => {});
            }
        }
    }

    // ---------- 看板 ----------

    function sessionStateLabel(state) {
        if (state === 'streaming') return '运行中';
        if (state === 'compacting') return '压缩中';
        if (state === 'idle') return '空闲';
        return '';
    }

    function batchSessionSuffix(batch, sessions) {
        if (!batch || !batch.sessionId) return '';
        const s = sessions && sessions.get(batch.sessionId);
        if (!s) return ' · 会话 ' + batch.sessionId;
        const bits = [];
        const state = sessionStateLabel(s.state);
        if (state) bits.push(state);
        if (s.messages) bits.push(s.messages + ' 条');
        if (s.unread) bits.push('未读');
        return ' · 会话 ' + batch.sessionId + (bits.length ? '（' + bits.join(' · ') + '）' : '');
    }

    function formatBatchTable(view, sessions) {
        const lines = [];
        const batches = (view && view.batches) || [];
        for (const b of batches) {
            if (b.kind === 'review') continue;
            lines.push(`${b.id}「${b.title}」${batchStatusLabel(b.status)}` +
                (b.failureReason ? ' · ' + failureLabel(b.failureReason) : '') +
                (b.attempts ? ' · 尝试 ' + b.attempts : '') +
                (b.owns && b.owns.length ? ' · owns ' + b.owns.join(',') : ' · 只读') +
                batchSessionSuffix(b, sessions));
            for (const r of batches.filter((x) => x.kind === 'review' && x.reviewOf === b.id)) {
                lines.push('  ↳ ' + r.id + '「' + r.title + '」' + batchStatusLabel(r.status) +
                    batchSessionSuffix(r, sessions));
            }
        }
        const finals = batches.filter((x) => x.finalReview);
        if (finals.length) {
            lines.push('终审：');
            for (const b of finals) {
                lines.push('  - ' + b.id + '「' + b.title + '」' + batchStatusLabel(b.status) +
                    (b.failureReason ? ' · ' + failureLabel(b.failureReason) : '') +
                    batchSessionSuffix(b, sessions));
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
                const all = (await call('OrchestrationList')) || [];
                // 多工作区 harness 的主窗口没有单一 workspace，后端会返回全部；
                // 看板仍按自己的 workspace 过滤，避免 A 仓库面板列出 B 仓库的编排。
                const list = board.workspace
                    ? all.filter((item) => acceptsWorkspace(item.workspace, board.workspace))
                    : all;
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
        const finals = (view.batches || []).filter((b) => b.finalReview);
        if (finals.length) {
            batches.appendChild(el('div', 'orch-section-title', '终审'));
            for (const b of finals) batches.appendChild(renderBatchRow(b, view, board, true));
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
        if (['pending', 'failed', 'blocked'].includes(b.status) && (!review || b.finalReview)) {
            actions.appendChild(iconButton('跳过', 'close', 'orch-btn orch-btn-ghost', () => onBoardAction(board, 'skip', b, view)));
        }
        if (b.finalReview && ['failed', 'blocked'].includes(b.status)) {
            actions.appendChild(iconButton('重派终审', 'refresh', 'orch-btn orch-btn-ghost', () => onBoardAction(board, 'retry', b, view)));
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
            if (eventName === 'orchestration-dispatch') {
                // 派发要跨「当前聚焦根」接收（harness 聚焦别处时仍能认领）；认领互斥在后端。
                appEvents.onApp(eventName, (payload) => {
                    ensure().handleEvent(eventName, payload);
                });
                continue;
            }
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
