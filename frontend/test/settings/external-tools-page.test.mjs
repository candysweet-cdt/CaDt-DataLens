// external-tools-page.test.mjs —— 「外部工具」迁为应用页面的接线守卫。
//
// 背景（2026-11-22 用户需求）：设置 → AI → 外部工具 迁为「应用页面」内容区标签页
// （与使用统计 / 定时任务同族）。迁移形态：
//   · DOM 常驻 index.html 的 #extcap-park 停靠区（隐藏），mount/unmount 搬进搬出标签页；
//   · 搬运保持节点身份——ai-mcp-settings.js 启动时按 id 捕获的引用与事件绑定始终有效；
//   · 设置弹层不再有 external-tools 子页；设置目录页「应用页面」一行可直达。
//
// 漏接线的代价是**静默降级**——标签页开着却渲染到隐藏停靠区、关标签后 DOM 丢失、
// MCP 绑定失效、AI 指引用户去不存在的设置页。都不会报错，所以必须有守卫。

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
const paneSrc = read('src/settings/settings-pane-external-tools.js');
const dirPaneSrc = read('src/settings/settings-pane-app-pages.js');
const mainSrc = read('src/main.js');
const uiSrc = read('src/settings/settings-ui.js');
const selectSrc = read('src/settings/settings-select.js');
const cssSrc = read('src/style.css');

test('APP_PAGES 注册 external-tools，图标已在注册表', () => {
    const page = appPageOf('external-tools');
    assert.ok(page, 'core/app-pages.js 必须注册 external-tools 应用页面');
    assert.equal(page.label, '外部工具');
    assert.ok(ICONS[page.icon], '页面图标 ' + page.icon + ' 必须先登记 core/icons.js');
});

test('index.html：设置导航不再有 external-tools 子页，停靠区在设置弹层之外', () => {
    assert.ok(!htmlSrc.includes('data-pane="external-tools"'),
        '设置导航与 settings-pane 都不得再有 external-tools——它已是应用页面');
    const parkAt = htmlSrc.indexOf('id="extcap-park"');
    const dlgAt = htmlSrc.indexOf('id="dlg-settings"');
    assert.ok(parkAt >= 0, 'index.html 必须有 #extcap-park 停靠区（DOM 的常驻位置）');
    assert.ok(dlgAt >= 0 && parkAt > dlgAt,
        '停靠区必须在设置弹层之外（buildSettingsTree 只扫 .settings-pane，停进去会被误索引）');
    // 停靠区必须带着 MCP 服务器组：那些 id 被 ai-mcp-settings.js 启动时按 id 捕获
    for (const id of ['extcap-list', 'extcap-provider', 'extcap-desktop', 'ai-opt-mcp-enabled', 'ai-opt-mcp-add', 'ai-opt-mcp-list', 'ai-opt-mcp-samples', 'ai-opt-mcp-samples-list']) {
        const at = htmlSrc.indexOf('id="' + id + '"');
        assert.ok(at > parkAt, '停靠区必须包含 #' + id + '（ai-mcp-settings / 本模块按 id 捕获）');
    }
});

test('index.html：设置导航「应用页面」用 apps 图标（与侧栏活动栏同款四方格）', () => {
    const nav = /data-pane="app-pages"><span class="snav-ic" data-icon="([^"]+)"/.exec(htmlSrc);
    assert.ok(nav, '设置导航必须有 data-pane="app-pages" 项');
    assert.equal(nav[1], 'apps', '应用页面导航图标必须是 apps（用户要求与侧栏对齐，旧值 list 是难看的清单图标）');
    assert.ok(ICONS.apps, 'apps 图标必须登记在 core/icons.js');
});

test('settings-pane-external-tools.js：mount 搬运停靠区、卸载搬回', () => {
    assert.ok(/function mount\(root\)/.test(paneSrc), '必须导出 mount(root) 供 appPageMounters 调用');
    const mountBody = paneSrc.slice(paneSrc.indexOf('function mount(root)'), paneSrc.indexOf('return {mount, renderExternalToolsPane}'));
    assert.ok(mountBody.includes("getElementById('extcap-park')"),
        'mount/unmount 必须以 #extcap-park 为搬运源（节点身份不变，id 引用与绑定才有效）');
    assert.ok(/return \(\) =>/.test(mountBody), 'mount 必须返回卸载函数（关标签把 DOM 搬回停靠区）');
    assert.ok(/return \{mount, renderExternalToolsPane\}/.test(paneSrc),
        '导出面必须同时保留 mount 与 renderExternalToolsPane（后者供 MCP 事件刷新）');
});

