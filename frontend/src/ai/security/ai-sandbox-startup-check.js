// ai-sandbox-startup-check.js：启动后的异步沙箱残留自检。
//
// 2026-11-27 事故修复：workspace-write 的 Low 完整性标签若残留在真实工作区，
// 会让仓库内所有 exe（含 node_modules 构建工具）以 Low 启动，导致构建失败。
// 本模块在首屏完成后延迟执行只读 Scan；发现残留只提示，由用户确认后才 Revoke。
// 绝不参与启动 await 链，失败静默，不影响启动性能。
import {sandboxHasResidue, describeSandboxGrant} from './ai-sandbox-grant.js';

export function createSandboxStartupCheck(deps) {
    let checkedRoot = '';

    async function check() {
        const root = typeof deps.currentRoot === 'function' ? String(deps.currentRoot() || '').trim() : '';
        if (!root) return;
        // 同一窗口同一工作区只检查一次，避免重复提示。
        if (root === checkedRoot) return;
        checkedRoot = root;
        try {
            const state = await deps.backend.SandboxScan(root);
            if (!sandboxHasResidue(state)) return;
            const detail = describeSandboxGrant(state);
            deps.openConfirmDialog(
                detail + '。残留的 Low 完整性标签可能导致构建工具无法运行，是否现在清除？',
                async () => {
                    try {
                        const after = await deps.backend.SandboxRevoke(root);
                        deps.flash(sandboxHasResidue(after) ? '仍有残留，请在设置中检查' : '已清除工作区沙箱残留');
                    } catch (e) {
                        deps.flash('清除沙箱残留失败：' + ((e && e.message) || e), true);
                    }
                },
                '清除残留',
                '检测到沙箱残留',
                'warning'
            );
        } catch (e) {
            // 启动自检是尽力而为：失败只记诊断日志，不打断用户。
            if (typeof deps.logFrontend === 'function') {
                deps.logFrontend('warn', '启动沙箱残留检查失败：' + ((e && (e.stack || e.message)) || e));
            }
        }
    }

    return {check};
}
