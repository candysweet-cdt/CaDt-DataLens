// ai-usage-quota.test.mjs —— 额度查询管线的纯函数护栏（沙箱脚本本体在 node 无 Worker，
// 只锁字符串形态与禁用表；result 归一化 / 节流 / 展示格式化 / 快照层全量覆盖）。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
    buildUsageSpec,
    buildUsageWorkerScript,
    createAIUsageQuota,
    formatUsageAge,
    formatUsageAmount,
    formatUsageCompactText,
    formatUsageCountdown,
    formatPercentCompact,
    normalizeResetAt,
    normalizeUsageResult,
    officialSnapshotFromResult,
    shortWindowName,
    currencySymbolOf,
    usageCompactLine,
    usageHeadlineParts,
    usageItemText,
    usageStale,
    usageTightSummary,
    usageTone,
} from '../../../src/ai/usage/ai-usage-quota.js';
import {normalizeUsageConfig} from '../../../src/ai/core/ai-config-model.js';

// node 没有 Worker：注入假件走同一消息协议（run → request / response → result），
// 在测试进程里 new Function 解析脚本——只验管线编排，沙箱隔离本身在 WebView 里人工验收。
function fakeWorkerFactory() {
    return () => {
        let cfg = null;
        const listeners = new Set();
        const emit = (data) => {
            for (const fn of [...listeners]) fn({data});
        };
        return {
            addEventListener(type, fn) {
                if (type === 'message') listeners.add(fn);
            },
            removeEventListener(type, fn) {
                listeners.delete(fn);
            },
            postMessage(msg) {
                queueMicrotask(() => {
                    try {
                        if (msg.type === 'run') {
                            cfg = new Function('return (' + msg.code + ')')();
                            const req = cfg.request;
                            emit({type: 'request', request: {
                                url: String(req.url), method: String(req.method || 'GET'),
                                headers: req.headers || {}, body: '',
                            }});
                        } else if (msg.type === 'response') {
                            let parsed;
                            try { parsed = JSON.parse(msg.response.body); } catch (_) { parsed = msg.response.body; }
                            emit({type: 'result', raw: cfg.extractor(parsed)});
                        }
                    } catch (err) {
                        emit({type: 'error', error: String((err && err.message) || err)});
                    }
                });
            },
            terminate() {},
        };
    };
}

// 直接执行 buildUsageWorkerScript() 产出的 prelude 源码（模拟 Worker 全局 self），
// 覆盖「run → request / response → result」两阶段。这是 _cfg 赋值 bug 的检测网：
// 假 worker 自己 new Function 解析脚本会绕过 prelude，抓不到这类错误。
function runPreludeStages(code, responseBody) {
    const messages = [];
    let onmessage = null;
    const fakeSelf = {
        postMessage: (msg) => messages.push(msg),
        set onmessage(fn) { onmessage = fn; },
        get onmessage() { return onmessage; },
    };
    // prelude 会把网络原语挂到 self 上赋 undefined / delete 原型链；node 的 fakeSelf
    // 没有那些属性，delete 走 try/catch 静默，不影响验证目标。
    const ctx = vm.createContext({self: fakeSelf, navigator: {}, Object, Function, JSON, String, Number, Array, Error, Date, isFinite});
    vm.runInContext(buildUsageWorkerScript(), ctx);
    onmessage({data: {type: 'run', code}});
    const requestMsg = messages.find((m) => m.type === 'request' || m.type === 'error');
    if (!requestMsg || requestMsg.type === 'error' || !responseBody) return {requestMsg, resultMsg: null, messages};
    onmessage({data: {type: 'response', response: {status: 200, body: responseBody}}});
    const resultMsg = messages.find((m) => m.type === 'result' || (m.type === 'error' && messages.indexOf(m) > messages.indexOf(requestMsg)));
    return {requestMsg, resultMsg, messages};
}

