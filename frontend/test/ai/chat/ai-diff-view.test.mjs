// ai-diff-view.test.mjs —— 行级 diff 纯函数（V4 从 ai-panel.js 收编）：
// LCS 输出形状 / CRLF 归一 / 超限降级 / preview 裁剪与省略号。

import test from 'node:test';
import assert from 'node:assert/strict';
import {diffLinesOf, computeLineDiff, diffStats, buildDiffPreview, diffNoDigits} from '../../../src/ai/chat/ai-diff-view.js';

test('diffLinesOf：CRLF / CR 归一、去尾部空行、空输入', () => {
    assert.deepEqual(diffLinesOf('a\r\nb\r\n'), ['a', 'b']);
    assert.deepEqual(diffLinesOf('a\rb'), ['a', 'b']);
    assert.deepEqual(diffLinesOf(''), []);
    assert.deepEqual(diffLinesOf(null), []);
    assert.deepEqual(diffLinesOf('a\n\n'), ['a', '']);
});

test('computeLineDiff：相同行保留、增删行按 LCS 对齐', () => {
    const ops = computeLineDiff('a\nb\nc', 'a\nx\nc');
    assert.deepEqual(ops, [
        {t: ' ', text: 'a'},
        {t: '-', text: 'b'},
        {t: '+', text: 'x'},
        {t: ' ', text: 'c'},
    ]);
});

test('computeLineDiff：空 → 内容 / 内容 → 空', () => {
    const added = computeLineDiff('', 'x\ny');
    assert.deepEqual(added, [{t: '+', text: 'x'}, {t: '+', text: 'y'}]);
    const removed = computeLineDiff('x\ny', '');
    assert.deepEqual(removed, [{t: '-', text: 'x'}, {t: '-', text: 'y'}]);
});

test('computeLineDiff：超限走首尾对齐降级，公共前后缀保留', () => {
    // 超过 AI_DIFF_MAX_LINES(4000) 行：走降级分支，中间整段按 - 后 + 输出
    const oldText = Array.from({length: 2001}, (_, i) => 'old-' + i).join('\n');
    const newText = Array.from({length: 2001}, (_, i) => 'new-' + i).join('\n');
    const ops = computeLineDiff(oldText, newText);
    assert.equal(ops.length, 4002);
    // 首行不同 → 无公共前缀；全部 2001 行 old 为 -，2001 行 new 为 +
    assert.equal(ops.filter((op) => op.t === '-').length, 2001);
    assert.equal(ops.filter((op) => op.t === '+').length, 2001);
    // 相同前缀会被保留为上下文
    const same = 'same\n' + oldText;
    const sameNew = 'same\n' + newText;
    const ops2 = computeLineDiff(same, sameNew);
    assert.deepEqual(ops2[0], {t: ' ', text: 'same'});
});

test('diffStats：± 计数', () => {
    const ops = computeLineDiff('a\nb\nc', 'a\nc\nd');
    const stats = diffStats(ops);
    assert.equal(stats.removed, 1); // b
    assert.equal(stats.added, 1); // d
    assert.deepEqual(diffStats([]), {added: 0, removed: 0});
});

test('buildDiffPreview：改动行前后各留 2 行上下文，长间隔插入省略号', () => {
    const ops = [];
    for (let i = 0; i < 20; i++) ops.push({t: ' ', text: 'ctx' + i});
    ops.push({t: '+', text: 'new'});
    // 只有一条改动（末行）：保留改动行 ±2，前面只有 2 行上下文可留
    const preview = buildDiffPreview(ops);
    assert.equal(preview.truncated, false);
    assert.deepEqual(preview.lines.map((line) => line.text), ['ctx18', 'ctx19', 'new']);
    // 两处相距很远的改动：中间出现 '…'
    const ops2 = [
        {t: '+', text: 'first'},
        {t: ' ', text: 'a'},
        {t: ' ', text: 'b'},
        {t: ' ', text: 'c'},
        {t: ' ', text: 'd'},
        {t: ' ', text: 'e'},
        {t: '+', text: 'last'},
    ];
    const preview2 = buildDiffPreview(ops2);
    assert.ok(preview2.lines.some((line) => line.t === '…'));
});

