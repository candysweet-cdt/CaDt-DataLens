// ai-external-tools 测试：来源矩阵归一化、可用性判定（off/provider/mcp/builtin）与结果格式化。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    defaultExternalToolsConfig,
    defaultSearchCount,
    effectiveExternalMode,
    externalCapabilityUsable,
    externalToolsAvailability,
    formatAsrOutput,
    formatMcpSourceLine,
    formatOcrOutput,
    formatTtsOutput,
    normalizeExternalToolsConfig,
} from '../../../src/ai/tools/ai-external-tools.js';

test('默认配置：搜索/抓取内置，OCR/TTS/ASR 关闭，提供商总开关关', () => {
    const cfg = defaultExternalToolsConfig();
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.capabilities.search.mode, 'builtin');
    assert.equal(cfg.capabilities.fetch.mode, 'builtin');
    for (const key of ['ocr', 'tts', 'asr']) assert.equal(cfg.capabilities[key].mode, 'off');
    assert.equal(cfg.searchCount, 10);
});

test('normalize：非法 mode 回落、搜索条数裁剪、绑定 trim', () => {
    const cfg = normalizeExternalToolsConfig({
        enabled: true,
        baseUrl: '  https://x/v1/tools ',
        apiKeySet: true,
        searchCount: 999,
        capabilities: {
            search: {mode: 'PROVIDER'},
            ocr: {mode: 'builtin'},
            tts: {mode: 'mcp'},
            asr: {mode: 'bogus'},
        },
        mcpBindings: {tts: '  mcp__srv__say  ', asr: 42},
    });
    assert.equal(cfg.searchCount, 50);
    assert.equal(cfg.baseUrl, 'https://x/v1/tools');
    assert.equal(cfg.capabilities.search.mode, 'provider');
    assert.equal(cfg.capabilities.ocr.mode, 'off');
    assert.equal(cfg.capabilities.tts.mode, 'mcp');
    assert.equal(cfg.capabilities.asr.mode, 'off');
    assert.equal(cfg.mcpBindings.tts, 'mcp__srv__say');
    assert.equal(cfg.mcpBindings.asr, '');
    assert.equal(cfg.apiKeySet, true);
});

test('effectiveExternalMode：provider 缺 key / mcp 绑定失效都按 off', () => {
    const cfg = normalizeExternalToolsConfig({
        enabled: true,
        apiKeySet: false,
        capabilities: {ocr: {mode: 'provider'}, tts: {mode: 'mcp'}, search: {mode: 'mcp'}},
        mcpBindings: {tts: 'mcp__a__say', search: 'mcp__a__search'},
    });
    assert.equal(effectiveExternalMode(cfg, 'ocr', []), 'off', '未存 key 的 provider 不可用');
    assert.equal(effectiveExternalMode(cfg, 'tts', []), 'off', '绑定工具不在快照里不可用');
    assert.equal(effectiveExternalMode(cfg, 'tts', ['mcp__a__say']), 'mcp');
    assert.equal(effectiveExternalMode(cfg, 'search', ['mcp__a__search']), 'mcp');
    const ready = normalizeExternalToolsConfig({enabled: true, apiKeySet: true, capabilities: {ocr: {mode: 'provider'}}});
    assert.equal(effectiveExternalMode(ready, 'ocr', []), 'provider');
    assert.equal(effectiveExternalMode(ready, 'fetch', []), 'builtin', '未配置的能力保持内置默认');
    assert.deepEqual(externalToolsAvailability(ready, []), {
        search: 'builtin', fetch: 'builtin', ocr: 'provider', tts: 'off', asr: 'off',
    });
});

test('externalCapabilityUsable：provider 全档、MCP 写档非计划、TTS 写档', () => {
    for (const scope of ['read', 'edit', 'auto', 'full']) {
        for (const planMode of [false, true]) {
            assert.equal(externalCapabilityUsable('ocr', 'provider', scope, planMode), true);
            assert.equal(externalCapabilityUsable('asr', 'provider', scope, planMode), true);
            assert.equal(externalCapabilityUsable('search', 'builtin', scope, planMode), true);
            assert.equal(externalCapabilityUsable('tts', 'provider', scope, planMode), scope !== 'read' && !planMode);
            assert.equal(externalCapabilityUsable('ocr', 'mcp', scope, planMode), scope !== 'read' && !planMode);
            assert.equal(externalCapabilityUsable('search', 'mcp', scope, planMode), scope !== 'read' && !planMode);
            assert.equal(externalCapabilityUsable('search', 'off', scope, planMode), false);
        }
    }
});

test('defaultSearchCount：设置条数受单次上限 10 约束', () => {
    assert.equal(defaultSearchCount({searchCount: 50}), 10);
    assert.equal(defaultSearchCount({searchCount: 0}), 1);
    assert.equal(defaultSearchCount({searchCount: 7}), 7);
    assert.equal(defaultSearchCount(null), 10);
});

test('formatOcrOutput：来源与费用、逐页输出、超预算标注省略', () => {
    const text = formatOcrOutput({
        pageCount: 2,
        pages: [
            {index: 0, text: '第一页', finishReason: 'stop'},
            {index: 1, text: '第二页', finishReason: 'length'},
        ],
    });
    assert.match(text, /DeepSeek OCR（2 页，约 ¥0\.003）/);
    assert.match(text, /--- 第 1 页 ---/);
    assert.match(text, /该页输出达到上限/);
    const big = formatOcrOutput({
        pageCount: 2,
        pages: [
            {index: 0, text: 'ok', finishReason: 'stop'},
            {index: 1, text: 'x'.repeat(41000), finishReason: 'stop'},
        ],
    });
    assert.match(big, /已省略第 2–2 页/);
    assert.match(big, /不自动重试/);
});

test('formatTtsOutput / formatAsrOutput / MCP 来源行', () => {
    const tts = formatTtsOutput({chars: 12, voice: 'tide', relPath: '.cadt/gen/tts/a.wav', bytes: 2048});
    assert.match(tts, /DeepSeek TTS（12 字符，voice=tide）/);
    assert.match(tts, /\.cadt\/gen\/tts\/a\.wav（2\.0 KB）/);
    const asr = formatAsrOutput({durationMs: 3200, text: '你好'});
    assert.match(asr, /DeepSeek ASR（0:03，约 ¥0\.0007）/);
    assert.match(asr, /你好/);
    assert.equal(formatMcpSourceLine('mcp__srv__tool'), '来源：本地 MCP（mcp__srv__tool）');
});
