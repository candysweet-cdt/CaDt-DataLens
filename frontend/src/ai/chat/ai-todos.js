// ai-todos.js：AI 面板 Todolist UI（折叠头 + 任务行 + 全部完成 3 秒自动收起）。
// 从 ai-panel.js 拆出（docs/unfinished-plans/structure-cleanup.md 阶段 3），函数体逐字搬移。
// todoStates（const Map，引用稳定）与 DOM 表/回调经 ctx 注入。
import {aiTextOf} from '../core/ai-constants.js';
import {iconSvg} from '../../core/icons.js';
import {kvGet, kvSet} from '../../core/kv-store.js';
import {AI_TODOS_BADGE_KEY} from '../../core/storage-keys.js';

// 新建会话状态时的默认收起态：默认收起（只看一行进度摘要），
// 设置页「任务清单默认展开」打开后为展开。纯函数便于单测。
export function todosDefaultCollapsed(settings) {
    return !(settings && settings.aiTodosDefaultExpanded === true);
}

// 轮末清单提醒（<task_todos_check>）的文案。口径必须与系统提示里的 <task_todos> 一致：
// 报「共 N 项 + 已完成/进行中/待处理」三分计数，且不断言「清单与实际进度没对齐」。
// 教训：旧文案只报进行中/待处理，模型拿它对自己刚写的 todo_write 清单对不上总数，
// 每轮把思考花在「这条提示是不是过期了」上，而不是继续干活。
export function todosCheckText(todos) {
    const list = Array.isArray(todos) ? todos : [];
    const doing = list.filter((todo) => todo.status === 'in_progress').length;
    const pending = list.filter((todo) => todo.status === 'pending').length;
    const done = list.length - doing - pending;
    return '<task_todos_check>任务清单现状：共 ' + list.length + ' 项，' +
        done + ' 项已完成、' + doing + ' 项进行中、' + pending + ' 项待处理。' +
        '若有已经做完却没标 completed 的步骤，用一次 todo_write 补齐；没有就无需处理本块。</task_todos_check>';
}

// 从上一条 task_todos_check 注入消息还原节流比较口径（裸 <task_todos_check> 块），
// 与 todosCheckText 的输出同形、可直接 === 比较。落盘 content 有两种形态都要认：
// 宿主块包装（<system-reminder> 包裹，新）与裸块（旧数据）。提取不到（非提醒消息 /
// 空内容）返回空串——按「从未注入过」处理，最多多催一次，无副作用。
// 教训（2026-11-19）：此前在 ai-panel.js 取 splitTurnReminderPrefix().body 当比较文本——
// body 是包装块之后的用户正文，纯注入消息里恒为空串，text === lastText 永不成立，
// 节流第一道闸门（相同文案不重复催）完全失效，相同文案每批工具结束都重插一条
// （session-mwm2sdc1n4cs5 实测 339 条、最长连续 69 条，模型每轮被迫在思考链里
// 复述「没有已完成未标记的项 / 不需要 todo_write」）。
export function todosCheckTextFromMessage(content) {
    const m = /<task_todos_check>[\s\S]*?<\/task_todos_check>/.exec(aiTextOf(content));
    return m ? m[0] : '';
}

// 轮末提醒的节流：清单文本与上次注入完全相同（模型没动过清单，旧那条仍在上下文里，
// 再插一条只是重复）不催；本轮距上一次 todo_write 不足 minToolCalls 个工具结果也不催
// ——模型一直在自己更新清单，属于正常推进。阈值放宽到 3 个批次，短轮次交给轮开始的
// <task_todos> 就够，不必每批都催一次。
export function shouldSendTodosCheck({text, lastText, toolNames, minToolCalls = 3} = {}) {
    if (!text || text === lastText) return false;
    const names = Array.isArray(toolNames) ? toolNames : [];
    let sinceTodoWrite = names.length;
    for (let i = names.length - 1; i >= 0; i--) {
        if (names[i] === 'todo_write') {
            sinceTodoWrite = names.length - 1 - i;
            break;
        }
    }
    return sinceTodoWrite >= minToolCalls;
}

