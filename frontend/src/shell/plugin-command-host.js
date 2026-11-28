// plugin-command-host.js：插件命令 ctx 构造 + 执行/写回的统一宿主接线。
// 把 createPluginCommandEnv 与 createPluginCommandRunner 合到一个入口，main.js 只留一次注入。
import {createPluginCommandEnv} from './plugin-command-env.js';
import {createPluginCommandRunner} from './plugin-command-runner.js';

/**
 * @param {any} deps 宿主能力（函数形态，活引用）
 * @returns {{pluginCommandEnv: Function, runPluginCommand: Function}}
 */
export function createPluginCommandHost(deps) {
    const pluginCommandEnv = createPluginCommandEnv({
        currentMode: deps.currentMode, editor: deps.editor, textArea: deps.textArea,
        file: deps.file, settings: deps.settings, workspace: deps.workspace,
        isDocReadOnly: deps.isDocReadOnly,
    });
    const runPluginCommand = createPluginCommandRunner({
        buildEnv: (cmd) => pluginCommandEnv(cmd),
        flash: deps.flash,
        openVirtualDoc: deps.openVirtualDoc,
        editor: deps.editor,
        mode: deps.currentMode,
        file: deps.file,
        settings: deps.settings,
        isDocReadOnly: deps.isDocReadOnly,
        markDocDirty: deps.markDocDirty,
        updateStatus: deps.updateStatus,
    });
    return {pluginCommandEnv, runPluginCommand};
}
