// ai-worktree.js：AI 隔离工作区（git worktree）域模块——worktree_manage 工具执行、
// 会话态（session.worktree）、<worktree> 注入块文本、头部状态胶囊。
// 设计见 docs/finished-plans/git-worktree.md：worktree 固定建在 <主根>/.cadt/worktree/<slug>，
// 一会话一个（独占）；回灌 = Go 导出 diff → PatchSave(主根) → patch 审批卡（全档必弹）→ 应用；
// 丢弃 = worktree remove --force + 删隔离分支。路径一律显式长路径，不做前缀注入。
import {aiTextOf} from '../core/ai-constants.js';
import {iconSvg} from '../../core/icons.js';
import {legacyPathKey} from '../../core/path-key.js';

export const WORKTREE_REL_DIR = '.cadt/worktree';
// 补丁超过此长度拒绝导出（与 propose_patch 的传输上限一致，防一次导出撑爆上下文）
export const WORKTREE_PATCH_LIMIT = 256 * 1024;
// create / discard 的必填原因：会原样显示在审批卡上给用户看，太长反而没人读
export const WORKTREE_REASON_MAX = 200;

// 会话态归一（单一来源；ai-session-store 的 meta 序列化与 ai-panel 的 normalizeSession 共用）
export function normalizeWorktreeState(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = aiTextOf(raw.name).trim();
    if (!name) return null;
    return {
        name,
        branch: aiTextOf(raw.branch),
        path: aiTextOf(raw.path),
        baseSha: aiTextOf(raw.baseSha),
        createdAt: Number(raw.createdAt) || 0,
        // export 状态标记（L3）：最近一次预检报告路径——与 lastExportPatch 并列，让
        // 「已导出 / 有未导出改动」可从状态区分。多次 export 各一份报告不覆盖。
        lastExportReport: aiTextOf(raw.lastExportReport),
        lastExportPreviewAt: Number(raw.lastExportPreviewAt) || 0,
    };
}

// 隔离区相对路径前缀（AI 文案与提示词块用）
export function worktreeRelPath(name) {
    return WORKTREE_REL_DIR + '/' + name;
}

// 路径是否落在某个根之下（归一化反斜杠、去尾斜杠、忽略大小写）。用于 worktree 删除前的
// 归属断言：git worktree remove 不可逆，根与会话不同源时可能删掉别的仓库登记的隔离区。
export function pathInsideWorkspace(root, path) {
    const norm = (value) => legacyPathKey(value == null ? '' : value)
    const base = norm(root);
    const full = norm(path);
    if (!base || !full) return false;
    return full === base || full.startsWith(base + '/');
}

// 旧「子代理隔离写闸」已随能力快照重构删除（2026-11-28）：worktree 现在是 writableRoots
// 的一种来源——子代理派单时快照注入前缀（composeAgentCapabilities），写判定统一走
// ai-panel 的 subWriteVerdict（快筛）+ Go 侧 WriteBoundaryCheck（权威，§5.5）。

// 预测 slug（纯函数，复刻 Go deriveSlug / alnumTail）：label 小写、[^a-z0-9] 折成 -、
// 截 32、去首尾 -，空则 wt；拼会话 id 末 8 位字母数字。创建审批卡用它显示真实路径——
// 仅当同名冲突时 Go 会顺延 -2/-3（以工具结果里的实际名为准）。
export function predictWorktreeSlug(label, sessionKey) {
    let base = '';
    let lastDash = false;
    for (const ch of String(label == null ? '' : label).trim().toLowerCase()) {
        if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
            base += ch;
            lastDash = false;
        } else if (base.length > 0 && !lastDash) {
            base += '-';
            lastDash = true;
        }
        if (base.length >= 32) break;
    }
    base = base.replace(/^-+|-+$/g, '');
    if (!base) base = 'wt';
    let id = '';
    for (const ch of String(sessionKey || '').toLowerCase()) {
        if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) id += ch;
    }
    if (id.length > 8) id = id.slice(-8);
    return id ? base + '-' + id : base;
}

// 主会话隔离写闸（纯函数）：隔离区开启期间主根只读——只允许写自己的隔离前缀与 .cadt/tmp
// 临时区；其余主根路径确定性拒绝（全档生效，含完全权限）。回灌必须走 worktree_manage(export)
// 的补丁审批卡，否则模型会在导出预检冲突时「直接改主根对齐」，绕过人工审阅（2026-11-17 真机）。
// 范围外的绝对路径（full 档）不在主根，不属于隔离边界，放行。
export function mainRootWriteVerdict(wt, relPath) {
    if (!wt || !wt.name) return {verdict: 'allow'};
    const prefix = (WORKTREE_REL_DIR + '/' + wt.name).toLowerCase();
    const rel = String(relPath == null ? '' : relPath);
    const lower = rel.toLowerCase();
    if (lower === prefix || lower.startsWith(prefix + '/')) return {verdict: 'allow'};
    // .cadt/tmp 是约定的临时产物区（<worktree> 块让模型把日志/中间产物写这里）
    if (lower === '.cadt/tmp' || lower.startsWith('.cadt/tmp/')) return {verdict: 'allow'};
    // 范围外盘符绝对路径（full 档）：落在主根内的已被 aiRelPath 转成相对路径，这里只剩真正
    // 的范围外路径，放行（如 C:/Users/.../Temp）。
    if (/^[a-zA-Z]:[\\/]/.test(rel)) return {verdict: 'allow'};
    // 单斜杠/反斜杠开头一律拒绝（根相对、UNC、\\?\ 扩展前缀）：aiNormalizePath 会把
    // \\server\share 与 \\?\D:\... 折成 /server/share、/?/D:/...（单斜杠），Win32 又把它
    // 解析到「当前盘根」——若工作区恰在该盘，即可命中主根。解析口径不可靠，隔离期间不开后门。
    if (rel.startsWith('/') || rel.startsWith('\\')) {
        return {
            verdict: 'deny',
            message: '【worktree:error】WORKTREE_MAIN_READONLY：隔离期间不接受根相对 / UNC / 扩展长度路径（' + rel
                + '）。请用相对范围根的路径写到 ' + worktreeRelPath(wt.name) + '/…；临时产物写主根 .cadt/tmp/'
                + '（范围外临时目录请用带盘符的绝对路径，如 C:/Users/.../Temp）。',
        };
    }
    return {
        verdict: 'deny',
        message: '【worktree:error】WORKTREE_MAIN_READONLY：本会话开启隔离工作区（' + worktreeRelPath(wt.name)
            + '），隔离期间主根只读——回灌必须经补丁审批卡，不能直接改主根文件。请把改动写到 '
            + worktreeRelPath(wt.name) + '/' + rel + '；导出预检冲突时在隔离区里修正后重新 '
            + 'worktree_manage(action=export)。要放弃隔离直接改主根，先由用户丢弃隔离区。',
    };
}

// worktree_manage by-name 目标解析（纯函数）：own 为会话自己的隔离区登记，subWorktrees
// 为本会话派生子代理的隔离区登记。缺省（不带 name）= 自己的；带 name 只认本会话拥有的；
// 其余（其他会话的隔离区）返回 null——归属外不可触碰。
export function resolveWorktreeTarget(own, subWorktrees, requestedName) {
    const ownNorm = normalizeWorktreeState(own);
    const wanted = String(requestedName || '').trim().toLowerCase();
    if (!wanted) return ownNorm ? {wt: ownNorm, own: true} : null;
    if (ownNorm && String(ownNorm.name).toLowerCase() === wanted) return {wt: ownNorm, own: true};
    const hit = (subWorktrees || []).find((w) => w && String(w.name).toLowerCase() === wanted && w.baseSha);
    if (hit) return {wt: {name: hit.name, baseSha: hit.baseSha}, own: false};
    return null;
}

// export 预检回执（纯函数，可单测）：merge-tree 三方合并分类 → 有界三栏文本。
// 体量护栏（方案「报告体量护栏」）：回执只给索引不给全文——冲突/可应用清单各 20 行封顶、
// 已应用 10 行，超出折叠为计数；全量报告在 mp.reportPath（主根 .cadt/export-reports/，
// 每次 export 独立一份），AI 要细节按需读文件，冲突文件内容永不进上下文。
// mp 为 Go GitWorktreeMergePreviewResult（json 小驼峰）：{supported, clean, applicable,
// alreadyApplied, conflicted:[{path, reasons}], reportPath}。
const PREVIEW_CAP_CONFLICT = 20;
const PREVIEW_CAP_APPLICABLE = 20;
const PREVIEW_CAP_ALREADY = 10;

