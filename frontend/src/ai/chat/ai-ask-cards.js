// ai-ask-cards.js：提问卡（可折叠收起成细条）与环境变量询问卡（composer 接管区的 AI 提问交互）。
// 从 ai-takeover.js 拆出（frontend-split-phase3 A2，同域兄弟模块）；ctx 与宿主同源，
// askNavAction 纯函数（宿主留守，ai-takeover.test.mjs 覆盖）与宿主分发器经 extras 注入。
import {aiClampInt, aiNowId} from '../core/ai-constants.js';
import {iconSvg} from '../../core/icons.js';

// 问号圆圈图标：展开态头部与收起态细条共用（.ai-ask-icon 无 svg 尺寸规则，显式 16 保持撑满）
const ASK_ICON_SVG = iconSvg('question', 16);

// 倒计时暂停/继续图标：暂停态显示播放三角（点它继续），运行态显示双竖条（点它暂停）
const ASK_PAUSE_SVG = iconSvg('pause');
const ASK_PLAY_SVG = iconSvg('play');

// ===== 询问卡片入口与草稿 =====
export function createAIAskCards(ctx, extras) {
    const el = ctx.el;
    const decideEnvCreation = ctx.decideEnvCreation;
    const askDrafts = ctx.askDrafts;
    const askCountdownText = ctx.askCountdownText;
    const toggleAskPause = ctx.toggleAskPause;
    const skipAsk = ctx.skipAsk;
    const submitAskAnswers = ctx.submitAskAnswers;
    const AI_CHEVRON_SVG = ctx.AI_CHEVRON_SVG;
    // ask 接管卡的键盘导航决策（宿主留守的导出纯函数，测试从 ai-takeover.js 取）
    const askNavAction = extras.askNavAction;
    // 折叠/展开走宿主分发器（与审批卡同口径：重定位浮层 + stickBottom 跟随）
    const updateComposerTakeover = extras.updateComposerTakeover;

    function askTakeoverKey(entry) {
        return entry.toolMessage.toolCallId || entry.key;
    }

    // 倒计时右侧的暂停/继续小图标。仅倒计时存在时显示；无 deadline（wait / 0 秒）时返回 null。
    // 用独立 button 而非把细条本身做成 button：收起态细条若嵌 button 会形成嵌套按钮，故细条改 div。
    function askPauseButton(entry) {
        const ask = entry.ask;
        if (!ask || !ask.deadline) return null;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ai-ask-pause';
        const paused = !!ask.paused;
        btn.innerHTML = paused ? ASK_PLAY_SVG : ASK_PAUSE_SVG;
        btn.dataset.tip = paused ? '继续倒计时' : '暂停倒计时';
        btn.setAttribute('aria-label', paused ? '继续倒计时' : '暂停倒计时');
        btn.addEventListener('click', (e) => {
            e.stopPropagation(); // 收起态细条整块可点恢复，别让暂停按钮冒泡触发展开
            e.preventDefault();
            toggleAskPause(entry);
        });
        return btn;
    }

    function askDraftFor(entry) {
        const key = askTakeoverKey(entry);
        let draft = askDrafts.get(key);
        if (draft) return draft;
        draft = {
            idx: 0,
            // 收起态：整卡折成单行细条（保留倒计时、不放决策按钮），方便先看上方消息；
            // 草稿与题目进度不丢，点击细条恢复
            collapsed: false,
            // 键盘焦点落在第几个导航项（选项 + 可选「自己输入」框）；整卡重建后据此回焦，保证连续按键不中断。
            focusOi: 0,
            // 推荐项只显示「推荐」角标不预选：预选会和「点选自动下一题」冲突（点推荐=取消选中）。
            answers: entry.ask.questions.map(() => ({selected: [], custom: ''})),
        };
        askDrafts.set(key, draft);
        return draft;
    }

// ===== env 询问接管 =====
    function renderEnvAskTakeover(entry) {
        const toolMessage = entry.toolMessage;
        const envAsk = toolMessage.envAsk;
        el.takeover.dataset.takeoverKey = 'env:' + (toolMessage.toolCallId || aiNowId('env-ask-'));
        el.takeover.textContent = '';
        const card = document.createElement('div');
        card.className = 'ai-takeover-card ai-env-takeover';
        const head = document.createElement('div');
        head.className = 'ai-takeover-head';
        const icon = document.createElement('span');
        icon.className = 'ai-ask-icon';
        icon.innerHTML = iconSvg('env', 16);
        const title = document.createElement('span');
        title.className = 'ai-takeover-title';
        title.textContent = '创建环境变量 · ' + envAsk.name;
        head.append(icon, title);
        const body = document.createElement('div');
        body.className = 'ai-takeover-body';
        if (envAsk.description) {
            const desc = document.createElement('div');
            desc.className = 'ai-ask-detail';
            desc.textContent = envAsk.description;
            body.appendChild(desc);
        }
        const row = document.createElement('div');
        row.className = 'env-ask-row';
        const input = document.createElement('input');
        input.type = 'password';
        input.className = 'ai-settings-input env-ask-input';
        input.placeholder = '输入变量值（仅你可见）';
        input.spellcheck = false;
        input.autocomplete = 'off';
        const submit = (approved) => decideEnvCreation(toolMessage, approved, input.value);
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); submit(true); }
            else if (e.key === 'Escape') { e.preventDefault(); submit(false); }
        });
        row.appendChild(input);
        const hint = document.createElement('div');
        hint.className = 'ai-approval-more';
        hint.textContent = '值由用户亲自输入，AI 看不到；保存后注入终端与命令桥。Enter 创建 · Esc 放弃。';
        const actions = document.createElement('div');
        actions.className = 'ai-approval-actions';
        const deny = document.createElement('button');
        deny.type = 'button';
        deny.className = 'dlg-btn';
        deny.textContent = '放弃';
        deny.addEventListener('click', () => submit(false));
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'dlg-btn primary';
        apply.textContent = '创建';
        apply.addEventListener('click', () => submit(true));
        actions.append(deny, apply);
        body.append(row, hint, actions);
        card.append(head, body);
        el.takeover.appendChild(card);
        setTimeout(() => {
            if (input.isConnected) input.focus();
        }, 50);
    }

