// db-session-tree-wiring.test.mjs —— 侧栏树「会话通道分派」接线守卫。
//
// 事故背景：插件数据库驱动（cadt.registerDbDriver，会话 id 形如 'p:<entryId>'，只存在于前端
// 门面）接入后，侧栏树仍把 info.id 直接发给 deps.backend（Go 侧 sessions 里没有这个 id），
// 于是展开连接条目时恒报 ErrSessionNotFound——界面上表现为「连接会话不存在，可能已断开或
// 空闲超时，请重新连接」，看起来像数据库连不上，实际会话早就连好了（行尾还显示「只读」徽标）。
//
// 约定：树的会话级调用必须经 sessionApi(entry) 分派（插件 api 优先，内置走宿主绑定）；
// 唯一例外是 MySQL 专属的 DBListServerObjects（插件驱动没有该方法，调用点有 isMySQL 门禁）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../../src/db/db-session-tree.js', import.meta.url)), 'utf8');

test('侧栏树：必须提供 sessionApi 分派（插件 api 优先，内置回落 deps.backend）', () => {
    assert.ok(/function sessionApi\(entry\)\s*\{/.test(src), '必须有 sessionApi(entry) 解析函数');
    assert.ok(/const snap = getSessionState\(entry\.id\);/.test(src), 'sessionApi 必须按 entry.id 取会话快照');
    assert.ok(/return \(snap && snap\.api\) \|\| deps\.backend;/.test(src), 'sessionApi 的回落顺序必须是 api → deps.backend');
});

test('侧栏树：库清单/对象清单/表结构三处会话调用必须走 sessionApi', () => {
    assert.ok(/sessionApi\(entry\)\.DBListDatabases\(info\.id\)/.test(src), 'loadDatabases 必须走 sessionApi');
    assert.ok(/sessionApi\(entry\)\.DBListObjects\(info\.id, db\)/.test(src), 'loadObjects 必须走 sessionApi');
    assert.ok(/sessionApi\(entry\)\.DBDescribe\(snap\.info\.id, db, table, false\)/.test(src), 'fetchDDL 必须走 sessionApi');
});

test('侧栏树：不得再出现绕过门面直连宿主的会话调用（回归防线）', () => {
    const direct = src.match(/deps\.backend\.DB(ListDatabases|ListObjects|Describe|Browse|Query)\b/g) || [];
    assert.deepEqual(direct, [], '会话级调用不得直连 deps.backend：' + direct.join(', '));
    // MySQL 专属的服务器对象清单是唯一允许直连的（插件驱动会话无此方法，调用点有 isMySQL 门禁）
    assert.ok(/deps\.backend\.DBListServerObjects\(/.test(src), 'DBListServerObjects 保持宿主绑定');
});
