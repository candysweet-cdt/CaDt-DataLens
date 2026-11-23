// ai-path-hints.test.mjs —— read_file「同名文件在哪」提示（2026-11-17 事故：
// 模型被过期文档带偏把 test/ 猜成 src/，原始英文报错让它又花一轮 glob 才找回）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {NOT_FOUND_RE, splitBasename, missingFileHint} from '../../../src/ai/tools/ai-path-hints.js';

test('NOT_FOUND_RE：认得 Windows / Go 的不存在报错，不认目录过大二进制', () => {
    assert.ok(NOT_FOUND_RE.test('打开失败：The system cannot find the file specified.'));
    assert.ok(NOT_FOUND_RE.test('open x: no such file or directory'));
    assert.ok(NOT_FOUND_RE.test('路径不存在'));
    // 这些是「路径对但读不了」，不该给替代路径建议
    assert.ok(!NOT_FOUND_RE.test('这是目录，不是文件'));
    assert.ok(!NOT_FOUND_RE.test('文件过大（>10 MB）'));
    assert.ok(!NOT_FOUND_RE.test('二进制文件不可作为文本读取'));
});

test('splitBasename：正反斜杠与尾部分隔符', () => {
    assert.equal(splitBasename('D:\\a\\b\\x.test.mjs'), 'x.test.mjs');
    assert.equal(splitBasename('a/b/x.test.mjs/'), 'x.test.mjs');
    assert.equal(splitBasename(''), '');
});

function deps(overrides = {}) {
    return {
        findFiles: overrides.findFiles || null,
        resolveRoot: overrides.resolveRoot || (async () => 'D:/ws'),
        redact: overrides.redact,
        session: overrides.session,
        ...overrides,
    };
}

test('有同名文件：返回可直接重试的相对路径清单', async () => {
    const hint = await missingFileHint(
        new Error('打开失败：The system cannot find the file specified.'),
        'frontend/src/core/x.test.mjs',
        'D:/ws/frontend/src/core/x.test.mjs',
        deps({
            findFiles: async () => ({files: [
                {path: 'frontend/test/core/x.test.mjs', size: 12},
                {path: 'frontend/test/core/other.mjs', size: 3},
            ]}),
            redact: (t) => t,
        }),
    );
    assert.ok(hint.startsWith('文件不存在：frontend/src/core/x.test.mjs'));
    assert.ok(hint.includes('frontend/test/core/x.test.mjs'));
    assert.ok(!hint.includes('other.mjs'), '只保留同名匹配');
    assert.ok(hint.includes('重试 read_file'));
});

test('没有同名：引导用 glob 找相近文件，而不是硬猜', async () => {
    const hint = await missingFileHint(
        new Error('no such file or directory'),
        'a/b/missing.mjs',
        'D:/ws/a/b/missing.mjs',
        deps({findFiles: async () => ({files: []})}),
    );
    assert.ok(hint.includes('文件不存在：a/b/missing.mjs'));
    assert.ok(hint.includes('glob'));
});

test('非不存在错误（过大 / 目录 / 二进制）返回 null，回退原始报错', async () => {
    for (const message of ['这是目录，不是文件', '文件过大（>10 MB）', '二进制文件不可作为文本读取']) {
        const hint = await missingFileHint(new Error(message), 'a', 'D:/ws/a', deps({
            findFiles: async () => ({files: [{path: 'a'}]}),
        }));
        assert.equal(hint, null, message);
    }
});

test('防御：FindFiles 抛错 / 无通道 / 空根 / 空 basename 都返回 null', async () => {
    const err = new Error('no such file');
    assert.equal(await missingFileHint(err, 'a', 'D:/ws/a', deps({
        findFiles: async () => { throw new Error('boom'); },
    })), null);
    assert.equal(await missingFileHint(err, 'a', 'D:/ws/a', deps({findFiles: null})), null);
    assert.equal(await missingFileHint(err, 'a', 'D:/ws/a', deps({
        resolveRoot: async () => '',
    })), null);
    assert.equal(await missingFileHint(err, '', '', deps({
        findFiles: async () => ({files: [{path: 'a'}]}),
    })), null);
});
