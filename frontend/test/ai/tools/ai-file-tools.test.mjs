// ai-file-tools.test.mjs：read_file 窗口切片 / edit_file 定位 / list_dir 大小 / search_text 通配 / file:// 解析 的纯函数测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AI_READ_MAX_CHARS,
    attachmentPathHint,
    globMatchPath,
    humanSizeBytes,
    locateEditTarget,
    normalizeFileUrlTarget,
    normalizeReadWindow,
    readWindowOf,
    renderDirTreeText,
} from '../../../src/ai/tools/ai-file-tools.js';

// —— normalizeReadWindow ——

test('normalizeReadWindow: 字符模式默认值与钳制', () => {
    assert.deepEqual(normalizeReadWindow({}), {mode: 'chars', offset: 0, limit: AI_READ_MAX_CHARS});
    assert.deepEqual(normalizeReadWindow({offset: -5}), {mode: 'chars', offset: 0, limit: AI_READ_MAX_CHARS});
    assert.deepEqual(normalizeReadWindow({offset: 10, limit: 50}), {mode: 'chars', offset: 10, limit: 50});
    // limit 超上限钳到 64KB
    assert.equal(normalizeReadWindow({limit: 999999}).limit, AI_READ_MAX_CHARS);
});

test('normalizeReadWindow: 行号模式与互斥校验', () => {
    assert.deepEqual(normalizeReadWindow({startLine: 5}), {mode: 'lines', startLine: 5, endLine: null});
    assert.deepEqual(normalizeReadWindow({startLine: 3, endLine: 9}), {mode: 'lines', startLine: 3, endLine: 9});
    assert.throws(() => normalizeReadWindow({offset: 1, startLine: 1}), /不能混用/);
    assert.throws(() => normalizeReadWindow({limit: 10, endLine: 2}), /不能混用/);
    assert.throws(() => normalizeReadWindow({startLine: 9, endLine: 2}), /不能小于/);
    assert.throws(() => normalizeReadWindow({limit: 0}), /limit 至少为 1/);
});

// —— readWindowOf ——

test('readWindowOf: 字符模式切片、截断与续读提示', () => {
    const text = 'a'.repeat(100) + '\n' + 'b'.repeat(100);
    const view = readWindowOf(text, {mode: 'chars', offset: 0, limit: 50});
    assert.equal(view.text, 'a'.repeat(50));
    assert.equal(view.truncated, true);
    assert.match(view.hint, /offset=50/);
    assert.equal(view.targetLine, 1);
    // 从第二行中间开始：targetLine 落在 2
    const view2 = readWindowOf(text, {mode: 'chars', offset: 120, limit: 10});
    assert.equal(view2.targetLine, 2);
    // offset 到末尾之外
    const view3 = readWindowOf(text, {mode: 'chars', offset: 9999, limit: 10});
    assert.equal(view3.text, '');
    assert.match(view3.hint, /文件末尾/);
});

test('readWindowOf: 行号模式带行号前缀、与编辑器行号一致', () => {
    const text = 'alpha\nbeta\ngamma\n';
    const view = readWindowOf(text, {mode: 'lines', startLine: 2, endLine: 3});
    // 末尾换行不算一行：共 3 行；前缀右对齐 + tab
    assert.equal(view.totalLines, 3);
    assert.equal(view.text, '2\tbeta\n3\tgamma\n');
    assert.equal(view.truncated, false);
    assert.equal(view.targetLine, 2);
});

test('readWindowOf: 行号模式 64KB 截断给续读 startLine', () => {
    const text = Array.from({length: 100}, (_, i) => 'x'.repeat(1000)).join('\n');
    const view = readWindowOf(text, {mode: 'lines', startLine: 1, endLine: null});
    assert.equal(view.truncated, true);
    assert.ok(view.nextStartLine > 1);
    assert.match(view.hint, /startLine=/);
    assert.equal(view.text.length + 'x'.repeat(0).length <= AI_READ_MAX_CHARS + view.text.split('\n').length, true);
});

test('readWindowOf: 行号超界给出总行数提示；CRLF 行尾去 \\r', () => {
    const view = readWindowOf('a\nb', {mode: 'lines', startLine: 99, endLine: null});
    assert.equal(view.text, '');
    assert.match(view.hint, /共 2 行/);
    const crlf = readWindowOf('a\r\nbeta\r\ngamma\r\n', {mode: 'lines', startLine: 1, endLine: 2});
    assert.equal(crlf.text, '1\ta\n2\tbeta\n');
    assert.equal(crlf.totalLines, 3);
});

// —— locateEditTarget ——

