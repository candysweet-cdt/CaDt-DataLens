// settings-pane-lifecycle.js：设置 → 生命周期（工作区/会话生命周期事件上的自动命令钩子）。
// 条目存 settings.lifecycleHooks（AI 没有任何写通道，方案见
// docs/finished-plans/workspace-lifecycle-hooks.md）；纯函数在 core/lifecycle-hooks.js，
// AI 四动作在 shell/lifecycle-hooks.js（写动作无条件动作审批，完全权限也不例外）。
// 域间依赖（analyzeDangerousCommand / runOnce / sessionPathKey）一律经 deps 注入。
// 条目行不用 .set-row 标记类——刻意不进设置树（设置树只暴露总开关一行，见 §7 决策 10）。
// 2026-11-21 由 settings-pane-precommands.js 改名，DOM id / CSS 类同步 precmd-* → lifecycle-*。

import {createInput, createNumber, createSelect, createSwitch} from '../core/form-controls.js';
import {overlayStack} from '../core/overlay-stack.js';
import {
    LIFECYCLE_HOOK_TIMEOUT_DEFAULT,
    LIFECYCLE_HOOK_TIMEOUT_MIN,
    LIFECYCLE_HOOK_TIMEOUT_MAX,
    LIFECYCLE_HOOK_EVENTS,
    LIFECYCLE_HOOK_EVENT_OPTIONS,
    LIFECYCLE_HOOK_MAX_TOTAL,
    LIFECYCLE_HOOK_MAX_PER_WS,
    normalizeLifecycleHook,
    eventLabel,
    isToolEvent,
    wsDisplayName,
    commandDigest,
} from '../core/lifecycle-hooks.js';

export function createSettingsPaneLifecycle(deps) {

// 编辑器状态：null = 关闭；{id} = 编辑现有；{id: ''} = 新建（弹窗生命周期内有效）
let editor = null;
// 弹窗 DOM（惰性创建一次复用）与弹层栈句柄：自建模态、直接接 overlayStack（modal 档），
// 不依赖 AI 面板的对话框三件套——那要求 aiPanel.openDialog 在返回面（实测并不存在，
// 曾导致「点新建没反应」）；z-index 由栈分配（modal 3100 > 设置窗 dialog 2101），Esc 由栈退。
let modalEl = null;
let modalStackHandle = null;

function entriesOf() {
    return Array.isArray(deps.settings.lifecycleHooks) ? deps.settings.lifecycleHooks : [];
}

function wsKeyOf() {
    const ws = String(deps.getWorkspace() || '');
    return ws ? deps.sessionPathKey(ws) : '';
}

function persist() {
    deps.applySettings();
    renderHookList();
}

// ---- 总开关（设置树行 id：lifecycle-enabled，risk=medium，AI 写入走动作审批）----

function setupMasterSwitch() {
    const control = document.getElementById('lifecycle-enabled');
    if (!control) return;
    control.checked = deps.settings.lifecycleHooksEnabled !== false;
    control.addEventListener('change', () => {
        deps.settings.lifecycleHooksEnabled = control.checked;
        deps.applySettings();
        deps.flash(control.checked ? '已启用：打开工作区时自动执行' : '已停用：打开工作区不再自动执行');
    });
}

// ---- 条目列表（动态行，不进设置树）----

function smallButton(label, className, onClick, tip) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lifecycle-btn' + (className ? ' ' + className : '');
    btn.textContent = label;
    if (tip) btn.dataset.tip = tip;
    btn.addEventListener('click', onClick);
    return btn;
}

function renderHookList() {
    const list = document.getElementById('lifecycle-list');
    if (!list) return;
    list.textContent = '';
    const wsKey = wsKeyOf();
    const entries = entriesOf();
    const mine = wsKey ? entries.filter((e) => String(e.ws || '') === wsKey) : [];
    if (!wsKey) {
        const empty = document.createElement('div');
        empty.className = 'fmt-hint';
        empty.textContent = '先打开一个文件夹：钩子绑定工作区，按工作区各自生效。';
        list.appendChild(empty);
        return;
    }
    if (!mine.length) {
        const empty = document.createElement('div');
        empty.className = 'fmt-hint';
        empty.textContent = '当前工作区还没有配置，点「新建命令…」创建。';
        list.appendChild(empty);
        return;
    }
    for (const entry of mine) {
        list.appendChild(buildHookRow(entry, entries, wsKey));
    }
    if (editor && editor.id && !entries.some((e) => e && e.id === editor.id)) closeHookEditor();
}

