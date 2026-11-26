// session-restore.test.mjs：关标签空快照必须能落地的回归测试。
// 背景（2026-11-17）：用户关掉两个 AI 产物标签（.cadt/gen 下的 wav/mp4）后重启，
// 标签又从 workspace 快照恢复出来。
// 根因：关掉带 path 的标签后若还剩虚拟标签（AI 对话 / browser 等无 path），
// serializeSession 产出 0 tabs；renderTabs 的无参 scheduleSessionSave 覆盖掉
// closeDocNow 传来的 allowEmpty，空快照保护误判为「过程性保存」而跳过，旧快照
// 原地残留，下次从该目录启动按 workspace 快照 openPathsHere 恢复出旧标签。
// 修复：allowEmpty 粘滞到真正写入那一刻。本测试锁住该行为，且确保不误伤
// 「启动预热的过程性空快照仍受保护」这条既有护栏。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createSessionRestore} from '../../src/shell/session-restore.js';

const src = (rel) => readFileSync(fileURLToPath(new URL('../../src/' + rel, import.meta.url)), 'utf8');

const SESSION_KEY = 'cadt.session.v1';
const WS_KEY = 'cadt.workspace-sessions.v1';
const WS = 'D:/proj/CandySweet/CaDt-DataLens';

function makeStore() {
    const m = new Map();
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
        _map: m,
    };
}

// 用带 path 的普通 doc Simulate 编辑器状态；虚拟标签（AI/browser）没有 path。
function harness(store, {docs = [], workspaceFolder = ''} = {}) {
    const state = {docs, editorGroups: [], workspaceFolder};
    const deps = {
        get docs() { return state.docs; },
        get workspaceFolder() { return state.workspaceFolder; },
        // 与 main.js 接线一致：活引用 getter，不是创建期快照
        get editorGroups() { return state.editorGroups; },
        file: docs[0] || null,
        splitRoot: null,
        groupDocs: () => [],
        rememberDocView() {},
        logFrontend() {},
        activityLog: {log() {}, flush() {}},
        openFolderWorkspace() {},
        createGroup() { return {id: 'g', activeId: null, docIds: []}; },
        setFocusedGroupId() {},
        openPathsHere: async () => {},
        findDocByPath: () => null,
        groupOfDoc: () => null,
        activateDoc: async () => {},
        setSplitRoot() {},
        switchMode() {},
        renderEditorLayout() {},
        flash() {},
    };
    const restore = createSessionRestore(deps);
    return {deps, restore, state};
}

function seedWorkspaceSnapshot(store, workspace, paths) {
    const map = JSON.parse(store.getItem(WS_KEY) || '{}');
    const key = workspace.replace(/\\/g, '/').replace(/[\\/]+$/, '').toLowerCase();
    map[key] = {workspace, groups: [{paths, active: paths[0]}], current: paths[0], savedAt: Date.now()};
    store.setItem(WS_KEY, JSON.stringify(map));
}

function wsSnapshotPaths(store, workspace) {
    const map = JSON.parse(store.getItem(WS_KEY) || '{}');
    const key = workspace.replace(/\\/g, '/').replace(/[\\/]+$/, '').toLowerCase();
    const s = map[key];
    return s && s.groups && s.groups[0] ? s.groups[0].paths : [];
}

// 关键回归：allowEmpty 必须粘滞到真正写入。模拟 closeDocNow 的
// scheduleSessionSave({allowEmpty:true}) 紧跟 renderTabs 的无参 scheduleSessionSave()。
test('allowEmpty 粘滞：后续无参调度不覆盖，空快照能落地', async () => {
    globalThis.window = {addEventListener() {}};
    globalThis.localStorage = makeStore();
    // 前置：全局 key 里存着含产物标签的旧快照（与当前 workspace 相同）
    globalThis.localStorage.setItem(SESSION_KEY, JSON.stringify({
        workspace: WS,
        groups: [{paths: [WS + '/.cadt/gen/a.mp4'], active: WS + '/.cadt/gen/a.mp4'}],
        current: WS + '/.cadt/gen/a.mp4',
    }));
    seedWorkspaceSnapshot(globalThis.localStorage, WS, [WS + '/.cadt/gen/a.mp4']);
    // 剩余只有虚拟标签（无 path）→ serializeSession 产出 0 tabs
    const {restore} = harness(globalThis.localStorage, {docs: [{id: 'v1'}], workspaceFolder: WS});

    restore.scheduleSessionSave({allowEmpty: true});
    restore.scheduleSessionSave(); // 模拟 renderEditorLayout 的无参覆盖

    await new Promise((r) => setTimeout(r, 650));

    const sess = JSON.parse(globalThis.localStorage.getItem(SESSION_KEY) || 'null');
    assert.ok(sess, '空快照已写入（没有被空快照保护跳过）');
    assert.equal(sess.groups.length, 0, '保存的是 0 标签快照');
    assert.equal(wsSnapshotPaths(globalThis.localStorage, WS).length, 0, 'workspace 快照也清空');
});

