import test from 'node:test';
import assert from 'node:assert/strict';
import {AI_PERSONA_TANGERINE, PERSONA_INSTRUCTION_MAX, normalizePersona} from '../../../src/ai/core/ai-persona.js';

// 极简 DOM 桩：本模块只在工厂期取 element、在事件里读写 value，不需要真 DOM。
function makeEl() {
    const listeners = new Map();
    return {
        value: '',
        textContent: '',
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        },
        dispatch(type) {
            for (const fn of listeners.get(type) || []) fn({type});
        },
        getClientRects() { return [{width: 120, height: 20}]; },
    };
}

function setup() {
    const ids = [
        'ai-persona-user-label', 'ai-persona-name', 'ai-persona-name-hint', 'ai-persona-style',
        'ai-persona-instructions', 'ai-persona-instructions-count', 'ai-persona-text',
        'ai-persona-text-count', 'ai-persona-text-load', 'ai-persona-text-clear',
        'ai-persona-memory-mode', 'ai-persona-memory-preview', 'ai-persona-memory-open', 'ai-persona-reset',
    ];
    const els = {};
    for (const id of ids) els[id] = makeEl();
    globalThis.document = {
        getElementById: (id) => els[id] || null,
        querySelector: () => null,
    };

    const config = {persona: normalizePersona(null), preferences: [{id: 'p1', text: 'keep'}], memoryMode: 'workspace'};
    const logs = [];
    const statuses = [];
    const saved = [];
    const memoryOpenCalls = [];
    let confirmCallback = null;
    const deps = {
        getConfig: () => config,
        saveAIConfig: () => saved.push(JSON.stringify(config.persona)),
        readTextFile: async () => ({text: '# 记忆\n- 用户偏好简洁回答'}),
        resolveMemoryDir: async () => ({dir: 'D:/ws/.cadt/memory', mode: 'workspace'}),
        showMemoryDialog: async (options) => { memoryOpenCalls.push(options); },
        aiJoinPath: (a, b) => a + '/' + b,
        flash: () => {},
        askConfirm: (msg, action) => { confirmCallback = action; },
        currentSession: () => null,
        renderMessages: () => {},
        assistantName: () => config.persona.assistantName.custom || '甜澄',
        activity: {log: (action, target) => logs.push([action, target])},
    };
    return {els, config, logs, statuses, saved, deps, memoryOpenCalls, fireConfirm: () => confirmCallback && confirmCallback()};
}

const modPath = '../../../src/ai/core/ai-personalization-ui.js';
const {createAIPersonalizationSettings} = await import(modPath);

test('渲染：输入框 / 下拉 / 字数 / 记忆摘要都填上当前值与预览', async () => {
    const {els, config, deps} = setup();
    config.persona = normalizePersona({
        assistantName: {custom: '小橘'},
        userLabel: '老板',
        replyStyle: 'friendly',
        personaText: '你是审稿人。',
        customInstructions: '先给结论。',
    });
    const mod = createAIPersonalizationSettings(deps, {setSettingsStatus: () => {}});
    mod.refreshPersonalizationPane();
    assert.equal(els['ai-persona-name'].value, '小橘');
    assert.equal(els['ai-persona-user-label'].value, '老板');
    assert.equal(els['ai-persona-style'].value, 'friendly');
    assert.equal(els['ai-persona-text'].value, '你是审稿人。');
    assert.equal(els['ai-persona-instructions'].value, '先给结论。');
    assert.equal(els['ai-persona-text-count'].textContent, '6 / 4096');
    assert.equal(els['ai-persona-instructions-count'].textContent, '5 / 2048');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(els['ai-persona-memory-preview'].textContent, /用户偏好简洁回答/);
    assert.match(els['ai-persona-memory-mode'].textContent, /工作区/);
});

test('改名：只写 config.assistantName.custom，留痕只记字段名', () => {
    const {els, config, logs, deps} = setup();
    const mod = createAIPersonalizationSettings(deps, {setSettingsStatus: () => {}});
    mod.refreshPersonalizationPane();
    els['ai-persona-name'].value = '小橘';
    els['ai-persona-name'].dispatch('input');
    assert.equal(config.persona.assistantName.custom, '小橘');
    els['ai-persona-name'].dispatch('change');
    assert.deepEqual(logs.at(-1), ['persona.change', 'assistantName']);
    assert.ok(!JSON.stringify(logs).includes('小橘'), '留痕里不出现用户正文');
});

