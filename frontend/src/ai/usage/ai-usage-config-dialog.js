// ai-usage-config-dialog.js：账号额度查询配置弹窗——启用开关 / 预设模板 chips /
// 模板专属字段（apiKey / baseUrl / extraFields）/ 自定义脚本编辑器 / 测试脚本。
// 走 openAIDialog 动态构建（同 gen-settings 先例），DOM 不进 index.html；
// 查询管线在 ai-usage-quota.js，本模块只做表单与落盘。
import {createInput, createSwitch, createTextarea} from '../../core/form-controls.js';
import {normalizeUsageConfig} from '../core/ai-config-model.js';
import {
    USAGE_NEWAPI_FIELDS,
    USAGE_OAUTH_PROVIDERS,
    USAGE_PLAN_FIELDS,
    USAGE_PLAN_PRESETS,
    USAGE_SCRIPT_HELP,
    USAGE_TEMPLATE_KEYS,
    USAGE_TEMPLATE_LABELS,
    usageTemplatePresetCode,
} from './ai-usage-templates.js';

export function createAIUsageConfigDialog(ctx, extras) {
    const getConfig = ctx.getConfig;
    const saveAIConfig = ctx.saveAIConfig;
    const flash = ctx.flash;
    const dialogButton = ctx.dialogButton;
    const openAIDialog = ctx.openAIDialog;
    const closeAIDialog = ctx.closeAIDialog;

    // 打开中的编辑态：{profileId, draft}；重开 / 保存后清空
    let state = null;

    function dialogNode(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function section(title) {
        const box = dialogNode('div', 'ai-usage-section');
        if (title) box.appendChild(dialogNode('div', 'ai-usage-section-title', title));
        return box;
    }

    function fieldRow(label, control, hint) {
        const row = dialogNode('div', 'ai-usage-field');
        if (label) row.appendChild(dialogNode('span', 'ai-usage-field-label', label));
        row.appendChild(control);
        if (hint) row.appendChild(dialogNode('div', 'ai-usage-field-hint', hint));
        return row;
    }

    function chipsRow(items, activeValue, onPick) {
        const wrap = dialogNode('div', 'ai-usage-chips');
        for (const item of items) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'ai-usage-chip' + (item.value === activeValue ? ' active' : '');
            chip.textContent = item.label;
            chip.addEventListener('click', () => onPick(item.value));
            wrap.appendChild(chip);
        }
        return wrap;
    }

    // 密钥输入（password + 显隐切换）：配置随 ai-config.json 本地明文存储（与账号
    // apiKey 同语义），掩码只是防肩窥。
    function secretInput(value, placeholder, onInput) {
        const wrap = dialogNode('div', 'ai-usage-secret');
        const {control} = createInput({
            type: 'password',
            value: value || '',
            placeholder: placeholder || '留空则使用账号的 API Key',
            spellcheck: false,
            autocomplete: 'off',
            onInput: (event) => onInput(event.target.value),
        });
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'ai-usage-secret-toggle';
        toggle.textContent = '显示';
        let visible = false;
        toggle.addEventListener('click', () => {
            visible = !visible;
            control.type = visible ? 'text' : 'password';
            toggle.textContent = visible ? '隐藏' : '显示';
        });
        wrap.append(control, toggle);
        return wrap;
    }

    function numberInput(value, min, max, onInput) {
        const {control} = createInput({
            type: 'number',
            value: String(value),
            min,
            max,
            onInput: (event) => onInput(event.target.value),
        });
        return control;
    }

    function scriptTextarea(code) {
        const {control} = createTextarea({
            rows: 12,
            value: code || '',
            spellcheck: false,
            className: 'dlg-input ai-settings-textarea ai-usage-script',
            placeholder: '粘贴或编写脚本：({ request: {...}, extractor: function (response) {...} })',
            onInput: (event) => {
                state.draft.code = event.target.value;
            },
        });
        return control;
    }

    // 当前模板应显示的脚本文本（预设展示原脚本，便于照抄成自定义）。
    function draftScriptOf(draft) {
        if (draft.template === 'official') return '';
        if (draft.template === 'custom') return draft.code;
        return usageTemplatePresetCode(draft.template, draft.planProvider) || draft.code;
    }

    function renderStatus(statusNode, snapshot) {
        statusNode.innerHTML = '';
        statusNode.classList.remove('hidden');
        if (!snapshot) return;
        if (snapshot.state === 'error') {
            statusNode.appendChild(dialogNode('div', 'ai-usage-test error', '测试失败：' + (snapshot.error || '未知错误')));
            return;
        }
        const ok = dialogNode('div', 'ai-usage-test ok', '测试成功');
        statusNode.appendChild(ok);
        for (const item of snapshot.items.slice(0, 6)) {
            const text = item.isValid === false
                ? (item.invalidMessage || '已失效')
                : [item.planName, item.label && item.value ? item.label + ' ' + item.value : null,
                    Number.isFinite(item.remaining) ? '余额 ' + item.remaining + (item.unit ? ' ' + item.unit : '') : null,
                    Number.isFinite(item.used) ? '已用 ' + item.used + (item.unit ? ' ' + item.unit : '') : null,
                    item.extra]
                    .filter(Boolean).join(' · ');
            statusNode.appendChild(dialogNode('div', 'ai-usage-test-row', text || '（空条目）'));
        }
    }

    // OAuth 登录框：provider 选择后显示登录状态 + 用户名/密码 + 登录/登出。
    // 密码只在点登录时经绑定传给 Go 引擎（JWE 加密后发），不进配置、不落盘。
    function buildOAuthLoginBox(providerID) {
        const box = section('控制台登录');
        const oauth = extras.oauth;
        if (!oauth) {
            box.appendChild(dialogNode('div', 'ai-usage-hint', '当前版本不支持 OAuth 登录（后端绑定缺失）'));
            return box;
        }
        const statusLine = dialogNode('div', 'ai-usage-hint', '读取登录状态…');
        box.appendChild(statusLine);
        const refreshStatus = async () => {
            try {
                const status = await oauth.status(providerID);
                statusLine.textContent = status.error
                    ? '状态读取失败：' + status.error
                    : (status.loggedIn
                        ? '已登录' + (status.username ? '（' + status.username + '）' : '') +
                          (status.canRenew
                            ? ' · 到期自动续期，无需重新登录'
                            : status.expiresAt
                                ? ' · 当前令牌至 ' + new Date(status.expiresAt * 1000).toLocaleString() + '（无续期凭据，到期需重登）'
                                : '')
                        : '未登录——填账号密码点「登录」');
                return status;
            } catch (e) {
                statusLine.textContent = '状态读取失败：' + ((e && e.message) || e);
                return null;
            }
        };
        const userCtl = createInput({placeholder: '控制台账号', spellcheck: false, autocomplete: 'username'});
        const passCtl = createInput({type: 'password', placeholder: '密码（只用于本次登录）', autocomplete: 'current-password'});
        box.appendChild(fieldRow('账号', userCtl.control));
        box.appendChild(fieldRow('密码', passCtl.control));
        const loginBtn = dialogButton('登录', 'dlg-btn', async () => {
            loginBtn.disabled = true;
            loginBtn.textContent = '登录中…';
            try {
                const result = await oauth.login(providerID, userCtl.control.value, passCtl.control.value);
                statusLine.textContent = result.ok
                    ? '登录成功' + (result.username ? '（' + result.username + '）' : '')
                    : '登录失败：' + (result.error || '未知错误');
                if (result.ok) {
                    passCtl.control.value = ''; // 成功后清掉密码框
                    flash('OAuth 控制台登录成功，可以测试脚本并保存配置了');
                }
            } finally {
                loginBtn.disabled = false;
                loginBtn.textContent = '登录';
            }
        });
        const logoutBtn = dialogButton('登出', 'dlg-btn', async () => {
            const err = await oauth.logout(providerID);
            statusLine.textContent = err ? '登出失败：' + err : '已登出';
        });
        const refreshBtn = dialogButton('刷新状态', 'dlg-btn', () => refreshStatus());
        const row = dialogNode('div', 'ai-usage-secret');
        row.append(loginBtn, logoutBtn, refreshBtn);
        box.appendChild(row);
        refreshStatus(); // 打开时异步读状态（不阻塞 UI 构建）
        return box;
    }

    // 模板字段区（切模板 / 套餐时整块重建）。
    function buildTemplateFields() {
        const draft = state.draft;
        const box = section('凭证与字段');
        if (draft.template === 'official') {
            box.appendChild(dialogNode('div', 'ai-usage-hint',
                '使用内置官方查询（DeepSeek / OpenRouter / SiliconFlow），按账号 Base URL 的域名匹配；' +
                '其他服务商请选脚本模板。'));
            return box;
        }
        if (draft.template === 'plan') {
            box.appendChild(dialogNode('div', 'ai-usage-hint', '自动使用账号的 API Key 和 Base URL 查询套餐额度'));
            box.appendChild(chipsRow(
                USAGE_PLAN_PRESETS.map((item) => ({value: item.id, label: item.label})),
                draft.planProvider,
                (value) => {
                    state.draft.planProvider = value;
                    openDialog(); // 重建字段区（plan 专属 extraFields 跟着套餐走）
                },
            ));
        }
        if (draft.template === 'oauth') {
            box.appendChild(dialogNode('div', 'ai-usage-hint',
                'OAuth 模板用控制台账号登录取 token（不是 API Key）；登录后自动续期，额度随预设脚本解析。'));
            box.appendChild(chipsRow(
                USAGE_OAUTH_PROVIDERS.map((item) => ({value: item.id, label: item.label})),
                draft.planProvider,
                (value) => {
                    state.draft.planProvider = value;
                    openDialog(); // 重建字段区（登录状态按 provider 重新读）
                },
            ));
            box.appendChild(buildOAuthLoginBox(draft.planProvider));
            // OAuth 模板不用账号的 apiKey / baseUrl，直接返回（不往下走通用覆盖字段）
            return {fields: box};
        }
        if (draft.template === 'newapi') {
            for (const field of USAGE_NEWAPI_FIELDS) {
                const {control} = createInput({
                    value: String(draft.extraFields[field.key] || ''),
                    placeholder: field.placeholder,
                    spellcheck: false,
                    onInput: (event) => {
                        state.draft.extraFields[field.key] = event.target.value;
                    },
                });
                box.appendChild(fieldRow(field.label, control));
            }
        }
        if (draft.template === 'plan' && draft.planProvider === 'zhipu_team') {
            for (const field of USAGE_PLAN_FIELDS.zhipu_team) {
                const {control} = createInput({
                    value: String(draft.extraFields[field.key] || ''),
                    placeholder: field.placeholder,
                    spellcheck: false,
                    onInput: (event) => {
                        state.draft.extraFields[field.key] = event.target.value;
                    },
                });
                box.appendChild(fieldRow(field.label, control));
            }
        }
        // 通用 / NewAPI / Sub2API / Token Plan / 自定义：凭证覆盖（留空用账号的）
        if (draft.template !== 'newapi' && draft.template !== 'oauth') {
            box.appendChild(fieldRow('API Key（可选）',
                secretInput(draft.apiKey, '留空则使用账号的 API Key', (value) => {
                    state.draft.apiKey = value;
                })));
        }
        if (draft.template !== 'plan' && draft.template !== 'oauth' || draft.template === 'plan' && (draft.planProvider === 'kimi' || draft.planProvider === 'zenmux')) {
            const {control} = createInput({
                value: draft.baseUrl,
                placeholder: '留空则使用账号的 Base URL',
                spellcheck: false,
                onInput: (event) => {
                    state.draft.baseUrl = event.target.value;
                },
            });
            box.appendChild(fieldRow('请求地址（可选）', control));
        }
        if (draft.template === 'custom') {
            const scriptBox = section('提取器代码');
            scriptBox.appendChild(fieldRow('', scriptTextarea(draftScriptOf(draft)),
                '返回对象需包含剩余额度等字段（extractor 在隔离沙箱执行，无网络与宿主 API）'));
            const help = dialogNode('details', 'ai-usage-help');
            help.appendChild(dialogNode('summary', '', '脚本编写说明'));
            for (const line of USAGE_SCRIPT_HELP) {
                help.appendChild(dialogNode('div', 'ai-usage-help-line', line));
            }
            scriptBox.appendChild(help);
            return {fields: box, scriptBox};
        }
        return {fields: box};
    }
    function buildDialogNodes() {
        const draft = state.draft;
        const profile = getConfig().profiles.find((item) => item.id === state.profileId);
        const body = dialogNode('div', 'ai-usage-dialog-body');

        const enableSection = section('');
        const {element: switchEl, control: enableControl} = createSwitch({
            checked: draft.enabled,
            onChange: (event) => {
                state.draft.enabled = event.target.checked;
            },
        });
        const enableRow = dialogNode('div', 'ai-usage-enable-row');
        enableRow.append(dialogNode('span', 'ai-usage-enable-label', '启用用量查询'), switchEl);
        enableSection.appendChild(enableRow);
        enableControl.checked = draft.enabled;
        body.appendChild(enableSection);

        const templateSection = section('预设模板');
        templateSection.appendChild(chipsRow(
            USAGE_TEMPLATE_KEYS.map((key) => ({value: key, label: USAGE_TEMPLATE_LABELS[key]})),
            draft.template,
            (value) => {
                // 切模板不清 draft.code：预设模板运行时走预设表（code 只在 custom 用），
                // 清空会让「custom → 其他 → custom」丢掉已写脚本
                state.draft.template = value;
                openDialog();
            },
        ));
        body.appendChild(templateSection);

        const statusNode = dialogNode('div', 'ai-usage-testbox hidden');
        const templateFields = buildTemplateFields();
        if (templateFields.fields) body.appendChild(templateFields.fields);
        if (templateFields.scriptBox) body.appendChild(templateFields.scriptBox);

        const timing = section('查询节奏');
        timing.appendChild(fieldRow('超时时间（秒）',
            numberInput(draft.timeoutSec, 5, 60, (value) => {
                state.draft.timeoutSec = Number(value) || 10;
            })));
        timing.appendChild(fieldRow('自动查询间隔（分钟，0 表示不自动查询）',
            numberInput(draft.autoIntervalMin, 0, 1440, (value) => {
                state.draft.autoIntervalMin = Number(value) || 0;
            })));
        body.appendChild(timing);
        body.appendChild(statusNode);

        const testBtn = dialogButton('测试脚本', 'dlg-btn', async () => {
            testBtn.disabled = true;
            testBtn.textContent = '测试中…';
            try {
                const snapshot = await extras.testUsageConfig(profile, state.draft);
                renderStatus(statusNode, snapshot);
            } finally {
                testBtn.disabled = false;
                testBtn.textContent = '测试脚本';
            }
        });
        const cancelBtn = dialogButton('取消', 'dlg-btn', () => {
            state = null;
            closeAIDialog();
        });
        const saveBtn = dialogButton('保存配置', 'dlg-btn primary', () => {
            const target = getConfig().profiles.find((item) => item.id === state.profileId);
            if (!target) {
                flash('账号不存在，配置未保存', true);
                return;
            }
            target.usage = normalizeUsageConfig(state.draft);
            saveAIConfig();
            state = null;
            closeAIDialog();
            extras.refreshSettingsPane();
            extras.renderModelList();
            // 外显开关 / 启用状态变了：立即刷新 composer 胶囊
            if (typeof extras.onUsageQuotaUpdated === 'function') extras.onUsageQuotaUpdated();
            flash(target.usage.enabled
                ? '已启用「' + (target.name || '账号') + '」的用量查询'
                : '已保存「' + (target.name || '账号') + '」的用量配置（未启用）');
        });

        return {body, footer: [testBtn, cancelBtn, saveBtn]};
    }

    function openDialog() {
        if (!state) return;
        const profile = getConfig().profiles.find((item) => item.id === state.profileId);
        if (!profile) return;
        const nodes = buildDialogNodes();
        openAIDialog('配置用量查询 · ' + (profile.name || '未命名账号'), [nodes.body], nodes.footer, {top: true, wide: true});
    }

    function openUsageConfigDialog(profileId) {
        const profile = getConfig().profiles.find((item) => item.id === profileId);
        if (!profile) return;
        state = {profileId, draft: normalizeUsageConfig(profile.usage)};
        if (!state.draft.code && state.draft.template === 'custom') {
            // 自定义模板首开给一份通用底稿，可改可清
            state.draft.code = usageTemplatePresetCode('custom');
        }
        openDialog();
    }

    return {openUsageConfigDialog};
}
