import test from 'node:test';
import assert from 'node:assert/strict';
import {firstJsonObject, inspectToolArguments, safeToolArguments, detectFenceToolMisuse, fenceToolMisuseMessage} from '../../../src/ai/tools/ai-tool-args.js';

const isObject = (text) => {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value);
};

test('合法参数原样返回', () => {
    const text = '{"path":"a.txt","content":"x"}';
    assert.equal(safeToolArguments(text), text);
});

test('空参数返回 {}', () => {
    assert.equal(safeToolArguments(''), '{}');
    assert.equal(safeToolArguments(null), '{}');
    assert.equal(safeToolArguments('   '), '{}');
});

test('末尾多余右括号：保留第一个完整对象', () => {
    const bad = '{"questions":[{"id":"style","question":"q"}],"timeoutSec":300,"timeoutAction":"recommended"}}';
    const fixed = safeToolArguments(bad);
    assert.ok(isObject(fixed));
    assert.equal(JSON.parse(fixed).timeoutSec, 300);
});

test('末尾多余说明文字：保留第一个完整对象', () => {
    const bad = '{"command":"git status"} 多余文字 }';
    assert.deepEqual(JSON.parse(safeToolArguments(bad)), {command: 'git status'});
});

test('markdown 围栏包裹的参数可解出', () => {
    const bad = '```json\n{"command":"git push"}\n```';
    assert.deepEqual(JSON.parse(safeToolArguments(bad)), {command: 'git push'});
});

test('单引号等可修复损伤走 jsonrepair', () => {
    const fixed = safeToolArguments("{'command': 'git log'}");
    assert.deepEqual(JSON.parse(fixed), {command: 'git log'});
});

test('截断或完全无法解析时退化为 {}', () => {
    assert.equal(safeToolArguments('{"command": "git '), '{}');
    assert.equal(safeToolArguments('not json at all'), '{}');
    assert.equal(safeToolArguments('[1,2,3]'), '{}');
});

test('firstJsonObject 字符串感知，不把字符串内括号当结构', () => {
    assert.equal(firstJsonObject('{"text":"a } b","n":1} tail'), '{"text":"a } b","n":1}');
    assert.equal(firstJsonObject('no braces'), '');
});

test('inspectToolArguments 区分原样合法 / 修复成功 / 无法修复', () => {
    const ok = inspectToolArguments('{"a":1}');
    assert.deepEqual(ok, {text: '{"a":1}', valid: true, repaired: false});
    const fixed = inspectToolArguments('{"a":1}}');
    assert.equal(fixed.valid, false);
    assert.equal(fixed.repaired, true);
    assert.deepEqual(JSON.parse(fixed.text), {a: 1});
    const broken = inspectToolArguments('{"a": ');
    assert.deepEqual(broken, {text: '{}', valid: false, repaired: false});
});

test('detectFenceToolMisuse 命中被误当工具名的围栏语言', () => {
    assert.equal(detectFenceToolMisuse('mermaid'), 'mermaid');
    assert.equal(detectFenceToolMisuse('graph'), 'graph');
    assert.equal(detectFenceToolMisuse('svg'), 'svg');
    assert.equal(detectFenceToolMisuse('echarts'), 'echarts');
    assert.equal(detectFenceToolMisuse('wordcloud'), 'wordcloud');
    assert.equal(detectFenceToolMisuse('chart'), 'chart');
});

test('detectFenceToolMisuse 容忍大小写与首尾空白', () => {
    assert.equal(detectFenceToolMisuse('  SVG  '), 'svg');
    assert.equal(detectFenceToolMisuse('Mermaid'), 'mermaid');
});

test('detectFenceToolMisuse 忽略名字里混入的序列化噪声', () => {
    // 截图里第三个调用名把参数序列化标签混进了工具名，开头的语言标记仍应被识别。
    const noisy = 'svg' + '</' + 'arg_value:6124c78e>';
    assert.equal(detectFenceToolMisuse(noisy), 'svg');
});

test('detectFenceToolMisuse 不误伤正常工具名与空值', () => {
    assert.equal(detectFenceToolMisuse('read_file'), null);
    assert.equal(detectFenceToolMisuse('run_command'), null);
    assert.equal(detectFenceToolMisuse('svgchart'), null);
    assert.equal(detectFenceToolMisuse(''), null);
    assert.equal(detectFenceToolMisuse(null), null);
});

test('fenceToolMisuseMessage 给出可纠正的正文围栏指引', () => {
    const msg = fenceToolMisuseMessage('mermaid');
    assert.ok(msg.includes('mermaid'));
    assert.ok(msg.includes('正文'));
    assert.ok(msg.includes('围栏'));
    assert.ok(msg.includes('不是可调用工具'));
});