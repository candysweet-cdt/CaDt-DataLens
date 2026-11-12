import test from 'node:test';
import assert from 'node:assert/strict';

import {createReadingState, READING_STATE_KEY} from './reading-state.js';

function memoryStorage() {
    const map = new Map();
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
        _map: map,
    };
}

test('updateBook/getBook 往返与路径归一化', () => {
    const st = createReadingState(memoryStorage());
    st.updateBook('D:\\OraSkyC\\Novel\\书\\正文', {progress: 0.5, lastUnitId: 'a.md#L3'});
    const b = st.getBook('d:/oraskyc/novel/书/正文');
    assert.ok(b, '大小写与反斜杠应归一化命中');
    assert.equal(b.progress, 0.5);
    assert.equal(st.getBook('别的书'), null);
});

test('书签去重与删除', () => {
    const st = createReadingState(memoryStorage());
    const first = st.addBookmark('k', {unitId: 'a.md#L1', ratio: 0.5, excerpt: '摘录', title: 'T', rel: 'a.md'});
    assert.ok(first.ok);
    const dup = st.addBookmark('k', {unitId: 'a.md#L1', ratio: 0.505, excerpt: 'x', title: 'T', rel: 'a.md'});
    assert.ok(!dup.ok, '同单元比例差 <0.02 应判重');
    const near = st.addBookmark('k', {unitId: 'a.md#L1', ratio: 0.6, excerpt: 'x', title: 'T', rel: 'a.md'});
    assert.ok(near.ok, '比例差 ≥0.02 不判重');
    const b = st.getBook('k');
    assert.equal(b.bookmarks.length, 2);
    assert.ok(st.removeBookmark('k', first.bookmark.id));
    assert.equal(st.getBook('k').bookmarks.length, 1);
    assert.ok(!st.removeBookmark('k', 'no-such'));
});

test('统计：累计、连续天数、每日裁剪', () => {
    const st = createReadingState(memoryStorage());
    const day = (offset) => {
        const d = new Date('2026-11-12T12:00:00');
        d.setDate(d.getDate() + offset);
        return d;
    };
    st.recordReading('k', 60, day(0));
    st.recordReading('k', 30, day(0));
    let stats = st.stats('k');
    assert.equal(stats.totalSec, 90);
    assert.equal(stats.streak, 1);
    st.recordReading('k', 10, day(1));
    stats = st.stats('k');
    assert.equal(stats.streak, 2, '昨天有阅读 → streak+1');
    st.recordReading('k', 10, day(3));
    stats = st.stats('k');
    assert.equal(stats.streak, 1, '中断 → 重置为 1');
    // 400 天前的数据应被裁剪
    st.recordReading('k', 5, day(-400));
    stats = st.stats('k');
    assert.ok(!Object.keys(stats.daily).some((k) => k < '2025-10-01'), '超过 365 天应裁剪');
});

test('最近阅读与遗忘', () => {
    const st = createReadingState(memoryStorage());
    st.touchRecent('a');
    st.touchRecent('b');
    st.touchRecent('a');
    assert.deepEqual(st.recent(), ['a', 'b']);
    st.forgetBook('a');
    assert.deepEqual(st.recent(), ['b']);
    assert.equal(st.getBook('a'), null);
});

test('持久化：flush 落盘 + 重新加载', () => {
    const ls = memoryStorage();
    const st = createReadingState(ls);
    st.updateBook('k', {progress: 0.42});
    assert.equal(ls.getItem(READING_STATE_KEY), null, '防抖未到不应写入');
    st.flush();
    assert.ok(ls.getItem(READING_STATE_KEY));
    const st2 = createReadingState(ls);
    assert.equal(st2.getBook('k').progress, 0.42);
});

test('损坏数据重建', () => {
    const ls = memoryStorage();
    ls.setItem(READING_STATE_KEY, '{not json');
    const st = createReadingState(ls);
    st.updateBook('k', {progress: 1});
    st.flush();
    const st2 = createReadingState(ls);
    assert.equal(st2.getBook('k').progress, 1);
});
