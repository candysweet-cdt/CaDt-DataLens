// core/tooltip.test.mjs：全局 tooltip 显示时机的护栏（只测纯函数，不引 DOM）。
// 产品规则（2026-11-16 用户反馈「鼠标一放上去就弹很打扰」）：
// 1) 普通 data-tip 必须「停留」才出现——鼠标扫过一排按钮时一个都不该弹；
// 2) 设置页 ⓘ 说明点（.info-tip）必须立即出现——用户是明确来求解释的，等一秒像没反应；
// 3) 气泡还在屏上时切到相邻锚点立即换内容，不在两个相邻图标之间空等；
// 4) 气泡刚消失后的热窗口里再贴到别的锚点只等 RESHOW（Windows TTDT_RESHOW 语义）。
// 5) data-tip-actions：坏数据整段丢弃不炸显示链路；气泡渲染绝不走 innerHTML（原始 HTML 不执行是硬要求）。
// 6) 动态内容（2026-11-18 用户反馈「AI 对话里动态块一出现 tooltip 就消失/不出现」）：
//    程序滚动（流式贴底）不掐 tooltip——指针还压在锚点上跟随重摆、锚点被换掉原地换锚；
//    只有用户手势后的滚动才立即隐藏。滚动处置判定见 resolveScrollAction。
// 基准：Windows UX 指南 initial 0.5s / reshow 0.1s；macOS NSInitialToolTipDelay 1s。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveTipDelay, parseTipActions, resolveScrollAction, SHOW_DELAY_MS, RESHOW_DELAY_MS } from '../../src/core/tooltip.js';

const css = readFileSync(new URL('../../src/style.css', import.meta.url), 'utf8');

test('普通 tooltip 走「停留」窗口，且窗口不能被悄悄调回悬停即弹', () => {
    assert.equal(resolveTipDelay(), SHOW_DELAY_MS);
    assert.ok(SHOW_DELAY_MS >= 500, '停留窗口 ' + SHOW_DELAY_MS + 'ms 太短，等于悬停即弹');
});

test('热窗口内的再次显示比首次快，但不能是 0（沿排浏览与乱扫要区分开）', () => {
    assert.equal(resolveTipDelay({ warm: true }), RESHOW_DELAY_MS);
    assert.ok(RESHOW_DELAY_MS > 0, '热窗口秒出＝扫过就有，和这次要治的毛病一样');
    assert.ok(RESHOW_DELAY_MS < SHOW_DELAY_MS, '热窗口必须明显短于首次停留窗口');
});

test('优先级：气泡还在屏上 > 热窗口 > 首次停留', () => {
    assert.equal(resolveTipDelay({ warm: true, showing: true }), 0);
    assert.equal(resolveTipDelay({ warm: false, showing: false }), SHOW_DELAY_MS);
});

test('设置页 ⓘ 说明点立即出现', () => {
    assert.equal(resolveTipDelay({ instant: true }), 0);
    assert.equal(resolveTipDelay({ instant: true, warm: true }), 0);
});

test('data-tip-delay 显式覆盖优先于其它所有规则', () => {
    assert.equal(resolveTipDelay({ delayAttr: '0', instant: false }), 0);
    assert.equal(resolveTipDelay({ delayAttr: '120', showing: true }), 120);
    assert.equal(resolveTipDelay({ delayAttr: '1500', instant: true, warm: true }), 1500);
});

test('data-tip-delay 垃圾值（空/非数字/负数）忽略，回落默认窗口', () => {
    for (const bad of ['', '   ', 'abc', '-1', 'NaN', null, undefined]) {
        assert.equal(resolveTipDelay({ delayAttr: bad }), SHOW_DELAY_MS, '应忽略 ' + JSON.stringify(bad));
    }
});

test('data-tip-actions 正常解析：label+action 均非空才收，空白裁掉', () => {
    assert.deepEqual(
        parseTipActions('[{"label":"去关闭","action":"ai:context-slim"}]'),
        [{label: '去关闭', action: 'ai:context-slim'}],
    );
    assert.deepEqual(
        parseTipActions('[{"label":"  去关闭  ","action":" ai:context-slim "}]'),
        [{label: '去关闭', action: 'ai:context-slim'}],
    );
});

test('data-tip-actions 坏数据整段/逐条丢弃，不让显示链路炸掉', () => {
    for (const bad of [null, undefined, '', '   ', '不是 JSON', '[1,2]', '{"label":"a"}', 'null', '"str"']) {
        assert.deepEqual(parseTipActions(bad), [], '应丢弃 ' + JSON.stringify(bad));
    }
    // 条目缺 label / 缺 action / 不是对象：跳过该条，不影响后面的合法条目
    assert.deepEqual(
        parseTipActions('[{"action":"a:1"},{"label":"x"},{"label":"好的","action":"a:2"}]'),
        [{label: '好的', action: 'a:2'}],
    );
});

