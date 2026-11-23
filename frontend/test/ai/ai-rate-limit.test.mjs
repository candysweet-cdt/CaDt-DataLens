// RPM 本地限流：配置透传 + 前后端接线护栏。
//
// Go 侧的窗口/冻结逻辑在 internal/aitransport/ratelimit_test.go 单测；这里管的是
// 「配置有没有真的送到 Go」「排队提示有没有真的渲染」，这两条断了功能等于没做，
// 但界面看起来完全正常（限流器读不到 rpmLock 就永远放行）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {configForModel, normalizeModelEntry} from '../../src/ai/core/ai-config-model.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const readGo = (rel) => readFileSync(join(ROOT, '..', 'internal', 'aitransport', rel), 'utf8');

test('模型条目保留频率上限，非法值归零（0 = 不限）', () => {
    assert.equal(normalizeModelEntry({model: 'm', rpm: 60}).rpm, 60);
    assert.equal(normalizeModelEntry({model: 'm'}).rpm, 0, '缺省必须是不限，不能悄悄限速');
    assert.equal(normalizeModelEntry({model: 'm', rpm: -5}).rpm, 0);
    assert.equal(normalizeModelEntry({model: 'm', rpm: 'abc'}).rpm, 0);
    assert.equal(normalizeModelEntry({model: 'm', rpm: 99999}).rpm, 6000, '上限钳到 6000');
});

test('按模型区分：不同条目各自带自己的阈值', () => {
    const account = {provider: 'openai', baseURL: 'https://x.test/v1', apiKey: 'k', temperature: 0};
    const slow = configForModel(account, {model: 'a', outputWindow: 4096, rpm: 20});
    const fast = configForModel(account, {model: 'b', outputWindow: 4096, rpm: 600});
    const none = configForModel(account, {model: 'c', outputWindow: 4096});
    assert.equal(slow.rpmLimit, 20);
    assert.equal(fast.rpmLimit, 600);
    assert.equal(none.rpmLimit, 0);
});

test('Go 侧 Config 接收 rpmLimit，并在发请求前取名额', () => {
    const types = readGo('types.go');
    assert.match(types, /RPMLimit int `json:"rpmLimit,omitempty"`/, 'Config 缺 RPMLimit 字段');
    const http = readGo('http.go');
    assert.match(http, /acquireSlot\(ctx, cfg, id, emit, touch\)/, '请求主循环未接入限流');
    assert.match(http, /aiRateLimiter\.freezeUntil\(rateKey\(cfg\), time\.Now\(\)\.Add\(delay\)\)/, '429 未回灌冻结窗口');
    const limiter = readGo('ratelimit.go');
    assert.match(limiter, /EventQueue, QueuePayload/, '排队未通知前端（会表现为纯空转）');
    assert.match(limiter, /if touch != nil \{\s*\n\s*touch\(\)/, '排队中未喂看门狗（120s 会被杀）');
});

test('前端渲染排队提示，并在流有进展时收起', () => {
    const code = read('src/ai/ai-panel.js');
    assert.match(code, /case 'ai-queue':/, '未处理 ai-queue 事件');
    assert.match(code, /function showQueueNote/, '缺排队提示渲染');
    assert.match(code, /function clearQueueNote/, '缺排队提示清除');
    // 四个「流已发出」的分支都要收提示，漏一个就会挂着一条过期的「排队中」
    const clears = code.match(/clearQueueNote\(\)/g) || [];
    assert.ok(clears.length >= 5, `clearQueueNote 调用点过少（${clears.length}），流有进展时可能残留提示`);
});

test('模型编辑器提供频率上限输入并写回条目', () => {
    const html = read('index.html');
    const panel = read('src/ai/ai-panel.js');
    const dialog = read('src/ai/settings/ai-settings-dialog.js');
    assert.match(html, /id="ai-opt-rpm"/, '编辑器缺输入框');
    assert.match(panel, /rpm:\s*document\.getElementById\('ai-opt-rpm'\)/, 'opt 表缺条目');
    assert.match(dialog, /if \(opt\.rpm\) opt\.rpm\.value = Number\(entry\.rpm\) > 0/, '缺回填');
    assert.match(dialog, /entry\.rpm = Number\.isFinite\(raw\)/, '缺写回');
});
