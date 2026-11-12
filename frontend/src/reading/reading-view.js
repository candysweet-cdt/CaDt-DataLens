// 阅读视图 DOM 构建（docs/reading-mode.md §3/§5/§6/§14）：
// 全部结构由 JS 构建进 #reading-view 容器，index.html 只放空容器。
// 样式见 reading.css（.rd- 前缀）。

import {minutesFor} from './reading-model.js';

const FONT_FAMILIES = {
    songti: '"SimSun", "宋体", "Noto Serif CJK SC", serif',
    kaiti: '"KaiTi", "楷体", "Noto Serif CJK SC", serif',
    yahei: '"Microsoft YaHei", "微软雅黑", "Noto Sans CJK SC", sans-serif',
    dengxian: '"DengXian", "等线", "Noto Sans CJK SC", sans-serif',
    system: 'system-ui, "Segoe UI", "Microsoft YaHei", sans-serif',
};

export function fontFamilyFor(id) {
    return FONT_FAMILIES[id] || FONT_FAMILIES.songti;
}

export const READING_THEMES = ['auto', 'paper', 'sepia', 'light', 'dark'];

function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
}

function btn(className, text, title) {
    const b = el('button', className, text);
    b.type = 'button';
    if (title) b.title = title;
    return b;
}

function fmtWords(n) {
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + ' 万字';
    return (n || 0) + ' 字';
}

function fmtTime(sec) {
    sec = Math.round(sec || 0);
    if (sec < 60) return sec + ' 秒';
    const m = Math.floor(sec / 60);
    if (m < 60) return m + ' 分钟';
    return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
}

function fmtAgo(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    return Math.floor(diff / 86400000) + ' 天前';
}

// ---- 骨架 ----

export function buildSkeleton(container) {
    container.textContent = '';
    const topbar = el('div', 'rd-topbar');
    const back = btn('rd-btn', '←', '退出阅读 (Esc)');
    const bookTitle = el('span', 'rd-book-title');
    const unitTitle = el('span', 'rd-unit-title');
    const actions = el('div', 'rd-topbar-actions');
    const btnToc = btn('rd-btn', '目录', '目录 (拖动进度条也可打开)');
    const btnBm = btn('rd-btn', '书签', '书签列表');
    const btnSearch = btn('rd-btn', '搜索', '全书搜索 (Ctrl+Shift+F)');
    const btnAa = btn('rd-btn', 'Aa', '排版设置');
    const btnTts = btn('rd-btn', '朗读', '朗读本章');
    const btnFocus = btn('rd-btn', '专注', '专注模式');
    actions.append(btnToc, btnBm, btnSearch, btnAa, btnTts, btnFocus);
    topbar.append(back, bookTitle, unitTitle, actions);

    const body = el('div', 'rd-body');
    const sidebar = el('aside', 'rd-sidebar hidden');
    const tabs = el('div', 'rd-tabs');
    const tabToc = btn('rd-tab active', '目录');
    const tabBm = btn('rd-tab', '书签');
    const tabSearch = btn('rd-tab', '搜索');
    tabs.append(tabToc, tabBm, tabSearch);
    const tocFilter = el('input', 'rd-toc-filter hidden');
    tocFilter.type = 'text';
    tocFilter.placeholder = '过滤目录…';
    const tocPane = el('div', 'rd-pane');
    const bmPane = el('div', 'rd-pane hidden');
    const searchPane = el('div', 'rd-pane hidden');
    sidebar.append(tabs, tocFilter, tocPane, bmPane, searchPane);

    const contentWrap = el('div', 'rd-content-wrap');
    const reader = el('div', 'rd-reader');
    const findbar = el('div', 'rd-findbar hidden');
    const findInput = el('input');
    findInput.type = 'text';
    findInput.placeholder = '本章查找 (Enter 下一个)';
    const findCount = el('span', 'rd-find-count');
    const findPrev = btn('rd-btn', '↑', '上一个 (Shift+Enter)');
    const findNext = btn('rd-btn', '↓', '下一个 (Enter)');
    const findClose = btn('rd-btn', '×', '关闭 (Esc)');
    findbar.append(findInput, findCount, findPrev, findNext, findClose);
    contentWrap.append(reader, findbar);

    const bottombar = el('div', 'rd-bottombar');
    const progressTrack = el('div', 'rd-progress-track');
    const progressFill = el('div', 'rd-progress-fill');
    progressTrack.appendChild(progressFill);
    const progressText = el('span', 'rd-progress-text');
    bottombar.append(progressTrack, progressText);
    body.append(sidebar, contentWrap);

    const focusHint = el('div', 'rd-focus-hint hidden');
    container.append(topbar, body, bottombar, focusHint);

    return {
        topbar, back, bookTitle, unitTitle, btnToc, btnBm, btnSearch, btnAa, btnTts, btnFocus,
        sidebar, tabs, tabToc, tabBm, tabSearch, tocFilter, tocPane, bmPane, searchPane,
        contentWrap, reader, findbar, findInput, findCount, findPrev, findNext, findClose,
        bottombar, progressTrack, progressFill, progressText, focusHint,
    };
}

