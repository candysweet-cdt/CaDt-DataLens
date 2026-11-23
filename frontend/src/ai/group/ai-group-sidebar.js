// ai-group-sidebar.js：AI 侧栏「会话 | 群聊」分段、群聊列表与新建群聊弹窗（含兼容性预检）。
// 列表只读 meta（快照来自 runtime.subscribe）；创建弹窗用面板对话框三件套，
// 表单控件一律走 core/form-controls.js（表单控件硬规范）。
// 预检纯函数与内置主持人模板在 ai-group-model.js。
import {createInput, createSelect, createSwitch, createTextarea} from '../../core/form-controls.js';
import {iconSvg} from '../../core/icons.js';
import {relativeTime} from '../../core/humanize.js';
import {aiNowId} from '../core/ai-constants.js';
import {AGENT_COLOR_HEX, agentGroups, agentsByGroup} from '../agent/ai-agent-model.js';
import {agentsUpsert} from '../agent/ai-agent-model.js';
import {
    BRIEF_BOARD_TOKEN_BUDGET,
    BUILTIN_CHAIR,
    CHAIR_KINDS,
    CHAIR_POLICIES,
    GROUP_GOALS,
    deriveMaxSpeeches,
    estimateDiscussionCalls,
    normalizeGroupMeta,
    normalizeGroupMode,
    preflightGroup,
} from './ai-group-model.js';

