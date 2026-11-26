// ai-changes-ui.js：变更记录 UI（按钮徽标 / 弹层 / 轮尾文件改动汇总卡 / 审阅虚拟 diff）。
// 从 ai-panel.js 拆出（docs/unfinished-plans/structure-cleanup.md 阶段 3），函数体逐字搬移。
// 依赖（opts 常量、const Map、面板函数）均引用稳定，经 ctx 注入。
import {aiFormatTime, aiTextOf} from '../core/ai-constants.js';
import {createFileIcon} from '../../core/fileicons.js';
import {iconSvg} from '../../core/icons.js';

// 审阅 diff 块归一：GitDiffFor 的输出**不能整串 trim**——git 的空上下文行是「单个空格」
// 的行，hunk 恰好以空上下文行结尾时（markdown 等文档极常见），整串 trim 会把它连同
// 换行整行吃掉，hunk 实际行数便与 @@ 头对不上（PatchParseText 报 PATCH_PARSE：
// 头部声明 -141,7 +141,7，实际数出 -6 +6）。只裁首尾的换行；空上下文行原样保留，
// 解析端对传输吃尾空格的空行已有兜底（patch_parse.go 的空行按上下文补计）。
export function normalizeGitDiffBlock(diff) {
    return String(diff == null ? '' : diff)
        .replace(/^(?:\r?\n)+/, '')
        .replace(/(?:\r?\n)+$/, '');
}

