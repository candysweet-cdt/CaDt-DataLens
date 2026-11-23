// AI 设置 → 导入导出：配置导出（可选是否含密钥）与导入（合并/覆盖、旧格式兼容）。
// 从 ai-settings-dialog.js 拆出；renderModelList / refreshPromptSettings / aiAddUnique 等由兄弟模块注入。
import {
    findModelEntry, resolveModelId, resolveModelRef, subAgentModelChoicesFrom,
} from '../core/ai-config-model.js';
import {
    AI_PREF_LIMIT, AI_PREF_TEXT_LIMIT, aiClamp, aiClampInt, aiNowId, aiTextOf,
} from '../core/ai-constants.js';
import {
    normalizeDefaultScope,
} from '../security/ai-permissions.js';
import {
    normalizeGenModel,
} from '../gen/ai-gen-model.js';
import {
    normalizePersona,
} from '../core/ai-persona.js';

export function createAISettingsIO(ctx, extras) {

    const opt = ctx.opt;
    const flash = ctx.flash;
    const backend = ctx.backend;
    const readTextFile = ctx.readTextFile;
    const isOpen = ctx.isOpen;
    const saveAIConfig = ctx.saveAIConfig;
    const renderMessages = ctx.renderMessages;
    const updateComposerState = ctx.updateComposerState;
    const renderProfileSelect = ctx.renderProfileSelect;
    const normalizeProfile = ctx.normalizeProfile;
    const promptById = ctx.promptById;
    const invalidateSkillsCache = ctx.invalidateSkillsCache;
    const getConfig = ctx.getConfig;

    // scope: 'accounts' = 只导账号模型（profiles + genModels，供模型面板）；
    //        'all'      = 导出整份 AI 配置（含其他面板设置，供 AI 助手面板）。
    function exportAIConfig(scope) {
        const includeKeys = !!(opt.exportKeys && opt.exportKeys.checked);
        // 个性化含用户称呼 / 长期指令 / 人设正文，属个人内容：默认不导出，显式勾选才带
        const includePersona = !!(opt.exportPersona && opt.exportPersona.checked);
        const all = scope !== 'accounts';
        const data = {
            version: 1,
            exportedAt: new Date().toISOString(),
            scope: all ? 'all' : 'accounts',
            profiles: getConfig().profiles.map((profile) => ({
                ...profile,
                apiKey: includeKeys ? profile.apiKey : '',
                // 额度查询的覆盖密钥与账号 apiKey 同一脱敏语义（随 includeKeys 开关）
                usage: profile.usage ? {...profile.usage, apiKey: includeKeys ? profile.usage.apiKey : ''} : profile.usage,
            })),
            // 生成条目（生图/视频）：密钥与账号 apiKey 同一脱敏语义
            genModels: (getConfig().genModels || []).map((entry) => ({
                ...entry,
                apiKey: includeKeys ? entry.apiKey : '',
            })),
        };
        if (all) Object.assign(data, {
            prompts: getConfig().prompts.map((prompt) => ({
                id: prompt.id,
                name: prompt.name,
                content: prompt.content,
                builtin: !!prompt.builtin,
            })),
            activePromptId: getConfig().activePromptId,
            preferences: getConfig().preferences.map((pref) => ({
                id: pref.id,
                text: pref.text,
                source: pref.source,
                createdAt: pref.createdAt,
            })),
            memoryMode: getConfig().memoryMode,
            defaultScope: getConfig().defaultScope,
            approvedPaths: getConfig().approvedPaths,
            approvedReadRoots: getConfig().approvedReadRoots,
            disabledSkills: getConfig().disabledSkills,
            hiddenSkills: getConfig().hiddenSkills,
            skillIndexMaxUser: getConfig().skillIndexMaxUser,
            autoCompactThreshold: getConfig().autoCompactThreshold,
            autoCompact: getConfig().autoCompact,
            autoTitle: getConfig().autoTitle !== false,
            autoClassifier: getConfig().autoClassifier === true,
            autoClassifierModel: getConfig().autoClassifierModel || '',
            outputLanguage: getConfig().outputLanguage || 'zh',
            logEnabled: getConfig().logEnabled !== false,
            worklogEnabled: getConfig().worklogEnabled !== false,
            subAgentMax: getConfig().subAgentMax,
            subAgentMaxDepth: getConfig().subAgentMaxDepth,
            subAgentRounds: getConfig().subAgentRounds,
            subAgentModel: getConfig().subAgentModel || '',
            subAgentModelChoices: (getConfig().subAgentModelChoices || []).slice(),
            notifyInApp: getConfig().notifyInApp === true,
            notifySystem: getConfig().notifySystem === true,
            notifyFinish: getConfig().notifyFinish !== false,
            notifyError: getConfig().notifyError !== false,
            notifyAsk: getConfig().notifyAsk !== false,
            notifyApprove: getConfig().notifyApprove !== false,
            notifySound: getConfig().notifySound !== false,
            askTimeout: getConfig().askTimeout,
            askTimeoutAction: getConfig().askTimeoutAction,
            idleTimeoutSec: getConfig().idleTimeoutSec,
        });
        if (includePersona) data.persona = normalizePersona(getConfig().persona);
        const json = JSON.stringify(data, null, 2);
        const defaultName = all ? 'cadt-ai-config.json' : 'cadt-ai-accounts.json';
        const title = all ? '导出 AI 配置' : '导出账号模型';
        const save = async () => {
            let path = '';
            if (backend.ShowSaveFileDialog) path = await backend.ShowSaveFileDialog(title, defaultName, '*.json');
            else if (backend.SaveFileDialog) path = await backend.SaveFileDialog(defaultName);
            else throw new Error('当前版本不支持保存对话框');
            if (!path) {
                flash('已取消导出');
                return;
            }
            await backend.SaveFile(path, json, 'lf', false, 'utf-8');
            flash('AI 配置已导出：' + path);
        };
        save().catch((e) => flash('导出失败：' + ((e && e.message) || e), true));
    }

    // scope: 'accounts' = 只合并账号模型（供模型面板）；'all' = 合并整份 AI 配置。
    // 两个入口都按 scope 决定合并范围，与文件里实际有哪些字段解耦，行为可预期。
    async function importAIConfig(scope) {
        const all = scope !== 'accounts';
        if (!backend.ShowOpenFileDialog) {
            flash('当前版本不支持导入对话框', true);
            return;
        }
        try {
            const path = await backend.ShowOpenFileDialog(all ? '导入 AI 配置' : '导入账号模型', '*.json');
            if (!path) {
                flash('已取消导入');
                return;
            }
            const read = await readTextFile(path, 4 << 20);
            const data = JSON.parse(read.text);
            if (!data || typeof data !== 'object') throw new Error('配置格式无效');
            let importedProfiles = 0;
            for (const raw of Array.isArray(data.profiles) ? data.profiles : []) {
                const profile = normalizeProfile(raw, getConfig().profiles.length);
                if (!profile) continue;
                const existing = getConfig().profiles.find((item) => item.id === profile.id);
                if (existing) {
                    const keepKey = existing.apiKey;
                    // 额度覆盖密钥与主 key 同语义：导入空值时保留本机旧值（脱敏导出的配置能无损回灌）
                    const keepUsageKey = existing.usage && existing.usage.apiKey;
                    Object.assign(existing, profile);
                    if (!profile.apiKey) existing.apiKey = keepKey;
                    if (keepUsageKey && (!existing.usage || !existing.usage.apiKey)) {
                        existing.usage = {...existing.usage, apiKey: keepUsageKey};
                    }
                } else {
                    getConfig().profiles.push(profile);
                }
                importedProfiles++;
            }
            if (all) {
                for (const raw of Array.isArray(data.prompts) ? data.prompts : []) {
                if (!raw || !aiTextOf(raw.id) || !aiTextOf(raw.content).trim()) continue;
                if (String(raw.id).startsWith('builtin-')) continue;
                const existing = getConfig().prompts.find((item) => item.id === raw.id);
                if (existing) {
                    if (existing.builtin) continue;
                    existing.name = aiTextOf(raw.name) || existing.name;
                    existing.content = aiTextOf(raw.content);
                } else {
                    getConfig().prompts.push({
                        id: aiTextOf(raw.id),
                        name: aiTextOf(raw.name) || '导入模板',
                        content: aiTextOf(raw.content),
                        builtin: false,
                    });
                }
            }
            if (data.activePromptId && promptById(aiTextOf(data.activePromptId))) {
                getConfig().activePromptId = aiTextOf(data.activePromptId);
            }
            for (const raw of Array.isArray(data.preferences) ? data.preferences : []) {
                if (!raw || typeof raw !== 'object') continue;
                const text = aiTextOf(raw.text).trim().slice(0, AI_PREF_TEXT_LIMIT);
                if (!text) continue;
                if (getConfig().preferences.some((pref) => pref.text === text)) continue;
                if (getConfig().preferences.length >= AI_PREF_LIMIT) break;
                getConfig().preferences.push({
                    id: aiTextOf(raw.id) || aiNowId('pref-'),
                    text,
                    source: raw.source === 'ai' ? 'ai' : 'user',
                    createdAt: Number(raw.createdAt) || Date.now(),
                    updatedAt: Number(raw.createdAt) || Date.now(),
                });
            }
            if (data.memoryMode === 'app' || data.memoryMode === 'workspace') getConfig().memoryMode = data.memoryMode;
            getConfig().defaultScope = normalizeDefaultScope(data.defaultScope);
            if (Number.isFinite(Number(data.autoCompactThreshold))) {
                getConfig().autoCompactThreshold = aiClamp(Number(data.autoCompactThreshold), 0.5, 0.95);
            }
            if (typeof data.autoCompact === 'boolean') getConfig().autoCompact = data.autoCompact;
            if (typeof data.autoTitle === 'boolean') getConfig().autoTitle = data.autoTitle;
            if (typeof data.autoClassifier === 'boolean') getConfig().autoClassifier = data.autoClassifier;
            getConfig().autoClassifierModel = resolveModelRef(
                aiTextOf(data.autoClassifierModel), getConfig().profiles);
            if (['zh', 'en', 'auto'].includes(data.outputLanguage)) getConfig().outputLanguage = data.outputLanguage;
            if (typeof data.logEnabled === 'boolean') getConfig().logEnabled = data.logEnabled;
            if (typeof data.worklogEnabled === 'boolean') getConfig().worklogEnabled = data.worklogEnabled;
            getConfig().subAgentMax = aiClampInt(data.subAgentMax, 1, 20, getConfig().subAgentMax);
            getConfig().subAgentMaxDepth = aiClampInt(data.subAgentMaxDepth, 0, 20, getConfig().subAgentMaxDepth);
            getConfig().subAgentRounds = aiClampInt(data.subAgentRounds, 3, 200, getConfig().subAgentRounds);
            getConfig().subAgentModel = resolveModelRef(aiTextOf(data.subAgentModel), getConfig().profiles);
            // 自选候选：**字段缺失时保留本地**（导出方没开这项不代表要关掉本地的），
            // 有字段则逐条校验，失效引用剔掉
            if (Array.isArray(data.subAgentModelChoices)) {
                getConfig().subAgentModelChoices = data.subAgentModelChoices
                    .map((ref) => resolveModelRef(aiTextOf(ref), getConfig().profiles))
                    .filter(Boolean)
                    .slice(0, 3);
            }
            for (const key of ['notifyInApp', 'notifySystem', 'notifyFinish', 'notifyError', 'notifyAsk', 'notifyApprove', 'notifySound']) {
                if (typeof data[key] === 'boolean') getConfig()[key] = data[key];
            }
            if (Number.isFinite(Number(data.askTimeout))) getConfig().askTimeout = aiClampInt(data.askTimeout, 0, 3600, 300);
            if (['recommended', 'wait', 'abort', 'ai_decide'].includes(data.askTimeoutAction)) {
                getConfig().askTimeoutAction = data.askTimeoutAction;
            }
            if (Number.isFinite(Number(data.idleTimeoutSec))) {
                getConfig().idleTimeoutSec = aiClampInt(data.idleTimeoutSec, 30, 3600, 120);
            }
            // 个性化：字段级合并——导出时未勾选「含个性化设定」的旧文件不会冲掉本地设定
            if (data.persona && typeof data.persona === 'object') {
                getConfig().persona = normalizePersona(data.persona);
            }
            }
            // 生成条目：按 id 合并（同 id 空密钥不覆盖本地，与账号语义一致）
            let importedGenModels = 0;
            for (const raw of Array.isArray(data.genModels) ? data.genModels : []) {
                if (!raw || typeof raw !== 'object') continue;
                const entry = normalizeGenModel(raw, () => aiNowId('gen-'));
                const existing = (getConfig().genModels || []).find((item) => item.id === entry.id);
                if (existing) {
                    const keepKey = existing.apiKey;
                    Object.assign(existing, entry);
                    if (!entry.apiKey) existing.apiKey = keepKey;
                } else {
                    getConfig().genModels = (getConfig().genModels || []).concat([entry]);
                }
                importedGenModels++;
            }
            if (importedGenModels) extras.refreshSettingsPane();
            if (!getConfig().profiles.some((profile) => profile.id === getConfig().activeProfileId)) {
                getConfig().activeProfileId = getConfig().profiles[0] ? getConfig().profiles[0].id : '';
            }
            const activeAccount = getConfig().profiles.find((profile) => profile.id === getConfig().activeProfileId);
            if (activeAccount) {
                if (!findModelEntry(activeAccount, getConfig().activeModelId)) {
                    getConfig().activeModelId = resolveModelId(activeAccount, activeAccount.lastModelId, '');
                }
            } else {
                getConfig().activeModelId = '';
            }
            if (all) {
                for (const pathValue of Array.isArray(data.approvedPaths) ? data.approvedPaths : []) {
                    extras.aiAddUnique(getConfig().approvedPaths, pathValue);
                }
                for (const rootValue of Array.isArray(data.approvedReadRoots) ? data.approvedReadRoots : []) {
                    extras.aiAddUnique(getConfig().approvedReadRoots, rootValue);
                }
                for (const name of Array.isArray(data.disabledSkills) ? data.disabledSkills : []) {
                    extras.aiAddUnique(getConfig().disabledSkills, name);
                }
                for (const name of Array.isArray(data.hiddenSkills) ? data.hiddenSkills : []) {
                    extras.aiAddUnique(getConfig().hiddenSkills, name);
                }
                if (Number.isFinite(Number(data.skillIndexMaxUser))) {
                    getConfig().skillIndexMaxUser = aiClampInt(data.skillIndexMaxUser, 1, 100, 100);
                }
                getConfig().autoClassifierModel = resolveModelRef(getConfig().autoClassifierModel, getConfig().profiles);
                getConfig().subAgentModel = resolveModelRef(getConfig().subAgentModel, getConfig().profiles);
                getConfig().subAgentModelChoices = subAgentModelChoicesFrom(
                    getConfig().subAgentModelChoices, getConfig().profiles).map((choice) => choice.ref).slice(0, 3);
                invalidateSkillsCache();
                extras.refreshSettingsPane();
                extras.refreshChatSettings();
                extras.refreshPromptSettings();
            }
            saveAIConfig();
            renderProfileSelect();
            updateComposerState();
            extras.renderModelList();
            if (isOpen()) renderMessages(true);
            extras.setSettingsStatus('已导入 ' + importedProfiles + ' 个模型账号' + (all ? '及 AI 配置' : ''), 'ok');
        } catch (e) {
            flash('导入失败：' + ((e && e.message) || e), true);
        }
    }

    // 账号级字段写入口（模型级字段走 extras.editorEntryOf + 各自 handler）

    return {
        // 全量导出/导入（AI 助手面板）
        exportAIConfig: () => exportAIConfig('all'),
        importAIConfig: () => importAIConfig('all'),
        // 仅账号模型导出/导入（模型面板）
        exportAccountModels: () => exportAIConfig('accounts'),
        importAccountModels: () => importAIConfig('accounts'),
    };
}