test('data-tip-actions 上限约束：最多 3 条，label 截断防溢出版面', () => {
    const many = '[{"label":"a","action":"a:1"},{"label":"b","action":"a:2"},{"label":"c","action":"a:3"},{"label":"d","action":"a:4"}]';
    const parsed = parseTipActions(many);
    assert.equal(parsed.length, 3, '超出 3 条的部分应丢弃');
    const longLabel = '这行说明特别长，超出了气泡动作链接的合理长度上限';
    assert.equal(parseTipActions(JSON.stringify([{label: longLabel, action: 'a:1'}]))[0].label.length, 24);
});

test('气泡渲染绝不走 innerHTML——data-tip/data-tip-actions 是文本不是 HTML（硬要求）', () => {
    const src = readFileSync(new URL('../../src/core/tooltip.js', import.meta.url), 'utf8');
    assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(src), 'tooltip.js 里出现 HTML 写入会把 data-tip / actions 当 HTML 执行（注释里提「innerHTML」不算，只卡赋值/写入）');
});

test('两段式气泡（data-tip-title）标题与描述都经 textContent 写入', () => {
    const src = readFileSync(new URL('../../src/core/tooltip.js', import.meta.url), 'utf8');
    assert.match(src, /data-tip-title/, '缺少两段式气泡的标题读取');
    // renderTipContent 里标题/描述节点都必须走 textContent
    const block = src.match(/function renderTipContent\([\s\S]*?\n\}/);
    assert.ok(block, '缺少 renderTipContent');
    assert.match(block[0], /head\.textContent\s*=\s*title/, '标题必须 textContent 写入');
    assert.match(block[0], /body\.textContent\s*=\s*tip/, '描述必须 textContent 写入');
});

// ---- 滚动处置（2026-11-18：AI 流式贴底滚动把 tooltip 反复掐灭的回归护栏） ----

test('用户手势后的滚动照旧立即隐藏——气泡不跟手滚动，别被动态内容改掉这条', () => {
    assert.equal(resolveScrollAction({userGesture: true, bubbleVisible: true, anchorConnected: true, pointerOverAnchor: true}), 'hide-user');
    assert.equal(resolveScrollAction({userGesture: true, bubbleVisible: false}), 'hide-user');
});

test('程序滚动 + 指针还压在锚点上 = 跟随重摆，不许回到「滚动即隐藏」', () => {
    assert.equal(resolveScrollAction({userGesture: false, bubbleVisible: true, anchorConnected: true, pointerOverAnchor: true}), 'follow');
});

test('程序滚动 + 锚点被流式重渲染换掉 = 原地换锚，不是隐藏', () => {
    assert.equal(resolveScrollAction({userGesture: false, bubbleVisible: true, anchorConnected: false, pointerOverAnchor: false}), 'retether');
});

test('程序滚动把锚点挪出指针下才隐藏（此时进热窗口，指针被顶回要快出）', () => {
    assert.equal(resolveScrollAction({userGesture: false, bubbleVisible: true, anchorConnected: true, pointerOverAnchor: false}), 'hide');
});

test('气泡不在屏上时滚动不许取消待显示——流式每帧贴底会把它永远摁到不了点', () => {
    assert.equal(resolveScrollAction({userGesture: false, bubbleVisible: false, anchorConnected: true, pointerOverAnchor: true}), 'keep-pending');
    assert.equal(resolveScrollAction({userGesture: false, bubbleVisible: false, anchorConnected: false, pointerOverAnchor: false}), 'keep-pending');
});

test('滚动处置优先级：用户手势 > 气泡在屏 > 锚点连通/指针压锚', () => {
    // 用户手势优先于一切（即使指针还压着锚点也不跟随）
    assert.equal(resolveScrollAction({userGesture: true, bubbleVisible: true, anchorConnected: true, pointerOverAnchor: true}), 'hide-user');
    // 气泡不在屏上时不谈跟随/换锚
    assert.notEqual(resolveScrollAction({userGesture: false, bubbleVisible: false, anchorConnected: true, pointerOverAnchor: true}), 'follow');
});

test('浅色 tooltip 用白底 + 轻描边，不再与文字色混成灰块', () => {
    const block = css.match(/html\[data-theme="light"\] \.app-tip \{([^}]*)\}/s);
    assert.ok(block, '缺少浅色 .app-tip 覆盖');
    assert.match(block[1], /background:\s*#ffffff;/, '浅色 tooltip 必须是白底');
    assert.match(block[1], /border-color:\s*var\(--light-panel-line\);/, '描边要走浅色面板线');
    assert.match(block[1], /box-shadow:/, '需要柔和投影与背景拉开层次');
    assert.doesNotMatch(block[1], /color-mix\([^)]*var\(--text\)/, '不得再与文字色混色');
});
