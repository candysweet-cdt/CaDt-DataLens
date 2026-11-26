// 定时任务胶囊的刷新链路守卫。
//
// 背景（2026-11-26 实测）：多工作区下定时任务能正常触发，但头部胶囊始终不显示当前会话的任务。
// 两个叠加的根因：
//
//  1. `renderScheduleSettings()` 里 `refreshSchedulesUI()` 写在 `if (!target) return` **之后**。
//     而 target 的兜底 `opt.schedules` 指向的设置页容器（#ai-opt-schedules）在定时任务迁成
//     应用页面标签页后已从 index.html 移除 → 恒为 null。于是只要定时任务页没开着，刷新就被
//     整段跳过，缓存永不更新，胶囊永不显示（AI 用 schedule_create 建完任务也一样）。
//  2. `syncChip()`（切会话时调）只按缓存重算。面板初始化那次 renderChip 可能早于会话恢复，
//     sid 还是空 → mine 为空 → 隐藏；之后再没人拿新 sid 重算过，胶囊就永久隐藏。
//
// 本测试锁这两条：缓存/胶囊刷新不得依赖容器存在；未成功拉过列表时 syncChip 要补一次拉取。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../../src/ai/settings/ai-schedule.js'), 'utf8');
const html = readFileSync(join(here, '../../../index.html'), 'utf8');

test('renderScheduleSettings：刷新胶囊在 target 判空之前', () => {
    const start = src.indexOf('function renderScheduleSettings(host) {');
    assert.ok(start > 0, '找不到 renderScheduleSettings');
    const head = src.slice(start, start + 900);
    const refreshIdx = head.indexOf('refreshSchedulesUI()');
    const guardIdx = head.indexOf('if (!target) return');
    assert.ok(refreshIdx > 0, 'renderScheduleSettings 必须刷新缓存与胶囊');
    assert.ok(guardIdx > 0, '找不到 target 判空（期望它仍在，用来跳过列表渲染）');
    assert.ok(refreshIdx < guardIdx,
        'refreshSchedulesUI() 必须在 `if (!target) return` 之前：胶囊在面板头部，'
        + '与「定时任务页是否开着」无关。放后面的话，容器不存在时（opt.schedules 已随'
        + '定时任务迁成应用页面而失效）缓存永不更新，胶囊永远不显示');
});

test('opt.schedules 指向的设置页容器确实已不存在（说明这条兜底是死值）', () => {
    // 正是这个失效兜底触发了上面那条 bug；容器若哪天回来了，这条会提醒重新审视判定。
    assert.ok(/schedules: document\.getElementById\('ai-opt-schedules'\)/.test(
        readFileSync(join(here, '../../../src/ai/ai-panel.js'), 'utf8')),
        'ai-panel 仍在用 #ai-opt-schedules 作兜底容器');
    assert.equal(html.includes('ai-opt-schedules'), false,
        '#ai-opt-schedules 已不在 index.html 里——任何依赖它存在的刷新路径都会被静默跳过');
});

test('syncChip：未成功拉过列表时补一次拉取', () => {
    const start = src.indexOf('function syncChip() {');
    assert.ok(start > 0, '找不到 syncChip');
    const body = src.slice(start, start + 400);
    assert.match(body, /scheduleLoaded/, 'syncChip 必须看「是否已成功拉过」');
    assert.match(body, /refreshSchedulesUI\(\)/, '未拉过时要补一次，否则会话恢复后胶囊仍按空缓存隐藏');
    assert.match(body, /updateChipFromCache\(\)/, '已拉过时仍走缓存重算（不每次都打后端）');
});

test('scheduleLoaded：成功与「旧后端」两条出口都置位，失败留待重试', () => {
    const fn = src.slice(src.indexOf('function refreshSchedulesUI'), src.indexOf('function renderChip'));
    assert.match(fn, /if \(!backend\.AIScheduleList\) \{ scheduleLoaded = true; return; \}/,
        '旧后端不支持时也要标已加载，否则每次切会话都空拉一次');
    assert.match(fn, /scheduleLoaded = true;/, '成功路径要置位');
    // catch 分支不置位：下次 syncChip 会重试（首次拉取失败的短暂网络问题能自愈）
    const catchAt = fn.indexOf('.catch(');
    const afterCatch = fn.slice(catchAt);
    assert.ok(!/scheduleLoaded = true/.test(afterCatch),
        '失败分支不能置位——否则一次失败后胶囊永远不显示');
});