test('外部工具页打开时按 mcp.json 渲染 MCP 服务器组（开关 / 列表不停在静态初值）', () => {
    // 症状（2026-11-22 用户实测）：页面里的总开关显示为关、服务器行与「工具」按钮全无，
    // 点开关像是打开了，重开页面又弹回。根因是该组已迁出设置弹层，refreshSettings()
    // （含 mcpSettingsMod.render()）只在设置页触发，本页 mount 谁都没按配置渲染一次。
    const mountBody = paneSrc.slice(paneSrc.indexOf('function mount(root)'), paneSrc.indexOf('return {mount, renderExternalToolsPane}'));
    assert.ok(/renderMcpSettings\(\)/.test(mountBody),
        'mount 必须触发 ai-panel 的 renderMcpSettings（漏了 = 开关停在 index.html 未勾态、服务器列表空白）');
    assert.ok(/ensureAiPanel/.test(paneSrc),
        '取面板必须经 ensureAiPanel（AI 面板惰性初始化时直接读 aiPanel 会拿到 null）');
    const panelSrc = read('src/ai/ai-panel.js');
    assert.ok(/renderMcpSettings:\s*\(\)\s*=>\s*mcpSettingsMod\.render\(\)/.test(panelSrc),
        'ai-panel 必须暴露 renderMcpSettings，且内部走 mcpSettingsMod.render（含 loadConfig，不是 renderAll）');
    assert.ok(/get ensureAiPanel\(\)/.test(mainSrc),
        'main.js 必须注入 ensureAiPanel（未建面板时初始化后再返回）');
});

test('main.js：挂载器登记 external-tools，事件刷新不再找设置 pane', () => {
    assert.ok(/'external-tools': \(root\) => settingsPaneExternalTools\.mount\(root\)/.test(mainSrc),
        'appPageMounters 必须登记 external-tools（漏了 = 标签页只显示「界面尚未就绪」）');
    assert.ok(!mainSrc.includes('.settings-pane[data-pane="external-tools"]'),
        'refreshExternalToolsPaneIfVisible 不得再查设置 pane（子页已删，永远查不到）');
    assert.ok(/d\.appPage === 'external-tools'/.test(mainSrc),
        '事件刷新应判应用页面标签是否开着');
});

