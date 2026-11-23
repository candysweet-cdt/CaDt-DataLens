// ai-turn-steer 接线护栏：源码级的插话（steer）/ 抢占（preempt）合同。
// 这些行为无法在 node 里跑（依赖 Wails 后端与 DOM），只能锁住接线点与文案：
// 方案见 docs/finished-plans/ai-turn-steering.md §6.2。改实现时同步改这里。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createAIMessageQueue} from '../../src/ai/chat/ai-message-queue.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const composer = read('../../src/ai/chat/ai-composer.js');
const queue = read('../../src/ai/chat/ai-message-queue.js');
const panel = read('../../src/ai/ai-panel.js');
const store = read('../../src/ai/session/ai-session-store.js');
const usage = read('../../src/ai/usage/ai-usage-ui.js');
const outline = read('../../src/ai/session/session-outline.js');

function sliceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.notEqual(start, -1, '找不到起点：' + startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(end, -1, '找不到终点：' + endMarker);
    return source.slice(start, end);
}

function sliceFunction(source, marker) {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, '找不到函数：' + marker);
    const end = source.indexOf('\n    function ', start + marker.length);
    return source.slice(start, end < 0 ? undefined : end);
}

// el.queue 为空时 DOM 壳的渲染直接 return，不需要真 DOM
const makeShell = () => createAIMessageQueue({el: {}});

