// message-center.js：状态栏消息中心（【消息】入口 + 浮层面板 + 持久化消息队列）。
// 消息来源：AI 的 notify_send 工具、失败 / 提问 / 审批等需要用户回来处理的事件、版本更新等系统事件。
// **例行「任务完成」不进这里**（一轮一条会把列表刷成流水账，会话列表的「已完成未查看」角标已表达同一件事），
// 它只在软件处于后台时走 Windows 系统卡片（见 ai/core/ai-notify-policy.js 的 centerRecord）。
// 右下角 toast 只是消息的「可选弹出形态」——弹完消失后消息仍在列表里
// （localStorage 持久化，上限 100 条，超出淘汰最旧）。
// ctx: {
//   focusSession(sessionId)        toast 点击跳转到对应 AI 会话（main.js 传懒箭头）
//   runAction(actionId, item)      带 actionId 的消息被点击时分派动作（如打开更新对话框）
// }

// 历史迁移：审批 / 待填写曾被标成 error（红叉图标），语义上不是错误，统一改成 info。
// 只按标题匹配（含 60 秒催办的「（仍在等待）」后缀），不动真正的「AI 任务失败」。
// 就地修改并返回是否发生变化，供 load 决定是否写回 localStorage；抽成纯函数便于单测。
import {overlayStack} from '../core/overlay-stack.js';
import {placePopover} from '../core/popover-position.js';
import {iconSvg} from '../core/icons.js';
import {kvGetJson, kvSetJson} from '../core/kv-store.js';
import {LAYOUT_MOTION_OPTIONS, heightKeyframes, shouldAnimateLayout} from '../ai/chat/ai-layout-motion.js';

export function migrateApprovalKind(m) {
    if (m && m.kind === 'error' && /AI 待(审批|填写)/.test(String(m.title || ''))) {
        m.kind = 'info';
        return true;
    }
    return false;
}

