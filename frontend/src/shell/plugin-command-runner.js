// plugin-command-runner.js：插件命令统一执行器（写回契约）。
// 从 main.js 拆出（组合根「只减不增」）：run(env) 返回写回意图时，经宿主注入的 editor 能力
// 走编辑器既有通道替换——脏标记 / undo / 只读判定都在宿主手里，插件碰不到 doc 本体。
import {parseCommandWriteback, writebackNeedsEditor} from './plugin-command-writeback.js';

/**
 * deps 全部传函数/值：buildEnv(cmd)（构造命令 ctx）/ flash / openVirtualDoc / editor() /
 * mode() / file() / settings() / isDocReadOnly / markDocDirty / updateStatus。
 * @param {any} deps
 * @returns {(cmd: any) => Promise<void>}
 */
export function createPluginCommandRunner(deps) {
    return async function runPluginCommand(cmd) {
        let result;
        try {
            result = await cmd.run(deps.buildEnv(cmd));
        } catch (e) {
            deps.flash('插件命令执行失败：' + ((e && e.message) || e), true);
            return;
        }
        const intent = parseCommandWriteback(result);
        if (intent.kind === 'none') return;
        if (intent.kind === 'openVirtualDoc') {
            if (typeof deps.openVirtualDoc === 'function') deps.openVirtualDoc(intent.name, intent.text);
            return;
        }
        if (!writebackNeedsEditor(intent)) return;
        const editor = deps.editor && deps.editor();
        const ace = editor && editor.aceEditor;
        const mode = deps.mode && deps.mode();
        if (!ace || (mode !== 'code' && mode !== 'split')) {
            deps.flash('插件命令的写回需要代码编辑器焦点', true);
            return;
        }
        const file = deps.file && deps.file();
        if (deps.isDocReadOnly && deps.isDocReadOnly(file, deps.settings && deps.settings())) {
            deps.flash('只读模式下插件命令不能写回内容', true);
            return;
        }
        try {
            if (intent.kind === 'replaceSelection') {
                ace.session.replace(ace.getSelectionRange(), intent.text);
            } else {
                ace.insert(intent.text);
            }
            if (file && deps.markDocDirty) deps.markDocDirty(file);
            if (deps.updateStatus) deps.updateStatus();
        } catch (e) {
            deps.flash('插件命令写回失败：' + ((e && e.message) || e), true);
        }
    };
}