// ---- 书架（§3.2） ----

export function renderBookshelf(container, data) {
    container.textContent = '';
    const wrap = el('div', 'rd-bookshelf');
    wrap.appendChild(el('h2', 'rd-shelf-title', '阅读模式'));
    if (data.recent && data.recent.length) {
        const sec = el('div', 'rd-shelf-section');
        sec.appendChild(el('h3', '', '最近阅读'));
        for (const b of data.recent) {
            const card = el('button', 'rd-book-card rd-recent-card');
            card.type = 'button';
            const cover = el('span', 'rd-book-cover', (b.title || '?').slice(0, 1));
            const info = el('span', 'rd-book-info');
            const t = el('span', 'rd-book-name', b.title || b.key);
            const meta = el('span', 'rd-book-meta',
                Math.round((b.progress || 0) * 100) + '% · ' + fmtAgo(b.updatedAt));
            info.append(t, meta);
            card.append(cover, info);
            card.addEventListener('click', () => data.onOpen(b));
            sec.appendChild(card);
        }
        wrap.appendChild(sec);
    }
    const detected = el('div', 'rd-shelf-section');
    detected.appendChild(el('h3', '', '当前工作区检测到 ' + (data.suggestions || []).length + ' 本书'));
    if (!data.suggestions || !data.suggestions.length) {
        detected.appendChild(el('p', 'rd-shelf-empty', '没有找到可阅读的目录。把小说/资料整理到一个目录里，再在这里打开。'));
    }
    for (const s of data.suggestions || []) {
        const card = el('button', 'rd-book-card');
        card.type = 'button';
        const cover = el('span', 'rd-book-cover', (s.name || '?').slice(0, 1));
        const info = el('span', 'rd-book-info');
        info.append(
            el('span', 'rd-book-name', s.name),
            el('span', 'rd-book-meta', (s.bookFiles ?? s.books ?? 0) + ' 个文件 · 约 ' + fmtWords(s.estWords) + ' / 未读'),
        );
        card.append(cover, info);
        card.title = s.root;
        card.addEventListener('click', () => data.onOpen({key: s.root, root: s.root, title: s.name}));
        detected.appendChild(card);
    }
    wrap.appendChild(detected);
    const actions = el('div', 'rd-shelf-actions');
    const browse = btn('tb-btn', '打开其他文件夹…');
    browse.addEventListener('click', () => data.onBrowse());
    actions.appendChild(browse);
    wrap.appendChild(actions);
    container.appendChild(wrap);
}

// ---- 详情页（§3.2） ----

