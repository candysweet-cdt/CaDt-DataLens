// ai-notify-policy.js 的语义护栏：各通道的前提各不相同，别让后续改动悄悄合并回去。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildNotifyActivationPayload, desktopNotifyTargets, parseNotifyActivationPayload} from '../../../src/ai/core/ai-notify-policy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REPO = join(ROOT, '..'); // 仓库根（Go 侧文件在 frontend 外）
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const readRepo = (rel) => readFileSync(join(REPO, rel), 'utf8');

test('后台：弹系统卡片 + 闪任务栏，不弹应用内 toast（看不到软件，弹了也没意义）', () => {
    assert.deepEqual(
        desktopNotifyTargets({inApp: true, system: true, foreground: false, viewingOther: true}),
        {centerRecord: true, systemToast: true, inAppToast: false, taskbarFlash: true});
});

test('前台但看的是别的会话：弹应用内 toast，不弹系统卡片', () => {
    assert.deepEqual(
        desktopNotifyTargets({inApp: true, system: true, foreground: true, viewingOther: true}),
        {centerRecord: true, systemToast: false, inAppToast: true, taskbarFlash: false});
});

test('前台且正看着这个会话：什么都不弹（内容就在眼前），消息中心仍记', () => {
    assert.deepEqual(
        desktopNotifyTargets({inApp: true, system: true, foreground: true, viewingOther: false}),
        {centerRecord: true, systemToast: false, inAppToast: false, taskbarFlash: false});
});

test('任务完成：不弹应用内 toast、不闪任务栏、不写消息中心', () => {
    assert.deepEqual(
        desktopNotifyTargets({inApp: true, system: true, foreground: true, viewingOther: true, completion: true}),
        {centerRecord: false, systemToast: false, inAppToast: false, taskbarFlash: false});
    // 后台时系统卡片仍要弹（人不在电脑前，回来能看见）
    assert.deepEqual(
        desktopNotifyTargets({inApp: true, system: true, foreground: false, viewingOther: true, completion: true}),
        {centerRecord: false, systemToast: true, inAppToast: false, taskbarFlash: false});
});

// 完成通知曾经「永远记一条消息中心」，一轮一条直接把列表刷成流水账（同一条会话标题连着十几行）。
// 需要人回来处理的事件（失败 / 提问 / 审批 / notify_send）必须照旧记，别一起被砍掉。
test('消息中心口径：只有任务完成不记，其余事件一律记', () => {
    assert.equal(desktopNotifyTargets({completion: true}).centerRecord, false);
    assert.equal(desktopNotifyTargets({completion: 'true'}).centerRecord, true, 'completion 只认严格 true');
    assert.equal(desktopNotifyTargets({}).centerRecord, true);
    assert.equal(desktopNotifyTargets(null).centerRecord, true);
    assert.equal(desktopNotifyTargets({inApp: false, system: false}).centerRecord, true);
});

// 旧流水清理与「不再写完成」必须指向同一个标题：ai-panel 改了完成通知标题，
// message-center 里的过滤就会静默失效（旧条目留着，看起来像修复没生效）。
test('消息中心读取时剔除旧的「AI 任务完成」流水，标题与 ai-panel 一致', () => {
    const center = read('src/shell/message-center.js');
    assert.ok(/const LEGACY_DONE_TITLE = 'AI 任务完成';/.test(center), 'message-center 必须保留旧完成条目标题常量');
    assert.ok(/m\.kind === 'success' && m\.title === LEGACY_DONE_TITLE/.test(center),
        '只剔「success + 标题完全相同」的条目，自定义标题的 notify_send 消息不能误删');
    assert.ok(/title: 'AI 任务完成'/.test(read('src/ai/ai-panel.js')), 'ai-panel 的完成通知标题必须与清理口径一致');
});

test('开关全关 / 缺字段：一律不弹，不因字段缺失误开', () => {
    assert.deepEqual(
        desktopNotifyTargets({inApp: false, system: false, foreground: false, viewingOther: true}),
        {centerRecord: true, systemToast: false, inAppToast: false, taskbarFlash: false});
    assert.deepEqual(desktopNotifyTargets({}), {centerRecord: true, systemToast: false, inAppToast: false, taskbarFlash: false});
    assert.deepEqual(desktopNotifyTargets(null), {centerRecord: true, systemToast: false, inAppToast: false, taskbarFlash: false});
});

test('foreground 只认严格 true（缺字段视为后台，宁可多弹一条）', () => {
    assert.deepEqual(
        desktopNotifyTargets({inApp: true, system: true}),
        {centerRecord: true, systemToast: true, inAppToast: false, taskbarFlash: true});
    assert.deepEqual(
        desktopNotifyTargets({inApp: true, system: true, foreground: 'true'}),
        {centerRecord: true, systemToast: true, inAppToast: false, taskbarFlash: true});
});

// 系统通知点击激活：payload 随通知下发、点击后原样回传，往返必须无损（ai-session=<id>）。
test('激活参数往返：构建出的 payload 一定能解析回同一个会话 id', () => {
    // 含空格 / & / = 的 id 也要无损（encodeURIComponent 负责转义，解析端负责还原）
    for (const id of ['ai-abc123', 'ai-x_y-z.9', 'ai 带空格', 'ai&weird=id']) {
        const payload = buildNotifyActivationPayload(id);
        assert.match(payload, /^ai-session=/, 'payload 必须带 ai-session 键');
        assert.deepEqual(parseNotifyActivationPayload(payload), {sessionId: id});
    }
});

