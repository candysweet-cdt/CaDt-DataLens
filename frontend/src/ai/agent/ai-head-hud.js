// ai-head-hud.js：AI 面板头部 HUD（会话标题自适应 + 智能体团队 / 后台终端 chips 角标与弹层）。
// 从 ai-subagents.js 拆出（frontend-split-phase3 A4b，同域兄弟模块）；ctx 与宿主同源，
// 运行态注册表（const Map 活引用）与运行时动作 / 详情视图入口经 extras 注入。函数体逐字搬移。
// 构造期即绑定 chip 点击 / 面板点击关弹层 / 标题行 ResizeObserver（时机与拆分前一致）。
import {iconSvg} from '../../core/icons.js';
import {sandboxModeLabel} from '../security/ai-sandbox-grant.js';
import {buildAgentTree, flattenAgentTree} from './ai-agent-tree.js';
import {agentLevelText} from '../group/ai-team-model.js';

// 子代理 HUD 条目的双维度判重器：key（agent-*）与 toolCallId（模型 call.id）任一命中即视为同一条。
// 为什么两个维度：正常数据两者都有；历史会话的 spawn_agent meta 被旧版 normalizeMessage 剥掉了
// agent.key，兜底源只能回退到 toolCallId——若只按 key 去重就会与运行期 Map 的 agent-* 判为不同、
// 同一个已完成子代理显示两次（5 → 10）。两个维度都登记，新数据与历史数据都能去重。
// 纯函数，无 DOM / Wails 依赖，供 listAgentsForHud 与回归测试共用。
export function makeHudDeduper() {
    const keys = new Set();
    const calls = new Set();
    return function seen(key, callId) {
        if ((key && keys.has(key)) || (callId && calls.has(callId))) return true;
        if (key) keys.add(key);
        if (callId) calls.add(callId);
        return false;
    };
}

