// ai-desktop-control.test.mjs —— 桌面控制（Computer Use）新模型：会话级启用 +
// 控制模式声明（2026-11-22 用户重设计）。旧模型的「应用级单飞」与「windows_desktop
// 懒加载揭示」已被移除，这里按新契约断言：
//   · 启用是会话字段（session.desktopEnabled），模块只做判定；
//   · 控制模式只存内存（重启即清空），进入要求「已启用 + 桌面 server 有工具」；
//   · 工具注入 = 仅控制模式期间；退出即移除；
//   · 配置行一步到位（enabled + 白名单勾选），供「安装…」按钮直接写。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DESKTOP_MCP_SERVER,
    DESKTOP_ALL_TOOLS,
    DESKTOP_HIGH_RISK_TOOLS,
    DESKTOP_AVAILABILITY,
    controlModeActionOf,
    createAIDesktopControl,
    desktopAvailability,
    desktopAvailabilityMessage,
    desktopAvailabilitySummary,
    desktopConfigNeedsUpgrade,
    desktopServerConfigRow,
    isDesktopToolDef,
    isDesktopToolName,
} from '../../src/ai/ai-desktop-control.js';

const defs = (names) => names.map((n) => ({
    name: 'mcp__windows__' + n,
    description: '工具 ' + n,
    parameters: {type: 'object', properties: {}},
    mcpServer: DESKTOP_MCP_SERVER,
    mcpRawName: n,
}));

const session = (id, extra) => Object.assign({id}, extra || {});

function makeCtl(list = defs(['Snapshot', 'Click'])) {
    const changes = [];
    const ctl = createAIDesktopControl({
        mcpToolDefs: () => list,
        onControlChange: (s) => changes.push(s && s.id),
    });
    return {ctl, changes, list};
}

test('server 判定只认 def.mcpServer === windows', () => {
    assert.equal(DESKTOP_MCP_SERVER, 'windows');
    assert.ok(isDesktopToolName('mcp__windows__Snapshot'));
    assert.ok(!isDesktopToolName('mcp__other__Snapshot'));
    assert.ok(!isDesktopToolName('windows'));
    assert.ok(!isDesktopToolName(null));
    assert.ok(isDesktopToolDef({mcpServer: 'windows'}));
    assert.ok(!isDesktopToolDef({mcpServer: 'tts_local'}));
    assert.ok(!isDesktopToolDef(null));
});

test('controlModeActionOf：enter / exit / status 与中文别名，非法返回空串', () => {
    assert.equal(controlModeActionOf({action: 'enter'}), 'enter');
    assert.equal(controlModeActionOf({action: 'ENTER'}), 'enter');
    assert.equal(controlModeActionOf({action: '进入'}), 'enter');
    assert.equal(controlModeActionOf({action: 'exit'}), 'exit');
    assert.equal(controlModeActionOf({action: 'off'}), 'exit');
    assert.equal(controlModeActionOf({action: '退出'}), 'exit');
    assert.equal(controlModeActionOf({action: 'status'}), 'status');
    assert.equal(controlModeActionOf({action: 'wat'}), '');
    assert.equal(controlModeActionOf(null), '');
});

test('会话启用判定：只看 session.desktopEnabled，不做应用级单飞', () => {
    const {ctl} = makeCtl();
    const a = session('a');
    const b = session('b', {desktopEnabled: true});
    assert.equal(ctl.enabledOn(a), false);
    assert.equal(ctl.enabledOn(b), true);
    assert.equal(ctl.enabledOn(null), false);
    // 多个会话可以同时启用（会话字段各自独立，模块不持有任何全局授权）
    const c = session('c', {desktopEnabled: true});
    assert.equal(ctl.enabledOn(c), true);
    assert.equal(ctl.enabledOn(b), true);
});

test('进入控制模式：未启用拒绝；未安装拒绝；成功后 activeOn 为真且注入白名单工具', () => {
    const {ctl, changes} = makeCtl();
    const s = session('s1');
    assert.equal(ctl.activeOn(s), false);
    assert.deepEqual(ctl.defsForSession(s), []);

    // 未启用
    const denied = ctl.enter(s, '试一下');
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'not-enabled');

    // 已启用但桌面 server 没有注册工具（未安装 / 未启动）
    const empty = makeCtl([]);
    const s2 = session('s2', {desktopEnabled: true});
    const noTools = empty.ctl.enter(s2, '');
    assert.equal(noTools.ok, false);
    assert.equal(noTools.reason, 'not-installed');

    // 正常进入
    s.desktopEnabled = true;
    const ok = ctl.enter(s, '在记事本里输入配置');
    assert.equal(ok.ok, true);
    assert.equal(ok.already, false);
    assert.deepEqual(ok.tools, ['mcp__windows__Snapshot', 'mcp__windows__Click']);
    assert.equal(ctl.activeOn(s), true);
    assert.deepEqual(ctl.activeInfo(s).reason, '在记事本里输入配置');
    assert.equal(ctl.defsForSession(s).length, 2);
    assert.deepEqual(changes, ['s1']);

    // 重复进入幂等（不再触发回调、不再重复算「刚进入」）
    const again = ctl.enter(s, '');
    assert.equal(again.already, true);
    assert.deepEqual(changes, ['s1']);
});

