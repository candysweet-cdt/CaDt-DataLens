// titlebar-popovers.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// 标题栏弹层：项目选择（IDEA 简洁版）
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。


export function createTitlebarPopovers(deps) {


const POP_ICONS = {
    folder: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.8 4.5c0-.8.6-1.4 1.4-1.4h3l1.5 1.7h5c.8 0 1.4.6 1.4 1.4v5.3c0 .8-.6 1.4-1.4 1.4H3.2c-.8 0-1.4-.6-1.4-1.4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    branch: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="4.6" cy="3.7" r="1.7" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="4.6" cy="12.3" r="1.7" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="11.4" cy="5.4" r="1.7" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.6 5.4v5.2M11.4 7.1c0 2.1-2.2 2.9-4.3 3.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    reveal: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 5.3V3.9c0-.7.6-1.3 1.3-1.3h3l1.4 1.5h4.9c.8 0 1.4.6 1.4 1.4v.7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.4 6.4h11.2l-1.2 5.1c-.1.6-.6 1-1.2 1H4.7c-.6 0-1.1-.4-1.2-1z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    update: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M12.8 8a4.8 4.8 0 1 1-1.4-3.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M12.8 2.6v3.2H9.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    commit: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.4 8.3l2.8 2.8 6-6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    push: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 12.4V3.6M4.4 7.2L8 3.6l3.6 3.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    plus: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 3.4v9.2M3.4 8h9.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    tag: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2.6 3.2h5.1l5 5-4.5 4.5-5-5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="5.3" cy="5.9" r="1" fill="currentColor"/></svg>',
    check: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5.5 8.2l1.7 1.7 3.3-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chevron: '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M4.4 6.2 8 9.8l3.6-3.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function isToolbarPopOpen(pop) {
    return !!pop && !pop.classList.contains('hidden');
}

function positionToolbarPopover(pop, anchor) {
    if (!pop || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    let left = Math.min(rect.left, window.innerWidth - width - margin);
    left = Math.max(margin, left);
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - margin) top = window.innerHeight - height - margin;
    top = Math.max(margin, top);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
}

function closeProjectPopover() {
    if (!deps.els.projectPop) return;
    deps.els.projectPop.classList.add('hidden');
}

function projectBadgeColor(name) {
    const badgeColors = ['#4f8cff', '#3fb950', '#a371f7', '#d18616', '#1fa5a0', '#d4577d'];
    let hash = 0;
    for (const ch of String(name || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return badgeColors[hash % badgeColors.length];
}

function appendProjectAction(body, icon, label, action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pp-item';
    const ic = document.createElement('span');
    ic.className = 'pp-icon';
    ic.innerHTML = icon;
    const text = document.createElement('span');
    text.className = 'pp-name';
    text.textContent = label;
    btn.append(ic, text);
    btn.addEventListener('click', action);
    body.appendChild(btn);
}

function appendProjectLabel(body, text) {
    const label = document.createElement('div');
    label.className = 'pp-label';
    label.textContent = text;
    body.appendChild(label);
}

function appendProjectSep(body) {
    const sep = document.createElement('div');
    sep.className = 'pp-sep';
    body.appendChild(sep);
}

function appendProjectMain(parent, name, path) {
    const main = document.createElement('div');
    main.className = 'pp-main';
    const nameEl = document.createElement('div');
    nameEl.className = 'pp-name';
    nameEl.textContent = name || deps.baseNameOf(path) || path;
    const pathEl = document.createElement('div');
    pathEl.className = 'pp-path';
    pathEl.textContent = path;
    pathEl.title = path;
    main.append(nameEl, pathEl);
    parent.appendChild(main);
}

async function revealWorkspaceFolder() {
    if (!deps.workspaceFolder) return;
    try {
        await deps.backend.ShowInFolder(deps.workspaceFolder);
    } catch (e) {
        deps.flash('打开文件夹位置失败：' + e, true);
    }
}

function renderProjectPopover() {
    const body = deps.els.projectPopBody;
    if (!body) return;
    body.textContent = '';
    appendProjectAction(body, POP_ICONS.folder, '打开…', () => {
        closeProjectPopover();
        deps.openFolderDialog();
    });
    appendProjectAction(body, POP_ICONS.branch, '克隆仓库…', () => {
        closeProjectPopover();
        cloneRepositoryFlow();
    });
    if (deps.workspaceFolder) {
        appendProjectSep(body);
        appendProjectLabel(body, '打开项目');
        const row = document.createElement('div');
        row.className = 'pp-project';
        const badge = document.createElement('span');
        badge.className = 'pp-badge current';
        badge.textContent = deps.projectBadgeText(deps.baseNameOf(deps.workspaceFolder) || deps.workspaceFolder);
        row.appendChild(badge);
        appendProjectMain(row, deps.baseNameOf(deps.workspaceFolder) || deps.workspaceFolder, deps.workspaceFolder);
        body.appendChild(row);
        const reveal = document.createElement('button');
        reveal.type = 'button';
        reveal.className = 'pp-subaction';
        reveal.innerHTML = POP_ICONS.reveal + '<span>在文件资源管理器中显示</span>';
        reveal.addEventListener('click', () => {
            closeProjectPopover();
            revealWorkspaceFolder();
        });
        body.appendChild(reveal);
    }
    const norm = (s) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const currentKey = deps.workspaceFolder ? norm(deps.workspaceFolder) : '';
    const recent = deps.readRecentOpen()
        .filter((entry) => entry && entry.isDir && entry.path && norm(entry.path) !== currentKey)
        .slice(0, 8);
    if (recent.length) {
        appendProjectSep(body);
        appendProjectLabel(body, '最近的项目');
        for (const entry of recent) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'pp-item pp-recent';
            const badge = document.createElement('span');
            badge.className = 'pp-badge';
            badge.style.background = projectBadgeColor(entry.name || entry.path);
            badge.textContent = deps.projectBadgeText(entry.name || deps.baseNameOf(entry.path));
            btn.appendChild(badge);
            appendProjectMain(btn, entry.name || deps.baseNameOf(entry.path), entry.path);
            btn.addEventListener('click', () => {
                closeProjectPopover();
                deps.openFolderSmart(entry.path);
            });
            body.appendChild(btn);
        }
    }
}

function showProjectMenu(anchor) {
    if (!deps.els.projectPop) return;
    if (isToolbarPopOpen(deps.els.projectPop)) {
        closeProjectPopover();
        return;
    }
    closeGitBranchPopover();
    renderProjectPopover();
    deps.els.projectPop.classList.remove('hidden');
    positionToolbarPopover(deps.els.projectPop, anchor);
}

function joinFsPath(parent, name) {
    const sep = String(parent || '').includes('\\') ? '\\' : '/';
    return String(parent || '').replace(/[\\/]+$/, '') + sep + name;
}

function cloneRepoName(url) {
    let s = String(url || '').trim().replace(/[\\/]+$/, '');
    s = s.replace(/\.git$/i, '');
    const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf(':'));
    return s.slice(cut + 1).replace(/[^A-Za-z0-9._-]+/g, '-');
}

function cloneRepositoryFlow() {
    if (!deps.backend.GitCloneRepository) {
        deps.flash('当前版本不支持克隆仓库', true);
        return;
    }
    deps.openNameDialog({
        title: '克隆仓库',
        label: '仓库 URL',
        placeholder: 'https://github.com/owner/repo.git 或 git@host:owner/repo.git',
        okLabel: '选择目录并克隆',
        onSubmit: async (value) => {
            const url = String(value || '').trim();
            if (!url) throw new Error('请输入仓库 URL');
            const repoName = cloneRepoName(url);
            if (!repoName) throw new Error('无法从 URL 解析仓库名');
            const parent = await deps.backend.OpenFolderDialog(deps.workspaceFolder || '');
            if (!parent) return;
            const target = joinFsPath(parent, repoName);
            deps.elsDialogs.nameOk.textContent = '克隆中…';
            try {
                const res = await deps.backend.GitCloneRepository(url, target);
                if (!res || !res.success) throw new Error((res && res.output) || '克隆失败');
                await deps.openFolderSmart(target);
                deps.flash('已克隆仓库：' + repoName);
            } finally {
                deps.elsDialogs.nameOk.textContent = '选择目录并克隆';
            }
        },
    });
}

// ===== 标题栏弹层：Git 分支（IDEA 式） =====

const gitBranchPopState = {
    open: false,
    loading: false,
    data: null,
    error: '',
    query: '',
    active: -1,
    pinned: false,
    collapsed: new Set(),
    anchor: null,
    dir: '',
};
// 本地分支每次打开都刷新；远程分支列表缓存，只在 fetch 按钮或 push/pull 后重读
const gitBranchCache = {dir: '', remote: [], hasRemote: false, result: null};
let gitBranchRows = [];

function invalidateGitBranchRemoteCache() {
    gitBranchCache.hasRemote = false;
    gitBranchCache.remote = [];
    if (gitBranchCache.result) gitBranchCache.result.remote = [];
}

function closeGitBranchPopover() {
    if (!deps.els.gitBranchPop) return;
    deps.els.gitBranchPop.classList.add('hidden');
    gitBranchPopState.open = false;
    gitBranchPopState.loading = false;
    gitBranchPopState.data = null;
    gitBranchPopState.error = '';
    gitBranchPopState.query = '';
    gitBranchPopState.active = -1;
    gitBranchPopState.anchor = null;
    gitBranchPopState.dir = '';
    gitBranchRows = [];
}

function gitBranchPopButton(className) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.tabIndex = -1;
    return btn;
}

