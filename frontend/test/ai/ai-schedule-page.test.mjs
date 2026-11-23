// ai-schedule-page.test.mjs —— 定时任务应用页面现代化接线守卫。
// 重设计点：竖排 nowrap → 表格式排程列表；筛选 chips + 搜索；空态 CTA；
// 编辑器改用 core/form-controls.js 工厂（修复裸控件违规）；跨窗口刷新走 main.js 的
// schedules-changed 订阅。这些都是源码级接线，漏一处会静默降级，故用守卫钉死。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL('../../' + rel, import.meta.url)), 'utf8');
const scheduleSrc = read('src/ai/settings/ai-schedule.js');
const mainSrc = read('src/main.js');

test('定时任务应用页：表格式排程列表 + 列头', () => {
    assert.ok(/function renderScheduleTableRow\(s\)/.test(scheduleSrc),
        '必须有独立的表格行渲染（与弹层窄列表 renderScheduleRow 分开）');
    assert.ok(/ap-sched-thead/.test(scheduleSrc), '必须有表头容器');
    assert.ok(/ap-sched-table/.test(scheduleSrc), '必须有表格容器 class');
    assert.ok(/target\.classList\.contains\('ap-sched-table'\)/.test(scheduleSrc),
        'renderScheduleSettings 必须识别表格容器并走表格渲染分支');
});