test('退出控制模式：幂等、不审批；退出后工具立刻移除；会通知面板', () => {
    const {ctl, changes} = makeCtl();
    const s = session('s1', {desktopEnabled: true});
    ctl.enter(s, '');
    const out = ctl.exit(s);
    assert.equal(out.ok, true);
    assert.equal(out.wasActive, true);
    assert.equal(ctl.activeOn(s), false);
    assert.deepEqual(ctl.defsForSession(s), []);
    assert.deepEqual(changes, ['s1', 's1']);
    // 再退一次：不报错、不重复通知
    const twice = ctl.exit(s);
    assert.equal(twice.wasActive, false);
    assert.deepEqual(changes, ['s1', 's1']);
});

test('控制模式按会话隔离：A 处于控制模式不影响 B；clearSession 收尾', () => {
    const {ctl} = makeCtl();
    const a = session('a', {desktopEnabled: true});
    const b = session('b', {desktopEnabled: true});
    ctl.enter(a, '');
    assert.equal(ctl.activeOn(a), true);
    assert.equal(ctl.activeOn(b), false);
    assert.deepEqual(ctl.defsForSession(b), []);
    assert.deepEqual(ctl.snapshot().sessions, ['a']);
    ctl.clearSession('a');
    assert.equal(ctl.activeOn(a), false);
    assert.deepEqual(ctl.snapshot().sessions, []);
});

test('installedCount：只数 windows server 的工具（外部工具页开关的可用性判定）', () => {
    const mixed = defs(['Snapshot']).concat([
        {name: 'mcp__tts__speak', mcpServer: 'tts_local', description: 'x', parameters: {}},
        {name: 'mcp__ocr__read', mcpServer: 'ocr_windows', description: 'y', parameters: {}},
    ]);
    const {ctl} = makeCtl(mixed);
    assert.equal(ctl.installedCount(), 1);
    assert.equal(makeCtl([]).ctl.installedCount(), 0);
});

test('DESKTOP_ALL_TOOLS：上游 21 个 + 本地补丁的 Find = 22，高危组是子集', () => {
    assert.equal(DESKTOP_ALL_TOOLS.length, 22, '上游 21 个工具 + 本地补丁新增的 Find');
    assert.equal(new Set(DESKTOP_ALL_TOOLS).size, 22, '清单里不能有重复');
    assert.ok(DESKTOP_ALL_TOOLS.includes('Find'), '本地补丁新增的 Find 必须在清单里（否则设置页看不到、enabledTools 也不会勾它）');
    for (const name of ['Snapshot', 'Screenshot', 'Click', 'Type', 'WaitFor', 'Scrape', 'App',
        'PowerShell', 'FileSystem', 'Registry', 'Process', 'ControlStatus']) {
        assert.ok(DESKTOP_ALL_TOOLS.includes(name), name + ' 必须在上游工具清单里');
    }
    for (const name of DESKTOP_HIGH_RISK_TOOLS) {
        assert.ok(DESKTOP_ALL_TOOLS.includes(name), name + ' 的高危标注必须指向真实工具');
    }
});

