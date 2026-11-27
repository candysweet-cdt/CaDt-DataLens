// ai-timer.js：AI 计时工具的单胶囊 UI 与前端注册表（类一-11）。
// 计时本体在 Go 侧（timer.go，窗口最小化不漂移）；到点广播 ai-timer-fired，
// 经 ai-panel 的 wakeSessionByTimer 注入系统消息唤醒对应会话（与定时任务同一投递通道）。
// 头部只挂一枚「计时」胶囊（数量角标 + 最近倒计时剩余走秒），无计时器时隐藏；
// 点击弹出计时器列表：行点击进入详情（读数/起止时刻/id + 停止按钮），行尾【x】直接停止。
// 用户也能从消息框「+」→ 计时器手动创建倒计时 / 正计时（openCreateDialog，居中弹窗）。
// 弹层复用 chips-pop 机制（kind=timers，内容由 renderPop 提供）。
//
// deps 由 ai-panel 显式传入（getter 延迟求值）：
// - getBackend(): Wails 后端（StartTimer / StopTimer / ListTimers）
// - getSessionId(): 面板当前打开的会话 id（显示过滤口径 + 手动创建的缺省归属；AI 工具启动的
//   计时器由 start 的 ownerSessionId 显式传发起会话，不能用这个）
// - getChip(): 头部计时胶囊（index.html 的 #ai-chip-timers）
// - togglePop(chip): 开关计时器弹层（ai-panel 转发到 subagents 的 chips-pop 机制）
// - onTimersChanged(): 计时器集合/视图变化通知（弹层开着时由 ai-panel 原位刷新）
// - flash(msg, isErr): 用户可见提示（创建成功 / 校验失败）
// - onFire(payload): 到点回调（payload 含 sessionId），由 ai-panel 注入并触发新一轮
// - openDialog/closeDialog/dialogNode/dialogButton: 居中弹窗三件套（ai-panel openAIDialog）
import {iconSvg} from '../../core/icons.js';
import {createInput, createSelect} from '../../core/form-controls.js';

const AI_TIMER_SESSION_MAX = 5; // 单会话同时运行上限（应用总上限 30 在 Go 侧 aiTimerMaxActive）

// 倒计时的常用时长档位（秒）：select 直选，替代手输数字。
const AI_TIMER_PRESETS = [
    {value: 300, label: '5 分钟'},
    {value: 600, label: '10 分钟'},
    {value: 900, label: '15 分钟'},
    {value: 1200, label: '20 分钟'},
    {value: 1800, label: '30 分钟'},
    {value: 2700, label: '45 分钟'},
    {value: 3600, label: '1 小时'},
];

// ===== 计时器快照与筛选 =====
// secondsUntilClock 把「到点时刻 HH:MM」换算成距现在的秒数（Go 侧按 duration 计时）。
// 时刻已过按明天同一时刻算（今晚 23 点建一个明早 8 点的到点 ≈ 9 小时）。
// 返回 0 表示时刻格式非法。
export function secondsUntilClock(hhmm, nowMs) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
    if (!match) return 0;
    const hh = Number(match[1]);
    const mm = Number(match[2]);
    if (hh > 23 || mm > 59) return 0;
    const now = Number(nowMs) || Date.now();
    const target = new Date(now);
    target.setHours(hh, mm, 0, 0);
    let delta = target.getTime() - now;
    if (delta <= 0) delta += 24 * 3600 * 1000;
    return Math.round(delta / 1000);
}

// 计时器会话隔离（纯函数，ai-timer.test.mjs 覆盖）。
// 显示与上限都按会话隔离：胶囊 / 弹层 / 数量角标只算「归属当前会话」的计时器；
// 归属不明（跨窗同步来的外部计时器，本实例没记过归属）保持可见可停，避免另一窗口
// 关闭后计时器在本窗口失联。done（到点 / 停止）的计时器已从注册表移除，天然不计入。
export function filterTimersForSession(timers, sessionIdOf, currentSessionId) {
    const out = [];
    if (timers && typeof timers.values === 'function') {
        for (const info of timers.values()) {
            const owner = sessionIdOf(info.id);
            if (!owner || owner === currentSessionId) out.push(info);
        }
    }
    return out;
}

