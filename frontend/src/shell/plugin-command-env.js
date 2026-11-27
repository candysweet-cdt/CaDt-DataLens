// plugin-command-env.js：插件命令上下文环境（run(env) / when(env)）的构造。
//
// 从 main.js 拆出（组合根「只减不增」）：这段要做的是「读一遍当前编辑器状态 + 拼 ctx 基座」，
// 属于插件域，不该长在组合根里。
//
// deps 一律传**函数**而不是值：currentMode / editor / textArea / file / settings 在 main.js 里
// 都是会整体替换的可变绑定，拍成快照就会拿到旧值（AGENTS.md「导出可变 let 状态一律 getter 活引用」）。
import {PLUGIN_CTX_ORIGINS, pluginCtxBase, withCtx} from './plugin-ctx.js';

/**
 * @typedef {object} PluginCommandEnvDeps
 * @property {() => string} currentMode 当前视图模式（'code' 才有 Ace 选区/焦点）
 * @property {() => any} editor 编辑器实例（可能为 null）
 * @property {() => any} textArea 纯文本编辑区（非 code 模式下的选区来源）
 * @property {() => any} file 当前文档（可能为 null）
 * @property {() => any} settings 设置对象（只读判定要用）
 * @property {() => string} workspace 当前工作区根（多工作区下是聚焦会话的仓库）
 * @property {(doc: any, settings: any) => boolean} isDocReadOnly 只读判定（与编辑器同一实现）
 */

/**
 * 返回 pluginCommandEnv(cmd)：一次性只读快照。cmd 缺省时只拼基座（快捷键匹配阶段还不知道
 * 会命中哪条命令）；给了 cmd 时把插件身份带进 env，命令在 run 里读 `env.plugin.id` 即可认出自己。
 * @param {PluginCommandEnvDeps} deps
 * @returns {(cmd?: any) => Record<string, any>}
 */
export function createPluginCommandEnv(deps) {
    function safeEditor() {
        try {
            return deps.editor() || null;
        } catch (e) {
            return null;
        }
    }

    return function pluginCommandEnv(cmd) {
        let hasSelection = false;
        try {
            const editor = safeEditor();
            if (deps.currentMode() === 'code' && editor && editor.aceEditor) {
                hasSelection = !!editor.aceEditor.getSelectedText();
            } else {
                const area = deps.textArea();
                if (area) hasSelection = area.selectionStart !== area.selectionEnd;
            }
        } catch (e) {
            hasSelection = false;
        }
        let editorFocused = false;
        try {
            const editor = safeEditor();
            editorFocused = !!(deps.currentMode() === 'code' && editor && editor.aceEditor && editor.aceEditor.isFocused());
        } catch (e) {
            editorFocused = false;
        }
        let file = null;
        try {
            file = deps.file() || null;
        } catch (e) {
            file = null;
        }
        let workspace = '';
        try {
            workspace = deps.workspace ? String(deps.workspace() || '') : '';
        } catch (e) {
            workspace = '';
        }
        let readonly = false;
        try {
            readonly = !!file && !!deps.isDocReadOnly(file, deps.settings());
        } catch (e) {
            readonly = false;
        }
        return withCtx(pluginCtxBase({
            pluginId: cmd && cmd.pluginId,
            pluginName: cmd && cmd.pluginName,
            workspace,
            // 命令不归属任何 AI 会话：sessionId 恒空串，插件别拿它当「有没有打开文件」用
            sessionId: '',
            origin: PLUGIN_CTX_ORIGINS.command,
        }), {
            hasFile: !!file,
            formatId: file && file.format ? file.format.id : '',
            hasSelection,
            readonly,
            editorFocused,
        });
    };
}
