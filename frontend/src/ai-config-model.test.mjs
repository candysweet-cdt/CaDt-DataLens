import test from 'node:test';
import assert from 'node:assert/strict';
import {
    clampNumber,
    configForModel,
    defaultModalities,
    formatTokenAmount,
    migrateAccountModels,
    modelEntryOf,
    modelRefLabel,
    normalizeModalities,
    normalizeModelEntry,
    parseTokenAmount,
    resolveModelRef,
} from './ai-config-model.js';

test('parseTokenAmount：支持 K / M / 纯数字 / 小数 / 千分位，非法返回 null', () => {
    assert.equal(parseTokenAmount('256K'), 262144);
    assert.equal(parseTokenAmount('131K'), 134144);
    assert.equal(parseTokenAmount('1M'), 1048576);
    assert.equal(parseTokenAmount('1.5M'), 1572864);
    assert.equal(parseTokenAmount('2m'), 2097152);
    assert.equal(parseTokenAmount('8k'), 8192);
    assert.equal(parseTokenAmount('4096'), 4096);
    assert.equal(parseTokenAmount(' 1,048,576 '), 1048576);
    assert.equal(parseTokenAmount(65536), 65536);
    assert.equal(parseTokenAmount(''), null);
    assert.equal(parseTokenAmount('abc'), null);
    assert.equal(parseTokenAmount('-5K'), null);
    assert.equal(parseTokenAmount('12KB'), null);
    assert.equal(parseTokenAmount('0'), null);
});

test('formatTokenAmount：整 K / M 用单位显示，否则原样', () => {
    assert.equal(formatTokenAmount(262144), '256K');
    assert.equal(formatTokenAmount(131072), '128K');
    assert.equal(formatTokenAmount(1048576), '1M');
    assert.equal(formatTokenAmount(1572864), '1536K', '不整除 1M 时退回 K 显示');
    assert.equal(formatTokenAmount(4096), '4K');
    assert.equal(formatTokenAmount(5000), '5000');
    assert.equal(formatTokenAmount(0), '');
    assert.equal(formatTokenAmount('bad'), '');
});

test('normalizeModalities：默认勾选文本+图像，非法输入收敛', () => {
    assert.deepEqual(normalizeModalities(null), defaultModalities());
    assert.deepEqual(normalizeModalities({}), {text: true, image: true, video: false, audio: false});
    assert.deepEqual(
        normalizeModalities({text: false, image: true, video: true, audio: 'yes'}),
        {text: false, image: true, video: true, audio: false});
});

test('normalizeModelEntry：字段 clamp 与回退', () => {
    const entry = normalizeModelEntry({
        id: 'm1',
        model: ' deepseek-chat ',
        contextWindow: '256K',
        outputWindow: 99999999,
        modalities: {image: false},
        reasoningEffort: 'ultra',
        thinkingBudget: 0,
    }, () => 'gen-1');
    assert.equal(entry.model, 'deepseek-chat');
    assert.equal(entry.contextWindow, 262144);
    assert.equal(entry.outputWindow, 2097152, '超限输出窗口收敛到上限');
    assert.deepEqual(entry.modalities, {text: true, image: false, video: false, audio: false});
    assert.equal(entry.reasoningEffort, '');
    assert.equal(entry.thinkingBudget, 1024);
    const fallback = normalizeModelEntry(null, () => 'gen-2');
    assert.equal(fallback.id, 'gen-2');
    assert.equal(fallback.contextWindow, 128000);
    assert.equal(fallback.outputWindow, 4096);
});

test('migrateAccountModels：旧版单模型 profile 迁移为首条目并镜像旧字段', () => {
    const account = {
        id: 'p1',
        model: 'deepseek-chat',
        maxTokens: 8192,
        contextWindow: 128000,
        reasoningEffort: 'high',
        thinking: false,
        thinkingBudget: 8000,
    };
    const models = migrateAccountModels(account, '', () => 'gen-1');
    assert.equal(models.length, 1);
    assert.equal(models[0].id, 'p1-m1');
    assert.equal(models[0].model, 'deepseek-chat');
    assert.equal(models[0].outputWindow, 8192);
    assert.equal(models[0].contextWindow, 128000);
    assert.deepEqual(models[0].modalities, {text: true, image: true, video: false, audio: false});
    // 旧字段镜像 = 激活（缺省首）条目
    assert.equal(account.model, 'deepseek-chat');
    assert.equal(account.maxTokens, 8192);
    assert.equal(account.contextWindow, 128000);
});

