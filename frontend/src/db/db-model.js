// db-model.js：数据库连接页的纯函数——行键编解码、筛选算子、状态文案、修改摘要。
// 无 DOM、无依赖（core 层纯函数模块），测试在 frontend/test/db/db-model.test.mjs。

// 结果行数的默认值与硬上限：与 Go 侧 internal/dbclient 的 rowDefault / rowMax 以及
// internal/sqlview 的 sqlQueryRowDefault / sqlQueryRowMax 同值。前端只用它做档位与输入钳制，
// **真上限在 Go**（超了会被截断），所以两处必须同时改；护栏 test/core/backend-constants-parity。
export const DB_ROW_DEFAULT = 500;
export const DB_ROW_MAX = 5000;

/** 会话类型的展示名（插件 kind 由 db-plugin.js 按注册表解析，不走这里）。 */
export function kindLabel(kind) {
    switch (kind) {
        case 'sqlite': return 'SQLite';
        case 'mysql': return 'MySQL';
        case 'mariadb': return 'MariaDB';
        case 'redis': return 'Redis';
        default: return kind || '';
    }
}

// ---------- Redis 键空间（方案 §5.4）：前缀虚拟树聚合 ----------

/** Redis 键前缀分隔符（默认 `:` 分组；可切扁平由树渲染控制，聚合只认这个分隔符）。 */
export const REDIS_KEY_SEP = ':';

/**
 * redisPrefixTree 把扁平键列表聚合为前缀组 + 叶子的树（§5.4 的 key 虚拟树数据面）。
 * 同名前缀组与叶子共存时组名后缀 '/' 区分（user: 与 user:1001）。
 * @param {string[]} keys 键名全量
 * @returns {{groups: string[], leaves: string[]}} 本层结构——groups 是子前缀名（不含分隔符），
 *   leaves 是本层的叶子键名（完整键，供打开标签页精确传值）
 */
export function redisPrefixTree(keys, prefix) {
    const base = typeof prefix === 'string' && prefix !== '' ? prefix + REDIS_KEY_SEP : '';
    const groups = [];
    const leaves = [];
    for (const key of keys || []) {
        if (!key.startsWith(base)) continue;
        const rest = key.slice(base.length);
        if (rest === '') continue;
        const sepAt = rest.indexOf(REDIS_KEY_SEP);
        // 无分隔符 / 分隔符在首位（空组名）/ 分隔符在末尾（键名以 `:` 结尾，如 user: 本身是叶子）
        if (sepAt < 0 || sepAt === 0 || sepAt === rest.length - 1) {
            leaves.push(key);
        } else {
            const group = rest.slice(0, sepAt);
            if (!groups.includes(group)) groups.push(group);
        }
    }
    // 同层里「组名 == 叶子名」时叶子无法区分（组节点不可点开值）——叶子进 leaves，组照常展开
    return {groups, leaves};
}

/** redisGroupPrefix 组节点的完整前缀（SCAN MATCH 参数用，组名本身不含尾分隔符）。 */
export function redisGroupPrefix(prefix, group) {
    const base = typeof prefix === 'string' && prefix !== '' ? prefix + REDIS_KEY_SEP : '';
    return base + group;
}

/** redisKeyDisplayName 非 UTF-8 键名的显示转义（操作仍传精确键名）。 */
export function redisKeyDisplayName(name) {
    let printable = true;
    for (let i = 0; i < name.length; i++) {
        const c = name.charCodeAt(i);
        if ((c < 0x20 && c !== 9 && c !== 10 && c !== 13) || (c >= 0xD800 && c < 0xE000)) {
            printable = false;
            break;
        }
    }
    if (printable) return name;
    let out = '';
    for (const byte of new TextEncoder().encode(name)) {
        out += byte < 0x20 || byte > 0x7E ? '\\x' + byte.toString(16).toUpperCase().padStart(2, '0') : String.fromCharCode(byte);
    }
    return out;
}

/** redisTTLLabel TTL 角标文案（-1 永久 / 秒数人性化）。 */
export function redisTTLLabel(ttl) {
    if (ttl === -1) return '永久';
    if (ttl <= 0) return '';
    if (ttl < 60) return ttl + 's';
    if (ttl < 3600) return Math.floor(ttl / 60) + 'm';
    if (ttl < 86400) return Math.floor(ttl / 3600) + 'h';
    return Math.floor(ttl / 86400) + 'd';
}

/** redisTTLDraftAction TTL 输入语义：0 是删除确认，-1 是永久，其余负数非法。 */
export function redisTTLDraftAction(ttl) {
    if (!Number.isFinite(ttl) || ttl < -1) return 'invalid';
    if (ttl === -1) return 'persist';
    if (ttl === 0) return 'delete';
    return 'set';
}

/** 行主键编解码：PK 值用 \x1f 连接（值里不可能出现单元分隔符的可靠分隔）。 */
export function encodeRowKey(pkValues) {
    return (pkValues || []).map((v) => (v == null ? '' : String(v))).join('\x1f');
}

export function decodeRowKey(key) {
    return String(key || '').split('\x1f');
}

/** 从一行数据提取主键值（按 meta.PK 列名对位）。 */
export function rowKeyOf(meta, row, columns) {
    const pkValues = [];
    for (const name of meta.pk || []) {
        const idx = columns.indexOf(name);
        pkValues.push(idx >= 0 ? row[idx] : '');
    }
    return encodeRowKey(pkValues);
}

