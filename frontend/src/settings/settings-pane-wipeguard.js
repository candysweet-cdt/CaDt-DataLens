// settings-pane-wipeguard.js：设置 → 存储与清理 → 「工作区防护」区（docs/finished-plans/workspace-wipe-guard.md §4.5 / §3.4）。
//
// 渲染三块：开关组（总开关 / 诱饵 / 定期快照 + 备份根）· 备份时间线（按文件分组 + 还原）·
// 快照清单（tar / manifest + 还原）。清空与删除走 WipeGuardClear（删除前摘 ACL 在 Go 侧）。
// 本模块只渲染与传 id；备份库、清理阈值、路径校验都在 internal/wipeguard。
// 由 main.js 组合根接线：storage pane 渲染完后追加渲染本区块（不互相 import）。
// DOM 复用 storage pane 的 stg-row 系列类（同一张设置页，视觉一致）。

import {createSwitch, createInput} from '../core/form-controls.js';
import {formatBytes} from '../core/humanize.js';
import {el} from '../core/dom.js';
import {legacyPathKey} from '../core/path-key.js';

// ---- 纯函数（测试见 test/settings/settings-pane-wipeguard.test.mjs）----

// humanBytes：字节数人可读化，实现统一到 core/humanize.js 的 formatBytes（保留旧名）。
export const humanBytes = formatBytes;

