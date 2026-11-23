// ai-group-store.js：ai-groups 磁盘适配——Go 绑定薄封装 + JSONL 事件编解码/重放。
// 事件族沿用会话存储（header / msg / meta，§6.3）；共享日志只存对话（正文 + groupBlock
// + 对话元数据），思考/工具过程在 private/<agentId>.jsonl（§3.13）。
// 纯编解码 + 注入 backend 的适配器，不碰 DOM。

export const GROUP_LOG_SCHEMA = 2;

export function textOf(value) {
    return typeof value === 'string' ? value : (value == null ? '' : String(value));
}

// 群创建时的首行 header（之后所有成员请求都用它校验日志完整性）。
export function groupHeaderLine(meta) {
    return JSON.stringify({
        kind: 'header',
        v: GROUP_LOG_SCHEMA,
        id: meta.id,
        title: meta.title,
        createdAt: meta.createdAt,
        memberIds: meta.memberIds,
    });
}

// 群消息行（§6.3 字段）；落盘前补默认（gid/role/content/ts 必填）。
export function encodeGroupMessage(msg) {
    return JSON.stringify({
        kind: 'msg',
        gid: '',
        role: 'assistant',
        agentId: '',
        agentName: '',
        agentColor: '',
        model: '',
        content: '',
        ts: 0,
        turnId: '',
        round: 0,
        replyTo: '',
        addressedTo: [],
        stance: '',
        groupBlock: null,
        usage: null,
        hasPrivate: false,
        timing: null,
        timeout: false,
        status: 'done',
        ...msg,
    });
}

// 系统事件行（轮次开始/结束、主持人小结、到限提示；role:'system' 不进模型上下文）。
export function encodeGroupEvent(evt) {
    return JSON.stringify({kind: 'meta', ...evt});
}

function parseLine(line) {
    try {
        const value = JSON.parse(line);
        return value && typeof value === 'object' ? value : null;
    } catch (e) {
        return null;
    }
}

// 重放共享日志：header / messages / events；崩溃残行（Go 侧下次 append 才修复）丢弃；
// 崩溃时停在 streaming 的消息归一为 interrupted（与会话存储同语义）。
export function replayGroupLog(text) {
    const out = {header: null, messages: [], events: []};
    const lines = textOf(text).split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const evt = parseLine(trimmed);
        if (!evt) continue; // 残行 / 坏行丢弃，不抛错
        if (evt.kind === 'header' && !out.header) {
            out.header = evt;
            continue;
        }
        if (evt.kind === 'msg') {
            if (evt.status === 'streaming') evt.status = 'interrupted';
            out.messages.push(evt);
            continue;
        }
        out.events.push(evt);
    }
    return out;
}

// 私有日志 JSONL → 步骤记录数组（坏行跳过）：发言落盘时 runtime 与成员详情视图共用。
export function parsePrivateSteps(text) {
    const out = [];
    for (const line of textOf(text).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const item = JSON.parse(trimmed);
            if (item && item.gid) out.push(item);
        } catch (e) {
            continue; // 坏行跳过，不抛错
        }
    }
    return out;
}

// Go 绑定薄封装：绑定缺失时立即抛错（dev mock 未接时给出可读信息，而不是 undefined is not a function）。
export function createGroupStoreAdapter(backend) {
    const source = backend || {};
    const need = (name) => {
        if (typeof source[name] !== 'function') {
            throw new Error('群聊存储绑定不可用：' + name + '（后端缺 AIGroup* 方法）');
        }
        return (...args) => source[name](...args);
    };
    return {
        list: need('AIGroupList'),
        read: need('AIGroupRead'),
        append: need('AIGroupAppend'),
        rewrite: need('AIGroupRewrite'),
        writeMeta: need('AIGroupWriteMeta'),
        remove: need('AIGroupDelete'),
        removeAll: need('AIGroupDeleteAll'),
        privateRead: need('AIGroupPrivateRead'),
        privateAppend: need('AIGroupPrivateAppend'),
        privateRewrite: need('AIGroupPrivateRewrite'),
    };
}
