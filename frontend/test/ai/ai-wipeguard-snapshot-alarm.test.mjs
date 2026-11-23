// L3 快照告警的节流决策与错误收敛（2026-11-21 frontend\nul 连败 13 轮、只有调试日志的教训）：
// 失败 / 跳过文件要升级进消息中心，同一车道 30 分钟最多打扰一次，连击计数进文案。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    snapshotAlarmDecide,
    snapshotAlarmReset,
    compactSnapshotError,
    WIPEGUARD_SNAPSHOT_ALARM_COOLDOWN_MS,
} from '../../src/ai/security/ai-wipeguard.js';

const T0 = 1_000_000_000_000;
const COOL = WIPEGUARD_SNAPSHOT_ALARM_COOLDOWN_MS;

test('失败首轮必通知，冷却期内静默但连击累计', () => {
    const d1 = snapshotAlarmDecide(null, T0, 'error');
    assert.equal(d1.notify, true);
    assert.equal(d1.streak, 1);
    const d2 = snapshotAlarmDecide(d1.next, T0 + 60_000, 'error');
    assert.equal(d2.notify, false, '30 分钟内的后续失败只累计不打扰');
    assert.equal(d2.streak, 2);
    const d3 = snapshotAlarmDecide(d2.next, T0 + COOL + 1, 'error');
    assert.equal(d3.notify, true, '冷却过后再次通知');
    assert.equal(d3.streak, 3);
});

test('干净成功重置连击：下一轮失败重新算第 1 次', () => {
    let state = snapshotAlarmDecide(null, T0, 'error').next;
    state = snapshotAlarmDecide(state, T0 + 1, 'error').next; // streak=2
    const clean = snapshotAlarmReset();
    const d = snapshotAlarmDecide(clean, T0 + 2, 'error');
    assert.equal(d.streak, 1);
    assert.equal(d.notify, true);
});

test('error 与 excluded 两条车道互不挤占', () => {
    let state = snapshotAlarmDecide(null, T0, 'error').next;
    // 失败刚通知过（error 车道冷却中），同刻出现跳过文件仍应通知
    const d = snapshotAlarmDecide(state, T0 + 1000, 'excluded');
    assert.equal(d.notify, true);
    assert.equal(d.streak, 1, 'excluded 不动失败连击');
    // 反向：excluded 冷却中不影响 error 车道的首报
    const d2 = snapshotAlarmDecide(snapshotAlarmReset(), T0, 'excluded');
    assert.equal(d2.notify, true);
    const d3 = snapshotAlarmDecide(d2.next, T0 + 1, 'error');
    assert.equal(d3.notify, true, 'error 车道首报不受 excluded 冷却影响');
    assert.equal(d3.streak, 1);
});

test('excluded 车道自己也守 30 分钟冷却', () => {
    let state = snapshotAlarmDecide(null, T0, 'excluded').next;
    const d = snapshotAlarmDecide(state, T0 + COOL - 1, 'excluded');
    assert.equal(d.notify, false);
});

test('compactSnapshotError 取最后一条 fatal/error 行并截断', () => {
    const raw = 'git [add -A]: exit status 128: error: open("frontend/nul"): No such file or directory\n' +
        "error: unable to index file 'frontend/nul'\n" +
        'fatal: adding files failed';
    assert.equal(compactSnapshotError(raw), 'fatal: adding files failed');
    const long = 'fatal: ' + 'x'.repeat(500);
    const capped = compactSnapshotError(long, 200);
    assert.equal(capped.length, 201);
    assert.ok(capped.endsWith('…'));
    assert.equal(compactSnapshotError(''), '未知错误');
    assert.equal(compactSnapshotError(undefined), '未知错误');
});
