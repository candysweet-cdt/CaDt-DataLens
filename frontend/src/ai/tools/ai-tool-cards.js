// ai-tool-cards.js：工具卡 / 审批卡渲染（命令审批、写审批、Env、Ask 卡、diff 预览、工具消息壳、助手消息更新）。
// 从 ai-panel.js 拆出（docs/unfinished-plans/structure-cleanup.md 阶段 3），函数体逐字搬移。
// 折叠状态 Map 与转录 Map 经 ctx 注入（引用稳定）；dismissedPlanApproval 经 setDismissedPlanApproval 写。
import {iconSvg} from '../../core/icons.js';
import {createFileIcon} from '../../core/fileicons.js';
import {enhanceWidgets, parkPendingWidgets, restoreParkedWidgets} from '../../core/widget.js';
import {aiFormatTime, aiTextOf} from '../core/ai-constants.js';
import {parseJson} from '../../core/json-safe.js';
import {diffNoDigits} from '../chat/ai-diff-view.js';
import {agentLevelText} from '../group/ai-team-model.js';
import {formatCommandDuration} from './ai-terminal-tools.js';
import {answerThinkingDefaultCollapsed} from '../chat/ai-always-collapse.js';
import {CONTINUATION_PROMPT, truncatedNotice} from '../chat/ai-truncation.js';
import '../core/ai-plan-file.js';

