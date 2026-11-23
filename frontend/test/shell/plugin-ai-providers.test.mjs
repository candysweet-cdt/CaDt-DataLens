import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {configForModel} from '../../src/ai/core/ai-config-model.js';
import {
    AI_PROVIDER_ACCOUNT_PREFIX,
    AI_PROVIDER_MAX_HEADERS,
    AI_PROVIDER_MAX_BODY_BYTES,
    applyPluginAIPatch,
    clearPluginAIProviders,
    getPluginAIProviders,
    mergePluginAIRequest,
    pluginAIAccounts,
    registerPluginAIProvider,
} from '../../src/shell/plugin-ai-providers.js';

const baseSpec = (extra = {}) => ({
    id: 'demo-provider',
    name: '示例 provider',
    account: {
        baseURL: 'https://example.com/v1',
        apiKey: 'k',
        temperature: 0.3,
        extraHeaders: {'x-static': '1'},
    },
    models: [{model: 'demo-model', contextWindow: 128000, outputWindow: 4096}],
    ...extra,
});

const quiet = (fn) => {
    const original = console.warn;
    console.warn = () => {};
    try { return fn(); } finally { console.warn = original; }
};

test.beforeEach(() => clearPluginAIProviders());

test('注册校验：id / name / models / prepare 都要合法，重复注册被拒', () => {
    assert.throws(() => registerPluginAIProvider('p', {...baseSpec(), id: 'Bad ID'}), /id 无效/);
    assert.throws(() => registerPluginAIProvider('p', {...baseSpec(), name: ''}), /缺少 name/);
    assert.throws(() => registerPluginAIProvider('p', {...baseSpec(), models: []}), /至少要有 1 条/);
    assert.throws(() => registerPluginAIProvider('p', {...baseSpec(), prepare: 'nope'}), /prepare 必须是函数/);
    assert.throws(() => registerPluginAIProvider('p', baseSpec({account: {...baseSpec().account, baseURL: 'file:///etc'}})), /http\/https/);
    registerPluginAIProvider('p', baseSpec());
    assert.throws(() => registerPluginAIProvider('p', baseSpec()), /已注册/);
    assert.equal(getPluginAIProviders().length, 1);
});

test('虚拟账号形状可直接进 config.profiles，且带不落盘标记', () => {
    registerPluginAIProvider('p', baseSpec());
    const [account] = pluginAIAccounts();
    assert.ok(account.id.startsWith(AI_PROVIDER_ACCOUNT_PREFIX));
    assert.equal(account.id, 'pluginai:p:demo-provider');
    assert.equal(account.pluginAI, true);
    assert.equal(account.baseURL, 'https://example.com/v1');
    assert.equal(account.apiKey, 'k');
    assert.equal(account.temperature, 0.3);
    assert.deepEqual(account.extraHeaders, {'x-static': '1'});
    assert.equal(account.models.length, 1);
    assert.equal(account.models[0].model, 'demo-model');
    assert.equal(account.lastModelId, account.models[0].id);
    assert.equal(account.model, 'demo-model');
    assert.equal(account.maxTokens, 4096);
    assert.equal(account.contextWindow, 128000);
});

test('补丁白名单：连接字段不可改，头可覆盖同名静态头且总数不超上限', () => {
    const cfg = {
        provider: 'openai', baseURL: 'https://a.example/v1', apiKey: 'secret', model: 'm1',
        extraHeaders: {'x-static': 'old', 'X-Dynamic': 'static', 'x-keep': 'yes'},
    };
    const patch = {
        baseURL: 'https://evil.example/v1',
        apiKey: 'stolen',
        extraHeaders: {'x-dynamic': 'fresh', 'x-extra': '2'},
    };
    const next = applyPluginAIPatch(cfg, patch);
    assert.equal(next.baseURL, cfg.baseURL);
    assert.equal(next.apiKey, cfg.apiKey);
    assert.equal(next.extraHeaders['x-dynamic'], 'fresh');
    assert.equal(next.extraHeaders['X-Dynamic'], undefined);
    assert.equal(next.extraHeaders['x-static'], 'old');
    assert.equal(cfg.extraHeaders['X-Dynamic'], 'static', '原配置对象不能被就地修改');

    const many = {};
    for (let i = 0; i < 20; i++) many['h' + i] = String(i);
    const capped = applyPluginAIPatch(cfg, {extraHeaders: many});
    assert.equal(Object.keys(capped.extraHeaders).length, AI_PROVIDER_MAX_HEADERS);
});

test('补丁请求体：删掉 stream，超限整体忽略，非对象忽略', () => {
    const cfg = {model: 'm1', extraHeaders: {}};
    const clean = applyPluginAIPatch(cfg, {extraBody: {stream: false, tool_choice: 'none'}});
    assert.deepEqual(clean.extraBody, {tool_choice: 'none'});
    assert.equal(cfg.extraBody, undefined);

    const huge = quiet(() => applyPluginAIPatch(cfg, {extraBody: {blob: 'x'.repeat(AI_PROVIDER_MAX_BODY_BYTES)}}));
    assert.equal(huge.extraBody, undefined);
    const arrayPatch = applyPluginAIPatch(cfg, {extraBody: [1, 2, 3]});
    assert.equal(arrayPatch.extraBody, undefined);
});

