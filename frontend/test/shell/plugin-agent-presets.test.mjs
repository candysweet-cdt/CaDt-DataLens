// Agent preset 扩展点生命周期护栏（cadt.registerAgentPreset，能力快照方案 §4 / §10.4）。
// 审查（2026-11-28）列出的五个缺口里钉四个：① 注册转发 owner 与错误包装；② 重放清空；
// ③ 半个插件失败时按 owner 撤（fail-closed，与命令「已成功的部分保留」契约的例外）；
// ④ 未接线宿主桩的报错契约。host.* 命名空间占用单列一条（2026-11-28 审查定案）。
// 真注册表直连（不走捕获桩）：注册结果用 ai-agent-preset-registry 的查询口断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import {initPluginRuntime, loadPlugins} from '../../src/shell/plugins.js';
import {
    registerAgentPreset,
    unregisterAgentPresetsByOwner,
    revokeAllPluginAgentPresets,
    getAgentPreset,
    listAgentPresetIds,
} from '../../src/ai/agent/ai-agent-preset-registry.js';

const source = (id, name, code) => ({GetPluginSources: async () => [{id, name, code}]});
const OK = 'cadt.registerAgentPreset({id: "webnovel.drafting", name: "正文起草", tools: ["read_file", "search_text"], fs: {mode: "workspace-write", writableRoots: ["草稿区"]}})';

// 真注册表接线（宿主注入的等价形态，见 main.js 的 deps getter）+ 撤销调用记录
const revokedOwners = [];
let revokeAllCalls = 0;

function wireHost() {
    initPluginRuntime({
        registerAgentPreset: (owner, spec) => registerAgentPreset(spec, owner),
        revokeAgentPresetsOwner: (owner) => {
            revokedOwners.push(owner);
            return unregisterAgentPresetsByOwner(owner);
        },
        revokeAllAgentPresets: () => {
            revokeAllCalls += 1;
            return revokeAllPluginAgentPresets();
        },
    });
}

test('注册 → 注册表可见（owner 转发）→ 重放清空', async () => {
    wireHost();
    revokeAllPluginAgentPresets();
    const errors = await loadPlugins(source('p1', 'P1', OK));
    assert.deepEqual(errors, [], '合法声明不产生加载错误');
    const entry = getAgentPreset('webnovel.drafting');
    assert.ok(entry, '插件 preset 应注册进真注册表');
    assert.equal(entry.owner, 'p1', 'owner 必须是插件 id（能力确认按它归账）');
    assert.equal(entry.preset.fs.mode, 'workspace-write');
    assert.equal(entry.preset.fs.writableRoots.length, 1);
    assert.equal(entry.preset.name, '正文起草');
    assert.ok(!entry.preset.fs.followParent, 'followParent 只对宿主内置生效');

    // 重放（禁用 / 卸载 / 重载路径）：全部插件 preset 清掉，宿主内置保留
    const before = revokeAllCalls;
    await loadPlugins({GetPluginSources: async () => []});
    assert.equal(revokeAllCalls, before + 1, 'revokeAllAgentPresets 必须在重放时调用');
    assert.equal(getAgentPreset('webnovel.drafting'), null);
    for (const id of ['host.default', 'host.read-only', 'host.full-write']) {
        assert.ok(getAgentPreset(id), '宿主内置 ' + id + ' 不可被重放清掉');
    }
});

test('非法声明 / 重复 / host.* 占用：报错进 lastLoadErrors 且带插件名前缀', async () => {
    wireHost();
    revokeAllPluginAgentPresets();
    // 非法 id（loadPlugins 的错误串 = 插件名 + pluginError 包装的 [插件id] 前缀）
    const e1 = await loadPlugins(source('p2', 'P2', 'cadt.registerAgentPreset({id: "BAD ID"})'));
    assert.equal(e1.length, 1);
    assert.match(e1[0], /P2：\[P2\] agent preset id 无效/);
    // 重复注册（与宿主内置撞 id 同样算占用/冲突）
    const e2 = await loadPlugins(source('p2', 'P2', 'cadt.registerAgentPreset({id: "x.y", tools: []});cadt.registerAgentPreset({id: "x.y", tools: []})'));
    assert.equal(e2.length, 1);
    assert.match(e2[0], /已注册/);
    // 宿主命名空间
    const e3 = await loadPlugins(source('p2', 'P2', 'cadt.registerAgentPreset({id: "host.custom", tools: []})'));
    assert.equal(e3.length, 1);
    assert.match(e3[0], /宿主命名空间/);
    assert.equal(getAgentPreset('host.custom'), null);
    // 宿主内置不可覆盖（重复注册撞 host.default）
    const e4 = await loadPlugins(source('p2', 'P2', 'cadt.registerAgentPreset({id: "host.default", tools: []})'));
    assert.equal(e4.length, 1);
    assert.match(e4[0], /宿主命名空间/);
    // 宿主内置仍然完好
    assert.ok(getAgentPreset('host.default'));
});

test('半个插件失败：已注册的 preset 按 owner 撤（fail-closed 例外）', async () => {
    wireHost();
    revokeAllPluginAgentPresets();
    revokedOwners.length = 0;
    // 注册成功后插件代码再抛错：命令 / 分类器按既有契约保留，agent preset 是例外——撤
    const code = OK + ';throw new Error("后半段炸了")';
    const errors = await loadPlugins(source('p3', 'P3', code));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /后半段炸了/);
    assert.deepEqual(revokedOwners, ['p3'], '失败插件的 preset 必须按 owner 撤销');
    assert.equal(getAgentPreset('webnovel.drafting'), null);
    // 旧宿主守卫：没有该扩展点的插件代码不受影响
    const e5 = await loadPlugins(source('p3', 'P3', 'if (!cadt.registerAgentPreset) return;'));
    assert.deepEqual(e5, []);
});

test('宿主未接线时注册直接报错（fail-fast，而不是静默无效）', async () => {
    // breakRegister：把钩子置回「未接线」形态——apiFor 的 try/catch 会把它包成插件加载错误
    initPluginRuntime({registerAgentPreset: undefined});
    const errors = await loadPlugins(source('p4', 'P4', OK));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /not a function|未接线/);
    assert.equal(getAgentPreset('webnovel.drafting'), null, '未接线时不得有半注册状态');
});

test('注册表查询面契约：listAgentPresetIds 恒含宿主内置', () => {
    revokeAllPluginAgentPresets();
    for (const id of ['host.default', 'host.read-only', 'host.full-write']) {
        assert.ok(listAgentPresetIds().includes(id), '内置 ' + id + ' 必须在候选清单里（派单错误信息引用）');
    }
});