// ===== 工具状态与实时摘要 =====
// 解码可能未闭合的 JSON 字符串字面量：截掉不完整转义、补收尾引号再 parse；
// parse 仍失败（如截断的 \uXX）就退回手写替换。仅显示用，无需严格。
function decodePartialJsonString(frag) {
    const s = String(frag || '').replace(/\\+$/, '');
    try {
        return JSON.parse('"' + s + '"');
    } catch (e) {
        return s.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
            .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
}

// 流式工具卡的增量解析：路径（可能未闭合）拆成 文件名 / 目录，附已接收体积，
// write_file 另带 content-so-far；edit_file 另带 oldString（**闭合才算完整**，open 收尾引号匹配）
// 与 new_string-so-far（未闭合匹配，闭不闭合都能取到值）——供流式 ± 行数估算。
// 模块级导出纯函数，ai-tool-cards.test.mjs 覆盖。
export function liveToolParts(args) {
    const raw = String(args || '');
    const size = raw.length >= 1024 ? (raw.length / 1024).toFixed(1) + ' KB' : raw.length + ' B';
    // chars = 已接收的参数字节数（原始长度）：占位行靠它区分「一个字都还没来」与「真收到了 0 B」，
    // 别用 size 字符串反推（格式化后会丢精度）。
    const parts = {path: '', dir: '', name: '', size, chars: raw.length, content: null, oldString: null, newString: null};
    const pathMatch = raw.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (pathMatch) {
        parts.path = decodePartialJsonString(pathMatch[1]);
        const idx = Math.max(parts.path.lastIndexOf('/'), parts.path.lastIndexOf('\\'));
        parts.name = idx >= 0 ? parts.path.slice(idx + 1) : parts.path;
        parts.dir = idx >= 0 ? parts.path.slice(0, idx) : '';
    }
    const contentMatch = raw.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (contentMatch) parts.content = decodePartialJsonString(contentMatch[1]);
    // 工具 schema 用 camelCase（ai-tool-defs 的 oldString/newString）：这里曾按
    // snake_case 取值，流式阶段永远匹配不到，± 行数统计一直不显示。
    const oldMatch = raw.match(/"oldString"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (oldMatch) parts.oldString = decodePartialJsonString(oldMatch[1]);
    const newMatch = raw.match(/"newString"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (newMatch) parts.newString = decodePartialJsonString(newMatch[1]);
    return parts;
}

// 旧版摘要文案（liveToolParts 的字符串形态），保留给测试与可能的复用。
export function liveToolSummary(args) {
    const parts = liveToolParts(args);
    if (!parts.path) return '参数接收中 ' + parts.size;
    return parts.path + ' · 参数接收中 ' + parts.size;
}

// 流式占位行右侧状态文案。工具调用头（name）通常远早于参数字节到达，而部分网关
// （实测 sensenova-6.8-flash 走 token.sensenova.cn）把整段工具参数憋完再回放，
// 中间十几秒零字节——这段时间显示「接收中 0 B」看着像卡死 / 计数器坏了。
// 零字节统一显示「等待参数…」，收到首块后才报体积。
// 导出供 ai-tool-cards.test.mjs 防回归。
export function liveToolStateText(parts) {
    if (!parts || !(parts.chars > 0)) return '等待参数…';
    return '接收中 ' + parts.size;
}

// spinner 的 CSS 动画绑在 ::before 上：节点一旦被 remove + insert（哪怕同一父节点同一位置），
// 动画对象就会被替换、进度归零——这正是「转一点点又被弹回初始状态」的根因。实测 Chrome：
// appendChild(已有子节点) 后旧动画 playState 变 idle、新动画 currentTime = 0。
// 这里给每个 spinner 记一个稳定起始时刻，用负 animation-delay 继承全局相位，
// 于是即便某条路径仍在重建 DOM，视觉上也是接着转而不是回弹。
// WeakMap 以消息对象为键：跨轮自动隔离、消息回收即释放，不需要手动清理。
const AI_SPIN_MS = 900; // 与 style.css .ai-tool-spinner::before 的 0.9s 保持一致
const cardSpinStart = new WeakMap();
const liveSpinStart = new WeakMap();
// 可视化 loading 的相位（转环 0.9s / 扫光 1.9s / 呼吸 1.7s，与 style.css 三条动画周期一致）。
// 流式每帧 md.innerHTML 重建 + park/restore 重新插入会重置 CSS 动画对象（currentTime 归零），
// 给每个 pending widget 补负 animation-delay 继承全局相位，转环才不会「转一点又被弹回」。
const WIDGET_SPIN_MS = 900;
const WIDGET_SWEEP_MS = 1900;
const WIDGET_BREATHE_MS = 1700;
const widgetPhaseStart = new WeakMap();
function syncWidgetLoadingPhase(root, message) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    const pending = root.querySelectorAll('.ai-widget:not([data-widget-ready])');
    if (!pending.length) return;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    let start = widgetPhaseStart.get(message);
    if (start === undefined) {
        start = now;
        widgetPhaseStart.set(message, start);
    }
    const phase = (period) => {
        const p = ((now - start) % period + period) % period;
        // floor 避免 round 把 899.7ms 抬成 900ms（≡0）导致相位跳回起点（审查轻微 1）。
        return p >= 1 ? '-' + Math.floor(p) + 'ms' : '0ms';
    };
    const spin = phase(WIDGET_SPIN_MS);
    const sweep = phase(WIDGET_SWEEP_MS);
    const breathe = phase(WIDGET_BREATHE_MS);
    for (const node of pending) {
        node.style.setProperty('--ai-widget-spin-phase', spin);
        node.style.setProperty('--ai-widget-sweep-phase', sweep);
        node.style.setProperty('--ai-widget-breathe-phase', breathe);
    }
}
function makeToolSpinner(reg, key) {
    const el = document.createElement('span');
    el.className = 'ai-tool-spinner';
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    let start = reg.get(key);
    if (start === undefined) {
        start = now;
        reg.set(key, start);
    }
    const phase = ((now - start) % AI_SPIN_MS + AI_SPIN_MS) % AI_SPIN_MS;
    if (phase >= 1) el.style.setProperty('--ai-spin-phase', '-' + Math.round(phase) + 'ms');
    return el;
}

// 流式占位行的顺序对齐：只在顺序真的不同时返回最小的 insertBefore 操作。
// 纯函数（无 DOM），供 ai-tool-cards.test.mjs 防回归；顺序不变必须返回空 moves，
// 否则每 80ms 一次的 appendChild 会重启 spinner 动画。
// 执行方式：先 row.remove() 再 box.insertBefore(row, box.children[i] || null)。
export function planLiveRowOrder(current, desired) {
    const kids = current.slice();
    const moves = [];
    for (let i = desired.length - 1; i >= 0; i--) {
        if (kids[i] === desired[i]) continue;
        const at = kids.indexOf(desired[i]);
        if (at >= 0) kids.splice(at, 1);
        kids.splice(i, 0, desired[i]);
        moves.push(i);
    }
    const trim = Math.max(0, kids.length - desired.length);
    if (trim) kids.splice(kids.length - trim, trim);
    return {moves, trim, final: kids};
}

// 工具卡「仍在运行」的唯一判定。`interrupted` 是终止态的最高优先级标记：停止时先落它，
// 而 status 可能被迟到回来的审批 / 分类器回调改回 running（executeTool 里的早期放行路径），
// 于是出现「头部已停止、正文写正在执行命令…、spinner 一直转」的自相矛盾卡片。
// 头部状态（toolStateText）本来就先看 interrupted，渲染其余部分必须同一口径。
// 导出供 ai-tool-cards.test.mjs 防回归。
export function toolIsLive(message) {
    if (!message || message.interrupted) return false;
    return message.status === 'running';
}

// 工具卡头真正指向本地文件的工具：这些卡的 primary 是文件名，可挂「点击打开」超链接。
// list_dir 的 primary 是目录、search_text 是查询词、generate_* 是提示词——都不算文件。
export function toolShowsFileLink(message) {
    const n = message && message.name;
    return n === 'read_file' || n === 'read_image' || n === 'write_file' ||
        n === 'edit_file' || n === 'ocr' || n === 'transcribe_audio';
}

// 卡头文件名点击要打开的绝对路径。优先级：执行时记录的目标 > 审批里的落盘绝对路径 >
// 参数里已是绝对路径 > 工作区根 + 卡头相对路径（历史会话 / 执行中兜底）。
// 纯函数，root 由调用方从 getScopeRoot() 传入，便于测试。
export function toolFileOpenTarget(message, info, root) {
    if (!message || !info || info.remote || !info.primary || info.primary === '—') return '';
    if (message.targetPath) return message.targetPath;
    if (message.approval && message.approval.path) return message.approval.path;
    const args = parseJson(message.arguments, {}) || {};
    const raw = aiTextOf(args.path).trim();
    if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(raw)) return raw;
    const rel = (info.dir ? info.dir + '/' : '') + info.primary;
    const base = String(root || '').replace(/[\\/]+$/, '');
    return base ? base + '/' + rel : rel;
}

// 计划批准指令（纯函数，便于测试）：应用代用户按「执行计划」发出的固定指令。
// 不勾隔离区时维持旧文案（detectAppMessage 靠「计划已批准，请立即按」前缀认回历史会话）；
// 勾选隔离区时明确告知「隔离区已建好、改动只写隔离区、完成后 export 回灌」，否则模型
// 会按主根习惯动手，绕过隔离写闸（主根只读）。两种文案都以「计划已批准，请立即按」开头。
export function planApprovalInstruction(inWorktree, session) {
    const base = '计划已批准，请立即按你通过 submit_plan 提交的计划开始执行，不要重复计划内容。' +
        '计划模式已随批准自动退出，不要再调用 plan_mode。';
    if (!inWorktree) return base;
    const name = (session && session.worktree && session.worktree.name) || '';
    const prefix = name ? '.cadt/worktree/' + name + '/' : '.cadt/worktree/<slug>/';
    return base + '\n\n' +
        '本次已按你的选择先创建隔离工作区：所有文件改动写到 ' + prefix + '（相对范围根），不要改主根同名文件；' +
        '隔离期间主根只读，回灌只能在完成后经 worktree_manage(action=export) 生成补丁交用户审阅。' +
        'run_command / background_command 未显式传 cwd 时默认在隔离区里执行。';
}

// ===== 审批与询问卡片渲染 =====
export function createAIToolCards(ctx) {
    const copyText = ctx.copyText;
    const flash = ctx.flash;
    // 可视化卡片「另存为」用：AIEnsureDir + SaveFileChecked 落盘 .cadt/answers/
    const backend = ctx.backend || null;
    const renderMarkdown = ctx.renderMarkdown;
    const renderMermaidBlocks = ctx.renderMermaidBlocks;
    const openExternal = ctx.openExternal;
    // 可视化卡片「全屏」：复用 AI 面板图片灯箱放大 SVG（经 ai-panel 注入）
    const openWidgetFullscreen = typeof ctx.openWidgetFullscreen === 'function' ? ctx.openWidgetFullscreen : null;
    // 打开文件并跳行（main.js 的 openTargets，经 ai-panel 透传）：read_file 卡路径超链接用
    const openTargets = typeof ctx.openTargets === 'function' ? ctx.openTargets : null;
    // submit_plan 工具卡「查看计划」：已批准开 .cadt/plan/ 的真文件，未批准开虚拟只读预览
    const openPlan = typeof ctx.openPlan === 'function' ? ctx.openPlan : null;
    const settings = ctx.settings;
    // 助手展示名（ai-panel 注入）：气泡角色标签跟随个性化命名，默认名时仍是「AI」行径不变
    const assistantName = typeof ctx.assistantName === 'function' ? ctx.assistantName : () => 'AI';
    const getScopeRoot = ctx.getScopeRoot;
    // 会话根（批次 B，ai-panel 注入 sessionScopeRoot）：计划审批记规则 / 判 risky 都按会话根，
    // 不按「用户此刻显示的窗口工作区」。未注入时回落 getScopeRoot（旧行为）。
    const scopeRootOf = typeof ctx.scopeRootOf === 'function' ? ctx.scopeRootOf : null;
    const currentSession = ctx.currentSession;
    const currentScopeOf = ctx.currentScopeOf;
    const persistSessions = ctx.persistSessions;
    const renderMessages = ctx.renderMessages;
    const submitText = ctx.submitText;
    const streamOf = ctx.streamOf;
    const updateScopeUI = ctx.updateScopeUI;
    const addCommandApprovalRule = ctx.addCommandApprovalRule;
    const appendActions = ctx.appendActions;
    const renderPatchApprovalBody = ctx.renderPatchApprovalBody;
    const renderPendingApprovalPlaceholder = ctx.renderPendingApprovalPlaceholder;
    const renderThinkBody = ctx.renderThinkBody;
    const aiThinkKey = ctx.aiThinkKey;
    const aiThinkLabel = ctx.aiThinkLabel;
    const resolveAIImages = ctx.resolveAIImages;
    // 文件引用链接（ai-panel 的 enhanceAIFileRefs）：inline code 里的工作区文件路径 → 可点击链接
    const enhanceAIFileRefs = typeof ctx.enhanceAIFileRefs === 'function' ? ctx.enhanceAIFileRefs : null;
    const toggleThink = ctx.toggleThink;
    const toolArgsSummary = ctx.toolArgsSummary;
    const toolStateText = ctx.toolStateText;
    const approvalTraceNote = ctx.approvalTraceNote;
    const renderMessageQueue = ctx.renderMessageQueue;
    const updateComposerTakeover = ctx.updateComposerTakeover;
    const thinkFoldState = ctx.thinkFoldState;
    const toolFoldState = ctx.toolFoldState;
    const subAgentTranscripts = ctx.subAgentTranscripts;
    const setDismissedPlanApproval = ctx.setDismissedPlanApproval;

    // saveWidgetAs 可视化卡片「另存为」：用户主动动作，不走 write_file 审批链。
    // 写工作区 .cadt/answers/<slug>.<ext>（父目录自动创建）；与 answer-me-with-html 落盘区共用。
    async function saveWidgetAs(payload) {
        const root = getScopeRoot();
        if (!root) {
            flash('没有打开的工作区，无法另存为', true);
            return;
        }
        if (!backend || !backend.AIEnsureDir || !backend.SaveFileChecked) {
            flash('当前环境不支持另存为', true);
            return;
        }
        const dir = root.replace(/[\\/]+$/, '') + '/.cadt/answers';
        const path = dir + '/card-' + Date.now().toString(36) + '.' + (payload.ext || 'html');
        await backend.AIEnsureDir(dir);
        await backend.SaveFileChecked(path, payload.content || '', '\n', false, 'utf-8', '');
        flash('已保存：' + path);
    }

    function renderCommandApprovalBody(container, message, approval) {
        if (approval.state === 'pending') {
            renderPendingApprovalPlaceholder(container, approval);
            return;
        }
        const meta = document.createElement('div');
        meta.className = 'ai-approval-meta';
        const label = document.createElement('span');
        label.className = 'ai-approval-path';
        // 显式指定了 shell 时如实标出来：审批的人要知道这条命令是在 bash 还是 PowerShell 里跑
        label.textContent = approval.shell ? '终端命令 · ' + approval.shell : '终端命令';
        meta.appendChild(label);
        if (approval.cwd) {
            const cwd = document.createElement('span');
            cwd.className = 'ai-command-cwd';
            cwd.textContent = approval.cwd;
            cwd.dataset.tip = approval.cwd;
            meta.appendChild(cwd);
        }
        container.appendChild(meta);
        const line = document.createElement('pre');
        line.className = 'ai-command-line';
        line.textContent = approval.command;
        container.appendChild(line);
        if (approval.state === 'pending') {
            const actions = document.createElement('div');
            actions.className = 'ai-approval-actions';
            const deny = document.createElement('button');
            deny.type = 'button';
            deny.className = 'dlg-btn';
            deny.dataset.aiApprove = 'deny';
            deny.textContent = '放弃';
            const apply = document.createElement('button');
            apply.type = 'button';
            apply.className = 'dlg-btn primary';
            apply.dataset.aiApprove = 'apply';
            apply.textContent = '执行';
            actions.append(deny, apply);
            container.appendChild(actions);
            return;
        }
        const result = document.createElement('div');
        result.className = 'ai-approval-result ' + approval.state;
        result.textContent = approval.state === 'approved'
            ? (message.interrupted
                ? '命令已中断'
                : (toolIsLive(message) ? '正在执行命令…' : '命令已执行' + approvalTraceNote(approval)))
            : approval.state === 'denied'
                ? '已放弃，命令未执行'
                : (approval.state === 'failed'
                    ? ('执行失败：' + (approval.error || '无法执行命令'))
                    : '审批已取消');
        container.appendChild(result);
        if (message.content) {
            const output = document.createElement('div');
            output.className = 'ai-approval-output';
            output.textContent = message.content;
            container.appendChild(output);
        }
    }

    // 隔离工作区动作（worktree_manage 的 create / discard）：已裁决后的结果态。
    // 没有 diff / 逐文件列表，只在工具卡里给一句结果；完整审批过程在 composer 接管卡。
    function renderWorktreeApprovalBody(container, message, approval) {
        if (approval.state === 'pending') {
            renderPendingApprovalPlaceholder(container, approval);
            return;
        }
        const discard = approval.action === 'discard';
        const target = approval.relPath || approval.name || '';
        const result = document.createElement('div');
        result.className = 'ai-approval-result ' + approval.state;
        result.textContent = approval.state === 'approved'
            ? (toolIsLive(message)
                ? (discard ? '正在丢弃隔离工作区…' : '正在创建隔离工作区…')
                : (discard ? '已丢弃 ' + target : '已创建隔离工作区') + approvalTraceNote(approval))
            : approval.state === 'denied'
                ? (discard ? '已保留隔离工作区' : '已取消创建隔离工作区')
                : (approval.state === 'failed'
                    ? ((discard ? '丢弃失败：' : '创建失败：') + (approval.error || ''))
                    : '操作已取消');
        container.appendChild(result);
        if (message.content) {
            const output = document.createElement('div');
            output.className = 'ai-approval-output';
            output.textContent = message.content;
            container.appendChild(output);
        }
    }

    // 通用动作审批（危险设置 / 装删插件）：已裁决后只给一句结果，完整过程在 composer 接管卡。
    function renderActionApprovalBody(container, message, approval) {
        if (approval.state === 'pending') {
            renderPendingApprovalPlaceholder(container, approval);
            return;
        }
        const what = approval.actionTitle || '操作';
        const result = document.createElement('div');
        result.className = 'ai-approval-result ' + approval.state;
        result.textContent = approval.state === 'approved'
            ? (toolIsLive(message) ? '正在执行：' + what + '…' : '已批准：' + what + approvalTraceNote(approval))
            : approval.state === 'denied'
                ? '已拒绝：' + what
                : (approval.state === 'failed'
                    ? '执行失败：' + (approval.error || what)
                    : '操作已取消：' + what);
        container.appendChild(result);
    }

    function renderApprovalBody(container, message, approval, opts) {
        if (approval.state === 'pending') {
            renderPendingApprovalPlaceholder(container, approval);
            return;
        }
        if (approval.kind === 'command') {
            renderCommandApprovalBody(container, message, approval);
            return;
        }
        if (approval.kind === 'patch') {
            renderPatchApprovalBody(container, message, approval);
            return;
        }
        if (approval.kind === 'worktree') {
            renderWorktreeApprovalBody(container, message, approval);
            return;
        }
        if (approval.kind === 'action') {
            renderActionApprovalBody(container, message, approval);
            return;
        }
        if (approval.kind === 'orchestration') {
            const result = document.createElement('div');
            result.className = 'ai-approval-result ' + approval.state;
            result.textContent = approval.state === 'approved'
                ? (message.content || '编排计划已批准')
                : (approval.state === 'denied' ? '已取消本次编排' : '编排计划已取消');
            container.appendChild(result);
            return;
        }
        // skipMeta：工具卡头部已带路径与 diff 统计时，正文不再重复
        if (!(opts && opts.skipMeta)) {
            const meta = document.createElement('div');
            meta.className = 'ai-approval-meta';
            const path = document.createElement('span');
            path.className = 'ai-approval-path';
            path.textContent = approval.relPath || approval.path;
            path.dataset.tip = approval.path || '';
            // diff 统计只有写类审批才有（read 审批如 list_dir / read_file 没有 added/removed，
            // 直接拼会出「+undefined −undefined」）；与头部统计的判定保持一致。
            if (approval.added || approval.removed) {
                const stat = document.createElement('span');
                stat.className = 'ai-approval-stat';
                const add = document.createElement('span');
                add.className = 'add';
                add.textContent = '+' + approval.added;
                const del = document.createElement('span');
                del.className = 'del';
                del.textContent = '−' + approval.removed;
                stat.append(add, del);
                if (approval.newFile) {
                    const tag = document.createElement('span');
                    tag.className = 'ai-approval-tag';
                    tag.textContent = '新文件';
                    stat.appendChild(tag);
                }
                meta.append(path, stat);
            } else {
                meta.append(path);
            }
            container.appendChild(meta);
        }

        if (approval.dirty) {
            const warn = document.createElement('div');
            warn.className = 'ai-approval-warn';
            warn.textContent = '该文件在编辑器中存在未保存修改；应用后不会自动重载，请手动重新加载。';
            container.appendChild(warn);
        }

        if (approval.diff && approval.diff.length) {
            renderDiffInto(container, approval);
            if (approval.truncated) {
                const more = document.createElement('div');
                more.className = 'ai-approval-more';
                more.textContent = '…（diff 预览已截断）';
                container.appendChild(more);
            }
        }

        if (approval.state === 'pending') {
            const options = document.createElement('div');
            options.className = 'ai-approval-remember';
            const sessionLabel = document.createElement('label');
            const sessionBox = document.createElement('input');
            sessionBox.type = 'checkbox';
            sessionBox.dataset.aiRemember = 'session';
            sessionLabel.append(sessionBox, document.createTextNode(' 本会话允许此文件'));
            const alwaysLabel = document.createElement('label');
            const alwaysBox = document.createElement('input');
            alwaysBox.type = 'checkbox';
            alwaysBox.dataset.aiRemember = 'always';
            alwaysLabel.append(alwaysBox, document.createTextNode(' 总是允许此文件'));
            options.append(sessionLabel, alwaysLabel);
            container.appendChild(options);

            const actions = document.createElement('div');
            actions.className = 'ai-approval-actions';
            const deny = document.createElement('button');
            deny.type = 'button';
            deny.className = 'dlg-btn';
            deny.dataset.aiApprove = 'deny';
            deny.textContent = '放弃';
            const apply = document.createElement('button');
            apply.type = 'button';
            apply.className = 'dlg-btn primary';
            apply.dataset.aiApprove = 'apply';
            apply.textContent = '应用';
            actions.append(deny, apply);
            container.appendChild(actions);
        } else {
            const result = document.createElement('div');
            result.className = 'ai-approval-result ' + approval.state;
            // 读类审批（read_file / 列目录 / 搜索起点）没有「更改」可应用，文案按读取措辞
            const readKind = approval.kind === 'read';
            result.textContent = approval.state === 'approved'
                ? (toolIsLive(message)
                    ? (readKind ? '正在读取…' : '正在应用更改…')
                    : (readKind ? '已授权读取' : '已应用更改') + approvalTraceNote(approval))
                : approval.state === 'denied'
                    ? (readKind ? '已拒绝，未读取' : '已放弃，文件未修改')
                    : (approval.state === 'failed'
                        ? ('应用失败：' + (approval.error || '写入文件失败'))
                        : '审批已取消');
            container.appendChild(result);
            if (message.content) {
                const output = document.createElement('div');
                output.className = 'ai-approval-output';
                output.textContent = message.content;
                container.appendChild(output);
            }
        }
    }

    function renderEnvAskBody(container, message, envAsk) {
        const meta = document.createElement('div');
        meta.className = 'ai-approval-meta';
        const name = document.createElement('span');
        name.className = 'ai-approval-path env-ask-name';
        name.textContent = envAsk.name;
        meta.appendChild(name);
        if (envAsk.description) {
            const desc = document.createElement('span');
            desc.className = 'ai-approval-stat env-ask-desc';
            desc.textContent = envAsk.description;
            meta.appendChild(desc);
        }
        container.appendChild(meta);

        if (envAsk.state === 'pending') {
            // 输入区已改为 composer 接管（renderEnvAskTakeover），消息流只留占位提示。
            const wait = document.createElement('div');
            wait.className = 'ai-approval-result pending';
            wait.textContent = '等待用户在下方输入区填写变量值…';
            container.appendChild(wait);
        } else {
            const result = document.createElement('div');
            result.className = 'ai-approval-result ' + envAsk.state;
            result.textContent = envAsk.state === 'approved'
                ? (toolIsLive(message) ? '正在创建变量…' : '已创建环境变量 ' + envAsk.name)
                : envAsk.state === 'failed'
                    ? '创建失败：' + (message.content || '保存失败')
                    : '已取消，未创建变量';
            container.appendChild(result);
            if (message.content) {
                const output = document.createElement('div');
                output.className = 'ai-approval-output';
                output.textContent = message.content;
                container.appendChild(output);
            }
        }
    }

    function askStateLabel(ask) {
        return {
            pending: '等待回答',
            answered: '已回答',
            skipped: '已跳过',
            timeout: '已超时',
            timeout_abort: '超时停止',
            cancelled: '已取消',
            expired: '已过期',
        }[ask.state] || ask.state;
    }

    function askResultText(ask) {
        if (ask.state === 'timeout' && ask.source === 'timeout_recommended') return '超时未回答，已自动采用推荐项';
        if (ask.state === 'timeout') return '超时未回答，已交给 AI 决定并继续';
        if (ask.state === 'timeout_abort') return '超时未回答，已停止本轮';
        if (ask.state === 'cancelled') return '问题已取消';
        if (ask.state === 'skipped') return '用户跳过了回答';
        if (ask.state === 'expired') return '应用重启，这个问题没收到回答';
        return '';
    }

    function renderAskCard(wrap, message) {
        const ask = message.ask;
        const card = document.createElement('div');
        card.className = 'ai-ask-card ' + ask.state;
        const head = document.createElement('div');
        head.className = 'ai-ask-head';
        const icon = document.createElement('span');
        icon.className = 'ai-ask-icon';
        icon.innerHTML = iconSvg('question', 16);
        const title = document.createElement('span');
        title.className = 'ai-ask-title';
        title.textContent = ask.questions.length > 1 ? 'AI 提问 · ' + ask.questions.length + ' 个问题' : 'AI 提问';
        const state = document.createElement('span');
        state.className = 'ai-ask-state';
        state.textContent = askStateLabel(ask);
        head.append(icon, title, state);
        card.appendChild(head);
        if (ask.state === 'pending') {
            const pending = document.createElement('div');
            pending.className = 'ai-ask-question';
            pending.textContent = '等待在底部输入框回答…';
            card.appendChild(pending);
            wrap.appendChild(card);
            return;
        }
        ask.questions.forEach((question, index) => {
            const block = document.createElement('div');
            block.className = 'ai-ask-record';
            const q = document.createElement('div');
            q.className = 'ai-ask-question';
            q.textContent = (ask.questions.length > 1 ? (index + 1) + '. ' : '') + question.question;
            block.appendChild(q);
            if (question.detail) {
                const detail = document.createElement('div');
                detail.className = 'ai-ask-detail';
                detail.textContent = question.detail;
                block.appendChild(detail);
            }
            const answer = (ask.answers || []).find((item) => item.id === question.id) || {};
            const lines = [];
            if (answer.selected && answer.selected.length) lines.push('选择：' + answer.selected.join('、'));
            if (answer.custom) lines.push('补充：' + answer.custom);
            const answerEl = document.createElement('div');
            answerEl.className = 'ai-ask-answer' + (lines.length ? '' : ' empty');
            answerEl.textContent = lines.length ? lines.join('；') : '未回答';
            block.appendChild(answerEl);
            card.appendChild(block);
        });
        const note = askResultText(ask);
        if (note) {
            const result = document.createElement('div');
            result.className = 'ai-ask-result';
            result.textContent = note;
            card.appendChild(result);
        }
        wrap.appendChild(card);
    }

// ===== 工具元数据表 =====
    // 工具卡 ZCode 风格：动词 + 图标 + 主参数（文件名/路径/命令）+ 目录 + diff 统计 + 状态
    // 每个动作使用独立图标，便于一眼区分「读取 / 搜索 / 写入」等不同操作。
    function toolMeta(name, approval) {
        // 插件工具（plugin__<pluginId>__<toolName>）：卡头显示「插件 · 工具短名」，
        // 不把完整命名空间摊在卡头上；来源由审批卡与目录另行标注。
        if (typeof name === 'string' && name.startsWith('plugin__')) {
            const rest = name.slice('plugin__'.length);
            const idx = rest.indexOf('__');
            const shortName = idx > 0 ? rest.slice(idx + 2) : rest;
            return {verb: '插件 · ' + (shortName || name), icon: 'download'};
        }
        switch (name) {
            case 'read_file': return {verb: '读取', icon: 'eye'};
            case 'code_outline': return {verb: '代码大纲', icon: 'list'};
            case 'read_image': return {verb: '看图', icon: 'image'};
            case 'read_video': return {verb: '看视频', icon: 'play'};
            case 'list_dir': return {verb: '列目录', icon: 'folder'};
            case 'search_text': return {verb: '搜索', icon: 'search'};
            case 'glob': return {verb: '找文件', icon: 'folder'};
            case 'web_search': return {verb: '联网搜索', icon: 'web-search'};
            case 'web_fetch': return {verb: '读取网页', icon: 'globe'};
            case 'generate_image': return {verb: '生成图片', icon: 'image'};
            case 'generate_video': return {verb: '生成视频', icon: 'image'};
            case 'check_gen': return {verb: '查询生成', icon: 'refresh'};
            case 'ocr': return {verb: '文字识别', icon: 'scan'};
            case 'text_to_speech': return {verb: '语音合成', icon: 'speaker'};
            case 'transcribe_audio': return {verb: '语音识别', icon: 'microphone'};
            case 'write_file': return {verb: (approval && approval.newFile) ? '新建' : '写入', icon: 'save'};
            case 'edit_file': return {verb: '编辑', icon: 'rename'};
            case 'propose_patch': return {verb: '补丁', icon: 'save'};
            case 'worktree_manage': return {verb: '隔离工作区', icon: 'folder'};
            case 'run_command': return {verb: '终端', icon: 'terminal'};
            case 'background_command': return {verb: '后台命令', icon: 'terminal'};
            case 'check_command': return {verb: '查询作业', icon: 'refresh'};
            case 'stop_command': return {verb: '停止作业', icon: 'close'};
            case 'terminal': return {verb: '终端读写', icon: 'terminal'};
            case 'schedule_create': return {verb: '创建定时任务', icon: 'clock'};
            case 'schedule_list': return {verb: '定时任务列表', icon: 'clock'};
            case 'timer_list': return {verb: '计时器读数', icon: 'clock'};
            case 'start_timer': return {verb: '开始计时', icon: 'clock'};
            case 'stop_timer': return {verb: '停止计时', icon: 'clock'};
            case 'reminder_list': return {verb: '提醒列表', icon: 'bell'};
            case 'reminder_add': return {verb: '加提醒', icon: 'bell'};
            case 'reminder_update': return {verb: '改提醒', icon: 'bell'};
            case 'reminder_remove': return {verb: '删提醒', icon: 'trash'};
            case 'schedule_delete': return {verb: '删除定时任务', icon: 'trash'};
            case 'schedule_toggle': return {verb: '启停定时任务', icon: 'refresh'};
            case 'spawn_agent': return {verb: '子代理', icon: 'agents'};
            case 'agent_send': return {verb: '通知子代理', icon: 'agents'};
            case 'agent_tree': return {verb: '查看团队树', icon: 'agents'};
            case 'agent_stop': return {verb: '停止子代理', icon: 'close'};
            case 'agent_compact': return {verb: '压缩子代理', icon: 'eraser'};
            case 'wait_agent': return {verb: '等待新输入', icon: 'agents'};
            case 'memory_list': return {verb: '记忆目录', icon: 'book'};
            case 'memory_read': return {verb: '读取记忆', icon: 'book-open'};
            case 'memory_write': return {verb: '写入记忆', icon: 'book-plus'};
            case 'write_worklog': return {verb: '记工作日志', icon: 'book-plus'};
            case 'session_history': return {verb: '查历史', icon: 'history'};
            case 'session_search': return {verb: '搜会话', icon: 'search'};
            case 'session_read': return {verb: '读会话', icon: 'sidechat'};
            case 'session_list': return {verb: '会话列表', icon: 'list'};
            case 'session_send': return {verb: '会话投递', icon: 'sidechat'};
            case 'orchestration_plan': return {verb: '编排计划', icon: 'branch'};
            case 'orchestration_report': return {verb: '编排回报', icon: 'branch'};
            case 'orchestration_status': return {verb: '编排状态', icon: 'branch'};
            case 'orchestration_control': return {verb: '编排控制', icon: 'branch'};
            case 'preference_list': return {verb: '偏好列表', icon: 'bookmark'};
            case 'preference_write': return {verb: '记录偏好', icon: 'bookmark-plus'};
            case 'preference_remove': return {verb: '删除偏好', icon: 'trash'};
            case 'skill_use': return {verb: '技能', icon: 'star'};
            case 'skill_list': return {verb: '技能目录', icon: 'book'};
            case 'cognition_read': return {verb: '读认知索引', icon: 'scan'};
            case 'cognition_edit': return {verb: '维护认知索引', icon: 'book-plus'};
            case 'cognition_status': return {verb: '索引治理报告', icon: 'chart'};
            case 'plan_mode': return {verb: '计划模式', icon: 'compass'};
            case 'submit_plan': return {verb: '提交计划', icon: 'compass'};
            case 'ask_user': return {verb: '提问', icon: 'info'};
            case 'app_control': return {verb: '应用操作', icon: 'gear'};
            case 'windows_control_mode': return {verb: '桌面控制', icon: 'cursor'};
            case 'todo_write': return {verb: '任务', icon: 'check'};
            case 'notify_send': return {verb: '消息', icon: 'bell'};
            case 'env_list': return {verb: '环境变量', icon: 'shield'};
            case 'env_create': return {verb: '新建变量', icon: 'shield-plus'};
            case 'browser_navigate': return {verb: '打开网页', icon: 'browser'};
            case 'browser_back': return {verb: '后退', icon: 'back'};
            case 'browser_forward': return {verb: '前进', icon: 'forward'};
            case 'browser_reload': return {verb: '刷新页面', icon: 'refresh'};
            case 'browser_snapshot': return {verb: '页面快照', icon: 'doc'};
            case 'browser_screenshot': return {verb: '截图', icon: 'camera'};
            case 'browser_click': return {verb: '点击', icon: 'cursor'};
            case 'browser_type': return {verb: '输入', icon: 'keyboard'};
            case 'browser_press_key': return {verb: '按键', icon: 'keycap'};
            case 'browser_wait': return {verb: '等待条件', icon: 'clock'};
            case 'browser_scroll': return {verb: '滚动页面', icon: 'chevron-down'};
            case 'browser_hover': return {verb: '悬停', icon: 'eye'};
            case 'browser_select': return {verb: '选择选项', icon: 'check'};
            case 'browser_resize': return {verb: '调整视口', icon: 'maximize'};
            case 'browser_evaluate': return {verb: '执行脚本', icon: 'code'};
            case 'browser_close': return {verb: '关闭页面', icon: 'close'};
            default: return {verb: name || '工具', icon: 'doc'};
        }
    }

// ===== 工具主标签与文件动词 =====
    function toolPrimary(message) {
        const args = parseJson(message.arguments, {}) || {};
        const path = aiTextOf(args.path).trim();
        const base = path ? path.replace(/^.*[\\/]/, '') : '';
        const dir = base && path.length > base.length ? path.slice(0, path.length - base.length).replace(/[\\/]+$/, '') : '';
        switch (message.name) {
            case 'read_file': {
                // 按行读取（startLine/endLine）时卡头补行范围徽标，否则看不出读的是哪段
                const startLine = Math.round(Number(args.startLine));
                const hasLines = Number.isFinite(startLine) && startLine > 0;
                let range = '';
                if (hasLines) {
                    const endLine = Math.round(Number(args.endLine));
                    range = Number.isFinite(endLine) && endLine > 0
                        ? startLine + '–' + endLine
                        : startLine + '–';
                }
                return {primary: base || path || '—', dir, range};
            }
            case 'write_file': case 'edit_file':
                return {primary: base || path || '—', dir};
            case 'read_image':
                // 网图（read_image 传 URL）：卡头显示「域名 + 路径」，且不做本地文件链接
                if (/^https?:\/\//i.test(path)) {
                    return {primary: path.replace(/^https?:\/\//i, '').replace(/[?#].*$/, ''), dir: '', remote: true};
                }
                return {primary: base || path || '—', dir};
            case 'list_dir':
                return {primary: aiTextOf(args.path).trim() || '.', dir: ''};
            case 'search_text':
                return {primary: aiTextOf(args.query).trim() || '—', dir: aiTextOf(args.path).trim()};
            case 'web_search':
                return {primary: aiTextOf(args.query).trim() || '—', dir: ''};
            case 'web_fetch':
                return {primary: aiTextOf(args.url).trim() || '—', dir: ''};
            case 'generate_image': case 'generate_video':
                return {primary: aiTextOf(args.prompt).trim().slice(0, 60) || '—', dir: ''};
            case 'ocr': case 'transcribe_audio':
                return {primary: base || path || '—', dir};
            case 'text_to_speech':
                return {primary: aiTextOf(args.text).trim().replace(/\s+/g, ' ').slice(0, 60) || '—', dir: ''};
            case 'check_gen':
                return {primary: aiTextOf(args.jobId).trim() || '—', dir: ''};
            case 'browser_navigate':
                return {primary: aiTextOf(args.url).trim() || '—', dir: ''};
            case 'browser_click': case 'browser_type':
                return {primary: aiTextOf(args.selector).trim() || (aiTextOf(args.text).trim() ? '「' + aiTextOf(args.text).trim().slice(0, 40) + '」' : '—'), dir: ''};
            case 'browser_hover': case 'browser_select':
                return {primary: aiTextOf(args.selector).trim() || '—', dir: ''};
            case 'browser_wait': {
                const cond = [aiTextOf(args.selector).trim(), aiTextOf(args.text).trim(), aiTextOf(args.url).trim()].filter(Boolean);
                return {primary: cond.length ? cond.join(' + ').slice(0, 60) : '—', dir: ''};
            }
            case 'browser_scroll': {
                const target = aiTextOf(args.selector).trim() || (args.byPx !== undefined && args.byPx !== null ? String(args.byPx) + 'px' : '') || aiTextOf(args.position).trim();
                return {primary: target ? target.slice(0, 60) : '—', dir: ''};
            }
            case 'browser_press_key':
                return {primary: aiTextOf(args.key).trim() || '—', dir: ''};
            case 'browser_resize':
                return {primary: (Math.round(Number(args.width)) || '?') + '×' + (Math.round(Number(args.height)) || '?'), dir: ''};
            case 'browser_evaluate':
                return {primary: aiTextOf(args.script).trim().replace(/\s+/g, ' ').slice(0, 80) || '—', dir: ''};
            case 'browser_back': case 'browser_forward': case 'browser_reload':
            case 'browser_snapshot': case 'browser_screenshot': case 'browser_close':
                return {primary: '', dir: ''};
            case 'plan_mode':
                return {primary: args.enabled === false ? '退出' : '进入', dir: ''};
            case 'submit_plan':
                // 计划正文很长，卡头只显示标题（缺省「计划文档」），绝不把 plan 参数塞进摘要
                return {primary: aiTextOf(args.title).trim().slice(0, 60) || '计划文档', dir: ''};
            case 'run_command':
                return {primary: aiTextOf(args.command).trim().replace(/\s+/g, ' '), dir: ''};
            case 'background_command':
                return {primary: aiTextOf(args.command).trim().replace(/\s+/g, ' '), dir: ''};
            case 'check_command': case 'stop_command':
                return {primary: aiTextOf(args.jobId).trim() || '—', dir: ''};
            case 'schedule_create':
                return {primary: aiTextOf(args.name).trim() || aiTextOf(args.prompt).trim().slice(0, 40) || '—', dir: ''};
            case 'schedule_list':
                return {primary: '定时任务', dir: ''};
            case 'timer_list':
                return {primary: '计时器', dir: ''};
            case 'schedule_delete': case 'schedule_toggle':
                return {primary: aiTextOf(args.id).trim() || '—', dir: ''};
            case 'spawn_agent':
                return {primary: aiTextOf(args.name).trim() || '—', dir: ''};
            case 'memory_read': case 'memory_write':
                return {primary: aiTextOf(args.name).trim() || '—', dir: ''};
            case 'memory_list':
                return {primary: '记忆目录', dir: ''};
            // 等待 / 协作 / 会话类：卡头只给「做什么、等多久、对谁」，不把参数 JSON 原样摆出来
            case 'wait_agent': {
                const sec = Math.round(Number(args.timeoutSec) || 0);
                return {primary: sec > 0 ? '最多 ' + Math.max(1, Math.round(sec / 60)) + ' 分钟' : '等待新消息', dir: ''};
            }
            case 'agent_send': case 'agent_stop': case 'agent_compact':
                return {primary: aiTextOf(args.agentId).trim() || '子代理', dir: ''};
            case 'agent_tree':
                return {primary: '', dir: ''};
            case 'notify_send':
                return {primary: aiTextOf(args.title).trim().slice(0, 60), dir: ''};
            case 'session_search': case 'session_history':
                return {primary: aiTextOf(args.query).trim().slice(0, 60), dir: ''};
            case 'session_read':
                return {primary: aiTextOf(args.id).trim(), dir: ''};
            case 'session_send':
                return {primary: '会话投递', dir: ''};
            case 'session_list':
                return {primary: '', dir: ''};
            case 'start_timer':
                return {primary: aiTextOf(args.label).trim().slice(0, 40), dir: ''};
            case 'stop_timer':
                return {primary: aiTextOf(args.id).trim(), dir: ''};
            case 'reminder_add': case 'reminder_update': case 'reminder_remove':
                return {primary: aiTextOf(args.title || args.id).trim().slice(0, 60), dir: ''};
            case 'reminder_list': case 'env_list':
                return {primary: '', dir: ''};
            case 'env_create':
                return {primary: aiTextOf(args.name).trim(), dir: ''};
            case 'preference_write': case 'preference_remove':
                return {primary: aiTextOf(args.text || args.id).trim().slice(0, 80) || '—', dir: ''};
            case 'preference_list':
                return {primary: '用户偏好', dir: ''};
            case 'skill_use':
                return {primary: aiTextOf(args.name).trim() || '—', dir: ''};
            case 'app_control':
                return {primary: aiTextOf(args.action).trim() || '—', dir: ''};
            case 'ask_user': case 'todo_write': case 'env_list': case 'env_create':
                return {primary: '', dir: ''};
            default:
                return {primary: toolArgsSummary(message.arguments), dir: ''};
        }
    }

// ===== 工具消息渲染 =====
    function toolFileVerb(message) {
        return message.name === 'read_file' || message.name === 'read_image' ||
            message.name === 'write_file' || message.name === 'edit_file';
    }

    // diff 视图（带行号：− 行显示旧行号，+/空白行显示新行号；行号取 preview 里
    // 按完整 diff 算好的真实文件行号，旧会话没有该字段时退回从 1 连数）
    function renderDiffInto(container, approval) {
        if (!approval.diff || !approval.diff.length) return;
        const diff = document.createElement('div');
        diff.className = 'ai-diff';
        // 行号列宽随最大行号位数走（style.css 以 max(22px, var(--ai-diff-no-w)) 消费）：
        // 固定 22px 只装得下 3 位数，四位数行号会被继承的 overflow-wrap: anywhere
        // 从数字中间断行（3091 → 309/1 两行）
        diff.style.setProperty('--ai-diff-no-w', diffNoDigits(approval.diff) + 'ch');
        let oldLine = 1;
        let newLine = 1;
        for (const line of approval.diff) {
            if (line.t === '…') {
                const gap = document.createElement('div');
                gap.className = 'ai-diff-line gap';
                gap.textContent = '⋯';
                diff.appendChild(gap);
                continue;
            }
            const row = document.createElement('div');
            row.className = 'ai-diff-line ' + (line.t === '+' ? 'add' : (line.t === '-' ? 'del' : 'ctx'));
            const no = document.createElement('span');
            no.className = 'ai-diff-no';
            if (line.t === '-') {
                if (line.oldLine > 0) oldLine = line.oldLine;
                no.textContent = String(oldLine);
                oldLine++;
            } else {
                if (line.newLine > 0) newLine = line.newLine;
                no.textContent = String(newLine);
                newLine++;
            }
            const sign = document.createElement('span');
            sign.className = 'ai-diff-sign';
            sign.textContent = line.t === '+' ? '+' : (line.t === '-' ? '−' : ' ');
            const text = document.createElement('span');
            text.className = 'ai-diff-text';
            text.textContent = line.text || ' ';
            row.append(no, sign, text);
            diff.appendChild(row);
        }
        container.appendChild(diff);
    }

    // read_file 按行读取片段：与 diff 同款的「背景框 + 行号列 + 代码列」结构，
    // 让读取内容和 edit_file 的 diff 在视觉语义上一致——都是代码块，不是摊在卡片上的裸文本。
    // 正文每行形如「右对齐行号<TAB>代码」（见 ai-file-tools.readWindowOf），末尾可能有截断提示。
    function renderReadLinesInto(container, text) {
        const box = document.createElement('div');
        box.className = 'ai-read-body';
        const lines = String(text == null ? '' : text).split('\n');
        // 行号列宽随最大行号位数走（同 diff 的 --ai-diff-no-w）：固定 22px 装不下四位数行号
        let maxNoWidth = 0;
        for (const line of lines) {
            const m = line.match(/^(\s*\d+)\t/);
            if (m) maxNoWidth = Math.max(maxNoWidth, m[1].length);
        }
        if (maxNoWidth) box.style.setProperty('--ai-read-no-w', maxNoWidth + 'ch');
        for (const line of lines) {
            const m = line.match(/^(\s*\d+)\t(.*)$/);
            const row = document.createElement('div');
            row.className = 'ai-read-line';
            if (m) {
                const no = document.createElement('span');
                no.className = 'ai-read-no';
                no.textContent = m[1];
                const code = document.createElement('span');
                code.className = 'ai-read-text';
                code.textContent = m[2] || ' ';
                row.append(no, code);
            } else {
                // 截断提示 / 空行区间 / 其他非代码行：整行弱化显示
                const note = document.createElement('span');
                note.className = 'ai-read-note';
                note.textContent = line || ' ';
                row.appendChild(note);
            }
            box.appendChild(row);
        }
        container.appendChild(box);
    }

    // session：这张卡属于哪个会话（渲染目标会话，不一定是面板当前查看的会话）。
    // 支线对话标签页复用同一套渲染，卡内动作（查看计划）必须按它取，不能用 currentSession。
    function renderToolMessage(wrap, message, options, session) {
        if (message.ask) {
            renderAskCard(wrap, message);
            return;
        }
        const card = document.createElement('div');
        const approval = message.approval;
        const envAsk = message.envAsk;
        const isCommand = message.name === 'run_command' || message.name === 'background_command';
        // 读取卡：路径名即超链接（点击在标签页打开并跳到读取起始行）。按行读取（startLine/endLine）
        // 额外支持展开折叠——正文显示带行号的内容片段，让用户直接核对 AI 读了哪几行。
        const isRead = message.name === 'read_file';
        let readLineRange = '';
        if (isRead) {
            try {
                const args = parseJson(message.arguments, {}) || {};
                const s = Math.round(Number(args.startLine));
                if (Number.isFinite(s) && s > 0) {
                    const e = Math.round(Number(args.endLine));
                    readLineRange = Number.isFinite(e) && e > 0 ? s + '-' + e : s + '-';
                }
            } catch (e) {}
        }
        const isReadLines = !!readLineRange;
        // 内置技能卡：内容只注入模型上下文，不向用户展示（识别结果首行的来源标注「（内置）」，
        // 该文案来自 ai-panel skillSourceLabel('builtin') 单一来源）；工作区/用户技能照常可展开
        const isBuiltinSkill = message.name === 'skill_use' &&
            /^技能：[^\n]*（内置）/.test(aiTextOf(message.content));
        const agentRunning = message.name === 'spawn_agent' && message.agent && message.agent.state === 'running';
        const bgRunning = message.name === 'background_command' && message.bg && message.bg.state === 'running';
        // 同一条消息既要驱动 spinner / 「执行中…」文案，又要驱动卡片状态色：
        // 统一走 toolIsLive（interrupted 优先），别再用裸 status === 'running'。
        const live = toolIsLive(message);
        const cardState = (agentRunning || bgRunning || live) ? 'running' : (message.interrupted ? 'done' : (message.status || 'done'));
        card.className = 'ai-tool-card ' + cardState + (approval ? ' has-approval' : '') + (envAsk ? ' has-approval' : '') + (isCommand ? ' command' : '') + (message.name === 'spawn_agent' ? ' agent' : '') + (message.interrupted ? ' interrupted' : '');
        if ((approval && approval.state === 'pending') || (envAsk && envAsk.state === 'pending')) card.classList.add('approval-pending');
        wrap.appendChild(card);
        // 没有可展开正文的卡（只有「执行中…」/「（无输出）」这类状态占位）不摆折叠箭头：
        // 箭头展开只有一行字，头部状态徽标已经把话说完了。赋值点见下方的通用分支。
        let statusOnlyBody = false;
        const head = document.createElement('button');
        head.type = 'button';
        head.className = 'ai-tool-head';
        const chev = document.createElement('span');
        chev.className = 'ai-tool-chev';
        chev.innerHTML = iconSvg('chevron-down');
        // 动作词 + 图标 + 主参数（ZCode 风格）
        const meta = toolMeta(message.name, approval);
        const info = toolPrimary(message);
        const icon = document.createElement('span');
        icon.className = 'ai-tool-icon';
        icon.innerHTML = iconSvg(meta.icon, 13);
        const verb = document.createElement('span');
        verb.className = 'ai-tool-verb';
        verb.textContent = meta.verb;
        // 执行中：头部最前放旋转加载图标（替代旧 border-left 指示）
        // 相位以消息对象为键：refreshToolWrap / renderMessages 整卡重建后接着转，不回弹。
        if (live) {
            head.appendChild(makeToolSpinner(cardSpinStart, message));
        }
        head.append(chev, icon, verb);
        if ((isRead && !isReadLines) || isBuiltinSkill) chev.remove(); // 无展开功能，折叠箭头不出现（按行读取卡保留箭头）
        if (toolFileVerb(message) && info.primary && info.primary !== '—' && !info.remote) {
            head.appendChild(createFileIcon(info.primary, 'ai-tool-fileicon'));
        }
        if (info.primary) {
            const primary = document.createElement('span');
            primary.className = 'ai-tool-primary';
            primary.textContent = info.primary;
            if (toolShowsFileLink(message) && !info.remote && openTargets) {
                // 文件名即超链接：hover 下划线、点击在标签页打开。读取带 offset 时跳对应行。
                // 只对文件名加链接，卡头其余区域（箭头 / 动词 / 目录）照旧展开或折叠。
                const root = typeof getScopeRoot === 'function' ? getScopeRoot() : '';
                const target = toolFileOpenTarget(message, info, root);
                if (target) {
                    primary.classList.add('ai-tool-link');
                    primary.dataset.tip = '点击打开文件' + (Number(message.targetLine) > 1 ? '（跳到读取起始行）' : '');
                    primary.addEventListener('click', (e) => {
                        e.stopPropagation(); // 别冒泡到卡头的折叠 toggle
                        openTargets([{path: target, line: Number(message.targetLine) || 1, column: 0}]);
                    });
                }
            }
            head.appendChild(primary);
        }
        if (info.range) {
            // read_file 按行读取的行范围徽标：一眼看出这次读的是哪段，不是整个文件
            const range = document.createElement('span');
            range.className = 'ai-tool-tag';
            range.textContent = '行 ' + info.range;
            range.dataset.tip = '按行读取：第 ' + info.range.replace('–', ' 到 ') + ' 行';
            head.appendChild(range);
        }
        if (isBuiltinSkill) {
            // 内置技能卡没有正文（内容只进模型上下文），徽标替代原来的 hover 说明
            const tag = document.createElement('span');
            tag.className = 'ai-tool-tag';
            tag.textContent = '内置';
            head.appendChild(tag);
        }
        if (message.name === 'submit_plan' && openPlan) {
            // 计划的对话区唯一入口：点开虚拟只读预览（未批准）或 .cadt/plan/ 文件（已批准）
            const view = document.createElement('button');
            view.type = 'button';
            view.className = 'ai-tool-plan-open';
            view.textContent = '查看计划';
            view.dataset.tip = '在标签页查看这份计划（未批准为只读预览，批准后是工作区文件）';
            view.addEventListener('click', (e) => {
                e.stopPropagation(); // 别冒泡到卡头的折叠 toggle
                openPlan(session || currentSession());
            });
            head.appendChild(view);
        }
        if (info.dir) {
            const dir = document.createElement('span');
            dir.className = 'ai-tool-dir';
            dir.textContent = info.dir;
            dir.dataset.tip = info.dir;
            head.appendChild(dir);
        }
        if (approval && toolFileVerb(message) && message.name !== 'read_file' && (approval.added || approval.removed)) {
            const add = document.createElement('span');
            add.className = 'ai-tool-stat add';
            add.textContent = '+' + approval.added;
            const del = document.createElement('span');
            del.className = 'ai-tool-stat del';
            del.textContent = '−' + approval.removed;
            head.append(add, del);
        } else if (message.name === 'edit_file' && live) {
            // 执行中（审批/落盘前）approval 还没挂：edit_file 参数此时已完整，
            // oldString → newString 直接精确算 ±，不必等审批走完（键名是 camelCase）
            try {
                const input = parseJson(message.arguments, {});
                if (typeof input.oldString === 'string' && typeof input.newString === 'string') {
                    const ops = ctx.computeLineDiff(input.oldString, input.newString);
                    let added = 0;
                    let removed = 0;
                    for (const op of ops) {
                        if (op.t === '+') added++;
                        else if (op.t === '-') removed++;
                    }
                    if (added || removed) {
                        const add = document.createElement('span');
                        add.className = 'ai-tool-stat add';
                        add.textContent = '+' + added;
                        const del = document.createElement('span');
                        del.className = 'ai-tool-stat del';
                        del.textContent = '−' + removed;
                        head.append(add, del);
                    }
                }
            } catch (e) {}
        }
        // 命令耗时徽标（run_command 完成后 Go 回传的 durationMs 暂存在消息上）：
        // 贴右侧状态字左边（.duration 的 auto margin 吃掉中间空隙，状态字让位成固定间距）。
        const durationText = formatCommandDuration(message.durationMs);
        if (durationText) {
            const dur = document.createElement('span');
            dur.className = 'ai-tool-stat duration';
            dur.textContent = durationText;
            head.appendChild(dur);
        }
        const state = document.createElement('span');
        state.className = 'ai-tool-state';
        state.textContent = toolStateText(message);
        head.append(state);
        if ((!isRead || isReadLines) && !isBuiltinSkill) {
            head.addEventListener('click', () => {
                if (statusOnlyBody) return; // 无正文可展开，别把它当折叠开关
                card.dataset.userToggled = '1';
                card.classList.toggle('collapsed');
                if (message.toolCallId) toolFoldState.set(message.toolCallId, card.classList.contains('collapsed'));
            });
        }
        const body = document.createElement('div');
        body.className = 'ai-tool-body';
        if (message.name === 'spawn_agent' && message.agent) {
            // 子代理卡片：任务 + 轮次用时 + 实时转录（内存态）/ 最终摘要
            const agent = message.agent;
            const task = document.createElement('div');
            task.className = 'ai-agent-task';
            task.textContent = agent.task || '';
            body.appendChild(task);
            // 后台派单：结束时机独立于主回合，卡片上明确「不阻塞、完成才通知」
            if (agent.state === 'running' && agent.mode === 'background') {
                const tip = document.createElement('div');
                tip.className = 'ai-agent-bg-tip';
                tip.textContent = '后台运行中 · 完成后会自动通知主代理，期间主代理继续其他工作';
                body.appendChild(tip);
            }
            const transcript = subAgentTranscripts.get(agent.key || message.toolCallId);
            if (transcript && transcript.length) {
                const list = document.createElement('div');
                list.className = 'ai-agent-transcript';
                for (const entry of transcript.slice(-40)) {
                    const item = document.createElement('div');
                    item.className = 'ai-agent-entry ' + entry.role;
                    const tag = document.createElement('span');
                    tag.className = 'ai-agent-entry-tag';
                    tag.textContent = entry.role === 'tool' ? (entry.name || '工具') : '子代理';
                    const text = document.createElement('span');
                    text.className = 'ai-agent-entry-text';
                    text.textContent = entry.text || '';
                    item.append(tag, text);
                    list.appendChild(item);
                }
                body.appendChild(list);
            } else if (agent.state !== 'running') {
                const archived = document.createElement('div');
                archived.className = 'ai-agent-archived';
                archived.textContent = '子对话已归档（不随会话持久化）';
                body.appendChild(archived);
            }
            if (agent.state !== 'running' && agent.summary) {
                const meta = document.createElement('div');
                meta.className = 'ai-agent-meta';
                meta.textContent = (agent.depth >= 1 ? agentLevelText(agent.depth) + ' · ' : '') +
                    '轮次 ' + (agent.rounds || 0) + ' · 用时 ' + Math.round((agent.ms || 0) / 1000) + 's' +
                    (agent.tokens ? ' · ' + agent.tokens + ' tokens' : '') +
                    (agent.state === 'error' ? ' · 失败' : (agent.state === 'stopped' ? ' · 已停止' : ''));
                const summary = document.createElement('div');
                summary.className = 'ai-agent-summary';
                summary.textContent = agent.summary;
                body.append(meta, summary);
            }
        } else if (approval) {
            body.classList.add('ai-tool-approval-body');
            // 已执行的写文件/编辑：头部已带路径与 diff 统计，正文只渲染 diff 视图
            renderApprovalBody(body, message, approval, {skipMeta: message.name === 'write_file' || message.name === 'edit_file'});
        } else if (envAsk) {
            body.classList.add('ai-tool-approval-body');
            renderEnvAskBody(body, message, envAsk);
        } else if (isCommand) {
            // $ 命令块（长命令折叠「展开命令」）+ 输出
            let command = '';
            try {
                command = aiTextOf(parseJson(message.arguments, {}).command).trim();
            } catch (e) {}
            if (command) {
                const cmdLine = document.createElement('div');
                cmdLine.className = 'ai-cmd-line';
                const dollar = document.createElement('span');
                dollar.className = 'ai-cmd-dollar';
                dollar.textContent = '$';
                const cmdText = document.createElement('span');
                cmdText.className = 'ai-cmd-text';
                cmdText.textContent = command;
                cmdText.dataset.tip = command;
                cmdLine.append(dollar, cmdText);
                if (command.length > 120 || /\n/.test(command)) {
                    cmdLine.classList.add('clamped');
                    const more = document.createElement('button');
                    more.type = 'button';
                    more.className = 'ai-cmd-more';
                    more.textContent = '展开命令';
                    more.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const clamped = cmdLine.classList.toggle('clamped');
                        more.textContent = clamped ? '展开命令' : '收起命令';
                    });
                    body.append(cmdLine, more);
                } else {
                    body.appendChild(cmdLine);
                }
            }
            const output = document.createElement('div');
            output.className = 'ai-cmd-output';
            output.textContent = message.content || (live ? '执行中…' : '（无输出）');
            body.appendChild(output);
            // 后台命令：命令下方实时追加输出（cmd-out 广播驱动；重新渲染时从 bgLog 恢复）
            if (message.name === 'background_command') {
                const live = document.createElement('div');
                live.className = 'ai-cmd-output ai-bg-live';
                live.textContent = message.bgLog || '（等待输出…）';
                body.appendChild(live);
            }
        } else if (message.gen) {
            // 生成任务卡（generate_image / generate_video）：提示词块 + 进度行 + 停止钮 + 参考图行 + 产物缩略图条
            // 头部主参数只有 60 字摘要，完整提示词放展开正文（长文折叠，同命令卡模式）
            let genPrompt = '';
            try {
                genPrompt = aiTextOf(parseJson(message.arguments, {}).prompt).trim();
            } catch (e) {}
            if (genPrompt) {
                const promptLine = document.createElement('div');
                promptLine.className = 'ai-cmd-line ai-gen-prompt';
                const promptText = document.createElement('span');
                promptText.className = 'ai-cmd-text';
                promptText.textContent = genPrompt;
                promptLine.appendChild(promptText);
                if (genPrompt.length > 120 || /\n/.test(genPrompt)) {
                    promptLine.classList.add('clamped');
                    const more = document.createElement('button');
                    more.type = 'button';
                    more.className = 'ai-cmd-more';
                    more.textContent = '展开提示词';
                    more.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const clamped = promptLine.classList.toggle('clamped');
                        more.textContent = clamped ? '展开提示词' : '收起提示词';
                    });
                    body.append(promptLine, more);
                } else {
                    body.appendChild(promptLine);
                }
            }
            const gen = message.gen;
            const statusLine = document.createElement('div');
            statusLine.className = 'ai-gen-status' + (gen.status === 'running' ? ' running' : '') + (gen.status === 'failed' ? ' failed' : '');
            if (gen.status === 'running') statusLine.textContent = '生成中 · ' + (gen.progressText || '…');
            else if (gen.status === 'failed') statusLine.textContent = '失败 · ' + (gen.error || '未知原因');
            else if (gen.status === 'stopped') statusLine.textContent = '已停止';
            else statusLine.textContent = '已完成';
            body.appendChild(statusLine);
            if (gen.status === 'running' && typeof ctx.genStopJob === 'function' && gen.jobId) {
                const stopBtn = document.createElement('button');
                stopBtn.type = 'button';
                stopBtn.className = 'dlg-btn ai-gen-stop';
                stopBtn.textContent = '停止生成';
                stopBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (ctx.genStopJob(gen.jobId)) flash('已停止生成任务');
                });
                body.appendChild(stopBtn);
            }
            // 参考图行（图生图）：本地图按路径现读缩略图（快照里只存路径，不存 Data URL），
            // 远程 URL 只显示地址不代拉取——卡片重绘不该产生额外网络请求。
            const genRefs = gen.references || [];
            if (genRefs.length) {
                const refRow = document.createElement('div');
                refRow.className = 'ai-gen-refs';
                const refLabel = document.createElement('div');
                refLabel.className = 'ai-gen-refs-label';
                refLabel.textContent = '参考图 · ' + genRefs.length + ' 张';
                refRow.appendChild(refLabel);
                const refStrip = document.createElement('div');
                refStrip.className = 'ai-gen-thumbs';
                for (const ref of genRefs) {
                    if (/^https?:\/\//i.test(ref)) {
                        const chip = document.createElement('div');
                        chip.className = 'ai-gen-ref-url';
                        chip.textContent = ref;
                        chip.title = ref;
                        refStrip.appendChild(chip);
                        continue;
                    }
                    const thumb = document.createElement('button');
                    thumb.type = 'button';
                    thumb.className = 'ai-gen-thumb ai-gen-ref-thumb';
                    thumb.title = ref;
                    const img = document.createElement('img');
                    img.alt = '参考图';
                    img.loading = 'lazy';
                    thumb.appendChild(img);
                    const refName = document.createElement('span');
                    refName.className = 'ai-gen-thumb-name';
                    refName.textContent = ref.split(/[\\/]/).pop();
                    thumb.appendChild(refName);
                    thumb.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (typeof ctx.openTargets === 'function') ctx.openTargets([{path: ref, line: 1, column: 0}]);
                    });
                    refStrip.appendChild(thumb);
                    Promise.resolve(backend.ReadImageAsDataURL(ref))
                        .then((dataURL) => { img.src = dataURL || ''; })
                        .catch(() => {});
                }
                refRow.appendChild(refStrip);
                body.appendChild(refRow);
            }
            const imageFiles = (gen.files || []).filter((file) => file.mime && file.mime.startsWith('image/'));
            if (imageFiles.length) {
                const strip = document.createElement('div');
                strip.className = 'ai-gen-thumbs';
                for (const file of imageFiles) {
                    const thumb = document.createElement('button');
                    thumb.type = 'button';
                    thumb.className = 'ai-gen-thumb';
                    const img = document.createElement('img');
                    img.alt = '生成图';
                    img.loading = 'lazy';
                    thumb.append(img);
                    const fileName = document.createElement('span');
                    fileName.className = 'ai-gen-thumb-name';
                    fileName.textContent = file.path.split(/[\\/]/).pop();
                    thumb.appendChild(fileName);
                    thumb.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (typeof ctx.openTargets === 'function') ctx.openTargets([{path: file.path, line: 1, column: 0}]);
                    });
                    strip.appendChild(thumb);
                    // data URL 异步加载（ReadImageAsDataURL 32MB 上限内）；失败保持空占位框，路径可点击排查
                    Promise.resolve(backend.ReadImageAsDataURL(file.path))
                        .then((dataURL) => {
                            img.src = dataURL || '';
                        })
                        .catch(() => {}); // 缩略图加载失败属尽力而为路径：空框 + 路径标签仍可点开排查
                }
                body.appendChild(strip);
            } else if ((gen.files || []).length) {
                const paths = document.createElement('div');
                paths.className = 'ai-gen-files';
                paths.textContent = gen.files.map((file) => file.path + '（' + file.mime + '，' + file.bytes + ' 字节）').join('\n');
                body.appendChild(paths);
            }
        } else if (isBuiltinSkill) {
            // 内置技能卡：内容只注入模型上下文，不向用户展示（无 body，卡片头即全部）
        } else if (isRead) {
            // 字符模式读取卡不做展开：内容不渲染，路径超链接即全部交互。
            // 按行读取卡：正文显示带行号的内容片段（去掉 head 那两行「文件：…」元信息），
            // 让用户直接核对 AI 读了哪几行；默认折叠，点箭头展开。
            if (isReadLines) {
                const raw = String(message.content == null ? '' : message.content);
                const nl = raw.indexOf('\n\n');
                const bodyText = nl >= 0 ? raw.slice(nl + 2) : raw;
                // 行号 + tab + 代码，结构与 .ai-diff 同款：每行拆成行号列 + 代码列，
                // 让读取片段和 edit_file 的 diff 待在同一个「背景框」里（视觉语义统一）。
                renderReadLinesInto(body, bodyText);
                statusOnlyBody = !bodyText.trim();
            }
        } else {
            const inlineText = String(message.content == null ? '' : message.content);
            // 只剩状态占位（执行中 / 无输出）就不是「可展开的正文」：不建 body、不摆箭头。
            // 等它真出内容时（如 wait_agent 返回结算）下一次渲染会带上 body 与箭头。
            statusOnlyBody = !inlineText.trim();
            body.textContent = inlineText || (live ? '执行中…' : '（无输出）');
        }
        if ((isRead && !isReadLines) || isBuiltinSkill || statusOnlyBody) card.appendChild(head);
        else card.append(head, body);
        if ((approval && approval.state === 'pending') || (envAsk && envAsk.state === 'pending')) return;
        // 终端命令默认只显示一行摘要（命令 + 状态），点击展开完整输出。
        if (isCommand) {
            card.classList.add('collapsed');
        }
        // 文件写入/编辑卡全程折叠（running 也不展开）：running 展开显示「执行中…」body、
        // 完成瞬间折起——卡高度突变把消息区与旁边布局顶得一跳（用户看到的就是这个闪，
        // 不是 spinner）。error 仍默认展开便于看失败原因；状态在头部徽标上始终可见。
        const fileToolCard = message.name === 'write_file' || message.name === 'edit_file';
        if (fileToolCard) {
            card.classList.add('collapsed');
        }
        if ((!isRead || isReadLines) && !isBuiltinSkill && !fileToolCard && !live && message.status !== 'error' && !statusOnlyBody) card.classList.add('collapsed');
        // 生成卡：进行中或已有产物时不默认折叠（缩略图是主要反馈）；用户手动折叠过的仍以其偏好为准
        if (message.gen && (message.gen.status === 'running' || (message.gen.files || []).length)) {
            card.classList.remove('collapsed');
        }
        // 用户手动展开/收起过的卡片以偏好为准，覆盖上面的默认折叠规则。
        if ((!isRead || isReadLines) && !isBuiltinSkill && !statusOnlyBody && message.toolCallId) {
            const storedFold = toolFoldState.get(message.toolCallId);
            if (storedFold !== undefined) card.classList.toggle('collapsed', storedFold);
        }
        if (statusOnlyBody) chev.remove(); // 无正文：折叠箭头不出现（与读取卡同一口径）
    }