export function renderDetail(container, data) {
    container.textContent = '';
    const wrap = el('div', 'rd-detail');
    wrap.appendChild(el('h2', 'rd-shelf-title', data.title || '未命名'));
    if (data.author) wrap.appendChild(el('p', 'rd-detail-author', '作者：' + data.author));
    if (data.intro) wrap.appendChild(el('p', 'rd-detail-intro', data.intro));
    const meta = el('p', 'rd-detail-meta');
    meta.textContent = [
        data.chapterCount + ' 章',
        fmtWords(data.totalWords),
        '预计 ' + fmtTime((data.totalWords || 0) / 400 * 60),
        '已读 ' + Math.round((data.progress || 0) * 100) + '%',
    ].join(' · ');
    wrap.appendChild(meta);
    const actions = el('div', 'rd-detail-actions');
    const cont = btn('tb-btn primary', data.progress > 0 ? '继续阅读' : '开始阅读');
    cont.addEventListener('click', data.onContinue);
    actions.appendChild(cont);
    if (data.progress > 0) {
        const restart = btn('tb-btn', '从头开始');
        restart.addEventListener('click', data.onRestart);
        actions.appendChild(restart);
    }
    const inExplorer = btn('tb-btn', '在资源管理器中显示');
    inExplorer.addEventListener('click', data.onShowInFolder);
    actions.appendChild(inExplorer);
    wrap.appendChild(actions);

    // 结构设置（§4.3 用户覆盖）
    const struct = el('div', 'rd-detail-struct');
    struct.appendChild(el('h3', '', '结构设置'));
    const row1 = el('label', 'rd-struct-row');
    row1.append(el('span', '', '章级标题'));
    const levelSel = el('select');
    for (const [v, label] of [['', '自动'], ['1', 'h1'], ['2', 'h2'], ['3', 'h3']]) {
        const opt = el('option', '', label);
        opt.value = v;
        levelSel.appendChild(opt);
    }
    levelSel.value = data.chapterLevel ? String(data.chapterLevel) : '';
    levelSel.addEventListener('change', () => data.onChapterLevel(levelSel.value ? parseInt(levelSel.value, 10) : null));
    row1.appendChild(levelSel);
    struct.appendChild(row1);
    const row2 = el('label', 'rd-struct-row');
    row2.append(el('span', '', '文档树默认'));
    const treeCheck = el('input');
    treeCheck.type = 'checkbox';
    treeCheck.checked = !!data.treeMode;
    treeCheck.addEventListener('change', () => data.onTreeMode(treeCheck.checked));
    row2.appendChild(treeCheck);
    struct.appendChild(row2);
    // 忽略目录（§4.3 用户覆盖，逗号分隔）
    const row3 = el('label', 'rd-struct-row');
    row3.append(el('span', '', '忽略目录'));
    const ignoreInput = el('input');
    ignoreInput.type = 'text';
    ignoreInput.placeholder = '如：backup, 草稿';
    ignoreInput.value = (data.ignoreDirs || []).join(', ');
    row3.appendChild(ignoreInput);
    const applyIgnore = btn('rd-btn', '应用', '按忽略目录重扫本书');
    applyIgnore.addEventListener('click', () => {
        const list = ignoreInput.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        data.onIgnoreDirs(list);
    });
    row3.appendChild(applyIgnore);
    struct.appendChild(row3);
    const clearBtn = btn('tb-btn', '清空本书进度');
    clearBtn.addEventListener('click', data.onClearProgress);
    struct.appendChild(clearBtn);
    wrap.appendChild(struct);
    container.appendChild(wrap);
}

// ---- 目录树（§5） ----

// renderToc 渲染目录树。nodes: 模型 top；activeId 高亮；depth 展开层级；
// cap 限制渲染节点总数（>300 显示「显示更多」），onShowMore 提升上限重渲染。
export function renderToc(container, data) {
    container.textContent = '';
    const cap = data.cap || 300;
    if (data.filter) {
        const matches = [];
        collectMatches(data.nodes, data.filter.toLowerCase(), [], matches, 200);
        if (!matches.length) {
            container.appendChild(el('p', 'rd-toc-empty', '没有匹配的目录项'));
            return;
        }
        const list = el('div', 'rd-toc-list');
        for (const path of matches) {
            const row = el('button', 'rd-toc-row');
            row.type = 'button';
            row.appendChild(el('span', 'rd-toc-title', path.map((n) => n.title).join(' / ')));
            row.addEventListener('click', () => data.onJump(path[path.length - 1]));
            list.appendChild(row);
        }
        container.appendChild(list);
        return;
    }
    const list = el('div', 'rd-toc-list');
    let rendered = 0;
    let truncated = false;
    const walk = (nodes, parent, depth) => {
        for (const node of nodes) {
            if (rendered >= cap) {
                truncated = true;
                return;
            }
            rendered++;
            const hasChildren = node.children && node.children.length;
            const row = el('div', 'rd-toc-row rd-toc-d' + Math.min(depth, 4) +
                (node.id === data.activeId ? ' active' : '') +
                (node.renderable ? '' : ' rd-toc-group'));
            const label = el('button', 'rd-toc-title');
            label.type = 'button';
            label.appendChild(el('span', '', node.title));
            if (node.words) {
                label.appendChild(el('span', 'rd-toc-words', fmtWords(node.words)));
            }
            label.title = node.words ? '约 ' + minutesFor(node.words) + ' 分钟' : node.title;
            label.addEventListener('click', () => {
                if (data.onJump) data.onJump(node);
            });
            row.appendChild(label);
            if (hasChildren && depth < data.depth) {
                const childBox = el('div', 'rd-toc-children');
                row.appendChild(childBox);
                walk(node.children, childBox, depth + 1);
            } else if (hasChildren) {
                const toggle = btn('rd-toc-toggle', '▸', '展开');
                toggle.addEventListener('click', () => {
                    if (toggle.textContent === '▸') {
                        toggle.textContent = '▾';
                        const childBox = el('div', 'rd-toc-children');
                        row.appendChild(childBox);
                        walk(node.children, childBox, depth + 1);
                    } else {
                        toggle.textContent = '▸';
                        const box = row.querySelector('.rd-toc-children');
                        if (box) box.remove();
                    }
                });
                row.appendChild(toggle);
            }
            parent.appendChild(row);
        }
    };
    walk(data.nodes, list, 0);
    container.appendChild(list);
    if (truncated && data.onShowMore) {
        const more = btn('rd-toc-more', '显示更多', '目录项过多，已截断显示');
        more.addEventListener('click', data.onShowMore);
        container.appendChild(more);
    }
}