test('desktopConfigNeedsUpgrade：只认结构性旧形态，不因用户取消勾选而反复判脏', () => {
    const latest = desktopServerConfigRow();
    assert.equal(desktopConfigNeedsUpgrade(latest), false);
    assert.equal(desktopConfigNeedsUpgrade(null), false);

    // 旧形态①：有 --from，但缺 --no-control（上游会弹接管确认窗，2026-11-22 用户实测）
    assert.equal(desktopConfigNeedsUpgrade(Object.assign({}, latest, {
        args: ['--from', 'C:/x/windows_mcp-0.8.9-py3-none-any.whl', 'windows-mcp', 'serve'],
    })), true);

    // 旧形态②：从 PyPI 现拉（缺 --from），应升级成内置 wheel
    assert.equal(desktopConfigNeedsUpgrade(Object.assign({}, latest, {
        args: ['windows-mcp@0.8.9', 'serve', '--no-control'],
    })), true);

    // 旧形态⑤：--from 指向旧版本 wheel（版本升级后配置没跟上）——按 plan 比对判脏
    const plan = {wheelPath: 'C:/data/builtin-desktop-mcp/0.8.9+p3/windows_mcp-0.8.9+p3-py3-none-any.whl'};
    assert.equal(desktopConfigNeedsUpgrade(Object.assign({}, latest, {
        args: ['--from', 'C:/data/builtin-desktop-mcp/0.8.9/windows_mcp-0.8.9-py3-none-any.whl', 'windows-mcp', 'serve', '--no-control'],
    }), plan), true, '指向旧版本 wheel 必须判为需更新');
    assert.equal(desktopConfigNeedsUpgrade(Object.assign({}, latest, {
        args: ['--from', plan.wheelPath, 'windows-mcp', 'serve', '--no-control'],
    }), plan), false, '与 plan 一致时不该判脏');
    // 没有 plan（后端旧版）时不做版本比对，不能因此判脏
    assert.equal(desktopConfigNeedsUpgrade(Object.assign({}, latest, {
        args: ['--from', 'C:/data/builtin-desktop-mcp/0.8.9/old.whl', 'windows-mcp', 'serve', '--no-control'],
    })), false, '没有 plan 时不做版本比对');

    // 旧形态③：command 不是 uvx
    assert.equal(desktopConfigNeedsUpgrade(Object.assign({}, latest, {command: 'uvx-not-on-path'})), true);

    // 旧形态④：勾选为空 —— 空数组语义是「一个都不给」，等于装了不能用
    assert.equal(desktopConfigNeedsUpgrade(Object.assign({}, latest, {enabledTools: []})), true);

    // 新契约：用户逐项取消勾选是正常操作，不能判成需要升级
    assert.equal(desktopConfigNeedsUpgrade(Object.assign({}, latest, {enabledTools: ['Snapshot', 'Click']})), false);
    assert.equal(desktopConfigNeedsUpgrade(Object.assign({}, latest, {enabledTools: ['ControlStatus']})), false);

    // 用户自己写的 notes 也不动（升级判定已不看 notes）
    assert.equal(desktopConfigNeedsUpgrade(Object.assign({}, latest, {
        notes: '我自己的约定：只操作记事本。',
    })), false);
});

test('desktopServerConfigRow：内置 wheel（--from）+ 默认全选 + 超时放宽 + notes ≤1000', () => {
    // 没有 plan 时降级预览：路径占位，工具清单用前端常量
    const preview = desktopServerConfigRow();
    assert.equal(preview.command, 'uvx');
    assert.deepEqual(preview.args, ['--from', '<内置组件路径>', 'windows-mcp', 'serve', '--no-control']);
    assert.equal(preview.enabled, true);
    assert.deepEqual(preview.enabledTools, DESKTOP_ALL_TOOLS);
    assert.equal(preview.startupTimeoutMs, 600000);
    assert.equal(preview.env.ANONYMIZED_TELEMETRY, 'false');

    // 有 plan（后端 MCPDesktopPlan）时按它写：真实 wheel 路径 + 上游工具清单
    const wheel = 'C:/Users/x/builtin-desktop-mcp/0.8.9/windows_mcp-0.8.9-py3-none-any.whl';
    const plan = {
        version: '0.8.9',
        wheelPath: wheel,
        command: wheel ? 'uvx' : 'uvx',
        args: ['--from', wheel, 'windows-mcp', 'serve', '--no-control'],
        enabledTools: ['Snapshot', 'Click'],
        startupTimeoutMs: 600000,
        notes: '后端给的约定：任务结束调 windows_control_mode 退出。',
        tools: [{name: 'Snapshot'}, {name: 'Click'}, {name: 'PowerShell'}],
    };
    const row = desktopServerConfigRow(plan);
    assert.deepEqual(row.args, plan.args);
    assert.deepEqual(row.enabledTools, ['Snapshot', 'Click']);
    assert.equal(row.notes, plan.notes);
    assert.ok(row.notes.length <= 1000, 'notes 超过 ValidateServer 的 1000 字上限');

    // 兜底 notes 必须告诉模型任务结束时退出控制模式
    assert.match(desktopServerConfigRow().notes, /windows_control_mode/);

    // env / enabledTools 都是拷贝不是共享引用
    row.env.WINDOWS_MCP_MAX_TREE_ELEMENTS = '999';
    row.enabledTools.push('FileSystem');
    assert.equal(desktopServerConfigRow(plan).env.WINDOWS_MCP_MAX_TREE_ELEMENTS, '500');
    assert.deepEqual(desktopServerConfigRow(plan).enabledTools, ['Snapshot', 'Click']);
});

