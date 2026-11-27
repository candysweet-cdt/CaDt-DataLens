// maven-panel.js：侧边栏「Maven」工具窗口——项目树（配置文件 / 生存期 / 子模块 / 依赖 / 插件 / 仓库）
// + 一键执行 + 任意 goal 弹窗 + 执行开关。纯函数在 maven-model.js；pom 结构来自 Go 的
// MavenProjectInfo，数据命令经 MavenData（原始文本，前端解析）；执行走运行通道 runCommand。

import {iconSvg} from '../core/icons.js';
import {createSwitch, createInput} from '../core/form-controls.js';
import {overlayStack} from '../core/overlay-stack.js';
import {
    MAVEN_LIFECYCLE,
    MAVEN_FLAG_DEFS,
    mavenFlagsOrDefaults,
    assembleMavenArgs,
    parseDependencyTreeText,
    parseEffectivePomPlugins,
    parseEffectiveSettings,
} from './maven-model.js';

// 数据命令超时：首次 effective-pom 可能要下载插件，给足余量（Go 侧另有 15 分钟硬上限）。
const DATA_TIMEOUT_MS = 180000;

function errText(e) {
    if (!e) return '未知错误';
    if (typeof e === 'string') return e;
    return e.message || String(e);
}

export function createMavenPanel(deps) {
    // 触发判定缓存：key = workspaceFolder。done=false 表示还在算。
    let trigger = {key: undefined, done: false, ok: false, reason: '', root: ''};
    let projectInfo = null; // MavenProjectInfo 结果（root 维度缓存，手动刷新清）
    let infoKey = '';
    let expanded = new Set(['files', 'proj', 'life:']);
    let loading = new Set(); // 惰性加载中的节点 id
    let errors = new Map(); // 节点 id -> 最近一次加载失败的文案
    let dataCache = new Map(); // 节点 id -> {kind, payload}（刷新清空）
    let cmdShellPath = '';
    let mvnPathCache = '';
    let renderSeq = 0;

    // ---------- 触发判定 ----------

    // pom 命中（纯 stat，零成本）→ 再惰性扫一次工具链并缓存（见方案 §4.1）。
    async function ensureTrigger() {
        const key = deps.workspaceFolder || '';
        if (trigger.done && trigger.key === key) return trigger.ok;
        // 代际守卫：mount() 的启动判定与切工作区的 syncTrigger 可能并发（首次工具链扫描要起
        // DetectToolchain 子进程，可耗时数秒）——完成时不校验归属，旧 key 的 ok/root 会写进
        // 新 key 的对象（非 Maven 工作区显示图标、渲染错项目）。完成前发现被换代就整体作废。
        const mine = {key, done: false, ok: false, reason: '', root: ''};
        trigger = mine;
        syncButton();
        let ok = false;
        let reason = '';
        try {
            if (!key) {
                reason = '打开一个 Maven 项目文件夹后，这里会显示它的配置文件、生存期、子模块与依赖。';
            } else {
                const info = await deps.backend.DetectRunProject(key);
                if (info && info.kind === 'Maven' && info.root) {
                    const tool = await deps.ensureToolchainForRun('java', 'maven');
                    if (tool && tool.path) {
                        ok = true;
                        mine.root = info.root;
                        mvnPathCache = tool.path;
                    } else {
                        reason = '本机还没扫描到 Maven：到 设置 → 编程语言 → Java 里扫描或手动指定 mvn 路径。';
                    }
                } else {
                    reason = '当前文件夹不是 Maven 项目（没有找到 pom.xml）。';
                }
            }
        } catch (e) {
            reason = errText(e);
        }
        if (trigger !== mine) return ok;
        mine.done = true;
        mine.ok = ok;
        mine.reason = reason;
        syncButton();
        // 触发失败但视图还停在 maven（重启恢复了残留的 sidebarView / 工作区刚被关）：
        // 自动退回 files，别让用户停在空面板上。
        if (!ok && typeof deps.currentSidebarView === 'function' && deps.currentSidebarView() === 'maven') {
            deps.exitMavenView();
        }
        return ok;
    }

    // 工作区切换 / 设置变更入口：按 key 去重重算，面板开着就顺手重绘。
    // H1：key 变化（切工作区）时必须清掉按 id 缓存的数据——dataCache/errors 的 id 不含 root，
    // 不清会让新项目展开「依赖项」时命中旧项目缓存，显示串味数据。
    function syncTrigger() {
        const before = trigger.key;
        ensureTrigger().then(() => {
            if (trigger.key !== before) resetCaches();
            syncButton();
            if (typeof deps.currentSidebarView === 'function' && deps.currentSidebarView() === 'maven') renderTree();
        }).catch(() => {});
    }

    // 清掉与具体项目绑定的缓存/展开态（保留 trigger 本身）
    function resetCaches() {
        projectInfo = null;
        infoKey = '';
        dataCache.clear();
        errors.clear();
        expanded = new Set(['files', 'proj', 'life:']);
        renderSeq++;
    }

    function syncButton() {
        const btn = deps.abButton;
        if (!btn) return;
        const key = deps.workspaceFolder || '';
        const ok = trigger.done && trigger.key === key && trigger.ok;
        btn.classList.toggle('hidden', !ok);
    }

    // ---------- 数据加载 ----------

    async function resolveMvnPath() {
        if (mvnPathCache) return mvnPathCache;
        const tool = await deps.ensureToolchainForRun('java', 'maven');
        if (!tool || !tool.path) {
            deps.flash('未检测到本机 Maven：到 设置 → 编程语言 → Java 里扫描或手动指定路径', true);
            return '';
        }
        mvnPathCache = tool.path;
        return mvnPathCache;
    }

    async function resolveCmdShell() {
        if (cmdShellPath) return cmdShellPath;
        try {
            const info = await deps.backend.ResolveRunShell('cmd');
            cmdShellPath = (info && info.path) || '';
        } catch (e) {
            cmdShellPath = '';
        }
        if (!cmdShellPath) deps.flash('无法解析 cmd.exe，Maven 命令起不来（设置 → 系统集成）', true);
        return cmdShellPath;
    }

    async function ensureProjectInfo() {
        const root = trigger.root;
        if (projectInfo && infoKey === root) return projectInfo;
        projectInfo = await deps.backend.MavenProjectInfo(root);
        infoKey = root;
        return projectInfo;
    }

    async function loadData(id, kind, rel) {
        if (dataCache.has(id) || loading.has(id)) return;
        const root = trigger.root;
        const seq = renderSeq;
        loading.add(id);
        renderTreeNow();
        try {
            const mvnPath = await resolveMvnPath();
            if (!mvnPath) throw new Error('未检测到本机 Maven');
            const text = await deps.backend.MavenData(root, mvnPath, DATA_TIMEOUT_MS, kind, rel);
            // M4：await 期间工作区切换/刷新 → 丢弃旧响应，不写缓存、不重绘
            if (root !== trigger.root || seq !== renderSeq) return;
            if (kind === 'dependency-tree') {
                dataCache.set(id, {kind, payload: parseDependencyTreeText(text)});
            } else if (kind === 'effective-pom') {
                dataCache.set(id, {kind, payload: parseEffectivePomPlugins(text)});
            } else {
                dataCache.set(id, {kind, payload: parseEffectiveSettings(text)});
            }
            errors.delete(id);
        } catch (e) {
            if (root !== trigger.root || seq !== renderSeq) return;
            errors.set(id, errText(e));
            deps.flash('Maven 数据加载失败：' + errText(e), true);
        } finally {
            loading.delete(id);
        }
        if (root === trigger.root && seq === renderSeq) renderTreeNow();
    }

    // ---------- 执行 ----------

    async function runGoal(rel, goal) {
        const root = trigger.root;
        if (!root || !goal || !String(goal).trim()) return;
        const mvnPath = await resolveMvnPath();
        if (!mvnPath) return;
        const shell = await resolveCmdShell();
        if (!shell) return;
        let args;
        try {
            args = assembleMavenArgs({flags: deps.settings.mavenFlags, goal, moduleRelPath: rel});
        } catch (e) {
            deps.flash(errText(e), true);
            return;
        }
        deps.runCommand({
            label: 'mvn ' + String(goal).trim() + (rel ? ' (' + rel + ')' : ''),
            exe: shell,
            args: ['/c', mvnPath, ...args],
            cwd: root,
        });
    }

    // ---------- 树渲染 ----------

    function rowEl(node) {
        const isOpen = expanded.has(node.id);
        const row = document.createElement('div');
        row.className = 'mv-row' + (node.group ? ' mv-group' : '');
        row.style.paddingLeft = (8 + (node.depth || 0) * 16) + 'px';
        const caret = document.createElement('span');
        caret.className = 'mv-caret' + (node.expandable ? '' : ' hidden');
        if (node.expandable) caret.innerHTML = iconSvg(isOpen ? 'chevron-down' : 'chevron-right', 12);
        const icon = document.createElement('span');
        icon.className = 'mv-icon';
        if (node.icon) icon.innerHTML = iconSvg(node.icon, 14);
        const label = document.createElement('span');
        label.className = 'mv-label';
        label.textContent = node.label;
        label.title = node.label;
        row.append(caret, icon, label);
        if (node.sub) {
            const sub = document.createElement('span');
            sub.className = 'mv-sub';
            sub.textContent = node.sub;
            sub.title = node.sub;
            row.append(sub);
        }
        if (node.expandable) {
            row.addEventListener('click', () => toggleNode(node));
        } else if (typeof node.action === 'function') {
            row.addEventListener('click', node.action);
        }
        return row;
    }

    function hintRow(depth, text) {
        const row = document.createElement('div');
        row.className = 'mv-hint';
        row.style.paddingLeft = (8 + depth * 16) + 'px';
        row.textContent = text;
        return row;
    }

    function toggleNode(node) {
        if (expanded.has(node.id)) {
            expanded.delete(node.id);
        } else {
            expanded.add(node.id);
            if (node.lazy) loadData(node.id, node.lazy, node.rel);
        }
        renderTreeNow();
    }

    function lifecycleGroup(rel) {
        return {
            id: 'life:' + rel,
            label: '生存期',
            group: true,
            expandable: true,
            depth: 0,
            children: MAVEN_LIFECYCLE.map((goal) => ({
                id: 'goal:' + rel + ':' + goal,
                icon: 'play',
                label: goal,
                depth: 1,
                action: () => runGoal(rel, goal),
            })),
        };
    }

    function lazyGroup(kind, rel, label, icon) {
        const id = kind + ':' + rel;
        return {
            id,
            label,
            icon,
            group: true,
            expandable: true,
            lazy: kind,
            rel,
            depth: 0,
            children: lazyChildren(id, kind, rel, 1),
        };
    }

    function lazyChildren(id, kind, rel, depth) {
        if (loading.has(id)) return [{hintText: '加载中…', depth}];
        if (errors.has(id)) return [{hintText: '加载失败：' + errors.get(id), depth}];
        const cached = dataCache.get(id);
        if (!cached) return []; // 展开时 loadData 补
        if (cached.kind === 'dependency-tree') {
            const rows = [];
            const walk = (nodes, d) => {
                for (const n of nodes) {
                    rows.push({
                        id: 'dep:' + d + ':' + n.label,
                        icon: '',
                        label: n.label,
                        sub: n.scope || '',
                        depth: d,
                        action: () => deps.copyText(n.label, '坐标'),
                    });
                    walk(n.children, d + 1);
                }
            };
            walk(cached.payload, depth);
            if (!rows.length) rows.push({hintText: '没有输出（该模块没有依赖声明？）', depth});
            return rows;
        }
        if (cached.kind === 'effective-pom') {
            const rows = cached.payload.map((p) => ({
                id: 'plugin:' + p.groupId + ':' + p.artifactId,
                icon: 'gear',
                label: p.artifactId,
                sub: p.version ? p.groupId + ':' + p.version : p.groupId,
                depth,
                action: () => deps.copyText(p.groupId + ':' + p.artifactId + (p.version ? ':' + p.version : ''), '插件坐标'),
            }));
            if (!rows.length) rows.push({hintText: '没有插件声明', depth});
            return rows;
        }
        const rows = [];
        if (cached.payload.localRepository) {
            rows.push({id: 'repo:local', icon: 'folder', label: 'local', sub: cached.payload.localRepository, depth, action: () => deps.copyText(cached.payload.localRepository, '本地仓库路径')});
        }
        for (const m of cached.payload.mirrors) {
            rows.push({id: 'repo:mirror:' + m.id, icon: 'globe', label: m.id + (m.mirrorOf ? ' → ' + m.mirrorOf : ''), sub: m.url, depth, action: () => deps.copyText(m.url, '镜像 URL')});
        }
        for (const r of cached.payload.repositories) {
            rows.push({id: 'repo:' + r.id, icon: 'globe', label: r.id, sub: r.url, depth, action: () => deps.copyText(r.url, '仓库 URL')});
        }
        if (!rows.length) rows.push({hintText: '没有仓库配置', depth});
        return rows;
    }

    function projectChildren(info, rel) {
        const kids = [
            lifecycleGroup(rel),
            lazyGroup('dependency-tree', rel, '依赖项', 'list'),
        ];
        if (!rel) {
            kids.push(lazyGroup('effective-pom', '', '插件', 'gear'));
            kids.push(lazyGroup('effective-settings', '', '仓库', 'globe'));
        }
        for (const mod of info.modules || []) {
            kids.push({
                id: 'mod:' + mod.relPath,
                icon: 'folder',
                label: mod.artifactId || mod.name,
                sub: mod.hasPom ? '' : '（没有 pom.xml）',
                expandable: !!mod.hasPom,
                depth: 0,
                children: mod.hasPom ? projectChildren(mod, mod.relPath) : [],
            });
        }
        return kids;
    }

    function buildNodes(info) {
        const nodes = [];
        const fileRows = [
            {id: 'file:pom', icon: 'doc', label: 'pom.xml', sub: '', depth: 1, action: () => deps.openPath(info.pomPath)},
        ];
        if (info.settingsExists && info.settingsPath) {
            fileRows.push({id: 'file:settings', icon: 'doc', label: 'settings.xml', sub: '~/.m2', depth: 1, action: () => deps.openPath(info.settingsPath)});
        }
        nodes.push({id: 'files', label: '配置文件', group: true, expandable: true, depth: 0, children: fileRows});
        const projLabel = info.name || info.artifactId;
        nodes.push({
            id: 'proj',
            icon: 'maven',
            label: projLabel,
            sub: projLabel !== info.artifactId ? info.artifactId : '',
            expandable: true,
            depth: 0,
            children: projectChildren(info, ''),
        });
        return nodes;
    }

    function appendNodes(container, nodes) {
        for (const n of nodes) {
            if (n.hintText !== undefined) {
                container.appendChild(hintRow(n.depth || 0, n.hintText));
                continue;
            }
            container.appendChild(rowEl(n));
            if (n.children && expanded.has(n.id)) appendNodes(container, n.children);
        }
    }

    function renderTreeNow() {
        const el = deps.treeEl;
        if (!el) return;
        el.textContent = '';
        if (!trigger.done) {
            el.appendChild(hintRow(0, '正在识别 Maven 项目…'));
            return;
        }
        if (!trigger.ok) {
            const gate = document.createElement('div');
            gate.className = 'mv-gate';
            const icon = document.createElement('div');
            icon.innerHTML = iconSvg('maven', 30);
            const text = document.createElement('div');
            text.textContent = trigger.reason || '这里还没有可显示的 Maven 项目。';
            gate.append(icon, text);
            el.appendChild(gate);
            return;
        }
        if (!projectInfo || infoKey !== trigger.root) {
            el.appendChild(hintRow(0, '正在读取项目结构…'));
            return;
        }
        appendNodes(el, buildNodes(projectInfo));
    }

    async function renderTree() {
        const seq = ++renderSeq;
        await ensureTrigger();
        if (seq !== renderSeq) return;
        if (!trigger.ok || !trigger.root) {
            renderTreeNow();
            return;
        }
        try {
            await ensureProjectInfo();
        } catch (e) {
            // 陈旧调用的失败不污染新一轮状态：先判代再写共享 trigger
            if (seq !== renderSeq) return;
            trigger.ok = false;
            trigger.reason = '读取项目结构失败：' + errText(e);
        }
        if (seq !== renderSeq) return;
        renderTreeNow();
    }

    function refresh() {
        trigger = {key: deps.workspaceFolder || '', done: false, ok: false, reason: '', root: ''};
        resetCaches();
        renderTree();
    }

    // 设置变更入口（settings-changed → main.js）：设置页补扫了 Maven 后不用切工作区就能让
    // 图标出现。与 syncTrigger 的区别是不做 key 去重——上次失败可能正是「工具链没扫」这类
    // 可被设置修复的原因；但已就绪（图标已显示且 key 未变）时跳过，避免无关设置变更白起探测。
    function revalidate() {
        if (trigger.done && trigger.ok && trigger.key === (deps.workspaceFolder || '')) return;
        trigger = {key: deps.workspaceFolder || '', done: false, ok: false, reason: '', root: ''};
        syncButton();
        ensureTrigger().then(() => syncButton()).catch(() => {});
    }

    // ---------- goal 弹窗（overlay-stack 注册，Esc 按层退） ----------

    function openGoalDialog() {
        const wrap = document.createElement('div');
        wrap.className = 'maven-goal-dialog';
        const box = document.createElement('div');
        box.className = 'maven-goal-box';
        const title = document.createElement('div');
        title.className = 'maven-goal-title';
        title.textContent = '执行 Maven 目标';
        const hint = document.createElement('div');
        hint.className = 'maven-goal-hint';
        hint.textContent = '输入 goal 与参数，空格分隔：如 clean package -DskipTests 或 org.example:plugin:1.0:go。在项目根执行，走运行面板输出。';
        const input = createInput({placeholder: 'clean package', attrs: {spellcheck: 'false'}});
        const actions = document.createElement('div');
        actions.className = 'maven-goal-actions';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'dlg-btn';
        cancel.textContent = '取消';
        const run = document.createElement('button');
        run.type = 'button';
        run.className = 'dlg-btn primary';
        run.textContent = '运行';
        actions.append(cancel, run);
        box.append(title, hint, input.element, actions);
        wrap.append(box);
        let handle = null;
        const close = () => {
            if (handle) handle.dispose();
        };
        handle = overlayStack.open({
            id: 'maven-goal-dialog',
            kind: 'dialog',
            el: wrap,
            onClose: () => {
                handle = null;
            },
            closeOnOutsideClick: true,
        });
        cancel.addEventListener('click', close);
        run.addEventListener('click', () => {
            const text = input.control.value;
            close();
            runGoal('', text);
        });
        input.control.focus();
    }

    // ---------- 执行开关行（偏好键 settings.mavenFlags，走 persistSettingsLight 通道） ----------

    function renderFlags() {
        const el = deps.flagsEl;
        if (!el) return;
        const flags = mavenFlagsOrDefaults(deps.settings);
        el.textContent = '';
        el.classList.remove('hidden');
        for (const def of MAVEN_FLAG_DEFS) {
            const wrap = document.createElement('span');
            wrap.className = 'maven-flag';
            const sw = createSwitch({
                checked: flags[def.id],
                title: def.tip,
                onChange: () => {
                    deps.settings.mavenFlags = {
                        ...mavenFlagsOrDefaults(deps.settings),
                        [def.id]: sw.control.checked,
                    };
                    deps.persistSettingsLight();
                },
            });
            const label = document.createElement('span');
            label.textContent = def.label;
            label.title = def.tip;
            wrap.append(sw.element, label);
            el.append(wrap);
        }
    }

    // ---------- 装配 ----------

    function mount() {
        const refreshBtn = deps.refreshBtn;
        const goalBtn = deps.goalBtn;
        if (refreshBtn && !refreshBtn.dataset.mavenWired) {
            refreshBtn.dataset.mavenWired = '1';
            refreshBtn.innerHTML = iconSvg('refresh', 16);
            refreshBtn.addEventListener('click', refresh);
        }
        if (goalBtn && !goalBtn.dataset.mavenWired) {
            goalBtn.dataset.mavenWired = '1';
            goalBtn.innerHTML = iconSvg('play', 16);
            goalBtn.addEventListener('click', openGoalDialog);
        }
        renderFlags();
        syncButton();
        ensureTrigger().then(() => syncButton()).catch(() => {});
    }

    return {mount, renderTree, syncTrigger, syncButton, refresh, revalidate};
}
