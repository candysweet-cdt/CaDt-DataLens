// git-graph.js：底部面板「Git 图谱」视图的域模块（factory + 显式依赖注入）。
// 图形布局交给 git 自己（`git log --graph`，graph.c 权威实现）：Go 侧解析字形流并
// 压缩成 flow 折线（paths[{f, p:[charPos, yFrac, ...]}]），这里只负责渲染 SVG、
// 提交列表虚拟滚动、双搜索框（分支 / 提交）、ref 树过滤、
// 详情面板（IDEA 式：正文 + 作者行 + ref 徽章 + 分支计数 + 本次变动文件树）与
// 写操作（签出 / cherry-pick / 重置 / 新建分支，右键菜单入口，对话框在 git-graph-dialogs.js）。
// 写操作是用户主动 UI 动作：走只读锁 + 确认弹窗，不涉 AI 审批链。
import {iconSvg} from '../core/icons.js';
import {createInput, createSelect} from '../core/form-controls.js';
import {createFileIcon} from '../core/fileicons.js';
import {GITGRAPH_PANE_WIDTHS_KEY, GITGRAPH_INFO_HEIGHT_KEY} from '../core/storage-keys.js';
import {kvGet, kvGetJson, kvSet, kvSetJson} from '../core/kv-store.js';
import {createGitGraphDialogs} from './git-graph-dialogs.js';

const ROW_H = 26;        // 提交行高（px）
const LANE_W = 16;       // 每条泳道宽（px）
const LANE_PAD = 8;      // 泳道区左右留白
const DEFAULT_LIMIT = 500;

// 目录未就绪时的自动重试（启动恢复期 applyDockView 可能早于 workspaceFolder 赋值）：
// 每 200ms 试一次、最多 15 次（约 3s），覆盖工作区恢复窗口又不会永久空转。
const DIR_RETRY_DELAY_MS = 200;
const DIR_RETRY_MAX = 15;

// 目录图标：统一走注册表（原散落 SVG 与 explorer 同造型，已收编 core/icons.js 的 folder 键）；
// 文件图标走 createFileIcon（core/fileicons.js 主题解析链），「本次变动」树与文件树显示同一套图标
const FOLDER_SVG = iconSvg('folder');

// diff-tree 状态 → git 树状态类（.git-file-row 的 FILESTATUS 映射同源）与悬停文案
const GIT_STATUS_CLS = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'renamed', T: 'modified', U: 'conflict' };
const GIT_STATUS_LABEL = { A: '新增', M: '修改', D: '删除', R: '重命名', C: '复制', T: '类型变更', U: '冲突' };

// flow 配色：按 flow 色号循环取主题色板（CSS 变量在 style.css 定义，12 色降低撞色概率）
const LANE_COLORS = [
    'var(--gg-lane-0)', 'var(--gg-lane-1)', 'var(--gg-lane-2)', 'var(--gg-lane-3)',
    'var(--gg-lane-4)', 'var(--gg-lane-5)', 'var(--gg-lane-6)', 'var(--gg-lane-7)',
    'var(--gg-lane-8)', 'var(--gg-lane-9)', 'var(--gg-lane-10)', 'var(--gg-lane-11)',
];
// flow 色号从 1 起（Go 侧解析器约定）
function laneColor(flow) {
    return LANE_COLORS[(flow - 1 + LANE_COLORS.length * 16) % LANE_COLORS.length];
}

// ===== 泳道 SVG 几何（纯函数，可单测） =====

// 每个字形占 HALF_W 宽的网格列（git --graph 字形矩阵的半泳道格）。
const HALF_W = LANE_W / 2; // 8

// glyphX 返回字形 pos 的「竖线 x」：竖线画在格子右边界（Gitea svgcontainer.tmpl 同款），
// 斜线/横线以此为连接锚点，相邻字形天然首尾相接。
export function glyphX(pos) {
    return LANE_PAD + (pos + 1) * HALF_W;
}

// laneSvgWidth 返回容纳 laneCount 条泳道的 SVG 宽度。
export function laneSvgWidth(laneCount) {
    return LANE_PAD * 2 + Math.max(1, laneCount) * LANE_W;
}

// slant 生成一条直线斜线（Gitea svgcontainer.tmpl 同款，也贴合 git 文本字形）。
// 曾用 S 形贝塞尔（控制点压向终点）追求「IDEA 观感」，但那让横向位移集中在行首：
// 线先快速横移一格再竖直，形成台阶/凹陷（作者反馈「右边几条线没必要凹进去一块」）。
// 直线让分叉/汇入在整行内均匀过渡，分支线更接近「直上」，不再有突兀的弯折。
function slant(x0, y0, x1, y1) {
    return `M${x0},${y0} L${x1},${y1}`;
}

// buildLaneSvg 渲染一页提交的泳道 SVG（新→旧，行 i 的 y 中心 = i*ROW_H + ROW_H/2）。
// 布局数据来自 Go 侧对 `git log --graph` 字形流的解析（graph.c 权威算法，graphglyph.go）：
// 每个提交组（提交行 + 关系行）带 Rows 与组内字形表，前端按 Gitea svgcontainer.tmpl
// 的映射逐字形直译成 SVG 段——竖线在格右界、斜线跨 2 格、横线贴底边跨 2 格，
// 相邻字形天然首尾相接，复合字形（`| |_|_|/`、`|/| | |`）全覆盖；组内行高按
// Rows 等分压缩（IDEA 式过渡行折叠）。同一条分支线一个 flow 色号贯穿。
// 返回 <svg> 的 innerHTML 字符串（不含 <svg> 壳）。
export function buildLaneSvg(commits, laneCount) {
    const width = laneSvgWidth(laneCount);
    const height = commits.length * ROW_H;
    const parts = [];

    for (let i = 0; i < commits.length; i++) {
        const c = commits[i];
        const yTop = i * ROW_H;
        const gh = c.rows > 0 ? ROW_H / c.rows : ROW_H; // 组内每行高
        const seg = (d, flow) => parts.push(`<path d="${d}" class="gg-line" stroke="${laneColor(flow)}"/>`);

        for (const g of (c.glyphs || [])) {
            const x = glyphX(g.p);
            const y0 = yTop + g.r * gh;
            const y1 = y0 + gh;
            switch (g.c) {
                case '|':
                case '*':
                    seg(`M${x},${y0} L${x},${y1}`, g.f);
                    break;
                case '\\': // 左格左界 → 右格右界（下一行 pos+1 相接），直线斜线
                    seg(slant(glyphX(g.p - 1), y0, glyphX(g.p + 1), y1), g.f);
                    break;
                case '/': // 右格右界 → 左格左界（下一行 pos-1 相接），直线斜线
                    seg(slant(glyphX(g.p + 1), y0, glyphX(g.p - 1), y1), g.f);
                    break;
                case '_': // 底边横线：本格左界 → 右格右界（跨 2 格，与右侧字形相接）
                    seg(`M${glyphX(g.p - 1)},${y1} L${glyphX(g.p + 1)},${y1}`, g.f);
                    break;
                case '-':
                case '.': // 半格横线（八叉合并收尾）
                    seg(`M${glyphX(g.p - 1)},${y1} L${x},${y1}`, g.f);
                    break;
                default:
                    break;
            }
        }

        // 圆点：提交行的圆点在组内第一行的行中
        parts.push(`<circle cx="${glyphX(c.dotPos)}" cy="${yTop + gh / 2}" r="4" class="gg-dot" fill="${laneColor(c.dotFlow)}"/>`);
    }
    return `<svg class="gg-lane-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">${parts.join('')}</svg>`;
}