// ===== 回答正文与代码块增强 =====
    // AI 正文的完整增强链：代码块复制钮 + 本地图片解析 + 可视化卡片（mermaid / echarts / svg /
    // html / 关系图 / 词云）。主消息区与子代理详情标签页共用同一条——少走一步，围栏就只剩
    // 一块源码占位（子代理视图历史遗留问题）。必须在 innerHTML 写入之后调用。
    function enhanceAnswerBody(root, opts) {
        if (!root) return 0;
        const streaming = !!(opts && opts.streaming);
        enhanceAICodeBlocks(root);
        resolveAIImages(root);
        return enhanceWidgets(root, {
            streaming,
            copyText,
            openExternal,
            saveAs: saveWidgetAs,
            resolveImages: resolveAIImages,
            openFullscreen: openWidgetFullscreen,
        });
    }

    // 围栏语言：markdown.js 把 info 语言写成 code 的 language-<lang> 类；代码块没有围栏信息时为空。
    function codeBlockLanguage(block) {
        const code = block.querySelector('code');
        const cls = (code && code.className ? code.className : '') + ' ' + (block.className || '');
        const m = cls.match(/language-([A-Za-z0-9_+.#-]+)/);
        return m ? m[1].toLowerCase() : '';
    }

    // 代码块卡片：顶部信息条（左语言 / 右复制图标）+ 下方代码区。
    // 结构必须保持「条 + 体」两层——条高固定、体负责横向滚动，滚动条只在代码区出现。
    // opts.noBar：只留代码区，不建顶部条。思考链这类弱化区域里，「js + 复制」工具栏比代码
    // 本身还跳；代码高亮与边框照旧，只是不摆那条操作栏。主回答区/子代理详情仍走默认带条分支。
    function enhanceAICodeBlocks(root, opts) {
        if (!root) return;
        const noBar = !!(opts && opts.noBar);
        const blocks = [];
        root.querySelectorAll('.md-code-frame').forEach((frame) => blocks.push(frame));
        root.querySelectorAll('pre').forEach((pre) => {
            // 可视化卡片的源码面板自带复制按钮，不再包一层代码卡片
            if (!pre.closest('.md-code-frame') && !pre.closest('.ai-widget')) blocks.push(pre);
        });
        for (const block of blocks) {
            // 增量渲染可能对同一批节点重复走增强链，已包过的不再包第二层
            if (block.parentNode && block.parentNode.classList.contains('ai-code-body')) continue;
            const code = block.querySelector('code') || block;
            const card = document.createElement('div');
            card.className = 'ai-code-card' + (noBar ? ' no-bar' : '');
            if (!noBar) {
                const bar = document.createElement('div');
                bar.className = 'ai-code-bar';
                const lang = document.createElement('span');
                lang.className = 'ai-code-lang';
                lang.textContent = codeBlockLanguage(block) || '文本';
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'ai-code-copy';
                button.dataset.tip = '复制代码';
                button.setAttribute('aria-label', '复制代码');
                button.innerHTML = iconSvg('copy', 13);
                button.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    Promise.resolve(copyText(code.textContent || '', '代码')).then((ok) => {
                        if (ok === false || button.dataset.copied) return;
                        // 图标按钮没有文字反馈，短暂换成勾号（1s 后由重渲染或定时器复原）
                        button.dataset.copied = '1';
                        button.innerHTML = iconSvg('check', 13);
                        setTimeout(() => {
                            if (!button.isConnected) return;
                            delete button.dataset.copied;
                            button.innerHTML = iconSvg('copy', 13);
                        }, 1000);
                    }).catch(() => {});
                });
                bar.append(lang, button);
                card.appendChild(bar);
            }
            const body = document.createElement('div');
            body.className = 'ai-code-body';
            block.parentNode.insertBefore(card, block);
            body.appendChild(block);
            card.appendChild(body);
        }
    }

    // 流式 ± 行数：write_file 用 content-so-far 对磁盘旧文本（基线每条调用异步取一次）diff；
    // edit_file 用 new_string-so-far 对已接收完整的 old_string diff——流式期间数字会随接收
    // 收敛到真实 ±（old 未到齐时不算）。每帧重算（computeLineDiff 自带上限兜底），
    // 进度没长 ≥256B 就复用上次结果，避免大内容每 80ms 跑一次 LCS。键 = 工具调用序号。
    const liveBaseTexts = new Map();
    const liveStatsCache = new Map();
    let liveTurnMessage = null; // 换轮即清缓存：调用序号跨轮复用，基线不能串轮
// ===== 实时行与差异统计 =====
    function liveDiffStats(key, name, parts) {
        let baseText = null;
        let progress = -1;
        if (name === 'write_file') {
            if (parts.content === null || !parts.path) return null;
            let base = liveBaseTexts.get(key);
            if (base === undefined) {
                liveBaseTexts.set(key, null); // pending 标记：基线还没读到
                const fetch = ctx.readOptionalText
                    ? ctx.readOptionalText(parts.path)
                    : Promise.resolve({exists: false, text: ''});
                fetch.then((r) => liveBaseTexts.set(key, {exists: !!r.exists, text: r.text || ''}))
                    .catch(() => liveBaseTexts.set(key, {exists: false, text: ''}));
                return null;
            }
            if (base === null) return null;
            baseText = base.exists ? base.text : '';
            progress = parts.content.length;
        } else if (name === 'edit_file') {
            // old_string 带闭合引号匹配才算接收完整；new_string 未闭合匹配到多少算多少
            if (parts.oldString === null || parts.newString === null) return null;
            baseText = parts.oldString;
            progress = parts.newString.length;
        } else {
            return null;
        }
        const cached = liveStatsCache.get(key);
        if (cached && cached.len <= progress && progress - cached.len < 256) return cached;
        const ops = ctx.computeLineDiff(baseText, name === 'write_file' ? parts.content : parts.newString);
        let added = 0;
        let removed = 0;
        for (const op of ops) {
            if (op.t === '+') added++;
            else if (op.t === '-') removed++;
        }
        const stats = {len: progress, added, removed};
        liveStatsCache.set(key, stats);
        return stats;
    }

    // 流式占位行：与真实工具卡头部同款结构（加载图标 / 动词 / 文件图标 / 文件名 / 目录 / ±统计 / 右侧状态），
    // 整轮结束后由真实工具卡接替。行按调用 key 复用（updateLiveTools 原位更新文本），
    // 避免每个流帧整行重建导致 spinner 动画重启 / hover 丢失的疯狂闪烁。
    // 注意：不只是「重建」，把已有节点 appendChild 回同一父节点同一位置同样会重启动画，
    // 所以顺序不变时一个 DOM 写都不能做（见 planLiveRowOrder）。
    function buildLiveRow(call, parts, stats, shape, spinReg) {
        const meta = toolMeta(call.name);
        const row = document.createElement('div');
        row.className = 'ai-live-tool';
        row.dataset.liveKey = String(call.key);
        row.dataset.shape = shape;
        const spinner = makeToolSpinner(spinReg, String(call.key));
        const icon = document.createElement('span');
        icon.className = 'ai-tool-icon';
        icon.innerHTML = iconSvg(meta.icon || 'gear', 13);
        const verb = document.createElement('span');
        verb.className = 'ai-tool-verb';
        verb.textContent = meta.verb || call.name;
        row.append(spinner, icon, verb);
        if (parts.path) {
            if (parts.name) {
                row.appendChild(createFileIcon(parts.name, 'ai-tool-fileicon'));
                row.dataset.liveName = parts.name;
            }
            const primary = document.createElement('span');
            primary.className = 'ai-tool-primary';
            primary.textContent = parts.name || parts.path;
            primary.dataset.tip = parts.path;
            row.appendChild(primary);
            if (parts.dir) {
                const dir = document.createElement('span');
                dir.className = 'ai-tool-dir';
                dir.textContent = parts.dir;
                dir.dataset.tip = parts.dir;
                row.appendChild(dir);
            }
            if (stats) {
                const add = document.createElement('span');
                add.className = 'ai-tool-stat add';
                add.textContent = '+' + stats.added;
                const del = document.createElement('span');
                del.className = 'ai-tool-stat del';
                del.textContent = '−' + stats.removed;
                row.append(add, del);
            }
        }
        const state = document.createElement('span');
        state.className = 'ai-tool-state';
        state.textContent = liveToolStateText(parts);
        row.appendChild(state);
        return row;
    }

    function setTextIfChanged(el, text) {
        if (el && el.textContent !== text) el.textContent = text;
    }

    // 原位更新一行：结构形态（有无 path / 有无 ±统计）变了才整行重建，其余只改文本。
    // 文件图标只在文件名变化时重建：createFileIcon 的 scopeSvgIds 每次生成唯一 id，
    // 用 fresh.innerHTML 跟旧值比较会永远不等，等于每个流帧都重写图标 DOM。
    function updateLiveRow(row, call, parts, stats) {
        const meta = toolMeta(call.name);
        setTextIfChanged(row.querySelector('.ai-tool-verb'), meta.verb || call.name);
        if (parts.path) {
            const name = parts.name || parts.path;
            const fileIcon = row.querySelector('.ai-tool-fileicon');
            if (fileIcon && row.dataset.liveName !== name) {
                const fresh = createFileIcon(name, 'ai-tool-fileicon');
                fileIcon.className = fresh.className;
                fileIcon.innerHTML = fresh.innerHTML;
            }
            if (row.dataset.liveName !== name) row.dataset.liveName = name;
            const primary = row.querySelector('.ai-tool-primary');
            setTextIfChanged(primary, parts.name || parts.path);
            if (primary) primary.dataset.tip = parts.path;
            const dir = row.querySelector('.ai-tool-dir');
            setTextIfChanged(dir, parts.dir);
            if (dir) dir.dataset.tip = parts.dir;
            if (stats) {
                setTextIfChanged(row.querySelector('.ai-tool-stat.add'), '+' + stats.added);
                setTextIfChanged(row.querySelector('.ai-tool-stat.del'), '−' + stats.removed);
            }
        }
        setTextIfChanged(row.querySelector('.ai-tool-state'), liveToolStateText(parts));
    }

// ===== 助手元素实时更新 =====
    // 占位区增量更新：按 key 复用行、按 live 顺序就位、消失的行移除；
    // 形态（path 是否已收到 / ±统计是否可算）变化才重建那一行。
    function updateLiveTools(box, live, message) {
        const existing = new Map();
        for (const row of [...box.querySelectorAll('.ai-live-tool')]) {
            existing.set(row.dataset.liveKey, row);
        }
        let spinReg = liveSpinStart.get(message);
        if (!spinReg) {
            spinReg = new Map();
            liveSpinStart.set(message, spinReg);
        }
        const seen = new Set();
        const desired = [];
        for (const call of live) {
            const key = String(call.key);
            seen.add(key);
            const parts = liveToolParts(call.arguments);
            const stats = liveDiffStats(call.key, call.name, parts);
            const shape = (parts.path ? 'p' : '-') + (stats ? 's' : '-');
            let row = existing.get(key);
            if (row && row.dataset.shape !== shape) {
                row.remove();
                row = null;
            }
            if (!row) {
                row = buildLiveRow(call, parts, stats, shape, spinReg);
            } else {
                updateLiveRow(row, call, parts, stats);
            }
            desired.push(row);
        }
        for (const [key, row] of existing) {
            if (!seen.has(key)) row.remove();
        }
        // 顺序对齐：顺序不变时 moves 为空 → 零 DOM 写，spinner 动画不会每 80ms 重启。
        // 旧实现无条件 box.appendChild(row)「移动」既有节点，实测会把 ::before 动画归零。
        const plan = planLiveRowOrder(Array.from(box.children), desired);
        for (const i of plan.moves) {
            const row = desired[i];
            row.remove();
            box.insertBefore(row, box.children[i] || null);
        }
        for (let n = 0; n < plan.trim; n++) {
            const last = box.lastElementChild;
            if (last) last.remove();
        }
    }

    function updateAssistantElement(wrap, message, streaming, options) {
        if (!wrap) return;
        const hideThinking = !!(options && options.hideThinking);
        const expandThinking = !!(options && options.expandThinking);
        wrap.classList.toggle('streaming', !!streaming);
        if (!streaming) wrap.classList.remove('actions-visible');
        const meta = wrap.querySelector('.ai-msg-meta');
        if (meta) {
            // 流式每帧都会走到这里；名字 / 模型 / 时间没变就别清空重建整行
            // （同类「无谓 DOM 重建」，会丢 hover 与选区）。
            const metaSig = [assistantName(), message.model || '', aiFormatTime(message.ts)].join('\u0001');
            if (meta.dataset.renderSig !== metaSig) {
                meta.innerHTML = '';
                const who = document.createElement('span');
                who.textContent = assistantName();
                const model = document.createElement('span');
                model.className = 'ai-model';
                model.textContent = message.model || '';
                const time = document.createElement('span');
                time.textContent = aiFormatTime(message.ts);
                meta.append(who);
                if (model.textContent) meta.appendChild(model);
                meta.appendChild(time);
                meta.dataset.renderSig = metaSig;
            }
        }

        // 占位条件：有思考内容照常显示；流式中还没内容时显示「等待模型响应」占位（限流
        // 重试 / 排队期间不该谎报「正在思考」）；正文一旦开始流式（不思考的模型）就撤掉，
        // 与轮结束时的移除条件（无 reasoning 即移除）保持同一口径，避免收尾时跳变。
        let think = wrap.querySelector('.ai-think');
        if (settings.aiShowThinking !== false && !hideThinking &&
            (message.reasoning || (streaming && !message.content))) {
            const thinkKey = aiThinkKey(message, Number(wrap.dataset.aiIdx));
            if (!think) {
                think = document.createElement('div');
                think.className = 'ai-think';
                think.dataset.thinkKey = thinkKey;
                const head = document.createElement('button');
                head.type = 'button';
                head.className = 'ai-think-head';
                const chev = document.createElement('span');
                chev.className = 'ai-think-chev';
                chev.innerHTML = iconSvg('chevron-down');
                const label = document.createElement('span');
                label.className = 'ai-think-label';
                head.append(chev, label);
                head.addEventListener('click', () => toggleThink(think));
                const body = document.createElement('div');
                body.className = 'ai-think-body';
                think.append(head, body);
                wrap.insertBefore(think, wrap.querySelector('.ai-bubble'));
            }
            think.dataset.thinkKey = thinkKey;
            think.classList.toggle('thinking', !!streaming);
            const label = think.querySelector('.ai-think-label');
            if (label) {
                label.textContent = aiThinkLabel(message, !!streaming);
                const guardState = message.guard && message.guard.state;
                label.classList.toggle('ai-think-guard',
                    guardState === 'warned' || guardState === 'pending' ||
                    guardState === 'continued' || guardState === 'stopped');
            }
            renderThinkBody(think.querySelector('.ai-think-body'), message, !!streaming);
            const storedThink = thinkFoldState.get(thinkKey);
            if (storedThink !== undefined) think.classList.toggle('collapsed', storedThink);
            else think.classList.toggle('collapsed',
                answerThinkingDefaultCollapsed(!!streaming, expandThinking, settings.aiAlwaysCollapse === true));
            // 思考卡头部不给 tooltip：标签 + 箭头已经把「点一下展开 / 收起点思考」说清楚了
        } else if (think) {
            think.remove();
        }

        // 只找正文容器的 markdown 区：think body 也带 ai-md class 且在 DOM 序上先于 bubble，
        // 裸查 '.ai-md' 会命中它——content 为空时 textContent='' 会清掉刚渲染好的思考内容。
        const md = wrap.querySelector('.ai-bubble .ai-md');
        if (md) {
            md.classList.toggle('error-text', message.status === 'error' && !message.content);
            // 内容签名：流式只追加，长度 + 末尾片段即可识别变化；签名带 streaming，
            // 保证轮结束（false）时重渲染一次，把可视化占位换成真实卡片。
            // 工具参数接收帧里 content 往往不变，跳过整块 innerHTML 重写可避免
            // 打字点 / 代码块复制钮 / 图片 / widget 每 80ms 重建一次。
            const content = message.content || '';
            const mdSig = (content
                ? (streaming ? 's' : 'd') + content.length + ':' + content.slice(-64)
                : (message.status === 'error' && !content ? 'e:' + (message.error || '') :
                    (streaming ? 't' : (message.status === 'stopped' ? 'stop' : 'empty'))));
            if (md.dataset.renderSig !== mdSig) {
                md.dataset.renderSig = mdSig;
                if (message.status === 'error' && !content) {
                    md.textContent = message.error ? ('请求失败：' + message.error) : '请求失败';
                } else if (content) {
                    // 流式期间整段重建会销毁可视化占位 → CSS loading 动画时钟归零（上方
                    // 思考链 / 工具卡每帧更新时「正在生成可视化…」永远停在前几帧，看着一直闪）。
                    // 占位先按文档顺序摘出，写完移植回同序槽位，复用同一节点让动画连续。
                    // 轮结束（streaming=false）不移植：让带最终源码的新占位留下供 mountCard 渲染，
                    // 复用旧节点会拿到半截源码、画出半张图。
                    const parked = parkPendingWidgets(md);
                    md.innerHTML = renderMarkdown(content);
                    enhanceAICodeBlocks(md);
                    resolveAIImages(md);
                    if (enhanceAIFileRefs) enhanceAIFileRefs(md);
                    if (streaming) restoreParkedWidgets(parked, md);
                    // 重建/重新插入会重置 widget loading 的 CSS 动画对象，按消息起点补负 delay 相位，
                    // 让扫光 / 转环 / 呼吸接着走而不是每帧回弹（用户 2026-11-27 反馈「转一点又被重置」）。
                    if (streaming) syncWidgetLoadingPhase(md, message);
                    // svg / html / mermaid / echarts 围栏 → 可视化卡片；流式期间只占位，整轮结束后再挂载
                    enhanceWidgets(md, {
                        streaming: !!streaming,
                        copyText,
                        openExternal,
                        saveAs: saveWidgetAs,
                        resolveImages: resolveAIImages,
                        openFullscreen: openWidgetFullscreen,
                    });
                } else if (streaming) {
                    md.innerHTML = '<div class="ai-typing"><span></span><span></span><span></span></div>';
                } else if (message.status === 'stopped') {
                    md.textContent = '（已停止生成）';
                } else {
                    md.textContent = '';
                }
            }
            // 错误条：只在文本变化时改，别每帧删了又建
            let errorBox = wrap.querySelector('.ai-error-box');
            if (message.status === 'error' && message.error && content) {
                if (!errorBox) {
                    errorBox = document.createElement('div');
                    errorBox.className = 'ai-error-box';
                    wrap.querySelector('.ai-bubble').appendChild(errorBox);
                }
                setTextIfChanged(errorBox, message.error);
            } else if (errorBox) {
                errorBox.remove();
            }
            // 截断提示条：打满输出预算（length）或上游没给结束原因且正文悬空（suspect）时，
            // 在回复末尾给一条「继续」出口——否则用户只看到话说到一半，分不清是模型没写完
            // 还是软件断了（2026-11-21 那次「莫名其妙停下来」）。只在收尾后显示。
            let truncBox = wrap.querySelector('.ai-truncated-box');
            const truncKind = !streaming && message.truncated ? String(message.truncated) : '';
            if (truncKind && content) {
                const viewing = typeof currentSession === 'function' ? currentSession() : null;
                const owner = options && options.session;
                const sameSession = !!(viewing && owner && viewing.id === owner.id);
                const signature = truncKind + '|' + (sameSession ? 'live' : 'read');
                if (!truncBox) {
                    truncBox = document.createElement('div');
                    truncBox.className = 'ai-truncated-box';
                    wrap.querySelector('.ai-bubble').appendChild(truncBox);
                }
                if (truncBox.dataset.signature !== signature) {
                    truncBox.dataset.signature = signature;
                    truncBox.textContent = truncatedNotice(truncKind);
                    if (sameSession && typeof submitText === 'function') {
                        const cont = document.createElement('button');
                        cont.type = 'button';
                        cont.className = 'ai-truncated-continue';
                        cont.textContent = '继续';
                        cont.dataset.tip = '让 AI 从断点接着写，不重复已输出的内容';
                        cont.addEventListener('click', async () => {
                            cont.disabled = true;
                            const ok = await submitText(CONTINUATION_PROMPT, null, {preserveScroll: true});
                            if (ok) {
                                truncBox.remove();
                            } else {
                                cont.disabled = false;
                                flash('「继续」没有发出，请手动发言', true);
                            }
                        });
                        truncBox.appendChild(cont);
                    }
                }
            } else if (truncBox) {
                truncBox.remove();
            }
        }
        // 流式工具调用占位：name 已到、参数还在增量接收时先亮卡（写大文件不再像卡住），
        // 整轮结束后由真实工具卡接替（非流式渲染时移除残留占位）
        const bubble = wrap.querySelector('.ai-bubble');
        if (bubble) {
            // 非流式渲染（轮结束 / 历史回放）才清残留占位；流式期间绝不能每帧删——
            // 占位区被删后 updateLiveTools 面对空盒子全量重建行，spinner 动画每帧重启（闪烁回归）
            if (!streaming) {
                const staleLive = bubble.querySelector('.ai-live-tools');
                if (staleLive) staleLive.remove();
            }
            const live = (streaming && options && Array.isArray(options.liveTools)) ? options.liveTools : null;
            let box = bubble.querySelector('.ai-live-tools');
            if (!live || !live.length) {
                if (box) box.remove();
            } else {
                // 换轮清缓存并重建占位区（调用 key 跨轮复用，基线不能串轮）
                if (message !== liveTurnMessage) {
                    liveTurnMessage = message;
                    liveBaseTexts.clear();
                    liveStatsCache.clear();
                    if (box) box.remove();
                    box = null;
                }
                if (!box) {
                    box = document.createElement('div');
                    box.className = 'ai-live-tools';
                    bubble.appendChild(box);
                }
                updateLiveTools(box, live, message);
            }
            // 非流式渲染完成后补渲染 mermaid 占位（AI 回复里的 ```mermaid 围栏，报告 §1.3.3）
            if (!streaming && typeof renderMermaidBlocks === 'function') {
                const mdEl = bubble.querySelector('.ai-md');
                if (mdEl && mdEl.querySelector('.md-mermaid')) {
                    renderMermaidBlocks(mdEl).catch(() => {}); // 渲染失败静默：writing-ui 内部已按块兜底
                }
            }
        }
        wrap.classList.toggle('error', message.status === 'error');

        // 用量不再单独占一行：并进操作行的「用量」徽标（点开是本轮明细）
        // 卡片所属会话（options.session；缺省=面板当前会话）：支线标签页渲染时若不认目标会话，
        // 「最后一条 / 该会话是否在生成」会按面板会话算，操作按钮会出现在错的条目上。
        if (!streaming) appendActions(wrap, message, Number(wrap.dataset.aiIdx), (options && options.session) || currentSession());
    }

// ===== 计划批准 =====
    // grantItems：批准卡勾选的条目（{mode:'family', signature} / {mode:'exact', command}）。
    // 危险 / 复合条目（mode null）不会进勾选集合，这里再兜一层——危险命令永不落会话规则。
    // opts.inWorktree：批准卡「在隔离区中执行」开关——勾选后先建隔离区再执行，批准指令也随之不同。
    async function acceptPlan(session, grantItems, opts) {
        // 注意：ai-panel 的包装层在调用前已落盘并把 activePlan 置为 approved，
        // 所以这里不能再用 status==='pending' 做守卫（否则批准永远静默失败）。
        // 也不做 streamOf 守卫：包装层已 stopGeneration，残余流由 submitText 的排队机制兜底。
        if (!session || !session.activePlan || !session.planMode) return;
        if (currentScopeOf(session) === 'read') {
            flash('当前为「只读访问」，执行阶段无法修改文件', true);
            return;
        }
        // 勾选「在隔离区中执行」时隔离区已由包装层在落盘前建好（见 ai-panel 的 acceptPlan），
        // 这里只负责按勾选生成差异化的批准指令。
        const inWorktree = !!(opts && opts.inWorktree);
        // 命令规则的 cwd 按会话根（批次 B）：它会写进会话命令规则，根错了规则就永远不命中；
        // 会话无根时才回落窗口根。
        const cwd = (scopeRootOf ? scopeRootOf(session) : '') || getScopeRoot() || '';
        if (Array.isArray(grantItems) && cwd) {
            for (const item of grantItems) {
                if (!item || item.dangerous) continue;
                if (item.mode === 'family' && item.signature) {
                    addCommandApprovalRule(session, {mode: 'family', signature: item.signature, cwd});
                } else if (item.mode === 'exact' && item.command) {
                    addCommandApprovalRule(session, {mode: 'exact', command: item.command, cwd});
                }
            }
        }
        session.planMode = false;
        setDismissedPlanApproval('');
        persistSessions();
        updateScopeUI();
        updateComposerTakeover(true);
        renderMessageQueue();
        renderMessages(true);
        // 这条指令是应用代用户按「执行计划」发出的，不是用户手打的——按应用消息卡片展示，
        // 别渲染成用户胶囊（rest 走 detectAppMessage 的同一前缀，历史会话也能认回来）。
        // 勾选隔离区时指令明确告知「隔离区已建好、路径在哪、改动只写隔离区」——否则模型可能
        // 按主根习惯动手，绕过隔离写闸；不勾选时维持原指令（旧会话 detectAppMessage 前缀不变）。
        const ok = await submitText(planApprovalInstruction(inWorktree, session), null, {
            app: {kind: 'plan', label: '计划已批准'},
        });
        if (!ok) {
            session.planMode = true;
            persistSessions();
            updateScopeUI();
            updateComposerTakeover(true);
            renderMessages(true);
        }
    }
    return {
        renderCommandApprovalBody,
        renderApprovalBody,
        renderEnvAskBody,
        renderAskCard,
        renderDiffInto,
        renderToolMessage,
        updateAssistantElement,
        toolMeta,
        acceptPlan,
        askStateLabel,
        askResultText,
        enhanceAICodeBlocks,
        enhanceAnswerBody,
    };
}