function gitBranchPopDir() {
    return gitBranchPopState.dir || deps.gitRootDir();
}

function gitBranchPopMatchesQuery(text) {
    const q = gitBranchPopState.query.trim().toLowerCase();
    return !q || String(text || '').toLowerCase().includes(q);
}

function addGitBranchRow(btn, run) {
    btn.addEventListener('click', () => run());
    btn.classList.toggle('active', gitBranchRows.length === gitBranchPopState.active);
    deps.els.gbBody.appendChild(btn);
    gitBranchRows.push({el: btn, run});
}

function addGitBranchAction(icon, label, shortcut, run) {
    const btn = gitBranchPopButton('gb-row gb-action');
    const ic = document.createElement('span');
    ic.className = 'gb-row-icon';
    ic.innerHTML = icon;
    const text = document.createElement('span');
    text.className = 'gb-row-label';
    text.textContent = label;
    btn.append(ic, text);
    if (shortcut) {
        const key = document.createElement('span');
        key.className = 'gb-row-key';
        key.textContent = shortcut;
        btn.appendChild(key);
    }
    addGitBranchRow(btn, run);
}

function addGitBranchGroup(key, label, count, indent, collapsible = true) {
    const collapsed = collapsible && gitBranchPopState.collapsed.has(key);
    const btn = gitBranchPopButton('gb-group' + (collapsed ? ' collapsed' : '') + (collapsible ? '' : ' gb-static'));
    btn.style.paddingLeft = 12 + indent * 14 + 'px';
    if (collapsible) {
        const chev = document.createElement('span');
        chev.className = 'gb-chev';
        chev.innerHTML = POP_ICONS.chevron;
        btn.appendChild(chev);
    }
    const name = document.createElement('span');
    name.className = 'gb-group-name';
    name.textContent = label;
    btn.appendChild(name);
    if (count != null) {
        const countEl = document.createElement('span');
        countEl.className = 'gb-group-count';
        countEl.textContent = String(count);
        btn.appendChild(countEl);
    }
    if (collapsible) {
        btn.addEventListener('click', () => {
            if (gitBranchPopState.collapsed.has(key)) gitBranchPopState.collapsed.delete(key);
            else gitBranchPopState.collapsed.add(key);
            renderGitBranchPopover();
        });
    }
    deps.els.gbBody.appendChild(btn);
}