// 会话内上限计数：只数归属当前会话的运行中计时器（不含归属不明的跨窗计时器）。
export function countSessionTimers(timers, sessionIdOf, currentSessionId) {
    let n = 0;
    if (timers && typeof timers.keys === 'function') {
        for (const id of timers.keys()) {
            if (sessionIdOf(id) === currentSessionId) n += 1;
        }
    }
    return n;
}

// timer_list 只读快照（纯函数，ai-timer.test.mjs 覆盖）。
// 与 UI 的 filterTimersForSession 口径不同：UI 为避免跨窗计时器失联会放行「归属不明」的条目，
// 但共享给子代理时必须严格按会话树过滤——归属不明（别的窗口同步来的）一律不外泄。
// sessionIds 传入调用方所在会话链（自身 / 父 / 根），只暴露这条链上启动的计时器。
export function snapshotTimersForTree(timers, sessionIdOf, sessionIds, nowMs) {
    const out = [];
    const allowed = new Set((Array.isArray(sessionIds) ? sessionIds : [sessionIds]).filter(Boolean));
    if (!allowed.size || !timers || typeof timers.values !== 'function') return out;
    const now = Number(nowMs) || Date.now();
    for (const info of timers.values()) {
        if (!info || !info.id) continue;
        const owner = sessionIdOf(info.id);
        if (!allowed.has(owner)) continue;
        const countup = info.mode === 'countup';
        out.push({
            id: info.id,
            mode: countup ? 'countup' : 'countdown',
            label: info.label || '',
            startMs: info.startMs || 0,
            elapsedMs: Math.max(0, now - (info.startMs || 0)),
            remainingMs: countup ? 0 : Math.max(0, (info.endMs || 0) - now),
            autoStopMs: info.autoStopMs || 0,
            marks: Array.isArray(info.marks) ? info.marks.length : 0,
            owner,
        });
    }
    return out;
}

