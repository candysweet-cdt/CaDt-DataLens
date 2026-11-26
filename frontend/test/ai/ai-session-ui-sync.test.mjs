// ai-session-ui-sync 接线守卫：当前查看会话的 chrome（消息区 / 输入区 / 发送停止按钮 /
// 提醒徽标 / 计时胶囊 / 定时任务胶囊 / 隔离 worktree 芯片 / 系统提示词估算）统一走 syncActiveSessionUI，
// 凡「当前会话可能变了」的路径都必须调它，不许手写清单。
// 背景：switchSession 有一份完整清单，newSession 不走 switchSession 又手写了一份，
// 漏了隔离芯片——从隔离区会话点「新建对话」会残留「隔离 · 开」（2026-11-18）。
// 定时胶囊同理（2026-11-20）：syncActiveSessionUI 只刷计时不刷定时，绑定 A 会话的
// 任务数在 B 会话一直挂着，用户实测「定时 1 在哪个会话都显示」。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../../src/ai/ai-panel.js', import.meta.url)), 'utf8');
const cardSrc = readFileSync(fileURLToPath(new URL('../../src/ai/tools/ai-tool-cards.js', import.meta.url)), 'utf8');

// 按函数声明切片：从 `function NAME(` 到下一个同缩进（4 空格）的兄弟函数声明。
// 模块惯例：createAIPanel 体内函数声明一律 4 空格缩进，嵌套箭头函数不会命中。
function fnBody(name) {
    const marker = 'function ' + name + '(';
    const start = src.indexOf(marker);
    assert.ok(start >= 0, 'ai-panel.js 缺少 function ' + name + '(');
    const next = src.slice(start + marker.length).search(/\n    (?:async )?function /);
    return next < 0 ? src.slice(start) : src.slice(start, start + marker.length + next + 1);
}

// 统一入口必须覆盖全部会话级 chrome——以后给面板加新的会话级芯片时，这里的清单要同步补
test('syncActiveSessionUI：包含全部会话级 chrome 刷新', () => {
    const body = fnBody('syncActiveSessionUI');
    const calls = [
        'syncStreamView()',
        'renderMessages(',
        'updateComposerState()',
        'setStreamingUI()',
        'syncRemindersUI(',
        'timerMod.render()',
        'scheduleMod.syncChip()',
        'worktreeMod.syncChip(',
        'refreshSystemPromptEstimate(',
    ];
    for (const call of calls) {
        assert.ok(body.includes(call), 'syncActiveSessionUI 缺少 ' + call + '（新增会话级芯片要统一收进这里）');
    }
});

// 「当前会话可能变了」的路径：切会话 / 新建 / 删除兜底 / 跨窗口重载兜底 / 启动加载与 init
test('当前会话可能变化的路径一律走 syncActiveSessionUI', () => {
    for (const name of ['switchSession', 'newSession', 'deleteSession', 'refreshSessionUI', 'applyLoadedSessions', 'init']) {
        assert.ok(fnBody(name).includes('syncActiveSessionUI('), name + ' 缺少 syncActiveSessionUI 调用');
    }
});

// switchSession 不再手写会话级清单：往里加第 N 个芯片刷新而不动统一入口，
// 其他路径就会各漏一份（本守卫的来历）
test('switchSession 不再手写会话级芯片清单', () => {
    const body = fnBody('switchSession');
    for (const call of ['worktreeMod.syncChip', 'timerMod.render', 'scheduleMod.syncChip', 'syncRemindersUI(']) {
        assert.ok(!body.includes(call), 'switchSession 里出现裸的 ' + call + '（应统一走 syncActiveSessionUI）');
    }
});

// 计划模式开关是会话级状态：plan_mode 工具必须按调用者会话改，不能按面板当前查看的会话。
// 来历：后台会话（子代理 / 切走后仍在跑的会话）调 plan_mode(true) 点亮了前台会话的计划开关，
// 自己反而没进计划模式，紧接着 submit_plan 报「尚未进入计划模式」。
test('plan_mode 工具按 ctx.session 切换，后台会话不刷新面板 UI', () => {
    assert.ok(src.includes('setPlanMode(enabled, false, true, ctx.session)'),
        'plan_mode 工具必须把 ctx.session 作为目标会话传给 setPlanMode');
    assert.ok(/function setPlanMode\(on, announce, force, target\)/.test(src),
        'setPlanMode 必须接受目标会话参数');
    const body = fnBody('setPlanMode');
    assert.ok(body.includes('const isViewed = session === viewed'),
        'setPlanMode 要区分「目标会话」与「面板当前查看的会话」');
    assert.ok(body.includes('isSessionBusy(session.id)'),
        '生成中判定要按目标会话的流，不能用面板镜像 stream');
    const earlyReturn = body.indexOf('if (!isViewed) return true;');
    assert.ok(earlyReturn > 0, '非当前会话改状态后必须早退，不刷面板 UI');
    for (const call of ['updateScopeUI()', 'updateSendState()', 'renderMessages(', 'renderMessageQueue()']) {
        const at = body.indexOf(call);
        assert.ok(at > earlyReturn, call + ' 必须排在「非当前会话早退」之后（后台会话不许改前台 UI）');
    }
});

// 支线对话标签页复用面板的渲染函数（withRenderTarget），此时「渲染目标会话」才是消息的主人。
// 身份：卡内动作（查看计划）与助手操作按钮的「最后一条 / 该会话是否在生成」必须按它算，
// 按面板 currentSession() 算会把动作落到别的会话（2026-11-19 计划模式串台的同一类）。
test('工具卡 / 助手操作按钮按渲染会话取 owner，不直接落 currentSession', () => {
    assert.ok(cardSrc.includes('function renderToolMessage(wrap, message, options, session)'),
        'renderToolMessage 必须接受所属会话参数');
    assert.ok(cardSrc.includes('openPlan(session || currentSession())'),
        '「查看计划」必须按卡片所属会话打开');
    assert.ok(cardSrc.includes('(options && options.session) || currentSession()'),
        '助手操作按钮的会话（最后一条 / 忙判定）必须取渲染会话');
    assert.ok(src.includes('renderToolMessage(wrap, message, options, session)'),
        'renderMessage 必须把渲染目标会话传给工具卡');
    assert.ok(src.includes('Object.assign({}, options, {session})'),
        'renderMessage 必须把渲染目标会话传给 updateAssistantElement');
});

// 父/根会话都被删除时，子代理没有归宿：不许拿面板当前会话顶上（那会把结算与记录挂到
// 用户正看着的另一个对话）。parentSessionOfSub 的结果只喂 profileOf / entryOf，null 安全。
test('子代理父会话解析不再回落 currentSession', () => {
    const subSrc = readFileSync(fileURLToPath(new URL('../../src/ai/agent/ai-subagents.js', import.meta.url)), 'utf8');
    const start = subSrc.indexOf('function parentSessionOfSub(');
    assert.ok(start >= 0, '找不到 parentSessionOfSub');
    const body = subSrc.slice(start, start + 400);
    assert.ok(!body.includes('currentSession()'), 'parentSessionOfSub 不得回落 currentSession');
    assert.ok(body.includes('|| null'), '找不到父/根会话时应返回 null');
});
