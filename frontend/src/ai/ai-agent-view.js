// ai-agent-view.js：子代理详情视图（内容区标签页 / 悬浮窗覆盖层的正文渲染与输入行）。
// 从 ai-subagents.js 拆出（frontend-split-phase3 A4a，同域兄弟模块）；ctx 与宿主同源，
// 块模型纯函数与运行态注册表（const Map 活引用）、运行时动作经 extras 注入。函数体逐字搬移。
import {iconSvg} from '../core/icons.js';
import {createTextarea} from '../core/form-controls.js';
import {agentLevelText} from './ai-team-model.js';
import {createScrollGesture, nextStickState} from './ai-scroll-follow.js';

export function createAIAgentView(ctx, extras) {
    const el = ctx.el;
    const flash = ctx.flash;
    const renderMarkdown = ctx.renderMarkdown;
    // 详情视图的宿主出口：主窗口在内容区开标签页（bridge-agent-view.js），悬浮窗退回面板覆盖层
    const openAgentTab = typeof ctx.openAgentTab === 'function' ? ctx.openAgentTab : null;
    const isFloatWindow = typeof ctx.isFloatWindow === 'function' ? ctx.isFloatWindow : () => false;
    // 正文增强链（代码复制钮 / 本地图片 / mermaid·echarts·svg 可视化卡片）：与主消息区同一条
    const enhanceAnswerBody = typeof ctx.enhanceAnswerBody === 'function' ? ctx.enhanceAnswerBody : null;
    const sessionById = ctx.sessionById;
    const getSessions = ctx.getSessions;
    const agentRegistry = ctx.agentRegistry;
    // 懒加载会话补正文（面板注入）：详情头部的状态兜底要用它——只补「所属会话」这一个，
    // 绝不为了找一个 spawn_agent 记录去扫全部会话。
    const ensureSessionLoaded = typeof ctx.ensureSessionLoaded === 'function'
        ? ctx.ensureSessionLoaded
        : () => Promise.resolve(true);
    // 块模型纯函数（宿主留守，ai-subagents.test.mjs 覆盖）
    const agentMessageBlocks = extras.agentMessageBlocks;
    const agentRecordBlocks = extras.agentRecordBlocks;
    const agentTranscriptBlocks = extras.agentTranscriptBlocks;
    const agentBlockSig = extras.agentBlockSig;
    const canReviveRecord = extras.canReviveRecord;
    // 工具行的动词+图标映射（复用主消息区 toolMeta）与默认折叠判定（纯函数）
    const toolMeta = typeof extras.toolMeta === 'function' ? extras.toolMeta : null;
    const agvToolDefaultCollapsed = typeof extras.agvToolDefaultCollapsed === 'function'
        ? extras.agvToolDefaultCollapsed
        : (name, text) => String(text || '').length > 400;
    // 运行态注册表（宿主构造块里的 const Map，稳定活引用）
    const subAgents = extras.subAgents;
    const subAgentRecords = extras.subAgentRecords;
    const subAgentTranscripts = extras.subAgentTranscripts;
    // 运行时动作与 HUD 徽标（宿主后定义，惰性箭头延迟解析）
    const steerSubAgent = extras.steerSubAgent;
    const queueSubAgentMessage = extras.queueSubAgentMessage;
    const reviveSubAgent = extras.reviveSubAgent;
    const stopSubAgent = extras.stopSubAgent;
    // 用户手动停止：连同它派出的下级一起停（自停 / 循环守卫自动停止不走这里）
    const stopSubAgentDeep = typeof extras.stopSubAgentDeep === 'function' ? extras.stopSubAgentDeep : stopSubAgent;
    const startSubCompact = extras.startSubCompact;
    const agentStateBadge = extras.agentStateBadge;
    // 磁盘转录补读（宿主注入）：重启后内存里的转录没了，但 ai-artifacts 里还留着落盘副本。
    // 只在「内存没块且拿得到 agentId + 父会话」时试一次，读到就填回内存缓存再重渲染。
    const loadAgentTranscript = typeof extras.loadAgentTranscript === 'function' ? extras.loadAgentTranscript : null;
    const transcriptLoads = new Set();
    const transcriptLoadsFailed = new Set();

    // 详情视图挂载点：主窗口是内容区标签页、悬浮窗是面板内覆盖层。每个挂载点一个 view 对象，
    // 同一子代理可同时开多处（标签页 + 悬浮窗），各自独立节流渲染。
    const agentViews = new Set();
    let overlayView = null;           // 悬浮窗覆盖层上的那个挂载点（最多一个）

    // ---- 子代理详情视图（内容区标签页；悬浮窗退回面板内覆盖层） ----
    // 视图不再占满 AI 面板：主窗口点开「智能体团队」的一行 → 内容区标签页（可与主对话并排、
    // 输入框不被遮挡）；悬浮窗没有内容区，仍用 #ai-agent-view 覆盖层。
    // 正文按「块 + 内容签名」增量渲染：子代理流式输出时只重写变化的块——整段重建会销毁
    // mermaid / echarts / svg 卡片的 Shadow DOM，并把滚动位置拉回底部（实测每 300ms 一次）。

    function agentBlock(className, contentText, markdown) {
        const div = document.createElement('div');
        div.className = className;
        if (markdown) div.innerHTML = renderMarkdown(contentText || '');
        else div.textContent = contentText || '';
        return div;
    }

    // 工具行：动词 + 图标 + 主参数 + 可折叠输出（与主消息区工具卡同款信息密度）。
    // 视图是只读速览，超长输出截断（完整输出在父会话的工具卡里）。折叠态存在节点 class 上：
    // 块节点按 key 持久复用，重渲染只改文本、不动 class，用户的开合选择跨 300ms 刷新自动保留。
    const AGV_TOOL_TEXT_MAX = 4000;

    function agentToolRow(block) {
        const row = document.createElement('div');
        row.className = 'ai-agv-tool';
        const head = document.createElement('button');
        head.type = 'button';
        head.className = 'ai-agv-tool-head';
        const icon = document.createElement('span');
        icon.className = 'ai-agv-tool-icon';
        const verb = document.createElement('span');
        verb.className = 'ai-agv-tool-verb';
        const label = document.createElement('span');
        label.className = 'ai-agv-tool-name';
        const chev = document.createElement('span');
        chev.className = 'ai-agv-tool-chev';
        chev.innerHTML = iconSvg('chevron-down', 12);
        head.append(icon, verb, label, chev);
        head.addEventListener('click', () => {
            row.classList.toggle('collapsed');
            // 展开后内容变高：贴底态下补一次底（按所属 view 找滚动状态，多挂载点互不串扰）
            const owner = toolRowOwner.get(row);
            if (owner) refollowAfterToolToggle(owner);
        });
        const body = document.createElement('div');
        body.className = 'ai-agv-tool-body';
        const pre = document.createElement('pre');
        body.appendChild(pre);
        row.append(head, body);
        if (agvToolDefaultCollapsed(block.name, block.text)) row.classList.add('collapsed');
        fillAgentToolRow(row, block || {});
        return row;
    }

    // 工具行 → 所属 view（多挂载点下按行反查，避免折叠点击串到别的 view 的滚动状态）
    const toolRowOwner = new WeakMap();

    function fillAgentToolRow(row, block) {
        const failed = !!(block && block.error);
        // 用 classList.toggle 而非重写 className：保住用户的折叠态（collapsed）
        row.classList.toggle('error', failed);
        const icon = row.querySelector('.ai-agv-tool-icon');
        const verb = row.querySelector('.ai-agv-tool-verb');
        const label = row.querySelector('.ai-agv-tool-name');
        const meta = toolMeta ? toolMeta(block.name || 'tool', null) : null;
        if (icon) icon.innerHTML = meta && meta.icon ? iconSvg(meta.icon, 13) : '';
        if (verb) verb.textContent = meta && meta.verb ? meta.verb : '';
        if (label) {
            const suffix = failed ? ' · 失败' : '';
            label.textContent = (block.arg ? block.arg : (block.name || 'tool')) + suffix;
            label.dataset.tip = block.name || 'tool';
        }
        const pre = row.querySelector('pre');
        if (!pre) return;
        const raw = String(block.text || '');
        const cut = raw.length > AGV_TOOL_TEXT_MAX;
        pre.textContent = cut ? raw.slice(0, AGV_TOOL_TEXT_MAX) + '\n…（输出过长，已截断）' : raw;
    }

    // 正文块模型：user / assistant / tool / summary / inbox / tip。
    // key 稳定（消息下标、转录下标或固定名），内容签名变化才重写节点——增量渲染的唯一依据。
    function agentInboxBlock(sub) {
        const inbox = sub.inbox || {step: [], turn: [], ask: null};
        const stepN = (inbox.step || []).length;
        const turnN = (inbox.turn || []).length;
        if (!stepN && !turnN && !inbox.ask) return null;
        const lines = [...(inbox.step || []), ...(inbox.turn || [])].slice(0, 3).map((item) =>
            (item.from === 'user' ? '用户：' : (item.from === 'subagent' ? '下级：' : '上级：')) +
            String(item.text || '').slice(0, 90));
        const ask = inbox.ask ? '等待主代理回答提问（askId=' + (inbox.ask.askId || '') + '）' : '';
        return {
            key: 'inbox',
            kind: 'inbox',
            title: '收件箱 · 排队 ' + turnN + ' 条 · 插队 ' + stepN + ' 条',
            lines,
            ask,
            // 签名只认可见内容：条数变化而文本相同时不必重写
            text: lines.join('\n') + '|' + ask,
        };
    }

    function agentBlocksOf(view) {
        const sub = view.subId ? subAgents.get(view.subId) : null;
        if (sub) {
            const blocks = agentMessageBlocks(sub.session && sub.session.messages);
            const inbox = agentInboxBlock(sub);
            if (inbox) blocks.push(inbox);
            return {blocks, live: true, sub};
        }
        // 终态记录：会话还在内存（done 可续 / 本轮刚收尾）就继续用消息块，别切成「摘要 + 转录」。
        // 两套模型交替 = 每次收尾/唤醒都整段换块，滚动位置与图表卡片全丢（见 agentRecordBlocks）。
        const rec = view.subId ? subAgentRecords.get(view.subId) : null;
        const recMessages = rec && rec.session ? rec.session.messages : null;
        if (recMessages && recMessages.length) {
            return {blocks: agentRecordBlocks(recMessages, rec.summary), live: false, sub: null};
        }
        // 退路：上下文已回收 / 应用重启后内存里没有会话，只剩摘要与转录
        const meta = agentStatusMeta(view);
        const summary = meta && meta.summary ? String(meta.summary) : '';
        const transcript = view.toolCallId ? subAgentTranscripts.get(view.toolCallId) : null;
        const blocks = [];
        if (summary) blocks.push({key: 'summary', kind: 'summary', text: summary});
        if (summary && transcript && transcript.length) {
            blocks.push({key: 'transcript-label', kind: 'label', text: '过程转录'});
        }
        blocks.push(...agentTranscriptBlocks(transcript));
        // 内存里没有转录时，试一次磁盘补读（每个 subId 只试一次，读到就重渲染）。
        // 这是「应用重启后」唯一的还原路径：会话 JSONL 里只剩 toolMessage.agent 的 id，
        // 转录正文在 ai-artifacts/<父会话>/sub-<agentId>.txt。
        if (!transcript || !transcript.length) {
            const agentId = String(view.subId || '');
            const loading = kickTranscriptLoad(view);
            if (!blocks.length) {
                blocks.push({
                    key: 'empty',
                    kind: 'tip',
                    text: loading
                        ? '正在读取磁盘转录…'
                        : (transcriptLoadsFailed.has(agentId)
                            ? '磁盘上没有找到这台子代理的转录（可能未落盘或缓存已被清理）；只保留状态与结论摘要。'
                            : '应用重启后子代理只保留状态与结论摘要；本次没有可显示的转录。'),
                });
            }
        }
        return {blocks, live: false, sub: null};
    }

    // 补读磁盘转录：返回 true 表示「已发起，正在读」。禁止并发重复发起，也不重试失败——
    // 但失败要落一个标记并重渲染一次，否则「正在读取」永远不收敛（读回为空也算失败）。
    function kickTranscriptLoad(view) {
        if (!loadAgentTranscript) return false;
        const agentId = String((view && view.subId) || '');
        const sessionId = String((view && (view.agentArtifactDir || view.parentSessionId || view.sessionId)) || '');
        if (!agentId || !sessionId) return false;
        if (transcriptLoads.has(agentId)) return false;
        transcriptLoads.add(agentId);
        Promise.resolve(loadAgentTranscript(sessionId, agentId))
            .then((entries) => {
                if (entries && entries.length) {
                    if (view.toolCallId) subAgentTranscripts.set(view.toolCallId, entries);
                } else {
                    // 没读到：记下来，agentBlocksOf 下次走「没有可显示的转录」的兜底文案
                    transcriptLoadsFailed.add(agentId);
                }
                scheduleAgentViewRender(view);
            })
            .catch(() => {
                transcriptLoadsFailed.add(agentId);
                scheduleAgentViewRender(view);
            });
        return true;
    }

    function createAgentBlockNode(block) {
        if (block.kind === 'assistant') return agentBlock('ai-agv-msg', '', true);
        if (block.kind === 'user') return agentBlock('ai-agv-user', '', false);
        if (block.kind === 'tip') return agentBlock('ai-agv-live-tip', '', false);
        if (block.kind === 'label') return agentBlock('ai-agv-summary-title', '', false);
        if (block.kind === 'tool') return agentToolRow(block);
        if (block.kind === 'summary') {
            const wrap = document.createElement('div');
            wrap.className = 'ai-agv-summary';
            const title = document.createElement('div');
            title.className = 'ai-agv-summary-title';
            title.textContent = '最终结论';
            const body = document.createElement('div');
            body.className = 'ai-agv-msg';
            wrap.append(title, body);
            return wrap;
        }
        // inbox：标题 + 逐条预览 + 提问挂起提示（与面板里的收件箱预览同款信息）
        const box = document.createElement('div');
        box.className = 'ai-agv-inbox';
        const title = document.createElement('div');
        title.className = 'ai-agv-inbox-title';
        box.appendChild(title);
        for (let i = 0; i < 3; i += 1) {
            const line = document.createElement('div');
            line.className = 'ai-agv-inbox-line';
            line.hidden = true;
            box.appendChild(line);
        }
        const ask = document.createElement('div');
        ask.className = 'ai-agv-inbox-ask';
        ask.hidden = true;
        box.appendChild(ask);
        return box;
    }

    function fillAgentBlockNode(node, block, streaming) {
        if (block.kind === 'tool') {
            fillAgentToolRow(node, block);
            return;
        }
        if (block.kind === 'inbox') {
            const title = node.querySelector('.ai-agv-inbox-title');
            if (title) title.textContent = block.title || '';
            const lines = [...node.querySelectorAll('.ai-agv-inbox-line')];
            lines.forEach((line, i) => {
                const text = (block.lines || [])[i];
                line.hidden = text == null;
                line.textContent = text == null ? '' : text;
            });
            const ask = node.querySelector('.ai-agv-inbox-ask');
            if (ask) {
                ask.hidden = !block.ask;
                ask.textContent = block.ask || '';
            }
            return;
        }
        if (block.kind === 'summary') {
            const body = node.querySelector('.ai-agv-msg');
            if (!body) return;
            paintAgentMarkdown(body, block.text, streaming);
            return;
        }
        if (block.kind === 'assistant') {
            paintAgentMarkdown(node, block.text, streaming);
            return;
        }
        node.textContent = block.text || '';
    }

    // 子代理正文与主消息区走同一条渲染链：Markdown → 代码块复制钮 → 本地图片 → 可视化卡片
    // （mermaid / echarts / svg / html / 关系图 / 词云）。缺了增强链，围栏只会剩一块源码占位。
    function paintAgentMarkdown(node, text, streaming) {
        node.innerHTML = renderMarkdown(text || '');
        if (enhanceAnswerBody) enhanceAnswerBody(node, {streaming: !!streaming});
    }

    function syncAgentBlocks(view, body, state) {
        // 先把阅读位置记下来，再动 DOM：块被删 / 整段换模型时长内容会瞬间缩短，
        // 浏览器会把 scrollTop 钳到新上限（内容短到一屏时直接钳成 0）。只在「原来就在底部」
        // 时吸附是不够的——上翻读的时候也会被钳走，表现就是滚动条自己往顶部跑。
        const prevTop = body.scrollTop;
        // 标签页在后台（display:none）时布局盒为 0：此时任何 scrollTop 写入都会被压成 0，
        // 等切回前台再看就「到顶了」。没有布局盒就只更新 DOM，不碰滚动。
        const measurable = body.clientHeight > 0 && body.scrollHeight > 0;
        // 首帧一律跟到底部：刚打开详情时正文常常一屏放不下（长派单提示词），此时 scrollTop=0
        // 会被误算成「用户在上翻」，于是整轮都不再跟随——表现就是滚动条一直卡在顶部，
        // 内容却还在下面长。落地之后才交由用户的真实位置决定。
        // 后续帧用通用手势判定（ai-scroll-follow）：只有用户手势里的上滚才解除贴底，
        // 工具卡展开/内容重排导致的 scrollTop 变化不算上翻（旧的手写「距底<60」会被骗）。
        const pinned = !view.scrollReady || !measurable || view.stick.stickBottom;
        const blocks = state.blocks;
        const seen = new Set();
        let cursor = body.firstElementChild;
        blocks.forEach((block, index) => {
            seen.add(block.key);
            let node = view.blockNodes.get(block.key);
            if (!node) {
                node = createAgentBlockNode(block);
                node.dataset.agvKey = block.key;
                // 工具行记下所属 view：折叠点击据此找滚动状态（多挂载点互不串扰）
                if (block.kind === 'tool') toolRowOwner.set(node, view);
                view.blockNodes.set(block.key, node);
            }
            // 只在「最后一块且子代理仍在跑」时按生成中处理：可视化卡片先占位不建实例
            const streaming = state.live && index === blocks.length - 1 && block.kind === 'assistant';
            const sig = agentBlockSig(block, streaming);
            if (node.dataset.agvSig !== sig) {
                node.dataset.agvSig = sig;
                fillAgentBlockNode(node, block, streaming);
            }
            // 块只追加，正常情况就地命中；万一乱序才搬一次（搬动会重置节点动画，别写成每帧都搬）
            if (node !== cursor) body.insertBefore(node, cursor || null);
            cursor = node.nextElementSibling;
        });
        for (const [key, node] of [...view.blockNodes]) {
            if (seen.has(key)) continue;
            view.blockNodes.delete(key);
            node.remove();
        }
        if (!measurable) return;
        if (pinned) {
            body.scrollTop = body.scrollHeight;
        } else if (body.scrollTop !== prevTop) {
            // 上翻读时把位置还回去（超出新上限会自动钳到 max，不会凭空回到顶部）
            body.scrollTop = prevTop;
        }
        // 同步「上一帧位置」：滚动监听用它区分用户上滚与布局变化（首帧 DOM 刚落地，
        // 以实际写回的 scrollTop 为准，避免把首帧吸附误判成用户滚动）
        view.scrollLastTop = body.scrollTop;
        view.scrollGesture.reset();
        view.scrollReady = true;
    }

    // 正文滚动监听：只有用户手势（滚轮 / 触摸 / 滚动条拖拽）里的上滚才解除贴底。
    // 判定收在 ai-scroll-follow.js，与主消息区同一口径——工具卡展开 / 内容重排导致的
    // scrollTop 变化不算上翻，避免「展开一个工具卡后再也不跟随触底」。
    function bindAgentScroll(view, body) {
        if (view.scrollBound) return;
        view.scrollBound = true;
        const onScroll = () => {
            const top = body.scrollTop;
            const distance = body.scrollHeight - top - body.clientHeight;
            const shrunk = top < view.scrollLastTop - 0.5;
            const byUser = view.scrollGesture.active();
            const next = nextStickState(
                {stickBottom: view.stick.stickBottom, lastTop: view.scrollLastTop, byUser},
                {top, distance},
            );
            view.stick.stickBottom = next.stickBottom;
            view.scrollLastTop = top;
        };
        const onWheel = () => view.scrollGesture.note();
        const onTouchStart = () => view.scrollGesture.begin();
        const onTouchMove = () => view.scrollGesture.note();
        const onTouchEnd = () => view.scrollGesture.end();
        body.addEventListener('scroll', onScroll, {passive: true});
        body.addEventListener('wheel', onWheel, {passive: true});
        body.addEventListener('touchstart', onTouchStart, {passive: true});
        body.addEventListener('touchmove', onTouchMove, {passive: true});
        body.addEventListener('touchend', onTouchEnd, {passive: true});
        body.addEventListener('touchcancel', onTouchEnd, {passive: true});
        view.scrollCleanup = () => {
            body.removeEventListener('scroll', onScroll);
            body.removeEventListener('wheel', onWheel);
            body.removeEventListener('touchstart', onTouchStart);
            body.removeEventListener('touchmove', onTouchMove);
            body.removeEventListener('touchend', onTouchEnd);
            body.removeEventListener('touchcancel', onTouchEnd);
        };
    }

    // 工具卡展开导致内容变高：贴底态下补一次底（手势判定在 scroll 事件里已更新 stick）
    function refollowAfterToolToggle(view) {
        if (!view || !view.stick.stickBottom || view.scrollGesture.active()) return;
        const body = view.body;
        // 等展开后的布局收敛再补底（display:none 切换 / CSS display:block 需一帧）
        requestAnimationFrame(() => {
            if (view.stick.stickBottom && body && body.clientHeight > 0) body.scrollTop = body.scrollHeight;
        });
    }

    function agentStatusMeta(view) {
        const sub = view && view.subId ? subAgents.get(view.subId) : null;
        if (sub) {
            return {
                state: 'running',
                rounds: sub.flow ? sub.flow.roundNo : 0,
                ms: Math.max(0, Date.now() - sub.startedAt),
                tokens: sub.flow && sub.flow.usage ? (Number(sub.flow.usage.totalTokens) || 0) : 0,
                summary: '',
            };
        }
        // 终态记录（含可冷唤醒的 done）：比 registry 与持久化 meta 都新
        const rec = view && view.subId ? subAgentRecords.get(view.subId) : null;
        if (rec) {
            return {
                state: rec.state,
                rounds: rec.rounds,
                ms: rec.ms,
                tokens: rec.tokens,
                summary: rec.summary,
                mode: rec.mode,
                continuable: rec.continuable,
            };
        }
        const meta = view && view.toolCallId ? agentRegistry.get(view.toolCallId) : null;
        if (meta) return meta;
        // 内存正文兜底：先扫「打开详情时所在的那个会话」，再扫其余**已载体的**会话
        //（懒加载占位没有正文，扫也扫不到；旧实现会白扫几十个空数组）
        const owner = view && view.sessionId ? sessionById(view.sessionId) : null;
        const order = [];
        if (owner) order.push(owner);
        for (const session of getSessions()) {
            if (session !== owner && !session._stub) order.push(session);
        }
        for (const session of order) {
            for (const m of session.messages) {
                const key = (m.agent && m.agent.key) || m.toolCallId;
                if (m.role === 'tool' && m.name === 'spawn_agent' && key === view.toolCallId && m.agent) return m.agent;
            }
        }
        // 所属会话还是占位（启动后没点开过它）：只补这一个会话，补完重画一次头部。
        // 一次单文件读，不会变成「为了一个徽标扫全部会话」。
        if (owner && owner._stub) requestAgentRecordHydrate(view, owner);
        return null;
    }

    // 已发起过「补所属会话」的视图（key = subId / toolCallId），避免每次重画都读一次盘
    const agentRecordHydrateTried = new Set();

    function requestAgentRecordHydrate(view, session) {
        const key = String((view && (view.subId || view.toolCallId)) || '');
        if (!key || agentRecordHydrateTried.has(key)) return;
        agentRecordHydrateTried.add(key);
        Promise.resolve(ensureSessionLoaded(session))
            .then((ok) => { if (ok) scheduleAgentViewRender(view); })
            .catch(() => {});
    }

    // 子代理的父级信息（详情头部面包屑 + 标签页 tooltip 共用）：嵌套时父是另一个子代理，
    // 顶层时父是主会话。查不到（记录被 LRU 回收 / 重启后只剩摘要）就退回「父会话」。
    function agentParentInfo(view) {
        const sub = view && view.subId ? subAgents.get(view.subId) : null;
        const rec = !sub && view && view.subId ? subAgentRecords.get(view.subId) : null;
        const source = sub || rec;
        const depth = (source && source.depth) || (view && view.depth) || 1;
        const parentId = String((source && source.parentSessionId) || (view && view.parentSessionId) || '');
        if (!parentId) return {label: '', depth};
        const parentSub = subAgents.get(parentId);
        if (parentSub && parentSub.name) return {label: parentSub.name, depth, nested: true};
        const parentRec = subAgentRecords.get(parentId);
        if (parentRec && parentRec.name) return {label: parentRec.name, depth, nested: true};
        const parentSession = sessionById(parentId);
        if (parentSession) {
            const title = String(parentSession.title || '').trim() || '新会话';
            return {label: title, depth, nested: false};
        }
        return {label: '父会话', depth};
    }

    // 头部每次重建（按钮随状态增删，代价很小）；正文与输入行是持久节点，正文内部再按块增量。
    function renderAgentHead(view, head) {
        head.textContent = '';
        const meta = agentStatusMeta(view);
        // 覆盖层没有标签栏，需要一个回主代理的出口；标签页靠关标签即可
        if (view.overlay) {
            const back = document.createElement('button');
            back.type = 'button';
            back.className = 'ai-icon-btn';
            back.dataset.tip = '返回主代理';
            back.setAttribute('aria-label', '返回主代理');
            back.innerHTML = iconSvg('back', 14);
            back.addEventListener('click', closeAgentView);
            head.appendChild(back);
        }
        const nameWrap = document.createElement('span');
        nameWrap.className = 'ai-agent-view-title';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'ai-agent-view-name';
        nameSpan.textContent = view.name;
        nameWrap.appendChild(nameSpan);
        const parent = agentParentInfo(view);
        if (parent.label) {
            const crumb = document.createElement('span');
            crumb.className = 'ai-agent-view-parent';
            crumb.dataset.tip = parent.nested ? '父代理' : '所属会话';
            crumb.textContent = parent.label;
            nameWrap.appendChild(crumb);
        }
        // 层号走 agentLevelText 单一来源（内部 depth 主代理为 0，人读层号 +1）。
        // 徽标判定与标签 ↳ 记号同一口径：有父级（非主代理）就显示，避免「tooltip 有父级行但标签无 ↳」。
        if (parent.depth >= 1) {
            const lvl = document.createElement('span');
            lvl.className = 'ai-agent-view-depth';
            lvl.dataset.tip = '嵌套层级';
            lvl.textContent = agentLevelText(parent.depth);
            nameWrap.appendChild(lvl);
        }
        head.appendChild(nameWrap);
        if (meta) head.appendChild(agentStateBadge(meta.state));
        const liveSub = view.subId ? subAgents.get(view.subId) : null;
        const metaLine = document.createElement('span');
        metaLine.className = 'ai-agent-view-meta';
        const bits = [];
        if (meta && meta.rounds) bits.push('轮次 ' + meta.rounds);
        if (meta && meta.ms) bits.push(Math.max(1, Math.round(meta.ms / 1000)) + 's');
        if (meta && meta.tokens) bits.push((meta.tokens / 1000).toFixed(1) + 'k tok');
        if (meta && meta.mode === 'background') bits.push('后台');
        if (liveSub && liveSub.compacting) bits.push('压缩中');
        if (meta && meta.continuable === false) bits.push('上下文已回收');
        metaLine.textContent = bits.join(' · ');
        head.appendChild(metaLine);
        // 手动压缩入口：运行中 → 请求在下一轮边界执行；done 可续记录 → 立即压缩
        if (liveSub && liveSub.state === 'running' && !liveSub.compacting) {
            const compactBtn = document.createElement('button');
            compactBtn.type = 'button';
            compactBtn.className = 'ai-icon-btn ai-agv-compact';
            compactBtn.setAttribute('aria-label', '压缩上下文');
            compactBtn.innerHTML = iconSvg('eraser', 13);
            compactBtn.addEventListener('click', () => {
                liveSub.compactRequested = true;
                flash('已请求压缩：当前工具轮结束后执行');
                renderAgentView(view);
            });
            head.appendChild(compactBtn);
        } else if (!liveSub && view.subId) {
            const record = subAgentRecords.get(view.subId);
            const compactable = record && canReviveRecord(record).ok && !(record.session && record.session.summary);
            if (compactable) {
                const compactBtn = document.createElement('button');
                compactBtn.type = 'button';
                compactBtn.className = 'ai-icon-btn ai-agv-compact';
                compactBtn.setAttribute('aria-label', '压缩上下文');
                compactBtn.innerHTML = iconSvg('eraser', 13);
                compactBtn.addEventListener('click', () => {
                    startSubCompact(record, {auto: false});
                    flash('已发起压缩：完成后唤醒将以精简上下文继续');
                    renderAgentView(view);
                });
                head.appendChild(compactBtn);
            }
        }
        // 后台子代理的结束时机独立于主回合：详情视图必须有手动停止入口（§4.6）
        if (liveSub && liveSub.state === 'running') {
            const stopBtn = document.createElement('button');
            stopBtn.type = 'button';
            stopBtn.className = 'ai-icon-btn ai-agv-stop';
            stopBtn.setAttribute('aria-label', '停止子代理');
            stopBtn.innerHTML = iconSvg('stop', 13);
            stopBtn.addEventListener('click', () => {
                // 手动停止 = 连同它派出的子代理 / 孙代理递归停掉，避免留下没人收结论的孤儿任务
                stopSubAgentDeep(liveSub, '用户在详情视图停止');
                renderAgentView(view);
            });
            head.appendChild(stopBtn);
        }
    }

    function renderAgentView(view) {
        if (!view || !view.root) return;
        const root = view.root;
        if (!view.head) {
            view.head = document.createElement('div');
            view.head.className = 'ai-agent-view-head';
        }
        if (!view.body) {
            view.body = document.createElement('div');
            view.body.className = 'ai-agent-view-body';
        }
        bindAgentScroll(view, view.body);
        renderAgentHead(view, view.head);
        // 结构固定为「头部 → 正文 → 输入行」；正文节点常驻，内部按块增量更新
        if (root.firstElementChild !== view.head) root.insertBefore(view.head, root.firstElementChild);
        if (view.head.nextElementSibling !== view.body) root.insertBefore(view.body, view.head.nextElementSibling);
        // 输入行先就位（独立节点，重渲染不重建——重建会丢焦点与草稿）。必须排在正文同步之前：
        // 首帧吸附要按「已经扣掉输入行」的正文高度算，否则会差一截（实测 36~40px）停不到底。
        const composer = ensureAgentViewComposer(view);
        if (composer) {
            if (root.lastElementChild !== composer) root.appendChild(composer);
        } else {
            const stale = root.querySelector('.ai-agv-composer');
            if (stale) stale.remove();
        }
        syncAgentBlocks(view, view.body, agentBlocksOf(view));
    }

    // 子代理对话视图的输入行（F3）：Enter 排队 / Ctrl+Enter 插队；对已完成且可续的子代理
    // 输入即冷唤醒入口；失败/停止/上下文已回收的记录禁用并说明原因。
    // 节点挂在 view 上复用——运行中的详情视图每 300ms 重渲染，重建输入框会丢焦点与草稿。
    function ensureAgentViewComposer(view) {
        const key = view.subId || '';
        const live = key ? subAgents.get(key) : null;
        const record = !live && key ? subAgentRecords.get(key) : null;
        const target = live || record;
        if (!target) {
            view.composer = null;
            return null;
        }
        const gate = live ? {ok: true, reason: ''} : canReviveRecord(record);
        const canType = gate.ok;
        const stateText = {running: '运行中', done: '已完成', error: '失败', stopped: '已停止'}[live ? 'running' : record.state] || '';
        let wrap = view.composer && view.composer.subId === key ? view.composer.el : null;
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.className = 'ai-agv-composer';
            // 表单控件走工厂（docs/frontend-form-controls.md）：className 覆盖默认封装 class，
            // 外观由 .ai-agv-input 自己适配详情视图的紧凑行
            const input = createTextarea({className: 'ai-agv-input', rows: 1, spellcheck: false}).control;
            const send = document.createElement('button');
            send.type = 'button';
            send.className = 'ai-agv-send';
            send.textContent = '发送';
            const submit = (urgent) => {
                const text = String(input.value || '').trim();
                if (!text) return;
                const current = view.subId ? subAgents.get(view.subId) : null;
                const rec = !current && view.subId ? subAgentRecords.get(view.subId) : null;
                if (current) {
                    if (urgent) {
                        const r = steerSubAgent(current, text, {from: 'user'});
                        flash(r.degraded ? '它正在压缩上下文，消息已排队（压缩完成后消费）' : '已插队：打断当前生成，消息在下一步最前注入');
                    } else {
                        queueSubAgentMessage(current, text, {from: 'user'});
                        flash('已排队：子代理下一轮可见');
                    }
                } else if (rec) {
                    const revived = reviveSubAgent(rec, text, {from: 'user', urgent});
                    flash(revived ? '已唤醒子代理「' + revived.name + '」，消息已投递' : '唤醒失败：上下文不可用，请重新派单', !revived);
                }
                input.value = '';
                renderAgentView(view);
            };
            input.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' || e.shiftKey) return;
                e.preventDefault();
                submit(e.ctrlKey || e.metaKey);
            });
            send.addEventListener('click', () => submit(false));
            wrap.append(input, send);
            view.composer = {subId: key, el: wrap};
        }
        // 状态可能变（running → done / 被停止）：每次渲染同步可用性与文案
        const input = wrap.querySelector('.ai-agv-input');
        const send = wrap.querySelector('.ai-agv-send');
        if (input) {
            input.disabled = !canType;
            input.placeholder = !canType
                ? (gate.reason === 'recycled'
                    ? '上下文已回收（终态记录超出上限），无法继续'
                    : '该子代理已' + stateText + '，不能再接收消息')
                : (live ? '给子代理补充线索：Enter 排队 · Ctrl+Enter 插队' : '它已完成，发消息会唤醒它继续：Enter 发送');
        }
        if (send) send.disabled = !canType;
        wrap.classList.toggle('disabled', !canType);
        return wrap;
    }

    function scheduleAgentViewRender(view) {
        if (!view || view.timer) return;
        view.timer = setTimeout(() => {
            view.timer = 0;
            renderAgentView(view);
        }, 300);
    }

    // 子代理状态事件带的是它的注册表 key（见 listAgentsForHud 的 toolCallId: sub.key）
    function refreshAgentViewIfOpen(agentKey) {
        if (!agentKey) return;
        for (const view of agentViews) {
            if (view.toolCallId === agentKey) scheduleAgentViewRender(view);
        }
    }

    // 挂载视图到任意宿主节点（内容区标签页 / 悬浮窗覆盖层）。同一节点重复挂载先清旧的，
    // 同一子代理可以同时挂在多处，各自独立节流。
    function mountAgentView(root, spec) {
        if (!root) return null;
        unmountAgentView(root);
        root.textContent = '';
        const view = {
            root,
            overlay: !!(spec && spec.overlay),
            toolCallId: String((spec && spec.toolCallId) || ''),
            subId: String((spec && spec.subId) || ''),
            name: String((spec && spec.name) || '子代理'),
            // 详情所在的会话：头部状态兜底要靠它的正文（懒加载下别的会话可能只有 meta）
            sessionId: String((spec && spec.sessionId) || ''),
            // 父级信息（openAgentView 已算好；直接 mount 时 renderAgentHead 会自己再算一次）
            parentLabel: String((spec && spec.parentLabel) || ''),
            depth: Number((spec && spec.depth) || 0) || 0,
            // 记录被 LRU 回收后 agentParentInfo 靠它回落到父会话标题
            parentSessionId: String((spec && spec.parentSessionId) || ''),
            timer: 0,
            head: null,
            body: null,
            composer: null,
            blockNodes: new Map(),
            // 首帧是否已落地（syncAgentBlocks 里决定「跟到底部」还是「尊重用户位置」）
            scrollReady: false,
            // 滚动贴底跟随（ai-scroll-follow 单一来源）：只有用户手势里的上滚才解除贴底
            stick: {stickBottom: true},
            scrollLastTop: 0,
            scrollGesture: createScrollGesture(),
            scrollBound: false,
            scrollCleanup: null,
        };
        agentViews.add(view);
        renderAgentView(view);
        return view;
    }

    function unmountAgentView(root) {
        let removed = false;
        for (const view of [...agentViews]) {
            if (view.root !== root) continue;
            if (view.timer) {
                clearTimeout(view.timer);
                view.timer = 0;
            }
            if (view.scrollCleanup) { view.scrollCleanup(); view.scrollCleanup = null; }
            view.scrollGesture.reset();
            agentViews.delete(view);
            removed = true;
        }
        return removed;
    }

    // 详情视图入口：主窗口在内容区标签页打开（不遮挡面板，可与主对话并排看），
    // 悬浮窗没有内容区，退回面板内覆盖层（原来的做法）。
    function openAgentView(spec) {
        const target = {
            toolCallId: String((spec && spec.toolCallId) || ''),
            subId: String((spec && spec.subId) || ''),
            name: String((spec && spec.name) || '子代理'),
            sessionId: String((spec && spec.sessionId) || ''),
        };
        if (!target.toolCallId && !target.subId) return;
        // 父级信息（标签页 tooltip / 详情头部面包屑共用）：调用方（HUD chips / 团队视图）不必各自算
        const parent = agentParentInfo(target);
        target.parentLabel = parent.label;
        target.depth = parent.depth;
        // 透传 parentSessionId：记录被 LRU 回收后 agentParentInfo 仍能靠它回落到父会话标题
        const source = target.subId ? (subAgents.get(target.subId) || subAgentRecords.get(target.subId)) : null;
        target.parentSessionId = String((source && source.parentSessionId) || '');
        // 磁盘转录的分桶 id：落盘时用的是根会话（嵌套代理的 parentSessionId 是上层子代理
        // 的会话 id，对不上桶）。记录里有 rootSessionId，运行态有 artifactDir，都没有再回落。
        target.agentArtifactDir = String((source && (source.artifactDir || source.rootSessionId)) || '');
        const liveSub = target.subId ? subAgents.get(target.subId) : null;
        const rec = !liveSub && target.subId ? subAgentRecords.get(target.subId) : null;
        target.task = String((liveSub && liveSub.task) || (rec && rec.task) || '');
        if (!isFloatWindow() && typeof openAgentTab === 'function') {
            if (openAgentTab(target)) return;
        }
        if (!el.agentView) return;
        el.agentView.classList.remove('hidden');
        overlayView = mountAgentView(el.agentView, {...target, overlay: true});
    }

    function closeAgentView() {
        if (overlayView) unmountAgentView(overlayView.root);
        overlayView = null;
        if (el.agentView) {
            el.agentView.classList.add('hidden');
            el.agentView.textContent = '';
        }
    }

    return {
        agentViews,
        scheduleAgentViewRender, refreshAgentViewIfOpen,
        renderAgentView, openAgentView, closeAgentView,
        mountAgentView, unmountAgentView,
    };
}
