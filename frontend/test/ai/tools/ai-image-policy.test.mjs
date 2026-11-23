// ai-image-policy 单测：投影归一化、源准入层、请求预算层三条红线。
// 纯函数为主 + 一个小 store 用假 backend 验证兜底。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    checkRequestBudget,
    checkSourceBatch,
    createImagePolicyStore,
    DEFAULT_IMAGE_LIMITS,
    IMAGE_POLICY_CODE,
    normalizeImageLimits,
} from '../../../src/ai/tools/ai-image-policy.js';
import {AI_IMAGE_LIMIT, AI_IMAGE_MAX_BASE64, AI_IMAGE_MAX_DIM, AI_IMAGE_MAX_INPUT_BYTES} from '../../../src/ai/core/ai-constants.js';

const MB = 1024 * 1024;

// 漂移守卫：ai-constants.js 里仍在实际消费的镜像常量必须与投影默认值一致。
// 改 Go 的 aiimagepolicy 而忘了同步这里时，这条会红——而不是静默让前端用旧值。
test('ai-constants 的镜像常量与 DEFAULT_IMAGE_LIMITS 一致（防漂移）', () => {
    assert.equal(AI_IMAGE_LIMIT, DEFAULT_IMAGE_LIMITS.maxImagesPerMessage);
    assert.equal(AI_IMAGE_MAX_DIM, DEFAULT_IMAGE_LIMITS.maxNormalizedDimension);
    assert.equal(AI_IMAGE_MAX_BASE64, DEFAULT_IMAGE_LIMITS.maxNormalizedBase64);
    // 输入上限 = 源准入单张上限
    assert.equal(AI_IMAGE_MAX_INPUT_BYTES, DEFAULT_IMAGE_LIMITS.maxSourceImageBytes);
});

