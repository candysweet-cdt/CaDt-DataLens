// ai-scope-redact.test.mjs：非完全权限档下工具报错/路径回显的收敛口径（只读档不能暴露真实根）。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {redactScopePaths, SCOPE_ROOT_MARK, OUT_OF_SCOPE_MARK} from '../../../src/ai/security/ai-scope-redact.js';

const ROOT = 'D:/OraSkyC/Project/CandySweet/CaDt-DataLens';

test('完全权限档原样返回（full 档本就该看到真实路径）', () => {
    const text = 'GetFileAttributesEx D:/OraSkyC/Novel/番外0007.md: The system cannot find the path specified.';
    assert.equal(redactScopePaths(text, ROOT, 'full'), text);
});

test('只读档：工作区内的路径换成 <工作区> 记号，保留相对部分', () => {
    const text = '工具执行失败：GetFileAttributesEx ' + ROOT + '/Novel/番外0007.md: The system cannot find the path specified.';
    assert.equal(
        redactScopePaths(text, ROOT, 'read'),
        '工具执行失败：GetFileAttributesEx ' + SCOPE_ROOT_MARK + '/Novel/番外0007.md: The system cannot find the path specified.',
    );
});

test('只读档：工作区外的绝对路径只留文件名', () => {
    const text = '工具执行失败：GetFileAttributesEx D:/OraSkyC/Novel/日记星辰/正文/番外0007-最轻松的时光.md: The system cannot find the path specified.';
    const out = redactScopePaths(text, ROOT, 'read');
    assert.equal(
        out,
        '工具执行失败：GetFileAttributesEx ' + OUT_OF_SCOPE_MARK + '番外0007-最轻松的时光.md: The system cannot find the path specified.',
    );
    assert.ok(!out.includes('D:/'), '不应残留盘符');
    assert.ok(!out.includes('OraSkyC'), '不应残留用户名目录');
});

test('反斜杠路径同样收敛（Windows 原生报错）', () => {
    const text = 'GetFileAttributesEx D:\\OraSkyC\\Novel\\a.md: 找不到路径';
    assert.equal(redactScopePaths(text, ROOT, 'read'), 'GetFileAttributesEx ' + OUT_OF_SCOPE_MARK + 'a.md: 找不到路径');
});

test('大小写不敏感，且两种分隔符混用也能命中根', () => {
    const text = '错误：d:\\oraskyc\\project\\candysweet\\cadt-datalens\\子目录\\a.md 打不开';
    assert.equal(redactScopePaths(text, ROOT, 'read'), '错误：' + SCOPE_ROOT_MARK + '\\子目录\\a.md 打不开');
});

test('只认完整目录段：前缀相同的兄弟目录不算命中根', () => {
    const text = ROOT + '2/evil.md';
    assert.equal(redactScopePaths(text, ROOT, 'read'), OUT_OF_SCOPE_MARK + 'evil.md');
});

test('根本身（不带子路径）→ 记号；根尾随斜杠容错', () => {
    assert.equal(redactScopePaths(ROOT, ROOT, 'read'), SCOPE_ROOT_MARK);
    assert.equal(redactScopePaths(ROOT, ROOT + '/', 'read'), SCOPE_ROOT_MARK);
});

test('不误伤 URL 与普通文本', () => {
    const text = '见 https://example.com/docs/x 和 frontend/src/ai/ai-panel.js:4512';
    assert.equal(redactScopePaths(text, ROOT, 'read'), text);
});

test('edit / auto 档同样收敛（边界口径与 aiResolveScopePath 一致）', () => {
    const text = 'D:/OraSkyC/Novel/a.md';
    assert.equal(redactScopePaths(text, ROOT, 'edit'), OUT_OF_SCOPE_MARK + 'a.md');
    assert.equal(redactScopePaths(text, ROOT, 'auto'), OUT_OF_SCOPE_MARK + 'a.md');
});

test('空值 / 无根时不炸', () => {
    assert.equal(redactScopePaths('', ROOT, 'read'), '');
    assert.equal(redactScopePaths(null, ROOT, 'read'), '');
    assert.equal(redactScopePaths('D:/a/b.md', '', 'read'), OUT_OF_SCOPE_MARK + 'b.md');
});
