// AI 设置 → 模型：条目列表、编辑器状态机（新建/编辑/收起）、窗口与思考预算、导入条目、模型账号增删复制。
// 从 ai-settings-dialog.js 拆出；modelEditorState / editorEntryOf 随模型域迁入，宿主经 extras 触达状态栏与整页刷新。
// 额度外显（cc-switch 式）：账号卡带品牌图标与余额行——只在 profile.usage.enabled 时渲染；
// 未开启的账号没有余额行也没有「查询用量」按钮，只有「用量配置」入口（弹窗见 ai-usage-config-dialog.js）。
import {
    findModelEntry,
    formatTokenAmount,
    modelEntryOf,
    resolveModelId,
} from '../core/ai-config-model.js';
import {
    aiNowId,
} from '../core/ai-constants.js';
import {iconSvg} from '../../core/icons.js';
import {overlayStack} from '../../core/overlay-stack.js';
import {providerIconTileHtml} from '../core/ai-provider-icons.js';
import {usageCompactLine} from '../usage/ai-usage-quota.js';

export function createAIModelSettings(ctx, extras) {

    const opt = ctx.opt;
    const flash = ctx.flash;
    const askConfirm = ctx.askConfirm;
    const saveAIConfig = ctx.saveAIConfig;
    const updateComposerState = ctx.updateComposerState;
    const renderMessages = ctx.renderMessages;
    const isOpen = ctx.isOpen;
    // 账号增删后重绘主区：空态「尚未配置 AI / 未配置模型」与模型 chip 都按 profileOf(session)
    // 画在消息区里，updateComposerState 只刷发送按钮/hint，不重画主区——不调这条就会停在旧空态，
    // 直到关掉面板重开（与 switchProfile / importAIConfig 的收尾口径一致）。
    const refreshMainView = () => {
        if (typeof updateComposerState === 'function') updateComposerState();
        if (typeof ctx.renderModelChip === 'function') ctx.renderModelChip();
        if (typeof renderMessages === 'function' && typeof isOpen === 'function' &&
            isOpen() && ctx.currentSession && ctx.currentSession()) renderMessages(true);
    };
    const enhanceSelect = typeof ctx.enhanceSelect === 'function' ? ctx.enhanceSelect : null;
    // 额度查询域：extras.usageQuota 是惰性 getter（管线在 ai-panel 构造）；
    // openUsageConfigDialog 由 ai-settings-dialog 注入（弹窗模块先于本模块创建）
    const usageQuota = typeof extras.usageQuota === 'function' ? extras.usageQuota : null;
    const openUsageConfigDialog = typeof extras.openUsageConfigDialog === 'function'
        ? extras.openUsageConfigDialog : null;

    // 模型编辑器的临时状态（原在 ai-settings-dialog.js 闭包级，随模型域迁入）
    let modelEditorState = null;
    // 编辑器的弹层栈条目：盖在设置窗之上，Esc 由栈先退它再退设置窗
    let modelEditorStackHandle = null;
    function disposeEditorStack() {
        if (modelEditorStackHandle) {
            modelEditorStackHandle.dispose();
            modelEditorStackHandle = null;
        }
    }
    const renderProfileSelect = ctx.renderProfileSelect;
    const activeProfile = ctx.activeProfile;
    const defaultModelEntry = ctx.defaultModelEntry;
    const defaultProfile = ctx.defaultProfile;
    const dialogButton = ctx.dialogButton;
    const queryUsageForAccount = ctx.queryUsageForAccount;
    const switchProfile = ctx.switchProfile;
    const getConfig = ctx.getConfig;

    function editorEntryOf(profile) {
        if (!profile) return null;
        if (modelEditorState && modelEditorState.entryId) {
            const found = (profile.models || []).find((item) => item.id === modelEditorState.entryId);
            if (found) return found;
        }
        if (profile.id === getConfig().activeProfileId) return modelEntryOf(profile, getConfig().activeModelId);
        return modelEntryOf(profile, profile.lastModelId);
    }

    function providerLabelFor(profile) {
        return profile && profile.provider === 'anthropic' ? '/v1/messages'
            : (profile && profile.provider === 'responses' ? '/responses' : '/chat/completions');
    }

    // 手动排序：数组顺序即持久化顺序（saveAIConfig 存整个 profiles），拖拽与上移/下移都走这里。
    // 返回是否真的移动了（首/末张往边界移是 no-op）。
    function moveProfile(id, toIndex) {
        const profiles = getConfig().profiles;
        const from = profiles.findIndex((item) => item.id === id);
        if (from < 0) return false;
        const target = Math.max(0, Math.min(profiles.length - 1, Math.round(Number(toIndex))));
        if (target === from) return false;
        const [moved] = profiles.splice(from, 1);
        profiles.splice(target, 0, moved);
        saveAIConfig();
        extras.refreshSettingsPane();
        renderProfileSelect();
        renderModelList();
        return true;
    }

    // 拖拽排序：dragover 按指针在目标卡的上/下半决定插到它前还是后，让位提示用 CSS 类。
    function setupCardDrag(card, profile) {
        card.draggable = true;
        card.dataset.profileId = profile.id;
        card.addEventListener('dragstart', (event) => {
            dragProfileId = profile.id;
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = 'move';
                try { event.dataTransfer.setData('text/plain', profile.id); } catch (_) { /* IE 兼容，忽略 */ }
            }
            card.classList.add('dragging');
        });
        card.addEventListener('dragend', () => {
            dragProfileId = '';
            card.classList.remove('dragging');
            for (const node of opt.modelList.querySelectorAll('.drop-before, .drop-after')) {
                node.classList.remove('drop-before', 'drop-after');
            }
        });
        card.addEventListener('dragover', (event) => {
            if (!dragProfileId || dragProfileId === profile.id) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            const rect = card.getBoundingClientRect();
            const offset = event.clientY - rect.top - rect.height / 2;
            const after = offset > 0;
            // 滞回：让位 margin 会移动下一次的中线，指针停在中线附近会在两态间来回跳。
            // 已处于某态时，指针要越过中线 8px 才切换。
            const hysteresis = 8;
            if (card.classList.contains('drop-before') && offset > -hysteresis) return;
            if (card.classList.contains('drop-after') && offset < hysteresis) return;
            card.classList.toggle('drop-after', after);
            card.classList.toggle('drop-before', !after);
        });
        card.addEventListener('dragleave', (event) => {
            if (card.contains(event.relatedTarget)) return;
            card.classList.remove('drop-before', 'drop-after');
        });
        card.addEventListener('drop', (event) => {
            event.preventDefault();
            const after = card.classList.contains('drop-after');
            card.classList.remove('drop-before', 'drop-after');
            if (!dragProfileId || dragProfileId === profile.id) return;
            const profiles = getConfig().profiles;
            const from = profiles.findIndex((item) => item.id === dragProfileId);
            const to = profiles.findIndex((item) => item.id === profile.id);
            dragProfileId = '';
            if (from < 0 || to < 0) return;
            // 从前往后移时删掉原位后目标下标会左移一位，按 after 补回
            moveProfile(profiles[from].id, to + (after ? 1 : 0));
        });
    }

    let dragProfileId = '';

    // 余额行：只在 usage.enabled 时渲染。点击 = 重新查询 + 明细弹层（ctx.queryUsageForAccount）；
    // 失败态红字带原因（详情在弹层里），无缓存显示「待查询」。缓存来自 ai-usage-quota 的快照层。
    function buildUsageLine(profile) {
        const usage = profile.usage;
        if (!usage || usage.enabled !== true || !usageQuota) return null;
        const snapshot = usageQuota().peek(profile.id);
        const line = document.createElement('button');
        line.type = 'button';
        line.className = 'ai-usage-line';
        const icon = document.createElement('span');
        icon.className = 'ai-usage-line-icon';
        icon.innerHTML = iconSvg('refresh', 12);
        const text = document.createElement('span');
        text.className = 'ai-usage-line-text';
        // 显示规范 v1（docs/finished-plans/ai-quota-display.md §11）：全窗口百分比 + ⏱倒计时，
        // 币种只留符号；只有数值上色，标签/前缀/倒计时灰。明细仍点弹层看。
        const compact = usageCompactLine(snapshot);
        if (compact) {
            if (compact.prefix) text.appendChild(document.createTextNode(compact.prefix));
            compact.parts.forEach((part, index) => {
                if (index) text.appendChild(document.createTextNode(' · '));
                if (part.label) text.appendChild(document.createTextNode(part.label + ': '));
                const value = document.createElement('b');
                value.className = 'ai-usage-value' + (part.tone ? ' tone-' + part.tone : '');
                value.textContent = part.value;
                text.appendChild(value);
                if (part.countdown) {
                    const clock = document.createElement('span');
                    clock.className = 'ai-usage-clock';
                    clock.innerHTML = iconSvg('clock', 11);
                    const countdown = document.createElement('span');
                    countdown.className = 'ai-usage-countdown';
                    countdown.textContent = part.countdown;
                    text.append(clock, countdown);
                }
            });
        } else {
            text.textContent = '待查询';
        }
        if (!snapshot) line.classList.add('pending');
        else if (snapshot.state === 'error') line.classList.add('error');
        line.append(icon, text);
        // 不再挂 hover tooltip：点击直接出美化后的用量弹层（含全量窗口 + 倒计时 + 重新查询）。
        line.addEventListener('click', (event) => queryUsageForAccount(profile, event));
        return line;
    }

    function renderModelList() {
        // 拖拽中若被别处触发重渲染（表单变更 / refreshSettings），原 card 节点销毁会让 dragend
        // 永不触发——残留的 dragProfileId 与让位类会卡住下一个拖拽，重建前一并清掉。
        dragProfileId = '';
        if (!opt.modelList) return;
        opt.modelList.innerHTML = '';
        if (!getConfig().profiles.length) {
            const empty = document.createElement('div');
            empty.className = 'ai-model-empty';
            empty.textContent = '还没有模型账号';
            opt.modelList.appendChild(empty);
            return;
        }
        const profiles = getConfig().profiles;
        profiles.forEach((profile, index) => {
            const entry = modelEntryOf(profile, profile.id === getConfig().activeProfileId ? getConfig().activeModelId : profile.lastModelId);
            const card = document.createElement('div');
            card.className = 'ai-model-card' + (profile.id === getConfig().activeProfileId ? ' active' : '');
            const head = document.createElement('div');
            head.className = 'ai-model-card-head';
            const grip = document.createElement('span');
            grip.className = 'ai-model-grip';
            grip.dataset.tip = '拖动调整顺序';
            grip.innerHTML = iconSvg('grip', 14);
            head.appendChild(grip);
            const iconSlot = document.createElement('span');
            iconSlot.className = 'ai-picon-slot';
            iconSlot.innerHTML = providerIconTileHtml(profile, 20);
            head.appendChild(iconSlot);
            const name = document.createElement('span');
            name.className = 'ai-model-name';
            name.textContent = profile.name || '未命名账号';
            const provider = document.createElement('span');
            provider.className = 'ai-model-provider';
            provider.textContent = providerLabelFor(profile);
            head.append(name, provider);
            if (profile.id === getConfig().activeProfileId) {
                const badge = document.createElement('span');
                badge.className = 'ai-model-badge';
                badge.textContent = '当前';
                head.appendChild(badge);
            }
            const meta = document.createElement('div');
            meta.className = 'ai-model-meta';
            meta.textContent = [
                (profile.models || []).length + ' 个模型' + (entry && entry.model ? ' · ' + entry.model : ' · 未填写模型 ID'),
                profile.baseURL || '未填写 Base URL',
                profile.apiKey ? 'Key 已配置' : 'Key 未配置',
            ].join(' · ');
            const actions = document.createElement('div');
            actions.className = 'ai-model-actions';

            if (profile.id !== getConfig().activeProfileId) {
                actions.appendChild(dialogButton('设为当前', 'dlg-btn', () => switchProfile(profile.id)));
            }
            // 旧的「查询用量」按钮退役：开启查询的账号走余额行（点击即查 + 明细），
            // 未开启的不显示任何查询按钮——统一只有「用量配置」入口
            if (openUsageConfigDialog) {
                actions.appendChild(dialogButton('用量配置', 'dlg-btn', () => openUsageConfigDialog(profile.id)));
            } else {
                actions.appendChild(dialogButton('查询用量', 'dlg-btn', (event) => queryUsageForAccount(profile, event)));
            }
            actions.appendChild(dialogButton('编辑', 'dlg-btn', () => openModelEditor(profile.id)));
            actions.appendChild(dialogButton('复制', 'dlg-btn', () => duplicateModel(profile.id)));
            actions.appendChild(dialogButton('删除', 'dlg-btn', () => deleteModel(profile.id)));
            const usageLine = buildUsageLine(profile);
            if (usageLine) card.append(head, meta, usageLine, actions);
            else card.append(head, meta, actions);
            setupCardDrag(card, profile);
            opt.modelList.appendChild(card);
        });
        // 自动刷新：开启查询的账号按 autoIntervalMin 节流补查（0 = 只手动），
        // 批次完成后重画列表；白名单外的「官方」模板不打扰
        if (usageQuota) {
            const enabled = getConfig().profiles.filter((p) => p.usage && p.usage.enabled === true);
            if (enabled.length) usageQuota().sweep(enabled, () => {
                renderModelList();
                // 自动补查完成：刷新 composer 状态栏额度胶囊（当前会话若绑定了被刷新的账号）
                if (typeof extras.onUsageQuotaUpdated === 'function') extras.onUsageQuotaUpdated();
            });
        }
    }

    function setActiveModel(id) {
        // 兼容旧入口：设为当前 = 切换账号（保留账号记住的模型条目）
        switchProfile(id);
    }

    function openModelEditor(id) {
        if (!opt.modelEditor) return;
        let profile = id ? getConfig().profiles.find((item) => item.id === id) : null;
        if (id && !profile) return;
        const previousActiveId = getConfig().activeProfileId;
        if (profile) {
            // 编辑器打开的是该账号上次记住的条目，与「当前窗口选择」解耦；
            // 用 resolveModelId 保证失效 id 回落到真实存在的条目。
            modelEditorState = {
                isCreate: false,
                editingId: profile.id,
                previousActiveId,
                entryId: resolveModelId(profile, profile.lastModelId, ''),
                snapshot: JSON.parse(JSON.stringify(profile)),
            };
        } else {
            profile = defaultProfile();
            profile.name = '账号 ' + (getConfig().profiles.length + 1);
            getConfig().profiles.push(profile);
            modelEditorState = {
                isCreate: true,
                newId: profile.id,
                previousActiveId,
                entryId: profile.models[0].id,
                snapshot: null,
            };
        }
        getConfig().activeProfileId = profile.id;
        getConfig().activeModelId = modelEditorState.entryId;
        saveAIConfig();
        extras.refreshSettingsPane();
        renderModelList();
        if (opt.modelTitle) opt.modelTitle.textContent = modelEditorState.isCreate ? '新建模型账号' : '编辑模型账号';
        // 密钥每次打开都回到掩码态，避免上次「显示」把明文留在下一次编辑里
        if (opt.apiKey) opt.apiKey.type = 'password';
        if (opt.keyToggle) {
            opt.keyToggle.setAttribute('aria-pressed', 'false');
            opt.keyToggle.setAttribute('aria-label', '显示密钥');
            opt.keyToggle.dataset.tip = '显示密钥';
        }
        if (opt.modelEditorMask) opt.modelEditorMask.classList.remove('hidden');
        // 清掉拖拽残留的内联定位：createDialogDrag 拖头部会写 transform:none + left/top 像素值，
        // 不清的话 ui-dialog-in 动画结束后会回落到这些值，弹窗跳到上次拖到的位置（开合闪现）。
        // 与 settings-dialogs.js 的 openDialogEl 同款处理（该类注释也明确只有 openDialogEl 会清）。
        opt.modelEditor.style.left = '';
        opt.modelEditor.style.top = '';
        opt.modelEditor.style.transform = '';
        opt.modelEditor.classList.remove('hidden');
        // 进全局弹层栈（modal 档，遮罩作 underEl）：Esc 先退编辑器（= 取消）再退设置窗
        if (modelEditorStackHandle) modelEditorStackHandle.dispose();
        modelEditorStackHandle = overlayStack.open({
            id: 'ai-model-editor', kind: 'modal',
            el: opt.modelEditor, underEl: opt.modelEditorMask,
            onClose: () => { closeModelEditor(false); return true; },
        });
        // 协议 / 代理 / 推理下拉与设置页同款浮层：原生 select 展开会露出系统菜单，
        // 和弹窗里的自绘控件像两套。enhanceSelect 幂等，重复调用顺带同步触发器文本。
        if (enhanceSelect) {
            for (const node of [opt.provider, opt.proxy, opt.reasoning]) {
                if (node) enhanceSelect(node);
            }
        }
        setTimeout(() => {
            if (opt.name) {
                opt.name.focus();
                opt.name.select();
            }
        }, 50);
    }

    // 保存校验：账号名必填；至少一个模型条目带非空模型 ID（空条目自动丢弃）
    function collectEditorEntries(profile) {
        const entries = (profile.models || []).filter((entry) => String(entry.model || '').trim());
        if (!entries.length) {
            extras.setSettingsStatus('至少需要一个模型 ID', 'error');
            if (opt.model) opt.model.focus();
            return null;
        }
        return entries;
    }

    function closeModelEditor(save) {
        const state = modelEditorState;
        if (!state) {
            if (opt.modelEditor) opt.modelEditor.classList.add('hidden');
            return;
        }
        const profile = activeProfile();
        if (save) {
            const name = String((opt.name && opt.name.value) || '').trim();
            if (!name) {
                extras.setSettingsStatus('账号名称不能为空', 'error');
                if (opt.name) opt.name.focus();
                return;
            }
            const entries = profile ? collectEditorEntries(profile) : null;
            if (!entries) return;
            if (profile) {
                profile.name = name;
                profile.models = entries;
                if (!findModelEntry(profile, profile.lastModelId)) profile.lastModelId = entries[0].id;
            }
            if (state.isCreate) getConfig().activeProfileId = profile ? profile.id : getConfig().activeProfileId;
            else getConfig().activeProfileId = state.previousActiveId || (profile ? profile.id : '');
            const activeAccount = getConfig().profiles.find((item) => item.id === getConfig().activeProfileId);
            if (activeAccount && !findModelEntry(activeAccount, getConfig().activeModelId)) {
                getConfig().activeModelId = resolveModelId(activeAccount, activeAccount.lastModelId, '');
            }
            saveAIConfig();
            modelEditorState = null;
            disposeEditorStack();
            if (opt.modelEditor) opt.modelEditor.classList.add('hidden');
            if (opt.modelEditorMask) opt.modelEditorMask.classList.add('hidden');
            extras.refreshSettingsPane();
            renderProfileSelect();
            renderModelList();
            refreshMainView();
            flash('模型账号已保存：' + name + '（' + entries.length + ' 个模型）');
            return;
        }
        if (state.isCreate) {
            getConfig().profiles = getConfig().profiles.filter((item) => item.id !== state.newId);
            getConfig().activeProfileId = state.previousActiveId ||
                (getConfig().profiles[0] ? getConfig().profiles[0].id : '');
        } else {
            const editing = getConfig().profiles.find((item) => item.id === state.editingId);
            if (editing && state.snapshot) Object.assign(editing, state.snapshot);
            getConfig().activeProfileId = state.previousActiveId || (editing ? editing.id : '');
        }
        const activeAccount = getConfig().profiles.find((item) => item.id === getConfig().activeProfileId);
        if (activeAccount && !findModelEntry(activeAccount, getConfig().activeModelId)) {
            getConfig().activeModelId = resolveModelId(activeAccount, activeAccount.lastModelId, '');
        }
        modelEditorState = null;
        disposeEditorStack();
        if (opt.modelEditor) opt.modelEditor.classList.add('hidden');
        if (opt.modelEditorMask) opt.modelEditorMask.classList.add('hidden');
        saveAIConfig();
        extras.refreshSettingsPane();
        renderProfileSelect();
        renderModelList();
        refreshMainView();
    }

    // 编辑器内的模型条目 strip（选中态 + 计数）；删除走 chip 内联 ×，账号只剩一个模型时不显示
    function renderModelEntries() {
        const profile = activeProfile();
        const models = profile && Array.isArray(profile.models) ? profile.models : [];
        if (opt.modelCount) opt.modelCount.textContent = String(models.length);
        if (!opt.modelEntries) return;
        opt.modelEntries.innerHTML = '';
        if (!profile) return;
        const current = editorEntryOf(profile);
        for (const entry of models) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'ai-entry-chip' + (current && entry.id === current.id ? ' active' : '');
            const name = document.createElement('span');
            name.className = 'ai-entry-chip-name';
            name.textContent = entry.model || '（未填写）';
            chip.appendChild(name);
            chip.addEventListener('click', () => {
                if (modelEditorState) modelEditorState.entryId = entry.id;
                // 两个字段必须一起写：activeModelId 是窗口选择，lastModelId 是账号记忆。
                // 只写前者会让下次 switchProfile / openModelEditor 用 stale 的 lastModelId 覆盖回来。
                profile.lastModelId = entry.id;
                if (profile.id === getConfig().activeProfileId) getConfig().activeModelId = entry.id;
                saveAIConfig();
                extras.refreshSettingsPane();
            });
            // chip 本身是 button，删除钮用 span+role 以免嵌套按钮（HTML 不允许）
            if (models.length > 1) {
                const remove = document.createElement('span');
                remove.className = 'ai-entry-chip-x';
                remove.setAttribute('role', 'button');
                remove.setAttribute('tabindex', '0');
                remove.setAttribute('aria-label', '删除模型 ' + (entry.model || '未填写'));
                remove.innerHTML = iconSvg('close');
                remove.addEventListener('click', (event) => {
                    event.stopPropagation();
                    deleteEditorEntry(entry.id);
                });
                remove.addEventListener('keydown', (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    event.stopPropagation();
                    deleteEditorEntry(entry.id);
                });
                chip.appendChild(remove);
            }
            opt.modelEntries.appendChild(chip);
        }
    }

    function addEditorEntry() {
        const profile = activeProfile();
        if (!profile) return;
        const entry = defaultModelEntry();
        profile.models.push(entry);
        if (modelEditorState) modelEditorState.entryId = entry.id;
        if (profile.id === getConfig().activeProfileId) getConfig().activeModelId = entry.id;
        saveAIConfig();
        extras.refreshSettingsPane();
        renderModelList();
        if (opt.model) {
            opt.model.focus();
            opt.model.select();
        }
    }

    // 删除模型条目：chip 内联 × 传条目 id，独立按钮（无参）删当前选中条目
    function deleteEditorEntry(entryId) {
        const profile = activeProfile();
        if (!profile || !profile.models) return;
        if (profile.models.length <= 1) {
            extras.setSettingsStatus('账号至少保留一个模型', 'error');
            return;
        }
        const wanted = typeof entryId === 'string' ? entryId : '';
        const target = (wanted && profile.models.find((entry) => entry.id === wanted)) || editorEntryOf(profile);
        if (!target) return;
        profile.models = profile.models.filter((entry) => entry.id !== target.id);
        const next = profile.models[0];
        if (modelEditorState) modelEditorState.entryId = next.id;
        if (profile.id === getConfig().activeProfileId) getConfig().activeModelId = next.id;
        saveAIConfig();
        extras.refreshSettingsPane();
        renderModelList();
    }

    function duplicateModel(id) {
        const profile = getConfig().profiles.find((item) => item.id === id);
        if (!profile) return;
        const copy = JSON.parse(JSON.stringify(profile));
        copy.id = aiNowId('profile-');
        copy.name = (profile.name || '模型') + ' 副本';
        getConfig().profiles.push(copy);
        getConfig().activeProfileId = copy.id;
        saveAIConfig();
        extras.refreshSettingsPane();
        renderProfileSelect();
        renderModelList();
        openModelEditor(copy.id);
    }

    function deleteModel(id) {
        const profile = getConfig().profiles.find((item) => item.id === id);
        if (!profile) return;
        askConfirm('删除模型账号「' + (profile.name || '未命名') + '」（含其全部模型）？', () => {
            getConfig().profiles = getConfig().profiles.filter((item) => item.id !== id);
            if (getConfig().activeProfileId === id) {
                getConfig().activeProfileId = getConfig().profiles[0] ? getConfig().profiles[0].id : '';
                const next = activeProfile();
                getConfig().activeModelId = next ? modelEntryOf(next, next.lastModelId).id : '';
            }
            // 额度快照随账号走：被删账号的 localStorage 快照一并清掉（profile id 唯一，不清理就是永久残留）
            if (usageQuota) usageQuota().invalidate(id);
            saveAIConfig();
            extras.refreshSettingsPane();
            renderProfileSelect();
            renderModelList();
            refreshMainView();
            flash('已删除模型账号：' + (profile.name || '未命名'));
        }, '删除', '删除模型账号');
    }

return {
        addEditorEntry,
        closeModelEditor,
        collectEditorEntries,
        deleteEditorEntry,
        deleteModel,
        duplicateModel,
        editorEntryOf,
        moveProfile,
        openModelEditor,
        providerLabelFor,
        renderModelEntries,
        renderModelList,
        setActiveModel,
    };
}