/** 从一行数据提取主键定位 map（列名 → 原值）。 */
export function rowKeysMap(meta, row, columns) {
    const map = {};
    for (const name of meta.pk || []) {
        const idx = columns.indexOf(name);
        map[name] = idx >= 0 ? row[idx] : '';
    }
    return map;
}

/** 筛选算子（UI 选项与语义说明）。 */
export const FILTER_OPS = [
    {value: 'contains', label: '包含'},
    {value: 'eq', label: '='},
    {value: 'ne', label: '≠'},
    {value: 'gt', label: '>'},
    {value: 'ge', label: '≥'},
    {value: 'lt', label: '<'},
    {value: 'le', label: '≤'},
    {value: 'null', label: '为 NULL'},
    {value: 'notNull', label: '非 NULL'},
];

export function filterOpNeedsValue(op) {
    return op !== 'null' && op !== 'notNull';
}

/** 耗时文案：<1s 显示毫秒，否则显示秒。 */
export function formatElapsed(ms) {
    const n = Number(ms) || 0;
    if (n < 1000) return n + ' ms';
    return (n / 1000).toFixed(2) + ' s';
}

/** 行估算文案（information_schema 的估计值，以「约」开头；0 表示未知不显示）。 */
export function rowEstimateLabel(n) {
    const v = Number(n) || 0;
    if (v <= 0) return '';
    if (v >= 1000000) return '约 ' + (v / 1000000).toFixed(1) + 'M 行';
    if (v >= 1000) return '约 ' + (v / 1000).toFixed(1) + 'K 行';
    return '约 ' + v + ' 行';
}

/** 待提交修改摘要：{updates, deletes, inserts} → 「3 处修改 · 1 行待删 · 2 行待插」。 */
export function dirtySummary(dirty) {
    if (!dirty) return '';
    const parts = [];
    if (dirty.updates && dirty.updates.size) parts.push(dirty.updates.size + ' 处修改');
    if (dirty.deletes && dirty.deletes.size) parts.push(dirty.deletes.size + ' 行待删');
    if (dirty.inserts && dirty.inserts.length) parts.push(dirty.inserts.length + ' 行待插');
    return parts.join(' · ');
}

/** 表是否可编辑：有主键、非视图、会话允许编辑，且全局只读锁未开。
 *（Go 侧 meta.editable 是权威判定；这里把主键/视图再查一遍，UI 层双保险。） */
export function tableEditable(meta, sessionEditable, globalReadonly) {
    return !!(meta && meta.editable && sessionEditable && !globalReadonly &&
        meta.kind !== 'view' && (meta.pk || []).length);
}

/** 确认原因 → 提示文案（与 Go guard.go 的 confirmDanger / confirmMissingWhere 对应）。 */
export function confirmReasonLabel(reason) {
    if (reason === 'danger') return '危险操作';
    if (reason === 'missingWhere') return '缺 WHERE（全表生效）';
    return reason || '';
}

/** buildDDL 从表元数据生成建表语句（复制/导出 DDL 用）。
 * 方言：MySQL 反引号、SQLite 双引号；列定义 + 主键（单列落列内、复合落表级）+ 索引；
 * 朴素还原——不虚构引擎参数（ENGINE/CHARSET）与自增，导出的就是元数据里能确证的部分。 */
export function buildDDL(kind, meta) {
    if (!meta || !meta.table) return '';
    const q = (name) => (kind === 'mysql'
        ? '`' + String(name).replace(/`/g, '``') + '`'
        : '"' + String(name).replace(/"/g, '""') + '"');
    const pk = meta.pk || [];
    const singlePk = pk.length === 1 ? pk[0] : null;
    const defs = (meta.columns || []).map((c) => {
        const parts = [q(c.name), c.type || 'TEXT'];
        if (c.notNull || (singlePk && c.name === singlePk)) parts.push('NOT NULL');
        if (c.default != null) parts.push('DEFAULT ' + defaultLiteral(String(c.default)));
        if (singlePk && c.name === singlePk) parts.push('PRIMARY KEY');
        return parts.join(' ');
    });
    if (pk.length > 1) {
        defs.push('PRIMARY KEY (' + pk.map((c) => q(c)).join(', ') + ')');
    }
    const stmts = ['CREATE TABLE ' + q(meta.table) + ' (\n  ' + defs.join(',\n  ') + '\n)'];
    for (const idx of meta.indexes || []) {
        if (/autoindex/i.test(idx.name || '')) continue; // SQLite 主键自动索引不还原
        stmts.push('CREATE ' + (idx.unique ? 'UNIQUE ' : '') + 'INDEX ' + q(idx.name) +
            ' ON ' + q(meta.table) + ' (' + (idx.columns || []).map((c) => q(c)).join(', ') + ')');
    }
    return stmts.join(';\n\n') + ';';
}

function defaultLiteral(v) {
    const s = String(v);
    if (/^null$/i.test(s)) return 'NULL';
    if (/^-?\d+(\.\d+)?$/.test(s)) return s; // 数字字面量裸值
    return '\'' + s.replace(/'/g, '\'\'') + '\'';
}