function addGitBranchRowItem(branch, remote, indent) {
    const btn = gitBranchPopButton('gb-row gb-branch' + (branch.current ? ' current' : ''));
    btn.style.paddingLeft = 12 + indent * 14 + 'px';
    const ic = document.createElement('span');
    ic.className = 'gb-row-icon';
    ic.innerHTML = branch.current ? POP_ICONS.check : POP_ICONS.branch;
    const label = document.createElement('span');
    label.className = 'gb-row-label';
    label.textContent = branch.name;
    btn.append(ic, label);
    const meta = document.createElement('span');
    meta.className = 'gb-row-meta';
    if (!remote) {
        if (branch.gone) {
            const gone = document.createElement('span');
            gone.className = 'gb-gone';
            gone.textContent = '上游已删除';
            meta.appendChild(gone);
        } else if (branch.upstream) {
            const up = document.createElement('span');
            up.textContent = branch.upstream;
            meta.appendChild(up);
        }
        if (branch.ahead > 0) {
            const ahead = document.createElement('span');
            ahead.className = 'gb-ahead';
            ahead.textContent = '↑' + branch.ahead;
            ahead.title = '领先上游 ' + branch.ahead + ' 个提交';
            meta.appendChild(ahead);
        }
        if (branch.behind > 0) {
            const behind = document.createElement('span');
            behind.className = 'gb-behind';
            behind.textContent = '↓' + branch.behind;
            behind.title = '落后上游 ' + branch.behind + ' 个提交';
            meta.appendChild(behind);
        }
    }
    if (meta.childNodes.length) btn.appendChild(meta);
    btn.title = remote ? '签出远程分支 ' + branch.name + '（自动创建本地跟踪分支）' : '签出 ' + branch.name;
    addGitBranchRow(btn, () => gitPopCheckout(branch, remote));
}