// ===== 计时器服务入口 =====
export function createAITimer(ctx) {
    const timers = new Map();   // id → AITimerInfo
    const sessions = new Map(); // id → 启动时的会话 id（Go 侧不感知会话）
    let styleInjected = false;
    let tickTimer = 0;
    let detailId = '';          // 弹层当前展示的详情计时器 id（空 = 列表视图）

    // 当前会话可见的计时器（显示隔离的统一口径，见文件头 filterTimersForSession 注释）
    function visibleTimers() {
        const sid = ctx.getSessionId ? ctx.getSessionId() : '';
        return filterTimersForSession(timers, (id) => sessions.get(id) || '', sid);
    }

// ===== 胶囊与格式化 =====
    function ensureStyle() {
        if (styleInjected) return;
        styleInjected = true;
        const style = document.createElement('style');
        style.textContent = [
            '.ai-chip-time { font-variant-numeric: tabular-nums; color: var(--accent); font-weight: 600; }',
            '.ai-chip-time.hidden { display: none; }',
            '.ai-timer-badge { flex: none; font-size: 10px; line-height: 16px; color: var(--accent); border: 1px solid var(--border); border-radius: 3px; padding: 0 4px; }',
            '.ai-timer-badge.countup { color: var(--muted); }',
            '.ai-timer-row-time { font-variant-numeric: tabular-nums; }',
            '.ai-timer-stop { flex: none; width: 18px; height: 18px; display: grid; place-items: center; padding: 0; border: none; border-radius: 3px; background: none; color: var(--muted); cursor: pointer; }',
            '.ai-timer-stop:hover { background: color-mix(in srgb, var(--red) 14%, transparent); color: var(--red); }',
            '.ai-timer-stop svg { width: 11px; height: 11px; display: block; }',
            '.ai-timer-back { width: 100%; margin-bottom: 4px; justify-content: flex-start; }',
            '.ai-timer-detail { padding: 4px 6px 6px; display: flex; flex-direction: column; gap: 3px; font-size: 11px; }',
            '.ai-timer-detail-row { display: flex; gap: 8px; min-width: 0; }',
            '.ai-timer-detail-key { flex: none; color: var(--muted); }',
            '.ai-timer-detail-val { flex: 1; min-width: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }',
            '.ai-timer-detail-time { color: var(--accent); font-weight: 600; }',
            '.ai-timer-stop-btn { margin-top: 6px; align-self: flex-start; }',
            '.ai-timer-mark-input { flex: 1; min-width: 0; font-size: 11px; }',
            '.ai-timer-mark-btn { flex: none; }',
            '.ai-timer-create-err { font-size: 11px; color: var(--red); min-height: 14px; }',
        ].join('\n');
        document.head.appendChild(style);
    }

    function chipEl() {
        return typeof ctx.getChip === 'function' ? ctx.getChip() : null;
    }

    function flash(msg, isErr) {
        return typeof ctx.flash === 'function' ? ctx.flash(msg, isErr) : undefined;
    }

    // 弹层内容变化的原位刷新：经 ai-panel 的 onTimersChanged 转发（chipsPopKind 为 timers 时重渲染）
    function refreshPop() {
        if (typeof ctx.onTimersChanged === 'function') ctx.onTimersChanged();
    }

    function fmtDuration(totalSeconds) {
        const s = Math.max(0, Math.floor(totalSeconds));
        const hh = Math.floor(s / 3600);
        const mm = Math.floor((s % 3600) / 60);
        const ss = s % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return hh > 0 ? hh + ':' + pad(mm) + ':' + pad(ss) : pad(mm) + ':' + pad(ss);
    }

    function fmtClock(ms) {
        const d = new Date(ms);
        const pad = (n) => String(n).padStart(2, '0');
        return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    // modeText 模式说明文案（详情视图用）：正计时区分「到点自动停止」兜底形态。
    function modeText(info) {
        if (info.mode === 'countdown') return '倒计时（到点自动唤醒 AI）';
        return info.autoStopMs ? '正计时（停止时上报时长；到点自动停止）' : '正计时（停止时上报时长）';
    }

    // 胶囊时间位与弹层行的实时读数：倒计时显示剩余，正计时显示已计
    function liveTime(info) {
        return info.mode === 'countdown'
            ? fmtDuration((info.endMs - Date.now()) / 1000)
            : fmtDuration((Date.now() - info.startMs) / 1000);
    }

    // 胶囊聚焦的计时器（仅当前会话可见集）：优先「最快到点的倒计时」，没有倒计时时取最新启动的正计时
    function focusTimer() {
        let soonest = null;
        for (const info of visibleTimers()) {
            if (info.mode !== 'countdown') continue;
            if (!soonest || info.endMs < soonest.endMs) soonest = info;
        }
        if (soonest) return soonest;
        let latest = null;
        for (const info of visibleTimers()) {
            if (!latest || (info.startMs || 0) > (latest.startMs || 0)) latest = info;
        }
        return latest;
    }

    function ensureChipChrome(chip) {
        const iconEl = chip.querySelector('.ai-chip-icon');
        if (iconEl && !iconEl.dataset.ready) {
            iconEl.dataset.ready = '1';
            iconEl.innerHTML = iconSvg('clock', 12);
        }
    }

// ===== 胶囊渲染 =====
    function updateChipTime(chip) {
        const timeEl = chip.querySelector('.ai-chip-time');
        if (!timeEl) return;
        const info = focusTimer();
        if (info) {
            timeEl.textContent = liveTime(info);
            timeEl.classList.remove('hidden');
        } else {
            timeEl.textContent = '';
            timeEl.classList.add('hidden');
        }
    }

    function render() {
        const chip = chipEl();
        if (!chip) return;
        ensureStyle();
        ensureChipChrome(chip);
        // 会话隔离：只显示/统计当前会话的计时器（其他会话的照常在跑并到点唤醒自己，只是不在这里显示）
        const visible = visibleTimers();
        chip.classList.toggle('hidden', !visible.length);
        const countEl = chip.querySelector('.ai-chip-count');
        if (countEl) {
            countEl.textContent = String(visible.length);
            countEl.classList.toggle('hidden', !visible.length);
        }
        if (visible.length) {
            updateChipTime(chip);
        }
        // 弹层开着时由 ai-panel 原位刷新（详情对象被停止时自动回到列表）
        refreshPop();
        if (timers.size && !tickTimer) {
            tickTimer = setInterval(() => {
                if (!timers.size) return;
                const current = chipEl();
                if (current && !current.classList.contains('hidden')) updateChipTime(current);
                // 弹层行/详情读数原位刷新，不整层重建（避免打断悬停/点击）
                const pop = document.getElementById('ai-chips-pop');
                if (pop) {
                    for (const timeEl of pop.querySelectorAll('.ai-timer-row-time[data-timer-id], .ai-timer-detail-time[data-timer-id]')) {
                        const info = timers.get(timeEl.dataset.timerId);
                        if (info) timeEl.textContent = liveTime(info);
                    }
                }
            }, 1000);
        }
        if (!timers.size && tickTimer) {
            clearInterval(tickTimer);
            tickTimer = 0;
        }
    }

// ===== 弹层渲染 =====
    // chips-pop 的 timers 内容：列表视图（行点击进详情，行尾【x】停止）与详情视图两种形态
    function renderPop(host) {
        if (!host) return;
        ensureStyle();
        host.textContent = '';
        const info = timers.get(detailId);
        if (info) {
            renderPopDetail(host, info);
            return;
        }
        const title = document.createElement('div');
        title.className = 'ai-chips-pop-title';
        title.textContent = '计时器';
        host.appendChild(title);
        const list = visibleTimers().sort((a, b) => {
            if ((a.mode === 'countdown') !== (b.mode === 'countdown')) return a.mode === 'countdown' ? -1 : 1;
            return a.mode === 'countdown' ? (a.endMs - b.endMs) : ((b.startMs || 0) - (a.startMs || 0));
        });
        for (const item of list) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'ai-chips-row ai-timer-row';
            const badge = document.createElement('span');
            badge.className = 'ai-timer-badge' + (item.mode === 'countdown' ? '' : ' countup');
            badge.textContent = item.mode === 'countdown' ? '倒计时' : '正计时';
            const main = document.createElement('span');
            main.className = 'ai-chips-main';
            const nameSpan = document.createElement('span');
            nameSpan.className = 'ai-chips-name';
            nameSpan.textContent = item.label || (item.mode === 'countdown' ? '倒计时' : '正计时');
            const timeSpan = document.createElement('span');
            timeSpan.className = 'ai-chips-sub ai-timer-row-time';
            timeSpan.dataset.timerId = item.id;
            timeSpan.textContent = liveTime(item);
            main.append(nameSpan, timeSpan);
            // 行尾【x】：直接停止该计时器（行本体点击 = 看详情）
            const stopBtn = document.createElement('span');
            stopBtn.className = 'ai-timer-stop';
            stopBtn.setAttribute('role', 'button');
            stopBtn.setAttribute('aria-label', '停止「' + (item.label || item.id) + '」');
            stopBtn.dataset.tip = '停止该计时器';
            stopBtn.innerHTML = iconSvg('close', 12);
            stopBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                stop(item.id).then((stopped) => {
                    if (stopped && stopped.mode === 'countup') {
                        const elapsed = Math.max(0, Math.round((Date.now() - stopped.startMs) / 1000));
                        flash('正计时「' + stopped.label + '」已停止，已计 ' + Math.floor(elapsed / 60) + ' 分 ' + (elapsed % 60) + ' 秒');
                    }
                }).catch(() => {});
            });
            row.append(badge, main, stopBtn);
            row.addEventListener('click', () => {
                detailId = item.id;
                refreshPop();
            });
            host.appendChild(row);
        }
        if (!list.length) {
            const empty = document.createElement('div');
            empty.className = 'ai-chips-empty';
            empty.textContent = '本会话暂无计时器';
            host.appendChild(empty);
        }
    }

    // 详情视图：目的 / 模式 / 实时读数 / 起止时刻 / id + 停止按钮（返回按钮回到列表）
    function renderPopDetail(host, info) {
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'ai-chips-row ai-timer-back';
        const backIco = document.createElement('span');
        backIco.className = 'ai-chips-go';
        backIco.style.transform = 'rotate(180deg)';
        backIco.innerHTML = iconSvg('chevron-right', 12);
        const backLabel = document.createElement('span');
        backLabel.className = 'ai-chips-name';
        backLabel.textContent = '返回列表';
        back.append(backIco, backLabel);
        back.addEventListener('click', () => {
            detailId = '';
            refreshPop();
        });
        host.appendChild(back);
        const box = document.createElement('div');
        box.className = 'ai-timer-detail';
        const rowOf = (key, valNode) => {
            const row = document.createElement('div');
            row.className = 'ai-timer-detail-row';
            const keyEl = document.createElement('span');
            keyEl.className = 'ai-timer-detail-key';
            keyEl.textContent = key;
            row.append(keyEl, valNode);
            return row;
        };
        const textVal = (text) => {
            const el = document.createElement('span');
            el.className = 'ai-timer-detail-val';
            el.textContent = text;
            return el;
        };
        box.appendChild(rowOf('目的', textVal(info.label || (info.mode === 'countdown' ? '倒计时' : '正计时'))));
        box.appendChild(rowOf('模式', textVal(modeText(info))));
        const timeEl = document.createElement('span');
        timeEl.className = 'ai-timer-detail-val ai-timer-detail-time';
        timeEl.dataset.timerId = info.id;
        timeEl.textContent = liveTime(info);
        box.appendChild(rowOf(info.mode === 'countdown' ? '剩余' : '已计', timeEl));
        if (info.mode === 'countdown') box.appendChild(rowOf('到点时刻', textVal(fmtClock(info.endMs))));
        if (info.mode === 'countup' && info.autoStopMs) box.appendChild(rowOf('自动停止', textVal(fmtClock(info.autoStopMs))));
        box.appendChild(rowOf('启动时刻', textVal(fmtClock(info.startMs))));
        // 时刻标记时间线（停止/到点时随系统消息一次性投给 AI，这里是已打的标记回显）
        for (const mark of info.marks || []) {
            const markVal = document.createElement('span');
            markVal.className = 'ai-timer-detail-val';
            const markText = document.createElement('span');
            markText.className = 'ai-timer-detail-time';
            markText.textContent = 'T+' + fmtDuration(Math.max(0, Math.round((mark.atMs - info.startMs) / 1000)));
            markVal.appendChild(markText);
            if (mark.note) markVal.appendChild(document.createTextNode(' ' + mark.note));
            box.appendChild(rowOf('标记', markVal));
        }
        box.appendChild(rowOf('id', textVal(info.id)));
        // 打标行：可选备注 + 一键打标（攒批投递，不打断 AI）
        const markRow = document.createElement('div');
        markRow.className = 'ai-timer-detail-row';
        const markInput = createInput({
            placeholder: '标记备注（可选，如「开始报错」）',
            maxLength: 200,
            spellcheck: false,
        });
        markInput.element.classList.add('ai-timer-mark-input');
        const markBtn = document.createElement('button');
        markBtn.type = 'button';
        markBtn.className = 'dlg-btn ai-timer-mark-btn';
        markBtn.textContent = '打标记';
        markBtn.addEventListener('click', () => {
            markTimer(info.id, markInput.control.value).catch(() => {});
        });
        markInput.control.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                markTimer(info.id, markInput.control.value).catch(() => {});
            }
        });
        markRow.append(markInput.element, markBtn);
        box.appendChild(markRow);
        const stopBtn = document.createElement('button');
        stopBtn.type = 'button';
        stopBtn.className = 'dlg-btn ai-timer-stop-btn';
        stopBtn.textContent = '停止计时器';
        stopBtn.addEventListener('click', () => {
            stop(info.id).then((stopped) => {
                if (stopped && stopped.mode === 'countup') {
                    const elapsed = Math.max(0, Math.round((Date.now() - stopped.startMs) / 1000));
                    flash('正计时「' + stopped.label + '」已停止，已计 ' + Math.floor(elapsed / 60) + ' 分 ' + (elapsed % 60) + ' 秒');
                }
            }).catch(() => {});
        });
        box.appendChild(stopBtn);
        host.appendChild(box);
    }

