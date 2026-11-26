// 路径归一化「唯一实现」的守卫。
//
// 背景（2026-11-26 普查）：`replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase()` 这个
// 完整三段式在 src/ 下出现 **19 处、11 个文件**，另有 45 处半截变体、112 处单独转斜杠。
// 危险的不是重复本身，是**边界判定重复**：`startsWith(root + '/')` 少写那个 `/`，
// 就会把 `D:/a/bc` 当成 `D:/a/b` 的子路径 —— 不报错，只在某个目录名恰好多两个字符时出错。
//
// 本守卫锁三件事：
//   1. 完整三段式只允许出现在 core/path-key.js（唯一实现）；
//   2. core/path-key.js 必须导出约定的 API；
//   3. 「同形不同义」的实现必须留在各自位置（不能被误合并）——以白名单形式固定。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join, relative} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '../../src');

function walkJs(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walkJs(p, out);
        else if (name.endsWith('.js')) out.push(p);
    }
    return out;
}

const rel = (p) => relative(srcRoot, p).replace(/\\/g, '/');

// 完整三段式的字面形态（用字符码拼，避免本文件自己被转义搞晕）
const BS = String.fromCharCode(92);
const Q = String.fromCharCode(39);
const TRIPLE = [
    '.replace(/', BS, BS, '/g, ', Q, '/', Q, ')',
    '.replace(/', BS, '/+$/, ', Q, Q, ')',
    '.toLowerCase()',
].join('');

// 允许出现完整三段式的位置：只有唯一实现本身，以及 dev mock（克隆真实后端行为）。
const TRIPLE_ALLOWED = {
    'core/path-key.js': '唯一实现（legacyPathKey 的函数体）',
};

test('完整三段式只允许出现在 core/path-key.js', () => {
    const offenders = [];
    for (const file of walkJs(srcRoot)) {
        const name = rel(file);
        const text = readFileSync(file, 'utf8');
        if (!text.includes(TRIPLE)) continue;
        if (TRIPLE_ALLOWED[name]) continue;
        offenders.push(name);
    }
    assert.deepEqual(offenders, [],
        '这些文件又写了一遍「转斜杠 + 去尾斜杠 + 转小写」：请改用 core/path-key.js 的 '
        + 'legacyPathKey / fsPathEquals / fsPathContains。重复实现本身不可怕，'
        + '可怕的是**目录段包含**的边界各写一遍——漏一个 `/` 就会把 D:/a/bc 误判成 D:/a/b 的子路径。\n'
        + offenders.join('\n'));
});

test('core/path-key.js 导出约定的 API', () => {
    const core = readFileSync(join(srcRoot, 'core/path-key.js'), 'utf8');
    for (const name of ['toPosixPath', 'stripTrailingSlashes', 'legacyPathKey',
        'fsPathEquals', 'fsPathContains', 'relativeToFsRoot']) {
        assert.match(core, new RegExp('export function ' + name + '\\('), '缺导出 ' + name);
    }
    // 边界必须有分隔符（这是本模块存在的核心理由）
    assert.match(core, /p\.startsWith\(r \+ '\/'\)/,
        'fsPathContains 的边界必须带分隔符，否则 D:/a/bc 会被判成 D:/a/b 的子路径');
});

test('fsPathContains / relativeToFsRoot 行为正确（含边界）', async () => {
    const mod = await import('../../src/core/path-key.js');
    const {fsPathContains, relativeToFsRoot, fsPathEquals, legacyPathKey} = mod;

    // 大小写、斜杠方向、尾斜杠都不敏感
    assert.equal(fsPathEquals('D:\\a\\b', 'd:/a/b/'), true);
    assert.equal(legacyPathKey('D:\\a\\b\\'), 'd:/a/b');

    // 边界：D:/a/bc 不是 D:/a/b 的子路径
    assert.equal(fsPathContains('D:/a/b', 'D:/a/bc'), false, '漏分隔符会把这判成 true');
    assert.equal(fsPathContains('D:/a/b', 'D:/a/b/c'), true);
    assert.equal(fsPathContains('D:/a/b', 'D:/a/b'), true, '根自身算包含');
    assert.equal(fsPathContains('', 'D:/a'), false, '空根不包含任何东西');
    assert.equal(fsPathContains('D:/a/b', ''), false, '空路径不算包含');

    // 相对路径保留原大小写（展示/传后端要用原串）
    assert.equal(relativeToFsRoot('D:/Repo', 'd:/repo/Src/File.ts'), 'Src/File.ts');
    assert.equal(relativeToFsRoot('D:/Repo', 'D:/Repo'), '');
    assert.equal(relativeToFsRoot('D:/Repo', 'D:/Other/x'), '');
});

test('同形不同义：这些实现必须留在原地（不能误合并）', () => {
    // 每条都要有「为什么不合并」的依据，否则下一个人会把它们收编掉，然后行为漂移。
    const mustStay = [
        // 含点段解析 + 保留 scheme/盘符：输出是 Go 侧 WorkspaceBucketKey 的 sha256 输入
        ['ai/session/ai-session-scope.js', /export function workspaceKey/],
        // wipeguard per-root 状态表 key：UNC `//` 与 scheme 的口径与上面故意不同
        ['ai/security/ai-wipeguard.js', /export function normalizeWsKey/],
        // 安全边界：越界必须**拒绝**而非静默归一（`..` 语义与 legacyPathKey 相反）
        ['ai/tools/ai-file-tools.js', /export function resolveWithinRoot/],
        // JSONPath 段转义（['a\\b']），与文件系统无关，只是形态像
        ['core/jsonpath.js', /export function jsonPathKey/],
    ];
    for (const [file, pattern] of mustStay) {
        const text = readFileSync(join(srcRoot, file), 'utf8');
        assert.match(text, pattern, file + ' 的唯一实现不该被合并掉');
    }
});
