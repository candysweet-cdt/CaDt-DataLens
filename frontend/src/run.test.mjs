// 运行代码的纯函数测试：配方表完整性、扩展名解析、版本门禁、ANSI 上色与位置引用识别。
// 用法：npm test（package.json 的 test 脚本里显式列出本文件）
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    RECIPES, extOf, stemOf, joinPath, cmdText, versionOf, versionAtLeast,
    ansiSegments, splitRefs, splitRunArgs,
} from './run.js';

test('配方表：每项都有 run，编译型必须有 build 与 outExt', () => {
    for (const [ext, recipe] of Object.entries(RECIPES)) {
        assert.equal(typeof recipe.run, 'function', ext + ' 缺少 run');
        assert.ok(recipe.lang, ext + ' 缺少 lang');
        assert.ok(recipe.label, ext + ' 缺少 label');
        if (recipe.build) {
            assert.equal(typeof recipe.build, 'function', ext + ' 的 build 不是函数');
            assert.equal(recipe.outExt, '.exe', ext + ' 的编译产物后缀应为 .exe');
        } else {
            assert.ok(recipe.tool || recipe.shell, ext + ' 需要 tool 或 shell');
        }
        assert.equal(ext, ext.toLowerCase(), ext + '：配方键必须小写');
    }
});

test('配方表：C/C++/Rust 走两段式，语言与工具对应', () => {
    assert.equal(RECIPES.c.tool, 'c');
    assert.equal(RECIPES.cpp.tool, 'cpp');
    assert.equal(RECIPES.rs.tool, 'rust');
    assert.ok(RECIPES.c.build && RECIPES.cpp.build && RECIPES.rs.build);
    const build = RECIPES.c.build({file: 'a.c', out: 'C:\\tmp\\a.exe'});
    assert.deepEqual(build, ['-O0', '-g', '-o', 'C:\\tmp\\a.exe', 'a.c']);
    const run = RECIPES.c.run({args: ['x'], out: 'C:\\tmp\\a.exe'});
    assert.deepEqual(run, ['C:\\tmp\\a.exe', 'x']);
});

test('配方表：解释型参数顺序正确', () => {
    assert.deepEqual(RECIPES.py.run({file: 'a.py', args: ['1']}), ['-u', 'a.py', '1']);
    assert.deepEqual(RECIPES.go.run({file: 'a.go', args: []}), ['run', 'a.go']);
    assert.deepEqual(RECIPES.java.run({file: 'A.java', args: []}), ['A.java']);
    assert.deepEqual(RECIPES.ps1.run({file: 'a.ps1', args: []}), ['-NoLogo', '-NoProfile', '-File', 'a.ps1']);
});

test('extOf / stemOf 处理 Windows 路径与大小写', () => {
    assert.equal(extOf('D:\\data\\Main.PY'), 'py');
    assert.equal(extOf('a.b.cpp'), 'cpp');
    assert.equal(extOf('noext'), '');
    assert.equal(stemOf('D:\\x\\hello.world.py'), 'hello.world');
    assert.equal(stemOf('.gitignore'), '.gitignore');
});

test('joinPath / cmdText 处理路径分隔符与带空格参数', () => {
    assert.equal(joinPath('C:\\temp\\run-1', 'main.c'), 'C:\\temp\\run-1\\main.c');
    assert.equal(joinPath('C:/temp/', 'main.c'), 'C:/temp/main.c');
    assert.equal(joinPath('', 'main.c'), 'main.c');
    assert.equal(cmdText('gcc', ['-o', 'C:\\a b\\x.exe', 'm.c']), 'gcc -o "C:\\a b\\x.exe" m.c');
});

test('versionOf / versionAtLeast 取第一组 x.y 做门禁', () => {
    assert.deepEqual(versionOf('Python 3.12.1'), [3, 12]);
    assert.deepEqual(versionOf('v20.11.0'), [20, 11]);
    assert.deepEqual(versionOf('openjdk version "17.0.2" 2022-01-18'), [17, 0]);
    assert.equal(versionOf('无版本'), null);
    assert.equal(versionAtLeast([22, 6], [22, 6]), true);
    assert.equal(versionAtLeast([22, 5], [22, 6]), false);
    assert.equal(versionAtLeast([20, 11], [22, 6]), false);
    assert.equal(versionAtLeast(null, [11, 0]), true, '版本未知时不拦');
});