// ===== 询问接管渲染 =====
    function renderAskTakeover(entry) {
        const ask = entry.ask;
        const draft = askDraftFor(entry);
        const key = askTakeoverKey(entry);
        const multi = ask.questions.length > 1;
        draft.idx = multi ? aiClampInt(draft.idx, 0, ask.questions.length - 1, 0) : 0;
        el.takeover.dataset.takeoverKey = 'ask:' + key;
        el.takeover.textContent = '';
        if (draft.collapsed) {
            renderAskCollapsedBar(entry, ask, draft, key, multi);
            return;
        }
        const card = document.createElement('div');
        card.className = 'ai-takeover-card ai-ask-takeover' + (multi ? ' multi' : '');
        const head = document.createElement('div');
        head.className = 'ai-takeover-head';
        const icon = document.createElement('span');
        icon.className = 'ai-ask-icon';
        icon.innerHTML = ASK_ICON_SVG;
        const title = document.createElement('span');
        title.className = 'ai-takeover-title';
        title.textContent = 'AI 提问' + (multi ? ' · ' + ask.questions.length + ' 个问题' : '');
        head.append(icon, title);
        // 有倒计时才渲染文案节点；wait / 0 秒（无 deadline）时文案为空，整块不显示
        const countdownText = askCountdownText(ask);
        if (countdownText) {
            const countdown = document.createElement('span');
            countdown.className = 'ai-ask-countdown';
            countdown.dataset.askKey = key;
            countdown.textContent = countdownText;
            head.appendChild(countdown);
        }
        const pauseBtn = askPauseButton(entry);
        if (pauseBtn) head.appendChild(pauseBtn);
        // 临时收起：整卡折成单行细条，方便继续看上方消息；倒计时保留在细条上（renderAskCollapsedBar），
        // 答案草稿与题目进度在 askDrafts 里不丢。展开态头部无倒计时时收起按钮自己推右（CSS 兄弟选择器分工）
        const collapse = document.createElement('button');
        collapse.type = 'button';
        collapse.className = 'ai-takeover-collapse';
        collapse.innerHTML = AI_CHEVRON_SVG;
        collapse.addEventListener('click', () => {
            draft.collapsed = true;
            updateComposerTakeover(true);
        });
        head.appendChild(collapse);
        const body = document.createElement('div');
        body.className = 'ai-takeover-body';
        const qi = draft.idx;
        const question = ask.questions[qi];
        const answerDraft = draft.answers[qi];
        // 键盘导航项 = 选项 + 可选「自己输入」框；focusOi 指向当前项，整卡重建后回焦到这里。
        const navCount = question.options.length + (question.allowCustom ? 1 : 0);
        draft.focusOi = aiClampInt(draft.focusOi, 0, Math.max(0, navCount - 1), 0);
        const block = document.createElement('div');
        block.className = 'ai-ask-form-q single';
        const qrow = document.createElement('div');
        qrow.className = 'ai-ask-qrow';
        if (question.header) {
            const header = document.createElement('span');
            header.className = 'ai-ask-header';
            header.textContent = question.header;
            qrow.appendChild(header);
        }
        const q = document.createElement('span');
        q.className = 'ai-ask-question';
        q.textContent = question.question;
        qrow.appendChild(q);
        if (multi) {
            const pager = document.createElement('span');
            pager.className = 'ai-ask-pager';
            const prev = document.createElement('button');
            prev.type = 'button';
            prev.className = 'ai-ask-page-btn';
            prev.innerHTML = iconSvg('chevron-left');
            prev.disabled = qi <= 0;
            prev.addEventListener('click', () => {
                draft.idx = Math.max(0, draft.idx - 1);
                renderAskTakeover(entry);
            });
            const pos = document.createElement('span');
            pos.className = 'ai-ask-page-pos';
            pos.textContent = (qi + 1) + ' / ' + ask.questions.length;
            const next = document.createElement('button');
            next.type = 'button';
            next.className = 'ai-ask-page-btn';
            next.innerHTML = iconSvg('chevron-right');
            next.disabled = qi >= ask.questions.length - 1;
            next.addEventListener('click', () => {
                draft.idx = Math.min(ask.questions.length - 1, draft.idx + 1);
                renderAskTakeover(entry);
            });
            pager.append(prev, pos, next);
            qrow.appendChild(pager);
        }
        block.appendChild(qrow);
        if (question.detail) {
            const detail = document.createElement('div');
            detail.className = 'ai-ask-detail';
            detail.textContent = question.detail;
            block.appendChild(detail);
        }
        const options = document.createElement('div');
        options.className = 'ai-ask-options';
        for (let oi = 0; oi < question.options.length; oi++) {
            const option = question.options[oi];
            const selected = answerDraft.selected.includes(option.label);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'ai-ask-option' + (option.recommended ? ' recommended' : '') + (selected ? ' selected' : '');
            button.dataset.askOpt = String(oi);
            if (question.multiSelect) {
                const check = document.createElement('span');
                check.className = 'ai-ask-check';
                check.innerHTML = iconSvg('check');
                button.appendChild(check);
            }
            const num = document.createElement('span');
            num.className = 'ai-ask-num';
            num.textContent = (oi + 1) + '.';
            const label = document.createElement('span');
            label.className = 'ai-ask-option-label';
            label.textContent = option.label;
            button.append(num, label);
            if (option.recommended) {
                const badge = document.createElement('span');
                badge.className = 'ai-ask-badge';
                badge.textContent = '推荐';
                button.appendChild(badge);
            }
            if (option.description) {
                const desc = document.createElement('span');
                desc.className = 'ai-ask-option-desc';
                desc.textContent = option.description;
                button.appendChild(desc);
            }
            button.addEventListener('click', () => {
                draft.focusOi = oi;
                if (question.multiSelect) {
                    const at = answerDraft.selected.indexOf(option.label);
                    if (at >= 0) answerDraft.selected.splice(at, 1);
                    else answerDraft.selected.push(option.label);
                } else {
                    answerDraft.selected = selected ? [] : [option.label];
                    answerDraft.custom = '';
                    if (answerDraft.selected.length && qi < ask.questions.length - 1) {
                        draft.idx = qi + 1;
                        draft.focusOi = 0; // 跳到下一题，焦点回到首项
                    }
                }
                renderAskTakeover(entry);
            });
            options.appendChild(button);
        }
        if (options.childNodes.length) block.appendChild(options);
        if (question.allowCustom) {
            const custom = document.createElement('div');
            custom.className = 'ai-ask-custom';
            const num = document.createElement('span');
            num.className = 'ai-ask-num';
            num.textContent = (question.options.length + 1) + '.';
            const input = document.createElement('input');
            input.className = 'ai-ask-input';
            input.dataset.askOpt = String(question.options.length);
            input.type = 'text';
            input.placeholder = question.options.length ? '其他：自己输入回答…' : '输入你的回答…';
            input.spellcheck = false;
            input.value = answerDraft.custom;
            // 初始渲染：自填已有内容时显示选中态
            if (answerDraft.custom.trim()) custom.classList.add('selected');
            input.addEventListener('input', () => {
                answerDraft.custom = input.value;
                // 自填有内容即视为选中：加高亮；单选题同时清除选项选中（与提交逻辑对齐：custom 优先于 selected）
                custom.classList.toggle('selected', !!answerDraft.custom.trim());
                if (!question.multiSelect && answerDraft.custom.trim()) {
                    answerDraft.selected = [];
                    // 同步 UI：移除所有选项的 .selected 类，不重建卡片（避免打断输入焦点）
                    options.querySelectorAll('.ai-ask-option.selected').forEach((btn) => {
                        btn.classList.remove('selected');
                    });
                }
            });
            input.addEventListener('focus', () => {
                draft.focusOi = question.options.length;
            });
            input.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (qi < ask.questions.length - 1) {
                    draft.idx = qi + 1;
                    renderAskTakeover(entry);
                } else {
                    submitAskAnswers(entry, draft.answers);
                }
            });
            custom.append(num, input);
            block.appendChild(custom);
        }
        body.appendChild(block);
        const foot = document.createElement('div');
        foot.className = 'ai-takeover-foot';
        const hint = document.createElement('span');
        hint.className = 'ai-takeover-hint';
        hint.textContent = multi
            ? '上下键选择，回车或空格选中；左右方向键切换问题'
            : '上下键选择，回车或空格选中；不确定可点「跳过」，超时按设置处理';
        const skip = document.createElement('button');
        skip.type = 'button';
        skip.className = 'dlg-btn';
        skip.textContent = '跳过';
        skip.addEventListener('click', () => skipAsk(entry));
        const main = document.createElement('button');
        main.type = 'button';
        main.className = 'dlg-btn primary';
        if (multi && qi < ask.questions.length - 1) {
            main.textContent = '继续';
            main.addEventListener('click', () => {
                draft.idx = qi + 1;
                renderAskTakeover(entry);
            });
        } else {
            main.textContent = '提交回答';
            main.addEventListener('click', () => submitAskAnswers(entry, draft.answers));
        }
        foot.append(hint, skip, main);
        card.append(head, body, foot);
        if (navCount) {
            card.addEventListener('keydown', (e) => {
                const tag = e.target && e.target.tagName;
                const action = askNavAction(e.key, {
                    multi,
                    questionCount: ask.questions.length,
                    idx: qi,
                    focusIndex: draft.focusOi,
                    itemCount: navCount,
                    inInput: tag === 'INPUT' || tag === 'TEXTAREA',
                });
                if (!action) return;
                e.preventDefault();
                if (action.type === 'question') {
                    draft.idx = action.idx;
                    draft.focusOi = 0;
                    renderAskTakeover(entry); // 切问题：整卡重建，末尾统一回焦
                    return;
                }
                // 上下：只移动焦点，不重建卡片（避免闪烁 / 打断输入）
                draft.focusOi = action.index;
                const opts = card.querySelectorAll('[data-ask-opt]');
                const target = opts[action.index];
                if (target) target.focus({preventScroll: true});
            });
        }
        el.takeover.appendChild(card);
        // 整卡重建后把焦点还回导航项，保证「选完一题按右键→再上下选」这种连续操作不中断。
        // 首次渲染也聚焦首项，让键盘用户一进来就能直接操作。
        if (navCount) {
            const target = card.querySelector('[data-ask-opt="' + draft.focusOi + '"]');
            if (target) target.focus({preventScroll: true});
        }
    }

