// orchestration-wiring.test.mjs：编排域的多点接线守护。
//
// 编排不是单个工具：应用页面 / 虚拟标签页 / 事件范围 / 派发宿主 / 工具定义 / 工具执行
// 任何一处漏接都是静默降级（页面空白、事件无人收、模型看不到工具），所以逐点对账。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {APP_PAGES, appPageOf} from '../../src/core/app-pages.js';
import {TAB_KINDS, tabKindByName} from '../../src/core/tab-kinds.js';
import {EVENT_SCOPES} from '../../src/core/event-scope.js';
import {AI_TOOL_CATALOG, AI_TOOL_DEFS, AI_TOOL_GROUPS} from '../../src/ai/tools/ai-tool-defs.js';
import {ICONS} from '../../src/core/icons.js';

const read = (rel) => readFileSync(new URL('../../src/' + rel, import.meta.url), 'utf8');

test('应用页面与独立标签页都注册编排，图标已注册', () => {
    const page = appPageOf('orchestration');
    assert.ok(page, 'APP_PAGES 缺 orchestration');
    assert.equal(page.icon, 'branch');
    assert.ok(ICONS[page.icon], '编排图标没注册');
    const kind = tabKindByName('orchestration');
    assert.ok(kind, 'TAB_KINDS 缺 orchestration');
    assert.equal(kind.marker, 'orchestration');
    assert.ok(ICONS[kind.icon]);
    const resolved = TAB_KINDS.find((k) => k.kind === 'orchestration').resolve({
        orchestrationSpec: {title: '我的编排'},
    });
    assert.equal(resolved.label, '我的编排');
});

test('六个编排事件都登记为 workspace 范围', () => {
    for (const name of [
        'orchestration-dispatch', 'orchestration-changed', 'orchestration-stop',
        'orchestration-arbiter-event', 'orchestration-arbiter-handoff', 'orchestration-audit',
    ]) {
        assert.equal(EVENT_SCOPES[name], 'workspace', name + ' 的事件范围必须按工作区隔离');
    }
});