test('locateEditTarget: 唯一命中替换；多处命中报错或 replaceAll 全替换', () => {
    const text = 'foo bar foo';
    const one = locateEditTarget(text, 'bar', 'BAZ', false);
    assert.equal(one.next, 'foo BAZ foo');
    assert.equal(one.count, 1);
    const multi = locateEditTarget(text, 'foo', 'qux', false);
    assert.match(multi.error, /多处命中（2 处）/);
    assert.match(multi.error, /replaceAll/);
    const all = locateEditTarget(text, 'foo', 'qux', true);
    assert.equal(all.next, 'qux bar qux');
    assert.equal(all.count, 2);
});

test('locateEditTarget: CRLF 文件 LF 模式兜底重试', () => {
    const text = 'a\r\n  hello world\r\nb';
    const r = locateEditTarget(text, '\n  hello world\n', '\n  hi\n', false);
    assert.equal(r.next, 'a\r\n  hi\r\nb');
    assert.match(r.error || '', /^$/);
});

test('locateEditTarget: 未命中报错', () => {
    const r = locateEditTarget('abc', 'xyz', 'q', false);
    assert.match(r.error, /未找到 oldString/);
});

// —— humanSizeBytes ——

test('humanSizeBytes: 分级与尾零去除', () => {
    assert.equal(humanSizeBytes(0), '0B');
    assert.equal(humanSizeBytes(512), '512B');
    assert.equal(humanSizeBytes(1024), '1KB');
    assert.equal(humanSizeBytes(12.3 * 1024), '12.3KB');
    assert.equal(humanSizeBytes(5 * 1024 * 1024), '5MB');
});

test('humanSizeBytes: 非有限值与负数返回空串（调用方据此不显示大小）', () => {
    assert.equal(humanSizeBytes(-1), '');
    assert.equal(humanSizeBytes(NaN), '');
    assert.equal(humanSizeBytes(Infinity), '');
    assert.equal(humanSizeBytes('bad'), '');
});

// —— globMatchPath ——

test('globMatchPath: 文件名模式与路径模式', () => {
    assert.equal(globMatchPath('*.go', 'src/server.go', 'server.go'), true);
    assert.equal(globMatchPath('*.go', 'src/server.js', 'server.js'), false);
    assert.equal(globMatchPath('src/**/*.ts', 'src/a/b/c.ts', 'c.ts'), true);
    // **/ 可为零个目录段（与 Go 侧 globMatchPath 一致）
    assert.equal(globMatchPath('src/**/*.ts', 'src/c.ts', 'c.ts'), true);
    assert.equal(globMatchPath('src/**/*.ts', 'lib/a/b/c.ts', 'c.ts'), false);
    assert.equal(globMatchPath('src/*.ts', 'src/a/b/c.ts', 'c.ts'), false);
    assert.equal(globMatchPath('server?.go', 'src/server1.go', 'server1.go'), true);
    assert.equal(globMatchPath('SERVER.GO', 'src/server.go', 'server.go'), true);
    assert.equal(globMatchPath('', 'a/b.txt', 'b.txt'), true);
});

// —— normalizeFileUrlTarget ——

