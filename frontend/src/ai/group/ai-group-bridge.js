// ai-group-bridge.js：面板内容视图（会话 ↔ 群聊）的挂载/卸载与切换。
// 从 ai-panel.js 拆出（phase4 P3），5 个视图状态与 4 个函数整包搬移；
// onViewChange/mountGroupChatView 经 getter 活引用，panel/el/open/flash 经 deps 直接注入（稳定引用）。

export function createAIGroupBridge(deps) {
    // 面板的内容视图只有两种：session（现有对话）/ group（群聊接管）。
    // 显示形态（dock/fullscreen）归 applyMode 管，这里只管「显示哪套内容」。
    // 群讨论/自由聊天都跑在 aiGroupRuntime 里，切回会话视图只是卸载 DOM，不停成员发言。
    let panelView = 'session';
    let panelGroupSpec = null; // {groupId, title}
    let groupViewApi = null;   // mountGroupChatView 返回的 {dispose, focus}
    let groupViewRelease = null;
    let groupViewFocus = null;

    function applyPanelViewDom() {
        const group = panelView === 'group';
        deps.panel.classList.toggle('ai-group-mode', group);
        if (deps.el.groupHost) deps.el.groupHost.classList.toggle('hidden', !group);
        // 面板头标题随视图切换：会话视图固定「AI 助手」，群聊视图显示群名
        if (deps.el.headTitle) deps.el.headTitle.textContent = group ? ((panelGroupSpec && panelGroupSpec.title) || '群聊') : 'AI 助手';
    }

    function notifyPanelView() {
        if (!deps.onViewChange) return;
        try {
            deps.onViewChange(panelView, panelView === 'group' && panelGroupSpec ? panelGroupSpec.groupId : '');
        } catch (e) { /* 宿主高亮失败不影响视图切换 */ }
    }

    function releaseGroupView() {
        if (groupViewRelease) {
            try { groupViewRelease(); } catch (e) { /* 卸载失败不阻断切换 */ }
        }
        groupViewRelease = null;
        groupViewApi = null;
        groupViewFocus = null;
        if (deps.el.groupHost) deps.el.groupHost.textContent = '';
    }

    // 入口：bridgeShowGroupView（侧栏群行 / 更多菜单 / 群切换弹层 / AI 代建群）与
    // bridgeShowSessionView（switchSession / newSession）。返回是否切换成功。
    function setPanelView(next, spec) {
        if (next === 'group') {
            if (!deps.mountGroupChatView || !deps.el.groupHost) {
                deps.flash('群聊视图不可用（宿主未就绪）', true);
                return false;
            }
            const nextSpec = {
                groupId: String((spec && spec.groupId) || ''),
                title: String((spec && spec.title) || ''),
            };
            if (!nextSpec.groupId) return false;
            // 同群重复打开：不重建视图，只确保面板可见
            if (panelView === 'group' && panelGroupSpec && panelGroupSpec.groupId === nextSpec.groupId && groupViewApi) {
                deps.open(true);
                return true;
            }
            releaseGroupView();
            panelView = 'group';
            panelGroupSpec = nextSpec;
            applyPanelViewDom();
            const api = deps.mountGroupChatView(nextSpec, deps.el.groupHost) || null;
            groupViewApi = api;
            groupViewRelease = api && typeof api.dispose === 'function' ? api.dispose : null;
            groupViewFocus = api && typeof api.focus === 'function' ? () => groupViewApi && groupViewApi.focus() : null;
            deps.open(true);
            notifyPanelView();
            return true;
        }
        releaseGroupView();
        panelView = 'session';
        panelGroupSpec = null;
        applyPanelViewDom();
        notifyPanelView();
        return true;
    }

    return {
        setPanelView,
        releaseGroupView,
        getPanelView: () => panelView,
        getBridgePanelView: () => ({
            view: panelView,
            groupId: panelView === 'group' && panelGroupSpec ? panelGroupSpec.groupId : '',
        }),
        getGroupViewFocus: () => groupViewFocus,
    };
}
