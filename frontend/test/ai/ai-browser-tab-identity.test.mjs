// ai-browser-tab-identity.test.mjs —— app_control 浏览器标签动作与 browser_* 工具
// 共享会话标签页身份的接线护栏（2026-11-22 高频 bug）。
//
// 根因：AI 用 app_control open_browser_tab 打开网页（新建标签页，但不写 session.browserTabId），
// 随后 browser_screenshot 走 ensureBrowserTab 看不到 id，又开一个 about:blank「新标签页」并截到白图。
// 这些接线依赖真实 DOM / Wails 后端，只能在源码层面锁住（同 ai-tool-wiring 惯例）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const panel = read('../../src/ai/ai-panel.js');
const browserTools = read('../../src/ai/tools/ai-browser-tools.js');

test('ai-panel 从 ai-browser-tools 导入 resolveSessionBrowserTabId', () => {
    assert.match(panel, /import\s*\{[\s\S]*?resolveSessionBrowserTabId[\s\S]*?\}\s*from\s*['"]\.\/tools\/ai-browser-tools\.js['"]/);
});

test('app_control 分支在 open/adopt/close 后同步会话标签页身份与接管态', () => {
    // 必须调用 resolveSessionBrowserTabId，并把结果写回 ctx.session.browserTabId
    assert.match(panel, /resolveSessionBrowserTabId\(action,\s*params,\s*result,\s*ctx\.session\.browserTabId\)/);
    assert.match(panel, /ctx\.session\.browserTabId\s*=\s*nextId/);
    // 接管态同步：调 resolveBrowserTabAdoption 并写回 session.browserTabAdopted
    assert.match(panel, /resolveBrowserTabAdoption\(action,\s*result,\s*ctx\.session\.browserTabAdopted\)/);
    assert.match(panel, /ctx\.session\.browserTabAdopted\s*=\s*nextAdopted/);
    // 且只在身份或接管态变化时落盘，避免每轮无谓写盘
    assert.match(panel, /if\s*\(nextId\s*!==\s*ctx\.session\.browserTabId\s*\|\|\s*nextAdopted\s*!==\s*ctx\.session\.browserTabAdopted\)[\s\S]{0,160}persistSessions\(\)/);
});

test('同步接线覆盖 open / adopt / close 三个动作', () => {
    const block = panel.slice(panel.indexOf("action === 'open_browser_tab' || action === 'adopt_browser_tab'"));
    assert.ok(block.length > 0, '找不到三动作同步分支');
    assert.ok(block.slice(0, 160).includes("action === 'close_browser_tab'"));
});

test('ai-panel 从 ai-browser-tools 导入 resolveBrowserTabAdoption', () => {
    assert.match(panel, /import\s*\{[\s\S]*?resolveBrowserTabAdoption[\s\S]*?\}\s*from\s*['"]\.\/tools\/ai-browser-tools\.js['"]/);
});

test('resolveSessionBrowserTabId / resolveBrowserTabAdoption 落在纯函数层而非面板内联', () => {
    for (const name of ['resolveSessionBrowserTabId', 'resolveBrowserTabAdoption']) {
        assert.match(browserTools, new RegExp('export function ' + name + '\\('));
        // 纯函数层不碰 session / persist 等运行时状态（截到下一个 export function 为止）
        const start = browserTools.indexOf('export function ' + name);
        const rest = browserTools.slice(start + 1);
        const next = rest.indexOf('export function ');
        const fnBody = next >= 0 ? rest.slice(0, next) : rest;
        assert.ok(!/\bpersistSessions\b|\bctx\./.test(fnBody), name + ' 不该碰运行时状态');
    }
});
