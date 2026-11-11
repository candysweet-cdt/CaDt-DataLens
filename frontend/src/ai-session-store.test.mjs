import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AI_SESSION_SCHEMA,
    encodeSessionHeader,
    encodeMessageEvent,
    encodeTruncateEvent,
    encodeArchiveEvent,
    encodeResetEvent,
    encodeMetaEvent,
    encodeSessionLines,
    replaySessionLog,
    serializeSessionMessage,
    buildSessionMeta,
    createSessionDiskStore,
} from './ai-session-store.js';

function logOf(...events) {
    return encodeSessionLines(events);
}

test('header + messages replay', () => {
    const text = logOf(
        encodeSessionHeader({id: 's1', title: '标题', createdAt: 100, workspace: 'D:/w'}),
        encodeMessageEvent({role: 'user', content: '你好', ts: 1}, 'm-1', false),
        encodeMessageEvent({role: 'assistant', content: '在', ts: 2}, 'm-2', false),
    );
    const result = replaySessionLog(text);
    assert.equal(result.header.id, 's1');
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0]._mid, 'm-1');
    assert.equal(result.messages[1].content, '在');
    assert.equal(result.issues, 0);
    assert.equal(result.torn, false);
});

test('truncate keeps prefix', () => {
    const text = logOf(
        encodeSessionHeader({id: 's1'}),
        encodeMessageEvent({role: 'user', content: 'a', ts: 1}, 'm-1', false),
        encodeMessageEvent({role: 'assistant', content: 'b', ts: 2}, 'm-2', false),
        encodeMessageEvent({role: 'user', content: 'c', ts: 3}, 'm-3', false),
        encodeTruncateEvent(2),
        encodeMessageEvent({role: 'user', content: 'd', ts: 4}, 'm-4', false),
    );
    const result = replaySessionLog(text);
    assert.deepEqual(result.messages.map((m) => m.content), ['a', 'b', 'd']);
});

test('archive moves prefix and sets summary', () => {
    const text = logOf(
        encodeSessionHeader({id: 's1'}),
        encodeMessageEvent({role: 'user', content: 'a', ts: 1}, 'm-1', false),
        encodeMessageEvent({role: 'assistant', content: 'b', ts: 2}, 'm-2', false),
        encodeMessageEvent({role: 'user', content: 'c', ts: 3}, 'm-3', false),
        encodeArchiveEvent(2, {text: '摘要', upTo: 2}),
    );
    const result = replaySessionLog(text);
    assert.deepEqual(result.archived.map((m) => m.content), ['a', 'b']);
    assert.deepEqual(result.messages.map((m) => m.content), ['c']);
    assert.equal(result.summary.text, '摘要');
});

test('reset clears live and archived', () => {
    const text = logOf(
        encodeSessionHeader({id: 's1'}),
        encodeMessageEvent({role: 'user', content: 'a', ts: 1}, 'm-1', true),
        encodeArchiveEvent(0, {text: '摘要'}),
        encodeResetEvent(),
    );
    const result = replaySessionLog(text);
    assert.equal(result.messages.length, 0);
    assert.equal(result.archived.length, 0);
    assert.equal(result.summary, null);
});

test('torn tail is ignored', () => {
    const complete = logOf(
        encodeSessionHeader({id: 's1'}),
        encodeMessageEvent({role: 'user', content: 'a', ts: 1}, 'm-1', false),
    );
    const result = replaySessionLog(complete + '{"v":1,"t":"msg","mid":"m-2"');
    assert.equal(result.messages.length, 1);
    assert.equal(result.torn, true);
});

test('malformed lines are skipped and counted', () => {
    const text = logOf(encodeSessionHeader({id: 's1'})) + 'not json\n' + encodeSessionLines([
        encodeMessageEvent({role: 'user', content: 'a', ts: 1}, 'm-1', false),
    ]);
    const result = replaySessionLog(text);
    assert.equal(result.issues, 1);
    assert.equal(result.messages.length, 1);
});

test('serialize strips inline image data when file exists', () => {
    const message = {
        role: 'user',
        content: '',
        ts: 1,
        _mid: 'm-1',
        images: [{id: 'img-1', mime: 'image/png', data: 'AAAA', file: 'images/img-1.png'}],
    };
    const out = serializeSessionMessage(message);
    assert.equal(out._mid, undefined);
    assert.equal(out.images[0].data, undefined);
    assert.equal(out.images[0].file, 'images/img-1.png');
});

test('serialize keeps inline data when file missing', () => {
    const out = serializeSessionMessage({
        role: 'user',
        content: '',
        ts: 1,
        images: [{id: 'img-1', mime: 'image/png', data: 'AAAA'}],
    });
    assert.equal(out.images[0].data, 'AAAA');
});