// 接线护栏（2026-11-17 事故）：editor-groups 的导出对象漏了 editorGroups getter，
// main.js 传给 session-restore 的就是 undefined；serializeSession 的 for...of 抛
// TypeError 并被静默吞掉 → 之后每次保存都失败，旧快照原地残留，关掉的标签重启又回来。
test('接线：editorGroups 必须是活引用导出，session-restore 才拿得到分组', () => {
    assert.match(src('editor/editor-groups.js'), /get editorGroups\(\) \{ return editorGroups; \}/,
        'createEditorGroups 的导出对象必须带 editorGroups getter');
    assert.match(src('main.js'), /get editorGroups\(\) \{ return editorGroupsMod\.editorGroups; \}/,
        'main.js 必须把 editorGroups 以 getter 注入 session-restore');
});

// 保存链路不许静默失败：依赖缺失（如上面的接线断了）要在调试日志留下 warn。
test('保存失败不静默：序列化抛错时写 warn 日志并返回 false', () => {
    globalThis.window = {addEventListener() {}};
    globalThis.localStorage = makeStore();
    const logs = [];
    const restore = createSessionRestore({
        docs: [{id: 'd1', path: WS + '/a.md'}],
        workspaceFolder: WS,
        editorGroups: undefined,
        file: {id: 'd1', path: WS + '/a.md'},
        splitRoot: null,
        groupDocs: () => [],
        rememberDocView() {},
        logFrontend: (level, msg) => logs.push([level, msg]),
        activityLog: {log() {}, flush() {}},
    });
    assert.equal(restore.saveSessionNow({allowEmpty: true}), false);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'warn');
    assert.match(logs[0][1], /会话保存失败/);
});

// 调试台可见性（2026-11-17）：logFrontend 以前只写应用日志文件，模块里直接
// logFrontend('warn'/'error') 的失败在调试台里完全看不到。现在必须双写；console
// 补丁与全局错误钩子带 fromConsole，避免同一条日志在调试台出现两次。
test('诊断可见性：logFrontend 同时写调试台，console 补丁不重复入面板', () => {
    const main = src('main.js');
    assert.match(main, /function logFrontend\(level, message, opts\)/);
    assert.match(main, /if \(!\(opts && opts\.fromConsole\)\) debugConsole\.push\(level, \[text\]\);/);
    assert.match(main, /logFrontend\(level, args\.map\(formatLogArg\)\.join\(' '\), \{fromConsole: true\}\);/);
    assert.match(main, /logFrontend\('error', '未捕获异常：' \+ detail, \{fromConsole: true\}\);/);
});

// 跨工作区快照不恢复（2026-11-18 多窗口串台）：cadt.session.v1 存在共享 localStorage 里，
// 是「最后保存的那个窗口」的环境。本窗口已有工作区时，workspace 不匹配的快照必须整体拒绝，
// 否则别的工作区的标签会被恢复进来，本窗口工作区也会被 openFolderWorkspace 换掉。
test('跨工作区快照不恢复：快照 workspace 与本窗口不一致时整体跳过', async () => {
    globalThis.window = {addEventListener() {}};
    globalThis.localStorage = makeStore();
    const other = 'D:/work/OtherProject';
    const opened = [];
    const logs = [];
    const restore = createSessionRestore({
        docs: [], workspaceFolder: other,
        editorGroups: [], file: null, splitRoot: null,
        groupDocs: () => [], rememberDocView() {},
        logFrontend: (level, msg) => logs.push([level, msg]),
        activityLog: {log() {}, flush() {}},
        openFolderWorkspace: (dir) => opened.push(dir),
        createGroup() { throw new Error('跨工作区快照不应走到打开标签这一步'); },
    });
    const ok = await restore.restoreSession({
        workspace: WS,
        groups: [{paths: [WS + '/a.md'], active: WS + '/a.md'}],
        current: WS + '/a.md',
    });
    assert.equal(ok, false);
    assert.deepEqual(opened, [], '不能把本窗口工作区切成快照里的那个');
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'warn');
    assert.match(logs[0][1], /会话恢复跳过/);
});