// ===== 创建对话框 =====
    // 「+」菜单的创建对话框（居中弹窗）：倒计时选常用时长档位或自定义到点时刻，
    // 正计时填目的 + 可选「到点自动停止」时刻。Go 侧按 duration 计时，到点时刻在此换算成秒。
    function openCreateDialog(mode) {
        if (typeof ctx.openDialog !== 'function') {
            flash('当前版本不支持创建对话框', true);
            return;
        }
        ensureStyle();
        closeCreateDialog();
        const isCountdown = mode !== 'countup';
        const errEl = ctx.dialogNode ? ctx.dialogNode('div', 'ai-timer-create-err', '') : document.createElement('div');

        const labelField = createInput({
            maxLength: 60,
            placeholder: '计时目的（必填，如「等待构建完成」）',
            spellcheck: false,
        });

        let presetSelect = null;
        let clockField = null;
        let autoStopField = null;
        if (isCountdown) {
            // 到点时刻默认值：现在 + 10 分钟（取整到分钟）
            const def = new Date(Date.now() + 10 * 60 * 1000);
            const pad = (n) => String(n).padStart(2, '0');
            const defClock = pad(def.getHours()) + ':' + pad(def.getMinutes());
            presetSelect = createSelect({
                options: AI_TIMER_PRESETS.map((p) => ({value: p.value, label: p.label}))
                    .concat([{value: 'custom', label: '自定义到点时刻'}]),
                onChange: () => syncClockVisible(),
            });
            clockField = createInput({
                type: 'time',
                value: defClock,
                title: '到点时刻（已过按明天同一时刻算）',
                onChange: () => {
                    // 选了时刻但档位还是时长：自动切到自定义档（程序赋值不触发 change，需手动同步可见性）
                    if (presetSelect.control.value !== 'custom') presetSelect.control.value = 'custom';
                    syncClockVisible();
                },
            });
        } else {
            // 正计时：可选「到点自动停止」兜底（忘停不再无限挂着）；留空 = 一直计到手动停
            const def = new Date(Date.now() + 30 * 60 * 1000);
            const pad = (n) => String(n).padStart(2, '0');
            autoStopField = createInput({
                type: 'time',
                value: '',
                title: '到点自动停止（可选，留空 = 一直计到手动停止；已过时刻按明天算）',
                placeholder: '到点自动停止（可选）',
                onChange: () => {},
            });
            autoStopField.control.dataset.defClock = pad(def.getHours()) + ':' + pad(def.getMinutes());
        }

        const body = [];
        body.push(labelField.element);
        if (isCountdown) {
            body.push(presetSelect.element);
            body.push(clockField.element);
        } else {
            body.push(autoStopField.element);
        }
        body.push(errEl);

        const close = () => closeCreateDialog();
        const footerNodes = [
            ctx.dialogButton('取消', 'dlg-btn', close),
            ctx.dialogButton(isCountdown ? '启动' : '开始计时', 'dlg-btn', () => {
                submit().catch(() => {});
            }),
        ];
        ctx.openDialog(isCountdown ? '新建倒计时' : '新建正计时', body, footerNodes);

        const syncClockVisible = () => {
            if (!clockField) return;
            clockField.element.classList.toggle('hidden', presetSelect.control.value !== 'custom');
        };
        syncClockVisible();

        const submit = async () => {
            errEl.textContent = '';
            const label = labelField.control.value.trim();
            if (!label) {
                errEl.textContent = '计时目的不能为空';
                labelField.control.focus();
                return;
            }
            let seconds = 0;
            if (isCountdown && presetSelect) {
                if (presetSelect.control.value === 'custom') {
                    const hhmm = clockField.control.value;
                    seconds = secondsUntilClock(hhmm, Date.now());
                    if (!seconds) {
                        errEl.textContent = '请选择有效的到点时刻';
                        clockField.control.focus();
                        return;
                    }
                } else {
                    seconds = Number(presetSelect.control.value) || 0;
                }
                if (seconds < 1 || seconds > 86400) {
                    errEl.textContent = '到点时间须在 1 秒 – 24 小时内';
                    return;
                }
            } else if (autoStopField && autoStopField.control.value) {
                // 正计时的到点自动停止（可选）：留空 = 一直计到手动停止
                seconds = secondsUntilClock(autoStopField.control.value, Date.now());
                if (seconds < 1 || seconds > 86400) {
                    errEl.textContent = '自动停止时刻须在 1 秒 – 24 小时内';
                    autoStopField.control.focus();
                    return;
                }
            }
            try {
                const created = await start(isCountdown ? 'countdown' : 'countup', seconds, label);
                close();
                flash((isCountdown ? '倒计时「' : '正计时「') + created.label + '」已启动' +
                    (isCountdown ? '，' + fmtClock(created.endMs) + ' 到点'
                        : (created.autoStopMs ? '，' + fmtClock(created.autoStopMs) + ' 自动停止' : '')));
            } catch (e) {
                errEl.textContent = (e && e.message) || String(e);
            }
        };
        // Enter 提交 / Esc 关闭（绑在弹窗输入控件上，冒泡统一处理）
        for (const control of [labelField.control, presetSelect ? presetSelect.control : null,
            clockField ? clockField.control : null, autoStopField ? autoStopField.control : null].filter(Boolean)) {
            control.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    submit().catch(() => {});
                } else if (e.key === 'Escape') {
                    e.stopPropagation();
                    close();
                }
            });
        }
        labelField.control.focus();
    }

    function closeCreateDialog() {
        if (typeof ctx.closeDialog === 'function') ctx.closeDialog();
    }

