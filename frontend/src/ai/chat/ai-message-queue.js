// ai-message-queue.js：AI 面板消息排队 / 插话 / 抢占（流式生成中 Enter 排队、Ctrl+Enter 插话、
// Ctrl+Shift+Enter 抢占，结束后冲刷）。队列状态机是纯模型（createQueueModel），DOM 壳只做渲染与接线；
// 方案见 docs/finished-plans/ai-turn-steering.md。
import {iconSvg} from '../../core/icons.js';
import {kvGetJson, kvRemove, kvSet} from '../../core/kv-store.js';
import {AI_MSG_QUEUE_KEY} from '../../core/storage-keys.js';
import {createSessionBusyProbe, canStartTurn} from '../session/ai-session-scope.js';
import {AI_QUOTE_KIND, quoteMarkupFromAttachments, groupAttachmentsForTurn} from './ai-quote.js';
import {shouldAnimateLayout, heightKeyframes, LAYOUT_MOTION_OPTIONS} from './ai-layout-motion.js';

// 队列条目 → startSessionTurn 的附件载荷：分组本体在 ai-quote.js 的 groupAttachmentsForTurn
// （手动发送 / 排队冲刷 / 原地编辑三条路共用）。保留这个导出名给测试桩与旧调用方。
export function queuedAttachmentsPayload(attachments) {
    return groupAttachmentsForTurn(attachments);
}

// 插话（steer）请求模板：只作用于发给模型的请求，落盘与气泡仍是用户原文（见 ai-panel.js buildApiMessages）。
// 文案与 ZCode 的 user_steer 对齐——改文案要同步 test/ai/ai-turn-steer-wiring.test.mjs。
export function formatSteerMessage(text) {
    return 'The user sent a new message while you were working:\n' + String(text == null ? '' : text) + '\n\n' +
        'This is a mid-turn message. Address it as you continue your current task, ' +
        'rather than treating it as a separate conversation turn.';
}

// 队列 item id 用字符串：跨端合并按 id 去重（自增数字在两端会撞号）。
let queueItemSeq = 0;
let queueItemOrderSeq = 0;
function nextQueueItemId() {
    queueItemSeq += 1;
    return 'q_' + Date.now() + '_' + queueItemSeq;
}
function nextQueueItemOrder() {
    queueItemOrderSeq += 1;
    return queueItemOrderSeq;
}
function queueItemOrder(item) {
    const seq = Number(item && item.seq);
    return Number.isFinite(seq) && seq > 0 ? seq : 0;
}
function compareQueueItemOrder(a, b) {
    const aSeq = queueItemOrder(a);
    const bSeq = queueItemOrder(b);
    // 新条目用 seq 定序；旧快照没有 seq 时回落 ts，保证旧数据仍可恢复。
    if (aSeq && bSeq) return aSeq - bSeq;
    return (Number(a && a.ts) || 0) - (Number(b && b.ts) || 0);
}

// ---------- 重启恢复（localStorage 轻量快照） ----------
// 队列本体是纯内存，重启即丢。排队消息虽是秒级缓冲，但「被 over_budget 拦下等压缩」
// 「后台会话挂着」的条目可能活很久，丢了用户无从察觉。读写时机：每次队列渲染后全量
// 覆盖（队列变更必然触发渲染，见 renderMessageQueue）；启动读盘完成后恢复一次。
// 局限：多窗口双开时各自恢复同一批条目（队列本就 per-window、互不同步），只有窗口
// 主动消费才会发送，风险面与恢复前一致。

const QUEUE_STORAGE_KEY = AI_MSG_QUEUE_KEY;
// 序列化超过这个体积就整体放弃（恢复后重写同样守它）：localStorage 配额 5MB，快照
// 是尽力而为的兜底，不能反过来把存储撑爆。
const QUEUE_STORAGE_BUDGET = 800 * 1024;

// 图片 / 视频附件的 base64 data 动辄数百 KB~数 MB，不进 localStorage——快照只保留
// 文本类附件；媒体在恢复后会随条目消失，用户重贴即可（消息文本才是条目主体）。
export function persistSafeItem(item) {
    return {
        id: item.id,
        sessionId: item.sessionId,
        text: item.text == null ? '' : String(item.text),
        attachments: (item.attachments || []).filter((att) => att && att.kind !== 'image' && att.kind !== 'video'),
        delivery: item.delivery === 'steer' ? 'steer' : 'queue',
        ts: Number(item.ts) || 0,
        seq: Number(item.seq) || 0,
        roundId: item.roundId || '',
    };
}

// 从快照列表挑出可恢复的条目：剔除失效（无 id / 无会话 / 无正文且无可恢复附件、会话已删除或归档）
// 与内存里已有的（双窗口先后恢复同一批时按 id 去重）。纯函数，便于单测。
export function restorableQueueItems(list, existingIds, sessionLookup) {
    const seen = existingIds instanceof Set ? existingIds : new Set(existingIds || []);
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
        if (!item || !item.id || seen.has(item.id)) continue;
        if (!item.sessionId) continue;
        const hasText = typeof item.text === 'string' && item.text.trim().length > 0;
        const hasRestorableAttachment = Array.isArray(item.attachments) && item.attachments.some(
            (att) => att && att.kind !== 'image' && att.kind !== 'video');
        if (!hasText && !hasRestorableAttachment) continue;
        if (typeof sessionLookup === 'function' && !sessionLookup(item.sessionId)) continue;
        seen.add(item.id);
        out.push(item);
    }
    return out;
}

function copyQueueItem(item) {
    // 快照是跨端同步的同步单元：优先整体深拷贝，附件里可能有嵌套对象（选区行号等）。
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(item);
        } catch (e) {
            // 含不可克隆值（理论上不该有）时退回浅拷贝，至少不把队列本体交出去
        }
    }
    return {...item, attachments: (item.attachments || []).map((att) => ({...att}))};
}

