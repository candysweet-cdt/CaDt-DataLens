// settings-tree.js：设置页 DOM → 可定位的设置树（app_control 的 get_settings_tree /
// set_setting_row / open_settings row 共用）。
// 行 id：控件自带 id 优先（如 ai-opt-subagent-depth），否则用「页 / 组 / 标题」的稳定哈希。
// 危险分级与可写判定与树同源：中/高危险项写入前要过动作审批，布局形态永久不可写。
// 纯逻辑（id 归一 / 分级 / 取值整形）不依赖 DOM，可单测。

export const SETTINGS_RISK_LABELS = {low: '低', medium: '中', high: '高'};

// 布局形态只能由用户手动切换（用户硬规则）：树里可见，但永远不可由 AI 写。
// ai-opt-cognition：启停走 app_control 的 cognition_toggle（无条件审批卡）——树里可见，
// 但 set_setting_row 不得成为绕开那张审批卡的第二条写路径。
export const PROTECTED_SETTING_IDS = new Set(['ai-opt-display-mode', 'ai-opt-cognition']);

// 高风险：安全姿态 / 执行权限 / 第三方代码 / 系统级注册。
const HIGH_RISK_IDS = new Set([
    'ai-opt-default-scope', 'ai-opt-app-control', 'ai-opt-worklog',
    'ai-opt-auto-classifier', 'ai-opt-classifier-model',
    'ai-opt-local-linear', 'ai-opt-local-semantic', 'ai-opt-local-strictness', 'ai-opt-local-personalize',
    'ai-opt-subagent-max', 'ai-opt-subagent-depth', 'ai-opt-subagent-model',
    'ai-opt-mcp-enabled', 'ai-opt-export-keys',
    'plugin-path-mode',
    'orch-opt-review-default',
    'opt-file-assoc', 'opt-context-menu', 'opt-agent-skill', 'opt-path-cmd', 'opt-developer-mode',
]);

// 中风险：资源 / 保留 / 执行行为 / 上下文注入量。
const MEDIUM_RISK_IDS = new Set([
    'ai-opt-threshold', 'ai-opt-autocompact', 'ai-opt-context-slim',
    'ai-opt-subagent-rounds',
    'ai-opt-idle-timeout', 'ai-opt-retry-max', 'ai-opt-ask-timeout', 'ai-opt-ask-action',
    'ai-opt-log-enabled', 'ai-opt-log-path',
    'ai-opt-skill-index-max', 'ai-opt-inject-agents', 'ai-opt-inject-memory', 'ai-opt-inject-envvars',
    'run-cwd', 'run-timeout', 'run-dirty-mode',
    'opt-activity-retention', 'opt-auto-update',
    'plugin-market-source-mode',
    'envvar-encrypted',
    'lifecycle-enabled',
    'orch-opt-max-parallel', 'orch-opt-max-attempts', 'orch-opt-batch-timeout',
    'orch-opt-audit-idle', 'orch-opt-budget',
]);

// 审批卡上的警示文案（高风险项必须能说清为什么危险）。
const RISK_REASONS = {
    'ai-opt-default-scope': '新建会话的默认权限档位，影响之后所有 AI 会话能做什么',
    'ai-opt-app-control': '应用操作工具开关，直接决定 AI 能否操作界面与创建群聊',
    'ai-opt-auto-classifier': '云端分类器复核开关，影响命令审批的放行判定',
    'ai-opt-classifier-model': '云端复核所用模型，影响审批判定质量与费用',
    'ai-opt-local-linear': '端侧线性分类器开关，影响命令自动放行判定',
    'ai-opt-local-semantic': '端侧语义分类器开关，影响命令自动放行判定',
    'ai-opt-local-strictness': '分类器严格度：调低会让更多命令直接放行',
    'ai-opt-local-personalize': '个性化学习会根据你的审批习惯改变放行边界',
    'ai-opt-subagent-max': '子代理并发上限，放宽会让 AI 同时派出更多代理',
    'ai-opt-subagent-depth': '子代理层级上限，放宽会让 AI 更深地自我派发',
    'ai-opt-subagent-model': '子代理默认模型，影响子代理的成本与能力',
    'ai-opt-mcp-enabled': 'MCP 客户端总开关，接入第三方工具执行能力',
    'ai-opt-export-keys': '配置导出会包含 API Key 明文',
    'plugin-path-mode': '插件目录模式：插件代码将以应用权限运行',
    'opt-file-assoc': '注册系统文件关联（写注册表）',
    'opt-context-menu': '注册资源管理器右键菜单（写注册表）',
    'opt-agent-skill': '写入全局 Agent Skill 目录',
    'opt-path-cmd': '把 datalens 命令加入用户 PATH',
    'opt-developer-mode': '开发者模式会记录更多调试信息并开放调试入口',
    'ai-opt-threshold': '上下文压缩阈值，调高可能让模型在超窗前仍不收口',
    'ai-opt-autocompact': '自动压缩会改写会话上下文（摘要 + 截止点）',
    'ai-opt-context-slim': '实时瘦身会剔除旧轮思考与大输出',
    'ai-opt-subagent-rounds': '子代理默认轮次，放宽会增加调用与耗时',
    'ai-opt-inject-agents': 'AGENTS.md 全文注入会增加每轮上下文与费用',
    'ai-opt-inject-memory': 'MEMORY.md 索引注入会增加每轮上下文',
    'ai-opt-inject-envvars': '环境变量名列表会发送给模型',
    'run-cwd': '脚本相对路径的执行目录',
    'run-timeout': '运行超时（关闭后长驻命令会一直占用）',
    'opt-activity-retention': '操作留痕保留月数，调小会更早删除审计记录',
    'plugin-market-source-mode': '插件市场数据源（Gitee / GitHub）',
    'envvar-encrypted': '环境变量存储与加密方式',
    'lifecycle-enabled': '总开关控制「生命周期钩子自动执行」：覆盖打开/关闭工作区、会话起轮、工具前后、权限请求、停止生成等 9 个事件',
    'orch-opt-review-default': '编排默认关闭独立审查门会少一道质量关卡',
    'orch-opt-max-parallel': '编排默认并发越高，同时改文件与消耗 token 的速度越快',
    'orch-opt-max-attempts': '编排自动重试次数影响返工成本',
    'orch-opt-batch-timeout': '编排单批超时影响卡住批次占用时间',
    'orch-opt-audit-idle': '编排审计静默阈值过低会误报、过高会晚发现卡死',
    'orch-opt-budget': '编排默认 token 预算是成本熔断线',
};