function buildHookRow(entry, entries, wsKey) {
    const row = document.createElement('div');
    row.className = 'lifecycle-row';

    const toggle = createSwitch({
        checked: entry.enabled !== false,
        onChange: () => {
            // 直接改存量条目，不走 normalize（不触碰命令文本）；origin 保持不变
            entry.enabled = toggle.control.checked;
            persist();
        },
    });
    row.appendChild(toggle.element);

    const preview = document.createElement('span');
    preview.className = 'lifecycle-cmd';
    preview.textContent = commandDigest(entry.command, 120);
    preview.dataset.tip = entry.command;
    row.appendChild(preview);

    const evTag = document.createElement('span');
    evTag.className = 'lifecycle-tag';
    evTag.textContent = eventLabel(entry.event);
    row.appendChild(evTag);

    if (isToolEvent(entry.event) && Array.isArray(entry.matchTools) && entry.matchTools.length) {
        const tag = document.createElement('span');
        tag.className = 'lifecycle-tag';
        tag.textContent = '工具: ' + entry.matchTools.join('/');
        tag.dataset.tip = '匹配工具：' + entry.matchTools.join('、');
        row.appendChild(tag);
    }

    if (entry.origin === 'ai') {
        const tag = document.createElement('span');
        tag.className = 'lifecycle-tag';
        tag.textContent = 'AI 配置';
        tag.dataset.tip = '该条目由 AI 写入并经你审批；你在本页保存过它会改回「用户配置」';
        row.appendChild(tag);
    }
    const verdict = typeof deps.analyzeDangerousCommand === 'function'
        ? deps.analyzeDangerousCommand(entry.command) : null;
    if (verdict && verdict.dangerous) {
        const danger = document.createElement('span');
        danger.className = 'lifecycle-danger';
        danger.textContent = '⚠ ' + (verdict.label || '危险命令');
        danger.dataset.tip = '命中危险命令规则（只提示，不拦截）：' + (verdict.segment || entry.command);
        row.appendChild(danger);
    }

    // 上移 / 下移：只在同工作区条目之间交换（全局数组里跳过别的工作区的条目）
    const siblings = entries
        .map((e, i) => ({e, i}))
        .filter((x) => String(x.e.ws || '') === wsKey);
    const pos = siblings.findIndex((x) => x.e.id === entry.id);
    row.appendChild(smallButton('↑', '', () => moveHook(siblings, pos, -1),
        pos > 0 ? '上移（执行顺序 = 列表顺序）' : '已经是第一条'));
    row.appendChild(smallButton('↓', '', () => moveHook(siblings, pos, 1),
        pos < siblings.length - 1 ? '下移（执行顺序 = 列表顺序）' : '已经是最后一条'));
    row.appendChild(smallButton('运行', 'lifecycle-btn-run', () => runOnceEntry(entry),
        '立即执行一次（结果见状态栏消息中心）'));
    row.appendChild(smallButton('编辑', 'lifecycle-btn-edit', () => openHookEditor(entry)));
    row.appendChild(smallButton('删除', 'lifecycle-btn-del', () => deleteHook(entry)));
    return row;
}

// 列表行的单条立即执行（用户入口，不走审批；AI 没有对应的 run 动作）
function runOnceEntry(entry) {
    if (!deps.getWorkspace()) {
        deps.flash('先打开一个文件夹：命令绑定工作区', true);
        return;
    }
    deps.flash('已触发执行（' + wsDisplayName(deps.getWorkspace()) + '），结果见状态栏消息中心');
    Promise.resolve(deps.runOnceEntry(entry)).catch((e) => {
        console.error('lifecycle: 单条运行失败', e);
    });
}

function moveHook(siblings, pos, delta) {
    const next = pos + delta;
    if (next < 0 || next >= siblings.length) return;
    const entries = entriesOf();
    const a = siblings[pos].i;
    const b = siblings[next].i;
    const tmp = entries[a];
    entries[a] = entries[b];
    entries[b] = tmp;
    deps.settings.lifecycleHooks = entries;
    persist();
}

function deleteHook(entry) {
    const doRemove = () => {
        deps.settings.lifecycleHooks = entriesOf().filter((e) => e.id !== entry.id);
        if (editor && editor.id === entry.id) closeHookEditor();
        persist();
        deps.flash('已删除：' + commandDigest(entry.command, 40));
    };
    if (typeof deps.confirmAction === 'function') {
        deps.confirmAction('删除命令「' + commandDigest(entry.command, 60) + '」？', doRemove, '删除', '删除命令', 'danger');
    } else {
        doRemove();
    }
}

// ---- 新建 / 编辑（弹窗表单；字段上下布局：标题行 + 控件占满宽，短说明在标题右侧）----

