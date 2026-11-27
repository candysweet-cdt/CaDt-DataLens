// ai-group-view.js：群聊视图（G6 面板化）——挂进 AI 面板的 #ai-group-host，
// QQ/微信群式气泡 + 贴底滚动 + @ 补全 + 看板覆盖层 + 讨论控制收敛。
// 状态来自 runtime（subscribe + groupById / activeStreamOf / discussionSnapshot）；DOM 只做渲染。
// 面板切换视图时 dispose（退订/清 timer/摘除文档级监听）；群讨论在 runtime 里继续跑。
import {createInput, createTextarea} from '../../core/form-controls.js';
import {el} from '../../core/dom.js';
import {iconSvg} from '../../core/icons.js';
import {renderEmptyState} from '../../core/empty-state.js';
import {STANCE_LABELS, stripHandoffMarker} from './ai-group-model.js';
import {
    buildRichHtml,
    dateLabel,
    discussionActionLabel,
    eventLineText,
    expandDeletionRange,
    filterMentionCandidates,
    groupStatusText,
    memberColorHex,
    memberInitial,
    mentionQuery,
    needsDateBreak,
    needsRoundBreak,
    scanMentions,
    shouldMerge,
    statusLineOf,
    timeLabel,
} from './ai-group-ui-model.js';
import {createScrollGesture, createShrinkBurst, nextStickState} from '../chat/ai-scroll-follow.js';

const FLUSH_THROTTLE_MS = 80;
// 输入框最大可视高度（约 6 行）
const COMPOSER_MAX_PX = 132;
const MENTION_ALL = '全体成员';

function icon(name, size) {
    const span = el('span', 'gc-icon');
    span.innerHTML = iconSvg(name, size || 14);
    return span;
}

