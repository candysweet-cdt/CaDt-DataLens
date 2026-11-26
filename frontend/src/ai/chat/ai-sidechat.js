// ai-sidechat.js：支线对话（用户向旁路会话）。
// 形态：普通持久化会话 + `sideOf` 元数据（指向母会话），列表里紧跟母会话并带「支线」徽标。
// 与「分支会话」（branchSessionAt）的区别：分支是在面板内换条路（切走当前会话）；支线是
// **能与主对话并排的旁路**——历史用同一套深拷贝快照（forkMessages），但落在内容区标签页，
// 面板继续显示主对话；结论靠「带回主对话」送回母会话的信箱（复用 ai-agent-notices 的注入通道）。
// `sideOf` 不嵌套（§4.9.3）：从支线再开支线时归到同一个母会话，永远只有一层。
import {aiTextOf} from '../core/ai-constants.js';
import {forkMessages, forkSettings} from '../session/ai-session-fork.js';
import {isUnboundSession} from '../session/ai-session-scope.js';

// 引用块：把源消息压成 markdown 引用。历史已经整段拷贝过来了，引用块只作为「从这句话
// 接着问」的定位锚点，所以仍做截断——不重复搬一遍长文。
export function sideChatQuote(title, text) {
    const body = String(text == null ? '' : text).trim();
    if (!body) return '';
    const all = body.split('\n');
    const lines = all.slice(0, 8).map((line) => '> ' + line.slice(0, 240));
    return '> 引用自「' + (String(title || '').trim() || '会话') + '」：\n' + lines.join('\n') +
        (all.length > 8 ? '\n> …' : '') + '\n\n';
}

export function isSideChat(session) {
    return !!(session && aiTextOf(session.sideOf).trim());
}