function editorRow(label, controlEl, hint) {
    const row = document.createElement('div');
    row.className = 'lifecycle-field';
    const head = document.createElement('div');
    head.className = 'lifecycle-field-head';
    const title = document.createElement('span');
    title.className = 'lifecycle-field-label';
    title.textContent = label;
    head.appendChild(title);
    if (hint) {
        const d = document.createElement('span');
        d.className = 'lifecycle-field-hint';
        d.textContent = hint;
        head.appendChild(d);
    }
    const ctl = document.createElement('div');
    ctl.className = 'lifecycle-field-control';
    if (controlEl) ctl.appendChild(controlEl);
    row.append(head, ctl);
    return {row, ctl};
}

function ensureModalDom() {
    if (modalEl) return modalEl;
    const root = document.createElement('div');
    root.className = 'lifecycle-modal hidden';
    const card = document.createElement('div');
    card.className = 'lifecycle-modal-card';
    const title = document.createElement('div');
    title.className = 'lifecycle-modal-title';
    const body = document.createElement('div');
    body.className = 'lifecycle-modal-body';
    const foot = document.createElement('div');
    foot.className = 'lifecycle-modal-foot';
    card.append(title, body, foot);
    root.appendChild(card);
    // 点遮罩（容器自身）关闭：与各模态一致的收口路径
    root.addEventListener('mousedown', (e) => {
        if (e.target === root) closeHookEditor();
    });
    document.body.appendChild(root);
    modalEl = root;
    return modalEl;
}

function closeHookEditor() {
    editor = null;
    if (modalStackHandle) {
        modalStackHandle.dispose();
        modalStackHandle = null;
    }
    if (modalEl) modalEl.classList.add('hidden');
}

function openHookEditor(entry) {
    editor = {id: entry ? entry.id : ''};
    const cmdIn = createInput({
        value: entry ? entry.command : '',
        placeholder: '例如：npm run dev（工作目录为该工作区根）',
        spellcheck: false, autocomplete: 'off',
    });
    cmdIn.element.style.flex = '1';
    cmdIn.element.style.minWidth = '0';
    const seconds = entry ? Math.round((entry.timeoutMs || LIFECYCLE_HOOK_TIMEOUT_DEFAULT) / 1000)
        : Math.round(LIFECYCLE_HOOK_TIMEOUT_DEFAULT / 1000);
    const timeoutIn = createNumber({
        value: seconds,
        min: Math.round(LIFECYCLE_HOOK_TIMEOUT_MIN / 1000),
        max: Math.round(LIFECYCLE_HOOK_TIMEOUT_MAX / 1000),
    });
    // 旧名 ai-session-start（一期存量）在下拉里映射到规范名 session-start，
    // 否则没有选项命中会默认选第一项 workspace-open，保存时把用户的命令改错事件（审查 P1）
    const selectedEvent = entry ? (entry.event === 'ai-session-start' ? 'session-start' : entry.event) : 'workspace-open';
    const eventSel = createSelect({
        options: LIFECYCLE_HOOK_EVENT_OPTIONS.map((ev) => ({value: ev, label: eventLabel(ev), selected: ev === selectedEvent})),
    });
    const matchIn = createInput({
        value: entry && Array.isArray(entry.matchTools) ? entry.matchTools.join(', ') : '',
        placeholder: '例如 write_file, run_command, mcp__*（留空 = 所有工具）',
        spellcheck: false, autocomplete: 'off',
    });
    const matchRow = editorRow('匹配工具', matchIn.element,
        '逗号分隔；mcp__* 匹配全部 MCP；留空=所有工具').row;
    const syncMatchRow = () => { matchRow.classList.toggle('hidden', !isToolEvent(eventSel.control.value)); };
    eventSel.control.addEventListener('change', syncMatchRow);
    syncMatchRow();

    // 自建模态 + 接 overlayStack（modal 档）：不依赖 AI 面板，Esc / z-index 都归栈管
    const submit = () => saveHookEditor({
        id: entry ? entry.id : '',
        command: cmdIn.control.value,
        timeoutMs: Math.round(Number(timeoutIn.control.value) || 0) * 1000,
        event: eventSel.control.value,
        matchTools: matchIn.control.value,
    });
    const dlgBtn = (label, className, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = className;
        b.textContent = label;
        b.addEventListener('click', onClick);
        return b;
    };
    const modal = ensureModalDom();
    modal.querySelector('.lifecycle-modal-title').textContent = entry ? '编辑生命周期钩子' : '新建生命周期钩子';
    const bodyBox = modal.querySelector('.lifecycle-modal-body');
    bodyBox.textContent = '';
    bodyBox.append(
        editorRow('命令', cmdIn.element, '特定 shell 直接写在命令里').row,
        editorRow('时机', eventSel.element, '工具级按匹配器过滤；其余按会话/工作区触发').row,
        matchRow,
        editorRow('超时（秒）', timeoutIn.element, '1–600 秒，到点强制停止').row,
    );
    // 弹窗挂在 body，enhanceSetSelects 扫不到——挂载后手动走设置页的行式下拉增强
    // （gen-settings 先例），原生 select 露系统外观是被表单硬规范禁的场景；
    // 增强器选完派发原生 change，匹配器行的显隐联动不受影响
    if (typeof deps.enhanceSelect === 'function') deps.enhanceSelect(eventSel.control);
    const footBox = modal.querySelector('.lifecycle-modal-foot');
    footBox.textContent = '';
    footBox.append(
        dlgBtn('取消', 'dlg-btn', closeHookEditor),
        dlgBtn(entry ? '保存修改' : '创建命令', 'dlg-btn primary', submit),
    );
    if (modalStackHandle) modalStackHandle.dispose();
    modal.classList.remove('hidden');
    modalStackHandle = overlayStack.open({
        id: 'lifecycle-editor', kind: 'modal', el: modal,
        onClose: () => { closeHookEditor(); return true; },
    });
    cmdIn.control.focus();
}