test('main.js：常驻订阅、应用页面挂载器、桥视图工厂与 AI 适配器都接上', () => {
    const main = read('main.js');
    assert.match(main, /ensureOrchestrationHost\(\)\.subscribe\(appEvents/, '主组合根没有登记编排常驻订阅');
    assert.match(main, /'orchestration':\s*\(root,\s*workspace\)/, '应用页面挂载器缺 orchestration 或其工作区参数');
    assert.match(main, /openOrchestrationTab:\s*\(\.\.\.args\)/, 'AI 面板缺打开编排标签页的宿主出口');
    assert.match(main, /ensureOrchestrationHost\(\)/, '缺编排域懒创建入口');
    assert.match(main, /createOrchestrationView/, 'editor-groups 依赖没有接编排视图工厂');
    assert.match(main, /orchestration:\s*ensureOrchestrationHost\(\)\.adapter/, 'AI 面板没有注入 orchestration 适配器');
    assert.match(main, /ensureAI:\s*\(\)\s*=>/, '派发宿主需要能惰性初始化 AI 面板');
    const bridge = read('bridge/bridge-orchestration-view.js');
    assert.match(bridge, /marker:\s*'orchestration'\s*,\s*key/, '虚拟标签创建点必须成对传 marker + key');
    assert.match(bridge, /doc\.tabUnmount\s*=/, '编排标签页必须挂统一卸载契约');
});

test('四个编排工具定义、目录、分组与执行分支齐全', () => {
    const names = ['orchestration_plan', 'orchestration_report', 'orchestration_status', 'orchestration_control'];
    const groupKeys = new Set(AI_TOOL_GROUPS.map((g) => g.key));
    for (const name of names) {
        assert.ok(AI_TOOL_DEFS[name], name + ' 缺定义');
        assert.ok(AI_TOOL_CATALOG[name], name + ' 缺目录');
        assert.ok(groupKeys.has(AI_TOOL_CATALOG[name].group), name + ' 的目录组未注册');
    }
    assert.equal(AI_TOOL_CATALOG.orchestration_report.group, 'orchestration');
    const panel = read('ai/ai-panel.js');
    for (const name of names) {
        assert.match(panel, new RegExp("case '" + name + "'"), name + ' 缺执行分支');
    }
    const cards = read('ai/tools/ai-tool-cards.js');
    for (const name of names) {
        assert.match(cards, new RegExp("case '" + name + "'"), name + ' 缺工具卡元数据');
    }
});

test('Worker 工具裁剪与写闸都在宿主接线里，不靠 prompt', () => {
    const defs = read('ai/tools/ai-tool-defs.js');
    assert.match(defs, /orcRole === 'work' \|\| orcRole === 'review'/, '缺 Worker/审查者工具裁剪');
    assert.match(defs, /orchestration_report/, 'Worker 必须能拿到 report');
    const panel = read('ai/ai-panel.js');
    assert.match(panel, /orchestration\.authorizeWrite/, '受控写入前没有调用编排写闸');
    assert.match(panel, /orchestration\.onTurnStarted/, '起轮事实没有交给编排宿主');
    assert.match(panel, /orchestration\.onTurnFinished/, '回合结束事实没有交给编排宿主');
    const domain = read('orchestration/orchestration-ui.js');
    assert.match(domain, /OrchestrationTurnEvent/, '编排宿主没有把回合生命周期事实写入 Go');
});

test('审批卡回归：mock this / audit 阈值 / 提交中关闭 / 跨工作区根 / 停止竞态', () => {
    const domain = read('orchestration/orchestration-ui.js');
    assert.match(domain, /fn\.apply\(target, args\)/, '后端方法必须以 mock 对象为 this 调用');
    assert.match(domain, /computeAuditIdleMs\(/, '审批卡必须按逐批 timeout 重算审计阈值');
    assert.match(domain, /waitForSubmit/, '提交中关闭审批卡必须等创建落定再回报，避免误报未创建');
    assert.match(domain, /sessionWs \|\| windowWs/, '计划工作区必须优先取会话所属工作区');
    assert.match(domain, /workspace: \(o\.workspaces && o\.workspaces\[0\]\)/, '派发时必须显式绑定编排工作区');
    assert.match(domain, /d\.timeoutSec > 0[\s\S]{0,120}'wait'/, 'ask 不限时应转成 timeoutAction=wait');
    const panel = read('ai/ai-panel.js');
    assert.match(panel, /refreshProjections/, '磁盘重读后必须重放编排投影');
    assert.match(panel, /!toolHalted\(toolMessage\)/, '用户停止后不得再发回合恢复事实');
});

test('编排审批复用 composer 接管卡，首屏批次只留标题+描述，模型收进高级设置', () => {
    const domain = read('orchestration/orchestration-ui.js');
    const takeover = read('ai/chat/ai-takeover.js');
    assert.match(takeover, /renderOrchestrationTakeover/, '接管卡缺编排审批分支');
    assert.match(takeover, /orchestrationTakeoverCollapsed/, '编排审批卡必须可折叠');
    assert.match(domain, /bridgeRequestOrchestrationPlanApproval/, '审批必须走 composer 接管通道');
    assert.match(domain, /orch-batch-spec/, '批次描述必须以只读正文显示');
    assert.match(domain, /buildExecutionGraph\(/, '审批卡必须按 waves 画执行顺序图');
    assert.match(domain, /renderExecutionGraph\(/, '审批卡必须渲染 SVG 执行图');
    assert.match(domain, /orch-graph-card/, '执行顺序图必须是常驻卡片');
    assert.match(domain, /orch-board-dir-toggle/, '看板目录必须可折叠');
    assert.match(read('ai/session/ai-session-list.js'), /ai-session-orch-open/, '母会话行必须有打开编排入口');
    assert.match(domain, /batchSessionSuffix/, 'orchestration_status 必须输出子会话 id/运行态');
    assert.match(domain, /bridgeListSessions/, 'orchestration_status 必须从会话列表取运行态');
    assert.match(domain, /finalReview = finalReviewBox\.control/, '终审 checkbox 必须保存原生 control');
    assert.match(domain, /allowModels = allowModelsBox\.control/, '模型授权 checkbox 必须保存原生 control');
    const css = read('orchestration/orchestration.css');
    assert.match(css, /orch-batch-card\.expanded \.orch-batch-spec/, '展开描述必须命中批次卡 class');
    assert.doesNotMatch(css, /var\(--fg[,)]/, '深色主题没有 --fg，必须用 --text');
    assert.match(css, /\.orch-plan-advanced \.orch-advanced-summary\s*\{[^}]*background: transparent/,
        '高级设置不能铺整条面板色矩形');
    const graph = read('orchestration/orchestration-graph.js');
    assert.match(graph, /svg\.style\.width = layout\.width/, '执行图必须按原始宽度渲染，不能 width:100% 等比虚高');
    assert.match(graph, /Math\.max\(126,/, '单行图不能预留大块空白高度');
    assert.doesNotMatch(domain, /添加批次/, '计划结构不能由审批卡增删');
    assert.match(domain, /finalCountRow\.style\.display/, '终审数量必须在未勾选终审时隐藏');
    assert.match(domain, /roles?\s*=\s*'allowed'/, '模型选择必须收进高级设置');
    assert.match(domain, /继续编排/, '底部必须是继续编排而不是取消');
    assert.match(domain, /终审数量/, '高级设置缺终审数量');
    assert.match(domain, /留空 = 继承母会话/, '模型留空必须写明继承母会话');
    assert.match(domain, /isMultiWorkspace\(\)/, '多工作区派发必须跨当前聚焦根接收');
    assert.match(domain, /cancelFromHost/, '停止生成必须让在飞的创建请求收口');
    assert.match(read('ai/ai-panel.js'), /cancelFromHost/, 'AI 面板停止审批时要通知编排编辑器');
});

test('harness 跨根事件、看板旧回包与旧 attempt 归档都有防护', () => {
    const domain = read('orchestration/orchestration-ui.js');
    const subscribe = domain.slice(domain.indexOf('function subscribe('));
    assert.match(subscribe, /appEvents\.onApp\(eventName/, '六类编排事件都要跨当前聚焦根接收');
    assert.match(subscribe, /isMultiWorkspace\(\) && !acceptsWorkspace/, '非 harness 仍需按工作区过滤');
    assert.match(domain, /seq !== refreshSeq/, '看板重叠刷新必须只让最后一次回写');
    assert.match(domain, /b\.title \|\| '', b\.deadline/, '详情签名必须覆盖标题与剩余时间');
    assert.match(domain, /close\.setAttribute\('aria-label', '关闭'\)/, '弹窗关闭按钮必须有可用名称');
    const css = read('orchestration/orchestration.css');
    assert.match(css, /@container \(max-width: 1000px\)[\s\S]{0,500}flex-direction: row/,
        '窄宽度目录必须改成横向选择器，不能竖着堆在详情上方');
    assert.match(domain, /\]\.includes\(b\.status\)[\s\S]{0,80}formatElapsed/,
        '已完成批次不应残留“剩余：0s”');
    const panel = read('ai/ai-panel.js');
    assert.match(panel, /snapshotAttempt < sessionAttempt/, '旧 attempt 快照不能覆盖新投影');
    assert.match(panel, /sessionAttempt >= batchAttempt/, '旧快照不能归档当前 attempt');
});

test('仲裁者上下文使用量取最后一次 API 用量，不能累加整会话 token', () => {
    // 2026-11-28 实测：累加每条消息的 totalTokens 把历史每轮的输入输出重复计了多遍，
    // 227 条消息的会话算出 1207%，触发假的仲裁者交接、把编排甩给新会话。
    const panel = read('ai/ai-panel.js');
    const start = panel.indexOf('bridgeSessionUsage:');
    assert.ok(start > 0, '缺 bridgeSessionUsage');
    const next = panel.indexOf('bridgeNewSession:', start);
    const body = panel.slice(start, next > 0 ? next : start + 2000);
    assert.doesNotMatch(body, /used \+=/, '不能累加 token：会把历史每轮重复计入，算出 >100% 的假占用');
    assert.match(body, /messages\.length - 1/, '必须从最后一条往前找最近一次 usage');
    assert.match(body, /promptTokens/, '取 prompt+completion 才是当前上下文窗口占用的近似');
    assert.match(body, /contextWindow/, '窗口必须取模型条目/账号的 contextWindow');
});
