// ai-schedule-chip-wiring 接线守卫：头部「定时」胶囊的两个历史缺陷钉死。
// ① 点击无反应：togglePop 注入了 createAISchedule 却从没绑到 chip 上——弹层机制
//    （chips-pop kind=schedules）、renderSchedulePop 全就位，唯独差一行 addEventListener，
//    用户点胶囊永远没反应（2026-11-20 实测，计时胶囊 ai-timer.js 有同款接线可对照）。
// ② 弹层内容口径：renderSchedulePop 只列绑定当前会话的任务，与胶囊角标同一口径。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const scheduleSrc = readFileSync(fileURLToPath(new URL('../../src/ai/settings/ai-schedule.js', import.meta.url)), 'utf8');
const panelSrc = readFileSync(fileURLToPath(new URL('../../src/ai/ai-panel.js', import.meta.url)), 'utf8');

test('定时胶囊必须在工厂时绑 click → ctx.togglePop（与计时胶囊同款）', () => {
    assert.ok(scheduleSrc.includes("ctx.togglePop(schedChip)"),
        'ai-schedule.js 必须给头部胶囊绑 click → ctx.togglePop，否则点击永远无反应');
    assert.ok(/schedChip\.addEventListener\('click'/.test(scheduleSrc),
        '定时胶囊的 click 监听丢失');
    assert.ok(panelSrc.includes("toggleChipsPop('schedules', chip)"),
        'ai-panel.js 必须把 schedules 弹层开关注入 createAISchedule');
});

test('定时胶囊显隐与角标都是「绑定当前会话」口径', () => {
    assert.ok(scheduleSrc.includes("s.sessionId === sid"),
        'currentSessionTasks 必须按会话 id 过滤（胶囊是当前会话口径，不是应用级总数）');
    assert.ok(scheduleSrc.includes("chip.classList.toggle('hidden'"),
        '无任务时胶囊必须隐藏');
});
