// ai-truncation 纯函数：截断判定与提示文案。
import test from 'node:test';
import assert from 'node:assert/strict';

import {resolveTruncation, truncatedNotice, CONTINUATION_PROMPT} from '../../../src/ai/chat/ai-truncation.js';

test('length 一律判截断，不看正文', () => {
    assert.equal(resolveTruncation('length', ''), 'length');
    assert.equal(resolveTruncation('length', '写完了。'), 'length');
    assert.equal(resolveTruncation(' LENGTH ', 'x'), 'length');
});

test('unknown 只在悬空收尾时判疑似截断', () => {
    assert.equal(resolveTruncation('unknown', '先用一张图对齐统一模型：'), 'suspect');
    assert.equal(resolveTruncation('unknown', '参数是，'), 'suspect');
    assert.equal(resolveTruncation('unknown', '再看这里…'), 'suspect');
    assert.equal(resolveTruncation('unknown', '这是一句完整的话。'), '');
    assert.equal(resolveTruncation('unknown', '```svg\n<svg viewBox="0 0 1 1">'), '');
    assert.equal(resolveTruncation('unknown', ''), '');
    assert.equal(resolveTruncation('unknown', '   '), '');
});

test('stop / tool / 空值一律不提示', () => {
    for (const reason of ['stop', 'tool', '', null, undefined, 'whatever']) {
        assert.equal(resolveTruncation(reason, '例如：'), '');
    }
});

test('提示文案与继续指令', () => {
    assert.match(truncatedNotice('length'), /输出达到上限/);
    assert.match(truncatedNotice('suspect'), /没给结束原因/);
    assert.equal(truncatedNotice(''), '');
    assert.ok(CONTINUATION_PROMPT.length > 0);
});
