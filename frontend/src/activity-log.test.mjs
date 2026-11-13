import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createActivityLog, sanitizeDetail, ACTIVITY_DOMAINS} from './activity-log.js';

function fakeBackend() {
    const calls = [];
    return {
        calls,
        ActivityAppend(payload) {
            calls.push(JSON.parse(payload));
            return Promise.resolve();
        },
    };
}

function lastEntries(backend) {
    assert.ok(backend.calls.length > 0, 'ActivityAppend 未被调用');
    return backend.calls[backend.calls.length - 1].entries;
}

test('sanitizeDetail 打码秘密键', () => {
    const out = sanitizeDetail({apiKey: 'sk-123', password: 'p', nested: {token: 't', note: 'ok'}});
    assert.equal(out.apiKey, '***');
    assert.equal(out.password, '***');
    assert.equal(out.nested.token, '***');
    assert.equal(out.nested.note, 'ok');
});

test('sanitizeDetail 命中键名包含秘密词的大小写变体', () => {
    const out = sanitizeDetail({APIKEY: 'a', BearerToken: 'b', my_secret: 's'});
    assert.equal(out.APIKEY, '***');
    assert.equal(out.BearerToken, '***');
    assert.equal(out.my_secret, '***');
});

test('sanitizeDetail 长文本替换', () => {
    const out = sanitizeDetail({short: 'ok', long: 'x'.repeat(201)});
    assert.equal(out.short, 'ok');
    assert.equal(out.long, '<长文本>');
});

test('sanitizeDetail 数组只记长度，深对象截断', () => {
    const out = sanitizeDetail({list: [1, 2, 3], deep: {a: {b: {c: {d: 1}}}}});
    assert.deepEqual(out.list, {length: 3});
    assert.equal(out.deep.a.b, '{…}');
});

test('sanitizeDetail 超大对象整体截断', () => {
    const big = {};
    for (let i = 0; i < 50; i++) big['k' + i] = 'v'.repeat(80);
    const out = sanitizeDetail(big);
    assert.deepEqual(out, {truncated: true});
});

test('sanitizeDetail 非对象 detail 包一层，null 丢弃', () => {
    assert.deepEqual(sanitizeDetail('文本'), {value: '文本'});
    assert.equal(sanitizeDetail(null), undefined);
    assert.equal(sanitizeDetail(undefined), undefined);
});

test('log 走格式化 + 攒批 + flush 一次投递', async () => {
    const backend = fakeBackend();
    const logSvc = createActivityLog({backend, settings: {activityLog: true, activityRetentionMonths: 12}});
    logSvc.log('file.open', 'a.json', {format: 'json', size: 10});
    logSvc.log('file.save', 'a.json', {bytes: 10, mode: 'save'});
    assert.equal(backend.calls.length, 0, '未 flush 不应投递');
    logSvc.flush();
    assert.equal(backend.calls.length, 1);
    const entries = lastEntries(backend);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].action, 'file.open');
    assert.equal(entries[0].v, 1);
    assert.equal(entries[0].actor, 'user');
    assert.equal(entries[0].source, 'user');
    assert.ok(entries[0].ts > 0);
    assert.ok(typeof entries[0].seq === 'number');
    assert.deepEqual(backend.calls[0].retentionMonths, 12);
    await Promise.resolve(); // ActivityAppend 返回的 Promise 不应产生未处理拒绝
});

test('log 支持 actor/source 与 relativize', () => {
    const backend = fakeBackend();
    const logSvc = createActivityLog({
        backend,
        settings: {},
        relativize: (p) => (p.startsWith('D:/ws/') ? p.slice(6) : p),
    });
    logSvc.log('file.format', 'D:/ws/main.js', null, {actor: 'ai', source: 'ai'});
    logSvc.flush();
    const entries = lastEntries(backend);
    assert.equal(entries[0].target, 'main.js');
    assert.equal(entries[0].actor, 'ai');
    assert.equal(entries[0].source, 'ai');
    assert.equal(entries[0].detail, undefined);
});

test('关闭开关后 log/flush 都不落盘', () => {
    const backend = fakeBackend();
    let conf = {activityLog: true};
    const logSvc = createActivityLog({backend, settings: () => conf});
    logSvc.log('tab.switch', 'a', {});
    logSvc.flush();
    assert.equal(backend.calls.length, 1);
    backend.calls.length = 0;
    conf = {activityLog: false};
    logSvc.log('tab.switch', 'a', {});
    logSvc.flush();
    assert.equal(backend.calls.length, 0);
});

test('攒满 20 条自动投递', () => {
    const backend = fakeBackend();
    const logSvc = createActivityLog({backend, settings: {}});
    for (let i = 0; i < 20; i++) {
        logSvc.log('tab.switch', 't' + i, {});
    }
    assert.equal(backend.calls.length, 1, '第 20 条应触发自动投递');
    assert.equal(lastEntries(backend).length, 20);
});

test('retentionMonths 钳制到 1–60', () => {
    const backend = fakeBackend();
    const logSvc = createActivityLog({backend, settings: {activityRetentionMonths: 500}});
    logSvc.log('file.open', 'a', {});
    logSvc.flush();
    assert.equal(backend.calls[0].retentionMonths, 60);
});

test('backend 缺少 ActivityAppend 时静默', () => {
    const logSvc = createActivityLog({backend: {}, settings: {}});
    assert.doesNotThrow(() => {
        logSvc.log('file.open', 'a', {});
        logSvc.flush();
    });
});

test('ACTIVITY_DOMAINS 覆盖全部动作大类', () => {
    assert.ok(ACTIVITY_DOMAINS.includes('file'));
    assert.ok(ACTIVITY_DOMAINS.includes('ai'));
    assert.ok(ACTIVITY_DOMAINS.includes('activity'));
});

// 静态断言（方案 §8）：每个 P0/P1 action 在触发点代码里都有字面量调用。
test('每个操作事件都有触发点', () => {
    const dir = new URL('./', import.meta.url);
    const files = ['main.js', 'ai/ai-panel.js', 'mode-switch.js', 'settings-ui.js', 'writing-ui.js', 'editor-groups.js', 'terminal-ui.js', 'bridge-ui.js', 'quick-switch.js', 'menu-bar.js', 'session-restore.js', 'app-actions.js', 'properties-ui.js', 'update-check.js'];
    const src = files.map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
    const required = [
        'file.open', 'file.save', 'file.saveAs', 'file.create', 'file.delete', 'file.rename', 'file.move', 'file.format',
        'tab.open', 'tab.switch', 'tab.close', 'tab.closeDirty', 'tab.reopen',
        'workspace.open', 'view.switch', 'plugin.change', 'settings.change',
        'ai.session', 'ai.approve', 'ai.deny', 'ai.tool',
    ];
    for (const action of required) {
        assert.ok(src.includes(`'${action}'`), `缺少触发点：${action}`);
    }
});
