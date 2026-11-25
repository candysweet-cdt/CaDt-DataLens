// ai-cognition-page.test.mjs —— 「认知索引」应用页面的接线守卫。
//
// 背景（2026-11-23 用户需求）：开启认知索引（settings.aiCognition）后，「应用页面」出现
// 「认知索引」页，浏览 .cadt/cognition/ 卷；关闭后入口消失。它是 APP_PAGES 第一个
// **条件可见页**（visibleWhen 机制），漏接线都是静默降级：
//   · 漏登记 appPageMounters → 标签页只显示「界面尚未就绪」且不自愈；
//   · 入口调用点漏传 settings → visibleWhen 过滤永远不生效（或全藏）；
//   · settings-changed 不刷新 → 开关翻转后侧栏/已开标签停在旧状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {APP_PAGES, appPageOf, appPageGroups} from '../../../src/core/app-pages.js';
import {ICONS} from '../../../src/core/icons.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const mainSrc = read('src/main.js');
const pageSrc = read('src/ai/settings/ai-cognition-page.js');
const dirPaneSrc = read('src/settings/settings-pane-app-pages.js');
const cssSrc = read('src/style.css');
const mockSrc = read('src/dev/mock-backend.js');

test('APP_PAGES 注册 cognition：图标在册、条件键是 aiCognition', () => {
    const page = appPageOf('cognition');
    assert.ok(page, 'core/app-pages.js 必须注册 cognition 应用页面');
    assert.equal(page.label, '认知索引');
    assert.equal(page.group, 'AI 工具');
    assert.equal(page.visibleWhen, 'aiCognition', '条件可见键必须是 settings.aiCognition');
    assert.ok(ICONS[page.icon], '页面图标 ' + page.icon + ' 必须先登记 core/icons.js');
});

test('appPageGroups：按 settings.aiCognition 过滤，其余页面不受影响', () => {
    const labelsOf = (groups) => groups.flatMap((g) => g.pages.map((p) => p.id));
    const on = labelsOf(appPageGroups({aiCognition: true}));
    assert.ok(on.includes('cognition'), '开启时应出现认知索引');
    for (const off of [{aiCognition: false}, {}, undefined]) {
        const ids = labelsOf(appPageGroups(off));
        assert.ok(!ids.includes('cognition'), '关闭/缺省时应隐藏认知索引（' + JSON.stringify(off) + '）');
        for (const always of ['usage-stats', 'external-tools', 'agents', 'schedules', 'activity', 'patches']) {
            assert.ok(ids.includes(always), '无条件页不得被误伤：' + always);
        }
    }
    // appPageOf 不过滤：已开的认知标签在开关关掉后仍要能 resolve 图标与标题
    assert.ok(appPageOf('cognition'), 'appPageOf 必须无条件返回注册表项（标签页 resolve 依赖它）');
});

test('main.js：挂载器登记 cognition，工厂 deps 完整', () => {
    assert.ok(/'cognition': \(root\) => cognitionPage\.mount\(root\)/.test(mainSrc),
        'appPageMounters 必须登记 cognition（漏了 = 标签页只显示「界面尚未就绪」）');
    assert.ok(/import \{createAICognitionPage\} from '\.\/ai\/settings\/ai-cognition-page\.js';/.test(mainSrc),
        'main.js 必须导入 createAICognitionPage');
    assert.ok(/get openCognitionSettings\(\)/.test(mainSrc) && /getElementById\('ai-opt-cognition'\)/.test(mainSrc),
        '「去设置开启」CTA 必须定位到 AI 页的认知开关行（openSettingsAtRow 先例）');
    assert.ok(/get getWorkspace\(\)/.test(mainSrc),
        '页面必须注入 getWorkspace（认知索引按窗口工作区生效）');
});

