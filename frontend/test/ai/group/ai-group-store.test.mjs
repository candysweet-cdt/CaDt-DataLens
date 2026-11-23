// ai-group-store.test.mjs：共享日志编解码/重放（残行丢弃、streaming→interrupted）
// 与 Go 绑定适配器护栏（缺绑定即抛、调用透传）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createGroupStoreAdapter,
    encodeGroupEvent,
    encodeGroupMessage,
    groupHeaderLine,
    replayGroupLog,
} from '../../../src/ai/group/ai-group-store.js';

test('groupHeaderLine / encodeGroupMessage：字段与形状', () => {
    const header = JSON.parse(groupHeaderLine({id: 'g1', title: '评审', createdAt: 123, memberIds: ['a1', 'a2']}));
    assert.equal(header.kind, 'header');
    assert.equal(header.v, 2);
    assert.deepEqual(header.memberIds, ['a1', 'a2']);

    const line = JSON.parse(encodeGroupMessage({gid: 'gm-1', agentId: 'a1', content: '观点'}));
    assert.equal(line.kind, 'msg');
    assert.equal(line.role, 'assistant');
    assert.equal(line.status, 'done');
    assert.equal(line.timeout, false);
    assert.equal(line.hasPrivate, false);
});

test('encodeGroupEvent：系统事件行不占用 msg kind', () => {
    const evt = JSON.parse(encodeGroupEvent({type: 'round-start', round: 1}));
    assert.equal(evt.kind, 'meta');
    assert.equal(evt.type, 'round-start');
});

test('replayGroupLog：header/msg 分流、残行丢弃、streaming 归一 interrupted', () => {
    const text = [
        groupHeaderLine({id: 'g1', title: 't', createdAt: 1, memberIds: []}),
        encodeGroupMessage({gid: 'gm-1', content: '一'}),
        encodeGroupEvent({type: 'round-start', round: 1}),
        encodeGroupMessage({gid: 'gm-2', content: '二', status: 'streaming'}),
        '{"kind":"msg","gid":"gm-3","cont', // 崩溃残行
        'not-json', // 坏行
        '', // 空行
    ].join('\n');
    const replay = replayGroupLog(text);
    assert.equal(replay.header.id, 'g1');
    assert.equal(replay.messages.length, 2);
    assert.equal(replay.messages[0].gid, 'gm-1');
    assert.equal(replay.messages[1].gid, 'gm-2');
    assert.equal(replay.messages[1].status, 'interrupted');
    assert.equal(replay.events.length, 1);
    assert.equal(replay.events[0].type, 'round-start');
});

test('replayGroupLog：空输入 / 多 header 取首个', () => {
    assert.deepEqual(replayGroupLog(''), {header: null, messages: [], events: []});
    const text = [
        groupHeaderLine({id: 'g1', title: 'first', createdAt: 1, memberIds: []}),
        groupHeaderLine({id: 'g1', title: 'second', createdAt: 2, memberIds: []}),
    ].join('\n');
    const replay = replayGroupLog(text);
    assert.equal(replay.header.title, 'first');
});

test('createGroupStoreAdapter：缺绑定即抛 / 调用透传', async () => {
    assert.throws(() => createGroupStoreAdapter({}), /AIGroupList/);
    const calls = [];
    const backend = {
        AIGroupList: () => calls.push('list'),
        AIGroupRead: (id) => calls.push('read:' + id),
        AIGroupAppend: (id, lines) => calls.push('append:' + id + ':' + lines),
        AIGroupRewrite: () => calls.push('rewrite'),
        AIGroupWriteMeta: () => calls.push('meta'),
        AIGroupDelete: () => calls.push('delete'),
        AIGroupDeleteAll: () => calls.push('deleteAll'),
        AIGroupPrivateRead: (g, a) => calls.push('privRead:' + g + ':' + a),
        AIGroupPrivateAppend: () => calls.push('privAppend'),
        AIGroupPrivateRewrite: () => calls.push('privRewrite'),
    };
    const adapter = createGroupStoreAdapter(backend);
    adapter.list();
    adapter.read('g1');
    adapter.append('g1', 'x\n');
    adapter.privateRead('g1', 'a1');
    assert.deepEqual(calls, ['list', 'read:g1', 'append:g1:x\n', 'privRead:g1:a1']);
});
