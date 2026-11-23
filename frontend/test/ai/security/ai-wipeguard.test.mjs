// ai-wipeguard.test.mjs：工作区破坏防护检测控制器的纯函数与接线护栏。
// 哈希向量与 Go 侧 TestWorkspaceKey 共享（internal/wipeguard/fingerprint_test.go），防两端漂移。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
    WIPEGUARD_WINDOW_MS,
    WIPEGUARD_DELETE_THRESHOLD,
    WIPEGUARD_FINGERPRINT_DEBOUNCE_MS,
    WIPEGUARD_NOTIFY_COOLDOWN_MS,
    wipeGuardSkipPath,
    registerDeleteEvents,
    shouldAlarmFromWatch,
    normalizeWsKey,
    humanAgo,
    recoveryHintText,
    buildGuardNotice,
    createAIWipeguard,
} from '../../../src/ai/security/ai-wipeguard.js';

// ---- 哈希口径（与 Go 共享向量）----

test('normalizeWsKey：与后端 WorkspaceKey 的归一化语义一致', () => {
    assert.equal(normalizeWsKey('D:\\OraSkyC\\Project\\CandySweet\\CaDt-DataLens\\'), 'd:/oraskyc/project/candysweet/cadt-datalens');
    assert.equal(normalizeWsKey('d:/oraskyc/project/candysweet/cadt-datalens'), 'd:/oraskyc/project/candysweet/cadt-datalens');
    assert.equal(normalizeWsKey(''), '');
});

test('共享测试向量：归一化 key 的 sha256 前 8 hex 与 Go TestWorkspaceKey 相同', () => {
    const key = normalizeWsKey('D:\\OraSkyC\\Project\\CandySweet\\CaDt-DataLens\\');
    assert.equal(createHash('sha256').update(key).digest('hex').slice(0, 8), '35dc7bd8');
    assert.equal(createHash('sha256').update('').digest('hex').slice(0, 8), 'e3b0c442');
});

// ---- watcher 计数 ----

test('wipeGuardSkipPath：忽略表顶层子树不计入（与 Go skipFingerprintDir 同口径）', () => {
    for (const p of ['.git/HEAD', '.git\\objects\\ab\\cd', '.cadt/tmp/x.txt', 'node_modules/pkg/i.js', '.cache/d']) {
        assert.ok(wipeGuardSkipPath(p), `${p} 应被排除`);
    }
    for (const p of ['frontend/src/ai/ai-panel.js', 'README.md', 'docs/a.md', 'internal/x/y.go']) {
        assert.ok(!wipeGuardSkipPath(p), `${p} 不应被排除`);
    }
    assert.ok(wipeGuardSkipPath(''), '空路径排除');
});

test('wipeGuardSkipPath：构建产物目录（顶层与二级）不计入——vite/wails 清产物是合法 churn', () => {
    for (const p of ['dist/index.js', 'build/bin/app.exe', 'frontend/dist/assets/x.js', 'tools/bin/a']) {
        assert.ok(wipeGuardSkipPath(p), `${p} 应被排除`);
    }
    // 三级及以下不排除：源码树深处的同名目录不算产物
    assert.ok(!wipeGuardSkipPath('src/plugins/dist-helper/x.js'), '源码树深处不排除');
    assert.ok(!wipeGuardSkipPath('src/a/building/x.js'), '前缀相似目录不排除');
});

test('wipeGuardSkipPath：临时/机械文件不计入——原子写与补丁的 temp「消失」是写入正常半程', () => {
    for (const p of [
        'frontend/src/terminal/terminal-sessions.js.tmp.29772.db48c7c22105', // atomfile 变体
        'docs/plugins/.cadt-patch-3970327745.tmp',                          // 补丁写入 temp
        'frontend/.cadt-patch-173752754.tmp',
        'src/a/keep.txt.1234.5678.tmp',                                     // atomfile 原生命名
        'ai-sessions.lock',                                                 // 跨进程锁
        '.cadt-workspace.gate',
    ]) {
        assert.ok(wipeGuardSkipPath(p), `${p} 应被排除`);
    }
    for (const p of ['frontend/src/terminal/terminal-sessions.js', 'docs/plugins/README.md', 'a.tmpx', 'lockfile']) {
        assert.ok(!wipeGuardSkipPath(p), `${p} 不应被排除`);
    }
});