function collectMatches(nodes, filter, path, out, max) {
    if (out.length >= max) return;
    for (const n of nodes) {
        const here = path.concat([n]);
        if (n.title && n.title.toLowerCase().includes(filter)) {
            out.push(here);
            if (out.length >= max) return;
        }
        if (n.children) collectMatches(n.children, filter, here, out, max);
    }
}

// 滚动当前节点到可视区
export function scrollTocToActive(container) {
    const active = container.querySelector('.rd-toc-row.active');
    if (active && active.scrollIntoView) {
        active.scrollIntoView({block: 'nearest'});
    }
}

// ---- 书签（§8.4） ----

export function renderBookmarks(container, data) {
    container.textContent = '';
    if (!data.bookmarks.length) {
        container.appendChild(el('p', 'rd-toc-empty', '还没有书签。Ctrl+D 或顶栏按钮添加。'));
        return;
    }
    const list = el('div', 'rd-bm-list');
    for (const bm of data.bookmarks) {
        const row = el('div', 'rd-bm-row');
        const main = btn('rd-bm-main');
        main.type = 'button';
        main.append(
            el('span', 'rd-bm-title', bm.title || bm.rel),
            el('span', 'rd-bm-excerpt', bm.excerpt || ''),
            el('span', 'rd-bm-time', fmtAgo(bm.createdAt)),
        );
        main.addEventListener('click', () => data.onGo(bm));
        const del = btn('rd-bm-del', '删除');
        del.addEventListener('click', () => data.onDelete(bm));
        row.append(main, del);
        list.appendChild(row);
    }
    container.appendChild(list);
}

// ---- 全书搜索结果（§11.2） ----

export function renderSearchResults(container, data) {
    container.textContent = '';
    if (data.status) {
        const row = el('div', 'rd-search-status-row');
        row.appendChild(el('p', 'rd-search-status', data.status));
        if (data.cancellable && data.onCancel) {
            const cancel = btn('rd-btn', '取消');
            cancel.addEventListener('click', data.onCancel);
            row.appendChild(cancel);
        }
        container.appendChild(row);
    }
    if (!data.result) return;
    const res = data.result;
    if (!res.hits.length) {
        container.appendChild(el('p', 'rd-toc-empty', '没有找到「' + data.query + '」'));
        return;
    }
    const head = el('p', 'rd-search-status', '共 ' + res.hits.length + ' 处命中' +
        (res.truncated ? '（已截断）' : '') + ' · ' + res.elapsedMs + ' ms');
    container.appendChild(head);
    // 按 文件/单元 分组
    const groups = new Map();
    for (const hit of res.hits) {
        const key = hit.rel + '#' + hit.unitOffset;
        if (!groups.has(key)) groups.set(key, {rel: hit.rel, unitOffset: hit.unitOffset, unitTitle: hit.unitTitle, hits: []});
        groups.get(key).hits.push(hit);
    }
    for (const g of groups.values()) {
        const group = el('div', 'rd-search-group');
        const title = btn('rd-search-group-title', (g.unitTitle || g.rel) + '（' + g.hits.length + '）');
        title.addEventListener('click', () => data.onGo(g.rel, g.unitOffset, g.hits[0], 0));
        group.appendChild(title);
        g.hits.forEach((hit, i) => {
            const row = btn('rd-search-hit');
            row.type = 'button';
            const ctx = el('span', 'rd-search-ctx');
            ctx.append(
                el('span', 'rd-search-before', hit.before),
                el('span', 'rd-search-match', hit.match),
                el('span', 'rd-search-after', hit.after),
            );
            row.appendChild(ctx);
            row.addEventListener('click', () => data.onGo(g.rel, g.unitOffset, hit, i));
            group.appendChild(row);
        });
        container.appendChild(group);
    }
}

