// ai-stream-retry 纯函数测试：断流重试预算与判定。
import test from 'node:test';
import assert from 'node:assert/strict';
import {AI_STREAM_RETRY_LIMIT, aiStreamRetryBudget, shouldAutoRetryStream} from '../../../src/ai/chat/ai-stream-retry.js';

test('aiStreamRetryBudget：retryMax=0 关闭，默认 5 收敛到上限', () => {
    assert.equal(aiStreamRetryBudget(0), 0);
    assert.equal(aiStreamRetryBudget(5), AI_STREAM_RETRY_LIMIT);
    assert.equal(aiStreamRetryBudget(10), AI_STREAM_RETRY_LIMIT);
    assert.equal(aiStreamRetryBudget(1), 1);
});

test('aiStreamRetryBudget：非法值按默认 5 处理，负数归零', () => {
    assert.equal(aiStreamRetryBudget(undefined), AI_STREAM_RETRY_LIMIT);
    assert.equal(aiStreamRetryBudget(NaN), AI_STREAM_RETRY_LIMIT);
    assert.equal(aiStreamRetryBudget(-3), 0);
    assert.equal(aiStreamRetryBudget('2'), 2);
});

test('shouldAutoRetryStream：只认 retryable，停止与预算用尽都不重试', () => {
    assert.equal(shouldAutoRetryStream({retryable: true, stopped: false, retried: 0, budget: 2}), true);
    assert.equal(shouldAutoRetryStream({retryable: false, stopped: false, retried: 0, budget: 2}), false);
    assert.equal(shouldAutoRetryStream({retryable: true, stopped: true, retried: 0, budget: 2}), false);
    assert.equal(shouldAutoRetryStream({retryable: true, stopped: false, retried: 2, budget: 2}), false);
    assert.equal(shouldAutoRetryStream({retryable: true, stopped: false, retried: 0, budget: 0}), false);
    assert.equal(shouldAutoRetryStream(), false);
});