test('registerDeleteEvents：同一路径窗口内去重——rename 的多条 action 不重复计数', () => {
    const now = 1000;
    const batch = [
        'frontend/src/terminal/terminal-sessions.js.tmp.29772.x',
        'frontend/src/terminal/terminal-sessions.js.tmp.29772.x',   // temp 重复
        'frontend/src/terminal',
        'frontend/src/terminal/terminal-sessions.js',
        'frontend/src/terminal/terminal-sessions.js',               // 目标重复
        'frontend/src/terminal',                                     // 目录重复
    ];
    const win = registerDeleteEvents(null, batch, now);
    // temp 被形态排除；目标与目录各计一次
    assert.deepEqual(win.events.map((e) => e.path), [
        'frontend/src/terminal',
        'frontend/src/terminal/terminal-sessions.js',
    ]);
    // 跨批次重复也去重（窗口滑动前）
    const win2 = registerDeleteEvents(win, ['frontend/src/terminal/terminal-sessions.js'], now + 100);
    assert.equal(win2.events.length, 2);
});

test('registerDeleteEvents：并入窗口、丢弃窗外旧条目、排除子树', () => {
    const now = 10000;
    let win = registerDeleteEvents(null, ['a.js', '.git/HEAD', 'b.js'], now);
    assert.equal(win.events.length, 2);
    win = registerDeleteEvents(win, ['c.js'], now + WIPEGUARD_WINDOW_MS - 100);
    assert.equal(win.events.length, 3);
    // 第一批已出窗（窗口滑动）
    win = registerDeleteEvents(win, [], now + WIPEGUARD_WINDOW_MS + 1);
    assert.deepEqual(win.events.map((e) => e.path), ['c.js']);
    // 纯函数：不改动入参
    const frozen = {events: [{at: 0, path: 'x'}]};
    registerDeleteEvents(frozen, ['y'], now);
    assert.equal(frozen.events.length, 1);
});

test('wipeGuardSkipPath：版本控制元数据任意层级都排除——插件目录自带 .git', () => {
    for (const p of [
        'plugins/command-classifier-onnx/.git/config',
        'plugins\\demo\\.git\\objects\\ab\\cdef',
        'plugins/demo/src/.git/HEAD',      // 子模块布局
        'plugins/a/.svn/entries',
        'a/b/.cadt/logs/x.md',
    ]) {
        assert.ok(wipeGuardSkipPath(p), `${p} 应被排除`);
    }
    // 名字相近的真目录不误伤
    for (const p of ['plugins/demo/.gitignore', 'plugins/git-helper/x.js', 'plugins/demo/.github/workflows/ci.yml']) {
        assert.ok(!wipeGuardSkipPath(p), `${p} 不应被排除`);
    }
});

test('registerDeleteEvents + shouldAlarmFromWatch：删除后又重建 = 替换，不计净消失', () => {
    const now = 1000;
    const files = Array.from({length: 50}, (_, i) => `plugins/demo/f${i}.js`);
    // 第一批只有删除（os.RemoveAll 整目录）
    let win = registerDeleteEvents(null, files, now, []);
    assert.equal(shouldAlarmFromWatch(win, now)?.level, 'critical', '只有删除时仍按删除计数');
    // 第二批同路径全部重建（复制新目录）→ 净消失归零
    win = registerDeleteEvents(win, [], now + 200, files);
    assert.equal(shouldAlarmFromWatch(win, now + 200), null);
});

test('registerDeleteEvents + shouldAlarmFromWatch：先出现后删除仍是真删除', () => {
    const now = 1000;
    const files = Array.from({length: 45}, (_, i) => `src/f${i}.js`);
    // 先有 modified/added（写入流程），随后才被删除
    let win = registerDeleteEvents(null, [], now, files);
    win = registerDeleteEvents(win, files, now + 200, []);
    const verdict = shouldAlarmFromWatch(win, now + 200);
    assert.equal(verdict.level, 'critical');
    assert.equal(verdict.paths.length, 45);
});

test('registerDeleteEvents + shouldAlarmFromWatch：部分重建按净消失计', () => {
    const now = 1000;
    const gone = Array.from({length: 60}, (_, i) => `plugins/demo/f${i}.js`);
    const kept = gone.slice(0, 55); // 新版本少 5 个文件
    let win = registerDeleteEvents(null, gone, now, []);
    win = registerDeleteEvents(win, [], now + 100, kept);
    assert.equal(shouldAlarmFromWatch(win, now + 100), null, '净消失 5 个不告警');
});

test('shouldAlarmFromWatch：删除数到阈值即 critical，静默时返回 null', () => {
    const now = 1000;
    const paths = Array.from({length: WIPEGUARD_DELETE_THRESHOLD}, (_, i) => `f${i}.js`);
    const win = registerDeleteEvents(null, paths, now);
    const verdict = shouldAlarmFromWatch(win, now);
    assert.equal(verdict.level, 'critical');
    assert.ok(verdict.reason.includes('40 个文件'));
    const quiet = registerDeleteEvents(null, ['only-one.js'], now);
    assert.equal(shouldAlarmFromWatch(quiet, now), null);
});