export function worktreeExportPreviewText(wt, mp) {
    const name = wt && wt.name ? wt.name : '?';
    const conflicted = (mp && mp.conflicted) || [];
    const applicable = (mp && mp.applicable) || [];
    const already = (mp && mp.alreadyApplied) || [];
    const total = conflicted.length + applicable.length + already.length;
    const section = (title, items, cap, render) => {
        if (!items.length) return [title + ' 0 个：'];
        // 折叠计数并入标题行（体量护栏：大冲突场景回执仍有界）
        const lines = [title + ' ' + items.length + ' 个' + (items.length > cap ? '（列前 ' + cap
            + '，另有 ' + (items.length - cap) + ' 个见报告文件）' : '') + '：'];
        for (const item of items.slice(0, cap)) lines.push('  ' + render(item));
        return lines;
    };
    const lines = ['隔离区 ' + worktreeRelPath(name) + ' 回灌预检（merge-tree 三方合并，未写入主根）：改动共 ' + total + ' 个文件。'];
    if (total && !conflicted.length && !applicable.length) {
        // 全集都已应用：明确「无需重做」，不落盘补丁——消除复盘问题 2 的「已应用误报冲突」
        lines.push('');
        lines.push(...section('已在主根（无需重做）', already, PREVIEW_CAP_ALREADY, (p) => '· ' + p));
    } else {
        lines.push('');
        lines.push(...section('真冲突（需在隔离区重做后重新 export）', conflicted, PREVIEW_CAP_CONFLICT,
            (f) => '· ' + f.path + ((f.reasons && f.reasons.length) ? '（' + f.reasons[0] + '）' : '')));
        lines.push(...section('本次可应用', applicable, PREVIEW_CAP_APPLICABLE, (p) => '· ' + p));
        lines.push(...section('已在主根（无需重做）', already, PREVIEW_CAP_ALREADY, (p) => '· ' + p));
    }
    lines.push('');
    if (mp && mp.reportPath) {
        lines.push('全量报告（主根侧，可用 read_file 查看）：' + mp.reportPath);
    } else {
        lines.push('全量报告落盘失败' + ((mp && mp.reportErr) ? '：' + mp.reportErr : ''));
    }
    lines.push('冲突处理：在 ' + worktreeRelPath(name) + '/ 里按主根当前内容重做对应文件后重新 export；'
        + '主根隔离期只读，绝不要直接改主根文件绕过审阅。');
    return lines.join('\n');
}

// create / discard 的必填原因校验（纯函数）：原因原样进审批卡，让用户看到 AI 的意图
// 而不只是动作。返回 {reason} 或 {error}——error 串会作为工具结果回给模型，指导它补参数。
export function worktreeReasonCheck(rawReason) {
    const reason = aiTextOf(rawReason).trim();
    if (!reason) {
        return {error: '缺少 reason：create / discard 必须用一句话说明原因（会显示在审批卡上给用户看）'};
    }
    if (reason.length > WORKTREE_REASON_MAX) {
        return {error: 'reason 过长（' + reason.length + ' 字，上限 ' + WORKTREE_REASON_MAX + ' 字）：请压成一句话'};
    }
    return {reason};
}

// <worktree> 注入块（给模型看的稳定区提示词；仅 session.worktree 存在时注入）
export function worktreeBlockText(wt) {
    if (!wt || !wt.name) return '';
    return [
        '<worktree>',
        '本会话正在隔离工作区中改代码：所有文件改动写到 ' + worktreeRelPath(wt.name) + '/…（相对范围根=主根），不要改主根同名文件。隔离期间主根只读——write_file / edit_file 写主根其他路径会被拒绝（.cadt/tmp/ 临时产物除外），回灌只能经补丁审批卡。',
        '- run_command / background_command 未显式传 cwd 时默认在 ' + worktreeRelPath(wt.name) + ' 里执行；git 命令会自动作用于该 worktree 的分支 ' + (wt.branch || '隔离分支') + '。要在主根执行只读命令请显式传 cwd=.。',
        '- 依赖共享只覆盖主根顶层的 node_modules / .venv / venv（junction，写入即主根目录）；子目录依赖（如 frontend/node_modules）不会共享——缺依赖时在隔离区里装（npm install），绝不要手动 mklink 借主根目录（删除隔离区时 git 会跟进 junction 把主根依赖删空）。Go 无需共享（模块与构建缓存在用户级）。',
        '- 隔离区里没有主根的 .cadt/，工具的路径一律相对范围根（主根），与命令 cwd 无关：临时日志/中间产物用 write_file 写到主根 .cadt/tmp/（auto 档免审批）；不要在命令里用 ../ 猜路径，也不要用 / 开头或 UNC 路径（隔离期间会被拒绝，Win32 会把它解析到当前盘根）。',
        '- 跑测试直接用 run_command，输出会自动返回；不要用输出重定向把日志写文件再 sed 读（会变成无法静态分析的复合命令而转人工审批）。长日志用 background_command + check_command。',
        '- 完成后调 worktree_manage(action=export) 生成补丁交用户审阅回灌主根；应用成功后建议 discard 收尾。不要 commit 到隔离分支：worktree 是草稿区，分支不保留。',
        '- 导出预检有冲突时：export 会先用 merge-tree 三方合并做零副作用预检并给出三栏报告（可应用 / 真冲突 / 已应用）。真冲突文件在隔离区里按主根当前内容修正该文件后重新 export（全量报告文件可 read_file 按需查看）；绝不要直接编辑主根绕过审阅（写工具会拒绝，这不是权限档能放行的）。',
        '</worktree>',
    ].join('\n');
}

// worktree 列表格式化（list 工具的输出；orphan 由前端算——登记之外的 .cadt/worktree 条目）。
// sessions 为全量会话列表（含 _stub 占位：meta 里有 worktree 字段即可参与判定）。
// stats 为 relPath → git diff --stat 尾行（未提交改动量；对比多个隔离区用），缺失项不打统计。
// 解析 git diff --stat 尾行汇总（「N files changed, X insertions(+), Y deletions(-)」），
// 给丢弃卡/信息卡出「+45 −39 · 3 文件」的紧凑汇总。无改动 / 解析失败 → label 空串。
export function worktreeStatTotals(statText) {
    const lines = String(statText || '').split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const m = lines[i].match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
        if (m) {
            const files = Number(m[1]) || 0;
            const added = Number(m[2]) || 0;
            const removed = Number(m[3]) || 0;
            return {files, added, removed, label: '+' + added + ' −' + removed + ' · ' + files + ' 文件'};
        }
    }
    return {files: 0, added: 0, removed: 0, label: ''};
}

// 把紧凑汇总 label（+45 −39 · 3 文件）渲染成带 +/- 颜色的节点（接管卡与弹窗共用）；
// 不是汇总形状（如「无改动」）原样返回文本。
export function worktreeStatNode(label) {
    const wrap = document.createElement('span');
    const text = String(label || '');
    const m = text.match(/^\+(\d+) −(\d+) · (\d+) 文件$/);
    if (!m) {
        wrap.textContent = text;
        return wrap;
    }
    const add = document.createElement('span');
    add.className = 'ai-worktree-stat-add';
    add.textContent = '+' + m[1];
    const del = document.createElement('span');
    del.className = 'ai-worktree-stat-del';
    del.textContent = '−' + m[2];
    const files = document.createElement('span');
    files.className = 'ai-worktree-stat-files';
    files.textContent = ' · ' + m[3] + ' 文件';
    wrap.append(add, del, files);
    return wrap;
}

