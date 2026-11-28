// 设置 → 插件：插件列表与错误、加载/卸载、插件市场（TTL 缓存与列表）。
// 从 writing-ui.js 拆出；deps.flash / openConfirmDialog / setupFormatSettings / setupLanguageSettings 由宿主注入。
import {iconSvg} from '../core/icons.js';

import {formats} from '../core/formats.js';
import {initPluginRuntime, loadPlugins} from '../shell/plugins.js';
import {PLUGIN_CTX_ORIGINS, pluginCtxBase, withCtx} from '../shell/plugin-ctx.js';
import {getPluginSettingsPanel, getPluginSettingsPanels, panelsOfPlugin} from '../shell/plugin-settings-panels.js';
import {serviceLogs, serviceStatus, startService, stopService} from '../shell/plugin-services.js';

export function createSettingsPanePlugins(deps) {

function refreshPluginUI() {
    // 清掉已失效的插件格式导航与面板（插件被禁用/删除后）
    const children = document.querySelector('#snav-formats .snav-children');
    const content = document.querySelector('.settings-content');
    if (children && content) {
        const valid = new Set(deps.allFormatDefs().map((f) => 'fmt-' + f.id));
        for (const nav of [...children.querySelectorAll('.snav-fmt')]) {
            if (!valid.has(nav.dataset.pane)) {
                const pane = content.querySelector(`.settings-pane[data-pane="${nav.dataset.pane}"]`);
                if (pane) pane.remove();
                nav.remove();
            }
        }
    }
    deps.setupFormatSettings();
    deps.setupLanguageSettings();
    setupPluginSettingsNav();
    if (deps.elsDialogs.settings && !deps.elsDialogs.settings.classList.contains('hidden')) {
        const active = document.querySelector('.snav-item.active');
        if (active && active.dataset.pane === 'plugins') renderPluginsPane();
    }
}

// 插件专属设置页：动态建导航项与面板容器（仿 settings-pane-lang.js 的范式）。
// 每次插件重载调用，先清旧节点再按当前注册表重建，禁用/卸载插件的面板随之消失。
function setupPluginSettingsNav() {
    const navRoot = document.querySelector('button.snav-item[data-pane="plugins"]');
    const content = document.querySelector('.settings-content');
    if (!navRoot || !content) return;
    const panels = getPluginSettingsPanels();
    const valid = new Set(panels.map((p) => p.key));
    for (const nav of [...document.querySelectorAll('.snav-plugin-panel')]) {
        if (!valid.has(nav.dataset.pane)) {
            const pane = content.querySelector(`.settings-pane[data-pane="${nav.dataset.pane}"]`);
            if (pane) pane.remove();
            nav.remove();
        }
    }
    let group = document.getElementById('snav-plugin-panels');
    if (!panels.length) {
        if (group) group.remove();
        return;
    }
    if (!group) {
        group = document.createElement('div');
        group.id = 'snav-plugin-panels';
        group.className = 'snav-group expanded';
        const parent = document.createElement('button');
        parent.type = 'button';
        parent.className = 'snav-item snav-parent';
        parent.setAttribute('aria-expanded', 'true');
        // 与静态分组（snav-ai/snav-formats）同构：chev 折叠箭头 + 图标；
        // 图标直接内联填充——data-icon 注水只在设置弹窗打开时跑一次，动态节点晚于它就永远空白
        parent.innerHTML = '<span class="snav-chev" aria-hidden="true"></span><span class="snav-ic">' + iconSvg('puzzle', 13) + '</span><span>插件设置</span>';
        const children = document.createElement('div');
        children.className = 'snav-children';
        group.append(parent, children);
        navRoot.parentNode.insertBefore(group, navRoot.nextSibling);
    }
    const children = group.querySelector('.snav-children');
    for (const p of panels) {
        if (!children.querySelector(`[data-pane="${p.key}"]`)) {
            const nav = document.createElement('button');
            nav.type = 'button';
            nav.className = 'snav-item snav-child snav-plugin-panel';
            nav.dataset.pane = p.key;
            nav.textContent = p.label;
            children.appendChild(nav);
        }
        if (!content.querySelector(`.settings-pane[data-pane="${p.key}"]`)) {
            const pane = document.createElement('div');
            pane.className = 'settings-pane hidden';
            pane.dataset.pane = p.key;
            content.appendChild(pane);
        }
    }
}

// 渲染某个插件设置面板；由 settings-ui 的 selectSettingsPane 分支调用。
function renderPluginSettingsPane(key) {
    const pane = document.querySelector(`.settings-pane[data-pane="${key}"]`);
    const spec = getPluginSettingsPanel(key);
    if (!pane || !spec) return;
    pane.textContent = '';
    // 身份与位置走 shell/plugin-ctx.js 的基座（ctx.plugin / ctx.workspace / ctx.origin）；
    // 设置面板是全局 UI，工作区可能为空——插件要判「有没有工作区」就读空串。
    const ctx = withCtx(pluginCtxBase({
        pluginId: spec.pluginId,
        pluginName: spec.pluginName,
        workspace: deps.workspaceFolder || '',
        sessionId: '',
        origin: PLUGIN_CTX_ORIGINS.settings,
    }), {
        flash: (msg, isErr) => deps.flash(String(msg), !!isErr),
        startService: (id) => startService(spec.pluginId, id),
        stopService: (id) => stopService(spec.pluginId, id),
        getServiceStatus: (id) => serviceStatus(spec.pluginId, id),
        getServiceLogs: (id) => serviceLogs(spec.pluginId, id),
        openExternal: (url) => {
            if (deps.rt && deps.rt.BrowserOpenURL) deps.rt.BrowserOpenURL(url);
            else window.open(url, '_blank', 'noopener');
        },
    });
    try {
        spec.render(pane, ctx);
    } catch (e) {
        const err = document.createElement('div');
        err.className = 'plugin-warn';
        err.textContent = '插件面板渲染失败：' + ((e && e.message) || e);
        pane.appendChild(err);
    }
}

initPluginRuntime({
    flash: deps.flash,
    getActiveFile: () => deps.file ? {path: deps.file.path || '', name: deps.file.name || '', size: deps.file.size || 0, formatId: deps.file.format ? deps.file.format.id : null} : null,
    getActiveText: () => {
        if (!deps.file) return null;
        if (deps.currentMode === 'code' && deps.editor && deps.editor.aceEditor) return deps.editor.aceEditor.getValue();
        if (deps.currentMode === 'tree' && deps.editor && deps.file.format && typeof deps.file.format.stringify === 'function') {
            try {
                return deps.file.format.stringify(deps.editor.get());
            } catch (e) {
                return null;
            }
        }
        const ta = deps.textArea();
        if (ta) return ta.value;
        return deps.file.binary ? null : deps.file.content;
    },
    openPath: (p) => {
        if (p) deps.openPaths([p]);
    },
    runCommandSync: (opts) => deps.backend.RunCommandSync(opts.exe, opts.args, opts.cwd || '', opts.timeoutMs || 20000),
    runCommand: (opts) => {
        const id = 'cmd-' + deps.nextCmdSeq();
        deps.cmdOutHandlers.set(id, (stream, data) => {
            if (stream === 'out' && opts.onOut) opts.onOut(data);
            if (stream === 'err' && opts.onErr) opts.onErr(data);
        });
        deps.cmdExitHandlers.set(id, (code) => {
            deps.cmdOutHandlers.delete(id);
            if (opts.onExit) opts.onExit(code);
        });
        Promise.resolve(deps.backend.StartCommand(id, opts.exe, opts.args, opts.cwd || '')).catch((e) => {
            deps.flash('启动命令失败：' + e, true);
            deps.cmdExitHandlers.delete(id);
            if (opts.onExit) opts.onExit(-1);
        });
        return {stop: () => deps.backend.StopCommand(id).catch(() => {})};
    },
    openVirtualDoc: (name, content) => deps.openVirtualDoc(name, content),
    readPluginAsset: (pluginId, relPath) => deps.backend.ReadPluginAsset(pluginId, relPath),
    // Agent preset 注册（能力快照方案 §4 / §10.4）：注册函数经 main.js 的 deps 注入
    //（shell 不直接 import ai/ 域），禁用 / 加载失败 / 全量重放时按 owner 撤销
    registerAgentPreset: (owner, spec) => deps.agentPresetRegister(owner, spec),
    revokeAgentPresetsOwner: (owner) => deps.agentPresetRevokeOwner(owner),
    revokeAllAgentPresets: () => deps.agentPresetRevokeAll(),
    onPluginsChanged: () => refreshPluginUI(),
    onThemesChanged: () => {
        if (deps.reconcileThemes()) deps.applySettings();
        else deps.refreshThemes();
    },
});

async function reloadPluginErrors(prefix) {
    const errors = await loadPlugins(deps.backend);
    for (const err of errors) deps.flash(prefix + err, true);
}

if (deps.elsSettings.fileAssoc) {
    deps.elsSettings.fileAssoc.addEventListener('change', () => deps.applyIntegration('SetFileAssociation', deps.elsSettings.fileAssoc, '文件关联'));
    deps.elsSettings.contextMenu.addEventListener('change', () => deps.applyIntegration('SetContextMenu', deps.elsSettings.contextMenu, '右键菜单'));
    deps.elsSettings.agentSkill.addEventListener('change', () => deps.applyIntegration('SetAgentSkill', deps.elsSettings.agentSkill, 'Agent Skill '));
    deps.elsSettings.refreshIntegration.addEventListener('click', deps.syncIntegrationStatus);
}

function setupPluginsSettings() {
    const addBtn = document.getElementById('plugin-add');
    const importBtn = document.getElementById('plugin-import');
    const cloneBtn = document.getElementById('plugin-clone');
    const openDirBtn = document.getElementById('plugin-open-dir');
    const modeSel = document.getElementById('plugin-path-mode');
    if (!addBtn) return;
    addBtn.addEventListener('click', async () => {
        if (!deps.backend.AddPluginFromFolder) return deps.flash('当前版本不支持插件', true);
        try {
            const installed = await deps.backend.AddPluginFromFolder();
            if (installed) {
                await reloadPluginErrors('');
                deps.flash('已添加插件：' + installed.name);
                deps.activityLog.log('plugin.change', installed.id || installed.name, {op: 'install-folder'});
            }
        } catch (e) {
            deps.flash('添加插件失败：' + e, true);
        }
        renderPluginsPane();
    });
    importBtn.addEventListener('click', async () => {
        if (!deps.backend.ImportPluginFromZip) return deps.flash('当前版本不支持插件', true);
        try {
            const installed = await deps.backend.ImportPluginFromZip();
            if (installed) {
                await reloadPluginErrors('');
                deps.flash('已导入插件：' + installed.name);
                deps.activityLog.log('plugin.change', installed.id || installed.name, {op: 'install-zip'});
            }
        } catch (e) {
            deps.flash('导入插件失败：' + e, true);
        }
        renderPluginsPane();
    });
    cloneBtn.addEventListener('click', () => {
        if (!deps.backend.InstallPluginFromUrl) {
            deps.flash('当前版本不支持从仓库地址安装', true);
            return;
        }
        deps.openNameDialog({
            title: '从仓库地址安装插件',
            label: '仓库地址',
            placeholder: marketSourcePref === 'github'
                ? 'https://github.com/cadt-datalens-plugins/git-flow'
                : 'https://gitee.com/cadt-datalens-plugins/git-flow',
            okLabel: '安装',
            onSubmit: async (url) => {
                if (!url || !url.trim()) throw new Error('仓库地址为空');
                // 安装插件 = 执行第三方代码：先明示权限范围，确认后再装
                deps.openConfirmDialog('插件代码以与应用相同的权限运行，可读写本机文件、执行命令。仅安装你信任的来源：' + url, () => {
                    (async () => {
                        try {
                            const installed = await deps.backend.InstallPluginFromUrl(url);
                            await reloadPluginErrors('');
                            renderPluginsPane();
                            deps.flash('已安装插件：' + installed.name);
                            deps.activityLog.log('plugin.change', (installed && (installed.id || installed.name)) || url, {op: 'install-url'});
                        } catch (e) {
                            deps.flash('安装失败：' + e, true);
                        }
                    })();
                }, '继续安装', '安装第三方插件');
            },
        });
    });
    openDirBtn.addEventListener('click', async () => {
        try {
            await deps.backend.OpenPluginsDir();
        } catch (e) {
            deps.flash('打开插件目录失败：' + e, true);
        }
    });
    const trustIcon = document.querySelector('.plugin-trust-icon');
    if (trustIcon) trustIcon.innerHTML = iconSvg('warn', 12);
    modeSel.addEventListener('change', async () => {
        try {
            await deps.backend.SetPluginsPathMode(modeSel.value);
            await reloadPluginErrors('');
            deps.flash('插件目录已切换，重新打开文件生效');
        } catch (e) {
            deps.flash('切换插件目录失败：' + e, true);
        }
        renderPluginsPane();
    });
    const marketRefresh = document.getElementById('plugin-market-refresh');
    const sourceSel = document.getElementById('plugin-market-source-mode');
    if (sourceSel) {
        sourceSel.addEventListener('change', async () => {
            const next = sourceSel.value === 'github' ? 'github' : 'gitee';
            try {
                await deps.backend.SetDataSource(next);
                marketSourcePref = next;
                applyMarketSourceUi();
                pluginMarketCache = null;
                await renderPluginMarket(true);
                deps.flash('数据源已切换：' + marketSourceLabel(marketSourcePref));
            } catch (e) {
                sourceSel.value = marketSourcePref;
                deps.flash('切换数据源失败：' + e, true);
                if (deps.addMessage) deps.addMessage({kind: 'error', title: '切换数据源失败', body: String(e)}, {});
            }
        });
    }
    const marketSearch = document.getElementById('plugin-market-search');
    if (marketSearch && !marketSearch.dataset.bound) {
        marketSearch.dataset.bound = '1';
        marketSearch.addEventListener('input', () => {
            const listEl = document.getElementById('plugin-market-list');
            const keyword = (marketSearch.value || '').trim().toLowerCase();
            const items = (pluginMarketCache && pluginMarketCache.items) || [];
            if (!listEl) return;
            if (!keyword) { if (items.length) renderPluginMarketList(listEl, items); return; }
            const filtered = items.filter((m) => [m.name, m.id, m.description, m.author, m.repo]
                .some((v) => String(v || '').toLowerCase().includes(keyword)));
            renderPluginMarketList(listEl, filtered);
        });
    }
    if (marketRefresh) {
        marketRefresh.addEventListener('click', () => renderPluginMarket(true));
    }
    const marketSource = document.getElementById('plugin-market-source');
    if (marketSource) {
        marketSource.addEventListener('click', (e) => {
            e.preventDefault();
            const url = marketSource.dataset.url;
            if (deps.rt && deps.rt.BrowserOpenURL) deps.rt.BrowserOpenURL(url);
            else window.open(url, '_blank', 'noopener');
        });
    }
}

let cachedAppVersion = '';
function appVersionValue() {
    return cachedAppVersion;
}

function versionAtLeast(current, required) {
    const parse = (v) => String(v || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    const [c1 = 0, c2 = 0, c3 = 0] = parse(current);
    const [r1 = 0, r2 = 0, r3 = 0] = parse(required);
    if (c1 !== r1) return c1 > r1;
    if (c2 !== r2) return c2 > r2;
    return c3 >= r3;
}

function compareVersion(a, b) {
    const parse = (v) => String(v || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    const ap = parse(a);
    const bp = parse(b);
    for (let i = 0; i < 3; i += 1) {
        const av = ap[i] || 0;
        const bv = bp[i] || 0;
        if (av !== bv) return av > bv ? 1 : -1;
    }
    return 0;
}

async function renderPluginsPane() {
    const listEl = document.getElementById('plugin-list');
    if (!listEl) return;
    const modeSel = document.getElementById('plugin-path-mode');
    try {
        if (deps.backend.GetAppVersion) cachedAppVersion = await deps.backend.GetAppVersion();
        const plugins = deps.backend.GetPlugins ? await deps.backend.GetPlugins() : [];
        const dir = deps.backend.GetPluginsDir ? await deps.backend.GetPluginsDir() : '—';
        if (modeSel && deps.backend.GetPluginsPathMode) {
            modeSel.value = await deps.backend.GetPluginsPathMode();
        }
        if (document.getElementById('plugin-dir-line')) {
            document.getElementById('plugin-dir-line').textContent = '插件目录：' + dir;
        }
        await refreshMarketSource();
        renderPluginMarket(false);
        listEl.textContent = '';
        if (!plugins || !plugins.length) {
            const empty = document.createElement('div');
            empty.className = 'plugin-empty';
            empty.textContent = '暂无插件';
            listEl.appendChild(empty);
            fitPluginListBox(listEl);
            return;
        }
        for (const p of plugins) {
            const item = document.createElement('div');
            item.className = 'plugin-item';
            const head = document.createElement('div');
            head.className = 'plugin-head';
            if (p.iconData) {
                const icon = document.createElement('img');
                icon.className = 'plugin-icon';
                icon.src = p.iconData;
                icon.alt = '';
                icon.draggable = false;
                head.appendChild(icon);
            }
            const name = document.createElement('span');
            name.className = 'plugin-name';
            name.textContent = p.name;
            const ver = document.createElement('span');
            ver.className = 'plugin-version';
            ver.textContent = p.version ? 'v' + p.version : '';
            const author = document.createElement('span');
            author.className = 'plugin-author';
            author.textContent = p.author ? '作者：' + p.author : '';
            const license = document.createElement('span');
            license.className = 'plugin-license';
            license.textContent = p.license || '';
            license.dataset.tip = '许可证';
            const enabledLabel = document.createElement('label');
            enabledLabel.className = 'popover-label plugin-enabled';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!p.enabled;
            cb.addEventListener('change', async () => {
                try {
                    await deps.backend.SetPluginEnabled(p.id, cb.checked);
                    await reloadPluginErrors('');
                    deps.activityLog.log('plugin.change', p.id, {op: cb.checked ? 'enable' : 'disable'});
                } catch (e) {
                    deps.flash('切换失败：' + e, true);
                }
                renderPluginsPane();
            });
            enabledLabel.append(cb, document.createTextNode('启用'));
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'dlg-btn plugin-del';
            del.textContent = '删除';
            del.addEventListener('click', () => {
                // 与设置页其他破坏性操作一致：走统一确认弹窗，不做「再点一次按钮」的就地确认
                deps.openConfirmDialog(
                    '删除插件「' + p.name + '」？插件代码会立即从本机移除。',
                    async () => {
                        try {
                            await deps.backend.DeletePlugin(p.id);
                            await reloadPluginErrors('');
                            deps.flash('插件已删除：' + p.name);
                            deps.activityLog.log('plugin.change', p.id, {op: 'uninstall'});
                        } catch (e) {
                            deps.flash('删除失败：' + e, true);
                        }
                        renderPluginsPane();
                    },
                    '删除',
                    '删除插件',
                    'danger'
                );
            });
            // 插件专属设置面板入口（每个面板一个按钮）
            const myPanels = panelsOfPlugin(p.id);
            for (const panel of myPanels) {
                const settingsBtn = document.createElement('button');
                settingsBtn.type = 'button';
                settingsBtn.className = 'dlg-btn plugin-settings';
                settingsBtn.textContent = panel.label;
                settingsBtn.addEventListener('click', () => {
                    if (deps.openSettings) deps.openSettings(panel.key);
                    else deps.flash('当前版本不支持插件设置面板', true);
                });
                head.append(settingsBtn);
            }
            // 正交维度互跳：插件生命周期在这里管，「能否向 AI 提供工具 + 逐工具授权」在权限页
            const permBtn = document.createElement('button');
            permBtn.type = 'button';
            permBtn.className = 'dlg-btn plugin-ai-perms';
            permBtn.setAttribute('data-open-pane', 'permissions');
            permBtn.setAttribute('data-open-anchor', 'setgrp-ai-tool-perms');
            permBtn.textContent = 'AI 工具权限…';
            // 子代理 preset 写入授权的撤销入口（能力快照方案 §6.3）：该插件有已确认的写授权
            // 时显示，一键清掉它的全部确认记录——撤销后下次派单会重新弹能力确认卡
            const grantCount = typeof deps.agentPresetGrantCount === 'function' ? deps.agentPresetGrantCount(p.id) : 0;
            if (grantCount > 0) {
                const grantBtn = document.createElement('button');
                grantBtn.type = 'button';
                grantBtn.className = 'dlg-btn plugin-grant-revoke';
                grantBtn.textContent = '撤销写入确认';
                grantBtn.dataset.tip = '该插件有 ' + grantCount + ' 条子代理写入授权记录：撤销后下次派单会重新弹确认卡';
                grantBtn.addEventListener('click', () => {
                    const n = typeof deps.agentPresetRevokeGrants === 'function' ? deps.agentPresetRevokeGrants(p.id) : 0;
                    try {
                        deps.activityLog.log('plugin.change', p.id, {op: 'revoke-agent-preset-grants', count: n});
                    } catch (e) {}
                    deps.flash('已撤销插件「' + p.name + '」的 ' + n + ' 条子代理写入确认');
                    renderPluginsPane();
                });
                head.append(grantBtn);
            }
            head.append(name, ver, author, license, enabledLabel, permBtn, del);
            const desc = document.createElement('div');
            desc.className = 'plugin-desc';
            desc.textContent = p.description || '无描述';
            const meta = document.createElement('div');
            meta.className = 'plugin-meta';
            if (p.extensions && p.extensions.length) {
                const exts = document.createElement('span');
                exts.textContent = '扩展名：' + p.extensions.join('、');
                meta.appendChild(exts);
            }
            for (const kw of (p.keywords || []).slice(0, 6)) {
                const chip = document.createElement('span');
                chip.className = 'plugin-tag';
                chip.textContent = kw;
                meta.appendChild(chip);
            }
            if (p.minAppVersion && !versionAtLeast(appVersionValue(), p.minAppVersion)) {
                const warn = document.createElement('span');
                warn.className = 'plugin-warn';
                warn.textContent = '需要应用 ≥ ' + p.minAppVersion;
                meta.appendChild(warn);
            }
            for (const [label, url] of [['主页', p.homepage], ['源码', p.repository]]) {
                if (!url) continue;
                const link = document.createElement('a');
                link.className = 'plugin-link';
                link.textContent = label;
                link.href = url;
                link.dataset.url = url;
                link.dataset.tip = url;
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    if (deps.rt && deps.rt.BrowserOpenURL) deps.rt.BrowserOpenURL(url);
                    else window.open(url, '_blank', 'noopener');
                });
                meta.appendChild(link);
            }
            if (!p.entryOk) {
                const warn = document.createElement('span');
                warn.className = 'plugin-warn';
                warn.textContent = '入口文件缺失或过大';
                meta.appendChild(warn);
            }
            item.append(head, desc, meta);
            listEl.appendChild(item);
        }
        fitPluginListBox(listEl);
    } catch (e) {
        deps.flash('读取插件失败：' + e, true);
    }
}

let pluginMarketCache = null;
const PLUGIN_MARKET_TTL = 5 * 60 * 1000;
// 数据源（gitee/github）：插件市场与模型配置表的远端来源，默认 Gitee。
// 模块内另有 const marketSource（DOM 链接元素），本状态用 marketSourcePref 命名避免遮蔽。
let marketSourcePref = 'gitee';

function marketSourceLabel(source) {
    return source === 'github' ? 'GitHub' : 'Gitee';
}

function applyMarketSourceUi() {
    const sel = document.getElementById('plugin-market-source-mode');
    if (sel) sel.value = marketSourcePref;
    const org = 'cadt-datalens-plugins';
    const url = marketSourcePref === 'github'
        ? 'https://github.com/organizations/' + org + '/repositories'
        : 'https://gitee.com/organizations/' + org + '/projects';
    const link = document.getElementById('plugin-market-source');
    if (link) {
        link.href = url;
        link.dataset.url = url;
        link.textContent = marketSourceLabel(marketSourcePref) + ' · CaDt-DataLens 插件市场';
    }
    const desc = document.getElementById('plugin-market-source-desc');
    if (desc) {
        desc.textContent = marketSourcePref === 'github'
            ? 'GitHub 组织公开仓库（Gitee 镜像），数据源同时影响插件市场与模型配置表'
            : 'Gitee 组织公开仓库，推送即上架；数据源同时影响插件市场与模型配置表';
    }
}

async function refreshMarketSource() {
    if (deps.backend.GetDataSource) {
        try {
            marketSourcePref = (await deps.backend.GetDataSource()) === 'github' ? 'github' : 'gitee';
        } catch (e) {
            marketSourcePref = 'gitee';
        }
    }
    applyMarketSourceUi();
}

async function renderPluginMarket(force) {
    const listEl = document.getElementById('plugin-market-list');
    if (!listEl) return;
    if (!deps.backend.GetPluginMarket) {
        listEl.textContent = '';
        const unsupported = document.createElement('div');
        unsupported.className = 'plugin-empty';
        unsupported.textContent = '当前版本不支持插件市场。';
        listEl.appendChild(unsupported);
        fitPluginListBox(listEl);
        return;
    }
    if (!force && pluginMarketCache && Date.now() - pluginMarketCache.at < PLUGIN_MARKET_TTL) {
        renderPluginMarketList(listEl, pluginMarketCache.items);
        return;
    }
    listEl.textContent = '';
    const loading = document.createElement('div');
    loading.className = 'plugin-empty';
    loading.textContent = force ? '正在刷新插件市场…' : '正在读取插件市场…';
    listEl.appendChild(loading);
    fitPluginListBox(listEl);
    try {
        const items = (await deps.backend.GetPluginMarket()) || [];
        pluginMarketCache = {at: Date.now(), items};
        renderPluginMarketList(listEl, items);
    } catch (e) {
        listEl.textContent = '';
        const err = document.createElement('div');
        err.className = 'plugin-empty plugin-market-error';
        err.textContent = '插件市场加载失败：' + e + '（点「刷新」重试）';
        listEl.appendChild(err);
        fitPluginListBox(listEl);
        deps.logFrontend('error', '插件市场加载失败：' + e);
        if (deps.addMessage) deps.addMessage({kind: 'error', title: '插件市场加载失败', body: String(e)}, {});
    }
}

function renderPluginMarketList(listEl, items) {
    const searchEl = document.getElementById('plugin-market-search');
    const keyword = searchEl ? (searchEl.value || '').trim().toLowerCase() : '';
    if (keyword) {
        items = items.filter((m) => [m.name, m.id, m.description, m.author, m.repo]
            .some((v) => String(v || '').toLowerCase().includes(keyword)));
    }
    listEl.textContent = '';
    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'plugin-empty';
        empty.textContent = keyword ? '没有匹配「' + keyword + '」的插件。' : '插件市场暂无公开插件。';
        listEl.appendChild(empty);
        fitPluginListBox(listEl);
        return;
    }
    for (const m of items) {
        const item = document.createElement('div');
        item.className = 'plugin-item';
        const head = document.createElement('div');
        head.className = 'plugin-head';
        const name = document.createElement('span');
        name.className = 'plugin-name';
        name.textContent = m.name || m.repo;
        const ver = document.createElement('span');
        ver.className = 'plugin-version';
        ver.textContent = m.version ? 'v' + m.version : '';
        const author = document.createElement('span');
        author.className = 'plugin-author';
        author.textContent = m.author ? '作者：' + m.author : '';
        head.append(name, ver, author);
        const installedVersion = m.installedVersion || '';
        const updateAvailable = m.installed && installedVersion && m.version && compareVersion(m.version, installedVersion) > 0;
        if (updateAvailable) {
            const update = document.createElement('button');
            update.type = 'button';
            update.className = 'dlg-btn primary plugin-market-action';
            update.textContent = '更新';
            update.dataset.tip = '当前 v' + installedVersion + ' → v' + m.version;
            update.addEventListener('click', async () => {
                update.disabled = true;
                update.textContent = '更新中…';
                try {
                    const pluginId = m.id || (m.repo || '').split('/').pop();
                    const updated = await deps.backend.UpdatePluginFromUrl(pluginId, m.url);
                    if (!updated) throw new Error('更新失败');
                    m.installed = true;
                    m.installedVersion = m.version;
                    await reloadPluginErrors('');
                    renderPluginsPane();
                    deps.flash('已更新插件：' + (updated.name || m.name) + (m.version ? ' v' + m.version : ''));
                } catch (e) {
                    update.disabled = false;
                    update.textContent = '更新';
                    deps.flash('更新失败：' + e, true);
                }
            });
            head.appendChild(update);
        } else if (m.installed) {
            const tag = document.createElement('span');
            tag.className = 'plugin-market-installed';
            tag.textContent = '已安装' + (installedVersion ? ' v' + installedVersion : '');
            head.appendChild(tag);
        } else if (m.minAppVersion && !versionAtLeast(appVersionValue(), m.minAppVersion)) {
            const warn = document.createElement('span');
            warn.className = 'plugin-warn plugin-market-action';
            warn.textContent = '需要应用 ≥ ' + m.minAppVersion;
            head.appendChild(warn);
        } else {
            const install = document.createElement('button');
            install.type = 'button';
            install.className = 'dlg-btn plugin-market-action';
            install.textContent = '安装';
            install.addEventListener('click', () => {
                deps.openConfirmDialog('插件代码以与应用相同的权限运行，可读写本机文件、执行命令。仅安装你信任的来源：' + (m.name || m.url), async () => {
                    install.disabled = true;
                    install.textContent = '安装中…';
                    try {
                        const installed = await deps.backend.InstallPluginFromUrl(m.url);
                        if (!installed) throw new Error('仓库地址为空');
                        m.installed = true;
                        await reloadPluginErrors('');
                        renderPluginsPane();
                        deps.flash('已安装插件：' + (installed.name || m.name));
                        deps.activityLog.log('plugin.change', (installed.id || installed.name || m.url), {op: 'install-url'});
                    } catch (e) {
                        install.disabled = false;
                        install.textContent = '安装';
                        deps.flash('安装失败：' + e, true);
                    }
                }, '继续安装', '安装第三方插件');
            });
            head.appendChild(install);
        }
        const desc = document.createElement('div');
        desc.className = 'plugin-desc';
        desc.textContent = m.description || '无描述';
        const meta = document.createElement('div');
        meta.className = 'plugin-meta';
        const repo = document.createElement('span');
        repo.textContent = m.repo;
        meta.appendChild(repo);
        const date = marketDate(m.updatedAt);
        if (date) {
            const updated = document.createElement('span');
            updated.textContent = '更新于 ' + date;
            meta.appendChild(updated);
        }
        if (m.stars > 0) {
            const stars = document.createElement('span');
            stars.className = 'market-stars';
            stars.innerHTML = iconSvg('star', 11) + '<span>' + m.stars + '</span>';
            meta.appendChild(stars);
        }
        if (!m.manifestOk) {
            const warn = document.createElement('span');
            warn.className = 'plugin-warn';
            warn.textContent = '未读取到插件清单';
            meta.appendChild(warn);
        }
        const link = document.createElement('a');
        link.className = 'plugin-link';
        link.textContent = '主页';
        link.href = m.url;
        link.dataset.url = m.url;
        link.dataset.tip = m.url;
        link.addEventListener('click', (e) => {
            e.preventDefault();
            if (deps.rt && deps.rt.BrowserOpenURL) deps.rt.BrowserOpenURL(m.url);
            else window.open(m.url, '_blank', 'noopener');
        });
        meta.appendChild(link);
        item.append(head, desc, meta);
        listEl.appendChild(item);
    }
    fitPluginListBox(listEl);
}

