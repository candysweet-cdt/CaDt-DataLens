// 模型配置表：ID 归一 / 匹配 / 合并 / 回填策略 / 同步状态机。
// 重点护栏是「宁可漏填不能填错」——前缀与模糊匹配会给出错误窗口，测试里明确钉住不放行。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    BUILTIN_CATALOG,
    CATALOG_URL_DEFAULT,
    CATALOG_URL_GITHUB,
    applyCatalogFields,
    canAutoFill,
    catalogSupport,
    createModelCatalogStore,
    fillEntryFromCatalog,
    matchCatalogModel,
    mergeCatalogs,
    normalizeCatalog,
    normalizeModelId,
} from '../../../src/ai/core/model-catalog.js';

const entryWith = (overrides) => ({
    id: 'm1',
    model: '',
    contextWindow: 128000,
    outputWindow: 4096,
    modalities: {text: true, image: true, video: false, audio: false},
    ...overrides,
});

test('normalizeModelId：去 vendor 前缀 / 路由后缀 / -latest / 日期尾巴', () => {
    assert.equal(normalizeModelId('DeepSeek-Chat'), 'deepseek-chat');
    assert.equal(normalizeModelId('openai/gpt-4o'), 'gpt-4o');
    assert.equal(normalizeModelId('anthropic/claude-sonnet-4-5'), 'claude-sonnet-4-5');
    assert.equal(normalizeModelId('deepseek-chat:free'), 'deepseek-chat');
    assert.equal(normalizeModelId('gpt-4o-2024-08-06'), 'gpt-4o');
    assert.equal(normalizeModelId('gpt-4o-20240806'), 'gpt-4o');
    assert.equal(normalizeModelId('kimi-latest'), 'kimi');
    assert.equal(normalizeModelId('  '), '');
});

test('-free 免费档作为独立条目，窗口低于付费正主且不被后缀剥离', () => {
    // normalizeModelId 刻意不剥 -free：免费档窗口普遍低于付费正主，剥离会错填
    assert.equal(normalizeModelId('deepseek-v4.1-flash-free'), 'deepseek-v4.1-flash-free');
    assert.equal(normalizeModelId('beam-free'), 'beam-free');
    const catalog = normalizeCatalog({
        version: 't',
        models: [
            {id: 'deepseek-v4.1-flash', contextWindow: 1000000, outputWindow: 384000},
            {id: 'deepseek-v4.1-flash-free', contextWindow: 200000, outputWindow: 32000},
            {id: 'beam-free', contextWindow: 1048576, outputWindow: 131072},
        ],
    });
    const paid = matchCatalogModel(catalog, 'deepseek-v4.1-flash');
    const free = matchCatalogModel(catalog, 'deepseek-v4.1-flash-free');
    assert.ok(free, '-free 条目应能精确命中');
    assert.equal(free.contextWindow, 200000, '免费档用自己的低窗口，不复用付费正主');
    assert.equal(free.outputWindow, 32000);
    assert.equal(paid.contextWindow, 1000000, '付费正主不受 -free 条目影响');
    assert.ok(matchCatalogModel(catalog, 'beam-free'), '纯 -free 结尾的模型也能命中');
});

test('matchCatalogModel：精确 → 别名 → 归一化，不做模糊匹配', () => {
    const catalog = normalizeCatalog({
        version: 't',
        models: [
            {id: 'gpt-4o', contextWindow: 128000},
            {id: 'deepseek-chat', aliases: ['DeepSeek-V3'], contextWindow: 131072},
        ],
    });
    assert.equal(matchCatalogModel(catalog, 'gpt-4o').id, 'gpt-4o');
    assert.equal(matchCatalogModel(catalog, 'GPT-4O').id, 'gpt-4o');
    assert.equal(matchCatalogModel(catalog, 'openai/gpt-4o-2024-08-06').id, 'gpt-4o');
    assert.equal(matchCatalogModel(catalog, 'deepseek-v3').id, 'deepseek-chat');
    // 关键负例：gpt-4 不能命中 gpt-4o，deepseek-chat-extra 也不能命中 deepseek-chat
    assert.equal(matchCatalogModel(catalog, 'gpt-4'), null);
    assert.equal(matchCatalogModel(catalog, 'deepseek-chat-extra'), null);
    assert.equal(matchCatalogModel(catalog, ''), null);
    assert.equal(matchCatalogModel(null, 'gpt-4o'), null);
});