// 纯队列模型（无 DOM / 无 flash 依赖）：单一队列 + delivery 车道（'queue' | 'steer'）。
// 单一队列是为了将来跨端整体同步：item 自带 delivery，合并按 id 去重即可。
export function createQueueModel(options) {
    // onChange：条目入队后的通知钩子（ai-message-queue 用它唤醒 wait_agent 的调用方）。
    // 纯模型本身不认识会话与等待者，钩子由装配方传入，测试不传即空跑。
    const onChange = options && typeof options.onChange === 'function' ? options.onChange : null;
    let items = [];

    function makeItem(payload) {
        return {
            id: nextQueueItemId(),
            sessionId: payload.sessionId,
            text: payload.text == null ? '' : String(payload.text),
            attachments: (payload.attachments || []).slice(),
            delivery: payload.delivery === 'steer' ? 'steer' : 'queue',
            ts: Date.now(),
            seq: nextQueueItemOrder(),
            roundId: payload.roundId || '',
        };
    }

    function enqueue(payload) {
        const item = makeItem(payload || {});
        items.push(item);
        if (onChange) onChange(item);
        return item;
    }

    function enqueueFront(payload) {
        const item = makeItem(payload || {});
        items.unshift(item);
        if (onChange) onChange(item);
        return item;
    }

    function findIndex(itemOrId) {
        const id = itemOrId && typeof itemOrId === 'object' ? itemOrId.id : itemOrId;
        return items.findIndex((item) => item.id === id);
    }

    return {
        enqueue,
        enqueueFront,
        all: () => items.slice(),
        forSession: (sessionId) => items.filter((item) => item.sessionId === sessionId),
        hasItems: () => items.length > 0,
        indexOf: (item) => findIndex(item),
        remove(item) {
            const index = findIndex(item);
            if (index < 0) return false;
            items.splice(index, 1);
            return true;
        },
        insert(index, item) {
            items.splice(Math.max(0, Math.min(index, items.length)), 0, item);
        },
        hasSteer: (sessionId) => items.some((item) => item.sessionId === sessionId && item.delivery === 'steer'),
        // 改投车道：队列行「插话 / 排队」按钮与窗口关闭时的静默降级都走这里（一次同步操作内完成）。
        setDelivery(itemOrId, delivery) {
            const index = findIndex(itemOrId);
            if (index < 0) return false;
            const target = items[index];
            const next = delivery === 'steer' ? 'steer' : 'queue';
            if (target.delivery === next) return false;
            target.delivery = next;
            return true;
        },
        // 队列行拖动排序：只重排目标会话的条目，其它会话的槽位保持不动（flush 按会话取队首）。
        reorderSession(sessionId, orderedIds) {
            const ids = Array.isArray(orderedIds) ? orderedIds : [];
            const slots = [];
            const byId = new Map();
            for (let i = 0; i < items.length; i++) {
                if (items[i].sessionId !== sessionId) continue;
                slots.push(i);
                byId.set(items[i].id, items[i]);
            }
            const ordered = [];
            const seen = new Set();
            for (const id of ids) {
                const item = byId.get(id);
                if (!item || seen.has(id)) continue;
                seen.add(id);
                ordered.push(item);
            }
            // 防御：orderedIds 漏掉的条目按原顺序补在末尾（不丢消息）。
            for (const item of byId.values()) if (!seen.has(item.id)) ordered.push(item);
            if (ordered.length !== slots.length) return false;
            slots.forEach((slot, index) => { items[slot] = ordered[index]; });
            return true;
        },
        // FIFO 取出该会话全部 steer（roundId 只用于诊断，不参与过滤）；取后从队列移除。
        drainSteer(sessionId) {
            const taken = items.filter((item) => item.sessionId === sessionId && item.delivery === 'steer');
            if (!taken.length) return [];
            items = items.filter((item) => !taken.includes(item));
            return taken;
        },
        // drain 后预算超限的回滚：按入队顺序放回同会话队列项之间（保持 FIFO），并改投 queue。
        restoreItems(list, delivery = 'queue') {
            const next = delivery === 'steer' ? 'steer' : 'queue';
            const restored = (list || []).slice();
            if (!restored.length) return;
            for (const item of restored) item.delivery = next;
            const sessionId = restored[0].sessionId;
            // 新条目按 seq 定序，避免同毫秒 ts 相同时误插；旧快照没有 seq 时保持原回落逻辑。
            const useSeq = restored.every((item) => queueItemOrder(item) > 0);
            if (useSeq) restored.sort((a, b) => queueItemOrder(a) - queueItemOrder(b));
            // 逐条归位，不能把整批插到最后一个回滚项之前——否则 q1,steerA,q2,steerB
            // drain 后会变成 q1,q2,steerA,steerB，破坏原始交错顺序。
            for (const item of restored) {
                let insertAt = items.length;
                for (let i = 0; i < items.length; i++) {
                    if (items[i].sessionId !== sessionId) continue;
                    const existingSeq = queueItemOrder(items[i]);
                    const later = useSeq && existingSeq > 0
                        ? existingSeq > queueItemOrder(item)
                        : (Number(items[i].ts) || 0) > (Number(item.ts) || 0);
                    if (later) {
                        insertAt = i;
                        break;
                    }
                }
                items.splice(insertAt, 0, item);
            }
        },
        fallbackSteerToQueue(sessionId) {
            let changed = false;
            for (const item of items) {
                if (item.sessionId === sessionId && item.delivery === 'steer') {
                    item.delivery = 'queue';
                    changed = true;
                }
            }
            return changed;
        },
        clearSteer(sessionId) {
            const dropped = items.filter((item) => item.sessionId === sessionId && item.delivery === 'steer');
            if (!dropped.length) return [];
            items = items.filter((item) => !dropped.includes(item));
            return dropped;
        },
        clearForSession(sessionId) {
            items = items.filter((item) => item.sessionId !== sessionId);
        },
        clearAll() {
            items = [];
        },
        // 重启恢复：原样收回快照条目（保留原 id / ts / delivery / roundId）。不触发
        // onChange——恢复的旧条目不该去唤醒 wait_agent。调用方负责去重与失效过滤。
        restore(restored) {
            const list = (Array.isArray(restored) ? restored : []).filter((item) => item && item.id && item.sessionId);
            if (!list.length) return false;
            // 新快照带 seq，恢复时按 seq 排序；旧快照没有 seq 时保留原数组顺序，避免破坏旧数据。
            const ordered = list.every((item) => queueItemOrder(item) > 0)
                ? list.slice().sort(compareQueueItemOrder)
                : list;
            for (const item of ordered) {
                items.push(item);
                queueItemOrderSeq = Math.max(queueItemOrderSeq, queueItemOrder(item));
            }
            return true;
        },
        // 跨端同步快照（深拷贝：改快照不影响队列本体）。
        snapshot: (sessionId) => ({
            sessionId,
            items: items.filter((item) => item.sessionId === sessionId).map(copyQueueItem),
        }),
    };
}

