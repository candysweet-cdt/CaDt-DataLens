// agent-capabilities.test.mjs：能力快照合成 / 收窄 / 校验 / 序列化的纯函数护栏
//（方案 docs/unfinished-plans/subagent-capabilities-redesign.md §3 / §4.2 / §10.3 / §8.1）。
// 覆盖：§4.2 全部非法情形（未知工具名、danger-full-access 插件声明、可写根逃逸、
// 父档上限取交）、worktree 隔离注入、host 内置 preset（§10.4）、能力确认降级（§6.3）、
// 序列化与恢复校验（§8.1 / §8.2）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {
    composeAgentCapabilities,
    serializeCapabilities,
    parseCapabilities,
    subWriteVerdict,
    subToolDenyText,
    pathInWritableRoots,
    resolveWritableRoots,
    pathWithin,
    PARENT_FS_CAP,
    READ_ONLY_CAPABILITIES,
} from '../../../src/ai/agent/agent-capabilities.js';
import {
    registerAgentPreset,
    unregisterAgentPresetsByOwner,
    revokeAllPluginAgentPresets,
    getAgentPreset,
    listAgentPresetIds,
    isHostPresetId,
    knownAgentToolNames,
    subagentProjectableToolNames,
    HOST_PRESET_DEFAULT,
    HOST_PRESET_READ_ONLY,
    HOST_PRESET_FULL_WRITE,
} from '../../../src/ai/agent/ai-agent-preset-registry.js';
import {normalizeAgentPreset} from '../../../src/ai/agent/ai-agent-preset.js';

// 已知工具全集（真实工具表）：未知名拒绝的判定来源
const KNOWN = knownAgentToolNames();

function makePreset(overrides) {
    return normalizeAgentPreset(Object.assign({
        id: 'webnovel.drafting',
        name: '正文起草',
        tools: ['read_file', 'search_text', 'write_file', 'edit_file'],
        fs: {mode: 'workspace-write', writableRoots: ['草稿区']},
    }, overrides));
}

const compose = (over) => composeAgentCapabilities(Object.assign({
    preset: makePreset(),
    owner: 'webnovel',
    parentScope: 'auto',
    parentSessionId: 'sess-1',
    workspaceRoot: 'D:/book',
    worktreePath: '',
    parentToolFace: null,
    knownTools: KNOWN,
    globalMaxDepth: 3,
    grantPresetWrite: true,
}, over));

// ---------- §4.2 非法情形：派单时直接失败 ----------

test('未知工具名 → 派单失败，错误信息带工具名（对齐 DSH unknown-name 拒绝）', () => {
    assert.throws(() => compose({preset: makePreset({tools: ['read_file', 'no_such_tool']})}),
        /未知工具.*no_such_tool/);
});

test('插件 preset 声明 fs.mode=danger-full-access → 派单失败（提权漏洞封堵）', () => {
    assert.throws(() => compose({preset: makePreset({fs: {mode: 'danger-full-access'}})}),
        /danger-full-access/);
    // 宿主内置 host.full-write 是唯一合法来源
    const full = getAgentPreset(HOST_PRESET_FULL_WRITE);
    const caps = compose({preset: full.preset, owner: full.owner, parentScope: 'full'});
    assert.equal(caps.fs.mode, 'danger-full-access');
    // 但父档不是 full 时仍失败（§10.4：仅父档 full 可派）
    assert.throws(() => compose({preset: full.preset, owner: full.owner, parentScope: 'auto'}),
        /父会话权限档/);
});

test('可写根逃出工作区（绝对路径指向工作区外）→ 派单失败', () => {
    assert.throws(() => compose({preset: makePreset({fs: {mode: 'workspace-write', writableRoots: ['D:/elsewhere']}})}),
        /逃出工作区/);
    // 没有工作区根时相对声明无法解析 → 同样失败，绝不悄悄放宽
    assert.throws(() => compose({preset: makePreset(), workspaceRoot: ''}),
        /没有工作区|无法解析/);
});

