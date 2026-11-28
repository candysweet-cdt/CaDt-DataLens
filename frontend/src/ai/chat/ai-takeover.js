// ai-takeover.js：输入区接管卡宿主（工具审批 / 系统接管 / 计划批准 + 分发器与计数徽标折叠）。
// 从 ai-panel.js 拆出（structure-cleanup 阶段 3）；phase3 A2 再拆同域兄弟模块 ai-patch-card.js /
// ai-ask-cards.js（ctx 同源直传、宿主符号经 extras 注入），函数体逐字搬移。
// classifyVerdictRows/askNavAction 纯函数留守（ai-takeover.test.mjs）；
// approvalTakeoverKey/Collapsed、dismissedPlanApproval、stickBottom 经访问器读写（核心域他处亦写）。
import {iconSvg} from '../../core/icons.js';
import {createSwitch, createCheckbox} from '../../core/form-controls.js';
import {humanSizeBytes} from '../tools/ai-file-tools.js';
import {AI_WRITE_SCOPES, AI_DELETE_BULK_WARN, AI_DELETE_SIZE_ASK} from '../core/ai-constants.js';
import {createSessionBusyProbe} from '../session/ai-session-scope.js';
import {isWebApproval} from '../security/ai-permissions.js';
import {collectCommandFamilies, commandFamilySignature, mergePlanGrantItems, deletionHintFor} from '../security/ai-command-rules.js';
import {planDigest, planPreviewSlice, PLAN_PREVIEW_CHARS} from '../core/ai-plan-file.js';
import {worktreeRelPath, worktreeStatNode} from '../tools/ai-worktree.js';
import {createAIAskCards} from './ai-ask-cards.js';
import {createAIPatchCard} from './ai-patch-card.js';
import {createAIActionApprovalCard} from '../security/ai-action-approval-card.js';

// 审批卡判定区的行描述（纯函数，ai-takeover.test.mjs 覆盖）：
// info = {engine: '线性'|'语义'|插件短名, score, threshold, aiReason}。
// 端侧引擎行只在 engine 有值时输出（分数按危险度着色：≥0.7 红，否则黄）；
// AI 复核行只在 aiReason 非空时输出。旧会话没有结构化字段时调用方回退拼接文案。
export function classifyVerdictRows(info) {
    const rows = [];
    if (info && info.engine) {
        const score = Math.min(1, Math.max(0, Number(info.score) || 0));
        const threshold = Math.max(0, Number(info.threshold) || 0);
        rows.push({
            chip: '端侧·' + String(info.engine),
            score,
            threshold,
            hot: score >= 0.7,
        });
    }
    const aiReason = info && info.aiReason ? String(info.aiReason) : '';
    if (aiReason) rows.push({chip: 'AI 复核', reason: aiReason});
    return rows;
}

// ask 接管卡的键盘导航决策（纯函数，ai-takeover.test.mjs 覆盖）。
// 左右 = 在多个问题间前后切换（仅多题、且焦点不在输入框时；输入框里的左右要留给光标）；
// 上下 = 在当前题的「选项 + 自己输入」之间移动焦点，回车/空格由原生 button 触发选中。
// 返回 null 表示不拦截，交还浏览器默认行为。
// ctx = {multi, questionCount, idx, focusIndex, itemCount, inInput}
export function askNavAction(key, ctx) {
    if (!ctx) return null;
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
        if (!ctx.multi || ctx.inInput) return null;
        const next = ctx.idx + (key === 'ArrowLeft' ? -1 : 1);
        return next >= 0 && next < ctx.questionCount ? {type: 'question', idx: next} : null;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
        const count = Math.max(0, Number(ctx.itemCount) || 0);
        if (!count) return null;
        const cur = ctx.focusIndex;
        // 无有效焦点时，方向键都落到第一项（而不是跳过它）。
        if (!Number.isInteger(cur) || cur < 0) return {type: 'focus', index: 0};
        const index = key === 'ArrowDown' ? Math.min(count - 1, cur + 1) : Math.max(0, cur - 1);
        return {type: 'focus', index};
    }
    return null;
}

// 判定区 DOM：行描述 → 来源 chip / 风险条（蓝刻度=阈值）/ 分数阈值 / 转人工箭头 / AI 复核理由
function buildClassifyVerdict(info) {
    const box = document.createElement('div');
    box.className = 'ai-classify';
    for (const row of classifyVerdictRows(info)) {
        const line = document.createElement('div');
        line.className = 'ai-classify-row';
        const chip = document.createElement('span');
        chip.className = 'ai-classify-chip ' + (row.reason ? 'remote' : 'local');
        chip.textContent = row.chip;
        line.appendChild(chip);
        if (row.reason) {
            const why = document.createElement('span');
            why.className = 'ai-classify-why';
            why.textContent = row.reason;
            line.appendChild(why);
        } else {
            const meter = document.createElement('span');
            meter.className = 'ai-classify-meter';
            const fill = document.createElement('i');
            fill.className = 'fill' + (row.hot ? '' : ' mid');
            fill.style.width = Math.round(row.score * 100) + '%';
            const tick = document.createElement('i');
            tick.className = 'tick';
            tick.style.left = Math.min(100, Math.round(row.threshold * 100)) + '%';
            meter.append(fill, tick);
            const num = document.createElement('span');
            num.className = 'ai-classify-num';
            const score = document.createElement('b');
            score.className = row.hot ? 'hot' : 'mid';
            score.textContent = row.score.toFixed(2);
            num.appendChild(score);
            num.append(' ≥ 阈值 ' + row.threshold.toFixed(2));
            const arrow = document.createElement('span');
            arrow.className = 'ai-classify-arrow';
            arrow.append('→ ');
            const hard = document.createElement('b');
            hard.textContent = '转人工';
            arrow.appendChild(hard);
            line.append(meter, num, arrow);
        }
        box.appendChild(line);
    }
    return box;
}