export function createAIMessageQueue(ctx) {
    const el = ctx.el;
    // 队列所有权在本模块（阶段 A 迁移）：panel / composer / 设置页一律经下面这组 API 访问，
    // 不再各自持有数组引用——历史上所有权在 panel、flush 调用点散布在三处，容易漏刷。
    // 入队即唤醒 wait_agent 的调用方：主代理可能在等「用户插话 / 排队消息」。
    // 只唤醒不注入——真正注入仍在轮边界（flushMessageQueue / steer 边界），
    // 在工具调用中间插消息会破坏轮次模型。
    const model = createQueueModel({
        onChange: (item) => {
            // 只有插话（steer）唤醒 wait_agent：排队消息（queue）不打扰等待——它按排队
            // 语义在本轮结束后由 flushMessageQueue 送达，唤醒只会让等待白醒一轮
            //（注入仍只在轮边界，wait 拿不到排队消息的内容）。来源随 notify 带回，
            // 供 waitForInbox 按来源分文案。
            const waiter = ctx.inboxWaiters;
            if (waiter && typeof waiter.notify === 'function' && item && item.sessionId
                && item.delivery === 'steer') {
                waiter.notify(item.sessionId, 'steer');
            }
        },
    });
    const interjectPending = new Set();  // sessionId：该会话有一条「抢占」消息待优先发送
    const flushingSessions = new Set();  // sessionId：该会话正在冲刷，重入直接返回，避免并发取队首
    let draggingQueueId = '';            // 队列行拖动排序中的 item id（仅本模块内使用）
    let queueHeightAnim = null;          // 当前队列高度补间动画：新渲染先 cancel 旧的，避免状态竞态
    const streams = ctx.streams;
    const flash = ctx.flash;
    const notifyFailure = typeof ctx.notifyFailure === 'function' ? ctx.notifyFailure : () => {};
    const positionOverlays = ctx.positionOverlays;
    const compactOf = ctx.compactOf;
    const currentSession = ctx.currentSession;
    const syncStreamView = ctx.syncStreamView;
    const currentQueueItems = ctx.currentQueueItems;
    const planApprovalMessage = ctx.planApprovalMessage;
    const planApprovalKey = ctx.planApprovalKey;
    const planAwaitingUserReply = typeof ctx.planAwaitingUserReply === 'function'
        ? ctx.planAwaitingUserReply : () => true;
    const updateComposerTakeover = ctx.updateComposerTakeover;
    const editQueuedMessage = ctx.editQueuedMessage;
    const captureComposerMessage = ctx.captureComposerMessage;
    const handleSlashText = ctx.handleSlashText;
    const stopGeneration = ctx.stopGeneration;
    const currentPendingAskEntry = ctx.currentPendingAskEntry;
    const getAttachments = ctx.getAttachments;
    const getDismissedPlanApproval = ctx.getDismissedPlanApproval;
    const setDismissedPlanApproval = ctx.setDismissedPlanApproval;
    const getStream = ctx.getStream;
    const videoSteerAllowed = ctx.videoSteerAllowed;
    // 起轮依赖（所有会话共用一条路径）：会话查询 / 内核起轮 / 未读标记 / 失败文案。
    // 旧调用方（测试桩）没传 startSessionTurn 时降级为「不发送、留队」。
    const sessionById = typeof ctx.sessionById === 'function' ? ctx.sessionById : null;
    const startSessionTurn = typeof ctx.startSessionTurn === 'function' ? ctx.startSessionTurn : null;
    const setSessionUnread = typeof ctx.setSessionUnread === 'function' ? ctx.setSessionUnread : null;
    // 失败文案单一来源在 panel（turnStartFailureText），queued=true 时它负责「留在队列」措辞；
    // 队列侧不另写一套 reason → 人话映射。
    const describeTurnFailure = typeof ctx.describeTurnFailure === 'function' ? ctx.describeTurnFailure : null;
    // 内核预检拦下（over_budget）时的兜底钩子：panel 注入 maybeAutoCompact，
    // 让「队列消息塞不下」也能自动腾地方（与手动路径 autoCompactOnGateBlocked 对称）。
    const onQueueOverBudget = typeof ctx.onQueueOverBudget === 'function' ? ctx.onQueueOverBudget : null;

    // 会话查询：显式 id 优先；没注入 sessionById 时退回 currentSession（单会话测试桩）。
    function sessionOf(sessionId) {
        if (!sessionId) return null;
        if (sessionById) return sessionById(sessionId) || null;
        const cur = typeof currentSession === 'function' ? currentSession() : null;
        return cur && cur.id === sessionId ? cur : null;
    }

    // 会话是否忙（生成中 / 压缩中）：队列一律等服务。判定本体在 ai-session-scope.js
    // （与面板、子代理信箱、起轮内核同一口径），这里只注入 streams / compactOf。
    const sessionBusy = createSessionBusyProbe({streams, compactOf});

    // 当前查看会话的流是否还能接受 steer：已停止 / 已收尾的流不再收——stopGeneration 后
    // 最多 1.2s 内 streams 仍登记着它，此时入队 steer 会被 finishStream 的 clearSteer 丢掉。
    function liveSteerableStream(sessionId) {
        const live = getStream();
        if (!live || live.sessionId !== sessionId) return null;
        if (live.stopped || live.finished) return null;
        return live;
    }

    // 拖动排序：对齐标签页的 JetBrains 式让位——目标位置让出一条插槽（margin 过渡），
    // 不画描边 / 插入线。
    function clearQueueDropGaps() {
        if (!el.queue) return;
        for (const row of el.queue.querySelectorAll('.drop-gap-before, .drop-gap-after')) {
            row.classList.remove('drop-gap-before', 'drop-gap-after');
        }
    }

    // 把拖动项放到目标项之前 / 之后（只重排当前会话，其它会话槽位不动）。
    function reorderQueueItem(draggedId, targetId, after) {
        if (!draggedId || !targetId || draggedId === targetId) return;
        const session = currentSession();
        if (!session) return;
        const ids = model.forSession(session.id).map((item) => item.id);
        const from = ids.indexOf(draggedId);
        if (from < 0) return;
        ids.splice(from, 1);
        let to = ids.indexOf(targetId);
        if (to < 0) return;
        if (after) to += 1;
        ids.splice(to, 0, draggedId);
        if (model.reorderSession(session.id, ids)) renderMessageQueue();
    }

    // 队列快照写盘：渲染后全量覆盖（清空 / 移除等不一定走渲染的变更点在 API 层单独挂）。
    // 超预算 / 存储不可用时清键放弃——快照是尽力而为的兜底，不能反过来撑爆 localStorage。
    function persistQueueSnapshot() {
        let payload;
        try {
            payload = JSON.stringify(model.all().map(persistSafeItem));
        } catch (e) {
            return; // 尽力而为路径：条目里出现无法序列化的字段就放弃这次快照，不影响内存队列
        }
        if (!payload || payload.length > QUEUE_STORAGE_BUDGET) {
            kvRemove(QUEUE_STORAGE_KEY);
            return;
        }
        kvSet(QUEUE_STORAGE_KEY, payload);
    }

    // 启动恢复：读盘完成后调用一次（sessionLookup 校验会话还在且未归档，返回会话或空值）。
    // 恢复后立刻回写一次快照，把失效条目从存储里清掉。
    function restorePersistedQueue(sessionLookup) {
        const list = kvGetJson(QUEUE_STORAGE_KEY, []);
        if (!Array.isArray(list)) return 0;
        const existing = new Set(model.all().map((item) => item.id));
        const restored = restorableQueueItems(list, existing, sessionLookup);
        if (!model.restore(restored)) return 0;
        persistQueueSnapshot();
        renderMessageQueue();
        return restored.length;
    }

    function renderMessageQueue() {
        if (!el.queue) return;
        // 重绘会换掉行 DOM：进行中的拖动直接作废，避免 dragend 丢失后留下过期的拖动 id。
        draggingQueueId = '';
        syncStreamView();
        const items = currentQueueItems();
        const session = currentSession();
        const plan = session ? planApprovalMessage(session) : null;
        const planKey = plan ? planApprovalKey(session, plan) : '';
        // 横条只在「用户点了继续规划、但还没发出修订消息」时作为回到审批卡的入口出现。
        // 用户一旦发言（ts 晚于计划提交），说明已在继续规划，横条收起，不再反复提示批准。
        const showPlanReminder = !!(plan && getDismissedPlanApproval() === planKey &&
            planAwaitingUserReply(session));
        // 队列高度补间：记录旧高度，重建后对比——增减/清空时给容器补一段收缩/展开，
        // 动画期间逐帧 positionOverlays() 让消息区 padding 跟着平滑变化（面板不再瞬间缩一截）。
        const wasHidden = el.queue.classList.contains('hidden');
        const oldHeight = wasHidden ? 0 : el.queue.getBoundingClientRect().height;
        el.queue.innerHTML = '';
        el.queue.classList.toggle('hidden', !items.length && !showPlanReminder);
        if (showPlanReminder) {
            const row = document.createElement('div');
            row.className = 'ai-queue-row ai-plan-reminder';
            const badge = document.createElement('span');
            badge.className = 'ai-queue-badge';
            badge.textContent = '计划';
            const text = document.createElement('span');
            text.className = 'ai-queue-text';
            text.textContent = '计划等待批准';
            const view = document.createElement('button');
            view.type = 'button';
            view.className = 'ai-queue-action';
            view.textContent = '查看';
            view.addEventListener('click', () => {
                setDismissedPlanApproval('');
                updateComposerTakeover(true);
                renderMessageQueue();
            });
            row.append(badge, text, view);
            el.queue.appendChild(row);
        }
        for (const item of items) {
            const row = document.createElement('div');
            row.className = 'ai-queue-row';
            // 拖动排序手柄（3×3 点阵）：只让手柄可拖，行内按钮仍可正常点击。
            const handle = document.createElement('span');
            handle.className = 'ai-queue-drag';
            handle.draggable = true;
            handle.dataset.tip = '拖动排序：调整排队消息的发送顺序';
            handle.setAttribute('aria-label', '拖动排序');
            handle.innerHTML = iconSvg('grip', 12);
            handle.addEventListener('dragstart', (e) => {
                if (!e.dataTransfer) return;
                draggingQueueId = item.id;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', item.id);
                try { e.dataTransfer.setDragImage(row, 12, 12); } catch (err) { /* 拖动预览失败不影响排序 */ }
                row.classList.add('dragging');
            });
            handle.addEventListener('dragend', () => {
                draggingQueueId = '';
                row.classList.remove('dragging');
                clearQueueDropGaps();
            });
            row.dataset.queueId = item.id;
            row.addEventListener('dragover', (e) => {
                if (!draggingQueueId || row.dataset.queueId === draggingQueueId) return;
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                const rect = row.getBoundingClientRect();
                const before = e.clientY < rect.top + rect.height / 2;
                clearQueueDropGaps();
                if (before) {
                    row.classList.add('drop-gap-before');
                } else {
                    const next = row.nextElementSibling;
                    // 向下拖时让下一行让位，插槽始终出现在「将要插入的位置」
                    if (next && next.classList.contains('ai-queue-row') && next.dataset.queueId) {
                        next.classList.add('drop-gap-before');
                    } else {
                        row.classList.add('drop-gap-after');
                    }
                }
            });
            row.addEventListener('drop', (e) => {
                if (!draggingQueueId) return;
                e.preventDefault();
                const rect = row.getBoundingClientRect();
                const before = e.clientY < rect.top + rect.height / 2;
                const draggedId = draggingQueueId;
                draggingQueueId = '';
                clearQueueDropGaps();
                if (draggedId !== row.dataset.queueId) reorderQueueItem(draggedId, row.dataset.queueId, !before);
            });
            const steering = item.delivery === 'steer';
            const badge = document.createElement('span');
            badge.className = 'ai-queue-badge';
            // 两条车道用不同颜色：排队=蓝（accent），插话=琥珀（warn）
            badge.classList.toggle('is-steer', steering);
            badge.textContent = steering ? '插话' : '排队';
            const text = document.createElement('span');
            text.className = 'ai-queue-text';
            const imageCount = (item.attachments || []).filter((att) => att.kind === 'image').length;
            const attachCount = (item.attachments || []).filter((att) => att.kind !== 'image').length;
            const meta = [];
            if (imageCount) meta.push(imageCount + ' 张图片');
            if (attachCount) meta.push(attachCount + ' 个附件');
            text.textContent = (item.text || '（无文字）') + (meta.length ? ' · ' + meta.join(' · ') : '');
            const edit = document.createElement('button');
            edit.type = 'button';
            edit.className = 'ai-queue-action ai-queue-icon';
            edit.innerHTML = iconSvg('rename', 11);
            edit.dataset.tip = '编辑：取回输入区重新编辑，附件一并带回';
            edit.setAttribute('aria-label', '编辑排队消息');
            edit.addEventListener('click', () => editQueuedMessage(item));
            const interject = document.createElement('button');
            interject.type = 'button';
            interject.className = 'ai-queue-action';
            interject.textContent = steering ? '排队' : '插话';
            interject.dataset.tip = steering
                ? '撤回插话，改回当前轮结束后发送'
                : '在当前轮的下一个工具边界注入，不打断当前工作';
            interject.addEventListener('click', () => {
                if (steering) {
                    if (model.setDelivery(item, 'queue')) {
                        renderMessageQueue();
                        flash('已改回排队：本轮结束后发送');
                    }
                    return;
                }
                // 不可 steer 的状态（压缩中）静默保持排队；轮已结束则按普通发送冲刷。
                if (compactOf(item.sessionId)) {
                    flash('正在压缩上下文，消息保持排队');
                    return;
                }
                if (!streams.has(item.sessionId)) {
                    flushMessageQueue(item.sessionId);
                    return;
                }
                if (!liveSteerableStream(item.sessionId)) {
                    // 停止 / 收尾窗口：改投 steer 必被清掉，保持排队并登记待冲刷。
                    interjectPending.add(item.sessionId);
                    flash('当前轮正在停止，消息将随后发送');
                    return;
                }
                if (model.setDelivery(item, 'steer')) {
                    renderMessageQueue();
                    flash('已改为插话：将在下一个工具边界生效');
                }
            });
            const preempt = document.createElement('button');
            preempt.type = 'button';
            preempt.className = 'ai-queue-action ai-queue-icon';
            preempt.innerHTML = iconSvg('zap', 11);
            preempt.dataset.tip = '抢占：停止当前回复并立即发送这条消息';
            preempt.setAttribute('aria-label', '抢占发送');
            // 只有当前轮还活着（含停止收尾窗口）时才有抢占语义；空闲时队列会自行冲刷。
            if (streams.has(item.sessionId)) preempt.addEventListener('click', () => preemptQueuedItem(item));
            else preempt.classList.add('hidden');
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'ai-queue-action';
            remove.textContent = '×';
            remove.dataset.tip = '移除这条排队消息';
            remove.addEventListener('click', () => {
                model.remove(item);
                renderMessageQueue();
            });
            row.append(handle, badge, text, edit, interject, preempt, remove);
            el.queue.appendChild(row);
        }
        if (el.hint) {
            if (getStream()) {
                const steerCount = items.filter((item) => item.delivery === 'steer').length;
                const queueCount = items.length - steerCount;
                if (!items.length) {
                    el.hint.textContent = '生成中';
                } else {
                    const parts = [];
                    if (queueCount) parts.push('排队 ' + queueCount + ' 条');
                    if (steerCount) parts.push('插话 ' + steerCount + ' 条');
                    el.hint.textContent = '已' + parts.join(' · ');
                }
            } else if (items.length && compactOf((currentSession() || {}).id)) {
                // 压缩中不覆盖「正在压缩上下文…」，只补排队条数
                el.hint.textContent = '正在压缩上下文 · 已排队 ' + items.length + ' 条';
            }
        }
        positionOverlays();
        // 队列增减/清空的收缩/展开动画。display:none 无法做高度动画，所以清空（新态 hidden）
        // 时先临时撤掉 hidden、从旧高度收到 0，结束后再补回；出现（旧态 hidden）时从 0 展开到新高度。
        const nowHidden = el.queue.classList.contains('hidden');
        const newHeight = nowHidden ? 0 : el.queue.getBoundingClientRect().height;
        const reduce = !!(typeof window !== 'undefined' && window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        const canAnimate = typeof el.queue.animate === 'function';
        if (shouldAnimateLayout(oldHeight, newHeight, reduce, canAnimate)) {
            if (nowHidden) el.queue.classList.remove('hidden');
            // 新动画来了先取消旧的：cancel 会触发旧 finish，把 hidden 状态按旧目标收口——
            // 随后新动画按新目标重建，最终状态以最后一次渲染为准。
            if (queueHeightAnim) queueHeightAnim.cancel();
            const anim = el.queue.animate(heightKeyframes(oldHeight, newHeight), LAYOUT_MOTION_OPTIONS);
            queueHeightAnim = anim;
            const finish = () => {
                const stale = queueHeightAnim !== anim;
                if (!stale) queueHeightAnim = null;
                // cancel 事件是异步排队的：闭包里的 nowHidden 可能已经过期
                //（期间删空又快速入队）。只有「仍是当前动画」且「此刻队列真的为空」
                // 才补 hidden，否则会把有消息的队列一起藏掉。
                if (nowHidden && !stale && !el.queue.querySelector('[data-queue-id]')) {
                    el.queue.classList.add('hidden');
                }
                positionOverlays();
            };
            anim.addEventListener('finish', finish, {once: true});
            anim.addEventListener('cancel', finish, {once: true});
            // height 参与布局、逐帧改变堆叠区高度：贴底态逐帧补底，padding 平滑跟随。
            const follow = () => {
                if (anim.playState === 'finished' || anim.playState === 'idle') return;
                positionOverlays();
                requestAnimationFrame(follow);
            };
            requestAnimationFrame(follow);
        }
        persistQueueSnapshot();
    }

    // opts.plain：跳过「/ 开头转斜杠命令」检查——斜杠技能调用（sendComposerMessage）的
    // 文本本身以 / 开头但已是待发消息，再转 handleSlashText 会死循环。
    function enqueueComposerMessage(opts) {
        if (!syncStreamView() && !compactOf((currentSession() || {}).id)) return false;
        const text = el.input ? String(el.input.value || '').trim() : '';
        if (!(opts && opts.plain) && text.startsWith('/')) {
            handleSlashText(text);
            return true;
        }
        const payload = captureComposerMessage();
        if (!payload) return false;
        // 停止收尾窗口（流还登记着但已 stopped/finished）：本轮收尾的 shouldFlush 只认
        // interjectPending，不登记的话这条排队消息会滞留到下次切换会话才有机会发出。
        const session = currentSession();
        if (session && !liveSteerableStream(session.id)) interjectPending.add(session.id);
        const item = model.enqueue(payload);
        renderMessageQueue();
        flash('已加入排队：' + (item.text ? item.text.slice(0, 24) : '图片'));
        return true;
    }

    // 插话（steer）：不打断当前轮，条目以 delivery:'steer' 留在队列，下一个工具边界注入。
    // 压缩中 / 空闲 / 带文件类附件时静默降级为排队（不报错，见方案 §4.5）。
    function interjectComposerMessage(opts) {
        const session = currentSession();
        if (!session) return;
        const text = el.input ? String(el.input.value || '').trim() : '';
        if (!(opts && opts.plain) && text.startsWith('/')) {
            handleSlashText(text);
            return;
        }
        const payload = captureComposerMessage();
        if (!payload) return;
        if (compactOf(session.id)) {
            model.enqueue(payload);
            renderMessageQueue();
            flash('正在压缩上下文，消息已排队');
            return;
        }
        if (!streams.has(session.id)) {
            model.enqueue(payload);
            renderMessageQueue();
            flushMessageQueue(session.id);
            return;
        }
        const live = liveSteerableStream(session.id);
        if (!live) {
            // 停止 / 收尾窗口（stopGeneration 已置 stopped、finishStream 还没跑）：此时入队
            // steer 会被收尾的 clearSteer 丢弃，降级为排队并登记待冲刷，消息不丢。
            model.enqueue(payload);
            interjectPending.add(session.id);
            renderMessageQueue();
            flash('当前轮已停止，消息将在收尾后发送');
            return;
        }
        // 第一版 steer 只支持文字 + 引用 markup + 图片/视频：文件 / 技能 / 选区附件
        // 需要在轮中重组 <attachments> 环境块，直接按排队处理。
        const unsupported = (payload.attachments || []).some((att) =>
            att.kind !== 'image' && att.kind !== 'video' && att.kind !== AI_QUOTE_KIND);
        if (unsupported) {
            model.enqueue(payload);
            renderMessageQueue();
            flash('文件附件将随下一轮发送：已排队');
            return;
        }
        // 视频 steer 与正常发送走同一条协议门禁：否则历史里会留下一条每轮请求都被拒收的视频消息。
        const hasVideo = (payload.attachments || []).some((att) => att.kind === 'video');
        if (hasVideo && !videoSteerAllowed(session)) {
            model.enqueue(payload);
            renderMessageQueue();
            flash('当前模型或协议不支持视频输入：已改为排队，请换模型或移除视频', true);
            return;
        }
        model.enqueue({...payload, delivery: 'steer', roundId: live.roundId || ''});
        renderMessageQueue();
        flash('已插话：将在下一个工具边界生效');
    }

    // 抢占 = 立即发出这条消息：待批准的计划卡收起让路（只改显示、计划保持 pending，
    // 队列上方出现「计划等待批准 · 查看」入口，随时可回到批准卡）。流式期间卡片本就
    // 不显示（planApprovalMessage 对未注销的流返回 null），这里覆盖「轮已空闲、卡正
    // 显示」的直冲刷分支；收尾竞态由 ai-panel.js finishStream 的同款收起兜底。
    function dismissPendingPlanCard(session) {
        if (!session || typeof planApprovalMessage !== 'function' ||
            typeof getDismissedPlanApproval !== 'function' || typeof setDismissedPlanApproval !== 'function') return;
        const plan = planApprovalMessage(session);
        if (!plan) return;
        const key = typeof planApprovalKey === 'function' ? planApprovalKey(session, plan) : '';
        if (!key || getDismissedPlanApproval() === key) return;
        setDismissedPlanApproval(key);
        if (typeof updateComposerTakeover === 'function') updateComposerTakeover(true);
    }

    // 抢占（preempt）：停掉当前轮，消息作为普通用户消息开新一轮（原「插话」语义）。
    function preemptComposerMessage(opts) {
        const session = currentSession();
        if (!session) return;
        const text = el.input ? String(el.input.value || '').trim() : '';
        if (!(opts && opts.plain) && text.startsWith('/')) {
            handleSlashText(text);
            return;
        }
        const payload = captureComposerMessage();
        if (!payload) return;
        // 轮已空闲且计划卡正显示时先收起让路；流式 / 收尾窗口交给 finishStream 兜底
        dismissPendingPlanCard(session);
        if (compactOf(session.id)) {
            model.enqueue(payload);
            renderMessageQueue();
            flash('正在压缩上下文，消息已排队');
            return;
        }
        if (!streams.has(session.id)) {
            model.enqueue(payload);
            renderMessageQueue();
            flushMessageQueue(session.id);
            return;
        }
        if (!liveSteerableStream(session.id)) {
            // 已在停止 / 收尾：不再重复 stopGeneration，消息插到队首由收尾冲刷。
            // 收尾的 finishStream 会 clearSteer，先把其它 steer 降级保留，避免连带丢失。
            model.fallbackSteerToQueue(session.id);
            model.enqueueFront(payload);
            interjectPending.add(session.id);
            renderMessageQueue();
            flash('当前轮正在停止，消息将随后发送');
            return;
        }
        // stopGeneration 会 clearSteer 丢弃本会话所有 steer：先把其它 steer 降级为 queue
        // 保留（本条 payload 是 queue，不受影响），它们会在本条发出后按 FIFO 依次冲刷。
        model.fallbackSteerToQueue(session.id);
        model.enqueueFront(payload);
        renderMessageQueue();
        flash('已抢占：正在停止当前回复…');
        interjectPending.add(session.id);
        stopGeneration();
    }

    // 队列行「抢占」：停掉当前轮，把这条消息作为普通用户消息立即发送（原「插话」语义）。
    // 行内已有编辑 / 改投 / 删除三个文字动作，这里用 ⚡ 图标 + tooltip，避免把行挤爆。
    function preemptQueuedItem(item) {
        const sessionId = item.sessionId;
        if (compactOf(sessionId)) {
            flash('正在压缩上下文，消息保持排队');
            return;
        }
        // 轮已空闲且计划卡正显示时先收起让路（后续直冲刷分支才不会被计划守卫静默拦下）
        dismissPendingPlanCard(sessionOf(sessionId));
        const index = model.indexOf(item);
        if (index < 0) return;
        model.setDelivery(item, 'queue');
        // 抢占 = 让这一条立即发出，其它消息必须保留。stopGeneration / finishStream 会
        // clearSteer 丢弃本会话所有 steer，所以提前把「除本条外」的 steer 降级为 queue
        //（本条已 setDelivery 成 queue，不受影响）——clearSteer 清不到它们，它们会在本条
        // 发出后按 FIFO 依次冲刷。否则用户排队的多条插话会随抢占一起消失（2026-11-22 实测）。
        model.fallbackSteerToQueue(sessionId);
        model.remove(item);
        model.insert(0, item);
        interjectPending.add(sessionId);
        renderMessageQueue();
        if (liveSteerableStream(sessionId)) {
            flash('已抢占：正在停止当前回复…');
            stopGeneration();
            return;
        }
        if (streams.has(sessionId)) {
            // 已在停止 / 收尾窗口：交给 finishStream 的 shouldFlush 冲刷。
            flash('当前轮正在停止，消息将随后发送');
            return;
        }
        flushMessageQueue(sessionId);
    }

    // 取项（纯守卫，不碰 UI）：返回 {session, item} 并把条目从队列摘掉；不满足条件返回 null。
    // 后台会话与当前会话共用这一套守卫——输入区草稿保护只对「用户正看着的那个输入区」有意义。
    function takeQueuedItem(sessionId) {
        if (!sessionId || sessionBusy(sessionId)) return null;
        const session = sessionOf(sessionId);
        if (!session) return null;
        // 归档 / 正文读取失败与起轮内核同一判定（canStartTurn）：改造前这里只判归档，
        // _loadError 的会话会把条目取走再被内核拒收，然后每 2.5s 自愈重试一次（永远发不出去）。
        // _stub 刻意不算拦截理由：正文还没读上来时内核会先 ensureSessionLoaded，
        // 「投递到没点开过的会话」正是靠这条路径工作的。
        if (!canStartTurn(session, {busy: false}).ok) return null;
        // 待回答：输入区被接管卡占着，队列不动（与手动发送同一口径）
        if (typeof currentPendingAskEntry === 'function' && currentPendingAskEntry(sessionId)) return null;
        // 计划待批准只在审批卡「正显示」时拦队列：被「继续规划」或抢占收起后输入区已空闲、
        // 手动发送可行，冲刷同一口径放行——否则 pending 计划会把队列永远钉住（2026-11-22
        // plan 模式抢占实测：抢占消息变成排队后发不出去）。
        const pendingPlan = typeof planApprovalMessage === 'function' ? planApprovalMessage(session) : null;
        if (pendingPlan && typeof planApprovalKey === 'function' &&
            typeof getDismissedPlanApproval === 'function' &&
            getDismissedPlanApproval() !== planApprovalKey(session, pendingPlan)) return null;
        const item = model.forSession(sessionId)[0];
        if (!item) return null;
        const viewing = typeof currentSession === 'function' ? currentSession() : null;
        if (viewing && viewing.id === sessionId &&
            ((el.input && el.input.value.trim()) || getAttachments().length)) return null;
        model.remove(item);
        renderMessageQueue();
        return {session, item};
    }

    // 失败回插：放到该会话的队首（其它会话的条目位置不受影响）。
    function restoreQueuedItem(session, item) {
        const all = model.all();
        let at = all.length;
        for (let i = 0; i < all.length; i++) {
            if (all[i].sessionId === session.id) {
                at = i;
                break;
            }
        }
        model.insert(at, item);
        renderMessageQueue();
    }

    // 起轮失败多为瞬态（回合租约释放 / 写盘排空的时序差）：延 2.5s 自愈重试一次。
    // 既有守卫（忙 / 草稿 / 接管卡）让重试天然防重入；持续失败由下一次自然触发点兜底。
    function scheduleFlushRetry(sessionId, opts) {
        if (opts && opts.fromRetry) return;
        setTimeout(() => { flushMessageQueue(sessionId, {fromRetry: true}); }, 2500);
    }

    // 排队项 → 内核起轮：**所有会话只有这一条发送路径**（当前会话与后台会话完全等价）。
    // 历史上这里分两条：当前会话先把文字灌回输入区再 submitText 代发，后台会话直接起轮
    // （方案 A，2026-11-19）。代发没提供任何发送语义——视图渲染在内核里按 viewed 判定
    // （ai-panel.js startSessionTurnInner），它只多做了「写 UI → 发 → 自己擦掉」的自偿还，
    // 并留下「await 窗口里切走会话 → 文字留在别的会话输入框」的隐患。已按方案 B 统一，
    // 依据 docs/finished-plans/ai-queue-background-flush.md §4.2 / §10。
    async function dispatchQueuedItem(session, item, opts) {
        if (!startSessionTurn) {
            // 没接内核（测试桩 / 旧装配）：不发送也不丢，留队等下次触发
            restoreQueuedItem(session, item);
            return;
        }
        // 引用前缀与附件载荷和手动发送同一口径：引用已进正文，不能再当附件送一遍。
        const quoteMarkup = quoteMarkupFromAttachments(item.attachments || []);
        let text = String(item.text || '');
        if (quoteMarkup) text = text ? quoteMarkup + '\n\n' + text : quoteMarkup;
        let result = null;
        try {
            result = await startSessionTurn(session, text, {
                attachments: queuedAttachmentsPayload(item.attachments),
                // 冲刷不是用户主动发送：绝不拿它去截断用户正在原地编辑的那条（§5 唤醒防护）
                allowPendingEdit: false,
                truncateAt: null,
                preserveScroll: true,
            });
        } catch (e) {
            result = {ok: false, reason: 'error', error: (e && e.message) || String(e)};
        }
        if (result && result.ok === true) return;
        restoreQueuedItem(session, item);
        if (result && result.reason === 'over_budget' && onQueueOverBudget) {
            // 消息塞不下：兜底触发一次自动压缩腾地方。消息已退回队列，压缩完成后
            // flushMessageQueue 会自动重发（panel 侧压缩完成路径已有冲刷，闭环不丢消息）。
            onQueueOverBudget(session);
        }
        reportFlushFailure(session, result);
        // 失败都排一次重试（fromRetry 防无限打转）：busy 是流注册 / 压缩的时序差，
        // 其余是租约 / 写盘的瞬态失败，2.5s 后一次自愈窗口足够。
        scheduleFlushRetry(session.id, opts);
    }

    // 发送失败要让用户看得见：状态栏一句话 + 会话未读标记（内容仍留在队列，不丢）。
    // 文案由 panel 的 describeTurnFailure 给（与手动发送同一张表），队列侧不再另维护一份。
    function reportFlushFailure(session, result) {
        const reason = (result && result.reason) || 'error';
        if (reason === 'busy') return; // 纯时序差：不打扰用户，等重试
        const detail = (describeTurnFailure ? describeTurnFailure(result, session) : '')
            || '排队消息未能发出（' + reason + '），已留在队列';
        flash(detail, true);
        // B 级：排队消息没发出去，用户不看状态栏就会漏掉（内容仍在队列，不丢）。
        notifyFailure('排队消息未发送', detail, {key: 'queue-flush-' + reason, kind: 'error', sessionId: session.id});
        if (setSessionUnread) setSessionUnread(session, 'done');
    }

    // 冲刷排队消息（一轮一条，队首优先）：取项 → 内核起轮，没有第二套发送路径。
    // opts.fromRetry：失败自动重试的那次调用——防止重试自身失败后再排下一次。
    async function flushMessageQueue(sessionId, opts) {
        if (!sessionId || flushingSessions.has(sessionId)) return;
        flushingSessions.add(sessionId);
        try {
            const taken = takeQueuedItem(sessionId);
            if (!taken) return;
            return await dispatchQueuedItem(taken.session, taken.item, opts);
        } finally {
            flushingSessions.delete(sessionId);
        }
    }


    function clearQueueForSession(sessionId) {
        model.clearForSession(sessionId);
        interjectPending.delete(sessionId);
        renderMessageQueue();
    }
    // ---- 队列所有权 API（供 panel / composer / 设置页消费；不暴露可变数组本体）----
    function items() {
        return model.all();
    }

    function itemsForSession(sessionId) {
        return model.forSession(sessionId);
    }

    function hasItems() {
        return model.hasItems();
    }

    function indexOfItem(item) {
        return model.indexOf(item);
    }

    function removeItem(item) {
        const ok = model.remove(item);
        if (ok) persistQueueSnapshot();
        return ok;
    }

    function insertItem(index, item) {
        model.insert(index, item);
        persistQueueSnapshot();
    }

    function clearAll() {
        model.clearAll();
        interjectPending.clear();
        persistQueueSnapshot();
    }

    function hasInterject(sessionId) {
        return interjectPending.has(sessionId);
    }

    function addInterject(sessionId) {
        interjectPending.add(sessionId);
    }

    function clearInterject(sessionId) {
        interjectPending.delete(sessionId);
    }

    return {
        renderMessageQueue,
        restorePersistedQueue,
        enqueueComposerMessage,
        interjectComposerMessage,
        preemptComposerMessage,
        preemptQueuedItem,
        flushMessageQueue,
        clearQueueForSession,
        items,
        itemsForSession,
        hasItems,
        enqueueItem: (payload) => model.enqueue(payload),
        indexOfItem,
        removeItem,
        insertItem,
        clearAll,
        hasInterject,
        addInterject,
        clearInterject,
        // steer 车道（ai-panel.js 轮边界 drain / 收尾兜底；第二期跨端同步从这里接）
        hasSteer: (sessionId) => model.hasSteer(sessionId),
        drainSteer: (sessionId) => model.drainSteer(sessionId),
        restoreItems: (list, delivery) => model.restoreItems(list, delivery),
        setDelivery: (item, delivery) => model.setDelivery(item, delivery),
        reorderSession: (sessionId, ids) => model.reorderSession(sessionId, ids),
        fallbackSteerToQueue: (sessionId) => model.fallbackSteerToQueue(sessionId),
        clearSteer: (sessionId) => model.clearSteer(sessionId),
        snapshot: (sessionId) => model.snapshot(sessionId),
    };
}
