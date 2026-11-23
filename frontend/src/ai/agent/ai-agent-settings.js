// ai-agent-settings.js：智能体（群聊成员）管理页——原 设置 → AI → 智能体 pane，
// 已迁为应用页面标签页（core/app-pages.js 的 agents）。DOM 常驻 index.html 尾部
// #agents-park 停靠区，mountAgentsPane 搬进 / 搬出标签页容器保持节点身份（本模块
// 创建期按 id 捕获 listEl / createBtn，不能重建 DOM）。
// 编辑器用居中动态弹窗（openAIDialog 三件套，仿生成条目编辑器），表单控件一律走
// core/form-controls.js 工厂（表单控件硬规范）。数据层在 ai-agent-model.js；
// agents[] 存 ai-config.json（panel 归一化后即真源，本模块就地改 + saveAIConfig）。

import {createInput, createSelect, createSwitch, createTextarea} from '../../core/form-controls.js';
import {iconSvg} from '../../core/icons.js';
import {overlayStack} from '../../core/overlay-stack.js';
import {aiNowId} from '../core/ai-constants.js';
import {modelRefLabel} from '../core/ai-config-model.js';
import {REPLY_STYLES} from '../core/ai-persona.js';
import {
    AGENT_COLOR_HEX, AGENT_COLORS, AGENT_DEFAULT_GROUP, agentsRemove, agentsUpsert, agentCapability,
    agentGroups, agentsByGroup, filterGroupSuggestions, groupNameError,
} from './ai-agent-model.js';

