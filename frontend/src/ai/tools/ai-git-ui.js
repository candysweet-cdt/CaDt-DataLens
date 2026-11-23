// ai-git-ui.js：Git 快捷操作 UI（标题栏入口按钮 + 动作菜单 + 派发发送）。
// 从 ai-panel.js 拆出（docs/unfinished-plans/structure-cleanup.md 阶段 3），函数体逐字搬移。
// gitEntryState 为本域私有 let，随域迁入模块；其余依赖引用稳定，经 ctx 注入。
import {GIT_ACTIONS, OTHER_ACTIONS, buildGitActionPrompt} from './ai-git.js';
import {aiTextOf} from '../core/ai-constants.js';

export function createAIGitUi(ctx) {
    const el = ctx.el;
    const getGitRepo = ctx.getGitRepo;
    const currentWorkspacePath = ctx.currentWorkspacePath;
    const currentScopeOf = ctx.currentScopeOf;
    const syncStreamView = ctx.syncStreamView;
    const compactOf = ctx.compactOf;
    const currentSession = ctx.currentSession;
    const flash = ctx.flash;
    const ensureOpen = ctx.ensureOpen;
    const showNote = ctx.showNote;
    const sendAppMessage = ctx.sendAppMessage;
    const showContextMenu = ctx.showContextMenu;
    const setGitFlowToken = ctx.setGitFlowToken;
    const getSettings = ctx.getSettings;

    // ---------- Git 快捷操作 ----------

    let gitEntryState = {available: false, root: '', branch: ''};

    // 工作区变化（打开/关闭目录、仓库探测完成）后由 main.js 调用，决定 Git 图标是否出现。
    function refreshGitEntry() {
        if (!el.gitBtn) return;
        let repo = null;
        try {
            repo = getGitRepo ? getGitRepo() : null;
        } catch (e) {
            repo = null;
        }
        const root = currentWorkspacePath();
        const available = !!(repo && repo.available && root);
        gitEntryState = {
            available,
            root,
            branch: aiTextOf(repo && repo.branch),
        };
        el.gitBtn.classList.toggle('hidden', !available);
    }

    function gitActionBlockedReason(session) {
        if (!session) return '没有可用的会话';
        if (session.archivedAt) return '当前会话已归档，请先取消归档再执行 Git 操作';
        if (session.planMode) return '计划模式下不能执行 Git 操作，请先退出计划模式';
        if (currentScopeOf(session) === 'read') return 'Git 操作需要写权限：请把底部权限切到「每次询问」或更高';
        return '';
    }

    // 所有快捷操作共用的门禁 + 发送：git 动作与「其他操作」只差 meta（图标 / 令牌 / 标签前缀）。
    function runAction(action, meta) {
        if (!meta) return;
        if (syncStreamView() || compactOf((currentSession() || {}).id)) {
            flash('AI 正在生成，请等本轮结束后再执行快捷操作', true);
            return;
        }
        const session = currentSession();
        const blocked = gitActionBlockedReason(session);
        if (blocked) {
            ensureOpen();
            showNote(blocked, true);
            flash(blocked, true);
            return;
        }
        if (!gitEntryState.available) {
            refreshGitEntry();
            if (!gitEntryState.available) {
                flash('当前工作区不在 Git 仓库内', true);
                return;
            }
        }
        const prompt = buildGitActionPrompt(action, {root: gitEntryState.root, branch: gitEntryState.branch});
        if (!prompt) return;
        // 一次性窄豁免：auto 档下常规 git 写命令（add/commit/push/pull）免逐条审批。
        // 令牌按会话归属、15 分钟过期；危险变体与项目规则仍照常拦截（见 ai-panel.js approveCommandForRun）。
        // 只有 git 动作需要这个令牌；「其他操作」（维护认知索引 / 更新日志）不执行 git 写命令。
        if (meta.isGit && setGitFlowToken) setGitFlowToken(session.id, gitEntryState.root);
        ensureOpen();
        sendAppMessage({
            kind: 'git',
            icon: meta.msgIcon,
            label: (meta.isGit ? 'Git 快捷操作 · ' : '快捷操作 · ') + meta.label,
            content: prompt,
        }).then((sent) => {
            if (!sent) flash('快捷操作未能发送，请检查模型配置或当前会话状态', true);
        }).catch((e) => flash('快捷操作发送失败：' + ((e && e.message) || e), true));
    }

    function runGitAction(action) {
        runAction(action, GIT_ACTIONS.find((item) => item.id === action));
    }

    function runOtherAction(action) {
        runAction(action, OTHER_ACTIONS.find((item) => item.id === action));
    }

    function cognitionEnabled() {
        try {
            const settings = getSettings ? getSettings() : null;
            return !!(settings && settings.aiCognition === true);
        } catch (e) {
            return false;
        }
    }

    function showGitMenu() {
        if (!el.gitBtn || !showContextMenu) return;
        refreshGitEntry();
        if (!gitEntryState.available) {
            flash('当前工作区不在 Git 仓库内', true);
            return;
        }
        const items = GIT_ACTIONS.map((action) => ({
            label: action.label,
            icon: action.icon,
            action: () => runGitAction(action.id),
        }));
        // 「其他操作」分组：只在该组有可见项时显示标题（维护认知索引随开关显隐）。
        const others = OTHER_ACTIONS.filter((action) => !action.requiresCognition || cognitionEnabled());
        if (others.length) {
            items.push({sep: true});
            items.push({heading: '其他操作'});
            for (const action of others) {
                items.push({
                    label: action.label,
                    icon: action.icon,
                    action: () => runOtherAction(action.id),
                });
            }
        }
        const rect = el.gitBtn.getBoundingClientRect();
        showContextMenu(items, rect.left - 40, rect.bottom + 4);
    }
    return {refreshGitEntry, gitActionBlockedReason, runGitAction, showGitMenu};
}
