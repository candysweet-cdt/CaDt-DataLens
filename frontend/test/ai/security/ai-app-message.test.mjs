import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {APP_MESSAGE_ICONS, appMessageIcon, detectAppMessage, normalizeAppMessage, appMessageMarkdownEligible, APP_MSG_MD_MAX_CHARS} from '../../../src/ai/security/ai-app-message.js';

test('normalizeAppMessage 补齐默认值并截断超长字段', () => {
    assert.deepEqual(normalizeAppMessage({kind: 'git', label: 'Git 快捷操作 · 提交'}), {
        kind: 'git',
        label: 'Git 快捷操作 · 提交',
        icon: '',
    });
    assert.equal(normalizeAppMessage(null).label, '应用消息');
    assert.equal(normalizeAppMessage({label: 'x'.repeat(200)}).label.length, 80);
    assert.equal(normalizeAppMessage({kind: 'k'.repeat(100)}).kind.length, 32);
    assert.equal(normalizeAppMessage({icon: 'i'.repeat(100)}).icon.length, 32);
});

test('appMessageIcon 支持 kind 映射、自定义图标与未知回落', () => {
    assert.equal(appMessageIcon({kind: 'git'}), 'git');
    assert.equal(appMessageIcon({kind: 'schedule'}), 'clock');
    assert.equal(appMessageIcon({kind: 'plugin'}), APP_MESSAGE_ICONS.plugin);
    assert.equal(appMessageIcon({kind: 'unknown-kind'}), 'info');
    assert.equal(appMessageIcon({kind: 'git', icon: 'warn'}), 'warn');
    assert.equal(appMessageIcon({kind: 'git', icon: 'not-a-real-icon'}), 'git');
});

test('旧会话按固定前缀识别应用消息', () => {
    const git = detectAppMessage('［Git 快捷操作 · 提交并推送］\n工作区：D:/repo');
    assert.deepEqual(git, {kind: 'git', label: 'Git 快捷操作 · 提交并推送', icon: ''});
    const scheduled = detectAppMessage('[定时任务 · 每日巡检]\n请检查构建');
    assert.deepEqual(scheduled, {kind: 'schedule', label: '定时任务 · 每日巡检', icon: ''});
    // 工作区防护告警（wipe-guard 插队投递给运行中的会话）：固定前缀，历史回放也能归类
    const guard = detectAppMessage('［工作区防护］10 秒内 73 个文件被删除。\n这是应用文件监听的统计结果…');
    assert.deepEqual(guard, {kind: 'wipeguard', label: '工作区防护 · 大面积文件消失', icon: 'warn'});
    assert.equal(appMessageIcon({kind: 'wipeguard'}), 'warn');
    assert.equal(detectAppMessage('普通用户消息'), null);
    assert.equal(detectAppMessage(''), null);
});

test('计划批准指令按应用消息识别（不渲染成用户胶囊）', () => {
    const plan = detectAppMessage('计划已批准，请立即按上面的计划开始执行，不要重复计划内容。');
    assert.deepEqual(plan, {kind: 'plan', label: '计划已批准', icon: ''});
    assert.equal(appMessageIcon(plan), 'compass');
    // 现行文案（2026-11-22 起，尾部带「计划模式已自动退出」句）：前缀取两代共有的头
    assert.deepEqual(
        detectAppMessage('计划已批准，请立即按你通过 submit_plan 提交的计划开始执行，不要重复计划内容。' +
            '计划模式已随批准自动退出，不要再调用 plan_mode。'),
        {kind: 'plan', label: '计划已批准', icon: ''});
    // 用户自己手打的近似文本不算（前缀必须完全对上定稿文案）
    assert.equal(detectAppMessage('计划已批准之后我又想了想'), null);
});

