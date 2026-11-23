import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeGitDiffBlock} from '../../../src/ai/chat/ai-changes-ui.js';

// 回归背景：审阅虚拟文档此前对 GitDiffFor 输出整串 .trim()——hunk 以空上下文行
// （单个空格）结尾时整行被吃掉，PatchParseText 数出「头部声明 -141,7 +141,7，
// 实际数出 -6 +6」，审阅文档直接报无法解析。

test('结尾的空上下文行（单个空格）原样保留', () => {
    const diff = [
        'diff --git a/A.md b/A.md',
        '--- a/A.md',
        '+++ b/A.md',
        '@@ -141,7 +141,7 @@',
        ' ctx1',
        '-old1',
        '+new1',
        ' ctx2',
        ' ctx3',
        ' ',
        '',
    ].join('\n');
    const out = normalizeGitDiffBlock(diff);
    const lines = out.split('\n');
    assert.equal(lines[lines.length - 1], ' ');
    assert.equal(lines.length, 10);
    // Go 侧 TrimRight 后的形态（末尾无换行，直接以空格行结束）同样保留
    assert.equal(normalizeGitDiffBlock(diff.replace(/\n$/, '')), out);
});

test('首尾多余的换行裁掉，正文不动', () => {
    assert.equal(normalizeGitDiffBlock('\n\ndiff --git a/a b/a\n@@ -1,1 +1,1 @@\n-a\n+b\n\n\n'), 'diff --git a/a b/a\n@@ -1,1 +1,1 @@\n-a\n+b');
    // 中间的空上下文行（无论带不带尾空格）原样保留
    const mid = normalizeGitDiffBlock('@@ -1,3 +1,3 @@\n-a\n\n+b\n');
    assert.deepEqual(mid.split('\n'), ['@@ -1,3 +1,3 @@', '-a', '', '+b']);
});

test('CRLF 输入：结尾空上下文行同样保留', () => {
    const out = normalizeGitDiffBlock('@@ -1,2 +1,2 @@\r\n-a\r\n+b\r\n \r\n');
    assert.ok(out.endsWith(' '));
});

test('空值返回空串；纯换行输入裁空（空格上下文行按语义保留）', () => {
    assert.equal(normalizeGitDiffBlock(''), '');
    assert.equal(normalizeGitDiffBlock(null), '');
    assert.equal(normalizeGitDiffBlock(undefined), '');
    assert.equal(normalizeGitDiffBlock('\n\n'), '');
    // 只有空上下文行的极端输入也按「只裁换行」保留——调用方先用 trim() 判空，垃圾输入不会进来
    assert.equal(normalizeGitDiffBlock('\n \n'), ' ');
});