test('normalizeCatalog：缺 id 丢弃、重复 id 去重、窗口越界 clamp、支持性三态保留', () => {
    const catalog = normalizeCatalog({
        models: [
            {id: 'a', contextWindow: 10, outputWindow: 0},
            {id: 'a', contextWindow: 999999},
            {contextWindow: 1000},
            {id: 'b', reasoningEffort: true, thinking: false, modalities: {image: true, bogus: 1}},
        ],
    });
    assert.equal(catalog.models.length, 2);
    const a = catalog.models[0];
    assert.equal(a.contextWindow, 2048, '过小的上下文应抬到下限');
    assert.equal(a.outputWindow, undefined, '0 视为「不知道」，不写字段');
    const b = catalog.models[1];
    assert.equal(b.reasoningEffort, true);
    assert.equal(b.thinking, false);
    assert.deepEqual(b.modalities, {image: true});
    assert.equal(normalizeCatalog({models: []}), null);
    assert.equal(normalizeCatalog({models: 'x'}), null);
    assert.equal(normalizeCatalog(null), null);
});

test('mergeCatalogs：远端同 ID 覆盖、内置独有保留、远端多出的追加', () => {
    const builtin = normalizeCatalog({version: 'v1', models: [{id: 'a', contextWindow: 4096}, {id: 'b', contextWindow: 8192}]});
    const remote = normalizeCatalog({version: 'v2', models: [{id: 'a', contextWindow: 16384}, {id: 'c', contextWindow: 32768}]});
    const merged = mergeCatalogs(builtin, remote);
    assert.equal(merged.version, 'v2');
    assert.deepEqual(merged.models.map((entry) => entry.id), ['a', 'b', 'c']);
    assert.equal(merged.models[0].contextWindow, 16384);
    assert.equal(merged.models[1].contextWindow, 8192);
    // 空远端原样返回内置（不产生新对象，缓存索引还能命中）
    assert.equal(mergeCatalogs(builtin, null), builtin);
});

test('fillEntryFromCatalog：命中才填、只在允许时自动填、手改后退回可手动重填', () => {
    const catalog = normalizeCatalog({
        models: [{id: 'deepseek-chat', contextWindow: 131072, outputWindow: 8192, modalities: {image: false}}],
    });
    const fresh = entryWith({model: 'deepseek-chat', autoFilled: true});
    const first = fillEntryFromCatalog(catalog, fresh);
    assert.equal(first.hit.id, 'deepseek-chat');
    assert.equal(first.changed, true);
    assert.equal(fresh.contextWindow, 131072);
    assert.equal(fresh.outputWindow, 8192);
    assert.equal(fresh.modalities.image, false);
    assert.equal(fresh.autoFilled, true);

    // 用户手改 → 标记关闭；此后再调 fill 也不会被自动覆盖（调用方按 canAutoFill 判断）
    fresh.autoFilled = false;
    assert.equal(canAutoFill(fresh), false);
    // 但「按配置表重填」是显式动作，不受标记限制
    fresh.contextWindow = 4000;
    assert.equal(applyCatalogFields(fresh, matchCatalogModel(catalog, 'deepseek-chat')), true);
    assert.equal(fresh.contextWindow, 131072);

    // 未命中：什么都不改
    const unknown = entryWith({model: 'some-private-model', autoFilled: true});
    const miss = fillEntryFromCatalog(catalog, unknown);
    assert.equal(miss.hit, null);
    assert.equal(miss.changed, false);
    assert.equal(unknown.contextWindow, 128000);
});

test('canAutoFill：存量条目（没有标记）视为手填，不被配置表改动', () => {
    assert.equal(canAutoFill({}), false, '升级来的存量条目不能被表悄悄改窗口');
    assert.equal(canAutoFill({autoFilled: true}), true, '新建条目显式写 true');
    assert.equal(canAutoFill({autoFilled: false}), false);
    assert.equal(canAutoFill(null), false);
});

