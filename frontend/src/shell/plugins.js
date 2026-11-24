// 插件运行时：加载插件 JS、提供 cadt.* API、管理格式/命令/主题的注册生命周期。
// 与 main.js 通过 initPluginRuntime(hooks) 单向注入，避免循环依赖。
import {registerPluginFormat, unregisterAllPluginFormats} from '../core/formats.js';
import {themeRegistry} from '../core/theme-registry.js';
import {clearPluginAIProviders, getPluginAIProviders, registerPluginAIProvider} from './plugin-ai-providers.js';
import {normalizePluginCommand} from './plugin-commands-model.js';
import {
    clearPluginDbDrivers, getPluginDbDrivers, registerPluginDbDriver,
} from './plugin-db-drivers.js';
import {
    bindServiceBackend, buildServiceSpecs, clearPluginServices, registerPluginService,
    serviceLogs, serviceStatus, startService, stopService,
} from './plugin-services.js';
import {
    clearPluginSettingsPanels, getPluginSettingsPanels, registerPluginSettingsPanel,
} from './plugin-settings-panels.js';
import {clearPluginTools, registerPluginTool} from './plugin-tools.js';
import {clearPluginAIContexts, registerPluginAIContext} from './plugin-context.js';
import {clearPluginImporters, registerPluginImporter} from './plugin-importers.js';
import {clearPluginViewers, registerPluginViewer} from './plugin-viewers.js';

const host = {
    flash: () => {},
    getActiveFile: () => null,
    getActiveText: () => null,
    openPath: () => {},
    onPluginsChanged: () => {},
    onThemesChanged: () => {},
    readPluginAsset: () => Promise.reject(new Error('当前版本不支持读取插件资产')),
};

let commands = [];
// 命令风险分类器（docs/finished-plans/local-command-classifier.md §4）：
// 插件可注册 {id, label, classify(command, ctx) → {score, reason}}（可返回 Promise）。
// score = 危险概率 [0,1]；无 deny 权——判定统一由 AI 面板按严格度阈值转 allow/ask。
const commandClassifiers = new Map();
// 文档格式转换器（通用 doc 能力）：插件注册 Word/PDF 等重格式生成器，任何核心
// 导出场景（便签面板、AI 回答另存、阅读导出……）按需消费——重依赖全在插件侧，
// 核心 exe 保持零依赖。ctx 由消费方组装（title/html/images + 落盘原语）。
const docConverters = new Map();

export function getPluginDocConverters() {
    return [...docConverters.values()];
}

export function initPluginRuntime(hooks) {
    Object.assign(host, hooks || {});
}

export function getPluginCommands() {
    return commands;
}

export function getPluginCommandClassifiers() {
    return [...commandClassifiers.values()];
}

export function getPluginAIProviderList() {
    return getPluginAIProviders();
}

export function getPluginSettingsPanelList() {
    return getPluginSettingsPanels();
}

// 最近一次 loadPlugins 的加载错误（每个插件一条「名称：原因」），供诊断 UI 区分
// 「插件未安装」与「已安装但加载失败」——端侧分类器状态行据此不再误报「未安装」。
let lastLoadErrors = [];

