// ai-app-approval.js：app_control 高危动作的审批规格与插件来源判定（纯函数，可单测）。
// 动作审批卡（composer 接管区 kind='action'）的字段归一也在这里；
// 插件安装/卸载权限矩阵只依赖权限档与「是否官方市场」，不碰 DOM / 网络。

export const ACTION_RISK_IDS = ['low', 'medium', 'high'];

export const OFFICIAL_PLUGIN_ORG = 'cadt-datalens-plugins';

const OFFICIAL_HOSTS = new Set(['gitee.com', 'www.gitee.com', 'github.com', 'www.github.com']);

// 仓库地址解析：https(s)://<host>/<org>/<repo>(.git) 与 git@<host>:<org>/<repo>.git
// 以及 ssh://git@<host>/<org>/<repo>。非法地址返回 null。
export function parsePluginRepoUrl(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return null;
    let host = '';
    let path = '';
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(text);
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && scp) {
        host = scp[1];
        path = scp[2];
    } else {
        try {
            const url = new URL(text);
            host = url.hostname || '';
            path = decodeURIComponent(url.pathname || '');
        } catch (e) {
            return null;
        }
    }
    host = host.toLowerCase();
    path = path.replace(/^\/+/, '').replace(/\.git$/i, '');
    const parts = path.split('/').filter(Boolean);
    if (!host || parts.length < 2) return null;
    return {host, org: parts[0], repo: parts[1], fullName: parts[0] + '/' + parts[1]};
}

// 官方 = Gitee/GitHub 的 cadt-datalens-plugins 组织（两个镜像都算）。
export function isOfficialPluginSource(rawUrl) {
    const parsed = parsePluginRepoUrl(rawUrl);
    return !!parsed && OFFICIAL_HOSTS.has(parsed.host) && parsed.org.toLowerCase() === OFFICIAL_PLUGIN_ORG;
}

// 安装路由：read 拒绝；full 直通；auto 仅非官方要审批；edit 一律审批。
export function pluginInstallRoute(scope, official) {
    if (scope === 'read') return 'deny';
    if (scope === 'full') return 'direct';
    if (scope === 'auto' && official) return 'direct';
    return 'approve';
}

// 卸载是永久删除（DeletePlugin 走 os.RemoveAll）：full 之外一律审批。
export function pluginUninstallRoute(scope) {
    if (scope === 'read') return 'deny';
    if (scope === 'full') return 'direct';
    return 'approve';
}

function clampText(value, max) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

// 动作审批规格归一：面板只认这些字段，非法输入返回错误（不静默兜底）。
export function normalizeActionApprovalSpec(raw) {
    if (!raw || typeof raw !== 'object') return {ok: false, error: '审批规格为空'};
    const title = clampText(raw.title, 160);
    if (!title) return {ok: false, error: '审批规格缺少 title'};
    const risk = ACTION_RISK_IDS.includes(raw.risk) ? raw.risk : 'medium';
    const warnings = (Array.isArray(raw.warnings) ? raw.warnings : [])
        .map((item) => clampText(item, 300)).filter(Boolean).slice(0, 6);
    const locate = raw.locate && typeof raw.locate === 'object' && raw.locate.pane
        ? {pane: clampText(raw.locate.pane, 60), row: clampText(raw.locate.row, 120)}
        : null;
    return {
        ok: true,
        spec: {
            action: clampText(raw.action, 60) || 'action',
            title,
            // target 保留换行、上限 2000：生命周期钩子审批卡的命令全文（含多行）走这里，
            // 压平空白会让「用户批准的」与「实际执行的」不一致（workspace-lifecycle-hooks 方案）
            target: String(raw.target == null ? '' : raw.target).trim().slice(0, 2000),
            oldValue: clampText(raw.oldValue, 600),
            newValue: clampText(raw.newValue, 600),
            risk,
            warnings,
            source: clampText(raw.source, 300),
            locate,
        },
    };
}