export function createAIChangesUI(ctx) {
    const changesSummaryFold = ctx.changesSummaryFold;
    const el = ctx.el;
    const panel = ctx.panel;
    const currentSession = ctx.currentSession;
    const openPath = ctx.openPath;
    const openVirtualDoc = ctx.openVirtualDoc;
    const getScopeRoot = ctx.getScopeRoot;
    // 会话根（批次 B，ai-panel 注入 sessionScopeRoot）：汇总卡列的是**这个会话**改过的文件，
    // 撤销/状态查询必须按会话根算——否则换标签后就回滚到别的仓库的同名路径上。
    const scopeRootOf = typeof ctx.scopeRootOf === 'function' ? ctx.scopeRootOf : null;
    const backend = ctx.backend;
    const flash = ctx.flash;
    const askConfirm = typeof ctx.askConfirm === 'function' ? ctx.askConfirm : null;
    // 回滚到 HEAD（bridge-ui 的 gitRollbackPaths：tracked→checkout，未跟踪→删文件）
    const rollbackGitPaths = typeof ctx.rollbackGitPaths === 'function' ? ctx.rollbackGitPaths : null;

    // 撤销本轮编辑的文件：未跟踪（AI 新建的）文件走删除，已跟踪的 checkout 回 HEAD。
    // root 无 Git / 状态查询失败时按「已跟踪」处理（回滚会报错并 flash，不静默）。
    async function rollbackChangeFiles(files) {
        if (!rollbackGitPaths) return;
        const root = (scopeRootOf ? scopeRootOf(currentSession()) : '') || getScopeRoot();
        let untrackedSet = null;
        try {
            const status = root && backend.GitStatusFor ? await backend.GitStatusFor(root) : null;
            if (status && status.available) {
                untrackedSet = new Set((status.entries || [])
                    .filter((entry) => entry.state === 'untracked')
                    .map((entry) => String(entry.path || '').replace(/\\/g, '/')));
            }
        } catch (e) {}
        const paths = files.map((file) => String(file.path || file.relPath || '').replace(/\\/g, '/'));
        const untracked = untrackedSet ? paths.filter((p) => untrackedSet.has(p)) : [];
        const tracked = paths.filter((p) => !untracked.includes(p));
        const deleted = untracked.filter((p) => untrackedSet && untrackedSet.has(p));
        const detail = [
            tracked.length ? '回滚 ' + tracked.length + ' 个已跟踪文件' : '',
            deleted.length ? '删除 ' + deleted.length + ' 个新建文件' : '',
        ].filter(Boolean).join('，');
        const target = files.length === 1 ? (files[0].relPath || files[0].path || '') : (files.length + ' 个文件');
        // 根作为可选第三参传下去（bridge-git 的 gitRollbackPaths(paths, untracked, root)）；
        // 旧包装箭头只声明两个形参时它被静默丢弃 → 回落旧行为，不会错位。
        const run = () => Promise.resolve(rollbackGitPaths(paths, untracked, root)).catch(() => {});
        if (askConfirm) {
            askConfirm((detail ? detail + '：' : '回滚 ') + target + '？', run);
        } else {
            run();
        }
    }

    function updateChangesUI() {
        if (!el.changesBtn) return;
        const session = currentSession();
        const count = session && Array.isArray(session.changes) ? session.changes.length : 0;
        if (el.changesCount) el.changesCount.textContent = String(count);
        el.changesBtn.classList.toggle('hidden', count === 0);
        if (!count) hideChangesPopover();
        else if (el.changesPop && !el.changesPop.classList.contains('hidden')) renderChangesPopover();
    }

    function renderChangesPopover() {
        if (!el.changesPop) return;
        const session = currentSession();
        el.changesPop.innerHTML = '';
        if (!session || !session.changes.length) {
            el.changesPop.classList.add('hidden');
            return;
        }
        const title = document.createElement('div');
        title.className = 'ai-pop-title';
        title.textContent = '变更记录（' + session.changes.length + '）';
        el.changesPop.appendChild(title);
        const list = document.createElement('div');
        list.className = 'ai-pop-list';
        for (const change of session.changes.slice().reverse()) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'ai-change-row';
            const path = document.createElement('span');
            path.className = 'ai-change-path';
            path.textContent = change.relPath || change.path;
            const stat = document.createElement('span');
            stat.className = 'ai-change-stat';
            const add = document.createElement('span');
            add.className = 'add';
            add.textContent = '+' + change.added;
            const del = document.createElement('span');
            del.className = 'del';
            del.textContent = '−' + change.removed;
            stat.append(add, del);
            const time = document.createElement('span');
            time.className = 'ai-change-time';
            time.textContent = aiFormatTime(change.time);
            row.append(createFileIcon(change.relPath || change.path, 'ai-tool-fileicon'), path, stat, time);
            row.addEventListener('click', () => {
                hideChangesPopover();
                try {
                    openPath(change.path);
                } catch (e) {}
            });
            list.appendChild(row);
        }
        el.changesPop.appendChild(list);
    }

    function showChangesPopover() {
        if (!el.changesPop || !el.changesBtn) return;
        renderChangesPopover();
        if (!currentSession() || !currentSession().changes.length) return;
        el.changesPop.classList.remove('hidden');
        const panelRect = panel.getBoundingClientRect();
        const btnRect = el.changesBtn.getBoundingClientRect();
        const width = 260;
        let left = btnRect.right - panelRect.left - width;
        left = Math.max(8, Math.min(left, panel.clientWidth - width - 8));
        el.changesPop.style.left = left + 'px';
        el.changesPop.style.top = (btnRect.bottom - panelRect.top + 6) + 'px';
    }

    function hideChangesPopover() {
        if (el.changesPop) el.changesPop.classList.add('hidden');
    }

    // ---------- 每轮文件改动汇总卡（Qoder 风格） ----------

    const AI_CHANGES_SUMMARY_VISIBLE = 3;

    // 轮次结束（finishStream）时聚合本轮新增的 recordChange 记录，追加汇总卡消息。
    // 用「轮开始时的 changes 快照」做切分，而不是比较时间戳：审批/写入耗时长、
    // 系统时钟回拨或跨轮复用时，时间窗会把本轮记录整段过滤掉，卡片就静默消失。
    function changesSnapshot(session) {
        const list = Array.isArray(session && session.changes) ? session.changes : [];
        const last = list.length ? list[list.length - 1] : null;
        return {index: list.length, time: Number(last && last.time) || 0};
    }

    function appendChangesSummary(session, mark) {
        if (!session) return;
        const list = Array.isArray(session.changes) ? session.changes : [];
        const index = Math.max(0, Math.round(Number(mark && mark.index) || 0));
        const since = Number(mark && mark.time) || 0;
        // 索引可用时按位置切分（最准）；记录被上限裁剪过时退回按时间切分。
        let start = 0;
        let useIndex = false;
        if (index > 0 && index <= list.length) {
            const boundary = list[index - 1];
            // 校验边界记录没被裁剪挪位：时间对得上才认索引。
            if (!since || (boundary && Number(boundary.time) === since)) {
                start = index;
                useIndex = true;
            }
        }
        const merged = new Map();
        for (let i = start; i < list.length; i++) {
            const change = list[i];
            if (!change) continue;
            if (!useIndex && since && Number(change.time) <= since) continue;
            const relPath = aiTextOf(change.relPath) || aiTextOf(change.path);
            if (!relPath) continue;
            const prev = merged.get(relPath) || {relPath, path: aiTextOf(change.path), added: 0, removed: 0};
            prev.added += Math.max(0, Math.round(Number(change.added) || 0));
            prev.removed += Math.max(0, Math.round(Number(change.removed) || 0));
            merged.set(relPath, prev);
        }
        const files = [...merged.values()];
        if (!files.length) return;
        session.messages.push({
            role: 'assistant',
            kind: 'changes-summary',
            content: '',
            status: 'done',
            ts: Date.now(),
            changes: {files},
        });
    }

    // 只返回卡片本身：外层 .ai-msg 壳由调用方提供（轮尾 / 消息渲染各一处），
    // 避免重放时套两层 .ai-msg 导致缩进与宽度和其它消息不一致。
    function renderChangesSummaryCard(message, session) {
        const changes = (message.changes && Array.isArray(message.changes.files)) ? message.changes.files : [];
        const card = document.createElement('div');
        card.className = 'ai-changes-card';
        const totalAdded = changes.reduce((sum, file) => sum + file.added, 0);
        const totalRemoved = changes.reduce((sum, file) => sum + file.removed, 0);
        const head = document.createElement('div');
        head.className = 'ai-changes-card-head';
        const icon = document.createElement('span');
        icon.className = 'ai-changes-card-icon';
        icon.innerHTML = iconSvg('doc');
        const title = document.createElement('span');
        title.className = 'ai-changes-card-title';
        title.textContent = '已编辑 ' + changes.length + ' 个文件';
        const stat = document.createElement('span');
        stat.className = 'ai-changes-card-stat';
        const add = document.createElement('span');
        add.className = 'add';
        add.textContent = '+' + totalAdded;
        const del = document.createElement('span');
        del.className = 'del';
        del.textContent = '−' + totalRemoved;
        stat.append(add, del);
        const reviewBtn = document.createElement('button');
        reviewBtn.type = 'button';
        reviewBtn.className = 'dlg-btn ai-changes-card-review';
        reviewBtn.textContent = '审阅';
        reviewBtn.addEventListener('click', () => reviewChangesSummary(changes));
        head.append(icon, title, stat, reviewBtn);
        // 全部撤销：整轮回滚到 HEAD（新建文件删除；已跟踪 checkout）
        if (rollbackGitPaths) {
            const rollbackAllBtn = document.createElement('button');
            rollbackAllBtn.type = 'button';
            rollbackAllBtn.className = 'dlg-btn ai-changes-card-review';
            rollbackAllBtn.textContent = '全部撤销';
            rollbackAllBtn.addEventListener('click', () => rollbackChangeFiles(changes));
            head.appendChild(rollbackAllBtn);
        }
        card.appendChild(head);
        // 超过 3 个文件默认折叠，靠「再显示 N 个文件」展开
        // 折叠状态按会话隔离：不同会话的汇总卡可能共用同一个消息序号
        const foldKey = 'changes:' + ((session && session.id) || '') + ':' + (message._mid || message.ts || changes.length);
        const expanded = changesSummaryFold.has(foldKey) ? changesSummaryFold.get(foldKey) : false;
        const list = document.createElement('div');
        list.className = 'ai-changes-card-list';
        const visible = expanded ? changes.length : Math.min(AI_CHANGES_SUMMARY_VISIBLE, changes.length);
        for (const file of changes.slice(0, visible)) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'ai-changes-card-row';
            const name = document.createElement('span');
            name.className = 'ai-changes-card-path';
            name.textContent = file.relPath;
            name.dataset.tip = file.relPath;
            const nums = document.createElement('span');
            nums.className = 'ai-changes-card-nums';
            const fAdd = document.createElement('span');
            fAdd.className = 'add';
            fAdd.textContent = '+' + file.added;
            const fDel = document.createElement('span');
            fDel.className = 'del';
            fDel.textContent = '−' + file.removed;
            nums.append(fAdd, fDel);
            row.append(createFileIcon(file.relPath, 'ai-tool-fileicon'), name, nums);
            if (rollbackGitPaths) {
                // 行尾「撤销」：回滚该文件到 HEAD（AI 新建文件则删除）。span 承载避免按钮嵌套
                const undo = document.createElement('span');
                undo.className = 'ai-changes-card-undo';
                undo.setAttribute('role', 'button');
                undo.setAttribute('aria-label', '撤销对 ' + file.relPath + ' 的修改');
                undo.textContent = '撤销';
                undo.dataset.tip = '回滚该文件到 HEAD（AI 新建的文件将被删除）';
                undo.addEventListener('click', (e) => {
                    e.stopPropagation();
                    rollbackChangeFiles([file]);
                });
                row.appendChild(undo);
            }
            row.addEventListener('click', () => openPath(file.path || file.relPath));
            list.appendChild(row);
        }
        card.appendChild(list);
        if (changes.length > AI_CHANGES_SUMMARY_VISIBLE) {
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'ai-changes-card-more';
            more.textContent = expanded ? '收起' : '查看全部';
            more.addEventListener('click', () => {
                const next = !expanded;
                changesSummaryFold.set(foldKey, next);
                const cardHost = card.parentNode;
                const fresh = renderChangesSummaryCard(message, session);
                if (cardHost) cardHost.replaceChild(fresh, card);
            });
            card.appendChild(more);
        }
        return card;
    }

    // 轮尾/重放共用的外壳：保证两种渲染路径的层叠与缩进完全一致。
    function changesSummaryBlock(message, session) {
        const wrap = document.createElement('div');
        wrap.className = 'ai-msg assistant';
        if (session) wrap.dataset.session = session.id;
        wrap.appendChild(renderChangesSummaryCard(message, session));
        return wrap;
    }

    // 「审阅」：逐文件取 Git 差异拼成一份**只读的 .diff 虚拟文档**，复用 patch 视图的
    // 文件卡 / hunk 高亮。走 PatchParseText 纯解析：不预检、不生成计划、没有应用 / 撤销入口；
    // 撤销仍走汇总卡文件行的「撤销」按钮（gitRollbackPaths）。
    // 没有 Git 差异的文件（未跟踪 / 与 HEAD 一致）单独列在视图顶部的说明里。
    async function reviewChangesSummary(changes) {
        if (!openVirtualDoc) {
            for (const file of changes) openPath(file.path || file.relPath);
            return;
        }
        // 审阅的 diff 基准必须与回滚同源（会话根）：harness 下窗口根与会话根不同时，
        // 用窗口根取 diff 会拿不到本会话改动的文件，审阅视图变空白。
        const root = (scopeRootOf ? scopeRootOf(currentSession()) : '') || getScopeRoot();
        const limited = changes.slice(0, 20);
        const blocks = [];
        const notes = [];
        for (const file of limited) {
            const label = file.relPath + '  （+' + file.added + ' −' + file.removed + '）';
            let body = '';
            try {
                const result = root && backend.GitDiffFor
                    ? await backend.GitDiffFor(root, file.relPath)
                    : null;
                if (result && result.diff && String(result.diff).trim()) body = normalizeGitDiffBlock(result.diff);
            } catch (e) {
                notes.push(label + '：获取 Git 差异失败（' + ((e && e.message) || e) + '）');
                continue;
            }
            if (!body) {
                notes.push(label + '：未被 Git 跟踪或内容与 HEAD 一致，没有可展示的差异');
                continue;
            }
            blocks.push(body);
        }
        if (changes.length > limited.length) {
            notes.push('文件较多，只展示前 ' + limited.length + ' 个（共 ' + changes.length + ' 个）');
        }
        openVirtualDoc('本轮改动审阅 — ' + changes.length + ' 个文件.diff', blocks.join('\n'), {
            patchReview: true,
            // 审阅是已发生改动的只读快照：固定只读，连解锁入口都不给
            readOnly: true,
            readOnlyFixed: true,
            reviewNotes: notes,
        });
    }

    return {
        updateChangesUI,
        renderChangesPopover,
        showChangesPopover,
        hideChangesPopover,
        changesSnapshot,
        appendChangesSummary,
        renderChangesSummaryCard,
        changesSummaryBlock,
        reviewChangesSummary,
    };
}