test('Worker prelude 真实执行：run 解析脚本 → request，response 跑 extractor → result', () => {
    const code = `({
      request: { url: "https://api.example.com/balance", method: "GET", headers: {"Authorization": "Bearer k"} },
      extractor: function (response) { return {remaining: response.balance, unit: "USD"}; }
    })`;
    const {requestMsg, resultMsg} = runPreludeStages(code, '{"balance": 12.5}');
    assert.ok(requestMsg, 'prelude 没回 request');
    assert.equal(requestMsg.type, 'request', 'prelude run 阶段报错：' + JSON.stringify(requestMsg));
    assert.equal(requestMsg.request.url, 'https://api.example.com/balance');
    assert.equal(requestMsg.request.method, 'GET');
    assert.ok(resultMsg, 'prelude 没回 result');
    assert.equal(resultMsg.type, 'result', 'prelude response 阶段报错：' + JSON.stringify(resultMsg));
    assert.equal(resultMsg.raw.remaining, 12.5);
    assert.equal(resultMsg.raw.unit, 'USD');
});

test('Worker prelude 真实执行：顶层非对象 / 非法 URL / extractor 缺失都报错', () => {
    const badTop = runPreludeStages('42', null);
    assert.equal(badTop.requestMsg.type, 'error');
    assert.match(badTop.requestMsg.error, /对象字面量/);

    const badUrl = runPreludeStages('({request: {url: "javascript:alert(1)"}, extractor: function(){}})', null);
    assert.equal(badUrl.requestMsg.type, 'error');
    assert.match(badUrl.requestMsg.error, /http\(s\)/);

    const noExtractor = runPreludeStages('({request: {url: "https://x.com"}})', '{}');
    assert.equal(noExtractor.resultMsg.type, 'error');
    assert.match(noExtractor.resultMsg.error, /extractor/);
});

test('normalizeUsageResult：对象折成单条、数组多套餐、缺数值判失败', () => {
    const single = normalizeUsageResult({remaining: 12.5, unit: 'USD'});
    assert.equal(single.error, '');
    assert.equal(single.items.length, 1);
    assert.equal(single.items[0].remaining, 12.5);
    assert.equal(single.items[0].isValid, true);

    const multi = normalizeUsageResult([
        {remaining: 1, unit: 'USD', planName: 'a'},
        {used: 30, unit: '%', planName: 'b'},
        {isValid: false, invalidMessage: '已过期', unit: 'USD'},
    ]);
    assert.equal(multi.items.length, 3);
    assert.equal(multi.items[2].isValid, false);
    assert.equal(multi.items[2].invalidMessage, '已过期');
    // isValid=false 时允许没有数值
    assert.equal(multi.error, '');

    const bad = normalizeUsageResult({foo: 1});
    assert.equal(bad.items.length, 0);
    assert.match(bad.error, /remaining\/total\/used/);

    assert.match(normalizeUsageResult([]).error, /没有返回结果/);
    assert.match(normalizeUsageResult('str').error, /必须是对象/);
    // 非数值 NaN 被剔除后等于缺字段
    assert.match(normalizeUsageResult({remaining: 'abc'}).error, /remaining\/total\/used/);
    // 字符串字段限长 200：恶意 extractor 的超长串不进快照
    const capped = normalizeUsageResult({remaining: 1, unit: 'x'.repeat(500), extra: 'y'.repeat(500)});
    assert.equal(capped.items[0].unit.length, 200);
    assert.equal(capped.items[0].extra.length, 200);
});

test('normalizeUsageResult：截断超量条目', () => {
    const many = [];
    for (let i = 0; i < 40; i++) many.push({remaining: i, unit: 'USD'});
    const out = normalizeUsageResult(many);
    assert.equal(out.items.length, 24); // 多池账号（每池两档）需要更多条目
});

