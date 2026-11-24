// plugin-db-drivers.js：插件数据库驱动（cadt.registerDbDriver）注册表——纯逻辑、无 DOM，可单测。
//
// 「其他数据库交给插件」的扩展面：插件声明一个驱动（label + 连接表单字段 + connect(config)），
// 侧栏「数据库」面板据此动态出表单，内容区「数据库」标签页复用既有对象树 / 网格 / 控制台。
// 传输与协议实现全在插件侧（HTTP 型数据库直接 fetch；带 sidecar 的走 registerService；
// 裸 TCP 协议见 docs/plugins/README.md 的限制说明）。会话形状契约见同文档「注册数据库驱动」。
//
// kind 串约定：`plugin:<插件id>:<驱动id>`——工作区清单条目用它分组与分派；
// 插件禁用 / 卸载后 kind 查不到驱动，标签页打开时给出明确错误而不是静默空白。

export const PLUGIN_DB_KIND_PREFIX = 'plugin:';

// 上限：注册期严格拒绝（插件作者立刻看到错误），执行期不静默丢弃。
export const MAX_DRIVERS_TOTAL = 20;
export const MAX_DRIVERS_PER_PLUGIN = 5;
export const MAX_DRIVER_FIELDS = 12;
export const MAX_DRIVER_LABEL = 40;
// 驱动可选声明「自定义渲染视图」（如 Neo4j 的 graph）：数据表标签页多出视图切换，
// 插件负责画（mount/destroy/setTheme 契约同 cadt.registerViewer），宿主只给数据通道。
export const MAX_DRIVER_VIEWS = 3;
export const MAX_VIEW_LABEL = 20;
export const DRIVER_FIELD_TYPES = ['text', 'number', 'password'];

const ID_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FIELD_KEY_RULE = /^[a-z0-9_]{1,32}$/;

/** @type {Map<string, object>} driverId → 归一化记录 */
const drivers = new Map();