// ===== 折叠条 =====
    // 收起态细条（沿用审批卡的 .ai-takeover-bar）：标题 + 当前问题 + 倒计时，不放「跳过 / 提交回答」；
    // 超时处理照常在后台走（到点按设置结算，细条随接管区一起消失）。点击恢复完整卡。
    function renderAskCollapsedBar(entry, ask, draft, key, multi) {
        // 细条内含暂停按钮，不能用 <button>（嵌套按钮非法）：改 div + role/tabindex 保留可点可聚焦
        const bar = document.createElement('div');
        bar.className = 'ai-takeover-bar';
        bar.setAttribute('role', 'button');
        bar.tabIndex = 0;
        const barIcon = document.createElement('span');
        barIcon.className = 'ai-ask-icon';
        barIcon.innerHTML = ASK_ICON_SVG;
        const barText = document.createElement('span');
        barText.className = 'ai-takeover-bar-text';
        const qi = aiClampInt(draft.idx, 0, ask.questions.length - 1, 0);
        const question = ask.questions[qi];
        barText.textContent = 'AI 提问' + (multi ? ' · ' + ask.questions.length + ' 个问题' : '') +
            ' · ' + (question ? question.question : '');
        bar.append(barIcon, barText);
        // 倒计时节点沿用同一 data-ask-key：updateAskCountdown 的原地更新对细条照常生效
        const countdownText = askCountdownText(ask);
        if (countdownText) {
            const countdown = document.createElement('span');
            countdown.className = 'ai-ask-countdown';
            countdown.dataset.askKey = key;
            countdown.textContent = countdownText;
            bar.appendChild(countdown);
        }
        const pauseBtn = askPauseButton(entry);
        if (pauseBtn) bar.appendChild(pauseBtn);
        const chev = document.createElement('span');
        chev.className = 'ai-takeover-collapse';
        chev.innerHTML = AI_CHEVRON_SVG;
        bar.appendChild(chev);
        const expand = () => {
            draft.collapsed = false;
            updateComposerTakeover(true);
        };
        bar.addEventListener('click', expand);
        bar.addEventListener('keydown', (e) => {
            if (e.target !== bar) return; // 暂停按钮上的按键交给它自己
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expand(); }
        });
        el.takeover.appendChild(bar);
    }

    return {askTakeoverKey, renderEnvAskTakeover, renderAskTakeover};
}