// 2026-11-23 用户实测缺陷：mcp.json 有 windows 行、开关开着、工具全勾，但 server 启动失败
// （uv 缺失 / 依赖没下完）时工具数是 0，旧代码据此回「桌面控制尚未安装…点『安装』」，
// 而卡片自 2026-11-22 起是「开关即安装」——界面上根本没有安装按钮，用户被指向死路。
// 四态判定必须把「没装」与「装了没起来」分开，并带上 state 与失败原因。
test('desktopAvailability：配置行 + 快照 state 区分未安装 / 未启用 / 启动中 / 启动失败 / 可用', () => {
    const row = (extra) => Object.assign({command: 'uvx', args: ['--from', 'x.whl', 'windows-mcp'], enabledTools: ['Snapshot']}, extra || {});
    const server = (extra) => Object.assign({name: DESKTOP_MCP_SERVER, state: 'connected', toolCount: 3}, extra || {});

    // ① 真没装：配置行与快照里都没有
    const none = desktopAvailability({configRow: null, server: null, configKnown: true, snapshotLoaded: true, mcpEnabled: true});
    assert.equal(none.kind, DESKTOP_AVAILABILITY.NOT_INSTALLED);
    assert.equal(none.installed, false);

    // ② 有行但总开关关 / 行停用 / 工具勾成空
    assert.equal(
        desktopAvailability({configRow: row(), server: null, configKnown: true, snapshotLoaded: true, mcpEnabled: false}).kind,
        DESKTOP_AVAILABILITY.DISABLED);
    assert.equal(
        desktopAvailability({configRow: row({enabled: false}), server: null, configKnown: true, snapshotLoaded: true, mcpEnabled: true}).kind,
        DESKTOP_AVAILABILITY.DISABLED);
    const noTools = desktopAvailability({configRow: row({enabledTools: []}), server: null, configKnown: true, snapshotLoaded: true, mcpEnabled: true});
    assert.equal(noTools.kind, DESKTOP_AVAILABILITY.DISABLED);
    assert.match(noTools.detail, /勾选/);

    // ③ 已安装 + 开关开，但 server 启动失败：这是本次缺陷的核心回归点
    const failed = desktopAvailability({
        configRow: row(),
        server: server({state: 'failed', toolCount: 0, lastError: 'uv: command not found'}),
        configKnown: true, snapshotLoaded: true, mcpEnabled: true,
    });
    assert.equal(failed.kind, DESKTOP_AVAILABILITY.FAILED, '启动失败不能被判成未安装');
    assert.equal(failed.installed, true);
    assert.equal(failed.state, 'failed');
    const failedText = desktopAvailabilityMessage(failed);
    assert.match(failedText, /state=failed/, '文案必须带 state');
    assert.match(failedText, /uv: command not found/, '文案必须带失败原因');
    assert.match(failedText, /不是未安装/, '必须明确「不是未安装」');
    assert.doesNotMatch(failedText, /点「安装」/, '不能再引导用户去找不存在的安装按钮');
    assert.match(desktopAvailabilitySummary(failed), /启动失败/, '权限面板短文案要能区分失败');

    // ④ 正在连（首次下载依赖要几分钟）
    const starting = desktopAvailability({
        configRow: row(), server: server({state: 'reconnecting', toolCount: 0}),
        configKnown: true, snapshotLoaded: true, mcpEnabled: true,
    });
    assert.equal(starting.kind, DESKTOP_AVAILABILITY.STARTING);
    assert.match(desktopAvailabilityMessage(starting), /正在连接/);

    // ⑤ 可用：已连上且有工具 → 才允许走审批
    assert.equal(
        desktopAvailability({configRow: row(), server: server(), configKnown: true, snapshotLoaded: true, mcpEnabled: true}).kind,
        DESKTOP_AVAILABILITY.READY);

    // ⑥ 配置与快照都读不到：不许断言「没装」（宁可报异常，也不要给错误指引）
    const unknown = desktopAvailability({configRow: null, server: null, configKnown: false, snapshotLoaded: false});
    assert.notEqual(unknown.kind, DESKTOP_AVAILABILITY.NOT_INSTALLED);

    // ⑦ 单有配置行（快照还没到）：不算没装，也不假装可用
    const noSnapshot = desktopAvailability({configRow: row(), server: null, configKnown: true, snapshotLoaded: false});
    assert.notEqual(noSnapshot.kind, DESKTOP_AVAILABILITY.NOT_INSTALLED);
    assert.notEqual(noSnapshot.kind, DESKTOP_AVAILABILITY.READY);

    // ⑧ 未安装的文案指向「打开开关」而不是「点安装」
    const notInstalledText = desktopAvailabilityMessage(none);
    assert.match(notInstalledText, /启用桌面控制/);
    assert.doesNotMatch(notInstalledText, /点「安装」/);
});