function saveHookEditor(form) {
    const command = String(form.command || '').trim();
    if (!command) {
        deps.flash('请填命令', true);
        return;
    }
    const event = LIFECYCLE_HOOK_EVENTS.includes(form.event) ? form.event : 'workspace-open';
    const matchTools = String(form.matchTools || '').split(/[,，\n、\s]+/)
        .map((t) => t.trim()).filter(Boolean);
    const entries = entriesOf();
    if (form.id) {
        const idx = entries.findIndex((e) => e && e.id === form.id);
        if (idx < 0) {
            deps.flash('该条目已被删除', true);
            closeHookEditor();
            renderHookList();
            return;
        }
        // 用户亲手保存 = 最后写入方，origin 归 'user'（AI 配置徽标随之消失）
        const norm = normalizeLifecycleHook({command, timeoutMs: form.timeoutMs, event, matchTools, origin: 'user'}, entries[idx]);
        if (!norm.ok) {
            deps.flash(norm.error, true);
            return;
        }
        deps.settings.lifecycleHooks = entries.map((e, i) => (i === idx ? norm.entry : e));
    } else {
        const wsKey = wsKeyOf();
        if (!wsKey) {
            deps.flash('先打开一个文件夹：命令绑定工作区', true);
            return;
        }
        if (entries.length >= LIFECYCLE_HOOK_MAX_TOTAL) {
            deps.flash('已达全局上限 ' + LIFECYCLE_HOOK_MAX_TOTAL + ' 条，请先删除不用的条目', true);
            return;
        }
        const mine = entries.filter((e) => String(e.ws || '') === wsKey);
        if (mine.length >= LIFECYCLE_HOOK_MAX_PER_WS) {
            deps.flash('当前工作区已达上限 ' + LIFECYCLE_HOOK_MAX_PER_WS + ' 条', true);
            return;
        }
        const norm = normalizeLifecycleHook({command, timeoutMs: form.timeoutMs, event, matchTools, ws: wsKey, origin: 'user'});
        if (!norm.ok) {
            deps.flash(norm.error, true);
            return;
        }
        deps.settings.lifecycleHooks = entries.concat([norm.entry]);
    }
    deps.applySettings();
    closeHookEditor();
    renderHookList();
    deps.flash(form.id ? '已保存' : '已创建：' + commandDigest(command, 40));
}

// ---- 预跑一次（纯用户入口，不走审批；AI 没有对应动作，见 §7 决策 5）----

function setupActions() {
    const runNow = document.getElementById('lifecycle-run-now');
    if (runNow) {
        runNow.addEventListener('click', () => {
            if (!deps.getWorkspace()) {
                deps.flash('先打开一个文件夹：命令绑定工作区', true);
                return;
            }
            deps.flash('已触发执行（' + wsDisplayName(deps.getWorkspace()) + '），结果见状态栏消息中心');
            Promise.resolve(deps.runOnce()).catch((e) => {
                console.error('lifecycle: 预跑失败', e);
            });
        });
    }
    const newBtn = document.getElementById('lifecycle-new');
    if (newBtn) newBtn.addEventListener('click', () => openHookEditor(null));
}

function renderLifecyclePane() {
    const master = document.getElementById('lifecycle-enabled');
    if (master) master.checked = deps.settings.lifecycleHooksEnabled !== false;
    renderHookList();
}

setupMasterSwitch();
setupActions();
renderHookList();

return {renderLifecyclePane};
}