// parseCommitRefs 把 %D 装饰器拆成 ref 徽章列表（纯函数，可单测）。
// "HEAD -> master, origin/master, tag: v1.0" → [{kind:'head',name:'HEAD'},
//   {kind:'local',name:'master'}, {kind:'remote',name:'origin/master'}, {kind:'tag',name:'v1.0'}]
export function parseCommitRefs(refs) {
    const chips = [];
    for (const raw of String(refs || '').split(',')) {
        const s = raw.trim();
        if (!s) continue;
        if (s.startsWith('tag:')) {
            const name = s.slice(4).trim();
            if (name) chips.push({kind: 'tag', name});
        } else if (s.startsWith('HEAD ->')) {
            chips.push({kind: 'head', name: 'HEAD'});
            const b = s.slice(7).trim();
            if (b) chips.push({kind: 'local', name: b});
        } else if (s === 'HEAD') {
            chips.push({kind: 'head', name: 'HEAD'});
        } else {
            chips.push({kind: s.indexOf('origin/') === 0 ? 'remote' : 'local', name: s});
        }
    }
    return chips;
}

// buildCommitMatcher 根据搜索选项构造提交匹配器（纯函数，可单测）。
// opts: {query, regex, caseSensitive, user, date, now}；返回 (commit) => boolean。
// 正则无效时返回 {error} 由调用方提示，不抛异常打断渲染。
export function buildCommitMatcher(opts) {
    const query = String(opts.query || '').trim();
    const caseSensitive = !!opts.caseSensitive;
    const user = String(opts.user || '').trim().toLowerCase();
    const date = String(opts.date || '');
    const now = Number(opts.now) || Date.now();
    let test;
    if (!query) {
        test = () => true;
    } else if (opts.regex) {
        let re;
        try {
            re = new RegExp(query, caseSensitive ? '' : 'i');
        } catch (e) {
            return {error: '正则表达式无效：' + (e && e.message ? e.message : e)};
        }
        test = (s) => re.test(s);
    } else {
        const q = caseSensitive ? query : query.toLowerCase();
        const fold = (s) => caseSensitive ? String(s || '') : String(s || '').toLowerCase();
        test = (s) => fold(s).includes(q);
    }
    // 日期预设：用 commit 的 YYYY-MM-DD 前缀与 now 比较（date 字段是格式化字符串）
    const dayMs = 24 * 60 * 60 * 1000;
    const dateFrom = date === 'today' ? new Date(now).setHours(0, 0, 0, 0)
        : date === '7d' ? now - 7 * dayMs
        : date === '30d' ? now - 30 * dayMs
        : date === '1y' ? now - 365 * dayMs
        : null;
    return {match: (c) => {
        if (user && !((c.author || '').toLowerCase().includes(user) || (c.email || '').toLowerCase().includes(user))) return false;
        if (dateFrom != null) {
            const ts = Date.parse(String(c.date || '').replace(' ', 'T'));
            if (!Number.isFinite(ts) || ts < dateFrom) return false;
        }
        if (!query) return true;
        return test(c.subject || '') || test(c.sha || '') || test(c.author || '') || test(c.email || '') || test(c.refs || '');
    }};
}

// fileTreeFromChanges 把平铺的文件变动列表组目录树（纯函数，可单测）。
// 返回根级节点数组：{type:'dir', name, path, children[]} | {type:'file', name, path, status, oldPath}。
// 目录在前、同类型按名称升序。
// rootName 非空时，额外套一层「工作区顶层目录」节点（JetBrains 式：最外层是仓库名，
// 其下才是 docs/frontend 等），返回的数组只有一个根；不传则保持旧行为（匿名根被丢弃）。
export function fileTreeFromChanges(files, rootName) {
    const root = {type: 'dir', name: rootName || '', path: '', children: [], root: !!rootName};
    for (const f of files || []) {
        const parts = String(f.path || '').split('/');
        let cur = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const seg = parts[i];
            if (!seg) continue;
            const p = cur.path ? cur.path + '/' + seg : seg;
            let child = null;
            for (const n of cur.children) {
                if (n.type === 'dir' && n.name === seg) { child = n; break; }
            }
            if (!child) {
                child = {type: 'dir', name: seg, path: p, children: []};
                cur.children.push(child);
            }
            cur = child;
        }
        cur.children.push({
            type: 'file',
            name: parts[parts.length - 1] || f.path,
            path: f.path,
            status: f.status || '',
            oldPath: f.oldPath || '',
        });
    }
    const sortRec = (node) => {
        node.children.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
        });
        for (const ch of node.children) {
            if (ch.type === 'dir') sortRec(ch);
        }
    };
    sortRec(root);
    return rootName ? [root] : root.children;
}

// graphPageFailed 判定一次 GitGraphCommits 返回是否算「加载失败」（纯函数，可单测）。
// Go 侧 available 在跑 git log 之前就置 true（internal/gitinfo/graph.go:79），坏 ref /
// git log 失败只写 reason 不撤 available；因此「有 reason 且零提交」也要按失败处理，
// 否则前端会把坏 ref 当成功收尾：initialized=true、列表空，连刷新都救不回（currentRef 粘着坏值）。
export function graphPageFailed(page) {
    if (!page || !page.available) return true;
    const commits = Array.isArray(page.commits) ? page.commits : [];
    return !commits.length && !!page.reason;
}

// buildSkeletonHtml 生成首次加载的骨架屏内部 HTML（纯静态、可单测）。
// 三栏结构与 .gg-body 对齐；条块宽度错落，避免整齐得像表格。
// 纯字符串、无用户输入，用 innerHTML 一次性注入是安全的（同 buildLaneSvg）。
export function buildSkeletonHtml() {
    const refs = [72, 58, 80, 64, 70, 52].map((w, i) =>
        `<div class="gg-sk-line" style="width:${w}%;margin-left:${i === 0 ? 0 : 14}px"></div>`).join('');
    const rows = [64, 78, 55, 70, 82, 60, 73, 68, 58, 76, 66, 71, 62, 80].map((w) =>
        `<div class="gg-sk-row"><span class="gg-sk-dot"></span><span class="gg-sk-bar" style="width:${w}%"></span></div>`).join('');
    const detail = [
        '90%;height:14px', '70%;height:10px', '80%;height:10px', '55%;height:22px',
    ].map((s) => `<div class="gg-sk-block" style="width:${s}"></div>`).join('');
    return '<div class="gg-sk-refs">' + refs + '</div>' +
        '<div class="gg-sk-commits">' + rows + '</div>' +
        '<div class="gg-sk-detail">' + detail + '</div>';
}

// ===== 三栏宽度拖动 =====
const REFS_MIN = 120;       // ref 树最小宽
const DETAIL_MIN = 180;     // 详情最小宽
const COMMITS_MIN = 200;    // 中间提交列表最小宽（两条分割条各占 4px，共 8px）
const SPLITTERS_W = 8;
const PANE_W_KEY = GITGRAPH_PANE_WIDTHS_KEY;

// clampPaneWidth 把拖动请求的宽度限制在 [min, max] 内（纯函数，可单测）。
// 非有限值回落到 min；max < min 时也回落到 min（窗口太窄的退化情形）。
export function clampPaneWidth(requested, min, max) {
    if (!Number.isFinite(requested)) return min;
    if (max < min) return min;
    return Math.min(max, Math.max(min, requested));
}

// ===== 域模块 =====

