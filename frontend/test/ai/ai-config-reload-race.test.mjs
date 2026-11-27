// ai-config-reload-race.test.mjs：配置热重读与本地保存的并发回归。
// 直接执行 ai-panel.js 中的真实 reload 函数（依赖用最小桩注入），锁定「迟到旧快照
// 不得覆盖新会话 / 新设置」；另以源码接线守卫确认 saveAIConfig 会使在飞读取失效。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setImmediate} from 'node:timers/promises';

const panel = readFileSync(new URL('../../src/ai/ai-panel.js', import.meta.url), 'utf8');

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return {promise, resolve};
}

function reloadFunctionSource() {
    const start = panel.indexOf('    async function reloadAIConfigFromDisk() {');
    const end = panel.indexOf('\n    // 浮窗是独立进程', start);
    assert.ok(start >= 0 && end > start, '找不到 reloadAIConfigFromDisk');
    return panel.slice(start, end);
}

function createHarness(options) {
    const opts = options || {};
    const state = {
        config: opts.config,
        readCalls: 0,
        applied: 0,
        refreshed: 0,
        writeChain: opts.writeChain || Promise.resolve(),
    };
    const deps = {
        initialConfig: opts.config,
        whenConfigReady: async () => {},
        configUseDisk: () => true,
        backend: {
            AIConfigRead: () => {
                state.readCalls += 1;
                return opts.read();
            },
        },
        normalizeAIConfig: (value) => value,
        cloneConfig: (value) => JSON.parse(JSON.stringify(value)),
        configForSave: () => state.config,
        applyLoadedAIConfig: () => { state.applied += 1; },
        syncPluginAIAccounts: () => {},
        refreshSettingsPane: () => {},
        refreshChatSettings: () => {},
        refreshPromptSettings: () => {},
        renderProfileSelect: () => {},
        updateComposerState: () => {},
        refreshSystemPromptEstimate: () => {},
        modelCatalog: {autoSync: async () => {}},
        imagePolicy: {load: async () => {}},
        adoptWorkspaceSession: () => { state.refreshed += 1; return true; },
        refreshSessionUI: () => {},
        windowWorkspacePath: () => 'W',
        aiWorkspaceKey: (value) => value,
        initialState: state,
    };
    const names = Object.keys(deps);
    const api = new Function(...names, `
        let config = initialConfig;
        let lastConfigText = '';
        let lastConfigLoadAt = 0;
        let lastConfigDiskText = '';
        let lastConfigSnapshot = null;
        let configSealedBroken = false;
        let configWriteChain = initialState.writeChain;
        let configReadSeq = 0;
        let configMutationSeq = 0;
        ${reloadFunctionSource()}
        return {
            reload: reloadAIConfigFromDisk,
            setConfig: (next) => { config = next; initialState.config = next; },
            markMutation: () => { configMutationSeq += 1; },
            setWriteChain: (next) => { configWriteChain = next; },
            current: () => config,
        };
    `)(...names.map((name) => deps[name]));
    return {api, state};
}

const oldConfig = {activeSessionId: 'old', activeSessionByWorkspace: {W: 'old'}};
const newConfig = {activeSessionId: 'new', activeSessionByWorkspace: {W: 'new'}};

test('读取期间切到新会话：迟到旧快照不得把 currentSession 覆盖回老会话', async () => {
    const readResult = deferred();
    const readStarted = deferred();
    const {api, state} = createHarness({
        config: oldConfig,
        read: () => { readStarted.resolve(); return readResult.promise; },
    });
    const pending = api.reload();
    await readStarted.promise;
    api.setConfig(newConfig);
    api.markMutation(); // 等价于 newSession -> saveAIConfig
    readResult.resolve(JSON.stringify(oldConfig));
    await pending;
    assert.equal(api.current().activeSessionByWorkspace.W, 'new');
    assert.equal(state.applied, 0, '过期快照不能进入配置应用链');
    assert.equal(state.refreshed, 0, '不能因此触发会话视图回退');
});

test('没有本地变更：正常应用磁盘新配置', async () => {
    const readResult = deferred();
    const readStarted = deferred();
    const {api, state} = createHarness({
        config: oldConfig,
        read: () => { readStarted.resolve(); return readResult.promise; },
    });
    const pending = api.reload();
    await readStarted.promise;
    readResult.resolve(JSON.stringify(newConfig));
    await pending;
    assert.equal(api.current().activeSessionByWorkspace.W, 'new');
    assert.equal(state.applied, 1);
    assert.equal(state.refreshed, 1);
});

test('并发读取乱序返回：只允许最新一次读取落地', async () => {
    const first = deferred();
    const second = deferred();
    const firstStarted = deferred();
    const secondStarted = deferred();
    let calls = 0;
    const {api, state} = createHarness({
        config: oldConfig,
        read: () => {
            calls += 1;
            if (calls === 1) { firstStarted.resolve(); return first.promise; }
            secondStarted.resolve();
            return second.promise;
        },
    });
    const pendingFirst = api.reload();
    await firstStarted.promise;
    const pendingSecond = api.reload();
    await secondStarted.promise;
    const latest = {activeSessionId: 'latest', activeSessionByWorkspace: {W: 'latest'}};
    second.resolve(JSON.stringify(latest));
    await pendingSecond;
    first.resolve(JSON.stringify(newConfig));
    await pendingFirst;
    assert.equal(api.current().activeSessionByWorkspace.W, 'latest');
    assert.equal(state.applied, 1, '旧读取必须整份丢弃');
});

test('重读先等已排队写盘：避免读到尚未落盘的新会话', async () => {
    const writeDone = deferred();
    const readResult = deferred();
    const readStarted = deferred();
    const {api} = createHarness({
        config: oldConfig,
        writeChain: writeDone.promise,
        read: () => { readStarted.resolve(); return readResult.promise; },
    });
    const pending = api.reload();
    await setImmediate();
    writeDone.resolve();
    await readStarted.promise;
    readResult.resolve(JSON.stringify(newConfig));
    await pending;
    assert.equal(api.current().activeSessionByWorkspace.W, 'new');
});

test('等待写盘期间又发生保存：放弃本次重读，不拿旧磁盘快照回滚', async () => {
    const writeDone = deferred();
    let reads = 0;
    const {api, state} = createHarness({
        config: oldConfig,
        writeChain: writeDone.promise,
        read: () => { reads += 1; return Promise.resolve(JSON.stringify(oldConfig)); },
    });
    const pending = api.reload();
    await setImmediate();
    api.setConfig(newConfig);
    api.markMutation();
    api.setWriteChain(Promise.resolve());
    writeDone.resolve();
    await pending;
    assert.equal(reads, 0, '等待期间出现新保存时不应再读旧快照');
    assert.equal(api.current().activeSessionByWorkspace.W, 'new');
    assert.equal(state.applied, 0);
});

test('saveAIConfig 在排队写盘前使在飞读取失效', () => {
    const start = panel.indexOf('    function saveAIConfig() {');
    const end = panel.indexOf('\n    // 插件启用/禁用后', start);
    assert.ok(start >= 0 && end > start, '找不到 saveAIConfig');
    const body = panel.slice(start, end);
    const invalidateAt = body.indexOf('configMutationSeq += 1;');
    const writeAt = body.indexOf('configWriteChain = configWriteChain');
    assert.ok(invalidateAt > 0, '保存必须增加配置写入世代');
    assert.ok(writeAt > invalidateAt, '必须先让在飞读取失效，再排队写盘');
});