test('catalogSupport：只认明确的三态，缺省交给调用方兜底', () => {
    const catalog = normalizeCatalog({
        models: [{id: 'x', reasoningEffort: false}, {id: 'y'}, {id: 'z', thinking: true}],
    });
    assert.equal(catalogSupport(catalog, 'x', 'reasoningEffort'), false);
    assert.equal(catalogSupport(catalog, 'y', 'reasoningEffort'), undefined);
    assert.equal(catalogSupport(catalog, 'z', 'thinking'), true);
    assert.equal(catalogSupport(catalog, 'nope', 'thinking'), undefined);
});

test('内置表自检：ID 唯一、窗口是正整数、只登记确定性字段', () => {
    const ids = new Set();
    for (const entry of BUILTIN_CATALOG.models) {
        assert.ok(entry.id, '每条都要有 id');
        assert.equal(ids.has(entry.id), false, 'id 不能重复：' + entry.id);
        ids.add(entry.id);
        for (const key of ['contextWindow', 'outputWindow']) {
            if (entry[key] === undefined) continue;
            assert.ok(Number.isInteger(entry[key]) && entry[key] > 0, entry.id + ' 的 ' + key + ' 应为正整数');
        }
        assert.equal(typeof entry.thinking === 'boolean' || entry.thinking === undefined, true);
    }
    assert.ok(BUILTIN_CATALOG.models.length >= 40, '常见模型要铺开，不要只剩个位数');
});

test('内置表覆盖：常见厂商各有条目，且关键别名能被识别', () => {
    const vendors = new Set(BUILTIN_CATALOG.models.map((entry) => entry.vendor));
    for (const vendor of ['deepseek', 'anthropic', 'openai', 'google', 'qwen', 'glm', 'kimi', 'minimax', 'doubao', 'hunyuan']) {
        assert.ok(vendors.has(vendor), '缺厂商：' + vendor);
    }
    const probe = (id) => matchCatalogModel(BUILTIN_CATALOG, id);
    // 带日期/别名/大小写/厂商前缀的常见写法都要落到同一条
    assert.equal(probe('doubao-seed-2.1-lite')?.id, 'doubao-seed-2-1-lite-260915');
    assert.equal(probe('Doubao-Seed-2.1-Lite')?.id, 'doubao-seed-2-1-lite-260915');
    assert.equal(probe('glm-latest')?.id, 'glm-5.3');
    assert.equal(probe('anthropic/claude-opus-5-5')?.id, 'claude-opus-5-5');
    assert.equal(probe('gpt-5.2-2025-12-11')?.id, 'gpt-5.2');
    assert.equal(probe('MiniMax-M3.1-Flash')?.id, 'minimax-m3.1-flash');
    assert.equal(probe('kimi-k3.1-pro-highspeed')?.id, 'kimi-k3.1-pro-highspeed');
    assert.equal(probe('hy4')?.id, 'hy4');
});

test('store：读缓存合并、过期才自动同步、静默失败不抛错', async () => {
    const remoteText = JSON.stringify({version: 'r1', models: [{id: 'gpt-4o', contextWindow: 200000}]});
    let nowMs = 1_700_000_000_000;
    let cachedAtSec = Math.floor(nowMs / 1000) - 3600; // 缓存落在 1 小时前
    const calls = [];
    const backend = {
        async AIModelCatalogCached() {
            return {text: remoteText, fetchedAt: cachedAtSec};
        },
        async AIModelCatalogSync(url) {
            calls.push(url);
            return {text: remoteText, fetchedAt: Math.floor(nowMs / 1000)};
        },
    };
    const settings = {aiCatalogAutoSync: true};
    const store = createModelCatalogStore({backend, getSettings: () => settings, now: () => nowMs});

    await store.load();
    const merged = store.get();
    assert.equal(merged.version, 'r1');
    // 远端覆盖 gpt-4o 的窗口，内置其余条目保留
    assert.equal(store.match('gpt-4o').contextWindow, 200000);
    assert.ok(store.match('deepseek-flash'), '内置条目应仍在');

    // 缓存 1 小时前 → 未过期，自动同步跳过
    let result = await store.autoSync();
    assert.equal(result.skipped, true);
    assert.equal(calls.length, 0);

    // 手动同步永远执行
    result = await store.sync();
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], CATALOG_URL_DEFAULT);

    // 过期 + 自动同步开启 → 会再拉一次
    nowMs += 8 * 24 * 3600 * 1000;
    cachedAtSec = Math.floor(nowMs / 1000) - 8 * 24 * 3600;
    const store2 = createModelCatalogStore({backend, getSettings: () => settings, now: () => nowMs});
    result = await store2.autoSync();
    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);

    // 静默失败：不抛异常，内置表继续可用
    const brokenBackend = {
        async AIModelCatalogCached() { return {text: '', fetchedAt: 0}; },
        async AIModelCatalogSync() { throw new Error('网络断了'); },
    };
    const store3 = createModelCatalogStore({backend: brokenBackend, getSettings: () => settings, now: () => nowMs});
    const failed = await store3.autoSync();
    assert.equal(failed.ok, false);
    assert.equal(failed.error, '网络断了');
    assert.equal(store3.get(), BUILTIN_CATALOG);

    // 非静默失败要抛出，供手动同步把错误显示到状态行
    await assert.rejects(() => store3.sync(), /网络断了/);
});