test('officialSnapshotFromResult：引擎三态折成 snapshot', () => {
    const ok = officialSnapshotFromResult({
        supported: true,
        items: [{label: '总额余额（CNY）', value: '49.05'}],
    });
    assert.equal(ok.state, 'ok');
    assert.equal(ok.items[0].label, '总额余额（CNY）');
    assert.equal(ok.items[0].value, '49.05');

    const unsupported = officialSnapshotFromResult({supported: false});
    assert.equal(unsupported.state, 'error');
    assert.match(unsupported.error, /白名单/);

    const errored = officialSnapshotFromResult({supported: true, error: 'HTTP 401'});
    assert.equal(errored.error, 'HTTP 401');

    assert.equal(officialSnapshotFromResult(null).state, 'error');
});

test('Worker 沙箱脚本：禁用表覆盖实例与原型链两层，消息协议齐备', () => {
    const script = buildUsageWorkerScript();
    for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker', 'SharedWorker', 'indexedDB', 'open', 'caches', 'sendBeacon']) {
        assert.ok(script.includes("'" + name + "'"), '禁用表缺 ' + name);
    }
    // 只在 globalThis 遮挡会被 Object.getPrototypeOf(self).fetch 绕过（WebIDL 属性
    // 定义在 WorkerGlobalScope.prototype 上）——必须对原型链 delete（2026-11-19 审查实锤）
    assert.ok(script.includes('delete proto[name]'), 'prelude 缺原型链删除');
    assert.ok(script.includes('Object.getPrototypeOf(self)'), 'prelude 缺原型链处理');
    assert.ok(script.includes('Object.getPrototypeOf(navigator)'), 'prelude 缺 navigator.sendBeacon 原型链清理');
    assert.ok(script.includes("data.type === 'run'"));
    assert.ok(script.includes("data.type === 'response'"));
    assert.ok(script.includes("type: 'request'"));
    assert.ok(script.includes("type: 'result'"));
    assert.ok(script.includes('http(s)://'), '缺 URL scheme 校验');
    // 结果经 JSON 序列化过滤，函数/循环引用进不了主线程
    assert.ok(script.includes('JSON.parse(JSON.stringify(raw))'));
});

test('buildUsageSpec：字段名对齐 aigen.HTTPSpec，超时钳位', () => {
    const spec = buildUsageSpec(
        {url: 'https://x/y', method: 'get', headers: {a: '1'}, body: 'b'},
        {proxy: 'socks5://1.2.3.4'},
        {timeoutSec: 999},
    );
    assert.equal(spec.url, 'https://x/y');
    assert.equal(spec.method, 'get');
    assert.equal(spec.proxy, 'socks5://1.2.3.4');
    assert.equal(spec.maxBytes, 262144);
    assert.ok(spec.timeoutSec >= 3 && spec.timeoutSec <= 60);
});

test('usageStale：0 间隔只认无缓存，有间隔按时间窗', () => {
    const fresh = {state: 'ok', items: [], at: Date.now() - 1000};
    assert.equal(usageStale(null, 0), true);
    assert.equal(usageStale(fresh, 0), false);
    assert.equal(usageStale(fresh, 5), false);
    assert.equal(usageStale({state: 'ok', items: [], at: Date.now() - 3600000}, 5), true);
});

