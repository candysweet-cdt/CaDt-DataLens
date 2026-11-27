// 插件运行时：加载插件 JS、提供 cadt.* API、管理格式/命令/主题的注册生命周期。
// 与 main.js 通过 initPluginRuntime(hooks) 单向注入，避免循环依赖。
import {registerPluginFormat, unregisterAllPluginFormats} from '../core/formats.js';
import {themeRegistry} from '../core/theme-registry.js';
import {createHookBus} from '../core/hook-bus.js';
import {PLUGIN_CTX_ORIGINS, pluginCtxBase, withCtx} from './plugin-ctx.js';
import {createPluginContainer} from './plugin-container.js';
import {orderByDependencies} from './plugin-dependencies.js';
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

// ===== 插件运行时初始化 =====
export function getPluginDocConverters() {
    return [...docConverters.values()];
}

// ── 平台原语：依赖注入容器 + 进程内钩子总线（S4）─────────────────────────────
// 每次 loadPlugins 重建一对新实例：插件重放是幂等的（先 clear 再执行），容器与总线也必须
// 跟着换代，否则上一轮的服务引用与监听器会跨重载残留。消费者（ai-panel / editor 等）
// 一律经 getPluginContainer() / getPluginHookBus() **现取**，不要缓存引用。
let pluginContainer = null;
let pluginHookBus = null;

function ensurePlatformPrimitives() {
    pluginContainer = createPluginContainer({logf: (msg) => console.info(msg)});
    pluginHookBus = createHookBus({logf: (msg) => console.info(msg)});
    // 核心服务：插件可以 require 它们，也可以对它们挂钩子（如 core/pre-turn）
    pluginContainer.provide('core.host', {
        flash: (message) => host.flash(String(message ?? '')),
        getActiveFile: () => host.getActiveFile(),
        getActiveText: () => host.getActiveText(),
        openPath: (path) => host.openPath(path),
        readAsset: (pluginId, path) => Promise.resolve(host.readPluginAsset(pluginId, String(path || ''))),
    }, {owner: 'core'});
    pluginContainer.provide('core.hooks', pluginHookBus, {owner: 'core'});
    return {container: pluginContainer, bus: pluginHookBus};
}

// ===== 插件能力访问器 =====
/** 当前这一轮的插件容器（未加载过插件时为 null）。 */
export function getPluginContainer() {
    return pluginContainer;
}