test('meta patch applies', () => {
    const text = logOf(
        encodeSessionHeader({id: 's1'}),
        encodeMetaEvent({title: '新标题', summary: {text: '摘要'}}),
    );
    const result = replaySessionLog(text);
    assert.equal(result.meta.title, '新标题');
    assert.equal(result.summary.text, '摘要');
});

test('buildSessionMeta counts messages and archived', () => {
    const meta = buildSessionMeta({
        id: 's1',
        title: 't',
        createdAt: 1,
        updatedAt: 2,
        messages: [{role: 'user'}, {role: 'assistant'}],
        archived: [{role: 'user'}],
        summary: {text: 's'},
    });
    assert.equal(meta.v, AI_SESSION_SCHEMA);
    assert.equal(meta.messageCount, 2);
    assert.equal(meta.archivedCount, 1);
    assert.equal(meta.summary.text, 's');
});

function fakeBackend() {
    const logs = new Map();
    const metas = new Map();
    const images = new Map();
    return {
        _logs: logs,
        _metas: metas,
        _images: images,
        async AISessionList() {
            return Array.from(metas.values());
        },
        async AISessionRead(id) {
            return logs.get(id) || '';
        },
        async AISessionAppend(id, lines) {
            logs.set(id, (logs.get(id) || '') + lines);
        },
        async AISessionRewrite(id, content) {
            logs.set(id, content);
        },
        async AISessionWriteMeta(id, data) {
            metas.set(id, data);
        },
        async AISessionDelete(id) {
            logs.delete(id);
            metas.delete(id);
        },
        async AISessionDeleteAll() {
            logs.clear();
            metas.clear();
        },
        async AIEnsureDir() {},
        async SaveDataURL(path, dataURL) {
            images.set(path, dataURL);
        },
        async ReadImageAsDataURL(path) {
            return images.get(path) || '';
        },
        async AISessionSaveImage(id, name, dataURL) {
            images.set(id + '/' + name, dataURL);
            return 'images/' + name;
        },
        async AISessionReadImage(id, name) {
            return images.get(id + '/' + name) || '';
        },
    };
}

function newSession(extra) {
    return Object.assign({
        id: 's1',
        title: '测试',
        createdAt: 1,
        updatedAt: 1,
        workspace: 'D:/w',
        messages: [],
        archived: [],
        summary: null,
    }, extra);
}

test('disk store: persist, reload, truncate', async () => {
    const backend = fakeBackend();
    const store = createSessionDiskStore({backend});
    const session = newSession({messages: [{role: 'user', content: 'a', ts: 1}]});
    await store.persistSession(session);
    await store.flush();
    let loaded = await store.loadAll(null);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].messages.length, 1);
    assert.ok(backend._logs.get('s1').startsWith('{"v":1,"t":"header"'), '正文首行必须是 header');

    session.messages.push({role: 'assistant', content: 'b', ts: 2, status: 'done'});
    await store.persistSession(session);
    await store.flush();
    loaded = await store.loadAll(null);
    assert.deepEqual(loaded[0].messages.map((m) => m.content), ['a', 'b']);

    session.messages = session.messages.slice(0, 1);
    await store.persistSession(session);
    await store.flush();
    loaded = await store.loadAll(null);
    assert.deepEqual(loaded[0].messages.map((m) => m.content), ['a']);
});

test('disk store: streaming messages are not persisted until final', async () => {
    const backend = fakeBackend();
    const store = createSessionDiskStore({backend});
    const session = newSession({messages: [{role: 'user', content: 'q', ts: 1}]});
    await store.persistSession(session);
    session.messages.push({role: 'assistant', content: '部分', ts: 2, status: 'streaming'});
    await store.persistSession(session);
    await store.flush();
    let loaded = await store.loadAll(null);
    assert.equal(loaded[0].messages.length, 1);
    session.messages[1].status = 'done';
    await store.persistSession(session);
    await store.flush();
    loaded = await store.loadAll(null);
    assert.equal(loaded[0].messages.length, 2);
});

test('disk store: archive moves messages and keeps summary', async () => {
    const backend = fakeBackend();
    const store = createSessionDiskStore({backend});
    const session = newSession({messages: [
        {role: 'user', content: 'a', ts: 1},
        {role: 'assistant', content: 'b', ts: 2, status: 'done'},
        {role: 'user', content: 'c', ts: 3},
    ]});
    await store.persistSession(session);
    const summary = {text: '摘要', upTo: 2};
    const moved = session.messages.slice(0, 2);
    await store.archiveSession(session, 2, summary);
    session.messages = session.messages.slice(2);
    session.archived = session.archived.concat(moved);
    session.summary = summary;
    await store.persistSession(session);
    await store.flush();
    assert.ok(backend._logs.get('s1').includes('"t":"archive"'), '归档应追加 archive 事件而不是整份重写');
    // 归档后继续追加，前缀差分不能把剩余消息截掉
    session.messages.push({role: 'assistant', content: 'd', ts: 4, status: 'done'});
    await store.persistSession(session);
    await store.flush();
    const loaded = await store.loadAll(null);
    assert.deepEqual(loaded[0].messages.map((m) => m.content), ['c', 'd']);
    assert.deepEqual(loaded[0].archived.map((m) => m.content), ['a', 'b']);
    assert.equal(loaded[0].summary.text, '摘要');
});