function addGitBranchTag(name) {
    const btn = gitBranchPopButton('gb-row gb-tag');
    const ic = document.createElement('span');
    ic.className = 'gb-row-icon';
    ic.innerHTML = POP_ICONS.tag;
    const label = document.createElement('span');
    label.className = 'gb-row-label';
    label.textContent = name;
    btn.append(ic, label);
    btn.title = '签出标记 ' + name;
    addGitBranchRow(btn, () => gitPopCheckoutRefValue(name));
}

function addGitBranchSep() {
    const sep = document.createElement('div');
    sep.className = 'gb-sep';
    deps.els.gbBody.appendChild(sep);
}

function addGitBranchState(text, isError) {
    const state = document.createElement('div');
    state.className = 'gb-state' + (isError ? ' error' : '');
    state.textContent = text;
    deps.els.gbBody.appendChild(state);
}

function gitBranchCountTree(node) {
    let count = node.branches.length;
    for (const child of node.children.values()) count += gitBranchCountTree(child);
    return count;
}

function gitBranchBuildTree(branches) {
    const root = {children: new Map(), branches: []};
    for (const branch of branches) {
        const parts = String(branch.name || '').split('/');
        let node = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const key = parts[i];
            if (!node.children.has(key)) node.children.set(key, {children: new Map(), branches: []});
            node = node.children.get(key);
        }
        node.branches.push(branch);
    }
    return root;
}

function gitBranchRenderTree(node, depth, prefix) {
    const groups = Array.from(node.children.entries()).sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));
    for (const [name, child] of groups) {
        const full = prefix ? prefix + '/' + name : name;
        const key = 'localp:' + full;
        addGitBranchGroup(key, name, gitBranchCountTree(child), depth, true);
        if (!gitBranchPopState.collapsed.has(key)) gitBranchRenderTree(child, depth + 1, full);
    }
    const branches = node.branches.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    for (const branch of branches) addGitBranchRowItem(branch, false, depth);
}

