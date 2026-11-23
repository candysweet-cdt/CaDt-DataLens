// ask_user 倒计时暂停/继续 + 超时保留草稿的接线测试。
// 逻辑内聚在 ai-panel.js 闭包（有计时器/持久化副作用，无法直接 import），按该文件的既有惯例做源码断言，
// 锁住「暂停冻结剩余 / 继续重算 deadline / ctx 注入 / 两处渲染接线 / 超时合并草稿」这些易断的契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = new URL('../../', import.meta.url);
const panel = readFileSync(fileURLToPath(new URL('src/ai/ai-panel.js', root)), 'utf8');
const cards = readFileSync(fileURLToPath(new URL('src/ai/chat/ai-ask-cards.js', root)), 'utf8');
const css = readFileSync(fileURLToPath(new URL('src/style.css', root)), 'utf8');

const fnBody = (src, startMark, endMark) => {
    const from = src.indexOf(startMark);
    assert.notEqual(from, -1, '缺少标记：' + startMark);
    const to = src.indexOf(endMark, from);
    assert.notEqual(to, -1, '缺少结束标记：' + endMark);
    return src.slice(from, to);
};

test('暂停逻辑：冻结剩余毫秒、清计时器；继续用剩余时间重算 deadline 并重启', () => {
    const toggle = fnBody(panel, 'function toggleAskPause(entry)', 'function submitAskAnswers');
    assert.match(toggle, /ask\.remainingMs = Math\.max\(0, ask\.deadline - Date\.now\(\)\)/, '暂停时冻结剩余时间');
    assert.match(toggle, /ask\.paused = true/, '暂停置位');
    assert.match(toggle, /clearAskTimers\(entry\)/, '暂停清计时器');
    assert.match(toggle, /ask\.deadline = Date\.now\(\) \+ ask\.remainingMs/, '继续时按剩余时间重算 deadline');
    assert.match(toggle, /ask\.paused = false/, '继续清除暂停位');
    assert.match(toggle, /setupAskTimer\(entry\)/, '继续重启计时器');
    assert.match(toggle, /persistSessions\(\)/, '暂停态持久化');
});

test('setupAskTimer 尊重暂停态：paused 时不启动计时器', () => {
    const setup = fnBody(panel, 'function setupAskTimer(entry)', '// 暂停/继续倒计时');
    assert.match(setup, /entry\.ask\.paused/, '起计时器前检查 paused');
});

test('倒计时文案：暂停时冻结在 remainingMs，显示「已暂停」', () => {
    const text = fnBody(panel, 'function askCountdownText(ask)', 'function updateAskCountdown');
    assert.match(text, /ask\.paused \? ask\.remainingMs/, '暂停时用 remainingMs 而非 wall clock');
    assert.match(text, /'已暂停 · 剩余 '/, '暂停文案');
});

test('不限时不显示倒计时文案：无 deadline 直接返回空，不再有「已忽略 N 秒」', () => {
    const text = fnBody(panel, 'function askCountdownText(ask)', 'function updateAskCountdown');
    assert.match(text, /if \(!ask\.deadline\) return ''/, '无 deadline 返回空串');
    assert.doesNotMatch(text, /本次不限时|已忽略/, '不再渲染"已忽略 N 秒"提示');
    // 渲染层两处都按文案为空就不建节点
    const head = fnBody(cards, 'const countdownText = askCountdownText(ask);', '// 临时收起');
    assert.match(head, /if \(countdownText\)/, '展开态按文案判空');
});

