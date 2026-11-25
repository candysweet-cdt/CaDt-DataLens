// ai-model-picker.js：双层级模型选择器（搜索 + 按账号分组 + 行内思考等级 + 会话上下文上限）。
// 方案 M1 从 ai-panel.js 逐字搬入（docs/finished-plans/side-chat-tab.md §7.4）。
// 状态自持（弹层节点与文档监听器）；配置 / 会话 / 动作经 ctx 注入，档位与窗口计算
// 直接复用 ai-config-model.js 的纯函数（单一来源）。
import {iconSvg} from '../../core/icons.js';
import {overlayStack} from '../../core/overlay-stack.js';
import {createInput} from '../../core/form-controls.js';
import {ctxLimitTiersFor, formatTokenAmount, normalizeCtxLimit, reasoningLevelInfo} from '../core/ai-config-model.js';
import {providerIconTileHtml} from '../core/ai-provider-icons.js';
import {formatUsageCompactText, usageTightSummary} from '../usage/ai-usage-quota.js';

export function createAIModelPicker(ctx) {
    const el = ctx.el;
    const getConfig = ctx.getConfig;
    const currentSession = ctx.currentSession;
    const entryOf = ctx.entryOf;
    const sessionModelRef = ctx.sessionModelRef;
    const switchModel = ctx.switchModel;
    const openSettings = ctx.openSettings;
    const setReasoningLevelFor = ctx.setReasoningLevelFor;
    const applyCtxLimit = ctx.applyCtxLimit;
    const flash = ctx.flash;
    // 额度外显（可选依赖）：分组头右侧显示余额主句；管线未注入时保持原样
    const usageQuota = typeof ctx.usageQuota === 'function' ? ctx.usageQuota : null;

    let modelPickerEl = null;
    // 浮层的弹层栈条目（页面级 body 浮层，popover 档）：Esc 与外点关闭都由栈处理
    let modelPickerStackHandle = null;

    function closeModelPicker() {
        if (modelPickerStackHandle) {
            modelPickerStackHandle.dispose();
            modelPickerStackHandle = null;
        }
        if (modelPickerEl) {
            modelPickerEl.remove();
            modelPickerEl = null;
        }
    }

    function showModelPicker() {
        if (!el.modelChip) return;
        if (modelPickerEl) {
            closeModelPicker();
            return;
        }
        const config = getConfig();
        if (!config.profiles.length) {
            openSettings('models');
            return;
        }
        const rect = el.modelChip.getBoundingClientRect();
        // 选择器展示 / 勾选的都是「当前会话」的模型（各会话独立）
        const sessionRef = sessionModelRef(currentSession());
        const activeAccountId = (sessionRef.profile && sessionRef.profile.id) || '';
        const activeEntryId = (sessionRef.entry && sessionRef.entry.id) || '';
        const picker = document.createElement('div');
        picker.className = 'ai-model-picker';
        modelPickerEl = picker;

        const searchWrap = document.createElement('div');
        searchWrap.className = 'ai-model-picker-searchwrap';
        const searchIco = document.createElement('span');
        searchIco.className = 'ai-model-picker-searchico';
        searchIco.innerHTML = iconSvg('search', 13);
        const search = createInput({
            className: 'ai-model-picker-search',
            placeholder: '搜索模型…',
            spellcheck: false,
        }).control;
        // 模型设置入口收成搜索框右侧的齿轮图标，不再占底部一整行
        const settingsBtn = document.createElement('button');
        settingsBtn.type = 'button';
        settingsBtn.className = 'ai-model-picker-settings';
        settingsBtn.dataset.tip = '模型设置';
        settingsBtn.setAttribute('aria-label', '模型设置');
        settingsBtn.innerHTML = iconSvg('gear', 14);
        settingsBtn.addEventListener('click', () => {
            closeModelPicker();
            openSettings('models');
        });
        searchWrap.append(searchIco, search, settingsBtn);
        const listBox = document.createElement('div');
        listBox.className = 'ai-model-picker-list';
        const limitRow = document.createElement('div');
        limitRow.className = 'ai-model-picker-limits';
        picker.append(searchWrap, listBox, limitRow);

        let flatItems = [];
        let navIndex = -1;
        // 行内展开的思考等级档位条（accountId|entryId）；搜索重建列表时收起
        let expandedKey = '';

        function renderList() {
            const query = search.value.trim().toLowerCase();
            const tokens = query.split(/\s+/).filter(Boolean);
            listBox.innerHTML = '';
            flatItems = [];
            for (const account of getConfig().profiles) {
                const entries = (account.models || []).filter((entry) => {
                    if (!tokens.length) return true;
                    const haystack = ((entry.model || '') + ' ' + (account.name || '')).toLowerCase();
                    return tokens.every((token) => haystack.includes(token));
                });
                if (!entries.length) continue;
                const group = document.createElement('div');
                group.className = 'ai-model-picker-group';
                const head = document.createElement('div');
                head.className = 'ai-model-picker-group-head';
                const headIcon = document.createElement('span');
                headIcon.className = 'ai-model-picker-headicon';
                headIcon.innerHTML = providerIconTileHtml(account, 16);
                head.appendChild(headIcon);
                const headName = document.createElement('span');
                headName.textContent = account.name || '未命名账号';
                head.append(headName);
                // 开启了额度查询的账号在分组头右侧显示「最紧」单值（显示规范 v1：
                // 已用型取已用最高窗口 / 剩余型取剩余最低段 / 币种型取总额），悬浮看全量行
                if (usageQuota) {
                    const snapshot = usageQuota().peek(account.id);
                    if (snapshot && (snapshot.state === 'error' || (snapshot.items || []).length)) {
                        const headUsage = document.createElement('span');
                        headUsage.className = 'ai-model-picker-usage' + (snapshot.state === 'error' ? ' error' : '');
                        const tight = snapshot.state === 'error' ? null : usageTightSummary(snapshot);
                        if (tight) {
                            if (tight.label) headUsage.appendChild(document.createTextNode(tight.label));
                            const value = document.createElement('b');
                            value.className = 'ai-usage-value' + (tight.tone ? ' tone-' + tight.tone : '');
                            value.textContent = tight.value;
                            headUsage.appendChild(value);
                        } else {
                            headUsage.textContent = snapshot.state === 'error' ? (snapshot.error || '查询失败') : '';
                        }
                        // 悬浮提示给全量行（全部窗口 + 倒计时）；与单值相同时（币种）不挂
                        const full = snapshot.state === 'error' ? '' : formatUsageCompactText(snapshot);
                        if (full && full !== headUsage.textContent) headUsage.dataset.tip = full;
                        else delete headUsage.dataset.tip;
                        head.appendChild(headUsage);
                    }
                }
                group.appendChild(head);
                for (const entry of entries) {
                    const isActive = account.id === activeAccountId && entry.id === activeEntryId;
                    const item = document.createElement('button');
                    item.type = 'button';
                    item.className = 'ai-model-picker-item' + (isActive ? ' active' : '');
                    const name = document.createElement('span');
                    name.className = 'ai-model-picker-name';
                    name.textContent = entry.model || '（未填写模型 ID）';
                    // 思考等级徽标：每个模型条目自己的等级（分色见 --ai-lv-*），
                    // 点击在行下展开档位条直接改该模型 —— 弹层不关，可连续配置多个
                    const info = reasoningLevelInfo(account, entry);
                    const effort = document.createElement('button');
                    effort.type = 'button';
                    effort.className = 'ai-model-picker-effort';
                    effort.dataset.tone = info.tone;
                    effort.textContent = info.label;
                    effort.addEventListener('click', (e) => {
                        e.stopPropagation();
                        toggleQuickBar(account, entry);
                    });
                    const win = document.createElement('span');
                    win.className = 'ai-model-picker-win';
                    win.textContent = formatTokenAmount(entry.contextWindow || 128000);
                    const check = document.createElement('span');
                    check.className = 'ai-model-picker-check';
                    check.innerHTML = isActive ? iconSvg('check', 13) : '';
                    item.append(name, effort, win, check);
                    item.addEventListener('click', () => {
                        closeModelPicker();
                        switchModel(account.id, entry.id);
                    });
                    flatItems.push(item);
                    group.appendChild(item);
                    // 档位条是 item 的兄弟节点（按钮不能嵌套），展开态单开
                    if (account.id + '|' + entry.id === expandedKey) group.appendChild(buildQuickBar(account, entry));
                }
                listBox.appendChild(group);
            }
            if (!flatItems.length) {
                const empty = document.createElement('div');
                empty.className = 'ai-model-picker-empty';
                empty.textContent = query
                    ? '没有匹配「' + search.value.trim() + '」的模型'
                    : '还没有模型';
                listBox.appendChild(empty);
            }
            navIndex = -1;
        }

        // 展开 / 收起某模型行下的思考等级档位条（同弹层内只开一个）
        function toggleQuickBar(account, entry) {
            const key = account.id + '|' + entry.id;
            expandedKey = expandedKey === key ? '' : key;
            renderList();
            const bar = expandedKey ? listBox.querySelector('.ai-model-picker-quick') : null;
            if (bar && bar.scrollIntoView) bar.scrollIntoView({block: 'nearest'});
        }

        // 思考等级档位条：连体分段控件，点档写该模型条目（不关弹层、徽标即时刷新）
        function buildQuickBar(account, entry) {
            const info = reasoningLevelInfo(account, entry);
            const bar = document.createElement('div');
            bar.className = 'ai-model-picker-quick ai-model-picker-seggroup';
            for (const [value, label] of info.options) {
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'ai-model-picker-seg' + (info.value === value ? ' active' : '');
                chip.textContent = label;
                chip.addEventListener('click', () => {
                    setReasoningLevelFor(account, entry, value);
                    flash('已更新 ' + (entry.model || '未命名模型') + ' 思考等级：' + reasoningLevelInfo(account, entry).label);
                    expandedKey = account.id + '|' + entry.id;
                    renderList();
                });
                bar.appendChild(chip);
            }
            return bar;
        }

        function setNav(next) {
            if (!flatItems.length) return;
            navIndex = (next + flatItems.length) % flatItems.length;
            flatItems.forEach((item, index) => item.classList.toggle('nav', index === navIndex));
            const target = flatItems[navIndex];
            if (target && target.scrollIntoView) target.scrollIntoView({block: 'nearest'});
        }

        // 本次会话上下文上限（会话级，不动模型条目）：档位只列 < 模型窗口的固定档
        //（CTX_LIMIT_TIERS），模型窗口不大于最小档（如上限就 256K 的模型）时整行隐藏。
        // 用滑动条代替一排按钮：从左到右窗口递增，最右 = 默认（用满模型窗口）。
        // 默认停在最右（不设限），用户按需往左收窄；拖动即时生效并回写会话。
        function renderLimits() {
            const session = currentSession();
            const entry = entryOf(session);
            const base = (entry && entry.contextWindow) || 128000;
            const tiers = ctxLimitTiersFor(base);
            limitRow.innerHTML = '';
            if (!session || !entry || !tiers.length) {
                limitRow.style.display = 'none';
                return;
            }
            limitRow.style.display = '';

            // 档位从小到大排列，末尾追加「默认」（value=0，用满模型窗口）。
            // 这样滑块最右 = 最大上下文，符合「默认划到最右」的直觉。
            const steps = tiers.slice().sort((a, b) => a - b).map((tier) => ({
                value: tier,
                label: formatTokenAmount(tier) + ' 上下文',
            }));
            steps.push({value: 0, label: formatTokenAmount(base) + ' 上下文 · 默认'});

            const wrap = document.createElement('div');
            wrap.className = 'ai-ctx-slider';
            const title = document.createElement('div');
            title.className = 'ai-ctx-slider-title';
            title.textContent = steps[steps.length - 1].label;
            const range = createInput({
                type: 'range',
                className: 'ai-ctx-slider-range',
                min: 0,
                max: steps.length - 1,
                step: 1,
                value: steps.length - 1,
                tabFillPlaceholder: false,
            }).control;
            // 当前会话已设上限时，滑块落在对应档位（找不到精确档就停最右的「默认」）。
            const currentLimit = normalizeCtxLimit(session.ctxLimit);
            const currentIdx = currentLimit > 0
                ? steps.findIndex((step) => step.value === currentLimit)
                : steps.length - 1;
            range.value = String(currentIdx < 0 ? steps.length - 1 : currentIdx);

            const apply = () => {
                const step = steps[Number(range.value)] || steps[steps.length - 1];
                title.textContent = step.label;
                applyCtxLimit(step.value);
            };
            range.addEventListener('input', apply);
            wrap.append(title, range);
            limitRow.appendChild(wrap);
        }

        search.addEventListener('input', () => {
            expandedKey = '';
            renderList();
        });
        search.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setNav(navIndex < 0 ? 0 : navIndex + 1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setNav(navIndex < 0 ? flatItems.length - 1 : navIndex - 1);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const target = flatItems[navIndex >= 0 ? navIndex : 0];
                if (target) target.click();
            }
            // Esc 不在这里处理：浮层已进全局弹层栈，栈按层序关
        });

        renderList();
        renderLimits();
        document.body.appendChild(picker);
        picker.style.visibility = 'hidden';
        const width = Math.min(360, window.innerWidth - 16);
        picker.style.width = width + 'px';
        // 锁定打开时的高度：搜索过滤只重建列表内容，弹层高度不再随结果条数变化。
        // 列表自身 flex:1 + min-height:0 + overflow:auto，内容变少时留白、变多时内部滚动。
        // 放置侧取上/下可用空间更大的一侧，并把高度夹进该侧空间（chip 靠屏幕边时收高度而非伸出视口）。
        const margin = 8;
        const naturalHeight = picker.offsetHeight;
        const spaceUp = rect.top - margin;
        const spaceDown = window.innerHeight - rect.bottom - margin;
        const placeUp = spaceUp >= spaceDown;
        const avail = Math.max(placeUp ? spaceUp : spaceDown, 0);
        const height = Math.min(naturalHeight, Math.max(avail, 120));
        picker.style.height = height + 'px';
        const rawTop = placeUp ? rect.top - height - margin : rect.bottom + margin;
        const top = Math.max(margin, Math.min(rawTop, window.innerHeight - height - margin));
        picker.style.left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin)) + 'px';
        picker.style.top = top + 'px';
        picker.style.visibility = '';
        search.focus();
        if (modelPickerStackHandle) modelPickerStackHandle.dispose();
        modelPickerStackHandle = overlayStack.open({
            id: 'ai-model-picker', kind: 'popover', el: picker,
            closeOnOutsideClick: true, anchors: [el.modelChip],
            onClose: () => { closeModelPicker(); return true; },
        });
    }

    return {showModelPicker, closeModelPicker};
}