export function createAIHeadHud(ctx, extras) {
    const el = ctx.el;
    const panel = ctx.panel;
    const flash = ctx.flash;
    const currentSession = ctx.currentSession;
    const sessionById = ctx.sessionById;
    const getSessions = ctx.getSessions;
    const bgJobIndex = ctx.bgJobIndex;
    const agentRegistry = ctx.agentRegistry;
    const openTermTab = ctx.openTermTab;
    const renderSessionList = ctx.renderSessionList;
    const reconcileBgJobs = ctx.reconcileBgJobs;
    const getChipsPopKind = ctx.getChipsPopKind;
    const setChipsPopKind = ctx.setChipsPopKind;
    // 运行态注册表（宿主构造块里的 const Map，稳定活引用）
    const subAgents = extras.subAgents;
    const subAgentRecords = extras.subAgentRecords;
    // 运行时动作与详情视图入口（宿主后定义，惰性箭头延迟解析）
    const unseenInboxCount = extras.unseenInboxCount;
    const openAgentView = extras.openAgentView;
    // 团队详情标签页的打开入口（悬浮窗不提供内容区，面板会注入 null）
    const openAgentTeamTab = ctx.openAgentTeamTab;

    let hudReady = false;             // HUD 块执行完才置真，之前的 renderSessionList 调用跳过
    const AGENT_STATE_LABEL = {running: '运行中', done: '已完成', error: '失败', stopped: '已停止'};
    // 智能体团队弹层的折叠态：按 agent.key 记，弹层重渲染（开关 / 切 chip / 实时刷新）后保留。
    const agentCollapsed = new Set();
    const agentRowKey = (agent) => (agent && (agent.key || agent.toolCallId || agent.subId)) || '';
    // 树形缩进最多到第 4 层（80px）：弹层只有 320px 宽，再深会把名称列挤成 0 并撑出横向滚动条。
    // 更深的层级靠副标题里的「第 N 层」补足深度信息。
    const AGENT_TREE_MAX_INDENT = 4;

    // ---- 头部 HUD：会话标题 + 智能体团队 / 后台终端入口 ----
    // 标题显示当前会话标题（自动标题/改名/切换经 renderSessionList 统一走 updateHeadHud）；
    // 两个 chip 是常驻入口：智能体团队（子代理状态）与后台终端（background_command 作业）。

    function sessionTitleOf(sessionId) {
        const session = sessionById(sessionId);
        return session ? (session.title || '新会话') : '';
    }

    function sessionTitleById(id) {
        const session = getSessions().find((s) => s.id === id);
        return session ? (session.title || '新会话') : '';
    }

    function updateHeadIdentity() {
        if (!el.headTitle) return;
        const session = currentSession();
        const title = session ? String(session.title || '').trim() : '';
        el.headTitle.textContent = title || 'AI 助手';
    }

    function bgJobStateOf(entry) {
        const bg = entry && entry.message && entry.message.bg;
        return (bg && bg.state) || 'unknown';
    }

    // 头部两个入口与 dsh 一致：只展示「当前会话」的后台任务 / 子代理。
    // 子代理的会话对象带 rootSessionId，因此子代理里启动的后台命令归到根会话名下。
    function rootSessionIdOf(session) {
        if (!session) return '';
        return session.rootSessionId || session.parentSessionId || session.id || '';
    }

    function hudSessionId() {
        const session = currentSession();
        return session ? session.id : '';
    }

    function bgEntryOwnerId(entry) {
        if (!entry) return '';
        return entry.rootSessionId || rootSessionIdOf(entry.session);
    }

    function isBgEntryOfHud(entry) {
        const id = hudSessionId();
        return !!id && bgEntryOwnerId(entry) === id;
    }

    function hudBgEntries() {
        return [...bgJobIndex.values()].filter(isBgEntryOfHud);
    }

    // 某个会话是否还有正在跑的后台命令（会话列表的运行中标记用）
    function sessionHasLiveBgJob(sessionId) {
        if (!sessionId) return false;
        for (const entry of bgJobIndex.values()) {
            if (bgEntryOwnerId(entry) !== sessionId) continue;
            if (bgJobStateOf(entry) === 'running') return true;
        }
        return false;
    }

    function runningBgCount() {
        let n = 0;
        for (const entry of hudBgEntries()) {
            if (bgJobStateOf(entry) === 'running') n++;
        }
        return n;
    }

    // ownerOverride：团队详情标签页按「打开时的会话」取数（用户切走后它仍显示原会话的团队）
    function listAgentsForHud(ownerOverride) {
        const out = [];
        const seen = makeHudDeduper();
        const ownerId = String(ownerOverride || '') || hudSessionId();
        const belongs = (owner) => !ownerId || !owner || owner === ownerId;
        for (const sub of subAgents.values()) {
            if (seen(sub.key, sub.toolCallId)) continue;
            if (!belongs(sub.rootSessionId || sub.parentSessionId)) continue;
            out.push({toolCallId: sub.toolCallId || sub.key, key: sub.key, subId: sub.id, parentSessionId: sub.parentSessionId,
                name: sub.name, task: sub.task,
                depth: sub.depth, state: 'running', startedAt: sub.startedAt,
                mode: sub.mode || 'blocking', continuable: true,
                sandboxMode: sub.sandboxMode || '',
                inboxCount: unseenInboxCount(sub),
                compacting: !!sub.compacting,
                sessionTitle: sessionTitleOf(sub.parentSessionId)});
        }
        for (const [key, meta] of agentRegistry) {
            if (seen(key, meta.toolCallId)) continue;
            if (!belongs(meta.rootSessionId || meta.parentSessionId)) continue;
            out.push({...meta, toolCallId: meta.toolCallId || key, key, sessionTitle: sessionTitleOf(meta.parentSessionId)});
        }
        // 终态记录兜底：records 里还活引用着的条目比 registry / 持久化 meta 更新（含续轮后的轮次与摘要）
        for (const rec of subAgentRecords.values()) {
            if (seen(rec.key, rec.toolCallId)) continue;
            if (!belongs(rec.rootSessionId || rec.parentSessionId)) continue;
            out.push({
                toolCallId: rec.toolCallId || rec.key, key: rec.key, subId: rec.id,
                parentSessionId: rec.parentSessionId, name: rec.name,
                task: rec.task, depth: rec.depth, state: rec.state, startedAt: rec.startedAt,
                rounds: rec.rounds, ms: rec.ms, tokens: rec.tokens, summary: rec.summary,
                mode: rec.mode, continuable: rec.continuable,
                sandboxMode: rec.sandboxMode || '',
                sessionTitle: sessionTitleOf(rec.parentSessionId),
            });
        }
        // 重启后兜底：该会话持久化的 spawn_agent meta（转录已不在内存）。
        // 指定 ownerOverride 时只查它自己的会话，找不到就不兜底（不能拿当前会话的记录串台）。
        const session = ownerOverride && ownerId ? sessionById(ownerId) : currentSession();
        if (session) {
            for (const m of session.messages) {
                if (m.role !== 'tool' || m.name !== 'spawn_agent' || !m.agent) continue;
                // 新数据 agent.key 有值；历史数据缺 key，回退到 m.toolCallId（与运行期 Map 的 toolCallId 同源）
                const key = m.agent.key || '';
                const callId = m.toolCallId || '';
                if (seen(key || callId, callId)) continue;
                out.push({toolCallId: callId || key, key: key || callId,
                    // 身份字段：新数据由 normalizeMessage 保留；历史会话（agent.key 已被剥）仍可能缺，
                    // 补 subId/parentSessionId/startedAt 让兜底条目能参与父子挂靠与排序。
                    subId: m.agent.id || '', parentSessionId: m.agent.artifactDir || '',
                    startedAt: m.agent.startedAt || 0,
                    depth: m.agent.depth || 1, name: m.agent.name || '子代理',
                    task: m.agent.task || '', state: m.agent.state || 'done', summary: m.agent.summary || '',
                    rounds: m.agent.rounds || 0, ms: m.agent.ms || 0, tokens: m.agent.tokens || 0,
                    sandboxMode: m.agent.sandboxMode || '',
                    sessionTitle: session.title || ''});
            }
        }
        return out;
    }

    function setChipCount(chip, total, running) {
        if (!chip) return;
        const countEl = chip.querySelector('.ai-chip-count');
        if (countEl) {
            if (total > 0) {
                countEl.textContent = running > 0 ? String(running) : String(total);
                countEl.classList.remove('hidden');
            } else {
                countEl.classList.add('hidden');
            }
        }
        chip.classList.toggle('ai-chip-live', running > 0);
    }

    // 后台作业 / 子代理状态变化：刷新头部角标，并让「会话列表的运行中标记」跟上。
    function notifyBackgroundActivity() {
        refreshHeadChips();
        renderSessionList();
    }

    // 弹层开着时的实时刷新：状态变化只重绘弹层内容，不丢折叠态 / 滚动位置 / 键盘焦点。
    // 节流 120ms，连续事件（多代理同时跑到轮边界）合并成一次重建。
    let agentsPopRefreshTimer = 0;
    function scheduleAgentsPopRefresh() {
        if (agentsPopRefreshTimer) return;
        agentsPopRefreshTimer = setTimeout(() => {
            agentsPopRefreshTimer = 0;
            if (getChipsPopKind() !== 'agents' || !el.chipsPop) return;
            const scrollTop = el.chipsPop.scrollTop;
            const active = document.activeElement;
            const focusKey = active && el.chipsPop.contains(active) ? (active.dataset.agentKey || '') : '';
            renderChipsPop('agents');
            el.chipsPop.scrollTop = scrollTop;
            if (focusKey) {
                const next = el.chipsPop.querySelector('[data-agent-key="' + focusKey + '"]');
                if (next) next.focus({preventScroll: true});
            }
        }, 120);
    }

    function refreshHeadChips() {
        const agents = listAgentsForHud();
        const runningAgents = agents.filter((a) => a.state === 'running').length;
        const jobs = hudBgEntries();
        setChipCount(el.chipAgents, agents.length, runningAgents);
        setChipCount(el.chipTerms, jobs.length, runningBgCount());
        // 弹层开着时把新状态同步进去（关闭 / 切到后台终端时不做事）
        if (getChipsPopKind() === 'agents') scheduleAgentsPopRefresh();
        // 团队详情标签页同样跟随状态变化（未打开时只是空遍历）
        if (typeof extras.onAgentsChanged === 'function') extras.onAgentsChanged();
    }

    function updateHeadHud() {
        if (!hudReady) return;
        updateHeadIdentity();
        refreshHeadChips();
    }

    function hideChipsPop() {
        setChipsPopKind('');
        if (el.chipsPop) el.chipsPop.classList.add('hidden');
    }

    function positionChipsPop(chip) {
        if (!el.chipsPop || !chip) return;
        const panelRect = panel.getBoundingClientRect();
        const chipRect = chip.getBoundingClientRect();
        if (!panelRect.height || !panelRect.width) return;
        // 先显示再量宽：挂在 chip 下方左对齐，超出面板右缘时往回收
        const width = el.chipsPop.offsetWidth || 320;
        el.chipsPop.style.top = (chipRect.bottom - panelRect.top + 6) + 'px';
        let left = chipRect.left - panelRect.left;
        if (left + width > panelRect.width - 8) left = Math.max(8, panelRect.width - width - 8);
        el.chipsPop.style.right = 'auto';
        el.chipsPop.style.left = Math.max(8, left) + 'px';
    }

    function agentStateBadge(state) {
        const span = document.createElement('span');
        span.className = 'ai-agent-badge ai-agent-' + (AGENT_STATE_LABEL[state] ? state : 'done');
        span.textContent = AGENT_STATE_LABEL[state] || '已结束';
        return span;
    }

    // 沙箱档位胶囊：只写档位本身。未知值走中性色原样回显，不猜。
    const SANDBOX_TONE = {'read-only': 'read-only', 'workspace-write': 'workspace-write', 'danger-full-access': 'danger-full-access'};

    function agentSandboxBadge(mode) {
        const span = document.createElement('span');
        const tone = SANDBOX_TONE[mode];
        span.className = 'ai-agent-badge ai-sandbox-badge' + (tone ? ' ai-sandbox-' + tone : '');
        span.textContent = sandboxModeLabel(mode);
        return span;
    }

    // 后台作业状态图标：退出码区分成功 / 失败；「已停止」用实心方块（stop，与输入区停止按钮
    // 同字形）——|| 读起来像「暂停、可以继续」，而后台作业停下就是结束了，不会再跑。
    // notfound 是「查不到这个作业了」（应用重启后快照丢失），用中性 ⓘ 而不是任何终态图标。
    function agentStatusIcon(state, code) {
        if (state === 'running') return iconSvg('refresh', 12);
        if (state === 'exited') return Number(code) ? iconSvg('close', 12) : iconSvg('check', 12);
        if (state === 'stopped') return iconSvg('stop', 12);
        if (state === 'notfound') return iconSvg('info', 12);
        return iconSvg('warn', 12);
    }

    function bgJobFirstLine(command) {
        const line = String(command || '').split('\n', 1)[0].replace(/\s+/g, ' ').trim();
        if (!line) return '（空命令）';
        return line.length > 60 ? line.slice(0, 60) + '…' : line;
    }

    function taskSnippet(task) {
        const line = String(task || '').replace(/\s+/g, ' ').trim();
        return line.length > 76 ? line.slice(0, 76) + '…' : line;
    }

    function openBgTermInContent(entry) {
        if (!openTermTab) {
            flash('当前宿主不支持内容区标签页', true);
            return;
        }
        const bg = (entry.message && entry.message.bg) || {};
        openTermTab({
            jobId: bg.jobId,
            command: entry.command,
            cwd: entry.cwd,
            state: bgJobStateOf(entry),
        });
    }

    function renderChipsPop(kind) {
        if (!el.chipsPop) return;
        el.chipsPop.textContent = '';
        // 其它域的弹层内容（如计时器）：经 ctx 注入的钩子接管，返回 true 表示已渲染
        if (typeof ctx.renderChipsPopExtra === 'function' && ctx.renderChipsPopExtra(kind, el.chipsPop)) return;
        const title = document.createElement('div');
        title.className = 'ai-chips-pop-title';
        const titleText = document.createElement('span');
        titleText.textContent = kind === 'agents' ? '智能体团队' : '后台终端';
        title.appendChild(titleText);
        // 团队详情：内容区标签页（悬浮窗无内容区，入口不渲染）
        if (kind === 'agents' && typeof openAgentTeamTab === 'function') {
            const detail = document.createElement('button');
            detail.type = 'button';
            detail.className = 'ai-chips-pop-action';
            detail.textContent = '查看详情';
            detail.addEventListener('click', () => {
                const session = currentSession();
                const sessionId = session ? session.id : '';
                if (!sessionId) return;
                hideChipsPop();
                openAgentTeamTab({sessionId, title: session.title || ''});
            });
            title.appendChild(detail);
        }
        el.chipsPop.appendChild(title);
        let rows = 0;
        if (kind === 'agents') {
            // 树形展示嵌套关系：父子靠 parentSessionId ↔ subId 还原（纯函数见 ai-agent-tree.js）。
            // 折叠态挂闭包 Set；renderChipsPop 全量重建，展开行序由 flattenAgentTree 给出。
            const treeRows = flattenAgentTree(buildAgentTree(listAgentsForHud()), (key) => agentCollapsed.has(key));
            // 已消失的代理不留折叠键，避免 Set 长期膨胀
            const liveKeys = new Set();
            for (const item of treeRows) liveKeys.add(agentRowKey(item.agent));
            for (const key of [...agentCollapsed]) if (!liveKeys.has(key)) agentCollapsed.delete(key);
            // 列表里没有可折叠父行（全是第 1 层子代理）时不预留箭头列：
            // 否则整份列表会右移 20px，左边空出一条没有意义的槽
            const hasTree = treeRows.some((item) => item.childCount > 0);
            for (const item of treeRows) {
                const agent = item.agent;
                const key = agentRowKey(agent);
                rows++;
                // 行容器不是按钮：折叠箭头与「打开详情」主按钮各是一个 button（按钮不能嵌套按钮）
                const row = document.createElement('div');
                row.className = 'ai-chips-row ai-agent-tree-row';
                // 缩进封顶：更深的层级不再往右推，靠副标题的「第 N 层」补深度
                row.style.setProperty('--ai-lv', hasTree ? String(Math.min(item.level, AGENT_TREE_MAX_INDENT)) : '0');
                if (hasTree && item.level > 0) row.dataset.nested = '1';
                if (hasTree) {
                    if (item.childCount > 0) {
                        const toggle = document.createElement('button');
                        toggle.type = 'button';
                        toggle.className = 'ai-chips-toggle' + (item.collapsed ? '' : ' open');
                        toggle.dataset.agentKey = key;
                        toggle.setAttribute('aria-expanded', String(!item.collapsed));
                        toggle.innerHTML = iconSvg('chevron-right', 12);
                        toggle.addEventListener('click', () => {
                            if (agentCollapsed.has(key)) agentCollapsed.delete(key);
                            else agentCollapsed.add(key);
                            renderChipsPop('agents');
                            // 重建后焦点回到同一个折叠箭头，键盘操作不丢位
                            const next = el.chipsPop.querySelector('.ai-chips-toggle[data-agent-key="' + key + '"]');
                            if (next) next.focus({preventScroll: true});
                        });
                        row.appendChild(toggle);
                    } else {
                        // 叶子行用等宽占位，和父行名称列对齐
                        const spacer = document.createElement('span');
                        spacer.className = 'ai-chips-toggle-spacer';
                        row.appendChild(spacer);
                    }
                }
                const mainBtn = document.createElement('button');
                mainBtn.type = 'button';
                mainBtn.className = 'ai-chips-row-main';
                // 实时刷新重建后按这个键找回焦点
                mainBtn.dataset.agentKey = key;
                mainBtn.appendChild(agentStateBadge(agent.state));
                // 收件箱有未消费消息 / 等待主代理回答：单独一枚徽标（不改变 running 语义）
                if (agent.inboxCount > 0) {
                    const wait = document.createElement('span');
                    wait.className = 'ai-agent-badge ai-agent-waiting';
                    wait.textContent = '待处理 ' + agent.inboxCount;
                    mainBtn.appendChild(wait);
                }
                if (agent.compacting) {
                    const compacting = document.createElement('span');
                    compacting.className = 'ai-agent-badge ai-agent-waiting';
                    compacting.textContent = '压缩中';
                    mainBtn.appendChild(compacting);
                }
                const main = document.createElement('span');
                main.className = 'ai-chips-main';
                const nameSpan = document.createElement('span');
                nameSpan.className = 'ai-chips-name';
                nameSpan.textContent = agent.name || '子代理';
                const subSpan = document.createElement('span');
                subSpan.className = 'ai-chips-sub';
                const appendBit = (part, noSep) => {
                    if (!part) return;
                    if (!noSep && subSpan.childNodes.length) subSpan.appendChild(document.createTextNode(' · '));
                    subSpan.appendChild(typeof part === 'string' ? document.createTextNode(part) : part);
                };
                // 缩进已经表达层级；父代理不在列表（孤儿）或层级超过缩进封顶时才补层号
                if (agent.depth >= 1 && (item.level === 0 || item.level > AGENT_TREE_MAX_INDENT)) {
                    appendBit(agentLevelText(agent.depth));
                }
                if (item.collapsed && item.descendantCount > 0) appendBit(item.descendantCount + ' 个下级');
                // 档位胶囊占原「沙箱 只读」文本的位置：层级位之后、任务摘要之前
                if (agent.sandboxMode) appendBit(agentSandboxBadge(agent.sandboxMode));
                // 胶囊本身就是分隔，后面直接接任务摘要，不再补「·」
                appendBit(taskSnippet(agent.task), !!agent.sandboxMode);
                if (agent.sessionTitle) appendBit('@ ' + agent.sessionTitle);
                main.append(nameSpan, subSpan);
                mainBtn.appendChild(main);
                const go = document.createElement('span');
                go.className = 'ai-chips-go';
                go.innerHTML = iconSvg('chevron-right', 12);
                mainBtn.appendChild(go);
                mainBtn.addEventListener('click', () => {
                    hideChipsPop();
                    openAgentView({
                        toolCallId: agent.toolCallId,
                        subId: agent.subId || '',
                        name: agent.name || '子代理',
                        // 详情头部要在这个会话的正文里找 spawn_agent 记录：带上它，就能精确补
                        // 这一个会话（懒加载下别的会话可能只有 meta）
                        sessionId: (currentSession() || {}).id || '',
                    });
                });
                row.appendChild(mainBtn);
                el.chipsPop.appendChild(row);
            }
        } else {
            const jobs = hudBgEntries().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
            for (const entry of jobs) {
                rows++;
                const state = bgJobStateOf(entry);
                const code = (entry.message && entry.message.bg && entry.message.bg.code);
                // 非 0 退出是失败（不是「跑完了」）：图标与颜色都要与成功区分开
                const failedExit = state === 'exited' && Number(code) !== 0;
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'ai-chips-row';
                const icon = document.createElement('span');
                icon.className = 'ai-chips-status ai-status-' + (failedExit ? 'failed' : state);
                icon.innerHTML = agentStatusIcon(state, code);
                row.appendChild(icon);
                const main = document.createElement('span');
                main.className = 'ai-chips-main';
                main.textContent = bgJobFirstLine(entry.command);
                row.appendChild(main);
                const go = document.createElement('span');
                go.className = 'ai-chips-go';
                go.innerHTML = iconSvg('chevron-right', 12);
                row.appendChild(go);
                row.addEventListener('click', () => {
                    hideChipsPop();
                    openBgTermInContent(entry);
                });
                el.chipsPop.appendChild(row);
            }
        }
        if (!rows) {
            const empty = document.createElement('div');
            empty.className = 'ai-chips-empty';
            empty.textContent = kind === 'agents'
                ? '暂无共享任务'
                : '暂无后台命令';
            el.chipsPop.appendChild(empty);
        }
    }

    function toggleChipsPop(kind, chip) {
        if (!el.chipsPop) return;
        if (getChipsPopKind() === kind) {
            hideChipsPop();
            return;
        }
        setChipsPopKind(kind);
        renderChipsPop(kind);
        el.chipsPop.classList.remove('hidden');
        positionChipsPop(chip);
        // 弹层打开时对账后台作业状态：错过的 cmd-exit 不会重放，避免永久显示运行中
        if (kind === 'terms') {
            reconcileBgJobs().then(() => {
                if (getChipsPopKind() !== 'terms') return;
                renderChipsPop('terms');
                positionChipsPop(chip);
            }).catch(() => {});
        }
    }

    if (el.chipAgents) {
        const iconEl = el.chipAgents.querySelector('.ai-chip-icon');
        if (iconEl) iconEl.innerHTML = iconSvg('agents', 13);
        el.chipAgents.addEventListener('click', () => toggleChipsPop('agents', el.chipAgents));
    }
    if (el.chipTerms) {
        const iconEl = el.chipTerms.querySelector('.ai-chip-icon');
        if (iconEl) iconEl.innerHTML = iconSvg('terminal', 13);
        el.chipTerms.addEventListener('click', () => toggleChipsPop('terms', el.chipTerms));
    }
    // 点面板其他位置关闭 chips 弹层。chips pop 挂在面板内（.ai-popover 档），不进全局弹层栈，
    // 也无 Esc 语义（历史行为即如此：只靠外点与再次点击收起）。
    panel.addEventListener('mousedown', (e) => {
        if (!getChipsPopKind()) return;
        if (e.target.closest && (e.target.closest('#ai-chips-pop') || e.target.closest('.ai-chip'))) return;
        hideChipsPop();
    });
    // 标题行宽度自适应：不够宽时只显示 icon（保留角标）
    const headTitleRow = panel.querySelector('.ai-head-title-row');
    if (headTitleRow && typeof ResizeObserver === 'function') {
        const headRO = new ResizeObserver(() => {
            const width = headTitleRow.clientWidth;
            headTitleRow.classList.toggle('ai-head-compact', width < 420);
            // 中等宽度先把「变更 N」徽标收起：它是这一排里最宽、且可折行的元素，
            // 挤到 420–560 区间时会折成「变 / 更 N」两行（用户实测）。改动汇总在消息流
            // 轮尾卡片里仍可见，故此处先收起它，Git / 搜索留到 .ai-head-compact 档再收。
            headTitleRow.classList.toggle('ai-head-tight', width < 560);
        });
        headRO.observe(headTitleRow);
    }
    // 面板在原闭包体位次（init 之后）调用：置 HUD 就绪并刷一次头部
    function initHud() {
        hudReady = true;
        updateHeadHud();
    }

    return {
        sessionTitleOf, sessionTitleById, updateHeadIdentity,
        bgJobStateOf, rootSessionIdOf, hudSessionId, bgEntryOwnerId, isBgEntryOfHud, hudBgEntries,
        sessionHasLiveBgJob, runningBgCount, listAgentsForHud, setChipCount,
        notifyBackgroundActivity, refreshHeadChips, updateHeadHud,
        hideChipsPop, positionChipsPop, agentStateBadge, agentStatusIcon, bgJobFirstLine, taskSnippet,
        openBgTermInContent, renderChipsPop, toggleChipsPop,
        initHud,
    };
}