test('ask 数据：初始化与历史恢复都带 paused / remainingMs 字段', () => {
    const normalize = fnBody(panel, 'function normalizeAsk', '// 思考循环守卫记录');
    assert.match(normalize, /paused: !!raw\.paused/, '历史恢复 paused');
    assert.match(normalize, /remainingMs: Math\.max\(0, Number\(raw\.remainingMs\)/, '历史恢复 remainingMs');
    const create = fnBody(panel, 'const ask = {', 'const toolMessage = ctx.toolMessage;');
    assert.match(create, /paused: false/, '初始化 paused');
    assert.match(create, /remainingMs: 0/, '初始化 remainingMs');
});

test('ctx 注入：toggleAskPause 传给提问卡模块', () => {
    const ctx = fnBody(panel, 'const takeoverMod = createAITakeover({', 'const updateComposerTakeover');
    assert.match(ctx, /toggleAskPause,/, 'toggleAskPause 进入 ctx');
});

test('超时保留草稿：抽取草稿答案，已答保留、未答才套推荐项/交 AI', () => {
    const draft = fnBody(panel, 'function askDraftAnswersOf(entry)', 'function handleAskTimeout');
    assert.match(draft, /askDrafts\.get\(key\)/, '从 askDrafts 取草稿');
    assert.match(draft, /hasDraft/, '判定是否作答');
    const timeout = fnBody(panel, 'function handleAskTimeout(entry)', 'function setupAskTimer');
    assert.match(timeout, /askDraftAnswersOf\(entry\)/, '超时读取草稿');
    assert.match(timeout, /if \(draftAnswers\[qi\]\) return draftAnswers\[qi\]/, '已答优先');
    assert.match(timeout, /formatAskAnswers\(entry\.ask, draftAnswers,/, 'ai_decide 分支也带上已答');
});

test('提问卡渲染：展开态头部与收起态细条都挂暂停按钮，点击调 toggleAskPause', () => {
    assert.match(cards, /const toggleAskPause = ctx\.toggleAskPause;/, '解包 ctx');
    const btn = fnBody(cards, 'function askPauseButton(entry)', 'function askDraftFor');
    assert.match(btn, /ASK_PAUSE_SVG : ASK_PLAY_SVG|paused \? ASK_PLAY_SVG : ASK_PAUSE_SVG/, '按暂停态切图标');
    assert.match(btn, /toggleAskPause\(entry\)/, '点击调暂停切换');
    assert.match(btn, /e\.stopPropagation\(\)/, '阻止冒泡（收起态细条整块可点）');
    // 两处调用：展开态头 + 收起态细条
    const calls = cards.match(/askPauseButton\(entry\)/g) || [];
    assert.ok(calls.length >= 3, '至少定义 + 展开态 + 收起态三处出现');
});

test('收起态细条改 div + role=button，避免内嵌暂停按钮形成嵌套 button', () => {
    const bar = fnBody(cards, 'function renderAskCollapsedBar', 'return {askTakeoverKey');
    assert.match(bar, /createElement\('div'\)/, '细条用 div');
    assert.match(bar, /setAttribute\('role', 'button'\)/, '保留 button 语义');
    assert.match(bar, /tabIndex = 0/, '保留可聚焦');
});

test('CSS：暂停按钮样式存在且收起态不伸缩', () => {
    assert.match(css, /\.ai-ask-pause \{/, '暂停按钮基础样式');
    assert.match(css, /\.ai-takeover-bar \.ai-ask-pause \{[^}]*width: 18px/, '收起态尺寸');
});

test('快超时高亮：≤10 秒且未暂停时挂 urgent，暂停时移除', () => {
    assert.match(panel, /const ASK_URGENT_MS = 10000/, '高亮阈值常量');
    const update = fnBody(panel, 'function updateAskCountdown(entry)', 'function clearAskTimers');
    assert.match(update, /leftMs <= ASK_URGENT_MS/, '按阈值判定');
    assert.match(update, /!ask\.paused/, '暂停不高亮');
    assert.match(update, /classList\.toggle\('urgent', urgent\)/, '切换 urgent 类');
    const urgent = fnBody(css, '.ai-ask-countdown.urgent {', '.ai-ask-result');
    assert.match(urgent, /color: var\(--red\)/, '变红');
    assert.match(urgent, /font-weight: 600/, '加粗');
    assert.doesNotMatch(urgent, /animation|@keyframes/, '不做闪烁动画（用户要求）');
});

test('收起态留白：composer 在收起态降 min-height', () => {
    assert.match(css, /\.ai-composer:has\(> #ai-takeover > \.ai-takeover-bar\) \{[^}]*min-height: 0/,
        '收起态细条时输入框容器不再被 96px 撑高');
});
