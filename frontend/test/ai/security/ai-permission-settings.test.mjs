// ai-permission-settings.test.mjs —— 项目级权限规则（.cadt/permissions.json）写通道的守卫。
// 覆盖：写侧走 AIProjectRulesWrite（锁 + 原子写，root 用会话根）/ 旧宿主回落 SaveFile /
// 没有工作区时明确报错 / 读-改-写链（addProjectRule）能把新规则带进同一次落盘。
// 纯工厂测试：opt 传空对象即可——各 renderXxx 都有「元素不存在就早退」的守卫，不需要 DOM。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAIPermissionSettings} from '../../../src/ai/security/ai-permission-settings.js';
import {emptyPermissionRules, PERMISSION_VERSION} from '../../../src/ai/security/ai-permissions.js';

// 工厂构造时会给 window 挂 cadt-plugins-loaded 监听（插件注册表变化时原位刷新下拉）
globalThis.window = globalThis.window || {addEventListener() {}};

function makeMod(options = {}) {
    const writes = [];
    const legacySaves = [];
    // 假磁盘：写通道落盘后 readTextFile 读得回来（读-改-写链的行为才可测）
    const disk = new Map();
    const backend = {
        async AIProjectRulesWrite(root, text) {
            writes.push({root, text});
            disk.set(root + '/.cadt/permissions.json', text);
        },
        async SaveFile(path, content, eol, hasBom, enc) {
            legacySaves.push({path, content, eol, hasBom, enc});
            disk.set(path, content);
        },
        async AIEnsureDir(dir) {
            legacySaves.push({dir});
        },
    };
    if (options.noAtomicWrite) delete backend.AIProjectRulesWrite;
    const rootOf = options.rootOf || ((session) => (session && session.workspace) || '');
    const mod = createAIPermissionSettings({
        opt: {},
        flash: () => {},
        backend,
        readTextFile: async (path) => {
            if (disk.has(path)) return {text: disk.get(path)};
            throw new Error('no file');
        },
        currentSession: () => options.session || null,
        saveAIConfig: () => {},
        aiNormalizePath: (p) => String(p == null ? '' : p).replace(/\\/g, '/'),
        aiJoinPath: (root, rel) => (root ? root + '/' + rel : rel),
        aiPathDir: (p) => String(p).replace(/\/[^/]*$/, ''),
        aiPathKey: (p) => String(p == null ? '' : p).toLowerCase(),
        aiProjectRoot: rootOf,
        aiWorkspaceKey: (p) => String(p == null ? '' : p).toLowerCase(),
        getConfig: () => ({profiles: [], approvedPaths: []}),
        localClassifier: () => null,
        openSettings: () => {},
        getPluginCommandClassifiers: () => [],
        getPermissionAudit: () => [],
    }, {});
    return {mod, writes, legacySaves};
}

test('saveProjectRules 走 AIProjectRulesWrite：root 是会话根，原文不带路径拼接', async () => {
    const {mod, writes, legacySaves} = makeMod();
    const path = await mod.saveProjectRules(emptyPermissionRules(), {workspace: 'D:/ws'});
    assert.equal(path, 'D:/ws/.cadt/permissions.json');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].root, 'D:/ws', '首参是工作区根（后端自己拼 .cadt/permissions.json）');
    const parsed = JSON.parse(writes[0].text);
    assert.equal(parsed.version, PERMISSION_VERSION);
    assert.deepEqual(Object.keys(parsed).sort(), ['command', 'version', 'web', 'write']);
    assert.equal(legacySaves.length, 0, '有锁通道时不该再直写 SaveFile');
});

test('saveProjectRules：没有工作区直接报错，不调用任何写通道', async () => {
    const {mod, writes, legacySaves} = makeMod({rootOf: () => ''});
    await assert.rejects(() => mod.saveProjectRules(emptyPermissionRules()), /当前没有工作区/);
    assert.equal(writes.length, 0);
    assert.equal(legacySaves.length, 0);
});

test('saveProjectRules：旧宿主没有 AIProjectRulesWrite 时回落 SaveFile（目录先建）', async () => {
    const {mod, legacySaves} = makeMod({noAtomicWrite: true});
    await mod.saveProjectRules(emptyPermissionRules(), {workspace: 'D:/ws'});
    assert.deepEqual(legacySaves[0], {dir: 'D:/ws/.cadt'}, '先建 .cadt 目录（旧 SaveFile 不建父目录）');
    const saved = legacySaves.find((item) => item.path);
    assert.equal(saved.path, 'D:/ws/.cadt/permissions.json');
    assert.equal(saved.eol, 'lf');
    assert.equal(JSON.parse(saved.content).version, PERMISSION_VERSION);
});

test('addProjectRule 读-改-写链：新规则进同一次 AIProjectRulesWrite 落盘', async () => {
    const session = {id: 's1', workspace: 'D:/ws'};
    const {mod, writes} = makeMod({session});
    const added = await mod.addProjectRule('command', 'allow', 'git status:*');
    assert.equal(added, true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].root, 'D:/ws');
    assert.deepEqual(JSON.parse(writes[0].text).command.allow, ['git status:*']);
    // 重复添加同一规则：归一化后判定已存在，不再落盘
    const again = await mod.addProjectRule('command', 'allow', 'git status:*');
    assert.equal(again, false);
    assert.equal(writes.length, 1);
});