// 不误伤：同一工作区（大小写/斜杠归一后一致）的快照照常恢复。
test('同工作区快照照常恢复：路径写法不同也算同一工作区', async () => {
    globalThis.window = {addEventListener() {}};
    globalThis.localStorage = makeStore();
    const opened = [];
    const restore = createSessionRestore({
        docs: [], workspaceFolder: WS,
        editorGroups: [], file: null, splitRoot: null,
        groupDocs: () => [], rememberDocView() {},
        logFrontend() {},
        activityLog: {log() {}, flush() {}},
        openFolderWorkspace: (dir) => opened.push(dir),
        createGroup() { return {id: 'g1', activeId: null}; },
        setFocusedGroupId() {}, openPathsHere: async () => {}, findDocByPath: () => null,
        groupOfDoc: () => null, activateDoc: async () => {}, setSplitRoot() {},
        switchMode() {}, renderEditorLayout() {}, flash() {},
    });
    const ok = await restore.restoreSession({
        workspace: WS.replace(/\//g, '\\').toLowerCase(),
        groups: [{paths: [WS + '/a.md'], active: WS + '/a.md'}],
        current: WS + '/a.md',
    });
    assert.equal(ok, undefined);
    assert.deepEqual(opened, [], '本窗口已有工作区，不该再开一次');
});

// 不误伤：没有 allowEmpty 的过程性空快照仍被保护，不清旧快照。
test('过程性空快照仍受保护：无 allowEmpty 时不覆盖非空旧快照', () => {
    globalThis.window = {addEventListener() {}};
    globalThis.localStorage = makeStore();
    const old = {workspace: WS, groups: [{paths: [WS + '/a.md'], active: WS + '/a.md'}], current: WS + '/a.md'};
    globalThis.localStorage.setItem(SESSION_KEY, JSON.stringify(old));
    seedWorkspaceSnapshot(globalThis.localStorage, WS, [WS + '/a.md']);
    // 无 path 的虚拟标签 → 0 tabs，且 workspace 与旧快照相同
    const {restore} = harness(globalThis.localStorage, {docs: [{id: 'v1'}], workspaceFolder: WS});

    assert.equal(restore.saveSessionNow(), false, '空快照保护触发，返回 false');
    const kept = JSON.parse(globalThis.localStorage.getItem(SESSION_KEY));
    assert.equal(kept.groups[0].paths[0], WS + '/a.md', '旧快照未被抹成空');
});

// harness 窗口独立快照槽（agent-host-platform 批次 F3）：cadt.session.v1 是多窗口共享单槽，
// 空 workspace 的快照在读取侧不做归属校验——harness 的布局写进共享槽就会污染普通窗口的下次启动。
test('harness 窗口写独立槽：共享槽不被覆盖，读也读自己的槽', () => {
    globalThis.window = {addEventListener() {}, __harnessWindow: true};
    globalThis.localStorage = makeStore();
    const HARNESS_KEY = 'cadt.session.harness.v1';
    const shared = {workspace: 'D:/other/Repo', groups: [{paths: ['D:/other/Repo/x.md'], active: 'D:/other/Repo/x.md'}], current: 'D:/other/Repo/x.md'};
    globalThis.localStorage.setItem(SESSION_KEY, JSON.stringify(shared));

    const doc = {id: 'd1', path: WS + '/a.md', mode: 'text'};
    const restore = createSessionRestore({
        docs: [doc], workspaceFolder: '',
        editorGroups: [{id: 'g', activeId: 'd1'}],
        file: doc, splitRoot: null,
        groupDocs: (g) => (g.id === 'g' ? [doc] : []),
        rememberDocView() {},
        logFrontend() {},
        activityLog: {log() {}, flush() {}},
    });
    assert.equal(restore.saveSessionNow(), true);
    const own = JSON.parse(globalThis.localStorage.getItem(HARNESS_KEY) || 'null');
    assert.ok(own, 'harness 的快照写进了自己的槽');
    assert.equal(own.groups[0].paths[0], WS + '/a.md');
    assert.deepEqual(JSON.parse(globalThis.localStorage.getItem(SESSION_KEY)), shared, '共享槽一字未动');
    // 读侧同槽：harness 取自己的快照，不拿共享槽里别的窗口的环境
    assert.deepEqual(restore.readSession(), own);
    globalThis.window = {addEventListener() {}};
    assert.deepEqual(restore.readSession(), shared, '普通窗口仍读共享槽');
});
