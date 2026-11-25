// plugin-db-drivers.test.mjs —— 插件数据库驱动注册表（cadt.registerDbDriver）的校验与上限。
// 覆盖：id/字段规则、connect 必需、kind 串与拆分、去重、单插件与全局上限、密文字段推断。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    PLUGIN_DB_KIND_PREFIX,
    MAX_DRIVERS_TOTAL,
    MAX_DRIVERS_PER_PLUGIN,
    MAX_DRIVER_FIELDS,
    normalizePluginDbDriver,
    registerPluginDbDriver,
    clearPluginDbDrivers,
    getPluginDbDrivers,
    getPluginDbDriverByKind,
    isPluginDbKind,
    splitPluginDbKind,
    pluginDbKind,
} from '../../src/shell/plugin-db-drivers.js';

function baseSpec(overrides = {}) {
    return Object.assign({
        id: 'pg',
        label: 'PostgreSQL (demo)',
        fields: [
            {key: 'host', label: '主机', type: 'text', default: '127.0.0.1', required: true},
            {key: 'password', label: '密码', type: 'password'},
        ],
        connect: () => ({}),
    }, overrides);
}

test('归一化：kind 串、字段默认值、密文推断', () => {
    const record = normalizePluginDbDriver('acme', 'ACME 插件', baseSpec());
    assert.equal(record.kind, PLUGIN_DB_KIND_PREFIX + 'acme:pg');
    assert.equal(record.key, 'acme:pg');
    assert.equal(record.pluginName, 'ACME 插件');
    assert.equal(record.label, 'PostgreSQL (demo)');
    assert.equal(record.fields[0].secret, false);
    assert.equal(record.fields[1].secret, true, 'password 字段应推断为密文');
    assert.equal(record.fields[1].required, false);
    assert.equal(record.fields[0].hint, '', '未声明 hint 时为空串');
    // hint：字段级说明（宿主渲染在输入框下方），去首尾空白并截到 120 字
    const withHint = normalizePluginDbDriver('acme', '', baseSpec({
        fields: [
            {key: 'host', type: 'text', hint: '  填主机名或 IP  '},
            {key: 'long', type: 'text', hint: 'x'.repeat(200)},
        ],
    }));
    assert.equal(withHint.fields[0].hint, '填主机名或 IP');
    assert.equal(withHint.fields[1].hint.length, 120);
});

test('校验拒绝：坏 id / 缺 connect / 缺 fields / 坏字段键 / 重复键 / 未知类型回落 text', () => {
    assert.throws(() => normalizePluginDbDriver('Bad Id', '', baseSpec()), /插件 id 无效/);
    assert.throws(() => normalizePluginDbDriver('acme', '', baseSpec({id: 'UPPER'})), /id 无效/);
    assert.throws(() => normalizePluginDbDriver('acme', '', baseSpec({connect: null})), /connect/);
    assert.throws(() => normalizePluginDbDriver('acme', '', baseSpec({fields: []})), /fields/);
    assert.throws(() => normalizePluginDbDriver('acme', '', baseSpec({
        fields: [{key: 'Bad Key', type: 'text'}],
    })), /字段键无效/);
    assert.throws(() => normalizePluginDbDriver('acme', '', baseSpec({
        fields: [{key: 'dup', type: 'text'}, {key: 'dup', type: 'text'}],
    })), /字段键重复/);
    const loose = normalizePluginDbDriver('acme', '', baseSpec({
        fields: [{key: 'x', type: 'blob'}],
    }));
    assert.equal(loose.fields[0].type, 'text', '未知类型回落 text');
});

test('上限：fields ≤ 12、全局 ≤ 20、单插件 ≤ 5、重复 id 拒绝', () => {
    clearPluginDbDrivers();
    const manyFields = Array.from({length: MAX_DRIVER_FIELDS + 1}, (_, i) => ({key: 'f' + i, type: 'text'}));
    assert.throws(() => normalizePluginDbDriver('acme', '', baseSpec({id: 'wide', fields: manyFields})), /fields 超过/);

    clearPluginDbDrivers();
    for (let i = 0; i < MAX_DRIVERS_PER_PLUGIN; i++) {
        registerPluginDbDriver('acme', 'ACME', baseSpec({id: 'd' + i}));
    }
    assert.throws(() => registerPluginDbDriver('acme', 'ACME', baseSpec({id: 'd-over'})), /单插件驱动数超过上限/);
    clearPluginDbDrivers();
    // 填满全局上限（不同插件各注册一个），下一个必须撞总数帽
    for (let i = 0; i < MAX_DRIVERS_TOTAL; i++) {
        registerPluginDbDriver('p' + i, 'P' + i, baseSpec({id: 'd'}));
    }
    assert.throws(() => registerPluginDbDriver('overflow', 'O', baseSpec({id: 'd'})), /总数超过上限/);
    clearPluginDbDrivers();
    registerPluginDbDriver('acme', 'ACME', baseSpec({id: 'pg'}));
    assert.throws(() => registerPluginDbDriver('acme', 'ACME', baseSpec({id: 'pg'})), /已注册/);
});

