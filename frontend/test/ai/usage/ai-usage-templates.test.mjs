// ai-usage-templates.test.mjs —— 额度查询模板表与变量替换的护栏。
// 关键不变量：预设脚本可被解析（顶层对象字面量）、引用的 {{变量}} 都在已知清单、
// 变量替换是全量替换（多处命中都换）、plan 预设 id 表与字段表对齐。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    OFFICIAL_USAGE_HOSTS,
    USAGE_OAUTH_PROVIDERS,
    USAGE_TEMPLATE_LABELS,
    USAGE_NEWAPI_FIELDS,
    USAGE_PLAN_FIELDS,
    USAGE_PLAN_IDS,
    USAGE_PLAN_PRESETS,
    USAGE_TEMPLATE_KEYS,
    renderUsageVars,
    usageTemplatePresetCode,
} from '../../../src/ai/usage/ai-usage-templates.js';

test('模板键与标签一一对应（标签非空且互异）', () => {
    const labels = USAGE_TEMPLATE_KEYS.map((key) => USAGE_TEMPLATE_LABELS[key]);
    for (const label of labels) {
        assert.ok(label, '模板缺标签');
    }
    assert.equal(new Set(labels).size, labels.length, '模板标签重复');
    // 官方模板不走脚本管线
    assert.equal(usageTemplatePresetCode('official'), '');
});

test('预设脚本都是合法的对象字面量（new Function 解析不抛错）', () => {
    for (const key of USAGE_TEMPLATE_KEYS) {
        if (key === 'official') continue;
        // plan 模板的脚本挂在套餐预设上（无 planProvider 时为空，runQuery 会走预设表）
        const code = usageTemplatePresetCode(key, key === 'plan' ? 'kimi' : (key === 'oauth' ? 'sensenova' : undefined));
        assert.ok(code.length > 50, key + ' 的脚本是空的');
        const fn = new Function('return (' + code + ')');
        const cfg = fn();
        assert.equal(typeof cfg.extractor, 'function', key + ' 缺 extractor');
        assert.equal(typeof cfg.request.url, 'string', key + ' 缺 request.url');
    }
    assert.equal(usageTemplatePresetCode('plan', '不存在'), '');
});

test('plan 预设表：id 唯一、脚本可解析、字段表覆盖', () => {
    assert.equal(new Set(USAGE_PLAN_IDS).size, USAGE_PLAN_IDS.length);
    assert.equal(USAGE_PLAN_PRESETS.length, USAGE_PLAN_IDS.length);
    for (const preset of USAGE_PLAN_PRESETS) {
        const fn = new Function('return (' + preset.code + ')');
        const cfg = fn();
        assert.equal(typeof cfg.extractor, 'function', preset.id + ' 缺 extractor');
        assert.ok(Array.isArray(USAGE_PLAN_FIELDS[preset.id]), preset.id + ' 缺字段表');
    }
    // 智谱团队版必须带组织/项目两个字段（cc-switch：三者缺一不可）
    const team = USAGE_PLAN_FIELDS.zhipu_team.map((item) => item.key);
    assert.ok(team.includes('orgId') && team.includes('projectId'));
});

test('预设脚本引用的 {{变量}} 都在已知集合里', () => {
    const known = new Set(['baseUrl', 'apiKey', 'accessToken', 'userId', 'orgId', 'projectId']);
    const walk = (code) => [...code.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1]);
    for (const key of USAGE_TEMPLATE_KEYS) {
        const vars = walk(usageTemplatePresetCode(key));
        for (const name of vars) assert.ok(known.has(name), key + ' 引用了未知变量 {{' + name + '}}');
    }
    for (const preset of USAGE_PLAN_PRESETS) {
        for (const name of walk(preset.code)) {
            assert.ok(known.has(name), preset.id + ' 引用了未知变量 {{' + name + '}}');
            // 套餐专属变量必须出现在该套餐的字段表里（弹窗要能填它）
            const fieldKeys = USAGE_PLAN_FIELDS[preset.id].map((item) => item.key);
            if (!['baseUrl', 'apiKey'].includes(name)) {
                assert.ok(fieldKeys.includes(name), preset.id + ' 变量 {{' + name + '}} 不在字段表');
            }
        }
    }
});

test('newapi 模板声明了 accessToken / userId 字段', () => {
    const keys = USAGE_NEWAPI_FIELDS.map((item) => item.key);
    assert.deepEqual(keys, ['accessToken', 'userId']);
});

test('OAuth provider 表：id 唯一、脚本可解析、SenseNova 端点与重置口径正确', () => {
    assert.ok(USAGE_OAUTH_PROVIDERS.length >= 1);
    const ids = USAGE_OAUTH_PROVIDERS.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const provider of USAGE_OAUTH_PROVIDERS) {
        const cfg = new Function('return (' + provider.script + ')')();
        assert.equal(typeof cfg.extractor, 'function', provider.id + ' 缺 extractor');
        assert.ok(cfg.request.url.startsWith('https://'), provider.id + ' URL 非 https');
        assert.equal(cfg.request.method, 'GET');
    }
    const sense = USAGE_OAUTH_PROVIDERS.find((item) => item.id === 'sensenova');
    assert.ok(sense, '缺 SenseNova provider');
    assert.match(sense.script, /pool-usage/);
    assert.match(sense.script, /window_5h/);
    assert.match(sense.script, /grant_balance/);
    assert.match(sense.script, /reset_at/);
});

test('renderUsageVars：多处命中全量替换、未命中变量原样保留', () => {
    const out = renderUsageVars('{{apiKey}} {{baseUrl}} {{apiKey}} x={{unknown}}', {
        apiKey: 'sk-1', baseUrl: 'https://a.b',
    });
    assert.equal(out, 'sk-1 https://a.b sk-1 x={{unknown}}');
    // 值里带 {{ 不回环展开
    assert.equal(renderUsageVars('{{a}}', {a: '{{a}}'}), '{{a}}');
});

test('官方白名单 host 清单与前端图标/匹配口径一致', () => {
    assert.ok(OFFICIAL_USAGE_HOSTS.includes('api.deepseek.com'));
    assert.ok(OFFICIAL_USAGE_HOSTS.includes('openrouter.ai'));
    assert.ok(OFFICIAL_USAGE_HOSTS.some((host) => host.startsWith('api.siliconflow')));
});