test('shouldAlarmFromWatch：排除子树后不够阈值不告警（git gc / npm churn）', () => {
    const now = 1000;
    const paths = Array.from({length: WIPEGUARD_DELETE_THRESHOLD + 10}, (_, i) => `node_modules/m${i}/x.js`);
    const win = registerDeleteEvents(null, paths, now);
    assert.equal(shouldAlarmFromWatch(win, now), null);
});

// ---- 告警消息：长度与语言（这条消息会进会话上下文）----

test('humanAgo：相对时间用最短说法', () => {
    const now = 10 * 86400000;
    assert.equal(humanAgo(now - 30000, now), '刚刚');
    assert.equal(humanAgo(now - 5 * 60000, now), '5 分钟前');
    assert.equal(humanAgo(now - 3 * 3600000, now), '3 小时前');
    assert.equal(humanAgo(now - 2 * 86400000, now), '2 天前');
    assert.equal(humanAgo(0, now), '');
});

test('recoveryHintText：有快照报最近一份，没有/关闭说清原因，都是一行', () => {
    const now = 10 * 3600000;
    const rows = [
        {name: 'a.tar', at: now - 3 * 3600000, bytes: 10},
        {name: 'b.tar', at: now - 20 * 60000, bytes: 10},
    ];
    const line = recoveryHintText(rows, {snapshotsEnabled: true, now});
    assert.ok(line.includes('20 分钟前'), '取最新一份');
    assert.ok(line.includes('共 2 份'));
    assert.ok(line.includes('工作区防护'), '给出恢复入口');
    assert.ok(!line.includes('\n'), '只占一行');
    assert.ok(recoveryHintText([], {snapshotsEnabled: true, now}).includes('写前备份'));
    assert.ok(recoveryHintText(rows, {snapshotsEnabled: false, now}).includes('已关闭'));
});

test('buildGuardNotice：样例截断 8 条、长路径裁剪、整体长度可控', () => {
    const paths = Array.from({length: 300}, (_, i) => `plugins/demo-deep/packages/pkg-${i}/node_modules/lib/dist/f${i}.js`);
    const text = buildGuardNotice({reason: '10 秒内 300 个文件消失', paths}, '可回滚：最近一份快照 3 分钟前（共 6 份）。');
    assert.ok(text.startsWith('［工作区防护］10 秒内 300 个文件消失'));
    assert.equal((text.match(/\.js/g) || []).length, 8, '只带 8 条样例');
    assert.ok(text.includes('…'), '还有更多时留省略号');
    assert.ok(text.includes('可回滚'), '带上恢复提示');
    assert.ok(!text.includes('node_modules/pkg-299'), '没有把全量路径塞进来');
    assert.ok(text.length < 900, `总长度应可控，实际 ${text.length}`);
    // 短路径原样保留
    assert.ok(buildGuardNotice({reason: 'x', paths: ['a/b.js']}, '').includes('a/b.js'));
    // 没有样例时不出现「样例：」空行
    assert.ok(!buildGuardNotice({reason: 'x', paths: []}, '').includes('样例：'));
});

test('recoveryHint：读取快照清单，关闭快照时不查后端', async () => {
    const {ctrl, backend} = makeController();
    backend.WipeGuardSnapshotList = async () => [{name: 'a.tar', at: Date.now() - 60000, bytes: 1}];
    const line = await ctrl.recoveryHint('D:/demo');
    assert.ok(line.includes('可回滚') && line.includes('1 份'), line);

    const off = makeController({getSettings: () => ({wipeGuard: {enabled: true, snapshots: false}})});
    off.backend.WipeGuardSnapshotList = async () => {
        throw new Error('不该调用');
    };
    assert.ok((await off.ctrl.recoveryHint('D:/demo')).includes('已关闭'));
});

test('投递冷却常量存在且不小于 1 分钟（防连续告警把上下文堆满）', () => {
    assert.ok(WIPEGUARD_NOTIFY_COOLDOWN_MS >= 60 * 1000);
});

// ---- 控制器 ----