test('migrateAccountModels：已有 models 数组去重归一，镜像跟随激活条目', () => {
    const account = {
        id: 'p1',
        models: [
            {id: 'm1', model: 'deepseek-chat', contextWindow: '128K', outputWindow: '8K'},
            {id: 'm2', model: 'deepseek-reasoner', contextWindow: 131072, outputWindow: 65536, reasoningEffort: 'high'},
            'junk',
            {id: 'm1', model: 'dup'},
        ],
    };
    const models = migrateAccountModels(account, 'm2', () => 'gen-1');
    assert.equal(models.length, 2);
    assert.equal(models[0].contextWindow, 131072);
    assert.equal(models[0].outputWindow, 8192);
    assert.equal(models[1].reasoningEffort, 'high');
    // 镜像 = 激活条目 m2
    assert.equal(account.model, 'deepseek-reasoner');
    assert.equal(account.maxTokens, 65536);
    assert.equal(account.contextWindow, 131072);
    assert.equal(account.reasoningEffort, 'high');
});

test('modelEntryOf：精确匹配激活条目，缺省退回首条目', () => {
    const account = {models: [{id: 'm1', model: 'a'}, {id: 'm2', model: 'b'}]};
    assert.equal(modelEntryOf(account, 'm2').model, 'b');
    assert.equal(modelEntryOf(account, 'ghost').model, 'a');
    assert.equal(modelEntryOf(account, ''), modelEntryOf(account, ''));
    assert.equal(modelEntryOf(null, ''), null);
});

test('configForModel：连接字段取账号、模型字段取条目，Anthropic 强制 reasoning 为空', () => {
    const account = {
        provider: 'anthropic',
        baseURL: 'https://api.anthropic.com',
        apiKey: 'sk-1',
        temperature: 0.5,
        proxy: 'direct',
        extraHeaders: {'X-A': '1'},
    };
    const entry = {
        model: 'claude-x',
        outputWindow: 16384,
        thinking: true,
        thinkingBudget: 8000,
        reasoningEffort: 'high',
    };
    const cfg = configForModel(account, entry);
    assert.equal(cfg.provider, 'anthropic');
    assert.equal(cfg.baseURL, 'https://api.anthropic.com');
    assert.equal(cfg.model, 'claude-x');
    assert.equal(cfg.maxTokens, 16384);
    assert.equal(cfg.thinking, true);
    assert.equal(cfg.thinkingBudget, 8000);
    assert.equal(cfg.reasoningEffort, '');
    assert.deepEqual(cfg.extraHeaders, {'X-A': '1'});
    const openai = configForModel({provider: 'openai', baseURL: '', apiKey: ''}, {model: 'm', outputWindow: 4096, reasoningEffort: 'low'});
    assert.equal(openai.reasoningEffort, 'low');
    assert.equal(openai.thinking, false);
});

test('resolveModelRef：新格式校验双 id，旧格式解析为首条目，失效回空', () => {
    const profiles = [
        {id: 'p1', models: [{id: 'm1', model: 'a'}, {id: 'm2', model: 'b'}]},
        {id: 'p2', models: [{id: 'm3', model: 'c'}]},
    ];
    assert.equal(resolveModelRef('p1|m2', profiles), 'p1|m2');
    assert.equal(resolveModelRef('p2', profiles), 'p2|m3', '旧格式解析为账号首条目');
    assert.equal(resolveModelRef('p1|ghost', profiles), '');
    assert.equal(resolveModelRef('ghost|m1', profiles), '');
    assert.equal(resolveModelRef('', profiles), '');
    assert.equal(resolveModelRef('p1|m2', null), '');
    assert.equal(resolveModelRef(null, profiles), '');
});

test('modelRefLabel：模型名 · 账号名；缺模型名退回账号名', () => {
    assert.equal(modelRefLabel({name: 'DeepSeek 账号'}, {model: 'deepseek-chat'}), 'deepseek-chat · DeepSeek 账号');
    assert.equal(modelRefLabel({name: 'deepseek-chat'}, {model: 'deepseek-chat'}), 'deepseek-chat');
    assert.equal(modelRefLabel({name: '备用'}, {model: ''}), '备用');
});

test('clampNumber：非数字回退、越界收敛', () => {
    assert.equal(clampNumber('128', 1, 100, 50), 100);
    assert.equal(clampNumber('bad', 1, 100, 50), 50);
    assert.equal(clampNumber('3.6', 1, 100, 50), 4);
});