export function formatWorktreeList(result, sessions, stats) {
    if (!result || !result.available) {
        return '【worktree】git 不可用或不在仓库内：' + ((result && result.reason) || '未知原因');
    }
    const registered = new Set();
    for (const session of sessions || []) {
        const wt = session && session.worktree;
        if (wt && wt.path) registered.add(String(wt.path).toLowerCase());
    }
    const lines = ['【worktree】仓库现有 worktree ' + ((result.items || []).length) + ' 个：'];
    for (const item of result.items || []) {
        const tags = [];
        if (item.underCadt) tags.push('隔离区');
        if (item.underCadt && item.path && !registered.has(String(item.path).toLowerCase())) tags.push('孤儿（无会话登记，可 discard 或手动删）');
        const stat = item.underCadt && stats && stats[item.relPath];
        lines.push('- ' + (item.relPath || item.path) + (item.branch ? '（分支 ' + item.branch + '）' : '（detached/bare）')
            + (tags.length ? ' [' + tags.join('，') + ']' : '')
            + (stat ? '\n    改动：' + stat : ''));
    }
    lines.push('说明：AI 隔离区固定在 ' + WORKTREE_REL_DIR + '/<slug>，分支前缀 cadt/wt/；改动统计对比的是各 worktree 自己的 HEAD（未提交量）；孤儿 worktree 一期不自动清理。');
    return lines.join('\n');
}

