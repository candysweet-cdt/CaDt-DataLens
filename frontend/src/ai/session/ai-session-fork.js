// ai-session-fork.js：会话分叉的纯逻辑（支线对话与「从这里分支」共用一份）。
// 2026-11-15 抽出：两个入口原本各写一份深拷贝，且都漏掉 approvedPaths / readRoots——
// 分叉出来的会话第一次写文件要全部重新审批，母会话刚批过的路径不算数。
// 纯函数、无 DOM、无闭包状态，可直接单测；「能不能分叉」的运行时判定（正在流式 /
// 正在压缩 / index 必须落在 assistant 消息上）留在面板里。

// 纯 UI 注记：改动汇总卡只属于原会话的界面产物，分叉不带过去
const DROP_KINDS = new Set(['changes-summary']);

function cloneJson(value, fallback) {
    if (value == null) return fallback;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (e) {
        return fallback;
    }
}

// 取源会话的消息快照。index 为有效整数时取 [0..index]（「从这一轮分叉」），
// 否则取全部（从列表 / 头部创建支线时没有具体轮次）。返回深拷贝，改结果不影响源。
export function forkMessages(source, index) {
    const messages = Array.isArray(source && source.messages) ? source.messages : [];
    const atIndex = Number.isInteger(index) && index >= 0 && index < messages.length;
    const slice = atIndex ? messages.slice(0, index + 1) : messages;
    const copied = cloneJson(slice, null);
    if (!Array.isArray(copied)) return {ok: false, reason: 'clone_failed', messages: []};
    // 万一残留生成态也按已完成处理，否则新会话会一直显示流式中
    const out = copied
        .filter((item) => item && !DROP_KINDS.has(item.kind))
        .map((item) => (item.status === 'streaming' ? Object.assign({}, item, {status: 'done'}) : item));
    return {ok: true, reason: '', messages: out};
}

// 会话级设置的一次性快照。授权凭据（approvedPaths / readRoots）随快照继承，之后各自
// 演化、不联动——不继承的话用户刚在母会话批过的路径在支线里要全部重批一遍。
// workspace 保留原值（可能为空），由调用方按当前工作区兜底。
export function forkSettings(source) {
    const src = source || {};
    return {
        workspace: src.workspace || '',
        scope: src.scope || 'read',
        // 临时会话派生出来的会话仍是临时会话：语义（一次性、不绑工作区、不注入工作区知识）
        // 不能因为「分了个支 / 开了个支线」就漂移成重启后还留着的普通会话。
        // 调用方要在 assign 之后把它的 workspace 清空（见 ai-panel 的 branchSessionAt /
        // ai-sidechat 的 openSideChat）。
        temp: src.temp === true,
        profileId: src.profileId || '',
        modelId: src.modelId || '',
        // 本次会话上下文上限随 fork 继承（会话级模型设置的一部分，之后各自演化不联动）
        ctxLimit: Number(src.ctxLimit) || 0,
        systemPrompt: src.systemPrompt || '',
        promptTemplateId: src.promptTemplateId || '',
        summary: cloneJson(src.summary, null),
        approvedPaths: cloneJson(src.approvedPaths, []),
        readRoots: cloneJson(src.readRoots, []),
    };
}
