// agents-page.test.mjs —— 「智能体」迁为应用页面的接线守卫。
//
// 背景（2026-11-23）：设置 → AI → 智能体 迁为「应用页面」内容区标签页（与外部工具同族）。
// 迁移形态：
//   · DOM 常驻 index.html 尾部 #agents-park 停靠区（隐藏），mountAgentsPane 搬进搬出标签页；
//   · 搬运保持节点身份——ai-agent-settings.js 创建期按 id 捕获 agents-list / ai-agent-create，
//     编辑器中间态与分组折叠记忆都在模块闭包里，不能重建 DOM；
//   · pane 不带 .settings-pane 类（settings-tree / settings-search 不再扫到），停靠区在 #dlg-settings 之外；
//   · 设置导航不再有 agents 子页；AI 指引口径统一为「应用页面 → 智能体」。
//
// 漏接线的代价同样是静默降级——标签页开着却渲染进隐藏停靠区、AI create_agent 后列表陈旧、
// 建群齿轮跳到不存在的设置页。都不会报错，所以必须有守卫。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {APP_PAGES, appPageOf} from '../../src/core/app-pages.js';
import {ICONS} from '../../src/core/icons.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const htmlSrc = read('index.html');
const agentSrc = read('src/ai/agent/ai-agent-settings.js');
const dlgSrc = read('src/ai/settings/ai-settings-dialog.js');
const panelSrc = read('src/ai/ai-panel.js');
const mainSrc = read('src/main.js');
const uiSrc = read('src/settings/settings-ui.js');
const sidebarSrc = read('src/ai/group/ai-group-sidebar.js');
const runtimeSrc = read('src/ai/group/ai-group-runtime.js');
const constSrc = read('src/ai/core/ai-constants.js');
const cssSrc = read('src/style.css');

test('APP_PAGES 注册 agents，图标已在注册表', () => {
    const page = appPageOf('agents');
    assert.ok(page, 'core/app-pages.js 必须注册 agents 应用页面');
    assert.equal(page.label, '智能体');
    assert.equal(page.group, 'AI 工具', '智能体归 AI 工具组（与外部工具同组）');
    assert.ok(ICONS[page.icon], '页面图标 ' + page.icon + ' 必须先登记 core/icons.js');
});

test('index.html：设置导航不再有 agents 子页，停靠区在设置弹层之外', () => {
    assert.ok(!/class="snav-item[^"]*"[^>]*data-pane="agents"/.test(htmlSrc),
        '设置导航不得再有 agents 子页——它已是应用页面');
    const parkAt = htmlSrc.indexOf('id="agents-park"');
    const dlgAt = htmlSrc.indexOf('id="dlg-settings"');
    assert.ok(parkAt >= 0, 'index.html 必须有 #agents-park 停靠区（DOM 的常驻位置）');
    assert.ok(dlgAt >= 0 && parkAt > dlgAt,
        '停靠区必须在设置弹层之外（buildSettingsTree 只扫 .settings-pane，停进去会被误索引）');
    // 停靠区必须带着两个按 id 捕获的节点：ai-agent-settings.js 创建期抓引用
    for (const id of ['agents-list', 'ai-agent-create']) {
        const at = htmlSrc.indexOf('id="' + id + '"');
        assert.ok(at > parkAt, '停靠区必须包含 #' + id + '（ai-agent-settings.js 按 id 捕获）');
    }
    // pane 不得带 .settings-pane 类：settings-search 直接扫 .settings-pane，停着也会被索引
    // （indexOf 从 parkAt 起找 <script，head 里的内联脚本块不能当文档结尾用）
    const tail = htmlSrc.slice(parkAt, htmlSrc.indexOf('<script', parkAt));
    assert.ok(tail.includes('agents-root') && !tail.includes('settings-pane'),
        '停靠区里的 pane 用 agents-root 节奏类，不得保留 settings-pane 类');
});

test('ai-agent-settings.js：mountAgentsPane 搬运停靠区、卸载搬回并收口建议弹层', () => {
    assert.ok(/function mountAgentsPane\(root\)/.test(agentSrc),
        '必须提供 mountAgentsPane(root) 供 ai-panel 桥转发给 appPageMounters');
    const mountBody = agentSrc.slice(agentSrc.indexOf('function mountAgentsPane(root)'), agentSrc.indexOf('return {bindAgentsPane'));
    assert.ok(/getElementById\('agents-park'\)/.test(mountBody),
        'unmount 必须以 #agents-park 为搬运目标（节点身份不变，id 引用与绑定才有效）');
    assert.ok(/classList\.remove\('hidden'\)/.test(mountBody),
        'mount 必须摘掉 hidden（pane 离开设置窗的显隐切换体系）');
    assert.ok(/bindAgentsPane\(\)/.test(mountBody),
        'mount 必须调 bindAgentsPane（新建按钮绑定不再依赖设置窗打开路径）');
    assert.ok(/closeGroupSuggest\(\)/.test(mountBody),
        'unmount 必须收口分组建议弹层（编辑中途关标签页不得悬空）');
    assert.ok(/return \{bindAgentsPane, renderAgentsPane, mountAgentsPane\}/.test(agentSrc),
        '导出面必须带 mountAgentsPane');
});