export function createAIAgentSettings(ctx) {
    // 分组折叠记忆（本窗口会话内）：Set 只存组名，渲染时跳过成员行
    const collapsedGroups = new Set();
    // 分组建议弹层（接入弹层栈的 popover）：同一时刻最多一个，句柄收口一切关闭路径
    let groupSuggestEl = null;
    let groupSuggestHandle = null;

    function closeGroupSuggest() {
        const handle = groupSuggestHandle;
        groupSuggestHandle = null;
        if (handle) handle.dispose(); // onClose 回调会再进这里，句柄已置空防重入
        if (groupSuggestEl && groupSuggestEl.parentElement) groupSuggestEl.remove();
    }

    function openGroupSuggest() {
        const query = String((editorControls && editorControls.group && editorControls.group.control.value) || '').trim();
        const names = filterGroupSuggestions(agentGroups(agents()), query);
        if (!names.length) { closeGroupSuggest(); return; }
        if (!groupSuggestEl) groupSuggestEl = node('div', 'agent-group-suggest');
        groupSuggestEl.textContent = '';
        for (const name of names) {
            const item = node('button', 'agent-group-suggest-item' + (name === query ? ' current' : ''));
            item.type = 'button';
            item.textContent = name === AGENT_DEFAULT_GROUP ? name + '（默认）' : name;
            // mousedown + preventDefault：先于 blur 采纳，输入框不丢焦点
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                if (editorControls && editorControls.group) editorControls.group.control.value = name;
                closeGroupSuggest();
            });
            groupSuggestEl.appendChild(item);
        }
        if (!groupSuggestEl.parentElement) document.body.appendChild(groupSuggestEl);
        // 定位：贴分组输入框下沿，越下沿翻转、钳在视口内（body 定位，栈配 z-index）
        const control = editorControls && editorControls.group ? editorControls.group.control : null;
        if (control) {
            groupSuggestEl.style.visibility = 'hidden';
            const rect = control.getBoundingClientRect();
            const width = Math.max(rect.width, 160);
            const height = groupSuggestEl.offsetHeight;
            let top = rect.bottom + 4;
            if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 4);
            groupSuggestEl.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + 'px';
            groupSuggestEl.style.top = top + 'px';
            groupSuggestEl.style.width = width + 'px';
            groupSuggestEl.style.visibility = '';
        }
        if (!groupSuggestHandle) {
            const groupAnchor = editorControls && editorControls.group && editorControls.group.element;
            groupSuggestHandle = overlayStack.open({
                id: 'agent-group-suggest', kind: 'popover', el: groupSuggestEl,
                closeOnOutsideClick: true, anchors: groupAnchor ? [groupAnchor] : [],
                onClose: () => { closeGroupSuggest(); return true; },
            });
        }
    }
    const getConfig = ctx.getConfig;
    const saveAIConfig = ctx.saveAIConfig;
    const askConfirm = ctx.askConfirm;
    const openAIDialog = ctx.openAIDialog;
    const closeAIDialog = ctx.closeAIDialog;
    const dialogButton = ctx.dialogButton;
    const enhanceSelect = ctx.enhanceSelect;
    // 保存 / 删除反馈走全局 flash（原写设置窗状态条，迁为标签页后设置窗多半没开）
    const flash = typeof ctx.flash === 'function' ? ctx.flash : () => {};
    const listEl = document.getElementById('agents-list');
    const createBtn = document.getElementById('ai-agent-create');

    // 编辑器状态：editingId = null 表示新建；无临时插入 config 的中间态（保存才落）。
    let editorState = null; // {editingId} | null
    let editorControls = null;

    function agents() {
        return getConfig().agents || [];
    }

    function node(tag, className, text) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text != null) el.textContent = text;
        return el;
    }

    function bindAgentsPane() {
        if (!createBtn || createBtn.dataset.agentsBound === '1') return;
        createBtn.dataset.agentsBound = '1';
        createBtn.addEventListener('click', () => openAgentEditor(null));
    }

    // 模型下拉：全部账号的全部条目；失效 ref（账号/模型被删）保留原值显示「模型不可用」。
    function modelOptions(selectedRef) {
        const options = [{value: '', label: '未选择模型'}];
        let found = false;
        for (const profile of getConfig().profiles || []) {
            for (const entry of profile.models || []) {
                const ref = profile.id + '|' + entry.id;
                const selected = ref === selectedRef;
                if (selected) found = true;
                options.push({value: ref, label: modelRefLabel(profile, entry), selected});
            }
        }
        if (selectedRef && !found) {
            options.push({value: selectedRef, label: '模型不可用（' + selectedRef + '）', selected: true});
        }
        return options;
    }

    // ---------- 列表 ----------

    function renderAgentsPane() {
        if (!listEl) return;
        listEl.innerHTML = '';
        const list = agents();
        if (!list.length) {
            const card = node('div', 'set-card');
            const row = node('div', 'set-row');
            const main = node('div', 'set-main');
            main.appendChild(node('div', 'set-title', '还没有智能体'));
            main.appendChild(node('div', 'set-desc', '智能体是群聊（圆桌讨论）的成员：绑定一个账号下的模型，配人设与职责。点上方「新建智能体」创建第一个。'));
            row.appendChild(main);
            card.appendChild(row);
            listEl.appendChild(card);
            return;
        }
        // 按组分区：只有「默认」一组时不加组头（避免唯一标签的噪音）；组头可折叠（记忆到本窗口会话）
        const parts = agentsByGroup(list);
        const showHeaders = parts.length > 1;
        for (const part of parts) {
            const collapsed = collapsedGroups.has(part.group);
            if (showHeaders) listEl.appendChild(groupHead(part.group, part.agents.length, collapsed));
            if (collapsed) continue;
            for (const agent of part.agents) {
                listEl.appendChild(agentRow(agent));
            }
        }
    }

    function groupHead(group, count, collapsed) {
        const head = node('div', 'agent-group-head' + (collapsed ? ' collapsed' : ''));
        head.dataset.tip = collapsed ? '展开「' + group + '」组的成员' : '折叠「' + group + '」组的成员';
        const chevron = node('span', 'agent-group-chevron');
        chevron.innerHTML = iconSvg('chevron-down', 11);
        head.appendChild(chevron);
        head.appendChild(node('span', 'agent-group-name', group));
        head.appendChild(node('span', 'agent-group-count', String(count)));
        head.addEventListener('click', () => {
            if (collapsedGroups.has(group)) collapsedGroups.delete(group);
            else collapsedGroups.add(group);
            renderAgentsPane();
        });
        return head;
    }

    function agentRow(agent) {
        const card = node('div', 'set-card');
        const row = node('div', 'set-row');
        const main = node('div', 'set-main');
        const title = node('div', 'set-title');
        const dot = node('span', 'agent-color-dot');
        dot.style.backgroundColor = AGENT_COLOR_HEX[agent.color] || '#888';
        title.appendChild(dot);
        title.appendChild(document.createTextNode(agent.name));
        const cap = agentCapability(agent, getConfig().profiles);
        if (agent.chair) title.appendChild(badge('gc-badge-chair', '主持人'));
        if (!agent.enabled) title.appendChild(badge('agent-badge-off', '停用'));
        else if (!cap.available) title.appendChild(badge('agent-badge-off', '模型不可用'));
        else title.appendChild(badge('agent-badge-model', cap.label));
        main.appendChild(title);
        const desc = agent.role
            ? agent.role
            : '无职责描述';
        main.appendChild(node('div', 'set-desc', desc));

        const control = node('div', 'set-control');
        const editBtn = node('button', 'dlg-btn', '编辑');
        editBtn.type = 'button';
        editBtn.addEventListener('click', () => openAgentEditor(agent));
        const delBtn = node('button', 'dlg-btn', '删除');
        delBtn.type = 'button';
        delBtn.addEventListener('click', () => {
            askConfirm('删除智能体「' + agent.name + '」？引用它的群聊将显示「已删除成员」，群聊数据不受影响。', () => {
                agentsRemove(agents(), agent.id);
                saveAIConfig();
                renderAgentsPane();
                flash('已删除智能体：' + agent.name);
            }, '删除', '删除智能体');
        });
        control.append(editBtn, delBtn);
        row.append(main, control);
        card.appendChild(row);
        return card;
    }

    function badge(className, text) {
        const span = node('span', 'agent-badge ' + className, text);
        return span;
    }

    // ---------- 编辑器弹窗 ----------

    function openAgentEditor(agent) {
        const editing = !!(agent && agent.id);
        editorState = {editingId: editing ? agent.id : null};

        const wrap = node('div');
        const rowName = node('div', 'agent-form-row');
        rowName.appendChild(fieldLabel('名字'));
        const nameCtl = createInput({
            value: agent ? agent.name : '',
            placeholder: '1–32 字符，无空白与 @，全局唯一',
            spellcheck: false,
            autocomplete: 'off',
        });
        rowName.appendChild(nameCtl.element);
        wrap.appendChild(rowName);

        const rowModel = node('div', 'agent-form-row');
        rowModel.appendChild(fieldLabel('模型'));
        const modelCtl = createSelect({options: modelOptions(agent ? agent.modelRef : '')});
        rowModel.appendChild(modelCtl.element);
        wrap.appendChild(rowModel);

        // 分组：必有值字段（空 → 默认）。单个输入框 + 建议弹层：focus/输入列出（过滤后的）
        // 现有分组点选填入；输入列表里没有的新名字 = 新建分组（保存时 groupNameError 校验）。
        // 建议是接入弹层栈的正规 popover（body 定位 + 栈配 z-index，Esc 由栈按层序关闭）。
        const rowGroup = node('div', 'agent-form-row');
        rowGroup.appendChild(fieldLabel('分组'));
        const groupCtl = createInput({
            value: agent ? agent.group : AGENT_DEFAULT_GROUP,
            placeholder: '点选现有分组，或输入新名字即新建（≤16 字符）',
            spellcheck: false,
            autocomplete: 'off',
        });
        rowGroup.appendChild(groupCtl.element);
        wrap.appendChild(rowGroup);
        groupCtl.control.addEventListener('focus', () => openGroupSuggest());
        groupCtl.control.addEventListener('input', () => openGroupSuggest());
        groupCtl.control.addEventListener('blur', () => {
            // 延迟让 mousedown 采纳先落地（采纳时 preventDefault 不丢焦点）
            setTimeout(() => closeGroupSuggest(), 150);
        });
        groupCtl.control.addEventListener('keydown', (e) => {
            // Esc 归弹层栈（建议 popover 在栈顶，先于所在对话框关闭）
            if (e.key === 'Enter') {
                e.preventDefault();
                const names = filterGroupSuggestions(agentGroups(agents()), String(groupCtl.control.value || '').trim());
                if (names.length) {
                    groupCtl.control.value = names[0];
                    closeGroupSuggest();
                }
            }
        });

        const rowRole = node('div', 'agent-form-row');
        rowRole.appendChild(fieldLabel('职责'));
        const roleCtl = createInput({
            value: agent ? agent.role : '',
            placeholder: '一句话职责，进入成员名单与主持人参考',
        });
        rowRole.appendChild(roleCtl.element);
        wrap.appendChild(rowRole);

        const rowPersona = node('div', 'agent-form-row agent-form-row-top');
        rowPersona.appendChild(fieldLabel('人设'));
        const personaCtl = createTextarea({rows: 6, value: agent ? agent.personaText : '', placeholder: '人设正文（可选，≤4096 字符）：只影响表达，不改变事实判断与安全规则'});
        rowPersona.appendChild(personaCtl.element);
        wrap.appendChild(rowPersona);

        const rowStyle = node('div', 'agent-form-row');
        rowStyle.appendChild(fieldLabel('回复风格'));
        const styleCtl = createSelect({
            options: REPLY_STYLES.map((style) => ({
                value: style.id,
                label: style.name,
                selected: agent ? agent.replyStyle === style.id : style.id === 'default',
            })),
        });
        rowStyle.appendChild(styleCtl.element);
        wrap.appendChild(rowStyle);

        const rowTemp = node('div', 'agent-form-row');
        rowTemp.appendChild(fieldLabel('温度'));
        const tempCtl = createInput({
            type: 'number',
            step: '0.1',
            min: '-2',
            max: '2',
            value: agent && agent.temperature != null ? String(agent.temperature) : '',
            placeholder: '留空跟随账号',
        });
        rowTemp.appendChild(tempCtl.element);
        wrap.appendChild(rowTemp);

        const rowColor = node('div', 'agent-form-row');
        rowColor.appendChild(fieldLabel('颜色'));
        const colorCtl = createSelect({
            options: AGENT_COLORS.map((color) => ({
                value: color,
                label: color,
                selected: agent ? agent.color === color : false,
            })),
        });
        rowColor.appendChild(colorCtl.element);
        wrap.appendChild(rowColor);

        const rowSwitches = node('div', 'agent-form-row agent-form-row-top');
        const switchCol = node('div', 'agent-form-switches');
        const chairCtl = createSwitch({checked: agent ? agent.chair : false});
        switchCol.appendChild(switchWrap(chairCtl.element, '可作为主持人', '只做调度与纪要，不参与辩论（§3.1）；群创建时从这里选'));
        const slowCtl = createSwitch({checked: agent ? agent.slowTier : false});
        switchCol.appendChild(switchWrap(slowCtl.element, '按思考/慢速档超时', '兼容端点不暴露 reasoning 能力时手动标注；超时档与预检徽标同步'));
        const enabledCtl = createSwitch({checked: agent ? agent.enabled : true});
        switchCol.appendChild(switchWrap(enabledCtl.element, '启用', '停用后不可加入新讨论，已有群内显示停用状态'));
        rowSwitches.appendChild(switchCol);
        wrap.appendChild(rowSwitches);

        const statusLine = node('div', 'set-desc');
        statusLine.style.minHeight = '14px';

        const cancelBtn = dialogButton('取消', 'dlg-btn', () => {
            closeGroupSuggest();
            editorControls = null;
            closeAIDialog();
        });
        const saveBtn = dialogButton('保存', 'dlg-btn primary', () => {
            saveAgentEditor(collectDraft(), statusLine);
        });

        editorControls = {name: nameCtl, model: modelCtl, group: groupCtl, role: roleCtl, persona: personaCtl,
            style: styleCtl, temperature: tempCtl, color: colorCtl,
            chair: chairCtl, slow: slowCtl, enabled: enabledCtl};

        openAIDialog((editing ? '编辑智能体' : '新建智能体') + (editing && agent.name ? ' · ' + agent.name : ''),
            [wrap], [statusLine, cancelBtn, saveBtn], {top: true, wide: true});
        // 与生成条目编辑器同款：下拉在入 DOM 后再增强，否则露原生外观（分组已换输入框，不在此列）
        if (typeof enhanceSelect === 'function') {
            for (const ctl of [modelCtl, styleCtl, colorCtl]) enhanceSelect(ctl.control);
        }
    }

    function fieldLabel(text) {
        const label = node('span', 'agent-form-label', text);
        return label;
    }

    function switchWrap(element, title, desc) {
        const wrap = node('div', 'agent-switch-item');
        wrap.appendChild(element);
        const textCol = node('div', 'agent-switch-text');
        textCol.appendChild(node('div', 'set-title', title));
        textCol.appendChild(node('div', 'set-desc', desc));
        wrap.appendChild(textCol);
        return wrap;
    }

    function collectDraft() {
        const controls = editorControls || {};
        const temperatureRaw = String((controls.temperature && controls.temperature.control.value) || '').trim();
        // 分组输入框：空 → 默认（normalizeAgent 会兜底）；新名字 = 新建分组
        const group = String((controls.group && controls.group.control.value) || '').trim() || AGENT_DEFAULT_GROUP;
        return {
            id: editorState && editorState.editingId ? editorState.editingId : '',
            name: String((controls.name && controls.name.control.value) || ''),
            modelRef: String((controls.model && controls.model.control.value) || ''),
            group,
            role: String((controls.role && controls.role.control.value) || ''),
            personaText: String((controls.persona && controls.persona.control.value) || ''),
            replyStyle: String((controls.style && controls.style.control.value) || 'default'),
            temperature: temperatureRaw === '' ? null : Number(temperatureRaw),
            color: String((controls.color && controls.color.control.value) || ''),
            chair: !!(controls.chair && controls.chair.control.checked),
            slowTier: !!(controls.slow && controls.slow.control.checked),
            enabled: !controls.enabled || controls.enabled.control.checked,
        };
    }

    function saveAgentEditor(draft, statusLine) {
        // 输入的新组名（不在现有分组里）在保存前显式校验（归一化只静默限长，这里要给出可读错误）
        if (draft.group && !agentGroups(agents()).includes(draft.group)) {
            const groupError = groupNameError(draft.group, agents(), editorState ? editorState.editingId : '');
            if (groupError) {
                statusLine.textContent = groupError;
                if (editorControls && editorControls.group) editorControls.group.control.focus();
                return;
            }
        }
        const result = agentsUpsert(agents(), draft, () => aiNowId('agent-'));
        if (!result.ok) {
            statusLine.textContent = result.error || '保存失败';
            return;
        }
        closeGroupSuggest();
        saveAIConfig();
        editorControls = null;
        closeAIDialog();
        renderAgentsPane();
        flash('已保存智能体：' + result.agent.name);
    }

    // ---------- 应用页面标签页（停靠区搬运，保持节点身份） ----------

    function mountAgentsPane(root) {
        const pane = listEl ? listEl.closest('[data-pane="agents"]') : null;
        if (!pane || !root) return null;
        // 只搬不重建：本模块创建期按 id 捕获的引用与绑定跨开关标签页始终有效（外部工具先例）
        root.appendChild(pane);
        pane.classList.remove('hidden'); // 离开设置窗的 hidden 切换体系，挂载即显示
        bindAgentsPane();
        renderAgentsPane();
        return () => {
            const park = document.getElementById('agents-park');
            if (park && pane.isConnected) park.appendChild(pane);
            pane.classList.add('hidden');
            // 编辑中途关标签页：建议弹层收口（编辑器弹窗自身有栈，不在此管）
            closeGroupSuggest();
        };
    }

    return {bindAgentsPane, renderAgentsPane, mountAgentsPane};
}