test('查询：按 kind 取驱动；插件禁用（clear）后查不到', () => {
    clearPluginDbDrivers();
    registerPluginDbDriver('acme', 'ACME', baseSpec({id: 'pg'}));
    const kind = pluginDbKind('acme', 'pg');
    assert.ok(isPluginDbKind(kind));
    assert.deepEqual(splitPluginDbKind(kind), {pluginId: 'acme', driverId: 'pg'});
    assert.equal(getPluginDbDriverByKind(kind).id, 'pg');
    assert.equal(getPluginDbDriverByKind('sqlite'), null);
    assert.equal(isPluginDbKind('plugin:acme'), false, '缺驱动段的串不是合法 kind');
    assert.equal(isPluginDbKind('mysql'), false);
    clearPluginDbDrivers();
    assert.equal(getPluginDbDriverByKind(kind), null, 'clear 后查不到（插件禁用语义）');
    assert.equal(getPluginDbDrivers().length, 0);
});

// ---------- views：数据表标签页的自定义渲染视图（图 / 画布…） ----------

test('views：未声明时为 []，声明后按声明顺序归一化并保留 mount', () => {
    const plain = normalizePluginDbDriver('acme', 'ACME', baseSpec());
    assert.deepEqual(plain.views, [], '未声明 views 时是空数组（宿主据此不显示视图切换）');
    const mount = () => ({destroy() {}});
    const record = normalizePluginDbDriver('acme', 'ACME', baseSpec({
        views: [{id: 'graph', label: '  图  ', mount}],
    }));
    assert.equal(record.views.length, 1);
    assert.equal(record.views[0].id, 'graph');
    assert.equal(record.views[0].label, '图', 'label 去首尾空白');
    assert.equal(record.views[0].mount, mount, 'mount 原样保留（由宿主调用）');
    // label 缺省回落到 id
    const noLabel = normalizePluginDbDriver('acme', 'ACME', baseSpec({views: [{id: 'canvas', mount}]}));
    assert.equal(noLabel.views[0].label, 'canvas');
});

test('views：超上限 / 非数组 / 坏 id / 缺 mount / id 重复都拒绝', () => {
    const mount = () => ({});
    assert.throws(() => normalizePluginDbDriver('acme', '', baseSpec({views: 'graph'})), /views 必须是数组/);
    assert.throws(() => normalizePluginDbDriver('acme', '', baseSpec({
        views: [{id: 'a', mount}, {id: 'b', mount}, {id: 'c', mount}, {id: 'd', mount}],
    })), /views 超过/);
    assert.throws(() => normalizePluginDbDriver('acme', '', baseSpec({views: [{id: 'Bad Id', mount}]})), /视图 id 无效/);
    assert.throws(() => normalizePluginDbDriver('acme', '', baseSpec({views: [{id: 'graph'}]})), /缺少 mount/);
    assert.throws(() => normalizePluginDbDriver('acme', '', baseSpec({
        views: [{id: 'graph', mount}, {id: 'graph', mount}],
    })), /视图 id 重复/);
});

// ---------- console：表标签页顶部的自由查询输入框 ----------

test('console：未声明时为 null，声明后归一化 label / placeholder / limit', () => {
    assert.equal(normalizePluginDbDriver('acme', '', baseSpec()).console, null, '未声明时不显示查询框');
    const rec = normalizePluginDbDriver('acme', '', baseSpec({
        console: {label: '  Cypher  ', placeholder: 'MATCH (n) RETURN n', limit: 50},
    }));
    assert.equal(rec.console.label, 'Cypher', 'label 去首尾空白');
    assert.equal(rec.console.placeholder, 'MATCH (n) RETURN n');
    assert.equal(rec.console.limit, 50);
    // 缺省值
    const bare = normalizePluginDbDriver('acme', '', baseSpec({console: {}}));
    assert.equal(bare.console.label, '查询');
    assert.equal(bare.console.placeholder, '');
    assert.equal(bare.console.limit, 200);
    // 上下界
    assert.equal(normalizePluginDbDriver('acme', '', baseSpec({console: {limit: 99999}})).console.limit, 2000);
    assert.equal(normalizePluginDbDriver('acme', '', baseSpec({console: {limit: -5}})).console.limit, 200);
});

test('console：非对象声明直接拒绝（不静默丢弃）', () => {
    assert.throws(() => normalizePluginDbDriver('acme', '', baseSpec({console: 'cypher'})), /console 必须是对象/);
});

test('console：limit 的脏输入归一（字符串 / NaN / Infinity / 小数 / 0 / 负数）', () => {
    const lim = (v) => normalizePluginDbDriver('acme', '', baseSpec({console: {limit: v}})).console.limit;
    assert.equal(lim('50'), 50, '数字字符串按数值处理');
    assert.equal(lim('abc'), 200, 'NaN 回落默认');
    assert.equal(lim(NaN), 200, 'NaN 回落默认');
    assert.equal(lim(Infinity), 200, 'Infinity 回落默认（不是夹到上限）');
    assert.equal(lim(50.7), 50, '小数向下取整');
    assert.equal(lim(0), 200, '0 视为未设置');
    assert.equal(lim(-3), 200, '负数回落默认（夹到 1 会把结果截成一行）');
    assert.equal(lim(5000), 2000, '超上限夹到 2000');
    assert.equal(lim(null), 200, 'null 回落默认');
});



