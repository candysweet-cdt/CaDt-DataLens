// ai-tool-failure-guard.test.mjs：工具连续失败熔断的纯函数测试。
// 覆盖：错误签名归一化抹掉数字/路径/引号、同类失败累加、异类失败重置、
// 会话/路径隔离、成功清零、阈值拦截与提示文本。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    TOOL_FAILURE_GUARD_DEFAULTS,
    createToolFailureGuard,
    normalizeToolError,
    resolveToolFailureMax,
    toolFailureGiveupText,
    toolFailureNotice,
    toolFailureScope,
    toolFailureToastText,
    toolFailureToolResultText,
} from '../../../src/ai/chat/ai-tool-failure-guard.js';

const EDIT_ERR = '未找到 oldString，请先 read_file 并逐字复制（注意缩进与换行）';

// —— normalizeToolError ——

test('normalizeToolError: 抹掉数字与引号内容，只留错误类型骨架', () => {
    const a = normalizeToolError('未找到 oldString：第 150 行附近 "foo-bar"');
    const b = normalizeToolError('未找到 oldString：第 310 行附近 "totally-different"');
    assert.equal(a, b, '行号与引号内的具体值不应影响错误签名');
});

test('normalizeToolError: 同类错误文本（带工具执行失败前缀）归一后相同', () => {
    assert.equal(
        normalizeToolError('工具执行失败：未找到 oldString，请先 read_file 并逐字复制（注意缩进与换行）'),
        normalizeToolError(EDIT_ERR),
    );
});

test('normalizeToolError: 不同错误类型签名不同', () => {
    assert.notEqual(
        normalizeToolError(EDIT_ERR),
        normalizeToolError('oldString 多处命中（3 处），请提供更长的唯一上下文'),
    );
});

// —— toolFailureScope ——

test('toolFailureScope: 按工具 + 路径分桶，命令工具按命令分桶', () => {
    assert.equal(toolFailureScope('edit_file', {path: 'D:\\repo\\a.js'}), 'edit_file|D:/repo/a.js');
    assert.notEqual(toolFailureScope('edit_file', {path: 'a.js'}), toolFailureScope('edit_file', {path: 'b.js'}));
    assert.notEqual(toolFailureScope('run_command', {command: 'npm test'}), toolFailureScope('run_command', {command: 'npm build'}));
    assert.equal(toolFailureScope('list_dir', {}), 'list_dir');
});

// —— 状态机 ——

test('同类失败累加到阈值后 shouldBlock 命中', () => {
    const guard = createToolFailureGuard();
    const args = {path: 'frontend/src/core/tooltip.js', oldString: 'a', newString: 'b'};
    assert.equal(guard.shouldBlock('edit_file', args, 's1'), null);
    for (let i = 1; i < TOOL_FAILURE_GUARD_DEFAULTS.maxAttempts; i += 1) {
        assert.equal(guard.recordFailure('edit_file', args, EDIT_ERR, 's1'), i);
        assert.equal(guard.shouldBlock('edit_file', args, 's1'), null);
    }
    const last = guard.recordFailure('edit_file', args, EDIT_ERR, 's1');
    assert.equal(last, TOOL_FAILURE_GUARD_DEFAULTS.maxAttempts);
    assert.ok(guard.shouldBlock('edit_file', args, 's1'));
});

test('换 oldString 但错误同类仍累加（模型微调参数绕不过计数）', () => {
    const guard = createToolFailureGuard({maxAttempts: 3});
    guard.recordFailure('edit_file', {path: 'a.js', oldString: 'x = 1'}, EDIT_ERR, 's1');
    guard.recordFailure('edit_file', {path: 'a.js', oldString: 'x = 2'}, EDIT_ERR, 's1');
    assert.equal(guard.shouldBlock('edit_file', {path: 'a.js', oldString: 'x = 3'}, 's1'), null);
    guard.recordFailure('edit_file', {path: 'a.js', oldString: 'x = 3'}, EDIT_ERR, 's1');
    assert.ok(guard.shouldBlock('edit_file', {path: 'a.js', oldString: 'x = 4'}, 's1'));
});

test('错误类型改变则重新计数', () => {
    const guard = createToolFailureGuard();
    guard.recordFailure('edit_file', {path: 'a.js'}, EDIT_ERR, 's1');
    guard.recordFailure('edit_file', {path: 'a.js'}, EDIT_ERR, 's1');
    const count = guard.recordFailure('edit_file', {path: 'a.js'}, 'oldString 多处命中（3 处），请提供更长的唯一上下文', 's1');
    assert.equal(count, 1);
    assert.equal(guard.shouldBlock('edit_file', {path: 'a.js'}, 's1'), null);
});

test('不同路径 / 不同会话互不干扰', () => {
    const guard = createToolFailureGuard({maxAttempts: 3});
    for (let i = 0; i < 3; i += 1) guard.recordFailure('edit_file', {path: 'a.js'}, EDIT_ERR, 's1');
    assert.ok(guard.shouldBlock('edit_file', {path: 'a.js'}, 's1'));
    assert.equal(guard.shouldBlock('edit_file', {path: 'b.js'}, 's1'), null);
    assert.equal(guard.shouldBlock('edit_file', {path: 'a.js'}, 's2'), null);
});

test('成功后清零，可重新尝试', () => {
    const guard = createToolFailureGuard({maxAttempts: 3});
    for (let i = 0; i < 3; i += 1) guard.recordFailure('edit_file', {path: 'a.js'}, EDIT_ERR, 's1');
    assert.ok(guard.shouldBlock('edit_file', {path: 'a.js'}, 's1'));
    guard.recordSuccess('edit_file', {path: 'a.js'}, 's1');
    assert.equal(guard.shouldBlock('edit_file', {path: 'a.js'}, 's1'), null);
    assert.equal(guard.recordFailure('edit_file', {path: 'a.js'}, EDIT_ERR, 's1'), 1);
});