// ---- 排版设置弹层（§6.2/§14.1） ----

export function renderSettingsPopover(popover, data) {
    popover.textContent = '';
    popover.classList.add('rd-aa-pop');
    const settings = data.settings;
    const rows = [];

    const addSelect = (label, key, options) => {
        const row = el('label', 'rd-aa-row');
        row.append(el('span', '', label));
        const sel = el('select');
        for (const [v, text] of options) {
            const opt = el('option', '', text);
            opt.value = v;
            sel.appendChild(opt);
        }
        sel.value = String(settings[key]);
        sel.addEventListener('change', () => data.onChange(key, sel.value));
        row.appendChild(sel);
        rows.push(row);
        return sel;
    };
    const addRange = (label, key, min, max, step, unit) => {
        const row = el('label', 'rd-aa-row');
        row.append(el('span', '', label));
        const input = el('input');
        input.type = 'range';
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        input.value = String(settings[key]);
        const val = el('span', 'rd-aa-val', settings[key] + (unit || ''));
        input.addEventListener('input', () => {
            val.textContent = input.value + (unit || '');
            data.onChange(key, input.value);
        });
        row.append(input, val);
        rows.push(row);
    };
    const addCheck = (label, key) => {
        const row = el('label', 'rd-aa-row');
        row.append(el('span', '', label));
        const input = el('input');
        input.type = 'checkbox';
        input.checked = !!settings[key];
        input.addEventListener('change', () => data.onChange(key, input.checked));
        row.appendChild(input);
        rows.push(row);
    };

    addSelect('字体', 'readingFont', [
        ['songti', '宋体'], ['kaiti', '楷体'], ['yahei', '微软雅黑'], ['dengxian', '等线'], ['system', '跟随系统'],
    ]);
    addRange('字号', 'readingFontSize', 16, 28, 1, ' px');
    addRange('行高', 'readingLineHeight', 1.6, 2.2, 0.1, '');
    addRange('页宽', 'readingPageWidth', 32, 56, 1, ' em');
    addRange('段距', 'readingParagraphGap', 0, 1.2, 0.1, ' em');
    addCheck('段首缩进', 'readingIndent');
    addSelect('主题', 'readingTheme', [
        ['auto', '跟随应用'], ['paper', '纸白'], ['sepia', '护眼'], ['light', '纯白'], ['dark', '夜间'],
    ]);
    addCheck('合并段内单换行', 'readingJoinSoftLines');
    addCheck('连续滚动', 'readingContinuous');
    addCheck('分页模式', 'readingPaged');
    addSelect('朗读语速', 'readingTtsRate', [
        ['0.5', '0.5x'], ['0.75', '0.75x'], ['1', '1x'], ['1.25', '1.25x'], ['1.5', '1.5x'], ['2', '2x'],
    ]);
    addCheck('朗读自动续章', 'readingTtsAutoNext');
    for (const r of rows) popover.appendChild(r);
}

// ---- 阅读统计弹层（§8.5） ----

export function renderStats(container, data) {
    container.textContent = '';
    container.appendChild(el('h3', 'rd-stats-title', '阅读统计'));
    const grid = el('div', 'rd-stats-grid');
    const items = [
        ['总时长', fmtTime(data.totalSec)],
        ['今日', fmtTime(data.todaySec)],
        ['连续天数', (data.streak || 0) + ' 天'],
        [' sessions ', (data.sessions || 0) + ' 次'],
    ];
    for (const [label, value] of items) {
        const cell = el('div', 'rd-stats-cell');
        cell.append(el('span', 'rd-stats-label', label.trim()), el('span', 'rd-stats-value', value));
        grid.appendChild(cell);
    }
    container.appendChild(grid);
    // 最近 7 天柱状图（纯 CSS）
    if (data.daily && Object.keys(data.daily).length) {
        const chart = el('div', 'rd-stats-chart');
        const max = Math.max(...Object.values(data.daily), 1);
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
            const sec = data.daily[key] || 0;
            const bar = el('div', 'rd-stats-bar');
            const fill = el('div', 'rd-stats-bar-fill');
            fill.style.height = Math.max(4, Math.round(sec / max * 100)) + '%';
            fill.title = key + '：' + fmtTime(sec);
            bar.appendChild(fill);
            bar.appendChild(el('span', 'rd-stats-bar-label', String(d.getDate())));
            chart.appendChild(bar);
        }
        container.appendChild(chart);
    }
}