export function createAITodos(ctx) {
    const todoStates = ctx.todoStates;
    const el = ctx.el;
    const currentSession = ctx.currentSession;
    const positionOverlays = ctx.positionOverlays;
    // settings 对象引用（不进解构）：切设置开关后新会话状态立即按新默认生成
    const settings = ctx.settings || {};

    // 收起态「进行中任务」小字开关：存 localStorage（默认开），不进设置页。
    const TODO_CURRENT_BADGE_KEY = AI_TODOS_BADGE_KEY;

    function currentBadgeEnabled() {
        // 未存过（null）或存储不可用时按默认「开」——原实现 catch 里也是 true
        return kvGet(TODO_CURRENT_BADGE_KEY) !== '0';
    }

    function setCurrentBadgeEnabled(on) {
        kvSet(TODO_CURRENT_BADGE_KEY, on ? '1' : '0');
    }

    function todoStateOf(session) {
        let state = todoStates.get(session.id);
        if (!state) {
            state = {collapsed: todosDefaultCollapsed(settings), doneCollapsed: false, timer: 0};
            todoStates.set(session.id, state);
        }
        return state;
    }

    // 设置页切换「任务清单默认展开」后立即生效：既有会话的收起态一起按新默认重置，
    // 否则要等下次新建会话才看到变化（用户会以为开关没反应）。
    function applyDefaultCollapse() {
        const collapsed = todosDefaultCollapsed(settings);
        for (const state of todoStates.values()) {
            if (state.timer) {
                clearTimeout(state.timer);
                state.timer = 0;
            }
            state.collapsed = collapsed;
            state.doneCollapsed = false;
        }
        renderTodos();
    }

    function renderTodos() {
        if (!el.todos) return;
        const session = currentSession();
        const list = session && Array.isArray(session.todos) ? session.todos : [];
        if (!session || !list.length) {
            el.todos.classList.add('hidden');
            el.todos.innerHTML = '';
            positionOverlays();
            return;
        }
        el.todos.classList.remove('hidden');
        const state = todoStateOf(session);
        const done = list.filter((todo) => todo.status === 'completed').length;
        const doing = list.filter((todo) => todo.status === 'in_progress').length;
        const todo = list.length - done - doing;
        const allDone = done === list.length;
        if (!allDone) state.doneCollapsed = false;
        el.todos.innerHTML = '';
        el.todos.classList.toggle('collapsed', state.collapsed);
        el.todos.classList.toggle('alldone', allDone);
        const head = document.createElement('button');
        head.type = 'button';
        head.className = 'ai-todos-head';
        const ico = document.createElement('span');
        ico.className = 'ai-todos-ico';
        ico.innerHTML = iconSvg('checklist');
        const label = document.createElement('span');
        label.className = 'ai-todos-label';
        label.textContent = '任务';
        const sum = document.createElement('span');
        sum.className = 'ai-todos-sum';
        sum.textContent = allDone
            ? '已全部完成 · ' + done + ' 项'
            : [
                done ? done + ' 已完成' : '',
                doing ? doing + ' 进行中' : '',
                todo ? todo + ' 待处理' : '',
            ].filter(Boolean).join(' · ') || (list.length + ' 项');
        const chev = document.createElement('span');
        chev.className = 'ai-todos-chev';
        chev.innerHTML = iconSvg('chevron-down');
        head.append(ico, label, sum);
        // 收起态：在展开 icon 左侧用小字显示进行中的任务标题（过长由 CSS 截断）。
        // 头部本身是 button，开关只能用 span role=button 承载，避免 button 嵌套。
        const badgeOn = currentBadgeEnabled();
        const currentTodo = list.find((todo) => todo.status === 'in_progress');
        if (state.collapsed && currentTodo && badgeOn) {
            const cur = document.createElement('span');
            cur.className = 'ai-todos-current';
            cur.textContent = currentTodo.content;
            head.appendChild(cur);
        }
        const curToggle = document.createElement('span');
        curToggle.className = 'ai-todos-cur-toggle' + (badgeOn ? '' : ' off');
        curToggle.setAttribute('role', 'button');
        curToggle.setAttribute('aria-label', '收起时显示进行中的任务');
        curToggle.innerHTML = iconSvg('eye');
        curToggle.addEventListener('click', (e) => {
            // 不触发头部的折叠/展开
            e.stopPropagation();
            setCurrentBadgeEnabled(!currentBadgeEnabled());
            renderTodos();
        });
        // 头部整行不给 tooltip：这是要读的一行标题，鼠标路过就冒「收起任务清单」纯属打扰；
        // 折叠语义由右侧箭头自明，展开态交给 aria-expanded。
        head.setAttribute('aria-expanded', String(!state.collapsed));
        head.appendChild(curToggle);
        head.appendChild(chev);
        head.addEventListener('click', () => {
            state.collapsed = !state.collapsed;
            if (state.collapsed && state.timer) {
                clearTimeout(state.timer);
                state.timer = 0;
            }
            renderTodos();
        });
        el.todos.appendChild(head);
        if (!state.collapsed) {
            const body = document.createElement('div');
            body.className = 'ai-todos-body';
            for (const item of list) {
                const row = document.createElement('div');
                row.className = 'ai-todo-item ' + item.status;
                const dot = document.createElement('span');
                dot.className = 'ai-todo-dot';
                const text = document.createElement('span');
                text.className = 'ai-todo-text';
                text.textContent = item.content;
                row.append(dot, text);
                body.appendChild(row);
            }
            el.todos.appendChild(body);
        }
        if (allDone && !state.collapsed && !state.timer && !state.doneCollapsed) {
            state.timer = setTimeout(() => {
                state.timer = 0;
                if (currentSession() && currentSession().id === session.id) {
                    state.collapsed = true;
                    state.doneCollapsed = true;
                    renderTodos();
                }
            }, 3000);
        }
        // 渲染完成后刷新悬浮层位置：回到底部按钮等以 todos 当前高度为基准。
        positionOverlays();
    }
    return {todoStateOf, renderTodos, applyDefaultCollapse};
}
