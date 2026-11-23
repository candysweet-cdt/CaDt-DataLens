// ai-reminders 纯函数测试：归一化上限截断 / 注入清单过滤 / 超限报错。
import test from 'node:test';
import assert from 'node:assert/strict';
import {AI_REMINDER_LIMIT} from '../../../src/ai/core/ai-constants.js';
import {normalizeReminders, remindersForPrompt, reminderAddBlocked} from '../../../src/ai/chat/ai-reminders.js';

test('normalizeReminders：过滤非法条目、补 id、截断到上限', () => {
    const out = normalizeReminders([
        {title: '跑一遍 go test'},
        {id: 'r2', title: '更新 CHANGELOG', detail: '补充新工具说明', status: 'done', createdAt: 123},
        {title: ''},
        null,
        'junk',
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].status, 'open');
    assert.match(out[0].id, /^rem-/);
    assert.equal(out[1].id, 'r2');
    assert.equal(out[1].status, 'done');
    assert.equal(out[1].createdAt, 123);
    assert.deepEqual(normalizeReminders(undefined), []);
    assert.deepEqual(normalizeReminders('junk'), []);
});

test('normalizeReminders：超过上限时截断，重复 id 去重', () => {
    const raw = [];
    for (let i = 0; i < AI_REMINDER_LIMIT + 3; i++) raw.push({title: '任务 ' + i});
    const out = normalizeReminders(raw);
    assert.equal(out.length, AI_REMINDER_LIMIT);
    const dup = normalizeReminders([{id: 'same', title: 'A'}, {id: 'same', title: 'B'}]);
    assert.equal(dup.length, 2);
    assert.notEqual(dup[0].id, dup[1].id);
});

test('remindersForPrompt：只返回未完成条目', () => {
    const session = {reminders: [
        {id: 'a', title: '进行中', status: 'open'},
        {id: 'b', title: '已完成', status: 'done'},
        {id: 'c', title: '未标注状态（视为进行中）'},
    ]};
    const open = remindersForPrompt(session);
    assert.deepEqual(open.map((item) => item.id), ['a', 'c']);
    assert.deepEqual(remindersForPrompt(null), []);
    assert.deepEqual(remindersForPrompt({}), []);
});

test('reminderAddBlocked：上限只数未完成条目（标 done 释放名额）', () => {
    const list = [];
    for (let i = 0; i < AI_REMINDER_LIMIT; i++) list.push({id: 'r' + i, title: '任务 ' + i, status: 'open'});
    assert.equal(reminderAddBlocked(list.slice(0, AI_REMINDER_LIMIT - 1)), null);
    const blocked = reminderAddBlocked(list);
    assert.match(blocked, /未完成 5 条/);
    assert.match(blocked, /reminder_remove|reminder_update/);
    // 方案 A（报告 §4.3.1）：5 条里 2 条 done → 只剩 3 条未完成，可以继续添加
    const withDone = list.map((item, i) => (i < 2 ? Object.assign({}, item, {status: 'done'}) : item));
    assert.equal(reminderAddBlocked(withDone), null);
});

test('normalizeReminders：open 超限截断；done 保留作历史但只留最近上限条', () => {
    // 4 open + 2 done → 全部保留（done 不挤占 open 名额）
    const mixed = [
        {id: 'd1', title: '历史一', status: 'done', createdAt: 1},
        {id: 'o1', title: '进行一', status: 'open', createdAt: 2},
        {id: 'o2', title: '进行二', status: 'open', createdAt: 3},
        {id: 'o3', title: '进行三', status: 'open', createdAt: 4},
        {id: 'o4', title: '进行四', status: 'open', createdAt: 5},
        {id: 'd2', title: '历史二', status: 'done', createdAt: 6},
    ];
    const kept = normalizeReminders(mixed);
    assert.equal(kept.length, 6);
    assert.deepEqual(kept.map((item) => item.id), ['d1', 'o1', 'o2', 'o3', 'o4', 'd2']);
    // 7 条 done → 只留最近 5 条，最旧的先淘汰
    const doneHeavy = [];
    for (let i = 0; i < AI_REMINDER_LIMIT + 2; i++) {
        doneHeavy.push({id: 'd' + i, title: '历史 ' + i, status: 'done', createdAt: i + 1});
    }
    const trimmed = normalizeReminders(doneHeavy);
    assert.equal(trimmed.length, AI_REMINDER_LIMIT);
    assert.equal(trimmed[0].id, 'd2');
    assert.equal(trimmed[trimmed.length - 1].id, 'd' + (AI_REMINDER_LIMIT + 1));
});
