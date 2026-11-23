// ai-patch-error 纯函数测试：后端 patchError 文本 → {code, text, retryable}。
import test from 'node:test';
import assert from 'node:assert/strict';
import {patchErrorParts} from '../../../src/ai/security/ai-patch-error.js';

test('patchErrorParts：确定性失败还原错误码且不可重试', () => {
    const parts = patchErrorParts('PATCH_EMPTY: 补丁没有任何改动（+0/−0）：未保存，请确认 hunk 是否写对');
    assert.equal(parts.code, 'PATCH_EMPTY');
    assert.equal(parts.retryable, false);
    assert.equal(parts.matched, true);
    assert.match(parts.text, /没有任何改动/);
});

test('patchErrorParts：冲突类失败保留可重试', () => {
    const parts = patchErrorParts('PATCH_HUNK_CONFLICT: 补丁没有任何文件可直接应用（a.txt：上下文不匹配）');
    assert.equal(parts.code, 'PATCH_HUNK_CONFLICT');
    assert.equal(parts.retryable, true);
    assert.match(parts.text, /a\.txt/);
});

test('patchErrorParts：认识被拦路径 / 超限 / 解析失败三种不可重试码', () => {
    for (const code of ['PATCH_PATH_DENIED', 'PATCH_LIMIT', 'PATCH_PARSE', 'PATCH_NO_BACKUP']) {
        const parts = patchErrorParts(code + ': 说明');
        assert.equal(parts.code, code, code);
        assert.equal(parts.retryable, false, code);
    }
});

test('patchErrorParts：无前缀按解析失败处理并带回原文', () => {
    const parts = patchErrorParts('some unexpected failure');
    assert.equal(parts.code, 'PATCH_PARSE');
    assert.equal(parts.retryable, true);
    assert.equal(parts.matched, false);
    assert.equal(parts.text, 'some unexpected failure');
});

test('patchErrorParts：空输入与多行明细', () => {
    assert.deepEqual(patchErrorParts(''), {code: 'PATCH_PARSE', text: '补丁处理失败', retryable: true, matched: false});
    assert.deepEqual(patchErrorParts(null).text, '补丁处理失败');
    const multi = patchErrorParts('PATCH_APPLY_IO: 写入失败（\n第 2 行：权限不足\n）');
    assert.equal(multi.code, 'PATCH_APPLY_IO');
    assert.match(multi.text, /权限不足/);
});

test('patchErrorParts：冒号前后空格容错', () => {
    assert.equal(patchErrorParts('PATCH_EMPTY:没有空格').code, 'PATCH_EMPTY');
    assert.equal(patchErrorParts('  PATCH_EMPTY :  空白  ').code, 'PATCH_EMPTY');
});