test('自定义阈值与 reset', () => {
    const guard = createToolFailureGuard({maxAttempts: 1});
    guard.recordFailure('edit_file', {path: 'a.js'}, EDIT_ERR, 's1');
    assert.ok(guard.shouldBlock('edit_file', {path: 'a.js'}, 's1'));
    guard.reset();
    assert.equal(guard.shouldBlock('edit_file', {path: 'a.js'}, 's1'), null);
    assert.deepEqual(guard.stats(), []);
});

// —— 提示文本 ——

test('toolFailureGiveupText: 含路径、次数、强制指令语气与换策略指引', () => {
    const text = toolFailureGiveupText('edit_file', {path: 'frontend/src/core/tooltip.js'}, {count: 3, sig: '未找到 oldstring'});
    assert.match(text, /frontend\/src\/core\/tooltip\.js/);
    assert.match(text, /连续失败 3 次/);
    assert.match(text, /强制指令/);
    assert.match(text, /禁止再用相同或相近的参数重试/);
    assert.match(text, /read_file/);
    assert.match(text, /write_file/);
});

test('toolFailureToolResultText: 极简，指向随后的应用消息，不重复完整指引', () => {
    const text = toolFailureToolResultText();
    assert.match(text, /不要重试/);
    assert.match(text, /应用消息/);
    assert.ok(text.length < 100, 'tool 结果应极简，避免与应用消息重复占上下文');
    assert.doesNotMatch(text, /read_file|write_file/, '换策略指引只在应用消息里给一次');
});

test('toolFailureNotice: urgent 应用消息 payload，content 是完整强提示', () => {
    const state = {count: 3, sig: '未找到 oldstring'};
    const notice = toolFailureNotice('edit_file', {path: 'frontend/src/core/tooltip.js'}, state);
    assert.equal(notice.kind, 'tool-failure');
    assert.equal(notice.label, '工具熔断 · edit_file');
    assert.equal(notice.urgent, true);
    assert.equal(notice.content, toolFailureGiveupText('edit_file', {path: 'frontend/src/core/tooltip.js'}, state));
});

test('toolFailureToastText: 简短告知用户熔断与换策略', () => {
    const text = toolFailureToastText('edit_file', {path: 'frontend/src/core/tooltip.js'}, {count: 3});
    assert.match(text, /frontend\/src\/core\/tooltip\.js/);
    assert.match(text, /连续失败 3 次/);
    assert.match(text, /换策略/);
    assert.ok(text.length < 120, 'toast 文案应简短');
});

// —— 阈值配置（0 = 关闭，有效最小 3）与动态 getter ——

test('resolveToolFailureMax: 缺省回落 5，0 关闭，有效值钳到 3–20', () => {
    assert.equal(resolveToolFailureMax(undefined), 5, '缺省 = 默认 5');
    assert.equal(resolveToolFailureMax(null), 5);
    assert.equal(resolveToolFailureMax(''), 5);
    assert.equal(resolveToolFailureMax('abc'), 5, '非法值回落默认');
    assert.equal(resolveToolFailureMax(0), 0, '显式 0 = 关闭');
    assert.equal(resolveToolFailureMax('0'), 0);
    assert.equal(resolveToolFailureMax(3), 3, '有效最小 3');
    assert.equal(resolveToolFailureMax(2), 3, '低于最小钳到 3');
    assert.equal(resolveToolFailureMax(5), 5);
    assert.equal(resolveToolFailureMax('8'), 8, '数字字符串照常解析');
    assert.equal(resolveToolFailureMax(999), 20, '高于上限钳到 20');
});

test('阈值 0（关闭）时不记账、不拦截', () => {
    const guard = createToolFailureGuard({maxAttempts: 0});
    const args = {path: 'a.js'};
    for (let i = 0; i < 10; i += 1) {
        assert.equal(guard.recordFailure('edit_file', args, EDIT_ERR, 's1'), 0);
    }
    assert.equal(guard.shouldBlock('edit_file', args, 's1'), null);
    assert.deepEqual(guard.stats(), []);
});

test('maxAttempts 传 getter：实时读配置，改阈值立即生效', () => {
    let configured = 5;
    const guard = createToolFailureGuard({maxAttempts: () => configured});
    const args = {path: 'a.js'};
    for (let i = 0; i < 3; i += 1) guard.recordFailure('edit_file', args, EDIT_ERR, 's1');
    assert.equal(guard.shouldBlock('edit_file', args, 's1'), null, '阈值 5 时 3 次不拦');
    configured = 3;
    assert.ok(guard.shouldBlock('edit_file', args, 's1'), '改成 3 后立即拦截');
    configured = 0;
    assert.equal(guard.shouldBlock('edit_file', args, 's1'), null, '关掉后立即放行');
});

test('reset 清空全部计数（回合首轮调用，避免跨回合旧账累积）', () => {
    const guard = createToolFailureGuard({maxAttempts: 3});
    const args = {path: 'a.js'};
    guard.recordFailure('edit_file', args, EDIT_ERR, 's1');
    guard.recordFailure('edit_file', args, EDIT_ERR, 's1');
    guard.reset();
    assert.equal(guard.recordFailure('edit_file', args, EDIT_ERR, 's1'), 1, '重置后重新从 1 计');
    assert.equal(guard.shouldBlock('edit_file', args, 's1'), null);
});