test('展示格式化：∞ / 两位小数 / 条目文案 / 紧凑行三形态 / 分组头单值', () => {
    assert.equal(formatUsageAmount(-1, 'USD'), '∞');
    assert.equal(formatUsageAmount(3, 'USD'), '3.00 USD');
    assert.equal(formatUsageAmount(34.5555, '%'), '34.56%');

    assert.equal(usageItemText({remaining: 12.5, unit: 'CNY'}), '余额 12.50 CNY');
    assert.equal(usageItemText({planName: '5 小时', used: 30, unit: '%'}), '5 小时 已用 30.00%');
    assert.equal(usageItemText({isValid: false, invalidMessage: 'Key 无效'}), 'Key 无效');
    assert.equal(usageItemText({label: '剩余', value: '$3.20'}), '剩余 $3.20');

    // ── 显示规范 v1：账号卡紧凑行 / 分组头单值 ──
    // 币种型（官方引擎）：只显示总额，币种转符号；赠送/充值/账户可用留详情层
    assert.deepEqual(
        usageCompactLine({state: 'ok', items: [
            {label: '总额余额（CNY）', value: '48.47'},
            {label: '赠送余额（CNY）', value: '2.00'},
            {label: '账户可用', value: '是'},
        ]}),
        {prefix: '', parts: [{label: '', value: '¥48.47', tone: '', countdown: ''}]},
    );
    assert.equal(formatUsageCompactText({state: 'ok', items: [{label: '总额余额（USD）', value: '18.00'}]}), '$18.00');
    // value 自带 ¥ 前缀（SiliconFlow）不重复加符号
    assert.equal(formatUsageCompactText({state: 'ok', items: [{label: '总余额', value: '¥4.7'}]}), '¥4.7');
    // OpenRouter 没有「总额」行：优先「剩余」
    assert.equal(
        formatUsageCompactText({state: 'ok', items: [{label: '已购额度', value: '$5'}, {label: '剩余', value: '$3.2'}]}),
        '$3.2',
    );
    // NewAPI 货币 remaining 求和
    assert.equal(
        formatUsageCompactText({state: 'ok', items: [{remaining: 1, unit: 'USD'}, {remaining: 2, unit: 'USD'}]}),
        '$3.00',
    );

    // 已用型：窗口短名 + 前缀「已用：」，按剩余比例上色（≤0 红 / <20% 橙 / 其余绿）
    const used = usageCompactLine({state: 'ok', items: [
        {planName: '5 小时', used: 70, unit: '%'},
        {planName: '每周', used: 95, unit: '%'},
        {planName: '每月', used: 100, unit: '%'},
    ]});
    assert.equal(used.prefix, '已用：');
    assert.deepEqual(used.parts.map((p) => p.label + ' ' + p.value), ['5h 70%', '7d 95%', '30d 100%']);
    assert.deepEqual(used.parts.map((p) => p.tone), ['normal', 'warning', 'danger']);

    // 剩余型（SenseNova）：remaining/total 换算百分比，池名直接拼窗口短名
    const sense = usageCompactLine({state: 'ok', items: [
        {planName: '通用池 · 5 小时', poolName: '通用池', remaining: 850, total: 50000, unit: '%'},
        {planName: '通用池 · 每周', poolName: '通用池', remaining: 3800000, total: 5000000, unit: '%'},
    ]});
    assert.equal(sense.prefix, '剩余：');
    assert.deepEqual(sense.parts.map((p) => p.label), ['通用池5h', '通用池7d']);
    assert.deepEqual(sense.parts.map((p) => p.value), ['1.7%', '76%']);
    assert.deepEqual(sense.parts.map((p) => p.tone), ['warning', 'normal']);

    // 倒计时文本：⏱ 位置在 DOM，纯文本作「（…后重置）」后缀。
    // 时钟注入（now 与 resetAt 取同一瞬点）：倒计时按分钟向下取整，两次取 Date.now()
    // 之间只要跨过 1ms 就会掉进上一分钟（1h30m→1h29m），不钉住必闪烁。
    const countdownNow = Date.now();
    assert.equal(
        formatUsageCompactText({state: 'ok', items: [{planName: '每周', used: 40, unit: '%', resetAt: countdownNow + 90 * 60000}]}, countdownNow),
        '已用：7d: 40%（1h30m 后重置）',
    );
    assert.equal(formatUsageCompactText({state: 'error', error: 'HTTP 401'}), 'HTTP 401');
    assert.equal(formatUsageCompactText(null), '');
    // 已失效条目原位红字（全部失效时形态未知，不带前缀）
    assert.equal(
        formatUsageCompactText({state: 'ok', items: [{planName: '5 小时', used: 1, unit: '%', isValid: false, invalidMessage: 'Key 无效'}]}),
        '5h: Key 无效',
    );

    // 分组头单值：最紧约束
    assert.equal(usageTightSummary({state: 'ok', items: [{label: '总额余额（CNY）', value: '48.47'}]}).value, '¥48.47');
    const tightUsed = usageTightSummary({state: 'ok', items: [
        {planName: '5 小时', used: 70, unit: '%'},
        {planName: '每周', used: 37, unit: '%'},
    ]});
    assert.equal(tightUsed.label, '5h ');
    assert.equal(tightUsed.value, '70%');
    const tightSense = usageTightSummary({state: 'ok', items: [
        {planName: '通用池 · 5 小时', poolName: '通用池', remaining: 850, total: 50000, unit: '%'},
        {planName: '通用池 · 每周', poolName: '通用池', remaining: 3800000, total: 5000000, unit: '%'},
    ]});
    assert.equal(tightSense.label, '通用池5h ');
    assert.equal(tightSense.value, '1.7%');
    assert.equal(tightSense.tone, 'warning');
    assert.equal(usageTightSummary({state: 'error', error: 'HTTP 401'}).value, 'HTTP 401');
    assert.equal(usageTightSummary(null), null);

    // 规范基础记号：窗口短名 / 货币符号 / 百分比紧凑
    assert.equal(shortWindowName('5 小时'), '5h');
    assert.equal(shortWindowName('每周'), '7d');
    assert.equal(shortWindowName('每月'), '30d');
    assert.equal(shortWindowName('自定义窗口'), '自定义窗口');
    assert.equal(currencySymbolOf('CNY'), '¥');
    assert.equal(currencySymbolOf('USD'), '$');
    assert.equal(currencySymbolOf('%'), '');
    assert.equal(formatPercentCompact(0.004), '0%');
    assert.equal(formatPercentCompact(98.23), '98.2%');
    assert.equal(formatPercentCompact(120), '100%');
});