test('DEFAULT_IMAGE_LIMITS 与 Go 单一真源逐项一致', () => {
    // 这些数字必须与 internal/aiimagepolicy/policy.go 相同，改一处就要同步另一处
    assert.equal(DEFAULT_IMAGE_LIMITS.maxImagesPerMessage, 10);
    assert.equal(DEFAULT_IMAGE_LIMITS.maxSourceImageBytes, 50 * MB);
    assert.equal(DEFAULT_IMAGE_LIMITS.maxMessageSourceBytes, 200 * MB);
    assert.equal(DEFAULT_IMAGE_LIMITS.maxImagePixels, 64000000);
    assert.equal(DEFAULT_IMAGE_LIMITS.maxImageDimension, 65535);
    assert.equal(DEFAULT_IMAGE_LIMITS.maxNormalizedDimension, 2048);
    assert.equal(DEFAULT_IMAGE_LIMITS.maxNormalizedBase64, 4 * MB);
    assert.equal(DEFAULT_IMAGE_LIMITS.maxRequestImageBytes, 32 * MB);
    assert.deepEqual(Array.from(DEFAULT_IMAGE_LIMITS.mediaTypes), ['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
});

test('normalizeImageLimits：非法/残缺输入回落默认值，不产生 undefined 阈值', () => {
    assert.equal(normalizeImageLimits(null), DEFAULT_IMAGE_LIMITS);
    assert.equal(normalizeImageLimits(undefined), DEFAULT_IMAGE_LIMITS);
    assert.equal(normalizeImageLimits('nope'), DEFAULT_IMAGE_LIMITS);
    // 字段缺失/为 0/负数 → 回落默认
    const partial = normalizeImageLimits({maxImagesPerMessage: 0, maxRequestImageBytes: -1});
    assert.equal(partial.maxImagesPerMessage, DEFAULT_IMAGE_LIMITS.maxImagesPerMessage);
    assert.equal(partial.maxRequestImageBytes, DEFAULT_IMAGE_LIMITS.maxRequestImageBytes);
    // 合法值原样采用
    const custom = normalizeImageLimits({maxImagesPerMessage: 3, mediaTypes: ['image/png']});
    assert.equal(custom.maxImagesPerMessage, 3);
    assert.deepEqual(custom.mediaTypes, ['image/png']);
    // mediaTypes 空数组 → 回落默认
    assert.deepEqual(Array.from(normalizeImageLimits({mediaTypes: []}).mediaTypes), Array.from(DEFAULT_IMAGE_LIMITS.mediaTypes));
});

test('createImagePolicyStore：后端有绑定时采用投影值，无绑定时静默用默认', async () => {
    const withBackend = createImagePolicyStore({backend: {AIImageLimits: async () => ({maxImagesPerMessage: 4})}});
    const loaded = await withBackend.load();
    assert.equal(loaded.maxImagesPerMessage, 4);
    assert.equal(withBackend.get().maxImagesPerMessage, 4);
    assert.equal(withBackend.isLoaded(), true);

    const noBackend = createImagePolicyStore({});
    assert.equal(await noBackend.load(), DEFAULT_IMAGE_LIMITS);
    assert.equal(noBackend.isLoaded(), false);

    const failing = createImagePolicyStore({backend: {AIImageLimits: async () => { throw new Error('boom'); }}});
    assert.equal(await failing.load(), DEFAULT_IMAGE_LIMITS);

    // 并发 load 合并成一次调用
    let calls = 0;
    const concurrent = createImagePolicyStore({backend: {AIImageLimits: async () => { calls += 1; return {maxImagesPerMessage: 7}; }}});
    await Promise.all([concurrent.load(), concurrent.load(), concurrent.load()]);
    assert.equal(calls, 1);
});

test('checkSourceBatch：空输入直接通过', () => {
    assert.deepEqual(checkSourceBatch(DEFAULT_IMAGE_LIMITS, [], []), {ok: true});
});

test('checkSourceBatch：张数红线（10 张通过 / 11 张拒）', () => {
    const ten = Array.from({length: 10}, () => ({size: 1024, type: 'image/png'}));
    assert.equal(checkSourceBatch(DEFAULT_IMAGE_LIMITS, [], ten).ok, true);
    const eleven = Array.from({length: 11}, () => ({size: 1024, type: 'image/png'}));
    const denied = checkSourceBatch(DEFAULT_IMAGE_LIMITS, [], eleven);
    assert.equal(denied.ok, false);
    assert.equal(denied.code, IMAGE_POLICY_CODE.TOO_MANY_IMAGES);
    assert.equal(denied.reason, '每条消息最多附加 10 张图片');
    // 已有 8 张 + 再加 3 张 = 11 → 拒
    const existing = Array.from({length: 8}, () => ({}));
    const more = Array.from({length: 3}, () => ({size: 1024, type: 'image/png'}));
    assert.equal(checkSourceBatch(DEFAULT_IMAGE_LIMITS, existing, more).ok, false);
});

test('checkSourceBatch：单源字节红线（50MiB 边界）', () => {
    // 恰好 50MiB 通过
    assert.equal(checkSourceBatch(DEFAULT_IMAGE_LIMITS, [], [{size: 50 * MB, type: 'image/png'}]).ok, true);
    // 超 1 字节拒
    const denied = checkSourceBatch(DEFAULT_IMAGE_LIMITS, [], [{size: 50 * MB + 1, type: 'image/png'}]);
    assert.equal(denied.ok, false);
    assert.equal(denied.code, IMAGE_POLICY_CODE.SOURCES_TOO_LARGE);
    assert.match(denied.reason, /50 MB/);
});

test('checkSourceBatch：源合计红线（200MiB）', () => {
    // 5 张 50MiB = 250MiB，各张都在单源上限内，但合计超
    const files = Array.from({length: 5}, () => ({size: 50 * MB, type: 'image/png'}));
    const denied = checkSourceBatch(DEFAULT_IMAGE_LIMITS, [], files);
    assert.equal(denied.ok, false);
    assert.equal(denied.code, IMAGE_POLICY_CODE.SOURCES_TOO_LARGE);
    assert.match(denied.reason, /合计/);
});

test('checkSourceBatch：类型白名单（已知 type 才拦，未知放行给后端魔数）', () => {
    // 归一化白名单之外的格式：源层拒绝，且用独立的格式错误码（不与体积混为一谈）
    const denied = checkSourceBatch(DEFAULT_IMAGE_LIMITS, [], [{size: 1024, type: 'image/heic'}]);
    assert.equal(denied.ok, false);
    assert.equal(denied.code, IMAGE_POLICY_CODE.UNSUPPORTED_SOURCE_TYPE);
    assert.match(denied.reason, /不支持/);
    // 浏览器没给 type 时不误杀
    assert.equal(checkSourceBatch(DEFAULT_IMAGE_LIMITS, [], [{size: 1024}]).ok, true);
});

test('checkSourceBatch：bmp / svg / image/jpg 源层放行（画布能转码，不该在入口拒）', () => {
    // 这三种不在归一化白名单里，但 canvas 会统一转成 png/jpeg，源层必须放行
    for (const type of ['image/bmp', 'image/svg+xml', 'image/jpg']) {
        const result = checkSourceBatch(DEFAULT_IMAGE_LIMITS, [], [{size: 1024, type}]);
        assert.equal(result.ok, true, type + ' 应放行');
    }
});

test('checkRequestBudget：空输入直接通过', () => {
    assert.deepEqual(checkRequestBudget(DEFAULT_IMAGE_LIMITS, []), {ok: true});
});

test('checkRequestBudget：单张编码红线（4MiB base64）', () => {
    const ok = checkRequestBudget(DEFAULT_IMAGE_LIMITS, [{data: 'A'.repeat(4 * MB)}]);
    assert.equal(ok.ok, true);
    const denied = checkRequestBudget(DEFAULT_IMAGE_LIMITS, [{data: 'A'.repeat(4 * MB + 1)}]);
    assert.equal(denied.ok, false);
    assert.equal(denied.code, IMAGE_POLICY_CODE.REQUEST_IMAGES_TOO_LARGE);
    assert.match(denied.reason, /第 1 张/);
});

test('checkRequestBudget：合计红线（32MiB）', () => {
    // 9 张各 4MiB = 36MiB > 32MiB
    const images = Array.from({length: 9}, () => ({data: 'A'.repeat(4 * MB)}));
    const denied = checkRequestBudget(DEFAULT_IMAGE_LIMITS, images);
    assert.equal(denied.ok, false);
    assert.equal(denied.code, IMAGE_POLICY_CODE.REQUEST_IMAGES_TOO_LARGE);
    assert.match(denied.reason, /合计/);
    // 8 张各 4MiB = 32MiB 恰好等于上限 → 通过
    const exactly = Array.from({length: 8}, () => ({data: 'A'.repeat(4 * MB)}));
    assert.equal(checkRequestBudget(DEFAULT_IMAGE_LIMITS, exactly).ok, true);
});

test('checkRequestBudget：缺 data 的条目按 0 字节计，不抛错', () => {
    assert.equal(checkRequestBudget(DEFAULT_IMAGE_LIMITS, [{}, {data: null}, {data: 'AB'}]).ok, true);
});