test('store：远端内容损坏整份丢弃，退回内置表', async () => {
    const backend = {
        async AIModelCatalogCached() { return {text: '{"oops":1}', fetchedAt: 1700000000}; },
        async AIModelCatalogSync() { return {text: '<html>', fetchedAt: 1700000000}; },
    };
    const store = createModelCatalogStore({backend, getSettings: () => ({aiCatalogAutoSync: false}), now: () => 1700000000000});
    await store.load();
    assert.equal(store.get(), BUILTIN_CATALOG);
    await assert.rejects(() => store.sync(), /不是合法的模型配置表/);
    assert.equal(store.status().remote, false);
});

test('store：自定义同步地址必须像 URL，否则回落到默认', async () => {
    const seen = [];
    const backend = {
        async AIModelCatalogCached() { return {text: '', fetchedAt: 0}; },
        async AIModelCatalogSync(url) {
            seen.push(url);
            return {text: JSON.stringify({version: 'v', models: [{id: 'a'}]}), fetchedAt: 1700000000};
        },
    };
    const settings = {aiCatalogAutoSync: false, aiCatalogURL: 'https://example.com/catalog.json'};
    const store = createModelCatalogStore({backend, getSettings: () => settings, now: () => 1700000000000});
    await store.sync();
    assert.equal(seen[0], 'https://example.com/catalog.json');

    settings.aiCatalogURL = 'file:///C:/secret.json';
    await store.sync();
    assert.equal(seen[1], CATALOG_URL_DEFAULT, '非 http(s) 的自定义地址不可用');
});

test('store：自动同步开关关闭时整段跳过', async () => {
    let called = 0;
    const backend = {
        async AIModelCatalogCached() { return {text: '', fetchedAt: 0}; },
        async AIModelCatalogSync() { called += 1; return {text: '{}', fetchedAt: 1}; },
    };
    const store = createModelCatalogStore({backend, getSettings: () => ({aiCatalogAutoSync: false}), now: () => 1});
    const result = await store.autoSync();
    assert.equal(result.skipped, true);
    assert.equal(called, 0);
    assert.equal(store.status().autoSync, false);
});

test('store：默认同步地址跟随数据源，自定义地址优先', async () => {
    let source = 'gitee';
    const remoteJson = JSON.stringify({version: 'v1', models: [{id: 'deepseek-chat', contextWindow: 128000}]});
    const seen = [];
    const backend = {
        async AIModelCatalogCached() { return {text: '', fetchedAt: 0}; },
        async AIModelCatalogSync(url) {
            seen.push(url);
            return {text: remoteJson, fetchedAt: 1700000000};
        },
        async GetDataSource() { return source; },
    };
    const settings = {aiCatalogAutoSync: false};
    const store = createModelCatalogStore({backend, getSettings: () => settings, now: () => 1700000000000});

    await store.sync();
    assert.equal(seen[0], CATALOG_URL_DEFAULT, '默认应走 Gitee 地址');

    source = 'github';
    await store.sync();
    assert.equal(seen[1], CATALOG_URL_GITHUB, '数据源切到 GitHub 后默认地址跟随');

    settings.aiCatalogURL = 'https://example.com/catalog.json';
    await store.sync();
    assert.equal(seen[2], 'https://example.com/catalog.json', '自定义地址优先于数据源默认');

    delete settings.aiCatalogURL;
    source = 'gitee';
    await store.sync();
    assert.equal(seen[3], CATALOG_URL_DEFAULT, '清掉后回落当前数据源默认');
});
