// 插件专属设置面板注册表（纯逻辑，无 DOM 依赖）：插件经 cadt.registerSettingsPanel
// 声明一个设置子页，设置 → 插件 页为每个声明的插件加「详情/设置」入口，点击后进入
// data-pane="plugin-<插件id>:<面板id>" 的动态面板，由 spec.render(container, ctx) 填充内容。
//
// ctx 由宿主注入，提供 flash 与本插件的服务操作（start/stop/status/logs），
// 让面板能直接呈现服务状态和控制按钮，而不用插件自己碰 backend。

const ID_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const panels = new Map();

function bad(message) {
    throw new Error('[registerSettingsPanel] ' + message);
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

// 面板的全局 pane key：settings 里用它做 data-pane 与导航 id。
// 只用 [a-z0-9-]，避免 CSS 属性选择器里的转义问题。
export function panelPaneKey(pluginId, panelId) {
    return 'plugin-' + pluginId + '-' + panelId;
}

export function registerPluginSettingsPanel(pluginId, spec, pluginName) {
    const owner = String(pluginId || '').trim();
    if (!owner) bad('缺少插件 id');
    if (!isPlainObject(spec)) bad('需要一个设置面板对象');
    const id = String(spec.id || '').trim();
    if (!ID_RULE.test(id)) bad(`id 无效：${JSON.stringify(spec.id)}`);
    if (typeof spec.render !== 'function') bad('缺少 render 函数');
    const key = panelPaneKey(owner, id);
    if (panels.has(key)) bad(`设置面板 ${id} 已注册`);
    const record = {
        key,
        pluginId: owner,
        // 插件显示名：进 render(container, ctx) 的基座（ctx.plugin.name），缺省回落 id。
        pluginName: String(pluginName || owner).trim() || owner,
        id,
        label: String(spec.label || spec.id || '设置').trim().slice(0, 40),
        render: spec.render,
    };
    panels.set(key, record);
    return record;
}

export function clearPluginSettingsPanels() {
    panels.clear();
}

export function getPluginSettingsPanels() {
    return [...panels.values()];
}

export function getPluginSettingsPanel(key) {
    return panels.get(String(key || '')) || null;
}

export function panelsOfPlugin(pluginId) {
    return getPluginSettingsPanels().filter((p) => p.pluginId === pluginId);
}
