import test from 'node:test';
import assert from 'node:assert/strict';
import {classifierVerdictSnippet, jsonCandidates, parseClassifierVerdict} from '../../../src/ai/security/ai-classifier-verdict.js';

// ---------- 括号扫描 ----------

test('jsonCandidates：取出顶层对象、跳过未闭合、容忍字符串内花括号', () => {
    assert.deepEqual(jsonCandidates('{"a":1}'), ['{"a":1}']);
    assert.deepEqual(jsonCandidates('前缀 {"a":1} 后缀'), ['{"a":1}']);
    assert.deepEqual(jsonCandidates('{"a":{"b":2}}'), ['{"a":{"b":2}}']);
    assert.deepEqual(jsonCandidates('{"reason":"用 { 花括号 } 的命令","decision":"ask"}'),
        ['{"reason":"用 { 花括号 } 的命令","decision":"ask"}']);
    assert.deepEqual(jsonCandidates('{"a":1'), [], '未闭合不产出');
    assert.deepEqual(jsonCandidates('{"a":1}{"b":2}'), ['{"a":1}', '{"b":2}']);
    assert.deepEqual(jsonCandidates(''), []);
});

// ---------- 结构化解析 ----------

test('parseClassifierVerdict：标准 JSON', () => {
    assert.deepEqual(parseClassifierVerdict('{"decision":"allow","reason":"只读命令"}'),
        {allow: true, reason: '只读命令'});
    assert.deepEqual(parseClassifierVerdict('{"decision":"ask","reason":"写入工作区"}'),
        {allow: false, reason: '写入工作区'});
});

test('parseClassifierVerdict：代码块 / 前后解释 / 大小写都能认', () => {
    assert.equal(parseClassifierVerdict('```json\n{"decision":"allow","reason":"git status"}\n```').allow, true);
    assert.equal(parseClassifierVerdict('我判断如下：\n{"decision":"allow","reason":"只读"}\n以上。').allow, true);
    assert.equal(parseClassifierVerdict('{"decision":"ALLOW"}').allow, true);
    assert.equal(parseClassifierVerdict('{"verdict":"allow","note":"只读"}').allow, true);
});

test('parseClassifierVerdict：多个对象时以最后一个有效判定为准', () => {
    const text = '{"step":"分析中"}\n{"decision":"ask","reason":"需要联网"}';
    assert.deepEqual(parseClassifierVerdict(text), {allow: false, reason: '需要联网'});
});

test('parseClassifierVerdict：reason 缺失时的默认文案', () => {
    assert.deepEqual(parseClassifierVerdict('{"decision":"allow"}'), {allow: true, reason: ''});
    assert.deepEqual(parseClassifierVerdict('{"decision":"ask"}'), {allow: false, reason: '分类器建议人工确认'});
});

test('parseClassifierVerdict：对象里没有判定字段 → 不当成 JSON 结论', () => {
    const verdict = parseClassifierVerdict('{"usage":{"tokens":12}}');
    assert.equal(verdict.allow, false);
    assert.match(verdict.reason, /无法解析/);
});

// ---------- 纯文本兜底 ----------

test('parseClassifierVerdict：短答复纯文本 allow / ask', () => {
    assert.equal(parseClassifierVerdict('allow').allow, true);
    assert.equal(parseClassifierVerdict('允许').allow, false, '中文「允许」不在兜底白名单，保持 fail-closed');
    assert.equal(parseClassifierVerdict('ask').allow, false);
    assert.equal(parseClassifierVerdict('decision: allow').allow, true);
    assert.equal(parseClassifierVerdict('not allow').allow, false);
});

test('parseClassifierVerdict：长段落里的 allow 字样不构成放行', () => {
    const text = '这条命令看起来是只读的，理论上可以 allow，但它会写文件，所以我建议人工确认一下再执行。';
    assert.equal(parseClassifierVerdict(text).allow, false);
});

// ---------- fail-closed ----------

test('parseClassifierVerdict：空输出与垃圾输出一律转人工，并带片段定位', () => {
    assert.deepEqual(parseClassifierVerdict(''), {allow: false, reason: '分类器输出为空'});
    assert.deepEqual(parseClassifierVerdict('   \n '), {allow: false, reason: '分类器输出为空'});
    const garbage = parseClassifierVerdict('抱歉，我无法判断。');
    assert.equal(garbage.allow, false);
    assert.match(garbage.reason, /无法解析：抱歉/);
    assert.equal(parseClassifierVerdict(null).allow, false);
});

test('classifierVerdictSnippet：压平空白并截断', () => {
    assert.equal(classifierVerdictSnippet('  a\n b  '), 'a b');
    const long = 'x'.repeat(200);
    const snippet = classifierVerdictSnippet(long);
    assert.equal(snippet.length, 61, '60 字符 + 省略号');
    assert.ok(snippet.endsWith('…'));
});