test('ansiSegments：普通文本、颜色、加粗与重置', () => {
    const plain = ansiSegments('hello');
    assert.equal(plain.length, 1);
    assert.equal(plain[0].text, 'hello');
    assert.match(plain[0].cls, /run-t/);

    const colored = ansiSegments('\u001b[31mred\u001b[0m normal');
    assert.equal(colored[0].text, 'red');
    assert.match(colored[0].cls, /run-fg-1/);
    assert.equal(colored[1].text, ' normal');
    assert.doesNotMatch(colored[1].cls, /run-fg/);

    const bold = ansiSegments('\u001b[1mb\u001b[22mc');
    assert.match(bold[0].cls, /run-bold/);
    assert.doesNotMatch(bold[1].cls, /run-bold/);
});

test('ansiSegments：非 SGR 转义序列被丢弃，不污染文本', () => {
    const segs = ansiSegments('\u001b[2K\u001b[1Gdone');
    assert.equal(segs.map((s) => s.text).join(''), 'done');
});

test('splitRefs：gcc / node / rustc 的 path:line:col', () => {
    const parts = splitRefs('D:\\work\\main.c:12:5: error: expected');
    const ref = parts.find((p) => p.ref);
    assert.ok(ref, '应识别出位置引用');
    assert.equal(ref.ref.path, 'D:\\work\\main.c');
    assert.equal(ref.ref.line, 12);
    assert.equal(ref.ref.col, 5);
});

test('splitRefs：Python traceback 的 File "x", line N', () => {
    const parts = splitRefs('  File "C:\\a\\b.py", line 7, in <module>');
    const ref = parts.find((p) => p.ref);
    assert.ok(ref, '应识别出 traceback 位置');
    assert.equal(ref.ref.path, 'C:\\a\\b.py');
    assert.equal(ref.ref.line, 7);
});

test('splitRefs：普通文本不误判为路径', () => {
    const parts = splitRefs('hello world: 3 items');
    assert.equal(parts.filter((p) => p.ref).length, 0);
    assert.equal(parts.map((p) => p.text).join(''), 'hello world: 3 items');
});

test('splitRunArgs：空白分隔、引号成组、转义引号', () => {
    assert.deepEqual(splitRunArgs('a b  c'), ['a', 'b', 'c']);
    assert.deepEqual(splitRunArgs('--name "hello world" --n 3'), ['--name', 'hello world', '--n', '3']);
    assert.deepEqual(splitRunArgs("--path 'C://my docs\\a.txt'"), ['--path', 'C://my docs\\a.txt']);
    assert.deepEqual(splitRunArgs('say \\"hi\\"'), ['say', '"hi"']);
});

test('splitRunArgs：Windows 路径里的反斜杠原样保留', () => {
    assert.deepEqual(splitRunArgs('D://data//2026//in.csv --out out.csv'),
        ['D://data//2026//in.csv', '--out', 'out.csv']);
});

test('splitRunArgs：空串与未闭合引号不抛错', () => {
    assert.deepEqual(splitRunArgs(''), []);
    assert.deepEqual(splitRunArgs('   \t '), []);
    assert.deepEqual(splitRunArgs('"half open'), ['half open']);
    assert.deepEqual(splitRunArgs('a "" b'), ['a', '', 'b']);
});

test('配方：运行参数只进执行步骤，不进编译步骤', () => {
    const ctx = {file: 'main.c', dir: '.', out: 'main.exe', args: ['one', 'two']};
    assert.deepEqual(RECIPES.c.build(ctx), ['-O0', '-g', '-o', 'main.exe', 'main.c']);
    assert.deepEqual(RECIPES.c.run(ctx), ['main.exe', 'one', 'two']);
    assert.deepEqual(RECIPES.rs.run(ctx), ['main.exe', 'one', 'two']);
    assert.deepEqual(RECIPES.py.run(ctx), ['-u', 'main.c', 'one', 'two']);
});

test('配方：脚本解释器同样接收运行参数', () => {
    const ctx = {file: 'a.sh', dir: '.', out: '', args: ['x']};
    assert.deepEqual(RECIPES.sh.run(ctx), ['a.sh', 'x']);
    assert.deepEqual(RECIPES.bat.run(ctx), ['/c', 'a.sh', 'x']);
    assert.deepEqual(RECIPES.ps1.run(ctx), ['-NoLogo', '-NoProfile', '-File', 'a.sh', 'x']);
});
