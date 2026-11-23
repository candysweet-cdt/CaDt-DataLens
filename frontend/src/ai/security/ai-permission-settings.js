// AI 设置 → 权限：审批授权路径、会话/项目级规则、端侧分类器（模型位/状态/自测/个性化）与审批记录。
// 从 ai-settings-dialog.js 拆出（同域兄弟模块）；ctx 与原模块同源，宿主函数经 extras 注入。
import {
    commandFamilySignature, commandText, matchCommandRule,
} from './ai-command-rules.js';
import {
    modelRefLabel, resolveModelRef,
} from '../core/ai-config-model.js';
import {
    PERMISSION_VERSION, emptyPermissionRules, formatRuleLines,
    normalizeLocalClassifierStrictness, normalizePermissionRules, webRuleSubject,
    writeRuleSubject,
} from './ai-permissions.js';
import {describeSandboxGrant, sandboxHasResidue} from './ai-sandbox-grant.js';
import {createSwitch} from '../../core/form-controls.js';
import {parseJson} from '../../core/json-safe.js';
// 插件 AI 工具注册表（纯逻辑，无 DOM）：权限面板据此渲染三层授权开关
import * as pluginToolsMod from '../../shell/plugin-tools.js';

// 沙箱授权残留的可读描述来自 ai-sandbox-grant.js（纯模块：本文件顶层挂了 window 监听，
// 测试不能直接 import 这里的纯函数）。