test('超长输入按上限截断（不靠 maxlength 兜底）', () => {
    const {els, config, deps} = setup();
    const mod = createAIPersonalizationSettings(deps, {setSettingsStatus: () => {}});
    mod.refreshPersonalizationPane();
    els['ai-persona-instructions'].value = 'x'.repeat(PERSONA_INSTRUCTION_MAX + 100);
    els['ai-persona-instructions'].dispatch('input');
    assert.equal(config.persona.customInstructions.length, PERSONA_INSTRUCTION_MAX);
    assert.equal(els['ai-persona-instructions-count'].textContent, PERSONA_INSTRUCTION_MAX + ' / ' + PERSONA_INSTRUCTION_MAX);
});

test('风格切换：写入 replyStyle 并给出「下一条消息起生效」状态', () => {
    const {els, config, deps} = setup();
    const statuses = [];
    const mod = createAIPersonalizationSettings(deps, {setSettingsStatus: (text, kind) => statuses.push([text, kind])});
    mod.refreshPersonalizationPane();
    els['ai-persona-style'].value = 'tangerine';
    els['ai-persona-style'].dispatch('change');
    assert.equal(config.persona.replyStyle, 'tangerine');
    assert.match(statuses.at(-1)[0], /甜澄/);
});

test('载入 / 清空人设：直接改 personaText，风格不受影响', () => {
    const {els, config, deps} = setup();
    const mod = createAIPersonalizationSettings(deps, {setSettingsStatus: () => {}});
    mod.refreshPersonalizationPane();
    els['ai-persona-text-load'].dispatch('click');
    assert.equal(config.persona.personaText, AI_PERSONA_TANGERINE);
    assert.equal(els['ai-persona-text'].value, AI_PERSONA_TANGERINE);
    assert.equal(config.persona.replyStyle, 'default', '载入人设不改回复风格');
    els['ai-persona-text-clear'].dispatch('click');
    assert.equal(config.persona.personaText, '');
    assert.equal(els['ai-persona-text'].value, '');
});

test('恢复默认：四项复位，不动记忆模式与用户偏好', () => {
    const {els, config, deps, fireConfirm} = setup();
    config.persona = normalizePersona({
        assistantName: {custom: '小橘'}, userLabel: '老板', replyStyle: 'snarky',
        personaText: '人设', customInstructions: '指令',
    });
    const mod = createAIPersonalizationSettings(deps, {setSettingsStatus: () => {}});
    mod.refreshPersonalizationPane();
    els['ai-persona-reset'].dispatch('click');
    fireConfirm();
    assert.equal(config.persona.assistantName.custom, '');
    assert.equal(config.persona.userLabel, '');
    assert.equal(config.persona.replyStyle, 'default');
    assert.equal(config.persona.personaText, '');
    assert.equal(config.persona.customInstructions, '');
    assert.equal(config.memoryMode, 'workspace');
    assert.deepEqual(config.preferences, [{id: 'p1', text: 'keep'}]);
    assert.equal(els['ai-persona-name'].value, '');
    assert.equal(els['ai-persona-text-count'].textContent, '0 / 4096');
});

test('重复初始化只绑定一次：不会重复派发保存', () => {
    const {els, config, logs, deps} = setup();
    const mod = createAIPersonalizationSettings(deps, {setSettingsStatus: () => {}});
    mod.refreshPersonalizationPane();
    mod.refreshPersonalizationPane();
    mod.refreshPersonalizationPane();
    els['ai-persona-user-label'].value = '老板';
    els['ai-persona-user-label'].dispatch('input');
    const count = logs.filter((entry) => entry[1] === 'userLabel').length;
    assert.equal(count, 1);
    assert.equal(config.persona.userLabel, '老板');
});

test('打开记忆管理：从设置窗打开必须传 top:true 盖住设置窗', async () => {
    const {els, deps, memoryOpenCalls} = setup();
    const mod = createAIPersonalizationSettings(deps, {setSettingsStatus: () => {}});
    mod.refreshPersonalizationPane();
    els['ai-persona-memory-open'].dispatch('click');
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(memoryOpenCalls.length, 1, '应调用一次 showMemoryDialog');
    assert.deepEqual(memoryOpenCalls[0], {top: true}, '从设置窗打开必须传 top:true，弹窗才能盖住设置窗');
});