function renderGitBranchPopover() {
    if (!deps.els.gbBody || !gitBranchPopState.open) return;
    const body = deps.els.gbBody;
    body.textContent = '';
    gitBranchRows = [];
    gitBranchPopState.active = -1;
    const state = gitBranchPopState;
    if (state.loading && !state.data) {
        addGitBranchState('正在读取分支…');
        positionToolbarPopover(deps.els.gitBranchPop, state.anchor);
        return;
    }
    if (state.error) {
        addGitBranchState(state.error, true);
        positionToolbarPopover(deps.els.gitBranchPop, state.anchor);
        return;
    }
    const data = state.data;
    if (!data) {
        addGitBranchState('正在读取分支…');
        return;
    }
    if (!data.available) {
        addGitBranchState(data.reason || '当前目录不在 Git 仓库内');
        positionToolbarPopover(deps.els.gitBranchPop, state.anchor);
        return;
    }
    const q = state.query.trim().toLowerCase();
    const matches = (text) => !q || String(text || '').toLowerCase().includes(q);
    const allActions = [
        {icon: POP_ICONS.update, label: '更新项目…', shortcut: 'Ctrl+T', run: gitPopUpdateProject},
        {icon: POP_ICONS.commit, label: '提交…', shortcut: 'Ctrl+K', run: gitPopOpenCommit},
        {icon: POP_ICONS.push, label: '推送…', shortcut: 'Ctrl+Shift+K', run: gitPopPush},
        {sep: true},
        {icon: POP_ICONS.plus, label: '新建分支…', shortcut: 'Ctrl+Alt+N', run: gitPopNewBranch},
        {icon: POP_ICONS.tag, label: '签出标记或修订…', run: gitPopCheckoutRef},
    ];
    const actions = q ? allActions.filter((action) => !action.sep && matches(action.label)) : allActions;
    for (const action of actions) {
        if (action.sep) addGitBranchSep();
        else addGitBranchAction(action.icon, action.label, action.shortcut, action.run);
    }
    const localAll = data.local || [];
    const local = localAll.filter((b) => matches(b.name));
    const remote = (data.remote || []).filter((b) => matches(b.name));
    const tags = (data.tags || []).filter((t) => matches(t));
    const recentNames = new Set(data.recent || []);
    const recent = localAll.filter((b) => recentNames.has(b.name) && !b.current && matches(b.name));
    let groupsRendered = 0;
    if (recent.length) {
        if (q) addGitBranchGroup('recent', '最近', recent.length, 0, false);
        else addGitBranchGroup('recent', '最近', recent.length, 0, true);
        if (q || !state.collapsed.has('recent')) {
            for (const branch of recent) addGitBranchRowItem(branch, false, 0);
        }
        groupsRendered++;
    }
    if (local.length) {
        if (q) {
            addGitBranchGroup('local', '本地', local.length, 0, false);
            for (const branch of local) addGitBranchRowItem(branch, false, 0);
        } else {
            addGitBranchGroup('local', '本地', local.length, 0, true);
            if (!state.collapsed.has('local')) gitBranchRenderTree(gitBranchBuildTree(local), 0, '');
        }
        groupsRendered++;
    }
    if (remote.length) {
        addGitBranchGroup('remote', '远程', remote.length, 0, !q);
        if (q || !state.collapsed.has('remote')) {
            for (const branch of remote) addGitBranchRowItem(branch, true, 0);
        }
        groupsRendered++;
    }
    if (tags.length) {
        addGitBranchGroup('tags', '标签', tags.length, 0, !q);
        if (q || !state.collapsed.has('tags')) {
            for (const tag of tags) addGitBranchTag(tag);
        }
        groupsRendered++;
    }
    if (!groupsRendered) {
        addGitBranchState(q ? '没有匹配的分支或操作' : '仓库里还没有可用的分支');
    }
    positionToolbarPopover(deps.els.gitBranchPop, state.anchor);
}