test('mergePluginAIRequest：普通账号零改动，虚拟账号按会话调用 prepare', () => {
    const seen = [];
    registerPluginAIProvider('p', baseSpec({
        prepare(ctx) {
            seen.push(ctx);
            return {extraHeaders: {'x-session-tag': ctx.sessionId}, extraBody: {tool_choice: 'none'}};
        },
    }));
    const [account] = pluginAIAccounts();
    const cfg = {baseURL: account.baseURL, model: 'demo-model', extraHeaders: {'x-static': '1'}};
    assert.equal(mergePluginAIRequest(cfg, {accountId: 'profile-1', sessionId: 's1'}), cfg);

    const merged = mergePluginAIRequest(cfg, {accountId: account.id, sessionId: 's1'});
    assert.equal(merged.extraHeaders['x-session-tag'], 's1');
    assert.deepEqual(merged.extraBody, {tool_choice: 'none'});
    assert.equal(seen.length, 1);
    assert.equal(seen[0].providerId, 'demo-provider');
    assert.equal(seen[0].model, 'demo-model');
    assert.equal(seen[0].baseURL, 'https://example.com/v1');
    assert.equal(seen[0].accountId, account.id);
    assert.equal('apiKey' in seen[0], false, 'prepare 不应拿到密钥');
});

test('prepare 抛异常只降级忽略，不阻断发请求', () => {
    registerPluginAIProvider('p', baseSpec({prepare() { throw new Error('boom'); }}));
    const [account] = pluginAIAccounts();
    const cfg = {model: 'demo-model', extraHeaders: {}};
    const result = quiet(() => mergePluginAIRequest(cfg, {accountId: account.id, sessionId: 's1'}));
    assert.equal(result, cfg);
});

test('clear 后注册表与虚拟账号同时清空', () => {
    registerPluginAIProvider('p', baseSpec());
    assert.equal(pluginAIAccounts().length, 1);
    clearPluginAIProviders();
    assert.equal(getPluginAIProviders().length, 0);
    assert.deepEqual(pluginAIAccounts(), []);
});

test('Responses 协议：插件可声明并一路透传到 AIConfig', () => {
    registerPluginAIProvider('p', baseSpec({
        account: {...baseSpec().account, provider: 'responses'},
    }));
    const [account] = pluginAIAccounts();
    assert.equal(account.provider, 'responses');
    assert.equal(configForModel(account, account.models[0]).provider, 'responses');
    assert.equal(configForModel({...account, provider: 'weird'}, account.models[0]).provider, 'openai');
});

// 接线护栏：AI provider 能力横跨插件宿主、AI 面板、Go 请求链路、文档和测试清单，
// 任何一处重构漏掉都该让测试变红，而不是「装了插件但模型选择器里没有」。
test('接线护栏：宿主 / 面板 / Go 侧 / 文档 / 测试清单五处齐全', () => {
    const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
    const plugins = read('../../src/shell/plugins.js');
    const panel = read('../../src/ai/ai-panel.js');
    const goTypes = read('../../../internal/aitransport/types.go');
    const goHttp = read('../../../internal/aitransport/http.go');
    const goValidate = read('../../../internal/aitransport/validate.go');
    const docs = read('../../../docs/plugins/README.md');
    const packageJson = read('../../package.json');
    const html = read('../../index.html');
    const goStream = read('../../../internal/aitransport/stream.go');
    const goSSE = read('../../../internal/aitransport/sse.go');

    assert.match(plugins, /registerAIProvider\(spec\)/);
    assert.match(plugins, /clearPluginAIProviders\(\)/);
    assert.match(panel, /pluginAIAccounts\(\)/);
    assert.match(panel, /mergePluginAIRequest\(cfg, \{/);
    assert.match(panel, /profiles\.filter\(\(p\) => !p\.pluginAI\)/);
    assert.match(panel, /cadt-plugins-loaded/);
    assert.match(panel, /configForProfile\(modelRef\.account, modelRef\.entry\)/);
    assert.match(goTypes, /ExtraBody\s+map\[string\]any/);
    assert.match(goHttp, /aiApplyBodyPatch\(payload, cfg\.ExtraBody\)/);
    assert.match(goValidate, /aiMaxExtraBodyBytes/);
    assert.match(docs, /cadt\.registerAIProvider\(spec\)/);
    assert.match(packageJson, /plugin-ai-providers\.test\.mjs/);
    assert.match(html, /value="responses"/, '协议下拉要有 Responses 选项');
    assert.match(goStream, /ProviderResponses/);
    assert.match(goHttp, /aiBuildResponsesBody/);
    assert.match(goSSE, /func streamResponsesSSE/);
    assert.match(docs, /OpenAI Responses API/);
});