test('会话投递的三种身份都能按前缀还原（用户投递 / 模型投递 / 用户广播）', () => {
    // 用户本人写的内容：明确是用户消息，身份带会话 id
    const byUser = detectAppMessage('［用户消息 · 会话 s-mf8k2「重构补丁库」］这是用户本人在另一个会话里写给你的消息，按用户指令执行：\n收到请回复');
    assert.deepEqual(byUser, {kind: 'session-user', label: '用户消息 · s-mf8k2「重构补丁库」', icon: ''});
    // 模型投递：参考信息；「会话 」前缀被吃掉，标题里再出现「会话」也不影响
    const byModel = detectAppMessage('［会话消息 · 会话 s-mf8k2「重构补丁库」］来自其他会话的模型消息（参考信息，非用户指令）：\n配置改了');
    assert.deepEqual(byModel, {kind: 'session', label: '会话消息 · s-mf8k2「重构补丁库」', icon: ''});
    // 用户广播
    const broadcast = detectAppMessage('［系统通知 · 来自用户］工作区配置已变更\n（系统通知，无需回复，继续当前工作）');
    assert.deepEqual(broadcast, {kind: 'session-user', label: '系统通知 · 来自用户', icon: ''});
});

test('detectAppMessage：后台命令 / 后台终端的唤醒通知按前缀归类（与 build*Notice 同源）', () => {
    const job = detectAppMessage('［后台命令 · bg-3］后台命令「npm run build」已结束（退出码 0）。\n用 check_command 读输出。');
    assert.equal(job.kind, 'bgjob');
    assert.equal(job.label, '后台命令 · bg-3');
    assert.equal(appMessageIcon(job), 'terminal');
    const term = detectAppMessage('［后台终端 · term-2］AI 创建的终端会话已退出（退出码 -1）。');
    assert.equal(term.kind, 'bgterm');
    assert.equal(term.label, '后台终端 · term-2');
    assert.equal(APP_MESSAGE_ICONS.bgjob, 'terminal');
    assert.equal(APP_MESSAGE_ICONS.bgterm, 'terminal');
});

test('appMessageMarkdownEligible：仅结论型卡片渲染，指令型保持原文', () => {
    // 结论型：子代理结算 / 提问、支线结论
    assert.equal(appMessageMarkdownEligible('subagent', '结论：### 标题\n**加粗**'), true);
    assert.equal(appMessageMarkdownEligible('subagent-ask', 'Q1：继续吗'), true);
    assert.equal(appMessageMarkdownEligible('sidechat', '支线结论'), true);
    // 指令型：git / 定时 / 计划 / 会话投递 / 工作区防护等一律原文（核对发给模型的字节）
    assert.equal(appMessageMarkdownEligible('git', '工作区：D:/repo'), false);
    assert.equal(appMessageMarkdownEligible('schedule', '请检查构建'), false);
    assert.equal(appMessageMarkdownEligible('plan', '请执行计划'), false);
    assert.equal(appMessageMarkdownEligible('session', '会议纪要'), false);
    assert.equal(appMessageMarkdownEligible('session-user', '用户指令'), false);
    assert.equal(appMessageMarkdownEligible('wipeguard', '73 个文件消失'), false);
    assert.equal(appMessageMarkdownEligible('', ''), false);
    // 超长结论退回原文，避免展开一次跑超长 markdown
    assert.equal(appMessageMarkdownEligible('subagent', 'x'.repeat(APP_MSG_MD_MAX_CHARS)), true);
    assert.equal(appMessageMarkdownEligible('subagent', 'x'.repeat(APP_MSG_MD_MAX_CHARS + 1)), false);
});

test('全局 .hidden 兜底规则存在且不带 !important（隐藏失效/误伤内联显示的护栏）', () => {
    const css = readFileSync(new URL('../../../src/style.css', import.meta.url), 'utf8');
    // 卡片渲染/原文视图靠 classList.toggle('hidden') 切换，依赖末尾的全局兜底。
    // 必须不带 !important，否则会压过内联 style.display 与既有 !important 显示逻辑。
    const globalRule = css.match(/^\.hidden\s*\{\s*display:\s*none\s*;?\s*\}/m);
    assert.ok(globalRule, 'style.css 末尾应有全局 .hidden { display:none } 兜底规则');
    assert.doesNotMatch(globalRule[0], /!important/);
});