test('定时任务应用页：筛选 chips + 搜索 + 空态 CTA', () => {
    assert.ok(/filterChips\(\{/.test(scheduleSrc), '必须挂筛选 chips');
    assert.ok(/commandBar\(\{/.test(scheduleSrc), '必须挂搜索命令栏');
    assert.ok(/function filteredSchedules\(/.test(scheduleSrc), '必须有前端筛选纯函数');
    assert.ok(/stateBlock\('empty'/.test(scheduleSrc), '空态必须用 ui-kit 的 stateBlock');
    assert.ok(/新建第一个任务/.test(scheduleSrc), '空态必须有创建 CTA');
});

test('定时任务应用页：行操作补 tooltip/aria-label（消除无语义图标按钮）', () => {
    assert.ok(/toggle\.dataset\.tip = s\.enabled \? '暂停任务' : '启用任务'/.test(scheduleSrc),
        '启停按钮必须有 data-tip');
    assert.ok(/remove\.setAttribute\('aria-label', '删除任务'\)/.test(scheduleSrc),
        '删除按钮必须有 aria-label');
});

test('编辑器改用 form-controls 工厂，不再裸建 input/select/textarea', () => {
    const editorBody = scheduleSrc.slice(scheduleSrc.indexOf('function openScheduleEditor'), scheduleSrc.indexOf('// ---- 定时任务触发'));
    assert.ok(/createInput\(\{/.test(editorBody), '编辑器必须用 createInput');
    assert.ok(/createSelect\(\{/.test(editorBody), '编辑器必须用 createSelect');
    assert.ok(/createTextarea\(\{/.test(editorBody), '编辑器必须用 createTextarea');
    assert.ok(!/node\('(input|select|textarea)'/.test(editorBody), '编辑器不得再裸建原生控件');
});

// 2026-11-22 用户截图：新建立项的输入框看起来「不是封装好的」。原因是工厂的 className 会
// **覆盖**默认封装类（applyCommon 里 control.className = o.className），只传 ai-settings-input
// 就丢掉了 .dlg-input 的 7px 圆角 / 12.5px 字号 / hover 边框 / focus 外发光。
// 正确写法是两个类并列：dlg-input 给外观，ai-settings-input 给域内布局（flex/min-width）。
test('编辑器输入框必须带 dlg-input（不能只用域内 class 覆盖掉封装外观）', () => {
    const editorBody = scheduleSrc.slice(scheduleSrc.indexOf('function openScheduleEditor'), scheduleSrc.indexOf('// ---- 定时任务触发'));
    const classNames = [...editorBody.matchAll(/className:\s*'([^']+)'/g)].map((m) => m[1]);
    assert.ok(classNames.length >= 3, '编辑器应有多处 className 传参');
    for (const cn of classNames) {
        assert.ok(/\bdlg-input\b/.test(cn), '控件 className 必须包含 dlg-input，实际为：' + cn);
    }
});

// 2026-11-23 用户截图：三个下拉「框中框」。enhanceSelect 的 wrap 会继承 select 的全部 class
// （settings-select.js），若 createSelect 传了 dlg-input/ai-settings-input 输入框外观类，外层 wrap
// 就与内层 .set-select-btn 叠成双层边框。故这三个会被增强的 select 只能带纯布局类（或不传，走默认 opt-select）。
test('弹窗里被增强的 select 不得带输入框外观类（避免框中框）', () => {
    const editorBody = scheduleSrc.slice(scheduleSrc.indexOf('function openScheduleEditor'), scheduleSrc.indexOf('// ---- 定时任务触发'));
    for (const name of ['kindCtl', 'scopeCtl', 'targetCtl']) {
        const start = editorBody.indexOf('const ' + name + ' = createSelect');
        assert.ok(start >= 0, '应找到 ' + name + ' 的 createSelect 调用');
        const block = editorBody.slice(start, editorBody.indexOf(');', start));
        assert.ok(!/className/.test(block), name + ' 被 enhanceSelect 增强，不得传 className 外观类（框中框），实际：' + block.trim());
    }
});

test('定时任务弹窗里的 select 经 enhanceSelect 增强（去掉原生菜单）', () => {
    // 弹窗挂 body（不在 .apppage-root 里），扫描器扫不到，必须打开后手动增强三个下拉。
    assert.ok(/const enhanceSelect = typeof ctx\.enhanceSelect/.test(scheduleSrc),
        '必须接收 ctx.enhanceSelect');
    const editorBody = scheduleSrc.slice(scheduleSrc.indexOf('function openScheduleEditor'), scheduleSrc.indexOf('// ---- 定时任务触发'));
    assert.ok(/if \(enhanceSelect\)/.test(editorBody), '编辑器打开后必须增强下拉');
    assert.ok(/for \(const ctl of \[kindCtl, scopeCtl, targetCtl\]\) enhanceSelect\(ctl\.control\)/.test(editorBody),
        '类型 / 权限档 / 目标会话三个下拉都要增强');
});

test('跨窗口刷新：main.js 的 schedules-changed 订阅必须刷新应用页标签', () => {
    const sub = mainSrc.slice(mainSrc.indexOf("appEvents.onApp('schedules-changed'"), mainSrc.indexOf("appEvents.onApp('settings-changed'"));
    assert.ok(/d\.appPage === 'schedules'/.test(sub),
        'schedules-changed 必须找到打开的应用页标签并刷新（修复跨窗口陈旧）');
    assert.ok(/refreshScheduleSettings/.test(sub), '必须调 aiPanel.refreshScheduleSettings');
});

test('挂载器兜底：AI 面板惰性初始化，未碰过面板就开定时任务页要先建面板', () => {
    // 用户没开过 AI 面板时 aiPanel 是 null（initAIPanel 只在面板交互路径触发）：
    // 挂载器直接读 aiPanel 会返回 null → 标签页空白，且再激活被 doc.pane 守卫挡住不自愈。
    const mounter = mainSrc.slice(mainSrc.indexOf("'schedules': (root) => {"), mainSrc.indexOf("'agents': (root) => {"));
    assert.ok(mounter.length > 0, 'appPageMounters 必须登记 schedules');
    assert.ok(/if \(!aiPanel\) initAIPanel\(\);/.test(mounter),
        'schedules 挂载器必须先兜底 initAIPanel（幂等，与设置页 AI 子页 / 外部工具页同款）');
    assert.ok(/bridgeMountSchedules\(root\)/.test(mounter), '兜底后必须仍经面板桥转发');
});
