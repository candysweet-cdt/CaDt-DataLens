// ai-todos 默认收起态护栏：任务清单默认折叠（设置 aiTodosDefaultExpanded 可改为默认展开），
// 切换设置后既有会话的收起态立即跟随。渲染部分依赖 DOM，这里只测状态层。
// 另测轮末提醒 <task_todos_check> 的文案口径与节流（todosCheckText / shouldSendTodosCheck）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAITodos, shouldSendTodosCheck, todosCheckText, todosCheckTextFromMessage, todosDefaultCollapsed} from '../../../src/ai/chat/ai-todos.js';

function makeMod(settings, todoStates) {
    return createAITodos({
        todoStates,
        // el 不提供 todos：renderTodos 直接返回，状态层测试不需要 DOM
        el: {},
        currentSession: () => null,
        positionOverlays: () => {},
        settings,
    });
}

test('默认收起：未设置时新建会话状态 collapsed 为 true', () => {
    assert.equal(todosDefaultCollapsed({}), true);
    assert.equal(todosDefaultCollapsed(undefined), true);
    const states = new Map();
    const mod = makeMod({}, states);
    assert.equal(mod.todoStateOf({id: 's1'}).collapsed, true);
});

test('设置为默认展开时新建状态 collapsed 为 false', () => {
    assert.equal(todosDefaultCollapsed({aiTodosDefaultExpanded: true}), false);
    const mod = makeMod({aiTodosDefaultExpanded: true}, new Map());
    assert.equal(mod.todoStateOf({id: 's1'}).collapsed, false);
});

test('切换默认展开后既有会话状态立即跟随并清掉自动收起计时', () => {
    const settings = {};
    const states = new Map();
    const mod = makeMod(settings, states);
    const state = mod.todoStateOf({id: 's1'});
    assert.equal(state.collapsed, true);
    // 模拟「全部完成 3 秒后自动收起」挂着的计时器
    state.timer = setTimeout(() => {}, 60_000);
    state.doneCollapsed = true;

    settings.aiTodosDefaultExpanded = true;
    mod.applyDefaultCollapse();
    assert.equal(state.collapsed, false);
    assert.equal(state.timer, 0);
    assert.equal(state.doneCollapsed, false);

    settings.aiTodosDefaultExpanded = false;
    mod.applyDefaultCollapse();
    assert.equal(state.collapsed, true);
});

test('轮末提醒文案报全三分计数，不断言清单没对齐', () => {
    const todos = [
        {content: 'a', status: 'completed'},
        {content: 'b', status: 'completed'},
        {content: 'c', status: 'in_progress'},
        {content: 'd', status: 'pending'},
        {content: 'e', status: 'pending'},
    ];
    const text = todosCheckText(todos);
    assert.ok(text.startsWith('<task_todos_check>') && text.endsWith('</task_todos_check>'));
    assert.ok(text.includes('共 5 项') && text.includes('2 项已完成') && text.includes('1 项进行中') && text.includes('2 项待处理'));
    // 三分计数之和必须等于总数：漏掉已完成数会让模型对不上自己刚写的清单，转而核对提示是否过期
    const nums = [...text.matchAll(/(\d+) 项(?:已完成|进行中|待处理)/g)].map((m) => Number(m[1]));
    assert.equal(nums.reduce((a, b) => a + b, 0), 5);
    assert.equal(text.includes('尚未与实际进度对齐'), false);
    assert.ok(text.includes('不要在思考或回复里复述'));
});

test('轮末提醒节流：文本未变、或模型刚更新过清单时不催', () => {
    const text = todosCheckText([{content: 'a', status: 'in_progress'}]);
    // 清单没动过：上次注入的同一句话仍在上下文里，重复插一条只是噪音
    assert.equal(shouldSendTodosCheck({text, lastText: text, toolNames: ['read_file', 'search_text', 'edit_file']}), false);
    // 本轮一直在自己 todo_write 更新清单，距上次不足 3 个工具结果
    assert.equal(shouldSendTodosCheck({text, lastText: '', toolNames: ['read_file', 'todo_write', 'edit_file']}), false);
    assert.equal(shouldSendTodosCheck({text, lastText: '', toolNames: []}), false);
    // 跑过 3 个工具却没碰过清单 → 催
    assert.equal(shouldSendTodosCheck({text, lastText: '', toolNames: ['read_file', 'search_text', 'edit_file']}), true);
    assert.equal(shouldSendTodosCheck({text, lastText: '', toolNames: ['todo_write', 'read_file', 'search_text', 'edit_file']}), true);
    // 阈值可配
    assert.equal(shouldSendTodosCheck({text, lastText: '', toolNames: ['read_file', 'search_text'], minToolCalls: 2}), true);
});

test('节流比较口径：从落盘消息还原裸 task_todos_check 块（两种形态都要认）', () => {
    const check = '<task_todos_check>任务清单现状：共 2 项，1 项已完成、1 项进行中、0 项待处理。</task_todos_check>';
    // 宿主块包装（新形态）
    assert.equal(todosCheckTextFromMessage('<system-reminder>\n' + check + '\n</system-reminder>'), check);
    // 裸块（旧形态）
    assert.equal(todosCheckTextFromMessage(check), check);
    // 提取不到 → 空串（按从未注入过处理）
    assert.equal(todosCheckTextFromMessage('<system-reminder>\n<workspace_context>已打开文件</workspace_context>\n</system-reminder>'), '');
    assert.equal(todosCheckTextFromMessage(''), '');
    assert.equal(todosCheckTextFromMessage(undefined), '');
});

test('回归（2026-11-19 session-mwm2sdc1n4cs5）：相同清单连续两轮只催一次', () => {
    // 复现真实链路：checkText 经 wrapTurnReminder 落盘（带宿主块包装），下一批工具结束
    // 时清单没动 → 不得再插。旧实现取包装后的 .body（恒空串）导致该闸门永远放行，
    // 相同文案落盘 339 条、模型每轮在思考链里复述计数。
    const todos = [
        {content: 'a', status: 'completed'},
        {content: 'b', status: 'in_progress'},
        {content: 'c', status: 'pending'},
    ];
    const checkText = todosCheckText(todos);
    const stored = '<system-reminder>\n' + checkText + '\n</system-reminder>';
    const tools = ['read_file', 'search_text', 'edit_file'];
    assert.equal(shouldSendTodosCheck({text: checkText, lastText: todosCheckTextFromMessage(stored), toolNames: tools}), false);
    // 清单真的变了（todo_write 落地后计数不同）→ 正常催
    const todos2 = todos.map((t) => ({content: t.content, status: t.status === 'pending' ? 'completed' : t.status}));
    assert.equal(shouldSendTodosCheck({text: todosCheckText(todos2), lastText: todosCheckTextFromMessage(stored), toolNames: tools}), true);
});