// 列表外层框最多显示三格，超出的内容在框内滚动。
function fitPluginListBox(listEl, maxItems = 3) {
    const box = listEl && listEl.parentElement;
    if (!box || !box.classList.contains('plugin-list-box')) return;
    const items = Array.from(listEl.children);
    if (!items.length || !items[0].offsetHeight) {
        box.style.maxHeight = '';
        return;
    }
    const listStyle = getComputedStyle(listEl);
    const gap = parseFloat(listStyle.rowGap || listStyle.gap) || 0;
    let height = 0;
    const visible = Math.min(items.length, maxItems);
    for (let i = 0; i < visible; i += 1) {
        height += items[i].offsetHeight;
        if (i > 0) height += gap;
    }
    const boxStyle = getComputedStyle(box);
    height += (parseFloat(boxStyle.paddingTop) || 0) + (parseFloat(boxStyle.paddingBottom) || 0);
    height += (parseFloat(boxStyle.borderTopWidth) || 0) + (parseFloat(boxStyle.borderBottomWidth) || 0);
    box.style.maxHeight = Math.ceil(height) + 'px';
}

function marketDate(iso) {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso || ''));
    return match ? match[1] : '';
}

setupPluginsSettings();

// ---- 设置：环境变量（私密值注入终端/命令桥；AI 只见名称与描述） ----


return {pluginMarketCache, refreshPluginUI, renderPluginMarket, renderPluginMarketList, renderPluginsPane, renderPluginSettingsPane, setupPluginsSettings, setupPluginSettingsNav};
}
