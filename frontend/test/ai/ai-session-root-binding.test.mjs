// 「新建会话必须落在当前视图根」的守卫。
//
// 背景（2026-11-26，同一 bug 犯了两次）：
// createSessionData 在多工作区下**刻意不猜根**——`windowWorkspacePath()` 会退化成
// 「活动文件所在目录」，而那文件完全可能属于别的仓库。所以每个新建入口都得自己补根。
// 漏了的那处，会话 workspace 为空 → 落到「未关联工作区」分组 → 用户在聚焦仓库的
// 分组里**根本看不到它**（不报错、不显眼，只是"新会话消失"）。
//
// 两次实例：
//   1. ai_new_session 的后台路径（bridgeNewSession）——建完用户找不到
//   2. 归档/删除最后一条会话后的兜底新建——同样找不到
//
// 修法是把「新建 + 补根」收成 makeSessionWithRoot() 一个入口。本守卫锁住这个纪律：
// 除「临时会话 / 会话沙盒 / 显式设根 / 分支继承」这四类，不许再裸调 createSessionData()。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(here, '../../src/ai/ai-panel.js'), 'utf8');

test('存在 makeSessionWithRoot，且它才负责补根', () => {
    const start = panel.indexOf('function makeSessionWithRoot(');
    assert.ok(start > 0, '缺少 makeSessionWithRoot：新建会话的补根逻辑必须收成一处');
    const body = panel.slice(start, start + 800);
    assert.match(body, /createSessionData\(/, '它内部应当调 createSessionData');
    assert.match(body, /isUnboundSession\(session\)/, '临时会话 / 沙盒不该补根');
    // 根来源优先级：调用方会话 > 视图根。后台场景下 caller 与视图根可以不是同一个仓库，
    // 新会话必须落在 caller 的仓库里（否则工具根 / AGENTS.md / 记忆全跟视图跑偏）。
    assert.match(body, /sessionWorkspacePath\(baseSession\)\s*\|\|\s*viewRoot\(\)/,
        '根来源必须是「调用方会话的工作区」优先、视图根兜底——不能只用视图根');
});

test('bridgeNewSession 把调用方会话传给补根入口', () => {
    const start = panel.indexOf('bridgeNewSession: async');
    assert.ok(start > 0, '找不到 bridgeNewSession');
    const seg = panel.slice(start, start + 6000);
    assert.match(seg, /const baseSession = \(callerId \? sessionById\(callerId\) : null\) \|\| currentSession\(\);/,
        '必须先解析出调用方会话');
    assert.match(seg, /makeSessionWithRoot\(title \|\| undefined, \{[\s\S]{0,400}?\}, baseSession\)/,
        '补根时要传 baseSession：后台新建的会话应继承**调用方会话**的工作区，而不是当前视图根');
});

test('裸 createSessionData() 只允许四类免补根场景', () => {
    const lines = panel.split('\n');
    const offenders = [];
    lines.forEach((line, i) => {
        const m = line.match(/=\s*createSessionData\(/) || line.match(/createSessionData\(\);/);
        if (!m) return;
        if (line.includes('function createSessionData')) return;
        // 允许：临时会话、会话沙盒（本来无根）
        if (/transient:\s*true/.test(line) || /noWorkspace:\s*true/.test(line)) return;
        // 允许：紧接着显式设根（session.workspace = path）——看后 3 行
        const near = lines.slice(i, i + 4).join('\n');
        if (/\.workspace\s*=/.test(near)) return;
        // 允许：分支会话（forkSettings 拷母会话 workspace，之后单独处理）
        if (/分支/.test(line) || /branch\s*=/.test(line)) return;
        offenders.push('第 ' + (i + 1) + ' 行：' + line.trim());
    });
    assert.deepEqual(offenders, [],
        '这些地方裸调 createSessionData：多工作区下会话没有 workspace，会落到「未关联工作区」分组，'
        + '用户在聚焦仓库分组里看不到它。改用 makeSessionWithRoot()：\n'
        + offenders.join('\n'));
});

test('bridgeNewSession 后台路径用统一入口（回归守卫）', () => {
    const start = panel.indexOf('bridgeNewSession: async');
    assert.ok(start > 0, '找不到 bridgeNewSession');
    const seg = panel.slice(start, start + 6000);
    // 后台路径（focus=false）必须走统一入口
    assert.match(seg, /makeSessionWithRoot\(title/, '后台新建必须用 makeSessionWithRoot');
});
