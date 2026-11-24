// 版本号同步脚本的护栏：解析口径 + 仓库当前五处一致 + 改写只动版本字段。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const {SPECS, applyVersion, parseAppVersion} = await import(
    pathToFileURL(join(root, 'scripts', 'sync-version.mjs')).href
);
const read = (rel) => readFileSync(join(root, rel), 'utf8');

test('parseAppVersion 去掉 v 前缀', () => {
    assert.equal(parseAppVersion('const appVersion = "v1.2.3"'), '1.2.3');
    assert.equal(parseAppVersion('const appVersion = "1.2.3"'), '1.2.3');
});

test('parseAppVersion 拒绝非版本号', () => {
    assert.throws(() => parseAppVersion('package main'), /找不到/);
    assert.throws(() => parseAppVersion('const appVersion = "v1.2"'), /不是 vX\.Y\.Z/);
});

test('仓库里五处版本文件与 appVersion 一致', () => {
    const version = parseAppVersion(read('app_core.go'));
    for (const spec of SPECS) {
        const text = read(spec.file);
        const {next, hits} = applyVersion(spec, text, version);
        assert.equal(hits, spec.expect, `${spec.label}：版本字段数变化，检查文件结构`);
        assert.equal(next, text, `${spec.label} 与 appVersion ${version} 不一致，跑 node scripts/sync-version.mjs`);
    }
});

test('改写只碰版本值，改回去能还原原文', () => {
    const version = parseAppVersion(read('app_core.go'));
    for (const spec of SPECS) {
        const text = read(spec.file);
        const bumped = applyVersion(spec, text, '9.9.9').next;
        assert.notEqual(bumped, text, `${spec.label} 没有可改写的版本字段`);
        assert.equal(bumped.includes('"9.9.9"'), true, `${spec.label} 未写入新版本`);
        assert.equal(applyVersion(spec, bumped, version).next, text, `${spec.label} 改写不可逆`);
    }
});