export function createAIWorktree(deps) {
    const backend = deps.backend;
    // 根的语义已改为**会话根**（ai-panel 注入 sessionScopeRoot）：可选 session 参数，
    // 缺省取面板当前会话。工具路径一律显式传 ctx.session，后台会话才不会串到用户正看的会话上。
    const getScopeRoot = (session) => deps.getScopeRoot(session);
    const currentSession = () => deps.currentSession();
    const currentScopeOf = deps.currentScopeOf;
    const persistSessions = () => deps.persistSessions();
    const flash = deps.flash || (() => {});
    const requestPatchApproval = (...args) => deps.requestPatchApproval(...args);
    // AI 主动 create / discard 的审批卡（接管 composer；用户手点的开关仍走居中确认弹窗）
    const requestWorktreeApproval = (...args) => deps.requestWorktreeApproval(...args);
    const patchResultText = (...args) => deps.patchResultText(...args);
    const recordChange = (...args) => deps.recordChange(...args);
    const notifyFileChanged = (...args) => deps.notifyFileChanged(...args);
    const refreshToolWrap = (...args) => deps.refreshToolWrap(...args);
    const toolHalted = (...args) => deps.toolHalted(...args);
    const logPermission = (...args) => deps.logPermission(...args);
    const getSessions = () => deps.getSessions();
    // 本会话派生的子代理隔离区 [{name, baseSha}]：export/discard by name 的归属判定
    const getSubWorktrees = (...args) => deps.getSubWorktrees ? deps.getSubWorktrees(...args) : [];
    const joinPath = (...args) => deps.joinPath(...args);
    const openDialog = deps.openDialog;
    const closeDialog = deps.closeDialog;
    const dialogNode = deps.dialogNode;
    const dialogButton = deps.dialogButton;
    const chip = deps.chip || null;
    // 输入区常驻开关（对齐 ZCode 的 worktree 勾选）：勾上=本会话用隔离区，取消=确认丢弃
    const toggle = deps.toggle || null;
    const isRunning = (...args) => deps.isRunning ? deps.isRunning(...args) : false;
    // 用户手点的创建/丢弃合成 worktree_manage 消息对写进会话历史（AI 路径天然有工具卡）
    const recordToolEvent = (...args) => deps.recordToolEvent ? deps.recordToolEvent(...args) : undefined;
    // 同一会话的隔离区增删互斥：审批等待期间用户可能从 /worktree 或权限菜单再建一个，
    // 两次 GitWorktreeAdd 都成功 → 后者覆盖登记、前者成孤儿；双击/并发删除同理。
    const worktreeBusy = new Set();

    // 审批裁定后失败/取消的落定：只改 approval.state 不够——工具卡与状态文字会继续按
    // approved 显示「已创建/已丢弃」，与错误正文矛盾（2026-11-17 复查）。
    function settleWorktreeApproval(session, toolMessage, state, message) {
        const approval = toolMessage && toolMessage.approval;
        if (!approval) return;
        approval.state = state;
        if (message) approval.error = message;
        try {
            if (deps.persistApprovalMutation) deps.persistApprovalMutation(session, toolMessage);
            else persistSessions();
        } catch (e) {}
        refreshToolWrap(session, toolMessage);
    }

    // export 预检标记（导出状态标记）：把最近一次预检报告路径写回会话登记（lastExportReport）。
    // resolveTarget 返回的 wt 是归一化副本，直接改它不会持久化——own 写 session.worktree 活
    // 对象，子代理写 getSubWorktrees 命中项；尽力而为，失败不影响 export 本身。
    function markExportReport(session, target, wt, mp) {
        const path = mp && mp.reportPath ? String(mp.reportPath) : '';
        if (!path) return;
        try {
            const wanted = String(wt.name).toLowerCase();
            if (target && target.own && session && session.worktree
                && String(session.worktree.name || '').toLowerCase() === wanted) {
                session.worktree.lastExportReport = path;
                session.worktree.lastExportPreviewAt = Date.now();
                persistSessions();
                return;
            }
            if (target && !target.own) {
                const sub = (getSubWorktrees(session ? session.id : '') || [])
                    .find((w) => w && String(w.name || '').toLowerCase() === wanted);
                if (sub) {
                    sub.lastExportReport = path;
                    sub.lastExportPreviewAt = Date.now();
                    persistSessions();
                }
            }
        } catch (e) {}
    }

    // discard 保底快照（L3）：丢弃前把隔离区相对基准的未导出改动全量落盘 .cadt/patches/。
    // 必须绕开 PatchSave——它对「没有任何文件可应用」会删补丁文件，保底存档绝不能被删。
    // 返回补丁路径；无改动或绑定缺失返回 ''；失败返回 null（调用方继续丢弃但在回执里提示）。
    async function snapshotWorktreePatch(root, wt) {
        if (typeof backend.GitWorktreeSnapshotPatch !== 'function') return '';
        try {
            return await backend.GitWorktreeSnapshotPatch(root, wt.name, wt.baseSha || 'HEAD');
        } catch (e) {
            const msg = String((e && e.message) || e);
            if (msg.includes('没有改动')) return '';
            return null;
        }
    }

    // ---------- 确认弹窗（Promise 化；Esc / 关闭 / 取消都按放弃处理） ----------
    // message 可传字符串或 Promise<string>（如信息卡先取改动统计再渲染文案）。
    // 按钮回调必须先 closeDialog 再落定（仓库惯例，见 ai-reminders / ai-schedule）：漏掉这步
    // 会出现「动作已执行但弹层不消失、再点按钮被 settled 守卫吞掉」的假死（2026-11-17 实测）。
    function confirmDialog({title, message, messagePromise, cancelLabel, confirmLabel, danger}) {
        return new Promise((resolve) => {
            let settled = false;
            const done = (value) => {
                if (settled) return;
                settled = true;
                if (observer) observer.disconnect();
                try { if (typeof closeDialog === 'function') closeDialog(); } catch (e) {}
                resolve(value);
            };
            // 居中弹窗可能被 Esc / 右上角 × 关闭（ai-panel 直接加 hidden）：监听后按放弃收敛
            let observer = null;
            if (deps.dialogEl) {
                observer = new MutationObserver(() => {
                    if (deps.dialogEl.classList.contains('hidden')) done(false);
                });
                observer.observe(deps.dialogEl, {attributes: true, attributeFilter: ['class']});
            }
            Promise.resolve(messagePromise || message).then((content) => {
                if (settled) return;
                // Node / Node[] 直接用（结构化弹窗体），字符串才包 ai-dialog-text
                const nodes = content instanceof Node ? [content]
                    : (Array.isArray(content) && content.every((n) => n instanceof Node) ? content
                        : [dialogNode('div', 'ai-dialog-text', String(content))]);
                openDialog(title, nodes, [
                    dialogButton(cancelLabel || '取消', 'dlg-btn', () => done(false)),
                    dialogButton(confirmLabel, 'dlg-btn ' + (danger ? 'danger' : 'primary'), () => done(true)),
                ]);
            }).catch(() => done(false));
        });
    }

    // 结构化弹窗体（与接管审批卡同一套明细行 + 提示条样式）：胶囊信息卡 / 丢弃确认共用
    function worktreeDialogBody(wt, totals, noteText) {
        const detail = document.createElement('div');
        detail.className = 'ai-worktree-detail';
        const rows = [
            ['路径', worktreeRelPath(wt.name) + '/'],
            ['分支', wt.branch || '隔离分支'],
        ];
        if (totals.label) rows.push(['改动', worktreeStatNode(totals.label)]);
        // 导出状态标记（L3）：区分「已导出 / 有未导出改动」，避免全量统计被误读成全没回灌
        if (wt.lastExportReport) rows.push(['已导出', '最近预检报告 ' + wt.lastExportReport]);
        for (const [key, value] of rows) {
            const row = document.createElement('div');
            row.className = 'ai-worktree-row';
            const keyEl = document.createElement('span');
            keyEl.className = 'ai-worktree-key';
            keyEl.textContent = key;
            const valEl = document.createElement('span');
            valEl.className = 'ai-worktree-val';
            if (value instanceof Node) valEl.appendChild(value);
            else valEl.textContent = value;
            row.append(keyEl, valEl);
            detail.appendChild(row);
        }
        const note = document.createElement('div');
        note.className = 'ai-worktree-note';
        const noteIcon = document.createElement('span');
        noteIcon.className = 'ai-worktree-note-icon';
        noteIcon.innerHTML = iconSvg('info', 12);
        const noteTextEl = document.createElement('span');
        noteTextEl.textContent = noteText;
        note.append(noteIcon, noteTextEl);
        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.flexDirection = 'column';
        wrap.style.gap = '8px';
        wrap.append(detail, note);
        return wrap;
    }

    // ---------- 会话态与胶囊 / 开关 ----------

    function syncChip(session) {
        const wt = normalizeWorktreeState(session && session.worktree);
        if (chip) {
            if (!wt) {
                chip.classList.add('hidden');
            } else {
                chip.classList.remove('hidden');
                // 图标只注入一次：compact 档（标题行 <420px）会隐藏 label，没有图标就只剩空白圆
                const iconEl = chip.querySelector('.ai-chip-icon');
                if (iconEl && !iconEl.dataset.ready) {
                    iconEl.dataset.ready = '1';
                    iconEl.innerHTML = iconSvg('folder', 12);
                }
                const label = chip.querySelector('.ai-chip-label');
                if (label) label.textContent = '隔离区 ' + wt.name + (wt.lastExportReport ? ' · 已导出' : '');
                chip.dataset.tip = '隔离区 ' + wt.name + (wt.lastExportReport ? '（已导出过：改动统计是全量语义，已回灌部分见预检报告）' : '（点击查看信息与丢弃）');
            }
        }
        if (toggle) {
            const on = !!wt;
            toggle.classList.toggle('active', on);
            toggle.setAttribute('aria-pressed', String(on));
            toggle.textContent = on ? '隔离 · 开' : '隔离';
            toggle.dataset.tip = on
                ? '隔离区已开启：改动只落在 ' + worktreeRelPath(wt.name) + '/（点击关闭 = 丢弃隔离区）'
                : '隔离工作区：在 git worktree 里开发，改动只落在 .cadt/worktree/<slug>/，完成后经补丁审阅回灌';
        }
    }

    // 终端占用检查（对齐 ZCode §3.11「请先关闭在该目录中运行的终端」）：初始 cwd 落在
    // 隔离区内且还活着的终端会话，丢弃隔离区会连它们的进程一起带走。AI 终端工具与
    // 底部终端都走同一个 TermList，这里统一查。
    async function terminalsInWorktree(wt) {
        if (!backend.TermList) return [];
        try {
            const list = await backend.TermList();
            // Windows 终端报的 cwd 是反斜杠：统一转正斜杠再比前缀
            const norm = (p) => String(p || '').toLowerCase().replace(/[\\/]+/g, '/').replace(/\/+$/, '');
            const root = norm(wt.path);
            if (!root) return [];
            return (list || []).filter((t) => {
                if (!t || t.exited || !t.cwd) return false;
                const cwd = norm(t.cwd);
                return cwd === root || cwd.startsWith(root + '/');
            });
        } catch (e) {
            return []; // 查不到就不拦（尽力而为；删除仍受 git 层保护）
        }
    }

    // 实际删除（无二次确认）：清登记、持久化、刷新胶囊/开关。调用方负责弹窗确认。
    // 运行中/并发保护放在这里（胶囊信息卡的【丢弃】也走本函数，不能只靠 pill 的 toggle 守卫）。
    async function removeWorktreeNow(session, wt) {
        if (isRunning(session.id)) {
            flash('当前轮次运行中：结束或停止后再丢弃隔离区', true);
            return false;
        }
        if (worktreeBusy.has(session.id)) {
            flash('隔离区操作正在进行中，请稍候', true);
            return false;
        }
        const occupying = await terminalsInWorktree(wt);
        if (occupying.length) {
            flash('有 ' + occupying.length + ' 个终端在这个隔离区中运行：请先关闭后再丢弃', true);
            return false;
        }
        const root = getScopeRoot(session);
        // 归属断言（批次 B）：要删的隔离区目录必须在本会话根之下。根取错（会话根与窗口根
        // 不同源、或会话登记被拷到别的仓库）时 git worktree remove 会打到别的隔离区上，
        // 不可逆——宁可拒绝也不删。老会话没有 wt.path（早期登记只有 name）时跳过该断言。
        if (!root) {
            flash('本会话没有工作区范围：无法丢弃隔离区', true);
            return false;
        }
        if (wt.path && !pathInsideWorkspace(root, wt.path)) {
            flash('隔离区 ' + wt.name + ' 不在本会话工作区范围内（' + wt.path + '）：已拒绝丢弃', true);
            return false;
        }
        worktreeBusy.add(session.id);
        try {
            // 保底快照（L3）：用户手点的丢弃同样先存档未导出改动
            const snapPath = await snapshotWorktreePatch(root, wt);
            await backend.GitWorktreeRemove(root, wt.name, true);
            if (session.worktree && session.worktree.name === wt.name) {
                session.worktree = null;
                persistSessions();
            }
            syncChip(currentSession() === session ? session : null);
            let note = '已丢弃隔离工作区 ' + wt.name;
            if (snapPath) note += '（未导出改动已存档：' + snapPath + '，可恢复）';
            else if (snapPath === null) note += '（保底快照失败，未导出改动已丢失）';
            flash(note);
            // 写进会话历史：丢弃也是隔离区生命周期的一部分，重启后对话里可查
            recordToolEvent(session, {action: 'discard', name: wt.name},
                '已丢弃隔离工作区 ' + worktreeRelPath(wt.name) + '（含分支 ' + (wt.branch || '隔离分支') + '）。'
                + (snapPath ? '丢弃前已存档未导出改动：' + snapPath + '（可恢复）。' : '')
                + (snapPath === null ? '保底快照失败，未导出改动已丢失。' : ''));
            return true;
        } catch (e) {
            flash('丢弃失败：' + ((e && e.message) || e), true);
            return false;
        } finally {
            worktreeBusy.delete(session.id);
        }
    }

    // 丢弃确认（输入区「隔离」pill 取消勾选时用；返回是否真的丢弃）
    async function discardForSession(session) {
        const wt = normalizeWorktreeState(session && session.worktree);
        if (!wt) return false;
        const statPromise = backend.GitWorktreeStat
            ? backend.GitWorktreeStat(getScopeRoot(session), wt.name, wt.baseSha).catch(() => '')
            : Promise.resolve('');
        const confirmed = await confirmDialog({
            title: '丢弃隔离工作区',
            messagePromise: statPromise.then((stat) => worktreeDialogBody(wt, worktreeStatTotals(stat),
                '丢弃将删除 worktree 与分支（丢弃前会自动把未导出改动存档为 .patch，可恢复）；主根不受影响。回灌先让 AI 执行 worktree_manage(action=export)。')),
            confirmLabel: '丢弃隔离区',
            danger: true,
        });
        logPermission('worktree', worktreeRelPath(wt.name), confirmed ? 'approved' : 'denied', 'confirm', '');
        if (!confirmed) return false;
        // 运行中允许查看信息，但丢弃要等轮次结束（写效应正在产生，与输入区开关守卫一致）
        if (isRunning(session.id)) {
            flash('当前轮次运行中：结束或停止后再丢弃隔离区');
            return false;
        }
        return removeWorktreeNow(session, wt);
    }

    // 头部胶囊 / 权限菜单「隔离工作区」行：查看信息（路径 / 分支 / 改动统计 / 回灌指引），
    // 底部两个显式按钮【关闭】【丢弃隔离区】——点击本身不再直接进入丢弃流程。
    async function openChipDialog() {
        const session = currentSession();
        const wt = normalizeWorktreeState(session && session.worktree);
        if (!wt) return false;
        const statPromise = backend.GitWorktreeStat
            ? backend.GitWorktreeStat(getScopeRoot(session), wt.name, wt.baseSha).catch(() => '')
            : Promise.resolve('');
        const confirmed = await confirmDialog({
            title: '隔离工作区 ' + wt.name,
            cancelLabel: '关闭',
            messagePromise: statPromise.then((stat) => worktreeDialogBody(wt, worktreeStatTotals(stat),
                '回灌：让 AI 执行 worktree_manage(action=export)，在审批卡里逐文件审阅后应用。丢弃将删除 worktree 与分支（未导出改动会自动存档为 .patch，可恢复）。')),
            confirmLabel: '丢弃隔离区',
            danger: true,
        });
        logPermission('worktree', worktreeRelPath(wt.name), confirmed ? 'approved' : 'denied', 'confirm', '');
        if (!confirmed) return false;
        return removeWorktreeNow(session, wt);
    }

    // 会话级开关（输入区「隔离」pill 与权限菜单「隔离工作区」行共用）：勾上=创建（确认卡），
    // 取消=确认丢弃；轮次运行中不许切换（写效应正在产生）。
    async function toggleForSession(session) {
        if (!session) return;
        if (isRunning(session.id)) {
            flash('当前轮次运行中：结束或停止后再切换隔离区');
            syncChip(session);
            return;
        }
        const wt = normalizeWorktreeState(session.worktree);
        if (!wt) await createForSession(session, '');
        else await discardForSession(session);
        syncChip(currentSession() === session ? session : null);
    }

    function onToggleClick() {
        return toggleForSession(currentSession());
    }

    function mountChip() {
        if (chip) chip.addEventListener('click', openChipDialog);
        if (toggle) toggle.addEventListener('click', onToggleClick);
    }

    // 启动 reconcile：清 git 侧失效 worktree 记录（不动现存目录）。尽力而为。
    async function pruneStartup() {
        const root = getScopeRoot();
        if (!root || !backend.GitWorktreePrune) return;
        try {
            await backend.GitWorktreePrune(root);
        } catch (e) {} // 无 git / 非仓库时静默（这是尽力而为的清理）
    }

    // 恢复校验：会话登记的 worktree 目录已不存在（被手动删 / prune 过）时清字段，
    // 返回给注入块的提示；目录仍在时返回 <worktree> 块。由 assembleSystemContext 每轮调用。
    async function blockFor(session) {
        const wt = normalizeWorktreeState(session && session.worktree);
        if (!wt) return '';
        let exists = true;
        try {
            if (backend.GetPathInfo) await backend.GetPathInfo(wt.path);
        } catch (e) {
            exists = false;
        }
        if (!exists) {
            session.worktree = null;
            persistSessions();
            syncChip(currentSession() === session ? session : null);
            return [
                '<worktree>',
                '本会话此前登记的隔离工作区 ' + worktreeRelPath(wt.name) + ' 已不存在（被手动删除或清理），登记已清除。',
                '需要隔离时重新调 worktree_manage(action=create)。',
                '</worktree>',
            ].join('\n');
        }
        return worktreeBlockText(wt);
    }

    // ---------- worktree_manage 工具执行 ----------

    const deny = (code, message, detail) => '【worktree:error】' + code + '：' + message + (detail ? '\n' + detail : '');

    async function manageTool(ctx, input) {
        const action = aiTextOf(input && input.action).trim();
        const session = ctx && ctx.session;
        const toolMessage = ctx && ctx.toolMessage;
        switch (action) {
            case 'create':
                return manageCreate(session, toolMessage, input);
            case 'list':
                return manageList(session);
            case 'stat':
                return manageStat(session, input);
            case 'export':
                return manageExport(ctx, input);
            case 'discard':
                return manageDiscard(session, toolMessage, input);
            case 'conflict_detail':
                return manageConflictDetail(session, input);
            default:
                return deny('WORKTREE_ACTION', '未知 action：' + (action || '（空）') + '，可用 create / list / stat / export / discard / conflict_detail');
        }
    }

    function requireWriteSession(session) {
        if (!session) return '缺少会话上下文';
        const root = getScopeRoot(session);
        if (!root) return '当前没有工作区范围：隔离工作区建在主根的 .cadt/worktree/ 下，请先打开文件夹';
        return '';
    }

    // 解析操作目标：默认本会话自己的隔离区；带 name 时允许「本会话派生的子代理隔离区」
    // （登记外的一律拒绝——别的会话的隔离区不可触碰）。返回 {wt, own} 或 null。
    function resolveTarget(session, requestedName) {
        return resolveWorktreeTarget(session && session.worktree, getSubWorktrees(session ? session.id : ''), requestedName);
    }

    async function manageCreate(session, toolMessage, input) {
        const missing = requireWriteSession(session);
        if (missing) return deny('WORKTREE_CONTEXT', missing);
        const reasonCheck = worktreeReasonCheck(input && input.reason);
        if (reasonCheck.error) return deny('WORKTREE_REASON', reasonCheck.error, '补上 reason 后重试；它是审批卡给人看的首要信息');
        const reason = reasonCheck.reason;
        const root = getScopeRoot(session);
        if (session.worktree && normalizeWorktreeState(session.worktree)) {
            const wt = session.worktree;
            return deny('WORKTREE_EXISTS', '本会话已有隔离工作区 ' + worktreeRelPath(wt.name)
                + '（一会话一个）', '先 export 回灌或 discard 丢弃后再创建新的');
        }
        if (worktreeBusy.has(session.id)) {
            return deny('WORKTREE_BUSY', '本会话已有隔离区创建/删除在进行中', '等它完成后再试，避免建出两个隔离区');
        }
        const label = aiTextOf(input && input.label).trim().slice(0, 80);
        // carry=true：把主根当前未提交改动带入隔离区（binary patch + 未跟踪拷贝，
        // 打快照 commit 推进 baseSha——export 只含 AI 的草稿改动）
        const carry = input && input.carry === true;
        // 审批卡（接管 composer）：AI 主动创建 = 写盘 + 建分支 + 改变会话工作方式。
        // 全档必弹（含完全权限）——这是会话级状态变更，不是逐写风险判定；用户手点的「隔离」
        // 开关仍走居中确认弹窗（用户自己发起的动作）。
        const decision = await requestWorktreeApproval(session, toolMessage, {
            action: 'create',
            label,
            carry,
            reason,
            // 卡上给人看真实路径：按同一派生规则预测（同名冲突时 Go 顺延 -2/-3，结果里是实际名）
            slug: predictWorktreeSlug(label, session.id || ''),
        });
        if (!decision.approved) {
            return decision.cancelled
                ? '用户已停止生成，隔离工作区未创建。'
                : '用户取消了隔离工作区创建。如仍有需要，请说明用途后再次请求。';
        }
        // 审批等待期间用户可能已从 /worktree 或权限菜单建了一个：复查，避免第二个覆盖登记
        const raced = normalizeWorktreeState(session.worktree);
        if (raced) {
            return deny('WORKTREE_EXISTS', '审批期间本会话已创建隔离工作区 ' + worktreeRelPath(raced.name),
                '直接使用现有隔离区，不要重复创建');
        }
        if (toolHalted(toolMessage)) {
            settleWorktreeApproval(session, toolMessage, 'cancelled', '用户已停止生成');
            return '用户已停止生成，创建已取消。';
        }
        worktreeBusy.add(session.id);
        let added;
        try {
            added = await backend.GitWorktreeAdd(root, label, session.id || '', carry);
        } catch (e) {
            const msg = String((e && e.message) || e);
            settleWorktreeApproval(session, toolMessage, 'failed', msg);
            return deny('WORKTREE_ADD', '创建失败', msg);
        } finally {
            worktreeBusy.delete(session.id);
        }
        session.worktree = normalizeWorktreeState({
            name: added.name,
            branch: added.branch,
            path: added.path,
            baseSha: added.baseSha,
            createdAt: Date.now(),
        });
        persistSessions();
        syncChip(currentSession() === session ? session : null);
        flash('已创建隔离工作区 ' + added.name);
        return [
            '已创建隔离工作区：' + worktreeRelPath(added.name) + '/（分支 ' + added.branch + '，基准 ' + added.baseSha.slice(0, 10) + '）。',
            '从现在起：',
            '- 所有文件改动写到 ' + worktreeRelPath(added.name) + '/…（相对范围根），不要改主根同名文件。',
            '- run_command / background_command 未显式传 cwd 时默认就在 ' + worktreeRelPath(added.name) + ' 里执行；要看主根用 cwd=\'.\'。',
            depsNoteOf(added),
            '- 隔离区只有 git 跟踪内容：依赖目录（如 frontend/node_modules）与构建产物（dist）不在其中——测试或构建前先在隔离区自举，例：cd frontend && npm install → npm run build（缺 dist 时 go build 报 embed 错误是在提示先构建前端）。测试「假失败」先怀疑缺生成物，不是代码错误。',
            '- 完成后调 worktree_manage(action=export) 生成补丁交用户审阅回灌；不要 commit 到隔离分支。',
        ].filter(Boolean).join('\n');
    }

    // 依赖共享 / .worktreeinclude / carry 的结果说明（manageCreate 的工具结果用）
    function depsNoteOf(added) {
        const lines = [];
        if (Array.isArray(added.deps) && added.deps.length) {
            lines.push('- 已 junction 共享主根依赖：' + added.deps.join('、') + '（npm / pip 可直接使用；写入的就是主根依赖目录）。');
        }
        if (Array.isArray(added.depErrors) && added.depErrors.length) {
            lines.push('- 依赖共享失败项：' + added.depErrors.join('；') + '（不阻塞；需要依赖时在隔离区里自行安装，不要手动 mklink 借主根目录）。');
        }
        if (added.includeCopied > 0) {
            lines.push('- 已按 .worktreeinclude 从主根拷贝 ' + added.includeCopied + ' 个被忽略文件（.env 等）。');
        }
        if (Array.isArray(added.includeErrors) && added.includeErrors.length) {
            lines.push('- .worktreeinclude 拷贝失败项：' + added.includeErrors.join('；') + '（不阻塞；用户可能需要手动补）。');
        }
        if (added.carried > 0) {
            lines.push('- 已从主根带入 ' + added.carried + ' 个未提交改动（含暂存划分与未跟踪文件），并打成快照 commit 作为基准——export 的 diff 只含你的草稿改动。');
        }
        return lines.join('\n');
    }

    // 面板直连创建（/worktree 斜杠命令 / 计划批准卡「在隔离区中执行」）：不依赖模型回合与 toolMessage，
    // 确认卡走当前档位（full 免），创建后胶囊同步；并把「已创建隔离区」写进会话历史。
    // opts.carry=true 时同时带入主根未提交改动；opts.skipConfirm=true 表示调用方已经拿过用户确认
    // （计划批准卡本身就是一次明确确认，不必再弹第二次），full 档本来就免确认；
    // opts.allowRunning=true 用于「先停流再建隔离区」的批准场景——stopGeneration 后 streams 要到
    // 兜底定时器才摘除，这期间 streamOf 仍非空，但写效应已停，可以安全建区。
    // 返回 {name, branch, path, baseSha} 或 null。
    async function createForSession(session, label, opts) {
        const missing = requireWriteSession(session);
        if (missing) {
            flash(missing, true);
            return null;
        }
        // 运行中一律不许切换（写效应正在产生）：此前的守卫只挂在输入区 pill 上，
        // /worktree 与权限菜单直连这里会绕过（2026-11-17 复查）。
        if (isRunning(session.id) && !(opts && opts.allowRunning)) {
            flash('当前轮次运行中：结束或停止后再切换隔离区', true);
            return null;
        }
        if (worktreeBusy.has(session.id)) {
            flash('隔离区操作正在进行中，请稍候', true);
            return null;
        }
        // 只读档没有写工具，建了也没法用：先提示切档
        if (currentScopeOf(session) === 'read') {
            flash('只读访问档不能隔离开发：先把权限切到「每次询问」及以上', true);
            return null;
        }
        if (session.worktree && normalizeWorktreeState(session.worktree)) {
            flash('本会话已有隔离工作区：' + worktreeRelPath(session.worktree.name));
            return null;
        }
        const scope = currentScopeOf(session);
        let confirmed = true;
        if (scope !== 'full' && !(opts && opts.skipConfirm)) {
            confirmed = await confirmDialog({
                title: '创建隔离工作区',
                message: '在当前工作区建一个隔离 git worktree：之后的改动落在 ' + WORKTREE_REL_DIR + '/<slug>/（新分支 cadt/wt/<slug>），'
                    + '不影响主根；完成后经补丁审批卡审阅回灌。',
                confirmLabel: '创建',
                danger: false,
            });
            logPermission('worktree', WORKTREE_REL_DIR, confirmed ? 'approved' : 'denied', 'confirm', '');
        }
        if (!confirmed) return null;
        // 确认/审批等待期间可能已建好（另一入口）：复查防重复
        if (normalizeWorktreeState(session.worktree)) {
            flash('本会话已有隔离工作区：' + worktreeRelPath(session.worktree.name));
            return null;
        }
        worktreeBusy.add(session.id);
        const carry = !!(opts && opts.carry);
        let added;
        try {
            added = await backend.GitWorktreeAdd(getScopeRoot(session), aiTextOf(label).trim().slice(0, 80), session.id || '', carry);
        } catch (e) {
            flash('创建隔离工作区失败：' + ((e && e.message) || e), true);
            return null;
        } finally {
            worktreeBusy.delete(session.id);
        }
        session.worktree = normalizeWorktreeState({
            name: added.name,
            branch: added.branch,
            path: added.path,
            baseSha: added.baseSha,
            createdAt: Date.now(),
        });
        persistSessions();
        syncChip(currentSession() === session ? session : null);
        flash('已创建隔离工作区 ' + added.name);
        // 会话历史留痕（对齐 ZCode 的「已创建 worktree」timeline part）：重启后可查来龙去脉
        const summaryLines = [
            '已创建隔离工作区：' + worktreeRelPath(added.name) + '/（分支 ' + added.branch + '，基准 ' + String(added.baseSha || '').slice(0, 10) + '）。',
            '改动只落在隔离区，主根零改动；完成后 AI 经 worktree_manage(action=export) 生成补丁审阅回灌。',
        ];
        if (carry && added.carried > 0) summaryLines.push('已带入主根未提交改动 ' + added.carried + ' 个文件（快照 commit 作为基准）。');
        if (added.includeCopied > 0) summaryLines.push('已按 .worktreeinclude 拷贝 ' + added.includeCopied + ' 个被忽略文件。');
        summaryLines.push('提示：隔离区只有 git 跟踪内容——依赖目录与构建产物（node_modules / dist）不在其中，测试前需先自举（npm install → npm run build）。');
        recordToolEvent(session, {action: 'create', label: aiTextOf(label).trim().slice(0, 80), carry}, summaryLines.join('\n'));
        return added;
    }

    // 单个 worktree 的未提交改动统计尾行（尽力而为，失败返回空串）
    async function statLineOf(relPath, session) {
        if (!backend.GitWorktreeStat) return '';
        const slug = String(relPath || '').split('/').pop();
        try {
            const stat = await backend.GitWorktreeStat(getScopeRoot(session), slug, '');
            return worktreeStatTotals(stat).label;
        } catch (e) {
            return '';
        }
    }

    async function manageList(session) {
        const root = getScopeRoot(session);
        if (!root) return deny('WORKTREE_CONTEXT', '当前没有工作区范围');
        try {
            const result = await backend.GitWorktreeList(root);
            // 对比 lite：给每个隔离区取一行未提交改动统计（外部 worktree 无基准，按 HEAD 对比）
            const stats = {};
            for (const item of result.items || []) {
                if (item.underCadt && item.relPath) {
                    stats[item.relPath] = await statLineOf(item.relPath, session);
                }
            }
            return formatWorktreeList(result, getSessions(), stats);
        } catch (e) {
            return deny('WORKTREE_LIST', '查询失败', String((e && e.message) || e));
        }
    }

    async function manageStat(session, input) {
        const root = getScopeRoot(session);
        if (!root) return deny('WORKTREE_CONTEXT', '当前没有工作区范围');
        const target = resolveTarget(session, input && input.name);
        if (!target) {
            const wanted = String((input && input.name) || '').trim();
            if (wanted) return deny('WORKTREE_OWNERSHIP', '隔离区 ' + wanted + ' 不归本会话管', '只允许操作本会话自己的隔离区或本会话派生的子代理隔离区');
            return deny('WORKTREE_NONE', '本会话没有隔离工作区', '先 worktree_manage(action=create) 创建');
        }
        const wt = target.wt;
        try {
            const stat = await backend.GitWorktreeStat(root, wt.name, wt.baseSha);
            if (!String(stat || '').trim()) {
                return 'worktree 没有改动（相对创建基准无差异）。';
            }
            let text = '隔离区 ' + worktreeRelPath(wt.name) + ' 相对创建基准的改动统计（全量语义）：\n' + String(stat).trim();
            // 导出状态标记（L3）：已回灌部分看最近一次预检报告，别被全量统计误导成「全没回灌」
            if (wt.lastExportReport) {
                text += '\n已导出标记：最近一次 export 预检报告 ' + wt.lastExportReport
                    + '（报告里的「已应用」栏是主根已有的改动，无需重做）。';
            }
            return text;
        } catch (e) {
            return deny('WORKTREE_STAT', '统计失败', String((e && e.message) || e));
        }
    }

    // conflict_detail（L3「冲突报告可消费」）：主根某文件相对基准的 diff，按需逐文件拉取，
    // 单文件行数封顶（Go 侧截断）——冲突细节按需取（贵），文件级清单在 export 回执里（便宜）。
    async function manageConflictDetail(session, input) {
        const root = getScopeRoot(session);
        if (!root) return deny('WORKTREE_CONTEXT', '当前没有工作区范围');
        const target = resolveTarget(session, input && input.name);
        if (!target) {
            const wanted = String((input && input.name) || '').trim();
            if (wanted) return deny('WORKTREE_OWNERSHIP', '隔离区 ' + wanted + ' 不归本会话管', '只允许操作本会话自己的隔离区或本会话派生的子代理隔离区');
            return deny('WORKTREE_NONE', '本会话没有隔离工作区', '先 worktree_manage(action=create) 创建');
        }
        const wt = target.wt;
        const file = String((input && input.file) || '').trim();
        if (!file) return deny('WORKTREE_ARGS', '缺少 file：要查主根相对基准 diff 的文件路径（相对主根）');
        if (typeof backend.GitWorktreeDiffSinceBase !== 'function') {
            return deny('WORKTREE_ENV', '当前环境没有 diff 通道（旧后端）', '可改用 run_command 在主根跑 git diff ' + wt.baseSha + ' -- ' + file);
        }
        try {
            const diff = await backend.GitWorktreeDiffSinceBase(root, wt.baseSha, file, 200);
            return '主根 ' + file + ' 相对创建基准的改动（封顶 200 行）：\n' + diff
                + '\n据此在 ' + worktreeRelPath(wt.name) + '/ 里重做该文件后重新 export；绝不要直接改主根。';
        } catch (e) {
            return deny('WORKTREE_CONFLICT_DETAIL', '查询失败', String((e && e.message) || e));
        }
    }

    async function manageExport(ctx, input) {
        const session = ctx && ctx.session;
        const toolMessage = ctx && ctx.toolMessage;
        const missing = requireWriteSession(session);
        if (missing) return deny('WORKTREE_CONTEXT', missing);
        const root = getScopeRoot(session);
        const target = resolveTarget(session, input && input.name);
        if (!target) {
            const wanted = String((input && input.name) || '').trim();
            if (wanted) {
                return deny('WORKTREE_OWNERSHIP', '隔离区 ' + wanted + ' 不归本会话管',
                    '只允许操作本会话自己的隔离区或本会话派生的子代理隔离区（可用 list 查看）');
            }
            return deny('WORKTREE_NONE', '本会话没有隔离工作区', '先 worktree_manage(action=create) 创建');
        }
        const wt = target.wt;
        let diffText = '';
        try {
            diffText = await backend.GitWorktreeDiff(root, wt.name, wt.baseSha);
        } catch (e) {
            const msg = String((e && e.message) || e);
            if (msg.includes('没有改动')) {
                return 'worktree 没有改动（相对创建基准无差异）：先在 ' + worktreeRelPath(wt.name) + '/ 里做修改，再导出。';
            }
            return deny('WORKTREE_DIFF', '导出 diff 失败', msg);
        }
        if (diffText.length > WORKTREE_PATCH_LIMIT) {
            return deny('WORKTREE_LIMIT', '改动太大（' + Math.round(diffText.length / 1024) + ' KB，上限 256 KB）',
                '请把批量改动拆成多轮，每轮 export 后 discard 再开新的隔离区');
        }
        if (toolHalted(toolMessage)) return '用户已停止生成，导出已取消。';
        // dev mock 只实现了 GitWorktree*，没有补丁后端：给明确原因，别让 TypeError 被
        // 下面的 catch 误报成「补丁无法解析」。
        if (typeof backend.PatchSave !== 'function' || typeof backend.PatchApply !== 'function') {
            return deny('WORKTREE_NO_PATCH', '当前环境缺少补丁后端（dev mock 不支持回灌）',
                '请在完整应用里验证 export；这里只能 create/stat/discard。');
        }
        // 零副作用预检（L1，方案 docs/unfinished-plans/worktree-export-improvement.md）：
        // merge-tree 三方合并（base=wt.baseSha，ours=主根快照，theirs=隔离区快照），零落盘。
        // - 全部已应用 → 明确「无需重做」，不落盘补丁（消除复盘问题 2 的假冲突）；
        // - 预检不可应用（只有真冲突）→ 三栏报告直接返回，不再走 PatchSave 的
        //   「补丁已保存但没有任何文件可直接应用」误导路径（复盘问题 1/4）；
        // - 干净或混合（有可应用也有冲突）→ 仍走原 PatchSave 审批链路（可部分应用）；
        // - 绑定缺失（dev mock / 旧后端）、git <2.38、快照失败 → 静默降级走原链路兜底。
        let mp = null;
        if (typeof backend.GitWorktreeMergePreview === 'function') {
            try {
                const res = await backend.GitWorktreeMergePreview(root, wt.name, wt.baseSha);
                if (res && res.supported) mp = res;
            } catch (e) {
                mp = null; // 与无预检同待遇：兜底链路
            }
        }
        if (mp) markExportReport(session, target, wt, mp);
        if (mp && !(mp.applicable || []).length && (mp.conflicted || []).length) {
            // 有真冲突且没有可直接应用的文件：不落盘补丁、不弹审批卡，给有信息量的报告
            return worktreeExportPreviewText(wt, mp);
        }
        if (mp && (mp.alreadyApplied || []).length && !(mp.applicable || []).length && !(mp.conflicted || []).length) {
            return worktreeExportPreviewText(wt, mp);
        }
        let preview;
        try {
            preview = await backend.PatchSave(root, 'worktree 回灌：' + wt.name, diffText);
        } catch (e) {
            return deny('PATCH_PARSE', '补丁无法解析或路径不合法', String((e && e.message) || e));
        }
        // S2 应用换轨：merge-tree 判定「可合并」的文件按可应用呈现——双向引擎判冲突
        // ≠ 三方合不了（行号漂移、远处改动都合得动），审批卡里用户仍可自由勾选
        const mpApplicable = mp ? new Set(mp.applicable || []) : null;
        if (mpApplicable && mpApplicable.size) {
            for (const f of preview.files || []) {
                if (mpApplicable.has(f.relPath) && f.status !== 'ok') f.status = 'ok';
            }
        }
        const okFiles = (preview.files || []).filter((f) => f.status === 'ok');
        if (!okFiles.length && !(mp && (mp.applicable || []).length)) {
            const first = (preview.files || []).find((f) => f.reason) || {};
            return deny('PATCH_HUNK_CONFLICT', '补丁已保存但没有任何文件可直接应用：' + (first.relPath || '')
                    + (first.reason ? '（' + first.reason + '）' : ''),
                '主根在隔离期间被改过时会如实报错（严格匹配）；可重新导出或人工比对。补丁文件：' + (preview.patchPath || ''));
        }
        // 回灌闸门：全档必弹（含 full）——人工审阅是本功能的红线
        const decision = await requestPatchApproval(session, toolMessage, preview, true);
        if (!decision.approved) {
            return decision.cancelled
                ? deny('WORKTREE_DENIED', '用户停止了生成，补丁未应用', '补丁文件已保留：' + (preview.patchPath || ''))
                : deny('WORKTREE_DENIED', '用户放弃了本次回灌，主根未修改', '补丁文件已保留：' + (preview.patchPath || ''));
        }
        if (toolHalted(toolMessage)) {
            settleWorktreeApproval(session, toolMessage, 'cancelled', '用户已停止生成');
            return deny('WORKTREE_DENIED', '用户停止了生成，补丁未应用', '补丁文件已保留：' + (preview.patchPath || ''));
        }
        const approvalRef = toolMessage.approval || {};
        const mode = approvalRef.mode === 'atomic' ? 'atomic' : 'partial';
        const selected = Array.isArray(approvalRef.selected) && approvalRef.selected.length
            ? approvalRef.selected
            : okFiles.map((f) => f.relPath);
        toolMessage.status = 'running';
        toolMessage.content = '正在把隔离区改动回灌主根…';
        refreshToolWrap(session, toolMessage);
        let result;
        try {
            if (mp && typeof backend.GitWorktreeMergeApply === 'function') {
                // S2：应用走 merge-tree 写回（与预检同引擎，应用瞬间重新跑合并保证一致性，
                // 不碰主根 index）；结果形状对齐 PatchApply，结果卡零适配渲染
                result = await backend.GitWorktreeMergeApply(root, wt.name, wt.baseSha, selected);
            } else {
                result = await backend.PatchApply(approvalRef.planId, selected, null, mode);
            }
        } catch (e) {
            const msg = String((e && e.message) || e);
            // 补丁卡读 approval.result 判断「正在应用」还是结果；异常不落 failed 会永久转圈
            toolMessage.approval = toolMessage.approval || {};
            toolMessage.approval.result = {applied: 0, skipped: 0, files: [], message: msg};
            settleWorktreeApproval(session, toolMessage, 'failed', msg);
            return deny('PATCH_APPLY_IO', '回灌写入失败', msg);
        }
        if (toolMessage.approval) {
            toolMessage.approval.result = result;
            toolMessage.approval.state = 'approved';
        }
        let applied = 0;
        for (const f of result.files || []) {
            if (f.status === 'applied') {
                applied++;
                recordChange(session, {path: joinPath(root, f.relPath), relPath: f.relPath, tool: 'worktree_export', added: f.added || 0, removed: f.removed || 0});
                notifyFileChanged(joinPath(root, f.relPath));
            }
        }
        // okTotal = 预检可应用数：未勾选（冲突）的文件不在 PatchApply 结果里，让 unselected 写进汇总
        const lines = [patchResultText(result, {okTotal: okFiles.length, inWorktree: true})];
        if (applied > 0) {
            lines.push('回灌来自隔离区 ' + worktreeRelPath(wt.name) + '（' + applied + ' 个文件）。改动已回主根，worktree 保留；'
                + '建议 worktree_manage(action=discard) 收尾——再次 export 是全量语义，已回灌的 hunk 会预检报「不可应用」。');
        }
        if (mp) {
            if ((mp.conflicted || []).length) {
                lines.push('预检判定另有 ' + mp.conflicted.length + ' 个文件真冲突（未回灌）：在隔离区按主根当前内容重做后重新 export，'
                    + '绝不要直接改主根文件绕过审阅。全量报告：' + (mp.reportPath || ''));
            } else if (mp.reportPath) {
                lines.push('merge-tree 预检报告：' + mp.reportPath);
            }
        }
        return lines.filter(Boolean).join('\n');
    }

    async function manageDiscard(session, toolMessage, input) {
        const missing = requireWriteSession(session);
        if (missing) return deny('WORKTREE_CONTEXT', missing);
        const reasonCheck = worktreeReasonCheck(input && input.reason);
        if (reasonCheck.error) return deny('WORKTREE_REASON', reasonCheck.error, '补上 reason 后重试；它是审批卡给人看的首要信息');
        const reason = reasonCheck.reason;
        const target = resolveTarget(session, input && input.name);
        if (!target) {
            const wanted = String((input && input.name) || '').trim();
            if (wanted) return deny('WORKTREE_OWNERSHIP', '隔离区 ' + wanted + ' 不归本会话管', '只允许操作本会话自己的隔离区或本会话派生的子代理隔离区');
            return deny('WORKTREE_NONE', '本会话没有隔离工作区');
        }
        const wt = target.wt;
        if (worktreeBusy.has(session.id)) {
            return deny('WORKTREE_BUSY', '本会话已有隔离区创建/删除在进行中', '等它完成后再试');
        }
        // 终端占用（对齐 ZCode §3.11）：初始 cwd 在隔离区内的活终端会随删除一起被杀
        const occupying = await terminalsInWorktree(wt);
        if (occupying.length) {
            return deny('WORKTREE_TERMINAL', '有 ' + occupying.length + ' 个终端在这个隔离区中运行',
                '请让用户先关闭这些终端（或等它们退出）后再 discard');
        }
        // 销毁性动作：接管 composer 的审批卡（全档必弹，含完全权限），卡片里附改动汇总
        const statText = backend.GitWorktreeStat
            ? await backend.GitWorktreeStat(getScopeRoot(session), wt.name, wt.baseSha).catch(() => '')
            : '';
        const stat = worktreeStatTotals(statText).label || '无改动';
        const decision = await requestWorktreeApproval(session, toolMessage, {
            action: 'discard',
            name: wt.name,
            relPath: worktreeRelPath(wt.name),
            branch: wt.branch || '',
            stat,
            reason,
        });
        if (!decision.approved) {
            return decision.cancelled
                ? '用户已停止生成，隔离工作区保留。'
                : '用户保留了隔离工作区 ' + wt.name + '。';
        }
        if (toolHalted(toolMessage)) {
            settleWorktreeApproval(session, toolMessage, 'cancelled', '用户已停止生成');
            return '用户已停止生成，丢弃已取消。';
        }
        const root = getScopeRoot(session);
        // 保底快照（L3）：丢弃前把未导出改动落盘 .cadt/patches/，绝不静默丢工作
        const snapPath = await snapshotWorktreePatch(root, wt);
        worktreeBusy.add(session.id);
        try {
            await backend.GitWorktreeRemove(root, wt.name, true);
        } catch (e) {
            const msg = String((e && e.message) || e);
            settleWorktreeApproval(session, toolMessage, 'failed', msg);
            return deny('WORKTREE_REMOVE', '删除失败', msg);
        } finally {
            worktreeBusy.delete(session.id);
        }
        if (target.own) {
            // 只清本会话自己的登记；丢的是子代理隔离区时不动 session.worktree
            session.worktree = null;
            persistSessions();
            syncChip(currentSession() === session ? session : null);
        }
        flash('已丢弃隔离工作区 ' + wt.name);
        let note = '已丢弃隔离工作区 ' + worktreeRelPath(wt.name) + '（含分支）。主根不受影响；需要时重新 create。';
        if (snapPath) {
            note = '丢弃前已自动存档未导出改动（.patch）：' + snapPath + '（可用 git apply 或 propose_patch 恢复）。' + note;
        } else if (snapPath === null) {
            note = '保底快照失败：未导出改动已随隔离区删除。' + note;
        }
        return note;
    }

    return {manageTool, mountChip, syncChip, pruneStartup, blockFor, openChipDialog, createForSession, toggleForSession};
}
