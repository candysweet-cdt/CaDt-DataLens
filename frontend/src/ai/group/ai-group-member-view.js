// ai-group-member-view.js：群聊成员详情视图（G6）——像子代理详情一样的标签页正文，
// 展示单个成员的实时流、上下文占用、私有过程（仅你可见）与发言记录，并提供
// 请发言 / 静音 / 停止 / 打开群聊动作。挂载点由 bridge-group-member-view 提供（内容区标签页）。
// 数据来自 runtime（subscribe + groupById / activeStreamOf / discussionSnapshot / store.privateRead）。
import {createInput} from '../../core/form-controls.js';
import {el} from '../../core/dom.js';
import {agentCapability} from '../agent/ai-agent-model.js';
import {STANCE_LABELS, stripHandoffMarker} from './ai-group-model.js';
import {parsePrivateSteps} from './ai-group-store.js';
import {memberColorHex, memberInitial, timeLabel} from './ai-group-ui-model.js';

const REFRESH_THROTTLE_MS = 200;
// 私有过程 / 发言记录最多展示的条数（更早的仍在本机日志里，不删）
const PRIVATE_STEPS_MAX = 20;
const SPEECH_HISTORY_MAX = 30;

export function createAIGroupMemberView(deps) {
    const runtime = deps.runtime;
    const getAIConfig = deps.getAIConfig || (() => null);
    const renderMarkdown = typeof deps.renderMarkdown === 'function' ? deps.renderMarkdown : null;
    const enhanceAnswerBody = typeof deps.enhanceAnswerBody === 'function' ? deps.enhanceAnswerBody : null;
    const flash = deps.flash || ((message) => console.warn('[group-member]', message));
    // 「打开群聊」：main 注入，把 AI 面板切回该群视图
    const openGroupView = typeof deps.openGroupView === 'function' ? deps.openGroupView : null;

    const views = new Set();

    function memberViews() {
        return views;
    }

    // 与子代理详情同款契约：mount/unmount 任意宿主节点（同一成员可同时挂在多处）
    function mountMemberView(root, spec) {
        if (!root) return null;
        unmountMemberView(root);
        root.textContent = '';
        const groupId = String((spec && spec.groupId) || '');
        const agentId = String((spec && spec.agentId) || '');
        if (!groupId || !agentId) {
            root.appendChild(el('div', 'gm-empty', '缺少群聊或成员标识，无法打开详情。'));
            return null;
        }
        const view = {
            root,
            groupId,
            agentId,
            name: String((spec && spec.name) || ''),
            groupTitle: String((spec && spec.groupTitle) || ''),
            timer: 0,
            unsub: null,
            dead: false,
            head: null,
            body: null,
            liveBox: null,
            liveSig: '',
            ctxBox: null,
            privateBox: null,
            privateSig: '',
            privateSteps: null,
            privateLoading: false,
            historyBox: null,
            historySig: '',
            lastPaint: 0,
        };
        views.add(view);
        buildDom(view);
        renderNow(view);
        view.unsub = runtime.subscribe(() => scheduleRender(view));
        return view;
    }

    function unmountMemberView(root) {
        let removed = false;
        for (const view of [...views]) {
            if (view.root !== root) continue;
            view.dead = true;
            if (view.timer) { clearTimeout(view.timer); view.timer = 0; }
            if (view.unsub) view.unsub();
            view.unsub = null;
            views.delete(view);
            removed = true;
        }
        return removed;
    }

    function scheduleRender(view) {
        if (view.dead || view.timer) return;
        view.timer = setTimeout(() => {
            view.timer = 0;
            renderNow(view);
        }, REFRESH_THROTTLE_MS);
    }

    function groupOf(view) {
        return runtime.groupById(view.groupId);
    }

    function agentOf(view) {
        const config = getAIConfig();
        const agents = (config && Array.isArray(config.agents)) ? config.agents : [];
        return agents.find((item) => item && item.id === view.agentId) || null;
    }

    function profilesOf() {
        const config = getAIConfig();
        return (config && Array.isArray(config.profiles)) ? config.profiles : [];
    }

    function buildDom(view) {
        view.head = el('div', 'gm-head');
        view.body = el('div', 'gm-body');
        view.root.append(view.head, view.body);
        // 各区块持久化：实时每帧更新；上下文 / 私有 / 历史按各自签名增量重绘
        const section = (title) => {
            view.body.appendChild(el('div', 'gm-sec-title', title));
            const card = el('div', 'gm-card');
            view.body.appendChild(card);
            return card;
        };
        view.liveBox = section('实时');
        view.ctxBox = section('上下文');
        view.privateBox = section('私有过程（仅你可见）');
        view.historyBox = section('发言记录');
        view.headSig = '';
        view.ctxSig = '';
        view.privateSig = '';
        view.historySig = '';
        view.privateMsgCount = -1;
    }

    function renderNow(view) {
        if (view.dead) return;
        const g = groupOf(view);
        if (!g) {
            view.root.textContent = '';
            view.root.appendChild(el('div', 'gm-empty', '群聊已删除或不可用。'));
            return;
        }
        const agent = agentOf(view);
        if (!agent) {
            view.root.textContent = '';
            view.root.appendChild(el('div', 'gm-empty', '该成员已从智能体配置中删除。'));
            return;
        }
        const stream = runtime.activeStreamOf(view.groupId);
        const speaking = !!(stream && stream.agentId === view.agentId);
        const muted = (g.meta.mutedAgentIds || []).includes(view.agentId);
        const headSig = [g.meta.updatedAt, speaking ? '1' : '0', muted ? '1' : '0'].join('|');
        if (headSig !== view.headSig) {
            view.headSig = headSig;
            renderHead(view, g, agent);
        }
        renderLive(view, speaking ? stream : null);
        renderCtx(view, g, agent);
        renderPrivate(view, g);
        renderHistory(view, g);
        // 私有日志随消息数变化重读（发言落盘同帧 push 消息；不逐 chunk 重读）
        const msgCount = (g.messages || []).length;
        if (view.privateMsgCount !== msgCount) {
            view.privateMsgCount = msgCount;
            loadPrivateSteps(view);
        }
    }

    // ---------- 头部 ----------

    function renderHead(view, g, agent) {
        const meta = g.meta;
        const stream = runtime.activeStreamOf(view.groupId);
        const speaking = !!(stream && stream.agentId === view.agentId);
        const muted = (meta.mutedAgentIds || []).includes(view.agentId);
        const capability = agentCapability(agent, profilesOf());
        view.head.textContent = '';

        const avatar = el('span', 'gc-avatar gc-avatar-lg');
        avatar.textContent = memberInitial(agent.name);
        avatar.style.background = memberColorHex(agent.color);
        view.head.appendChild(avatar);

        const info = el('div', 'gm-head-info');
        const nameRow = el('div', 'gm-name');
        nameRow.appendChild(el('span', null, agent.name));
        if (speaking) nameRow.appendChild(el('span', 'gc-badge gc-badge-mode', '发言中'));
        if (muted) nameRow.appendChild(el('span', 'gc-badge', '已静音'));
        if (!capability.available) nameRow.appendChild(el('span', 'gc-badge gc-level-red', '模型不可用'));
        if (meta.chair && meta.chair.kind === 'member' && meta.chair.agentId === view.agentId) {
            nameRow.appendChild(el('span', 'gc-badge gc-badge-chair', '兼任主持人'));
        }
        info.appendChild(nameRow);
        const metaParts = [];
        if (view.groupTitle) metaParts.push(view.groupTitle);
        if (meta.roles && meta.roles[view.agentId]) metaParts.push('角色：' + meta.roles[view.agentId]);
        metaParts.push(capability.available ? (capability.label || '模型') : '模型已失效');
        if (capability.available && capability.contextWindow) metaParts.push(`窗口 ${Math.round(capability.contextWindow / 1000)}k`);
        if (agent.role) metaParts.push(agent.role);
        info.appendChild(el('div', 'gm-meta', metaParts.join(' · ')));
        view.head.appendChild(info);

        const actions = el('div', 'gm-head-actions');
        const speakBtn = el('button', 'gc-btn gc-btn-primary', '请发言');
        speakBtn.type = 'button';
        speakBtn.dataset.tip = '让这位成员现在发言一次（可先在右侧填焦点）';
        speakBtn.addEventListener('click', () => {
            const focus = view.focusCtl && String(view.focusCtl.control.value || '').trim();
            runtime.speak(view.groupId, view.agentId, {focus}).then((result) => {
                if (!result.ok) flash(result.error || '请发言失败', true);
            }).catch((e) => flash((e && e.message) || String(e), true));
        });
        actions.appendChild(speakBtn);
        const focusCtlWrap = el('div', 'gm-focus');
        const ctl = createInput({placeholder: '焦点（可选）：要 TA 回应什么'});
        view.focusCtl = {control: ctl.control, element: ctl.element};
        focusCtlWrap.appendChild(ctl.element);
        actions.appendChild(focusCtlWrap);
        const muteBtn = el('button', 'gc-btn', muted ? '取消静音' : '静音');
        muteBtn.type = 'button';
        muteBtn.addEventListener('click', () => {
            runtime.saveMeta(view.groupId, (meta2) => {
                const list = meta2.mutedAgentIds || (meta2.mutedAgentIds = []);
                const index = list.indexOf(view.agentId);
                if (index >= 0) list.splice(index, 1);
                else list.push(view.agentId);
            });
        });
        actions.appendChild(muteBtn);
        if (speaking) {
            const stopBtn = el('button', 'gc-btn', '停止');
            stopBtn.type = 'button';
            stopBtn.addEventListener('click', () => runtime.stopOne(view.groupId, view.agentId));
            actions.appendChild(stopBtn);
        }
        if (openGroupView) {
            const openBtn = el('button', 'gc-btn', '打开群聊');
            openBtn.type = 'button';
            openBtn.addEventListener('click', () => openGroupView({groupId: view.groupId, title: view.groupTitle || (g.meta && g.meta.title) || ''}));
            actions.appendChild(openBtn);
        }
        view.head.appendChild(actions);
    }

    function renderLive(view, stream) {
        const card = view.liveBox;
        card.textContent = '';
        if (stream) {
            if (stream.thinking) card.appendChild(el('div', 'gm-live-thinking', stream.thinking));
            const content = el('div', 'gm-live-content', stream.content || (stream.thinking ? '' : '（等待输出…）'));
            card.appendChild(content);
            if (stream.statusNote) card.appendChild(el('div', 'gm-meta', stream.statusNote));
        } else {
            card.appendChild(el('div', 'gm-empty', '空闲：没有正在进行的发言。'));
        }
    }

    function renderCtx(view, g, agent) {
        const sig = String(g.meta.updatedAt || 0) + '|' + String(g.meta.maxSpeeches || 0) + '|' + String(g.meta.maxRounds || 0);
        if (sig === view.ctxSig) return;
        view.ctxSig = sig;
        const card = view.ctxBox;
        card.textContent = '';
        const sharedCount = (g.messages || []).filter((m) => m.role === 'user' || m.role === 'assistant').length;
        const capability = agentCapability(agent, profilesOf());
        const ctxParts = [`共享消息 ${sharedCount} 条`];
        if (capability.available && capability.contextWindow) {
            ctxParts.push(`模型窗口 ${capability.contextWindow} tok`);
            if (capability.outputWindow) ctxParts.push(`输出预留 ${capability.outputWindow} tok`);
        } else {
            ctxParts.push('模型不可用（发言会被拒绝并落灰条）');
        }
        ctxParts.push(`发言预算 ${g.meta.maxSpeeches} 次` + (Number(g.meta.maxRounds) === 0 ? ' · 不限轮次' : ` · ${g.meta.maxRounds} 轮`));
        card.appendChild(el('div', 'gm-meta', ctxParts.join(' · ')));
    }

    function renderPrivate(view, g) {
        const sig = (view.privateSteps ? view.privateSteps.length : -1) + '|' + ((g.messages || []).length);
        if (sig === view.privateSig) return;
        view.privateSig = sig;
        const card = view.privateBox;
        card.textContent = '';
        const steps = view.privateSteps;
        if (view.privateLoading && !steps) {
            card.appendChild(el('div', 'gm-empty', '读取私有日志…'));
            return;
        }
        if (!steps || !steps.length) {
            card.appendChild(el('div', 'gm-empty', '还没有私有过程：该成员还没产出过思考链，或模型不返回思考。'));
            return;
        }
        const byGid = new Map();
        for (const msg of (g.messages || [])) byGid.set(msg.gid, msg);
        for (const step of steps.slice(-PRIVATE_STEPS_MAX).reverse()) {
            // 工具调用条目（gid=tools:<roundId>）：渲染成工具行，与共享发言的对齐交给头部摘要
            const isToolEntry = String(step.gid || '').startsWith('tools:');
            const box = el('details', 'gm-step' + (isToolEntry ? ' gm-step-tool' : ''));
            const summary = el('summary', 'gm-step-summary');
            const msg = byGid.get(step.gid) || (g.messages || []).find((m) => 'tools:' + m.turnId === step.gid);
            const when = msg ? timeLabel(msg.ts) : timeLabel(step.ts);
            if (isToolEntry) {
                const toolLines = (step.steps || []).map((s) => (s && s.name) || 'tool').join('、');
                summary.textContent = `🔧 ${when} · 工具调用（${toolLines || '无'}）`;
            } else {
                summary.textContent = `${when} · ${msg ? String(msg.content || '').replace(/\s+/g, ' ').slice(0, 40) || '（空发言）' : '（共享日志中无对应发言）'}`;
            }
            box.appendChild(summary);
            const bodyEl = el('div', 'gm-step-body');
            if (isToolEntry) {
                for (const s of (step.steps || [])) {
                    const row = el('div', 'gm-tool-step');
                    row.textContent = '🔧 ' + ((s && s.name) || 'tool') + '：' + ((s && s.text) || '');
                    bodyEl.appendChild(row);
                }
                if (!bodyEl.children.length) bodyEl.textContent = '（无工具步骤）';
            } else {
                const texts = (step.steps || []).map((s) => s && s.text).filter(Boolean);
                bodyEl.textContent = texts.join('\n\n') || '（无文本步骤）';
            }
            box.appendChild(bodyEl);
            card.appendChild(box);
        }
        if (steps.length > PRIVATE_STEPS_MAX) {
            card.appendChild(el('div', 'gm-meta', `只显示最近 ${PRIVATE_STEPS_MAX} 条，更早的仍在本机私有日志里。`));
        }
    }

    function renderHistory(view, g) {
        const mine = (g.messages || []).filter((m) => m.role === 'assistant' && m.agentId === view.agentId);
        const isRelay = g.meta.mode === 'relay';
        const sig = String(g.meta.updatedAt || 0) + '|' + mine.length + '|' + (isRelay ? 'r' : 'd');
        if (sig === view.historySig) return;
        view.historySig = sig;
        const card = view.historyBox;
        card.textContent = '';
        if (!mine.length) {
            card.appendChild(el('div', 'gm-empty', '这位成员还没有在群里发过言。'));
            return;
        }
        for (const msg of mine.slice(-SPEECH_HISTORY_MAX).reverse()) {
            const row = el('div', 'gm-msg-row');
            const head = el('div', 'gm-msg-head');
            head.appendChild(el('span', null, timeLabel(msg.ts)));
            if (Number(msg.round) > 0) head.appendChild(el('span', 'gc-badge', `第 ${msg.round} ${isRelay ? '棒' : '轮'}`));
            if (msg.stance) head.appendChild(el('span', 'gc-badge gc-badge-stance-' + msg.stance, STANCE_LABELS[msg.stance] || msg.stance));
            if (msg.timing && msg.timing.ttftMs) head.appendChild(el('span', 'gc-badge', `首字 ${(msg.timing.ttftMs / 1000).toFixed(1)}s`));
            if (msg.usage && msg.usage.totalTokens) head.appendChild(el('span', 'gc-badge', `${msg.usage.totalTokens} tok`));
            if (msg.timeout) head.appendChild(el('span', 'gc-badge gc-level-red', '超时'));
            if (msg.status && msg.status !== 'done') head.appendChild(el('span', 'gc-badge', msg.status === 'error' ? '失败' : msg.status));
            row.appendChild(head);
            const content = el('div', 'gm-msg-content');
            // 接力成员的【交棒】标记只给引擎判读，发言历史同样不展示（与主群聊视图一致）
            const bodyText = isRelay ? stripHandoffMarker(String(msg.content || '')) : String(msg.content || '');
            if (renderMarkdown) {
                content.innerHTML = renderMarkdown(bodyText);
                if (enhanceAnswerBody) enhanceAnswerBody(content);
            } else {
                content.textContent = bodyText;
            }
            row.appendChild(content);
            card.appendChild(row);
        }
        if (mine.length > SPEECH_HISTORY_MAX) {
            card.appendChild(el('div', 'gm-meta', `只显示最近 ${SPEECH_HISTORY_MAX} 条发言。`));
        }
    }

    // 私有日志：只在消息数变化时重读磁盘（发言落盘与消息 push 同帧发生）
    function loadPrivateSteps(view) {
        if (view.privateLoading) return;
        view.privateLoading = true;
        Promise.resolve(runtime.store.privateRead(view.groupId, view.agentId))
            .then((text) => {
                view.privateLoading = false;
                if (view.dead) return;
                view.privateSteps = parsePrivateSteps(text);
                renderNow(view);
            })
            .catch((e) => {
                view.privateLoading = false;
                if (view.dead) return;
                view.privateSteps = [];
                view.privateError = String((e && e.message) || e);
                renderNow(view);
            });
    }

    return {mountMemberView, unmountMemberView, memberViews};
}