export function createAIGroupView(deps) {
    const runtime = deps.runtime;
    const getAIConfig = deps.getAIConfig || (() => null);
    const renderMarkdown = typeof deps.renderMarkdown === 'function' ? deps.renderMarkdown : null;
    const enhanceAnswerBody = typeof deps.enhanceAnswerBody === 'function' ? deps.enhanceAnswerBody : null;
    const flash = deps.flash || ((message) => console.warn('[group]', message));
    // 成员详情标签页（像子代理）：main 注入；不可用时点头像只提示
    const openMemberTab = typeof deps.openMemberTab === 'function' ? deps.openMemberTab : null;
    // 返回会话视图 / 群列表 / 新建群聊 / 群设置（main 注入，指向 panel bridge 与侧栏弹窗）
    const showSessions = typeof deps.showSessions === 'function' ? deps.showSessions : null;
    const groupHub = (deps.groupHub && typeof deps.groupHub === 'object') ? deps.groupHub : null;
    const openGroupSettings = typeof deps.openGroupSettings === 'function' ? deps.openGroupSettings : null;

    const views = new Set();

    function mountPanel(spec, host) {
        if (!host) return null;
        const groupId = String((spec && spec.groupId) || '');
        if (!groupId) return null;
        const shell = el('div', 'gc-shell');
        host.appendChild(shell);

        const state = {
            groupId,
            shell,
            dead: false,
            unsub: null,
            flushTimer: null,
            elapsedTimer: null,
            // 时间线游标：messages / events 各自只追加；lastMsg/lastTs 供分隔与合并判定
            msgCursor: 0,
            evtCursor: 0,
            lastMsg: null,
            lastTs: null,
            emptyEl: null,
            // 滚动跟随（ai-scroll-follow 单一来源）
            gesture: createScrollGesture(),
            burst: createShrinkBurst(),
            stick: {stickBottom: true, lastTop: 0, byUser: false},
            unseen: 0,
            streamingRow: null,
            streamingKey: '',
            // 顶部/看板/弹层
            topbarStamp: '',
            boardOpen: false,
            menuEl: null,
            menuCleanup: null,
            mentionItems: [],
            mentionIndex: 0,
        };

        buildDom(state);
        state.unsub = runtime.subscribe(() => scheduleFlush(state));
        views.add(state);
        flushNow(state);
        // 首帧落在最新消息（延迟到布局完成后再量高度）
        requestAnimationFrame(() => scrollToBottom(state, false));

        return {
            dispose() {
                if (state.dead) return;
                state.dead = true;
                views.delete(state);
                if (state.unsub) state.unsub();
                state.unsub = null;
                if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null; }
                if (state.elapsedTimer) { clearInterval(state.elapsedTimer); state.elapsedTimer = null; }
                closeMenu(state);
                if (state.docListeners) {
                    for (const [target, name, fn] of state.docListeners) target.removeEventListener(name, fn);
                    state.docListeners = null;
                }
                if (shell.parentElement) shell.parentElement.removeChild(shell);
            },
            focus() {
                if (state.composerCtl && !state.dead) {
                    try { state.composerCtl.control.focus(); } catch (e) { /* 输入框可能尚未布局 */ }
                }
            },
        };
    }

    // ---------- DOM 骨架 ----------

    function buildDom(state) {
        const shell = state.shell;
        // 顶部工具栏：返回 · 模式/轮次 chips · 状态文案 · 主讨论按钮 · 成员头像堆 · 看板 · ⋯
        const topbar = el('div', 'gc-topbar');
        const backBtn = el('button', 'gc-icon-btn');
        backBtn.type = 'button';
        backBtn.dataset.tip = '返回会话';
        backBtn.setAttribute('aria-label', '返回会话');
        backBtn.appendChild(icon('back', 15));
        backBtn.addEventListener('click', () => { if (showSessions) showSessions(); });
        state.chipsEl = el('div', 'gc-top-chips');
        state.statusEl = el('span', 'gc-top-status');
        state.actionBtn = el('button', 'gc-btn gc-btn-primary', '开始讨论');
        state.actionBtn.type = 'button';
        state.actionBtn.addEventListener('click', () => runDiscussionAction(state));
        const topMain = el('div', 'gc-top-main');
        topMain.append(state.chipsEl, state.statusEl);
        const topActions = el('div', 'gc-top-actions');
        state.avatarsEl = el('div', 'gc-avatars');
        topActions.appendChild(state.avatarsEl);
        const boardBtn = el('button', 'gc-icon-btn');
        boardBtn.type = 'button';
        boardBtn.dataset.tip = '讨论看板';
        boardBtn.setAttribute('aria-label', '讨论看板');
        boardBtn.appendChild(icon('list', 15));
        boardBtn.addEventListener('click', () => toggleBoard(state));
        state.boardBtn = boardBtn;
        const moreBtn = el('button', 'gc-icon-btn');
        moreBtn.type = 'button';
        moreBtn.dataset.tip = '更多操作';
        moreBtn.setAttribute('aria-label', '更多操作');
        moreBtn.appendChild(icon('more', 15));
        moreBtn.addEventListener('click', () => openMoreMenu(state, moreBtn));
        topActions.append(boardBtn, moreBtn);
        topbar.append(backBtn, topMain, state.actionBtn, topActions);
        shell.appendChild(topbar);

        // 议题（1 行省略，点击展开）
        state.topicEl = el('div', 'gc-topic hidden');
        state.topicEl.addEventListener('click', () => {
            const open = state.topicEl.classList.toggle('expanded');
            state.topicEl.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        shell.appendChild(state.topicEl);

        // 消息区 + 看板覆盖层 + 回到底部按钮
        const bodyWrap = el('div', 'gc-body-wrap');
        const scroll = el('div', 'gc-scroll');
        state.list = el('div', 'gc-list');
        scroll.appendChild(state.list);
        const board = el('div', 'gc-board hidden');
        const boardHead = el('div', 'gc-board-head');
        boardHead.appendChild(el('div', 'gc-board-title', '讨论看板'));
        const boardClose = el('button', 'gc-icon-btn');
        boardClose.type = 'button';
        boardClose.dataset.tip = '收起看板';
        boardClose.appendChild(icon('close', 14));
        boardClose.addEventListener('click', () => toggleBoard(state, false));
        boardHead.appendChild(boardClose);
        state.boardBody = el('div', 'gc-board-body');
        board.append(boardHead, state.boardBody);
        const scrollBtn = el('button', 'gc-scroll-btn hidden', '回到底部');
        scrollBtn.type = 'button';
        scrollBtn.addEventListener('click', () => {
            state.unseen = 0;
            scrollToBottom(state, true);
        });
        state.scrollBtn = scrollBtn;
        bodyWrap.append(scroll, board, scrollBtn);
        shell.appendChild(bodyWrap);
        state.scroll = scroll;

        bindScrollFollow(state, scroll);

        // 输入区：@ 补全弹层 + 自增高输入框（镜像层画 @ 胶囊）+ 发送/停止
        const composerWrap = el('div', 'gc-composer-wrap');
        state.mentionPop = el('div', 'gc-mention-pop hidden');
        const composer = el('div', 'gc-composer');
        // QQ 式 @ 胶囊：textarea 文字透明，绝对定位镜像层按相同度量渲染文本 + 胶囊 span；
        // 文本仍是纯文本（复制/粘贴/选区/IME 全走原生），Backspace/Delete 命中胶囊时整段删
        state.inputWrap = el('div', 'gc-input-wrap');
        state.inputMirror = el('div', 'gc-input-mirror', '\u200b');
        state.composerCtl = createTextarea({rows: 1, placeholder: '发消息，@ 点名成员，@全体成员 全员回应'});
        state.composerCtl.element.classList.add('gc-input');
        state.inputWrap.append(state.inputMirror, state.composerCtl.element);
        const sendBtn = el('button', 'gc-send-btn');
        sendBtn.type = 'button';
        sendBtn.dataset.tip = '发送 (Enter)';
        sendBtn.setAttribute('aria-label', '发送');
        sendBtn.appendChild(icon('forward', 15));
        sendBtn.addEventListener('click', () => sendComposer(state));
        state.sendBtn = sendBtn;
        const stopBtn = el('button', 'gc-send-btn gc-stop-btn hidden');
        stopBtn.type = 'button';
        stopBtn.dataset.tip = '停止当前发言';
        stopBtn.setAttribute('aria-label', '停止当前发言');
        stopBtn.appendChild(icon('stop', 14));
        stopBtn.addEventListener('click', () => {
            const stream = runtime.activeStreamOf(state.groupId);
            if (stream) runtime.stopOne(state.groupId, stream.agentId);
        });
        state.stopBtn = stopBtn;
        composer.append(state.inputWrap, stopBtn, sendBtn);
        composerWrap.append(state.mentionPop, composer);
        shell.appendChild(composerWrap);
        bindComposer(state);
    }

    // ---------- 刷新调度 ----------

    function scheduleFlush(state) {
        if (state.dead || state.flushTimer) return;
        state.flushTimer = setTimeout(() => {
            state.flushTimer = null;
            flushNow(state);
        }, FLUSH_THROTTLE_MS);
    }

    function flushNow(state) {
        if (state.dead) return;
        const g = runtime.groupById(state.groupId);
        if (!g) {
            renderDeleted(state);
            return;
        }
        renderTopbar(state, g);
        renderMessages(state, g);
        renderStreaming(state, g);
        renderComposerState(state);
        if (state.boardOpen) renderBoard(state, g);
        followGrowth(state);
    }

    function renderDeleted(state) {
        if (state.deletedShown) return;
        state.deletedShown = true;
        state.shell.textContent = '';
        // 空态收编 core/empty-state.js（2026-11-28）：与其它域的空态同一套观感
        state.shell.appendChild(renderEmptyState({
            title: '群聊已删除或不可用',
            hint: '共享对话与成员私有过程已进回收站。',
            action: {label: '返回会话', onClick: () => { if (showSessions) showSessions(); }},
        }));
    }

    // ---------- 顶部工具栏 ----------

    function renderTopbar(state, g) {
        const meta = g.meta;
        const isRelay = meta.mode === 'relay';
        const run = isRelay ? runtime.relaySnapshot(state.groupId) : runtime.discussionSnapshot(state.groupId);
        const running = !!(run && run.running);
        const paused = !!(run && run.paused);
        const stream = runtime.activeStreamOf(state.groupId);
        const stamp = [meta.updatedAt, meta.mode, running ? 'r' : '', paused ? 'p' : '',
            isRelay && run ? 's' + run.stage : '', stream ? stream.roundId : ''].join('|');
        if (state.topbarStamp !== stamp) {
            state.topbarStamp = stamp;
            state.chipsEl.textContent = '';
            state.chipsEl.appendChild(el('span', 'gc-badge gc-badge-mode',
                meta.mode === 'task' ? '任务' : (isRelay ? '接力' : (meta.mode === 'free' ? '自由' : '圆桌'))));
            if (isRelay) {
                state.chipsEl.appendChild(el('span', 'gc-badge',
                    run && run.stageCount
                        ? (running || paused ? `第 ${run.stage}/${run.stageCount} 棒 · ${run.stageName}` : `共 ${run.stageCount} 棒`)
                        : '接力链未建'));
                state.composerCtl.control.placeholder = '描述需求，发送后自动开始接力；运行中的插话在下一棒生效';
            } else if (meta.mode !== 'free') {
                const round = Math.max(1, (meta.discussion && meta.discussion.round) || 1);
                state.chipsEl.appendChild(el('span', 'gc-badge', run && run.unlimitedRounds ? `第 ${round} 轮 · 不限` : `第 ${round}/${meta.maxRounds} 轮`));
            }
            rebuildAvatars(state, meta);
            state.boardBtn.classList.toggle('hidden', meta.mode === 'free' || isRelay);
        }
        // 状态文案每帧更新（修掉旧版 phase 早退导致「N 次发言」冻结的问题）
        state.statusEl.textContent = groupStatusText(meta, run);
        const actionLabel = discussionActionLabel(meta, run);
        state.actionBtn.classList.toggle('hidden', !actionLabel);
        if (actionLabel) state.actionBtn.textContent = actionLabel;
        renderTopic(state, meta);
    }

    function rebuildAvatars(state, meta) {
        state.avatarsEl.textContent = '';
        const config = getAIConfig();
        const agents = (config && Array.isArray(config.agents)) ? config.agents : [];
        const muted = meta.mutedAgentIds || [];
        for (const id of meta.memberIds) {
            const agent = agents.find((item) => item && item.id === id);
            const avatar = el('button', 'gc-avatar');
            avatar.type = 'button';
            avatar.textContent = memberInitial(agent ? agent.name : '?');
            avatar.style.background = memberColorHex(agent && agent.color);
            const tips = [agent ? agent.name : '已删除成员'];
            if (meta.roles && meta.roles[id]) tips.push(meta.roles[id]);
            if (muted.includes(id)) tips.push('已静音');
            avatar.dataset.tip = tips.join(' · ');
            if (muted.includes(id)) avatar.classList.add('muted');
            if (meta.chair && meta.chair.kind === 'member' && meta.chair.agentId === id) avatar.classList.add('chair');
            avatar.addEventListener('click', () => {
                if (!openMemberTab) { flash('成员详情视图不可用'); return; }
                openMemberTab({groupId: state.groupId, agentId: id, name: agent ? agent.name : '', groupTitle: meta.title});
            });
            state.avatarsEl.appendChild(avatar);
        }
    }

    function renderTopic(state, meta) {
        const topic = String(meta.topic || '').trim();
        state.topicEl.classList.toggle('hidden', !topic);
        if (topic && state.topicEl.textContent !== topic) {
            state.topicEl.textContent = topic;
            state.topicEl.classList.remove('expanded');
            state.topicEl.setAttribute('aria-expanded', 'false');
        }
    }

    function runDiscussionAction(state) {
        const meta = (runtime.groupById(state.groupId) || {}).meta;
        if (!meta || meta.mode === 'free') return;
        if (meta.mode === 'relay') {
            const run = runtime.relaySnapshot(state.groupId);
            if (run && run.running) {
                runtime.pauseRelay(state.groupId);
            } else if (run && run.paused) {
                runtime.resumeRelay(state.groupId);
            } else {
                runtime.startRelay(state.groupId);
            }
            return;
        }
        const disc = runtime.discussionSnapshot(state.groupId);
        if (disc && disc.running) {
            runtime.pauseDiscussion(state.groupId);
        } else if (disc && disc.paused) {
            runtime.resumeDiscussion(state.groupId);
        } else {
            runtime.startDiscussion(state.groupId);
        }
    }

    // ---------- 成员菜单（更多 / 群切换） ----------

    function closeMenu(state) {
        if (state.menuCleanup) { state.menuCleanup(); state.menuCleanup = null; }
        if (state.menuEl && state.menuEl.parentElement) state.menuEl.parentElement.removeChild(state.menuEl);
        state.menuEl = null;
    }

    function openPopover(state, anchor, items) {
        closeMenu(state);
        const menu = el('div', 'gc-menu');
        for (const item of items) {
            if (item.sep) {
                menu.appendChild(el('div', 'gc-menu-sep'));
                continue;
            }
            const row = el('button', 'gc-menu-item' + (item.danger ? ' danger' : '') + (item.title ? ' title' : ''));
            row.type = 'button';
            row.textContent = item.label;
            if (item.disabled) row.disabled = true;
            row.addEventListener('click', () => {
                closeMenu(state);
                if (typeof item.action === 'function') item.action();
            });
            menu.appendChild(row);
        }
        state.shell.appendChild(menu);
        // 量尺寸后定位：默认贴锚点下方右对齐，越界翻转
        menu.style.visibility = 'hidden';
        requestAnimationFrame(() => {
            const rect = anchor.getBoundingClientRect();
            const shellRect = state.shell.getBoundingClientRect();
            const width = menu.offsetWidth;
            let left = rect.right - width;
            if (left < shellRect.left + 6) left = shellRect.left + 6;
            let top = rect.bottom + 4 - shellRect.top;
            const bottomOverflow = top + menu.offsetHeight - (shellRect.height - 6);
            if (bottomOverflow > 0) top = Math.max(6, rect.top - shellRect.top - menu.offsetHeight - 4);
            menu.style.left = Math.round(left - shellRect.left) + 'px';
            menu.style.top = Math.round(top) + 'px';
            menu.style.visibility = '';
        });
        state.menuEl = menu;
        const onDocDown = (e) => {
            if (!menu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closeMenu(state);
        };
        // 菜单挂在群聊视图 shell 内（面板层叠上下文），不进全局弹层栈：Esc 自管
        // （页面级弹层开着时栈先消费并抢占，本监听收不到）。
        const onDocKey = (e) => { if (e.key === 'Escape') closeMenu(state); };
        document.addEventListener('mousedown', onDocDown, true);
        document.addEventListener('keydown', onDocKey, true);
        state.menuCleanup = () => {
            document.removeEventListener('mousedown', onDocDown, true);
            document.removeEventListener('keydown', onDocKey, true);
        };
    }

    function openMoreMenu(state, anchor) {
        const g = runtime.groupById(state.groupId);
        if (!g) return;
        const meta = g.meta;
        const disc = meta.mode === 'relay' ? runtime.relaySnapshot(state.groupId) : runtime.discussionSnapshot(state.groupId);
        const items = [];
        if (meta.mode !== 'free' && disc && (disc.running || disc.paused)) {
            items.push(meta.mode === 'relay'
                ? {label: '结束并总结', action: () => runtime.endRelay(state.groupId)}
                : {label: '结束并总结', action: () => runtime.endDiscussion(state.groupId)});
        }
        items.push({label: '压缩群聊数据', action: () => {
            flash('正在压缩群聊数据…');
            runtime.compressShared(state.groupId, {keepRounds: 1}).then((result) => {
                if (!result.ok) flash(result.error || '压缩失败', true);
                else flash('已生成共享摘要');
            }).catch((e) => flash((e && e.message) || String(e), true));
        }});
        if (meta.minutes) {
            items.push({label: '润色纪要', action: () => {
                runtime.polishMinutes(state.groupId).then((result) => {
                    if (!result.ok) flash(result.error || '润色失败', true);
                }).catch((e) => flash((e && e.message) || String(e), true));
            }});
            items.push({label: '导出纪要…', action: () => {
                runtime.exportMinutes(state.groupId).then((result) => {
                    if (!result.ok && !result.canceled) flash(result.error || '导出失败', true);
                }).catch((e) => flash((e && e.message) || String(e), true));
            }});
        }
        if (openGroupSettings) items.push({sep: true}, {label: '群设置…', action: () => openGroupSettings(state.groupId)});
        // 群切换：列出全部群 + 新建群聊
        if (groupHub && typeof groupHub.list === 'function') {
            items.push({sep: true});
            for (const metaItem of (groupHub.list() || []).slice(0, 12)) {
                items.push({
                    label: (metaItem.id === state.groupId ? '· ' : '') + (metaItem.title || '未命名群聊'),
                    action: () => {
                        if (metaItem.id === state.groupId) return;
                        if (groupHub.open) groupHub.open(metaItem.id, metaItem.title);
                    },
                });
            }
            if (typeof groupHub.create === 'function') items.push({label: '新建群聊…', action: () => groupHub.create()});
        }
        openPopover(state, anchor, items);
    }

    // ---------- 时间线（消息 + 系统事件，增量追加） ----------

    function renderMessages(state, g) {
        const messages = g.messages || [];
        const events = g.events || [];
        // 空态：没有任何消息也没有流式发言时，给一块「发条消息开始」的引导卡
        const shouldEmpty = !messages.length && !runtime.activeStreamOf(state.groupId);
        if (shouldEmpty && !state.emptyEl) {
            state.emptyEl = buildEmptyState(state, g);
            state.list.appendChild(state.emptyEl);
        } else if (!shouldEmpty && state.emptyEl) {
            state.emptyEl.remove();
            state.emptyEl = null;
        }
        if (state.msgCursor >= messages.length && state.evtCursor >= events.length) return;
        // 新尾巴按 ts 合并（消息与事件都可能在一帧内追加）
        const tail = [];
        for (let i = state.msgCursor; i < messages.length; i++) tail.push({kind: 'msg', ts: messages[i].ts || 0, msg: messages[i]});
        for (let i = state.evtCursor; i < events.length; i++) {
            const text = eventLineText(events[i]);
            if (text) tail.push({kind: 'event', ts: events[i].ts || 0, text});
        }
        tail.sort((a, b) => (a.ts - b.ts));
        const meta = g.meta;
        for (const item of tail) {
            if (item.kind === 'event') {
                const node = el('div', 'gc-event-line', item.text);
                insertTimelineNode(state, node, item.ts);
            } else {
                const msg = item.msg;
                const prev = state.lastMsg;
                if (needsDateBreak(state.lastTs, msg.ts)) {
                    insertTimelineNode(state, el('div', 'gc-date-sep', dateLabel(msg.ts)), msg.ts);
                }
                if (needsRoundBreak(prev, msg, meta)) {
                    const round = Number(msg.round) || 1;
                    const unit = meta.mode === 'relay' ? '棒' : '轮';
                    const label = meta.mode === 'free' ? '' : `第 ${round} ${unit}`;
                    if (label) insertTimelineNode(state, el('div', 'gc-round-sep', label), msg.ts);
                }
                const merged = shouldMerge(prev, msg);
                const node = messageNode(msg, meta, state, merged);
                insertTimelineNode(state, node, msg.ts);
                state.lastMsg = msg;
            }
            state.lastTs = item.ts;
        }
        state.msgCursor = messages.length;
        state.evtCursor = events.length;
    }

    function buildEmptyState(state, g) {
        const meta = g.meta;
        const empty = el('div', 'gc-empty-state');
        const config = getAIConfig();
        const agents = (config && Array.isArray(config.agents)) ? config.agents : [];
        const avatars = el('div', 'gc-avatars gc-avatars-lg');
        for (const id of meta.memberIds) {
            const agent = agents.find((item) => item && item.id === id);
            const avatar = el('span', 'gc-avatar');
            avatar.textContent = memberInitial(agent ? agent.name : '?');
            avatar.style.background = memberColorHex(agent && agent.color);
            avatar.dataset.tip = agent ? agent.name : '已删除成员';
            avatars.appendChild(avatar);
        }
        empty.appendChild(avatars);
        empty.appendChild(el('div', 'gc-empty-title', meta.title || '未命名群聊'));
        if (meta.topic) empty.appendChild(el('div', 'gc-empty-topic', meta.topic));
        empty.appendChild(el('div', 'gc-empty-hint',
            meta.mode === 'free'
                ? '发条消息开始：@点名谁谁回，@全体成员人人回'
                : (meta.mode === 'relay'
                    ? '发条需求开始接力：成员按链序交棒，后者可 @ 前棒回问'
                    : '发条消息或点「开始讨论」，@ 成员可以点名发言')));
        return empty;
    }

    // 新节点插到流式气泡之前（流式气泡固定在时间线最后）
    function insertTimelineNode(state, node, ts) {
        if (state.streamingRow && state.streamingRow.parentElement === state.list) {
            state.list.insertBefore(node, state.streamingRow);
        } else {
            state.list.appendChild(node);
        }
        if (!state.stick.stickBottom) state.unseen++;
    }

    function agentOf(agents, agentId) {
        return (agents || []).find((item) => item && item.id === agentId) || null;
    }

    function messageNode(msg, meta, state, merged) {
        if (msg.role === 'system') {
            // 系统通知（成员模型失效 / 无可用成员等）：不进成员上下文，居中灰条
            const pill = el('div', 'gc-msg-system', String(msg.content || ''));
            pill.dataset.tip = timeLabel(msg.ts);
            return pill;
        }
        const isMinutes = msg.kind === 'minutes';
        const isUser = msg.role === 'user';
        const config = getAIConfig();
        const agents = (config && Array.isArray(config.agents)) ? config.agents : [];
        const agent = isUser ? null : agentOf(agents, msg.agentId);
        const name = isMinutes ? '纪要' : (isUser ? '你' : (msg.chair ? '主持人' : (msg.agentName || (agent && agent.name) || '已删除成员')));
        const colorHex = isUser ? '' : memberColorHex(msg.agentColor || (agent && agent.color));

        const row = el('div', 'gc-msg' +
            (isUser ? ' gc-msg-user' : ' gc-msg-agent') +
            (isMinutes ? ' gc-msg-minutes' : '') +
            (merged ? ' merged' : ''));
        if (merged) {
            // 连续消息：只补正文，保留悬停定位
            row.dataset.tip = name + ' · ' + timeLabel(msg.ts);
        } else {
            const head = el('div', 'gc-msg-head');
            if (!isUser) {
                const avatar = el('span', 'gc-avatar gc-avatar-sm');
                avatar.textContent = memberInitial(name);
                avatar.style.background = colorHex;
                if (msg.chair && !isMinutes) avatar.classList.add('chair');
                avatar.addEventListener('click', () => openMemberOf(state, msg, meta));
                head.appendChild(avatar);
            }
            const nameEl = el('span', 'gc-msg-name' + (isUser ? ' gc-msg-name-user' : ''), name);
            const tips = [];
            if (!isUser && msg.model && !msg.chair) tips.push(msg.model);
            if (!isUser && meta.roles && meta.roles[msg.agentId]) tips.push('角色：' + meta.roles[msg.agentId]);
            if (msg.timing && msg.timing.ttftMs) tips.push(`首字 ${(msg.timing.ttftMs / 1000).toFixed(1)}s`);
            if (Number(msg.round) > 0 && meta.mode !== 'free') tips.push(`第 ${msg.round} ${meta.mode === 'relay' ? '棒' : '轮'}`);
            if (tips.length) nameEl.dataset.tip = tips.join(' · ');
            if (!isUser && !isMinutes) nameEl.addEventListener('click', () => openMemberOf(state, msg, meta));
            head.appendChild(nameEl);
            head.appendChild(el('span', 'gc-msg-time', timeLabel(msg.ts)));
            row.appendChild(head);
        }

        const bubble = el('div', 'gc-bubble' + (isUser ? ' gc-bubble-user' : '') + (isMinutes ? ' gc-bubble-minutes' : ''));
        // 接力成员的【交棒】标记只留给引擎判读，气泡里不显示（落盘保留原样）
        const bodyText = (isUser || isMinutes) ? String(msg.content || '') : stripHandoffMarker(String(msg.content || ''));
        if (isUser) {
            bubble.textContent = bodyText;
        } else if (renderMarkdown) {
            bubble.innerHTML = renderMarkdown(bodyText);
            if (enhanceAnswerBody) enhanceAnswerBody(bubble);
        } else {
            bubble.textContent = bodyText;
        }
        row.appendChild(bubble);

        // 失败/超时/停止：气泡下小状态行（不再让整条消息变红字）
        const statusText = statusLineOf(msg);
        if (statusText) row.appendChild(el('div', 'gc-msg-status', statusText));

        // 立场卡（§3.5）：结构化 stance 摘要
        if (msg.groupBlock && (msg.groupBlock.stance || (msg.groupBlock.keyPoints && msg.groupBlock.keyPoints.length))) {
            row.appendChild(stanceCard(msg.groupBlock));
        }

        // 纪要卡操作（§3.8 / G4）
        if (isMinutes && meta.minutes) {
            const actions = el('div', 'gc-minutes-actions');
            const copyBtn = el('button', 'gc-btn', '复制');
            copyBtn.type = 'button';
            copyBtn.addEventListener('click', () => {
                navigator.clipboard.writeText(meta.minutes.text || '').then(() => flash('纪要已复制')).catch(() => flash('复制失败'));
            });
            const exportBtn = el('button', 'gc-btn', '导出 Markdown');
            exportBtn.type = 'button';
            exportBtn.addEventListener('click', () => {
                runtime.exportMinutes(state.groupId).then((result) => {
                    if (!result.ok && !result.canceled) flash(result.error);
                }).catch((e) => flash((e && e.message) || String(e)));
            });
            const backBtn = el('button', 'gc-btn', '带回当前会话');
            backBtn.type = 'button';
            backBtn.dataset.tip = '把纪要投递到当前打开的 AI 会话（出现投递卡）';
            backBtn.addEventListener('click', () => {
                runtime.bringMinutesBack(state.groupId).then((result) => {
                    if (!result.ok) flash(result.error);
                }).catch((e) => flash((e && e.message) || String(e)));
            });
            actions.append(copyBtn, exportBtn, backBtn);
            row.appendChild(actions);
        }

        // hover 动作：复制 / @TA / 成员详情
        const hover = el('div', 'gc-msg-actions');
        const copyAction = el('button', 'gc-icon-btn');
        copyAction.type = 'button';
        copyAction.dataset.tip = '复制';
        copyAction.appendChild(icon('copy', 12));
        copyAction.addEventListener('click', () => {
            navigator.clipboard.writeText(String(msg.content || '')).then(() => flash('已复制')).catch(() => {});
        });
        hover.appendChild(copyAction);
        if (!isUser && !isMinutes && agent) {
            const atAction = el('button', 'gc-icon-btn');
            atAction.type = 'button';
            atAction.dataset.tip = '@TA';
            atAction.textContent = '@';
            atAction.addEventListener('click', () => {
                if (!state.composerCtl || state.dead) return;
                const control = state.composerCtl.control;
                const value = String(control.value || '');
                const add = value && !value.endsWith(' ') ? ' ' : '';
                // 走 execCommand 插入：可撤销且自然触发 input → 重扫 @ 胶囊
                insertComposerText(state, value.length, value.length, add + '@' + (msg.agentName || (agent && agent.name) || '') + ' ');
                try { control.focus(); } catch (e) { /* 焦点失败不影响 */ }
            });
            hover.appendChild(atAction);
        }
        row.appendChild(hover);
        return row;
    }

    function openMemberOf(state, msg, meta) {
        if (!msg.agentId) return;
        if (!openMemberTab) { flash('成员详情视图不可用'); return; }
        const config = getAIConfig();
        const agents = (config && Array.isArray(config.agents)) ? config.agents : [];
        const agent = agentOf(agents, msg.agentId);
        openMemberTab({groupId: state.groupId, agentId: msg.agentId, name: agent ? agent.name : (msg.agentName || ''), groupTitle: meta.title});
    }

    function stanceCard(block) {
        const card = el('div', 'gc-stance');
        if (block.stance) card.appendChild(el('span', 'gc-badge gc-badge-stance-' + block.stance, '立场：' + (STANCE_LABELS[block.stance] || block.stance)));
        for (const point of block.keyPoints || []) card.appendChild(el('span', 'gc-badge', '要点：' + point));
        for (const concern of block.concerns || []) card.appendChild(el('span', 'gc-badge gc-badge-concern', '担忧：' + concern));
        for (const question of block.questions || []) card.appendChild(el('span', 'gc-badge gc-badge-question', '疑问：' + question));
        return card;
    }

    // ---------- 流式气泡 ----------

    function renderStreaming(state, g) {
        const stream = runtime.activeStreamOf(state.groupId);
        if (!stream) {
            if (state.streamingRow) {
                state.streamingRow.remove();
                state.streamingRow = null;
                state.streamingKey = '';
                if (state.elapsedTimer) {
                    clearInterval(state.elapsedTimer);
                    state.elapsedTimer = null;
                }
            }
            return;
        }
        if (!state.streamingRow || state.streamingKey !== stream.roundId) {
            if (state.streamingRow) state.streamingRow.remove();
            state.streamingKey = stream.roundId;
            const row = el('div', 'gc-msg gc-msg-agent gc-msg-streaming');
            const head = el('div', 'gc-msg-head');
            const avatar = el('span', 'gc-avatar gc-avatar-sm');
            avatar.textContent = memberInitial(stream.agentName);
            avatar.style.background = memberColorHex(stream.agentColor);
            head.appendChild(avatar);
            head.appendChild(el('span', 'gc-msg-name', stream.agentName || '成员'));
            state.streamNoteEl = el('span', 'gc-msg-typing', '正在思考…');
            head.appendChild(state.streamNoteEl);
            state.elapsedEl = el('span', 'gc-msg-time', '0s');
            head.appendChild(state.elapsedEl);
            row.appendChild(head);
            state.streamingContentEl = el('div', 'gc-bubble gc-bubble-streaming');
            row.appendChild(state.streamingContentEl);
            state.list.appendChild(row); // 流式气泡固定最后，新消息用 insertBefore 插到它前面
            state.streamingRow = row;
            if (state.elapsedTimer) clearInterval(state.elapsedTimer);
            state.elapsedTimer = setInterval(() => {
                if (!state.elapsedEl || !stream) return;
                state.elapsedEl.textContent = Math.round((Date.now() - stream.startedAt) / 1000) + 's';
            }, 1000);
        }
        const hasContent = !!stream.content;
        state.streamingContentEl.textContent = hasContent ? stream.content : '';
        state.streamingContentEl.classList.toggle('typing', !hasContent);
        state.streamNoteEl.textContent = stream.statusNote || (stream.thinking && !hasContent ? '思考中…' : '正在输入…');
    }

    // ---------- 输入区 ----------

    function bindComposer(state) {
        const control = state.composerCtl.control;
        syncMirrorStyles(state);
        const refresh = () => {
            autoGrow(control);
            // @ 胶囊：文本是唯一真源，每次输入重扫（改到胶囊中间会自然溶解回纯文本）
            rescanPills(state);
            updateMentionPop(state);
            state.sendBtn.classList.toggle('disabled', !String(control.value || '').trim());
        };
        control.addEventListener('input', refresh);
        // 镜像层随文本域滚动（内容超过 6 行出现滚动条后保持对齐）
        control.addEventListener('scroll', () => {
            state.inputMirror.scrollTop = control.scrollTop;
            state.inputMirror.scrollLeft = control.scrollLeft;
        });
        control.addEventListener('keydown', (e) => {
            if (state.mentionOpen && handleMentionKeys(state, e)) return;
            // QQ 式原子删除：Backspace/Delete 命中胶囊整段删（execCommand 参与原生撤销栈）
            if ((e.key === 'Backspace' || e.key === 'Delete') && !e.isComposing) {
                const range = expandDeletionRange(state.pills, control.selectionStart, control.selectionEnd,
                    e.key === 'Backspace' ? 'backspace' : 'delete');
                if (range) {
                    e.preventDefault();
                    try {
                        control.setSelectionRange(range.start, range.end);
                        if (!document.execCommand('delete')) throw new Error('execCommand 不可用');
                    } catch (err) {
                        // 兜底：setRangeText 直接改值（丢撤销栈，输入事件手动补发）
                        control.setRangeText('', range.start, range.end, 'end');
                        control.dispatchEvent(new Event('input', {bubbles: true}));
                    }
                    return;
                }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                sendComposer(state);
            }
        });
        state.sendBtn.classList.add('disabled');
        refresh();
    }

    // 成员名单（胶囊识别用：全部成员，静音与否由 runtime 决定回不回）
    function memberNamesOf(meta) {
        if (!meta) return [];
        const config = getAIConfig();
        const agents = (config && Array.isArray(config.agents)) ? config.agents : [];
        return meta.memberIds
            .map((id) => agentOf(agents, id))
            .filter((agent) => agent)
            .map((agent) => agent.name)
            .concat([MENTION_ALL]);
    }

    function rescanPills(state) {
        const control = state.composerCtl.control;
        if (!control || state.dead) return;
        const meta = (runtime.groupById(state.groupId) || {}).meta;
        state.pills = scanMentions(String(control.value || ''), memberNamesOf(meta));
        renderMirror(state);
    }

    // 镜像层样式与文本域对齐（逐项 longhand 比 font 简写更可靠），只同步一次，主题变量跟随 CSS
    function syncMirrorStyles(state) {
        const control = state.composerCtl.control;
        const mirror = state.inputMirror;
        if (!control || !mirror) return;
        const cs = getComputedStyle(control);
        const box = (prop, extra) => (parseFloat(cs[prop]) || 0) + (extra || 0);
        mirror.style.fontFamily = cs.fontFamily;
        mirror.style.fontSize = cs.fontSize;
        mirror.style.fontWeight = cs.fontWeight;
        mirror.style.fontStyle = cs.fontStyle;
        mirror.style.lineHeight = cs.lineHeight;
        mirror.style.letterSpacing = cs.letterSpacing;
        mirror.style.whiteSpace = 'pre-wrap';
        mirror.style.overflowWrap = 'anywhere';
        mirror.style.wordBreak = cs.wordBreak === 'normal' ? 'normal' : cs.wordBreak;
        mirror.style.padding = [
            box('paddingTop', box('borderTopWidth')),
            box('paddingRight', box('borderRightWidth')),
            box('paddingBottom', box('borderBottomWidth')),
            box('paddingLeft', box('borderLeftWidth')),
        ].map((n) => n + 'px').join(' ');
    }

    function renderMirror(state) {
        const control = state.composerCtl.control;
        const mirror = state.inputMirror;
        if (!control || !mirror) return;
        mirror.innerHTML = buildRichHtml(String(control.value || ''), state.pills);
        mirror.scrollTop = control.scrollTop;
        mirror.scrollLeft = control.scrollLeft;
    }

    // 用 execCommand 插入文本：参与原生撤销栈并自然触发 input（失败回落直接赋值）
    function insertComposerText(state, start, end, text) {
        const control = state.composerCtl.control;
        control.focus();
        try {
            control.setSelectionRange(start, end);
            if (document.execCommand('insertText', false, text)) return true;
        } catch (err) { /* execCommand 不可用走兜底 */ }
        control.setRangeText(text, start, end, 'end');
        control.dispatchEvent(new Event('input', {bubbles: true}));
        return false;
    }

    function autoGrow(control) {
        control.style.height = 'auto';
        control.style.height = Math.min(control.scrollHeight, COMPOSER_MAX_PX) + 'px';
    }

    function sendComposer(state) {
        const control = state.composerCtl.control;
        const text = String(control.value || '').trim();
        if (!text) return;
        runtime.sendUserMessage(state.groupId, text).then((result) => {
            if (result.ok) {
                control.value = '';
                rescanPills(state);
                autoGrow(control);
                state.sendBtn.classList.add('disabled');
                closeMentionPop(state);
                state.unseen = 0;
                scrollToBottom(state, true);
                try { control.focus(); } catch (e) { /* 已卸载时忽略 */ }
            } else {
                flash(result.error || '发送失败', true);
            }
        }).catch((e) => flash((e && e.message) || String(e), true));
    }

    function renderComposerState(state) {
        const stream = runtime.activeStreamOf(state.groupId);
        state.stopBtn.classList.toggle('hidden', !stream);
        if (stream) state.stopBtn.dataset.tip = '停止 ' + (stream.agentName || '当前发言');
    }

    // @ 补全弹层
    function updateMentionPop(state) {
        const control = state.composerCtl.control;
        const parsed = mentionQuery(String(control.value || ''), control.selectionStart);
        if (!parsed) { closeMentionPop(state); return; }
        const meta = (runtime.groupById(state.groupId) || {}).meta;
        if (!meta) { closeMentionPop(state); return; }
        const config = getAIConfig();
        const agents = (config && Array.isArray(config.agents)) ? config.agents : [];
        const names = meta.memberIds
            .map((id) => agentOf(agents, id))
            .filter((agent) => agent && agent.enabled && !(meta.mutedAgentIds || []).includes(agent.id))
            .map((agent) => agent.name);
        const candidates = filterMentionCandidates([MENTION_ALL, ...names], parsed.query).slice(0, 8);
        if (!candidates.length) { closeMentionPop(state); return; }
        state.mentionQuery = parsed;
        state.mentionItems = candidates;
        state.mentionIndex = 0;
        state.mentionOpen = true;
        state.mentionPop.textContent = '';
        candidates.forEach((name, index) => {
            const row = el('button', 'gc-mention-item' + (index === 0 ? ' active' : ''));
            row.type = 'button';
            row.textContent = name === MENTION_ALL ? '@' + name : name;
            row.addEventListener('click', () => applyMentionChoice(state, name));
            state.mentionPop.appendChild(row);
        });
        state.mentionPop.classList.remove('hidden');
    }

    function handleMentionKeys(state, e) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const total = state.mentionItems.length;
            state.mentionIndex = (state.mentionIndex + (e.key === 'ArrowDown' ? 1 : total - 1)) % total;
            [...state.mentionPop.children].forEach((child, index) => child.classList.toggle('active', index === state.mentionIndex));
            return true;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            applyMentionChoice(state, state.mentionItems[state.mentionIndex]);
            return true;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            closeMentionPop(state);
            return true;
        }
        return false;
    }

    function applyMentionChoice(state, name) {
        const control = state.composerCtl.control;
        // 弹层打开时的补全区（@xxx）；execCommand 替换可撤销且自然触发 input → 重扫胶囊
        const parsed = state.mentionQuery || mentionQuery(String(control.value || ''), control.selectionStart);
        const caret = control.selectionStart;
        closeMentionPop(state);
        if (!parsed) return;
        insertComposerText(state, parsed.start, caret, '@' + String(name || '') + ' ');
        autoGrow(control);
        state.sendBtn.classList.toggle('disabled', !String(control.value || '').trim());
        try { control.focus(); } catch (e) { /* 已卸载时忽略 */ }
    }

    function closeMentionPop(state) {
        state.mentionOpen = false;
        state.mentionItems = [];
        state.mentionPop.classList.add('hidden');
        state.mentionPop.textContent = '';
    }

    // ---------- 贴底跟随（ai-scroll-follow 单一来源） ----------

    function bindScrollFollow(state, scroll) {
        const note = () => state.gesture.note();
        scroll.addEventListener('wheel', note, {passive: true});
        scroll.addEventListener('touchstart', (e) => { state.gesture.begin(); note(); }, {passive: true});
        scroll.addEventListener('touchmove', note, {passive: true});
        scroll.addEventListener('touchend', () => state.gesture.end());
        scroll.addEventListener('keydown', (e) => {
            if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) note();
        });
        scroll.addEventListener('scroll', () => {
            const top = scroll.scrollTop;
            const distance = scroll.scrollHeight - scroll.clientHeight - top;
            const byUser = state.gesture.active() || state.burst.push(top < state.stick.lastTop);
            const next = nextStickState(state.stick, {top, distance});
            state.stick = {stickBottom: next.stickBottom, lastTop: top, byUser};
            if (next.refollow) scroll.scrollTop = scroll.scrollHeight;
            if (next.stickBottom) state.unseen = 0;
            state.scrollBtn.classList.toggle('hidden', !!next.stickBottom);
            state.scrollBtn.textContent = '回到底部' + (state.unseen ? ' · ' + state.unseen : '');
        }, {passive: true});
    }

    function followGrowth(state) {
        const scroll = state.scroll;
        if (!scroll) return;
        const distance = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop;
        if (state.stick.stickBottom) {
            scroll.scrollTop = scroll.scrollHeight;
            state.stick.lastTop = scroll.scrollTop;
            state.scrollBtn.classList.add('hidden');
        } else {
            // 用户在读历史：不抢滚动，只更新未读计数
            state.scrollBtn.textContent = '回到底部' + (state.unseen ? ' · ' + state.unseen : '');
            if (distance <= 4) {
                state.stick.stickBottom = true;
                state.unseen = 0;
                state.scrollBtn.classList.add('hidden');
            }
        }
    }

    function scrollToBottom(state, smooth) {
        const scroll = state.scroll;
        if (!scroll) return;
        if (smooth && scroll.scrollTo) {
            scroll.scrollTo({top: scroll.scrollHeight, behavior: 'smooth'});
        } else {
            scroll.scrollTop = scroll.scrollHeight;
        }
        state.stick.stickBottom = true;
        state.stick.lastTop = scroll.scrollTop;
        state.unseen = 0;
        state.scrollBtn.classList.add('hidden');
    }

    // ---------- 讨论看板覆盖层 ----------

    function toggleBoard(state, force) {
        const open = typeof force === 'boolean' ? force : !state.boardOpen;
        state.boardOpen = open;
        state.boardBtn.classList.toggle('active', open);
        const board = state.boardBody ? state.boardBody.parentElement : null;
        if (board) board.classList.toggle('hidden', !open);
        if (open) {
            const g = runtime.groupById(state.groupId);
            if (g) renderBoard(state, g);
        }
    }

    function renderBoard(state, g) {
        const d = g.meta.discussion;
        if (!d) return;
        const box = state.boardBody;
        box.textContent = '';
        const section = (title, items, renderer) => {
            if (!items || !items.length) return;
            box.appendChild(el('div', 'gc-drawer-sec-title', title));
            const sec = el('div', 'gc-drawer-sec');
            for (const item of items) sec.appendChild(renderer(item));
            box.appendChild(sec);
        };
        if (d.agenda.length) section('议程', d.agenda, (item) => el('div', 'gc-drawer-item', item));
        section('成员立场', (d.positions || []).filter((p) => p && p.stance), (pos) => {
            const row = el('div', 'gc-drawer-item');
            row.appendChild(el('span', 'gc-badge gc-badge-stance-' + pos.stance, `${pos.name || pos.agentId}：${STANCE_LABELS[pos.stance] || pos.stance}`));
            for (const point of pos.keyPoints || []) row.appendChild(el('div', 'gc-drawer-sub', '· ' + point));
            for (const concern of pos.concerns || []) row.appendChild(el('div', 'gc-drawer-sub', '· 担忧：' + concern));
            return row;
        });
        section('共识', d.agreements, (item) => el('div', 'gc-drawer-item', item));
        section('分歧', d.disagreements, (item) => {
            const row = el('div', 'gc-drawer-item');
            row.textContent = `${item.point}（${(item.sides || []).join(' vs ')}）${item.resolution ? ' → ' + item.resolution : ''}`;
            return row;
        });
        section('未决问题', d.openQuestions, (item) => el('div', 'gc-drawer-item', item));
        section('决定', d.decisions, (item) => el('div', 'gc-drawer-item', item));
        // 任务板（§1.2 任务模式可增改；圆桌模式只读展示）
        if ((d.actionItems || []).length || g.meta.mode === 'task') {
            box.appendChild(el('div', 'gc-drawer-sec-title', '任务板'));
            const taskBox = el('div', 'gc-drawer-sec');
            const statusOrder = ['todo', 'doing', 'done', 'blocked'];
            const statusLabel = {todo: '待办', doing: '进行中', done: '完成', blocked: '阻塞'};
            for (const item of d.actionItems || []) {
                const row = el('div', 'gc-drawer-item');
                row.appendChild(el('span', 'gc-drawer-task-title', `${item.title}（${item.ownerId || '待定'}）`));
                const cycleBtn = el('button', 'gc-btn gc-task-cycle', statusLabel[item.status] || item.status);
                cycleBtn.type = 'button';
                cycleBtn.dataset.tip = '切换状态：待办 → 进行中 → 完成 → 阻塞';
                cycleBtn.addEventListener('click', () => {
                    const next = statusOrder[(statusOrder.indexOf(item.status) + 1) % statusOrder.length];
                    runtime.updateActionItem(state.groupId, item.id, {status: next}).catch((e) => flash((e && e.message) || String(e)));
                });
                row.appendChild(cycleBtn);
                taskBox.appendChild(row);
            }
            if (g.meta.mode === 'task') {
                const addRow = el('div', 'gc-drawer-item gc-task-add');
                // 表单控件硬规范：一律走 core/form-controls.js 工厂
                const titleCtl = createInput({placeholder: '新任务（回车添加）'});
                titleCtl.control.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && titleCtl.control.value.trim()) {
                        runtime.addActionItem(state.groupId, titleCtl.control.value.trim()).then((result) => {
                            if (result.ok) titleCtl.control.value = '';
                            else flash(result.error);
                        }).catch((err) => flash((err && err.message) || String(err)));
                    }
                });
                addRow.appendChild(titleCtl.element);
                taskBox.appendChild(addRow);
            }
            box.appendChild(taskBox);
        }
        section('请求发言', (d.floorRequests || []).slice(-6), (req) => {
            const row = el('div', 'gc-drawer-item');
            row.textContent = `${req.fromName || req.from} → ${req.to}${req.reason ? '：' + req.reason : ''}`;
            return row;
        });
        if (d.lastRoundSummary) section('上一轮小结', [d.lastRoundSummary], (item) => el('div', 'gc-drawer-item', item));
        if (!box.children.length) {
            box.appendChild(el('div', 'gc-drawer-item', '看板还是空的：开始讨论后由主持人开场与成员立场自动填充。'));
        }
    }

    return {mountPanel};
}
