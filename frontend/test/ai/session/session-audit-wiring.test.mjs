// 会话审计事件的接线护栏（S5 / S6 切片）。
//
// 这些行为依赖真实 Wails 后端与磁盘，单测跑不到；按仓库惯例用源码切片锁住接线点
// （同 ai-tool-wiring / ai-inline-edit-wiring）。断言的不是实现细节，而是三条契约：
//   1. 回合首轮写 turn/start，收尾写 turn/close（否则 interruptedTurnIds 全空，崩溃无法识别）；
//   2. 载入时对未闭合回合补 reason=crash（否则崩溃永远只表现为「消息还在 running」）；
//   3. 子代理 spawn / 终态各写一条 agent 事件（否则编排记录在重启后彻底消失）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const panel = read('../../../src/ai/ai-panel.js');
const subagents = read('../../../src/ai/agent/ai-subagents.js');
const disk = read('../../../src/ai/session/ai-session-disk.js');

function sliceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.notEqual(start, -1, '找不到起点：' + startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(end, -1, '找不到终点：' + endMarker);
    return source.slice(start, end);
}

// finishStream 后面的函数名会变（同域还在持续拆分），所以按「下一个同级 function」切，
// 不写死终点函数名。
function sliceFromFn(source, marker) {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, '找不到函数：' + marker);
    const next = source.indexOf('\n    function ', start + marker.length);
    return next < 0 ? source.slice(start) : source.slice(start, next);
}

const startRound = sliceBetween(panel, 'function startRound(target) {', 'function handleToolRound(');
const finishStream = sliceFromFn(panel, 'function finishStream(target) {');

test('startRound：只在回合首个请求写 turn/start', () => {
    assert.match(startRound, /if \(s\.roundNo === 1\) auditTurnEvent\(/,
        '缺少「仅首轮」判定会在每个工具续轮重复开回合，interruptedTurnIds 会误报');
    assert.match(startRound, /'start'/);
});

test('finishStream：收尾写 turn/close，并区分 stop / error / done', () => {
    assert.match(finishStream, /auditTurnEvent\(/);
    assert.match(finishStream, /'close'/);
    assert.match(finishStream, /current\.stopped \? 'stop'/);
    assert.match(finishStream, /status === 'error' \? 'error' : 'done'/);
});

test('auditEventOf 走 appendAuditEvent 且吞错不打断对话；三类事件共用它', () => {
    const helper = sliceBetween(panel, 'function auditEventOf(', 'function notifyStorageFailed(');
    assert.match(helper, /sessionStore\.appendAuditEvent\(/);
    assert.match(helper, /catch/);
    // turn / tool / approval 三类编码器都经统一口追加，不再各自直写。
    assert.match(helper, /function auditTurnEvent\(/);
    assert.match(helper, /encodeTurnEvent\(/);
    assert.match(helper, /function auditToolEvent\(/);
    assert.match(helper, /encodeToolEvent\(/);
    assert.match(helper, /function auditApprovalEvent\(/);
    assert.match(helper, /encodeApprovalEvent\(/);
});

test('工具调用挂 start / end 事件，审批裁定挂 approval 事件', () => {
    // 按 runToolCall 函数切片（它前面是 handleToolRound 的其它局部函数，避免误抓别处）。
    const fn = sliceBetween(panel, 'const runToolCall = async (call) => {', '// 执行批次：相邻的只读调用并发跑');
    const startAt = fn.indexOf("auditToolEvent(session, call.id, call.name, 'start')");
    const endAt = fn.indexOf("auditToolEvent(session, call.id, call.name, 'end'");
    const approvalAt = fn.indexOf('auditApprovalEvent(session, call.id, toolMessage.approval');
    assert.ok(startAt >= 0, '工具 start 事件缺失');
    assert.ok(endAt > startAt, '工具 end 事件须在 start 之后');
    assert.ok(approvalAt >= 0, '审批裁定事件缺失');
});

test('载入时对未闭合回合补 crash 闭合', () => {
    assert.match(disk, /interruptedTurnIds\(replay\)/);
    assert.match(disk, /encodeTurnEvent\(turnId, 'close', 'crash'\)/);
});

test('appendAuditEvent 是纯追加、不建日志（allowCreate=false）', () => {
    const fn = sliceBetween(disk, 'function appendAuditEvent(', 'return {queueLogSave');
    assert.match(fn, /AISessionAppend\(id, lines, false\)/,
        '审计事件不得允许创建日志：无 header 的文件会让 Go 侧分桶归属出错');
});

test('子代理 spawn 与终态各写一条 agent 事件', () => {
    assert.match(subagents, /function auditAgent\(/);
    assert.match(subagents, /auditAgent\(sub, 'spawn'\)/);
    assert.match(subagents, /auditAgent\(sub, state === 'done' \? 'done' : 'stopped', state\)/);
    // finalize 的幂等前置必须仍在 auditAgent 之前，否则重复终态会重复落事件。
    const finalize = sliceBetween(subagents, 'function finalizeSubAgent(', 'if (sub.renderTimer)');
    const guardAt = finalize.indexOf("if (sub.state !== 'running') return;");
    const auditAt = finalize.indexOf('auditAgent(sub, state === ');
    assert.ok(guardAt >= 0 && auditAt > guardAt, 'finalize 幂等守卫必须在写事件之前');
});
