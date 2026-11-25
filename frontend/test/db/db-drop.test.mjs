// db-drop.test.mjs：数据库面板拖放分派（SQLite 只读加入 / 连接配置导入 / 不支持的类型 / 未启用门）。
//
// db-drop 是 DOM 无关的分派层，依赖全部注入——这里用假 deps 覆盖四条分支与三条纪律：
// ① 重复库文件只展开不重复建条目；② 连不上要回滚刚建的条目（不留脏行）；
// ③ 导入的连接逐个展开，密码未导入导致的失败不刷 N 条红字（有汇总说明）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {classifyDbDropPath, createDbDropHandler} from '../../src/db/db-drop.js';

function fakeDeps(overrides) {
    const state = {
        entries: [],
        expanded: [],
        removed: [],
        flashes: [],
        nextId: 1,
    };
    const deps = {
        isEnabled: () => true,
        baseNameOf: (p) => String(p || '').split(/[\\/]/).pop(),
        findSqliteEntry: (path) => {
            const key = String(path || '').replace(/\\/g, '/').toLowerCase();
            return state.entries.find((e) => e.kind === 'sqlite' && String(e.path || '').replace(/\\/g, '/').toLowerCase() === key) || null;
        },
        addSqliteEntry: (path) => {
            const entry = {id: 'wsdb-' + state.nextId++, kind: 'sqlite', path, name: String(path).split(/[\\/]/).pop(), allowEdit: false};
            state.entries.push(entry);
            return entry;
        },
        removeEntry: (id) => {
            state.removed.push(id);
            state.entries = state.entries.filter((e) => e.id !== id);
        },
        ensureConnectionEntry: (cfg) => {
            const existing = state.entries.find((e) => e.connectionId === cfg.id);
            if (existing) return existing;
            const entry = {id: 'wsdb-' + state.nextId++, kind: cfg.kind === 'redis' ? 'redis' : 'mysql', connectionId: cfg.id, name: cfg.name};
            state.entries.push(entry);
            return entry;
        },
        expandEntry: async (entry) => {
            state.expanded.push(entry.id);
            if (entry.failWith) throw new Error(entry.failWith);
        },
        importConnections: async () => ({imported: [], updated: [], skipped: []}),
        flash: (msg, isError) => state.flashes.push({msg, isError: !!isError}),
        ...(overrides || {}),
    };
    return {deps, state};
}

test('classifyDbDropPath：按扩展名分类，大小写不敏感', () => {
    assert.equal(classifyDbDropPath('D:\\a.db'), 'sqlite');
    assert.equal(classifyDbDropPath('D:\\a.SQLITE3'), 'sqlite');
    assert.equal(classifyDbDropPath('/tmp/x.sqlite'), 'sqlite');
    assert.equal(classifyDbDropPath('D:\\db-connections.json'), 'connection-config');
    assert.equal(classifyDbDropPath('D:\\notes.txt'), 'unsupported');
    assert.equal(classifyDbDropPath(''), 'unsupported');
    assert.equal(classifyDbDropPath(null), 'unsupported');
});

test('SQLite：只读加入并展开；重复文件只展开；连不上回滚条目', async () => {
    const ok = fakeDeps();
    const handler = createDbDropHandler(ok.deps);
    await handler.handle(['D:\\data\\shop.db']);
    assert.equal(ok.state.entries.length, 1);
    assert.equal(ok.state.entries[0].allowEdit, false, '拖入只能读：写权限由行菜单显式开启');
    assert.deepEqual(ok.state.expanded, [ok.state.entries[0].id]);

    // 再拖一次同一个库（换大小写）：只展开，不新建
    await handler.handle(['d:\\DATA\\SHOP.DB']);
    assert.equal(ok.state.entries.length, 1);
    assert.equal(ok.state.expanded.length, 2);
    assert.match(ok.state.flashes[ok.state.flashes.length - 1].msg, /已在工作区清单/);

    // 假 .db（连不上）：条目被回滚，清单里不留脏行
    const bad = fakeDeps({addSqliteEntry: (path) => {
        const entry = {id: 'wsdb-bad', kind: 'sqlite', path, name: 'fake.db', failWith: 'file is not a database'};
        bad.state.entries.push(entry);
        return entry;
    }});
    const badHandler = createDbDropHandler(bad.deps);
    const out = await badHandler.handle(['D:\\x\\fake.db']);
    assert.equal(out.added, 0);
    assert.deepEqual(bad.state.removed, ['wsdb-bad']);
    assert.equal(bad.state.entries.length, 0);
    const last = bad.state.flashes[bad.state.flashes.length - 1];
    assert.equal(last.isError, true);
    assert.match(last.msg, /不是可用的 SQLite 数据库：fake\.db/);
});

test('连接配置：导入的连接挂进工作区并逐个展开，摘要说清密码不随配置导入', async () => {
    const fx = fakeDeps({
        importConnections: async () => ({
            imported: [
                {id: 'dbc-1', kind: 'mysql', name: '生产库'},
                {id: 'dbc-2', kind: 'redis', name: '缓存'},
            ],
            updated: [{id: 'dbc-3', kind: 'mysql', name: '旧连接'}],
            skipped: [{name: '坏驱动', reason: '不支持的驱动类型：postgres'}],
        }),
        // 导入的连接通常还没存密码：展开即失败，这里模拟该失败
        expandEntry: async (entry) => {
            fx.state.expanded.push(entry.id);
            throw new Error('该连接尚未保存密码');
        },
    });
    const handler = createDbDropHandler(fx.deps);
    const out = await handler.handle(['D:\\cfg\\db-connections.json']);
    assert.equal(out.added, 2);
    assert.equal(out.updated, 1);
    assert.equal(fx.state.entries.length, 3);
    assert.deepEqual(fx.state.entries.map((e) => e.kind), ['mysql', 'redis', 'mysql']);
    assert.equal(fx.state.expanded.length, 3, '导入后应逐个展开（失败也不中断其余条目）');
    // 展开失败不逐条刷红字：只有一条汇总提示
    assert.equal(fx.state.flashes.length, 1);
    const msg = fx.state.flashes[0].msg;
    assert.match(msg, /已导入 2 个连接、更新 1 个/);
    assert.match(msg, /跳过 1 个（坏驱动：不支持的驱动类型：postgres）/);
    assert.match(msg, /密码不随配置文件导入/);
});

test('不支持的扩展名只提示一次；数据库工具未启用时整体不落任何东西', async () => {
    const fx = fakeDeps();
    const handler = createDbDropHandler(fx.deps);
    await handler.handle(['D:\\a.txt', 'D:\\b.png']);
    assert.equal(fx.state.entries.length, 0);
    assert.equal(fx.state.flashes.filter((f) => f.isError).length, 2, '每个不支持的文件各提示一次（用户需要知道哪个被拒）');

    const gate = fakeDeps({isEnabled: () => false});
    const out = await createDbDropHandler(gate.deps).handle(['D:\\a.db']);
    assert.equal(out.added, 0);
    assert.equal(gate.state.entries.length, 0);
    assert.equal(gate.state.flashes.length, 1);
    assert.match(gate.state.flashes[0].msg, /数据库工具未启用/);
});

test('同一批里重复路径只处理一次', async () => {
    const fx = fakeDeps();
    await createDbDropHandler(fx.deps).handle(['D:\\a.db', 'd:\\A.DB']);
    assert.equal(fx.state.entries.length, 1);
});
