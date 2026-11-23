// ai-slash.js：斜杠命令（/context /compact /clear /help /model /export /memory /schedule /skill /plan /init /patch /diff /worktree）
// 与技能补全：指令固定在前、技能在后分区显示；/技能名 立即发送（只发 skill），/技能名 参数 连原文一起发（生成中由 sendComposerMessage 排队）。
// slashState 由面板与输入区共享（引用稳定、仅属性级读写），经 ctx 注入。
import {AI_COMMANDS, aiClamp} from '../core/ai-constants.js';

// ---------- 纯函数（测试见 frontend/test/ai/ai-slash.test.mjs） ----------

// 指令按前缀过滤（历史口径）；技能名用 includes（/err 也能命中 app-error-log）；均大小写不敏感
export function filterSlashCommands(commands, query) {
    const q = String(query || '').toLowerCase();
    return commands.filter((cmd) => cmd.name.slice(1).toLowerCase().startsWith(q));
}

export function filterSlashSkills(skills, query) {
    const q = String(query || '').toLowerCase();
    return skills.filter((skill) => String(skill.name || '').toLowerCase().includes(q));
}

// 提取「/技能名」之后的参数文本；首 token 与技能名大小写不敏感比对，不匹配返回空串
export function extractSlashArgs(text, skillName) {
    const trimmed = String(text || '').trim();
    const firstToken = trimmed.split(/\s+/)[0] || '';
    if (firstToken.toLowerCase() !== '/' + String(skillName || '').toLowerCase()) return '';
    return trimmed.slice(firstToken.length).trim();
}

// 斜杠技能调用的发送决策（纯函数，可单测）：两种都立即发起一轮，区别只在文案——
// 无参数 → textToSend 为空串，只发 skill（正文随附件 <skill_manual> 注入，空文案由 startSessionTurn 补占位）；
// 带参数 → textToSend 为原文（/技能名 参数），连同 skill 附件一起发。
// 对齐主流 harness（dsh / opencode / cline / codex / pi / ZCode）「选中即作为本轮请求」的语义，
// 不再让用户「继续输入需求 / 等下一轮」。
export function slashSkillInvocation(text, skillName) {
    const args = extractSlashArgs(text, skillName);
    return {args, textToSend: args ? String(text || '').trim() : ''};
}

// 选中项滚动跟随的增量（纯函数，可单测）：row 完全在 box 内返回 0；
// 露在可视区上方返回负增量（贴顶对齐）、露在下方返回正增量（贴底对齐）。
// 口径同 explorer.js 的「nearest」——不用 scrollIntoView，避免连带滚动祖先容器。
export function slashScrollDelta(box, row) {
    if (!box || !row) return 0;
    if (row.top < box.top) return row.top - box.top;
    if (row.bottom > box.bottom) return row.bottom - box.bottom;
    return 0;
}

// 「/技能名」按首 token 精确命中（去掉前导 /，大小写不敏感）；不命中返回 null
export function findSkillBySlashToken(skills, token) {
    const name = String(token || '').trim().replace(/^\/+/, '').toLowerCase();
    if (!name) return null;
    for (const skill of skills || []) {
        if (String((skill && skill.name) || '').toLowerCase() === name) return skill;
    }
    return null;
}