test('相对可写根相对工作区解析为绝对路径并定死（§3）', () => {
    const caps = compose({});
    assert.deepEqual(caps.fs.writableRoots, ['D:/book/草稿区']);
    // 全部为正斜杠绝对路径
    for (const root of caps.fs.writableRoots) assert.ok(/^[a-z]:\//i.test(root), root);
});

// ---------- §10.3 父档上限取交 ----------

test('父档上限取交：preset 请求比父档宽 → 派单失败（不是静默钳制）', () => {
    // read / edit 父档拿不到 workspace-write
    assert.throws(() => compose({parentScope: 'read'}), /父会话权限档/);
    assert.throws(() => compose({parentScope: 'edit'}), /父会话权限档/);
    // auto 父档恰好够 workspace-write
    assert.equal(compose({parentScope: 'auto'}).fs.mode, 'workspace-write');
    // full 父档也不放 danger（preset 只声明了 workspace-write）
    assert.equal(compose({parentScope: 'full'}).fs.mode, 'workspace-write');
    assert.deepEqual(PARENT_FS_CAP, {full: 'danger-full-access', auto: 'workspace-write', edit: 'read-only', read: 'read-only'});
});

test('host.default：followParent 等价旧「默认封顶 auto」，不抛错（§10.4 现状等价）', () => {
    const def = getAgentPreset(HOST_PRESET_DEFAULT);
    assert.equal(def.owner, 'host');
    // full 父档 → workspace-write（封顶 auto 的现状语义，不是 danger）
    assert.equal(compose({preset: def.preset, owner: 'host', parentScope: 'full'}).fs.mode, 'workspace-write');
    assert.equal(compose({preset: def.preset, owner: 'host', parentScope: 'auto'}).fs.mode, 'workspace-write');
    // read / edit 父档 → read-only（现状 read/edit 档子代理命令只读）
    assert.equal(compose({preset: def.preset, owner: 'host', parentScope: 'read'}).fs.mode, 'read-only');
    assert.equal(compose({preset: def.preset, owner: 'host', parentScope: 'edit'}).fs.mode, 'read-only');
    // 工具面 = 只读白名单 + 命令四件套，无写工具；可跑 go test / npm test（回归验收 §11.1）
    const caps = compose({preset: def.preset, owner: 'host', parentScope: 'auto', workspaceRoot: 'D:/book'});
    for (const name of ['run_command', 'background_command', 'check_command', 'stop_command',
        'read_file', 'search_text', 'spawn_agent', 'wait_agent', 'agent_send', 'ask_user']) {
        assert.ok(caps.tools.allow.includes(name), 'host.default 必须含 ' + name);
    }
    assert.ok(!caps.tools.allow.includes('write_file'), 'host.default 无写工具');
    assert.equal(caps.execution.command, 'sandboxed');
    assert.equal(caps.delegation.canSpawn, true);
    // 默认可写根 = 整个工作区（无写工具时只是潜在边界，与现状「命令写效应圈工作区」等价）
    assert.deepEqual(caps.fs.writableRoots, ['D:/book']);
});

test('host.read-only：无命令工具、不能再派（编排强制收窄落点）', () => {
    const ro = getAgentPreset(HOST_PRESET_READ_ONLY);
    assert.equal(ro.owner, 'host');
    const caps = compose({preset: ro.preset, owner: 'host', parentScope: 'auto'});
    assert.equal(caps.fs.mode, 'read-only');
    assert.equal(caps.execution.command, 'denied');
    assert.ok(!caps.tools.allow.includes('run_command'));
    assert.ok(caps.tools.allow.includes('read_file'));
    assert.equal(caps.delegation.canSpawn, false);
});

test('host.read-only 强制收窄覆盖编排派单参数（阶段零：不信任派单参数）', () => {
    // 编排会话派单点名写 preset → 宿主侧改用 host.read-only（startSubAgent 侧的实现，
    // 这里验证合成结果与编排语义一致：只读、无写工具、不能再派）
    const caps = compose({
        preset: getAgentPreset(HOST_PRESET_READ_ONLY).preset,
        owner: 'host',
        parentScope: 'full',
        grantPresetWrite: true,
    });
    assert.equal(caps.fs.mode, 'read-only');
    assert.ok(!caps.tools.allow.includes('write_file'));
    assert.equal(caps.delegation.canSpawn, false);
});

// ---------- worktree 隔离（§7 / §10.1 语义纯化） ----------

test('isolation=worktree 注入 writableRoots=前缀 + 写工具；连 danger 也被收窄到前缀', () => {
    // host.default + worktree（现状：只读父档/计划模式也能给 worktree 前缀写，回灌走 export 审批）
    const caps = compose({
        preset: getAgentPreset(HOST_PRESET_DEFAULT).preset,
        owner: 'host',
        parentScope: 'read',
        worktreePath: 'D:/book/.cadt/worktree/sub-ab12',
    });
    assert.equal(caps.fs.mode, 'workspace-write');
    assert.deepEqual(caps.fs.writableRoots, ['D:/book/.cadt/worktree/sub-ab12']);
    for (const name of ['write_file', 'edit_file']) {
        assert.ok(caps.tools.allow.includes(name), 'worktree 必须挂 ' + name);
    }
    // 沙箱根优先取 worktree（现状 P2 写根来源）
    assert.equal(caps.fs.workspaceRoot, 'D:/book/.cadt/worktree/sub-ab12');
    // host.full-write + worktree：danger 收窄到前缀（现状 sandbox:'full'+worktree 即如此）
    const full = compose({
        preset: getAgentPreset(HOST_PRESET_FULL_WRITE).preset,
        owner: 'host',
        parentScope: 'full',
        worktreePath: 'D:/book/.cadt/worktree/sub-ab12',
    });
    assert.equal(full.fs.mode, 'workspace-write');
    assert.deepEqual(full.fs.writableRoots, ['D:/book/.cadt/worktree/sub-ab12']);
});

test('worktree 前缀写不受父档上限取交拦截（隔离车道，改动经 export 人工审批）', () => {
    // 现状等价：read / planMode 会话也能派 worktree 子代理试改
    const caps = compose({
        preset: getAgentPreset(HOST_PRESET_DEFAULT).preset,
        owner: 'host',
        parentScope: 'read',
        worktreePath: 'D:/book/.cadt/worktree/wt-1',
    });
    assert.equal(caps.fs.mode, 'workspace-write');
});

// ---------- 工具面取交（§10.3：父代理自己没有的工具不能给子代理） ----------

test('嵌套派单：preset 工具面与父快照 allow 取交', () => {
    const caps = compose({
        parentToolFace: ['read_file', 'search_text'],
    });
    assert.deepEqual(caps.tools.allow, ['read_file', 'search_text']);
    // 主代理派单（parentToolFace=null）不设限
    assert.deepEqual(compose({parentToolFace: null}).tools.allow, ['read_file', 'search_text', 'write_file', 'edit_file']);
});

// ---------- delegation / interaction（§3） ----------

test('delegation.maxDepth 与全局设置取 min，快照只收窄不放宽', () => {
    const preset = makePreset({delegation: {canSpawn: true, maxDepth: 2}});
    assert.equal(compose({preset, globalMaxDepth: 5}).delegation.maxDepth, 2);
    assert.equal(compose({preset, globalMaxDepth: 3}).delegation.maxDepth, 2);
    // 全局不设限（0）→ 用 preset 值；preset 不限（0）→ 用全局值
    assert.equal(compose({preset, globalMaxDepth: 0}).delegation.maxDepth, 2);
    assert.equal(compose({preset: makePreset({delegation: {canSpawn: true, maxDepth: 0}}), globalMaxDepth: 3}).delegation.maxDepth, 3);
    // canSpawn 缺省 false（最小权限）：插件 preset 不声明就没有再派权
    assert.equal(compose({}).delegation.canSpawn, false);
    assert.equal(compose({preset: makePreset({delegation: {canSpawn: true}})}).delegation.canSpawn, true);
    // interaction.askParent 缺省 true（现状：后台可 ask_user 问父代理）
    assert.equal(compose({}).interaction.askParent, true);
    assert.equal(compose({preset: makePreset({interaction: {askParent: false}})}).interaction.askParent, false);
});

// ---------- 快照固定字段（§3） ----------

test('快照固定字段：approval 恒 never、readRoots 恒 null（读边界沿用 scope 链）', () => {
    const caps = compose({});
    assert.equal(caps.execution.approval, 'never');
    assert.equal(caps.fs.readRoots, null);
    assert.equal(caps.granted.pluginId, 'webnovel');
    assert.equal(caps.granted.parentSessionId, 'sess-1');
    assert.ok(caps.granted.at > 0);
    assert.equal(caps.preset, 'webnovel.drafting');
});

// ---------- 能力确认（§6.3） ----------

test('grantPresetWrite=false：preset 写边界与写工具剥掉（撤销后恢复默认只读）', () => {
    const caps = compose({grantPresetWrite: false});
    assert.equal(caps.fs.mode, 'read-only');
    assert.deepEqual(caps.fs.writableRoots, []);
    for (const name of ['write_file', 'edit_file']) {
        assert.ok(!caps.tools.allow.includes(name), '未确认时不得有 ' + name);
    }
    // worktree 隔离不受确认闸影响（隔离车道）
    const wt = compose({grantPresetWrite: false, worktreePath: 'D:/book/.cadt/worktree/wt-2'});
    assert.equal(wt.fs.mode, 'workspace-write');
    assert.ok(wt.tools.allow.includes('write_file'));
});

// ---------- 注册表（§4.4 / §10.4） ----------

test('注册表：插件 preset 可注册 / 按 owner 撤销；宿主内置不可覆盖', () => {
    revokeAllPluginAgentPresets();
    assert.throws(() => registerAgentPreset({id: 'host.default'}, 'plugin-x'), /已注册|宿主内置|不可覆盖|宿主命名空间/);
    assert.throws(() => registerAgentPreset({id: 'x.y'}, ''), /owner/);
    assert.throws(() => registerAgentPreset({id: 'bad id!'}, 'plugin-x'), /id 无效/);
    registerAgentPreset({id: 'webnovel.drafting', tools: ['read_file']}, 'webnovel');
    registerAgentPreset({id: 'webnovel.review', tools: ['read_file']}, 'webnovel');
    registerAgentPreset({id: 'other.z', tools: ['read_file']}, 'other');
    assert.ok(isHostPresetId(HOST_PRESET_DEFAULT));
    assert.ok(!isHostPresetId('webnovel.drafting'));
    assert.equal(unregisterAgentPresetsByOwner('webnovel'), 2);
    assert.equal(getAgentPreset('webnovel.drafting'), null);
    assert.ok(getAgentPreset('other.z'));
    assert.equal(unregisterAgentPresetsByOwner('host'), 0, '宿主内置不被 owner 撤销');
    revokeAllPluginAgentPresets();
    // 撤后宿主内置仍在
    assert.ok(getAgentPreset(HOST_PRESET_DEFAULT));
    assert.ok(listAgentPresetIds().includes(HOST_PRESET_FULL_WRITE));
});

test('normalizeAgentPreset：能力维度缺省取最窄值，字段全有值', () => {
    const p = normalizeAgentPreset({id: 'a.b'});
    assert.equal(p.fs.mode, 'read-only');
    assert.deepEqual(p.fs.writableRoots, []);
    assert.equal(p.fs.followParent, false);
    assert.equal(p.delegation.canSpawn, false);
    assert.equal(p.execution.command, 'sandboxed');
    assert.equal(p.interaction.askParent, true);
    // 非法 mode / command 归一为最窄 / 缺省
    const p2 = normalizeAgentPreset({id: 'a.c', fs: {mode: 'yolo'}, execution: {command: 'raw'}});
    assert.equal(p2.fs.mode, 'read-only');
    assert.equal(p2.execution.command, 'sandboxed');
});

// ---------- 写判定（§5.3 快筛） ----------

test('subWriteVerdict：read-only 拒、workspace-write 看可写根、full 直通', () => {
    const caps = compose({});
    assert.equal(subWriteVerdict(caps, 'D:/book/草稿区/第一章.md').verdict, 'allow');
    assert.equal(subWriteVerdict(caps, 'D:/book/定稿/第一章.md').verdict, 'deny');
    // 大小写 / 反斜杠变体（§7 前端快筛）
    assert.equal(subWriteVerdict(caps, 'd:/BOOK/草稿区/a.MD').verdict, 'allow');
    // 前缀兄弟目录不误放
    assert.equal(subWriteVerdict(caps, 'D:/book/草稿区2/a.md').verdict, 'deny');
    assert.equal(subWriteVerdict(READ_ONLY_CAPABILITIES, 'D:/book/草稿区/a.md').verdict, 'deny');
    // full 直通（工作区外也放）
    const full = getAgentPreset(HOST_PRESET_FULL_WRITE);
    const fullCaps = compose({preset: full.preset, owner: 'host', parentScope: 'full'});
    assert.equal(subWriteVerdict(fullCaps, 'C:/anywhere/outside.txt').verdict, 'allow');
});

test('pathInWritableRoots / pathWithin / resolveWritableRoots：边界与穿越', () => {
    assert.equal(pathWithin('D:/a/b/c', 'D:/a/b'), true);
    assert.equal(pathWithin('D:/a/bc', 'D:/a/b'), false);
    assert.equal(pathWithin('D:/a/b', 'D:/a/b'), true);
    assert.equal(pathWithin('d:\\A\\B', 'D:/a/b'), true);
    assert.equal(pathInWritableRoots('D:/a/b/x', ['D:/other', 'D:/a/b']), true);
    assert.deepEqual(resolveWritableRoots(['草稿', 'D:/book/设定'], 'D:/book'), ['D:/book/草稿', 'D:/book/设定']);
    assert.throws(() => resolveWritableRoots(['../outside'], 'D:/book'), /逃出工作区/);
    assert.throws(() => resolveWritableRoots(['x'], ''), /无法解析|没有工作区/);
    assert.deepEqual(resolveWritableRoots([], 'D:/book'), []);
});

// ---------- guard 文案与序列化（§5.2 / §6.1 / §8.1 / §8.2） ----------

test('subToolDenyText：拒绝信息包含缺什么权限 / 可写范围（§6.1）', () => {
    const deny = subToolDenyText('write_file', compose({}));
    assert.ok(deny.includes('write_file'));
    assert.ok(deny.includes('D:/book/草稿区'), '要写出可写范围');
    const ro = subToolDenyText('run_command', READ_ONLY_CAPABILITIES);
    assert.ok(ro.includes('只读授权'), '只读快照要说明没拿到写能力');
});

test('serializeCapabilities / parseCapabilities：往返一致，坏数据拒绝（§8.2）', () => {
    const caps = compose({});
    const encoded = serializeCapabilities(caps);
    assert.deepEqual(parseCapabilities(encoded), encoded);
    // 缺 fs.mode → null（缺关键字段拒绝续跑）
    assert.equal(parseCapabilities({preset: 'x', tools: {allow: []}}), null);
    assert.equal(parseCapabilities(null), null);
    // 未知 fs.mode → null
    assert.equal(parseCapabilities({preset: 'x', fs: {mode: 'yolo'}, tools: {allow: []}}), null);
    // 深冻结：合成产物是机制级不可变（写它 = TypeError），序列化不引用原对象
    assert.equal(Object.isFrozen(caps), true);
    assert.equal(Object.isFrozen(caps.tools), true);
    assert.equal(Object.isFrozen(caps.fs.writableRoots), true);
    assert.throws(() => { caps.fs.mode = 'danger-full-access'; }, TypeError);
});

// ---------- 2026-11-28 审查修复的回归钉 ----------

test('插件 preset 声明 followParent 不生效：按显式 mode 走父档校验（堵确认卡绕过口）', () => {
    // 实证过的提权口：插件声明 fs:{followParent:true} 曾绕过 §10.3 取交与 §6.3 确认卡，
    // 合成出 workspace-write + 全工作区可写根。现在 followParent 只认宿主内置（owner='host'）。
    const quiet = makePreset({fs: {followParent: true}});
    const caps = compose({preset: quiet, parentScope: 'auto'});
    assert.equal(caps.fs.mode, 'read-only', '插件 followParent 被忽略，按声明的 read-only 合成');
    assert.deepEqual(caps.fs.writableRoots, []);
    // 借道失败：显式 mode 更宽在 read 父档下照样派单失败，不会因为带了 followParent 变钳制
    const louder = makePreset({fs: {followParent: true, mode: 'workspace-write', writableRoots: ['草稿区']}});
    assert.throws(() => compose({preset: louder, parentScope: 'read'}), /父会话权限档/);
    // 宿主内置仍享有 followParent 语义
    const def = getAgentPreset(HOST_PRESET_DEFAULT);
    assert.equal(compose({preset: def.preset, owner: 'host', parentScope: 'full'}).fs.mode, 'workspace-write');
});

test('无工作区根 + 绝对可写根 → 派单失败（与相对根同口径 fail-closed，§4.2）', () => {
    assert.throws(() => compose({
        preset: makePreset({fs: {mode: 'workspace-write', writableRoots: ['D:/elsewhere']}}),
        workspaceRoot: '',
    }), /没有工作区根|无法校验边界/);
});

test('delegation.maxDepth 跨层累积：子快照吃 min(全局, preset, 父快照)', () => {
    // 祖先 preset 声明 maxDepth=2：孙代派单判定吃父快照 2，孙代自己的快照也必须带着 2——
    // 否则祖先的收窄在第二跳失效（host.default 的孙代快照曾回到全局值 5）
    const preset = makePreset({delegation: {canSpawn: true, maxDepth: 0}});
    const caps = compose({preset, globalMaxDepth: 5, parentCapsMaxDepth: 2});
    assert.equal(caps.delegation.maxDepth, 2);
    // 三方取 min
    assert.equal(compose({preset: makePreset({delegation: {canSpawn: true, maxDepth: 4}}),
        globalMaxDepth: 5, parentCapsMaxDepth: 3}).delegation.maxDepth, 3);
    // 全 0 = 不设限
    assert.equal(compose({preset, globalMaxDepth: 0, parentCapsMaxDepth: 0}).delegation.maxDepth, 0);
});

test('preset 声明子代理工具面之外的工具 → 派单失败（不静默损失，§4.2）', () => {
    const projectable = subagentProjectableToolNames();
    const hostile = makePreset({tools: ['read_file', 'terminal']});
    assert.throws(() => compose({preset: hostile, projectableTools: projectable}),
        /工具面之外.*terminal/);
    // 宿主内置三件套的工具全部可投影
    for (const id of [HOST_PRESET_DEFAULT, HOST_PRESET_READ_ONLY, HOST_PRESET_FULL_WRITE]) {
        const entry = getAgentPreset(id);
        const caps = compose({
            preset: entry.preset, owner: 'host', parentScope: 'full', projectableTools: projectable,
        });
        assert.ok(caps.tools.allow.length > 0, id + ' 工具面必须可投影');
    }
});

test('worktree 替换语义：host.default + auto 父档也只写前缀（隔离不被默认根击穿，§11.1）', () => {
    // 审查实证的 P0：默认根回退 [workspaceRoot] 若被 worktree 分支带入，
    // 最常见的 host.default + auto 组合会拿到 [前缀 + 整个工作区]。
    for (const parentScope of ['auto', 'full']) {
        const caps = compose({
            preset: getAgentPreset(HOST_PRESET_DEFAULT).preset,
            owner: 'host',
            parentScope,
            worktreePath: 'D:/book/.cadt/worktree/sub-ab12',
        });
        assert.deepEqual(caps.fs.writableRoots, ['D:/book/.cadt/worktree/sub-ab12'],
            parentScope + ' 父档的 worktree 子代理只许写隔离前缀');
        assert.equal(subWriteVerdict(caps, 'D:/book/README.md').verdict, 'deny', parentScope + ' 主根写入必须被拒');
        assert.equal(subWriteVerdict(caps, 'D:/book/.cadt/worktree/sub-ab12/a.js').verdict, 'allow');
    }
    // 插件写 preset 自身声明的根同样不带入 worktree 车道
    const pluginWt = compose({parentScope: 'auto', worktreePath: 'D:/book/.cadt/worktree/wt-9'});
    assert.deepEqual(pluginWt.fs.writableRoots, ['D:/book/.cadt/worktree/wt-9']);
});

test('host.read-only + worktree：preset 声明赢——保持只读、不挂写工具（§10.1 定案）', () => {
    const ro = getAgentPreset(HOST_PRESET_READ_ONLY);
    const caps = compose({preset: ro.preset, owner: 'host', parentScope: 'auto', worktreePath: 'D:/book/.cadt/worktree/wt-ro'});
    assert.equal(caps.fs.mode, 'read-only');
    assert.ok(!caps.tools.allow.includes('write_file'), '只读 preset 不因 worktree 获得写工具');
    assert.ok(!caps.tools.allow.includes('run_command'));
    // worktree 前缀仍记录在案（沙箱根优先它），只是没有任何写通道可用
    assert.deepEqual(caps.fs.writableRoots, ['D:/book/.cadt/worktree/wt-ro']);
});

test('preset id 不得占用宿主命名空间 host.*（§4 命名空间语义）', () => {
    assert.throws(() => registerAgentPreset({id: 'host.custom'}, 'plugin-y'), /宿主命名空间/);
    assert.equal(getAgentPreset('host.custom'), null);
});

test('语义定案：插件写 preset + worktree + 低父档仍派单失败（preset 自身声明照常受父档校验）', () => {
    // worktree 前缀写是隔离车道豁免，但 preset 自身声明的 workspace-write（工作区目录）
    // 不是前缀写——从 read/edit 父档拿它就是越权，worktree 隔离不构成豁免。
    assert.throws(() => compose({parentScope: 'read', worktreePath: 'D:/book/.cadt/worktree/wt-3'}),
        /父会话权限档/);
    // host.default（followParent）+ worktree 在 read 父档下不受拦截（现状等价，隔离车道）
    const caps = compose({
        preset: getAgentPreset(HOST_PRESET_DEFAULT).preset,
        owner: 'host', parentScope: 'read', worktreePath: 'D:/book/.cadt/worktree/wt-3',
    });
    assert.equal(caps.fs.mode, 'workspace-write');
});

test('源码钉住：spawn_agent 不再有 sandbox 参数，subToolsForScope 不再有 hasWorktree 写分支', () => {
    const defs = readFileSync(new URL('../../../src/ai/tools/ai-tool-defs.js', import.meta.url), 'utf8');
    const defStart = defs.indexOf('spawn_agent: {');
    const defEnd = defs.indexOf('env_list: {', defStart);
    const spawnDef = defs.slice(defStart, defEnd);
    assert.ok(!/sandbox\s*:/.test(spawnDef), 'spawn_agent 的 sandbox 参数应已删除');
    assert.ok(spawnDef.includes('preset:'), 'spawn_agent 应声明 preset 参数');
    const subs = readFileSync(new URL('../../../src/ai/agent/ai-subagents.js', import.meta.url), 'utf8');
    assert.ok(!/if \(hasWorktree\) list\.push/.test(subs), 'worktree 写工具特判应已删除');
});