export function createGitGraph(ctx) {
    const state = {
        refs: null,
        commits: [],
        laneCount: 0,
        hasMore: false,
        nextSkip: 0,
        loading: false,
        currentRef: '',       // 空串 = 当前 HEAD
        selectedSha: '',
        refFilter: '',        // 左栏分支过滤词
        searchRegex: false,      // 提交搜索：正则模式
        searchCaseSensitive: false, // 提交搜索：区分大小写
        userFilter: '',          // 提交搜索：作者筛选（author 或 email）
        dateFilter: '',          // 提交搜索：日期筛选（today/7d/30d/1y）
        expandedGroups: {local: true, remote: false, tags: false, worktrees: false},
        initialized: false,
        loadedDir: '',        // 上次成功加载用的 git 目录：工作区/仓库变了要让 initialized 失效
        refsW: 180,     // 左栏 ref 树宽（可拖动）
        detailW: 280,   // 右栏详情宽（可拖动）
        filesCache: new Map(),   // sha → 文件变动列表（LRU 上限 FILES_CACHE_MAX）
        fileCollapse: new Set(), // 文件树折叠的目录路径
    };
    const FILES_CACHE_MAX = 100;

    // 对话框域（新建分支 / 重置 / 签出冲突）：只暴露它们需要的宿主能力
    const dialogs = createGitGraphDialogs({
        get backend() { return ctx.backend; },
        get flash() { return ctx.flash; },
        get state() { return state; },
        gitDir,
    });

    let els = null; // {root, body, refsCol, refTree, rightCol, commitWrap, laneCol, commitList, detail, hint, filterInput, branchFilter, skeleton}
    let resizeWatched = false;
    let inflightReload = null; // 进行中的 reload()：并发 show() 复用它，避免后一次被 loading 守卫吞掉
    let dirRetryTimer = 0;     // 目录未就绪时的重试定时器
    let dirRetry = 0;          // 已重试次数（有上限，避免永久空转）

    // 栏宽持久化：读用 try/catch 兜底（隐私模式 / 损坏值），写尽力而为
    function loadPaneWidths() {
        const v = kvGetJson(PANE_W_KEY, null);
        if (!v) return;
        if (Number.isFinite(v.refsW)) state.refsW = v.refsW;
        if (Number.isFinite(v.detailW)) state.detailW = v.detailW;
    }
    function savePaneWidths() {
        // 写不进也不提示：栏宽是纯装饰性偏好，本次会话内仍然生效
        kvSetJson(PANE_W_KEY, {refsW: state.refsW, detailW: state.detailW});
    }
    // 把当前栏宽应用到 DOM（CSS 变量），并按容器实际宽度收敛，避免窄窗口下中间栏被挤没
    function applyPaneWidths() {
        if (!els || !els.body) return;
        const total = els.body.clientWidth;
        const maxRefs = total > 0 ? clampPaneWidth(total - SPLITTERS_W - COMMITS_MIN - state.detailW, REFS_MIN, total) : state.refsW;
        const refsW = clampPaneWidth(state.refsW, REFS_MIN, maxRefs);
        const maxDetail = total > 0 ? clampPaneWidth(total - SPLITTERS_W - COMMITS_MIN - refsW, DETAIL_MIN, total) : state.detailW;
        const detailW = clampPaneWidth(state.detailW, DETAIL_MIN, maxDetail);
        els.body.style.setProperty('--gg-refs-w', refsW + 'px');
        els.body.style.setProperty('--gg-detail-w', detailW + 'px');
    }

    // ---- 初始化 DOM ----
    function ensureEls() {
        if (els) return els;
        const root = document.getElementById('git-graph-view');
        if (!root) return null;
        root.innerHTML = '';
        root.classList.add('gg-root');

        // 主体：ref 树（含分支过滤头）| 提交列表（含提交搜索头）| 详情
        const body = document.createElement('div');
        body.className = 'gg-body';

        // 左栏：分支过滤 + ref 树
        const refsCol = document.createElement('div');
        refsCol.className = 'gg-refs';
        const refsHead = document.createElement('div');
        refsHead.className = 'gg-col-head';
        const branchFilter = createInput({
            className: 'gg-filter gg-filter-col',
            placeholder: '过滤分支…',
            spellcheck: false,
            autocomplete: 'off',
            onInput: () => { state.refFilter = branchFilter.value || ''; renderRefTree(); },
        }).element;
        refsHead.appendChild(branchFilter);
        const refTree = document.createElement('div');
        refTree.className = 'gg-refs-tree';
        refsCol.append(refsHead, refTree);

        // 右区：提交搜索头（延伸到详情上方，边界处竖分割线）+ 提交列表 | 分割条 | 详情。
        // 头部横跨提交列与详情列：未选提交时详情顶部不再是断掉的一截
        const rightCol = document.createElement('div');
        rightCol.className = 'gg-right';
        const commitsHead = document.createElement('div');
        commitsHead.className = 'gg-col-head gg-right-head';
        const headInner = document.createElement('div');
        headInner.className = 'gg-head-inner';
        const filterInput = createInput({
            className: 'gg-filter gg-filter-col',
            placeholder: '搜索提交（文本或哈希）…',
            spellcheck: false,
            autocomplete: 'off',
            onInput: () => { filteredCache = null; renderCommitList(true); },
        }).element;

        // 搜索框右侧两个开关：正则（.*）/ 区分大小写（大小双环），均为 SVG 图标按钮
        const regexBtn = mkToggleBtn('regex', '正则表达式', () => {
            state.searchRegex = !state.searchRegex;
            regexBtn.classList.toggle('active', state.searchRegex);
            regexBtn.setAttribute('aria-pressed', String(state.searchRegex));
            filteredCache = null; renderCommitList(true);
        });
        const caseBtn = mkToggleBtn('case-sensitive', '区分大小写', () => {
            state.searchCaseSensitive = !state.searchCaseSensitive;
            caseBtn.classList.toggle('active', state.searchCaseSensitive);
            caseBtn.setAttribute('aria-pressed', String(state.searchCaseSensitive));
            filteredCache = null; renderCommitList(true);
        });
        const searchBox = document.createElement('div');
        searchBox.className = 'gg-search-box';
        searchBox.append(filterInput, regexBtn, caseBtn);

        // 三个筛选下拉：分支（切换查看该分支历史）/ 用户（作者）/ 日期（时间范围）。
        // 分支选项由 loadRefs 填充；用户选项由 loadCommits 填充；日期是固定预设。
        const branchSel = createSelect({
            className: 'gg-filter-select',
            options: [{value: '', label: '分支'}],
            title: '按分支查看历史',
            onChange: (e) => {
                const ref = e.target.value;
                loadCommits(ref);
            },
        }).element;
        const userSel = createSelect({
            className: 'gg-filter-select',
            options: [{value: '', label: '用户'}],
            title: '按作者筛选',
            onChange: (e) => { state.userFilter = e.target.value; filteredCache = null; renderCommitList(true); },
        }).element;
        const dateSel = createSelect({
            className: 'gg-filter-select',
            options: [
                {value: '', label: '日期'},
                {value: 'today', label: '今天'},
                {value: '7d', label: '最近 7 天'},
                {value: '30d', label: '最近 30 天'},
                {value: '1y', label: '最近一年'},
            ],
            title: '按日期筛选',
            onChange: (e) => { state.dateFilter = e.target.value; filteredCache = null; renderCommitList(true); },
        }).element;
        const filterBar = document.createElement('div');
        filterBar.className = 'gg-filter-bar';
        filterBar.append(branchSel, userSel, dateSel);

        const headActions = document.createElement('div');
        headActions.className = 'gg-col-actions';
        const refreshBtn = mkIconBtn('refresh', '刷新图谱', () => reload());
        const closeBtn = mkIconBtn('close', '关闭面板', () => ctx.toggleTerminalPanel(false));
        headActions.append(refreshBtn, closeBtn);
        headInner.append(searchBox, filterBar);
        // 刷新/关闭钉在整条头部的最右端（详情列上方右缘），搜索框只占提交列宽度
        commitsHead.append(headInner, headActions);
        const commitWrap = document.createElement('div');
        commitWrap.className = 'gg-commits';
        const laneCol = document.createElement('div');
        laneCol.className = 'gg-lane-col';
        const listCol = document.createElement('div');
        listCol.className = 'gg-list-col';
        commitWrap.append(laneCol, listCol);

        // 右栏：详情
        const detail = document.createElement('div');
        detail.className = 'gg-detail';

        // 两条列宽拖动条：ref 树 | ‖ | 提交列表 | ‖ | 详情
        const splitRefs = mkSplitter('refs');
        const splitDetail = mkSplitter('detail');
        const rightBody = document.createElement('div');
        rightBody.className = 'gg-right-body';
        rightBody.append(commitWrap, splitDetail, detail);
        rightCol.append(commitsHead, rightBody);
        body.append(refsCol, splitRefs, rightCol);

        const hint = document.createElement('div');
        hint.className = 'gg-hint hidden';

        // 首次加载骨架屏：覆盖整个 body（含三栏），加载完成/失败后移除
        const skeleton = document.createElement('div');
        skeleton.className = 'gg-skeleton hidden';
        skeleton.innerHTML = buildSkeletonHtml();
        body.appendChild(skeleton); // 锚在 .gg-body 内，只盖三栏、不盖列头

        root.append(body, hint);

        commitWrap.addEventListener('scroll', onScroll);

        els = {root, body, refsCol, refTree, rightCol, rightHead: commitsHead, commitWrap, laneCol, commitList: listCol, detail, hint, filterInput, branchFilter, branchSel, userSel, dateSel, skeleton};
        loadPaneWidths();
        applyPaneWidths();
        watchPanelResize();
        return els;
    }

    // watchPanelResize 底部面板高度 / 窗口尺寸变化后重渲提交列表：拖动底板高度不改
    // commitWrap 内容，但可见区变了，虚拟滚动要按新高度重算（用户反馈：拖动后不滚动不重建）。
    function watchPanelResize() {
        if (resizeWatched) return;
        resizeWatched = true;
        window.addEventListener('resize', () => {
            if (!els) return;
            renderCommitList(true);
            applyPaneWidths();
        });
        // 底板高度拖动只改 style.height，不触发 window resize：观察面板 style 变化兜底
        const panel = document.getElementById('terminal-panel');
        if (panel && typeof MutationObserver === 'function') {
            new MutationObserver(() => {
                if (!els) return;
                renderCommitList(true);
            }).observe(panel, {attributes: true, attributeFilter: ['style']});
        }
    }

    // mkSplitter 生成一条列宽拖动条：拖动时改左栏（refs=ref 树）或右栏（detail=详情）宽度。
    // 用 pointer 事件 + setPointerCapture：拖出条外也持续跟踪，松手/取消即结束。
    // 光标走自定义主题（setDragCursor('ew') → body.cursor-ew → 注入的系统光标），
    // 与侧栏 / 编辑器分栏一致，不再用原生 col-resize。
    function mkSplitter(which) {
        const bar = document.createElement('div');
        bar.className = 'gg-splitter';
        bar.dataset.tip = '拖动调整宽度';
        bar.setAttribute('role', 'separator');
        bar.setAttribute('aria-orientation', 'vertical');
        // hover/拖动「提交列 | 详情」分割条时，让头部那段静态竖线同步高亮，
        // 否则 body 里拖动条变蓝、头部线仍是灰色，视觉上断成两截（2026-11-21 修复）。
        // refs 那条分割条在头部没有对应竖线，不联动。
        const syncHeadLine = (on) => {
            if (which === 'detail' && els && els.rightHead) {
                els.rightHead.classList.toggle('gg-head-line-active', on);
            }
        };
        bar.addEventListener('pointerenter', () => syncHeadLine(true));
        bar.addEventListener('pointerleave', () => syncHeadLine(false));
        bar.addEventListener('pointerdown', (ev) => {
            if (!els || !els.body) return;
            ev.preventDefault();
            bar.setPointerCapture(ev.pointerId);
            bar.classList.add('dragging');
            if (ctx.setDragCursor) ctx.setDragCursor('ew');
            document.body.style.userSelect = 'none';
            const startX = ev.clientX;
            const startRefs = state.refsW;
            const startDetail = state.detailW;
            const total = els.body.clientWidth;

            const onMove = (e) => {
                const dx = e.clientX - startX;
                if (which === 'refs') {
                    const max = total - SPLITTERS_W - COMMITS_MIN - startDetail;
                    state.refsW = clampPaneWidth(startRefs + dx, REFS_MIN, max);
                } else {
                    // 拖右分割条向右 = 详情变窄
                    const max = total - SPLITTERS_W - COMMITS_MIN - startRefs;
                    state.detailW = clampPaneWidth(startDetail - dx, DETAIL_MIN, max);
                }
                applyPaneWidths();
            };
            const onUp = () => {
                bar.removeEventListener('pointermove', onMove);
                bar.removeEventListener('pointerup', onUp);
                bar.removeEventListener('pointercancel', onUp);
                bar.classList.remove('dragging');
                syncHeadLine(false);
                if (ctx.setDragCursor) ctx.setDragCursor(null);
                document.body.style.userSelect = '';
                savePaneWidths();
            };
            bar.addEventListener('pointermove', onMove);
            bar.addEventListener('pointerup', onUp);
            bar.addEventListener('pointercancel', onUp);
        });
        return bar;
    }

    // 骨架屏显隐：首次拉数据期间盖住空的三栏，避免「先空白后突然蹦出」
    function showSkeleton() {
        if (els && els.skeleton) els.skeleton.classList.remove('hidden');
    }
    function hideSkeleton() {
        if (els && els.skeleton) els.skeleton.classList.add('hidden');
    }

    function mkIconBtn(icon, tip, onClick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'gg-btn';
        b.dataset.tip = tip;
        b.setAttribute('aria-label', tip);
        b.innerHTML = iconSvg(icon, 14);
        b.addEventListener('click', onClick);
        return b;
    }

    // mkToggleBtn 搜索选项开关按钮（正则 / 区分大小写）：SVG 图标 + active 态 + aria-pressed。
    function mkToggleBtn(icon, tip, onClick) {
        const b = mkIconBtn(icon, tip, onClick);
        b.classList.add('gg-search-toggle');
        b.setAttribute('aria-pressed', 'false');
        return b;
    }

    // ---- 数据加载 ----
    function gitDir() {
        return ctx.gitStateCache.dir || ctx.workspaceFolder || '';
    }

    // workspaceRootName 取工作区路径的末段作为「本次变动」树的顶层节点名（JetBrains 式）。
    // 兼容 Windows 反斜杠 / POSIX 斜杠，路径末尾的斜杠先剥掉；取不到时回落到 '工作区'。
    function workspaceRootName() {
        const dir = String(gitDir() || '').replace(/[\\/]+$/, '');
        const seg = dir.split(/[\\/]/).filter(Boolean).pop();
        return seg || '工作区';
    }

    // fillBranchSelect 用 refs 的本地/远程分支填充头部「分支」下拉（切换查看该分支历史）。
    function fillBranchSelect() {
        if (!els || !els.branchSel) return;
        const refs = state.refs || {};
        const names = [];
        for (const r of (refs.local || [])) if (r.name) names.push(r.name);
        for (const r of (refs.remote || [])) if (r.name) names.push(r.name);
        const cur = state.currentRef || '';
        els.branchSel.innerHTML = '';
        const first = document.createElement('option');
        first.value = '';
        first.textContent = '分支';
        els.branchSel.appendChild(first);
        for (const name of names) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            els.branchSel.appendChild(opt);
        }
        els.branchSel.value = cur;
    }

    // fillUserSelect 用当前提交列表里的作者去重填充「用户」下拉。
    function fillUserSelect() {
        if (!els || !els.userSel) return;
        const names = [...new Set(state.commits.map((c) => c.author).filter(Boolean))].sort();
        const cur = state.userFilter || '';
        els.userSel.innerHTML = '';
        const first = document.createElement('option');
        first.value = '';
        first.textContent = '用户';
        els.userSel.appendChild(first);
        for (const name of names) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            els.userSel.appendChild(opt);
        }
        els.userSel.value = names.includes(cur) ? cur : '';
        if (els.userSel.value !== cur) { state.userFilter = ''; filteredCache = null; }
    }

    async function loadRefs() {
        if (!ctx.backend.GitGraphRefs) return;
        const dir = gitDir();
        if (!dir) return;
        try {
            const refs = await ctx.backend.GitGraphRefs(dir);
            // 竞态守卫：await 期间可能已切到别的工作区。旧仓的响应写回去会让分支列表
            // 与「当前根」不一致（界面显示 A 仓分支，工具根已是 B）。同文件 loadCommitDetail
            // 有同款守卫（比较 selectedSha），这里对齐。
            if (dir !== gitDir()) return;
            state.refs = refs;
        } catch (e) {
            if (dir !== gitDir()) return;
            state.refs = null;
        }
        renderRefTree();
        fillBranchSelect();
    }

    async function loadCommits(ref, skip = 0) {
        if (!ctx.backend.GitGraphCommits) return;
        const dir = gitDir();
        if (!dir) {
            showHint('请先打开一个 git 仓库');
            return;
        }
        if (state.loading) return;
        state.loading = true;
        hideHint();
        try {
            const page = await ctx.backend.GitGraphCommits(dir, ref || '', DEFAULT_LIMIT, skip);
            // 竞态守卫：await 期间切了工作区就丢弃这次结果——否则旧仓的提交会写进
            // 新仓的列表（`state.loadedDir` 也会被旧值覆盖，下次判断"目录没变"就错了）。
            if (dir !== gitDir()) return;
            // 失败判定要跟 Go 侧对齐：available 在跑 git log 之前就置 true（graph.go:79），
            // 坏 ref / 拉取失败只写 reason，所以「有 reason 且零提交」也按失败提示，别当成功收尾。
            if (graphPageFailed(page)) {
                showHint(page && page.reason ? page.reason : '无法读取提交历史');
                return;
            }
            if (skip === 0) {
                state.commits = page.commits;
                state.laneCount = page.laneCount;
                state.currentRef = ref || '';
            } else {
                state.commits = state.commits.concat(page.commits);
                state.laneCount = Math.max(state.laneCount, page.laneCount);
            }
            state.hasMore = page.hasMore;
            state.nextSkip = page.nextSkip;
            state.initialized = true;
            state.loadedDir = dir;
            dirRetry = 0; // 成功加载后清零重试计数（下次目录失效可重新拿到重试额度）
            filteredCache = null; // 数据变了，清过滤缓存
            fillUserSelect();
            if (els && els.branchSel) els.branchSel.value = state.currentRef || '';
            renderCommitList(true);
        } catch (e) {
            showHint('读取提交历史失败：' + e);
        } finally {
            // 无论成功 / 失败 / 抛错都复位，避免 loading 被钉死挡住后续所有加载（含刷新）
            state.loading = false;
            hideSkeleton();
        }
    }

    async function reload() {
        // 共享 in-flight promise：并发 show()（如快速切视图、切回图谱）复用同一次加载，
        // 而不是让后一次被 loadCommits 的 loading 守卫静默丢弃——那样骨架被提前收掉、
        // initialized 仍 false，就出现「一片空白、只能手动刷新」。
        if (inflightReload) return inflightReload;
        state.filesCache.clear();
        state.fileCollapse.clear();
        inflightReload = Promise.all([loadRefs(), loadCommits(state.currentRef, 0)])
            .finally(() => { inflightReload = null; });
        return inflightReload;
    }

    // afterGraphWrite 图谱写操作（签出 / 重置 / 新建分支）完成后的统一收尾：
    // 重拉图谱 + 刷新底部 Git 状态条。
    function afterGraphWrite() {
        reload();
        if (ctx.refreshGitStatus) ctx.refreshGitStatus();
    }

    // 首次切到该视图时调用（懒加载）：首次拉数据期间显示骨架屏。
    // 已加载过且 git 目录没变才跳过；切了工作区 / 仓库后 initialized 失效，下次进来自动重拉
    //（否则停在 false 上又没重试入口，只能手动点刷新）。
    async function show() {
        const e = ensureEls();
        if (!e) return;
        if (state.initialized && state.loadedDir === gitDir()) return;
        // 启动恢复期 git 目录还没就绪（applyDockView 早于 workspaceFolder 赋值）：
        // 短延时重试几次，避免留下「骨架已收、列表空、只能手动刷新」的空白。
        if (!gitDir()) {
            // 视图已被切走 / 面板已收起时不再重试（用户不在看，白白空转）
            if (e.root.classList.contains('hidden')) return;
            if (dirRetry < DIR_RETRY_MAX && !dirRetryTimer) {
                dirRetryTimer = setTimeout(() => {
                    dirRetryTimer = 0;
                    dirRetry++;
                    show();
                }, DIR_RETRY_DELAY_MS);
            }
            return;
        }
        showSkeleton();
        try {
            await reload();
        } finally {
            // reload 已在 loadCommits 的 finally 里收骨架；这里兜底 `!dir` 等早退路径
            hideSkeleton();
        }
    }

    // ---- 渲染：ref 树（带分支过滤） ----
    function renderRefTree() {
        if (!els || !els.refTree) return;
        const tree = els.refTree;
        tree.innerHTML = '';
        const refs = state.refs;
        if (!refs || !refs.available) {
            const empty = document.createElement('div');
            empty.className = 'gg-refs-empty';
            empty.textContent = (refs && refs.reason) || '不在 git 仓库内';
            tree.appendChild(empty);
            return;
        }
        const q = state.refFilter.trim().toLowerCase();
        const hit = (name) => !q || String(name || '').toLowerCase().includes(q);
        const filtered = (items) => (!q || !items) ? (items || []) : items.filter((r) => hit(r.name));
        // HEAD / 当前分支
        if (refs.current || refs.headSha) {
            const headName = refs.current || 'HEAD（detached）';
            if (!q || hit(headName)) {
                const headGroup = document.createElement('div');
                headGroup.className = 'gg-ref-group';
                headGroup.appendChild(mkRefRow({name: headName, sha: refs.headSha, current: true}, 'HEAD'));
                tree.appendChild(headGroup);
            }
        }
        // 分组：本地 / 远程 / 标签 / worktree（过滤时空组隐藏并强制展开）
        addRefGroup(tree, 'local', '本地分支', filtered(refs.local), false, q);
        addRefGroup(tree, 'remote', '远程分支', filtered(refs.remote), true, q);
        addRefGroup(tree, 'tags', '标签', filtered(refs.tags), false, q);
        addRefGroup(tree, 'worktrees', 'Worktree', filtered(refs.worktrees), true, q);
        if (q && !tree.children.length) {
            const empty = document.createElement('div');
            empty.className = 'gg-refs-empty';
            empty.textContent = '没有匹配的分支';
            tree.appendChild(empty);
        }
    }

    function addRefGroup(tree, key, title, items, collapsedDefault, q) {
        if (!items || !items.length) return;
        if (!(key in state.expandedGroups)) state.expandedGroups[key] = !collapsedDefault;
        const group = document.createElement('div');
        group.className = 'gg-ref-group';
        const head = document.createElement('div');
        head.className = 'gg-ref-group-head';
        const expanded = q ? true : state.expandedGroups[key];
        const chev = document.createElement('button');
        chev.type = 'button';
        chev.className = 'gg-chev';
        chev.setAttribute('aria-label', title + '（展开或收起）');
        chev.setAttribute('aria-expanded', String(expanded));
        chev.innerHTML = iconSvg(expanded ? 'chevron-down' : 'chevron-right', 12);
        const label = document.createElement('span');
        label.className = 'gg-ref-group-title';
        label.textContent = title + '（' + items.length + '）';
        head.append(chev, label);
        group.appendChild(head);
        if (expanded) {
            for (const r of items) group.appendChild(mkRefRow(r, r.name));
        }
        head.addEventListener('click', () => {
            state.expandedGroups[key] = !state.expandedGroups[key];
            renderRefTree();
        });
        tree.appendChild(group);
    }

    function mkRefRow(ref, displayName) {
        const row = document.createElement('div');
        row.className = 'gg-ref-row' + (ref.current ? ' current' : '');
        const name = document.createElement('span');
        name.className = 'gg-ref-name';
        name.textContent = displayName;
        row.appendChild(name);
        if (ref.worktree) {
            const wt = document.createElement('span');
            wt.className = 'gg-ref-wt';
            wt.textContent = ref.worktree;
            row.appendChild(wt);
        }
        row.addEventListener('click', () => {
            // 点 ref = 过滤到该分支（标签/提交则定位）
            loadCommits(ref.name);
        });
        return row;
    }

    // ---- 渲染：提交列表（虚拟滚动） ----
    // 缓存上次渲染的可见区与过滤结果，滚动时只在可见区变化时才重建 DOM
    let lastRange = {start: -1, end: -1};
    let lastFilter = '';
    let filteredCache = null;

    function visibleRange() {
        const wrap = els.commitWrap;
        const total = (filteredCache || state.commits).length;
        if (!wrap || total === 0) return {start: 0, end: 0, padTop: 0, padBottom: 0};
        const scrollTop = wrap.scrollTop;
        const viewH = wrap.clientHeight || 400;
        const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 10);
        const end = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + 10);
        return {start, end, padTop: start * ROW_H, padBottom: (total - end) * ROW_H};
    }

    function filterCommits() {
        const query = (els.filterInput.value || '').trim();
        // 缓存键必须覆盖所有筛选条件，否则切换开关/下拉后「点了没变化」
        const key = JSON.stringify([query, state.searchRegex, state.searchCaseSensitive, state.userFilter, state.dateFilter]);
        if (key === lastFilter && filteredCache) return filteredCache;
        lastFilter = key;
        const {match, error} = buildCommitMatcher({
            query, regex: state.searchRegex, caseSensitive: state.searchCaseSensitive,
            user: state.userFilter, date: state.dateFilter,
        });
        if (error) {
            showHint(error);
            return filteredCache || (filteredCache = state.commits);
        }
        const anyFilter = !!(query || state.userFilter || state.dateFilter);
        filteredCache = anyFilter ? state.commits.filter(match) : state.commits;
        return filteredCache;
    }

    // hasAnyFilter 是否处于任一筛选态（泳道/加载更多/预加载都要据此收敛）。
    function hasAnyFilter() {
        return !!(els && ((els.filterInput && els.filterInput.value || '').trim() || state.userFilter || state.dateFilter));
    }

    function renderCommitList(force) {
        if (!els || !els.commitList) return;
        const list = els.commitList;
        const laneCol = els.laneCol;
        const commits = filterCommits();
        if (!commits.length) {
            lastRange = {start: -1, end: -1};
            list.innerHTML = '';
            laneCol.innerHTML = '';
            if (state.initialized) showHint('没有匹配的提交');
            return;
        }
        hideHint();

        const {start, end, padTop, padBottom} = visibleRange();
        // 可见区没变且非强制刷新：跳过重建（滚动时大部分帧都命中这里，避免疯狂重建 DOM）
        if (!force && start === lastRange.start && end === lastRange.end) return;
        lastRange = {start, end};

        // 保存 scrollTop（重建 DOM 会重置）
        const savedScrollTop = els.commitWrap.scrollTop;
        list.innerHTML = '';
        laneCol.innerHTML = '';
        const slice = commits.slice(start, end);

        // spacer 维持滚动条高度
        if (padTop > 0) {
            const top = document.createElement('div');
            top.style.height = padTop + 'px';
            list.appendChild(top);
        }
        for (let i = start; i < end; i++) {
            const c = commits[i];
            list.appendChild(mkCommitRow(c, i));
        }
        if (padBottom > 0) {
            const bot = document.createElement('div');
            bot.style.height = padBottom + 'px';
            list.appendChild(bot);
        }

        // 恢复 scrollTop（虚拟滚动重建后必须恢复，否则滚动条会被拉回顶部）
        els.commitWrap.scrollTop = savedScrollTop;

        // 泳道 SVG（按过滤后的切片渲染，行号对齐 slice）
        // 注意：过滤会打乱 lane 连续性——过滤时泳道不准，只在无过滤时画泳道。
        if (!hasAnyFilter()) {
            laneCol.innerHTML = buildLaneSvg(slice, state.laneCount);
            laneCol.style.paddingTop = padTop + 'px';
            // 同步泳道列宽度到 CSS 变量，让文字列的 padding-left 匹配
            const laneWidth = laneSvgWidth(state.laneCount);
            els.commitWrap.style.setProperty('--gg-lane-col-w', laneWidth + 'px');
        } else {
            laneCol.innerHTML = '';
        }

        // 加载更多提示
        if (state.hasMore && !hasAnyFilter()) {
            const more = document.createElement('div');
            more.className = 'gg-load-more';
            more.textContent = state.loading ? '加载中…' : '滚动加载更多';
            list.appendChild(more);
        }
    }

    function mkCommitRow(c, idx) {
        const row = document.createElement('div');
        row.className = 'gg-row' + (c.sha === state.selectedSha ? ' selected' : '');
        row.style.height = ROW_H + 'px';

        const msg = document.createElement('span');
        msg.className = 'gg-msg';
        msg.textContent = c.subject || '(无消息)';

        const refs = document.createElement('span');
        refs.className = 'gg-refs-deco';
        refs.textContent = c.refs || '';

        const author = document.createElement('span');
        author.className = 'gg-author';
        author.textContent = c.author || '';

        const date = document.createElement('span');
        date.className = 'gg-date';
        date.textContent = c.date || '';

        row.append(msg, refs, author, date);
        row.addEventListener('click', () => selectCommit(c.sha));
        row.addEventListener('dblclick', () => selectCommit(c.sha));
        // 右键：先选中该行再弹菜单（JetBrains 语义）
        row.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            if (state.selectedSha !== c.sha) selectCommit(c.sha);
            openCommitMenu(ev, c);
        });
        return row;
    }

    // openCommitMenu 提交行的右键菜单（JetBrains 式精选项：复制修订号 / 新建分支 /
    // 签出修订 / Cherry-Pick / 将当前分支重置到此处）。
    function openCommitMenu(ev, c) {
        const items = [
            {
                label: '复制修订号',
                icon: 'copy',
                action: () => { if (ctx.copyText) ctx.copyText(c.sha, '修订号'); },
            },
            {sep: true},
            {
                label: '新建分支…',
                icon: 'git',
                action: () => dialogs.openBranchDialog(c, afterGraphWrite),
            },
            {
                label: '签出修订',
                icon: 'forward',
                action: () => doCheckout(c),
            },
            {
                label: 'Cherry-Pick',
                icon: 'star',
                action: () => doCherryPick(c),
            },
            {sep: true},
            {
                label: '将当前分支重置到此处…',
                icon: 'undo',
                action: () => dialogs.openResetDialog(c, afterGraphWrite),
            },
        ];
        if (ctx.ctxMenu) ctx.ctxMenu.open(items, ev.clientX, ev.clientY);
    }

    function onScroll() {
        if (!els) return;
        const wrap = els.commitWrap;
        const nearBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - ROW_H * 5;
        if (nearBottom && state.hasMore && !state.loading && !hasAnyFilter()) {
            loadCommits(state.currentRef, state.nextSkip);
        } else {
            renderCommitList();
        }
    }

    // ---- 详情面板（IDEA 式：消息正文 / 作者行 / ref 徽章 / 分支计数 / 操作 / 本次变动） ----
    function selectCommit(sha) {
        state.selectedSha = sha;
        renderCommitList(true); // 选中高亮变了，强制刷新
        renderDetail();
    }

    function findCommit(sha) {
        return state.commits.find((c) => c.sha === sha) || null;
    }

    function renderDetail() {
        if (!els || !els.detail) return;
        const d = els.detail;
        d.innerHTML = '';
        const c = findCommit(state.selectedSha);
        if (!c) {
            const empty = document.createElement('div');
            empty.className = 'gg-detail-empty';
            empty.textContent = '选择一个提交查看详情';
            d.appendChild(empty);
            return;
        }

        // 上半区：消息与元信息（可滚动）
        const info = document.createElement('div');
        info.className = 'gg-detail-info';

        // 关闭按钮浮在详情右上角
        const closeBtn = mkIconBtn('close', '关闭详情', () => {
            state.selectedSha = '';
            renderCommitList(true);
            renderDetail();
        });
        closeBtn.classList.add('gg-detail-close');

        // 完整提交消息：主题加粗 + 正文（IDEA 式）。正文随文件变动一起按需异步加载
        //（--graph 的一条提交只占一行，多行正文会破坏一行一提交的映射）
        const msg = document.createElement('div');
        msg.className = 'gg-detail-msg';
        msg.textContent = c.subject || '(无消息)';
        info.appendChild(msg);
        const bodyEl = document.createElement('div');
        bodyEl.className = 'gg-detail-body';
        bodyEl.dataset.bodySha = c.sha;
        info.appendChild(bodyEl);

        // 作者信息行：头像色块 + sha + 作者 <邮箱>, 日期
        const authorRow = document.createElement('div');
        authorRow.className = 'gg-detail-author';
        const avatar = document.createElement('span');
        avatar.className = 'gg-avatar';
        avatar.style.background = avatarColor(c.email || c.author || '');
        const authorText = document.createElement('span');
        authorText.className = 'gg-author-text';
        authorText.textContent = (c.sha || '').slice(0, 8) + ' 作者 ' + (c.author || '') +
            (c.email ? ' <' + c.email + '>' : '') + '，' + (c.date || '');
        authorRow.append(avatar, authorText);
        info.appendChild(authorRow);

        // ref 徽章行：HEAD / 本地分支 / 远程 / 标签 分色展示（IDEA 式）
        const chips = parseCommitRefs(c.refs);
        if (chips.length) {
            const refRow = document.createElement('div');
            refRow.className = 'gg-detail-refs';
            for (const chip of chips) {
                const el = document.createElement('span');
                el.className = 'gg-refchip gg-refchip--' + chip.kind;
                el.textContent = chip.name;
                refRow.appendChild(el);
            }
            info.appendChild(refRow);
        }

        // 分支计数行：「在 N 个分支中: HEAD, master, origin/master」
        const branchRow = document.createElement('div');
        branchRow.className = 'gg-detail-branch';
        if (chips.length) {
            const label = document.createElement('span');
            label.textContent = '在 ' + chips.length + ' 个分支中: ';
            const list = document.createElement('span');
            list.className = 'gg-branch-list';
            list.textContent = chips.map((x) => x.name).join(', ');
            branchRow.append(label, list);
            branchRow.title = chips.map((x) => x.name).join(', ');
        } else {
            branchRow.textContent = '不在任何分支上（游离提交）';
        }
        info.appendChild(branchRow);

        // 操作按钮
        const actions = document.createElement('div');
        actions.className = 'gg-detail-actions';
        actions.appendChild(mkActionBtn('签出', () => doCheckout(c)));
        actions.appendChild(mkActionBtn('Cherry-Pick', () => doCherryPick(c)));
        actions.appendChild(mkActionBtn('重置…', () => dialogs.openResetDialog(c, () => reload())));
        info.appendChild(actions);

        // 下半区：本次提交的文件变动树（IDEA 右侧「本次变动」）
        const filesWrap = document.createElement('div');
        filesWrap.className = 'gg-detail-files';
        const filesTitle = document.createElement('div');
        filesTitle.className = 'gg-files-title';
        filesTitle.textContent = '本次变动';
        const filesBody = document.createElement('div');
        filesBody.className = 'gg-files-body';
        filesBody.textContent = '加载中…';
        filesWrap.append(filesTitle, filesBody);

        // 信息区 / 本次变动之间的水平拖动条：上下分配详情高度（比例持久化）
        const infoRatio = loadInfoH();
        if (infoRatio != null && els.detail.clientHeight > 0) {
            info.style.height = Math.round(els.detail.clientHeight * infoRatio) + 'px';
        }
        const vsplit = mkDetailSplitter(info);
        d.append(closeBtn, info, vsplit, filesWrap);
        loadCommitDetail(c.sha, filesWrap, bodyEl);
    }

    // 详情信息区高度持久化：null = 未拖过（自适应内容）。存比例（相对详情高），窗口变化不失真。
    const INFO_H_KEY = GITGRAPH_INFO_HEIGHT_KEY;
    function loadInfoH() {
        const raw = kvGet(INFO_H_KEY);
        if (!raw) return null;
        const v = Number(raw);
        if (!Number.isFinite(v) || v <= 0.05 || v >= 0.9) return null;
        return v;
    }
    function saveInfoH(ratio) {
        kvSet(INFO_H_KEY, String(ratio)); // 存储不可用：会话内仍生效
    }

    // mkDetailSplitter 详情内上下拖动条：拖动改信息区高度（其余给本次变动树）。
    // 比例 = infoH / detail 高度，松手持久化。
    function mkDetailSplitter(infoEl) {
        const bar = document.createElement('div');
        bar.className = 'gg-detail-vsplit';
        bar.dataset.tip = '拖动调整上下高度';
        bar.setAttribute('role', 'separator');
        bar.setAttribute('aria-orientation', 'horizontal');
        bar.addEventListener('pointerdown', (ev) => {
            if (!els || !els.detail) return;
            ev.preventDefault();
            bar.setPointerCapture(ev.pointerId);
            bar.classList.add('dragging');
            if (ctx.setDragCursor) ctx.setDragCursor('ns');
            document.body.style.userSelect = 'none';
            const detailH = els.detail.clientHeight;
            const startY = ev.clientY;
            const startH = infoEl.getBoundingClientRect().height;
            const onMove = (e) => {
                const h = Math.min(detailH - 120, Math.max(60, startH + (e.clientY - startY)));
                infoEl.style.height = h + 'px';
            };
            const onUp = () => {
                bar.removeEventListener('pointermove', onMove);
                bar.removeEventListener('pointerup', onUp);
                bar.removeEventListener('pointercancel', onUp);
                bar.classList.remove('dragging');
                if (ctx.setDragCursor) ctx.setDragCursor(null);
                document.body.style.userSelect = '';
                saveInfoH(Math.min(0.9, Math.max(0.05, infoEl.getBoundingClientRect().height / detailH)));
            };
            bar.addEventListener('pointermove', onMove);
            bar.addEventListener('pointerup', onUp);
            bar.addEventListener('pointercancel', onUp);
        });
        return bar;
    }

    // loadCommitDetail 拉取选中提交的文件变动与完整正文（LRU 缓存；会话切换守卫）。
    async function loadCommitDetail(sha, filesWrap, bodyEl) {
        const title = filesWrap.querySelector('.gg-files-title');
        const box = filesWrap.querySelector('.gg-files-body');
        if (!box) return;
        // fillFiles / fillBody 必须先声明再用：缓存命中路径（再次点同一提交）在首个 await
        // 之前就同步调用它们，声明放后面会踩 const TDZ（Cannot access 'fillFiles' before
        // initialization → 未处理的 Promise 拒绝，2026-11-20 实测）。
        const fillFiles = (files) => {
            title.textContent = '本次变动（' + files.length + '）';
            box.innerHTML = '';
            if (!files.length) {
                const empty = document.createElement('div');
                empty.className = 'gg-files-empty';
                empty.textContent = '没有文件变动';
                box.appendChild(empty);
                return;
            }
            renderFileTree(box, fileTreeFromChanges(files, workspaceRootName()), 0);
        };
        const fillBody = (el, forSha, body) => {
            if (el.dataset.bodySha !== forSha) return;
            el.textContent = body && body !== findCommit(forSha)?.subject ? body : '';
        };
        const cacheHit = state.filesCache.get(sha);
        if (cacheHit) {
            fillFiles(cacheHit.files);
            fillBody(bodyEl, sha, cacheHit.body);
            return;
        }
        if (!ctx.backend.GitGraphCommitFiles) {
            filesWrap.classList.add('hidden');
            return;
        }
        try {
            const [files, body] = await Promise.all([
                ctx.backend.GitGraphCommitFiles(gitDir(), sha),
                ctx.backend.GitGraphCommitBody ? ctx.backend.GitGraphCommitBody(gitDir(), sha) : Promise.resolve(''),
            ]);
            if (state.selectedSha !== sha) return; // 请求期间选中的提交变了，丢弃
            if (state.filesCache.size >= FILES_CACHE_MAX) {
                const first = state.filesCache.keys().next().value;
                state.filesCache.delete(first);
            }
            state.filesCache.set(sha, { files, body });
            fillFiles(files);
            fillBody(bodyEl, sha, body);
        } catch (e) {
            if (state.selectedSha === sha) {
                box.textContent = '读取文件变动失败：' + e;
            }
        }
    }

    // renderFileTree 递归渲染目录树；目录可折叠（折叠状态记在 state.fileCollapse）。
    function renderFileTree(box, nodes, depth) {
        for (const n of nodes) {
            if (n.type === 'dir') {
                const row = document.createElement('div');
                row.className = 'gg-file-dir' + (n.root ? ' gg-file-root' : '');
                row.style.paddingLeft = (4 + depth * 14) + 'px';
                const chev = document.createElement('span');
                chev.className = 'gg-file-chev';
                chev.innerHTML = iconSvg(state.fileCollapse.has(n.path) ? 'chevron-right' : 'chevron-down', 10);
                const ico = document.createElement('span');
                ico.className = 'gg-file-ico gg-dir-ico';
                ico.innerHTML = FOLDER_SVG;
                const name = document.createElement('span');
                name.className = 'gg-file-dir-name';
                name.textContent = n.name;
                const count = document.createElement('span');
                count.className = 'gg-file-dir-count';
                count.textContent = countFiles(n);
                row.append(chev, ico, name, count);
                row.addEventListener('click', () => {
                    if (state.fileCollapse.has(n.path)) state.fileCollapse.delete(n.path);
                    else state.fileCollapse.add(n.path);
                    box.innerHTML = '';
                    // 缓存值是 {files, body} 对象：折叠重渲只取 files（直接展开对象会
                    // 触发 fileTreeFromChanges 的 for-of 抛 TypeError 并清掉整棵树）
                    const cached = state.filesCache.get(state.selectedSha);
                    renderFileTree(box, fileTreeFromChanges(cached ? cached.files : [], workspaceRootName()), 0);
                });
                box.appendChild(row);
                if (!state.fileCollapse.has(n.path)) renderFileTree(box, n.children, depth + 1);
            } else {
                // 状态不画字母徽章：文件名直接用 git 树同款 FILESTATUS 色彩
                // （绿=新增 蓝=修改/重命名 灰=删除），与 .git-file-row / .sb-name 同源变量
                const stCls = GIT_STATUS_CLS[n.status] || 'modified';
                const row = document.createElement('div');
                row.className = 'gg-file-row gg-st-' + stCls;
                row.style.paddingLeft = (4 + depth * 14 + 14) + 'px';
                // 文件图标与文件树同一主题解析链（vscode-icons 彩色图标）
                const ico = createFileIcon(n.name, 'gg-file-ico');
                const name = document.createElement('span');
                name.className = 'gg-file-name';
                name.textContent = n.name;
                row.append(ico, name);
                const label = GIT_STATUS_LABEL[n.status] || n.status || '修改';
                row.title = label + '：' + n.path + (n.oldPath ? '（' + n.oldPath + ' → ' + n.path + '）' : '');
                // 点击文件：拉该文件在「当前选中提交」中的 diff，开只读虚拟 diff 文档
                // （JetBrains 式：本次变动树点文件看当次提交改了什么）。
                row.classList.add('gg-file-clickable');
                row.addEventListener('click', () => openFileDiff(n));
                box.appendChild(row);
            }
        }
    }

    // openFileDiff 打开「本次变动」树中某个文件在当前提交里的 diff（只读虚拟文档）。
    // 复用 bridge-git 的 showGitDiff 范式：GitGraphCommitFileDiff → 虚拟 .diff doc → patch-view 只读渲染。
    async function openFileDiff(n) {
        if (!ctx.backend || !ctx.backend.GitGraphCommitFileDiff || !ctx.openVirtualDoc) return;
        const sha = state.selectedSha;
        if (!sha) return;
        try {
            const res = await ctx.backend.GitGraphCommitFileDiff(gitDir(), sha, n.path, 4000);
            if (!res || !res.hasChanges || !res.diff) {
                ctx.flash && ctx.flash('该文件在此提交中无文本差异');
                return;
            }
            const short = sha.slice(0, 8);
            ctx.openVirtualDoc('提交 ' + short + ' — ' + n.name + '.diff', res.diff, {readOnlyFixed: true, viewKind: 'diff'});
        } catch (e) {
            ctx.flash && ctx.flash('读取提交文件差异失败：' + e, true);
        }
    }

    // countFiles 统计目录节点下的文件总数（含子目录）。
    function countFiles(node) {
        let n = 0;
        for (const ch of node.children) {
            if (ch.type === 'dir') n += countFiles(ch);
            else n += 1;
        }
        return n;
    }

    // avatarColor 由邮箱/作者名派生一个稳定的头像底色（JetBrains 式彩色首字母块）
    function avatarColor(seed) {
        let h = 0;
        for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
        const hue = h % 360;
        return 'hsl(' + hue + ' 45% 45%)';
    }

    function mkActionBtn(label, onClick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'gg-action-btn';
        b.textContent = label;
        b.addEventListener('click', onClick);
        return b;
    }

    // ---- 写操作（只读锁 + 确认） ----
    function readOnlyBlocked() {
        if (ctx.settings && ctx.settings.readOnlyMode) {
            ctx.flash('当前处于只读模式，无法执行 git 操作', true);
            return true;
        }
        return false;
    }

    async function doCheckout(c) {
        if (readOnlyBlocked()) return;
        const detached = !(state.refs && state.refs.local.some((r) => r.sha === c.sha));
        const msg = detached
            ? `签出到提交 ${c.sha.slice(0, 7)} 会进入 detached HEAD（不在任何分支上）。继续？`
            : `签出到 ${c.sha.slice(0, 7)}？`;
        ctx.openConfirmDialog(msg, async () => {
            try {
                const res = await ctx.backend.GitGraphCheckout(gitDir(), c.sha);
                if (res && res.success) {
                    ctx.flash('已签出 ' + (res.branch || c.sha.slice(0, 7)));
                    await reload();
                    if (ctx.refreshGitStatus) ctx.refreshGitStatus();
                } else if (res && Array.isArray(res.conflictFiles) && res.conflictFiles.length) {
                    // 未提交改动挡路：弹 IDEA 式三选一（强制 / 智能 / 不签出）
                    dialogs.openCheckoutConflict(c, res.conflictFiles, afterGraphWrite);
                } else {
                    ctx.flash('签出失败：' + ((res && res.output) || '未知错误'), true);
                }
            } catch (e) {
                ctx.flash('签出失败：' + e, true);
            }
        }, '签出', '签出提交', detached ? 'danger' : undefined);
    }

    async function doCherryPick(c) {
        if (readOnlyBlocked()) return;
        ctx.openConfirmDialog(
            `把提交 ${c.sha.slice(0, 7)}（${c.subject || ''}）摘到当前分支？冲突时会停在冲突状态。`,
            async () => {
                try {
                    const res = await ctx.backend.GitGraphCherryPick(gitDir(), c.sha);
                    if (res && res.success) {
                        ctx.flash('已 cherry-pick ' + c.sha.slice(0, 7));
                        await reload();
                        if (ctx.refreshGitStatus) ctx.refreshGitStatus();
                    } else {
                        ctx.flash('cherry-pick 失败：' + ((res && res.output) || '可能有冲突'), true);
                    }
                } catch (e) {
                    ctx.flash('cherry-pick 失败：' + e, true);
                }
            }, 'Cherry-Pick', 'Cherry-Pick 提交');
    }

    // ---- 提示 ----
    function showHint(msg) {
        if (!els || !els.hint) return;
        els.hint.textContent = msg;
        els.hint.classList.remove('hidden');
    }
    function hideHint() {
        if (els && els.hint) els.hint.classList.add('hidden');
    }

    return {
        show, reload, loadCommits,
        get state() { return state; },
    };
}
