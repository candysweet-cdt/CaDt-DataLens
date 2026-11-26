// ai-manage-dialogs.js：提示词 / 记忆 / 技能三个管理对话框与 createAppSkill。
// 从 ai-panel.js 拆出（docs/unfinished-plans/structure-cleanup.md 阶段 3），函数体逐字搬移。
// config 为重赋值 let（经 getConfig() 读）；memoryFallbackNotified 经访问器写；
// 对话框基建（openAIDialog/closeAIDialog/dialogNode/dialogButton）也归本模块（方案 M4 搬入）；浮动窗折叠状态经 ctx 访问器读写。
import {aiClamp, aiCtxBannerShow, aiCtxBannerState, aiEstimateTokens, aiEstimateImageTokens, aiEstimateVideoTokens, aiImageStats, aiTextOf} from '../core/ai-constants.js';
import {createInput, createSelect, createSwitch, createTextarea} from '../../core/form-controls.js';
import {overlayStack} from '../../core/overlay-stack.js';

export function createAIManageDialogs(ctx) {
    const el = ctx.el;
    const flash = ctx.flash;
    const askConfirm = ctx.askConfirm;
    const backend = ctx.backend;
    const openPath = ctx.openPath;
    const openSettings = ctx.openSettings;
    const showNote = ctx.showNote;
    const currentSession = ctx.currentSession;
    const persistSessions = ctx.persistSessions;
    const saveAIConfig = ctx.saveAIConfig;
    const positionOverlays = ctx.positionOverlays;
    const updateContextCount = ctx.updateContextCount;
    const buildApiMessages = ctx.buildApiMessages;
    const assembleSystemContext = ctx.assembleSystemContext;
    const effectiveSystemPrompt = ctx.effectiveSystemPrompt;
    const contextWindowOf = ctx.contextWindowOf;
    const toolsTokenEstimate = ctx.toolsTokenEstimate;
    const promptById = ctx.promptById;
    const promptTextOf = ctx.promptTextOf;
    const injectionStatusText = ctx.injectionStatusText;
    const resolveMemoryDir = ctx.resolveMemoryDir;
    const getAIAppDir = ctx.getAIAppDir;
    const skillSourceLabel = ctx.skillSourceLabel;
    const listSkillsRaw = ctx.listSkillsRaw;
    const invalidateSkillsCache = ctx.invalidateSkillsCache;
    const aiNormalizePath = ctx.aiNormalizePath;
    const aiJoinPath = ctx.aiJoinPath;
    const aiPathDir = ctx.aiPathDir;
    const MEMORY_NAME_RULE = ctx.MEMORY_NAME_RULE;
    const getConfig = ctx.getConfig;
    const setMemoryFallbackNotified = ctx.setMemoryFallbackNotified;
    const getAttachments = ctx.getAttachments;
    // 实测 usage 锚点由面板的 buildApiMessages 侧信道提供（拿不到就退回纯估算）
    const getBuildAnchor = ctx.getBuildAnchor;
    // 发送门禁回写宿主（ai-panel 的 updateSendState / submitText 读同一份状态）
    const setCtxGate = ctx.setCtxGate;

    // ---------- 对话框基建（方案 M4 从 ai-panel.js 搬入） ----------
    // 从设置窗打开记忆 / 技能管理时，把对话框临时挂到 body 顶层（盖在设置窗之上），
    // 不再为了显示对话框而关闭设置窗；关闭后放回 AI 面板原位。
    const getFloatCollapsed = ctx.getFloatCollapsed;
    const setFloatCollapsed = ctx.setFloatCollapsed;
    let dialogOnTop = false;
    let dialogHome = null;
    // AI 弹窗的弹层栈条目（openAIDialog/closeAIDialog 所有路径都要收口）
    let dialogStackHandle = null;

    function attachDialogTop() {
        if (!el.dialog || dialogOnTop) return;
        if (!dialogHome) dialogHome = el.dialog.parentElement;
        dialogOnTop = true;
        el.dialog.classList.add('ai-dialog-top');
        document.body.appendChild(el.dialog);
    }

    function detachDialogTop() {
        if (!el.dialog || !dialogOnTop) return;
        dialogOnTop = false;
        el.dialog.classList.remove('ai-dialog-top');
        if (dialogHome) dialogHome.appendChild(el.dialog);
    }

    function openAIDialog(title, bodyNodes, footerNodes, options) {
        if (!el.dialog) return;
        if (getFloatCollapsed && getFloatCollapsed()) setFloatCollapsed(false);
        if (options && options.top) attachDialogTop();
        else if (dialogOnTop) detachDialogTop();
        el.dialog.classList.remove('ai-permission-dialog');
        // 宽弹窗：内容密集的编辑器（生成条目等）在 560px 里太挤，调用方传 options.wide 加宽
        if (el.dialogCard) el.dialogCard.classList.toggle('ai-dialog-card-wide', !!(options && options.wide));
        if (el.dialogTitle) el.dialogTitle.textContent = title || '';
        if (el.dialogBody) {
            el.dialogBody.innerHTML = '';
            for (const node of bodyNodes || []) if (node) el.dialogBody.appendChild(node);
        }
        if (el.dialogFoot) {
            el.dialogFoot.innerHTML = '';
            for (const node of footerNodes || []) if (node) el.dialogFoot.appendChild(node);
        }
        el.dialog.classList.remove('hidden');
        // 进全局弹层栈：从设置窗以 top 方式打开时本层在栈顶，Esc 先退本层再退设置窗
        if (dialogStackHandle) dialogStackHandle.dispose();
        dialogStackHandle = overlayStack.open({
            id: 'ai-dialog', kind: 'modal', el: el.dialog,
            onClose: () => { closeAIDialog(); return true; },
        });
    }

    function closeAIDialog() {
        if (!el.dialog) return;
        if (dialogStackHandle) {
            dialogStackHandle.dispose();
            dialogStackHandle = null;
        }
        el.dialog.classList.remove('ai-permission-dialog');
        el.dialog.classList.add('hidden');
        if (el.dialogCard) el.dialogCard.classList.remove('ai-dialog-card-wide');
        if (el.dialogBody) el.dialogBody.innerHTML = '';
        if (el.dialogFoot) el.dialogFoot.innerHTML = '';
        detachDialogTop();
    }

    function dialogNode(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function dialogButton(label, className, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className || 'dlg-btn';
        button.textContent = label;
        button.addEventListener('click', onClick);
        return button;
    }

    async function showPromptDialog() {
        const session = currentSession();
        if (!session) return;
        const status = dialogNode('div', 'ai-dialog-hint', '注入状态：统计中…');
        const {control: select} = createSelect();
        const currentOption = document.createElement('option');
        currentOption.value = '';
        currentOption.textContent = '（当前生效值）';
        select.appendChild(currentOption);
        for (const prompt of getConfig().prompts) {
            const option = document.createElement('option');
            option.value = prompt.id;
            option.textContent = prompt.name + (prompt.id === getConfig().activePromptId ? '（默认）' : '');
            select.appendChild(option);
        }
        select.value = promptById(session.promptTemplateId) ? session.promptTemplateId : '';
        const {control: textarea} = createTextarea({
            spellcheck: false,
            value: effectiveSystemPrompt(session),
        });
        select.addEventListener('change', () => {
            const prompt = promptById(select.value);
            textarea.value = prompt ? prompt.content : effectiveSystemPrompt(session);
        });
        const selectRow = dialogNode('div', 'ai-dialog-field');
        selectRow.append(dialogNode('span', '', '模板'), select);
        const textRow = dialogNode('div', 'ai-dialog-field');
        textRow.append(dialogNode('span', '', '系统提示词'), textarea);
        const footer = [
            dialogButton('清除会话覆盖', 'dlg-btn', () => {
                session.systemPrompt = '';
                session.promptTemplateId = '';
                persistSessions();
                closeAIDialog();
                showNote('已清除本会话的提示词覆盖，恢复默认模板。');
            }),
            dialogButton('取消', 'dlg-btn', closeAIDialog),
            dialogButton('保存到本会话', 'dlg-btn primary', () => {
                const value = String(textarea.value || '').trim();
                const prompt = promptById(select.value);
                if (!value) {
                    session.systemPrompt = '';
                    session.promptTemplateId = '';
                } else if (prompt && value === prompt.content.trim()) {
                    session.systemPrompt = '';
                    session.promptTemplateId = prompt.id;
                } else {
                    session.systemPrompt = value;
                    session.promptTemplateId = '';
                }
                persistSessions();
                closeAIDialog();
                showNote('已保存本会话提示词（下一轮生效）。');
                updateContextCount();
            }),
        ];
        openAIDialog('会话提示词', [selectRow, textRow, status], footer);
        try {
            const bundle = await assembleSystemContext(session, getAttachments());
            status.textContent = injectionStatusText(bundle.meta);
        } catch (e) {
            status.textContent = '注入状态统计失败：' + ((e && e.message) || e);
        }
    }

    function showArchivedDialog() {
        const session = currentSession();
        if (!session) return;
        // 归档 = 内存（vacuum 后新增的压缩）+ 侧车（vacuum 移入的历史，按页读回）。
        const archived = Array.isArray(session.archived) ? session.archived : [];
        const sidecarTotal = typeof ctx.archivedTotalOf === 'function'
            ? Math.max(0, Number(ctx.archivedTotalOf(session)) || 0) - archived.length
            : 0;
        const body = dialogNode('div', 'ai-mgr-list');
        if (session.summary && session.summary.text) {
            body.appendChild(dialogNode('div', 'ai-dialog-hint', '当前摘要：\n' + session.summary.text));
        }
        if (!archived.length && !sidecarTotal) {
            body.appendChild(dialogNode('div', 'ai-mgr-empty', '没有已归档消息。执行 /compact 后，压缩前的消息会保存在这里（不随请求发送）。'));
        } else {
            if (sidecarTotal) {
                body.appendChild(dialogNode('div', 'ai-mgr-empty', '侧车历史 ' + sidecarTotal + ' 条（已整理入 archive.v1.jsonl）。'));
            }
            const renderRow = (message) => {
                if (!message || !message.role) return;
                const row = dialogNode('div', 'ai-mgr-row');
                const main = dialogNode('div', 'ai-mgr-main');
                const label = message.kind === 'changes-summary'
                    ? '文件改动汇总'
                    : (message.role === 'user'
                        ? (message.app && message.app.label ? '应用 · ' + message.app.label : '用户')
                        : (message.role === 'tool' ? ('工具：' + (message.name || '')) : 'AI'));
                const text = message.kind === 'changes-summary'
                    ? '已编辑 ' + ((message.changes && message.changes.files || []).length) + ' 个文件（详见对话流汇总卡）'
                    : String(message.content || '（无内容）').slice(0, 200);
                main.appendChild(dialogNode('div', 'ai-mgr-name', label));
                main.appendChild(dialogNode('div', 'ai-mgr-meta', text));
                row.appendChild(main);
                body.appendChild(row);
            };
            archived.forEach(renderRow);
            // 侧车按页读回（100 条/页），「更多」按钮就地追加。
            let sidecarLoaded = 0;
            const moreBtn = sidecarTotal
                ? dialogButton('读取侧车历史（剩 ' + sidecarTotal + ' 条）', 'dlg-btn', async () => {
                    if (typeof ctx.loadArchivedSidecarPage !== 'function') return;
                    moreBtn.disabled = true;
                    try {
                        const state = await ctx.loadArchivedSidecarPage(session);
                        const messages = (state && state.messages) || [];
                        for (const message of messages.slice(sidecarLoaded)) renderRow(message);
                        sidecarLoaded = messages.length;
                        const remaining = Math.max(0, ((state && state.total) || sidecarTotal) - sidecarLoaded);
                        if (remaining > 0) {
                            moreBtn.disabled = false;
                            moreBtn.textContent = '读取侧车历史（剩 ' + remaining + ' 条）';
                        } else {
                            moreBtn.parentElement && moreBtn.remove();
                        }
                    } catch (e) {
                        moreBtn.disabled = false;
                        flash('侧车读取失败：' + String((e && e.message) || e), true);
                    }
                })
                : null;
            if (moreBtn) body.appendChild(moreBtn);
        }
        openAIDialog('已归档消息（不发送）', [body], [dialogButton('关闭', 'dlg-btn primary', closeAIDialog)]);
    }

    async function showMemoryDialog(options) {
        const top = !!(options && options.top);
        let mem;
        try {
            mem = await resolveMemoryDir();
            // workspace 模式下没有会话根（harness 未绑定会话 / 会话沙盒未就绪）时 dir 为空：
            // 再往下 AIEnsureDir('') 会落到盘符根、aiJoinPath('', name) 会拼出 /MEMORY.md
            // （独立审查 🟡）。这里直接按「不可用」收口，不进入后续流程。
            if (!mem || !mem.dir) {
                showNote('当前会话未绑定工作区，记忆不可用：请先绑定工作区，或把记忆模式改为「应用数据」', true);
                return;
            }
            if (backend.AIEnsureDir) await backend.AIEnsureDir(mem.dir);
        } catch (e) {
            showNote('读取记忆目录失败：' + ((e && e.message) || e), true);
            return;
        }
        const pathBox = dialogNode('div', 'ai-mgr-path', '模式：' + mem.mode + '\n目录：' + mem.dir);
        pathBox.style.whiteSpace = 'pre-wrap';
        const list = dialogNode('div', 'ai-mgr-list');
        const newRow = dialogNode('div', 'ai-dialog-field');
        const {control: nameInput} = createInput({
            className: 'dlg-input ai-settings-input',
            placeholder: '新文件名，如 user-preferences.md',
            spellcheck: false,
        });
        newRow.append(dialogNode('span', '', '新建文件'), nameInput,
            dialogButton('创建', 'dlg-btn', async () => {
                const name = String(nameInput.value || '').trim();
                if (!MEMORY_NAME_RULE.test(name) || name.includes('..')) {
                    flash('记忆文件名无效（安全字符，且以 .md 结尾）', true);
                    return;
                }
                try {
                    await backend.SaveFile(aiJoinPath(mem.dir, name), '', 'lf', false, 'utf-8');
                    nameInput.value = '';
                    await reload();
                } catch (e) {
                    flash('创建失败：' + ((e && e.message) || e), true);
                }
            }));

        async function reload() {
            list.innerHTML = '';
            let entries = [];
            try {
                const listing = await backend.ReadDir(mem.dir, 200);
                entries = ((listing && listing.entries) || []).filter((entry) => !entry.isDir);
            } catch (e) {
                entries = [];
            }
            if (!entries.length) {
                list.appendChild(dialogNode('div', 'ai-mgr-empty', '记忆目录为空。AI 在任意权限下都可通过 memory_write 写入。'));
                return;
            }
            entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
            for (const entry of entries) {
                const row = dialogNode('div', 'ai-mgr-row');
                const main = dialogNode('div', 'ai-mgr-main');
                main.appendChild(dialogNode('div', 'ai-mgr-name', entry.name));
                let size = Number(entry.size);
                if (!Number.isFinite(size)) {
                    try {
                        const info = await backend.OpenFile(entry.path, 'auto');
                        size = Number(info && info.size);
                    } catch (e) {
                        size = NaN;
                    }
                }
                const meta = [];
                if (Number.isFinite(size)) meta.push(size + ' 字节');
                main.appendChild(dialogNode('div', 'ai-mgr-meta', meta.join(' · ')));
                const actions = dialogNode('div', 'ai-mgr-actions');
                actions.appendChild(dialogButton('打开', 'dlg-btn', () => openPath(entry.path)));
                actions.appendChild(dialogButton('删除', 'dlg-btn', () => {
                    askConfirm('删除记忆文件「' + entry.name + '」？（移入回收站）', async () => {
                        try {
                            if (!backend.DeleteEntry) throw new Error('当前版本不支持删除');
                            await backend.DeleteEntry(entry.path);
                            await reload();
                        } catch (e) {
                            flash('删除失败：' + ((e && e.message) || e), true);
                        }
                    }, '删除', '删除记忆文件');
                }));
                row.append(main, actions);
                list.appendChild(row);
            }
        }

        const modeButton = dialogButton(getConfig().memoryMode === 'app' ? '切换到工作区模式' : '切换到应用数据模式', 'dlg-btn', () => {
            getConfig().memoryMode = getConfig().memoryMode === 'app' ? 'workspace' : 'app';
            setMemoryFallbackNotified(false);
            saveAIConfig();
            closeAIDialog();
            showMemoryDialog({top});
        });
        const footer = [
            dialogButton('在设置中打开', 'dlg-btn', () => { closeAIDialog(); openSettings('ai'); }),
            modeButton,
            dialogButton('刷新', 'dlg-btn', reload),
            dialogButton('关闭', 'dlg-btn primary', closeAIDialog),
        ];
        openAIDialog('记忆管理', [pathBox, list, newRow], footer, {top});
        await reload();
    }


    async function createAppSkill(name, description) {
        const app = aiNormalizePath(await getAIAppDir());
        if (!app) throw new Error('无法定位应用数据目录');
        const dirName = String(name || '').replace(/[\\/:*?"<>|]/g, '-').trim();
        if (!dirName) throw new Error('技能名称不能为空');
        const skillDir = aiJoinPath(aiJoinPath(app, 'ai-skills'), dirName);
        const file = aiJoinPath(skillDir, 'SKILL.md');
        if (backend.AIEnsureDir) await backend.AIEnsureDir(skillDir);
        const content = [
            '---',
            'name: ' + JSON.stringify(String(name)),
            'description: ' + JSON.stringify(String(description || '（待补充）')),
            '---',
            '',
            '# ' + name,
            '',
            '（在此编写技能指令：说明何时使用、步骤、注意事项。）',
        ].join('\n');
        await backend.SaveFile(file, content, 'lf', false, 'utf-8');
        invalidateSkillsCache();
        return file;
    }

    // 分组折叠状态在 AI 面板生命周期内保留：刷新 / 重开对话框不重置，内置组默认收起。
    const skillGroupCollapsed = {custom: false, builtin: true};

    async function showSkillsDialog(options) {
        const top = !!(options && options.top);
        const list = dialogNode('div', 'ai-mgr-list ai-skills-list');
        const status = dialogNode('div', 'ai-dialog-hint', '技能来源（优先级从高到低）：工作区 .cadt/skills > 工作区 .agents/skills > 应用数据 ai-skills > 用户 ~/.agents/skills > 内置（随应用分发，版本更新后自动刷新）；同名时低 rank 覆盖高 rank。列表按「用户 / 自定义技能」与「内置技能」分组，点组名可折叠；组内滚动。');
        const newRow = dialogNode('div', 'ai-dialog-field');
        const {control: nameInput} = createInput({
            className: 'dlg-input ai-settings-input',
            placeholder: '技能名称',
            spellcheck: false,
        });
        const {control: descInput} = createInput({
            className: 'dlg-input ai-settings-input',
            placeholder: '描述（一句话）',
            spellcheck: false,
        });
        newRow.append(dialogNode('span', '', '新建技能'), nameInput, descInput,
            dialogButton('创建', 'dlg-btn', async () => {
                const name = String(nameInput.value || '').trim();
                if (!name) {
                    flash('技能名称不能为空', true);
                    return;
                }
                try {
                    const file = await createAppSkill(name, String(descInput.value || '').trim());
                    nameInput.value = '';
                    descInput.value = '';
                    flash('已创建技能：' + file);
                    await reload();
                } catch (e) {
                    flash('创建技能失败：' + ((e && e.message) || e), true);
                }
            }));

        function toggleSkill(skill, enabled) {
            const disabled = new Set((getConfig().disabledSkills || []).map((value) => String(value).toLowerCase()));
            if (enabled) disabled.delete(skill.name.toLowerCase());
            else disabled.add(skill.name.toLowerCase());
            getConfig().disabledSkills = [...disabled];
            saveAIConfig();
            invalidateSkillsCache();
            updateContextCount();
        }

        // 「不在 AI 索引」开关：只隐藏系统提示词里的索引行；技能仍可被输入框附加与 skill_use 加载
        function toggleHidden(skill, inIndex) {
            const hidden = new Set((getConfig().hiddenSkills || []).map((value) => String(value).toLowerCase()));
            if (inIndex) hidden.delete(skill.name.toLowerCase());
            else hidden.add(skill.name.toLowerCase());
            getConfig().hiddenSkills = [...hidden];
            saveAIConfig();
            invalidateSkillsCache();
            updateContextCount();
        }

        async function reload() {
            list.innerHTML = '';
            list.classList.remove('ai-skills-list');
            let skills = [];
            try {
                skills = await listSkillsRaw(true);
            } catch (e) {
                list.appendChild(dialogNode('div', 'ai-mgr-empty', '读取技能失败：' + ((e && e.message) || e)));
                return;
            }
            if (!skills.length) {
                list.appendChild(dialogNode('div', 'ai-mgr-empty', '还没有技能。把 SKILL.md 放进技能目录即可。'));
                return;
            }
            list.classList.add('ai-skills-list');
            function appendRow(skill, host) {
                const row = dialogNode('div', 'ai-mgr-row');
                const check = document.createElement('input');
                check.type = 'checkbox';
                check.checked = !skill.disabled;
                check.dataset.tip = '启用 / 禁用该技能';
                check.addEventListener('change', () => {
                    toggleSkill(skill, check.checked);
                    status.textContent = '已' + (check.checked ? '启用' : '禁用') + '技能：' + skill.name + '（下一轮生效）';
                });
                const hiddenWrap = document.createElement('span');
                hiddenWrap.className = 'ai-mgr-hidden-toggle';
                hiddenWrap.appendChild(document.createTextNode('索引'));
                const hiddenSwitch = createSwitch({
                    checked: !skill.hidden,
                    title: '开 = 出现在 AI 系统提示词的技能索引；关 = 只隐藏索引，仍可手动附加或用 skill_use 加载',
                });
                hiddenSwitch.control.addEventListener('change', () => {
                    toggleHidden(skill, hiddenSwitch.control.checked);
                    status.textContent = '已' + (hiddenSwitch.control.checked ? '列入' : '移出') + 'AI 索引：' + skill.name + '（下一轮生效）';
                });
                hiddenWrap.appendChild(hiddenSwitch.element);
                const main = dialogNode('div', 'ai-mgr-main');
                const isBuiltin = skill.source === 'builtin';
                const sourceLabel = skillSourceLabel(skill.source);
                const nameRow = dialogNode('div', 'ai-mgr-name');
                nameRow.appendChild(document.createTextNode(skill.name));
                nameRow.appendChild(dialogNode('span', 'ai-mgr-tag' + (isBuiltin ? ' ai-mgr-tag-builtin' : ''), sourceLabel));
                main.appendChild(nameRow);
                main.appendChild(dialogNode('div', 'ai-mgr-meta', skill.description));
                const actions = dialogNode('div', 'ai-mgr-actions');
                if (!skill.builtin) {
                    actions.appendChild(dialogButton('打开', 'dlg-btn', () => openPath(skill.path)));
                    actions.appendChild(dialogButton('目录', 'dlg-btn', () => {
                        const dir = aiPathDir(skill.path);
                        if (backend.ShowInFolder) backend.ShowInFolder(dir);
                        else openPath(dir);
                    }));
                }
                row.append(check, hiddenWrap, main, actions);
                host.appendChild(row);
            }

            function appendGroup(key, title, note, items, builtinGroup) {
                if (!items.length) return;
                const collapsed = !!skillGroupCollapsed[key];
                const head = document.createElement('button');
                head.type = 'button';
                head.className = 'ai-mgr-group' + (builtinGroup ? ' ai-mgr-group-builtin' : '');
                head.setAttribute('aria-expanded', String(!collapsed));
                                head.appendChild(dialogNode('span', 'ai-mgr-group-arrow', ''));
                head.appendChild(dialogNode('span', 'ai-mgr-group-title', title));
                head.appendChild(dialogNode('span', 'ai-mgr-group-count', items.length + ' 个'));
                if (note) head.appendChild(dialogNode('span', 'ai-mgr-group-note', note));
                const body = dialogNode('div', 'ai-mgr-group-items' + (collapsed ? ' ai-mgr-group-collapsed' : ''));
                head.addEventListener('click', () => {
                    const next = !skillGroupCollapsed[key];
                    skillGroupCollapsed[key] = next;
                    head.setAttribute('aria-expanded', String(!next));
                    body.classList.toggle('ai-mgr-group-collapsed', next);
                });
                list.appendChild(head);
                for (const skill of items) appendRow(skill, body);
                list.appendChild(body);
            }

            // 内置（随应用分发）与用户 / 自定义（工作区、应用数据、用户目录）分开列：
            // 用户自己的技能放前面且带来源徽标，内置组默认折叠；列表固定高度内部滚动、组头吸顶。
            appendGroup('custom', '用户 / 自定义技能', '工作区 · 应用 · 用户目录，可打开编辑', skills.filter((skill) => skill.source !== 'builtin'));
            appendGroup('builtin', '内置技能', '随应用分发，版本更新自动刷新', skills.filter((skill) => skill.source === 'builtin'), true);
        }

        const footer = [
            dialogButton('刷新', 'dlg-btn', async () => { await reload(); }),
            dialogButton('关闭', 'dlg-btn primary', closeAIDialog),
        ];
        openAIDialog('技能管理', [status, list, newRow], footer, {top});
        await reload();
    }

    // ---------- 上下文压缩 / 超限提示 / init ----------

    // 请求体积估算：content + 思考链 + 工具调用参数 + 图片。
    // 原来两处都只累加 aiTextOf(message.content)，实测会漏掉约 1/3：
    // 长会话里思考链能占内容总量的 35%，write_file / edit_file 的 arguments 更大。
    // 结果是百分比环系统性偏低、auto-compact 触发过晚（真实占用早已超窗口）。
    // 统一入口，保证「显示」「弹层」「触发压缩」全部用同一口径：
    // 上下文弹层（renderCtxPopover）按 system / 消息 / 工具定义分段展示，
    // 必须逐条调用 estimateMessageTokens，任何新增体积来源都改这里一处。
    function estimateMessageTokens(message) {
        let tokens = aiEstimateTokens(aiTextOf(message.content));
        if (message.thinking) tokens += aiEstimateTokens(aiTextOf(message.thinking));
        if (Array.isArray(message.toolCalls)) {
            for (const call of message.toolCalls) {
                if (!call) continue;
                tokens += aiEstimateTokens(aiTextOf(call.name));
                tokens += aiEstimateTokens(aiTextOf(call.arguments));
            }
        }
        return tokens + aiImageStats([message]).tokens +
            // 视频按固定值估算（AI_VIDEO_ESTIMATE_TOKENS）；已归档（无 data）的视频不随请求发，不计
            (Array.isArray(message.videos) ? message.videos.filter((v) => v && v.data).length * aiEstimateVideoTokens() : 0);
    }

    function estimateApiMessagesTokens(messages) {
        let tokens = 0;
        for (const message of messages) {
            if (!message) continue;
            tokens += estimateMessageTokens(message);
        }
        return tokens;
    }

    // 上下文占用的**实测锚点**：最近一条已成功发送的 assistant 的 usage。
    // 六个参照 harness（opencode/pi/ZCode/cline/codex/dsh）都优先用 provider 返回的用量，
    // 缺失时才退回字符估算——纯字符估算在工具 schema / 思考链 / CJK 场景系统性偏低，
    // 会出现「估算没到阈值、实际早已超窗」。Anthropic 的 promptTokens 已含 cache 读写。
    function usageContextTokens(usage) {
        if (!usage) return 0;
        const total = Number(usage.totalTokens) || 0;
        if (total > 0) return total;
        return Math.max(0, Number(usage.promptTokens) || 0) +
            Math.max(0, Number(usage.completionTokens) || 0);
    }

    // anchor = {index, usage}：buildApiMessages 记下的「最后一条带 usage 的 assistant」
    // 在发送数组里的位置。实测值 + 其后的增量估算 = 本轮真实上下文占用。
    function estimateApiMessagesContext(messages, anchor) {
        const list = Array.isArray(messages) ? messages : [];
        let measured = 0;
        let from = 0;
        if (anchor && Number.isInteger(anchor.index) && anchor.index >= 0 && anchor.index < list.length) {
            measured = usageContextTokens(anchor.usage);
            if (measured > 0) from = anchor.index + 1;
        }
        let estimated = 0;
        for (let i = from; i < list.length; i++) estimated += estimateMessageTokens(list[i]);
        return {tokens: measured + estimated, measured, estimated};
    }

    // sessionOverride：支线标签页的统计行按指定会话估算（附件只属于面板输入框，不计入）；
    // 无参调用 = 面板当前会话，行为不变。
    function estimateCurrentTokens(sessionOverride) {
        const session = sessionOverride || currentSession();
        const messages = buildApiMessages(session, null, promptTextOf(session && session.id));
        // 有实测锚点就用锚点 + 增量，否则退回全量字符估算（与旧行为一致）
        const built = estimateApiMessagesContext(messages, getBuildAnchor ? getBuildAnchor() : null);
        let tokens = built.tokens;
        for (const item of sessionOverride ? [] : getAttachments()) {
            if (item.kind === 'image') tokens += aiEstimateImageTokens(item);
            else if (item.kind === 'video') tokens += aiEstimateVideoTokens();
            else tokens += aiEstimateTokens(aiTextOf(item.content));
        }
        tokens += toolsTokenEstimate(session);
        const windowSize = contextWindowOf(session);
        return {tokens, windowSize, percent: windowSize > 0 ? tokens / windowSize : 0};
    }

    // 上下文提醒条的会话内关闭态：session → 关闭时的整数百分比；再涨 5% 才重新提醒。
    // WeakMap 挂会话对象，会话删除即回收；压缩后百分比回落自然隐藏，不受关闭态影响。
    const ctxBannerDismissed = new WeakMap();

    function updateCtxBanner() {
        if (!el.ctxBanner) return;
        const {tokens, windowSize, percent} = estimateCurrentTokens();
        const threshold = aiClamp(Number(getConfig().autoCompactThreshold) || 0.8, 0.5, 0.95);
        const session = currentSession();
        const dismissedAt = session ? ctxBannerDismissed.get(session) : null;
        const show = aiCtxBannerShow(percent, threshold, dismissedAt);
        // 状态与文案单一来源 aiCtxBannerState；blocked 与显隐无关（× 关闭后发送门禁仍在）
        const view = aiCtxBannerState(percent, tokens, windowSize);
        if (setCtxGate) setCtxGate({blocked: view.blocked, compactBlocked: view.compactBlocked, percent});
        // ≥100% 时整体压缩请求发不出去，但 startCompact 有超窗兜底（按窗口比例截断转录），
        // 压缩仍可用、只是摘要略粗。按钮保持「压缩上下文」可点，仅补一句预期说明。
        if (el.ctxCompact) {
            el.ctxCompact.textContent = '压缩上下文';
            el.ctxCompact.removeAttribute('aria-disabled');
            if (view.compactBlocked) {
                el.ctxCompact.dataset.tip = '已超过模型上限：本次压缩只喂入最近的转录，摘要会略粗';
            } else {
                delete el.ctxCompact.dataset.tip;
            }
        }
        const wasHidden = el.ctxBanner.classList.contains('hidden');
        el.ctxBanner.classList.toggle('hidden', !show);
        el.ctxBanner.classList.toggle('is-over', show && view.state === 'over');
        if (wasHidden !== !show) positionOverlays();
        if (show && el.ctxBannerText) el.ctxBannerText.textContent = view.text;
    }

    // 点 × 关闭提醒：记下当前百分比（会话内），上下文再涨 5% 才重新出现
    function dismissCtxBanner() {
        const session = currentSession();
        if (session) ctxBannerDismissed.set(session, Math.round(estimateCurrentTokens().percent * 100));
        if (!el.ctxBanner) return;
        el.ctxBanner.classList.add('hidden');
        positionOverlays();
    }
    return {showPromptDialog, showMemoryDialog, createAppSkill, showSkillsDialog, updateCtxBanner, dismissCtxBanner,
        openAIDialog, closeAIDialog, dialogNode, dialogButton,
        showArchivedDialog, estimateMessageTokens, estimateApiMessagesTokens, estimateApiMessagesContext, estimateCurrentTokens};
}