test('外部工具页现代化：页头保存反馈 + 能力有效性徽标 + 工具面板无监听器累积', () => {
    // 页头：统一 pageHeader + 保存状态徽标，mount 时 prepend、unmount 时移除
    assert.ok(/pageHeader\(\{/.test(paneSrc), '外部工具页必须用 ui-kit 的 pageHeader 统一页头');
    assert.ok(/statusBadge\(/.test(paneSrc), '页头必须有保存状态徽标（保存中/已保存/失败）');
    assert.ok(/setSaveState\('保存中/.test(paneSrc), 'save 必须有「保存中」反馈，避免连续编辑无反馈');
    assert.ok(/setSaveState\('已保存/.test(paneSrc), 'save 成功后必须更新「已保存」状态');
    assert.ok(/headEl\.parentNode\.removeChild\(headEl\)/.test(paneSrc),
        'unmount 必须移除 mount 时新建的页头，避免残留到下次挂载');
    // 能力矩阵：提示升级为「有效性徽标 + 说明」
    assert.ok(/function capabilityState\(/.test(paneSrc), '能力提示应升级为 capabilityState（徽标 tone + 文案）');
    assert.ok(/statusBadge\(state\.text, state\.tone\)/.test(paneSrc), '能力卡必须渲染有效性徽标');
    // MCP 工具面板：每次重建 panel 节点，消除监听器累积
    const mcpSrc = read('src/ai/tools/ai-mcp-settings.js');
    assert.ok(/if \(panel\) panel\.remove\(\);/.test(mcpSrc),
        'renderToolsPanel 必须先移除旧 panel 节点再新建，否则每次叠加一组监听器');
});

test('settings-ui.js：不再渲染 external-tools 子页', () => {
    assert.ok(!uiSrc.includes("'external-tools'"),
        'selectSettingsPane 里的 external-tools 分支必须摘除（pane 已不存在）');
});

test('settings-pane-app-pages.js：目录行打开页面后关设置弹层', () => {
    const openBody = dirPaneSrc.slice(dirPaneSrc.indexOf('function openPage(page)'), dirPaneSrc.indexOf('function renderAppPagesPane'));
    assert.ok(openBody.includes('deps.closeSettings()'),
        'openPage 必须调 deps.closeSettings——设置弹层挡着刚打开的标签页（用户要求 3）');
    const renderBody = dirPaneSrc.slice(dirPaneSrc.indexOf('function renderAppPagesPane'));
    assert.ok((renderBody.match(/openPage\(page\)/g) || []).length >= 2,
        '按钮与整行两条点击路径都要走 openPage（只改按钮会漏整行点击）');
});

test('settings-select.js：行式下拉增强覆盖应用页面宿主', () => {
    assert.ok(/\.settings-pane select,\s*\.apppage-root select/.test(selectSrc),
        'enhanceSetSelects 必须扫 .apppage-root select（外部工具的 opt-select 已不在 .settings-pane 里）');
});

test('style.css：外部工具页纵向节奏 + 目录行 hover 圆角内收', () => {
    assert.ok(/\.apppage-root\.extcap-root\s*\{[^}]*flex-direction:\s*column[^}]*gap:\s*\d+px/.test(cssSrc),
        '.extcap-root 必须沿用设置 pane 的 flex+gap 节奏（搬运后卡片会紧贴）');
    assert.ok(/\.set-row\.app-pages-row\s*\{[^}]*border-radius/.test(cssSrc),
        '目录行 hover 必须带圆角（贴边直角色块是用户嫌弃的形态）');
    assert.ok(/\.set-row\.app-pages-row\s*\+\s*\.set-row\.app-pages-row\s*\{[^}]*border-top:\s*none/.test(cssSrc),
        '目录行之间要去掉分隔线（hover 色块压着分隔线同样难看）');
    assert.ok(/\.set-row\.app-pages-row:hover\s*\{[^}]*background:\s*var\(--hover\)/.test(cssSrc),
        'hover 底色必须保留（整行可点的可见反馈）');
    assert.ok(/#extcap-list\s*\{[^}]*grid-template-columns/.test(cssSrc),
        '能力矩阵必须改为响应式网格（自动适配列数），不再是单列堆叠');
});

test('桌面控制：开关即安装 + 进度条 + 工具逐项开关，MCP 列表不出现 windows 行', () => {
    assert.ok(/createSwitch\(\{/.test(paneSrc), '启用开关与工具开关都必须走 form-controls 的 createSwitch');
    // 开关即安装：未安装时打开开关直接进安装流程，不再有独立的「安装…」按钮
    assert.ok(/startDesktopInstall/.test(paneSrc) && /MCPDesktopInstallStart/.test(paneSrc),
        '开关必须调 backend.MCPDesktopInstallStart（异步安装，进度走事件）');
    assert.ok(/onAppEvent\('mcp-desktop-install'/.test(paneSrc),
        '必须订阅 mcp-desktop-install 事件来画进度条');
    assert.ok(/MCPDesktopInstallStatus/.test(paneSrc),
        '页面重建要能把正在跑的安装进度接回来');
    assert.ok(/MCPDesktopPlan/.test(paneSrc),
        'wheel 路径与上游工具清单来自 backend.MCPDesktopPlan');
    // 工具逐项开关：默认全选、可取消，写回 enabledTools
    assert.ok(/setDesktopToolEnabled/.test(paneSrc), '工具开关必须走独立的 setDesktopToolEnabled');
    assert.ok(/desktopToolsNode/.test(paneSrc) && /DESKTOP_HIGH_RISK_TOOLS/.test(paneSrc),
        '工具列表要按后端清单渲染，并标注可改系统的高危项');
    assert.ok(!/writeDesktopServerRow/.test(paneSrc), '旧的两段式写入已删除（安装一步到位）');
    assert.ok(!/runDesktopDoctor/.test(paneSrc), 'doctor 检测按钮已从卡片移除');
    assert.ok(/setDesktopEnabled/.test(paneSrc), '已安装时开关走 setDesktopEnabled（只切 enabled）');
    const mcpSrc = read('src/ai/tools/ai-mcp-settings.js');
    assert.ok(/name !== DESKTOP_MCP_SERVER/.test(mcpSrc),
        'MCP 服务器列表必须过滤 windows 行（桌面控制只在自己的卡片里出现）');
});

test('桌面控制：跑马灯是悬浮胶囊（不是横幅），且键盘钩子有两道护栏', () => {
    // 用户 2026-11-22：要悬浮胶囊框，不是流内横幅；也不要那道流光动画
    const marqueeCss = cssSrc.slice(cssSrc.indexOf('.ai-marquee {'), cssSrc.indexOf('.ai-scroll-btn {'));
    assert.ok(/position:\s*absolute/.test(marqueeCss), '跑马灯必须是悬浮定位（上一版流内一行变成了横幅）');
    assert.ok(/top:\s*100%/.test(marqueeCss), '必须锚在标题栏下沿（top:100%），不写死偏移');
    assert.ok(/border-radius:\s*999px/.test(marqueeCss), '必须是胶囊圆角');
    assert.ok(/background:\s*var\(--panel2\)/.test(marqueeCss), '胶囊要有底色（用户说的是要框，不是要红字横幅）');
    assert.ok(/box-shadow:/.test(marqueeCss), '胶囊必须有阴影才浮得起来');
    assert.ok(!/\.ai-marquee::after/.test(marqueeCss), '不得有扫光伪元素');
    assert.ok(!/ai-marquee-sweep/.test(cssSrc), '扫光动画必须删除');
    assert.ok(/#ai-panel\.desktop-active \.ai-messages/.test(cssSrc), '悬浮时要给消息区让出顶部空间');
    // DOM 必须在 #ai-head 内（top:100% 才锚得住）
    const headAt = htmlSrc.indexOf('id="ai-head"');
    const marqueeAt = htmlSrc.indexOf('id="ai-desktop-marquee"');
    const changesPopAt = htmlSrc.indexOf('id="ai-changes-pop"');
    assert.ok(headAt >= 0 && marqueeAt > headAt && marqueeAt < changesPopAt,
        '跑马灯节点必须位于 #ai-head 内（头标签之后、#ai-changes-pop 之前）');
    // 键盘被吞的根因：上游 --control 的低级钩子只在 server 进程退出时释放
    const panelSrc = read('src/ai/ai-panel.js');
    assert.ok(/function desktopInputGuard/.test(panelSrc),
        '进入控制模式前必须校验 args 含 --no-control（缺失会吞掉用户键盘）');
    assert.ok(/args\.includes\('--no-control'\)/.test(panelSrc), '校验必须是 args 包含 --no-control');
    assert.ok(/function releaseDesktopControl/.test(panelSrc),
        '退出控制模式必须走 releaseDesktopControl（清状态 + 重启 server 释放钩子）');
    assert.ok(/MCPRestartServer\(DESKTOP_MCP_SERVER\)/.test(panelSrc),
        'releaseDesktopControl 必须重启桌面 server——只清前端状态救不回被吞的键盘');
    assert.ok(/await desktopInputGuard\(\)/.test(panelSrc), 'enter 分支必须真的调用守卫');
});

test('桌面控制：权限面板行 / 标题胶囊 / 跑马灯 / 控制模式工具接线', () => {
    const panelSrc = read('src/ai/ai-panel.js');
    assert.ok(/label: '桌面控制'/.test(panelSrc), '权限面板必须有「桌面控制」行');
    assert.ok(/function confirmDesktopControl/.test(panelSrc), '用户手动开启必须二次确认（完全权限同款）');
    assert.ok(/request_desktop_control/.test(panelSrc), 'AI 申请通道必须在 app_control 里拦截处理');
    assert.ok(/function syncDesktopControlUI/.test(panelSrc), '标题胶囊与跑马灯统一由 syncDesktopControlUI 驱动');
    assert.ok(/case 'windows_control_mode'/.test(panelSrc), '必须实现 windows_control_mode 执行分支');
    assert.ok(!/case 'windows_desktop'/.test(panelSrc), '揭示层执行分支必须删除');
    assert.ok(!htmlSrc.includes('id="ai-computer-use"'), 'composer 的「桌面」pill 必须删除');
    assert.ok(htmlSrc.includes('id="ai-chip-desktop"') && htmlSrc.includes('id="ai-desktop-marquee"'),
        '标题红胶囊与面板顶部跑马灯节点必须在 index.html');
    assert.ok(/ai-marquee/.test(cssSrc) && /ai-chip-desktop/.test(cssSrc), '两套样式必须存在');
    const defsSrc = read('src/ai/tools/ai-tool-defs.js');
    assert.ok(/windows_control_mode: \{/.test(defsSrc), '工具定义必须改名为 windows_control_mode');
    assert.ok(!/windows_desktop: \{/.test(defsSrc), '旧揭示工具定义必须删除');
    assert.ok(/defaultDesktopControl/.test(read('src/ai/settings/ai-settings-dialog.js')),
        '设置页「新会话默认桌面控制」必须接线');
});

