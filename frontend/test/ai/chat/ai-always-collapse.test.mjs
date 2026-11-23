// 「AI 始终折叠」模式的判定与接线护栏。
//
// 判定是纯函数（src/ai/ai-always-collapse.js），接线横跨 main.js 设置项 /
// index.html 开关 / ai-settings-dialog 回填写入 / ai-panel 两处判定与菜单 /
// ai-tool-cards 思考块判定。任何一处掉了都表现为「开关点了没反应」或
// 「点开折叠头看到空白」，只靠手测很难发现，这里逐处钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    turnProcessDefaultExpanded,
    answerThinkingDefaultCollapsed,
    processThinkingDefaultCollapsed,
    shouldEnsureBody,
} from '../../../src/ai/chat/ai-always-collapse.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// ---- 轮级过程条默认展开 ----

test('默认模式：流式中展开、结束后按有无正文决定', () => {
    assert.equal(turnProcessDefaultExpanded(true, false, false), true);
    assert.equal(turnProcessDefaultExpanded(true, true, false), true);
    assert.equal(turnProcessDefaultExpanded(false, true, false), false);
    assert.equal(turnProcessDefaultExpanded(false, false, false), true);
});

test('始终折叠模式：四种组合全部收起', () => {
    assert.equal(turnProcessDefaultExpanded(true, false, true), false);
    assert.equal(turnProcessDefaultExpanded(true, true, true), false);
    assert.equal(turnProcessDefaultExpanded(false, true, true), false);
    assert.equal(turnProcessDefaultExpanded(false, false, true), false);
});

// ---- 回答气泡内思考块默认折叠 ----

test('默认模式思考块：流式 / expandThinking 展开，其余收起', () => {
    assert.equal(answerThinkingDefaultCollapsed(true, false, false), false);
    assert.equal(answerThinkingDefaultCollapsed(false, true, false), false);
    assert.equal(answerThinkingDefaultCollapsed(false, false, false), true);
    assert.equal(answerThinkingDefaultCollapsed(true, true, false), false);
});

test('始终折叠模式思考块：默认收起，但 expandThinking 显式联动优先展开', () => {
    assert.equal(answerThinkingDefaultCollapsed(true, false, true), true);
    assert.equal(answerThinkingDefaultCollapsed(false, false, true), true);
    // 回归：过程折叠体展开时传 expandThinking=true，里面的思考链必须跟着展开，
    // 不能被 alwaysCollapse 吞掉（否则用户展开过程体后看到的思考链全是收起的）。
    assert.equal(answerThinkingDefaultCollapsed(false, true, true), false);
    assert.equal(answerThinkingDefaultCollapsed(true, true, true), false);
});

// ---- 过程折叠体内思考块默认折叠 ----

test('过程区思考块：只决定默认值，默认模式展开、始终折叠收起', () => {
    assert.equal(processThinkingDefaultCollapsed(false), false);
    assert.equal(processThinkingDefaultCollapsed(true), true);
    // 边界值：undefined/null 不当成开启，回落默认展开
    assert.equal(processThinkingDefaultCollapsed(undefined), false);
    assert.equal(processThinkingDefaultCollapsed(null), false);
});

test('回归：过程区思考块的手动展开记忆优先于 alwaysCollapse（调用处接线）', () => {
    // 纯函数只给默认值；手动记忆（含 false=用户手动展开）必须在调用处优先，
    // 与回答气泡内思考块（storedThink !== undefined）同构。否则手动展开的思考块
    // 在任意 renderMessages(true) 后被强制收起。
    const code = read('src/ai/ai-panel.js');
    assert.match(code, /storedThink !== undefined\s*\n?\s*\?\s*storedThink\s*\n?\s*:\s*processThinkingDefaultCollapsed\(/,
        'renderProcessThinking 未让手动记忆优先于默认折叠判定');
});

// ---- R1：流式折叠态 body 预建 ----

test('body 预建：展开时必建；始终折叠 + 流式也要建（点开才不空白）', () => {
    assert.equal(shouldEnsureBody(true, false, false), true);
    assert.equal(shouldEnsureBody(true, true, false), true);
    assert.equal(shouldEnsureBody(false, true, false), false);
    assert.equal(shouldEnsureBody(false, true, true), true);
    // 始终折叠但轮次已结束：不必预建，点开时按需懒建即可
    assert.equal(shouldEnsureBody(false, false, true), false);
});

// ---- 接线护栏 ----

test('接线：main.js 默认关 + 存量归一', () => {
    const code = read('src/main.js');
    assert.match(code, /aiAlwaysCollapse:\s*false/, '默认值必须是关（会改变默认体验，须主动开启）');
    assert.match(code, /settings\.aiAlwaysCollapse = settings\.aiAlwaysCollapse === true/, '缺少存量配置归一（缺键即关）');
});

test('接线：设置页开关四处齐全', () => {
    const html = read('index.html');
    const panel = read('src/ai/ai-panel.js');
    const dialog = read('src/ai/settings/ai-settings-dialog.js');
    assert.match(html, /id="ai-opt-always-collapse"/, '设置页缺少开关 DOM');
    assert.match(panel, /alwaysCollapse:\s*document\.getElementById\('ai-opt-always-collapse'\)/, 'opt 表缺条目');
    assert.match(dialog, /opt\.alwaysCollapse\.checked = settings\.aiAlwaysCollapse === true/, '缺回填');
    assert.match(dialog, /opt\.alwaysCollapse\.addEventListener\('change'/, '缺写入');
});

test('接线：ai-panel 两处判定走纯函数 + 显示方式菜单有开关', () => {
    const code = read('src/ai/ai-panel.js');
    assert.match(code, /turnProcessDefaultExpanded\(/, 'renderTurn 未走纯函数判定');
    assert.match(code, /processThinkingDefaultCollapsed\(/, 'renderProcessThinking 未走纯函数判定');
    assert.match(code, /shouldEnsureBody\(/, 'R1 护栏：未预建流式折叠体 body');
    // 精确钉住菜单项：不能只搜「始终折叠」（注释里也有这词，会自证式假阳性）。
    // 菜单项必须真的写 settings.aiAlwaysCollapse + saveSettings + 重渲染，且 checked 绑定当前值。
    assert.match(code, /label:\s*'过程区始终折叠',\s*checked:\s*settings\.aiAlwaysCollapse === true/,
        '显示方式菜单缺少带 checked 绑定的「过程区始终折叠」项');
    assert.match(code, /label:\s*'过程区始终折叠'[\s\S]{0,200}settings\.aiAlwaysCollapse = settings\.aiAlwaysCollapse !== true[\s\S]{0,100}saveSettings\(\)/,
        '菜单项未写入设置或保存');
});

test('边界值：undefined/null 输入安全回落，不抛错', () => {
    assert.equal(turnProcessDefaultExpanded(undefined, undefined, undefined), true);
    assert.equal(turnProcessDefaultExpanded(null, null, null), true);
    assert.equal(answerThinkingDefaultCollapsed(undefined, undefined, undefined), true);
    assert.equal(answerThinkingDefaultCollapsed(null, null, null), true);
    assert.equal(shouldEnsureBody(undefined, undefined, undefined), false);
});

test('接线：ai-tool-cards 思考块判定走纯函数', () => {
    const code = read('src/ai/tools/ai-tool-cards.js');
    assert.match(code, /answerThinkingDefaultCollapsed\(/, '回答气泡内思考块未走纯函数判定');
});
