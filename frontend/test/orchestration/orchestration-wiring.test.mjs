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
    assert.match(main, /'orchestration':\s*\(root\)/, '应用页面挂载器缺 orchestration');
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

test('审查修复回归：mock this / audit 阈值 / 提交关闭 / 跨工作区根 / 停止竞态', () => {
    const domain = read('orchestration/orchestration-ui.js');
    assert.match(domain, /fn\.apply\(target, args\)/, '后端方法必须以 mock 对象为 this 调用');
    assert.match(domain, /computeAuditIdleMs\(/, '审批卡必须按逐批 timeout 重算审计阈值');
    assert.match(domain, /dismissedWhileSubmitting/, '提交中关闭审批卡不能误报未创建');
    assert.match(domain, /sessionWs \|\| windowWs/, '计划工作区必须优先取会话所属工作区');
    assert.match(domain, /workspace: \(o\.workspaces && o\.workspaces\[0\]\)/, '派发时必须显式绑定编排工作区');
    assert.match(domain, /d\.timeoutSec > 0[\s\S]{0,120}'wait'/, 'ask 不限时应转成 timeoutAction=wait');
    const panel = read('ai/ai-panel.js');
    assert.match(panel, /refreshProjections/, '磁盘重读后必须重放编排投影');
    assert.match(panel, /!toolHalted\(toolMessage\)/, '用户停止后不得再发回合恢复事实');
});