function bad(message) {
    throw new Error('[registerDbDriver] ' + message);
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

export function pluginDbKind(pluginId, driverId) {
    return PLUGIN_DB_KIND_PREFIX + pluginId + ':' + driverId;
}

export function isPluginDbKind(kind) {
    const k = String(kind || '');
    if (!k.startsWith(PLUGIN_DB_KIND_PREFIX)) return false;
    // 冒号判定只看前缀之后的剩余段（前缀自身含冒号，'plugin:acme' 不是合法 kind）
    const rest = k.slice(PLUGIN_DB_KIND_PREFIX.length);
    return rest.length > 0 && rest.includes(':');
}

// kind → {pluginId, driverId}；非插件 kind 返回 null。
export function splitPluginDbKind(kind) {
    if (!isPluginDbKind(kind)) return null;
    const rest = String(kind).slice(PLUGIN_DB_KIND_PREFIX.length);
    const at = rest.indexOf(':');
    return {pluginId: rest.slice(0, at), driverId: rest.slice(at + 1)};
}

function normalizeFields(driverId, raw) {
    const rawList = Array.isArray(raw) ? raw : [];
    if (!rawList.length) bad(`驱动 ${driverId} 缺少 fields（连接表单字段声明）`);
    if (rawList.length > MAX_DRIVER_FIELDS) bad(`驱动 ${driverId} 的 fields 超过 ${MAX_DRIVER_FIELDS} 项`);
    const fields = [];
    for (const f of rawList) {
        if (!isPlainObject(f)) bad(`驱动 ${driverId} 的 fields 项必须是对象`);
        const key = String(f.key || '').trim();
        if (!FIELD_KEY_RULE.test(key)) bad(`驱动 ${driverId} 的字段键无效：${JSON.stringify(f.key)}（小写字母/数字/下划线，≤32）`);
        const type = DRIVER_FIELD_TYPES.includes(f.type) ? f.type : 'text';
        if (fields.some((x) => x.key === key)) bad(`驱动 ${driverId} 的字段键重复：${key}`);
        fields.push({
            key,
            label: String(f.label == null ? key : f.label).trim().slice(0, 40) || key,
            type,
            default: f.default == null ? '' : String(f.default),
            required: !!f.required,
            // hint：字段级说明，渲染在输入框下一行（驱动用它解释语义，如「库名 = instance 内的逻辑库」）
            hint: String(f.hint == null ? '' : f.hint).trim().slice(0, 120),
            // password 字段天然是密文面：宿主存 dpapi 凭据库，不进工作区清单（localStorage）
            secret: type === 'password' || !!f.secret,
        });
    }
    return fields;
}

// views 声明：数据表标签页可选的「自定义渲染视图」（图 / 画布 / 时间线…）。
// 契约与 cadt.registerViewer 一致（mount 返回 {resize?, setTheme?, destroy}），
// 差别是数据来源：ctx 给的是「库 + 表 + 查询通道」，不是文件文本。
function normalizeViews(driverId, raw) {
    if (raw == null) return [];
    if (!Array.isArray(raw)) bad(`驱动 ${driverId} 的 views 必须是数组`);
    if (raw.length > MAX_DRIVER_VIEWS) bad(`驱动 ${driverId} 的 views 超过 ${MAX_DRIVER_VIEWS} 项`);
    const out = [];
    for (const v of raw) {
        if (!isPlainObject(v)) bad(`驱动 ${driverId} 的 views 项必须是对象`);
        const id = String(v.id || '').trim();
        if (!ID_RULE.test(id)) bad(`驱动 ${driverId} 的视图 id 无效：${JSON.stringify(v.id)}`);
        if (typeof v.mount !== 'function') bad(`驱动 ${driverId} 的视图 ${id} 缺少 mount(container, ctx) 函数`);
        if (out.some((x) => x.id === id)) bad(`驱动 ${driverId} 的视图 id 重复：${id}`);
        out.push({
            id,
            label: String(v.label == null ? id : v.label).trim().slice(0, MAX_VIEW_LABEL) || id,
            mount: v.mount,
        });
    }
    return out;
}

export function normalizePluginDbDriver(pluginId, pluginName, spec) {
    const owner = String(pluginId || '').trim();
    if (!ID_RULE.test(owner)) bad(`插件 id 无效：${JSON.stringify(pluginId)}`);
    if (!isPlainObject(spec)) bad('需要一个驱动对象');
    const id = String(spec.id || '').trim();
    if (!ID_RULE.test(id)) bad(`id 无效：${JSON.stringify(spec.id)}`);
    if (typeof spec.connect !== 'function') bad(`驱动 ${id} 缺少 connect(config) 函数`);
    const fields = normalizeFields(id, spec.fields);
    const views = normalizeViews(id, spec.views);
    const label = String(spec.label == null ? id : spec.label).trim().slice(0, MAX_DRIVER_LABEL) || id;
    return {
        key: owner + ':' + id,
        kind: pluginDbKind(owner, id),
        pluginId: owner,
        pluginName: String(pluginName || owner),
        id,
        label,
        fields,
        views,
        connect: spec.connect,
    };
}

export function registerPluginDbDriver(pluginId, pluginName, spec) {
    const record = normalizePluginDbDriver(pluginId, pluginName, spec);
    if (drivers.has(record.kind)) bad(`驱动 ${record.id} 已注册`);
    if (drivers.size >= MAX_DRIVERS_TOTAL) bad(`数据库驱动总数超过上限 ${MAX_DRIVERS_TOTAL}`);
    let mine = 0;
    for (const d of drivers.values()) {
        if (d.pluginId === record.pluginId) mine += 1;
    }
    if (mine >= MAX_DRIVERS_PER_PLUGIN) bad(`单插件驱动数超过上限 ${MAX_DRIVERS_PER_PLUGIN}`);
    drivers.set(record.kind, record);
    return record;
}

export function clearPluginDbDrivers() {
    drivers.clear();
}

export function getPluginDbDrivers() {
    return [...drivers.values()].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

export function getPluginDbDriverByKind(kind) {
    return drivers.get(String(kind || '')) || null;
}