export function createAISlash(ctx) {
    const el = ctx.el;
    const slashState = ctx.slashState;
    const positionOverlays = ctx.positionOverlays;
    const resizeInput = ctx.resizeInput;
    const updateSendState = ctx.updateSendState;
    const contextSummaryText = ctx.contextSummaryText;
    const startCompact = ctx.startCompact;
    const clearCurrentSession = ctx.clearCurrentSession;
    const showNote = ctx.showNote;
    const showModelPicker = ctx.showModelPicker;
    const exportSession = ctx.exportSession;
    const showMemoryDialog = ctx.showMemoryDialog;
    const openSettings = ctx.openSettings;
    // /schedule 走定时任务应用页面标签页（悬浮窗降级回对话框）
    const openSchedulesPage = typeof ctx.openSchedulesPage === 'function' ? ctx.openSchedulesPage : null;
    const attachSkillByName = ctx.attachSkillByName;
    const showSkillsDialog = ctx.showSkillsDialog;
    const handlePlanCommand = ctx.handlePlanCommand;
    const runInitAgentsMd = ctx.runInitAgentsMd;
    const listSkills = ctx.listSkills;
    const skillSourceLabel = ctx.skillSourceLabel;
    const addAttachment = ctx.addAttachment;
    const sendComposerMessage = ctx.sendComposerMessage;

    // 技能列表缓存：面板构造即预热（listSkills 自带 5s 缓存），输入 / 时基本已就位，
    // 补全可以全同步渲染、不闪烁；首载在途时 updateSlash 才走异步补渲染兜底。
    //
    // 缓存必须能过期：早先这里「命中一次就永不刷新」，面板若在打开工作区之前预热
    // （启动时 AI 面板本就是开着的），工作区里的技能（.cadt/skills、.agents/skills）
    // 就被永久漏掉——补全与 /技能名 判未知命令，而 skill_use / /skill / 技能菜单走
    // listSkills(true) 强扫又能加载。TTL 与面板缓存同口径，另给显式 invalidateSkills。
    const SKILLS_TTL_MS = 5000;
    let skillsCache = null;
    let skillsAt = 0;
    let skillsPromise = null;
    let renderSeq = 0;

    // 尽力而为：技能列表读不到就不显示技能区，指令补全不受影响
    function refreshSkills(force) {
        if (skillsPromise) return skillsPromise;
        skillsPromise = Promise.resolve()
            .then(() => listSkills(force === true))
            .then((skills) => { skillsCache = skills; skillsAt = Date.now(); return skills; })
            .catch(() => { skillsCache = skillsCache || []; skillsAt = Date.now(); return skillsCache; })
            .then((skills) => { skillsPromise = null; return skills; });
        return skillsPromise;
    }

    function skillsFresh() {
        return !!skillsCache && Date.now() - skillsAt < SKILLS_TTL_MS;
    }

    function ensureSkills() {
        if (skillsFresh()) return Promise.resolve(skillsCache);
        return refreshSkills(false);
    }

    // 技能管理里新建 / 启停 / 改名后由面板调用：清空缓存立即重扫
    function invalidateSkills() {
        skillsCache = null;
        skillsAt = 0;
        return ensureSkills();
    }

    // ---------- 斜杠命令 ----------

    function hideSlash() {
        slashState.open = false;
        slashState.index = 0;
        slashState.items = [];
        if (el.slash) {
            el.slash.classList.add('hidden');
            el.slash.innerHTML = '';
        }
    }

    function commandEntry(cmd) {
        return {type: 'command', name: cmd.name, desc: cmd.desc};
    }

    function skillEntry(skill) {
        return {
            type: 'skill',
            name: '/' + skill.name,
            desc: (skillSourceLabel(skill.source) || '') + (skill.description ? ' · ' + skill.description : ''),
            skill,
        };
    }

    // 只换 selected 高亮，不动 DOM 结构（方向键 / 鼠标悬停共用）
    function syncSelectedClass() {
        if (!el.slash) return;
        el.slash.querySelectorAll('.ai-slash-item').forEach((row) => {
            row.classList.toggle('selected', Number(row.dataset.aiSlashIndex) === slashState.index);
        });
    }

    // 让选中项留在可视区：容器自己滚（.ai-slash 是 max-height + overflow:auto 的滚动容器）
    function scrollSelectedIntoView() {
        const list = el.slash;
        if (!list) return;
        const selected = list.querySelector('.ai-slash-item.selected');
        if (!selected) return;
        const delta = slashScrollDelta(list.getBoundingClientRect(), selected.getBoundingClientRect());
        if (delta) list.scrollTop += delta;
    }

    // 方向键移动选中：只切高亮 + 滚动跟随，**不重建列表**。
    // 重建（updateSlash → renderSlash 的 innerHTML=''）会把 scrollTop 归零，
    // 选中项一离开首屏就跑到可视区外——这正是「方向键选中了但滚轮不跟」的根因。
    // 列表内容只由输入框文本决定，value 没变时切高亮与重建等价。
    function moveSlashSelection(delta) {
        if (!slashState.open || !slashState.items.length) return false;
        slashState.index = aiClamp(slashState.index + delta, 0, slashState.items.length - 1);
        syncSelectedClass();
        scrollSelectedIntoView();
        return true;
    }

    function renderSlash(items) {
        if (!items.length) {
            hideSlash();
            return;
        }
        slashState.items = items;
        slashState.index = aiClamp(slashState.index, 0, items.length - 1);
        slashState.open = true;
        el.slash.innerHTML = '';
        let headerPlaced = false;
        items.forEach((entry, index) => {
            // 分区标题放在第一个技能条目前：指令固定在前、技能在后
            if (entry.type === 'skill' && !headerPlaced) {
                headerPlaced = true;
                const header = document.createElement('div');
                header.className = 'ai-slash-header';
                header.textContent = '技能';
                el.slash.appendChild(header);
            }
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'ai-slash-item' + (index === slashState.index ? ' selected' : '');
            item.dataset.aiSlashIndex = String(index);
            const name = document.createElement('span');
            name.textContent = entry.name;
            const desc = document.createElement('span');
            desc.className = 'ai-slash-desc';
            desc.textContent = entry.desc;
            item.append(name, desc);
            item.addEventListener('click', () => {
                slashState.index = index;
                runSlashCommand(items[index]);
            });
            item.addEventListener('mousemove', () => {
                if (slashState.index === index) return;
                slashState.index = index;
                syncSelectedClass();
            });
            el.slash.appendChild(item);
        });
        el.slash.classList.remove('hidden');
        // 重建后把选中项重新纳入视野：过滤条件变化会收缩列表、index 被 clamp，
        // 用户也可能刚用滚轮停在半途（innerHTML 重建会重置 scrollTop）。
        scrollSelectedIntoView();
        positionOverlays();
    }

    function updateSlash() {
        if (!el.slash || !el.input) return;
        const value = el.input.value;
        if (!value.startsWith('/') || value.includes(' ') || value.includes('\n')) {
            hideSlash();
            return;
        }
        const query = value.slice(1).toLowerCase();
        const commands = filterSlashCommands(AI_COMMANDS, query).map(commandEntry);
        const matched = skillsCache ? filterSlashSkills(skillsCache, query).map(skillEntry) : [];
        const entries = commands.concat(matched);
        const rendered = entries.length > 0;
        if (rendered) renderSlash(entries);
        else hideSlash();
        if (skillsFresh()) return;
        // 首载 / 缓存过期：旧列表先顶上补全（不闪烁），刷新到达后本次输入仍有效就再渲染一遍
        // （含「指令无匹配但技能有」的面板重开；Esc 与空态在此时序下无法区分，
        //  重开窗口只有一次异步往返，可接受）
        const seq = ++renderSeq;
        ensureSkills().then((skills) => {
            if (seq !== renderSeq || !el.input || el.input.value !== value) return;
            const all = commands.concat(filterSlashSkills(skills, query).map(skillEntry));
            if (all.length) renderSlash(all);
            else if (!rendered) hideSlash();
        });
    }

    // 技能调用核心：附加技能附件后立即发起一轮（生成中由 sendComposerMessage 排队）——
    // 有参数发原文（/技能名 参数），无参数只发 skill（空文案由 startSessionTurn 补占位、正文随附件注入）。
    // 对齐主流 harness「选中即作为本轮请求」的语义，不再让用户「继续输入需求 / 等下一轮」。
    async function invokeSkillItem(skill, typedText) {
        if (!skill) return;
        hideSlash();
        const {args, textToSend} = slashSkillInvocation(typedText, skill.name);
        if (!addAttachment({kind: 'skill', label: skill.name, path: skill.path, content: skill.content})) return;
        sendComposerMessage(textToSend);
        showNote(args ? ('已附加技能：' + skill.name) : ('已发送技能：' + skill.name));
    }

    async function runSlashCommand(entry) {
        if (!entry) return;
        if (entry.type === 'skill') {
            await invokeSkillItem(entry.skill, el.input ? String(el.input.value || '') : '');
            return;
        }
        const command = entry;
        const typed = el.input ? String(el.input.value || '').trim() : '';
        const argText = typed.startsWith(command.name) ? typed.slice(command.name.length).trim() : '';
        hideSlash();
        if (el.input) {
            el.input.value = '';
            resizeInput();
        }
        updateSendState();
        switch (command.name) {
            case '/context':
                try {
                    showNote(await contextSummaryText());
                } catch (e) {
                    showNote('上下文统计失败：' + ((e && e.message) || e), true);
                }
                break;
            case '/compact':
                startCompact(argText ? {instruction: argText} : undefined);
                break;
            case '/clear':
                clearCurrentSession();
                break;
            case '/help':
                showNote('可用命令：\n' + AI_COMMANDS.map((cmd) => cmd.name + '  —  ' + cmd.desc).join('\n')
                    + '\n\n技能输入 /技能名 立即发送（只发 skill），也可带参数如 /技能名 参数；输入 / 从补全列表选择。');
                break;
            case '/model':
                showModelPicker();
                break;
            case '/export':
                exportSession();
                break;
            case '/memory':
                await showMemoryDialog();
                break;
            case '/schedule':
                if (openSchedulesPage) openSchedulesPage();
                else openSettings('schedules');
                break;
            case '/skill':
                if (argText) await attachSkillByName(argText);
                else await showSkillsDialog();
                break;
            case '/persona':
                openSettings('persona');
                break;
            case '/plan':
                handlePlanCommand(argText);
                break;
            case '/init':
                await runInitAgentsMd();
                break;
            case '/patch': {
                // 直接注入提示词到输入框，用户可改再发；不在命令里替用户做决定
                const ask = argText.trim();
                const prompt = ask
                    ? '把「' + ask + '」的改动做成 patch 补丁给我审批（不要直接改文件）。'
                    : '把这次改动做成 patch 补丁给我审批（不要直接改文件）。';
                if (el.input) {
                    el.input.value = prompt;
                    el.input.focus();
                    try { el.input.setSelectionRange(prompt.length, prompt.length); } catch (e) {}
                    updateSendState();
                }
                showNote('已填入提示词。');
                break;
            }
            case '/diff': {
                const ask = argText.trim();
                const prompt = ask
                    ? '先给我看「' + ask + '」改动的 diff，不要写入文件。'
                    : '先给我看这次改动的 diff，不要写入文件。';
                if (el.input) {
                    el.input.value = prompt;
                    el.input.focus();
                    try { el.input.setSelectionRange(prompt.length, prompt.length); } catch (e) {}
                    updateSendState();
                }
                showNote('已填入提示词。');
                break;
            }
            case '/worktree': {
                // 隔离 worktree：面板直接创建（不经过模型回合，确定性入口）。
                // 确认卡在 createWorktree 内部按当前档位出（full 免）；成功后会出胶囊。
                const added = await ctx.createWorktree(argText.trim());
                showNote(added
                    ? '隔离区已创建：' + added.name + '（分支 ' + added.branch + '）。之后让 AI 在 .cadt/worktree/' + added.name + '/ 下改代码，完成后 export 审阅回灌。'
                    : '未创建隔离区（已有隔离区、用户取消或失败，详见提示）。');
                break;
            }
            default:
                showNote('未知命令，输入 /help 查看可用命令。', true);
                break;
        }
    }

    async function handleSlashText(text) {
        const name = String(text || '').trim().split(/\s+/)[0];
        const command = AI_COMMANDS.find((cmd) => cmd.name === name);
        if (command) {
            runSlashCommand(command);
            return;
        }
        // 非固定指令：尝试按技能名调用（/技能名 参数）。缓存没命中先强扫一次再判未知——
        // skill_use / /skill / 技能菜单都是 listSkills(true) 强扫，只有这里读缓存；
        // 不补这一趟就会出现「模型能加载、斜杠说不认识」的口径分裂。
        let skill = findSkillBySlashToken(await ensureSkills(), name);
        if (!skill) skill = findSkillBySlashToken(await refreshSkills(true), name);
        if (skill) {
            await invokeSkillItem(skill, text);
            return;
        }
        showNote('未知命令：' + name + '\n输入 / 查看命令与技能补全，/help 查看命令列表。', true);
    }

    ensureSkills();
    return {hideSlash, updateSlash, runSlashCommand, handleSlashText, invalidateSkills, moveSlashSelection};
}
