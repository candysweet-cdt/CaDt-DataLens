// ai-loop-guard 单测：双指标阈值、短行过滤、滑窗淘汰与离线分析入口。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoopGuard, analyzeReasoningLoop, LOOP_GUARD_DEFAULTS} from '../../../src/ai/chat/ai-loop-guard.js';

function loopText(repeats, linesPerCycle = 24) {
    const block = [];
    for (let i = 0; i < linesPerCycle; i += 1) {
        block.push('固定段落第 ' + i + ' 行：这是模型反复重复的一句话。');
    }
    return Array.from({length: repeats}, () => block.join('\n')).join('\n');
}

function diverseText(lines) {
    return Array.from({length: lines}, (_, i) => '第 ' + i + ' 行：文件 path/file-' + i + '.js:12 的上下文说明。').join('\n');
}

test('正常多样思考不触发任何级别', () => {
    const result = analyzeReasoningLoop(diverseText(400));
    assert.equal(result.level, '');
    assert.ok(result.stats.ratio > 0.8);
});

test('少量口头语 / 短行不误判', () => {
    const noisy = ['好的。', '}', '继续。', ''].join('\n').repeat(50) + '\n' + diverseText(200);
    const guard = createLoopGuard();
    guard.push(noisy);
    guard.flush();
    assert.equal(guard.verdict(), '');
});

test('同文重复达到 prompt 阈值：比例与最高重复次数同时满足', () => {
    const guard = createLoopGuard();
    guard.push(loopText(20));
    guard.flush();
    const stats = guard.stats();
    assert.ok(stats.maxRepeat >= LOOP_GUARD_DEFAULTS.promptRepeat);
    assert.ok(stats.ratio < LOOP_GUARD_DEFAULTS.promptRatio);
    assert.equal(guard.verdict(), 'prompt');
});

test('重复次数只到 warn 档时返回 warn，不到阈值返回空', () => {
    const warn = createLoopGuard();
    warn.push(loopText(10));
    warn.flush();
    assert.equal(warn.verdict(), 'warn');

    const quiet = createLoopGuard();
    quiet.push(loopText(3) + '\n' + diverseText(300));
    quiet.flush();
    assert.equal(quiet.verdict(), '');
});

test('行数与字符数不足时不判定', () => {
    const guard = createLoopGuard();
    guard.push(loopText(20, 4));
    guard.flush();
    assert.equal(guard.verdict(), '');
});

test('滑窗淘汰：循环停止后新内容把旧重复挤出窗口，判定恢复为空', () => {
    const guard = createLoopGuard({
        windowLines: 80,
        minLines: 40,
        minChars: 100,
        warnRepeat: 4,
        warnRatio: 0.5,
        promptRepeat: 6,
        promptRatio: 0.3,
    });
    guard.push(loopText(10, 12));
    guard.flush();
    assert.equal(guard.verdict(), 'prompt');
    guard.push(diverseText(200));
    guard.flush();
    assert.equal(guard.verdict(), '');
});

test('增量推送与整段推送结果一致；最后一行无换行也能计入', () => {
    const text = loopText(16) + '\n最后一行没有换行符但足够长';
    const whole = analyzeReasoningLoop(text);
    const guard = createLoopGuard();
    for (let i = 0; i < text.length; i += 37) guard.push(text.slice(i, i + 37));
    guard.flush();
    assert.deepEqual(guard.stats(), whole.stats);
    assert.equal(guard.verdict(), whole.level);
});

test('reset 清空窗口与计数', () => {
    const guard = createLoopGuard();
    guard.push(loopText(20));
    guard.flush();
    assert.equal(guard.verdict(), 'prompt');
    guard.reset();
    assert.deepEqual(guard.stats(), {chars: 0, lines: 0, uniq: 0, ratio: 1, maxRepeat: 0});
    assert.equal(guard.verdict(), '');
});
