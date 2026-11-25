// AI 设置 → 偏好：偏好清单（增删改）、预设账号与系统提示词。
// 从 ai-settings-dialog.js 拆出；openModelEditor / renderModelList 由 model 模块经 extras 注入。
import {
    AI_PREF_LIMIT, AI_PREF_TEXT_LIMIT, AI_PRESETS, aiNowId,
} from '../core/ai-constants.js';
import {iconSvg} from '../../core/icons.js';

export function createAIPreferenceSettings(ctx, extras) {

    const opt = ctx.opt;
    const flash = ctx.flash;
    const saveAIConfig = ctx.saveAIConfig;
    const renderProfileSelect = ctx.renderProfileSelect;
    const defaultProfile = ctx.defaultProfile;
    const promptById = ctx.promptById;
    const aiPathKey = ctx.aiPathKey;
    const getConfig = ctx.getConfig;
    const showNameDialog = ctx.showNameDialog;

// 状态条（宿主）经 extras 注入
    const setSettingsStatus = extras.setSettingsStatus;

    function renderPreferenceSettings() {
        if (!opt.prefs) return;
        opt.prefs.innerHTML = '';
        const prefs = getConfig().preferences || [];
        const query = opt.prefFilter ? String(opt.prefFilter.value || '').trim().toLowerCase() : '';
        const shown = query ? prefs.filter((pref) => String(pref.text).toLowerCase().includes(query)) : prefs;
        if (!prefs.length) {
            const empty = document.createElement('div');
            empty.className = 'ai-pref-empty';
            empty.textContent = '（暂无偏好；例如「回答用中文，尽量简洁」）';
            opt.prefs.appendChild(empty);
        } else if (!shown.length) {
            const empty = document.createElement('div');
            empty.className = 'ai-pref-empty';
            empty.textContent = '没有匹配「' + query + '」的偏好';
            opt.prefs.appendChild(empty);
        } else {
            for (let i = 0; i < shown.length; i++) {
                const pref = shown[i];
                const row = document.createElement('div');
                row.className = 'ai-pref-row';
                const idx = document.createElement('span');
                idx.className = 'ai-pref-idx';
                idx.textContent = String(i + 1);
                const text = document.createElement('span');
                text.className = 'ai-pref-text';
                text.textContent = pref.text;
                text.dataset.tip = pref.text;
                const src = document.createElement('span');
                src.className = 'ai-pref-src' + (pref.source === 'ai' ? ' on' : '');
                src.textContent = pref.source === 'ai' ? 'AI' : '用户';
                const edit = document.createElement('button');
                edit.type = 'button';
                edit.className = 'ai-pref-btn';
                edit.setAttribute('aria-label', '编辑');
                edit.innerHTML = iconSvg('rename', 12);
                edit.addEventListener('click', () => editPreference(pref));
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'ai-pref-btn';
                remove.setAttribute('aria-label', '删除');
                remove.innerHTML = iconSvg('close', 12);
                remove.addEventListener('click', () => {
                    getConfig().preferences = getConfig().preferences.filter((item) => item.id !== pref.id);
                    saveAIConfig();
                    renderPreferenceSettings();
                    flash('已删除偏好：' + pref.text);
                });
                const actions = document.createElement('div');
                actions.className = 'ai-pref-actions';
                actions.append(edit, remove);
                row.append(idx, text, src, actions);
                opt.prefs.appendChild(row);
            }
        }
        if (opt.prefCount) {
            opt.prefCount.textContent = query
                ? shown.length + ' / ' + prefs.length + ' 条'
                : prefs.length + ' 条';
        }
        if (opt.prefAdd) opt.prefAdd.disabled = prefs.length >= AI_PREF_LIMIT;
    }

    function submitPreferenceText(title, value, okLabel, onSubmit) {
        const validate = (raw) => {
            const text = String(raw || '').trim();
            if (!text) throw new Error('偏好内容不能为空');
            if (text.length > AI_PREF_TEXT_LIMIT) throw new Error('偏好最多 ' + AI_PREF_TEXT_LIMIT + ' 字符');
            return text;
        };
        if (showNameDialog) {
            showNameDialog({title, label: '偏好内容', value: value || '', okLabel, onSubmit: (raw) => onSubmit(validate(raw))});
            return;
        }
        const raw = window.prompt(title, value || '');
        if (raw == null) return;
        try {
            onSubmit(validate(raw));
        } catch (e) {
            flash((e && e.message) || String(e), true);
        }
    }

    function editPreference(pref) {
        submitPreferenceText('编辑偏好', pref.text, '保存', (text) => {
            pref.text = text;
            pref.updatedAt = Date.now();
            saveAIConfig();
            renderPreferenceSettings();
        });
    }

    function addPreference() {
        if ((getConfig().preferences || []).length >= AI_PREF_LIMIT) {
            flash('偏好数量已达上限（' + AI_PREF_LIMIT + ' 条）', true);
            return;
        }
        submitPreferenceText('添加偏好', '', '添加', (text) => {
            if (getConfig().preferences.some((pref) => pref.text === text)) throw new Error('已存在相同偏好');
            getConfig().preferences.push({
                id: aiNowId('pref-'),
                text,
                source: 'user',
                createdAt: Date.now(),
                updatedAt: Date.now(),
            });
            saveAIConfig();
            renderPreferenceSettings();
        });
    }


    function aiAddUnique(list, value) {
        if (!Array.isArray(list) || !value) return;
        const key = aiPathKey(value);
        if (!list.some((item) => aiPathKey(item) === key)) list.push(value);
    }

    function renderPresetSelect() {
        if (!opt.preset) return;
        opt.preset.innerHTML = '';
        for (const preset of AI_PRESETS) {
            const option = document.createElement('option');
            option.value = preset.id;
            option.textContent = preset.name;
            opt.preset.appendChild(option);
        }
    }

    function refreshPromptSettings() {
        if (!opt.prompt) return;
        const previous = opt.prompt.value;
        opt.prompt.innerHTML = '';
        for (const prompt of getConfig().prompts) {
            const option = document.createElement('option');
            option.value = prompt.id;
            option.textContent = prompt.name + (prompt.builtin ? '（内置）' : '') +
                (prompt.id === getConfig().activePromptId ? ' · 默认' : '');
            opt.prompt.appendChild(option);
        }
        if (previous && promptById(previous)) opt.prompt.value = previous;
        else opt.prompt.value = getConfig().activePromptId || (getConfig().prompts[0] && getConfig().prompts[0].id) || '';
        const selected = promptById(opt.prompt.value);
        if (opt.promptText) opt.promptText.value = selected ? selected.content : '';
        if (opt.promptDel) opt.promptDel.disabled = !selected || !!selected.builtin;
    }

    function addPresetProfile() {
        if (!opt.preset) return;
        const preset = AI_PRESETS.find((item) => item.id === opt.preset.value);
        if (!preset) return;
        const profile = defaultProfile();
        profile.name = preset.name;
        profile.provider = preset.provider;
        profile.baseURL = preset.baseURL;
        // 不再预置模型 ID：让用户填好 Key 后用「拉取模型列表」自己选。
        // 预置的 model 只是模板猜测值，常常与实际可用 ID 不符，反而要手动删。
        getConfig().profiles.push(profile);
        getConfig().activeProfileId = profile.id;
        saveAIConfig();
        renderProfileSelect();
        extras.renderModelList();
        extras.openModelEditor(profile.id);
        extras.setSettingsStatus('预设已添加：' + preset.name + '，请填写 API Key 并拉取模型列表', 'ok');
    }

return {
        addPreference,
        addPresetProfile,
        aiAddUnique,
        editPreference,
        refreshPromptSettings,
        renderPreferenceSettings,
        renderPresetSelect,
        submitPreferenceText,
    };
}
