// plugin-host-wiring.js：插件平台扩展在宿主侧的统一接线（供 main.js 一次调用）。
// 目的：把 8 个新接口的「import + deps 注入 + 事件转发」集中到 shell 域，
// 让组合根 main.js 只留一行 init，守住「只减不增」的行数基线。
import {PLUGIN_CTX_ORIGINS, pluginCtxBase, withCtx} from './plugin-ctx.js';
import {registerContextProvider as regCtxProvider, clearContextProviders, removeContextProvidersByOwner} from './plugin-context-provider.js';
import {registerPluginSkill, clearPluginSkills, removePluginSkillsByOwner} from './plugin-skills.js';
import {registerPluginPage, clearPluginPages, pluginPagesAsAppPages, pluginPageMounters, getPluginPages, removePluginPagesByOwner} from './plugin-pages.js';
import {registerFileDecorator as regFileDecorator, registerFileAction as regFileAction,
    clearFileDecorators, clearFileActions, actionsFor, removeFileExtensionsByOwner} from './plugin-file-actions.js';
import {registerEditorDecoration as regEditorDecoration, registerInlineSuggestProvider as regInlineSuggest,
    clearEditorDecorations, clearInlineSuggestProviders, removeEditorExtensionsByOwner} from './plugin-editor-extensions.js';
import {registerTaskProvider as regTaskProvider, registerProgressReporter as regProgressReporter,
    registerBackgroundJob as regBackgroundJob, registerWorkspaceInitializer as regWorkspaceInitializer,
    clearTaskProviders, clearProgressReporters, clearBackgroundJobs, clearWorkspaceInitializers,
    removeTaskExtensionsByOwner} from './plugin-task-providers.js';
import {emitWorkspaceEvent as emitEvent} from './plugin-workspace-events.js';

/**
 * 把平台扩展 API 挂到插件 apiFor 对象上（plugins.js 在 apiFor 里 spread 本对象）。
 * 各方法用 plugin.id/name 闭包，与 plugins.js 的 pluginError 包错约定一致（这里不包，由调用方包）。
 */
export function platformApiFor(plugin, wrapError) {
    const id = plugin.id;
    const name = plugin.name;
    const wrap = typeof wrapError === 'function' ? wrapError : (fn) => fn();
    return {
        registerContextProvider: (spec) => wrap(() => regCtxProvider(id, name, spec)),
        registerPage: (spec) => wrap(() => registerPluginPage(id, name, spec)),
        registerFileDecorator: (spec) => wrap(() => regFileDecorator(id, name, spec)),
        registerFileAction: (spec) => wrap(() => regFileAction(id, name, spec)),
        registerEditorDecoration: (spec) => wrap(() => regEditorDecoration(id, name, spec)),
        registerInlineSuggestProvider: (spec) => wrap(() => regInlineSuggest(id, name, spec)),
        registerTaskProvider: (spec) => wrap(() => regTaskProvider(id, name, spec)),
        registerProgressReporter: (spec) => wrap(() => regProgressReporter(id, name, spec)),
        registerBackgroundJob: (spec) => wrap(() => regBackgroundJob(id, name, spec)),
        registerWorkspaceInitializer: (spec) => wrap(() => regWorkspaceInitializer(id, name, spec)),
    };
}

/** 插件重载时清空所有平台扩展注册表。 */
export function clearAllPlatformExtensions() {
    clearContextProviders();
    clearPluginPages();
    clearFileDecorators();
    clearFileActions();
    clearEditorDecorations();
    clearInlineSuggestProviders();
    clearTaskProviders();
    clearProgressReporters();
    clearBackgroundJobs();
    clearWorkspaceInitializers();
}

/** 文件树动作 + 各自的 ctx 基座（供 explorer 消费，explorer 域不 import shell）。 */
export function actionsWithCtx(path, workspace) {
    return actionsFor(path).map((a) => ({
        ...a,
        ctx: withCtx(pluginCtxBase({
            pluginId: a.pluginId, pluginName: a.pluginName,
            workspace, origin: PLUGIN_CTX_ORIGINS.command,
        }), {path: String(path || ''), name: String(path || '').split(/[\\/]/).pop() || '', isDir: false}),
    }));
}

/**
 * 半插件失败时按 owner 撤销平台扩展（ContextProvider 会进系统提示词、Page 会进导航，
 * 残留到下次全局 clear 的危害大于命令）。各模块的 clear 是全清，这里按 pluginId 精确删。
 */
export function revokePlatformOwner(pluginId) {
    const id = String(pluginId || '');
    if (!id) return;
    removePluginSkillsByOwner(id);
    removeContextProvidersByOwner(id);
    removePluginPagesByOwner(id);
    removeFileExtensionsByOwner(id);
    removeEditorExtensionsByOwner(id);
    removeTaskExtensionsByOwner(id);
}

export {pluginPageMounters, actionsFor, emitEvent};
export {initPluginPages} from './plugin-pages.js';
/** 插件页 id → mount 函数（loadPlugins 之后才注册，动态查）。 */
export function pluginPageMountOf(id) {
    const p = getPluginPages().find((item) => item.id === id);
    return p ? p.mount : null;
}
export * as pluginSkillsMod from './plugin-skills.js';
export * as pluginContextMod from './plugin-context.js';
export * as pluginContextProviderMod from './plugin-context-provider.js';