export function createAISidechat(ctx) {
    const getSessions = ctx.getSessions;
    const sessionById = ctx.sessionById;
    const currentSession = ctx.currentSession;
    const createSessionData = ctx.createSessionData;
    const persistSessions = ctx.persistSessions;
    const switchSession = ctx.switchSession;
    const renderSessionList = ctx.renderSessionList;
    const setDraft = ctx.setDraft;
    const deliverAgentNotice = ctx.deliverAgentNotice;
    const flash = ctx.flash;
    const logActivity = ctx.logActivity;

    // 支线归属的母会话（扁平到一层）：从支线再开支线时仍归到同一个母会话。
    function rootOf(session) {
        if (!session) return null;
        const sideOf = aiTextOf(session.sideOf).trim();
        if (!sideOf) return session;
        return sessionById(sideOf) || session;
    }

    // 新建支线并切过去。quote 非空时预填到新会话的输入草稿（切换后 loadComposerDraft 恢复）。
    function openSideChat(options) {
        const opts = options || {};
        const owner = rootOf(opts.session || currentSession());
        if (!owner) {
            flash('没有可挂靠的母会话', true);
            return null;
        }
        const child = createSessionData('支线 · ' + (owner.title || '新会话'));
        child.sideOf = owner.id;
        // 配置与授权凭据继承母会话（权限档 / 模型 / 人设 / 提示词模板 / 已批准路径）。
        // 以前强制 scope='read' 且不继承模型：支线等于换了个默认助手在问，母会话刚批过的
        // 路径还要重批一遍。快照之后各自演化，不联动。
        const inherited = forkSettings(owner);
        // createSessionData 已按当前工作区填好 workspace，源为空时不要覆盖成空串
        if (!inherited.workspace) delete inherited.workspace;
        Object.assign(child, inherited);
        // 临时 / 无工作区会话的支线同样是同类（forkSettings 已带 temp/noWorkspace）：清掉
        // createSessionData 按当前工作区兜底绑上的 workspace，否则「不绑工作区」语义在这里就断了。
        if (isUnboundSession(child)) child.workspace = '';
        // 历史快照：与「从这里分支」同一套深拷贝（opts.index 缺省 = 全量）。支线因此有
        // 完整上下文，不再是「只带一句引用」的弱化版——旧行为让支线与分支难以区分。
        const forked = forkMessages(owner, opts.index);
        if (!forked.ok) {
            flash('支线创建失败：历史快照无法深拷贝', true);
            return null;
        }
        child.messages = forked.messages;
        const quote = sideChatQuote(owner.title, opts.quote);
        if (quote) setDraft(child.id, quote);
        getSessions().push(child);
        persistSessions();
        logActivity('ai.session', child.id, {op: 'create', title: child.title, sideOf: owner.id}, {actor: 'user', source: 'user'});
        // 支线落在内容区的标签页，面板留在主对话——这是「支线不切走」的关键。
        // 没有内容区可用（悬浮窗）时退回旧行为：切到支线会话本身。
        const opened = typeof ctx.openSideChatTab === 'function'
            ? ctx.openSideChatTab({
                sessionId: child.id,
                title: child.title,
                ownerTitle: owner.title || '',
                snapAt: Date.now(),
            })
            : null;
        if (!opened) switchSession(child.id);
        renderSessionList();
        flash(opened
            ? '已新建支线对话：在内容区标签页打开，主对话仍在面板；结论可「带回主对话」'
            : '已新建支线对话（继承母会话权限档）：可用「带回主对话」把结论送回去');
        return child;
    }

    // 带回主对话：走会话信箱投递（母会话忙→下轮边界，闲→唤醒新轮，删除→兜底提示）。
    function bringBackToParent(session, textOverride) {
        const side = session || currentSession();
        if (!side) return {ok: false, reason: 'no_session'};
        const ownerId = aiTextOf(side.sideOf);
        if (!ownerId) {
            flash('当前不是支线对话，没有母会话可带回', true);
            return {ok: false, reason: 'not_side'};
        }
        const owner = sessionById(ownerId);
        if (!owner) {
            flash('母会话已删除，无法带回这个结论', true);
            return {ok: false, reason: 'gone'};
        }
        const content = String(textOverride == null ? '' : textOverride).trim();
        if (!content) {
            flash('没有可带回的内容', true);
            return {ok: false, reason: 'empty'};
        }
        const title = side.title || '支线';
        // 支线若动过文件，把改动文件清单一并带回：母会话的 changes 卡不收支线的改动
        // （两边都改文件会串味，方案 §6），只能靠这份摘要让它知道「支线改了什么」。
        // 同一路径聚合（relPath 合并 + / − 计），超过 12 个文件折叠为计数。
        const changes = Array.isArray(side.changes) ? side.changes : [];
        const merged = new Map();
        for (const change of changes) {
            const relPath = String((change && change.relPath) || (change && change.path) || '').trim();
            if (!relPath) continue;
            const prev = merged.get(relPath) || {relPath, added: 0, removed: 0};
            prev.added += Math.max(0, Math.round(Number(change && change.added) || 0));
            prev.removed += Math.max(0, Math.round(Number(change && change.removed) || 0));
            merged.set(relPath, prev);
        }
        const files = [...merged.values()];
        const digestLimit = 12;
        const changesNote = files.length
            ? '\n\n支线改动（' + files.length + ' 个文件）：' +
              files.slice(0, digestLimit).map((f) => f.relPath + '（+' + f.added + '/−' + f.removed + '）').join('、') +
              (files.length > digestLimit ? ' 等 ' + files.length + ' 个' : '')
            : '';
        const result = deliverAgentNotice(owner, {
            kind: 'sidechat',
            label: '支线结论 · ' + title,
            content: '［支线结论 · ' + title + '］来自支线对话「' + title + '」的结论：\n' + content + changesNote,
        });
        if (result && result.ok) {
            flash(result.woke
                ? '已带回主对话「' + (owner.title || '母会话') + '」，并为它起了一轮'
                : '已投递到主对话「' + (owner.title || '母会话') + '」的信箱（它当前忙碌，下轮可见）');
            return result;
        }
        flash('带回失败：' + ((result && result.reason) || '未知原因'), true);
        return result || {ok: false, reason: 'unknown'};
    }

    // 提升为独立会话：清掉 sideOf，列表里不再缩进/带徽标，母会话删除也不影响它。
    function promoteSideChat(session) {
        const side = session || currentSession();
        if (!isSideChat(side)) return false;
        side.sideOf = '';
        persistSessions();
        renderSessionList();
        flash('已提升为独立会话');
        return true;
    }

    return {rootOf, openSideChat, bringBackToParent, promoteSideChat, isSideChat};
}