export function createAITakeover(ctx) {
    const el = ctx.el;
    const flash = ctx.flash;
    const compactOf = ctx.compactOf;
    const currentSession = ctx.currentSession;
    const currentScopeOf = ctx.currentScopeOf;
    const decideApproval = ctx.decideApproval;
    const pendingApprovals = ctx.pendingApprovals;
    const currentPendingApprovalEntry = ctx.currentPendingApprovalEntry;
    const currentPendingAskEntry = ctx.currentPendingAskEntry;
    const currentPendingEnvEntry = ctx.currentPendingEnvEntry;
    const currentSystemTakeoverEntry = ctx.currentSystemTakeoverEntry;
    const systemTakeoverHost = ctx.systemTakeoverHost;
    const projectRulesPath = ctx.projectRulesPath;
    const lastAssistantIndex = ctx.lastAssistantIndex;
    const scrollToBottom = ctx.scrollToBottom;
    const setScope = ctx.setScope;
    const streamOf = ctx.streamOf;
    // 会话「忙」判定与面板同源（ai-session-scope.js 的探针），供「回退到此轮」等入口共用。
    const isSessionBusy = createSessionBusyProbe({streamOf, compactOf});
    const positionOverlays = ctx.positionOverlays;
    const AI_CHEVRON_SVG = ctx.AI_CHEVRON_SVG;
    const renderDiffInto = ctx.renderDiffInto;
    const renderMessageQueue = ctx.renderMessageQueue;
    const getApprovalTakeoverKey = ctx.getApprovalTakeoverKey;
    const setApprovalTakeoverKey = ctx.setApprovalTakeoverKey;
    const getApprovalTakeoverCollapsed = ctx.getApprovalTakeoverCollapsed;
    const setApprovalTakeoverCollapsed = ctx.setApprovalTakeoverCollapsed;
    const getDismissedPlanApproval = ctx.getDismissedPlanApproval;
    const setDismissedPlanApproval = ctx.setDismissedPlanApproval;
    const getStickBottom = ctx.getStickBottom;
    const toolMeta = ctx.toolMeta;
    const renderMarkdown = ctx.renderMarkdown;
    const acceptPlan = ctx.acceptPlan;
    // 计划卡「查看完整计划」（ai-panel 注入）：已批准开 .cadt/plan/ 的真文件，未批准开虚拟只读预览
    const openPlan = typeof ctx.openPlan === 'function' ? ctx.openPlan : null;

    // 补丁卡与提问卡（phase3 A2 拆出的同域兄弟模块）：ctx 同源直传，宿主侧符号经 extras 注入；
    // 分发器 updateComposerTakeover 在下方定义，extras 里用惰性箭头延迟解析。
    // 留守侧调用点（renderApprovalTakeover 的 patch 分支、分发器、返回面）经同名惰性别名零改动。
    const patchCards = createAIPatchCard(ctx, {
        updateComposerTakeover: (...args) => updateComposerTakeover(...args),
    });
    const askCards = createAIAskCards(ctx, {
        askNavAction,
        // 提问卡折叠/展开走宿主分发器（与审批卡同口径：重定位浮层 + stickBottom 跟随）
        updateComposerTakeover: (...args) => updateComposerTakeover(...args),
    });
    const actionApprovalCard = createAIActionApprovalCard(ctx, {
        updateComposerTakeover: (...args) => updateComposerTakeover(...args),
    });
    const renderActionTakeover = (...args) => actionApprovalCard.renderActionTakeover(...args);
    // 编排计划审批：卡片主体由 orchestration 域注入（record.mount），这里只提供
    // 与 submit_plan 同款的接管外壳、折叠细条与结算通道。
    const getOrchestrationApproval = typeof ctx.getOrchestrationApproval === 'function'
        ? ctx.getOrchestrationApproval
        : () => null;
    let orchestrationTakeoverKey = '';
    let orchestrationTakeoverCollapsed = false;
    const requestPatchApproval = (...args) => patchCards.requestPatchApproval(...args);
    const renderPatchTakeover = (...args) => patchCards.renderPatchTakeover(...args);
    const renderPatchApprovalBody = (...args) => patchCards.renderPatchApprovalBody(...args);
    const askTakeoverKey = (...args) => askCards.askTakeoverKey(...args);
    const renderEnvAskTakeover = (...args) => askCards.renderEnvAskTakeover(...args);
    const renderAskTakeover = (...args) => askCards.renderAskTakeover(...args);

    function renderApprovalTakeover(entry) {
        if (entry && entry.approval && entry.approval.kind === 'orchestration') {
            renderOrchestrationTakeover(entry);
            return;
        }
        if (entry && entry.approval && entry.approval.kind === 'patch') {
            renderPatchTakeover(entry);
            return;
        }
        if (entry && entry.approval && entry.approval.kind === 'worktree') {
            renderWorktreeTakeover(entry);
            return;
        }
        if (entry && entry.approval && entry.approval.kind === 'action') {
            renderActionTakeover(entry);
            return;
        }
        const toolMessage = entry.toolMessage;
        const approval = entry.approval;
        const isCommand = approval.kind === 'command';
        const isRead = approval.kind === 'read';
        const isDelete = approval.kind === 'delete';
        const commandFamily = isCommand ? commandFamilySignature(approval.command) : null;
        const takeoverKey = 'approval:' + (toolMessage.toolCallId || '');
        el.takeover.dataset.takeoverKey = takeoverKey;
        if (getApprovalTakeoverKey() !== takeoverKey) {
            setApprovalTakeoverKey(takeoverKey);
            setApprovalTakeoverCollapsed(false);
        }
        el.takeover.textContent = '';
        if (getApprovalTakeoverCollapsed()) {
            // 收起态：单行细条，保持「有待审批」的可见性，点击恢复
            const bar = document.createElement('button');
            bar.type = 'button';
            bar.className = 'ai-takeover-bar';
            const barIcon = document.createElement('span');
            barIcon.className = 'ai-takeover-icon';
            barIcon.innerHTML = iconSvg('diff', 13);
            const barText = document.createElement('span');
            barText.className = 'ai-takeover-bar-text';
            barText.textContent = isCommand
                ? '命令待审批'
                : (isRead ? '读取待审批 · ' : (isDelete ? '删除待审批 · ' : '更改待审批 · ')) + (approval.relPath || approval.path || '');
            const barStat = document.createElement('span');
            barStat.className = 'ai-approval-stat';
            if (!isCommand && !isRead && !isDelete) {
                const add = document.createElement('span');
                add.className = 'add';
                add.textContent = '+' + (approval.added || 0);
                const del = document.createElement('span');
                del.className = 'del';
                del.textContent = '−' + (approval.removed || 0);
                barStat.append(add, del);
            }
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
        card.className = 'ai-takeover-card ai-approval-takeover' + (isCommand ? ' command' : '');
        // 头部：动作词 + 图标 + 路径 + diff 统计 + 收起按钮
        const head = document.createElement('div');
        head.className = 'ai-takeover-head';
        const meta = toolMeta(toolMessage.name, approval);
        const icon = document.createElement('span');
        icon.className = 'ai-takeover-icon';
        icon.innerHTML = iconSvg(meta.icon, 13);
        const verb = document.createElement('span');
        verb.className = 'ai-takeover-title';
        verb.textContent = meta.verb;
        head.append(icon, verb);
        if (isCommand) {
            const cwd = document.createElement('span');
            cwd.className = 'ai-command-cwd';
            // 显式指定 shell 时前置标出（bash / pwsh 的语言规则完全不同，审批的人要看得见）
            cwd.textContent = (approval.shell ? approval.shell + ' · ' : '') + (approval.cwd || '终端命令');
            head.appendChild(cwd);
        } else {
            const path = document.createElement('span');
            path.className = 'ai-takeover-path';
            path.textContent = approval.relPath || approval.path || '';
            head.appendChild(path);
            if (!isRead && !isDelete) {
                const stat = document.createElement('span');
                stat.className = 'ai-approval-stat';
                const add = document.createElement('span');
                add.className = 'add';
                add.textContent = '+' + (approval.added || 0);
                const del = document.createElement('span');
                del.className = 'del';
                del.textContent = '−' + (approval.removed || 0);
                stat.append(add, del);
                if (approval.newFile) {
                    const tag = document.createElement('span');
                    tag.className = 'ai-approval-tag';
                    tag.textContent = '新文件';
                    stat.appendChild(tag);
                }
                head.appendChild(stat);
            }
        }
        // 临时收起：折叠整卡为细条，方便继续查看上方消息；审批本身不受影响
        const collapse = document.createElement('button');
        collapse.type = 'button';
        collapse.className = 'ai-takeover-collapse';
        collapse.innerHTML = AI_CHEVRON_SVG;
        collapse.addEventListener('click', () => {
            setApprovalTakeoverCollapsed(true);
            updateComposerTakeover(true);
        });
        head.appendChild(collapse);
        // 正文：diff / 命令内容占满剩余高度并内部滚动
        const body = document.createElement('div');
        body.className = 'ai-takeover-body ai-approval-takeover-body';
        if (approval.dirty) {
            const warn = document.createElement('div');
            warn.className = 'ai-approval-warn';
            warn.textContent = '该文件在编辑器中存在未保存修改；应用后不会自动重载，请手动重新加载。';
            body.appendChild(warn);
        }
        if (isCommand) {
            if (approval.danger) {
                const danger = document.createElement('div');
                danger.className = 'ai-approval-danger';
                danger.textContent = '高风险操作：' + (approval.danger.label || approval.danger.ruleId) +
                    '。该命令只执行这一次，不会写入任何长期授权。';
                body.appendChild(danger);
            }
            const line = document.createElement('pre');
            line.className = 'ai-command-line ai-command-line-fill';
            line.textContent = approval.command || '';
            body.appendChild(line);
            if (approval.classifyInfo && !(approval.danger || approval.singleUse)) {
                // 结构化判定区（2026-11-14 提案）：端侧引擎行 + AI 复核行，取代拼接文案；
                // 旧会话恢复的审批对象没有该字段，走下方 classifyNote 纯文本回退
                body.appendChild(buildClassifyVerdict(approval.classifyInfo));
            } else {
                const note = document.createElement('div');
                note.className = 'ai-approval-more';
                const noteText = isWebApproval(approval)
                    ? '将向该地址发起网络请求；域名规则可在 .cadt/permissions.json 的 Web(...) 中预先配置。'
                    : (approval.danger || approval.singleUse
                        ? '命令将在工作目录中执行；危险命令不提供「本会话 / 本项目允许」。'
                        : (approval.classifyNote
                            ? (approval.askSource === 'local-classifier'
                                ? '端侧分类器转人工：' + approval.classifyNote
                                : '分类器建议人工确认：' + approval.classifyNote)
                            : (commandFamily
                                ? '命令将在工作目录中执行；同类命令授权可保存到本会话或本项目，且不含管道、重定向或命令串联。'
                                : '命令将在工作目录中执行；授权仅本次对话。')));
                // 删除类命令追加工具引导（不改判定，deletionHintFor 只是文案）
                note.textContent = noteText + deletionHintFor(approval.command);
                body.appendChild(note);
            }
        } else if (isRead) {
            // 读审批：无 diff，展示完整真实路径（用户要知道自己批准的是什么）与记住粒度。
            const line = document.createElement('pre');
            line.className = 'ai-command-line ai-command-line-fill';
            line.textContent = approval.path || '';
            body.appendChild(line);
            const note = document.createElement('div');
            note.className = 'ai-approval-more';
            note.textContent = approval.isDir
                ? '该目录在工作区外。批准后可免询问搜索与读取该目录树' +
                    '（也可不勾选，仅本次放行）；应用数据目录不受此影响，始终拒绝。'
                : '该文件在工作区外。批准目录后，该目录下的文件可免询问读取' +
                    '（也可不勾选，仅本次放行）；应用数据目录不受此影响，始终拒绝读取。';
            body.appendChild(note);
        } else if (isDelete) {
            // 删除审批：无 diff。逐条清单（多条全列，上限 AI_DELETE_PATHS_LIMIT 可控）+
            // 影响面 + 回收站说明；展开总量超 AI_DELETE_BULK_WARN 或枚举截断时加红块警告
            // （对齐危险命令卡的 ai-approval-danger）。兼容旧会话恢复的单条 approval 形态。
            const deleteScale = (impact) => {
                if (!impact) return '条目';
                if (impact.isDir) {
                    return impact.truncated
                        ? '目录 · 超过 ' + (impact.entries || 400) + ' 项（枚举已截断，忽略目录不计入）'
                        : '目录 · ' + (impact.entries || 0) + ' 项（忽略目录不计入）';
                }
                return impact.size ? '文件 · ' + humanSizeBytes(impact.size) : '文件';
            };
            const list = Array.isArray(approval.entries) && approval.entries.length ? approval.entries : null;
            if (list && list.length > 1) {
                for (const item of list) {
                    const row = document.createElement('div');
                    row.className = 'ai-approval-more';
                    row.textContent = '· ' + item.relPath + '（' + deleteScale(item.impact) + '）';
                    body.appendChild(row);
                }
            } else {
                const line = document.createElement('pre');
                line.className = 'ai-command-line ai-command-line-fill';
                line.textContent = approval.path || '';
                body.appendChild(line);
                const meta = document.createElement('div');
                meta.className = 'ai-approval-more';
                meta.textContent = '删除目标：' + deleteScale(list && list[0] ? list[0].impact : approval.impact) + '。';
                body.appendChild(meta);
            }
            const summary = document.createElement('div');
            summary.className = 'ai-approval-more';
            summary.textContent = approval.permanent
                ? '将彻底删除，不进回收站、不可恢复；批准仅对本次生效（删除不提供记住）。'
                : '将全部移入系统回收站，可在回收站还原；批准仅对本次生效（删除不提供记住）。';
            body.appendChild(summary);
            const summaryImpact = approval.impact || {};
            if ((summaryImpact.totalEntries || 0) > AI_DELETE_BULK_WARN || !!summaryImpact.anyTruncated) {
                const bulk = document.createElement('div');
                bulk.className = 'ai-approval-danger';
                bulk.textContent = '批量删除：本次展开超过 ' + AI_DELETE_BULK_WARN + ' 个条目' +
                    (summaryImpact.anyTruncated ? '（枚举已截断，实际可能更多）' : '') + '，请确认影响范围。';
                body.appendChild(bulk);
            }
            if (approval.permanent) {
                // 模型请求彻底删除（permanent=true，非 full 档已被强制转人工到这张卡）
                const perm = document.createElement('div');
                perm.className = 'ai-approval-danger';
                perm.textContent = '永久删除：模型请求跳过回收站，此操作不可恢复；请确认这些条目确实不需要保留。';
                body.appendChild(perm);
            }
            if (approval.outOfWorkspace) {
                const note = document.createElement('div');
                note.className = 'ai-approval-more';
                note.textContent = '清单中有条目在工作区外；应用数据目录不受此影响，始终拒绝删除。';
                body.appendChild(note);
            }
        } else if (approval.diff && approval.diff.length) {
            if (approval.outOfWorkspace) {
                // 写审批的工作区外提示（2026-11-28 写工具放行越界路径）：diff 上方一句话
                // 说清批准范围——记住只对这一个文件生效，不像读授权那样记目录树。
                const note = document.createElement('div');
                note.className = 'ai-approval-more';
                note.textContent = '该文件在工作区外。批准仅对这一个文件生效' +
                    '（可勾选记住，免下次再问）；应用数据目录始终拒绝写入。';
                body.appendChild(note);
            }
            renderDiffInto(body, approval);
            if (approval.truncated) {
                const more = document.createElement('div');
                more.className = 'ai-approval-more';
                more.textContent = '…（diff 预览已截断）';
                body.appendChild(more);
            }
        } else {
            const empty = document.createElement('div');
            empty.className = 'ai-approval-more';
            empty.textContent = '（无内容变化）';
            body.appendChild(empty);
        }
        // 底部操作条：勾选框 + 固定按钮
        const foot = document.createElement('div');
        foot.className = 'ai-takeover-foot ai-approval-takeover-foot';
        const options = document.createElement('div');
        options.className = 'ai-approval-remember';
        let alwaysBox = null;
        let sessionBox = null;
        let familyBox = null;
        let projectFamilyBox = null;
        let projectFileBox = null;
        let permanentBox = null;
        if (!isCommand && !isDelete) {
            // 写审批记「此文件」（精确路径），读审批记「此目录」（父目录树）——复用同一组勾选框。
            // 删除不提供记住（授权写 ≠ 授权删）：勾选框整段跳过，decideApproval 的 delete 分支兜底。
            const noun = isRead ? '此目录' : '此文件';
            const sessionLabel = document.createElement('label');
            sessionBox = document.createElement('input');
            sessionBox.type = 'checkbox';
            sessionLabel.append(sessionBox, document.createTextNode(' 本会话允许' + noun));
            const alwaysLabel = document.createElement('label');
            alwaysBox = document.createElement('input');
            alwaysBox.type = 'checkbox';
            alwaysLabel.append(alwaysBox, document.createTextNode(' 总是允许' + noun));
            options.append(sessionLabel, alwaysLabel);
            if (projectRulesPath()) {
                const projectLabel = document.createElement('label');
                projectFileBox = document.createElement('input');
                projectFileBox.type = 'checkbox';
                projectFileBox.dataset.aiWriteRemember = 'project';
                projectLabel.append(projectFileBox, document.createTextNode(' 本项目允许' + noun));
                options.appendChild(projectLabel);
            }
            foot.appendChild(options);
        } else if (isDelete) {
            // 彻底删除（不进回收站）由人在卡上勾选、默认不勾——不可逆决策不交给模型参数
            // 独自决定；大文件给提示（auto 档超 AI_DELETE_SIZE_ASK 的清单本来就会弹卡到这里）。
            const permanent = createCheckbox({label: ' 彻底删除（不进回收站，不可恢复）'});
            permanent.control.dataset.aiDeletePermanent = '1';
            permanentBox = permanent.control;
            options.appendChild(permanent.element);
            if ((approval.impact && (approval.impact.totalSize || 0)) >= AI_DELETE_SIZE_ASK) {
                const hint = document.createElement('span');
                hint.className = 'ai-approval-more';
                hint.textContent = '大文件建议勾选彻底删除，以免占用回收站空间。';
                options.appendChild(hint);
            }
            foot.appendChild(options);
        } else if (!approval.danger && !approval.singleUse) {
            const exactLabel = document.createElement('label');
            sessionBox = document.createElement('input');
            sessionBox.type = 'checkbox';
            sessionBox.dataset.aiCommandRemember = 'exact';
            exactLabel.append(sessionBox, document.createTextNode(isWebApproval(approval) ? ' 本会话允许该网址' : ' 本会话允许相同命令'));
            options.appendChild(exactLabel);
            if (commandFamily) {
                const familyLabel = document.createElement('label');
                familyBox = document.createElement('input');
                familyBox.type = 'checkbox';
                familyBox.dataset.aiCommandRemember = 'family';
                familyLabel.append(familyBox, document.createTextNode(' 本会话允许同类命令（' + commandFamily.signature + '）'));
                options.appendChild(familyLabel);
                if (projectRulesPath()) {
                    const projectLabel = document.createElement('label');
                    projectFamilyBox = document.createElement('input');
                    projectFamilyBox.type = 'checkbox';
                    projectFamilyBox.dataset.aiCommandRemember = 'projectFamily';
                    projectLabel.append(projectFamilyBox, document.createTextNode(' 本项目允许同类命令'));
                    options.appendChild(projectLabel);
                }
            }
            foot.appendChild(options);
        }
        const actions = document.createElement('div');
        actions.className = 'ai-approval-actions';
        const readRemember = () => {
            if (!isCommand) {
                return alwaysBox && alwaysBox.checked
                    ? 'always'
                    : (projectFileBox && projectFileBox.checked
                        ? 'project'
                        : (sessionBox && sessionBox.checked ? 'session' : ''));
            }
            if (approval.danger || approval.singleUse) return {};
            return {
                exact: !!(sessionBox && sessionBox.checked),
                family: !!(familyBox && familyBox.checked),
                projectFamily: !!(projectFamilyBox && projectFamilyBox.checked),
            };
        };
        // 删除卡的「彻底删除」勾选（extra.permanent → decideApproval → applyDelete 选绑定）
        const readPermanent = () => !!(permanentBox && permanentBox.checked);
        const deny = document.createElement('button');
        deny.type = 'button';
        deny.className = 'dlg-btn';
        deny.textContent = isRead ? '拒绝' : '放弃';
        deny.addEventListener('click', () => decideApproval(toolMessage, false, readRemember(), {permanent: readPermanent()}));
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'dlg-btn primary';
        apply.textContent = isCommand ? '执行' : (isRead ? '允许' : (isDelete ? '删除' : '应用'));
        apply.addEventListener('click', () => decideApproval(toolMessage, true, readRemember(), {permanent: readPermanent()}));
        actions.append(deny, apply);
        foot.appendChild(actions);
        card.append(head, body, foot);
        el.takeover.appendChild(card);
    }

    // 隔离工作区动作审批（AI 主动 create / discard）：接管 composer 的简洁审批卡。
    // 与写/命令审批共用 pendingApprovals 通道；全档必弹（含完全权限）。用户手点的
    // 「隔离」开关仍走居中确认弹窗（那是用户自己发起的动作）。
    function renderWorktreeTakeover(entry) {
        const toolMessage = entry.toolMessage;
        const approval = entry.approval;
        const discard = approval.action === 'discard';
        const takeoverKey = 'approval:' + (toolMessage.toolCallId || '');
        el.takeover.dataset.takeoverKey = takeoverKey;
        if (getApprovalTakeoverKey() !== takeoverKey) {
            setApprovalTakeoverKey(takeoverKey);
            setApprovalTakeoverCollapsed(false);
        }
        el.takeover.textContent = '';
        const titleText = discard ? '丢弃隔离工作区' : '创建隔离工作区';
        if (getApprovalTakeoverCollapsed()) {
            const bar = document.createElement('button');
            bar.type = 'button';
            bar.className = 'ai-takeover-bar';
            const barIcon = document.createElement('span');
            barIcon.className = 'ai-takeover-icon';
            barIcon.innerHTML = iconSvg(discard ? 'trash' : 'folder', 13);
            const barText = document.createElement('span');
            barText.className = 'ai-takeover-bar-text';
            barText.textContent = '隔离工作区待审批 · ' + titleText + (approval.name ? ' ' + approval.name : '');
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
        card.className = 'ai-takeover-card ai-approval-takeover ai-worktree-takeover';
        const head = document.createElement('div');
        head.className = 'ai-takeover-head';
        const icon = document.createElement('span');
        icon.className = 'ai-takeover-icon';
        icon.innerHTML = iconSvg(discard ? 'trash' : 'folder', 13);
        const title = document.createElement('span');
        title.className = 'ai-takeover-title';
        title.textContent = titleText;
        const collapse = document.createElement('button');
        collapse.type = 'button';
        collapse.className = 'ai-takeover-collapse';
        collapse.innerHTML = AI_CHEVRON_SVG;
        collapse.addEventListener('click', () => {
            setApprovalTakeoverCollapsed(true);
            updateComposerTakeover(true);
        });
        head.append(icon, title, collapse);

        const body = document.createElement('div');
        body.className = 'ai-takeover-body';
        // 结构化明细（对齐补丁卡清单的观感）：键值行 + 强调色提示条，替代纯文字墙
        const detail = document.createElement('div');
        detail.className = 'ai-worktree-detail';
        const addRow = (key, value, mono = true) => {
            const row = document.createElement('div');
            row.className = 'ai-worktree-row';
            const keyEl = document.createElement('span');
            keyEl.className = 'ai-worktree-key';
            keyEl.textContent = key;
            const valEl = document.createElement('span');
            valEl.className = 'ai-worktree-val' + (mono ? '' : ' plain');
            if (value instanceof Node) valEl.appendChild(value);
            else valEl.textContent = value;
            row.append(keyEl, valEl);
            detail.appendChild(row);
        };
        const addNote = (iconName, message, danger = false) => {
            const note = document.createElement('div');
            note.className = 'ai-worktree-note' + (danger ? ' danger' : '');
            const noteIcon = document.createElement('span');
            noteIcon.className = 'ai-worktree-note-icon';
            noteIcon.innerHTML = iconSvg(iconName, 12);
            const noteText = document.createElement('span');
            noteText.textContent = message;
            note.append(noteIcon, noteText);
            body.appendChild(note);
        };
        if (discard) {
            // 原因放第一行：用户先要知道「为什么收尾」，再看后果
            if (approval.reason) addRow('原因', approval.reason, false);
            addRow('位置', approval.relPath || approval.name || '');
            addRow('分支', approval.branch || '隔离分支');
            if (approval.stat) addRow('改动', worktreeStatNode(approval.stat));
            addRow('影响', 'worktree 与分支一并删除；未导出的改动会丢失');
            body.appendChild(detail);
            addNote('warn', '删除不可恢复；主根不受影响。', true);
        } else {
            // 原因放第一行：这是 AI 主动发起，用户最先要判断的是「该不该隔离」
            if (approval.reason) addRow('原因', approval.reason, false);
            // slug 由后端按「用途名-会话尾号」派生：这里按同一规则预测出真实路径给人看
            // （同名冲突时 Go 会顺延 -2/-3，实际名以工具结果为准）
            if (approval.slug) {
                addRow('位置', worktreeRelPath(approval.slug) + '/');
                addRow('分支', 'cadt/wt/' + approval.slug);
            } else {
                addRow('去向', '主根 .cadt/worktree/ 下的独立检出副本', false);
            }
            if (approval.label) addRow('用途', approval.label, false);
            if (approval.carry) addRow('带入', '主根当前未提交改动 → 快照基准', false);
            body.appendChild(detail);
            addNote('info', '主根零改动；完成后 AI 经补丁审批卡回灌。拒绝后只能在主根按常规流程继续。');
        }

        const foot = document.createElement('div');
        foot.className = 'ai-takeover-foot ai-approval-takeover-foot';
        const hint = document.createElement('span');
        hint.className = 'ai-takeover-hint';
        hint.textContent = '由 AI 发起 · 批准后才执行';
        const actions = document.createElement('div');
        actions.className = 'ai-approval-actions';
        const deny = document.createElement('button');
        deny.type = 'button';
        deny.className = 'dlg-btn';
        deny.textContent = discard ? '保留' : '取消';
        deny.addEventListener('click', () => decideApproval(toolMessage, false));
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'dlg-btn ' + (discard ? 'danger' : 'primary');
        apply.textContent = discard ? '丢弃隔离区' : '创建隔离区';
        apply.addEventListener('click', () => decideApproval(toolMessage, true));
        actions.append(deny, apply);
        foot.append(hint, actions);
        card.append(head, body, foot);
        el.takeover.appendChild(card);
    }

    // 编排计划审批：复用 composer 接管卡，正文由 orchestration 域的编辑器挂载；
    // 折叠只影响显示，审批/提交状态仍在编辑器内，收起再展开不会丢失已填内容。
    function renderOrchestrationTakeover(entry) {
        const toolMessage = entry.toolMessage;
        const record = getOrchestrationApproval(toolMessage);
        const takeoverKey = 'approval:' + (toolMessage.toolCallId || '');
        el.takeover.dataset.takeoverKey = takeoverKey;
        el.takeover.textContent = '';
        if (orchestrationTakeoverKey !== takeoverKey) {
            orchestrationTakeoverKey = takeoverKey;
            orchestrationTakeoverCollapsed = false;
        }
        if (!record) {
            const card = document.createElement('div');
            card.className = 'ai-takeover-card ai-orchestration-takeover';
            const body = document.createElement('div');
            body.className = 'ai-takeover-body';
            body.textContent = '编排计划审批状态已丢失，请重新发起（orchestration_plan）。';
            card.appendChild(body);
            el.takeover.appendChild(card);
            return;
        }
        if (orchestrationTakeoverCollapsed) {
            const bar = document.createElement('button');
            bar.type = 'button';
            bar.className = 'ai-takeover-bar';
            const barIcon = document.createElement('span');
            barIcon.className = 'ai-takeover-icon';
            barIcon.innerHTML = iconSvg('branch', 13);
            const barText = document.createElement('span');
            barText.className = 'ai-takeover-bar-text';
            barText.textContent = (record.pendingText || '编排计划待批准') + (record.subtitle ? ' · ' + record.subtitle : '');
            const chev = document.createElement('span');
            chev.className = 'ai-takeover-collapse';
            chev.innerHTML = AI_CHEVRON_SVG;
            bar.append(barIcon, barText, chev);
            bar.addEventListener('click', () => {
                orchestrationTakeoverCollapsed = false;
                updateComposerTakeover(true);
            });
            el.takeover.appendChild(bar);
            return;
        }
        const card = document.createElement('div');
        card.className = 'ai-takeover-card ai-orchestration-takeover';
        const head = document.createElement('div');
        head.className = 'ai-takeover-head';
        const icon = document.createElement('span');
        icon.className = 'ai-takeover-icon';
        icon.innerHTML = iconSvg('branch', 13);
        const title = document.createElement('span');
        title.className = 'ai-takeover-title';
        title.textContent = record.title || '编排计划审批';
        const collapse = document.createElement('button');
        collapse.type = 'button';
        collapse.className = 'ai-takeover-collapse';
        collapse.innerHTML = AI_CHEVRON_SVG;
        collapse.addEventListener('click', () => {
            orchestrationTakeoverCollapsed = true;
            updateComposerTakeover(true);
        });
        head.append(icon, title, collapse);
        const body = document.createElement('div');
        body.className = 'ai-takeover-body ai-orchestration-takeover-body';
        const foot = document.createElement('div');
        foot.className = 'ai-takeover-foot ai-orchestration-takeover-foot';
        record.mount(body, foot, {
            finish: (approved) => decideApproval(toolMessage, approved),
            // 与 submit_plan 的「继续规划」同义：不是拒绝，而是把计划退回给母会话修订。
            continue: () => {
                const entry = pendingApprovals && pendingApprovals.get(toolMessage.toolCallId);
                if (entry && entry.approval) entry.approval.continue = true;
                decideApproval(toolMessage, false);
            },
        });
        card.append(head, body, foot);
        el.takeover.appendChild(card);
    }

    function planApprovalMessage(session) {
        if (!session || isSessionBusy(session.id) || !session.planMode) return null;
        // 计划唯一真源是 session.activePlan：pending 且属于本会话才弹审批卡。
        // 不扫消息——模型提交后补一句话、工具轮，都不影响卡的显示与指向。
        const plan = session.activePlan;
        if (!plan || plan.status !== 'pending' || !String(plan.markdown || '').trim()) return null;
        return plan;
    }

    function planApprovalKey(session, plan) {
        return session.id + ':' + (Number(plan.ts) || 0) + ':' + String(plan.markdown || '').length;
    }

    // 计划审批卡临时收起状态（仅显示层，不影响审批）：换一条计划（key 变化）自动复位展开。
    // 与审批卡 / 提问卡同口径——收起后仍可从细条恢复，「执行计划 / 继续规划」不受影响。
    // 宿主不需要读写它，故存在本工厂闭包内（createAITakeover 只在面板初始化时创建一次）。
    let planTakeoverKey = '';
    let planTakeoverCollapsed = false;

    // ---- 系统接管（通用；系统发起、模型不可见） ----
    const systemCountdownTimers = new Map();

    function stopSystemCountdown(key) {
        const item = systemCountdownTimers.get(key);
        if (!item) return;
        clearInterval(item.timer);
        systemCountdownTimers.delete(key);
    }

    function systemRemainingText(entry) {
        const sec = systemTakeoverHost ? systemTakeoverHost.remainingSec(entry) : 0;
        return sec > 0 ? '剩余 ' + sec + ' 秒' : '';
    }

    function bindSystemCountdown(entry, node) {
        stopSystemCountdown(entry.key);
        if (!entry.deadline) return;
        const tick = () => {
            const live = systemTakeoverHost.get(entry.key);
            if (!live) {
                stopSystemCountdown(entry.key);
                return;
            }
            node.textContent = systemRemainingText(live);
        };
        const timer = setInterval(tick, 1000);
        systemCountdownTimers.set(entry.key, {timer, node});
        tick();
    }

    // 通用外壳：标题 + 倒计时 + 说明 + 底部动作。body 只吃纯数据，专属渲染由调用方
    // 以 detail / meta 文本提供，避免系统接管模块反向依赖各业务 DOM。
    function renderSystemTakeover(entry) {
        const spec = entry.spec || {};
        const actions = Array.isArray(spec.actions) ? spec.actions : [];
        el.takeover.dataset.takeoverKey = 'system:' + entry.key;
        el.takeover.textContent = '';
        const card = document.createElement('div');
        card.className = 'ai-takeover-card ai-system-takeover';
        const head = document.createElement('div');
        head.className = 'ai-takeover-head';
        const icon = document.createElement('span');
        icon.className = 'ai-takeover-icon';
        icon.innerHTML = iconSvg('shield', 13);
        const title = document.createElement('span');
        title.className = 'ai-takeover-title';
        title.textContent = spec.title || '需要确认';
        head.append(icon, title);
        if (entry.deadline) {
            const countdown = document.createElement('span');
            countdown.className = 'ai-ask-countdown';
            bindSystemCountdown(entry, countdown);
            countdown.textContent = systemRemainingText(entry);
            head.appendChild(countdown);
        }
        const body = document.createElement('div');
        body.className = 'ai-takeover-body';
        const block = document.createElement('div');
        block.className = 'ai-ask-form-q single';
        if (spec.detail) {
            const q = document.createElement('div');
            q.className = 'ai-ask-question';
            q.textContent = spec.detail;
            block.appendChild(q);
        }
        if (spec.meta) {
            const meta = document.createElement('div');
            meta.className = 'ai-ask-detail';
            meta.textContent = spec.meta;
            block.appendChild(meta);
        }
        body.appendChild(block);
        const foot = document.createElement('div');
        foot.className = 'ai-takeover-foot';
        const hint = document.createElement('span');
        hint.className = 'ai-takeover-hint';
        hint.textContent = spec.hint || '';
        foot.appendChild(hint);
        for (const action of actions) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'dlg-btn' + (action.default ? ' primary' : '') + (action.tone === 'danger' ? ' danger' : '');
            button.textContent = action.label || String(action.value);
            button.addEventListener('click', () => {
                systemTakeoverHost.settle(entry.key, action.value, 'user');
            });
            foot.appendChild(button);
        }
        card.append(head, body, foot);
        el.takeover.appendChild(card);
    }

    function renderPlanTakeover(session, plan) {
        const key = planApprovalKey(session, plan);
        el.takeover.dataset.takeoverKey = 'plan:' + key;
        el.takeover.textContent = '';
        if (planTakeoverKey !== key) {
            planTakeoverKey = key;
            planTakeoverCollapsed = false;
        }
        // 收起态：单行细条，保留「计划等待批准」的可见性与计划标题，点击恢复完整卡
        if (planTakeoverCollapsed) {
            const bar = document.createElement('button');
            bar.type = 'button';
            bar.className = 'ai-takeover-bar';
            const barIcon = document.createElement('span');
            barIcon.className = 'ai-plan-takeover-icon';
            barIcon.innerHTML = iconSvg('plan', 16);
            const barText = document.createElement('span');
            barText.className = 'ai-takeover-bar-text';
            const digest = planDigest(String(plan.markdown || '').trim());
            barText.textContent = '计划等待批准' + (digest.title ? ' · ' + digest.title : '');
            const chev = document.createElement('span');
            chev.className = 'ai-takeover-collapse';
            chev.innerHTML = AI_CHEVRON_SVG;
            bar.append(barIcon, barText, chev);
            bar.addEventListener('click', () => {
                planTakeoverCollapsed = false;
                updateComposerTakeover(true);
            });
            el.takeover.appendChild(bar);
            return;
        }
        const card = document.createElement('div');
        card.className = 'ai-takeover-card ai-plan-takeover';
        const head = document.createElement('div');
        head.className = 'ai-takeover-head';
        const icon = document.createElement('span');
        icon.className = 'ai-plan-takeover-icon';
        icon.innerHTML = iconSvg('plan', 16);
        const title = document.createElement('span');
        title.className = 'ai-takeover-title';
        title.textContent = '计划等待批准';
        const mode = document.createElement('span');
        mode.className = 'ai-takeover-mode';
        mode.textContent = '计划模式';
        head.append(icon, title, mode);
        // 临时收起：折叠整卡为细条，方便继续查看上方消息；审批本身不受影响
        const collapse = document.createElement('button');
        collapse.type = 'button';
        collapse.className = 'ai-takeover-collapse';
        collapse.innerHTML = AI_CHEVRON_SVG;
        collapse.addEventListener('click', () => {
            planTakeoverCollapsed = true;
            updateComposerTakeover(true);
        });
        head.appendChild(collapse);
        const body = document.createElement('div');
        body.className = 'ai-takeover-body';
        const preview = document.createElement('div');
        preview.className = 'ai-plan-preview ai-md';
        // plan 是 session.activePlan（pending）；审批卡只在待批准状态出现，不需要「已落盘」分支
        const text = String(plan.markdown || '').trim();
        const digest = planDigest(text);
        // 未批准不落盘：预览只给截断片段——planPreviewSlice 只在行边界 + 围栏外切（结构化
        // 计划格式不伤），走共享渲染链（markdown-it → DOMPurify → hljs），原始 HTML 不执行。
        // 「查看完整计划」放预览区**外面**（固定可见，不跟着内容滚走），点击打开虚拟只读预览（不写盘）。
        const slice = planPreviewSlice(text, PLAN_PREVIEW_CHARS);
        preview.innerHTML = renderMarkdown(slice.text + (slice.truncated ? '\n\n…' : ''));
        const openFull = document.createElement('button');
        openFull.type = 'button';
        openFull.className = 'dlg-btn ai-plan-file-open';
        openFull.textContent = '查看完整计划';
        openFull.addEventListener('click', () => {
            if (openPlan) openPlan(session);
        });
        const openFullRow = document.createElement('div');
        openFullRow.className = 'ai-plan-file-row';
        const note = document.createElement('span');
        note.className = 'ai-plan-file-note';
        note.textContent = digest.lines + ' 行 · ' + digest.chars + ' 字 · 尚未保存成文件，批准后写入 .cadt/plan/';
        openFullRow.append(note, openFull);
        body.appendChild(preview);
        body.appendChild(openFullRow);
        // 批准时可一并授权的命令清单：AI 申报（submit_plan commands，权威、带 purpose）在前，
        // 正文扫描出的同类签名（collectCommandFamilies）兜底。危险命令只展示不预授权——
        // 执行期仍逐次单次确认（dangerous 短路在会话规则之前，安全不变式不动）。
        const grantItems = mergePlanGrantItems(plan.declaredCommands, collectCommandFamilies(text));
        const selectedGrants = new Map();
        if (grantItems.length && AI_WRITE_SCOPES.includes(currentScopeOf(session))) {
            const grant = document.createElement('div');
            grant.className = 'ai-plan-grant';
            const grantTitle = document.createElement('div');
            grantTitle.className = 'ai-plan-grant-title';
            grantTitle.textContent = '批准后本会话允许的命令（可取消勾选）';
            grant.appendChild(grantTitle);
            let withheldCount = 0;
            for (const item of grantItems) {
                const grantable = !item.dangerous && (item.mode === 'family' || item.mode === 'exact');
                const shown = item.mode === 'family' ? item.signature : item.command;
                if (!grantable) withheldCount += 1;
                const label = document.createElement('label');
                label.className = 'ai-plan-grant-item' + (grantable ? '' : ' ai-plan-grant-item-off') +
                    (item.dangerous ? ' ai-plan-grant-item-danger' : '');
                if (grantable) {
                    const key = item.mode + ':' + shown;
                    selectedGrants.set(key, item);
                    const box = document.createElement('input');
                    box.type = 'checkbox';
                    box.checked = true;
                    box.addEventListener('change', () => {
                        if (box.checked) selectedGrants.set(key, item);
                        else selectedGrants.delete(key);
                    });
                    const code = document.createElement('code');
                    code.textContent = shown;
                    if (item.mode === 'exact') {
                        // 精确匹配存的是完整命令，可能超宽：CSS 截断 + tooltip 补全文。
                        code.classList.add('ai-plan-grant-cmd');
                        code.dataset.tip = item.command;
                    }
                    label.append(box, code);
                } else {
                    const code = document.createElement('code');
                    code.textContent = shown;
                    const why = document.createElement('span');
                    why.className = 'ai-plan-grant-why';
                    why.textContent = item.dangerous
                        ? (item.dangerLabel || '危险命令') + '，执行时仍需单次确认'
                        : (item.reason || '不做预授权');
                    label.append(code, why);
                }
                if (item.purpose) {
                    const purpose = document.createElement('span');
                    purpose.className = 'ai-plan-grant-purpose';
                    purpose.textContent = item.purpose;
                    label.appendChild(purpose);
                }
                grant.appendChild(label);
            }
            const grantHint = document.createElement('div');
            grantHint.className = 'ai-approval-more';
            grantHint.textContent = '只对同工作目录、不含管道 / 重定向 / 命令串联的简单命令生效。' +
                (withheldCount ? '灰项不预授权：危险命令执行时仍逐次确认。' : '');
            grant.appendChild(grantHint);
            body.appendChild(grant);
        }
        const foot = document.createElement('div');
        foot.className = 'ai-takeover-foot';
        const readOnly = currentScopeOf(session) === 'read';
        // 「在隔离区中执行」开关（默认关）：取代原先左下角的静态提示「批准后开始执行」。
        // 勾选后点「执行计划」会先建一个隔离 git worktree，再让 AI 在隔离区里执行——
        // 批准卡本身就是一次明确确认，创建隔离区不再弹第二次确认框。只读档不能隔离开发，禁用并说明原因。
        const wtRow = document.createElement('div');
        wtRow.className = 'ai-plan-worktree-row';
        const wtText = document.createElement('span');
        wtText.className = 'ai-plan-worktree-label';
        wtText.textContent = '在隔离区中执行';
        const wtSwitch = createSwitch({
            checked: false,
            title: '开启后先创建一个隔离 git worktree，计划的所有改动只落在隔离区，完成后经补丁审阅回灌主根',
        });
        if (readOnly) {
            wtSwitch.control.disabled = true;
            wtRow.dataset.tip = '只读访问档不能隔离开发：先切换到「每次询问」或更高权限';
        }
        wtRow.append(wtText, wtSwitch.element);
        if (readOnly) {
            const permission = document.createElement('button');
            permission.type = 'button';
            permission.className = 'dlg-btn';
            permission.textContent = '切换到每次询问';
            permission.addEventListener('click', () => {
                setScope('edit');
                updateComposerTakeover(true);
                renderMessageQueue();
            });
            foot.appendChild(permission);
        }
        const continueBtn = document.createElement('button');
        continueBtn.type = 'button';
        continueBtn.className = 'dlg-btn';
        continueBtn.textContent = '继续规划';
        continueBtn.addEventListener('click', () => {
            setDismissedPlanApproval(key);
            updateComposerTakeover(true);
            renderMessageQueue();
            if (el.input) el.input.focus();
            flash('已按你的意见继续规划');
        });
        const accept = document.createElement('button');
        accept.type = 'button';
        accept.className = 'dlg-btn primary';
        accept.textContent = '执行计划';
        accept.addEventListener('click', () => acceptPlan(session, Array.from(selectedGrants.values()), {
            inWorktree: wtSwitch.control.checked,
        }));
        foot.append(wtRow, continueBtn, accept);
        card.append(head, body, foot);
        el.takeover.appendChild(card);
    }

    // takeoverHost / sessionOverride：内容区支线对话标签页的接管区（宿主不是面板）。
    // 面板调用保持无参，行为不变；外部宿主时不碰 composer 类名与浮层定位。
    function updateComposerTakeover(force, sessionOverride, takeoverHost) {
        const host = takeoverHost || el.takeover;
        if (!host) return;
        if (!takeoverHost && !el.composer) return;
        const sessionId = sessionOverride ? sessionOverride.id : '';
        // 系统接管优先：守卫发生在流式思考中，与模型可见的 ask / 审批天然互斥。
        const systemEntry = currentSystemTakeoverEntry(sessionId);
        const ask = systemEntry ? null : currentPendingAskEntry(sessionId);
        const env = (systemEntry || ask) ? null : currentPendingEnvEntry(sessionId);
        const approvalEntry = (systemEntry || ask || env) ? null : currentPendingApprovalEntry(sessionId);
        const session = sessionOverride || currentSession();
        const plan = (systemEntry || ask || env || approvalEntry) ? null : planApprovalMessage(session);
        const planKey = plan ? planApprovalKey(session, plan) : '';
        if (!systemEntry) {
            for (const key of [...systemCountdownTimers.keys()]) stopSystemCountdown(key);
        }
        let key = '';
        if (systemEntry) key = 'system:' + systemEntry.key;
        else if (ask) key = 'ask:' + askTakeoverKey(ask);
        else if (env) key = 'env:' + ((env.toolMessage && env.toolMessage.toolCallId) || '');
        else if (approvalEntry) key = 'approval:' + ((approvalEntry.toolMessage && approvalEntry.toolMessage.toolCallId) || '');
        else if (plan && getDismissedPlanApproval() !== planKey) key = 'plan:' + planKey;
        if (!force && key && host.dataset.takeoverKey === key) return;
        if (!key) {
            host.dataset.takeoverKey = '';
            host.classList.add('hidden');
            host.textContent = '';
            if (!takeoverHost && el.composer) el.composer.classList.remove('ai-takeover-active');
            if (!takeoverHost) positionOverlays();
            return;
        }
        host.dataset.takeoverKey = key;
        host.classList.remove('hidden');
        if (!takeoverHost && el.composer) el.composer.classList.add('ai-takeover-active');
        // 三个渲染函数都写 el.takeover：外部宿主时临时换引用，try/finally 复位
        const prevTakeover = el.takeover;
        if (takeoverHost) el.takeover = host;
        try {
            if (systemEntry) renderSystemTakeover(systemEntry);
            else if (ask) renderAskTakeover(ask);
            else if (env) renderEnvAskTakeover(env);
            else if (approvalEntry) renderApprovalTakeover(approvalEntry);
            else if (plan) renderPlanTakeover(session, plan);
        } finally {
            if (takeoverHost) el.takeover = prevTakeover;
        }
        if (takeoverHost) return;
        positionOverlays();
        if (getStickBottom()) scrollToBottom(false);
    }
    return {
        requestPatchApproval,
        planApprovalMessage,
        planApprovalKey,
        renderPatchTakeover,
        renderPatchApprovalBody,
        renderApprovalTakeover,
        renderAskTakeover,
        renderPlanTakeover,
        updateComposerTakeover,
    };
}
