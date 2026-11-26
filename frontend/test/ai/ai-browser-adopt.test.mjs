// ai-browser-adopt.test.mjs —— AI 接管用户浏览器标签页（adopt_browser_tab）的接线护栏。
//
// 这个动作跨三份清单（技能表 / APP_ACTIONS / runAppAction switch）+ 审批链 + 会话状态 +
// 关闭守卫，依赖真实 DOM / Wails 后端，只能在源码层面锁住（同 ai-tool-wiring / 标签身份护栏惯例）。
// 纯函数行为在 test/ai/tools/ai-browser-tools.test.mjs 里测。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const main = read('../../src/main.js');
const panel = read('../../src/ai/ai-panel.js');
const constants = read('../../src/ai/core/ai-constants.js');
const store = read('../../src/ai/session/ai-session-store.js');

test('三处清单都登记了 adopt_browser_tab', () => {
    assert.ok(constants.includes("'- adopt_browser_tab {"), '技能表要下发动作，模型才知道能用');
    assert.ok(/'open_browser_tab', 'close_browser_tab', 'adopt_browser_tab'/.test(main), 'APP_ACTIONS 要登记');
    assert.ok(main.includes("case 'adopt_browser_tab':"), 'runAppAction 要有执行分支');
});

test('adopt case 全档弹高危审批卡，无审批通道时拒绝', () => {
    const start = main.indexOf("case 'adopt_browser_tab':");
    const end = main.indexOf("case 'close_browser_tab':", start);
    const body = main.slice(start, end);
    assert.ok(body.includes("typeof requestActionApproval !== 'function'"), '没有审批通道必须确定性拒绝');
    assert.ok(body.includes("action: 'adopt_browser_tab'"), '审批规格动作名');
    assert.ok(body.includes("risk: 'high'"), '必须高危卡（全档必弹）');
    assert.ok(body.includes('登录态'), '警告要说明读取的是用户已登录页面');
    assert.ok(body.includes('adopted: true'), '批准后回执');
    assert.ok(body.includes('adopted: false'), '拒绝后回执');
});

test('close_browser_tab 有 protectedId 守卫，且在关闭之前', () => {
    const start = main.indexOf("case 'close_browser_tab':");
    const body = main.slice(start, start + 700);
    assert.ok(body.includes('protectedDoc'), '按 protectedId 找到接管标签');
    assert.ok(body.includes('AI 不能关闭'), '明确拒绝文案');
    assert.ok(body.indexOf('protectedDoc') < body.indexOf('closeDocNow(target'), '守卫必须在关闭之前');
});

test('browser_close 工具拦截接管态标签，且在关闭调用之前', () => {
    const start = panel.indexOf("case 'browser_close':");
    const body = panel.slice(start, start + 800);
    assert.ok(body.includes('ctx.session.browserTabAdopted'), '检查接管态');
    assert.ok(body.includes('请手动关闭'), '拒绝文案');
    assert.ok(body.indexOf('ctx.session.browserTabAdopted') < body.indexOf("runHostAppAction('close_browser_tab'"), '拦截在关闭调用之前');
});

test('app_control 给 close_browser_tab 注入 protectedId', () => {
    assert.ok(/action === 'close_browser_tab' && ctx && ctx\.session && ctx\.session\.browserTabAdopted/.test(panel));
    assert.ok(/params\.protectedId = ctx\.session\.browserTabId/.test(panel));
});

test('计划模式拦截 adopt_browser_tab', () => {
    const anchor = panel.indexOf('// 接管用户浏览器标签是会话能力变更');
    assert.ok(anchor > 0, '找不到计划模式拦截注释');
    assert.ok(panel.slice(anchor, anchor + 200).includes("'adopt_browser_tab'"));
});

test('接管态随会话持久化：加载归一 + 落盘归一', () => {
    assert.ok(/browserTabAdopted: raw\.browserTabAdopted === true/.test(panel));
    assert.ok(/browserTabAdopted: \(session && session\.browserTabAdopted\) === true/.test(store));
});

test('ensureBrowserTab 惰性重建时清除接管态', () => {
    const start = panel.indexOf('async function ensureBrowserTab(session)');
    assert.ok(start > 0, '找不到 ensureBrowserTab');
    assert.ok(panel.slice(start, start + 1000).includes('session.browserTabAdopted = false'));
});

test('get_state 的浏览器标签暴露精确定位字段', () => {
    const start = main.indexOf('function appActionDocInfo(doc)');
    assert.ok(start > 0, '找不到 appActionDocInfo');
    const body = main.slice(start, start + 700);
    assert.ok(body.includes('info.browserUrl'), '暴露 URL 供定位');
    assert.ok(body.includes('info.browserTabId'), '暴露 id 供精确定位');
});

test('浏览器标签定位辅助存在且四选一', () => {
    const start = main.indexOf('function appActionFindBrowserDoc(ref)');
    assert.ok(start > 0, '找不到定位辅助函数');
    const body = main.slice(start, start + 900);
    for (const key of ['r.id', 'r.name', 'r.url', 'r.index']) {
        assert.ok(body.includes(key), '定位辅助要支持 ' + key);
    }
    assert.ok(body.includes('matches.length > 1'), '多命中要报错，不随便选一个');
});
