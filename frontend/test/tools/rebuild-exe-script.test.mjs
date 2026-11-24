// 一键重建脚本的图标资源与 Shell 缓存刷新护栏。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const script = readFileSync(join(root, 'tools', 'rebuild-exe.ps1'), 'utf8');

test('rebuild-exe 校验 syso 非空，避免无图标资源静默构建', () => {
    assert.ok(script.includes('Test-Path -LiteralPath $syso'));
    assert.ok(script.includes('Length -lt 1024'));
    assert.ok(script.includes('wails3 generate syso 未生成有效资源文件'));
});

test('rebuild-exe 先移走旧文件，避免同名覆盖保留白页缓存', () => {
    const renameAt = script.indexOf('Rename-Item -LiteralPath $target -Destination $aside -Force');
    const clearAt = script.indexOf('Clear-ShellIcon $target');
    const copyAt = script.indexOf('Copy-Item $binExe $target -Force');
    const updateAt = script.indexOf('Update-ShellIcon $target');
    assert.ok(renameAt > 0 && clearAt > renameAt && copyAt > clearAt && updateAt > copyAt);
});

test('rebuild-exe 通知 Shell 删除旧项并刷新新项图标缓存', () => {
    assert.ok(script.includes('function Notify-ShellFile([string]$Path, [int]$EventId)'));
    assert.ok(script.includes('SHChangeNotify($EventId, 0x00000005, $Path, $null)'));
    assert.ok(script.includes('Notify-ShellFile $Path 0x00000000'));
    assert.ok(script.includes('Notify-ShellFile $Path 0x00002000'));
    assert.ok(script.includes('Notify-ShellFile $Path 0x00000002'));
});