export function createAIGroupSidebar(deps) {
    // 新建群聊弹窗的成员分组折叠记忆（跨弹窗保留用户偏好）
    const gcCollapsedGroups = new Set();
    const runtime = deps.runtime;
    const getAIConfig = deps.getAIConfig || (() => null);
    const saveConfig = deps.saveConfig || (() => {});
    const flash = deps.flash || (() => {});
    const dialog = deps.dialog || {};
    const openDialog = dialog.open || (() => {});
    const closeDialog = dialog.close || (() => {});
    const node = dialog.node || ((tag, className, text) => {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text != null) el.textContent = text;
        return el;
    });
    const dialogButton = dialog.button || null;
    const enhanceSelect = dialog.enhanceSelect || null;
    // 弹窗左下角齿轮：直达 应用页面 → 智能体（宿主注入 openAppPageTab）
    const openAppPageTab = typeof deps.openAppPageTab === 'function' ? deps.openAppPageTab : null;

    const els = {
        panel: document.getElementById('ai-sessions-panel'),
        segment: document.getElementById('ai-list-segment'),
        sessionList: document.getElementById('ai-session-list'),
        sessionActions: document.getElementById('ai-session-actions'),
        groupList: document.getElementById('ai-group-list'),
        groupActions: document.getElementById('ai-group-actions'),
        groupNew: document.getElementById('ai-group-action-new'),
    };

    // ---------- 分段与列表 ----------

    function bindSidebar() {
        if (els.segment && !els.segment.dataset.gcBound) {
            els.segment.dataset.gcBound = '1';
            for (const button of els.segment.querySelectorAll('button[data-list]')) {
                button.addEventListener('click', () => {
                    runtime.setListMode(button.dataset.list);
                    if (!runtime.groupList().length && button.dataset.list === 'groups') {
                        // 切到空列表时兜底刷一次（首次进入可能还没拉完）
                        runtime.refreshList().catch(() => {});
                    }
                });
            }
        }
        if (els.groupNew && !els.groupNew.dataset.gcBound) {
            els.groupNew.dataset.gcBound = '1';
            els.groupNew.addEventListener('click', () => openCreateDialog());
        }
        runtime.subscribe((snap) => {
            applyListMode(snap.listMode);
            renderGroupList(snap.groups);
        });
        applyListMode(runtime.getListMode());
        renderGroupList(runtime.groupList());
    }

    function applyListMode(mode) {
        const groups = mode === 'groups';
        if (els.panel) {
            // 分段模式同步到面板根：CSS 据此隐藏会话过滤按钮/行（过滤只作用于会话列表）
            els.panel.dataset.listMode = groups ? 'groups' : 'sessions';
        }
        if (els.segment) {
            // 分段控件的滑动指示块由 data-mode 驱动（thumb 的 transform 过渡）
            els.segment.dataset.mode = groups ? 'groups' : 'sessions';
            for (const button of els.segment.querySelectorAll('button[data-list]')) {
                button.classList.toggle('active', button.dataset.list === mode);
            }
        }
        if (els.sessionList) els.sessionList.classList.toggle('hidden', groups);
        if (els.sessionActions) els.sessionActions.classList.toggle('hidden', groups);
        if (els.groupList) els.groupList.classList.toggle('hidden', !groups);
        if (els.groupActions) els.groupActions.classList.toggle('hidden', !groups);
    }

    // 当前在 AI 面板打开的群（panel onViewChange 回填）：列表行高亮
    let activeGroupId = '';

    function setActiveGroup(id) {
        const next = String(id || '');
        if (activeGroupId === next) return;
        activeGroupId = next;
        renderGroupList(runtime.groupList());
    }



    // 运行指示：有流式发言或讨论（含暂停）时亮脉冲点
    function groupRunning(meta) {
        if (runtime.activeStreamOf(meta.id)) return true;
        const disc = runtime.discussionSnapshot(meta.id);
        return !!(disc && (disc.running || disc.paused));
    }

    function renderGroupList(metas) {
        if (!els.groupList) return;
        els.groupList.innerHTML = '';
        if (!metas || !metas.length) {
            const empty = node('div', 'gc-list-empty');
            empty.textContent = '还没有群聊。新建一个圆桌，让多个智能体就一个议题多轮讨论。';
            els.groupList.appendChild(empty);
            return;
        }
        const config = getAIConfig();
        const agents = (config && Array.isArray(config.agents)) ? config.agents : [];
        for (const meta of metas) {
            els.groupList.appendChild(groupRow(meta, agents));
        }
    }

    function groupRow(meta, agents) {
        const row = node('div', 'ai-session-item gc-list-row' + (meta.id === activeGroupId ? ' active' : ''));
        const head = node('div', 'gc-list-head');
        head.appendChild(node('span', 'gc-list-title', meta.title || '未命名群聊'));
        head.appendChild(node('span', 'gc-badge gc-badge-mode', modeLabel(meta.mode)));
        if (groupRunning(meta)) {
            const pulse = node('span', 'gc-list-pulse');
            pulse.dataset.tip = meta.mode === 'free' ? '有成员正在发言' : '讨论进行中';
            head.appendChild(pulse);
        }
        row.appendChild(head);
        // 最近消息预览（meta.lastPreview 由 runtime 落盘时写入；老群回落成员数 + 目标）
        const preview = String(meta.lastPreview || '').trim();
        row.appendChild(node('div', 'gc-list-preview', preview || `${meta.memberIds.length} 成员 · ${goalLabel(meta.goal)}`));
        const foot = node('div', 'gc-list-foot');
        const avatars = node('div', 'gc-list-avatars');
        for (const id of meta.memberIds) {
            const agent = agents.find((item) => item && item.id === id);
            const avatar = node('span', 'gc-avatar gc-avatar-sm');
            avatar.textContent = (agent ? agent.name : '?').trim().charAt(0) || '?';
            avatar.style.background = AGENT_COLOR_HEX[agent && agent.color] || '#989898';
            avatar.dataset.tip = agent ? agent.name : '已删除成员';
            avatars.appendChild(avatar);
        }
        foot.appendChild(avatars);
        foot.appendChild(node('span', 'gc-list-meta', relativeTime(meta.updatedAt)));
        // 监控窗（辅助窗第一批）：只读镜像群聊时间线，不改群聊归属
        const pop = node('button', 'gc-list-del', '监控');
        pop.type = 'button';
        pop.dataset.tip = '在独立窗口打开（只读监控）';
        pop.addEventListener('click', (e) => {
            e.stopPropagation();
            const b = deps.backend;
            if (!b || typeof b.PopOutSession !== 'function') {
                flash('当前构建不支持监控窗', true);
                return;
            }
            b.PopOutSession(meta.id, 'group', '').catch((err) => flash('打开监控窗失败：' + ((err && err.message) || err), true));
        });
        foot.appendChild(pop);
        const del = node('button', 'gc-list-del', '删除');
        del.type = 'button';
        del.dataset.tip = '删除群聊（回收站可撤销）';
        del.addEventListener('click', (e) => {
            e.stopPropagation();
            askDeleteGroup(meta);
        });
        foot.appendChild(del);
        row.appendChild(foot);
        row.addEventListener('click', () => runtime.openGroup(meta.id));
        return row;
    }

    function modeLabel(mode) {
        return mode === 'task' ? '任务' : mode === 'free' ? '自由' : '圆桌';
    }

    function goalLabel(goal) {
        return (GROUP_GOALS.find((g) => g.id === goal) || {label: '探索'}).label;
    }

    function askDeleteGroup(meta) {
        if (typeof deps.confirm === 'function') {
            deps.confirm(`删除群聊「${meta.title || '未命名群聊'}」？共享对话与各成员私有过程一起进回收站。`, async () => {
                const result = await runtime.deleteGroup(meta.id);
                if (result.ok) flash('群聊已删除（回收站可撤销）');
            }, '删除', '删除群聊');
        } else {
            runtime.deleteGroup(meta.id);
        }
    }

    // ---------- 新建群聊弹窗 ----------

    // 弹窗控件表；collectDraft 读取。成员勾选用开关列表（form-controls 规范）。
    let createControls = null;

    function openCreateDialog() {
        const config = getAIConfig();
        const agents = (config && Array.isArray(config.agents)) ? config.agents.filter((a) => a && a.enabled) : [];
        const profiles = (config && Array.isArray(config.profiles)) ? config.profiles : [];
        if (!agents.length) {
            flash('还没有可用智能体：先到 应用页面 → 智能体 创建成员', true);
            return;
        }

        const body = node('div', 'gc-create-form');
        // factory 是 core/form-controls 的 {element, control}：挂 .element，返回 factory 供取值；
        // wrap 存 factory.wrapEl（模式切换要整行显隐）
        const row = (labelText, factory, className) => {
            const wrap = node('div', 'gc-form-row' + (className ? ' ' + className : ''));
            wrap.appendChild(node('span', 'gc-form-label', labelText));
            wrap.appendChild(factory.element);
            body.appendChild(wrap);
            factory.wrapEl = wrap;
            return factory;
        };

        const titleCtl = row('群名', createInput({value: '', placeholder: '例如：存储方案评审', maxlength: String(60)}));
        const topicCtl = row('议题', createTextarea({rows: 2, value: '', placeholder: '要讨论的问题与背景约束（进入主持人开场）'}), 'gc-form-row-top');
        const goalCtl = row('目标', createSelect({options: GROUP_GOALS.map((g) => ({value: g.id, label: g.label, selected: g.id === 'decide'}))}));
        const modeCtl = row('模式', createSelect({options: [
            {value: 'roundtable', label: '圆桌讨论（推荐）', selected: true},
            {value: 'task', label: '任务协作（主持人拆任务板）'},
            {value: 'free', label: '自由聊天（像微信群：@谁谁回）'},
            {value: 'relay', label: '接力流水线（多模型按序交棒，后者可回问前者）'},
        ]}));
        // 预设（§1.4）：辩论/评审给成员分配角色，发言顺序按 正 → 反 → 评审 交替
        const presetCtl = row('预设', createSelect({options: [
            {value: 'standard', label: '标准圆桌', selected: true},
            {value: 'debate', label: '辩论（正—反—评审）'},
            {value: 'review', label: '评审团'},
        ]}));

        // 成员勾选（开关列表 + 能力徽标）：按智能体分组分区渲染；组多时顶部给过滤下拉
        const groups = agentGroups(agents);
        const memberWrap = node('div', 'gc-member-list');
        const memberSwitches = [];
        const roleInputs = {};
        const memberItems = []; // {agentId, group, item}
        for (const part of agentsByGroup(agents)) {
            const collapsed = gcCollapsedGroups.has(part.group);
            const head = node('div', 'gc-group-head' + (collapsed ? ' collapsed' : ''));
            head.dataset.group = part.group;
            head.dataset.tip = collapsed ? '展开「' + part.group + '」组的成员' : '折叠「' + part.group + '」组的成员';
            const chevron = node('span', 'gc-group-chevron');
            chevron.innerHTML = iconSvg('chevron-down', 10);
            head.appendChild(chevron);
            head.appendChild(node('span', 'gc-group-name', part.group));
            head.appendChild(node('span', 'gc-group-count', String(part.agents.length)));
            head.addEventListener('click', () => {
                if (gcCollapsedGroups.has(part.group)) gcCollapsedGroups.delete(part.group);
                else gcCollapsedGroups.add(part.group);
                applyMemberVisibility();
            });
            memberWrap.appendChild(head);
            for (const agent of part.agents) {
                const item = node('div', 'gc-member-item');
                item.dataset.group = part.group;
                const dot = node('span', 'gc-dot gc-dot-lg');
                dot.style.backgroundColor = AGENT_COLOR_HEX[agent.color] || '#989898';
                item.appendChild(dot);
                const textCol = node('div', 'gc-member-text');
                textCol.appendChild(node('div', 'set-title', agent.name));
                textCol.appendChild(node('div', 'set-desc', agent.role || agentCapabilityLabel(agent, profiles)));
                item.appendChild(textCol);
                const cap = preflightGroup({agents, profiles, memberIds: [agent.id], sharedTokens: 0, boardTokens: BRIEF_BOARD_TOKEN_BUDGET})[0];
                const badge = node('span', 'gc-badge gc-level-' + (cap ? cap.level : 'red'), cap ? capLevelText(cap.level) : '红');
                item.appendChild(badge);
                const sw = createSwitch({checked: false});
                item.appendChild(sw.element);
                // 接力链序（G7）：勾选顺序 = 链序；徽标 + ▲▼ 只在接力模式勾选后显示
                const chainOrder = node('span', 'gc-chain-order hidden');
                item.appendChild(chainOrder);
                const chainUp = node('button', 'gc-chain-btn hidden');
                chainUp.type = 'button';
                chainUp.textContent = '▲';
                chainUp.dataset.tip = '把该成员在接力链中上移一棒';
                chainUp.addEventListener('click', () => moveChainMember(agent.id, -1));
                const chainDown = node('button', 'gc-chain-btn hidden');
                chainDown.type = 'button';
                chainDown.textContent = '▼';
                chainDown.dataset.tip = '把该成员在接力链中下移一棒';
                chainDown.addEventListener('click', () => moveChainMember(agent.id, 1));
                item.appendChild(chainUp);
                item.appendChild(chainDown);
                // 辩论/评审预设的角色输入（勾选后显示；占位按序号给正/反/评审提示）
                const roleInput = createInput({placeholder: '角色（如 正方 / 反方 / 评审）', maxlength: '80'});
                roleInput.element.classList.add('gc-member-role');
                roleInput.element.classList.add('hidden');
                item.appendChild(roleInput.element);
                roleInputs[agent.id] = roleInput;
                memberSwitches.push({agentId: agent.id, control: sw.control, index: memberSwitches.length,
                    chainOrder, chainUp, chainDown});
                memberItems.push({agentId: agent.id, group: part.group, item});
                sw.control.addEventListener('change', () => {
                    roleInput.element.classList.toggle('hidden', !sw.control.checked);
                    if (!sw.control.checked) roleInput.control.value = '';
                    refreshDerived();
                });
                memberWrap.appendChild(item);
            }
        }
        let filterCtl = null;
        // 接力链调序（G7）：在 memberSwitches 数组内交换两个已勾选成员的位置（跳过未勾选），
        // 勾选顺序 = 链序；行保持分组分区不动，序号徽标随 refreshChainOrder 重排
        const moveChainMember = (agentId, delta) => {
            const pickedIdx = memberSwitches
                .map((sw, i) => (sw.control.checked ? i : -1))
                .filter((i) => i >= 0);
            const rank = pickedIdx.indexOf(memberSwitches.findIndex((sw) => sw.agentId === agentId));
            const nextRank = rank + delta;
            if (rank < 0 || nextRank < 0 || nextRank >= pickedIdx.length) return;
            const a = pickedIdx[rank];
            const b = pickedIdx[nextRank];
            const tmp = memberSwitches[a];
            memberSwitches[a] = memberSwitches[b];
            memberSwitches[b] = tmp;
            refreshDerived();
        };
        // 成员可见性单一出口：分组过滤（>4 组时的下拉）× 折叠（组头点击）共同决定；
        // 折叠组保留组头（可展开），只藏成员行
        const applyMemberVisibility = () => {
            const picked = filterCtl ? filterCtl.control.value : '';
            const filterPass = (group) => !picked || group === picked;
            for (const entry of memberItems) {
                entry.item.classList.toggle('hidden', !filterPass(entry.group) || gcCollapsedGroups.has(entry.group));
            }
            for (const head of memberWrap.querySelectorAll('.gc-group-head')) {
                head.classList.toggle('hidden', !filterPass(head.dataset.group));
                head.classList.toggle('collapsed', gcCollapsedGroups.has(head.dataset.group));
            }
        };
        if (groups.length > 4) {
            // 分组过滤（纯展示）：选组只显示该组成员，组头随成员可见性收起
            filterCtl = createSelect({
                options: [{value: '', label: '全部分组'}].concat(groups.map((group) => ({value: group, label: group}))),
            });
            filterCtl.control.addEventListener('change', applyMemberVisibility);
            body.appendChild(wrapRow('分组', filterCtl.element, 'gc-form-row'));
        }
        body.appendChild(wrapRow('成员', memberWrap, 'gc-form-row-top'));

        // 主持人
        const chairAgents = agents.filter((agent) => agent.chair);
        const chairKindCtl = row('主持', createSelect({
            options: CHAIR_KINDS.map((k) => ({value: k.id, label: k.label, selected: k.id === 'ai'})),
        }));
        const chairAgentWrap = node('div', 'gc-form-row');
        chairAgentWrap.appendChild(node('span', 'gc-form-label', '主持人'));
        let chairAgentOptions = chairAgents.map((agent) => ({value: agent.id, label: agent.name}));
        if (!chairAgentOptions.length) chairAgentOptions = [{value: '', label: '没有主持人智能体'}];
        const chairAgentCtl = createSelect({options: chairAgentOptions});
        chairAgentWrap.appendChild(chairAgentCtl.element);
        const chairCreateBtn = node('button', 'dlg-btn', '一键创建默认主持人');
        chairCreateBtn.type = 'button';
        chairCreateBtn.addEventListener('click', () => {
            const created = createDefaultChairAgent();
            if (!created.ok) {
                flash(created.error, true);
                return;
            }
            chairAgentCtl.control.innerHTML = '';
            for (const option of [{value: created.agent.id, label: created.agent.name}]) {
                const item = document.createElement('option');
                item.value = option.value;
                item.textContent = option.label;
                chairAgentCtl.control.appendChild(item);
            }
            chairCreateBtn.classList.add('hidden');
            flash('已创建默认主持人智能体（应用页面 → 智能体 可编辑）');
        });
        if (chairAgents.length) chairCreateBtn.classList.add('hidden');
        chairAgentWrap.appendChild(chairCreateBtn);
        body.appendChild(chairAgentWrap);

        const policyCtl = row('策略', createSelect({options: CHAIR_POLICIES.map((p) => ({value: p.id, label: p.label, selected: p.id === 'round-plan'}))}));
        // 轮数（G6）：0 = 不限轮次（手动结束），默认 5；发言上限由 runtime 按「成员数 × 轮数」自动推导
        const roundsCtl = row('轮数', createSelect({options: [
            {value: '3', label: '3 轮'},
            {value: '5', label: '5 轮（推荐）', selected: true},
            {value: '10', label: '10 轮'},
            {value: '20', label: '20 轮'},
            {value: '0', label: '不限轮次（手动结束）'},
        ]}));
        const timeoutCtl = row('超时', createSelect({options: [
            {value: 'standard', label: '标准（首次 45s / 总 180s）', selected: true},
            {value: 'lenient', label: '宽松（首次 90s / 总 300s）'},
        ]}));

        const preflightBox = node('div', 'gc-preflight');
        body.appendChild(preflightBox);
        const estLine = node('div', 'gc-est-line');
        body.appendChild(estLine);

        const statusLine = node('div', 'set-desc');
        statusLine.style.minHeight = '14px';

        createControls = {title: titleCtl, topic: topicCtl, goal: goalCtl, mode: modeCtl, preset: presetCtl,
            memberSwitches, roleInputs,
            chairKind: chairKindCtl, chairAgent: chairAgentCtl, chairAgentWrap,
            policy: policyCtl,
            rounds: roundsCtl, timeout: timeoutCtl};

        const refreshDerived = () => {
            refreshModeVisibility();
            refreshChairVisibility();
            refreshPresetDefaults();
            refreshChainOrder();
            refreshPreflight(preflightBox, estLine, agents, profiles);
        };
        chairKindCtl.control.addEventListener('change', refreshDerived);
        for (const sw of memberSwitches) sw.control.addEventListener('change', refreshDerived);
        modeCtl.control.addEventListener('change', refreshDerived);
        presetCtl.control.addEventListener('change', refreshDerived);
        refreshDerived();

        const cancelBtn = dialogButton('取消', 'dlg-btn', () => {
            createControls = null;
            closeDialog();
        });
        const createBtn = dialogButton('创建群聊', 'dlg-btn primary', async () => {
            const draft = collectCreateDraft();
            const result = await runtime.createGroup(draft);
            if (!result.ok) {
                statusLine.textContent = result.error || '创建失败';
                return;
            }
            createControls = null;
            closeDialog();
        });
        // 左下角齿轮：先去应用页面把智能体备齐，再回来建群（开 应用页面 → 智能体 标签页）
        const settingsBtn = node('button', 'dlg-btn gc-settings-btn');
        settingsBtn.type = 'button';
        settingsBtn.dataset.tip = '应用页面 → 智能体';
        settingsBtn.setAttribute('aria-label', '打开应用页面 · 智能体');
        settingsBtn.innerHTML = iconSvg('gear', 14);
        settingsBtn.addEventListener('click', () => {
            if (!openAppPageTab) return;
            createControls = null;
            closeDialog();
            openAppPageTab('agents');
        });

        openDialog('新建群聊',
            [body],
            [settingsBtn, estLine, statusLine, cancelBtn, createBtn],
            {top: true, wide: true});
        if (typeof enhanceSelect === 'function') {
            // 与设置页/面板弹窗同一套行式下拉（原生 select 会露出系统下拉，和自绘控件混成两套）
            const enhances = [goalCtl, modeCtl, presetCtl, chairKindCtl, chairAgentCtl, policyCtl, roundsCtl, timeoutCtl];
            if (filterCtl) enhances.push(filterCtl);
            for (const ctl of enhances) {
                enhanceSelect(ctl.control);
            }
        }
    }

    function wrapRow(labelText, control, className) {
        const wrap = node('div', 'gc-form-row' + (className ? ' ' + className : ''));
        wrap.appendChild(node('span', 'gc-form-label', labelText));
        wrap.appendChild(control);
        return wrap;
    }

    function agentCapabilityLabel(agent, profiles) {
        const cap = preflightGroup({agents: [agent], profiles, memberIds: [agent.id], sharedTokens: 0, boardTokens: BRIEF_BOARD_TOKEN_BUDGET})[0];
        return cap && cap.detail ? cap.detail : '';
    }

    function capLevelText(level) {
        return level === 'red' ? '红' : level === 'yellow' ? '黄' : '绿';
    }

    function refreshChairVisibility() {
        void 0; // kind=ai 与 member 共用同一选择器，选项含义在 change 时重算
    }

    // 自由聊天没有主持人/预设/策略/轮数（消息即唤醒，无讨论循环）；接力同样无主持人/
    // 预设/轮数（链是确定性的，chair 固定 user、轮数不适用）——整行隐藏
    function refreshModeVisibility() {
        if (!createControls) return;
        const mode = createControls.mode.control.value;
        const hideRows = mode === 'free' || mode === 'relay';
        for (const ctl of [createControls.preset, createControls.chairKind, createControls.policy, createControls.rounds]) {
            if (ctl && ctl.wrapEl) ctl.wrapEl.classList.toggle('hidden', hideRows);
        }
        const chairRow = createControls.chairAgentWrap;
        if (chairRow) chairRow.classList.toggle('hidden', hideRows);
    }

    // 接力链序徽标与 ▲▼ 显隐（G7）：只在接力模式 + 已勾选时显示；序号 = 勾选顺序
    function refreshChainOrder() {
        if (!createControls) return;
        const relay = createControls.mode.control.value === 'relay';
        const pickedTotal = createControls.memberSwitches.filter((sw) => sw.control.checked).length;
        let rank = 0;
        for (const sw of createControls.memberSwitches) {
            const show = relay && sw.control.checked;
            sw.chainOrder.classList.toggle('hidden', !show);
            if (show) sw.chainOrder.textContent = '第' + (++rank) + '棒';
            sw.chainUp.classList.toggle('hidden', !show);
            sw.chainDown.classList.toggle('hidden', !show);
            sw.chainUp.disabled = !show || rank <= 1;
            sw.chainDown.disabled = !show || rank >= pickedTotal;
        }
    }

    // 辩论/评审预设（§1.4）：切预设时按勾选顺序填默认角色（正方/反方/评审…）并调目标
    function refreshPresetDefaults() {
        if (!createControls) return;
        if (createControls.mode.control.value === 'relay') return; // 接力不用预设角色
        const preset = createControls.preset.control.value;
        if (preset === 'standard') return;
        const picked = createControls.memberSwitches.filter((sw) => sw.control.checked);
        const defaults = preset === 'debate'
            ? ['正方', '反方', '评审', '领域专家', '评审', '正方补充', '反方补充', '评审']
            : ['评审', '领域专家', '被评审方', '评审', '领域专家', '评审', '领域专家', '评审'];
        picked.forEach((sw, index) => {
            const input = createControls.roleInputs[sw.agentId];
            if (input && !input.control.value.trim()) {
                input.control.value = defaults[index % defaults.length] || '';
                input.element.classList.remove('hidden');
            }
        });
        if (picked.length) {
            if (preset === 'review') createControls.goal.control.value = 'review';
            else if (preset === 'debate') createControls.goal.control.value = 'decide';
        }
    }

    // 辩论/评审的角色表（§1.4）：发言顺序由主持人按角色交替安排，角色进成员提示词
    function collectRoles() {
        if (!createControls) return {};
        const roles = {};
        for (const sw of createControls.memberSwitches) {
            if (!sw.control.checked) continue;
            const input = createControls.roleInputs[sw.agentId];
            const role = input ? String(input.control.value || '').trim() : '';
            if (role) roles[sw.agentId] = role.slice(0, 80);
        }
        return roles;
    }

    function pickedMemberIds() {
        if (!createControls) return [];
        return createControls.memberSwitches
            .filter((sw) => sw.control.checked)
            .map((sw) => sw.agentId);
    }

    function refreshPreflight(box, estLine, agents, profiles) {
        if (!box) return;
        box.innerHTML = '';
        const memberIds = pickedMemberIds();
        const chairKind = createControls ? createControls.chairKind.control.value : 'ai';
        let chairAgentId = createControls ? createControls.chairAgent.control.value : '';
        // 成员兼任：主持人即所选成员之一（只影响标注，不参与预检差异）
        if (chairKind === 'member' && !memberIds.includes(chairAgentId)) chairAgentId = memberIds[0] || '';
        const items = preflightGroup({agents, profiles, memberIds, sharedTokens: 0, boardTokens: BRIEF_BOARD_TOKEN_BUDGET});
        const summary = node('div', 'gc-preflight-summary');
        const counts = {green: 0, yellow: 0, red: 0};
        for (const item of items) counts[item.level]++;
        summary.appendChild(node('span', 'gc-badge gc-level-green', `绿 ${counts.green}`));
        summary.appendChild(node('span', 'gc-badge gc-level-yellow', `黄 ${counts.yellow}`));
        summary.appendChild(node('span', 'gc-badge gc-level-red', `红 ${counts.red}`));
        summary.appendChild(node('span', 'gc-preflight-note', '红 = 共享对话超出窗口将停止参与；黄 = 接近上限'));
        box.appendChild(summary);
        const detail = node('div', 'gc-preflight-detail');
        for (const item of items) {
            const line = node('div', 'gc-preflight-item gc-level-' + item.level);
            line.textContent = `${item.name}：${item.detail}`;
            detail.appendChild(line);
        }
        box.appendChild(detail);
        if (estLine) {
            const mode = createControls ? createControls.mode.control.value : '';
            if (mode === 'relay') {
                estLine.textContent = memberIds.length >= 2
                    ? `接力链：${memberIds.length} 棒（按勾选顺序，行上 ▲▼ 可调序）；每棒最多 4 次发言（含 2 次回问）；跑完自动出成果纪要`
                    : '勾选 2–8 位成员组成接力链（勾选顺序 = 链序）';
            } else if (mode === 'free') {
                estLine.textContent = memberIds.length >= 1
                    ? `自由聊天按消息唤醒：每条消息至少 1 次调用，@全体成员 ≈ ${memberIds.length} 次/条`
                    : '勾选 2–8 位成员后开始聊天';
            } else {
                const policy = createControls ? createControls.policy.control.value : 'round-plan';
                // '0' = 不限轮次：按发言上限估算（estimateDiscussionCalls 自带该分支）
                const rounds = createControls ? Number(createControls.rounds.control.value) : 5;
                const calls = estimateDiscussionCalls(memberIds.length, rounds, policy, deriveMaxSpeeches(memberIds.length, rounds));
                const roundsText = rounds === 0 ? '不限轮次' : `${memberIds.length} 成员 × ${rounds} 轮`;
                estLine.textContent = memberIds.length >= 2
                    ? `预计调用量：约 ${calls} 次（${roundsText}；发言上限 ${deriveMaxSpeeches(memberIds.length, rounds)} 次）`
                    : '勾选 2–8 位成员后开始讨论';
            }
        }
    }

    function collectCreateDraft() {
        if (!createControls) return {memberIds: []};
        const mode = normalizeGroupMode(createControls.mode.control.value);
        const isRelay = mode === 'relay';
        const chairKind = isRelay ? 'user' : createControls.chairKind.control.value;
        const memberIds = pickedMemberIds();
        let chairAgentId = isRelay ? '' : createControls.chairAgent.control.value;
        if (chairKind === 'member' && !memberIds.includes(chairAgentId)) {
            chairAgentId = memberIds[0] || '';
        }
        // 模式直传（归一化在 ai-group-model 的 normalizeGroupMode 单一来源）：
        // 这里曾写成「非 task 即 roundtable」，把 free 静默改写成圆桌，让自由聊天在 UI 上不可达。
        return {
            title: String(createControls.title.control.value || '').trim(),
            topic: String(createControls.topic.control.value || '').trim(),
            goal: createControls.goal.control.value,
            mode,
            roles: isRelay ? {} : collectRoles(),
            memberIds,
            chair: {kind: chairKind, agentId: chairKind === 'user' ? '' : chairAgentId, policy: createControls.policy.control.value},
            // 轮数三值直传（'0' = 不限轮次；Number 而不是 ||，否则 0 会被兜成 2）；接力不适用轮数
            maxRounds: isRelay ? 0 : Number(createControls.rounds.control.value),
            timeoutPreset: createControls.timeout.control.value,
        };
    }

    // 「一键创建默认主持人」（§16.2）：写内置模板进 agents[]，模型让用户后续自选。
    function createDefaultChairAgent() {
        const config = getAIConfig();
        if (!config) return {ok: false, error: '配置不可用'};
        const result = agentsUpsert(config.agents || [], {...BUILTIN_CHAIR, modelRef: ''}, () => aiNowId('agent-'));
        if (!result.ok) return {ok: false, error: result.error || '创建失败'};
        saveConfig();
        return {ok: true, agent: result.agent};
    }

    // 群设置（G6）：群名 / 议题 / 目标 / 轮数（0=不限）/ 发言上限 / 讨论总时长；
    // 保存走 normalizeGroupMeta 单一来源钳制后 saveMeta，头部与列表自动刷新。不改成员（静音在成员详情页）。
    function openGroupSettingsDialog(groupId) {
        const g = runtime.groupById(groupId);
        if (!g) {
            flash('群聊不存在或已删除');
            return;
        }
        const meta = g.meta;
        const titleCtl = createInput({value: meta.title || '', placeholder: '群名'});
        const topicCtl = createTextarea({rows: 3, value: meta.topic || '', placeholder: '议题（发给成员的讨论背景）'});
        const goalCtl = createSelect({options: GROUP_GOALS.map((item) => ({value: item.id, label: item.label, selected: item.id === meta.goal}))});
        const roundOptions = [3, 5, 10, 20].map((n) => ({value: String(n), label: n + ' 轮', selected: Number(meta.maxRounds) === n}));
        roundOptions.push({value: '0', label: '不限轮次（手动结束）', selected: Number(meta.maxRounds) === 0});
        if (![3, 5, 10, 20, 0].includes(Number(meta.maxRounds))) {
            roundOptions.unshift({value: String(meta.maxRounds), label: meta.maxRounds + ' 轮（当前）', selected: true});
        }
        const roundsCtl = createSelect({options: roundOptions});
        const speechesCtl = createInput({type: 'number', value: meta.maxSpeeches || 12, min: 12, max: 200, step: 1});
        const totalMinutes = Math.round((meta.timeouts && meta.timeouts.discussionTotalMs ? meta.timeouts.discussionTotalMs : 3600000) / 60000);
        const minutesCtl = createInput({type: 'number', value: totalMinutes, min: 15, max: 180, step: 5});
        const statusLine = node('div', 'set-desc');
        statusLine.style.minHeight = '14px';

        const body = node('div');
        body.appendChild(wrapRow('群名', titleCtl.element));
        body.appendChild(wrapRow('议题', topicCtl.element, 'gc-form-row-top'));
        body.appendChild(wrapRow('目标', goalCtl.element));
        body.appendChild(wrapRow('轮数', roundsCtl.element));
        body.appendChild(wrapRow('发言上限', speechesCtl.element));
        body.appendChild(wrapRow('总时长', minutesCtl.element));
        body.appendChild(node('div', 'gc-est-line', '发言上限 12–200 次；不限轮次时到达上限 / 总时长会自动生成纪要，或点「结束并总结」手动收敛。'));

        const cancelBtn = dialogButton ? dialogButton('取消', 'dlg-btn', () => closeDialog()) : node('button', 'dlg-btn', '取消');
        if (!dialogButton) cancelBtn.type = 'button';
        let saveBtn = dialogButton ? dialogButton('保存', 'dlg-btn primary', () => save()) : null;
        if (!saveBtn) {
            saveBtn = node('button', 'dlg-btn primary', '保存');
            saveBtn.type = 'button';
            saveBtn.addEventListener('click', () => save());
        }

        function save() {
            const minutes = Math.round(Number(minutesCtl.control.value));
            const merged = normalizeGroupMeta({
                ...meta,
                title: String(titleCtl.control.value || '').trim() || meta.title,
                topic: String(topicCtl.control.value || '').trim(),
                goal: goalCtl.control.value,
                maxRounds: Number(roundsCtl.control.value),
                maxSpeeches: Math.round(Number(speechesCtl.control.value)) || meta.maxSpeeches,
                timeouts: {...(meta.timeouts || {}), discussionTotalMs: Math.min(180, Math.max(15, minutes)) * 60000},
            });
            runtime.saveMeta(groupId, (m) => Object.assign(m, merged));
            closeDialog();
            flash('群设置已保存');
        }

        openDialog('群设置 · ' + (meta.title || '未命名群聊'), [body, statusLine], [cancelBtn, saveBtn], {top: true});
        if (typeof enhanceSelect === 'function') {
            enhanceSelect(goalCtl.control);
            enhanceSelect(roundsCtl.control);
        }
    }

    return {bindSidebar, renderGroupList, openCreateDialog, setActiveGroup, openGroupSettingsDialog};
}