test('buildDiffPreview：行号按完整 diff 计数，裁剪与省略号不重置', () => {
    const ops = [];
    for (let i = 0; i < 30; i++) ops.push({t: ' ', text: 'head' + i});
    ops.push({t: '-', text: 'old'});
    ops.push({t: '+', text: 'new'});
    for (let i = 0; i < 20; i++) ops.push({t: ' ', text: 'mid' + i});
    ops.push({t: '+', text: 'tail'});
    const preview = buildDiffPreview(ops);
    // 前 2 行上下文从第 29/30 行开始（不是 1）；省略号之后的行号继续按完整 diff 推进
    assert.deepEqual(preview.lines.slice(0, 3), [
        {t: ' ', text: 'head28', oldLine: 29, newLine: 29},
        {t: ' ', text: 'head29', oldLine: 30, newLine: 30},
        {t: '-', text: 'old', oldLine: 31, newLine: 0},
    ]);
    assert.ok(preview.lines.some((line) => line.t === '…'));
    assert.deepEqual(preview.lines.slice(-3), [
        {t: ' ', text: 'mid18', oldLine: 50, newLine: 50},
        {t: ' ', text: 'mid19', oldLine: 51, newLine: 51},
        {t: '+', text: 'tail', oldLine: 0, newLine: 52},
    ]);
});

test('buildDiffPreview：改动行不受行数上限约束，末尾 + 行不被吞', () => {
    // 事故回归：+28 −37 的审批卡只见红色 − 行、看不到任何 + 行。
    // 根因是旧实现按 ops 顺序累计到上限就 break，把排在后面的 + 行整段丢掉。
    // 现在上限只裁未改动的上下文（空格行），所有 +/- 改动行必留。
    const ops = [];
    for (let i = 0; i < 37; i++) ops.push({t: '-', text: 'old' + i});
    for (let i = 0; i < 28; i++) ops.push({t: '+', text: 'new' + i});
    const preview = buildDiffPreview(ops);
    assert.equal(preview.lines.filter((line) => line.t === '+').length, 28);
    assert.equal(preview.lines.filter((line) => line.t === '-').length, 37);
    assert.equal(preview.truncated, false);
    // 末尾的 + 行必须出现在预览里
    assert.deepEqual(preview.lines[preview.lines.length - 1], {t: '+', text: 'new27', oldLine: 0, newLine: 28});
});

test('buildDiffPreview：超限时只裁上下文，改动行仍全留且 truncated 为真', () => {
    // 30 处改动各隔 10 行上下文：保留的上下文（每处 ±2）合计远超 40 行上限，
    // 上下文被裁、插省略号、truncated=true，但 30 条 + 改动行一条不少。
    const ops = [];
    for (let c = 0; c < 30; c++) {
        for (let k = 0; k < 10; k++) ops.push({t: ' ', text: 'ctx' + c + '-' + k});
        ops.push({t: '+', text: 'add' + c});
    }
    const preview = buildDiffPreview(ops);
    assert.equal(preview.truncated, true);
    assert.equal(preview.lines.filter((line) => line.t === '+').length, 30);
    assert.deepEqual(preview.lines[preview.lines.length - 1], {t: '+', text: 'add29', oldLine: 0, newLine: 330});
    assert.ok(preview.lines.some((line) => line.t === '…'));
});

test('buildDiffPreview：无改动时保留首行；空 ops 返回空', () => {
    const unchanged = computeLineDiff('a\nb', 'a\nb');
    const preview = buildDiffPreview(unchanged);
    assert.equal(preview.lines.length, 1);
    assert.deepEqual(preview.lines[0], {t: ' ', text: 'a', oldLine: 1, newLine: 1});
    assert.deepEqual(buildDiffPreview([]), {lines: [], truncated: false});
});

test('diffNoDigits：取整份 diff 最大行号的位数，少于 3 位保 3 位基线', () => {
    // 事故场景：main.js 3091 行附近，4 位行号把 22px 行号列撑爆
    assert.equal(diffNoDigits([{t: ' ', text: '}', oldLine: 3091, newLine: 3091}]), 4);
    // 删行看 oldLine、加行看 newLine，两侧取最大
    assert.equal(diffNoDigits([
        {t: '-', text: 'x', oldLine: 999, newLine: 0},
        {t: '+', text: 'y', oldLine: 0, newLine: 1001},
    ]), 4);
    // 五位数（万行大文件）也要撑开
    assert.equal(diffNoDigits([{t: '+', text: 'x', oldLine: 0, newLine: 12000}]), 5);
    // 两位行号不缩列
    assert.equal(diffNoDigits([{t: '+', text: 'x', oldLine: 0, newLine: 42}]), 3);
    // 旧会话无行号字段：退回行数连数的上限
    assert.equal(diffNoDigits([{t: '+', text: 'x'}]), 3);
    assert.equal(diffNoDigits(new Array(1000).fill({t: '+'})), 4);
    // 空与异常输入：基线 3 位
    assert.equal(diffNoDigits([]), 3);
    assert.equal(diffNoDigits(null), 3);
});