test('main.js：四个入口全部传 settings 给 appPageGroups（visibleWhen 的统一漏斗）', () => {
    const bare = mainSrc.match(/appPageGroups\(\)/g) || [];
    assert.deepEqual(bare, [], 'main.js 不得再有 appPageGroups() 裸调用（条件页会永远隐藏）');
    const withSettings = mainSrc.match(/appPageGroups\(settings\)/g) || [];
    assert.ok(withSettings.length >= 3, 'ab-more / renderAppPagesNav / tools 菜单三处都要传 settings，实得 ' + withSettings.length);
    assert.ok(/appPageGroups\(deps\.settings\)/.test(dirPaneSrc),
        '设置目录 pane 必须传 deps.settings（main.js 侧注入 get settings）');
    assert.ok(/get settings\(\) \{ return settings; \},/.test(mainSrc),
        'main.js 创建 settingsPaneAppPages 时必须注入 get settings');
});

test('main.js：settings-changed 用 payload 权威值 + lastCog 基线判翻转（本地开关路径也生效）', () => {
    // 回归 H1：本地开关「先改 settings 再广播」，广播到达时 settings 已是新值，
    // 拿 settings.aiCognition 当 before 会让比较恒 false。必须用 payload.values + 独立基线。
    assert.ok(!/const cogBefore = settings\.aiCognition/.test(mainSrc),
        '不得再用 settings.aiCognition 当翻转前基线（本地开关路径恒 false）');
    assert.ok(/const nowCog = values\.aiCognition === true;/.test(mainSrc),
        '翻转判定必须用 payload.values 的权威快照');
    assert.ok(/let lastCog = null;/.test(mainSrc) && /nowCog !== lastCog/.test(mainSrc),
        '必须用模块级 lastCog 独立基线比对（跨窗口/本窗口两条路径统一）');
    assert.ok(/refreshAppPagesNavIfVisible\(\)/.test(mainSrc) && /refreshCognitionPageIfVisible\(\)/.test(mainSrc),
        '翻转后必须同时刷新侧栏入口与已开的认知页');
    const helper = mainSrc.slice(mainSrc.indexOf('function refreshCognitionPageIfVisible'));
    assert.ok(/d\.appPage === 'cognition'/.test(helper) && /appPageRoot\.isConnected/.test(helper),
        '认知页刷新必须判标签开着（同 refreshExternalToolsPaneIfVisible 先例）');
});

