// ai-usage-turn-refresh.test.mjs —— 轮次完成后自动补查用量的接线护栏。
// 行为依赖 Wails 后端与 DOM，node 里跑不了，只能锁源码接线点：
// 插在 finishStream（每轮收尾汇聚点），fire-and-forget、走节流、失败静默、只刷当前会话。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const panel = readFileSync(new URL('../../../src/ai/ai-panel.js', import.meta.url), 'utf8');

function sliceFunction(source, marker) {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, '找不到函数：' + marker);
    const end = source.indexOf('\n    function ', start + marker.length);
    return source.slice(start, end < 0 ? undefined : end);
}

test('finishStream：轮次完成后自动补查当前会话账号用量，静默且走节流', () => {
    const finish = sliceFunction(panel, 'function finishStream(target) {');
    const start = finish.indexOf('// 轮次完成后自动补查');
    assert.notEqual(start, -1, 'finishStream 里找不到轮末自动补查接线');
    const block = finish.slice(start);

    // 只在「正在查看 + 面板打开 + 自然完成（非停止/报错）」时触发
    assert.match(block, /session && wasViewed && isOpen\(\) && !current\.stopped && current\.assistant\.status === 'done'/);
    // 只补查当前会话绑定的账号，且账号开启了用量查询
    assert.match(block, /sessionModelRef\(session\)\.profile/);
    assert.match(block, /quotaUsage\.enabled/);
    // 走 queryAccountUsage 的节流路径（不传 force），不是每轮真发请求
    assert.match(block, /usageQuota\(\)\.queryAccountUsage\(quotaProfile\)/);
    assert.doesNotMatch(block, /queryAccountUsage\(quotaProfile,\s*\{\s*force:\s*true/);
    // fire-and-forget：void + then/catch，不 await、不 flash、不弹用量层
    assert.match(block, /void usageQuota\(\)\.queryAccountUsage\(quotaProfile\)\.then\(/);
    assert.match(block, /\.catch\(\(\) => \{/);
    assert.doesNotMatch(block, /flash\(/);
    assert.doesNotMatch(block, /showUsagePopover\(/);
    // 补查期间可能切会话：只刷新仍属于该会话的胶囊
    assert.match(block, /currentSession\(\) === session/);
    assert.match(block, /renderQuotaPill\(\)/);
});