export function classifySettingsRisk(id) {
    const key = String(id || '');
    if (HIGH_RISK_IDS.has(key)) return 'high';
    if (MEDIUM_RISK_IDS.has(key)) return 'medium';
    if (/^ai-opt-subagent-choice\d+$/.test(key)) return 'high';
    return 'low';
}

export function settingsRiskReason(id) {
    return RISK_REASONS[String(id || '')] || '';
}

function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return ('00000000' + (hash >>> 0).toString(16)).slice(-8);
}

// 行 id：控件 id 优先；无 id 的行用确定性哈希（同一页/组/标题永远得到同一个 id）。
export function settingsRowId({pane, group, title, controlId}) {
    const raw = String(controlId || '').trim();
    if (raw) return raw;
    return 'set-' + fnv1a([pane, group, title].join('|'));
}

function textOf(el) {
    return el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '';
}

function controlKind(control) {
    if (!control) return 'none';
    const tag = String(control.tagName || '').toUpperCase();
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'textarea';
    const type = String(control.type || '').toLowerCase();
    if (type === 'checkbox') return 'switch';
    if (type === 'number') return 'number';
    if (type === 'text' || type === 'password' || type === 'search' || !type) return 'text';
    return 'other';
}

export function describeSettingsValue(kind, control) {
    if (!control) return '';
    if (kind === 'switch') return control.checked ? '开启' : '关闭';
    if (kind === 'select') {
        const option = control.selectedOptions && control.selectedOptions[0];
        return String(control.value == null ? '' : control.value) + (option ? '（' + textOf(option) + '）' : '');
    }
    return String(control.value == null ? '' : control.value);
}

// 待写入值的展示形态（审批卡「原值 → 新值」用；select 带选项文案）。
export function describeSettingsInput(kind, control, value) {
    if (kind === 'switch') return value ? '开启' : '关闭';
    if (kind === 'select') {
        const option = [...((control && control.options) || [])].find((item) => String(item.value) === String(value));
        return String(value == null ? '' : value) + (option ? '（' + textOf(option) + '）' : '');
    }
    return String(value == null ? '' : value);
}

// 把模型给的值整形到控件可接受的形式；非法值返回错误而不是静默钳制。
export function coerceSettingsValue(kind, control, raw) {
    if (!control) return {ok: false, error: '该行没有可写控件'};
    if (kind === 'switch') {
        const text = String(raw == null ? '' : raw).trim().toLowerCase();
        if (['true', 'on', '1', '开', '开启', '是', 'yes'].includes(text)) return {ok: true, value: true};
        if (['false', 'off', '0', '关', '关闭', '否', 'no'].includes(text)) return {ok: true, value: false};
        return {ok: false, error: '开关只接受 true / false（或 开 / 关）'};
    }
    if (kind === 'select') {
        const text = String(raw == null ? '' : raw).trim();
        const options = [...(control.options || [])];
        const byValue = options.find((option) => String(option.value) === text);
        if (byValue) return {ok: true, value: String(byValue.value)};
        const byLabel = options.find((option) => textOf(option) === text);
        if (byLabel) return {ok: true, value: String(byLabel.value)};
        return {ok: false, error: '取值不在可选项内；可用：' + options.map((option) => String(option.value)).join(' / ')};
    }
    if (kind === 'number') {
        const num = Number(raw);
        if (!Number.isFinite(num)) return {ok: false, error: '需要数字'};
        const min = Number(control.min);
        const max = Number(control.max);
        if (String(control.min || '') !== '' && Number.isFinite(min) && num < min) {
            return {ok: false, error: '不能小于 ' + min};
        }
        if (String(control.max || '') !== '' && Number.isFinite(max) && num > max) {
            return {ok: false, error: '不能大于 ' + max};
        }
        return {ok: true, value: num};
    }
    if (kind === 'text' || kind === 'textarea') {
        const text = String(raw == null ? '' : raw);
        const maxlength = Number(control.maxLength);
        if (Number.isFinite(maxlength) && maxlength > 0 && text.length > maxlength) {
            return {ok: false, error: '文本超过长度上限 ' + maxlength};
        }
        return {ok: true, value: text};
    }
    return {ok: false, error: '该控件类型不支持由 AI 写入'};
}

