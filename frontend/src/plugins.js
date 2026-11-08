// 插件运行时：加载插件 JS、提供 cadt.* API、管理格式/命令/主题的注册生命周期。
// 与 main.js 通过 initPluginRuntime(hooks) 单向注入，避免循环依赖。
import {registerPluginFormat, unregisterAllPluginFormats} from './formats.js';

const host = {
    flash: () => {},
    getActiveFile: () => null,
    getActiveText: () => null,
    openPath: () => {},
    addPluginTheme: () => {},
    onPluginsChanged: () => {},
};

let commands = [];
const themeStyles = new Map();

export function initPluginRuntime(hooks) {
    Object.assign(host, hooks || {});
}

export function getPluginCommands() {
    return commands;
}

const iconThemes = {};

export function getPluginIconThemes() {
    return iconThemes;
}

function pluginError(plugin, message) {
    return new Error(`[${plugin.name || plugin.id}] ${message}`);
}

function apiFor(plugin) {
    return {
        // 注册自定义文件格式：{id, name, extensions, parse(text), stringify(value), aceMode?, rawOnly?, table?, parseTable?, stringifyTable?}
        registerFormat(driver) {
            if (!driver || typeof driver !== 'object') {
                throw pluginError(plugin, 'registerFormat 需要一个格式对象');
            }
            return registerPluginFormat({...driver, pluginId: plugin.id});
        },
        // 注册工具菜单命令：{id, label, run()}
        addCommand(spec) {
            if (!spec || typeof spec !== 'object') {
                throw pluginError(plugin, 'addCommand 需要一个命令对象');
            }
            const id = String(spec.id || '').trim();
            const label = String(spec.label || '').trim();
            if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
                throw pluginError(plugin, `命令 id 无效：${JSON.stringify(spec.id)}`);
            }
            if (!label || typeof spec.run !== 'function') {
                throw pluginError(plugin, '命令缺少 label 或 run');
            }
            if (commands.some((c) => c.id === `${plugin.id}:${id}`)) {
                throw pluginError(plugin, `命令 ${id} 已注册`);
            }
            commands.push({id: `${plugin.id}:${id}`, pluginId: plugin.id, label, run: spec.run});
        },
        // 注册文件图标主题：{id, name, icons: {json: '<svg…>', default_file: '<svg…>', …}}
        // icons 缺失的类型自动回退到内置文字缩写图标
        registerIconTheme(spec) {
            if (!spec || typeof spec !== 'object') {
                throw pluginError(plugin, 'registerIconTheme 需要一个主题对象');
            }
            const id = String(spec.id || '').trim();
            if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
                throw pluginError(plugin, `图标主题 id 无效：${JSON.stringify(spec.id)}`);
            }
            if (!spec.icons || typeof spec.icons !== 'object') {
                throw pluginError(plugin, 'registerIconTheme 缺少 icons 映射');
            }
            const icons = {};
            for (const [k, v] of Object.entries(spec.icons)) {
                if (typeof v === 'string' && v.includes('<svg')) icons[k] = v;
            }
            if (!Object.keys(icons).length) {
                throw pluginError(plugin, 'registerIconTheme 的 icons 为空');
            }
            iconThemes[id] = {id, name: String(spec.name || id), icons};
            host.addPluginIconTheme({id, name: String(spec.name || id), icons});
        },
        // 注册主题：{id, name, bg, accent, css}，css 里用 html[data-theme="<id>"] 选择器
        addTheme(spec) {
            if (!spec || typeof spec !== 'object') {
                throw pluginError(plugin, 'addTheme 需要一个主题对象');
            }
            const id = String(spec.id || '').trim();
            if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
                throw pluginError(plugin, `主题 id 无效：${JSON.stringify(spec.id)}`);
            }
            if (themeStyles.has(id)) {
                throw pluginError(plugin, `主题 ${id} 已注册`);
            }
            const style = document.createElement('style');
            style.dataset.pluginTheme = id;
            style.textContent = String(spec.css || '');
            document.head.appendChild(style);
            themeStyles.set(id, style);
            host.addPluginTheme({id, name: String(spec.name || id), bg: spec.bg || '#1e1f24', accent: spec.accent || '#4f8cff'});
        },
        getActiveFile() {
            return host.getActiveFile();
        },
        getActiveText() {
            return host.getActiveText();
        },
        openPath(path) {
            host.openPath(path);
        },
        // 同步执行命令：{exe, args, cwd, timeoutMs} → {code, stdout, stderr}
        runCommandSync(opts) {
            return host.runCommandSync(opts);
        },
        // 流式执行命令：{exe, args, cwd, onOut, onErr, onExit} → {stop()}
        runCommand(opts) {
            return host.runCommand(opts);
        },
        // 以只读虚拟文档打开文本（用于展示命令输出等）
        openVirtualDoc(name, content) {
            return host.openVirtualDoc(name, content);
        },
        flash(message) {
            host.flash(String(message ?? ''));
        },
    };
}

// 清空上一轮注册并按当前启用列表重新执行插件代码；返回错误信息数组。
export async function loadPlugins(backend) {
    unregisterAllPluginFormats();
    for (const style of themeStyles.values()) {
        style.remove();
    }
    themeStyles.clear();
    commands = [];
    host.onPluginsChanged();
    if (!backend || typeof backend.GetPluginSources !== 'function') {
        return [];
    }
    let sources = [];
    try {
        sources = (await backend.GetPluginSources()) || [];
    } catch (e) {
        return [`读取插件失败：${e}`];
    }
    const errors = [];
    for (const source of sources) {
        try {
            const api = apiFor({id: source.id, name: source.name});
            new Function('cadt', `"use strict";\n${source.code || ''}`)(api);
        } catch (e) {
            const message = `${source.name || source.id}：${(e && e.message) || e}`;
            errors.push(message);
        }
    }
    host.onPluginsChanged();
    return errors;
}