export function createMessageCenter(ctx) {
    const KEY = 'datalens-message-center';
    const MAX_MESSAGES = 100;
    // 消息类型 → 注册表键（圆圈勾/圆圈叉是状态徽标造型，与裸勾/叉区分）
    const KIND_ICONS = {
        success: 'circle-check',
        error: 'circle-x',
        update: 'refresh',
        ai: 'bell',
        info: 'info',
    };
    // toast 图标 18px（.app-toast-icon 无 svg 尺寸规则，显式尺寸保持撑满）；面板行 CSS 统一 13px 覆盖
    const kindIcon = (kind) => iconSvg(KIND_ICONS[kind] || KIND_ICONS.info, 18);

    // 历史遗留：2026-11-17 之前每轮结束都记一条「AI 任务完成」（标题固定），一轮一条会把列表刷成流水账。
    // 口径已改（完成不进消息中心，见 ai/core/ai-notify-policy.js），读取时把这类旧条目一次性剔掉，
    // 免得改完之后列表里还留着上百行旧流水。只认「success + 标题完全相同」，
    // notify_send 发的自定义标题消息（哪怕内容与完成有关）一律保留。
    // 注意：必须定义在下面的 load() 调用之前——load 里要用它，const 存在 TDZ，
    // 挪到 load 调用之后就变成「Cannot access before initialization」，整个模块初始化失败。
    const LEGACY_DONE_TITLE = 'AI 任务完成';
    const isLegacyDone = (m) => !!m && m.kind === 'success' && m.title === LEGACY_DONE_TITLE;

    let messages = load();
    let seq = 0;
    let pop = null;
    // 面板的弹层栈条目（togglePanel/closePanel 收口）
    let stackHandle = null;
    // 浮层定位函数（内容高度变化后重新调用，保证底部始终贴住按钮）
    let placePanel = null;
    // 高度补间期间逐帧重定位，避免面板底边在收缩过程中离开按钮
    let heightAnim = null;
    // 每次起新动画 / 关面板都自增：旧动画的 finish 回调与 follow 帧链据此识别自己已过期，
    // 不再对当前面板调用 placePanel（否则多次重入会在同一帧重复定位、甚至用旧目标干扰新动画）。
    let heightAnimGen = 0;

    function load() {
        const raw = kvGetJson(KEY, []);
        const list = Array.isArray(raw) ? raw.slice(0, MAX_MESSAGES) : [];
        const kept = list.filter((m) => !isLegacyDone(m));
        let approvalMigrated = false;
        for (const m of kept) {
            if (migrateApprovalKind(m)) approvalMigrated = true;
        }
        if (kept.length !== list.length || approvalMigrated) {
            // 顺手写回：别每次启动都重新过滤一遍（此处不能调 persist——messages 还没绑定）
            kvSetJson(KEY, kept);
        }
        return kept;
    }

    function persist() {
        // 写不进（隐私模式 / 配额满）：降级为内存态，不影响本会话使用
        kvSetJson(KEY, messages.slice(0, MAX_MESSAGES));
    }

    function btnEl() {
        return document.getElementById('btn-messages');
    }

    function badgeEl() {
        return document.getElementById('msg-badge');
    }

    function unreadCount() {
        return messages.filter((m) => !m.read).length;
    }

    function refreshBadge() {
        const badge = badgeEl();
        const btn = btnEl();
        const count = unreadCount();
        if (badge && btn) {
            badge.textContent = count > 99 ? '99+' : String(count);
            badge.classList.toggle('hidden', !count);
            btn.dataset.tip = count ? '消息中心（' + count + ' 条未读）' : '消息中心';
        }
        if (pop && pop.isConnected) {
            // 重绘前取消进行中的高度动画：它的终值是旧内容（空态）的高度，若不取消，
            // 新消息重绘成高列表后动画仍会把面板压向旧终值，overflow:hidden 截断内容。
            cancelHeightAnim();
            renderPanel(pop);
            // 新消息进来（如 ask_user 提问）会让未读排前、面板变高：重新定位让底边继续贴按钮。
            // 否则顶边固定 + 内容增高会把底部顶出视口/状态栏，只露出上半截（与「清空全部」同一处理）。
            if (placePanel) placePanel();
        }
    }

    // 新增消息：msg = {kind: 'ai'|'success'|'error'|'update'|'info', title, body, sessionId?, actionId?}；
    // actionId 是可持久化的动作标识（点击消息时分派给 ctx.runAction，如 'open-update-dialog'）；
    // opts.toast = true 时右下角弹出提示框（弹完消息仍在列表）。
    function add(msg, opts) {
        const item = {
            id: 'm' + Date.now() + '-' + (++seq),
            ts: Date.now(),
            kind: KIND_ICONS[msg && msg.kind] ? msg.kind : 'info',
            title: String((msg && msg.title) || '').slice(0, 120) || '消息',
            body: String((msg && msg.body) || '').slice(0, 2000),
            sessionId: String((msg && msg.sessionId) || ''),
            actionId: String((msg && msg.actionId) || ''),
            read: false,
        };
        messages.unshift(item);
        if (messages.length > MAX_MESSAGES) messages.length = MAX_MESSAGES;
        persist();
        refreshBadge();
        if (opts && opts.toast) showToast(item);
        return item.id;
    }

    function markAllRead() {
        for (const m of messages) m.read = true;
        persist();
        refreshBadge();
    }

    function clearAll() {
        messages = [];
        persist();
        refreshBadge();
    }

    // 面板专用紧凑格式（旧档回 MM-DD HH:mm），与 core/humanize.relativeTime 口径不同，勿混用/勿替换。
    function relativeTime(ts) {
        const diff = Date.now() - ts;
        if (diff < 60000) return '刚刚';
        if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
        if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
        const d = new Date(ts);
        const pad = (n) => String(n).padStart(2, '0');
        return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    // 右下角弹出提示：复用 #app-toasts 与 .app-toast 样式（与原任务完成 toast 同形态）
    function showToast(item) {
        const host = document.getElementById('app-toasts');
        if (!host) return;
        const toast = document.createElement('div');
        toast.className = 'app-toast ' + (item.kind === 'error' ? 'error' : (item.kind === 'success' ? 'success' : 'info'));
        const icon = document.createElement('span');
        icon.className = 'app-toast-icon';
        icon.innerHTML = kindIcon(item.kind);
        const main = document.createElement('div');
        main.className = 'app-toast-main';
        const title = document.createElement('div');
        title.className = 'app-toast-title';
        title.textContent = item.title;
        const body = document.createElement('div');
        body.className = 'app-toast-body';
        body.textContent = item.body;
        main.append(title, body);
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'app-toast-close';
        close.dataset.tip = '关闭提示';
        close.textContent = '×';
        toast.append(icon, main, close);
        let timer = 0;
        const dismiss = () => {
            if (timer) clearTimeout(timer);
            timer = 0;
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 180);
        };
        close.addEventListener('click', (e) => {
            e.stopPropagation();
            dismiss();
        });
        toast.addEventListener('click', () => {
            if (item.actionId && typeof ctx.runAction === 'function') {
                ctx.runAction(item.actionId, item);
            } else if (item.sessionId && typeof ctx.focusSession === 'function') {
                ctx.focusSession(item.sessionId);
            }
            dismiss();
        });
        host.appendChild(toast);
        while (host.children.length > 3) host.firstElementChild.remove();
        requestAnimationFrame(() => toast.classList.add('show'));
        timer = setTimeout(dismiss, 9000);
    }

    // 浮层面板：未读在上（其余按时间倒序），行点击标记已读；「清空全部」清队列。
    // 本函数只负责渲染内容；高度动画由「清空全部」点击处理显式触发（见下方 animatePanelHeight），
    // 避免 refreshBadge / 首次打开等重绘路径误起「从 0 展开」的错误动画。
    function renderPanel(host) {
        host.textContent = '';
        const head = document.createElement('div');
        head.className = 'msg-center-head';
        const title = document.createElement('span');
        title.className = 'msg-center-title';
        title.textContent = '消息';
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'msg-center-clear';
        clear.textContent = '清空全部';
        clear.addEventListener('click', () => {
            const oldHeight = host.offsetHeight;
            clearAll();
            renderPanel(host);
            animatePanelHeight(host, oldHeight);
        });
        head.append(title, clear);
        host.appendChild(head);
        if (!messages.length) {
            const empty = document.createElement('div');
            empty.className = 'msg-center-empty';
            empty.textContent = '暂无消息';
            host.appendChild(empty);
            return;
        }
        const ordered = messages.slice().sort((a, b) => ((a.read === true) - (b.read === true)) || (b.ts - a.ts));
        for (const item of ordered) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'msg-center-row' + (item.read ? '' : ' unread');
            const icon = document.createElement('span');
            icon.className = 'msg-center-ico';
            icon.innerHTML = kindIcon(item.kind);
            const main = document.createElement('span');
            main.className = 'msg-center-main';
            const line1 = document.createElement('span');
            line1.className = 'msg-center-line1';
            const name = document.createElement('span');
            name.className = 'msg-center-row-title';
            name.textContent = item.title;
            const time = document.createElement('span');
            time.className = 'msg-center-time';
            time.textContent = relativeTime(item.ts);
            line1.append(name, time);
            const body = document.createElement('span');
            body.className = 'msg-center-body';
            body.textContent = item.body;
            main.append(line1, body);
            row.append(icon, main);
            row.addEventListener('click', () => {
                if (!item.read) {
                    item.read = true;
                    persist();
                    refreshBadge();
                }
                if (item.actionId && typeof ctx.runAction === 'function') {
                    ctx.runAction(item.actionId, item);
                } else if (item.sessionId && typeof ctx.focusSession === 'function') {
                    ctx.focusSession(item.sessionId);
                }
                closePanel();
            });
            host.appendChild(row);
        }
    }

    // 取消进行中的高度动画：先让 gen 失效（旧帧链/回调停止），再 cancel 动画本体。
    function cancelHeightAnim() {
        heightAnimGen++;
        if (heightAnim) {
            heightAnim.cancel();
            heightAnim = null;
        }
    }

    function animatePanelHeight(host, oldHeight) {
        cancelHeightAnim();
        const newHeight = host.offsetHeight;
        const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        if (!shouldAnimateLayout(oldHeight, newHeight, reduce, typeof host.animate === 'function')) {
            if (placePanel) placePanel();
            return;
        }
        const gen = heightAnimGen;
        const anim = host.animate(heightKeyframes(oldHeight, newHeight), LAYOUT_MOTION_OPTIONS);
        heightAnim = anim;
        const finish = () => {
            if (heightAnim === anim) heightAnim = null;
            if (gen !== heightAnimGen) return;
            if (placePanel) placePanel();
        };
        anim.addEventListener('finish', finish, {once: true});
        anim.addEventListener('cancel', finish, {once: true});
        const follow = () => {
            if (gen !== heightAnimGen) return;
            if (anim.playState === 'finished' || anim.playState === 'idle') return;
            if (placePanel) placePanel();
            requestAnimationFrame(follow);
        };
        requestAnimationFrame(follow);
    }

    function closePanel() {
        if (!pop) return;
        // 先断链再 cancel：cancel 触发的回调因 gen 已失效不会再对新移除的面板定位
        cancelHeightAnim();
        placePanel = null;
        if (stackHandle) {
            stackHandle.dispose();
            stackHandle = null;
        }
        pop.remove();
        pop = null;
    }

    function togglePanel(anchor) {
        if (pop) {
            closePanel();
            return;
        }
        const panel = document.createElement('div');
        panel.className = 'msg-center-pop';
        document.body.appendChild(panel);
        renderPanel(panel);
        // 定位统一走 core/popover-position（底部贴按钮、右侧对齐、视口钳制）
        placePanel = () => placePopover(panel, anchor, {placement: 'top', align: 'right', gap: 8});
        placePanel();
        pop = panel;
        // 打开即视为已读：未读角标清零
        markAllRead();
        // Esc 与外点关闭都归全局弹层栈：面板外点（不含锚点）自动退出本层
        stackHandle = overlayStack.open({
            id: 'msg-center-pop', kind: 'popover', el: panel,
            closeOnOutsideClick: true, anchors: [anchor],
            onClose: () => { closePanel(); return true; },
        });
    }

    function init() {
        const btn = btnEl();
        if (!btn) return;
        btn.addEventListener('click', () => togglePanel(btn));
        refreshBadge();
    }

    init();
    return {add, clearAll, refreshBadge, togglePanel};
}