test('usageTone：按剩余 20% 阈值分绿/橙/红（对齐 cc-switch），只给数值上色', () => {
    // 有 total 时按 remaining/total 算剩余
    assert.equal(usageTone({remaining: 50, total: 100, unit: '%'}), 'normal');   // 剩 50%
    assert.equal(usageTone({remaining: 15, total: 100, unit: '%'}), 'warning');  // 剩 15% (<20)
    assert.equal(usageTone({remaining: 0, total: 100, unit: '%'}), 'danger');    // 用完
    assert.equal(usageTone({remaining: 82, total: 100, unit: '%'}), 'normal');   // 已用 18%
    // unit=% 但没 total：按 100-used
    assert.equal(usageTone({used: 30, unit: '%'}), 'normal');
    assert.equal(usageTone({used: 85, unit: '%'}), 'warning');
    assert.equal(usageTone({used: 100, unit: '%'}), 'danger');
    // 余额（无 total）不上色 → normal（绿）
    assert.equal(usageTone({remaining: 49.05, unit: 'CNY'}), 'normal');
    assert.equal(usageTone({isValid: false, invalidMessage: '过期'}), 'danger');
});

test('usageHeadlineParts：segments 分段、过滤「账户可用」、多套餐完整列出、优先 used%', () => {
    // DeepSeek 官方：过滤「账户可用」，显示总额余额
    const official = usageHeadlineParts({state: 'ok', items: [
        {label: '账户可用', value: '是', isValid: true},
        {label: '总额余额（CNY）', value: '49.05', isValid: true},
    ]});
    assert.equal(official.segments.length, 1);
    assert.equal(official.segments[0].label, '总额余额（CNY） ');
    assert.equal(official.segments[0].value, '49.05');
    assert.equal(official.segments[0].tone, 'normal');

    // 只剩「账户可用」时照常显示
    const onlyAvailable = usageHeadlineParts({state: 'ok', items: [{label: '账户可用', value: '是', isValid: true}]});
    assert.equal(onlyAvailable.segments[0].label, '账户可用 ');

    // 脚本多套餐：完整列出（不再聚合「N 个套餐」），各自带 tone
    const multi = usageHeadlineParts({state: 'ok', items: [
        {planName: '5 小时', used: 12, unit: '%', remaining: 880000, total: 100, isValid: true},
        {planName: '每周', used: 90, unit: '%', remaining: 500, total: 5000, isValid: true},
    ]});
    assert.equal(multi.segments.length, 2);
    assert.equal(multi.segments[0].label, '5 小时 ');
    assert.equal(multi.segments[0].value, '已用 12.00%');
    assert.equal(multi.segments[0].tone, 'normal');
    assert.equal(multi.segments[1].tone, 'warning'); // 剩 10% < 20%

    // unit=% 时优先 used 显示，remaining 不再套 % 单位（112911.76% 回归）
    const pct = usageHeadlineParts({state: 'ok', items: [
        {planName: '池1 · 5小时', used: 25, remaining: 11291176, total: 100, unit: '%', isValid: true},
    ]});
    assert.equal(pct.segments[0].value, '已用 25.00%');

    const err = usageHeadlineParts({state: 'error', error: 'HTTP 401'});
    assert.equal(err.segments[0].value, 'HTTP 401');
    assert.equal(err.segments[0].tone, 'danger');
    assert.equal(usageHeadlineParts(null).segments[0].tone, 'muted');
});

