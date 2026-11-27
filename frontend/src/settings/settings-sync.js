// settings-sync.js：跨窗口设置同步的纯逻辑（2026-11-22）。
// 背景：设置存在共享 localStorage，但每个窗口只在启动时读一次到内存 settings 对象；
// 任一窗口改设置后，其他窗口的内存副本不刷新，导致设置页 / 认知索引开关显示旧值。
// 修复：写入方广播全量快照（settings-changed），接收方把快照**原地合并**进现有 settings 对象。
//
// 为什么原地合并（Object.assign）而不是替换引用：ai-panel.js:327 `const settings = opts.settings`
// 及 ai-cognition / 各域模块都持有 settings 的值快照引用，替换对象它们读不到新值。

// sameValue：逐键相等判定。设置快照是 JSON.parse 产物，对象/数组键（runArgs、runConfigs、
// runProfiles、langEnv、formatSettings…）每次广播都是新引用——只按 Object.is 比较的话
// 「内容没变」也会报变更，导致每次广播接收方与发送方回声都做一次全量 applySettings 重绘。
// 引用相同走 Object.is 快路径；同为纯对象/数组按结构比较（键序无关），其余类型不同引用即变更。
function sameValue(a, b) {
    if (Object.is(a, b)) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    const aArr = Array.isArray(a);
    if (aArr !== Array.isArray(b)) return false;
    if (aArr) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!sameValue(a[i], b[i])) return false;
        }
        return true;
    }
    // 非 plain 对象（Date/Map 等，设置里不存在）不同引用一律视为变更，不做假相等
    if (a.constructor !== Object || b.constructor !== Object) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const k of keys) {
        if (!Object.prototype.hasOwnProperty.call(b, k) || !sameValue(a[k], b[k])) return false;
    }
    return true;
}

// mergeSettingsInto：把快照原地合并进目标对象，返回真正发生变化的键名列表。
// - 只接受普通对象快照，其他形状直接忽略（防御畸形 payload）。
// - 逐键按值比较（sameValue），内容没变不写入（发出的窗口自己也收广播，必须幂等）。
// - 原地写 target，保持所有持有者引用有效；内容相同的对象键连引用都保持不动。
export function mergeSettingsInto(target, snapshot) {
    if (!target || typeof target !== 'object' || !snapshot || typeof snapshot !== 'object' ||
        Array.isArray(snapshot)) return [];
    const changed = [];
    for (const key of Object.keys(snapshot)) {
        const next = snapshot[key];
        if (sameValue(target[key], next)) continue;
        target[key] = next;
        changed.push(key);
    }
    return changed;
}

// 每窗口独立的布局/模式/选择键：跨窗口设置同步（settings-changed 广播 + 方案 C 重读）刻意不传播。
// 判类规则：描述**当前窗口自身形态**的键（面板显隐/宽度/形态、窗口模式、当前选择）→ 每窗独立；
// 描述**用户偏好与数据**的键（字体、主题、行为开关、配置表）→ 全局同步。
// 点侧边栏 icon、拖侧栏/终端宽度、切 AI 面板形态、进写作模式、置顶窗口、选运行配置这类操作
// 只属于当前窗口，镜像到别的窗口既没有意义，又会触发对端全量 applySettings 重绘。
// AI 面板形态/停靠侧（aiFloatMode / aiPanelSide）按 2026-11-17 硬规则本来就是「只能用户手动切」
// 的窗口级状态，同理不跨窗；runActiveProfile 决定标题栏 ▶ 跑哪个配置，镜像过去会让 B 窗跑 A 窗
// 选中的配置（绑定文件还是 A 的路径）。localStorage 仍是共享单槽：重启后取最后写入者的值——
// 与引入同步之前的行为一致。
export const PER_WINDOW_LAYOUT_KEYS = [
    'showSidebar', 'sidebarView', 'sidebarMode', 'sidebarWidth',
    'terminalHeight', 'gitCommitAreaHeight',
    'aiPanelOpen', 'aiPanelWidth', 'aiPanelSide', 'aiFloatMode',
    'splitRatio',
    'alwaysOnTop', 'writingMode', 'runActiveProfile',
    // 窗口模式（单 / 多工作区）：一个窗口切模式不该把别的窗口也改掉
    'windowMode',
];

// stripPerWindowLayout：从快照里剥掉布局键（返回浅拷贝，不改入参）。
// 合并入口（applyRemoteSettings）必须过这一刀——它是广播与方案 C 重读的共同必经点。
export function stripPerWindowLayout(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
    const out = {...snapshot};
    for (const key of PER_WINDOW_LAYOUT_KEYS) delete out[key];
    return out;
}
