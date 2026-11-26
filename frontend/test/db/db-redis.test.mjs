// db-redis.test.mjs —— Redis 键空间纯函数（frontend/src/db/db-model.js）与树聚合语义。
// 覆盖：前缀树聚合（组/叶子/嵌套前缀/组叶同名共存）、组前缀展开、键名转义、TTL 角标文案、kindLabel。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    kindLabel, redisPrefixTree, redisGroupPrefix, redisKeyDisplayName, redisTTLLabel, redisTTLDraftAction, REDIS_KEY_SEP,
} from '../../src/db/db-model.js';

test('kindLabel：redis', () => {
    assert.equal(kindLabel('redis'), 'Redis');
    assert.equal(kindLabel('mariadb'), 'MariaDB');
    assert.equal(kindLabel(''), '');
});

test('redisPrefixTree：根层聚合出组与叶子', () => {
    const keys = ['user:1001', 'user:1002', 'config:debug', 'standalone-key'];
    const t = redisPrefixTree(keys, '');
    assert.deepEqual(t.groups, ['user', 'config']);
    assert.deepEqual(t.leaves, ['standalone-key']);
});

test('redisPrefixTree：组层继续聚合（递归语义由调用方驱动）', () => {
    const keys = ['user:1001', 'user:1002', 'user:profile:1001', 'queue:jobs'];
    const root = redisPrefixTree(keys, '');
    assert.deepEqual(root.groups, ['user', 'queue']);
    const user = redisPrefixTree(keys, redisGroupPrefix('', 'user'));
    assert.equal(user.groups.length, 1);
    assert.ok(user.groups.includes('profile'));
    assert.deepEqual(user.leaves, ['user:1001', 'user:1002']);
    const profile = redisPrefixTree(keys, redisGroupPrefix('user', 'profile'));
    assert.deepEqual(profile.leaves, ['user:profile:1001']);
    assert.equal(profile.groups.length, 0);
});

test('redisPrefixTree：组名与叶子同名共存互不吞并', () => {
    // user: 本身是叶子、user:1001 是子组——两者同时存在
    const keys = ['user:', 'user:1001'];
    const t = redisPrefixTree(keys, '');
    assert.deepEqual(t.groups, ['user']);
    assert.deepEqual(t.leaves, ['user:']);
});

test('redisPrefixTree：按前缀过滤（组层只收自己的键）', () => {
    const keys = ['a:1', 'ab:1', 'a:b:c'];
    const t = redisPrefixTree(keys, 'a');
    assert.deepEqual(t.leaves, ['a:1']);
    assert.deepEqual(t.groups, ['b']);
});

test('redisPrefixTree：空输入与无匹配', () => {
    assert.deepEqual(redisPrefixTree([], ''), {groups: [], leaves: []});
    const t = redisPrefixTree(['x:1'], 'y');
    assert.deepEqual(t, {groups: [], leaves: []});
});

test('redisGroupPrefix：根层与嵌套层的前缀拼接', () => {
    assert.equal(redisGroupPrefix('', 'user'), 'user');
    assert.equal(redisGroupPrefix('user', 'profile'), 'user' + REDIS_KEY_SEP + 'profile');
    assert.equal(redisGroupPrefix('user' + REDIS_KEY_SEP + 'profile', 'x'), 'user:profile:x');
});

test('redisKeyDisplayName：可打印原样、非 UTF-8/控制字符转义', () => {
    assert.equal(redisKeyDisplayName('user:1001'), 'user:1001');
    assert.equal(redisKeyDisplayName('键:名字'), '键:名字'); // 非 ASCII 但可打印
    // \x01 控制字符 → 转义
    assert.equal(redisKeyDisplayName('a\x01b'), 'a\\x01b');
    // 孤立代理对（合法 JS 字符串但不是合法 UTF-8 序列）
    const lone = 'a\uD800b';
    assert.notEqual(redisKeyDisplayName(lone), lone);
    assert.ok(/\\x/.test(redisKeyDisplayName(lone)));
});

test('redisTTLLabel：永久/负值/人性化秒数', () => {
    assert.equal(redisTTLLabel(-1), '永久');
    assert.equal(redisTTLLabel(-2), '');
    assert.equal(redisTTLLabel(0), '');
    assert.equal(redisTTLLabel(45), '45s');
    assert.equal(redisTTLLabel(120), '2m');
    assert.equal(redisTTLLabel(7200), '2h');
    assert.equal(redisTTLLabel(172800), '2d');
});

test('redisTTLDraftAction：0 必须走删除确认，-1 永久，其余负数非法', () => {
    assert.equal(redisTTLDraftAction(0), 'delete');
    assert.equal(redisTTLDraftAction(-1), 'persist');
    assert.equal(redisTTLDraftAction(-2), 'invalid');
    assert.equal(redisTTLDraftAction(Number.NaN), 'invalid');
    assert.equal(redisTTLDraftAction(60), 'set');
});
