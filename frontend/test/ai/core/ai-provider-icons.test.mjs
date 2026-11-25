// ai-provider-icons.test.mjs —— 供应商图标注册表的护栏：键唯一、SVG body 干净
//（无脚本/事件属性）、host 匹配带端口剥离与子域、名称关键词兜底、首字母 Unicode 安全。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PROVIDER_ICONS,
    getProviderInitials,
    providerIconKeyForHost,
    providerIconKeyForName,
    providerIconSvg,
    providerIconTileHtml,
    resolveProviderIcon,
} from '../../../src/ai/core/ai-provider-icons.js';

test('注册表：键唯一、viewBox 是 24 栅格、body 无危险内容', () => {
    const keys = Object.keys(PROVIDER_ICONS);
    assert.ok(keys.length >= 15, '图标数不足：' + keys.length);
    assert.equal(new Set(keys).size, keys.length);
    for (const [key, icon] of Object.entries(PROVIDER_ICONS)) {
        assert.match(icon.viewBox, /^0 0 \d+ \d+$/, key + ' viewBox 异常');
        assert.ok(icon.body.length > 20, key + ' body 为空');
        assert.ok(!/<script/i.test(icon.body), key + ' body 含 script');
        assert.ok(!/on[a-z]+\s*=/i.test(icon.body), key + ' body 含事件属性');
        assert.ok(!/<svg/i.test(icon.body), key + ' body 嵌套 svg（外壳由 providerIconSvg 输出）');
        assert.ok(!/<title/i.test(icon.body), key + ' body 残留 title');
    }
});

test('providerIconSvg：外壳 fill currentColor，未注册返回空串', () => {
    const svg = providerIconSvg('deepseek', 18);
    assert.ok(svg.startsWith('<svg viewBox="0 0 24 24"'));
    assert.ok(svg.includes('fill="currentColor"'));
    assert.ok(svg.endsWith('</svg>'));
    assert.equal(providerIconSvg('nope', 18), '');
    assert.equal(providerIconSvg(undefined), '');
});

test('providerIconSvg：带渐变定义的图标（qwen）每次渲染 id 唯一且引用自洽', () => {
    const a = providerIconSvg('qwen', 18);
    const b = providerIconSvg('qwen', 18);
    assert.notEqual(a, b, '两次渲染的 defs id 必须不同，避免多实例 id 冲突');
    const idOf = (svg) => (svg.match(/id="(lobe-icons-qwen-fill[^"]*)"/) || [])[1];
    const refOf = (svg) => (svg.match(/url\(#(lobe-icons-qwen-fill[^)]*)\)/) || [])[1];
    assert.ok(idOf(a) && refOf(a), 'qwen svg 应含渐变定义与引用');
    assert.equal(idOf(a), refOf(a), '同一 svg 内 id 与 url(#) 引用必须一致');
    assert.notEqual(idOf(a), idOf(b));
});

test('host 匹配：精确 / 子域 / 端口剥离 / userinfo / 大小写', () => {
    assert.equal(providerIconKeyForHost('https://api.deepseek.com/v1'), 'deepseek');
    assert.equal(providerIconKeyForHost('https://api.deepseek.com:443/v1'), 'deepseek');
    assert.equal(providerIconKeyForHost('HTTPS://OPENROUTER.AI/api/v1'), 'openrouter');
    assert.equal(providerIconKeyForHost('https://user@api.kimi.com/coding/v1'), 'kimi');
    assert.equal(providerIconKeyForHost('https://api.minimaxi.com/v1'), 'minimax');
    // 子域后缀匹配
    assert.equal(providerIconKeyForHost('https://eu.api.anthropic.com/v1'), 'claude');
    // 新增厂商 host
    assert.equal(providerIconKeyForHost('https://opencode.ai/zen/v1'), 'opencode');
    assert.equal(providerIconKeyForHost('https://ark.cn-beijing.volces.com/api/v3'), 'doubao');
    assert.equal(providerIconKeyForHost('https://qianfan.baidubce.com/v2'), 'wenxin');
    assert.equal(providerIconKeyForHost('https://bedrock-runtime.us-east-1.amazonaws.com'), 'aws');
    assert.equal(providerIconKeyForHost('https://my.openai.azure.com/openai'), 'azure');
    assert.equal(providerIconKeyForHost('https://generativelanguage.googleapis.com/v1'), 'gemini');
    // 伪造后缀不命中
    assert.equal(providerIconKeyForHost('https://api.deepseek.com.evil.example.com/v1'), '');
    assert.equal(providerIconKeyForHost(''), '');
    assert.equal(providerIconKeyForHost('not a url'), '');
});

test('名称关键词：中文命中、伪造子串可接受（名称是弱信号）', () => {
    assert.equal(providerIconKeyForName('我的 DeepSeek 中转'), 'deepseek');
    assert.equal(providerIconKeyForName('智谱 GLM 官方'), 'zhipu');
    assert.equal(providerIconKeyForName('Kimi For Coding'), 'kimi');
    assert.equal(providerIconKeyForName('本地 ollama'), 'ollama');
    assert.equal(providerIconKeyForName('OpenCode Go'), 'opencode');
    assert.equal(providerIconKeyForName('豆包 · 火山方舟'), 'doubao');
    assert.equal(providerIconKeyForName('腾讯混元'), 'hunyuan');
    assert.equal(providerIconKeyForName('文心一言'), 'wenxin');
    assert.equal(providerIconKeyForName('Sub2API 自建'), 'sub2api');
    assert.equal(providerIconKeyForName('随便什么'), '');
    assert.equal(providerIconKeyForName(''), '');
});

test('resolveProviderIcon：host 优先于名称', () => {
    // baseURL 是 OpenAI 但名字提到 DeepSeek → host 赢
    assert.equal(resolveProviderIcon({baseURL: 'https://api.openai.com/v1', name: 'DeepSeek 备用'}), 'openai');
    assert.equal(resolveProviderIcon({baseURL: 'https://relay.example.com', name: 'DeepSeek 备用'}), 'deepseek');
    assert.equal(resolveProviderIcon({baseURL: 'https://relay.example.com', name: '中转站'}), '');
    assert.equal(resolveProviderIcon(null), '');
});

test('getProviderInitials：代理对不截半、空名退 AI', () => {
    assert.equal(getProviderInitials('DeepSeek'), 'D');
    assert.equal(getProviderInitials('智谱 GLM'), '智G');
    assert.equal(getProviderInitials(''), 'AI');
    assert.equal(getProviderInitials('   '), 'AI');
    // emoji 码位切分：不产生孤立代理项
    const initials = getProviderInitials('🤖 AI Bot');
    assert.ok(!/[\uD800-\uDFFF]/.test(initials.slice(0, 2)) || Array.from(initials).length <= 2);
});

test('providerIconTileHtml：命中走 SVG、未命中走首字母瓦片并 HTML 转义', () => {
    const hit = providerIconTileHtml({baseURL: 'https://api.deepseek.com', name: 'DeepSeek'}, 20);
    assert.ok(hit.includes('ai-picon-svg'));
    assert.ok(hit.includes('<svg'));

    const fallback = providerIconTileHtml({baseURL: '', name: '自定义中转站'}, 20);
    assert.ok(fallback.includes('ai-picon-fallback'));
    assert.ok(fallback.includes('>自<'));

    // 名称含 HTML 字符时转义（不产生活动内容）
    const evil = providerIconTileHtml({baseURL: '', name: '<img src=x onerror=1>'}, 20);
    assert.ok(!evil.includes('<img'));
    assert.ok(evil.includes('&lt;'));
});