test('normalizeResetAt：秒/毫秒/ISO 归一，无效返回 0', () => {
    const sec = Math.floor(Date.now() / 1000) + 3600;
    assert.equal(normalizeResetAt(String(sec)), sec * 1000);
    assert.equal(normalizeResetAt(sec), sec * 1000);
    assert.ok(normalizeResetAt(new Date(Date.now() + 3600000).toISOString()) > Date.now());
    assert.equal(normalizeResetAt(''), 0);
    assert.equal(normalizeResetAt('not a date'), 0);
    assert.equal(normalizeResetAt(-5), 0);
});

test('formatUsageCountdown：d/h/m 只显示两个单位（对齐 cc-switch）', () => {
    const now = Date.now();
    assert.equal(formatUsageCountdown(now + (27 * 24 + 2) * 3600000, now), '27d2h');
    assert.equal(formatUsageCountdown(now + (1 * 60 + 55) * 60000, now), '1h55m');
    assert.equal(formatUsageCountdown(now + 55 * 60000, now), '55m');
    assert.equal(formatUsageCountdown(now - 1000, now), '');
    assert.equal(formatUsageCountdown(0, now), '');
});

test('formatUsageAge：分钟/小时分档', () => {
    const now = Date.now();
    assert.equal(formatUsageAge(now - 30000, now), '刚刚查询');
    assert.equal(formatUsageAge(now - 120000, now), '2 分钟前查询');
    assert.equal(formatUsageAge(now - 7200000, now), '2 小时前查询');
    assert.equal(formatUsageAge(now - 172800000, now), '2 天前查询');
    assert.equal(formatUsageAge(0), '');
});

test('createAIUsageQuota：查询写缓存、失败是快照不抛错、测试通道不写缓存', async () => {
    let httpCalls = 0;
    const quota = createAIUsageQuota({
        workerFactory: fakeWorkerFactory(),
        backend: () => ({
            async AIUsageHTTPRequest(specJSON) {
                httpCalls++;
                return {status: 200, contentType: 'application/json', body: JSON.stringify({balance: 5.5}), bytes: 20};
            },
        }),
    });
    const profile = {
        id: 'p1',
        name: '通用站',
        baseURL: 'https://relay.example.com/v1',
        apiKey: 'sk-x',
        usage: normalizeUsageConfig({enabled: true, template: 'general'}),
    };
    const first = await quota.queryAccountUsage(profile, {force: true});
    assert.equal(first.state, 'ok', first.error);
    assert.equal(first.items[0].remaining, 5.5);
    // 缓存生效：同账号再查（未 force）不打后端
    await quota.queryAccountUsage(profile);
    assert.equal(httpCalls, 1);
    assert.equal(quota.peek('p1').state, 'ok');

    // 测试通道：不写缓存
    const testOut = await quota.testConfig(profile, {enabled: true, template: 'general'});
    assert.equal(testOut.state, 'ok');
    assert.equal(httpCalls, 2);
    assert.equal(quota.peek('p1').at, first.at);

    // 失败也是快照
    const bad = createAIUsageQuota({
        workerFactory: fakeWorkerFactory(),
        backend: () => ({async AIUsageHTTPRequest() { throw new Error('net down'); }}),
    });
    const snap = await bad.queryAccountUsage({...profile, id: 'p2'}, {force: true});
    assert.equal(snap.state, 'error');
    assert.match(snap.error, /net down/);
});

