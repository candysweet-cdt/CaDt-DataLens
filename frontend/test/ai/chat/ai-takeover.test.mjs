// ai-takeover 纯函数测试：审批卡判定区的行描述（classifyVerdictRows）、ask 键盘导航（askNavAction）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyVerdictRows, askNavAction} from '../../../src/ai/chat/ai-takeover.js';

test('classifyVerdictRows：端侧 + AI 复核双层输出两行', () => {
    const rows = classifyVerdictRows({engine: '线性', score: 1.0, threshold: 0.15, aiReason: '联网请求并写入文件，非只读'});
    assert.equal(rows.length, 2);
    assert.equal(rows[0].chip, '端侧·线性');
    assert.equal(rows[0].score, 1);
    assert.equal(rows[0].threshold, 0.15);
    assert.equal(rows[0].hot, true);
    assert.equal(rows[1].chip, 'AI 复核');
    assert.equal(rows[1].reason, '联网请求并写入文件，非只读');
});

test('classifyVerdictRows：低分贴阈值不着红；仅端侧 / 仅 AI 复核各一行', () => {
    const low = classifyVerdictRows({engine: '线性', score: 0.16, threshold: 0.15});
    assert.equal(low.length, 1);
    assert.equal(low[0].hot, false);
    const sem = classifyVerdictRows({engine: 'MiniLM 语义', score: 0.96, threshold: 0.15});
    assert.equal(sem[0].chip, '端侧·MiniLM 语义');
    assert.equal(sem[0].hot, true);
    const aiOnly = classifyVerdictRows({aiReason: '读取文件并写入剪贴板，超出只读范围'});
    assert.equal(aiOnly.length, 1);
    assert.equal(aiOnly[0].chip, 'AI 复核');
    assert.equal(aiOnly[0].reason, '读取文件并写入剪贴板，超出只读范围');
});

test('classifyVerdictRows：空 / 异常输入安全兜底', () => {
    assert.deepEqual(classifyVerdictRows(null), []);
    assert.deepEqual(classifyVerdictRows({}), []);
    assert.deepEqual(classifyVerdictRows({engine: '', aiReason: ''}), []);
    // 分数越界收敛到 [0,1]
    const clamped = classifyVerdictRows({engine: '线性', score: 5, threshold: -1})[0];
    assert.equal(clamped.score, 1);
    assert.equal(clamped.threshold, 0);
});

// ---- ask 键盘导航 ----
const askCtx = (over) => Object.assign({
    multi: true, questionCount: 3, idx: 1, focusIndex: 0, itemCount: 4, inInput: false,
}, over || {});

test('askNavAction：左右在多题间前后切换，边界不动', () => {
    assert.deepEqual(askNavAction('ArrowLeft', askCtx()), {type: 'question', idx: 0});
    assert.deepEqual(askNavAction('ArrowRight', askCtx()), {type: 'question', idx: 2});
    assert.equal(askNavAction('ArrowLeft', askCtx({idx: 0})), null);
    assert.equal(askNavAction('ArrowRight', askCtx({idx: 2})), null);
});

test('askNavAction：单题不切问题；焦点在输入框时左右让位给光标', () => {
    assert.equal(askNavAction('ArrowLeft', askCtx({multi: false})), null);
    assert.equal(askNavAction('ArrowRight', askCtx({multi: false})), null);
    assert.equal(askNavAction('ArrowLeft', askCtx({inInput: true})), null);
    assert.equal(askNavAction('ArrowRight', askCtx({inInput: true})), null);
});

test('askNavAction：上下在选项间移动焦点，首尾钳制不回绕', () => {
    assert.deepEqual(askNavAction('ArrowDown', askCtx({focusIndex: 0})), {type: 'focus', index: 1});
    assert.deepEqual(askNavAction('ArrowUp', askCtx({focusIndex: 2})), {type: 'focus', index: 1});
    assert.deepEqual(askNavAction('ArrowDown', askCtx({focusIndex: 3, itemCount: 4})), {type: 'focus', index: 3});
    assert.deepEqual(askNavAction('ArrowUp', askCtx({focusIndex: 0})), {type: 'focus', index: 0});
});

test('askNavAction：上下对单题同样生效；无焦点/异常索引从首项起；无选项返回 null', () => {
    assert.deepEqual(askNavAction('ArrowDown', askCtx({multi: false, focusIndex: -1})), {type: 'focus', index: 0});
    assert.deepEqual(askNavAction('ArrowDown', askCtx({focusIndex: 999})), {type: 'focus', index: 3});
    assert.equal(askNavAction('ArrowDown', askCtx({itemCount: 0})), null);
});

test('askNavAction：输入框里上下仍可移出到选项；其他键不拦截', () => {
    assert.deepEqual(askNavAction('ArrowUp', askCtx({inInput: true, focusIndex: 2})), {type: 'focus', index: 1});
    assert.equal(askNavAction('Enter', askCtx()), null);
    assert.equal(askNavAction('Tab', askCtx()), null);
    assert.equal(askNavAction('ArrowLeft', null), null);
});