export function getPluginLoadErrors() {
    return [...lastLoadErrors];
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
        // 注册命令：{id, label, run, icon?, description?, category?, contexts?, when?, shortcut?}
        // 归一化与校验在 plugin-commands-model.js（纯函数）；宿主按 contexts 决定进哪些入口。
        addCommand(spec) {
            let cmd;
            try {
                cmd = normalizePluginCommand(plugin.id, plugin.name, spec);
            } catch (e) {
                throw pluginError(plugin, (e && e.message) || e);
            }
            if (commands.some((c) => c.id === cmd.id)) {
                throw pluginError(plugin, `命令 ${spec && spec.id} 已注册`);
            }
            commands.push(cmd);
        },
        // 注册文件图标主题：{id, name, extends?, icons: {json: '<svg…>', default_file: '<svg…>', …}}
        registerIconTheme(spec) {
            try {
                themeRegistry.registerIconTheme(spec, plugin);
            } catch (e) {
                throw pluginError(plugin, (e && e.message) || String(e));
            }
        },
        // 注册界面主题：{id, name, extends?, bg?, accent?, vars?, css?}
        addTheme(spec) {
            try {
                themeRegistry.registerUiTheme(spec, plugin);
            } catch (e) {
                throw pluginError(plugin, (e && e.message) || String(e));
            }
        },
        // 注册代码主题：{id, name, extends?, group?, vars?}
        addCodeTheme(spec) {
            try {
                themeRegistry.registerCodeTheme(spec, plugin);
            } catch (e) {
                throw pluginError(plugin, (e && e.message) || String(e));
            }
        },
        // 注册命令风险分类器：{id, label, classify(command, ctx) → {score, reason}}
        // ctx: {cwd, toolName, strictness, threshold, sessionId}；score = 危险概率 [0,1]，
        // 分类器只产出概率（无 deny 权），allow/ask 由核心按严格度阈值统一判定。
        registerCommandClassifier(spec) {
            if (!spec || typeof spec !== 'object') {
                throw pluginError(plugin, 'registerCommandClassifier 需要一个分类器对象');
            }
            const id = String(spec.id || '').trim();
            if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
                throw pluginError(plugin, `分类器 id 无效：${JSON.stringify(spec.id)}`);
            }
            if (typeof spec.classify !== 'function') {
                throw pluginError(plugin, '分类器缺少 classify 函数');
            }
            const fullId = `${plugin.id}:${id}`;
            if (commandClassifiers.has(fullId)) {
                throw pluginError(plugin, `分类器 ${id} 已注册`);
            }
            commandClassifiers.set(fullId, {
                id: fullId,
                pluginId: plugin.id,
                label: String(spec.label || id).trim().slice(0, 40),
                classify: spec.classify,
            });
        },
        // 注册可插拔 AI provider：{id, name, account, models, prepare(ctx)}。
        // 账号以虚拟 profile 进入模型选择器，prepare 在每轮组装请求配置时注入动态补丁。
        // 详见 docs/plugins/README.md「注册 AI provider」。
        registerAIProvider(spec) {
            return registerPluginAIProvider(plugin.id, spec);
        },
        // 注册 AI 工具：{name, description, parameters?, readOnly?, timeoutMs?, execute(args, ctx)}。
        // 默认关闭，须用户在 设置 → AI → 权限 → 插件工具 授权后才下发给模型；
        // 安全模型见 docs/unfinished-plans/plugin-tool-security.md。
        registerTool(spec) {
            try {
                return registerPluginTool(plugin.id, plugin.name, spec);
            } catch (e) {
                throw pluginError(plugin, (e && e.message) || e);
            }
        },
        // 注册 AI 上下文：{id, label?, stable?, text(ctx)}——注入系统提示词的领域知识。
        // 上限单条 4 KiB / 合计 12 KiB；内容按数据处理（docs/plugins/README.md）。
        registerAIContext(spec) {
            try {
                return registerPluginAIContext(plugin.id, plugin.name, spec);
            } catch (e) {
                throw pluginError(plugin, (e && e.message) || e);
            }
        },
        // 注册文档导入器：{id, label?, extensions, convert(ctx)}——把内置格式解析不了的文件转成文本。
        registerImporter(spec) {
            try {
                return registerPluginImporter(plugin.id, plugin.name, spec);
            } catch (e) {
                throw pluginError(plugin, (e && e.message) || e);
            }
        },
        // 注册自定义视图：{id, label?, formats, priority?, mount(container, ctx)}。
        // 视图只渲染不改数据（写回经 ctx.requestSave 上抛编辑器），必须返回 destroy。
        // 详见 docs/plugins/README.md「注册自定义视图」与路线图 2.2 节。
        registerViewer(spec) {
            try {
                return registerPluginViewer(plugin.id, plugin.name, spec);
            } catch (e) {
                throw pluginError(plugin, (e && e.message) || e);
            }
        },
        // 返回本插件的安装目录（绝对路径）；插件可用它拼自己的资源/脚本路径。
        getPluginDir() {
            return String(plugin.dir || '');
        },
        // 注册后台服务：{id, exe, args, cwd?, healthURL?, autoStart?, pollIntervalMs?, logCapBytes?}。
        // 进程启停/健康检查/退出清理由 Go 侧统一托管，详见 docs/plugins/README.md「注册后台服务」。
        registerService(spec) {
            return registerPluginService(plugin.id, plugin.dir, spec);
        },
        // 注册插件专属设置面板：{id, label, render(container, ctx)}。
        // ctx 提供 flash 与本插件服务操作，详见 docs/plugins/README.md「插件专属设置面板」。
        registerSettingsPanel(spec) {
            return registerPluginSettingsPanel(plugin.id, spec);
        },
        // 服务操作（按本插件内的短 id）。返回 Promise。
        startService(id) { return startService(plugin.id, id); },
        stopService(id) { return stopService(plugin.id, id); },
        getServiceStatus(id) { return serviceStatus(plugin.id, id); },
        getServiceLogs(id) { return serviceLogs(plugin.id, id); },
        // 注册数据库驱动：{id, label, fields, connect(config)}——「其他数据库交给插件」的扩展面。
        // kind = plugin:<插件id>:<驱动id>，侧栏「数据库」面板按声明动态出连接表单，
        // 内容区标签页复用对象树/网格/控制台；会话形状契约见 docs/plugins/README.md。
        registerDbDriver(spec) {
            try {
                return registerPluginDbDriver(plugin.id, plugin.name, spec);
            } catch (e) {
                throw pluginError(plugin, (e && e.message) || e);
            }
        },
        // 注册文档格式转换器：{id, label, extensions, convert(ctx)}——通用导出能力，
        // 各导出场景（便签面板 / AI 回答另存 / 阅读导出…）把内容组装成统一 ctx 后调用
        // convert；Word/PDF 等生成依赖全在插件侧随插件分发。ctx：{title, suggestedName,
        // html(图片为相对 img/ 引用), images:[{name,mime,base64}], chooseSavePath(defaultName),
        // writeTextFile(path,content), writeBinaryFile(path,base64,mime), flash(msg,isErr)}。
        // 详见 docs/plugins/README.md「注册文档格式转换器」。
        registerDocConverter(spec) {
            if (!spec || typeof spec !== 'object') {
                throw pluginError(plugin, 'registerDocConverter 需要一个转换器对象');
            }
            const id = String(spec.id || '').trim();
            if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
                throw pluginError(plugin, `转换器 id 无效：${JSON.stringify(spec.id)}`);
            }
            if (typeof spec.convert !== 'function') {
                throw pluginError(plugin, '转换器缺少 convert 函数');
            }
            const fullId = `${plugin.id}:${id}`;
            if (docConverters.has(fullId)) {
                throw pluginError(plugin, `转换器 ${id} 已注册`);
            }
            docConverters.set(fullId, {
                id: fullId,
                pluginId: plugin.id,
                label: String(spec.label || id).trim().slice(0, 60),
                extensions: Array.isArray(spec.extensions) ? spec.extensions.map(String).filter(Boolean) : [],
                convert: spec.convert,
            });
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
        // 同步执行命令：{exe, args, cwd, timeoutMs} → Promise<{code, stdout, stderr}>（调用方要 await）
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
        // 读取插件目录内的图片资产：path 相对插件目录，返回 data URL
        readAsset(path) {
            return Promise.resolve(host.readPluginAsset(plugin.id, String(path || '')));
        },
        flash(message) {
            host.flash(String(message ?? ''));
        },
    };
}

