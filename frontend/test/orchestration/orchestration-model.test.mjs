// orchestration-model.test.mjs：编排前端纯函数（计划归一、审批编辑解析、看板摘要）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    batchDoneRatio, buildPlanRequest, computeAuditIdleMs, formatVerifyEditor, isTerminalStatus,
    normalizeBatch, ownsFromInput, parseVerifyEditor, statusLabel, stricterScope, summarizeView,
} from '../../src/orchestration/orchestration-model.js';

test('buildPlanRequest：默认审查门开、审计阈值随最长批次放大、会话身份由宿主填', () => {
    const req = buildPlanRequest({
        title: '把 X 做完',
        goal: '目标',
        policy: {maxParallel: 9, batchTimeoutMs: 60 * 60 * 1000},
        batches: [{id: 'B1', title: '实现', spec: '改代码', owns: ['src/**'], timeoutMs: 2 * 60 * 60 * 1000}],
    }, {
        workspace: 'D:/repo', sessionId: 'parent-1', group: '工作',
        scope: 'full', modelRef: 'acc|model',
    });
    assert.equal(req.workspace, 'D:/repo');
    assert.equal(req.parentSessionId, 'parent-1');
    assert.equal(req.arbiterSessionId, 'parent-1');
    assert.equal(req.arbiterModelRef, 'acc|model');
    assert.equal(req.policy.scope, 'edit', 'full 档发起时执行会话默认收到 edit，不默认给最宽');
    assert.equal(req.policy.maxParallel, 8, '并发夹到 1–8');
    assert.equal(req.policy.review, true, '未显式关审查时应默认开');
    assert.equal(req.policy.reviewExplicit, false);
    assert.equal(req.policy.finalReview, false, '终审默认关，由审批卡/设置显式开启');
    assert.equal(req.policy.finalReviewCount, 0);
    assert.ok(req.policy.auditIdleMs >= 2 * 2 * 60 * 60 * 1000, '审计阈值必须 ≥ 2 × 最长批次超时');
    assert.deepEqual(req.batches[0].owns, ['src/**']);
});

test('buildPlanRequest：显式关审查 + 白名单 + 自主模式都如实保留', () => {
    const req = buildPlanRequest({
        title: 't', goal: 'g',
        policy: {review: false, allowWorkerModels: true, allowedWorkerModels: ['a|b', 'c|d'], autoRun: true},
        batches: [{id: 'B1', title: 't', spec: 's', owns: [], model: {first: 'a|b'}}],
    }, {workspace: 'D:/repo', sessionId: 'p', scope: 'read'});
    assert.equal(req.policy.review, false);
    assert.equal(req.policy.reviewExplicit, true);
    assert.equal(req.policy.allowWorkerModels, true);
    assert.deepEqual(req.policy.allowedWorkerModels, ['a|b', 'c|d']);
    assert.equal(req.policy.autoRun, true);
    assert.equal(req.policy.scope, 'read');
    assert.deepEqual(req.batches[0].owns, []);
});

test('buildPlanRequest：终审开关、数量与模型留空（继承母会话）如实保留', () => {
    const req = buildPlanRequest({
        title: 't', goal: 'g',
        policy: {finalReview: true, finalReviewCount: 9, finalReviewModel: ''},
        batches: [{id: 'B1', title: 't', spec: 's', owns: []}],
    }, {workspace: 'D:/repo', sessionId: 'p', scope: 'read'});
    assert.equal(req.policy.finalReview, true);
    assert.equal(req.policy.finalReviewCount, 3, '终审数量夹到 1–3');
    assert.equal(req.policy.finalReviewModel, '', '留空表示继承母会话');
});

test('stricterScope：只能继承或更严', () => {
    assert.equal(stricterScope('read', 'full'), 'read');
    assert.equal(stricterScope('full', 'read'), 'read');
    assert.equal(stricterScope('edit', 'auto'), 'edit');
    assert.equal(stricterScope('edit', 'bogus'), 'edit');
});

test('verify 编辑器：JSON 数组与逐行 JSON 都接受，坏行明确报错', () => {
    const one = parseVerifyEditor('[{"file":"npm","args":["run","test"]}]');
    assert.equal(one.ok, true);
    assert.deepEqual(one.value, [{file: 'npm', args: ['run', 'test']}]);
    const lines = parseVerifyEditor('{"file":"go","args":["test"]}\n{"file":"npm"}');
    assert.equal(lines.ok, true);
    assert.equal(lines.value.length, 2);
    assert.equal(parseVerifyEditor('{oops').ok, false);
    assert.equal(parseVerifyEditor('').ok, true);
    assert.equal(formatVerifyEditor([{file: 'go'}]).includes('"file": "go"'), true);
});

test('owns 输入：中英文逗号与换行都可分隔', () => {
    assert.deepEqual(ownsFromInput('src/**, docs/**\nREADME.md'), ['src/**', 'docs/**', 'README.md']);
    assert.deepEqual(ownsFromInput(''), []);
});

test('看板摘要：work 与审查分开计数，失败批次要点名', () => {
    const view = {
        orchestration: {id: 'o1', title: '测试', status: 'awaiting_arbitration', goal: 'g', stats: {tokensUsed: 123}},
        batches: [
            {id: 'B1', title: '一', kind: 'work', status: 'done'},
            {id: 'B2', title: '二', kind: 'work', status: 'failed', failureReason: 'verify_failed', attempts: 2},
            {id: 'review-B1', title: '审一', kind: 'review', status: 'done', reviewOf: 'B1'},
        ],
    };
    const ratio = batchDoneRatio(view);
    assert.equal(ratio.work, '1/2');
    assert.equal(ratio.review, '1/1');
    const text = summarizeView(view);
    assert.match(text, /1\/2 批/);
    assert.match(text, /B2/);
    assert.match(text, /验收失败/);
    assert.equal(statusLabel('paused_no_window'), '暂停（窗口已关）');
    assert.equal(isTerminalStatus('done'), true);
    assert.equal(isTerminalStatus('running'), false);
});

test('normalizeBatch：缺 id / title 时给稳定占位，非法数值被夹掉', () => {
    const b = normalizeBatch({spec: 's', owns: ['a'], timeoutMs: -5}, 2);
    assert.equal(b.id, 'B3');
    assert.equal(b.title, '批次 3');
    assert.deepEqual(b.owns, ['a']);
    assert.equal(b.timeoutMs, undefined);
});

test('computeAuditIdleMs：逐批 timeout 也参与，且不把更大默认值改小', () => {
    const policy = {batchTimeoutMs: 20 * 60 * 1000};
    assert.equal(computeAuditIdleMs(2 * 60 * 60 * 1000, policy, []), 2 * 60 * 60 * 1000);
    assert.equal(computeAuditIdleMs(2 * 60 * 60 * 1000, policy, [{timeoutMs: 2 * 60 * 60 * 1000}]), 4 * 60 * 60 * 1000);
    assert.equal(computeAuditIdleMs(8 * 60 * 60 * 1000, policy, [{timeoutMs: 60 * 60 * 1000}]), 8 * 60 * 60 * 1000);
});