test('生成中手势：Enter 排队 / Ctrl+Enter 插话 / Ctrl+Shift+Enter 抢占 / Shift+Enter 换行', () => {
    const handler = sliceBetween(composer, 'function handleComposerKey(e) {', 'function currentQueueItems()');
    const branchStart = handler.indexOf('if (syncStreamView() || compactOf(');
    assert.notEqual(branchStart, -1, '找不到生成中分支');
    const branch = handler.slice(branchStart);
    assert.match(branch, /if \(!ctrl && e\.shiftKey\) return;/);
    // Shift+Enter 必须在 preventDefault 之前 return，否则换行被吃掉
    assert.ok(branch.indexOf('if (!ctrl && e.shiftKey) return;') < branch.indexOf('e.preventDefault();'));
    assert.match(branch, /if \(ctrl && e\.shiftKey\) \{\s*preemptComposerMessage\(\);/);
    assert.match(branch, /else if \(ctrl\) \{\s*interjectComposerMessage\(\);/);
    assert.match(branch, /else \{\s*enqueueComposerMessage\(\);/);
});

test('点击发送：Ctrl+点击 = 插话，Ctrl+Shift+点击 = 抢占', () => {
    // Ctrl 分流已收口到 sendComposerMessage（submitFromComposer 与斜杠技能调用共用）
    const send = sliceFunction(composer, 'function sendComposerMessage(text, ev) {');
    assert.match(send, /if \(ctrl && ev\.shiftKey\) \{\s*preemptComposerMessage\(\{plain: true\}\);/);
    assert.match(send, /else if \(ctrl\) \{\s*interjectComposerMessage\(\{plain: true\}\);/);
    // 斜杠命令仍从 submitFromComposer 短路进 handleSlashText
    const submit = sliceFunction(composer, 'function submitFromComposer(ev) {');
    assert.match(submit, /handleSlashText\(trimmed\)/);
});

test('斜杠技能调用排队走 plain 旁路：/ 开头的待发消息不再转回 handleSlashText', () => {
    for (const fn of ['function enqueueComposerMessage(opts) {', 'function interjectComposerMessage(opts) {',
        'function preemptComposerMessage(opts) {']) {
        const body = sliceFunction(queue, fn);
        assert.match(body, /!\(opts && opts\.plain\) && text\.startsWith\('\/'\)/, fn + ' 缺少 plain 旁路');
    }
    const send = sliceFunction(composer, 'function sendComposerMessage(text, ev) {');
    assert.match(send, /enqueueComposerMessage\(\{plain: true\}\)/);
});

test('interjectComposerMessage：只入队 delivery:steer，不再停当前轮', () => {
    const interject = sliceBetween(queue, 'function interjectComposerMessage(opts) {', 'function preemptComposerMessage(opts) {');
    assert.match(interject, /delivery: 'steer'/);
    assert.equal(interject.includes('stopGeneration()'), false, '插话不得停掉当前轮');
    // 不可 steer 的附件（文件 / 技能 / 选区）降级排队；引用 kind 走 ai-quote.js 单一来源
    assert.match(interject, /att\.kind !== 'image' && att\.kind !== 'video' && att\.kind !== AI_QUOTE_KIND/);
    // 正常插话路径不碰抢占的待发标记：interjectPending 只出现在「停止收尾窗口」的降级分支
    const fallback = interject.indexOf('if (!live) {');
    assert.notEqual(fallback, -1, '缺少停止 / 收尾窗口的降级分支');
    assert.ok(interject.indexOf('interjectPending.add') > fallback);
});

test('停止 / 收尾窗口：steer 降级为排队，避免被 clearSteer 静默丢弃', () => {
    const interject = sliceBetween(queue, 'function interjectComposerMessage(opts) {', 'function preemptComposerMessage(opts) {');
    assert.match(interject, /liveSteerableStream\(session\.id\)/);
    assert.match(interject, /当前轮已停止，消息将在收尾后发送/);
    const row = sliceBetween(queue, 'const interject = document.createElement', 'const remove = document.createElement');
    assert.match(row, /liveSteerableStream\(item\.sessionId\)/);
    assert.match(row, /当前轮正在停止，消息将随后发送/);
    const preempt = sliceBetween(queue, 'function preemptComposerMessage(opts) {', 'async function flushMessageQueue');
    assert.match(preempt, /liveSteerableStream\(session\.id\)/);
    // 已停止的流不再重复 stopGeneration（避免叠 1.2s 兜底定时器）
    assert.ok(preempt.indexOf('if (!liveSteerableStream(session.id))') < preempt.indexOf('stopGeneration()'));
});

test('视频插话与正常发送同一条协议门禁', () => {
    const interject = sliceBetween(queue, 'function interjectComposerMessage(opts) {', 'function preemptComposerMessage(opts) {');
    assert.match(interject, /hasVideo && !videoSteerAllowed\(session\)/);
    assert.match(panel, /videoSteerAllowed: \(session\) => modelVideoInputEnabled\(profileOf\(session\), entryOf\(session\)\)/);
});

test('preemptComposerMessage：停轮 + 队首 + 抢占待发标记 + 保留其它 steer', () => {
    const preempt = sliceFunction(queue, 'function preemptComposerMessage(opts) {');
    assert.match(preempt, /model\.enqueueFront\(payload\)/);
    assert.match(preempt, /interjectPending\.add\(session\.id\)/);
    assert.match(preempt, /stopGeneration\(\)/);
    // 抢占前先把其它 steer 降级为 queue，避免被 stopGeneration / finishStream 的
    // clearSteer 连带丢弃（2026-11-22 实测：两条插话抢占一条后另一条消失）
    assert.match(preempt, /model\.fallbackSteerToQueue\(session\.id\)/);
    // plan 模式抢占：待批准的计划卡收起让路（2026-11-22 实测：卡在显示时队列冲刷被静默拦下）
    assert.match(preempt, /dismissPendingPlanCard\(session\)/);
});

test('wait_agent 唤醒语义：排队不打扰等待，只有 steer 唤醒并带来源', () => {
    // 方案 docs/finished-plans/ai-wait-input-gestures.md：排队消息按排队语义本轮结束后送达，
    // 唤醒只会让等待白醒一轮（注入仍只在轮边界，wait 拿不到排队消息内容）。
    const onChange = sliceBetween(queue, 'const model = createQueueModel({', '});');
    assert.match(onChange, /item\.delivery === 'steer'/, '只有 steer 车道唤醒');
    assert.match(onChange, /notify\(item\.sessionId, 'steer'\)/, '唤醒要带来源');
    // 排队入队路径（Enter）不得出现 notify
    const enqueue = sliceFunction(queue, 'function enqueueComposerMessage(opts) {');
    assert.equal(enqueue.includes('notify'), false, '排队不打扰等待');
    // 停止收尾窗口内排队也要登记待冲刷：shouldFlush 只认 interjectPending
    assert.match(enqueue, /!liveSteerableStream\(session\.id\)\) interjectPending\.add\(session\.id\)/);
});

test('flushMessageQueue：起轮失败自动重试一次（瞬态失败自愈，不无限打转）', () => {
    // 重试逻辑收在 scheduleFlushRetry（两条发送路径共用），fromRetry 是防无限打转的标记
    const retry = sliceFunction(queue, 'function scheduleFlushRetry(sessionId, opts) {');
    assert.match(retry, /opts && opts\.fromRetry/, '重试那次调用必须带标记');
    assert.match(retry, /setTimeout\(\(\) => \{ flushMessageQueue\(sessionId, \{fromRetry: true\}\); \}, 2500\)/);
    const ui = sliceFunction(queue, 'async function flushThroughComposer(session, item, opts) {');
    assert.match(ui, /scheduleFlushRetry\(session\.id, opts\)/, '当前会话失败要排重试');
    const bg = sliceFunction(queue, 'async function flushInBackground(session, item, opts) {');
    assert.match(bg, /scheduleFlushRetry\(session\.id, opts\)/, '后台会话失败也要排重试');
    // 后台会话必须真的走内核起轮，不能退回「不是当前会话就 return」的旧死路
    assert.match(bg, /startSessionTurn\(session, text, \{/);
    assert.match(bg, /allowPendingEdit: false/);
    assert.match(bg, /truncateAt: null/);
});

test('队列行按钮：按 delivery 切换插话 / 排队，改投是同步 setDelivery', () => {
    assert.match(queue, /model\.setDelivery\(item, 'steer'\)/);
    assert.match(queue, /model\.setDelivery\(item, 'queue'\)/);
    assert.match(queue, /steering \? '排队' : '插话'/);
    assert.match(queue, /streams\.has\(item\.sessionId\)/);
});

test('takeQueuedItem：计划审批卡「正显示」才拦队列，收起后与手动发送同口径放行', () => {
    // 2026-11-22 实测：pending 计划曾把队列冲刷永远钉住（plan 模式抢占消息停在排队框）
    const guard = sliceFunction(queue, 'function takeQueuedItem(sessionId) {');
    assert.match(guard, /getDismissedPlanApproval\(\) !== planApprovalKey\(session, pendingPlan\)/);
    // 待回答（ask 卡）仍然无条件拦：它必须被回答或取消，没有「收起」语义
    assert.match(guard, /currentPendingAskEntry\(sessionId\)/);
});

test('队列行提供点击抢占（⚡ 图标，仅当前轮活着时显示）', () => {
    const row = sliceBetween(queue, 'const interject = document.createElement', 'const remove = document.createElement');
    assert.match(row, /iconSvg\('zap'/);
    assert.match(row, /preemptQueuedItem\(item\)/);
    assert.match(row, /抢占：停止当前回复并立即发送这条消息/);
    const preemptItem = sliceBetween(queue, 'function preemptQueuedItem(item) {', 'async function flushMessageQueue');
    assert.match(preemptItem, /model\.setDelivery\(item, 'queue'\)/);
    assert.match(preemptItem, /interjectPending\.add\(sessionId\)/);
    assert.match(preemptItem, /stopGeneration\(\)/);
    // 抢占前降级其它 steer 保留，避免被 clearSteer 连带丢弃（2026-11-22 bug）
    assert.match(preemptItem, /model\.fallbackSteerToQueue\(sessionId\)/);
    // 同款计划卡收起（队列行抢占走的是 sessionOf 查询，输入区手势走 currentSession）
    assert.match(preemptItem, /dismissPendingPlanCard\(sessionOf\(sessionId\)\)/);
});

test('队列行拖动排序：3×3 点阵手柄 + 标签页式让位插槽', () => {
    const row = sliceBetween(queue, "const handle = document.createElement('span')", 'const steering = item.delivery');
    assert.match(row, /iconSvg\('grip'/);
    assert.match(row, /handle\.draggable = true/);
    assert.match(row, /draggingQueueId = item\.id/);
    // 让位插槽（margin 过渡），不是描边 / 插入线
    assert.match(row, /clearQueueDropGaps\(\)/);
    assert.match(row, /drop-gap-before/);
    assert.match(row, /drop-gap-after/);
    assert.match(row, /reorderQueueItem\(draggedId, row\.dataset\.queueId, !before\)/);
    const reorder = sliceBetween(queue, 'function reorderQueueItem(draggedId, targetId, after) {', 'function renderMessageQueue() {');
    assert.match(reorder, /model\.reorderSession\(session\.id, ids\)/);
    assert.match(queue, /reorderSession: \(sessionId, ids\) => model\.reorderSession\(sessionId, ids\)/);
    // 手柄必须在行首（最左边）
    assert.match(queue, /row\.append\(handle, badge, text, edit, interject, preempt, remove\)/);
    // 视觉契约：插槽是 margin，不是 border / box-shadow 线
    const css = read('../../src/style.css');
    assert.match(css, /\.ai-queue-row\.drop-gap-before \{ margin-top: 26px; \}/);
    assert.match(css, /\.ai-queue-row\.drop-gap-after \{ margin-bottom: 26px; \}/);
    assert.equal(/\.ai-queue-row\.drop-before\b/.test(css), false);
});

test('startRound：第 2 次及以后请求前 drain，且先落盘再组装请求', () => {
    const startRound = sliceFunction(panel, 'function startRound(target) {');
    assert.match(startRound, /s\.roundNo > 1 && queueMod\.hasSteer\(s\.sessionId\)/);
    assert.match(startRound, /queueMod\.drainSteer\(s\.sessionId\)/);
    assert.match(startRound, /steer: true/);
    assert.ok(startRound.indexOf('queueMod.drainSteer') < startRound.indexOf('buildApiMessages(session, index'));
    // drain / 回滚后队列行要重绘（否则残留幽灵「插话」行）
    assert.match(startRound, /queueMod\.renderMessageQueue\(\)/);
    // 预算超 90% 回滚为排队
    assert.match(startRound, /queueMod\.restoreItems\(drainedSteer, 'queue'\)/);
    // 纯附件插话也要有正文，模板才不会被跳过
    assert.match(startRound, /body = '（附图）'/);
});

test('buildApiMessages：steer 消息只在请求里包 user_steer 模板', () => {
    assert.match(panel, /import \{createAIMessageQueue, formatSteerMessage\} from '\.\/chat\/ai-message-queue\.js';/);
    const build = sliceFunction(panel, 'function buildApiMessages(session, endIndex, systemText) {');
    assert.match(build, /message\.role === 'user' && message\.steer/);
    assert.match(build, /content = formatSteerMessage\(content\)/);
});

test('重放 / 懒加载：normalizeMessage 保留 steer 标记', () => {
    const normalize = sliceBetween(panel, 'function normalizeMessage(raw) {', "if (role === 'tool') {");
    assert.match(normalize, /if \(raw\.steer === true\) message\.steer = true;/);
});

test('steer 不进轮次口径：lastUserIndex / 回合边界 / 统计', () => {
    const lastUser = sliceFunction(panel, 'function lastUserIndex(session) {');
    // 轮次口径收敛到单一判据：lastUserIndex 直接复用 isTurnBoundaryMessage（steer 在那边排除）
    assert.match(lastUser, /if \(isTurnBoundaryMessage\(session\.messages\[i\]\)\) return i;/);
    const boundary = sliceBetween(store, 'export function isTurnBoundaryMessage(message) {', '// 轮次起点：最后一条边界消息的时间');
    assert.match(boundary, /if \(message\.steer\) return false;/);
    // 统计口径也走同一判据（steer 在 isTurnBoundaryMessage 里排除，这里不能再各写一份）
    assert.match(usage, /if \(isTurnBoundaryMessage\(message\)\) rounds\+\+;/);
});

test('插话可见性：结构面板列出插话（同轮号 + 标记），回合折叠不藏用户插话', () => {
    // 结构面板：steer 项带 steer: true、不占新轮号
    assert.match(outline, /const steer = message\.steer === true;/);
    assert.match(outline, /if \(!steer\) round \+= 1;/);
    assert.match(outline, /steer,/);
    assert.match(outline, /so-steer-tag/);
    // 回合折叠：插话切成独立段，整条渲染在折叠区外
    const turn = sliceBetween(panel, 'function renderTurn(group, session, isLastGroup, parent, extraOptions) {', '// 看板娘文案池与轮换索引见 ai-mascot-phrases.js');
    assert.match(turn, /if \(item\.message\.steer\) \{/);
    assert.match(turn, /segments\.push\(\{steer: item\}\)/);
    assert.match(turn, /if \(seg\.steer\) \{/);
    assert.match(turn, /renderMessage\(seg\.steer\.message, seg\.steer\.index, session, host, turnOptions\)/);
    assert.match(turn, /!seg\.steer &&/);
});

test('ai-done：stop + pending steer 时新建 assistant 续轮，不复用已完成消息', () => {
    const done = sliceBetween(panel, "case 'ai-done': {", "case 'ai-error':");
    const branchStart = done.indexOf('queueMod.hasSteer(current.sessionId)');
    assert.notEqual(branchStart, -1, 'ai-done 缺少 pending steer 续轮分支');
    const startRoundAt = done.indexOf('startRound(current);', branchStart);
    assert.notEqual(startRoundAt, -1, '续轮分支必须调用 startRound');
    const branch = done.slice(branchStart, startRoundAt);
    assert.match(branch, /newAssistantMessage\(profileOf\(session\), entryOf\(session\)\)/);
    assert.match(branch, /current\.assistant = assistant;/);
    // 用户已停止的流不许被续轮复活
    assert.match(done, /!current\.stopped && payload\.finishReason === 'stop'/);
});

test('finishStream / stopGeneration：自然结束降级排队，停止或抢占丢弃 steer', () => {
    const finish = sliceFunction(panel, 'function finishStream(target) {');
    assert.match(finish, /if \(current\.stopped\) queueMod\.clearSteer\(current\.sessionId\);/);
    assert.match(finish, /else queueMod\.fallbackSteerToQueue\(current\.sessionId\);/);
    assert.ok(finish.indexOf('queueMod.clearSteer') < finish.indexOf('const shouldFlush'));
    // 自然结束（模型没被停止）必须有冲刷：降级来的插话靠这一行发出；只认 hasInterject
    // 会让「模型直接停止、插话没赶上本轮」的在后台会话里永远躺在队列（2026-11-19 实测场景）
    assert.match(finish, /const shouldFlush = queueMod\.hasInterject\(current\.sessionId\) \|\| \(!current\.stopped && current\.assistant\.status === 'done'\);/);
    assert.ok(finish.indexOf('const shouldFlush') < finish.indexOf('flushMessageQueue(session.id)'),
        '冲刷必须在 shouldFlush 判定之后');
    // plan 模式抢占：冲刷前收起待批准的计划卡，否则 takeQueuedItem 静默拦下、
    // 消息永远停在排队框（2026-11-22 实测）。只对停止 / 抢占收尾生效，自然结束不收卡。
    assert.match(finish, /if \(shouldFlush && current\.stopped && session\) \{/);
    assert.match(finish, /dismissedPlanApproval = planKey;/);

    const stop = sliceFunction(panel, 'function stopGeneration(target, byUser) {');
    assert.match(stop, /queueMod\.clearSteer\(sessionId\)/);
    assert.ok(stop.indexOf('queueMod.clearSteer') < stop.indexOf('stopSubAgentsOf'));
});

test('输入区提示：按键说明只在 placeholder / tooltip，hint 不重复', () => {
    // hint（生成中状态行、排队条数行）不再显示按键提示：手势说明已在 placeholder 与发送按钮 tooltip 给出
    const render = sliceBetween(queue, 'function renderMessageQueue() {', 'function enqueueComposerMessage(opts) {');
    assert.doesNotMatch(render, /Enter 排队|Ctrl\+Enter 插话|Ctrl\+Shift\+Enter 抢占/);
    assert.match(render, /el\.hint\.textContent = '生成中'/);
    const streaming = sliceBetween(panel, 'function setStreamingUI() {', 'function updateSendState() {');
    // 只看 hint 赋值部分（placeholder 的调用之后），确认 hint 本身不带按键提示
    const hintPart = streaming.slice(streaming.indexOf('updateSendState();'));
    assert.doesNotMatch(hintPart, /Enter 排队|Ctrl\+Enter 插话|Ctrl\+Shift\+Enter 抢占/);
    assert.match(streaming, /正在压缩上下文：消息将排队/); // placeholder 仍保留手势
    // 发送按钮 tooltip：生成中且有内容时显示三行简洁文案
    const sendBtn = sliceBetween(panel, 'function syncSendStopButtons(busy) {', 'function setStreamingUI() {');
    assert.match(sendBtn, /发送消息 Enter\\n插话 Ctrl \+ Enter\\n抢占 Ctrl \+ Shift \+ Enter/);
});

test('formatSteerMessage：文案合同（while you were working / mid-turn）', () => {
    assert.match(queue, /The user sent a new message while you were working/);
    assert.match(queue, /This is a mid-turn message/);
});

test('上下文弹层「压缩上下文」按钮：会话运行中禁用（与 startCompact 门禁同源）', () => {
    const sync = sliceFunction(panel, 'function syncCtxCompactButton() {');
    // 门禁口径与 startCompact 的 anyStreaming() / oneShot 一致
    assert.match(sync, /anyStreaming\(\) \|\| !!oneShot/);
    assert.match(sync, /el\.ctxPopCompact\.disabled = busy/);
    assert.match(sync, /el\.ctxPopCompact\.dataset\.tip = '请先停止当前生成，再压缩上下文'/);
    // 流开始/结束（setStreamingUI）与弹层打开（paintCtxPop）两处都要同步，覆盖弹层开着时别的会话起轮
    const streaming = sliceFunction(panel, 'function setStreamingUI() {');
    assert.match(streaming, /syncCtxCompactButton\(\)/);
    const paint = sliceFunction(panel, 'function paintCtxPop(session, systemText) {');
    assert.match(paint, /syncCtxCompactButton\(\)/);
    // 视觉：禁用态压暗（.dlg-btn:disabled 只改 cursor，看不出来）
    const css = read('../../src/style.css');
    assert.match(css, /\.ai-ctx-compact:disabled \{ opacity: \.45; \}/);
});

test('接线：composer 拿到 preempt，队列壳导出 steer 车道与手势 API', () => {
    assert.match(panel, /preemptComposerMessage: \(\.\.\.args\) => queueMod\.preemptComposerMessage\(\.\.\.args\)/);
    const shell = makeShell();
    for (const api of ['preemptComposerMessage', 'preemptQueuedItem', 'interjectComposerMessage', 'enqueueComposerMessage',
        'hasSteer', 'drainSteer', 'restoreItems', 'setDelivery', 'reorderSession', 'fallbackSteerToQueue', 'clearSteer', 'snapshot']) {
        assert.equal(typeof shell[api], 'function', '队列壳缺少导出：' + api);
    }
    // 纯模型现在接受可选的 {onChange}（steer 入队即唤醒 wait_agent 的调用方），签名不再是无参
    assert.match(queue, /export function createQueueModel\(options\)/);
    // 引用 kind 的单一来源（对话引用前缀也从同一模块取，队列与手动发送一条口径）
    assert.match(queue, /import \{AI_QUOTE_KIND, quoteMarkupFromAttachments\} from '\.\/ai-quote\.js';/);
});
