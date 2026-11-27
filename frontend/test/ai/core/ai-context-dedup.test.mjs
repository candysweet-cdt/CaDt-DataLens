// ai-context-dedup 单测（S6）：digest 稳定、headerEquals 段落比较、warm cache 命中/LRU/失效。
import test from 'node:test';
import assert from 'node:assert/strict';
import {contextDigest, headerEquals, createContextWarmCache} from '../../../src/ai/core/ai-context-dedup.js';

test('contextDigest：同文同摘要、异文异摘要、容忍非字符串', () => {
    assert.equal(contextDigest('abc'), contextDigest('abc'));
    assert.notEqual(contextDigest('abc'), contextDigest('abd'));
    assert.equal(contextDigest(null), contextDigest(''));
    assert.match(contextDigest('x'), /^[0-9a-f]{8}$/);
});

test('headerEquals：逐段比较，忽略空行与段内首尾空白', () => {
    assert.equal(headerEquals('A\n\nB', '  A  \n\n\nB'), true);
    assert.equal(headerEquals('A\n\nB', 'A\n\nC'), false);
    assert.equal(headerEquals('A\n\nB', 'A\n\nB\n\nC'), false);
    assert.equal(headerEquals('', ''), true);
});

test('createContextWarmCache：digest 命中复用、变化重算', () => {
    const cache = createContextWarmCache();
    let builds = 0;
    const build = () => { builds += 1; return 'STABLE'; };
    assert.equal(cache.get('s1', 'd1', build), 'STABLE');
    assert.equal(cache.get('s1', 'd1', build), 'STABLE');
    assert.equal(builds, 1, '同 digest 不应重算');
    assert.equal(cache.get('s1', 'd2', build), 'STABLE');
    assert.equal(builds, 2, 'digest 变化必须重算');
    assert.deepEqual(cache.stats, {hits: 1, misses: 2});
});

test('createContextWarmCache：按 key 隔离、invalidate / clear', () => {
    const cache = createContextWarmCache();
    cache.get('s1', 'd', () => 'A');
    cache.get('s2', 'd', () => 'B');
    assert.equal(cache.get('s1', 'd', () => 'X'), 'A');
    assert.equal(cache.get('s2', 'd', () => 'X'), 'B');
    assert.equal(cache.invalidate('s1'), true);
    assert.equal(cache.get('s1', 'd', () => 'NEW'), 'NEW');
    cache.clear();
    assert.equal(cache.size, 0);
});

test('createContextWarmCache：LRU 淘汰最久未用槽', () => {
    const cache = createContextWarmCache({limit: 2});
    cache.get('a', 'd', () => 'A');
    cache.get('b', 'd', () => 'B');
    cache.get('a', 'd', () => 'A'); // a 变成最近使用
    cache.get('c', 'd', () => 'C'); // 淘汰 b
    assert.equal(cache.has('b'), false);
    assert.equal(cache.has('a'), true);
    assert.equal(cache.has('c'), true);
});