test('ai-agent-settings.js：反馈走 flash，不再写设置窗状态条', () => {
    assert.ok(!agentSrc.includes('setSettingsStatus'),
        '标签页场景设置窗多半没开，setSettingsStatus 必须换成 flash');
    assert.ok(/ctx\.flash/.test(agentSrc), 'flash 必须经 ctx 注入（ai-settings-dialog 的 ctx 已带）');
    assert.ok(/ctx\.getConfig/.test(agentSrc), '数据读写仍走 aiGroupApi 同一条配置通路');
});

test('三级桥：ai-settings-dialog 转发 → ai-panel 桥 → main.js 挂载器登记', () => {
    assert.ok(/mountAgentsPane:\s*agentsMod\.mountAgentsPane/.test(dlgSrc) &&
        /refreshAgentsPane:\s*agentsMod\.renderAgentsPane/.test(dlgSrc),
        'ai-settings-dialog 必须转发 mountAgentsPane / refreshAgentsPane');
    assert.ok(/createAIAgentSettings\(ctx\)/.test(dlgSrc),
        'agentsMod 不再要 extras（setSettingsStatus 已换 flash）');
    assert.ok(/bridgeMountAgents:\s*\(root\)\s*=>\s*settingsMod\.mountAgentsPane\(root\)/.test(panelSrc),
        'ai-panel 必须暴露 bridgeMountAgents（同 bridgeMountSchedules 形态）');
    assert.ok(/bridgeRefreshAgents:\s*\(\)\s*=>\s*settingsMod\.refreshAgentsPane\(\)/.test(panelSrc),
        'ai-panel 必须暴露 bridgeRefreshAgents（create_agent 落盘后刷新开着标签页）');
    assert.ok(/'agents': \(root\) => \{\s*if \(!aiPanel\) initAIPanel\(\);/.test(mainSrc),
        'appPageMounters 必须登记 agents 且先兜底初始化 AI 面板（面板惰性初始化，漏了 = 没碰过 AI 面板就开标签页得到空白且不自愈）');
});

test('main.js：create_agent 落盘后刷新开着的标签页，指引口径换新', () => {
    assert.ok(/d\.appPage === 'agents'/.test(mainSrc) && /appPageRoot\.isConnected/.test(mainSrc),
        'create_agent 后必须判应用页面标签开着才刷新（同 schedules-changed 订阅先例）');
    assert.ok(/应用页面 → 智能体 再编辑/.test(mainSrc), 'create_agent 的 note 必须指应用页面');
    assert.ok(!mainSrc.includes('设置 → AI → 智能体'), 'main.js 不得再指旧路径');
});

test('settings-ui.js：AI 组展开逻辑不再认 agents', () => {
    assert.ok(!uiSrc.includes("pane === 'agents'"),
        'inAI / refreshSettings 触发列表里的 agents 必须摘除（pane 已不存在）');
});

test('群聊域：建群齿轮直达标签页，文案统一新口径', () => {
    assert.ok(/deps\.openAppPageTab/.test(sidebarSrc) && !sidebarSrc.includes("openSettings('agents')"),
        '齿轮必须经 openAppPageTab 开标签页（设置子页已不存在）');
    assert.ok(/closeDialog\(\);\s*\n\s*openAppPageTab\('agents'\)/.test(sidebarSrc),
        '齿轮保持先关弹窗再跳的现状语义（离开建群流程去备成员）');
    assert.ok(/应用页面 → 智能体/.test(sidebarSrc), '齿轮 data-tip 与空态提示必须用新口径');
    assert.ok(!sidebarSrc.includes('设置 → AI → 智能体'), 'sidebar 不得再指旧路径');
    assert.ok(!runtimeSrc.includes('设置 → AI → 智能体') && /应用页面 → 智能体/.test(runtimeSrc),
        'ai-group-runtime 的空群提示必须用新口径');
});

test('ai-constants.js：open_settings 不再接受 agents pane，指引指应用页面', () => {
    assert.ok(!/models \/ agents \//.test(constSrc),
        'open_settings 的 pane 枚举必须去掉 agents（设置窗不再有它，传了会失败）');
    assert.ok(/「应用页面 → 智能体」/.test(constSrc), '动作表必须给出新口径的指引句');
    assert.ok(/那由用户在 应用页面 → 智能体 操作/.test(constSrc),
        'create_agent 描述里的修改/删除归属必须指应用页面');
});

test('style.css：agents-root 沿用设置 pane 纵向节奏', () => {
    assert.ok(/\.apppage-root \.agents-root\s*\{[^}]*flex-direction:\s*column[^}]*gap:\s*12px/.test(cssSrc),
        '.agents-root 必须沿用 flex+gap 节奏（搬运后卡片会紧贴）');
    assert.ok(/\.agents-root > \.set-group-title:first-child/.test(cssSrc),
        '首组头收边要对齐 .settings-pane 的同款规则');
});