test('createAIUsageQuota：官方模板走 AIUsageQuery，白名单外不自动查询', async () => {
    let officialCalls = 0;
    const quota = createAIUsageQuota({
        backend: () => ({
            async AIUsageQuery() {
                officialCalls++;
                return {supported: true, provider: 'DeepSeek', items: [{label: '总额余额（CNY）', value: '10'}]};
            },
        }),
    });
    const offProfile = {
        id: 'off',
        name: 'DeepSeek',
        baseURL: 'https://api.deepseek.com/v1',
        usage: normalizeUsageConfig({enabled: true, template: 'official'}),
    };
    const snapshot = await quota.queryAccountUsage(offProfile, {force: true});
    assert.equal(snapshot.state, 'ok');
    assert.equal(officialCalls, 1);
    assert.equal(snapshot.items[0].label, '总额余额（CNY）');

    // 白名单外的官方模板：sweep 不触发查询
    const relayProfile = {
        id: 'relay',
        name: '中转',
        baseURL: 'https://relay.example.com',
        usage: normalizeUsageConfig({enabled: true, template: 'official'}),
    };
    let changed = false;
    quota.sweep([relayProfile], () => { changed = true; });
    assert.equal(changed, false);
    assert.equal(officialCalls, 1);
});

test('createAIUsageQuota：invalidate 清内存与快照存储', async () => {
    const quota = createAIUsageQuota({
        workerFactory: fakeWorkerFactory(),
        backend: () => ({async AIUsageHTTPRequest() { return {status: 200, body: '{"balance":1}', bytes: 12}; }}),
    });
    const profile = {
        id: 'p3',
        baseURL: 'https://x.example.com',
        usage: normalizeUsageConfig({enabled: true, template: 'general'}),
    };
    await quota.queryAccountUsage(profile, {force: true});
    assert.ok(quota.peek('p3'));
    quota.invalidate('p3');
    assert.equal(quota.peek('p3'), null);
});

test('normalizeUsageConfig：坏值回落、extraFields 键限标识符、enabled 显式 true', () => {
    const cfg = normalizeUsageConfig({
        enabled: 1, // 非 true 布尔 → 关
        template: 'hacker',
        planProvider: 'nope',
        code: 42,
        extraFields: {'ok-key': 'v', good: 'kept', bad2: 'x', '9x': 'no', toomuch: undefined},
        timeoutSec: -5,
        autoIntervalMin: 99999,
    });
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.template, 'official');
    assert.equal(cfg.planProvider, 'kimi');
    assert.equal(cfg.code, '');
    // 合法标识符键保留（bad2 是合法名），带连字符 / 数字开头 / 空值丢弃
    assert.deepEqual(cfg.extraFields, {good: 'kept', bad2: 'x'});
    assert.equal(cfg.timeoutSec, 5);
    assert.equal(cfg.autoIntervalMin, 1440);
    assert.equal(normalizeUsageConfig(null).enabled, false);
    assert.equal(normalizeUsageConfig({enabled: true}).autoIntervalMin, 5);
    // 输入区外显：默认关，只有显式 true 才开（坏值回落，与 enabled 同口径）
    assert.equal(cfg.showInComposer, false);
    assert.equal(normalizeUsageConfig({showInComposer: 1}).showInComposer, false);
    assert.equal(normalizeUsageConfig({showInComposer: true}).showInComposer, true);
});