// ===== 同步与后端事件 =====
    function sync(list) {
        timers.clear();
        for (const info of Array.isArray(list) ? list : []) {
            if (info && info.id) timers.set(info.id, info);
        }
        render();
    }

    // start 启动计时器；返回新建的计时器信息（供工具结果描述）。
    // ownerSessionId 是发起这次创建的会话（AI 工具传正在执行的 ctx.session.id）；缺省才回落到
    // 面板当前打开的会话（手动创建）。后台会话运行中前台可能已切走，不能拿可见会话记归属——
    // 否则到点唤醒与会话内上限都会算到错误会话上。
    async function start(mode, seconds, label, ownerSessionId) {
        const backend = ctx.getBackend();
        if (!backend || typeof backend.StartTimer !== 'function') throw new Error('当前版本不支持计时工具');
        // 会话内上限（done 不计入——注册表里只有运行中的）：AI 工具与手动创建同走这里
        const sid = String(ownerSessionId || (ctx.getSessionId ? ctx.getSessionId() : '') || '');
        if (countSessionTimers(timers, (id) => sessions.get(id) || '', sid) >= AI_TIMER_SESSION_MAX) {
            throw new Error('本会话运行中的计时器已达上限（' + AI_TIMER_SESSION_MAX + ' 个），请先停止部分计时器');
        }
        // Go 返回 AITimerStartResult {list, created}；应用总上限（30）由 Go 侧 aiTimerMaxActive 把关
        const result = await backend.StartTimer(mode === 'countup' ? 'countup' : 'countdown',
            Math.max(0, Math.round(Number(seconds) || 0)), String(label || '').slice(0, 60));
        const list = (result && result.list) || [];
        const created = (result && result.created) || {};
        sessions.set(created.id, sid);
        sync(list);
        return created;
    }

    // stop 停止指定计时器；返回被停信息（正计时的已计时长由前端按 now-StartMs 计算）。
    async function stop(id) {
        const backend = ctx.getBackend();
        if (!backend || typeof backend.StopTimer !== 'function') throw new Error('当前版本不支持计时工具');
        const target = id || onlyRunningId();
        if (!target) throw new Error(timers.size ? '有多个计时器在运行，请指定 id（start_timer 返回值里有）' : '没有运行中的计时器');
        // Go 返回 AITimerStopResult {list, stopped, found}。
        // 会话归属不在这里删：ai-timer-stopped 广播回来时 onStopped 统一读取并返回，
        // 正计时停止的会话通知（ai-panel）要靠它找到绑定会话。
        const result = await backend.StopTimer(target);
        if (!result || !result.found) throw new Error('计时器不存在：' + target);
        sync(result.list || []);
        return result.stopped;
    }

    function onlyRunningId() {
        const ids = [...timers.keys()];
        return ids.length === 1 ? ids[0] : '';
    }

    // snapshot 给 AI 工具 timer_list 的只读时钟：按调用方会话链过滤，只有读权。
    // 子代理 / 孙代理经同一个 executeTool 调用它，看到的是主会话启动的那几枚计时器。
    function snapshot(sessionIds) {
        return snapshotTimersForTree(timers, (id) => sessions.get(id) || '', sessionIds, Date.now());
    }

    // markTimer 给运行中的计时器打时刻标记（可选备注）：攒在 Go 注册表里，
    // 停止 / 到点时随事件一次性投递给绑定会话（逐针唤醒 AI 既贵又吵，攒批后给完整时间线）。
    async function markTimer(id, note) {
        const backend = ctx.getBackend();
        if (!backend || typeof backend.MarkTimer !== 'function') throw new Error('当前版本不支持打标记');
        const target = id || onlyRunningId();
        if (!target) throw new Error(timers.size ? '有多个计时器在运行，请指定 id' : '没有运行中的计时器');
        const info = await backend.MarkTimer(target, String(note || ''));
        if (info && info.id) {
            timers.set(info.id, info); // 回读的 info 带全部标记，详情视图原位刷新
            render();
        }
        flash('已打标记，停止或到点时会随时间线一起发给 AI');
    }

    async function syncFromBackend() {
        const backend = ctx.getBackend();
        if (!backend || typeof backend.ListTimers !== 'function') return;
        try {
            sync(await backend.ListTimers());
        } catch (e) {}
    }

    // onFired 倒计时到点（广播事件，只有持有该会话映射的窗口会触发唤醒）。
    function onFired(info) {
        if (!info || !info.id) return;
        const sessionId = sessions.get(info.id) || '';
        sessions.delete(info.id);
        timers.delete(info.id);
        render();
        if (typeof ctx.onFire === 'function') {
            ctx.onFire(Object.assign({}, info, {sessionId}));
        }
    }

    // onStopped 计时器被停止（本窗口弹层/详情停止 / 另一窗口 / stop_timer 工具）。
    // 返回启动时记录的会话归属（启动窗口才有；归属不明的跨窗计时器返回 ''），
    // ai-panel 据此给绑定会话投递「正计时已停止」的系统消息（AI 感知耗时）。
    function onStopped(info) {
        if (!info || !info.id) return '';
        const owner = sessions.get(info.id) || '';
        sessions.delete(info.id);
        timers.delete(info.id);
        render();
        return owner;
    }

    // 头部胶囊点击开关弹层（chip 是静态 DOM，工厂时接线一次即可）
    const chip = chipEl();
    if (chip && typeof ctx.togglePop === 'function') {
        chip.addEventListener('click', () => ctx.togglePop(chip));
    }

    // render 必须导出：ai-panel 的 switchSession 会调它按目标会话重绘头部胶囊
    // （漏导出会让每次切会话抛 "timerMod.render is not a function"，定时任务跨会话唤醒随之失败）。
    return {start, stop, sync, syncFromBackend, snapshot, onFired, onStopped, render, renderPop, openCreateDialog, closeCreateDialog};
}