// 清空上一轮注册并按当前启用列表重新执行插件代码；返回错误信息数组。
// 插件注册表状态变化广播：loadPlugins 每次完成（含清空 / 跳过 / 失败路径）都派发，
// 订阅方（如端侧模型设置的下拉与状态行）据此原位刷新，不必各自轮询
function notifyPluginsLoaded() {
    try { window.dispatchEvent(new CustomEvent('cadt-plugins-loaded')); } catch (e) {}
}

let pluginLoadQueue = Promise.resolve();

export function loadPlugins(backend) {
    const run = pluginLoadQueue.catch(() => {}).then(() => reloadPlugins(backend));
    pluginLoadQueue = run.then(() => {}, () => {});
    return run;
}

async function reloadPlugins(backend) {
    themeRegistry.clearPluginThemes();
    unregisterAllPluginFormats();
    clearPluginAIProviders();
    clearPluginDbDrivers();
    clearPluginServices();
    clearPluginSettingsPanels();
    clearPluginTools();
    clearPluginAIContexts();
    clearPluginImporters();
    clearPluginViewers();
    bindServiceBackend(backend);
    commands = [];
    commandClassifiers.clear();
    docConverters.clear();
    lastLoadErrors = [];
    host.onPluginsChanged();
    if (!backend || typeof backend.GetPluginSources !== 'function') {
        console.info('[plugins] 跳过加载：宿主无 GetPluginSources 绑定');
        host.onThemesChanged();
        notifyPluginsLoaded();
        return [];
    }
    let sources = [];
    try {
        sources = (await backend.GetPluginSources()) || [];
    } catch (e) {
        lastLoadErrors = [`读取插件失败：${e}`];
        console.info('[plugins] 读取插件源失败：' + lastLoadErrors[0]);
        host.onThemesChanged();
        notifyPluginsLoaded();
        return [...lastLoadErrors];
    }
    const errors = [];
    for (const source of sources) {
        try {
            const api = apiFor({id: source.id, name: source.name, dir: source.dir || ''});
            new Function('cadt', `"use strict";\n${source.code || ''}`)(api);
        } catch (e) {
            themeRegistry.removePluginThemes(source.id);
            const message = `${source.name || source.id}：${(e && e.message) || e}`;
            errors.push(message);
        }
    }
    // 所有插件重放完成后，一次性把服务声明推给 Go：新增/变更的自启服务拉起，
    // 被禁用/卸载插件的服务停止。Sync 失败只记诊断，不阻断插件加载。
    if (backend && typeof backend.AppServiceSync === 'function') {
        try {
            await backend.AppServiceSync(buildServiceSpecs());
        } catch (e) {
            console.warn('[plugins] 后台服务同步失败：' + ((e && e.message) || e));
        }
    }
    lastLoadErrors = [...errors];
    // 诊断行：插件加载是静默失败高发区（源被 Go 侧跳过 / 入口早期 return 都不报错），
    // 进 F12 调试控制台与 jsonl，排查「分类器未注册」类问题从这里看起
    console.info('[plugins] 加载完成：源 ' + sources.length + ' 个（' +
        sources.map((s) => s.id).join('、') + '）· 命令分类器 ' + commandClassifiers.size +
        ' 个 · AI provider ' + getPluginAIProviders().length +
        ' 个 · 服务 ' + buildServiceSpecs().length +
        ' 个 · 数据库驱动 ' + getPluginDbDrivers().length +
        ' 个 · 设置面板 ' + getPluginSettingsPanels().length +
        ' 个 · 错误 ' + errors.length + (errors.length ? '：' + errors.join('；') : ''));
    host.onPluginsChanged();
    host.onThemesChanged();
    notifyPluginsLoaded();
    return errors;
}
