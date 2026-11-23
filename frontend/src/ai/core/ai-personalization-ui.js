// ai-personalization-ui.js：设置 → AI → 个性化（称呼 / 助手名 / 回复风格 / 人设 / 长期指令 / 记忆入口）。
// 自管本域 DOM 与事件绑定：不往 640 行的 bindSettingsPane 里塞新域逻辑，
// 首次 render 时幂等绑定一次，之后由 refreshSettingsPane / 导航点击驱动刷新。
// 纯逻辑（归一化 / 双语名字 / 段生成 / 转义）在 ai-persona.js，本文件只管界面与落盘。
import {
    AI_PERSONA_NAME_DEFAULTS, AI_PERSONA_TANGERINE, PERSONA_INSTRUCTION_MAX, PERSONA_LABEL_MAX,
    PERSONA_NAME_MAX, PERSONA_TEXT_MAX, normalizePersona,
} from './ai-persona.js';

// 摘要预览上限：与 <memory> 注入量级对齐（8 KiB），超出只显示开头。
const MEMORY_PREVIEW_MAX = 800;
const SAVE_DEBOUNCE_MS = 400;

export function createAIPersonalizationSettings(ctx, extras) {

    const getConfig = ctx.getConfig;
    const saveAIConfig = ctx.saveAIConfig;
    const readTextFile = ctx.readTextFile;
    const resolveMemoryDir = ctx.resolveMemoryDir;
    const showMemoryDialog = ctx.showMemoryDialog;
    const aiJoinPath = ctx.aiJoinPath;
    const flash = ctx.flash;
    const askConfirm = ctx.askConfirm;
    const currentSession = ctx.currentSession;
    const renderMessages = ctx.renderMessages;
    const assistantName = typeof ctx.assistantName === 'function' ? ctx.assistantName : () => AI_PERSONA_NAME_DEFAULTS.zh;
    const activity = ctx.activity && typeof ctx.activity.log === 'function' ? ctx.activity : null;
    const setSettingsStatus = extras.setSettingsStatus;

    const el = {
        label: document.getElementById('ai-persona-user-label'),
        name: document.getElementById('ai-persona-name'),
        nameHint: document.getElementById('ai-persona-name-hint'),
        style: document.getElementById('ai-persona-style'),
        instructions: document.getElementById('ai-persona-instructions'),
        instructionsCount: document.getElementById('ai-persona-instructions-count'),
        persona: document.getElementById('ai-persona-text'),
        personaCount: document.getElementById('ai-persona-text-count'),
        personaLoad: document.getElementById('ai-persona-text-load'),
        personaClear: document.getElementById('ai-persona-text-clear'),
        memoryMode: document.getElementById('ai-persona-memory-mode'),
        memoryPreview: document.getElementById('ai-persona-memory-preview'),
        memoryOpen: document.getElementById('ai-persona-memory-open'),
        reset: document.getElementById('ai-persona-reset'),
    };

    let bound = false;
    let saveTimer = 0;
    let memorySeq = 0;

    function personaOf() {
        const cfg = getConfig();
        if (!cfg.persona) cfg.persona = normalizePersona(null);
        return cfg.persona;
    }

    // 留痕只记字段名：称呼 / 指令 / 人设正文属个人内容，绝不进日志
    function logChange(field) {
        if (!activity) return;
        try { activity.log('persona.change', field, {}); } catch (e) {}
    }

    function scheduleSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = 0;
            saveAIConfig();
        }, SAVE_DEBOUNCE_MS);
    }

    function flushSave() {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = 0;
        }
        saveAIConfig();
    }

    // 空态副标题即时换名字；历史消息气泡保持渲染时的样子（不重绘历史）
    function refreshNameSurfaces() {
        const session = typeof currentSession === 'function' ? currentSession() : null;
        if (!session || !Array.isArray(session.messages) || !session.messages.length) {
            if (typeof renderMessages === 'function') {
                try { renderMessages(false); } catch (e) {}
            }
        }
    }

    function countText(value, max) {
        return String(value || '').length + ' / ' + max;
    }

    // 超长一律按上限截断，并把截断结果写回控件：用户看到的就是实际会生效的内容
    function clampInto(node, max) {
        const next = String((node && node.value) || '').slice(0, max);
        if (node && node.value !== next) node.value = next;
        return next;
    }

    function updateCounts() {
        if (el.instructionsCount) el.instructionsCount.textContent = countText(el.instructions && el.instructions.value, PERSONA_INSTRUCTION_MAX);
        if (el.personaCount) el.personaCount.textContent = countText(el.persona && el.persona.value, PERSONA_TEXT_MAX);
    }

    function defaultNameHint() {
        const en = getConfig().outputLanguage === 'en';
        const d = AI_PERSONA_NAME_DEFAULTS;
        return en
            ? '留空即用默认名：' + d.en + '（中文名 ' + d.zh + ' / 自称 ' + d.nickname + '）'
            : '留空即用默认名：' + d.zh + '（自称 ' + d.nickname + '），英文输出时用 ' + d.en;
    }

    async function refreshMemoryPreview() {
        if (!el.memoryPreview) return;
        const seq = ++memorySeq;
        el.memoryPreview.textContent = '读取中…';
        try {
            const mem = await resolveMemoryDir();
            if (seq !== memorySeq) return;
            if (el.memoryMode) el.memoryMode.textContent = mem.mode === 'workspace' ? '工作区 .cadt/memory' : '应用数据';
            const path = aiJoinPath ? aiJoinPath(mem.dir, 'MEMORY.md') : mem.dir + '/MEMORY.md';
            let text = '';
            try {
                const read = await readTextFile(path, 8 << 10);
                text = String((read && read.text) || '').trim();
            } catch (e) {
                // 文件不存在 / 读不到：显示空态，不静默吞错也不新建文件
                text = '';
            }
            if (seq !== memorySeq) return;
            if (!text) {
                el.memoryPreview.textContent = '（还没有记忆文件；点「打开记忆管理」添加，写入仍走 .cadt/memory）';
                return;
            }
            el.memoryPreview.textContent = text.length > MEMORY_PREVIEW_MAX
                ? text.slice(0, MEMORY_PREVIEW_MAX) + '\n…（仅预览前 ' + MEMORY_PREVIEW_MAX + ' 字符）'
                : text;
        } catch (e) {
            if (seq !== memorySeq) return;
            el.memoryPreview.textContent = '（记忆目录不可用：' + ((e && e.message) || e) + '）';
        }
    }

    // 记忆预览要读磁盘（两跳 IPC）：只在页面可见时读，切到本页时由导航点击 / refreshSettings 触发
    function paneVisible() {
        return !!(el.memoryPreview && el.memoryPreview.getClientRects().length);
    }

    function renderPersonalizationSettings(force) {
        const p = personaOf();
        if (el.label) el.label.value = p.userLabel || '';
        if (el.name) el.name.value = p.assistantName.custom || '';
        if (el.nameHint) el.nameHint.textContent = defaultNameHint();
        if (el.style) el.style.value = p.replyStyle || 'default';
        if (el.instructions) el.instructions.value = p.customInstructions || '';
        if (el.persona) el.persona.value = p.personaText || '';
        updateCounts();
        if (force || paneVisible()) refreshMemoryPreview();
    }

    function bind() {
        if (bound) return;
        bound = true;

        if (el.label) {
            el.label.addEventListener('input', () => {
                personaOf().userLabel = clampInto(el.label, PERSONA_LABEL_MAX);
                scheduleSave();
                logChange('userLabel');
            });
            el.label.addEventListener('change', flushSave);
        }

        if (el.name) {
            el.name.addEventListener('input', () => {
                personaOf().assistantName.custom = clampInto(el.name, PERSONA_NAME_MAX);
                scheduleSave();
                logChange('assistantName');
            });
            el.name.addEventListener('change', () => {
                flushSave();
                refreshNameSurfaces();
                if (setSettingsStatus) setSettingsStatus('助手名已更新：' + assistantName() + '（下一条消息起生效）', 'ok');
            });
        }

        if (el.style) {
            el.style.addEventListener('change', () => {
                personaOf().replyStyle = String(el.style.value || 'default');
                flushSave();
                logChange('replyStyle');
                // 甜澄风格会自动带内置人设；提示一句，免得以为只是换语气
                if (setSettingsStatus) {
                    setSettingsStatus(personaOf().replyStyle === 'tangerine'
                        ? '回复风格：甜澄（人设框为空时自动用内置甜澄人设）'
                        : '回复风格已更新（下一条消息起生效）', 'ok');
                }
            });
        }

        if (el.instructions) {
            el.instructions.addEventListener('input', () => {
                personaOf().customInstructions = clampInto(el.instructions, PERSONA_INSTRUCTION_MAX);
                updateCounts();
                scheduleSave();
                logChange('customInstructions');
            });
            el.instructions.addEventListener('change', flushSave);
        }

        if (el.persona) {
            el.persona.addEventListener('input', () => {
                personaOf().personaText = clampInto(el.persona, PERSONA_TEXT_MAX);
                updateCounts();
                scheduleSave();
                logChange('personaText');
            });
            el.persona.addEventListener('change', flushSave);
        }

        if (el.personaLoad) el.personaLoad.addEventListener('click', () => {
            if (el.persona) el.persona.value = AI_PERSONA_TANGERINE;
            personaOf().personaText = AI_PERSONA_TANGERINE;
            flushSave();
            logChange('personaText');
            updateCounts();
            if (setSettingsStatus) setSettingsStatus('已载入甜澄人设（与回复风格无关，长期生效）', 'ok');
        });

        if (el.personaClear) el.personaClear.addEventListener('click', () => {
            if (el.persona) el.persona.value = '';
            personaOf().personaText = '';
            flushSave();
            logChange('personaText');
            updateCounts();
            if (setSettingsStatus) setSettingsStatus('已清空人设框', 'ok');
        });

        if (el.memoryOpen) el.memoryOpen.addEventListener('click', () => {
            // 从设置窗打开：挂到 body 顶层盖住设置窗（openAIDialog 的 options.top）
            Promise.resolve(showMemoryDialog && showMemoryDialog({top: true}))
                .then(() => refreshMemoryPreview())
                .catch(() => {});
        });

        if (el.reset) el.reset.addEventListener('click', () => {
            askConfirm('恢复个性化默认设定？\n\n助手名回到「甜澄」、回复风格回到「默认」，并清空人设框与长期指令。\n长期记忆与用户偏好不受影响。', () => {
                getConfig().persona = normalizePersona(null);
                flushSave();
                logChange('reset');
                renderPersonalizationSettings();
                refreshNameSurfaces();
                if (setSettingsStatus) setSettingsStatus('已恢复默认个性化设定', 'ok');
                else if (flash) flash('已恢复默认个性化设定');
            }, '恢复默认', '恢复个性化默认设定');
        });

        // 导航切到本页时重绘：外部（主窗口另一处 / 导入配置）改过也能看到最新值
        const navBtn = document.querySelector('.snav-item[data-pane="persona"]');
        if (navBtn) navBtn.addEventListener('click', () => renderPersonalizationSettings());
    }

    // 首次渲染即完成绑定（由 refreshSettingsPane 在设置页初始化时调用）
    function ensureReady() {
        bind();
        renderPersonalizationSettings();
    }

    return {
        renderPersonalizationSettings,
        refreshPersonalizationPane: ensureReady,
    };
}