// 写入控件并触发 change：走设置页原有的校验 / 持久化 / 刷新通路，不另开一条写入口。
export function applySettingsValue(kind, control, value) {
    if (kind === 'switch') control.checked = !!value;
    else control.value = String(value);
    control.dispatchEvent(new Event('change', {bubbles: true}));
}

function buildRow(pane, group, rowEl) {
    const titleEl = rowEl.querySelector('.set-main .set-title');
    const descEl = rowEl.querySelector('.set-main .set-desc');
    const title = textOf(titleEl) || textOf(rowEl).slice(0, 40) || '（未命名）';
    const desc = textOf(descEl).slice(0, 160);
    const controlBox = rowEl.querySelector('.set-control');
    const fields = controlBox
        ? [...controlBox.querySelectorAll('input, select, textarea')].filter((el) => String(el.type || '').toLowerCase() !== 'file')
        : [];
    const buttons = controlBox ? [...controlBox.querySelectorAll('button')] : [];
    let kind = 'readonly';
    let control = null;
    if (fields.length === 1) {
        control = fields[0];
        kind = controlKind(control);
    } else if (fields.length > 1) {
        kind = 'mixed';
    } else if (buttons.length) {
        kind = 'action';
    }
    const controlId = (control && control.id) || (buttons[0] && buttons[0].id) || '';
    const id = settingsRowId({pane, group, title, controlId});
    const settable = !!control && ['switch', 'select', 'number', 'text', 'textarea'].includes(kind) && !control.disabled;
    return {
        id,
        pane,
        group,
        title,
        desc,
        kind,
        settable,
        protected: PROTECTED_SETTING_IDS.has(id),
        risk: classifySettingsRisk(id),
        riskReason: settingsRiskReason(id),
        value: describeSettingsValue(kind, control),
        options: kind === 'select' ? [...control.options].map((option) => ({value: String(option.value), label: textOf(option)})) : null,
        rowEl,
        control,
    };
}

// 树构建：导航分组 → 每个 pane 的组标题 / 行；id 冲突加 -2 后缀（同一算法在查找时复用）。
export function buildSettingsTree(root) {
    const doc = root || (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof doc.querySelectorAll !== 'function') return {panes: []};
    const panes = [];
    const seenPanes = new Set();
    const usedIds = new Set();
    for (const navEl of doc.querySelectorAll('.snav-item[data-pane]')) {
        const pane = String(navEl.dataset.pane || '');
        if (!pane || seenPanes.has(pane)) continue;
        seenPanes.add(pane);
        const parentLabel = navEl.classList.contains('snav-child')
            ? textOf(navEl.closest('.snav-group') && navEl.closest('.snav-group').querySelector('.snav-parent'))
            : '';
        const paneEl = doc.querySelector('.settings-pane[data-pane="' + pane + '"]');
        const rows = [];
        if (paneEl) {
            let group = '';
            for (const el of paneEl.querySelectorAll('.set-group-title, .set-row')) {
                if (el.classList.contains('set-group-title')) {
                    group = textOf(el);
                    continue;
                }
                const row = buildRow(pane, group, el);
                let id = row.id;
                let dup = 2;
                while (usedIds.has(id)) id = row.id + '-' + dup++;
                row.id = id;
                usedIds.add(id);
                rows.push(row);
            }
        }
        panes.push({id: pane, label: textOf(navEl) || pane, group: parentLabel, rows});
    }
    return {panes};
}

export function findSettingsRow(id, root) {
    const key = String(id || '');
    if (!key) return null;
    const {panes} = buildSettingsTree(root);
    for (const pane of panes) {
        for (const row of pane.rows) {
            if (row.id === key) return {...row, paneLabel: pane.label};
        }
    }
    return null;
}

// 返回面只出可序列化字段（DOM 引用留给 set_setting_row / open_settings 行内使用）。
export function settingsRowSnapshot(row) {
    if (!row) return null;
    return {
        id: row.id,
        pane: row.pane,
        group: row.group,
        title: row.title,
        desc: row.desc,
        kind: row.kind,
        value: row.value,
        options: row.options,
        settable: row.settable && !row.protected,
        protected: row.protected,
        risk: row.risk,
        riskReason: row.riskReason,
    };
}
