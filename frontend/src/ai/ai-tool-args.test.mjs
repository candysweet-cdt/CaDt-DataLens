import test from 'node:test';
import assert from 'node:assert/strict';
import {firstJsonObject, inspectToolArguments, safeToolArguments} from './ai-tool-args.js';

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
    const fixed = safeToolArguments(bad);
    assert.deepEqual(JSON.parse(fixed), {command: 'git status'});
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