export function createAIPermissionSettings(ctx, extras) {

    const opt = ctx.opt;
    const flash = ctx.flash;
    const backend = ctx.backend;
    const readTextFile = ctx.readTextFile;
    const currentSession = ctx.currentSession;
    const saveAIConfig = ctx.saveAIConfig;
    const aiNormalizePath = ctx.aiNormalizePath;
    const aiJoinPath = ctx.aiJoinPath;
    const aiPathDir = ctx.aiPathDir;
    const aiPathKey = ctx.aiPathKey;
    const aiProjectRoot = ctx.aiProjectRoot;
    const aiWorkspaceKey = ctx.aiWorkspaceKey;
    const getConfig = ctx.getConfig;
    const localClassifier = ctx.localClassifier;
    const openSettings = ctx.openSettings;
    const getPluginCommandClassifiers = ctx.getPluginCommandClassifiers;
    const getPluginLoadErrors = typeof ctx.getPluginLoadErrors === 'function' ? ctx.getPluginLoadErrors : null;
    const refreshPlugins = typeof ctx.refreshPlugins === 'function' ? ctx.refreshPlugins : null;
    const getPermissionAudit = ctx.getPermissionAudit;

// 插件注册表可能在异步加载中变化（启动加载 / 市场装完 / 刷新）：loadPlugins 完成时广播
// cadt-plugins-loaded，端侧模型位与状态行原位刷新——避免「装了插件下拉里没有、要手动刷新」
window.addEventListener('cadt-plugins-loaded', renderLocalClassifierSettings);
let semanticAutoRecheckDone = false; // 注册表空时的自动补扫，每会话一次（见 renderLocalClassifierSettings）

    // 测试框输入防抖：原内联在 bindSettingsPane 的监听里，随 runLocalClassifierTest 迁入本域
    function scheduleLocalClassifierTest() {
        if (localClassifierTestTimer) clearTimeout(localClassifierTestTimer);
        localClassifierTestTimer = setTimeout(runLocalClassifierTest, 250);
    }

    function renderApprovedSettings() {
        if (!opt.approved) return;
        opt.approved.innerHTML = '';
        const paths = getConfig().approvedPaths || [];
        if (!paths.length) {
            const empty = document.createElement('span');
            empty.className = 'ai-approved-empty';
            empty.textContent = '（无，所有写操作每次询问）';
            opt.approved.appendChild(empty);
        } else {
            for (const path of paths) {
                const row = document.createElement('div');
                row.className = 'ai-approved-row';
                const text = document.createElement('span');
                text.className = 'ai-approved-path';
                text.textContent = path;
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'ai-approved-remove';
                remove.textContent = '×';
                remove.addEventListener('click', () => {
                    getConfig().approvedPaths = getConfig().approvedPaths.filter((item) => aiPathKey(item) !== aiPathKey(path));
                    saveAIConfig();
                    renderApprovedSettings();
                    flash('已移除授权：' + path);
                });
                row.append(text, remove);
                opt.approved.appendChild(row);
            }
        }
        if (opt.approvedClear) opt.approvedClear.disabled = !(getConfig().approvedPaths || []).length;
    }

    // 插件 AI 工具授权：三层开关（全局总闸 / 插件级 / 工具级）。
    // readOnly 工具多一个「只读档可用」子开关——插件声明只是候选资格，放行必须由用户勾。
    // 安全模型见 docs/unfinished-plans/plugin-tool-security.md（M2 定稿）。
    function ensurePluginToolAuth() {
        const cfg = getConfig();
        if (!cfg.pluginTools || typeof cfg.pluginTools !== 'object') {
            cfg.pluginTools = {enabled: false, plugins: {}};
        }
        const auth = cfg.pluginTools;
        if (!auth.plugins || typeof auth.plugins !== 'object') auth.plugins = {};
        return auth;
    }

    function renderPluginToolSettings() {
        const listEl = document.getElementById('ai-plugin-tools-list');
        const emptyEl = document.getElementById('ai-plugin-tools-empty');
        const masterEl = document.getElementById('ai-opt-plugin-tools');
        const mod = pluginToolsMod;
        if (!listEl || !masterEl || !mod || typeof mod.pluginToolsByPlugin !== 'function') return;

        const auth = ensurePluginToolAuth();
        if (!masterEl.dataset.boundPluginTools) {
            masterEl.addEventListener('change', () => {
                ensurePluginToolAuth().enabled = masterEl.checked === true;
                saveAIConfig();
                renderPluginToolSettings();
            });
            masterEl.dataset.boundPluginTools = '1';
        }
        masterEl.checked = auth.enabled === true;

        const groups = mod.pluginToolsByPlugin() || [];
        listEl.textContent = '';
        if (emptyEl) emptyEl.style.display = groups.length ? 'none' : '';

        for (const group of groups) {
            const pid = group.pluginId;
            const ensurePlugin = () => {
                const store = ensurePluginToolAuth();
                if (!store.plugins[pid] || typeof store.plugins[pid] !== 'object') {
                    store.plugins[pid] = {allow: false, tools: {}};
                }
                const entry = store.plugins[pid];
                if (!entry.tools || typeof entry.tools !== 'object') entry.tools = {};
                return entry;
            };
            const pluginState = ensurePlugin();

            const head = document.createElement('div');
            head.className = 'ai-approved-row';
            const nameEl = document.createElement('span');
            nameEl.className = 'ai-approved-path';
            nameEl.textContent = group.pluginName + '（' + group.tools.length + ' 个工具）';
            const allowSwitch = createSwitch({
                checked: pluginState.allow === true,
                onChange() {
                    ensurePlugin().allow = this.checked === true;
                    saveAIConfig();
                    renderPluginToolSettings();
                },
            });
            head.append(nameEl, allowSwitch.element);
            listEl.appendChild(head);

            for (const tool of group.tools) {
                const ensureTool = () => {
                    const plugin = ensurePlugin();
                    if (!plugin.tools[tool.name] || typeof plugin.tools[tool.name] !== 'object') {
                        plugin.tools[tool.name] = {on: false, readOnlyOk: false};
                    }
                    return plugin.tools[tool.name];
                };
                const entry = ensureTool();

                const row = document.createElement('div');
                row.className = 'ai-approved-row';
                row.style.paddingLeft = '18px';
                const main = document.createElement('div');
                main.className = 'set-main';
                const title = document.createElement('div');
                title.className = 'set-title';
                title.textContent = tool.name + (tool.readOnly ? '（声明只读）' : '');
                const desc = document.createElement('div');
                desc.className = 'set-desc';
                desc.textContent = tool.description.length > 80
                    ? tool.description.slice(0, 80) + '…'
                    : tool.description;
                main.append(title, desc);

                const ctrl = document.createElement('div');
                ctrl.className = 'set-control';
                const toolSwitch = createSwitch({
                    checked: entry.on === true,
                    disabled: pluginState.allow !== true,
                    title: pluginState.allow === true ? '' : '先允许该插件',
                    onChange() {
                        ensureTool().on = this.checked === true;
                        saveAIConfig();
                        renderPluginToolSettings();
                    },
                });
                ctrl.appendChild(toolSwitch.element);
                if (tool.readOnly) {
                    const roSwitch = createSwitch({
                        checked: entry.readOnlyOk === true,
                        disabled: pluginState.allow !== true || entry.on !== true,
                        title: '允许在只读档使用（默认关闭）',
                        onChange() {
                            ensureTool().readOnlyOk = this.checked === true;
                            saveAIConfig();
                            renderPluginToolSettings();
                        },
                    });
                    ctrl.appendChild(roSwitch.element);
                }
                row.append(main, ctrl);
                listEl.appendChild(row);
            }
        }
    }

    const PERMISSION_KIND_LABELS = {command: 'Bash', write: 'Write', web: 'Web', read: 'Read', worktree: '隔离工作区'};
    const AUDIT_SOURCE_LABELS = {
        readonly: '只读命令',
        family: '已知命令族',
        classifier: 'AI 分类器',
        'local-classifier': '端侧分类器',
        session: '本会话授权',
        project: '项目规则',
        full: '完全权限',
        dangerous: '危险命令',
        risky: '风险路径',
        scope: '逐次询问',
        default: '默认放行',
        auto: '自动权限档',
        user: '用户批准',
        confirm: '确认弹窗',
        'worktree-isolation': '隔离区主根只读',
        'agent-worktree': '子代理隔离前缀',
    };

    function sessionRulePattern(rule) {
        if (!rule) return '';
        return rule.mode === 'family'
            ? String(rule.signature || '') + ':*'
            : commandText(rule.command);
    }

    function auditRulePattern(entry) {
        if (!entry) return '';
        if (entry.kind === 'command') {
            const family = commandFamilySignature(entry.subject);
            return family ? family.signature + ':*' : commandText(entry.subject);
        }
        if (entry.kind === 'write' || entry.kind === 'read') return writeRuleSubject(entry.subject);
        if (entry.kind === 'web') {
            return entry.subject.startsWith('domain:')
                ? entry.subject
                : (webRuleSubject(entry.subject) || entry.subject);
        }
        return '';
    }

    function removeCommandApprovalRule(session, rule) {
        if (!session || !session.id) return false;
        const list = commandRulesFor(session);
        const index = list.indexOf(rule);
        if (index < 0) return false;
        list.splice(index, 1);
        if (!list.length) commandApprovalRules.delete(session.id);
        return true;
    }

    async function removeProjectRule(kind, behavior, rule) {
        return enqueueProjectRulesMutation(async () => {
            const current = await ensureProjectRules(true);
            const next = normalizePermissionRules(current);
            const list = next[kind] && next[kind][behavior];
            if (!list) return false;
            const index = list.findIndex((item) => item.toLowerCase() === String(rule || '').toLowerCase());
            if (index < 0) return false;
            list.splice(index, 1);
            await saveProjectRules(next);
            renderPermissionSettings();
            refreshPermissionEditors().catch(() => {});
            return true;
        });
    }

    function projectRuleRow(kind, behavior, rule) {
        const row = document.createElement('div');
        row.className = 'ai-perm-row';
        const kindLabel = document.createElement('span');
        kindLabel.className = 'ai-perm-kind';
        kindLabel.textContent = PERMISSION_KIND_LABELS[kind] || kind;
        const pattern = document.createElement('span');
        pattern.className = 'ai-perm-pattern';
        pattern.textContent = rule;
        const badge = document.createElement('span');
        badge.className = 'ai-perm-decision ' + behavior;
        badge.textContent = behavior;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'ai-perm-mini';
        remove.textContent = '×';
        remove.addEventListener('click', () => {
            removeProjectRule(kind, behavior, rule).then((removed) => {
                if (removed) flash('已删除项目规则：' + rule);
            }).catch((e) => flash('删除失败：' + ((e && e.message) || e), true));
        });
        row.append(kindLabel, pattern, badge, remove);
        return row;
    }

    function renderProjectRuleTable() {
        if (!opt.permissionTable) return;
        const rules = currentProjectRules();
        opt.permissionTable.innerHTML = '';
        let total = 0;
        for (const behavior of ['deny', 'ask', 'allow']) {
            for (const kind of ['command', 'write', 'web', 'read']) {
                for (const rule of rules[kind][behavior]) {
                    total += 1;
                    opt.permissionTable.appendChild(projectRuleRow(kind, behavior, rule));
                }
            }
        }
        if (!total) {
            const empty = document.createElement('span');
            empty.className = 'ai-approved-empty';
            empty.textContent = '（没有项目规则）';
            opt.permissionTable.appendChild(empty);
        }
    }

    // 分类器模型下拉：跟随当前模型（默认）+ 所有账号下的模型条目。
    // logPermission 每条审批记录都会触发本页重渲，用签名比对避免重建下拉打断交互。
    function renderClassifierModelOptions() {
        if (!opt.permissionClassifierModel) return;
        const select = opt.permissionClassifierModel;
        const signature = getConfig().profiles.map((account) =>
            account.id + ':' + (account.models || []).map((entry) =>
                entry.id + ':' + (modelRefLabel(account, entry) || '')).join(',')).join('|');
        if (select.dataset.optionsSig !== signature) {
            select.dataset.optionsSig = signature;
            select.innerHTML = '';
            const follow = document.createElement('option');
            follow.value = '';
            follow.textContent = '跟随当前模型（默认）';
            select.appendChild(follow);
            for (const account of getConfig().profiles) {
                for (const entry of (account.models || [])) {
                    const option = document.createElement('option');
                    option.value = account.id + '|' + entry.id;
                    option.textContent = modelRefLabel(account, entry) || (account.id + '|' + entry.id);
                    select.appendChild(option);
                }
            }
        }
        const wanted = resolveModelRef(getConfig().autoClassifierModel, getConfig().profiles);
        if (select.value !== wanted) select.value = wanted;
    }

    // 端侧分类器设置区（docs/finished-plans/local-command-classifier.md §5/§7）：
    // 开关、严格度、个性化、测试框（不产生审批记录）、重置 / 清空 / 导出。
    let localClassifierTestTimer = 0;
    const LOCAL_CLASSIFIER_STRICTNESS_NAMES = {loose: '宽松', standard: '标准', strict: '严格'};

    function renderLocalClassifierSettings() {
        if (!opt.localClassifierStatus) return;
        if (opt.localLinear) opt.localLinear.value = getConfig().localClassifierLinear === 'off' ? 'off' : 'builtin';
        renderSemanticModelOptions();
        if (opt.localClassifierStrictness) opt.localClassifierStrictness.value = normalizeLocalClassifierStrictness(getConfig().localClassifierStrictness);
        if (opt.localClassifierPersonalize) opt.localClassifierPersonalize.checked = getConfig().localClassifierPersonalize === true;
        renderLocalClassifierStatus();
        // 时序兜底（实测事故：启动加载早已完成但注册表是空的，手动点刷新才出来）：
        // 渲染时注册表空且无加载错误 → 自动补一次重扫；每次会话只补一次防循环，
        // 完成后经 cadt-plugins-loaded 事件回填下拉与状态行
        const pluginsNow = typeof getPluginCommandClassifiers === 'function' ? getPluginCommandClassifiers() : [];
        const loadErrorsNow = getPluginLoadErrors ? getPluginLoadErrors() : [];
        if (!pluginsNow.length && !loadErrorsNow.length && !semanticAutoRecheckDone && refreshPlugins) {
            semanticAutoRecheckDone = true;
            Promise.resolve(refreshPlugins()).catch(() => {}); // loadPlugins 自己收集错误，完成后事件回填
        }
    }

    // 语义模型下拉：全部已装（默认）/ 各已注册分类器 / 关闭；当前值被卸载时补一条「未找到」保显示
    function renderSemanticModelOptions() {
        if (!opt.localSemantic) return;
        const plugins = typeof getPluginCommandClassifiers === 'function' ? getPluginCommandClassifiers() : [];
        const wanted = getConfig().localClassifierSemantic || '';
        opt.localSemantic.innerHTML = '';
        const add = (value, text) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = text;
            opt.localSemantic.appendChild(option);
        };
        add('', '全部已装（默认）');
        for (const item of plugins) add(item.id, item.label || item.id);
        add('off', '关闭');
        if (wanted && wanted !== 'off' && !plugins.some((item) => item.id === wanted)) add(wanted, wanted + '（未找到）');
        opt.localSemantic.value = wanted;
    }

    function renderLocalClassifierStatus() {
        if (!opt.localClassifierStatus) return;
        const plugins = typeof getPluginCommandClassifiers === 'function' ? getPluginCommandClassifiers() : [];
        const semanticSetting = getConfig().localClassifierSemantic || '';
        // 语义模型位按当前选择过滤：关闭 / 指定一个 / 全部
        const visibleSemantic = semanticSetting === 'off'
            ? []
            : (semanticSetting ? plugins.filter((item) => item.id === semanticSetting) : plugins);
        // 插件已安装但加载失败时如实显示原因，不误报「未安装」
        const loadErrors = getPluginLoadErrors ? getPluginLoadErrors() : [];
        // 语义模型跳转口：语义模型位无可用模型时显示，一键带 onnx 关键词跳插件市场搜索
        if (opt.localClassifierMarket) {
            opt.localClassifierMarket.classList.toggle('hidden', visibleSemantic.length > 0);
            opt.localClassifierMarket.onclick = () => openSettings('plugins', 'onnx');
        }
        let pluginPart;
        if (semanticSetting === 'off') pluginPart = '语义模型已关闭';
        else if (visibleSemantic.length) pluginPart = '插件：' + visibleSemantic.map((p) => p.label || p.id).join('、');
        else if (semanticSetting) pluginPart = '语义模型未找到（' + semanticSetting + '）';
        else pluginPart = loadErrors.length ? '插件加载失败：' + loadErrors[0] : '语义模型未安装';
        if (getConfig().localClassifierEnabled !== true) {
            opt.localClassifierStatus.textContent = pluginPart || '未启用';
            return;
        }
        const mod = typeof localClassifier === 'function' ? localClassifier() : null;
        if (!mod) {
            opt.localClassifierStatus.textContent = pluginPart || '不可用';
            return;
        }
        mod.ensureLoaded().then(() => {
            const st = mod.getStatus();
            const bits = [getConfig().localClassifierLinear === 'off' ? '线性已关闭' : '出厂 ' + (st.factoryVersion || '—')];
            if (getConfig().localClassifierPersonalize === true) {
                bits.push('样本 ' + st.sampleCount);
                bits.push('delta ' + st.deltaDims + ' 维');
                if (st.trainedAt) bits.push('最近学习 ' + new Date(st.trainedAt).toLocaleString());
            }
            if (st.disabled.length) bits.push('已熔断：' + st.disabled.join('、'));
            if (pluginPart) bits.push(pluginPart);
            opt.localClassifierStatus.textContent = bits.join(' · ');
        }).catch(() => {
            opt.localClassifierStatus.textContent = '权重加载失败';
        });
    }

    function runLocalClassifierTest() {
        if (!opt.localClassifierTestResult) return;
        const command = (opt.localClassifierTest.value || '').trim();
        if (!command) {
            opt.localClassifierTestResult.textContent = '';
            return;
        }
        if (getConfig().localClassifierEnabled !== true) {
            opt.localClassifierTestResult.textContent = '端侧分类器未启用';
            return;
        }
        const mod = typeof localClassifier === 'function' ? localClassifier() : null;
        if (!mod) return;
        mod.scoreText(command).then((r) => {
            opt.localClassifierTestResult.textContent = 'score=' + r.score.toFixed(2) + ' → '
                + (r.verdict.allow ? '放行' : '转人工') + '（' + LOCAL_CLASSIFIER_STRICTNESS_NAMES[normalizeLocalClassifierStrictness(getConfig().localClassifierStrictness)]
                + ' 阈值 ' + r.verdict.threshold + (r.deltaDims ? ' · delta ' + r.deltaDims + ' 维' : '') + '）';
        }).catch((e) => {
            opt.localClassifierTestResult.textContent = '打分失败：' + ((e && e.message) || e);
        });
    }

    // ---- 子代理命令沙箱：授权残留的检查与清理（docs/finished-plans/subagent-sandbox.md §4 阶段 D） ----
    // 授权是跨会话复用的缓存，日常不必清理；这里只为「想还原目录权限」的用户提供出口。
    let sandboxGrantBound = false;
    let sandboxGrantBusy = false;

    function sandboxWorkspaceRoot() {
        const root = typeof ctx.getScopeRoot === 'function' ? ctx.getScopeRoot() : '';
        return root || aiProjectRoot() || '';
    }

    async function refreshSandboxGrant() {
        if (!opt.sandboxState) return;
        if (!backend.SandboxScan) {
            opt.sandboxState.textContent = '当前版本不支持沙箱授权检查';
            if (opt.sandboxScanBtn) opt.sandboxScanBtn.disabled = true;
            if (opt.sandboxRevokeBtn) opt.sandboxRevokeBtn.disabled = true;
            return;
        }
        const root = sandboxWorkspaceRoot();
        if (!root) {
            opt.sandboxState.textContent = '（未打开工作区）';
            if (opt.sandboxRevokeBtn) opt.sandboxRevokeBtn.disabled = true;
            return;
        }
        opt.sandboxState.textContent = '检查中…';
        try {
            const state = await backend.SandboxScan(root);
            opt.sandboxState.textContent = describeSandboxGrant(state);
            if (opt.sandboxRevokeBtn) opt.sandboxRevokeBtn.disabled = !sandboxHasResidue(state);
        } catch (e) {
            opt.sandboxState.textContent = '检查失败：' + ((e && e.message) || e);
            if (opt.sandboxRevokeBtn) opt.sandboxRevokeBtn.disabled = true;
        }
    }

    async function revokeSandboxGrant() {
        if (sandboxGrantBusy || !opt.sandboxState) return;
        const root = sandboxWorkspaceRoot();
        if (!root || !backend.SandboxRevoke) return;
        sandboxGrantBusy = true;
        if (opt.sandboxRevokeBtn) opt.sandboxRevokeBtn.disabled = true;
        opt.sandboxState.textContent = '正在清除…';
        try {
            const state = await backend.SandboxRevoke(root);
            opt.sandboxState.textContent = sandboxHasResidue(state)
                ? describeSandboxGrant(state)
                : '已清除本工作区的沙箱授权与完整性标签（子代理下次执行时会重新授权）';
        } catch (e) {
            opt.sandboxState.textContent = '清除失败：' + ((e && e.message) || e);
        } finally {
            sandboxGrantBusy = false;
            if (opt.sandboxRevokeBtn) opt.sandboxRevokeBtn.disabled = true;
        }
    }

    function renderSandboxGrant() {
        if (!opt.sandboxState) return;
        if (!sandboxGrantBound) {
            sandboxGrantBound = true;
            if (opt.sandboxScanBtn) opt.sandboxScanBtn.addEventListener('click', () => { refreshSandboxGrant(); });
            if (opt.sandboxRevokeBtn) opt.sandboxRevokeBtn.addEventListener('click', () => { revokeSandboxGrant(); });
        }
        refreshSandboxGrant();
    }

    function renderPermissionSettings() {
        if (opt.permissionsPath) {
            const path = projectRulesPath();
            opt.permissionsPath.textContent = path || '（未打开工作区）';
        }
        if (opt.permissionClassifier) opt.permissionClassifier.checked = getConfig().autoClassifier === true;
        renderClassifierModelOptions();
        renderLocalClassifierSettings();
        renderSandboxGrant();
        if (opt.permissionsSession) {
            opt.permissionsSession.innerHTML = '';
            const session = currentSession();
            const rules = session ? commandRulesFor(session) : [];
            if (!rules.length) {
                const empty = document.createElement('span');
                empty.className = 'ai-approved-empty';
                empty.textContent = '（无；审批卡里的「本会话允许」会出现在这里）';
                opt.permissionsSession.appendChild(empty);
            } else {
                for (const rule of rules.slice().reverse()) {
                    const row = document.createElement('div');
                    row.className = 'ai-approved-row';
                    const text = document.createElement('span');
                    text.className = 'ai-approved-path';
                    text.textContent = (rule.mode === 'family' ? '同类命令 ' : '相同命令 ') + (rule.signature || rule.command);
                    const cwd = document.createElement('span');
                    cwd.className = 'ai-perm-cwd';
                    cwd.textContent = rule.cwd || '';
                    const project = document.createElement('button');
                    project.type = 'button';
                    project.className = 'ai-perm-mini';
                    project.textContent = '存入项目';
                    project.addEventListener('click', () => {
                        const pattern = sessionRulePattern(rule);
                        if (!pattern) return;
                        addProjectRule('command', 'allow', pattern).then((added) => {
                            flash(added
                                ? '已加入项目规则：' + pattern + ' → allow'
                                : '项目规则已存在：' + pattern);
                        }).catch((e) => flash('保存失败：' + ((e && e.message) || e), true));
                    });
                    const remove = document.createElement('button');
                    remove.type = 'button';
                    remove.className = 'ai-perm-mini';
                    remove.textContent = '×';
                    remove.addEventListener('click', () => {
                        if (!removeCommandApprovalRule(session, rule)) return;
                        renderPermissionSettings();
                        flash('已删除本会话授权');
                    });
                    row.append(text, cwd, project, remove);
                    opt.permissionsSession.appendChild(row);
                }
            }
            if (opt.permissionsSessionClear) opt.permissionsSessionClear.disabled = !rules.length;
        }
        if (opt.permissionsLog) {
            opt.permissionsLog.innerHTML = '';
            if (!getPermissionAudit().length) {
                const empty = document.createElement('span');
                empty.className = 'ai-approved-empty';
                empty.textContent = '（本次运行还没有审批记录）';
                opt.permissionsLog.appendChild(empty);
            } else {
                const labels = {allow: '放行', ask: '审批', deny: '拒绝', classify: '分类'};
                for (const entry of getPermissionAudit().slice(-20).reverse()) {
                    const row = document.createElement('div');
                    row.className = 'ai-approved-row';
                    const badge = document.createElement('span');
                    badge.className = 'ai-perm-decision ' + entry.decision;
                    badge.textContent = labels[entry.decision] || entry.decision;
                    const text = document.createElement('span');
                    text.className = 'ai-approved-path';
                    text.textContent = entry.subject;
                    const source = document.createElement('span');
                    source.className = 'ai-perm-cwd';
                    source.textContent = AUDIT_SOURCE_LABELS[entry.source] || entry.source || '';
                    const time = document.createElement('span');
                    time.className = 'ai-perm-time';
                    time.textContent = new Date(entry.at).toLocaleTimeString();
                    const actions = document.createElement('span');
                    actions.className = 'ai-perm-row-actions';
                    const pattern = auditRulePattern(entry);
                    if (pattern) {
                        for (const behavior of ['allow', 'ask', 'deny']) {
                            const button = document.createElement('button');
                            button.type = 'button';
                            button.className = 'ai-perm-mini';
                            button.textContent = '+' + behavior;
                            button.addEventListener('click', () => {
                                addProjectRule(entry.kind, behavior, pattern).then((added) => {
                                    flash(added
                                        ? '已加入项目规则：' + pattern + ' → ' + behavior
                                        : '项目规则已存在：' + pattern);
                                }).catch((e) => flash('保存失败：' + ((e && e.message) || e), true));
                            });
                            actions.appendChild(button);
                        }
                    }
                    row.append(badge, text, source, time, actions);
                    opt.permissionsLog.appendChild(row);
                }
            }
        }
    }

    async function refreshPermissionEditors(force) {
        if (!opt.permissionsAllow) return;
        const rules = await ensureProjectRules(force === true);
        opt.permissionsAllow.value = formatRuleLines(rules, 'allow');
        if (opt.permissionsAsk) opt.permissionsAsk.value = formatRuleLines(rules, 'ask');
        if (opt.permissionsDeny) opt.permissionsDeny.value = formatRuleLines(rules, 'deny');
        renderProjectRuleTable();
    }

    function isPathApproved(session, path) {
        const key = aiPathKey(path);
        if ((getConfig().approvedPaths || []).some((item) => aiPathKey(item) === key)) return true;
        return !!(session && (session.approvedPaths || []).some((item) => aiPathKey(item) === key));
    }

    // 终端命令的会话级放行只存内存：重启应用或重新加载对话后需要重新授权。
    const commandApprovalRules = new Map();

    function commandRulesFor(session) {
        if (!session || !session.id) return [];
        return commandApprovalRules.get(session.id) || [];
    }

    function addCommandApprovalRule(session, rule) {
        if (!session || !session.id || !rule) return;
        const cwdKey = aiPathKey(rule.cwd);
        const command = rule.mode === 'exact' ? commandText(rule.command) : '';
        const signature = rule.mode === 'family' ? String(rule.signature || '') : '';
        if (rule.mode === 'exact' && !command) return;
        if (rule.mode === 'family' && !signature) return;
        const list = commandRulesFor(session);
        const exists = list.some((item) => item.mode === rule.mode && item.cwdKey === cwdKey &&
            (item.mode === 'exact' ? item.command === command : item.signature === signature));
        if (exists) return;
        list.push({
            mode: rule.mode,
            command,
            signature,
            cwdKey,
            cwd: aiNormalizePath(rule.cwd),
            createdAt: Date.now(),
        });
        if (list.length > 30) list.splice(0, list.length - 30);
        commandApprovalRules.set(session.id, list);
    }

    function matchCommandApproval(session, command, cwd) {
        const rules = commandRulesFor(session);
        if (!rules.length) return null;
        return matchCommandRule(rules, command, aiPathKey(cwd));
    }

    // ---------- 项目级权限规则（<工作区>/.cadt/permissions.json） ----------

    function projectRulesPath() {
        const root = aiProjectRoot();
        return root ? aiJoinPath(root, '.cadt/permissions.json') : '';
    }

    function projectRulesKey() {
        return aiWorkspaceKey(aiProjectRoot());
    }

    let projectRulesCache = {key: '', rules: emptyPermissionRules(), at: 0};
    // 规则文件是读-改-写：连续添加/删除必须串行，否则后一次会把前一次的结果覆盖掉。
    let projectRulesMutation = Promise.resolve();
    const PROJECT_RULES_TTL = 3000;

    function enqueueProjectRulesMutation(task) {
        const next = projectRulesMutation.then(task, task);
        projectRulesMutation = next.catch(() => {});
        return next;
    }

    function currentProjectRules() {
        if (projectRulesCache.key !== projectRulesKey()) return emptyPermissionRules();
        return projectRulesCache.rules;
    }

    async function ensureProjectRules(force) {
        const key = projectRulesKey();
        const path = projectRulesPath();
        if (!path) {
            projectRulesCache = {key, rules: emptyPermissionRules(), at: Date.now()};
            return projectRulesCache.rules;
        }
        if (!force && projectRulesCache.key === key && Date.now() - projectRulesCache.at < PROJECT_RULES_TTL) {
            return projectRulesCache.rules;
        }
        let rules = emptyPermissionRules();
        try {
            const read = await readTextFile(path, 256 << 10);
            if (read && read.text && read.text.trim()) {
                const parsed = parseJson(read.text, null);
                if (parsed && typeof parsed === 'object') rules = normalizePermissionRules(parsed);
            }
        } catch (e) {
            // 文件不存在 / 没有工作区：按空规则处理
        }
        projectRulesCache = {key, rules, at: Date.now()};
        return rules;
    }

    async function saveProjectRules(rules) {
        const path = projectRulesPath();
        if (!path) throw new Error('当前没有工作区，无法保存项目权限规则');
        const payload = {
            version: PERMISSION_VERSION,
            command: rules.command,
            write: rules.write,
            web: rules.web,
        };
        const text = JSON.stringify(payload, null, 2) + '\n';
        if (backend.AIEnsureDir) {
            try { await backend.AIEnsureDir(aiPathDir(path)); } catch (e) {}
        }
        await backend.SaveFile(path, text, 'lf', false, 'utf-8');
        projectRulesCache = {key: projectRulesKey(), rules: normalizePermissionRules(payload), at: Date.now()};
        return path;
    }

    async function addProjectRule(kind, behavior, rule) {
        return enqueueProjectRulesMutation(async () => {
            const current = await ensureProjectRules(true);
            const next = normalizePermissionRules(current);
            const list = next[kind] && next[kind][behavior];
            const text = String(rule || '').trim();
            if (!list || !text) return false;
            if (list.some((item) => item.toLowerCase() === text.toLowerCase())) return false;
            list.push(text);
            await saveProjectRules(next);
            renderPermissionSettings();
            refreshPermissionEditors().catch(() => {});
            return true;
        });
    }

return {
        AUDIT_SOURCE_LABELS,
        LOCAL_CLASSIFIER_STRICTNESS_NAMES,
        PERMISSION_KIND_LABELS,
        PROJECT_RULES_TTL,
        addCommandApprovalRule,
        addProjectRule,
        auditRulePattern,
        commandApprovalRules,
        commandRulesFor,
        currentProjectRules,
        enqueueProjectRulesMutation,
        ensureProjectRules,
        isPathApproved,
        localClassifierTestTimer,
        matchCommandApproval,
        projectRuleRow,
        projectRulesCache,
        projectRulesKey,
        projectRulesMutation,
        projectRulesPath,
        refreshPermissionEditors,
        removeCommandApprovalRule,
        removeProjectRule,
        renderApprovedSettings,
        renderClassifierModelOptions,
        renderLocalClassifierSettings,
        renderLocalClassifierStatus,
        renderPermissionSettings,
        renderPluginToolSettings,
        renderProjectRuleTable,
        renderSemanticModelOptions,
        runLocalClassifierTest,
        scheduleLocalClassifierTest,
        saveProjectRules,
        sessionRulePattern,
    };
}