async function loadGitBranches(includeRemote) {
    if (!deps.backend.GitBranchesFor) return;
    const dir = gitBranchPopDir();
    if (!dir) return;
    gitBranchPopState.loading = true;
    if (!gitBranchPopState.data) renderGitBranchPopover();
    try {
        const data = await deps.backend.GitBranchesFor(dir, !!includeRemote);
        if (data && data.available) {
            if (includeRemote) {
                gitBranchCache.remote = data.remote || [];
                gitBranchCache.hasRemote = true;
            } else {
                data.remote = gitBranchCache.remote || [];
            }
            gitBranchCache.dir = dir;
            gitBranchCache.result = data;
        } else {
            gitBranchCache.dir = '';
            gitBranchCache.remote = [];
            gitBranchCache.hasRemote = false;
            gitBranchCache.result = null;
        }
        gitBranchPopState.data = data;
        gitBranchPopState.error = '';
    } catch (e) {
        const message = '读取分支失败：' + ((e && e.message) || e);
        if (gitBranchPopState.data) deps.flash(message, true);
        else gitBranchPopState.error = message;
    }
    gitBranchPopState.loading = false;
    if (gitBranchPopState.open) renderGitBranchPopover();
}

function showBranchMenu(anchor) {
    if (!deps.els.gitBranchPop) return;
    if (isToolbarPopOpen(deps.els.gitBranchPop)) {
        closeGitBranchPopover();
        return;
    }
    closeProjectPopover();
    const dir = deps.gitRootDir();
    if (!dir) {
        deps.flash('请先打开文件或目录', true);
        return;
    }
    if (!deps.backend.GitBranchesFor) {
        deps.flash('当前版本不支持 Git 分支管理', true);
        return;
    }
    const cached = gitBranchCache.result && deps.samePathValue(gitBranchCache.dir, dir) && gitBranchCache.result.available
        ? gitBranchCache.result
        : null;
    gitBranchPopState.open = true;
    gitBranchPopState.loading = true;
    gitBranchPopState.data = cached;
    gitBranchPopState.error = '';
    gitBranchPopState.query = '';
    gitBranchPopState.active = -1;
    gitBranchPopState.dir = dir;
    gitBranchPopState.anchor = anchor;
    gitBranchRows = [];
    deps.els.gbSearch.value = '';
    deps.els.gbBody.textContent = '';
    deps.els.gitBranchPop.classList.remove('hidden');
    if (cached) {
        renderGitBranchPopover();
    } else {
        addGitBranchState('正在读取分支…');
        positionToolbarPopover(deps.els.gitBranchPop, anchor);
    }
    deps.els.gbSearch.focus();
    loadGitBranches(!cached || !gitBranchCache.hasRemote);
}

function gitBranchMoveActive(delta) {
    if (!gitBranchRows.length) return;
    let next = gitBranchPopState.active + delta;
    if (gitBranchPopState.active < 0) next = delta > 0 ? 0 : gitBranchRows.length - 1;
    next = Math.max(0, Math.min(gitBranchRows.length - 1, next));
    gitBranchPopState.active = next;
    gitBranchRows.forEach((row, i) => row.el.classList.toggle('active', i === next));
    gitBranchRows[next].el.scrollIntoView({block: 'nearest'});
}

function gitBranchRunActive() {
    const row = gitBranchRows[gitBranchPopState.active];
    if (row) row.run();
}

function openGitOutput(name, output) {
    deps.openVirtualDoc(name, output || '（命令没有输出）');
}

