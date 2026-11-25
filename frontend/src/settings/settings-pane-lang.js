// 设置 → 格式与语言：格式表、语言/工具链扫描与包管理、fmtSize 等格式化助手。
// 从 writing-ui.js 拆出；视图模型（deps.LANG_DEFS/deps.ENCODINGS/deps.INDENTS/deps.EOLS/viewOptionsFor）与 makeSelect 由宿主注入。
import {formats} from '../core/formats.js';

// 全空判定：所有语言的全部工具都没有扫描结果、也没有任何一项在扫 → 返回全语言扫描
// 清单（首次打开「编程语言」时自动触发一次）；只要有任何一条结果或在扫，返回 null，
// 走各语言自己 pane 的首开补扫。readEnv(langId, toolId) 只读读取，缺档视为未扫。
export function firstFullScanRuns(langDefs, readEnv) {
    const langs = Array.isArray(langDefs) ? langDefs : [];
    const runs = [];
    for (const lang of langs) {
        for (const tool of lang.tools || []) {
            const env = readEnv(lang.id, tool.id);
            if (env && (env.scannedAt || env.scanning)) return null;
            runs.push({langId: lang.id, toolId: tool.id});
        }
    }
    return runs;
}

export function createSettingsPaneLang(deps) {

function setupFormatSettings() {
    const children = document.querySelector('#snav-formats .snav-children');
    const content = document.querySelector('.settings-content');
    if (!children || !content) return;
    for (const f of deps.allFormatDefs()) {
        if (children.querySelector(`[data-pane="fmt-${f.id}"]`)) continue;
        const nav = document.createElement('button');
        nav.type = 'button';
        nav.className = 'snav-item snav-child snav-fmt';
        nav.dataset.pane = 'fmt-' + f.id;
        nav.textContent = f.name;
        children.appendChild(nav);
        if (!content.querySelector(`.settings-pane[data-pane="fmt-${f.id}"]`)) {
            const pane = document.createElement('div');
            pane.className = 'settings-pane hidden';
            pane.dataset.pane = 'fmt-' + f.id;
            content.appendChild(pane);
        }
    }
}

function setupLanguageSettings() {
    const children = document.getElementById('snav-lang-children');
    const content = document.querySelector('.settings-content');
    if (!children || !content) return;
    for (const lang of deps.LANG_DEFS) {
        if (children.querySelector(`[data-pane="lang-${lang.id}"]`)) continue;
        const nav = document.createElement('button');
        nav.type = 'button';
        nav.className = 'snav-item snav-child snav-lang';
        nav.dataset.pane = 'lang-' + lang.id;
        nav.textContent = lang.name;
        children.appendChild(nav);
        if (!content.querySelector(`.settings-pane[data-pane="lang-${lang.id}"]`)) {
            const pane = document.createElement('div');
            pane.className = 'settings-pane hidden';
            pane.dataset.pane = 'lang-' + lang.id;
            content.appendChild(pane);
        }
    }
}

// 每个语言的环境状态按工具拆分存放在 settings.langEnv[id].tools[toolId]
function langEnvFor(id) {
    if (!deps.settings.langEnv || typeof deps.settings.langEnv !== 'object') deps.settings.langEnv = {};
    const entry = deps.settings.langEnv[id];
    if (!entry || typeof entry !== 'object') {
        deps.settings.langEnv[id] = {tools: {}};
    } else if (Array.isArray(entry.envs) && !entry.tools) {
        // 旧结构迁移：语言级缓存挪到该语言的主工具下
        const lang = deps.LANG_DEFS.find((l) => l.id === id);
        const primary = lang && lang.tools && lang.tools[0] ? lang.tools[0].id : id;
        const migrated = {
            envs: entry.envs,
            selectedPath: entry.selectedPath || '',
            pathOverride: entry.pathOverride || '',
            scannedAt: entry.scannedAt || 0,
        };
        deps.settings.langEnv[id] = {tools: {}};
        deps.settings.langEnv[id].tools[primary] = migrated;
    }
    if (!deps.settings.langEnv[id].tools || typeof deps.settings.langEnv[id].tools !== 'object') deps.settings.langEnv[id].tools = {};
    return deps.settings.langEnv[id];
}

function toolEnvFor(id, toolId) {
    const e = langEnvFor(id);
    if (!e.tools[toolId] || typeof e.tools[toolId] !== 'object') e.tools[toolId] = {};
    return e.tools[toolId];
}

// 只读读取（不建空档）：全空判定用，避免为没打开过的语言预创建空工具条目
function readLangToolEnv(id, toolId) {
    const entry = deps.settings.langEnv && deps.settings.langEnv[id];
    const tools = entry && entry.tools;
    return (tools && tools[toolId]) || null;
}

// effectiveToolEnv 当前生效的环境：手动指定 > 手动选择 > 默认第一个
function effectiveToolEnv(id, toolId) {
    const env = toolEnvFor(id, toolId);
    const list = Array.isArray(env.envs) ? env.envs : [];
    if (env.pathOverride) {
        const hit = list.find((x) => x.path && String(x.path).toLowerCase() === env.pathOverride.toLowerCase());
        if (hit) return hit;
        return {ok: false, path: env.pathOverride, error: env.error || '指定的路径不可用'};
    }
    const hit = env.selectedPath ? list.find((x) => x.path && String(x.path).toLowerCase() === env.selectedPath.toLowerCase()) : null;
    return hit || list[0] || {ok: false, error: env.error || '未找到可用环境'};
}

function renderLangPane(id) {
    const lang = deps.LANG_DEFS.find((l) => l.id === id);
    const pane = document.querySelector(`.settings-pane[data-pane="lang-${id}"]`);
    if (!lang || !pane) return;
    pane.textContent = '';
    const title = document.createElement('div');
    title.className = 'fmt-pane-title';
    title.textContent = lang.name;
    const sub = document.createElement('div');
    sub.className = 'fmt-pane-sub';
    sub.textContent = '环境信息（解释器 / 编译器与配套工具链的路径和版本），缓存到本地；按 F5 运行当前文件时用的就是这里选中的环境';
    pane.append(title, sub);
    // 正交维度互跳：这里配「环境在哪」，运行方式（命令模板 / 运行配置）在「运行」页
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'dlg-btn';
    jump.setAttribute('data-open-pane', 'run');
    jump.textContent = '命令模板 / 运行配置…';
    jump.style.margin = '6px 0';
    pane.appendChild(jump);

    for (const tool of lang.tools) {
        const env = toolEnvFor(id, tool.id);
        const list = Array.isArray(env.envs) ? env.envs : [];
        const eff = effectiveToolEnv(id, tool.id);

        const sec = document.createElement('div');
        sec.className = 'env-tool';

        const head = document.createElement('div');
        head.className = 'env-tool-head';
        const dot = document.createElement('span');
        dot.className = 'env-dot' + (env.scanning ? ' busy' : (env.scannedAt ? (eff && eff.ok ? ' ok' : (tool.optional ? '' : ' fail')) : ''));
        const headText = document.createElement('span');
        headText.textContent = tool.name + (tool.optional ? '（可选）' : '');
        head.append(dot, headText);
        sec.appendChild(head);

        // 多环境选择框：扫描出多个时默认选第一个，可手动切换
        if (list.length) {
            const sel = document.createElement('select');
            sel.className = 'env-select';
            for (const e of list) {
                const opt = document.createElement('option');
                opt.value = e.path || '';
                opt.textContent = (e.version ? e.version + ' ｜ ' : '') + (e.path || '');
                sel.appendChild(opt);
            }
            if (eff && eff.path && list.some((e) => e.path === eff.path)) sel.value = eff.path;
            if (env.pathOverride) {
                sel.disabled = true;
                sel.dataset.tip = '手动指定路径时忽略此选择';
            }
            sel.addEventListener('change', () => {
                env.selectedPath = sel.value;
                deps.applySettings();
                if (id === 'python') resetLangPkgs(id);
                renderLangPane(id);
            });
            sec.appendChild(sel);
        }

        const body = document.createElement('div');
        body.className = 'env-status';
        if (env.scanning) {
            const line = document.createElement('div');
            line.className = 'env-meta';
            line.textContent = '正在扫描…';
            body.appendChild(line);
        } else if (!env.scannedAt) {
            const line = document.createElement('div');
            line.className = 'env-meta';
            line.textContent = '未检测';
            body.appendChild(line);
        } else if (eff && eff.ok) {
            const vRow = document.createElement('div');
            vRow.className = 'env-status-row';
            const vk = document.createElement('span');
            vk.className = 'env-status-key';
            vk.textContent = '版本';
            const vv = document.createElement('span');
            vv.className = 'env-status-val';
            vv.textContent = eff.version || '';
            vRow.append(vk, vv);
            body.appendChild(vRow);
            const pRow = document.createElement('div');
            pRow.className = 'env-status-row';
            const pk = document.createElement('span');
            pk.className = 'env-status-key';
            pk.textContent = '路径';
            const pv = document.createElement('span');
            pv.className = 'env-status-val mono';
            pv.textContent = eff.path || '';
            pRow.append(pk, pv);
            body.appendChild(pRow);
        } else {
            const line = document.createElement('div');
            line.className = 'env-error';
            line.textContent = (eff && eff.error) || env.error || '未找到可用环境';
            body.appendChild(line);
        }
        if (env.scannedAt && !env.scanning) {
            const meta = document.createElement('div');
            meta.className = 'env-meta';
            const source = env.pathOverride ? '手动指定' : (env.selectedPath ? '手动选择' : '默认');
            meta.textContent = '上次扫描 ' + deps.propsTimeText(env.scannedAt) + ' · ' + source;
            body.appendChild(meta);
        }
        sec.appendChild(body);

        // 手动指定：输入框 + 「…」按钮，可手输也可打开文件对话框选择
        const overrideRow = document.createElement('div');
        overrideRow.className = 'env-override-row';
        const overrideInput = document.createElement('input');
        overrideInput.type = 'text';
        overrideInput.className = 'env-override';
        overrideInput.placeholder = '手动指定可执行文件路径';
        overrideInput.value = env.pathOverride || '';
        overrideInput.addEventListener('change', () => {
            env.pathOverride = overrideInput.value.trim();
            deps.applySettings();
            if (id === 'python') resetLangPkgs(id);
            renderLangPane(id);
        });
        const browseBtn = document.createElement('button');
        browseBtn.type = 'button';
        browseBtn.className = 'env-browse';
        browseBtn.dataset.tip = '浏览…';
        browseBtn.textContent = '…';
        browseBtn.disabled = !!env.scanning;
        browseBtn.addEventListener('click', async () => {
            if (!deps.backend.ShowOpenFileDialog) {
                deps.flash('当前版本不支持选择文件', true);
                return;
            }
            try {
                const picked = await deps.backend.ShowOpenFileDialog('选择 ' + tool.name + ' 可执行文件', 'exe');
                if (!picked) return;
                overrideInput.value = picked;
                env.pathOverride = picked;
                deps.applySettings();
                if (tool.id === 'python') resetLangPkgs(id);
                await scanLanguageTool(id, tool.id);
            } catch (e) {
                deps.flash('选择文件失败：' + ((e && e.message) || e), true);
            }
        });
        overrideRow.append(overrideInput, browseBtn);
        sec.appendChild(overrideRow);

        pane.appendChild(sec);
    }

    const anyScanning = lang.tools.some((t) => toolEnvFor(id, t.id).scanning);
    const btnRow = document.createElement('div');
    btnRow.className = 'popover-row';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tb-btn';
    const scanned = lang.tools.every((t) => toolEnvFor(id, t.id).scannedAt);
    btn.textContent = scanned ? '重新扫描' : '扫描环境';
    btn.disabled = anyScanning;
    btn.addEventListener('click', () => scanLanguageAll(id));
    btnRow.appendChild(btn);
    pane.appendChild(btnRow);

    const hint = document.createElement('div');
    hint.className = 'fmt-hint';
    hint.textContent = '首次打开（还没有任何扫描结果）会自动把全部语言扫一遍并缓存；扫描出多个环境时默认选第一个，可用下拉切换，或在各工具的「手动指定」里填路径。';
    pane.appendChild(hint);

    // 已安装的包：python（pip 全局 / .venv）与 node（npm 全局 / 项目 node_modules）
    if (lang.pkgs && lang.pkgs.length) {
        const pkgSec = document.createElement('div');
        pkgSec.className = 'env-tool';
        const pkgHead = document.createElement('div');
        pkgHead.className = 'env-tool-head';
        pkgHead.textContent = '已安装的包';
        pkgSec.appendChild(pkgHead);
        for (const scope of lang.pkgs) {
            pkgSec.appendChild(renderPkgScope(id, scope));
        }
        pane.appendChild(pkgSec);
    }

    // 自动扫描：全空（从未扫出任何结果）→ 首次打开触发一次全语言扫描；否则只补当前
    // 语言还没扫过的工具（结果缓存，不重复扫）。全语言扫描进行中时跳过单语言补扫；
    // 循环内复查 scanning/scannedAt，与并发补扫互不重复（scanLanguageTool 另有重入守卫）。
    const container = langEnvFor(id);
    const firstRuns = firstFullScanRuns(deps.LANG_DEFS, readLangToolEnv);
    if (firstRuns && firstRuns.length) {
        if (!fullAutoScanning) {
            fullAutoScanning = true;
            (async () => {
                try {
                    for (const run of firstRuns) {
                        const e = toolEnvFor(run.langId, run.toolId);
                        if (e.scanning || e.scannedAt) continue; // 并发补扫已覆盖
                        await scanLanguageTool(run.langId, run.toolId);
                    }
                } finally {
                    fullAutoScanning = false;
                }
            })();
        }
    } else if (!firstRuns) {
        const pending = lang.tools.filter((t) => {
            const e = toolEnvFor(id, t.id);
            return !e.scanning && !e.scannedAt;
        });
        if (pending.length && !anyScanning && !fullAutoScanning && !container._autoScanning) {
            container._autoScanning = true;
            (async () => {
                try {
                    for (const t of pending) {
                        await scanLanguageTool(id, t.id);
                    }
                } finally {
                    container._autoScanning = false;
                }
            })();
        }
    }

    // 包列表：还没有缓存结果的作用域按顺序补一次
    if (lang.pkgs && lang.pkgs.length) {
        const pendingPkgs = lang.pkgs.filter((s) => {
            const st = pkgStateFor(id, s.id);
            return !st.scanning && !st.scannedAt;
        });
        if (pendingPkgs.length && !container._pkgAutoScanning) {
            container._pkgAutoScanning = true;
            (async () => {
                try {
                    for (const s of pendingPkgs) {
                        await scanLanguagePkgs(id, s.id);
                    }
                } finally {
                    container._pkgAutoScanning = false;
                }
            })();
        }
    }
}

// 全语言首扫进行中标记（工厂级，跨语言 pane 共享）：防止各 pane 的补扫与全语言扫描并发重复
let fullAutoScanning = false;

async function scanLanguageTool(id, toolId) {
    const env = toolEnvFor(id, toolId);
    if (env.scanning) return;
    env.scanning = true;
    renderLangPane(id);
    let res = null;
    try {
        res = deps.backend.DetectToolchain ? await deps.backend.DetectToolchain(toolId, env.pathOverride || '') : null;
    } catch (e) {
        res = {envs: []};
    }
    env.scanning = false;
    env.scannedAt = Date.now();
    const list = res && Array.isArray(res.envs) ? res.envs : [];
    env.envs = list;
    const prev = env.selectedPath;
    env.selectedPath = prev && list.some((x) => x.path && String(x.path).toLowerCase() === prev.toLowerCase()) ? prev : '';
    env.error = list.length ? '' : ((res && res.error) || '未找到可用环境');
    deps.applySettings();
    renderLangPane(id);
}

async function scanLanguageAll(id) {
    const lang = deps.LANG_DEFS.find((l) => l.id === id);
    if (!lang) return;
    for (const tool of lang.tools) {
        await scanLanguageTool(id, tool.id);
    }
}

// ---- 已安装的包列表：python（pip）与 node（npm）----

function pkgStateFor(id, scope) {
    const container = langEnvFor(id);
    if (!container.pkgs || typeof container.pkgs !== 'object') container.pkgs = {};
    if (!container.pkgs[scope] || typeof container.pkgs[scope] !== 'object') container.pkgs[scope] = {};
    return container.pkgs[scope];
}

function resetLangPkgs(id) {
    const container = langEnvFor(id);
    if (!container.pkgs || typeof container.pkgs !== 'object') return;
    for (const key of Object.keys(container.pkgs)) {
        container.pkgs[key].scannedAt = 0;
    }
}

function renderPkgScope(id, scope) {
    const lang = deps.LANG_DEFS.find((l) => l.id === id);
    // scope 兼容传对象或 id 字符串
    const scopeDef = typeof scope === 'object'
        ? scope
        : ((lang.pkgs || []).find((s) => s.id === scope) || {id: scope, label: scope});
    const scopeId = scopeDef.id;
    const st = pkgStateFor(id, scopeId);
    const wrap = document.createElement('div');
    wrap.className = 'pkg-scope';

    const head = document.createElement('div');
    head.className = 'pkg-scope-head';
    const name = document.createElement('span');
    name.className = 'env-tool-head';
    name.style.marginBottom = '0';
    const dot = document.createElement('span');
    dot.className = 'env-dot' + (st.scanning ? ' busy' : (st.scannedAt ? (st.error ? ' fail' : ' ok') : ''));
    const nameText = document.createElement('span');
    nameText.textContent = scopeDef.label;
    name.append(dot, nameText);
    const count = document.createElement('span');
    count.className = 'pkg-count';
    count.textContent = st.scanning || st.error
        ? ''
        : (st.exists ? ((Array.isArray(st.list) ? st.list.length : 0) + ' 个包') : '未找到');
    name.appendChild(count);
    head.appendChild(name);

    const filter = document.createElement('input');
    filter.type = 'text';
    filter.className = 'pkg-filter';
    filter.placeholder = '过滤包名…';
    filter.value = st.filterText || '';
    filter.addEventListener('input', () => {
        st.filterText = filter.value;
        renderPkgRows();
    });

    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'tb-btn';
    refresh.textContent = '刷新';
    refresh.disabled = !!st.scanning;
    refresh.addEventListener('click', () => scanLanguagePkgs(id, scopeId));
    head.append(filter, refresh);
    wrap.appendChild(head);

    const listBox = document.createElement('div');
    listBox.className = 'pkg-list';
    const renderPkgRows = () => {
        listBox.textContent = '';
        if (st.scanning) {
            const line = document.createElement('div');
            line.className = 'pkg-empty';
            line.textContent = '正在扫描…';
            listBox.appendChild(line);
            return;
        }
        if (st.error) {
            const line = document.createElement('div');
            line.className = 'env-error';
            line.textContent = st.error;
            listBox.appendChild(line);
            return;
        }
        if (!st.exists) {
            const line = document.createElement('div');
            line.className = 'pkg-empty';
            line.textContent = scopeId === 'env'
                ? '未检测到可用的 Python 解释器'
                : (id === 'go' ? '当前工作区没有 go.mod' : '当前目录没有 package.json');
            listBox.appendChild(line);
            return;
        }
        const q = (st.filterText || '').trim().toLowerCase();
        const list = (Array.isArray(st.list) ? st.list : []).filter((p) => !q || String(p.name).toLowerCase().includes(q));
        if (!list.length) {
            const line = document.createElement('div');
            line.className = 'pkg-empty';
            line.textContent = q ? '没有匹配的包' : '没有已安装的包';
            listBox.appendChild(line);
            return;
        }
        for (const p of list) {
            const row = document.createElement('div');
            row.className = 'pkg-row';
            const n = document.createElement('span');
            n.className = 'pkg-name';
            n.textContent = p.name;
            const v = document.createElement('span');
            v.className = 'pkg-ver';
            v.textContent = p.version || '';
            row.append(n, v);
            listBox.appendChild(row);
        }
    };
    renderPkgRows();
    wrap.appendChild(listBox);
    return wrap;
}

async function scanLanguagePkgs(id, scope) {
    const scopeId = typeof scope === 'object' ? scope.id : scope;
    const st = pkgStateFor(id, scopeId);
    if (st.scanning) return;
    st.scanning = true;
    renderLangPane(id);
    const kind = id === 'python' ? 'pip' : (id === 'node' ? 'npm' : (id === 'go' ? 'go' : ''));
    // python：包列表跟随所选解释器；npm/project：用当前工作区目录
    let target = '';
    if (id === 'python') {
        const eff = effectiveToolEnv(id, 'python');
        target = (eff && eff.path) || '';
    } else if (scopeId === 'project') {
        target = deps.termCwd() || '';
    }
    let res = null;
    try {
        res = deps.backend.ListLangPackages ? await deps.backend.ListLangPackages(kind, scopeId, target) : null;
    } catch (e) {
        res = {packages: [], exists: true, error: String((e && e.message) || e)};
    }
    st.scanning = false;
    st.scannedAt = Date.now();
    st.list = res && Array.isArray(res.packages) ? res.packages : [];
    st.exists = !!(res && res.exists !== false);
    st.error = (res && res.error) || '';
    deps.applySettings();
    renderLangPane(id);
}

function renderFormatPane(id) {
    const f = deps.allFormatDefs().find((item) => item.id === id);
    const pane = document.querySelector(`.settings-pane[data-pane="fmt-${id}"]`);
    if (!f || !pane) return;
    const fs = deps.getFormatSettings(id);
    pane.textContent = '';
    const title = document.createElement('div');
    title.className = 'fmt-pane-title';
    title.textContent = f.name + ' 文件';
    // 扩展名列表太长很难看（纯文本有几十个），收进标题悬停提示
    const extensions = formats[id] && formats[id].extensions ? formats[id].extensions : [];
    if (extensions.length) title.dataset.tip = '扩展名：' + extensions.join('、');
    pane.append(title);
    const update = (key) => (value) => {
        deps.settings.formatSettings[id][key] = value;
        deps.applySettings();
    };
    const addRow = (label, control) => {
        const row = document.createElement('div');
        row.className = 'popover-row';
        const text = document.createElement('span');
        text.className = 'popover-label';
        text.textContent = label;
        row.append(text, control);
        pane.appendChild(row);
    };
    addRow('编码', deps.makeSelect(deps.ENCODINGS, fs.encoding, update('encoding')));
    addRow('缩进', deps.makeSelect(deps.INDENTS, fs.indent, update('indent')));
    addRow('保存换行', deps.makeSelect(deps.EOLS, fs.eol, update('eol')));
    const viewSel = deps.makeSelect(deps.viewOptionsFor(f), fs.view, (value) => {
        deps.settings.formatSettings[id].view = value;
        deps.applySettings();
        if (deps.file && deps.file.format.id === id) deps.switchMode(value);
    });
    if (id === 'text') viewSel.disabled = true;
    addRow('默认视图', viewSel);
    const hint = document.createElement('div');
    hint.className = 'fmt-hint';
    hint.textContent = '编码 / 缩进 / 保存换行对之后打开或保存的文件生效；默认视图对当前同类文件立即生效。';
    if (id === 'text') hint.textContent += ' txt/log/conf 默认按所在扩展名打开；CMake / Dockerfile / Git 规则等特殊文件名按代码视图打开。';
    pane.appendChild(hint);
}

function renderFmtTable() {
    const table = document.getElementById('fmt-table');
    table.textContent = '';
    const head = document.createElement('div');
    head.className = 'fmt-row fmt-head';
    for (const label of ['格式', '编码', '缩进', '保存换行', '默认视图']) {
        const cell = document.createElement('span');
        cell.textContent = label;
        head.appendChild(cell);
    }
    table.appendChild(head);
    for (const f of deps.allFormatDefs()) {
        const fs = deps.getFormatSettings(f.id);
        const row = document.createElement('div');
        row.className = 'fmt-row';
        const name = document.createElement('span');
        name.textContent = f.name;
        name.dataset.tip = f.name; // 长名称单行省略后仍可悬停看全
        row.appendChild(name);
        const update = (key) => (value) => {
            deps.settings.formatSettings[f.id][key] = value;
            deps.applySettings();
        };
        // 挂 opt-select 布局类：增强后 wrap 会继承它，宽度与设置页其它下拉一致；
        // aria-label 会传给自绘触发器，让每一列都读得出含义。
        const decorate = (sel, label) => {
            sel.classList.add('opt-select');
            sel.setAttribute('aria-label', f.name + ' · ' + label);
            return sel;
        };
        row.appendChild(decorate(deps.makeSelect(deps.ENCODINGS, fs.encoding, update('encoding')), '编码'));
        row.appendChild(decorate(deps.makeSelect(deps.INDENTS, fs.indent, update('indent')), '缩进'));
        row.appendChild(decorate(deps.makeSelect(deps.EOLS, fs.eol, update('eol')), '保存换行'));
        const viewSel = deps.makeSelect(deps.viewOptionsFor(f), fs.view, (value) => {
            deps.settings.formatSettings[f.id].view = value;
            deps.applySettings();
            if (deps.file && deps.file.format.id === f.id) deps.switchMode(value);
        });
        if (f.id === 'text') viewSel.disabled = true;
        row.appendChild(decorate(viewSel, '默认视图'));
        table.appendChild(row);
    }
}

function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
}


return {effectiveToolEnv, fmtSize, langEnvFor, renderFormatPane, renderFmtTable, renderLangPane, setupFormatSettings,
        setupLanguageSettings, toolEnvFor};
}