test('激活参数构建：无会话 / 空串返回空 payload（点击只拉窗口不跳转）', () => {
    assert.equal(buildNotifyActivationPayload(''), '');
    assert.equal(buildNotifyActivationPayload(null), '');
    assert.equal(buildNotifyActivationPayload(undefined), '');
    assert.equal(buildNotifyActivationPayload('   '), '');
});

test('激活参数解析：空 / 未知键 / 缺值一律返回 null，不误跳会话', () => {
    assert.equal(parseNotifyActivationPayload(''), null);
    assert.equal(parseNotifyActivationPayload(null), null);
    assert.equal(parseNotifyActivationPayload('other=1'), null);
    assert.equal(parseNotifyActivationPayload('ai-session='), null);
    assert.equal(parseNotifyActivationPayload('ai-session=%20%20'), null);
    // 容忍将来扩展的附加键
    assert.deepEqual(parseNotifyActivationPayload('ai-session=s1&kind=approve'), {sessionId: 's1'});
});

// 「通知点击没反应」是四处接线各掉一环都会复发的静默故障（历史教训：面板漏导出
// switchSession 抛 TypeError 被 try/catch 吞掉、Go 侧没注册激活器点击只等于关卡片）。
// 这里把每一环都钉住，掉任意一环直接红。
test('通知点击跳转的完整链路：四处接线一环不少', () => {
    // ① 面板公共 API 导出 switchSession（main.js focusSession 按名字调用）。
    // 锚定工厂的顶层 return（其后紧跟 toggle,）：裸找 '    return {' 会命中内层缩进的 return。
    const panelSrc = read('src/ai/ai-panel.js');
    const retStart = /return \{\s*\r?\n\s*toggle,/.exec(panelSrc);
    assert.ok(retStart, '找不到 ai-panel 工厂的顶层 return（结构变了请同步护栏）');
    const ret = panelSrc.slice(retStart.index);
    assert.ok(/switchSession,/.test(ret), 'ai-panel 的对外 return 必须导出 switchSession');
    // ② 发系统通知时必须带激活参数（第四参前的 payload）
    assert.ok(
        /NotifySystemToast\(title, body, buildNotifyActivationPayload\(sessionId\),/.test(panelSrc),
        'notifyDesktop 发系统通知必须带 buildNotifyActivationPayload(sessionId)');
    // ③ main.js 监听 Go 转发的激活事件并按参数跳会话
    const mainSrc = read('src/main.js');
    assert.ok(/(?:EventsOn|onWindow)\('ai-notify-activate'/.test(mainSrc), "main.js 必须监听 'ai-notify-activate'（控制命令走事件桥 onWindow）");
    assert.ok(mainSrc.includes('function focusAISession'), 'main.js 必须有 focusAISession 收口');
    assert.ok(/aiPanel\.switchSession/.test(mainSrc), 'focusAISession 必须调 aiPanel.switchSession');
    // ④ Go 侧接激活钩子 + 原样转发事件名；前端解析键与 Go 注释里的契约一致
    const goCore = readRepo('app_core.go');
    assert.ok(goCore.includes('notify.OnToastActivation = a.onToastActivation'), 'app_core 必须接 OnToastActivation 钩子');
    assert.ok(goCore.includes('"ai-notify-activate"'), 'Go 侧必须发 ai-notify-activate 事件');
    const goNotify = readRepo('internal/notify/notify_windows.go');
    assert.ok(goNotify.includes('ActivationArguments:'), 'NotifySystemToast 必须设置 ActivationArguments（launch 属性）');
    assert.ok(goNotify.includes('toast.SetActivationCallback'), '必须注册 COM 激活回调');
    assert.ok(goNotify.includes('toast.SetAppData'), '必须登记 CustomActivator / LocalServer32');
    // mock 与设置页测试按钮跟签名走（4 参：title/body/payload/silent）
    assert.ok(
        /NotifySystemToast\(title, body, payload, silent\)/.test(read('src/dev/mock-backend.js')),
        'mock-backend 的 NotifySystemToast 必须收 payload 参数');
    assert.ok(
        /NotifySystemToast\('CaDt-DataLens · 测试通知', '能看到这条，说明系统通知已通。', '', false\)/.test(read('src/ai/settings/ai-settings-dialog.js')),
        '设置页测试按钮调用必须带空 payload');
});

// notifyDesktop 有三条出口（开关全关的早退、前台判定后、completion 透传），
// 任何一条漏看 centerRecord 都会让完成通知重新漏进消息中心。
test('notifyDesktop 的每条出口都尊重 centerRecord', () => {
    const panelSrc = read('src/ai/ai-panel.js');
    assert.ok(
        /if \(targets\.centerRecord !== false && typeof opts\.addMessage === 'function'\)/.test(panelSrc),
        'addMessage 必须先看 targets.centerRecord');
    assert.ok(
        /deliver\(\{centerRecord: !completion, systemToast: false, inAppToast: false, taskbarFlash: false\}\)/.test(panelSrc),
        '开关全关的早退出口也要算 centerRecord（否则失败/审批会连消息都不留）');
    assert.ok(/const completion = options\.completion === true;/.test(panelSrc), 'completion 只能有一处判定');
    assert.ok(/^\s*completion,\s*$/m.test(panelSrc), 'completion 必须原样传给策略函数');
});