/** 当前这一轮的插件钩子总线（未加载过插件时为 null）。 */
export function getPluginHookBus() {
    return pluginHookBus;
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

function requireContainer() {
    if (!pluginContainer) throw new Error('插件容器尚未初始化（loadPlugins 未执行）');
    return pluginContainer;
}

function requireHookBus() {
    if (!pluginHookBus) throw new Error('插件钩子总线尚未初始化（loadPlugins 未执行）');
    return pluginHookBus;
}

// ===== 插件 API 构造 =====
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
            // 存一层包装：插件能拿到自己的身份（ctx.plugin）与 origin:'classifier'，宿主传的
            // {cwd, toolName, strictness, threshold, sessionId, workspace} 原样叠加（域字段优先，
            // 身份恒取基座）。fn 先取出来再调，保持原有的「this 不指向注册对象」语义
            // ——旧实现是直接存 spec.classify，别让这次包装悄悄改掉插件的 this。
            const classifyFn = spec.classify;
            commandClassifiers.set(fullId, {
                id: fullId,
                pluginId: plugin.id,
                label: String(spec.label || id).trim().slice(0, 40),
                classify: (command, runtimeCtx) => classifyFn(command, withCtx(pluginCtxBase({
                    pluginId: plugin.id,
                    pluginName: plugin.name,
                    workspace: runtimeCtx && runtimeCtx.workspace,
                    sessionId: runtimeCtx && runtimeCtx.sessionId,
                    origin: PLUGIN_CTX_ORIGINS.classifier,
                }), runtimeCtx)),
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
            return registerPluginSettingsPanel(plugin.id, spec, plugin.name);
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
                // 显示名要存下来：导出 ctx 的 ctx.plugin.name 取它（漏了就会回落成插件 id）
                pluginName: plugin.name,
                label: String(spec.label || id).trim().slice(0, 60),
                extensions: Array.isArray(spec.extensions) ? spec.extensions.map(String).filter(Boolean) : [],
                convert: spec.convert,
            });
        },
        // ── 依赖注入（S4）───────────────────────────────────────────────────
        // 服务名用点分稳定 key（约定：插件自己提供的服务用 `plugin.<插件id>.<名字>`，
        // 想替换核心服务则直接用核心的 key 并传 replace:true，冲突时有明确报错）。
        // group（realm 隔离）：opts.group 缺省不分组（全局可见）；显式给定时同名服务
        // 只在同 group 内可见，查找先同组再回落全局——对齐 Cordis realm。
        // provide 返回撤销函数；卸载插件时宿主还会按 owner 整体撤一遍，双保险。
        provide(name, value, opts) {
            return requireContainer().provide(name, value, {...(opts || {}), owner: plugin.id});
        },
        // 取服务，缺失返回 undefined（用于「有就增强、没有就降级」）。
        getService(name, opts) {
            return requireContainer().get(name, opts);
        },
        // 取服务，缺失抛错（用于「硬依赖」；错误信息会列出已注册 key 便于排查拼写）。
        require(name, opts) {
            return requireContainer().require(name, opts);
        },
        hasService(name, opts) {
            return requireContainer().has(name, opts);
        },
        // 声明依赖并等待就绪：await cadt.inject(['core.host']) → {'core.host': {...}}
        inject(names, opts) {
            return requireContainer().inject(names, opts);
        },
        // 声明一次性副作用并登记 disposer（Cordis ctx.effect）：fn 立即执行，返回的
        // 清理函数在插件禁用 / 重载时由宿主按 owner 统一调用；也可自己调返回的撤销函数。
        effect(fn, opts) {
            return requireContainer().effect(fn, {...(opts || {}), owner: plugin.id});
        },
        // ── 钩子（S4，进程内五模式）──────────────────────────────────────────
        // on 返回解绑函数；owner 自动记为插件 id，禁用插件时整体撤销。
        on(name, fn, opts) {
            return requireHookBus().on(name, fn, {...(opts || {}), owner: plugin.id});
        },
        emit(name, payload) {
            return requireHookBus().emit(name, payload);
        },
        waterfall(name, value, payload) {
            return requireHookBus().waterfall(name, value, payload);
        },
        parallel(name, payload) {
            return requireHookBus().parallel(name, payload);
        },
        serial(name, payload) {
            return requireHookBus().serial(name, payload);
        },
        bail(name, payload) {
            return requireHookBus().bail(name, payload);
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

// ===== 加载与重载 =====
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
    // 换代前先把上一轮的容器与总线整体拆掉：等待中的 inject 会被拒（不会永远悬着），
    // 插件注册的 dispose 逐个执行，监听器随总线一起丢弃。顺序在 clear* 之前——否则
    // dispose 回调里若读注册表会读到已被清空的状态。
    if (pluginContainer) pluginContainer.dispose();
    if (pluginHookBus) pluginHookBus.dispose();
    pluginContainer = null;
    pluginHookBus = null;

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
    ensurePlatformPrimitives();
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
    // 依赖声明（S7）：manifest 的 dependencies 决定执行顺序——被依赖者先执行，否则它
    // 提供的服务在对方 apply 时还不存在，inject 只能等超时。排序失败（循环 / 缺依赖）
    // 记一条错误并把该插件跳过，不阻断其余插件。
    const ordered = orderByDependencies(sources, errors);
    for (const source of ordered) {
        try {
            const api = apiFor({id: source.id, name: source.name, dir: source.dir || ''});
            // Cordis 风格：插件可以 `return {apply(ctx)}`、`module.exports = {apply(ctx)}`，
            // 也可以继续用纯脚本式的 cadt.xxx() 直接注册（老插件零改动）。三种写法可共存。
            // module / exports 是给 CommonJS 写法准备的薄壳：没有它，插件里写 module.exports
            // 会直接 ReferenceError（真踩过）。
            const moduleShim = {exports: {}};
            const returned = new Function('cadt', 'module', 'exports',
                `"use strict";\n${source.code || ''}`)(api, moduleShim, moduleShim.exports);
            const exported = returned || moduleShim.exports;
            if (exported && typeof exported.apply === 'function') {
                const applied = exported.apply(api);
                // apply 允许是 async：等它完成再执行下一个插件，保证「被依赖者先就绪」。
                // 但必须有上限——插件返回一个永不结算的 Promise 会把整条 pluginLoadQueue
                // 永久挂住，之后所有 loadPlugins 调用都排在它后面（旧代码是 fire-and-forget）。
                if (applied && typeof applied.then === 'function') {
                    await Promise.race([
                        applied,
                        new Promise((_resolve, reject) => {
                            setTimeout(() => reject(new Error('apply 超时（5000ms），已放弃等待')), 5000);
                        }),
                    ]);
                }
            }
        } catch (e) {
            themeRegistry.removePluginThemes(source.id);
            // 只撤本轮新增的平台侧注册（服务 / 钩子）。命令、分类器、转换器等「已成功的部分」
            // 按既有契约保留到下一次全局 clear*——plugin-commands 的集成测试钉住了这个语义
            // （半个插件失败时，先前那条命令仍可用），改它会静默改变用户可见行为。
            if (pluginContainer) pluginContainer.disposeOwner(source.id);
            if (pluginHookBus) pluginHookBus.offOwner(source.id);
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
        ' 个 · DI 服务 ' + (pluginContainer ? pluginContainer.size : 0) +
        ' 个 · 钩子 ' + (pluginHookBus ? pluginHookBus.eventNames().length : 0) +
        ' 类 · 错误 ' + errors.length + (errors.length ? '：' + errors.join('；') : ''));
    host.onPluginsChanged();
    host.onThemesChanged();
    notifyPluginsLoaded();
    return errors;
}
