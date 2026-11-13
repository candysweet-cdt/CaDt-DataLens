// 会话结构（用户消息定位条）：
// 把当前 AI 会话里的每一轮用户消息渲染成一行可点击的定位项，点一下跳到那条消息。
// 数据由 ai-panel 的 bridgeSessionOutline() 提供，跳转也由 ai-panel 执行（消息窗口、
// 滚动与高亮都在那边），本模块只做渲染与键盘/点击交互。

const MAX_TEXT = 160;
const MAX_ITEMS = 400;

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
}

// 单行预览：把换行、连续空白压成空格，避免行高被撑开
function oneLine(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (s.length <= MAX_TEXT) return s;
    return s.slice(0, MAX_TEXT) + '…';
}

function shortTime(ts) {
    const ms = Number(ts) || 0;
    if (!ms) return '';
    const d = new Date(ms);
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
    return sameDay ? pad(d.getHours()) + ':' + pad(d.getMinutes())
        : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 把 session.messages 压成定位项：只留用户真正说过的话。
// 系统注记（systemNote）、应用注入的指令（app）、模型切换记录都不算一轮。
// options.max 限制最多返回多少条（保留最近的），返回里带 total / truncated。
export function buildSessionOutlineItems(messages, options) {
    const opts = options || {};
    const max = Number(opts.max) > 0 ? Math.round(Number(opts.max)) : MAX_ITEMS;
    const list = Array.isArray(messages) ? messages : [];
    const all = [];
    let round = 0;
    for (let i = 0; i < list.length; i += 1) {
        const message = list[i];
        if (!message || message.role !== 'user') continue;
        if (message.systemNote || message.app || message.kind === 'model-switch') continue;
        round += 1;
        const text = String(message.content == null ? '' : message.content).replace(/\s+/g, ' ').trim();
        const images = Array.isArray(message.images) ? message.images.length : 0;
        all.push({
            index: i,
            round,
            ts: Number(message.ts) || Number(message.turnStartedAt) || 0,
            text: text || (images ? '（' + images + ' 张图片）' : ''),
        });
    }
    const items = all.length > max ? all.slice(all.length - max) : all;
    return {total: all.length, truncated: all.length > items.length, items};
}

// snapshot: {items: [{index, round, text, ts}], activeIndex}
// opts: {onJump(index)}
export function renderSessionOutline(body, snapshot, opts) {
    if (!body) return;
    const options = opts || {};
    const items = (snapshot && snapshot.items) || [];
    const active = Number(snapshot && snapshot.activeIndex);
    const list = el('div', 'so-list');
    for (let i = 0; i < items.length; i += 1) {
        const item = items[i] || {};
        const index = Number(item.index);
        if (!Number.isFinite(index)) continue;
        const row = el('div', 'sb-row so-row' + (index === active ? ' so-current' : ''));
        row.tabIndex = -1;
        row.dataset.index = String(index);
        row.title = item.text || '';
        row.appendChild(el('span', 'so-num', String(item.round || i + 1)));
        row.appendChild(el('span', 'so-text', oneLine(item.text) || '（图片消息）'));
        const time = shortTime(item.ts);
        if (time) row.appendChild(el('span', 'so-time', time));
        const jump = () => {
            if (typeof options.onJump === 'function') options.onJump(index);
        };
        row.addEventListener('click', () => {
            row.focus({preventScroll: true});
            jump();
        });
        row.addEventListener('keydown', (e) => {
            const rows = [...body.querySelectorAll('.so-row')];
            const at = rows.indexOf(row);
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (at + 1 < rows.length) rows[at + 1].focus();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (at > 0) rows[at - 1].focus();
            } else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                jump();
            }
        });
        list.appendChild(row);
    }
    body.appendChild(list);
}

// 只更新「当前定位」高亮：滚动时避免整表重建
export function syncSessionOutlineActive(body, activeIndex) {
    if (!body) return;
    const active = String(Number(activeIndex));
    for (const row of body.querySelectorAll('.so-row')) {
        row.classList.toggle('so-current', row.dataset.index === active);
    }
}
