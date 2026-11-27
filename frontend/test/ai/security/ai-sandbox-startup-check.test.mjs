// ai-sandbox-startup-check.test.mjs —— 启动沙箱残留自检（纯工厂测试）。
// 覆盖：无残留静默 / 有残留提示且确认后 Revoke / Scan 失败静默 / 同根只检查一次。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSandboxStartupCheck} from '../../../src/ai/security/ai-sandbox-startup-check.js';

function makeMod(state, options = {}) {
    const calls = {scan: [], revoke: [], confirm: [], flash: [], log: []};
    const mod = createSandboxStartupCheck({
        backend: {
            async SandboxScan(root) {
                calls.scan.push(root);
                if (options.scanError) throw new Error('scan failed');
                return state;
            },
            async SandboxRevoke(root) {
                calls.revoke.push(root);
                if (options.revokeError) throw new Error('revoke failed');
                return {root, granted: false, denyPresent: false, labeled: false};
            },
        },
        currentRoot: () => options.root === undefined ? 'D:/ws' : options.root,
        openConfirmDialog: (message, action) => calls.confirm.push({message, action}),
        flash: (message, isError) => calls.flash.push({message, isError}),
        logFrontend: (level, message) => calls.log.push({level, message}),
    });
    return {mod, calls};
}

const clean = {root: 'D:/ws', granted: false, denyPresent: false, labeled: false};
const dirty = {root: 'D:/ws', granted: true, denyPresent: true, labeled: true};

test('无残留：只 Scan，不提示、不 Revoke', async () => {
    const {mod, calls} = makeMod(clean);
    await mod.check();
    assert.deepEqual(calls.scan, ['D:/ws']);
    assert.equal(calls.confirm.length, 0);
    assert.equal(calls.revoke.length, 0);
});

test('有残留：提示用户确认，确认后才 Revoke', async () => {
    const {mod, calls} = makeMod(dirty);
    await mod.check();
    assert.equal(calls.confirm.length, 1);
    assert.match(calls.confirm[0].message, /Low 完整性标签/);
    assert.equal(calls.revoke.length, 0, '提示阶段不能擅自清理');
    await calls.confirm[0].action();
    assert.deepEqual(calls.revoke, ['D:/ws']);
    assert.equal(calls.flash.length, 1);
    assert.match(calls.flash[0].message, /已清除/);
});

test('Scan 失败：静默记日志，不提示、不 Revoke', async () => {
    const {mod, calls} = makeMod(clean, {scanError: true});
    await mod.check();
    assert.equal(calls.confirm.length, 0);
    assert.equal(calls.revoke.length, 0);
    assert.equal(calls.log.length, 1);
    assert.equal(calls.log[0].level, 'warn');
});

test('Revoke 失败：错误走 flash，不抛出打断启动', async () => {
    const {mod, calls} = makeMod(dirty, {revokeError: true});
    await mod.check();
    await calls.confirm[0].action();
    assert.equal(calls.flash.length, 1);
    assert.equal(calls.flash[0].isError, true);
});

test('同一工作区只检查一次；无工作区不检查', async () => {
    const {mod, calls} = makeMod(clean);
    await mod.check();
    await mod.check();
    assert.deepEqual(calls.scan, ['D:/ws']);
    const empty = makeMod(clean, {root: ''});
    await empty.mod.check();
    assert.deepEqual(empty.calls.scan, []);
});
