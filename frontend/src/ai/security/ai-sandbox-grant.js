// ai-sandbox-grant.js：子代理沙箱授权残留的可读描述（纯函数）。
//
// 为什么单独一个文件：`ai-permission-settings.js` 在模块顶层挂了 window 事件监听，
// Node 测试里 import 会直接炸；这段文案是设置页与单测共用的唯一来源，放这里最干净。
//
// state 是后端 `sandbox.GrantState`：三样痕迹（写权 ACE / ambient-delete deny /
// Low 完整性标签）各自独立，任一存在都算「有残留」。

export function sandboxHasResidue(state) {
    return !!(state && (state.granted || state.denyPresent || state.labeled));
}

// 沙箱档位的中文短标签（HUD 副标题一行里放得下）。未知值原样回显，不猜。
export function sandboxModeLabel(mode) {
    const table = {'read-only': '只读', 'workspace-write': '可写', 'danger-full-access': '完全'};
    const key = String(mode || '').trim();
    return table[key] || key;
}

export function describeSandboxGrant(state) {
    if (!state || !state.root) return '（未打开工作区）';
    if (!sandboxHasResidue(state)) return '本工作区没有沙箱痕迹（未授权，或已清除）';
    const parts = [];
    if (state.granted) parts.push('写权授权');
    if (state.denyPresent) parts.push('删除子项 deny');
    if (state.labeled) parts.push('Low 完整性标签');
    return '本工作区留有沙箱痕迹：' + parts.join('、') + '（' + (state.workspaceSid || '未知 SID') + '）';
}