test('normalizeFileUrlTarget: 解码为本地路径并保留可导航地址', () => {
    const cases = [
        ['file:///D:/work/项目/page.html', 'D:/work/项目/page.html'],
        ['file:///d:/WORK/项目/sub/a%20b.html', 'd:/WORK/项目/sub/a b.html'],
        ['file:///D:/work/项目/%E4%B8%AD%E6%96%87.html', 'D:/work/项目/中文.html'],
        ['file://localhost/D:/work/项目/x.html', 'D:/work/项目/x.html'],
    ];
    for (const [url, path] of cases) {
        const target = normalizeFileUrlTarget(url);
        assert.equal(target.ok, true, url + ' 应解析：' + target.reason);
        assert.equal(target.path, path);
        assert.ok(target.url.startsWith('file:'));
    }
    // 片段留在导航地址里，不进本地路径
    const frag = normalizeFileUrlTarget('file:///D:/work/项目/p.html#sec');
    assert.equal(frag.path, 'D:/work/项目/p.html');
    assert.match(frag.url, /#sec$/);
});

test('normalizeFileUrlTarget: .. 与编码分隔符在解码后归一', () => {
    // URL 解析器会把 .. 归一（盘符为地板）
    assert.equal(normalizeFileUrlTarget('file:///D:/work/proj/../page.html').path, 'D:/work/page.html');
    assert.equal(normalizeFileUrlTarget('file:///D:/work/proj/../../../secret.txt').path, 'D:/secret.txt');
    // 编码的点段/分隔符解码后再归一（限制权限需要真实路径）
    assert.equal(normalizeFileUrlTarget('file:///D:/work/项目/%2e%2e/secret.txt').path, 'D:/work/secret.txt');
    assert.equal(normalizeFileUrlTarget('file:///D:/work/项目/a%2F..%2Fb.html').path, 'D:/work/项目/b.html');
    // 连 .. 也越不过盘符根
    assert.equal(normalizeFileUrlTarget('file:///D:/%2e%2e%2f%2e%2e%2fx.txt').ok, false);
});

test('normalizeFileUrlTarget: UNC 分享与非法形式', () => {
    const unc = normalizeFileUrlTarget('file://server/share/dir/x.html');
    assert.equal(unc.ok, true, unc.reason);
    assert.equal(unc.path, '//server/share/dir/x.html');
    const bad = [
        ['file:foo.html', /绝对路径/],          // 驱动器相对（file:///foo.html）
        ['file:///', /绝对路径/],
        ['file://server/', /绝对路径/],          // 缺分享名
        ['file://%zz', /格式无效/],
        ['https://example.com', /不是 file:/],
    ];
    for (const [url, re] of bad) {
        const target = normalizeFileUrlTarget(url);
        assert.equal(target.ok, false, url + ' 应拒绝');
        assert.match(target.reason, re);
    }
});

// —— renderDirTreeText（list_dir depth>1 的树状输出） ——

test('renderDirTreeText: ├──/└── 前缀、目录 / 后缀、文件带大小', () => {
    const nodes = [
        {name: 'ai', isDir: true, children: [
            {name: 'ai-panel.js', isDir: false, size: 524288},
            {name: 'defs.js', isDir: false, size: 300},
        ]},
        {name: 'core', isDir: true, children: []},
        {name: 'README.md', isDir: false, size: 2048},
    ];
    assert.deepEqual(renderDirTreeText(nodes), [
        '├── ai/',
        '│   ├── ai-panel.js（512KB）',
        '│   └── defs.js（300B）',
        '├── core/',
        '└── README.md（2KB）',
    ]);
});

test('renderDirTreeText: 最后一个子树的缩进与 Omitted 标记', () => {
    const nodes = [
        {name: 'a', isDir: true, children: [
            {name: 'x.js', isDir: false, size: 1},
        ]},
        {name: 'b', isDir: true, omitted: true, children: [
            {name: 'y.js', isDir: false, size: 2},
        ]},
    ];
    assert.deepEqual(renderDirTreeText(nodes), [
        '├── a/',
        '│   └── x.js（1B）',
        '└── b/',
        '    └── y.js（2B）',
        '    …（还有条目未列出）',
    ]);
});

test('renderDirTreeText: 空与非数组输入返回空行表（由调用方补「空目录」占位）', () => {
    assert.deepEqual(renderDirTreeText(null), []);
    assert.deepEqual(renderDirTreeText(undefined), []);
    assert.deepEqual(renderDirTreeText([]), []);
});

// —— attachmentPathHint（二进制/超大文件的路径引用）——

test('attachmentPathHint: 空路径返回空串（调用方据此跳过）', () => {
    assert.equal(attachmentPathHint('', 'binary'), '');
    assert.equal(attachmentPathHint(null, 'binary'), '');
    assert.equal(attachmentPathHint('   ', 'binary'), '');
});

test('attachmentPathHint: 始终带上路径与「未读入正文」说明', () => {
    const text = attachmentPathHint('D:\\docs\\report.pdf', 'binary');
    assert.match(text, /未读入正文/);
    assert.match(text, /report\.pdf/);
    assert.match(text, /D:\\docs\\report\.pdf/);
    assert.match(text, /处理建议/);
});

test('attachmentPathHint: 按扩展名给不同读法', () => {
    assert.match(attachmentPathHint('/a/b.pdf', 'binary'), /ocr/);
    assert.match(attachmentPathHint('/a/b.docx', 'binary'), /docx 技能/);
    assert.match(attachmentPathHint('/a/b.zip', 'binary'), /解压/);
    assert.match(attachmentPathHint('/a/b.png', 'binary'), /read_image/);
    assert.match(attachmentPathHint('/a/b.mp4', 'binary'), /read_video/);
    // 未知扩展名回落到 read_file
    assert.match(attachmentPathHint('/a/b.bin', 'binary'), /read_file/);
    // 无扩展名同样回落
    assert.match(attachmentPathHint('/a/Makefile', 'binary'), /read_file/);
});

test('attachmentPathHint: reason 区分「二进制」与「超过文本读取上限」', () => {
    assert.match(attachmentPathHint('/a/b.dat', 'binary'), /二进制文件/);
    assert.match(attachmentPathHint('/a/b.dat', 'large'), /超过文本读取上限/);
    // 未知 reason 按二进制兜底
    assert.match(attachmentPathHint('/a/b.dat', undefined), /二进制文件/);
});

test('attachmentPathHint: 扩展名大小写不敏感（正斜杠/反斜杠都能取到文件名）', () => {
    assert.match(attachmentPathHint('/a/B.PDF', 'binary'), /ocr/);
    assert.match(attachmentPathHint('D:\\a\\B.Zip', 'binary'), /解压/);
});