test('页面模块：mount/unmount 对称、数据走 CognitionRead/CognitionStatus', () => {
    assert.ok(/export function createAICognitionPage\(deps\)/.test(pageSrc), '必须是 factory + deps 注入形态');
    const mountBody = pageSrc.slice(pageSrc.indexOf('function mount(host)'), pageSrc.indexOf('function refresh()'));
    assert.ok(/host\.classList\.add\('cog-root'\)/.test(mountBody), 'mount 必须给宿主加 .cog-root（纵向节奏）');
    assert.ok(/hostEl\.classList\.remove\('cog-root'\)/.test(pageSrc), '卸载必须移除 .cog-root（对称契约）');
    assert.ok(/return \(\) =>/.test(mountBody), 'mount 必须返回卸载函数');
    assert.ok(/CognitionRead\(/.test(pageSrc) && /CognitionStatus\(/.test(pageSrc),
        '数据必须走 backend.CognitionRead / CognitionStatus');
    assert.ok(/JSON\.stringify\(\{query: v\}\)/.test(pageSrc), 'FRAS 关键词搜索必须走后端 query 过滤');
    assert.ok(/JSON\.stringify\(\{paths: \[path\]\}\)/.test(pageSrc), '详情必须按单条 paths 取结构化条目');
    assert.ok(/seq !== searchSeq/.test(pageSrc), '搜索要有请求序号守卫（防竞态错序渲染）');
    assert.ok(/const seq = \+\+detailSeq;/.test(pageSrc) && /seq !== detailSeq \|\| !alive\(\)/.test(pageSrc),
        '详情抽屉要有独立序号守卫（快速连点不遗留孤儿抽屉/overlay 泄漏）');
    assert.ok(/loadStatus\(ws, seq\)/.test(pageSrc) && /seq !== loadSeq \|\| !alive\(\)/.test(pageSrc),
        '状态条加载要带序号守卫（快速重复 reload 不叠加徽标）');
    assert.ok(/res\.hitEntries\.length/.test(pageSrc) || /fetched < Number\(res\.hitCount\)/.test(pageSrc),
        '截断提示须按后端 hitEntries 数判，不能把 chips 本地过滤误算成后端截断');
    assert.ok(/refresh\(\)/.test(pageSrc.slice(pageSrc.indexOf('return {mount, refresh}'))) ||
        /return \{mount, refresh\}/.test(pageSrc), '必须暴露 refresh 供 settings-changed 翻转驱动');
});

test('页面模块硬规范：无裸原生控件、无全局 Esc 监听、抽屉走 ui-kit（overlay-stack）', () => {
    assert.ok(!/<input|<select|<textarea/i.test(pageSrc),
        '禁止裸 <input>/<select>/<textarea>——搜索框走 ui-kit 的 commandBar（form-controls 工厂）');
    assert.ok(/detailDrawer\(\{/.test(pageSrc), '详情抽屉必须走 ui-kit 的 detailDrawer（内部注册 overlay-stack，Esc 栈序）');
    assert.ok(!/window\.addEventListener\('keydown|document\.addEventListener\('keydown/.test(pageSrc),
        '不得自挂 window/document 级 Esc 监听（弹层硬规范，overlay-esc-guard 会扫）');
    assert.ok(/closest\('\.apppage-pane'\)/.test(pageSrc),
        '抽屉要挂到 .apppage-pane（定位与 z-index 生效，补丁库先例）');
    assert.ok(/stateBlock\('empty'/.test(pageSrc) && /去设置开启/.test(pageSrc),
        '卷未建立时要有空态；未启用时给「去设置开启」CTA');
});

test('页面模块：205 条列表要前端分页，不能一次铺开', () => {
    assert.ok(/const PAGE_SIZE = \d+/.test(pageSrc), '必须有前端分页常量（对齐补丁库）');
    assert.ok(/function paintPaged\(/.test(pageSrc), '列表/搜索结果必须走统一分页渲染');
    assert.ok(/const start = \(page - 1\) \* PAGE_SIZE/.test(pageSrc) && /\.slice\(start, start \+ PAGE_SIZE\)/.test(pageSrc),
        '必须按页切片渲染，不能整表铺开');
    assert.ok(/function pageFoot\(/.test(pageSrc) && /第 ' \+ page \+ '\/'/.test(pageSrc), '必须有分页页脚（共 N 条 · 第 x/y 页）');
    assert.ok(/function repaintCurrent\(/.test(pageSrc), '翻页要能按当前视图（概览/搜索）重绘');
    // 切换搜索 / chips / 刷新都要把页码归 1，否则翻到第 5 页后搜索显示空页
    assert.ok(/function onSearch\(v, resetPage = true\)/.test(pageSrc) && /if \(resetPage\) page = 1/.test(pageSrc),
        '新搜索必须归位页码，翻页重绘传 false 保留');
    assert.ok(/chipsValue = v; page = 1/.test(pageSrc), 'chips 切换必须归位页码');
    assert.ok(/const seq = \+\+loadSeq;\s*page = 1/.test(pageSrc), 'reload 必须归位页码');
});

test('style.css：认知页骨架与行样式就位', () => {
    assert.ok(/\.cog-root\s*\{[^}]*flex-direction:\s*column[^}]*gap:\s*\d+px/.test(cssSrc),
        '.cog-root 必须沿用 flex+gap 纵向节奏（.us-root 同款约定）');
    assert.ok(/\.cog-row\s*\{/.test(cssSrc) && /\.cog-row-path\s*\{/.test(cssSrc), '列表行与路径样式必须存在');
    assert.ok(/\.cog-field-label\s*\{/.test(cssSrc) && /\.cog-field-value\s*\{/.test(cssSrc), 'FRAS 字段块样式必须存在');
    assert.ok(/\.cog-page-foot\s*\{/.test(cssSrc), '分页页脚样式必须存在');
});

test('dev mock：认知卷给样例条目，dev 下页面有东西可看', () => {
    assert.ok(/hitEntries/.test(mockSrc), 'mock CognitionRead 过滤命中必须返回结构化 hitEntries');
    assert.ok(/mock dev 环境样例卷/.test(mockSrc), 'overview 文案要标明是样例卷（防误当真实数据）');
});