test('disk store: images externalized and rehydrated', async () => {
    const backend = fakeBackend();
    const store = createSessionDiskStore({backend});
    const session = newSession({messages: [{
        role: 'user',
        content: '',
        ts: 1,
        images: [{id: 'img-1', mime: 'image/png', data: 'QUJD', name: '图'}],
    }]});
    await store.persistSession(session);
    await store.flush();
    const log = backend._logs.get('s1');
    assert.ok(!log.includes('QUJD'), '日志里不应内嵌 base64');
    assert.ok(log.includes('images/img-1.png'), '日志应保存图片引用');
    const loaded = await store.loadAll(null);
    assert.equal(loaded[0].messages[0].images[0].data, 'QUJD');
});

test('disk store: reset removes history', async () => {
    const backend = fakeBackend();
    const store = createSessionDiskStore({backend});
    const session = newSession({messages: [{role: 'user', content: 'a', ts: 1}]});
    await store.persistSession(session);
    await store.resetSession(session);
    session.messages = [];
    await store.flush();
    const loaded = await store.loadAll(null);
    assert.equal(loaded[0].messages.length, 0);
    assert.ok(backend._logs.get('s1').startsWith('{"v":1,"t":"header"'));
    assert.ok(!backend._logs.get('s1').includes('"a"'));
});

test('disk store: normalized-out messages trigger a rewrite before appending', async () => {
    const backend = fakeBackend();
    const store = createSessionDiskStore({backend});
    const session = newSession({messages: [
        {role: 'assistant', content: '', status: 'done', ts: 1},
        {role: 'user', content: 'a', ts: 2},
    ]});
    await store.persistSession(session);
    await store.flush();
    const normalize = (raw) => Object.assign({}, raw, {
        messages: (raw.messages || []).filter((m) => !(m.role === 'assistant' && !m.content && m.status === 'done')),
    });
    const loaded = await store.loadAll(normalize);
    assert.equal(loaded[0].messages.length, 1);
    loaded[0].messages.push({role: 'user', content: 'b', ts: 3});
    await store.persistSession(loaded[0]);
    await store.flush();
    const again = await store.loadAll(normalize);
    assert.deepEqual(again[0].messages.map((m) => m.content), ['a', 'b']);
    assert.ok(!backend._logs.get('s1').includes('"content":""'), '被归一化丢掉的消息应从日志里清掉');
});

test('disk store: recovered transient messages are rewritten before appending', async () => {
    const backend = fakeBackend();
    const store = createSessionDiskStore({backend});
    const session = newSession({messages: [
        {role: 'user', content: 'run', ts: 1},
        {role: 'tool', name: 'read_file', content: '', status: 'running', ts: 2},
    ]});
    await store.persistSession(session);
    await store.flush();
    // 模拟 normalizeMessage 的恢复收尾：running → error
    const normalize = (raw) => {
        const messages = (raw.messages || []).map((m) => (
            m.status === 'running'
                ? Object.assign({}, m, {status: 'error', content: '执行被中断', _recovered: true})
                : m
        ));
        return Object.assign({}, raw, {messages, _recovered: messages.some((m) => m._recovered)});
    };
    const loaded = await store.loadAll(normalize);
    assert.equal(loaded[0].messages[1].status, 'error');
    loaded[0].messages.push({role: 'assistant', content: 'ok', status: 'done', ts: 3});
    await store.persistSession(loaded[0]);
    await store.flush();
    const log = backend._logs.get('s1');
    assert.ok(!log.includes('"status":"running"'), '恢复后不应再保留 running 状态');
    assert.ok(log.includes('"status":"error"'), '收尾状态应落盘');
});

test('disk store: failed append is retried on next persist', async () => {
    const backend = fakeBackend();
    const original = backend.AISessionAppend;
    let failOnce = true;
    backend.AISessionAppend = async (...args) => {
        if (failOnce) {
            failOnce = false;
            throw new Error('磁盘写入失败');
        }
        return original.apply(backend, args);
    };
    const errors = [];
    const store = createSessionDiskStore({backend, onError: (e) => errors.push(e)});
    const session = newSession({messages: [{role: 'user', content: 'a', ts: 1}]});
    await store.persistSession(session);
    await store.flush();
    assert.equal(errors.length, 1);
    assert.equal(backend._logs.get('s1') || '', '');
    await store.persistSession(session);
    await store.flush();
    const loaded = await store.loadAll(null);
    assert.deepEqual(loaded[0].messages.map((m) => m.content), ['a']);
});
