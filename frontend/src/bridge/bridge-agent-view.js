// bridge-agent-view.js：子代理详情在内容区的标签页（对齐后台终端标签页的先例）。
// 本模块只负责「建标签页 + 提供容器 + 关标签时卸载」；正文渲染归 AI 面板
// （ai-subagents.js 的 mountAgentView）——子代理的运行态、收件箱与插话输入行都在面板闭包里。
import {createVirtualTabDoc} from '../core/virtual-tab-doc.js';

export function createBridgeAgentView(deps) {

const AGENT_VIEW_MAX = 8;

// 标题主体（不含状态前缀）：超 20 字截断。状态前缀经 deps.aiPanel.bridgeAgentViewTabName 叠加
// （bridge 域不 import ai 域，纯函数经桥方法注入，与 bridgeMountAgentView 同款模式）。
function agentTabName(name) {
    const line = String(name || '子代理').replace(/\s+/g, ' ').trim() || '子代理';
    return line.length > 20 ? line.slice(0, 20) + '…' : line;
}

function tabNameWithState(name, state) {
    const base = agentTabName(name);
    const withState = deps.aiPanel && deps.aiPanel.bridgeAgentViewTabName
        ? deps.aiPanel.bridgeAgentViewTabName(base, state)
        : base;
    return withState;
}

// 视图键：优先 subId（运行态/终态记录都以它为主键），退回派单时的注册表 key。
function agentViewKey(spec) {
    return String((spec && (spec.subId || spec.toolCallId)) || '');
}

function openAgentTab(spec) {
    const key = agentViewKey(spec);
    if (!key) return null;
    const existing = deps.docs.find((d) => d.agentView === key);
    if (existing) {
        deps.activateDoc(existing);
        return existing;
    }
    // 标签页不会自己回收：同一批派单连点会堆一排，只保留最近 8 个子代理视图
    const opened = deps.docs.filter((d) => d.agentView);
    while (opened.length >= AGENT_VIEW_MAX) {
        const oldest = opened.shift();
        if (oldest) deps.closeDocNow(oldest, false);
    }
    const doc = createVirtualTabDoc({
        id: 'agentview-' + key,
        name: agentTabName(spec && spec.name),
        format: {id: 'agentview', name: '子代理', extensions: [], aceMode: 'text', rawOnly: true},
        mode: 'agentview',
        marker: 'agentView',
        key,
        extra: {
            agentViewSpec: {
                toolCallId: String((spec && spec.toolCallId) || ''),
                subId: String((spec && spec.subId) || ''),
                name: String((spec && spec.name) || '子代理'),
                // 详情所在的会话（头部状态兜底用它精确补正文，不扫全部会话）
                sessionId: String((spec && spec.sessionId) || ''),
                // 父级信息（openAgentView 算好传进来）：标签页 tooltip 与详情头部面包屑共用
                parentLabel: String((spec && spec.parentLabel) || ''),
                depth: Number((spec && spec.depth) || 0) || 0,
                task: String((spec && spec.task) || ''),
                // 磁盘转录补读要用的两个 id：落盘分桶用根会话（artifactDir），父会话 id 做回落。
                // 漏掉任何一个，重启后「补读转录」在标签页路径上就永远不会发生。
                parentSessionId: String((spec && spec.parentSessionId) || ''),
                agentArtifactDir: String((spec && spec.agentArtifactDir) || ''),
            },
        },
    });
    deps.docs.push(doc);
    deps.addDocToFocusedGroup(doc);
    deps.activateDoc(doc);
    return doc;
}

function createAgentView(doc) {
    const pane = document.createElement('div');
    pane.className = 'jsoneditor-pane active agentview-pane';
    deps.els.editor.appendChild(pane);
    const root = document.createElement('div');
    root.className = 'agentview-root';
    pane.appendChild(root);
    doc.pane = pane;
    doc.agentViewRoot = root;

    const mounted = deps.aiPanel && deps.aiPanel.bridgeMountAgentView
        ? deps.aiPanel.bridgeMountAgentView(root, doc.agentViewSpec)
        : null;
    if (!mounted) {
        root.textContent = doc.agentViewSpec && doc.agentViewSpec.subId
            ? '这个子代理的记录已不在本运行期（应用重启后只保留状态与结论），无法再展开视图。'
            : '子代理视图不可用：AI 面板尚未就绪。';
        root.classList.add('empty');
        return;
    }
    // 运行态标题/tooltip 同步（仿后台终端的「快照 + 订阅 + 卸载」范式）。
    // 通知不带 key（运行态用 sub.key、标签存 subId，两者口径不同），收到后各自读自己的快照；
    // 用 name/runtime 比对守卫避免每次状态事件都 renderTabs 整段重建标签栏。
    let titleTimer = 0;
    const syncAgentTitle = () => {
        if (!doc.pane || !doc.pane.isConnected) return;
        const ai = deps.aiPanel;
        if (!ai || !ai.bridgeAgentViewSnapshot) return;
        const snap = ai.bridgeAgentViewSnapshot(doc.agentView || doc.agentViewSpec.subId || doc.agentViewSpec.toolCallId);
        const name = tabNameWithState(doc.agentViewSpec.name, snap && snap.state);
        const runtime = snap && ai.bridgeAgentViewRuntimeText ? ai.bridgeAgentViewRuntimeText(snap) : '';
        let changed = false;
        if (name && name !== doc.name) { doc.name = name; changed = true; }
        if (runtime !== (doc.agentViewSpec.runtimeText || '')) { doc.agentViewSpec.runtimeText = runtime; changed = true; }
        if (changed && typeof deps.renderTabs === 'function') deps.renderTabs();
    };
    // 节流：状态事件密集（流式期间每轮多次），合并到 300ms 一次
    const scheduleSyncTitle = () => {
        if (titleTimer) return;
        titleTimer = setTimeout(() => { titleTimer = 0; syncAgentTitle(); }, 300);
    };
    let unsubAgent = null;
    if (deps.aiPanel && deps.aiPanel.bridgeOnAgentViewUpdate) {
        unsubAgent = deps.aiPanel.bridgeOnAgentViewUpdate(scheduleSyncTitle);
    }
    syncAgentTitle();

    // 卸载契约：先退订 + 清定时器，再卸载正文视图，最后清空 doc.tabUnmount（避免重复调用）
    doc.tabUnmount = () => {
        if (titleTimer) { clearTimeout(titleTimer); titleTimer = 0; }
        if (typeof unsubAgent === 'function') unsubAgent();
        unsubAgent = null;
        if (deps.aiPanel && deps.aiPanel.bridgeUnmountAgentView) deps.aiPanel.bridgeUnmountAgentView(root);
        doc.tabUnmount = null;
    };
}

return {createAgentView, openAgentTab};
}
