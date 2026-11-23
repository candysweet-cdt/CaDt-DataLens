import test from 'node:test';
import assert from 'node:assert/strict';
import {recordRead, recordWrite, checkWriteFresh} from '../../../src/ai/security/ai-write-guard.js';

test('新文件写入不设闸门，直接放行', () => {
    const result = checkWriteFresh({id: 's1'}, 'D:/w/new.md', {exists: false});
    assert.deepEqual(result, {ok: true});
});

test('本会话从未读过该文件 → 硬拒绝并提示先读', () => {
    const session = {id: 's1'};
    const result = checkWriteFresh(session, 'D:/w/a.js', {exists: true, mtime: '111', size: 100}, 'a.js');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unread');
    assert.ok(result.message.includes('a.js'));
    assert.ok(result.message.includes('read_file'));
    assert.ok(result.message.includes('edit_file'));
});

test('读过且磁盘未变化 → 放行', () => {
    const session = {id: 's1'};
    recordRead(session, 'D:/w/a.js', '111', 100);
    const result = checkWriteFresh(session, 'D:/w/a.js', {exists: true, mtime: '111', size: 100}, 'a.js');
    assert.deepEqual(result, {ok: true});
});

test('读过但磁盘 mtime 已变化 → 拒绝并附尺寸变化', () => {
    const session = {id: 's1'};
    recordRead(session, 'D:/w/a.js', '111', 100);
    const result = checkWriteFresh(session, 'D:/w/a.js', {exists: true, mtime: '222', size: 1580}, 'a.js');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'stale');
    assert.ok(result.message.includes('已被外部修改'));
    assert.ok(result.message.includes('100 → 1580'));
});

test('mtime 相同而尺寸未知时不误报尺寸变化', () => {
    const session = {id: 's1'};
    recordRead(session, 'D:/w/a.js', '111', 100);
    const result = checkWriteFresh(session, 'D:/w/a.js', {exists: true, mtime: '111', size: 999}, 'a.js');
    // mtime 一致即视为新鲜（尺寸仅用于提示，不参与判定）
    assert.deepEqual(result, {ok: true});
});

test('写入成功后回写指纹：同会话后续写入不再要求重读', () => {
    const session = {id: 's1'};
    recordRead(session, 'D:/w/a.js', '111', 100);
    assert.equal(checkWriteFresh(session, 'D:/w/a.js', {exists: true, mtime: '111', size: 100}).ok, true);
    recordWrite(session, 'D:/w/a.js', '333');
    const result = checkWriteFresh(session, 'D:/w/a.js', {exists: true, mtime: '333', size: 120}, 'a.js');
    assert.deepEqual(result, {ok: true});
    // 写后磁盘再被外部改动 → 仍能拦下
    const stale = checkWriteFresh(session, 'D:/w/a.js', {exists: true, mtime: '444', size: 120}, 'a.js');
    assert.equal(stale.ok, false);
});

test('会话间指纹互不影响', () => {
    const a = {id: 'a'};
    const b = {id: 'b'};
    recordRead(a, 'D:/w/a.js', '111', 100);
    assert.equal(checkWriteFresh(a, 'D:/w/a.js', {exists: true, mtime: '111'}).ok, true);
    assert.equal(checkWriteFresh(b, 'D:/w/a.js', {exists: true, mtime: '111'}).ok, false);
});

test('无会话上下文时不崩溃并按未读拒绝', () => {
    recordRead(null, 'D:/w/a.js', '111', 100);
    const result = checkWriteFresh(null, 'D:/w/a.js', {exists: true, mtime: '111'});
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unread');
});

test('read 后外部改动、重新 read 后放行（拒绝消息可恢复）', () => {
    const session = {id: 's1'};
    recordRead(session, 'D:/w/a.js', '111', 100);
    assert.equal(checkWriteFresh(session, 'D:/w/a.js', {exists: true, mtime: '222'}).ok, false);
    recordRead(session, 'D:/w/a.js', '222', 1580);
    assert.equal(checkWriteFresh(session, 'D:/w/a.js', {exists: true, mtime: '222', size: 1580}).ok, true);
});