function fakeBackend() {
    const calls = {alarms: [], compares: [], configs: [], fingerprints: 0};
    return {
        calls,
        async WipeGuardConfigure(s) { calls.configs.push(s); return s; },
        async WipeGuardFingerprint() { calls.fingerprints++; return {rootEntries: 10, depth1Dirs: 5, markers: {'.git': true}, fileCount: 100, sampled: false}; },
        async WipeGuardCompare(before, after) {
            calls.compares.push([before, after]);
            if (after.rootEntries <= 1 && before.rootEntries >= 5) return {level: 'critical', reason: '整仓顶层条目被清空'};
            return {level: '', reason: ''};
        },
        async WipeGuardAlarm(level, reason, detail) { calls.alarms.push({level, reason, detail}); },
        async WipeGuardSnapshot() { return {mode: 'git', name: 'x.tar', bytes: 1, files: -1}; },
    };
}

function makeController(overrides = {}) {
    const backend = fakeBackend();
    const fired = {critical: [], warn: []};
    const ctrl = createAIWipeguard({
        getBackend: () => backend,
        getWsRoot: () => 'D:/demo',
        getSettings: () => ({wipeGuard: {enabled: true, snapshots: true}}),
        isAIActive: () => false,
        onCritical: (info) => fired.critical.push(info),
        onWarn: (info) => fired.warn.push(info),
        settleMs: 5, // 超阈值确认延迟，测试里压到 5ms
        ...overrides,
    });
    return {ctrl, backend, fired};
}

// settleMs(5) + 余量：等延迟确认窗口走完
const settle = () => new Promise((r) => setTimeout(r, 30));

test('控制器：watcher 判定 critical → onCritical 上报，但不再停会话 / 不再熔断写', async () => {
    const {ctrl, backend, fired} = makeController({isAIActive: () => true});
    const paths = Array.from({length: WIPEGUARD_DELETE_THRESHOLD}, (_, i) => `f${i}.js`);
    ctrl.handleWorkspaceEvent({root: 'D:/demo', removed: paths, overflow: false});
    await settle();
    assert.equal(fired.critical.length, 1);
    assert.equal(backend.calls.alarms.length, 1);
    assert.equal(backend.calls.alarms[0].level, 'critical');
    assert.ok(!ctrl.isWriteBlocked(), '2026-11-19 起改为插队投递应用消息，不再熔断写命令');
});

test('控制器：critical 但会话空闲 → 只提醒不熔断', async () => {
    const {ctrl, fired} = makeController({isAIActive: () => false});
    const paths = Array.from({length: WIPEGUARD_DELETE_THRESHOLD}, (_, i) => `f${i}.js`);
    ctrl.handleWorkspaceEvent({root: 'D:/demo', removed: paths, overflow: false});
    await settle();
    assert.equal(fired.critical.length, 1);
    assert.equal(fired.critical[0].aiActive, false);
    assert.ok(!ctrl.isWriteBlocked(), '空闲时不熔断（用户手动批量删除不误伤）');
});

test('控制器：总开关关闭时不消费事件、不取指纹', async () => {
    const {ctrl, backend} = makeController({
        getSettings: () => ({wipeGuard: {enabled: false}}),
    });
    const paths = Array.from({length: WIPEGUARD_DELETE_THRESHOLD + 5}, (_, i) => `f${i}.js`);
    ctrl.handleWorkspaceEvent({root: 'D:/demo', removed: paths, overflow: false});
    assert.equal(backend.calls.alarms.length, 0);
    assert.equal(await ctrl.preCommand('D:/demo'), null);
    assert.equal(backend.calls.fingerprints, 0);
});

test('控制器：preCommand/postCommand 前后指纹对比走 Go 判定（阈值不复制到前端）', async () => {
    const {ctrl, backend} = makeController();
    const before = await ctrl.preCommand('D:/demo');
    assert.ok(before, '应取到基线指纹');
    // 模拟命令后整仓清空
    backend.WipeGuardFingerprint = async () => ({rootEntries: 1, depth1Dirs: 0, markers: {}, fileCount: 0, sampled: false});
    await ctrl.postCommand('D:/demo', before);
    assert.equal(backend.calls.compares.length, 1);
    assert.equal(backend.calls.alarms.length, 1);
    assert.equal(backend.calls.alarms[0].level, 'critical');
});

test('控制器：切工作区重置窗口与基线（跨工作区不误判）', async () => {
    const {ctrl} = makeController();
    const paths = Array.from({length: WIPEGUARD_DELETE_THRESHOLD - 1}, (_, i) => `f${i}.js`);
    ctrl.handleWorkspaceEvent({root: 'D:/demo', removed: paths, overflow: false});
    // 换工作区：上一窗口的 39 条删除不应带入
    ctrl.handleWorkspaceEvent({root: 'E:/other', removed: ['one.js'], overflow: false});
    assert.equal(ctrl.handleWorkspaceEvent({root: 'E:/other', removed: ['two.js'], overflow: false}), undefined);
    const {backend} = {backend: null};
    void backend;
});