async function gitPopCheckout(branch, remote) {
    const dir = gitBranchPopDir();
    const name = branch.name;
    closeGitBranchPopover();
    if (branch.current) return;
    deps.flash('正在切换到 ' + name + '…');
    try {
        const res = await deps.backend.GitCheckoutBranch(dir, name, !!remote);
        if (!res || !res.success) {
            deps.flash('切换分支失败', true);
            if (res && res.output) openGitOutput('切换分支失败.txt', res.output);
            return;
        }
        deps.flash('已切换到分支：' + (res.branch || name));
        await deps.refreshGitStatus();
        await deps.reloadAllFromDisk();
    } catch (e) {
        deps.flash('切换分支失败：' + e, true);
    }
}

async function gitPopUpdateProject() {
    const dir = gitBranchPopDir();
    closeGitBranchPopover();
    if (!deps.backend.GitPullFor) return;
    deps.flash('正在更新项目…');
    try {
        const res = await deps.backend.GitPullFor(dir);
        if (!res || !res.success) {
            deps.flash('更新项目失败', true);
            if (res && res.output) openGitOutput('更新项目失败.txt', res.output);
            return;
        }
        deps.flash('项目已更新');
        invalidateGitBranchRemoteCache();
        await deps.refreshGitStatus();
        await deps.reloadAllFromDisk();
    } catch (e) {
        deps.flash('更新项目失败：' + e, true);
    }
}

function gitPopOpenCommit() {
    closeGitBranchPopover();
    deps.settings.showSidebar = true;
    deps.switchSidebarView('git');
    setTimeout(() => {
        if (deps.els.gitMessage) deps.els.gitMessage.focus();
    }, 80);
}

async function gitPopPush() {
    const dir = gitBranchPopDir();
    closeGitBranchPopover();
    if (!deps.backend.GitPushFor) return;
    deps.flash('正在推送…');
    try {
        const res = await deps.backend.GitPushFor(dir);
        if (!res || !res.success) {
            deps.flash('推送失败', true);
            if (res && res.output) openGitOutput('推送失败.txt', res.output);
            return;
        }
        deps.flash('已推送当前分支');
        invalidateGitBranchRemoteCache();
        await deps.refreshGitStatus();
    } catch (e) {
        deps.flash('推送失败：' + e, true);
    }
}

function gitPopNewBranch() {
    const dir = gitBranchPopDir();
    closeGitBranchPopover();
    if (!deps.backend.GitCreateBranch) {
        deps.flash('当前版本不支持新建分支', true);
        return;
    }
    deps.openNameDialog({
        title: '新建分支',
        label: '分支名称',
        placeholder: 'feature/my-branch',
        okLabel: '创建并检出',
        onSubmit: async (value) => {
            const name = String(value || '').trim();
            if (!name) throw new Error('请输入分支名');
            const res = await deps.backend.GitCreateBranch(dir, name);
            if (!res || !res.success) throw new Error((res && res.output) || '创建分支失败');
            deps.flash('已创建并切换到分支：' + name);
            await deps.refreshGitStatus();
        },
    });
}

function gitPopCheckoutRefValue(ref) {
    const dir = gitBranchPopDir();
    closeGitBranchPopover();
    if (!deps.backend.GitCheckoutRefFor) {
        deps.flash('当前版本不支持签出标记或修订', true);
        return;
    }
    deps.flash('正在签出 ' + ref + '…');
    deps.backend.GitCheckoutRefFor(dir, ref).then(async (res) => {
        if (!res || !res.success) {
            deps.flash('签出失败', true);
            if (res && res.output) openGitOutput('签出失败.txt', res.output);
            return;
        }
        deps.flash('已签出：' + ref);
        await deps.refreshGitStatus();
        await deps.reloadAllFromDisk();
    }).catch((e) => deps.flash('签出失败：' + e, true));
}