// formatBackupTime：时间戳 → 'MM-DD HH:mm'（当年）或 'YYYY-MM-DD'（往年）。
export function formatBackupTime(at, now) {
    const ts = Number(at) || 0;
    if (!ts) return '—';
    const d = new Date(ts);
    const ref = now ? new Date(now) : new Date();
    const two = (x) => String(x).padStart(2, '0');
    if (d.getFullYear() === ref.getFullYear()) {
        return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
    }
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

// groupBackupEntries：索引行按文件分组（每文件取「最新一份」为展示主体），按最新时间倒序。
// rows 顺序任意；无 blob 的 tombstone / skipped 行只作为时间线信息保留在 latest 里。
export function groupBackupEntries(rows) {
    const list = Array.isArray(rows) ? rows.slice() : [];
    const byRel = new Map();
    for (const row of list) {
        if (!row || !row.rel) continue;
        const group = byRel.get(row.rel) || {rel: row.rel, latest: null, count: 0};
        group.count++;
        if (!group.latest || (row.at || 0) > (group.latest.at || 0)) group.latest = row;
        byRel.set(row.rel, group);
    }
    return Array.from(byRel.values())
        .sort((a, b) => (b.latest.at || 0) - (a.latest.at || 0));
}

// normalizePathKey：路径归一化（与后端 WorkspaceKey 归一化语义一致）。
export function normalizePathKey(p) {
    return legacyPathKey(p || '')
}

// validateBackupRoot：备份根校验（方案 §4.1）。
//   空 → 用默认 appdata（ok）；非绝对路径 → error；在工作区内部（含相等）→ error
//   （放进去 = 白放）；是工作区的祖先目录（含盘根）→ warn（祖先被删会连带备份）。
// 返回 {ok, severity: '' | 'warn' | 'error', reason}。
export function validateBackupRoot(path, ws) {
    const value = String(path || '').trim();
    if (!value) return {ok: true, severity: '', reason: ''};
    if (!/^[a-zA-Z]:[\\/]/.test(value) && !value.startsWith('\\\\') && !value.startsWith('/')) {
        return {ok: false, severity: 'error', reason: '必须是绝对路径（如 D:\\backups）'};
    }
    const key = normalizePathKey(value);
    const wsKey = normalizePathKey(ws);
    if (!wsKey) return {ok: true, severity: '', reason: ''};
    // 判定顺序：相等 / 在工作区内 → error；工作区在备份根内（祖先，含盘根 'd:'）→ warn。
    if (key === wsKey || key.startsWith(wsKey + '/')) {
        return {ok: false, severity: 'error', reason: '备份根不能在工作区内部——整仓删除会连备份一起删掉，等于没有防护'};
    }
    if (wsKey.startsWith(key + '/')) {
        return {ok: true, severity: 'warn', reason: '备份根是工作区的祖先目录：上级目录被删会连带备份，建议放在无关联的盘符下'};
    }
    return {ok: true, severity: '', reason: ''};
}

// wipeGuardDefaults：设置段默认值（全部开启，方案 §3.4）。
export function wipeGuardDefaults() {
    return {enabled: true, snapshots: true, backupRoot: ''};
}

// resolveDep：统一 deps 取值。main.js 用 `get xxx(){return value}` 传 getter——
// 读取 deps.xxx 即得到最终值（对象 / 字符串 / 函数）；少数宿主可能直接传函数 () => value。
// 两种形态都要能取到值，且**绝不能把非函数当函数调用**（这正是本面板此前渲染失效的根因）。
// 注意：action 类 deps（flash / confirmAction / applySettings / syncConfig）求值结果本身就是
// 函数，调用方拿到后照常调用，不走这里。
export function resolveDep(raw, fallback) {
    const v = typeof raw === 'function' ? raw() : raw;
    return v == null ? fallback : v;
}

// ---- 工厂 ----

export function createSettingsPaneWipeguard(deps) {
    // deps: { get backend, get root, get settings, get applySettings,
    //         get confirmAction(message, action, okLabel?, title?, variant?), get flash, get syncConfig }

    // settings / backend / root 都是 getter（求值即最终值，非函数）。此前误写成
    // deps.settings() / deps.backend() / deps.root()（当函数调用），renderSection 每次
    // 抛 `TypeError: ... is not a function`，整个「工作区防护」区块渲染不出来——后端
    // 备份/检测/快照都正常，只有这个查看与恢复 UI 失效。统一走 resolveDep。
    function settingsObj() { return resolveDep(deps.settings, {}); }
    function backendObj() { return resolveDep(deps.backend, null); }
    function rootVal() { return resolveDep(deps.root, ''); }

    function settingsOf() {
        const s = settingsObj();
        if (!s.wipeGuard) s.wipeGuard = wipeGuardDefaults();
        return Object.assign(wipeGuardDefaults(), s.wipeGuard);
    }

    async function persistSettings() {
        const s = settingsObj();
        s.wipeGuard = settingsOf();
        if (typeof deps.applySettings === 'function') deps.applySettings();
        if (deps.syncConfig) await deps.syncConfig(); // 推给 Go（WipeGuardConfigure）
    }

    async function renderSection() {
        const pane = document.querySelector('.settings-pane[data-pane="storage"]');
        if (!pane) return;
        let host = document.getElementById('wipe-guard-section');
        if (!host) {
            host = el('div', 'wg-section');
            host.id = 'wipe-guard-section';
            pane.appendChild(host);
        }
        host.textContent = '';
        const st = settingsOf();
        const root = rootVal();

        // ---- 标题 + 说明 ----
        host.appendChild(el('h3', 'wg-title', '工作区防护'));
        host.appendChild(el('p', 'stg-row-meta',
            'AI 写文件前自动留原文件副本；检测到大范围文件消失时告警，并把情况插队告诉正在运行的会话——不打断对话，由模型自己判断是否与它有关。备份存在应用数据目录（工作区之外），整仓删除波及不到。'));

        // ---- 开关组（方案 §3.4：全部默认开）----
        const mkSwitchRow = (label, key, tip) => {
            const row = el('div', 'stg-row');
            const main = el('div', 'stg-row-main');
            const title = el('span', 'stg-row-title', label);
            if (tip) {
                title.dataset.tip = tip;
                main.appendChild(title);
                main.appendChild(el('span', 'stg-row-meta', tip));
            } else {
                main.appendChild(title);
            }
            row.appendChild(main);
            const holder = el('div', 'stg-row-switch');
            holder.appendChild(createSwitch({
                checked: st[key],
                onChange: async () => {
                    st[key] = !st[key];
                    await persistSettings();
                    await renderSection();
                },
            }).element);
            row.appendChild(holder);
            return row;
        };
        host.appendChild(mkSwitchRow('总开关', 'enabled', '关闭后不再备份、不检测；已有备份保留，可手动清理'));
        host.appendChild(mkSwitchRow('定期状态快照', 'snapshots', '每 10 分钟一份全树快照（有 git 用 git archive，无 git 走增量去重）'));

        // ---- 备份根 ----
        const rootRow = el('div', 'stg-row');
        const rootMain = el('div', 'stg-row-main');
        rootMain.appendChild(el('span', 'stg-row-title', '备份根'));
        rootMain.appendChild(el('span', 'stg-row-meta', '留空 = 应用数据目录（推荐）；改到其他盘适合大项目'));
        rootRow.appendChild(rootMain);
        const rootHolder = el('div', 'stg-row-switch');
        const rootInput = createInput({value: st.backupRoot, placeholder: '如 D:\\backups'});
        rootInput.element.style.width = '220px';
        rootInput.element.addEventListener('change', async () => {
            const verdict = validateBackupRoot(rootInput.element.value, root);
            if (verdict.severity === 'error') {
                if (deps.flash) deps.flash(verdict.reason, 'error');
                rootInput.element.value = st.backupRoot;
                return;
            }
            st.backupRoot = String(rootInput.element.value || '').trim();
            await persistSettings();
            if (verdict.severity === 'warn' && deps.flash) deps.flash(verdict.reason, 'warn');
            await renderSection();
        });
        rootHolder.appendChild(rootInput.element);
        rootRow.appendChild(rootHolder);
        host.appendChild(rootRow);

        // ---- 快照形态 + 风险提示（§6.3：无 git 大项目必须明说）----
        try {
            const status = root ? await backendObj().WipeGuardStatus(root) : null;
            if (status && status.mode === 'preimage') {
                host.appendChild(el('p', 'wg-risk',
                    `当前项目：${status.reason}。AI 命令造成的批量删除无法自动恢复。建议 git init 或在上方把备份根指到其他盘。`));
            } else if (status && status.reason) {
                host.appendChild(el('p', 'stg-row-meta', `快照形态：${status.reason}。`));
            }
        } catch (e) { /* 后端不可用（dev mock 缺失）：静默，区块其余部分照常渲染 */ }

        // ---- 备份时间线 ----
        const listHead = el('div', 'wg-list-head');
        listHead.appendChild(el('h4', null, '备份时间线（按文件）'));
        const clearBtn = el('button', 'stg-tile-open', '清空备份');
        clearBtn.type = 'button';
        clearBtn.addEventListener('click', () => {
            deps.confirmAction && deps.confirmAction(
                '清空全部备份与快照？当前文件不受影响，但将失去对事故的恢复能力。',
                async () => {
                    await backendObj().WipeGuardClear();
                    if (deps.flash) deps.flash('备份已清空');
                    await renderSection();
                }, '清空', '清空备份', 'danger');
        });
        listHead.appendChild(clearBtn);
        host.appendChild(listHead);

        let rows = [];
        try {
            rows = root ? await backendObj().WipeGuardList(root) : [];
        } catch (e) { rows = []; }
        const groups = groupBackupEntries(rows);
        if (!groups.length) {
            host.appendChild(el('p', 'stg-row-meta',
                '还没有备份记录。AI 用 write_file / edit_file 修改文件时会自动留下原文件副本。'));
        } else {
            const list = el('div', 'wg-list');
            for (const group of groups.slice(0, 100)) {
                const row = el('div', 'stg-row');
                const main = el('div', 'stg-row-main');
                const title = el('span', 'stg-row-title', group.rel);
                title.dataset.tip = group.rel;
                main.appendChild(title);
                main.appendChild(el('span', 'stg-row-meta',
                    `${formatBackupTime(group.latest.at)} · ${group.latest.tool} · ${group.count} 份`));
                row.appendChild(main);
                const holder = el('div', 'stg-row-switch');
                const restoreBtn = el('button', 'stg-tile-open', '还原');
                restoreBtn.type = 'button';
                restoreBtn.disabled = !group.latest.blob;
                if (!group.latest.blob) restoreBtn.title = '该记录没有原内容（新建文件或超大跳过）';
                restoreBtn.addEventListener('click', () => {
                    deps.confirmAction && deps.confirmAction(
                        `把「${group.rel}」还原到 ${formatBackupTime(group.latest.at)} 的内容？会覆盖当前文件。`,
                        async () => {
                            try {
                                await backendObj().WipeGuardRestore(group.latest.id, root);
                                if (deps.flash) deps.flash('已还原：' + group.rel);
                            } catch (e) {
                                if (deps.flash) deps.flash('还原失败：' + ((e && e.message) || e), 'error');
                            }
                        }, '还原', '还原备份', 'danger');
                });
                holder.appendChild(restoreBtn);
                row.appendChild(holder);
                list.appendChild(row);
            }
            host.appendChild(list);
            if (groups.length > 100) {
                host.appendChild(el('p', 'stg-row-meta', `仅显示最近 100 个文件（共 ${groups.length} 个）。`));
            }
        }

        // ---- 快照清单 ----
        let snaps = [];
        try {
            snaps = root ? await backendObj().WipeGuardSnapshotList(root) : [];
        } catch (e) { snaps = []; }
        if (snaps.length) {
            host.appendChild(el('h4', 'wg-subtitle', '定期快照'));
            const snapList = el('div', 'wg-list');
            for (const snap of snaps.slice(-20).reverse()) {
                const row = el('div', 'stg-row');
                const main = el('div', 'stg-row-main');
                main.appendChild(el('span', 'stg-row-title',
                    `${snap.name}（${snap.kind === 'tar' ? 'git 归档' : '增量快照'} · ${humanBytes(snap.bytes)}）`));
                main.appendChild(el('span', 'stg-row-meta', formatBackupTime(snap.at)));
                row.appendChild(main);
                const holder = el('div', 'stg-row-switch');
                const restoreBtn = el('button', 'stg-tile-open', '还原');
                restoreBtn.type = 'button';
                restoreBtn.addEventListener('click', () => {
                    deps.confirmAction && deps.confirmAction(
                        `把快照 ${snap.name} 的内容写回工作区？会覆盖同名文件的当前内容（不删除快照之后新建的文件）。`,
                        async () => {
                            try {
                                await backendObj().WipeGuardSnapshotRestore(root, snap.name);
                                if (deps.flash) deps.flash('快照已还原：' + snap.name);
                            } catch (e) {
                                if (deps.flash) deps.flash('还原失败：' + ((e && e.message) || e), 'error');
                            }
                        }, '还原', '还原快照', 'danger');
                });
                holder.appendChild(restoreBtn);
                row.appendChild(holder);
                snapList.appendChild(row);
            }
            host.appendChild(snapList);
        }
    }

    return {renderSection};
}
