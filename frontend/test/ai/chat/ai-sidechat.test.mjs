// ai-sidechat.test.mjs：支线对话的纯函数护栏（引用块、列表排序、sideOf 判定）。
// 动作层（创建 / 带回 / 提升）依赖面板闭包，端到端行为靠手工回归清单（§6 第 11–13 条）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {sideChatQuote, isSideChat} from '../../../src/ai/chat/ai-sidechat.js';
import {orderSessionsWithSides} from '../../../src/ai/session/ai-session-list.js';

test('sideChatQuote：带来源标注，超长按行截断', () => {
    const quote = sideChatQuote('依赖调查', '第一行\n第二行');
    assert.ok(quote.startsWith('> 引用自「依赖调查」：'));
    assert.ok(quote.includes('> 第一行'));
    assert.ok(quote.includes('> 第二行'));
    assert.ok(quote.endsWith('\n\n'), '引用块后面要留空行，方便直接接打字');

    const long = Array.from({length: 12}, (_, i) => 'line' + i).join('\n');
    const cut = sideChatQuote('长文', long);
    assert.ok(cut.includes('> line7'), '前 8 行保留');
    assert.ok(!cut.includes('> line8'), '第 9 行起截断');
    assert.ok(cut.includes('> …'), '截断要有省略标记');
});

test('sideChatQuote：空正文返回空串（不预填无意义的引用）', () => {
    assert.equal(sideChatQuote('标题', ''), '');
    assert.equal(sideChatQuote('标题', '   '), '');
});

test('isSideChat：只认非空 sideOf', () => {
    assert.equal(isSideChat({sideOf: 'session-1'}), true);
    assert.equal(isSideChat({sideOf: '  '}), false);
    assert.equal(isSideChat({}), false);
    assert.equal(isSideChat(null), false);
});

test('orderSessionsWithSides：支线紧跟母会话，其余保持原顺序', () => {
    const list = [
        {id: 'a', sideOf: ''},
        {id: 'b', sideOf: ''},
        {id: 'c', sideOf: ''},
        {id: 'a1', sideOf: 'a'},
    ];
    const ids = orderSessionsWithSides(list).map((s) => s.id);
    assert.deepEqual(ids, ['a', 'a1', 'b', 'c']);
});

test('orderSessionsWithSides：多条支线按原顺序跟在母会话后', () => {
    const list = [
        {id: 'a'},
        {id: 'b'},
        {id: 'a2', sideOf: 'a'},
        {id: 'a1', sideOf: 'a'},
    ];
    const ids = orderSessionsWithSides(list).map((s) => s.id);
    assert.deepEqual(ids, ['a', 'a2', 'a1', 'b']);
});

test('orderSessionsWithSides：母会话缺失按普通会话处理，记录不丢', () => {
    const list = [{id: 'x', sideOf: 'gone'}, {id: 'y'}];
    const ids = orderSessionsWithSides(list).map((s) => s.id);
    assert.deepEqual(ids, ['x', 'y']);
    assert.equal(orderSessionsWithSides(list).length, list.length);
});

test('orderSessionsWithSides：sideOf 成环不死循环、不丢条目', () => {
    const list = [{id: 'p', sideOf: 'q'}, {id: 'q', sideOf: 'p'}];
    const out = orderSessionsWithSides(list);
    assert.equal(out.length, 2);
});

test('orderSessionsWithSides：空列表与自指都安全', () => {
    assert.deepEqual(orderSessionsWithSides([]), []);
    assert.deepEqual(orderSessionsWithSides(null), []);
    const self = [{id: 's', sideOf: 's'}];
    assert.equal(orderSessionsWithSides(self).length, 1);
});