function gitPopCheckoutRef() {
    const dir = gitBranchPopDir();
    closeGitBranchPopover();
    if (!deps.backend.GitCheckoutRefFor) {
        deps.flash('当前版本不支持签出标记或修订', true);
        return;
    }
    deps.openNameDialog({
        title: '签出标记或修订',
        label: '分支、标记或提交 SHA',
        placeholder: 'v1.0.0 / 1a2b3c4 / feature/x',
        okLabel: '签出',
        onSubmit: async (value) => {
            const ref = String(value || '').trim();
            if (!ref) throw new Error('请输入分支、标记或提交 SHA');
            const res = await deps.backend.GitCheckoutRefFor(dir, ref);
            if (!res || !res.success) throw new Error((res && res.output) || '签出失败');
            deps.flash('已签出：' + ref);
            await deps.refreshGitStatus();
            await deps.reloadAllFromDisk();
        },
    });
}

async function gitPopFetch() {
    if (!gitBranchPopState.open || gitBranchPopState.loading || !deps.backend.GitFetchFor) return;
    if (deps.els.gbFetch) {
        deps.els.gbFetch.disabled = true;
        deps.els.gbFetch.classList.add('active');
    }
    try {
        const res = await deps.backend.GitFetchFor(gitBranchPopDir());
        if (!res || !res.success) {
            closeGitBranchPopover();
            deps.flash('获取远程分支失败', true);
            if (res && res.output) openGitOutput('获取远程分支失败.txt', res.output);
            return;
        }
        deps.flash('已获取远程分支');
        await loadGitBranches(true);
    } catch (e) {
        deps.flash('获取远程分支失败：' + e, true);
    } finally {
        if (deps.els.gbFetch) {
            deps.els.gbFetch.disabled = false;
            deps.els.gbFetch.classList.remove('active');
        }
    }
}

function gitPopTogglePin() {
    gitBranchPopState.pinned = !gitBranchPopState.pinned;
    if (deps.els.gbPin) {
        deps.els.gbPin.classList.toggle('active', gitBranchPopState.pinned);
        deps.els.gbPin.setAttribute('aria-pressed', String(gitBranchPopState.pinned));
        deps.els.gbPin.title = gitBranchPopState.pinned ? '取消固定窗口' : '固定窗口（点击外部不关闭）';
    }
}

if (deps.els.gbSearch) {
    deps.els.gbSearch.addEventListener('input', () => {
        gitBranchPopState.query = deps.els.gbSearch.value;
        renderGitBranchPopover();
    });
    deps.els.gbSearch.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            gitBranchMoveActive(1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            gitBranchMoveActive(-1);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            gitBranchRunActive();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeGitBranchPopover();
        }
    });
}
if (deps.els.gbFetch) deps.els.gbFetch.addEventListener('click', gitPopFetch);
if (deps.els.gbPin) deps.els.gbPin.addEventListener('click', gitPopTogglePin);

document.addEventListener('pointerdown', (e) => {
    const target = e.target;
    if (isToolbarPopOpen(deps.els.projectPop) && !deps.els.projectPop.contains(target) && !deps.els.wsProject.contains(target)) {
        closeProjectPopover();
    }
    if (isToolbarPopOpen(deps.els.gitBranchPop) && !deps.els.gitBranchPop.contains(target) && !deps.els.wsBranch.contains(target) && !gitBranchPopState.pinned) {
        closeGitBranchPopover();
    }
}, true);

document.addEventListener('keydown', (e) => {
    if (isToolbarPopOpen(deps.els.projectPop) && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeProjectPopover();
        return;
    }
    if (!gitBranchPopState.open) return;
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeGitBranchPopover();
        return;
    }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        if (deps.els.gbSearch) {
            deps.els.gbSearch.focus();
            deps.els.gbSearch.select();
        }
    }
}, true);

window.addEventListener('blur', () => {
    closeProjectPopover();
    closeGitBranchPopover();
});
window.addEventListener('resize', () => {
    closeProjectPopover();
    closeGitBranchPopover();
});

    return {closeGitBranchPopover, gitPopNewBranch, gitPopOpenCommit, gitPopPush, gitPopUpdateProject, showBranchMenu, showProjectMenu};
}