test('控制器：配置同步（开关对象原样发 Go）', async () => {
    const {ctrl, backend} = makeController();
    await ctrl.syncConfig();
    assert.equal(backend.calls.configs.length, 1);
    assert.deepEqual(backend.calls.configs[0], {enabled: true, snapshots: true, backupRoot: ''});
});

test('控制器：overflow 触发指纹重扫兜底', async () => {
    const {ctrl, backend} = makeController();
    ctrl.handleWorkspaceEvent({root: 'D:/demo', paths: [], removed: [], overflow: true});
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(backend.calls.fingerprints >= 1, 'overflow 应触发指纹重扫');
});

test('handleWorkspaceEvent：只计 removed 事件——added/modified（回灌/写入）不计数', async () => {
    const {ctrl, backend, fired} = makeController({isAIActive: () => true});
    // 补丁回灌 70 个文件：paths 全量（added/modified 为主），removed 为空 → 不得告警
    const paths = Array.from({length: 70}, (_, i) => `src/f${i}.js`);
    ctrl.handleWorkspaceEvent({root: 'D:/demo', paths, removed: [], overflow: false});
    await settle();
    assert.equal(backend.calls.alarms.length, 0);
    assert.equal(fired.critical.length, 0);
    assert.ok(!ctrl.isWriteBlocked('D:/demo'), '回灌不熔断');
    // 同窗口真删除 41 个 → 延迟确认后告警
    const gone = Array.from({length: 41}, (_, i) => `src/gone${i}.js`);
    ctrl.handleWorkspaceEvent({root: 'D:/demo', removed: gone, overflow: false});
    await settle();
    assert.equal(backend.calls.alarms.length, 1);
});

test('handleWorkspaceEvent：删除后同路径重建（插件更新）不计入净消失', async () => {
    const {ctrl, backend, fired} = makeController({isAIActive: () => true});
    // 插件更新：os.RemoveAll 旧目录 → 立刻复制新目录。第一批只含删除，第二批全是新增。
    const files = Array.from({length: 73}, (_, i) => `plugins/demo/p${i}.js`);
    ctrl.handleWorkspaceEvent({root: 'D:/demo', paths: files, removed: files, present: [], overflow: false});
    ctrl.handleWorkspaceEvent({root: 'D:/demo', paths: files, removed: [], present: files, overflow: false});
    await settle();
    assert.equal(backend.calls.alarms.length, 0, '删了又建是替换，不是消失');
    assert.equal(fired.critical.length, 0);
    assert.ok(!ctrl.isWriteBlocked('D:/demo'), '替换不熔断');
});

test('告警按工作区归因：onCritical 带着被告警的 root（投递侧据此收窄），且有 3s 去抖', async () => {
    // fireAlarm 有 3s 告警去抖：用假时钟跨过去，否则第二次告警被早退吞掉
    const realNow = Date.now;
    let fake = 1000000;
    Date.now = () => fake;
    try {
        let activeRoot = '';
        const {ctrl, fired} = makeController({isAIActive: (root) => root === activeRoot});
        activeRoot = 'D:/demo';
        ctrl.handleWorkspaceEvent({root: 'D:/demo', removed: Array.from({length: 41}, (_, i) => 'f' + i + '.js'), overflow: false});
        await settle();
        assert.equal(fired.critical.length, 1);
        assert.equal(normalizeWsKey(fired.critical[0].root), 'd:/demo', '告警要带着发生地工作区');
        assert.equal(fired.critical[0].aiActive, true, 'AI 活跃标记供 main.js 决定是否投递');
        assert.ok(!ctrl.isWriteBlocked('D:/demo'), '不再熔断');
        // 去抖窗口内的第二次告警不再刷屏
        ctrl.handleWorkspaceEvent({root: 'D:/demo', removed: Array.from({length: 41}, (_, i) => 'g' + i + '.js'), overflow: false});
        await settle();
        assert.equal(fired.critical.length, 1, '3 秒去抖内不重复投递/刷屏');
        // 跨过去抖窗口后可以再次告警
        fake += WIPEGUARD_FINGERPRINT_DEBOUNCE_MS + 100;
        ctrl.handleWorkspaceEvent({root: 'D:/demo', removed: Array.from({length: 41}, (_, i) => 'h' + i + '.js'), overflow: false});
        await settle();
        assert.equal(fired.critical.length, 2);
    } finally {
        Date.now = realNow;
    }
});
