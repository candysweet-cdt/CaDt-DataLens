// ai-session-merge.test.mjs —— 磁盘全量重读与内存会话的合并（元数据保活）纯函数测试。
//
// 背景：打开面板触发的 loadAll 会把所有会话正文重放一遍（秒级），这段窗口里用户改名 /
// 置顶 / 归档 / 改分组 / 清未读只写内存，等 next 到达时被磁盘版本整份覆盖。判定依据是
// store 在 writeMetaIfChanged 里打的 `_metaWrittenAt`：只有「本轮读盘开始之后」被本窗口
// 写过的会话才保留内存 meta，正文基线一律用磁盘的。
import test from 'node:test';
import assert from 'node:assert/strict';

import {mergeLoadedSessions} from '../../../src/ai/session/ai-session-merge.js';
import {buildSessionMeta} from '../../../src/ai/session/ai-session-store.js';

const metaOf = (session) => buildSessionMeta(session);

function memorySession(over) {
    return Object.assign({
        id: 's1',
        title: '内存标题',
        pinned: true,
        group: '内存分组',
        unread: '',
        archivedAt: 0,
        workspace: 'D:/w',
        scope: 'edit',
        messages: [{role: 'user', content: 'm1', _mid: 'mid1'}],
        archived: [],
        _mids: ['mid1'],
        _metaWrittenAt: 2000,
    }, over || {});
}

function diskSession(over) {
    return Object.assign({
        id: 's1',
        title: '磁盘标题',
        pinned: false,
        group: '',
        unread: 'done',
        archivedAt: 0,
        workspace: 'D:/w',
        scope: 'read',
        messages: [{role: 'user', content: 'm1', _mid: 'mid1'}, {role: 'assistant', content: 'a1', _mid: 'mid2'}],
        archived: [],
        _mids: ['mid1', 'mid2'],
    }, over || {});
}

test('读盘开始之后写过 meta 的会话：保留内存元数据', () => {
    const memory = [memorySession()];
    const next = mergeLoadedSessions(memory, [diskSession()], {readStartedAt: 1000, metaOf});
    assert.equal(next[0].title, '内存标题');
    assert.equal(next[0].pinned, true);
    assert.equal(next[0].group, '内存分组');
    assert.equal(next[0].unread, '', '刚清掉的未读不能被磁盘版本复活');
});

test('读盘开始之前写的（或从没写过）：用磁盘版本（不能回滚另一窗口的改动）', () => {
    const tooEarly = mergeLoadedSessions([memorySession({_metaWrittenAt: 500})], [diskSession()], {readStartedAt: 1000, metaOf});
    assert.equal(tooEarly[0].title, '磁盘标题');
    const never = mergeLoadedSessions([memorySession({_metaWrittenAt: 0})], [diskSession()], {readStartedAt: 1000, metaOf});
    assert.equal(never[0].title, '磁盘标题');
});

test('正文派生字段一律用磁盘：条数 / 时间键 / schema 版本', () => {
    const memory = [memorySession()];
    const disk = diskSession();
    disk.messageCount = 2;
    disk.archivedCount = 0;
    disk.turnTs = 111;
    disk.endTs = 222;
    disk.v = 1;
    const next = mergeLoadedSessions(memory, [disk], {readStartedAt: 1000, metaOf});
    assert.equal(next[0].messageCount, 2, '正文条数以磁盘重放结果为准（内存可能落后）');
    assert.equal(next[0].turnTs, 111);
    assert.equal(next[0].endTs, 222);
    assert.equal(next[0].v, 1);
});

test('正文与写入基线不被内存污染（messages / _mids 保持磁盘版本）', () => {
    const memory = [memorySession()];
    const disk = diskSession();
    const next = mergeLoadedSessions(memory, [disk], {readStartedAt: 1000, metaOf});
    assert.equal(next[0].messages.length, 2, '磁盘正文更权威');
    assert.deepEqual(next[0]._mids, ['mid1', 'mid2']);
});

test('磁盘上没有的会话不受影响（别处删了就不复活）', () => {
    const memory = [memorySession({id: 'gone'})];
    const next = mergeLoadedSessions(memory, [diskSession({id: 's1'})], {readStartedAt: 1000, metaOf});
    assert.deepEqual(next.map((s) => s.id), ['s1']);
});

test('缺 metaOf 时原样返回（防御：调用方漏传不能崩）', () => {
    const disk = diskSession();
    const next = mergeLoadedSessions([memorySession()], [disk], {readStartedAt: 1000});
    assert.equal(next[0], disk);
    assert.equal(next[0].title, '磁盘标题');
});

test('空输入安全', () => {
    assert.deepEqual(mergeLoadedSessions([], [], {readStartedAt: 1, metaOf}), []);
    assert.deepEqual(mergeLoadedSessions(null, [diskSession()], {readStartedAt: 1, metaOf}).length, 1);
});
