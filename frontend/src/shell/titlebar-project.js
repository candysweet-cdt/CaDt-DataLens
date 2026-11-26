// 标题栏项目弹层：当前项目、项目切换、克隆仓库与 reveal 到资源管理器。
// 从 titlebar-popovers.js 拆出；定位工具与 SVG 常量由宿主经 deps 注入。
import {overlayStack} from '../core/overlay-stack.js';
import {legacyPathKey} from '../core/path-key.js';

export function createTitlebarProject(deps) {

let projStackHandle = null;

function closeProjectPopover() {
    if (!deps.els.projectPop) return;
    if (projStackHandle) {
        projStackHandle.dispose();
        projStackHandle = null;
    }
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
    pathEl.dataset.tip = path;
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
    appendProjectAction(body, deps.POP_ICONS.folder, '打开…', () => {
        closeProjectPopover();
        deps.openFolderDialog();
    });
    appendProjectAction(body, deps.POP_ICONS.branch, '克隆仓库…', () => {
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
        reveal.innerHTML = deps.POP_ICONS.reveal + '<span>在文件资源管理器中显示</span>';
        reveal.addEventListener('click', () => {
            closeProjectPopover();
            revealWorkspaceFolder();
        });
        body.appendChild(reveal);
    }
    const norm = (s) => legacyPathKey(s || '')
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
    if (deps.isToolbarPopOpen(deps.els.projectPop)) {
        closeProjectPopover();
        return;
    }
    deps.closeGitBranchPopover();
    renderProjectPopover();
    deps.els.projectPop.classList.remove('hidden');
    deps.positionToolbarPopover(deps.els.projectPop, anchor);
    // 进全局弹层栈（popover 档）：Esc 由栈按层序退
    if (projStackHandle) projStackHandle.dispose();
    projStackHandle = overlayStack.open({
        id: 'project-pop', kind: 'popover', el: deps.els.projectPop,
        onClose: () => { closeProjectPopover(); return true; },
    });
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


return {closeProjectPopover, showProjectMenu};
}
